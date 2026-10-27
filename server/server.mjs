// Archipelago run tracker backend.
//
// Every run is one Archipelago room plus the slot this server joins as a
// read-only Tracker. While a run is open the server stays connected and writes
// everything it hears into SQLite: checks, deaths, the message log, own-world
// placements and received items. Pages only read this database, so counting
// goes on while nobody has a page open.
//
//   /                          list of all runs (public)
//   /run-N                     live view of run N (public)
//   /run-N/<game>/poptracker   one player's PopTracker, e.g. /run-2/liesofp/poptracker (public)
//   /login, /settings          add, edit, end and delete runs (your own admin password)
//
// Needs Node >= 22.13 (built-in WebSocket and node:sqlite). No npm packages.

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8080);
const DB_PATH = process.env.DB_PATH || path.join(HERE, "data", "tracker.db");
const DEFAULT_HOST = process.env.AP_DEFAULT_HOST || "archipelago.gg";
const MAX_OPEN_RUNS = Number(process.env.MAX_ROOMS || 30);
// "scrypt$<salt hex>$<hash hex>", see README / make-password snippet in docker-compose.yml.
const ADMIN_HASH = process.env.ADMIN_PASSWORD_HASH || "";
const SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex");
const SESSION_DAYS = 30;
const PUBLIC = path.join(HERE, "public");
const FIRST_EVENTS = 400;     // first page of the log; older pages come via /events

// Shown in the header, the footer and the page titles. Set them in .env.
const SITE_NAME = process.env.SITE_NAME || "Archipelago Run Tracker";
const SITE_OWNER = process.env.SITE_OWNER || "";
// Logic service (ap-logic container): rebuilds the world from slot_data and
// answers which locations the received items can reach.
const LOGIC_URL = process.env.AP_LOGIC_URL || "";

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new DatabaseSync(DB_PATH);
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT, dkey TEXT UNIQUE, title TEXT,
    addr TEXT, password TEXT, slot_name TEXT, template TEXT, tracker_id TEXT,
    created INTEGER, ended INTEGER, last_connected INTEGER, seed TEXT,
    my_slot INTEGER, rev INTEGER DEFAULT 0);
  CREATE TABLE IF NOT EXISTS players (
    room TEXT, slot INTEGER, name TEXT, game TEXT, goal INTEGER DEFAULT 0,
    PRIMARY KEY (room, slot));
  CREATE TABLE IF NOT EXISTS checks (
    room TEXT, slot INTEGER, location INTEGER, location_name TEXT,
    item_name TEXT, receiver INTEGER, flags INTEGER, t INTEGER,
    PRIMARY KEY (room, slot, location));
  CREATE TABLE IF NOT EXISTS deaths (
    room TEXT, slot INTEGER, source TEXT, cause TEXT, t INTEGER, ap_time REAL,
    UNIQUE (room, source, ap_time));
  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT, room TEXT, t INTEGER, kind TEXT,
    slots TEXT, parts TEXT);
  CREATE INDEX IF NOT EXISTS events_room ON events (room, id);
  CREATE TABLE IF NOT EXISTS scout (
    room TEXT, location INTEGER, location_name TEXT, item_name TEXT,
    player INTEGER, flags INTEGER, PRIMARY KEY (room, location));
  CREATE TABLE IF NOT EXISTS received (
    room TEXT, idx INTEGER, item_name TEXT, from_slot INTEGER,
    location_name TEXT, flags INTEGER, PRIMARY KEY (room, idx));
  CREATE TABLE IF NOT EXISTS datapackage (
    game TEXT PRIMARY KEY, checksum TEXT, json TEXT);
  CREATE TABLE IF NOT EXISTS hints (
    room TEXT, finder INTEGER, receiver INTEGER, location INTEGER, location_name TEXT,
    item_name TEXT, flags INTEGER, found INTEGER, PRIMARY KEY (room, finder, location));
  CREATE TABLE IF NOT EXISTS webstats (
    room TEXT, slot INTEGER, checked INTEGER, total INTEGER, status INTEGER, t INTEGER,
    PRIMARY KEY (room, slot));
`);
// archipelago.gg room id (from the room link): lets a run follow its room to a new port.
try { db.exec("ALTER TABLE runs ADD COLUMN room_id TEXT"); } catch {}
// Released without reaching the goal: done, but not "completed".
try { db.exec("ALTER TABLE players ADD COLUMN released INTEGER DEFAULT 0"); } catch {}
// The slot's YAML options as the room reports them (Connect with slot_data: true).
try { db.exec("ALTER TABLE runs ADD COLUMN slot_data TEXT"); } catch {}
db.exec("CREATE INDEX IF NOT EXISTS checks_room_t ON checks (room, slot, t)");
// Test runs: only visible when logged in (list, pages, API and log file).
try { db.exec("ALTER TABLE runs ADD COLUMN hidden INTEGER DEFAULT 0"); } catch {}
// Per player from the archipelago.gg tracker API (needs the room link): received
// items [item, location, sender, flags], checked location ids, hints and slot_data.
// This is what the personal PopTracker of every player is built from.
db.exec(`CREATE TABLE IF NOT EXISTS webslot (
  room TEXT, slot INTEGER, items TEXT, checks TEXT, hints TEXT, slot_data TEXT, t INTEGER,
  PRIMARY KEY (room, slot))`);
// Site-wide settings (currently the design), changed in /settings.
db.exec("CREATE TABLE IF NOT EXISTS site (key TEXT PRIMARY KEY, value TEXT)");
const DESIGNS = ["erdtree", "liesofp", "bg3", "ds3", "silksong", "classic", "archipelago", "ozean", "graphit", "mono", "hell"];
const DEFAULT_DESIGN = DESIGNS.includes(process.env.DEFAULT_DESIGN) ? process.env.DEFAULT_DESIGN : "archipelago";
const siteDesign = () => { const r = db.prepare("SELECT value FROM site WHERE key='design'").get(); return r && DESIGNS.includes(r.value) ? r.value : DEFAULT_DESIGN; };
const escHtml = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
// Site logo (favicon + header mark), also chosen in /settings.
const ICONS = ["pin", "kompass"];
const siteIcon = () => { const r = db.prepare("SELECT value FROM site WHERE key='icon'").get(); return r && ICONS.includes(r.value) ? r.value : "pin"; };
// Fixed URLs browsers and the header ask for -> files of the chosen logo.
const ICON_FILES = { "/favicon.svg": ".svg", "/favicon.ico": ".ico", "/favicon-32.png": "-32.png",
                     "/apple-touch-icon.png": "-180.png", "/logo-512.png": "-512.png", "/logo-mark.svg": "-mark.svg" };
/** Every page gets the design right in <html> (nothing flickers) and the site name/owner. */
const withDesign = html => html
  .replace(/<html lang="de">/, `<html lang="de" data-design="${siteDesign()}" data-icon="${siteIcon()}">`)
  .replace("<head>", `<head>\n<script>window.SITE = ${JSON.stringify({ name: SITE_NAME, owner: SITE_OWNER }).replace(/</g, "\\u003c")};</script>`)
  .replaceAll("{{SITE_NAME}}", escHtml(SITE_NAME))
  .replaceAll("{{SITE_OWNER}}", escHtml(SITE_OWNER || SITE_NAME));
const DATA_TABLES = ["players", "checks", "deaths", "events", "scout", "received", "hints", "webstats", "webslot"];

const q = sql => db.prepare(sql);
const now = () => Date.now();

// Releases logged before the column existed: "Name (Team #1) has released all remaining items …".
for (const e of q("SELECT room, parts FROM events WHERE kind='release'").all()) {
  const m = /^(.+?) \(Team #\d+\) has released/.exec(JSON.parse(e.parts).map(x => x.text).join(""));
  if (m) q("UPDATE players SET released=1 WHERE room=? AND name=?").run(e.room, m[1]);
}

const getRun = id => q("SELECT * FROM runs WHERE id=?").get(Number(id));
/** A run as the public may see it: hidden test runs do not exist for them. */
const seeRun = (id, admin) => { const r = getRun(id); return r && (!r.hidden || admin) ? r : null; };

/** "wss://Archipelago.gg:38281/" -> "archipelago.gg:38281"; "38281" -> default host. */
function normalizeAddr(raw) {
  let s = String(raw || "").trim().toLowerCase()
    .replace(/^wss?:\/\//, "").replace(/\/+$/, "");
  if (/^\d{2,5}$/.test(s)) s = DEFAULT_HOST + ":" + s;
  return /^[a-z0-9.-]+:\d{2,5}$/.test(s) ? s : null;
}

// ---------------------------------------------------------------------------
// Data package cache: game -> {items: Map(id->name), locs: Map(id->name)}
// ---------------------------------------------------------------------------
const names = new Map();
function loadGame(game, data) {
  const flip = o => new Map(Object.entries(o || {}).map(([n, id]) => [id, n]));
  names.set(game, { items: flip(data.item_name_to_id), locs: flip(data.location_name_to_id) });
}
for (const row of q("SELECT game, json FROM datapackage").all()) {
  try { loadGame(row.game, JSON.parse(row.json)); } catch {}
}

// ---------------------------------------------------------------------------
// Log file per run: data/logs/run-N.html, only ever appended to, with the same
// colours as on the page. It outlives room restarts and can be downloaded.
// ---------------------------------------------------------------------------
const LOG_DIR = path.join(path.dirname(DB_PATH), "logs");
fs.mkdirSync(LOG_DIR, { recursive: true });
const logPath = id => path.join(LOG_DIR, `run-${id}.html`);
const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const logTime = t => new Date(t).toLocaleString("de-DE", { timeZone: "Europe/Berlin",
  day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });

function logHead(run) {
  const title = esc(run.title || `Archipelago Run #${run.id}`);
  return `<!doctype html>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} - Log</title>
<style>
  body { margin:0; padding:16px; background:#15161a; color:#e6e7ea; font:14px/1.5 "Segoe UI", system-ui, sans-serif; }
  h1 { font-size:17px; margin:0 0 4px; } h1 + p { color:#9ba0ab; margin:0 0 14px; font-size:12px; }
  .ev { display:flex; gap:10px; padding:4px 0; border-bottom:1px solid #33363f; }
  .ts { color:#9ba0ab; flex:0 0 auto; font-variant-numeric:tabular-nums; }
  .tx { flex:1; word-break:break-word; }
  .p { color:#8fa8d8; } .p.me { color:#c9a227; }
  .i.prog { color:#5fb37a; } .i.use { color:#8fa8d8; } .i.trap { color:#d2635f; }
  .l { color:#9ba0ab; }
  .death .tx { color:#d2635f; font-weight:600; } .goal .tx { color:#5fb37a; } .system .tx { color:#d99a3c; }
</style>
<h1>${title}</h1><p>Archipelago-Log von ${esc(SITE_NAME)}, älteste Einträge oben. Zeiten: Europe/Berlin.</p>
`;
}

