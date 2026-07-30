"""Deterministic generator: Sinter-Frame Civic market building.

Authoring space: +X east, +Y north, +Z up; public front = -Y (glTF +Z).

  blender -b --factory-startup -noaudio -P src/build_market.py -- [--stage blockout|full]
"""
import hashlib
import json
import math
import os
import sys

import bpy

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import mlib as M  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TEX = os.path.join(ROOT, "build", "textures")
PROPDIR = os.path.abspath(os.path.join(ROOT, "..", "..", "..", "..",
                                       "client-3d", "public", "assets", "world-items"))

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
STAGE = argv[argv.index("--stage") + 1] if "--stage" in argv else "full"
DETAIL = STAGE == "full"

# ===========================================================================
# PARAMETERS — every dimension in metres, authored space
# ===========================================================================
P = dict(
    # footprint contract
    foot_x=5.70, foot_y=4.275, cell=0.95, floor_top=0.02, slab_bot=-0.32,
    # sintered base mass
    out_x=5.62, out_y=4.20, base_th=0.42, base_top=2.15, batter=0.075,
    # datum band
    reveal_top=2.24, flash_top=2.34, flash_out=0.10, reveal_in=0.11,
    # ceramic panel skin
    panel_th=0.26, panel_set=0.12,
    # hall
    hall_top=4.30, hall_parapet=4.72, hall_deck=4.38,
    # clerestory monitor
    mon_w=-3.60, mon_e=1.80, mon_s=-1.90, mon_n=0.80,
    mon_ridge_n=5.85, mon_ridge_s=5.50,
    # back of house
    boh_y0=1.50, boh_y1=2.26, boh_top=3.30, boh_parapet=3.62, boh_deck=3.36,
    # trainer bay
    tr_x0=2.00, tr_y1=-1.20, tr_top=3.64, tr_parapet=4.02, tr_deck=3.72,
    # loggia / entry
    log_w0=-4.15, log_w1=2.00, log_y1=-2.92, entry_in=-2.50, log_soffit=3.15,
    # sliding door
    door_cx=-0.475, door_w=2.00, door_h=2.50,
    leaf_w=2.24, leaf_h=2.56, leaf_t=0.08, leaf_y=-2.98, travel=-2.30,
    # rear service door
    svc_x=-1.00, svc_w=1.10, svc_h=2.20,
    # bulkhead pass-through
    pass_x=4.30, pass_w=0.95, pass_h=2.10,
    # alcoves
    alc_w=1.40, alc_h=2.40,
)
P["in_x"] = P["out_x"] - P["base_th"]        # 5.20
P["in_y"] = P["out_y"] - P["base_th"]        # 3.78
P["base_top_x"] = P["out_x"] - P["batter"]   # 5.545
P["base_top_y"] = P["out_y"] - P["batter"]   # 4.125
P["pan_x"] = P["out_x"] - P["panel_set"]     # 5.50
P["pan_y"] = P["out_y"] - P["panel_set"]     # 4.08
P["pan_in_x"] = P["pan_x"] - P["panel_th"]   # 5.24
P["pan_in_y"] = P["pan_y"] - P["panel_th"]   # 3.82

# fixture cells, measured from the north-west corner of the 12x9 grid
def cell(c, r):
    return (-P["foot_x"] + (c - 0.5) * P["cell"], P["foot_y"] - (r - 0.5) * P["cell"])

CELLS = {"bank": cell(3, 3), "trade": cell(6, 3), "assoc": cell(9, 3),
         "trainer": cell(10, 6)}

MAT = {}


def materials():
    t = TEX
    MAT["sinter"] = M.pbr_material("MKT_Sinter", t, "sinter")
    MAT["scour"] = M.pbr_material("MKT_SinterScoured", t, "sinter",
                                  factor=(1.34, 1.28, 1.18), rough_mul=1.04)
    MAT["ceramic"] = M.pbr_material("MKT_Ceramic", t, "ceramic")
    MAT["ceramic_d"] = M.pbr_material("MKT_CeramicShade", t, "ceramic",
                                      factor=(0.66, 0.65, 0.63))
    MAT["screed"] = M.pbr_material("MKT_Screed", t, "screed")
    MAT["roof"] = M.pbr_material("MKT_Roof", t, "roofmetal")
    MAT["steel"] = M.pbr_material("MKT_Steel", t, "steel")
    MAT["brass"] = M.pbr_material("MKT_Brass", t, "brass")
    MAT["dust"] = M.pbr_material("MKT_Dust", t, "screed",
                                 factor=(2.15, 1.98, 1.66), rough_mul=1.25)
    MAT["glass"] = M.plain_material("MKT_Glass", (0.42, 0.52, 0.55), 0.06, 0.0,
                                    alpha=0.30)
    MAT["seal"] = M.plain_material("MKT_Seal", (0.022, 0.022, 0.024), 0.86)
    MAT["lamp"] = M.plain_material("MKT_LampWarm", (0.95, 0.72, 0.42), 0.30,
                                   emit=(1.0, 0.74, 0.42), emit_str=9.0)
    MAT["cyan"] = M.plain_material("MKT_LampCyan", (0.32, 0.85, 0.92), 0.30,
                                   emit=(0.30, 0.86, 0.95), emit_str=5.0)


TILES = {"MKT_Sinter": 5.0, "MKT_SinterScoured": 5.0, "MKT_Ceramic": 5.0,
         "MKT_CeramicShade": 5.0, "MKT_Screed": 5.0, "MKT_Dust": 5.0,
         "MKT_Roof": 2.5, "MKT_Steel": 2.5, "MKT_Brass": 2.5}


# ===========================================================================
# SUBSYSTEM 1 — foundation, floor plate, thresholds
# ===========================================================================
def build_foundation():
    p, o = P, []
    ft, sb = p["floor_top"], p["slab_bot"]
    # structural slab under the whole envelope
    o.append(M.box("floor__slab", MAT["sinter"], (0, 0, (sb + ft) / 2 - 0.05),
                   (2 * p["out_x"], 2 * p["out_y"], (ft - 0.10) - sb), lod=2))
    # interior wearing screed (hall + trainer bay + BOH), 0.10 above the slab
    for nm, (x0, x1, y0, y1) in (
            ("hall", (-p["in_x"], p["in_x"], p["entry_in"], p["boh_y0"])),
            ("trainer", (p["tr_x0"] + p["base_th"], p["in_x"], -p["in_y"], p["entry_in"])),
            ("boh", (-p["in_x"], p["in_x"], p["boh_y1"], p["in_y"]))):
        o.append(M.box(f"floor__screed_{nm}", MAT["screed"],
                       ((x0 + x1) / 2, (y0 + y1) / 2, ft - 0.05),
                       (x1 - x0, y1 - y0, 0.10), lod=2))
    # loggia deck: same screed, brass expansion strips mark the threshold line
    o.append(M.box("floor__loggia", MAT["screed"],
                   ((p["log_w0"] + p["log_w1"]) / 2, (-p["out_y"] + p["log_y1"]) / 2,
                    ft - 0.05), (p["log_w1"] - p["log_w0"], p["log_y1"] + p["out_y"], 0.10),
                   lod=2))
    if not DETAIL:
        return o
    # brass threshold plate under the door line
    o.append(M.box("floor__threshold", MAT["brass"],
                   (p["door_cx"], p["log_y1"] - 0.03, ft - 0.008),
                   (p["door_w"] + 0.42, 0.30, 0.024), bev=0.006))
    # dust grate: slatted steel trough just inside the door
    gx, gy = p["door_cx"], p["entry_in"] + 0.34
    o.append(M.box("floor__grate_frame", MAT["steel"], (gx, gy, ft - 0.03),
                   (2.10, 0.62, 0.08), bev=0.006))
    for i in range(13):
        o.append(M.box(f"floor__grate_bar_{i}", MAT["steel"],
                       (gx - 0.94 + i * 0.157, gy, ft - 0.004),
                       (0.055, 0.58, 0.030), bev=0.004, lod=1))
    # sand fillet: wind-blown drift banked against the outside of the base
    for nm, c, s in (("w", (-p["out_x"] - 0.02, 0, ft + 0.05), (0.16, 2 * p["out_y"], 0.12)),
                     ("e", (p["out_x"] + 0.02, 0, ft + 0.04), (0.14, 2 * p["out_y"], 0.10)),
                     ("n", (0, p["out_y"] + 0.02, ft + 0.03), (2 * p["out_x"], 0.13, 0.09))):
        o.append(M.box(f"floor__drift_{nm}", MAT["dust"], c, s, bev=0.03, lod=1))
    return o


# ===========================================================================
# SUBSYSTEM 2 — sintered base mass (battered, buttressed)
# ===========================================================================
def _bwall_x(name, sign, y0, y1, lod=0):
    """Battered base wall on the east/west side. sign=-1 west, +1 east."""
    p = P
    xo, xt, xi = sign * p["out_x"], sign * p["base_top_x"], sign * p["in_x"]
    pts = [(xo, p["floor_top"]), (xt, p["base_top"]), (xi, p["base_top"]),
           (xi, p["floor_top"])]
    return M.prism(name, MAT["sinter"], pts, 1, y0, y1, bev=0.012, lod=lod)


def _bwall_y(name, sign, x0, x1, lod=0, inner=None):
    """Battered base wall on the north/south side. sign=-1 south, +1 north."""
    p = P
    yo, yt = sign * p["out_y"], sign * p["base_top_y"]
    yi = inner if inner is not None else sign * p["in_y"]
    pts = [(x0, yo), (x1, yo), (x1, yi), (x0, yi)]
    ob = M.prism(name, MAT["sinter"], [(a, b) for a, b in
                                       [(yo, p["floor_top"]), (yt, p["base_top"]),
                                        (yi, p["base_top"]), (yi, p["floor_top"])]],
                 0, x0, x1, bev=0.012, lod=lod)
    return ob


