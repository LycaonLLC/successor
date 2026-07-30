#!/usr/bin/env bash
# Packaged Successor desktop launcher.
#
# Brings the desktop shell's runtime artifacts up to date (only building what is
# missing) and then execs Electron pointed at the desktop shell. The desktop
# shell (desktop/src/main.mjs) is responsible for starting its own game server
# and tearing it down when the window closes; this script does not manage the
# server process.
set -euo pipefail

REPO=/home/lycaon/dev/games/successor
export PATH="$HOME/.local/bin:$HOME/.cargo/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

# Establish the runtime log before any staleness check can trigger a build. The
# desktop entries use Terminal=false, so build/install failures would otherwise
# disappear before Electron has a chance to initialize its own log sink.
mkdir -p "$HOME/.local/state/successor-desktop"
export SUCCESSOR_DESKTOP_RUNTIME_LOG="$HOME/.local/state/successor-desktop/launch-$(date +%Y%m%d-%H%M%S).log"

launcher_log() {
  printf '[successor-desktop-launch] %s\n' "$1" | tee -a "$SUCCESSOR_DESKTOP_RUNTIME_LOG" >&2
}

run_logged() {
  local label=$1
  shift
  launcher_log "starting $label"
  if "$@" \
    > >(tee -a "$SUCCESSOR_DESKTOP_RUNTIME_LOG") \
    2> >(tee -a "$SUCCESSOR_DESKTOP_RUNTIME_LOG" >&2); then
    launcher_log "completed $label"
    return 0
  else
    local status=$?
    launcher_log "FAILED $label (exit $status)"
    return "$status"
  fi
}

FORCE_REBUILD=0
if [[ "${1:-}" == "--rebuild" ]]; then
  FORCE_REBUILD=1
  shift
fi

build_server() {
  run_logged "server build" pnpm --dir "$REPO/server" build
}
build_sim() {
  (cd "$REPO" && run_logged "Rust authority bridge build" env CARGO_PROFILE_DEV_OPT_LEVEL=2 cargo build -q -p successor-sim --example authority_bridge_server)
}
build_client_3d() {
  run_logged "3D client build" pnpm --dir "$REPO/client-3d" build
}
install_desktop() {
  run_logged "desktop dependency install" pnpm --dir "$REPO/desktop" install
}

# Staleness gate: an artifact is rebuilt when it is MISSING or any relevant
# source file is newer than it. The old existence-only check shipped stale
# clients (2026-07-05: fresh weather server under a pre-storm client dist —
# server-side hazard ticking with zero visuals).
stale() {
  local artifact=$1
  shift
  [[ -f "$artifact" || -x "$artifact" ]] || return 0
  local newer
  newer=$(find "$@" -type f \
    \( -name '*.ts' -o -name '*.rs' -o -name '*.mjs' -o -name '*.js' \
       -o -name '*.json' -o -name '*.css' -o -name '*.html' -o -name '*.glb' \) \
    -newer "$artifact" -print -quit 2>/dev/null)
  [[ -n "$newer" ]]
}

if [[ "$FORCE_REBUILD" -eq 1 ]]; then
  build_server
  build_sim
  build_client_3d
  [[ -x "$REPO/desktop/node_modules/.bin/electron" ]] || install_desktop
else
  # NOTE: client/public/successor-slice is intentionally excluded — the shell
  # regenerates the fixture at every launch, which would force rebuilds.
  ! stale "$REPO/server/dist/index.js" "$REPO/server/src" "$REPO/client/src/slice-core" || build_server
  ! stale "$REPO/target/debug/examples/authority_bridge_server" "$REPO/crates" || build_sim
  ! stale "$REPO/client-3d/dist/index.html" "$REPO/client-3d/src" "$REPO/client-3d/public" "$REPO/client/src" || build_client_3d
  [[ -x "$REPO/desktop/node_modules/.bin/electron" ]] || install_desktop
fi

# Sandbox preflight: with unprivileged userns restricted (Ubuntu default),
# Chromium needs the SUID sandbox helper (root-owned, mode 4755). A pnpm
# store rebuild resets ownership, which would abort Electron with SIGTRAP
# before any window appears. Fall back to --no-sandbox (local repo client,
# loads only local content) and leave a loud note in the runtime log.
SANDBOX_ARGS=()
CHROME_SANDBOX="$(readlink -f "$REPO/desktop/node_modules/electron/dist/chrome-sandbox" 2>/dev/null || true)"
SYSCTL_BIN="$(command -v sysctl 2>/dev/null || true)"
if [[ -z "$SYSCTL_BIN" ]]; then
  for candidate in /usr/sbin/sysctl /sbin/sysctl; do
    if [[ -x "$candidate" ]]; then
      SYSCTL_BIN=$candidate
      break
    fi
  done
fi
APPARMOR_RESTRICT_UNPRIVILEGED_USERNS=0
if [[ -n "$SYSCTL_BIN" ]]; then
  APPARMOR_RESTRICT_UNPRIVILEGED_USERNS="$("$SYSCTL_BIN" -n kernel.apparmor_restrict_unprivileged_userns 2>/dev/null || echo 0)"
else
  launcher_log "WARNING: sysctl is unavailable; unable to query kernel.apparmor_restrict_unprivileged_userns"
fi
if [[ "$APPARMOR_RESTRICT_UNPRIVILEGED_USERNS" == "1" ]]; then
  if [[ -z "$CHROME_SANDBOX" || "$(stat -c '%u %a' "$CHROME_SANDBOX" 2>/dev/null)" != "0 4755" ]]; then
    SANDBOX_ARGS=(--no-sandbox)
    launcher_log "WARNING: chrome-sandbox not root:4755 (${CHROME_SANDBOX:-missing}); launching with --no-sandbox. Fix: sudo chown root:root <path> && sudo chmod 4755 <path>"
  fi
fi

exec "$REPO/desktop/node_modules/.bin/electron" "$REPO/desktop" "${SANDBOX_ARGS[@]}" "$@"
