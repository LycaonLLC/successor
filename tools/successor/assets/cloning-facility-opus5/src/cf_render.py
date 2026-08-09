"""Checkpoint and proof rendering for the Dustgate Clone Vault.

Two modes:
  * `checkpoint` — EEVEE, small, fast, driven live over the Blender MCP bridge
    while the asset is being shaped;
  * `proof` — the delivered evidence set, same rig at a higher sample count.

The camera rig speaks LOGICAL coordinates (+Z front) so camera notes in the
iteration log match the numbers in `cf_spec`.
"""
from __future__ import annotations

import math
from pathlib import Path

import bpy
from mathutils import Matrix, Vector

from cf_spec import PAWN_HEIGHT_M

RIG_COLLECTION = "CLONE_OPUS5_RIG"


def _l2b(v):
    return Vector((v[0], -v[2], v[1]))


def look_at(location, target, up=(0.0, 0.0, 1.0)):
    loc = Vector(location)
    fwd = (Vector(target) - loc).normalized()
    up_hint = Vector(up)
    if abs(fwd.dot(up_hint)) > 0.999:
        up_hint = Vector((0.0, 1.0, 0.0))
    right = fwd.cross(up_hint).normalized()
    upv = right.cross(fwd).normalized()
    return Matrix(((right.x, upv.x, -fwd.x, loc.x),
                   (right.y, upv.y, -fwd.y, loc.y),
                   (right.z, upv.z, -fwd.z, loc.z),
                   (0.0, 0.0, 0.0, 1.0)))


def camera(name, loc_logical, target_logical, lens=42.0, ortho=None, collection=None):
    old = bpy.data.objects.get(name)
    if old is not None:
        data = old.data
        bpy.data.objects.remove(old, do_unlink=True)
        if data.users == 0:
            bpy.data.cameras.remove(data)
    cam_data = bpy.data.cameras.new(name)
    if ortho is not None:
        cam_data.type = "ORTHO"
        cam_data.ortho_scale = ortho
    else:
        cam_data.lens = lens
    cam_data.clip_start = 0.05
    cam_data.clip_end = 220.0
    cam = bpy.data.objects.new(name, cam_data)
    (collection or bpy.context.scene.collection).objects.link(cam)
    cam.matrix_world = look_at(_l2b(loc_logical), _l2b(target_logical))
    return cam


VIEWS = {
    # name: (eye, target, lens/ortho)
    "01_front_three_quarter": ((10.4, 5.6, 12.2), (0.1, 1.7, 0.0), 46.0),
    "02_rear_three_quarter": ((-9.8, 6.1, -11.4), (-0.2, 1.9, -0.3), 46.0),
    "03_front_elevation": ((0.85, 2.35, 17.5), (0.85, 2.10, 0.0), 40.0),
    "04_left_flank": ((-14.6, 4.4, 2.2), (-0.4, 1.9, -0.2), 50.0),
    "05_right_flank": ((14.8, 4.6, -1.4), (0.4, 1.9, -0.2), 50.0),
    "06_door_closed": ((2.6, 1.75, 8.4), (0.85, 1.45, 3.6), 45.0),
    "07_door_open": ((2.6, 1.75, 8.4), (0.85, 1.45, 3.6), 45.0),
    "10_interior_wide": ((3.35, 2.62, 2.62), (-2.6, 1.15, -1.35), 24.0),
    "11_interior_from_door": ((0.85, 1.62, 2.55), (-2.9, 1.35, -0.7), 22.0),
    "12_vat_empty_close": ((-0.10, 1.86, 3.05), (-3.55, 1.30, 1.52), 40.0),
    "13_vat_occupied_close": ((-0.35, 1.72, 1.55), (-3.62, 1.24, 0.00), 40.0),
    "14_terminal_close": ((1.35, 1.72, 1.30), (3.55, 1.20, -0.55), 40.0),
    "15_control_bank": ((0.20, 1.90, -1.15), (4.15, 1.55, -0.55), 26.0),
    "16_process_wall": ((0.60, 1.85, 0.90), (-0.60, 1.15, -3.10), 26.0),
    "30_occupant_front": ((0.10, 1.40, 0.00), (-3.66, 1.40, 0.00), 38.0),
    "31_occupant_side": ((-3.66, 1.40, 3.70), (-3.66, 1.40, 0.00), 38.0),
    "20_topdown_cutaway": ((0.0, 17.0, 0.001), (0.0, 0.0, 0.0), None),
    "21_gameplay_ortho": ((7.6, 8.6, 9.4), (0.0, 1.5, -0.1), None),
}
ORTHO_SCALE = {"20_topdown_cutaway": 10.4, "21_gameplay_ortho": 13.6}


