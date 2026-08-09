"""Scene assembly for the Dustgate Clone Vault.

`build_facility` produces the whole enterable asset as Blender objects under
one root, in a named collection, with the cutaway role prefixes the runtime
requires.  It is called identically from the live Blender MCP session (for
visual iteration) and from the headless exporter, so what is iterated on is
exactly what ships.
"""
from __future__ import annotations

import math

import bpy

import cf_interior
import cf_occupant
import cf_props
import cf_screen
import cf_shell
import cf_vat
from cf_geom import Part, make_root, realize
from cf_mat import build_library
from cf_spec import DOOR, PROPS, ROOT_NODE, ROLE_PREFIXES

BUILD_COLLECTION = "CLONE_OPUS5_BUILD"
RIG_COLLECTION = "CLONE_OPUS5_RIG"
REF_COLLECTION = "CLONE_OPUS5_REF"


def ensure_scene(name="CLONE_OPUS5"):
    """Named, isolated scene plus the three working collections."""
    win = getattr(bpy.context, "window", None)
    scene = bpy.data.scenes.get(name) or bpy.data.scenes.new(name)
    if win is not None:
        win.scene = scene
    ours = {BUILD_COLLECTION, RIG_COLLECTION, REF_COLLECTION}
    for child in list(scene.collection.children):
        if child.name not in ours:
            scene.collection.children.unlink(child)
    if bpy.app.background:
        # Headless: nothing in this process is anyone else's.  The
        # factory-startup Cube stays selected in the scene it was born in, and
        # Blender 5.2 `use_selection` export picks it up even though it is not
        # in this view layer -- so it has to be deleted, not merely unlinked.
        # (`bpy.context.window` is NOT None in background Blender 5.2, which is
        # why an earlier window-presence test failed to catch this.)
        keep = set()
        for cn in ours:
            col = bpy.data.collections.get(cn)
            if col is not None:
                keep.update(o.name for o in col.objects)
        for obj in list(bpy.data.objects):
            if obj.name not in keep:
                bpy.data.objects.remove(obj, do_unlink=True)
    else:
        for obj in list(scene.collection.objects):
            bpy.data.objects.remove(obj, do_unlink=True)
    for cn in (BUILD_COLLECTION, RIG_COLLECTION, REF_COLLECTION):
        col = bpy.data.collections.get(cn) or bpy.data.collections.new(cn)
        if cn not in [c.name for c in scene.collection.children]:
            scene.collection.children.link(col)
    scene.unit_settings.system = "METRIC"
    scene.unit_settings.scale_length = 1.0
    return scene


def clear_collection(name):
    col = bpy.data.collections.get(name)
    if col is None:
        return
    for obj in list(col.objects):
        data = obj.data
        bpy.data.objects.remove(obj, do_unlink=True)
        if isinstance(data, bpy.types.Mesh) and data.users == 0:
            bpy.data.meshes.remove(data)
    for mesh in list(bpy.data.meshes):
        if mesh.users == 0:
            bpy.data.meshes.remove(mesh)


def purge_orphans():
    for coll in (bpy.data.meshes, bpy.data.materials, bpy.data.images,
                 bpy.data.actions, bpy.data.armatures):
        for item in list(coll):
            if item.users == 0:
                try:
                    coll.remove(item)
                except Exception:
                    pass


# ─────────────────────────────── assembly ─────────────────────────────────


