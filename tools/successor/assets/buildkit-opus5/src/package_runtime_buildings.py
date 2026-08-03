#!/usr/bin/env python3
"""Export the approved modular homes as self-contained runtime packages.

Run under the same Blender version used for the approved kit:

    blender -b --factory-startup -noaudio -P src/package_runtime_buildings.py -- \
      --output runtime-buildings/modular

The exporter composes the current ``home_plan`` functions rather than consuming
stale assembly JSON. It preserves approved geometry, furniture, materials, and
lighting meshes while packaging a closed, animated exterior entry for runtime.
"""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import math
import os
import struct
import sys
import tempfile
from pathlib import Path
from typing import Any

try:
    import bpy
    from mathutils import Vector
except ImportError as error:  # pragma: no cover - this is a Blender entry point
    raise SystemExit("package_runtime_buildings.py must run inside Blender") from error


ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

import assemble_home as Assembly
import kit_grid as Grid
import kit_spec as Kit
import pack_runtime_glb as RuntimePacker
import render_kit as Render


PACKAGE_SCHEMA = "successor.runtime-building-manifest.v1"
PROVENANCE_SCHEMA = "successor.runtime-building-provenance.v1"
COLLISION_SCHEMA = "successor.structure-collision.v3"
LOD = 0
FLOOR_TOP_M = 0.02
ROUND_DIGITS = 6

# Runtime keys and nominal lattice footprints are the shared contract.
PACKAGES = (
    {
        "plan": "home_starter",
        "key": "home_modular_starter",
        "label": "Modular Starter Home",
        "footprint_cells": (8, 6),
    },
    {
        "plan": "home_court",
        "key": "home_modular_court",
        "label": "Modular Courtyard Home",
        "footprint_cells": (10, 8),
    },
    {
        "plan": "home_wing",
        "key": "home_modular_wing",
        "label": "Modular Wing Home",
        "footprint_cells": (12, 10),
    },
)

# Keep this order identical to assemble_home.glb_path(): core first, then
# furniture, then architecture. A package fails rather than choosing a
# same-named module from the wrong lane.
MODULE_TREES = (
    ("core", ROOT / "build" / "modules", ROOT / "build" / "collision"),
    (
        "expansion_furniture",
        ROOT / "build" / "expansion_furniture" / "modules",
        ROOT / "build" / "expansion_furniture" / "collision",
    ),
    (
        "expansion_architecture",
        ROOT / "build" / "expansion_architecture" / "modules",
        ROOT / "build" / "expansion_architecture" / "collision",
    ),
)

REVEAL_PREFIXES = (
    "roof__",
    "wall_front__",
    "wall_back__",
    "wall_left__",
    "wall_right__",
    "wall_court__",
)
CUTAWAY_FACES = {
    "front": "wall_front__",
    "back": "wall_back__",
    "left": "wall_left__",
    "right": "wall_right__",
}


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _relative(path: Path) -> str:
    return path.resolve().relative_to(ROOT.resolve()).as_posix()


def _round(value: float) -> float:
    rounded = round(float(value), ROUND_DIGITS)
    return 0.0 if rounded == -0.0 else rounded


def _numbers(values: list[float] | tuple[float, ...]) -> list[float]:
    return [_round(value) for value in values]


def _write_json(path: Path, payload: dict[str, Any]) -> None:
    """Atomically write stable JSON without timestamps or machine-local data."""
    path.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(payload, indent=2, sort_keys=True) + "\n"
    with tempfile.NamedTemporaryFile(
        mode="w", encoding="utf-8", prefix=f".{path.name}.", suffix=".tmp",
        dir=path.parent, delete=False,
    ) as handle:
        temp_path = Path(handle.name)
        handle.write(text)
        handle.flush()
        os.fsync(handle.fileno())
    try:
        os.replace(temp_path, path)
    except BaseException:
        temp_path.unlink(missing_ok=True)
        raise


def _parse_args() -> argparse.Namespace:
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    parser = argparse.ArgumentParser(
        description="Export current modular-home plans as strict runtime packages"
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=Path("runtime-buildings/modular"),
        help="package output directory, relative to the asset root by default",
    )
    parser.add_argument(
        "--validate-only",
        action="store_true",
        help="re-import and validate existing package artifacts without rebuilding",
    )
    return parser.parse_args(argv)


def _module_id(item: dict[str, Any]) -> str:
    return f"{item['base']}__{item['finish']}"


def _module_files(item: dict[str, Any]) -> dict[str, Any]:
    """Locate one current LOD0 module and its matching collision record."""
    module_id = _module_id(item)
    filename = f"{module_id}_lod{LOD}.glb"
    collision_name = f"{module_id}.collision.json"
    for lane, module_dir, collision_dir in MODULE_TREES:
        glb = module_dir / filename
        if not glb.is_file():
            continue
        collision = collision_dir / collision_name
        if not collision.is_file():
            raise RuntimeError(
                f"{module_id}: LOD{LOD} GLB is present in {lane}, but collision "
                f"is missing: {_relative(collision)}"
            )
        return {
            "id": module_id,
            "lane": lane,
            "glb": glb,
            "collision": collision,
        }
    searched = ", ".join(_relative(directory) for _, directory, _ in MODULE_TREES)
    raise RuntimeError(f"{module_id}: no LOD{LOD} module GLB in {searched}")


def _plan_inputs(plan: Any) -> list[dict[str, Any]]:
    """Pair every current placement with its exact source artifacts in plan order."""
    inputs = []
    for index, item in enumerate(plan.items):
        record = dict(_module_files(item))
        record["index"] = index
        record["item"] = item
        inputs.append(record)
    return inputs


def _load_collision(record: dict[str, Any]) -> list[dict[str, Any]]:
    path = record["collision"]
    with path.open(encoding="utf-8") as handle:
        payload = json.load(handle)
    if payload.get("version") != COLLISION_SCHEMA:
        raise RuntimeError(f"{_relative(path)}: unsupported collision schema")
    if payload.get("module_id") != record["id"]:
        raise RuntimeError(
            f"{_relative(path)}: module_id {payload.get('module_id')!r} does not "
            f"match {record['id']!r}"
        )
    boxes = payload.get("boxes")
    if not isinstance(boxes, list):
        raise RuntimeError(f"{_relative(path)}: boxes must be a list")
    for box in boxes:
        if not isinstance(box, dict) or box.get("kind") not in {"structure", "door"}:
            raise RuntimeError(f"{_relative(path)}: unsupported collision box {box!r}")
        center, size = box.get("center"), box.get("size")
        if not (
            isinstance(center, list) and len(center) == 3
            and isinstance(size, list) and len(size) == 3
            and all(isinstance(value, (int, float)) and math.isfinite(value)
                    for value in center + size)
            and all(value > 0.0 for value in size)
        ):
            raise RuntimeError(f"{_relative(path)}: invalid collision box {box!r}")
    return boxes


def _transform_box(box: dict[str, Any], item: dict[str, Any]) -> dict[str, Any]:
    """Move a source axis-aligned box through a plan's right-angle transform."""
    center = box["center"]
    size = box["size"]
    rotation = float(item["rot"])
    x, z = Grid.rotate_xz(float(center[0]), float(center[2]), rotation)
    quarter_turn = int(round(rotation / 90.0)) % 2
    sx, sy, sz = (size[2], size[1], size[0]) if quarter_turn else size
    return {
        "kind": box["kind"],
        "center": _numbers((x + item["pos"][0], center[1] + item["pos"][1],
                            z + item["pos"][2])),
        "size": _numbers((sx, sy, sz)),
    }


