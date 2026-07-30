#!/usr/bin/env bash
set -Eeuo pipefail

STATE_DIR=${SUCCESSOR_STATE_DIR:-/var/lib/successor}
STATE_ROOT=${SUCCESSOR_STATE_ROOT:-$STATE_DIR/live}
RUN_DIR=${SUCCESSOR_RUN_DIR:-/run/successor}
IMAGE_REF=${SUCCESSOR_IMAGE_REF:?SUCCESSOR_IMAGE_REF must be an immutable image@sha256:digest}
AWS_REGION=${AWS_REGION:?AWS_REGION is required}
[[ "$IMAGE_REF" == *@sha256:* ]] || { echo 'successor: image must be digest pinned' >&2; exit 1; }
/usr/local/libexec/successor-preflight.sh
registry=${IMAGE_REF%%/*}
[[ "$registry" == *.* ]] || { echo "successor: image registry is invalid: $registry" >&2; exit 1; }
mkdir -p "$RUN_DIR"
exec 9>"$RUN_DIR/authority.lock"
flock -n 9 || { echo 'successor: another writer owns authority.lock' >&2; exit 1; }
DOCKER_CONFIG="$RUN_DIR/docker-config"
mkdir -p "$DOCKER_CONFIG"
chmod 700 "$DOCKER_CONFIG"
export DOCKER_CONFIG
printf '%s\n' "$$" >"$STATE_DIR/.successor-writer"
cleanup() { /usr/bin/docker logout "$registry" >/dev/null 2>&1 || true; rm -rf "$DOCKER_CONFIG"; rm -f "$STATE_DIR/.successor-writer"; }
trap cleanup EXIT
aws ecr get-login-password --region "$AWS_REGION" | /usr/bin/docker login --username AWS --password-stdin "$registry" >/dev/null
/usr/bin/docker pull "$IMAGE_REF"
exec /usr/bin/docker run --pull=never --rm --name successor-authority \
  --platform linux/amd64 \
  --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,nodev,size=256m \
  --mount "type=bind,src=$STATE_ROOT,dst=/var/lib/successor/live" \
  --env-file /etc/successor/runtime.env \
  --log-driver awslogs \
  --log-opt "awslogs-group=${SUCCESSOR_LOG_GROUP:?SUCCESSOR_LOG_GROUP is required}" \
  --log-opt "awslogs-region=$AWS_REGION" \
  --log-opt "awslogs-stream=${SUCCESSOR_SHARD_NAME:-successor-staging-1}" \
  --stop-timeout 120 \
  --publish 28093:28093 \
  "$IMAGE_REF"
