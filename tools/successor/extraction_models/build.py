"""Deployable extractor models build script - Bpy headless.
Generates mineral, chemical, gas, and water placed extractors.
"""
import bpy
import bmesh
import json
import math
import sys
import os
from pathlib import Path

# Parse arguments
argv = sys.argv
if '--' in argv:
    category = argv[argv.index('--') + 1]
else:
    category = 'mineral'

print(f"BUILDING MODEL FOR CATEGORY: {category}")

# Set up paths
REPO_ROOT = Path(__file__).resolve().parent.parent.parent.parent
OUT_DIR = REPO_ROOT / "client-3d" / "public" / "assets" / "world-items"
OUT_DIR.mkdir(parents=True, exist_ok=True)

ROUND_DIR = Path(f"/tmp/extractor_{category}")
ROUND_DIR.mkdir(parents=True, exist_ok=True)

GLB_NAME = f"extractor_{category}.glb"
BLEND_NAME = f"extractor_{category}.blend"

FPS = 30
GRID = 4
SIZE = 64

# Define palette cells
CELLS = {
    "0_gunmetal": [0.16, 0.17, 0.19],
    "1_gunmetal_dark": [0.095, 0.1, 0.115],
    "2_rubber": [0.075, 0.075, 0.082],
    "3_steel": [0.44, 0.46, 0.5],
    "4_rust_orange": [0.85, 0.62, 0.15] if category == 'mineral' else \
                     ([0.18, 0.35, 0.2] if category == 'chemical' else \
                      ([0.23, 0.48, 0.54] if category == 'gas' else [0.16, 0.36, 0.54])),
    "5_rust_brown": [0.3, 0.18, 0.11],
    "6_hazard_ochre": [0.85, 0.62, 0.15],
    "7_canvas_tan": [0.55, 0.48, 0.36],
    "8_recess_black": [0.035, 0.035, 0.042],
    "9_worn_steel": [0.28, 0.29, 0.31]
}

NODE = {
    "root": f"extractor_{category}_export",
    "base": "base",
    "chassis": "chassis",
    "crank": "crank_pivot"
}

CRANK_P = [0.276, 0.4, 0.0]

def B(p):
    """glTF (x,y,z) -> Blender (x,-z,y). Inverse of Blender +Y-up export."""
    return (p[0], -p[2], p[1])

# ---------------------------------------------------------------- scene
bpy.ops.wm.read_factory_settings(use_empty=True)
scn = bpy.context.scene
scn.render.fps = FPS
col = scn.collection

# ---------------------------------------------------------------- palette
img = bpy.data.images.new(f"extractor_{category}_palette", SIZE, SIZE)
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
img.filepath_raw = str(ROUND_DIR / "palette.png")
img.file_format = "PNG"
img.save()

mat = bpy.data.materials.new(f"extractor_{category}_mat")
mat.use_nodes = True
bsdf = mat.node_tree.nodes["Principled BSDF"]
bsdf.inputs["Roughness"].default_value = 0.85
tex = mat.node_tree.nodes.new("ShaderNodeTexImage")
tex.image = img
tex.interpolation = "Closest"
mat.node_tree.links.new(tex.outputs["Color"], bsdf.inputs["Base Color"])

# named cells -> index
CI = {k.split("_", 1)[1]: int(k.split("_")[0]) for k in CELLS}

# ---------------------------------------------------------------- helpers
def cell_uv(uv_layer, face, cell):
    cx, cy = cell % GRID, cell // GRID
    u, v = (cx + 0.5) / GRID, (cy + 0.5) / GRID
    for loop in face.loops:
        loop[uv_layer].uv = (u, v)

def transform_pt(p, dy, tilt_x, rot_y):
    # tilt around X
    cx = math.cos(tilt_x)
    sx = math.sin(tilt_x)
    y1 = p[1] * cx - p[2] * sx
    z1 = p[1] * sx + p[2] * cx
    # rotate around Y
    cy = math.cos(rot_y)
    sy = math.sin(rot_y)
    x2 = p[0] * cy + z1 * sy
    z2 = -p[0] * sy + z1 * cy
    # translate Y by dy
    return (x2, y1 + dy, z2)