function logLine(e, mySlot) {
  const parts = e.parts.map(x => {
    const cls = x.type === "player" ? "p" + (x.slot != null && x.slot === mySlot ? " me" : "")
      : x.type === "item" ? "i" + ((x.flags & 1) ? " prog" : (x.flags & 4) ? " trap" : (x.flags & 2) ? " use" : "")
      : x.type === "location" ? "l" : "";
    return cls ? `<span class="${cls}">${esc(x.text)}</span>` : esc(x.text);
  }).join("");
  return `<div class="ev ${esc(e.kind)}"><span class="ts">${logTime(e.t)}</span><span class="tx">${parts}</span></div>\n`;
}

/** Create the file (with everything logged so far) if it is missing. */
function ensureLogFile(run) {
  const file = logPath(run.id);
  if (fs.existsSync(file)) return;
  let out = logHead(run);
  for (const e of q("SELECT t, kind, parts FROM events WHERE room=? ORDER BY id").iterate(run.dkey))
    out += logLine({ t: e.t, kind: e.kind, parts: JSON.parse(e.parts) }, run.my_slot);
  fs.writeFileSync(file, out);
}

function appendLog(id, e, mySlot) {
  try {
    const file = logPath(id);
    if (!fs.existsSync(file)) { const run = getRun(id); if (run) ensureLogFile(run); return; }
    fs.appendFileSync(file, logLine(e, mySlot));
  } catch (err) { console.error("log file", id, err.message); }
}

for (const run of q("SELECT * FROM runs").all()) {
  try { ensureLogFile(run); } catch (e) { console.error("log file", run.id, e.message); }
}

// ---------------------------------------------------------------------------
// One collector per open run.
// ---------------------------------------------------------------------------
const rooms = new Map();   // run id -> Room

class Room {
  constructor(run) {
    this.id = run.id;
    this.key = run.dkey;           // rows in the data tables carry this
    this.addr = run.addr;
    this.slotName = run.slot_name;
    this.password = run.password || null;
    this.roomId = run.room_id || null;
    this.lost = false;
    this.ws = null;
    this.connected = false;
    this.status = "verbinde";
    this.error = "";
    this.players = new Map();   // slot -> {name, game}
    this.myS = run.my_slot;
    this.timer = null;
    this.failures = 0;
    this.stopped = false;
    this.waiters = [];
    for (const p of q("SELECT slot, name, game FROM players WHERE room=?").all(this.key))
      this.players.set(p.slot, { name: p.name, game: p.game });
  }

  bump() { q("UPDATE runs SET rev = rev + 1 WHERE id=?").run(this.id); }

  gameOf(slot) { const p = this.players.get(slot); return p && p.game; }
  itemName(id, slot) {
    const g = names.get(this.gameOf(slot));
    return (g && g.items.get(id)) || "#" + id;
  }
  locName(id, slot) {
    const g = names.get(this.gameOf(slot));
    return (g && g.locs.get(id)) || "#" + id;
  }
  slotOfName(src) {
    const s = String(src || "").trim().toLowerCase();
    for (const [slot, p] of this.players) if (p.name.toLowerCase() === s) return slot;
    return null;
  }

  start(secure = true) {
    if (this.stopped) return;
    clearTimeout(this.timer);
    let opened = false;
    let ws;
    try { ws = new WebSocket((secure ? "wss://" : "ws://") + this.addr); }
    catch (e) { return this.retry(String(e.message || e)); }
    this.ws = ws;
    this.status = "verbinde";
    ws.onopen = () => { opened = true; };
    ws.onmessage = ev => {
      let frames;
      try { frames = JSON.parse(typeof ev.data === "string" ? ev.data : ev.data.toString()); }
      catch { return; }
      for (const p of frames) {
        try { this.handle(p); } catch (e) { console.error(this.addr, p.cmd, e); }
      }
    };
    ws.onerror = () => {};
    ws.onclose = () => {
      const was = this.connected;
      this.connected = false;
      if (!opened && secure) return this.start(false);   // self-hosted rooms are often plain ws
      if (was) { this.lost = true; this.addEvent("system", [], [{ type: "text", text: "Verbindung zum Raum verloren" }]); }
      this.retry(this.error || "Raum nicht erreichbar");
    };
  }

  retry(reason) {
    if (this.stopped) return;
    if (this.status !== "abgelehnt") this.status = "offline";
    this.error = reason;
    this.failures++;
    this.resolveWaiters(false);
    // Rooms on archipelago.gg sleep after a while without players; keep knocking,
    // but slower over time. With a room link we can also ask where it is now.
    const delay = Math.min(this.roomId ? 2 * 60_000 : 10 * 60_000, 5_000 * 2 ** Math.min(this.failures, 7));
    this.timer = setTimeout(() => this.followPort().finally(() => this.start(true)), delay);
  }

  /** A room that wakes up again on archipelago.gg often gets a new port. Follow it. */
  async followPort() {
    if (!this.roomId || this.stopped || !this.addr.startsWith(DEFAULT_HOST + ":")) return;
    try {
      const info = await lookupRoomLink("room/" + this.roomId);
      const addr = info.port ? DEFAULT_HOST + ":" + info.port : null;
      if (addr && addr !== this.addr && !this.stopped) {
        console.log("run", this.id, "moved", this.addr, "->", addr);
        this.addr = addr;
        this.failures = 0;
        q("UPDATE runs SET addr=? WHERE id=?").run(addr, this.id);
        this.addEvent("system", [], [{ type: "text", text: `Raum läuft jetzt auf Port ${info.port}` }]);
      }
    } catch {}
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    this.resolveWaiters(false);
    if (this.ws) { this.ws.onclose = null; try { this.ws.close(); } catch {} }
  }

