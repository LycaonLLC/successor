"""Render script for placed extractors.
Generates 4-angle turntable strips for each extractor, and a family lineup render.
Run: /snap/bin/blender -b --factory-startup -P tools/successor/extraction_models/render.py
"""
import os
import sys
import math
import json
import shutil
from pathlib import Path

# Add script directory to path so we can import from build
script_dir = Path(__file__).resolve().parent
sys.path.append(str(script_dir))

import bpy
import bmesh
scn = bpy.context.scene
col = scn.collection
from mathutils import Vector

REPO_ROOT = Path(__file__).resolve().parent.parent.parent.parent
PROOFS_DIR = REPO_ROOT / "verification" / "ledgers" / "artifacts" / "extraction-models"
PROOFS_DIR.mkdir(parents=True, exist_ok=True)
FRAMES_DIR = Path("/tmp/extractor_renders")
if FRAMES_DIR.exists():
    shutil.rmtree(FRAMES_DIR)
FRAMES_DIR.mkdir(parents=True, exist_ok=True)

# Colors and configuration
CELLS_BASE = {
    "0_gunmetal": [0.16, 0.17, 0.19],
    "1_gunmetal_dark": [0.095, 0.1, 0.115],
    "2_rubber": [0.075, 0.075, 0.082],
    "3_steel": [0.44, 0.46, 0.5],
    "5_rust_brown": [0.3, 0.18, 0.11],
    "6_hazard_ochre": [0.85, 0.62, 0.15],
    "7_canvas_tan": [0.55, 0.48, 0.36],
    "8_recess_black": [0.035, 0.035, 0.042],
    "9_worn_steel": [0.28, 0.29, 0.31]
}

ACCENTS = {
    "mineral": [0.85, 0.62, 0.15],
    "chemical": [0.18, 0.35, 0.2],
    "gas": [0.23, 0.48, 0.54],
    "water": [0.16, 0.36, 0.54]
}

CRANK_P = [0.276, 0.4, 0.0]

def B(p):
    return (p[0], -p[2], p[1])

def ring_rect(y, h):
    return [(-h[0], y, -h[1]), (-h[0], y, h[1]), (h[0], y, h[1]), (h[0], y, -h[1])]

def ring_rect_c(y, h, c):
    return [(c[0]-h[0], y, c[1]-h[1]), (c[0]-h[0], y, c[1]+h[1]), (c[0]+h[0], y, c[1]+h[1]), (c[0]+h[0], y, c[1]-h[1])]

def transform_pt(p, dy, tilt_x, rot_y):
    cx = math.cos(tilt_x)
    sx = math.sin(tilt_x)
    y1 = p[1] * cx - p[2] * sx
    z1 = p[1] * sx + p[2] * cx
    cy = math.cos(rot_y)
    sy = math.sin(rot_y)
    x2 = p[0] * cy + z1 * sy
    z2 = -p[0] * sy + z1 * cy
    return (x2, y1 + dy, z2)

# Global material dict to avoid rebuilds
materials = {}

def get_material(category, name_suffix=""):
    mat_key = (category, name_suffix)
    if mat_key in materials:
        return materials[mat_key]
        
    mat = bpy.data.materials.new(f"extractor_{category}_mat{name_suffix}")
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes["Principled BSDF"]
    bsdf.inputs["Roughness"].default_value = 0.85
    
    # Create simple palette color lookup directly in shader to avoid file PNG texture issues during rendering
    # Set the color based on material index or vertex color, but since we map faces to palette,
    # let's just make it simple: we use a color map texture
    GRID = 4
    SIZE = 64
    img = bpy.data.images.new(f"palette_{category}{name_suffix}", SIZE, SIZE)
    accent = ACCENTS[category]
    CELLS = {**CELLS_BASE, "4_rust_orange": accent}
    cell_colors = [(0.095, 0.10, 0.115, 1.0)] * (GRID * GRID)
    for key, rgb in CELLS.items():
        idx = int(key.split("_")[0])
        cell_colors[idx] = (rgb[0], rgb[1], rgb[2], 1.0)
    px = [0.0] * (SIZE * SIZE * 4)
    cpx = SIZE // GRID
    for cy in range(GRID):
        for cx in range(GRID):
            c = cell_colors[cy * GRID + cx]
            for y in range(cy * cpx, (cy + 1) * cpx):
                for x in range(cx * cpx, (cx + 1) * cpx):
                    i = (y * SIZE + x) * 4
                    px[i:i + 4] = c
    img.pixels = px
    
    tex = mat.node_tree.nodes.new("ShaderNodeTexImage")
    tex.image = img
    tex.interpolation = "Closest"
    mat.node_tree.links.new(tex.outputs["Color"], bsdf.inputs["Base Color"])
    
    materials[mat_key] = mat
    return mat

