"""Standalone canonical props: `clone_pod` and `clone_terminal`.

Both are one-cell world props.  The runtime fits a prop to its cell by uniform
scale from the FOOTPRINT alone (`client-3d/src/render/props.ts::composePlacement`),
so a 0.95 m authored footprint lands at exactly the 1.052632 placement scale the
facility uses, and everything inside — including a specimen — keeps parity with
the building it stands in.

`clone_pod` ships PRIMED: sealed, charged with culture fluid, amber standby, no
occupant.  That is the correct read for the pod a player is about to respawn
into, and the occupied-with-a-body story is told by the facility's built-in
vat B, where it belongs dramatically.
"""
from __future__ import annotations

import math

from cf_geom import (Part, box, cham_box, oct_plan, prism_y, frustum_y, cyl_y,
                     tube_y, cyl_axis, lathe, torus_y, pipe_run, plate,
                     recess_field, louvers, bolt_row, grate, ring_plan, lerp)
from cf_spec import PROPS

# ───────────────────────────── clone_pod ──────────────────────────────────

POD_FOOT = 0.95
POD_BASE_TOP = 0.50
POD_FOOT_PLATE = 0.56
POD_CHAMBER_TOP = 2.34
POD_CROWN_TOP = 2.52
POD_TOP = 2.68
POD_R = 0.425                        # + the 0.05 sill ring lands exactly on the
POD_R_GLASS = 0.392                  # 0.95 m footprint, which is what keeps the
POD_R_FLUID = 0.352                  # runtime placement scale at 1.052632
BACK_A0, BACK_A1 = 232.0, 308.0      # solid service spine, centred on -Z


def _arc(cx, cz, r, a0, a1, steps):
    return [(cx + r * math.cos(math.radians(lerp(a0, a1, i / steps))),
             cz + r * math.sin(math.radians(lerp(a0, a1, i / steps))))
            for i in range(steps + 1)]


def _band(p, r0, r1, y0, y1, mat, a0, a1, steps=8):
    o0 = [(q[0], y0, q[1]) for q in _arc(0.0, 0.0, r1, a0, a1, steps)]
    o1 = [(q[0], y1, q[1]) for q in _arc(0.0, 0.0, r1, a0, a1, steps)]
    i0 = [(q[0], y0, q[1]) for q in _arc(0.0, 0.0, r0, a0, a1, steps)]
    i1 = [(q[0], y1, q[1]) for q in _arc(0.0, 0.0, r0, a0, a1, steps)]
    p.strip(o0, o1, mat, closed=False)
    p.strip(i1, i0, mat, closed=False)
    for i in range(steps):
        p.quad(o1[i], o1[i + 1], i1[i + 1], i1[i], mat)
        p.quad(i0[i], i0[i + 1], o0[i + 1], o0[i], mat)
    p.quad(o0[0], o1[0], i1[0], i0[0], mat)
    p.quad(i0[-1], i1[-1], o1[-1], o0[-1], mat)


