#!/usr/bin/env bash
set -Eeuo pipefail

POLICY=${SUCCESSOR_RETENTION_POLICY_FILE:-/etc/successor/backup-retention.env}
fail() { echo "successor retention: $*" >&2; exit 1; }
[[ -r "$POLICY" ]] || fail "retention policy is missing: $POLICY"
# shellcheck disable=SC1090
source "$POLICY"
[[ "${SUCCESSOR_RETENTION_ENABLED:-}" == "1" ]] || fail 'retention policy is disabled'
[[ "${SUCCESSOR_RETENTION_KEEP_RECENT:-0}" =~ ^[0-9]+$ && "${SUCCESSOR_RETENTION_KEEP_RECENT:-0}" -ge 2 ]] || fail 'keep_recent must be at least 2'
[[ "${SUCCESSOR_RETENTION_KEEP_FAILED:-0}" =~ ^[0-9]+$ && "${SUCCESSOR_RETENTION_KEEP_FAILED:-0}" -ge 1 ]] || fail 'keep_failed must be at least 1'
[[ "${SUCCESSOR_RETENTION_MAX_AGE_DAYS:-0}" =~ ^[0-9]+$ && "${SUCCESSOR_RETENTION_MAX_AGE_DAYS:-0}" -ge 7 ]] || fail 'max_age_days must be at least 7'
[[ "${SUCCESSOR_BACKUP_INTERVAL_MINUTES:-0}" =~ ^[0-9]+$ && "${SUCCESSOR_BACKUP_INTERVAL_MINUTES:-0}" -ge 1 && "${SUCCESSOR_BACKUP_INTERVAL_MINUTES:-0}" -le $((SUCCESSOR_RETENTION_MAX_AGE_DAYS * 1440)) ]] || fail 'backup interval must fit inside max age'
[[ -n "${SUCCESSOR_RETENTION_ARCHIVE_PREFIX:-}" && "${SUCCESSOR_RETENTION_ARCHIVE_PREFIX}" != /* ]] || fail 'archive prefix is required and must be relative'
printf 'successor retention: PASS keep_recent=%s keep_failed=%s max_age_days=%s interval_minutes=%s\n' "$SUCCESSOR_RETENTION_KEEP_RECENT" "$SUCCESSOR_RETENTION_KEEP_FAILED" "$SUCCESSOR_RETENTION_MAX_AGE_DAYS" "$SUCCESSOR_BACKUP_INTERVAL_MINUTES"
