"""Build, measure, and export the three standalone building units.

    blender -b --factory-startup -P prodbuild.py -- all
    blender -b --factory-startup -P prodbuild.py -- clone commerce

For each unit this emits, under the git-ignored production artifact root:

    units/<uid>.blend                 editable source checkpoint
    glb/<uid>_lod0.glb                textured PBR, door clips, LOD0
    glb/<uid>_lod1.glb                maps-free web base
    glb/<uid>_lod2.glb                maps-free distant silhouette
    manifests/<uid>_manifest.json     building manifest
    manifests/<uid>_collision.json    successor.structure-collision.v3
    qa/<uid>_build.json               measured build report

Nothing here writes into `client-3d/public/assets/world-items/`, the fixture,
or any runtime path. This is a source-stage lane.

## Why LOD1/LOD2 ship maps-free

`convertMaterial` in `client-3d/src/render/props.ts` routes ANY material that
carries a `map` to an unlit `MeshBasicMaterial`, and maps-free materials to the
authored `MeshMatcapMaterial` path. A fully textured GLB therefore renders flat
and unlit in the Three client while looking correct in an HDRP import. So LOD0
is the textured PBR product for Unity/HDRP, and LOD1 -- the web base -- carries
the same geometry silhouette with maps-free palette materials that the matcap
path shades properly. That is a deliberate, recorded split, not an omission.
"""

from __future__ import annotations

import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import bpy  # type: ignore

import dgkit as dg
import prodkit as pk
import produnits as pu
from dgpaths import REPO_ROOT
from prodkit import DoorSpec, Unit
from produnits import CELL_PER_METRE, FLOOR_TOP, SLAB_THICKNESS, TAN60

GENERATED_BY = "tools/successor/assets/dustgate-redesign/prodbuild.py"
PLAYER_RADIUS_M = 0.30
PLAYER_HEIGHT_M = 1.75
#: Widest representative character envelope measured from the promoted assets:
#: pawn body plus pack and shouldered equipment.
EQUIPPED_WIDTH_M = 0.86
EQUIPPED_DEPTH_M = 0.62


# --------------------------------------------------------------------------
# instanced world items: external assets, never embedded geometry
# --------------------------------------------------------------------------

SOURCE_ROOT = os.path.abspath(os.environ.get(
    "SUCCESSOR_PROP_SOURCE_ROOT",
    os.path.join(os.path.expanduser("~"), "dev", "games", "source-assets", "props"),
))
PROMOTED_ROOT = os.path.join(
    REPO_ROOT, "client-3d", "public", "assets", "world-items",
)

EXTRACTION = ("successor/full-spectrum-wave-20260720/extraction-installations/"
              "parent-reset-01/assets")
VEHICLE = "vehicles/successor/grok45-wave-20260718/components/assets"
EVERYDAY = "successor/everyday-wave-20260719/everyday-world-props/assets"
HOMEBUILD = "successor/homebuilder-wave-20260719/furniture/assets"


def _promoted(name: str) -> str:
    return os.path.join(PROMOTED_ROOT, name)


def _source(lane: str, name: str) -> str:
    return os.path.join(SOURCE_ROOT, lane, name)