def build_base_walls():
    p, o = P, []
    ft, bt = p["floor_top"], p["base_top"]
    # ---- west and east flanks (full depth)
    o.append(_bwall_x("wall_left__base", -1, -p["out_y"], p["out_y"]))
    # east wall is interrupted by nothing; trainer bay shares it
    o.append(_bwall_x("wall_right__base", +1, -p["out_y"], p["out_y"]))
    # ---- north (rear) wall, with the service door opening
    sx0, sx1 = p["svc_x"] - p["svc_w"] / 2, p["svc_x"] + p["svc_w"] / 2
    for i, (a, b) in enumerate(((-p["out_x"], sx0), (sx1, p["out_x"]))):
        o.append(_bwall_y(f"wall_back__base_{i}", +1, a, b))
    o.append(M.box("wall_back__base_lintel", MAT["sinter"],
                   ((sx0 + sx1) / 2, (p["in_y"] + p["out_y"]) / 2,
                    (ft + p["svc_h"] + bt) / 2),
                   (sx1 - sx0, p["base_th"], bt - ft - p["svc_h"]), bev=0.012))
    # ---- south: two forward flank masses framing the loggia recess
    o.append(_bwall_y("wall_front__flank_w", -1, -p["out_x"], p["log_w0"],
                      inner=p["entry_in"]))
    # the trainer bay is the east flank; its south wall runs the same plane
    o.append(_bwall_y("wall_front__flank_e", -1, p["log_w1"], p["out_x"]))
    # ---- entry wall, set back, with the door opening
    dx0, dx1 = p["door_cx"] - p["door_w"] / 2, p["door_cx"] + p["door_w"] / 2
    o += M.wall("wall_front__entry", MAT["sinter"], 1, p["log_y1"], p["entry_in"],
                p["log_w0"], p["log_w1"], ft, bt,
                openings=[(dx0, dx1, ft, ft + p["door_h"])], bev=0.012)
    # ---- trainer bay west wall (loggia east jamb)
    o.append(M.box("wall_right__trainer_w", MAT["sinter"],
                   (p["tr_x0"] + p["base_th"] / 2, (-p["out_y"] + p["tr_y1"]) / 2,
                    (ft + bt) / 2),
                   (p["base_th"], p["tr_y1"] + p["out_y"], bt - ft), bev=0.012))
    if not DETAIL:
        return o
    # ---- buttress pilasters: positions driven by plan, deliberately irregular
    def pil(nm, x, y, w, d, h, grp):
        o.append(M.box(nm, MAT["sinter"], (x, y, (ft + h) / 2), (w, d, h - ft),
                       bev=0.014, group=grp))
    for i, y in enumerate((-1.90, 0.80, p["boh_y0"] + 0.10)):
        pil(f"wall_left__pilaster_{i}", -p["out_x"] - 0.055, y, 0.20, 0.62, bt - 0.18, "L")
        pil(f"wall_right__pilaster_{i}", p["out_x"] + 0.055, y, 0.20, 0.62, bt - 0.18, "R")
    pil("wall_right__pilaster_tr", p["out_x"] + 0.055, p["tr_y1"] - 0.30, 0.20, 0.55,
        bt - 0.18, "R")
    for i, x in enumerate((-4.62, -2.10, 1.24, 3.86)):
        pil(f"wall_back__pilaster_{i}", x, p["out_y"] + 0.055, 0.62, 0.20, bt - 0.18, "B")
    # loggia jamb pilasters read as the entry's structural frame
    for nm, x in (("w", p["log_w0"] - 0.10), ("e", p["log_w1"] + 0.10)):
        o.append(M.box(f"wall_front__jamb_{nm}", MAT["sinter"],
                       (x, -p["out_y"] + 0.30, (ft + bt + 0.30) / 2),
                       (0.20, 0.60, bt + 0.30 - ft), bev=0.014))
    # ---- scour course: the abraded band where sand actually cuts, expressed as a
    # recessed course in a paler, rougher finish instead of a painted gradient
    sc = 0.62
    for nm, sign in (("wall_left__scour", -1), ("wall_right__scour", +1)):
        o.append(M.box(nm, MAT["scour"], (sign * (p["out_x"] - 0.028), 0, ft + sc / 2),
                       (0.056, 2 * p["out_y"] - 0.02, sc), bev=0.01, lod=1))
    o.append(M.box("wall_front__scour_w", MAT["scour"],
                   ((-p["out_x"] + p["log_w0"]) / 2, -p["out_y"] + 0.028, ft + sc / 2),
                   (p["log_w0"] + p["out_x"] - 0.02, 0.056, sc), bev=0.01, lod=1))
    o.append(M.box("wall_front__scour_e", MAT["scour"],
                   ((p["log_w1"] + p["out_x"]) / 2, -p["out_y"] + 0.028, ft + sc / 2),
                   (p["out_x"] - p["log_w1"] - 0.02, 0.056, sc), bev=0.01, lod=1))
    o.append(M.box("wall_back__scour", MAT["scour"],
                   (0, p["out_y"] - 0.028, ft + sc / 2),
                   (2 * p["out_x"] - 0.02, 0.056, sc * 0.7), bev=0.01, lod=1))
    return o


# ===========================================================================
# SUBSYSTEM 3 — datum band: shadow reveal + brass drip flashing
# ===========================================================================
def build_datum():
    p, o = P, []
    rz0, rz1, fz1 = p["base_top"], p["reveal_top"], p["flash_top"]
    ri, fo = p["reveal_in"], p["flash_out"]
    sides = (("wall_left__", 0, -1), ("wall_right__", 0, +1),
             ("wall_back__", 1, +1), ("wall_front__", 1, -1))
    for nm, ax, sg in sides:
        if ax == 0:
            xr = sg * (p["base_top_x"] - ri)
            o.append(M.box(nm + "reveal", MAT["ceramic_d"],
                           (xr - sg * 0.09, 0, (rz0 + rz1) / 2),
                           (0.18, 2 * p["out_y"] - 0.02, rz1 - rz0), lod=1))
            xf = sg * (p["base_top_x"] + fo)
            o.append(M.box(nm + "flash", MAT["brass"],
                           (xf - sg * 0.16, 0, (rz1 + fz1) / 2),
                           (0.32, 2 * p["out_y"] - 0.01, fz1 - rz1), bev=0.008))
            o.append(M.box(nm + "drip", MAT["brass"], (xf - sg * 0.018, 0, rz1 - 0.028),
                           (0.036, 2 * p["out_y"] - 0.01, 0.056), bev=0.006, lod=1))
        else:
            yr = sg * (p["base_top_y"] - ri)
            o.append(M.box(nm + "reveal", MAT["ceramic_d"],
                           (0, yr - sg * 0.09, (rz0 + rz1) / 2),
                           (2 * p["out_x"] - 0.02, 0.18, rz1 - rz0), lod=1))
            yf = sg * (p["base_top_y"] + fo)
            o.append(M.box(nm + "flash", MAT["brass"], (0, yf - sg * 0.16, (rz1 + fz1) / 2),
                           (2 * p["out_x"] - 0.01, 0.32, fz1 - rz1), bev=0.008))
            o.append(M.box(nm + "drip", MAT["brass"], (0, yf - sg * 0.018, rz1 - 0.028),
                           (2 * p["out_x"] - 0.01, 0.036, 0.056), bev=0.006, lod=1))
    return o


# ===========================================================================
# SUBSYSTEM 4 — imported ceramic panel skin on the steel frame
# ===========================================================================
def _panel_run(name, axis, sign, a0, a1, z0, z1, openings=(), grp=""):
    """Panel skin + its expressed steel frame, on one side of the building."""
    p, o = P, []
    if axis == 0:
        lo, hi = sign * (P["pan_x"] - P["panel_th"]), sign * P["pan_x"]
        lo, hi = min(lo, hi), max(lo, hi)
    else:
        lo, hi = sign * (P["pan_y"] - P["panel_th"]), sign * P["pan_y"]
        lo, hi = min(lo, hi), max(lo, hi)
    o += M.wall(name, MAT["ceramic"], axis, lo, hi, a0, a1, z0, z1,
                openings=openings, bev=0.008, group=grp)
    if not DETAIL:
        return o
    # panel joints: real recessed shadow gaps, spaced by structural bay, not tiled
    face = sign * (P["pan_x"] if axis == 0 else P["pan_y"]) + sign * 0.004
    span = a1 - a0
    nj = max(1, int(round(span / 1.62)))
    for i in range(1, nj):
        u = a0 + span * i / nj
        if any(k[0] - 0.06 < u < k[1] + 0.06 for k in openings):
            continue
        c = ((face, u, (z0 + z1) / 2) if axis == 0 else (u, face, (z0 + z1) / 2))
        s = ((0.05, 0.028, z1 - z0) if axis == 0 else (0.028, 0.05, z1 - z0))
        o.append(M.box(f"{name}_joint_{i}", MAT["ceramic_d"], c, s, lod=1))
    # horizontal course line at two thirds height, and the head rail
    for frac, th, mat in ((0.62, 0.030, MAT["ceramic_d"]), (1.0, 0.075, MAT["steel"])):
        zz = z0 + (z1 - z0) * frac - th / 2
        c = ((face, (a0 + a1) / 2, zz) if axis == 0 else ((a0 + a1) / 2, face, zz))
        s = ((0.05, span, th) if axis == 0 else (span, 0.05, th))
        o.append(M.box(f"{name}_course_{int(frac*100)}", mat, c, s, lod=1))
    return o


