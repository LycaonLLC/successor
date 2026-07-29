"""Deterministic Blender blockout of the selected Dustgate direction.

    blender -b -P build_selected.py -- all        # combined review scene
    blender -b -P build_selected.py -- structures # per-structure GLBs

Geometry is derived from `layout.py`, so the layout document and the mesh can
never disagree about footprints, wall faces, door openings, or anchor cells.

Direction: "Leeward Terrace". One culture building in the lee of a single
ancient windbreak. The measured lesson from the three-way direction study is
that at the locked 60-degree pitch the roof plane owns roughly nine tenths of
the read, so:

  * roofs are the DARKEST large field and the ground is the lightest, giving a
    silhouette that survives the low-resolution grade;
  * no roof carries an unbroken value field wider than one structural bay;
  * every roof step, riser, monitor, and louvre face points SOUTH so it is
    camera-facing rather than self-hidden;
  * south eave overhangs stay at or under 0.55 m so the facade sliver visible
    at this pitch is never swallowed, and function is pushed FORWARD of the
    eave — a projecting wind lock, gantry, and sails — because a threshold
    flush with the wall sits inside the eave's own shadow and cannot be seen.

Local layout metres map to Blender metres as x_b = x_local - 20 (east) and
y_b = 14 - y_local (north), so Blender +Y is north and the glTF export lands on
the Successor world basis.
"""

from __future__ import annotations

import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import bpy  # type: ignore

import dgkit as dg
import layout as L
from dgpaths import proof

EAST_SHIFT = 20.0
NORTH_SHIFT = 14.0


def bx(x: float) -> float:
    return x - EAST_SHIFT


def by(y: float) -> float:
    return NORTH_SHIFT - y


def bounds(r: dict) -> tuple[float, float, float, float]:
    """Local rect -> Blender (x0, x1, y_south, y_north)."""
    return bx(r["x0"]), bx(r["x1"]), by(r["y1"]), by(r["y0"])


# --------------------------------------------------------------------------
# palette: roofs darkest, ground lightest, ancient work mid and cooler
# --------------------------------------------------------------------------

# Value ladder, lightest to darkest, checked by qa.py against measured
# relative luminance: sand > canvas > panel > ancient > roof_patch >
# panel_shade > ancient_deep > steel > roof > reveal. Human panel work stays
# warm; ancient stone stays cool, so the two scales never share a value AND a
# hue.
PALETTE = {
    "sand": ("#c1ad8d", 0.96, 0.0),
    "roof": ("#332f2a", 0.72, 0.15),
    "roof_patch": ("#6d6355", 0.80, 0.10),
    "canvas": ("#ab9f85", 0.92, 0.0),
    "panel": ("#9a8c72", 0.80, 0.0),
    "panel_shade": ("#5c5449", 0.86, 0.0),
    "reveal": ("#1d1a17", 0.95, 0.0),
    "ancient": ("#5f6060", 0.90, 0.0),
    "ancient_deep": ("#414341", 0.92, 0.0),
    "oxide": ("#8d4a2b", 0.78, 0.0),
    "steel": ("#413f3a", 0.52, 0.65),
    "proxy": ("#d7d9d4", 0.60, 0.0),
}

M: dict[str, object] = {}


def build_materials() -> None:
    M.clear()
    for key, (hexval, rough, metal) in PALETTE.items():
        M[key] = dg.mat(f"DG_{key}", hexval, rough=rough, metal=metal)
    M["amber"] = dg.mat("DG_amber", "#ffb347", rough=0.4, emission="#ffb347",
                        emission_strength=3.0)


# --------------------------------------------------------------------------
# ancient windbreak
# --------------------------------------------------------------------------


def build_ancient() -> None:
    for segment in L.ANCIENT["segments"]:
        x0, x1, ys, yn = bounds(segment["footprint"])
        h = segment["height_m"]
        if segment["name"] == "fallen_slab":
            hx, hy = (x1 - x0) * 0.5, (yn - ys) * 0.5
            slab = dg.boxm("ancient__fallen_slab", -hx, hx, -hy, hy, 0.0, h,
                           M["ancient"], chamfer=0.28, corner_segments=2,
                           top_inset=0.18)
            slab.rotation_euler = (math.radians(-7.0), 0.0, math.radians(4.0))
            slab.location = ((x0 + x1) * 0.5, (ys + yn) * 0.5, 0.06)
            continue
        dg.boxm(f"ancient__{segment['name']}", x0, x1, ys, yn, 0.0, h, M["ancient"],
                chamfer=0.26, corner_segments=2, top_inset=h * 0.075, base_flare=0.4)
        # Repeated bays: deep reveals between piers, not decoration. Pier heights
        # step down toward each break so the wall reads as ruined, not fenced.
        step = 4.4
        count = max(2, int((x1 - x0) / step))
        span = (x1 - x0 - 1.7) / max(1, count - 1)
        for i in range(count):
            px = x0 + 0.85 + span * i
            frac = 0.62 + 0.26 * (1.0 - abs((i / max(1, count - 1)) * 2.0 - 1.0))
            dg.boxm(f"ancient__{segment['name']}_pier_{i:02d}", px - 0.85, px + 0.85,
                    ys - 0.95, ys + 0.05, 0.0, h * frac, M["ancient"],
                    chamfer=0.2, corner_segments=2, top_inset=0.16, base_flare=0.3)
            if i < count - 1:
                rx = px + span * 0.5
                dg.boxm(f"ancient__{segment['name']}_reveal_{i:02d}", rx - 0.9,
                        rx + 0.9, ys - 0.24, ys + 0.02, 0.5, h * 0.68,
                        M["ancient_deep"])
    for i, (x, y, r) in enumerate(((-4.6, 9.1, 0.85), (-2.2, 8.6, 0.55),
                                   (9.2, 9.4, 0.7), (16.9, 10.6, 0.6))):
        dg.boxm(f"ancient__rubble_{i:02d}", x - r, x + r, y - r, y + r, 0.0, r * 1.15,
                M["ancient"], chamfer=r * 0.38, corner_segments=2)


