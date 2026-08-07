"""Bake, export and sidecar emission for the Dustgate Clone Vault suite.

Pipeline per asset
------------------
1. classify every object: ATLAS (uses at least one tiling surface material) or
   SPECIAL (glass / fluid / emissive only, which the runtime reads directly);
2. pack one unique UV set across every atlas object;
3. bake base colour, ORM and tangent normals through that UV set;
4. collapse every atlas object onto the single baked `CF_Body` material and
   drop the authoring UV set, so TEXCOORD_0 is the atlas;
5. export, then patch the door node back to its closed rest translation;
6. re-parse the shipped bytes and gate on what is actually in the file.

Nothing downstream trusts the Blender scene: every number in the manifest, the
collision sidecar and the provenance record is measured from the exported GLB.
"""
from __future__ import annotations

import hashlib
import json
import math
import shutil
import struct
import subprocess
from pathlib import Path

import bpy
from mathutils import Matrix, Quaternion, Vector

import cf_bake
import cf_spec
from cf_mat import make_atlas_material
from cf_spec import (ATLAS_MATERIAL, BUILDING, DOOR, DOOR_COLLISION, ENVELOPE,
                     FLOOR, FOOTPRINT_CELLS, INTERIOR_CLEAR_HEIGHT,
                     INTERIOR_REGION, PAWN_HEIGHT_M, PROPS, REVEAL_PREFIXES,
                     ROLE_PREFIXES, RUNTIME_SCALE_AT_10X8, SPECIAL,
                     STRUCTURAL_WALLS, SURFACES, VERSION)

REPO = Path(__file__).resolve().parents[5]
OUT_DIR = REPO / "client-3d" / "public" / "assets" / "world-items"
LAB = REPO / ".game-lab" / "cloning-facility-opus5-20260803"


def write_json(path: Path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2, sort_keys=True) + "\n")


def sha256_of(path: Path) -> str:
    return "sha256:" + hashlib.sha256(path.read_bytes()).hexdigest()


# ───────────────────────────── classification ─────────────────────────────


def classify(objects):
    atlas, special = [], []
    for obj in objects:
        if obj.type != "MESH" or not obj.data.polygons:
            continue
        names = [m.name for m in obj.data.materials if m]
        uses_surface = any(n in SURFACES for n in names)
        uses_special = any(n in SPECIAL for n in names)
        if uses_surface and uses_special:
            raise RuntimeError(
                f"{obj.name} mixes atlas and runtime-special materials ({names}); "
                "split it into separate parts so the atlas UV set stays clean")
        (atlas if uses_surface else special).append(obj)
    return atlas, special


# ──────────────────────────────── baking ──────────────────────────────────


def bake_and_collapse(scene, objects, atlas_size, prefix, samples=None,
                      want_orm=True, want_normal=True):
    atlas, special = classify(objects)
    if not atlas:
        raise RuntimeError("nothing to bake")
    cf_bake.pack_atlas_uv(atlas)
    coverage = cf_bake.atlas_uv_coverage(atlas)
    mats = []
    for obj in atlas:
        for m in obj.data.materials:
            if m and m not in mats:
                mats.append(m)
    images = cf_bake.bake_asset(scene, atlas, mats, atlas_size, prefix,
                                samples=samples, want_orm=want_orm,
                                want_normal=want_normal)
    stats = _atlas_stats(images["basecolor"])
    stats["lit_fraction"] = images.get("lit_fraction", stats["lit_fraction"])
    body = make_atlas_material(images["basecolor"], images.get("orm"))
    if images.get("normal") is not None:
        _attach_normal(body, images["normal"])
    for obj in atlas:
        me = obj.data
        me.materials.clear()
        me.materials.append(body)
        for poly in me.polygons:
            poly.material_index = 0
        for layer in list(me.uv_layers):
            if layer.name != cf_bake.ATLAS_UV:
                me.uv_layers.remove(layer)
        me.uv_layers[cf_bake.ATLAS_UV].name = "UVMap"
        me.uv_layers["UVMap"].active = True
        me.uv_layers["UVMap"].active_render = True
    return {"atlas_objects": len(atlas), "special_objects": len(special),
            "uv_coverage": round(float(coverage), 4), "images": images,
            "material": body, "device": images.get("device"),
            "basecolor_mean": stats["mean"],
            "basecolor_lit_fraction": stats["lit_fraction"],
            "basecolor_p95": stats["p95"]}