def build_clone_pod(solid: Part, glass: Part, fluid: Part, glow: Part):
    half = POD_FOOT * 0.5
    # ---- plinth ----------------------------------------------------------
    cham_box(solid, -half, half, 0.0, 0.13, -half, half, "CF_gunmetal", ch=0.035, top=True)
    for (fx, fz) in ((-0.33, -0.33), (0.33, -0.33), (-0.33, 0.33), (0.33, 0.33)):
        cyl_y(solid, fx, fz, 0.055, 0.0, 0.05, "CF_steel", sides=8)
    grate(solid, -0.19, 0.19, 0.16, 0.44, 0.14, "CF_steel", bars=7, along="x", thick=0.012)
    box(solid, -0.22, 0.22, 0.10, 0.145, 0.13, 0.455, "CF_gunmetal")

    # ---- machine base ----------------------------------------------------
    plan = oct_plan(-half + 0.03, half - 0.03, -half + 0.03, half - 0.03, 0.10)
    prism_y(solid, plan, 0.13, POD_BASE_TOP - 0.05, "CF_enamel", cap_lo=False, cap_hi=False)
    frustum_y(solid, plan, POD_BASE_TOP - 0.05,
              oct_plan(-half + 0.08, half - 0.08, -half + 0.08, half - 0.08, 0.10),
              POD_BASE_TOP, "CF_enamel", cap_lo=False, cap_hi=True)
    plate(solid, -0.28, 0.28, 0.20, POD_BASE_TOP - 0.10, half - 0.06, half - 0.012,
          "CF_enamel", ch=0.016, axis="+z")
    louvers(solid, -0.24, -0.02, POD_BASE_TOP - 0.15, 3, 0.075, half - 0.012, 0.026,
            "CF_gunmetal", axis="+z")
    bolt_row(solid, [(0.22, 0.24), (0.22, POD_BASE_TOP - 0.15)], half - 0.022,
             "CF_steel", r=0.016, h=0.009, axis="+z")
    plate(solid, 0.02, 0.24, 0.24, 0.38, half - 0.012, half - 0.001, "CF_bronze",
          ch=0.009, axis="+z")
    # sill ring
    tube_y(solid, 0.0, 0.0, POD_R - 0.06, POD_R + 0.05, POD_BASE_TOP - 0.09,
           POD_BASE_TOP, "CF_steel", sides=24)
    torus_y(solid, 0.0, POD_BASE_TOP + 0.014, 0.0, POD_R + 0.014, 0.030, "CF_bronze",
            major_sides=24, minor_sides=6)

    # ---- chamber ---------------------------------------------------------
    _band(solid, POD_R - 0.05, POD_R, POD_BASE_TOP, POD_CHAMBER_TOP, "CF_enamel",
          BACK_A0, BACK_A1, steps=6)
    _band(solid, POD_R - 0.058, POD_R - 0.05, POD_BASE_TOP, POD_CHAMBER_TOP,
          "CF_gunmetal", BACK_A0 - 6.0, BACK_A1 + 6.0, steps=8)
    for a in (BACK_A0, 0.0, 62.0, 118.0, 180.0, BACK_A1):
        cyl_y(solid, POD_R * math.cos(math.radians(a)), POD_R * math.sin(math.radians(a)),
              0.033, POD_BASE_TOP - 0.02, POD_CHAMBER_TOP + 0.02, "CF_gunmetal", sides=8)
    span = _arc(0.0, 0.0, POD_R_GLASS, BACK_A1, BACK_A0 + 360.0, 18)
    lo = [(q[0], POD_BASE_TOP + 0.02, q[1]) for q in span]
    hi = [(q[0], POD_CHAMBER_TOP - 0.02, q[1]) for q in span]
    glass.strip(lo, hi, "CF_GlassClear", closed=False)
    tube_y(solid, 0.0, 0.0, POD_R - 0.05, POD_R + 0.045, POD_CHAMBER_TOP,
           POD_CHAMBER_TOP + 0.10, "CF_steel", sides=24)
    torus_y(solid, 0.0, POD_CHAMBER_TOP - 0.014, 0.0, POD_R + 0.014, 0.028, "CF_bronze",
            major_sides=24, minor_sides=6)

    # cradle: foot plate, heel cups, spine post, cranial cradle
    cyl_y(solid, 0.0, 0.0, POD_R - 0.09, POD_BASE_TOP + 0.02, POD_FOOT_PLATE,
          "CF_steel", sides=20)
    for dx in (-0.105, 0.105):
        lathe(solid, dx, -0.04, [(0.100, POD_FOOT_PLATE), (0.106, POD_FOOT_PLATE + 0.026),
                                 (0.084, POD_FOOT_PLATE + 0.046), (0.0, POD_FOOT_PLATE + 0.050)],
              "CF_rubber", sides=10)
    cyl_y(solid, 0.0, -POD_R + 0.13, 0.040, POD_FOOT_PLATE, POD_FOOT_PLATE + 1.56,
          "CF_steel", sides=8)
    _cradle(solid, -POD_R + 0.155, POD_FOOT_PLATE + 1.46)
    # backlit diffuser strip behind the specimen station
    _band(glow, POD_R - 0.072, POD_R - 0.062, POD_BASE_TOP + 0.30, POD_CHAMBER_TOP - 0.26,
          "CF_Glow", 262.0, 278.0, steps=2)

    # primed: charged with culture fluid, no occupant
    surface = POD_CHAMBER_TOP - 0.11
    cyl_y(fluid, 0.0, 0.0, POD_R_FLUID, POD_BASE_TOP + 0.05, surface, "CF_Fluid",
          sides=24, cap_lo=False, cap_hi=True)
    torus_y(solid, 0.0, surface, 0.0, POD_R_FLUID + 0.004, 0.011, "CF_bronze",
            major_sides=24, minor_sides=5)
    tube_y(glow, 0.0, 0.0, POD_R - 0.10, POD_R - 0.055, POD_BASE_TOP + 0.006,
           POD_BASE_TOP + 0.026, "CF_GlowAmber", sides=24)
    tube_y(glow, 0.0, 0.0, POD_R - 0.14, POD_R - 0.075, POD_CHAMBER_TOP - 0.045,
           POD_CHAMBER_TOP - 0.025, "CF_Glow", sides=24)

    # ---- crown -----------------------------------------------------------
    cp = oct_plan(-0.34, 0.34, -0.34, 0.34, 0.09)
    prism_y(solid, cp, POD_CHAMBER_TOP + 0.10, POD_CROWN_TOP - 0.05, "CF_enamel",
            cap_lo=False, cap_hi=False)
    frustum_y(solid, cp, POD_CROWN_TOP - 0.05, oct_plan(-0.28, 0.28, -0.28, 0.28, 0.08),
              POD_CROWN_TOP, "CF_enamel", cap_lo=False, cap_hi=True)
    for dx in (-0.24, 0.24):
        lathe(solid, dx, -0.24, [(0.0, POD_CROWN_TOP + 0.01), (0.075, POD_CROWN_TOP + 0.04),
                                 (0.088, POD_CROWN_TOP + 0.10), (0.088, POD_TOP - 0.10),
                                 (0.062, POD_TOP - 0.04), (0.0, POD_TOP - 0.02)],
              "CF_steel", sides=12)
        pipe_run(solid, [(dx, POD_CROWN_TOP + 0.04, -0.24), (dx, POD_CROWN_TOP - 0.02, -0.12),
                         (dx * 0.55, POD_CHAMBER_TOP + 0.14, -0.12)], 0.034, "CF_steel",
                 sides=8)
    cyl_axis(solid, "z", 0.0, POD_CROWN_TOP - 0.11, 0.30, 0.38, 0.075, "CF_steel", sides=14)
    cyl_axis(glow, "z", 0.0, POD_CROWN_TOP - 0.11, 0.38, 0.392, 0.060, "CF_GlowWarm",
             sides=14)
    torus_y(solid, 0.0, POD_TOP + 0.03, 0.16, 0.055, 0.016, "CF_steel",
            major_sides=12, minor_sides=6)

    # ---- status column and umbilicals -----------------------------------
    sx = POD_R - 0.03
    box(solid, sx - 0.055, sx + 0.055, POD_BASE_TOP + 0.12, POD_CHAMBER_TOP - 0.10,
        0.26, 0.38, "CF_gunmetal")
    for i, mat in enumerate(("CF_GlowAmber", "CF_GlowAmber", "CF_gunmetal", "CF_gunmetal")):
        y = POD_BASE_TOP + 0.22 + i * 0.34
        target = glow if mat.startswith("CF_Glow") else solid
        box(target, sx - 0.042, sx + 0.042, y, y + 0.22, 0.382, 0.396, mat)
    for run in ([(-0.20, POD_CROWN_TOP - 0.04, -0.30), (-0.24, POD_CHAMBER_TOP - 0.40, -0.36),
                 (-0.26, POD_BASE_TOP + 0.30, -0.36), (-0.26, 0.24, -0.33)],
                [(-0.30, POD_CROWN_TOP - 0.08, -0.24), (-0.34, POD_CHAMBER_TOP - 0.70, -0.30),
                 (-0.34, POD_BASE_TOP + 0.20, -0.30), (-0.34, 0.20, -0.27)]):
        pipe_run(solid, run, 0.034, "CF_rubber", sides=7)
        for k in (1, len(run) - 2):
            pt = run[k]
            torus_y(solid, pt[0], pt[1], pt[2], 0.046, 0.013, "CF_steel",
                    major_sides=8, minor_sides=5)