def _xz_box(box: dict[str, Any], identifier: str) -> dict[str, Any]:
    """Project one placed collision box to the runtime sidecar's X/Z AABB."""
    center = box["center"]
    size = box["size"]
    return {
        "id": identifier,
        "minX": _round(center[0] - size[0] / 2.0),
        "minZ": _round(center[2] - size[2] / 2.0),
        "maxX": _round(center[0] + size[0] / 2.0),
        "maxZ": _round(center[2] + size[2] / 2.0),
    }


def _compact_xz_boxes(boxes: list[dict[str, Any]], identifier: str) -> dict[str, Any]:
    """Keep the runtime sidecar compact while retaining each placed module's extent."""
    projected = [_xz_box(box, identifier) for box in boxes]
    if not projected:
        raise RuntimeError(f"{identifier}: no collision boxes to compact")
    return {
        "id": identifier,
        "minX": _round(min(box["minX"] for box in projected)),
        "minZ": _round(min(box["minZ"] for box in projected)),
        "maxX": _round(max(box["maxX"] for box in projected)),
        "maxZ": _round(max(box["maxZ"] for box in projected)),
    }


def _clip_xz_box(
    box: dict[str, Any], bounds: dict[str, float]
) -> dict[str, Any] | None:
    """Clip a module proxy to its authored floor field, never enlarging occupancy."""
    clipped = {
        "id": box["id"],
        "minX": _round(max(box["minX"], bounds["minX"])),
        "minZ": _round(max(box["minZ"], bounds["minZ"])),
        "maxX": _round(min(box["maxX"], bounds["maxX"])),
        "maxZ": _round(min(box["maxZ"], bounds["maxZ"])),
    }
    return clipped if clipped["maxX"] > clipped["minX"] and clipped["maxZ"] > clipped["minZ"] else None


def _clip_xz_boxes(
    boxes: list[dict[str, Any]], bounds: dict[str, float], label: str
) -> list[dict[str, Any]]:
    clipped = [box for box in (_clip_xz_box(box, bounds) for box in boxes) if box]
    if not clipped:
        raise RuntimeError(f"{label}: all collision proxies lie outside the floor field")
    return clipped


def _is_furniture_base(base: str) -> bool:
    return base.startswith(("furn_", "xs_san_"))


def _is_runtime_wall_base(base: str) -> bool:
    """Structural X/Z blockers, excluding slabs, roofs, and exterior dressings."""
    return (
        base.startswith(("wall_", "window_", "corner_", "door_"))
        or base == "column"
    )


def _floor_bounds(inputs: list[dict[str, Any]]) -> dict[str, float]:
    floors = [
        record["item"] for record in inputs
        if record["item"]["base"] in {"floor_1x1", "floor_cham_1x1"}
    ]
    if not floors:
        raise RuntimeError("packaged plan has no placed floor modules")
    return {
        "minX": _round(min(item["pos"][0] - Kit.CELL / 2.0 for item in floors)),
        "minZ": _round(min(item["pos"][2] - Kit.CELL / 2.0 for item in floors)),
        "maxX": _round(max(item["pos"][0] + Kit.CELL / 2.0 for item in floors)),
        "maxZ": _round(max(item["pos"][2] + Kit.CELL / 2.0 for item in floors)),
    }


def _sidecar_footprint(
    floor_bounds: dict[str, float], boxes: list[dict[str, Any]], regions: list[dict[str, Any]]
) -> dict[str, float]:
    """Envelope every exported X/Z proxy; render overhangs stay out of this proxy."""
    all_bounds = [floor_bounds, *boxes, *regions]
    min_x = min(bounds["minX"] for bounds in all_bounds)
    min_z = min(bounds["minZ"] for bounds in all_bounds)
    max_x = max(bounds["maxX"] for bounds in all_bounds)
    max_z = max(bounds["maxZ"] for bounds in all_bounds)
    if not (max_x > min_x and max_z > min_z):
        raise RuntimeError("collision footprint has no positive X/Z area")
    return {
        "minX": _round(min_x),
        "minZ": _round(min_z),
        "maxX": _round(max_x),
        "maxZ": _round(max_z),
        "spanX": _round(max_x - min_x),
        "spanZ": _round(max_z - min_z),
        "centerX": _round((min_x + max_x) / 2.0),
        "centerZ": _round((min_z + max_z) / 2.0),
    }


def _entry_safe_footprint(
    floor_bounds: dict[str, float], closed_door: dict[str, Any], entry_record: dict[str, Any]
) -> dict[str, float]:
    """Keep a centrally placed courtyard entry's exterior side unambiguous.

    The fixture adapter derives a doorway's outward normal from its offset from
    the sidecar center.  Approved home_court places its south-facing courtyard
    entry on the plan centreline, so reserve only one wall-thickness of empty
    threshold space on the opposite (north) edge when that condition occurs.
    """
    footprint = _sidecar_footprint(floor_bounds, [], [])
    center_x = (closed_door["minX"] + closed_door["maxX"]) / 2.0
    center_z = (closed_door["minZ"] + closed_door["maxZ"]) / 2.0
    facing = _entry_facing(entry_record["item"]["rot"])
    centered = (
        abs(center_z - footprint["centerZ"]) <= 1e-6
        if facing in {"north", "south"}
        else abs(center_x - footprint["centerX"]) <= 1e-6
    )
    if not centered:
        return footprint
    margin = 0.1
    if facing == "south":
        footprint["maxZ"] = _round(footprint["maxZ"] + margin)
    elif facing == "north":
        footprint["minZ"] = _round(footprint["minZ"] - margin)
    elif facing == "east":
        footprint["minX"] = _round(footprint["minX"] - margin)
    else:
        footprint["maxX"] = _round(footprint["maxX"] + margin)
    footprint["spanX"] = _round(footprint["maxX"] - footprint["minX"])
    footprint["spanZ"] = _round(footprint["maxZ"] - footprint["minZ"])
    footprint["centerX"] = _round((footprint["minX"] + footprint["maxX"]) / 2.0)
    footprint["centerZ"] = _round((footprint["minZ"] + footprint["maxZ"]) / 2.0)
    return footprint