#: (item id, absolute glb, lane label, promoted?, footprint w x d in metres,
#:  height, blender centre (x, y), yaw degrees, anchor role)
ITEM_PLAN: dict[str, tuple] = {
    "clone": (
        ("clone_pod_west", _promoted("clone_pod.glb"), "promoted-runtime", True,
         (1.56, 1.56), 2.44, (-3.30, 3.00), 0.0, "clone pod bay 1"),
        ("clone_pod_centre", _promoted("clone_pod.glb"), "promoted-runtime", True,
         (1.56, 1.56), 2.44, (0.00, 3.00), 0.0, "clone pod bay 2"),
        ("clone_pod_east", _promoted("clone_pod.glb"), "promoted-runtime", True,
         (1.56, 1.56), 2.44, (3.30, 3.00), 0.0, "clone pod bay 3"),
        ("clone_terminal", _promoted("clone_terminal.glb"), "promoted-runtime", True,
         (0.84, 1.02), 1.74, (-4.30, 0.80), 0.0, "clone terminal"),
        ("battery_bank_quad", _source(VEHICLE,
         "successor_vehicle_component_battery_bank_quad.glb"), "grok45-vehicle", False,
         (1.55, 1.06), 0.55, (-3.85, -2.75), 0.0, "facility power plant"),
        ("workbench_fold", _source(VEHICLE,
         "successor_vehicle_component_workbench_fold.glb"), "grok45-vehicle", False,
         (0.50, 1.31), 0.88, (4.60, -0.60), 90.0, "maintenance surface"),
        ("service_tool_cabinet", _source(VEHICLE,
         "successor_vehicle_component_service_tool_cabinet.glb"), "grok45-vehicle", False,
         (0.33, 0.94), 1.09, (4.78, -2.70), 90.0, "maintenance wall"),
    ),
    "commerce": (
        ("bank_terminal_civic", _promoted("bank_terminal_civic.glb"), "promoted-runtime", True,
         (1.01, 0.68), 1.65, (-3.60, 3.86), 0.0, "bank terminal"),
        ("trade_terminal", _promoted("trade_terminal.glb"), "promoted-runtime", True,
         (1.16, 0.72), 1.35, (0.00, 3.84), 0.0, "trade terminal"),
        ("pa_terminal", _promoted("pa_terminal.glb"), "promoted-runtime", True,
         (1.06, 0.66), 1.75, (3.20, 3.85), 0.0, "player association terminal"),
        ("cargo_crate_long_a", _source(VEHICLE,
         "successor_vehicle_component_cargo_crate_long.glb"), "grok45-vehicle", False,
         (0.67, 1.56), 0.61, (-5.45, -3.20), 90.0, "commerce stock"),
        ("cargo_crate_long_b", _source(VEHICLE,
         "successor_vehicle_component_cargo_crate_long.glb"), "grok45-vehicle", False,
         (0.67, 1.56), 0.61, (-5.45, -1.50), 90.0, "commerce stock"),
        ("cargo_crate_small", _source(VEHICLE,
         "successor_vehicle_component_cargo_crate_small.glb"), "grok45-vehicle", False,
         (0.78, 0.77), 0.67, (5.30, -3.55), 0.0, "commerce stock"),
        ("open_shelving", _source(HOMEBUILD,
         "successor_home_open_shelving_standard.glb"), "homebuilder", False,
         (1.00, 0.28), 1.80, (-5.20, 4.30), 0.0, "restrained storage"),
    ),
    "shelter": (
        ("bunk_bed", _source(HOMEBUILD, "successor_home_bunk_bed_standard.glb"),
         "homebuilder", False, (1.06, 2.10), 1.70, (-1.75, 1.05), 0.0, "sleeping platform"),
        ("footlocker_frontier", _promoted("footlocker_frontier.glb"), "promoted-runtime", True,
         (1.00, 0.58), 0.52, (-1.35, -2.35), 0.0, "personal storage"),
        ("utility_water_tank", _source(VEHICLE,
         "successor_vehicle_component_utility_water_tank.glb"), "grok45-vehicle", False,
         (0.86, 0.67), 0.77, (2.35, 2.10), 0.0, "shelter water system"),
        ("shelf_unit", _source(EVERYDAY, "successor_everyday_shelf_unit.glb"),
         "everyday", False, (0.81, 0.32), 1.35, (2.55, -2.62), 0.0, "shelter storage"),
    ),
}

#: Built-in interior masses that must block movement. Blender XY rectangles.
BUILT_IN_BLOCKERS: dict[str, tuple] = {
    "clone": (
        ("pod_pedestal_west", -4.25, -2.35, 2.04, 3.98),
        ("pod_pedestal_centre", -0.95, 0.95, 2.04, 3.98),
        ("pod_pedestal_east", 2.35, 4.25, 2.04, 3.98),
        ("west_service_counter", -4.90, -3.56, -2.09, -0.31),
    ),
    "commerce": (
        ("counter_bank", -4.86, -2.34, 2.49, 3.36),
        ("counter_trade", -1.26, 1.26, 2.49, 3.36),
        ("counter_pa", 1.94, 4.46, 2.49, 3.36),
        ("waiting_bench_west", -5.91, -5.43, -1.20, 1.80),
        ("strongroom_face", 4.89, 5.05, 1.35, 4.485),
    ),
    "shelter": (
        ("sleep_platform", -2.34, -1.04, -0.30, 2.45),
        ("service_pad", 1.54, 3.16, 1.54, 2.66),
    ),
}

#: Anchors that MUST stay walkable. Blender XY points.
ANCHORS: dict[str, tuple] = {
    "clone": (
        ("clone_respawn_point", 0.00, 1.55, "clone respawn"),
        ("clone_terminal_use", -3.55, 0.80, "clone terminal approach"),
        ("clone_pod_use_centre", 0.00, 1.55, "centre pod approach"),
    ),
    "commerce": (
        ("bank_terminal_civic", -3.60, 1.85, "bank counter approach"),
        ("trade_terminal", 0.00, 1.85, "trade counter approach"),
        ("pa_terminal", 3.20, 1.85, "PA counter approach"),
        ("trainer_npc", 4.20, 0.55, "Knox Vale station"),
    ),
    "shelter": (
        ("shelter_interior_stand", 0.60, 0.10, "shelter standing space"),
    ),
}


# --------------------------------------------------------------------------
# geometry helpers shared by the manifest, the sidecar and the QA report
# --------------------------------------------------------------------------


