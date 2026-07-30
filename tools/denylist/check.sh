#!/usr/bin/env bash
# Denylist CI gate. Fails on any tracked file (or supplied prompt string) that
# contains a forbidden term, case-insensitive substring match.
#
# Usage:
#   tools/denylist/check.sh                      # scan tracked files in repo
#   tools/denylist/check.sh --prompt "..."       # check a single prompt string
#   tools/denylist/check.sh --files <paths>      # scan an explicit list of files
#
# Exit code 0: clean. Exit code 1: denylist hit. Exit code 2: misuse.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
DENYLIST="$SCRIPT_DIR/denylist.txt"

if [[ ! -f "$DENYLIST" ]]; then
    echo "denylist file not found: $DENYLIST" >&2
    exit 2
fi

# Load denylist into an array, stripping comments and blanks.
mapfile -t TERMS < <(
    grep -vE '^\s*(#|$)' "$DENYLIST" | sed 's/[[:space:]]*$//' | grep -v '^$' || true
)

if [[ ${#TERMS[@]} -eq 0 ]]; then
    echo "denylist is empty; nothing to check" >&2
    exit 0
fi
# Baseline entries are exact per-file, per-term occurrence counts captured
# from the committed repository state. The repo gate compares current content
# to those counts so existing debt stays accountable while new debt fails.
BASELINE="$SCRIPT_DIR/baseline.tsv"
if [[ ! -f "$BASELINE" ]]; then
    echo "denylist baseline file not found: $BASELINE" >&2
    exit 2
fi

# Write the term list to a temp file for `grep -F -w -f`.
# Word-boundary matching avoids substring false positives ("vendor" matching "endor",
# "solo-author" matching "solo", etc.). For multi-word terms grep treats spaces as
# part of the literal; the surrounding text is still matched on word boundaries.
TERMFILE="$(mktemp)"
trap 'rm -f "$TERMFILE"' EXIT
for term in "${TERMS[@]}"; do
    [[ -n "$term" ]] && printf '%s\n' "$term" >> "$TERMFILE"
done
declare -A BASELINE_COUNTS=()
while IFS=$'\t' read -r baseline_path baseline_term baseline_count; do
    [[ -z "$baseline_path" || "$baseline_path" == \#* ]] && continue
    if [[ -z "$baseline_term" || ! "$baseline_count" =~ ^[1-9][0-9]*$ ]]; then
        echo "invalid denylist baseline entry: $baseline_path" >&2
        exit 2
    fi
    baseline_key="${baseline_path}"$'\t'"${baseline_term,,}"
    if [[ -n "${BASELINE_COUNTS[$baseline_key]+set}" ]]; then
        echo "duplicate denylist baseline entry: $baseline_path $baseline_term" >&2
        exit 2
    fi
    BASELINE_COUNTS["$baseline_key"]="$baseline_count"
done < "$BASELINE"
if [[ ! -s "$TERMFILE" ]]; then
    echo "denylist is empty after parsing" >&2
    exit 0
fi

MODE="repo"
PROMPT=""
EXPLICIT_FILES=()

while [[ $# -gt 0 ]]; do
    case "$1" in
        --prompt)
            MODE="prompt"
            PROMPT="${2:-}"
            shift 2
            ;;
        --files)
            MODE="files"
            shift
            while [[ $# -gt 0 ]] && [[ "$1" != --* ]]; do
                EXPLICIT_FILES+=("$1")
                shift
            done
            ;;
        *)
            echo "unknown arg: $1" >&2
            exit 2
            ;;
    esac
done

denylist_hit() {
    local subject="$1"
    local content="$2"
    local hits
    # -F fixed strings, -w word boundaries, -f read patterns from file, -i ignore case, -o only matches
    hits="$(printf '%s' "$content" | grep -Fwiof "$TERMFILE" 2>/dev/null | sort -uf || true)"
    if [[ -n "$hits" ]]; then
        echo "DENYLIST HIT in $subject:" >&2
        echo "$hits" | sed 's/^/  /' >&2
        return 1
    fi
    return 0
}

denylist_file() {
    local f="$1"
    [[ -f "$f" ]] || return 0
    if ! grep -Iq . "$f" 2>/dev/null; then
        return 0
    fi
    denylist_hit "$f" "$(cat -- "$f")"
}

baseline_repo_check() {
    local -n counts="$1"
    local key subject term allowed actual
    local rc=0
    for key in "${!BASELINE_COUNTS[@]}"; do
        subject="${key%%$'\t'*}"
        term="${key#*$'\t'}"
        allowed="${BASELINE_COUNTS[$key]}"
        actual="${counts[$key]:-0}"
        if [[ "$actual" -eq 0 ]]; then
            echo "DENYLIST BASELINE STALE in $subject:" >&2
            echo "  $term (allowed $allowed occurrences, found 0)" >&2
            rc=1
        elif [[ "$actual" -ne "$allowed" ]]; then
            if [[ "$actual" -gt "$allowed" ]]; then
                echo "DENYLIST HIT in $subject:" >&2
            else
                echo "DENYLIST BASELINE STALE in $subject:" >&2
            fi
            echo "  $term (allowed $allowed occurrences, found $actual)" >&2
            rc=1
        fi
    done
    for key in "${!counts[@]}"; do
        [[ -n "${BASELINE_COUNTS[$key]+set}" ]] && continue
        subject="${key%%$'\t'*}"
        term="${key#*$'\t'}"
        echo "DENYLIST HIT in $subject:" >&2
        echo "  $term (new occurrence count: ${counts[$key]})" >&2
        rc=1
    done
    return "$rc"
}

case "$MODE" in
    prompt)
        if denylist_hit "<prompt>" "$PROMPT"; then
            echo "prompt clean."
            exit 0
        else
            exit 1
        fi
        ;;
    files)
        rc=0
        for f in "${EXPLICIT_FILES[@]}"; do
            if ! denylist_file "$f"; then
                rc=1
            fi
        done
        exit "$rc"
        ;;
    repo)
        cd "$REPO_ROOT"
        # Path-name check: any tracked path containing a top-level 'reference/' directory fails.
        if git rev-parse --git-dir >/dev/null 2>&1; then
            BAD_PATHS="$(git ls-files 2>/dev/null | grep -E '(^|/)reference/' || true)"
            if [[ -n "$BAD_PATHS" ]]; then
                echo "tracked paths contain 'reference/' (reference vault must stay outside repo):" >&2
                echo "$BAD_PATHS" | sed 's/^/  /' >&2
                exit 1
            fi
        fi
        # Content scan: tracked and untracked text files. Boundary docs and
        # generated coverage fixtures are intentionally outside this gate.
        EXCLUDE_PATTERN='(^|\./)(tools/denylist/.*|tools/verification/coverage/temp-[^/]+\.json|docs/AI_PROMPT_DENYLIST\.md|docs/SOURCE_ISOLATION\.md|docs/PRODUCT_IDENTITY_BIBLE\.md|docs/RISK_REGISTER\.md|docs/adr/.*\.md|README\.md|PLAN\.md|CONTRIBUTING\.md)$'
        BIN_EXCLUDE='\.(png|jpg|jpeg|gif|webp|wav|ogg|mp3|mp4|glb|gltf|ktx2|basis|bin|zip|tar|gz|woff|woff2|ttf|otf|ico|pdf)$'
        rc=0
        if git rev-parse --git-dir >/dev/null 2>&1; then
            mapfile -t FILES < <(git ls-files --cached --others --exclude-standard 2>/dev/null | grep -vE "$EXCLUDE_PATTERN" | grep -vE "$BIN_EXCLUDE" || true)
            declare -A CURRENT_COUNTS=()
            for f in "${FILES[@]}"; do
                [[ -f "$f" ]] || continue
                if ! grep -Iq . "$f" 2>/dev/null; then
                    continue
                fi
                while IFS= read -r hit; do
                    [[ -n "$hit" ]] || continue
                    key="${f}"$'\t'"${hit,,}"
                    CURRENT_COUNTS["$key"]=$(( ${CURRENT_COUNTS[$key]:-0} + 1 ))
                done < <(grep -Fwiof "$TERMFILE" -- "$f" 2>/dev/null || true)
            done
            if ! baseline_repo_check CURRENT_COUNTS; then
                rc=1
            fi
        else
            mapfile -t FILES < <(find . -type f -not -path './.git/*' -not -path './node_modules/*' -not -path './target/*' | grep -vE "$EXCLUDE_PATTERN" | grep -vE "$BIN_EXCLUDE" || true)
            for f in "${FILES[@]}"; do
                if ! denylist_file "$f"; then
                    rc=1
                fi
            done
        fi
        if [[ $rc -eq 0 ]]; then
            echo "denylist check passed (${#FILES[@]} files, ${#TERMS[@]} terms, ${#BASELINE_COUNTS[@]} baseline entries)."
        fi
        exit "$rc"
        ;;
esac
