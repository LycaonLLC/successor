"""Prove every hair piece actually sits on the head, on BOTH bodies.

`verify_starter_fit` covers the two authored starter garments. Hair is a
different failure mode and nothing gated it: a hair cap either

  1. FLOATS  -- its underside never reaches the scalp, so the skull shows
     through the gap and the hair reads as a hat hovering above the head; or
  2. SINKS   -- it is buried so deep that the styled silhouette is swallowed by
     the skull; or
  3. DRIFTS  -- the male and female variants disagree about where the head is,
     so one body wears it correctly and the other does not; or
  4. LEAKS   -- the cap is too small or too tight for the skull it was fitted
     to, so the head pushes out THROUGH the hair and a bare patch of scalp
     shows inside the style.

Hair is *meant* to intersect the scalp: the cap has to cross the skin surface or
its rim leaves a slot. So penetration is not the fault -- absence of contact is.

Cases 1-3 are all cap-to-body measures, and none of them can see case 4: every
cap vertex can rest perfectly on skin while the crown erupts between them. That
one needs the opposite probe, skull outward, which `scalp_exposure` does.

This measures, per hair per body, against the head/neck skin only:

  `contact_fraction`   share of cap vertices within `CONTACT_BAND_MM` of skin.
  `underside_gap_mm`   how far the nearest cap vertex sits ABOVE the scalp.
  `max_depth_mm`       deepest the cap reaches inside the skull.
  `crown_clearance_mm` how far the top of the hair clears the top of the skull.
  `scalp_poke_vertices` skull points left bare while their neighbours are
     covered -- a hole in the style rather than its edge.

Bind pose only: hair rides the head joint rigidly, so a pose sweep adds cost
without adding signal.

    blender --background --factory-startup --python verify_wearable_fit.py
"""

from __future__ import annotations

import json
import os
import sys

import numpy as np
from mathutils import Vector
from mathutils.bvhtree import BVHTree

LAB_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, LAB_DIR)

import pose_probe as POSE  # noqa: E402
import refit_config as CFG  # noqa: E402

GENERATOR = "successor content-pipeline/labs/humanoid-runtime-refit/verify_wearable_fit.py"

REPO = os.path.abspath(os.path.join(LAB_DIR, "..", "..", ".."))
EQUIPMENT = os.path.join(REPO, "client-3d", "public", "assets",
                         "pawn-pack", "equipment")

#: Skin a cap vertex must come within to count as resting on the head.
CONTACT_BAND_MM = 2.0
#: A cap whose closest point never reaches the skin is floating: the skull
#: shows through the gap and the hair reads as a hat hovering above the head.
FLOAT_LIMIT_MM = 3.0
#: A cap is MEANT to cross the scalp -- a rim that stops at the skin leaves a
#: slot. Across the shipped set the crossing measures 11..46 mm (median 28),
#: so this rejects a piece swallowed well past the authored band rather than
#: pretending shallow is better.
BURIED_LIMIT_MM = 60.0
#: The male and female variants are refits of one style, so they may differ by
#: a head-size margin. The shipped set differs by at most 9.8 mm; a piece that
#: disagrees by more than this has been fitted to one body only.
VARIANT_DELTA_LIMIT_MM = 25.0
#: Where the scalp starts, as a fraction of head-zone height. Below the brow
#: the skin is face and jaw, which hair is not answerable for.
BROW_HEIGHT_FRACTION = 0.45
#: A vertex whose outward normal points this strongly toward the face is part
#: of the face shell, not the scalp, even when it sits above the brow.
FACE_NORMAL_LIMIT = 0.5
#: How far out from the skin a cover probe looks for hair. Anything further
#: than this is a silhouette the scalp was never behind.
COVER_PROBE_MM = 80.0
#: A bare skull vertex counts as a poke-through when at least this share of its
#: neighbours ARE covered: the cap is present all around it and stops short
#: only there, which is the hole the player sees. A vertex on the open edge of
#: the style -- a hairline, a shaved back, the gap beside a ponytail -- has bare
#: neighbours too and is left alone.
POKE_NEIGHBOUR_FRACTION = 0.75
#: The probe samples the scalp at its vertices, so a cap that genuinely
#: envelops still misses a few along the brow edge of the mask. Measured
#: against the helmets, which are built to swallow the skull whole: they leave
#: 5-7. Anything past that is the style itself failing to cover, and the refit
#: target is zero.
POKE_LIMIT = 8
#: Skin zones that define the skull reference the crown is measured against.
HEAD_ZONES = ("head", "neck")


def variant_path(body_id: str, relative: str) -> str:
    root = EQUIPMENT if body_id == "male" else os.path.join(EQUIPMENT, "Female")
    return os.path.join(root, relative)


def wearables() -> list[str]:
    """Every authored piece that has to fit both bodies."""
    found: list[str] = []
    for folder in ("Under", "Armor"):
        directory = os.path.join(EQUIPMENT, folder)
        if not os.path.isdir(directory):
            continue
        for name in sorted(os.listdir(directory)):
            if name.endswith(".glb"):
                found.append(f"{folder}/{name}")
    return found


