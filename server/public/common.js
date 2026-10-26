"use strict";
// Shared by all pages: language (DE/EN, remembered per browser), dates, the toggle.

// Designs, one per game of the first run. The server writes the site default into
// <html data-design>; a visitor's own pick (header) wins and stays in their browser.
const DESIGNS = [
  { id: "erdtree", name: "Elden Ring", sub: "Gold und Erdbaum-Schimmer" },
  { id: "liesofp", name: "Lies of P", sub: "Kupfer und Petrol, Belle Époque" },
  { id: "bg3", name: "Baldur's Gate 3", sub: "Gold auf tiefem Violett" },
  { id: "ds3", name: "Dark Souls III", sub: "Asche und Glut" },
  { id: "silksong", name: "Silksong", sub: "Knochenweiß und Seidenrot" },
  { id: "classic", name: "Klassisch", sub: "Die ursprüngliche Optik, mit mehr Tiefe" },
  { id: "archipelago", name: "Archipelago", sub: "Nachtblau, Inseln und Logo-Farben" },
  { id: "ozean", name: "Ozean", sub: "Tiefblau und Türkis mit Wellen" },
  { id: "graphit", name: "Graphit", sub: "Schlichtes Dunkelgrau mit Blau" },
  { id: "mono", name: "Mono", sub: "Schwarz und Weiß, ganz reduziert" },
  { id: "hell", name: "Hell", sub: "Helles Design auf warmem Papierton" },
];
const DESIGN_KEY = "tracker_design";
const SITE_DESIGN = DESIGNS.some(d => d.id === document.documentElement.dataset.design)
  ? document.documentElement.dataset.design : "archipelago";
function myDesign() {
  try { const v = localStorage.getItem(DESIGN_KEY); if (DESIGNS.some(d => d.id === v)) return v; } catch (e) {}
  return null;
}
document.documentElement.dataset.design = myDesign() || SITE_DESIGN;

// German unless someone picked English.
const LANG_KEY = "tracker_lang";
function readLang() {
  try { const v = localStorage.getItem(LANG_KEY); if (v === "de" || v === "en") return v; } catch (e) {}
  return "de";
}
let LANG = readLang();
const I18N = { de: {}, en: {} };

/** t("key", {n: 3}) -> text in the current language, German as fallback. */
function t(key, vars) {
  let s = (I18N[LANG] && I18N[LANG][key]) ?? I18N.de[key] ?? key;
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.split("{" + k + "}").join(v);
  return s;
}

function applyI18n(root = document) {
  document.documentElement.lang = LANG;
  root.querySelectorAll("[data-i18n]").forEach(el => { el.textContent = t(el.dataset.i18n); });
  root.querySelectorAll("[data-i18n-html]").forEach(el => { el.innerHTML = t(el.dataset.i18nHtml); });
  root.querySelectorAll("[data-i18n-ph]").forEach(el => { el.placeholder = t(el.dataset.i18nPh); });
}

