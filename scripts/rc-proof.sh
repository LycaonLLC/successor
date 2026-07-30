#!/usr/bin/env bash
set -euo pipefail
umask 077

usage() {
  printf 'usage: %s <40-hex-commit>\n' "$0" >&2
}

if [[ $# -ne 1 ]]; then
  usage
  exit 2
fi
sha_input=$1
if [[ ! "$sha_input" =~ ^[0-9a-fA-F]{40}$ ]]; then
  printf 'RC FAIL invocation commit must be exactly 40 hexadecimal characters\n'
  exit 2
fi

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
repo_root=$(CDPATH= cd -- "$script_dir/.." && pwd -P)
if ! git -C "$repo_root" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  printf 'RC FAIL invocation repository is not a git worktree\n'
  exit 2
fi
if [[ -n "$(git -C "$repo_root" status --porcelain=v1 --untracked-files=all)" ]]; then
  printf 'RC FAIL invocation canonical worktree is dirty\n'
  exit 2
fi
if ! git -C "$repo_root" cat-file -e "$sha_input^{commit}" 2>/dev/null; then
  printf 'RC FAIL invocation commit does not resolve to a commit\n'
  exit 2
fi
resolved=$(git -C "$repo_root" rev-parse --verify "$sha_input^{commit}")
if [[ ! "$resolved" =~ ^[0-9a-f]{40}$ ]]; then
  printf 'RC FAIL invocation commit resolution was not exact\n'
  exit 2
fi

cache_root=${SUCCESSOR_RC_PROOF_ROOT:-/home/lycaon/.cache/successor-rc-proof}
case "$cache_root" in
  /home/lycaon/.cache|/home/lycaon/.cache/*|/home/lycaon/dev/releases|/home/lycaon/dev/releases/*) ;;
  *) printf 'RC FAIL invocation proof root must stay under the approved cache or release root\n'; exit 2 ;;
esac
if [[ -L "$cache_root" ]]; then
  printf 'RC FAIL invocation proof root must not be a symlink\n'
  exit 2
fi
mkdir -p "$cache_root"
cache_real=$(realpath -e "$cache_root")
case "$cache_real" in
  /home/lycaon/.cache|/home/lycaon/.cache/*|/home/lycaon/dev/releases|/home/lycaon/dev/releases/*) ;;
  *) printf 'RC FAIL invocation proof root resolves outside the approved roots\n'; exit 2 ;;
esac
if [[ "$(stat -c %u "$cache_real")" != "$(id -u)" ]]; then
  printf 'RC FAIL invocation proof root is not owned by the current user\n'
  exit 2
fi
chmod 700 "$cache_real"
run_id="rc-$(date -u +%Y%m%dT%H%M%SZ)-$$-${RANDOM}"
run_root="$cache_real/$run_id"
if ! mkdir -m 700 "$run_root" || ! mkdir -m 700 "$run_root/evidence"; then
  printf 'RC FAIL infrastructure unable to create private run root\n'
  exit 3
fi
worktree="$run_root/worktree"
worktree_added=0
cleanup_worktree() {
  if [[ $worktree_added -ne 1 ]]; then return 0; fi
  git -C "$repo_root" worktree unlock "$worktree" >/dev/null 2>&1 || true
  if ! git -C "$repo_root" worktree remove --force "$worktree" >/dev/null 2>&1; then return 1; fi
  worktree_added=0
  [[ ! -e "$worktree" ]]
}
emergency_cleanup() {
  cleanup_worktree || true
}
trap emergency_cleanup EXIT INT TERM

if ! git -C "$repo_root" worktree add --detach --lock "$worktree" "$resolved" >/dev/null 2>&1; then
  printf 'RC FAIL infrastructure unable to create detached worktree\n'
  exit 3
fi
worktree_added=1
if [[ "$(git -C "$worktree" rev-parse HEAD)" != "$resolved" ]]; then
  printf 'RC FAIL infrastructure detached worktree SHA mismatch\n'
  exit 3
fi
if [[ -n "$(git -C "$worktree" status --porcelain=v1 --untracked-files=all)" ]]; then
  printf 'RC FAIL infrastructure detached worktree is dirty\n'
  exit 3
fi

runner="$worktree/tools/verification/rc/run.mjs"
status=3
line="RC INCOMPLETE runner-missing-at-commit $run_root/evidence"
if [[ -f "$runner" ]]; then
  runner_stderr="$run_root/runner.stderr"
  set +e
  runner_output=$(node "$runner" \
    --commit "$resolved" \
    --worktree "$worktree" \
    --run-root "$run_root" \
    --artifact-root "$run_root/evidence" \
    --run-id "$run_id" 2>"$runner_stderr")
  status=$?
  set -e
  nonempty_lines=$(printf '%s\n' "$runner_output" | sed '/^[[:space:]]*$/d' | wc -l | tr -d ' ')
  if [[ $nonempty_lines -eq 1 && ! -s "$runner_stderr" ]]; then
    line=$(printf '%s\n' "$runner_output" | sed '/^[[:space:]]*$/d')
  else
    status=3
    line="RC INCOMPLETE runner-output-contract $run_root/evidence"
  fi
fi

trap - EXIT INT TERM
if ! cleanup_worktree; then
  status=3
  line="RC INCOMPLETE worktree-cleanup $run_root/evidence"
fi
printf '%s\n' "$line"
exit "$status"