def is_hair(relative: str) -> bool:
    return "hair" in os.path.basename(relative).lower()


def vertex_normals(position, faces, indices):
    """Area-weighted outward normal per skull vertex, in body space."""
    accumulated = np.zeros((len(position), 3), dtype=np.float64)
    corners = position[faces]
    cross = np.cross(corners[:, 1] - corners[:, 0], corners[:, 2] - corners[:, 0])
    for slot in range(3):
        np.add.at(accumulated, faces[:, slot], cross)
    lengths = np.linalg.norm(accumulated, axis=1)
    lengths[lengths == 0.0] = 1.0
    return accumulated[indices] / lengths[indices, None]


def vertex_neighbours(faces, indices):
    """Adjacency among the given vertices, from the faces that share them."""
    wanted = set(int(index) for index in indices)
    adjacency: dict[int, set[int]] = {index: set() for index in wanted}
    for face in faces:
        for slot, vertex in enumerate(face):
            vertex = int(vertex)
            if vertex not in wanted:
                continue
            for other in (face[(slot + 1) % 3], face[(slot + 2) % 3]):
                other = int(other)
                if other in wanted:
                    adjacency[vertex].add(other)
    return adjacency


def scalp_vertices(position, indices, normals):
    """The part of the skull hair is responsible for covering.

    Not the whole head. The face is bare by design and the neck is nobody's
    job, so probing them reports the open front of a helm as a hole. The scalp
    is what remains: the cranium above the brow, minus the forward-facing
    shell that carries the face.
    """
    points = position[indices]
    low, high = float(points[:, 1].min()), float(points[:, 1].max())
    brow = low + (high - low) * BROW_HEIGHT_FRACTION
    # Whichever way the face points, it is the axis the head is deepest along.
    middle = float(np.median(points[:, 2]))
    forward = 1.0 if float(points[:, 2].max()) - middle >= middle - float(points[:, 2].min()) else -1.0
    facing = normals[:, 2] * forward
    return np.where((points[:, 1] >= brow) & (facing < FACE_NORMAL_LIMIT))[0]


def scalp_exposure(cap, skull_indices, scalp_slots, position, normals, adjacency):
    """Skull left bare inside the cap's own footprint.

    The seating measures above all run cap-to-body: they prove the hair TOUCHES
    the head. None of them can see the opposite defect, where the cap is too
    small or too tight and the skull pushes out through it -- every cap vertex
    still rests on skin while the crown pokes into open air. This probes the
    other direction, skull outward, and reports the holes.
    """
    cap_tree = BVHTree.FromPolygons(
        [tuple(point) for point in cap.position],
        [tuple(face) for face in cap.faces])
    reach = COVER_PROBE_MM / 1000.0
    covered: dict[int, bool] = {}
    for slot in scalp_slots:
        index = skull_indices[slot]
        point = position[index]
        normal = normals[slot]
        origin = Vector((float(point[0] + normal[0] * 1.0e-5),
                         float(point[1] + normal[1] * 1.0e-5),
                         float(point[2] + normal[2] * 1.0e-5)))
        hit, _, _, _ = cap_tree.ray_cast(
            origin, Vector((float(normal[0]), float(normal[1]), float(normal[2]))), reach)
        covered[int(index)] = hit is not None
    holes = 0
    for index, is_covered in covered.items():
        if is_covered:
            continue
        neighbours = adjacency.get(index) or ()
        if not neighbours:
            continue
        share = sum(1 for other in neighbours if covered.get(other)) / len(neighbours)
        if share >= POKE_NEIGHBOUR_FRACTION:
            holes += 1
    return holes, sum(1 for value in covered.values() if value), len(covered)


