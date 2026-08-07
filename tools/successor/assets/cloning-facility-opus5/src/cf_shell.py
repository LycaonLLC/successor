"""Exterior shell of the Dustgate Clone Vault.

Tectonics, in the buildkit-opus5 register: a heavy sintered ground plate and
plinth, a lighter panel skin with crisp recessed reveals above it, a bronze
datum band at the construction line, a galvanised coping, and purposeful
service mass — but the service mass is *biomedical process plant*, which is
what makes this building a clone vault and not another dwelling.

Footprint discipline
--------------------
The nine structural collision boxes are frozen (see `cf_spec.STRUCTURAL_WALLS`).
Nothing solid at pawn height may sit outside them, or the player walks through
it.  Every mass that wants more room than the wall band allows therefore lives
on the roof, above 3.58 m, where there is no collision contract at all.
"""
from __future__ import annotations

import math

from cf_geom import (Part, box, cham_box, oct_plan, prism_y, frustum_y, cyl_y,
                     tube_y, cyl_axis, lathe, torus_y, pipe_run, plate,
                     recess_field, louvers, bolt_row, grate, ladder,
                     chevron_band, ring_plan, lerp)
from cf_spec import DOOR, ENTRY_BAY, ENVELOPE, LEVELS, MAIN, SHELL

X0, X1 = ENVELOPE["x_min"], ENVELOPE["x_max"]
Z0, Z1 = ENVELOPE["z_min"], ENVELOPE["z_max"]
LX, RX = SHELL["left_x"], SHELL["right_x"]        # panel-skin planes
BZ, FZ = SHELL["back_z"], MAIN["z_max"]
IX0, IX1 = -4.20, 4.20                            # interior faces
IZ0, IZ1 = -3.25, 2.80

CURB_TOP = LEVELS["curb_top_y"]
DATUM = LEVELS["datum_y"]
WALL_TOP = LEVELS["wall_top_y"]
ROOF_TOP = LEVELS["roof_top_y"]
PARAPET = LEVELS["parapet_top_y"]
PARAPET_BACK = LEVELS["parapet_back_y"]
PARAPET_RIGHT = LEVELS["parapet_right_y"]
PARAPET_FRONT = LEVELS["parapet_front_y"]
PIER_TOP = LEVELS["corner_pier_top_y"]
TOWER_SHAFT = LEVELS["tower_shaft_top_y"]
TOWER_TOP = LEVELS["tower_top_y"]
GRADE = LEVELS["grade_y"]
FLOOR_TOP = 0.02

CURB_OUT = 0.13       # plinth projection past the skin
DATUM_H = 0.10
DATUM_OUT = 0.045
REVEAL = 0.09         # depth of the recessed panel fields


# ─────────────────────────────── ground plate ─────────────────────────────


# The apron deck sits 6 mm BELOW the interior floor top.  Coplanar with it, the
# two caps self-shadow: an ambient ray leaving either one hits the other at zero
# distance, and the whole interior floor bakes to black.  6 mm is invisible and
# costs nothing.
APRON_TOP = FLOOR_TOP - 0.006


def build_ground(p: Part):
    """Sintered apron.  Also the part that fixes the 9.5 x 7.6 m envelope."""
    ch = 0.055
    plan = oct_plan(X0, X1, Z0, Z1, 0.20)
    inner = oct_plan(X0 + ch, X1 - ch, Z0 + ch, Z1 - ch, 0.20)
    prism_y(p, plan, GRADE, APRON_TOP - ch, "CF_sinter", cap_lo=True, cap_hi=False)
    frustum_y(p, plan, APRON_TOP - ch, inner, APRON_TOP, "CF_sinter",
              cap_lo=False, cap_hi=True)
    # cast-in expansion joints, so the plate is not one blank slab
    for z in (-2.1, 0.4, 2.6):
        box(p, X0 + 0.22, X1 - 0.22, APRON_TOP - 0.016, APRON_TOP - 0.002,
            z - 0.022, z + 0.022, "CF_gunmetal")
    for x in (-2.6, 1.4):
        box(p, x - 0.022, x + 0.022, APRON_TOP - 0.016, APRON_TOP - 0.002,
            Z0 + 0.22, Z1 - 0.22, "CF_gunmetal")


def build_threshold(p: Part, glow: Part):
    """Everything in front of the portal: hazard chevrons, a wash grille and
    the bollard pair that says `vehicles stop here`."""
    chevron_band(p, -0.34, 2.04, 3.13, 3.44, APRON_TOP + 0.004,
                 "CF_hazard", "CF_gunmetal", count=9, skew=0.14)
    grate(p, -0.30, 2.00, 3.46, 3.62, APRON_TOP + 0.008, "CF_steel",
          bars=13, along="y", thick=0.02)
    for x in (-0.62, 2.32):
        cyl_y(p, x, 3.54, 0.075, APRON_TOP, 0.62, "CF_gunmetal", sides=10)
        cyl_y(p, x, 3.54, 0.092, 0.62, 0.70, "CF_bronze", sides=10)
        cyl_y(glow, x, 3.54, 0.055, 0.70, 0.745, "CF_GlowAmber", sides=10)


# ───────────────────────────────── walls ──────────────────────────────────


def _wall_body(p: Part, side: str):
    """Plinth + panel skin + datum + head band for one of the four faces."""
    if side == "left":
        xo, xi = LX, IX0
        za, zb = BZ, FZ
        out = -1.0
    elif side == "right":
        xo, xi = RX, IX1
        za, zb = BZ, FZ
        out = 1.0
    else:
        raise ValueError(side)
    xc0, xc1 = min(xo, xi), max(xo, xi)
    # plinth
    curb = xo + out * CURB_OUT
    c0, c1 = min(curb, xi), max(curb, xi)
    box(p, c0, c1, FLOOR_TOP, CURB_TOP - 0.05, za, zb, "CF_sinter")
    if out < 0:
        p.quad((curb, CURB_TOP - 0.05, za), (curb, CURB_TOP - 0.05, zb),
               (xo, CURB_TOP, zb), (xo, CURB_TOP, za), "CF_sinter")
    else:
        p.quad((curb, CURB_TOP - 0.05, zb), (curb, CURB_TOP - 0.05, za),
               (xo, CURB_TOP, za), (xo, CURB_TOP, zb), "CF_sinter")
    box(p, min(xo, xi), max(xo, xi), CURB_TOP - 0.05, CURB_TOP, za, zb, "CF_sinter")
    # panel skin
    box(p, xc0, xc1, CURB_TOP, WALL_TOP, za, zb, "CF_panel")
    # recessed panel field, split above and below the datum
    ax = "-x" if out < 0 else "+x"
    u0, u1 = (zb, za) if out < 0 else (za, zb)
    sgn = -1.0 if out < 0 else 1.0
    recess_field(p, min(u0, u1) + 0.34, max(u0, u1) - 0.34, CURB_TOP + 0.22,
                 DATUM - 0.12, abs(xo), REVEAL, "CF_panel_dk", 3, 1,
                 gap=0.11, axis=ax)
    recess_field(p, min(u0, u1) + 0.34, max(u0, u1) - 0.34, DATUM + DATUM_H + 0.14,
                 WALL_TOP - 0.50, abs(xo), REVEAL * 0.7, "CF_gunmetal", 3, 1,
                 gap=0.11, axis=ax)
    # bronze datum band
    d0, d1 = sorted((xo, xo + out * DATUM_OUT))
    box(p, d0, d1, DATUM, DATUM + DATUM_H, za, zb, "CF_bronze")
    # drip under the head
    h0, h1 = sorted((xo, xo + out * 0.055))
    box(p, h0, h1, WALL_TOP - 0.30, WALL_TOP - 0.24, za, zb, "CF_gunmetal")


