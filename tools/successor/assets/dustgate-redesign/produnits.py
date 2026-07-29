"""Three standalone building products in structure-local coordinates.

Each unit is an independently placeable asset: its own origin at the footprint
centre, its own ground contact at Z=0, its own door contract, manifest and
collision sidecar. The settlement assembler instances these; it never joins or
rebuilds them.

Blender authoring space, per unit:

    +X   structure right (glTF +X, world east at yaw 0)
    -Y   structure FRONT (glTF +Z, the camera-facing side)
    +Z   up (glTF +Y), ground contact at exactly 0

## The shared construction grammar

One culture, three products. Every unit is built from the same seven moves, at
the same measured dimensions, in the same order:

1. a cast plinth ring with a battered face and a splayed foot that meets sand;
2. a chamfered floor slab whose top sits at +0.02 m;
3. ribbed panel walls between steel pilasters, on a `panel_shade` base band,
   with a panel-joint band at 2.35 m;
4. an entry bay that is always the SOUTHERNMOST mass of the building;
5. a track-hung sliding leaf on the outside face, parked over blank wall;
6. a dark structural roof broken into bays no wider than 3.2 m by steel fascia,
   canvas upstands and battens;
7. exactly one oxide functional accent and one amber signal.

## Why the entry bay must be the southernmost mass

Measured, not asserted. The gameplay camera is orthographic, north-up, pitched
60 degrees. Any element of height `h` standing `d` metres south of a target
hides that target when `h > target_top + d * tan(60)`. A 4.5 m eave with a
0.5 m overhang therefore hides a 2.45 m door head standing 0.5 m behind it
(2.45 + 0.5 * 1.732 = 3.32 < 4.5). Recessed porches, deep verandas and full-
width eaves over the threshold are all invisible at this pitch. So the door
plane leads, and the only thing allowed south of it is a shallow track hood
whose top clears `door_head + overhang * tan(60)`. `prodqa.py` re-derives that
inequality from the exported GLB for every unit.
"""

from __future__ import annotations

import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import bpy  # type: ignore

import prodkit as pk
from prodkit import CORE, FINE, MID, DoorSpec, Unit

TAN60 = math.tan(math.radians(60.0))

# --------------------------------------------------------------------------
# shared measured constants
# --------------------------------------------------------------------------

#: Ground contact is exactly local Z = 0 and nothing is authored below it: a
#: buried plinth would move the exported AABB and desynchronise the declared
#: footprint from the runtime's measured fit. The walk surface therefore sits
#: on a slab that stands ON grade, and the 0.16 m step up from sand to floor is
#: real geometry the threshold crop can be checked against.
FLOOR_TOP = 0.16
SLAB_THICKNESS = 0.16
PLINTH_TOP = 0.34
PLINTH_FLARE = 0.09
WALL_JOINT_Z = 2.35
BASE_BAND_Z = 0.95
MAX_ROOF_FIELD = 3.2
#: One uniform runtime fit for all three units, so they read as one build
#: culture at one scale: cells = span * 1.0526315789.
CELL_PER_METRE = 20.0 / 19.0


# --------------------------------------------------------------------------
# shared grammar
# --------------------------------------------------------------------------


def plinth_and_floor(u: Unit, P: dict) -> None:
    """Cast footing ring plus the walk surface.

    The footing is a ring, not a solid pad: the floor slab spans the interior
    and the ring carries the walls. That keeps the slab's exposed south edge
    readable as a real step instead of a printed line."""
    fx0, fx1 = P["wall_x0"] - 0.14, P["wall_x1"] + 0.14
    fy0, fy1 = P["front_y"] - 0.14, P["back_y"] + 0.14
    t = P["wall_t"] + 0.24

    # The footing follows the WALLS, not the footprint: the strip between the
    # plinth and the eave line is bare sand, because this settlement has no
    # paving, aprons or connective surfaces of any kind. The flared foot is
    # inset by exactly its own flare so grade contact lands on the ring line.
    f = PLINTH_FLARE
    for x0, x1, y0, y1 in (
        (fx0 + f, fx1 - f, fy0 + f, fy0 + t),
        (fx0 + f, fx1 - f, fy1 - t, fy1 - f),
        (fx0 + f, fx0 + t, fy0 + t, fy1 - t),
        (fx1 - t, fx1 - f, fy0 + t, fy1 - t),
    ):
        u.box("floor__", "plinth", x0, x1, y0, y1, 0.0, PLINTH_TOP,
              detail=CORE, bevel=0.02, base_flare=f, top_inset=0.018)

    # Walk surface. `floor__` is the only family the renderer can never hide,
    # so nothing else in the unit may carry the substring "floor". Round 1 made
    # the slab dark steel and the revealed interior read as a black hole under
    # the cutaway; the deck is pale cast now, with steel only at the edges.
    u.box("floor__", "plinth", fx0 + t, fx1 - t, fy0 + t, fy1 - t,
          0.0, FLOOR_TOP, detail=CORE, bevel=0.012)
    # Steel service bands: two value fields, so a revealed floor is not one
    # flat rectangle, and they read as where the work happens.
    ix0, ix1 = P["int_x0"] + 0.55, P["int_x1"] - 0.55
    iy0, iy1 = P["int_y0"] + 0.55, P["int_y1"] - 0.55
    u.box("floor__", "steel", ix0, ix1, iy0, iy1,
          FLOOR_TOP - 0.02, FLOOR_TOP + 0.008, detail=MID, bevel=0.008)
    u.box("floor__", "canvas", ix0 + 0.4, ix1 - 0.4, iy0 + 0.35, iy1 - 0.35,
          FLOOR_TOP - 0.01, FLOOR_TOP + 0.014, detail=MID, bevel=0.008)
    # Drainage channel on the door centreline: reads as function, not decal.
    dcx = (P["door_x0"] + P["door_x1"]) * 0.5
    u.box("floor__", "reveal", dcx - 0.13, dcx + 0.13, P["int_y0"], iy1 - 0.9,
          FLOOR_TOP - 0.05, FLOOR_TOP - 0.008, detail=MID, bevel=0.004)