def _build_collision(
    key: str, plan: Any, inputs: list[dict[str, Any]], entry_record: dict[str, Any]
) -> tuple[dict[str, Any], dict[str, int]]:
    """Derive both source-accurate 3D boxes and runtime fixture-compatible X/Z proxies.

    `boxes` preserves every placed structural record for diagnostics.  The
    top-level v3 fields are intentionally compacted per placed module: they are
    the physical blocker contract consumed by structureCollisionFromSidecar.
    """
    boxes: list[dict[str, Any]] = []
    walls: list[dict[str, Any]] = []
    furniture: list[dict[str, Any]] = []
    entry_leaf_boxes: list[dict[str, Any]] = []
    floor_boxes: list[dict[str, Any]] = []
    counts = {"source_records": 0, "structure": 0, "door": 0}

    for record in inputs:
        base = record["item"]["base"]
        placed_structures: list[dict[str, Any]] = []
        placed_doors: list[dict[str, Any]] = []
        for source_box in _load_collision(record):
            counts["source_records"] += 1
            transformed = _transform_box(source_box, record["item"])
            boxes.append(transformed)
            counts[transformed["kind"]] += 1
            if transformed["kind"] == "structure":
                placed_structures.append(transformed)
            else:
                placed_doors.append(transformed)

        placement_id = f"{record['index']:03d}_{record['id']}"
        if _is_furniture_base(base):
            if placed_structures:
                furniture.append(_compact_xz_boxes(placed_structures, f"furniture_{placement_id}"))
        elif _is_runtime_wall_base(base):
            # Interior leaves have no runtime animation record and therefore
            # intentionally remain static blockers; only the exterior leaf is
            # represented by the dedicated top-level door record below.
            blockers = placed_structures
            if base == "door_inner_2c":
                blockers = [*blockers, *placed_doors]
            if blockers:
                walls.append(_compact_xz_boxes(blockers, f"wall_{placement_id}"))

        if record is entry_record:
            entry_leaf_boxes.extend(placed_doors)
        if base in {"floor_1x1", "floor_cham_1x1"}:
            floor_boxes.extend(placed_structures)

    if not boxes or not counts["structure"] or not counts["door"]:
        raise RuntimeError(
            f"{key}: expected structure and door collision boxes, got {counts}"
        )
    if not walls or not furniture or not entry_leaf_boxes:
        raise RuntimeError(
            f"{key}: incomplete runtime collision proxies "
            f"(walls={len(walls)}, furniture={len(furniture)}, entry={len(entry_leaf_boxes)})"
        )

    regions = _interior_regions(plan)
    floor_bounds = _floor_bounds(inputs)
    floor_slabs = [
        box["size"][1]
        for box in floor_boxes
        if abs(box["center"][1] + box["size"][1] / 2.0 - FLOOR_TOP_M) <= 0.0001
    ]
    if not floor_slabs:
        raise RuntimeError(f"{key}: no floor collision slab reaches {FLOOR_TOP_M}m")
    # The runtime footprint is the authored floor field, not wall thickness or
    # roof/apron overhang.  Clamp edge proxies so every exported X/Z blocker is
    # within that exact contracted occupancy rectangle.
    walls = _clip_xz_boxes(walls, floor_bounds, f"{key}: walls")
    furniture = _clip_xz_boxes(furniture, floor_bounds, f"{key}: furniture")
    closed_door = _clip_xz_box(
        _compact_xz_boxes(entry_leaf_boxes, "closed_exterior_entry"), floor_bounds
    )
    if closed_door is None:
        raise RuntimeError(f"{key}: exterior door lies outside its floor field")
    footprint = _entry_safe_footprint(floor_bounds, closed_door, entry_record)

    return (
        {
            "schema": COLLISION_SCHEMA,
            # Retained for the current module-sidecar convention and tooling.
            "version": COLLISION_SCHEMA,
            "module_id": key,
            "source": f"{key}.glb",
            "generatedBy": "src/package_runtime_buildings.py",
            "footprint": footprint,
            "floor": {
                "topY": FLOOR_TOP_M,
                "slabThicknessM": _round(min(floor_slabs)),
                "bounds": floor_bounds,
            },
            "walls": walls,
            "furniture": furniture,
            "door": {
                "node": "door_slide",
                "closed": closed_door,
            },
            "interiorRegions": regions,
            "contract": {
                "geometrySource": "placed_module_collision_records",
                "structuralRoles": ["walls", "windows", "columns", "static_internal_doors"],
                "furnitureRoles": ["furn_*", "xs_san_*"],
                "decorativeExcluded": [
                    "foundation", "floor", "ceiling", "roof", "entry_apron", "entry_hood"
                ],
                "interiorDoorPolicy": "closed_static",
            },
            "boxes": boxes,
        },
        counts,
    )


def _exterior_door_record(inputs: list[dict[str, Any]]) -> dict[str, Any]:
    exterior = [record for record in inputs if record["item"]["base"] == "door_slide_2c"]
    if len(exterior) != 1:
        raise RuntimeError(
            "an exported home must currently have exactly one exterior door_slide_2c; "
            f"found {len(exterior)}"
        )
    return exterior[0]


def _entry_cells(item: dict[str, Any]) -> list[list[int]]:
    """Derive the two lattice cells consumed by the approved 2-cell entry."""
    x, _y, z = item["pos"]
    node_x = round(x / Kit.CELL)
    node_z = round(z / Kit.CELL)
    if abs(x - node_x * Kit.CELL) > 1e-5 or abs(z - node_z * Kit.CELL) > 1e-5:
        raise RuntimeError(f"entry door is not node-anchored: {item['pos']}")
    rotation = int(round(item["rot"])) % 360
    if rotation in (0, 180):
        return [[node_x - 1, node_z], [node_x, node_z]]
    if rotation in (90, 270):
        return [[node_x, node_z - 1], [node_x, node_z]]
    raise RuntimeError(f"entry door rotation is not cardinal: {item['rot']}")


def _entry_facing(rotation: float) -> str:
    return {0: "north", 90: "east", 180: "south", 270: "west"}[int(round(rotation)) % 360]


def _axis_vector(axis: str) -> list[int]:
    if axis == "+X":
        return [1, 0, 0]
    if axis == "-X":
        return [-1, 0, 0]
    raise RuntimeError(f"unsupported exterior door local axis {axis!r}")


def _entry_door(inputs: list[dict[str, Any]]) -> tuple[dict[str, Any], dict[str, Any]]:
    """Select the approved entry and preserve its source door contract exactly."""
    record = _exterior_door_record(inputs)
    manifest_path = ROOT / "build" / "buildkit.manifest.json"
    with manifest_path.open(encoding="utf-8") as handle:
        module_manifest = json.load(handle)
    source_door = module_manifest.get("modules", {}).get(record["id"], {}).get("door")
    if not isinstance(source_door, dict):
        raise RuntimeError(f"{record['id']}: exterior door contract is missing")
    if source_door.get("node") != "door_slide":
        raise RuntimeError(
            f"{record['id']}: exterior door node must be 'door_slide', got "
            f"{source_door.get('node')!r}"
        )
    clips = source_door.get("clips")
    if clips != ["door_close", "door_open"]:
        raise RuntimeError(f"{record['id']}: unexpected exterior door clips {clips!r}")

    item = record["item"]
    entry = {
        "kind": "exterior_entry",
        "module_id": record["id"],
        "placement_index": record["index"],
        "position_m": _numbers(item["pos"]),
        "rotation_y_deg": _round(item["rot"]),
        "facing": _entry_facing(item["rot"]),
        "door_cells": _entry_cells(item),
        "closed_in_glb": True,
        "node": "door_slide",
        "axis": source_door["axis"],
        "axis_local": _axis_vector(source_door["axis"]),
        "closed_offset_m": _round(source_door["closed_offset_m"]),
        "open_offset_m": _round(source_door["open_offset_m"]),
        "travel_m": _round(source_door["travel_m"]),
        "clear_opening_m": _numbers(source_door["clear_opening_m"]),
        "clips": list(clips),
        "clip_seconds": _round(source_door["clip_seconds"]),
    }
    return entry, record