def cell_uv(uv_layer, face, cell):
    GRID = 4
    cx, cy = cell % GRID, cell // GRID
    u, v = (cx + 0.5) / GRID, (cy + 0.5) / GRID
    for loop in face.loops:
        loop[uv_layer].uv = (u, v)

class Builder:
    def __init__(self, name, category, shift_x=0.0):
        self.mesh = bpy.data.meshes.new(name)
        self.bm = bmesh.new()
        self.uv = self.bm.loops.layers.uv.new("UVMap")
        self.name = name
        self.category = category
        self.shift_x = shift_x
        self.CI = {
            "gunmetal": 0, "gunmetal_dark": 1, "rubber": 2, "steel": 3,
            "rust_orange": 4, "rust_brown": 5, "hazard_ochre": 6,
            "canvas_tan": 7, "recess_black": 8, "worn_steel": 9
        }

    def _face(self, verts, cell):
        f = self.bm.faces.new(verts)
        cell_uv(self.uv, f, cell)
        return f

    def prism(self, bot4, top4, cell, cell_top=None, cell_bot=None):
        # Apply shift in X
        bot = [(p[0] + self.shift_x, p[1], p[2]) for p in bot4]
        top = [(p[0] + self.shift_x, p[1], p[2]) for p in top4]
        bv = [self.bm.verts.new(B(p)) for p in bot]
        tv = [self.bm.verts.new(B(p)) for p in top]
        self._face(tuple(tv), cell_top if cell_top is not None else cell)
        self._face(tuple(reversed(bv)), cell_bot if cell_bot is not None else cell)
        for i in range(4):
            j = (i + 1) % 4
            self._face((bv[i], bv[j], tv[j], tv[i]), cell)
        return bv, tv

    def box(self, c, half, cell):
        x0, x1 = c[0] - half[0], c[0] + half[0]
        y0, y1 = c[1] - half[1], c[1] + half[1]
        z0, z1 = c[2] - half[2], c[2] + half[2]
        bot = [(x0, y0, z0), (x1, y0, z0), (x1, y0, z1), (x0, y0, z1)]
        top = [(x0, y1, z0), (x1, y1, z0), (x1, y1, z1), (x0, y1, z1)]
        bot = [bot[0], bot[3], bot[2], bot[1]]
        top = [top[0], top[3], top[2], top[1]]
        return self.prism(bot, top, cell)

    def frustum(self, y0, y1, half0, half1, cell, c=(0.0, 0.0),
                cell_top=None, cell_bot=None):
        def ring(y, h):
            return [(c[0] - h[0], y, c[1] - h[1]), (c[0] - h[0], y, c[1] + h[1]),
                    (c[0] + h[0], y, c[1] + h[1]), (c[0] + h[0], y, c[1] - h[1])]
        return self.prism(ring(y0, half0), ring(y1, half1), cell,
                          cell_top=cell_top, cell_bot=cell_bot)

    def cyl_x(self, x0, x1, cy, cz, r, segs, cell, cap0=True, cap1=True,
              cell_cap=None):
        r0, r1 = [], []
        for i in range(segs):
            a = 2 * math.pi * i / segs
            y, z = cy + r * math.cos(a), cz + r * math.sin(a)
            # shift X
            r0.append(self.bm.verts.new(B((x0 + self.shift_x, y, z))))
            r1.append(self.bm.verts.new(B((x1 + self.shift_x, y, z))))
        for i in range(segs):
            j = (i + 1) % segs
            self._face((r0[i], r1[i], r1[j], r0[j]), cell)
        cc = cell_cap if cell_cap is not None else cell
        if cap0:
            self._face(tuple(r0), cc)
        if cap1:
            self._face(tuple(reversed(r1)), cc)
        return r0, r1

    def cyl_y(self, y0, y1, cx, cz, r, segs, cell, cap0=True, cap1=True):
        r0, r1 = [], []
        for i in range(segs):
            a = 2 * math.pi * i / segs
            x, z = cx + r * math.cos(a), cz + r * math.sin(a)
            r0.append(self.bm.verts.new(B((x + self.shift_x, y0, z))))
            r1.append(self.bm.verts.new(B((x + self.shift_x, y1, z))))
        for i in range(segs):
            j = (i + 1) % segs
            self._face((r0[i], r0[j], r1[j], r1[i]), cell)
        if cap0:
            self._face(tuple(reversed(r0)), cell)
        if cap1:
            self._face(tuple(r1), cell)
        return r0, r1

    def cyl_z(self, z0, z1, cx, cy, r, segs, cell, cap0=True, cap1=True):
        r0, r1 = [], []
        for i in range(segs):
            a = 2 * math.pi * i / segs
            x, y = cx + r * math.cos(a), cy + r * math.sin(a)
            r0.append(self.bm.verts.new(B((x + self.shift_x, y, z0))))
            r1.append(self.bm.verts.new(B((x + self.shift_x, y, z1))))
        for i in range(segs):
            j = (i + 1) % segs
            self._face((r0[i], r0[j], r1[j], r1[i]), cell)
        if cap0:
            self._face(tuple(reversed(r0)), cell)
        if cap1:
            self._face(tuple(r1), cell)
        return r0, r1

    def loft(self, rings, cell, cap_start=True, cap_end=True):
        vr = []
        for ring in rings:
            vr.append([self.bm.verts.new(B((p[0] + self.shift_x, p[1], p[2]))) for p in ring])
        for k in range(len(vr) - 1):
            a, b = vr[k], vr[k + 1]
            for i in range(4):
                j = (i + 1) % 4
                self._face((a[i], a[j], b[j], b[i]), cell)
        if cap_start:
            self._face(tuple(reversed(vr[0])), cell)
        if cap_end:
            self._face(tuple(vr[-1]), cell)
        return vr

    def finish(self, obj_name, origin_gltf=(0.0, 0.0, 0.0), suffix=""):
        self.bm.normal_update()
        ob_loc = B((origin_gltf[0] + self.shift_x, origin_gltf[1], origin_gltf[2]))
        # Shift vertices so origin is at object location
        for v in self.bm.verts:
            v.co.x -= ob_loc[0]
            v.co.y -= ob_loc[1]
            v.co.z -= ob_loc[2]
        self.bm.to_mesh(self.mesh)
        self.bm.free()
        
        # Link material
        mat = get_material(self.category, suffix)
        self.mesh.materials.append(mat)
        
        ob = bpy.data.objects.new(obj_name + suffix, self.mesh)
        ob.location = ob_loc
        col.objects.link(ob)
        return ob

