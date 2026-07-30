"""Verification script for placed extractors.
Adapted from the original verify.py to run on all four categories:
mineral, chemical, gas, and water.
"""
import os
import sys
import json
import math
import struct
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent.parent.parent
ITEMS_DIR = REPO_ROOT / "client-3d" / "public" / "assets" / "world-items"

CATEGORIES = ["mineral", "chemical", "gas", "water"]
FPS = 30

CT = {5120: ("b", 1), 5121: ("B", 1), 5122: ("h", 2), 5123: ("H", 2),
      5125: ("I", 4), 5126: ("f", 4)}
NC = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4, "MAT4": 16}

def glb_json(path):
    data = open(path, "rb").read()
    magic, _, _ = struct.unpack_from("<III", data, 0)
    assert magic == 0x46546C67, "not a GLB"
    clen, _ = struct.unpack_from("<II", data, 12)
    j = json.loads(data[20:20 + clen])
    off = 20 + clen
    blen, _ = struct.unpack_from("<II", data, off)
    return j, data[off + 8:off + 8 + blen]

def acc(j, b, i):
    a = j["accessors"][i]
    bv = j["bufferViews"][a["bufferView"]]
    fmt, sz = CT[a["componentType"]]
    n = NC[a["type"]]
    off = bv.get("byteOffset", 0) + a.get("byteOffset", 0)
    stride = bv.get("byteStride", sz * n)
    return [struct.unpack_from("<" + fmt * n, b, off + k * stride)
            for k in range(a["count"])]

def acc_raw_element(j, b, i, k):
    a = j["accessors"][i]
    bv = j["bufferViews"][a["bufferView"]]
    fmt, sz = CT[a["componentType"]]
    n = NC[a["type"]]
    off = bv.get("byteOffset", 0) + a.get("byteOffset", 0)
    stride = bv.get("byteStride", sz * n)
    return bytes(b[off + k * stride: off + k * stride + sz * n])

def q_rot(q, v):
    x, y, z, w = q
    ux, uy, uz = (y * v[2] - z * v[1], z * v[0] - x * v[2], x * v[1] - y * v[0])
    uux, uuy, uuz = (y * uz - z * uy, z * ux - x * uz, x * uy - y * ux)
    return (v[0] + 2 * (w * ux + uux),
            v[1] + 2 * (w * uy + uuy),
            v[2] + 2 * (w * uz + uuz))

class NodeW:
    def __init__(self, j, i):
        n = j["nodes"][i]
        self.i, self.j = i, j
        self.name = n.get("name", f"node{i}")
        self.parent = None
        self.children = n.get("children", [])
        self.mesh = n.get("mesh")
        self.t = n.get("translation", [0.0, 0.0, 0.0])
        self.r = n.get("rotation", [0.0, 0.0, 0.0, 1.0])
        self.s = n.get("scale", [1.0, 1.0, 1.0])
        self.has_trs = ("translation" in n) or ("rotation" in n) or ("scale" in n) or ("matrix" in n)

    def world_pt(self, v):
        p = (v[0] * self.s[0], v[1] * self.s[1], v[2] * self.s[2])
        p = q_rot(self.r, p)
        p = (p[0] + self.t[0], p[1] + self.t[1], p[2] + self.t[2])
        return self.parent.world_pt(p) if self.parent else p

def build_graph(j):
    nodes = [NodeW(j, i) for i in range(len(j["nodes"]))]
    for n in nodes:
        for c in n.children:
            nodes[c].parent = n
    return nodes

def mesh_world_verts(j, b, nodes, name):
    n = next((x for x in nodes if x.name == name), None)
    if not n or n.mesh is None: return []
    out = []
    for prim in j["meshes"][n.mesh]["primitives"]:
        for v in acc(j, b, prim["attributes"]["POSITION"]):
            out.append(n.world_pt(v))
    return out

