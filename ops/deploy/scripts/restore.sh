#!/usr/bin/env bash
set -Eeuo pipefail

STATE_DIR=${SUCCESSOR_STATE_DIR:-/var/lib/successor}
RUN_DIR=${SUCCESSOR_RUN_DIR:-/run/successor}
BACKUP_DIR=${SUCCESSOR_BACKUP_DIR:-/var/backups/successor}
BACKUP_S3_URI=${SUCCESSOR_BACKUP_S3_URI:-}
ARCHIVE=${1:?usage: restore.sh ARCHIVE.tar.gz}
STARTED_AT=$(date +%s)

fail() { echo "successor restore: $*" >&2; exit 1; }
/usr/local/libexec/successor-preflight.sh
mkdir -p "${SUCCESSOR_RUN_DIR:-/run/successor}"
exec 8>"${SUCCESSOR_RUN_DIR:-/run/successor}/maintenance.lock"
flock -n 8 || fail 'maintenance lock is busy'
[[ "${SUCCESSOR_RESTORE_CONFIRM:-}" == "I_UNDERSTAND_SINGLE_WRITER" ]] || fail 'set SUCCESSOR_RESTORE_CONFIRM=I_UNDERSTAND_SINGLE_WRITER'
if [[ "$ARCHIVE" != */* ]]; then ARCHIVE="$BACKUP_DIR/$ARCHIVE"; fi
if [[ ! -f "$ARCHIVE" && -n "$BACKUP_S3_URI" ]]; then
  mkdir -p "$BACKUP_DIR"
  aws s3 cp "$BACKUP_S3_URI/$(basename "$ARCHIVE")" "$ARCHIVE" --only-show-errors
fi
[[ -f "$ARCHIVE" ]] || fail "archive not found: $ARCHIVE"
systemctl mask --runtime successor.service
trap 'systemctl unmask successor.service' EXIT
if systemctl is-active --quiet successor.service; then systemctl stop successor.service; fi
systemctl is-active --quiet successor.service && fail 'authority is still active after stop'
mkdir -p "$RUN_DIR"
exec 9>"$RUN_DIR/authority.lock"
flock -n 9 || fail 'another authority or maintenance operation owns authority.lock'
mountpoint -q "$STATE_DIR" || fail 'state mount disappeared'
while IFS= read -r name; do
  [[ "$name" != /* && "$name" != ../* && "$name" != */../* ]] || fail "unsafe archive member: $name"
done < <(tar -tzf "$ARCHIVE")
expanded_kb=$(tar -tzvf "$ARCHIVE" | awk '{sum += $3} END {print int(sum/1024)+1}')
available_kb=$(df --output=avail -k "$STATE_DIR" | tail -n 1 | tr -d ' ')
(( available_kb > expanded_kb * 2 + 10240 )) || fail "insufficient EBS free space for staged restore: need ${expanded_kb}KiB plus margin, have ${available_kb}KiB"
tmp=$(mktemp -d "$STATE_DIR/.restore.XXXXXX")
old="$STATE_DIR/.previous-$(date -u +%Y%m%dT%H%M%SZ)"
trap 'rm -rf "$tmp"; systemctl unmask successor.service' EXIT
tar -xzf "$ARCHIVE" -C "$tmp"
[[ -f "$tmp/characters.json" && -d "$tmp/state" ]] || fail 'archive has no complete successor state payload'
chown -R 10001:10001 "$tmp"
# Same-filesystem renames are the generation pointer swap. Keep old until the
# replacement serves readiness and has a non-empty checkpoint.
mv "$STATE_DIR/live" "$old"
mv "$tmp" "$STATE_DIR/live"
exec 9>&-
rollback_generation() {
  systemctl stop successor.service >/dev/null 2>&1 || true
  exec 9>"$RUN_DIR/authority.lock"
  flock -n 9 || return 1
  failed="$STATE_DIR/.failed-$(date -u +%Y%m%dT%H%M%SZ)"
  mv "$STATE_DIR/live" "$failed" || return 1
  mv "$old" "$STATE_DIR/live" || return 1
  systemctl unmask successor.service >/dev/null 2>&1 || true
  systemctl start successor.service >/dev/null 2>&1 || true
  return 0
}
if ! systemctl unmask successor.service; then
  if ! rollback_generation; then
    systemctl stop successor.service >/dev/null 2>&1 || true
    aws cloudwatch put-metric-data --region "${AWS_REGION:?AWS_REGION is required}" --namespace "Successor/${SUCCESSOR_SHARD_NAME:-successor-staging-1}" --metric-data "MetricName=RestoreFailure,Dimensions=[{Name=Shard,Value=${SUCCESSOR_SHARD_NAME:-successor-staging-1}}],Value=1,Unit=Count" --no-cli-pager || true
    fail "rollback_failed: could not restore prior generation after unmask failure"
  fi
  fail 'could not unmask service after generation swap; rolled back pointer'
fi
if ! systemctl start successor.service; then
  if ! rollback_generation; then
    systemctl stop successor.service >/dev/null 2>&1 || true
    aws cloudwatch put-metric-data --region "${AWS_REGION:?AWS_REGION is required}" --namespace "Successor/${SUCCESSOR_SHARD_NAME:-successor-staging-1}" --metric-data "MetricName=RestoreFailure,Dimensions=[{Name=Shard,Value=${SUCCESSOR_SHARD_NAME:-successor-staging-1}}],Value=1,Unit=Count" --no-cli-pager || true
    fail "rollback_failed: could not restore prior generation after start failure"
  fi
  fail 'replacement service failed to start; rolled back pointer' 
fi
ready=0
for _ in $(seq 1 60); do
  if curl -fsS --max-time 2 http://127.0.0.1:28093/readyz >/dev/null 2>&1 && [[ -s "$STATE_DIR/live/state/open-desert-shard-1.checkpoint.json" ]]; then
    ready=1
    break
  fi
  sleep 2
done
if [[ "$ready" != 1 ]]; then
  if ! rollback_generation; then
    systemctl stop successor.service >/dev/null 2>&1 || true
    aws cloudwatch put-metric-data --region "${AWS_REGION:?AWS_REGION is required}" --namespace "Successor/${SUCCESSOR_SHARD_NAME:-successor-staging-1}" --metric-data "MetricName=RestoreFailure,Dimensions=[{Name=Shard,Value=${SUCCESSOR_SHARD_NAME:-successor-staging-1}}],Value=1,Unit=Count" --no-cli-pager || true
    fail "rollback_failed: could not restore prior generation after readiness failure"
  fi
  fail 'restored generation failed readiness/checkpoint smoke; rolled back pointer' 
fi
DURATION_MINUTES=$(( ( $(date +%s) - STARTED_AT + 59 ) / 60 ))
aws cloudwatch put-metric-data --region "${AWS_REGION:?AWS_REGION is required}" --namespace "Successor/${SUCCESSOR_SHARD_NAME:-successor-staging-1}" --metric-data "MetricName=RestoreDurationMinutes,Dimensions=[{Name=Shard,Value=${SUCCESSOR_SHARD_NAME:-successor-staging-1}}],Value=$DURATION_MINUTES,Unit=Count" --no-cli-pager || printf 'successor telemetry warning: RestoreDuration metric failed\n' >&2
trap - EXIT
printf 'successor restore: generation passed ready/checkpoint smoke; old tree retained at %s\n' "$old"