def wall_run(
    u: Unit,
    family: str,
    x0: float,
    x1: float,
    y0: float,
    y1: float,
    top: float,
    axis: str,
    pilaster_step: float = 2.6,
    detail_base: int = CORE,
) -> None:
    """A ribbed panel wall between steel pilasters on a shaded base band.

    `axis` is the wall's long axis: 'x' for the front/back runs, 'y' for the
    side runs. Pilasters are real 0.09 m proud members on the outside face, so
    the wall carries a shadow rhythm instead of a flat albedo stripe."""
    u.box(family, "panel", x0, x1, y0, y1, PLINTH_TOP, top,
          detail=detail_base, bevel=0.016)
    u.box(family, "plinth", x0, x1, y0, y1, PLINTH_TOP - 0.02, BASE_BAND_Z,
          detail=detail_base, bevel=0.014, top_inset=-0.012)

    if axis == "x":
        outward = -0.09 if family == "wall_front__" else 0.09
        oy = y0 if family == "wall_front__" else y1
        span = x1 - x0
        count = max(2, int(round(span / pilaster_step)))
        for i in range(count + 1):
            cx = x0 + span * i / count
            cx = min(max(cx, x0 + 0.11), x1 - 0.11)
            u.box(family, "steel", cx - 0.11, cx + 0.11,
                  min(oy, oy + outward), max(oy, oy + outward),
                  PLINTH_TOP, top - 0.06, detail=MID, bevel=0.010)
        u.box(family, "steel", x0, x1, min(oy, oy + outward * 0.6),
              max(oy, oy + outward * 0.6), WALL_JOINT_Z, WALL_JOINT_Z + 0.11,
              detail=MID, bevel=0.008)
    else:
        outward = -0.09 if family == "wall_left__" else 0.09
        ox = x0 if family == "wall_left__" else x1
        span = y1 - y0
        count = max(2, int(round(span / pilaster_step)))
        for i in range(count + 1):
            cy = y0 + span * i / count
            cy = min(max(cy, y0 + 0.11), y1 - 0.11)
            u.box(family, "steel", min(ox, ox + outward), max(ox, ox + outward),
                  cy - 0.11, cy + 0.11, PLINTH_TOP, top - 0.06,
                  detail=MID, bevel=0.010)
        u.box(family, "steel", min(ox, ox + outward * 0.6),
              max(ox, ox + outward * 0.6), y0, y1,
              WALL_JOINT_Z, WALL_JOINT_Z + 0.11, detail=MID, bevel=0.008)


def hooded_vent(u: Unit, family: str, cx: float, y_out: float, y_in: float,
                z0: float, width: float, height: float) -> None:
    """Recessed louvre behind a weather hood: the kit's one repeated opening."""
    sign = -1.0 if y_out < y_in else 1.0
    u.box(family, "reveal", cx - width * 0.5, cx + width * 0.5,
          min(y_out, y_in), max(y_out, y_in), z0, z0 + height,
          detail=MID, bevel=0.006)
    for i in range(3):
        bz = z0 + height * (0.18 + 0.30 * i)
        u.box(family, "steel", cx - width * 0.5 + 0.04, cx + width * 0.5 - 0.04,
              min(y_out + 0.02 * sign, y_out), max(y_out + 0.02 * sign, y_out),
              bz, bz + 0.05, detail=FINE, bevel=0.004)
    u.box(family, "canvas", cx - width * 0.5 - 0.06, cx + width * 0.5 + 0.06,
          min(y_out + 0.13 * sign, y_out), max(y_out + 0.13 * sign, y_out),
          z0 + height, z0 + height + 0.07, detail=MID, bevel=0.008)


def entry_bay(u: Unit, P: dict) -> DoorSpec:
    """The southernmost mass: jamb piers, sill, track hood, sliding leaf.

    Returns the measured door contract. Nothing in this bay may rise above
    `door_head + overhang * tan(60)` or the camera loses the threshold."""
    ox0, ox1 = P["door_x0"], P["door_x1"]          # clear opening
    face = P["front_y"]                            # outer face of the front wall
    head = P["door_head"]
    leaf_x0 = ox0 - P["leaf_lap"]
    leaf_x1 = ox1 + P["leaf_lap"]

    # Jamb piers: the only full-height mass at the opening, so the door reads
    # as a hole in a wall rather than a painted rectangle.
    for px0, px1 in ((ox0 - 0.42, ox0), (ox1, ox1 + 0.42)):
        u.box("wall_front__", "steel", px0, px1, face - 0.14, face + P["wall_t"],
              PLINTH_TOP, head + 0.34, detail=CORE, bevel=0.016)
    # Head beam over the opening, up to the wall top.
    u.box("wall_front__", "panel", ox0 - 0.42, ox1 + 0.42, face, face + P["wall_t"],
          head + 0.34, P["wall_top"], detail=CORE, bevel=0.014)
    u.box("wall_front__", "steel", ox0 - 0.42, ox1 + 0.42, face - 0.10, face,
          head + 0.34, head + 0.52, detail=MID, bevel=0.010)

    # Raised pale sill and threshold apron. It runs the whole track length so
    # the parked leaf still has a floor under it, and its southern strip stays
    # open to the sky by design.
    sill_y0 = P["sill_y0"]
    apron_x0 = leaf_x0 - P["park_run"] - 0.20
    u.box("mass__", "canvas", apron_x0, ox1 + 0.62, sill_y0, face,
          0.0, FLOOR_TOP + 0.05, detail=CORE, bevel=0.012)
    u.box("mass__", "plinth", apron_x0, ox1 + 0.62, sill_y0, sill_y0 + 0.09,
          0.0, FLOOR_TOP + 0.11, detail=MID, bevel=0.010)

    # Track and hood. The hood is the only element allowed south of the door
    # plane, so its top must stay under the camera sightline to the door head.
    hood_y = P["hood_y"]
    overhang = face - hood_y
    limit = head + overhang * TAN60
    hood_top = min(head + 0.30, limit - 0.08)
    if hood_top <= head + 0.14:
        raise ValueError(
            f"{u.uid}: {overhang:.3f} m hood overhang leaves no legal hood "
            f"depth over a {head:.3f} m door head (limit {limit:.3f} m)"
        )
    u.box("mass__", "steel", leaf_x0 - P["park_run"] - 0.2, leaf_x1 + 0.24,
          hood_y, face - 0.02, head + 0.04, head + 0.15, detail=CORE, bevel=0.010)
    u.box("mass__", "roof", leaf_x0 - P["park_run"] - 0.2, leaf_x1 + 0.24,
          hood_y, face - 0.02, head + 0.15, hood_top, detail=MID, bevel=0.012)
    for cx in (leaf_x0 - P["park_run"] - 0.14, leaf_x1 + 0.16):
        u.box("mass__", "steel", cx - 0.07, cx + 0.07, face - 0.16, face,
              PLINTH_TOP, head + 0.32, detail=MID, bevel=0.008)
    # Amber threshold signal: one per building, always at the door.
    u.box("mass__", "amber", ox1 + 0.50, ox1 + 0.64, face - 0.09, face,
          head - 0.30, head - 0.06, detail=MID, bevel=0.006)

    spec = DoorSpec(
        x0=leaf_x0,
        x1=leaf_x1,
        y_front=face - 0.12,
        y_back=face - 0.02,
        z0=FLOOR_TOP,
        z1=head,
        travel=P["door_travel"],
        axis_local=(-1.0, 0.0, 0.0),
        park_x0=leaf_x0 - P["door_travel"],
        park_x1=leaf_x0,
    )
    return spec


