"""Probe rigid attachments and weapons against male and female body meshes."""

from __future__ import annotations

import json
import os
import sys
import numpy as np
from mathutils import Vector
from mathutils.bvhtree import BVHTree

LAB_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, LAB_DIR)

import refit_config as CFG
import pose_probe as POSE
from gltf_io import Glb


# A hand closes around a grip, so a few millimetres of the mesh sitting inside
# the palm is correct and expected: the measured spread for a correctly posed
# mount is 4-19 mm. The five copy-pasted carbine/SMG/sniper/launcher mounts sit
# at 64-66 mm, which is more than a third of the way through a ~90 mm hand and
# puts the grip out the far side. 30 mm separates the two populations cleanly.
GRIP_DEPTH_LIMIT_MM = 30.0
# A head-socketed accessory rests on the skull. Anything further out is
# visibly floating; this matches the wearable gate's own float limit.
HEAD_FLOAT_LIMIT_MM = 3.0
# Male and female share one 45-joint skeleton, so a socket must resolve to the
# same world point on both. Any real divergence is a rig defect, not tolerance.
VARIANT_POS_LIMIT_MM = 1.0

REPORT_PATH = os.path.join(LAB_DIR, "reports", "rigid_mount_fit.json")

def quat_matrix(q: list[float] | np.ndarray) -> np.ndarray:
    x, y, z, w = q
    return np.array([
        [1 - 2*(y**2 + z**2), 2*(x*y - z*w),     2*(x*z + y*w),     0],
        [2*(x*y + z*w),     1 - 2*(x**2 + z**2), 2*(y*z - x*w),     0],
        [2*(x*z - y*w),     2*(y*z + x*w),     1 - 2*(x**2 + y**2), 0],
        [0,                 0,                 0,                 1]
    ], dtype=np.float64)


def trs_matrix(pos: list[float], quat: list[float], scale: float = 1.0) -> np.ndarray:
    m = quat_matrix(quat)
    m[:3, :3] *= scale
    m[:3, 3] = pos
    return m


def load_glb_vertices(glb_path: str, model_scale: float = 1.0) -> np.ndarray:
    g = Glb.load(glb_path)
    nodes = g.json["nodes"]
    count = len(nodes)
    parent: dict[int, int] = {}
    for idx, node in enumerate(nodes):
        for child in node.get("children", ()):
            parent[child] = idx

    roots = g.json.get("scenes", [{}])[0].get("nodes", []) if "scenes" in g.json else []
    if not roots:
        has_p = set(parent.keys())
        roots = [i for i in range(count) if i not in has_p]

    def get_local(n: dict) -> np.ndarray:
        if "matrix" in n:
            return np.array(n["matrix"], dtype=np.float64).reshape(4, 4).T
        t = np.array(n.get("translation", [0, 0, 0]), dtype=np.float64)
        r = np.array(n.get("rotation", [0, 0, 0, 1]), dtype=np.float64)
        s = np.array(n.get("scale", [1, 1, 1]), dtype=np.float64)
        m = np.eye(4)
        m[:3, :3] = quat_matrix(r)[:3, :3] * s
        m[:3, 3] = t
        return m

    cache: dict[int, np.ndarray] = {}

    def get_global(idx: int) -> np.ndarray:
        if idx not in cache:
            l = get_local(nodes[idx])
            p = parent.get(idx)
            cache[idx] = l if p is None else get_global(p) @ l
        return cache[idx]

    all_verts = []
    for idx, node in enumerate(nodes):
        if "mesh" in node:
            mesh_idx = node["mesh"]
            mesh = g.json["meshes"][mesh_idx]
            g_mat = get_global(idx)
            if abs(model_scale - 1.0) > 1e-5:
                s_mat = np.eye(4)
                s_mat[0, 0] = s_mat[1, 1] = s_mat[2, 2] = model_scale
                g_mat = s_mat @ g_mat
            for prim in mesh["primitives"]:
                pos_acc = prim["attributes"]["POSITION"]
                pos_data = g.accessor(pos_acc).astype(np.float64)
                ones = np.ones((len(pos_data), 1))
                pos_h = np.hstack([pos_data, ones])
                pos_world = (g_mat @ pos_h.T).T[:, :3]
                all_verts.append(pos_world)
    if not all_verts:
        return np.zeros((0, 3))
    return np.vstack(all_verts)


