"""Renderer-neutral selected-layout proposal for the Dustgate redesign study.

Pure Python: no Blender, no repository fixture, no canonical ids. The Blender
builder, the QA pass, and the emitted JSON all read this module so geometry and
layout cannot drift apart.

Local grid
----------
A local integer-cell grid, 40 cells east-west by 28 cells north-south. Cell
`(i, j)` spans metres `x in [i, i+1]` measured EAST from the local origin and
`y in [j, j+1]` measured SOUTH from it. That matches authority orientation
(`+x` east, `+y` south), so `j = 0` is the NORTH edge of the study area and
`j = 27` is the SOUTH edge. Cell centres are at `(i + 0.5, j + 0.5)`.

The proposal deliberately carries no origin in world/authority cells. Placing
this block into the world is the later integration pass's job.

No connective surface, apron, path, kerb, or route geometry exists in this
layout. The plaza between the buildings is empty ground.
"""

from __future__ import annotations

import json
from typing import Any

GRID_EAST_CELLS = 40
GRID_SOUTH_CELLS = 28
CELL_METRES = 1.0

# Directional labels for every consumer of this document.
COMPASS = {
    "east": "+x, increasing cell i",
    "west": "-x, decreasing cell i",
    "south": "+y, increasing cell j",
    "north": "-y, decreasing cell j",
    "up": "+z",
    "camera": "north-up pitched orthographic, yaw locked 0, pitch 60 degrees",
}

WALL_THICKNESS = 0.35
FLOOR_HEIGHT = 0.02
DOOR_WIDTH = 1.8
DOOR_HEIGHT = 2.4
DOOR_PANEL_WIDTH = 1.95
PROXY_HEIGHT_MARGIN = 0.0


def rect(x0: float, y0: float, x1: float, y1: float) -> dict[str, float]:
    """South-east positive axis-aligned rectangle in local metres."""
    return {
        "x0": round(min(x0, x1), 3),
        "y0": round(min(y0, y1), 3),
        "x1": round(max(x0, x1), 3),
        "y1": round(max(y0, y1), 3),
    }


def cell(i: int, j: int) -> dict[str, Any]:
    return {"i": i, "j": j, "centre": [i + 0.5, j + 0.5]}


# --------------------------------------------------------------------------
# ancient backdrop: the windbreak this settlement was built in the lee of
# --------------------------------------------------------------------------

ANCIENT = {
    "id": "study-ancient-windbreak",
    "role": "ancient remnant backdrop, not human construction",
    "note": (
        "One battered wall fragment on the north edge, broken in two places. "
        "Human structures stand 1.0 m clear of its south face; nothing is "
        "built into it."
    ),
    "segments": [
        {"name": "seg_west", "footprint": rect(2.0, 2.0, 16.0, 4.0), "height_m": 8.6},
        {"name": "seg_mid", "footprint": rect(18.5, 2.0, 29.0, 4.0), "height_m": 7.6},
        {"name": "seg_stub", "footprint": rect(29.0, 2.2, 36.5, 3.8), "height_m": 4.0},
        {"name": "fallen_slab", "footprint": rect(16.2, 2.2, 18.3, 3.9),
         "height_m": 1.35,
         "note": "the block that fell out of the western breach, lying where it landed"},
    ],
}


# --------------------------------------------------------------------------
# structures
# --------------------------------------------------------------------------


def wind_lock(structure_shell: dict[str, float], door_opening: dict[str, float],
              depth: float, thickness: float, height: float,
              flank: float = 0.6) -> dict[str, Any]:
    """Projecting wind-lock threshold.

    Measured constraint: under the locked 60-degree pitch an eave at height `h`
    with overhang `o` hides every ground point from `o` south of the wall to
    `h / tan(60) - o` north of it. For a 4.2 m eave that is ~2.4 m, so a
    threshold flush with the wall CANNOT be seen at gameplay framing. The wind
    lock therefore projects past the eave shadow line: two return walls and a
    raised sill plate whose southern strip is always lit and camera-visible.
    """
    y0 = structure_shell["y1"]
    y1 = y0 + depth
    west = rect(door_opening["x0"] - flank - thickness, y0,
                door_opening["x0"] - flank, y1)
    east = rect(door_opening["x1"] + flank, y0,
                door_opening["x1"] + flank + thickness, y1)
    return {
        "depth_m": depth,
        "return_thickness_m": thickness,
        "height_m": height,
        "returns": [{"name": "wind_lock_west", "rect": west},
                    {"name": "wind_lock_east", "rect": east}],
        "clear_span_m": round(east["x0"] - west["x1"], 3),
        "sill": rect(west["x1"], y0 + depth * 0.63, east["x0"], y1),
        "sill_height_m": 0.06,
        "sill_note": "raised plate inside the wind lock footprint; walkable, not a blocker",
    }


