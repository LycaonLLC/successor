#!/usr/bin/env bash
set -Eeuo pipefail

ARCHIVE=${1:-${SUCCESSOR_REHEARSAL_ARCHIVE:-}}
STATE_DIR=${SUCCESSOR_STATE_DIR:-/var/lib/successor}
TARGET=${2:-${SUCCESSOR_REHEARSAL_TARGET:-/var/lib/successor-restore-rehearsals/$(date -u +%Y%m%dT%H%M%SZ)}}
RUN_DIR=${SUCCESSOR_RUN_DIR:-/run/successor}

fail() { echo "successor restore rehearsal: $*" >&2; exit 1; }
[[ -n "$ARCHIVE" ]] || fail 'usage: restore-rehearsal.sh BACKUP.tar.gz [ISOLATED_TARGET]'
[[ -f "$ARCHIVE" ]] || fail "archive not found: $ARCHIVE"
[[ "${SUCCESSOR_REHEARSAL_WRITER_ACCESS:-0}" == "0" ]] || fail 'restore rehearsal refuses live writer access'
source_abs=$(readlink -f "$STATE_DIR")
target_abs=$(readlink -m "$TARGET")
[[ "$source_abs" != "$target_abs" && "$target_abs" != "$source_abs"/* && "$source_abs" != "$target_abs"/* ]] || fail 'isolated target overlaps live state'
mkdir -p "$RUN_DIR"
exec 8>"$RUN_DIR/restore-rehearsal.lock"
flock -n 8 || fail 'another restore rehearsal owns the lock'
while IFS= read -r name; do
  [[ "$name" != /* && "$name" != ../* && "$name" != */../* ]] || fail "unsafe archive member: $name"
done < <(tar -tzf "$ARCHIVE")
[[ ! -e "$target_abs" ]] || fail "isolated target already exists: $target_abs"
mkdir -p "$target_abs"
tar -xzf "$ARCHIVE" -C "$target_abs"
[[ -s "$target_abs/characters.json" && -d "$target_abs/state" ]] || fail 'archive has no complete successor state payload'
[[ ! -e "$target_abs/.successor-writer" ]] || fail 'rehearsal target contains a live-writer marker'
# Do not call systemctl, docker, restore.sh, or any live endpoint here. The
# extracted tree is the isolated restore input for an operator-owned smoke.
manifest="$target_abs/restore-rehearsal.json"
printf '{\n  "schema": "successor.restore-rehearsal.v1",\n  "archive": "%s",\n  "isolatedTarget": "%s",\n  "writerAccess": false,\n  "serviceStarted": false,\n  "statePayload": "present"\n}\n' "$ARCHIVE" "$target_abs" >"$manifest"
chmod 0600 "$manifest"
printf 'successor restore rehearsal: PASS isolated_target=%s archive=%s\n' "$target_abs" "$ARCHIVE"