def roof_bay_breaks(u: Unit, x0: float, x1: float, y_s: float, y_n: float,
                    z_s: float, z_n: float, family: str = "roof__") -> list[float]:
    """Canvas upstands and steel fascia across a roof field.

    Round 1 authored these as horizontal bars at the ridge height, which flew
    off a falling roof plane as loose sticks in every three-quarter frame. They
    are sloped slabs now: they sit ON the roof and terminate at its edges.
    Returns the break positions so QA can prove no unbroken value field exceeds
    MAX_ROOF_FIELD."""
    span = x1 - x0
    count = max(1, int(math.ceil(span / MAX_ROOF_FIELD)))
    breaks = [x0 + span * i / count for i in range(count + 1)]
    for raw in breaks:
        cx = min(max(raw, x0 + 0.11), x1 - 0.11)
        u.slab(family, "canvas", cx - 0.09, cx + 0.09, y_s, y_n,
               z_s + 0.03, z_n + 0.03, 0.21, detail=MID, bevel=0.010)
        u.box(family, "steel", cx - 0.11, cx + 0.11, y_s, y_s + 0.16,
              z_s - 0.06, z_s + 0.26, detail=FINE, bevel=0.006)
    return breaks


def roof_walkway(u: Unit, x0: float, x1: float, y: float,
                 z_s: float, z_n: float, y_s: float, y_n: float) -> None:
    """Grated maintenance run along a roof plane.

    Functional, and it is the only light-value band allowed on a roof: at the
    locked pitch the roof is most of the building's pixels, so one legible
    service line does more for the read than any amount of panel noise."""
    t = (y - y_s) / max(y_n - y_s, 1e-6)
    z = z_s + (z_n - z_s) * t
    u.box("roof__", "steel", x0, x1, y - 0.34, y + 0.34, z + 0.03, z + 0.09,
          detail=MID, bevel=0.008)
    for cx in (x0 + 0.3, (x0 + x1) * 0.5, x1 - 0.3):
        u.box("roof__", "steel", cx - 0.05, cx + 0.05, y - 0.36, y + 0.36,
              z + 0.09, z + 0.30, detail=FINE, bevel=0.005)


def sloped_roof(u: Unit, x0: float, x1: float, y_s: float, y_n: float,
                z_s: float, z_n: float, thickness: float = 0.22,
                patches: tuple = ()) -> None:
    """A structural roof plane: slab, south fascia, side fascia, patches."""
    u.slab("roof__", "roof", x0, x1, y_s, y_n, z_s, z_n, thickness,
           detail=CORE, bevel=0.014)
    u.box("roof__", "steel", x0, x1, y_s, y_s + 0.14,
          z_s - thickness - 0.06, z_s + 0.07, detail=CORE, bevel=0.010)
    for sx0, sx1 in ((x0, x0 + 0.12), (x1 - 0.12, x1)):
        u.slab("roof__", "steel", sx0, sx1, y_s, y_n,
               z_s + 0.04, z_n + 0.04, 0.10, detail=MID, bevel=0.008)
    # Mismatched replacement panels, with a real lapped edge rather than a
    # pale rectangle painted onto the slope.
    for px0, px1, py0, py1 in patches:
        t = (py0 - y_s) / max(y_n - y_s, 1e-6)
        t1 = (py1 - y_s) / max(y_n - y_s, 1e-6)
        za = z_s + (z_n - z_s) * t
        zb = z_s + (z_n - z_s) * t1
        u.slab("roof__", "canvas", px0, px1, py0, py1, za + 0.02, zb + 0.02,
               0.07, detail=MID, bevel=0.008)
        u.box("roof__", "steel", px0 - 0.05, px0 + 0.03, py0, py1,
              za + 0.02, za + 0.13, detail=FINE, bevel=0.005)
        u.box("roof__", "steel", px1 - 0.03, px1 + 0.05, py0, py1,
              za + 0.02, za + 0.13, detail=FINE, bevel=0.005)


def interior_lining(u: Unit, P: dict, top: float = 2.6) -> None:
    """Retained interior surfaces. These stay when the cutaway fires, so the
    revealed room reads as a built room and not as four bare wall backs."""
    x0, x1 = P["int_x0"], P["int_x1"]
    y0, y1 = P["int_y0"], P["int_y1"]
    # Wall lining: a pale cast dado over a shaded skirt. Round 1 lined the
    # walls in dark plinth only and the revealed room went black; the pale band
    # is what the interior props read against under the cutaway.
    for bx0, bx1, by0, by1 in (
        (x0, x1, y1 - 0.07, y1),
        (x0, x0 + 0.07, y0, y1),
        (x1 - 0.07, x1, y0, y1),
    ):
        u.box("interior__", "plinth", bx0, bx1, by0, by1,
              FLOOR_TOP, FLOOR_TOP + 0.26, detail=MID, bevel=0.008)
        u.box("interior__", "canvas", bx0, bx1, by0, by1,
              FLOOR_TOP + 0.26, 1.62, detail=MID, bevel=0.008)
        u.box("interior__", "steel", bx0, bx1, by0, by1, 1.62, 1.72,
              detail=FINE, bevel=0.006)
    # Exposed roof structure: light purlins the revealed room reads against.
    # Round 1 used 0.17 m bars and they became the loudest thing in the room.
    count = max(3, int(round((y1 - y0) / 1.7)))
    for i in range(count + 1):
        cy = y0 + (y1 - y0) * i / count
        cy = min(max(cy, y0 + 0.1), y1 - 0.1)
        u.box("interior__", "steel", x0, x1, cy - 0.05, cy + 0.05,
              top, top + 0.11, detail=FINE, bevel=0.006)


