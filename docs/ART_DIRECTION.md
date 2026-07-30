# Successor Art Direction

Status: active graphical-client art contract. See `ASSET_PIPELINE.md` for the
promotion workflow and `CANONICAL_CONTEXT.md` for product scope.

## World premise

Small, practical settlements survive among structures built at a scale and age
their inhabitants cannot reproduce. Human work is welded, patched, wrapped,
portable, and visibly maintained. Ancient work is monolithic, battered, sparse,
and large enough to shape travel. The contrast between those scales is the
world's main visual signature.

The world is broad and lightly occupied. Landmarks, encounters, and inhabited
sites earn detail; empty travel space supplies distance and anticipation.

## Binding principles

1. **Silhouette first.** The camera and post stack remove small detail. A model
   must read at normal play scale before surface detail matters.
2. **Keep the two scales distinct.** Human structures are assembled from parts
   a person could move. Ancient structures are masses that make a pawn look
   small.
3. **Judge through the game camera.** A clean Blender render is diagnostic, not
   the final look.
4. **Wear has a cause.** Use value shifts, repairs, chipped outlines, settling,
   and mismatched replacement parts. Avoid decorative noise.
5. **Function should be visible.** Doors, tools, storage, extraction equipment,
   weapons, farms, and medical objects should explain their use through form.
6. **One strong read per object.** A prop or item gets one primary silhouette,
   one material family, and at most one functional accent.

## Renderer constraints

Verify exact values in code before authoring:

| Constraint | Source |
| --- | --- |
| Orthographic isometric camera and zoom | `client-3d/src/render/camera.ts` |
| World scale and pawn constants | `client-3d/src/config.ts` |
| Low-resolution grade, posterization, dither, dust, bloom, and heat treatment | `client-3d/src/render/post.ts` |
| Time-of-day shadow and grade | `client-3d/src/render/environment/` |
| Prop material conversion and instancing | `client-3d/src/render/props.ts` |
| Pawn/equipment materials and sockets | `client-3d/src/render/pawns.ts` and `assets/pawnPack.ts` |

Practical consequences:

- Separate adjacent faces by value, not subtle hue.
- Prefer bevels, facets, and readable planes to engraving.
- Do not bake directional light into albedo.
- Treat roofs and the two camera-facing sides as primary surfaces.
- Give every ground object a convincing contact band, base, or footprint.
- Test transparency, emissive accents, and fine lines after the full post chain.

## Scale language

### Human-scale construction

Use corrugated panels, angle frames, cast shells, canvas, cable runs, patch
plates, skids, blocks, and pocket doors. Doors and interiors use human
proportions. Roof pitch, frame, overhang, and repairs should carry the read.

Buildings are authored for open-world interiors. Mesh nodes separate roof,
camera-facing walls, far walls, floor, interior, and doors so the runtime can
cut away the correct surfaces. Door pivots and collision metadata must match
the authority geometry.

### Monument construction

Use battered walls, deep reveals, large value bands, repeated bays, buried
bases, broken silhouettes, and sparse landmark placement. Build large forms
from instancing-friendly modules. Multi-screen structures are assemblies of
parts, not one always-drawn hero mesh.

Ancient work does not use contemporary signage, exposed cabling, convenient
panel seams, or familiar faction decoration.

## Character and equipment language

PawnForge humanoids are compact, readable, and equipment-led. Clothing and
armor use a small tint palette with clear value separation. Hair, headwear,
weapons, and carried gear must survive motion, camera rotation, stow/draw
changes, and the paper-doll view.

Weapons are tools before ornaments. Their bore, grip, striking edge, energy
source, and carried orientation should be obvious. Muzzle and blade effects
support the model's silhouette instead of replacing it.

## Creature language

Gaia wildlife should feel native to its biome and readable by gait and body
mass. Each species needs a distinct side and three-quarter silhouette, clear
ground contact, and animation that communicates calm roaming, alarm, flight,
damage, and death. Color supports species recognition but cannot be the only
difference.

## Farming and items

Crop stages must read in sequence from planted to establishing, laden, and
husk. Produce, seed cassettes, ingredients, dishes, tools, and additives use
their real containers and shapes rather than interchangeable cards.

Inventory models are judged in the lit turntable as well as the world. Resource
containers use standardized polygonal forms and monochrome semantic glyphs;
they do not need unique hero geometry for every rolled resource identity.

## Effects and weather

Effects are brief, localized, and event-driven. Favor a few strong particles,
beams, rings, tracers, shield surfaces, and color changes over continuous screen
noise. Outcome effects must follow streamed authority events.

Weather should alter atmosphere, visibility, motion, and sound without hiding
interaction cues or target feedback. Time-of-day grade, fog, terrain, shadows,
and ambience should agree.

## UI relationship

The world is muted and material; the UI is a compact instrument layer. Use
oxide, bone, dark metal, restrained phosphor/amber signals, square geometry,
short labels, and strong state changes. Avoid large decorative chrome and
persistent tutorial prose.

## Review frame

Review promoted art in this order:

1. silhouette at minimum and normal zoom;
2. scale beside a pawn and neighboring world objects;
3. material/value separation after post;
4. contact, pivot, socket, and animation behavior;
5. interaction/nameplate/UI readability;
6. performance with realistic instance counts.