def build_scene_model(category, shift_x=0.0, suffix=""):
    CI = {
        "gunmetal": 0, "gunmetal_dark": 1, "rubber": 2, "steel": 3,
        "rust_orange": 4, "rust_brown": 5, "hazard_ochre": 6,
        "canvas_tan": 7, "recess_black": 8, "worn_steel": 9
    }

    # 1. Base
    bb = Builder("base", category, shift_x)
    for sx in (-1, 1):
        xc = sx * 0.185
        hw = 0.034
        stations = [(-0.270, 0.022), (-0.200, 0.0), (0.200, 0.0), (0.270, 0.022)]
        TOPY = 0.056
        rings = []
        for z, ybot in stations:
            rings.append([(xc - hw, ybot, z), (xc - hw, TOPY, z),
                          (xc + hw, TOPY, z), (xc + hw, ybot, z)])
        bb.loft(rings, CI["worn_steel"])
    for zc in (-0.13, 0.13):
        bb.box((0.0, 0.033, zc), (0.219, 0.019, 0.025), CI["gunmetal_dark"])
    base_ob = bb.finish("base", suffix=suffix)

    # 2. Chassis
    cb = Builder("chassis", category, shift_x)
    if category == "mineral":
        cb.frustum(0.056, 0.8, (0.16, 0.16), (0.18, 0.18), CI["gunmetal"])
        ob_ring = [cb.bm.verts.new(B((p[0] + shift_x, p[1], p[2]))) for p in ring_rect(0.8, (0.18, 0.18))]
        ot_ring = [cb.bm.verts.new(B((p[0] + shift_x, p[1], p[2]))) for p in ring_rect(0.98, (0.22, 0.22))]
        it_ring = [cb.bm.verts.new(B((p[0] + shift_x, p[1], p[2]))) for p in ring_rect(0.98, (0.18, 0.18))]
        fl_ring = [cb.bm.verts.new(B((p[0] + shift_x, p[1], p[2]))) for p in ring_rect(0.85, (0.13, 0.13))]
        for i in range(4):
            j = (i + 1) % 4
            cb._face((ob_ring[i], ob_ring[j], ot_ring[j], ot_ring[i]), CI["rust_orange"])
            cb._face((ot_ring[i], ot_ring[j], it_ring[j], it_ring[i]), CI["gunmetal"])
            cb._face((it_ring[i], it_ring[j], fl_ring[j], fl_ring[i]), CI["recess_black"])
        cb._face(tuple(fl_ring), CI["recess_black"])
        cb._face(tuple(reversed(ob_ring)), CI["recess_black"])
        for k in range(3):
            zc = -0.06 + k * 0.06
            cb.box((0.0, 0.88, zc), (0.12, 0.008, 0.008), CI["steel"])
        cb.cyl_y(0.0, 0.45, 0.0, 0.0, 0.035, 8, CI["worn_steel"])
        for k in range(5):
            dy = 0.05 + k * 0.075
            angle = k * 1.25
            bot = [(-0.09, -0.008, -0.03), (0.09, -0.008, -0.03), (0.09, -0.008, 0.03), (-0.09, -0.008, 0.03)]
            top = [(-0.09, 0.008, -0.03), (0.09, 0.008, -0.03), (0.09, 0.008, 0.03), (-0.09, 0.008, 0.03)]
            bot = [bot[0], bot[3], bot[2], bot[1]]
            top = [top[0], top[3], top[2], top[1]]
            t_bot = [transform_pt(p, dy, 0.45, angle) for p in bot]
            t_top = [transform_pt(p, dy, 0.45, angle) for p in top]
            cb.prism(t_bot, t_top, CI["steel"])
        bzx, by0, by1 = 0.060, 0.35, 0.45
        fw = 0.022
        BZ0, BZ1 = 0.168, 0.188
        cb.box((0.0, by1 + fw / 2, (BZ0 + BZ1) / 2), (bzx + fw, fw / 2, (BZ1 - BZ0) / 2), CI["steel"])
        cb.box((0.0, by0 - fw / 2, (BZ0 + BZ1) / 2), (bzx + fw, fw / 2, (BZ1 - BZ0) / 2), CI["steel"])
        for sx in (-1, 1):
            cb.box((sx * (bzx + fw / 2), (by0 + by1) / 2, (BZ0 + BZ1) / 2),
                   (fw / 2, (by1 - by0) / 2, (BZ1 - BZ0) / 2), CI["steel"])
        cb.box((0.0, 0.4, 0.165), (bzx, 0.05, 0.001), CI["recess_black"])
        cb.box((0.0, 0.4, 0.196), (0.044, 0.04, 0.024), CI["hazard_ochre"])
        cb.box((0.0, 0.4, 0.223), (0.02, 0.01, 0.003), CI["rubber"])
        cb.box((0.242, CRANK_P[1], 0.0), (0.020, 0.038, 0.038), CI["gunmetal"])
        cb.cyl_x(0.262, 0.276, CRANK_P[1], 0.0, 0.030, 10, CI["steel"])

    elif category == "chemical":
        cb.box((0.0, 0.228, 0.0), (0.16, 0.172, 0.16), CI["gunmetal"])
        cb.prism(
            [(-0.14, 0.4, -0.04), (-0.10, 0.4, -0.04), (-0.10, 0.4, 0.04), (-0.14, 0.4, 0.04)],
            [(-0.03, 0.85, -0.03), (-0.01, 0.85, -0.03), (-0.01, 0.85, 0.03), (-0.03, 0.85, 0.03)],
            CI["worn_steel"]
        )
        cb.prism(
            [(0.10, 0.4, -0.04), (0.14, 0.4, -0.04), (0.14, 0.4, 0.04), (0.10, 0.4, 0.04)],
            [(0.01, 0.85, -0.03), (0.03, 0.85, -0.03), (0.03, 0.85, 0.03), (0.01, 0.85, 0.03)],
            CI["worn_steel"]
        )
        cb.cyl_y(0.4, 0.8, 0.0, -0.16, 0.11, 8, CI["worn_steel"])
        cb.cyl_y(0.58, 0.64, 0.0, -0.16, 0.115, 8, CI["rust_orange"])
        cb.box((0.0, 0.88, 0.0), (0.035, 0.03, 0.22), CI["steel"])
        cb.box((0.0, 0.86, 0.24), (0.035, 0.1, 0.03), CI["rust_orange"])
        cb.cyl_y(0.4, 0.76, 0.0, 0.25, 0.012, 6, CI["steel"])
        
        ob_ring = [cb.bm.verts.new(B((p[0] + shift_x, p[1], p[2]))) for p in ring_rect_c(0.8, (0.08, 0.08), (0.0, -0.16))]
        ot_ring = [cb.bm.verts.new(B((p[0] + shift_x, p[1], p[2]))) for p in ring_rect_c(0.95, (0.12, 0.12), (0.0, -0.16))]
        it_ring = [cb.bm.verts.new(B((p[0] + shift_x, p[1], p[2]))) for p in ring_rect_c(0.95, (0.09, 0.09), (0.0, -0.16))]
        fl_ring = [cb.bm.verts.new(B((p[0] + shift_x, p[1], p[2]))) for p in ring_rect_c(0.83, (0.05, 0.05), (0.0, -0.16))]
        for i in range(4):
            j = (i + 1) % 4
            cb._face((ob_ring[i], ob_ring[j], ot_ring[j], ot_ring[i]), CI["rust_orange"])
            cb._face((ot_ring[i], ot_ring[j], it_ring[j], it_ring[i]), CI["gunmetal"])
            cb._face((it_ring[i], it_ring[j], fl_ring[j], fl_ring[i]), CI["recess_black"])
        cb._face(tuple(fl_ring), CI["recess_black"])
        cb._face(tuple(reversed(ob_ring)), CI["recess_black"])
        bzx, by0, by1 = 0.060, 0.148, 0.252
        fw = 0.022
        BZ0, BZ1 = 0.168, 0.188
        cb.box((0.0, by1 + fw / 2, (BZ0 + BZ1) / 2), (bzx + fw, fw / 2, (BZ1 - BZ0) / 2), CI["steel"])
        cb.box((0.0, by0 - fw / 2, (BZ0 + BZ1) / 2), (bzx + fw, fw / 2, (BZ1 - BZ0) / 2), CI["steel"])
        for sx in (-1, 1):
            cb.box((sx * (bzx + fw / 2), (by0 + by1) / 2, (BZ0 + BZ1) / 2),
                   (fw / 2, (by1 - by0) / 2, (BZ1 - BZ0) / 2), CI["steel"])
        cb.box((0.0, 0.200, 0.165), (bzx, 0.050, 0.001), CI["recess_black"])
        cb.box((0.0, 0.200, 0.196), (0.044, 0.040, 0.024), CI["hazard_ochre"])
        cb.box((0.0, 0.200, 0.223), (0.020, 0.010, 0.003), CI["rubber"])
        cb.box((0.242, CRANK_P[1], 0.0), (0.020, 0.038, 0.038), CI["gunmetal"])
        cb.cyl_x(0.262, 0.276, CRANK_P[1], 0.0, 0.030, 10, CI["steel"])

    elif category == "gas":
        cb.cyl_z(-0.20, 0.20, 0.0, 0.20, 0.13, 8, CI["gunmetal"])
        cb.cyl_z(-0.21, -0.20, 0.0, 0.20, 0.12, 8, CI["gunmetal_dark"])
        cb.cyl_z(0.20, 0.21, 0.0, 0.20, 0.12, 8, CI["gunmetal_dark"])
        for zc in (-0.10, 0.10):
            cb.cyl_z(zc - 0.015, zc + 0.015, 0.0, 0.20, 0.135, 8, CI["rust_orange"])
        cb.box((0.0, 0.44, 0.0), (0.11, 0.11, 0.10), CI["gunmetal_dark"])
        for yc in (0.38, 0.46, 0.54):
            cb.box((0.0, yc, 0.0), (0.13, 0.008, 0.12), CI["steel"])
        cb.cyl_y(0.55, 0.95, -0.06, 0.06, 0.016, 6, CI["steel"])
        cb.cyl_y(0.85, 0.87, -0.06, 0.06, 0.05, 8, CI["rust_orange"])
        cb.cyl_z(-0.25, -0.21, 0.0, 0.20, 0.08, 8, CI["worn_steel"])
        
        ob_ring = [cb.bm.verts.new(B((p[0] + shift_x, p[1], p[2]))) for p in ring_rect_c(0.55, (0.08, 0.08), (0.06, -0.02))]
        ot_ring = [cb.bm.verts.new(B((p[0] + shift_x, p[1], p[2]))) for p in ring_rect_c(0.72, (0.12, 0.12), (0.06, -0.02))]
        it_ring = [cb.bm.verts.new(B((p[0] + shift_x, p[1], p[2]))) for p in ring_rect_c(0.72, (0.09, 0.09), (0.06, -0.02))]
        fl_ring = [cb.bm.verts.new(B((p[0] + shift_x, p[1], p[2]))) for p in ring_rect_c(0.58, (0.05, 0.05), (0.06, -0.02))]
        for i in range(4):
            j = (i + 1) % 4
            cb._face((ob_ring[i], ob_ring[j], ot_ring[j], ot_ring[i]), CI["rust_orange"])
            cb._face((ot_ring[i], ot_ring[j], it_ring[j], it_ring[i]), CI["gunmetal"])
            cb._face((it_ring[i], it_ring[j], fl_ring[j], fl_ring[i]), CI["recess_black"])
        cb._face(tuple(fl_ring), CI["recess_black"])
        cb._face(tuple(reversed(ob_ring)), CI["recess_black"])
        bzx, by0, by1 = 0.060, 0.148, 0.252
        fw = 0.022
        BZ0, BZ1 = 0.208, 0.228
        cb.box((0.0, by1 + fw / 2, (BZ0 + BZ1) / 2), (bzx + fw, fw / 2, (BZ1 - BZ0) / 2), CI["steel"])
        cb.box((0.0, by0 - fw / 2, (BZ0 + BZ1) / 2), (bzx + fw, fw / 2, (BZ1 - BZ0) / 2), CI["steel"])
        for sx in (-1, 1):
            cb.box((sx * (bzx + fw / 2), (by0 + by1) / 2, (BZ0 + BZ1) / 2),
                   (fw / 2, (by1 - by0) / 2, (BZ1 - BZ0) / 2), CI["steel"])
        cb.box((0.0, 0.200, 0.205), (bzx, 0.050, 0.001), CI["recess_black"])
        cb.box((0.0, 0.200, 0.236), (0.044, 0.040, 0.024), CI["hazard_ochre"])
        cb.box((0.0, 0.200, 0.263), (0.020, 0.010, 0.003), CI["rubber"])
        cb.box((0.242, CRANK_P[1], 0.0), (0.020, 0.038, 0.038), CI["gunmetal"])
        cb.cyl_x(0.262, 0.276, CRANK_P[1], 0.0, 0.030, 10, CI["steel"])

    elif category == "water":
        cb.box((0.0, 0.153, 0.0), (0.16, 0.097, 0.16), CI["gunmetal"])
        cb.cyl_y(0.25, 1.35, 0.0, 0.0, 0.035, 8, CI["worn_steel"])
        for k in range(3):
            a = k * 2.0 * math.pi / 3.0
            ca, sa = math.cos(a), math.sin(a)
            nx, nz = -sa, ca
            r = 0.032
            R = 0.16
            y0, y1 = 0.70, 1.25
            ib_x, ib_z = r * ca, r * sa
            ob_x, ob_z = R * ca, R * sa
            bot = [
                (ib_x - nx * 0.005, y0, ib_z - nz * 0.005),
                (ib_x + nx * 0.005, y0, ib_z + nz * 0.005),
                (ob_x + nx * 0.005, y0, ob_z + nz * 0.005),
                (ob_x - nx * 0.005, y0, ob_z - nz * 0.005)
            ]
            top = [
                (ib_x - nx * 0.005, y1, ib_z - nz * 0.005),
                (ib_x + nx * 0.005, y1, ib_z + nz * 0.005),
                (ob_x + nx * 0.005, y1, ob_z + nz * 0.005),
                (ob_x - nx * 0.005, y1, ob_z - nz * 0.005)
            ]
            cb.prism(bot, top, CI["steel"])
            bot_acc = [
                (ob_x - nx * 0.006, 0.85, ob_z - nz * 0.006),
                (ob_x + nx * 0.006, 0.85, ob_z + nz * 0.006),
                ((ob_x + nx * 0.006) * 1.05, 0.85, (ob_z + nz * 0.006) * 1.05),
                ((ob_x - nx * 0.006) * 1.05, 0.85, (ob_z - nz * 0.006) * 1.05)
            ]
            top_acc = [
                (ob_x - nx * 0.006, 1.10, ob_z - nz * 0.006),
                (ob_x + nx * 0.006, 1.10, ob_z + nz * 0.006),
                ((ob_x + nx * 0.006) * 1.05, 1.10, (ob_z + nz * 0.006) * 1.05),
                ((ob_x - nx * 0.006) * 1.05, 1.10, (ob_z - nz * 0.006) * 1.05)
            ]
            cb.prism(bot_acc, top_acc, CI["rust_orange"])
        cb.cyl_y(1.30, 1.35, 0.0, 0.0, 0.08, 8, CI["worn_steel"])
        cb.cyl_y(1.35, 1.37, 0.0, 0.0, 0.09, 8, CI["steel"])
        for yc in (0.45, 0.53, 0.61):
            cb.cyl_y(yc - 0.01, yc + 0.01, 0.0, 0.0, 0.065, 8, CI["steel"])
        cb.cyl_z(0.0, 0.12, 0.0, 0.35, 0.012, 6, CI["steel"])
        cb.cyl_y(0.24, 0.35, 0.0, 0.12, 0.012, 6, CI["steel"])
        
        ob_ring = [cb.bm.verts.new(B((p[0] + shift_x, p[1], p[2]))) for p in ring_rect_c(0.25, (0.08, 0.08), (0.0, -0.06))]
        ot_ring = [cb.bm.verts.new(B((p[0] + shift_x, p[1], p[2]))) for p in ring_rect_c(0.37, (0.12, 0.12), (0.0, -0.06))]
        it_ring = [cb.bm.verts.new(B((p[0] + shift_x, p[1], p[2]))) for p in ring_rect_c(0.37, (0.09, 0.09), (0.0, -0.06))]
        fl_ring = [cb.bm.verts.new(B((p[0] + shift_x, p[1], p[2]))) for p in ring_rect_c(0.28, (0.05, 0.05), (0.0, -0.06))]
        for i in range(4):
            j = (i + 1) % 4
            cb._face((ob_ring[i], ob_ring[j], ot_ring[j], ot_ring[i]), CI["rust_orange"])
            cb._face((ot_ring[i], ot_ring[j], it_ring[j], it_ring[i]), CI["gunmetal"])
            cb._face((it_ring[i], it_ring[j], fl_ring[j], fl_ring[i]), CI["recess_black"])
        cb._face(tuple(fl_ring), CI["recess_black"])
        cb._face(tuple(reversed(ob_ring)), CI["recess_black"])
        bzx, by0, by1 = 0.060, 0.08, 0.18
        fw = 0.022
        BZ0, BZ1 = 0.168, 0.188
        cb.box((0.0, by1 + fw / 2, (BZ0 + BZ1) / 2), (bzx + fw, fw / 2, (BZ1 - BZ0) / 2), CI["steel"])
        cb.box((0.0, by0 - fw / 2, (BZ0 + BZ1) / 2), (bzx + fw, fw / 2, (BZ1 - BZ0) / 2), CI["steel"])
        for sx in (-1, 1):
            cb.box((sx * (bzx + fw / 2), (by0 + by1) / 2, (BZ0 + BZ1) / 2),
                   (fw / 2, (by1 - by0) / 2, (BZ1 - BZ0) / 2), CI["steel"])
        cb.box((0.0, 0.13, 0.165), (bzx, 0.04, 0.001), CI["recess_black"])
        cb.box((0.0, 0.13, 0.196), (0.044, 0.035, 0.024), CI["hazard_ochre"])
        cb.box((0.0, 0.13, 0.223), (0.020, 0.010, 0.003), CI["rubber"])
        cb.box((0.242, CRANK_P[1], 0.0), (0.020, 0.038, 0.038), CI["gunmetal"])
        cb.cyl_x(0.262, 0.276, CRANK_P[1], 0.0, 0.030, 10, CI["steel"])

    chassis_ob = cb.finish("chassis", suffix=suffix)

    # 3. Crank
    kb = Builder("crank_pivot", category, shift_x)
    PY, PZ = CRANK_P[1], CRANK_P[2]
    kb.cyl_x(0.280, 0.292, PY, PZ, 0.017, 8, CI["steel"])
    kb.prism(
        [(0.292, PY - 0.098, PZ - 0.014), (0.292, PY - 0.098, PZ + 0.014),
         (0.306, PY - 0.098, PZ + 0.014), (0.306, PY - 0.098, PZ - 0.014)],
        [(0.292, PY + 0.030, PZ - 0.020), (0.292, PY + 0.030, PZ + 0.020),
         (0.306, PY + 0.030, PZ + 0.020), (0.306, PY + 0.030, PZ - 0.020)],
        CI["steel"]
    )
    GRIP_Y = PY - 0.093
    kb.cyl_x(0.306, 0.344, GRIP_Y, PZ, 0.0170, 8, CI["rubber"])
    kb.cyl_x(0.344, 0.352, GRIP_Y, PZ, 0.0100, 8, CI["steel"])
    crank_ob = kb.finish("crank_pivot", origin_gltf=CRANK_P, suffix=suffix)

    # 4. Root
    root = bpy.data.objects.new(f"extractor_{category}_export" + suffix, None)
    col.objects.link(root)
    for ob in (base_ob, chassis_ob):
        ob.parent = root
    crank_ob.parent = chassis_ob
    
    return root

