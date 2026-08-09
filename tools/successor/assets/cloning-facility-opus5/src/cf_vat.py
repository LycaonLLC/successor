"""The cloning vat family.

One authored unit, three states, used by the facility's built-in bank and by
the standalone `clone_pod` props.  The unit is built in a LOCAL frame — origin
on its own floor, front toward +X, width along Z — and placed with
`cf_geom.merge`.

Scale discipline: the chamber's clear internal volume is 0.89 m across and
1.96 m tall, so a 1.725 m pawn stands in it with 0.23 m of head room.  That
number, not the silhouette, is what makes the room read as person-scale.
"""
from __future__ import annotations

import math

from cf_geom import (Part, box, cham_box, oct_plan, prism_y, frustum_y, cyl_y,
                     tube_y, cyl_axis, lathe, torus_y, pipe_run, plate,
                     recess_field, louvers, bolt_row, grate, ring_plan, lerp,
                     merge)
from cf_spec import VAT_BANK, GANTRY, PAWN_HEIGHT_M

# local-frame constants -----------------------------------------------------
DEPTH = VAT_BANK["depth"]        # 1.18 along +X, 0 at the back plane
WIDTH = VAT_BANK["width"]        # 1.14 along Z, centred on 0
HEIGHT = VAT_BANK["height"]      # 2.62

BASE_TOP = 0.44                  # top of the machine base / chamber sill
FOOT_PLATE = BASE_TOP + 0.08     # the surface an occupant actually stands on
CHAMBER_TOP = 2.40               # top of the glazed chamber
CROWN_TOP = 2.62
R_OUT = 0.52                     # chamber outer radius
R_GLASS = 0.485
R_FLUID = 0.445
CX = 0.54                        # chamber centre along +X inside the unit


def _arc(cx, cz, r, a0, a1, steps):
    return [(cx + r * math.cos(math.radians(lerp(a0, a1, i / steps))),
             cz + r * math.sin(math.radians(lerp(a0, a1, i / steps))))
            for i in range(steps + 1)]


def _shell_band(p, r0, r1, y0, y1, mat, a0=100.0, a1=260.0, steps=12):
    """Back half-shell band: an arc swept between two radii and heights."""
    outer0 = [(q[0], y0, q[1]) for q in _arc(CX, 0.0, r1, a0, a1, steps)]
    outer1 = [(q[0], y1, q[1]) for q in _arc(CX, 0.0, r1, a0, a1, steps)]
    inner0 = [(q[0], y0, q[1]) for q in _arc(CX, 0.0, r0, a0, a1, steps)]
    inner1 = [(q[0], y1, q[1]) for q in _arc(CX, 0.0, r0, a0, a1, steps)]
    p.strip(outer0, outer1, mat, closed=False)
    p.strip(inner1, inner0, mat, closed=False)
    for i in range(steps):
        p.quad(outer1[i], outer1[i + 1], inner1[i + 1], inner1[i], mat)
        p.quad(inner0[i], inner0[i + 1], outer0[i + 1], outer0[i], mat)
    p.quad(outer0[0], outer1[0], inner1[0], inner0[0], mat)
    p.quad(inner0[-1], inner1[-1], outer1[-1], outer0[-1], mat)