def _wall_proxies(x0: float, y0: float, x1: float, y1: float, t: float,
                  door_wall: str, door_a: float, door_b: float) -> list[dict[str, Any]]:
    """Shell collision proxies with the door opening subtracted from its wall."""
    out: list[dict[str, Any]] = []

    def push(name: str, r: dict[str, float]) -> None:
        out.append({"name": name, "rect": r})

    walls = {
        "north": rect(x0, y0, x1, y0 + t),
        "south": rect(x0, y1 - t, x1, y1),
        "west": rect(x0, y0, x0 + t, y1),
        "east": rect(x1 - t, y0, x1, y1),
    }
    for side, r in walls.items():
        if side != door_wall:
            push(f"wall_{side}", r)
            continue
        if side in ("north", "south"):
            push(f"wall_{side}_w", rect(r["x0"], r["y0"], door_a, r["y1"]))
            push(f"wall_{side}_e", rect(door_b, r["y0"], r["x1"], r["y1"]))
        else:
            push(f"wall_{side}_n", rect(r["x0"], r["y0"], r["x1"], door_a))
            push(f"wall_{side}_s", rect(r["x0"], door_b, r["x1"], r["y1"]))
    return out


CLONE = {
    "id": "study-clone-facility",
    "function": "cloning",
    "visual_read": "north-stepped sawtooth roof, west pod bank, south hoist gantry",
    "footprint": {"cell": [4, 5], "east_cells": 10, "south_cells": 8, "yaw_deg": 0},
    "shell": rect(4.0, 5.0, 14.0, 13.0),
    "wall_thickness_m": WALL_THICKNESS,
    "floor_height_m": FLOOR_HEIGHT,
    "wall_top_north_m": 3.90,
    "wall_top_south_m": 4.85,
    "roof": {
        "kind": (
            "sawtooth, 3 bays, ridge at each bay's SOUTH edge falling north; the "
            "louvred riser faces of every step therefore face the camera"
        ),
        "bays": 3,
        "ridge_m": 4.85,
        "valley_m": 3.90,
        "riser_height_m": 0.95,
        "eave_overhang_south_m": 0.5,
        "eave_overhang_side_m": 0.3,
        "exhaust_stack": {"cell": [13, 6], "height_m": 7.6,
                          "reason": "vat cooling exhaust; the settlement's one "
                                    "vertical accent above a horizontal band"},
    },
    "door": {
        "wall": "south",
        "opening": rect(8.0, 12.65, 9.8, 13.0),
        "width_m": DOOR_WIDTH,
        "height_m": DOOR_HEIGHT,
        "node": "door_slide",
        "slide_axis_local": [-1, 0, 0],
        "slide_distance_m": DOOR_PANEL_WIDTH,
        "pivot_local": [8.9, 12.825, 0.0],
        "open_pose_note": "panel translates west along local -x by 1.95 m over 0.8 s",
    },
    "interior_walkable": rect(4.35, 5.35, 13.65, 12.65),
    "anchors": [
        {"id": "study-clone-terminal", "cell": cell(12, 7), "kind": "terminal",
         "facing": "west"},
        {"id": "study-clone-pod", "cell": cell(5, 7), "kind": "clone-pod",
         "facing": "east"},
        {"id": "study-clone-respawn", "cell": cell(9, 11), "kind": "respawn-point"},
    ],
    "furniture_blockers": [
        {"name": "coolant_bench", "rect": rect(4.35, 9.6, 6.4, 12.0)},
        {"name": "vat_bench", "rect": rect(11.6, 5.6, 13.65, 6.9)},
        {"name": "hoist_leg_west", "rect": rect(6.15, 14.8, 6.65, 15.3)},
        {"name": "hoist_leg_east", "rect": rect(11.35, 14.8, 11.85, 15.3)},
    ],
    "exterior_masses": [
        {"name": "pod_bulge", "rect": rect(3.0, 5.6, 4.35, 9.6), "height_m": 3.15,
         "note": "three clone drums bulging west through the wall; the reserved "
                 "pod cell is the interior standing cell in front of them"},
    ],
}

