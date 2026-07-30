#!/usr/bin/env bash
# Successor — deterministic code-hygiene gate.
#
# Runs the Rust side (clippy -D warnings, cargo-machete, successor-sim tests) and
# the TypeScript/tooling side (command-manifest drift, knip, client-3d + server
# builds) and prints a clear PASS/FAIL summary. Exits non-zero if any hard gate
# fails.
#
# Hard gates (exit non-zero on failure):
#   - cargo clippy --workspace -- -D warnings
#   - cargo machete (no unused deps)
#   - cargo test -p successor-sim
#   - node tools/codegen/commands.mjs --check
#   - pnpm --dir client-3d build
#   - pnpm --dir server build
# Report gate (printed, does not fail the run):
#   - knip (unused exports/files/types)
#
# Usage:
#   tools/hygiene/run.sh                # everything
#   tools/hygiene/run.sh --rust         # rust gates only
#   tools/hygiene/run.sh --ts           # ts gates only
#
# knip is invoked via `pnpm dlx knip` so the gate is runnable without a global
# install; configuration lives in knip.json at the repo root.

set -u

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

SCOPE="all"
if [[ "${1:-}" == "--rust" ]]; then SCOPE="rust"; fi
if [[ "${1:-}" == "--ts" ]]; then SCOPE="ts"; fi

# --- terminal colors (disabled when not a tty) ---
if [[ -t 1 ]]; then
  GREEN=$'\033[32m'; RED=$'\033[31m'; YELLOW=$'\033[33m'; BOLD=$'\033[1m'; RESET=$'\033[0m'
else
  GREEN=""; RED=""; YELLOW=""; BOLD=""; RESET=""
fi

declare -a RESULTS=()
FAIL=0

run_step() {
  local label="$1"; shift
  local log
  log="$(mktemp -t successor-hygiene.XXXXXX.log)"
  if "$@" >"$log" 2>&1; then
    printf "  ${GREEN}PASS${RESET}  %s\n" "$label"
    RESULTS+=("${GREEN}PASS${RESET}  $label")
  else
    printf "  ${RED}FAIL${RESET}  %s${RESET}\n" "$label"
    RESULTS+=("${RED}FAIL${RESET}  $label")
    FAIL=1
    # surface the tail of the failing log so the summary is actionable
    printf "${RED}      --- last lines of %s ---${RESET}\n" "$label"
    tail -n 25 "$log" | sed 's/^/      /'
  fi
  rm -f "$log"
}

report_step() {
  # Report-only gate: prints findings count, never fails the run.
  local label="$1"; shift
  local log
  log="$(mktemp -t successor-hygiene.XXXXXX.log)"
  "$@" >"$log" 2>&1
  local rc=$?
  local lines
  lines="$(grep -cE '^(Unused|Unlisted|Duplicate)' "$log" || true)"
  if [[ $rc -eq 0 ]]; then
    printf "  ${GREEN}CLEAN${RESET}  %s\n" "$label"
    RESULTS+=("${GREEN}CLEAN${RESET}  $label (report gate)")
  else
    local count
    count="$(grep -cE '^(Unused files|Unused exports|Unused exported types|Unlisted|Duplicate exports)' "$log" || true)"
    printf "  ${YELLOW}INFO${RESET}   %s — %s finding group(s) (structural; see hygiene.md)\n" "$label" "${count:-0}"
    RESULTS+=("${YELLOW}INFO${RESET}   $label — ${count:-0} finding group(s) [report gate]")
  fi
  rm -f "$log"
}

echo "${BOLD}== Successor hygiene gate ==${RESET}"
echo

if [[ "$SCOPE" == "all" || "$SCOPE" == "rust" ]]; then
  echo "${BOLD}[rust]${RESET}"
  command -v cargo >/dev/null 2>&1 || { printf "  ${RED}FAIL${RESET}  cargo not on PATH\n"; FAIL=1; }
  if command -v cargo >/dev/null 2>&1; then
    run_step   "cargo clippy --workspace --all-targets -- -D warnings" \
               cargo clippy --workspace --all-targets -- -D warnings
    # cargo-machete is a cargo subcommand; fall back to a documented udeps note.
    if cargo machete --version >/dev/null 2>&1; then
      run_step "cargo machete (unused deps)" cargo machete --skip-target-dir
    else
      printf "  ${YELLOW}SKIP${RESET}  cargo machete not installed (cargo install cargo-machete; fallback: cargo +nightly udeps)\n"
      RESULTS+=("${YELLOW}SKIP${RESET}  cargo machete (not installed)")
    fi
    run_step   "cargo test -p successor-sim" \
               cargo test -p successor-sim
  fi
  echo
fi

if [[ "$SCOPE" == "all" || "$SCOPE" == "ts" ]]; then
  echo "${BOLD}[typescript]${RESET}"
  command -v pnpm >/dev/null 2>&1 || { printf "  ${RED}FAIL${RESET}  pnpm not on PATH\n"; FAIL=1; }
  command -v node >/dev/null 2>&1 || { printf "  ${RED}FAIL${RESET}  node not on PATH\n"; FAIL=1; }
  if command -v node >/dev/null 2>&1; then
    run_step    "node tools/codegen/commands.mjs --check" node tools/codegen/commands.mjs --check
  fi
  if command -v pnpm >/dev/null 2>&1; then
    run_step    "pnpm --dir client-3d build" pnpm --dir client-3d build
    run_step    "pnpm --dir server build"    pnpm --dir server build
    report_step "knip (unused exports/files/types)" pnpm dlx knip@6 --no-progress
  fi
  echo
fi

echo "${BOLD}== summary ==${RESET}"
for r in "${RESULTS[@]}"; do
  printf "  %s\n" "$r"
done
echo
if [[ $FAIL -eq 0 ]]; then
  printf "${GREEN}${BOLD}HYGIENE GATE: PASS${RESET} (hard gates green; knip is a report gate)\n"
else
  printf "${RED}${BOLD}HYGIENE GATE: FAIL${RESET} (one or more hard gates failed)\n"
fi
exit $FAIL
