#!/usr/bin/env bash
set -Eeuo pipefail

STATE_DIR=${SUCCESSOR_STATE_DIR:-/var/lib/successor}
RUN_DIR=${SUCCESSOR_RUN_DIR:-/run/successor}
CURRENT_GENERATION_FILE=${SUCCESSOR_CURRENT_GENERATION_FILE:-$STATE_DIR/live/state/generation}
CURRENT_COMPATIBILITY_FILE=${SUCCESSOR_CURRENT_COMPATIBILITY_FILE:-$STATE_DIR/live/state/compatibility}
TARGET_GENERATION=${SUCCESSOR_ROLLBACK_TARGET_GENERATION:-}
EXPECTED_CURRENT_GENERATION=${SUCCESSOR_ROLLBACK_EXPECTED_CURRENT_GENERATION:-}
TARGET_COMPATIBILITY=${SUCCESSOR_ROLLBACK_TARGET_COMPATIBILITY:-}
TARGET_DIGEST=${SUCCESSOR_ROLLBACK_TARGET_DIGEST:-}
IMAGE_REF=${1:-${SUCCESSOR_ROLLBACK_IMAGE_REF:-}}

fail() { echo "successor rollback: $*" >&2; exit 1; }
[[ -n "$IMAGE_REF" && "$IMAGE_REF" == *@sha256:* ]] || fail 'usage: rollback.sh IMAGE@sha256:DIGEST (digest pinned image required)'
[[ -n "$TARGET_GENERATION" && -n "$EXPECTED_CURRENT_GENERATION" && -n "$TARGET_COMPATIBILITY" && -n "$TARGET_DIGEST" ]] || fail 'target/current generation, compatibility, and digest are required'
actual_digest=${IMAGE_REF##*@sha256:}
[[ "$actual_digest" == "$TARGET_DIGEST" ]] || fail 'rollback digest does not match the sealed target digest'
[[ -s "$CURRENT_GENERATION_FILE" && -s "$CURRENT_COMPATIBILITY_FILE" ]] || fail 'state generation identity is missing; refusing rollback'
current_generation=$(<"$CURRENT_GENERATION_FILE")
current_compatibility=$(<"$CURRENT_COMPATIBILITY_FILE")
[[ "$current_generation" == "$EXPECTED_CURRENT_GENERATION" ]] || fail "rollback refused: incompatible state generation (expected $EXPECTED_CURRENT_GENERATION, got $current_generation); restore the matching backup first"
[[ "$current_compatibility" == "$TARGET_COMPATIBILITY" ]] || fail 'rollback refused: incompatible save/journal generation; use the restore path'

/usr/local/libexec/successor-preflight.sh
mkdir -p "$RUN_DIR"
exec 8>"$RUN_DIR/maintenance.lock"
flock -n 8 || fail 'maintenance lock is busy'
systemctl mask --runtime successor.service
trap 'systemctl unmask successor.service >/dev/null 2>&1 || true' EXIT
systemctl stop successor.service || true
systemctl is-active --quiet successor.service && fail 'authority remains active after stop'
exec 9>"$RUN_DIR/authority.lock"
flock -n 9 || fail 'authority lock is busy'

# Release locks before calling the existing restore/deploy scripts; each owns
# the same maintenance and authority locks for its own critical section.
exec 8>&-
exec 9>&-
systemctl unmask successor.service >/dev/null 2>&1 || true
trap - EXIT
if [[ -n "${SUCCESSOR_ROLLBACK_RESTORE_ARCHIVE:-}" ]]; then
  [[ "${SUCCESSOR_RESTORE_CONFIRM:-}" == "I_UNDERSTAND_SINGLE_WRITER" ]] || fail 'restore rollback requires SUCCESSOR_RESTORE_CONFIRM=I_UNDERSTAND_SINGLE_WRITER'
  /usr/local/libexec/successor-restore.sh "$SUCCESSOR_ROLLBACK_RESTORE_ARCHIVE"
fi
# deploy.sh performs the one-writer stop, immutable pull, and readiness start.
/usr/local/libexec/successor-deploy.sh "$IMAGE_REF"
printf 'successor rollback: target=%s digest=%s generation=%s\n' "$TARGET_GENERATION" "$actual_digest" "$current_generation"