def footprint_of(P: dict) -> dict:
    box = pk.to_gltf_xz(P["foot_x0"], P["foot_x1"], P["foot_y0"], P["foot_y1"])
    return {
        **box,
        "spanX": round(box["maxX"] - box["minX"], 4),
        "spanZ": round(box["maxZ"] - box["minZ"], 4),
        "centerX": 0.0,
        "centerZ": 0.0,
    }


def cell_of(P: dict, gx: float, gz: float) -> list[int]:
    """glTF metres -> prop-local whole cell [col, row].

    Mirrors `transformStructureCollision`: recentre on the footprint, apply the
    uniform cell fit, then floor into integer cells. Row grows with glTF +Z,
    which is world south."""
    cw, ch = P["cells"]
    scale = min(cw / P["span_x"], ch / P["span_y"])
    col = int(math.floor(cw / 2.0 + gx * scale))
    row = int(math.floor(ch / 2.0 + gz * scale))
    return [max(0, min(cw - 1, col)), max(0, min(ch - 1, row))]


def structural_walls(P: dict) -> list[dict]:
    wx0, wx1, fy, by, t = (P["wall_x0"], P["wall_x1"], P["front_y"],
                           P["back_y"], P["wall_t"])
    dx0, dx1 = P["pier_x0"], P["door_x1"] + 0.42
    return [
        pk.collision_box(wx0, wx0 + t, fy, by, "outer_shell_left"),
        pk.collision_box(wx1 - t, wx1, fy, by, "outer_shell_right"),
        pk.collision_box(wx0, wx1, by - t, by, "outer_shell_back"),
        pk.collision_box(wx0, dx0, fy, fy + t, "front_wall_left"),
        pk.collision_box(dx1, wx1, fy, fy + t, "front_wall_right"),
        pk.collision_box(dx0, P["door_x0"], fy - 0.14, fy + t, "jamb_pier_left"),
        pk.collision_box(P["door_x1"], dx1, fy - 0.14, fy + t, "jamb_pier_right"),
    ]


def furniture_boxes(P: dict) -> list[dict]:
    uid = P["uid"]
    boxes = [pk.collision_box(x0, x1, y0, y1, name)
             for name, x0, x1, y0, y1 in BUILT_IN_BLOCKERS[uid]]
    for item in ITEM_PLAN[uid]:
        item_id, _path, _lane, _promoted_flag, (w, d), _h, (cx, cy), _yaw, _role = item
        boxes.append(pk.collision_box(cx - w / 2, cx + w / 2,
                                      cy - d / 2, cy + d / 2, f"item_{item_id}"))
    return boxes


def door_boxes(P: dict, door: DoorSpec) -> dict:
    face = P["front_y"]
    closed = pk.collision_box(door.x0, door.x1, door.y_front, face + P["wall_t"],
                              "closed_door_panel")
    return {"node": pk.DOOR_NODE, "closed": closed}


def interior_regions(P: dict) -> list[dict]:
    box = pk.to_gltf_xz(P["int_x0"], P["int_x1"], P["int_y0"], P["int_y1"])
    return [{"id": "main_walkable_interior", "floorTopY": FLOOR_TOP, **box}]


# --------------------------------------------------------------------------
# measured proofs
# --------------------------------------------------------------------------