def ring_rect(y, h):
    return [(-h[0], y, -h[1]), (-h[0], y, h[1]), (h[0], y, h[1]), (h[0], y, -h[1])]

def ring_rect_c(y, h, c):
    return [(c[0]-h[0], y, c[1]-h[1]), (c[0]-h[0], y, c[1]+h[1]), (c[0]+h[0], y, c[1]+h[1]), (c[0]+h[0], y, c[1]-h[1])]

class Builder:
    def __init__(self, name):
        self.mesh = bpy.data.meshes.new(name)
        self.bm = bmesh.new()
        self.uv = self.bm.loops.layers.uv.new("UVMap")
        self.name = name

    def _face(self, verts, cell):
        f = self.bm.faces.new(verts)
        cell_uv(self.uv, f, cell)
        return f

    def prism(self, bot4, top4, cell, cell_top=None, cell_bot=None):
        bv = [self.bm.verts.new(B(p)) for p in bot4]
        tv = [self.bm.verts.new(B(p)) for p in top4]
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
            r0.append(self.bm.verts.new(B((x0, y, z))))
            r1.append(self.bm.verts.new(B((x1, y, z))))
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
            r0.append(self.bm.verts.new(B((x, y0, z))))
            r1.append(self.bm.verts.new(B((x, y1, z))))
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
            r0.append(self.bm.verts.new(B((x, y, z0))))
            r1.append(self.bm.verts.new(B((x, y, z1))))
        for i in range(segs):
            j = (i + 1) % segs
            self._face((r0[i], r0[j], r1[j], r1[i]), cell)
        if cap0:
            self._face(tuple(reversed(r0)), cell)
        if cap1:
            self._face(tuple(r1), cell)
        return r0, r1

    def loft(self, rings, cell, cap_start=True, cap_end=True):
        vr = [[self.bm.verts.new(B(p)) for p in ring] for ring in rings]
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

    def finish(self, obj_name, origin_gltf=(0.0, 0.0, 0.0)):
        self.bm.normal_update()
        ob_loc = B(origin_gltf)
        for v in self.bm.verts:
            v.co.x -= ob_loc[0]
            v.co.y -= ob_loc[1]
            v.co.z -= ob_loc[2]
        self.bm.to_mesh(self.mesh)
        self.bm.free()
        self.mesh.materials.append(mat)
        ob = bpy.data.objects.new(obj_name, self.mesh)
        ob.location = ob_loc
        col.objects.link(ob)
        return ob

# ================================================================ BUILD BASE
bb = Builder("base")
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
base_ob = bb.finish(NODE["base"])

# ================================================================ BUILD CHASSIS
cb = Builder("chassis")

