"""Reachability service for the Archipelago run tracker.

Rebuilds a single Archipelago world from a room's slot_data (the way Universal
Tracker does it, so the world's own rules decide) and answers: with these
received items, which locations can be reached right now?

  POST /reach  {game, slot_name, seed, slot_data, items: [item names]}
            -> {locations: [all location ids], reachable: [ids], unknown_items: [...], ms}
  GET  /health -> {ok, games}

Only listens inside the docker network; the tracker server is the only client.
"""
import hashlib
import json
import logging
import os
import sys
import threading
import time
from argparse import Namespace
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

os.chdir("/ap")
sys.path.insert(0, "/ap")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("ap-logic")

from BaseClasses import CollectionState, MultiWorld, PlandoOptions  # noqa: E402
from worlds import AutoWorld  # noqa: E402  (importing loads all worlds, also custom_worlds/)

STEPS = ("generate_early", "create_regions", "create_items", "set_rules", "connect_entrances", "generate_basic")
# One cached world per player and run; every player of a run can have their own tracker.
MAX_WORLDS = int(os.environ.get("MAX_WORLDS", "12"))

_worlds: dict[str, dict] = {}          # cache key -> {"mw", "lock", "used"}
_cache_lock = threading.Lock()


def build_world(game: str, slot_name: str, seed: str, slot_data: dict) -> MultiWorld:
    world_type = AutoWorld.AutoWorldRegister.world_types[game]
    mw = MultiWorld(1)
    mw.game = {1: game}
    mw.player_name = {1: slot_name or "Player"}
    mw.set_seed(int(hashlib.sha1(str(seed).encode()).hexdigest()[:12], 16))
    # Worlds that support Universal Tracker read their options from here.
    mw.re_gen_passthrough = {game: slot_data}
    # Many worlds put their YAML options into slot_data, at the top or under "options".
    # Use them where the names match; worlds with Universal Tracker support still
    # override this in generate_early from re_gen_passthrough.
    given = {}
    if isinstance(slot_data, dict):
        given.update(slot_data)
        for sub in ("options", "slot_options"):
            if isinstance(slot_data.get(sub), dict):
                given.update(slot_data[sub])
    args = Namespace()
    for name, option in world_type.options_dataclass.type_hints.items():
        value = option.from_any(option.default)
        if name in given:
            try:
                candidate = option.from_any(given[name])
                if hasattr(candidate, "verify"):
                    candidate.verify(world_type, slot_name or "Player", PlandoOptions.bosses)
                value = candidate
            except Exception:
                pass   # slot_data uses its own format for this one: keep the default
        # Like a normal generation: expands location/item groups and checks names.
        if hasattr(value, "verify"):
            value.verify(world_type, slot_name or "Player", PlandoOptions.bosses)
        setattr(args, name, {1: value})
    mw.set_options(args)
    mw.state = CollectionState(mw)
    for step in STEPS:
        AutoWorld.call_all(mw, step)
    return mw


def get_world(game: str, slot_name: str, seed: str, slot_data: dict) -> dict:
    key = hashlib.sha1(json.dumps([game, slot_name, seed, slot_data], sort_keys=True).encode()).hexdigest()
    with _cache_lock:
        entry = _worlds.get(key)
        if entry is None:
            entry = {"mw": None, "lock": threading.Lock(), "used": 0.0}
            _worlds[key] = entry
            if len(_worlds) > MAX_WORLDS:   # forget the least recently used one
                oldest = min((k for k in _worlds if k != key), key=lambda k: _worlds[k]["used"])
                del _worlds[oldest]
    with entry["lock"]:
        if entry["mw"] is None:
            t = time.time()
            entry["mw"] = build_world(game, slot_name, seed, slot_data)
            log.info("built %s for %s in %.1fs", game, slot_name, time.time() - t)
        entry["used"] = time.time()
    return entry


def reach(req: dict) -> dict:
    t0 = time.time()
    game = req["game"]
    if game not in AutoWorld.AutoWorldRegister.world_types:
        raise ValueError(f"unknown game {game!r}")
    entry = get_world(game, req.get("slot_name", ""), req.get("seed", ""), req.get("slot_data") or {})
    mw: MultiWorld = entry["mw"]
    world = mw.worlds[1]
    with entry["lock"]:
        state = CollectionState(mw)
        unknown = set()
        for name in req.get("items", []):
            try:
                state.collect(world.create_item(name), prevent_sweep=True)
            except Exception:
                unknown.add(name)
        state.sweep_for_advancements()
        locations = [loc for loc in mw.get_locations(1) if loc.address is not None]
        reachable = [loc.address for loc in locations if loc.can_reach(state)]
    # The world's own regions, in the order it created them, for grouping on the page.
    order, regions = [], {}
    for loc in locations:
        name = loc.parent_region.name if loc.parent_region else "?"
        if name not in regions:
            regions[name] = []
            order.append(name)
        regions[name].append(loc.address)
    return {"locations": [loc.address for loc in locations], "reachable": reachable,
            "regions": regions, "order": order,
            "unknown_items": sorted(unknown)[:50], "ms": round((time.time() - t0) * 1000)}


class Handler(BaseHTTPRequestHandler):
    def _send(self, code: int, body: dict) -> None:
        data = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path == "/health":
            return self._send(200, {"ok": True, "games": sorted(AutoWorld.AutoWorldRegister.world_types)})
        self._send(404, {"error": "not found"})

    def do_POST(self):
        if self.path != "/reach":
            return self._send(404, {"error": "not found"})
        try:
            size = int(self.headers.get("content-length", "0"))
            if size > 5_000_000:
                return self._send(413, {"error": "too large"})
            self._send(200, reach(json.loads(self.rfile.read(size))))
        except Exception as e:
            log.exception("reach failed")
            self._send(400, {"error": f"{type(e).__name__}: {e}"})

    def log_message(self, fmt, *args):
        pass


if __name__ == "__main__":
    if len(sys.argv) > 2 and sys.argv[1] == "--test":
        with open(sys.argv[2]) as f:
            req = json.load(f)
        out = reach(req)
        print(json.dumps({"locations": len(out["locations"]), "reachable": len(out["reachable"]),
                          "unknown_items": out["unknown_items"][:10], "ms": out["ms"]}))
        out2 = reach(req)
        print("second call ms", out2["ms"])
        sys.exit(0)
    port = int(os.environ.get("PORT", "8000"))
    log.info("ap-logic on :%d", port)
    ThreadingHTTPServer(("0.0.0.0", port), Handler).serve_forever()
