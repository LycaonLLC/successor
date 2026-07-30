#!/usr/bin/env python3
"""Pose-swept rest-shape de-collapse for runtime garments (pose_sweep_declip pattern).

For every garment vert, sweep walk_f+run_f (all frames): measure signed distance
to the CURRENT body (lab semantics: find_nearest, signed=(p-loc)·n). Where the
fabric sinks below the skin deeper than --trigger, compute the worst-frame world
correction (push to +--clearance above skin), back-transform through the vert's
LBS matrix into REST space, cap at --max-delta, one Laplacian round on the rest
delta field, apply.

Outputs per-garment displaced rest positions npy keyed by original rest pos.

  blender -b work_inflate.blend --python creasefix.py -- --garment <id> [...]
"""
import argparse
import sys

import bpy
import numpy as np
from mathutils import Matrix, Vector
from mathutils.bvhtree import BVHTree

import os as _os
UNDER = _os.environ.get("UNDER_DIR", "successor/client-3d/public/assets/pawn-pack/equipment/Under")
GARMENT_FILES = {
    "legs_wrapped_workpants": "legs_wrapped_workpants.glb",
    "legs_reinforced_denim_pants": "legs_reinforced_denim_pants.glb",
    "legs_plated_trousers": "legs_plated_trousers.glb",
    "legs_layered_shorts": "legs_layered_shorts.glb",
    "legs_strapped_trousers": "legs_strapped_trousers.glb",
    "legs_skirted_workpants": "legs_skirted_workpants.glb",
    "legs_gaitered_cargo_pants": "legs_gaitered_cargo_pants.glb",
    "legs_padded_canvas_trousers": "legs_padded_canvas_trousers.glb",
    "legs_sashed_patrol_pants": "legs_sashed_patrol_pants.glb",
    "legs_layered_wrap_skirt": "legs_layered_wrap_skirt.glb",
    "under_bodysuit": "under_bodysuit.glb",
    "under_shorts": "Shorts.glb",
}
ACTIONS = ("walk_f", "run_f")


def parse_args():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    p = argparse.ArgumentParser()
    p.add_argument("--garments", nargs="+", default=list(GARMENT_FILES))
    p.add_argument("--trigger", type=float, default=0.003)
    p.add_argument("--clearance", type=float, default=0.002)
    p.add_argument("--max-delta", type=float, default=0.012)
    p.add_argument("--out-dir", default="tmp/bodyprom/creasefix")
    return p.parse_args(argv)