def _machine_base(p: Part):
    # sump plinth with a chamfered top and levelling feet
    cham_box(p, -0.02, DEPTH, 0.0, 0.16, -WIDTH * 0.5, WIDTH * 0.5, "CF_gunmetal",
             ch=0.03, top=True)
    for (fx, fz) in ((0.14, -0.44), (0.14, 0.44), (DEPTH - 0.16, -0.44), (DEPTH - 0.16, 0.44)):
        cyl_y(p, fx, fz, 0.055, 0.0, 0.055, "CF_steel", sides=8)
    # enamelled body
    cham_box(p, 0.0, DEPTH - 0.02, 0.16, BASE_TOP, -WIDTH * 0.5 + 0.02, WIDTH * 0.5 - 0.02,
             "CF_enamel", ch=0.035, top=True)
    # service door with latches and a louvered return-air panel
    plate(p, -0.42, 0.42, 0.24, BASE_TOP - 0.10, DEPTH - 0.02, DEPTH + 0.012,
          "CF_enamel", ch=0.018, axis="+x")
    louvers(p, -0.34, -0.02, BASE_TOP - 0.16, 4, 0.075, DEPTH + 0.012, 0.028,
            "CF_gunmetal", axis="+x")
    bolt_row(p, [(0.36, 0.30), (0.36, BASE_TOP - 0.16)], DEPTH + 0.012, "CF_steel",
             r=0.017, h=0.010, axis="+x")
    # bronze data plate
    plate(p, 0.06, 0.36, 0.28, 0.44, DEPTH + 0.012, DEPTH + 0.026, "CF_bronze",
          ch=0.010, axis="+x")
    # drain channel and grate under the chamber
    box(p, CX - 0.30, CX + 0.30, 0.16, 0.185, -0.20, 0.20, "CF_gunmetal")
    grate(p, CX - 0.28, CX + 0.28, -0.18, 0.18, 0.20, "CF_steel", bars=7, along="x",
          thick=0.014)
    # chamber sill ring
    tube_y(p, CX, 0.0, R_OUT - 0.06, R_OUT + 0.045, BASE_TOP - 0.09, BASE_TOP, "CF_steel",
           sides=24)
    torus_y(p, CX, BASE_TOP + 0.012, 0.0, R_OUT + 0.012, 0.030, "CF_bronze",
            major_sides=24, minor_sides=6)


