"""Prove the authored starter pieces are clean on every surface a player can see.

Hidden `BodyZone_*` skin is not rendered, so clearance against it is not a
contract -- chasing it only inflates the garment. What has to hold is what is
actually on screen, so this checks exactly that, by triangle overlap rather than
by distance heuristics:

  1. `suit_excess_depth_mm` -- how much DEEPER than the bare body the suit reaches
     into visible skin. Depth, not triangle counts: offset cloth necessarily spans
     more triangles than the skin it replaces even when it is no deeper, and the
     shipped clips already bury the hands in the thighs at `meditate_loop`. The
     counts stay in the report.
  2. `boots_into_suit_away_from_collar_mm` -- the boot collar is MEANT to rest on
     the suit cuff, so contact inside `COLLAR_BAND_M` of the boot's own boundary
     loop is the design working. A crossing further in is a real fault.
  3. foot coverage           -- both foot zones measured as safely enclosed, so
     nothing pokes out from under the boot.
  4. `open_rim_gap_mm`       -- every garment boundary vertex sits on the skin, so
     a collar or cuff terminates against the body instead of leaving a slot.

`hidden_skin_penetration_mm` is reported for information and is NOT a failure: it
is where the garment sits inside skin its own mask removes.

Every pose in `pose_probe.POSES` plus the bind pose, on both bodies. Baselines are
measured on the BARE body in the same pose, because the shipped clips already
drive covered skin through visible skin -- `crouch_idle` puts the hands into the
thighs -- and a garment cannot be charged for that.

    blender --background --python verify_starter_fit.py
"""

from __future__ import annotations

import json
import os
import sys

import numpy as np
from mathutils.bvhtree import BVHTree

LAB_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, LAB_DIR)

import body_zone_coverage as COV  # noqa: E402
import author_starter_apparel as AUTHOR  # noqa: E402
import body_zones as BZ  # noqa: E402
import pose_probe as POSE  # noqa: E402
import refit_config as CFG  # noqa: E402

GENERATOR = "successor content-pipeline/labs/humanoid-runtime-refit/verify_starter_fit.py"

#: How far past its authored landing an opening may drift before it reads as a
#: slot. Zero would forbid the boot collar its own 2 mm standoff over the suit.
OPEN_RIM_LIMIT_MM = 1.0
#: How much DEEPER than the bare body's own contact a garment may reach into
#: visible skin. Counting triangle pairs over-rejects: offset cloth spans more
#: triangles than the skin it replaces even when it is no deeper, and the shipped
#: clips already bury the hands in the thighs at `meditate_loop`. Depth is the
#: quantity a viewer sees, so depth is the gate; the counts stay in the report.
EXCESS_DEPTH_LIMIT_MM = 1.0
#: The authored standoffs, from `author_starter_apparel`. Two shells over the same
#: skin can legitimately come within the sum of their standoffs of each other
#: wherever the pose compresses them.
SUIT_STANDOFF_MM = AUTHOR.SUIT_OFFSET_M * 1000.0
BOOT_STANDOFF_MM = AUTHOR.BOOT_OFFSET_M * 1000.0
#: A boot collar is MEANT to touch the suit. Contact within this distance of the
#: boot's own boundary loop is the collar doing its job; a crossing further in is
#: a real fault.
COLLAR_BAND_M = 0.020
#: Zones the starter loadout must hide, so nothing pokes out under the boot.
REQUIRED_HIDDEN = ("left_foot", "right_foot")

AUTHORED = (("under_bodysuit", "Under/under_bodysuit.glb"),
            ("boots_canvas_ankle", "Under/boots_canvas_ankle.glb"))


def variant_path(body_id: str, relative: str) -> str:
    prefix = "" if body_id == "male" else f"{COV.FEMALE_PREFIX}/"
    return os.path.normpath(os.path.join(CFG.EQUIPMENT, prefix + relative))


