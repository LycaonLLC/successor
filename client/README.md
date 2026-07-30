# Successor Shared Client Runtime

`client/` is the renderer-neutral client package used by the graphical and
terminal clients. It is not a player-facing visual client.

It owns:

- connection, room, chat, and runtime defaults;
- command construction and authoritative state projection;
- targeting, interaction, inventory, progression, combat-event, audio-id, and
  world-query rules shared by both clients;
- headless hosts and helpers used by journeys and load tools;
- presentation data that does not depend on DOM, Three.js, or terminal layout.

Graphical rendering and browser UI belong in `../client-3d/`. Terminal layout,
input, and prose belong in `../client-tui/`.

## Checks

```bash
pnpm --dir client build
pnpm --dir client test
pnpm check:zero-gpu
```

Runtime endpoint defaults live in `src/runtime/runtimeDefaults.json`. Product
topology and full verification commands live in
`../docs/CANONICAL_CONTEXT.md` and `../docs/VERIFICATION.md`.
