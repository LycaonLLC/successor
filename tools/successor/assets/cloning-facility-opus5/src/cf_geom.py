"""Deterministic hard-surface mesh construction for the Dustgate Clone Vault.

A `Part` accumulates welded vertices and per-face material assignments in
LOGICAL space (+X right, +Y up, +Z front).  `realize` turns one Part into one
Blender object with as many material slots as it actually used, box-projects
the authoring UV set at each material's tile scale, and parents it to the
asset root.  One Part == one glTF node, so Part names carry the cutaway role
prefixes the runtime reveal logic reads.

Everything here is closed-form: no modifiers, no booleans, no ops that depend
on selection state.  Two runs of the same code produce the same vertex buffer.
"""
from __future__ import annotations

import math

import bpy
import bmesh
from mathutils import Vector

from cf_spec import SURFACES

TAU = math.pi * 2.0


def logical_to_blender(p):
    x, y, z = p
    return (x, -z, y)


def lerp(a, b, t):
    return a + (b - a) * t


def pol(cx, cz, deg, r):
    a = math.radians(deg)
    return (cx + r * math.cos(a), cz + r * math.sin(a))


# ────────────────────────────────── Part ──────────────────────────────────


class Part:
    """One glTF node's worth of geometry."""

    __slots__ = ("name", "verts", "faces", "_index", "_smooth", "bbox")

    def __init__(self, name: str, smooth: bool = False):
        self.name = name
        self.verts: list[tuple[float, float, float]] = []
        self.faces: list[tuple[tuple[int, ...], str]] = []
        self._index: dict[tuple[int, int, int], int] = {}
        self._smooth = smooth
        self.bbox = [1e9, 1e9, 1e9, -1e9, -1e9, -1e9]

    # -- vertex plumbing ---------------------------------------------------
    def v(self, co) -> int:
        key = (round(co[0] * 1e5), round(co[1] * 1e5), round(co[2] * 1e5))
        hit = self._index.get(key)
        if hit is not None:
            return hit
        idx = len(self.verts)
        self.verts.append((float(co[0]), float(co[1]), float(co[2])))
        self._index[key] = idx
        b = self.bbox
        for i in range(3):
            b[i] = min(b[i], co[i])
            b[i + 3] = max(b[i + 3], co[i])
        return idx

    def face(self, coords, mat: str):
        idx = tuple(self.v(c) for c in coords)
        if len(set(idx)) < 3:
            return
        self.faces.append((idx, mat))

    def quad(self, a, b, c, d, mat):
        self.face((a, b, c, d), mat)

    def tri(self, a, b, c, mat):
        self.face((a, b, c), mat)

    def strip(self, ring0, ring1, mat, closed=True, flip=False):
        """Bridge two equal-length rings of points."""
        n = len(ring0)
        last = n if closed else n - 1
        for i in range(last):
            j = (i + 1) % n
            if flip:
                self.quad(ring0[i], ring1[i], ring1[j], ring0[j], mat)
            else:
                self.quad(ring0[i], ring0[j], ring1[j], ring1[i], mat)

    @property
    def tri_count(self) -> int:
        return sum(max(0, len(f) - 2) for f, _ in self.faces)


# ───────────────────────────── primitive shapes ───────────────────────────


def box(p: Part, x0, x1, y0, y1, z0, z1, mat, skip=()):
    """Axis-aligned box.  `skip` drops faces by name: -x +x -y +y -z +z."""
    if "-z" not in skip:
        p.quad((x0, y0, z0), (x1, y0, z0), (x1, y1, z0), (x0, y1, z0), mat)
    if "+z" not in skip:
        p.quad((x1, y0, z1), (x0, y0, z1), (x0, y1, z1), (x1, y1, z1), mat)
    if "-x" not in skip:
        p.quad((x0, y0, z1), (x0, y0, z0), (x0, y1, z0), (x0, y1, z1), mat)
    if "+x" not in skip:
        p.quad((x1, y0, z0), (x1, y0, z1), (x1, y1, z1), (x1, y1, z0), mat)
    if "-y" not in skip:
        p.quad((x0, y0, z1), (x1, y0, z1), (x1, y0, z0), (x0, y0, z0), mat)
    if "+y" not in skip:
        p.quad((x0, y1, z0), (x1, y1, z0), (x1, y1, z1), (x0, y1, z1), mat)


