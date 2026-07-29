"""Render the proof packet from the FRESH standalone exports.

    blender -b --factory-startup -P prodproof.py -- all
    blender -b --factory-startup -P prodproof.py -- clone --round r1

Nothing here reads the authoring scene. Every frame is rendered from the GLB
that `prodbuild.py` just wrote, re-imported into a clean scene, so a stale
Blender datablock cannot flatter the result. Instanced world items are loaded
from their own source GLBs at render time and are never merged into the unit.

Per unit the packet contains:

    01_south 02_north 03_east 04_west      cardinal elevations
    05_top   06_three_quarter              plan and three-quarter
    07_gameplay                            the locked north-up 60-degree camera
    08_door_closed 09_door_half 10_door_open
    11_threshold_crop                      transit through the opening
    12_contact_crop                        where the plinth meets sand
    13_detail_crop                         the unit's primary functional read
    14_seam_crop                           the worst topology/seam risk
    15_cutaway                             reveal set hidden, keep set retained
    16_cutaway_gameplay                    the cutaway at gameplay framing
"""

from __future__ import annotations

import json
import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import bpy  # type: ignore
from mathutils import Vector  # type: ignore

import dgkit as dg
import prodkit as pk
import prodbuild as pb
import produnits as pu

REVEAL = pk.REVEAL_SET
RES = 1280

#: Per-unit crop targets: (blender x, y, z, ortho height, label).
CROPS = {
    "clone": {
        "detail": (-4.9, -0.4, 1.9, 5.4, "west pod bank bulging through the wall"),
        "seam": (5.28, -2.2, 3.6, 4.2, "east wall meets the sawtooth riser return"),
    },
    "commerce": {
        "detail": (-1.2, 0.1, 5.0, 6.4, "louvred ridge monitor"),
        "seam": (4.95, 2.4, 3.9, 4.6, "strongroom welded onto the shell"),
    },
    "shelter": {
        "detail": (-3.2, 2.2, 1.2, 3.4, "gutter, downpipe and cistern"),
        "seam": (-2.62, -3.0, 2.4, 3.0, "service-bay corner and patched panel"),
    },
}


# --------------------------------------------------------------------------
# scene assembly from exported artefacts
# --------------------------------------------------------------------------


def import_glb(path: str) -> list[bpy.types.Object]:
    before = set(bpy.context.scene.objects)
    bpy.ops.import_scene.gltf(filepath=path)
    return [o for o in bpy.context.scene.objects if o not in before]


def find_node(objects, name: str):
    for obj in objects:
        if obj.name == name or obj.name.startswith(name + "."):
            return obj
    return None


def place_item(path: str, cx: float, cy: float, yaw_deg: float, floor_z: float):
    """Instance an external item GLB at a structure-local anchor.

    The item keeps its own materials, origin and sockets; the unit never
    absorbs its geometry. It is grounded on the authored floor top, not on the
    Blender origin, because several source items are authored centred."""
    objects = import_glb(path)
    if not objects:
        return []
    roots = [o for o in objects if o.parent is None]
    container = bpy.data.objects.new(f"item_{os.path.basename(path)[:-4]}", None)
    bpy.context.scene.collection.objects.link(container)
    for root in roots:
        root.parent = container
    container.rotation_euler = (0.0, 0.0, math.radians(yaw_deg))
    bpy.context.view_layer.update()
    bounds = dg.world_bounds(objects)
    container.location = (
        cx - (bounds["minX"] + bounds["maxX"]) * 0.5,
        cy - (bounds["minY"] + bounds["maxY"]) * 0.5,
        floor_z - bounds["minZ"],
    )
    bpy.context.view_layer.update()
    return objects


def load_unit(uid: str, with_items: bool, with_proxy: bool):
    dg.reset()
    pk.dressed_scene(ground=True, ground_size=64.0)
    dg.configure_render(res_x=RES, res_y=RES, samples=96)

    glb = pk.prod("glb", f"{uid}_lod0.glb")
    if not os.path.exists(glb):
        raise SystemExit(f"missing export {glb}; run prodbuild.py first")
    objects = import_glb(glb)
    # The importer poses everything on an imported clip; the file's node
    # translations are the contract, so restore them and drop the animation.
    pk.rest_pose_from_glb(glb, objects)
    meshes = [o for o in objects if o.type == "MESH"]

    P = pu.BUILDERS[uid][0]()
    if with_items:
        for item in pb.ITEM_PLAN[uid]:
            _id, path, _lane, _promoted, _fp, _h, (cx, cy), yaw, _role = item
            if os.path.exists(path):
                place_item(path, cx, cy, yaw, pu.FLOOR_TOP)
            else:
                print(f"[prodproof] MISSING item source: {path}")
    if with_proxy:
        # The threshold proxy stands beside the opening, not in it: round 1 put
        # it dead centre and it occluded the whole threshold crop.
        door_cx = (P["door_x0"] + P["door_x1"]) * 0.5
        pk.capsule_proxy(f"proxy_{uid}_threshold",
                         door_cx + (P["door_x1"] - P["door_x0"]) * 0.5 + 1.05,
                         P["front_y"] - 1.3)
        pk.capsule_proxy(f"proxy_{uid}_interior", door_cx,
                         (P["int_y0"] + P["int_y1"]) * 0.5)
    interior_lights(P)
    return P, objects, meshes