  send(...cmds) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(cmds));
  }

  waitReady(ms) {
    if (this.connected) return Promise.resolve(true);
    return new Promise(res => {
      const t = setTimeout(() => res(false), ms);
      this.waiters.push(ok => { clearTimeout(t); res(ok); });
    });
  }
  resolveWaiters(ok) { const w = this.waiters; this.waiters = []; w.forEach(f => f(ok)); }

  addEvent(kind, slots, parts) {
    const t = now();
    q("INSERT INTO events (room, t, kind, slots, parts) VALUES (?,?,?,?,?)")
      .run(this.key, t, kind, JSON.stringify(slots), JSON.stringify(parts));
    appendLog(this.id, { t, kind, parts }, this.myS);
  }

  /** Resolve ids inside JSONMessageParts to text once, at write time. */
  resolveParts(parts) {
    return (parts || []).map(part => {
      const txt = part.text != null ? String(part.text) : "";
      switch (part.type) {
        case "player_id": {
          const n = Number(txt);
          return { type: "player", slot: n, text: (this.players.get(n) || {}).name || "Slot " + n };
        }
        case "item_id":
          return { type: "item", flags: part.flags || 0, text: this.itemName(Number(txt), part.player) };
        case "location_id":
          return { type: "location", text: this.locName(Number(txt), part.player) };
        case "player_name": return { type: "player", slot: this.slotOfName(txt), text: txt };
        case "item_name": return { type: "item", text: txt };
        case "location_name": return { type: "location", text: txt };
        default: return { type: "text", text: txt };
      }
    });
  }

  handle(p) {
    switch (p.cmd) {
      case "RoomInfo": {
        const want = Object.entries(p.datapackage_checksums || {})
          .filter(([g, sum]) => {
            const row = q("SELECT checksum FROM datapackage WHERE game=?").get(g);
            return !row || row.checksum !== sum || !names.has(g);
          }).map(([g]) => g);
        if (want.length) this.send({ cmd: "GetDataPackage", games: want });
        if (p.seed_name) q("UPDATE runs SET seed=? WHERE id=?").run(p.seed_name, this.id);
        this.send({
          cmd: "Connect", password: this.password, game: "", name: this.slotName,
          uuid: "archipelago-run-tracker-" + this.slotName,
          version: { major: 0, minor: 6, build: 8, class: "Version" },
          // Tracker = read-only, never takes over the slot. DeathLink only to
          // RECEIVE bounces; this client never sends one.
          items_handling: 0b111, tags: ["Tracker", "DeathLink"], slot_data: true,
        });
        break;
      }

      case "DataPackage":
        for (const [g, data] of Object.entries((p.data && p.data.games) || {})) {
          q("INSERT OR REPLACE INTO datapackage (game, checksum, json) VALUES (?,?,?)")
            .run(g, data.checksum || "", JSON.stringify({
              item_name_to_id: data.item_name_to_id, location_name_to_id: data.location_name_to_id }));
          loadGame(g, data);
        }
        this.fixNames();
        break;

      case "Connected": {
        this.connected = true;
        this.status = "verbunden";
        this.error = "";
        this.failures = 0;
        this.myS = p.slot;
        q("UPDATE runs SET my_slot=?, last_connected=? WHERE id=?").run(p.slot, now(), this.id);
        if (p.slot_data && typeof p.slot_data === "object") {
          const sd = JSON.stringify(p.slot_data);
          if (sd.length < 3_000_000) q("UPDATE runs SET slot_data=? WHERE id=?").run(sd, this.id);
        }
        const up = q("INSERT INTO players (room, slot, name, game) VALUES (?,?,?,?) " +
                     "ON CONFLICT (room, slot) DO UPDATE SET name=excluded.name, game=excluded.game");
        const slots = Object.keys(p.slot_info || {}).map(Number);
        for (const [s, info] of Object.entries(p.slot_info || {})) {
          this.players.set(Number(s), { name: info.name, game: info.game });
          up.run(this.key, Number(s), info.name, info.game);
        }
        // Drop guesses from the room link that the real slot list does not have.
        if (slots.length)
          q(`DELETE FROM players WHERE room=? AND slot NOT IN (${slots.map(() => "?").join(",")})`).run(this.key, ...slots);
        this.markOwnChecked(p.checked_locations || [], 0);   // t=0: checked before we watched
        const all = [...(p.checked_locations || []), ...(p.missing_locations || [])];
        if (all.length) this.send({ cmd: "LocationScouts", locations: all, create_as_hint: 0 });
        // Hints that concern this slot (both directions); the server pushes updates.
        this.hintsKey = `_read_hints_${p.team}_${p.slot}`;
        this.send({ cmd: "Get", keys: [this.hintsKey] }, { cmd: "SetNotify", keys: [this.hintsKey] });
        if (this.lost) {
          this.lost = false;
          this.addEvent("system", [], [{ type: "text", text: "Wieder verbunden, Log geht weiter" }]);
        }
        this.resolveWaiters(true);
        this.bump();
        break;
      }

      case "LocationInfo": {
        const ins = q("INSERT OR REPLACE INTO scout (room, location, location_name, item_name, player, flags) VALUES (?,?,?,?,?,?)");
        db.exec("BEGIN");
        for (const i of p.locations || [])
          ins.run(this.key, i.location, this.locName(i.location, this.myS),
                  this.itemName(i.item, i.player), i.player, i.flags || 0);
        db.exec("COMMIT");
        // Own checks recorded before the scout answer have no item yet.
        q(`UPDATE checks SET item_name = s.item_name, receiver = s.player, flags = s.flags
           FROM scout s WHERE checks.room = ? AND checks.slot = ? AND checks.item_name IS NULL
           AND s.room = checks.room AND s.location = checks.location`).run(this.key, this.myS);
        this.bump();
        break;
      }

      case "ReceivedItems": {
        if (p.index === 0) q("DELETE FROM received WHERE room=?").run(this.key);
        const ins = q("INSERT OR REPLACE INTO received (room, idx, item_name, from_slot, location_name, flags) VALUES (?,?,?,?,?,?)");
        (p.items || []).forEach((i, n) =>
          ins.run(this.key, p.index + n, this.itemName(i.item, this.myS), i.player,
                  this.locName(i.location, i.player), i.flags || 0));
        this.bump();
        break;
      }

      case "Retrieved":
        if (p.keys && this.hintsKey && this.hintsKey in p.keys) this.storeHints(p.keys[this.hintsKey]);
        break;

      case "SetReply":
        if (p.key === this.hintsKey) this.storeHints(p.value);
        break;

      case "RoomUpdate":
        if (p.checked_locations) this.markOwnChecked(p.checked_locations);
        break;

      case "PrintJSON": {
        const parts = this.resolveParts(p.data);
        const slots = [...new Set(parts.filter(x => x.type === "player" && x.slot != null).map(x => x.slot))];
        let kind = (p.type || "text").toLowerCase();
        if (p.type === "ItemSend" && p.item) {
          const finder = p.item.player;
          // ItemSend is always live (never replayed on reconnect), so its time wins.
          q("INSERT INTO checks (room, slot, location, location_name, item_name, receiver, flags, t) VALUES (?,?,?,?,?,?,?,?) " +
            "ON CONFLICT (room, slot, location) DO UPDATE SET item_name=excluded.item_name, " +
            "receiver=excluded.receiver, flags=excluded.flags, t=excluded.t")
            .run(this.key, finder, p.item.location, this.locName(p.item.location, finder),
                 this.itemName(p.item.item, p.receiving), p.receiving, p.item.flags || 0, now());
        }
        if (p.type === "Goal" && p.slot != null) {
          q("UPDATE players SET goal=1 WHERE room=? AND slot=?").run(this.key, p.slot);
          setImmediate(() => maybeFinish(this.id));
        }
        if (p.type === "Release" && p.slot != null) {
          q("UPDATE players SET released=1 WHERE room=? AND slot=?").run(this.key, p.slot);
          setImmediate(() => maybeFinish(this.id));
        }
        // Join/Part/Tutorial noise from trackers (including this one) is not worth keeping.
        if (p.type === "Tutorial") break;
        if ((p.type === "Join" || p.type === "Part") &&
            ((p.tags || []).includes("Tracker") || /tracking/.test(parts.map(x => x.text).join("")))) break;
        this.addEvent(kind, slots, parts);
        this.bump();
        break;
      }

      case "Bounced":
        if ((p.tags || []).includes("DeathLink")) {
          const d = p.data || {};
          const res = q("INSERT OR IGNORE INTO deaths (room, slot, source, cause, t, ap_time) VALUES (?,?,?,?,?,?)")
            .run(this.key, this.slotOfName(d.source), String(d.source || "?"),
                 d.cause ? String(d.cause) : null, now(), Number(d.time) || now() / 1000);
          if (res.changes) {
            const s = this.slotOfName(d.source);
            this.addEvent("death", s != null ? [s] : [], [
              { type: "text", text: "☠ " },
              { type: "player", slot: s, text: String(d.source || "?") },
              { type: "text", text: d.cause ? " - " + d.cause : " ist gestorben" }]);
            this.bump();
          }
        }
        break;

      case "ConnectionRefused":
        this.error = "AP lehnt ab: " + (p.errors || []).join(", ");
        this.status = "abgelehnt";
        this.resolveWaiters(false);
        break;
    }
  }

  /** Own checks come as bare ids from Connected/RoomUpdate; fold them into `checks`. */
  markOwnChecked(ids, t = now()) {
    if (this.myS == null || !ids.length) return;
    const ins = q("INSERT OR IGNORE INTO checks (room, slot, location, location_name, item_name, receiver, flags, t) " +
      "SELECT ?, ?, ?, ?, s.item_name, s.player, s.flags, ? FROM (SELECT 1) " +
      "LEFT JOIN scout s ON s.room = ? AND s.location = ?");
    db.exec("BEGIN");
    for (const id of ids) ins.run(this.key, this.myS, id, this.locName(id, this.myS), t, this.key, id);
    db.exec("COMMIT");
    this.bump();
  }

  /** The hint list is always complete, so replace what we had. */
  storeHints(list) {
    const ins = q("INSERT OR REPLACE INTO hints (room, finder, receiver, location, location_name, item_name, flags, found) VALUES (?,?,?,?,?,?,?,?)");
    db.exec("BEGIN");
    q("DELETE FROM hints WHERE room=?").run(this.key);
    for (const h of list || [])
      ins.run(this.key, h.finding_player, h.receiving_player, h.location,
              this.locName(h.location, h.finding_player), this.itemName(h.item, h.receiving_player),
              h.item_flags || 0, h.found ? 1 : 0);
    db.exec("COMMIT");
    this.bump();
  }

  /** Rows written before the data package arrived carry "#id"; fill them in. */
  fixNames() {
    if (this.myS == null) return;
    for (const r of q("SELECT slot, location FROM checks WHERE room=? AND location_name LIKE '#%'").all(this.key))
      q("UPDATE checks SET location_name=? WHERE room=? AND slot=? AND location=?")
        .run(this.locName(r.location, r.slot), this.key, r.slot, r.location);
  }
}