def build_panel_walls():
    p, o = P, []
    z0 = p["flash_top"]
    # ---- west wall: hall height, then the lower BOH height
    o += _panel_run("wall_left__panel_hall", 0, -1, -p["out_y"], p["boh_y0"], z0,
                    p["hall_top"], grp="L")
    o += _panel_run("wall_left__panel_boh", 0, -1, p["boh_y0"], p["out_y"], z0,
                    p["boh_top"], grp="L")
    # ---- east wall: trainer height, hall height, BOH height
    o += _panel_run("wall_right__panel_tr", 0, +1, -p["out_y"], p["tr_y1"], z0,
                    p["tr_top"], grp="R")
    o += _panel_run("wall_right__panel_hall", 0, +1, p["tr_y1"], p["boh_y0"], z0,
                    p["hall_top"], grp="R")
    o += _panel_run("wall_right__panel_boh", 0, +1, p["boh_y0"], p["out_y"], z0,
                    p["boh_top"], grp="R")
    # ---- north wall: BOH height, with the louvered service band
    o += _panel_run("wall_back__panel", 1, +1, -p["out_x"], p["out_x"], z0,
                    p["boh_top"], grp="B")
    # ---- south: west flank, trainer flank, and the screen over the loggia
    o += _panel_run("wall_front__panel_w", 1, -1, -p["out_x"], p["log_w0"], z0,
                    p["hall_top"], grp="F")
    o += _panel_run("wall_front__panel_e", 1, -1, p["log_w1"], p["out_x"], z0,
                    p["tr_top"], grp="F")
    o += _panel_run("wall_front__screen", 1, -1, p["log_w0"], p["log_w1"],
                    p["log_soffit"] + 0.20, p["hall_top"], grp="F")
    # ---- entry wall panel inside the loggia recess
    o += M.wall("wall_front__entry_panel", MAT["ceramic"], 1, p["log_y1"],
                p["log_y1"] + p["panel_th"], p["log_w0"], p["log_w1"], z0,
                p["log_soffit"] + 0.20, bev=0.008, group="F")
    # ---- spandrels where the tall hall rises above the lower volumes
    o.append(M.box("wall_back__spandrel", MAT["ceramic"],
                   (0, p["boh_y0"] + 0.13, (p["boh_parapet"] + p["hall_parapet"]) / 2),
                   (2 * p["out_x"] - 0.24, 0.26, p["hall_parapet"] - p["boh_parapet"]),
                   bev=0.008, group="B"))
    o.append(M.box("wall_right__spandrel_tr_w", MAT["ceramic"],
                   (p["tr_x0"] - 0.13, (-p["out_y"] + p["tr_y1"]) / 2,
                    (p["tr_parapet"] + p["hall_parapet"]) / 2),
                   (0.26, p["tr_y1"] + p["out_y"], p["hall_parapet"] - p["tr_parapet"]),
                   bev=0.008, group="R"))
    o.append(M.box("wall_right__spandrel_tr_n", MAT["ceramic"],
                   ((p["tr_x0"] + p["out_x"]) / 2, p["tr_y1"] - 0.13,
                    (p["tr_parapet"] + p["hall_parapet"]) / 2),
                   (p["out_x"] - p["tr_x0"], 0.26, p["hall_parapet"] - p["tr_parapet"]),
                   bev=0.008, group="R"))
    if not DETAIL:
        return o
    # ---- louvered service band: only where back-of-house sits behind it
    for i in range(7):
        x = -4.30 + i * 1.35
        if abs(x - p["svc_x"]) < 0.75:
            continue
        for k in range(5):
            o.append(M.box(f"wall_back__louver_{i}_{k}", MAT["steel"],
                           (x, p["pan_y"] + 0.012, 2.62 + k * 0.115),
                           (1.02, 0.075, 0.055), bev=0.006, lod=1, group="B"))
        o.append(M.box(f"wall_back__louver_frame_{i}", MAT["steel"],
                       (x, p["pan_y"] + 0.006, 2.85), (1.13, 0.045, 0.72),
                       bev=0.008, lod=1, group="B"))
    return o


# ===========================================================================
# SUBSYSTEM 5 — loggia: soffit, cove, lintel, medallion, entry furniture
# ===========================================================================
def build_loggia():
    p, o = P, []
    w0, w1, sf = p["log_w0"], p["log_w1"], p["log_soffit"]
    # soffit slab, spanning the recess
    o.append(M.box("wall_front__soffit", MAT["ceramic_d"],
                   ((w0 + w1) / 2, (-p["out_y"] + p["log_y1"]) / 2, sf + 0.10),
                   (w1 - w0, p["log_y1"] + p["out_y"], 0.20), bev=0.01, group="F"))
    # deep lintel beam at the front edge of the recess
    o.append(M.box("wall_front__lintel", MAT["steel"],
                   ((w0 + w1) / 2, -p["out_y"] + 0.13, sf - 0.15),
                   (w1 - w0, 0.26, 0.34), bev=0.012, group="F"))
    if not DETAIL:
        return o
    o.append(M.box("wall_front__lintel_face", MAT["brass"],
                   ((w0 + w1) / 2, -p["out_y"] + 0.012, sf - 0.15),
                   (w1 - w0 - 0.04, 0.036, 0.22), bev=0.008, group="F"))
    # cove light trough along the back of the soffit
    o.append(M.box("wall_front__cove", MAT["steel"],
                   ((w0 + w1) / 2, p["log_y1"] - 0.16, sf - 0.06),
                   (w1 - w0 - 0.30, 0.16, 0.12), bev=0.01, group="F"))
    o.append(M.box("wall_front__cove_lamp", MAT["lamp"],
                   ((w0 + w1) / 2, p["log_y1"] - 0.16, sf - 0.115),
                   (w1 - w0 - 0.42, 0.10, 0.016), group="F"))
    # entry medallion: concentric brass rings with three notches. No lettering.
    mx, mz = p["door_cx"], sf + 0.62
    for i, (r, t) in enumerate(((0.42, 0.055), (0.30, 0.040), (0.16, 0.030))):
        o.append(M.cyl(f"wall_front__medallion_r{i}", MAT["brass"],
                       (mx, -p["pan_y"] - 0.03, mz), r, t, axis=1, n=40, group="F"))
    o.append(M.cyl("wall_front__medallion_hub", MAT["brass"],
                   (mx, -p["pan_y"] - 0.05, mz), 0.075, 0.07, axis=1, n=24, group="F"))
    for k in range(3):
        a = math.radians(90 + k * 120)
        o.append(M.box(f"wall_front__medallion_notch_{k}", MAT["ceramic_d"],
                       (mx + math.cos(a) * 0.30, -p["pan_y"] - 0.035,
                        mz + math.sin(a) * 0.30), (0.10, 0.09, 0.10), group="F"))
    # loggia bench and notice niche in the west flank
    o.append(M.box("wall_front__niche", MAT["ceramic_d"],
                   (w0 - 0.34, -p["out_y"] + 0.55, 1.55), (0.62, 0.10, 1.20),
                   bev=0.01, group="F"))
    o.append(M.box("wall_front__niche_frame", MAT["brass"],
                   (w0 - 0.34, -p["out_y"] + 0.50, 1.55), (0.70, 0.035, 1.28),
                   bev=0.008, group="F"))
    o.append(M.box("wall_front__bench", MAT["sinter"],
                   (w0 - 0.34, -p["out_y"] + 0.72, 0.45), (0.86, 0.44, 0.10),
                   bev=0.014, group="F"))
    for s in (-1, 1):
        o.append(M.box(f"wall_front__bench_leg_{s}", MAT["steel"],
                       (w0 - 0.34 + s * 0.32, -p["out_y"] + 0.72, 0.22),
                       (0.07, 0.36, 0.36), bev=0.006, group="F"))
    # dust brush post and boot scraper by the door
    o.append(M.cyl("wall_front__scraper_post", MAT["steel"],
                   (w1 - 0.55, -p["out_y"] + 0.85, 0.34), 0.045, 0.62, group="F"))
    o.append(M.box("wall_front__scraper_blade", MAT["brass"],
                   (w1 - 0.55, -p["out_y"] + 0.85, 0.10), (0.30, 0.05, 0.16),
                   bev=0.006, group="F"))
    return o