# --------------------------------------------------------------------------
# shared shell kit
# --------------------------------------------------------------------------


def shell_floor(key: str, structure: dict) -> None:
    x0, x1, ys, yn = bounds(structure["shell"])
    fh = structure["floor_height_m"]
    dg.boxm(f"floor__{key}_slab", x0, x1, ys, yn, -0.12, fh, M["steel"],
            chamfer=0.14, corner_segments=2, base_flare=0.1)
    wx0, wx1, wys, wyn = bounds(structure["interior_walkable"])
    dg.boxm(f"floor__{key}_deck", wx0, wx1, wys, wyn, fh, fh + 0.03, M["panel_shade"])
    dg.boxm(f"floor__{key}_inset", wx0 + 0.6, wx1 - 0.6, wys + 0.6, wyn - 0.6,
            fh + 0.03, fh + 0.05, M["roof_patch"])


def shell_walls(key: str, structure: dict, north_top: float, south_top: float,
                side_profile) -> None:
    """Wall families. `side_profile(y_south, y_north)` returns the (y, z) outline."""
    x0, x1, ys, yn = bounds(structure["shell"])
    t = structure["wall_thickness_m"]
    door = structure["door"]
    dx0, dx1 = bx(door["opening"]["x0"]), bx(door["opening"]["x1"])
    dh = door["height_m"]

    dg.boxm(f"wall_back__{key}", x0, x1, yn - t, yn, 0.0, north_top, M["panel"])
    dg.boxm(f"wall_back__{key}_base", x0, x1, yn - t - 0.1, yn + 0.1, 0.0, 0.55,
            M["panel_shade"])
    dg.prism(f"wall_left__{key}", side_profile(ys, yn), "x", x0, x0 + t, M["panel"])
    dg.prism(f"wall_right__{key}", side_profile(ys, yn), "x", x1 - t, x1, M["panel"])
    dg.boxm(f"wall_front__{key}_west", x0, dx0, ys, ys + t, 0.0, south_top, M["panel"])
    dg.boxm(f"wall_front__{key}_east", dx1, x1, ys, ys + t, 0.0, south_top, M["panel"])
    dg.boxm(f"wall_front__{key}_lintel", dx0, dx1, ys, ys + t, dh, south_top,
            M["panel_shade"])
    dg.boxm(f"wall_front__{key}_base", x0, x1, ys - 0.1, ys + t + 0.1, 0.0, 0.55,
            M["panel_shade"])
    for i, dx in enumerate((dx0, dx1)):
        sign = -1.0 if i == 0 else 1.0
        dg.boxm(f"wall_front__{key}_jamb_{i:02d}", dx - 0.12 * (1 - i) - 0.0,
                dx + 0.12 * i, ys - 0.14, ys + t + 0.02, 0.0, dh + 0.28, M["steel"])
        _ = sign


def door_panel(key: str, structure: dict, suffix: str) -> None:
    door = structure["door"]
    opening = door["opening"]
    x0, x1, ys, yn = bounds(structure["shell"])
    t = structure["wall_thickness_m"]
    centre = (bx(opening["x0"]) + bx(opening["x1"])) * 0.5
    half = L.DOOR_PANEL_WIDTH * 0.5
    name = "door_slide" if not suffix else f"door_slide__{suffix}"
    dg.boxm(name, centre - half, centre + half, ys + 0.04, ys + t - 0.04, 0.02,
            door["height_m"], M["steel"], chamfer=0.06)
    dg.boxm(f"{name}_rail", centre - half - L.DOOR_PANEL_WIDTH, centre + half,
            ys - 0.02, ys + 0.06, door["height_m"] + 0.02, door["height_m"] + 0.2,
            M["steel"])


def wind_lock(key: str, structure: dict, eave_height: float) -> None:
    """Projecting threshold that clears the eave shadow at the locked 60-degree pitch."""
    lock = structure["wind_lock"]
    h = lock["height_m"]
    for ret in lock["returns"]:
        rx0, rx1, rys, ryn = bounds(ret["rect"])
        dg.boxm(f"mass__{key}_{ret['name']}", rx0, rx1, rys, ryn, 0.0, h,
                M["panel_shade"], chamfer=0.07, base_flare=0.12)
        dg.boxm(f"mass__{key}_{ret['name']}_cap", rx0 - 0.07, rx1 + 0.07, rys - 0.07,
                ryn + 0.07, h, h + 0.16, M["steel"])
    sx0, sx1, sys, syn = bounds(lock["sill"])
    dg.boxm(f"floor__{key}_threshold_sill", sx0, sx1, sys, syn, 0.0,
            lock["sill_height_m"], M["canvas"], chamfer=0.08, corner_segments=2)
    # The head beam ties the returns together above head height only, leaving the
    # sill strip open to the sky so it stays readable from above.
    lx0, _lx1, _lys, lyn = bounds(lock["returns"][0]["rect"])
    _rx0, rx1, _, _ = bounds(lock["returns"][1]["rect"])
    dg.boxm(f"mass__{key}_wind_lock_head", lx0, rx1, lyn - 0.34, lyn - 0.02,
            h - 0.42, h - 0.02, M["steel"])
    _ = eave_height