# ================================================================ RENDER RUN
def make_cam(name, loc, look_at, ortho_scale):
    cd = bpy.data.cameras.new(name)
    cd.type = "ORTHO"
    cd.ortho_scale = ortho_scale
    cam = bpy.data.objects.new(name, cd)
    col.objects.link(cam)
    cam.location = loc
    d = (Vector(look_at) - Vector(loc)).normalized()
    cam.rotation_euler = d.to_track_quat("-Z", "Y").to_euler()
    return cam

def setup_lighting_world():
    scn = bpy.context.scene
    engs = [e.identifier for e in bpy.types.RenderSettings.bl_rna.properties["engine"].enum_items]
    scn.render.engine = "BLENDER_EEVEE_NEXT" if "BLENDER_EEVEE_NEXT" in engs else "BLENDER_EEVEE"
    
    w = bpy.data.worlds.new("W")
    scn.world = w
    w.use_nodes = True
    w.node_tree.nodes["Background"].inputs[0].default_value = (0.12, 0.12, 0.14, 1.0)
    w.node_tree.nodes["Background"].inputs[1].default_value = 0.85
    
    for ang, en in [((58, 12, 35), 3.3), ((-35, 0, -125), 1.2), ((-52, -8, 55), 1.0)]:
        ld = bpy.data.lights.new("s", "SUN")
        ld.energy = en
        lo = bpy.data.objects.new("s", ld)
        col.objects.link(lo)
        lo.rotation_euler = tuple(math.radians(a) for a in ang)

    # sand ground plane
    mesh = bpy.data.meshes.new("ground")
    mesh.from_pydata([(-6, -6, 0), (6, -6, 0), (6, 6, 0), (-6, 6, 0)], [], [(0, 1, 2, 3)])
    gnd = bpy.data.objects.new("ground", mesh)
    col.objects.link(gnd)
    gm = bpy.data.materials.new("gnd")
    gm.use_nodes = True
    bsdf = gm.node_tree.nodes.get("Principled BSDF")
    if bsdf:
        bsdf.inputs["Base Color"].default_value = (0.36, 0.30, 0.22, 1.0)
        bsdf.inputs["Roughness"].default_value = 0.95
    gnd.data.materials.append(gm)

    if hasattr(scn.eevee, "use_gtao"):
        scn.eevee.use_gtao = True
        scn.eevee.gtao_distance = 0.15
    scn.render.resolution_x = 640
    scn.render.resolution_y = 640
    scn.render.image_settings.file_format = "PNG"