function ensureRoom(run) {
  if (rooms.has(run.id)) return rooms.get(run.id);
  const r = new Room(run);
  rooms.set(run.id, r);
  r.start();
  return r;
}

function stopRoom(id) {
  const r = rooms.get(id);
  if (r) { r.stop(); rooms.delete(id); }
}

// ---------------------------------------------------------------------------
// Run life cycle. A run ends by itself once every player reached the goal,
// or by hand in /settings. Ended runs keep their data but stop listening.
// ---------------------------------------------------------------------------
const stopLater = new Map();

/** Per player: reached the goal, or at least released (gave up / ran out of time). */
function goalsOf(dkey) {
  return q(`SELECT p.slot, p.goal, p.released, w.status FROM players p
            LEFT JOIN webstats w ON w.room = p.room AND w.slot = p.slot WHERE p.room=?`)
    .all(dkey).map(p => ({ goal: !!(p.goal || p.status >= 30), released: !!p.released }));
}

function maybeFinish(id) {
  const run = getRun(id);
  if (!run || run.ended) return;
  const goals = goalsOf(run.dkey);
  if (goals.length && goals.every(g => g.goal || g.released)) endRun(id, true);
}

function endRun(id, auto) {
  // Ended by itself: the run finished with the last goal/release, not when we noticed.
  const run = getRun(id);
  const last = auto && q("SELECT MAX(t) AS t FROM events WHERE room=? AND kind IN ('goal','release')").get(run.dkey).t;
  q("UPDATE runs SET ended=? WHERE id=?").run(last || now(), id);
  clearTimeout(stopLater.get(id));
  // After the last goal people often release/collect: keep listening a bit.
  if (auto) stopLater.set(id, setTimeout(() => { if (getRun(id)?.ended) stopRoom(id); }, 15 * 60_000));
  else stopRoom(id);
}

function reopenRun(id) {
  clearTimeout(stopLater.get(id));
  q("UPDATE runs SET ended=NULL WHERE id=?").run(id);
  ensureRoom(getRun(id));
}

function deleteRun(id) {
  const run = getRun(id);
  if (!run) return;
  stopRoom(id);
  db.exec("BEGIN");
  for (const t of DATA_TABLES) q(`DELETE FROM ${t} WHERE room=?`).run(run.dkey);
  q("DELETE FROM runs WHERE id=?").run(id);
  db.exec("COMMIT");
  try { fs.unlinkSync(logPath(id)); } catch {}
}

for (const run of q("SELECT * FROM runs WHERE ended IS NULL").all()) ensureRoom(run);

// ---------------------------------------------------------------------------
// Exact X/Y per player. The socket only tells a client about its own slot;
// the archipelago.gg tracker API knows every slot, including checks made
// before this server was watching. It needs the room link once.
// ---------------------------------------------------------------------------
const WEB = "https://" + DEFAULT_HOST;
const ROOM_ID = /room\/([A-Za-z0-9_-]{22})/;

/** Room link -> {tracker, port, players:[{name, game}]} from archipelago.gg. */
async function lookupRoomLink(link) {
  const m = ROOM_ID.exec(String(link || ""));
  if (!m) throw new Error("Das ist kein Raum-Link (https://archipelago.gg/room/…).");
  const r = await fetch(`${WEB}/api/room_status/${m[1]}`, { signal: AbortSignal.timeout(10_000) });
  if (!r.ok) throw new Error("archipelago.gg kennt diesen Raum nicht.");
  const j = await r.json();
  const players = (j.players || []).map(p => Array.isArray(p) ? { name: p[0], game: p[1] } : { name: p.name, game: p.game })
    .filter(p => p.name);
  return { roomId: m[1], tracker: j.tracker || null, port: j.last_port || null, players };
}

async function pollWeb(dkey, trackerId) {
  const get = path => fetch(`${WEB}/api/${path}/${trackerId}`, { signal: AbortSignal.timeout(15_000) }).then(r => r.json());
  const [live, statik] = await Promise.all([get("tracker"), get("static_tracker")]);
  const rows = new Map();
  const row = s => { if (!rows.has(s)) rows.set(s, { checked: null, total: null, status: null }); return rows.get(s); };
  for (const x of statik.player_locations_total || []) row(x.player).total = x.total_locations;
  for (const x of live.player_checks_done || []) row(x.player).checked = (x.locations || []).length;
  for (const x of live.player_status || []) row(x.player).status = x.status;
  const up = q("INSERT OR REPLACE INTO webstats (room, slot, checked, total, status, t) VALUES (?,?,?,?,?,?)");
  for (const [slot, v] of rows) up.run(dkey, slot, v.checked, v.total, v.status, now());

  // Everything per player for the PopTracker views. slot_data never changes: fetch it once.
  const hasSd = new Set(q("SELECT slot FROM webslot WHERE room=? AND slot_data IS NOT NULL").all(dkey).map(r => r.slot));
  let sd = [];
  if ((statik.player_game || []).some(x => !hasSd.has(x.player)))
    sd = await get("slot_data_tracker").catch(() => []);
  const sdBy = new Map((Array.isArray(sd) ? sd : []).map(x => [x.player, JSON.stringify(x.slot_data ?? null)]));
  const items = new Map((live.player_items_received || []).map(x => [x.player, x.items || []]));
  const checks = new Map((live.player_checks_done || []).map(x => [x.player, x.locations || []]));
  const hints = new Map((live.hints || []).map(x => [x.player, x.hints || []]));
  const ws = q(`INSERT INTO webslot (room, slot, items, checks, hints, slot_data, t) VALUES (?,?,?,?,?,?,?)
    ON CONFLICT (room, slot) DO UPDATE SET items=excluded.items, checks=excluded.checks, hints=excluded.hints,
      slot_data=COALESCE(excluded.slot_data, webslot.slot_data), t=excluded.t`);
  db.exec("BEGIN");
  for (const x of statik.player_game || []) {
    const s = sdBy.get(x.player);
    ws.run(dkey, x.player, JSON.stringify(items.get(x.player) || []), JSON.stringify(checks.get(x.player) || []),
           JSON.stringify(hints.get(x.player) || []), s && s.length < 3_000_000 ? s : null, now());
  }
  db.exec("COMMIT");
  webRev.set(dkey, (webRev.get(dkey) || 0) + 1);
}
const webRev = new Map();   // dkey -> counter, bumped by every pollWeb