def _reportable_prefix(item: dict[str, Any]) -> str:
    """Give runtime cutaway systems stable names without renaming geometry."""
    base = item["base"]
    note = item["note"].lower()
    if base.startswith(("floor_", "found_", "foundation_")):
        return "floor__"
    if (
        base.startswith(("furn_", "xs_san_", "ceiling_"))
        or base == "door_inner_2c"
        or "partition" in note
        or "entry screen" in note
        or "kitchen screen" in note
    ):
        return "interior__"
    if base.startswith("roof_"):
        return "roof__"
    if base == "corner_inner":
        return "interior__"
    if not (
        base.startswith("wall_")
        or base.startswith("window_")
        or base in {"door_slide_2c", "entry_apron_2c", "entry_hood_2c", "corner_outer", "column"}
    ):
        return "runtime__"
    for words, prefix in (
        (("front", "south"), "wall_front__"),
        (("right", "east"), "wall_right__"),
        (("back", "north"), "wall_back__"),
        (("left", "west"), "wall_left__"),
        (("court",), "wall_court__"),
    ):
        if any(word in note for word in words):
            return prefix
    return "runtime__"


def _rename_imported_objects(
    imported: list[Any], index: int, module_id: str, item: dict[str, Any]
) -> None:
    """Keep module identity while exposing stable roof, wall, floor, interior names."""
    marker = f"{_reportable_prefix(item)}{index:04d}_{module_id}"
    for object_index, obj in enumerate(imported):
        if obj.type == "MESH":
            original = obj.name.replace(" ", "_")
            obj.name = f"{marker}_{object_index:03d}_{original}"
    if item["base"] == "door_slide_2c":
        door_nodes = [obj for obj in imported if obj.name.startswith("door_slide")]
        if len(door_nodes) != 1:
            raise RuntimeError(
                f"{module_id}: expected one imported door_slide node, found "
                f"{len(door_nodes)}"
            )
        door_nodes[0].name = "door_slide"
    imported[-1].name = f"runtime_{index:04d}_{module_id}"


def _assemble_for_export(inputs: list[dict[str, Any]]) -> None:
    """Import only placed module GLBs, in their approved closed door poses."""
    Render.wipe()
    # Names participate in the emitted GLB; reset the importer counter so one
    # package is independent of the order requested in this Blender process.
    Render._INST_N[0] = 0
    for record in inputs:
        item = record["item"]
        imported = Render.import_glb(
            str(record["glb"]), item["pos"], item["rot"], record["id"]
        )
        _rename_imported_objects(imported, record["index"], record["id"], item)
    bpy.context.view_layer.update()


def _pack_images() -> None:
    """Make the Blender export self-contained before the strict byte packer runs."""
    for image in bpy.data.images:
        if image.source == "FILE" and image.packed_file is None:
            image.pack()


def _export_raw_glb(path: Path) -> None:
    """Use the kit's tangent/material convention without externalising images."""
    path.parent.mkdir(parents=True, exist_ok=True)
    _pack_images()
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.export_scene.gltf(
        filepath=str(path),
        export_format="GLB",
        use_selection=True,
        export_yup=True,
        export_apply=True,
        export_vertex_color="ACTIVE",
        export_all_vertex_colors=False,
        export_attributes=False,
        export_normals=True,
        export_tangents=True,
        export_texcoords=True,
        export_materials="EXPORT",
        export_image_format="AUTO",
        export_cameras=False,
        export_lights=False,
        export_extras=False,
        export_animations=False,
    )


def _glb_document(path: Path) -> tuple[dict[str, Any], bytearray]:
    document, binary = RuntimePacker._read_glb(path)
    RuntimePacker._validate_runtime_contract(document, path)
    return document, binary


def _append_source_view(
    destination: dict[str, Any], destination_binary: bytearray,
    source: dict[str, Any], source_binary: bytearray, source_index: int,
) -> int:
    source_view = source["bufferViews"][source_index]
    offset = source_view.get("byteOffset", 0)
    length = source_view["byteLength"]
    payload = source_binary[offset:offset + length]
    if len(payload) != length:
        raise RuntimeError("source door animation bufferView exceeds binary chunk")
    RuntimePacker._align4(destination_binary)
    destination_index = len(destination.setdefault("bufferViews", []))
    copied = {
        key: copy.deepcopy(value)
        for key, value in source_view.items()
        if key not in {"buffer", "byteOffset", "byteLength"}
    }
    destination["bufferViews"].append({
        "buffer": 0,
        "byteOffset": len(destination_binary),
        "byteLength": length,
        **copied,
    })
    destination_binary.extend(payload)
    return destination_index


def _copy_animation_accessor(
    destination: dict[str, Any], destination_binary: bytearray,
    source: dict[str, Any], source_binary: bytearray, source_index: int,
    accessor_map: dict[int, int], view_map: dict[int, int],
) -> int:
    existing = accessor_map.get(source_index)
    if existing is not None:
        return existing
    source_accessor = source["accessors"][source_index]
    if source_accessor.get("sparse") is not None:
        raise RuntimeError("sparse exterior door animation accessors are unsupported")
    copied = copy.deepcopy(source_accessor)
    if "bufferView" in copied:
        source_view = copied["bufferView"]
        destination_view = view_map.get(source_view)
        if destination_view is None:
            destination_view = _append_source_view(
                destination, destination_binary, source, source_binary, source_view
            )
            view_map[source_view] = destination_view
        copied["bufferView"] = destination_view
    destination_index = len(destination.setdefault("accessors", []))
    destination["accessors"].append(copied)
    accessor_map[source_index] = destination_index
    return destination_index


def _inject_entry_animations(path: Path, source_path: Path, entry: dict[str, Any]) -> None:
    """Copy source entry clips onto the composed asset's exact door_slide node.

    Blender imports source door clips as live NLA strips and the normal assembly
    path deliberately clears them to get a closed rest pose. Rebuilding an
    animation stack for a composed asset would change authored door behavior, so
    this copies the shipped accessors/channels byte-for-byte after packing.
    """
    destination, destination_binary = _glb_document(path)
    source, source_binary = RuntimePacker._read_glb(source_path)
    source_names = [node.get("name", "") for node in source.get("nodes", [])]
    destination_names = [node.get("name", "") for node in destination.get("nodes", [])]
    if source_names.count("door_slide") != 1 or destination_names.count("door_slide") != 1:
        raise RuntimeError("entry door animation requires exactly one source and destination door_slide")
    source_node = source_names.index("door_slide")
    destination_node = destination_names.index("door_slide")
    if destination.get("animations"):
        raise RuntimeError("composed GLB unexpectedly already has animations")

    source_animations = source.get("animations", [])
    by_name = {animation.get("name"): animation for animation in source_animations}
    if set(by_name) != set(entry["clips"]):
        raise RuntimeError(f"source exterior clips drifted: {sorted(by_name)}")

    accessor_map: dict[int, int] = {}
    view_map: dict[int, int] = {}
    copied_animations = []
    for clip_name in entry["clips"]:
        animation = by_name[clip_name]
        channels = [
            channel for channel in animation.get("channels", [])
            if channel.get("target", {}).get("node") == source_node
        ]
        if len(channels) != 1 or channels[0].get("target", {}).get("path") != "translation":
            raise RuntimeError(f"{clip_name}: expected one door_slide translation channel")
        source_sampler_index = channels[0]["sampler"]
        source_sampler = animation.get("samplers", [])[source_sampler_index]
        sampler = {
            "input": _copy_animation_accessor(
                destination, destination_binary, source, source_binary,
                source_sampler["input"], accessor_map, view_map,
            ),
            "output": _copy_animation_accessor(
                destination, destination_binary, source, source_binary,
                source_sampler["output"], accessor_map, view_map,
            ),
        }
        if "interpolation" in source_sampler:
            sampler["interpolation"] = source_sampler["interpolation"]
        copied_animations.append({
            "name": clip_name,
            "samplers": [sampler],
            "channels": [{
                "sampler": 0,
                "target": {"node": destination_node, "path": "translation"},
            }],
        })
    destination["animations"] = copied_animations
    RuntimePacker._write_glb(path, destination, destination_binary)