def facade_articulation(key: str, structure: dict, top: float) -> None:
    """Panel joint band plus two recessed low vents, so the visible facade
    sliver carries construction logic instead of reading as a blank sheet."""
    x0, x1, ys, _yn = bounds(structure["shell"])
    t = structure["wall_thickness_m"]
    band = min(2.35, top - 1.1)
    dg.boxm(f"wall_front__{key}_joint", x0 - 0.05, x1 + 0.05, ys - 0.07, ys + 0.02,
            band, band + 0.16, M["steel"])
    lock_x = [bounds(r["rect"]) for r in structure["wind_lock"]["returns"]]
    for i, cx in enumerate((x0 + (lock_x[0][0] - x0) * 0.5,
                            x1 - (x1 - lock_x[1][1]) * 0.5)):
        dg.boxm(f"wall_front__{key}_vent_{i:02d}", cx - 0.62, cx + 0.62, ys - 0.02,
                ys + t * 0.5, 0.95, 1.85, M["reveal"])
        dg.boxm(f"wall_front__{key}_vent_hood_{i:02d}", cx - 0.72, cx + 0.72,
                ys - 0.16, ys + 0.02, 1.85, 2.02, M["steel"])


def sloped_patch(name, x0, x1, ys, yn, z_south, z_north, material, lift=0.035):
    return dg.slab_sloped(name, x0, x1, ys, yn, z_south + lift, z_north + lift, 0.06,
                          material)


# --------------------------------------------------------------------------
# clone facility: sawtooth roof, west pod bank, south hoist gantry
# --------------------------------------------------------------------------


