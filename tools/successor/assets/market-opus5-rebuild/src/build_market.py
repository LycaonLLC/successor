"""Deterministic generator -- SCHEME E: "Valley Market", Dustgate settlement.

Authoring space: +X east, +Y north, +Z up; public front = -Y (glTF +Z).
Run:  blender -b --factory-startup -noaudio -P src/build_market.py -- [--stage full]

ARCHITECTURE (scheme E, chosen in ALTERNATIVES.md)
--------------------------------------------------
One asymmetric butterfly roof folds about a valley gutter that sits directly
over the service wall, so the fold has a real load path.  The north plane is
lifted 0.55 m above the valley, making a south-facing clerestory that washes
the service wall with light; its brise-soleil blades are the only repeated
element on the building and they earn it by shading that glass.  Water is the
parti: valley -> east sump -> downpipe -> cistern drum -> rear plant.

Exactly ONE curve exists: the vaulted entry hood, which breaks the south eave
and is therefore the tallest event on the public face.  The south facade is
plan-stepped three times (loggia / hood / trainer bay), each at a different
setback, so nothing reads as a repeated bay.  Two unequal vertical service
objects (square windcatcher, round flue) plus the drum give the skyline four
different shapes at four different heights.

Interior: one tall public hall under the raked south soffit, a low service
ceiling over the back-of-house, three docked terminals in deep niches, a real
staff aisle behind them, vendor line west, trainer consultation south-east.
"""
import hashlib
import json
import math
import os
import sys

import bpy
from mathutils import Vector

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import mlib as M   # noqa: E402
import plan as PL  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TEX = os.path.join(ROOT, "build", "textures")
PROPDIR = os.path.abspath(os.path.join(ROOT, "..", "..", "..", "..",
                                       "client-3d", "public", "assets", "world-items"))
REL = "client-3d/public/assets/world-items"

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
STAGE = argv[argv.index("--stage") + 1] if "--stage" in argv else "full"
DETAIL = STAGE != "blockout"
LODS = ([int(c) for c in argv[argv.index("--lods") + 1].split(",")]
        if "--lods" in argv else [0, 1, 2])
NO_EXPORT = "--no-export" in argv

PL.assert_contract()
CELLS = PL.CELLS        # blender-space fixture centres
GCELLS = PL.GCELLS      # glTF-space fixture centres

# ===========================================================================
# PARAMETERS -- metres, authoring space
# ===========================================================================
P = dict(
    foot_x=PL.FOOT_X, foot_y=PL.FOOT_Y, cell=PL.CELL,          # 5.70 / 4.275 / 0.95
    floor_top=PL.FLOOR_TOP, slab_bot=-0.30,
    # --- main mass (authored shell stays inside the footprint)
    mx=5.56, sy=-3.12, ny=3.95, wt=0.34,
    base_top=2.42,                      # sinter plinth top / datum line
    band_top=2.56,                      # brass drip band top
    # --- butterfly roof
    val_y=1.85,                         # valley line == service wall line
    z_eave_s=4.42, z_val=3.56,          # south plane: top surface (eave -> valley)
    z_cler=4.27, z_eave_n=4.52,         # north plane: lifted 0.55 over the valley
    deck_t=0.16, over_s=0.18, over_n=0.18, over_x=0.12,
    # --- entry hood (the single curve)
    hood_cx=-0.30, hood_ro=1.90, hood_ri=1.42, hood_spr=2.70, hood_y=-4.16,
    # --- sliding door
    door_cx=-0.30, door_w=2.20, door_h=2.40,
    leaf_w=2.44, leaf_h=2.52, leaf_t=0.09, travel=-2.60,
    # --- west loggia (three unequal bays, never a ring)
    log_x0=-5.56, log_x1=-2.34, log_y=-3.98, log_top=3.05,
    # --- trainer bay (projects south-east)
    tr_x0=2.72, tr_y=-3.72, tr_top=2.94,
    # --- service wall / niches
    bulk_y0=1.85, bulk_th=0.34, niche_y1=2.50, niche_w=1.34, niche_h=2.30,
    pass_x=-4.66, pass_w=0.95, pass_h=2.10,
    # --- back of house
    boh_ceil=2.75, svc_x=1.30, svc_w=1.15, svc_h=2.20,
    # --- verticals
    twr_x=-3.62, twr_y=2.55, twr_w=1.06, twr_top=6.35,
    flue_x=-0.95, flue_y=3.44, flue_r=0.42, flue_top=5.42,
    drum_x=4.28, drum_y=2.86, drum_r=0.84, drum_h=1.56,
)
P["ix"] = P["mx"] - P["wt"]              # 5.28  interior east/west face
P["sy_in"] = P["sy"] + P["wt"]           # -2.78 interior south face
P["ny_in"] = P["ny"] - P["wt"]           # 3.61  interior north face
P["bulk_y1"] = P["bulk_y0"] + P["bulk_th"]
P["leaf_y"] = P["sy_in"] + 0.075         # leaf plane, inside the south wall
P["hood_apex"] = P["hood_spr"] + P["hood_ro"]        # 4.60 -> breaks the eave
P["hood_op0"] = P["hood_cx"] - P["hood_ri"]          # entry opening, west jamb
P["hood_op1"] = P["hood_cx"] + P["hood_ri"]          # entry opening, east jamb
MAT = {}


P["y_eave_s"] = P["sy"] - P["over_s"]     # -3.30 south eave line
P["y_eave_n"] = P["ny"] + P["over_n"]     #  4.13 north eave line


def slope_s(y):
    """Top-surface z of the SOUTH roof plane at plan y (falls north to valley)."""
    p = P
    t = (y - p["y_eave_s"]) / (p["val_y"] - p["y_eave_s"])
    return p["z_eave_s"] + (p["z_val"] - p["z_eave_s"]) * t


def slope_n(y):
    """Top-surface z of the NORTH roof plane at plan y (falls south to valley)."""
    p = P
    t = (y - p["val_y"]) / (p["y_eave_n"] - p["val_y"])
    return p["z_cler"] + (p["z_eave_n"] - p["z_cler"]) * t


def ceil_s(y):
    """Hall ceiling = underside of the south deck."""
    return slope_s(y) - P["deck_t"]


def materials():
    t = TEX
    # one image set per material: no image is shared between two TexImage nodes,
    # which is what removes the "more than one shader node tex image" warnings.
    # tints re-pitch the palette for a desert settlement: the mass must not sit
    # at the same value as sand (pass-2 defect E3, measured separation 0.030).
    MAT["sinter"] = M.pbr_material("MKT_Sinter", t, "sinter", normal_strength=0.9,
                                   tint=(1.20, 1.11, 0.97))
    MAT["ceramic"] = M.pbr_material("MKT_Ceramic", t, "ceramic", normal_strength=0.7,
                                    tint=(0.835, 0.772, 0.672))
    MAT["plaster"] = M.pbr_material("MKT_Plaster", t, "plaster", normal_strength=0.6,
                                    tint=(1.08, 1.028, 0.937))
    MAT["screed"] = M.pbr_material("MKT_Screed", t, "screed", normal_strength=0.8,
                                   tint=(1.14, 1.09, 1.02))
    MAT["roof"] = M.pbr_material("MKT_RoofMetal", t, "roofmetal", metal=1.0,
                                 normal_strength=0.7, tint=(0.818, 0.790, 0.744))
    MAT["steel"] = M.pbr_material("MKT_Steel", t, "steel", metal=1.0,
                                  normal_strength=0.7)
    MAT["brass"] = M.pbr_material("MKT_Brass", t, "brass", metal=1.0,
                                  normal_strength=0.6)
    MAT["glass"] = M.plain_material("MKT_Glass", (0.38, 0.46, 0.50), 0.05, 0.0,
                                    alpha=0.26)
    MAT["seal"] = M.plain_material("MKT_Seal", (0.024, 0.024, 0.026), 0.88)
    MAT["lamp"] = M.plain_material("MKT_LampWarm", (0.98, 0.80, 0.55), 0.30,
                                   emit=(1.0, 0.79, 0.50), emit_str=22.0)
    MAT["cyan"] = M.plain_material("MKT_LampCyan", (0.34, 0.86, 0.93), 0.30,
                                   emit=(0.32, 0.88, 0.96), emit_str=9.0)


# texel density: 2.0 m tile. tile value = metres per tile repeat.
TILES = {"MKT_Sinter": 2.0, "MKT_Ceramic": 2.0, "MKT_Plaster": 2.0,
         "MKT_Screed": 2.0, "MKT_RoofMetal": 2.0, "MKT_Steel": 1.0,
         "MKT_Brass": 1.0}


# ------------------------------------------------------------ tagged wrappers
def _tag(ob, lod):
    if ob is not None:
        ob["lod"] = lod
    return ob


def B(name, mat, c, s, bev=0.0, seg=1, group="", lod=0, tile=None, phase=None):
    return _tag(M.box(name, mat, c, s, bev, seg, group, "", tile, phase), lod)


def PR(name, mat, pts, axis, a, b, bev=0.0, seg=1, group="", lod=0, tile=None,
       phase=None):
    return _tag(M.prism(name, mat, pts, axis, a, b, bev, seg, group, "", tile,
                        phase), lod)


def CY(name, mat, c, r, h, axis=2, n=16, bev=0.0, group="", r2=None, lod=0,
       tile=None, phase=None):
    return _tag(M.cyl(name, mat, c, r, h, axis, n, bev, group, "", r2, tile,
                      phase), lod)


def TU(name, mat, c, ro, ri, h, axis=2, n=20, group="", lod=0, tile=None):
    return _tag(M.tube(name, mat, c, ro, ri, h, axis, n, group, "", tile), lod)


def WA(name, mat, axis, lo, hi, u0, u1, z0, z1, openings=(), bev=0.0, group="",
       lod=0, tile=None):
    out = M.wall(name, mat, axis, lo, hi, u0, u1, z0, z1, openings, bev, group,
                 "", tile)
    for o in out:
        _tag(o, lod)
    return out


# ===========================================================================
# SUBSYSTEM 1 -- ground: slab, screed, loggia deck, thresholds, drift
# ===========================================================================
def build_ground():
    p, o = P, []
    ft, sb = p["floor_top"], p["slab_bot"]
    o.append(B("floor__slab", MAT["sinter"],
               (0, (p["sy"] + p["ny"]) / 2, (sb + ft - 0.09) / 2),
               (2 * p["mx"], p["ny"] - p["sy"], ft - 0.09 - sb), lod=2,
               phase=(0.0, 0.0, 0.0)))
    # slab under the projecting trainer bay
    o.append(B("floor__slab_trainer", MAT["sinter"],
               ((p["tr_x0"] + p["mx"]) / 2, (p["tr_y"] + p["sy"]) / 2,
                (sb + ft - 0.09) / 2),
               (p["mx"] - p["tr_x0"], p["sy"] - p["tr_y"], ft - 0.09 - sb), lod=2,
               phase=(0.0, 0.0, 0.0)))
    # interior wearing screed
    for nm, x0, x1, y0, y1 in (
            ("hall", -p["ix"], p["ix"], p["sy_in"], p["bulk_y0"]),
            ("bay", p["tr_x0"] + p["wt"], p["ix"], p["tr_y"] + p["wt"], p["sy_in"]),
            ("boh", -p["ix"], p["ix"], p["bulk_y1"], p["ny_in"])):
        o.append(B(f"floor__screed_{nm}", MAT["screed"],
                   ((x0 + x1) / 2, (y0 + y1) / 2, ft - 0.045),
                   (x1 - x0, y1 - y0, 0.09), lod=2, phase=(0.0, 0.0, 0.0)))
    # loggia + entry apron deck outside the wall line
    o.append(B("floor__deck_loggia", MAT["screed"],
               ((p["log_x0"] + p["log_x1"]) / 2, (p["log_y"] - 0.21 + p["sy"]) / 2,
                ft - 0.045), (p["log_x1"] - p["log_x0"], p["sy"] - p["log_y"] + 0.21,
                              0.09), lod=2, phase=(0.0, 0.0, 0.0)))
    o.append(B("floor__deck_entry", MAT["screed"],
               (p["hood_cx"], (p["hood_y"] + p["sy"]) / 2, ft - 0.045),
               (2 * p["hood_ro"] + 0.30, p["sy"] - p["hood_y"], 0.09), lod=2,
               phase=(0.0, 0.0, 0.0)))
    if not DETAIL:
        return o
    # brass threshold under the door line + a second at the loggia edge
    o.append(B("floor__threshold_entry", MAT["brass"],
               (p["door_cx"], p["sy"] + 0.02, ft - 0.006),
               (p["door_w"] + 0.50, 0.34, 0.026), bev=0.005, lod=1))
    # dust grate just inside the entry
    gy = p["sy_in"] + 0.46
    o.append(B("floor__grate_frame", MAT["steel"], (p["door_cx"], gy, ft - 0.028),
               (2.30, 0.60, 0.075), bev=0.005, lod=1))
    for i in range(11):
        o.append(B(f"floor__grate_bar_{i}", MAT["steel"],
                   (p["door_cx"] - 1.00 + i * 0.20, gy, ft - 0.002),
                   (0.075, 0.55, 0.028), bev=0.003))
    # inlaid brass queue studs on the approach line of each service cell
    for k in ("bank", "trade", "assoc"):
        cx = CELLS[k][0]
        for i in (-1, 0, 1):
            o.append(B(f"floor__stud_{k}_{i}", MAT["brass"],
                       (cx + i * 0.30, PL.cell(*PL.FIXTURE_CELLS[k])[1] - 0.10,
                        ft - 0.004), (0.11, 0.11, 0.016), bev=0.003))
    # wind-blown sand fillet banked against the outside of the plinth
    for nm, c, s in (("w", (-p["mx"] - 0.03, 0.4, ft + 0.045), (0.20, 6.6, 0.10)),
                     ("e", (p["mx"] + 0.03, 1.2, ft + 0.04), (0.18, 5.0, 0.09)),
                     ("n", (0.6, p["ny"] + 0.03, ft + 0.035), (8.4, 0.17, 0.08))):
        o.append(B(f"floor__drift_{nm}", MAT["sinter"], c, s, bev=0.025, lod=1))
    return o


# ===========================================================================
# SUBSYSTEM 2 -- shell: sinter plinth, brass datum band, ceramic skin
# ===========================================================================
def _clip(openings, z0, z1):
    """Clip openings to a z band; drop the ones that fall outside it."""
    out = []
    for (a, b, c, d) in openings:
        c2, d2 = max(c, z0), min(d, z1)
        if d2 - c2 > 1e-6:
            out.append((a, b, c2, d2))
    return out


def shell_wall(prefix, axis, sign, outer, u0, u1, top, openings=(), group="",
               skin_top=None):
    """One side of the envelope as plinth / brass datum band / ceramic skin.

    The three bands share an inner face, so the interior reads flat while the
    exterior steps back 0.07 m at the datum -- the tectonic split between the
    heavy sintered base and the light imported panel skin.
    """
    p, o = P, []
    ft, bt, dt = p["floor_top"], p["base_top"], p["band_top"]
    inner = outer - sign * p["wt"]
    lo, hi = min(outer, inner), max(outer, inner)
    sk_out = outer - sign * 0.07
    slo, shi = min(sk_out, inner), max(sk_out, inner)
    bd_out = outer + sign * 0.035
    blo, bhi = min(bd_out, inner), max(bd_out, inner)
    skin_top = top if skin_top is None else skin_top
    o += WA(prefix + "plinth", MAT["sinter"], axis, lo, hi, u0, u1, ft, bt,
            _clip(openings, ft, bt), bev=0.012, group=group, lod=2)
    if dt < skin_top:
        o += WA(prefix + "skin", MAT["ceramic"], axis, slo, shi, u0, u1, dt,
                skin_top, _clip(openings, dt, skin_top), bev=0.010, group=group,
                lod=2)
    o += WA(prefix + "band", MAT["brass"], axis, blo, bhi, u0, u1, bt, dt,
            _clip(openings, bt, dt), bev=0.006, group=group, lod=1)
    return o


