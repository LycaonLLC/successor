#!/usr/bin/env python3
"""Build the Dustgate commerce-terminal prop suite (deterministic source of truth).

Produces (runtime dir `client-3d/public/assets/world-items/`):
  - bank_terminal_civic.glb   (secure/private vault kiosk,   ~1.00 x 0.65 x 1.65 m)
  - trade_terminal.glb        (inspection/exchange counter,  ~1.15 x 0.70 x 1.35 m)
  - pa_terminal.glb           (civic roster directory pylon, ~1.05 x 0.65 x 1.75 m)
  - one <asset>_manifest.json + <asset>.provenance.json per GLB
  - commerce_*_basecolor.png / _mr.png / _normal.png / _emissive.png UV maps
    (source-of-record PNGs; identical copies are embedded in each GLB)

Evidence (ignored): .game-lab/commerce-terminals-20260718/ (renders/, gate.json).

Headless:
    /snap/bin/blender -b --factory-startup --python-exit-code 1 \
        -P tools/successor/assets/build_commerce_terminals.py

Design language (premium pass): shared Dustgate civic commerce palette — warm
sand ceramic bodywork over graphite/basalt structure, oxidized brass hardware,
deep teal glass, restrained amber / pale-cyan emissives. Housings are profiled
and layered: chamfered masses, recessed panels behind shadow reveals, corner
fasteners, hinge barrels, cable conduits with clips and junction boxes.
Mechanisms are physically legible: a bladed vault iris with a spoked hub,
sprung scale bellows under a platen, a receipt mouth with cutter bar and
curled stub, louvered service vents. Every material carries UV-backed
baseColor + metallicRoughness + normal maps; screens are emissive textures of
modeled non-text UI. Backs and sides are fully serviced. No baked words, no
franchise/IP motifs. Front (+Z) is the interaction face.

No generative model: hand-authored parametric part program with deterministic
seeded procedural texture maps.
"""
from __future__ import annotations

import hashlib
import json
import math
import re
import shutil
import struct
import subprocess
from pathlib import Path

import bpy
import numpy as np
from mathutils import Matrix, Vector

REPO = Path(__file__).resolve().parents[3]
OUT_DIR = REPO / "client-3d" / "public" / "assets" / "world-items"
EVIDENCE_DIR = REPO / ".game-lab" / "commerce-terminals-20260718"
RENDER_DIR = EVIDENCE_DIR / "renders"
GATE_PATH = EVIDENCE_DIR / "gate.json"
RUN_ID = "commerce-terminals-20260718"

# Shared civic commerce palette (agreed with the commerce-facility shell lane).
# Basalt/ink lifted 2026-07-18 (headed interior QA): the client renders these
# textures UNLIT, so the old #3E4147/#17181B albedos read as void-black slabs
# inside the facility. Still dark basalt/ink language, now legible.
PALETTE = {
    "ceramic": "#C4AE8C",
    "basalt": "#565B63",
    "brass": "#9A7840",
    "patina": "#567A6E",
    "steel": "#8E9296",
    "ink": "#26282E",
    "teal_glass": "#175055",
    "amber": "#E8A34C",
    "cyan": "#A8E4DC",
}

TERMINALS = {
    "bank_terminal_civic": {
        "root_node": "Gear_bank_terminal_civic",
        "dims_m": [1.00, 1.65, 0.65],
        "tri_budget": 9000,
        "proxy_id": "bank_terminal_civic__kiosk",
        "identity": (
            "Dustgate civic bank terminal — secure/private vault kiosk: chamfered "
            "basalt plinth with anchor studs, layered ceramic armor column with "
            "recessed side panels and brass strap bands, a bladed brass vault iris "
            "with spoked hub, dog bolts and an energized seal ring, a recessed "
            "amber deposit throat with roller, an angled credential console with "
            "beveled keypad, recessed teal palm window and half-inserted card, and "
            "a hooded privacy head with a stepped-bezel amber ledger screen. Fully "
            "serviced back: recessed access door on hinge barrels, latch, louvered "
            "vents, clipped cable riser with junction box."
        ),
    },
    "trade_terminal": {
        "root_node": "Gear_trade_terminal",
        "dims_m": [1.15, 1.35, 0.70],
        "tri_budget": 9000,
        "proxy_id": "trade_terminal__counter",
        "identity": (
            "Dustgate district exchange terminal — inspection/exchange counter: "
            "chamfered ceramic counter on a basalt plinth with corner posts and "
            "recessed aprons, a sunken teal scan bed with sloped rim, rails and a "
            "cyan-lensed gantry carriage, a sprung item scale with bellows, brass "
            "collar and hooded amber readout, a receipt mouth with cutter bar and "
            "curled stub, a coin tray, and a brass weight rail with graduated "
            "handled weights. Fully serviced back: hinged hopper chute with latch, "
            "louvered vents, clipped conduit with junction box."
        ),
    },
    "pa_terminal": {
        "root_node": "Gear_pa_terminal",
        "dims_m": [1.05, 1.75, 0.65],
        "tri_budget": 9000,
        "proxy_id": "pa_terminal__pylon",
        "identity": (
            "Dustgate association registry terminal — civic roster pylon: chamfered "
            "basalt feet with anchor studs, a ceramic slab in profiled basalt "
            "pilasters under a stepped cornice with a recessed cyan beacon cove, a "
            "layered brass identity seal on an ink backplate with a cyan halo ring "
            "(geometric, no words), a stepped-bezel portrait roster screen with "
            "side control keys and speaker louvers, and a reader podium with a "
            "two-step brass tap disc and amber slit. Fully serviced back: deep "
            "recessed notice panel with riveted frame, hinged access hatch, "
            "louvered vents, clipped conduit with junction box."
        ),
    },
}

DIM_TOL_M = 0.03
RENDER_RESOLUTION = (1280, 960)
REFERENCE_STAFF_HEIGHT_M = 1.7525
FRONT_CLEARANCE_M = 0.8

# ───────────────────────────── tiny shared helpers ─────────────────────────


def hex_to_rgba(hex_color: str, alpha: float = 1.0):
    hex_color = hex_color.lstrip("#")
    srgb = [int(hex_color[i : i + 2], 16) / 255.0 for i in (0, 2, 4)]
    return (srgb[0], srgb[1], srgb[2], alpha)


def hex_to_linear(hex_color: str) -> np.ndarray:
    c = hex_to_rgba(hex_color)[:3]
    return np.array(
        [(v / 12.92) if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4 for v in c],
        dtype=np.float32,
    )


def logical_to_blender(v):
    x, y, z = v
    return (x, -z, y)


def rounded_key(co, places=7):
    return tuple(round(float(c), places) for c in co)


def write_json(path: Path, data):
    path.write_text(json.dumps(data, indent=2, sort_keys=True) + "\n")


def sha256_of(path: Path) -> str:
    return "sha256:" + hashlib.sha256(path.read_bytes()).hexdigest()


def reset_scene():
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete()
    # Images survive across prop scenes: texture maps are shared.
    for datablocks in (bpy.data.meshes, bpy.data.materials, bpy.data.cameras, bpy.data.lights, bpy.data.actions):
        for block in list(datablocks):
            try:
                datablocks.remove(block)
            except RuntimeError:
                pass
    scene = bpy.context.scene
    scene.unit_settings.system = "METRIC"
    scene.unit_settings.scale_length = 1.0


# ───────────────────────────── mesh construction ───────────────────────────