def _buttress(p: Part, side: str, zc: float, half=0.24, corner=False):
    """Cast pier stepping out to the envelope.

    Ordinary piers stop below the wall head and die back into the skin on a
    45-degree shoulder.  Corner piers keep going past the parapet and take a
    bronze cap, which is what gives the mass four legible vertical edges
    instead of one continuous white band.
    """
    if side == "left":
        xa, xb = X0, LX + 0.02
        xin = LX
        ax = "-x"
    else:
        xa, xb = RX - 0.02, X1
        xin = RX
        ax = "+x"
    xo = X0 if side == "left" else X1
    half = half + (0.10 if corner else 0.0)
    cham_box(p, xa, xb, FLOOR_TOP, CURB_TOP + 0.07, zc - half - 0.06, zc + half + 0.06,
             "CF_sinter", ch=0.04, top=True)
    if corner:
        cham_box(p, xa, xb, CURB_TOP + 0.07, PIER_TOP - 0.10, zc - half, zc + half,
                 "CF_panel_dk", ch=0.035, top=False)
        box(p, xa - 0.0, xb, PIER_TOP - 0.10, PIER_TOP - 0.04, zc - half - 0.04,
            zc + half + 0.04, "CF_roofmetal")
        box(p, xa, xb, PIER_TOP - 0.145, PIER_TOP - 0.10, zc - half - 0.04,
            zc + half + 0.04, "CF_bronze")
        recess_field(p, zc - half + 0.07, zc + half - 0.07, CURB_TOP + 0.34,
                     DATUM - 0.16, abs(xo), 0.045, "CF_gunmetal", 1, 2,
                     gap=0.10, axis=ax)
    else:
        y_top = WALL_TOP - 0.42
        cham_box(p, xa, xb, CURB_TOP + 0.07, y_top, zc - half, zc + half,
                 "CF_panel_dk", ch=0.03, top=False)
        for z in (zc - half, zc + half):
            p.quad((xa, y_top, z), (xb, y_top, z), (xin, y_top + 0.26, z),
                   (xin, y_top + 0.26, z), "CF_panel_dk")
        p.quad((xo, y_top, zc - half), (xo, y_top, zc + half),
               (xin, y_top + 0.26, zc + half), (xin, y_top + 0.26, zc - half),
               "CF_panel_dk")
    box(p, min(xa, xb), max(xa, xb), DATUM - 0.012, DATUM + DATUM_H + 0.012,
        zc - half - 0.014, zc + half + 0.014, "CF_bronze")
    bolt_row(p, [(zc, CURB_TOP + 0.34), (zc, CURB_TOP + 0.70)], abs(xo) - 0.014,
             "CF_gunmetal", r=0.024, h=0.014, axis=ax)


def _clerestory(p: Part, glass: Part, side: str, z_a: float, z_b: float,
                y0=2.44, y1=3.10):
    """Deep-reveal clerestory: the building's only large dark rectangles, and
    the reason the pale panel field has anything to read against."""
    if side == "left":
        xo, xi = LX, IX0
    else:
        xo, xi = RX, IX1
    x_lo, x_hi = min(xo, xi), max(xo, xi)
    fr = 0.07
    box(p, x_lo, x_hi, y0 - fr, y0, z_a - fr, z_b + fr, "CF_gunmetal")
    box(p, x_lo, x_hi, y1, y1 + fr, z_a - fr, z_b + fr, "CF_gunmetal")
    box(p, x_lo, x_hi, y0, y1, z_a - fr, z_a, "CF_gunmetal")
    box(p, x_lo, x_hi, y0, y1, z_b, z_b + fr, "CF_gunmetal")
    # recessed dark liner so the opening reads deep even at grazing angles
    xr = xo + (xi - xo) * 0.55
    xt = xi + (0.02 if side == "left" else -0.02)
    box(p, min(xr, xt), max(xr, xt), y0, y1, z_a, z_b, "CF_gunmetal",
        skip=("-x" if side == "left" else "+x",))
    n = max(1, int((z_b - z_a) / 0.58))
    for i in range(1, n):
        zc = lerp(z_a, z_b, i / n)
        box(p, x_lo, x_hi, y0, y1, zc - 0.026, zc + 0.026, "CF_gunmetal")
    xg = xo + (0.055 if side == "left" else -0.055)
    box(glass, xg - 0.012, xg + 0.012, y0, y1, z_a, z_b, "CF_Glass")
    # sill drip
    box(p, min(xo, xo + (-0.05 if side == "left" else 0.05)),
        max(xo, xo + (-0.05 if side == "left" else 0.05)),
        y0 - fr - 0.05, y0 - fr, z_a - fr - 0.03, z_b + fr + 0.03, "CF_bronze")


def _flank_slot(p: Part, side: str, z_a: float, z_b: float):
    """Full-height recessed gunmetal slot with a vertical louver stack: the
    dark vertical accent that keeps a 7 m pale wall from reading as a slab."""
    if side == "left":
        xo, xi, ax = LX, IX0, "-x"
    else:
        xo, xi, ax = RX, IX1, "+x"
    out = -0.06 if side == "left" else 0.06
    x_lo, x_hi = sorted((xo + out, xo - out * 1.4))
    box(p, x_lo, x_hi, CURB_TOP, WALL_TOP - 0.34, z_a - 0.07, z_b + 0.07, "CF_gunmetal")
    louvers(p, z_a, z_b, WALL_TOP - 0.46, 13, 0.155, abs(xo) + 0.06, 0.05,
            "CF_steel", axis=ax)
    for y in (CURB_TOP - 0.02, WALL_TOP - 0.36):
        box(p, x_lo - 0.03, x_hi + 0.03, y, y + 0.08, z_a - 0.10, z_b + 0.10, "CF_bronze")


def build_wall_left(p: Part, glass: Part):
    _wall_body(p, "left")
    # the back-left corner is the filtration tower, so no pier is drawn there
    for zc, corner in ((-1.42, False), (0.32, False), (2.78, True)):
        _buttress(p, "left", zc, corner=corner)
    _clerestory(p, glass, "left", -1.18, 0.06)
    _clerestory(p, glass, "left", 0.58, 2.50)
    _flank_slot(p, "left", -1.24, 0.14)
    # service conduit riser feeding the roof plant
    for zc, r in ((-3.32, 0.075), (-3.10, 0.055)):
        cyl_y(p, X0 + 0.13, zc, r, CURB_TOP, WALL_TOP + 0.34, "CF_gunmetal", sides=8)
        for y in (1.05, 2.05, 3.05):
            torus_y(p, X0 + 0.13, y, zc, r + 0.012, 0.022, "CF_steel",
                    major_sides=8, minor_sides=5)


