"""Mesh / UV / weathering / export helpers for the market generator.

Blender authoring space: +X east, +Y north, +Z up. The public front is -Y,
which the glTF Y-up conversion turns into the required +Z front.
"""
import math
import os

import bmesh
import bpy
from mathutils import Vector
from mathutils.bvhtree import BVHTree

SCENE_OBJS = []
LOD_BEVEL = 1.0   # 0 disables bevels for coarse LODs
LOD_NSCALE = 1.0  # cylinder segment scale


def clear():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    SCENE_OBJS.clear()
    sc = bpy.context.scene
    sc.unit_settings.system = 'METRIC'
    sc.unit_settings.scale_length = 1.0
    sc.render.fps = 30


def _finish(name, bm, mat, bev, seg, lod, group):
    me = bpy.data.meshes.new(name)
    bev = bev * LOD_BEVEL
    if bev and bev > 0:
        edges = [e for e in bm.edges if len(e.link_faces) == 2
                 and e.calc_face_angle(0.0) > math.radians(28)]
        if edges:
            bmesh.ops.bevel(bm, geom=edges, offset=bev, offset_type='OFFSET',
                            segments=seg, profile=0.5, affect='EDGES',
                            clamp_overlap=True, miter_outer='SHARP')
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(me)
    bm.free()
    ob = bpy.data.objects.new(name, me)
    if mat:
        me.materials.append(mat)
    bpy.context.scene.collection.objects.link(ob)
    ob["lod"] = lod
    ob["group"] = group
    SCENE_OBJS.append(ob)
    return ob


def box(name, mat, c, s, bev=0.0, seg=1, lod=0, group=""):
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    bmesh.ops.scale(bm, vec=Vector(s), verts=bm.verts)
    bmesh.ops.translate(bm, vec=Vector(c), verts=bm.verts)
    return _finish(name, bm, mat, bev, seg, lod, group)