def _chamber(p: Part, glass: Part, fluid: Part, glow: Part, state: str):
    # Rear half-shell: enamel outside, DARK liner inside.  The liner is the
    # single most load-bearing decision in the whole unit -- a pale specimen in
    # front of a white shell is a silhouette-free smudge, and in front of a
    # gunmetal one it reads instantly.
    _shell_band(p, R_OUT - 0.05, R_OUT, BASE_TOP, CHAMBER_TOP, "CF_enamel")
    _shell_band(p, R_OUT - 0.058, R_OUT - 0.05, BASE_TOP, CHAMBER_TOP, "CF_gunmetal",
                a0=96.0, a1=264.0, steps=14)
    # backlit diffuser column behind the specimen
    _shell_band(glow, R_OUT - 0.072, R_OUT - 0.062, BASE_TOP + 0.30, CHAMBER_TOP - 0.26,
                "CF_Glow", a0=172.0, a1=188.0, steps=2)
    # vertical ribs on the shell back
    for a in (118.0, 152.0, 180.0, 208.0, 242.0):
        ax = CX + (R_OUT + 0.02) * math.cos(math.radians(a))
        az = (R_OUT + 0.02) * math.sin(math.radians(a))
        cyl_y(p, ax, az, 0.030, BASE_TOP + 0.06, CHAMBER_TOP - 0.06, "CF_steel", sides=6)
    # glazed front: mullions at the two jambs plus two intermediates
    jamb = [-80.0, -27.0, 27.0, 80.0]
    for a in jamb:
        ax = CX + R_OUT * math.cos(math.radians(a))
        az = R_OUT * math.sin(math.radians(a))
        cyl_y(p, ax, az, 0.036, BASE_TOP - 0.02, CHAMBER_TOP + 0.02, "CF_gunmetal", sides=8)
    if state == "empty":
        # front glazing swung open on the left jamb: unmistakably vacant
        hinge_a = math.radians(80.0)
        hx = CX + R_OUT * math.cos(hinge_a)
        hz = R_OUT * math.sin(hinge_a)
        span = _arc(CX, 0.0, R_GLASS, -80.0, 80.0, 8)
        open_deg = 62.0
        ca, sa = math.cos(math.radians(open_deg)), math.sin(math.radians(open_deg))
        moved = []
        for (qx, qz) in span:
            rx, rz = qx - hx, qz - hz
            moved.append((hx + rx * ca - rz * sa, hz + rx * sa + rz * ca))
        lo = [(q[0], BASE_TOP + 0.02, q[1]) for q in moved]
        hi = [(q[0], CHAMBER_TOP - 0.02, q[1]) for q in moved]
        glass.strip(lo, hi, "CF_GlassClear", closed=False)
        # canopy frame
        for k in (0, len(moved) - 1):
            cyl_y(p, moved[k][0], moved[k][1], 0.026, BASE_TOP + 0.0, CHAMBER_TOP,
                  "CF_gunmetal", sides=6)
        p.strip([(q[0], CHAMBER_TOP, q[1]) for q in moved],
                [(q[0], CHAMBER_TOP + 0.035, q[1]) for q in moved],
                "CF_gunmetal", closed=False)
        p.strip([(q[0], BASE_TOP - 0.035, q[1]) for q in moved],
                [(q[0], BASE_TOP, q[1]) for q in moved], "CF_gunmetal", closed=False)
    else:
        span = _arc(CX, 0.0, R_GLASS, -80.0, 80.0, 12)
        lo = [(q[0], BASE_TOP + 0.02, q[1]) for q in span]
        hi = [(q[0], CHAMBER_TOP - 0.02, q[1]) for q in span]
        glass.strip(lo, hi, "CF_GlassClear", closed=False)
    # top collar
    tube_y(p, CX, 0.0, R_OUT - 0.05, R_OUT + 0.04, CHAMBER_TOP, CHAMBER_TOP + 0.10,
           "CF_steel", sides=24)
    torus_y(p, CX, CHAMBER_TOP - 0.012, 0.0, R_OUT + 0.012, 0.028, "CF_bronze",
            major_sides=24, minor_sides=6)
    # interior cradle: foot plate with heel cups, spine post, cranial cradle
    cyl_y(p, CX, 0.0, R_OUT - 0.09, BASE_TOP + 0.02, FOOT_PLATE, "CF_steel", sides=20)
    for dz in (-0.105, 0.105):
        lathe(p, CX - 0.04, dz, [(0.105, FOOT_PLATE), (0.110, FOOT_PLATE + 0.028),
                                 (0.088, FOOT_PLATE + 0.048), (0.0, FOOT_PLATE + 0.052)],
              "CF_rubber", sides=10)
    cyl_y(p, CX - R_OUT + 0.13, 0.0, 0.042, FOOT_PLATE, FOOT_PLATE + 1.58,
          "CF_steel", sides=8)
    _cradle(p, CX - R_OUT + 0.155, FOOT_PLATE + 1.48)
    # umbilical dock inside the chamber, at navel height
    if state == "occupied":
        pipe_run(p, [(CX - R_OUT + 0.16, FOOT_PLATE + 0.98, 0.0),
                     (CX - 0.12, FOOT_PLATE + 1.00, 0.0),
                     (CX + 0.02, FOOT_PLATE + 1.04, 0.0)], 0.030, "CF_rubber", sides=6)
        cyl_axis(p, "x", FOOT_PLATE + 1.04, 0.0, CX + 0.02, CX + 0.11, 0.042, "CF_steel",
                 sides=8)
    # fluid volume
    if state in ("occupied", "primed"):
        surface = CHAMBER_TOP - 0.11
        cyl_y(fluid, CX, 0.0, R_FLUID, BASE_TOP + 0.05, surface, "CF_Fluid",
              sides=24, cap_lo=False, cap_hi=True)
        # meniscus ring so the fill level is a read, not an accident of alpha
        torus_y(p, CX, surface, 0.0, R_FLUID + 0.004, 0.012, "CF_bronze",
                major_sides=24, minor_sides=5)
    # sill uplight ring and crown downlight
    tube_y(glow, CX, 0.0, R_OUT - 0.10, R_OUT - 0.055, BASE_TOP + 0.005, BASE_TOP + 0.025,
           "CF_Glow" if state != "primed" else "CF_GlowAmber", sides=24)
    tube_y(glow, CX, 0.0, R_OUT - 0.14, R_OUT - 0.075, CHAMBER_TOP - 0.045,
           CHAMBER_TOP - 0.025, "CF_Glow", sides=24)