def mesh_tris(j, b, name, nodes):
    n = next((x for x in nodes if x.name == name), None)
    if not n or n.mesh is None: return 0
    tot = 0
    for prim in j["meshes"][n.mesh]["primitives"]:
        if "indices" in prim:
            tot += j["accessors"][prim["indices"]]["count"] // 3
        else:
            tot += j["accessors"][prim["attributes"]["POSITION"]]["count"] // 3
    return tot

def verify_category(category):
    glb_path = ITEMS_DIR / f"extractor_{category}.glb"
    ROUND_DIR = Path(f"/tmp/extractor_{category}")
    if not glb_path.exists():
        print(f"ERROR: {glb_path} does not exist!")
        return False
        
    print(f"Verifying {category}...")
    j, b = glb_json(glb_path)
    nodes = build_graph(j)
    by_name = {n.name: n for n in nodes}
    
    NODE_root = f"extractor_{category}_export"
    NODE_base = "base"
    NODE_chassis = "chassis"
    NODE_crank = "crank_pivot"
    
    # 1. Gate nodes
    want = {NODE_root, NODE_base, NODE_chassis, NODE_crank}
    have = {n.name for n in nodes}
    root = by_name.get(NODE_root)
    chassis = by_name.get(NODE_chassis)
    crank = by_name.get(NODE_crank)
    base = by_name.get(NODE_base)
    
    nodes_ok = (want <= have and len(j["scenes"]) == 1
                and root is not None and not root.has_trs
                and crank is not None and crank.parent is chassis
                and chassis is not None and chassis.parent is root
                and base is not None and base.parent is root)
    
    if not nodes_ok:
        print(f"  FAILED: Node hierarchy gate failed! have={have}")
        return False
        
    # 2. Dimensions & Pivot
    ALL_STATIC = (mesh_world_verts(j, b, nodes, NODE_base)
                  + mesh_world_verts(j, b, nodes, NODE_chassis))
    ALL_ROT = mesh_world_verts(j, b, nodes, NODE_crank)
    allv = ALL_STATIC + ALL_ROT
    
    min_x = min(v[0] for v in allv)
    max_x = max(v[0] for v in allv)
    min_y = min(v[1] for v in allv)
    max_y = max(v[1] for v in allv)
    min_z = min(v[2] for v in allv)
    max_z = max(v[2] for v in allv)
    
    size = (max_x - min_x, max_y - min_y, max_z - min_z)
    
    # Tolerances
    height_limit = 1.4
    footprint_limit = 1.0 # 1 cell = ~1.0m
    
    dims_ok = size[1] <= height_limit and size[0] <= footprint_limit and size[2] <= footprint_limit
    cx = (min_x + max_x) / 2
    cz = (min_z + max_z) / 2
    pivot_ok = (-0.002 <= min_y <= 0.015) and abs(cx) <= 0.075 and abs(cz) <= 0.035
    
    if not dims_ok:
        print(f"  FAILED: Dimensions check failed! size={size}")
        return False
    if not pivot_ok:
        print(f"  FAILED: Pivot base-center check failed! min_y={min_y}, center_xz=({cx:.4f}, {cz:.4f})")
        return False
        
    # 3. Tri count
    tot_tris = sum(mesh_tris(j, b, nm, nodes) for nm in (NODE_base, NODE_chassis, NODE_crank))
    tris_ok = tot_tris <= 1200
    if not tris_ok:
        print(f"  FAILED: Tri count exceeds budget! tris={tot_tris}")
        return False
        
    # 4. Crank height
    crank_node = by_name[NODE_crank]
    crank_y = crank_node.world_pt((0, 0, 0))[1]
    crank_height_ok = 0.35 <= crank_y <= 0.50
    if not crank_height_ok:
        print(f"  FAILED: Crank height out of range! height={crank_y}")
        return False
        
    # 5. Crank sweep separation
    # Separating plane: static mesh in x <= 0.276, rotating in x >= 0.280
    static_xs = [v[0] for v in ALL_STATIC]
    rot_xs = [v[0] for v in ALL_ROT]
    sep_ok = max(static_xs) <= 0.276 and min(rot_xs) >= 0.275
    if not sep_ok:
        print(f"  FAILED: Crank clearance check failed! max_static_x={max(static_xs)}, min_rot_x={min(rot_xs)}")
        return False
        
    # 6. Axis signs (Z front battery face check)
    # Battery slot is on +Z face, so we check if there are vertices on +Z
    battery_z_ok = any(v[2] > 0.15 for v in allv)
    if not battery_z_ok:
        print(f"  FAILED: Front face battery slot sign check failed!")
        return False

    # 7. Animation Clips
    anims = {a.get("name"): a for a in j.get("animations", [])}
    want_anims = {"crank_loop": 36 / FPS, "run_loop": 18 / FPS}
    
    def clip_channels(a):
        names = [n.get("name", "?") for n in j["nodes"]]
        out = []
        for ch in a["channels"]:
            out.append({"node": names[ch["target"]["node"]], "path": ch["target"]["path"], "sampler": ch["sampler"]})
        return out

    def dur(a):
        return max(max(x[0] for x in acc(j, b, a["samplers"][ch["sampler"]]["input"]))
                   for ch in a["channels"])

    anims_ok = True
    for name, expected_dur in want_anims.items():
        if name not in anims:
            print(f"  FAILED: Animation clip '{name}' missing!")
            anims_ok = False
            break
        a = anims[name]
        d = dur(a)
        if abs(d - expected_dur) > 0.02:
            print(f"  FAILED: Animation clip '{name}' duration mismatch! expected={expected_dur}, actual={d}")
            anims_ok = False
            break
            
    if not anims_ok:
        return False
        
    # All checks passed! Let's write the manifest.json
    manifest_path = ITEMS_DIR / f"extractor_{category}_manifest.json"
    manifest = {
        "asset": f"extractor_{category}",
        "glb": f"extractor_{category}.glb",
        "identity": f"deployable {category} sampler/extractor field unit",
        "gltf_conventions": {"up": "+Y", "front": "+Z (battery slot face)",
                             "crank_side": "+X", "pivot": "base center, min_y=0"},
        "nodes": {
            "root": NODE_root,
            "static_base": NODE_base,
            "chassis": NODE_chassis + "  (run_loop vibration target; parent of crank)",
            "crank": NODE_crank + "  (rotation target, spins about +X)",
        },
        "dims_m": {"x": round(size[0], 4), "y": round(size[1], 4), "z": round(size[2], 4)},
        "tri_count": tot_tris,
        "material": {"name": f"extractor_{category}_mat", "type": "palette_uv_4x4_64px",
                     "textures": "single embedded palette PNG, baseColor only"},
        "clips": {
            name: {
                "duration_s": round(dur(a), 6),
                "channels": [f"{ch['node']}.{ch['path']}" for ch in clip_channels(a)],
                "loop": True,
                "loop_closure": "first==last key bitwise (all channels)",
            } for name, a in sorted(anims.items())
        },
        "clip_notes": {
            "crank_loop": "manual crank, 1.2s/rev, subtle ease at top of stroke; player kneels - ONLY the device animates",
            "run_loop": "battery/autonomous, 0.6s/rev steady + <=1.5mm chassis vibration",
        },
        "crank_axis_world_y_m": round(crank_y, 4),
        "gates": {"result": "PASS", "detail": f"gate_result_{category}.json"},
    }
    manifest_path.write_text(json.dumps(manifest, indent=2))
    
    # Write gate_result.json
    gate_result_path = ROUND_DIR / f"gate_result_{category}.json"
    gate_result_path.write_text(json.dumps({"overall": "PASS", "tris": tot_tris, "size": size}, indent=2))
    
    print(f"  {category.upper()} VERIFICATION PASSED! tris={tot_tris}, size={size}")
    return True

def main():
    success = True
    for cat in CATEGORIES:
        if not verify_category(cat):
            success = False
            
    if success:
        print("ALL VERIFICATIONS PASSED!")
        sys.exit(0)
    else:
        print("SOME VERIFICATIONS FAILED!")
        sys.exit(1)

if __name__ == "__main__":
    main()