def build_clone(suffix: str) -> None:
    s = L.CLONE
    x0, x1, ys, yn = bounds(s["shell"])
    roof = s["roof"]
    ridge, valley = roof["ridge_m"], roof["valley_m"]
    bays = roof["bays"]
    depth = (yn - ys) / bays
    oh_s, oh_side = roof["eave_overhang_south_m"], roof["eave_overhang_side_m"]

    def side_profile(a: float, b: float):
        pts = [(a, 0.0), (b, 0.0), (b, valley)]
        for k in range(bays - 1, -1, -1):
            y_south = a + depth * k
            y_north = a + depth * (k + 1)
            pts.append((y_north, valley))
            pts.append((y_south, ridge))
            if k > 0:
                pts.append((y_south, valley))
        cleaned = []
        for p in pts:
            if not cleaned or abs(p[0] - cleaned[-1][0]) > 1e-6 or abs(p[1] - cleaned[-1][1]) > 1e-6:
                cleaned.append(p)
        return cleaned

    shell_floor("clone", s)
    shell_walls("clone", s, valley, ridge, side_profile)
    door_panel("clone", s, suffix)

    # sawtooth bays: high edge south, falling north, louvred riser facing south
    for k in range(bays):
        y_south = ys + depth * k
        y_north = ys + depth * (k + 1)
        ex0 = x0 - oh_side
        ex1 = x1 + oh_side
        south_edge = y_south - (oh_s if k == 0 else 0.0)
        dg.slab_sloped(f"roof__clone_bay_{k:02d}", ex0, ex1, south_edge, y_north,
                       ridge, valley, 0.2, M["roof"])
        dg.boxm(f"roof__clone_fascia_{k:02d}", ex0, ex1, south_edge - 0.06,
                south_edge + 0.1, ridge - 0.34, ridge + 0.06, M["steel"])
        # riser: the vertical step face exposed to the south
        if k > 0:
            dg.boxm(f"roof__clone_riser_{k:02d}", x0 - 0.05, x1 + 0.05, y_south - 0.16,
                    y_south + 0.02, valley - 0.1, ridge - 0.1, M["panel_shade"])
            for i in range(3):
                pitch = (x1 - x0 - 0.9) / 3.0
                lx = x0 + 0.45 + pitch * (i + 0.5)
                dg.boxm(f"roof__clone_louvre_{k:02d}_{i:02d}", lx - pitch * 0.44,
                        lx + pitch * 0.44, y_south - 0.3, y_south - 0.12,
                        valley + 0.06, ridge - 0.26, M["oxide"])
                dg.boxm(f"roof__clone_louvre_hood_{k:02d}_{i:02d}",
                        lx - pitch * 0.48, lx + pitch * 0.48, y_south - 0.46,
                        y_south - 0.24, ridge - 0.3, ridge - 0.14, M["steel"])
        # mismatched replacement panels break the value field
        if k == 1:
            sloped_patch(f"roof__clone_patch_{k:02d}", x0 + 1.1, x0 + 4.3,
                         y_south + 0.5, y_north - 0.4,
                         ridge - 0.19 * 0.5, valley + 0.19 * 0.4, M["roof_patch"])
        if k == 2:
            sloped_patch(f"roof__clone_patch_{k:02d}", x1 - 3.6, x1 - 0.9,
                         y_south + 0.6, y_north - 0.5,
                         ridge - 0.22, valley + 0.2, M["roof_patch"])

    # west pod bank: three drums bulging through the wall
    pod = next(m for m in s["exterior_masses"] if m["name"] == "pod_bulge")
    px0, px1, pys, pyn = bounds(pod["rect"])
    for i in range(3):
        cy = pys + (pyn - pys) * (i + 0.5) / 3.0
        dg.cylinder(f"interior__clone_pod_{i:02d}", x0, cy, 0.0, 2.55, 0.6, M["panel"],
                    segments=18)
        dg.cylinder(f"interior__clone_pod_cap_{i:02d}", x0, cy, 2.55, 3.15, 0.6,
                    M["oxide"], segments=18, top_radius=0.26)
        dg.boxm(f"interior__clone_pod_glass_{i:02d}", px0 - 0.06, px0 + 0.16,
                cy - 0.34, cy + 0.34, 0.72, 2.06, M["reveal"], chamfer=0.1,
                corner_segments=2)
        dg.boxm(f"interior__clone_pod_duct_{i:02d}", x0 + 0.1, x0 + 0.7,
                cy - 0.14, cy + 0.14, 2.9, 3.2, M["steel"])

    # interior fittings
    bx0, bx1, bys, byn = bounds(next(f for f in s["furniture_blockers"]
                                     if f["name"] == "vat_bench")["rect"])
    dg.boxm("interior__clone_vat_bench", bx0, bx1, bys, byn, 0.05, 1.0,
            M["panel_shade"], chamfer=0.08)
    for i in range(3):
        cx = bx0 + (bx1 - bx0) * (i + 0.5) / 3.0
        dg.cylinder(f"interior__clone_vat_{i:02d}", cx, (bys + byn) * 0.5, 1.0, 1.85,
                    0.28, M["reveal"], segments=14)
    cx0, cx1, cys, cyn = bounds(next(f for f in s["furniture_blockers"]
                                     if f["name"] == "coolant_bench")["rect"])
    dg.boxm("interior__clone_coolant_bench", cx0, cx1, cys, cyn, 0.05, 0.95,
            M["panel_shade"], chamfer=0.08)
    for i in range(2):
        dg.cylinder(f"interior__clone_coolant_drum_{i:02d}", cx0 + 0.55 + i * 1.0,
                    (cys + cyn) * 0.5, 0.95, 1.85, 0.4, M["steel"], segments=14)

    term = next(a for a in s["anchors"] if a["id"] == "study-clone-terminal")
    tx, ty = bx(term["cell"]["centre"][0]), by(term["cell"]["centre"][1])
    dg.boxm("interior__clone_terminal", tx - 0.3, tx + 0.3, ty - 0.45, ty + 0.45, 0.05,
            1.5, M["steel"], chamfer=0.07)
    dg.boxm("interior__clone_terminal_face", tx - 0.34, tx - 0.26, ty - 0.34, ty + 0.34,
            0.9, 1.4, M["amber"])

    # south hoist gantry: function pushed forward of the eave
    legs = [f for f in s["furniture_blockers"] if f["name"].startswith("hoist_leg")]
    xs = []
    for leg in legs:
        lx0, lx1, lys, lyn = bounds(leg["rect"])
        dg.boxm(f"mass__clone_{leg['name']}", lx0, lx1, lys, lyn, 0.0, 4.15,
                M["steel"], chamfer=0.06)
        xs.append((lx0 + lx1) * 0.5)
        dg.boxm(f"mass__clone_{leg['name']}_foot", lx0 - 0.24, lx1 + 0.24,
                lys - 0.24, lyn + 0.24, 0.0, 0.22, M["panel_shade"], chamfer=0.1)
    gy = (bounds(legs[0]["rect"])[2] + bounds(legs[0]["rect"])[3]) * 0.5
    dg.boxm("mass__clone_hoist_rail", min(xs) - 0.35, max(xs) + 0.35, gy - 0.19,
            gy + 0.19, 4.15, 4.52, M["steel"])
    dg.boxm("mass__clone_hoist_tie", min(xs) - 0.35, max(xs) + 0.35, gy - 0.19,
            ys + 0.2, 4.3, 4.46, M["steel"])
    dg.boxm("mass__clone_hoist_block", -0.55 + (min(xs) + max(xs)) * 0.5,
            0.55 + (min(xs) + max(xs)) * 0.5, gy - 0.32, gy + 0.32, 3.2, 4.15,
            M["oxide"], chamfer=0.12)
    wind_lock("clone", s, ridge)
    facade_articulation("clone", s, ridge)

    stack = roof["exhaust_stack"]
    sx, sy = bx(stack["cell"][0] + 0.5), by(stack["cell"][1] + 0.5)
    dg.cylinder("roof__clone_stack", sx, sy, valley - 1.4, stack["height_m"], 0.42,
                M["steel"], segments=16)
    dg.cylinder("roof__clone_stack_hood", sx, sy, stack["height_m"],
                stack["height_m"] + 0.72, 0.62, M["oxide"], segments=16,
                top_radius=0.24)
    for i in range(3):
        dg.cylinder(f"roof__clone_stack_hoop_{i:02d}", sx, sy,
                    valley + 0.5 + i * 1.7, valley + 0.68 + i * 1.7, 0.52, M["steel"],
                    segments=16)
    dg.boxm("roof__clone_stack_brace", sx - 0.09, sx + 0.09, sy, sy + 1.5,
            valley + 1.2, valley + 1.38, M["steel"])
    dg.boxm("wall_front__clone_signal", (x0 + x1) * 0.5 - 0.45,
            (x0 + x1) * 0.5 + 0.45, ys - 0.07, ys + 0.02, 2.62, 2.88, M["amber"])