def prism(name, mat, pts, axis, a, b, bev=0.0, seg=1, lod=0, group=""):
    """Extrude a 2D polygon along `axis` (0=X,1=Y,2=Z) from a to b.

    pts are the coordinates in the two remaining axes, in ascending axis order
    (axis 0 -> (y,z); axis 1 -> (x,z); axis 2 -> (x,y)), ordered counter-clockwise.
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
    return _finish(name, bm, mat, bev, seg, lod, group)


def cyl(name, mat, c, r, h, axis=2, n=16, bev=0.0, lod=0, group="", r2=None):
    n = max(6, int(round(n * LOD_NSCALE)))
    bm = bmesh.new()
    if r2 is None:
        bmesh.ops.create_cone(bm, cap_ends=True, cap_tris=False, segments=n,
                              radius1=r, radius2=r, depth=h)
    else:
        bmesh.ops.create_cone(bm, cap_ends=True, cap_tris=False, segments=n,
                              radius1=r, radius2=r2, depth=h)
    if axis == 0:
        bmesh.ops.rotate(bm, verts=bm.verts,
                         matrix=__import__("mathutils").Matrix.Rotation(math.pi / 2, 3, 'Y'))
    elif axis == 1:
        bmesh.ops.rotate(bm, verts=bm.verts,
                         matrix=__import__("mathutils").Matrix.Rotation(math.pi / 2, 3, 'X'))
    bmesh.ops.translate(bm, vec=Vector(c), verts=bm.verts)
    return _finish(name, bm, mat, bev, 1, lod, group)


def wall(name, mat, axis, lo, hi, u0, u1, z0, z1, openings=(), bev=0.0, lod=0,
         group="", batter=0.0):
    """Rectangular wall panel with rectangular openings, emitted as solid segments.

    axis: 0 -> wall spans Y (a west/east wall at X in [lo,hi]); u is Y.
          1 -> wall spans X (a south/north wall at Y in [lo,hi]); u is X.
    batter: outer face inward lean over the full height (metres), applied to the
    face at `lo` when axis==1 and Y<0, otherwise to the outward face.
    """
    segs = []
    cuts = sorted(openings, key=lambda o: o[0])
    x = u0
    for (a, b, c, d) in cuts:
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
                           (hi - lo, b - a, d - c), bev, 1, lod, group))
        else:
            out.append(box(nm, mat, ((a + b) / 2, (lo + hi) / 2, (c + d) / 2),
                           (b - a, hi - lo, d - c), bev, 1, lod, group))
    return out


def join(objs, name, lod=0, group=""):
    objs = [o for o in objs if o and o.name in bpy.data.objects]
    if not objs:
        return None
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    bpy.ops.object.join()
    ob = bpy.context.view_layer.objects.active
    ob.name = name
    ob.data.name = name
    ob["lod"] = lod
    ob["group"] = group
    for o in objs[1:]:
        if o in SCENE_OBJS:
            SCENE_OBJS.remove(o)
    bpy.ops.object.select_all(action='DESELECT')
    return ob


# ------------------------------------------------------------------ UV / bake

def uv_box_project(ob, tiles, default=2.5):
    """World-aligned box projection: identical texel density on every surface."""
    me = ob.data
    bm = bmesh.new()
    bm.from_mesh(me)
    uvl = bm.loops.layers.uv.verify()
    mw = ob.matrix_world
    for f in bm.faces:
        mn = ob.material_slots[f.material_index].name if ob.material_slots else ""
        t = tiles.get(mn, default)
        n = f.normal
        ax = max(range(3), key=lambda i: abs(n[i]))
        for l in f.loops:
            co = mw @ l.vert.co
            if ax == 0:
                u, v = (co.y if n.x < 0 else -co.y), co.z
            elif ax == 1:
                u, v = (-co.x if n.y < 0 else co.x), co.z
            else:
                u, v = co.x, (co.y if n.z > 0 else -co.y)
            l[uvl].uv = (u / t, v / t)
    bm.to_mesh(me)
    bm.free()


def uv_second_bake_layer(ob, margin=0.02):
    """Non-overlapping UV1 for future lightmap / AO bakes."""
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


def build_bvh(objs):
    verts, polys = [], []
    for ob in objs:
        mw = ob.matrix_world
        me = ob.data
        base = len(verts)
        verts.extend([mw @ v.co for v in me.vertices])
        for p in me.polygons:
            idx = [base + i for i in p.vertices]
            for k in range(1, len(idx) - 1):
                polys.append((idx[0], idx[k], idx[k + 1]))
    return BVHTree.FromPolygons(verts, polys, all_triangles=True, epsilon=0.0)


def _hemi(n, samples, seed):
    """Deterministic cosine-ish hemisphere directions around n."""
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


def compute_ao(objs, targets, samples=14, dist=1.1, seed=3):
    """Ray-traced ambient occlusion per vertex, written to obj['_ao'] lists."""
    bvh = build_bvh(objs)
    for ob in targets:
        me = ob.data
        mw = ob.matrix_world
        ao = []
        for v in me.vertices:
            p = mw @ v.co
            n = (mw.to_3x3() @ v.normal).normalized()
            o = p + n * 0.004
            hit = 0
            for d in _hemi(n, samples, seed):
                loc, _, _, dd = bvh.ray_cast(o, d, dist)
                if loc is not None:
                    hit += 1 - (dd / dist) * 0.55
            ao.append(1.0 - (hit / samples))
        ob["_ao"] = ao
    return bvh


def apply_vcolor(ob, fn, name="Col"):
    me = ob.data
    if name not in me.color_attributes:
        me.color_attributes.new(name=name, type='FLOAT_COLOR', domain='POINT')
    ca = me.color_attributes[name]
    mw = ob.matrix_world
    ao = ob.get("_ao")
    for i, v in enumerate(me.vertices):
        p = mw @ v.co
        n = (mw.to_3x3() @ v.normal).normalized()
        c = fn(p, n, ao[i] if ao else 1.0, ob)
        ca.data[i].color = (c[0], c[1], c[2], 1.0)


# ------------------------------------------------------------------ materials

def img(path, srgb):
    im = bpy.data.images.load(path, check_existing=True)
    im.colorspace_settings.name = 'sRGB' if srgb else 'Non-Color'
    im.alpha_mode = 'NONE'
    return im


def gltf_settings_group():
    """Use Blender's own builder so the importer can also read this group back."""
    from io_scene_gltf2.blender.com.material_helpers import (
        create_settings_group, get_gltf_node_name)
    n = get_gltf_node_name()
    if n in bpy.data.node_groups:
        return bpy.data.node_groups[n]
    return create_settings_group(n)


