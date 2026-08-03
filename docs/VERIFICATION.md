# Successor Verification

Status: current verification contract and latest local source proof as of
2026-08-02; latest public proof remains 2026-07-29.

Run commands from the repository root in the checkout being verified. A passing
result belongs to the exact source revision and working tree that produced it.
Historical screenshots, migration reports, another checkout, or a public
release cannot prove the current development source.

Architecture and scope live in `CANONICAL_CONTEXT.md`. Current implementation
inventory lives in `CURRENT_PROJECT_STATE.md`. Volatile public identities and
release debt live in `CURRENT_DEPLOYMENT.md`.

## Install and source identity

```bash
git status --short
git rev-parse HEAD
pnpm install --frozen-lockfile
pnpm verify:successor-context
```

Development may use any branch or checkout layout. Bind proof to the exact
revision and working tree, preserve unrelated changes, and remove temporary
isolation created for the task before handoff.

## Required source gates

The normal repository handoff requires both the Node/workspace gate and the
Rust gate:

```bash
pnpm run ci
pnpm hygiene:rust
```

`pnpm run ci` checks canonical-context drift, command and verification
coverage, deployment contracts, denylisted sources, production dependency
audit, all workspace builds, and all workspace tests. `pnpm hygiene:rust`
runs clippy with warnings denied, `cargo machete` when installed, and the
`successor-sim` suite.

For explicit Rust output, or when changing the authority, checkpoint, bridge,
or Rust contracts, also run:

```bash
cargo fmt --all -- --check
cargo check --workspace --all-targets
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
pnpm replay:authority
```

The deterministic replay must produce the same hash on repeated runs from the
same source. Any intentional hash change needs an explanation tied to the
behavior change.

## Focused package checks

Use the narrowest relevant checks while iterating, then run the required source
gates before handoff.

| Scope | Focused commands |
| --- | --- |
| Shared runtime | `pnpm --dir client lint && pnpm --dir client build && pnpm --dir client test` |
| Graphical client | `pnpm --dir client-3d build && pnpm --dir client-3d test` |
| Terminal client | `pnpm --dir client-tui lint && pnpm --dir client-tui build && pnpm --dir client-tui test` |
| Server and persistence | `pnpm --dir server lint && pnpm --dir server build && pnpm --dir server test` |
| Desktop supervisor | `pnpm --dir desktop check && pnpm --dir desktop test && pnpm --dir desktop verify:key-ownership` |
| Marketing and launch site | `pnpm site:test && pnpm site:build` |
| Release tooling | `pnpm deploy:contract && pnpm --dir desktop release:manifest` |
| Standalone Rust client | `make -C client-rust verify && make -C client-rust check-allocs && make -C client-rust runtime-check && make -C client-rust render-check && make -C client-rust terrain-check && make -C client-rust nostd`; connected changes also run `make -C client-rust connected-check-allocs CONNECTED_ENDPOINT=... CONNECTED_PLAYER=... CONNECTED_ACTOR=...` against a disposable authority |

`client-rust/` is outside both root workspaces. Its own gates are mandatory:
`verify` covers tests, corpus audit, and stripped native/wasm size budgets;
`check-allocs` requires zero steady-state allocations in the standard scene;
`connected-check-allocs` applies the same invariant after deferred connected
presentation initialization and requires at least 240 stable actor-count
frames; `runtime-check` checks frame time and RSS; `render-check` checks native
material-parity GPU p99; `terrain-check` checks deterministic desert and forest
ROI probes plus terrain GPU p99; and `nostd` builds both engine crates for
`thumbv7em-none-eabihf`. Browser renderer changes additionally require the
corresponding WebGL2 probe, connected authority commands and receipts, a resize
round trip, deterministic half-float-disabled fallback, gesture-gated audio,
and rendered context-loss recovery without replaying the launch capability.

For a Rust web beta release, build the immutable artifact from the exact source
and server protocol identities:

```bash
make -C client-rust web-release \
  SOURCE_COMMIT=<40-char-source-commit> \
  CLIENT_RELEASE_ID=successor-rust-beta@<source-prefix> \
  SERVER_RELEASE_ID=<server-protocol-id>
```