# --------------------------------------------------------------------------
# commerce facility: ridge monitor, four upstand bays, welded strongroom
# --------------------------------------------------------------------------


def build_commerce(suffix: str) -> None:
    s = L.COMMERCE
    x0, x1, ys, yn = bounds(s["shell"])
    roof = s["roof"]
    ridge_y = by(roof["ridge_y_m"])
    eave, ridge = roof["eave_m"], roof["ridge_m"]
    oh_s, oh_side = roof["eave_overhang_south_m"], roof["eave_overhang_side_m"]

    def side_profile(a: float, b: float):
        return [(a, 0.0), (b, 0.0), (b, eave), (ridge_y, ridge), (a, eave)]

    shell_floor("commerce", s)
    shell_walls("commerce", s, eave, eave, side_profile)
    door_panel("commerce", s, suffix)

    ex0, ex1 = x0 - oh_side, x1 + oh_side
    dg.slab_sloped("roof__commerce_south", ex0, ex1, ys - oh_s, ridge_y, eave, ridge,
                   0.22, M["roof"])
    dg.slab_sloped("roof__commerce_north", ex0, ex1, ridge_y, yn + oh_side, ridge, eave,
                   0.22, M["roof"])
    dg.boxm("roof__commerce_ridge_cap", ex0, ex1, ridge_y - 0.2, ridge_y + 0.2,
            ridge - 0.04, ridge + 0.22, M["steel"])
    dg.boxm("roof__commerce_eave_south", ex0, ex1, ys - oh_s - 0.06, ys - oh_s + 0.12,
            eave - 0.36, eave + 0.04, M["steel"])
    # upstand beams: four bays, so no single dark field is wider than 3 m
    lines = [ex0 + (ex1 - ex0) * i / 4.0 for i in range(5)]
    for i, lx in enumerate(lines):
        dg.slab_sloped(f"roof__commerce_upstand_s_{i:02d}", lx - 0.12, lx + 0.12,
                       ys - oh_s, ridge_y, eave + 0.16, ridge + 0.16, 0.2, M["canvas"])
        dg.slab_sloped(f"roof__commerce_upstand_n_{i:02d}", lx - 0.12, lx + 0.12,
                       ridge_y, yn + oh_side, ridge + 0.16, eave + 0.16, 0.2,
                       M["canvas"])
    # ridge monitor with south louvres
    mono_x0, mono_x1 = x0 + 0.8, x1 - 0.8
    dg.boxm("roof__commerce_monitor", mono_x0, mono_x1, ridge_y - 1.1, ridge_y + 1.1,
            ridge - 0.25, roof["monitor_top_m"] - 0.2, M["panel"])
    vent_c = (mono_x0 + mono_x1) * 0.5
    dg.boxm("roof__commerce_monitor_vent", vent_c - 2.2, vent_c + 2.2,
            ridge_y - 1.18, ridge_y - 1.02, ridge + 0.24,
            roof["monitor_top_m"] - 0.44, M["reveal"])
    dg.boxm("roof__commerce_monitor_vent_sill", vent_c - 2.32, vent_c + 2.32,
            ridge_y - 1.28, ridge_y - 1.0, ridge + 0.1, ridge + 0.26, M["oxide"])
    for i in range(2):
        lx = vent_c - 0.74 + i * 1.48
        dg.boxm(f"roof__commerce_monitor_mullion_{i:02d}", lx - 0.14, lx + 0.14,
                ridge_y - 1.26, ridge_y - 0.98, ridge + 0.24,
                roof["monitor_top_m"] - 0.4, M["panel"])
    dg.slab_sloped("roof__commerce_monitor_cap_s", mono_x0 - 0.2, mono_x1 + 0.2,
                   ridge_y - 1.3, ridge_y, roof["monitor_top_m"] - 0.22,
                   roof["monitor_top_m"], 0.12, M["roof"])
    dg.slab_sloped("roof__commerce_monitor_cap_n", mono_x0 - 0.2, mono_x1 + 0.2,
                   ridge_y, ridge_y + 1.3, roof["monitor_top_m"],
                   roof["monitor_top_m"] - 0.22, 0.12, M["roof"])
    # the two western bays were re-skinned later: lighter panel, raised flashing
    sloped_patch("roof__commerce_reskin_s", ex0 + 0.06, lines[2] - 0.12,
                 ys - oh_s + 0.08, ridge_y, eave, ridge, M["roof_patch"])
    sloped_patch("roof__commerce_reskin_n", ex0 + 0.06, lines[2] - 0.12,
                 ridge_y, yn + oh_side - 0.08, ridge, eave, M["roof_patch"])
    dg.slab_sloped("roof__commerce_flashing_s", lines[2] - 0.2, lines[2] + 0.08,
                   ys - oh_s, ridge_y, eave + 0.24, ridge + 0.24, 0.24, M["steel"])
    dg.slab_sloped("roof__commerce_flashing_n", lines[2] - 0.2, lines[2] + 0.08,
                   ridge_y, yn + oh_side, ridge + 0.24, eave + 0.24, 0.24, M["steel"])

    # threshold piers forward of the eave, plus shade sails over the approach
    door = s["door"]
    dx0, dx1 = bx(door["opening"]["x0"]), bx(door["opening"]["x1"])
    wind_lock("commerce", s, eave)
    facade_articulation("commerce", s, eave)
    for post in (f for f in s["furniture_blockers"]
                 if f["name"].startswith("sail_post")):
        lx0, lx1, lys, lyn = bounds(post["rect"])
        dg.cylinder(f"mass__commerce_{post['name']}", (lx0 + lx1) * 0.5,
                    (lys + lyn) * 0.5, 0.0, 2.9, 0.16, M["steel"], segments=10)
    for sail in s["shade_sails"]:
        fx0, fx1, fys, fyn = bounds(sail["rect"])
        dg.slab_sloped(f"mass__commerce_{sail['name']}", fx0, fx1, fys, fyn, 2.5, 2.95,
                       0.06, M["canvas"])
        dg.boxm(f"mass__commerce_{sail['name']}_edge", fx0 - 0.06, fx1 + 0.06,
                fys - 0.07, fys + 0.07, 2.38, 2.56, M["steel"])
        for j, fx in enumerate((fx0, fx1)):
            dg.slab_sloped(f"mass__commerce_{sail['name']}_rib_{j:02d}", fx - 0.06,
                           fx + 0.06, fys, fyn, 2.44, 2.89, 0.07, M["steel"])

    # interior: three distinct terminal reads plus counters and crates
    for name, blocker in ((f["name"], f) for f in s["furniture_blockers"]
                          if f["name"].startswith(("counter", "crate"))):
        cx0, cx1, cys, cyn = bounds(blocker["rect"])
        top = 1.05 if name.startswith("counter") else 1.45
        dg.boxm(f"interior__commerce_{name}", cx0, cx1, cys, cyn, 0.05, top,
                M["panel_shade"], chamfer=0.09)
        if name.startswith("counter"):
            dg.boxm(f"interior__commerce_{name}_top", cx0 - 0.12, cx1 + 0.12,
                    cys - 0.12, cyn + 0.12, top, top + 0.1, M["panel"])

    reads = {
        "study-bank-terminal": "vault",
        "study-trade-terminal": "scale",
        "study-pa-terminal": "banner",
    }
    for anchor in s["anchors"]:
        cxc, cyc = bx(anchor["cell"]["centre"][0]), by(anchor["cell"]["centre"][1])
        if anchor["kind"] == "npc-trainer":
            continue
        kind = reads[anchor["id"]]
        base = anchor["id"].replace("study-", "").replace("-", "_")
        dg.boxm(f"interior__commerce_{base}", cxc - 0.45, cxc + 0.45, cyc - 0.32,
                cyc + 0.32, 0.05, 1.15, M["steel"], chamfer=0.08)
        dg.boxm(f"interior__commerce_{base}_face", cxc - 0.36, cxc + 0.36, cyc - 0.4,
                cyc - 0.3, 0.68, 1.1, M["amber"])
        if kind == "vault":
            dg.boxm(f"interior__commerce_{base}_head", cxc - 0.5, cxc + 0.5,
                    cyc - 0.42, cyc + 0.42, 1.15, 1.95, M["panel_shade"], chamfer=0.14,
                    corner_segments=2)
            dg.cylinder(f"interior__commerce_{base}_wheel", cxc, cyc - 0.44, 1.55, 1.62,
                        0.3, M["oxide"], segments=14)
        elif kind == "scale":
            dg.cylinder(f"interior__commerce_{base}_column", cxc, cyc, 1.15, 2.05, 0.11,
                        M["steel"], segments=10)
            dg.boxm(f"interior__commerce_{base}_beam", cxc - 0.72, cxc + 0.72,
                    cyc - 0.07, cyc + 0.07, 2.05, 2.15, M["steel"])
            for i, ox in enumerate((-0.62, 0.62)):
                dg.cylinder(f"interior__commerce_{base}_pan_{i:02d}", cxc + ox, cyc,
                            1.72, 1.8, 0.26, M["oxide"], segments=12)
        else:
            dg.cylinder(f"interior__commerce_{base}_mast", cxc, cyc, 1.15, 2.75, 0.09,
                        M["steel"], segments=10)
            dg.boxm(f"interior__commerce_{base}_banner", cxc - 0.02, cxc + 0.5,
                    cyc - 0.05, cyc + 0.05, 1.85, 2.7, M["oxide"])

    # strongroom annex welded to the east gable
    annex = next(m for m in s["exterior_masses"] if m["name"] == "strongroom_annex")
    ax0, ax1, ays, ayn = bounds(annex["rect"])
    h = annex["height_m"]
    dg.boxm("mass__commerce_annex", ax0, ax1, ays, ayn, 0.0, h, M["panel_shade"],
            chamfer=0.3, corner_segments=2, base_flare=0.3, top_inset=0.14)
    # Crop evidence (crops/commerce_annex_weld.png): a dark cap on a dark roof made
    # the annex silhouette the lowest-contrast junction in the study. A mid-value
    # cap separates its top edge without turning the annex into a pale blob.
    dg.boxm("mass__commerce_annex_cap", ax0 - 0.18, ax1 + 0.18, ays - 0.18, ayn + 0.18,
            h - 0.1, h + 0.24, M["roof_patch"])
    dg.boxm("mass__commerce_annex_rim", ax0 - 0.22, ax1 + 0.22, ays - 0.22, ayn + 0.22,
            h - 0.16, h - 0.02, M["oxide"])
    dg.boxm("mass__commerce_annex_band", ax0 - 0.06, ax1 + 0.06, ays - 0.06,
            ayn + 0.06, 2.3, 2.75, M["steel"])
    dg.boxm("mass__commerce_annex_hatch", ax0 - 0.16, ax0 + 0.06,
            (ays + ayn) * 0.5 - 0.85, (ays + ayn) * 0.5 + 0.85, 0.0, 2.3, M["steel"],
            chamfer=0.08)


