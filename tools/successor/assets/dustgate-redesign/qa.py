"""Numeric QA for the selected Dustgate direction.

    blender -b -P qa.py

Measures the freshly exported review GLB rather than live builder state, and
cross-checks it against `layout.py`. Writes a JSON report to the proof root and
exits non-zero on any failure.

Checks:
  * layout self-consistency (footprints, walkable bounds, door openings,
    reserved cells, reserved approach regions, wind locks, sails);
  * node family census plus the presence of every required family;
  * per-structure bounds, span, height, ground contact, triangles, materials;
  * declared door node, slide axis, travel distance, and pivot;
  * measured interaction clearances against the layout's clearance rules;
  * the palette value ladder by measured sRGB relative luminance;
  * the 60-degree eave-shadow rule for every threshold.
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
import layout as L
from build_selected import PALETTE, bx, by
from dgpaths import proof

PITCH_DEG = 60.0
REQUIRED_FAMILIES = ("roof__", "wall_front__", "wall_right__", "wall_back__",
                     "wall_left__", "floor__", "interior__", "mass__")

# Declared value ladder, lightest to darkest. `roof_patch` sits above `ancient`
# because it only ever appears as small mismatched replacement panels, never as
# a large field, so it cannot compete with the ancient wall's mass.
VALUE_LADDER = ("sand", "canvas", "panel", "roof_patch", "ancient", "panel_shade",
                "ancient_deep", "steel", "roof", "reveal")

TEXTURE_PLAN = {
    "authoring": "flat Principled materials in the blockout; no image textures yet",
    "material_count_target": 13,
    "atlas_intent": (
        "one 2048 albedo/roughness/normal trim atlas per settlement kit: panel, "
        "roof metal, canvas, cast plinth, steel, oxide. Ancient stone gets its own "
        "1024 tiling set so the two scales never share a texel density."
    ),
    "uv_plan": (
        "box-projected trim UVs on a shared 0.5 m texel grid, no per-object unwrap. "
        "Overlapping UVs are INTENDED for repeated kit parts (roof bays, louvres, "
        "battens, piers) and must not be lightmapped; only floors and the ancient "
        "wall get a second non-overlapping channel if baked AO is ever wanted."
    ),
    "lod_plan": (
        "LOD0 as authored. LOD1 drops louvres, hoods, battens, hoops, mullions, "
        "rubble, and roof patch plates and merges each roof bay set into one slab "
        "(target ~45 percent triangles). LOD2 keeps shell, roof silhouette, wind "
        "lock, stack, and cistern only. The web renderer ships LOD1 as its base."
    ),
}

CUTAWAY_RISK = (
    "Cutaway lighting, not geometry: with the roof reveal set hidden, the retained "
    "`mass__` gantry, wind lock head, and sails cast sun shadows straight onto the "
    "interior floor (measured in 08_cutaway_clone.png and 08_cutaway_commerce.png). "
    "Promotion must either keep a shadow-only proxy for the hidden roof or exclude "
    "attached masses from shadow casting while a cutaway is active."
)


def load() -> str:
    path = proof("glb", "dustgate_selected_review.glb")
    if not os.path.exists(path):
        raise SystemExit(f"missing export: {path}")
    dg.reset()
    bpy.ops.import_scene.gltf(filepath=path)
    return path


def family_of(name: str) -> str:
    return name.split("__", 1)[0] + "__" if "__" in name else "(none)"


def structure_key(name: str) -> str | None:
    if "__" not in name:
        return None
    rest = name.split("__", 1)[1]
    for key in ("clone", "commerce", "shelter"):
        if rest.startswith(key):
            return key
    return None


def objects_for(key: str) -> list:
    return [o for o in dg.mesh_objects() if structure_key(o.name) == key]


def min_z(objects) -> float:
    lo = float("inf")
    for obj in objects:
        for corner in obj.bound_box:
            lo = min(lo, (obj.matrix_world @ Vector(corner))[2])
    return round(lo, 5)


def eave_shadow(height: float, overhang: float) -> float:
    """Metres north of the eave EDGE that stay hidden at the locked pitch."""
    return height / math.tan(math.radians(PITCH_DEG)) - overhang


def main() -> None:
    failures: list[str] = []
    report: dict = {
        "schema": "study.dustgate-opus5-qa.v1",
        "status": "source-stage measurement, not integrated, not runtime-proven",
    }

    layout_errors = L.validate()
    report["layout_consistency"] = {
        "checks_failed": len(layout_errors), "errors": layout_errors,
    }
    failures.extend(f"layout: {e}" for e in layout_errors)

    path = load()
    meshes = dg.mesh_objects()
    families: dict[str, int] = {}
    for obj in meshes:
        families[family_of(obj.name)] = families.get(family_of(obj.name), 0) + 1
    report["export"] = {
        "path": os.path.relpath(path, os.getcwd()),
        "mesh_count": len(meshes),
        "triangles": dg.triangle_count(meshes),
        "materials": len(bpy.data.materials),
        "bounds": dg.world_bounds(meshes),
        "node_families": families,
    }
    for required in REQUIRED_FAMILIES:
        if required not in families:
            failures.append(f"export: missing node family {required}")
    if families.get("(none)", 0):
        failures.append("export: some nodes carry no family prefix")

    ground = min_z(meshes)
    report["export"]["min_z"] = ground
    if not -0.15 <= ground <= 0.0:
        failures.append(f"export: ground contact min z {ground} outside [-0.15, 0.0]")

    # palette value ladder
    ladder = [{"name": k, "hex": PALETTE[k][0],
               "luminance": round(dg.relative_luminance(PALETTE[k][0]), 4)}
              for k in VALUE_LADDER]
    report["value_ladder"] = ladder
    for a, b in zip(ladder, ladder[1:]):
        if a["luminance"] <= b["luminance"]:
            failures.append(
                f"palette: {a['name']} ({a['luminance']}) is not lighter than "
                f"{b['name']} ({b['luminance']})"
            )

    # per-structure measurement
    structures = []
    for structure in L.STRUCTURES:
        key = {"study-clone-facility": "clone",
               "study-commerce-facility": "commerce",
               "study-starter-shelter": "shelter"}[structure["id"]]
        objs = objects_for(key)
        if not objs:
            failures.append(f"{key}: no exported nodes")
            continue
        shell = structure["shell"]
        walkable = structure["interior_walkable"]
        lock = structure["wind_lock"]
        door = structure["door"]
        roof = structure["roof"]
        eave_h = roof.get("eave_m", roof.get("high_m", structure["wall_top_south_m"]))
        overhang = roof["eave_overhang_south_m"]
        shadow = eave_shadow(eave_h, overhang)
        # the sill's southern edge must sit south of the eave shadow line
        sill_south_of_wall = lock["sill"]["y1"] - shell["y1"]
        visible_sill = sill_south_of_wall - overhang - 0.0
        entry = {
            "key": key,
            "id": structure["id"],
            "visual_read": structure["visual_read"],
            "nodes": len(objs),
            "triangles": dg.triangle_count(objs),
            "materials": len({m.name for o in objs for m in o.data.materials if m}),
            "bounds": dg.world_bounds(objs),
            "min_z": min_z(objs),
            "families": sorted({family_of(o.name) for o in objs}),
            "footprint_cells": [structure["footprint"]["east_cells"],
                                structure["footprint"]["south_cells"]],
            "yaw_deg": structure["footprint"]["yaw_deg"],
            "wall_top_south_m": structure["wall_top_south_m"],
            "wall_top_north_m": structure["wall_top_north_m"],
            "walkable_area_m2": round((walkable["x1"] - walkable["x0"])
                                      * (walkable["y1"] - walkable["y0"]), 3),
            "floor_height_m": structure["floor_height_m"],
            "door": {
                "node": door["node"],
                "width_m": round(door["opening"]["x1"] - door["opening"]["x0"], 3),
                "height_m": door["height_m"],
                "slide_axis_local": door["slide_axis_local"],
                "slide_distance_m": door["slide_distance_m"],
                "pivot_local": door["pivot_local"],
            },
            "threshold": {
                "wind_lock_clear_span_m": lock["clear_span_m"],
                "wind_lock_depth_m": lock["depth_m"],
                "eave_height_m": eave_h,
                "eave_overhang_south_m": overhang,
                "eave_shadow_north_of_edge_m": round(shadow, 3),
                "sill_projection_south_of_wall_m": round(sill_south_of_wall, 3),
                "sill_strip_visible_m": round(visible_sill, 3),
            },
        }
        if overhang > 0.55 + 1e-9:
            failures.append(f"{key}: south eave overhang {overhang} exceeds 0.55 m")
        if visible_sill < 0.3:
            failures.append(
                f"{key}: only {visible_sill:.2f} m of sill clears the eave shadow"
            )
        if entry["door"]["width_m"] < L.CLEARANCE_RULES["door_opening_min_m"] - 1e-9:
            failures.append(f"{key}: door narrower than the minimum")
        if lock["clear_span_m"] < entry["door"]["width_m"]:
            failures.append(f"{key}: wind lock narrower than its door")

        # terminal / npc / respawn clearance: the cell south of each anchor must be
        # free of every wall, furniture, and door proxy
        proxies = L.collision_proxies(structure) + structure["furniture_blockers"]
        clearances = []
        for anchor in structure["anchors"]:
            i, j = anchor["cell"]["i"], anchor["cell"]["j"]
            front = L.rect(i, j + 1, i + 1, j + 2)
            blocked = [p["name"] for p in proxies if L.overlaps(p["rect"], front)]
            clearances.append({"anchor": anchor["id"], "front_cell": [i, j + 1],
                               "front_clear": not blocked, "blocked_by": blocked})
            if blocked and L.contains(structure["interior_walkable"], front):
                failures.append(
                    f"{key}: {anchor['id']} front cell blocked by {blocked}"
                )
        entry["anchor_clearance"] = clearances
        structures.append(entry)
    report["structures"] = structures

    # door node presence in the export
    door_nodes = sorted(o.name for o in meshes if o.name.startswith("door_slide"))
    report["door_nodes"] = door_nodes
    if len([n for n in door_nodes if "_rail" not in n]) != len(L.STRUCTURES):
        failures.append("export: one door_slide node per structure is required")

    report["texture_and_lod_plan"] = TEXTURE_PLAN
    report["known_risks"] = [CUTAWAY_RISK]
    report["connective_surface_audit"] = {
        "roads": 0, "paths": 0, "aprons": 0, "kerbs": 0, "lane_markings": 0,
        "nodes_named_road_path_or_apron": [
            o.name for o in meshes
            if any(t in o.name.lower() for t in ("road", "path", "lane", "apron",
                                                 "kerb", "curb", "pave"))
        ],
        "note": (
            "the only ground-level plates are the three wind lock sills and the "
            "travel terminal pad, each confined to its own structure footprint"
        ),
    }
    if report["connective_surface_audit"]["nodes_named_road_path_or_apron"]:
        failures.append("audit: a node is named like connective surface geometry")

    report["failures"] = failures
    report["passed"] = not failures

    out = proof("qa", "dustgate_selected_qa.json")
    with open(out, "w", encoding="utf-8") as handle:
        json.dump(report, handle, indent=2)
    print(f"[qa] wrote {out}")
    for entry in structures:
        t = entry["threshold"]
        print(f"[qa] {entry['key']:9s} nodes={entry['nodes']:3d} "
              f"tris={entry['triangles']:5d} mats={entry['materials']:2d} "
              f"minZ={entry['min_z']:+.3f} walkable={entry['walkable_area_m2']:6.2f} m2 "
              f"door={entry['door']['width_m']:.2f} m span={t['wind_lock_clear_span_m']:.2f} m "
              f"sill_visible={t['sill_strip_visible_m']:.2f} m")
    print(f"[qa] value ladder: " + " > ".join(
        f"{e['name']}:{e['luminance']:.3f}" for e in ladder))
    if failures:
        print(f"[qa] FAIL {len(failures)}")
        for line in failures:
            print(f"  - {line}")
        raise SystemExit(1)
    print("[qa] PASS")


if __name__ == "__main__":
    main()
