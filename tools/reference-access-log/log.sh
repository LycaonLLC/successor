#!/usr/bin/env bash
# Append an entry to the reference-access log.
# Usage: tools/reference-access-log/log.sh "<subsystem>: <what was inspected>"

set -euo pipefail

SUBJECT="${1:-}"
if [[ -z "$SUBJECT" ]]; then
    echo "usage: $0 \"<subsystem>: <what>\"" >&2
    exit 2
fi

LOG="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/access.log"
WHO="${USER:-unknown}"
WHEN="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

printf '%s\t%s\t%s\n' "$WHEN" "$WHO" "$SUBJECT" >> "$LOG"
echo "logged: $WHEN  $WHO  $SUBJECT"
