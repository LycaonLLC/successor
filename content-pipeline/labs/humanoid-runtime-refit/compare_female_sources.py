"""Does `rbf_v3` actually reduce the female posterior? Measure, do not assume.

`rbf_v3_anim.glb` arrived as the "final reduced-posterior" female. The name is
not evidence, so this compares it against its predecessor `rbf_v2_anim.glb` and
against the previously shipped female bodies on the one quantity the request is
about: how far the rear pelvis silhouette projects behind the rig axis. Face is
+z, so rear is -z and the measure is `min z` inside a height band.

    blender --background --python compare_female_sources.py

Output: `reports/female_source_comparison.json` plus a printed table. Nothing is
written to the runtime pack; this is an instrument.
"""

from __future__ import annotations

import hashlib
import json
import os
import sys

import numpy as np

LAB_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, LAB_DIR)

import body_zones as BZ  # noqa: E402
import refit_config as CFG  # noqa: E402
import reduce_female_posterior as REDUCE  # noqa: E402
from gltf_io import Glb  # noqa: E402

GENERATOR = "successor content-pipeline/labs/humanoid-runtime-refit/compare_female_sources.py"

#: Height bands, in metres of bind-pose y. The first two match the audit the
#: v2/v3 question was raised with; the third is the band the reduction is judged
#: on and the last two bracket it, so a change that merely moved the projection
#: up or down cannot read as a reduction.
BANDS = ((0.85, 0.95), (0.95, 1.05), (0.86, 1.02), (0.78, 0.86), (1.02, 1.12))

#: Candidates, in lineage order. Missing entries are reported, not fatal: the
#: branch-base bodies come out of git and the v2 source is a handoff artifact.
CANDIDATES = (
    ("branch_base_shipped_female", os.path.join(CFG.BUILD_DIR, "reference/female.glb")),
    ("humanoid_lab_female_latest", os.path.join(CFG.BUILD_DIR,
                                                "scratch/pawn_female_latest.glb")),
    ("rbf_v2_source", os.path.join(CFG.SOURCE_DIR, "female/rbf_v2_anim.glb")),
    ("rbf_v3_source", os.path.join(CFG.SOURCE_DIR, "female/rbf_v3_anim.glb")),
    ("rbf_v3_reduced", REDUCE.output_path()),
    ("rb_v4_male_source", os.path.join(CFG.SOURCE_DIR, "male/rb_v4_anim.glb")),
)


def skin_positions(glb: Glb) -> np.ndarray:
    """Every skin vertex; the face panel is excluded, it is not a silhouette."""
    out = []
    for primitive in glb.json["meshes"][0]["primitives"]:
        if glb.json["materials"][primitive["material"]]["name"] == BZ.FACE_MATERIAL:
            continue
        out.append(glb.accessor(primitive["attributes"]["POSITION"]).astype(np.float64))
    return np.concatenate(out)


def partition(glb: Glb) -> dict[str, int]:
    return {glb.json["materials"][primitive["material"]]["name"]:
            glb.json["accessors"][primitive["attributes"]["POSITION"]]["count"]
            for primitive in glb.json["meshes"][0]["primitives"]}


def describe(path: str) -> dict:
    glb = Glb.load(path)
    position = skin_positions(glb)
    return {
        "path": os.path.relpath(path, CFG.REPO),
        "sha256": hashlib.sha256(open(path, "rb").read()).hexdigest(),
        "stature_m": round(float(position[:, 1].max()), 4),
        "hip_half_width_m": round(float(np.abs(position[:, 0]).max()), 4),
        "primitive_vertices": partition(glb),
        "rear_mm": {f"y{low:g}-{high:g}":
                    round(REDUCE.band_rear(position, (low, high)) * 1000.0, 3)
                    for low, high in BANDS},
        "rear_profile_mm": REDUCE.rear_profile(position),
    }


def main() -> None:
    CFG.ensure_dirs()
    report = {"generator": GENERATOR, "bands_y_m": [list(band) for band in BANDS],
              "note": "face is +z, so rear projection is min z; more negative is deeper",
              "bodies": {}, "missing": []}
    for name, path in CANDIDATES:
        if not os.path.exists(path):
            report["missing"].append({"name": name,
                                      "path": os.path.relpath(path, CFG.REPO)})
            continue
        report["bodies"][name] = describe(path)

    columns = [f"y{low:g}-{high:g}" for low, high in BANDS]
    print(f"{'body':30s} " + " ".join(f"{column:>11s}" for column in columns)
          + "   stature  hipW")
    for name, entry in report["bodies"].items():
        print(f"{name:30s} "
              + " ".join(f"{entry['rear_mm'][column]:11.3f}" for column in columns)
              + f"   {entry['stature_m']:.4f}  {entry['hip_half_width_m']:.4f}")
    for entry in report["missing"]:
        print(f"{entry['name']:30s} (absent: {entry['path']})")

    v2, v3 = report["bodies"].get("rbf_v2_source"), report["bodies"].get("rbf_v3_source")
    if v2 and v3:
        deltas = {column: round(v3["rear_mm"][column] - v2["rear_mm"][column], 4)
                  for column in columns}
        report["v3_minus_v2_mm"] = deltas
        report["v3_reduced_posterior"] = any(value > 0.05 for value in deltas.values())
        print(f"\nv3 - v2 rear delta (mm, positive = shallower): {deltas}")
        print("v3 reduced the posterior: "
              f"{'YES' if report['v3_reduced_posterior'] else 'NO'}")
    destination = os.path.join(CFG.REPORT_DIR, "female_source_comparison.json")
    with open(destination, "w", encoding="utf-8") as handle:
        json.dump(report, handle, indent=2)
    print(f"-> {os.path.relpath(destination, CFG.REPO)}")


if __name__ == "__main__":
    main()
