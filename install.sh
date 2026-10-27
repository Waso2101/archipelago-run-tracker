#!/bin/sh
# Archipelago Run Tracker: install or update.
#
#   curl -fsSL https://raw.githubusercontent.com/Waso2101/archipelago-run-tracker/main/install.sh | sh
#
# Installs the latest release into ./archipelago-run-tracker (or $TRACKER_DIR). Run it again in the
# same place to update: .env, data/ and your own files stay. Without a terminal (CI, scripts) the
# answers come from the environment: SITE_NAME, SITE_OWNER, ADMIN_PASSWORD, TRACKER_PORT.
# TRACKER_VERSION=v0.1.0 picks a release instead of the latest one.
set -eu

REPO=Waso2101/archipelago-run-tracker
IMAGE=ghcr.io/waso2101/archipelago-run-tracker
DIR=${TRACKER_DIR:-archipelago-run-tracker}

say() { printf '%s\n' "$*"; }
die() { printf 'Error: %s\n' "$*" >&2; exit 1; }
has_tty() { [ -r /dev/tty ] && [ -w /dev/tty ] && (: </dev/tty) 2>/dev/null; }

# ask VAR "Question" default  (keeps VAR if it is already set in the environment)
ask() {
  eval "cur=\${$1:-}"
  if [ -n "$cur" ]; then return; fi
  if has_tty; then
    printf '%s [%s]: ' "$2" "$3" >/dev/tty
    IFS= read -r ans </dev/tty || ans=""
  else
    ans=""
  fi
  [ -n "$ans" ] || ans=$3
  eval "$1=\$ans"
}

ask_password() {
  if [ -n "${ADMIN_PASSWORD:-}" ]; then return; fi
  has_tty || die "no terminal for the password prompt; set ADMIN_PASSWORD"
  while :; do
    printf 'Admin password for /settings (min. 8 characters): ' >/dev/tty
    stty -echo </dev/tty; IFS= read -r p1 </dev/tty || p1=""; stty echo </dev/tty; printf '\n' >/dev/tty
    printf 'Repeat: ' >/dev/tty
    stty -echo </dev/tty; IFS= read -r p2 </dev/tty || p2=""; stty echo </dev/tty; printf '\n' >/dev/tty
    if [ "${#p1}" -lt 8 ]; then say "Too short." >/dev/tty
    elif [ "$p1" != "$p2" ]; then say "Not the same, again." >/dev/tty
    else ADMIN_PASSWORD=$p1; break; fi
  done
}

# Values go into .env in single quotes, so "$" stays literal. A "'" in them is swapped for a typographic one.
envq() { printf "'%s'" "$(printf '%s' "$1" | sed "s/'/’/g")"; }

# set_env KEY value: replace the line in .env or append it
set_env() {
  if grep -q "^$1=" .env; then
    tmp=$(mktemp); grep -v "^$1=" .env >"$tmp"; cat "$tmp" >.env; rm -f "$tmp"
  fi
  printf '%s=%s\n' "$1" "$2" >>.env
}

# --- checks ---
command -v docker >/dev/null || die "Docker is missing: https://docs.docker.com/engine/install/"
docker compose version >/dev/null 2>&1 || die "Docker Compose v2 is missing (docker compose ...)"
command -v curl >/dev/null || die "curl is missing"
command -v tar >/dev/null || die "tar is missing"
docker info >/dev/null 2>&1 || die "cannot talk to Docker; run as root or add your user to the docker group"

# --- which version ---
if [ -z "${TRACKER_VERSION:-}" ]; then
  TRACKER_VERSION=$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" \
    | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' | head -n 1)
fi
[ -n "$TRACKER_VERSION" ] || die "could not find the latest release on GitHub"

UPDATE=0
if [ -f "$DIR/.env" ]; then
  UPDATE=1
  say "Updating $DIR to $TRACKER_VERSION"
else
  if [ -d "$DIR" ] && [ -n "$(ls -A "$DIR")" ]; then die "$DIR exists and is not empty"; fi
  say "Installing Archipelago Run Tracker $TRACKER_VERSION into $DIR"
fi

# --- files of the release (compose file, pages, tools); .env, data/ and your apworlds are not in it ---
mkdir -p "$DIR"
cd "$DIR"
curl -fsSL "https://github.com/$REPO/archive/refs/tags/$TRACKER_VERSION.tar.gz" | tar xz --strip-components=1

# --- .env ---
if [ "$UPDATE" = 0 ]; then
  ask SITE_NAME "Site name (header, page titles)" "Archipelago Run Tracker"
  ask SITE_OWNER "Who runs the site (footer, privacy page)" ""
  ask TRACKER_PORT "Local port for your reverse proxy" "8095"
  ask_password
fi

say "Downloading images ..."
export TRACKER_VERSION
# Plain docker pull: compose would need .env, which a fresh install only writes below.
docker pull -q "$IMAGE:$TRACKER_VERSION"
docker pull -q "$IMAGE-logic:$TRACKER_VERSION"

if [ "$UPDATE" = 0 ]; then
  secret=$(od -An -tx1 -N32 /dev/urandom | tr -d ' \n')
  hash=$(docker run --rm -e ADMIN_PASSWORD -v "$PWD/tools:/t:ro" "$IMAGE:$TRACKER_VERSION" node /t/make-password.mjs) \
    || die "could not create the password hash"
  umask 077
  {
    say "# Created by install.sh. Settings: see .env.example."
    say "SITE_NAME=$(envq "$SITE_NAME")"
    say "SITE_OWNER=$(envq "$SITE_OWNER")"
    say "$hash"
    say "SESSION_SECRET=$secret"
    say "DEFAULT_DESIGN=archipelago"
    say "TRACKER_PORT=$TRACKER_PORT"
  } >.env
  umask 022
fi
set_env TRACKER_VERSION "$TRACKER_VERSION"

# The tracker runs as user "node" (UID 1000) and needs to write its database.
mkdir -p data
docker run --rm --user 0 -v "$PWD/data:/d" "$IMAGE:$TRACKER_VERSION" chown 1000:1000 /d

docker compose up -d

port=$(sed -n "s/^TRACKER_PORT=//p" .env | tail -n 1)
say ""
say "Done: Archipelago Run Tracker $TRACKER_VERSION runs on 127.0.0.1:${port:-8095}."
if [ "$UPDATE" = 0 ]; then
  say "Next: point a reverse proxy with HTTPS at it, e.g. Caddy:"
  say ""
  say "  tracker.example.com {"
  say "  	reverse_proxy 127.0.0.1:${port:-8095}"
  say "  }"
  say ""
  say "then log in at https://tracker.example.com/login and add a run in /settings."
fi
say "Update later: run the same command again from the folder that contains $DIR."
