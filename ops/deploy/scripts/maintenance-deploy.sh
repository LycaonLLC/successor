#!/usr/bin/env bash
set -Eeuo pipefail

IMAGE_REF=${1:-${SUCCESSOR_IMAGE_REF:-}}
[[ -n "$IMAGE_REF" && "$IMAGE_REF" == *@sha256:* ]] || { echo 'successor maintenance deploy: digest-pinned IMAGE@sha256:DIGEST required' >&2; exit 2; }
[[ -n "${SUCCESSOR_MAINTENANCE_ACK:-}" ]] || { echo 'successor maintenance deploy: set SUCCESSOR_MAINTENANCE_ACK=I_UNDERSTAND_MAINTENANCE' >&2; exit 2; }
[[ -n "${SUCCESSOR_RELEASE_SEAL_SHA256:-}" ]] || { echo 'successor maintenance deploy: release seal identity is required' >&2; exit 2; }
[[ "${SUCCESSOR_IMAGE_DIGEST:-${IMAGE_REF##*@sha256:}}" == "${IMAGE_REF##*@sha256:}" ]] || { echo 'successor maintenance deploy: image digest is not bound to release seal' >&2; exit 1; }

# Admissions and ticket minting are paused by the existing maintenance window
# outside this host script. The deploy script then performs one locked stop,
# immutable pull, and start; no parallel authority is started here.
printf 'successor maintenance deploy: sequential candidate=%s seal=%s\n' "$IMAGE_REF" "$SUCCESSOR_RELEASE_SEAL_SHA256"
exec /usr/local/libexec/successor-deploy.sh "$IMAGE_REF"
