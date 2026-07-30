#!/usr/bin/env bash
set -Eeuo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
for script in "$ROOT"/ops/deploy/scripts/*.sh; do
  bash -n "$script"
done
bash -n "$ROOT/ops/deploy/user-data.sh.tftpl"
node "$ROOT/ops/deploy/contract-check.mjs"

TF_IMAGE='hashicorp/terraform:1.10.5@sha256:679ac5e095bf550bc726742cd12efa6050f0913080df479fdabfeb202953af28'
command -v docker >/dev/null || { echo 'validate: docker is required for pinned Terraform validation' >&2; exit 1; }
tf_validate() {
  local directory=$1
  docker run --rm --entrypoint sh -v "$ROOT:/workspace" -w "/workspace/$directory" "$TF_IMAGE" -ec \
    'export TF_DATA_DIR=$(mktemp -d); terraform init -backend=false -input=false; terraform validate'
}
tf() {
  local directory=$1
  shift
  docker run --rm -v "$ROOT:/workspace" -w "/workspace/$directory" "$TF_IMAGE" "$@"
}
tf_validate ops/deploy/terraform/bootstrap
tf_validate ops/deploy/terraform/envs/staging
tf . fmt -check -recursive ops/deploy/terraform
