# Archipelago Run Tracker

A self-hosted live tracker for [Archipelago](https://archipelago.gg) multiworld runs.
It stays connected to your rooms in the background, so nothing is missed while nobody has the page open.

- **Run overview** — every player with progress, deaths (DeathLink), goal/release state and the last item.
- **The full room log** — searchable, filterable by player, downloadable as an HTML file.
- **A PopTracker for every player, for any game** — pick yourself in the top left and see which of your
  open locations are *in logic right now*, your received items and your hints. The logic is not hand-written:
  it rebuilds the real Archipelago world from the room's `slot_data`, so the game's own rules decide.
- **No spoilers** — the public pages never show where items are placed.
- **Designs** — eleven themes, picked per visitor in the header; the default is set in `/settings`.
- **Logo** — two built-in logos (Pin, Kompass) for favicon and header, chosen in `/settings`; the header mark takes the colour of the design.
- **Private test runs** — hidden from everyone but you.
- **No tracking, no third parties** — fonts and icons are self-hosted, no cookies except your own admin login.

Pages are German by default with an English switch.

## How it works

```
browser ──► tracker (Node, SQLite) ──► Archipelago room (WebSocket, read-only "Tracker" client)
                 │                └──► archipelago.gg tracker API (all players' items, checks, hints, slot_data)
                 └──► ap-logic (Python, Archipelago 0.6.8 + apworlds): "which locations can this player reach?"
```

- `server/` — the tracker: one `server.mjs` (Node ≥ 22.13, no npm packages) and the static pages in `server/public/`.
- `ap-logic/` — a small HTTP service that builds an Archipelago world from `slot_data` and answers reachability.

## Setup

Requirements: Docker with Compose, a domain and a reverse proxy for HTTPS (example below).

```sh
git clone https://github.com/<you>/archipelago-run-tracker
cd archipelago-run-tracker
cp .env.example .env
node tools/make-password.mjs "your admin password"   # paste the line into .env
# also set SESSION_SECRET, SITE_NAME and SITE_OWNER in .env
docker compose up -d --build
```

The first build of `ap-logic` downloads Archipelago and takes a few minutes.
The tracker listens on `127.0.0.1:8095`. Example Caddy config:

```
tracker.example.com {
	encode zstd gzip
	reverse_proxy 127.0.0.1:8095
}
```

Then open `https://tracker.example.com/login`, log in and add a run in `/settings`:
paste the room link (`https://archipelago.gg/room/…`) and pick your slot name.
The room link fills in the address and the player list, gives exact progress for every player
and lets the tracker follow the room when archipelago.gg moves it to a new port.

## Games and apworlds

Every game that is part of Archipelago 0.6.8 works out of the box. For other games put their `.apworld`
into `ap-logic/apworlds/` and run `docker compose up -d --build ap-logic`. Without it, that player's page still
shows items, checks and hints, just not what is reachable.

## Addresses

| Address | What |
|---|---|
| `/` | all runs |
| `/run-N` | live overview of run N |
| `/run-N/<game>/poptracker` | one player's tracker, e.g. `/run-2/darksoulsiii/poptracker` |
| `/run-N/log` | the full log as a file |
| `/login`, `/settings` | admin |
| `/datenschutz` | privacy page (a template — adapt it to how you run the site) |

## Development

```sh
cd server
PORT=8787 DB_PATH=./data/tracker.db ADMIN_PASSWORD_HASH=... node server.mjs
```

Page changes (`server/public/`) are picked up on reload; the compose file mounts that folder into the container.
`tools/fonts.py server/public` re-downloads the self-hosted fonts; add new Material Symbols icon names to its list first.

## License

MIT, see [LICENSE](LICENSE). Archipelago and the games named in the designs belong to their respective owners;
the background drawings are original and only inspired by them.