def build_shell():
    p, o = P, []
    ft = p["floor_top"]
    # ---------------- south (public) wall: three openings, three setbacks
    s_open = [(-5.20, -4.30, 0.90, 2.30),            # vendor shopfront (in loggia)
              (-4.10, -2.60, 2.62, 3.30),            # high daylight slot band
              (p["hood_op0"], p["hood_op1"], ft, 3.34)]   # entry + fanlight
    o += shell_wall("wall_front__", 1, -1, p["sy"], -p["mx"], p["tr_x0"], 4.17,
                    s_open, group="F")
    # raked infill closing the wall head to the raked deck underside
    o.append(PR("wall_front__rake", MAT["ceramic"],
                [(p["sy"], 4.16), (p["sy_in"], 4.16),
                 (p["sy_in"], ceil_s(p["sy_in"])), (p["sy"], ceil_s(p["sy"]))],
                0, -p["mx"], p["tr_x0"], group="F", lod=1))
    # entry transom: the datum band crosses the entry opening as a real member
    o.append(B("wall_front__transom", MAT["brass"],
               (p["hood_cx"], p["sy"] + 0.02, (p["base_top"] + p["band_top"]) / 2),
               (2 * p["hood_ri"] + 0.26, p["wt"] + 0.10, p["band_top"] - p["base_top"]),
               bev=0.008,
               group="F"))
    # ---------------- north (service) wall
    # vents are staggered and each one sits over what it actually serves:
    # storage extract west, tank vent centre, switchgear louvre east.
    n_open = [(p["svc_x"] - p["svc_w"] / 2, p["svc_x"] + p["svc_w"] / 2, ft,
               ft + p["svc_h"]),
              (-4.55, -3.35, 2.72, 3.34),            # storage extract
              (1.95, 2.75, 2.05, 2.62),              # tank vent
              (3.85, 4.85, 2.86, 3.30)]              # switchgear louvre
    o += shell_wall("wall_back__", 1, +1, p["ny"], -p["mx"], p["mx"], 4.30,
                    n_open, group="B")
    if DETAIL:
        o += build_north_service()
    # ---------------- west wall (hall + BOH), flat to 3.40, raked gables above
    w_open = [(-2.30, -1.70, 2.62, 3.30), (-0.70, -0.10, 2.62, 3.30),
              (2.55, 3.05, 1.50, 2.30)]
    o += shell_wall("wall_left__", 0, -1, -p["mx"], p["sy"], p["ny"], 3.39,
                    w_open, group="L")
    # ---------------- east wall (runs south to enclose the trainer bay)
    e_open = [(2.55, 3.05, 1.50, 2.30)]
    o += shell_wall("wall_right__", 0, +1, p["mx"], p["tr_y"], p["ny"], 3.39,
                    e_open, group="R")
    # raked gables on both flanks: south plane then north plane
    for sgn, pre, grp in ((-1, "wall_left__", "L"), (+1, "wall_right__", "R")):
        xo = sgn * p["mx"]
        xi = xo - sgn * p["wt"]
        a, b = min(xo, xi), max(xo, xi)
        ys0 = p["tr_y"] if sgn > 0 else p["sy"]
        o.append(PR(pre + "gable_s", MAT["ceramic"],
                    [(ys0, 3.38), (p["val_y"], 3.38), (p["val_y"], ceil_s(p["val_y"])),
                     (ys0, ceil_s(max(ys0, p["y_eave_s"])))], 0, a, b,
                    group=grp, lod=1))
        o.append(PR(pre + "gable_n", MAT["ceramic"],
                    [(p["val_y"], 3.38), (p["ny"], 3.38),
                     (p["ny"], slope_n(p["ny"]) - p["deck_t"]),
                     (p["val_y"], slope_n(p["val_y"]) - p["deck_t"])], 0, a, b,
                    group=grp, lod=1))
    # ---------------- trainer bay walls (the third south setback)
    o += shell_wall("wall_front__bay_s_", 1, -1, p["tr_y"], p["tr_x0"], p["mx"],
                    p["tr_top"], [(3.55, 4.95, 0.95, 2.30)], group="F")
    o += shell_wall("wall_right__bay_w_", 0, +1, p["tr_x0"], p["tr_y"], p["sy"],
                    p["tr_top"], group="R")
    # spandrel over the bay portal, closing bay roof to the main deck
    o.append(B("wall_front__bay_spandrel", MAT["ceramic"],
               ((p["tr_x0"] + p["mx"]) / 2, p["sy"] - 0.035,
                (p["tr_top"] + 4.20) / 2),
               (p["mx"] - p["tr_x0"], p["wt"] - 0.07, 4.20 - p["tr_top"]),
               bev=0.010, group="F"))
    o.append(PR("wall_front__bay_rake", MAT["ceramic"],
                [(p["sy"], 4.19), (p["sy_in"], 4.19),
                 (p["sy_in"], ceil_s(p["sy_in"])), (p["sy"], ceil_s(p["sy"]))],
                0, p["tr_x0"], p["mx"], group="F", lod=1))
    # portal frame into the bay: brass reveal at the datum head
    o.append(B("wall_front__bay_lintel", MAT["steel"],
               ((p["tr_x0"] + p["mx"]) / 2, p["sy"] - 0.02, p["base_top"] + 0.18),
               (p["mx"] - p["tr_x0"], p["wt"] + 0.06, 0.36), bev=0.010, group="F"))
    o.append(B("wall_front__bay_reveal", MAT["brass"],
               ((p["tr_x0"] + p["mx"]) / 2, p["sy_in"] + 0.03, p["base_top"] - 0.02),
               (p["mx"] - p["tr_x0"] - 0.04, 0.06, 0.10), bev=0.006, group="F",
               lod=1))
    return o


def build_north_service():
    """The rear elevation is authored, not left blank (pass-2 defect E5)."""
    p, o = P, []
    ft, yo = p["floor_top"], p["ny"]
    yf = yo + 0.035                       # brass band face
    # --- recessed loading porch around the service door (no footprint cost)
    sx0, sx1 = p["svc_x"] - p["svc_w"] / 2, p["svc_x"] + p["svc_w"] / 2
    for s_ in (-1, 1):
        o.append(B(f"wall_back__porch_jamb_{s_}", MAT["brass"],
                   (p["svc_x"] + s_ * (p["svc_w"] / 2 + 0.07), yo - 0.02,
                    ft + p["svc_h"] / 2),
                   (0.10, 0.30, p["svc_h"] + 0.14), bev=0.006, group="B", lod=1))
    o.append(B("wall_back__porch_head", MAT["brass"],
               (p["svc_x"], yo - 0.02, ft + p["svc_h"] + 0.07),
               (p["svc_w"] + 0.28, 0.30, 0.10), bev=0.006, group="B", lod=1))
    # shallow canopy + drip, the only projection the footprint allows
    o.append(B("wall_back__porch_canopy", MAT["steel"],
               (p["svc_x"], yo + 0.115, ft + p["svc_h"] + 0.26),
               (p["svc_w"] + 0.72, 0.25, 0.13), bev=0.008, group="B"))
    o.append(B("wall_back__porch_drip", MAT["brass"],
               (p["svc_x"], yo + 0.215, ft + p["svc_h"] + 0.19),
               (p["svc_w"] + 0.72, 0.05, 0.09), bev=0.005, group="B", lod=1))
    for s_ in (-1, 1):
        o.append(PR(f"wall_back__porch_stay_{s_}", MAT["steel"],
                    [(yo + 0.21, ft + p["svc_h"] + 0.21), (yo + 0.02, ft + p["svc_h"] + 0.21),
                     (yo + 0.02, ft + p["svc_h"] + 0.62)], 0,
                    p["svc_x"] + s_ * 0.52 - 0.03, p["svc_x"] + s_ * 0.52 + 0.03,
                    group="B", lod=1))
    o.append(B("wall_back__porch_lamp", MAT["lamp"],
               (p["svc_x"], yo + 0.14, ft + p["svc_h"] + 0.18),
               (0.62, 0.16, 0.02), group="B"))
    # --- service shelf / pipe rack line, stopping short of both ends
    o.append(B("wall_back__pipe_rack", MAT["steel"], (-1.30, yf + 0.055, 2.02),
               (5.90, 0.11, 0.10), bev=0.006, group="B", lod=1))
    for x in (-4.60, -2.85, -1.10, 0.62):
        o.append(B(f"wall_back__rack_bracket_{int(x*100)}", MAT["steel"],
                   (x, yf + 0.045, 1.93), (0.07, 0.09, 0.20), bev=0.004, group="B",
                   lod=1))
    o.append(CY("wall_back__rack_pipe", MAT["brass"], (-1.30, yf + 0.10, 2.10),
                0.045, 5.70, axis=0, n=10, group="B", lod=1))
    # --- kerb along the base where trolleys hit the wall
    o.append(B("wall_back__kerb", MAT["sinter"], (0.4, yo + 0.075, ft + 0.14),
               (9.2, 0.15, 0.28), bev=0.014, group="B", lod=1))
    # --- vent hoods over the two upper openings (they shed sand and shadow)
    for nm, x, w, z in (("storage", -3.95, 1.20, 3.34), ("gear", 4.35, 1.00, 3.30)):
        o.append(B(f"wall_back__vent_hood_{nm}", MAT["steel"], (x, yo + 0.115, z + 0.09),
                   (w + 0.22, 0.25, 0.10), bev=0.006, group="B", lod=1))
        for k in range(3):
            o.append(B(f"wall_back__vent_blade_{nm}_{k}", MAT["steel"],
                       (x, yf + 0.045, z - 0.16 - k * 0.19), (w - 0.06, 0.09, 0.05),
                       bev=0.004, group="B", lod=1))
    o.append(B("wall_back__vent_grille_tank", MAT["steel"], (2.35, yf + 0.035, 2.34),
               (0.72, 0.07, 0.50), bev=0.006, group="B", lod=1))
    # --- meter cabinet and hose bib: small, deliberate, asymmetric
    o.append(B("wall_back__meter_box", MAT["steel"], (-5.05, yo + 0.10, 1.42),
               (0.62, 0.22, 0.78), bev=0.010, group="B"))
    o.append(B("wall_back__meter_door", MAT["brass"], (-5.05, yo + 0.215, 1.42),
               (0.54, 0.03, 0.70), bev=0.005, group="B", lod=1))
    o.append(CY("wall_back__hose_bib", MAT["brass"], (-5.05, yo + 0.16, 0.72),
                0.035, 0.22, axis=1, n=10, group="B", lod=1))
    return o


# ===========================================================================
# SUBSYSTEM 3 -- the entry hood: the ONE curve, breaking the south eave
# ===========================================================================
def build_hood():
    p, o = P, []
    cx, ro, ri, spr = p["hood_cx"], p["hood_ro"], p["hood_ri"], p["hood_spr"]
    y0, y1 = p["hood_y"], p["sy"]                 # -4.20 .. -3.12
    seg = 20 if DETAIL else 10
    # --- the vault shell: a real arched tunnel, not an applied outline
    shell = M.arc_pts(cx, spr, ro, 0.0, math.pi, seg, r_in=ri)
    o.append(PR("wall_front__hood_shell", MAT["ceramic"], shell, 1, y0, y1,
                bev=0.010, group="F"))
    # --- side piers carrying the vault down to the ground
    for s in (-1, 1):
        o.append(B(f"wall_front__hood_pier_{s}", MAT["sinter"],
                   (cx + s * (ri + ro) / 2, (y0 + y1) / 2, (p["floor_top"] + spr) / 2),
                   (ro - ri, y1 - y0, spr - p["floor_top"]), bev=0.014, group="F"))
    # --- deep brass reveal on the outer face: a modelled order, not a thin line
    o.append(PR("wall_front__hood_face", MAT["brass"],
                M.arc_pts(cx, spr, ro, 0.0, math.pi, seg, r_in=ro - 0.16),
                1, y0 - 0.055, y0 + 0.075, bev=0.008, group="F"))
    for s in (-1, 1):
        o.append(B(f"wall_front__hood_facepier_{s}", MAT["brass"],
                   (cx + s * (ro - 0.08), y0 + 0.010, (p["floor_top"] + spr) / 2),
                   (0.16, 0.13, spr - p["floor_top"]), bev=0.008, group="F"))
    # inner soffit reveal, so the throat reads deep from outside
    o.append(PR("wall_front__hood_soffit", MAT["brass"],
                M.arc_pts(cx, spr, ri + 0.09, 0.0, math.pi, seg, r_in=ri),
                1, y0 + 0.16, y1, group="F", lod=1))
    if not DETAIL:
        return o
    # --- springing course: where the arch lands on the piers
    for s in (-1, 1):
        o.append(B(f"wall_front__hood_spring_{s}", MAT["brass"],
                   (cx + s * (ri + ro) / 2, (y0 + y1) / 2, spr - 0.03),
                   (ro - ri + 0.10, y1 - y0 + 0.04, 0.09), bev=0.008, group="F"))
    # --- keystone boss: the single focal detail on the whole facade
    o.append(B("wall_front__hood_key", MAT["brass"], (cx, y0 + 0.115, spr + ro - 0.14),
               (0.42, 0.36, 0.48), bev=0.012, group="F"))
    o.append(CY("wall_front__hood_key_hub", MAT["steel"], (cx, y0 - 0.030, spr + ro - 0.20),
                0.085, 0.07, axis=1, n=18, group="F"))
    # --- cove uplight washing the vault from inside the throat
    for s in (-1, 1):
        o.append(B(f"wall_front__hood_cove_{s}", MAT["steel"],
                   (cx + s * (ri - 0.10), (y0 + y1) / 2 + 0.06, spr + 0.02),
                   (0.14, y1 - y0 - 0.42, 0.10), bev=0.008, group="F"))
        o.append(B(f"wall_front__hood_lamp_{s}", MAT["lamp"],
                   (cx + s * (ri - 0.10), (y0 + y1) / 2 + 0.06, spr + 0.075),
                   (0.10, y1 - y0 - 0.54, 0.014), group="F"))
    # --- glazed fanlight in the lunette above the door head
    o.append(PR("wall_front__fan_glass", MAT["glass"],
                M.arc_pts(cx, spr, ri - 0.02, 0.0, math.pi, seg), 1,
                p["sy"] + 0.02, p["sy"] + 0.06, group="F"))
    o.append(B("wall_front__fan_sill", MAT["steel"], (cx, p["sy"] + 0.04, spr),
               (2 * ri, 0.10, 0.09), bev=0.006, group="F"))
    for k, a in enumerate((math.radians(52), math.radians(90), math.radians(128))):
        o.append(B(f"wall_front__fan_bar_{k}", MAT["steel"],
                   (cx + math.cos(a) * (ri / 2), p["sy"] + 0.04,
                    spr + math.sin(a) * (ri / 2)),
                   (0.055, 0.075, ri - 0.06), bev=0.004, group="F",
                   phase=(0, 0, math.degrees(a))))
        o[-1].rotation_euler = (0, math.radians(90) - a, 0)
    # --- entry apron nosing and the two bollard lamps flanking the arrival
    o.append(B("wall_front__hood_nosing", MAT["brass"],
               (cx, y0 - 0.02, p["floor_top"] - 0.02), (2 * ro + 0.24, 0.10, 0.07),
               bev=0.006, group="F", lod=1))
    for s in (-1, 1):
        bx = cx + s * (ro + 0.52)
        o.append(CY(f"wall_front__bollard_{s}", MAT["sinter"], (bx, y0 + 0.42, 0.44),
                    0.13, 0.84, n=14, group="F"))
        o.append(CY(f"wall_front__bollard_cap_{s}", MAT["brass"], (bx, y0 + 0.42, 0.88),
                    0.145, 0.05, n=14, group="F"))
        o.append(CY(f"wall_front__bollard_lamp_{s}", MAT["lamp"], (bx, y0 + 0.42, 0.855),
                    0.10, 0.02, n=12, group="F"))
    return o


