#!/usr/bin/env python3
"""Compare crease-band weight rows between two garment GLBs (all mesh prims)."""
import json, struct, sys
import numpy as np

CT = {5121: np.uint8, 5123: np.uint16, 5125: np.uint32, 5126: np.float32}
NC = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4}

def load(p):
    d = open(p, "rb").read()
    ln = struct.unpack_from("<I", d, 8)[0]
    off, ch = 12, {}
    while off < ln:
        cl, ct = struct.unpack_from("<II", d, off)
        ch[ct] = d[off+8:off+8+cl]
        off += 8 + cl
    return json.loads(ch[0x4E4F534A]), ch[0x004E4942]

def acc(g, b, ai):
    a = g["accessors"][ai]
    bv = g["bufferViews"][a["bufferView"]]
    off = bv.get("byteOffset", 0) + a.get("byteOffset", 0)
    dt = np.dtype(CT[a["componentType"]])
    nc = NC[a["type"]]
    cnt = a["count"]
    stride = bv.get("byteStride") or nc * dt.itemsize
    if stride == nc * dt.itemsize:
        return np.frombuffer(b[off:off+cnt*nc*dt.itemsize], dtype=dt).reshape(cnt, nc)
    out = np.empty((cnt, nc), dtype=dt)
    for i in range(cnt):
        out[i] = np.frombuffer(b[off+i*stride:off+i*stride+nc*dt.itemsize], dtype=dt)
    return out

def gather(path):
    g, b = load(path)
    joints = [g["nodes"][i]["name"] for i in g["skins"][0]["joints"]]
    P, J, W, order = [], [], [], []
    for mi, mesh in enumerate(g["meshes"]):
        nm = mesh.get("name", f"m{mi}")
        if "Icosphere" in nm:
            continue
        for pr in mesh["primitives"]:
            if "JOINTS_0" not in pr["attributes"]:
                continue
            P.append(acc(g, b, pr["attributes"]["POSITION"]).astype(np.float64))
            J.append(acc(g, b, pr["attributes"]["JOINTS_0"]).astype(int))
            W.append(acc(g, b, pr["attributes"]["WEIGHTS_0"]).astype(np.float64))
            order.append((nm, len(P[-1])))
    return joints, np.vstack(P), np.vstack(J), np.vstack(W), order

def dense(J, W, joints, all_names):
    idx = {n: i for i, n in enumerate(all_names)}
    m = np.array([idx[n] for n in joints])
    D = np.zeros((len(J), len(all_names)))
    for k in range(J.shape[1]):
        D[np.arange(len(J)), m[J[:, k]]] += W[:, k]
    return D

a_path, b_path = sys.argv[1], sys.argv[2]
ja, Pa, Ja, Wa, orda = gather(a_path)
jb, Pb, Jb, Wb, ordb = gather(b_path)
print("meshes A:", orda)
print("meshes B:", ordb)
print("joint sets equal:", sorted(ja) == sorted(jb), len(ja), len(jb))
print("helperish joints A:", [n for n in ja if "helper" in n.lower()], "B:", [n for n in jb if "helper" in n.lower()])
if Pa.shape != Pb.shape:
    print("TOPOLOGY DIFFERS:", Pa.shape, Pb.shape)
    sys.exit(0)
pd = np.linalg.norm(Pa - Pb, axis=1)
names = sorted(set(ja) | set(jb))
Da, Db = dense(Ja, Wa, ja, names), dense(Jb, Wb, jb, names)
wd = np.abs(Da - Db).sum(axis=1)
# glTF y-up: crease band = y in [0.70, 1.00], front z > 0
y, zf = Pa[:, 1], Pa[:, 2]
band = (y > 0.68) & (y < 1.02)
front = band & (zf > 0.0)
print(f"verts: {len(Pa)}  pos-delta: mean {pd.mean()*1000:.2f}mm max {pd.max()*1000:.2f}mm  changed>0.1mm {(pd>1e-4).sum()}")
print(f"weights: rows changed(L1>0.02) {(wd>0.02).sum()} / band {(wd[band]>0.02).sum()}/{band.sum()} / front-band {(wd[front]>0.02).sum()}/{front.sum()}")
if (wd > 0.02).any():
    # which bones gained/lost in the band
    diff = (Da - Db)[band]
    gain = diff.sum(axis=0)
    top = np.argsort(-np.abs(gain))[:8]
    print("band weight shift per bone (A - B):")
    for i in top:
        if abs(gain[i]) > 0.01:
            print(f"  {names[i]:14s} {gain[i]:+8.2f}")
band_pd = pd[band]
print(f"band pos-delta: mean {band_pd.mean()*1000:.2f}mm max {band_pd.max()*1000:.2f}mm")
