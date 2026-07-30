#!/usr/bin/env python3
"""Deterministic run-peak crease reproduction.

Finds true hip-flexion peak frame of run_f (max thigh-vs-pelvis-down angle),
then at that frame renders hip closeups for: fabric-only, fabric+CURRENT body,
fabric+OLD body; plus numeric fold evidence:
  - garment crease-band verts penetrating the body (CURRENT vs OLD)
  - garment self-fold count (non-adjacent self-overlap pairs in band)

  blender -b work_inflate.blend --python peak_repro.py -- --garment legs_reinforced_denim_pants --out DIR
"""
import argparse, math, sys
import bpy
import numpy as np
from mathutils import Vector
from mathutils.bvhtree import BVHTree

import os
UNDER = os.environ.get("UNDER_DIR", "successor/client-3d/public/assets/pawn-pack/equipment/Under")

def parse_args():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    p = argparse.ArgumentParser()
    p.add_argument("--garment", default="legs_reinforced_denim_pants")
    p.add_argument("--action", default="run_f")
    p.add_argument("--out", required=True)
    return p.parse_args(argv)

args = parse_args()
body = bpy.data.objects["pawn_body"]
arm = bpy.data.objects["HumanoidRig"]
for o in list(bpy.data.objects):
    if o.type == "MESH" and o.name.startswith("SK_"):
        bpy.data.objects.remove(o, do_unlink=True)

before = set(bpy.data.objects)
bpy.ops.import_scene.gltf(filepath=f"{UNDER}/{args.garment}.glb")
new = [o for o in bpy.data.objects if o not in before]
gmeshes = [o for o in new if o.type == "MESH" and o.vertex_groups and any(m.type == "ARMATURE" for m in o.modifiers)]
for m in gmeshes:
    for mod in m.modifiers:
        if mod.type == "ARMATURE":
            mod.object = arm
    m.parent = arm
    m.matrix_parent_inverse.identity()
for o in new:
    if o.type == "ARMATURE" or (o.type == "MESH" and o not in gmeshes):
        bpy.data.objects.remove(o, do_unlink=True)

act = bpy.data.actions[args.action]
arm.animation_data_create()
arm.animation_data.action = act
if hasattr(arm.animation_data, "action_slot") and act.slots:
    arm.animation_data.action_slot = act.slots[0]
f0, f1 = act.frame_range
scene = bpy.context.scene

# ---- find hip-flexion peak: max angle between posed thigh dir and rest thigh dir(≈down) ----
best = (0.0, int(f0), "thigh_l")
for fr in range(int(f0), int(f1) + 1):
    scene.frame_set(fr)
    for tb in ("thigh_l", "thigh_r"):
        pb = arm.pose.bones[tb]
        d = (pb.tail - pb.head).normalized()
        ang = math.degrees(math.acos(max(-1.0, min(1.0, d.dot(Vector((0, 0, -1)))))))
        if ang > best[0]:
            best = (ang, fr, tb)
peak_ang, peak_fr, peak_bone = best
print(f"[peak] {args.action} hip-flexion peak: frame {peak_fr} ({peak_bone}, {peak_ang:.1f} deg from vertical)")

scene.frame_set(peak_fr)
dg = bpy.context.evaluated_depsgraph_get()

def eval_world(o):
    ev = o.evaluated_get(dg)
    me = ev.to_mesh()
    mw = ev.matrix_world
    verts = [mw @ v.co for v in me.vertices]
    polys = [tuple(p.vertices) for p in me.polygons]
    ev.to_mesh_clear()
    return verts, polys

# ---- fold numerics for both bodies ----
cur_co = np.empty(len(body.data.vertices) * 3)
body.data.vertices.foreach_get("co", cur_co)
old_co = np.load("tmp/bodyprom/old_body_co.npy")

gv, gp = [], []
for m in gmeshes:
    verts, polys = eval_world(m)
    base = len(gv)
    gv.extend(verts)
    gp.extend(tuple(base + i for i in p) for p in polys)
gnp = np.array([(v.x, v.y, v.z) for v in gv])
# crease band on the FLEXED leg side, front-upper thigh in world space:
pbb = arm.pose.bones[peak_bone]
hip = arm.matrix_world @ pbb.head
knee = arm.matrix_world @ pbb.tail
mid = (np.array(hip) + np.array(knee)) / 2
band = np.linalg.norm(gnp - np.array(hip), axis=1) < 0.22

for label, co in (("CURRENT", cur_co), ("OLD", old_co.reshape(-1))):
    body.data.vertices.foreach_set("co", np.asarray(co).reshape(-1))
    body.data.update()
    dg = bpy.context.evaluated_depsgraph_get()
    bverts, bpolys = eval_world(body)
    bvh = BVHTree.FromPolygons(bverts, bpolys)
    pen = []
    for i in np.nonzero(band)[0]:
        p = gv[int(i)]
        loc, nrm, _f, _d = bvh.find_nearest(p)
        s = (p - loc).dot(nrm.normalized())
        pen.append(-s if s < 0 else 0.0)
    pen = np.array(pen)
    print(f"[fold:{label}] crease-band garment verts={band.sum()} inside-body(>2mm)={int((pen>0.002).sum())} "
          f"max-depth={pen.max()*1000:.1f}mm mean-depth(inside)={pen[pen>0.002].mean()*1000 if (pen>0.002).any() else 0:.1f}mm")

# restore CURRENT positions
body.data.vertices.foreach_set("co", cur_co)
body.data.update()

# ---- renders: studio-lit closeup of the flexed hip ----
scene.render.engine = "BLENDER_WORKBENCH"
scene.display.shading.light = "STUDIO"
scene.display.shading.color_type = "OBJECT"
scene.display.render_aa = "5"
scene.render.resolution_x = 768
scene.render.resolution_y = 768
scene.world.color = (0.05, 0.05, 0.06)
body.color = (0.72, 0.45, 0.30, 1.0)
for m in gmeshes:
    m.color = (0.35, 0.38, 0.55, 1.0)
arm.hide_render = True

target = Vector(((hip.x + knee.x) / 2, (hip.y + knee.y) / 2, (hip.z + knee.z) / 2 + 0.05))
cams = []
for ci, (ang_deg, elev) in enumerate(((30, 0.15), (90, 0.05), (-40, 0.25))):
    ang = math.radians(ang_deg)
    camd = bpy.data.cameras.new(f"pkcam{ci}")
    camd.type = "ORTHO"
    camd.ortho_scale = 0.75
    cam = bpy.data.objects.new(f"pkcam{ci}", camd)
    pos = target + Vector((2.0 * math.sin(ang), -2.0 * math.cos(ang), elev * 2.0))
    cam.location = pos
    cam.rotation_euler = (target - pos).normalized().to_track_quat("-Z", "Y").to_euler()
    bpy.context.collection.objects.link(cam)
    cams.append(cam)

def shots(tag):
    for ci, cam in enumerate(cams):
        scene.camera = cam
        scene.render.filepath = f"{args.out}/{args.garment}_{args.action}_f{peak_fr}_{tag}_c{ci}.png"
        bpy.ops.render.render(write_still=True)

# fabric + CURRENT body
shots("CURRENT")
# fabric + OLD body
body.data.vertices.foreach_set("co", old_co.reshape(-1))
body.data.update()
shots("OLD")
body.data.vertices.foreach_set("co", cur_co)
body.data.update()
# fabric only
body.hide_render = True
shots("FABRIC")
body.hide_render = False
print("[repro] renders done")