# ===========================================================================
# SUBSYSTEM 4 -- west loggia: three UNEQUAL bays, deliberately partial
# ===========================================================================
LOG_PIERS = [(-5.30, 0.46), (-3.86, 0.38), (-2.62, 0.32)]


def build_loggia():
    p, o = P, []
    ly, top = p["log_y"], p["log_top"]
    ft = p["floor_top"]
    for i, (x, w) in enumerate(LOG_PIERS):
        o.append(B(f"wall_front__log_pier_{i}", MAT["sinter"], (x, ly, (ft + top - 0.34) / 2),
                   (w, w, top - 0.34 - ft), bev=0.016, group="F"))
        if DETAIL:
            o.append(B(f"wall_front__log_cap_{i}", MAT["brass"], (x, ly, top - 0.36),
                       (w + 0.08, w + 0.08, 0.06), bev=0.008, group="F", lod=1))
    # head beam along the pier line + transverse beams landing on each pier
    o.append(B("wall_front__log_beam", MAT["sinter"],
               ((p["log_x0"] + p["log_x1"]) / 2, ly, top - 0.17),
               (p["log_x1"] - p["log_x0"], 0.38, 0.34), bev=0.012, group="F"))
    for i, (x, w) in enumerate(LOG_PIERS):
        o.append(B(f"wall_front__log_joist_{i}", MAT["sinter"],
                   (x, (ly + p["sy"]) / 2, top - 0.20),
                   (w * 0.86, p["sy"] - ly, 0.28), bev=0.010, group="F", lod=1))
    # solid shade deck between the joists: shadow, not a slat pattern
    o.append(B("wall_front__log_deck", MAT["ceramic"],
               ((p["log_x0"] + p["log_x1"]) / 2, (ly + p["sy"]) / 2, top - 0.04),
               (p["log_x1"] - p["log_x0"], p["sy"] - ly, 0.09), bev=0.008, group="F"))
    if not DETAIL:
        return o
    # coffers between the joists: the soffit is modelled, not a flat slab
    for i in range(len(LOG_PIERS) - 1):
        x0 = LOG_PIERS[i][0] + LOG_PIERS[i][1] * 0.5
        x1 = LOG_PIERS[i + 1][0] - LOG_PIERS[i + 1][1] * 0.5
        o.append(B(f"wall_front__log_coffer_{i}", MAT["plaster"],
                   ((x0 + x1) / 2, (ly + p["sy"]) / 2, top - 0.155),
                   (x1 - x0 - 0.10, p["sy"] - ly - 0.34, 0.14), bev=0.010,
                   group="F", lod=1))
        o.append(B(f"wall_front__log_coffer_lip_{i}", MAT["brass"],
                   ((x0 + x1) / 2, (ly + p["sy"]) / 2, top - 0.225),
                   (x1 - x0 - 0.04, p["sy"] - ly - 0.28, 0.03), bev=0.004,
                   group="F", lod=1))
    o.append(B("wall_front__log_fascia", MAT["brass"],
               ((p["log_x0"] + p["log_x1"]) / 2, ly - 0.20, top - 0.16),
               (p["log_x1"] - p["log_x0"], 0.05, 0.20), bev=0.006, group="F", lod=1))
    # shopfront frame + glazing in the wall behind the loggia
    o.append(B("wall_front__shop_glass", MAT["glass"], (-4.75, p["sy"] + 0.16, 1.60),
               (0.86, 0.05, 1.36), group="F"))
    for s in (-1, 1):
        o.append(B(f"wall_front__shop_jamb_{s}", MAT["steel"],
                   (-4.75 + s * 0.46, p["sy"] + 0.14, 1.60), (0.075, 0.14, 1.44),
                   bev=0.006, group="F"))
    o.append(B("wall_front__shop_sill", MAT["brass"], (-4.75, p["sy"] - 0.02, 0.885),
               (1.02, 0.24, 0.055), bev=0.008, group="F"))
    o.append(B("wall_front__shop_head", MAT["steel"], (-4.75, p["sy"] + 0.02, 2.335),
               (1.02, 0.20, 0.10), bev=0.008, group="F"))
    # goods ledge + produce crates line the loggia (market, not civic lobby)
    o.append(B("wall_front__log_ledge", MAT["sinter"], (-4.10, p["sy"] - 0.52, 0.44),
               (2.30, 0.62, 0.10), bev=0.014, group="F"))
    for s in (-1, 1):
        o.append(B(f"wall_front__log_ledge_leg_{s}", MAT["steel"],
                   (-4.10 + s * 0.98, p["sy"] - 0.52, 0.22), (0.09, 0.52, 0.36),
                   bev=0.006, group="F"))
    # notice frame on the blank pier face + a bench in the third bay
    o.append(B("wall_front__log_notice", MAT["brass"], (-2.62, ly - 0.17, 1.72),
               (0.26, 0.03, 0.86), bev=0.006, group="F", lod=1))
    o.append(B("wall_front__log_bench", MAT["sinter"], (-3.20, p["sy"] - 0.42, 0.42),
               (1.10, 0.44, 0.09), bev=0.014, group="F"))
    for s in (-1, 1):
        o.append(B(f"wall_front__log_bench_leg_{s}", MAT["steel"],
                   (-3.20 + s * 0.44, p["sy"] - 0.42, 0.21), (0.08, 0.38, 0.34),
                   bev=0.006, group="F"))
    # loggia lighting: a warm line in the deck, washing the shopfront
    o.append(B("wall_front__log_lamp", MAT["lamp"], (-4.20, p["sy"] - 0.30, top - 0.10),
               (2.20, 0.11, 0.015), group="F"))
    return o


# ===========================================================================
# SUBSYSTEM 5 -- sliding door.  Root node `door_slide`, local +X travel.
# ===========================================================================
def build_door():
    p, o = P, []
    cx, ly, lt = p["door_cx"], p["leaf_y"], p["leaf_t"]
    z0 = p["floor_top"]
    z1 = z0 + p["leaf_h"]
    hw = p["leaf_w"] / 2
    trv = abs(p["travel"])
    # ---- fixed track, mounted on the INSIDE face of the south wall so the
    # mechanism is legible from the hall.  Section, outward from the wall:
    #   wall face -2.780 | standoff | rail -2.660 | roller | leaf -2.705
    rail_y = ly + 0.050
    rail_z = z1 + 0.115
    span = p["leaf_w"] + trv + 0.44
    ctr = cx - trv / 2.0
    o.append(B("wall_front__track_beam", MAT["steel"], (ctr, ly + 0.010, z1 + 0.325),
               (span, 0.26, 0.20), bev=0.012, group="F"))
    o.append(B("wall_front__track_rail", MAT["steel"], (ctr, rail_y, rail_z),
               (span - 0.05, 0.045, 0.085), bev=0.005, group="F"))
    o.append(B("wall_front__track_fascia", MAT["brass"], (ctr, ly - 0.115, z1 + 0.325),
               (span - 0.02, 0.035, 0.15), bev=0.006, group="F", lod=1))
    if DETAIL:
        for i in range(6):
            sx = cx - trv - hw + 0.22 + i * (span - 0.44) / 5.0
            o.append(B(f"wall_front__track_bracket_{i}", MAT["steel"],
                       (sx, ly + 0.115, rail_z + 0.02), (0.08, 0.16, 0.11),
                       bev=0.005, group="F"))
        for s, sx in ((-1, cx - trv - hw - 0.08), (1, cx + hw + 0.08)):
            o.append(B(f"wall_front__track_stop_{s}", MAT["brass"], (sx, rail_y, rail_z),
                       (0.07, 0.10, 0.12), bev=0.008, group="F"))
        # floor guide channel the leaf shoe runs in
        for s in (-1, 1):
            o.append(B(f"wall_front__door_guide_{s}", MAT["steel"],
                       (ctr, ly + s * 0.075, z0 + 0.008),
                       (span - 0.10, 0.028, 0.018), bev=0.003, group="F"))
        # pocket jamb: where the open leaf parks, expressed as a shallow reveal
        o.append(B("wall_front__door_pocket_jamb", MAT["brass"],
                   (cx - trv - hw - 0.10, ly + 0.005, (z0 + z1) / 2),
                   (0.055, 0.20, z1 - z0), bev=0.006, group="F", lod=1))
        # strike jamb + head reveal framing the closed leaf
        o.append(B("wall_front__door_strike", MAT["brass"],
                   (cx + p["door_w"] / 2 + 0.05, p["sy_in"] - 0.015, (z0 + z1) / 2),
                   (0.09, 0.10, p["door_h"]), bev=0.006, group="F", lod=1))
    # ---- the moving leaf
    leaf = []
    fr = 0.10
    leaf.append(B("dl__stile_l", MAT["steel"], (cx - hw + fr / 2, ly, (z0 + z1) / 2),
                  (fr, lt, z1 - z0), bev=0.007))
    leaf.append(B("dl__stile_r", MAT["steel"], (cx + hw - fr / 2, ly, (z0 + z1) / 2),
                  (fr, lt, z1 - z0), bev=0.007))
    leaf.append(B("dl__rail_top", MAT["steel"], (cx, ly, z1 - fr / 2),
                  (p["leaf_w"], lt, fr), bev=0.007))
    leaf.append(B("dl__rail_bot", MAT["steel"], (cx, ly, z0 + 0.19),
                  (p["leaf_w"], lt, 0.38), bev=0.007))
    leaf.append(B("dl__rail_mid", MAT["steel"], (cx, ly, z0 + 1.58),
                  (p["leaf_w"], lt * 0.99, 0.11), bev=0.007))
    leaf.append(B("dl__panel_lo", MAT["ceramic"], (cx, ly, z0 + 0.955),
                  (p["leaf_w"] - 2 * fr, lt * 0.70, 1.15), bev=0.006))
    leaf.append(B("dl__panel_hi", MAT["ceramic"], (cx, ly, z0 + 2.115),
                  (p["leaf_w"] - 2 * fr, lt * 0.70, 0.71), bev=0.006))
    leaf.append(B("dl__vision_frame", MAT["brass"], (cx, ly, z0 + 2.115),
                  (1.46, lt * 0.88, 0.40), bev=0.008))
    leaf.append(B("dl__vision_glass", MAT["glass"], (cx, ly, z0 + 2.115),
                  (1.32, lt * 0.48, 0.28)))
    if DETAIL:
        leaf.append(B("dl__kick", MAT["brass"], (cx, ly - lt * 0.44, z0 + 0.19),
                      (p["leaf_w"] - 2 * fr, 0.014, 0.34), bev=0.004))
        for s in (-1, 1):
            leaf.append(CY(f"dl__pull_{s}", MAT["brass"],
                           (cx + s * 0.26, ly - lt * 0.62, z0 + 1.06), 0.024, 0.66,
                           axis=2, n=14))
            for zz in (z0 + 0.76, z0 + 1.36):
                leaf.append(B(f"dl__pull_boss_{s}_{int(zz*100)}", MAT["brass"],
                              (cx + s * 0.26, ly - lt * 0.54, zz), (0.06, 0.08, 0.06),
                              bev=0.005))
        for s in (-1, 1):
            hx = cx + s * 0.82
            leaf.append(B(f"dl__hanger_{s}", MAT["steel"], (hx, ly + 0.030, z1 + 0.10),
                          (0.08, 0.05, 0.30), bev=0.005))
            leaf.append(B(f"dl__hanger_foot_{s}", MAT["steel"], (hx, ly + 0.010, z1 - 0.05),
                          (0.08, 0.11, 0.11), bev=0.005))
            leaf.append(CY(f"dl__roller_{s}", MAT["steel"], (hx, rail_y, rail_z + 0.055),
                           0.055, 0.05, axis=1, n=16))
            leaf.append(CY(f"dl__axle_{s}", MAT["brass"], (hx, rail_y - 0.035, rail_z + 0.055),
                           0.016, 0.05, axis=1, n=10))
        leaf.append(B("dl__shoe", MAT["steel"], (cx, ly, z0 + 0.016),
                      (0.20, 0.05, 0.030), bev=0.004))
        for s in (-1, 1):
            leaf.append(B(f"dl__seal_{s}", MAT["seal"],
                          (cx + s * (hw - 0.005), ly, (z0 + z1) / 2),
                          (0.012, lt * 0.92, z1 - z0 - 0.02)))
    leafob = M.join(leaf, "door_slide__leaf")
    leafob["lod"] = 2
    root = bpy.data.objects.new("door_slide", None)
    root.empty_display_size = 0.4
    bpy.context.scene.collection.objects.link(root)
    leafob.parent = root
    leafob.matrix_parent_inverse = root.matrix_world.inverted()
    # ---- clips: 0.8 s at 30 fps == 24 frames, lateral local X
    sc = bpy.context.scene
    sc.render.fps = 30
    sc.frame_start, sc.frame_end = 0, 24
    root.animation_data_create()
    for clip, a, b in (("door_open", 0.0, p["travel"]), ("door_close", p["travel"], 0.0)):
        root.animation_data.action = None
        for f_i, val in ((0, a), (24, b)):
            root.location = (val, 0.0, 0.0)
            root.keyframe_insert(data_path="location", frame=f_i)
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
# SUBSYSTEM 6 -- butterfly roof, valley drainage, clerestory, plant, ceilings
# ===========================================================================
CLER_X0, CLER_X1 = -4.30, 5.20          # clerestory stops short: crossing bay west


def _deck(name, y0, y1, ztop0, ztop1, x0, x1, mat, lod=2):
    t = P["deck_t"]
    return PR(name, mat, [(y0, ztop0 - t), (y1, ztop1 - t), (y1, ztop1), (y0, ztop0)],
              0, x0, x1, bev=0.008, lod=lod)