def door_proof(P: dict, door: DoorSpec, walls, furniture, closed) -> dict:
    """Numeric proof of closed overlap, open clearance and threshold transit."""
    opening = pk.to_gltf_xz(P["door_x0"], P["door_x1"], P["front_y"] - 0.14,
                            P["front_y"] + P["wall_t"])
    leaf_closed = pk.to_gltf_xz(door.x0, door.x1, door.y_front, door.y_back)
    ox = door.travel * door.axis_local[0]
    leaf_open = {**leaf_closed,
                 "minX": round(leaf_closed["minX"] + ox, 4),
                 "maxX": round(leaf_closed["maxX"] + ox, 4)}

    overlap_w = min(leaf_closed["maxX"], opening["maxX"]) - max(leaf_closed["minX"], opening["minX"])
    open_gap = opening["minX"] - leaf_open["maxX"]

    fouls = [b["id"] for b in list(walls) + list(furniture)
             if pk.boxes_overlap(leaf_open, b)]
    # The leaf is surface-hung on the OUTSIDE face of the front wall, so the
    # parked leaf never intersects a collision box -- it covers one in plan.
    # Report the wall it lands in front of, and how far it laps onto it.
    def lap(box: dict) -> float:
        return min(leaf_open["maxX"], box["maxX"]) - max(leaf_open["minX"], box["minX"])

    def depth_gap(box: dict) -> float:
        return max(0.0, max(leaf_open["minZ"] - box["maxZ"], box["minZ"] - leaf_open["maxZ"]))

    hosts = [(b["id"], round(lap(b), 4)) for b in walls
             if lap(b) > 0.0 and depth_gap(b) <= 0.25]
    hosts.sort(key=lambda pair: -pair[1])
    park_host = hosts[0][0] if hosts else None
    park_lap = hosts[0][1] if hosts else 0.0

    return {
        "node": pk.DOOR_NODE,
        "closed_pose": "authored default transform of the door_slide node",
        "slide_axis_local": list(door.axis_local),
        "slide_distance_m": round(door.travel, 4),
        "clear_opening_m": [round(P["door_x1"] - P["door_x0"], 4),
                            round(P["door_head"] - FLOOR_TOP, 4)],
        "leaf_span_m": round(door.x1 - door.x0, 4),
        "closed_leaf_box": leaf_closed,
        "open_leaf_box": leaf_open,
        "closed_blocker_box": {k: v for k, v in closed.items() if k != "id"},
        "closed_leaf_blocker_overlap_m": round(
            min(leaf_closed["maxX"], closed["maxX"]) - max(leaf_closed["minX"], closed["minX"]), 4),
        "closed_opening_overlap_width_m": round(overlap_w, 4),
        "closed_covers_opening": overlap_w >= (opening["maxX"] - opening["minX"]) - 1e-6,
        "open_clearance_to_opening_m": round(open_gap, 4),
        "open_fully_clears_opening": open_gap > 0.0,
        "open_leaf_parks_in_front_of": park_host,
        "open_leaf_lap_onto_wall_m": park_lap,
        "open_leaf_fouls": fouls,
        "blocker_state": {
            "closed": "door blocker ACTIVE (worldQueries adds prop.door.blocker)",
            "open": ("door blocker DISABLED when "
                     "serverAuthority.propStates[propId].doorOpen === true"),
        },
        "clips": ["door_open", "door_close"],
        "clip_note": ("authored for interchange parity; the Three runtime drives "
                      "the node directly from axisLocal * distance and never "
                      "evaluates these clips"),
    }


def camera_proof(P: dict) -> dict:
    """Re-derive the sightline inequality that forces the entry bay to lead."""
    head = P["door_head"]
    overhang = P["front_y"] - P["hood_y"]
    limit = head + overhang * TAN60
    hood_top = min(head + 0.30, limit - 0.08)
    return {
        "camera_pitch_deg": 60.0,
        "door_head_m": round(head, 4),
        "hood_overhang_south_m": round(overhang, 4),
        "hood_top_m": round(hood_top, 4),
        "occlusion_limit_m": round(limit, 4),
        "door_head_visible": hood_top < limit,
        "margin_m": round(limit - hood_top, 4),
        "rule": "hood_top < door_head + overhang * tan(60deg)",
    }