def _cradle(p: Part, x, y):
    """Cranial cradle: a padded horseshoe on a short arm."""
    arc = _arc(x, 0.0, 0.155, -120.0, 120.0, 8)
    lo = [(q[0], y, q[1]) for q in arc]
    hi = [(q[0], y + 0.075, q[1]) for q in arc]
    p.strip(lo, hi, "CF_rubber", closed=False)
    arc2 = _arc(x, 0.0, 0.115, -120.0, 120.0, 8)
    lo2 = [(q[0], y, q[1]) for q in arc2]
    hi2 = [(q[0], y + 0.075, q[1]) for q in arc2]
    p.strip(hi2, lo2, "CF_rubber", closed=False)
    for i in range(8):
        p.quad(hi[i], hi[i + 1], hi2[i + 1], hi2[i], "CF_rubber")
        p.quad(lo2[i], lo2[i + 1], lo[i + 1], lo[i], "CF_rubber")
    cyl_axis(p, "x", y + 0.035, 0.0, x - 0.10, x, 0.030, "CF_steel", sides=6)


def _crown(p: Part, glow: Part, state: str):
    """Head-end plant: valve block, pressure vessel stub, gauge, lift eye."""
    cham_box(p, 0.06, DEPTH - 0.06, CHAMBER_TOP + 0.10, CROWN_TOP,
             -WIDTH * 0.5 + 0.06, WIDTH * 0.5 - 0.06, "CF_enamel", ch=0.035, top=True)
    box(p, 0.16, DEPTH - 0.16, CROWN_TOP, CROWN_TOP + 0.06, -0.30, 0.30, "CF_gunmetal")
    # accumulator bottles either side
    for dz in (-0.36, 0.36):
        lathe(p, 0.34, dz, [(0.0, CROWN_TOP + 0.02), (0.09, CROWN_TOP + 0.05),
                            (0.105, CROWN_TOP + 0.12), (0.105, HEIGHT - 0.14),
                            (0.075, HEIGHT - 0.05), (0.0, HEIGHT - 0.02)],
              "CF_steel", sides=12)
        cyl_y(p, 0.34, dz, 0.030, HEIGHT - 0.05, HEIGHT + 0.02, "CF_bronze", sides=8)
    # valve tree feeding the chamber
    pipe_run(p, [(0.34, CROWN_TOP + 0.05, -0.36), (0.34, CROWN_TOP + 0.02, -0.18),
                 (0.62, CROWN_TOP + 0.02, -0.18), (0.62, CHAMBER_TOP + 0.12, -0.18)],
             0.038, "CF_steel", sides=8)
    pipe_run(p, [(0.34, CROWN_TOP + 0.05, 0.36), (0.34, CROWN_TOP + 0.02, 0.18),
                 (0.62, CROWN_TOP + 0.02, 0.18), (0.62, CHAMBER_TOP + 0.12, 0.18)],
             0.038, "CF_steel", sides=8)
    for dz in (-0.18, 0.18):
        cyl_axis(p, "z", 0.62, CROWN_TOP + 0.02, dz - 0.055, dz + 0.055, 0.055,
                 "CF_bronze", sides=8)
        cyl_axis(p, "z", 0.62, CROWN_TOP + 0.02, dz + 0.055, dz + 0.10, 0.022,
                 "CF_gunmetal", sides=6)
    # gauge face, angled toward the room
    cyl_axis(p, "x", CROWN_TOP - 0.14, -0.02, DEPTH - 0.06, DEPTH + 0.03, 0.085,
             "CF_steel", sides=14)
    cyl_axis(glow if state != "empty" else p, "x", CROWN_TOP - 0.14, -0.02,
             DEPTH + 0.03, DEPTH + 0.042, 0.068,
             "CF_GlowWarm" if state != "empty" else "CF_gunmetal", sides=14)
    # lift eye
    torus_y(p, 0.62, HEIGHT + 0.06, 0.0, 0.062, 0.018, "CF_steel",
            major_sides=12, minor_sides=6)


