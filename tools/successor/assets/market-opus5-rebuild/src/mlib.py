"""Geometry / UV / wear / material library for the market generator.

Blender authoring space: +X east, +Y north, +Z up. Public front is -Y, which the
glTF Y-up conversion turns into the required +Z front.

Three hard-won export rules are encoded here (see REPORT.md):
  1. n-gons (>4 verts) must be triangulated or glTF tangent generation fails.
  2. Every material must consume the "Col" vertex-colour layer or COLOR_0 is
     silently dropped from the whole primitive.
  3. A packed ORM image must be linked from EXACTLY ONE socket (Roughness).
     Linking Metallic and/or the glTF-Occlusion group from the same image makes
     Blender's exporter emit "More than one shader node tex image..." warnings.
     Metallic is therefore a per-material constant; occlusion is re-attached to
     the same texture after export by src/post_gltf.mjs.
"""
import math
import os
import random

import bmesh
import bpy
from mathutils import Matrix, Vector
from mathutils.bvhtree import BVHTree

SCENE_OBJS = []
LOD_BEVEL = 1.0
LOD_NSCALE = 1.0


def clear():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    SCENE_OBJS.clear()
    sc = bpy.context.scene
    sc.unit_settings.system = 'METRIC'
    sc.unit_settings.scale_length = 1.0
    sc.render.fps = 30


# --------------------------------------------------------------- primitives

def _finish(name, bm, mat, bev, seg, group, wear, tile, phase):
    if bev and bev * LOD_BEVEL > 0:
        b = bev * LOD_BEVEL
        edges = [e for e in bm.edges if len(e.link_faces) == 2
                 and e.calc_face_angle(0.0) > math.radians(28)]
        if edges:
            bmesh.ops.bevel(bm, geom=edges, offset=b, offset_type='OFFSET',
                            segments=seg, profile=0.5, affect='EDGES',
                            clamp_overlap=True, miter_outer='SHARP')
    # RULE 1: triangulate n-gons only; quads survive for a clean cage
    ng = [f for f in bm.faces if len(f.verts) > 4]
    if ng:
        bmesh.ops.triangulate(bm, faces=ng, quad_method='SHORT_EDGE',
                              ngon_method='BEAUTY')
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    ob = bpy.data.objects.new(name, me)
    if mat:
        me.materials.append(mat)
    bpy.context.scene.collection.objects.link(ob)
    ob["group"] = group
    ob["wear"] = wear or ""
    ob["tile"] = tile
    ob["phase"] = phase if phase is not None else _auto_phase(name)
    SCENE_OBJS.append(ob)
    return ob


def _auto_phase(name):
    """Deterministic per-object UV phase: breaks tile alignment between parts."""
    r = random.Random(name)
    return (r.random(), r.random(), r.choice([0.0, 90.0, 180.0, 270.0]))


def box(name, mat, c, s, bev=0.0, seg=1, group="", wear="", tile=None, phase=None):
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    bmesh.ops.scale(bm, vec=Vector(s), verts=bm.verts)
    bmesh.ops.translate(bm, vec=Vector(c), verts=bm.verts)
    return _finish(name, bm, mat, bev, seg, group, wear, tile, phase)


def prism(name, mat, pts, axis, a, b, bev=0.0, seg=1, group="", wear="",
          tile=None, phase=None):
    """Extrude 2D polygon `pts` along `axis` (0=X,1=Y,2=Z) from a to b.

    pts are in the two remaining axes in ascending order, counter-clockwise.
    """
    o = [i for i in range(3) if i != axis]
    bm = bmesh.new()
    ring = []
    for p in pts:
        v = [0.0, 0.0, 0.0]
        v[axis] = a
        v[o[0]], v[o[1]] = p[0], p[1]
        ring.append(bm.verts.new(v))
    bm.verts.ensure_lookup_table()
    f = bm.faces.new(ring)
    r = bmesh.ops.extrude_face_region(bm, geom=[f])
    vs = [e for e in r["geom"] if isinstance(e, bmesh.types.BMVert)]
    d = [0.0, 0.0, 0.0]
    d[axis] = b - a
    bmesh.ops.translate(bm, vec=Vector(d), verts=vs)
    return _finish(name, bm, mat, bev, seg, group, wear, tile, phase)


