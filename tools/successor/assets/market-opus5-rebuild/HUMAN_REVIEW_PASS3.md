# Human review gate after the scheme-E package

The scheme-E exterior is a viable refinement base. The package is not accepted
as a final asset. Automated verification passed, but the final images expose
functional and visual failures that the self-critique and report missed.

Do not restart concept exploration and do not merely reframe the cameras.
Correct the source geometry, furnishing, materials, collision, and proofs.

## Hard functional failures

1. **All three required terminals face backward.**
   `09_interior_eye_hall.png` and `15_crop_service_counter.png` show service
   backs, vents, and access panels to the customer. Each terminal manifest says
   its interaction face is asset-local `+Z`. Blender's glTF import maps that
   interaction face toward authoring `-Y` before yaw, so the current `180`
   degree placements reverse it. Determine the transform from the imported
   geometry rather than trusting prose, then make the screens and controls face
   the public hall/customer approach. Preserve the exact fixture centres and
   at least 0.8 m of reachable front clearance.

2. **The rear service entrance and BOH circulation are obstructed.**
   `26_crop_rear_service_door.png` shows the authored cylindrical tank directly
   inside the rear doorway. The original `23` view also showed the vessel
   dominating the aisle. Reframing the camera does not repair circulation.
   Relocate or redesign it and prove a continuous, collision-free staff route
   at least 0.90 m wide from the rear entrance through the BOH aisle and to the
   rear of all three service fixtures. Add a sampled path/width assertion to
   `src/verify.py`; checking only named cells and camera origins is insufficient.

3. **The trainer consultation spot is cramped and visually blocked.**
   `22_interior_eye_trainer.png` is mostly an occluding partition. Rebuild the
   booth so two chairs, the trainer fixture/cell, and an approach are legible
   and usable without intersection. Prove seated and standing clearances.

4. **Collision verification omits the failure modes above.**
   Extend the authored sidecar/checks so terminal orientation, rear-door
   approach, BOH path continuity, trainer approach, and imported loose-prop
   footprints are tested. A `76/76` result is not meaningful if these cases are
   absent.

## Hard visual failures

5. **The building has open black corner voids.**
   `03_left.png`, `04_right.png`, and `16_crop_uv_seam_corner.png` expose tall
   black gaps where side/front/rear systems fail to close. Seal the envelope or
   model a deliberate recessed joint with visible backing, flashing, drainage,
   and believable depth. No camera-visible void may read as missing geometry.

6. **The focal arch is under-resolved at inspection distance.**
   `13_crop_facade_hood.png` exposes obvious faceting in the curved hood and
   ring. Increase radial resolution, correct smoothing/normals, and refine its
   junctions, glazing frame, track, soffit, drainage, and wall penetration.
   This is the identity element and must survive a close crop.

7. **The material system still reads as uniform procedural grain.**
   `14_crop_floor_wall_contact.png`, `16`, and `20` show sponge-like noise
   repeated across screed/sinter surfaces. Reduce high-frequency grain,
   establish distinct material scale and response, and put dust, abrasion,
   runoff, contact darkening, and edge damage only where construction and use
   cause them. The restrained palette may remain, but brass trim must not read
   like noisy wood.

8. **The interior is sparse and generic.**
   The vendor shelves are nearly empty, the central hall has large dead wall
   fields, and the three service niches differ mostly by imported terminal
   silhouette. Add purposeful built-ins and a small, curated assortment of
   approved loose world items where useful. Create non-repeating service
   identities through lighting, backing, privacy/inspection/registry hardware,
   queue behavior, storage, and customer affordances—not fake text or glyph
   soup. Keep circulation clear.

9. **Side and rear elevations remain under-composed.**
   Preserve the functional water/plant logic, but give blank side walls,
   openings, base transitions, roof edges, and the rear loading/service zone
   convincing construction depth. Simplify rooftop clutter where it competes
   with the entry; detail must reveal systems rather than accumulate boxes.

10. **Several proof views do not prove their subject.**
    `20_crop_loggia.png` does not show the claimed coffers;
    `24_interior_clerestory.png` does not clearly show the clerestory;
    `27_crop_clerestory_brise.png` mostly shows plant and a dark slot.
    Correct the asset first, then place collision-safe cameras that visibly
    demonstrate the named feature. Add explicit customer-facing close views of
    all three terminal interaction surfaces, an unobstructed rear-door/BOH
    route, and an unoccluded trainer consultation view.

## Naming and invariant constraints

- Remove `Dustgate` from new source/design/report prose. Michael rejected that
  name. Use `Valley Market` as the asset name and refer generically to the
  settlement until a separate place name is chosen.
- Keep the current authority grid, exact zero-based fixture centres, footprint,
  floor elevation, cutaway prefixes, door node/clips/travel, LOD budgets, and
  deterministic generator.
- No roads, asphalt, road markings, or wheeled-traffic language.
- Do not inspect or reuse forbidden prior commerce buildings or their art.

## Acceptance evidence

Produce a moderate diagnostic pass before expensive final renders. Inspect it
visually and make at least one further source correction. The final evidence
must include:

- customer-facing screen/control close views for bank, trade, and association;
- rear entrance through BOH route, with measured minimum width;
- trainer spot showing both seats, fixture, and approach;
- sealed exterior corners in side and close views;
- smooth/refined hood close-up;
- vendor/service interiors with authored differentiation;
- clerestory and loggia views that actually show those systems;
- closed/open door states plus the existing loader/animation proof.

Update `REPORT.md` to distinguish automated checks from human visual
acceptance and remove claims contradicted by the evidence.