def build_wall_right(p: Part, glass: Part, glow: Part):
    _wall_body(p, "right")
    for zc, corner in ((-3.22, True), (-1.62, False), (0.10, False), (2.78, True)):
        _buttress(p, "right", zc, corner=corner)
    _clerestory(p, glass, "right", -2.90, -1.86)
    _clerestory(p, glass, "right", 1.90, 2.50)
    # external process columns: the wall band is the only ground-level room
    # the frozen footprint leaves for plant, so the plant becomes pilasters.
    for zc, h in ((-0.15, 2.62), (1.35, 2.30)):
        cyl_y(p, X1 - 0.31, zc, 0.26, CURB_TOP - 0.06, h, "CF_biotank", sides=16)
        lathe(p, X1 - 0.31, zc, [(0.26, h), (0.27, h + 0.03), (0.24, h + 0.10),
                                 (0.13, h + 0.17), (0.0, h + 0.20)],
              "CF_steel", sides=16)
        tube_y(p, X1 - 0.31, zc, 0.26, 0.295, CURB_TOP + 0.30, CURB_TOP + 0.40,
               "CF_bronze", sides=16)
        tube_y(p, X1 - 0.31, zc, 0.26, 0.295, h - 0.34, h - 0.24, "CF_bronze", sides=16)
        cyl_y(p, X1 - 0.31, zc, 0.295, CURB_TOP - 0.10, CURB_TOP - 0.06, "CF_gunmetal", sides=16)
        # sight glass with fluid level
        box(glow, X1 - 0.02, X1 - 0.005, CURB_TOP + 0.55, h - 0.55,
            zc - 0.035, zc + 0.035, "CF_Glow")
        pipe_run(p, [(X1 - 0.31, h + 0.20, zc), (X1 - 0.31, h + 0.46, zc),
                     (X1 - 0.31, h + 0.46, zc - 0.62)], 0.055, "CF_steel", sides=8)
    _flank_slot(p, "right", -1.30, -0.62)
    # valve cluster and gauge board between the columns
    box(p, X1 - 0.42, X1 - 0.10, CURB_TOP + 0.55, CURB_TOP + 1.35, 0.44, 0.96, "CF_gunmetal")
    plate(p, 0.50, 0.90, CURB_TOP + 0.62, CURB_TOP + 1.28, X1 - 0.10, X1 - 0.055,
          "CF_steel", ch=0.016, axis="+x")
    for zc in (0.60, 0.80):
        cyl_axis(p, "x", CURB_TOP + 1.02, zc, X1 - 0.055, X1 - 0.015, 0.045,
                 "CF_bronze", sides=10)


def build_wall_back(p: Part, glass: Part, upper: Part):
    box(p, IX0 - 0.10, IX1 + 0.10, FLOOR_TOP, CURB_TOP - 0.05, BZ - CURB_OUT, IZ0, "CF_sinter")
    p.quad((IX0 - 0.10, CURB_TOP - 0.05, BZ - CURB_OUT), (IX0 - 0.10, CURB_TOP, BZ),
           (IX1 + 0.10, CURB_TOP, BZ), (IX1 + 0.10, CURB_TOP - 0.05, BZ - CURB_OUT),
           "CF_sinter")
    box(p, IX0 - 0.10, IX1 + 0.10, CURB_TOP - 0.05, CURB_TOP, BZ, IZ0, "CF_sinter")
    box(p, IX0 - 0.10, IX1 + 0.10, CURB_TOP, WALL_TOP, BZ, IZ0, "CF_panel")
    recess_field(p, -4.02, 4.02, CURB_TOP + 0.22, DATUM - 0.12, abs(BZ), REVEAL,
                 "CF_panel_dk", 5, 1, gap=0.11, axis="-z")
    recess_field(p, -4.02, 4.02, DATUM + DATUM_H + 0.14, WALL_TOP - 0.50, abs(BZ),
                 REVEAL * 0.7, "CF_gunmetal", 5, 1, gap=0.11, axis="-z")
    box(p, IX0 - 0.10, IX1 + 0.10, DATUM, DATUM + DATUM_H, BZ - DATUM_OUT, BZ, "CF_bronze")
    box(p, IX0 - 0.10, IX1 + 0.10, WALL_TOP - 0.30, WALL_TOP - 0.24, BZ - 0.055, BZ, "CF_gunmetal")
    # back clerestory pair
    for (a, b) in ((-3.10, -1.30), (1.50, 3.30)):
        fr = 0.05
        y0, y1 = 2.66, 3.06
        box(p, a - fr, b + fr, y0 - fr, y0, BZ, IZ0, "CF_gunmetal")
        box(p, a - fr, b + fr, y1, y1 + fr, BZ, IZ0, "CF_gunmetal")
        box(p, a - fr, a, y0, y1, BZ, IZ0, "CF_gunmetal")
        box(p, b, b + fr, y0, y1, BZ, IZ0, "CF_gunmetal")
        n = max(1, int((b - a) / 0.62))
        for i in range(1, n):
            xc = lerp(a, b, i / n)
            box(p, xc - 0.022, xc + 0.022, y0, y1, BZ, IZ0, "CF_gunmetal")
        zg = (BZ + IZ0) * 0.5
        box(glass, a, b, y0, y1, zg - 0.012, zg + 0.012, "CF_Glass")
    build_tower(p, upper)