def build_facility(collection_name=BUILD_COLLECTION, with_occupant=True):
    scene = ensure_scene()
    clear_collection(collection_name)
    col = bpy.data.collections[collection_name]
    mats = build_library(screen_image=cf_screen.make_image(bpy))
    root = make_root(ROOT_NODE, col)

    parts: list[Part] = []

    def P(name, smooth=None):
        part = Part(name)
        parts.append((part, smooth))
        return part

    # ---- shell -----------------------------------------------------------
    ground = P("floor__ground_plate")
    ground_glow = P("floor__ground_accents")
    cf_shell.build_ground(ground)
    cf_shell.build_threshold(ground, ground_glow)

    wleft = P("wall_left__shell")
    wleft_glass = P("wall_left__glazing")
    cf_shell.build_wall_left(wleft, wleft_glass)

    wright = P("wall_right__shell")
    wright_glass = P("wall_right__glazing")
    wright_glow = P("wall_right__accents")
    cf_shell.build_wall_right(wright, wright_glass, wright_glow)

    wback = P("wall_back__shell")
    wback_glass = P("wall_back__glazing")
    tower_upper = P("roof__filtration_tower")
    cf_shell.build_wall_back(wback, wback_glass, tower_upper)

    wfront = P("wall_front__shell")
    wfront_glass = P("wall_front__glazing")
    wfront_glow = P("wall_front__accents")
    cf_shell.build_wall_front(wfront, wfront_glass, wfront_glow)

    bay = P("wall_front__entry_bay")
    bay_glass = P("wall_front__bay_glazing")
    bay_glow = P("wall_front__bay_accents")
    cf_shell.build_entry_bay(bay, bay_glass, bay_glow)

    roof = P("roof__deck_and_plant")
    roof_glass = P("roof__glazing")
    roof_glow = P("roof__accents")
    cf_shell.build_roof(roof, roof_glass, roof_glow)

    # ---- interior --------------------------------------------------------
    cf_interior.build(P)
    cf_vat.build_bank(P, with_occupant=with_occupant)

    # ---- realise ---------------------------------------------------------
    objects = []
    for part, smooth in parts:
        if not part.faces:
            continue
        objects.append(realize(part, mats, root, col, smooth_angle=smooth))

    occupant = None
    if with_occupant:
        occupant = cf_occupant.build_occupant(
            col, mats["CF_skin"], "interior__vat_b_occupant",
            cf_vat.occupant_transform(), yaw_deg=90.0)
        occupant["object"].parent = root
        objects.append(occupant["object"])

    door, leaves = _build_door(mats, root, col)
    objects.append(door)
    objects.extend(leaves)
    create_door_actions(door)

    _validate_names(objects, door)
    tris = sum(p.tri_count for p, _ in parts)
    if occupant is not None:
        tris += occupant["tri_count"]
    return {"scene": scene, "collection": col, "root": root, "materials": mats,
            "objects": objects, "door": door, "occupant": occupant,
            "tri_count": tris}


def _build_door(mats, root, col):
    """`door_slide` is an empty at the closed rest pose; the leaf is its child
    so the runtime slide transform composes exactly as the contract states."""
    node = bpy.data.objects.new(DOOR["node"], None)
    col.objects.link(node)
    node.empty_display_type = "PLAIN_AXES"
    node.empty_display_size = 0.3
    node.parent = root
    cx, cy, cz = DOOR["closed_center"]
    node.location = (cx, -cz, cy)

    leaf = Part(DOOR["leaf_node"])
    glow = Part(DOOR["leaf_node"] + "_accents")
    cf_shell.build_door(leaf, glow)
    leaves = []
    for part in (leaf, glow):
        if part.faces:
            obj = realize(part, mats, node, col)
            obj.parent = node
            leaves.append(obj)
    return node, leaves


def set_key_interpolation(action, interpolation="LINEAR"):
    for fc in getattr(action, "fcurves", []) or []:
        for kp in fc.keyframe_points:
            kp.interpolation = interpolation


def create_translation_action(obj, name, start_loc, end_loc, f0, f1):
    if obj.animation_data is None:
        obj.animation_data_create()
    stale = bpy.data.actions.get(name)
    if stale is not None:
        bpy.data.actions.remove(stale)
    action = bpy.data.actions.new(name)
    try:
        slot = action.slots.new(id_type="OBJECT", name=name)
    except Exception:
        slot = None
    obj.animation_data.action = action
    if slot is not None:
        obj.animation_data.action_slot = slot
    obj.location = start_loc
    obj.keyframe_insert("location", frame=f0)
    obj.location = end_loc
    obj.keyframe_insert("location", frame=f1)
    set_key_interpolation(action)
    obj.location = start_loc
    return action