def _triangles(document: dict[str, Any]) -> int:
    accessors = document.get("accessors", [])
    total = 0
    for mesh in document.get("meshes", []):
        for primitive in mesh.get("primitives", []):
            index = primitive.get("indices")
            if index is None:
                position = primitive.get("attributes", {}).get("POSITION")
                if position is None:
                    raise RuntimeError("runtime GLB primitive has no POSITION")
                count = accessors[position]["count"]
            else:
                count = accessors[index]["count"]
            if count % 3:
                raise RuntimeError("runtime GLB primitive does not contain whole triangles")
            total += count // 3
    return total


def _node_names(document: dict[str, Any]) -> list[str]:
    return [node.get("name", "") for node in document.get("nodes", [])]


def _validate_embedded_images(document: dict[str, Any], path: Path) -> int:
    images = document.get("images", [])
    for index, image in enumerate(images):
        if "uri" in image:
            raise RuntimeError(f"{_relative(path)}: image {index} has external URI")
        if image.get("mimeType") not in {"image/png", "image/jpeg"}:
            raise RuntimeError(f"{_relative(path)}: image {index} has unsupported mimeType")
        if "bufferView" not in image:
            raise RuntimeError(f"{_relative(path)}: image {index} is not embedded")
    if not images:
        raise RuntimeError(f"{_relative(path)}: package lost all PBR images")
    return len(images)


def _accessor_values(
    document: dict[str, Any], binary: bytearray, accessor_index: int
) -> list[tuple[float, ...]]:
    accessor = document["accessors"][accessor_index]
    if accessor.get("componentType") != 5126 or accessor.get("sparse") is not None:
        raise RuntimeError("door animation accessor must be dense float32")
    components = {"SCALAR": 1, "VEC3": 3}.get(accessor.get("type"))
    if components is None or accessor.get("count", 0) < 2:
        raise RuntimeError("door animation accessor must have at least two scalar/vector samples")
    view = document["bufferViews"][accessor["bufferView"]]
    stride = view.get("byteStride", components * 4)
    if stride < components * 4:
        raise RuntimeError("door animation accessor has an invalid stride")
    start = view.get("byteOffset", 0) + accessor.get("byteOffset", 0)
    result = []
    for row in range(accessor["count"]):
        offset = start + row * stride
        if offset + components * 4 > len(binary):
            raise RuntimeError("door animation accessor exceeds binary chunk")
        result.append(struct.unpack_from(f"<{components}f", binary, offset))
    return result


def _validate_entry_animation(
    document: dict[str, Any], binary: bytearray, entry: dict[str, Any]
) -> None:
    names = _node_names(document)
    if names.count("door_slide") != 1:
        raise RuntimeError("runtime GLB must contain exactly one door_slide node")
    door_node = names.index("door_slide")
    by_name = {animation.get("name"): animation for animation in document.get("animations", [])}
    if set(by_name) != set(entry["clips"]):
        raise RuntimeError(f"runtime door clips drifted: {sorted(by_name)}")
    axis = entry["axis_local"]
    axis_index = next(index for index, value in enumerate(axis) if value)
    sign = axis[axis_index]
    for clip_name in entry["clips"]:
        animation = by_name[clip_name]
        channels = animation.get("channels", [])
        if len(channels) != 1:
            raise RuntimeError(f"{clip_name}: expected exactly one channel")
        channel = channels[0]
        if channel.get("target", {}).get("node") != door_node or channel.get("target", {}).get("path") != "translation":
            raise RuntimeError(f"{clip_name}: targets the wrong runtime door node")
        sampler = animation.get("samplers", [])[channel["sampler"]]
        times = _accessor_values(document, binary, sampler["input"])
        values = _accessor_values(document, binary, sampler["output"])
        duration = times[-1][0] - times[0][0]
        if abs(duration - entry["clip_seconds"]) > 0.002:
            raise RuntimeError(f"{clip_name}: duration {duration} differs from door contract")
        displacement = values[-1][axis_index] - values[0][axis_index]
        expected = entry["travel_m"] * sign * (1.0 if clip_name == "door_open" else -1.0)
        off_axis = [
            values[-1][index] - values[0][index]
            for index in range(3) if index != axis_index
        ]
        if abs(displacement - expected) > 0.002 or any(abs(value) > 0.002 for value in off_axis):
            raise RuntimeError(f"{clip_name}: displacement does not match door contract")


def _reimport_bounds(path: Path) -> tuple[list[list[float]], int, int]:
    """Import final bytes into a fresh Blender scene and measure kit-axis bounds."""
    Render.wipe()
    bpy.ops.import_scene.gltf(filepath=str(path))
    bpy.context.view_layer.update()
    meshes = [obj for obj in bpy.data.objects if obj.type == "MESH"]
    if not meshes:
        raise RuntimeError(f"{_relative(path)}: Blender re-import produced no meshes")
    low = [math.inf, math.inf, math.inf]
    high = [-math.inf, -math.inf, -math.inf]
    for obj in meshes:
        for corner in obj.bound_box:
            world = obj.matrix_world @ Vector(corner)
            # render_kit.kit_to_bl() is (x, -z, y), so this is its inverse.
            values = (world.x, world.z, -world.y)
            for axis, value in enumerate(values):
                low[axis] = min(low[axis], value)
                high[axis] = max(high[axis], value)
    return [_numbers(low), _numbers(high)], len(meshes), len(bpy.data.materials)


def _furnished_placement_markers(inputs: list[dict[str, Any]]) -> list[str]:
    markers = []
    for record in inputs:
        base = record["item"]["base"]
        if base.startswith("furn_") or base.startswith("xs_san_"):
            markers.append(f"interior__{record['index']:04d}_{record['id']}")
    if not markers:
        raise RuntimeError("plan contains no furnished placements")
    return markers


def _validate_prefixes(node_names: list[str]) -> None:
    required = ("roof__", "floor__", "interior__", *CUTAWAY_FACES.values())
    missing = [prefix for prefix in required if not any(name.startswith(prefix) for name in node_names)]
    if missing:
        raise RuntimeError(f"runtime GLB lost required stable node prefixes: {missing}")