COMMERCE = {
    "id": "study-commerce-facility",
    "function": "exchange and commerce",
    "visual_read": "east-west ridge under a louvred monitor, welded-on strongroom annex",
    "footprint": {"cell": [16, 5], "east_cells": 12, "south_cells": 9, "yaw_deg": 0},
    "shell": rect(16.0, 5.0, 28.0, 14.0),
    "wall_thickness_m": WALL_THICKNESS,
    "floor_height_m": FLOOR_HEIGHT,
    "wall_top_north_m": 4.20,
    "wall_top_south_m": 4.20,
    "roof": {
        "kind": ("shallow gable, ridge east-west, 4 upstand bays, ridge monitor; the "
                 "two western bays carry a later re-skin in a lighter roof value "
                 "with a raised flashing bar on the seam"),
        "ridge_y_m": 9.5,
        "ridge_m": 5.10,
        "eave_m": 4.20,
        "monitor_top_m": 6.70,
        "eave_overhang_south_m": 0.55,
        "eave_overhang_side_m": 0.35,
        "upstand_bays": 4,
    },
    "door": {
        "wall": "south",
        "opening": rect(20.6, 13.65, 22.4, 14.0),
        "width_m": DOOR_WIDTH,
        "height_m": DOOR_HEIGHT,
        "node": "door_slide",
        "slide_axis_local": [-1, 0, 0],
        "slide_distance_m": DOOR_PANEL_WIDTH,
        "pivot_local": [21.5, 13.825, 0.0],
        "open_pose_note": "panel translates west along local -x by 1.95 m over 0.8 s",
    },
    "interior_walkable": rect(16.35, 5.35, 27.65, 13.65),
    "anchors": [
        {"id": "study-bank-terminal", "cell": cell(18, 7), "kind": "terminal",
         "facing": "south"},
        {"id": "study-trade-terminal", "cell": cell(21, 7), "kind": "terminal",
         "facing": "south"},
        {"id": "study-pa-terminal", "cell": cell(24, 7), "kind": "terminal",
         "facing": "south"},
        {"id": "study-knox-vale", "cell": cell(25, 11), "kind": "npc-trainer",
         "facing": "west"},
    ],
    "furniture_blockers": [
        {"name": "counter_west", "rect": rect(16.6, 10.4, 19.4, 11.4)},
        {"name": "counter_east", "rect": rect(22.6, 10.4, 24.4, 11.4)},
        {"name": "crate_stack_nw", "rect": rect(16.35, 5.35, 17.6, 6.6)},
        {"name": "crate_stack_ne", "rect": rect(26.4, 5.35, 27.65, 6.6)},
        {"name": "sail_post_west", "rect": rect(18.5, 15.9, 18.9, 16.3)},
        {"name": "sail_post_east", "rect": rect(24.1, 15.9, 24.5, 16.3)},
    ],
    "shade_sails": [
        {"name": "sail_west", "rect": rect(17.0, 14.55, 19.6, 16.3)},
        {"name": "sail_east", "rect": rect(23.4, 14.55, 26.0, 16.3)},
    ],
    "exterior_masses": [
        {"name": "strongroom_annex", "rect": rect(28.0, 5.0, 31.0, 9.6),
         "height_m": 4.6,
         "note": "later addition welded to the east gable; solid, not enterable"},
    ],
}

