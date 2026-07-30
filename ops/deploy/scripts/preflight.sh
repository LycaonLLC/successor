#!/usr/bin/env bash
set -Eeuo pipefail

STATE_DIR=${SUCCESSOR_STATE_DIR:-/var/lib/successor}
STATE_ROOT=${SUCCESSOR_STATE_ROOT:-$STATE_DIR/live}
LOCK_DIR=${SUCCESSOR_RUN_DIR:-/run/successor}
DEVICE=${SUCCESSOR_STATE_DEVICE:-}
CONTROL_DB=${ALPHA_CONTROL_DB_PATH:-$STATE_ROOT/control.sqlite}
MANIFEST=${GAME_SHARD_MANIFEST_PATH:-$STATE_ROOT/state/open-desert-shard-1.manifest.json}

fail() { printf 'successor preflight: %s\n' "$*" >&2; exit 1; }
[[ -d "$STATE_DIR" ]] || fail "state directory missing: $STATE_DIR"
mountpoint -q "$STATE_DIR" || fail "state directory is not a mountpoint: $STATE_DIR"
[[ -d "$STATE_ROOT" ]] || fail "state root missing: $STATE_ROOT"
[[ -d "$LOCK_DIR" ]] || fail "run directory missing: $LOCK_DIR"
if [[ -n "$DEVICE" ]]; then
  findmnt -rn -S "$DEVICE" -T "$STATE_DIR" >/dev/null || fail "state device is not mounted at $STATE_DIR"
fi
[[ -w "$STATE_ROOT" ]] || fail "state root is not writable"
[[ -x /usr/bin/docker ]] || fail "docker is not installed"
command -v flock >/dev/null || fail "flock is required"
[[ -s "$CONTROL_DB" ]] || fail "standalone control DB is missing or unbound: $CONTROL_DB"
grep -aFq 'schema_migrations' "$CONTROL_DB" || fail "standalone control DB is not bound: $CONTROL_DB"
[[ -s "$MANIFEST" ]] || fail "standalone state manifest is missing or unbound: $MANIFEST"
grep -Fq 'controlSchemaHead' "$MANIFEST" || fail "standalone state manifest is not bound to control schema: $MANIFEST"
if [[ -e "$STATE_DIR/.successor-writer" ]]; then
  existing=$(<"$STATE_DIR/.successor-writer")
  kill -0 "$existing" 2>/dev/null || rm -f "$STATE_DIR/.successor-writer"
fi
printf 'successor preflight: state=%s root=%s device=%s lock=%s control=%s manifest=%s\n' "$STATE_DIR" "$STATE_ROOT" "${DEVICE:-unset}" "$LOCK_DIR/authority.lock" "$CONTROL_DB" "$MANIFEST"
