#!/usr/bin/env python3
"""Patch POSITION accessors of runtime garment GLBs with creasefix rest deltas.

Match by exact rest position (glTF y-up <-> Blender z-up: b=(x,-z,y), g=(X,Z,-Y)).
Keeps everything else byte-identical (materials, weights, indices, normals).
"""
import json, struct, sys, glob, os
import numpy as np

CT = {5121: np.uint8, 5123: np.uint16, 5125: np.uint32, 5126: np.float32}
NC = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4}
JSON_T, BIN_T, MAGIC = 0x4E4F534A, 0x004E4942, 0x46546C67

import os as _os
UNDER = _os.environ.get("UNDER_DIR", "successor/client-3d/public/assets/pawn-pack/equipment/Under")
FILES = {
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
SRC_DIR = "tmp/bodyprom/creasefix"
OUT_DIR = "tmp/bodyprom/fixedUnder"
os.makedirs(OUT_DIR, exist_ok=True)


def load(p):
    d = open(p, "rb").read()
    ln = struct.unpack_from("<I", d, 8)[0]
    off, ch = 12, {}
    while off < ln:
        cl, ct = struct.unpack_from("<II", d, off)
        ch[ct] = d[off+8:off+8+cl]
        off += 8 + cl
    return json.loads(ch[JSON_T]), bytearray(ch[BIN_T])


def acc(g, b, ai):
    a = g["accessors"][ai]
    bv = g["bufferViews"][a["bufferView"]]
    off = bv.get("byteOffset", 0) + a.get("byteOffset", 0)
    dt = np.dtype(CT[a["componentType"]])
    nc = NC[a["type"]]
    cnt = a["count"]
    stride = bv.get("byteStride") or nc * dt.itemsize
    out = np.empty((cnt, nc), dtype=dt)
    isz = nc * dt.itemsize
    for i in range(cnt):
        out[i] = np.frombuffer(bytes(b[off+i*stride:off+i*stride+isz]), dtype=dt)
    return (off, stride, isz), out


for gid, fn in FILES.items():
    # build blender-space lookup orig -> new
    lut = {}
    for npy in glob.glob(f"{SRC_DIR}/{gid}__*.npy"):
        d = np.load(npy)
        for row in d:
            key = tuple(np.round(row[:3], 5))
            lut[key] = row[3:]
    g, b = load(f"{UNDER}/{fn}")
    n_patched, n_missed, max_mm = 0, 0, 0.0
    for mesh in g["meshes"]:
        if "Icosphere" in mesh.get("name", ""):
            continue
        for pr in mesh["primitives"]:
            if "JOINTS_0" not in pr["attributes"]:
                continue
            ai = pr["attributes"]["POSITION"]
            (off, stride, isz), P = acc(g, b, ai)
            P = P.astype(np.float64)
            newP = P.copy()
            for i in range(len(P)):
                x, y, z = P[i]
                key = tuple(np.round((x, -z, y), 5))
                nv = lut.get(key)
                if nv is None:
                    n_missed += 1
                    continue
                X, Y, Z = nv
                newP[i] = (X, Z, -Y)
                n_patched += 1
            d = np.linalg.norm(newP - P, axis=1)
            max_mm = max(max_mm, float(d.max()) * 1000)
            raw = newP.astype(np.float32)
            for i in range(len(raw)):
                b[off+i*stride:off+i*stride+isz] = raw[i].tobytes()
            a = g["accessors"][ai]
            a["min"] = [float(v) for v in raw.min(axis=0)]
            a["max"] = [float(v) for v in raw.max(axis=0)]
    jraw = json.dumps(g, separators=(",", ":")).encode()
    jraw += b" " * (-len(jraw) % 4)
    braw = bytes(b) + b"\x00" * (-len(b) % 4)
    tot = 12 + 8 + len(jraw) + 8 + len(braw)
    with open(f"{OUT_DIR}/{fn}", "wb") as f:
        f.write(struct.pack("<III", MAGIC, 2, tot))
        f.write(struct.pack("<II", len(jraw), JSON_T)); f.write(jraw)
        f.write(struct.pack("<II", len(braw), BIN_T)); f.write(braw)
    print(f"[patch:{gid}] verts patched={n_patched} missed={n_missed} max_move={max_mm:.1f}mm")
