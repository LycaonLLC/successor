# Successor Agent Notes

Treat `~/dev/games/successor` on Bunker as the sole canonical checkout. Its
branch is `main`. Inspect current code, processes, fixture identity, and Git
status before broad changes. Preserve unrelated local work.

Read these files in order before making architecture or runtime claims:

1. `docs/CANONICAL_CONTEXT.md`
2. `docs/CURRENT_PROJECT_STATE.md`
3. `docs/CURRENT_DEPLOYMENT.md`
4. `docs/VERIFICATION.md`

The canonical context owns architecture and scope. The state document is a
dated implementation snapshot. The deployment document owns volatile public
release identity. The verification document owns commands and runtime proof.
Narrow design docs may add detail but cannot override those four files.
Files under `docs/future/` are retained proposals, not current behavior. Verify
their assumptions against `main` before implementing them.

## Credential authority

Never revoke, rotate, replace, or disable an API key, SSH key, token, session,
or other credential merely because it appeared in session JSON, logs, tool
output, or another potentially exposed artifact. Investigate read-only, limit
further disclosure, and report the concern and affected scope in the final
handoff. Credential rotation requires explicit user authorization naming the
action or credential scope. Do not treat a general cleanup, security review, or
incident investigation as that authorization.

## Pre-alpha state compatibility

Accounts, characters, and world saves in the public alpha are disposable test
state, not a compatibility target. Do not add dual reads, migration ladders,
legacy claims, inferred defaults, or stale-ticket fallbacks solely to keep an
older pre-alpha generation loadable. Current schemas must validate completely
and fail closed.

When a requested release is intentionally incompatible, take and verify an
immutable backup, stop the single writer, and reset the smallest coherent
domain:

- identity/control state and its character roster;
- character roster plus checkpoint, journal, and durability manifest; or
- the full state generation when those domains cannot be separated safely.

Never reset opportunistically during startup, and do not infer reset
authorization from read-only investigation. A requested incompatible pre-alpha
release may use the backed-up reset path instead of compatibility work. Record
the backup identity, reset scope, new generation, exact release identities, and
post-reset player journey in `docs/CURRENT_DEPLOYMENT.md`.

## Host, source, and service ownership

| Use | Host and path | Agent rule |
| --- | --- | --- |
| Canonical integrated source | Bunker: `~/dev/games/successor`, branch `main` | Inspect HEAD, dirt, and `docs/CURRENT_DEPLOYMENT.md` before using it. Canonical checkout HEAD is development truth, not automatically production truth. |
| Temporary isolated work | Bunker disposable worktree | Start from `main` or the exact requested source commit. Merge or archive intentional work, then remove the worktree and its task branch before handoff. |
| PawnForge authoring | Bunker: `~/dev/games/pawn-forge/pawnforgev2` | Use for humanoid, rig, socket, and GLB source work. |
| Interactive cockpit | Michael's Mac | Use for interactive review and macOS-specific package proof. Do not assume a Mac checkout matches Bunker. |
| Public alpha | AWS | Site/client/downloads are S3/CloudFront; the single-writer authority is private EC2 behind the ALB. Bunker is not the public game host. |

The public surfaces are `https://www.successorgame.com` and
`https://world.successorgame.com`. The AWS instance has no public SSH ingress;
use the documented SSM/operator route. Local listeners and disposable
verification shards remain loopback-only. A Vite page, screenshot, listener,
temporary pod, or Rust process does not become the public alpha merely because
it is reachable from a test client.

Production may intentionally trail integrated development. Read the public
client pointer, server evidence, and native manifest before naming a live SHA.
Never infer production identity from the current branch name or newest commit.

## Repository discipline

`main` is the only long-lived branch in both the canonical checkout and the
local Bunker hub. A temporary task worktree is allowed when isolation is
useful, but it is not another source of truth. Before handoff:

1. merge verified work into `main`, or preserve unfinished work in a named
   recovery bundle or patch;
2. remove the temporary worktree;
3. delete its task branch; and
4. confirm `git worktree list` normally shows only
   `~/dev/games/successor`.

Do not accumulate verification-farm, cache-root, or detached worktrees. Do not
launch a new task from another task worktree. Production release identities
remain independent of `main` and must still come from
`docs/CURRENT_DEPLOYMENT.md`.

## Supported product surfaces

- `client-3d/` is the graphical game client.
- `client-tui/` is the terminal game client.
- `client/` is their renderer-neutral shared runtime and headless host.
- `desktop/` packages `client-3d/`; it does not fork gameplay state.
- `site/` is the marketing, account, connect, play-launch, and download shell;
  it is not a gameplay authority.
- `ops/deploy/` owns the AWS publication and single-writer deployment
  contracts.
- `client/public/successor-slice/open-desert-slice.json` and its map bundle are
  the default checked-in world fixture.

Do not add another gameplay client, world fixture, combat authority, or asset
manifest without an explicit product decision and a canonical-context update.