# ===========================================================================
# SUBSYSTEM 6 — sliding door: track, leaf, hangers, seals  (root node)
# ===========================================================================
def build_door():
    p, o = P, []
    cx, ly, lt = p["door_cx"], p["leaf_y"], p["leaf_t"]
    z0 = p["floor_top"]
    z1 = z0 + p["leaf_h"]
    hw = p["leaf_w"] / 2
    # ---- fixed track and hardware (part of the front wall)
    # Head arrangement, from the wall face outward:
    #   wall -2.92 | standoffs | rail -3.10..-3.06 | rollers | hanger plates -3.16..-3.12
    # The header cover sits above the rollers so nothing interpenetrates.
    wf = p["log_y1"]              # -2.92 wall face
    rail_y, rail_z = wf - 0.16, z1 + 0.105        # rail centre
    span = p["leaf_w"] + abs(p["travel"]) + 0.50
    trk = []
    trk.append(M.box("wall_front__track_header", MAT["steel"],
                     (cx - 1.15, wf - 0.10, z1 + 0.37), (span, 0.20, 0.18), bev=0.012,
                     group="F"))
    trk.append(M.box("wall_front__track_rail", MAT["steel"], (cx - 1.15, rail_y, rail_z),
                     (span - 0.06, 0.04, 0.08), bev=0.006, group="F"))
    for i in range(7):
        sx = cx - 3.40 + i * 0.95
        trk.append(M.box(f"wall_front__track_standoff_{i}", MAT["steel"],
                         (sx, wf - 0.07, rail_z), (0.07, 0.14, 0.09), bev=0.005,
                         group="F"))
        trk.append(M.box(f"wall_front__track_strap_{i}", MAT["steel"],
                         (sx, wf - 0.055, z1 + 0.26), (0.06, 0.11, 0.24), bev=0.005,
                         lod=1, group="F"))
    for s, sx in ((-1, cx - abs(p["travel"]) - hw - 0.09), (1, cx + hw + 0.09)):
        trk.append(M.box(f"wall_front__track_stop_{s}", MAT["brass"], (sx, rail_y, rail_z),
                         (0.075, 0.09, 0.11), bev=0.008, group="F"))
    # floor guide: two ribs the leaf shoe runs between
    for s, gy in ((-1, ly - 0.07), (1, ly + 0.07)):
        trk.append(M.box(f"wall_front__door_guide_{s}", MAT["steel"],
                         (cx - 1.15, gy, z0 + 0.010),
                         (p["leaf_w"] + abs(p["travel"]) + 0.40, 0.03, 0.020),
                         bev=0.003, group="F"))
    o += trk

    # ---- the moving leaf, built in world space then parented to the root empty
    leaf = []
    fr = 0.09
    leaf.append(M.box("door_slide__stile_l", MAT["steel"], (cx - hw + fr / 2, ly, (z0 + z1) / 2),
                      (fr, lt, z1 - z0), bev=0.008))
    leaf.append(M.box("door_slide__stile_r", MAT["steel"], (cx + hw - fr / 2, ly, (z0 + z1) / 2),
                      (fr, lt, z1 - z0), bev=0.008))
    leaf.append(M.box("door_slide__rail_top", MAT["steel"], (cx, ly, z1 - fr / 2),
                      (p["leaf_w"], lt, fr), bev=0.008))
    leaf.append(M.box("door_slide__rail_bot", MAT["steel"], (cx, ly, z0 + 0.16),
                      (p["leaf_w"], lt, 0.32), bev=0.008))
    leaf.append(M.box("door_slide__rail_mid", MAT["steel"], (cx, ly, z0 + 1.62),
                      (p["leaf_w"], lt * 0.98, 0.10), bev=0.008))
    # ceramic infill panels
    leaf.append(M.box("door_slide__panel_lo", MAT["ceramic"], (cx, ly, z0 + 0.97),
                      (p["leaf_w"] - 2 * fr, lt * 0.72, 1.30), bev=0.006))
    leaf.append(M.box("door_slide__panel_hi", MAT["ceramic"], (cx, ly, z0 + 2.20),
                      (p["leaf_w"] - 2 * fr, lt * 0.72, 0.62), bev=0.006))
    # vision slot
    leaf.append(M.box("door_slide__vision_frame", MAT["brass"], (cx, ly, z0 + 1.90),
                      (1.42, lt * 0.86, 0.34), bev=0.008))
    leaf.append(M.box("door_slide__vision_glass", MAT["glass"], (cx, ly, z0 + 1.90),
                      (1.30, lt * 0.50, 0.24)))
    if DETAIL:
        leaf.append(M.box("door_slide__kick", MAT["brass"], (cx, ly - lt * 0.42, z0 + 0.16),
                          (p["leaf_w"] - 2 * fr, 0.012, 0.30), bev=0.004))
        for s in (-1, 1):
            leaf.append(M.cyl(f"door_slide__pull_{s}", MAT["brass"],
                              (cx + s * 0.30, ly - lt * 0.60, z0 + 1.06), 0.026, 0.62,
                              axis=2, n=14))
            leaf.append(M.box(f"door_slide__pull_boss_{s}", MAT["brass"],
                              (cx + s * 0.30, ly - lt * 0.53, z0 + 1.06),
                              (0.07, 0.09, 0.07), bev=0.006))
        for s in (-1, 1):
            hx = cx + s * 0.75
            leaf.append(M.box(f"door_slide__hanger_{s}", MAT["steel"],
                              (hx, ly - 0.16, z1 + 0.11), (0.075, 0.04, 0.30),
                              bev=0.006))
            leaf.append(M.box(f"door_slide__hanger_foot_{s}", MAT["steel"],
                              (hx, ly - 0.09, z1 - 0.06), (0.075, 0.10, 0.10),
                              bev=0.006))
            leaf.append(M.cyl(f"door_slide__roller_{s}", MAT["steel"],
                              (hx, ly - 0.13, z1 + 0.20), 0.055, 0.05, axis=1, n=16))
            leaf.append(M.cyl(f"door_slide__axle_{s}", MAT["brass"],
                              (hx, ly - 0.145, z1 + 0.20), 0.018, 0.05, axis=1, n=10))
        leaf.append(M.box("door_slide__shoe", MAT["steel"], (cx, ly, z0 + 0.016),
                          (0.18, 0.055, 0.032), bev=0.004))
        for s in (-1, 1):
            leaf.append(M.box(f"door_slide__seal_{s}", MAT["seal"],
                              (cx + s * (hw - 0.004), ly, (z0 + z1) / 2),
                              (0.012, lt * 0.9, z1 - z0 - 0.02)))
    leafob = M.join(leaf, "door_slide__leaf")
    root = bpy.data.objects.new("door_slide", None)
    root.empty_display_size = 0.35
    bpy.context.scene.collection.objects.link(root)
    leafob.parent = root
    leafob.matrix_parent_inverse = root.matrix_world.inverted()
    # animation clips: 0.8 s at 30 fps = 24 frames, lateral local X.
    # keyframe_insert + NLA push-down is stable across Blender action API changes.
    sc = bpy.context.scene
    sc.frame_start, sc.frame_end = 0, 24
    root.animation_data_create()
    for clip, a, b in (("door_open", 0.0, p["travel"]), ("door_close", p["travel"], 0.0)):
        root.animation_data.action = None
        for fr_i, val in ((0, a), (24, b)):
            root.location = (val, 0.0, 0.0)
            root.keyframe_insert(data_path="location", frame=fr_i)
        act = root.animation_data.action
        act.name = clip
        act.use_fake_user = True
        tr = root.animation_data.nla_tracks.new()
        tr.name = clip
        st = tr.strips.new(clip, 0, act)
        st.name = clip
        tr.mute = True
    root.animation_data.action = None
    root.location = (0.0, 0.0, 0.0)
    return o + [leafob, root]