def oct_plan(x0, x1, z0, z1, ch):
    """Rectangle with its four corners cut, as an 8-gon in the x/z plane."""
    ch = min(ch, (x1 - x0) * 0.49, (z1 - z0) * 0.49)
    return [(x0 + ch, z0), (x1 - ch, z0), (x1, z0 + ch), (x1, z1 - ch),
            (x1 - ch, z1), (x0 + ch, z1), (x0, z1 - ch), (x0, z0 + ch)]


def prism_y(p: Part, plan, y0, y1, mat, cap_lo=True, cap_hi=True, skip_side=()):
    """Extrude a closed x/z polygon along +Y."""
    n = len(plan)
    for i in range(n):
        if i in skip_side:
            continue
        j = (i + 1) % n
        a, b = plan[i], plan[j]
        p.quad((a[0], y0, a[1]), (b[0], y0, b[1]),
               (b[0], y1, b[1]), (a[0], y1, a[1]), mat)
    if cap_lo:
        p.face([(q[0], y0, q[1]) for q in reversed(plan)], mat)
    if cap_hi:
        p.face([(q[0], y1, q[1]) for q in plan], mat)


def frustum_y(p: Part, plan_lo, y0, plan_hi, y1, mat, cap_lo=True, cap_hi=True):
    n = len(plan_lo)
    for i in range(n):
        j = (i + 1) % n
        a, b = plan_lo[i], plan_lo[j]
        c, d = plan_hi[j], plan_hi[i]
        p.quad((a[0], y0, a[1]), (b[0], y0, b[1]),
               (c[0], y1, c[1]), (d[0], y1, d[1]), mat)
    if cap_lo:
        p.face([(q[0], y0, q[1]) for q in reversed(plan_lo)], mat)
    if cap_hi:
        p.face([(q[0], y1, q[1]) for q in plan_hi], mat)


def cham_box(p: Part, x0, x1, y0, y1, z0, z1, mat, ch=0.02, top=True,
             bottom=False, skip_side=()):
    """Box with chamfered vertical arrises and optional chamfered lid/foot."""
    plan = oct_plan(x0, x1, z0, z1, ch)
    inner = oct_plan(x0 + ch, x1 - ch, z0 + ch, z1 - ch, ch)
    ylo = y0 + ch if bottom else y0
    yhi = y1 - ch if top else y1
    prism_y(p, plan, ylo, yhi, mat, cap_lo=not bottom, cap_hi=not top,
            skip_side=skip_side)
    if top:
        frustum_y(p, plan, yhi, inner, y1, mat, cap_lo=False, cap_hi=True)
    if bottom:
        frustum_y(p, inner, y0, plan, ylo, mat, cap_lo=True, cap_hi=False)


def ring_plan(cx, cz, r, sides, start_deg=0.0, rz=None):
    rz = r if rz is None else rz
    out = []
    for i in range(sides):
        a = math.radians(start_deg) + TAU * i / sides
        out.append((cx + r * math.cos(a), cz + rz * math.sin(a)))
    return out


def cyl_y(p: Part, cx, cz, r, y0, y1, mat, sides=16, start_deg=0.0,
          cap_lo=True, cap_hi=True, rz=None):
    prism_y(p, ring_plan(cx, cz, r, sides, start_deg, rz), y0, y1, mat,
            cap_lo=cap_lo, cap_hi=cap_hi)


def tube_y(p: Part, cx, cz, r_in, r_out, y0, y1, mat, sides=16, start_deg=0.0,
           cap_lo=True, cap_hi=True):
    outer = ring_plan(cx, cz, r_out, sides, start_deg)
    inner = ring_plan(cx, cz, r_in, sides, start_deg)
    for i in range(sides):
        j = (i + 1) % sides
        a, b = outer[i], outer[j]
        p.quad((a[0], y0, a[1]), (b[0], y0, b[1]), (b[0], y1, b[1]), (a[0], y1, a[1]), mat)
        c, d = inner[i], inner[j]
        p.quad((d[0], y0, d[1]), (c[0], y0, c[1]), (c[0], y1, c[1]), (d[0], y1, d[1]), mat)
    if cap_hi:
        for i in range(sides):
            j = (i + 1) % sides
            p.quad((outer[i][0], y1, outer[i][1]), (outer[j][0], y1, outer[j][1]),
                   (inner[j][0], y1, inner[j][1]), (inner[i][0], y1, inner[i][1]), mat)
    if cap_lo:
        for i in range(sides):
            j = (i + 1) % sides
            p.quad((inner[i][0], y0, inner[i][1]), (inner[j][0], y0, inner[j][1]),
                   (outer[j][0], y0, outer[j][1]), (outer[i][0], y0, outer[i][1]), mat)