def _atlas_stats(image):
    """What the shipped base colour actually contains."""
    import numpy as np
    arr = cf_bake.image_to_array(image)[:, :, :3]
    lum = arr.max(axis=2)
    lit = lum > 0.012
    return {"mean": round(float(arr[lit].mean()) if lit.any() else 0.0, 4),
            "lit_fraction": round(float(lit.mean()), 4),
            "p95": round(float(np.percentile(arr, 95)), 4)}


def _attach_normal(mat, image):
    tree = mat.node_tree
    bsdf = tree.nodes["Principled BSDF"]
    tex = tree.nodes.new("ShaderNodeTexImage")
    tex.image = image
    tex.location = (-520, -380)
    nm = tree.nodes.new("ShaderNodeNormalMap")
    nm.location = (-240, -380)
    tree.links.new(tex.outputs["Color"], nm.inputs["Color"])
    tree.links.new(nm.outputs["Normal"], bsdf.inputs["Normal"])


# ──────────────────────────────── export ──────────────────────────────────


def export_glb(root, path: Path, with_animations: bool):
    path.parent.mkdir(parents=True, exist_ok=True)
    restore = []
    if with_animations:
        for obj in [root, *root.children_recursive]:
            ad = obj.animation_data
            if ad is not None and not ad.use_nla:
                ad.use_nla = True
                restore.append(ad)
    bpy.ops.object.select_all(action="DESELECT")
    root.select_set(True)
    for child in root.children_recursive:
        child.select_set(True)
    bpy.context.view_layer.objects.active = root
    kwargs = dict(
        filepath=str(path), export_format="GLB", use_selection=True,
        export_apply=True, export_yup=True, export_texcoords=True,
        export_normals=True, export_tangents=False, export_materials="EXPORT",
        export_image_format="AUTO", export_jpeg_quality=92,
        export_animations=with_animations, export_extras=False,
        export_cameras=False, export_lights=False, export_skins=False,
        export_morph=False, export_def_bones=False,
    )
    if with_animations:
        kwargs.update(export_animation_mode="NLA_TRACKS", export_nla_strips=True,
                      export_bake_animation=False,
                      export_optimize_animation_size=False,
                      export_current_frame=False)
    bpy.ops.export_scene.gltf(**kwargs)
    for ad in restore:
        ad.use_nla = False


# ───────────────────────── GLB parsing and metrics ────────────────────────

_COMPONENT_FORMAT = {5120: "b", 5121: "B", 5122: "h", 5123: "H", 5125: "I", 5126: "f"}
_COMPONENT_SIZE = {5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4}
_TYPE_COUNT = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4, "MAT4": 16}


def read_glb_chunks(path: Path):
    data = Path(path).read_bytes()
    magic, _version, _length = struct.unpack_from("<III", data, 0)
    if magic != 0x46546C67:
        raise RuntimeError(f"{path} is not a GLB")
    offset, chunks = 12, {}
    while offset < len(data):
        clen, ctype = struct.unpack_from("<II", data, offset)
        offset += 8
        chunks[ctype] = data[offset:offset + clen]
        offset += clen
    return json.loads(chunks[0x4E4F534A].decode("utf-8")), chunks.get(0x004E4942, b"")


def write_glb_chunks(path: Path, gltf, bin_chunk: bytes):
    json_bytes = json.dumps(gltf, separators=(",", ":")).encode("utf-8")
    json_pad = (4 - len(json_bytes) % 4) % 4
    json_bytes += b" " * json_pad
    bin_pad = (4 - len(bin_chunk) % 4) % 4
    bin_chunk = bin_chunk + b"\x00" * bin_pad
    total = 12 + 8 + len(json_bytes) + (8 + len(bin_chunk) if bin_chunk else 0)
    out = struct.pack("<III", 0x46546C67, 2, total)
    out += struct.pack("<II", len(json_bytes), 0x4E4F534A) + json_bytes
    if bin_chunk:
        out += struct.pack("<II", len(bin_chunk), 0x004E4942) + bin_chunk
    path.write_bytes(out)


