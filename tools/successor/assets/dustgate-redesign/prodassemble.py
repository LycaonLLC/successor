"""Assemble the settlement from the standalone unit exports.

    blender -b --factory-startup -P prodassemble.py -- render

This is a layout, compatibility and art-direction test bed. It is NOT a
settlement asset. Every building is INSTANCED from its own exported GLB at a
map transform: the mesh datablocks are shared, nothing is joined, nothing is
baked, and no unit's internal geometry is edited here. If this file were
deleted the three products would be unaffected, which is the point.

Local block coordinates are world cells with the repository's compass:
`+x` east, `+y` south, origin at the block's north-west corner. Blender's
`+Y` is north, so `blender_y = -world_y` and a unit's authored front (`-Y` in
Blender, `+Z` in glTF) faces world south with no rotation applied.

There are no roads, paths, aprons, kerbs, paving or route-shaped ground marks
anywhere in this layout. The ground between buildings is the same untouched
desert surface as the ground outside them.
"""

from __future__ import annotations

import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import bpy  # type: ignore

import dgkit as dg
import prodkit as pk
import prodbuild as pb
import produnits as pu
from dgpaths import REPO_ROOT

BLOCK_W, BLOCK_H = 42, 32
RES = 1600

REPO = pb.PROMOTED_ROOT

#: unit id -> (north-west cell, cell size). Sizes MUST match the manifests.
PLACEMENTS = {
    "clone": ((4, 6), (12, 10)),
    "commerce": ((20, 5), (14, 11)),
    "shelter": ((9, 21), (8, 7)),
}

#: Freestanding settlement surfaces, in world cells (centre of the cell).
#: Tuple: (id, cell, glb or None, yaw deg, asset X rotation deg, role).
#: `None` means the surface has no promoted asset yet and the anchor is
#: reserved rather than dressed.
PAWNS = os.path.join(REPO_ROOT, "client-3d", "public", "assets", "pawn-pack")
FREESTANDING = (
    ("travel_terminal", (28.5, 22.5),
     os.path.join(REPO, "travel_terminal_grok_wedge.glb"), 0.0, -90.0,
     "Dustgate travel terminal; -90 X matches props-mapping assetRotationDegrees"),
    ("player_spawn", (26.0, 26.5), os.path.join(PAWNS, "pawn_male.glb"), 8.0, 0.0,
     "ordinary player spawn, promoted clothed pawn"),
    ("knox_vale", (32.4, 11.0), os.path.join(PAWNS, "pawn_female.glb"), 195.0, 0.0,
     "Knox Vale, profession trainer, at the commerce trainer station"),
    ("resident_a", (18.6, 18.4), os.path.join(PAWNS, "pawn_female.glb"), 40.0, 0.0,
     "resident"),
    ("resident_b", (13.2, 17.6), os.path.join(PAWNS, "pawn_male_bare.glb"), 250.0,
     0.0, "resident, bare body variant for clothing-layer compatibility"),
    ("equipment_vibrosword", (26.9, 26.5), os.path.join(PAWNS, "vibrosword.glb"),
     20.0, 0.0, "promoted equipment beside the spawn, scale compatibility"),
    ("gr0k", (24.0, 19.5), None, 0.0, 0.0,
     "GR0K, neutral social droid: anchor reserved, no promoted asset exists"),
)

#: Industrial-scale extraction props tested at their real size, OUTSIDE the
#: buildings. The audit's own verdict is that these are site equipment, not
#: interior dressing; shrinking them to fit a room was explicitly rejected.
YARD_PROPS = (
    ("mineral_power_skid", (17.4, 9.6), 0.0),
    ("mineral_dust_filter", (17.4, 12.4), 0.0),
    ("petrochemical_separator_skid", (17.6, 14.6), 90.0),
)
EXTRACTION_DIR = os.path.join(
    pb.SOURCE_ROOT,
    "successor/full-spectrum-wave-20260720/extraction-installations/parent-reset-01/assets",
)


def bx(cell_x: float) -> float:
    return cell_x


def by(cell_y: float) -> float:
    return -cell_y


# --------------------------------------------------------------------------
# instancing
# --------------------------------------------------------------------------


