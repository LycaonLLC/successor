#!/usr/bin/env bash
set -Eeuo pipefail

STATE_DIR=${SUCCESSOR_STATE_DIR:-/var/lib/successor}
RUN_DIR=${SUCCESSOR_RUN_DIR:-/run/successor}
MAX_FAILED=${SUCCESSOR_MAX_FAILED_GENERATIONS:-3}
MAX_AGE_DAYS=${SUCCESSOR_GENERATION_RETENTION_DAYS:-30}

fail() { echo "successor generation cleanup: $*" >&2; exit 1; }
/usr/local/libexec/successor-preflight.sh
mkdir -p "$RUN_DIR"
exec 8>"$RUN_DIR/maintenance.lock"
flock -n 8 || fail 'maintenance lock is busy'
was_active=0
systemctl is-active --quiet successor.service && was_active=1 || true
was_masked=0
[[ "$(systemctl is-enabled successor.service 2>/dev/null || true)" == "masked" ]] && was_masked=1
systemctl mask --runtime successor.service
restart=0
[[ "${SUCCESSOR_CLEANUP_RESTART:-}" == "1" && "$was_active" == 1 && "$was_masked" == 0 ]] && restart=1
trap 'if [[ "$restart" == 1 ]]; then systemctl unmask successor.service; systemctl start successor.service || true; elif [[ "$was_masked" == 0 ]]; then systemctl unmask successor.service; fi' EXIT
systemctl stop successor.service || true
systemctl is-active --quiet successor.service && fail 'authority remains active during cleanup'
exec 9>"$RUN_DIR/authority.lock"
flock -n 9 || fail 'authority lock is busy'
# Keep the newest known-good previous generation and recent failed attempts.
mapfile -t previous < <(find "$STATE_DIR" -maxdepth 1 -mindepth 1 -type d -name '.previous-*' -printf '%T@ %p\n' | sort -nr | awk 'NR > 1 { $1=""; sub(/^ /, ""); print }')
for path in "${previous[@]}"; do
  [[ -n "$path" ]] && find "$path" -prune -type d -mtime +"$MAX_AGE_DAYS" -exec rm -rf -- {} +
done
mapfile -t failed < <(find "$STATE_DIR" -maxdepth 1 -mindepth 1 -type d -name '.failed-*' -printf '%T@ %p\n' | sort -nr | awk -v keep="$MAX_FAILED" 'NR > keep { $1=""; sub(/^ /, ""); print }')
for path in "${failed[@]}"; do
  [[ -n "$path" ]] && rm -rf -- "$path"
done
printf 'successor generation cleanup: retained latest previous and %s failed generations\n' "$MAX_FAILED"