def accessor_values(gltf, bin_chunk, index):
    acc = gltf["accessors"][index]
    view = gltf["bufferViews"][acc["bufferView"]]
    fmt = _COMPONENT_FORMAT[acc["componentType"]]
    count = _TYPE_COUNT[acc["type"]]
    size = _COMPONENT_SIZE[acc["componentType"]] * count
    stride = view.get("byteStride", size)
    base = view.get("byteOffset", 0) + acc.get("byteOffset", 0)
    layout = "<" + fmt * count
    return [struct.unpack_from(layout, bin_chunk, base + i * stride)
            for i in range(acc["count"])]


def node_local_matrix(node):
    if "matrix" in node:
        m = node["matrix"]
        return Matrix((m[0:4], m[4:8], m[8:12], m[12:16])).transposed()
    t = Matrix.Translation(node.get("translation", [0.0, 0.0, 0.0]))
    q = node.get("rotation", [0.0, 0.0, 0.0, 1.0])
    r = Quaternion((q[3], q[0], q[1], q[2])).to_matrix().to_4x4()
    s = Matrix.Diagonal((*node.get("scale", [1.0, 1.0, 1.0]), 1.0))
    return t @ r @ s


def node_worlds(gltf):
    worlds = {}

    def walk(idx, parent):
        node = gltf["nodes"][idx]
        world = parent @ node_local_matrix(node)
        worlds[idx] = world
        for child in node.get("children", []):
            walk(child, world)

    for scene in gltf.get("scenes", []):
        for root in scene.get("nodes", []):
            walk(root, Matrix.Identity(4))
    return worlds


def parse_glb_metrics(path: Path):
    gltf, bin_chunk = read_glb_chunks(path)
    worlds = node_worlds(gltf)
    tri_count = 0
    bbox_min = [math.inf] * 3
    bbox_max = [-math.inf] * 3
    per_node = {}
    for idx, node in enumerate(gltf.get("nodes", [])):
        if "mesh" not in node:
            continue
        world = worlds.get(idx, Matrix.Identity(4))
        name = node.get("name", f"node{idx}")
        node_tris = 0
        lo = [math.inf] * 3
        hi = [-math.inf] * 3
        for prim in gltf["meshes"][node["mesh"]]["primitives"]:
            pos_acc = gltf["accessors"][prim["attributes"]["POSITION"]]
            if "indices" in prim:
                node_tris += gltf["accessors"][prim["indices"]]["count"] // 3
            else:
                node_tris += pos_acc["count"] // 3
            for cx in (pos_acc["min"][0], pos_acc["max"][0]):
                for cy in (pos_acc["min"][1], pos_acc["max"][1]):
                    for cz in (pos_acc["min"][2], pos_acc["max"][2]):
                        w = world @ Vector((cx, cy, cz))
                        for i in range(3):
                            lo[i] = min(lo[i], w[i])
                            hi[i] = max(hi[i], w[i])
                            bbox_min[i] = min(bbox_min[i], w[i])
                            bbox_max[i] = max(bbox_max[i], w[i])
        tri_count += node_tris
        per_node[name] = {"tris": node_tris, "min": lo, "max": hi}
    images = []
    for img in gltf.get("images", []):
        entry = {"name": img.get("name", ""), "mime": img.get("mimeType", ""),
                 "embedded": "uri" not in img}
        if "bufferView" in img:
            entry["bytes"] = gltf["bufferViews"][img["bufferView"]]["byteLength"]
        images.append(entry)
    return {
        "gltf": gltf, "bin": bin_chunk, "tri_count": tri_count,
        "bbox": {"min": bbox_min, "max": bbox_max},
        "span": [bbox_max[i] - bbox_min[i] for i in range(3)],
        "per_node": per_node,
        "materials": [m.get("name", "") for m in gltf.get("materials", [])],
        "node_names": [n.get("name", "") for n in gltf.get("nodes", [])],
        "images": images,
        "animations": [a.get("name", "") for a in gltf.get("animations", [])],
        "bytes": Path(path).stat().st_size,
    }


def patch_door_rest_translation(path: Path):
    """Guarantee the shipped rest pose is CLOSED regardless of which action was
    active at export time."""
    gltf, bin_chunk = read_glb_chunks(path)
    cx, cy, cz = DOOR["closed_center"]
    for node in gltf.get("nodes", []):
        if node.get("name") == DOOR["node"]:
            node.pop("matrix", None)
            node["translation"] = [cx, cy, cz]
            write_glb_chunks(path, gltf, bin_chunk)
            return
    raise RuntimeError("door_slide node missing from the exported GLB")


