"""Interior fitout of the Dustgate Clone Vault.

Everything in here is process plant or clinical equipment.  There is no
domestic furniture in a clone vault: no chairs, no shelves of crockery, no
crates of props standing in for detail.  The room's job is to explain, in one
glance from the threshold, that bodies are grown here.

Circulation contract
--------------------
The open-desert fixture drops two solid world props inside this building
(`cf_spec.RUNTIME_PROP_SLOTS`).  Their cells are kept clear here, and the
central aisle from the portal to the vat bank stays free, so a pawn can enter,
read the room, and reach both the vats and the operator console without
walking into decoration.
"""
from __future__ import annotations

import math

from cf_geom import (Part, box, cham_box, oct_plan, prism_y, frustum_y, cyl_y,
                     tube_y, cyl_axis, lathe, torus_y, pipe_run, plate,
                     recess_field, louvers, bolt_row, grate, ladder,
                     chevron_band, ring_plan, lerp)
from cf_spec import (FLOOR, INTERIOR_CLEAR_HEIGHT, INTERIOR_LIGHTS, LEVELS,
                     RUNTIME_PROP_SLOTS, VAT_BANK)

IX0, IX1 = -4.20, 4.20
IZ0, IZ1 = -3.25, 2.80
VZ1 = 3.40                      # walkable limit inside the entry reveal
FT = FLOOR["top_y_m"]
CEIL = INTERIOR_CLEAR_HEIGHT    # 3.05
BANK_FRONT = VAT_BANK["wall_x"] + VAT_BANK["depth"]   # -2.98


def build(P):
    build_floor(P("floor__interior_finish"), P("floor__interior_accents"))
    build_ceiling(P("roof__ceiling"), P("roof__ceiling_lights"))
    build_process_wall(P("interior__process_wall"), P("interior__process_accents"))
    build_control_bank(P("interior__control_bank"), P("interior__control_glass"),
                       P("interior__control_accents"))
    build_service_run(P("interior__service_runs"))
    build_vestibule(P("interior__vestibule"), P("interior__vestibule_accents"))


# ──────────────────────────────── floor ───────────────────────────────────


def build_floor(p: Part, glow: Part):
    # cast slab, then the sealed screed the room is actually finished in
    box(p, IX0 - 0.02, IX1 + 0.02, FT - FLOOR["slab_thickness_m"], FT - 0.012,
        IZ0 - 0.02, 3.46, "CF_sinter")
    box(p, IX0, IX1, FT - 0.012, FT, IZ0, 3.44, "CF_screed")
    # drainage channel across the room, gently crowned toward it
    cz = -0.32
    box(p, -3.70, 3.70, FT - 0.075, FT - 0.010, cz - 0.11, cz + 0.11, "CF_gunmetal")
    grate(p, -3.70, 3.70, cz - 0.10, cz + 0.10, FT - 0.008, "CF_steel", bars=41, along="x",
          thick=0.016)
    for x in (-3.70, 3.70):
        box(p, x - 0.03, x + 0.03, FT - 0.075, FT, cz - 0.13, cz + 0.13, "CF_gunmetal")
    # sump at the low end, under the process wall
    cyl_y(p, 3.42, cz, 0.19, FT - 0.11, FT - 0.008, "CF_gunmetal", sides=14)
    tube_y(p, 3.42, cz, 0.15, 0.20, FT - 0.014, FT, "CF_steel", sides=14)

    # sterile-zone boundary: an inlaid band around the vat bank apron
    ax0, ax1 = IX0 + 0.03, BANK_FRONT + 0.62
    az0, az1 = -2.62, 2.62
    for (a0, a1, b0, b1) in ((ax1 - 0.05, ax1, az0, az1),
                             (ax0, ax1, az0, az0 + 0.05),
                             (ax0, ax1, az1 - 0.05, az1)):
        box(p, a0, a1, FT, FT + 0.004, b0, b1, "CF_bronze")
    for i in range(11):
        z = lerp(az0 + 0.12, az1 - 0.12, i / 10)
        box(p, ax1 + 0.07, ax1 + 0.19, FT, FT + 0.003, z - 0.06, z + 0.06, "CF_hazard")

    # circulation: a walk lane from the portal to the console island
    chevron_band(p, -0.34, 2.04, 3.02, 3.30, FT + 0.003, "CF_hazard", "CF_screed",
                 count=7, skew=0.10)
    box(p, 0.34, 1.36, FT + 0.002, FT + 0.005, -1.30, 3.00, "CF_panel_dk")

    # equipment anchor pads (also tell the player where NOT to stand)
    for key in ("clone_terminal", "clone_pod"):
        slot = RUNTIME_PROP_SLOTS[key]
        r = slot["clear_r"]
        box(p, slot["x"] - r, slot["x"] + r, FT, FT + 0.006,
            slot["z"] - r, slot["z"] + r, "CF_gunmetal")
        box(p, slot["x"] - r + 0.05, slot["x"] + r - 0.05, FT + 0.006, FT + 0.009,
            slot["z"] - r + 0.05, slot["z"] + r - 0.05, "CF_screed")

    # low bio-glow strip washing the vat apron
    box(glow, ax1 + 0.22, ax1 + 0.30, FT + 0.001, FT + 0.018, az0 + 0.10, az1 - 0.10,
        "CF_Glow")