# ===========================================================================
# SUBSYSTEM 7 — roof: decks, parapets, clerestory monitor, plant, drainage
# ===========================================================================
def build_roof():
    p, o = P, []
    fx, fy = p["foot_x"], p["foot_y"]
    hd, bd, td = p["hall_deck"], p["boh_deck"], p["tr_deck"]
    # ---- decks
    for nm, x0, x1, y0, y1, z in (
            ("hall_a", -fx, p["tr_x0"], -fy, p["boh_y0"], hd),
            ("hall_b", p["tr_x0"], fx, p["tr_y1"], p["boh_y0"], hd),
            ("boh", -fx, fx, p["boh_y0"], fy, bd),
            ("trainer", p["tr_x0"], fx, -fy, p["tr_y1"], td)):
        o.append(M.box(f"roof__deck_{nm}", MAT["roof"], ((x0 + x1) / 2, (y0 + y1) / 2,
                                                          z - 0.09),
                       (x1 - x0, y1 - y0, 0.18), bev=0.01))
    # ---- standing seams, running with the fall (north-south)
    if DETAIL:
        for i in range(19):
            x = -fx + 0.30 + i * 0.60
            y0, y1 = -fy + 0.04, p["boh_y0"]
            if x > p["tr_x0"]:
                y0 = p["tr_y1"]
            o.append(M.box(f"roof__seam_h_{i}", MAT["roof"], (x, (y0 + y1) / 2, hd + 0.035),
                           (0.05, y1 - y0, 0.07), bev=0.008, lod=1))
        for i in range(19):
            x = -fx + 0.30 + i * 0.60
            o.append(M.box(f"roof__seam_b_{i}", MAT["roof"],
                           (x, (p["boh_y0"] + fy) / 2, bd + 0.035),
                           (0.05, fy - p["boh_y0"], 0.07), bev=0.008, lod=1))
        for i in range(6):
            x = p["tr_x0"] + 0.30 + i * 0.60
            o.append(M.box(f"roof__seam_t_{i}", MAT["roof"], (x, (-fy + p["tr_y1"]) / 2,
                                                              td + 0.035),
                           (0.05, p["tr_y1"] + fy, 0.07), bev=0.008, lod=1))
    # ---- parapets with brass coping
    def parapet(nm, c, s, top, base_z):
        o.append(M.box(f"roof__parapet_{nm}", MAT["ceramic"], (c[0], c[1],
                                                               (base_z + top) / 2),
                       (s[0], s[1], top - base_z), bev=0.01))
        o.append(M.box(f"roof__coping_{nm}", MAT["brass"], (c[0], c[1], top + 0.025),
                       (s[0] + 0.05, s[1] + 0.05, 0.05), bev=0.008, lod=1))
    hp, bp, tp = p["hall_parapet"], p["boh_parapet"], p["tr_parapet"]
    parapet("hall_w", (-fx + 0.09, (-fy + p["boh_y0"]) / 2), (0.18, p["boh_y0"] + fy),
            hp, hd - 0.18)
    parapet("hall_s", ((-fx + p["tr_x0"]) / 2, -fy + 0.09), (p["tr_x0"] + fx, 0.18),
            hp, hd - 0.18)
    parapet("boh_n", (0, fy - 0.09), (2 * fx, 0.18), bp, bd - 0.18)
    for s, nm in ((-1, "boh_w"), (1, "boh_e")):
        parapet(nm, (s * (fx - 0.09), (p["boh_y0"] + fy) / 2), (0.18, fy - p["boh_y0"]),
                bp, bd - 0.18)
    parapet("tr_s", ((p["tr_x0"] + fx) / 2, -fy + 0.09), (fx - p["tr_x0"], 0.18),
            tp, td - 0.18)
    parapet("tr_e", (fx - 0.09, (-fy + p["tr_y1"]) / 2), (0.18, p["tr_y1"] + fy),
            tp, td - 0.18)
    parapet("hall_e", (fx - 0.09, (p["tr_y1"] + p["boh_y0"]) / 2),
            (0.18, p["boh_y0"] - p["tr_y1"]), hp, hd - 0.18)

    # ---- clerestory monitor
    mw, me_, ms, mn = p["mon_w"], p["mon_e"], p["mon_s"], p["mon_n"]
    rs, rn = p["mon_ridge_s"], p["mon_ridge_n"]
    o.append(M.box("roof__mon_wall_s", MAT["ceramic"], ((mw + me_) / 2, ms + 0.09,
                                                        (hd + rs) / 2),
                   (me_ - mw, 0.18, rs - hd), bev=0.01))
    o.append(M.box("roof__mon_wall_n", MAT["ceramic"], ((mw + me_) / 2, mn - 0.09,
                                                        (hd + rn) / 2),
                   (me_ - mw, 0.18, rn - hd), bev=0.01))
    for s, x in ((-1, mw + 0.09), (1, me_ - 0.09)):
        M_ = M.prism(f"roof__mon_wall_{'w' if s < 0 else 'e'}", MAT["ceramic"],
                     [(ms, hd), (mn, hd), (mn, rn), (ms, rs)], 0, x - 0.09, x + 0.09,
                     bev=0.01)
        o.append(M_)
    # sloping monitor roof plane
    o.append(M.prism("roof__mon_roof", MAT["roof"],
                     [(ms - 0.16, rs), (mn + 0.16, rn), (mn + 0.16, rn + 0.14),
                      (ms - 0.16, rs + 0.14)], 0, mw - 0.16, me_ + 0.16, bev=0.01))
    # north glazing (no direct sun) + south brise-soleil
    o.append(M.box("roof__mon_glass", MAT["glass"], ((mw + me_) / 2, mn - 0.09,
                                                     (hd + 0.30 + rn - 0.16) / 2),
                   (me_ - mw - 0.42, 0.06, rn - 0.16 - hd - 0.30)))
    if DETAIL:
        for i in range(8):
            x = mw + 0.42 + i * 0.66
            o.append(M.box(f"roof__mon_mullion_{i}", MAT["steel"], (x, mn - 0.09,
                                                                    (hd + rn) / 2),
                           (0.07, 0.14, rn - hd - 0.20), bev=0.006, lod=1))
        for k in range(6):
            o.append(M.box(f"roof__mon_louver_{k}", MAT["steel"],
                           ((mw + me_) / 2, ms - 0.13, hd + 0.34 + k * 0.16),
                           (me_ - mw - 0.30, 0.20, 0.045), bev=0.006, lod=1))
        for s, x in ((-1, mw - 0.02), (1, me_ + 0.02)):
            o.append(M.box(f"roof__mon_louver_end_{s}", MAT["steel"], (x, ms - 0.13,
                                                                       hd + 0.66),
                           (0.05, 0.22, 0.80), bev=0.006, lod=1))
    if not DETAIL:
        return o

    # ---- plant deck equipment (authored here: the runtime roof props lack provenance)
    def condenser(nm, cx, cy):
        o.append(M.box(f"roof__{nm}_body", MAT["steel"], (cx, cy, bd + 0.34),
                       (1.02, 0.78, 0.68), bev=0.014, lod=1))
        o.append(M.box(f"roof__{nm}_cap", MAT["roof"], (cx, cy, bd + 0.70),
                       (1.06, 0.82, 0.05), bev=0.008, lod=1))
        o.append(M.cyl(f"roof__{nm}_fan", MAT["steel"], (cx, cy, bd + 0.735), 0.29, 0.05,
                       n=20, lod=1))
        for k in range(5):
            o.append(M.box(f"roof__{nm}_grille_{k}", MAT["steel"],
                           (cx - 0.51, cy, bd + 0.14 + k * 0.11), (0.03, 0.70, 0.055),
                           bev=0.004))
        for sx in (-1, 1):
            for sy in (-1, 1):
                o.append(M.box(f"roof__{nm}_foot_{sx}{sy}", MAT["steel"],
                               (cx + sx * 0.44, cy + sy * 0.32, bd + 0.03),
                               (0.12, 0.12, 0.06), bev=0.006))
    condenser("cond_a", -3.55, 3.30)
    condenser("cond_b", -2.05, 3.30)
    # cistern on a cradle
    o.append(M.cyl("roof__cistern", MAT["roof"], (3.30, 3.05, bd + 0.98), 0.82, 1.42,
                   n=24, lod=1))
    o.append(M.cyl("roof__cistern_band", MAT["steel"], (3.30, 3.05, bd + 1.34), 0.845,
                   0.07, n=24))
    o.append(M.cyl("roof__cistern_band2", MAT["steel"], (3.30, 3.05, bd + 0.62), 0.845,
                   0.07, n=24))
    for a in range(4):
        an = math.radians(45 + a * 90)
        o.append(M.box(f"roof__cistern_leg_{a}", MAT["steel"],
                       (3.30 + math.cos(an) * 0.60, 3.05 + math.sin(an) * 0.60, bd + 0.14),
                       (0.10, 0.10, 0.28), bev=0.006))
    o.append(M.cyl("roof__cistern_pipe", MAT["steel"], (3.30, 2.22, bd + 0.30), 0.055,
                   0.62, n=12))
    # comms mast
    o.append(M.cyl("roof__mast", MAT["steel"], (5.05, 2.05, bd + 1.55), 0.075, 3.10,
                   n=12, r2=0.045, lod=1))
    for k, (h, w) in enumerate(((2.30, 0.62), (2.72, 0.44))):
        o.append(M.box(f"roof__mast_arm_{k}", MAT["steel"], (5.05, 2.05, bd + h),
                       (w * 2, 0.06, 0.06), bev=0.006))
        for s in (-1, 1):
            o.append(M.cyl(f"roof__mast_can_{k}_{s}", MAT["steel"],
                           (5.05 + s * w, 2.05, bd + h + 0.13), 0.055, 0.22, n=10))
    o.append(M.box("roof__mast_base", MAT["steel"], (5.05, 2.05, bd + 0.06),
                   (0.34, 0.34, 0.12), bev=0.008))
    # roof hatch + ladder head
    o.append(M.box("roof__hatch", MAT["steel"], (-4.72, 2.60, bd + 0.09),
                   (0.82, 0.82, 0.18), bev=0.01, lod=1))
    o.append(M.box("roof__hatch_lid", MAT["roof"], (-4.72, 2.28, bd + 0.30),
                   (0.86, 0.10, 0.62), bev=0.01))
    for s in (-1, 1):
        o.append(M.cyl(f"roof__hatch_rail_{s}", MAT["steel"], (-4.72 + s * 0.44, 2.98,
                                                                bd + 0.45), 0.028, 0.90,
                       n=10))
    # conduit run from the plant deck to the monitor
    o.append(M.box("roof__conduit_a", MAT["steel"], (-2.80, 2.55, bd + 0.13),
                   (2.40, 0.07, 0.07), bev=0.006))
    o.append(M.box("roof__conduit_b", MAT["steel"], (-1.62, 2.02, bd + 0.13),
                   (0.07, 1.12, 0.07), bev=0.006))
    o.append(M.box("roof__junction", MAT["steel"], (-1.62, 1.62, bd + 0.22),
                   (0.26, 0.20, 0.30), bev=0.008))
    # scupper + downpipe on the west wall, which is why that wall is stained
    o.append(M.box("roof__scupper", MAT["brass"], (-fx + 0.09, -0.30, hd - 0.06),
                   (0.24, 0.30, 0.14), bev=0.008))
    o.append(M.cyl("roof__downpipe", MAT["steel"], (-p["pan_x"] - 0.10, -0.30, 2.40),
                   0.075, 3.80, n=12, lod=1))
    o.append(M.cyl("roof__downpipe_shoe", MAT["steel"], (-p["pan_x"] - 0.10, -0.30, 0.42),
                   0.09, 0.30, n=12))
    o.append(M.box("roof__splash", MAT["sinter"], (-p["out_x"] - 0.16, -0.30, 0.09),
                   (0.42, 0.62, 0.14), bev=0.02))
    return o