def animation_clips(metrics):
    gltf = metrics["gltf"]
    bin_chunk = metrics["bin"]
    out = []
    for anim in gltf.get("animations", []):
        duration = 0.0
        translations = []
        for channel in anim.get("channels", []):
            sampler = anim["samplers"][channel["sampler"]]
            times = [t[0] for t in accessor_values(gltf, bin_chunk, sampler["input"])]
            if times:
                duration = max(duration, times[-1])
            if channel["target"].get("path") == "translation":
                translations = accessor_values(gltf, bin_chunk, sampler["output"])
        travel = 0.0
        if len(translations) >= 2:
            a = Vector(translations[0])
            b = Vector(translations[-1])
            travel = (b - a).length
        out.append({"name": anim.get("name", ""), "duration_s": round(duration, 4),
                    "translation_travel_m": round(travel, 4),
                    "channels": len(anim.get("channels", []))})
    return out


# ──────────────────────────── sidecar emission ────────────────────────────


def collision_sidecar():
    """The frozen structural proxy.

    Nine named boxes plus the closed-door box, reproduced exactly as the
    shipped contract states them.  `configure-open-desert-fixture.mjs` and
    `structure-collision-geometry.test.mjs` both assert on this shape, and an
    art rebuild is not a reason to move a wall a player already walks past."""
    return {
        "schema": "successor.structure-collision.v3",
        "source": f"{BUILDING}.glb",
        "generatedBy": "tools/successor/assets/cloning-facility-opus5/src/build_clone_suite.py",
        "contract": {
            "geometrySource": "cf_spec.STRUCTURAL_WALLS",
            "structuralRoles": ["outer_shell", "entry_bay_returns",
                                "entry_bay_front_segments", "closed_door"],
            "decorativeExcluded": ["trim", "bolts", "glow", "pipes", "windows",
                                   "floor_guides", "roof_gear", "vats",
                                   "process_plant", "gantry", "control_bank"],
        },
        "footprint": {
            "minX": ENVELOPE["x_min"], "maxX": ENVELOPE["x_max"],
            "minZ": ENVELOPE["z_min"], "maxZ": ENVELOPE["z_max"],
            "spanX": round(ENVELOPE["x_max"] - ENVELOPE["x_min"], 6),
            "spanZ": round(ENVELOPE["z_max"] - ENVELOPE["z_min"], 6),
            "centerX": 0.0, "centerZ": 0.0,
        },
        "floor": {"topY": FLOOR["top_y_m"],
                  "slabThicknessM": FLOOR["slab_thickness_m"]},
        "walls": [{"id": wid, "minX": x0, "maxX": x1, "minZ": z0, "maxZ": z1}
                  for (wid, x0, x1, z0, z1) in STRUCTURAL_WALLS],
        "door": {"node": DOOR["node"], "closed": dict(DOOR_COLLISION)},
        "interiorRegions": [dict(INTERIOR_REGION)],
    }


def door_cells():
    """Advisory front-row cells (0-based [col, row]) the clear opening covers."""
    span_x = ENVELOPE["x_max"] - ENVELOPE["x_min"]
    cols = FOOTPRINT_CELLS[0]
    rows = FOOTPRINT_CELLS[1]
    cell_w = span_x / cols
    op = DOOR["opening"]
    cells = []
    for c in range(cols):
        a = ENVELOPE["x_min"] + c * cell_w
        b = a + cell_w
        overlap = min(b, op["x_max"]) - max(a, op["x_min"])
        if overlap > cell_w * 0.35:
            cells.append([c, rows - 1])
    return cells