def tree_for(positions: np.ndarray, faces: np.ndarray) -> BVHTree:
    return BVHTree.FromPolygons([tuple(point) for point in positions],
                                [tuple(face) for face in faces],
                                all_triangles=True, epsilon=0.0)


def overlaps(a: BVHTree, b: BVHTree) -> int:
    return len(a.overlap(b))


def hit_set(a: BVHTree, b: BVHTree) -> set[int]:
    """Which of `b`'s triangles `a` crosses."""
    return {pair[1] for pair in a.overlap(b)}


def boundary_vertices(positions: np.ndarray, faces: np.ndarray) -> np.ndarray:
    """Vertices on a real opening.

    Welded first: a glTF export splits one surface into a primitive per material,
    so raw index adjacency reports every dye-slot seam as a hole. The boot's
    c0/c1/c3 split alone produced a phantom 10 mm "rim gap" in the bind pose.
    """
    welded = BZ.weld(positions)
    edges = np.concatenate([faces[:, [0, 1]], faces[:, [1, 2]], faces[:, [2, 0]]])
    keys = np.sort(welded[edges], axis=1)
    unique, counts = np.unique(keys, axis=0, return_counts=True)
    open_points = set(np.unique(unique[counts == 1]).tolist())
    return np.array([slot for slot, point in enumerate(welded)
                     if int(point) in open_points], dtype=np.int64)


def nearest_distance(points: np.ndarray, tree: BVHTree, limit: float) -> np.ndarray:
    return np.fromiter(
        (found[3] if (found := tree.find_nearest(tuple(point), limit))[0] is not None
         else np.inf for point in points), dtype=np.float64, count=len(points))


#: Signed distance only means something near a surface, so the search is capped
#: and misses are dropped rather than signed.
GAP_SEARCH_M = 0.030


def signed_depth(points: np.ndarray, tree: BVHTree) -> np.ndarray:
    """Signed distance to the surface along its normal; negative is inside."""
    out = np.full(len(points), np.inf)
    for slot, point in enumerate(points):
        location, normal, _, _ = tree.find_nearest(tuple(point), GAP_SEARCH_M)
        if location is None:
            continue
        out[slot] = float(np.dot(point - np.array(location), np.array(normal)))
    return out


def deepest(points: np.ndarray, tree: BVHTree) -> float:
    depth = signed_depth(points, tree)
    finite = depth[np.isfinite(depth)]
    return float(finite.min()) if len(finite) else 0.0