## Rust client (client-rust/)

`client-rust/` is the in-development native Rust client intended to eventually
replace `client-3d/`, `desktop/`, and `client-tui/`. Until parity is proven and
a product promotion happens, the existing clients remain the supported player
surfaces; `client-rust/` must not be published, linked from the site, or added
to the download ledger.

It is a standalone Cargo workspace, deliberately outside the root Rust
workspace and the pnpm workspace. Root repo gates do not cover it; its own
gates are mandatory for any change under `client-rust/`:

- `make -C client-rust verify` — unit tests, perf regression vs machine
  baseline, stripped-size regression vs machine baseline and absolute ceilings.
- `make -C client-rust check-allocs` — steady-state frame loop must report
  `frame-allocs 0`; any per-frame heap allocation is a gate failure.
- `make -C client-rust runtime-check` — frame-time p50/p99, peak RSS, and
  allocation stats for the standard demo scene vs baseline and ceilings.
- `make -C client-rust nostd` — the engine crates must keep building for
  `thumbv7em-none-eabihf` (no_std purity proof).

Hard budgets (`client-rust/budgets.json` is authoritative):

- stripped wasm <= 2.0 MiB; stripped native binary <= 3.0 MiB;
- zero steady-state heap allocations per frame;
- peak RSS in the standard scene <= 256 MiB;
- frame p99 <= 4.0 ms on the `darwin-arm64-apple-m2-max` class;
- regressions: size +max(16 KiB, 1%), perf +10%, RSS +5% vs the checked-in
  per-machine baseline.

Machine baselines live in `client-rust/bench/baselines/<machine-id>.json` and
change ONLY via `make -C client-rust bench-baseline`, reviewed like code; an
intentional regression ships the new baseline in the same change with a
written justification. No baseline for your machine means capture one first.

Engine rules: `successor-engine-core` and `successor-engine-render` are
`#![no_std]` + `alloc`; no `core::fmt` in shipped paths; platform access only
through `successor-platform`; rendering backends only through the `Gpu` trait.
The wasm FFI import list in `client-rust/source/platform/src/web/` and the JS
shim `client-rust/web/successor.js` must change in lockstep. New dependencies
are weighed against the size gate — wgpu, winit, bevy, tokio, and wasm-bindgen
are explicitly rejected. The wire protocol reuses `crates/successor-net` types;
gameplay authority stays in Rust `successor-sim` — the client renders streamed
state and submits commands, exactly like the existing clients. The ECS carries
a repo-tailored prefab/JSON/asset layer (versioned `schema`/`format`
discriminators, manifest-by-stable-id, `resolveRuntimePublicPath` fail-closed
rules) mirroring how `client-3d`/`client` consume assets.

## Authority boundary

Rust `successor-sim` owns deterministic gameplay: movement, pathing, structure
collision, targeting, combat rolls, damage, life state, inventory, resources,
crafting, professions, farming, NPC behavior, population activation, and
economy mutations. The TypeScript game server owns transport, AOI and packet
shaping, persistence projection, chat, and the Rust bridge. It must not grow a
fallback actor or combat simulation. Clients submit commands and render
streamed state.

Trace player-facing bugs through the whole chain before calling them fixed:
command submission, server receipt, Rust transition/event, AOI delivery, client
projection, and final presentation.

## Assets and presentation

The active presentation library is rooted at:

- `client-3d/public/assets/`
- `client/public/successor-audio/`
- `client/public/successor-slice/`
- `~/dev/games/pawn-forge/pawnforgev2/` on Bunker (source checkout)

Keep GLB source provenance, manifests, sockets, material rules, and runtime
loaders aligned. Preserve authored shaders, effects, weather, crop/flora work,
equipment, world props, and source `.blend` files even when a feature is not
yet surfaced in the default fixture.

Use the PawnForge/Blender workflow for GLB changes and measured visual QA. Do
not treat generated screenshots, build output, or local cache directories as
source assets.

## Handoff requirements

- Regenerate the fixture when its generator changes and verify deterministic
  output.
- Rebuild the Electron package after changes in `client-3d/` or shared runtime
  code: `pnpm desktop:build`.
- Run the focused tests for touched packages, then the repository gates in
  `docs/VERIFICATION.md`.
- For local work, check `http://127.0.0.1:28093/game/status` or the isolated
  authority. For a public claim, check the public pointer, `/healthz`,
  `/readyz`, and `/game/status`, then bind the observation to the exact client
  release and server image in `docs/CURRENT_DEPLOYMENT.md`.
- Record whether a result is source-only, built, published immutably, promoted,
  or verified through a player journey. These are different states.
- Keep canonical docs synchronized with behavior and supported paths.
- Report possible credential exposure without rotating or revoking anything
  unless the user explicitly authorizes that credential action.

The Node workspace is pinned through `packageManager` and
`pnpm-workspace.yaml`. Do not weaken dependency maturity, exotic-source, or
install-script controls without reviewing and documenting the dependency.
