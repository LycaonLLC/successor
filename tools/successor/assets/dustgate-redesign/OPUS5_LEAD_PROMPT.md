# Opus-5 Lead Task: Rebuild the Starting Settlement From Zero

You are the lead 3-D environment designer and technical artist for a from-zero
Dustgate redesign study in Successor.

Read `AGENTS.md` and the canonical documents it routes to. Then read
`docs/DUSTGATE_OPUS5_REDESIGN_BRIEF.md` completely. Treat that redesign brief
as the task contract and do the work, not merely an analysis of how somebody
else could do it.

Important:

- This is a clean creative reset. Do not open or use the old facility/house
  GLBs, old renders, or old source geometry. Do not imitate their style.
- Work on the Mac in this clean linked worktree with the installed Blender
  4.5 LTS CLI.
- Build the three direction studies, inspect them, choose the strongest, and
  continue autonomously into a coherent selected layout/blockout.
- Treat the settlement view as an assembly and validation surface, not the
  authored asset. Clone, commerce, and shelter must each remain independently
  placeable/exportable units with local origins and functional contracts.
- Preserve the existing promoted player, customization, clothing, equipment,
  and item assets. They are required compatibility/runtime-proof inputs, not
  environment style references.
- Inspect the existing promoted and source-library world items before
  authoring props. Reuse strong real items as independent instances, never as
  geometry baked into a building. Read and update
  `EXISTING_WORLD_ITEM_AUDIT.md`; manifest pass status is not visual proof.
- Model functional openings, not facade theater: every enterable unit needs
  the real renderer's independently addressable `door_slide`, floor,
  interior-keep, wall, roof, and cutaway families, with measured door travel,
  threshold clearance, and closed collision blocker.
- Treat `Dustgate` as a legacy working label. Produce and select a stronger
  resident-credible display name under the naming contract in the brief, but
  do not rename fixture ids or runtime paths in this source-stage lane.
- Use deterministic Blender Python and preserve editable source. Keep
  generated binary and proof output in the ignored proof root named in the
  brief.
- Do not mutate the active fixture, current runtime assets, canonical ids,
  gameplay authority, existing renderers, credentials, remotes, or unrelated
  work.
- Do not use OMP task/subagents for this lead milestone. Own the creative
  synthesis yourself so the shared direction is genuinely coherent.
- You may install ordinary local, non-account-bound tooling if needed. Do not
  make purchases, create accounts, or alter credentials.
- Do not stop to ask for aesthetic selection. Use renders, normal gameplay
  framing, measurements, and close crops to select and improve the strongest
  direction.

Use a todo list and execute the full first milestone. Run at least two
inspection/iteration passes after selecting a direction. Before reporting:

1. run the focused builder/QA commands;
2. export a fresh review GLB;
3. run `npx --yes @gltf-transform/cli inspect` and `validate`;
4. inspect the wide proof and required close crops;
5. read back the final layout and geometry measurements;
6. run `git diff --check` and list exactly which source files changed.

Your final response should lead with what you actually made and the proof
paths. State what still remains source-stage and what a later building/interior
production pass should do next.