Inspect `client-rust/out/web-release/release-manifest.json`, then dry-run
`publish-client-assets.mjs` against that directory and
`promote-client-runtime.mjs` with
`--destination site/current/beta/release.json --channel beta
--server-release-id <server-protocol-id>`. The beta pointer and stable
`site/current/client/release.json` pointer are independent.

Browser beta proof must use `/beta/` and cover exact-parent READY/launch,
release-bound game and chat redemption, movement and receipts, resize,
gesture-gated audio, RGBA8 fallback, WebGL context loss/recovery, clean exit,
fresh-ticket re-entry, and character switching. Inspect URLs, storage, DOM,
console output, and proof artifacts for capability leakage. Repeat a stable
`/play/` journey after beta proof.

Native agent-control changes additionally require a real loopback journey:
launch a windowed demo or connected client with `--control-port N`, pipe
multiple input commands through `out/bin/successor-control`, request and
inspect a protocol screenshot, save `successor.input.v1`, relaunch with
`--replay-input`, and prove the replayed UI or actor result in a second
screenshot. A TCP acknowledgement alone is not visual or gameplay proof.

Graphics-tuning changes additionally require: load the checked-in
`assets/render/settings.json`, open the Backquote overlay through
`successor-control`, inspect all three control pages, change both a lighting or
post value and a palette/color value, capture the visible output difference,
save and reload the document, then restore the intended checked-in preset.
Verify a second launch consumes the saved/default document. Palette and grade
proof must inspect pixels; JSON values or uniform logs alone are insufficient.

`client-rust/budgets.json` is authoritative. Its fidelity-first caps are 6 MiB
stripped native, 4 MiB stripped WebAssembly, 8.33 ms runtime/terrain p99,
16.67 ms generic render p99, zero steady-state frame allocations, and 512 MiB
peak RSS. Relative headroom is `max(512 KiB, 25%)` for size, 100% for
performance, and 5% for RSS; absolute caps still apply.

Changes under `client-3d/` or shared `client/src/` must also rebuild the
packaged desktop:

```bash
pnpm desktop:build
```

## World generation

The open-desert fixture and map bundle are generated source. Changes to the
generator, structure sidecars, actor population, terminals, collision, or map
contracts require:

```bash
node tools/successor/configure-open-desert-fixture.mjs
node tools/successor/compile-map-bundle.mjs --verify
pnpm test:fixture-contract
git diff --exit-code -- \
  client/public/successor-slice/open-desert-slice.json \
  client/public/successor-slice/open-desert-map-bundle.json
```

The current checked-in identities are:

- slice SHA-256:
  `db907f43d0d19b3863db5b54508cea2f3f31e2962b83e0967be07c7248310190`
- map-bundle SHA-256:
  `4f0181134e7f0c37fa0189a89fb3ea145c3a6a34271d97a5b2f8e6f8c0dd8738`

Update the canonical and state docs in the same change when either identity
changes.

## Checkpoint and durability

The Rust authority accepts only `authority.checkpoint.v1`, version 1. Focused
checkpoint tests cover round-trip restore into the current authored world,
payload tampering, unsupported schema/version failure, transient-state
exclusion, and door-id reconciliation:

```bash
cargo test -p successor-sim authority::snapshots::checkpoint_tests
cargo test -p successor-sim \
  authority_transition_preserves_character_state_and_checkpoint_roundtrip
cargo test -p successor-sim \
  bridge_relocate_actor_preserves_progression_inventory_and_checkpoint_state
pnpm --filter @successor/server exec vitest run \
  src/game/rustAuthorityBridge.test.ts src/game/shard.test.ts
pnpm --dir server test:durability
node --test desktop/test/durable-character-inventory.integration.test.mjs
```

Checkpoint work must prove all of the following:

- `payloadHash` rejects altered durable payloads;
- authored geometry, tuning, catalogs, static collision, caches, metrics, and
  one-shot deliveries are not smuggled into durable state;
- current authored doors receive saved open state by stable prop id;
- an incompatible outer shard or desktop save fails closed;
- portal and ticket travel retain actor progression, equipment, vitals, and
  inventory through serialized restore, with no live-actor upsert;
- an accepted world transition reaches a forced checkpoint before its receipt;
- no command silently resets, renames, discards, or rewrites player state.