def _status_column(p: Part, glow: Part, state: str):
    """Vertical light stack on the right jamb: the at-a-glance state read."""
    zx = WIDTH * 0.5 - 0.055
    box(p, DEPTH - 0.20, DEPTH - 0.06, BASE_TOP + 0.12, CHAMBER_TOP - 0.10,
        zx - 0.055, zx + 0.055, "CF_gunmetal")
    lamps = {"occupied": ["CF_Glow", "CF_Glow", "CF_Glow", "CF_gunmetal"],
             "primed": ["CF_GlowAmber", "CF_GlowAmber", "CF_gunmetal", "CF_gunmetal"],
             "empty": ["CF_gunmetal", "CF_gunmetal", "CF_gunmetal", "CF_GlowAmber"]}[state]
    for i, mat in enumerate(lamps):
        y = BASE_TOP + 0.22 + i * 0.30
        target = glow if mat.startswith("CF_Glow") else p
        box(target, DEPTH - 0.062, DEPTH - 0.046, y, y + 0.20, zx - 0.042, zx + 0.042, mat)
    # engraved unit index: a run of bronze pips, not a wordmark
    for i in range(3):
        box(p, DEPTH - 0.05, DEPTH - 0.036, CHAMBER_TOP - 0.06 - i * 0.05,
            CHAMBER_TOP - 0.028 - i * 0.05, zx - 0.03, zx + 0.03, "CF_bronze")


def _umbilicals(p: Part, state: str):
    """Loomed hoses from the crown down the left jamb into the base."""
    zx = -WIDTH * 0.5 + 0.10
    if state == "empty":
        runs = [[(0.30, CROWN_TOP - 0.02, zx), (0.24, CHAMBER_TOP - 0.30, zx - 0.02),
                 (0.30, BASE_TOP + 0.55, zx + 0.05), (0.46, BASE_TOP + 0.18, zx + 0.02),
                 (0.72, BASE_TOP + 0.06, zx - 0.01)],
                [(0.22, CROWN_TOP - 0.06, zx + 0.09), (0.16, CHAMBER_TOP - 0.55, zx + 0.06),
                 (0.20, BASE_TOP + 0.30, zx + 0.12)]]
    else:
        runs = [[(0.30, CROWN_TOP - 0.02, zx), (0.26, CHAMBER_TOP - 0.40, zx - 0.01),
                 (0.24, BASE_TOP + 0.40, zx), (0.30, 0.30, zx + 0.02), (0.30, 0.20, zx + 0.02)],
                [(0.20, CROWN_TOP - 0.06, zx + 0.10), (0.17, CHAMBER_TOP - 0.70, zx + 0.09),
                 (0.17, BASE_TOP + 0.24, zx + 0.09), (0.17, 0.24, zx + 0.09)]]
    for run in runs:
        pipe_run(p, run, 0.036, "CF_rubber", sides=7)
        for k in (1, len(run) - 2):
            pt = run[k]
            torus_y(p, pt[0], pt[1], pt[2], 0.048, 0.014, "CF_steel",
                    major_sides=8, minor_sides=5)


def vat_unit(state: str) -> tuple[Part, Part, Part, Part]:
    """Return (solid, glass, fluid, glow) parts for one vat in local frame."""
    p = Part(f"vat_{state}")
    glass = Part(f"vat_{state}_glass")
    fluid = Part(f"vat_{state}_fluid")
    glow = Part(f"vat_{state}_glow")
    _machine_base(p)
    _chamber(p, glass, fluid, glow, state)
    _crown(p, glow, state)
    _status_column(p, glow, state)
    _umbilicals(p, state)
    return p, glass, fluid, glow


# ─────────────────────────── facility vat bank ────────────────────────────


def build_bank(P, with_occupant=True):
    """Three full-size vats on the left wall, plus the gantry that services
    them.  `P(name)` is the caller's part factory."""
    solid = P("interior__vat_bank")
    glass = P("interior__vat_bank_glass")
    fluid = P("interior__vat_bank_fluid")
    glow = P("interior__vat_bank_accents")

    wall_x = VAT_BANK["wall_x"]
    for (sid, zc, state) in VAT_BANK["slots"]:
        s, g, f, gl = vat_unit(state)
        off = (wall_x, 0.02, zc)
        merge(solid, s, offset=off)
        merge(glass, g, offset=off)
        merge(fluid, f, offset=off)
        merge(glow, gl, offset=off)
        # wall-side service riser behind each unit
        pipe_run(solid, [(wall_x + 0.10, 0.30, zc - 0.50), (wall_x + 0.10, 2.72, zc - 0.50),
                         (wall_x + 0.42, 2.86, zc - 0.50)], 0.045, "CF_steel", sides=8)
        pipe_run(solid, [(wall_x + 0.10, 0.30, zc + 0.50), (wall_x + 0.10, 2.72, zc + 0.50),
                         (wall_x + 0.42, 2.86, zc + 0.50)], 0.045, "CF_steel", sides=8)
        # numbered bay marker on the floor
        box(solid, wall_x + 0.02, wall_x + 1.36, 0.021, 0.024, zc - 0.66, zc - 0.62,
            "CF_hazard")
        box(solid, wall_x + 0.02, wall_x + 1.36, 0.021, 0.024, zc + 0.62, zc + 0.66,
            "CF_hazard")

    _gantry(solid, glow)


