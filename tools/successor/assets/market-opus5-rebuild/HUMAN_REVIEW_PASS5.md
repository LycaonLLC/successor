# Human review — pass 5

Status: **pass-4 functional work accepted; whole-building art finish rejected.**

Preserve the pass-4 functional baseline:

- fixture cells and customer-facing terminal orientation;
- the animated sliding-door node, clips, travel, and walk-through clearance;
- the collision sidecar, LOD budgets, strict glTF validity, and Three.js loader
  proof;
- the continuous rear entrance → BOH → rear-of-terminal service routes;
- trainer seats, standing approach, sightline, and fixture cell;
- sealed envelope openings and imported-prop provenance;
- the revised physical daylight section, standing-eye aperture, load path, and
  drainage story;
- the lower-corner construction and its separate geometric diagnostics.

`VERIFY_ALL_OK` is not visual acceptance. The canonical pass-4 images in
`proofs/final/` were inspected at 1100 px. The failures below are authoritative.

## 1. Redesign the side elevations as complete pieces of architecture

`03_left` and `04_right` still devote most of each lower elevation to one
uninterrupted gray rectangle. Pass 4 added functions at the rear edge, but it
did not compose the whole flank. In both images the roof remains visually busy
while roughly the middle half of the occupied wall is dead.

- Work across each **whole elevation**, not only inside the tight service
  crops.
- Establish a small number of large, hierarchical moves with real depth:
  recessed service/loading bays, returned structural masses, a protected
  utility court, shade or canopy, usable access, material changes at genuine
  construction joints, or another market-specific response.
- Let west remain goods/structure and east remain water/plant, but make those
  uses legible at human scale.
- The two sides must not mirror one another.
- Do not substitute barcode seams, rows of identical vents, stamped panels,
  decorative pipe spaghetti, or generic sci-fi greebles for architecture.
- Remain inside the 11.40 × 8.55 m footprint, preserve the interior functions,
  keep all punched openings closed by real assemblies, and preserve the
  universe's **no roads** constraint.

The acceptance images are the orthographic whole-side views. A close crop of a
small repaired area cannot hide a blank elevation around it.

## 2. Replace the toy-like west goods assembly with a usable transfer point

`41_west_flank_service` reads as a narrow blind window with a featureless gray
infill and some trim. It does not read as a shuttered goods hatch that can move
stock into the vendor line. The adjacent downpipe and oversized buttress do not
form a coherent loading condition.

- Give the hatch a credible human/stock-handling size, recess, frame, shutter
  construction, hardware, weather protection, and working ledge or counter.
- Make the route and relationship to the vendor/service side understandable.
- Resolve the buttress, hatch, drain, wall returns, and ground condition
  together instead of placing independent objects on a flat wall.
- Keep the drainage causal and preserve a clear usable approach.
- It need not become a second public entrance, but it must look operable.

## 3. Recompose the east water/plant bay so its parts do not collide

In `42_east_flank_service`, the isolator cabinet visually overlaps the BOH
window and its sill, the standpipe reads as a long brass bar with a tiny spout,
and the supposed trough reads as a strip at grade rather than a basin someone
could draw water into. The assembly looks attached after the wall was finished.

- Design one integrated utility bay in which the window, water point, cabinet,
  conduit source, drainage, and structural returns have deliberate clearances.
- Do not cover or visually crash through a window assembly.
- Make the standpipe's feed, valve, spout, receiving basin/trough, splash/drain
  condition, and standing use position credible.
- Give service access to the isolator without blocking the water-user approach.
- Use restrained, physically supported pipe/conduit routes rather than
  decorative vertical lines.

Add geometric/use-clearance checks for both flank functions where sensible,
but do not reduce the problem to a collision-only claim: the final images must
look physically authored as one construction.

## 4. Refine the facade focal insert; it currently reads as a fan

Pass 4 correctly removed the black low-sided puck and exposed the previously
buried roundel. `40_crop_keystone` now shows the result clearly, and it reads as
a four-blade ventilation fan or steering wheel mounted on a very large textured
gold slab. Visibility is fixed; design is not.

- Replace the fan-like four-spoke silhouette with a restrained, deliberate,
  non-textual market identity or optical focal detail.
- Integrate it into the arch/keystone construction instead of making it look
  like an appliance stuck to a rectangular plate.