# --------------------------------------------------------------------------
# starter shelter: single north-falling pitch, gutter, cistern, storm porch
# --------------------------------------------------------------------------


def build_shelter(suffix: str) -> None:
    s = L.SHELTER
    x0, x1, ys, yn = bounds(s["shell"])
    roof = s["roof"]
    high, low = roof["high_m"], roof["low_m"]
    top_s, top_n = s["wall_top_south_m"], s["wall_top_north_m"]

    def side_profile(a: float, b: float):
        return [(a, 0.0), (b, 0.0), (b, top_n), (a, top_s)]

    shell_floor("shelter", s)
    shell_walls("shelter", s, top_n, top_s, side_profile)
    door_panel("shelter", s, suffix)

    ex0 = x0 - roof["eave_overhang_side_m"]
    ex1 = x1 + roof["eave_overhang_side_m"]
    dg.slab_sloped("roof__shelter_pitch", ex0, ex1, ys - roof["eave_overhang_south_m"],
                   yn + roof["eave_overhang_north_m"], high, low, 0.18, M["roof"])
    for i in range(3):
        sx0 = ex0 + 0.35 + i * ((ex1 - ex0 - 0.7) / 3.0)
        dg.slab_sloped(f"roof__shelter_batten_{i:02d}", sx0, sx0 + 0.14,
                       ys - roof["eave_overhang_south_m"],
                       yn + roof["eave_overhang_north_m"], high + 0.12, low + 0.12,
                       0.16, M["canvas"])
    sloped_patch("roof__shelter_patch_00", ex0 + 1.4, ex0 + 3.5, yn - 2.4, yn + 0.2,
                 low + 0.55, low + 0.06, M["roof_patch"])
    gy = yn + roof["eave_overhang_north_m"]
    dg.boxm("roof__shelter_gutter", ex0, ex1 + 0.9, gy - 0.34, gy - 0.02, low - 0.34,
            low + 0.04, M["steel"])

    cistern = next(m for m in s["exterior_masses"] if m["name"] == "cistern")
    cx0, cx1, cys, cyn = bounds(cistern["rect"])
    ccx, ccy = (cx0 + cx1) * 0.5, (cys + cyn) * 0.5
    radius = min(cx1 - cx0, cyn - cys) * 0.5
    dg.cylinder("mass__shelter_cistern", ccx, ccy, 0.0, 2.5, radius,
                M["panel_shade"], segments=20)
    dg.cylinder("mass__shelter_cistern_cap", ccx, ccy, 2.5, 2.82, radius, M["oxide"],
                segments=20, top_radius=radius * 0.66)
    for i in range(3):
        dg.cylinder(f"mass__shelter_cistern_hoop_{i:02d}", ccx, ccy, 0.55 + i * 0.75,
                    0.68 + i * 0.75, radius + 0.06, M["steel"], segments=20)
    dg.boxm("mass__shelter_downpipe", ex1 + 0.62, ex1 + 0.86, gy - 0.28, gy - 0.04,
            0.0, low - 0.2, M["oxide"])
    dg.boxm("mass__shelter_feed", ex1 + 0.62, ccx + 0.12, gy - 0.26, ccy + 0.12,
            2.42, 2.6, M["oxide"])

    # storm porch, forward of the eave, on the building's own footprint only
    door = s["door"]
    dx0, dx1 = bx(door["opening"]["x0"]), bx(door["opening"]["x1"])
    wind_lock("shelter", s, high)
    facade_articulation("shelter", s, top_s)
    dg.boxm("wall_front__shelter_signal", (dx0 + dx1) * 0.5 - 0.35,
            (dx0 + dx1) * 0.5 + 0.35, ys - 0.06, ys + 0.02, 2.34, 2.56, M["amber"])

    for blocker in s["furniture_blockers"]:
        fx0, fx1, fys, fyn = bounds(blocker["rect"])
        top = 0.62 if blocker["name"] == "bunk" else 1.75
        dg.boxm(f"interior__shelter_{blocker['name']}", fx0, fx1, fys, fyn, 0.05, top,
                M["panel_shade"], chamfer=0.08)
        if blocker["name"] == "bunk":
            dg.boxm("interior__shelter_bunk_pad", fx0 + 0.08, fx1 - 0.08, fys + 0.08,
                    fyn - 0.08, top, top + 0.16, M["canvas"])


