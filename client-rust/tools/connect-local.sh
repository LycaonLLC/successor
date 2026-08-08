#!/usr/bin/env bash
# connect-local.sh — start the dev-capable Rust client against the local
# testing authority (scripts/server-local-persistent.mjs, loopback only).
#
# Brings the server up if it is not answering, creates a durable roster
# character on first run (the shard rejects bare dev identities for ids the
# character store already owns), then execs client-rust/out/bin/successor-dev
# with the documented dev-identity join.
#
# Usage:
#   client-rust/tools/connect-local.sh [options] [-- <client args>]
#
# Options:
#   --name NAME          Roster character name (letters/hyphens, 3-16).
#                        Created on first use. Default: local-dev
#   --profession ID      Initial profession for a new character:
#                        marksman|scout|craftsman|medic|brawler. Default: marksman
#   --port PORT          Authority port. Default: 28093
#   --control-port N     Client control listener; 0 = ephemeral (printed at
#                        startup). Default: 0
#   --build              Force `make -C client-rust dev` before launch.
#   --no-server          Fail instead of starting the authority when down.
#   -h, --help           This text.
#
# Anything after `--` is passed to the client verbatim (e.g. --spawn-area,
# --auto-walk, --quality high).

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)" # client-rust/
REPO="$(cd "$ROOT/.." && pwd)"
BIN="$ROOT/out/bin/successor-dev"

HOST=127.0.0.1
PORT=28093
NAME="local-dev"
PROFESSION="marksman"
CONTROL_PORT=0
BUILD=0
START_SERVER=1
EXTRA=()

usage() { sed -n '2,26p' "${BASH_SOURCE[0]}"; }

while [ $# -gt 0 ]; do
    case "$1" in
        --name) NAME="${2:?--name needs a value}"; shift 2 ;;
        --profession) PROFESSION="${2:?--profession needs a value}"; shift 2 ;;
        --port) PORT="${2:?--port needs a value}"; shift 2 ;;
        --control-port) CONTROL_PORT="${2:?--control-port needs a value}"; shift 2 ;;
        --build) BUILD=1; shift ;;
        --no-server) START_SERVER=0; shift ;;
        -h|--help) usage; exit 0 ;;
        --) shift; EXTRA+=("$@"); break ;;
        *) echo "connect-local: unknown option '$1' (use -- for client args)" >&2; exit 2 ;;
    esac
done

case "$NAME" in
    *[!A-Za-z-]*|''|?|??|?????????????????*|*--*|*-|-*)
        echo "connect-local: --name must be 3-16 letters with single hyphens" >&2; exit 2 ;;
esac
case "$PROFESSION" in
    marksman|scout|craftsman|medic|brawler) ;;
    *) echo "connect-local: --profession must be marksman|scout|craftsman|medic|brawler" >&2; exit 2 ;;
esac

BASE="http://$HOST:$PORT"
ENDPOINT="ws://$HOST:$PORT"

# --- 1. authority ------------------------------------------------------------

if curl -fsS --max-time 2 "$BASE/game/status" >/dev/null 2>&1; then
    echo "connect-local: authority already up at $ENDPOINT"
else
    if [ "$START_SERVER" -eq 0 ]; then
        echo "connect-local: no authority at $ENDPOINT and --no-server given" >&2; exit 1
    fi
    echo "connect-local: starting local authority on port $PORT"
    (cd "$REPO" && GAME_AUTHORITY_SERVER_PORT="$PORT" pnpm server:local:persistent)
    for _ in $(seq 1 120); do
        if curl -fsS --max-time 2 "$BASE/healthz" >/dev/null 2>&1; then break; fi
        sleep 1
    done
    curl -fsS --max-time 2 "$BASE/healthz" >/dev/null \
        || { echo "connect-local: authority did not become healthy" >&2; exit 1; }
fi

# --- 2. dev client binary ----------------------------------------------------

if [ "$BUILD" -eq 1 ] || [ ! -x "$BIN" ]; then
    echo "connect-local: building successor-dev"
    make -C "$ROOT" dev
fi

# --- 3. durable roster character ---------------------------------------------

CHARACTERS=$(curl -fsS --max-time 5 "$BASE/game/characters")
CHARACTER_ID=$(printf '%s' "$CHARACTERS" | python3 -c '
import json, sys
name = sys.argv[1]
for record in json.load(sys.stdin).get("characters", []):
    if record.get("name") == name:
        print(record.get("id", ""))
        break
' "$NAME")

if [ -z "$CHARACTER_ID" ]; then
    echo "connect-local: creating character '$NAME' ($PROFESSION)"
    CREATED=$(curl -fsS --max-time 5 -X POST "$BASE/game/characters" \
        -H 'content-type: application/json' \
        -d "{\"name\":\"$NAME\",\"appearance\":{\"body\":\"male\",\"skinTone\":\"#c78f62\",\"hair\":\"hair_mop\",\"hairMat\":\"hair_raven\",\"face\":null},\"initialProfessionId\":\"$PROFESSION\"}") \
        || { echo "connect-local: character create failed (name taken? run with another --name)" >&2; exit 1; }
    CHARACTER_ID=$(printf '%s' "$CREATED" | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')
fi

# --- 4. launch ----------------------------------------------------------------

echo "connect-local: character '$NAME' = $CHARACTER_ID"
echo "connect-local: launching successor-dev against $ENDPOINT (control-port $CONTROL_PORT)"
cd "$ROOT"
exec out/bin/successor-dev \
    --dev-identity \
    --endpoint "$ENDPOINT" \
    --player-id "$CHARACTER_ID" --actor-id "$CHARACTER_ID" \
    --character-id "$CHARACTER_ID" \
    --control-port "$CONTROL_PORT" \
    ${EXTRA[@]+"${EXTRA[@]}"}