def cyl(name, mat, c, r, h, axis=2, n=16, bev=0.0, group="", wear="", r2=None,
        tile=None, phase=None):
    n = max(6, int(round(n * LOD_NSCALE)))
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=True, cap_tris=False, segments=n,
                          radius1=r, radius2=(r if r2 is None else r2), depth=h)
    if axis == 0:
        bmesh.ops.rotate(bm, verts=bm.verts, matrix=Matrix.Rotation(math.pi / 2, 3, 'Y'))
    elif axis == 1:
        bmesh.ops.rotate(bm, verts=bm.verts, matrix=Matrix.Rotation(math.pi / 2, 3, 'X'))
    bmesh.ops.translate(bm, vec=Vector(c), verts=bm.verts)
    return _finish(name, bm, mat, bev, 1, group, wear, tile, phase)


def tube(name, mat, c, r_out, r_in, h, axis=2, n=20, group="", wear="",
         tile=None, phase=None):
    """Hollow ring/tube: two concentric rings bridged top and bottom."""
    n = max(8, int(round(n * LOD_NSCALE)))
    bm = bmesh.new()
    rings = []
    for rr in (r_out, r_in):
        for zz in (-h / 2, h / 2):
            vs = []
            for i in range(n):
                a = 2 * math.pi * i / n
                vs.append(bm.verts.new((math.cos(a) * rr, math.sin(a) * rr, zz)))
            rings.append(vs)
    bm.verts.ensure_lookup_table()
    ro_b, ro_t, ri_b, ri_t = rings
    for i in range(n):
        j = (i + 1) % n
        bm.faces.new((ro_b[i], ro_b[j], ro_t[j], ro_t[i]))     # outer wall
        bm.faces.new((ri_t[i], ri_t[j], ri_b[j], ri_b[i]))     # inner wall
        bm.faces.new((ro_t[i], ro_t[j], ri_t[j], ri_t[i]))     # top
        bm.faces.new((ri_b[i], ri_b[j], ro_b[j], ro_b[i]))     # bottom
    if axis == 0:
        bmesh.ops.rotate(bm, verts=bm.verts, matrix=Matrix.Rotation(math.pi / 2, 3, 'Y'))
    elif axis == 1:
        bmesh.ops.rotate(bm, verts=bm.verts, matrix=Matrix.Rotation(math.pi / 2, 3, 'X'))
    bmesh.ops.translate(bm, vec=Vector(c), verts=bm.verts)
    return _finish(name, bm, mat, 0.0, 1, group, wear, tile, phase)


def arc_pts(cx, cz, r, a0, a1, n, r_in=None):
    """Points along an arc; if r_in given, returns a closed arc band (a shell)."""
    out = [(cx + math.cos(a0 + (a1 - a0) * i / n) * r,
            cz + math.sin(a0 + (a1 - a0) * i / n) * r) for i in range(n + 1)]
    if r_in is not None:
        out += [(cx + math.cos(a1 - (a1 - a0) * i / n) * r_in,
                 cz + math.sin(a1 - (a1 - a0) * i / n) * r_in) for i in range(n + 1)]
    return out


def wall(name, mat, axis, lo, hi, u0, u1, z0, z1, openings=(), bev=0.0,
         group="", wear="", tile=None):
    """Rectangular wall with rectangular openings, emitted as solid segments."""
    segs = []
    x = u0
    for (a, b, c, d) in sorted(openings, key=lambda o: o[0]):
        if a > x:
            segs.append((x, a, z0, z1))
        if c > z0:
            segs.append((a, b, z0, c))
        if d < z1:
            segs.append((a, b, d, z1))
        x = max(x, b)
    if x < u1:
        segs.append((x, u1, z0, z1))
    out = []
    for i, (a, b, c, d) in enumerate(segs):
        if b - a < 1e-6 or d - c < 1e-6:
            continue
        nm = f"{name}_{i}"
        if axis == 0:
            out.append(box(nm, mat, ((lo + hi) / 2, (a + b) / 2, (c + d) / 2),
                           (hi - lo, b - a, d - c), bev, 1, group, wear, tile,
                           phase=(0.0, 0.0, 0.0)))
        else:
            out.append(box(nm, mat, ((a + b) / 2, (lo + hi) / 2, (c + d) / 2),
                           (b - a, hi - lo, d - c), bev, 1, group, wear, tile,
                           phase=(0.0, 0.0, 0.0)))
    return out


