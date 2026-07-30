# Successor content pipeline

This directory contains the 3D-era schemas for authored-asset manifests. They
cover models and editable model sources, materials, textures, shaders, visual
effects, UI icons, animation, and audio. The shipping asset roots are owned by
the 3D client:

- `client-3d/public/assets/` — GLB models, materials, world props, equipment,
  creatures, and their manifests
- `client-3d/src/render/` — terrain, flora, weather, shader, lighting, and FX
  implementations
- `client/public/successor-audio/` — runtime audio and its manifest

The retired sprite, tileset, atlas, and 2D VFX pipeline is not part of
Successor. Do not recreate those directories or add a browser-world renderer to
the shared `client` package.

## Promotion contract

1. Keep editable source material outside runtime asset roots until it is ready
   to promote.
2. Export runtime geometry as GLB and use deterministic, stable asset IDs.
3. Record provenance, source hash, scale, orientation, sockets, materials, and
   any license constraints in the nearest manifest.
4. Verify the asset in the 3D viewer and in the real game scene. Equipment also
   needs attachment, stow, motion, and silhouette checks.
5. Promote only runtime files and durable metadata. Screenshots, temporary
   renders, caches, and generated proof runs stay untracked.
6. Run the relevant catalog, manifest, build, and 3D journey checks before
   committing.

## Runtime boundaries

- Rust owns deterministic simulation and authoritative game outcomes.
- The shared TypeScript client owns renderer-neutral protocol and presentation
  state.
- The 3D client owns WebGL, Canvas overlay drawing, shaders, particles, model
  loading, and all headed visual behavior.
- The TUI owns terminal presentation and must remain DOM/GPU-free.

See `docs/ASSET_PIPELINE.md`, `docs/ASSET_PROVENANCE_POLICY.md`, and
`docs/ART_DIRECTION.md` for the current detailed contracts.