def _gantry(p: Part, glow: Part):
    g = GANTRY
    ry = g["rail_y"]
    for xa in (g["x0"] + 0.16, g["x1"]):
        box(p, xa - 0.055, xa + 0.055, ry, ry + 0.14, g["z0"], g["z1"], "CF_steel")
        box(p, xa - 0.075, xa + 0.075, ry + 0.14, ry + 0.17, g["z0"], g["z1"], "CF_gunmetal")
        for zc in (g["z0"] + 0.10, 0.0, g["z1"] - 0.10):
            box(p, xa - 0.05, xa + 0.05, ry + 0.17, 3.03, zc - 0.05, zc + 0.05, "CF_steel")
    # travelling carriage
    cz = g["carriage_z"]
    box(p, g["x0"] + 0.06, g["x1"] + 0.10, ry - 0.13, ry, cz - 0.19, cz + 0.19, "CF_gunmetal")
    for xa in (g["x0"] + 0.16, g["x1"]):
        for dz in (-0.14, 0.14):
            cyl_axis(p, "x", ry + 0.05, cz + dz, xa - 0.075, xa + 0.075, 0.055,
                     "CF_steel", sides=8)
    # articulated service arm reaching down over the middle vat
    pivot = (g["x0"] + 0.24, ry - 0.15, cz)
    elbow = (g["x0"] - 0.46, ry - 0.44, cz - 0.10)
    wrist = (g["x0"] - 0.66, ry - 0.74, cz - 0.02)
    for (a, b, r) in ((pivot, elbow, 0.062), (elbow, wrist, 0.050)):
        pipe_run(p, [a, b], r, "CF_steel", sides=8)
    for j in (pivot, elbow, wrist):
        cyl_axis(p, "z", j[0], j[1], j[2] - 0.075, j[2] + 0.075, 0.082, "CF_gunmetal", sides=10)
    # tool head
    lathe(p, wrist[0], wrist[2], [(0.0, wrist[1] - 0.02), (0.075, wrist[1] - 0.09),
                                  (0.075, wrist[1] - 0.19), (0.045, wrist[1] - 0.24),
                                  (0.0, wrist[1] - 0.26)], "CF_enamel", sides=12)
    box(glow, wrist[0] - 0.030, wrist[0] + 0.030, wrist[1] - 0.255, wrist[1] - 0.235,
        wrist[2] - 0.030, wrist[2] + 0.030, "CF_Glow")
    # festoon cable following the carriage
    pipe_run(p, [(g["x1"] - 0.02, ry - 0.02, g["z1"] - 0.10),
                 (g["x1"] - 0.02, ry - 0.22, cz + 0.90),
                 (g["x1"] - 0.02, ry - 0.06, cz + 0.42),
                 (g["x1"] - 0.02, ry - 0.14, cz + 0.20)], 0.026, "CF_rubber", sides=6)


def occupant_transform():
    """(x, y, z) of the occupied vat's chamber floor, in facility space."""
    wall_x = VAT_BANK["wall_x"]
    for (sid, zc, state) in VAT_BANK["slots"]:
        if state == "occupied":
            return (wall_x + CX, 0.02 + FOOT_PLATE, zc)
    raise RuntimeError("no occupied vat in the bank")


def chamber_clear_height() -> float:
    return CHAMBER_TOP - FOOT_PLATE


def chamber_clear_width() -> float:
    return R_FLUID * 2.0