def instance_unit(uid: str, cell: tuple[int, int], size: tuple[int, int]) -> dict:
    """Import a unit export once and place it at its map transform.

    The uniform fit reproduces `composePlacement`:
    `scale = min(cellsX / spanX, cellsZ / spanZ)`, applied about the unit's own
    origin, with the instance centred on the prop rect. No geometry is touched.
    """
    path = pk.prod("glb", f"{uid}_lod0.glb")
    before = set(bpy.context.scene.objects)
    bpy.ops.import_scene.gltf(filepath=path)
    objects = [o for o in bpy.context.scene.objects if o not in before]
    pk.rest_pose_from_glb(path, objects)

    P = pu.BUILDERS[uid][0]()
    scale = min(size[0] / P["span_x"], size[1] / P["span_y"])
    root = bpy.data.objects.new(f"instance_{uid}", None)
    bpy.context.scene.collection.objects.link(root)
    for obj in objects:
        if obj.parent is None:
            obj.parent = root
    root.location = (bx(cell[0] + size[0] / 2.0), by(cell[1] + size[1] / 2.0), 0.0)
    root.scale = (scale, scale, scale)
    bpy.context.view_layer.update()

    meshes = [o for o in objects if o.type == "MESH"]
    return {
        "unit": uid,
        "glb": os.path.basename(path),
        "sha256": pk.sha256(path),
        "cell": list(cell),
        "size_cells": list(size),
        "uniform_scale": round(scale, 8),
        "world_centre": [round(root.location[0], 4), round(-root.location[1], 4)],
        "instanced_mesh_datablocks": sorted({m.data.name for m in meshes}),
        "joined_or_baked": False,
        "world_bounds": dg.world_bounds(meshes),
    }


def place_external(path: str, cx: float, cy: float, yaw_deg: float,
                   label: str, x_rot_deg: float = 0.0) -> dict | None:
    """Instance an external asset at a world cell.

    `x_rot_deg` reproduces the mapping's `assetRotationDegrees`: the travel
    terminal is authored Z-up in its own GLB and the runtime corrects it with
    `[-90, 0, 0]`, so an assembly that skips that lays it flat on the sand."""
    if not os.path.exists(path):
        print(f"[prodassemble] MISSING {label}: {path}")
        return None
    before = set(bpy.context.scene.objects)
    bpy.ops.import_scene.gltf(filepath=path)
    objects = [o for o in bpy.context.scene.objects if o not in before]
    if not objects:
        return None
    pk.rest_pose_from_glb(path, objects)
    container = bpy.data.objects.new(f"ext_{label}", None)
    bpy.context.scene.collection.objects.link(container)
    for obj in objects:
        if obj.parent is None:
            obj.parent = container
    container.rotation_euler = (math.radians(x_rot_deg), 0.0, math.radians(yaw_deg))
    bpy.context.view_layer.update()
    bounds = dg.world_bounds([o for o in objects if o.type == "MESH"])
    container.location = (
        bx(cx) - (bounds["minX"] + bounds["maxX"]) * 0.5,
        by(cy) - (bounds["minY"] + bounds["maxY"]) * 0.5,
        -bounds["minZ"],
    )
    bpy.context.view_layer.update()
    return {
        "label": label,
        "source": path.replace(os.path.expanduser("~"), "~"),
        "sha256": pk.sha256(path),
        "world_cell": [cx, cy],
        "yaw_deg": yaw_deg,
        "asset_rotation_x_deg": x_rot_deg,
        "embedded": False,
    }


# --------------------------------------------------------------------------
# the ancient windbreak and natural terrain
# --------------------------------------------------------------------------


#: (west cell, width, depth offset, height, batter, lean degrees, notch).
#: Hand-tuned, not procedural: round 1 generated evenly spaced piers of one
#: width and the whole windbreak read as a row of shipping containers behind
#: the settlement. Ancient work has to be irregular in plan, section and decay
#: or it reads as human industry, which is precisely the thing it must not.
ANCIENT_PIERS = (
    (2.4, 4.30, 0.00, 7.40, 0.55, -1.4, 0.62),
    (7.1, 2.60, 0.35, 5.90, 0.40, 0.9, 0.48),
    (10.2, 5.10, -0.25, 8.20, 0.70, 0.4, 0.71),
    (15.8, 3.20, 0.55, 6.30, 0.45, -2.1, 0.55),
    (19.5, 4.60, 0.10, 7.80, 0.62, 1.2, 0.66),
    (24.6, 2.90, -0.40, 5.10, 0.36, -0.7, 0.44),
    (28.0, 3.80, 0.30, 4.20, 0.50, 2.4, 0.58),
    (32.3, 2.40, 0.65, 2.60, 0.30, 4.1, 0.36),
    (35.2, 1.70, 0.20, 1.45, 0.22, -3.2, 0.0),
    (37.4, 1.20, -0.30, 0.85, 0.16, 5.6, 0.0),
)


