#!/usr/bin/env bash
# Portable entrypoint retained for hooks and automation that invoke this path.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec node "$SCRIPT_DIR/check.mjs" "$@"