setup_lighting_world()

# Turntable renders (4 angles: 0, 90, 180, 270)
# We render each category individually
for cat in ["mineral", "chemical", "gas", "water"]:
    print(f"Rendering turntable for {cat}...")
    root = build_scene_model(cat, suffix=f"_{cat}_turn")
    
    # center is roughly C = Vector((0.05, 0.0, 0.24)) for mineral/chem/gas.
    # For water it's taller, center is Vector((0.05, 0.0, 0.65))
    h = 1.35 if cat == "water" else 0.95
    C = Vector((0.05, 0.0, h / 2))
    
    # Iso camera
    cam = make_cam("iso", C + Vector((1.35, -1.35, 1.05)), C, 1.6)
    
    for k in range(4):
        # 4 angles: 0, 90, 180, 270
        angle_deg = 90 * k
        root.rotation_euler = (0, 0, math.radians(angle_deg))
        
        # update scene
        bpy.context.view_layer.update()
        scn.camera = cam
        
        out_path = FRAMES_DIR / f"{cat}_turn_{k}.png"
        scn.render.filepath = str(out_path)
        bpy.ops.render.render(write_still=True)
        
    # Clean up objects for this category to render the next
    bpy.data.objects.remove(cam)
    # Recursively delete root hierarchy
    def delete_hierarchy(ob):
        for child in ob.children:
            delete_hierarchy(child)
        bpy.data.objects.remove(ob)
    delete_hierarchy(root)
    bpy.context.view_layer.update()

# Build family lineup
print("Building family lineup...")
lineup_roots = []
cats = ["mineral", "chemical", "gas", "water"]
shifts = [-0.9, -0.3, 0.3, 0.9]
for cat, shift in zip(cats, shifts):
    root = build_scene_model(cat, shift_x=shift, suffix=f"_{cat}_lineup")
    lineup_roots.append(root)

# Set camera to capture the lineup
C_lineup = Vector((0.0, 0.0, 0.5))
cam_lineup = make_cam("lineup", C_lineup + Vector((0.0, -2.4, 0.8)), C_lineup, 2.5)

bpy.context.view_layer.update()
scn.camera = cam_lineup
out_lineup_path = PROOFS_DIR / "extractor_family_lineup.png"
scn.render.filepath = str(out_lineup_path)
bpy.ops.render.render(write_still=True)

print("RENDERS_COMPLETE")