def task_light(u: Unit, cx: float, cy: float, z: float = 2.52) -> None:
    u.box("interior__", "steel", cx - 0.28, cx + 0.28, cy - 0.10, cy + 0.10,
          z, z + 0.09, detail=FINE, bevel=0.006)
    u.box("interior__", "amber", cx - 0.22, cx + 0.22, cy - 0.06, cy + 0.06,
          z - 0.05, z, detail=FINE, bevel=0.004)


# --------------------------------------------------------------------------
# unit parameter blocks
# --------------------------------------------------------------------------


def _frame(span_x: float, span_y: float, eave: float, wall_t: float) -> dict:
    """Footprint, wall lines and interior lines from two spans.

    The footprint IS the exported XZ bounding box: the runtime measures the GLB
    and fits it uniformly to the prop's cell rect, so a sidecar footprint that
    disagrees with the mesh silently rescales every collision box. Nothing may
    project beyond these numbers."""
    hx, hy = span_x * 0.5, span_y * 0.5
    return {
        "span_x": span_x,
        "span_y": span_y,
        "foot_x0": -hx, "foot_x1": hx,
        "foot_y0": -hy, "foot_y1": hy,
        "wall_x0": -hx + eave, "wall_x1": hx - eave,
        "front_y": -hy + eave * 0.0,      # set per unit below
        "back_y": hy - eave,
        "wall_t": wall_t,
        "eave": eave,
        "plinth_depth": wall_t + 0.10,
    }


def _derive(P: dict) -> dict:
    """Interior lines, leaf geometry and travel are DERIVED, never retyped.

    Travel must clear the west jamb pier, not merely the opening: the pier is
    0.42 m wide and occupies the same Y band as the leaf, so a travel sized on
    the clear opening alone parks the leaf through the pier."""
    P["int_x0"] = P["wall_x0"] + P["wall_t"]
    P["int_x1"] = P["wall_x1"] - P["wall_t"]
    P["int_y0"] = P["front_y"] + P["wall_t"]
    P["int_y1"] = P["back_y"] - P["wall_t"]
    P["leaf_x0"] = P["door_x0"] - P["leaf_lap"]
    P["leaf_x1"] = P["door_x1"] + P["leaf_lap"]
    P["pier_x0"] = P["door_x0"] - 0.42
    # Park the leaf fully west of the west pier, plus a 0.09 m service gap.
    travel = (P["leaf_x1"] - P["pier_x0"]) + 0.09
    P["door_travel"] = round(travel, 3)
    P["park_run"] = P["door_travel"]
    P["open_leaf_x0"] = round(P["leaf_x0"] - P["door_travel"], 4)
    P["open_leaf_x1"] = round(P["leaf_x1"] - P["door_travel"], 4)
    if P["open_leaf_x0"] < P["wall_x0"] - 1e-6:
        raise ValueError(f"{P['uid']}: open leaf runs off the west wall")
    if P["open_leaf_x1"] > P["pier_x0"] + 1e-6:
        raise ValueError(f"{P['uid']}: open leaf still fouls the west jamb pier")
    return P


def clone_params() -> dict:
    """12 x 10 cells. The settlement's tall, loud, industrial building."""
    P = _frame(11.40, 9.50, 0.42, 0.32)
    P.update(
        uid="clone",
        label="clone unit",
        cells=(12, 10),
        wall_top=4.10,
        int_ceiling=3.62,
        # The entry bay leads: the door plane sits 0.24 m north of the
        # footprint edge and only the track hood is allowed south of it.
        front_y=-4.51,
        back_y=4.33,
        hood_y=-4.75,
        sill_y0=-4.75,
        door_x0=-1.30, door_x1=1.30, door_head=2.55, leaf_lap=0.17,
    )
    P["wall_x0"], P["wall_x1"] = -5.28, 5.28
    return _derive(P)


def commerce_params() -> dict:
    """14 x 11 cells. The settlement's widest mass and its social interior."""
    P = _frame(13.30, 10.45, 0.42, 0.32)
    P.update(
        uid="commerce",
        label="commerce unit",
        cells=(14, 11),
        wall_top=3.55,
        int_ceiling=3.10,
        front_y=-4.985,
        back_y=4.805,
        hood_y=-5.225,
        sill_y0=-5.225,
        door_x0=-1.50, door_x1=1.50, door_head=2.60, leaf_lap=0.19,
    )
    P["wall_x0"], P["wall_x1"] = -6.23, 6.23
    return _derive(P)


def shelter_params() -> dict:
    """8 x 7 cells. The lowest, smallest, most repaired mass.

    Deliberately asymmetric: the shell is pulled 1.18 m east of the footprint's
    west edge so the rainwater cistern, downpipe and its footing get a real
    exterior service bay under the roof instead of being crammed into a 0.36 m
    eave strip. The door moves east with it, which is also why this unit's
    threshold does not sit on the building's centreline."""
    P = _frame(7.60, 6.65, 0.36, 0.28)
    P.update(
        uid="shelter",
        label="shelter unit",
        cells=(8, 7),
        wall_top=2.98,
        int_ceiling=2.56,
        front_y=-3.145,
        back_y=2.965,
        hood_y=-3.325,
        sill_y0=-3.325,
        door_x0=-0.05, door_x1=1.25, door_head=2.24, leaf_lap=0.15,
    )
    P["wall_x0"], P["wall_x1"] = -2.62, 3.44
    P["service_bay_x1"] = -2.62
    return _derive(P)


# --------------------------------------------------------------------------
# clone unit
# --------------------------------------------------------------------------