# ===========================================================================
# SUBSYSTEM 8 — interior: bulkhead, alcoves, built-ins, zoning, lighting
# ===========================================================================
def build_interior():
    p, o = P, []
    ix, iy = p["in_x"], p["in_y"]
    ft = p["floor_top"]
    y0, y1 = p["boh_y0"], p["boh_y1"]
    # ---- service bulkhead with three full-depth terminal alcoves + staff pass
    ops = []
    for k in ("bank", "trade", "assoc"):
        cx = CELLS[k][0]
        ops.append((cx - p["alc_w"] / 2, cx + p["alc_w"] / 2, ft, ft + p["alc_h"]))
    ops.append((p["pass_x"] - p["pass_w"] / 2, p["pass_x"] + p["pass_w"] / 2, ft,
                ft + p["pass_h"]))
    o += M.wall("interior__bulkhead", MAT["ceramic"], 1, y0, y1, -ix, ix, ft,
                p["hall_top"], openings=ops, bev=0.012)
    if DETAIL:
        # brass reveal frames around each service opening, and a sign panel above
        marks = {"bank": "sq", "trade": "cross", "assoc": "ring"}
        for k in ("bank", "trade", "assoc"):
            cx = CELLS[k][0]
            hw = p["alc_w"] / 2
            for s in (-1, 1):
                o.append(M.box(f"interior__alcove_{k}_jamb_{s}", MAT["brass"],
                               (cx + s * (hw + 0.03), y0 - 0.008, ft + p["alc_h"] / 2),
                               (0.06, 0.05, p["alc_h"]), bev=0.006))
            o.append(M.box(f"interior__alcove_{k}_head", MAT["brass"],
                           (cx, y0 - 0.008, ft + p["alc_h"] + 0.03),
                           (p["alc_w"] + 0.12, 0.05, 0.06), bev=0.006))
            # sign panel: geometric identifier only, no lettering
            o.append(M.box(f"interior__sign_{k}_plate", MAT["ceramic_d"],
                           (cx, y0 - 0.02, ft + p["alc_h"] + 0.52),
                           (1.05, 0.05, 0.72), bev=0.008))
            o.append(M.box(f"interior__sign_{k}_frame", MAT["brass"],
                           (cx, y0 - 0.035, ft + p["alc_h"] + 0.52),
                           (1.14, 0.03, 0.81), bev=0.006))
            mk = marks[k]
            if mk == "sq":
                for i, s in enumerate((0.46, 0.30, 0.15)):
                    o.append(M.box(f"interior__mark_{k}_{i}", MAT["brass"],
                                   (cx, y0 - 0.055, ft + p["alc_h"] + 0.52),
                                   (s, 0.02, s), bev=0.004))
            elif mk == "cross":
                for i, (a, b) in enumerate(((0.62, 0.10), (0.10, 0.46))):
                    o.append(M.box(f"interior__mark_{k}_{i}", MAT["brass"],
                                   (cx, y0 - 0.055, ft + p["alc_h"] + 0.52),
                                   (a, 0.02, b), bev=0.004))
            else:
                for i in range(6):
                    an = math.radians(i * 60)
                    o.append(M.cyl(f"interior__mark_{k}_{i}", MAT["brass"],
                                   (cx + math.cos(an) * 0.26, y0 - 0.055,
                                    ft + p["alc_h"] + 0.52 + math.sin(an) * 0.26),
                                   0.055, 0.02, axis=1, n=12))
            # downlight in each alcove head
            o.append(M.box(f"interior__alcove_{k}_light", MAT["lamp"],
                           (cx, y0 + 0.22, ft + p["alc_h"] - 0.04), (0.80, 0.14, 0.02)))
    # ---- ceiling planes
    hc, mw, me_, ms, mn = p["hall_top"], p["mon_w"], p["mon_e"], p["mon_s"], p["mon_n"]
    for nm, a, b, c, d in (("a", -ix, mw, p["entry_in"], y0),
                           ("b", me_, 2.42, p["entry_in"], y0),
                           ("c", mw, me_, p["entry_in"], ms),
                           ("d", mw, me_, mn, y0),
                           ("e", 2.42, ix, p["tr_y1"], y0)):
        o.append(M.box(f"interior__ceil_hall_{nm}", MAT["ceramic_d"],
                       ((a + b) / 2, (c + d) / 2, hc + 0.04), (b - a, d - c, 0.08),
                       bev=0.006))
    o.append(M.box("interior__ceil_trainer", MAT["ceramic_d"],
                   ((2.42 + ix) / 2, (-iy + p["tr_y1"]) / 2, p["tr_top"] + 0.04),
                   (ix - 2.42, p["tr_y1"] + iy, 0.08), bev=0.006))
    o.append(M.box("interior__ceil_boh", MAT["ceramic_d"], (0, (y1 + iy) / 2,
                                                             p["boh_top"] + 0.04),
                   (2 * ix, iy - y1, 0.08), bev=0.006))
    # ---- expressed roof structure
    for nm, yy in (("s", ms), ("n", mn)):
        o.append(M.box(f"interior__beam_{nm}", MAT["steel"], ((-ix + 2.42) / 2, yy,
                                                              hc - 0.28),
                       (ix + 2.42, 0.24, 0.56), bev=0.012))
    o.append(M.box("interior__beam_tr", MAT["steel"], ((2.42 + ix) / 2, p["tr_y1"],
                                                        hc - 0.28),
                   (ix - 2.42, 0.24, 0.56), bev=0.012))
    if DETAIL:
        for i in range(7):
            x = -4.60 + i * 1.62
            if x > 2.20:
                continue
            for (a, b) in ((p["entry_in"], ms), (mn, y0)):
                o.append(M.box(f"interior__purlin_{i}_{int(a*10)}", MAT["steel"],
                               (x, (a + b) / 2, hc - 0.14), (0.11, b - a, 0.28),
                               bev=0.008, lod=1))
        # corbels where the beams land
        for yy in (ms, mn):
            for s in (-1, 1):
                o.append(M.box(f"interior__corbel_{int(yy*10)}_{s}", MAT["steel"],
                               (s * (ix - 0.11), yy, hc - 0.62), (0.22, 0.34, 0.30),
                               bev=0.01))
    # ---- vendor / display zone (west)
    vx = -ix + 0.30
    o.append(M.box("interior__vendor_counter", MAT["sinter"], (vx + 0.02, -0.55, ft + 0.45),
                   (0.62, 2.60, 0.90), bev=0.016))
    o.append(M.box("interior__vendor_top", MAT["ceramic"], (vx + 0.06, -0.55, ft + 0.93),
                   (0.74, 2.68, 0.06), bev=0.01))
    o.append(M.box("interior__vendor_edge", MAT["brass"], (vx + 0.42, -0.55, ft + 0.93),
                   (0.05, 2.68, 0.075), bev=0.008))
    if DETAIL:
        for i in range(3):
            o.append(M.box(f"interior__vendor_shelf_{i}", MAT["steel"],
                           (vx - 0.10, -0.55, ft + 1.42 + i * 0.42),
                           (0.40 - i * 0.06, 2.50, 0.04), bev=0.006))
            o.append(M.box(f"interior__vendor_lip_{i}", MAT["brass"],
                           (vx + 0.10 - i * 0.03, -0.55, ft + 1.46 + i * 0.42),
                           (0.03, 2.50, 0.05), bev=0.004))
        for s in (-1, 1):
            o.append(M.box(f"interior__vendor_post_{s}", MAT["steel"],
                           (vx - 0.10, -0.55 + s * 1.25, ft + 1.60), (0.09, 0.09, 2.20),
                           bev=0.008))
        o.append(M.box("interior__vendor_rack", MAT["steel"], (vx + 0.30, -0.55, ft + 2.62),
                       (0.06, 2.50, 0.06), bev=0.006))
        for i in range(5):
            o.append(M.cyl(f"interior__vendor_hook_{i}", MAT["brass"],
                           (vx + 0.30, -1.55 + i * 0.50, ft + 2.50), 0.014, 0.20, n=8))
        o.append(M.box("interior__vendor_scale", MAT["brass"], (vx + 0.12, 0.42, ft + 1.05),
                       (0.26, 0.26, 0.18), bev=0.01))
        o.append(M.box("interior__vendor_light", MAT["lamp"], (vx + 0.16, -0.55, ft + 2.86),
                       (0.14, 2.20, 0.03)))
    # ---- trainer consultation (east)
    tx, ty = 4.60, -2.70
    o.append(M.box("interior__trainer_table", MAT["ceramic"], (tx, ty, ft + 0.72),
                   (1.16, 0.84, 0.07), bev=0.012))
    o.append(M.box("interior__trainer_apron", MAT["sinter"], (tx, ty, ft + 0.42),
                   (1.00, 0.68, 0.54), bev=0.014))
    if DETAIL:
        o.append(M.box("interior__trainer_edge", MAT["brass"], (tx, ty - 0.42, ft + 0.72),
                       (1.16, 0.05, 0.09), bev=0.008))
        o.append(M.box("interior__trainer_board", MAT["ceramic_d"], (ix - 0.06, ty, 1.95),
                       (0.06, 1.55, 1.05), bev=0.01))
        o.append(M.box("interior__trainer_board_frame", MAT["brass"], (ix - 0.10, ty, 1.95),
                       (0.03, 1.66, 1.16), bev=0.006))
        for i in range(4):
            o.append(M.box(f"interior__trainer_pin_{i}", MAT["cyan"],
                           (ix - 0.10, ty - 0.55 + i * 0.36, 1.72 + (i % 2) * 0.42),
                           (0.02, 0.07, 0.07)))
        o.append(M.box("interior__trainer_sconce", MAT["lamp"], (ix - 0.10, ty + 0.95, 2.45),
                       (0.05, 0.30, 0.10)))
        o.append(M.box("interior__trainer_kit", MAT["steel"], (tx + 0.30, ty + 0.05,
                                                                ft + 0.80),
                       (0.34, 0.24, 0.09), bev=0.01))
    # ---- circulation: brass queue rail defining the approach lane
    if DETAIL:
        for i, x in enumerate((-2.05, -0.55, 0.95)):
            o.append(M.cyl(f"interior__rail_post_{i}", MAT["brass"], (x, -0.35, ft + 0.50),
                           0.038, 0.96, n=12))
            o.append(M.cyl(f"interior__rail_foot_{i}", MAT["steel"], (x, -0.35, ft + 0.02),
                           0.10, 0.04, n=14))
        o.append(M.box("interior__rail_top", MAT["brass"], (-0.55, -0.35, ft + 0.96),
                       (3.00, 0.045, 0.045), bev=0.008))
    # ---- pendant lighting over the service row
    if DETAIL:
        for i, x in enumerate((-3.325, -0.475, 2.375)):
            o.append(M.cyl(f"interior__pend_rod_{i}", MAT["steel"], (x, 0.60, 3.55),
                           0.014, 1.45, n=8))
            o.append(M.cyl(f"interior__pend_shade_{i}", MAT["steel"], (x, 0.60, 2.78),
                           0.30, 0.20, n=20, r2=0.17))
            o.append(M.cyl(f"interior__pend_lamp_{i}", MAT["lamp"], (x, 0.60, 2.70),
                           0.155, 0.03, n=18))
    # ---- back of house
    o.append(M.box("interior__boh_bench", MAT["steel"], (3.20, iy - 0.32, ft + 0.44),
                   (1.90, 0.60, 0.88), bev=0.012))
    for i in range(4):
        o.append(M.box(f"interior__boh_shelf_{i}", MAT["steel"],
                       (-2.30, iy - 0.26, ft + 0.42 + i * 0.62), (4.60, 0.48, 0.05),
                       bev=0.006, lod=1))
    if DETAIL:
        for s in (-1, 1):
            o.append(M.box(f"interior__boh_shelf_post_{s}", MAT["steel"],
                           (-2.30 + s * 2.25, iy - 0.26, ft + 1.14), (0.07, 0.48, 2.28),
                           bev=0.006))
        o.append(M.box("interior__boh_switchgear", MAT["steel"], (ix - 0.24, 2.72, ft + 0.85),
                       (0.42, 0.74, 1.70), bev=0.012))
        for k in range(3):
            o.append(M.box(f"interior__boh_gear_led_{k}", MAT["cyan"],
                           (ix - 0.46, 2.52 + k * 0.16, ft + 1.42), (0.02, 0.06, 0.05)))
        o.append(M.cyl("interior__boh_riser", MAT["steel"], (3.30, 3.05, ft + 1.60), 0.09,
                       3.20, n=12))
        for i in range(7):
            o.append(M.cyl(f"interior__boh_ladder_r_{i}", MAT["steel"],
                           (-4.72, 3.30, ft + 0.30 + i * 0.42), 0.020, 0.46, axis=0, n=8))
        for s in (-1, 1):
            o.append(M.box(f"interior__boh_ladder_s_{s}", MAT["steel"],
                           (-4.72 + s * 0.23, 3.30, ft + 1.55), (0.05, 0.05, 3.05),
                           bev=0.006))
        o.append(M.box("interior__boh_light", MAT["lamp"], (0, 3.10, p["boh_top"] - 0.10),
                       (2.60, 0.10, 0.04)))
        o.append(M.box("interior__boh_light2", MAT["lamp"], (0, 1.95, p["boh_top"] - 0.10),
                       (2.60, 0.10, 0.04)))
        # threshold plate at the rear service door
        o.append(M.box("interior__svc_threshold", MAT["brass"], (p["svc_x"], iy + 0.20,
                                                                  ft - 0.006),
                       (p["svc_w"] + 0.16, 0.44, 0.028), bev=0.006))
    return o