def pbr_material(name, texdir, base, factor=(1, 1, 1), rough_mul=1.0, metal_mul=1.0,
                 use_vcol=True, normal_strength=1.0):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    nt.nodes.clear()
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    out.location = (900, 0)
    bsdf = nt.nodes.new("ShaderNodeBsdfPrincipled")
    bsdf.location = (600, 0)
    nt.links.new(bsdf.outputs["BSDF"], out.inputs["Surface"])

    tb = nt.nodes.new("ShaderNodeTexImage")
    tb.image = img(os.path.join(texdir, f"market_{base}_basecolor.png"), True)
    tb.location = (-600, 300)
    src = tb.outputs["Color"]
    if factor != (1, 1, 1):
        mf = nt.nodes.new("ShaderNodeMix")
        mf.data_type = 'RGBA'
        mf.blend_type = 'MULTIPLY'
        mf.inputs["Factor"].default_value = 1.0
        mf.location = (-350, 320)
        nt.links.new(src, mf.inputs[6])
        mf.inputs[7].default_value = (*factor, 1.0)
        src = mf.outputs[2]
    if use_vcol:
        ca = nt.nodes.new("ShaderNodeVertexColor")
        ca.layer_name = "Col"
        ca.location = (-350, 120)
        mv = nt.nodes.new("ShaderNodeMix")
        mv.data_type = 'RGBA'
        mv.blend_type = 'MULTIPLY'
        mv.inputs["Factor"].default_value = 1.0
        mv.location = (-120, 300)
        nt.links.new(src, mv.inputs[6])
        nt.links.new(ca.outputs["Color"], mv.inputs[7])
        src = mv.outputs[2]
    nt.links.new(src, bsdf.inputs["Base Color"])

    to = nt.nodes.new("ShaderNodeTexImage")
    to.image = img(os.path.join(texdir, f"market_{base}_orm.png"), False)
    to.location = (-600, -100)
    sep = nt.nodes.new("ShaderNodeSeparateColor")
    sep.location = (-350, -100)
    nt.links.new(to.outputs["Color"], sep.inputs["Color"])
    if rough_mul != 1.0:
        mr = nt.nodes.new("ShaderNodeMath")
        mr.operation = 'MULTIPLY'
        mr.inputs[1].default_value = rough_mul
        mr.location = (-120, -60)
        nt.links.new(sep.outputs["Green"], mr.inputs[0])
        nt.links.new(mr.outputs[0], bsdf.inputs["Roughness"])
    else:
        nt.links.new(sep.outputs["Green"], bsdf.inputs["Roughness"])
    if metal_mul != 1.0:
        mm = nt.nodes.new("ShaderNodeMath")
        mm.operation = 'MULTIPLY'
        mm.inputs[1].default_value = metal_mul
        mm.location = (-120, -180)
        nt.links.new(sep.outputs["Blue"], mm.inputs[0])
        nt.links.new(mm.outputs[0], bsdf.inputs["Metallic"])
    else:
        nt.links.new(sep.outputs["Blue"], bsdf.inputs["Metallic"])

    tn = nt.nodes.new("ShaderNodeTexImage")
    tn.image = img(os.path.join(texdir, f"market_{base}_normal.png"), False)
    tn.location = (-600, -450)
    nm = nt.nodes.new("ShaderNodeNormalMap")
    nm.location = (-350, -450)
    nm.inputs["Strength"].default_value = normal_strength
    nt.links.new(tn.outputs["Color"], nm.inputs["Color"])
    nt.links.new(nm.outputs["Normal"], bsdf.inputs["Normal"])

    gs = nt.nodes.new("ShaderNodeGroup")
    gs.node_tree = gltf_settings_group()
    gs.location = (600, -420)
    nt.links.new(sep.outputs["Red"], gs.inputs["Occlusion"])
    return m


def plain_material(name, color, rough=0.6, metal=0.0, emit=None, emit_str=0.0,
                   alpha=1.0):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    b = nt.nodes["Principled BSDF"]
    b.inputs["Base Color"].default_value = (*color, 1.0)
    b.inputs["Roughness"].default_value = rough
    b.inputs["Metallic"].default_value = metal
    if emit:
        b.inputs["Emission Color"].default_value = (*emit, 1.0)
        b.inputs["Emission Strength"].default_value = emit_str
    if alpha < 1.0:
        b.inputs["Alpha"].default_value = alpha
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