def build_clone(u: Unit, P: dict) -> DoorSpec:
    plinth_and_floor(u, P)
    wx0, wx1, fy, by = P["wall_x0"], P["wall_x1"], P["front_y"], P["back_y"]
    t, top = P["wall_t"], P["wall_top"]

    # -- shell -------------------------------------------------------------
    wall_run(u, "wall_back__", wx0, wx1, by - t, by, top, "x")
    wall_run(u, "wall_left__", wx0, wx0 + t, fy, by - t, top, "y")
    wall_run(u, "wall_right__", wx1 - t, wx1, fy, by - t, top, "y")

    dx0, dx1 = P["door_x0"] - 0.42, P["door_x1"] + 0.42
    wall_run(u, "wall_front__", wx0, dx0, fy, fy + t, top, "x")
    wall_run(u, "wall_front__", dx1, wx1, fy, fy + t, top, "x")

    hooded_vent(u, "wall_front__", (wx1 + dx1) * 0.5, fy - 0.02, fy + t,
                1.28, 0.92, 0.66)
    for cy in (-2.4, 1.2):
        u.box("wall_right__", "reveal", wx1, wx1 + 0.05, cy - 0.46, cy + 0.46,
              1.42, 2.28, detail=MID, bevel=0.006)
        u.box("wall_right__", "canvas", wx1 + 0.03, wx1 + 0.14,
              cy - 0.52, cy + 0.52, 2.28, 2.36, detail=FINE, bevel=0.006)

    door = entry_bay(u, P)

    # -- west pod service bay: the clone read, from outside -----------------
    # Three clone drums bulge THROUGH the west wall: most of each vessel is
    # inside the bay, and the exterior sees the bulge, its service reveal and a
    # charge lug. Everything stays inside the declared footprint.
    pod_cx = P["foot_x0"] + 0.52
    for cy in (-2.55, -0.35, 1.85):
        u.drum("mass__", "panel", pod_cx, cy, 0.34, 2.58, 0.50,
               segments=18, detail=CORE, bevel=0.010)
        u.drum("mass__", "steel", pod_cx, cy, 2.58, 2.80, 0.46, 0.28,
               segments=18, detail=MID, bevel=0.008)
        u.box("mass__", "reveal", P["foot_x0"] + 0.02, pod_cx - 0.28,
              cy - 0.20, cy + 0.20, 1.10, 2.16, detail=MID, bevel=0.008)
        u.box("mass__", "oxide", P["foot_x0"] + 0.06, P["foot_x0"] + 0.20,
              cy - 0.09, cy + 0.09, 0.62, 1.02, detail=FINE, bevel=0.006)
    u.box("mass__", "steel", P["foot_x0"], wx0 + 0.04, -3.20, 2.50,
          2.80, 2.94, detail=MID, bevel=0.010)
    u.box("mass__", "plinth", P["foot_x0"] + 0.06, wx0, -3.20, 2.50,
          0.0, 0.34, detail=MID, bevel=0.012, base_flare=0.06)

    # -- entry deck plus a three-bay sawtooth -------------------------------
    # The deck is a low flat plane whose south fascia sits directly over the
    # door head; it is what lets the sawtooth start far enough north that its
    # big camera-facing riser is fully visible instead of self-hidden.
    # The roof stops 0.10 m west of the shell so the pod bank stays open to the
    # sky: round 1 buried the building's whole clone read under the eave.
    deck_y1 = -3.60
    deck_z = 3.24
    fx0, fx1, fy1 = wx0 - 0.10, P["foot_x1"], P["foot_y1"]
    sloped_roof(u, fx0, fx1, fy, deck_y1, deck_z, deck_z, 0.20)
    roof_bay_breaks(u, fx0, fx1, fy, deck_y1, deck_z, deck_z)

    #: (south y, north y, riser bottom). Every ridge shares one datum at
    #: `ridge_z`, so the roof reads as one sawtooth rather than a stepped ramp,
    #: and each fall is deep enough that the next riser carries real louvres.
    ridge_z = 5.42
    fall = 1.24
    bays = ((deck_y1, -1.30, deck_z), (-1.30, 1.10, None), (1.10, fy1, None))
    previous_low = None
    for y_s, y_n, riser_bottom in bays:
        z_n = ridge_z - fall * ((y_n - y_s) / 2.40)
        if riser_bottom is None:
            riser_bottom = previous_low
        sloped_roof(u, fx0, fx1, y_s, y_n, ridge_z, z_n, 0.22,
                    patches=(((fx0 + 1.4, fx0 + 3.2, y_s + 0.4, y_s + 1.5),)
                             if y_s == -1.30 else ()))
        roof_bay_breaks(u, fx0, fx1, y_s, y_n, ridge_z, z_n)
        roof_walkway(u, fx0 + 0.5, fx1 - 0.5, (y_s + y_n) * 0.5,
                     ridge_z, z_n, y_s, y_n)
        # South-facing riser: the camera-facing structure of the sawtooth, and
        # the only place in the kit where louvres are allowed to repeat.
        riser_top = ridge_z - 0.22
        u.box("roof__", "panel", fx0, fx1, y_s - 0.02, y_s + 0.20,
              riser_bottom, riser_top, detail=CORE, bevel=0.014)
        u.box("roof__", "steel", fx0, fx1, y_s - 0.06, y_s + 0.06,
              riser_bottom, riser_bottom + 0.12, detail=MID, bevel=0.008)
        height = riser_top - riser_bottom
        if height >= 0.62:
            span = fx1 - fx0
            for k in range(3):
                cx = fx0 + span * (0.19 + 0.31 * k)
                hooded_vent(u, "roof__", cx, y_s - 0.03, y_s + 0.18,
                            riser_bottom + 0.16, span * 0.16, height - 0.40)
        previous_low = z_n

    # -- exhaust stack: the settlement's only vertical accent ---------------
    sx, sy = 4.05, 2.95
    u.drum("mass__", "steel", sx, sy, 0.0, 6.30, 0.42, segments=16,
           detail=CORE, bevel=0.010)
    u.drum("mass__", "oxide", sx, sy, 6.30, 7.02, 0.46, 0.40, segments=16,
           detail=CORE, bevel=0.010)
    u.drum("mass__", "reveal", sx, sy, 7.02, 7.16, 0.40, segments=16,
           detail=MID, bevel=0.006)
    for bz in (2.15, 4.35):
        u.drum("mass__", "steel", sx, sy, bz, bz + 0.14, 0.50, segments=16,
               detail=FINE, bevel=0.006)
    u.box("mass__", "steel", sx - 0.06, sx + 0.06, sy - 1.35, sy - 0.42,
          4.30, 4.42, detail=FINE, bevel=0.006)

    # -- interior ----------------------------------------------------------
    interior_lining(u, P, top=P["int_ceiling"])
    # Pod bays: three cast pedestals with service kerbs. The actual clone pods
    # are external instanced assets and are never embedded here.
    for cx in (-3.30, 0.0, 3.30):
        u.box("interior__", "plinth", cx - 0.95, cx + 0.95, 2.10, 3.92,
              FLOOR_TOP, FLOOR_TOP + 0.13, detail=MID, bevel=0.010)
        u.box("interior__", "steel", cx - 1.02, cx - 0.90, 2.04, 3.98,
              FLOOR_TOP, FLOOR_TOP + 0.26, detail=FINE, bevel=0.008)
        u.box("interior__", "steel", cx + 0.90, cx + 1.02, 2.04, 3.98,
              FLOOR_TOP, FLOOR_TOP + 0.26, detail=FINE, bevel=0.008)
        u.box("interior__", "reveal", cx - 0.80, cx + 0.80, 3.86, 3.98,
              FLOOR_TOP + 0.13, 1.62, detail=MID, bevel=0.008)
        u.box("interior__", "oxide", cx - 0.16, cx + 0.16, 3.90, 3.98,
              1.62, 1.96, detail=FINE, bevel=0.006)
    # Overhead service rail over the pod line: reads as a working facility.
    u.box("interior__", "steel", -4.40, 4.40, 2.86, 3.04, 2.72, 2.94,
          detail=MID, bevel=0.010)
    for cx in (-4.30, 0.0, 4.30):
        u.box("interior__", "steel", cx - 0.09, cx + 0.09, 2.88, 3.02,
              2.30, 2.94, detail=FINE, bevel=0.006)
    # West service counter under the pod bank.
    u.box("interior__", "steel", -4.86, -3.60, -2.05, -0.35,
          FLOOR_TOP, 0.94, detail=MID, bevel=0.012)
    u.box("interior__", "panel", -4.90, -3.56, -2.09, -0.31,
          0.94, 1.02, detail=MID, bevel=0.010)
    for cy in (-1.4, 1.0, 3.0):
        task_light(u, 0.0, cy, z=P["int_ceiling"] - 0.14)
    task_light(u, -3.6, -1.2, z=P["int_ceiling"] - 0.14)
    return door


