"""Render the proofs the numbers stand behind: final bodies and starter kit.

Geometry comes from `pose_probe`, not from Blender's own armature import. That is
deliberate: importing three GLBs gives three armatures, and the garments carry no
animation of their own, so an imported "posed" scene renders an animated body with
its clothes frozen in the bind pose. Skinning the vertices with the same joint
matrices the runtime uses -- which is what the fit gate measures -- means the
render shows exactly what was measured.

Solid-shaded orthographic views, deliberately plain, with the layers tinted so a
5 mm bodysuit is actually visible. Cells land in `proof/` (gitignored) and every
one is hashed into `reports/proof_manifest.json`.

    blender --background --python proof_renders.py
"""

from __future__ import annotations

import hashlib
import json
import math
import os
import sys

import bpy
import numpy as np

LAB_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, LAB_DIR)

import body_zones as BZ  # noqa: E402
import pose_probe as POSE  # noqa: E402
import refit_config as CFG  # noqa: E402
from gltf_io import Glb  # noqa: E402

GENERATOR = "successor content-pipeline/labs/humanoid-runtime-refit/proof_renders.py"

SIZE = 720
#: Camera azimuths, degrees clockwise from straight-on FRONT. 180 is the rear (the
#: posterior view), 225 the rear three-quarter, 270 the left side.
VIEWS = {"front": 0.0, "side": 270.0, "threequarter": 225.0, "rear": 180.0}
#: Layer tints. One flat tone hides a 5 mm shell completely.
SKIN = (0.88, 0.63, 0.42, 1.0)
SUIT = (0.06, 0.42, 0.58, 1.0)
BOOT = (0.06, 0.06, 0.08, 1.0)
#: Poses the loadout is shown in: bind, a deep crouch, and the cross-legged sit
#: the fit gate reports as its worst case.
#: Both sexes get the same set: a bind reference plus three motions, so the
#: movement proof is not male-only.
LOADOUT_POSES = ((None, 0.0, ""), ("walk_f", 0.25, "_walk"),
                 ("crouch_idle", 0.5, "_crouch"),
                 ("meditate_loop", 0.5, "_meditate"))


def reset() -> None:
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    scene.render.engine = "BLENDER_WORKBENCH"
    scene.render.resolution_x = SIZE
    scene.render.resolution_y = SIZE
    shading = scene.display.shading
    shading.light = "STUDIO"
    shading.color_type = "OBJECT"
    shading.show_cavity = True


def to_blender(vertices: np.ndarray) -> np.ndarray:
    """glTF is Y-up, Blender is Z-up.

    The GLB importer does this for you; feeding raw accessor values straight in
    lays the pawn on its back and every camera framing is then wrong.
    """
    return np.column_stack([vertices[:, 0], -vertices[:, 2], vertices[:, 1]])


def add(name: str, vertices: np.ndarray, faces: np.ndarray, rgba) -> None:
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata([tuple(v) for v in to_blender(vertices)], [],
                     [tuple(f) for f in faces])
    mesh.update()
    obj = bpy.data.objects.new(name, mesh)
    obj.color = rgba
    bpy.context.scene.collection.objects.link(obj)


def frame(azimuth: float, height: float = 0.9, radius: float = 2.4,
          scale: float = 2.0) -> None:
    angle = math.radians(azimuth)
    data = bpy.data.cameras.new("proof")
    data.type = "ORTHO"
    data.ortho_scale = scale
    camera = bpy.data.objects.new("proof", data)
    bpy.context.scene.collection.objects.link(camera)
    camera.location = (radius * math.sin(angle), -radius * math.cos(angle), height)
    camera.rotation_euler = (math.radians(90.0), 0.0, angle)
    bpy.context.scene.camera = camera


def render(name: str, cells: dict) -> None:
    path = os.path.join(CFG.PROOF_DIR, "cells", f"{name}.png")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    bpy.context.scene.render.filepath = path
    bpy.ops.render.render(write_still=True)
    cells[name] = {"path": os.path.relpath(path, CFG.REPO),
                   "sha256": hashlib.sha256(open(path, "rb").read()).hexdigest(),
                   "bytes": os.path.getsize(path)}
    print(f"[proof] {name} -> {cells[name]['path']}")