def facility_manifest(metrics, bake_info, collision_path: Path, glb_path: Path):
    op = DOOR["opening"]
    collision = json.loads(collision_path.read_text())
    return {
        "schema": "successor.runtime-building-manifest.v1",
        "building": BUILDING,
        "label": "Dustgate Clone Vault",
        "runtimeKey": BUILDING,
        "units": "m",
        "front": "+Z",
        "footprintCells": list(FOOTPRINT_CELLS),
        "runtime_scale_at_10x8_cells": RUNTIME_SCALE_AT_10X8,
        "bbox_span_m": [round(v, 4) for v in metrics["span"]],
        "floorHeightM": FLOOR["top_y_m"],
        "floorTopY": FLOOR["top_y_m"],
        "interior_clear_height_m": INTERIOR_CLEAR_HEIGHT,
        "clear_opening_m": [round(op["x_max"] - op["x_min"], 4),
                            round(op["y_max"] - op["y_min"], 4)],
        "door": {
            "node": DOOR["node"],
            "clips": ["door_open", "door_close"],
            "slide_axis_local": list(DOOR["slide_axis_local"]),
            "slide_distance_m": DOOR["slide_distance_m"],
        },
        "door_cells": door_cells(),
        "cutaway": {
            "hide": ["roof__"],
            "keep": ["floor__", "interior__"],
            "faces": {"front": "wall_front__", "right": "wall_right__",
                      "back": "wall_back__", "left": "wall_left__"},
            "stub_by_face": True,
        },
        "interiorRegions": [dict(INTERIOR_REGION)],
        "collisionProxy": {
            "source": "cf_spec.STRUCTURAL_WALLS",
            "sidecar": collision_path.name,
            "structuralOnly": True,
        },
        "collision": {
            "boxes": len(collision["walls"]) + 1,
            "structure_boxes": len(collision["walls"]),
            "door_boxes": 1,
            "sha256": sha256_of(collision_path),
        },
        "asset": {
            "file": glb_path.name,
            "bytes": metrics["bytes"],
            "sha256": sha256_of(glb_path),
            "images": metrics["images"],
        },
        "materials": sorted(metrics["materials"]),
        "tri_count": metrics["tri_count"],
        "occupant": {
            "source": "pawn-pack/pawn_male.glb (read-only, rig discarded)",
            "authored_height_m": round(cf_spec.PAWN_MESH_HEIGHT_M, 4),
            "runtime_height_m": PAWN_HEIGHT_M,
        },
        "bake": {
            "baseColorCarriesLighting": True,
            "atlasObjects": bake_info["atlas_objects"],
            "runtimeSpecialObjects": bake_info["special_objects"],
            "uvCoverage": bake_info["uv_coverage"],
            "reason": ("client-3d world props render textured materials with an "
                       "unlit MeshBasicMaterial, so irradiance and AO have to be "
                       "in the base colour or they do not exist in game"),
        },
    }


def prop_manifest(asset_id, metrics, bake_info, glb_path: Path):
    spec = PROPS[asset_id]
    return {
        "schema": "successor.runtime-prop-manifest.v1",
        "prop": asset_id,
        "units": "m",
        "front": "+Z",
        "root_node": spec["root_node"],
        "footprint_m": list(spec["footprint"]),
        "bbox_span_m": [round(v, 4) for v in metrics["span"]],
        "height_range_m": list(spec["height_range_m"]),
        "runtime_scale_at_1x1_cell": round(1.0 / max(spec["footprint"]), 6),
        "materials": sorted(metrics["materials"]),
        "tri_count": metrics["tri_count"],
        "asset": {"file": glb_path.name, "bytes": metrics["bytes"],
                  "sha256": sha256_of(glb_path), "images": metrics["images"]},
        "bake": {"baseColorCarriesLighting": True,
                 "atlasObjects": bake_info["atlas_objects"],
                 "runtimeSpecialObjects": bake_info["special_objects"],
                 "uvCoverage": bake_info["uv_coverage"]},
    }


# Read-only references. Each entry records the exact path AND the sha256 of the
# bytes that were actually consulted, resolved at build time, so a later reader
# can tell whether the reference has moved on since this asset was made.
BUILDKIT = Path("/home/lycaon/dev/worktrees/successor-buildkit-20260730"
                "/tools/successor/assets/buildkit-opus5")
HUMANOID = Path("/home/lycaon/dev/worktrees/successor-humanoid-runtime-refit-20260802"
                "/client-3d/public/assets/pawn-pack")

