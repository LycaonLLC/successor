#!/usr/bin/env bash
# Bootstrap a fresh checkout. Idempotent.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$REPO_ROOT"

echo "==> Successor bootstrap"

# Rust toolchain
if ! command -v cargo >/dev/null; then
    echo "cargo not found. Install rustup from https://rustup.rs/ first." >&2
    exit 1
fi

# wasm32 target
rustup target add wasm32-unknown-unknown >/dev/null 2>&1 || true

# Optional Rust tools
cargo install cargo-mutants --locked 2>/dev/null || true

# Node toolchain
if ! command -v pnpm >/dev/null; then
    if command -v corepack >/dev/null; then
        corepack enable
        corepack prepare pnpm@latest --activate
    else
        echo "pnpm not found and corepack unavailable. Install Node 22 + pnpm manually." >&2
        exit 1
    fi
fi

pnpm install

# Pre-commit hook: denylist
HOOK="$REPO_ROOT/.git/hooks/pre-commit"
if [[ -d "$REPO_ROOT/.git" ]]; then
    cat > "$HOOK" <<'EOF'
#!/usr/bin/env bash
exec "$(git rev-parse --show-toplevel)/tools/denylist/check.sh"
EOF
    chmod +x "$HOOK"
    echo "==> installed pre-commit denylist hook"
fi

echo "==> bootstrap complete"