def main() -> None:
    male = POSE.Body("male")
    female = POSE.Body("female")

    male_world = male.rig.world(None, 0.0)
    female_world = female.rig.world(None, 0.0)

    male_tree = BVHTree.FromPolygons([tuple(p) for p in male.position], [tuple(f) for f in male.faces])
    female_tree = BVHTree.FromPolygons([tuple(p) for p in female.position], [tuple(f) for f in female.faces])

    rigid_items = []
    field_cap_path = os.path.normpath(os.path.join(CFG.ASSETS, "items/custom/accessories/field_cap.glb"))
    rigid_items.append({
        "id": "hat_field_cap",
        "glb": field_cap_path,
        "bone": "head",
        "mount_pos": [0.0, 0.0, 0.0],
        "mount_quat": [0.0, 0.0, 0.0, 1.0],
        "scale": 1.0
    })

    legacy_weapons = [
        ("slugthrower", "slugthrower.glb", "slugthrower_attach.json"),
        ("vibrosword", "vibrosword.glb", "vibrosword_attach.json"),
        ("plasma_hilt", "plasma_hilt.glb", "vibrosword_attach.json"),
    ]
    for item_id, glb_name, attach_name in legacy_weapons:
        gpath = os.path.normpath(os.path.join(CFG.ASSETS, "pawn-pack", glb_name))
        apath = os.path.normpath(os.path.join(CFG.ASSETS, "pawn-pack", attach_name))
        with open(apath) as f:
            spec = json.load(f)
        m = spec["mount_hand_r_local"]
        rigid_items.append({
            "id": item_id,
            "glb": gpath,
            "bone": "hand_r",
            "mount_pos": m["pos"],
            "mount_quat": m["quat"],
            "scale": spec.get("scale_to_pawn", 1.0)
        })

    weapons_manifest_path = os.path.join(CFG.ASSETS, "pawn-pack/weapons/weapons_manifest.json")
    with open(weapons_manifest_path) as f:
        cmanifest = json.load(f)

    for item in cmanifest["items"]:
        item_id = item["id"]
        gpath = os.path.normpath(os.path.join(CFG.ASSETS, "pawn-pack/weapons", item["glb"]))
        apath = os.path.normpath(os.path.join(CFG.ASSETS, "pawn-pack/weapons", item["attach"]))
        with open(apath) as f:
            spec = json.load(f)
        m = spec["mount_hand_r_local"]
        m_scale = spec.get("scale_to_pawn", item.get("scale", 1.0))
        rigid_items.append({
            "id": item_id,
            "glb": gpath,
            "bone": "hand_r",
            "mount_pos": m["pos"],
            "mount_quat": m["quat"],
            "scale": m_scale
        })

    header = f"{'ID':24s} | {'M Clear(mm)':11s} | {'M Depth(mm)':11s} | {'F Clear(mm)':11s} | {'F Depth(mm)':11s} | {'Delta Pos(mm)':13s}"
    print(header)
    print("-" * len(header))

    results = {}

    for item in rigid_items:
        item_id = item["id"]
        verts_local = load_glb_vertices(item["glb"], item["scale"])
        mount_mat = trs_matrix(item["mount_pos"], item["mount_quat"])

        m_bone = male_world[item["bone"]]
        m_mount_world_mat = m_bone @ mount_mat
        m_mount_pos = m_mount_world_mat[:3, 3]

        f_bone = female_world[item["bone"]]
        f_mount_world_mat = f_bone @ mount_mat
        f_mount_pos = f_mount_world_mat[:3, 3]

        pos_delta_mm = float(np.linalg.norm(m_mount_pos - f_mount_pos) * 1000.0)

        m_signed = []
        if len(verts_local) > 0:
            verts_h = np.hstack([verts_local, np.ones((len(verts_local), 1))])
            m_verts_world = (m_mount_world_mat @ verts_h.T).T[:, :3]
            for pt in m_verts_world:
                loc, norm, _, dist = male_tree.find_nearest(Vector((float(pt[0]), float(pt[1]), float(pt[2]))))
                if loc is None:
                    continue
                outward = (float(pt[0]) - loc.x, float(pt[1]) - loc.y, float(pt[2]) - loc.z)
                inside = (outward[0]*norm.x + outward[1]*norm.y + outward[2]*norm.z) < 0.0
                m_signed.append(dist * 1000.0 * (-1.0 if inside else 1.0))

        m_clear = float(np.min(m_signed)) if m_signed else 0.0
        m_depth = max(0.0, -m_clear)

        f_signed = []
        if len(verts_local) > 0:
            verts_h = np.hstack([verts_local, np.ones((len(verts_local), 1))])
            f_verts_world = (f_mount_world_mat @ verts_h.T).T[:, :3]
            for pt in f_verts_world:
                loc, norm, _, dist = female_tree.find_nearest(Vector((float(pt[0]), float(pt[1]), float(pt[2]))))
                if loc is None:
                    continue
                outward = (float(pt[0]) - loc.x, float(pt[1]) - loc.y, float(pt[2]) - loc.z)
                inside = (outward[0]*norm.x + outward[1]*norm.y + outward[2]*norm.z) < 0.0
                f_signed.append(dist * 1000.0 * (-1.0 if inside else 1.0))

        f_clear = float(np.min(f_signed)) if f_signed else 0.0
        f_depth = max(0.0, -f_clear)

        print(f"{item_id:24s} | {m_clear:11.3f} | {m_depth:11.3f} | {f_clear:11.3f} | {f_depth:11.3f} | {pos_delta_mm:13.3f}")

        results[item_id] = {
            "male": {
                "clearance_mm": round(m_clear, 3),
                "max_depth_mm": round(m_depth, 3),
                "mount_world_pos": [round(x, 5) for x in m_mount_pos],
            },
            "female": {
                "clearance_mm": round(f_clear, 3),
                "max_depth_mm": round(f_depth, 3),
                "mount_world_pos": [round(x, 5) for x in f_mount_pos],
            },
            "delta_pos_mm": round(pos_delta_mm, 3),
            "bone": item["bone"]
        }

    failures = []
    for item_id, row in sorted(results.items()):
        head_socket = row["bone"] == "head"
        for body in ("male", "female"):
            depth = row[body]["max_depth_mm"]
            clearance = row[body]["clearance_mm"]
            if depth > GRIP_DEPTH_LIMIT_MM:
                failures.append(
                    f"{body}: {item_id} grip buried {depth:.1f} mm "
                    f"(> {GRIP_DEPTH_LIMIT_MM:.0f} mm)"
                )
            if head_socket and clearance > HEAD_FLOAT_LIMIT_MM:
                failures.append(
                    f"{body}: {item_id} floats {clearance:.1f} mm off the head "
                    f"(> {HEAD_FLOAT_LIMIT_MM:.0f} mm)"
                )
        if row["delta_pos_mm"] > VARIANT_POS_LIMIT_MM:
            failures.append(
                f"{item_id} resolves {row['delta_pos_mm']:.2f} mm apart between bodies"
            )

    os.makedirs(os.path.dirname(REPORT_PATH), exist_ok=True)
    with open(REPORT_PATH, "w", encoding="utf-8") as handle:
        json.dump(
            {
                "schema": "successor.rigid-mount-fit.v1",
                "limits": {
                    "grip_depth_mm": GRIP_DEPTH_LIMIT_MM,
                    "head_float_mm": HEAD_FLOAT_LIMIT_MM,
                    "variant_pos_mm": VARIANT_POS_LIMIT_MM,
                },
                "items": results,
                "failures": failures,
            },
            handle,
            indent=2,
            sort_keys=True,
        )

    print(f"\nwrote {REPORT_PATH}")
    if failures:
        print(f"FAIL: {len(failures)} rigid-mount defect(s)")
        for line in failures:
            print(f"  - {line}")
    else:
        print("PASS: every rigid mount seats on both bodies")


if __name__ == "__main__":
    main()