if category == "mineral":
    # Main body frustum
    cb.frustum(0.056, 0.8, (0.16, 0.16), (0.18, 0.18), CI["gunmetal"])
    
    # Hopper
    ob_ring = [cb.bm.verts.new(B(p)) for p in ring_rect(0.8, (0.18, 0.18))]
    ot_ring = [cb.bm.verts.new(B(p)) for p in ring_rect(0.98, (0.22, 0.22))]
    it_ring = [cb.bm.verts.new(B(p)) for p in ring_rect(0.98, (0.18, 0.18))]
    fl_ring = [cb.bm.verts.new(B(p)) for p in ring_rect(0.85, (0.13, 0.13))]
    for i in range(4):
        j = (i + 1) % 4
        cb._face((ob_ring[i], ob_ring[j], ot_ring[j], ot_ring[i]), CI["rust_orange"]) # safety amber
        cb._face((ot_ring[i], ot_ring[j], it_ring[j], it_ring[i]), CI["gunmetal"])
        cb._face((it_ring[i], it_ring[j], fl_ring[j], fl_ring[i]), CI["recess_black"])
    cb._face(tuple(fl_ring), CI["recess_black"])
    cb._face(tuple(reversed(ob_ring)), CI["recess_black"])

    # Grate/details
    for k in range(3):
        zc = -0.06 + k * 0.06
        cb.box((0.0, 0.88, zc), (0.12, 0.008, 0.008), CI["steel"])

    # Vertical drill shaft / auger at bottom
    cb.cyl_y(0.0, 0.45, 0.0, 0.0, 0.035, 8, CI["worn_steel"])
    # 4 spiral fins
    for k in range(5):
        dy = 0.05 + k * 0.075
        angle = k * 1.25 # pitch rotation
        bot = [(-0.09, -0.008, -0.03), (0.09, -0.008, -0.03), (0.09, -0.008, 0.03), (-0.09, -0.008, 0.03)]
        top = [(-0.09, 0.008, -0.03), (0.09, 0.008, -0.03), (0.09, 0.008, 0.03), (-0.09, 0.008, 0.03)]
        bot = [bot[0], bot[3], bot[2], bot[1]]
        top = [top[0], top[3], top[2], top[1]]
        
        t_bot = [transform_pt(p, dy, 0.45, angle) for p in bot]
        t_top = [transform_pt(p, dy, 0.45, angle) for p in top]
        cb.prism(t_bot, t_top, CI["steel"])

    # Front battery slot
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

    # crank mount
    cb.box((0.242, CRANK_P[1], 0.0), (0.020, 0.038, 0.038), CI["gunmetal"])
    cb.cyl_x(0.262, 0.276, CRANK_P[1], 0.0, 0.030, 10, CI["steel"])

elif category == "chemical":
    # Main body box at bottom
    cb.box((0.0, 0.228, 0.0), (0.16, 0.172, 0.16), CI["gunmetal"])
    
    # A-frame legs
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
    
    # Still drum at the back (Z-)
    cb.cyl_y(0.4, 0.8, 0.0, -0.16, 0.11, 8, CI["worn_steel"])
    cb.cyl_y(0.58, 0.64, 0.0, -0.16, 0.115, 8, CI["rust_orange"]) # green accent
    
    # Walking beam
    cb.box((0.0, 0.88, 0.0), (0.035, 0.03, 0.22), CI["steel"])
    cb.box((0.0, 0.86, 0.24), (0.035, 0.1, 0.03), CI["rust_orange"])
    cb.cyl_y(0.4, 0.76, 0.0, 0.25, 0.012, 6, CI["steel"])
    
    # Hopper
    ob_ring = [cb.bm.verts.new(B(p)) for p in ring_rect_c(0.8, (0.08, 0.08), (0.0, -0.16))]
    ot_ring = [cb.bm.verts.new(B(p)) for p in ring_rect_c(0.95, (0.12, 0.12), (0.0, -0.16))]
    it_ring = [cb.bm.verts.new(B(p)) for p in ring_rect_c(0.95, (0.09, 0.09), (0.0, -0.16))]
    fl_ring = [cb.bm.verts.new(B(p)) for p in ring_rect_c(0.83, (0.05, 0.05), (0.0, -0.16))]
    for i in range(4):
        j = (i + 1) % 4
        cb._face((ob_ring[i], ob_ring[j], ot_ring[j], ot_ring[i]), CI["rust_orange"]) # green accent
        cb._face((ot_ring[i], ot_ring[j], it_ring[j], it_ring[i]), CI["gunmetal"])
        cb._face((it_ring[i], it_ring[j], fl_ring[j], fl_ring[i]), CI["recess_black"])
    cb._face(tuple(fl_ring), CI["recess_black"])
    cb._face(tuple(reversed(ob_ring)), CI["recess_black"])

    # Front battery slot
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

    # crank mount
    cb.box((0.242, CRANK_P[1], 0.0), (0.020, 0.038, 0.038), CI["gunmetal"])
    cb.cyl_x(0.262, 0.276, CRANK_P[1], 0.0, 0.030, 10, CI["steel"])