def build_roof():
    p, o = P, []
    xw, xe = -p["mx"] - p["over_x"], p["mx"] + p["over_x"]
    ys, yv, yn = p["y_eave_s"], p["val_y"], p["y_eave_n"]
    # ---------------- the two folded planes
    o.append(_deck("roof__deck_south", ys, yv, p["z_eave_s"], p["z_val"], xw, xe,
                   MAT["roof"]))
    o.append(_deck("roof__deck_north", yv, yn, p["z_cler"], p["z_eave_n"], xw, xe,
                   MAT["roof"]))
    # trainer bay roof: the low third volume
    o.append(B("roof__deck_bay", MAT["roof"],
               ((p["tr_x0"] + xe) / 2, (p["tr_y"] - 0.12 + p["sy"]) / 2,
                p["tr_top"] - 0.07),
               (xe - p["tr_x0"], p["sy"] - p["tr_y"] + 0.12, 0.14), bev=0.008))
    # ---------------- valley gutter + sumps (the parti: water is collected)
    o.append(B("roof__valley_gutter", MAT["steel"], (0, yv - 0.30, p["z_val"] + 0.015),
               (xe - xw - 0.10, 0.52, 0.10), bev=0.006))
    o.append(B("roof__valley_liner", MAT["brass"], (0, yv - 0.30, p["z_val"] + 0.055),
               (xe - xw - 0.22, 0.42, 0.022), bev=0.004, lod=1))
    for s, sx in ((1, 4.62), (-1, -4.86)):
        o.append(B(f"roof__valley_sump_{s}", MAT["steel"], (sx, yv - 0.30, p["z_val"] - 0.02),
                   (0.46, 0.50, 0.20), bev=0.008))
        o.append(CY(f"roof__valley_grate_{s}", MAT["brass"], (sx, yv - 0.30, p["z_val"] + 0.07),
                    0.15, 0.03, n=14, lod=1))
    # ---------------- clerestory: south-facing, lights the service aisle
    zg0, zg1 = p["z_val"] + 0.04, p["z_cler"] - p["deck_t"] - 0.02
    o.append(B("roof__cler_glass", MAT["glass"], ((CLER_X0 + CLER_X1) / 2, yv,
                                                  (zg0 + zg1) / 2),
               (CLER_X1 - CLER_X0, 0.05, zg1 - zg0)))
    o.append(B("roof__cler_sill", MAT["steel"], ((CLER_X0 + CLER_X1) / 2, yv - 0.02,
                                                 zg0 - 0.03),
               (CLER_X1 - CLER_X0 + 0.10, 0.22, 0.09), bev=0.006))
    o.append(B("roof__cler_head", MAT["steel"], ((CLER_X0 + CLER_X1) / 2, yv - 0.02,
                                                 zg1 + 0.035),
               (CLER_X1 - CLER_X0 + 0.10, 0.22, 0.08), bev=0.006))
    # valley beam: the fold's load path, landing on the service wall below
    o.append(B("roof__valley_beam", MAT["steel"], (0, yv + 0.10, 3.48),
               (xe - xw - 0.20, 0.22, 0.20), bev=0.010))
    if DETAIL:
        # posts carrying the lifted north plane; unequal bays, not a picket row
        for x in (-5.20, -4.30, -2.62, -0.55, 1.62, 3.30, 4.42, 5.20):
            o.append(B(f"roof__cler_post_{int(x*100)}", MAT["steel"], (x, yv + 0.005,
                                                                       (zg0 + zg1) / 2),
                       (0.10, 0.16, zg1 - zg0 + 0.10), bev=0.006))
        # brise-soleil: the ONE repeated element, and it shades the glass
        for k in range(3):
            o.append(B(f"roof__brise_{k}", MAT["steel"],
                       ((CLER_X0 + CLER_X1) / 2, yv - 0.34 - k * 0.005,
                        zg1 - 0.06 - k * 0.20),
                       (CLER_X1 - CLER_X0, 0.62 - k * 0.10, 0.035), bev=0.004, lod=1))
        for x in (CLER_X0 + 0.10, -1.60, 2.30, CLER_X1 - 0.10):
            o.append(B(f"roof__brise_arm_{int(x*100)}", MAT["steel"], (x, yv - 0.34,
                                                                       zg1 - 0.26),
                       (0.06, 0.66, 0.46), bev=0.005, lod=1))
        # west crossing bay: solid infill + step-over platform between the planes
        o.append(B("roof__cross_infill", MAT["ceramic"], ((xw + CLER_X0) / 2, yv,
                                                          (zg0 + zg1) / 2),
                   (CLER_X0 - xw, 0.20, zg1 - zg0 + 0.10), bev=0.008))
        o.append(B("roof__cross_step", MAT["steel"], ((xw + CLER_X0) / 2, yv - 0.30,
                                                       p["z_val"] + 0.13),
                   (CLER_X0 - xw - 0.30, 0.86, 0.05), bev=0.005))
        for s in (-1, 1):
            o.append(B(f"roof__cross_rail_{s}", MAT["steel"],
                       ((xw + CLER_X0) / 2, yv - 0.30 + s * 0.40, p["z_val"] + 0.55),
                       (CLER_X0 - xw - 0.30, 0.045, 0.045), bev=0.004, lod=1))
    # ---------------- roof AS A SYSTEM (pass-2 defect E1/E4)
    # Hierarchy, strongest first: four unequal expressed rafters -> two unequal
    # dark collector arrays -> one service walk on the entry axis -> shallow
    # seams only inside the walk and verge bays.  The seams are no longer the
    # only thing on the plane, so they stop reading as a barcode.
    if DETAIL:
        RIBS = (-4.30, -2.42, 2.18, 4.34)      # unequal bays: 1.88 / 4.60 / 2.16
        hood_x0, hood_x1 = p["hood_cx"] - p["hood_ro"], p["hood_cx"] + p["hood_ro"]
        y_trim = -2.86
        for x in RIBS:
            y_from = y_trim if hood_x0 - 0.10 < x < hood_x1 + 0.10 else ys
            o.append(B(f"roof__rafter_{int(x*100)}", MAT["roof"],
                       (x, (y_from + yv) / 2, 0.065), (0.11, yv - y_from, 0.13),
                       bev=0.006, lod=1))
            _rake(o[-1], "s")
        # trimmer header where the hood penetrates the plane
        o.append(B("roof__rafter_trimmer", MAT["roof"],
                   ((hood_x0 + hood_x1) / 2, y_trim, 0.065),
                   (hood_x1 - hood_x0 + 0.24, 0.13, 0.13), bev=0.006, lod=1))
        _rake(o[-1], "s")
        # --- collector arrays: dark, flush to the plane, two unequal groups
        for gi, (gx, gy0, gy1, widths) in enumerate((
                (-5.20, -2.55, -0.30, ((1.10, 0.00), (0.94, 0.22), (0.82, -0.14))),
                (2.30, -1.85, 0.35, ((1.16, 0.00), (0.92, 0.26))))):
            cx = gx
            for pi, (wdt, dy) in enumerate(widths):
                a0, a1 = gy0 + max(0.0, dy), gy1 + min(0.0, dy)
                o.append(B(f"roof__collector_{gi}_{pi}", MAT["steel"],
                           (cx + wdt / 2, (a0 + a1) / 2, 0.150),
                           (wdt, a1 - a0, 0.085), bev=0.006, lod=1))
                _rake(o[-1], "s")
                o.append(B(f"roof__collector_{gi}_{pi}_frame", MAT["brass"],
                           (cx + wdt / 2, (a0 + a1) / 2, 0.135),
                           (wdt + 0.07, a1 - a0 + 0.07, 0.065), bev=0.004, lod=1))
                _rake(o[-1], "s")
                cx += wdt + 0.19
            # header + manifold pipe feeding the array back to the valley
            o.append(B(f"roof__collector_{gi}_manifold", MAT["steel"],
                       ((gx + cx) / 2, gy1 + 0.16, 0.115), (cx - gx, 0.09, 0.09),
                       bev=0.004, lod=1))
            _rake(o[-1], "s")
        # --- service walk on the entry axis, between the two arrays
        o.append(B("roof__south_walk", MAT["steel"], (-0.12, (ys + yv) / 2 + 0.10, 0.058),
                   (1.62, yv - ys - 0.70, 0.05), bev=0.004, lod=1))
        _rake(o[-1], "s")
        for i in range(6):
            o.append(B(f"roof__south_tread_{i}", MAT["brass"],
                       (-0.12, ys + 0.85 + i * 0.72, 0.088), (1.42, 0.34, 0.014),
                       bev=0.003, lod=1))
            _rake(o[-1], "s")
        # --- seams: only inside the walk bay and the two verge bays
        n = int(round((xe - xw) / 0.42))
        for i in range(1, n):
            x = xw + i * (xe - xw) / n
            in_walk = -2.42 < x < 2.18 and not (-0.95 < x < 0.71)
            in_verge = x < -5.10 or x > 5.16
            if in_walk or in_verge:
                o.append(B(f"roof__seam_s_{i}", MAT["roof"],
                           (x, (ys + yv - 0.55) / 2, 0.014),
                           (0.026, yv - 0.55 - ys, 0.028), bev=0.003, lod=1))
                _rake(o[-1], "s")
            if x < -5.0 or x > 5.0 or abs(x + 2.25) < 0.7 or abs(x - 4.28) < 1.0:
                continue                       # interrupted by hatch / drum
            o.append(B(f"roof__seam_n_{i}", MAT["roof"], (x, (yv + 0.55 + yn) / 2, 0.014),
                       (0.026, yn - yv - 0.55, 0.028), bev=0.003, lod=1))
            _rake(o[-1], "n")
        # eave drip closures
        for nm, yy, zz in (("s", ys + 0.03, p["z_eave_s"]), ("n", yn - 0.03, p["z_eave_n"])):
            o.append(B(f"roof__eave_{nm}", MAT["brass"], (0, yy, zz - 0.10),
                       (xe - xw, 0.07, 0.15), bev=0.006, lod=1))
        for s, sx in ((-1, xw + 0.035), (1, xe - 0.035)):
            o.append(PR(f"roof__verge_{s}", MAT["brass"],
                        [(ys, p["z_eave_s"] - 0.10), (yv, p["z_val"] - 0.10),
                         (yv, p["z_val"] + 0.05), (ys, p["z_eave_s"] + 0.05)],
                        0, sx - 0.035, sx + 0.035, lod=1))
            o.append(PR(f"roof__verge_n_{s}", MAT["brass"],
                        [(yv, p["z_cler"] - 0.10), (yn, p["z_eave_n"] - 0.10),
                         (yn, p["z_eave_n"] + 0.05), (yv, p["z_cler"] + 0.05)],
                        0, sx - 0.035, sx + 0.035, lod=1))
    return o


def _rake(ob, plane):
    """Sit a flat-built roof accessory on the raked deck by moving its verts."""
    fn = slope_s if plane == "s" else slope_n
    for v in ob.data.vertices:
        v.co.z = v.co.z + fn(v.co.y) + 0.001


def build_roof_plant():
    """Verticals + rooftop service: windcatcher, flue, cistern, plant, walkway."""
    p, o = P, []
    if not DETAIL:
        return o
    xw, xe = -p["mx"] - p["over_x"], p["mx"] + p["over_x"]
    # ---------------- 1. windcatcher tower (square, tallest, north-facing head)
    tx, ty, tw, tt = p["twr_x"], p["twr_y"], p["twr_w"], 6.60
    zbase = 2.30
    o.append(PR("roof__tower_shaft", MAT["sinter"],
                [(tx - tw / 2, ty - tw / 2), (tx + tw / 2, ty - tw / 2),
                 (tx + tw / 2, ty + tw / 2), (tx - tw / 2, ty + tw / 2)],
                2, zbase, tt - 0.62, bev=0.016))
    o.append(B("roof__tower_head", MAT["ceramic"], (tx, ty, tt - 0.34),
               (tw + 0.20, tw + 0.20, 0.56), bev=0.012))
    o.append(B("roof__tower_cap", MAT["brass"], (tx, ty, tt - 0.02),
               (tw + 0.34, tw + 0.34, 0.10), bev=0.010))
    o.append(B("roof__tower_finial", MAT["brass"], (tx, ty, tt + 0.13),
               (0.16, 0.16, 0.20), bev=0.010))
    for k in range(3):                       # intake louvres, north face only
        o.append(B(f"roof__tower_louv_{k}", MAT["steel"],
                   (tx, ty + tw / 2 + 0.11, tt - 0.20 - k * 0.17),
                   (tw - 0.12, 0.12, 0.055), bev=0.004, lod=1))
    o.append(B("roof__tower_flash", MAT["brass"], (tx, ty, slope_n(ty) + 0.06),
               (tw + 0.26, tw + 0.26, 0.12), bev=0.008))
    # ---------------- 2. flue stack (round, mid height -- a different section)
    fx, fy, fr = p["flue_x"], p["flue_y"], p["flue_r"]
    o.append(CY("roof__flue_shaft", MAT["steel"], (fx, fy, (2.60 + p["flue_top"]) / 2),
                fr, p["flue_top"] - 2.60, n=18))
    o.append(CY("roof__flue_collar", MAT["brass"], (fx, fy, slope_n(fy) + 0.10),
                fr + 0.13, 0.16, n=18))
    o.append(CY("roof__flue_cone", MAT["steel"], (fx, fy, p["flue_top"] + 0.14),
                fr + 0.16, 0.26, n=18, r2=fr * 0.45))
    o.append(CY("roof__flue_cowl", MAT["brass"], (fx, fy, p["flue_top"] + 0.32),
                fr * 0.5, 0.10, n=14))
    for k in range(3):
        a = math.radians(30 + k * 120)
        o.append(B(f"roof__flue_stay_{k}", MAT["steel"],
                   (fx + math.cos(a) * (fr + 0.28), fy + math.sin(a) * (fr + 0.28),
                    p["flue_top"] - 0.60), (0.05, 0.05, 0.90), bev=0.004, lod=1))
    # ---------------- 3. cistern drum on a cradle (the water parti's terminus)
    dx, dy, dr, dh = p["drum_x"], p["drum_y"], p["drum_r"], p["drum_h"]
    dz = 4.62
    o.append(CY("roof__drum", MAT["roof"], (dx, dy, dz + dh / 2), dr, dh, n=26))
    o.append(CY("roof__drum_top", MAT["brass"], (dx, dy, dz + dh + 0.04), dr + 0.05,
                0.08, n=26))
    for k, zz in enumerate((dz + 0.28, dz + dh - 0.30)):
        o.append(TU(f"roof__drum_band_{k}", MAT["steel"], (dx, dy, zz), dr + 0.035,
                    dr - 0.005, 0.075, n=26, lod=1))
    o.append(CY("roof__drum_hatch", MAT["steel"], (dx - 0.26, dy, dz + dh + 0.13),
                0.20, 0.12, n=14))
    for k in range(4):
        a = math.radians(45 + k * 90)
        lx, ly_ = dx + math.cos(a) * (dr - 0.14), dy + math.sin(a) * (dr - 0.14)
        o.append(B(f"roof__drum_leg_{k}", MAT["steel"], (lx, ly_, (slope_n(ly_) + dz) / 2),
                   (0.11, 0.11, dz - slope_n(ly_)), bev=0.006))
    o.append(B("roof__drum_pad", MAT["ceramic"], (dx, dy, slope_n(dy) + 0.06),
               (2 * dr + 0.24, 2 * dr + 0.20, 0.12), bev=0.010))
    # gauge + outlet: the drum is plumbed, not decorative
    o.append(CY("roof__drum_gauge", MAT["glass"], (dx - dr - 0.04, dy, dz + dh / 2),
                0.035, dh - 0.30, n=10))
    o.append(CY("roof__drum_outlet", MAT["steel"], (dx, dy - dr - 0.10, dz + 0.22),
                0.075, 0.34, axis=1, n=12))
    # ---------------- 4. downpipe: valley sump -> drum
    o.append(CY("roof__downpipe", MAT["steel"], (4.62, p["val_y"] - 0.30,
                                                 (p["z_val"] - 0.10 + dz + 0.9) / 2),
                0.085, (dz + 0.9) - (p["z_val"] - 0.10), n=12))
    o.append(B("roof__downpipe_elbow", MAT["steel"], (4.48, p["val_y"] - 0.30, dz + 0.92),
                (0.34, 0.17, 0.17), bev=0.006))
    o.append(CY("roof__downpipe_feed", MAT["steel"], (dx, dy - dr - 0.34, dz + 0.92),
                0.075, 1.30, axis=1, n=12))
    # overflow to the rear splash block, so the north wall stain has a cause
    o.append(CY("roof__overflow", MAT["steel"], (dx + dr - 0.12, dy + 0.30, 3.60),
                0.055, 2.60, n=10))
    o.append(B("roof__splash_block", MAT["sinter"], (dx + dr - 0.12, p["ny"] + 0.09, 0.12),
               (0.52, 0.36, 0.20), bev=0.02))
    o.append(CY("roof__overflow_drop", MAT["steel"], (dx + dr - 0.12, p["ny"] + 0.06, 1.60),
                0.055, 3.00, n=10))
    # ---------------- 5. condenser plant on curbs (north plane, service side)
    for i, (cxp, cyp) in enumerate(((1.15, 3.50), (2.62, 2.42))):
        zc = slope_n(cyp)
        o.append(B(f"roof__curb_{i}", MAT["ceramic"], (cxp, cyp, zc + 0.09),
                   (1.14, 0.92, 0.18), bev=0.010))
        o.append(B(f"roof__cond_{i}_body", MAT["steel"], (cxp, cyp, zc + 0.50),
                   (1.00, 0.78, 0.64), bev=0.012))
        o.append(B(f"roof__cond_{i}_cap", MAT["roof"], (cxp, cyp, zc + 0.84),
                   (1.06, 0.84, 0.05), bev=0.008))
        o.append(CY(f"roof__cond_{i}_fan", MAT["steel"], (cxp, cyp, zc + 0.875), 0.27,
                    0.05, n=18))
        for k in range(4):
            o.append(B(f"roof__cond_{i}_gril_{k}", MAT["steel"],
                       (cxp - 0.51, cyp, zc + 0.26 + k * 0.13), (0.03, 0.68, 0.06),
                       bev=0.004, lod=1))
    o.append(B("roof__plant_conduit", MAT["steel"], (1.85, 3.86, slope_n(3.86) + 0.09),
               (4.70, 0.07, 0.07), bev=0.004, lod=1))
    o.append(B("roof__plant_conduit_b", MAT["steel"], (2.62, 3.00, slope_n(3.00) + 0.09),
               (0.07, 1.00, 0.07), bev=0.004, lod=1))
    # ---------------- 6. walkway pad + hatch + crickets
    o.append(B("roof__walkway", MAT["steel"], (-0.30, 2.62, 0.026),
               (8.60, 0.62, 0.05), bev=0.004))
    _rake(o[-1], "n")
    for i in range(9):
        o.append(B(f"roof__walk_tread_{i}", MAT["brass"], (-4.20 + i * 1.02, 2.62, 0.058),
                   (0.62, 0.52, 0.014), bev=0.003, lod=1))
        _rake(o[-1], "n")
    o.append(B("roof__hatch_curb", MAT["ceramic"], (-2.25, 3.30, slope_n(3.30) + 0.10),
               (0.92, 0.92, 0.20), bev=0.010))
    o.append(B("roof__hatch_lid", MAT["roof"], (-2.25, 3.68, slope_n(3.30) + 0.42),
               (0.96, 0.14, 0.66), bev=0.010))
    for s in (-1, 1):
        o.append(CY(f"roof__hatch_rail_{s}", MAT["steel"],
                    (-2.25 + s * 0.42, 2.96, slope_n(2.96) + 0.52), 0.028, 0.86, n=10))
    # crickets: real upslope diverters at each penetration
    ylim = PL.FOOT_Y - 0.36
    for nm, cxp, cyp, w in (("twr", tx, min(ty + tw / 2 + 0.30, ylim), tw + 0.30),
                            ("flue", fx, min(fy + fr + 0.30, ylim), 1.00),
                            ("drum", dx, min(dy + dr + 0.34, ylim), 1.30)):
        o.append(PR(f"roof__cricket_{nm}", MAT["roof"],
                    [(cyp - 0.34, slope_n(cyp - 0.34)),
                     (cyp + 0.34, slope_n(cyp + 0.34)),
                     (cyp + 0.34, slope_n(cyp + 0.34) + 0.02),
                     (cyp - 0.34, slope_n(cyp - 0.34) + 0.20)],
                    0, cxp - w / 2, cxp + w / 2, lod=1))
    return o