- Reconsider the oversized slab, boss proportions, rim thickness, lamp
  intensity, depth stack, and edge hierarchy.
- Preserve smooth radial geometry, readable depth, the no-invented-name rule,
  and the build guard against buried visible parts.
- It must remain readable at normal gameplay distance as well as in the close
  view.

## 5. Fix the rendered orange-peel material family, not only base colour

Removing the minimum albedo-noise floor was correct. Nevertheless,
`46_crop_material_family` still shows a conspicuous, evenly distributed
wrinkled/orange-peel normal response over large mineral surfaces. The counter
mass and adjacent wall panels remain visually too similar, and the effect
repeats uniformly rather than responding to material, fabrication, scale, or
wear.

- Judge the **rendered response**, not just each texture's base-colour
  high-frequency score.
- Reduce or redesign normal/roughness amplitude and frequency wherever it makes
  plaster, ceramic, sinter, and screed look like one procedural surface.
- Sinter may retain visible aggregate, but it needs aggregate structure at a
  credible scale rather than a uniform embossed squiggle.
- Plaster should be substantially quieter; ceramic should read through panel
  precision, edge/seam treatment, value, and glaze response; metals should use
  restrained directional machining/brush response.
- Preserve sparse causal wear and real construction joints. Do not hide the
  issue with blur, low samples, darkness, or a distant camera.
- Render a well-lit material comparison in which at least sinter, ceramic,
  plaster, screed, steel, and brass can be distinguished without filenames.

Do not optimize a single global image-frequency number. If adding metrics, use
material-specific response, scale, correlation, and amplitude checks that
cannot reward replacing one ubiquitous noise field with another.

## 6. Make the canonical daylight proof visually prove daylight

The rebuilt daylight section is accepted as physical work: the aperture is
clear from normal standing stations and the BOH measured 3.25× brighter with
sun/sky than with authored emissives alone. Do not undo it.

The canonical presentation still fails:

- `24_interior_clerestory` looks down a narrow corridor and does not visibly
  identify glazing or sky. Its obvious bright rectangle is the rear wall
  window, so the filename is doing the explanatory work.
- `43_interior_eye_transom` reads as a continuous electric strip light above
  the terminals; mullions, glass, exterior light, and section depth are not
  legible.

- Keep the primary camera at a plausible standing eye height.
- Show real glazing/aperture and the room or wall it illuminates in the same
  architectural context. A normal eye may look upward; it may not be raised to
  an inspection platform.
- Make glazing, framing, transom bays, and the exterior source visually
  distinguishable from authored luminaires.
- If geometry/material/framing still prevents legibility, refine the actual
  construction. Camera changes alone are insufficient when the feature itself
  still reads incorrectly.
- Retain the A/B/C daylight measurement and standing-eye ray proof.

## 7. Proof the full correction honestly

- Moderate diagnostics must include `03_left`, `04_right`, both complete flank
  service constructions, the focal insert at close and gameplay distance, the
  material comparison, a normal-eye daylight view, and pitched gameplay.
- Include whole-side views before accepting tight crops.
- Inspect the rendered pixels at native resolution and name at least one defect
  discovered only after rendering.
- Make a further **source** correction in response to that inspection.
- Keep cameras outside collision and free of clipping.
- Rebuild every deliverable from one revision, run strict glTF validation and
  the real Three.js loader proof, then render exactly one canonical final set
  from that shipped build.
- Update `DESIGN.md` and `REPORT.md` candidly. Do not describe a fixture or
  elevation more favourably than its image supports.

## Required order

1. Measure and inspect the complete side elevations, service-assembly
   relationships, focal insert, rendered material response, and canonical
   daylight views.
2. The first substantive mutations must change flank architecture/service
   composition, focal geometry, and material response—not cameras, prose,
   verifier thresholds, or exposure.
3. Build and render a moderate diagnostic set.
4. Inspect native pixels, document a newly exposed defect, and correct source
   again.
5. Rebuild source textures, every GLB/LOD/furnished package, collision,
   manifests, diagnostics, and loader/validator evidence from one revision.
6. Extend verification for the revised functional assemblies without weakening
   any accepted pass-4 contract.
7. Render one current canonical proof set and report remaining compromises
   honestly.

Substantial geometry changes are allowed. Preserve what pass 4 proved; do not
protect what pass 4 merely asserted about its visual quality.
