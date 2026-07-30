#!/usr/bin/env bash
set -Eeuo pipefail

STATE_DIR=${SUCCESSOR_STATE_DIR:-/var/lib/successor}
STATE_ROOT=${SUCCESSOR_STATE_ROOT:-$STATE_DIR/live}
RUN_DIR=${SUCCESSOR_RUN_DIR:-/run/successor}
BACKUP_DIR=${SUCCESSOR_BACKUP_DIR:-/var/backups/successor}
BACKUP_S3_URI=${SUCCESSOR_BACKUP_S3_URI:?SUCCESSOR_BACKUP_S3_URI must point at the private backup bucket}
CHECKPOINT_PATH=${SUCCESSOR_CHECKPOINT_PATH:-$STATE_ROOT/state/open-desert-shard-1.checkpoint.json}
BACKUP_NAME=${1:-"successor-$(date -u +%Y%m%dT%H%M%SZ).tar.gz"}
RETENTION_POLICY=${SUCCESSOR_RETENTION_POLICY_FILE:-/etc/successor/backup-retention.env}

fail() { echo "successor backup: $*" >&2; exit 1; }
[[ -r "$RETENTION_POLICY" ]] || fail "retention policy is missing: $RETENTION_POLICY"
# shellcheck disable=SC1090
source "$RETENTION_POLICY"
/usr/local/libexec/successor-validate-retention.sh
RETENTION_MAX_AGE_DAYS=${SUCCESSOR_RETENTION_MAX_AGE_DAYS:?retention validator did not load max age}
/usr/local/libexec/successor-preflight.sh
mkdir -p "$RUN_DIR"
exec 8>"$RUN_DIR/maintenance.lock"
flock -n 8 || fail 'maintenance lock is busy'
was_active=0
systemctl is-active --quiet successor.service && was_active=1 || true
was_masked=0
[[ "$(systemctl is-enabled successor.service 2>/dev/null || true)" == "masked" ]] && was_masked=1
systemctl mask --runtime successor.service
stopped=0
restore_service() {
  local status=$?
  if [[ "$stopped" == 1 ]]; then
    if [[ "$was_masked" == 0 ]]; then systemctl unmask successor.service >/dev/null 2>&1 || true; fi
    if [[ "$was_active" == 1 && "$was_masked" == 0 ]]; then systemctl start successor.service >/dev/null 2>&1 || status=1; fi
  elif [[ "$was_masked" == 0 ]]; then
    systemctl unmask successor.service >/dev/null 2>&1 || true
  fi
  return "$status"
}
trap restore_service EXIT
systemctl stop successor.service || true
stopped=1
systemctl is-active --quiet successor.service && fail 'authority is still active after stop'
exec 9>"$RUN_DIR/authority.lock"
flock -n 9 || fail 'another authority or maintenance operation owns authority.lock'
mountpoint -q "$STATE_DIR" || fail 'state mount disappeared'
[[ -d "$STATE_ROOT" ]] || fail 'live state tree missing'
[[ -s "$CHECKPOINT_PATH" ]] || fail "graceful checkpoint barrier missing: $CHECKPOINT_PATH"
install -d -m 0700 "$BACKUP_DIR"
tmp="$BACKUP_DIR/.${BACKUP_NAME}.tmp"
rm -f "$tmp"
tar --sort=name --mtime='UTC 1970-01-01' --numeric-owner -czf "$tmp" -C "$STATE_ROOT" .
chmod 0600 "$tmp"
mv -f "$tmp" "$BACKUP_DIR/$BACKUP_NAME"
find "$BACKUP_DIR" -maxdepth 1 -type f -name "successor-*.tar.gz" -mtime +"$RETENTION_MAX_AGE_DAYS" -delete
aws s3 cp "$BACKUP_DIR/$BACKUP_NAME" "$BACKUP_S3_URI/$BACKUP_NAME" --sse AES256 --only-show-errors
aws cloudwatch put-metric-data --region "${AWS_REGION:?AWS_REGION is required}" --namespace "Successor/${SUCCESSOR_SHARD_NAME:-successor-staging-1}" --metric-data "MetricName=BackupSuccess,Dimensions=[{Name=Shard,Value=${SUCCESSOR_SHARD_NAME:-successor-staging-1}}],Value=1,Unit=Count" --no-cli-pager || printf "successor telemetry warning: BackupSuccess metric failed\n" >&2
printf '%s\n' "$BACKUP_S3_URI/$BACKUP_NAME"