def clearance_proof(P: dict, walls, furniture, closed, anchors) -> dict:
    """Human-proxy fit, plus a real walkable-egress search.

    Not a hand-drawn waypoint path: a breadth-first search over a 0.10 m
    occupancy grid swept at the player radius against every structural wall,
    built-in mass and instanced item. If the interior program traps an anchor,
    this reports the anchor and no route -- which is exactly the class of QA
    defect the first pass shipped as a skipped `front_cell`."""
    from collections import deque

    blockers = list(walls) + list(furniture)
    region = interior_regions(P)[0]
    door_center_x = (P["door_x0"] + P["door_x1"]) * 0.5
    threshold_z = -(P["front_y"])
    exterior_z = -(P["hood_y"]) + 1.10

    def hit(gx: float, gz: float, radius: float, with_door: bool) -> str | None:
        probe = {"minX": gx - radius, "maxX": gx + radius,
                 "minZ": gz - radius, "maxZ": gz + radius}
        for box in blockers:
            if pk.boxes_overlap(probe, box):
                return box["id"]
        if with_door and pk.boxes_overlap(probe, closed):
            return closed["id"]
        return None

    step = 0.10
    gx0, gx1 = P["foot_x0"] - 1.0, P["foot_x1"] + 1.0
    gz0, gz1 = -P["foot_y1"] - 1.0, exterior_z + 0.6
    nx = int((gx1 - gx0) / step) + 1
    nz = int((gz1 - gz0) / step) + 1

    def to_world(i: int, j: int) -> tuple[float, float]:
        return gx0 + i * step, gz0 + j * step

    def to_grid(gx: float, gz: float) -> tuple[int, int]:
        return (min(nx - 1, max(0, round((gx - gx0) / step))),
                min(nz - 1, max(0, round((gz - gz0) / step))))

    # Occupancy is computed once per unit; the door is OPEN while walking
    # through it, and its blocker is authority-disabled in exactly that state.
    free = bytearray(nx * nz)
    for j in range(nz):
        for i in range(nx):
            wx, wz = to_world(i, j)
            free[j * nx + i] = 1 if hit(wx, wz, PLAYER_RADIUS_M, False) is None else 0

    goal = to_grid(door_center_x, exterior_z)
    if not free[goal[1] * nx + goal[0]]:
        raise ValueError(f"{P['uid']}: the exterior egress target is not walkable")

    # One BFS from the exterior target; every anchor reads its own distance.
    INF = 10 ** 9
    dist = [INF] * (nx * nz)
    dist[goal[1] * nx + goal[0]] = 0
    queue = deque([goal])
    while queue:
        i, j = queue.popleft()
        base = dist[j * nx + i]
        for di, dj in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            ni, nj = i + di, j + dj
            if not (0 <= ni < nx and 0 <= nj < nz):
                continue
            index = nj * nx + ni
            if not free[index] or dist[index] <= base + 1:
                continue
            dist[index] = base + 1
            queue.append((ni, nj))

    routes = []
    for anchor_id, bx, by_, role in anchors:
        gx, gz = bx, -by_
        i, j = to_grid(gx, gz)
        steps = dist[j * nx + i]
        routes.append({
            "anchor": anchor_id,
            "role": role,
            "anchor_gltf": [round(gx, 3), round(gz, 3)],
            "anchor_cell": cell_of(P, gx, gz),
            "anchor_blocked_by": hit(gx, gz, PLAYER_RADIUS_M, False),
            "anchor_clear_at_player_radius": hit(gx, gz, PLAYER_RADIUS_M, False) is None,
            "anchor_clear_with_equipment": hit(
                gx, gz, max(EQUIPPED_WIDTH_M, EQUIPPED_DEPTH_M) * 0.5, False) is None,
            "route_length_m": None if steps >= INF else round(steps * step, 3),
            "route_walkable": steps < INF,
            "search": "4-connected BFS on a 0.10 m grid at the 0.30 m player radius",
        })

    threshold_open = hit(door_center_x, threshold_z, PLAYER_RADIUS_M, False)
    threshold_closed = hit(door_center_x, threshold_z, PLAYER_RADIUS_M, True)
    return {
        "player_proxy_height_m": PLAYER_HEIGHT_M,
        "player_radius_m": PLAYER_RADIUS_M,
        "equipped_envelope_m": [EQUIPPED_WIDTH_M, EQUIPPED_DEPTH_M],
        "interior_clear_height_m": round(P["int_ceiling"] - FLOOR_TOP, 3),
        "interior_fits_equipped_proxy": P["int_ceiling"] - FLOOR_TOP > PLAYER_HEIGHT_M + 0.3,
        "egress_target_gltf": [round(door_center_x, 3), round(exterior_z, 3)],
        "threshold_gltf": [round(door_center_x, 3), round(threshold_z, 3)],
        "threshold_clear_when_open": threshold_open is None,
        "threshold_blocked_when_closed": threshold_closed is not None,
        "walkable_region_m2": round(
            (region["maxX"] - region["minX"]) * (region["maxZ"] - region["minZ"]), 3),
        "routes": routes,
        "all_routes_walkable": all(r["route_walkable"] for r in routes),
        "all_anchors_clear": all(r["anchor_clear_at_player_radius"] for r in routes),
    }


def kept_clear(P: dict, walls, furniture, closed) -> dict:
    """`terminal_cells_kept_clear`: prop-local cells promised free of blockers."""
    cw, ch = P["cells"]
    scale = min(cw / P["span_x"], ch / P["span_y"])
    promised: dict[str, list[int]] = {}
    for anchor_id, bx, by_, _role in ANCHORS[P["uid"]]:
        promised[anchor_id] = cell_of(P, bx, -by_)

    for terminal_id, cell in promised.items():
        col, row = cell
        rect = {
            "minX": (col - cw / 2.0) / scale,
            "maxX": (col + 1 - cw / 2.0) / scale,
            "minZ": (row - ch / 2.0) / scale,
            "maxZ": (row + 1 - ch / 2.0) / scale,
        }
        for box in list(walls) + list(furniture) + [closed]:
            if pk.boxes_overlap(rect, box):
                raise ValueError(
                    f"{P['uid']}: blocker {box['id']} overlaps promised "
                    f"{terminal_id} cell {cell}"
                )
    return promised


# --------------------------------------------------------------------------
# build one unit
# --------------------------------------------------------------------------


def build_scene(uid: str, textured: bool, detail_cap: int):
    params_fn, build_fn = pu.BUILDERS[uid]
    P = params_fn()
    dg.reset()
    unit = Unit(uid=uid)
    door = build_fn(unit, P)
    door_empty = pk.build_door(unit, door)
    payload = unit.consolidate(detail_cap=detail_cap, textured=textured)
    pk.parent_door(door_empty, payload["parts"])
    roots = [e for e in payload["empties"].values() if e.name != pk.DOOR_NODE]
    roots.append(door_empty)
    return P, door, door_empty, payload, roots