def _validate_plan_glb(
    path: Path, inputs: list[dict[str, Any]], footprint_cells: tuple[int, int], entry: dict[str, Any]
) -> dict[str, Any]:
    document, binary = _glb_document(path)
    images = _validate_embedded_images(document, path)
    node_names = _node_names(document)
    _validate_prefixes(node_names)
    missing = [marker for marker in _furnished_placement_markers(inputs)
               if not any(marker in name for name in node_names)]
    if missing:
        raise RuntimeError(
            f"{_relative(path)}: re-export lost furnished module identities: {missing[:3]}"
        )
    _validate_entry_animation(document, binary, entry)
    bounds, meshes, materials = _reimport_bounds(path)
    if meshes <= 0 or materials <= 0:
        raise RuntimeError(f"{_relative(path)}: invalid re-import mesh/material count")

    # Plans use a nominal cell footprint. Their approved beveled roof rim and
    # entry apron may overhang it, so the actual visual bbox is published while
    # exact occupancy comes from the placed floor field below.
    width = footprint_cells[0] * Kit.CELL
    depth = footprint_cells[1] * Kit.CELL
    floor_records = [record for record in inputs
                     if record["item"]["base"] in {"floor_1x1", "floor_cham_1x1"}]
    floor_items = [record["item"] for record in floor_records]
    if not floor_items:
        raise RuntimeError(f"{_relative(path)}: plan has no floor-field placements")
    min_floor_x = min(item["pos"][0] - Kit.CELL / 2.0 for item in floor_items)
    max_floor_x = max(item["pos"][0] + Kit.CELL / 2.0 for item in floor_items)
    min_floor_z = min(item["pos"][2] - Kit.CELL / 2.0 for item in floor_items)
    max_floor_z = max(item["pos"][2] + Kit.CELL / 2.0 for item in floor_items)
    footprint_bounds = [[_round(min_floor_x), _round(min_floor_z)],
                        [_round(max_floor_x), _round(max_floor_z)]]
    if (
        abs((max_floor_x - min_floor_x) - width) > 0.001
        or abs((max_floor_z - min_floor_z) - depth) > 0.001
    ):
        raise RuntimeError(
            f"{_relative(path)}: floor field {footprint_bounds} does not match "
            f"declared {footprint_cells} cells"
        )
    floor_tops = [
        box["center"][1] + box["size"][1] / 2.0 + record["item"]["pos"][1]
        for record in floor_records
        for box in _load_collision(record)
        if box["kind"] == "structure"
    ]
    if not floor_tops or any(abs(top - FLOOR_TOP_M) > 0.0001 for top in floor_tops):
        raise RuntimeError(
            f"{_relative(path)}: placed floor collision does not top at {FLOOR_TOP_M}m"
        )
    return {
        "images_embedded": images,
        "mesh_nodes": meshes,
        "materials": materials,
        "triangles": _triangles(document),
        "nodes": len(node_names),
        "bounds_m": bounds,
        "footprint_bounds_m": footprint_bounds,
        "floor_top_m": FLOOR_TOP_M,
        "furnished_placements": len(_furnished_placement_markers(inputs)),
    }


def _validate_sidecar_xz_box(
    box: Any, footprint: dict[str, Any], label: str
) -> None:
    if not isinstance(box, dict):
        raise RuntimeError(f"{label}: expected an object")
    values = [box.get(field) for field in ("minX", "minZ", "maxX", "maxZ")]
    if not all(isinstance(value, (int, float)) and math.isfinite(value) for value in values):
        raise RuntimeError(f"{label}: invalid X/Z bounds")
    min_x, min_z, max_x, max_z = values
    if not (max_x > min_x and max_z > min_z):
        raise RuntimeError(f"{label}: non-positive X/Z bounds")
    epsilon = 1e-6
    if (
        min_x < footprint["minX"] - epsilon
        or max_x > footprint["maxX"] + epsilon
        or min_z < footprint["minZ"] - epsilon
        or max_z > footprint["maxZ"] + epsilon
    ):
        raise RuntimeError(f"{label}: lies outside collision footprint")


def _validate_collision(path: Path, expected_key: str) -> dict[str, int]:
    """Validate the exact raw contract consumed by structureCollisionFromSidecar."""
    with path.open(encoding="utf-8") as handle:
        payload = json.load(handle)
    if (
        payload.get("schema") != COLLISION_SCHEMA
        or payload.get("version") != COLLISION_SCHEMA
        or payload.get("module_id") != expected_key
        or payload.get("source") != f"{expected_key}.glb"
    ):
        raise RuntimeError(f"{_relative(path)}: collision header is invalid")

    footprint = payload.get("footprint")
    if not isinstance(footprint, dict):
        raise RuntimeError(f"{_relative(path)}: footprint is missing")
    values = [footprint.get(field) for field in ("minX", "minZ", "maxX", "maxZ")]
    if not all(isinstance(value, (int, float)) and math.isfinite(value) for value in values):
        raise RuntimeError(f"{_relative(path)}: footprint bounds are invalid")
    min_x, min_z, max_x, max_z = values
    if not (max_x > min_x and max_z > min_z):
        raise RuntimeError(f"{_relative(path)}: footprint has no positive X/Z area")
    expected_footprint = {
        "spanX": max_x - min_x,
        "spanZ": max_z - min_z,
        "centerX": (min_x + max_x) / 2.0,
        "centerZ": (min_z + max_z) / 2.0,
    }
    for field, expected in expected_footprint.items():
        actual = footprint.get(field)
        if not isinstance(actual, (int, float)) or not math.isfinite(actual) or abs(actual - expected) > 1e-6:
            raise RuntimeError(f"{_relative(path)}: footprint {field} drifted")

    floor = payload.get("floor")
    if not isinstance(floor, dict) or not all(
        isinstance(floor.get(field), (int, float)) and math.isfinite(floor[field])
        for field in ("topY", "slabThicknessM")
    ) or floor["slabThicknessM"] <= 0.0:
        raise RuntimeError(f"{_relative(path)}: floor contract is invalid")
    if abs(floor["topY"] - FLOOR_TOP_M) > 0.0001:
        raise RuntimeError(f"{_relative(path)}: floor top drifted")

    walls = payload.get("walls")
    furniture = payload.get("furniture")
    regions = payload.get("interiorRegions")
    door = payload.get("door")
    if not isinstance(walls, list) or not walls:
        raise RuntimeError(f"{_relative(path)}: walls are missing")
    if not isinstance(furniture, list) or not furniture:
        raise RuntimeError(f"{_relative(path)}: furniture is missing")
    if not isinstance(regions, list) or not regions:
        raise RuntimeError(f"{_relative(path)}: interiorRegions are missing")
    if not isinstance(door, dict) or door.get("node") != "door_slide" or "closed" not in door:
        raise RuntimeError(f"{_relative(path)}: exterior door is missing")
    if not isinstance(payload.get("contract"), dict) or not payload["contract"]:
        raise RuntimeError(f"{_relative(path)}: collision contract is missing")
    for index, box in enumerate(walls):
        _validate_sidecar_xz_box(box, footprint, f"{_relative(path)}: wall {index}")
    for index, box in enumerate(furniture):
        _validate_sidecar_xz_box(box, footprint, f"{_relative(path)}: furniture {index}")
    _validate_sidecar_xz_box(door["closed"], footprint, f"{_relative(path)}: exterior door")
    for index, region in enumerate(regions):
        _validate_sidecar_xz_box(region, footprint, f"{_relative(path)}: interior region {index}")
        floor_top = region.get("floorTopY")
        if not isinstance(floor_top, (int, float)) or not math.isfinite(floor_top):
            raise RuntimeError(f"{_relative(path)}: interior region {index} has no floorTopY")

    boxes = payload.get("boxes")
    if not isinstance(boxes, list) or not boxes:
        raise RuntimeError(f"{_relative(path)}: collision has no source boxes")
    counts = {"structure": 0, "door": 0}
    for box in boxes:
        if box.get("kind") not in counts:
            raise RuntimeError(f"{_relative(path)}: unsupported collision kind")
        center, size = box.get("center"), box.get("size")
        if not (
            isinstance(center, list) and len(center) == 3
            and isinstance(size, list) and len(size) == 3
            and all(isinstance(value, (int, float)) and math.isfinite(value)
                    for value in center + size)
            and all(value > 0.0 for value in size)
        ):
            raise RuntimeError(f"{_relative(path)}: invalid collision source box")
        counts[box["kind"]] += 1
    if not counts["structure"] or not counts["door"]:
        raise RuntimeError(f"{_relative(path)}: missing structure or door collision")
    return counts


