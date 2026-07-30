"""Deterministic generator -- SCHEME E: "Valley Market".

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
from mathutils import Matrix, Vector

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
    # trainer bay: deepened from -3.72 to -4.06 so the consultation booth can
    # hold a table and two usable seats (pass-3 review defect 3).  The three
    # south setbacks stay unequal -- hood -4.16, bay -4.06, loggia -3.98.
    tr_x0=2.72, tr_y=-4.06, tr_top=2.94,
    # --- service wall / niches
    bulk_y0=1.85, bulk_th=0.34, niche_y1=2.32, niche_w=1.34, niche_h=2.30,
    niche_back_t=0.13,                  # pocket back slab; thin, to widen the BOH
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

# ---------------------------------------------------------------------------
# TRAINER CONSULTATION BOOTH (pass-3 review defect 3)
# ---------------------------------------------------------------------------
# Authored as explicit rectangles so the fitout, the collision proxies, the
# seat placement and the clearance proofs all read the SAME numbers.
#   table     -- at the bay mouth, reachable from the hall, seats on both sides
#   credenza  -- waist height, in the bay's dead south-west corner only
#   seated    -- the volume a seated person occupies, proven clear
#   standing  -- the customer's standing approach at the table's north edge
TRN = dict(
    tx0=3.50, tx1=4.90, ty0=-2.92, ty1=-2.50,        # consultation table
    cx0=3.10, cx1=3.86, cy0=-3.66, cy1=-3.34,        # credenza (bay SW corner)
    trainer_seat=(4.30, -3.30, 180.0),               # behind the table, facing +N
    visitor_seat=(3.43, -2.14, 0.0),                 # drawn up to the table, N side
    seated_clear_h=1.30,                             # head height when seated
    stand_y0=-2.44, stand_y1=-1.94,                  # standing approach band
)


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


# PER-MATERIAL tile scale (pass-3 review defect 7).  These are read from the
# texture library's own MATERIAL_SCALE table rather than restated here, so the
# scale a tile was DESIGNED for and the scale it is PROJECTED at cannot drift
# apart.  Every material used to sit on the same 2.0 m tile, which is why
# screed, sinter and ceramic all read as one grain.
def _tile_scales():
    import json as _j
    meta = os.path.join(TEX, "textures.json")
    with open(meta) as fh:
        ms = _j.load(fh)["material_scale"]
    return {f"MKT_{k}": v["tile_m"] for k, v in
            (("Sinter", ms["sinter"]), ("Ceramic", ms["ceramic"]),
             ("Plaster", ms["plaster"]), ("Screed", ms["screed"]),
             ("RoofMetal", ms["roofmetal"]), ("Steel", ms["steel"]),
             ("Brass", ms["brass"]))}


TILES = _tile_scales()


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


# ---------------------------------------------------------------------------
# PUNCHED-OPENING ASSEMBLIES (pass-3 review defect 5, second and larger cause)
# ---------------------------------------------------------------------------
# `shell_wall` cuts openings through the plinth/band/skin bands, but only the
# vendor shopfront ever had anything PUT IN one.  The south daylight slot, both
# west high slots, both BOH windows, the trainer bay window and all three rear
# vents were left as literal holes in the envelope, which is why 03_left,
# 04_right and 16 showed "tall black gaps where side/front/rear systems fail to
# close".  They failed to close because nothing was ever authored to close
# them.  Every opening now receives a complete assembly with real depth:
# external surround, set-back glazing frame with rebate, glass, mullions where
# the span needs one, an external sill that projects and drips, and an internal
# liner.  Vents get blade louvres over a dark backing plate, so they read as
# serviced equipment rather than as a void.
def rot_about(ob, pivot, axis, deg):
    """Rotate an object's MESH DATA about `pivot`.

    mlib bakes world coordinates into the mesh and leaves every object at the
    identity transform, so setting `rotation_euler` rotates about the WORLD
    origin and throws the part across the site.  That is what happened to the
    louvre blades (up to 0.68 m outside the footprint) and, silently, to the
    fanlight bars, which is why only the vertical one appeared in the hood
    crop.  Transforming the mesh data about the part's own pivot is correct.
    """
    R = Matrix.Rotation(math.radians(deg), 4, axis)
    T = Matrix.Translation(Vector(pivot))
    ob.data.transform(T @ R @ T.inverted())
    return ob


def _wp(axis, u, t, z):
    """(along-wall u, across-thickness t, z) -> authoring (x, y, z)."""
    return (u, t, z) if axis == 1 else (t, u, z)


def _ws(axis, du, dt, dz):
    return (du, dt, dz) if axis == 1 else (dt, du, dz)


def window_assembly(name, axis, sign, outer, u0, u1, z0, z1, group,
                    sill=True, brow=False):
    """A complete glazed opening: surround, frame, glass, mullions, sill, liner."""
    p, o = P, []
    inner = outer - sign * p["wt"]
    uc, uw = (u0 + u1) / 2.0, u1 - u0
    zc, zh = (z0 + z1) / 2.0, z1 - z0
    tg = outer - sign * 0.12                      # glazing plane, set back
    # 1. external surround -- a picture frame standing 25 mm off the face
    for nm, cz, dz in (("head", z1 + 0.045, 0.09), ("cill", z0 - 0.045, 0.09)):
        o.append(B(f"{name}_sur_{nm}", MAT["brass"],
                   _wp(axis, uc, outer - sign * 0.0125, cz),
                   _ws(axis, uw + 0.18, 0.055, dz), bev=0.005, group=group, lod=1))
    for s in (-1, 1):
        o.append(B(f"{name}_sur_jamb_{s}", MAT["brass"],
                   _wp(axis, uc + s * (uw / 2 + 0.045), outer - sign * 0.0125, zc),
                   _ws(axis, 0.09, 0.055, zh + 0.18), bev=0.005, group=group, lod=1))
    # 2. glazing frame with a real rebate, set back 0.12 into the reveal
    for nm, cz, dz in (("head", z1 - 0.035, 0.07), ("cill", z0 + 0.035, 0.07)):
        o.append(B(f"{name}_frm_{nm}", MAT["steel"], _wp(axis, uc, tg, cz),
                   _ws(axis, uw, 0.09, dz), bev=0.004, group=group, lod=1))
    for s in (-1, 1):
        o.append(B(f"{name}_frm_jamb_{s}", MAT["steel"],
                   _wp(axis, uc + s * (uw / 2 - 0.035), tg, zc),
                   _ws(axis, 0.07, 0.09, zh - 0.14), bev=0.004, group=group, lod=1))
    # 3. GLASS -- lod 2 so the opening is still closed at the lowest LOD
    o.append(B(f"{name}_glass", MAT["glass"], _wp(axis, uc, tg, zc),
               _ws(axis, uw - 0.05, 0.018, zh - 0.05), group=group, lod=2))
    # 4. mullions where the span asks for one (never a repeated grid)
    nmul = max(0, int(uw / 0.62))
    for i in range(nmul):
        mu = u0 + uw * (i + 1) / (nmul + 1)
        o.append(B(f"{name}_mullion_{i}", MAT["steel"], _wp(axis, mu, tg, zc),
                   _ws(axis, 0.045, 0.10, zh - 0.10), bev=0.004, group=group, lod=1))
    # 5. external sill: projects past the face and throats, so it drips clear
    if sill:
        o.append(B(f"{name}_sill", MAT["brass"],
                   _wp(axis, uc, outer + sign * 0.045, z0 - 0.055),
                   _ws(axis, uw + 0.22, 0.14, 0.055), bev=0.006, group=group, lod=1))
        o.append(B(f"{name}_sill_drip", MAT["brass"],
                   _wp(axis, uc, outer + sign * 0.10, z0 - 0.095),
                   _ws(axis, uw + 0.22, 0.035, 0.045), bev=0.004, group=group,
                   lod=1))
    # 6. brow / hood over openings that face the sun
    if brow:
        o.append(B(f"{name}_brow", MAT["steel"],
                   _wp(axis, uc, outer + sign * 0.085, z1 + 0.135),
                   _ws(axis, uw + 0.34, 0.22, 0.06), bev=0.005, group=group, lod=1))
        for s in (-1, 1):
            o.append(B(f"{name}_brow_stay_{s}", MAT["steel"],
                       _wp(axis, uc + s * (uw / 2 + 0.10), outer + sign * 0.05,
                           z1 + 0.065),
                       _ws(axis, 0.035, 0.14, 0.10), bev=0.004, group=group, lod=1))
    # 7. internal liner, so the reveal reads as a built opening from inside
    o.append(B(f"{name}_liner_head", MAT["ceramic"],
               _wp(axis, uc, inner + sign * 0.025, z1 - 0.022),
               _ws(axis, uw + 0.06, 0.05, 0.045), bev=0.004, group=group, lod=1))
    o.append(B(f"{name}_liner_cill", MAT["ceramic"],
               _wp(axis, uc, inner + sign * 0.025, z0 + 0.022),
               _ws(axis, uw + 0.06, 0.05, 0.045), bev=0.004, group=group, lod=1))
    return o


def louvre_assembly(name, axis, sign, outer, u0, u1, z0, z1, group, blades=5):
    """A vent opening filled with weather blades over a dark backing plate."""
    p, o = P, []
    inner = outer - sign * p["wt"]
    uc, uw = (u0 + u1) / 2.0, u1 - u0
    zc, zh = (z0 + z1) / 2.0, z1 - z0
    # backing plate: the visible backing the review asks for -- a vent is not a
    # hole, it is a serviced closure with mesh behind it
    o.append(B(f"{name}_backing", MAT["seal"],
               _wp(axis, uc, inner + sign * 0.03, zc),
               _ws(axis, uw + 0.02, 0.03, zh + 0.02), group=group, lod=2))
    o.append(B(f"{name}_mesh", MAT["steel"], _wp(axis, uc, inner + sign * 0.065, zc),
               _ws(axis, uw - 0.02, 0.012, zh - 0.02), group=group, lod=1))
    # blade set, tilted to shed sand and rain
    tb = outer - sign * 0.055
    for i in range(blades):
        bz = z0 + (i + 0.5) * zh / blades
        b = B(f"{name}_blade_{i}", MAT["steel"], _wp(axis, uc, tb, bz),
              _ws(axis, uw - 0.03, 0.10, 0.030), bev=0.004, group=group, lod=1)
        o.append(rot_about(b, _wp(axis, uc, tb, bz), 'X' if axis == 1 else 'Y',
                           -32.0 if axis == 1 else 32.0))
    # frame around the blades
    for nm, cz, dz in (("head", z1 - 0.022, 0.045), ("cill", z0 + 0.022, 0.045)):
        o.append(B(f"{name}_frm_{nm}", MAT["steel"], _wp(axis, uc, tb, cz),
                   _ws(axis, uw, 0.12, dz), bev=0.004, group=group, lod=1))
    for s in (-1, 1):
        o.append(B(f"{name}_frm_jamb_{s}", MAT["steel"],
                   _wp(axis, uc + s * (uw / 2 - 0.022), tb, zc),
                   _ws(axis, 0.045, 0.12, zh - 0.09), bev=0.004, group=group, lod=1))
    return o


def build_openings():
    """Every punched opening in the envelope, closed with a real assembly."""
    p, o = P, []
    # south daylight slot band (over the hall, west of the entry)
    o += window_assembly("wall_front__win_slot_s", 1, -1, p["sy"], -4.10, -2.60,
                         2.62, 3.30, "F", brow=True)
    # west high slots: two unequal openings lighting the hall
    for i, (a, b) in enumerate(((-2.30, -1.70), (-0.70, -0.10))):
        o += window_assembly(f"wall_left__win_slot_w{i}", 0, -1, -p["mx"], a, b,
                             2.62, 3.30, "L")
    # BOH windows, both flanks, at working height over the staff aisle
    o += window_assembly("wall_left__win_boh", 0, -1, -p["mx"], 2.55, 3.05,
                         1.50, 2.30, "L")
    o += window_assembly("wall_right__win_boh", 0, +1, p["mx"], 2.55, 3.05,
                         1.50, 2.30, "R")
    # trainer bay window: the booth's own daylight, on the deepened bay wall
    o += window_assembly("wall_front__win_bay", 1, -1, p["tr_y"], 3.55, 4.95,
                         0.95, 2.30, "F", brow=True)
    # rear vents: each one closed with blades over dark backing
    o += louvre_assembly("wall_back__vent_storage", 1, +1, p["ny"], -4.55, -3.35,
                         2.72, 3.34, "B", blades=5)
    o += louvre_assembly("wall_back__vent_tank", 1, +1, p["ny"], 1.95, 2.75,
                         2.05, 2.62, "B", blades=4)
    o += louvre_assembly("wall_back__vent_gear", 1, +1, p["ny"], 3.85, 4.85,
                         2.86, 3.30, "B", blades=4)
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
    # The bay's west wall.  It was authored with sign +1, which put the wall
    # body at x 2.38..2.72 -- OUTSIDE the bay, standing in the entry apron with
    # its finished face turned inward, and 0.34 m away from its own collision
    # proxy (`shell__bay_west`, x 2.72..3.06) and from the bay screed.  sign is
    # -1: outward normal west, body 2.72..3.06.  It now also runs north to the
    # interior face so it forms the portal's west jamb instead of leaving a
    # 0.34 m square notch at the re-entrant corner.
    o += shell_wall("wall_right__bay_w_", 0, -1, p["tr_x0"], p["tr_y"], p["sy_in"],
                    p["tr_top"], group="R")
    o += build_corner_joints()
    o += build_openings()
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


# ---------------------------------------------------------------------------
# ENVELOPE CORNER JOINTS (pass-3 review defect 5)
# ---------------------------------------------------------------------------
# `shell_wall` insets the ceramic skin 0.07 m behind each wall's outer plane
# (the tectonic step between the heavy sinter base and the light panel skin).
# Where two walls meet at an outside corner, each skin runs to the OTHER wall's
# outer plane, so a 0.07 x 0.07 m vertical shaft was left open from the datum
# band up to the gable -- 0.82 m tall on the flanks, 0.38 m on the bay.  Those
# are the "tall black corner voids" in 03_left, 04_right and
# 16_crop_uv_seam_corner: they read as missing geometry because they ARE
# missing geometry.
#
# They are not simply filled.  The panel system needs a corner condition, so
# one is authored: a sealing backing block, a folded closure angle lapping both
# skin faces, a head flashing that terminates the joint under the verge, and a
# projecting sill with a weep so the joint drains onto the datum band instead
# of into the wall.  Depth is real: 0.07 m of backing, 0.008 m of proud metal.
CORNER_QUIRK = 0.07          # skin inset, and therefore the joint width


def corner_joint(name, xc, yc, sx, sy, z1, group):
    """One authored corner joint at (xc, yc); sx/sy are the outward signs."""
    p, o = P, []
    q = CORNER_QUIRK
    bt, dt = p["base_top"], p["band_top"]

    def spanx(d):
        return (min(xc, xc - sx * d), max(xc, xc - sx * d))

    def spany(d):
        return (min(yc, yc - sy * d), max(yc, yc - sy * d))

    def bx(nm, dx0, dx1, dy0, dy1, z0, zz1, mat, bev=0.006, lod=1):
        ax0, ax1 = sorted((xc - sx * dx0, xc - sx * dx1))
        ay0, ay1 = sorted((yc - sy * dy0, yc - sy * dy1))
        return B(f"{name}_{nm}", mat, ((ax0 + ax1) / 2, (ay0 + ay1) / 2, (z0 + zz1) / 2),
                 (ax1 - ax0, ay1 - ay0, zz1 - z0), bev=bev, group=group, lod=lod)

    # 1. BACKING -- seals the shaft completely, full quirk depth, all LODs.
    # SINTER, not steel: the corner is where the structural core turns, and the
    # panel skin returns into it.  Steel here was both tectonically wrong (a
    # 0.07 m steel post carrying a ceramic rainscreen) and, at 0.042 albedo,
    # dark enough that the joint still read as a void in raking light even
    # though ray casts prove it solid.
    o.append(bx("back", 0.0, q, 0.0, q, dt, z1, MAT["sinter"], bev=0.0, lod=2))
    # 2. CLOSURE ANGLE -- two legs lapping the skin faces, standing 8 mm proud
    o.append(bx("angle_x", q, q + 0.008, 0.0, 0.15, dt + 0.03, z1 - 0.03,
                MAT["brass"], bev=0.003))
    o.append(bx("angle_y", 0.0, 0.15, q, q + 0.008, dt + 0.03, z1 - 0.03,
                MAT["brass"], bev=0.003))
    # 3. HEAD FLASHING -- terminates the joint under the verge/deck above
    o.append(bx("head", -0.03, 0.11, -0.03, 0.11, z1 - 0.035, z1, MAT["brass"],
                bev=0.004))
    # 4. SILL -- sits on the datum band and projects, so water leaves the joint
    o.append(bx("sill", -0.04, 0.13, -0.04, 0.13, dt - 0.018, dt + 0.030,
                MAT["brass"], bev=0.005))
    # 5. WEEP -- the joint drains onto the band, not into the wall
    o.append(CY(f"{name}_weep", MAT["brass"],
                (xc - sx * 0.145, yc - sy * 0.055, dt + 0.006), 0.011, 0.055,
                axis=0, n=8, group=group, lod=1))
    # 6. BAND CORNER -- the brass datum band has its own 0.035 notch; close it
    o.append(B(f"{name}_band_corner", MAT["brass"],
               ((spanx(-0.035)[0] + spanx(-0.035)[1]) / 2,
                (spany(-0.035)[0] + spany(-0.035)[1]) / 2, (bt + dt) / 2),
               (0.035, 0.035, dt - bt), bev=0.004, group=group, lod=1))
    return o


def build_corner_joints():
    """Every outside corner of the envelope, sealed and expressed."""
    p, o = P, []
    # (name, xc, yc, sx, sy, z1, group).  z1 is the height at which the corner
    # is taken over by the gable, verge or bay deck above.
    corners = [
        ("wall_left__corner_sw", -p["mx"], p["sy"], -1, -1, 3.40, "L"),
        ("wall_left__corner_nw", -p["mx"], p["ny"], -1, +1, 3.40, "L"),
        ("wall_right__corner_ne", p["mx"], p["ny"], +1, +1, 3.40, "R"),
        ("wall_right__corner_bay_se", p["mx"], p["tr_y"], +1, -1, 2.96, "R"),
        ("wall_front__corner_bay_sw", p["tr_x0"], p["tr_y"], -1, -1, 2.96, "F"),
        ("wall_front__corner_bay_re", p["tr_x0"], p["sy"], -1, -1, 2.96, "F"),
    ]
    for (nm, xc, yc, sx, sy, z1, grp) in corners:
        o += corner_joint(nm, xc, yc, sx, sy, z1, grp)
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
    # PASS-3 REVIEW DEFECT 6.  The hood is the identity element and must
    # survive a close crop; `13_crop_facade_hood` showed obvious faceting.
    # Two causes, both fixed here: 20 segments over a half turn is a 9 deg
    # facet (a 0.30 m chord at r=1.90), and every face was FLAT shaded, so
    # each facet read as its own tone.  48 segments gives a 3.75 deg / 0.124 m
    # facet, and M.smooth() interpolates normals across the barrel while
    # keeping the cut ends and the springing crease sharp.
    seg = 48 if DETAIL else 12
    # --- the vault shell: a real arched tunnel, not an applied outline
    shell = M.arc_pts(cx, spr, ro, 0.0, math.pi, seg, r_in=ri)
    o.append(M.smooth(PR("wall_front__hood_shell", MAT["ceramic"], shell, 1, y0, y1,
                         bev=0.010, group="F"), 30.0))
    # --- side piers carrying the vault down to the ground
    for s in (-1, 1):
        o.append(B(f"wall_front__hood_pier_{s}", MAT["sinter"],
                   (cx + s * (ri + ro) / 2, (y0 + y1) / 2, (p["floor_top"] + spr) / 2),
                   (ro - ri, y1 - y0, spr - p["floor_top"]), bev=0.014, group="F"))
    # --- deep brass reveal on the outer face: a modelled order, not a thin line
    o.append(M.smooth(PR("wall_front__hood_face", MAT["brass"],
                         M.arc_pts(cx, spr, ro, 0.0, math.pi, seg, r_in=ro - 0.16),
                         1, y0 - 0.055, y0 + 0.075, bev=0.008, group="F"), 30.0))
    for s in (-1, 1):
        o.append(B(f"wall_front__hood_facepier_{s}", MAT["brass"],
                   (cx + s * (ro - 0.08), y0 + 0.010, (p["floor_top"] + spr) / 2),
                   (0.16, 0.13, spr - p["floor_top"]), bev=0.008, group="F"))
    # inner soffit reveal, so the throat reads deep from outside
    o.append(M.smooth(PR("wall_front__hood_soffit", MAT["brass"],
                         M.arc_pts(cx, spr, ri + 0.09, 0.0, math.pi, seg, r_in=ri),
                         1, y0 + 0.16, y1, group="F", lod=1), 30.0))
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
    o.append(M.smooth(PR("wall_front__fan_glass", MAT["glass"],
                         M.arc_pts(cx, spr, ri - 0.02, 0.0, math.pi, seg), 1,
                         p["sy"] + 0.02, p["sy"] + 0.06, group="F"), 30.0))
    o.append(B("wall_front__fan_sill", MAT["steel"], (cx, p["sy"] + 0.04, spr),
               (2 * ri, 0.10, 0.09), bev=0.006, group="F"))
    for k, a in enumerate((math.radians(52), math.radians(90), math.radians(128))):
        piv = (cx + math.cos(a) * (ri / 2), p["sy"] + 0.04,
               spr + math.sin(a) * (ri / 2))
        o.append(B(f"wall_front__fan_bar_{k}", MAT["steel"], piv,
                   (0.055, 0.075, ri - 0.06), bev=0.004, group="F",
                   phase=(0, 0, math.degrees(a))))
        rot_about(o[-1], piv, 'Y', 90.0 - math.degrees(a))
    # --- HOOD JUNCTIONS, GLAZING FRAME, DRAINAGE, WALL PENETRATION
    # (pass-3 review defect 6 asks for these by name).
    # 1. the fanlight is a framed assembly, not a floating glass sheet:
    #    a rebated outer frame following the arch, on the same 48 segments.
    o.append(M.smooth(PR("wall_front__fan_frame", MAT["steel"],
                         M.arc_pts(cx, spr, ri + 0.005, 0.0, math.pi, seg,
                                   r_in=ri - 0.075),
                         1, p["sy"] - 0.010, p["sy"] + 0.085, bev=0.004,
                         group="F", lod=1), 30.0))
    o.append(M.smooth(PR("wall_front__fan_stop", MAT["brass"],
                         M.arc_pts(cx, spr, ri - 0.055, 0.0, math.pi, seg,
                                   r_in=ri - 0.080),
                         1, p["sy"] + 0.062, p["sy"] + 0.082, group="F", lod=1),
                      30.0))
    # 2. WALL PENETRATION: the vault passes through the south wall, so the
    #    junction is expressed as a returned reveal rather than two solids
    #    intersecting.  A lining follows the arch through the wall thickness.
    o.append(M.smooth(PR("wall_front__hood_lining", MAT["ceramic"],
                         M.arc_pts(cx, spr, ri + 0.055, 0.0, math.pi, seg, r_in=ri),
                         1, p["sy"], p["sy_in"], group="F", lod=1), 30.0))
    o.append(M.smooth(PR("wall_front__hood_penetration_ring", MAT["brass"],
                         M.arc_pts(cx, spr, ri + 0.10, 0.0, math.pi, seg,
                                   r_in=ri + 0.045),
                         1, p["sy_in"] - 0.035, p["sy_in"] + 0.005, group="F",
                         lod=1), 30.0))
    # 3. DRAINAGE: the vault's outer face sheds onto a throated drip at the
    #    springing, which discharges through two spouts clear of the piers.
    for s in (-1, 1):
        o.append(B(f"wall_front__hood_drip_{s}", MAT["brass"],
                   (cx + s * (ri + ro) / 2, y0 - 0.045, spr + 0.115),
                   (ro - ri + 0.20, 0.10, 0.055), bev=0.005, group="F", lod=1))
        # the drip discharges into a downpipe run down the OUTER face of each
        # pier (a forward spout would have projected past the authored
        # footprint), ending in a shoe that spills onto the apron nosing
        dx_ = cx + s * (ro - 0.245)
        o.append(M.smooth(CY(f"wall_front__hood_hopper_{s}", MAT["brass"],
                             (dx_, y0 + 0.055, spr + 0.055), 0.075, 0.13, n=14,
                             r2=0.045, group="F", lod=1), 38.0))
        o.append(M.smooth(CY(f"wall_front__hood_downpipe_{s}", MAT["brass"],
                             (dx_, y0 + 0.055, (p["floor_top"] + spr) / 2 + 0.10),
                             0.042, spr - p["floor_top"] - 0.10, n=12, group="F",
                             lod=1), 38.0))
        for kk, zz in enumerate((0.72, 1.68)):
            o.append(B(f"wall_front__hood_pipe_clip_{s}_{kk}", MAT["steel"],
                       (dx_, y0 + 0.055, zz), (0.11, 0.055, 0.045), bev=0.004,
                       group="F", lod=1))
        o.append(M.smooth(CY(f"wall_front__hood_shoe_{s}", MAT["brass"],
                             (dx_, y0 + 0.055, p["floor_top"] + 0.145), 0.055, 0.19,
                             n=12, r2=0.042, group="F", lod=1), 38.0))
        o.append(B(f"wall_front__hood_spill_{s}", MAT["sinter"],
                   (dx_, y0 + 0.055, p["floor_top"] + 0.015), (0.28, 0.28, 0.05),
                   bev=0.010, group="F", lod=1))
        # 4. the springing junction gets a real impost block, so the curve
        #    lands on the pier instead of merging into it
        o.append(B(f"wall_front__hood_impost_{s}", MAT["sinter"],
                   (cx + s * (ri + ro) / 2, (y0 + y1) / 2, spr - 0.135),
                   (ro - ri + 0.16, y1 - y0 + 0.06, 0.13), bev=0.010, group="F"))
        o.append(B(f"wall_front__hood_impost_lip_{s}", MAT["brass"],
                   (cx + s * (ri + ro) / 2, y0 - 0.045, spr - 0.135),
                   (ro - ri + 0.20, 0.05, 0.045), bev=0.004, group="F", lod=1))
    # 5. the head of the arch meets the eave: a flashed saddle, since the hood
    #    apex (4.60) breaks the south eave line (4.42)
    o.append(B("wall_front__hood_saddle", MAT["brass"], (cx, p["sy"] + 0.02, 4.425),
               (2 * ro - 0.30, p["wt"] + 0.10, 0.05), bev=0.005, group="F", lod=1))
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
    # loggia lighting: a warm line in the deck washing the shopfront, PLUS a
    # recessed downlight in each coffer.  The pass-3 review found
    # `20_crop_loggia` did not show the coffers it claimed; the reason was not
    # only the camera -- the coffered soffit is north-facing and had a single
    # lamp 1.3 m away from either coffer, so the pans were lit by sky bounce
    # alone.  A coffered soffit with recessed downlights is also simply what
    # this element should be.
    o.append(B("wall_front__log_lamp", MAT["lamp"], (-4.20, p["sy"] - 0.30, top - 0.10),
               (2.20, 0.11, 0.015), group="F"))
    for i in range(len(LOG_PIERS) - 1):
        x0 = LOG_PIERS[i][0] + LOG_PIERS[i][1] * 0.5
        x1 = LOG_PIERS[i + 1][0] - LOG_PIERS[i + 1][1] * 0.5
        cxc, cyc = (x0 + x1) / 2, (ly + p["sy"]) / 2
        # The coffer pan's underside is at top-0.225.  The luminaire has to
        # sit BELOW it or the emissive face is enclosed in plaster and emits
        # into the inside of the pan -- which is exactly what the first
        # attempt did, giving an unlit soffit in `20_crop_loggia`.
        pan_soffit = top - 0.225
        o.append(B(f"wall_front__log_coffer_housing_{i}", MAT["steel"],
                   (cxc, cyc, top - 0.160), (0.40, 0.30, 0.10), bev=0.008,
                   group="F", lod=1))
        o.append(B(f"wall_front__log_coffer_bezel_{i}", MAT["brass"],
                   (cxc, cyc, pan_soffit - 0.008), (0.44, 0.34, 0.016), bev=0.005,
                   group="F", lod=1))
        o.append(B(f"wall_front__log_coffer_lamp_{i}", MAT["lamp"],
                   (cxc, cyc, pan_soffit - 0.013), (0.34, 0.24, 0.012),
                   group="F"))
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

# ---------------------------------------------------------------------------
# THE RESERVED BACK-OF-HOUSE STAFF ROUTE (pass-3 review defect 2)
# ---------------------------------------------------------------------------
# A declared corridor band running the length of the BOH.  Bulky plant may
# only occupy the PIER ALCOVES south of BOH_ROUTE_Y0 (where the service wall
# has no niche pocket) or the strip north of BOH_ROUTE_Y1 against the rear
# wall.  0.90 m is the width the review gate requires; the band is 0.90 m and
# the real clear width is wider almost everywhere, which verify.py measures.
BOH_ROUTE_Y0 = 2.58
BOH_ROUTE_Y1 = 3.48
BOH_ROUTE_MIN_W = 0.90
# The route the gate requires: rear entrance -> BOH aisle -> rear of all three
# service fixtures.  West and east of this span the BOH is working recess, not
# corridor, and is furnished as such; verify.py's sampled path check measures
# the real width along the real route rather than trusting this band.
BOH_ROUTE_X0 = -2.72
BOH_ROUTE_X1 = 3.68
# water-plant columns.  NOT in the alcove between trade and association: that
# alcove overlaps the rear door's x-span (0.725..1.875), which is how the old
# tank came to stand in the doorway.  They go in the alcove between the bank
# and trade niches, which no opening looks through.
BOH_FILTER_X = (-1.19, -0.71)


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

# Each service point projects a DIFFERENT head south of the wall face (pass-3
# review defect 8: "the three service niches differ mostly by imported terminal
# silhouette").  The head also carries the wash lamp in FRONT of the terminal's
# interaction face -- the previous head lamp sat behind it.
#   bank  -- deepest: a private, hooded transaction recess
#   trade -- middle: an open inspection gantry
#   assoc -- shallowest: a public registry brow
DOCK_HEAD_Y = {"bank": 1.50, "trade": 1.58, "assoc": 1.66}
# hardware lives on the PIERS beside each opening (|dx| >= 0.84) and north of
# y = 1.50, which keeps the fixture cell and the 0.8 m front-clearance box
# completely free.  verify_clearance re-proves this every build.
DOCK_SIDE_X = 0.90


def dock_identity(k, cx, y0, hp, ft, nh):
    """Non-repeating service identity: privacy / inspection / registry hardware.

    Everything here is placed on the pier faces or above head height, never in
    the customer approach.  No lettering: shapes and lit slots only.
    """
    o = []
    if k == "bank":
        # PRIVACY: deep hood with side fins, a screened deposit drawer on the
        # west pier, and a discretion line marked in the floor screed.
        for s in (-1, 1):
            o.append(B(f"interior__dock_bank_fin_{s}", MAT["ceramic"],
                       (cx + s * 0.755, (y0 + hp) / 2, ft + 1.62),
                       (0.10, y0 - hp, 1.42), bev=0.008))
            o.append(B(f"interior__dock_bank_fin_edge_{s}", MAT["brass"],
                       (cx + s * 0.755, hp + 0.018, ft + 1.62),
                       (0.115, 0.036, 1.42), bev=0.005, lod=1))
        o.append(B("interior__dock_bank_drawer", MAT["steel"],
                   (cx - DOCK_SIDE_X, y0 - 0.11, ft + 1.02), (0.40, 0.22, 0.30),
                   bev=0.010))
        o.append(B("interior__dock_bank_drawer_pull", MAT["brass"],
                   (cx - DOCK_SIDE_X, y0 - 0.225, ft + 1.02), (0.30, 0.04, 0.05),
                   bev=0.004, lod=1))
        o.append(B("interior__dock_bank_slot", MAT["brass"],
                   (cx - DOCK_SIDE_X, y0 - 0.225, ft + 1.24), (0.26, 0.04, 0.055),
                   bev=0.004, lod=1))
        o.append(B("interior__dock_bank_seal", MAT["cyan"],
                   (cx - DOCK_SIDE_X, y0 - 0.235, ft + 1.42), (0.10, 0.02, 0.10)))
        # ledger ledge on the east pier, to write on while queueing
        o.append(B("interior__dock_bank_ledge", MAT["ceramic"],
                   (cx + DOCK_SIDE_X, y0 - 0.17, ft + 0.96), (0.46, 0.34, 0.05),
                   bev=0.008))
        for s in (-1, 1):
            o.append(B(f"interior__dock_bank_ledge_leg_{s}", MAT["steel"],
                       (cx + DOCK_SIDE_X + s * 0.19, y0 - 0.12, ft + 0.47),
                       (0.045, 0.045, 0.94), bev=0.004, lod=1))
    elif k == "trade":
        # INSPECTION: an open gantry over the counter mouth carrying a hanging
        # scale, a goods rail on the east pier, and a lit inspection strip.
        o.append(CY("interior__dock_trade_gantry", MAT["steel"],
                    (cx, hp + 0.05, ft + nh - 0.10), 0.038, p_niche_w() + 0.50,
                    axis=0, n=12))
        for s in (-1, 1):
            o.append(B(f"interior__dock_trade_gantry_leg_{s}", MAT["steel"],
                       (cx + s * (p_niche_w() / 2 + 0.24), hp + 0.05, ft + nh / 2),
                       (0.06, 0.06, nh - 0.10), bev=0.005))
        o.append(CY("interior__dock_trade_hook", MAT["brass"],
                    (cx + 0.34, hp + 0.05, ft + nh - 0.34), 0.014, 0.46, n=8, lod=1))
        o.append(CY("interior__dock_trade_pan", MAT["brass"],
                    (cx + 0.34, hp + 0.05, ft + nh - 0.60), 0.15, 0.05, n=16,
                    r2=0.11, lod=1))
        # goods rail + weight shelf on the east pier
        o.append(B("interior__dock_trade_shelf", MAT["ceramic"],
                   (cx + DOCK_SIDE_X + 0.05, y0 - 0.15, ft + 0.92), (0.40, 0.30, 0.06),
                   bev=0.008))
        o.append(B("interior__dock_trade_shelf_apron", MAT["sinter"],
                   (cx + DOCK_SIDE_X + 0.05, y0 - 0.11, ft + 0.45), (0.36, 0.22, 0.88),
                   bev=0.010))
        for i, dz in enumerate((0.0, 0.16, 0.30)):
            o.append(CY(f"interior__dock_trade_weight_{i}", MAT["brass"],
                        (cx + DOCK_SIDE_X - 0.13 + i * 0.13, y0 - 0.15,
                         ft + 0.99 + dz * 0.0), 0.045 - i * 0.008,
                        0.10 - i * 0.018, n=12, lod=1))
        # west pier: a lit inspection strip washing the goods being checked
        o.append(B("interior__dock_trade_strip_housing", MAT["steel"],
                   (cx - DOCK_SIDE_X, y0 - 0.09, ft + 1.86), (0.34, 0.16, 0.10),
                   bev=0.006, lod=1))
        o.append(B("interior__dock_trade_strip", MAT["lamp"],
                   (cx - DOCK_SIDE_X, y0 - 0.13, ft + 1.81), (0.28, 0.09, 0.02)))
    else:
        # REGISTRY: a public notice frame on the west pier and a waiting bench
        # on the east pier -- this is the service you wait at, not queue at.
        o.append(B("interior__dock_assoc_notice", MAT["ceramic"],
                   (cx - DOCK_SIDE_X, y0 - 0.055, ft + 1.52), (0.52, 0.05, 0.86),
                   bev=0.008))
        o.append(B("interior__dock_assoc_notice_frame", MAT["brass"],
                   (cx - DOCK_SIDE_X, y0 - 0.078, ft + 1.52), (0.58, 0.03, 0.92),
                   bev=0.005, lod=1))
        for i, (dx_, dz, w, h) in enumerate(((-0.11, 0.24, 0.18, 0.13),
                                             (0.12, 0.20, 0.16, 0.20),
                                             (-0.06, -0.10, 0.22, 0.15),
                                             (0.13, -0.20, 0.14, 0.11))):
            o.append(B(f"interior__dock_assoc_card_{i}", MAT["plaster"],
                       (cx - DOCK_SIDE_X + dx_, y0 - 0.088, ft + 1.52 + dz),
                       (w, 0.012, h), bev=0.003, lod=1))
        o.append(B("interior__dock_assoc_bench", MAT["ceramic"],
                   (cx + DOCK_SIDE_X, y0 - 0.20, ft + 0.45), (0.54, 0.40, 0.07),
                   bev=0.010))
        for s in (-1, 1):
            o.append(B(f"interior__dock_assoc_bench_leg_{s}", MAT["steel"],
                       (cx + DOCK_SIDE_X + s * 0.21, y0 - 0.20, ft + 0.21),
                       (0.06, 0.34, 0.42), bev=0.005, lod=1))
        # a low registry beacon above the bench: this service is found, not queued
        o.append(TU("interior__dock_assoc_beacon", MAT["brass"],
                    (cx + DOCK_SIDE_X, y0 - 0.10, ft + 2.02), 0.13, 0.09, 0.05,
                    axis=1, n=20, lod=1))
        o.append(B("interior__dock_assoc_beacon_lamp", MAT["cyan"],
                   (cx + DOCK_SIDE_X, y0 - 0.105, ft + 2.02), (0.15, 0.02, 0.15)))
    return o


def p_niche_w():
    return P["niche_w"]


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
        nbt = p["niche_back_t"]
        o.append(B(f"interior__niche_{k}_back", MAT["ceramic"],
                   (cx, p["niche_y1"] + nbt / 2, ft + nh / 2),
                   (p["niche_w"] + 0.34, nbt, nh), bev=0.008))
        o.append(B(f"interior__niche_{k}_head", MAT["ceramic"],
                   (cx, (y0 + p["niche_y1"] + nbt) / 2, ft + nh + 0.09),
                   (p["niche_w"] + 0.34, p["niche_y1"] + nbt - y0, 0.18), bev=0.008))
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
        # backing panel: closes the pocket BEHIND the docked terminal.  It sits
        # north of TERM_BACK, so it can never intersect the imported prop.
        o.append(B(f"interior__niche_{k}_panel", MAT["steel"],
                   (cx, p["niche_y1"] - 0.02, ft + nh / 2 + 0.10),
                   (p["niche_w"] - 0.06, 0.04, nh - 0.24), bev=0.006))
        # ---- per-service dock head: projects SOUTH of the wall face so the
        # wash lamp is in front of the terminal's interaction face instead of
        # behind it.  Each service gets a different head, so the three niches
        # are not distinguished only by imported terminal silhouette.
        hp = DOCK_HEAD_Y[k]                       # south face of this head
        hd = y0 - hp                              # projection depth
        o.append(B(f"interior__dock_{k}_head", MAT["ceramic"],
                   (cx, (y0 + hp) / 2, ft + nh + 0.20),
                   (p["niche_w"] + 0.34, hd, 0.22), bev=0.010))
        o.append(B(f"interior__dock_{k}_head_lip", MAT["brass"],
                   (cx, hp + 0.02, ft + nh + 0.09),
                   (p["niche_w"] + 0.36, 0.05, 0.09), bev=0.005, lod=1))
        o.append(B(f"interior__dock_{k}_wash_housing", MAT["steel"],
                   (cx, hp + 0.10, ft + nh + 0.02), (p["niche_w"] - 0.10, 0.17, 0.13),
                   bev=0.008, lod=1))
        o.append(B(f"interior__dock_{k}_wash", MAT["lamp"],
                   (cx, hp + 0.10, ft + nh - 0.035), (p["niche_w"] - 0.20, 0.13, 0.02)))
        # a second lamp in the pocket head, washing the backing panel, so the
        # terminal is read against a lit surface instead of a black hole
        o.append(B(f"interior__niche_{k}_backlight", MAT["lamp"],
                   (cx, p["niche_y1"] - 0.10, ft + nh - 0.03),
                   (p["niche_w"] - 0.30, 0.12, 0.018)))
        o += dock_identity(k, cx, y0, hp, ft, nh)
        # geometric identifier plate above the opening -- no lettering.
        # sits between the dock head top and the cove, clear of both.
        pz = ft + nh + 0.54
        o.append(B(f"interior__sign_{k}_plate", MAT["ceramic"], (cx, y0 - 0.03, pz),
                   (0.96, 0.06, 0.38), bev=0.008, lod=1))
        o.append(B(f"interior__sign_{k}_frame", MAT["brass"], (cx, y0 - 0.048, pz),
                   (1.04, 0.03, 0.46), bev=0.005, lod=1))
        mk = MARKS[k]
        if mk == "bar":
            for i, w in enumerate((0.52, 0.34, 0.16)):
                o.append(B(f"interior__mark_{k}_{i}", MAT["brass"],
                           (cx, y0 - 0.068, pz + 0.10 - i * 0.10), (w, 0.02, 0.045),
                           bev=0.004, lod=1))
        elif mk == "cross":
            for i, (a, b) in enumerate(((0.50, 0.09), (0.09, 0.32))):
                o.append(B(f"interior__mark_{k}_{i}", MAT["brass"], (cx, y0 - 0.068, pz),
                           (a, 0.02, b), bev=0.004, lod=1))
        else:
            o.append(TU(f"interior__mark_{k}_ring", MAT["brass"], (cx, y0 - 0.062, pz),
                        0.17, 0.12, 0.02, axis=1, n=28, lod=1))
            o.append(B(f"interior__mark_{k}_pip", MAT["brass"], (cx, y0 - 0.068, pz),
                       (0.08, 0.02, 0.08), bev=0.003, lod=1))
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
    o.append(B("interior__wall_cove", MAT["steel"], (0, y0 - 0.13, ft + nh + 0.90),
               (2 * ix - 0.20, 0.20, 0.16), bev=0.010, lod=1))
    o.append(B("interior__wall_cove_lamp", MAT["lamp"], (0, y0 - 0.13, ft + nh + 0.82),
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
        # produce bins let into the counter top, each with authored goods --
        # the pass-3 review found the vendor shelves "nearly empty".  The
        # runtime library has no provenance-backed produce props, so the
        # assortment is authored: heaped roots, stacked discs, sacks, jars.
        for i, yy in enumerate((-1.70, -1.05, -0.40)):
            o.append(B(f"interior__vendor_bin_{i}", MAT["steel"], (vx1 - 0.16, yy,
                                                                   ft + 0.955),
                       (0.34, 0.44, 0.10), bev=0.010, lod=1))
        # bin 0: heaped roots (three unequal ellipsoidal clusters)
        for j, (dx_, dy_, rr) in enumerate(((-0.07, -0.11, 0.075),
                                            (0.05, 0.02, 0.088),
                                            (-0.02, 0.13, 0.066))):
            o.append(M.smooth(CY(f"interior__vendor_root_{j}", MAT["sinter"],
                                 (vx1 - 0.16 + dx_, -1.70 + dy_, ft + 1.02), rr,
                                 rr * 1.5, n=12, r2=rr * 0.45, lod=1), 40.0))
        # bin 1: stacked discs, leaning
        for j in range(4):
            o.append(M.smooth(CY(f"interior__vendor_disc_{j}", MAT["brass"],
                                 (vx1 - 0.16 + (j % 2) * 0.09 - 0.045,
                                  -1.05 - 0.14 + j * 0.09, ft + 1.015 + j * 0.012),
                                 0.072, 0.022, n=14, lod=1), 40.0))
        # bin 2: sacks
        for j, (dx_, dy_, w_) in enumerate(((-0.06, -0.10, 0.15), (0.06, 0.04, 0.17),
                                            (-0.03, 0.14, 0.13))):
            o.append(B(f"interior__vendor_sack_{j}", MAT["plaster"],
                       (vx1 - 0.16 + dx_, -0.40 + dy_, ft + 1.07),
                       (w_, w_ * 0.8, 0.20), bev=0.045, lod=1))
        # shelf goods: jars and stacked tins, unequal, on the three shelves
        for i, (h, d, n_) in enumerate(((1.42, 0.40, 6), (1.86, 0.34, 5),
                                        (2.26, 0.28, 4))):
            for j in range(n_):
                yy = (vy0 + vy1) / 2 + (j - (n_ - 1) / 2) * (2.6 / max(n_, 1))
                rr = 0.052 + 0.014 * ((i + j) % 3)
                hh = 0.16 + 0.05 * ((i * 2 + j) % 3)
                o.append(M.smooth(CY(f"interior__vendor_jar_{i}_{j}", MAT["glass"],
                                     (vx0 + d - 0.13, yy, ft + h + 0.022 + hh / 2),
                                     rr, hh, n=12, lod=1), 40.0))
                o.append(M.smooth(CY(f"interior__vendor_jar_lid_{i}_{j}", MAT["brass"],
                                     (vx0 + d - 0.13, yy, ft + h + 0.022 + hh),
                                     rr * 1.06, 0.018, n=12, lod=1), 40.0))
        # goods hanging from the rack hooks
        for i, yy in enumerate((-1.86, -1.34, -0.62, 0.06, 0.42)):
            L = 0.26 + 0.09 * (i % 3)
            o.append(B(f"interior__vendor_hung_{i}", MAT["sinter"],
                       (vx1 - 0.06, yy, ft + 1.96 - L / 2), (0.10, 0.11, L),
                       bev=0.030, lod=1))
        o.append(B("interior__vendor_scale", MAT["brass"], (vx1 - 0.18, 0.36, ft + 1.05),
                   (0.24, 0.24, 0.20), bev=0.010, lod=1))
        # a stacked crate plinth beside the counter, so goods arrive somewhere
        o.append(B("interior__vendor_pallet", MAT["steel"], (vx1 - 0.02, -2.62,
                                                             ft + 0.055),
                   (0.72, 0.62, 0.11), bev=0.008, lod=1))
        o.append(B("interior__vendor_light", MAT["lamp"], (vx0 + 0.34, (vy0 + vy1) / 2,
                                                           ft + 2.72),
                   (0.16, vy1 - vy0 - 0.40, 0.025)))
    # ---------------- trainer consultation booth, in the south-east bay
    #
    # PASS-3 REVIEW DEFECT 3.  The old booth was a 1.70 x 0.42 m desk jammed
    # against a 0.60 m deep bay with a full-height shelf stack and a display
    # case standing in the sightline, so `22_interior_eye_trainer` was mostly
    # occluding partition.  Rebuilt: the bay is deepened to 0.94 m clear, the
    # desk becomes a consultation TABLE at the bay mouth, the trainer sits
    # behind it in the bay, the visitor sits at its west end, and the tall
    # built-ins are demoted to a waist-height credenza in the bay's dead
    # south-west corner so nothing blocks the view in or the approach.
    tcx = (TRN["tx0"] + TRN["tx1"]) / 2
    tcy = (TRN["ty0"] + TRN["ty1"]) / 2
    o.append(B("interior__trainer_table", MAT["ceramic"], (tcx, tcy, ft + 0.72),
               (TRN["tx1"] - TRN["tx0"], TRN["ty1"] - TRN["ty0"], 0.07), bev=0.010))
    for s in (-1, 1):
        o.append(B(f"interior__trainer_leg_{s}", MAT["steel"],
                   (tcx + s * (TRN["tx1"] - TRN["tx0"] - 0.30) / 2, tcy, ft + 0.35),
                   (0.07, TRN["ty1"] - TRN["ty0"] - 0.12, 0.68), bev=0.006))
    o.append(B("interior__trainer_stretcher", MAT["steel"], (tcx, tcy, ft + 0.14),
               (TRN["tx1"] - TRN["tx0"] - 0.34, 0.06, 0.06), bev=0.005, lod=1))
    if DETAIL:
        o.append(B("interior__trainer_edge", MAT["brass"],
                   (tcx, TRN["ty0"] + 0.025, ft + 0.72),
                   (TRN["tx1"] - TRN["tx0"], 0.05, 0.09), bev=0.006, lod=1))
        # route/skill board on the bay back wall + a sconce washing it
        bwy = p["tr_y"] + p["wt"]
        o.append(B("interior__trainer_board", MAT["ceramic"], (4.30, bwy + 0.035, 1.72),
                   (1.86, 0.06, 1.00), bev=0.010))
        o.append(B("interior__trainer_board_frame", MAT["brass"],
                   (4.30, bwy + 0.055, 1.72), (1.98, 0.03, 1.12), bev=0.005, lod=1))
        for i, (dx_, dz) in enumerate(((-0.62, 0.22), (-0.18, -0.14), (0.34, 0.26),
                                       (0.70, -0.06))):
            o.append(B(f"interior__trainer_pin_{i}", MAT["cyan"],
                       (4.30 + dx_, bwy + 0.062, 1.72 + dz), (0.055, 0.02, 0.055)))
        o.append(B("interior__trainer_sconce_housing", MAT["steel"],
                   (4.30, bwy + 0.10, 2.44), (1.40, 0.14, 0.11), bev=0.008, lod=1))
        o.append(B("interior__trainer_sconce", MAT["lamp"], (4.30, bwy + 0.13, 2.38),
                   (1.30, 0.09, 0.025)))
        # waist-height credenza in the bay's south-west corner: storage that
        # cannot occlude the booth, replacing the old full-height shelf stack
        ccx, ccy = (TRN["cx0"] + TRN["cx1"]) / 2, (TRN["cy0"] + TRN["cy1"]) / 2
        o.append(B("interior__trainer_credenza", MAT["sinter"], (ccx, ccy, ft + 0.42),
                   (TRN["cx1"] - TRN["cx0"], TRN["cy1"] - TRN["cy0"], 0.84),
                   bev=0.012))
        o.append(B("interior__trainer_credenza_top", MAT["ceramic"],
                   (ccx, ccy, ft + 0.875),
                   (TRN["cx1"] - TRN["cx0"] + 0.05, TRN["cy1"] - TRN["cy0"] + 0.05,
                    0.07), bev=0.008, lod=1))
        for i in range(2):
            o.append(B(f"interior__trainer_credenza_pull_{i}", MAT["brass"],
                       (ccx + 0.005, TRN["cy0"] - 0.02, ft + 0.30 + i * 0.30),
                       (TRN["cx1"] - TRN["cx0"] - 0.16, 0.04, 0.04), bev=0.004,
                       lod=1))
        o.append(B("interior__trainer_kit", MAT["steel"], (ccx - 0.06, ccy, ft + 0.98),
                   (0.30, 0.22, 0.13), bev=0.010, lod=1))
        # a low shelf on the east wall, above seated head height, plus markers
        o.append(B("interior__bay_shelf_e", MAT["steel"], (ix - 0.17, -3.20, ft + 1.62),
                   (0.30, 1.00, 0.045), bev=0.004, lod=1))
        o.append(B("interior__bay_shelf_e_lip", MAT["brass"], (ix - 0.325, -3.20,
                                                               ft + 1.665),
                   (0.03, 1.00, 0.05), bev=0.004, lod=1))
        for i in range(3):
            o.append(B(f"interior__bay_marker_{i}", MAT["brass"],
                       (p["ix"] - 0.035, -3.35 + i * 0.30, 2.28),
                       (0.03, 0.10, 0.34), bev=0.004, lod=1))
        # booth downlight over the table, so the seats read in the proofs
        o.append(B("interior__trainer_downlight_housing", MAT["steel"],
                   (tcx, tcy, BAY_CEIL - 0.06), (1.30, 0.30, 0.12), bev=0.008, lod=1))
        o.append(B("interior__trainer_downlight", MAT["lamp"], (tcx, tcy,
                                                                BAY_CEIL - 0.125),
                   (1.20, 0.24, 0.02)))
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
    #
    # PASS-3 REVIEW DEFECT 2.  The authored cylindrical tank stood at
    # (2.30, 3.16) r 0.44 -- directly in the rear doorway's approach, leaving
    # 0.22 m between it and the niche backs.  The bench and shelving each ran
    # 0.48-0.62 m deep across the full aisle as well, so the "staff aisle" was
    # not a route at all.  The BOH is rebuilt here as an explicit corridor:
    #
    #   * BOH_ROUTE_Y0/Y1 is a reserved corridor band.  NOTHING may stand in it.
    #   * bulky plant is moved into the PIER ALCOVES -- the four x-bands where
    #     the service wall has no niche pocket, so its face is at bulk_y1 and
    #     there is 0.47 m of extra depth to build into.
    #   * the tank is redesigned as two slim filter columns in an alcove; the
    #     stored-water role it was doing badly is already carried by the roof
    #     cistern drum, which is the building's actual water parti.
    #   * `verify.py` samples a grid and proves a continuous >= 0.90 m route.
    ny_in = p["ny_in"]
    nb = p["niche_y1"] + p["niche_back_t"]          # 2.45 -- niche back face
    # work bench: pier alcove EAST of the association niche
    bx0, bx1 = 4.21, 5.25
    byc = (P["bulk_y1"] + BOH_ROUTE_Y0) / 2       # alcove centre, east of assoc
    bdp = BOH_ROUTE_Y0 - P["bulk_y1"] - 0.02
    o.append(B("interior__boh_bench", MAT["steel"], ((bx0 + bx1) / 2, byc, ft + 0.44),
               (bx1 - bx0, bdp, 0.88), bev=0.010))
    o.append(B("interior__boh_bench_top", MAT["ceramic"], ((bx0 + bx1) / 2, byc,
                                                           ft + 0.915),
               (bx1 - bx0 + 0.06, bdp + 0.04, 0.07), bev=0.008, lod=1))
    # storage stack: pier alcove WEST, between the staff pass and the bank niche
    sx0, sx1 = -4.14, -3.26
    syc = (P["bulk_y1"] + BOH_ROUTE_Y0) / 2       # alcove centre, west of bank
    sdp = BOH_ROUTE_Y0 - P["bulk_y1"] - 0.02
    for i in range(4):
        o.append(B(f"interior__boh_shelf_{i}", MAT["steel"], ((sx0 + sx1) / 2, syc,
                                                              ft + 0.40 + i * 0.56),
                   (sx1 - sx0, sdp, 0.045), bev=0.005, lod=1))
    if DETAIL:
        for s in (-1, 1):
            o.append(B(f"interior__boh_shelf_post_{s}", MAT["steel"],
                       ((sx0 + sx1) / 2 + s * (sx1 - sx0) / 2, syc, ft + 1.10),
                       (0.06, sdp, 2.20), bev=0.005))
        o.append(B("interior__boh_shelf_back", MAT["ceramic"],
                   ((sx0 + sx1) / 2, P["bulk_y1"] + 0.02, ft + 1.16),
                   (sx1 - sx0 + 0.10, 0.04, 2.28), bev=0.006, lod=1))
        # switchgear: turned onto the EAST WALL so it cannot cross the corridor
        o.append(B("interior__boh_switchgear", MAT["steel"], (ix - 0.13, 3.15,
                                                              ft + 0.84),
                   (0.26, 0.80, 1.66), bev=0.010))
        o.append(B("interior__boh_switchgear_door", MAT["brass"], (ix - 0.255, 3.15,
                                                                   ft + 0.92),
                   (0.03, 0.68, 1.34), bev=0.005, lod=1))
        for k in range(3):
            o.append(B(f"interior__boh_led_{k}", MAT["cyan"], (ix - 0.272, 2.86 + k * 0.18,
                                                               ft + 1.52),
                       (0.02, 0.06, 0.05)))
        # --- water plant, RELOCATED out of the rear doorway (defect 2).
        # two slim filter columns standing in the pier alcove between the trade
        # and association niches, with the manifold that feeds them on the wall.
        fy = P["bulk_y1"] + 0.18                   # column axis, inside the alcove
        for i, tx in enumerate(BOH_FILTER_X):
            o.append(CY(f"interior__boh_filter_{i}", MAT["steel"], (tx, fy, ft + 0.92),
                        0.19, 1.72, n=20))
            o.append(TU(f"interior__boh_filter_band_{i}", MAT["brass"],
                        (tx, fy, ft + 1.46), 0.205, 0.185, 0.06, n=20, lod=1))
            o.append(CY(f"interior__boh_filter_foot_{i}", MAT["steel"],
                        (tx, fy, ft + 0.035), 0.20, 0.07, n=20, lod=1))
            o.append(CY(f"interior__boh_filter_riser_{i}", MAT["steel"],
                        (tx, fy, ft + 2.12), 0.045, 0.68, n=10, lod=1))
        o.append(B("interior__boh_manifold", MAT["steel"],
                   (sum(BOH_FILTER_X) / 2, P["bulk_y1"] + 0.06, ft + 1.94),
                   (BOH_FILTER_X[1] - BOH_FILTER_X[0] + 0.30, 0.10, 0.16), bev=0.008,
                   lod=1))
        for i, tx in enumerate(BOH_FILTER_X):
            o.append(CY(f"interior__boh_manifold_drop_{i}", MAT["brass"],
                        (tx, P["bulk_y1"] + 0.06, ft + 1.80), 0.026, 0.28, n=8, lod=1))
        o.append(B("interior__boh_valve_panel", MAT["steel"], (-0.13, nb + 0.06,
                                                               ft + 1.36),
                   (0.34, 0.12, 0.52), bev=0.008, lod=1))
        for i in range(2):
            o.append(CY(f"interior__boh_valve_{i}", MAT["brass"],
                        (-0.19 + i * 0.13, nb + 0.085, ft + 1.46 - i * 0.20), 0.055,
                        0.05, axis=1, n=12, lod=1))
        # service ladder to the roof hatch: stringers flattened against the
        # north wall so the corridor keeps its width past it
        for i in range(9):
            o.append(CY(f"interior__boh_rung_{i}", MAT["steel"], (-2.30, ny_in - 0.075,
                                                                  ft + 0.34 + i * 0.45),
                        0.019, 0.44, axis=0, n=8))
        for s in (-1, 1):
            o.append(B(f"interior__boh_ladder_{s}", MAT["steel"], (-2.30 + s * 0.22,
                                                                   ny_in - 0.055,
                                                                   ft + 2.14),
                       (0.05, 0.11, 4.20), bev=0.005))
        # --- the corridor is DECLARED in the floor, not just left empty:
        # a brass route inlay from the rear threshold along the aisle, and
        # trolley bumpers on the alcove corners it turns past.
        rxc = (BOH_ROUTE_X0 + BOH_ROUTE_X1) / 2
        rxw = BOH_ROUTE_X1 - BOH_ROUTE_X0
        o.append(B("interior__boh_route_inlay", MAT["brass"],
                   (rxc, BOH_ROUTE_Y0 + 0.02, ft - 0.004), (rxw, 0.05, 0.016),
                   bev=0.003, lod=1))
        o.append(B("interior__boh_route_inlay_n", MAT["brass"],
                   (rxc, BOH_ROUTE_Y1 - 0.02, ft - 0.004), (rxw, 0.05, 0.016),
                   bev=0.003, lod=1))
        for i, bxx in enumerate((-3.19, -1.48, 1.42, 2.99, 4.14)):
            o.append(B(f"interior__boh_bumper_{i}", MAT["brass"], (bxx, nb + 0.04,
                                                                   ft + 0.13),
                       (0.07, 0.09, 0.26), bev=0.005, lod=1))
        # rear service threshold + trolley kerb
        o.append(B("interior__svc_threshold", MAT["brass"], (p["svc_x"], p["ny_in"] + 0.10,
                                                             ft - 0.006),
                   (p["svc_w"] + 0.18, 0.46, 0.026), bev=0.005, lod=1))
        # BOH strip lighting under the dropped soffits
        for nm, xx in (("w", -3.90), ("e", 4.20)):
            o.append(B(f"interior__boh_light_{nm}", MAT["lamp"], (xx, 3.05,
                                                                  BOH_SOFFIT - 0.03),
                       (2.20, 0.12, 0.025)))
    # ---------------- east hall wall: it was a dead field between the bay
    # portal and the service wall (pass-3 review defect 8).  Given a purpose:
    # a customer-facing information and waiting nook, which is also what the
    # queue for the association desk needs.
    if DETAIL:
        ey = 0.42          # north of the trainer approach cell
        o.append(B("interior__nook_back", MAT["ceramic"], (ix - 0.05, ey, ft + 1.30),
                   (0.10, 1.90, 2.30), bev=0.008))
        o.append(B("interior__nook_frame", MAT["brass"], (ix - 0.11, ey, ft + 1.30),
                   (0.04, 2.02, 2.42), bev=0.005, lod=1))
        o.append(B("interior__nook_bench", MAT["ceramic"], (ix - 0.31, ey, ft + 0.44),
                   (0.44, 1.46, 0.07), bev=0.008))
        for s_ in (-1, 1):
            o.append(B(f"interior__nook_bench_leg_{s_}", MAT["steel"],
                       (ix - 0.31, ey + s_ * 0.62, ft + 0.21), (0.36, 0.06, 0.42),
                       bev=0.005, lod=1))
        # a shelf of route/notice cards above the bench, and a lit sign band
        o.append(B("interior__nook_shelf", MAT["steel"], (ix - 0.26, ey, ft + 1.06),
                   (0.34, 1.30, 0.045), bev=0.004, lod=1))
        for j, (dy_, w_, h_) in enumerate(((-0.44, 0.20, 0.26), (-0.16, 0.16, 0.22),
                                           (0.14, 0.22, 0.30), (0.44, 0.18, 0.24))):
            o.append(B(f"interior__nook_card_{j}", MAT["plaster"],
                       (ix - 0.14, ey + dy_, ft + 1.62), (0.02, w_, h_), bev=0.003,
                       lod=1))
        o.append(B("interior__nook_signband", MAT["steel"], (ix - 0.17, ey, ft + 2.12),
                   (0.10, 1.70, 0.14), bev=0.006, lod=1))
        o.append(B("interior__nook_signlamp", MAT["cyan"], (ix - 0.225, ey, ft + 2.12),
                   (0.02, 1.54, 0.05)))
        # brass wayfinding studs let into the screed, leading to the nook
        for j in range(4):
            o.append(B(f"interior__nook_stud_{j}", MAT["brass"],
                       (ix - 0.72 - j * 0.34, ey - 0.30 - j * 0.16, ft - 0.004),
                       (0.09, 0.09, 0.016), bev=0.003, lod=1))
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
# ---------------------------------------------------------------------------
# THE INTERACTION-FACE TRANSFORM, MEASURED FROM THE IMPORTED GEOMETRY
# ---------------------------------------------------------------------------
# Pass-3 review defect 1: all three terminals faced backward, showing service
# backs, vents and access panels to the customer.  The manifests say the
# interaction face is asset-local +Z, and the previous code "reasoned" from
# that prose to a 180 deg yaw.  That was wrong.  The transform was then
# measured directly from the imported meshes (build/diag/diag_terminal_face.py
# and diag_terminal_normal.py, outputs checked into build/diag/):
#
#   * `bpy.ops.import_scene.gltf` BAKES the Y-up->Z-up conversion into the mesh
#     data.  Every imported root comes in with rotation_euler == (0,0,0), so
#     there is no root rotation left to compose with.
#   * measured world bbox of bank_terminal_civic after import:
#         x -0.504..0.504   y -0.3455..0.333   z 0..1.65
#     the manifest collisionProxy is min (-0.504, 0, -0.333), max (0.504, 1.65,
#     0.3455) in asset space -- so asset +Z (0.3455, the FRONT half) landed on
#     blender -Y, and asset -Z (0.333, the BACK half) landed on blender +Y.
#     => glTF +Z maps to BLENDER -Y.
#   * confirmed on the lit surfaces themselves: the largest polygon of every
#     screen/interaction material points along blender -Y
#         CM_ScreenBank  n = (0.000, -0.978,  0.208)
#         CM_ScreenTrade n = (0.000, -0.960,  0.280)
#         CM_ScreenPA    n = (0.000, -1.000,  0.000)
#
# Blender -Y is the public front (it is what the exporter turns into glTF +Z).
# Therefore the correct placement yaw for a customer-facing terminal is 0 deg,
# and the previous 180 deg turned the serviced backs to the hall.
# `verify.py::check_terminal_orientation` re-measures this from the shipped
# furnished GLB, in glTF space, so the defect cannot silently return.
TERM_FRONT_HALF = {"bank_terminal_civic": 0.3455, "trade_terminal": 0.365,
                   "pa_terminal": 0.329}      # measured: -min_y after import
TERM_BACK_HALF = {"bank_terminal_civic": 0.333, "trade_terminal": 0.360,
                  "pa_terminal": 0.329}       # measured: +max_y after import
PROP_HALF = TERM_FRONT_HALF                   # kept: front half-depth
TERM_BACK = 2.26          # authoring y of the docked terminal BACK face
TERM_YAW = 0.0            # measured, not assumed: interaction face -> -Y


def _dock_y(fn):
    """Origin y that lands the prop's measured BACK face on TERM_BACK at yaw 0."""
    return TERM_BACK - TERM_BACK_HALF[fn]