elif category == "gas":
    # Horizontal tank along Z
    cb.cyl_z(-0.20, 0.20, 0.0, 0.20, 0.13, 8, CI["gunmetal"])
    cb.cyl_z(-0.21, -0.20, 0.0, 0.20, 0.12, 8, CI["gunmetal_dark"])
    cb.cyl_z(0.20, 0.21, 0.0, 0.20, 0.12, 8, CI["gunmetal_dark"])
    
    # Tank straps (accent)
    for zc in (-0.10, 0.10):
        cb.cyl_z(zc - 0.015, zc + 0.015, 0.0, 0.20, 0.135, 8, CI["rust_orange"]) # cyan accent
        
    # Compressor block on top
    cb.box((0.0, 0.44, 0.0), (0.11, 0.11, 0.10), CI["gunmetal_dark"])
    for yc in (0.38, 0.46, 0.54):
        cb.box((0.0, yc, 0.0), (0.13, 0.008, 0.12), CI["steel"])
        
    # Bleed stack
    cb.cyl_y(0.55, 0.95, -0.06, 0.06, 0.016, 6, CI["steel"])
    cb.cyl_y(0.85, 0.87, -0.06, 0.06, 0.05, 8, CI["rust_orange"])
    
    # Cowl intake at back
    cb.cyl_z(-0.25, -0.21, 0.0, 0.20, 0.08, 8, CI["worn_steel"])
    
    # Hopper
    ob_ring = [cb.bm.verts.new(B(p)) for p in ring_rect_c(0.55, (0.08, 0.08), (0.06, -0.02))]
    ot_ring = [cb.bm.verts.new(B(p)) for p in ring_rect_c(0.72, (0.12, 0.12), (0.06, -0.02))]
    it_ring = [cb.bm.verts.new(B(p)) for p in ring_rect_c(0.72, (0.09, 0.09), (0.06, -0.02))]
    fl_ring = [cb.bm.verts.new(B(p)) for p in ring_rect_c(0.58, (0.05, 0.05), (0.06, -0.02))]
    for i in range(4):
        j = (i + 1) % 4
        cb._face((ob_ring[i], ob_ring[j], ot_ring[j], ot_ring[i]), CI["rust_orange"]) # cyan accent
        cb._face((ot_ring[i], ot_ring[j], it_ring[j], it_ring[i]), CI["gunmetal"])
        cb._face((it_ring[i], it_ring[j], fl_ring[j], fl_ring[i]), CI["recess_black"])
    cb._face(tuple(fl_ring), CI["recess_black"])
    cb._face(tuple(reversed(ob_ring)), CI["recess_black"])

    # Front battery slot
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

    # crank mount
    cb.box((0.242, CRANK_P[1], 0.0), (0.020, 0.038, 0.038), CI["gunmetal"])
    cb.cyl_x(0.262, 0.276, CRANK_P[1], 0.0, 0.030, 10, CI["steel"])