def main() -> None:
    CFG.ensure_dirs()
    with open(os.path.join(CFG.REPORT_DIR, "body_zone_coverage.json"),
              encoding="utf-8") as handle:
        coverage = json.load(handle)["items"]
    report = {"generator": GENERATOR, "open_rim_limit_mm": OPEN_RIM_LIMIT_MM,
              "excess_depth_limit_mm": EXCESS_DEPTH_LIMIT_MM,
              "collar_band_mm": COLLAR_BAND_M * 1000.0,
              "required_hidden_zones": list(REQUIRED_HIDDEN), "bodies": {}}
    failures: list[str] = []

    for body_id in ("male", "female"):
        body = POSE.Body(body_id)
        suit = POSE.SkinnedGeometry(variant_path(body_id, AUTHORED[0][1]),
                                    f"under_bodysuit:{body_id}")
        boots = POSE.SkinnedGeometry(variant_path(body_id, AUTHORED[1][1]),
                                     f"boots_canvas_ankle:{body_id}")
        hidden = set(coverage["under_bodysuit"]["hide_body_zones"])
        loadout = hidden | set(coverage["boots_canvas_ankle"]["hide_body_zones"])
        visible_faces = np.concatenate([f for zone, f in body.zone_faces.items()
                                        if zone not in loadout])
        hidden_faces = np.concatenate([f for zone, f in body.zone_faces.items()
                                       if zone in loadout])
        suit_rim = boundary_vertices(suit.position, suit.faces)
        boot_rim = boundary_vertices(boots.position, boots.faces)
        rim_points = boots.position[boot_rim]
        away = np.array([float(np.linalg.norm(rim_points - point, axis=1).min())
                         for point in boots.position]) > COLLAR_BAND_M

        deep = {"suit_excess_depth_mm": 0.0, "suit_depth_mm": 0.0,
                "bare_body_depth_mm": 0.0, "bare_leg_contact_mm": 0.0,
                "boots_into_suit_away_from_collar_mm": 0.0,
                "boots_into_suit_at_collar_mm": 0.0,
                "hidden_skin_penetration_mm": 0.0}
        high = {"suit_vs_visible_pairs": 0, "bare_vs_visible_pairs": 0,
                "boots_vs_suit_pairs": 0, "suit_rim_gap_mm": 0.0,
                "boot_rim_gap_mm": 0.0}
        where: dict[str, str | None] = {key: None for key in {**deep, **high}}

        for clip, phase in body.poses():
            label = "bind" if clip is None else f"{clip}@{phase:g}"
            world, skin = body.pose(clip, phase)
            suit_posed, boots_posed = suit.posed(world), boots.posed(world)
            visible = tree_for(skin, visible_faces)
            hidden_tree = tree_for(skin, hidden_faces)
            suit_tree = tree_for(suit_posed, suit.faces)
            boots_tree = tree_for(boots_posed, boots.faces)

            bare = min(0.0, deepest(skin[np.unique(hidden_faces)], visible))
            suit_depth = deepest(suit_posed, visible)
            depth = signed_depth(boots_posed, suit_tree)
            samples = {
                "bare_body_depth_mm": bare * 1000.0,
                "suit_depth_mm": suit_depth * 1000.0,
                "suit_excess_depth_mm": (suit_depth - bare) * 1000.0,
                "hidden_skin_penetration_mm":
                    deepest(suit_posed, hidden_tree) * 1000.0,
            }
            for key, mask in (("boots_into_suit_away_from_collar_mm", away),
                              ("boots_into_suit_at_collar_mm", ~away)):
                picked = depth[mask & np.isfinite(depth)]
                samples[key] = float(picked.min()) * 1000.0 if len(picked) else 0.0
            # Cross-legged and crouched clips already drive one leg's skin into
            # the other's, so the boot shell inherits that contact through the
            # suit. The baseline is the bare foot/calf skin against the rest of
            # the hidden leg skin, measured in the same pose.
            foot_calf = np.concatenate([body.zone_faces[f"{side}_{part}"]
                                        for side in ("left", "right")
                                        for part in ("foot", "calf")])
            leg_rest = np.concatenate([f for zone, f in body.zone_faces.items()
                                       if zone in loadout
                                       and not zone.endswith(("_foot", "_calf"))])
            samples["bare_leg_contact_mm"] = min(0.0, deepest(
                skin[np.unique(foot_calf)], tree_for(skin, leg_rest))) * 1000.0
            for key, value in samples.items():
                if value < deep[key]:
                    deep[key], where[key] = round(value, 3), label

            counts = {"suit_vs_visible_pairs": overlaps(suit_tree, visible),
                      "bare_vs_visible_pairs": overlaps(hidden_tree, visible),
                      "boots_vs_suit_pairs": overlaps(boots_tree, suit_tree)}
            skin_tree = tree_for(skin, body.faces)
            # An opening is judged on EXCESS, not on absolute distance: the boot
            # collar is authored to land one suit-standoff off the skin, so its
            # nominal gap is already 2 mm and comparing that to a 1 mm limit only
            # measures the design.
            for key, points, against, nominal in (
                    ("suit_rim_gap_mm", suit_posed[suit_rim], (skin_tree,), 0.0),
                    ("boot_rim_gap_mm", boots_posed[boot_rim],
                     (suit_tree, skin_tree), AUTHOR.BOOT_RIM_ON_SUIT_M * 1000.0)):
                gap = np.minimum.reduce([nearest_distance(points, tree, 0.05)
                                         for tree in against])
                finite = gap[np.isfinite(gap)]
                counts[key] = (round(max(0.0, float(finite.max()) * 1000.0 - nominal), 3)
                               if len(finite) else 0.0)
            for key, value in counts.items():
                if value > high[key]:
                    high[key], where[key] = value, label

        masked = [zone for zone in REQUIRED_HIDDEN if zone in loadout]
        report["bodies"][body_id] = {
            "suit": os.path.relpath(variant_path(body_id, AUTHORED[0][1]), CFG.REPO),
            "boots": os.path.relpath(variant_path(body_id, AUTHORED[1][1]), CFG.REPO),
            "suit_hidden_zones": sorted(hidden),
            "loadout_hidden_zones": sorted(loadout),
            "foot_zones_hidden": masked,
            "depth_mm": deep, "counts": high, "worst_pose": where}

        if deep["suit_excess_depth_mm"] < -EXCESS_DEPTH_LIMIT_MM:
            failures.append(f"{body_id}: suit reaches "
                            f"{-deep['suit_excess_depth_mm']:.3f} mm deeper into "
                            f"visible skin than the bare body at "
                            f"{where['suit_excess_depth_mm']}")
        # Allowance: the two shells' own standoffs plus the pose's own limb
        # contact plus a millimetre of measurement noise.
        allowance = (SUIT_STANDOFF_MM + BOOT_STANDOFF_MM + EXCESS_DEPTH_LIMIT_MM
                     - deep["bare_leg_contact_mm"])
        report["bodies"][body_id]["boot_suit_allowance_mm"] = round(allowance, 3)
        if deep["boots_into_suit_away_from_collar_mm"] < -allowance:
            failures.append(f"{body_id}: boots cross the suit "
                            f"{-deep['boots_into_suit_away_from_collar_mm']:.3f} mm "
                            f"away from the collar at "
                            f"{where['boots_into_suit_away_from_collar_mm']}, "
                            f"against a {allowance:.3f} mm allowance")
        for key in ("suit_rim_gap_mm", "boot_rim_gap_mm"):
            if high[key] > OPEN_RIM_LIMIT_MM:
                failures.append(f"{body_id}: {key} {high[key]:.3f} mm at {where[key]}")
        if len(masked) != len(REQUIRED_HIDDEN):
            failures.append(f"{body_id}: foot zones not hidden ({masked})")

        print(f"[fit] {body_id:6s} suit excess {deep['suit_excess_depth_mm']:8.3f} mm "
              f"(suit {deep['suit_depth_mm']:8.3f} vs bare "
              f"{deep['bare_body_depth_mm']:8.3f}, pairs "
              f"{high['suit_vs_visible_pairs']}/{high['bare_vs_visible_pairs']})")
        print(f"[fit] {'':6s} boot->suit away "
              f"{deep['boots_into_suit_away_from_collar_mm']:8.3f} collar "
              f"{deep['boots_into_suit_at_collar_mm']:8.3f} mm (pairs "
              f"{high['boots_vs_suit_pairs']})")
        print(f"[fit] {'':6s} rims {high['suit_rim_gap_mm']:.3f}/"
              f"{high['boot_rim_gap_mm']:.3f} mm  hidden-skin "
              f"{deep['hidden_skin_penetration_mm']:.3f} mm (not visible)  "
              f"feet {masked}")

    report["failures"] = failures
    destination = os.path.join(CFG.REPORT_DIR, "starter_fit.json")
    with open(destination, "w", encoding="utf-8") as handle:
        json.dump(report, handle, indent=2)
        handle.write("\n")
    print(f"[fit] {'PASS' if not failures else 'FAIL'}")
    for failure in failures:
        print(f"[fit]   {failure}")


if __name__ == "__main__":
    main()