SHELTER = {
    "id": "study-starter-shelter",
    "function": "shelter and habitat",
    "visual_read": "single north-falling pitch into a catchment gutter and cistern",
    "footprint": {"cell": [32, 6], "east_cells": 6, "south_cells": 6, "yaw_deg": 0},
    "shell": rect(32.0, 6.0, 38.0, 12.0),
    "wall_thickness_m": 0.3,
    "floor_height_m": FLOOR_HEIGHT,
    "wall_top_north_m": 2.70,
    "wall_top_south_m": 3.50,
    "roof": {
        "kind": "monopitch falling north into a gutter",
        "high_m": 3.55,
        "low_m": 2.75,
        "eave_overhang_south_m": 0.35,
        "eave_overhang_north_m": 0.45,
        "eave_overhang_side_m": 0.3,
    },
    "door": {
        "wall": "south",
        "opening": rect(34.1, 11.7, 35.9, 12.0),
        "width_m": DOOR_WIDTH,
        "height_m": 2.2,
        "node": "door_slide",
        "slide_axis_local": [-1, 0, 0],
        "slide_distance_m": DOOR_PANEL_WIDTH,
        "pivot_local": [35.0, 11.85, 0.0],
        "open_pose_note": "panel translates west along local -x by 1.95 m over 0.8 s",
    },
    "interior_walkable": rect(32.3, 6.3, 37.7, 11.7),
    "anchors": [
        {"id": "study-shelter-bunk", "cell": cell(33, 7), "kind": "furniture"},
        {"id": "study-shelter-store", "cell": cell(36, 7), "kind": "furniture"},
    ],
    "furniture_blockers": [
        {"name": "bunk", "rect": rect(32.3, 6.3, 34.1, 8.0)},
        {"name": "store_rack", "rect": rect(36.0, 6.3, 37.7, 7.9)},
    ],
    "exterior_masses": [
        {"name": "cistern", "rect": rect(38.4, 7.4, 40.0, 9.0), "height_m": 3.0,
         "note": "water catch drum fed by the north gutter"},
    ],
}

CLONE["wind_lock"] = wind_lock(CLONE["shell"], CLONE["door"]["opening"], 1.5, 0.3, 3.1)
COMMERCE["wind_lock"] = wind_lock(COMMERCE["shell"], COMMERCE["door"]["opening"],
                                  1.5, 0.3, 3.2)
SHELTER["wind_lock"] = wind_lock(SHELTER["shell"], SHELTER["door"]["opening"],
                                 1.3, 0.3, 2.5)

STRUCTURES = [CLONE, COMMERCE, SHELTER]

# --------------------------------------------------------------------------
# open-ground gameplay surfaces
# --------------------------------------------------------------------------

FREESTANDING = [
    {
        "id": "study-travel-terminal",
        "kind": "terminal",
        "anchor": cell(20, 20),
        "footprint": rect(19.4, 20.0, 21.4, 21.6),
        "height_m": 5.4,
        "own_reserved": "travel-approach",
        "collision_proxies": [{"name": "travel_pad", "rect": rect(19.4, 20.0, 21.4, 21.6)}],
        "note": "isolated footprint only; no apron, path, or connective surface",
    },
    {
        "id": "study-grok",
        "kind": "npc-social",
        "anchor": cell(25, 17),
        "footprint": None,
        "own_reserved": None,
        "collision_proxies": [],
        "note": "neutral social droid, no invented job, stands in open ground",
    },
]

POINTS = [
    {"id": "study-player-spawn", "cell": cell(21, 23), "kind": "ordinary-spawn"},
    {"id": "study-clone-respawn", "cell": cell(9, 11), "kind": "clone-respawn",
     "inside": "study-clone-facility"},
]

RESERVED_CLEAR = [
    {"id": "clone-threshold", "rect": rect(7.0, 14.5, 11.0, 17.2),
     "reason": "clone approach south of the wind lock, under the hoist gantry"},
    {"id": "commerce-threshold", "rect": rect(19.6, 15.5, 23.4, 18.2),
     "reason": "commerce approach south of the wind lock, between the shade sails"},
    {"id": "shelter-threshold", "rect": rect(33.0, 13.3, 37.0, 16.0),
     "reason": "shelter approach south of the wind lock"},
    {"id": "travel-approach", "rect": rect(18.0, 18.0, 23.0, 23.0),
     "reason": "travel terminal interaction ring"},
    {"id": "spawn-clearance", "rect": rect(19.0, 22.0, 24.0, 25.5),
     "reason": "ordinary spawn arrival space"},
    {"id": "windbreak-lee", "rect": rect(4.0, 4.0, 36.5, 5.0),
     "reason": "1.0 m maintenance gap between ancient wall and human north walls"},
]