def join(objs, name, group=""):
    objs = [o for o in objs if o and o.name in bpy.data.objects]
    if not objs:
        return None
    bpy.ops.object.select_all(action='DESELECT')
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    bpy.ops.object.join()
    ob = bpy.context.view_layer.objects.active
    ob.name = name
    ob.data.name = name
    ob["group"] = group
    for o in objs[1:]:
        if o in SCENE_OBJS:
            SCENE_OBJS.remove(o)
    bpy.ops.object.select_all(action='DESELECT')
    return ob


# ------------------------------------------------------------------ UV

def uv_project(ob, tiles, default=2.0):
    """Per-face tangent-frame planar projection.

    A face's UV frame is derived from its own normal, so texel density is
    constant on battered, raked and bevelled faces alike -- this is what kills
    the pass-1 stretch banding. Coplanar faces share a frame, so large walls
    stay continuous and seams fall only on real geometric edges.
    """
    me = ob.data
    bm = bmesh.new()
    bm.from_mesh(me)
    uvl = bm.loops.layers.uv.verify()
    mw = ob.matrix_world
    ph = ob.get("phase") or (0.0, 0.0, 0.0)
    otile = ob.get("tile")
    ca, sa = math.cos(math.radians(ph[2])), math.sin(math.radians(ph[2]))
    for f in bm.faces:
        mn = ob.material_slots[f.material_index].name if ob.material_slots else ""
        t = otile or tiles.get(mn, default)
        n = (mw.to_3x3() @ f.normal).normalized()
        ref = Vector((0, 1, 0)) if abs(n.z) > 0.707 else Vector((0, 0, 1))
        tx = ref.cross(n)
        if tx.length < 1e-6:
            tx = Vector((1, 0, 0))
        tx.normalize()
        bx = n.cross(tx)
        for l in f.loops:
            co = mw @ l.vert.co
            u, v = co.dot(tx) / t, co.dot(bx) / t
            l[uvl].uv = (u * ca - v * sa + ph[0], u * sa + v * ca + ph[1])
    bm.to_mesh(me)
    bm.free()


def uv_second_bake_layer(ob, margin=0.02):
    me = ob.data
    if len(me.uv_layers) < 2:
        me.uv_layers.new(name="UVBake")
    me.uv_layers.active_index = 1
    bpy.ops.object.select_all(action='DESELECT')
    ob.select_set(True)
    bpy.context.view_layer.objects.active = ob
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.uv.smart_project(angle_limit=math.radians(66), island_margin=margin,
                             correct_aspect=True, scale_to_bounds=True)
    bpy.ops.object.mode_set(mode='OBJECT')
    me.uv_layers.active_index = 0
    ob.select_set(False)


# ------------------------------------------------------------------ AO / wear

def build_bvh(objs):
    verts, polys = [], []
    for ob in objs:
        if ob.type != 'MESH':
            continue
        mw = ob.matrix_world
        base = len(verts)
        verts.extend([mw @ v.co for v in ob.data.vertices])
        for p in ob.data.polygons:
            idx = [base + i for i in p.vertices]
            for k in range(1, len(idx) - 1):
                polys.append((idx[0], idx[k], idx[k + 1]))
    return BVHTree.FromPolygons(verts, polys, all_triangles=True, epsilon=0.0)


