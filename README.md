# Successor

Successor is a server-authoritative multiplayer game with two supported clients:
the Three.js game client and a terminal client. Both consume the same streamed
world state and submit the same command vocabulary to the same authority.

The canonical Bunker checkout is `~/dev/games/successor`. Start with
[`docs/CANONICAL_CONTEXT.md`](docs/CANONICAL_CONTEXT.md). It defines the active
architecture and scope. [`docs/CURRENT_PROJECT_STATE.md`](docs/CURRENT_PROJECT_STATE.md)
records the implementation snapshot,
[`docs/CURRENT_DEPLOYMENT.md`](docs/CURRENT_DEPLOYMENT.md) records the exact
public release identities, and [`docs/VERIFICATION.md`](docs/VERIFICATION.md)
owns the commands used to prove them.

## Public alpha

- Site, account, browser play, and downloads:
  `https://www.successorgame.com`
- Public authority health and readiness:
  `https://world.successorgame.com`

The browser alpha and AWS authority are public and stateful. The marketing
site, browser client pointer, server image, and native download manifest have
separate release identities; do not summarize them with one branch name.
`docs/CURRENT_DEPLOYMENT.md` is the current release ledger.

## Repository map

```text
client-3d/       Three.js client, HUD, shaders, effects, weather, and GLB loaders
client-tui/      terminal client and terminal journeys
client/          renderer-neutral protocol, state projection, commands, and headless host
desktop/         Electron distribution of client-3d
site/            marketing, account, connect, browser-launch, and download shell
server/          network edge, rooms, persistence projection, chat, and Rust bridge
crates/          deterministic Rust simulation, net types, inventory, and WASM bindings
ops/deploy/      AWS infrastructure, publication, and single-writer operator contracts
tools/           fixture compiler, verification harnesses, code generation, and audits
docs/            current product and engineering contracts
```

`client/` is a shared runtime package. It is not a separately supported visual
client. PawnForge source work lives in the neighboring checkout at
`~/dev/games/pawn-forge/pawnforgev2` on Bunker.

Retained proposals live in [`docs/future/`](docs/future/README.md). They are
future design briefs, not implementation or release claims.

## Local development

Install and build from the repo root:

```bash
pnpm install --frozen-lockfile
pnpm build
```

Regenerate the checked-in open-desert fixture, then start the persistent local
authority and the 3D client:

```bash
node tools/successor/configure-open-desert-fixture.mjs
pnpm server:local:persistent
pnpm --dir client-3d dev
```

The defaults are:

- authority: `http://127.0.0.1:28093`
- 3D client: `http://127.0.0.1:5179/`
- fixture: `client/public/successor-slice/open-desert-slice.json`
- map bundle: `client/public/successor-slice/open-desert-map-bundle.json`

Confirm the authority identity before judging a play session:

```bash
curl -fsS http://127.0.0.1:28093/game/status
```

Run the terminal client against the same authority:

```bash
pnpm --dir client-tui build
node client-tui/dist/cli.js
```

Run `node client-tui/dist/cli.js --help` for identity, spawn, chat, and plain-mode
options.

## Desktop build

The Electron shell packages the built 3D client and launches an isolated local
authority. Changes under `client-3d/` or `client/src/` require a fresh desktop
build:

```bash
pnpm desktop:build
pnpm desktop:smoke
```

The local desktop shortcut runs `desktop/scripts/launch-desktop.sh`.

## Core rules

- Rust owns authoritative movement, collision, combat resolution, life state,
  NPC behavior, inventory mutations, resources, crafting, professions,
  farming, and economy events.
- The TypeScript server owns transport, connection policy, AOI filtering,
  packet shaping, persistence projection, chat, and the Rust process bridge;
  it does not run a parallel gameplay simulation.
- Clients own input and presentation. They do not create gameplay truth.
- The checked-in open-desert slice and its compiled map bundle are the only
  default world fixture.
- GLB actors, creatures, equipment, crops, props, shaders, post effects, and
  audio in the active asset roots are the supported presentation library.

## Verification

The normal repository gates are:

```bash
pnpm run ci
pnpm hygiene:rust
```

For focused work, use the matrix in [`docs/VERIFICATION.md`](docs/VERIFICATION.md).

## License

Source code and documentation are MIT licensed; see [`LICENSE`](LICENSE).
Game assets are not covered by that blanket grant. See
[`ASSET_LICENSE.md`](ASSET_LICENSE.md) and the provenance records beside
individual assets.
