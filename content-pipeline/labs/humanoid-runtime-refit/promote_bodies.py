"""Promote the approved refined humanoids onto the runtime body paths.

Input  : the hash-pinned final Bunker refinement artifacts selected by
         `refit_config.REFINED` (body/head geometry + skin, no clips), the
         hash-pinned pre-refit body for each sex (canonical animated hands),
         and the hash-pinned pre-refit male runtime shell.
Output : `client-3d/public/assets/pawn-pack/pawn_{male,female}.glb`

The shell contributes everything the runtime contract pins down: the 52-node
layout, the 50 joints in their exact skin order, the inverse bind matrices, and
the 47 authored animation clips with their sampler data. Those accessors are
copied through verbatim, so the promoted bodies carry a bit-identical animation
bank rather than a re-export of it. The refined body supplies every non-hand
zone; the last known-good body supplies both hand zones with their original
weights. Materials and embedded textures are rebuilt around that hybrid mesh.

The shell is read from `build/reference/male.glb`, the hash-pinned pre-refit
body `reference_bodies.py` checks out of git, so promoting onto
`pawn-pack/pawn_male.glb` never consumes its own output and a re-run reproduces
the first byte for byte.

Per-body work:

  * joint remap -- the lab exporter emits the same 50 joints in a different skin
    order, so `JOINTS_0` is permuted into the shell's order and the shell's
    inverse bind matrices stay untouched;
  * hand graft -- the reviewed replacement hands separate from the forearms as
    soon as wrist clips run, so both leaf zones come verbatim from each sex's
    hash-pinned pre-refit body and are remapped into the shell joint order;
  * attribute prune -- `COLOR_0` is a constant white VEC3 (a no-op the loader
    still uploads) and `COLOR_1` is the lab's region-debug layer that three.js
    ignores; both are dropped from the runtime body;
  * face panel -- the authored `RB_Face` island fills a real hole in the head,
    so it is emitted once as opaque head skin and again 1.5 mm forward as a
    transparent, component-only overlay. The overlay UVs are normalised from
    the authored island. This preserves a closed, skin-toned head while the
    face texture carries no baked skin rectangle.

    python3 promote_bodies.py
"""

from __future__ import annotations

import hashlib
import json
import os
import sys
from typing import Any

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import body_zones as BZ  # noqa: E402
import canonical_hands as HANDS  # noqa: E402
import reference_bodies  # noqa: E402
import refit_config as CFG  # noqa: E402
from gltf_io import (Glb, GlbBuilder, TARGET_ARRAY_BUFFER,  # noqa: E402
                     TARGET_ELEMENT_ARRAY_BUFFER)

GENERATOR = "successor content-pipeline/labs/humanoid-runtime-refit/promote_bodies.py"

#: Smallest authored face-panel island the promotion will accept, as a fraction
#: of the UV square. The panel is measured per body, not assumed: `rb_v4` packs
#: it at u 0.241-0.759 and `rbf_v3` at u 0.267-0.733.
FACE_UV_MIN_SPAN = 0.05

REST_TRANSLATION_TOLERANCE = 1.0e-5
REST_ROTATION_TOLERANCE_DEG = 0.25
IBM_TOLERANCE = 1.0e-5

SAMPLER = {"magFilter": 9729, "minFilter": 9987, "wrapS": 33071, "wrapT": 33071}


def sha256_file(path: str) -> str:
    with open(path, "rb") as handle:
        return hashlib.sha256(handle.read()).hexdigest()


def srgb_to_linear(hex_color: str) -> list[float]:
    value = hex_color.lstrip("#")
    out = []
    for index in range(3):
        channel = int(value[index * 2: index * 2 + 2], 16) / 255.0
        out.append(channel / 12.92 if channel <= 0.04045
                   else ((channel + 0.055) / 1.055) ** 2.4)
    return out


def joint_table(glb: Glb) -> tuple[list[str], dict[str, int]]:
    nodes = glb.json["nodes"]
    joints = glb.json["skins"][0]["joints"]
    names = [nodes[index]["name"] for index in joints]
    return names, {name: slot for slot, name in enumerate(names)}


