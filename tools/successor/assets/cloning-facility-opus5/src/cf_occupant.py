"""The occupied vat's specimen, derived from the approved humanoid source.

Source (read-only): `client-3d/public/assets/pawn-pack/pawn_male.glb` from the
`successor-humanoid-runtime-refit-20260802` worktree.  The rig is used ONLY to
pose the mesh; the armature, its 47 clips and the pawn's own materials are
discarded before the result is merged, so the building ships a static mesh and
never inherits a runtime skeleton.

Pose intent: neutral suspension.  Feet together and pointed, knees fractionally
soft, arms hanging a little away from the body, forearms turned in, head tipped
back into the cranial cradle.  Nothing heroic and nothing agonised — a body
that is being grown, not a character doing something.
"""
from __future__ import annotations

import math
from pathlib import Path

import bpy
from mathutils import Matrix, Vector

from cf_spec import PAWN_MESH_HEIGHT_M

SOURCE_GLB = Path("/home/lycaon/dev/worktrees/successor-humanoid-runtime-refit-20260802"
                  "/client-3d/public/assets/pawn-pack/pawn_male.glb")

# bone, (axis, degrees) ... applied parent-first so the chain compounds
# naturally.  `side` flips the frontal-plane sign for mirrored limbs.
# The source rig's REST pose is an idle stance with a stride and a forward
# stoop, so relative bone offsets fight it instead of replacing it (passes 6-9).
# Every limb below is therefore AIMED at an absolute direction in armature
# space: Blender +Z is up and the pawn faces -Y, so -Y is "forward" and the
# table reads as a plain description of the pose regardless of what the rig
# shipped with.  `s` is +1 for the limb on the +X side and -1 for its mirror,
# resolved from the rest skeleton rather than from the bone suffix.
AIM = {
    "spine_01":   (0.00, -0.02, 1.00),
    "spine_03":   (0.00, -0.01, 1.00),
    "neck_01":    (0.00,  0.03, 1.00),
    "head":       (0.00,  0.10, 0.99),      # chin up into the cranial cradle
    "upperarm":   (0.34, -0.12, -0.93),     # abducted, drifting forward
    "lowerarm":   (0.20, -0.40, -0.89),     # soft elbow, hands ahead of the hips
    "hand":       (0.14, -0.44, -0.89),
    "thigh":      (0.07,  0.00, -1.00),     # legs together, hanging
    "calf":       (0.04,  0.11, -0.99),     # knees a touch soft, bending back
    "foot":       (0.03, -0.52, -0.85),     # toes hang down
}

# Finger curl stays RELATIVE, about the knuckle axis measured off the rig: the
# phalanges point four different ways, so one world axis shears them apart.
FINGER_CURL = 14.0

def _rotate(pbone, axis, degrees: float):
    """Rotate a pose bone about a WORLD axis, expressed in its rest frame.

    Doing it this way means the pose table reads in anatomical terms (`x` is
    the sagittal axis, `y` the frontal one) instead of in whatever local axis
    convention the imported rig happens to carry.
    """
    if isinstance(axis, str):
        vec = {"x": Vector((1, 0, 0)), "y": Vector((0, 1, 0)),
               "z": Vector((0, 0, 1))}[axis]
    else:
        vec = Vector(axis).normalized()
    world = Matrix.Rotation(math.radians(degrees), 3, vec)
    rest = pbone.bone.matrix_local.to_3x3()
    basis = rest.inverted() @ world @ rest
    pbone.rotation_mode = "QUATERNION"
    pbone.rotation_quaternion = (pbone.rotation_quaternion.to_matrix()
                                 @ basis).to_quaternion()


def _import_source(collection):
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=str(SOURCE_GLB))
    fresh = [o for o in bpy.data.objects if o not in before]
    body = next((o for o in fresh if o.type == "MESH" and o.name.startswith("body")), None)
    rig = next((o for o in fresh if o.type == "ARMATURE"), None)
    if body is None or rig is None:
        raise RuntimeError("pawn_male.glb did not yield a body mesh and an armature")
    for o in fresh:
        if o not in (body, rig):
            bpy.data.objects.remove(o, do_unlink=True)
    for o in (body, rig):
        for col in list(o.users_collection):
            col.objects.unlink(o)
        collection.objects.link(o)
    return body, rig


def _aim(rig, pbone, direction):
    """Aim a posed bone at an ABSOLUTE armature-space direction."""
    bpy.context.view_layer.update()
    cur = (pbone.tail - pbone.head)
    if cur.length < 1e-6:
        return
    q = cur.normalized().rotation_difference(Vector(direction).normalized())
    head = pbone.matrix.translation.copy()
    pbone.matrix = (Matrix.Translation(head) @ q.to_matrix().to_4x4()
                    @ Matrix.Translation(-head) @ pbone.matrix)
    bpy.context.view_layer.update()