elif category == "water":
    # Bottom box
    cb.box((0.0, 0.153, 0.0), (0.16, 0.097, 0.16), CI["gunmetal"])
    
    # Central mast
    cb.cyl_y(0.25, 1.35, 0.0, 0.0, 0.035, 8, CI["worn_steel"])
    
    # Tri-vane structure (fins)
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
        
        # Accent stripe on outer edge
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
        cb.prism(bot_acc, top_acc, CI["rust_orange"]) # blue accent

    # Cupped collector head on top
    cb.cyl_y(1.30, 1.35, 0.0, 0.0, 0.08, 8, CI["worn_steel"])
    cb.cyl_y(1.35, 1.37, 0.0, 0.0, 0.09, 8, CI["steel"])
    
    # Condenser rings
    for yc in (0.45, 0.53, 0.61):
        cb.cyl_y(yc - 0.01, yc + 0.01, 0.0, 0.0, 0.065, 8, CI["steel"])
        
    # Drip spout
    cb.cyl_z(0.0, 0.12, 0.0, 0.35, 0.012, 6, CI["steel"])
    cb.cyl_y(0.24, 0.35, 0.0, 0.12, 0.012, 6, CI["steel"])
    
    # Hopper funnel in bottom box
    ob_ring = [cb.bm.verts.new(B(p)) for p in ring_rect_c(0.25, (0.08, 0.08), (0.0, -0.06))]
    ot_ring = [cb.bm.verts.new(B(p)) for p in ring_rect_c(0.37, (0.12, 0.12), (0.0, -0.06))]
    it_ring = [cb.bm.verts.new(B(p)) for p in ring_rect_c(0.37, (0.09, 0.09), (0.0, -0.06))]
    fl_ring = [cb.bm.verts.new(B(p)) for p in ring_rect_c(0.28, (0.05, 0.05), (0.0, -0.06))]
    for i in range(4):
        j = (i + 1) % 4
        cb._face((ob_ring[i], ob_ring[j], ot_ring[j], ot_ring[i]), CI["rust_orange"]) # blue accent
        cb._face((ot_ring[i], ot_ring[j], it_ring[j], it_ring[i]), CI["gunmetal"])
        cb._face((it_ring[i], it_ring[j], fl_ring[j], fl_ring[i]), CI["recess_black"])
    cb._face(tuple(fl_ring), CI["recess_black"])
    cb._face(tuple(reversed(ob_ring)), CI["recess_black"])

    # Front battery slot
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

    # crank mount
    cb.box((0.242, CRANK_P[1], 0.0), (0.020, 0.038, 0.038), CI["gunmetal"])
    cb.cyl_x(0.262, 0.276, CRANK_P[1], 0.0, 0.030, 10, CI["steel"])

chassis_ob = cb.finish(NODE["chassis"])

# ================================================================ BUILD CRANK
kb = Builder("crank_pivot")
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
crank_ob = kb.finish(NODE["crank"], origin_gltf=CRANK_P)

# ================================================================ HIERARCHY
root = bpy.data.objects.new(NODE["root"], None)
col.objects.link(root)
for ob in (base_ob, chassis_ob):
    ob.parent = root
crank_ob.parent = chassis_ob

bpy.context.view_layer.update()

# ================================================================ ANIMATION
def act_fcurves(act):
    out = []
    if hasattr(act, "layers"):
        for layer in act.layers:
            for strip in layer.strips:
                for cbag in strip.channelbags:
                    out.extend(cbag.fcurves)
    if not out and hasattr(act, "fcurves"):
        out = list(act.fcurves)
    return out

def linearize(act):
    for fc in act_fcurves(act):
        for kp in fc.keyframe_points:
            kp.interpolation = "LINEAR"

def quat_keys_360(n_frames, hitch):
    keys = []
    for f in range(n_frames + 1):
        u = f / n_frames
        th = -(2 * math.pi * u + hitch * math.sin(2 * math.pi * u))
        w, x = math.cos(th / 2), math.sin(th / 2)
        q = [w, x, 0.0, 0.0]
        if abs(th) > math.pi:
            q = [-c for c in q]
        keys.append((f, q))
    keys[-1] = (keys[-1][0], list(keys[0][1]))
    return keys

def set_action(ob, name):
    act = bpy.data.actions.new(name)
    if not ob.animation_data:
        ob.animation_data_create()
    ob.animation_data.action = act
    try:
        if len(act.slots):
            ob.animation_data.action_slot = act.slots[0]
    except Exception:
        pass
    return act

def key_quats(ob, name, keys):
    act = set_action(ob, name)
    ob.rotation_mode = "QUATERNION"
    for f, q in keys:
        ob.rotation_quaternion = q
        ob.keyframe_insert("rotation_quaternion", frame=f)
    linearize(act)
    return act

def key_locs(ob, name, base, offs):
    act = set_action(ob, name)
    for f, o in offs:
        ob.location = (base[0] + o[0], base[1] + o[1], base[2] + o[2])
        ob.keyframe_insert("location", frame=f)
    linearize(act)
    return act