def rest_pose(glb: Glb) -> dict[str, dict]:
    nodes = glb.json["nodes"]
    parent = {}
    for index, node in enumerate(nodes):
        for child in node.get("children", ()):
            parent[child] = index
    out = {}
    for index in glb.json["skins"][0]["joints"]:
        node = nodes[index]
        out[node["name"]] = {
            "parent": nodes[parent[index]]["name"] if index in parent else None,
            "t": node.get("translation", [0.0, 0.0, 0.0]),
            "r": node.get("rotation", [0.0, 0.0, 0.0, 1.0]),
            "s": node.get("scale", [1.0, 1.0, 1.0]),
        }
    return out


def quaternion_degrees(a, b) -> float:
    dot = min(1.0, abs(sum(x * y for x, y in zip(a, b))))
    return float(np.degrees(2.0 * np.arccos(dot)))


def assert_compatible(shell: Glb, refined: Glb, body_id: str) -> dict:
    shell_rest, refined_rest = rest_pose(shell), rest_pose(refined)
    if set(shell_rest) != set(refined_rest):
        raise SystemExit(f"{body_id}: joint name sets differ")
    worst_t = worst_r = 0.0
    for name, want in shell_rest.items():
        got = refined_rest[name]
        if want["parent"] != got["parent"]:
            raise SystemExit(f"{body_id}: {name} parent {got['parent']} != {want['parent']}")
        worst_t = max(worst_t, max(abs(x - y) for x, y in zip(want["t"], got["t"])))
        worst_r = max(worst_r, quaternion_degrees(want["r"], got["r"]))
        if max(abs(x - y) for x, y in zip(want["s"], got["s"])) > 1e-6:
            raise SystemExit(f"{body_id}: {name} rest scale differs")
    if worst_t > REST_TRANSLATION_TOLERANCE:
        raise SystemExit(f"{body_id}: rest translation drift {worst_t}")
    if worst_r > REST_ROTATION_TOLERANCE_DEG:
        raise SystemExit(f"{body_id}: rest rotation drift {worst_r} deg")

    shell_names, _ = joint_table(shell)
    _, refined_slot = joint_table(refined)
    permutation = [refined_slot[name] for name in shell_names]
    shell_ibm = shell.accessor(shell.json["skins"][0]["inverseBindMatrices"]).reshape(-1, 4, 4)
    refined_ibm = refined.accessor(refined.json["skins"][0]["inverseBindMatrices"]).reshape(-1, 4, 4)
    ibm_drift = float(np.abs(shell_ibm - refined_ibm[permutation]).max())
    if ibm_drift > IBM_TOLERANCE:
        raise SystemExit(f"{body_id}: inverse bind matrix drift {ibm_drift}")
    return {"rest_translation_drift_m": worst_t,
            "rest_rotation_drift_deg": worst_r,
            "inverse_bind_drift": ibm_drift,
            "joint_permutation": permutation}


def normalise_face_uv(uv: np.ndarray,
                      body_id: str) -> tuple[np.ndarray, list[float]]:
    """Fit the authored panel island onto the full [0,1] square.

    The baked panel texture fills its own image, so the island has to be
    normalised for the face to bind without a texture transform. The island is
    MEASURED rather than assumed: the two approved bodies pack it at different
    widths, and a hardcoded rectangle would slide one body's face sideways.
    """
    rect = [float(uv[:, 0].min()), float(uv[:, 1].min()),
            float(uv[:, 0].max()), float(uv[:, 1].max())]
    u0, v0, u1, v1 = rect
    if not (0.0 <= u0 < u1 <= 1.0 and 0.0 <= v0 < v1 <= 1.0):
        raise SystemExit(f"{body_id}: face panel island {rect} leaves the UV square")
    if min(u1 - u0, v1 - v0) < FACE_UV_MIN_SPAN:
        raise SystemExit(f"{body_id}: face panel island {rect} is degenerate")
    out = uv.copy()
    out[:, 0] = (out[:, 0] - u0) / (u1 - u0)
    out[:, 1] = (out[:, 1] - v0) / (v1 - v0)
    return out, [round(value, 6) for value in rect]


def copy_accessor(source: Glb, builder: GlbBuilder, index: int,
                  cache: dict[int, int]) -> int:
    """Re-emit one source accessor into the rebuilt buffer, deduplicated."""
    if index in cache:
        return cache[index]
    accessor = source.json["accessors"][index]
    data = source.accessor(index)
    new_index = builder.add_accessor(np.ascontiguousarray(data))
    emitted = builder.json["accessors"][new_index]
    for key in ("min", "max", "normalized", "name"):
        if key in accessor:
            emitted[key] = accessor[key]
    cache[index] = new_index
    return new_index