# Interaction clearances the layout must hold, in metres.
CLEARANCE_RULES = {
    "door_opening_min_m": 1.6,
    "walkway_min_m": 1.2,
    "terminal_front_min_m": 1.2,
    "npc_stand_min_m": 1.0,
    "player_circle_radius_m": 0.3,
    "player_height_m": 1.75,
}


# --------------------------------------------------------------------------
# derived collision + validation
# --------------------------------------------------------------------------


def collision_proxies(structure: dict[str, Any]) -> list[dict[str, Any]]:
    s = structure["shell"]
    door = structure["door"]
    opening = door["opening"]
    if door["wall"] in ("north", "south"):
        a, b = opening["x0"], opening["x1"]
    else:
        a, b = opening["y0"], opening["y1"]
    proxies = _wall_proxies(s["x0"], s["y0"], s["x1"], s["y1"],
                            structure["wall_thickness_m"], door["wall"], a, b)
    for ret in structure["wind_lock"]["returns"]:
        proxies.append({"name": ret["name"], "rect": ret["rect"]})
    for mass in structure.get("exterior_masses", []):
        proxies.append({"name": mass["name"], "rect": mass["rect"]})
    proxies.append({"name": "closed_door_panel", "rect": dict(opening),
                    "active_when": "door closed"})
    return proxies


def overlaps(a: dict[str, float], b: dict[str, float]) -> bool:
    return (a["x0"] < b["x1"] - 1e-9 and b["x0"] < a["x1"] - 1e-9
            and a["y0"] < b["y1"] - 1e-9 and b["y0"] < a["y1"] - 1e-9)


def contains(outer: dict[str, float], inner: dict[str, float]) -> bool:
    return (outer["x0"] <= inner["x0"] + 1e-9 and outer["y0"] <= inner["y0"] + 1e-9
            and outer["x1"] >= inner["x1"] - 1e-9 and outer["y1"] >= inner["y1"] - 1e-9)


def cell_rect(anchor: dict[str, Any]) -> dict[str, float]:
    return rect(anchor["i"], anchor["j"], anchor["i"] + 1, anchor["j"] + 1)


def terminal_cells_kept_clear() -> list[dict[str, Any]]:
    """Cells no wall, furniture, or door proxy may occupy."""
    keep: list[dict[str, Any]] = []
    for structure in STRUCTURES:
        for anchor in structure["anchors"]:
            if anchor["kind"] in ("terminal", "clone-pod", "npc-trainer", "respawn-point"):
                keep.append({"structure": structure["id"], "id": anchor["id"],
                             "cell": anchor["cell"]})
    return keep