CL_FRAMES, CL_HITCH = 36, 0.1
RL_FRAMES, RL_HITCH = 18, 0.0
kc = quat_keys_360(CL_FRAMES, CL_HITCH)
kr = quat_keys_360(RL_FRAMES, RL_HITCH)

a_cl_crank = key_quats(crank_ob, "crank_loop__crank", kc)
a_rl_crank = key_quats(crank_ob, "run_loop__crank", kr)

amp = [0.0012, 0.0008, 0.001]
cyc = [2, 3, 4]
wob = []
for f in range(RL_FRAMES + 1):
    u = f / RL_FRAMES
    gx = amp[0] * math.sin(2 * math.pi * cyc[0] * u)
    gy = amp[1] * math.sin(2 * math.pi * cyc[1] * u)
    gz = amp[2] * math.sin(2 * math.pi * cyc[2] * u)
    wob.append((f, (gx, -gz, gy)))
wob[-1] = (RL_FRAMES, wob[0][1])

a_rl_chassis = key_locs(chassis_ob, "run_loop__chassis", (0.0, 0.0, 0.0), wob)
a_cl_chassis = key_locs(chassis_ob, "crank_loop__chassis", (0.0, 0.0, 0.0),
                        [(0, (0, 0, 0)), (CL_FRAMES, (0, 0, 0))])

def stash(ob, act, track, end):
    tr = ob.animation_data.nla_tracks.new()
    tr.name = track
    st = tr.strips.new(act.name, 0, act)
    st.action_frame_start = 0
    st.action_frame_end = end

crank_ob.animation_data.action = None
chassis_ob.animation_data.action = None
stash(crank_ob, a_cl_crank, "crank_loop", CL_FRAMES)
stash(crank_ob, a_rl_crank, "run_loop", RL_FRAMES)
stash(chassis_ob, a_cl_chassis, "crank_loop", CL_FRAMES)
stash(chassis_ob, a_rl_chassis, "run_loop", RL_FRAMES)

# Canary files
def q_gltf(q):
    return [q[1], q[2], q[3], q[0]]

canary = {
    "crank_loop": {"crank_rotation": [q_gltf(q) for _, q in kc],
                   "chassis_translation": [[0.0, 0.0, 0.0]] * 2,
                   "duration_s": CL_FRAMES / FPS},
    "run_loop": {"crank_rotation": [q_gltf(q) for _, q in kr],
                 "chassis_translation": [[o[0], o[2], -o[1]] for _, o in wob],
                 "duration_s": RL_FRAMES / FPS},
}
(ROUND_DIR / "authored_canary.json").write_text(json.dumps(canary))

# ================================================================ EXPORT
bpy.ops.wm.save_as_mainfile(filepath=str(ROUND_DIR / BLEND_NAME))

bpy.ops.object.select_all(action="SELECT")
out_glb = OUT_DIR / GLB_NAME
bpy.ops.export_scene.gltf(
    filepath=str(out_glb), export_format="GLB", use_selection=True,
    export_yup=True, export_apply=True,
    export_animation_mode="NLA_TRACKS", export_force_sampling=True,
    export_optimize_animation_size=False,
    export_optimize_animation_keep_anim_object=True)

# Copy blend to world-items too as a source convenience
import shutil
shutil.copy(str(ROUND_DIR / BLEND_NAME), str(OUT_DIR / BLEND_NAME))

def tri_count(ob):
    return sum(len(pg.vertices) - 2 for pg in ob.data.polygons)

report = {
    "objects": {ob.name: {"tris": tri_count(ob), "verts": len(ob.data.vertices)}
                for ob in (base_ob, chassis_ob, crank_ob)},
    "total_tris": sum(tri_count(o) for o in (base_ob, chassis_ob, crank_ob)),
    "glb": str(out_glb),
    "blend": str(OUT_DIR / BLEND_NAME),
}
(ROUND_DIR / "build_report.json").write_text(json.dumps(report, indent=2))
print("BUILD_OK", json.dumps(report["objects"]), "total_tris", report["total_tris"])