# ===========================================================================
# SUBSYSTEM 7 -- ceilings.  These are `roof__` so the cutaway REMOVES them.
# ===========================================================================
CEIL_LINER = 0.05
BOH_SOFFIT = 2.62
BAY_CEIL = 2.78


def build_ceilings():
    p, o = P, []
    ix = p["ix"]
    # raked plaster liner under the south deck == the public hall ceiling
    z_s = ceil_s(p["sy_in"]) - CEIL_LINER
    z_v = ceil_s(p["bulk_y0"]) - CEIL_LINER
    o.append(PR("roof__ceil_hall", MAT["plaster"],
                [(p["sy_in"], z_s), (p["bulk_y0"], z_v),
                 (p["bulk_y0"], z_v + CEIL_LINER), (p["sy_in"], z_s + CEIL_LINER)],
                0, -ix, ix, lod=1))
    # trainer bay ceiling (low third volume, read from the hall)
    o.append(B("roof__ceil_bay", MAT["plaster"],
               ((p["tr_x0"] + p["wt"] + ix) / 2, (p["tr_y"] + p["wt"] + p["sy_in"]) / 2,
                BAY_CEIL + CEIL_LINER / 2),
               (ix - p["tr_x0"] - p["wt"], p["sy_in"] - p["tr_y"] - p["wt"], CEIL_LINER),
               lod=1))
    # back-of-house: dropped soffits over the two plant bays only; the middle
    # stays open to the north deck so the clerestory can reach the aisle floor
    for nm, x0, x1 in (("w", -ix, -2.90), ("e", 3.20, ix)):
        o.append(B(f"roof__ceil_boh_{nm}", MAT["plaster"],
                   ((x0 + x1) / 2, (p["niche_y1"] + p["ny_in"]) / 2,
                    BOH_SOFFIT + CEIL_LINER / 2),
                   (x1 - x0, p["ny_in"] - p["niche_y1"], CEIL_LINER), lod=1))
        o.append(B(f"roof__ceil_boh_{nm}_fascia", MAT["steel"],
                   ((x0 + x1) / 2, p["niche_y1"] + 0.03, BOH_SOFFIT - 0.06),
                   (x1 - x0, 0.06, 0.16), bev=0.006, lod=1))
    # niche head soffit (over the docked terminals)
    o.append(B("roof__ceil_niche", MAT["plaster"],
               (0, (p["bulk_y0"] + p["niche_y1"]) / 2,
                p["floor_top"] + p["niche_h"] + CEIL_LINER / 2),
               (2 * ix, p["niche_y1"] - p["bulk_y0"], CEIL_LINER), lod=1))
    if not DETAIL:
        return o
    # exposed steel purlins under the raked hall ceiling: unequal bays
    for x in (-4.34, -2.12, 0.62, 3.24):
        z0 = ceil_s(p["sy_in"]) - CEIL_LINER - 0.16
        z1 = ceil_s(p["bulk_y0"]) - CEIL_LINER - 0.16
        o.append(PR(f"interior__purlin_{int(x*100)}", MAT["steel"],
                    [(p["sy_in"], z0), (p["bulk_y0"], z1),
                     (p["bulk_y0"], z1 + 0.32), (p["sy_in"], z0 + 0.32)],
                    0, x - 0.055, x + 0.055, bev=0.006, lod=1))
    return o


# ===========================================================================
# SUBSYSTEM 8 -- interior: service wall, niches, vendor, trainer, BOH, light
# ===========================================================================
NICHE_KEYS = ("bank", "trade", "assoc")
MARKS = {"bank": "bar", "trade": "cross", "assoc": "ring"}


def build_interior():
    p, o = P, []
    ix, ft = p["ix"], p["floor_top"]
    y0, y1 = p["bulk_y0"], p["bulk_y1"]
    top = ceil_s(y0) - CEIL_LINER          # 3.35 -- meets the hall ceiling
    nh = p["niche_h"]
    # ---------------- service wall (the valley's load path)
    ops = []
    for k in NICHE_KEYS:
        cx = CELLS[k][0]
        ops.append((cx - p["niche_w"] / 2, cx + p["niche_w"] / 2, ft, ft + nh))
    ops.append((p["pass_x"] - p["pass_w"] / 2, p["pass_x"] + p["pass_w"] / 2, ft,
                ft + p["pass_h"]))
    o += WA("interior__service_wall", MAT["ceramic"], 1, y0, y1, -ix, ix, ft, top,
            ops, bev=0.010)
    # niche pockets: side cheeks + back panel + head, extending north
    for k in NICHE_KEYS:
        cx = CELLS[k][0]
        hw = p["niche_w"] / 2
        for s in (-1, 1):
            o.append(B(f"interior__niche_{k}_cheek_{s}", MAT["ceramic"],
                       (cx + s * (hw + 0.085), (y1 + p["niche_y1"]) / 2, ft + nh / 2),
                       (0.17, p["niche_y1"] - y1, nh), bev=0.008))
        o.append(B(f"interior__niche_{k}_back", MAT["ceramic"],
                   (cx, p["niche_y1"] + 0.085, ft + nh / 2),
                   (p["niche_w"] + 0.34, 0.17, nh), bev=0.008))
        o.append(B(f"interior__niche_{k}_head", MAT["ceramic"],
                   (cx, (y0 + p["niche_y1"] + 0.17) / 2, ft + nh + 0.09),
                   (p["niche_w"] + 0.34, p["niche_y1"] + 0.17 - y0, 0.18), bev=0.008))
        if not DETAIL:
            continue
        # brass reveal framing the opening
        for s in (-1, 1):
            o.append(B(f"interior__niche_{k}_jamb_{s}", MAT["brass"],
                       (cx + s * (hw + 0.035), y0 - 0.012, ft + nh / 2),
                       (0.07, 0.06, nh + 0.07), bev=0.006, lod=1))
        o.append(B(f"interior__niche_{k}_lintel", MAT["brass"],
                   (cx, y0 - 0.012, ft + nh + 0.035),
                   (p["niche_w"] + 0.14, 0.06, 0.07), bev=0.006, lod=1))
        # backing panel: closes the bay, with a transaction slot and a shutter box
        o.append(B(f"interior__niche_{k}_panel", MAT["steel"],
                   (cx, p["niche_y1"] - 0.02, ft + nh / 2 + 0.10),
                   (p["niche_w"] - 0.06, 0.05, nh - 0.24), bev=0.006))
        o.append(B(f"interior__niche_{k}_slot", MAT["brass"],
                   (cx, p["niche_y1"] - 0.05, ft + 1.06), (0.52, 0.05, 0.11),
                   bev=0.006))
        o.append(B(f"interior__niche_{k}_shutterbox", MAT["steel"],
                   (cx, p["niche_y1"] - 0.10, ft + nh - 0.16),
                   (p["niche_w"] - 0.02, 0.20, 0.22), bev=0.008, lod=1))
        # service lighting: a downlight over the customer side of the counter
        # and a second lamp washing the terminal face, so the fixture the player
        # interacts with is the brightest thing in the bay.
        o.append(B(f"interior__niche_{k}_light", MAT["lamp"],
                   (cx, y0 + 0.20, ft + nh - 0.012), (0.86, 0.13, 0.018)))
        o.append(B(f"interior__niche_{k}_wash_housing", MAT["steel"],
                   (cx, y0 + 0.055, ft + nh - 0.10), (0.94, 0.14, 0.13),
                   bev=0.008, lod=1))
        o.append(B(f"interior__niche_{k}_wash", MAT["lamp"],
                   (cx, y0 + 0.105, ft + nh - 0.145), (0.84, 0.05, 0.04)))
        # geometric identifier plate above the opening -- no lettering
        pz = ft + nh + 0.52
        o.append(B(f"interior__sign_{k}_plate", MAT["ceramic"], (cx, y0 - 0.03, pz),
                   (0.96, 0.06, 0.60), bev=0.008, lod=1))
        o.append(B(f"interior__sign_{k}_frame", MAT["brass"], (cx, y0 - 0.048, pz),
                   (1.04, 0.03, 0.68), bev=0.005, lod=1))
        mk = MARKS[k]
        if mk == "bar":
            for i, w in enumerate((0.52, 0.34, 0.16)):
                o.append(B(f"interior__mark_{k}_{i}", MAT["brass"],
                           (cx, y0 - 0.068, pz + 0.16 - i * 0.16), (w, 0.02, 0.06),
                           bev=0.004, lod=1))
        elif mk == "cross":
            for i, (a, b) in enumerate(((0.50, 0.09), (0.09, 0.40))):
                o.append(B(f"interior__mark_{k}_{i}", MAT["brass"], (cx, y0 - 0.068, pz),
                           (a, 0.02, b), bev=0.004, lod=1))
        else:
            o.append(TU(f"interior__mark_{k}_ring", MAT["brass"], (cx, y0 - 0.062, pz),
                        0.24, 0.17, 0.02, axis=1, n=28, lod=1))
            o.append(B(f"interior__mark_{k}_pip", MAT["brass"], (cx, y0 - 0.068, pz),
                       (0.09, 0.02, 0.09), bev=0.003, lod=1))
    # --- the wall BETWEEN the niches is articulated, not a blank slab.
    # Three members only, all already in the building's vocabulary: a brass kick
    # where trolleys hit, a shallow recessed panel, and a datum reveal that
    # continues the niche lintel line across the solid piers.
    piers = []
    xs = sorted([CELLS[k][0] for k in NICHE_KEYS] + [p["pass_x"]])
    hws = {CELLS[k][0]: p["niche_w"] / 2 for k in NICHE_KEYS}
    hws[p["pass_x"]] = p["pass_w"] / 2
    prev = -ix
    for cx in xs:
        piers.append((prev, cx - hws[cx] - 0.17))
        prev = cx + hws[cx] + 0.17
    piers.append((prev, ix))
    if DETAIL:
        for i, (a, b) in enumerate(piers):
            if b - a < 0.30:
                continue
            o.append(B(f"interior__wall_kick_{i}", MAT["brass"],
                       ((a + b) / 2, y0 - 0.025, ft + 0.09), (b - a, 0.05, 0.18),
                       bev=0.006, lod=1))
            if b - a > 0.75:
                o.append(B(f"interior__wall_panel_{i}", MAT["ceramic"],
                           ((a + b) / 2, y0 + 0.035, ft + 1.32),
                           (b - a - 0.34, 0.06, 1.86), bev=0.010, lod=1))
                o.append(B(f"interior__wall_panel_lip_{i}", MAT["brass"],
                           ((a + b) / 2, y0 - 0.012, ft + 2.27),
                           (b - a - 0.30, 0.035, 0.05), bev=0.004, lod=1))
            o.append(B(f"interior__wall_datum_{i}", MAT["brass"],
                       ((a + b) / 2, y0 - 0.020, ft + nh + 0.035), (b - a, 0.04, 0.07),
                       bev=0.005, lod=1))
    # staff pass head + brass reveal
    o.append(B("interior__pass_head", MAT["brass"],
               (p["pass_x"], y0 - 0.012, ft + p["pass_h"] + 0.035),
               (p["pass_w"] + 0.12, 0.06, 0.07), bev=0.005, lod=1))
    # continuous cove light along the service wall, above the niche heads
    o.append(B("interior__wall_cove", MAT["steel"], (0, y0 - 0.13, ft + nh + 1.02),
               (2 * ix - 0.20, 0.20, 0.16), bev=0.010, lod=1))
    o.append(B("interior__wall_cove_lamp", MAT["lamp"], (0, y0 - 0.13, ft + nh + 0.94),
               (2 * ix - 0.60, 0.13, 0.02)))
    return o