def bare_mesh(path: str):
    """Every opaque skin triangle of a body GLB, in its bind pose."""
    glb = Glb.load(path)
    positions, faces, base = [], [], 0
    for primitive in glb.json["meshes"][0]["primitives"]:
        material = glb.json["materials"][primitive["material"]]["name"]
        if material == BZ.FACE_MATERIAL:
            continue
        position = glb.accessor(primitive["attributes"]["POSITION"]).astype(np.float64)
        positions.append(position)
        faces.append(glb.accessor(primitive["indices"]).astype(np.int64).reshape(-1, 3)
                     + base)
        base += len(position)
    return np.concatenate(positions), np.concatenate(faces)


def main() -> None:
    CFG.ensure_dirs()
    cells: dict = {}
    # 1. both final promoted bodies bare. The transparent face overlay is
    # intentionally omitted here; the opaque skin panel proves the head stays
    # closed when the atlas background is erased.
    for body_id, path in CFG.RUNTIME_BODY.items():
        vertices, faces = bare_mesh(path)
        for view in ("front", "side"):
            reset()
            add("body", vertices, faces, SKIN)
            frame(VIEWS[view])
            render(f"body_{body_id}_{view}", cells)

    # 2. the starter loadout, skinned AND masked exactly as the runtime does it.
    with open(os.path.join(CFG.REPORT_DIR, "body_zone_coverage.json"),
              encoding="utf-8") as handle:
        coverage = json.load(handle)["items"]
    masked = (set(coverage["under_bodysuit"]["hide_body_zones"])
              | set(coverage["boots_canvas_ankle"]["hide_body_zones"]))
    for body_id in ("male", "female"):
        prefix = "" if body_id == "male" else "Female/"
        body = POSE.Body(body_id)
        suit = POSE.SkinnedGeometry(
            os.path.join(CFG.EQUIPMENT, f"{prefix}Under/under_bodysuit.glb"),
            "suit")
        boots = POSE.SkinnedGeometry(
            os.path.join(CFG.EQUIPMENT, f"{prefix}Under/boots_canvas_ankle.glb"),
            "boots")
        # The renderer hides the zone primitives the loadout claims, so a proof
        # that draws them shows skin gameplay never draws -- and at a folded knee
        # that reads as the garment failing when it is the mask working.
        visible_faces = np.concatenate([faces for zone, faces
                                        in body.zone_faces.items()
                                        if zone not in masked])
        for clip, phase, suffix in LOADOUT_POSES:
            world, skin = body.pose(clip, phase)
            layers = (("skin", skin, visible_faces, SKIN),
                      ("suit", suit.posed(world), suit.faces, SUIT),
                      ("boots", boots.posed(world), boots.faces, BOOT))
            # Framed from the posed bounding box: a T-pose is twice as wide as a
            # crouch is tall, so one fixed camera cannot hold both.
            everything = to_blender(np.concatenate(
                [vertices for _, vertices, _, _ in layers]))
            low, high = everything.min(axis=0), everything.max(axis=0)
            centre = float((low[2] + high[2]) * 0.5)
            span = 1.15 * float(max(high - low))
            for view in ("front", "side", "threequarter"):
                reset()
                for name, vertices, faces, rgba in layers:
                    add(name, vertices, faces, rgba)
                frame(VIEWS[view], height=centre, scale=span)
                render(f"starter_{body_id}_{view}{suffix}", cells)

    destination = os.path.join(CFG.REPORT_DIR, "proof_manifest.json")
    with open(destination, "w", encoding="utf-8") as handle:
        json.dump({"generator": GENERATOR, "size_px": SIZE, "views_deg": VIEWS,
                   "loadout_poses": [{"clip": clip, "phase": phase}
                                     for clip, phase, _ in LOADOUT_POSES],
                   "cells": cells}, handle, indent=2)
        handle.write("\n")
    print(f"[proof] {len(cells)} cells -> {os.path.relpath(destination, CFG.REPO)}")


if __name__ == "__main__":
    main()