def build_tower(p: Part, upper: Part):
    """Filtration tower, back-left.

    The frozen footprint leaves only a 0.55 m wall band at ground level, so the
    shaft is slim where a pawn can reach it and CORBELS OUT over the roof deck
    above the parapet, where no collision contract applies.  That 45-degree
    transition is the same shoulder move the wall piers make, at building
    scale, and it is what turns a flat rectangle into a landmark.
    """
    sx0, sx1, sz0, sz1 = X0, IX0, BZ, -2.05
    ux0, ux1, uz0, uz1 = X0, -3.42, Z0, -1.86
    shaft_top = 3.90
    corbel_top = 4.30

    cham_box(p, sx0, sx1 + 0.04, FLOOR_TOP, CURB_TOP + 0.09, sz0 - 0.0, sz1 + 0.10,
             "CF_sinter", ch=0.045, top=True)
    cham_box(p, sx0, sx1, CURB_TOP + 0.09, shaft_top, sz0, sz1, "CF_panel_dk",
             ch=0.04, top=False)
    for y in (1.24, 2.32, 3.40):
        box(p, sx0 - 0.0, sx1 + 0.02, y, y + 0.08, sz0 - 0.02, sz1 + 0.02, "CF_bronze")
    recess_field(p, sz0 + 0.16, sz1 - 0.16, CURB_TOP + 0.34, 1.16, abs(sx0), REVEAL,
                 "CF_gunmetal", 1, 1, axis="-x")
    recess_field(p, sz0 + 0.16, sz1 - 0.16, 1.40, 2.24, abs(sx0), REVEAL,
                 "CF_gunmetal", 1, 1, axis="-x")

    frustum_y(upper, oct_plan(sx0, sx1, sz0, sz1, 0.05), shaft_top,
              oct_plan(ux0, ux1, uz0, uz1, 0.08), corbel_top, "CF_panel_dk",
              cap_lo=False, cap_hi=False)
    cham_box(upper, ux0, ux1, corbel_top, TOWER_SHAFT, uz0, uz1, "CF_panel", ch=0.05,
             top=False)
    box(upper, ux0 - 0.0, ux1 + 0.03, corbel_top + 0.06, corbel_top + 0.15,
        uz0 - 0.0, uz1 + 0.03, "CF_bronze")
    louvers(upper, uz0 + 0.16, uz1 - 0.16, TOWER_SHAFT - 0.22, 6, 0.17, abs(ux0), 0.075,
            "CF_gunmetal", axis="-x")
    louvers(upper, ux0 + 0.16, ux1 - 0.16, TOWER_SHAFT - 0.22, 6, 0.17, abs(uz0), 0.075,
            "CF_gunmetal", axis="-z")
    recess_field(upper, uz0 + 0.20, uz1 - 0.20, corbel_top + 0.30, TOWER_SHAFT - 0.52,
                 abs(ux0), REVEAL, "CF_panel_dk", 1, 2, gap=0.12, axis="-x")

    frustum_y(upper, oct_plan(ux0, ux1, uz0, uz1, 0.05), TOWER_SHAFT,
              oct_plan(ux0, ux1 + 0.10, uz0, uz1 + 0.10, 0.07), TOWER_SHAFT + 0.14,
              "CF_roofmetal", cap_lo=False, cap_hi=False)
    box(upper, ux0, ux1 + 0.10, TOWER_SHAFT + 0.14, TOWER_SHAFT + 0.22, uz0, uz1 + 0.10,
        "CF_roofmetal")
    box(upper, ux0, ux1 + 0.10, TOWER_SHAFT + 0.10, TOWER_SHAFT + 0.14, uz0, uz1 + 0.10,
        "CF_bronze")
    # capped extract stack
    stx, stz = -4.16, -2.86
    cyl_y(upper, stx, stz, 0.245, TOWER_SHAFT + 0.22, TOWER_TOP - 0.16, "CF_roofmetal",
          sides=14)
    tube_y(upper, stx, stz, 0.245, 0.285, TOWER_SHAFT + 0.44, TOWER_SHAFT + 0.54,
           "CF_bronze", sides=14)
    lathe(upper, stx, stz, [(0.245, TOWER_TOP - 0.16), (0.34, TOWER_TOP - 0.09),
                        (0.34, TOWER_TOP - 0.04), (0.245, TOWER_TOP - 0.02),
                        (0.245, TOWER_TOP)], "CF_steel", sides=14)
    for a in (40.0, 160.0, 280.0):
        ax = stx + 0.30 * math.cos(math.radians(a))
        az = stz + 0.30 * math.sin(math.radians(a))
        pipe_run(upper, [(ax, TOWER_TOP - 0.30, az),
                     (stx + 0.50 * math.cos(math.radians(a)), TOWER_SHAFT + 0.26,
                      stz + 0.50 * math.sin(math.radians(a)))], 0.026, "CF_steel",
                 sides=6)
    ladder(upper, ux0 + 0.16, -3.70, -3.30, corbel_top + 0.10, TOWER_SHAFT - 0.10,
           "CF_steel", rungs=8)


# ─────────────────────────────── front face ───────────────────────────────# ─────────────────────────────── front face ───────────────────────────────


def build_wall_front(p: Part, glass: Part, glow: Part):
    """Front wall either side of the entry bay."""
    for (a, b) in ((X0, ENTRY_BAY["x_min"] + 0.10), (ENTRY_BAY["x_max"] - 0.10, X1)):
        box(p, a, b, FLOOR_TOP, CURB_TOP - 0.05, IZ1, FZ + CURB_OUT, "CF_sinter")
        p.quad((a, CURB_TOP - 0.05, FZ + CURB_OUT), (b, CURB_TOP - 0.05, FZ + CURB_OUT),
               (b, CURB_TOP, FZ), (a, CURB_TOP, FZ), "CF_sinter")
        box(p, a, b, CURB_TOP - 0.05, CURB_TOP, IZ1, FZ, "CF_sinter")
        box(p, a, b, CURB_TOP, WALL_TOP, IZ1, FZ, "CF_panel")
        recess_field(p, a + 0.28, b - 0.28, CURB_TOP + 0.22, DATUM - 0.12, FZ,
                     REVEAL, "CF_panel_dk", 2, 1, gap=0.11, axis="+z")
        recess_field(p, a + 0.28, b - 0.28, DATUM + DATUM_H + 0.14, WALL_TOP - 0.50,
                     FZ, REVEAL * 0.7, "CF_gunmetal", 2, 1, gap=0.11, axis="+z")
        box(p, a, b, DATUM, DATUM + DATUM_H, FZ, FZ + DATUM_OUT, "CF_bronze")
        box(p, a, b, WALL_TOP - 0.30, WALL_TOP - 0.24, FZ, FZ + 0.055, "CF_gunmetal")
    # tall observation slits right of the bay
    for xa in (3.10, 3.72):
        fr = 0.05
        y0, y1 = CURB_TOP + 0.55, 2.06
        box(p, xa - fr, xa + 0.34 + fr, y0 - fr, y0, IZ1, FZ, "CF_gunmetal")
        box(p, xa - fr, xa + 0.34 + fr, y1, y1 + fr, IZ1, FZ, "CF_gunmetal")
        box(p, xa - fr, xa, y0, y1, IZ1, FZ, "CF_gunmetal")
        box(p, xa + 0.34, xa + 0.34 + fr, y0, y1, IZ1, FZ, "CF_gunmetal")
        box(glass, xa, xa + 0.34, y0, y1, FZ - 0.16, FZ - 0.14, "CF_Glass")
    # Intake register: the broad front-left segment needs one real event, not a
    # small box on a blank slab, or the whole face reads as unarticulated panel.
    rx0, rx1 = -4.34, -3.44
    box(p, rx0 - 0.08, rx1 + 0.08, CURB_TOP + 0.30, DATUM - 0.06, FZ - 0.01, FZ + 0.06,
        "CF_gunmetal")
    louvers(p, rx0, rx1, DATUM - 0.16, 9, 0.17, FZ + 0.06, 0.055, "CF_steel", axis="+z")
    box(p, rx0 - 0.11, rx1 + 0.11, DATUM - 0.06, DATUM + 0.02, FZ - 0.01, FZ + 0.09,
        "CF_bronze")
    box(p, rx0 - 0.11, rx1 + 0.11, CURB_TOP + 0.22, CURB_TOP + 0.30, FZ - 0.01, FZ + 0.09,
        "CF_bronze")
    box(glow, rx0 + 0.06, rx1 - 0.06, CURB_TOP + 0.14, CURB_TOP + 0.20, FZ + 0.02,
        FZ + 0.07, "CF_GlowAmber")
    # duct trunk climbing from the register to the roof plant
    box(p, -4.06, -3.72, DATUM + 0.02, WALL_TOP - 0.30, FZ, FZ + 0.20, "CF_gunmetal")
    for yy in (DATUM + 0.30, DATUM + 0.62):
        box(p, -4.12, -3.66, yy, yy + 0.07, FZ - 0.01, FZ + 0.24, "CF_bronze")
    # a second dark slot on the front-right segment balances the composition
    box(p, 3.02, 4.30, CURB_TOP + 0.30, CURB_TOP + 0.72, FZ - 0.01, FZ + 0.06,
        "CF_gunmetal")
    louvers(p, 3.08, 4.24, CURB_TOP + 0.66, 3, 0.13, FZ + 0.06, 0.045, "CF_steel",
            axis="+z")