def main():
    args = parse_args()
    import os
    os.makedirs(args.out_dir, exist_ok=True)
    body = bpy.data.objects["pawn_body"]
    arm = bpy.data.objects["HumanoidRig"]
    for o in list(bpy.data.objects):
        if o.type == "MESH" and o.name.startswith("SK_"):
            bpy.data.objects.remove(o, do_unlink=True)

    for gid in args.garments:
        before = set(bpy.data.objects)
        bpy.ops.import_scene.gltf(filepath=f"{UNDER}/{GARMENT_FILES[gid]}")
        new = [o for o in bpy.data.objects if o not in before]
        gmeshes = [o for o in new if o.type == "MESH" and o.vertex_groups
                   and any(m.type == "ARMATURE" for m in o.modifiers)]
        for m in gmeshes:
            for mod in m.modifiers:
                if mod.type == "ARMATURE":
                    mod.object = arm
            m.parent = arm
            m.matrix_parent_inverse.identity()
            assert all(abs(m.matrix_world[i][j] - (1.0 if i == j else 0.0)) < 1e-5
                       for i in range(4) for j in range(4)), f"{m.name} non-identity matrix"
        for o in new:
            if o.type == "ARMATURE" or (o.type == "MESH" and o not in gmeshes):
                bpy.data.objects.remove(o, do_unlink=True)

        scene = bpy.context.scene
        # per mesh: worst (needed, frame normal, bone matrices) tracking
        state = {m.name: None for m in gmeshes}
        for act_name in ACTIONS:
            act = bpy.data.actions[act_name]
            arm.animation_data_create()
            arm.animation_data.action = act
            if hasattr(arm.animation_data, "action_slot") and act.slots:
                arm.animation_data.action_slot = act.slots[0]
            f0, f1 = act.frame_range
            for fr in range(int(f0), int(f1) + 1):
                scene.frame_set(fr)
                dg = bpy.context.evaluated_depsgraph_get()
                evb = body.evaluated_get(dg)
                meb = evb.to_mesh()
                mwb = evb.matrix_world
                bverts = [mwb @ v.co for v in meb.vertices]
                bpolys = [tuple(p.vertices) for p in meb.polygons]
                evb.to_mesh_clear()
                bvh = BVHTree.FromPolygons(bverts, bpolys)
                # pose-bone linear maps
                bone_mats = {pb.name: (arm.matrix_world @ pb.matrix @ pb.bone.matrix_local.inverted())
                             for pb in arm.pose.bones}
                for m in gmeshes:
                    ev = m.evaluated_get(dg)
                    me = ev.to_mesh()
                    mw = ev.matrix_world
                    if state[m.name] is None:
                        state[m.name] = [None] * len(me.vertices)
                    st = state[m.name]
                    for i, v in enumerate(me.vertices):
                        p = mw @ v.co
                        loc, nrm, _f, _d = bvh.find_nearest(p)
                        if loc is None:
                            continue
                        signed = (p - loc).dot(nrm.normalized())
                        if signed >= -args.trigger:
                            continue
                        needed = -signed + args.clearance
                        if st[i] is None or needed > st[i][0]:
                            st[i] = (needed, Vector(nrm.normalized()), fr, act_name)
                    ev.to_mesh_clear()
                # remember matrices for worst-frame back-transform: store lazily
                for m in gmeshes:
                    st = state[m.name]
                    for i, rec in enumerate(st):
                        if rec is not None and len(rec) == 4 and rec[2] == fr:
                            st[i] = (rec[0], rec[1], fr, rec[3], bone_mats)

        # apply rest deltas
        report = []
        for m in gmeshes:
            me = m.data
            nv = len(me.vertices)
            st = state[m.name]
            gnames = {g.index: g.name for g in m.vertex_groups}
            delta = np.zeros((nv, 3))
            n_fix = 0
            worst_needed = 0.0
            for i, rec in enumerate(st or []):
                if rec is None:
                    continue
                needed, nrm, fr, act_name, bone_mats = rec
                worst_needed = max(worst_needed, needed)
                # LBS matrix of this vert at worst frame
                M = Matrix(([0.0]*4, [0.0]*4, [0.0]*4, [0.0]*4))
                tot = 0.0
                for gvw in me.vertices[i].groups:
                    name = gnames.get(gvw.group)
                    if name in bone_mats and gvw.weight > 0:
                        Bm = bone_mats[name]
                        for r in range(4):
                            for c in range(4):
                                M[r][c] += gvw.weight * Bm[r][c]
                        tot += gvw.weight
                if tot < 1e-4:
                    continue
                try:
                    Minv3 = M.to_3x3().inverted()
                except ValueError:
                    continue
                dw = nrm * min(needed, args.max_delta * 2)  # world push (pre-cap)
                dr = Minv3 @ dw
                ln = dr.length
                if ln > args.max_delta:
                    dr = dr * (args.max_delta / ln)
                delta[i] = (dr.x, dr.y, dr.z)
                n_fix += 1
            # one Laplacian round over adjacency (only among moved verts, soft)
            adj = [[] for _ in range(nv)]
            for e in me.edges:
                a, b = e.vertices
                adj[a].append(b)
                adj[b].append(a)
            sm = delta.copy()
            for i in range(nv):
                if adj[i]:
                    neigh = delta[adj[i]]
                    sm[i] = 0.6 * delta[i] + 0.4 * neigh.mean(axis=0)
            delta = sm
            cur = np.empty(nv * 3)
            me.vertices.foreach_get("co", cur)
            cur = cur.reshape(nv, 3)
            newco = cur + delta
            np.save(f"{args.out_dir}/{gid}__{m.name}.npy",
                    np.hstack([cur, newco]))
            moved = np.linalg.norm(delta, axis=1)
            report.append((m.name, n_fix, float(moved.max()) * 1000, float(worst_needed) * 1000))
        for nm, nf, mx, wn in report:
            print(f"[fix:{gid}] {nm}: verts_touched={nf} max_rest_delta={mx:.1f}mm worst_pen_needed={wn:.1f}mm")
        for m in gmeshes:
            bpy.data.objects.remove(m, do_unlink=True)
    print("[creasefix] done")


main()