# ─────────────────────────────── ceiling ──────────────────────────────────


def build_ceiling(p: Part, glow: Part):
    box(p, IX0 - 0.30, IX1 + 0.30, CEIL, CEIL + 0.10, IZ0 - 0.30, 3.42, "CF_panel")
    # coffers between the beams
    for i in range(4):
        z0 = lerp(IZ0 + 0.24, 2.50, i / 4) + 0.10
        z1 = lerp(IZ0 + 0.24, 2.50, (i + 1) / 4) - 0.10
        # `-y` faces downward, so the outward w axis is negated: the soffit
        # plane is at w = -CEIL and the recess pushes further negative (up).
        recess_field(p, IX0 + 0.30, IX1 - 0.30, z0, z1, -CEIL, 0.075, "CF_panel_dk",
                     5, 1, gap=0.09, axis="-y")
    # downstand beams
    for i in range(5):
        z = lerp(IZ0 + 0.24, 2.62, i / 4)
        box(p, IX0, IX1, CEIL - 0.16, CEIL, z - 0.075, z + 0.075, "CF_panel")
        box(p, IX0, IX1, CEIL - 0.19, CEIL - 0.16, z - 0.095, z + 0.095, "CF_gunmetal")
    # cable tray + conduit spine
    for x in (-1.05, 1.65):
        box(p, x - 0.15, x + 0.15, CEIL - 0.26, CEIL - 0.22, IZ0 + 0.20, 2.50, "CF_gunmetal")
        for z in (-2.60, -1.30, 0.0, 1.30, 2.30):
            box(p, x - 0.17, x + 0.17, CEIL - 0.22, CEIL - 0.19, z - 0.03, z + 0.03,
                "CF_steel")
        cyl_axis(p, "z", x + 0.24, CEIL - 0.14, IZ0 + 0.20, 2.50, 0.042, "CF_gunmetal",
                 sides=8)
        cyl_axis(p, "z", x + 0.34, CEIL - 0.14, IZ0 + 0.20, 2.50, 0.030, "CF_gunmetal",
                 sides=8)
    # luminaire troughs, matching the baked practicals one for one
    for (x, y, z, size, energy, color) in INTERIOR_LIGHTS:
        if y < 2.5:
            continue
        h = size * 0.5
        box(p, x - h - 0.05, x + h + 0.05, CEIL - 0.13, CEIL, z - 0.19, z + 0.19,
            "CF_gunmetal")
        box(glow, x - h, x + h, CEIL - 0.135, CEIL - 0.115, z - 0.14, z + 0.14, "CF_Glow")
    # extract hoods over the vat bank and the process wall
    for (x0, x1, z0, z1) in ((IX0 + 0.10, BANK_FRONT + 0.10, -2.30, 2.30),
                             (0.30, 4.05, IZ0 + 0.10, -2.05)):
        frustum_y(p, oct_plan(x0, x1, z0, z1, 0.10), CEIL - 0.42,
                  oct_plan(x0 + 0.34, x1 - 0.34, z0 + 0.34, z1 - 0.34, 0.10), CEIL - 0.06,
                  "CF_steel", cap_lo=False, cap_hi=False)
        box(p, x0 - 0.03, x1 + 0.03, CEIL - 0.46, CEIL - 0.42, z0 - 0.03, z1 + 0.03,
            "CF_gunmetal")