def build_entry_bay(p: Part, glass: Part, glow: Part):
    bx0, bx1 = ENTRY_BAY["x_min"], ENTRY_BAY["x_max"]
    bz0, bzs, bzh = ENTRY_BAY["z_back"], ENTRY_BAY["z_struct"], ENTRY_BAY["z_hood"]
    op = DOOR["opening"]
    dx0, dx1, dy1 = op["x_min"], op["x_max"], op["y_max"]
    top = LEVELS["entry_parapet_top_y"]

    # bay plinth
    curb_z = min(bzs + CURB_OUT, bzh)      # the plinth may not leave the envelope
    box(p, bx0 - CURB_OUT, bx1 + CURB_OUT, FLOOR_TOP, CURB_TOP - 0.05,
        bz0, curb_z, "CF_sinter")
    p.quad((bx0 - CURB_OUT, CURB_TOP - 0.05, curb_z),
           (bx1 + CURB_OUT, CURB_TOP - 0.05, curb_z),
           (bx1, CURB_TOP, bzs), (bx0, CURB_TOP, bzs), "CF_sinter")
    for xa, xb in ((bx0 - CURB_OUT, bx0), (bx1, bx1 + CURB_OUT)):
        p.quad((xa, CURB_TOP - 0.05, bz0), (xa, CURB_TOP - 0.05, curb_z),
               (xb, CURB_TOP, bzs), (xb, CURB_TOP, bz0), "CF_sinter")
    box(p, bx0, bx1, CURB_TOP - 0.05, CURB_TOP, bz0, bzs, "CF_sinter")

    # bay returns (left / right cheeks)
    for (xa, xb) in ((bx0, -2.95), (2.45, bx1)):
        box(p, xa, xb, CURB_TOP, WALL_TOP, bz0, bzs, "CF_panel")
        recess_field(p, bz0 + 0.14, bzs - 0.14, CURB_TOP + 0.26, DATUM - 0.12,
                     abs(xa) if xa < 0 else xb, 0.032, "CF_panel_dk", 1, 1,
                     axis="-x" if xa < 0 else "+x")
        d0, d1 = (xa - DATUM_OUT, xa) if xa < 0 else (xb, xb + DATUM_OUT)
        box(p, d0, d1, DATUM, DATUM + DATUM_H, bz0, bzs, "CF_bronze")

    # bay front wall, pierced by the portal
    for (xa, xb) in ((-2.95, dx0), (dx1, 2.45)):
        box(p, xa, xb, CURB_TOP, WALL_TOP, 3.42, bzs, "CF_panel")
        box(p, xa, xb, FLOOR_TOP, CURB_TOP, 3.42, bzs + CURB_OUT * 0.6, "CF_sinter")
        box(p, xa, xb, DATUM, DATUM + DATUM_H, bzs, bzs + DATUM_OUT, "CF_bronze")
    # left cheek is broad enough for a real facade event
    recess_field(p, -2.80, -0.46, CURB_TOP + 0.30, DATUM - 0.14, bzs, 0.04,
                 "CF_panel_dk", 3, 1, gap=0.08, axis="+z")
    box(p, -2.66, -0.60, DATUM + 0.22, 2.36, bzs, bzs + 0.055, "CF_gunmetal")
    louvers(p, -2.60, -0.66, 2.30, 5, 0.135, bzs + 0.055, 0.05, "CF_steel", axis="+z")
    plate(p, -2.66, -1.72, WALL_TOP - 0.72, WALL_TOP - 0.30, bzs, bzs + 0.035,
          "CF_bronze", ch=0.015, axis="+z")
    for zx in (-2.44, -1.94):
        box(glow, zx - 0.055, zx + 0.055, WALL_TOP - 0.66, WALL_TOP - 0.36,
            bzs + 0.035, bzs + 0.055, "CF_Glow")

    # portal reveal: deep jamb, bronze bioseal gasket, energised trace
    jx0, jx1 = dx0 - 0.10, dx1 + 0.10
    box(p, jx0, dx0, CURB_TOP - 0.44, dy1 + 0.10, 3.42, bzs, "CF_gunmetal")
    box(p, dx1, jx1, CURB_TOP - 0.44, dy1 + 0.10, 3.42, bzs, "CF_gunmetal")
    box(p, jx0, jx1, dy1, dy1 + 0.10, 3.42, bzs, "CF_gunmetal")
    for xa in (dx0, dx1):
        box(p, xa - 0.035, xa + 0.035, FLOOR_TOP, dy1 + 0.045, bzs - 0.005, bzs + 0.03,
            "CF_bronze")
    box(p, dx0 - 0.035, dx1 + 0.035, dy1 + 0.01, dy1 + 0.045, bzs - 0.005, bzs + 0.03,
        "CF_bronze")
    for xa in (dx0 - 0.012, dx1 + 0.012):
        box(glow, xa - 0.012, xa + 0.012, FLOOR_TOP, dy1 + 0.02, bzs + 0.030, bzs + 0.040,
            "CF_Glow")
    box(glow, dx0 - 0.024, dx1 + 0.024, dy1 + 0.02, dy1 + 0.044, bzs + 0.030, bzs + 0.040,
        "CF_Glow")
    # jamb reveal carried through into the room
    box(p, jx0, dx0, CURB_TOP - 0.44, dy1 + 0.10, IZ1, 3.42, "CF_gunmetal")
    box(p, dx1, jx1, CURB_TOP - 0.44, dy1 + 0.10, IZ1, 3.42, "CF_gunmetal")
    box(p, jx0, jx1, dy1 + 0.10, WALL_TOP, IZ1, bzs, "CF_panel_dk")
    box(p, jx0, jx1, dy1, dy1 + 0.10, IZ1, 3.42, "CF_gunmetal")

    # door recess housing on the left of the portal
    pk = DOOR["door_recess"]
    box(p, pk["x_min"] - 0.06, pk["x_max"], pk["y_min"], pk["y_max"],
        pk["z_min"] - 0.05, pk["z_min"], "CF_gunmetal")
    box(p, pk["x_min"] - 0.06, pk["x_max"], pk["y_max"], pk["y_max"] + 0.07,
        pk["z_min"] - 0.05, pk["z_max"] + 0.03, "CF_gunmetal")
    bolt_row(p, [(x, pk["y_max"] + 0.035) for x in (-2.74, -2.24, -1.74, -1.24, -0.74)],
             bzs + 0.001, "CF_steel", r=0.02, h=0.010, axis="+z")

    # lintel: twin-figure resurrection crest on a recessed dark plate
    ly0, ly1 = dy1 + 0.16, dy1 + 0.74
    box(p, dx0 - 0.14, dx1 + 0.14, ly0, ly1, bzs - 0.045, bzs, "CF_gunmetal")
    cx = (dx0 + dx1) * 0.5
    cy = (ly0 + ly1) * 0.5
    _crest(p, cx, cy, bzs - 0.045, 0.25)
    for sx in (dx0 - 0.06, dx1 + 0.06):
        box(glow, sx - 0.02, sx + 0.02, ly0 + 0.06, ly1 - 0.06, bzs - 0.045, bzs - 0.02,
            "CF_Glow")

    # brow / hood over the whole bay
    hy0, hy1 = WALL_TOP - 0.44, WALL_TOP - 0.20
    box(p, bx0 - 0.08, bx1 + 0.08, hy0, hy1, bzs, bzh, "CF_panel")
    box(p, bx0 - 0.08, bx1 + 0.08, hy1, hy1 + 0.06, bzs - 0.02, bzh, "CF_bronze")
    p.quad((bx0 - 0.08, hy0, bzh), (bx1 + 0.08, hy0, bzh),
           (bx1 + 0.08, hy0 - 0.16, bzs), (bx0 - 0.08, hy0 - 0.16, bzs),
           "CF_panel_dk")
    box(glow, -2.60, 2.10, hy0 - 0.155, hy0 - 0.125, bzs + 0.06, bzh - 0.10, "CF_GlowWarm")
    for xa in (bx0 + 0.20, bx1 - 0.20):
        box(p, xa - 0.09, xa + 0.09, hy0 - 0.30, hy0, bzh - 0.16, bzh - 0.02, "CF_gunmetal")

    # bay parapet: taller than every main run, double-stepped, so the portal
    # mass reads as a separate volume from any approach bearing
    fin_top = LEVELS["entry_fin_top_y"]
    box(p, bx0 - 0.08, bx1 + 0.08, WALL_TOP, top - 0.22, bzs, bzh, "CF_panel")
    box(p, bx0 - 0.08, bx1 + 0.08, WALL_TOP, top - 0.22, bz0, bzs, "CF_panel",
        skip=("+z", "-z"))
    recess_field(p, bx0 + 0.26, bx1 - 0.26, WALL_TOP + 0.12, top - 0.40, bzh, 0.05,
                 "CF_panel_dk", 4, 1, gap=0.12, axis="+z")
    box(p, bx0 - 0.13, bx1 + 0.13, top - 0.22, top - 0.14, bz0, bzh, "CF_bronze")
    box(p, bx0 - 0.10, bx1 + 0.10, top - 0.14, top - 0.04, bz0, bzh - 0.02, "CF_panel_dk")
    box(p, bx0 - 0.16, bx1 + 0.16, top - 0.04, top, bz0, bzh, "CF_roofmetal")

    # corner fins standing on the bay returns
    for (fa, fb) in ((bx0, bx0 + 0.30), (bx1 - 0.30, bx1)):
        cham_box(p, fa, fb, CURB_TOP, fin_top - 0.10, bz0 + 0.04, bzh - 0.02,
                 "CF_panel_dk", ch=0.035, top=False)
        box(p, fa - 0.04, fb + 0.04, fin_top - 0.10, fin_top - 0.04, bz0 + 0.02,
            bzh, "CF_bronze")
        box(p, fa - 0.05, fb + 0.05, fin_top - 0.04, fin_top, bz0 + 0.02, bzh,
            "CF_roofmetal")
        for y in (1.42, 2.52, 3.62):
            box(p, fa - 0.03, fb + 0.03, y, y + 0.07, bz0 + 0.02, bzh, "CF_bronze")
        box(glow, fa + 0.09, fb - 0.09, DATUM + 0.34, fin_top - 0.42, bzh - 0.016,
            bzh - 0.002, "CF_Glow")

    # crest fin above the portal axis, cantilevered clear of head height
    fx0, fx1 = 0.60, 1.10
    box(p, fx0, fx1, top - 0.04, fin_top + 0.26, bzs + 0.06, bzh - 0.02, "CF_panel_dk")
    box(p, fx0 - 0.05, fx1 + 0.05, fin_top + 0.26, fin_top + 0.33, bzs + 0.04,
        bzh, "CF_bronze")
    _crest(p, (fx0 + fx1) * 0.5, fin_top - 0.06, bzh - 0.02, 0.19, flat=True)


