"""Regenerate the runtime bodies' provenance sidecars from the actual build.

The checked-in `pawn_male.provenance.json` still described the 2026-07-21
accessory body (2752 body vertices, hash 6eaac906...) and there was no female
sidecar at all, so the tree documented a lineage that no longer ships. Every
field here is read back out of this run's reports and the files on disk.

    blender --background --python write_provenance.py
"""

from __future__ import annotations

import hashlib
import json
import os
import sys

LAB_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, LAB_DIR)

import body_zones as BZ  # noqa: E402
import refit_config as CFG  # noqa: E402

GENERATOR = "successor content-pipeline/labs/humanoid-runtime-refit/write_provenance.py"
SCHEMA = "successor-asset-provenance/1"


def sha256_file(path: str) -> str:
    with open(path, "rb") as handle:
        return "sha256:" + hashlib.sha256(handle.read()).hexdigest()


def load(name: str) -> dict:
    with open(os.path.join(CFG.REPORT_DIR, name), encoding="utf-8") as handle:
        return json.load(handle)


def main() -> None:
    promotion = load("promotion.json")
    verification = load("body_zone_verification.json")
    coverage = load("body_zone_coverage.json")

    written = []
    for body_id in ("male", "female"):
        entry = promotion[body_id]
        checks = verification["bodies"][body_id]
        targets = [(body_id, CFG.RUNTIME_BODY[body_id], None)]
        for alias in CFG.RUNTIME_BODY_ALIAS[body_id]:
            targets.append((f"{body_id}_bare", alias, CFG.RUNTIME_BODY[body_id]))
        for asset_id, path, alias_of in targets:
            source = {
                "approved_body": promotion["approved_sources"][body_id]["path"],
                "approved_body_hash": "sha256:" + promotion["approved_sources"][body_id]["sha256"],
                "promotion_input": entry["source"],
                "promotion_input_hash": "sha256:" + entry["source_sha256"],
                "runtime_shell": os.path.relpath(CFG.RUNTIME_SHELL, CFG.REPO),
                "runtime_shell_hash": "sha256:" + promotion["shell_sha256"],
                "sidecar": entry["source_sidecar"],
                "generator": promotion["generator"],
                "pipeline": [
                    "reference_bodies.py (hash-pinned shell + approved sources)",
                    "bake_body_shading.py (per-vertex AO)",
                    "bake_face_texture.py (background-erased RGBA components)",
                    "promote_bodies.py (zone split + face skin base/overlay + accessor transplant)",
                ],
            }
            if alias_of:
                source["alias_of"] = os.path.relpath(alias_of, CFG.REPO)
                source["reason"] = (
                    "game_pack.json pawns.male.bare_file; the refit unified the "
                    "accommodation body and its full-volume sibling, so the bare "
                    "path is the same mesh and must carry the same zone primitives")
            document = {
                "schema": SCHEMA,
                "asset_id": f"pawn_{asset_id}",
                "asset_path": os.path.relpath(path, CFG.REPO),
                "asset_hash": sha256_file(path),
                "asset_kind": "pawn_body_glb",
                "source": source,
                "segmentation": {
                    "vocabulary": list(BZ.ZONES),
                    "material_pattern": f"{BZ.MATERIAL_PREFIX}<zone>",
                    "face_overlay_primitive": BZ.FACE_MATERIAL,
                    "face_skin_base_material": BZ.material_name("head"),
                    "method": ("per-tree-edge weight cuts, relaxed over the welded "
                               "dual graph, descended from the pelvis"),
                    "seams": entry["zone_segmentation"]["seams"],
                    "specks_absorbed": entry["zone_segmentation"]["specks_absorbed"],
                    "zones": entry["zone_segmentation"]["zones"],
                },
                "metrics": {
                    "bytes": entry["bytes"],
                    "joints": entry["joints"],
                    "animations": entry["animations"],
                    "primitives": len(entry["primitives"]),
                    "triangles": checks["triangles"],
                    "source_triangles": checks["source_triangles"],
                    "height_max_y_m": checks["stature_m"],
                },
                "validation": {
                    "materials_exact": checks["materials_exact"],
                    "joint_order_identical_to_shell": checks["joints_match_shell"],
                    "clip_names_identical_to_shell": checks["clips_match_shell"],
                    "inverse_bind_max_delta": checks["inverse_bind_max_delta"],
                    "index_accessor_types": checks["index_accessor_types"],
                    "zone_material_pbr_variants": checks["skin_material_variants"],
                    "welded_points_identical_to_source":
                        checks["welded_points_identical_to_source"],
                    "compatibility": entry["compatibility"],
                    "gate": "content-pipeline/labs/humanoid-runtime-refit/verify_body_zones.py",
                    "reports": sorted(os.path.relpath(
                        os.path.join(CFG.REPORT_DIR, name), CFG.REPO)
                        for name in os.listdir(CFG.REPORT_DIR)
                        if name.endswith(".json")),
                },
                "coverage": {
                    "manifest": coverage["manifest"]["path"],
                    "manifest_hash": "sha256:" + coverage["manifest"]["sha256"],
                    "items": len(coverage["items"]),
                    "items_with_coverage": coverage["manifest"]["items_with_coverage"],
                    "items_with_female_variant":
                        coverage["manifest"]["items_with_female_variant"],
                },
                "generator": GENERATOR,
            }
            destination = os.path.splitext(path)[0] + ".provenance.json"
            with open(destination, "w", encoding="utf-8") as handle:
                json.dump(document, handle, indent=2)
                handle.write("\n")
            written.append(os.path.relpath(destination, CFG.REPO))
            print(f"[provenance] {document['asset_id']:12s} {document['asset_hash'][:19]} "
                  f"-> {written[-1]}")
    print(f"[provenance] {len(written)} sidecars")


if __name__ == "__main__":
    main()