def _apply_pose(rig):
    bpy.context.view_layer.objects.active = rig
    bpy.ops.object.mode_set(mode="POSE")
    for name in ("spine_01", "spine_03", "neck_01", "head"):
        pbone = rig.pose.bones.get(name)
        if pbone is not None:
            _aim(rig, pbone, AIM[name])
    for limb in ("upperarm", "lowerarm", "hand", "thigh", "calf", "foot"):
        for suffix in ("l", "r"):
            pbone = rig.pose.bones.get(f"{limb}_{suffix}")
            if pbone is None:
                continue
            side = 1.0 if pbone.bone.head_local.x >= 0.0 else -1.0
            dx, dy, dz = AIM[limb]
            _aim(rig, pbone, (dx * side, dy, dz))
    _curl_fingers(rig)
    bpy.ops.object.mode_set(mode="OBJECT")


def _curl_fingers(rig):
    for side in ("l", "r"):
        index = rig.pose.bones.get(f"index_01_{side}")
        pinky = rig.pose.bones.get(f"pinky_01_{side}")
        if index is None or pinky is None:
            continue
        knuckle = (pinky.bone.head_local - index.bone.head_local)
        if knuckle.length < 1e-5:
            continue
        knuckle = knuckle.normalized()
        palm = (index.bone.tail_local - index.bone.head_local).normalized()
        sign = 1.0 if palm.cross(knuckle).z < 0 else -1.0
        for finger in ("index", "middle", "ring", "pinky"):
            for seg, gain in (("01", 1.0), ("02", 1.4), ("03", 1.1)):
                pbone = rig.pose.bones.get(f"{finger}_{seg}_{side}")
                if pbone is not None:
                    _rotate(pbone, knuckle, sign * FINGER_CURL * gain)
        for seg, gain in (("01", 0.8), ("02", 1.0)):
            pbone = rig.pose.bones.get(f"thumb_{seg}_{side}")
            if pbone is not None:
                _rotate(pbone, knuckle, sign * FINGER_CURL * gain * 0.55)


def _freeze(body, rig, material):
    bpy.ops.object.select_all(action="DESELECT")
    body.select_set(True)
    bpy.context.view_layer.objects.active = body
    for mod in list(body.modifiers):
        if mod.type == "ARMATURE":
            bpy.ops.object.modifier_apply(modifier=mod.name)
        else:
            body.modifiers.remove(mod)
    body.parent = None
    body.matrix_world = Matrix.Identity(4)
    if body.vertex_groups:
        body.vertex_groups.clear()
    body.data.materials.clear()
    body.data.materials.append(material)
    for poly in body.data.polygons:
        poly.material_index = 0
    if body.animation_data:
        body.animation_data_clear()
    bpy.data.objects.remove(rig, do_unlink=True)
    return body


def purge_source_actions(keep=("door_open", "door_close")):
    for action in list(bpy.data.actions):
        if action.name not in keep:
            bpy.data.actions.remove(action)
    for arm in list(bpy.data.armatures):
        if arm.users == 0:
            bpy.data.armatures.remove(arm)


def build_occupant(collection, material, name, position, yaw_deg=0.0,
                   height_m=PAWN_MESH_HEIGHT_M):
    """Posed, frozen, correctly scaled specimen standing at `position`.

    `position` is the LOGICAL point the soles rest on (x, y, z)."""
    body, rig = _import_source(collection)
    _apply_pose(rig)
    body = _freeze(body, rig, material)

    bpy.context.view_layer.update()
    lo = Vector((1e9, 1e9, 1e9))
    hi = Vector((-1e9, -1e9, -1e9))
    for v in body.data.vertices:
        lo = Vector((min(lo[i], v.co[i]) for i in range(3)))
        hi = Vector((max(hi[i], v.co[i]) for i in range(3)))
    raw_height = hi.z - lo.z
    scale = height_m / raw_height
    cx = (lo.x + hi.x) * 0.5
    cy = (lo.y + hi.y) * 0.5

    # centre on the vat axis, sole to the foot plate, then place (logical ->
    # blender is (x, -z, y))
    body.data.transform(Matrix.Translation((-cx, -cy, -lo.z)) )
    body.data.transform(Matrix.Diagonal((scale, scale, scale, 1.0)))
    body.data.transform(Matrix.Rotation(math.radians(yaw_deg), 4, "Z"))
    body.location = (position[0], -position[2], position[1])
    body.name = name
    body.data.name = name + "_mesh"
    purge_source_actions()

    bpy.context.view_layer.update()
    return {"object": body, "raw_height_m": raw_height, "scale": scale,
            "height_m": height_m,
            "tri_count": sum(len(p.vertices) - 2 for p in body.data.polygons)}