def setup_scene(scene, samples=48, resolution=(1280, 960), night=False,
                film_transparent=False):
    try:
        scene.render.engine = "BLENDER_EEVEE_NEXT"
    except TypeError:
        scene.render.engine = "BLENDER_EEVEE"
    ee = getattr(scene, "eevee", None)
    if ee is not None:
        for attr, value in (("taa_render_samples", samples), ("use_gtao", True),
                            ("use_raytracing", True), ("use_shadows", True),
                            ("use_bloom", True), ("shadow_ray_count", 2),
                            ("fast_gi_method", "GLOBAL_ILLUMINATION")):
            try:
                setattr(ee, attr, value)
            except Exception:
                pass
    scene.render.resolution_x, scene.render.resolution_y = resolution
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGB"
    scene.render.film_transparent = film_transparent
    scene.view_settings.view_transform = "AgX"
    scene.view_settings.look = "AgX - Base Contrast"
    scene.view_settings.exposure = 0.35 if not night else 1.05
    return scene


def render(scene, cam, path: Path):
    path.parent.mkdir(parents=True, exist_ok=True)
    scene.camera = cam
    scene.render.filepath = str(path)
    bpy.ops.render.render(write_still=True)
    return path


def build_ground_plane(collection, size=90.0):
    name = "CF_RIG_GROUND"
    old = bpy.data.objects.get(name)
    if old is not None:
        bpy.data.objects.remove(old, do_unlink=True)
    mesh = bpy.data.meshes.new(name + "_mesh")
    verts = [(-size, -size, -0.30), (size, -size, -0.30), (size, size, -0.30),
             (-size, size, -0.30)]
    mesh.from_pydata(verts, [], [(0, 1, 2, 3)])
    mesh.update()
    mat = bpy.data.materials.get("CF_RIG_SAND") or bpy.data.materials.new("CF_RIG_SAND")
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes["Principled BSDF"]
    bsdf.inputs["Base Color"].default_value = (0.36, 0.30, 0.22, 1.0)
    bsdf.inputs["Roughness"].default_value = 0.95
    mesh.materials.append(mat)
    obj = bpy.data.objects.new(name, mesh)
    collection.objects.link(obj)
    return obj


def build_scale_figure(collection, x, z, height=PAWN_HEIGHT_M, name="CF_RIG_STAFF"):
    """Striped survey staff at exactly one pawn height: the render-only scale
    witness.  Never exported."""
    old = bpy.data.objects.get(name)
    if old is not None:
        bpy.data.objects.remove(old, do_unlink=True)
    verts, faces, mats = [], [], []
    bands = 7
    dark = bpy.data.materials.get("CF_RIG_DARK") or bpy.data.materials.new("CF_RIG_DARK")
    dark.use_nodes = True
    dark.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (0.05, 0.05, 0.05, 1)
    light = bpy.data.materials.get("CF_RIG_LIGHT") or bpy.data.materials.new("CF_RIG_LIGHT")
    light.use_nodes = True
    light.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (0.94, 0.9, 0.84, 1)
    r = 0.045
    for i in range(bands):
        y0 = height * i / bands
        y1 = height * (i + 1) / bands
        base = len(verts)
        for (dx, dz) in ((-r, -r), (r, -r), (r, r), (-r, r)):
            verts.append((x + dx, z + dz, y0))
        for (dx, dz) in ((-r, -r), (r, -r), (r, r), (-r, r)):
            verts.append((x + dx, z + dz, y1))
        for a, b in ((0, 1), (1, 2), (2, 3), (3, 0)):
            faces.append((base + a, base + b, base + 4 + b, base + 4 + a))
            mats.append(i % 2)
        faces.append((base + 4, base + 5, base + 6, base + 7))
        mats.append(i % 2)
    mesh = bpy.data.meshes.new(name + "_mesh")
    mesh.from_pydata(verts, [], faces)
    mesh.update()
    mesh.materials.append(dark)
    mesh.materials.append(light)
    for poly, m in zip(mesh.polygons, mats):
        poly.material_index = m
    obj = bpy.data.objects.new(name, mesh)
    collection.objects.link(obj)
    return obj


def hide_prefixes(root, prefixes, hidden=True):
    for obj in root.children_recursive:
        if any(obj.name.startswith(p) for p in prefixes):
            obj.hide_render = hidden
            obj.hide_viewport = hidden


def show_all(root):
    for obj in root.children_recursive:
        obj.hide_render = False
        obj.hide_viewport = False


# Where the 1.725 m witness staff stands for each view.  Absent = hidden: a
# scale witness that is not in frame is just noise in the evidence.
STAFF_AT = {
    "01_front_three_quarter": (2.95, 4.70),
    "02_rear_three_quarter": (-3.10, -4.70),
    "03_front_elevation": (3.30, 4.60),
    "04_left_flank": (-5.60, 1.20),
    "05_right_flank": (5.60, -1.20),
    "06_door_closed": (2.55, 4.35),
    "07_door_open": (2.55, 4.35),
    "10_interior_wide": (-1.35, 0.35),
    "11_interior_from_door": (-1.55, 0.95),
    "12_vat_empty_close": (-2.55, 2.35),
    "13_vat_occupied_close": (-2.52, -0.86),
    "14_terminal_close": (2.30, -0.50),
    "21_gameplay_ortho": (3.10, 4.60),
}


def set_ref(staff, view_key):
    at = STAFF_AT.get(view_key)
    hidden = at is None
    staff.hide_render = hidden
    staff.hide_viewport = hidden
    if at is not None:
        staff.location = (at[0], -at[1], 0.0)
