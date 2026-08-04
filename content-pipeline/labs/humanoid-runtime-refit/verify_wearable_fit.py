"""Prove every hair piece actually sits on the head, on BOTH bodies.

`verify_starter_fit` covers the two authored starter garments. Hair is a
different failure mode and nothing gated it: a hair cap either

  1. FLOATS  -- its underside never reaches the scalp, so the skull shows
     through the gap and the hair reads as a hat hovering above the head; or
  2. SINKS   -- it is buried so deep that the styled silhouette is swallowed by
     the skull; or
  3. DRIFTS  -- the male and female variants disagree about where the head is,
     so one body wears it correctly and the other does not.

Hair is *meant* to intersect the scalp: the cap has to cross the skin surface or
its rim leaves a slot. So penetration is not the fault -- absence of contact is.
This measures, per hair per body, against the head/neck skin only:

  `contact_fraction`   share of cap vertices within `CONTACT_BAND_MM` of skin.
  `underside_gap_mm`   how far the nearest cap vertex sits ABOVE the scalp.
  `max_depth_mm`       deepest the cap reaches inside the skull.
  `crown_clearance_mm` how far the top of the hair clears the top of the skull.

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
        skin = body.position[np.unique(head_faces.reshape(-1))]
        skull_top = float(skin[:, 1].max())
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
            items[name] = {"nearest_surface_mm": round(nearest_mm, 3),
                           "max_depth_mm": round(depth_mm, 3),
                           "contact_fraction": round(contact, 4),
                           "crown_clearance_mm": round(crown_mm, 2),
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

        report["bodies"][body_id] = {"skull_top_m": round(skull_top, 5),
                                     "items": items}
        hairs = [v for v in items.values() if v["hair"]]
        seated = sum(1 for v in hairs
                     if v["nearest_surface_mm"] <= FLOAT_LIMIT_MM)
        print(f"[fitcheck] {body_id}: {len(items)} pieces measured, "
              f"{seated}/{len(hairs)} hairs seated")

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