def ancient_windbreak(unit: pk.Unit) -> None:
    """The older, irreproducible construction the settlement shelters behind.

    Cool cast mass on a continuous eroded footing, battered and leaning, taller
    and heavier at the west and collapsing into rubble at the east. It is
    terrain-scale context for the layout test bed, not a fourth building
    product, and it is never exported as one."""
    # Continuous footing: the piers are what survives of one structure, not a
    # row of separate objects, so they must share a plinth.
    unit.box("mass__", "ancient", bx(1.6), bx(39.4), by(4.10), by(0.30),
             0.0, 0.95, detail=pk.CORE, bevel=0.10, top_inset=0.22,
             base_flare=0.30)
    unit.box("mass__", "ancient_deep" if False else "reveal",
             bx(1.9), bx(39.1), by(3.95), by(3.80),
             0.30, 0.80, detail=pk.MID, bevel=0.04)

    for west, width, depth, height, batter, lean, notch in ANCIENT_PIERS:
        x0 = bx(west)
        y0, y1 = by(3.70 + depth), by(0.70 + depth)
        unit.box("mass__", "ancient", x0, x0 + width, y0, y1, 0.55, height,
                 detail=pk.CORE, bevel=0.09, top_inset=batter, base_flare=0.12)
        # Wind-cut shoulder: the top is never a clean plane.
        unit.box("mass__", "ancient", x0 + batter * 0.6, x0 + width - batter * 1.4,
                 y0 + 0.30, y1 - 0.55, height - 0.18, height + 0.42 * notch + 0.12,
                 detail=pk.MID, bevel=0.08, top_inset=0.26)
        if notch > 0.0:
            # Deep vertical slot: the only place `reveal` appears at this scale,
            # and it is what separates ancient work from panelled human walls.
            slot = min(0.55, width * 0.16)
            unit.box("mass__", "reveal", x0 + width - slot - 0.18,
                     x0 + width - 0.18, y0 + 0.22, y1 - 0.22,
                     height * 0.20, height * notch,
                     detail=pk.MID, bevel=0.03)
        # Lean: a few degrees is the difference between "ruin" and "warehouse".
        for piece in unit.pieces[-3:]:
            piece.obj.rotation_euler = (0.0, math.radians(lean), 0.0)
            piece.obj.location = (
                -(x0 + width * 0.5) * (math.cos(math.radians(lean)) - 1.0),
                0.0,
                (x0 + width * 0.5) * math.sin(math.radians(lean)),
            )

    # Spill of broken mass at the collapsed end: the only ground feature, and it
    # is rubble, not a route.
    for rx, ry, rr, seg in (
        (38.6, 2.4, 1.35, 7), (39.9, 3.9, 0.92, 6), (37.8, 5.1, 0.64, 6),
        (40.6, 1.8, 0.78, 5), (36.9, 4.4, 0.47, 5), (38.2, 6.3, 0.36, 5),
    ):
        unit.drum("mass__", "ancient", bx(rx), by(ry), 0.0, rr * 0.78, rr,
                  top_radius=rr * 0.38, segments=seg, detail=pk.MID, bevel=0.05)


def terrain() -> None:
    """Natural desert surface. No paving, aprons or route-shaped marks."""
    plane = dg.ground_plane("ground_sand", 180.0, pk.pbr_material("sand"))
    plane.location = (bx(BLOCK_W / 2.0), by(BLOCK_H / 2.0), 0.0)
    pk.box_project(plane, tile=7.0)
    # Low wind-drift swells, aligned with the prevailing wind off the windbreak.
    unit = pk.Unit(uid="terrain")
    for i, (cx, cy, rx, ry, h) in enumerate((
        (9.0, 19.5, 7.2, 2.1, 0.20), (30.0, 27.0, 8.4, 2.6, 0.26),
        (38.0, 14.0, 3.4, 5.2, 0.18), (2.5, 12.0, 2.6, 6.0, 0.16),
    )):
        unit.box("mass__", "sand", bx(cx - rx), bx(cx + rx), by(cy + ry), by(cy - ry),
                 -0.02, h, detail=pk.CORE, bevel=0.45, top_inset=rx * 0.55)
        _ = i
    unit.consolidate(detail_cap=pk.CORE, textured=True)


# --------------------------------------------------------------------------
# entry point
# --------------------------------------------------------------------------


