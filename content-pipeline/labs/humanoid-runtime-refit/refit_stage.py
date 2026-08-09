"""Blender scene assembly shared by the refit and its proof renders.

One place that knows how to put a runtime body, an outfit and a pose in front of
a camera, so the fitting step and the evidence step cannot drift apart. Lighting
and framing follow the humanoid adjustment lab's conventions -- same three-area
key/fill/rim rig, same dark neutral world -- because the approved bodies were
reviewed under exactly that light.
"""

from __future__ import annotations

import math
import os
import sys

import bpy
from mathutils import Vector

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import refit_config as CFG  # noqa: E402

VIEWS = {
    "front": (0.0, 4.0),
    "threequarter": (35.0, 10.0),
    "side": (90.0, 4.0),
    "back": (180.0, 4.0),
}

# Close crops the brief names: every place apparel touches the body.
CROPS = {
    "neck_head": ((0.0, 0.0, 1.62), 0.62, 20.0, 8.0, 70.0),
    "shoulder_armpit": ((0.20, 0.0, 1.36), 0.66, 40.0, 14.0, 70.0),
    "waist_pelvis": ((0.0, 0.0, 0.95), 0.80, 25.0, 6.0, 70.0),
    "wrist_glove": ((0.80, 0.0, 1.42), 0.55, 15.0, 22.0, 70.0),
    "ankle_boot": ((0.10, 0.0, 0.12), 0.60, 30.0, 14.0, 70.0),
    "back_seam": ((0.0, 0.0, 1.25), 0.95, 180.0, 8.0, 70.0),
}


def purge() -> None:
    bpy.ops.wm.read_factory_settings(use_empty=True)
    for collection in (bpy.data.objects, bpy.data.meshes, bpy.data.armatures,
                       bpy.data.materials, bpy.data.images, bpy.data.actions,
                       bpy.data.cameras, bpy.data.lights):
        for item in list(collection):
            collection.remove(item)


def import_glb(path: str, prefix: str) -> tuple[list, object]:
    """Import one GLB and return (meshes, armature) with prefixed names."""
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=path)
    fresh = [o for o in bpy.data.objects if o not in before]
    meshes, rig = [], None
    for obj in fresh:
        obj.name = f"{prefix}_{obj.name}"
        if obj.type == "MESH":
            meshes.append(obj)
        elif obj.type == "ARMATURE":
            rig = obj
    return meshes, rig


def rest_pose(rig) -> None:
    if rig is None:
        return
    rig.animation_data_clear()
    for bone in rig.pose.bones:
        bone.matrix_basis.identity()
    bpy.context.view_layer.update()


def bind_to(rig, meshes: list) -> None:
    """Re-parent imported apparel onto the body's armature by bone name."""
    for mesh in meshes:
        for modifier in list(mesh.modifiers):
            if modifier.type == "ARMATURE":
                mesh.modifiers.remove(modifier)
        mesh.parent = rig
        mesh.matrix_parent_inverse = rig.matrix_world.inverted()
        modifier = mesh.modifiers.new("Armature", "ARMATURE")
        modifier.object = rig


def apply_action(rig, action, tau: float) -> None:
    """Absolute pose evaluation: rest first, then one frame of `action`."""
    rest_pose(rig)
    if action is None:
        return
    rig.animation_data_create()
    rig.animation_data.action = action
    if hasattr(rig.animation_data, "action_slot") and action.slots:
        rig.animation_data.action_slot = action.slots[0]
    start, end = action.frame_range
    bpy.context.scene.frame_set(int(round(start + tau * (end - start))))
    bpy.context.view_layer.update()


def setup_render(scene, width: int, height: int, samples: int = 64) -> None:
    try:
        scene.render.engine = "BLENDER_EEVEE_NEXT"
    except TypeError:
        scene.render.engine = "BLENDER_EEVEE"
    scene.render.resolution_x = width
    scene.render.resolution_y = height
    scene.render.resolution_percentage = 100
    scene.render.film_transparent = False
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGB"
    scene.render.image_settings.compression = 100
    if hasattr(scene, "eevee"):
        scene.eevee.taa_render_samples = samples
    world = bpy.data.worlds.get("REFIT_WORLD") or bpy.data.worlds.new("REFIT_WORLD")
    world.use_nodes = True
    background = world.node_tree.nodes.get("Background")
    if background:
        # Mid neutral, not black: clipping is judged on contrast between a
        # garment and the skin behind it, and a black void hides both.
        background.inputs[0].default_value = (0.13, 0.135, 0.145, 1.0)
        background.inputs[1].default_value = 1.0
    scene.world = world


def make_lights() -> None:
    specs = (("REFIT_KEY", (2.9, -3.6, 3.1), 800.0, 4.0),
             ("REFIT_FILL", (-3.4, -2.4, 1.6), 320.0, 5.0),
             ("REFIT_RIM", (0.0, 4.0, 3.0), 460.0, 4.0))
    for name, location, power, size in specs:
        obj = bpy.data.objects.get(name)
        if obj is None:
            obj = bpy.data.objects.new(name, bpy.data.lights.new(name, type="AREA"))
            bpy.context.scene.collection.objects.link(obj)
        obj.data.type = "AREA"
        obj.data.size = size
        obj.data.energy = power
        obj.location = location
        direction = (Vector((0.0, 0.0, 1.1)) - Vector(location)).normalized()
        obj.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()


def make_camera():
    camera = bpy.data.objects.get("REFIT_CAM")
    if camera is None:
        camera = bpy.data.objects.new("REFIT_CAM", bpy.data.cameras.new("REFIT_CAM"))
        bpy.context.scene.collection.objects.link(camera)
    bpy.context.scene.camera = camera
    return camera


def aim(camera, target, distance: float, azimuth: float, elevation: float,
        lens: float = 55.0):
    focus = Vector(target)
    a, e = math.radians(azimuth), math.radians(elevation)
    offset = Vector((math.sin(a) * math.cos(e), -math.cos(a) * math.cos(e),
                     math.sin(e))) * distance
    camera.location = focus + offset
    camera.rotation_euler = (focus - camera.location).normalized().to_track_quat("-Z", "Y").to_euler()
    camera.data.lens = lens
    return camera


def render_to(path: str) -> str:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    bpy.context.scene.render.filepath = path
    bpy.ops.render.render(write_still=True)
    return path