def measured_bounds(parts) -> dict:
    return dg.world_bounds(parts)


def verify_export(uid: str, P: dict, door: DoorSpec) -> dict:
    """Reload the fresh LOD0 GLB and check the contract in the FILE.

    Everything above this line is a claim about the authoring scene. This is the
    only check that reads the artefact a runtime would load, which is how round
    2's open-pose door node was caught: the scene was right and the file was
    not."""
    path = pk.prod("glb", f"{uid}_lod0.glb")
    dg.reset()
    bpy.ops.import_scene.gltf(filepath=path)
    objects = list(bpy.context.scene.objects)
    rest = pk.rest_pose_from_glb(path, objects)
    names = [o.name for o in objects]
    door_nodes = [o for o in objects if o.name == pk.DOOR_NODE]
    stray = [n for n in names if n.startswith(pk.DOOR_NODE + ".")]
    door_meshes = [o for o in objects
                   if o.type == "MESH" and o.name.startswith(pk.DOOR_NODE)]
    leaf = dg.world_bounds(door_meshes) if door_meshes else None
    meshes = [o for o in objects if o.type == "MESH"]
    bounds = dg.world_bounds(meshes)
    families = sorted({f for f in pk.FAMILIES
                       if any(n.startswith(f) for n in names)})
    result = {
        "glb": path,
        "sha256": pk.sha256(path),
        "door_node_count": len(door_nodes),
        "stray_door_nodes": stray,
        "door_leaf_bounds": leaf,
        "door_leaf_covers_opening": bool(
            leaf
            and leaf["minX"] <= P["door_x0"] + 1e-3
            and leaf["maxX"] >= P["door_x1"] - 1e-3
        ),
        "animations": sorted(
            a.get("name", "") for a in pk.glb_document(path).get("animations", [])),
        "door_node_translation_gltf": rest.get(pk.DOOR_NODE),
        "node_families_present": families,
        "reloaded_bbox": bounds,
        "ground_contact_y": round(bounds["minZ"], 5),
        "bbox_matches_footprint": (
            abs(bounds["spanX"] - P["span_x"]) < 1e-3
            and abs(bounds["spanY"] - P["span_y"]) < 1e-3
        ),
        "uv0_on_every_mesh": all(m.data.uv_layers for m in meshes),
    }
    _ = door
    return result


