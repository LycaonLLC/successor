#!/usr/bin/env bash
set -Eeuo pipefail

OUT=${1:-${SUCCESSOR_REVIEW_OUT:-}}
RELEASE_SEAL=${SUCCESSOR_RELEASE_SEAL_SHA256:-}
IMAGE_DIGEST=${SUCCESSOR_IMAGE_DIGEST:-}
CLIENT_MANIFEST=${SUCCESSOR_CLIENT_MANIFEST_SHA256:-}
SESSION_ID=${SUCCESSOR_SESSION_ID:-}
STARTED_AT=${SUCCESSOR_SESSION_STARTED_AT:-}
ENDED_AT=${SUCCESSOR_SESSION_ENDED_AT:-}
REVIEWED_AT=${SUCCESSOR_REVIEWED_AT:-}
OUTCOME=${SUCCESSOR_SESSION_OUTCOME:-unreviewed}
METRICS=${SUCCESSOR_REVIEW_METRICS_FILES:-}
LOGS=${SUCCESSOR_REVIEW_LOG_FILES:-}
JOURNAL=${SUCCESSOR_REVIEW_JOURNAL_FILES:-}

fail() { echo "successor post-session review: $*" >&2; exit 1; }
[[ -n "$OUT" && -n "$RELEASE_SEAL" && -n "$IMAGE_DIGEST" && -n "$CLIENT_MANIFEST" && -n "$SESSION_ID" && -n "$STARTED_AT" && -n "$ENDED_AT" && -n "$REVIEWED_AT" ]] || fail 'output, release/client identity, session bounds, and reviewed-at are required'
[[ "$RELEASE_SEAL" =~ ^[a-f0-9]{64}$ && "$IMAGE_DIGEST" =~ ^[a-f0-9]{64}$ && "$CLIENT_MANIFEST" =~ ^[a-f0-9]{64}$ ]] || fail 'release identities must be sha256 values'
[[ -n "$METRICS$LOGS$JOURNAL" ]] || fail 'at least one metrics, log, or journal evidence file is required'

json_escape() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'; }
evidence_json() {
  local list=${1:-} first=1 file digest bytes
  printf '['
  IFS=':' read -r -a files <<< "$list"
  for file in "${files[@]}"; do
    [[ -n "$file" ]] || continue
    [[ -f "$file" ]] || fail "evidence file missing: $file"
    digest=$(sha256sum "$file" | cut -d' ' -f1)
    bytes=$(stat -c '%s' "$file")
    [[ "$first" == 1 ]] || printf ','
    first=0
    printf '{"path":"%s","sha256":"%s","bytes":%s}' "$(json_escape "$file")" "$digest" "$bytes"
  done
  printf ']'
}

mkdir -p "$(dirname "$OUT")"
tmp="${OUT}.tmp"
cat >"$tmp" <<EOF
{
  "schema": "successor.post-session-review.v1",
  "release": {"sealSha256":"$RELEASE_SEAL","imageDigest":"$IMAGE_DIGEST","clientManifestSha256":"$CLIENT_MANIFEST"},
  "session": {"id":"$(json_escape "$SESSION_ID")","startedAt":"$(json_escape "$STARTED_AT")","endedAt":"$(json_escape "$ENDED_AT")","outcome":"$(json_escape "$OUTCOME")"},
  "evidence": {
    "metrics": $(evidence_json "$METRICS"),
    "logs": $(evidence_json "$LOGS"),
    "journal": $(evidence_json "$JOURNAL")
  },
  "reviewedAt":"$(json_escape "$REVIEWED_AT")"
}
EOF
mv -f "$tmp" "$OUT"
printf 'successor post-session review: wrote %s bound to session=%s release=%s\n' "$OUT" "$SESSION_ID" "$RELEASE_SEAL"