# --------------------------------------------------------------------------
# commerce unit
# --------------------------------------------------------------------------


def build_commerce(u: Unit, P: dict) -> DoorSpec:
    plinth_and_floor(u, P)
    wx0, wx1, fy, by = P["wall_x0"], P["wall_x1"], P["front_y"], P["back_y"]
    t, top = P["wall_t"], P["wall_top"]

    wall_run(u, "wall_back__", wx0, wx1, by - t, by, top, "x", pilaster_step=2.9)
    wall_run(u, "wall_left__", wx0, wx0 + t, fy, by - t, top, "y", pilaster_step=2.9)
    wall_run(u, "wall_right__", wx1 - t, wx1, fy, by - t, top, "y", pilaster_step=2.9)
    dx0, dx1 = P["door_x0"] - 0.42, P["door_x1"] + 0.42
    wall_run(u, "wall_front__", wx0, dx0, fy, fy + t, top, "x", pilaster_step=2.9)
    wall_run(u, "wall_front__", dx1, wx1, fy, fy + t, top, "x", pilaster_step=2.9)

    # Re-skinned western bays behind a raised flashing bar: the repair history.
    u.box("wall_front__", "canvas", wx0 + 0.04, -2.60, fy - 0.05, fy,
          BASE_BAND_Z, WALL_JOINT_Z - 0.06, detail=MID, bevel=0.010)
    u.box("wall_front__", "steel", wx0, -2.52, fy - 0.13, fy,
          WALL_JOINT_Z - 0.06, WALL_JOINT_Z + 0.06, detail=MID, bevel=0.008)
    hooded_vent(u, "wall_front__", 4.30, fy - 0.02, fy + t, 1.30, 0.98, 0.62)
    hooded_vent(u, "wall_front__", -4.30, fy - 0.02, fy + t, 1.30, 0.98, 0.62)

    door = entry_bay(u, P)

    # -- shade sails flanking, never covering, the threshold ---------------
    for sign in (-1.0, 1.0):
        ax = sign * 3.05
        bx = sign * 5.55
        u.slab("mass__", "canvas", min(ax, bx), max(ax, bx),
               P["foot_y0"] + 0.10, fy - 0.10, 2.72, 3.12, 0.05,
               detail=MID, bevel=0.006)
        for px, pz in ((min(ax, bx) + 0.12, 2.74), (max(ax, bx) - 0.12, 2.74)):
            u.box("mass__", "steel", px - 0.07, px + 0.07,
                  P["foot_y0"] + 0.14, P["foot_y0"] + 0.28,
                  0.0, pz + 0.30, detail=MID, bevel=0.008)
        u.box("mass__", "steel", min(ax, bx), max(ax, bx),
              P["foot_y0"] + 0.10, P["foot_y0"] + 0.20,
              3.02, 3.14, detail=FINE, bevel=0.006)

    # -- strongroom: a taller welded volume in the north-east corner --------
    # Kept east of x = 4.95 so its interior face never walls off the PA
    # counter or the trainer station's approach.
    sr_x0, sr_x1 = 4.95, wx1
    sr_y0, sr_y1 = 1.35, by
    u.box("roof__", "panel", sr_x0, sr_x1, sr_y0, sr_y1, top - 0.05, top + 1.05,
          detail=CORE, bevel=0.016, top_inset=0.05)
    u.box("roof__", "steel", sr_x0 - 0.06, sr_x1 + 0.02, sr_y0 - 0.06, sr_y1,
          top + 1.05, top + 1.22, detail=CORE, bevel=0.012)
    u.box("roof__", "oxide", sr_x0 + 0.30, sr_x0 + 0.52, sr_y0 - 0.08, sr_y0 + 0.02,
          top + 0.14, top + 0.92, detail=MID, bevel=0.008)
    hooded_vent(u, "roof__", (sr_x0 + sr_x1) * 0.5, sr_y0 - 0.06, sr_y0 + 0.10,
                top + 0.16, 1.10, 0.52)

    # -- ridge roof with a louvred monitor ---------------------------------
    ridge_y = 0.10
    ridge_z = 4.62
    sloped_roof(u, P["foot_x0"], P["foot_x1"], P["foot_y0"], ridge_y,
                3.62, ridge_z, 0.24)
    sloped_roof(u, P["foot_x0"], P["foot_x1"], ridge_y, P["foot_y1"],
                ridge_z, 3.70, 0.24,
                patches=((-4.6, -2.1, 1.5, 3.4), (1.4, 3.1, 2.6, 4.1)))
    roof_bay_breaks(u, P["foot_x0"], P["foot_x1"], P["foot_y0"], ridge_y,
                    3.62, ridge_z)
    roof_bay_breaks(u, P["foot_x0"], P["foot_x1"], ridge_y, P["foot_y1"],
                    ridge_z, 3.70)
    roof_walkway(u, P["foot_x0"] + 0.6, P["foot_x1"] - 0.6, -2.4,
                 3.62, ridge_z, P["foot_y0"], ridge_y)
    mon_x0, mon_x1 = -4.60, 2.10
    u.box("roof__", "panel", mon_x0, mon_x1, ridge_y - 1.15, ridge_y + 0.95,
          ridge_z - 0.10, ridge_z + 0.92, detail=CORE, bevel=0.014)
    u.box("roof__", "steel", mon_x0 - 0.10, mon_x1 + 0.10,
          ridge_y - 1.26, ridge_y + 1.05, ridge_z + 0.92, ridge_z + 1.08,
          detail=CORE, bevel=0.012)
    band_x0, band_x1 = mon_x0 + 0.45, mon_x1 - 0.45
    u.box("roof__", "reveal", band_x0, band_x1, ridge_y - 1.18, ridge_y - 1.06,
          ridge_z + 0.14, ridge_z + 0.72, detail=MID, bevel=0.008)
    for cx in (band_x0 + (band_x1 - band_x0) / 3.0,
               band_x0 + 2.0 * (band_x1 - band_x0) / 3.0):
        u.box("roof__", "steel", cx - 0.07, cx + 0.07,
              ridge_y - 1.21, ridge_y - 1.04, ridge_z + 0.12, ridge_z + 0.74,
              detail=FINE, bevel=0.006)

    # -- interior ----------------------------------------------------------
    interior_lining(u, P, top=P["int_ceiling"])
    # Three service counters on the north wall, one per terminal, each with a
    # different head so the functions are distinguishable by form.
    for cx, kind in ((-3.60, "bank"), (0.0, "trade"), (3.20, "pa")):
        u.box("interior__", "plinth", cx - 1.20, cx + 1.20, 2.55, 3.30,
              FLOOR_TOP, 0.98, detail=MID, bevel=0.012)
        u.box("interior__", "steel", cx - 1.26, cx + 1.26, 2.49, 3.36,
              0.98, 1.08, detail=MID, bevel=0.010)
        if kind == "bank":
            u.box("interior__", "steel", cx - 0.55, cx + 0.55, 3.30, 3.52,
                  1.08, 2.15, detail=MID, bevel=0.012)
            u.drum("interior__", "oxide", cx, 3.29, 1.42, 1.56, 0.26,
                   segments=16, detail=FINE, bevel=0.006)
        elif kind == "trade":
            u.box("interior__", "steel", cx - 0.07, cx + 0.07, 3.30, 3.44,
                  1.08, 2.32, detail=MID, bevel=0.008)
            for sx in (-0.62, 0.62):
                u.box("interior__", "panel", cx + sx - 0.30, cx + sx + 0.30,
                      3.24, 3.50, 1.96, 2.04, detail=FINE, bevel=0.006)
            u.box("interior__", "steel", cx - 0.66, cx + 0.66, 3.32, 3.42,
                  2.24, 2.32, detail=FINE, bevel=0.006)
        else:
            u.box("interior__", "steel", cx - 0.10, cx + 0.10, 3.32, 3.48,
                  1.08, 2.68, detail=MID, bevel=0.008)
            u.box("interior__", "canvas", cx - 0.04, cx + 0.62, 3.36, 3.44,
                  1.90, 2.62, detail=MID, bevel=0.006)
    # Waiting bench along the west wall and a low queue kerb, both retained.
    u.box("interior__", "plinth", wx0 + t, wx0 + t + 0.48, -1.15, 1.75,
          FLOOR_TOP, 0.46, detail=MID, bevel=0.010)
    u.box("interior__", "canvas", wx0 + t, wx0 + t + 0.52, -1.20, 1.80,
          0.46, 0.52, detail=FINE, bevel=0.008)
    for cx in (-3.60, 0.0, 3.20):
        u.box("interior__", "steel", cx - 0.90, cx + 0.90, 1.28, 1.36,
              FLOOR_TOP, 0.06, detail=FINE, bevel=0.004)
    # Strongroom face inside the east end.
    u.box("interior__", "steel", sr_x0 - 0.06, sr_x0 + 0.10, sr_y0, by - t,
          FLOOR_TOP, 2.55, detail=MID, bevel=0.012)
    u.box("interior__", "oxide", sr_x0 - 0.10, sr_x0 + 0.02, 1.95, 2.65,
          0.85, 1.62, detail=FINE, bevel=0.008)
    for cy in (-2.6, 0.6, 3.2):
        task_light(u, -1.8, cy, z=P["int_ceiling"] - 0.14)
        task_light(u, 2.6, cy, z=P["int_ceiling"] - 0.14)
    return door