# ===========================================================================
# SUBSYSTEM 9 — allowed loose props (read-only imports, provenance required)
# ===========================================================================
PROPS = [
    # (file, x, y, rot_z_deg, role)
    ("bank_terminal_civic.glb", CELLS["bank"][0], 1.90, 0.0, "bank service point"),
    ("trade_terminal.glb", CELLS["trade"][0], 1.90, 0.0, "trade/exchange point"),
    ("pa_terminal.glb", CELLS["assoc"][0], 1.90, 0.0, "association registry"),
    ("chair_frontier_a.glb", 4.60, -3.40, 180.0, "trainer seat"),
    ("chair_frontier_b.glb", 4.60, -2.00, 0.0, "visitor seat"),
    ("crate_planked.glb", -3.90, -1.30, 12.0, "vendor goods"),
    ("footlocker_frontier.glb", 3.00, -3.30, -8.0, "trainer kit locker"),
]


def import_props():
    out = []
    for fn, x, y, rz, role in PROPS:
        path = os.path.join(PROPDIR, fn)
        before = set(bpy.data.objects)
        bpy.ops.import_scene.gltf(filepath=path)
        new = [o for o in bpy.data.objects if o not in before]
        roots = [o for o in new if o.parent is None]
        e = bpy.data.objects.new(f"prop__{fn[:-4]}", None)
        e.empty_display_size = 0.2
        bpy.context.scene.collection.objects.link(e)
        for r in roots:
            r.parent = e
        e.location = (x, y, P["floor_top"])
        e.rotation_euler = (0, 0, math.radians(rz))
        out.append(e)
        out.extend(new)
    return out


def prop_records():
    recs = []
    rel = "client-3d/public/assets/world-items"
    for fn, x, y, rz, role in PROPS:
        path = os.path.join(PROPDIR, fn)
        h = hashlib.sha256(open(path, "rb").read()).hexdigest()
        pv = os.path.join(PROPDIR, fn[:-4] + ".provenance.json")
        recs.append({
            "file": f"{rel}/{fn}", "sha256": h,
            "provenance": f"{rel}/{fn[:-4]}.provenance.json" if os.path.exists(pv) else None,
            "role": role,
            "placement_asset_space": {"x": round(x, 4), "y": round(P["floor_top"], 4),
                                      "z": round(-y, 4), "yaw_deg": round(-rz, 2)},
            "placement_note": "asset space is glTF: +Y up, +Z front; yaw about +Y",
        })
    return recs


# ===========================================================================
# SUBSYSTEM 10 — weathering: caused wear written to COLOR_0 (darkening only)
# ===========================================================================
def _h1(v):
    s = math.sin(v * 12.9898) * 43758.5453
    return s - math.floor(s)


GRIME = [
    # (x, y, z, radius, strength) — where hands, feet and goods actually go
    (-1.475, -2.92, 1.05, 0.55, 0.34), (0.525, -2.92, 1.05, 0.55, 0.34),
    (-0.475, -2.92, 0.06, 1.60, 0.30), (-0.475, -2.50, 0.06, 1.50, 0.26),
    (-0.775, -3.02, 1.06, 0.42, 0.40), (-0.175, -3.02, 1.06, 0.42, 0.40),
    (-4.57, -0.55, 0.85, 0.95, 0.26), (-0.55, -0.35, 0.98, 1.60, 0.22),
    (4.60, -2.28, 0.75, 0.75, 0.24), (3.20, 3.46, 0.90, 1.10, 0.24),
    (-1.00, 3.78, 1.00, 0.85, 0.30),
]
for _k in ("bank", "trade", "assoc"):
    GRIME.append((CELLS[_k][0] - 0.73, 1.50, 1.05, 0.40, 0.30))
    GRIME.append((CELLS[_k][0] + 0.73, 1.50, 1.05, 0.40, 0.30))


def wear(pt, n, ao, ob):
    x, y, z = pt
    v = 0.42 + 0.58 * max(0.0, min(1.0, ao))          # baked ambient occlusion
    # contact grime
    g = 0.0
    for (gx, gy, gz, r, s) in GRIME:
        d = math.sqrt((x - gx) ** 2 + (y - gy) ** 2 + (z - gz) ** 2)
        if d < r:
            g = max(g, s * (1.0 - d / r) ** 1.4)
    # water staining below the drip flashing: irregular vertical streaks
    w = 0.0
    if z < P["flash_top"] and abs(n[2]) < 0.6:
        horiz = x if abs(n[1]) > abs(n[0]) else y
        st = _h1(horiz * 3.1 + 0.7) * 0.6 + _h1(horiz * 11.3) * 0.4
        if st > 0.62:
            fall = max(0.0, 1.0 - (P["flash_top"] - z) / 1.9)
            w = (st - 0.62) / 0.38 * 0.30 * fall
    # concentrated stain below the roof scupper on the west wall
    if x < -5.3 and abs(y + 0.30) < 0.55 and z < 4.3:
        w = max(w, 0.34 * (1.0 - abs(y + 0.30) / 0.55) * max(0.0, 1.0 - (4.3 - z) / 4.4))
    # cistern overflow stain on the north wall
    if y > 4.0 and abs(x - 3.30) < 0.50 and z < 3.4:
        w = max(w, 0.26 * (1.0 - abs(x - 3.30) / 0.50))
    d = max(g, w)
    # grime is warmer and darker; water stain is cooler
    r = v * (1.0 - d)
    gg = v * (1.0 - d * 1.05)
    b = v * (1.0 - d * 1.16)
    if w > g:
        r, gg, b = v * (1.0 - d * 1.12), v * (1.0 - d * 1.06), v * (1.0 - d)
    return (max(0.03, r), max(0.03, gg), max(0.03, b))


# ===========================================================================
# SUBSYSTEM 11 — collision proxies (authored, simple, named)
# ===========================================================================
def collision_boxes():
    p = P
    ft, hc = p["floor_top"], p["hall_top"]
    dx0, dx1 = p["door_cx"] - p["door_w"] / 2, p["door_cx"] + p["door_w"] / 2
    sx0, sx1 = p["svc_x"] - p["svc_w"] / 2, p["svc_x"] + p["svc_w"] / 2
    B = []

    def add(i, x0, x1, y0, y1, z0, z1, kind):
        B.append({"id": i, "shape": "box", "kind": kind,
                  "min": [round(x0, 4), round(z0, 4), round(-y1, 4)],
                  "max": [round(x1, 4), round(z1, 4), round(-y0, 4)]})
    # --- outer structure
    add("shell__wall_west", -p["out_x"], -p["in_x"], -p["out_y"], p["out_y"], ft, hc, "structure")
    add("shell__wall_east", p["in_x"], p["out_x"], -p["out_y"], p["out_y"], ft, hc, "structure")
    add("shell__wall_north_w", -p["out_x"], sx0, p["in_y"], p["out_y"], ft, p["boh_top"], "structure")
    add("shell__wall_north_e", sx1, p["out_x"], p["in_y"], p["out_y"], ft, p["boh_top"], "structure")
    add("shell__flank_west", -p["out_x"], p["log_w0"], -p["out_y"], p["entry_in"], ft, hc, "structure")
    add("shell__trainer_south", p["tr_x0"], p["out_x"], -p["out_y"], -p["in_y"], ft, p["tr_top"], "structure")
    add("shell__trainer_west", p["tr_x0"], p["tr_x0"] + p["base_th"], -p["out_y"], p["tr_y1"], ft, p["tr_top"], "structure")
    add("shell__entry_west", p["log_w0"], dx0, p["log_y1"], p["entry_in"], ft, hc, "structure")
    add("shell__entry_east", dx1, p["log_w1"], p["log_y1"], p["entry_in"], ft, hc, "structure")
    add("shell__entry_head", dx0, dx1, p["log_y1"], p["entry_in"], ft + p["door_h"], hc, "structure")
    # --- interior bulkhead, between the service openings
    edges = [-p["in_x"]]
    for k in ("bank", "trade", "assoc"):
        cx = CELLS[k][0]
        edges += [cx - p["alc_w"] / 2, cx + p["alc_w"] / 2]
    edges += [p["pass_x"] - p["pass_w"] / 2, p["pass_x"] + p["pass_w"] / 2, p["in_x"]]
    for i in range(0, len(edges), 2):
        a, b = edges[i], edges[i + 1]
        if b - a > 0.01:
            add(f"shell__bulkhead_{i//2}", a, b, p["boh_y0"], p["boh_y1"], ft, hc, "structure")
    # --- built-in furniture
    add("fixture__vendor_counter", -p["in_x"], -4.57, -1.85, 1.05, ft, ft + 0.96, "furniture")
    add("fixture__trainer_table", 4.02, 5.18, -3.12, -2.28, ft, ft + 0.76, "furniture")
    add("fixture__boh_bench", 2.25, 4.15, p["in_y"] - 0.62, p["in_y"], ft, ft + 0.88, "furniture")
    add("fixture__boh_shelving", -4.60, 0.00, p["in_y"] - 0.50, p["in_y"], ft, ft + 2.28, "furniture")
    add("fixture__boh_switchgear", p["in_x"] - 0.45, p["in_x"], 2.35, 3.09, ft, ft + 1.70, "furniture")
    add("fixture__queue_rail", -2.09, 0.99, -0.40, -0.30, ft, ft + 0.99, "furniture")
    add("fixture__loggia_bench", p["log_w0"] - 0.77, p["log_w0"] + 0.09, -p["out_y"] + 0.50,
        -p["out_y"] + 0.94, ft, ft + 0.50, "furniture")
    # --- the door, fully closed
    hw = p["leaf_w"] / 2
    add("door__closed", p["door_cx"] - hw, p["door_cx"] + hw, p["leaf_y"] - p["leaf_t"] / 2,
        p["leaf_y"] + p["leaf_t"] / 2, ft, ft + p["leaf_h"], "door")
    return B