The removed `authority.state-export.v1` versions and desktop v4-through-v9
migration scripts are not a compatibility target. A future conversion from an
archived save is new work and needs its own isolated-copy proof.

Account persistence upgrades the checksum-pinned
`alpha-control-current-v1` head to the current
`alpha-control-bug-reports-v2` head without resetting accounts. Character
persistence accepts only `successor.character-store.v2`. Focused proof must
preserve an existing v1 account while adding the report ledger, restore a
checksum-bound v1 world checkpoint, and rebind its durability manifest to v2
on the next forced checkpoint. It must reject
incomplete records, unknown migration heads, older character schemas, missing
launch provenance, and mixed character/checkpoint domains. A breaking
pre-alpha release proves a verified backup plus coherent reset and a
fresh-player journey; it does not require an open-ended dual-read migration.

## Runtime and player journeys

Start local services only on loopback, then confirm the exact authority before
judging behavior:

```bash
pnpm server:local:persistent
pnpm --dir client-3d dev
curl -fsS http://127.0.0.1:28093/game/status | jq \
  '{shardId,tick,source,readiness,persistence}'
```

The full headless, TUI, and graphical journey sets are:

```bash
GAME_ALLOW_DEV_IDENTITY=1 pnpm gate:all
```

Durability-sensitive changes require the focused restart and graphical
lifecycle sets:

```bash
pnpm lifecycle:gate
pnpm lifecycle:3d
```

The graphical gate needs a usable display or isolated Xvfb environment. A
listening Vite page is not proof. Record the source commit, fixture identity,
authority status, journey ids, and artifact directory for any visual
acceptance claim.

## Desktop distribution

The desktop shell packages the graphical client and owns an isolated local
authority lifetime. For desktop, shared-client, persistence, hosted-session,
or packaging changes run:

```bash
pnpm desktop:build
pnpm --dir desktop check
pnpm --dir desktop test
pnpm --dir desktop verify:key-ownership
pnpm desktop:smoke
```

The smoke must identify the packaged artifact it launched. Do not substitute a
source Vite session for packaged-desktop proof.

## Full verification farm

For broad authority/protocol work, fixture rewrites, cross-package refactors,
or a release candidate, inspect and execute the source-aware matrix:

```bash
pnpm verify:full --dry-run --pretty
pnpm verify:full
```

The full run executes fresh against the identified source revision. Generated
ledgers, screenshots, and build output are evidence artifacts, not committed
source.

## Public release observation

Public observation is read-only and does not authorize a deployment, state
reset, key rotation, or pointer promotion:

```bash
curl -fsS https://www.successorgame.com/client/release.json | jq .
curl -fsS https://www.successorgame.com/beta/release.json | jq .
curl -fsS https://www.successorgame.com/downloads/manifest.json | jq .
curl -fsS https://world.successorgame.com/healthz | jq .
curl -fsS https://world.successorgame.com/readyz | jq .
curl -fsS https://world.successorgame.com/game/status | jq \
  '{source,readiness,persistence:{enabled:.persistence.enabled,restore:.persistence.restore},durabilityManifest}'
```

Bind every public claim to the exact client pointer, server image, state
generation, and site/native release recorded in `CURRENT_DEPLOYMENT.md`.
Health and readiness do not replace an authenticated player journey.

## Latest public release proof

The running authority is exact source
`b9262b21a1c8f51d146a9006188d62794456f3fb`. It includes the current-only
state refactor, clean browser exit, face persistence, spatial/global chat,
bounded audio, in-place ticket travel, authored-actor isolation, direct durable
actor restart proof, and synchronous lifecycle-journal flush.

The clean release source passed:

- `pnpm run ci`;
- server lint and build, with 467 tests total including the 172-test shard
  suite;
- `pnpm hygiene:rust`, clippy with warnings denied, `cargo machete`, and the
  `successor-sim` tests;
- the direct real-Rust durability restart proof;
- the standalone release matrix, 13/13, run id
  `standalone-rc-b9262b21a1c8`.

The standalone matrix bound source tree
`986d65e4b4d8c1b90632cf79acbbc74d665e3110` and source hash
`29024cd47d3555df5735e58f10c97bf992f580cfe95934eec531b98fbb26af5a`.
The sealed amd64 image is:

```text
595529182031.dkr.ecr.us-east-1.amazonaws.com/successor-staging-1/server@sha256:0e7d1055fba3787c35c9c367d0d3b07136f95d47decb919cb0c873bd1d994040
```

The release evidence is identified by public-journey digest
`7df2b5fbd681bda99d0eadf664d1b631517f4b9bdd8961aa4bb7daaecd405cc6`;
its storage location is environment-specific and is not part of the
verification contract.

The final authenticated public journey passed 25 checks. It proved:

- registration, nondefault face creation, first entry, clean character switch,
  logout, and relog;
- no durable character can take the authored fixture actor `player`;
- local chat through the inclusive 24-cell edge and suppression beyond it;
- same-area zone routing, cross-area zone suppression, and cross-area global
  delivery;
- two travel tickets in one inventory, consumption of one for in-place travel,
  and retention of the second;
- exact destination, worn state, appearance, Scout novice box, 16 spent
  points, 250-point cap, and remaining inventory after world travel and relog;
- final healthy readiness with no buffered lifecycle journal entry.

Its canonical proof digest is:

```text
7df2b5fbd681bda99d0eadf664d1b631517f4b9bdd8961aa4bb7daaecd405cc6
```

The operator inspection independently counted the current characters, found
zero roster owners of the authored placeholder, read the retained travel
ticket from the checkpoint, and matched the durable character summary. The
public state contains only smoke accounts/characters from the release proof.

The separately promoted site source
`5c30a98a777406ec5b77eb38fe95881b0c6389e5` passed 170 tests and a production
build. Cache-busted public checks found its corrected download copy and the
zero-build native manifest. The browser pointer remained
`successor-alpha@731b87bb5ce5ea4c`; no browser rebuild was implied by the site
promotion.

## Unpromoted hosted-launch repair

Current source removes the redundant second confirmation after roster/workshop
selection and separates the canonical server protocol identity from the
broader deployment release stamp. Focused proof covers direct entry, direct
`/play/` fallback, malformed/unknown handoffs, storage-denied fallback,
runtime-pointer failure without ticket minting, full-viewport state, exact
origin/window handoff, clean frame replacement, and source credential hygiene.

The relevant source checks are:

```bash
NODE_OPTIONS=--no-experimental-webstorage pnpm site:test
pnpm site:build
node --test ops/deploy/operator-contract.test.mjs
pnpm deploy:contract
```

The Node option disables Node 26's process-level experimental Web Storage so
Happy DOM owns the test window's storage objects; without it, the unrelated
storage-spy test cannot construct `window.localStorage`.

These checks prove source behavior only. They do not prove a site promotion,
authority restart, repaired public launch, or authenticated world entry.

## Repository recovery

The pre-consolidation archive contains the verified all-refs bundle for the
former worktrees, dirty patches and untracked payloads, the corrupt-checkout
raw archive, and the unfinished property/farming patch. Its storage location is
environment-specific and must be supplied explicitly:

```bash
archive="${SUCCESSOR_RECOVERY_ARCHIVE:?set recovery archive path}"
repo="${SUCCESSOR_REPO_ROOT:-$PWD}"
sha256sum --check "$archive/SHA256SUMS"
git -C "$repo" bundle verify "$archive/successor-all-refs.bundle"
git -C "$repo" bundle list-heads "$archive/successor-all-refs.bundle"
```

Do not restore the former worktree farm. Extract one named commit, patch, or
payload into an isolated checkout, revalidate it against the current source
tree, then either integrate it or remove the temporary checkout.

## Before committing

1. Review `git status`, `git diff --check`, and the staged diff for unrelated
   work, generated caches, credentials, private absolute paths, and oversized
   binaries.
2. Confirm canonical docs describe current code and that future briefs are not
   presented as shipped behavior.
3. Run focused checks, `pnpm run ci`, and `pnpm hygiene:rust`.
4. Rebuild and smoke the desktop package when its inputs changed.
5. Commit or otherwise preserve only the intended files in the requested
   source destination.
6. Report source, built, published, promoted, and player-verified states
   separately.

If a credential might have appeared in logs, session JSON, or an artifact,
report the concern and affected scope. Do not revoke or rotate anything unless
the user explicitly authorizes that action.
