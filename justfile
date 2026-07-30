# Successor task runner. Install just: https://github.com/casey/just

default:
    @just --list

# Run the denylist CI gate. Fails on any forbidden term in tracked files.
denylist:
    bash tools/denylist/check.sh

# Run the Successor active-context gate. Fails if retired local inference paths
# reappear in active code, scripts, or launch configuration.
context-gate:
    node tools/verification/successor-context-gate.mjs

# Build everything.
build:
    cargo build --workspace
    pnpm build

# Run the full test suite (Rust + Node + denylist + provenance audit).
test:
    node tools/verification/successor-context-gate.mjs
    bash tools/denylist/check.sh
    cargo test --workspace
    pnpm test

# Run mutation tests on active gameplay crates.
mutate:
    cargo mutants --workspace

# Snapshot tool/dependency provenance into content-pipeline/manifests/tool-snapshot.md.
tool-snapshot:
    bash tools/tool-snapshot/snapshot.sh

# Log external reference inspection for source-isolation audits.
log-reference-access note:
    bash tools/reference-access-log/log.sh "{{note}}"

# Audit content-pipeline manifests for missing provenance.
provenance-audit:
    python3 tools/provenance-audit/audit.py

# Bootstrap a fresh checkout (install Rust toolchain, pnpm, hooks).
bootstrap:
    bash bootstrap.sh