def create_door_actions(door):
    """Both clips, published as NLA tracks.

    `export_animation_mode="ACTIONS"` only emitted the action that happened to
    be assigned, so the shipped GLB carried `door_close` alone.  One strip per
    track, exported in NLA_TRACKS mode, is the only arrangement that reliably
    yields exactly two named animations.  Keys start at frame 0 because the
    exporter converts frames to seconds as `frame / fps`, which turned a
    1..25 key range into a 0.833 s clip instead of the contracted 0.8 s."""
    axis = DOOR["slide_axis_local"]
    dist = DOOR["slide_distance_m"]
    frames = max(2, int(round(DOOR["clip_duration_s"] * DOOR["fps"])))
    closed = tuple(door.location)
    # logical axis -> blender axis on the node's own local frame
    opened = (closed[0] + axis[0] * dist, closed[1] - axis[2] * dist,
              closed[2] + axis[1] * dist)
    scene = bpy.context.scene
    scene.render.fps = DOOR["fps"]
    scene.frame_start = 0
    scene.frame_end = frames
    a_open = create_translation_action(door, "door_open", closed, opened, 0, frames)
    a_close = create_translation_action(door, "door_close", opened, closed, 0, frames)

    ad = door.animation_data
    ad.action = None
    for track in list(ad.nla_tracks):
        ad.nla_tracks.remove(track)
    for name, action in (("door_open", a_open), ("door_close", a_close)):
        action.use_fake_user = True
        track = ad.nla_tracks.new()
        track.name = name
        strip = track.strips.new(name, 0, action)
        strip.name = name
        slots = getattr(action, "slots", None)
        if slots:
            try:
                strip.action_slot = slots[0]
            except Exception:
                pass
    # Both tracks evaluated at frame 0 would blend to the OPEN pose, which is
    # how the first render pass showed an open portal at rest.  NLA is switched
    # off for authoring and switched back on only for the export call.
    ad.use_nla = False
    scene.frame_set(0)
    door.location = closed
    return closed, opened


def _validate_names(objects, door):
    bad = [o.name for o in objects
           if o is not door
           and not o.name.startswith(ROLE_PREFIXES)
           and not o.name.startswith(DOOR["leaf_node"])]
    if bad:
        raise RuntimeError(f"objects missing a cutaway role prefix: {bad}")
    if door.name != DOOR["node"]:
        raise RuntimeError("door node name drifted")


# ──────────────────────────── standalone props ────────────────────────────


def build_prop(kind: str, collection_name=BUILD_COLLECTION):
    """One canonical world prop per call, in its own clean collection."""
    scene = ensure_scene()
    clear_collection(collection_name)
    col = bpy.data.collections[collection_name]
    mats = build_library(screen_image=cf_screen.make_image(bpy))
    spec = PROPS[kind]
    root = make_root(spec["root_node"], col)

    if kind == "clone_pod":
        solid = Part("clone_pod__body")
        glass = Part("clone_pod__canopy")
        fluid = Part("clone_pod__fluid")
        glow = Part("clone_pod__accents")
        cf_props.build_clone_pod(solid, glass, fluid, glow)
        parts = [solid, glass, fluid, glow]
    elif kind == "clone_terminal":
        solid = Part("clone_terminal__body")
        screen = Part("clone_terminal__screen")
        glow = Part("clone_terminal__accents")
        cf_props.build_clone_terminal(solid, screen, glow)
        parts = [solid, screen, glow]
    else:
        raise ValueError(kind)

    objects = [realize(p, mats, root, col) for p in parts if p.faces]
    return {"scene": scene, "collection": col, "root": root, "materials": mats,
            "objects": objects, "kind": kind, "spec": spec,
            "tri_count": sum(p.tri_count for p in parts)}