/** Ended runs are not polled any more; fetch their web data once when someone looks. */
const webOnce = new Map();
function ensureWeb(run) {
  if (!run.tracker_id) return Promise.resolve();
  if (q("SELECT 1 FROM webslot WHERE room=? LIMIT 1").get(run.dkey)) return Promise.resolve();
  if (!webOnce.has(run.id))
    webOnce.set(run.id, pollWeb(run.dkey, run.tracker_id).catch(e => { console.error("web once", run.id, e.message); })
      .finally(() => setTimeout(() => webOnce.delete(run.id), 60_000)));
  return webOnce.get(run.id);
}

async function pollAllWeb() {
  for (const r of q("SELECT id, dkey, tracker_id FROM runs WHERE tracker_id IS NOT NULL AND ended IS NULL").all()) {
    try { await pollWeb(r.dkey, r.tracker_id); maybeFinish(r.id); }
    catch (e) { console.error("web tracker", r.id, e.message); }
  }
}
setInterval(pollAllWeb, 60_000);
pollAllWeb();

// ---------------------------------------------------------------------------
// Login: one admin password (scrypt hash in the environment), signed cookie.
// ---------------------------------------------------------------------------
function checkPassword(pw) {
  const [kind, salt, hash] = ADMIN_HASH.split("$");
  if (kind !== "scrypt" || !salt || !hash) return false;
  const want = Buffer.from(hash, "hex");
  const got = crypto.scryptSync(String(pw || ""), Buffer.from(salt, "hex"), want.length);
  return crypto.timingSafeEqual(got, want);
}
const sign = s => crypto.createHmac("sha256", SECRET).update(s).digest("base64url");

function cookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

function isAdmin(req) {
  const c = cookies(req).sid;
  if (!c) return false;
  const i = c.lastIndexOf(".");
  const value = c.slice(0, i), sig = Buffer.from(c.slice(i + 1));
  const good = Buffer.from(sign(value));
  if (sig.length !== good.length || !crypto.timingSafeEqual(sig, good)) return false;
  return Number(value.split(".")[1]) > now();
}

function sessionCookie(on) {
  const base = "sid=%; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=";
  if (!on) return base.replace("%", "") + "0";
  const value = "admin." + (now() + SESSION_DAYS * 86400_000);
  return base.replace("%", value + "." + sign(value)) + SESSION_DAYS * 86400;
}

// At most 5 wrong passwords per address and 15 minutes.
const loginFails = new Map();
function clientIp(req) {
  const xff = String(req.headers["x-forwarded-for"] || "").split(",").map(s => s.trim()).filter(Boolean);
  return xff.length ? xff[xff.length - 1] : req.socket.remoteAddress;
}

// ---------------------------------------------------------------------------
// What pages get to see
// ---------------------------------------------------------------------------
function liveStatus(run) {
  if (run.ended) return { status: "beendet", error: "" };
  const live = rooms.get(run.id);
  return live ? { status: live.status, error: live.error } : { status: "gestoppt", error: "" };
}

function runSummary(run) {
  const players = q("SELECT slot, name, game FROM players WHERE room=? ORDER BY slot").all(run.dkey);
  const goals = goalsOf(run.dkey);
  return {
    id: run.id, title: run.title || null, created: run.created, ended: run.ended, hidden: !!run.hidden,
    status: liveStatus(run).status,
    players: players.map((p, i) => ({ name: p.name, game: p.game,
      goal: goals[i] ? goals[i].goal : false, released: goals[i] ? goals[i].released : false })),
    goals: goals.filter(g => g.goal).length,
    deaths: q("SELECT COUNT(*) AS n FROM deaths WHERE room=?").get(run.dkey).n,
  };
}

function state(run, since, admin) {
  const key = run.dkey;
  const players = q(`
    SELECT p.slot, p.name, p.game, p.goal, p.released,
      (SELECT COUNT(*) FROM checks c WHERE c.room=p.room AND c.slot=p.slot) AS checks,
      (SELECT COUNT(*) FROM deaths d WHERE d.room=p.room AND d.slot=p.slot) AS deaths
    FROM players p WHERE p.room=? ORDER BY p.slot`).all(key);
  const web = new Map(q("SELECT slot, checked, total, status FROM webstats WHERE room=?").all(key).map(w => [w.slot, w]));
  for (const p of players) {
    const w = web.get(p.slot);
    p.web = w ? { checked: w.checked, total: w.total } : null;
    if (w && w.status >= 30) p.goal = 1;
  }
  // Own slot without the room link: the scouted locations give the total.
  const me = players.find(p => p.slot === run.my_slot);
  if (me && !me.web) {
    const n = q("SELECT COUNT(*) AS n FROM scout WHERE room=?").get(key).n;
    if (n) me.web = { checked: me.checks, total: n };
  }
  const last = q(`SELECT c.slot, c.location_name, c.item_name, c.receiver, c.flags, c.t FROM checks c
    JOIN (SELECT slot, MAX(t) AS mt FROM checks WHERE room=? AND t > 0 GROUP BY slot) m
      ON m.slot = c.slot AND c.t = m.mt
    WHERE c.room=?`).all(key, key);
  const lastBy = new Map(last.map(l => [l.slot, l]));
  const slugBy = new Map(slugsOf(key).map(s => [s.slot, s.slug]));
  for (const p of players) { p.last = lastBy.get(p.slot) || null; p.slug = slugBy.get(p.slot); }
  // First load: the newest page plus the total; the page fetches older ones itself.
  // Later polls: everything new since the last id.
  const events = q(`SELECT id, t, kind, slots, parts FROM events WHERE room=? AND id>? ORDER BY id DESC LIMIT ?`)
    .all(key, since, since ? 100_000 : FIRST_EVENTS).map(eventOut);
  const events_total = since ? undefined : q("SELECT COUNT(*) AS n FROM events WHERE room=?").get(key).n;
  const ls = liveStatus(run);
  return {
    room: {
      id: run.id, title: run.title || null, seed: run.seed, created: run.created, ended: run.ended,
      last_connected: run.last_connected, rev: run.rev, status: ls.status, my_slot: run.my_slot,
      ...(admin && run.slot_data ? { slot_data: JSON.parse(run.slot_data) } : {}),
      ...(admin ? { error: ls.error, has_link: !!run.tracker_id } : {}),
    },
    players, events, events_total,
  };
}

const eventOut = e => ({ id: e.id, t: e.t, kind: e.kind, slots: JSON.parse(e.slots), parts: JSON.parse(e.parts) });

/** Older log entries, page by page (newest first), for scrolling to the very beginning. */
function olderEvents(run, before, limit) {
  return q("SELECT id, t, kind, slots, parts FROM events WHERE room=? AND id<? ORDER BY id DESC LIMIT ?")
    .all(run.dkey, before, Math.min(Math.max(limit, 1), 5000)).map(eventOut);
}

// ---------------------------------------------------------------------------
// Reachability ("PopTracker") via the logic service, cached until items change.
// ---------------------------------------------------------------------------
const logicCache = new Map();   // "run:slot" -> {key, data, busy}

/** Games the logic service can rebuild (Archipelago core + apworlds), asked once per 10 min. */
let logicGames = { t: 0, set: null };
async function knownGames() {
  if (logicGames.set && now() - logicGames.t < 10 * 60_000) return logicGames.set;
  const j = await fetch(LOGIC_URL + "/health", { signal: AbortSignal.timeout(5_000) }).then(r => r.json());
  logicGames = { t: now(), set: new Set(j.games || []) };
  return logicGames.set;
}

/**
 * Reachability for one player. Resolves to {reachable, regions, order, ...} or throws
 * with a message for the page. Cached until the player's items change.
 */