class MeshBuilder:
    def __init__(self):
        self.verts = []
        self.faces = []
        self.vmap = {}

    def v(self, co):
        key = rounded_key(co)
        idx = self.vmap.get(key)
        if idx is None:
            idx = len(self.verts)
            self.vmap[key] = idx
            self.verts.append(key)
        return idx

    def face(self, coords):
        idx = [self.v(co) for co in coords]
        if len(set(idx)) == len(idx):
            self.faces.append(idx)

    def extend_box(self, center, size):
        cx, cy, cz = center
        sx, sy, sz = size
        x0, x1 = cx - sx / 2, cx + sx / 2
        y0, y1 = cy - sy / 2, cy + sy / 2
        z0, z1 = cz - sz / 2, cz + sz / 2
        self.face([(x0, y0, z1), (x1, y0, z1), (x1, y1, z1), (x0, y1, z1)])
        self.face([(x1, y0, z0), (x0, y0, z0), (x0, y1, z0), (x1, y1, z0)])
        self.face([(x0, y0, z0), (x0, y0, z1), (x0, y1, z1), (x0, y1, z0)])
        self.face([(x1, y0, z1), (x1, y0, z0), (x1, y1, z0), (x1, y1, z1)])
        self.face([(x0, y1, z1), (x1, y1, z1), (x1, y1, z0), (x0, y1, z0)])
        self.face([(x0, y0, z0), (x1, y0, z0), (x1, y0, z1), (x0, y0, z1)])

    def extend_bounds(self, x0, x1, y0, y1, z0, z1):
        self.extend_box(((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2), (x1 - x0, y1 - y0, z1 - z0))

    def extend_prism(self, cx, cz, radius, y0, y1, sides=8, start_deg=0.0):
        ring0, ring1 = [], []
        for i in range(sides):
            a = math.radians(start_deg) + 2.0 * math.pi * i / sides
            x = cx + radius * math.cos(a)
            z = cz + radius * math.sin(a)
            ring0.append((round(x, 7), y0, round(z, 7)))
            ring1.append((round(x, 7), y1, round(z, 7)))
        for i in range(sides):
            j = (i + 1) % sides
            self.face([ring0[i], ring0[j], ring1[j], ring1[i]])
        self.face(list(reversed(ring0)))
        self.face(list(ring1))


def bounds(b, x0, x1, y0, y1, z0, z1):
    b.extend_bounds(x0, x1, y0, y1, z0, z1)


# axis mapper: (u, v, w) -> logical, w positive = outward along the face normal
def _amap(axis):
    if axis == "+z":
        return lambda u, v, w: (u, v, w)
    if axis == "-z":
        return lambda u, v, w: (u, v, -w)
    if axis == "+x":
        return lambda u, v, w: (w, v, u)
    if axis == "-x":
        return lambda u, v, w: (-w, v, u)
    if axis == "+y":
        return lambda u, v, w: (u, w, v)
    raise ValueError(axis)


def plate(b, u0, u1, v0, v1, w_back, w_front, ch, axis="+z"):
    """Proud plate with a chamfered outer border on the face given by `axis`."""
    P = _amap(axis)
    wf0 = w_front - ch
    A = [(u0, v0), (u1, v0), (u1, v1), (u0, v1)]
    B = [(u0 + ch, v0 + ch), (u1 - ch, v0 + ch), (u1 - ch, v1 - ch), (u0 + ch, v1 - ch)]
    for i in range(4):
        j = (i + 1) % 4
        b.face([P(*A[i], w_back), P(*A[j], w_back), P(*A[j], wf0), P(*A[i], wf0)])
        b.face([P(*A[i], wf0), P(*A[j], wf0), P(*B[j], w_front), P(*B[i], w_front)])
    b.face([P(*p, w_back) for p in reversed(A)])
    b.face([P(*p, w_front) for p in B])


def disc_axis(b, cu, cv, radius, w0, w1, axis="+z", sides=16, start_deg=0.0):
    P = _amap(axis)
    r0, r1 = [], []
    for i in range(sides):
        a = math.radians(start_deg) + 2.0 * math.pi * i / sides
        u, v = cu + radius * math.cos(a), cv + radius * math.sin(a)
        r0.append(P(round(u, 7), round(v, 7), w0))
        r1.append(P(round(u, 7), round(v, 7), w1))
    for i in range(sides):
        j = (i + 1) % sides
        b.face([r0[i], r0[j], r1[j], r1[i]])
    b.face(list(reversed(r0)))
    b.face(list(r1))


def ring_axis(b, cu, cv, r_in, r_out, w0, w1, axis="+z", segments=24, start_deg=0.0):
    P = _amap(axis)
    in0, in1, out0, out1 = [], [], [], []
    for i in range(segments):
        a = math.radians(start_deg) + 2.0 * math.pi * i / segments
        ca, sa = math.cos(a), math.sin(a)
        in0.append(P(round(cu + r_in * ca, 7), round(cv + r_in * sa, 7), w0))
        in1.append(P(round(cu + r_in * ca, 7), round(cv + r_in * sa, 7), w1))
        out0.append(P(round(cu + r_out * ca, 7), round(cv + r_out * sa, 7), w0))
        out1.append(P(round(cu + r_out * ca, 7), round(cv + r_out * sa, 7), w1))
    for i in range(segments):
        j = (i + 1) % segments
        b.face([out1[i], out1[j], in1[j], in1[i]])
        b.face([in0[i], in0[j], out0[j], out0[i]])
        b.face([out0[i], out0[j], out1[j], out1[i]])
        b.face([in1[i], in1[j], in0[j], in0[i]])


def screws(b, positions, w0, w1, axis="+z", r=0.0095, sides=6):
    for (u, v) in positions:
        disc_axis(b, u, v, r, w0, w1, axis=axis, sides=sides, start_deg=15.0)


def slab(b, quad, offset):
    """Thin solid extruded from an arbitrary planar quad by `offset` (logical)."""
    q1 = [(p[0] + offset[0], p[1] + offset[1], p[2] + offset[2]) for p in quad]
    b.face(q1)
    b.face(list(reversed(quad)))
    for i in range(4):
        j = (i + 1) % 4
        b.face([quad[i], quad[j], q1[j], q1[i]])


def cable_tube(b, pts, z_center, radius):
    """Smooth octagonal cable tube along an x/y polyline at constant z."""
    def chaikin(path):
        out = [path[0]]
        for i in range(len(path) - 1):
            (x0, y0), (x1, y1) = path[i], path[i + 1]
            out.append((0.75 * x0 + 0.25 * x1, 0.75 * y0 + 0.25 * y1))
            out.append((0.25 * x0 + 0.75 * x1, 0.25 * y0 + 0.75 * y1))
        out.append(path[-1])
        return out

    path = chaikin(chaikin(pts))
    rings = []
    for i, (u, v) in enumerate(path):
        if i == 0:
            du, dv = path[1][0] - u, path[1][1] - v
        else:
            du, dv = u - path[i - 1][0], v - path[i - 1][1]
        ln = math.hypot(du, dv) or 1.0
        nx, ny = -dv / ln, du / ln
        ring = []
        for k in range(8):
            a = 2.0 * math.pi * k / 8
            ring.append((round(u + nx * radius * math.cos(a), 7), round(v + ny * radius * math.cos(a), 7), round(z_center + radius * math.sin(a), 7)))
        rings.append(ring)
    for i in range(len(rings) - 1):
        for k in range(8):
            j = (k + 1) % 8
            b.face([rings[i][k], rings[i][j], rings[i + 1][j], rings[i + 1][k]])
    b.face(list(reversed(rings[0])))
    b.face(list(rings[-1]))


def louvers(b, u0, u1, v_top, n, pitch, w_face, depth, axis="+z", drop=0.020):
    """Row of tilted vent slats on the face given by `axis` (top to bottom)."""
    P = _amap(axis)
    for i in range(n):
        v = v_top - i * pitch
        quad = [P(u0, v, w_face), P(u1, v, w_face), P(u1, v - drop, w_face + depth), P(u0, v - drop, w_face + depth)]
        slab(b, quad, (0.0, 0.007, 0.0))


def oct_plan(x0, x1, z0, z1, ch):
    return [(x0 + ch, z0), (x1 - ch, z0), (x1, z0 + ch), (x1, z1 - ch), (x1 - ch, z1), (x0 + ch, z1), (x0, z1 - ch), (x0, z0 + ch)]


def ngon_frustum(b, poly_lo, y_lo, poly_hi, y_hi, cap_lo=True, cap_hi=True):
    n = len(poly_lo)
    for i in range(n):
        j = (i + 1) % n
        b.face([
            (poly_lo[i][0], y_lo, poly_lo[i][1]), (poly_lo[j][0], y_lo, poly_lo[j][1]),
            (poly_hi[j][0], y_hi, poly_hi[j][1]), (poly_hi[i][0], y_hi, poly_hi[i][1]),
        ])
    if cap_lo:
        b.face([(p[0], y_lo, p[1]) for p in reversed(poly_lo)])
    if cap_hi:
        b.face([(p[0], y_hi, p[1]) for p in poly_hi])


def cham_box(b, x0, x1, y0, y1, z0, z1, ch=0.02):
    """Box with chamfered vertical edges and a chamfered top border."""
    p = oct_plan(x0, x1, z0, z1, ch)
    pin = oct_plan(x0 + ch, x1 - ch, z0 + ch, z1 - ch, ch)
    ngon_frustum(b, p, y0, p, y1 - ch, cap_hi=False)
    ngon_frustum(b, p, y1 - ch, pin, y1, cap_lo=False)


def prism_x(b, cy, cz, radius, x0, x1, sides=8, start_deg=22.5):
    ring0, ring1 = [], []
    for i in range(sides):
        a = math.radians(start_deg) + 2.0 * math.pi * i / sides
        y = cy + radius * math.cos(a)
        z = cz + radius * math.sin(a)
        ring0.append((x0, round(y, 7), round(z, 7)))
        ring1.append((x1, round(y, 7), round(z, 7)))
    for i in range(sides):
        j = (i + 1) % sides
        b.face([ring0[i], ring0[j], ring1[j], ring1[i]])
    b.face(list(ring0))
    b.face(list(reversed(ring1)))


def angled_panel(b, xa, xb, y0, z0, y1, z1, depth):
    b.face([(xa, y0, z0 + depth), (xb, y0, z0 + depth), (xb, y1, z1 + depth), (xa, y1, z1 + depth)])
    b.face([(xb, y0, z0), (xa, y0, z0), (xa, y1, z1), (xb, y1, z1)])
    b.face([(xa, y1, z1 + depth), (xb, y1, z1 + depth), (xb, y1, z1), (xa, y1, z1)])
    b.face([(xb, y0, z0 + depth), (xa, y0, z0 + depth), (xa, y0, z0), (xb, y0, z0)])
    b.face([(xa, y0, z0), (xa, y0, z0 + depth), (xa, y1, z1 + depth), (xa, y1, z1)])
    b.face([(xb, y0, z0 + depth), (xb, y0, z0), (xb, y1, z1), (xb, y1, z1 + depth)])


def rot_box(b, center, size, yaw_deg):
    """Axis box rotated about the vertical (y) axis."""
    cx, cy, cz = center
    sx, sy, sz = size
    a = math.radians(yaw_deg)
    ca, sa = math.cos(a), math.sin(a)

    def R(px, pz):
        return (cx + px * ca + pz * sa, cz - px * sa + pz * ca)

    lo, hi = cy - sy / 2, cy + sy / 2
    plan = [R(-sx / 2, -sz / 2), R(sx / 2, -sz / 2), R(sx / 2, sz / 2), R(-sx / 2, sz / 2)]
    ngon_frustum(b, plan, lo, plan, hi)


def pol(cx, cy, deg, r):
    a = math.radians(deg)
    return (cx + r * math.cos(a), cy + r * math.sin(a))


def make_root(name):
    root = bpy.data.objects.new(name, None)
    bpy.context.collection.objects.link(root)
    root.empty_display_type = "CUBE"
    root.empty_display_size = 0.25
    root.location = (0.0, 0.0, 0.0)
    root.rotation_euler = (0.0, 0.0, 0.0)
    root.scale = (1.0, 1.0, 1.0)
    return root


def assign_box_uvs(mesh, scale=0.85):
    uv = mesh.uv_layers.new(name="UVMap")
    for poly in mesh.polygons:
        n = poly.normal
        ax = max(range(3), key=lambda i: abs(n[i]))
        for li in poly.loop_indices:
            co = mesh.vertices[mesh.loops[li].vertex_index].co
            if ax == 0:
                u, v = co.y, co.z
            elif ax == 1:
                u, v = co.x, co.z
            else:
                u, v = co.x, co.y
            uv.data[li].uv = (u * scale + 0.5, v * scale + 0.5)


def assign_rect_uvs(mesh):
    uv = mesh.uv_layers.new(name="UVMap")
    xs = [v.co.x for v in mesh.vertices]
    zs = [v.co.z for v in mesh.vertices]
    x0, x1 = min(xs), max(xs)
    z0, z1 = min(zs), max(zs)
    dx = max(x1 - x0, 1e-6)
    dz = max(z1 - z0, 1e-6)
    for li, loop in enumerate(mesh.loops):
        co = mesh.vertices[loop.vertex_index].co
        uv.data[li].uv = ((co.x - x0) / dx, (co.z - z0) / dz)


def make_mesh_object(name, builder, mat, root, uv="box", uv_scale=0.85, smooth=False):
    import bmesh

    mesh = bpy.data.meshes.new(name + "Mesh")
    mesh.from_pydata([logical_to_blender(v) for v in builder.verts], [], builder.faces)
    mesh.validate(clean_customdata=True)
    bm = bmesh.new()
    bm.from_mesh(mesh)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(mesh)
    bm.free()
    mesh.update(calc_edges=True)
    if uv == "rect":
        assign_rect_uvs(mesh)
    else:
        assign_box_uvs(mesh, uv_scale)
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(obj)
    obj.parent = root
    obj.location = (0.0, 0.0, 0.0)
    obj.rotation_euler = (0.0, 0.0, 0.0)
    obj.scale = (1.0, 1.0, 1.0)
    obj.data.materials.append(mat)
    for poly in mesh.polygons:
        poly.material_index = 0
        poly.use_smooth = bool(smooth)
    if smooth:
        # keep caps/rims crisp while curved walls shade smooth
        mod = obj.modifiers.new("edge_split", "EDGE_SPLIT")
        mod.split_angle = math.radians(46.0)
        mod.use_edge_angle = True
        mod.use_edge_sharp = False
    return obj


# ─────────────────────── procedural PBR texture maps ───────────────────────


def bilinear_upscale(grid: np.ndarray, w: int, h: int) -> np.ndarray:
    gh, gw = grid.shape
    ys = np.linspace(0.0, gh - 1.0, h, dtype=np.float32)
    xs = np.linspace(0.0, gw - 1.0, w, dtype=np.float32)
    y0 = np.floor(ys).astype(np.int64)
    x0 = np.floor(xs).astype(np.int64)
    y1 = np.minimum(y0 + 1, gh - 1)
    x1 = np.minimum(x0 + 1, gw - 1)
    fy = (ys - y0)[:, None]
    fx = (xs - x0)[None, :]
    a = grid[np.ix_(y0, x0)]
    b = grid[np.ix_(y0, x1)]
    c = grid[np.ix_(y1, x0)]
    d = grid[np.ix_(y1, x1)]
    return a * (1 - fy) * (1 - fx) + b * (1 - fy) * fx + c * fy * (1 - fx) + d * fy * fx


def fbm(rng: np.random.Generator, w: int, h: int, cells=(6, 12, 24), amps=(1.0, 0.5, 0.25)) -> np.ndarray:
    out = np.zeros((h, w), dtype=np.float32)
    total = 0.0
    for c, a in zip(cells, amps):
        out += a * bilinear_upscale(rng.random((c + 1, c + 1), dtype=np.float32), w, h)
        total += a
    return out / total


def blur1d(a: np.ndarray, r: int, axis: int) -> np.ndarray:
    n = a.shape[axis]
    c = np.cumsum(a, axis=axis, dtype=np.float32)
    zshape = list(a.shape)
    zshape[axis] = 1
    c = np.concatenate([np.zeros(zshape, dtype=np.float32), c], axis=axis)
    i0 = np.clip(np.arange(n) - r, 0, n)
    i1 = np.clip(np.arange(n) + r + 1, 0, n)
    s = np.take(c, i1, axis=axis) - np.take(c, i0, axis=axis)
    w = (i1 - i0).astype(np.float32)
    wshape = [1] * a.ndim
    wshape[axis] = n
    return s / w.reshape(wshape)


def soft_glow(img: np.ndarray, radius=7, gain=0.55):
    rgb = img[:, :, :3]
    blur = blur1d(blur1d(rgb, radius, 0), radius, 1)
    img[:, :, :3] = np.maximum(rgb, blur * gain)


def rgba_image(color_hw3: np.ndarray) -> np.ndarray:
    h, w = color_hw3.shape[:2]
    out = np.ones((h, w, 4), dtype=np.float32)
    out[:, :, :3] = np.clip(color_hw3, 0.0, 1.0)
    return out


def mr_image(rough_hw: np.ndarray, metal_hw) -> np.ndarray:
    h, w = rough_hw.shape
    if np.isscalar(metal_hw):
        metal_hw = np.full((h, w), float(metal_hw), dtype=np.float32)
    out = np.ones((h, w, 4), dtype=np.float32)
    out[:, :, 0] = 1.0
    out[:, :, 1] = np.clip(rough_hw, 0.02, 1.0)
    out[:, :, 2] = np.clip(metal_hw, 0.0, 1.0)
    return out


def normal_image(height_hw: np.ndarray, strength=2.4) -> np.ndarray:
    gy, gx = np.gradient(height_hw.astype(np.float32))
    nx = -gx * strength
    ny = -gy * strength
    nz = np.ones_like(height_hw, dtype=np.float32)
    length = np.sqrt(nx * nx + ny * ny + nz * nz)
    out = np.ones((height_hw.shape[0], height_hw.shape[1], 4), dtype=np.float32)
    out[:, :, 0] = nx / length * 0.5 + 0.5
    out[:, :, 1] = ny / length * 0.5 + 0.5
    out[:, :, 2] = nz / length * 0.5 + 0.5
    return out


def panel_grid(size, n, line_px=3, depth=1.0):
    """Height field of recessed panel seams every size/n pixels."""
    h = np.zeros((size, size), dtype=np.float32)
    step = size // n
    for k in range(0, size, step):
        h[:, max(0, k - line_px // 2) : k + line_px // 2 + 1] -= depth
        h[max(0, k - line_px // 2) : k + line_px // 2 + 1, :] -= depth
    return blur1d(blur1d(h[:, :, None], 1, 0), 1, 1)[:, :, 0]


def fill_rect(img, x0, x1, y0, y1, color):
    img[y0:y1, x0:x1, :3] = color


def fill_ring(img, cx, cy, r0, r1, color):
    h, w = img.shape[:2]
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    d = np.sqrt((xx - cx) ** 2 + (yy - cy) ** 2)
    mask = (d >= r0) & (d <= r1)
    img[mask, 0] = color[0]
    img[mask, 1] = color[1]
    img[mask, 2] = color[2]


def tex_ceramic(size=512):
    rng = np.random.default_rng(2026_0718_01)
    base = hex_to_linear(PALETTE["ceramic"])
    mottle = fbm(rng, size, size, cells=(4, 8, 16), amps=(1.0, 0.55, 0.3))
    tone = 0.90 + 0.20 * mottle
    grime = 0.82 + 0.18 * (np.linspace(0.0, 1.0, size, dtype=np.float32)[:, None]) ** 0.6
    seams = panel_grid(size, 4, line_px=4, depth=1.0)
    tone = tone * (1.0 + 0.14 * seams)
    smudge = np.clip((fbm(rng, size, size, cells=(3, 6), amps=(1.0, 0.5)) - 0.58) / 0.25, 0.0, 1.0)
    tone = tone * (1.0 - 0.06 * smudge)
    color = base[None, None, :] * (tone * grime)[:, :, None]
    chips = rng.random((size, size), dtype=np.float32) < 0.0012
    color[chips] *= 0.62
    dust = rng.random((size, size), dtype=np.float32) < 0.0012
    color[dust] = np.minimum(color[dust] * 1.5 + 0.02, 1.0)
    rough = 0.30 + 0.18 * fbm(rng, size, size) - 0.10 * seams - 0.14 * smudge + 0.20 * (1.0 - grime)
    height = 0.5 * mottle + 1.6 * seams
    return rgba_image(color), mr_image(rough, 0.0), normal_image(height, strength=2.0)


def tex_basalt(size=512):
    rng = np.random.default_rng(2026_0718_02)
    base = hex_to_linear(PALETTE["basalt"])
    mottle = fbm(rng, size, size, cells=(5, 10, 20))
    grain = bilinear_upscale(rng.random((40, 40), dtype=np.float32), size, size)  # isotropic hone
    tone = 0.72 + 0.48 * mottle + 0.05 * grain
    color = base[None, None, :] * tone[:, :, None]
    fleck = rng.random((size, size), dtype=np.float32) < 0.012
    color[fleck] *= 1.9
    dustband = (np.linspace(1.0, 0.0, size, dtype=np.float32)[:, None]) ** 3
    color = color * (1.0 - 0.22 * dustband[:, :, None]) + 0.075 * dustband[:, :, None]
    rough = 0.48 + 0.18 * mottle + 0.06 * grain + 0.24 * dustband
    height = 0.35 * mottle + 0.25 * grain
    return rgba_image(color), mr_image(rough, 0.0), normal_image(height, strength=1.6)


def tex_brass(size=256):
    rng = np.random.default_rng(2026_0718_03)
    base = hex_to_linear(PALETTE["brass"])
    patina = hex_to_linear(PALETTE["patina"])
    n = fbm(rng, size, size, cells=(5, 10, 20))
    vgrad = np.linspace(1.0, 0.0, size, dtype=np.float32)[:, None]  # crevice bloom low
    mask = np.clip((n * 0.6 + vgrad * 0.55 - 0.62) / 0.22, 0.0, 1.0) ** 1.5
    brush = bilinear_upscale(rng.random((3, 128), dtype=np.float32), size, size)
    tone = 1.02 + 0.16 * n + 0.06 * brush
    wear = np.clip((fbm(rng, size, size, cells=(16, 32), amps=(1.0, 0.7)) - 0.70) / 0.18, 0.0, 1.0)
    color = base[None, None, :] * tone[:, :, None]
    color = color * (1.0 - 0.62 * mask[:, :, None]) + patina[None, None, :] * (0.62 * mask[:, :, None])
    color = color * (1.0 - wear[:, :, None]) + (base * 1.5)[None, None, :] * wear[:, :, None]
    rough = (0.15 + 0.32 * mask + 0.07 * brush) * (1.0 - wear) + 0.09 * wear
    metal = 1.0 - 0.30 * mask * (1.0 - wear)
    height = 0.20 * brush + 0.30 * n * mask
    return rgba_image(color), mr_image(rough, metal), normal_image(height, strength=1.4)


def tex_steel(size=256):
    rng = np.random.default_rng(2026_0718_04)
    base = hex_to_linear(PALETTE["steel"])
    brush = bilinear_upscale(rng.random((2, 160), dtype=np.float32), size, size)
    fine = fbm(rng, size, size, cells=(24, 48), amps=(1.0, 0.6))
    smf = np.clip((fbm(rng, size, size, cells=(3, 6), amps=(1.0, 0.5)) - 0.55) / 0.30, 0.0, 1.0)
    tone = 0.96 + 0.02 * brush + 0.03 * fine - 0.04 * smf
    color = base[None, None, :] * tone[:, :, None]
    rough = 0.17 + 0.035 * brush + 0.04 * fine + 0.14 * smf
    height = 0.10 * brush
    return rgba_image(color), mr_image(rough, 0.95), normal_image(height, strength=0.8)


def tex_ink(size=256):
    rng = np.random.default_rng(2026_0718_05)
    base = hex_to_linear(PALETTE["ink"])
    n = fbm(rng, size, size)
    color = base[None, None, :] * (0.90 + 0.22 * n)[:, :, None]
    rough = 0.46 + 0.14 * n
    height = 0.15 * n
    return rgba_image(color), mr_image(rough, 0.0), normal_image(height, strength=0.8)


def _scanlines(img, strength=0.12):
    img[::4, :, :3] *= 1.0 - strength


def fill_tri_h(img, x0, y_center, length, half_h, color, direction=1):
    """Horizontal triangle glyph (arrowhead) from vertical strips."""
    for c in range(length):
        frac = c / max(length - 1, 1)
        hh = max(1, int(round(half_h * (1.0 - frac))))
        x = x0 + c if direction > 0 else x0 - c
        fill_rect(img, x, x + 1, int(y_center - hh), int(y_center + hh), color)


def fill_disc(img, cx, cy, r, color):
    fill_ring(img, cx, cy, 0.0, r, color)


def tex_screen_bank(w=384, h=384):
    """Amber bank screen: vault-door glyph, coin stack, amount blocks, and
    two-level status discs. Strong service pictograms, no words."""
    img = np.ones((h, w, 4), dtype=np.float32)
    img[:, :, :3] = hex_to_linear("#160D03")[None, None, :] * 0.85
    dim = hex_to_linear("#7A5218") * 0.5
    mid = hex_to_linear("#C08030") * 0.85
    bright = hex_to_linear("#F0B054") * 1.15
    fill_rect(img, 10, 374, 10, 14, dim)
    fill_rect(img, 10, 374, 370, 374, dim)
    fill_rect(img, 10, 14, 10, 374, dim)
    fill_rect(img, 370, 374, 10, 374, dim)
    # header band with a small vault pip
    fill_rect(img, 24, 360, 330, 356, mid)
    fill_disc(img, 44.0, 343.0, 9.0, bright)
    # LEFT: large vault-door glyph — ring, hub, four spokes
    fill_ring(img, 112.0, 212.0, 52.0, 64.0, mid)
    fill_disc(img, 112.0, 212.0, 18.0, bright)
    fill_rect(img, 108, 116, 230, 264, mid)
    fill_rect(img, 108, 116, 160, 194, mid)
    fill_rect(img, 60, 94, 208, 216, mid)
    fill_rect(img, 130, 164, 208, 216, mid)
    # RIGHT: coin stack + coin face + amount blocks
    for i, y in enumerate((150, 184, 218)):
        fill_rect(img, 210, 330, y, y + 24, bright if i == 1 else mid)
    fill_ring(img, 270.0, 286.0, 22.0, 30.0, bright)
    fill_disc(img, 270.0, 286.0, 12.0, mid)
    fill_rect(img, 210, 300, 108, 128, dim)
    fill_rect(img, 312, 330, 108, 128, bright)
    # BOTTOM: two-level status icons — filled disc = live, hollow ring = idle
    fill_disc(img, 96.0, 62.0, 16.0, bright)
    fill_disc(img, 192.0, 62.0, 16.0, bright)
    fill_ring(img, 288.0, 62.0, 10.0, 16.0, dim)
    soft_glow(img, radius=8, gain=0.6)
    _scanlines(img)
    return img


def tex_screen_trade(w=384, h=384):
    """Cyan exchange screen: opposing exchange arrows, crate glyph, small
    histogram, two-level status icons. No words."""
    img = np.ones((h, w, 4), dtype=np.float32)
    img[:, :, :3] = hex_to_linear("#04100E")[None, None, :] * 0.85
    grid = hex_to_linear("#1E4A46") * 0.45
    mid = hex_to_linear("#5FA89E") * 0.85
    bright = hex_to_linear("#9FE0D8") * 1.1
    amber = hex_to_linear("#E8A34C")
    for x in range(24, 361, 45):
        fill_rect(img, x, x + 1, 18, 366, grid)
    for y in range(18, 367, 45):
        fill_rect(img, 24, 361, y, y + 1, grid)
    fill_rect(img, 24, 360, 330, 356, mid)
    fill_disc(img, 44.0, 343.0, 9.0, bright)
    # CENTER: exchange arrows — outbound bright, inbound amber
    fill_rect(img, 60, 150, 236, 264, bright)
    fill_tri_h(img, 150, 250.0, 46, 40.0, bright, direction=1)
    fill_rect(img, 234, 324, 156, 184, amber)
    fill_tri_h(img, 234, 170.0, 46, 40.0, amber, direction=-1)
    # LEFT-BOTTOM: crate glyph — square outline + cross bands
    fill_rect(img, 52, 152, 60, 68, mid)
    fill_rect(img, 52, 152, 144, 152, mid)
    fill_rect(img, 52, 60, 68, 144, mid)
    fill_rect(img, 144, 152, 68, 144, mid)
    fill_rect(img, 96, 108, 68, 144, mid)
    fill_rect(img, 52, 152, 100, 112, mid)
    # RIGHT-BOTTOM: mini histogram + status icons
    for i, hgt in enumerate((26, 52, 38, 64)):
        x = 210 + i * 24
        fill_rect(img, x, x + 16, 66, 66 + hgt, mid if i % 2 else bright)
    fill_disc(img, 328.0, 40.0, 13.0, bright)
    fill_ring(img, 292.0, 40.0, 8.0, 13.0, grid * 1.8)
    soft_glow(img, radius=8, gain=0.6)
    _scanlines(img)
    return img


def tex_screen_pa(w=384, h=576):
    """Portrait civic roster screen: linked-node crest, roster rows with
    two-level status icons (filled disc = present, hollow ring = away)."""
    img = np.ones((h, w, 4), dtype=np.float32)
    img[:, :, :3] = hex_to_linear("#05100F")[None, None, :] * 0.85
    dim = hex_to_linear("#1E4A46") * 0.65
    mid = hex_to_linear("#5FA89E") * 0.9
    bright = hex_to_linear("#A8E4DC") * 1.05
    amber = hex_to_linear("#E8A34C") * 0.95
    fill_rect(img, 10, 374, 10, 14, dim)
    fill_rect(img, 10, 374, 562, 566, dim)
    fill_rect(img, 10, 14, 10, 566, dim)
    fill_rect(img, 370, 374, 10, 566, dim)
    fill_rect(img, 24, 360, 528, 552, mid)
    # CREST: linked-node association glyph — hub + 4 orthogonal nodes
    fill_disc(img, 192.0, 462.0, 20.0, bright)
    fill_disc(img, 118.0, 462.0, 12.0, mid)
    fill_disc(img, 266.0, 462.0, 12.0, mid)
    fill_disc(img, 192.0, 400.0, 12.0, mid)
    fill_disc(img, 192.0, 512.0, 12.0, amber)
    fill_rect(img, 130, 174, 458, 466, mid)
    fill_rect(img, 210, 254, 458, 466, mid)
    fill_rect(img, 188, 196, 412, 444, mid)
    fill_rect(img, 188, 196, 480, 502, mid)
    # roster rows with two-level status icons
    widths = (225, 264, 198, 252, 216, 240)
    for i, wdt in enumerate(widths):
        y = 330 - i * 48
        fill_disc(img, 46.0, y + 14.0, 10.0, mid if i % 2 else bright)
        fill_rect(img, 68, 68 + wdt, y, y + 28, mid if i % 2 else bright * 0.82)
        if i % 3 == 2:
            fill_ring(img, 344.0, y + 14.0, 8.0, 13.0, dim * 1.4)
        else:
            fill_disc(img, 344.0, y + 14.0, 13.0, bright if i % 2 == 0 else amber)
        fill_rect(img, 30, 360, y - 11, y - 9, dim * 0.6)
    fill_rect(img, 24, 360, 24, 45, dim)
    soft_glow(img, radius=8, gain=0.6)
    _scanlines(img)
    return img


TEXTURE_BUILDERS = {
    "commerce_ceramic": tex_ceramic,
    "commerce_basalt": tex_basalt,
    "commerce_brass": tex_brass,
    "commerce_steel": tex_steel,
    "commerce_ink": tex_ink,
}
SCREEN_BUILDERS = {
    "commerce_screen_bank": tex_screen_bank,
    "commerce_screen_trade": tex_screen_trade,
    "commerce_screen_pa": tex_screen_pa,
}

TEXTURE_FILES: dict[str, Path] = {}


def save_pixels_png(name: str, rgba: np.ndarray, path: Path, non_color: bool):
    h, w = rgba.shape[:2]
    existing = bpy.data.images.get(name)
    if existing is not None:
        bpy.data.images.remove(existing)
    img = bpy.data.images.new(name, width=w, height=h, alpha=True, float_buffer=False)
    if non_color:
        img.colorspace_settings.name = "Non-Color"
    img.pixels.foreach_set(rgba.astype(np.float32).ravel())
    img.filepath_raw = str(path)
    img.file_format = "PNG"
    img.save()
    bpy.data.images.remove(img)


def write_texture_maps():
    for name, builder in TEXTURE_BUILDERS.items():
        base, mr, nrm = builder()
        for suffix, arr, non_color in (("basecolor", base, False), ("mr", mr, True), ("normal", nrm, True)):
            path = OUT_DIR / f"{name}_{suffix}.png"
            save_pixels_png(f"{name}_{suffix}", arr, path, non_color=non_color)
            TEXTURE_FILES[f"{name}_{suffix}"] = path
    for name, builder in SCREEN_BUILDERS.items():
        emissive = builder()
        path = OUT_DIR / f"{name}_emissive.png"
        save_pixels_png(name + "_emissive", emissive, path, non_color=False)
        TEXTURE_FILES[name + "_emissive"] = path


def load_image(key: str, non_color: bool):
    name = TEXTURE_FILES[key].name
    img = bpy.data.images.get(name)
    if img is None:
        img = bpy.data.images.load(str(TEXTURE_FILES[key]))
        img.colorspace_settings.name = "Non-Color" if non_color else "sRGB"
    return img


# ───────────────────────────────── materials ───────────────────────────────

MATERIAL_SPEC = {
    "CM_Ceramic": {"tex": "commerce_ceramic"},
    "CM_Basalt": {"tex": "commerce_basalt"},
    "CM_Brass": {"tex": "commerce_brass"},
    "CM_Steel": {"tex": "commerce_steel"},
    "CM_Ink": {"tex": "commerce_ink"},
    "CM_TealGlass": {"base": PALETTE["teal_glass"], "rough": 0.05, "metal": 0.0, "alpha": 0.22},
    "CM_GlowAmber": {"base": "#141008", "rough": 0.4, "metal": 0.0, "emissive": PALETTE["amber"]},
    "CM_GlowCyan": {"base": "#0A1413", "rough": 0.4, "metal": 0.0, "emissive": PALETTE["cyan"]},
    "CM_ScreenBank": {"screen": "commerce_screen_bank"},
    "CM_ScreenTrade": {"screen": "commerce_screen_trade"},
    "CM_ScreenPA": {"screen": "commerce_screen_pa"},
}

TEXTURED_MATERIALS = {"CM_Ceramic", "CM_Basalt", "CM_Brass", "CM_Steel", "CM_Ink"}

BANK_MATERIALS = {"CM_Ceramic", "CM_Basalt", "CM_Brass", "CM_Steel", "CM_Ink", "CM_TealGlass", "CM_GlowAmber", "CM_ScreenBank"}
TRADE_MATERIALS = {"CM_Ceramic", "CM_Basalt", "CM_Brass", "CM_Steel", "CM_Ink", "CM_TealGlass", "CM_GlowAmber", "CM_GlowCyan", "CM_ScreenTrade"}
PA_MATERIALS = {"CM_Ceramic", "CM_Basalt", "CM_Brass", "CM_Steel", "CM_Ink", "CM_TealGlass", "CM_GlowAmber", "CM_GlowCyan", "CM_ScreenPA"}


def make_materials(names):
    mats = {}
    for name in sorted(names):
        spec = MATERIAL_SPEC[name]
        mat = bpy.data.materials.new(name)
        mat.use_nodes = True
        tree = mat.node_tree
        bsdf = tree.nodes.get("Principled BSDF")
        if "tex" in spec:
            base_node = tree.nodes.new("ShaderNodeTexImage")
            base_node.image = load_image(spec["tex"] + "_basecolor", non_color=False)
            base_node.location = (-560, 320)
            tree.links.new(base_node.outputs["Color"], bsdf.inputs["Base Color"])
            mr_node = tree.nodes.new("ShaderNodeTexImage")
            mr_node.image = load_image(spec["tex"] + "_mr", non_color=True)
            mr_node.location = (-560, 20)
            sep = tree.nodes.new("ShaderNodeSeparateColor")
            sep.location = (-240, 20)
            tree.links.new(mr_node.outputs["Color"], sep.inputs["Color"])
            tree.links.new(sep.outputs["Green"], bsdf.inputs["Roughness"])
            tree.links.new(sep.outputs["Blue"], bsdf.inputs["Metallic"])
            nrm_tex = tree.nodes.new("ShaderNodeTexImage")
            nrm_tex.image = load_image(spec["tex"] + "_normal", non_color=True)
            nrm_tex.location = (-560, -300)
            nrm_map = tree.nodes.new("ShaderNodeNormalMap")
            nrm_map.location = (-240, -300)
            nrm_map.inputs["Strength"].default_value = 1.0
            tree.links.new(nrm_tex.outputs["Color"], nrm_map.inputs["Color"])
            tree.links.new(nrm_map.outputs["Normal"], bsdf.inputs["Normal"])
            if "Coat Weight" in bsdf.inputs and spec["tex"] == "commerce_ceramic":
                bsdf.inputs["Coat Weight"].default_value = 0.55
                if "Coat Roughness" in bsdf.inputs:
                    bsdf.inputs["Coat Roughness"].default_value = 0.08
            mat.diffuse_color = hex_to_rgba(PALETTE.get(spec["tex"].split("_")[1], "#888888"))
        elif "screen" in spec:
            em_node = tree.nodes.new("ShaderNodeTexImage")
            em_node.image = load_image(spec["screen"] + "_emissive", non_color=False)
            em_node.location = (-560, -300)
            bsdf.inputs["Base Color"].default_value = hex_to_rgba("#0B0906")
            bsdf.inputs["Roughness"].default_value = 0.3
            tree.links.new(em_node.outputs["Color"], bsdf.inputs["Emission Color"])
            bsdf.inputs["Emission Strength"].default_value = 2.0
            mat.diffuse_color = hex_to_rgba("#0B0906")
        else:
            alpha = spec.get("alpha", 1.0)
            rgba = hex_to_rgba(spec["base"], alpha)
            mat.diffuse_color = rgba
            bsdf.inputs["Base Color"].default_value = rgba
            bsdf.inputs["Roughness"].default_value = spec["rough"]
            bsdf.inputs["Metallic"].default_value = spec["metal"]
            if "emissive" in spec:
                bsdf.inputs["Emission Color"].default_value = hex_to_rgba(spec["emissive"])
                bsdf.inputs["Emission Strength"].default_value = 1.5
            if alpha < 1.0:
                bsdf.inputs["Alpha"].default_value = alpha
                for attr, value in (("surface_render_method", "BLENDED"), ("blend_method", "BLEND")):
                    try:
                        setattr(mat, attr, value)
                    except Exception:
                        pass
        mats[name] = mat
    return mats


# ──────────────────────────── terminal geometry ────────────────────────────


def build_bank_terminal_civic():
    """Secure/private vault kiosk: 1.00 x 0.65 footprint, 1.65 m tall."""
    reset_scene()
    mats = make_materials(BANK_MATERIALS)
    root = make_root(TERMINALS["bank_terminal_civic"]["root_node"])

    # Chamfered basalt plinth, ink kick reveal, hex anchor studs with washers.
    b = MeshBuilder()
    cham_box(b, -0.50, 0.50, 0.0, 0.12, -0.325, 0.325, ch=0.024)
    cham_box(b, -0.455, 0.455, 0.145, 0.20, -0.295, 0.30, ch=0.018)
    make_mesh_object("base__plinth", b, mats["CM_Basalt"], root)
    b = MeshBuilder()
    bounds(b, -0.43, 0.43, 0.12, 0.145, -0.27, 0.275)
    make_mesh_object("base__kick_reveal", b, mats["CM_Ink"], root)
    b = MeshBuilder()
    for bx, bz in ((-0.415, -0.255), (0.415, -0.255), (-0.415, 0.26), (0.415, 0.26)):
        b.extend_prism(bx, bz, 0.042, 0.12, 0.128, sides=8, start_deg=22.5)  # washer
        b.extend_prism(bx, bz, 0.026, 0.128, 0.168, sides=6, start_deg=15.0)  # hex stud
    make_mesh_object("base__anchor_studs", b, mats["CM_Steel"], root, smooth=True)

    # Layered ceramic armor column with recessed side panels + brass straps.
    b = MeshBuilder()
    cham_box(b, -0.42, 0.42, 0.20, 1.26, -0.26, 0.24, ch=0.03)
    make_mesh_object("body__column", b, mats["CM_Ceramic"], root)
    b = MeshBuilder()
    for axis in ("+x", "-x"):
        bounds_u = (-0.19, 0.17)  # z extent on the side face
        bounds_v = (0.30, 1.14)
        P = _amap(axis)
        b.face([P(bounds_u[0], bounds_v[0], 0.4205), P(bounds_u[1], bounds_v[0], 0.4205), P(bounds_u[1], bounds_v[1], 0.4205), P(bounds_u[0], bounds_v[1], 0.4205)])
    make_mesh_object("body__side_reveals", b, mats["CM_Ink"], root)
    b = MeshBuilder()
    for axis in ("+x", "-x"):
        plate(b, -0.16, 0.14, 0.34, 1.10, 0.4205, 0.443, 0.016, axis=axis)
    make_mesh_object("body__side_panels", b, mats["CM_Ceramic"], root)
    b = MeshBuilder()
    for axis in ("+x", "-x"):
        screws(b, [(-0.135, 0.375), (0.115, 0.375), (-0.135, 1.065), (0.115, 1.065)], 0.443, 0.4515, axis=axis)
    make_mesh_object("body__side_screws", b, mats["CM_Steel"], root)
    b = MeshBuilder()
    for band_y0, band_y1 in ((0.225, 0.285), (1.145, 1.205)):
        cham_box(b, -0.437, 0.437, band_y0, band_y1, -0.277, 0.257, ch=0.02)
    make_mesh_object("body__brass_straps", b, mats["CM_Brass"], root)
    b = MeshBuilder()
    for band_cy in (0.255, 1.175):
        screws(b, [(-0.36, band_cy), (0.0, band_cy), (0.36, band_cy)], 0.257, 0.2655, axis="+z", r=0.0085)
    make_mesh_object("body__strap_bolts", b, mats["CM_Steel"], root)

    # Front apron plate carrying the vault assembly.
    b = MeshBuilder()
    plate(b, -0.37, 0.37, 0.30, 0.735, 0.24, 0.262, 0.018, axis="+z")
    make_mesh_object("body__front_apron", b, mats["CM_Ceramic"], root)

    # Vault iris (secure read): stepped brass collar, recessed dark chamber
    # with an energized amber seal ring, six steel iris blades, spoked brass
    # hub, eight perimeter dog bolts.
    VC = (0.0, 0.515)
    b = MeshBuilder()
    ring_axis(b, *VC, 0.145, 0.205, 0.262, 0.318, segments=48)
    ring_axis(b, *VC, 0.168, 0.205, 0.318, 0.334, segments=48)
    ring_axis(b, *VC, 0.132, 0.145, 0.245, 0.318, segments=48)  # barrel wall of the recess
    make_mesh_object("vault__collar", b, mats["CM_Brass"], root, smooth=True)
    b = MeshBuilder()
    ring_axis(b, *VC, 0.150, 0.156, 0.318, 0.3195, segments=48)
    make_mesh_object("vault__collar_engraving", b, mats["CM_Ink"], root)
    b = MeshBuilder()
    disc_axis(b, *VC, 0.134, 0.238, 0.246, sides=32)
    make_mesh_object("vault__chamber", b, mats["CM_Ink"], root, smooth=True)
    b = MeshBuilder()
    ring_axis(b, *VC, 0.118, 0.132, 0.246, 0.2505, segments=32)
    make_mesh_object("vault__seal_glow", b, mats["CM_GlowAmber"], root, smooth=True)
    b = MeshBuilder()
    for i in range(8):
        a0 = 45.0 * i
        quad = [
            (*pol(*VC, a0 + 6.0, 0.058), 0.0),
            (*pol(*VC, a0 + 50.0, 0.075), 0.0),
            (*pol(*VC, a0 + 38.0, 0.126), 0.0),
            (*pol(*VC, a0 - 5.0, 0.118), 0.0),
        ]
        depth = 0.252 if i % 2 == 0 else 0.259
        quad = [(q[0], q[1], depth) for q in quad]
        slab(b, quad, (0.0, 0.0, 0.010))
    make_mesh_object("vault__iris_blades", b, mats["CM_Steel"], root)
    b = MeshBuilder()
    disc_axis(b, *VC, 0.080, 0.244, 0.256, sides=20)  # rear bearing plate on the chamber wall
    disc_axis(b, *VC, 0.040, 0.256, 0.298, sides=14)  # fat shaft through the blade aperture
    disc_axis(b, *VC, 0.044, 0.296, 0.320, sides=16)
    disc_axis(b, *VC, 0.018, 0.320, 0.3455, sides=12)  # long projecting central axle
    ring_axis(b, *VC, 0.020, 0.034, 0.322, 0.338, segments=16)  # bearing collar
    for a in (90.0, 210.0, 330.0):
        # bolted yoke arms: the hub visibly lands on the collar face
        p_in = pol(*VC, a, 0.030)
        p_out = pol(*VC, a, 0.155)
        side = pol(0, 0, a + 90.0, 0.009)
        quad = [
            (p_in[0] - side[0], p_in[1] - side[1], 0.312),
            (p_in[0] + side[0], p_in[1] + side[1], 0.312),
            (p_out[0] + side[0], p_out[1] + side[1], 0.312),
            (p_out[0] - side[0], p_out[1] - side[1], 0.312),
        ]
        slab(b, quad, (0.0, 0.0, 0.014))
    make_mesh_object("vault__hub_spokes", b, mats["CM_Brass"], root)
    b = MeshBuilder()
    for i in range(8):
        a = 22.5 + 45.0 * i
        u, v = pol(*VC, a, 0.1865)
        disc_axis(b, u, v, 0.0135, 0.334, 0.3455, sides=8, start_deg=a)
    for a in (90.0, 210.0, 330.0):
        u, v = pol(*VC, a, 0.150)
        disc_axis(b, u, v, 0.009, 0.326, 0.336, sides=6, start_deg=a)
    make_mesh_object("vault__dog_bolts", b, mats["CM_Steel"], root)

    # Deposit throat: chamfered ink bezel, amber slit deep inside, brass
    # roller bar under the mouth, two screws.
    b = MeshBuilder()
    plate(b, -0.20, 0.20, 0.74, 0.885, 0.24, 0.276, 0.016, axis="+z")
    make_mesh_object("deposit__bezel", b, mats["CM_Ink"], root)
    b = MeshBuilder()
    for sxn in (-1, 1):
        bounds(b, sxn * 0.145, sxn * 0.168, 0.768, 0.858, 0.24, 0.316)
    bounds(b, -0.168, 0.168, 0.845, 0.866, 0.24, 0.316)
    make_mesh_object("deposit__throat_hood", b, mats["CM_Steel"], root)
    b = MeshBuilder()
    bounds(b, -0.14, 0.14, 0.798, 0.826, 0.252, 0.300)
    make_mesh_object("deposit__slit_glow", b, mats["CM_GlowAmber"], root)
    b = MeshBuilder()
    prism_x(b, 0.834, 0.302, 0.014, -0.14, 0.14, sides=10)
    prism_x(b, 0.790, 0.302, 0.014, -0.14, 0.14, sides=10)
    make_mesh_object("deposit__rollers", b, mats["CM_Brass"], root, smooth=True)
    b = MeshBuilder()
    for sxn in (-1, 1):
        bounds(b, sxn * 0.06, sxn * 0.13, 0.848, 0.862, 0.316, 0.325)
    make_mesh_object("deposit__sensor_pips", b, mats["CM_GlowAmber"], root)
    b = MeshBuilder()
    angled_panel(b, -0.13, 0.13, 0.742, 0.298, 0.768, 0.262, 0.010)
    make_mesh_object("deposit__feed_lip", b, mats["CM_Steel"], root)
    b = MeshBuilder()
    screws(b, [(-0.175, 0.8125), (0.175, 0.8125)], 0.276, 0.2845, axis="+z", r=0.0085)
    make_mesh_object("deposit__screws", b, mats["CM_Steel"], root)

    # Credential console: ceramic pedestal, angled steel pad with beveled
    # two-layer keycaps + amber accept key, recessed teal palm window, card
    # slot with a half-inserted card at a slight yaw.
    b = MeshBuilder()
    cham_box(b, -0.28, 0.28, 0.90, 0.985, 0.24, 0.302, ch=0.016)
    make_mesh_object("cred__pedestal", b, mats["CM_Ceramic"], root)
    b = MeshBuilder()
    for gx in (-0.225, -0.10):
        plate(b, gx, gx + 0.09, 0.912, 0.972, 0.302, 0.310, 0.006, axis="+z")
    make_mesh_object("cred__pictogram_plates", b, mats["CM_Ink"], root)
    b = MeshBuilder()
    # coin glyph: ring + slot bar
    ring_axis(b, -0.18, 0.942, 0.014, 0.022, 0.310, 0.3165, segments=14)
    bounds(b, -0.188, -0.172, 0.936, 0.948, 0.310, 0.315)
    # key glyph: square bow + stem
    bounds(b, -0.067, -0.043, 0.938, 0.962, 0.310, 0.3155)
    bounds(b, -0.059, -0.051, 0.920, 0.938, 0.310, 0.3145)
    make_mesh_object("cred__pictogram_marks", b, mats["CM_Brass"], root)
    pad = ((0.985, 0.288), (1.135, 0.232))

    def pad_pt(t):
        (y0, z0), (y1, z1) = pad
        return (y0 + (y1 - y0) * t, z0 + (z1 - z0) * t)

    b = MeshBuilder()
    angled_panel(b, -0.29, 0.29, *pad_pt(0.0), *pad_pt(1.0), 0.026)
    make_mesh_object("cred__pad", b, mats["CM_Steel"], root)
    b = MeshBuilder()
    y0, z0 = pad_pt(0.14)
    y1, z1 = pad_pt(0.88)
    angled_panel(b, -0.245, -0.045, y0, z0 + 0.026, y1, z1 + 0.026, 0.004)
    make_mesh_object("cred__palm_pocket", b, mats["CM_Ink"], root)
    b = MeshBuilder()
    y0, z0 = pad_pt(0.20)
    y1, z1 = pad_pt(0.82)
    angled_panel(b, -0.23, -0.06, y0, z0 + 0.030, y1, z1 + 0.030, 0.005)
    make_mesh_object("cred__palm_glass", b, mats["CM_TealGlass"], root)
    b = MeshBuilder()
    for row in range(3):
        t0 = 0.16 + 0.26 * row
        ky0, kz0 = pad_pt(t0)
        ky1, kz1 = pad_pt(t0 + 0.15)
        for kx in (0.02, 0.09, 0.16):
            if kx == 0.16 and row in (0, 2):
                continue  # amber accept + brass cancel keys live here
            angled_panel(b, kx, kx + 0.052, ky0, kz0 + 0.026, ky1, kz1 + 0.026, 0.008)
            angled_panel(b, kx + 0.008, kx + 0.044, ky0 + 0.004, kz0 + 0.034, ky1 - 0.004, kz1 + 0.034, 0.004)
    make_mesh_object("cred__keypad", b, mats["CM_Steel"], root)
    b = MeshBuilder()
    ky0, kz0 = pad_pt(0.16)
    ky1, kz1 = pad_pt(0.31)
    angled_panel(b, 0.16, 0.212, ky0, kz0 + 0.026, ky1, kz1 + 0.026, 0.010)
    make_mesh_object("cred__accept_key", b, mats["CM_GlowAmber"], root)
    b = MeshBuilder()
    ky0, kz0 = pad_pt(0.68)
    ky1, kz1 = pad_pt(0.83)
    angled_panel(b, 0.16, 0.212, ky0, kz0 + 0.026, ky1, kz1 + 0.026, 0.010)
    make_mesh_object("cred__cancel_key", b, mats["CM_Brass"], root)
    b = MeshBuilder()
    # iconographic inlays (geometric, no words): accept bar / cancel dot / home nub
    ky0, kz0 = pad_pt(0.215)
    ky1, kz1 = pad_pt(0.255)
    angled_panel(b, 0.172, 0.20, ky0, kz0 + 0.0365, ky1, kz1 + 0.0365, 0.003)
    ky0, kz0 = pad_pt(0.735)
    ky1, kz1 = pad_pt(0.775)
    angled_panel(b, 0.178, 0.194, ky0, kz0 + 0.0365, ky1, kz1 + 0.0365, 0.003)
    ky0, kz0 = pad_pt(0.485)
    ky1, kz1 = pad_pt(0.515)
    angled_panel(b, 0.108, 0.124, ky0, kz0 + 0.0385, ky1, kz1 + 0.0385, 0.003)
    make_mesh_object("cred__key_icons", b, mats["CM_Ink"], root)
    b = MeshBuilder()
    plate(b, 0.03, 0.23, 0.906, 0.962, 0.302, 0.316, 0.010, axis="+z")
    make_mesh_object("cred__card_mouth", b, mats["CM_Ink"], root)
    b = MeshBuilder()
    rot_box(b, (0.13, 0.934, 0.318), (0.13, 0.036, 0.028), 7.0)
    make_mesh_object("cred__inserted_card", b, mats["CM_Ceramic"], root)

    # Privacy head: chamfered basalt hood with brow, ink cheek liners, a
    # stepped ledger-screen recess, brow status lamp, louvered side vents.
    b = MeshBuilder()
    cham_box(b, -0.46, 0.46, 1.26, 1.65, -0.28, 0.10, ch=0.028)
    bounds(b, -0.46, 0.46, 1.555, 1.622, 0.08, 0.298)
    for sxn in (-1, 1):
        bounds(b, sxn * 0.335, sxn * 0.46, 1.26, 1.585, 0.08, 0.262)
    bounds(b, -0.46, 0.46, 1.26, 1.305, 0.08, 0.286)
    make_mesh_object("head__privacy_hood", b, mats["CM_Basalt"], root)
    b = MeshBuilder()
    cham_box(b, -0.445, 0.445, 1.235, 1.278, -0.275, 0.255, ch=0.014)
    for sxn in (-1, 1):
        bounds(b, sxn * 0.40, sxn * 0.462, 1.196, 1.26, -0.11, 0.07)
    make_mesh_object("head__neck_collar", b, mats["CM_Steel"], root)
    b = MeshBuilder()
    bounds(b, -0.46, 0.46, 1.615, 1.648, 0.08, 0.312)
    make_mesh_object("head__brow_cap", b, mats["CM_Basalt"], root)
    b = MeshBuilder()
    for sxn in (-1, 1):
        bounds(b, sxn * 0.322, sxn * 0.335, 1.305, 1.555, 0.10, 0.246)
    bounds(b, -0.335, 0.335, 1.542, 1.555, 0.10, 0.24)
    make_mesh_object("head__cheek_liners", b, mats["CM_Ink"], root)
    b = MeshBuilder()
    angled_panel(b, -0.322, 0.322, 1.308, 0.158, 1.545, 0.108, 0.016)
    make_mesh_object("head__screen_bezel", b, mats["CM_Ink"], root)
    b = MeshBuilder()
    angled_panel(b, -0.295, 0.295, 1.332, 0.156, 1.525, 0.115, 0.015)
    make_mesh_object("head__ledger_screen", b, mats["CM_ScreenBank"], root, uv="rect")
    b = MeshBuilder()
    angled_panel(b, -0.308, 0.308, 1.320, 0.176, 1.535, 0.128, 0.004)
    make_mesh_object("head__screen_glass", b, mats["CM_TealGlass"], root)
    b = MeshBuilder()
    for strip in ((-0.13, 0.13, 1.604, 1.612), (-0.13, 0.13, 1.578, 1.586), (-0.13, -0.105, 1.586, 1.604), (0.105, 0.13, 1.586, 1.604)):
        bounds(b, strip[0], strip[1], strip[2], strip[3], 0.298, 0.309)
    make_mesh_object("head__lamp_bezel", b, mats["CM_Steel"], root)
    b = MeshBuilder()
    bounds(b, -0.105, 0.105, 1.586, 1.604, 0.298, 0.307)
    make_mesh_object("head__status_glow", b, mats["CM_GlowAmber"], root)
    b = MeshBuilder()
    for axis in ("+x", "-x"):
        louvers(b, -0.20, 0.02, 1.56, 3, 0.055, 0.46, 0.014, axis=axis)
    make_mesh_object("head__side_louvers", b, mats["CM_Ink"], root)

    # Serviced back: recessed access door on hinge barrels with latch,
    # riveted frame, louvered head vents, clipped cable riser + junction box.
    b = MeshBuilder()
    for strip in ((-0.37, 0.37, 1.14, 1.20), (-0.37, 0.37, 0.24, 0.30), (-0.37, -0.31, 0.30, 1.14), (0.31, 0.37, 0.30, 1.14)):
        plate(b, strip[0], strip[1], strip[2], strip[3], 0.26, 0.298, 0.012, axis="-z")
    make_mesh_object("back__door_frame", b, mats["CM_Steel"], root)
    b = MeshBuilder()
    plate(b, -0.30, 0.30, 0.31, 1.13, 0.26, 0.283, 0.02, axis="-z")
    make_mesh_object("back__access_door", b, mats["CM_Ceramic"], root)
    b = MeshBuilder()
    for y0, y1 in ((0.42, 0.56), (0.87, 1.01)):
        b.extend_prism(-0.325, -0.305, 0.0165, y0, y1, sides=8)
    make_mesh_object("back__hinge_barrels", b, mats["CM_Brass"], root)
    b = MeshBuilder()
    for yc in (0.455, 0.525, 0.905, 0.975):
        bounds(b, -0.342, -0.296, yc - 0.016, yc + 0.016, -0.294, -0.276)
    make_mesh_object("back__hinge_knuckles", b, mats["CM_Steel"], root)
    b = MeshBuilder()
    disc_axis(b, 0.255, 0.683, 0.014, 0.283, 0.315, axis="-z", sides=10)
    bounds(b, 0.205, 0.305, 0.668, 0.698, -0.333, -0.315)
    make_mesh_object("back__latch_handle", b, mats["CM_Brass"], root)
    b = MeshBuilder()
    bounds(b, 0.215, 0.295, 0.648, 0.718, -0.290, -0.283)
    make_mesh_object("back__latch_keeper", b, mats["CM_Ink"], root)
    b = MeshBuilder()
    screws(b, [(-0.345, 0.335), (0.345, 0.335), (-0.345, 1.105), (0.345, 1.105)], 0.298, 0.3065, axis="-z", r=0.008)
    make_mesh_object("back__frame_screws", b, mats["CM_Steel"], root)
    b = MeshBuilder()
    louvers(b, -0.24, 0.24, 1.55, 4, 0.062, 0.28, 0.016, axis="-z")
    make_mesh_object("back__head_louvers", b, mats["CM_Ink"], root)
    b = MeshBuilder()
    bounds(b, 0.378, 0.428, 0.32, 1.22, -0.316, -0.268)
    cham_box(b, 0.352, 0.454, 0.20, 0.34, -0.322, -0.262, ch=0.012)
    make_mesh_object("back__cable_riser", b, mats["CM_Steel"], root)
    b = MeshBuilder()
    for cy in (0.56, 0.92):
        bounds(b, 0.368, 0.438, cy, cy + 0.034, -0.321, -0.263)
    make_mesh_object("back__riser_clips", b, mats["CM_Brass"], root)
    b = MeshBuilder()
    plate(b, -0.21, 0.05, 0.42, 0.62, 0.283, 0.297, 0.008, axis="-z")
    make_mesh_object("back__port_plate", b, mats["CM_Ink"], root)
    b = MeshBuilder()
    for pu in (-0.155, -0.075, 0.005):
        ring_axis(b, pu, 0.545, 0.015, 0.025, 0.297, 0.308, axis="-z", segments=12)
    make_mesh_object("back__port_collars", b, mats["CM_Brass"], root, smooth=True)
    b = MeshBuilder()
    for pu in (-0.155, -0.075):
        disc_axis(b, pu, 0.545, 0.0148, 0.288, 0.2955, axis="-z", sides=12)
    make_mesh_object("back__socket_cavities", b, mats["CM_Ink"], root)
    b = MeshBuilder()
    disc_axis(b, 0.005, 0.545, 0.0145, 0.297, 0.320, axis="-z", sides=10)
    make_mesh_object("back__port_plug", b, mats["CM_Steel"], root, smooth=True)
    b = MeshBuilder()
    bounds(b, -0.17, 0.01, 0.315, 0.415, -0.288, -0.2825)  # bolted backing plate on the door inset
    bounds(b, -0.13, -0.03, 0.34, 0.405, -0.316, -0.288)  # junction body
    make_mesh_object("back__cable_junction", b, mats["CM_Steel"], root, smooth=True)
    b = MeshBuilder()
    screws(b, [(-0.155, 0.328), (-0.005, 0.328), (-0.155, 0.402), (-0.005, 0.402)], 0.283, 0.30, axis="-z", r=0.012)
    make_mesh_object("back__junction_bolts", b, mats["CM_Brass"], root, smooth=True)
    b = MeshBuilder()
    disc_axis(b, -0.08, -0.307, 0.026, 0.405, 0.443, axis="+y", sides=16)
    disc_axis(b, -0.08, -0.307, 0.017, 0.443, 0.456, axis="+y", sides=6, start_deg=15.0)
    make_mesh_object("back__junction_gland", b, mats["CM_Brass"], root, smooth=True)
    b = MeshBuilder()
    bounds(b, -0.017, 0.027, 0.505, 0.545, -0.318, -0.296)  # plug boot
    # drip loop: sag from the plug, rise into the junction gland
    pts = [(0.005, 0.545), (0.008, 0.50), (-0.005, 0.455), (-0.045, 0.428), (-0.075, 0.42), (-0.08, 0.415)]
    cable_tube(b, pts, -0.307, 0.011)
    make_mesh_object("back__service_cable", b, mats["CM_Ink"], root, smooth=True)
    b = MeshBuilder()
    bounds(b, -0.504, 0.504, 0.0, 0.02, -0.329, 0.329)
    make_mesh_object("base__ground_gasket", b, mats["CM_Ink"], root)
    return root


def build_trade_terminal():
    """Inspection/exchange counter: 1.15 x 0.70 footprint, 1.35 m tall."""
    reset_scene()
    mats = make_materials(TRADE_MATERIALS)
    root = make_root(TERMINALS["trade_terminal"]["root_node"])

    # Basalt plinth + ink reveal + chamfered ceramic counter with corner posts.
    b = MeshBuilder()
    cham_box(b, -0.575, 0.575, 0.0, 0.10, -0.35, 0.35, ch=0.024)
    make_mesh_object("base__plinth", b, mats["CM_Basalt"], root)
    b = MeshBuilder()
    bounds(b, -0.53, 0.53, 0.10, 0.13, -0.305, 0.31)
    make_mesh_object("base__kick_reveal", b, mats["CM_Ink"], root)
    b = MeshBuilder()
    cham_box(b, -0.52, 0.52, 0.13, 0.86, -0.30, 0.30, ch=0.026)
    make_mesh_object("body__counter", b, mats["CM_Ceramic"], root)
    b = MeshBuilder()
    for px in (-0.545, 0.465):
        cham_box(b, px, px + 0.08, 0.10, 0.90, -0.325, -0.245, ch=0.012)
        cham_box(b, px, px + 0.08, 0.10, 0.90, 0.245, 0.325, ch=0.012)
    make_mesh_object("body__corner_posts", b, mats["CM_Basalt"], root)
    b = MeshBuilder()
    for u0, u1 in ((-0.46, -0.07), (0.07, 0.42)):
        plate(b, u0, u1, 0.20, 0.52, 0.30, 0.322, 0.014, axis="+z")
    make_mesh_object("body__front_panels", b, mats["CM_Ceramic"], root)
    b = MeshBuilder()
    screws(b, [(-0.43, 0.235), (-0.10, 0.235), (-0.43, 0.487), (-0.10, 0.487), (0.10, 0.235), (0.39, 0.487)], 0.322, 0.3295, axis="+z", r=0.008)
    make_mesh_object("body__panel_screws", b, mats["CM_Steel"], root)

    # Steel counter top with brass edge trim.
    b = MeshBuilder()
    cham_box(b, -0.56, 0.56, 0.86, 0.925, -0.33, 0.33, ch=0.018)
    make_mesh_object("body__counter_top", b, mats["CM_Steel"], root)
    b = MeshBuilder()
    bounds(b, -0.56, 0.56, 0.845, 0.862, 0.318, 0.334)
    make_mesh_object("body__top_trim", b, mats["CM_Brass"], root)

    # Sunken scan bed: ink tray, sloped rims, cyan underglow, recessed teal
    # glass, side rails and a cyan-lensed gantry carriage on end blocks.
    bed = (-0.50, 0.10, -0.235, 0.195)  # x0, x1, z0, z1 at top opening
    b = MeshBuilder()
    bounds(b, bed[0] + 0.03, bed[1] - 0.03, 0.868, 0.878, bed[2] + 0.03, bed[3] - 0.03)
    make_mesh_object("scan__tray", b, mats["CM_Ink"], root)
    b = MeshBuilder()
    for i in range(4):  # sloped inner rims
        if i == 0:
            quad = [(bed[0], 0.925, bed[2]), (bed[1], 0.925, bed[2]), (bed[1] - 0.03, 0.878, bed[2] + 0.03), (bed[0] + 0.03, 0.878, bed[2] + 0.03)]
        elif i == 1:
            quad = [(bed[1], 0.925, bed[3]), (bed[0], 0.925, bed[3]), (bed[0] + 0.03, 0.878, bed[3] - 0.03), (bed[1] - 0.03, 0.878, bed[3] - 0.03)]
        elif i == 2:
            quad = [(bed[0], 0.925, bed[3]), (bed[0], 0.925, bed[2]), (bed[0] + 0.03, 0.878, bed[2] + 0.03), (bed[0] + 0.03, 0.878, bed[3] - 0.03)]
        else:
            quad = [(bed[1], 0.925, bed[2]), (bed[1], 0.925, bed[3]), (bed[1] - 0.03, 0.878, bed[3] - 0.03), (bed[1] - 0.03, 0.878, bed[2] + 0.03)]
        slab(b, quad, (0.0, -0.006, 0.0))
    make_mesh_object("scan__rim_slopes", b, mats["CM_Basalt"], root)
    b = MeshBuilder()
    bounds(b, bed[0] + 0.035, bed[1] - 0.035, 0.879, 0.888, bed[2] + 0.035, bed[3] - 0.035)
    make_mesh_object("scan__underglow", b, mats["CM_GlowCyan"], root)
    b = MeshBuilder()
    bounds(b, bed[0] + 0.04, bed[1] - 0.04, 0.893, 0.910, bed[2] + 0.04, bed[3] - 0.04)
    make_mesh_object("scan__glass", b, mats["CM_TealGlass"], root)
    b = MeshBuilder()
    for strip in (
        (bed[0] + 0.036, bed[1] - 0.036, bed[2] + 0.036, bed[2] + 0.046),
        (bed[0] + 0.036, bed[1] - 0.036, bed[3] - 0.046, bed[3] - 0.036),
        (bed[0] + 0.036, bed[0] + 0.046, bed[2] + 0.046, bed[3] - 0.046),
        (bed[1] - 0.046, bed[1] - 0.036, bed[2] + 0.046, bed[3] - 0.046),
    ):
        bounds(b, strip[0], strip[1], 0.910, 0.917, strip[2], strip[3])
    make_mesh_object("scan__aperture_glow", b, mats["CM_GlowCyan"], root)
    b = MeshBuilder()
    for rz in (bed[2] - 0.018, bed[3] + 0.002):
        bounds(b, bed[0] - 0.01, bed[1] + 0.01, 0.925, 0.938, rz, rz + 0.016)
    make_mesh_object("scan__rails", b, mats["CM_Steel"], root)
    b = MeshBuilder()
    for cx0 in (bed[0] - 0.014, bed[1] - 0.026):
        for cz0 in (bed[2] - 0.022, bed[3] - 0.018):
            bounds(b, cx0, cx0 + 0.04, 0.925, 0.944, cz0, cz0 + 0.04)
    screws(b, [(bed[0] + 0.006, 0.20), (bed[1] - 0.006, 0.20), (bed[0] + 0.006, -0.24), (bed[1] - 0.006, -0.24)], 0.944, 0.951, axis="+y", r=0.007)
    make_mesh_object("scan__corner_brackets", b, mats["CM_Steel"], root)
    b = MeshBuilder()
    for bz in (bed[2] - 0.02, bed[3] - 0.016):
        cham_box(b, -0.245, -0.185, 0.925, 0.962, bz, bz + 0.036, ch=0.008)
    bounds(b, -0.238, -0.192, 0.938, 0.955, bed[2] + 0.016, bed[3] - 0.016)
    make_mesh_object("scan__carriage", b, mats["CM_Steel"], root)
    b = MeshBuilder()
    bounds(b, -0.229, -0.201, 0.9255, 0.938, bed[2] + 0.02, bed[3] - 0.02)
    make_mesh_object("scan__carriage_lens", b, mats["CM_GlowCyan"], root)

    # Item scale: brass collar, steel bellows stack, chamfered platen with a
    # brass rim, hooded amber readout with buttons.
    SC = (0.35, -0.02)
    b = MeshBuilder()
    b.extend_prism(*SC, 0.175, 0.925, 0.945, sides=64, start_deg=2.8125)
    b.extend_prism(*SC, 0.160, 0.945, 0.958, sides=64, start_deg=2.8125)
    make_mesh_object("scale__collar", b, mats["CM_Brass"], root, smooth=True)
    b = MeshBuilder()
    b.extend_prism(*SC, 0.034, 0.945, 1.022, sides=12, start_deg=15.0)
    for sy in (0.955, 0.9715, 0.988):
        ring_axis(b, *SC, 0.118, 0.146, sy, sy + 0.012, axis="+y", segments=32)
    make_mesh_object("scale__spring", b, mats["CM_Brass"], root, smooth=True)
    b = MeshBuilder()
    for a_deg in (210.0, 270.0, 330.0):  # open guide cage clear of the platen rim
        px = SC[0] + 0.168 * math.cos(math.radians(a_deg))
        pz = SC[1] + 0.168 * math.sin(math.radians(a_deg))
        b.extend_prism(px, pz, 0.011, 0.945, 1.050, sides=8)
    b.extend_prism(SC[0] - 0.135, SC[1] + 0.075, 0.010, 0.945, 1.022, sides=8)  # damper rod, front-left
    make_mesh_object("scale__cage_damper", b, mats["CM_Steel"], root, smooth=True)
    b = MeshBuilder()
    b.extend_prism(*SC, 0.150, 1.022, 1.050, sides=64, start_deg=2.8125)
    make_mesh_object("scale__platen", b, mats["CM_Steel"], root, smooth=True)
    b = MeshBuilder()
    ring_axis(b, *SC, 0.138, 0.152, 1.050, 1.058, axis="+y", segments=64)
    make_mesh_object("scale__platen_rim", b, mats["CM_Brass"], root, smooth=True)
    b = MeshBuilder()
    angled_panel(b, 0.24, 0.46, 0.958, 0.245, 1.006, 0.185, 0.018)
    bounds(b, 0.24, 0.46, 0.925, 0.962, 0.16, 0.25)
    make_mesh_object("scale__readout_hood", b, mats["CM_Steel"], root)
    b = MeshBuilder()
    angled_panel(b, 0.262, 0.438, 0.968, 0.243, 1.000, 0.201, 0.010)
    make_mesh_object("scale__readout_glow", b, mats["CM_GlowAmber"], root)
    b = MeshBuilder()
    b.extend_prism(0.285, 0.285, 0.016, 0.925, 0.94, sides=8)
    b.extend_prism(0.335, 0.285, 0.016, 0.925, 0.938, sides=8)
    make_mesh_object("scale__buttons", b, mats["CM_Brass"], root)

    # Receipt mouth: chamfered steel module, ink mouth, amber slit, cutter
    # bar, curled two-piece stub, roller end caps.
    b = MeshBuilder()
    plate(b, 0.20, 0.48, 0.56, 0.84, 0.30, 0.336, 0.016, axis="+z")
    make_mesh_object("receipt__module", b, mats["CM_Steel"], root)
    b = MeshBuilder()
    bounds(b, 0.235, 0.445, 0.652, 0.706, 0.318, 0.3375)
    make_mesh_object("receipt__mouth", b, mats["CM_Ink"], root)
    b = MeshBuilder()
    bounds(b, 0.248, 0.432, 0.664, 0.688, 0.322, 0.3395, )
    make_mesh_object("receipt__slit_glow", b, mats["CM_GlowAmber"], root)
    b = MeshBuilder()
    for sx in (0.243, 0.413):
        bounds(b, sx, sx + 0.024, 0.744, 0.778, 0.304, 0.336)
    make_mesh_object("receipt__top_slot", b, mats["CM_Ink"], root)
    b = MeshBuilder()
    # paper path: rises out of the top slot, crests, curls over the face, hangs
    slab(b, [(0.27, 0.752, 0.312), (0.41, 0.752, 0.312), (0.41, 0.80, 0.318), (0.27, 0.80, 0.318)], (0.0, 0.0, 0.004))
    slab(b, [(0.27, 0.80, 0.318), (0.41, 0.80, 0.318), (0.41, 0.812, 0.336), (0.27, 0.812, 0.336)], (0.0, 0.0, 0.004))
    slab(b, [(0.27, 0.812, 0.336), (0.41, 0.812, 0.336), (0.41, 0.782, 0.356), (0.27, 0.782, 0.356)], (0.0, 0.0, 0.004))
    slab(b, [(0.27, 0.782, 0.356), (0.41, 0.782, 0.356), (0.41, 0.71, 0.361), (0.27, 0.71, 0.361)], (0.0, 0.0, 0.004))
    make_mesh_object("receipt__paper_path", b, mats["CM_Ceramic"], root)
    b = MeshBuilder()
    for rx in (0.255, 0.401):
        prism_x(b, 0.762, 0.318, 0.009, rx - 0.012, rx + 0.012, sides=8)
    make_mesh_object("receipt__slot_roller_caps", b, mats["CM_Brass"], root, smooth=True)

    # Coin tray: open steel tray, brass coins (one pair stacked, one tilted).
    b = MeshBuilder()
    bounds(b, -0.46, -0.18, 0.575, 0.601, 0.302, 0.348)
    bounds(b, -0.46, -0.432, 0.601, 0.678, 0.302, 0.348)
    bounds(b, -0.208, -0.18, 0.601, 0.678, 0.302, 0.348)
    bounds(b, -0.432, -0.208, 0.601, 0.636, 0.302, 0.316)
    make_mesh_object("tray__body", b, mats["CM_Steel"], root)
    b = MeshBuilder()
    for cxx, czz, cy in ((-0.385, 0.322, 0.601), (-0.385, 0.322, 0.617), (-0.315, 0.318, 0.601), (-0.252, 0.328, 0.601)):
        b.extend_prism(cxx, czz, 0.021, cy, cy + 0.015, sides=10, start_deg=9.0)
    make_mesh_object("tray__coins", b, mats["CM_Brass"], root, smooth=True)

    # Side weight rail: brass rail on steel brackets, three graduated
    # chamfered weights with bar handles.
    b = MeshBuilder()
    bounds(b, -0.575, -0.52, 0.925, 0.958, -0.21, 0.17)
    make_mesh_object("rail__beam", b, mats["CM_Brass"], root)
    b = MeshBuilder()
    for bz in (-0.185, 0.145):
        bounds(b, -0.558, -0.53, 0.895, 0.925, bz - 0.016, bz + 0.016)
    make_mesh_object("rail__brackets", b, mats["CM_Steel"], root)
    b = MeshBuilder()
    for czz, ybot in ((-0.135, 0.795), (-0.005, 0.825), (0.115, 0.852)):
        cham_box(b, -0.567, -0.528, ybot, 0.902, czz - 0.030, czz + 0.030, ch=0.007)
        bounds(b, -0.5555, -0.5395, 0.902, 0.94, czz - 0.005, czz + 0.005)
    make_mesh_object("rail__weights", b, mats["CM_Steel"], root)

    # Rear readout mast + stepped-bezel trade screen, LED strip, side cable.
    b = MeshBuilder()
    cham_box(b, -0.30, 0.30, 0.86, 1.12, -0.345, -0.24, ch=0.02)
    cham_box(b, -0.36, 0.36, 1.10, 1.35, -0.35, -0.20, ch=0.024)
    make_mesh_object("mast__body", b, mats["CM_Basalt"], root)
    b = MeshBuilder()
    angled_panel(b, -0.325, 0.325, 1.115, -0.198, 1.335, -0.262, 0.016)
    make_mesh_object("mast__screen_bezel", b, mats["CM_Ink"], root)
    b = MeshBuilder()
    angled_panel(b, -0.335, 0.335, 1.108, -0.208, 1.342, -0.272, 0.006)
    make_mesh_object("mast__bezel_step", b, mats["CM_Steel"], root)
    b = MeshBuilder()
    angled_panel(b, -0.295, 0.295, 1.14, -0.194, 1.315, -0.245, 0.015)
    make_mesh_object("mast__trade_screen", b, mats["CM_ScreenTrade"], root, uv="rect")
    b = MeshBuilder()
    angled_panel(b, -0.308, 0.308, 1.128, -0.180, 1.326, -0.238, 0.004)
    make_mesh_object("mast__screen_glass", b, mats["CM_TealGlass"], root)
    b = MeshBuilder()
    bounds(b, -0.20, 0.20, 1.078, 1.096, -0.245, -0.232)
    make_mesh_object("mast__status_glow", b, mats["CM_GlowAmber"], root)
    b = MeshBuilder()
    bounds(b, 0.315, 0.345, 0.925, 1.14, -0.30, -0.272)
    for cy in (0.99, 1.09):
        bounds(b, 0.308, 0.352, cy, cy + 0.024, -0.304, -0.268)
    make_mesh_object("mast__cable", b, mats["CM_Ink"], root)

    # Serviced back: hinged hopper chute with latch, louvers, clipped conduit
    # with junction box.
    b = MeshBuilder()
    for strip in ((0.10, 0.46, 0.60, 0.645), (0.10, 0.46, 0.27, 0.315), (0.10, 0.145, 0.315, 0.60), (0.415, 0.46, 0.315, 0.60)):
        plate(b, strip[0], strip[1], strip[2], strip[3], 0.30, 0.332, 0.010, axis="-z")
    make_mesh_object("hopper__frame", b, mats["CM_Steel"], root)
    b = MeshBuilder()
    screws(b, [(0.125, 0.29), (0.435, 0.29), (0.125, 0.622), (0.435, 0.622)], 0.332, 0.3395, axis="-z", r=0.0075)
    make_mesh_object("hopper__frame_screws", b, mats["CM_Brass"], root)
    b = MeshBuilder()
    slab(b, [(0.155, 0.585, -0.345), (0.405, 0.585, -0.345), (0.405, 0.33, -0.318), (0.155, 0.33, -0.318)], (0.0, 0.0, 0.012))
    make_mesh_object("hopper__door", b, mats["CM_Basalt"], root)
    b = MeshBuilder()
    for hx in (0.20, 0.36):
        prism_x(b, 0.592, -0.338, 0.014, hx - 0.028, hx + 0.028, sides=8)
    make_mesh_object("hopper__hinges", b, mats["CM_Brass"], root)
    b = MeshBuilder()
    disc_axis(b, 0.280, 0.353, 0.013, 0.332, 0.360, axis="-z", sides=10)
    bounds(b, 0.235, 0.325, 0.340, 0.366, -0.360, -0.344)
    make_mesh_object("hopper__latch", b, mats["CM_Brass"], root)
    b = MeshBuilder()
    bounds(b, 0.245, 0.315, 0.322, 0.384, -0.336, -0.330)
    make_mesh_object("hopper__latch_keeper", b, mats["CM_Ink"], root)
    b = MeshBuilder()
    louvers(b, -0.44, -0.08, 0.57, 5, 0.058, 0.30, 0.016, axis="-z")
    make_mesh_object("back__louvers", b, mats["CM_Ink"], root)
    b = MeshBuilder()
    bounds(b, -0.50, -0.452, 0.24, 0.86, -0.342, -0.30)
    cham_box(b, -0.525, -0.427, 0.13, 0.26, -0.348, -0.294, ch=0.012)
    make_mesh_object("back__conduit", b, mats["CM_Steel"], root)
    b = MeshBuilder()
    for cy in (0.44, 0.70):
        bounds(b, -0.508, -0.444, cy, cy + 0.03, -0.346, -0.296)
    make_mesh_object("back__conduit_clips", b, mats["CM_Brass"], root)
    b = MeshBuilder()
    plate(b, -0.36, -0.12, 0.15, 0.30, 0.30, 0.314, 0.008, axis="-z")
    make_mesh_object("back__port_plate", b, mats["CM_Ink"], root)
    b = MeshBuilder()
    for pu in (-0.315, -0.235, -0.155):
        ring_axis(b, pu, 0.225, 0.015, 0.025, 0.314, 0.325, axis="-z", segments=12)
    make_mesh_object("back__port_collars", b, mats["CM_Brass"], root, smooth=True)
    b = MeshBuilder()
    for pu in (-0.235, -0.155):
        disc_axis(b, pu, 0.225, 0.0148, 0.305, 0.3125, axis="-z", sides=12)
    make_mesh_object("back__socket_cavities", b, mats["CM_Ink"], root)
    b = MeshBuilder()
    disc_axis(b, -0.315, 0.225, 0.0145, 0.314, 0.337, axis="-z", sides=10)
    make_mesh_object("back__port_plug", b, mats["CM_Steel"], root, smooth=True)
    b = MeshBuilder()
    bounds(b, -0.338, -0.292, 0.185, 0.225, -0.342, -0.320)  # plug boot
    pts = [(-0.315, 0.225), (-0.355, 0.225), (-0.39, 0.221), (-0.412, 0.216)]
    cable_tube(b, pts, -0.331, 0.011)
    make_mesh_object("back__service_cable", b, mats["CM_Ink"], root, smooth=True)
    b = MeshBuilder()
    cham_box(b, -0.468, -0.404, 0.176, 0.256, -0.352, -0.312, ch=0.01)  # external junction elbow
    ring_axis(b, -0.331, 0.216, 0.013, 0.026, -0.412, -0.394, axis="+x", segments=12)
    make_mesh_object("back__cable_coupling", b, mats["CM_Brass"], root, smooth=True)
    b = MeshBuilder()
    bounds(b, -0.579, 0.579, 0.0, 0.018, -0.354, 0.354)
    make_mesh_object("base__ground_gasket", b, mats["CM_Ink"], root)
    return root


def build_pa_terminal():
    """Civic roster directory pylon: 1.05 x 0.65 footprint, 1.75 m tall."""
    reset_scene()
    mats = make_materials(PA_MATERIALS)
    root = make_root(TERMINALS["pa_terminal"]["root_node"])

    # Chamfered basalt feet, ink toe reveals, hex anchor studs with washers.
    b = MeshBuilder()
    cham_box(b, -0.525, -0.295, 0.0, 0.115, -0.325, 0.325, ch=0.02)
    cham_box(b, 0.295, 0.525, 0.0, 0.115, -0.325, 0.325, ch=0.02)
    bounds(b, -0.30, 0.30, 0.0, 0.07, -0.25, 0.25)
    make_mesh_object("base__feet", b, mats["CM_Basalt"], root)
    b = MeshBuilder()
    for fx0, fx1 in ((-0.50, -0.32), (0.32, 0.50)):
        bounds(b, fx0, fx1, 0.115, 0.14, -0.28, 0.285)
    make_mesh_object("base__toe_reveals", b, mats["CM_Ink"], root)
    b = MeshBuilder()
    for bx, bz in ((-0.455, -0.25), (-0.455, 0.255), (0.455, -0.25), (0.455, 0.255)):
        b.extend_prism(bx, bz, 0.038, 0.115, 0.123, sides=8, start_deg=22.5)
        b.extend_prism(bx, bz, 0.023, 0.123, 0.158, sides=6, start_deg=15.0)
    make_mesh_object("base__anchor_studs", b, mats["CM_Steel"], root, smooth=True)

    # Ceramic slab in profiled basalt pilasters under a stepped cornice with
    # a recessed cyan beacon cove.
    b = MeshBuilder()
    cham_box(b, -0.44, 0.44, 0.07, 1.66, -0.16, 0.10, ch=0.018)
    make_mesh_object("body__pylon_slab", b, mats["CM_Ceramic"], root)
    b = MeshBuilder()
    for px0, px1 in ((-0.50, -0.40), (0.40, 0.50)):
        cham_box(b, px0, px1, 0.14, 1.66, -0.10, 0.14, ch=0.016)
    make_mesh_object("body__pilasters", b, mats["CM_Basalt"], root)
    b = MeshBuilder()
    for px0, px1 in ((-0.50, -0.40), (0.40, 0.50)):
        cham_box(b, px0 - 0.008, px1 + 0.008, 1.56, 1.64, -0.108, 0.148, ch=0.012)
        cham_box(b, px0 - 0.008, px1 + 0.008, 0.14, 0.22, -0.108, 0.148, ch=0.012)
    make_mesh_object("body__pilaster_caps", b, mats["CM_Basalt"], root)
    b = MeshBuilder()
    for rx in (-0.405, 0.395):
        bounds(b, rx, rx + 0.01, 0.16, 1.60, -0.06, 0.105)
    make_mesh_object("body__pilaster_reveals", b, mats["CM_Ink"], root)
    b = MeshBuilder()
    cham_box(b, -0.50, 0.50, 1.64, 1.705, -0.10, 0.14, ch=0.016)
    cham_box(b, -0.455, 0.455, 1.705, 1.75, -0.085, 0.115, ch=0.014)
    make_mesh_object("body__cornice", b, mats["CM_Basalt"], root)
    b = MeshBuilder()
    bounds(b, -0.20, 0.20, 1.658, 1.695, 0.14, 0.152)
    make_mesh_object("body__beacon_cove", b, mats["CM_Ink"], root)
    b = MeshBuilder()
    bounds(b, -0.17, 0.17, 1.664, 1.688, 0.14, 0.158)
    make_mesh_object("body__crown_beacon", b, mats["CM_GlowCyan"], root)

    # Identity seal: ink backplate, cyan halo ring, layered brass ring with
    # boss and four hex studs (geometric, no words).
    SEAL = (0.0, 1.53)
    b = MeshBuilder()
    ring_axis(b, *SEAL, 0.090, 0.104, 0.10, 0.116, segments=32)
    make_mesh_object("seal__socket", b, mats["CM_Basalt"], root, smooth=True)
    b = MeshBuilder()
    disc_axis(b, *SEAL, 0.090, 0.10, 0.118, sides=48)
    make_mesh_object("seal__backplate", b, mats["CM_Ink"], root, smooth=True)
    b = MeshBuilder()
    ring_axis(b, *SEAL, 0.070, 0.082, 0.118, 0.126, segments=48)
    make_mesh_object("seal__halo", b, mats["CM_GlowCyan"], root, smooth=True)
    b = MeshBuilder()
    ring_axis(b, *SEAL, 0.044, 0.066, 0.118, 0.146, segments=48)
    ring_axis(b, *SEAL, 0.050, 0.060, 0.146, 0.158, segments=48)
    disc_axis(b, *SEAL, 0.024, 0.118, 0.152, sides=24)
    make_mesh_object("seal__brass", b, mats["CM_Brass"], root, smooth=True)
    b = MeshBuilder()
    for i in range(4):
        a = 45.0 + 90.0 * i
        u, v = pol(*SEAL, a, 0.055)
        disc_axis(b, u, v, 0.008, 0.146, 0.159, sides=6, start_deg=a)
    make_mesh_object("seal__studs", b, mats["CM_Steel"], root)

    # Portrait roster screen with stepped bezel + side control keys and
    # speaker louvers.
    b = MeshBuilder()
    plate(b, -0.30, 0.30, 0.82, 1.42, 0.10, 0.124, 0.014, axis="+z")
    make_mesh_object("screen__bezel", b, mats["CM_Ink"], root)
    b = MeshBuilder()
    for strip in ((-0.285, 0.285, 1.392, 1.406), (-0.285, 0.285, 0.834, 0.848), (-0.285, -0.271, 0.848, 1.392), (0.271, 0.285, 0.848, 1.392)):
        bounds(b, strip[0], strip[1], strip[2], strip[3], 0.124, 0.1315)
    make_mesh_object("screen__inner_frame", b, mats["CM_Steel"], root)
    b = MeshBuilder()
    screws(b, [(-0.283, 0.837), (0.283, 0.837), (-0.283, 1.403), (0.283, 1.403)], 0.124, 0.1315, axis="+z", r=0.0075)
    make_mesh_object("screen__bezel_screws", b, mats["CM_Steel"], root)
    b = MeshBuilder()
    bounds(b, -0.255, 0.255, 0.875, 1.375, 0.10, 0.134)
    make_mesh_object("screen__directory", b, mats["CM_ScreenPA"], root, uv="rect")
    b = MeshBuilder()
    plate(b, -0.268, 0.268, 0.862, 1.388, 0.10, 0.1435, 0.006, axis="+z")
    make_mesh_object("screen__glass", b, mats["CM_TealGlass"], root)
    b = MeshBuilder()
    for i, ky in enumerate((1.30, 1.20, 1.10)):
        plate(b, 0.318, 0.372, ky, ky + 0.062, 0.10, 0.121, 0.008, axis="+z")
    make_mesh_object("screen__side_keys", b, mats["CM_Steel"], root)
    b = MeshBuilder()
    plate(b, 0.318, 0.372, 0.99, 1.052, 0.10, 0.124, 0.008, axis="+z")
    make_mesh_object("screen__call_key", b, mats["CM_GlowAmber"], root)
    b = MeshBuilder()
    louvers(b, 0.318, 0.372, 0.955, 3, 0.026, 0.10, 0.010, axis="+z", drop=0.012)
    make_mesh_object("screen__speaker_louvers", b, mats["CM_Ink"], root)

    # Reader podium: chamfered ceramic wedge, steel top tray, two-step brass
    # tap disc with an ink cross inlay, amber slit, bezeled status dots.
    b = MeshBuilder()
    cham_box(b, -0.30, 0.30, 0.60, 0.79, 0.10, 0.298, ch=0.018)
    make_mesh_object("podium__wedge", b, mats["CM_Ceramic"], root)
    b = MeshBuilder()
    cham_box(b, -0.325, 0.325, 0.79, 0.828, 0.08, 0.318, ch=0.012)
    make_mesh_object("podium__top", b, mats["CM_Steel"], root)
    b = MeshBuilder()
    bounds(b, -0.29, 0.29, 0.828, 0.8335, 0.115, 0.295)
    make_mesh_object("podium__tray", b, mats["CM_Ink"], root)
    b = MeshBuilder()
    b.extend_prism(0.115, 0.205, 0.062, 0.8335, 0.845, sides=24, start_deg=7.5)
    b.extend_prism(0.115, 0.205, 0.049, 0.845, 0.856, sides=24, start_deg=7.5)
    make_mesh_object("podium__tap_disc", b, mats["CM_Brass"], root, smooth=True)
    b = MeshBuilder()
    bounds(b, 0.0785, 0.1515, 0.856, 0.859, 0.199, 0.211)
    bounds(b, 0.109, 0.121, 0.856, 0.859, 0.1685, 0.2415)
    make_mesh_object("podium__disc_inlay", b, mats["CM_Ink"], root)
    b = MeshBuilder()
    bounds(b, -0.245, -0.085, 0.8335, 0.8445, 0.155, 0.265)
    make_mesh_object("podium__tap_slit", b, mats["CM_GlowAmber"], root)
    b = MeshBuilder()
    for dx in (-0.13, 0.0, 0.13):
        plate(b, dx - 0.032, dx + 0.032, 0.685, 0.745, 0.298, 0.306, 0.006, axis="+z")
    make_mesh_object("podium__dot_bezels", b, mats["CM_Steel"], root)
    b = MeshBuilder()
    for bx in (-0.255, 0.215):
        bounds(b, bx, bx + 0.04, 0.596, 0.62, 0.11, 0.30)
    screws(b, [(-0.235, 0.607), (0.235, 0.607)], 0.30, 0.307, axis="+z", r=0.007)
    make_mesh_object("podium__side_brackets", b, mats["CM_Steel"], root)
    b = MeshBuilder()
    for dx in (-0.13, 0.0, 0.13):
        bounds(b, dx - 0.02, dx + 0.02, 0.697, 0.733, 0.298, 0.3085)
    make_mesh_object("podium__status_dots", b, mats["CM_GlowCyan"], root)

    # Serviced back: deep recessed notice panel in a riveted steel frame,
    # hinged access hatch with latch, louvered vents, clipped conduit with
    # junction box.
    b = MeshBuilder()
    for strip in ((-0.35, 0.35, 1.30, 1.36), (-0.35, 0.35, 0.62, 0.68), (-0.35, -0.29, 0.68, 1.30), (0.29, 0.35, 0.68, 1.30)):
        plate(b, strip[0], strip[1], strip[2], strip[3], 0.16, 0.205, 0.012, axis="-z")
    make_mesh_object("back__notice_frame", b, mats["CM_Steel"], root)
    b = MeshBuilder()
    plate(b, -0.285, 0.285, 0.685, 1.295, 0.16, 0.178, 0.014, axis="-z")
    make_mesh_object("back__notice_panel", b, mats["CM_Ceramic"], root)
    b = MeshBuilder()
    for bx, by in ((-0.322, 0.652), (0.322, 0.652), (-0.322, 1.328), (0.322, 1.328)):
        disc_axis(b, bx, by, 0.012, 0.205, 0.216, axis="-z", sides=6, start_deg=15.0)
    make_mesh_object("back__rivets", b, mats["CM_Brass"], root)
    b = MeshBuilder()
    # perfectly symmetric stepped service panel (no bevel): centered base +
    # centered raised flat plate
    bounds(b, -0.16, 0.16, 0.24, 0.52, -0.178, -0.16)
    bounds(b, -0.146, 0.146, 0.254, 0.506, -0.192, -0.178)
    make_mesh_object("back__access_hatch", b, mats["CM_Steel"], root)
    b = MeshBuilder()
    # removable bolted service panel: six exposed bolts entirely on the flat
    # panel face; the beveled perimeter gap stays continuous and clean
    screws(b, [(-0.095, 0.29), (0.095, 0.29), (-0.095, 0.38), (0.095, 0.38), (-0.095, 0.47), (0.095, 0.47)], 0.192, 0.203, axis="-z", r=0.009)
    make_mesh_object("back__panel_bolts", b, mats["CM_Brass"], root, smooth=True)
    b = MeshBuilder()
    # external latch tabs, wholly on the fixed frame, clear of the panel
    bounds(b, -0.215, -0.185, 0.355, 0.405, -0.172, -0.16)
    bounds(b, 0.185, 0.215, 0.355, 0.405, -0.172, -0.16)
    make_mesh_object("back__panel_latch_tabs", b, mats["CM_Steel"], root)
    b = MeshBuilder()
    louvers(b, -0.26, 0.26, 1.58, 4, 0.054, 0.16, 0.015, axis="-z")
    make_mesh_object("back__louvers", b, mats["CM_Ink"], root)
    b = MeshBuilder()
    bounds(b, 0.352, 0.398, 0.24, 1.44, -0.208, -0.166)
    cham_box(b, 0.328, 0.422, 0.115, 0.26, -0.214, -0.16, ch=0.010)
    make_mesh_object("back__conduit", b, mats["CM_Steel"], root)
    b = MeshBuilder()
    for cy in (0.62, 1.02):
        bounds(b, 0.344, 0.406, cy, cy + 0.028, -0.212, -0.164)
    make_mesh_object("back__conduit_clips", b, mats["CM_Brass"], root)
    b = MeshBuilder()
    plate(b, -0.44, -0.24, 0.24, 0.42, 0.16, 0.174, 0.008, axis="-z")
    make_mesh_object("back__port_plate", b, mats["CM_Ink"], root)
    b = MeshBuilder()
    for pv in (0.395, 0.34, 0.285):
        ring_axis(b, -0.34, pv, 0.014, 0.024, 0.174, 0.185, axis="-z", segments=12)
    make_mesh_object("back__port_collars", b, mats["CM_Brass"], root, smooth=True)
    b = MeshBuilder()
    for pv in (0.395, 0.34):
        disc_axis(b, -0.34, pv, 0.013, 0.1735, 0.1805, axis="-z", sides=12)
    make_mesh_object("back__socket_cavities", b, mats["CM_Ink"], root)
    b = MeshBuilder()
    disc_axis(b, -0.34, 0.285, 0.0135, 0.174, 0.197, axis="-z", sides=10)
    make_mesh_object("back__port_plug", b, mats["CM_Steel"], root, smooth=True)
    b = MeshBuilder()
    bounds(b, -0.375, -0.305, 0.115, 0.162, -0.212, -0.16)  # gland base on the foot
    ring_axis(b, -0.34, -0.185, 0.014, 0.024, 0.162, 0.178, axis="+y", segments=12)
    make_mesh_object("back__cable_gland", b, mats["CM_Brass"], root, smooth=True)
    b = MeshBuilder()
    bounds(b, -0.363, -0.317, 0.245, 0.285, -0.202, -0.178)  # plug boot
    pts = [(-0.34, 0.30), (-0.344, 0.25), (-0.34, 0.205), (-0.34, 0.172)]
    cable_tube(b, pts, -0.188, 0.009)
    make_mesh_object("back__service_cable", b, mats["CM_Ink"], root, smooth=True)
    b = MeshBuilder()
    bounds(b, -0.529, -0.291, 0.0, 0.016, -0.329, 0.329)
    bounds(b, 0.291, 0.529, 0.0, 0.016, -0.329, 0.329)
    make_mesh_object("base__ground_gasket", b, mats["CM_Ink"], root)
    return root


BUILDERS = {
    "bank_terminal_civic": build_bank_terminal_civic,
    "trade_terminal": build_trade_terminal,
    "pa_terminal": build_pa_terminal,
}


# ─────────────────────────── export + GLB parsing ──────────────────────────


def export_glb(root, glb_path: Path):
    bpy.ops.object.select_all(action="DESELECT")
    root.select_set(True)
    for child in root.children_recursive:
        child.select_set(True)
    bpy.context.view_layer.objects.active = root
    bpy.ops.export_scene.gltf(
        filepath=str(glb_path),
        export_format="GLB",
        use_selection=True,
        export_apply=True,
        export_materials="EXPORT",
        export_image_format="AUTO",
        export_cameras=False,
        export_lights=False,
        export_yup=True,
        export_skins=False,
        export_normals=True,
        export_texcoords=True,
        export_animations=False,
    )


_COMPONENT_FORMAT = {5120: "b", 5121: "B", 5122: "h", 5123: "H", 5125: "I", 5126: "f"}
_COMPONENT_SIZE = {5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4}
_TYPE_COUNT = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4, "MAT4": 16}


def read_glb_chunks(path):
    data = Path(path).read_bytes()
    magic, _version, _length = struct.unpack_from("<III", data, 0)
    if magic != 0x46546C67:
        raise RuntimeError(f"not a GLB: {path}")
    offset = 12
    chunks = {}
    while offset < len(data):
        clen, ctype = struct.unpack_from("<II", data, offset)
        offset += 8
        chunks[struct.pack("<I", ctype)] = data[offset : offset + clen]
        offset += clen
    return json.loads(chunks[b"JSON"].decode("utf-8")), chunks.get(b"BIN\x00", b"")


def accessor_values(gltf, bin_chunk, accessor_index):
    acc = gltf["accessors"][accessor_index]
    view = gltf["bufferViews"][acc["bufferView"]]
    comp_fmt = _COMPONENT_FORMAT[acc["componentType"]]
    comp_size = _COMPONENT_SIZE[acc["componentType"]]
    count_per = _TYPE_COUNT[acc["type"]]
    stride = view.get("byteStride", comp_size * count_per)
    base = view.get("byteOffset", 0) + acc.get("byteOffset", 0)
    fmt = "<" + comp_fmt * count_per
    return [struct.unpack_from(fmt, bin_chunk, base + i * stride) for i in range(acc["count"])]


def node_local_matrix(node):
    if "matrix" in node:
        m = node["matrix"]
        return Matrix((m[0:4], m[4:8], m[8:12], m[12:16])).transposed()
    from mathutils import Quaternion

    t = node.get("translation", [0.0, 0.0, 0.0])
    r = node.get("rotation", [0.0, 0.0, 0.0, 1.0])
    s = node.get("scale", [1.0, 1.0, 1.0])
    translation = Matrix.Translation(Vector(t))
    rotation = Quaternion((r[3], r[0], r[1], r[2])).to_matrix().to_4x4()
    scale = Matrix.Diagonal((s[0], s[1], s[2], 1.0))
    return translation @ rotation @ scale


def node_worlds(gltf):
    worlds = {}

    def walk(idx, parent):
        node = gltf["nodes"][idx]
        world = parent @ node_local_matrix(node)
        worlds[idx] = world
        for child in node.get("children", []):
            walk(child, world)

    scene = gltf.get("scenes", [{}])[gltf.get("scene", 0)]
    for idx in scene.get("nodes", []):
        walk(idx, Matrix.Identity(4))
    return worlds


def primitive_indices(gltf, bin_chunk, prim, vertex_count):
    if "indices" not in prim:
        return list(range(vertex_count))
    return [int(v[0]) for v in accessor_values(gltf, bin_chunk, prim["indices"])]


def triangle_area(a, b, c):
    return ((b - a).cross(c - a)).length / 2.0


def is_identity_node_transform(node, tol=1e-6):
    t = node.get("translation", [0.0, 0.0, 0.0])
    r = node.get("rotation", [0.0, 0.0, 0.0, 1.0])
    s = node.get("scale", [1.0, 1.0, 1.0])
    return (
        all(abs(v) <= tol for v in t)
        and all(abs(v) <= tol for v in r[:3])
        and abs(r[3] - 1.0) <= tol
        and all(abs(v - 1.0) <= tol for v in s)
        and "matrix" not in node
    )


def parse_glb_metrics(path):
    gltf, bin_chunk = read_glb_chunks(path)
    worlds = node_worlds(gltf)
    mat_names = [m.get("name", "") for m in gltf.get("materials", [])]
    mesh_nodes = []
    tri_count = 0
    degenerate = 0
    loose = 0
    material_sets = {}
    normal_prim_count = 0
    texcoord_prim_count = 0
    prim_count = 0
    all_positions = []
    for node_idx, node in enumerate(gltf.get("nodes", [])):
        if "mesh" not in node:
            continue
        name = node.get("name", "")
        mesh_nodes.append(name)
        mesh = gltf["meshes"][node["mesh"]]
        world = worlds.get(node_idx, Matrix.Identity(4))
        mats = set()
        for prim in mesh.get("primitives", []):
            if prim.get("mode", 4) != 4:
                continue
            prim_count += 1
            attrs = prim.get("attributes", {})
            if "NORMAL" in attrs:
                normal_prim_count += 1
            if "TEXCOORD_0" in attrs:
                texcoord_prim_count += 1
            pos_acc_idx = attrs.get("POSITION")
            if pos_acc_idx is None:
                continue
            world_positions = [world @ Vector(v[:3]) for v in accessor_values(gltf, bin_chunk, pos_acc_idx)]
            idxs = primitive_indices(gltf, bin_chunk, prim, len(world_positions))
            loose += max(0, len(world_positions) - len(set(idxs)))
            for i in range(0, len(idxs), 3):
                if i + 2 >= len(idxs):
                    break
                a, b, c = world_positions[idxs[i]], world_positions[idxs[i + 1]], world_positions[idxs[i + 2]]
                tri_count += 1
                if len({idxs[i], idxs[i + 1], idxs[i + 2]}) < 3 or triangle_area(a, b, c) <= 1e-12:
                    degenerate += 1
            mat_idx = prim.get("material", -1)
            if 0 <= mat_idx < len(mat_names):
                mats.add(mat_names[mat_idx])
            all_positions.extend(world_positions)
        material_sets[name] = sorted(mats)
    xs = [p.x for p in all_positions]
    ys = [p.y for p in all_positions]
    zs = [p.z for p in all_positions]
    total_bbox = {"min": [min(xs), min(ys), min(zs)], "max": [max(xs), max(ys), max(zs)]}
    return {
        "gltf": gltf,
        "mat_names": mat_names,
        "mesh_nodes": mesh_nodes,
        "tri_count": tri_count,
        "degenerate_faces": degenerate,
        "loose_vertices": loose,
        "material_sets": material_sets,
        "normal_primitives": normal_prim_count,
        "texcoord_primitives": texcoord_prim_count,
        "primitive_count": prim_count,
        "total_bbox": total_bbox,
    }


def bbox_span(bbox):
    return [bbox["max"][i] - bbox["min"][i] for i in range(3)]


def run_validator(glb_path: Path):
    exe = shutil.which("npx")
    if not exe:
        return {"available": False, "pass": False, "note": "npx missing"}
    cmd = [exe, "--yes", "@gltf-transform/cli", "validate", str(glb_path), "--format", "csv"]
    try:
        proc = subprocess.run(cmd, cwd=str(EVIDENCE_DIR), text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=240)
    except Exception as exc:
        return {"available": False, "pass": False, "note": str(exc)}
    out = proc.stdout or ""
    num_errors = None
    for pat in [r"numErrors\D+(\d+)", r"Errors\D+(\d+)", r"ERROR,\s*(\d+)"]:
        m = re.search(pat, out, flags=re.IGNORECASE)
        if m:
            num_errors = int(m.group(1))
            break
    if num_errors is None:
        num_errors = len([line for line in out.splitlines() if line.strip().lower().startswith("error,")])
    if proc.returncode == 0 and "No errors found" in out:
        num_errors = 0
    return {"available": True, "mode": "gltf-transform", "rc": proc.returncode, "numErrors": num_errors, "pass": proc.returncode == 0 and num_errors == 0, "tail": "\n".join(out.splitlines()[-8:])}


def material_texture_flags(gltf):
    flags = {}
    for mat in gltf.get("materials", []):
        name = mat.get("name", "")
        pbr = mat.get("pbrMetallicRoughness", {})
        flags[name] = {
            "baseColorTexture": "baseColorTexture" in pbr,
            "metallicRoughnessTexture": "metallicRoughnessTexture" in pbr,
            "normalTexture": "normalTexture" in mat,
            "emissiveTexture": "emissiveTexture" in mat,
        }
    return flags


def terminal_gate(asset_id, metrics, validate, allowed_materials, screen_material):
    spec = TERMINALS[asset_id]
    gltf = metrics["gltf"]
    node_names = [n.get("name", "") for n in gltf.get("nodes", [])]
    scene_idx = gltf.get("scene", 0)
    scene_nodes = gltf.get("scenes", [{}])[scene_idx].get("nodes", [])
    root_node = node_names[scene_nodes[0]] if len(scene_nodes) == 1 else None
    total_span = bbox_span(metrics["total_bbox"])
    min_y = metrics["total_bbox"]["min"][1]
    tex_flags = material_texture_flags(gltf)
    images = gltf.get("images", [])
    dims = spec["dims_m"]
    bad_pivots = [n.get("name", "") for n in gltf.get("nodes", []) if "mesh" in n and not is_identity_node_transform(n)]
    checks = {
        "root_node": root_node == spec["root_node"] and len(scene_nodes) == 1,
        "grounded_y0": abs(min_y) <= 0.0005,
        "dims_within_tolerance": all(abs(total_span[i] - dims[i]) <= DIM_TOL_M for i in range(3)),
        "one_material_per_node": all(len(mats) == 1 for mats in metrics["material_sets"].values()),
        "materials_subset": set(metrics["mat_names"]) <= allowed_materials,
        "has_screen_material": screen_material in metrics["mat_names"],
        "screen_has_emissive_texture": bool(tex_flags.get(screen_material, {}).get("emissiveTexture")),
        "core_materials_textured": all(
            tex_flags.get(m, {}).get("baseColorTexture") and tex_flags.get(m, {}).get("metallicRoughnessTexture")
            for m in metrics["mat_names"]
            if m in TEXTURED_MATERIALS
        ),
        "core_materials_normal_mapped": all(
            tex_flags.get(m, {}).get("normalTexture") for m in metrics["mat_names"] if m in TEXTURED_MATERIALS
        ),
        "textures_embedded": len(images) >= 6 and all("bufferView" in img for img in images),
        "has_glow_accent": any(name in {"CM_GlowAmber", "CM_GlowCyan"} for name in metrics["mat_names"]),
        "normals_exported": metrics["primitive_count"] > 0 and metrics["normal_primitives"] == metrics["primitive_count"],
        "texcoords_exported": metrics["texcoord_primitives"] == metrics["primitive_count"],
        "no_skins": len(gltf.get("skins", [])) == 0,
        "pivots_identity": not bad_pivots,
        "tri_count_within_budget": metrics["tri_count"] <= spec["tri_budget"],
        "tri_count_detail_floor": metrics["tri_count"] >= 2500,
        "degenerate_faces_zero": metrics["degenerate_faces"] == 0,
        "loose_vertices_zero": metrics["loose_vertices"] == 0,
        "validate": bool(validate.get("pass")),
    }
    return {
        "asset": asset_id,
        "all_green": all(checks.values()),
        "root_node": root_node,
        "mesh_nodes": metrics["mesh_nodes"],
        "materials": metrics["mat_names"],
        "material_textures": tex_flags,
        "embedded_images": len(images),
        "tri_count": int(metrics["tri_count"]),
        "total_bbox_m": {
            "min": [round(v, 5) for v in metrics["total_bbox"]["min"]],
            "max": [round(v, 5) for v in metrics["total_bbox"]["max"]],
            "span": [round(v, 5) for v in total_span],
        },
        "bad_pivot_nodes": bad_pivots,
        "validate": validate,
        "checks": checks,
    }


# ─────────────────────────────── render rig ────────────────────────────────


def look_at_matrix(location, target, desired_up=(0, 0, 1)):
    loc = Vector(location)
    forward = (Vector(target) - loc).normalized()
    up_hint = Vector(desired_up)
    if abs(forward.dot(up_hint)) > 0.999:
        up_hint = Vector((0.0, 1.0, 0.0))
    right = forward.cross(up_hint).normalized()
    up = right.cross(forward)
    return Matrix(((right.x, up.x, -forward.x, loc.x), (right.y, up.y, -forward.y, loc.y), (right.z, up.z, -forward.z, loc.z), (0.0, 0.0, 0.0, 1.0)))


def add_camera_logical(name, location, target, ortho_scale):
    cam_data = bpy.data.cameras.new(name)
    cam = bpy.data.objects.new(name, cam_data)
    bpy.context.collection.objects.link(cam)
    cam.matrix_world = look_at_matrix(logical_to_blender(location), logical_to_blender(target), desired_up=(0, 0, 1))
    cam_data.type = "ORTHO"
    cam_data.ortho_scale = ortho_scale
    return cam


def add_camera_persp(name, location, target, lens=50.0):
    cam_data = bpy.data.cameras.new(name)
    cam = bpy.data.objects.new(name, cam_data)
    bpy.context.collection.objects.link(cam)
    cam.matrix_world = look_at_matrix(logical_to_blender(location), logical_to_blender(target), desired_up=(0, 0, 1))
    cam_data.type = "PERSP"
    cam_data.lens = lens
    return cam


def add_area_light(name, location, target, size, energy):
    light_data = bpy.data.lights.new(name, type="AREA")
    light_data.energy = energy
    light_data.size = size
    light = bpy.data.objects.new(name, light_data)
    bpy.context.collection.objects.link(light)
    light.matrix_world = look_at_matrix(logical_to_blender(location), logical_to_blender(target), desired_up=(0, 0, 1))
    return light


def setup_render():
    scene = bpy.context.scene
    try:
        scene.render.engine = "BLENDER_EEVEE_NEXT"
    except TypeError:
        scene.render.engine = "BLENDER_EEVEE"
    scene.render.resolution_x = RENDER_RESOLUTION[0]
    scene.render.resolution_y = RENDER_RESOLUTION[1]
    scene.render.film_transparent = False
    for attr, value in (("taa_render_samples", 64), ("use_raytracing", True), ("use_shadows", True)):
        try:
            setattr(scene.eevee, attr, value)
        except Exception:
            pass
    for transform in ("AgX", "Filmic", "Standard"):
        try:
            scene.view_settings.view_transform = transform
            break
        except Exception:
            continue
    scene.view_settings.look = "None"
    scene.view_settings.exposure = 0.35
    scene.view_settings.gamma = 1.0
    bg = hex_to_rgba("#B9BCBE")
    if scene.world is None:
        scene.world = bpy.data.worlds.new("commerce_studio_world")
    scene.world.color = bg[:3]
    scene.world.use_nodes = True
    bg_node = scene.world.node_tree.nodes.get("Background")
    if bg_node:
        bg_node.inputs["Color"].default_value = bg
        bg_node.inputs["Strength"].default_value = 0.85

    def sun(name, az_deg, elev_deg, energy, angle_deg=4.0):
        light_data = bpy.data.lights.new(name, type="SUN")
        light_data.energy = energy
        try:
            light_data.angle = math.radians(angle_deg)
        except Exception:
            pass
        light = bpy.data.objects.new(name, light_data)
        bpy.context.collection.objects.link(light)
        az = math.radians(az_deg)
        elev = math.radians(elev_deg)
        direction_logical = Vector((-math.cos(elev) * math.cos(az), -math.sin(elev), -math.cos(elev) * math.sin(az)))
        direction_bl = Vector(logical_to_blender(direction_logical))
        light.rotation_euler = direction_bl.to_track_quat("-Z", "Y").to_euler()

    sun("sun_key_38_44", 38.0, 44.0, 1.9)
    add_area_light("key_area", (2.4, 3.0, 3.2), (0.0, 0.9, 0.0), 2.6, 420.0)
    add_area_light("rim_area", (-2.6, 2.4, -3.0), (0.0, 1.0, 0.0), 2.2, 240.0)
    add_area_light("fill_area", (-3.0, 1.6, 2.6), (0.0, 0.8, 0.0), 3.0, 120.0)
    add_area_light("front_spec", (0.3, 1.7, 4.4), (0.0, 1.0, 0.0), 2.4, 170.0)

    # Studio ground plane: catches contact shadows. Render-only.
    def flat_mat(name, rgba, rough):
        mat = bpy.data.materials.new(name)
        mat.diffuse_color = rgba
        mat.use_nodes = True
        bsdf = mat.node_tree.nodes.get("Principled BSDF")
        if bsdf:
            bsdf.inputs["Base Color"].default_value = rgba
            bsdf.inputs["Roughness"].default_value = rough
        return mat

    b = MeshBuilder()
    b.extend_bounds(-9.0, 9.0, -0.03, -0.001, -9.0, 9.0)
    make_mesh_object("render_ground_not_exported", b, flat_mat("render_ground_mat_not_exported", (0.42, 0.42, 0.42, 1.0), 0.85), None)
    return scene


def create_ref_staff(location_logical):
    def flat_mat(name, value):
        mat = bpy.data.materials.new(name)
        mat.diffuse_color = (value, value, value, 1.0)
        mat.use_nodes = True
        bsdf = mat.node_tree.nodes.get("Principled BSDF")
        if bsdf:
            bsdf.inputs["Base Color"].default_value = mat.diffuse_color
            bsdf.inputs["Roughness"].default_value = 0.9
        return mat

    mats = (flat_mat("render_ref_dark_not_exported", 0.14), flat_mat("render_ref_light_not_exported", 0.72))
    h = REFERENCE_STAFF_HEIGHT_M
    seg = h / 4.0
    cx, cz = location_logical
    parts = []
    b = MeshBuilder()
    b.extend_box((cx, 0.015, cz), (0.44, 0.03, 0.44))
    parts.append(make_mesh_object("render_ref_staff_base_not_exported", b, mats[0], None))
    for i in range(4):
        b = MeshBuilder()
        b.extend_box((cx, (i + 0.5) * seg, cz), (0.16, seg, 0.16))
        parts.append(make_mesh_object(f"render_ref_staff_seg{i}_not_exported", b, mats[i % 2], None))
    holder = parts[0]
    for p in parts[1:]:
        p.parent = holder
        p.matrix_parent_inverse = holder.matrix_world.inverted()
    return holder


def set_ref_hidden(ref, hidden):
    for obj in [ref, *ref.children_recursive]:
        obj.hide_render = hidden
        obj.hide_viewport = hidden


def render_still(scene, camera, path):
    scene.camera = camera
    scene.render.filepath = str(path)
    bpy.ops.render.render(write_still=True)


RENDER_RIGS = {
    "bank_terminal_civic": {
        "ortho": 2.5,
        "cam_h": 1.0,
        "close": {
            "screen": ((0.0, 1.44, 0.14), (0.62, 0.62, 1.5), 52),
            "controls": ((0.0, 0.78, 0.28), (0.5, 0.62, 1.35), 52),
            "iris": ((0.0, 0.515, 0.30), (0.42, 0.34, 0.85), 62),
            "iris34": ((0.0, 0.515, 0.28), (0.85, 0.42, 0.55), 62),
            "ground": ((0.0, 0.16, 0.26), (0.55, 0.55, 1.3), 48),
            "back": ((0.0, 0.75, -0.29), (-0.55, 0.7, -1.5), 44),
            "ports": ((-0.07, 0.52, -0.30), (-0.5, 0.45, -1.05), 58),
        },
    },
    "trade_terminal": {
        "ortho": 2.5,
        "cam_h": 0.85,
        "close": {
            "screen": ((0.0, 1.22, -0.22), (0.6, 0.75, 1.35), 52),
            "controls": ((0.05, 0.93, 0.02), (0.65, 1.0, 1.3), 46),
            "scale": ((0.35, 0.99, -0.02), (0.62, 0.30, 0.85), 60),
            "ground": ((0.0, 0.12, 0.31), (0.55, 0.5, 1.3), 48),
            "back": ((0.0, 0.55, -0.33), (-0.6, 0.75, -1.45), 44),
            "ports": ((-0.27, 0.41, -0.31), (-0.5, 0.45, -1.0), 58),
        },
    },
    "pa_terminal": {
        "ortho": 2.7,
        "cam_h": 1.05,
        "close": {
            "screen": ((0.0, 1.18, 0.13), (0.55, 0.75, 1.45), 52),
            "controls": ((0.0, 0.82, 0.26), (0.5, 0.62, 1.3), 52),
            "ground": ((0.0, 0.14, 0.29), (0.55, 0.5, 1.35), 48),
            "back": ((0.0, 0.95, -0.19), (-0.6, 0.85, -1.5), 44),
            "hatch": ((0.06, 0.38, -0.19), (-0.4, 0.35, -0.95), 62),
            "panel34": ((0.0, 0.38, -0.19), (-0.35, 0.22, -0.85), 58),
            "panel_front": ((0.0, 0.38, -0.19), (0.0, 0.001, -1.55), 75),
            "ports": ((-0.30, 0.30, -0.17), (-0.48, 0.45, -1.0), 58),
        },
    },
}


def render_terminal(root, asset_id):
    rig = RENDER_RIGS[asset_id]
    scene = setup_render()
    ref = create_ref_staff((-1.35, 0.5))
    ortho = rig["ortho"]
    ch = rig["cam_h"]
    height = TERMINALS[asset_id]["dims_m"][1]
    wide = {
        "front": add_camera_logical(f"cam_{asset_id}_front", (0.0, ch, 5.2), (0.0, ch * 0.92, 0.0), ortho),
        "back": add_camera_logical(f"cam_{asset_id}_back", (0.0, ch, -5.2), (0.0, ch * 0.92, 0.0), ortho),
        "left": add_camera_logical(f"cam_{asset_id}_left", (-5.2, ch, 0.0), (0.0, ch * 0.92, 0.0), ortho),
        "right": add_camera_logical(f"cam_{asset_id}_right", (5.2, ch, 0.0), (0.0, ch * 0.92, 0.0), ortho),
        "top": add_camera_logical(f"cam_{asset_id}_top", (0.0, 6.0, 1.1), (0.0, 0.15, 0.0), ortho),
    }
    for name, cam in wide.items():
        render_still(scene, cam, RENDER_DIR / f"{asset_id}_{name}.png")
    gameplay = add_camera_persp(f"cam_{asset_id}_gameplay", (2.6, 3.05, 2.6), (0.0, height * 0.45, 0.0), lens=46.0)
    render_still(scene, gameplay, RENDER_DIR / f"{asset_id}_gameplay.png")
    studio = add_camera_persp(f"cam_{asset_id}_studio", (2.1, height * 0.95, 2.7), (0.0, height * 0.52, 0.0), lens=50.0)
    render_still(scene, studio, RENDER_DIR / f"{asset_id}_studio.png")
    set_ref_hidden(ref, True)
    for name, (target, offset, lens) in rig["close"].items():
        cam = add_camera_persp(
            f"cam_{asset_id}_close_{name}",
            (target[0] + offset[0], target[1] + offset[1], target[2] + offset[2]),
            target,
            lens=lens,
        )
        render_still(scene, cam, RENDER_DIR / f"{asset_id}_close_{name}.png")


# ─────────────────── manifests, provenance, prop mapping ───────────────────


def proxy_box(asset_id, bbox):
    spec = TERMINALS[asset_id]
    return {
        "id": spec["proxy_id"],
        "shape": "box",
        "min": [round(bbox["min"][0], 4), 0.0, round(bbox["min"][2], 4)],
        "max": [round(bbox["max"][0], 4), round(bbox["max"][1], 4), round(bbox["max"][2], 4)],
        "space": "asset-local meters, +Z front; placement yaw is applied by the world lane after this box (one stable post-rotation footprint proxy per terminal)",
        "source": "authored",
    }


def write_manifest(asset_id, metrics, texture_names):
    spec = TERMINALS[asset_id]
    span = bbox_span(metrics["total_bbox"])
    manifest = {
        "asset": asset_id,
        "glb": f"{asset_id}.glb",
        "identity": spec["identity"],
        "units": "m",
        "gltf_conventions": {
            "up": "+Y",
            "front": "+Z (interaction face: screens, controls)",
            "pivot": "base center, min_y=0",
        },
        "dims_m": {"x": round(span[0], 4), "y": round(span[1], 4), "z": round(span[2], 4)},
        "tri_count": int(metrics["tri_count"]),
        "materials": sorted(metrics["mat_names"]),
        "textures": sorted(texture_names),
        "collisionProxy": proxy_box(asset_id, metrics["total_bbox"]),
        "front_clearance_m": FRONT_CLEARANCE_M,
        "front_clearance_note": "keep the cell in front of +Z free; every interactable surface faces +Z",
        "gates": {"result": "see gate.json", "detail": f".game-lab/{RUN_ID}/gate.json"},
    }
    write_json(OUT_DIR / f"{asset_id}_manifest.json", manifest)
    return manifest


def write_provenance(asset_id, glb_path: Path, tri_count: int):
    spec = TERMINALS[asset_id]
    data = {
        "schema": "successor-asset-provenance/1",
        "asset_id": asset_id,
        "asset_path": f"client-3d/public/assets/world-items/{glb_path.name}",
        "asset_hash": sha256_of(glb_path),
        "asset_kind": "model_glb",
        "tool": {"name": "blender-bpy-headless", "version": bpy.app.version_string.split()[0], "tool_snapshot_id": f"blender-{bpy.app.version_string.split()[0]}"},
        "prompt": {
            "text": "Hand-authored parametric part program (no generative model): " + spec["identity"] + " UV-backed procedural PBR maps (baseColor + metallicRoughness + normal, deterministic seeds), non-text emissive screen UI, shared Dustgate civic commerce palette.",
            "denylist_audit": "passed: no franchise/IP terms and no baked words in names, materials, node names, textures, or artifacts",
        },
        "seed": "deterministic numpy seeds 2026071801..05 + per-screen layout constants",
        "input_assets": [
            {"path": "tools/successor/assets/cloning-facility-opus5/", "purpose": "design-language + gate/manifest contract reference (formerly build_cloning_facility.py, replaced by that package)"},
        ],
        "human_edits": [],
        "rights": {
            "source_license": "Successor proprietary project asset; all rights reserved",
            "redistribution_status": "authorized for Successor runtime distribution only; no standalone reuse grant",
        },
        "regeneration_command": "/snap/bin/blender -b --factory-startup --python-exit-code 1 -P tools/successor/assets/build_commerce_terminals.py",
        "tri_count": tri_count,
        "gate_report": f".game-lab/{RUN_ID}/gate.json",
        "source_blend_or_script": "tools/successor/assets/build_commerce_terminals.py (deterministic parametric part program; no .blend needed)",
        "agent_provenance": {
            "produced_by": [
                {
                    "agent_instance_id": "CommerceTerminalBuilder",
                    "run_id": RUN_ID,
                    "role": "content-author",
                    "provider": "anthropic",
                    "model": "Fable 5",
                }
            ],
            "reviewed_by_agents": [
                {"agent_instance_id": "CommerceTerminalBuilder", "role": "judge", "notes": f"numeric parsed-GLB gates + multi-pass studio render/crop review in .game-lab/{RUN_ID}/renders/"}
            ],
            "human_approvals": [],
        },
    }
    write_json(glb_path.with_suffix("").with_name(glb_path.stem + ".provenance.json"), data)


ASSET_MATERIALS = {
    "bank_terminal_civic": (BANK_MATERIALS, "CM_ScreenBank"),
    "trade_terminal": (TRADE_MATERIALS, "CM_ScreenTrade"),
    "pa_terminal": (PA_MATERIALS, "CM_ScreenPA"),
}


def asset_texture_names(allowed):
    names = []
    for mat in allowed:
        spec = MATERIAL_SPEC[mat]
        if "tex" in spec:
            names += [f"{spec['tex']}_basecolor.png", f"{spec['tex']}_mr.png", f"{spec['tex']}_normal.png"]
        elif "screen" in spec:
            names.append(f"{spec['screen']}_emissive.png")
    return names


def main():
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    EVIDENCE_DIR.mkdir(parents=True, exist_ok=True)
    RENDER_DIR.mkdir(parents=True, exist_ok=True)
    for p in RENDER_DIR.glob("*.png"):
        p.unlink()

    write_texture_maps()

    gates = {}
    for asset_id, build_fn in BUILDERS.items():
        allowed, screen_mat = ASSET_MATERIALS[asset_id]
        root = build_fn()
        glb_path = OUT_DIR / f"{asset_id}.glb"
        export_glb(root, glb_path)
        metrics = parse_glb_metrics(glb_path)
        validate = run_validator(glb_path)
        gates[asset_id] = terminal_gate(asset_id, metrics, validate, allowed, screen_mat)
        write_manifest(asset_id, metrics, asset_texture_names(allowed))
        write_provenance(asset_id, glb_path, metrics["tri_count"])
        render_terminal(root, asset_id)

    all_green = all(g["all_green"] for g in gates.values())
    summary = {
        "run": RUN_ID,
        "all_green": all_green,
        "assets": gates,
        "textures": {key: {"path": str(path.relative_to(REPO)), "hash": sha256_of(path)} for key, path in sorted(TEXTURE_FILES.items())},
        "renders_dir": str(RENDER_DIR),
    }
    write_json(GATE_PATH, summary)
    final = json.loads(GATE_PATH.read_text())
    print(json.dumps({
        "all_green": final["all_green"],
        "tri_counts": {k: v["tri_count"] for k, v in final["assets"].items()},
        "spans": {k: v["total_bbox_m"]["span"] for k, v in final["assets"].items()},
        "checks_failed": {k: [c for c, ok in v["checks"].items() if not ok] for k, v in final["assets"].items() if not v["all_green"]},
    }, indent=2))
    if not final.get("all_green"):
        raise SystemExit("gate.json is not green after disk re-read")


if __name__ == "__main__":
    main()