def _hemi(n, samples, seed):
    up = Vector((0, 0, 1)) if abs(n.z) < 0.9 else Vector((1, 0, 0))
    t = n.cross(up).normalized()
    b = n.cross(t)
    out = []
    ga = math.pi * (3.0 - math.sqrt(5.0))
    for i in range(samples):
        z = (i + 0.5) / samples
        r = math.sqrt(max(0.0, 1.0 - z * z))
        a = ga * (i + seed)
        out.append((t * (r * math.cos(a)) + b * (r * math.sin(a)) + n * z).normalized())
    return out


def compute_ao(occluders, targets, samples=10, dist=0.55, seed=3):
    """Short-ray contact AO. Short ray = creases only, never a global dimmer."""
    bvh = build_bvh(occluders)
    dirs = {}
    for ob in targets:
        me = ob.data
        mw = ob.matrix_world
        nm = mw.to_3x3()
        ao = []
        for v in me.vertices:
            n = (nm @ v.normal).normalized()
            key = (round(n.x, 2), round(n.y, 2), round(n.z, 2))
            d = dirs.get(key)
            if d is None:
                d = _hemi(n, samples, seed)
                dirs[key] = d
            o = (mw @ v.co) + n * 0.004
            hit = 0.0
            for dd in d:
                loc, _, _, t = bvh.ray_cast(o, dd, dist)
                if loc is not None:
                    hit += 1.0 - (t / dist) * 0.55
            ao.append(1.0 - hit / samples)
        ob["_ao"] = ao
    return bvh


def apply_vcolor(ob, fn, name="Col"):
    me = ob.data
    if name not in me.color_attributes:
        me.color_attributes.new(name=name, type='FLOAT_COLOR', domain='POINT')
    ca = me.color_attributes[name]
    mw = ob.matrix_world
    nm = mw.to_3x3()
    ao = ob.get("_ao")
    for i, v in enumerate(me.vertices):
        p = mw @ v.co
        n = (nm @ v.normal).normalized()
        c = fn(p, n, ao[i] if ao else 1.0, ob)
        ca.data[i].color = (c[0], c[1], c[2], 1.0)


def ensure_vcolor(ob, value=(1.0, 1.0, 1.0), name="Col"):
    me = ob.data
    if name not in me.color_attributes:
        me.color_attributes.new(name=name, type='FLOAT_COLOR', domain='POINT')
    ca = me.color_attributes[name]
    for d in ca.data:
        d.color = (*value, 1.0)


# ------------------------------------------------------------------ materials

def img(path, srgb):
    im = bpy.data.images.load(path, check_existing=True)
    im.colorspace_settings.name = 'sRGB' if srgb else 'Non-Color'
    im.alpha_mode = 'NONE'
    return im