# ─────────────────────────── back process wall ────────────────────────────


def build_process_wall(p: Part, glow: Part):
    zw = IZ0                     # inner face of the back wall
    # skirting plinth the whole plant stands on
    box(p, -1.30, IX1 - 0.05, FT, FT + 0.16, zw + 0.02, zw + 0.86, "CF_gunmetal")
    box(p, -1.30, IX1 - 0.05, FT + 0.16, FT + 0.19, zw + 0.0, zw + 0.90, "CF_steel")

    # twin buffer vessels
    for (x, h) in ((3.62, 1.94), (2.62, 1.72)):
        cz = zw + 0.46
        lathe(p, x, cz, [(0.0, FT + 0.19), (0.24, FT + 0.23), (0.31, FT + 0.33),
                         (0.31, h - 0.22), (0.27, h - 0.08), (0.16, h + 0.02),
                         (0.0, h + 0.05)], "CF_biotank", sides=20, cap_lo=True)
        for band in (FT + 0.62, h - 0.46):
            tube_y(p, x, cz, 0.31, 0.345, band, band + 0.075, "CF_bronze", sides=20)
        cyl_y(p, x, cz, 0.10, h + 0.05, h + 0.16, "CF_steel", sides=12)
        tube_y(p, x, cz, 0.10, 0.13, h + 0.11, h + 0.16, "CF_bronze", sides=12)
        # sight glass with a live level
        box(p, x + 0.29, x + 0.34, FT + 0.42, h - 0.30, cz - 0.055, cz + 0.055, "CF_gunmetal")
        box(glow, x + 0.305, x + 0.325, FT + 0.46, FT + 0.46 + (h - 0.90) * 0.62,
            cz - 0.032, cz + 0.032, "CF_Glow")
        pipe_run(p, [(x, h + 0.16, cz), (x, h + 0.42, cz), (x, h + 0.42, zw + 0.16)],
                 0.055, "CF_steel", sides=8)

    # pump skid
    for (x, flip) in ((0.42, 1.0), (1.32, 1.0)):
        cz = zw + 0.40
        cham_box(p, x - 0.30, x + 0.30, FT + 0.19, FT + 0.44, cz - 0.26, cz + 0.26,
                 "CF_gunmetal", ch=0.02, top=True)
        cyl_axis(p, "z", x, FT + 0.66, cz - 0.30, cz + 0.10, 0.21, "CF_enamel", sides=16)
        cyl_axis(p, "z", x, FT + 0.66, cz + 0.10, cz + 0.34, 0.15, "CF_steel", sides=16)
        for k in range(6):
            a = 60.0 * k
            cyl_axis(p, "z", x + 0.155 * math.cos(math.radians(a)),
                     FT + 0.66 + 0.155 * math.sin(math.radians(a)),
                     cz + 0.34, cz + 0.36, 0.014, "CF_gunmetal", sides=4)
        # volute inlet/outlet
        pipe_run(p, [(x, FT + 0.66, cz - 0.30), (x, FT + 0.66, cz - 0.52),
                     (x, FT + 1.30, cz - 0.52), (x, FT + 1.30, zw + 0.12)],
                 0.058, "CF_steel", sides=8)
        pipe_run(p, [(x + 0.21, FT + 0.66, cz - 0.10), (x + 0.46, FT + 0.66, cz - 0.10),
                     (x + 0.46, FT + 1.62, cz - 0.10)], 0.048, "CF_steel", sides=8)
        cyl_axis(p, "y", x + 0.46, cz - 0.10, FT + 1.02, FT + 1.14, 0.072, "CF_bronze",
                 sides=10)
        box(glow, x - 0.16, x + 0.16, FT + 0.455, FT + 0.475, cz + 0.10, cz + 0.24,
            "CF_GlowAmber")

    # manifold tree with hand wheels
    mx0, mx1 = -1.20, 0.02
    box(p, mx0, mx1, FT + 0.19, FT + 2.28, zw + 0.02, zw + 0.16, "CF_gunmetal")
    for i, y in enumerate((FT + 0.62, FT + 1.24, FT + 1.86)):
        cyl_axis(p, "x", y, zw + 0.30, mx0 + 0.06, mx1 - 0.06, 0.062, "CF_steel", sides=12)
        for k, x in enumerate((mx0 + 0.26, mx0 + 0.66, mx0 + 1.02)):
            cyl_y(p, x, zw + 0.30, 0.048, y + 0.062, y + 0.17, "CF_gunmetal", sides=8)
            torus_y(p, x, y + 0.20, zw + 0.30, 0.085, 0.017, "CF_bronze",
                    major_sides=12, minor_sides=5)
            for a in (0.0, 90.0, 180.0, 270.0):
                cyl_axis(p, "y", x + 0.043 * math.cos(math.radians(a)),
                         zw + 0.30 + 0.043 * math.sin(math.radians(a)),
                         y + 0.17, y + 0.20, 0.012, "CF_bronze", sides=4)
            pipe_run(p, [(x, y, zw + 0.30), (x, y, zw + 0.62),
                         (x, FT + 2.46, zw + 0.62)], 0.034, "CF_steel", sides=6)
    # control cabinet between the manifold and the pumps
    cham_box(p, -1.86, -1.30, FT, FT + 1.92, zw + 0.02, zw + 0.44, "CF_enamel",
             ch=0.03, top=True)
    plate(p, zw + 0.10, zw + 0.36, FT + 0.42, FT + 1.62, -1.30, -1.286, "CF_gunmetal",
          ch=0.014, axis="+x")
    for i in range(5):
        y = FT + 0.52 + i * 0.24
        box(glow, -1.284, -1.276, y, y + 0.05, zw + 0.14, zw + 0.32,
            "CF_Glow" if i % 2 == 0 else "CF_GlowAmber")
    louvers(p, zw + 0.08, zw + 0.38, FT + 1.86, 4, 0.075, -1.286, 0.028, "CF_steel",
            axis="+x")
    # wall-hung filter housings on the left half (clear of the pod slot)
    for x in (-3.86, -3.30):
        cyl_y(p, x, zw + 0.24, 0.145, FT + 1.10, FT + 2.10, "CF_enamel", sides=14)
        tube_y(p, x, zw + 0.24, 0.145, 0.175, FT + 1.62, FT + 1.70, "CF_bronze", sides=14)
        lathe(p, x, zw + 0.24, [(0.145, FT + 2.10), (0.125, FT + 2.17), (0.0, FT + 2.20)],
              "CF_steel", sides=14)
        pipe_run(p, [(x, FT + 1.10, zw + 0.24), (x, FT + 0.86, zw + 0.24),
                     (x, FT + 0.86, zw + 0.10)], 0.032, "CF_steel", sides=6)
        box(p, x - 0.19, x + 0.19, FT + 2.20, FT + 2.28, zw + 0.06, zw + 0.42, "CF_gunmetal")
    # cable tray running the wall
    box(p, IX0 + 0.10, IX1 - 0.10, FT + 2.42, FT + 2.46, zw + 0.02, zw + 0.20, "CF_gunmetal")
    for x in range(-4, 5):
        box(p, x - 0.02, x + 0.02, FT + 2.46, FT + 2.50, zw + 0.02, zw + 0.20, "CF_steel")
    # eyewash / decontamination point, the one piece of human safety kit
    box(p, -2.42, -2.06, FT + 0.86, FT + 1.02, zw + 0.02, zw + 0.30, "CF_steel")
    cyl_y(p, -2.24, zw + 0.22, 0.036, FT + 1.02, FT + 1.34, "CF_steel", sides=8)
    for dz in (-0.10, 0.10):
        lathe(p, -2.24 + dz, zw + 0.22, [(0.055, FT + 1.34), (0.062, FT + 1.30),
                                         (0.0, FT + 1.26)], "CF_bronze", sides=8)
    box(glow, -2.42, -2.06, FT + 1.44, FT + 1.62, zw + 0.02, zw + 0.06, "CF_GlowAmber")


