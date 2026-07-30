#!/usr/bin/env bash
set -Eeuo pipefail

fail() { echo "successor deploy: $*" >&2; exit 1; }

IMAGE_REF=${1:-${SUCCESSOR_IMAGE_REF:-}}
[[ -n "$IMAGE_REF" ]] || { echo 'usage: deploy.sh IMAGE@sha256:DIGEST' >&2; exit 2; }
[[ "$IMAGE_REF" == *@sha256:* ]] || { echo 'successor deploy: digest-pinned images are required' >&2; exit 2; }
export SUCCESSOR_IMAGE_REF="$IMAGE_REF"
/usr/local/libexec/successor-preflight.sh
mkdir -p "${SUCCESSOR_RUN_DIR:-/run/successor}"
exec 8>"${SUCCESSOR_RUN_DIR:-/run/successor}/maintenance.lock"
flock -n 8 || fail 'maintenance lock is busy'
# Runtime masking closes the start/restart race while the shared authority lock is held.
systemctl mask --runtime successor.service
trap 'systemctl unmask successor.service' EXIT
systemctl stop successor.service || true
exec 9>"${SUCCESSOR_RUN_DIR:-/run/successor}/authority.lock"
flock -n 9 || fail 'authority lock is busy'
/usr/bin/docker pull "$IMAGE_REF"
arch=$(/usr/bin/docker image inspect --format '{{.Architecture}}' "$IMAGE_REF")
[[ "$arch" == amd64 ]] || fail "expected amd64 image, got $arch"
install -d -m 0750 /etc/successor
# Keep the bootstrap-provisioned runtime contract (state paths, backup URI,
# region, and shard identity) while replacing only the immutable image.
runtime_env_tmp=$(mktemp /etc/successor/runtime.env.XXXXXX)
if [[ -f /etc/successor/runtime.env ]]; then
  sed '/^SUCCESSOR_IMAGE_REF=/d' /etc/successor/runtime.env >"$runtime_env_tmp"
fi
printf 'SUCCESSOR_IMAGE_REF=%s\n' "$IMAGE_REF" >>"$runtime_env_tmp"
chmod 0600 "$runtime_env_tmp"
mv -f "$runtime_env_tmp" /etc/successor/runtime.env
systemctl unmask successor.service
trap - EXIT
systemctl start successor.service
systemctl is-active --quiet successor.service