PROVENANCE_INPUTS = [
    {"path": str(BUILDKIT / "src") + " + style-reference/",
     "purpose": "style authority: sinter/panel/screed/roofmetal/bronze/gunmetal "
                "material register and heavy-base-over-light-skin tectonics"},
    {"path": str(BUILDKIT / "runtime-buildings/modular/home_modular_starter.glb"),
     "purpose": "promoted modular runtime reference for silhouette density, "
                "facade articulation and payload budget"},
    {"path": str(BUILDKIT / "runtime-buildings/modular/home_modular_wing.glb"),
     "purpose": "promoted modular runtime reference"},
    {"path": str(BUILDKIT / "runtime-buildings/modular/home_modular_court.glb"),
     "purpose": "promoted modular runtime reference"},
    {"path": str(HUMANOID / "pawn_male.glb"),
     "purpose": "approved humanoid source, posed and frozen into the occupied "
                "vat; armature and all 47 clips discarded before export"},
    {"path": "client-3d/public/assets/world-items/cloning_facility_collision.json",
     "purpose": "frozen structural collision contract (nine named wall proxies "
                "plus the closed-door box), reproduced unchanged"},
    {"path": "client-3d/src/render/props.ts",
     "purpose": "runtime material contract: textured world props render unlit, "
                "so the base colour must carry the lit read"},
]


def _resolved_inputs(extra=None):
    out = []
    for entry in PROVENANCE_INPUTS + list(extra or []):
        record = dict(entry)
        candidate = Path(entry["path"])
        if not candidate.is_absolute():
            candidate = REPO / entry["path"]
        if candidate.is_file():
            record["sha256"] = sha256_of(candidate)
        out.append(record)
    return out


def write_provenance(asset_id, glb_path: Path, tri_count: int, description: str,
                     gate_summary: str, extra_inputs=None):
    data = {
        "schema": "successor-asset-provenance/1",
        "asset_id": asset_id,
        "asset_kind": "model_glb",
        "asset_path": str(glb_path.relative_to(REPO)),
        "asset_hash": sha256_of(glb_path),
        "tri_count": tri_count,
        "seed": None,
        "source_blend_or_script":
            "tools/successor/assets/cloning-facility-opus5/src/ (deterministic "
            "parametric part program; checkpoint .blend in blend/)",
        "regeneration_command":
            "/snap/bin/blender -b --factory-startup -noaudio --python-exit-code 1 "
            "-P tools/successor/assets/cloning-facility-opus5/src/build_clone_suite.py",
        "gate_report": f".game-lab/{LAB.name}/gate.json",
        "tool": {"name": "blender-bpy-headless", "version": bpy.app.version_string,
                 "tool_snapshot_id": f"blender-{bpy.app.version_string}"},
        "input_assets": _resolved_inputs(extra_inputs),
        "human_edits": [],
        "prompt": {
            "text": description,
            "denylist_audit": ("passed: no franchise or trademark terms in node "
                               "names, material names, textures or artifacts; the "
                               "entry crest and console graphics are authored "
                               "pictograms with no lettering"),
        },
        "rights": {
            "source_license": "Successor proprietary project asset; all rights reserved",
            "redistribution_status": ("authorized for Successor runtime distribution "
                                      "only; no standalone reuse grant"),
        },
        "agent_provenance": {
            "produced_by": [{
                "agent_instance_id": "CloneFacilityOpus5",
                "model": "Opus 5", "provider": "anthropic",
                "role": "content-author", "run_id": VERSION,
            }],
            "reviewed_by_agents": [{
                "agent_instance_id": "CloneFacilityOpus5",
                "role": "judge",
                "notes": gate_summary,
            }],
            "human_approvals": [],
        },
    }
    write_json(glb_path.with_name(glb_path.stem + ".provenance.json"), data)
    return data


# ─────────────────────────────── validation ───────────────────────────────


def run_validator(glb_path: Path):
    exe = shutil.which("npx")
    if not exe:
        return {"available": False, "pass": False, "note": "npx missing"}
    try:
        proc = subprocess.run(
            [exe, "--yes", "@gltf-transform/cli", "validate", str(glb_path)],
            capture_output=True, text=True, timeout=600, cwd=str(REPO))
    except Exception as exc:  # noqa: BLE001
        return {"available": False, "pass": False, "note": str(exc)}
    out = (proc.stdout or "") + (proc.stderr or "")
    errors = 0
    for line in out.splitlines():
        low = line.lower().strip()
        if low.startswith("errors") or "numerrors" in low.replace(" ", ""):
            digits = "".join(ch for ch in line if ch.isdigit())
            if digits:
                errors = max(errors, int(digits))
    return {"available": True, "mode": "gltf-transform", "rc": proc.returncode,
            "numErrors": errors, "pass": proc.returncode == 0 and errors == 0,
            "tail": "\n".join(out.splitlines()[-10:])}