def validate() -> list[str]:
    """Layout consistency checks. Returns a list of failures (empty = pass)."""
    errors: list[str] = []
    rules = CLEARANCE_RULES

    for structure in STRUCTURES:
        sid = structure["id"]
        shell = structure["shell"]
        fp = structure["footprint"]
        if round(shell["x1"] - shell["x0"], 6) != float(fp["east_cells"]):
            errors.append(f"{sid}: shell east span != footprint east_cells")
        if round(shell["y1"] - shell["y0"], 6) != float(fp["south_cells"]):
            errors.append(f"{sid}: shell south span != footprint south_cells")
        if [shell["x0"], shell["y0"]] != [float(fp["cell"][0]), float(fp["cell"][1])]:
            errors.append(f"{sid}: shell origin != footprint cell")

        walkable = structure["interior_walkable"]
        if not contains(shell, walkable):
            errors.append(f"{sid}: walkable interior escapes the shell")
        t = structure["wall_thickness_m"]
        if abs(walkable["x0"] - (shell["x0"] + t)) > 1e-9:
            errors.append(f"{sid}: walkable west edge != wall inner face")
        if abs(walkable["y1"] - (shell["y1"] - t)) > 1e-9:
            errors.append(f"{sid}: walkable south edge != wall inner face")

        door = structure["door"]
        opening = door["opening"]
        width = opening["x1"] - opening["x0"]
        if width < rules["door_opening_min_m"] - 1e-9:
            errors.append(f"{sid}: door opening {width:.2f} m below minimum")
        if not contains(shell, opening):
            errors.append(f"{sid}: door opening escapes the shell")
        if abs(door["slide_distance_m"] - DOOR_PANEL_WIDTH) > 1e-9:
            errors.append(f"{sid}: door slide distance must clear the panel width")

        lock = structure["wind_lock"]
        if lock["clear_span_m"] < width - 1e-9:
            errors.append(f"{sid}: wind lock clear span narrower than the door")
        if lock["clear_span_m"] < rules["walkway_min_m"] - 1e-9:
            errors.append(f"{sid}: wind lock clear span below walkway minimum")
        for ret in lock["returns"]:
            if overlaps(ret["rect"], opening):
                errors.append(f"{sid}: {ret['name']} blocks its own door opening")
            if overlaps(ret["rect"], shell):
                errors.append(f"{sid}: {ret['name']} intrudes the shell")
        if overlaps(lock["sill"], shell):
            errors.append(f"{sid}: wind lock sill intrudes the shell")
        for ret in lock["returns"]:
            if overlaps(ret["rect"], lock["sill"]):
                errors.append(f"{sid}: wind lock sill overlaps {ret['name']}")

        proxies = collision_proxies(structure)
        for keep in terminal_cells_kept_clear():
            if keep["structure"] != sid:
                continue
            kr = cell_rect(keep["cell"])
            for proxy in proxies:
                if overlaps(proxy["rect"], kr):
                    errors.append(
                        f"{sid}: proxy {proxy['name']} overlaps reserved cell "
                        f"{keep['id']}"
                    )
            for blocker in structure["furniture_blockers"]:
                if overlaps(blocker["rect"], kr):
                    errors.append(
                        f"{sid}: furniture {blocker['name']} overlaps reserved cell "
                        f"{keep['id']}"
                    )

        for anchor in structure["anchors"]:
            ar = cell_rect(anchor["cell"])
            if not contains(shell, ar):
                errors.append(f"{sid}: anchor {anchor['id']} outside the shell")

        for reserved in RESERVED_CLEAR:
            for proxy in proxies:
                if proxy["name"] == "closed_door_panel":
                    continue
                if overlaps(proxy["rect"], reserved["rect"]):
                    errors.append(
                        f"{sid}: proxy {proxy['name']} intrudes reserved region "
                        f"{reserved['id']}"
                    )
            for blocker in structure["furniture_blockers"]:
                if overlaps(blocker["rect"], reserved["rect"]):
                    errors.append(
                        f"{sid}: furniture {blocker['name']} intrudes reserved region "
                        f"{reserved['id']}"
                    )

    for sail in COMMERCE["shade_sails"]:
        if overlaps(sail["rect"], COMMERCE["wind_lock"]["sill"]):
            errors.append(f"commerce {sail['name']} covers the wind lock sill")
        for ret in COMMERCE["wind_lock"]["returns"]:
            if overlaps(sail["rect"], ret["rect"]):
                errors.append(f"commerce {sail['name']} collides with {ret['name']}")

    # ancient wall must not touch any human shell or reserved region
    for segment in ANCIENT["segments"]:
        for structure in STRUCTURES:
            if overlaps(segment["footprint"], structure["shell"]):
                errors.append(
                    f"ancient {segment['name']} overlaps {structure['id']} shell"
                )
        for reserved in RESERVED_CLEAR:
            if reserved["id"] == "windbreak-lee":
                continue
            if overlaps(segment["footprint"], reserved["rect"]):
                errors.append(
                    f"ancient {segment['name']} intrudes {reserved['id']}"
                )

    # freestanding items and open-ground points
    for item in FREESTANDING:
        for structure in STRUCTURES:
            if item["footprint"] and overlaps(item["footprint"], structure["shell"]):
                errors.append(f"{item['id']} overlaps {structure['id']}")
        for reserved in RESERVED_CLEAR:
            if reserved["id"] == item.get("own_reserved"):
                continue
            for proxy in item["collision_proxies"]:
                if overlaps(proxy["rect"], reserved["rect"]):
                    errors.append(
                        f"{item['id']} proxy {proxy['name']} intrudes reserved region "
                        f"{reserved['id']}"
                    )
    for point in POINTS:
        pr = cell_rect(point["cell"])
        inside = point.get("inside")
        for structure in STRUCTURES:
            hit = overlaps(pr, structure["shell"])
            if hit and structure["id"] != inside:
                errors.append(f"{point['id']} lands inside {structure['id']}")
            if hit and structure["id"] == inside:
                if not contains(structure["interior_walkable"], pr):
                    errors.append(f"{point['id']} not fully on walkable floor")

    # grid containment
    board = rect(0, 0, GRID_EAST_CELLS, GRID_SOUTH_CELLS)
    for structure in STRUCTURES:
        if not contains(board, structure["shell"]):
            errors.append(f"{structure['id']} escapes the local grid")
    return errors