def build_unit(uid: str) -> dict:
    print(f"\n[prodbuild] === {uid} ===")
    P, door, door_empty, payload, roots = build_scene(uid, True, pk.FINE)
    parts = payload["parts"]

    clips = pk.author_door_clips(door_empty, door)
    bounds = measured_bounds(parts)
    census = pk.part_census(parts)
    uvs = pk.uv_report(parts)

    # A part that pokes past the declared footprint silently rescales every
    # collision box at bake time, so name the offender instead of drifting.
    overflow = []
    for part in parts:
        b = dg.world_bounds([part])
        for label, over in (
            ("west", P["foot_x0"] - b["minX"]), ("east", b["maxX"] - P["foot_x1"]),
            ("south", P["foot_y0"] - b["minY"]), ("north", b["maxY"] - P["foot_y1"]),
        ):
            if over > 1e-4:
                overflow.append(f"{part.name} {label} +{over:.4f} m")
    if overflow:
        raise SystemExit(f"[prodbuild] {uid}: geometry leaves the declared "
                         f"footprint:\n  " + "\n  ".join(overflow))

    foot = footprint_of(P)
    walls = structural_walls(P)
    furniture = furniture_boxes(P)
    doors = door_boxes(P, door)
    regions = interior_regions(P)
    for box in walls + furniture + [doors["closed"]] + regions:
        pk.assert_inside(box, foot, box.get("id", "interiorRegion"))
    promised = kept_clear(P, walls, furniture, doors["closed"])

    blend = pk.prod("units", f"{uid}.blend")
    dg.save_blend(blend)

    glb0 = pk.prod("glb", f"{uid}_lod0.glb")
    pk.export_unit(glb0, roots, animations=True)

    lods = {"lod0": {"path": glb0, "detail_cap": "FINE", "textured": True,
                     "renderer_primitives": census["renderer_primitives"],
                     "triangles": census["triangles"],
                     "sha256": pk.sha256(glb0),
                     "bytes": os.path.getsize(glb0)}}
    for level, cap in (("lod1", pk.MID), ("lod2", pk.CORE)):
        _P2, _d2, _e2, pay2, roots2 = build_scene(uid, False, cap)
        path = pk.prod("glb", f"{uid}_{level}.glb")
        pk.export_unit(path, roots2, animations=False)
        c2 = pk.part_census(pay2["parts"])
        b2 = measured_bounds(pay2["parts"])
        lods[level] = {
            "path": path,
            "detail_cap": "MID" if level == "lod1" else "CORE",
            "textured": False,
            "renderer_primitives": c2["renderer_primitives"],
            "triangles": c2["triangles"],
            "triangle_fraction_of_lod0": round(c2["triangles"] / census["triangles"], 4),
            "sha256": pk.sha256(path),
            "bytes": os.path.getsize(path),
            "silhouette_span_delta_m": [
                round(b2["spanX"] - bounds["spanX"], 4),
                round(b2["spanZ"] - bounds["spanZ"], 4),
                round(b2["spanY"] - bounds["spanY"], 4),
            ],
            "keeps_door_floor_opening": all(
                any(p.name.startswith(f) for p in pay2["parts"])
                for f in ("floor__", pk.DOOR_NODE)
            ),
        }

    manifest = {
        "building": f"settlement_{uid}_unit",
        "units": "m",
        "front": "+Z",
        "origin": "footprint centre in XZ, ground contact at Y=0",
        "footprint_cells": list(P["cells"]),
        "bbox_span_m": [round(bounds["spanX"], 4), round(bounds["spanZ"], 4),
                        round(bounds["spanY"], 4)],
        f"runtime_scale_at_{P['cells'][0]}x{P['cells'][1]}_cells": round(
            min(P["cells"][0] / P["span_x"], P["cells"][1] / P["span_y"]), 6),
        "interior_clear_height_m": round(P["int_ceiling"] - FLOOR_TOP, 3),
        "clear_opening_m": [round(P["door_x1"] - P["door_x0"], 4),
                            round(P["door_head"] - FLOOR_TOP, 4)],
        "door_cells": sorted({tuple(cell_of(P, x, -(P["front_y"] + P["wall_t"] * 0.5)))
                              for x in (P["door_x0"] + 0.05, 0.0, P["door_x1"] - 0.05)},
                             key=lambda c: (c[1], c[0])),
        "floorHeightM": FLOOR_TOP,
        "floorTopY": FLOOR_TOP,
        "interiorRegions": regions,
        "cutaway": {
            "hide": ["roof__"],
            "keep": ["floor__", "interior__"],
            "stub_by_face": True,
            "faces": {"front": "wall_front__", "right": "wall_right__",
                      "back": "wall_back__", "left": "wall_left__"},
            "reveal_prefixes_for_mapping": list(pk.REVEAL_SET),
            "non_reveal_attached_masses": "mass__",
        },
        "door": {
            "node": pk.DOOR_NODE,
            "slide_axis_local": list(door.axis_local),
            "slide_distance_m": round(door.travel, 4),
            "clips": clips,
        },
        "collisionProxy": {
            "source": "P",
            "sidecar": f"{uid}_collision.json",
            "structuralOnly": False,
            "includesFurniture": True,
        },
        "service_anchor_cells": promised,
        "materials": census["materials"],
        "tri_count": census["triangles"],
        "renderer_primitives": census["renderer_primitives"],
        "draw_calls_per_instance": census["draw_calls_per_instance"],
        "node_families": census["node_families"],
        "lods": {k: {"glb": os.path.basename(v["path"]),
                     "triangles": v["triangles"],
                     "renderer_primitives": v["renderer_primitives"],
                     "textured": v["textured"]} for k, v in lods.items()},
        "instanced_items": [
            {
                "id": item[0],
                "source": item[1].replace(os.path.expanduser("~"), "~"),
                "lane": item[2],
                "promoted": item[3],
                "footprint_m": list(item[4]),
                "height_m": item[5],
                "local_center_gltf": [round(item[6][0], 3), round(-item[6][1], 3)],
                "yaw_deg": item[7],
                "role": item[8],
                "embedded": False,
            }
            for item in ITEM_PLAN[uid]
        ],
    }

    sidecar = {
        "schema": "successor.structure-collision.v3",
        "source": f"{uid}_lod0.glb",
        "generatedBy": GENERATED_BY,
        "contract": {
            "geometrySource": "P",
            "structuralRoles": ["outer_shell", "front_walls", "jamb_piers", "closed_door"],
            "furnitureRoles": ["built_in_masses", "instanced_world_items"],
            "decorativeExcluded": ["pilasters", "vents", "hoods", "battens",
                                   "fascia", "louvres", "signals", "sills"],
            "terminal_cells_kept_clear": promised,
        },
        "footprint": foot,
        "floor": {"topY": FLOOR_TOP, "slabThicknessM": SLAB_THICKNESS},
        "walls": walls,
        "furniture": furniture,
        "door": doors,
        "interiorRegions": regions,
    }

    report = {
        "unit": uid,
        "generatedBy": GENERATED_BY,
        "blender": bpy.app.version_string,
        "authored_basis": {
            "source": "Blender Z-up, front -Y, origin at footprint centre",
            "export": "glTF Y-up via export_yup, front +Z",
            "ground_contact_local_y": round(bounds["minZ"], 5),
            "origin_offset_xz_m": [round((bounds["minX"] + bounds["maxX"]) / 2, 5),
                                   round(-(bounds["minY"] + bounds["maxY"]) / 2, 5)],
        },
        "bounds_blender": bounds,
        "footprint_gltf": foot,
        "footprint_matches_mesh": (
            abs(bounds["spanX"] - foot["spanX"]) < 1e-3
            and abs(bounds["spanY"] - foot["spanZ"]) < 1e-3
        ),
        "census": census,
        "uv": uvs,
        "camera": camera_proof(P),
        "door": door_proof(P, door, walls, furniture, doors["closed"]),
        "clearance": clearance_proof(P, walls, furniture, doors["closed"],
                                     ANCHORS[uid]),
        "lods": lods,
        "blend": blend,
    }

    report["export_check"] = verify_export(uid, P, door)

    pk.write_json(pk.prod("manifests", f"{uid}_manifest.json"), manifest)
    pk.write_json(pk.prod("manifests", f"{uid}_collision.json"), sidecar)
    pk.write_json(pk.prod("qa", f"{uid}_build.json"), report)

    print(f"[prodbuild] {uid}: {census['triangles']} tris, "
          f"{census['renderer_primitives']} primitives, "
          f"{census['material_count']} materials")
    print(f"[prodbuild] {uid}: bbox {bounds['spanX']:.3f} x {bounds['spanY']:.3f} "
          f"x {bounds['spanZ']:.3f} m, ground {bounds['minZ']:+.4f}")
    print(f"[prodbuild] {uid}: door travel {door.travel:.3f} m, "
          f"open clearance {report['door']['open_clearance_to_opening_m']:+.3f} m, "
          f"camera margin {report['camera']['margin_m']:+.3f} m")
    for route in report["clearance"]["routes"]:
        flag = "ok     " if route["route_walkable"] else "BLOCKED"
        length = route["route_length_m"]
        print(f"[prodbuild] {uid}:   egress {route['anchor']:<24s} {flag} "
              f"{'  n/a' if length is None else format(length, '6.2f')} m "
              f"{route['anchor_blocked_by'] or ''}")
    return report