# ────────────────────────── right-wall control bank ───────────────────────


def build_control_bank(p: Part, glass: Part, glow: Part):
    xw = IX1                     # inner face of the right wall
    # backing panel and console plinth
    box(p, xw - 0.14, xw, FT, CEIL - 0.20, -2.30, 2.55, "CF_panel_dk")
    box(p, xw - 0.20, xw, FT + 1.98, FT + 2.06, -2.30, 2.55, "CF_bronze")

    # angled monitor wall: three faces reading toward the room
    for i, zc in enumerate((-1.55, -0.55, 0.45)):
        w = 0.42
        y0, y1 = FT + 1.16, FT + 1.86
        # bezel
        box(p, xw - 0.30, xw - 0.14, y0 - 0.05, y1 + 0.05, zc - w - 0.05, zc + w + 0.05,
            "CF_gunmetal")
        # screen face angled 12 degrees toward the door
        near, far = xw - 0.315, xw - 0.30
        glass.quad((near, y0, zc - w), (near, y0, zc + w),
                   (far, y1, zc + w), (far, y1, zc - w), "CF_Screen")
        for k in range(3):
            yy = lerp(y0 + 0.10, y1 - 0.10, k / 2)
            box(glow, xw - 0.325, xw - 0.318, yy, yy + 0.022, zc - w + 0.05, zc + w - 0.16,
                "CF_Glow")
    # operator ledge under the monitors
    box(p, xw - 0.62, xw - 0.10, FT + 0.94, FT + 1.02, -2.10, 0.95, "CF_enamel")
    box(p, xw - 0.64, xw - 0.58, FT + 0.90, FT + 1.02, -2.10, 0.95, "CF_bronze")
    for zc in (-1.85, -0.30, 0.70):
        box(p, xw - 0.56, xw - 0.20, FT + 1.02, FT + 1.06, zc - 0.22, zc + 0.22,
            "CF_gunmetal")
        for k in range(4):
            cyl_y(p, xw - 0.50 + k * 0.09, zc, 0.022, FT + 1.06, FT + 1.085,
                  "CF_bronze" if k % 2 else "CF_steel", sides=6)
    box(p, xw - 0.62, xw - 0.10, FT, FT + 0.94, -2.10, 0.95, "CF_enamel", skip=("+x",))
    recess_field(p, -2.02, 0.87, FT + 0.12, FT + 0.86, xw - 0.62, 0.03, "CF_panel_dk",
                 4, 1, gap=0.07, axis="-x")

    # equipment rack: culture media, reagent bottles, sample cassettes
    rx0, rx1 = xw - 0.52, xw - 0.06
    cham_box(p, rx0, rx1, FT, FT + 2.16, 1.15, 2.52, "CF_enamel", ch=0.028, top=True)
    for i in range(4):
        y = FT + 0.42 + i * 0.44
        box(p, rx0 - 0.03, rx1, y, y + 0.035, 1.18, 2.49, "CF_steel")
        for k in range(6):
            z = lerp(1.28, 2.40, k / 5)
            lathe(p, (rx0 + rx1) * 0.5 + (0.06 if k % 2 else -0.05), z,
                  [(0.0, y + 0.035), (0.042, y + 0.055), (0.042, y + 0.20),
                   (0.028, y + 0.235), (0.028, y + 0.27), (0.0, y + 0.28)],
                  "CF_biotank" if k % 3 else "CF_steel", sides=8)
    box(glass, rx0 - 0.012, rx0 - 0.006, FT + 0.38, FT + 2.02, 1.18, 2.49, "CF_GlassClear")
    box(p, rx0 - 0.03, rx0 - 0.004, FT + 0.34, FT + 0.38, 1.15, 2.52, "CF_gunmetal")
    box(p, rx0 - 0.03, rx0 - 0.004, FT + 2.02, FT + 2.06, 1.15, 2.52, "CF_gunmetal")

    # autoclave / sterilizer at the back end of the bank
    ax0, ax1 = xw - 0.66, xw - 0.06
    cham_box(p, ax0, ax1, FT, FT + 1.68, -3.02, -2.34, "CF_enamel", ch=0.03, top=True)
    cyl_axis(p, "x", FT + 0.94, -2.68, ax0 - 0.02, ax0 + 0.06, 0.24, "CF_steel", sides=18)
    cyl_axis(p, "x", FT + 0.94, -2.68, ax0 - 0.07, ax0 - 0.02, 0.27, "CF_gunmetal", sides=18)
    for a in range(6):
        deg = 60.0 * a + 15.0
        cyl_axis(p, "x", FT + 0.94 + 0.27 * math.sin(math.radians(deg)),
                 -2.68 + 0.27 * math.cos(math.radians(deg)), ax0 - 0.09, ax0 - 0.07,
                 0.022, "CF_bronze", sides=6)
    box(p, ax0 - 0.04, ax1, FT + 1.68, FT + 1.76, -3.02, -2.34, "CF_gunmetal")
    box(glow, ax0 - 0.075, ax0 - 0.070, FT + 1.34, FT + 1.44, -2.92, -2.46, "CF_GlowAmber")
    pipe_run(p, [(ax1 - 0.10, FT + 1.76, -2.68), (ax1 - 0.10, FT + 2.32, -2.68),
                 (ax1 - 0.10, FT + 2.32, -3.16)], 0.048, "CF_steel", sides=8)

    # instrument trolley parked clear of the walk lane
    tx, tz = 2.62, 1.86
    for (dx, dz) in ((-0.26, -0.17), (0.26, -0.17), (-0.26, 0.17), (0.26, 0.17)):
        cyl_y(p, tx + dx, tz + dz, 0.030, FT + 0.06, FT + 0.78, "CF_steel", sides=6)
        cyl_axis(p, "x", FT + 0.05, tz + dz, tx + dx - 0.022, tx + dx + 0.022, 0.05,
                 "CF_rubber", sides=8)
    for y in (FT + 0.44, FT + 0.80):
        box(p, tx - 0.32, tx + 0.32, y, y + 0.035, tz - 0.23, tz + 0.23, "CF_steel")
        box(p, tx - 0.33, tx + 0.33, y + 0.035, y + 0.055, tz - 0.24, tz - 0.225, "CF_steel")
        box(p, tx - 0.33, tx + 0.33, y + 0.035, y + 0.055, tz + 0.225, tz + 0.24, "CF_steel")
    for k in range(4):
        z = lerp(tz - 0.16, tz + 0.16, k / 3)
        box(p, tx - 0.20, tx - 0.02, FT + 0.815, FT + 0.845, z - 0.018, z + 0.018,
            "CF_gunmetal")
    lathe(p, tx + 0.16, tz, [(0.0, FT + 0.815), (0.055, FT + 0.845), (0.055, FT + 0.99),
                             (0.038, FT + 1.02), (0.0, FT + 1.03)], "CF_biotank", sides=10)