def build() -> dict:
    dg.reset()
    pk.dressed_scene(ground=False)
    dg.configure_render(res_x=RES, res_y=RES, samples=96)
    terrain()

    ancient = pk.Unit(uid="ancient")
    ancient_windbreak(ancient)
    ancient.consolidate(detail_cap=pk.MID, textured=True)

    instances = [instance_unit(uid, cell, size)
                 for uid, (cell, size) in PLACEMENTS.items()]

    externals = []
    for label, (cx, cy), path, yaw, x_rot, role in FREESTANDING:
        if path is None:
            externals.append({"label": label, "role": role, "asset": None,
                              "world_cell": [cx, cy],
                              "note": "anchor reserved; no promoted asset exists"})
            continue
        record = place_external(path, cx, cy, yaw, label, x_rot_deg=x_rot)
        if record:
            record["role"] = role
            externals.append(record)

    for name, (cx, cy), yaw in YARD_PROPS:
        record = place_external(
            os.path.join(EXTRACTION_DIR, f"successor_extraction_{name}.glb"),
            cx, cy, yaw, name)
        if record:
            record["role"] = "extraction-scale yard equipment, tested outdoors"
            externals.append(record)

    # Interior items of every unit, instanced at the unit's map transform.
    for uid, (cell, size) in PLACEMENTS.items():
        P = pu.BUILDERS[uid][0]()
        scale = min(size[0] / P["span_x"], size[1] / P["span_y"])
        ox = cell[0] + size[0] / 2.0
        oy = cell[1] + size[1] / 2.0
        for item in pb.ITEM_PLAN[uid]:
            item_id, path, lane, promoted, _fp, _h, (lx, ly), yaw, role = item
            record = place_external(path, ox + lx * scale, oy - ly * scale,
                                    yaw, f"{uid}_{item_id}")
            if record:
                record.update(role=role, lane=lane, promoted=promoted,
                              host_unit=uid)
                externals.append(record)

    return {"instances": instances, "externals": externals}


def render(payload: dict) -> dict:
    frames = []

    def shot(name: str, camera, res: int = RES) -> None:
        path = pk.prod("assembly", f"{name}.png")
        dg.render_to(path, camera, res, res)
        frames.append(path)

    centre = (bx(BLOCK_W / 2.0), by(BLOCK_H / 2.0), 0.0)
    shot("01_plan", dg.add_ortho_camera_axis("cam_plan", centre, "top", 46.0))
    shot("02_gameplay_wide", dg.add_camera("cam_wide", centre, 40.0))
    shot("03_gameplay_frame", dg.add_camera(
        "cam_frame", (bx(20.0), by(17.0), 0.0), dg.GAMEPLAY_BASE_FRUSTUM_CELLS * 1.9))
    shot("04_three_quarter", dg.add_camera(
        "cam_q", centre, 44.0, pitch_deg=32.0, yaw_deg=34.0, distance=140.0))
    shot("05_south_elevation", dg.add_ortho_camera_axis(
        "cam_south", (centre[0], centre[1], 3.0), "south", 30.0))
    shot("06_spawn_view", dg.add_camera(
        "cam_spawn", (bx(26.0), by(24.0), 0.0), dg.GAMEPLAY_BASE_FRUSTUM_CELLS))
    shot("07_clone_approach", dg.add_camera(
        "cam_clone", (bx(10.0), by(17.5), 0.0), dg.GAMEPLAY_BASE_FRUSTUM_CELLS * 1.3))
    shot("08_windbreak", dg.add_camera(
        "cam_wb", (bx(24.0), by(6.0), 0.0), 22.0, pitch_deg=26.0, yaw_deg=-24.0,
        distance=120.0))

    meshes = [o for o in bpy.context.scene.objects if o.type == "MESH"]
    report = {
        "layout": {"block_cells": [BLOCK_W, BLOCK_H],
                   "compass": "+x east, +y south, origin at the block north-west",
                   "roads_paths_aprons_or_paving": "none authored"},
        "instances": payload["instances"],
        "externals": payload["externals"],
        "scene_mesh_objects": len(meshes),
        "scene_triangles": dg.triangle_count(meshes),
        "scene_bounds": dg.world_bounds(meshes),
        "frames": frames,
    }
    pk.write_json(pk.prod("assembly", "assembly.json"), report)
    print(f"[prodassemble] {len(payload['instances'])} instanced units, "
          f"{len(payload['externals'])} external assets, "
          f"{report['scene_triangles']} scene triangles, {len(frames)} frames")
    for record in payload["instances"]:
        print(f"[prodassemble]   {record['unit']:9s} cell {record['cell']} "
              f"size {record['size_cells']} scale {record['uniform_scale']:.7f}")
    return report


def main() -> None:
    payload = build()
    blend = pk.prod("assembly", "settlement_review.blend")
    dg.save_blend(blend)
    render(payload)


if __name__ == "__main__":
    main()