def build_fitout():
    """Vendor line, trainer consultation, back-of-house, circulation, lighting."""
    p, o = P, []
    ix, ft = p["ix"], p["floor_top"]
    # ---------------- vendor / display line, west wall of the hall
    vx0, vx1 = -ix, -ix + 0.64
    vy0, vy1 = -2.20, 0.60
    o.append(B("interior__vendor_counter", MAT["sinter"],
               ((vx0 + vx1) / 2, (vy0 + vy1) / 2, ft + 0.44),
               (vx1 - vx0, vy1 - vy0, 0.88), bev=0.014))
    o.append(B("interior__vendor_top", MAT["ceramic"], ((vx0 + vx1) / 2 + 0.05,
                                                        (vy0 + vy1) / 2, ft + 0.915),
               (vx1 - vx0 + 0.10, vy1 - vy0 + 0.06, 0.07), bev=0.008))
    o.append(B("interior__vendor_edge", MAT["brass"], (vx1 + 0.075, (vy0 + vy1) / 2,
                                                       ft + 0.915),
               (0.05, vy1 - vy0 + 0.06, 0.085), bev=0.006, lod=1))
    if DETAIL:
        # display shelving above, stepping back; unequal shelf heights
        for i, (h, d) in enumerate(((1.42, 0.40), (1.86, 0.34), (2.26, 0.28))):
            o.append(B(f"interior__vendor_shelf_{i}", MAT["steel"],
                       (vx0 + d / 2, (vy0 + vy1) / 2, ft + h), (d, vy1 - vy0 - 0.10, 0.045),
                       bev=0.005))
            o.append(B(f"interior__vendor_lip_{i}", MAT["brass"],
                       (vx0 + d - 0.015, (vy0 + vy1) / 2, ft + h + 0.045),
                       (0.03, vy1 - vy0 - 0.10, 0.05), bev=0.004, lod=1))
        for s in (-1, 1):
            o.append(B(f"interior__vendor_post_{s}", MAT["steel"],
                       (vx0 + 0.20, (vy0 + vy1) / 2 + s * (vy1 - vy0) / 2, ft + 1.40),
                       (0.075, 0.075, 2.76), bev=0.006))
        # hanging rack over the counter -- market language, not civic
        o.append(CY("interior__vendor_rack", MAT["steel"], (vx1 - 0.06, (vy0 + vy1) / 2,
                                                            ft + 2.16),
                    0.030, vy1 - vy0 - 0.06, axis=1, n=10))
        for i, yy in enumerate((-1.86, -1.34, -0.62, 0.06, 0.42)):
            o.append(CY(f"interior__vendor_hook_{i}", MAT["brass"], (vx1 - 0.06, yy,
                                                                     ft + 2.05),
                        0.013, 0.22, n=8, lod=1))
        # produce bins let into the counter top
        for i, yy in enumerate((-1.70, -1.05, -0.40)):
            o.append(B(f"interior__vendor_bin_{i}", MAT["steel"], (vx1 - 0.16, yy,
                                                                   ft + 0.955),
                       (0.34, 0.44, 0.10), bev=0.010, lod=1))
        o.append(B("interior__vendor_scale", MAT["brass"], (vx1 - 0.18, 0.36, ft + 1.05),
                   (0.24, 0.24, 0.20), bev=0.010, lod=1))
        o.append(B("interior__vendor_light", MAT["lamp"], (vx0 + 0.34, (vy0 + vy1) / 2,
                                                           ft + 2.72),
                   (0.16, vy1 - vy0 - 0.40, 0.025)))
    # ---------------- trainer consultation, inside the south-east bay
    tx, ty = 4.15, -2.70
    o.append(B("interior__trainer_desk", MAT["ceramic"], (tx, ty, ft + 0.72),
               (1.70, 0.42, 0.07), bev=0.010))
    o.append(B("interior__trainer_apron", MAT["sinter"], (tx, ty + 0.02, ft + 0.35),
               (1.54, 0.34, 0.68), bev=0.012))
    if DETAIL:
        o.append(B("interior__trainer_edge", MAT["brass"], (tx, ty - 0.215, ft + 0.72),
                   (1.70, 0.05, 0.09), bev=0.006, lod=1))
        # pin/route board on the bay back wall + a kit shelf
        o.append(B("interior__trainer_board", MAT["ceramic"],
                   (tx, p["tr_y"] + p["wt"] + 0.035, 1.72), (1.86, 0.06, 1.00),
                   bev=0.010))
        o.append(B("interior__trainer_board_frame", MAT["brass"],
                   (tx, p["tr_y"] + p["wt"] + 0.055, 1.72), (1.98, 0.03, 1.12),
                   bev=0.005, lod=1))
        for i, (dx_, dz) in enumerate(((-0.62, 0.22), (-0.18, -0.14), (0.34, 0.26),
                                       (0.70, -0.06))):
            o.append(B(f"interior__trainer_pin_{i}", MAT["cyan"],
                       (tx + dx_, p["tr_y"] + p["wt"] + 0.062, 1.72 + dz),
                       (0.055, 0.02, 0.055)))
        o.append(B("interior__trainer_shelf", MAT["steel"], (ix - 0.22, -2.60, ft + 1.34),
                   (0.40, 0.90, 0.045), bev=0.005, lod=1))
        o.append(B("interior__trainer_sconce", MAT["lamp"], (tx, p["tr_y"] + p["wt"] + 0.08,
                                                             2.44),
                   (1.30, 0.05, 0.025)))
        o.append(B("interior__trainer_kit", MAT["steel"], (tx + 0.58, ty + 0.04, ft + 0.82),
                   (0.30, 0.22, 0.13), bev=0.010, lod=1))
        # bay built-ins: the bay walls are fitted out, not blank (defect E6)
        bx = p["tr_x0"] + p["wt"]
        for i, (h, d) in enumerate(((0.98, 0.32), (1.46, 0.28), (1.94, 0.24))):
            o.append(B(f"interior__bay_shelf_{i}", MAT["steel"],
                       (bx + d / 2, -2.86, ft + h), (d, 1.10, 0.04), bev=0.004,
                       lod=1))
        o.append(B("interior__bay_shelf_back", MAT["ceramic"], (bx + 0.03, -2.86, ft + 1.46),
                   (0.06, 1.22, 1.36), bev=0.006, lod=1))
        o.append(B("interior__bay_case", MAT["sinter"], (bx + 0.24, -1.68, ft + 0.40),
                   (0.48, 0.86, 0.80), bev=0.012))
        o.append(B("interior__bay_case_top", MAT["ceramic"], (bx + 0.24, -1.68, ft + 0.82),
                   (0.54, 0.92, 0.05), bev=0.006, lod=1))
        o.append(CY("interior__bay_rail", MAT["brass"], (bx + 0.16, -2.86, ft + 2.16),
                    0.022, 1.10, axis=1, n=10, lod=1))
        for i in range(3):
            o.append(B(f"interior__bay_marker_{i}", MAT["brass"],
                       (p["ix"] - 0.035, -3.05 + i * 0.30, 2.28),
                       (0.03, 0.10, 0.34), bev=0.004, lod=1))
    # ---------------- circulation: a single brass queue rail, not a cage
    if DETAIL:
        for i, x in enumerate((-1.55, 0.05, 1.65)):
            o.append(CY(f"interior__rail_post_{i}", MAT["brass"], (x, -1.55, ft + 0.50),
                        0.034, 0.96, n=12))
            o.append(CY(f"interior__rail_foot_{i}", MAT["steel"], (x, -1.55, ft + 0.025),
                        0.11, 0.05, n=14, lod=1))
        o.append(CY("interior__rail_top", MAT["brass"], (0.05, -1.55, ft + 0.97),
                    0.026, 3.20, axis=0, n=10))
    # ---------------- back of house
    ny_in = p["ny_in"]
    o.append(B("interior__boh_bench", MAT["steel"], (4.10, ny_in - 0.32, ft + 0.44),
               (2.10, 0.62, 0.88), bev=0.010))
    o.append(B("interior__boh_bench_top", MAT["ceramic"], (4.10, ny_in - 0.32, ft + 0.915),
               (2.18, 0.66, 0.07), bev=0.008, lod=1))
    for i in range(4):
        o.append(B(f"interior__boh_shelf_{i}", MAT["steel"], (-3.95, ny_in - 0.24,
                                                              ft + 0.40 + i * 0.56),
                   (2.30, 0.48, 0.045), bev=0.005, lod=1))
    if DETAIL:
        for s in (-1, 1):
            o.append(B(f"interior__boh_shelf_post_{s}", MAT["steel"],
                       (-3.95 + s * 1.10, ny_in - 0.24, ft + 1.10), (0.06, 0.48, 2.20),
                       bev=0.005))
        # switchgear + authored water tank (the runtime tank prop lacks provenance)
        o.append(B("interior__boh_switchgear", MAT["steel"], (ix - 0.26, 2.98, ft + 0.84),
                   (0.46, 0.80, 1.66), bev=0.010))
        for k in range(3):
            o.append(B(f"interior__boh_led_{k}", MAT["cyan"], (ix - 0.50, 2.76 + k * 0.18,
                                                               ft + 1.42),
                       (0.02, 0.06, 0.05)))
        o.append(CY("interior__boh_tank", MAT["steel"], (2.30, 3.16, ft + 1.06), 0.44,
                    1.28, n=18))
        o.append(TU("interior__boh_tank_band", MAT["brass"], (2.30, 3.16, ft + 1.52),
                    0.455, 0.435, 0.07, n=18, lod=1))
        o.append(CY("interior__boh_tank_pipe", MAT["steel"], (2.30, 3.16, ft + 2.10),
                    0.055, 0.90, n=10))
        for k in range(3):
            a = math.radians(30 + k * 120)
            o.append(B(f"interior__boh_tank_foot_{k}", MAT["steel"],
                       (2.30 + math.cos(a) * 0.34, 3.16 + math.sin(a) * 0.34, ft + 0.20),
                       (0.09, 0.09, 0.36), bev=0.005, lod=1))
        # service ladder to the roof hatch
        for i in range(9):
            o.append(CY(f"interior__boh_rung_{i}", MAT["steel"], (-2.30, 3.42,
                                                                  ft + 0.34 + i * 0.45),
                        0.019, 0.44, axis=0, n=8))
        for s in (-1, 1):
            o.append(B(f"interior__boh_ladder_{s}", MAT["steel"], (-2.30 + s * 0.22, 3.42,
                                                                    ft + 2.14),
                       (0.05, 0.05, 4.20), bev=0.005))
        # rear service threshold + trolley kerb
        o.append(B("interior__svc_threshold", MAT["brass"], (p["svc_x"], p["ny_in"] + 0.10,
                                                             ft - 0.006),
                   (p["svc_w"] + 0.18, 0.46, 0.026), bev=0.005, lod=1))
        # BOH strip lighting under the dropped soffits
        for nm, xx in (("w", -3.90), ("e", 4.20)):
            o.append(B(f"interior__boh_light_{nm}", MAT["lamp"], (xx, 3.05,
                                                                  BOH_SOFFIT - 0.03),
                       (2.20, 0.12, 0.025)))
    # ---------------- hall pendants over the circulation spine
    if DETAIL:
        for i, (x, yy) in enumerate(((-2.90, -1.10), (0.30, -1.10), (3.30, -1.10))):
            zc = ceil_s(yy) - CEIL_LINER
            o.append(CY(f"interior__pend_rod_{i}", MAT["steel"], (x, yy, zc - 0.55),
                        0.012, 1.10, n=8))
            o.append(CY(f"interior__pend_shade_{i}", MAT["steel"], (x, yy, zc - 1.18),
                        0.34, 0.22, n=20, r2=0.14))
            o.append(CY(f"interior__pend_lamp_{i}", MAT["lamp"], (x, yy, zc - 1.28),
                        0.16, 0.03, n=18))
    return o


# ===========================================================================
# SUBSYSTEM 9 -- allowed loose props (read-only; provenance is mandatory)
# ===========================================================================
def _prop_back_y(fn, back_y):
    """Origin y so the prop's BACK face lands on `back_y` after a 180 deg yaw."""
    return back_y - PROP_HALF[fn]


PROP_HALF = {"bank_terminal_civic": 0.3455, "trade_terminal": 0.365,
             "pa_terminal": 0.329}
NICHE_BACK = 2.455

PROPS = [
    ("bank_terminal_civic.glb", CELLS["bank"][0],
     _prop_back_y("bank_terminal_civic", NICHE_BACK), 180.0,
     "bank / private-value service point, docked in its niche, facing the cell"),
    ("trade_terminal.glb", CELLS["trade"][0],
     _prop_back_y("trade_terminal", NICHE_BACK), 180.0,
     "trade / exchange service point, docked in its niche, facing the cell"),
    ("pa_terminal.glb", CELLS["assoc"][0],
     _prop_back_y("pa_terminal", NICHE_BACK), 180.0,
     "player-association registry point, docked in its niche, facing the cell"),
    ("chair_frontier_a.glb", 4.15, -2.97, 180.0, "trainer's seat, facing the customer"),
    ("chair_frontier_b.glb", 3.35, -2.10, 0.0, "visitor seat at the trainer desk"),
    ("crate_planked.glb", -3.95, -1.55, 12.0, "vendor goods at the display line"),
    ("footlocker_frontier.glb", -4.60, 2.80, 0.0, "back-of-house storage locker"),
]


def import_props():
    out = []
    for fn, x, y, rz, _role in PROPS:
        path = os.path.join(PROPDIR, fn)
        before = set(bpy.data.objects)
        bpy.ops.import_scene.gltf(filepath=path)
        new = [ob for ob in bpy.data.objects if ob not in before]
        roots = [ob for ob in new if ob.parent is None]
        e = bpy.data.objects.new(f"prop__{fn[:-4]}", None)
        e.empty_display_size = 0.2
        bpy.context.scene.collection.objects.link(e)
        for r in roots:
            r.parent = e
            r.matrix_parent_inverse = e.matrix_world.inverted()
        e.location = (x, y, P["floor_top"])
        e.rotation_euler = (0, 0, math.radians(rz))
        out.append(e)
        out.extend(new)
    return out


def prop_records():
    recs = []
    for fn, x, y, rz, role in PROPS:
        path = os.path.join(PROPDIR, fn)
        pv = os.path.join(PROPDIR, fn[:-4] + ".provenance.json")
        mf = os.path.join(PROPDIR, fn[:-4] + "_manifest.json")
        recs.append({
            "file": f"{REL}/{fn}",
            "sha256": hashlib.sha256(open(path, "rb").read()).hexdigest(),
            "bytes": os.path.getsize(path),
            "provenance": f"{REL}/{fn[:-4]}.provenance.json" if os.path.exists(pv) else None,
            "manifest": f"{REL}/{fn[:-4]}_manifest.json" if os.path.exists(mf) else None,
            "role": role,
            "placement_asset_space": {"x": round(x, 4), "y": round(P["floor_top"], 4),
                                      "z": round(-y, 4), "yaw_deg_about_Y": round(-rz, 2)},
            "note": "asset space is glTF: +Y up, +Z public front",
        })
    return recs