# ─────────────────────── service runs and vestibule ───────────────────────


def build_service_run(p: Part):
    """The pipe grammar that ties vats -> process wall -> roof plant.  Without
    it the room is a set of objects; with it, it is a system."""
    ceil = CEIL - 0.30
    for zc in (VAT_BANK["slots"][0][1], VAT_BANK["slots"][1][1], VAT_BANK["slots"][2][1]):
        pipe_run(p, [(-4.06, 2.86, zc), (-4.06, ceil, zc), (-1.05, ceil, zc),
                     (-1.05, ceil, -2.92), (-1.05, 2.62, -2.92)], 0.042, "CF_steel", sides=8)
        pipe_run(p, [(-3.94, 2.86, zc + 0.14), (-3.94, ceil - 0.10, zc + 0.14),
                     (1.65, ceil - 0.10, zc + 0.14), (1.65, ceil - 0.10, -2.86)],
                 0.030, "CF_rubber", sides=6)
    for x in (-1.05, 1.65):
        pipe_run(p, [(x, ceil, 2.30), (x, ceil, 2.62), (x, CEIL - 0.02, 2.62)],
                 0.042, "CF_steel", sides=8)
    # gas bottle bank strapped to the front wall, right of the portal
    for i, x in enumerate((2.66, 2.98, 3.30)):
        lathe(p, x, 2.52, [(0.0, FT), (0.115, FT + 0.05), (0.135, FT + 0.16),
                           (0.135, FT + 1.16), (0.105, FT + 1.30), (0.055, FT + 1.36),
                           (0.055, FT + 1.46), (0.0, FT + 1.48)],
              "CF_biotank" if i != 1 else "CF_steel", sides=14)
        cyl_y(p, x, 2.52, 0.072, FT + 1.46, FT + 1.56, "CF_gunmetal", sides=10)
        pipe_run(p, [(x, FT + 1.56, 2.52), (x, FT + 1.72, 2.52), (3.62, FT + 1.72, 2.52)],
                 0.024, "CF_steel", sides=6)
    box(p, 2.52, 3.44, FT + 0.92, FT + 1.00, 2.36, 2.42, "CF_steel")
    box(p, 2.52, 3.44, FT + 0.30, FT + 0.38, 2.36, 2.42, "CF_steel")


