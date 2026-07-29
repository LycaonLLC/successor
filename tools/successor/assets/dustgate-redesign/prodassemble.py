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

There are no roads, paths, aprons, kerbs, paving, rectangular ground patches or
route-shaped ground marks anywhere in this layout. The desert is one continuous
plane; the only relief is the ancient remnant landform along the north and the
broken mass fallen off it. The ground between buildings is the same untouched
surface as the ground outside them.
"""

from __future__ import annotations

import math
import os
import random
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

#: Extraction skids tested at their real size, OUTSIDE the buildings. The
#: audit's verdict is that these are site equipment, not interior dressing, and
#: shrinking them to fit a room was explicitly rejected.
#:
#: Round 1 stacked all three in the four-cell alley between the clone and
#: commerce units, 2.8 cells apart on one axis. Visual review rejected that: it
#: crowded the only direct link between the two buildings and the three skids
#: read as a service lane. They now stand as a loose working yard on the open
#: desert flank east of commerce, non-collinear and at unrelated yaws, with the
#: alley left as clear walkable sand.
YARD_PROPS = (
    ("mineral_power_skid", (36.8, 9.4), 24.0),
    ("mineral_dust_filter", (39.4, 12.9), -38.0),
    ("petrochemical_separator_skid", (36.2, 14.8), 112.0),
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
# the ancient remnant and the natural desert surface
# --------------------------------------------------------------------------


#: Stations of the ancient remnant, west to east, in world cells:
#: `(x, crest_y, crest_z, south_toe_depth, north_toe_depth, crest_half_width)`.
#:
#: This is a swept landform, not a row of objects. Every station contributes one
#: cross-section of ONE continuous solid; consecutive sections are bridged, so
#: there is no repeated silhouette to read as a modular unit and no seam where
#: a "pier" could start or stop. Two earlier attempts failed here: evenly spaced
#: piers of one width read as shipping containers, and hand-varied piers on a
#: shared plinth still read as tombstones, because a box row is a box row
#: however much its heights differ.
#:
#: The macro silhouette is authored, not generated. Two surviving massifs — a
#: heavy one west of the clone unit and a taller, thicker one east of commerce —
#: with the whole central stretch collapsed to a two-metre spine, sheared open
#: at x 6.5, standing as a single stub at x 17-18, and breached almost to sand
#: level at x 23. The settlement sits inside that breach, which is why a
#: settlement is there at all.
#:
#: Crest heights are constrained by the locked 60-degree camera: an element of
#: height `h` standing north of a target projects its crest `h / tan(60)` cells
#: south on screen. Every station is chosen so `crest_y + crest_half_width +
#: 0.577 * crest_z` stays north of the nearest building wall, which is why the
#: two massifs stay under 9.5 m and the collapsed middle never exceeds 6.5 m.
#:
#: Round 1 of this correction used narrow crests on 10-11.5 m stations. It
#: killed the modular-wall reading, but the result was a jagged natural rock
#: ridge: pointed summits, no evidence of construction, and it dominated the top
#: of the gameplay frame. Round 2 broadens every crest into a dished bench with
#: two rims, keeps the windward face short and steep against a long sand-buried
#: lee, and lowers the peaks. A flat-topped, breached, terrain-scale rampart
#: reads as ancient work; a peak reads as a mountain.
REMNANT_STATIONS = (
    (-7.0, -5.8, 7.2, 4.8, 4.4, 3.1),
    (-4.6, -5.4, 8.6, 5.4, 5.1, 3.8),
    (-2.4, -5.7, 8.1, 5.0, 4.6, 3.3),
    (-0.6, -5.1, 9.1, 5.6, 5.4, 4.1),
    (1.2, -5.5, 8.7, 5.2, 4.8, 3.5),
    (2.9, -5.0, 9.4, 5.8, 5.3, 4.0),
    (4.3, -5.3, 8.9, 5.3, 4.7, 3.4),
    (5.4, -4.8, 8.2, 5.0, 4.4, 3.0),
    (6.4, -4.4, 6.6, 4.6, 4.0, 2.6),
    (6.85, -4.2, 5.0, 4.4, 3.8, 2.4),
    (7.3, -4.0, 3.4, 4.2, 3.6, 2.2),
    (8.4, -3.6, 4.8, 4.4, 3.8, 2.4),
    (9.8, -3.1, 3.6, 4.0, 3.4, 2.0),
    (11.4, -2.6, 2.9, 3.6, 3.2, 1.8),
    (12.9, -3.0, 2.2, 3.2, 2.9, 1.6),
    (14.6, -2.4, 3.1, 3.6, 3.2, 1.9),
    (15.8, -2.1, 2.4, 3.4, 3.0, 1.7),
    (16.9, -2.3, 4.2, 3.9, 3.4, 2.1),
    (17.8, -2.4, 6.2, 4.2, 3.8, 2.5),
    (18.8, -2.2, 5.6, 4.0, 3.6, 2.3),
    (19.35, -2.35, 4.3, 3.9, 3.4, 2.1),
    (19.9, -2.5, 3.2, 3.5, 3.1, 1.8),
    (20.9, -2.1, 2.1, 3.1, 2.8, 1.6),
    (22.1, -1.7, 1.4, 2.7, 2.5, 1.4),
    (23.4, -2.0, 0.6, 2.3, 2.2, 1.2),
    (24.6, -1.5, 1.3, 2.6, 2.4, 1.3),
    (25.9, -1.9, 2.4, 3.0, 2.7, 1.5),
    (27.2, -2.3, 3.0, 3.4, 3.0, 1.7),
    (28.8, -2.0, 4.2, 3.9, 3.4, 2.0),
    (30.2, -2.6, 3.5, 3.6, 3.2, 1.8),
    (31.6, -2.2, 4.9, 4.1, 3.6, 2.2),
    (33.0, -2.8, 4.3, 3.8, 3.4, 2.0),
    (34.4, -2.6, 5.8, 4.3, 3.8, 2.5),
    (35.8, -3.2, 6.9, 4.5, 3.8, 2.4),
    (37.1, -2.9, 7.8, 4.8, 4.4, 3.1),
    (38.4, -3.4, 8.6, 5.2, 4.2, 2.8),
    (39.6, -3.0, 8.1, 4.7, 4.7, 3.4),
    (40.9, -3.6, 8.7, 5.3, 4.4, 3.0),
    (42.3, -3.2, 7.6, 4.6, 3.9, 2.5),
    (44.1, -3.8, 6.4, 4.1, 3.4, 2.0),
    (46.3, -3.4, 5.4, 3.7, 3.7, 2.4),
    (49.0, -4.0, 5.0, 4.0, 4.1, 2.8),
)

#: Fallen mass, in world cells: `(x, y, rx, ry, height, lean, taper, material)`.
#: Authored where the remnant actually failed — the shear at x 7, the breach at
#: x 21-25, and the two scarp feet — not scattered evenly. The largest entries
#: are tabular blocks (high `taper`, long in one axis, strong `lean`) that read
#: as collapsed courses off the crest; the small ones are broken rubble.
#: Nothing is spaced evenly, nothing is collinear, nothing forms a line or a
#: fan, and nothing comes near the door approaches on the south faces.
REMNANT_FRAGMENTS = (
    (6.8, 1.6, 3.10, 1.40, 2.45, 0.52, 0.88, "ancient"),
    (8.9, 0.4, 1.90, 2.60, 1.85, -0.34, 0.86, "ancient"),
    (7.6, 3.2, 1.25, 0.98, 1.05, 0.24, 0.70, "plinth"),
    (4.6, 2.4, 0.86, 1.18, 0.72, -0.20, 0.74, "plinth"),
    (10.4, 2.1, 0.60, 0.68, 0.50, 0.11, 0.60, "plinth"),
    (9.7, -1.2, 1.05, 0.82, 0.86, -0.28, 0.68, "plinth"),
    (2.2, -0.6, 2.40, 1.15, 1.95, 0.46, 0.90, "ancient"),
    (5.1, -9.6, 1.60, 2.10, 1.30, 0.38, 0.82, "ancient"),
    (21.4, 1.4, 2.05, 1.35, 1.70, -0.42, 0.84, "ancient"),
    (23.8, 2.6, 1.28, 1.80, 1.12, 0.29, 0.76, "ancient"),
    (25.4, 0.8, 0.92, 0.76, 0.74, -0.15, 0.64, "plinth"),
    (22.6, 3.4, 0.66, 0.90, 0.54, 0.21, 0.57, "plinth"),
    (24.8, -1.4, 0.48, 0.56, 0.40, -0.09, 0.53, "plinth"),
    (20.0, 2.5, 0.72, 0.58, 0.56, 0.16, 0.62, "plinth"),
    (22.2, -6.2, 1.35, 1.02, 1.02, 0.35, 0.78, "ancient"),
    (33.6, 1.6, 1.15, 1.50, 0.98, -0.27, 0.72, "ancient"),
    (35.2, 2.8, 0.62, 0.70, 0.50, 0.13, 0.58, "plinth"),
    (31.8, 0.6, 0.84, 0.66, 0.62, -0.18, 0.66, "plinth"),
    (43.4, 2.2, 1.85, 1.32, 1.55, 0.40, 0.86, "ancient"),
    (45.6, 1.0, 0.96, 1.20, 0.78, -0.22, 0.70, "plinth"),
)

#: One seed for the whole remnant. Micro erosion is deterministic noise on an
#: authored macro form: it breaks every face out of plane so no silhouette
#: repeats, and it reproduces byte-for-byte on a rerun.
REMNANT_SEED = 20260729

#: Cross-section point count. Fixed, because a swept solid needs equal rings.
SECTION_POINTS = 15

#: Per-station windward flute, as a signed fraction of the south toe depth.
#: This is what stops the two massifs reading as smooth grey lumps: consecutive
#: sections step the scarp in and out, so the face carries vertical eroded
#: buttresses and clefts at the station pitch instead of one continuous surface.
#: 23 authored values against 42 stations, and the station pitch itself varies
#: from 0.45 to 2.7 cells, so the fluting never lands on a regular rhythm.
FLUTE = (
    0.26, -0.09, 0.20, -0.29, 0.06, 0.22, -0.19, 0.31, -0.05, 0.13, -0.25,
    0.11, 0.24, -0.15, 0.28, -0.07, 0.12, -0.22, 0.18, -0.31, 0.04, -0.13,
    0.23,
)

#: The flute is an undulation of the section's OUTER ENVELOPE, not of individual
#: points: every windward point moves together and every lee point moves
#: together, with only the two crest-bench interior points pinned. Weighting the
#: points differently folds the profile back on itself and the sweep
#: self-intersects, which is exactly the thin flapping geometry round 2 showed
#: at the shear. Windward moves further than lee, so the flute reads as
#: buttresses and clefts on the face the settlement sees.
FLUTE_WINDWARD = 0.55
FLUTE_LEE = -0.32

#: Section point index ranges the two flute factors apply to.
FLUTE_GROUPS = ((range(0, 6), FLUTE_WINDWARD), (range(8, 14), FLUTE_LEE))


def _remnant_section(cy: float, h: float, d0: float, d1: float, w: float,
                     flute: float, rng) -> list[tuple[float, float]]:
    """One cross-section of the remnant, as `(world_y, z)` points.

    Undercut windward scarp, a dished crest bench between two eroded rims, a
    shorter convex lee face, then a shallow keel below zero so the mass is
    bedded in the sand instead of sitting on a visible flat seam. Both faces are
    interpolated from toe to crest lip with different exponents, so the section
    is asymmetric by construction and monotonic by construction: an eroded
    rampart, never a battered box and never a cone.

    Round 3 gave the lee a 6-8 m toe on a 1.05 exponent. That made it a large
    smooth ruled surface between stations, and where the crest fell away fast it
    read as folded drapery rather than rock. The lee toe is now roughly 0.8 of
    the windward toe on a 1.40 exponent, which keeps the remnant a rampart with
    two steep faces and leaves no shallow sheet to catch the light.

    The rims are the one construction cue the form keeps. A natural ridge has no
    reason to be higher at both edges of a flat top than in the middle. Rim
    prominence scales with height, so the sanded-over middle of the remnant
    flattens out instead of sweeping a knife-edge fin along the collapsed run."""
    rim = min(1.0, h / 5.0)
    pts: list[tuple[float, float]] = []
    for t in (0.0, 0.20, 0.50, 0.76, 0.93):
        pts.append((cy + w + (d0 - w) * (1.0 - t) ** 1.70, h * t))
    pts.append((cy + w, h))
    pts.append((cy + w * 0.10, h * (1.0 - 0.045 * rim)))
    pts.append((cy - w * 0.62, h * (1.0 - 0.060 * rim)))
    pts.append((cy - w, h * (1.0 - 0.015 * rim)))
    for t in (0.90, 0.66, 0.40, 0.18, 0.0):
        pts.append((cy - w - (d1 - w) * (1.0 - t) ** 1.40, h * t))
    pts.append((cy, -0.40))

    toe = max(d0, d1)
    reach = min(1.0, h / 6.0)
    shift = [0.0] * len(pts)
    for indices, factor in FLUTE_GROUPS:
        for index in indices:
            shift[index] = flute * d0 * reach * factor

    eroded: list[tuple[float, float]] = []
    for index, (y, z) in enumerate(pts):
        y += shift[index]
        if index in (0, 13, 14):
            eroded.append((y + rng.uniform(-0.22, 0.22), z))
        else:
            eroded.append((y + rng.uniform(-0.06, 0.06) * toe,
                           max(0.06, z + rng.uniform(-0.03, 0.03) * h)))
    return eroded


def _remnant_spine(unit: pk.Unit, rng) -> None:
    """Bridge every station section into one closed solid."""
    rings: list[list[tuple[float, float, float]]] = []
    for index, (x, cy, h, d0, d1, w) in enumerate(REMNANT_STATIONS):
        station_x = x + rng.uniform(-0.14, 0.14)
        flute = FLUTE[index % len(FLUTE)]
        rings.append([(station_x, y, z) for y, z
                      in _remnant_section(cy, h, d0, d1, w, flute, rng)])

    verts = [(bx(x), by(y), z) for ring in rings for x, y, z in ring]
    faces: list[tuple[int, ...]] = []
    for level in range(len(rings) - 1):
        lower = level * SECTION_POINTS
        upper = (level + 1) * SECTION_POINTS
        for i in range(SECTION_POINTS):
            j = (i + 1) % SECTION_POINTS
            faces.append((lower + i, lower + j, upper + j, upper + i))
    faces.append(tuple(reversed(range(SECTION_POINTS))))
    last = (len(rings) - 1) * SECTION_POINTS
    faces.append(tuple(last + i for i in range(SECTION_POINTS)))

    obj = dg.mesh_from("tmp_remnant", verts, faces, unit.mat("ancient"))
    unit.add(obj, "mass__", "ancient", detail=pk.CORE, bevel=0.13)


def _fragment(unit: pk.Unit, cx: float, cy: float, rx: float, ry: float,
              height: float, lean: float, taper: float, matkey: str,
              rng) -> None:
    """One irregular block of fallen mass.

    Four jittered rings, each ring's centre offset along a lean vector, so the
    block is tabular and toppled rather than a drum or a cone. No object
    transform is used: the lean is in the vertices, which keeps the piece safe
    to join and keeps its box projection aligned with its own faces."""
    segments = rng.choice((5, 6, 7, 8))
    phase = rng.uniform(0.0, math.tau)
    lean_y = lean * rng.uniform(-1.0, 1.0)
    rings: list[tuple[float, list[tuple[float, float]]]] = []
    for frac, scale in ((0.0, 0.94), (0.30, 1.0), (0.74, taper), (1.0, taper * 0.52)):
        ox = cx + lean * rx * frac
        oy = cy + lean_y * ry * frac
        poly: list[tuple[float, float]] = []
        for step in range(segments):
            angle = phase + math.tau * (step / segments) + rng.uniform(-0.18, 0.18)
            wobble = rng.uniform(0.76, 1.20)
            poly.append((bx(ox + math.cos(angle) * rx * scale * wobble),
                         by(oy + math.sin(angle) * ry * scale * wobble)))
        rings.append((frac * height - 0.14, poly))
    obj = dg.loft("tmp_fragment", rings, unit.mat(matkey))
    unit.add(obj, "mass__", matkey, detail=pk.MID, bevel=0.05)


def ancient_remnant(unit: pk.Unit) -> None:
    """The older, irreproducible thing the settlement shelters behind.

    One terrain-scale swept mass of cool cast rock plus the blocks that have
    fallen off it. It is assembly-only art direction for the layout test bed: it
    is never exported, never manifested, and is deliberately not a building. It
    must not read as a fourth modular unit or as a repeated prop line, so it has
    no repeated element to read as either."""
    rng = random.Random(REMNANT_SEED)
    _remnant_spine(unit, rng)
    for cx, cy, rx, ry, height, lean, taper, matkey in REMNANT_FRAGMENTS:
        _fragment(unit, cx, cy, rx, ry, height, lean, taper, matkey, rng)


def facet(parts: list) -> None:
    """Flat-shade the remnant. Stone is faceted; cast panels are not.

    `pk.Unit.consolidate` smooth-shades every part and marks sharp edges above
    38 degrees, which is correct for the building units and wrong here. On a
    low-poly swept landform it blends whole runs of adjacent facets into one
    continuous curved surface, and rounds 2-5 all read as creased cloth or
    folded sheet metal in close inspection no matter what the silhouette did.
    Flat shading restores the facets and the same geometry reads as rock."""
    for part in parts:
        for polygon in part.data.polygons:
            polygon.use_smooth = False
        part.data.update()


def terrain() -> None:
    """One continuous natural desert plane.

    Round 1 added four low box-built "wind-drift swells". They were not
    connected route geometry, but a truncated box with a flat top is a
    rectangle, and under the gameplay camera all four read as tan plazas or
    road aprons against the sand. They are gone. A plain continuous desert
    surface is better than fake naturalism, and the only authored relief on this
    site is the ancient remnant landform and the mass fallen off it."""
    plane = dg.ground_plane("ground_sand", 180.0, pk.pbr_material("sand"))
    plane.location = (bx(BLOCK_W / 2.0), by(BLOCK_H / 2.0), 0.0)
    pk.box_project(plane, tile=7.0)


# --------------------------------------------------------------------------
# entry point
# --------------------------------------------------------------------------


def build() -> dict:
    dg.reset()
    pk.dressed_scene(ground=False)
    dg.configure_render(res_x=RES, res_y=RES, samples=96)
    terrain()

    ancient = pk.Unit(uid="ancient")
    ancient_remnant(ancient)
    facet(ancient.consolidate(detail_cap=pk.MID, textured=True)["parts"])

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
    # Closer proof that the remnant is one swept mass, not a row of piers: the
    # western massif, the shear at x 6.5 and the blocks that fell out of it.
    shot("09_remnant_shear", dg.add_camera(
        "cam_remnant", (bx(7.5), by(-1.5), 0.0), 26.0, pitch_deg=21.0,
        yaw_deg=-42.0, distance=110.0))

    meshes = [o for o in bpy.context.scene.objects if o.type == "MESH"]
    report = {
        "layout": {"block_cells": [BLOCK_W, BLOCK_H],
                   "compass": "+x east, +y south, origin at the block north-west",
                   "roads_paths_aprons_or_paving": "none authored",
                   "ground_relief": "continuous sand plane plus the ancient "
                                    "remnant landform and its fallen mass"},
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