# --------------------------------------------------------------------------
# shelter unit
# --------------------------------------------------------------------------


def build_shelter(u: Unit, P: dict) -> DoorSpec:
    plinth_and_floor(u, P)
    wx0, wx1, fy, by = P["wall_x0"], P["wall_x1"], P["front_y"], P["back_y"]
    t, top = P["wall_t"], P["wall_top"]

    wall_run(u, "wall_back__", wx0, wx1, by - t, by, top - 0.42, "x", pilaster_step=2.2)
    wall_run(u, "wall_left__", wx0, wx0 + t, fy, by - t, top, "y", pilaster_step=2.2)
    wall_run(u, "wall_right__", wx1 - t, wx1, fy, by - t, top, "y", pilaster_step=2.2)
    dx0, dx1 = P["door_x0"] - 0.42, P["door_x1"] + 0.42
    wall_run(u, "wall_front__", wx0, dx0, fy, fy + t, top, "x", pilaster_step=2.2)
    wall_run(u, "wall_front__", dx1, wx1, fy, fy + t, top, "x", pilaster_step=2.2)
    hooded_vent(u, "wall_front__", 2.35, fy - 0.02, fy + t, 1.22, 0.72, 0.54)
    u.box("wall_right__", "reveal", wx1, wx1 + 0.05, -0.55, 0.55, 1.46, 2.16,
          detail=MID, bevel=0.006)
    u.box("wall_right__", "canvas", wx1 + 0.03, wx1 + 0.15, -0.62, 0.62,
          2.16, 2.24, detail=FINE, bevel=0.006)
    # Patched wall panel: the shelter is the most-repaired mass in the kit.
    u.box("wall_left__", "canvas", wx0 - 0.04, wx0 + 0.02, -1.55, 0.35,
          1.05, 2.40, detail=MID, bevel=0.008)
    for cz in (1.12, 2.32):
        u.box("wall_left__", "steel", wx0 - 0.06, wx0 + 0.02, -1.62, 0.42,
              cz, cz + 0.07, detail=FINE, bevel=0.005)

    door = entry_bay(u, P)

    # -- single north-falling pitch, gutter, downpipe, cistern -------------
    sloped_roof(u, P["foot_x0"], P["foot_x1"], P["foot_y0"] + 0.55,
                P["foot_y1"], 3.46, 2.86, 0.20,
                patches=((-2.4, -0.7, 0.2, 1.7),))
    roof_bay_breaks(u, P["foot_x0"], P["foot_x1"], P["foot_y0"] + 0.55,
                    P["foot_y1"], 3.46, 2.86)
    roof_walkway(u, P["foot_x0"] + 0.4, P["foot_x1"] - 0.4, 1.35,
                 3.46, 2.86, P["foot_y0"] + 0.55, P["foot_y1"])
    gy = P["foot_y1"]
    u.box("roof__", "steel", P["foot_x0"] + 0.03, P["foot_x1"] - 0.03,
          gy - 0.20, gy - 0.03, 2.62, 2.86, detail=CORE, bevel=0.010,
          top_inset=-0.03)
    u.box("roof__", "reveal", P["foot_x0"] + 0.05, P["foot_x1"] - 0.05,
          gy - 0.15, gy - 0.04, 2.72, 2.86, detail=FINE, bevel=0.005)
    # Posts under the service-bay cantilever. A 1.18 m unsupported overhang on
    # a hand-maintained shelter reads as a rendering trick, not construction.
    post_x = P["foot_x0"] + 0.34
    for py, top_z in ((-2.45, 3.28), (0.30, 3.10), (2.85, 2.92)):
        u.box("mass__", "steel", post_x - 0.09, post_x + 0.09,
              py - 0.09, py + 0.09, 0.0, top_z, detail=CORE, bevel=0.010)
        u.box("mass__", "plinth", post_x - 0.22, post_x + 0.22,
              py - 0.22, py + 0.22, 0.0, 0.20, detail=MID, bevel=0.012,
              base_flare=0.05)
        # Knee brace back to the wall head: the joint that makes it credible.
        u.box("mass__", "steel", post_x + 0.09, P["service_bay_x1"] - 0.05,
              py - 0.05, py + 0.05, top_z - 0.52, top_z - 0.36,
              detail=FINE, bevel=0.006)
    # Downpipe and cistern live in the west service bay, under the roof but
    # outside the shell -- the one place this unit has room for them.
    bay_x = (P["foot_x0"] + P["service_bay_x1"]) * 0.5
    u.drum("mass__", "steel", bay_x, gy - 0.30, 1.02, 2.74, 0.09,
           segments=12, detail=MID, bevel=0.006)
    u.drum("mass__", "steel", bay_x, gy - 0.30, 0.88, 1.06, 0.12,
           segments=12, detail=FINE, bevel=0.006)
    cist_y = gy - 1.05
    u.drum("mass__", "panel", bay_x, cist_y, 0.16, 1.66, 0.50,
           segments=18, detail=CORE, bevel=0.010)
    u.drum("mass__", "canvas", bay_x, cist_y, 1.66, 1.80, 0.52, 0.42,
           segments=18, detail=MID, bevel=0.008)
    for hz in (0.52, 1.26):
        u.drum("mass__", "oxide", bay_x, cist_y, hz, hz + 0.07, 0.525,
               segments=18, detail=FINE, bevel=0.004)
    u.box("mass__", "oxide", bay_x + 0.44, bay_x + 0.56, cist_y - 0.07,
          cist_y + 0.07, 0.30, 0.56, detail=FINE, bevel=0.005)
    u.box("mass__", "plinth", P["foot_x0"] + 0.10, P["service_bay_x1"] - 0.06,
          cist_y - 0.70, cist_y + 0.70, 0.0, 0.16, detail=MID, bevel=0.010)
    # Salvaged tie-down anchors along the bay: the shelter is the kit's most
    # patched, most improvised mass.
    for ay in (-1.9, -0.4, 1.1):
        u.box("mass__", "steel", bay_x - 0.06, bay_x + 0.06, ay - 0.10, ay + 0.10,
              0.0, 0.22, detail=FINE, bevel=0.005)

    # -- interior ----------------------------------------------------------
    interior_lining(u, P, top=P["int_ceiling"])
    # Sleeping platform and a service pad. Real anchors for the instanced bunk,
    # footlocker, shelving and tank -- never stand-ins for them.
    u.box("interior__", "plinth", wx0 + t, wx0 + t + 1.30, -0.20, 2.35,
          FLOOR_TOP, 0.34, detail=MID, bevel=0.012)
    u.box("interior__", "steel", wx0 + t, wx0 + t + 1.36, -0.26, 2.41,
          0.34, 0.41, detail=MID, bevel=0.008)
    u.box("interior__", "steel", wx0 + t, wx0 + t + 0.34, -0.30, 2.45,
          1.34, 1.42, detail=FINE, bevel=0.006)
    u.box("interior__", "plinth", 1.60, 3.14, 1.60, 2.62,
          FLOOR_TOP, 0.30, detail=MID, bevel=0.010)
    u.box("interior__", "steel", 1.54, 3.16, 1.54, 2.66, 0.30, 0.37,
          detail=FINE, bevel=0.006)
    task_light(u, 0.60, 1.15, z=P["int_ceiling"] - 0.12)
    task_light(u, 0.60, -1.55, z=P["int_ceiling"] - 0.12)
    return door


BUILDERS = {
    "clone": (clone_params, build_clone),
    "commerce": (commerce_params, build_commerce),
    "shelter": (shelter_params, build_shelter),
}