def build_vestibule(p: Part, glow: Part):
    """Threshold read: wash-down mat, hand register, and the airlock light."""
    grate(p, -0.24, 1.94, 2.86, 3.34, FT + 0.008, "CF_steel", bars=17, along="y",
          thick=0.018)
    box(p, -0.30, -0.24, FT, FT + 0.012, 2.82, 3.38, "CF_gunmetal")
    box(p, 1.94, 2.00, FT, FT + 0.012, 2.82, 3.38, "CF_gunmetal")
    # intake register on the return, inside
    box(p, 2.06, 2.44, FT + 0.86, FT + 1.72, 2.62, 2.78, "CF_enamel")
    plate(p, 2.62, 2.78, FT + 0.96, FT + 1.62, 2.06, 2.046, "CF_gunmetal", ch=0.012,
          axis="-x")
    box(glow, 2.056, 2.062, FT + 1.06, FT + 1.16, 2.66, 2.74, "CF_Glow")
    box(glow, 2.056, 2.062, FT + 1.24, FT + 1.34, 2.66, 2.74, "CF_GlowAmber")
    # airlock status ring above the portal, inside
    torus_y(p, 0.85, FT + 2.60, 2.82, 0.20, 0.035, "CF_gunmetal", major_sides=16,
            minor_sides=6)
    torus_y(glow, 0.85, FT + 2.60, 2.80, 0.20, 0.022, "CF_Glow", major_sides=16,
            minor_sides=6)
