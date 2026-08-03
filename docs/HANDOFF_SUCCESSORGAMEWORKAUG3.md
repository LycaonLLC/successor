# Successor game work handoff — 2026-08-03

Status: development-source handoff. This note does not override
`CANONICAL_CONTEXT.md`, `CURRENT_PROJECT_STATE.md`, `CURRENT_DEPLOYMENT.md`, or
`VERIFICATION.md`.

OMP session name: `SUCCESSORGAMEWORKAUG3`.

## Resume point

- Development branch: `dev/rust-client`
- Integrated source tip before this documentation-only handoff commit:
  `d72692bc8c2a2683ea5321189c31b0f6cb1a12bc`
- Review surface: <https://github.com/LycaonLLC/successor/pull/15>
- PR base: `main`
- PR state at handoff: open, cleanly mergeable, with all five required GitHub
  checks passing
- `main` was not merged or deployed as part of this work

The integration landmarks immediately below the handoff commit are:

- `d72692bc` — hydrate tested LFS assets in CI
- `f2f040bd` — stabilize CI integration and record humanoid source provenance
- `2c486e51` — reconcile concurrent `dev/rust-client` changes
- `b1cdd622` — support macOS durability locks and refresh runtime gates
- `c0cdb35a` — integrate the native client, redesigned world, and humanoid assets

## Integrated work

The branch combines the previously parallel development lanes:

- streamed and skinned GLB rendering in the Rust client;
- routed movement, cutaways, doors, interiors, and current-world presentation;
- the 1,024-cell desert/forest fixture, sparse population, safe starting region,
  Dustgate facilities, travel, and authority parity;
- modular runtime buildings, collision sidecars, and LFS-backed building assets;
- canonical male and female PawnForge bodies, creator/body persistence, fitted
  wardrobe assets, runtime animation, and production packaging;
- portable desktop durability locking and packaged verification on macOS; and
- CI, provenance, LFS hydration, and cross-platform test repairs needed by the
  combined branch.

Read the canonical and current-state documents for exact active contracts. Do
not treat this summary as a new runtime specification.

## Asset availability

All Git LFS objects reachable from the branch were published to GitHub:

- 2,979 objects processed;
- approximately 1.1 GB of LFS content;
- a fresh HTTPS clone of `dev/rust-client` completed `git lfs pull`; and
- the independent checkout returned `Git LFS fsck OK` at `d72692bc`.

A collaborator with repository access and Git LFS installed can start with:

```bash
git clone --branch dev/rust-client https://github.com/LycaonLLC/successor.git
cd successor
git lfs pull
pnpm install --frozen-lockfile
```

For an existing checkout:

```bash
git fetch origin
git switch dev/rust-client
git pull --ff-only
git lfs pull
```

Do not use ignored lab build directories as source assets. Versioned runtime
assets and source manifests are the repository contract.

## Verification recorded at the integration tip

GitHub Actions passed on `d72692bc`:

- `denylist gate`
- `cargo test`
- `cargo test (wasm)`
- `pnpm test`
- `provenance audit`

Focused local proof also passed for the promoted male/female boot fit contract,
humanoid source provenance, desktop packaging/runtime, shared-client tests, and
a clean fresh-clone LFS integrity check.

Before handing off any further source change, follow `VERIFICATION.md` and run:

```bash
pnpm run ci
pnpm hygiene:rust
```

Changes under `client-3d/` or shared `client/src/` also require:

```bash
pnpm desktop:build
```

## Publication state

Keep these states separate:

- **Source published:** yes, on `origin/dev/rust-client`.
- **LFS assets published:** yes, and fetched from a fresh clone.
- **Branch CI:** green at the integration tip.
- **Merged to `main`:** no.
- **Promoted to the public game:** no claim.
- **Authenticated public player journey for this branch:** no claim.

Use `CURRENT_DEPLOYMENT.md` and direct endpoint observation for public-release
identity. A newer development branch does not prove a deployment.

## Next safe actions

1. Fetch `dev/rust-client` and run `git lfs pull` before inspecting visuals or
   running asset-dependent tests.
2. Recheck the PR head and CI because another developer may have advanced the
   branch after this note.
3. Continue work from the branch tip; do not recreate the former worktree farm
   or import ignored generated builds.
4. Run focused checks while iterating, then the repository gates above.
5. Treat a merge to `main`, beta/stable pointer promotion, authority restart,
   or public deployment as a separate explicitly authorized operation.