def interior_lights(P: dict) -> None:
    """Render-only practical lighting inside the shell.

    The units author emissive task lights, but Blender emission alone does not
    illuminate a room under EEVEE at these sample counts. These lamps stand in
    for the runtime's own interior lighting so the cutaway frames show the room
    that was actually built instead of a black box. They are never exported."""
    x0, x1 = P["int_x0"], P["int_x1"]
    y0, y1 = P["int_y0"], P["int_y1"]
    z = P["int_ceiling"] - 0.25
    for i in range(2):
        for j in range(2):
            lamp = bpy.data.lights.new(f"KIT_interior_{i}{j}", type="AREA")
            lamp.energy = 190.0
            lamp.size = 1.6
            lamp.color = dg.hex_rgb("#ffd9a8")
            obj = bpy.data.objects.new(lamp.name, lamp)
            bpy.context.scene.collection.objects.link(obj)
            obj.location = (x0 + (x1 - x0) * (0.28 + 0.44 * i),
                            y0 + (y1 - y0) * (0.28 + 0.44 * j), z)
            obj.rotation_euler = (0.0, 0.0, 0.0)


def set_door(objects, spec_travel: float, axis_local, t: float) -> None:
    """Pose the reloaded `door_slide` node absolutely, from its closed pose.

    The closed pose is whatever the GLB shipped, captured once per load, so a
    half-open frame can never accumulate from the previous frame."""
    node = find_node(objects, pk.DOOR_NODE)
    if node is None:
        raise SystemExit("door_slide node missing from the export")
    if "dg_closed" not in node:
        node["dg_closed"] = tuple(node.location)
    ax, ay, az = axis_local
    # glTF axis -> Blender axis; the importer already applied the basis change
    # to the geometry, so the drive vector must be converted the same way.
    delta = Vector((ax, -az, ay)) * spec_travel * t
    node.location = Vector(node["dg_closed"]) + delta
    bpy.context.view_layer.update()


def apply_cutaway(objects) -> dict:
    """Hide exactly the shipped reveal set; prove the keep set survives."""
    hidden, kept = [], []
    for obj in objects:
        if obj.type != "MESH":
            continue
        names = []
        node = obj
        while node is not None:
            names.append(node.name)
            node = node.parent
        reveal = any(n.startswith(p) for n in names for p in REVEAL)
        floor = any("floor" in n.lower() for n in names)
        door = any(n.startswith(pk.DOOR_NODE) for n in names)
        if reveal and not floor and not door:
            obj.hide_render = True
            hidden.append(obj.name)
        else:
            kept.append(obj.name)
    return {"hidden": sorted(hidden), "kept": sorted(kept)}


# --------------------------------------------------------------------------
# cameras
# --------------------------------------------------------------------------


def elevation(name: str, axis: str, centre, span: float):
    return dg.add_ortho_camera_axis(name, centre, axis, span, distance=90.0)


def three_quarter(name: str, centre, span: float):
    cam = dg.add_camera(name, centre, span, pitch_deg=34.0, yaw_deg=38.0, distance=90.0)
    return cam


def gameplay(name: str, centre, cells: float):
    return dg.add_camera(name, centre, cells)


def crop_camera(name: str, target, span: float, pitch: float = 26.0,
                yaw: float = 24.0):
    return dg.add_camera(name, target, span, pitch_deg=pitch, yaw_deg=yaw,
                         distance=60.0)


# --------------------------------------------------------------------------
# packet
# --------------------------------------------------------------------------