def add_texture(builder: GlbBuilder, png_path: str, name: str,
                sampler_index: int) -> int:
    with open(png_path, "rb") as handle:
        payload = handle.read()
    view = builder.add_view(payload)
    builder.json.setdefault("images", []).append(
        {"name": name, "mimeType": "image/png", "bufferView": view})
    image_index = len(builder.json["images"]) - 1
    builder.json.setdefault("textures", []).append(
        {"name": name, "sampler": sampler_index, "source": image_index})
    return len(builder.json["textures"]) - 1


def build(body_id: str, source: str, report: dict) -> None:
    shell = Glb.load(CFG.RUNTIME_SHELL)
    refined = Glb.load(source)
    digest = sha256_file(source)

    compatibility = assert_compatible(shell, refined, body_id)
    permutation = compatibility.pop("joint_permutation")
    inverse = np.zeros(len(permutation), dtype=np.int64)   # refined slot -> shell slot
    for shell_slot, refined_slot in enumerate(permutation):
        inverse[refined_slot] = shell_slot
    # Zone shares are computed in the REFINED skin order, before the remap.
    refined_joints, _ = joint_table(refined)
    shell_joints, _ = joint_table(shell)
    hand_reference_path = reference_bodies.path_for(body_id)
    hand_reference = Glb.load(hand_reference_path)
    hand_compatibility = assert_compatible(
        shell, hand_reference, f"{body_id} canonical hands")
    hand_compatibility.pop("joint_permutation")
    canonical_hands = HANDS.extract(hand_reference, shell_joints)
    gltf: dict[str, Any] = {
        "asset": {"version": "2.0", "generator": GENERATOR},
        "scene": 0,
        "scenes": json.loads(json.dumps(shell.json["scenes"])),
        "nodes": json.loads(json.dumps(shell.json["nodes"])),
        "skins": json.loads(json.dumps(shell.json["skins"])),
        "animations": json.loads(json.dumps(shell.json["animations"])),
    }
    builder = GlbBuilder(gltf)
    cache: dict[int, int] = {}

    # --- skeleton + animation bank, copied straight through -----------------
    skin = gltf["skins"][0]
    skin["inverseBindMatrices"] = copy_accessor(
        shell, builder, shell.json["skins"][0]["inverseBindMatrices"], cache)
    for animation in gltf["animations"]:
        for sampler in animation["samplers"]:
            sampler["input"] = copy_accessor(shell, builder, sampler["input"], cache)
            sampler["output"] = copy_accessor(shell, builder, sampler["output"], cache)

    # --- materials + the transparent default face overlay ------------------
    # Skin shading is per-vertex `COLOR_0`, not a map: the approved heads carry
    # an authored UV set whose head island folds front onto back. The face panel
    # is emitted as ordinary head skin, then duplicated just proud of the head
    # with the component-only RGBA texture. That split is load-bearing: using a
    # skin-filled face texture makes the entire panel render as a dark mask.
    builder.json["samplers"] = [dict(SAMPLER)]
    tone = srgb_to_linear(CFG.DEFAULT_SKIN_HEX)
    face_texture = os.path.join(CFG.TEXTURE_DIR, "face_default.png")
    skin_pbr: dict[str, Any] = {"baseColorFactor": tone + [1.0],
                                "metallicFactor": 0.0, "roughnessFactor": 0.82}
    materials = [{"name": BZ.material_name(zone), "doubleSided": True,
                  "pbrMetallicRoughness": dict(skin_pbr)} for zone in BZ.ZONES]
    face_slot = len(materials)
    materials.append({
        "name": CFG.MATERIALS[body_id]["face"],
        "doubleSided": True,
        "alphaMode": "BLEND",
        "pbrMetallicRoughness": {
            "baseColorFactor": [1.0, 1.0, 1.0, 1.0],
            "metallicFactor": 0.0,
            "roughnessFactor": 0.82,
            "baseColorTexture": {
                "index": add_texture(builder, face_texture, f"{body_id}_face", 0),
            },
        },
    })
    builder.json["materials"] = materials

    source_primitives = refined.json["meshes"][0]["primitives"]
    shading = np.load(os.path.join(CFG.BUILD_DIR, f"{body_id}_vertex_ao.npy"))
    if len(shading) != sum(refined.json["accessors"][p["attributes"]["POSITION"]]["count"]
                           for p in source_primitives):
        raise SystemExit(f"{body_id}: baked shading does not match the body vertex count")

    # --- one soup of skin, plus the face panel kept aside -------------------
    source_material = [refined.json["materials"][p["material"]]["name"]
                       for p in source_primitives]
    if source_material.count(BZ.FACE_MATERIAL) != 1:
        raise SystemExit(f"{body_id}: expected exactly one {BZ.FACE_MATERIAL} "
                         f"primitive, found {source_material}")
    panel_slot = source_material.index(BZ.FACE_MATERIAL)

    columns: dict[str, list[np.ndarray]] = {key: [] for key in
                                            ("POSITION", "NORMAL", "JOINTS_0",
                                             "WEIGHTS_0")}
    skin_faces: list[np.ndarray] = []
    skin_shading: list[np.ndarray] = []
    merged_from: list[dict] = []
    cursor = 0
    soup = 0
    for slot, primitive in enumerate(source_primitives):
        count = refined.json["accessors"][primitive["attributes"]["POSITION"]]["count"]
        if slot != panel_slot:
            for key, values in columns.items():
                values.append(refined.accessor(primitive["attributes"][key]))
            skin_faces.append(refined.accessor(primitive["indices"]
                                               ).astype(np.int64).reshape(-1, 3) + soup)
            skin_shading.append(shading[cursor: cursor + count])
            merged_from.append({"slot": slot, "material": source_material[slot],
                                "vertices": int(count)})
            soup += count
        cursor += count

    position = np.concatenate(columns["POSITION"]).astype(np.float64)
    normal = np.concatenate(columns["NORMAL"]).astype(np.float32)
    joints = np.concatenate(columns["JOINTS_0"]).astype(np.int64)
    weights = np.concatenate(columns["WEIGHTS_0"]).astype(np.float64)
    faces = np.concatenate(skin_faces)
    shade = np.concatenate(skin_shading)

    totals = weights.sum(axis=1, keepdims=True)
    if float(np.abs(totals - 1.0).max()) > 1.0e-4:
        raise SystemExit(f"{body_id}: skin weights not normalised")
    weights = weights / totals
    labels, zone_report = BZ.segment(position, faces, refined_joints, joints,
                                     weights, body_id)

    # Zero-weight slots point at joint 0 so a stray index can never name a bone
    # the weight row does not actually use.
    remapped = inverse[joints].astype(np.uint8)
    remapped[weights <= 0.0] = 0
    colour = np.empty((len(position), 4), dtype=np.uint8)
    colour[:, 0] = colour[:, 1] = colour[:, 2] = np.rint(
        np.clip(shade, 0.0, 1.0) * 255.0).astype(np.uint8)
    colour[:, 3] = 255
    position32 = position.astype(np.float32)
    weights32 = weights.astype(np.float32)

    # --- mesh: one primitive per zone, then the panel -----------------------
    primitives = []
    stats = []
    for index, zone in enumerate(BZ.ZONES):
        if zone in HANDS.HAND_ZONES:
            hand = canonical_hands[zone]
            zone_position = hand["POSITION"]
            zone_normal = hand["NORMAL"]
            zone_joints = hand["JOINTS_0"]
            zone_weights = hand["WEIGHTS_0"]
            zone_faces = hand["indices"]
            indices = zone_faces.reshape(-1)
            zone_colour = np.full((len(zone_position), 4), 255, dtype=np.uint8)
            area_cm2 = round(
                float(BZ.triangle_areas(zone_position, zone_faces).sum()) * 1.0e4, 3)
            shading_min = shading_mean = 1.0
        else:
            picked = faces[labels == index]
            # `return_inverse` renumbers the zone's corners into a compact local
            # vertex range; glTF wants the result flat and SCALAR.
            used, indices = np.unique(picked, return_inverse=True)
            indices = indices.reshape(-1)
            zone_position = position32[used]
            zone_normal = normal[used]
            zone_joints = remapped[used]
            zone_weights = weights32[used]
            zone_colour = colour[used]
            area_cm2 = zone_report["zones"][zone]["area_cm2"]
            shading_min = float(shade[used].min())
            shading_mean = float(shade[used].mean())
        primitives.append({
            "attributes": {
                "POSITION": builder.add_accessor(
                    zone_position, target=TARGET_ARRAY_BUFFER, minmax=True),
                "NORMAL": builder.add_accessor(zone_normal, target=TARGET_ARRAY_BUFFER),
                "JOINTS_0": builder.add_accessor(zone_joints, target=TARGET_ARRAY_BUFFER),
                "WEIGHTS_0": builder.add_accessor(
                    zone_weights, target=TARGET_ARRAY_BUFFER),
                "COLOR_0": builder.add_accessor(
                    zone_colour, target=TARGET_ARRAY_BUFFER, normalized=True),
            },
            "indices": builder.add_accessor(
                indices.astype(np.uint16) if len(zone_position) <= 65535
                else indices.astype(np.uint32),
                target=TARGET_ELEMENT_ARRAY_BUFFER),
            "material": index,
        })
        stat = {"material": BZ.material_name(zone), "zone": zone,
                "vertices": int(len(zone_position)),
                "triangles": int(len(indices) // 3),
                "area_cm2": area_cm2,
                "shading_min": shading_min,
                "shading_mean": shading_mean}
        if zone in HANDS.HAND_ZONES:
            stat["geometry_source"] = os.path.relpath(hand_reference_path, CFG.REPO)
        stats.append(stat)

    panel = source_primitives[panel_slot]
    panel_count = refined.json["accessors"][panel["attributes"]["POSITION"]]["count"]
    panel_start = sum(refined.json["accessors"][p["attributes"]["POSITION"]]["count"]
                      for p in source_primitives[:panel_slot])
    panel_shade = shading[panel_start: panel_start + panel_count]
    panel_position = refined.accessor(panel["attributes"]["POSITION"]).astype(np.float32)
    panel_normal = refined.accessor(panel["attributes"]["NORMAL"]).astype(np.float32)
    panel_joints = refined.accessor(panel["attributes"]["JOINTS_0"]).astype(np.int64)
    panel_weights = refined.accessor(panel["attributes"]["WEIGHTS_0"]).astype(np.float64)
    panel_totals = panel_weights.sum(axis=1, keepdims=True)
    if float(np.abs(panel_totals - 1.0).max()) > 1.0e-4:
        raise SystemExit(f"{body_id}: face panel weights not normalised")
    panel_weights = panel_weights / panel_totals
    panel_remapped = inverse[panel_joints].astype(np.uint8)
    panel_remapped[panel_weights <= 0.0] = 0
    panel_colour = np.empty((panel_count, 4), dtype=np.uint8)
    panel_colour[:, 0] = panel_colour[:, 1] = panel_colour[:, 2] = np.rint(
        np.clip(panel_shade, 0.0, 1.0) * 255.0).astype(np.uint8)
    panel_colour[:, 3] = 255
    panel_uv, panel_rect = normalise_face_uv(
        refined.accessor(panel["attributes"]["TEXCOORD_0"]).astype(np.float64), body_id)
    panel_indices = refined.accessor(panel["indices"]).astype(np.uint16)

    panel_normal_accessor = builder.add_accessor(panel_normal, target=TARGET_ARRAY_BUFFER)
    panel_joints_accessor = builder.add_accessor(panel_remapped, target=TARGET_ARRAY_BUFFER)
    panel_weights_accessor = builder.add_accessor(
        panel_weights.astype(np.float32), target=TARGET_ARRAY_BUFFER)
    panel_indices_accessor = builder.add_accessor(
        panel_indices, target=TARGET_ELEMENT_ARRAY_BUFFER)

    # The source panel fills a real opening. First emit it as ordinary opaque
    # head skin so transparent face pixels reveal the same material as the skull.
    primitives.append({
        "attributes": {
            "POSITION": builder.add_accessor(
                panel_position, target=TARGET_ARRAY_BUFFER, minmax=True),
            "NORMAL": panel_normal_accessor,
            "JOINTS_0": panel_joints_accessor,
            "WEIGHTS_0": panel_weights_accessor,
            "COLOR_0": builder.add_accessor(
                panel_colour, target=TARGET_ARRAY_BUFFER, normalized=True),
        },
        "indices": panel_indices_accessor,
        "material": BZ.ZONES.index("head"),
    })
    stats.append({
        "material": BZ.material_name("head"),
        "zone": "head",
        "role": "face_panel_skin_base",
        "vertices": int(panel_count),
        "triangles": int(len(panel_indices) // 3),
        "shading_min": float(panel_shade.min()),
        "shading_mean": float(panel_shade.mean()),
    })

    # Then duplicate only the panel as a transparent feature overlay. It omits
    # COLOR_0 deliberately: ambient-occlusion vertex colour must not darken the
    # eyes, brows, nose, or mouth.
    overlay_position = panel_position + panel_normal * CFG.FACE_OVERLAY_INFLATE
    primitives.append({
        "attributes": {
            "POSITION": builder.add_accessor(
                overlay_position, target=TARGET_ARRAY_BUFFER, minmax=True),
            "NORMAL": panel_normal_accessor,
            "JOINTS_0": panel_joints_accessor,
            "WEIGHTS_0": panel_weights_accessor,
            "TEXCOORD_0": builder.add_accessor(
                panel_uv.astype(np.float32), target=TARGET_ARRAY_BUFFER),
        },
        "indices": panel_indices_accessor,
        "material": face_slot,
    })
    stats.append({
        "material": CFG.MATERIALS[body_id]["face"],
        "zone": None,
        "role": "transparent_face_overlay",
        "vertices": int(panel_count),
        "triangles": int(len(panel_indices) // 3),
        "inflate_m": CFG.FACE_OVERLAY_INFLATE,
    })
    builder.json["meshes"] = [{"name": "body", "primitives": primitives}]

    destination = CFG.RUNTIME_BODY[body_id]
    size = builder.write(destination)
    payload = open(destination, "rb").read()
    aliases = []
    for alias in CFG.RUNTIME_BODY_ALIAS[body_id]:
        with open(alias, "wb") as handle:
            handle.write(payload)
        aliases.append(os.path.relpath(alias, CFG.REPO))
    report[body_id] = {
        "output": os.path.relpath(destination, CFG.REPO),
        "aliases": aliases,
        "bytes": size,
        "sha256": sha256_file(destination),
        "source": os.path.relpath(source, CFG.REPO),
        "source_sha256": digest,
        "source_sidecar": json.load(open(CFG.REFINED_SIDECAR[body_id],
                                         encoding="utf-8")),
        "joints": len(skin["joints"]),
        "animations": len(gltf["animations"]),
        "animation_names": [a["name"] for a in gltf["animations"]],
        "merged_skin_primitives": merged_from,
        "face_panel_uv_rect": panel_rect,
        "primitives": stats,
        "zone_segmentation": zone_report,
        "compatibility": compatibility,
        "canonical_hand_source": {
            "path": os.path.relpath(hand_reference_path, CFG.REPO),
            "sha256": sha256_file(hand_reference_path),
            "compatibility": hand_compatibility,
        },
        "face_texture": os.path.relpath(os.path.join(CFG.TEXTURE_DIR, "face_default.png"), CFG.REPO),
    }
    print(f"[promote] {body_id}: {size} B, {len(stats)} primitives "
          f"({len(BZ.ZONES)} zones + face skin base + transparent overlay), "
          f"{len(gltf['animations'])} clips -> {report[body_id]['output']}"
          + (f" (+{len(aliases)} alias)" if aliases else ""))


def main() -> None:
    CFG.ensure_dirs()
    report: dict[str, Any] = {"generator": GENERATOR}
    reference_bodies.materialise()
    shell = Glb.load(CFG.RUNTIME_SHELL)
    if len(shell.json["skins"][0]["joints"]) != 50:
        raise SystemExit("runtime shell no longer carries 50 joints")
    if len(shell.json["animations"]) != 47:
        raise SystemExit(f"runtime shell carries {len(shell.json['animations'])} clips, expected 47")
    if any("sparse" in accessor for accessor in shell.json["accessors"]):
        raise SystemExit("runtime shell uses sparse accessors; the copy path cannot carry them")
    if shell.json.get("extensionsUsed"):
        raise SystemExit(f"runtime shell uses extensions {shell.json['extensionsUsed']}")
    report["shell_sha256"] = sha256_file(CFG.RUNTIME_SHELL)
    report["shell_animations"] = [a["name"] for a in shell.json["animations"]]
    del shell
    # Promote the exact final Bunker refinement artifacts. Shape corrections
    # have already been reviewed and must not be applied a second time here.
    sources = reference_bodies.promotion_inputs()
    approved = reference_bodies.refined()
    report["approved_sources"] = {
        body_id: {"path": os.path.relpath(path, CFG.REPO),
                  "sha256": sha256_file(path),
                  "promotes_directly": os.path.abspath(path) == os.path.abspath(sources[body_id])}
        for body_id, path in approved.items()}
    for body_id in ("female", "male"):
        build(body_id, sources[body_id], report)
    with open(os.path.join(CFG.REPORT_DIR, "promotion.json"), "w", encoding="utf-8") as handle:
        json.dump(report, handle, indent=2)


if __name__ == "__main__":
    main()