def term_front_y(fn):
    """Authoring y of the docked terminal's interaction face."""
    return _dock_y(fn) - TERM_FRONT_HALF[fn]


PROPS = [
    ("bank_terminal_civic.glb", CELLS["bank"][0], _dock_y("bank_terminal_civic"),
     TERM_YAW,
     "bank / private-value service point, docked in its niche, screens facing "
     "the customer approach (+Z)"),
    ("trade_terminal.glb", CELLS["trade"][0], _dock_y("trade_terminal"), TERM_YAW,
     "trade / exchange service point, docked in its niche, scan bed and readout "
     "facing the customer approach (+Z)"),
    ("pa_terminal.glb", CELLS["assoc"][0], _dock_y("pa_terminal"), TERM_YAW,
     "player-association registry point, docked in its niche, roster screen and "
     "reader podium facing the customer approach (+Z)"),
    ("chair_frontier_a.glb", TRN["trainer_seat"][0], TRN["trainer_seat"][1],
     TRN["trainer_seat"][2],
     "trainer's seat behind the consultation table, facing the customer approach"),
    ("chair_frontier_b.glb", TRN["visitor_seat"][0], TRN["visitor_seat"][1],
     TRN["visitor_seat"][2],
     "visitor seat drawn up to the north side of the consultation table"),
    ("crate_planked.glb", -3.82, -1.55, 12.0,
     "vendor goods delivered at the display line, clear of the counter"),
    ("footlocker_frontier.glb", -4.70, 3.293, 0.0,
     "back-of-house storage locker, against the rear wall west of the staff "
     "route, clear of the proven corridor"),
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
    # the bay west wall now runs north to the interior face (it forms the
    # portal's west jamb), so its proxy must follow the geometry
    add("shell__bay_west", p["tr_x0"], p["tr_x0"] + p["wt"], p["tr_y"], p["sy_in"],
        ft, p["tr_top"], "structure")
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
            p["niche_y1"] + p["niche_back_t"], ft, ft + p["niche_h"], "structure")
    # ---- per-service dock hardware standing on the piers (never in the
    # customer approach; verify_clearance re-proves that every build)
    nb_ = p["niche_y1"] + p["niche_back_t"]
    for k in NICHE_KEYS:
        cx = CELLS[k][0]
        hp = DOCK_HEAD_Y[k]
        if k == "bank":
            for s in (-1, 1):
                add(f"fixture__dock_bank_fin_{'w' if s < 0 else 'e'}",
                    cx + s * 0.755 - 0.06, cx + s * 0.755 + 0.06, hp, p["bulk_y0"],
                    ft, ft + 2.33, "furniture")
            add("fixture__dock_bank_drawer", cx - DOCK_SIDE_X - 0.20,
                cx - DOCK_SIDE_X + 0.20, p["bulk_y0"] - 0.25, p["bulk_y0"],
                ft + 0.87, ft + 1.17, "furniture")
            add("fixture__dock_bank_ledge", cx + DOCK_SIDE_X - 0.23,
                cx + DOCK_SIDE_X + 0.23, p["bulk_y0"] - 0.34, p["bulk_y0"], ft,
                ft + 0.99, "furniture")
        elif k == "trade":
            for s in (-1, 1):
                add(f"fixture__dock_trade_leg_{'w' if s < 0 else 'e'}",
                    cx + s * (p["niche_w"] / 2 + 0.24) - 0.03,
                    cx + s * (p["niche_w"] / 2 + 0.24) + 0.03, hp + 0.02, hp + 0.08,
                    ft, ft + p["niche_h"] - 0.05, "furniture")
            add("fixture__dock_trade_shelf", cx + DOCK_SIDE_X - 0.15,
                cx + DOCK_SIDE_X + 0.25, p["bulk_y0"] - 0.30, p["bulk_y0"], ft,
                ft + 0.95, "furniture")
        else:
            add("fixture__dock_assoc_notice", cx - DOCK_SIDE_X - 0.29,
                cx - DOCK_SIDE_X + 0.29, p["bulk_y0"] - 0.09, p["bulk_y0"],
                ft + 1.09, ft + 1.95, "furniture")
            add("fixture__dock_assoc_bench", cx + DOCK_SIDE_X - 0.27,
                cx + DOCK_SIDE_X + 0.27, p["bulk_y0"] - 0.40, p["bulk_y0"], ft,
                ft + 0.49, "furniture")
    # ---- built-in furniture
    add("fixture__vendor_counter", -p["ix"], -p["ix"] + 0.74, -2.20, 0.60, ft,
        ft + 0.95, "furniture")
    add("fixture__trainer_table", TRN["tx0"], TRN["tx1"], TRN["ty0"], TRN["ty1"], ft,
        ft + 0.76, "furniture")
    add("fixture__trainer_credenza", TRN["cx0"], TRN["cx1"], TRN["cy0"], TRN["cy1"],
        ft, ft + 0.92, "furniture")
    add("fixture__boh_bench", 4.21, 5.25, p["bulk_y1"] + 0.01, BOH_ROUTE_Y0 - 0.01,
        ft, ft + 0.95, "furniture")
    add("fixture__boh_shelving", -4.14, -3.26, p["bulk_y1"] + 0.01,
        BOH_ROUTE_Y0 - 0.01, ft, ft + 2.20, "furniture")
    add("fixture__boh_switchgear", p["ix"] - 0.27, p["ix"], 2.75, 3.55, ft, ft + 1.67,
        "furniture")
    for i, tx in enumerate(BOH_FILTER_X):
        add(f"fixture__boh_filter_{i}", tx - 0.205, tx + 0.205,
            p["bulk_y1"] + 0.18 - 0.205, p["bulk_y1"] + 0.18 + 0.205, ft, ft + 2.46,
            "furniture")
    add("fixture__boh_valve_panel", -0.30, 0.04, nb_, nb_ + 0.12, ft + 1.10,
        ft + 1.62, "furniture")
    add("fixture__boh_ladder", -2.55, -2.05, p["ny_in"] - 0.11, p["ny_in"], ft,
        ft + 4.24, "furniture")
    add("fixture__nook_bench", p["ix"] - 0.53, p["ix"], -0.31, 1.15, ft, ft + 0.48,
        "furniture")
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
    # MEASURED docked terminal interaction face, southward into the hall
    for k, fn in (("bank", "bank_terminal_civic"), ("trade", "trade_terminal"),
                  ("assoc", "pa_terminal")):
        cx = CELLS[k][0]
        front = term_front_y(fn)
        checks.append((f"front_clearance_{k}", cx - 0.40, cx + 0.40, front - 0.80,
                       front, ft, ft + 1.9))
    # ---- pass-3 additions: the failure modes the old check set omitted ----
    # rear service door approach, inside and out
    sx0, sx1 = p["svc_x"] - p["svc_w"] / 2, p["svc_x"] + p["svc_w"] / 2
    checks.append(("rear_door_approach_in", sx0 + 0.05, sx1 - 0.05, p["ny_in"] - 1.10,
                   p["ny_in"] - 0.02, ft, ft + 2.0))
    checks.append(("rear_door_walk_through", sx0 + 0.05, sx1 - 0.05, p["ny_in"] - 0.02,
                   p["ny"] + 0.40, ft, ft + p["svc_h"] - 0.05))
    # BOH corridor band: the declared staff route, end to end
    checks.append(("boh_route_band", BOH_ROUTE_X0, BOH_ROUTE_X1, BOH_ROUTE_Y0,
                   BOH_ROUTE_Y1, ft, ft + 1.95))
    # staff can reach the SERVICE SIDE of each fixture from that corridor
    nb2 = p["niche_y1"] + p["niche_back_t"]
    for k in NICHE_KEYS:
        cx = CELLS[k][0]
        checks.append((f"boh_reach_{k}", cx - 0.30, cx + 0.30, nb2 + 0.01,
                       BOH_ROUTE_Y0, ft, ft + 1.95))
    # trainer booth: seated volumes, the table approach, and the standing customer
    for nm, (sx, sy, _yaw) in (("trainer", TRN["trainer_seat"]),
                               ("visitor", TRN["visitor_seat"])):
        checks.append((f"trainer_seat_{nm}", sx - 0.32, sx + 0.32, sy - 0.32,
                       sy + 0.32, ft + 0.50, ft + TRN["seated_clear_h"]))
    checks.append(("trainer_standing_approach", TRN["tx0"] + 0.10, TRN["tx1"] - 0.10,
                   TRN["stand_y0"], TRN["stand_y1"], ft, ft + 1.90))
    # the customer sightline into the booth must not be blocked at eye height
    checks.append(("trainer_sightline", TRN["tx0"] + 0.10, TRN["tx1"] - 0.10,
                   TRN["ty1"] + 0.02, TRN["stand_y1"], ft + 1.00, ft + 1.70))
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
L2_KEYS = ("__plinth", "__skin", "_glass", "_backing", "corner_sw_back", "corner_nw_back",
           "corner_ne_back", "corner_bay_se_back", "corner_bay_sw_back",
           "corner_bay_re_back", "deck_south", "deck_north", "deck_bay", "gable_",
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
           "vendor_shelf", "vendor_root", "vendor_disc", "vendor_sack",
           "vendor_jar", "vendor_hung", "vendor_pallet", "nook_", "trainer_board", "sign_", "niche_", "log_fascia",
           "log_ledge", "log_coffer_housing", "log_coffer_bezel", "shop_", "track_rail", "track_fascia", "hood_soffit",
           "hood_spring", "fan_", "threshold", "grate_frame", "wall_cove",
           "cricket", "splash", "overflow", "flue_collar", "flue_cowl", "bollard",
           "win_", "vent_storage", "vent_tank", "vent_gear",
           "hood_drip", "hood_hopper", "hood_downpipe", "hood_pipe_clip",
           "hood_shoe", "hood_spill", "hood_impost", "hood_saddle", "fan_frame",
           "fan_stop", "hood_lining", "hood_penetration",
           "corner_", "dock_", "boh_filter", "boh_manifold", "boh_valve",
           "boh_route", "boh_bumper", "trainer_credenza", "trainer_downlight",
           "trainer_sconce", "bay_shelf_e")


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
    # MEASURED loose-prop footprints, written as their own sidecar.  The pass-3
    # review asked for "imported loose-prop footprints" to be tested; that
    # cannot be done from placement numbers alone, because the prop's own
    # bounds and pivot decide where it actually lands.  These are measured from
    # the imported meshes after placement, in authoring space.
    pf = []
    for e in props:
        if e.type != 'EMPTY' or not e.name.startswith("prop__"):
            continue
        mn = Vector((1e9,) * 3)
        mx = Vector((-1e9,) * 3)
        for ch in e.children_recursive:
            if ch.type != 'MESH':
                continue
            for c in ch.bound_box:
                w = ch.matrix_world @ Vector(c)
                for i in range(3):
                    mn[i] = min(mn[i], w[i])
                    mx[i] = max(mx[i], w[i])
        if mn[0] > 1e8:
            continue
        pf.append({"name": e.name[6:],
                   "x0": round(mn[0], 4), "x1": round(mx[0], 4),
                   "y0": round(mn[1], 4), "y1": round(mx[1], 4),
                   "z0": round(mn[2], 4), "z1": round(mx[2], 4),
                   "size": [round(mx[i] - mn[i], 4) for i in range(3)]})
    with open(os.path.join(ROOT, "build", "prop_footprints.json"), "w") as fh:
        json.dump({"space": "authoring metres (+X east, +Y north, +Z up)",
                   "note": "measured from the imported meshes after placement",
                   "props": pf}, fh, indent=1)
    print(f"[props] measured {len(pf)} loose-prop footprints")
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
