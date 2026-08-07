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
import canonical_hands as HANDS  # noqa: E402
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
    references = reference_bodies.materialise()

    bodies = {}
    for body_id, path in CFG.RUNTIME_BODY.items():
        glb = Glb.load(path)
        primitives = glb.json["meshes"][0]["primitives"]
        materials = [glb.json["materials"][p["material"]]["name"] for p in primitives]
        expected = ([BZ.material_name(zone) for zone in BZ.ZONES]
                    + [BZ.material_name("head"), BZ.FACE_MATERIAL])
        overlay_slots = [index for index, name in enumerate(materials)
                         if name == BZ.FACE_MATERIAL]
        skin_primitives = [primitive for index, primitive in enumerate(primitives)
                           if index not in overlay_slots]
        joints = [glb.json["nodes"][j].get("name")
                  for j in glb.json["skins"][0]["joints"]]
        clips = [a["name"] for a in glb.json.get("animations", ())]
        ibm = glb.accessor(glb.json["skins"][0]["inverseBindMatrices"])
        index_types = {glb.json["accessors"][p["indices"]]["type"] for p in primitives}
        skin_pbr = {
            json.dumps(material["pbrMetallicRoughness"], sort_keys=True)
            for material in glb.json["materials"]
            if material["name"] != BZ.FACE_MATERIAL
        }
        source = Glb.load(sources[body_id])
        source_primitives = source.json["meshes"][0]["primitives"]
        source_materials = [source.json["materials"][p["material"]]["name"]
                            for p in source_primitives]
        source_face = source_primitives[source_materials.index(BZ.FACE_MATERIAL)]
        source_skin = [primitive for primitive, material
                       in zip(source_primitives, source_materials)
                       if material != BZ.FACE_MATERIAL]
        source_position_parts = []
        source_joint_parts = []
        source_weight_parts = []
        source_face_parts = []
        source_base = 0
        for primitive in source_skin:
            position_part = source.accessor(
                primitive["attributes"]["POSITION"]).astype(np.float64)
            source_position_parts.append(position_part)
            source_joint_parts.append(source.accessor(
                primitive["attributes"]["JOINTS_0"]).astype(np.int64))
            source_weight_parts.append(source.accessor(
                primitive["attributes"]["WEIGHTS_0"]).astype(np.float64))
            source_face_parts.append(source.accessor(
                primitive["indices"]).astype(np.int64).reshape(-1, 3) + source_base)
            source_base += len(position_part)
        source_position = np.concatenate(source_position_parts)
        source_joint_slots = np.concatenate(source_joint_parts)
        source_weights = np.concatenate(source_weight_parts)
        source_weights /= source_weights.sum(axis=1, keepdims=True)
        source_faces = np.concatenate(source_face_parts)
        source_joint_names = [
            source.json["nodes"][joint].get("name", "")
            for joint in source.json["skins"][0]["joints"]]
        source_labels, _ = BZ.segment(
            source_position, source_faces, source_joint_names,
            source_joint_slots, source_weights, body_id)
        refined_hand_labels = {
            BZ.ZONE_INDEX[zone] for zone in HANDS.HAND_ZONES}
        source_non_hand_faces = source_faces[
            ~np.isin(source_labels, list(refined_hand_labels))]
        source_non_hand_points = source_position[
            np.unique(source_non_hand_faces.reshape(-1))]

        hand_reference = Glb.load(references[body_id])
        canonical_hands = HANDS.extract(hand_reference, shell_joints)
        canonical_hand_points = np.concatenate([
            canonical_hands[zone]["POSITION"] for zone in HANDS.HAND_ZONES])
        source_face_points = source.accessor(
            source_face["attributes"]["POSITION"]).astype(np.float64)
        out_points = np.unique(np.round(np.concatenate(
            [glb.accessor(p["attributes"]["POSITION"]).astype(np.float64)
             for p in skin_primitives]), 6), axis=0)
        expected_points = np.unique(np.round(np.concatenate(
            [source_non_hand_points, source_face_points, canonical_hand_points]), 6),
            axis=0)
        render_tris = sum(glb.json["accessors"][p["indices"]]["count"]
                          for p in primitives) // 3
        geometry_tris = sum(glb.json["accessors"][p["indices"]]["count"]
                            for p in skin_primitives) // 3
        refined_source_tris = sum(
            source.json["accessors"][p["indices"]]["count"]
            for p in source_primitives) // 3
        expected_hybrid_tris = (
            len(source_non_hand_faces)
            + source.json["accessors"][source_face["indices"]]["count"] // 3
            + sum(len(canonical_hands[zone]["indices"])
                  for zone in HANDS.HAND_ZONES))
        by_material = {
            glb.json["materials"][primitive["material"]]["name"]: primitive
            for primitive in primitives}
        canonical_hands_exact = {}
        for zone in HANDS.HAND_ZONES:
            primitive = by_material.get(BZ.material_name(zone))
            expected_hand = canonical_hands[zone]
            canonical_hands_exact[zone] = bool(
                primitive is not None
                and all(np.array_equal(
                    glb.accessor(primitive["attributes"][attribute]),
                    expected_hand[attribute])
                    for attribute in ("POSITION", "NORMAL", "JOINTS_0", "WEIGHTS_0"))
                and np.array_equal(
                    glb.accessor(primitive["indices"]).reshape(-1),
                    expected_hand["indices"].reshape(-1)))

        overlay_ok = len(overlay_slots) == 1
        overlay_inflate_delta = float("inf")
        overlay_omits_colour = False
        overlay_alpha_blend = False
        if overlay_ok:
            overlay = primitives[overlay_slots[0]]
            overlay_position = glb.accessor(
                overlay["attributes"]["POSITION"]).astype(np.float64)
            source_position = source.accessor(
                source_face["attributes"]["POSITION"]).astype(np.float64)
            source_normal = source.accessor(
                source_face["attributes"]["NORMAL"]).astype(np.float64)
            expected_overlay = source_position + source_normal * CFG.FACE_OVERLAY_INFLATE
            if overlay_position.shape == expected_overlay.shape:
                overlay_inflate_delta = float(
                    np.abs(overlay_position - expected_overlay).max())
            overlay_omits_colour = "COLOR_0" not in overlay["attributes"]
            overlay_material = glb.json["materials"][overlay["material"]]
            overlay_alpha_blend = overlay_material.get("alphaMode") == "BLEND"

        entry = {
            "path": os.path.relpath(path, CFG.REPO),
            "sha256": hashlib.sha256(open(path, "rb").read()).hexdigest(),
            "materials_exact": materials == expected,
            "joints_match_shell": joints == shell_joints,
            "clips_match_shell": clips == shell_clips,
            "inverse_bind_max_delta": float(np.abs(ibm - shell_ibm).max()),
            "index_accessor_types": sorted(index_types),
            "skin_material_variants": len(skin_pbr),
            "welded_points_match_hybrid_sources": bool(
                out_points.shape == expected_points.shape
                and np.array_equal(out_points, expected_points)),
            "canonical_hands_exact": canonical_hands_exact,
            "source_geometry_triangles": geometry_tris,
            "expected_hybrid_triangles": expected_hybrid_tris,
            "refined_source_triangles": refined_source_tris,
            "triangles": render_tris,
            "face_overlay_count": len(overlay_slots),
            "face_overlay_alpha_blend": overlay_alpha_blend,
            "face_overlay_omits_vertex_color": overlay_omits_colour,
            "face_overlay_inflate_max_delta_m": overlay_inflate_delta,
            "stature_m": round(float(out_points[:, 1].max()), 6),
            "expected_stature_m": round(float(expected_points[:, 1].max()), 6),
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
        if not entry["welded_points_match_hybrid_sources"]:
            failures.append(
                f"{body_id}: opaque skin vertex set differs from refined body + canonical hands")
        if not all(entry["canonical_hands_exact"].values()):
            failures.append(
                f"{body_id}: canonical hand graft drifted {entry['canonical_hands_exact']}")
        if geometry_tris != expected_hybrid_tris:
            failures.append(
                f"{body_id}: opaque geometry has {geometry_tris} triangles vs hybrid "
                f"sources {expected_hybrid_tris}")
        if entry["face_overlay_count"] != 1:
            failures.append(
                f"{body_id}: expected one transparent face overlay, got {entry['face_overlay_count']}")
        if not entry["face_overlay_alpha_blend"]:
            failures.append(f"{body_id}: face overlay is not alpha-blended")
        if not entry["face_overlay_omits_vertex_color"]:
            failures.append(f"{body_id}: face overlay still carries darkening vertex colour")
        if entry["face_overlay_inflate_max_delta_m"] > 1e-6:
            failures.append(
                f"{body_id}: face overlay inflate drift "
                f"{entry['face_overlay_inflate_max_delta_m']:.2e} m")
        if entry["stature_m"] != entry["expected_stature_m"]:
            failures.append(f"{body_id}: stature {entry['stature_m']} != expected "
                            f"{entry['expected_stature_m']}")
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
              f"hybrid points {entry['welded_points_match_hybrid_sources']}, "
              f"canonical hands {entry['canonical_hands_exact']}, "
              f"opaque tris {entry['source_geometry_triangles']}=="
              f"{entry['expected_hybrid_triangles']}, "
              f"render tris {entry['triangles']}, "
              f"face inflate delta {entry['face_overlay_inflate_max_delta_m']:.2e}, "
              f"stature {entry['stature_m']}")
    print(f"[verify] vocabulary match {report['checks']['vocabulary']['match']}, "
          f"rust missing {report['checks']['rust_vocabulary']['missing']}")
    print(f"[verify] manifest {report['checks']['manifest']}")
    print(f"[verify] {'PASS' if not failures else 'FAIL'}")
    for failure in failures:
        print(f"[verify]   {failure}")


if __name__ == "__main__":
    main()