# --------------------------------------------------------------------------
# open-ground surfaces and scale proxies
# --------------------------------------------------------------------------


def build_freestanding() -> None:
    travel = next(i for i in L.FREESTANDING if i["id"] == "study-travel-terminal")
    tx0, tx1, tys, tyn = bounds(travel["footprint"])
    cxc, cyc = (tx0 + tx1) * 0.5, (tys + tyn) * 0.5
    dg.boxm("prop__travel_pad", tx0, tx1, tys, tyn, 0.0, 0.3, M["panel_shade"],
            chamfer=0.18, corner_segments=2, base_flare=0.12)
    dg.boxm("prop__travel_console", cxc - 0.62, cxc + 0.62, tys + 0.24, tys + 0.78, 0.3,
            1.42, M["panel"], chamfer=0.09)
    dg.boxm("prop__travel_screen", cxc - 0.5, cxc + 0.5, tys + 0.2, tys + 0.27, 0.82,
            1.36, M["amber"])
    # Deliberately NOT a mast with cross-arms: that reads as roadside utility
    # furniture, which this setting does not have. A squat drum beacon instead.
    dg.cylinder("prop__travel_drum", cxc, cyc + 0.44, 0.3, 2.05, 0.62, M["panel_shade"],
                segments=18)
    dg.cylinder("prop__travel_drum_band", cxc, cyc + 0.44, 1.28, 1.5, 0.68, M["steel"],
                segments=18)
    dg.cylinder("prop__travel_beacon", cxc, cyc + 0.44, 2.05, 2.62, 0.62, M["oxide"],
                segments=18, top_radius=0.34)
    dg.cylinder("prop__travel_beacon_lens", cxc, cyc + 0.44, 2.62, 2.78, 0.34,
                M["amber"], segments=18, top_radius=0.3)
    dg.boxm("prop__travel_dish", cxc - 0.5, cxc + 0.5, cyc + 0.06, cyc + 0.2, 1.55,
            2.45, M["steel"], chamfer=0.12, corner_segments=2)