const locale = () => LANG === "de" ? "de-DE" : "en-GB";
const fmtDate = t => new Date(t).toLocaleString(locale(),
  { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
const fmtDay = t => new Date(t).toLocaleDateString(locale(), { day: "2-digit", month: "2-digit", year: "numeric" });
const fmtTime = t => new Date(t).toLocaleTimeString(locale(), { hour: "2-digit", minute: "2-digit" });

function fmtAgo(ts) {
  if (!ts) return "";
  const s = Math.round((Date.now() - ts) / 1000);
  const de = LANG === "de";
  if (s < 60) return de ? "gerade eben" : "just now";
  if (s < 3600) return de ? `vor ${Math.round(s / 60)} min` : `${Math.round(s / 60)} min ago`;
  if (s < 86400) return de ? `vor ${Math.round(s / 3600)} h` : `${Math.round(s / 3600)} h ago`;
  return fmtDay(ts);
}

function fmtSpan(a, b) {
  const m = Math.max(0, Math.round((b - a) / 60000));
  const d = Math.floor(m / 1440), h = Math.floor(m % 1440 / 60), mm = m % 60;
  if (d) return `${d} ${LANG === "de" ? (d === 1 ? "Tag" : "Tage") : (d === 1 ? "day" : "days")} ${h} h`;
  return h ? `${h} h ${mm} min` : `${mm} min`;
}

// Flags as SVG: Windows shows flag emoji as plain letters.
const FLAGS = {
  de: `<svg viewBox="0 0 5 3" aria-hidden="true"><rect width="5" height="1" fill="#000"/><rect y="1" width="5" height="1" fill="#D00"/><rect y="2" width="5" height="1" fill="#FFCE00"/></svg>`,
  en: `<svg viewBox="0 0 60 30" aria-hidden="true"><clipPath id="fgb"><path d="M0 0v30h60V0z"/></clipPath><clipPath id="fgb2"><path d="M30 15h30v15zv15H0zH0V0zV0h30z"/></clipPath><g clip-path="url(#fgb)"><path d="M0 0v30h60V0z" fill="#012169"/><path d="M0 0l60 30m0-30L0 30" stroke="#fff" stroke-width="6"/><path d="M0 0l60 30m0-30L0 30" clip-path="url(#fgb2)" stroke="#C8102E" stroke-width="4"/><path d="M30 0v30M0 15h60" stroke="#fff" stroke-width="10"/><path d="M30 0v30M0 15h60" stroke="#C8102E" stroke-width="6"/></g></svg>`,
};
const GEAR = `<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M19.4 13a7.6 7.6 0 0 0 0-2l2.1-1.6-2-3.5-2.5 1a7.4 7.4 0 0 0-1.7-1L15 3h-4l-.4 2.9a7.4 7.4 0 0 0-1.7 1l-2.5-1-2 3.5L6.6 11a7.6 7.6 0 0 0 0 2l-2.1 1.6 2 3.5 2.5-1a7.4 7.4 0 0 0 1.7 1L11 21h4l.4-2.9a7.4 7.4 0 0 0 1.7-1l2.5 1 2-3.5zM13 15.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7z" transform="translate(-1 0)"/></svg>`;

/**
 * The same right end of the header on every page: language (flags) and the
 * settings cog. `extra` nodes (e.g. Logout) go in front of them.
 */
function langToggle(onChange, extra) {
  const header = document.querySelector("header");
  if (!header) return;
  const box = document.createElement("div");
  box.className = "hright";
  for (const n of extra || []) box.appendChild(n);

  // Design for this browser only.
  // Own menu instead of <select>: native option lists cannot be spaced or styled.
  const ds = document.createElement("div");
  ds.className = "dsgsel";
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "dsgbtn";
  btn.title = "Design (nur für dich)";
  btn.setAttribute("aria-haspopup", "listbox");
  btn.setAttribute("aria-expanded", "false");
  const menu = document.createElement("div");
  menu.className = "dsgmenu";
  menu.setAttribute("role", "listbox");
  menu.hidden = true;
  const cur = () => DESIGNS.find(d => d.id === document.documentElement.dataset.design) || DESIGNS[0];
  const drawBtn = () => { btn.innerHTML = `<span class="sw" data-design="${cur().id}"></span><span class="nm"></span><span class="car">▾</span>`; btn.querySelector(".nm").textContent = cur().name; };
  const close = () => { menu.hidden = true; btn.setAttribute("aria-expanded", "false"); };
  const drawMenu = () => {
    menu.innerHTML = "";
    for (const d of DESIGNS) {
      const o = document.createElement("button");
      o.type = "button";
      o.className = "dsgopt" + (d.id === cur().id ? " on" : "");
      o.setAttribute("role", "option");
      o.setAttribute("aria-selected", d.id === cur().id ? "true" : "false");
      o.innerHTML = `<span class="sw" data-design="${d.id}"></span><span class="tx"><b></b><small></small></span><span class="ck ic">check</span>`;
      o.querySelector("b").textContent = d.name;
      o.querySelector("small").textContent = d.sub;
      o.onclick = () => {
        document.documentElement.dataset.design = d.id;
        try { localStorage.setItem(DESIGN_KEY, d.id); } catch (e) {}
        drawBtn(); close();
        document.dispatchEvent(new CustomEvent("designchange"));
      };
      menu.appendChild(o);
    }
  };
  btn.onclick = e => {
    e.stopPropagation();
    if (!menu.hidden) return close();
    drawMenu(); menu.hidden = false; btn.setAttribute("aria-expanded", "true");
  };
  document.addEventListener("click", e => { if (!ds.contains(e.target)) close(); });
  document.addEventListener("keydown", e => { if (e.key === "Escape") close(); });
  drawBtn();
  ds.append(btn, menu);
  box.appendChild(ds);

  const sw = document.createElement("div");
  sw.className = "langsw";
  sw.setAttribute("role", "group");
  sw.title = "Sprache / Language";
  for (const l of ["de", "en"]) {
    const b = document.createElement("button");
    b.type = "button";
    b.dataset.lang = l;
    b.innerHTML = FLAGS[l] + `<span>${l.toUpperCase()}</span>`;
    b.title = l === "de" ? "Deutsch" : "English";
    b.onclick = () => {
      if (LANG === l) return;
      LANG = l;
      try { localStorage.setItem(LANG_KEY, LANG); } catch (e) {}
      draw();
      applyI18n();
      document.dispatchEvent(new CustomEvent("langchange"));
      if (onChange) onChange();
    };
    sw.appendChild(b);
  }
  const draw = () => sw.querySelectorAll("button").forEach(b => b.classList.toggle("on", b.dataset.lang === LANG));
  draw();
  box.appendChild(sw);
  const cog = document.createElement("a");
  cog.className = "cog" + (location.pathname === "/settings" ? " on" : "");
  cog.href = "/settings";
  cog.innerHTML = GEAR;
  cog.title = LANG === "de" ? "Einstellungen" : "Settings";
  cog.setAttribute("aria-label", cog.title);
  box.appendChild(cog);
  header.appendChild(box);
}

/** Icon from Material Symbols (Google Fonts): ic("skull") -> HTML, icEl("skull") -> element. */
function ic(name, cls) { return `<span class="ic${cls ? " " + cls : ""}" aria-hidden="true">${name}</span>`; }
function icEl(name, cls) { const s = document.createElement("span"); s.className = "ic" + (cls ? " " + cls : ""); s.setAttribute("aria-hidden", "true"); s.textContent = name; return s; }

// ---------------------------------------------------------------------------
// Footer and the privacy notice, on every page.
// ---------------------------------------------------------------------------
Object.assign(I18N.de, {
  ftPrivacy: "Datenschutz", ftNoTrack: "Kein Tracking, keine Werbung",
  ntText: "Hier gibt es kein Tracking und keine Werbung. Gespeichert werden nur deine Sprache und dein Design, in deinem Browser.",
  ntMore: "Mehr dazu", ntOk: "Verstanden",
});
Object.assign(I18N.en, {
  ftPrivacy: "Privacy", ftNoTrack: "No tracking, no ads",
  ntText: "No tracking and no ads here. Only your language and design are stored, in your browser.",
  ntMore: "Details", ntOk: "Got it",
});
const NOTICE_KEY = "tracker_notice";

const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

function siteFooter() {
  if (document.querySelector("footer.site")) return;
  const f = document.createElement("footer");
  f.className = "site";
  const draw = () => {
    f.innerHTML = `<span class="cr">${ic("copyright", "o")} ${new Date().getFullYear()} ${esc((window.SITE && (SITE.owner || SITE.name)) || "Archipelago Run Tracker")}</span>
      <span class="sep">·</span><a href="/datenschutz">${ic("shield", "o")} ${t("ftPrivacy")}</a>
      <span class="sep">·</span><span class="nt">${t("ftNoTrack")}</span>`;
  };
  draw();
  document.body.appendChild(f);
  document.addEventListener("langchange", draw);

  let seen = false;
  try { seen = localStorage.getItem(NOTICE_KEY) === "1"; } catch (e) {}
  if (seen || location.pathname === "/datenschutz") return;
  const n = document.createElement("div");
  n.className = "notice";
  n.setAttribute("role", "status");
  const drawN = () => {
    n.innerHTML = `${ic("cookie", "o")}<p>${t("ntText")} <a href="/datenschutz">${t("ntMore")}</a></p><button type="button" class="sub">${t("ntOk")}</button>`;
    n.querySelector("button").onclick = () => { try { localStorage.setItem(NOTICE_KEY, "1"); } catch (e) {} n.remove(); };
  };
  drawN();
  document.addEventListener("langchange", drawN);
  document.body.appendChild(n);
}
document.addEventListener("DOMContentLoaded", siteFooter);


async function isAdmin() {
  try { return (await (await fetch("/api/me", { cache: "no-store" })).json()).admin; } catch (e) { return false; }
}