def main() -> None:
    CFG.ensure_dirs()
    report = {"generator": GENERATOR,
              "contact_band_mm": CONTACT_BAND_MM,
              "float_limit_mm": FLOAT_LIMIT_MM,
              "buried_limit_mm": BURIED_LIMIT_MM,
              "variant_delta_limit_mm": VARIANT_DELTA_LIMIT_MM,
              "bodies": {}}
    failures: list[str] = []
    pieces = wearables()

    for body_id in ("male", "female"):
        body = POSE.Body(body_id)
        head_faces = np.concatenate([faces for zone, faces
                                     in body.zone_faces.items()
                                     if zone in HEAD_ZONES])
        skull_indices = np.unique(head_faces.reshape(-1))
        skin = body.position[skull_indices]
        skull_top = float(skin[:, 1].max())
        skull_normals = vertex_normals(body.position, body.faces, skull_indices)
        scalp_slots = scalp_vertices(body.position, skull_indices, skull_normals)
        skull_adjacency = vertex_neighbours(head_faces, skull_indices)
        # Signed against the WHOLE body, not just head/neck: a bob or a braid
        # drapes past the jaw onto the shoulders, and measuring only against
        # head skin makes that drape read as though it were buried inside the
        # skull.
        body_tree = BVHTree.FromPolygons(
            [tuple(point) for point in body.position],
            [tuple(face) for face in body.faces])
        items: dict[str, dict[str, float]] = {}

        for relative in pieces:
            path = variant_path(body_id, relative)
            if not os.path.exists(path):
                failures.append(f"{body_id}: {relative} has no variant")
                continue
            cap = POSE.SkinnedGeometry(path, f"{relative}:{body_id}")
            points = cap.position
            # Signed distance to the head SURFACE, not to its vertices: skin
            # vertices are millimetres apart, so a vertex-to-vertex measure
            # reports a gap for a cap resting exactly on a triangle.
            signed_mm = np.empty(len(points), dtype=np.float64)
            for slot, point in enumerate(points):
                location, normal, _, distance = body_tree.find_nearest(
                    Vector((float(point[0]), float(point[1]), float(point[2]))))
                if location is None:
                    signed_mm[slot] = np.inf
                    continue
                outward = (float(point[0]) - location.x,
                           float(point[1]) - location.y,
                           float(point[2]) - location.z)
                inside = (outward[0] * normal.x + outward[1] * normal.y
                          + outward[2] * normal.z) < 0.0
                signed_mm[slot] = distance * 1000.0 * (-1.0 if inside else 1.0)

            nearest_mm = float(signed_mm.min())
            contact = float((np.abs(signed_mm) <= CONTACT_BAND_MM).mean())
            crown_mm = (float(points[:, 1].max()) - skull_top) * 1000.0
            name = os.path.splitext(os.path.basename(relative))[0]
            depth_mm = max(0.0, -nearest_mm)
            holes, covered, probed = scalp_exposure(
                cap, skull_indices, scalp_slots, body.position, skull_normals,
                skull_adjacency)
            items[name] = {"nearest_surface_mm": round(nearest_mm, 3),
                           "max_depth_mm": round(depth_mm, 3),
                           "contact_fraction": round(contact, 4),
                           "crown_clearance_mm": round(crown_mm, 2),
                           "scalp_poke_vertices": holes,
                           "scalp_covered_vertices": covered,
                           "scalp_probed_vertices": probed,
                           "hair": is_hair(relative),
                           "vertices": int(len(points))}
            # Seating limits are a hair contract. A glove or vest is authored
            # with a deliberate standoff and a helm is meant to envelop, so
            # neither is charged against a scalp rule.
            if is_hair(relative):
                if nearest_mm > FLOAT_LIMIT_MM:
                    failures.append(f"{body_id}: {name} never reaches the "
                                    f"scalp ({nearest_mm:.2f} mm clear)")
                elif depth_mm > BURIED_LIMIT_MM:
                    failures.append(f"{body_id}: {name} is buried "
                                    f"{depth_mm:.1f} mm into the body")
                if holes > POKE_LIMIT:
                    failures.append(f"{body_id}: {name} lets the skull through "
                                    f"at {holes} points inside its own cap")

        report["bodies"][body_id] = {"skull_top_m": round(skull_top, 5),
                                     "items": items}
        hairs = [v for v in items.values() if v["hair"]]
        seated = sum(1 for v in hairs
                     if v["nearest_surface_mm"] <= FLOAT_LIMIT_MM)
        leaking = sum(1 for v in hairs
                      if v["scalp_poke_vertices"] > POKE_LIMIT)
        print(f"[fitcheck] {body_id}: {len(items)} pieces measured, "
              f"{seated}/{len(hairs)} hairs seated, "
              f"{leaking}/{len(hairs)} leaking scalp")

    # A style ships as two refits of one design. If the variants disagree about
    # how deep the cap sits, the piece was fitted to one body and copied to the
    # other, which is the failure that survives every per-body check.
    male_items = report["bodies"]["male"]["items"]
    female_items = report["bodies"]["female"]["items"]
    for name, male_fit in sorted(male_items.items()):
        female_fit = female_items.get(name)
        if female_fit is None:
            failures.append(f"{name} has no female variant")
            continue
        delta = abs(male_fit["max_depth_mm"] - female_fit["max_depth_mm"])
        if delta > VARIANT_DELTA_LIMIT_MM:
            failures.append(f"{name}: male and female seat {delta:.1f} mm "
                            f"apart ({male_fit['max_depth_mm']:.1f} vs "
                            f"{female_fit['max_depth_mm']:.1f})")
    report["failures"] = failures
    out = os.path.join(CFG.REPORT_DIR, "wearable_fit.json")
    with open(out, "w", encoding="utf-8") as handle:
        json.dump(report, handle, indent=2)
        handle.write("\n")

    if failures:
        print(f"[fitcheck] FAIL ({len(failures)})")
        for failure in failures:
            print(f"[fitcheck]   {failure}")
        raise SystemExit(1)
    print("[fitcheck] PASS")


if __name__ == "__main__":
    main()