# ===========================================================================
# SUBSYSTEM 10 -- causal wear written to COLOR_0 (never a uniform noise field)
# ===========================================================================
def _h1(v):
    s = math.sin(v * 12.9898) * 43758.5453
    return s - math.floor(s)


# (x, y, z, radius, strength) -- only where hands, feet, goods and water go
GRIME = [
    (-0.30, -3.12, 1.05, 0.85, 0.30),      # entry threshold rub
    (-0.30, -2.78, 0.10, 1.70, 0.26),      # tracked-in dust inside the door
    (-1.52, -2.70, 1.06, 0.45, 0.34),      # door pull, closed position
    (0.92, -2.70, 1.06, 0.30, 0.26),       # leading stile handling
    (-4.58, -0.80, 0.92, 1.30, 0.24),      # vendor counter edge
    (4.15, -2.49, 0.74, 0.90, 0.22),       # trainer desk edge
    (4.10, 3.29, 0.92, 0.95, 0.22),        # BOH bench
    (1.30, 3.61, 1.00, 0.80, 0.28),        # rear service door jamb
    (-4.66, 1.85, 1.05, 0.55, 0.26),       # staff pass rub
    (-4.10, -3.64, 0.50, 1.10, 0.22),      # loggia goods ledge
    (0.05, -1.55, 0.97, 1.65, 0.18),       # queue rail
]
for _k in NICHE_KEYS:
    _cx = CELLS[_k][0]
    GRIME.append((_cx - 0.70, 1.85, 1.10, 0.42, 0.28))     # niche jamb, left
    GRIME.append((_cx + 0.70, 1.85, 1.10, 0.42, 0.28))     # niche jamb, right
    GRIME.append((_cx, 1.85, 1.06, 0.55, 0.16))            # transaction slot


def wear(pt, n, ao, tone=1.0):
    x, y, z = pt
    p = P
    # contact AO darkens creases only (AO is not a global dimmer). The whole
    # range stays inside 0..1 because glTF clamps COLOR_0 (validator:
    # ACCESSOR_NON_CLAMPED), so "lighter than base" means "closer to 1.0".
    v = COL_BASE * (0.78 + 0.22 * max(0.0, min(1.0, ao)))
    # per-part tonal drift at architectural scale: panel-to-panel, not noise
    v *= tone
    g = 0.0
    for (gx, gy, gz, r, s) in GRIME:
        d = math.sqrt((x - gx) ** 2 + (y - gy) ** 2 + (z - gz) ** 2)
        if d < r:
            g = max(g, s * (1.0 - d / r) ** 1.5)
    # --- water: only under things that actually shed water
    w = 0.0
    # 1. the brass datum band drips onto the plinth below it
    if z < p["base_top"] and abs(n[2]) < 0.6:
        horiz = x if abs(n[1]) > abs(n[0]) else y
        st = _h1(horiz * 2.7 + 0.3) * 0.62 + _h1(horiz * 9.1) * 0.38
        if st > 0.68:
            fall = max(0.0, 1.0 - (p["base_top"] - z) / 1.7)
            w = (st - 0.68) / 0.32 * 0.26 * fall
    # 2. the cistern overflow pipe stains the north wall in one place
    if y > p["ny"] - 0.10 and abs(x - (p["drum_x"] + p["drum_r"] - 0.12)) < 0.42:
        w = max(w, 0.34 * (1.0 - abs(x - (p["drum_x"] + p["drum_r"] - 0.12)) / 0.42)
                * max(0.0, 1.0 - z / 3.6))
    # 3. the west valley sump discharges over the west verge
    if x < -p["mx"] + 0.10 and abs(y - 1.55) < 0.55 and z < p["z_val"]:
        w = max(w, 0.24 * (1.0 - abs(y - 1.55) / 0.55)
                * max(0.0, 1.0 - (p["z_val"] - z) / 3.4))
    # --- wind-driven dust settles on up-facing surfaces, strongest low down
    dust = 0.0
    if n[2] > 0.55 and z < 3.0:
        dust = 0.20 * max(0.0, 1.0 - z / 3.0) * (0.55 + 0.45 * _h1(x * 0.7 + y * 1.3))
    d = max(g, w)
    r_ = v * (1.0 - d)
    g_ = v * (1.0 - d * 1.06)
    b_ = v * (1.0 - d * 1.18)
    if w > g:                                  # water stain is cooler and darker
        r_, g_, b_ = v * (1.0 - d * 1.14), v * (1.0 - d * 1.07), v * (1.0 - d)
    if dust > 0.0:                             # dust is warm and lightens
        r_ += (1.0 - r_) * dust * 1.00
        g_ += (1.0 - g_) * dust * 0.85
        b_ += (1.0 - b_) * dust * 0.58
    return (min(1.0, max(0.03, r_)), min(1.0, max(0.03, g_)), min(1.0, max(0.03, b_)))


COL_BASE = 0.88          # COLOR_0 headroom: dust and tone must stay <= 1.0

TONE = {"MKT_Ceramic": 0.055, "MKT_Sinter": 0.045, "MKT_Screed": 0.035,
        "MKT_RoofMetal": 0.05, "MKT_Plaster": 0.03}


def assign_tone(objs):
    """Deterministic per-part tone drift so panels differ without a noise stamp."""
    for ob in objs:
        amp = 0.0
        if ob.type == 'MESH' and ob.material_slots and ob.material_slots[0].material:
            amp = TONE.get(ob.material_slots[0].material.name, 0.0)
        ob["_tone"] = min(1.0, max(0.0, 1.0 + (
            _h1(len(ob.name) * 1.7 + sum(map(ord, ob.name)) * 0.013) - 0.5)
            * 2.0 * amp))


# ===========================================================================
# SUBSYSTEM 11 -- authored collision proxies (simple, named, never decorative)
# ===========================================================================
def collision_boxes():
    p = P
    ft = p["floor_top"]
    B_ = []

    def add(i, x0, x1, y0, y1, z0, z1, kind):
        """Authoring-space box -> glTF-space min/max (x, y=z_up, z=-y_north)."""
        B_.append({"id": i, "shape": "box", "kind": kind,
                   "min": [round(min(x0, x1), 4), round(min(z0, z1), 4),
                           round(-max(y0, y1), 4)],
                   "max": [round(max(x0, x1), 4), round(max(z0, z1), 4),
                           round(-min(y0, y1), 4)]})

    # ---- outer structure
    add("shell__wall_west", -p["mx"], -p["ix"], p["sy"], p["ny"], ft, 3.39, "structure")
    add("shell__wall_east", p["ix"], p["mx"], p["tr_y"], p["ny"], ft, 3.39, "structure")
    sx0, sx1 = p["svc_x"] - p["svc_w"] / 2, p["svc_x"] + p["svc_w"] / 2
    add("shell__wall_north_w", -p["mx"], sx0, p["ny_in"], p["ny"], ft, 4.30, "structure")
    add("shell__wall_north_e", sx1, p["mx"], p["ny_in"], p["ny"], ft, 4.30, "structure")
    add("shell__wall_north_head", sx0, sx1, p["ny_in"], p["ny"], ft + p["svc_h"], 4.30,
        "structure")
    add("shell__wall_south_w", -p["mx"], p["hood_op0"], p["sy"], p["sy_in"], ft, 4.17,
        "structure")
    add("shell__wall_south_e", p["hood_op1"], p["tr_x0"], p["sy"], p["sy_in"], ft, 4.17,
        "structure")
    add("shell__entry_head", p["hood_op0"], p["hood_op1"], p["sy"], p["sy_in"],
        ft + 3.34, 4.17, "structure")
    add("shell__bay_south", p["tr_x0"], p["mx"], p["tr_y"], p["tr_y"] + p["wt"], ft,
        p["tr_top"], "structure")
    add("shell__bay_west", p["tr_x0"], p["tr_x0"] + p["wt"], p["tr_y"], p["sy"], ft,
        p["tr_top"], "structure")
    add("shell__hood_pier_w", p["hood_cx"] - p["hood_ro"], p["hood_op0"], p["hood_y"],
        p["sy"], ft, p["hood_spr"], "structure")
    add("shell__hood_pier_e", p["hood_op1"], p["hood_cx"] + p["hood_ro"], p["hood_y"],
        p["sy"], ft, p["hood_spr"], "structure")
    for i, (x, w) in enumerate(LOG_PIERS):
        add(f"shell__loggia_pier_{i}", x - w / 2, x + w / 2, p["log_y"] - w / 2,
            p["log_y"] + w / 2, ft, p["log_top"], "structure")
    # ---- service wall, solid between the openings
    edges = [-p["ix"]]
    holes = sorted([(CELLS[k][0] - p["niche_w"] / 2, CELLS[k][0] + p["niche_w"] / 2)
                    for k in NICHE_KEYS] +
                   [(p["pass_x"] - p["pass_w"] / 2, p["pass_x"] + p["pass_w"] / 2)])
    for a, b in holes:
        edges += [a, b]
    edges.append(p["ix"])
    for i in range(0, len(edges), 2):
        a, b = edges[i], edges[i + 1]
        if b - a > 0.02:
            add(f"shell__service_wall_{i // 2}", a, b, p["bulk_y0"], p["bulk_y1"], ft,
                3.35, "structure")
    # niche cheeks + backs: the pocket walls behind the docked terminals
    for k in NICHE_KEYS:
        cx = CELLS[k][0]
        hw = p["niche_w"] / 2
        for s in (-1, 1):
            add(f"shell__niche_{k}_cheek_{'w' if s < 0 else 'e'}", cx + s * hw,
                cx + s * (hw + 0.17), p["bulk_y1"], p["niche_y1"], ft,
                ft + p["niche_h"], "structure")
        add(f"shell__niche_{k}_back", cx - hw, cx + hw, p["niche_y1"],
            p["niche_y1"] + 0.17, ft, ft + p["niche_h"], "structure")
    # ---- built-in furniture
    add("fixture__vendor_counter", -p["ix"], -p["ix"] + 0.74, -2.20, 0.60, ft,
        ft + 0.95, "furniture")
    add("fixture__trainer_desk", 3.30, 5.00, -2.91, -2.49, ft, ft + 0.76, "furniture")
    add("fixture__boh_bench", 3.05, 5.15, p["ny_in"] - 0.63, p["ny_in"], ft, ft + 0.95,
        "furniture")
    add("fixture__boh_shelving", -5.10, -2.80, p["ny_in"] - 0.48, p["ny_in"], ft,
        ft + 2.20, "furniture")
    add("fixture__boh_switchgear", p["ix"] - 0.49, p["ix"], 2.58, 3.38, ft, ft + 1.67,
        "furniture")
    add("fixture__boh_tank", 1.86, 2.74, 2.72, 3.60, ft, ft + 1.70, "furniture")
    add("fixture__boh_ladder", -2.55, -2.05, 3.36, 3.50, ft, ft + 4.24, "furniture")
    add("fixture__queue_rail", -1.59, 1.69, -1.59, -1.51, ft, ft + 1.00, "furniture")
    add("fixture__loggia_ledge", -5.25, -2.95, -3.95, -3.33, ft, ft + 0.50, "furniture")
    add("fixture__loggia_bench", -3.75, -2.65, -3.76, -3.32, ft, ft + 0.47, "furniture")
    # ---- the door, fully closed
    hw = p["leaf_w"] / 2
    add("door__closed", p["door_cx"] - hw, p["door_cx"] + hw,
        p["leaf_y"] - p["leaf_t"] / 2, p["leaf_y"] + p["leaf_t"] / 2, ft,
        ft + p["leaf_h"], "door")
    return B_


