"""Gate the segmented bodies and the promoted masks against the runtime contract.

Everything here is a fact about the shipped files, checked against the runtime
source rather than against a copy of it: the zone vocabulary is parsed straight
out of `client-3d/src/assets/pawnPack.ts`, so a rename on either side fails
loudly instead of drifting.

    blender --background --python verify_body_zones.py
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import sys

import numpy as np

LAB_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, LAB_DIR)

import body_zones as BZ  # noqa: E402
import reference_bodies  # noqa: E402
import refit_config as CFG  # noqa: E402
from gltf_io import Glb  # noqa: E402

GENERATOR = "successor content-pipeline/labs/humanoid-runtime-refit/verify_body_zones.py"

TS_SOURCE = os.path.join(CFG.REPO, "client-3d/src/assets/pawnPack.ts")
RUST_SOURCE = os.path.join(CFG.REPO, "client-rust/source/app/src/pawn/catalog.rs")


def ts_vocabulary() -> list[str]:
    """`PAWN_BODY_ZONES` exactly as the Three runtime declares it."""
    with open(TS_SOURCE, encoding="utf-8") as handle:
        source = handle.read()
    block = re.search(r"export const PAWN_BODY_ZONES = \[(.*?)\] as const;",
                      source, re.S)
    if not block:
        raise SystemExit(f"{TS_SOURCE}: PAWN_BODY_ZONES not found")
    return re.findall(r'"([a-z_]+)"', block.group(1))


def main() -> None:
    CFG.ensure_dirs()
    failures: list[str] = []
    report: dict = {"generator": GENERATOR, "checks": {}}

    declared = ts_vocabulary()
    report["checks"]["vocabulary"] = {"typescript": declared, "lab": list(BZ.ZONES),
                                      "match": declared == list(BZ.ZONES)}
    if declared != list(BZ.ZONES):
        failures.append(f"zone vocabulary drift: TS {declared} vs lab {list(BZ.ZONES)}")
    with open(RUST_SOURCE, encoding="utf-8") as handle:
        rust = handle.read()
    missing = [zone for zone in BZ.ZONES if f'"{zone}"' not in rust]
    report["checks"]["rust_vocabulary"] = {"missing": missing}
    if missing:
        failures.append(f"{RUST_SOURCE} does not name {missing}")

    shell = Glb.load(CFG.RUNTIME_SHELL)
    shell_joints = [shell.json["nodes"][j].get("name")
                    for j in shell.json["skins"][0]["joints"]]
    shell_clips = [a["name"] for a in shell.json["animations"]]
    shell_ibm = shell.accessor(shell.json["skins"][0]["inverseBindMatrices"])
    sources = reference_bodies.promotion_inputs()

    bodies = {}
    for body_id, path in CFG.RUNTIME_BODY.items():
        glb = Glb.load(path)
        materials = [glb.json["materials"][p["material"]]["name"]
                     for p in glb.json["meshes"][0]["primitives"]]
        expected = [BZ.material_name(zone) for zone in BZ.ZONES] + [BZ.FACE_MATERIAL]
        joints = [glb.json["nodes"][j].get("name")
                  for j in glb.json["skins"][0]["joints"]]
        clips = [a["name"] for a in glb.json.get("animations", ())]
        ibm = glb.accessor(glb.json["skins"][0]["inverseBindMatrices"])
        index_types = {glb.json["accessors"][p["indices"]]["type"]
                       for p in glb.json["meshes"][0]["primitives"]}
        skin_pbr = {json.dumps(glb.json["materials"][i]["pbrMetallicRoughness"],
                               sort_keys=True)
                    for i, name in enumerate(materials) if name != BZ.FACE_MATERIAL}
        source = Glb.load(sources[body_id])
        out_points = np.unique(np.round(np.concatenate(
            [glb.accessor(p["attributes"]["POSITION"]).astype(np.float64)
             for p in glb.json["meshes"][0]["primitives"]]), 6), axis=0)
        src_points = np.unique(np.round(np.concatenate(
            [source.accessor(p["attributes"]["POSITION"]).astype(np.float64)
             for p in source.json["meshes"][0]["primitives"]]), 6), axis=0)
        out_tris = sum(glb.json["accessors"][p["indices"]]["count"]
                       for p in glb.json["meshes"][0]["primitives"]) // 3
        src_tris = sum(source.json["accessors"][p["indices"]]["count"]
                       for p in source.json["meshes"][0]["primitives"]) // 3
        entry = {
            "path": os.path.relpath(path, CFG.REPO),
            "sha256": hashlib.sha256(open(path, "rb").read()).hexdigest(),
            "materials_exact": materials == expected,
            "joints_match_shell": joints == shell_joints,
            "clips_match_shell": clips == shell_clips,
            "inverse_bind_max_delta": float(np.abs(ibm - shell_ibm).max()),
            "index_accessor_types": sorted(index_types),
            "skin_material_variants": len(skin_pbr),
            "welded_points_identical_to_source": bool(
                out_points.shape == src_points.shape
                and np.array_equal(out_points, src_points)),
            "triangles": out_tris, "source_triangles": src_tris,
            "stature_m": round(float(out_points[:, 1].max()), 6),
            "source_stature_m": round(float(src_points[:, 1].max()), 6),
        }
        bodies[body_id] = entry
        if not entry["materials_exact"]:
            failures.append(f"{body_id}: materials {materials} != {expected}")
        if not entry["joints_match_shell"]:
            failures.append(f"{body_id}: joint order drifted from the shell")
        if not entry["clips_match_shell"]:
            failures.append(f"{body_id}: clip list drifted from the shell")
        if entry["inverse_bind_max_delta"] > 1e-6:
            failures.append(f"{body_id}: inverse binds differ from the shell by "
                            f"{entry['inverse_bind_max_delta']:.2e}")
        if entry["index_accessor_types"] != ["SCALAR"]:
            failures.append(f"{body_id}: index accessors are "
                            f"{entry['index_accessor_types']}, must be SCALAR")
        if entry["skin_material_variants"] != 1:
            failures.append(f"{body_id}: zone materials are not visually identical "
                            f"({entry['skin_material_variants']} PBR variants)")
        if not entry["welded_points_identical_to_source"]:
            failures.append(f"{body_id}: welded vertex set differs from its source")
        if out_tris != src_tris:
            failures.append(f"{body_id}: {out_tris} triangles vs source {src_tris}")
        if entry["stature_m"] != entry["source_stature_m"]:
            failures.append(f"{body_id}: stature {entry['stature_m']} != source "
                            f"{entry['source_stature_m']}")
    report["bodies"] = bodies

    male = hashlib.sha256(open(CFG.RUNTIME_BODY["male"], "rb").read()).hexdigest()
    for alias in CFG.RUNTIME_BODY_ALIAS["male"]:
        digest = hashlib.sha256(open(alias, "rb").read()).hexdigest()
        report["checks"][os.path.basename(alias)] = {"matches_male": digest == male}
        if digest != male:
            failures.append(f"{os.path.basename(alias)} is not the promoted male")

    with open(os.path.join(CFG.EQUIPMENT, "manifest.json"), encoding="utf-8") as handle:
        manifest = json.load(handle)
    unknown, bad_order, missing_variant = [], [], []
    for entry in manifest["items"]:
        zones = entry.get("hideBodyZones", [])
        unknown += [f"{entry['id']}:{zone}" for zone in zones
                    if zone not in BZ.ZONE_INDEX]
        if zones != [zone for zone in BZ.ZONES if zone in set(zones)]:
            bad_order.append(entry["id"])
        variant = entry.get("glbFemale")
        if variant and not os.path.exists(
                os.path.normpath(os.path.join(CFG.EQUIPMENT, variant))):
            missing_variant.append(entry["id"])
    report["checks"]["manifest"] = {
        "items": len(manifest["items"]),
        "with_hide_body_zones": sum(1 for e in manifest["items"]
                                    if e.get("hideBodyZones")),
        "with_glb_female": sum(1 for e in manifest["items"] if e.get("glbFemale")),
        "unknown_zones": unknown, "non_canonical_order": bad_order,
        "missing_female_files": missing_variant,
    }
    failures += [f"manifest declares unknown zone {value}" for value in unknown]
    failures += [f"{item}: hideBodyZones not in canonical order" for item in bad_order]
    failures += [f"{item}: glbFemale points at a missing file"
                 for item in missing_variant]

    report["failures"] = failures
    destination = os.path.join(CFG.REPORT_DIR, "body_zone_verification.json")
    with open(destination, "w", encoding="utf-8") as handle:
        json.dump(report, handle, indent=2)
        handle.write("\n")
    for body_id, entry in bodies.items():
        print(f"[verify] {body_id}: materials exact {entry['materials_exact']}, "
              f"joints {entry['joints_match_shell']}, clips {entry['clips_match_shell']}, "
              f"ibm delta {entry['inverse_bind_max_delta']:.2e}, "
              f"points identical {entry['welded_points_identical_to_source']}, "
              f"tris {entry['triangles']}=={entry['source_triangles']}, "
              f"stature {entry['stature_m']}")
    print(f"[verify] vocabulary match {report['checks']['vocabulary']['match']}, "
          f"rust missing {report['checks']['rust_vocabulary']['missing']}")
    print(f"[verify] manifest {report['checks']['manifest']}")
    print(f"[verify] {'PASS' if not failures else 'FAIL'}")
    for failure in failures:
        print(f"[verify]   {failure}")


if __name__ == "__main__":
    main()