async function logicFor(run, slot, game, slotName, slotData, items) {
  if (!LOGIC_URL) throw new Error("Der Logik-Dienst ist nicht eingerichtet.");
  const games = await knownGames().catch(() => { throw new Error("Der Logik-Dienst ist gerade nicht erreichbar."); });
  if (!games.has(game))
    throw new Error(`Für ${game} kennt der Server die Spiel-Logik nicht (apworld fehlt).`);
  const id = run.id + ":" + slot;
  const key = [game, items.length, items[items.length - 1] || "", slotData.length].join("|");
  const hit = logicCache.get(id);
  if (hit && hit.key === key) return hit.data || hit.busy;
  const busy = (async () => {
    const r = await fetch(LOGIC_URL + "/reach", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ game, slot_name: slotName, seed: run.seed || "", slot_data: JSON.parse(slotData), items }),
      signal: AbortSignal.timeout(120_000),
    });
    const j = await r.json();
    if (!r.ok) throw new Error("Logik-Dienst: " + (j.error || r.status));
    return { game, items: items.length, reachable: j.reachable, regions: j.regions,
             order: j.order, unknown_items: j.unknown_items, ms: j.ms, t: now() };
  })();
  logicCache.set(id, { key, busy });
  try {
    const data = await busy;
    if (logicCache.get(id)?.busy === busy) logicCache.set(id, { key, data });
    return data;
  } catch (e) {
    if (logicCache.get(id)?.busy === busy) logicCache.delete(id);
    throw e;
  }
}

// ---------------------------------------------------------------------------
// One player's own tracker, public: what they got, what they checked, hints,
// and what their items reach. No placements, so nothing is spoiled.
// ---------------------------------------------------------------------------
const nameOf = (game, kind, id) => { const g = names.get(game); return (g && g[kind].get(id)) || "#" + id; };

async function slotView(run, slot) {
  await ensureWeb(run);
  const players = new Map(q("SELECT slot, name, game FROM players WHERE room=?").all(run.dkey).map(p => [p.slot, p]));
  const p = players.get(slot);
  if (!p) return null;
  const gameOf = s => (players.get(s) || {}).game;
  const web = q("SELECT items, checks, hints, slot_data FROM webslot WHERE room=? AND slot=?").get(run.dkey, slot);
  const mine = slot === run.my_slot;

  // Received items, keyed by where they came from. The log adds times and anything
  // newer than the last archipelago.gg poll.
  const got = new Map();
  if (mine && q("SELECT 1 FROM received WHERE room=? LIMIT 1").get(run.dkey)) {
    for (const r of q("SELECT item_name, from_slot, location_name, flags FROM received WHERE room=? ORDER BY idx").all(run.dkey))
      got.set(got.size + ":" + r.from_slot, { i: r.item_name, p: r.from_slot, l: r.location_name, f: r.flags || 0, t: null });
  } else if (web) {
    // Starting items all share location -2 of "slot 0": keep each of them.
    for (const [item, loc, from, flags] of JSON.parse(web.items))
      got.set(from + ":" + loc + (loc < 0 ? ":" + got.size : ""), { i: nameOf(p.game, "items", item), p: from, l: nameOf(gameOf(from), "locs", loc), f: flags || 0, t: null });
  }
  const sent = q("SELECT slot, location, location_name, item_name, flags, t FROM checks WHERE room=? AND receiver=? ORDER BY t")
    .all(run.dkey, slot);
  const byLoc = new Map([...got.values()].map(g => [g.p + ":" + g.l, g]));
  for (const c of sent) {
    const k = c.slot + ":" + c.location;
    const known = got.get(k) || byLoc.get(c.slot + ":" + c.location_name);
    if (known) { if (c.t) known.t = c.t; continue; }
    if (mine && got.size) continue;   // the socket list is complete already
    got.set(k, { i: c.item_name, p: c.slot, l: c.location_name, f: c.flags || 0, t: c.t || null });
  }

  const checked = new Set(web ? JSON.parse(web.checks) : []);
  for (const c of q("SELECT location FROM checks WHERE room=? AND slot=?").all(run.dkey, slot)) checked.add(c.location);

  // Hints: [receiver, finder, location, item, found, entrance, item_flags, status].
  let hints = [];
  if (web) hints = JSON.parse(web.hints).map(h => ({
    r: h[0], f: h[1], l: nameOf(gameOf(h[1]), "locs", h[2]), loc: h[1] === slot ? h[2] : null,
    i: nameOf(gameOf(h[0]), "items", h[3]), found: !!h[4], flags: h[6] || 0 }));
  else if (mine) hints = q("SELECT finder AS f, receiver AS r, location AS loc, location_name AS l, item_name AS i, flags, found FROM hints WHERE room=?")
    .all(run.dkey).map(h => ({ ...h, found: !!h.found, loc: h.f === slot ? h.loc : null }));

  const total = (q("SELECT total FROM webstats WHERE room=? AND slot=?").get(run.dkey, slot) || {}).total || null;
  const slotData = (web && web.slot_data && web.slot_data !== "null" ? web.slot_data : null) || (mine ? run.slot_data : null);

  // Logic: answer right away; a first build can take a while, the page asks again.
  let logic;
  if (!slotData) logic = { error: run.tracker_id
      ? "Für diesen Spieler hat archipelago.gg keine Spieldaten geliefert."
      : "Für den PopTracker fehlt bei diesem Run der Raum-Link von archipelago.gg (in den Einstellungen nachtragen)." };
  else {
    const items = [...got.values()].map(g => g.i);
    const job = logicFor(run, slot, p.game, p.name, slotData, items);
    const ready = await Promise.race([job.then(d => ({ d }), e => ({ e })), new Promise(r => setTimeout(() => r(null), 1500))]);
    if (!ready) { job.catch(() => {}); logic = { pending: true }; }
    else if (ready.e) logic = { error: ready.e.message };
    else {
      const d = ready.d;
      const loc = id => [id, nameOf(p.game, "locs", id)];
      logic = { ms: d.ms, unknown_items: d.unknown_items, reachable: d.reachable,
                regions: d.order.map(name => ({ name, locs: (d.regions[name] || []).map(loc) })) };
      // Checked places the rebuilt world does not have (options it could not read).
      const inWorld = new Set(d.order.flatMap(n => d.regions[n] || []));
      const extra = [...checked].filter(id => !inWorld.has(id)).sort((a, b) => a - b);
      if (extra.length) logic.regions.push({ name: "Sonstige (nicht in der Logik)", extra: true, locs: extra.map(loc) });
    }
  }

  const list = [...got.values()];
  const sig = [list.length, checked.size, hints.length, hints.filter(h => h.found).length,
               logic.pending ? "p" : logic.error ? "e" : "ok", webRev.get(run.dkey) || 0].join("|");
  return {
    sig, slot, name: p.name, game: p.game, total, mine,
    received: list, checked: [...checked].map(id => [id, nameOf(p.game, "locs", id)]), hints, logic,
    source: web ? "web" : "log",
  };
}

function adminRun(run) {
  const ls = liveStatus(run);
  return {
    ...runSummary(run), addr: run.addr, slot_name: run.slot_name, has_password: !!run.password,
    has_link: !!run.tracker_id, has_room_id: !!run.room_id, error: ls.error, seed: run.seed,
  };
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------
function json(res, code, body, headers = {}) {
  res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers });
  res.end(JSON.stringify(body));
}

function redirect(res, to) { res.writeHead(302, { location: to, "cache-control": "no-store" }); res.end(); }

function readBody(req) {
  return new Promise((ok, bad) => {
    let s = "";
    req.on("data", c => { s += c; if (s.length > 10_000) req.destroy(); });
    req.on("end", () => { try { ok(JSON.parse(s || "{}")); } catch (e) { bad(e); } });
    req.on("error", bad);
  });
}

const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
               ".css": "text/css; charset=utf-8", ".json": "application/json", ".svg": "image/svg+xml",
               ".png": "image/png", ".ico": "image/x-icon", ".woff2": "font/woff2" };

function sendFile(res, name, code = 200, cache = null) {
  const full = path.normalize(path.join(PUBLIC, name));
  if (!full.startsWith(PUBLIC + path.sep)) { res.writeHead(403); return res.end(); }
  fs.readFile(full, (err, buf) => {
    if (err) return notFound(res);
    const html = name.endsWith(".html");
    res.writeHead(code, { "content-type": MIME[path.extname(full)] || "application/octet-stream",
                          // Pages and their shared files change while the site runs: always revalidate.
                          // Fonts never change under the same name: cache them for a year.
                          "cache-control": cache || html || /\.(css|js)$/.test(name) ? "no-cache"
                            : name.endsWith(".woff2") ? "public, max-age=31536000, immutable" : "public, max-age=3600" });
    res.end(html ? withDesign(buf.toString("utf8")) : buf);
  });
}