def build_proxies() -> None:
    spots = [
        ("spawn", L.POINTS[0]["cell"]["centre"]),
        ("grok", next(i for i in L.FREESTANDING
                      if i["id"] == "study-grok")["anchor"]["centre"]),
        ("knox", next(a for a in L.COMMERCE["anchors"]
                      if a["kind"] == "npc-trainer")["cell"]["centre"]),
        ("clone_respawn", L.POINTS[1]["cell"]["centre"]),
        ("commerce_threshold", [21.5, 15.4]),
        ("clone_threshold", [8.9, 14.4]),
        ("shelter_threshold", [35.0, 13.4]),
        ("travel", [21.9, 21.8]),
    ]
    for name, (lx, ly) in spots:
        dg.capsule(f"proxy__{name}", bx(lx), by(ly), 0.0, 0.3, 1.75, M["proxy"])


# --------------------------------------------------------------------------
# assembly
# --------------------------------------------------------------------------

STRUCTURE_BUILDERS = {
    "clone": build_clone,
    "commerce": build_commerce,
    "shelter": build_shelter,
}


def build_scene(combined: bool, only: str | None = None) -> None:
    dg.reset()
    build_materials()
    if combined:
        dg.ground_plane("ground", 160.0, M["sand"])
        build_ancient()
        for key, builder in STRUCTURE_BUILDERS.items():
            builder(key)
        build_freestanding()
        build_proxies()
    else:
        STRUCTURE_BUILDERS[only]("")


def export_targets() -> list:
    return [o for o in dg.mesh_objects()
            if not o.name.startswith(("ground", "proxy__"))]


def report(tag: str) -> dict:
    meshes = dg.mesh_objects()
    payload = {
        "tag": tag,
        "mesh_count": len(meshes),
        "triangles": dg.triangle_count(meshes),
        "materials": len(bpy.data.materials),
        "bounds": dg.world_bounds(export_targets()),
    }
    print(f"[build {tag}] {payload}")
    return payload


def main() -> None:
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else ["all"]
    mode = argv[0]

    failures = L.validate()
    if failures:
        for line in failures:
            print(f"[build] LAYOUT FAIL {line}")
        raise SystemExit(1)

    if mode == "all":
        build_scene(combined=True)
        report("combined")
        dg.save_blend(proof("blend", "dustgate_selected_blockout.blend"))
        dg.export_glb(proof("glb", "dustgate_selected_review.glb"), export_targets())
    elif mode == "structures":
        for key in STRUCTURE_BUILDERS:
            build_scene(combined=False, only=key)
            report(key)
            dg.export_glb(proof("glb", f"dustgate_study_{key}.glb"), export_targets())
    else:
        raise SystemExit(f"unknown mode {mode!r}")


if __name__ == "__main__":
    main()