def document() -> dict[str, Any]:
    return {
        "schema": "study.dustgate-opus5-layout.v1",
        "status": "source-stage proposal, not integrated, not canonical",
        "direction": "Leeward Terrace",
        "grid": {
            "east_cells": GRID_EAST_CELLS,
            "south_cells": GRID_SOUTH_CELLS,
            "cell_metres": CELL_METRES,
            "origin": "local cell (0, 0) is the north-west corner of the study block",
            "compass": COMPASS,
        },
        "connective_surface": {
            "roads": 0, "paths": 0, "aprons": 0, "kerbs": 0,
            "note": "the setting has no roads; the plaza is bare ground",
        },
        "clearance_rules": CLEARANCE_RULES,
        "camera_derived_rules": {
            "pitch_degrees": 60,
            "eave_shadow_metres": "eave_height / tan(60) - overhang, measured north of the eave edge",
            "consequence": (
                "thresholds, sills, and ground contact must sit SOUTH of the eave "
                "shadow line or they are invisible at gameplay framing"
            ),
            "max_south_eave_overhang_m": 0.55,
            "max_unbroken_roof_value_field_m": 3.2,
        },
        "ancient": ANCIENT,
        "structures": [
            {
                **{k: v for k, v in structure.items()},
                "collision_proxies": collision_proxies(structure),
            }
            for structure in STRUCTURES
        ],
        "terminal_cells_kept_clear": terminal_cells_kept_clear(),
        "freestanding": FREESTANDING,
        "points": POINTS,
        "reserved_clear": RESERVED_CLEAR,
        "node_families": {
            "roof": "roof__*",
            "walls": ["wall_front__* (south)", "wall_right__* (east)",
                      "wall_back__* (north)", "wall_left__* (west)"],
            "floor": "floor__*",
            "attached_mass": (
                "mass__* — non-enterable attached exterior masses (strongroom annex, "
                "hoist gantry, cistern, sail and porch posts). Never in a reveal set, "
                "so the cutaway cannot punch a hole in the exterior silhouette."
            ),
            "interior": "interior__*",
            "door": "door_slide",
            "cutaway_reveal_set": ["roof__", "wall_front__", "wall_right__"],
            "cutaway_keep_set": ["floor__", "interior__", "mass__", "door_slide",
                                 "wall_back__", "wall_left__"],
        },
    }


def to_json() -> str:
    return json.dumps(document(), indent=2, sort_keys=False) + "\n"


if __name__ == "__main__":
    import os
    import sys

    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    from dgpaths import proof

    failures = validate()
    path = proof("layout", "dustgate_selected_layout.json")
    with open(path, "w", encoding="utf-8") as handle:
        handle.write(to_json())
    print(f"[layout] wrote {path}")
    if failures:
        print(f"[layout] FAIL {len(failures)} consistency errors:")
        for line in failures:
            print(f"  - {line}")
        raise SystemExit(1)
    print("[layout] PASS all consistency checks")