def _crest(p: Part, cx, cy, w_face, r, axis="+z", flat=False):
    """Twin-figure resurrection crest: two abstract standing figures inside a
    broken ring.  Authored as geometry, so it carries no glyph or wordmark."""
    seg = 26
    ring0 = ring_plan(cx, cy, r, seg)
    ring1 = ring_plan(cx, cy, r * 0.80, seg)
    d = 0.022 if not flat else 0.014
    for i in range(seg):
        if 11 <= i <= 14:      # break at the top of the ring
            continue
        j = (i + 1) % seg
        a, b = ring0[i], ring0[j]
        c, e = ring1[j], ring1[i]
        for w0, w1 in ((w_face, w_face + d),):
            p.quad((a[0], a[1], w1), (b[0], b[1], w1), (c[0], c[1], w1), (e[0], e[1], w1),
                   "CF_bronze")
            p.quad((a[0], a[1], w0), (a[0], a[1], w1), (e[0], e[1], w1), (e[0], e[1], w0),
                   "CF_bronze")
            p.quad((b[0], b[1], w1), (b[0], b[1], w0), (c[0], c[1], w0), (c[0], c[1], w1),
                   "CF_bronze")
    for sgn in (-1, 1):
        fx = cx + sgn * r * 0.30
        hw = r * 0.115
        # head
        head = ring_plan(fx, cy + r * 0.34, hw * 0.95, 10)
        p.face([(q[0], q[1], w_face + d) for q in head], "CF_bronze")
        for i in range(10):
            j = (i + 1) % 10
            p.quad((head[i][0], head[i][1], w_face), (head[j][0], head[j][1], w_face),
                   (head[j][0], head[j][1], w_face + d), (head[i][0], head[i][1], w_face + d),
                   "CF_bronze")
        # torso + legs, tapered
        body = [(fx - hw * 1.5, cy + r * 0.20), (fx + hw * 1.5, cy + r * 0.20),
                (fx + hw * 0.85, cy - r * 0.46), (fx - hw * 0.85, cy - r * 0.46)]
        p.face([(q[0], q[1], w_face + d) for q in body], "CF_bronze")
        for i in range(4):
            j = (i + 1) % 4
            p.quad((body[i][0], body[i][1], w_face), (body[j][0], body[j][1], w_face),
                   (body[j][0], body[j][1], w_face + d), (body[i][0], body[i][1], w_face + d),
                   "CF_bronze")


# ──────────────────────────────── roof ────────────────────────────────────