def make_collision_objects(boxes):
    obs = []
    for b in boxes:
        mn, mx = b["min"], b["max"]
        x0, x1 = mn[0], mx[0]
        z0, z1 = mn[1], mx[1]
        y0, y1 = -mx[2], -mn[2]
        obs.append(M.box("collision__" + b["id"], None,
                         ((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2),
                         (x1 - x0, y1 - y0, z1 - z0)))
    return obs


def verify_clearance(boxes):
    """Prove every promised cell, its customer approach and the door path clear."""
    p, issues, checks = P, [], []
    half = p["cell"] / 2
    ft = p["floor_top"]

    def ov(b, x0, x1, y0, y1, z0, z1):
        return not (b["max"][0] <= x0 + 1e-9 or b["min"][0] >= x1 - 1e-9 or
                    -b["min"][2] <= y0 + 1e-9 or -b["max"][2] >= y1 - 1e-9 or
                    b["max"][1] <= z0 + 1e-9 or b["min"][1] >= z1 - 1e-9)

    for k, (cx, cy) in CELLS.items():
        checks.append((f"cell_{k}", cx - half, cx + half, cy - half, cy + half,
                       ft, ft + 2.0))
    for k, (c, r) in PL.APPROACH.items():
        ax, ay = PL.cell(c, r)
        checks.append((f"approach_{k}", ax - half, ax + half, ay - half, ay + half,
                       ft, ft + 1.9))
    # terminal front clearance (manifest: 0.8 m in front of +Z) measured from the
    # docked terminal face southward into the hall
    for k, fn in (("bank", "bank_terminal_civic"), ("trade", "trade_terminal"),
                  ("assoc", "pa_terminal")):
        cx = CELLS[k][0]
        front = NICHE_BACK - 2 * PROP_HALF[fn]
        checks.append((f"front_clearance_{k}", cx - 0.40, cx + 0.40, front - 0.80,
                       front, ft, ft + 1.9))
    hw = p["leaf_w"] / 2
    tol = 0.012
    checks.append(("door_swept_volume", p["door_cx"] + p["travel"] - hw,
                   p["door_cx"] + hw, p["leaf_y"] - p["leaf_t"] / 2 - tol,
                   p["leaf_y"] + p["leaf_t"] / 2 + tol, ft, ft + p["leaf_h"]))
    checks.append(("door_walk_through", p["door_cx"] - p["door_w"] / 2 + 0.05,
                   p["door_cx"] + p["door_w"] / 2 - 0.05, p["sy"] - 0.40,
                   p["sy_in"] + 0.40, ft, ft + 2.0))
    report = []
    for (nm, x0, x1, y0, y1, z0, z1) in checks:
        hits = []
        for b in boxes:
            if b["kind"] == "door" and nm.startswith("door_"):
                continue
            if ov(b, x0, x1, y0, y1, z0, z1):
                hits.append(b["id"])
        report.append({"check": nm, "clear": not hits, "blockers": hits,
                       "volume_authoring": {"x": [round(x0, 3), round(x1, 3)],
                                            "y": [round(y0, 3), round(y1, 3)],
                                            "z": [round(z0, 3), round(z1, 3)]}})
        issues += [f"{nm} blocked by {h}" for h in hits]
    return issues, report


# ===========================================================================
# LOD policy -- `lod` = highest LOD level at which a part survives
# ===========================================================================
L2_KEYS = ("__plinth", "__skin", "deck_south", "deck_north", "deck_bay", "gable_",
           "__rake", "bay_rake", "hood_shell", "hood_pier", "hood_face", "log_pier",
           "log_beam", "log_deck", "log_joist", "service_wall", "niche_bank_cheek",
           "niche_trade_cheek", "niche_assoc_cheek", "niche_bank_back",
           "niche_trade_back", "niche_assoc_back", "niche_bank_head",
           "niche_trade_head", "niche_assoc_head", "slab", "screed", "deck_loggia",
           "deck_entry", "vendor_counter", "vendor_top", "trainer_desk",
           "trainer_apron", "tower_shaft", "tower_head", "tower_cap", "drum",
           "flue_shaft", "flue_cone", "bay_spandrel", "ceil_hall", "ceil_bay",
           "valley_gutter", "valley_beam", "cler_glass", "boh_bench", "transom",
           "bay_lintel", "track_beam", "cross_infill")
L1_KEYS = ("__band", "ceil_boh", "ceil_niche", "seam_", "brise", "verge", "eave_",
           "cler_sill", "cler_head", "cler_post", "walkway", "curb_", "cond_",
           "downpipe", "hatch", "boh_shelf", "switchgear", "boh_tank", "purlin",
           "vendor_shelf", "trainer_board", "sign_", "niche_", "log_fascia",
           "log_ledge", "shop_", "track_rail", "track_fascia", "hood_soffit",
           "hood_spring", "fan_", "threshold", "grate_frame", "wall_cove",
           "cricket", "splash", "overflow", "flue_collar", "flue_cowl", "bollard")


def assign_lods():
    for ob in M.SCENE_OBJS:
        n = ob.name
        cur = ob.get("lod", 0) or 0
        if any(k in n for k in L2_KEYS):
            cur = max(cur, 2)
        elif any(k in n for k in L1_KEYS):
            cur = max(cur, 1)
        ob["lod"] = cur


# ===========================================================================
# BUILD / BAKE / EXPORT
# ===========================================================================
PREFIXES = ("roof__", "wall_front__", "wall_back__", "wall_left__", "wall_right__",
            "floor__", "interior__")


def build_scene(lod_level, with_props=False):
    M.clear()
    M.LOD_BEVEL = 1.0 if lod_level == 0 else (0.65 if lod_level == 1 else 0.0)
    M.LOD_NSCALE = 1.0 if lod_level == 0 else (0.60 if lod_level == 1 else 0.38)
    materials()
    build_ground()
    build_shell()
    build_hood()
    build_loggia()
    build_door()
    build_roof()
    build_roof_plant()
    build_ceilings()
    build_interior()
    build_fitout()
    assign_lods()
    leaf = bpy.data.objects.get("door_slide__leaf")
    if leaf:
        leaf["lod"] = 2
    # per-part tone -> baked into COLOR_0 now, so it survives the join
    assign_tone(M.SCENE_OBJS + ([leaf] if leaf else []))
    for ob in M.SCENE_OBJS:
        t = ob.get("_tone", 1.0)
        M.ensure_vcolor(ob, (t, t, t))
    if leaf:
        t = leaf.get("_tone", 1.0)
        M.ensure_vcolor(leaf, (t, t, t))
    # drop parts that do not survive this LOD
    bad = report_offenders(M.SCENE_OBJS + ([leaf] if leaf else []))
    if bad:
        raise AssertionError(f"{len(bad)} authored parts leave the footprint")
    for ob in [o for o in list(M.SCENE_OBJS) if (o.get("lod", 0) or 0) < lod_level]:
        M.SCENE_OBJS.remove(ob)
        bpy.data.objects.remove(ob, do_unlink=True)
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
        M.uv_project(ob, TILES, default=2.0)
        _triangulate(ob)
    props = import_props() if with_props else []
    return joined, props


def _triangulate(ob):
    """Full triangulation: guarantees glTF tangent generation cannot fail."""
    import bmesh
    bm = bmesh.new()
    bm.from_mesh(ob.data)
    bmesh.ops.triangulate(bm, faces=bm.faces, quad_method='SHORT_EDGE',
                          ngon_method='BEAUTY')
    bm.to_mesh(ob.data)
    bm.free()


def bake_wear(joined, lod_level):
    """Short-ray contact AO + causal wear, multiplied onto the per-part tone."""
    samples = 12 if lod_level == 0 else (7 if lod_level == 1 else 4)
    M.compute_ao(joined, joined, samples=samples, dist=0.55, seed=3)
    for ob in joined:
        me = ob.data
        if "Col" not in me.color_attributes:
            me.color_attributes.new(name="Col", type='FLOAT_COLOR', domain='POINT')
        ca = me.color_attributes["Col"]
        ao = ob.get("_ao")
        mw = ob.matrix_world
        nm = mw.to_3x3()
        for i, v in enumerate(me.vertices):
            tone = ca.data[i].color[0] if i < len(ca.data) else 1.0
            pnt = mw @ v.co
            n = (nm @ v.normal).normalized()
            c = wear(pnt, n, ao[i] if ao else 1.0, tone)
            ca.data[i].color = (c[0], c[1], c[2], 1.0)


def strip_prop_colors(props):
    """Imported props keep their own materials; drop unused colour attributes so
    the export log stays free of 'active vertex color not exported' warnings."""
    for ob in props:
        if ob.type != 'MESH':
            continue
        for ca in list(ob.data.color_attributes):
            ob.data.color_attributes.remove(ca)


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


def bounds(objs):
    mn = [1e9] * 3
    mx = [-1e9] * 3
    for ob in objs:
        if ob.type != 'MESH':
            continue
        for c in ob.bound_box:
            w = ob.matrix_world @ Vector(c)
            for i in range(3):
                mn[i] = min(mn[i], w[i])
                mx[i] = max(mx[i], w[i])
    return mn, mx


def report_offenders(objs, limit=14):
    """Name the individual parts that leave the authored footprint."""
    fx, fy = PL.FOOT_X, PL.FOOT_Y
    bad = []
    for ob in objs:
        if ob.type != 'MESH':
            continue
        o_mn = [1e9] * 3
        o_mx = [-1e9] * 3
        for c in ob.bound_box:
            w = ob.matrix_world @ Vector(c)
            for i in range(3):
                o_mn[i] = min(o_mn[i], w[i])
                o_mx[i] = max(o_mx[i], w[i])
        e = max(-fx - o_mn[0], o_mx[0] - fx, -fy - o_mn[1], o_mx[1] - fy)
        if e > 1e-4:
            bad.append((e, ob.name, o_mn, o_mx))
    bad.sort(reverse=True)
    for e, nm, a, b in bad[:limit]:
        print(f"  OUTSIDE by {e:+.4f}  {nm:44s} "
              f"x=[{a[0]:.3f},{b[0]:.3f}] y=[{a[1]:.3f},{b[1]:.3f}]", flush=True)
    return bad


def assert_footprint(mn, mx, label):
    fx, fy = PL.FOOT_X, PL.FOOT_Y
    tol = 1e-4
    bad = []
    if mn[0] < -fx - tol:
        bad.append(f"x min {mn[0]:.4f} < {-fx}")
    if mx[0] > fx + tol:
        bad.append(f"x max {mx[0]:.4f} > {fx}")
    if mn[1] < -fy - tol:
        bad.append(f"y min {mn[1]:.4f} < {-fy}")
    if mx[1] > fy + tol:
        bad.append(f"y max {mx[1]:.4f} > {fy}")
    if bad:
        raise AssertionError(f"FOOTPRINT VIOLATION [{label}]: " + "; ".join(bad))
    return True


def texture_records():
    meta_path = os.path.join(TEX, "textures.json")
    recs = {}
    if os.path.exists(meta_path):
        meta = json.load(open(meta_path))
        for fn, rec in meta.get("textures", {}).items():
            recs[fn] = {"sha256": rec["sha256"], "bytes": rec["bytes"],
                        "resolution": rec["res"]}
    return recs


def main():
    os.makedirs(os.path.join(ROOT, "build"), exist_ok=True)
    os.makedirs(os.path.join(ROOT, "build", "checkpoints"), exist_ok=True)
    print("=" * 72)
    print("SCHEME E -- Valley Market.  Coordinate contract:")
    PL.assert_contract(verbose=True)
    print("=" * 72)

    report = {"stage": STAGE, "scheme": "E synthesis (see ALTERNATIVES.md)",
              "params": {k: (round(v, 5) if isinstance(v, float) else v)
                         for k, v in P.items()},
              "lods": {}}

    for lod in LODS:
        joined, _ = build_scene(lod, with_props=False)
        bake_wear(joined, lod)
        tris = M.tri_count(joined)
        mats = sorted({s.material.name for o in joined for s in o.material_slots
                       if s.material})
        mn, mx = bounds(joined)
        assert_footprint(mn, mx, f"lod{lod}")
        out = os.path.join(ROOT, "build", f"market_house_lod{lod}.glb")
        if not NO_EXPORT:
            export_glb(out, animate=True)
        limit = (90000, 45000, 20000)[lod]
        report["lods"][f"lod{lod}"] = {
            "file": os.path.basename(out), "triangles": tris,
            "triangle_budget": limit, "within_budget": tris <= limit,
            "materials": mats, "material_count": len(mats),
            "objects": sorted(o.name for o in joined),
            "bounds_authoring_m": {"min": [round(v, 4) for v in mn],
                                   "max": [round(v, 4) for v in mx]},
            "size_m": {"x": round(mx[0] - mn[0], 4), "y_up": round(mx[2] - mn[2], 4),
                       "z_front": round(mx[1] - mn[1], 4)},
            "bytes": os.path.getsize(out),
            "sha256": hashlib.sha256(open(out, "rb").read()).hexdigest()}
        print(f"[lod{lod}] tris={tris}/{limit} mats={len(mats)} "
              f"size={os.path.getsize(out) / 1024:.0f}KB "
              f"bounds x=[{mn[0]:.3f},{mx[0]:.3f}] y=[{mn[1]:.3f},{mx[1]:.3f}] "
              f"z=[{mn[2]:.3f},{mx[2]:.3f}]", flush=True)
        if lod == 0:
            for ob in joined:
                M.uv_second_bake_layer(ob, margin=0.02)
            bpy.ops.wm.save_as_mainfile(
                filepath=os.path.join(ROOT, "build", "checkpoints",
                                      f"market_house_checkpoint_01_{STAGE}_lod0.blend"))

    # ---------------- furnished reference build (LOD0 + allowed loose props)
    if NO_EXPORT:
        print("NO_EXPORT: stopping before the furnished build")
        print("BUILD_OK")
        return
    joined, props = build_scene(0, with_props=True)
    bake_wear(joined, 0)
    strip_prop_colors(props)
    boxes = collision_boxes()
    issues, clearance = verify_clearance(boxes)
    out = os.path.join(ROOT, "build", "market_house_furnished.glb")
    export_glb(out, animate=True)
    all_mesh = [o for o in bpy.data.objects if o.type == 'MESH']
    report["furnished"] = {
        "file": os.path.basename(out), "bytes": os.path.getsize(out),
        "sha256": hashlib.sha256(open(out, "rb").read()).hexdigest(),
        "triangles_with_props": M.tri_count(all_mesh)}
    report["props"] = prop_records()
    report["props_omitted"] = [
        {"file": f"{REL}/{n}.glb", "reason": "no .provenance.json in the runtime "
         "library; ALLOWED_PROPS.md requires omission rather than silent acceptance"}
        for n in ("stall_vendor", "crate_cargo_heavy", "barrel_ribbed", "barrel_scav",
                  "battery_pack_industrial", "aircon_rooftop", "antenna_comms",
                  "tank_water_frontier")]
    report["collision"] = {
        "schema": "successor.structure-collision.v3",
        "space": "asset-local metres, glTF axes (+Y up, +Z public front)",
        "box_count": len(boxes), "boxes": boxes,
        "clearance_checks": clearance, "clearance_issues": issues}
    report["door"] = {
        "node": "door_slide", "node_parent": None,
        "movable_child": "door_slide__leaf",
        "local_axis": "X", "closed_local_x_m": 0.0,
        "open_local_x_m": round(P["travel"], 4),
        "travel_abs_m": round(abs(P["travel"]), 4),
        "direction": "opens toward -X (asset west) in local space",
        "clips": ["door_open", "door_close"], "clip_seconds": 0.8, "fps": 30,
        "frames": [0, 24],
        "leaf_size_m": [P["leaf_w"], P["leaf_h"], P["leaf_t"]],
        "opening_size_m": [P["door_w"], P["door_h"]]}
    report["contract"] = {
        "footprint_max_m": list(PL.MAX_FOOTPRINT),
        "grid": {"cols": PL.COLS, "rows": PL.ROWS, "cell_m": PL.CELL,
                 "origin": "zero-based from the north-west corner"},
        "fixture_cells": {k: {"cell": list(PL.FIXTURE_CELLS[k]),
                              "gltf_xz": [round(GCELLS[k][0], 4),
                                          round(GCELLS[k][1], 4)],
                              "authoring_xy": [round(CELLS[k][0], 4),
                                               round(CELLS[k][1], 4)]}
                          for k in PL.FIXTURE_CELLS},
        "approach_cells": {k: list(v) for k, v in PL.APPROACH.items()},
        "cutaway_prefixes": list(PREFIXES),
        "floor_top_m": PL.FLOOR_TOP,
        "interior_bounds_authoring_m": {
            "hall": {"x": [-P["ix"], P["ix"]], "y": [P["sy_in"], P["bulk_y0"]],
                     "ceiling_z": [round(ceil_s(P["bulk_y0"]) - CEIL_LINER, 3),
                                   round(ceil_s(P["sy_in"]) - CEIL_LINER, 3)]},
            "back_of_house": {"x": [-P["ix"], P["ix"]],
                              "y": [P["niche_y1"], P["ny_in"]],
                              "ceiling_z": BOH_SOFFIT},
            "trainer_bay": {"x": [P["tr_x0"] + P["wt"], P["ix"]],
                            "y": [P["tr_y"] + P["wt"], P["sy_in"]],
                            "ceiling_z": BAY_CEIL}}}
    report["textures"] = texture_records()
    report["roof"] = {
        "type": "asymmetric butterfly, valley over the service wall",
        "south_plane_pitch_pct": round(100 * (P["z_eave_s"] - P["z_val"]) /
                                       (P["val_y"] - P["y_eave_s"]), 2),
        "north_plane_pitch_pct": round(100 * (P["z_eave_n"] - P["z_cler"]) /
                                       (P["y_eave_n"] - P["val_y"]), 2),
        "clerestory_height_m": round(P["z_cler"] - P["deck_t"] - P["z_val"], 3),
        "skyline_heights_m": {"windcatcher": 6.60, "cistern_drum": 6.18,
                              "flue": round(P["flue_top"] + 0.37, 2),
                              "entry_hood_apex": round(P["hood_apex"], 2),
                              "south_eave": P["z_eave_s"], "north_eave": P["z_eave_n"]}}

    bpy.ops.wm.save_as_mainfile(
        filepath=os.path.join(ROOT, "build", f"market_house_{STAGE}.blend"))
    json.dump(report, open(os.path.join(ROOT, "build", "build_report.json"), "w"),
              indent=1)
    json.dump({"schema": "successor.structure-collision.v3",
               "asset": "market_house_lod0.glb",
               "space": "asset-local metres, glTF axes (+Y up, +Z public front)",
               "generated_by": "src/build_market.py",
               "boxes": boxes},
              open(os.path.join(ROOT, "build", "market_house.collision.json"), "w"),
              indent=1)
    print("CLEARANCE_ISSUES:", issues if issues else "none")
    for c in clearance:
        print(f"  {'OK  ' if c['clear'] else 'FAIL'} {c['check']}")
    print("BUILD_OK")


main()