def make_collision_objects(boxes):
    obs = []
    for b in boxes:
        mn, mx = b["min"], b["max"]
        # back to authoring space
        x0, x1 = mn[0], mx[0]
        z0, z1 = mn[1], mx[1]
        y0, y1 = -mx[2], -mn[2]
        obs.append(M.box("collision__" + b["id"], None,
                         ((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2),
                         (x1 - x0, y1 - y0, z1 - z0)))
    return obs


# ===========================================================================
# LOD policy — `lod` = highest LOD level at which a part survives
# ===========================================================================
L2_KEYS = ("__base", "flank", "entry", "screen", "spandrel", "panel", "deck_",
           "parapet_", "mon_wall", "mon_roof", "bulkhead", "soffit", "lintel",
           "trainer_w", "slab", "screed", "loggia")
L1_KEYS = ("ceil_", "beam_", "vendor_counter", "vendor_top", "trainer_table",
           "trainer_apron", "alcove", "sign_", "mon_glass", "track", "reveal",
           "flash", "boh_bench", "boh_shelf", "pilaster", "medallion", "cove",
           "grate_frame", "threshold", "switchgear", "cistern", "mast", "cond_")


def assign_lods():
    for ob in M.SCENE_OBJS:
        if ob.get("lod", 0):
            continue
        n = ob.name
        if any(k in n for k in L2_KEYS):
            ob["lod"] = 2
        elif any(k in n for k in L1_KEYS):
            ob["lod"] = 1


PREFIXES = ("roof__", "wall_front__", "wall_back__", "wall_left__", "wall_right__",
            "floor__", "interior__")


def build_scene(lod_level, with_props):
    M.clear()
    M.LOD_BEVEL = 1.0 if lod_level == 0 else (0.7 if lod_level == 1 else 0.0)
    M.LOD_NSCALE = 1.0 if lod_level == 0 else (0.62 if lod_level == 1 else 0.40)
    materials()
    build_foundation()
    build_base_walls()
    build_datum()
    build_panel_walls()
    build_loggia()
    door_objs = build_door()
    build_roof()
    build_interior()
    assign_lods()
    leaf = bpy.data.objects.get("door_slide__leaf")
    if leaf:
        leaf["lod"] = 2
    # drop parts that do not survive this LOD
    doomed = [o for o in list(M.SCENE_OBJS) if o.get("lod", 0) < lod_level]
    for o in doomed:
        M.SCENE_OBJS.remove(o)
        bpy.data.objects.remove(o, do_unlink=True)
    # join by cutaway prefix (the door leaf stays a separate movable child)
    joined = []
    for pre in PREFIXES:
        grp = [o for o in M.SCENE_OBJS if o.name.startswith(pre)]
        if grp:
            j = M.join(grp, pre + "parts")
            if j:
                joined.append(j)
    if leaf:
        joined.append(leaf)
    for ob in joined:
        M.uv_box_project(ob, TILES)
    props = import_props() if with_props else []
    return joined, props


def bake_wear(joined, lod_level):
    samples = 12 if lod_level == 0 else (7 if lod_level == 1 else 4)
    M.compute_ao(joined, joined, samples=samples, dist=1.15)
    for ob in joined:
        M.apply_vcolor(ob, wear)


def export_glb(path, animate=True):
    for ob in bpy.data.objects:
        if ob.animation_data:
            for t in ob.animation_data.nla_tracks:
                t.mute = False
    kw = dict(filepath=path, export_format='GLB', use_selection=False,
              export_apply=True, export_yup=True, export_tangents=True,
              export_normals=True, export_texcoords=True,
              export_animations=animate, export_nla_strips=animate,
              export_cameras=False, export_lights=False, export_extras=False,
              export_image_format='AUTO', use_active_scene=True)
    for extra in (dict(export_vertex_color='MATERIAL', export_all_vertex_colors=False),
                  dict(export_vertex_color='MATERIAL'), dict(export_colors=True), {}):
        try:
            bpy.ops.export_scene.gltf(**{**kw, **extra})
            return
        except TypeError:
            continue
    raise RuntimeError("glTF export failed")


def verify_clearance(boxes):
    """Prove the fixture cells, their customer approach and the door path are clear."""
    p, issues = P, []
    half = p["cell"] / 2

    def overlaps(b, x0, x1, y0, y1, z0, z1):
        return not (b["max"][0] <= x0 or b["min"][0] >= x1 or
                    -b["min"][2] <= y0 or -b["max"][2] >= y1 or
                    b["max"][1] <= z0 or b["min"][1] >= z1)

    checks = []
    for k, (cx, cy) in CELLS.items():
        checks.append((f"cell_{k}", cx - half, cx + half, cy - half, cy + half,
                       p["floor_top"], p["floor_top"] + 2.0))
    for k in ("bank", "trade", "assoc"):
        cx, cy = CELLS[k]
        checks.append((f"approach_{k}", cx - half, cx + half, cy - p["cell"] - half,
                       cy - half, p["floor_top"], p["floor_top"] + 1.9))
    cx, cy = CELLS["trainer"]
    checks.append(("approach_trainer", cx - half, cx + half, cy + half,
                   cy + half + p["cell"], p["floor_top"], p["floor_top"] + 1.9))
    hw = p["leaf_w"] / 2
    tol = 0.01   # the leaf slides past the wall face with a real, small gap
    checks.append(("door_swept_volume", p["door_cx"] + p["travel"] - hw,
                   p["door_cx"] + hw, p["leaf_y"] - p["leaf_t"] / 2 - tol,
                   p["leaf_y"] + p["leaf_t"] / 2 + tol,
                   p["floor_top"], p["floor_top"] + p["leaf_h"]))
    checks.append(("door_walk_through", p["door_cx"] - p["door_w"] / 2 + 0.05,
                   p["door_cx"] + p["door_w"] / 2 - 0.05, p["log_y1"] - 0.35,
                   p["entry_in"] + 0.35, p["floor_top"], p["floor_top"] + 2.0))
    for (nm, x0, x1, y0, y1, z0, z1) in checks:
        for b in boxes:
            if nm == "door_swept_volume" and b["kind"] == "door":
                continue
            if nm == "door_walk_through" and b["kind"] == "door":
                continue
            if overlaps(b, x0, x1, y0, y1, z0, z1):
                issues.append(f"{nm} blocked by {b['id']}")
    return issues


def main():
    os.makedirs(os.path.join(ROOT, "build"), exist_ok=True)
    os.makedirs(os.path.join(ROOT, "build", "checkpoints"), exist_ok=True)
    report = {"stage": STAGE, "lods": {}, "params": {k: v for k, v in P.items()}}

    for lod in (0, 1, 2):
        joined, props = build_scene(lod, with_props=False)
        bake_wear(joined, lod)
        if lod == 0:
            for ob in joined:
                M.uv_second_bake_layer(ob)
        tris = M.tri_count(joined)
        mats = sorted({s.material.name for o in joined for s in o.material_slots
                       if s.material})
        mn = [1e9] * 3
        mx = [-1e9] * 3
        for ob in joined:
            for c in ob.bound_box:
                w = ob.matrix_world @ __import__("mathutils").Vector(c)
                for i in range(3):
                    mn[i] = min(mn[i], w[i])
                    mx[i] = max(mx[i], w[i])
        out = os.path.join(ROOT, "build", f"market_house_lod{lod}.glb")
        export_glb(out, animate=True)
        report["lods"][f"lod{lod}"] = {
            "file": os.path.basename(out), "triangles": tris,
            "materials": mats, "material_count": len(mats),
            "objects": [o.name for o in joined],
            "bounds_authoring": {"min": [round(v, 4) for v in mn],
                                 "max": [round(v, 4) for v in mx]},
            "bytes": os.path.getsize(out),
            "sha256": hashlib.sha256(open(out, "rb").read()).hexdigest(),
        }
        print(f"[lod{lod}] tris={tris} mats={len(mats)} "
              f"size={os.path.getsize(out)/1024:.0f}KB")
        if lod == 0:
            bpy.ops.wm.save_as_mainfile(
                filepath=os.path.join(ROOT, "build", "checkpoints",
                                      f"market_house_{STAGE}_lod0.blend"))

    # furnished reference build (LOD0 + allowed loose props)
    joined, props = build_scene(0, with_props=True)
    bake_wear(joined, 0)
    boxes = collision_boxes()
    issues = verify_clearance(boxes)
    out = os.path.join(ROOT, "build", "market_house_furnished.glb")
    export_glb(out, animate=True)
    report["furnished"] = {
        "file": os.path.basename(out), "bytes": os.path.getsize(out),
        "sha256": hashlib.sha256(open(out, "rb").read()).hexdigest(),
        "triangles_with_props": M.tri_count(
            [o for o in bpy.data.objects if o.type == 'MESH']),
    }
    report["props"] = prop_records()
    report["collision"] = {
        "schema": "successor.structure-collision.v3",
        "space": "asset-local metres, +Y up, +Z front (glTF)",
        "boxes": boxes, "clearance_issues": issues,
    }
    report["door"] = {
        "node": "door_slide", "axis_local": "X", "closed_offset_m": 0.0,
        "open_offset_m": P["travel"], "travel_abs_m": abs(P["travel"]),
        "clips": ["door_open", "door_close"], "clip_seconds": 0.8, "fps": 30,
        "leaf_size_m": [P["leaf_w"], P["leaf_h"], P["leaf_t"]],
        "opening_size_m": [P["door_w"], P["door_h"]],
    }
    bpy.ops.wm.save_as_mainfile(
        filepath=os.path.join(ROOT, "build", f"market_house_{STAGE}.blend"))
    json.dump(report, open(os.path.join(ROOT, "build", "build_report.json"), "w"),
              indent=1)
    print("CLEARANCE_ISSUES:", issues if issues else "none")
    print("BUILD_OK")


main()