def _cradle(p: Part, z, y):
    arc = _arc(0.0, z, 0.150, -30.0, 210.0, 8)
    lo = [(q[0], y, q[1]) for q in arc]
    hi = [(q[0], y + 0.072, q[1]) for q in arc]
    p.strip(lo, hi, "CF_rubber", closed=False)
    arc2 = _arc(0.0, z, 0.112, -30.0, 210.0, 8)
    lo2 = [(q[0], y, q[1]) for q in arc2]
    hi2 = [(q[0], y + 0.072, q[1]) for q in arc2]
    p.strip(hi2, lo2, "CF_rubber", closed=False)
    for i in range(8):
        p.quad(hi[i], hi[i + 1], hi2[i + 1], hi2[i], "CF_rubber")
        p.quad(lo2[i], lo2[i + 1], lo[i + 1], lo[i], "CF_rubber")
    cyl_axis(p, "z", 0.0, y + 0.035, z - 0.10, z, 0.028, "CF_steel", sides=6)


# ─────────────────────────── clone_terminal ───────────────────────────────

TERM_W, TERM_D = 0.92, 0.66
TERM_TOP = 1.74


def build_clone_terminal(solid: Part, screen: Part, glow: Part):
    hw, hd = TERM_W * 0.5, TERM_D * 0.5
    # splayed foot with a cable gland
    frustum_y(solid, oct_plan(-0.34, 0.34, -0.24, 0.24, 0.06), 0.0,
              oct_plan(-0.26, 0.26, -0.18, 0.18, 0.05), 0.10, "CF_gunmetal",
              cap_lo=True, cap_hi=False)
    box(solid, -0.26, 0.26, 0.10, 0.14, -0.18, 0.18, "CF_bronze")
    cyl_y(solid, 0.0, -0.14, 0.055, 0.02, 0.16, "CF_gunmetal", sides=10)
    pipe_run(solid, [(0.0, 0.10, -0.14), (0.0, 0.055, -0.30), (0.18, 0.038, -0.42)],
             0.030, "CF_rubber", sides=6)

    # column
    cham_box(solid, -0.22, 0.22, 0.14, 0.84, -0.16, 0.16, "CF_enamel", ch=0.03, top=False)
    box(solid, -0.24, 0.24, 0.50, 0.57, -0.18, 0.18, "CF_bronze")
    recess_field(solid, -0.17, 0.17, 0.22, 0.46, 0.16, 0.028, "CF_panel_dk", 1, 1,
                 axis="+z")

    # deck
    cham_box(solid, -hw, hw, 0.84, 0.96, -hd, hd, "CF_enamel", ch=0.028, top=True)
    box(solid, -hw - 0.018, hw + 0.018, 0.90, 0.955, -hd - 0.018, hd + 0.018, "CF_bronze")
    # raked control deck facing the operator (+Z)
    solid.quad((-0.38, 0.96, 0.10), (0.38, 0.96, 0.10), (0.38, 1.05, -0.16),
               (-0.38, 1.05, -0.16), "CF_gunmetal")
    solid.tri((-0.38, 0.96, 0.10), (-0.38, 1.05, -0.16), (-0.38, 0.96, -0.16), "CF_gunmetal")
    solid.tri((0.38, 1.05, -0.16), (0.38, 0.96, 0.10), (0.38, 0.96, -0.16), "CF_gunmetal")
    solid.quad((-0.38, 0.96, -0.16), (-0.38, 1.05, -0.16), (0.38, 1.05, -0.16),
               (0.38, 0.96, -0.16), "CF_gunmetal")
    for r in range(2):
        for k in range(7):
            x = lerp(-0.32, 0.32, k / 6)
            z = 0.02 - r * 0.10
            y = 0.99 + r * 0.035
            cyl_y(solid, x, z, 0.017, y, y + 0.022,
                  "CF_bronze" if (k + r) % 3 == 0 else "CF_steel", sides=6)
    # palm reader inset
    box(solid, 0.16, 0.36, 0.958, 0.966, 0.16, 0.34, "CF_gunmetal")
    box(glow, 0.175, 0.345, 0.966, 0.970, 0.175, 0.325, "CF_Glow")
    # sample dock on the left of the deck
    cyl_y(solid, -0.30, 0.24, 0.062, 0.96, 1.02, "CF_steel", sides=12)
    tube_y(solid, -0.30, 0.24, 0.062, 0.078, 1.00, 1.02, "CF_bronze", sides=12)
    lathe(solid, -0.30, 0.24, [(0.0, 1.02), (0.038, 1.04), (0.038, 1.16),
                               (0.026, 1.19), (0.0, 1.20)], "CF_biotank", sides=10)

    # screen head, raked back 16 degrees
    y0, y1 = 1.04, 1.56
    zf0, zf1 = 0.06, -0.09
    bez = 0.045
    solid.quad((-0.42, y0, zf0), (0.42, y0, zf0), (0.42, y1, zf1), (-0.42, y1, zf1),
               "CF_gunmetal")
    solid.quad((0.42, y0, zf0 - 0.09), (-0.42, y0, zf0 - 0.09),
               (-0.42, y1, zf1 - 0.09), (0.42, y1, zf1 - 0.09), "CF_enamel")
    for (a, b) in ((-0.42, -0.42), (0.42, 0.42)):
        solid.quad((a, y0, zf0), (a, y1, zf1), (b, y1, zf1 - 0.09), (b, y0, zf0 - 0.09),
                   "CF_gunmetal")
    solid.quad((-0.42, y1, zf1), (0.42, y1, zf1), (0.42, y1, zf1 - 0.09),
               (-0.42, y1, zf1 - 0.09), "CF_gunmetal")
    solid.quad((0.42, y0, zf0), (-0.42, y0, zf0), (-0.42, y0, zf0 - 0.09),
               (0.42, y0, zf0 - 0.09), "CF_gunmetal")
    sx0, sx1 = -0.42 + bez, 0.42 - bez
    sy0, sy1 = y0 + bez, y1 - bez
    t0 = zf0 + (zf1 - zf0) * (bez / (y1 - y0)) + 0.004
    t1 = zf0 + (zf1 - zf0) * ((y1 - y0 - bez) / (y1 - y0)) + 0.004
    screen.quad((sx0, sy0, t0), (sx1, sy0, t0), (sx1, sy1, t1), (sx0, sy1, t1), "CF_Screen")

    # crown band and status column
    box(solid, -0.44, 0.44, y1, y1 + 0.05, zf1 - 0.10, zf1 + 0.02, "CF_bronze")
    box(solid, -0.10, 0.10, y1 + 0.05, TERM_TOP - 0.05, zf1 - 0.09, zf1 - 0.01,
        "CF_gunmetal")
    for i in range(3):
        yy = y1 + 0.09 + i * 0.05
        box(glow, -0.07, 0.07, yy, yy + 0.03, zf1 - 0.002, zf1 + 0.008,
            "CF_Glow" if i < 2 else "CF_GlowAmber")
    lathe(solid, 0.0, zf1 - 0.05, [(0.09, TERM_TOP - 0.05), (0.09, TERM_TOP - 0.02),
                                   (0.05, TERM_TOP)], "CF_steel", sides=10)
