"""Sit the female armour on the female body instead of hovering over it.

Every armour piece was fitted to the male frame and copied across. Measured
against the bodies, the nearest point of each female variant to her skin:

    piece                 male     female
    Gorget                2.5 mm   14.0 mm
    Bicep_L               1.1 mm    9.7 mm
    Bicep_R               1.5 mm   10.1 mm
    Nape_Reinforcement    4.6 mm    9.9 mm
    Reinforcement         4.8 mm   18.1 mm

The male pieces rest on the skin. The female ones float up to 18 mm clear, and
their contact fraction is 0.000 - they never touch her anywhere. On a narrower
frame the copied shell simply stands off.

The correction is a uniform draw-in toward the body's vertical axis, not a
projection onto the skin. Projection would shrink-wrap the armour and destroy
the authored silhouette; a uniform scale keeps the piece the shape the artist
made and just seats it. Height is untouched, so nothing slides up or down the
torso, and the scale is solved per piece against the measured gap.

    blender --background --factory-startup --python refit_female_armor.py

Writes the female variants in place. Re-run `verify_wearable_fit.py` after.
"""
from __future__ import annotations

import json
import os
import struct
import sys

import numpy as np
from mathutils import Vector
from mathutils.bvhtree import BVHTree

LAB_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, LAB_DIR)

import pose_probe as POSE  # noqa: E402

REPO = os.path.abspath(os.path.join(LAB_DIR, "..", "..", ".."))
EQUIPMENT = os.path.join(REPO, "client-3d", "public", "assets", "pawn-pack", "equipment")

#: Pieces to seat, and the standoff each should end up with. These are the
#: male values: the male set is the reference for how close the armour sits.
TARGETS_MM = {
    "Armor/Gorget.glb": 2.5,
    "Armor/Bicep_L.glb": 1.1,
    "Armor/Bicep_R.glb": 1.5,
    "Armor/Nape_Reinforcement.glb": 4.6,
    "Armor/Reinforcement.glb": 4.8,
}
#: Solve tolerance and iteration cap for the per-piece scale search.
TOLERANCE_MM = 0.6
MAX_STEPS = 24

CT = {5120: ("b", 1), 5121: ("B", 1), 5122: ("h", 2), 5123: ("H", 2),
      5125: ("I", 4), 5126: ("f", 4)}
NC = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4, "MAT4": 16}


def read_glb(path):
    raw = open(path, "rb").read()
    assert raw[:4] == b"glTF", path
    json_len = struct.unpack("<I", raw[12:16])[0]
    doc = json.loads(raw[20:20 + json_len])
    offset, chunks = 20 + json_len, []
    while offset + 8 <= len(raw):
        length, kind = struct.unpack("<II", raw[offset:offset + 8])
        chunks.append((kind, raw[offset + 8:offset + 8 + length]))
        offset += 8 + length + ((4 - length % 4) % 4 if length % 4 else 0)
    return doc, chunks


def view(doc, index):
    a = doc["accessors"][index]
    fmt, size = CT[a["componentType"]]
    nc = NC[a["type"]]
    bv = doc["bufferViews"][a["bufferView"]]
    return (a, fmt, nc, bv.get("byteOffset", 0) + a.get("byteOffset", 0),
            bv.get("byteStride") or (size * nc))


def positions(doc, blob):
    """Every POSITION slot in the file, as (byte offset, x, y, z)."""
    found = []
    for mesh in doc["meshes"]:
        for prim in mesh["primitives"]:
            a, _f, _nc, base, stride = view(doc, prim["attributes"]["POSITION"])
            for k in range(a["count"]):
                offset = base + k * stride
                x, y, z = struct.unpack_from("<fff", blob, offset)
                found.append((offset, x, y, z))
    return found


def write_glb(doc, blob, out_path):
    for mesh in doc["meshes"]:
        for prim in mesh["primitives"]:
            a, _f, _nc, base, stride = view(doc, prim["attributes"]["POSITION"])
            pts = [struct.unpack_from("<fff", blob, base + k * stride)
                   for k in range(a["count"])]
            a["min"] = [min(p[i] for p in pts) for i in range(3)]
            a["max"] = [max(p[i] for p in pts) for i in range(3)]
    doc_bytes = json.dumps(doc, separators=(",", ":")).encode("utf-8")
    doc_bytes += b" " * ((4 - len(doc_bytes) % 4) % 4)
    body = bytes(blob) + b"\x00" * ((4 - len(blob) % 4) % 4)
    with open(out_path, "wb") as fh:
        fh.write(b"glTF" + struct.pack("<II", 2, 12 + 8 + len(doc_bytes) + 8 + len(body)))
        fh.write(struct.pack("<II", len(doc_bytes), 0x4E4F534A) + doc_bytes)
        fh.write(struct.pack("<II", len(body), 0x004E4942) + body)


def nearest_gap_mm(tree, points):
    """Smallest signed distance from a set of points to the body surface."""
    best = float("inf")
    for x, y, z in points:
        location, normal, _, distance = tree.find_nearest(Vector((x, y, z)))
        if location is None:
            continue
        outward = (x - location.x, y - location.y, z - location.z)
        inside = (outward[0] * normal.x + outward[1] * normal.y
                  + outward[2] * normal.z) < 0.0
        best = min(best, distance * 1000.0 * (-1.0 if inside else 1.0))
    return best


def main() -> None:
    body = POSE.Body("female")
    tree = BVHTree.FromPolygons([tuple(p) for p in body.position],
                                [tuple(f) for f in body.faces])
    axis_z = float(np.median(body.position[:, 2]))

    for relative, target in TARGETS_MM.items():
        path = os.path.join(EQUIPMENT, "Female", relative)
        if not os.path.exists(path):
            print(f"[armour] {relative}: missing")
            continue
        doc, chunks = read_glb(path)
        bin_index = next(i for i, (k, _) in enumerate(chunks) if k == 0x004E4942)
        original = bytearray(chunks[bin_index][1])
        slots = positions(doc, original)
        before = nearest_gap_mm(tree, [(x, y, z) for _o, x, y, z in slots])

        # Draw the piece toward the body's vertical axis. Height is left alone:
        # the armour is standing off sideways, not sitting too high.
        low, high = 0.55, 1.0
        chosen, achieved = 1.0, before
        for _ in range(MAX_STEPS):
            factor = 0.5 * (low + high)
            moved = [(x * factor, y, axis_z + (z - axis_z) * factor)
                     for _o, x, y, z in slots]
            gap = nearest_gap_mm(tree, moved)
            chosen, achieved = factor, gap
            if abs(gap - target) <= TOLERANCE_MM:
                break
            if gap > target:
                high = factor      # still floating, pull in harder
            else:
                low = factor       # gone too far, ease off
        blob = bytearray(original)
        for offset, x, y, z in slots:
            struct.pack_into("<fff", blob, offset,
                             x * chosen, y, axis_z + (z - axis_z) * chosen)
        write_glb(doc, blob, path)
        print(f"[armour] {relative}: {before:6.1f} mm -> {achieved:5.1f} mm "
              f"(target {target:.1f}, scale {chosen:.4f})")


if __name__ == "__main__":
    main()