def cyl_axis(p: Part, axis, c0, c1, span0, span1, r, mat, sides=12,
             start_deg=0.0, caps=True):
    """Cylinder along a world axis.  `axis` in {'x','y','z'};
    (c0, c1) are the two cross-section centre coordinates in cyclic order."""
    rings = []
    for s in (span0, span1):
        ring = []
        for i in range(sides):
            a = math.radians(start_deg) + TAU * i / sides
            u = c0 + r * math.cos(a)
            v = c1 + r * math.sin(a)
            if axis == "x":
                ring.append((s, u, v))     # (x, y, z) with u=y, v=z
            elif axis == "y":
                ring.append((u, s, v))
            else:
                ring.append((u, v, s))
            del u, v
        rings.append(ring)
    for i in range(sides):
        j = (i + 1) % sides
        p.quad(rings[0][i], rings[0][j], rings[1][j], rings[1][i], mat)
    if caps:
        p.face(list(reversed(rings[0])), mat)
        p.face(list(rings[1]), mat)


def lathe(p: Part, cx, cz, profile, mat, sides=24, start_deg=0.0,
          cap_lo=False, cap_hi=False):
    """Revolve an (radius, y) profile about the vertical axis at (cx, cz)."""
    rings = []
    for r, y in profile:
        if r <= 1e-6:
            rings.append([(cx, y, cz)] * sides)
        else:
            rings.append([(x, y, z) for x, z in ring_plan(cx, cz, r, sides, start_deg)])
    for k in range(len(rings) - 1):
        lo, hi = rings[k], rings[k + 1]
        for i in range(sides):
            j = (i + 1) % sides
            a, b, c, d = lo[i], lo[j], hi[j], hi[i]
            if a == b:
                p.tri(a, c, d, mat)
            elif c == d:
                p.tri(a, b, c, mat)
            else:
                p.quad(a, b, c, d, mat)
    if cap_lo:
        p.face(list(reversed(rings[0])), mat)
    if cap_hi:
        p.face(list(rings[-1]), mat)


def torus_y(p: Part, cx, cy, cz, major, minor, mat, major_sides=24,
            minor_sides=8, arc_deg=360.0, start_deg=0.0):
    """Torus whose ring plane is horizontal (a gasket / seal band)."""
    rings = []
    steps = major_sides if arc_deg >= 359.9 else major_sides + 1
    for i in range(steps):
        a = math.radians(start_deg + arc_deg * i / major_sides)
        dx, dz = math.cos(a), math.sin(a)
        ring = []
        for k in range(minor_sides):
            b = TAU * k / minor_sides
            rr = major + minor * math.cos(b)
            ring.append((cx + rr * dx, cy + minor * math.sin(b), cz + rr * dz))
        rings.append(ring)
    closed = arc_deg >= 359.9
    lim = len(rings) if closed else len(rings) - 1
    for i in range(lim):
        lo, hi = rings[i], rings[(i + 1) % len(rings)]
        for k in range(minor_sides):
            m = (k + 1) % minor_sides
            p.quad(lo[k], lo[m], hi[m], hi[k], mat)


