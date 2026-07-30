#!/usr/bin/env python3
"""Rendered visible-clip sweep: flat-color masks of body(magenta)/garment(black).

  blender -b work.blend --python render_sweep.py -- --body CURRENT|NEW|OLD --out DIR

Renders 12 garments x (walk_f+run_f, 6 frames each) x 6 orbit cameras at 448px,
Workbench flat object-color, AA off. Body co set from npy per --body.
"""
import argparse
import math
import sys

import bpy
import numpy as np
from mathutils import Vector

import os as _os
UNDER = _os.environ.get("UNDER_DIR", "successor/client-3d/public/assets/pawn-pack/equipment/Under")
GARMENTS = {
    "legs_wrapped_workpants": f"{UNDER}/legs_wrapped_workpants.glb",
    "legs_reinforced_denim_pants": f"{UNDER}/legs_reinforced_denim_pants.glb",
    "legs_plated_trousers": f"{UNDER}/legs_plated_trousers.glb",
    "legs_layered_shorts": f"{UNDER}/legs_layered_shorts.glb",
    "legs_strapped_trousers": f"{UNDER}/legs_strapped_trousers.glb",
    "legs_skirted_workpants": f"{UNDER}/legs_skirted_workpants.glb",
    "legs_gaitered_cargo_pants": f"{UNDER}/legs_gaitered_cargo_pants.glb",
    "legs_padded_canvas_trousers": f"{UNDER}/legs_padded_canvas_trousers.glb",
    "legs_sashed_patrol_pants": f"{UNDER}/legs_sashed_patrol_pants.glb",
    "legs_layered_wrap_skirt": f"{UNDER}/legs_layered_wrap_skirt.glb",
    "under_bodysuit": f"{UNDER}/under_bodysuit.glb",
    "under_shorts": f"{UNDER}/Shorts.glb",
}
ACTIONS = ("walk_f", "run_f")
FRAMES = 6
N_CAMS = 6
RES = 448


def parse_args():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    p = argparse.ArgumentParser()
    p.add_argument("--body", required=True, choices=["CURRENT", "NEW", "OLD"])
    p.add_argument("--out", required=True)
    return p.parse_args(argv)


def import_garments(arm):
    garment_objs = {}
    for gid, path in GARMENTS.items():
        before = set(bpy.data.objects)
        bpy.ops.import_scene.gltf(filepath=path)
        new = [o for o in bpy.data.objects if o not in before]
        meshes = [o for o in new if o.type == "MESH"
                  and o.vertex_groups and any(m.type == "ARMATURE" for m in o.modifiers)]
        for m in meshes:
            for mod in m.modifiers:
                if mod.type == "ARMATURE":
                    mod.object = arm
            m.parent = arm
            m.matrix_parent_inverse.identity()
            m.color = (0.0, 1.0, 0.0, 1.0)
        for o in new:
            if o.type == "ARMATURE" or (o.type == "MESH" and o not in meshes):
                bpy.data.objects.remove(o, do_unlink=True)
        garment_objs[gid] = [m.name for m in meshes]
    return garment_objs


def main():
    args = parse_args()
    body = bpy.data.objects["pawn_body"]
    arm = bpy.data.objects["HumanoidRig"]
    for o in list(bpy.data.objects):
        if o.type == "MESH" and o.name.startswith("SK_"):
            bpy.data.objects.remove(o, do_unlink=True)
    garment_objs = import_garments(arm)

    nv = len(body.data.vertices)
    if args.body == "NEW":
        co = np.load("tmp/bodyprom/new_body_co.npy")
        body.data.vertices.foreach_set("co", co.reshape(-1))
        body.data.update()
    elif args.body == "OLD":
        co = np.load("tmp/bodyprom/old_body_co.npy")
        body.data.vertices.foreach_set("co", co.reshape(-1))
        body.data.update()
    body.color = (1.0, 0.0, 1.0, 1.0)
    arm.hide_render = True

    scene = bpy.context.scene
    scene.render.engine = "BLENDER_WORKBENCH"
    scene.display.shading.light = "FLAT"
    scene.display.shading.color_type = "OBJECT"
    scene.display.render_aa = "OFF"
    scene.render.resolution_x = RES
    scene.render.resolution_y = RES
    scene.render.film_transparent = False
    scene.world.color = (0.0, 0.0, 0.0)

    cams = []
    target = Vector((0.0, 0.0, 0.68))
    for ci in range(N_CAMS):
        ang = 2 * math.pi * ci / N_CAMS
        camd = bpy.data.cameras.new(f"swpcam{ci}")
        camd.type = "ORTHO"
        camd.ortho_scale = 1.15
        cam = bpy.data.objects.new(f"swpcam{ci}", camd)
        pos = Vector((2.5 * math.sin(ang), -2.5 * math.cos(ang), 0.78))
        cam.location = pos
        d = (target - pos).normalized()
        cam.rotation_euler = d.to_track_quat("-Z", "Y").to_euler()
        bpy.context.collection.objects.link(cam)
        cams.append(cam)

    for names in garment_objs.values():
        for nm in names:
            bpy.data.objects[nm].hide_render = True

    for gid, names in garment_objs.items():
        for nm in names:
            bpy.data.objects[nm].hide_render = False
        row = 0
        for act_name in ACTIONS:
            act = bpy.data.actions[act_name]
            arm.animation_data_create()
            arm.animation_data.action = act
            if hasattr(arm.animation_data, "action_slot") and act.slots:
                arm.animation_data.action_slot = act.slots[0]
            f0, f1 = act.frame_range
            for fi in range(FRAMES):
                scene.frame_set(int(round(f0 + (f1 - f0) * fi / (FRAMES - 1))))
                for ci, cam in enumerate(cams):
                    scene.camera = cam
                    scene.render.filepath = f"{args.out}/{gid}/f{row:02d}_c{ci}.png"
                    bpy.ops.render.render(write_still=True)
                row += 1
        for nm in names:
            bpy.data.objects[nm].hide_render = True
        print(f"[render] {gid} done", flush=True)


main()
