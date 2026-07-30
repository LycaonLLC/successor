#!/usr/bin/env bash
# Snapshots the generator/toolchain notes that matter for repeatable asset work
# into content-pipeline/manifests/tool-snapshot.md.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

echo "tool-snapshot: stub. Wire asset generators, atlas packers, and renderer tooling to this script." >&2
echo "Target output: content-pipeline/manifests/tool-snapshot.md." >&2
echo "Repo root: $REPO_ROOT" >&2

exit 0