function notFound(res) {
  res.writeHead(404, { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" });
  res.end(`<!doctype html><html lang="de" data-design="${siteDesign()}"><meta charset="utf-8"><link rel="icon" href="/favicon.svg" type="image/svg+xml"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Nicht gefunden · Archipelago Tracker</title><link rel="stylesheet" href="/common.css"><link rel="stylesheet" href="/theme.css">
<script src="/common.js"></script>
<body><header class="top"><h1><a class="brand" href="/"><span class="logo"></span><span class="bt">${escHtml(SITE_NAME)}</span></a></h1></header>
<main style="min-height:calc(100vh - 70px);display:grid;place-items:center;padding:16px">
<div class="card" style="text-align:center;padding:34px 40px;max-width:420px">
<div style="font-family:var(--head-font);font-size:54px;color:var(--accent);line-height:1">404</div>
<h2 style="margin:10px 0 6px">Nicht gefunden</h2><p style="color:var(--dim);margin:0 0 20px">Diese Seite gibt es nicht.</p>
<a class="btn" href="/" style="text-decoration:none;display:inline-block">Zur Hauptseite</a></div></main>
<script>langToggle()</script></body></html>`);
}

// URL names for players: the game ("Lies Of P" -> "liesofp"). Two players with the
// same game get their name added ("eldenring-alice").
const slugify = s => String(s || "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "");
function slugsOf(dkey) {
  const ps = q("SELECT slot, name, game FROM players WHERE room=? ORDER BY slot").all(dkey);
  const count = new Map();
  for (const x of ps) { const g = slugify(x.game); count.set(g, (count.get(g) || 0) + 1); }
  return ps.map(x => {
    const g = slugify(x.game) || "slot";
    const slug = count.get(g) > 1 ? `${g}-${slugify(x.name) || x.slot}` : g;
    return { slot: x.slot, game: x.game, slug, nameSlug: slugify(x.name) };
  });
}
/** Game slug, else player name, else slot number. */
const findSlug = (list, seg) => list.find(x => x.slug === seg) || list.find(x => x.nameSlug === seg)
  || list.find(x => String(x.slot) === seg) || null;

/** run.html with what to show (overview, a player, my tracker) written into the page. */
function sendRunPage(res, page) {
  fs.readFile(path.join(PUBLIC, "run.html"), "utf8", (err, html) => {
    if (err) return notFound(res);
    const tag = `<script>window.PAGE = ${JSON.stringify(page).replace(/</g, "\\u003c")};</script>`;
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" });
    res.end(withDesign(html).replace("<!--PAGE-->", tag));
  });
}

/** Only same-site paths are allowed as a target after login. */
const safeNext = n => (typeof n === "string" && /^\/(?!\/)[\w\-/]*$/.test(n)) ? n : "/settings";

async function handleAdmin(req, res, p) {
  if (p === "/api/admin/runs" && req.method === "GET") {
    const runs = q("SELECT * FROM runs ORDER BY id DESC").all().map(adminRun);
    return json(res, 200, { runs });
  }

  if (p === "/api/admin/site" && req.method === "POST") {
    const body = await readBody(req);
    if (body.icon !== undefined) {
      if (!ICONS.includes(body.icon)) return json(res, 400, { error: "unbekanntes Logo" });
      q("INSERT INTO site (key, value) VALUES ('icon', ?) ON CONFLICT (key) DO UPDATE SET value=excluded.value").run(body.icon);
      return json(res, 200, { ok: true, icon: body.icon });
    }
    if (!DESIGNS.includes(body.design)) return json(res, 400, { error: "unbekanntes Design" });
    q("INSERT INTO site (key, value) VALUES ('design', ?) ON CONFLICT (key) DO UPDATE SET value=excluded.value").run(body.design);
    return json(res, 200, { ok: true, design: body.design });
  }

  if (p === "/api/admin/lookup" && req.method === "POST") {
    const body = await readBody(req);
    try {
      const info = await lookupRoomLink(body.link);
      return json(res, 200, { addr: info.port ? DEFAULT_HOST + ":" + info.port : null, players: info.players });
    } catch (e) { return json(res, 400, { error: e.message }); }
  }

  if (p === "/api/admin/runs" && req.method === "POST") {
    const body = await readBody(req);
    const slot = String(body.slot || "").trim();
    const title = String(body.title || "").trim().slice(0, 80) || null;
    const template = null;
    const password = String(body.password || "") || null;
    const hidden = body.hidden ? 1 : 0;
    let addr = body.addr ? normalizeAddr(body.addr) : null;
    if (body.addr && !addr) return json(res, 400, { error: "Adresse bitte als host:port, z. B. archipelago.gg:38281" });
    let info = null;
    if (String(body.link || "").trim()) {
      try { info = await lookupRoomLink(body.link); } catch (e) { return json(res, 400, { error: e.message }); }
      if (!addr && info.port) addr = DEFAULT_HOST + ":" + info.port;
      if (addr && addr.startsWith(DEFAULT_HOST + ":") && info.port && String(info.port) !== addr.split(":")[1])
        return json(res, 400, { error: `Der Raum-Link gehört zu Port ${info.port}, nicht zu ${addr}.` });
      if (slot && info.players.length && !info.players.some(x => x.name.toLowerCase() === slot.toLowerCase()))
        return json(res, 400, { error: `"${slot}" spielt in diesem Raum nicht mit.` });
    }
    if (!addr) return json(res, 400, { error: "Adresse (ip) oder Raum-Link fehlt." });
    if (!slot) return json(res, 400, { error: "Welcher User bist du in diesem Raum?" });
    const dup = q("SELECT id FROM runs WHERE addr=? AND ended IS NULL").get(addr);
    if (dup) return json(res, 409, { error: `Diese Adresse läuft schon als Run #${dup.id}.` });
    if (rooms.size >= MAX_OPEN_RUNS) return json(res, 429, { error: "Zu viele offene Runs. Beende zuerst einen." });

    const tmp = "new-" + crypto.randomUUID();
    const { lastInsertRowid } = q(`INSERT INTO runs (dkey, title, addr, password, slot_name, template, tracker_id, room_id, created, hidden)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(tmp, title, addr, password, slot, template,
        info ? info.tracker : null, info ? info.roomId : null, now(), hidden);
    const id = Number(lastInsertRowid);
    q("UPDATE runs SET dkey=? WHERE id=?").run("run-" + id, id);
    if (info) {
      const ins = q("INSERT OR IGNORE INTO players (room, slot, name, game) VALUES (?,?,?,?)");
      info.players.forEach((x, i) => ins.run("run-" + id, i + 1, x.name, x.game || "?"));
    }
    const r = ensureRoom(getRun(id));
    const ok = await r.waitReady(15_000);
    if (!ok && r.status === "abgelehnt") {
      const err = r.error;
      deleteRun(id);
      return json(res, 400, { error: err + ` (User "${slot}")` });
    }
    if (info && info.tracker) pollWeb("run-" + id, info.tracker).catch(() => {});
    return json(res, 200, {
      id, connected: ok,
      warning: ok ? null : "Raum gerade nicht erreichbar. Der Run ist angelegt, der Tracker versucht es weiter.",
    });
  }

  const m = /^\/api\/admin\/runs\/(\d+)$/.exec(p);
  if (m && req.method === "POST") {
    const id = Number(m[1]);
    const run = getRun(id);
    if (!run) return json(res, 404, { error: "Run nicht gefunden" });
    const body = await readBody(req);
    switch (body.action) {
      case "end": endRun(id, false); break;
      case "reopen": reopenRun(id); break;
      case "hide": q("UPDATE runs SET hidden=1 WHERE id=?").run(id); break;
      case "show": q("UPDATE runs SET hidden=0 WHERE id=?").run(id); break;
      case "delete": deleteRun(id); break;
      case "edit": {
        const title = String(body.title || "").trim().slice(0, 80) || null;
        q("UPDATE runs SET title=? WHERE id=?").run(title, id);
        if ("hidden" in body) q("UPDATE runs SET hidden=? WHERE id=?").run(body.hidden ? 1 : 0, id);
        // Connection settings (edit dialog): only what was sent changes, then reconnect.
        let reconnect = false;
        if ("addr" in body) {
          const addr = normalizeAddr(body.addr);
          if (!addr) return json(res, 400, { error: "Adresse bitte als host:port, z. B. archipelago.gg:38281" });
          const dup = q("SELECT id FROM runs WHERE addr=? AND ended IS NULL AND id<>?").get(addr, id);
          if (dup && !run.ended) return json(res, 409, { error: `Diese Adresse läuft schon als Run #${dup.id}.` });
          if (addr !== run.addr) { q("UPDATE runs SET addr=? WHERE id=?").run(addr, id); reconnect = true; }
        }
        if ("slot" in body) {
          const slot = String(body.slot || "").trim();
          if (!slot) return json(res, 400, { error: "Welcher User bist du in diesem Raum?" });
          if (slot !== run.slot_name) { q("UPDATE runs SET slot_name=? WHERE id=?").run(slot, id); reconnect = true; }
        }
        if (body.password_clear) { q("UPDATE runs SET password=NULL WHERE id=?").run(id); reconnect = true; }
        else if (body.password) { q("UPDATE runs SET password=? WHERE id=?").run(String(body.password), id); reconnect = true; }
        if (reconnect && rooms.has(id)) { stopRoom(id); ensureRoom(getRun(id)); }
        break;
      }
      case "link": {
        try {
          const info = await lookupRoomLink(body.link);
          // Same room = same players. (The port may have changed since.)
          const known = q("SELECT name FROM players WHERE room=?").all(run.dkey).map(x => x.name.toLowerCase()).sort().join("|");
          const linked = info.players.map(x => x.name.toLowerCase()).sort().join("|");
          if (known && linked && known !== linked)
            return json(res, 400, { error: "Die Spieler in diesem Raum passen nicht zu diesem Run." });
          const addr = info.port && run.addr.startsWith(DEFAULT_HOST + ":") ? DEFAULT_HOST + ":" + info.port : run.addr;
          q("UPDATE runs SET tracker_id=?, room_id=?, addr=? WHERE id=?").run(info.tracker, info.roomId, addr, id);
          const live = rooms.get(id);
          if (live) { live.roomId = info.roomId; if (live.addr !== addr) { live.addr = addr; if (!live.connected) live.start(true); } }
          if (info.tracker) await pollWeb(run.dkey, info.tracker);
        } catch (e) { return json(res, 400, { error: e.message }); }
        break;
      }
      default: return json(res, 400, { error: "unbekannte Aktion" });
    }
    return json(res, 200, { ok: true });
  }

  return json(res, 404, { error: "unbekannt" });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const p = url.pathname;
  try {
    // ---- login ----
    if (p === "/api/login" && req.method === "POST") {
      const ip = clientIp(req);
      const f = loginFails.get(ip);
      if (f && f.n >= 5 && now() - f.t < 15 * 60_000)
        return json(res, 429, { error: "Zu viele Versuche. Bitte in 15 Minuten nochmal." });
      const body = await readBody(req);
      if (!checkPassword(body.password)) {
        const cur = f && now() - f.t < 15 * 60_000 ? f : { n: 0, t: now() };
        loginFails.set(ip, { n: cur.n + 1, t: cur.t });
        await new Promise(r => setTimeout(r, 600));
        return json(res, 401, { error: ADMIN_HASH ? "Falsches Passwort." : "Kein Admin-Passwort eingerichtet." });
      }
      loginFails.delete(ip);
      return json(res, 200, { ok: true, next: safeNext(body.next) }, { "set-cookie": sessionCookie(true) });
    }
    if (p === "/api/logout" && req.method === "POST")
      return json(res, 200, { ok: true }, { "set-cookie": sessionCookie(false) });
    if (p === "/api/me") return json(res, 200, { admin: isAdmin(req) });

    if (p.startsWith("/api/admin/")) {
      if (!isAdmin(req)) return json(res, 401, { error: "Bitte einloggen." });
      // Changes only from our own pages: a JSON body cannot come from a plain cross-site form.
      if (req.method !== "GET" && !String(req.headers["content-type"] || "").startsWith("application/json"))
        return json(res, 415, { error: "JSON erwartet" });
      return await handleAdmin(req, res, p);
    }

    // ---- public data ----
    if (p === "/api/runs") {
      const admin = isAdmin(req);
      const runs = q("SELECT * FROM runs ORDER BY (ended IS NOT NULL), COALESCE(ended, created) DESC").all()
        .filter(r => admin || !r.hidden).map(runSummary);
      return json(res, 200, { runs });
    }

    const api = /^\/api\/run\/(\d+)\/(state|events|slot)$/.exec(p);
    if (api) {
      const admin = isAdmin(req);
      const run = seeRun(api[1], admin);
      if (!run) return json(res, 404, { error: "Run nicht gefunden" });
      // Every player's own PopTracker: public, contains no placements.
      if (api[2] === "slot") {
        const v = await slotView(run, Number(url.searchParams.get("slot")));
        if (!v) return json(res, 404, { error: "Spieler nicht gefunden" });
        if (url.searchParams.get("sig") === v.sig) return json(res, 200, { same: true });
        return json(res, 200, v);
      }
      if (api[2] === "state") return json(res, 200, state(run, Number(url.searchParams.get("since") || 0), admin));
      if (api[2] === "events")
        return json(res, 200, { events: olderEvents(run, Number(url.searchParams.get("before") || 0), Number(url.searchParams.get("limit") || 2000)) });
      return json(res, 404, { error: "unbekannt" });
    }

    if (p === "/healthz") return json(res, 200, { ok: true, open_runs: rooms.size });
    if (p.startsWith("/api/")) return json(res, 404, { error: "unbekannt" });

    // ---- pages ----
    if (p === "/") return sendFile(res, "home.html");
    if (p === "/datenschutz" || p === "/privacy") return sendFile(res, "datenschutz.html");
    if (ICON_FILES[p]) return sendFile(res, `icon-${siteIcon()}${ICON_FILES[p]}`, 200, "no-cache");
    if (p === "/login") return isAdmin(req) ? redirect(res, safeNext(url.searchParams.get("next"))) : sendFile(res, "login.html");
    if (p === "/settings") return isAdmin(req) ? sendFile(res, "settings.html") : redirect(res, "/login?next=/settings");

    const logm = /^\/run-(\d+)\/log(\.html)?$/.exec(p);
    if (logm) {
      const run = seeRun(logm[1], isAdmin(req));
      if (!run) return notFound(res);
      ensureLogFile(run);
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache",
        ...(url.searchParams.has("download") ? { "content-disposition": `attachment; filename="run-${run.id}-log.html"` } : {}) });
      return fs.createReadStream(logPath(run.id)).pipe(res);
    }

    //   /run-N                     overview (public)
    //   /run-N/<game>/poptracker   one player's PopTracker (public), e.g. /run-2/liesofp/poptracker
    const page = /^\/run-(\d+)(?:\/([a-z0-9-]+)(?:\/(poptracker))?)?\/?$/.exec(p);
    if (page) {
      const run = seeRun(page[1], isAdmin(req));
      if (!run) return notFound(res);
      const [, , seg, view] = page;
      const slugs = slugsOf(run.dkey);
      if (!seg) return sendRunPage(res, { run: run.id, mode: "overview" });
      const pl = findSlug(slugs, seg);
      if (!pl) return notFound(res);
      if (!view) return redirect(res, `/run-${run.id}/${pl.slug}/poptracker`);
      return sendRunPage(res, { run: run.id, mode: "player", slot: pl.slot });
    }

    // Static assets (pages only through the routes above).
    const ext = path.extname(p);
    if (ext && ext !== ".html" && /^\/[\w.-]+$/.test(p)) return sendFile(res, p.slice(1));
    return notFound(res);
  } catch (e) {
    console.error(e);
    json(res, 500, { error: "Serverfehler" });
  }
});

server.listen(PORT, () => console.log(`tracker on :${PORT}, ${rooms.size} open runs, db ${DB_PATH}` +
  (ADMIN_HASH ? "" : "  (WARNUNG: kein ADMIN_PASSWORD_HASH gesetzt, Login geht nicht)")));
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { for (const r of rooms.values()) r.stop(); db.close(); process.exit(0); });