def _collision_proxy_counts(inputs: list[dict[str, Any]]) -> dict[str, int]:
    """Count placed wall-like and furnished structure boxes from source sidecars."""
    wall_count = 0
    furniture_count = 0
    for record in inputs:
        base = record["item"]["base"]
        boxes = _load_collision(record)
        structures = sum(box["kind"] == "structure" for box in boxes)
        if base.startswith(("furn_", "xs_san_")):
            furniture_count += structures
        elif (
            base.startswith(("wall_", "window_", "door_", "corner_", "gable_"))
            or base in {"column", "entry_apron_2c", "entry_hood_2c"}
        ):
            wall_count += structures
    return {"wallCount": wall_count, "furnitureCount": furniture_count}


def _interior_regions(plan: Any) -> list[dict[str, Any]]:
    return [
        {
            "id": room["name"],
            "minX": _round(room["c0"] * Kit.CELL),
            "minZ": _round(room["r0"] * Kit.CELL),
            "maxX": _round(room["c1"] * Kit.CELL),
            "maxZ": _round(room["r1"] * Kit.CELL),
            "floorTopY": FLOOR_TOP_M,
        }
        for room in plan.rooms
    ]


def _module_provenance(inputs: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Record each distinct current source module exactly once, sorted by ID."""
    unique: dict[str, dict[str, Any]] = {}
    for record in inputs:
        module_id = record["id"]
        if module_id not in unique:
            unique[module_id] = {
                "id": module_id,
                "lane": record["lane"],
                "glb": {
                    "path": _relative(record["glb"]),
                    "bytes": record["glb"].stat().st_size,
                    "sha256": _sha256(record["glb"]),
                },
                "collision": {
                    "path": _relative(record["collision"]),
                    "sha256": _sha256(record["collision"]),
                },
            }
    return [unique[module_id] for module_id in sorted(unique)]


def _source_provenance() -> list[dict[str, str]]:
    paths = (
        SRC / "package_runtime_buildings.py",
        SRC / "assemble_home.py",
        SRC / "home_plan.py",
        SRC / "kit_grid.py",
        SRC / "kit_spec.py",
        SRC / "pack_runtime_glb.py",
        ROOT / "build" / "buildkit.manifest.json",
    )
    result = []
    for path in paths:
        if not path.is_file():
            raise RuntimeError(f"required source is missing: {_relative(path)}")
        result.append({"path": _relative(path), "sha256": _sha256(path)})
    return result


def _package_paths(output_dir: Path, key: str) -> dict[str, Path]:
    return {
        "glb": output_dir / f"{key}.glb",
        "collision": output_dir / f"{key}_collision.json",
        "manifest": output_dir / f"{key}_manifest.json",
        "provenance": output_dir / f"{key}.provenance.json",
    }


def _load_existing_inputs(plan_name: str) -> tuple[Any, list[dict[str, Any]]]:
    plans = Assembly.load_plans()
    try:
        plan = plans[plan_name]()
    except KeyError as error:
        raise RuntimeError(f"current plan registry has no {plan_name}") from error
    return plan, _plan_inputs(plan)


def _bbox_span(bounds: list[list[float]]) -> list[float]:
    return _numbers(tuple(bounds[1][axis] - bounds[0][axis] for axis in range(3)))


def _public_manifest(
    spec: dict[str, Any], plan: Any, paths: dict[str, Path], entry: dict[str, Any],
    glb_validation: dict[str, Any], collision_counts: dict[str, int],
    proxy_counts: dict[str, int],
) -> dict[str, Any]:
    cells = list(spec["footprint_cells"])
    max_m = _numbers((cells[0] * Kit.CELL, cells[1] * Kit.CELL))
    scale_field = f"runtime_scale_at_{cells[0]}x{cells[1]}_cells"
    axis = entry["axis_local"]
    return {
        "schema": PACKAGE_SCHEMA,
        "building": spec["key"],
        "runtimeKey": spec["key"],
        "label": spec["label"],
        "units": "m",
        "front": "+Z",
        "footprintCells": cells,
        "footprint_max_m": max_m,
        scale_field: 1.0,
        "floorHeightM": glb_validation["floor_top_m"],
        "floorTopY": glb_validation["floor_top_m"],
        "exteriorEntry": {
            "facing": entry["facing"],
            "frontAxis": "+Z",
            "doorNode": entry["node"],
            "doorCells": entry["door_cells"],
        },
        "door": {
            "node": entry["node"],
            "local_axis": "X",
            "axisLocal": axis,
            "slide_axis_local": axis,
            "slide_distance_m": entry["travel_m"],
            "clips": entry["clips"],
            "closedInGlb": entry["closed_in_glb"],
        },
        "door_cells": entry["door_cells"],
        "service_anchor_cells": {},
        "promised_clear_cells": {},
        "collisionProxy": {
            "source": spec["key"],
            "sidecar": paths["collision"].name,
            "structuralOnly": False,
            "includesFurniture": True,
            **proxy_counts,
        },
        "cutaway": {
            "faces": CUTAWAY_FACES,
            "hide": list(REVEAL_PREFIXES),
            "revealPrefixes": list(REVEAL_PREFIXES),
            "keep": ["floor__", "interior__"],
            "stub_by_face": True,
        },
        "interiorRegions": _interior_regions(plan),
        "bbox_span_m": _bbox_span(glb_validation["bounds_m"]),
        "tri_count": glb_validation["triangles"],
        "materials": glb_validation["materials"],
        "asset": {
            "file": paths["glb"].name,
            "bytes": paths["glb"].stat().st_size,
            "sha256": f"sha256:{_sha256(paths['glb'])}",
            "images": {
                "image_count": glb_validation["images_embedded"],
                "external_image_uri_count": 0,
            },
        },
        "source": {
            "plan": plan.name,
            "placements": len(plan.items),
            "furnishedPlacements": glb_validation["furnished_placements"],
            "floorBoundsM": glb_validation["footprint_bounds_m"],
            "provenance": paths["provenance"].name,
        },
        "collision": {
            "boxes": collision_counts["structure"] + collision_counts["door"],
            "structure_boxes": collision_counts["structure"],
            "door_boxes": collision_counts["door"],
            "sha256": f"sha256:{_sha256(paths['collision'])}",
        },
    }


def _build_package(spec: dict[str, Any], output_dir: Path) -> dict[str, Any]:
    plan, inputs = _load_existing_inputs(spec["plan"])
    paths = _package_paths(output_dir, spec["key"])
    entry, entry_record = _entry_door(inputs)
    collision, collision_counts = _build_collision(spec["key"], plan, inputs, entry_record)

    with tempfile.TemporaryDirectory(prefix=f".{spec['key']}.", dir=output_dir) as temp:
        raw_glb = Path(temp) / f"{spec['key']}.raw.glb"
        _assemble_for_export(inputs)
        _export_raw_glb(raw_glb)
        pack_report = RuntimePacker.pack_file(raw_glb, paths["glb"])
    _inject_entry_animations(paths["glb"], entry_record["glb"], entry)

    glb_validation = _validate_plan_glb(
        paths["glb"], inputs, spec["footprint_cells"], entry
    )
    _write_json(paths["collision"], collision)
    collision_validation = _validate_collision(paths["collision"], spec["key"])
    if collision_validation != {
        "structure": collision_counts["structure"],
        "door": collision_counts["door"],
    }:
        raise RuntimeError(f"{spec['key']}: packaged collision counts drifted")

    manifest = _public_manifest(
        spec, plan, paths, entry, glb_validation, collision_counts,
        _collision_proxy_counts(inputs),
    )
    _write_json(paths["manifest"], manifest)

    provenance = {
        "schema": PROVENANCE_SCHEMA,
        "asset_id": spec["key"],
        "runtime_key": spec["key"],
        "source_plan": plan.name,
        "generator": {
            "path": _relative(SRC / "package_runtime_buildings.py"),
            "sha256": _sha256(SRC / "package_runtime_buildings.py"),
            "lod": LOD,
        },
        "asset": {
            "path": paths["glb"].name,
            "bytes": paths["glb"].stat().st_size,
            "sha256": f"sha256:{_sha256(paths['glb'])}",
        },
        "contract": {
            "manifest": paths["manifest"].name,
            "collision": paths["collision"].name,
            "footprintCells": list(spec["footprint_cells"]),
            "floorTopY": FLOOR_TOP_M,
            "entryDoor": entry["node"],
        },
        "sources": _source_provenance(),
        "modules": _module_provenance(inputs),
        "artifacts": {
            name: {
                "path": path.name,
                "bytes": path.stat().st_size,
                "sha256": _sha256(path),
            }
            for name, path in paths.items()
            if name != "provenance"
        },
        "pack": {
            "colour_accessors_quantized": pack_report["colour_accessors_quantized"],
            "images_embedded": pack_report["images_embedded"],
            "unique_image_bytes": pack_report["unique_image_bytes"],
        },
    }
    _write_json(paths["provenance"], provenance)

    return {
        "key": spec["key"],
        "paths": {name: _relative(path) for name, path in paths.items()},
        "glb": manifest["asset"],
        "collision": manifest["collision"],
        "placements": manifest["source"]["placements"],
        "entry_door": manifest["door"],
    }


def _validate_existing_package(spec: dict[str, Any], output_dir: Path) -> dict[str, Any]:
    plan, inputs = _load_existing_inputs(spec["plan"])
    entry, _entry_record = _entry_door(inputs)
    paths = _package_paths(output_dir, spec["key"])
    missing = [path for path in paths.values() if not path.is_file()]
    if missing:
        raise RuntimeError(
            f"{spec['key']}: missing package artifact(s): "
            + ", ".join(_relative(path) for path in missing)
        )
    glb_validation = _validate_plan_glb(
        paths["glb"], inputs, spec["footprint_cells"], entry
    )
    collision_counts = _validate_collision(paths["collision"], spec["key"])
    with paths["manifest"].open(encoding="utf-8") as handle:
        manifest = json.load(handle)
    cells = list(spec["footprint_cells"])
    expected_max = _numbers((cells[0] * Kit.CELL, cells[1] * Kit.CELL))
    if (
        manifest.get("schema") != PACKAGE_SCHEMA
        or manifest.get("building") != spec["key"]
        or manifest.get("runtimeKey") != spec["key"]
        or manifest.get("footprintCells") != cells
        or manifest.get("footprint_max_m") != expected_max
        or manifest.get("floorHeightM") != FLOOR_TOP_M
        or manifest.get("floorTopY") != FLOOR_TOP_M
    ):
        raise RuntimeError(f"{_relative(paths['manifest'])}: public manifest identity drift")
    if manifest.get("exteriorEntry", {}).get("doorNode") != "door_slide":
        raise RuntimeError(f"{_relative(paths['manifest'])}: exterior entry node missing")
    door = manifest.get("door", {})
    if (
        door.get("node") != "door_slide"
        or door.get("axisLocal") != entry["axis_local"]
        or door.get("slide_axis_local") != entry["axis_local"]
        or abs(door.get("slide_distance_m", -1) - entry["travel_m"]) > 0.0001
        or door.get("clips") != entry["clips"]
    ):
        raise RuntimeError(f"{_relative(paths['manifest'])}: exterior door contract drift")
    if manifest.get("collisionProxy", {}).get("sidecar") != paths["collision"].name:
        raise RuntimeError(f"{_relative(paths['manifest'])}: collision sidecar drift")
    if manifest.get("asset", {}).get("images", {}).get("external_image_uri_count") != 0:
        raise RuntimeError(f"{_relative(paths['manifest'])}: external image URI reported")
    with paths["provenance"].open(encoding="utf-8") as handle:
        provenance = json.load(handle)
    if (
        provenance.get("schema") != PROVENANCE_SCHEMA
        or provenance.get("asset_id") != spec["key"]
        or provenance.get("runtime_key") != spec["key"]
    ):
        raise RuntimeError(f"{_relative(paths['provenance'])}: invalid provenance")
    return {
        "key": spec["key"],
        "glb": {
            "bytes": paths["glb"].stat().st_size,
            "sha256": _sha256(paths["glb"]),
            **glb_validation,
        },
        "collision": collision_counts,
        "artifacts": {
            name: {"bytes": path.stat().st_size, "sha256": _sha256(path)}
            for name, path in paths.items()
        },
    }


def main() -> None:
    args = _parse_args()
    output_dir = args.output if args.output.is_absolute() else ROOT / args.output
    output_dir.mkdir(parents=True, exist_ok=True)

    if args.validate_only:
        reports = [_validate_existing_package(spec, output_dir) for spec in PACKAGES]
        print(json.dumps({"schema": PACKAGE_SCHEMA, "validated": reports}, indent=2))
        return

    reports = [_build_package(spec, output_dir) for spec in PACKAGES]
    # A second pass starts from only final files and fresh re-imports, so a
    # success report cannot rely on the just-assembled Blender scene.
    validation = [_validate_existing_package(spec, output_dir) for spec in PACKAGES]
    print(json.dumps({"schema": PACKAGE_SCHEMA, "packages": reports,
                      "validation": validation}, indent=2))


if __name__ == "__main__":
    main()