def pipe_run(p: Part, points, r, mat, sides=8, caps=True, start_deg=22.5):
    """Mitred tube through a 3D polyline.  Adjacent segments share a ring."""
    pts = [Vector(q) for q in points]
    if len(pts) < 2:
        return
    dirs = [(pts[i + 1] - pts[i]).normalized() for i in range(len(pts) - 1)]
    normals = []
    for i in range(len(pts)):
        if i == 0:
            normals.append(dirs[0])
        elif i == len(pts) - 1:
            normals.append(dirs[-1])
        else:
            n = (dirs[i - 1] + dirs[i])
            normals.append(n.normalized() if n.length > 1e-6 else dirs[i])
    up = Vector((0.0, 1.0, 0.0))
    rings = []
    for i, (c, n) in enumerate(zip(pts, normals)):
        d = dirs[min(i, len(dirs) - 1)]
        ref = up if abs(d.dot(up)) < 0.94 else Vector((1.0, 0.0, 0.0))
        u = d.cross(ref).normalized()
        v = d.cross(u).normalized()
        # Mitre: scale the section so the swept tube keeps radius r.
        cosang = max(0.35, n.dot(d))
        ring = []
        for k in range(sides):
            a = math.radians(start_deg) + TAU * k / sides
            off = u * (r * math.cos(a)) + v * (r * math.sin(a))
            # project the offset onto the mitre plane along d
            t = -(off.dot(n)) / max(1e-4, d.dot(n)) if abs(d.dot(n)) > 1e-4 else 0.0
            q = c + off + d * t
            ring.append((q.x, q.y, q.z))
            del off, t, q
        del cosang
        rings.append(ring)
    for i in range(len(rings) - 1):
        p.strip(rings[i], rings[i + 1], mat)
    if caps:
        p.face(list(reversed(rings[0])), mat)
        p.face(list(rings[-1]), mat)


def plate(p: Part, u0, u1, v0, v1, w_back, w_front, mat, ch=0.012, axis="+z"):
    """Proud, chamfer-bordered plate on one of the six cardinal faces."""
    m, flip = _axis_map(axis)
    wf = w_front - ch if w_front > w_back else w_front + ch
    outer = [(u0, v0), (u1, v0), (u1, v1), (u0, v1)]
    inner = [(u0 + ch, v0 + ch), (u1 - ch, v0 + ch), (u1 - ch, v1 - ch), (u0 + ch, v1 - ch)]
    for i in range(4):
        j = (i + 1) % 4
        quad = [m(*outer[i], w_back), m(*outer[j], w_back),
                m(*inner[j], wf), m(*inner[i], wf)]
        p.face(quad[::-1] if flip else quad, mat)
    cap = [m(*q, wf) for q in inner]
    p.face(cap[::-1] if flip else cap, mat)


# Face-local frame for the six cardinal faces.
#
#   u, v  are PLAIN WORLD COORDINATES in the face plane (u = x for the z/y
#         faces and z for the x faces; v = y for the vertical faces and z for
#         the horizontal ones);
#   w     is the outward coordinate along the face normal.
#
# Three of the six mappings are orientation-reversing, so they carry a `flip`
# and every helper below reverses its point order for them.  The alternative —
# folding the sign into `u` to keep every map right-handed — is what the older
# generators did, and it silently mirrors any asymmetric detail placed on a
# `+x`, `-z` or `+y` face.  Correct winding is cheap; a mirrored facade is not.
_AXIS = {
    "+z": (lambda u, v, w: (u, v, w), False),
    "-z": (lambda u, v, w: (u, v, -w), True),
    "+x": (lambda u, v, w: (w, v, u), True),
    "-x": (lambda u, v, w: (-w, v, u), False),
    "+y": (lambda u, v, w: (u, w, v), True),
    "-y": (lambda u, v, w: (u, -w, v), False),
}


def _axis_map(axis):
    try:
        return _AXIS[axis]
    except KeyError:
        raise ValueError(axis) from None


def recess_field(p: Part, u0, u1, v0, v1, w_face, depth, mat, cols, rows,
                 gap=0.045, axis="+z", rim=0.0):
    """Grid of shallow recessed panels: the micro-relief that keeps a large
    cast face from reading as one flat rectangle."""
    m, flip = _axis_map(axis)
    su = (u1 - u0 - rim * 2) / cols
    sv = (v1 - v0 - rim * 2) / rows
    for c in range(cols):
        for r in range(rows):
            a0 = u0 + rim + c * su + gap * 0.5
            a1 = u0 + rim + (c + 1) * su - gap * 0.5
            b0 = v0 + rim + r * sv + gap * 0.5
            b1 = v0 + rim + (r + 1) * sv - gap * 0.5
            if a1 - a0 < 0.02 or b1 - b0 < 0.02:
                continue
            wb = w_face - depth
            k = 0.018
            outer = [(a0, b0), (a1, b0), (a1, b1), (a0, b1)]
            inner = [(a0 + k, b0 + k), (a1 - k, b0 + k), (a1 - k, b1 - k), (a0 + k, b1 - k)]
            for i in range(4):
                j = (i + 1) % 4
                quad = [m(*outer[i], w_face), m(*inner[i], wb),
                        m(*inner[j], wb), m(*outer[j], w_face)]
                p.face(quad[::-1] if flip else quad, mat)
            cap = [m(*q, wb) for q in inner]
            p.face(cap[::-1] if flip else cap, mat)