def render_unit(uid: str, tag: str) -> dict:
    out = []

    def shot(name: str, camera) -> str:
        path = pk.prod("proof", tag, uid, f"{name}.png")
        dg.render_to(path, camera, RES, RES)
        out.append(path)
        return path

    P, objects, meshes = load_unit(uid, with_items=True, with_proxy=True)
    bounds = dg.world_bounds(meshes)
    cx = (bounds["minX"] + bounds["maxX"]) * 0.5
    cy = (bounds["minY"] + bounds["maxY"]) * 0.5
    cz = bounds["maxZ"] * 0.5
    span = max(bounds["spanX"], bounds["spanY"], bounds["spanZ"]) * 1.22
    centre = (cx, cy, cz)

    shot("01_south", elevation("cam_s", "south", centre, span))
    shot("02_north", elevation("cam_n", "north", centre, span))
    shot("03_east", elevation("cam_e", "east", centre, span))
    shot("04_west", elevation("cam_w", "west", centre, span))
    shot("05_top", elevation("cam_t", "top", (cx, cy, 0.0), span))
    shot("06_three_quarter", three_quarter("cam_q", centre, span))
    shot("07_gameplay", gameplay("cam_g", (cx, cy, 0.0),
                                 max(P["span_x"], P["span_y"]) * 1.45))

    door_cx = (P["door_x0"] + P["door_x1"]) * 0.5
    travel = P["door_travel"]
    door_cam = crop_camera("cam_door", (door_cx, P["front_y"] - 0.4, 1.35),
                           max(4.6, travel + 3.4), pitch=22.0, yaw=14.0)
    for label, t in (("08_door_closed", 0.0), ("09_door_half", 0.5),
                     ("10_door_open", 1.0)):
        set_door(objects, travel, (-1.0, 0.0, 0.0), t)
        shot(label, door_cam)
    set_door(objects, travel, (-1.0, 0.0, 0.0), 1.0)

    shot("11_threshold_crop",
         crop_camera("cam_thr", (door_cx, P["front_y"] - 0.1, 1.05), 3.4,
                     pitch=30.0, yaw=8.0))
    set_door(objects, travel, (-1.0, 0.0, 0.0), 0.0)

    shot("12_contact_crop",
         crop_camera("cam_con", (P["wall_x0"] + 1.4, P["front_y"] - 0.05, 0.35),
                     2.1, pitch=14.0, yaw=28.0))
    dx, dy, dz, dspan, _why = CROPS[uid]["detail"]
    shot("13_detail_crop", crop_camera("cam_det", (dx, dy, dz), dspan,
                                       pitch=22.0, yaw=-32.0))
    sx, sy, sz, sspan, _why2 = CROPS[uid]["seam"]
    shot("14_seam_crop", crop_camera("cam_seam", (sx, sy, sz), sspan,
                                     pitch=18.0, yaw=46.0))

    cut = apply_cutaway(objects)
    shot("15_cutaway", three_quarter("cam_cut", centre, span * 0.92))
    shot("16_cutaway_gameplay", gameplay("cam_cutg", (cx, cy, 0.0),
                                         max(P["span_x"], P["span_y"]) * 1.28))

    report = {
        "unit": uid,
        "round": tag,
        "source_glb": pk.prod("glb", f"{uid}_lod0.glb"),
        "source_sha256": pk.sha256(pk.prod("glb", f"{uid}_lod0.glb")),
        "reloaded_bounds": bounds,
        "imported_mesh_count": len(meshes),
        "cutaway_hidden": cut["hidden"],
        "cutaway_kept": cut["kept"],
        "cutaway_floor_retained": any("floor" in n.lower() for n in cut["kept"]),
        "cutaway_door_retained": any(n.startswith(pk.DOOR_NODE) for n in cut["kept"]),
        "cutaway_interior_retained": any(n.startswith("interior__") for n in cut["kept"]),
        "detail_crop_subject": CROPS[uid]["detail"][4],
        "seam_crop_subject": CROPS[uid]["seam"][4],
        "frames": out,
    }
    pk.write_json(pk.prod("proof", tag, uid, "packet.json"), report)
    print(f"[prodproof] {uid}/{tag}: {len(out)} frames, "
          f"{len(cut['hidden'])} hidden / {len(cut['kept'])} kept under cutaway")
    return report


def main() -> None:
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else ["all"]
    tag = "r1"
    if "--round" in argv:
        i = argv.index("--round")
        tag = argv[i + 1]
        argv = argv[:i] + argv[i + 2:]
    targets = list(pu.BUILDERS) if argv in ([], ["all"]) else argv
    reports = {uid: render_unit(uid, tag) for uid in targets}
    for uid, report in reports.items():
        for key in ("cutaway_floor_retained", "cutaway_door_retained",
                    "cutaway_interior_retained"):
            if not report[key]:
                raise SystemExit(f"[prodproof] {uid}: {key} is False")
    print(f"[prodproof] {len(reports)} unit packet(s) at round {tag}")


if __name__ == "__main__":
    main()