def build_roof(p: Part, glass: Part, glow: Part):
    """Deck, parapet, and the process plant that makes the building read as a
    biomedical works from any exterior angle."""
    # structural deck + ceiling soffit
    box(p, IX0 - 0.30, IX1 + 0.30, LEVELS["roof_bottom_y"], ROOF_TOP,
        BZ, FZ + 0.06, "CF_roofmetal")
    # standing seams
    for i in range(15):
        xc = lerp(IX0 - 0.10, IX1 + 0.10, i / 14)
        box(p, xc - 0.024, xc + 0.024, ROOF_TOP, ROOF_TOP + 0.05, BZ + 0.10, FZ - 0.02,
            "CF_roofmetal")
    # parapet: four runs at three different heights, so the skyline has a
    # service side and a back rather than one continuous rectangle
    for (xa, xb, za, zb, top) in (
            (X0 + 0.05, LX + 0.06, -1.80, FZ, PARAPET),
            (RX - 0.06, X1 - 0.05, BZ + 0.05, FZ, PARAPET_RIGHT),
            (-3.30, X1 - 0.05, BZ + 0.05, BZ + 0.39, PARAPET_BACK),
            (X0 + 0.05, X1 - 0.05, FZ - 0.34, FZ, PARAPET_FRONT)):
        box(p, xa, xb, ROOF_TOP, top - 0.10, za, zb, "CF_panel")
        box(p, xa - 0.05, xb + 0.05, top - 0.10, top, za - 0.05, zb + 0.05,
            "CF_roofmetal")
        box(p, xa - 0.05, xb + 0.05, top - 0.135, top - 0.10, za - 0.05, zb + 0.05,
            "CF_bronze")
        recess_field(p, (za + 0.24 if xa < 0 and xb < 0 else xa + 0.24),
                     (zb - 0.24 if xa < 0 and xb < 0 else xb - 0.24),
                     ROOF_TOP + 0.10, top - 0.26,
                     abs(xa) if (xa < 0 and xb < 0) else abs(zb),
                     0.035, "CF_panel_dk", 3, 1, gap=0.12,
                     axis="-x" if (xa < 0 and xb < 0) else "+z")
    # scuppers
    for zc in (-2.4, 1.2):
        box(p, X0, LX - 0.10, ROOF_TOP + 0.05, ROOF_TOP + 0.17, zc - 0.10, zc + 0.10,
            "CF_gunmetal")

    # roof lantern over the vat bank: the interior glow leaves the building here
    lx0, lx1, lz0, lz1 = -4.28, -2.62, -1.62, 2.34
    box(p, lx0 - 0.10, lx1 + 0.10, ROOF_TOP, ROOF_TOP + 0.10, lz0 - 0.10, lz1 + 0.10,
        "CF_gunmetal")
    box(p, lx0, lx1, ROOF_TOP + 0.10, ROOF_TOP + 0.46, lz0, lz1, "CF_gunmetal",
        skip=("-y", "+y"))
    for i in range(1, 8):
        zc = lerp(lz0, lz1, i / 8)
        box(p, lx0, lx1, ROOF_TOP + 0.10, ROOF_TOP + 0.46, zc - 0.03, zc + 0.03, "CF_gunmetal")
    box(glass, lx0 + 0.03, lx1 - 0.03, ROOF_TOP + 0.28, ROOF_TOP + 0.30, lz0 + 0.03, lz1 - 0.03,
        "CF_Glass")
    box(p, lx0 - 0.12, lx1 + 0.12, ROOF_TOP + 0.46, ROOF_TOP + 0.56, lz0 - 0.12, lz1 + 0.12,
        "CF_roofmetal")

    # process hall
    hx0, hx1, hz0, hz1 = -1.95, 1.55, -3.05, -0.70
    hy0, hy1 = ROOF_TOP, ROOF_TOP + 1.16
    cham_box(p, hx0, hx1, hy0, hy1, hz0, hz1, "CF_panel", ch=0.05, top=False)
    box(p, hx0 - 0.07, hx1 + 0.07, hy1, hy1 + 0.09, hz0 - 0.07, hz1 + 0.07, "CF_roofmetal")
    box(p, hx0 - 0.03, hx1 + 0.03, hy0 + 0.86, hy0 + 0.95, hz0 - 0.03, hz1 + 0.03, "CF_bronze")
    louvers(p, hx0 + 0.16, hx1 - 0.16, hy0 + 0.74, 5, 0.135, abs(hz1), 0.05,
            "CF_gunmetal", axis="+z")
    recess_field(p, hz0 + 0.18, hz1 - 0.18, hy0 + 0.18, hy0 + 0.72, abs(hx1), 0.03,
                 "CF_panel_dk", 2, 1, axis="+x")
    for zc in (-2.6, -1.15):
        box(glow, hx1 + 0.001, hx1 + 0.02, hy0 + 1.02, hy0 + 1.20, zc - 0.14, zc + 0.14,
            "CF_GlowAmber")

    # filtration stack out of the process hall
    sx, sz = -1.05, -1.85
    cyl_y(p, sx, sz, 0.30, hy1, hy1 + 0.72, "CF_roofmetal", sides=16)
    tube_y(p, sx, sz, 0.30, 0.345, hy1 + 0.16, hy1 + 0.26, "CF_bronze", sides=16)
    tube_y(p, sx, sz, 0.30, 0.345, hy1 + 0.52, hy1 + 0.62, "CF_bronze", sides=16)
    lathe(p, sx, sz, [(0.30, hy1 + 0.72), (0.42, hy1 + 0.80), (0.42, hy1 + 0.86),
                      (0.30, hy1 + 0.88), (0.30, hy1 + 0.94), (0.0, hy1 + 1.00)],
          "CF_steel", sides=16)
    for a in (35.0, 155.0, 275.0):
        ax = sx + 0.30 * math.cos(math.radians(a))
        az = sz + 0.30 * math.sin(math.radians(a))
        pipe_run(p, [(ax, hy1 + 0.62, az),
                     (sx + 0.86 * math.cos(math.radians(a)), hy0 + 0.06,
                      sz + 0.86 * math.sin(math.radians(a)))],
                 0.028, "CF_steel", sides=6)

    # bio-reservoir: horizontal vessel on saddles, feeding the hall
    ty, tz, tr = ROOF_TOP + 0.86, 1.42, 0.60
    cyl_axis(p, "x", ty, tz, 1.34, 3.94, tr, "CF_biotank", sides=24, caps=False)
    for (xa, sgn) in ((1.34, -1.0), (3.94, 1.0)):
        prof = [(tr, xa), (tr * 0.94, xa + sgn * 0.10), (tr * 0.72, xa + sgn * 0.20),
                (0.0, xa + sgn * 0.27)]
        rings = []
        for r, xx in prof:
            ring = [(xx, ty + r * math.sin(math.radians(360 * k / 24)),
                     tz + r * math.cos(math.radians(360 * k / 24))) for k in range(24)]
            rings.append(ring)
        for k in range(len(rings) - 1):
            p.strip(rings[k], rings[k + 1], "CF_biotank")
    for xa in (1.72, 2.64, 3.56):
        ring = [(xa, ty + (tr + 0.035) * math.sin(math.radians(360 * k / 24)),
                 tz + (tr + 0.035) * math.cos(math.radians(360 * k / 24))) for k in range(24)]
        ring2 = [(xa + 0.075, q[1], q[2]) for q in ring]
        p.strip(ring, ring2, "CF_bronze")
        inner = [(xa, ty + tr * math.sin(math.radians(360 * k / 24)),
                  tz + tr * math.cos(math.radians(360 * k / 24))) for k in range(24)]
        inner2 = [(xa + 0.075, q[1], q[2]) for q in inner]
        p.strip(inner, ring, "CF_bronze")
        p.strip(inner2, ring2, "CF_bronze")
    box(p, 1.28, 4.02, ROOF_TOP + 0.05, ROOF_TOP + 0.13, tz - 0.62, tz + 0.62,
        "CF_gunmetal")
    for xa in (1.60, 3.68):
        box(p, xa - 0.12, xa + 0.12, ROOF_TOP, ty - tr + 0.10, tz - 0.52, tz + 0.52,
            "CF_gunmetal")
        p.quad((xa - 0.12, ty - tr + 0.10, tz - 0.52), (xa + 0.12, ty - tr + 0.10, tz - 0.52),
               (xa + 0.12, ty - tr * 0.55, tz - 0.30), (xa - 0.12, ty - tr * 0.55, tz - 0.30),
               "CF_gunmetal")
        p.quad((xa + 0.12, ty - tr + 0.10, tz + 0.52), (xa - 0.12, ty - tr + 0.10, tz + 0.52),
               (xa - 0.12, ty - tr * 0.55, tz + 0.30), (xa + 0.12, ty - tr * 0.55, tz + 0.30),
               "CF_gunmetal")
    # man-way and feed manifold
    cyl_y(p, 2.64, tz, 0.20, ty + tr - 0.02, ty + tr + 0.13, "CF_steel", sides=14)
    tube_y(p, 2.64, tz, 0.20, 0.245, ty + tr + 0.08, ty + tr + 0.13, "CF_bronze", sides=14)
    pipe_run(p, [(3.94, ty, tz), (4.28, ty, tz), (4.28, ROOF_TOP + 0.22, tz),
                 (4.28, ROOF_TOP + 0.22, -0.30), (2.10, ROOF_TOP + 0.22, -0.30),
                 (2.10, ROOF_TOP + 0.22, -1.10)], 0.085, "CF_steel", sides=10)
    for xa in (4.28, 3.10):
        cyl_y(p, xa, -0.30, 0.055, ROOF_TOP + 0.22, ROOF_TOP + 0.40, "CF_bronze", sides=8)
    # condenser bank, front right of the deck
    box(p, 1.70, 4.46, ROOF_TOP + 0.05, ROOF_TOP + 0.12, 1.98, 2.79, "CF_gunmetal")
    for i, xa in enumerate((2.15, 3.10, 4.05)):
        cham_box(p, xa - 0.40, xa + 0.40, ROOF_TOP + 0.12, ROOF_TOP + 0.62, 2.05, 2.72,
                 "CF_gunmetal", ch=0.03, top=True)
        for k in range(7):
            zc = lerp(2.10, 2.67, k / 6)
            box(p, xa - 0.36, xa + 0.36, ROOF_TOP + 0.56, ROOF_TOP + 0.60, zc - 0.018, zc + 0.018,
                "CF_steel")
        cyl_y(p, xa, 2.38, 0.24, ROOF_TOP + 0.60, ROOF_TOP + 0.66, "CF_steel", sides=12)
        tube_y(p, xa, 2.38, 0.24, 0.27, ROOF_TOP + 0.62, ROOF_TOP + 0.70, "CF_gunmetal", sides=12)
        if i == 1:
            box(glow, xa - 0.10, xa + 0.10, ROOF_TOP + 0.20, ROOF_TOP + 0.26, 2.03, 2.05,
                "CF_GlowAmber")
    # deck walkway grating between plant
    grate(p, -2.30, 1.90, 0.10, 0.86, ROOF_TOP + 0.07, "CF_steel", bars=11, along="x",
          thick=0.025)
    for zc in (0.10, 0.86):
        box(p, -2.30, 1.90, ROOF_TOP + 0.05, ROOF_TOP + 0.09, zc - 0.03, zc + 0.03, "CF_gunmetal")
    # handrail along the deck edge
    for zc in (0.06,):
        for xa in (-2.30, -0.20, 1.90):
            cyl_y(p, xa, zc, 0.022, ROOF_TOP + 0.07, ROOF_TOP + 0.95, "CF_steel", sides=6)
        cyl_axis(p, "x", ROOF_TOP + 0.95, zc, -2.30, 1.90, 0.022, "CF_steel", sides=6)
        cyl_axis(p, "x", ROOF_TOP + 0.52, zc, -2.30, 1.90, 0.018, "CF_steel", sides=6)


