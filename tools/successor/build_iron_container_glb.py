"""Build the iron resource container GLB (itemId 2001 display model).

Owner spec: simple oblong rectangular prism ("a cylinder squared off
completely"), geometric embedded gridlines, uniform iron-symbolizing
material — explicitly NO lettering. Two flat materials (body + recessed
groove frames) keep it crisp under the PS2 grade with zero textures.

Run headless:
  blender -b --python tools/successor/build_iron_container_glb.py

Writes: client-3d/public/assets/world-items/resource_iron.glb
"""

import os

import bmesh
import bpy

# Half-extents: oblong along X (0.60 x 0.36 x 0.28 m box).
HALF_X = 0.30
HALF_Y = 0.18
HALF_Z = 0.14
GROOVE_INSET = 0.016
GROOVE_DEPTH = 0.010

OUT_RELPATH = os.path.join(
    "client-3d", "public", "assets", "world-items", "resource_iron.glb"
)


def repo_root() -> str:
    here = os.path.dirname(os.path.abspath(__file__))
    return os.path.dirname(os.path.dirname(here))


def build() -> None:
    bpy.ops.wm.read_factory_settings(use_empty=True)

    mesh = bpy.data.meshes.new("resource_iron")
    obj = bpy.data.objects.new("resource_iron", mesh)
    bpy.context.scene.collection.objects.link(obj)

    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    for vert in bm.verts:
        vert.co.x *= HALF_X * 2
        vert.co.y *= HALF_Y * 2
        vert.co.z *= HALF_Z * 2

    # Panel grid: two cuts across the long axis -> 3 panel rings, one cut
    # around girth for the squared-cylinder read.
    long_edges = [e for e in bm.edges if abs(e.verts[0].co.x - e.verts[1].co.x) > 1e-6]
    bmesh.ops.subdivide_edges(bm, edges=long_edges, cuts=2, use_grid_fill=False)
    girth_edges = [
        e
        for e in bm.edges
        if abs(e.verts[0].co.x - e.verts[1].co.x) < 1e-6
        and abs(e.verts[0].co.z - e.verts[1].co.z) > 1e-6
        and abs(e.verts[0].co.x) < HALF_X - 1e-4
    ]
    if girth_edges:
        bmesh.ops.subdivide_edges(bm, edges=girth_edges, cuts=1, use_grid_fill=False)

    # Recessed frame per panel = the "geometric embedded gridline".
    result = bmesh.ops.inset_individual(
        bm,
        faces=list(bm.faces),
        thickness=GROOVE_INSET,
        depth=-GROOVE_DEPTH,
        use_even_offset=True,
    )
    # inset_individual RETURNS the newly created rim/frame ring faces (the
    # originals survive as the recessed panel interiors) — proven by face
    # counts: 16 originals vs 68 new ring faces on this box. Panels = body,
    # ring = groove.
    for face in bm.faces:
        face.material_index = 0
    for face in result["faces"]:
        face.material_index = 1

    bm.to_mesh(mesh)
    bm.free()

    body = bpy.data.materials.new("iron_body")
    body.use_nodes = True
    bsdf = body.node_tree.nodes["Principled BSDF"]
    bsdf.inputs["Base Color"].default_value = (0.318, 0.345, 0.398, 1.0)
    bsdf.inputs["Metallic"].default_value = 0.72
    bsdf.inputs["Roughness"].default_value = 0.42

    groove = bpy.data.materials.new("iron_groove")
    groove.use_nodes = True
    gbsdf = groove.node_tree.nodes["Principled BSDF"]
    gbsdf.inputs["Base Color"].default_value = (0.058, 0.064, 0.078, 1.0)
    gbsdf.inputs["Metallic"].default_value = 0.0
    gbsdf.inputs["Roughness"].default_value = 1.0

    mesh.materials.append(body)
    mesh.materials.append(groove)
    for poly in mesh.polygons:
        poly.use_smooth = False
    body_count = sum(1 for p in mesh.polygons if p.material_index == 0)
    print(f"FACES body={body_count} groove={len(mesh.polygons) - body_count}")

    out_path = os.path.join(repo_root(), OUT_RELPATH)
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    bpy.ops.export_scene.gltf(
        filepath=out_path,
        export_format="GLB",
        export_apply=True,
        export_yup=True,
    )
    tri_count = sum(max(0, len(p.vertices) - 2) for p in mesh.polygons)
    print(f"WROTE {out_path} tris={tri_count} materials=2")


build()