def louvers(p: Part, u0, u1, v_top, count, pitch, w_face, depth, mat,
            axis="+z", drop=0.022):
    m, flip = _axis_map(axis)
    for i in range(count):
        vt = v_top - i * pitch
        vb = vt - pitch * 0.62
        blade = [m(u0, vt, w_face), m(u1, vt, w_face),
                 m(u1, vb - drop, w_face - depth), m(u0, vb - drop, w_face - depth)]
        soffit = [m(u0, vb - drop, w_face - depth), m(u1, vb - drop, w_face - depth),
                  m(u1, vb, w_face - depth * 0.35), m(u0, vb, w_face - depth * 0.35)]
        p.face(blade[::-1] if flip else blade, mat)
        p.face(soffit[::-1] if flip else soffit, mat)


def bolt_row(p: Part, coords, w_face, mat, r=0.019, h=0.014, axis="+z", sides=6):
    m, flip = _axis_map(axis)
    for (u, v) in coords:
        ring = [(u + r * math.cos(math.radians(30 + 60 * k)),
                 v + r * math.sin(math.radians(30 + 60 * k))) for k in range(sides)]
        top = [m(a, b, w_face + h) for a, b in ring]
        bot = [m(a, b, w_face) for a, b in ring]
        if flip:
            top, bot = top[::-1], bot[::-1]
        p.strip(bot, top, mat)
        p.face(top, mat)


def grate(p: Part, x0, x1, z0, z1, y, mat, bars=9, along="x", thick=0.012):
    """Slotted drain / vent grate lying in the horizontal plane."""
    if along == "x":
        step = (z1 - z0) / bars
        for i in range(bars):
            a = z0 + i * step + step * 0.22
            b = z0 + (i + 1) * step - step * 0.22
            box(p, x0, x1, y - thick, y, a, b, mat)
    else:
        step = (x1 - x0) / bars
        for i in range(bars):
            a = x0 + i * step + step * 0.22
            b = x0 + (i + 1) * step - step * 0.22
            box(p, a, b, y - thick, y, z0, z1, mat)


def ladder(p: Part, x, z0, z1, y0, y1, mat, rungs=7, rail_r=0.026, rung_r=0.017):
    cyl_axis(p, "y", x, z0, y0, y1, rail_r, mat, sides=6)
    cyl_axis(p, "y", x, z1, y0, y1, rail_r, mat, sides=6)
    for i in range(rungs):
        yy = lerp(y0 + 0.16, y1 - 0.14, i / max(1, rungs - 1))
        cyl_axis(p, "z", x, yy, z0, z1, rung_r, mat, sides=6)


def chevron_band(p: Part, x0, x1, z0, z1, y, mat_a, mat_b, count=10, skew=0.10):
    """Floor hazard striping: alternating skewed bands, two materials."""
    span = (x1 - x0) / count
    for i in range(count):
        a0 = x0 + i * span
        a1 = a0 + span
        mat = mat_a if i % 2 == 0 else mat_b
        p.quad((a0, y, z0), (a1, y, z0), (a1 + skew, y, z1), (a0 + skew, y, z1), mat)


def merge(dst: Part, src: Part, offset=(0.0, 0.0, 0.0), yaw_deg=0.0, scale=1.0,
          mirror_z=False):
    """Copy `src` into `dst`, rotated about +Y and translated.

    Lets a sub-assembly (a vat, a pump skid) be authored once in a convenient
    local frame — front toward +X, origin on its own floor — and then placed
    repeatedly without every primitive growing a transform argument.
    """
    a = math.radians(yaw_deg)
    ca, sa = math.cos(a), math.sin(a)
    remap = {}
    for i, (x, y, z) in enumerate(src.verts):
        x, y, z = x * scale, y * scale, z * scale
        if mirror_z:
            z = -z
        xr = x * ca + z * sa
        zr = -x * sa + z * ca
        remap[i] = dst.v((xr + offset[0], y + offset[1], zr + offset[2]))
    for idx, mat in src.faces:
        order = tuple(remap[i] for i in idx)
        if mirror_z:
            order = tuple(reversed(order))
        if len(set(order)) < 3:
            continue
        dst.faces.append((order, mat))
    return dst


