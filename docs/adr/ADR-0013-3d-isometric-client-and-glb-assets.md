# ADR-0013: Three.js Isometric Client and GLB Assets

Status: accepted and fully adopted.

## Decision

Successor's graphical client is `client-3d/`: a Three.js client with a locked
orthographic isometric camera, GLB actors and props, streamed terrain, authored
shaders/effects, and a custom low-resolution post stack.

Renderer-neutral connection, command, projection, targeting, interaction, and
combat-event code belongs in `client/`. The graphical client consumes those
contracts without owning gameplay state. `client-tui/` consumes the same shared
runtime without importing graphics or browser APIs.

Humanoid source assets come from PawnForge. Runtime assets use stable manifests,
socket metadata, measured bounds, and GLB paths. The generated world bundle
contains logical world data, not render frames or atlas coordinates.

## Consequences

- New graphical presentation work goes through Three.js and GLB/code-native
  effects.
- There is one graphical client and one renderer-neutral map contract.
- Desktop releases package `client-3d/`.
- Asset promotion requires in-camera, in-post verification rather than a clean
  authoring-viewport judgment alone.
- Presentation may interpolate and animate authoritative events but cannot own
  movement, combat, inventory, or lifecycle outcomes.