def build_door(p: Part, glow: Part):
    """The sliding bioseal leaf, authored around its own origin."""
    w, h, t = DOOR["panel_size"]
    hw, ht = w * 0.5, h
    box(p, -hw, hw, -h * 0.5, h * 0.5, -t * 0.5, t * 0.5, "CF_gunmetal")
    plate(p, -hw + 0.09, hw - 0.09, -h * 0.5 + 0.09, h * 0.5 - 0.09, t * 0.5, t * 0.5 + 0.028,
          "CF_steel", ch=0.022, axis="+z")
    plate(p, -hw + 0.09, hw - 0.09, -h * 0.5 + 0.09, h * 0.5 - 0.09, -t * 0.5, -t * 0.5 - 0.028,
          "CF_steel", ch=0.022, axis="-z")
    for yy in (-0.72, -0.24, 0.24, 0.72):
        box(p, -hw + 0.16, hw - 0.16, yy - 0.028, yy + 0.028, t * 0.5 + 0.028, t * 0.5 + 0.050,
            "CF_gunmetal")
    box(p, -hw + 0.02, hw - 0.02, h * 0.5 - 0.06, h * 0.5 - 0.02, -t * 0.5 - 0.03, t * 0.5 + 0.03,
        "CF_bronze")
    box(p, -hw + 0.02, hw - 0.02, -h * 0.5 + 0.02, -h * 0.5 + 0.06, -t * 0.5 - 0.03, t * 0.5 + 0.03,
        "CF_bronze")
    # leading-edge seal and grab rail
    box(p, hw - 0.045, hw, -h * 0.5 + 0.02, h * 0.5 - 0.02, -t * 0.5 - 0.02, t * 0.5 + 0.02,
        "CF_rubber")
    for zz in (t * 0.5 + 0.05, -t * 0.5 - 0.05):
        cyl_axis(p, "y", hw - 0.30, zz, -0.42, 0.42, 0.022, "CF_steel", sides=6)
        for yy in (-0.42, 0.42):
            cyl_axis(p, "z", hw - 0.30, yy, zz - 0.05 if zz > 0 else zz + 0.05, zz, 0.018,
                     "CF_steel", sides=6)
    # hazard chevrons on the leading third
    for i in range(6):
        y = -h * 0.5 + 0.14 + i * 0.36
        p.quad((hw - 0.42, y, t * 0.5 + 0.029), (hw - 0.10, y, t * 0.5 + 0.029),
               (hw - 0.10, y + 0.17, t * 0.5 + 0.029), (hw - 0.42, y + 0.17, t * 0.5 + 0.029),
               "CF_hazard" if i % 2 == 0 else "CF_gunmetal")
    # status bar
    box(glow, -hw + 0.22, -hw + 0.86, 0.62, 0.70, t * 0.5 + 0.028, t * 0.5 + 0.044, "CF_Glow")
    box(glow, -hw + 0.22, -hw + 0.86, 0.62, 0.70, -t * 0.5 - 0.044, -t * 0.5 - 0.028, "CF_Glow")