# ────────────────────────────── realisation ───────────────────────────────


# Materials whose UV must fit the face, not the world.
_FIT_FACE_UV = ("CF_Screen",)


def _tile_for(mat_name: str) -> float:
    spec = SURFACES.get(mat_name)
    return spec[3] if spec else 1.0


def realize(part: Part, materials: dict, parent, collection, smooth_angle=None):
    """Part -> Blender object with per-face material slots and box UVs."""
    mesh = bpy.data.meshes.new(part.name + "_mesh")
    bm = bmesh.new()
    bverts = [bm.verts.new(logical_to_blender(v)) for v in part.verts]
    bm.verts.index_update()

    used: list[str] = []
    slot_of: dict[str, int] = {}
    for _, mat_name in part.faces:
        if mat_name not in slot_of:
            slot_of[mat_name] = len(used)
            used.append(mat_name)

    made = []
    for idx, mat_name in part.faces:
        try:
            f = bm.faces.new([bverts[i] for i in idx])
        except ValueError:
            continue
        f.material_index = slot_of[mat_name]
        made.append(f)
    bm.faces.index_update()
    # Recalculate outward normals BEFORE anything reads f.normal.
    #
    # The hand-rolled primitives below wind their faces inward: `box()`'s -X
    # quad, for instance, resolves to a +X normal once `logical_to_blender`
    # has been applied.  Camera rays never showed it, because both EEVEE and
    # Cycles flip the shading normal toward the viewer on a two-sided
    # material -- but `bpy.ops.object.bake` does not, so every ambient and
    # shadow ray fired INTO the solid and the whole lighting bake came back
    # zero.  This one call is what makes a baked read possible at all.
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.normal_update()

    uv = bm.loops.layers.uv.new("UVMap")
    for f in bm.faces:
        n = f.normal
        ax, ay, az = abs(n.x), abs(n.y), abs(n.z)
        mat_name = used[f.material_index] if used else ""
        tile = _tile_for(mat_name)
        s = 1.0 / max(1e-4, tile)
        raw = []
        for loop in f.loops:
            co = loop.vert.co
            if ax >= ay and ax >= az:
                raw.append((co.y, co.z))
            elif ay >= az:
                raw.append((co.x, co.z))
            else:
                raw.append((co.x, co.y))
        if mat_name in _FIT_FACE_UV:
            # A display panel wants the whole graphic on the face, not a slice
            # of a world-space tiling projection.
            u0 = min(q[0] for q in raw); u1 = max(q[0] for q in raw)
            v0 = min(q[1] for q in raw); v1 = max(q[1] for q in raw)
            du = max(1e-6, u1 - u0); dv = max(1e-6, v1 - v0)
            flip = ax >= ay and ax >= az and n.x > 0
            for loop, (u, v) in zip(f.loops, raw):
                fu = (u - u0) / du
                loop[uv].uv = (1.0 - fu if flip else fu, (v - v0) / dv)
        else:
            for loop, (u, v) in zip(f.loops, raw):
                loop[uv].uv = (u * s, v * s)

    bm.to_mesh(mesh)
    bm.free()

    obj = bpy.data.objects.new(part.name, mesh)
    for mat_name in used:
        mesh.materials.append(materials[mat_name])
    collection.objects.link(obj)
    obj.parent = parent
    if smooth_angle is not None:
        for poly in mesh.polygons:
            poly.use_smooth = True
        mod = obj.modifiers.new("SmoothByAngle", "SMOOTH_BY_ANGLE")
        try:
            mod["Input_1"] = math.radians(smooth_angle)
        except Exception:
            pass
    mesh.validate(clean_customdata=False)
    return obj


def make_root(name: str, collection):
    root = bpy.data.objects.new(name, None)
    collection.objects.link(root)
    root.empty_display_type = "PLAIN_AXES"
    root.empty_display_size = 0.5
    return root