def main() -> None:
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else ["all"]
    targets = list(pu.BUILDERS) if argv == ["all"] else argv
    reports = {}
    for uid in targets:
        if uid not in pu.BUILDERS:
            raise SystemExit(f"unknown unit {uid!r}")
        reports[uid] = build_unit(uid)
    failures = []
    for uid, report in reports.items():
        if not report["footprint_matches_mesh"]:
            failures.append(f"{uid}: declared footprint disagrees with the mesh AABB")
        if not report["door"]["open_fully_clears_opening"]:
            failures.append(f"{uid}: open leaf does not clear the opening")
        if report["door"]["open_leaf_fouls"]:
            failures.append(f"{uid}: open leaf fouls {report['door']['open_leaf_fouls']}")
        if not report["camera"]["door_head_visible"]:
            failures.append(f"{uid}: door head occluded at the gameplay pitch")
        if not report["clearance"]["all_routes_walkable"]:
            failures.append(f"{uid}: an anchor has no walkable egress")
        if abs(report["authored_basis"]["ground_contact_local_y"]) > 1e-4:
            failures.append(f"{uid}: ground contact is not at local Y = 0")
        check = report["export_check"]
        if check["door_node_count"] != 1:
            failures.append(f"{uid}: exported GLB has {check['door_node_count']} "
                            f"nodes named {pk.DOOR_NODE!r}")
        if check["stray_door_nodes"]:
            failures.append(f"{uid}: stray door nodes {check['stray_door_nodes']}")
        if not check["door_leaf_covers_opening"]:
            failures.append(f"{uid}: exported door leaf is not at its closed "
                            f"pose -- bounds {check['door_leaf_bounds']}")
        if sorted(check["animations"]) != ["door_close", "door_open"]:
            failures.append(f"{uid}: exported clips {check['animations']}")
        if not check["bbox_matches_footprint"]:
            failures.append(f"{uid}: reloaded bbox disagrees with the footprint")
        if abs(check["ground_contact_y"]) > 1e-4:
            failures.append(f"{uid}: reloaded ground contact "
                            f"{check['ground_contact_y']}")
        if not check["uv0_on_every_mesh"]:
            failures.append(f"{uid}: a reloaded mesh has no UV0")
    if failures:
        raise SystemExit("[prodbuild] FAILED\n  " + "\n  ".join(failures))
    print(f"\n[prodbuild] {len(reports)} unit(s) built and verified")


if __name__ == "__main__":
    main()