def pbr_material(name, texdir, base, metal=0.0, tint=(1, 1, 1),
                 normal_strength=1.0, rough_bias=0.0):
    """The locked zero-export-warning PBR recipe (see module docstring)."""
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    nt.nodes.clear()
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    out.location = (900, 0)
    b = nt.nodes.new("ShaderNodeBsdfPrincipled")
    b.location = (600, 0)
    nt.links.new(b.outputs["BSDF"], out.inputs["Surface"])

    tb = nt.nodes.new("ShaderNodeTexImage")
    tb.image = img(os.path.join(texdir, f"market_{base}_basecolor.png"), True)
    tb.location = (-700, 300)
    src = tb.outputs["Color"]
    if tint != (1, 1, 1):
        mf = nt.nodes.new("ShaderNodeMix")
        mf.data_type = 'RGBA'
        mf.blend_type = 'MULTIPLY'
        mf.inputs["Factor"].default_value = 1.0
        mf.location = (-450, 330)
        nt.links.new(src, mf.inputs[6])
        mf.inputs[7].default_value = (*tint, 1.0)
        src = mf.outputs[2]
    # RULE 2: every material consumes "Col" so COLOR_0 survives export
    ca = nt.nodes.new("ShaderNodeVertexColor")
    ca.layer_name = "Col"
    ca.location = (-450, 100)
    mv = nt.nodes.new("ShaderNodeMix")
    mv.data_type = 'RGBA'
    mv.blend_type = 'MULTIPLY'
    mv.inputs["Factor"].default_value = 1.0
    mv.location = (-200, 300)
    nt.links.new(src, mv.inputs[6])
    nt.links.new(ca.outputs["Color"], mv.inputs[7])
    nt.links.new(mv.outputs[2], b.inputs["Base Color"])

    # RULE 3: ORM linked from ONE socket only (Roughness); metallic constant
    to = nt.nodes.new("ShaderNodeTexImage")
    to.image = img(os.path.join(texdir, f"market_{base}_orm.png"), False)
    to.location = (-700, -120)
    sep = nt.nodes.new("ShaderNodeSeparateColor")
    sep.location = (-450, -120)
    nt.links.new(to.outputs["Color"], sep.inputs["Color"])
    if rough_bias:
        ad = nt.nodes.new("ShaderNodeMath")
        ad.operation = 'ADD'
        ad.inputs[1].default_value = rough_bias
        ad.location = (-200, -120)
        nt.links.new(sep.outputs["Green"], ad.inputs[0])
        nt.links.new(ad.outputs[0], b.inputs["Roughness"])
    else:
        nt.links.new(sep.outputs["Green"], b.inputs["Roughness"])
    b.inputs["Metallic"].default_value = metal

    tn = nt.nodes.new("ShaderNodeTexImage")
    tn.image = img(os.path.join(texdir, f"market_{base}_normal.png"), False)
    tn.location = (-700, -480)
    nmn = nt.nodes.new("ShaderNodeNormalMap")
    nmn.location = (-450, -480)
    nmn.inputs["Strength"].default_value = normal_strength
    nt.links.new(tn.outputs["Color"], nmn.inputs["Color"])
    nt.links.new(nmn.outputs["Normal"], b.inputs["Normal"])
    m["orm_metallic"] = metal
    m["orm_base"] = base
    return m


def plain_material(name, color, rough=0.6, metal=0.0, emit=None, emit_str=0.0,
                   alpha=1.0, use_vcol=True):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    b = nt.nodes["Principled BSDF"]
    b.inputs["Roughness"].default_value = rough
    b.inputs["Metallic"].default_value = metal
    if use_vcol:
        ca = nt.nodes.new("ShaderNodeVertexColor")
        ca.layer_name = "Col"
        ca.location = (-500, 100)
        mv = nt.nodes.new("ShaderNodeMix")
        mv.data_type = 'RGBA'
        mv.blend_type = 'MULTIPLY'
        mv.inputs["Factor"].default_value = 1.0
        mv.location = (-250, 200)
        mv.inputs[6].default_value = (*color, 1.0)
        nt.links.new(ca.outputs["Color"], mv.inputs[7])
        nt.links.new(mv.outputs[2], b.inputs["Base Color"])
    else:
        b.inputs["Base Color"].default_value = (*color, 1.0)
    if emit:
        b.inputs["Emission Color"].default_value = (*emit, 1.0)
        b.inputs["Emission Strength"].default_value = emit_str
    if alpha < 1.0:
        b.inputs["Alpha"].default_value = alpha
        # Blender 4.2+ replaced Material.blend_method with surface_render_method
        if hasattr(m, "surface_render_method"):
            m.surface_render_method = 'BLENDED'
        elif hasattr(m, "blend_method"):
            m.blend_method = 'BLEND'
    return m


def tri_count(objs):
    n = 0
    dg = bpy.context.evaluated_depsgraph_get()
    for ob in objs:
        if ob.type != 'MESH':
            continue
        me = ob.evaluated_get(dg).to_mesh()
        me.calc_loop_triangles()
        n += len(me.loop_triangles)
    return n


def world_bounds(objs):
    mn = [1e9] * 3
    mx = [-1e9] * 3
    for ob in objs:
        if ob.type != 'MESH':
            continue
        for c in ob.bound_box:
            w = ob.matrix_world @ Vector(c)
            for i in range(3):
                mn[i] = min(mn[i], w[i])
                mx[i] = max(mx[i], w[i])
    return mn, mx
