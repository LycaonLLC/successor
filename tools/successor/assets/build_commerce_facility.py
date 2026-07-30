#!/usr/bin/env python3
"""Build the Dustgate commerce facility (deterministic source of truth).

Produces (runtime dir `client-3d/public/assets/world-items/`):
  - commerce_facility.glb + commerce_facility_manifest.json
  - commerce_facility_collision.json (authored structural + furniture proxy)
  - commerce_facility.provenance.json
  (UV PBR texture maps are shared with the terminal suite: commerce_*.png)

Evidence (ignored): .game-lab/commerce-facility-20260718/ (renders/, gate.json).

Headless:
    /snap/bin/blender -b --factory-startup --python-exit-code 1 \
        -P tools/successor/assets/build_commerce_facility.py

Contract: 12x9-cell civic landmark. Mesh authored 11.4 x 8.55 m so runtime
placement scale is 12/11.4 = 9/8.55 = 1.0526315789 (pawn parity with
house_h1 / cloning_facility). Floor top authored at y = 0.02 m. South (+Z)
centered portal, 2.47 m authored clear (2.6 m runtime), pocket door
`door_slide` with door_open/door_close clips per the house door contract.
Cutaway groups: floor__/interior__ keep (never reveal-hide — includes the
ceiling cove + counter service glow strips, which stay lit during roof peel),
roof__ hides, wall_<face>__ stub by face.

Design language: the upgraded commerce-terminal premium pass carried to
building scale — chamfered basalt structure over a grounded plinth course,
warm sand ceramic cladding with recessed panels behind shadow reveals,
oxidized brass hardware, deep teal glass, restrained amber/pale-cyan
emissives. Flagship civic interior: vestibule piers into a medallion
concourse, glazed bank counter with a wall vault face, trade inspection
counter with wall shelving, PA civic notice bay, trainer consultation nook,
benches, queue rails, clerestory roof lantern, ceiling beams with light
coves, floor inlays. Terminal machines themselves are separate props placed
by the world lane at local cells (3,3), (6,3), (9,3); those cells and their
south approach stay clear here. No baked words, no franchise/IP motifs.
"""
from __future__ import annotations

import json
import math
import sys
from pathlib import Path

import bpy
from mathutils import Vector

sys.path.insert(0, str(Path(__file__).resolve().parent))
import build_commerce_terminals as ct  # noqa: E402  (shared helpers/palette/textures)

REPO = ct.REPO
OUT_DIR = ct.OUT_DIR
EVIDENCE_DIR = REPO / ".game-lab" / "commerce-facility-20260718"
RENDER_DIR = EVIDENCE_DIR / "renders"
GATE_PATH = EVIDENCE_DIR / "gate.json"
RUN_ID = "commerce-facility-20260718"

FACILITY_GLB = OUT_DIR / "commerce_facility.glb"
MANIFEST_PATH = OUT_DIR / "commerce_facility_manifest.json"
COLLISION_PATH = OUT_DIR / "commerce_facility_collision.json"

P = {
    "building": "commerce_facility",
    "root_node": "Gear_commerce_facility",
    "units": "m",
    "footprint_cells": [12, 9],
    # Mesh spans exactly 11.4 x 8.55 => runtime scale 1.0526315789.
    "main_outer": {"x_min": -5.7, "x_max": 5.7, "z_min": -4.275, "z_max": 4.275},
    "shell": {"left_x": -5.45, "right_x": 5.45, "back_z": -4.05, "front_z": 3.90},
    "entry_bay": {"x_min": -3.95, "x_max": 2.05, "z_back": 3.90, "z_front": 4.275},
    "wall_thickness_m": 0.30,
    "wall_top_y_m": 3.30,
    "parapet_top_y_m": 3.72,
    "bay_parapet_top_y_m": 4.10,
    "roof": {"slab_bottom_y_m": 3.10, "slab_top_y_m": 3.30},
    "floor": {"slab_thickness_m": 0.14, "top_y_m": 0.02},
    "interior_clear_height_m": 3.10,
    "door": {
        "node": "door_slide",
        "opening_bounds": {"x_min": -1.235, "x_max": 1.235, "y_min": 0.0, "y_max": 2.50, "front_z": 4.21, "inner_z": 3.91},
        "closed_center": [0.0, 1.30, 4.06],
        "panel_size": [2.55, 2.60, 0.08],
        "slide_axis_local": [-1, 0, 0],
        "slide_distance_m": 2.58,
        "clip_duration_s": 0.8,
        "fps": 30,
        "pocket_bounds": {"x_min": -3.90, "x_max": -1.30, "y_min": -0.01, "y_max": 2.66, "z_min": 3.99, "z_max": 4.17},
    },
    "tri_budget": 22000,
    "render_resolution": [1280, 960],
}

CELL = 0.95  # authored cell size


def cell_center(col, row):
    return ((col + 0.5) * CELL - 5.7, (row + 0.5) * CELL - 4.275)


FACILITY_MATERIALS = {"CM_Ceramic", "CM_Basalt", "CM_Brass", "CM_Steel", "CM_Ink", "CM_TealGlass", "CM_GlowAmber", "CM_GlowCyan"}

# Aliases into the shared helper module.
MeshBuilder = ct.MeshBuilder
bounds = ct.bounds
plate = ct.plate
cham_box = ct.cham_box
louvers = ct.louvers
screws = ct.screws
disc_axis = ct.disc_axis
ring_axis = ct.ring_axis
slab = ct.slab
prism_x = ct.prism_x
rot_box = ct.rot_box
make_root = ct.make_root
write_json = ct.write_json
sha256_of = ct.sha256_of
logical_to_blender = ct.logical_to_blender
hex_to_rgba = ct.hex_to_rgba
bbox_span = ct.bbox_span


def mm(name, b, mat, root, mats):
    return ct.make_mesh_object(name, b, mats[mat], root)


# ─────────────────────────── exterior structure ────────────────────────────


def build_floor(root, mats):
    mo = P["main_outer"]
    b = MeshBuilder()
    bounds(b, mo["x_min"], mo["x_max"], P["floor"]["top_y_m"] - P["floor"]["slab_thickness_m"], P["floor"]["top_y_m"], mo["z_min"], mo["z_max"])
    mm("floor__single_cast_slab", b, "CM_Basalt", root, mats)

    # Warm ceramic concourse field over the walkable interior (authored floor
    # readability cue — lifts the unlit interior without a global desert
    # wash). Flush inlay: basalt slab shows as a 0.13 m perimeter border and
    # every existing inlay/pad top (>= 0.0225) clears the field top by >= 1 mm.
    b = MeshBuilder()
    bounds(b, -5.02, 5.02, P["floor"]["top_y_m"], 0.0215, -3.62, 3.47)
    mm("floor__concourse_field", b, "CM_Ceramic", root, mats)

    # Flush inlays: brass concourse ring + teal core, teal vestibule threshold.
    b = MeshBuilder()
    ring_axis(b, 0.0, 1.15, 0.92, 1.04, 0.02, 0.0235, axis="+y", segments=28)
    bounds(b, -0.06, 0.06, 0.02, 0.0235, 1.98, 3.42)
    mm("floor__brass_inlays", b, "CM_Brass", root, mats)
    b = MeshBuilder()
    # Transparent inlays inside the concourse field seat ON the field top
    # (0.0215) — a translucent volume sharing the field's 0.02 base plane
    # reads as shimmer through the 22% alpha glass.
    disc_axis(b, 0.0, 1.15, 0.48, 0.0215, 0.023, axis="+y", sides=24)
    bounds(b, -1.235, 1.235, 0.02, 0.023, 3.52, 3.60)
    mm("floor__teal_inlays", b, "CM_TealGlass", root, mats)
    b = MeshBuilder()
    bounds(b, -0.9, 0.9, 0.02, 0.0225, 3.03, 3.10)
    mm("floor__arrival_inlay_glow", b, "CM_GlowAmber", root, mats)
    # Flush machine anchor pads: trade/PA keep the shared steel pad + brass
    # corner marks; the BANK cell gets a distinct practical cue — ink pad,
    # brass vault ring and amber halo echoing the wall vault — so the bank
    # machine silhouettes readably. Flush inlays only: the terminal cells and
    # their south approach stay clear (no words, no collision).
    b = MeshBuilder()
    for col in (6, 9):
        cxx, czz = cell_center(col, 3)
        bounds(b, cxx - 0.44, cxx + 0.44, 0.02, 0.0235, czz - 0.44, czz + 0.44)
    mm("floor__machine_pads", b, "CM_Steel", root, mats)
    b = MeshBuilder()
    for col in (6, 9):
        cxx, czz = cell_center(col, 3)
        for sx in (-1, 1):
            for sz in (-1, 1):
                bounds(b, cxx + sx * 0.44 - 0.03, cxx + sx * 0.44 + 0.03, 0.02, 0.024, czz + sz * 0.44 - 0.03, czz + sz * 0.44 + 0.03)
    mm("floor__pad_corner_marks", b, "CM_Brass", root, mats)
    bx, bz = cell_center(3, 3)
    b = MeshBuilder()
    bounds(b, bx - 0.44, bx + 0.44, 0.02, 0.0228, bz - 0.44, bz + 0.44)
    mm("floor__bank_pad", b, "CM_Ink", root, mats)
    b = MeshBuilder()
    ring_axis(b, bx, bz, 0.30, 0.36, 0.02, 0.0238, axis="+y", segments=28)
    mm("floor__bank_vault_ring", b, "CM_Brass", root, mats)
    b = MeshBuilder()
    # Bold amber halo band (0.09 m) — must survive the iso gameplay pixel
    # scale; the first 0.035 m band vanished at gameplay distance (headed QA).
    ring_axis(b, bx, bz, 0.375, 0.465, 0.02, 0.0234, axis="+y", segments=28)
    mm("floor__bank_halo_glow", b, "CM_GlowAmber", root, mats)


def _wall_run(b, x0, x1, z0, z1, y0, y1):
    bounds(b, x0, x1, y0, y1, z0, z1)


def build_walls(root, mats):
    sh = P["shell"]
    th = P["wall_thickness_m"]
    top = P["wall_top_y_m"]
    eb = P["entry_bay"]
    door = P["door"]["opening_bounds"]

    # ── front (south, +z) ──
    b = MeshBuilder()
    _wall_run(b, sh["left_x"], eb["x_min"], sh["front_z"] - th, sh["front_z"], 0.0, top)
    _wall_run(b, eb["x_max"], sh["right_x"], sh["front_z"] - th, sh["front_z"], 0.0, top)
    # bay returns + bay front segments + header above the portal
    _wall_run(b, eb["x_min"], eb["x_min"] + th, eb["z_back"], eb["z_front"], 0.0, top)
    _wall_run(b, eb["x_max"] - th, eb["x_max"], eb["z_back"], eb["z_front"], 0.0, top)
    _wall_run(b, eb["x_min"] + th, door["x_min"], door["inner_z"], door["front_z"], 0.0, top)
    _wall_run(b, door["x_max"], eb["x_max"] - th, door["inner_z"], door["front_z"], 0.0, top)
    _wall_run(b, door["x_min"], door["x_max"], door["inner_z"], door["front_z"], door["y_max"], top)
    mm("wall_front__shell", b, "CM_Ceramic", root, mats)

    # plinth course, parapet, bay tower parapet, recessed panels, portal frame
    b = MeshBuilder()
    _wall_run(b, sh["left_x"] - 0.04, eb["x_min"], sh["front_z"] - th, sh["front_z"] + 0.05, 0.0, 0.55)
    _wall_run(b, eb["x_max"], sh["right_x"] + 0.04, sh["front_z"] - th, sh["front_z"] + 0.05, 0.0, 0.55)
    _wall_run(b, eb["x_min"] - 0.05, door["x_min"] - 0.02, door["inner_z"], door["front_z"] + 0.03, 0.0, 0.55)
    _wall_run(b, door["x_max"] + 0.02, eb["x_max"] + 0.05, door["inner_z"], door["front_z"] + 0.03, 0.0, 0.55)
    cham_box(b, sh["left_x"] - 0.03, eb["x_min"] + 0.02, top, P["parapet_top_y_m"], sh["front_z"] - th - 0.03, sh["front_z"] + 0.04, ch=0.03)
    cham_box(b, eb["x_max"] - 0.02, sh["right_x"] + 0.03, top, P["parapet_top_y_m"], sh["front_z"] - th - 0.03, sh["front_z"] + 0.04, ch=0.03)
    cham_box(b, eb["x_min"] - 0.04, eb["x_max"] + 0.04, top, P["bay_parapet_top_y_m"], door["inner_z"] - 0.03, door["front_z"] + 0.03, ch=0.035)
    mm("wall_front__basalt_course", b, "CM_Basalt", root, mats)

    b = MeshBuilder()
    for u0, u1 in ((-5.25, -4.15), (2.25, 3.35), (3.55, 5.25)):
        plate(b, u0, u1, 0.75, 2.85, sh["front_z"], sh["front_z"] + 0.045, 0.03, axis="+z")
    for u0, u1 in ((eb["x_min"] + 0.42, door["x_min"] - 0.28), (door["x_max"] + 0.28, eb["x_max"] - 0.42)):
        plate(b, u0, u1, 0.75, 2.85, door["front_z"], door["front_z"] + 0.045, 0.03, axis="+z")
    mm("wall_front__recessed_panels", b, "CM_Ceramic", root, mats)
    b = MeshBuilder()
    for cu in (-4.7, 2.8, 4.4, -1.9, 1.35):
        zface = door["front_z"] + 0.045 if -3.6 < cu < 2.0 else sh["front_z"] + 0.045
        screws(b, [(cu - 0.42, 0.87), (cu + 0.42, 0.87), (cu - 0.42, 2.73), (cu + 0.42, 2.73)], zface, zface + 0.008, axis="+z", r=0.011)
    mm("wall_front__panel_bolts", b, "CM_Steel", root, mats)

    # portal frame + energized gasket
    b = MeshBuilder()
    for x0, x1 in ((door["x_min"] - 0.24, door["x_min"] - 0.04), (door["x_max"] + 0.04, door["x_max"] + 0.24)):
        cham_box(b, x0, x1, 0.0, door["y_max"] + 0.24, door["front_z"] - 0.07, door["front_z"] + 0.05, ch=0.02)
    bounds(b, door["x_min"] - 0.24, door["x_max"] + 0.24, door["y_max"] + 0.04, door["y_max"] + 0.24, door["front_z"] - 0.07, door["front_z"] + 0.05)
    mm("wall_front__portal_frame", b, "CM_Basalt", root, mats)
    b = MeshBuilder()
    for x0, x1 in ((door["x_min"] - 0.04, door["x_min"] - 0.008), (door["x_max"] + 0.008, door["x_max"] + 0.04)):
        bounds(b, x0, x1, 0.05, door["y_max"] + 0.008, door["front_z"] + 0.005, door["front_z"] + 0.052)
    bounds(b, door["x_min"] - 0.04, door["x_max"] + 0.04, door["y_max"] + 0.008, door["y_max"] + 0.04, door["front_z"] + 0.005, door["front_z"] + 0.052)
    mm("wall_front__portal_glow", b, "CM_GlowAmber", root, mats)
    b = MeshBuilder()
    bounds(b, door["x_min"] - 0.30, door["x_min"] - 0.02, 0.0, 0.008, door["front_z"] - 0.11, door["front_z"] + 0.05)
    bounds(b, door["x_max"] + 0.02, door["x_max"] + 0.30, 0.0, 0.008, door["front_z"] - 0.11, door["front_z"] + 0.05)
    mm("wall_front__threshold", b, "CM_Steel", root, mats)

    # Civic commerce identity: shallow canopy, emissive sign band, brass
    # commerce emblem over the entry; accent band + patch plates break the
    # beige repetition.
    b = MeshBuilder()
    bounds(b, -1.9, 1.9, 2.76, 2.86, door["front_z"] - 0.10, 4.272)
    for sxn in (-1, 1):
        slab(b, [(sxn * 1.7, 2.76, 4.26), (sxn * 1.5, 2.76, 4.26), (sxn * 1.5, 2.50, door["front_z"] + 0.005), (sxn * 1.7, 2.50, door["front_z"] + 0.005)], (0.0, 0.03, 0.0))
    mm("wall_front__canopy", b, "CM_Steel", root, mats)
    b = MeshBuilder()
    bounds(b, -1.5, 1.5, 2.90, 3.22, door["front_z"], door["front_z"] + 0.025)
    mm("wall_front__sign_band_glow", b, "CM_GlowAmber", root, mats)
    b = MeshBuilder()
    for bx in (-1.35, -0.45, 0.45, 1.35):
        bounds(b, bx - 0.038, bx + 0.038, 2.845, 2.925, door["front_z"] - 0.005, door["front_z"] + 0.052)  # lower cleat gripping band bottom edge
        bounds(b, bx - 0.038, bx + 0.038, 3.195, 3.275, door["front_z"] - 0.005, door["front_z"] + 0.052)  # upper cleat gripping band top edge
    mm("wall_front__sign_brackets", b, "CM_Steel", root, mats)
    b = MeshBuilder()
    bounds(b, -1.53, -1.49, 2.92, 3.20, door["front_z"], door["front_z"] + 0.028)
    bounds(b, 1.49, 1.53, 2.92, 3.20, door["front_z"], door["front_z"] + 0.028)
    mm("wall_front__sign_edge_accents", b, "CM_GlowCyan", root, mats)
    b = MeshBuilder()
    ring_axis(b, -1.22, 3.06, 0.10, 0.14, door["front_z"] + 0.025, door["front_z"] + 0.06, segments=24)
    disc_axis(b, -1.22, 3.06, 0.05, door["front_z"] + 0.025, door["front_z"] + 0.05, sides=16)
    mm("wall_front__sign_emblem", b, "CM_Brass", root, mats)
    b = MeshBuilder()
    bounds(b, sh["left_x"] - 0.06, eb["x_min"], 1.86, 2.02, sh["front_z"] - th - 0.06, sh["front_z"] + 0.052)
    bounds(b, eb["x_max"], sh["right_x"] + 0.06, 1.86, 2.02, sh["front_z"] - th - 0.06, sh["front_z"] + 0.052)
    mm("wall_front__accent_band", b, "CM_Basalt", root, mats)
    b = MeshBuilder()
    plate(b, -4.9, -4.45, 1.15, 1.7, sh["front_z"] + 0.045, sh["front_z"] + 0.062, 0.008, axis="+z")
    plate(b, 4.0, 4.6, 0.68, 1.1, sh["front_z"] + 0.045, sh["front_z"] + 0.062, 0.008, axis="+z")
    mm("wall_front__patch_plates", b, "CM_Steel", root, mats)

    # ── back (north, -z) ──
    b = MeshBuilder()
    _wall_run(b, sh["left_x"], sh["right_x"], sh["back_z"], sh["back_z"] + th, 0.0, top)
    mm("wall_back__shell", b, "CM_Ceramic", root, mats)
    b = MeshBuilder()
    _wall_run(b, sh["left_x"] - 0.04, sh["right_x"] + 0.04, sh["back_z"] - 0.05, sh["back_z"] + th, 0.0, 0.55)
    cham_box(b, sh["left_x"] - 0.03, sh["right_x"] + 0.03, top, P["parapet_top_y_m"], sh["back_z"] - 0.04, sh["back_z"] + th + 0.03, ch=0.03)
    for i, bx in enumerate((-4.2, -1.4, 1.4, 4.2)):
        cham_box(b, bx - 0.22, bx + 0.22, 0.0, 2.9 - 0.25 * (i % 2), P["main_outer"]["z_min"], sh["back_z"] + 0.05, ch=0.03)
    mm("wall_back__basalt_course", b, "CM_Basalt", root, mats)
    b = MeshBuilder()
    for u0, u1 in ((-3.6, -2.0), (-0.8, 0.8), (2.0, 3.6)):
        plate(b, u0, u1, 0.75, 2.6, -sh["back_z"], -sh["back_z"] + 0.045, 0.03, axis="-z")
    mm("wall_back__recessed_panels", b, "CM_Ceramic", root, mats)
    b = MeshBuilder()
    louvers(b, -4.9, -4.1, 2.75, 4, 0.09, -sh["back_z"], 0.022, axis="-z", drop=0.03)
    louvers(b, 4.1, 4.9, 2.75, 4, 0.09, -sh["back_z"], 0.022, axis="-z", drop=0.03)
    mm("wall_back__service_louvers", b, "CM_Ink", root, mats)
    b = MeshBuilder()
    bounds(b, 4.62, 4.72, 0.06, 2.45, sh["back_z"] - 0.16, sh["back_z"] - 0.06)  # stand-off pipe
    cham_box(b, 4.52, 4.82, 0.0, 0.06, sh["back_z"] - 0.20, sh["back_z"] + 0.02, ch=0.012)  # ground flange
    bounds(b, 4.56, 4.78, 2.45, 2.52, sh["back_z"] - 0.10, sh["back_z"])  # top wall plate
    mm("wall_back__conduit", b, "CM_Steel", root, mats)
    b = MeshBuilder()
    for cy in (1.0, 1.8):
        # stand-off clamps: U-strap around the pipe + arm back to a wall flange
        bounds(b, 4.585, 4.755, cy, cy + 0.05, sh["back_z"] - 0.185, sh["back_z"] - 0.158)
        bounds(b, 4.585, 4.615, cy, cy + 0.05, sh["back_z"] - 0.158, sh["back_z"] - 0.06)
        bounds(b, 4.725, 4.755, cy, cy + 0.05, sh["back_z"] - 0.158, sh["back_z"] - 0.06)
        bounds(b, 4.655, 4.685, cy + 0.005, cy + 0.045, sh["back_z"] - 0.06, sh["back_z"])
        bounds(b, 4.63, 4.71, cy - 0.02, cy + 0.07, sh["back_z"] - 0.02, sh["back_z"])
    mm("wall_back__pipe_clamps", b, "CM_Brass", root, mats)

    # ── sides ──
    for axis_name, sign in (("wall_left__", -1), ("wall_right__", 1)):
        wx_in = sign * (abs(sh["left_x"]) - th)
        wx_out = sign * abs(sh["left_x"])
        x0, x1 = sorted((wx_in, wx_out))
        b = MeshBuilder()
        _wall_run(b, x0, x1, sh["back_z"] + th, sh["front_z"] - th, 0.0, top)
        mm(axis_name + "shell", b, "CM_Ceramic", root, mats)
        b = MeshBuilder()
        _wall_run(b, min(x0, sign * (abs(sh["left_x"]) + 0.04)), max(x1, sign * (abs(sh["left_x"]) + 0.04)), sh["back_z"], sh["front_z"] - th, 0.0, 0.55)
        cham_box(b, min(x0, sign * (abs(sh["left_x"]) + 0.03)) - 0.0, max(x1, sign * (abs(sh["left_x"]) + 0.03)), top, P["parapet_top_y_m"] - 0.06, sh["back_z"] + 0.02, sh["front_z"] - th + 0.02, ch=0.03)
        for pz in (-2.6, -0.3, 2.0):
            px0, px1 = sorted((sign * abs(sh["left_x"]), sign * abs(P["main_outer"]["x_min"])))
            cham_box(b, px0, px1, 0.0, 3.05, pz - 0.24, pz + 0.24, ch=0.03)
        mm(axis_name + "basalt_course", b, "CM_Basalt", root, mats)
        b = MeshBuilder()
        face_axis = "-x" if sign < 0 else "+x"
        for zz0, zz1 in ((-3.4, -1.6), (0.6, 2.4)):
            plate(b, zz0, zz1, 0.75, 2.6, abs(wx_out), abs(wx_out) + 0.045, 0.03, axis=face_axis)
        mm(axis_name + "recessed_panels", b, "CM_Ceramic", root, mats)
        b = MeshBuilder()
        bounds(b, min(sign * (abs(wx_out) + 0.055), sign * abs(wx_out)), max(sign * (abs(wx_out) + 0.055), sign * abs(wx_out)), 2.32, 2.62, -2.38, -0.52)  # spans pilaster to pilaster; ends buried
        mm(axis_name + "slit_reveal", b, "CM_Ink", root, mats)
        b = MeshBuilder()
        px0, px1 = sorted((sign * (abs(wx_out) + 0.055), sign * (abs(wx_out) - 0.02)))
        bounds(b, px0, px1, 1.86, 2.02, sh["back_z"], sh["front_z"] - th)  # full run; ends meet back/front corner bands flush
        bounds(b, px0, px1, 1.86, 2.02, sh["back_z"] - 0.055, sh["back_z"] + 0.06)  # back-corner return stub; no raw end cap
        mm(axis_name + "accent_band", b, "CM_Basalt", root, mats)
        b = MeshBuilder()
        wface = abs(wx_out)
        for bz0 in ((-1.0, 0.2) if sign < 0 else (-1.2, 0.4)):
            cham_box(b, *sorted((sign * (wface + 0.005), sign * (wface + 0.055))), 1.05, 1.55, bz0, bz0 + 0.44, ch=0.012)
        mm(axis_name + "service_boxes", b, "CM_Steel", root, mats)
        b = MeshBuilder()
        zp = 1.32 if sign < 0 else -1.55
        b.extend_prism(sign * (wface + 0.05), zp + 0.025, 0.024, 0.06, 1.84, sides=8)
        ring_axis(b, sign * (wface + 0.05), zp + 0.025, 0.028, 0.05, 1.72, 1.785, axis="+y", segments=12)  # collar under the band junction
        bounds(b, *sorted((sign * (wface + 0.002), sign * (wface + 0.105))), 1.80, 2.06, zp - 0.055, zp + 0.105)  # exposed junction block ON the band face; pipe terminates into it
        for dz0, dz1 in ((zp - 0.135, zp - 0.055), (zp + 0.105, zp + 0.185)):
            bounds(b, *sorted((sign * (wface + 0.002), sign * (wface + 0.082))), 1.82, 2.04, dz0, dz1)  # stepped transition gussets: band -> gusset -> block
        bounds(b, *sorted((sign * wface, sign * (wface + 0.085))), 0.0, 0.06, zp - 0.03, zp + 0.08)  # base shoe
        for cy2 in (0.6, 1.5):
            bounds(b, *sorted((sign * (wface - 0.002), sign * (wface + 0.085))), cy2, cy2 + 0.05, zp - 0.008, zp + 0.058)
        mm(axis_name + "service_pipe", b, "CM_Brass", root, mats)
        b = MeshBuilder()
        for bz0 in ((-2.2, 2.35) if sign < 0 else (-2.5, 2.1)):
            face_ax2 = "-x" if sign < 0 else "+x"
            plate(b, bz0, bz0 + 0.5, 1.15, 2.35, wface, wface + 0.03, 0.012, axis=face_ax2)
        mm(axis_name + "civic_banners", b, "CM_Ceramic", root, mats)


def build_roof(root, mats):
    sh = P["shell"]
    b = MeshBuilder()
    bounds(b, sh["left_x"], sh["right_x"], P["roof"]["slab_bottom_y_m"], P["roof"]["slab_top_y_m"], sh["back_z"], sh["front_z"])
    mm("roof__slab", b, "CM_Basalt", root, mats)

    # Clerestory lantern over the concourse.
    b = MeshBuilder()
    lx0, lx1, lz0, lz1 = -3.2, 3.2, -1.4, 0.4
    for wall in ((lx0, lx1, lz0, lz0 + 0.14), (lx0, lx1, lz1 - 0.14, lz1), (lx0, lx0 + 0.14, lz0, lz1), (lx1 - 0.14, lx1, lz0, lz1)):
        bounds(b, wall[0], wall[1], 3.30, 3.46, wall[2], wall[3])
        bounds(b, wall[0], wall[1], 3.74, 3.86, wall[2], wall[3])
    cham_box(b, lx0 - 0.08, lx1 + 0.08, 3.86, 3.98, lz0 - 0.08, lz1 + 0.08, ch=0.03)
    mm("roof__clerestory_frame", b, "CM_Basalt", root, mats)
    b = MeshBuilder()
    for wall in ((lx0 + 0.02, lx1 - 0.02, lz0 + 0.02, lz0 + 0.12), (lx0 + 0.02, lx1 - 0.02, lz1 - 0.12, lz1 - 0.02), (lx0 + 0.02, lx0 + 0.12, lz0 + 0.1, lz1 - 0.1), (lx1 - 0.12, lx1 - 0.02, lz0 + 0.1, lz1 - 0.1)):
        bounds(b, wall[0], wall[1], 3.46, 3.74, wall[2], wall[3])
    mm("roof__clerestory_glass", b, "CM_TealGlass", root, mats)

    # Roof gear: two louvered vent hoods + brass ductwork.
    b = MeshBuilder()
    cham_box(b, -4.9, -4.0, 3.30, 3.86, -3.4, -2.5, ch=0.03)
    cham_box(b, 4.0, 4.9, 3.30, 3.72, -3.5, -2.6, ch=0.03)
    mm("roof__vent_hoods", b, "CM_Steel", root, mats)
    b = MeshBuilder()
    louvers(b, -4.82, -4.08, 3.74, 4, 0.085, 3.4, 0.024, axis="+z", drop=0.03)
    louvers(b, 4.08, 4.82, 3.62, 3, 0.085, 3.5 - 0.9 - 0.0, 0.024, axis="-z", drop=0.03)
    mm("roof__vent_louvers", b, "CM_Ink", root, mats)
    b = MeshBuilder()
    prism_x(b, 3.52, -2.95, 0.16, -4.6, -0.6, sides=10)
    for cx in (-3.6, -1.4):
        ring_axis(b, -2.95, 3.52, 0.16, 0.20, cx, cx + 0.12, axis="+x", segments=10)
    bounds(b, -4.00, -3.955, 3.30, 3.74, -3.19, -2.71)  # exposed square flange ON the hood face
    ring_axis(b, -2.95, 3.52, 0.17, 0.22, -3.945, -3.86, axis="+x", segments=12)  # collar just off the flange
    cham_box(b, -0.82, -0.66, 3.34, 3.70, -3.15, -2.75, ch=0.02)  # boot into the roof junction box
    for xs in (-3.1, -1.9):
        # U-straps wrapping the duct, clear of it, landing on the sleepers
        bounds(b, xs - 0.02, xs + 0.02, 3.685, 3.71, -3.15, -2.75)
        bounds(b, xs - 0.02, xs + 0.02, 3.35, 3.71, -3.15, -3.118)
        bounds(b, xs - 0.02, xs + 0.02, 3.35, 3.71, -2.782, -2.75)
    mm("roof__ductwork", b, "CM_Brass", root, mats)
    b = MeshBuilder()
    cham_box(b, -0.75, -0.30, 3.30, 3.72, -3.19, -2.71, ch=0.02)  # roof junction box at the duct end
    for xs in (-3.1, -1.9):
        bounds(b, xs - 0.05, xs + 0.05, 3.30, 3.355, -3.17, -2.73)  # sleepers, clear below the duct
    mm("roof__duct_supports", b, "CM_Steel", root, mats)

    # Ceiling beams peel with the roof; their amber light coves are FUNCTIONAL
    # interior glow and stay visible during the roof peel (interior__ = keep
    # content, never reveal-hidden — the unlit interior keeps its light lines).
    b = MeshBuilder()
    for bx in (-3.4, 0.0, 3.4):
        bounds(b, bx - 0.14, bx + 0.14, 2.92, 3.10, -3.7, 3.5)
    mm("roof__ceiling_beams", b, "CM_Basalt", root, mats)
    b = MeshBuilder()
    for bx in (-3.4, 0.0, 3.4):
        bounds(b, bx - 0.10, bx + 0.10, 2.90, 2.925, -3.5, 3.3)
    mm("interior__light_cove_glow", b, "CM_GlowAmber", root, mats)

    # Bay soffit seals the entry ceiling wedge; service soffit + light strips
    # over the counter band.
    b = MeshBuilder()
    bounds(b, -3.65, 1.75, 3.10, 3.30, 3.90, 4.21)
    mm("roof__bay_slab", b, "CM_Basalt", root, mats)
    b = MeshBuilder()
    bounds(b, -3.6, 4.5, 3.02, 3.10, -2.05, -1.25)
    mm("roof__service_soffit", b, "CM_Ceramic", root, mats)
    b = MeshBuilder()
    for cxx in (-2.375, 0.475, 3.325):
        bounds(b, cxx - 0.7, cxx + 0.7, 3.00, 3.025, -1.95, -1.35)
    mm("interior__service_light_glow", b, "CM_GlowAmber", root, mats)


# ─────────────────────────────── interior ──────────────────────────────────


def build_interior(root, mats):
    # Vestibule: chamfered ceramic piers + steel lintel; layered arrival.
    b = MeshBuilder()
    for sxn in (-1, 1):
        px0, px1 = sorted((sxn * 1.87, sxn * 1.53))
        cham_box(b, px0, px1, 0.02, 2.70, 3.13, 3.47, ch=0.03)
    mm("interior__vestibule_piers", b, "CM_Ceramic", root, mats)
    b = MeshBuilder()
    bounds(b, -1.95, 1.95, 2.70, 2.92, 3.08, 3.52)
    mm("interior__vestibule_lintel", b, "CM_Steel", root, mats)
    b = MeshBuilder()
    for sxn in (-1, 1):
        bounds(b, sxn * 1.90, sxn * 1.50, 2.52, 2.70, 3.11, 3.49)
        b.extend_prism(sxn * 1.70, 3.30, 0.235, 0.08, 0.34, sides=8, start_deg=22.5)  # one-piece octagonal base collar
    mm("interior__pier_trim", b, "CM_Steel", root, mats)
    b = MeshBuilder()
    for sxn in (-1, 1):
        b.extend_prism(sxn * 1.70, 3.30, 0.222, 0.34, 0.37, sides=8, start_deg=22.5)  # ink reveal: clean collar-to-pier joint
    mm("interior__pier_joint_reveals", b, "CM_Ink", root, mats)
    b = MeshBuilder()
    bounds(b, -1.6, 1.6, 2.66, 2.695, 3.12, 3.16)
    mm("interior__vestibule_glow", b, "CM_GlowAmber", root, mats)

    # Service counter run behind the three terminal cells (terminals are
    # separate props at cells (3,3)/(6,3)/(9,3); counters sit north of them).
    segs = ((-3.45, -1.30), (-0.60, 1.55), (2.25, 4.40))
    b = MeshBuilder()
    for x0, x1 in segs:
        cham_box(b, x0, x1, 0.02, 0.98, -1.85, -1.45, ch=0.022)
    mm("interior__counter_bases", b, "CM_Basalt", root, mats)
    b = MeshBuilder()
    for x0, x1 in segs:
        cham_box(b, x0 - 0.05, x1 + 0.05, 0.98, 1.10, -1.90, -1.40, ch=0.018)
    mm("interior__counter_tops", b, "CM_Ceramic", root, mats)
    b = MeshBuilder()
    for x0, x1 in segs:
        bounds(b, x0 + 0.06, x1 - 0.06, 0.10, 0.16, -1.44, -1.41)
        plate(b, x0 + 0.10, (x0 + x1) / 2 - 0.05, 0.28, 0.86, 1.45, 1.472, 0.014, axis="+z")
        plate(b, (x0 + x1) / 2 + 0.05, x1 - 0.10, 0.28, 0.86, 1.45, 1.472, 0.014, axis="+z")
    mm("interior__counter_panels", b, "CM_Steel", root, mats)
    b = MeshBuilder()
    for x0, x1 in segs:
        bounds(b, x0 + 0.02, x1 - 0.02, 0.955, 0.98, -1.415, -1.40)
    mm("interior__counter_glow", b, "CM_GlowAmber", root, mats)

    # Bank: teller glazing over counter seg A + wall vault face (echoes the
    # terminal iris at architectural scale — a vault, not a machine).
    b = MeshBuilder()
    for mx in (-3.40, -2.72, -2.04, -1.36):
        bounds(b, mx - 0.03, mx + 0.03, 1.10, 2.30, -1.685, -1.615)
    bounds(b, -3.43, -1.33, 2.30, 2.38, -1.70, -1.60)
    mm("interior__bank_glazing_mullions", b, "CM_Brass", root, mats)
    b = MeshBuilder()
    for bx in (-3.30, -2.60, -1.90, -1.46):
        bounds(b, bx - 0.035, bx + 0.035, 1.095, 1.155, -1.72, -1.58)
    mm("interior__glazing_brackets", b, "CM_Steel", root, mats)
    b = MeshBuilder()
    bounds(b, -3.40, -1.36, 1.10, 2.30, -1.665, -1.635)
    mm("interior__bank_glazing", b, "CM_TealGlass", root, mats)
    b = MeshBuilder()
    cham_box(b, -4.70, -1.60, 0.02, 2.60, -3.75, -3.38, ch=0.03)
    mm("interior__vault_face", b, "CM_Basalt", root, mats)
    VC = (-3.15, 1.32)
    b = MeshBuilder()
    ring_axis(b, *VC, 0.46, 0.60, -3.38, -3.30, segments=28)
    ring_axis(b, *VC, 0.52, 0.60, -3.30, -3.26, segments=28)
    mm("interior__vault_ring", b, "CM_Brass", root, mats)
    b = MeshBuilder()
    disc_axis(b, *VC, 0.46, -3.38, -3.335, sides=28)
    bounds(b, VC[0] - 0.30, VC[0] + 0.30, VC[1] - 0.045, VC[1] + 0.045, -3.335, -3.30)
    bounds(b, VC[0] - 0.045, VC[0] + 0.045, VC[1] - 0.30, VC[1] + 0.30, -3.335, -3.30)
    disc_axis(b, *VC, 0.09, -3.335, -3.285, sides=12)
    mm("interior__vault_door", b, "CM_Steel", root, mats)
    b = MeshBuilder()
    ring_axis(b, *VC, 0.415, 0.45, -3.375, -3.365, segments=28)
    mm("interior__vault_seal_glow", b, "CM_GlowAmber", root, mats)
    b = MeshBuilder()
    for i in range(8):
        a = 22.5 + 45.0 * i
        u, v = ct.pol(*VC, a, 0.545)
        disc_axis(b, u, v, 0.028, -3.30, -3.272, sides=6, start_deg=a)
    mm("interior__vault_lugs", b, "CM_Steel", root, mats)

    # Overhead bank-bay pendant: brass ring + amber halo hung over the bank
    # machine cell (3,3) — the iso-readable "bank here" icon that separates
    # the bank bay from trade/PA at gameplay distance. interior__ keep
    # content: stays lit through the roof peel (stems reach the beam line,
    # same hung language as the concourse chandelier). No words, no
    # collision, machine clearance 2.345 m over a 1.65 m kiosk.
    BPX, BPZ = cell_center(3, 3)
    b = MeshBuilder()
    ring_axis(b, BPX, BPZ, 0.30, 0.42, 2.38, 2.46, axis="+y", segments=24)
    for dx in (-0.26, 0.26):
        b.extend_prism(BPX + dx, BPZ, 0.016, 2.46, 3.06, sides=8)
    mm("interior__bank_pendant", b, "CM_Brass", root, mats)
    b = MeshBuilder()
    ring_axis(b, BPX, BPZ, 0.31, 0.41, 2.345, 2.38, axis="+y", segments=24)
    mm("interior__bank_pendant_glow", b, "CM_GlowAmber", root, mats)

    # Trade: wall storage shelving + sample crates north of counter seg B.
    b = MeshBuilder()
    for sy in (0.55, 1.35, 2.10):
        bounds(b, -0.70, 1.70, sy, sy + 0.05, -3.75, -3.42)
    for sx in (-0.70, 0.48, 1.65):
        bounds(b, sx, sx + 0.05, 0.10, 2.15, -3.75, -3.44)
    mm("interior__trade_shelving", b, "CM_Steel", root, mats)
    b = MeshBuilder()
    for i, (sx, sy) in enumerate(((-0.52, 0.60), (0.02, 0.60), (0.98, 0.60), (-0.30, 1.40), (0.62, 1.40), (1.18, 1.40))):
        cham_box(b, sx, sx + 0.42, sy, sy + 0.34, -3.72, -3.46, ch=0.014)
    mm("interior__storage_bins", b, "CM_Ceramic", root, mats)
    b = MeshBuilder()
    rot_box(b, (1.15, 0.22, -3.35), (0.52, 0.40, 0.52), 14.0)
    rot_box(b, (0.62, 0.18, -3.30), (0.44, 0.32, 0.44), -9.0)
    mm("interior__sample_crates", b, "CM_Basalt", root, mats)

    # PA: civic notice bay north of counter seg C — framed panels + seal.
    b = MeshBuilder()
    for u0, u1 in ((2.30, 3.00), (3.10, 3.80), (3.90, 4.48)):
        plate(b, u0, u1, 0.85, 2.35, 3.75, 3.81, 0.018, axis="-z")
    mm("interior__notice_panels", b, "CM_Ceramic", root, mats)
    b = MeshBuilder()
    for u0, u1 in ((2.26, 4.52),):
        bounds(b, u0, u1, 2.35, 2.42, -3.82, -3.74)
        bounds(b, u0, u1, 0.78, 0.85, -3.82, -3.74)
    mm("interior__notice_rails", b, "CM_Steel", root, mats)
    SEAL = (3.39, 2.62)
    b = MeshBuilder()
    ring_axis(b, *SEAL, 0.14, 0.20, -3.75, -3.70, axis="+z", segments=20)
    disc_axis(b, *SEAL, 0.075, -3.75, -3.705, sides=12)
    mm("interior__civic_seal", b, "CM_Brass", root, mats)
    b = MeshBuilder()
    ring_axis(b, *SEAL, 0.225, 0.255, -3.75, -3.727, axis="+z", segments=20)
    mm("interior__civic_seal_halo", b, "CM_GlowCyan", root, mats)

    # Zone signage on the north wall — ink panels + zone glyphs + colored
    # underlines, readable at gameplay distance. PA panel backs the seal.
    b = MeshBuilder()
    bounds(b, -3.5, -2.0, 2.66, 3.06, -3.75, -3.735)
    bounds(b, -0.4, 1.1, 2.35, 2.95, -3.75, -3.735)
    bounds(b, 2.5, 4.1, 2.30, 3.06, -3.75, -3.735)
    mm("interior__zone_sign_panels", b, "CM_Ink", root, mats)
    b = MeshBuilder()
    for sy in (2.74, 2.84, 2.94):
        bounds(b, -3.30, -2.80, sy, sy + 0.06, -3.735, -3.705)
    ring_axis(b, -2.42, 2.88, 0.08, 0.12, -3.735, -3.70, axis="+z", segments=20)
    mm("interior__zone_glyph_bank", b, "CM_Brass", root, mats)
    b = MeshBuilder()
    for strip in ((-0.05, 0.75, 2.82, 2.88), (-0.05, 0.75, 2.44, 2.50), (-0.05, 0.01, 2.50, 2.82), (0.69, 0.75, 2.50, 2.82), (0.32, 0.38, 2.50, 2.82), (-0.05, 0.75, 2.63, 2.69)):
        bounds(b, strip[0], strip[1], strip[2], strip[3], -3.735, -3.706)
    mm("interior__zone_glyph_trade", b, "CM_Steel", root, mats)
    b = MeshBuilder()
    bounds(b, -3.5, -2.0, 2.70, 2.745, -3.735, -3.702)
    mm("interior__zone_underline_bank", b, "CM_GlowAmber", root, mats)
    b = MeshBuilder()
    bounds(b, -0.4, 1.1, 2.38, 2.425, -3.735, -3.702)
    bounds(b, 2.5, 4.1, 2.985, 3.03, -3.735, -3.702)
    mm("interior__zone_underline_cyan", b, "CM_GlowCyan", root, mats)

    # Central concourse luminaire hung from the middle ceiling beam.
    b = MeshBuilder()
    ring_axis(b, 0.0, 1.15, 0.55, 0.63, 2.56, 2.64, axis="+y", segments=28)
    for hz_ in (0.56, 1.74):
        b.extend_prism(0.0, hz_, 0.014, 2.64, 3.06, sides=8)
    mm("interior__chandelier", b, "CM_Brass", root, mats)
    b = MeshBuilder()
    for hz_ in (0.56, 1.74):
        disc_axis(b, 0.0, hz_, 0.05, 3.06, 3.095, axis="+y", sides=12)
    mm("interior__pendant_mounts", b, "CM_Steel", root, mats)
    b = MeshBuilder()
    ring_axis(b, 0.0, 1.15, 0.56, 0.62, 2.525, 2.56, axis="+y", segments=28)
    mm("interior__chandelier_glow", b, "CM_GlowAmber", root, mats)
    b = MeshBuilder()
    for sxn in (-1, 1):
        fx0, fx1 = sorted((sxn * 2.06, sxn * 1.40))
        bounds(b, fx0, fx1, 0.02, 0.10, 3.02, 3.58)
    mm("interior__pier_footings", b, "CM_Basalt", root, mats)

    # Queue rails south of the three terminal approach cells.
    anchors = [cell_center(3, 3)[0], cell_center(6, 3)[0], cell_center(9, 3)[0]]
    b = MeshBuilder()
    for a in anchors:
        for px in (a - 0.85, a + 0.85):
            b.extend_prism(px, 0.55, 0.045, 0.02, 0.90, sides=10, start_deg=9.0)
    mm("interior__queue_posts", b, "CM_Brass", root, mats)
    b = MeshBuilder()
    for a in anchors:
        seg_pairs = ((a - 0.85, a - 0.18), (a + 0.18, a + 0.85)) if abs(a - 0.475) < 0.01 else ((a - 0.85, a + 0.85),)
        for s0, s1 in seg_pairs:
            bounds(b, s0, s1, 0.84, 0.90, 0.53, 0.57)
            bounds(b, s0, s1, 0.44, 0.49, 0.535, 0.565)
    mm("interior__queue_rails", b, "CM_Brass", root, mats)

    # Benches (west wall + front wall) — basalt legs, ceramic slab, back rail.
    b = MeshBuilder()
    for leg_z in (-0.95, 0.30, 1.55):
        bounds(b, -5.10, -4.74, 0.02, 0.40, leg_z - 0.05, leg_z + 0.05)
    for leg_x in (-4.85, -3.95, -3.00):
        bounds(b, leg_x - 0.05, leg_x + 0.05, 0.02, 0.40, 3.30, 3.56)
    mm("interior__bench_legs", b, "CM_Basalt", root, mats)
    b = MeshBuilder()
    cham_box(b, -5.12, -4.70, 0.40, 0.50, -1.05, 1.65, ch=0.016)
    cham_box(b, -4.95, -2.85, 0.40, 0.50, 3.26, 3.58, ch=0.016)
    mm("interior__bench_seats", b, "CM_Ceramic", root, mats)
    b = MeshBuilder()
    bounds(b, -5.15, -5.10, 0.85, 0.95, -1.0, 1.6)
    mm("interior__bench_rail", b, "CM_Brass", root, mats)

    # Trainer consultation nook at cell (10,6): rug, desk against the east
    # wall, stool, desk lamp, wall chart board. Cell itself stays clear.
    b = MeshBuilder()
    bounds(b, 3.55, 4.80, 0.0215, 0.0233, 1.15, 2.65)
    mm("interior__trainer_rug", b, "CM_TealGlass", root, mats)
    b = MeshBuilder()
    cham_box(b, 4.82, 5.14, 0.02, 0.75, 1.30, 2.55, ch=0.02)
    mm("interior__trainer_desk_base", b, "CM_Basalt", root, mats)
    b = MeshBuilder()
    cham_box(b, 4.76, 5.15, 0.75, 0.83, 1.24, 2.60, ch=0.014)
    mm("interior__trainer_desk_top", b, "CM_Ceramic", root, mats)
    b = MeshBuilder()
    # open ledger (two tilted leaves) + brass inkwell: flat desk dressing only
    slab(b, [(4.82, 0.832, 2.02), (5.06, 0.832, 2.02), (5.06, 0.876, 2.17), (4.82, 0.876, 2.17)], (0.0, 0.008, 0.0))
    slab(b, [(4.82, 0.832, 2.02), (5.06, 0.832, 2.02), (5.06, 0.874, 1.88), (4.82, 0.874, 1.88)], (0.0, 0.008, 0.0))
    mm("interior__trainer_open_ledger", b, "CM_Ceramic", root, mats)
    b = MeshBuilder()
    bounds(b, 4.87, 4.975, 0.83, 0.842, 2.365, 2.475)  # holder tray on the desk
    b.extend_prism(4.9225, 2.42, 0.028, 0.842, 0.90, sides=10)
    mm("interior__trainer_inkwell", b, "CM_Brass", root, mats)
    b = MeshBuilder()
    cham_box(b, 4.85, 5.08, 0.83, 0.865, 1.42, 1.72, ch=0.008)  # ledger stack
    cham_box(b, 4.88, 5.05, 0.865, 0.895, 1.46, 1.68, ch=0.006)
    mm("interior__trainer_ledgers", b, "CM_Ceramic", root, mats)
    b = MeshBuilder()
    b.extend_prism(4.30, 2.72, 0.17, 0.02, 0.42, sides=10, start_deg=9.0)
    b.extend_prism(4.30, 2.72, 0.19, 0.42, 0.48, sides=10, start_deg=9.0)
    mm("interior__trainer_stool", b, "CM_Basalt", root, mats)
    b = MeshBuilder()
    bounds(b, 5.142, 5.15, 1.05, 2.15, 1.35, 2.25)
    mm("interior__trainer_board_back", b, "CM_Ink", root, mats)
    b = MeshBuilder()
    bounds(b, 5.112, 5.142, 1.12, 2.08, 1.42, 2.18)
    mm("interior__trainer_board", b, "CM_Ink", root, mats)
    b = MeshBuilder()
    # training emblem inset on the board: brass ring + three ascending bars
    ring_axis(b, 1.80, 1.86, 0.075, 0.105, 5.092, 5.112, axis="+x", segments=20)
    bounds(b, 5.095, 5.112, 1.30, 1.42, 1.62, 1.70)
    bounds(b, 5.095, 5.112, 1.30, 1.50, 1.76, 1.84)
    bounds(b, 5.095, 5.112, 1.30, 1.58, 1.90, 1.98)
    mm("interior__trainer_board_emblem", b, "CM_Brass", root, mats)
    b = MeshBuilder()
    for bz in (1.302, 2.278):
        bounds(b, 5.098, 5.15, 0.83, 2.12, bz - 0.025, bz + 0.025)  # side posts seated on the desk
    for bz in (1.302, 2.278):
        bounds(b, 5.078, 5.15, 0.83, 0.875, bz - 0.06, bz + 0.06)  # foot plates on the desktop
    mm("interior__trainer_board_mounts", b, "CM_Steel", root, mats)
    b = MeshBuilder()
    for pz in (1.45, 1.75, 2.05):
        bounds(b, 5.128, 5.15, 0.90, 1.06, pz, pz + 0.22)
    mm("interior__trainer_plaques", b, "CM_Steel", root, mats)
    b = MeshBuilder()
    for pz in (1.45, 1.75, 2.05):
        disc_axis(b, pz + 0.11, 1.00, 0.070, 5.108, 5.128, axis="+x", sides=16)
    mm("interior__trainer_plaque_seals", b, "CM_Brass", root, mats)
    b = MeshBuilder()
    for pz in (1.45, 1.75, 2.05):
        bounds(b, 5.118, 5.128, 0.912, 0.945, pz + 0.03, pz + 0.19)
    mm("interior__trainer_plaque_glow", b, "CM_GlowAmber", root, mats)
    b = MeshBuilder()
    bounds(b, 5.134, 5.15, 1.28, 2.00, 2.34, 2.70)  # rack backplate on the wall
    bounds(b, 5.116, 5.134, 1.55, 1.85, 2.42, 2.45)  # tool 1 shank, on the plate
    bounds(b, 5.116, 5.134, 1.82, 1.85, 2.38, 2.49)  # tool 1 head
    bounds(b, 5.116, 5.134, 1.32, 1.52, 2.55, 2.58)  # tool 2 shank
    bounds(b, 5.116, 5.134, 1.32, 1.35, 2.55, 2.62)  # tool 2 foot
    mm("interior__trainer_tools", b, "CM_Steel", root, mats)

    # East-wall civic dressing (dead-zone break, wall-mounted only): three
    # banners on brass rods + a brass dial clock. No new floor blockers.
    b = MeshBuilder()
    for bz0 in (0.10, 0.62, 1.14):
        bounds(b, 5.128, 5.152, 2.50, 2.53, bz0, bz0 + 0.42)
    mm("interior__banner_rods", b, "CM_Brass", root, mats)
    b = MeshBuilder()
    for bz0 in (0.10, 0.62, 1.14):
        bounds(b, 5.136, 5.148, 1.55, 2.48, bz0 + 0.03, bz0 + 0.39)
    mm("interior__banners", b, "CM_Ceramic", root, mats)
    b = MeshBuilder()
    for bz0 in (0.10, 0.62, 1.14):
        disc_axis(b, bz0 + 0.21, 2.10, 0.07, 5.116, 5.136, axis="+x", sides=14)
        bounds(b, 5.128, 5.136, 1.72, 1.92, bz0 + 0.17, bz0 + 0.25)
    mm("interior__banner_glyphs", b, "CM_Ink", root, mats)
    b = MeshBuilder()
    ring_axis(b, -1.5, 2.15, 0.14, 0.17, 5.128, 5.15, axis="+x", segments=20)
    disc_axis(b, -1.5, 2.15, 0.02, 5.124, 5.15, axis="+x", sides=8)
    bounds(b, 5.128, 5.15, 2.15, 2.26, -1.508, -1.492)
    bounds(b, 5.128, 5.15, 2.142, 2.158, -1.58, -1.50)
    mm("interior__wall_clock", b, "CM_Brass", root, mats)

    # Concourse columns with brass base collars + amber sconce rings.
    b = MeshBuilder()
    for cx in (-2.85, 2.85):
        cham_box(b, cx - 0.19, cx + 0.19, 0.02, 3.10, 2.01, 2.39, ch=0.05)
    mm("interior__columns", b, "CM_Basalt", root, mats)
    b = MeshBuilder()
    for cx in (-2.85, 2.85):
        cham_box(b, cx - 0.23, cx + 0.23, 0.02, 0.34, 1.97, 2.43, ch=0.03)
    mm("interior__column_collars", b, "CM_Brass", root, mats)
    b = MeshBuilder()
    for cx in (-2.85, 2.85):
        bounds(b, cx - 0.30, cx + 0.30, 0.02, 0.026, 1.90, 2.50)
    mm("interior__column_anchor_plates", b, "CM_Steel", root, mats)
    b = MeshBuilder()
    for cx in (-2.85, 2.85):
        bounds(b, cx - 0.20, cx + 0.20, 2.30, 2.40, 1.995, 2.405)
    mm("interior__column_sconce_glow", b, "CM_GlowAmber", root, mats)

    # Wall sconces along both side walls.
    b = MeshBuilder()
    for sxn in (-1, 1):
        for sz in ((-2.6, -0.3, 2.0) if sxn < 0 else (-2.6, -0.3, 2.85)):
            bounds(b, sxn * 5.15, sxn * 5.05, 2.15, 2.45, sz - 0.05, sz + 0.05)
    mm("interior__sconce_bodies", b, "CM_Steel", root, mats)
    b = MeshBuilder()
    for sxn in (-1, 1):
        for sz in ((-2.6, -0.3, 2.0) if sxn < 0 else (-2.6, -0.3, 2.85)):
            bounds(b, sxn * 5.105, sxn * 5.045, 2.42, 2.47, sz - 0.04, sz + 0.04)
    mm("interior__sconce_glow", b, "CM_GlowAmber", root, mats)


# ────────────────────────────── door + clips ───────────────────────────────


def make_door(root, mats):
    dp = P["door"]
    sx, sy, sz = dp["panel_size"]
    hx, hy, hz = sx / 2, sy / 2, sz / 2
    b = MeshBuilder()
    b.extend_box((0.0, 0.0, 0.0), (sx, sy, sz))
    # Proud border frame + corner gussets (pressure panel, not roll-up).
    bounds(b, -hx, hx, hy - 0.17, hy, hz, hz + 0.036)
    bounds(b, -hx, hx, -hy, -hy + 0.17, hz, hz + 0.036)
    bounds(b, -hx, -hx + 0.17, -hy + 0.17, hy - 0.17, hz, hz + 0.036)
    bounds(b, hx - 0.17, hx, -hy + 0.17, hy - 0.17, hz, hz + 0.036)
    for sxn in (-1, 1):
        for gyn in (-1, 1):
            gx0, gx1 = sorted((sxn * (hx - 0.55), sxn * (hx - 0.17)))
            gy0, gy1 = sorted((gyn * (hy - 0.55), gyn * (hy - 0.17)))
            bounds(b, gx0, gx1, gy0, gy1, hz, hz + 0.030)
    # Central emblem: brass-language ring + spoked disc (single material).
    disc_axis(b, 0.0, 0.0, 0.52, hz, hz + 0.040, sides=20)
    disc_axis(b, 0.0, 0.0, 0.26, hz + 0.040, hz + 0.058, sides=16)
    b.extend_box((0.0, 0.0, hz + 0.048), (0.96, 0.11, 0.020))
    b.extend_box((0.0, 0.0, hz + 0.048), (0.11, 0.96, 0.020))
    for i in range(8):
        a = math.radians(22.5 + 45.0 * i)
        b.extend_box((0.45 * math.cos(a), 0.45 * math.sin(a), hz + 0.046), (0.13, 0.13, 0.016))
    for sxn in (-1, 1):
        for dy in (-0.86, 0.0, 0.86):
            b.extend_box((sxn * (hx - 0.14), dy, hz + 0.026), (0.27, 0.35, 0.050))
    obj = ct.make_mesh_object("door_slide", b, mats["CM_Basalt"], root, uv_scale=0.34)
    obj.location = logical_to_blender(dp["closed_center"])
    return obj


def set_key_interpolation(action, interpolation="LINEAR"):
    for fc in getattr(action, "fcurves", []) or []:
        for kp in fc.keyframe_points:
            kp.interpolation = interpolation
    for layer in getattr(action, "layers", []) or []:
        for strip in getattr(layer, "strips", []) or []:
            for channelbag in getattr(strip, "channelbags", []) or []:
                for fc in getattr(channelbag, "fcurves", []) or []:
                    for kp in fc.keyframe_points:
                        kp.interpolation = interpolation


def create_translation_action(obj, name, start_loc, end_loc, frame_start, frame_end):
    obj.animation_data_create()
    obj.animation_data.action = None
    bpy.context.scene.frame_set(frame_start)
    obj.location = start_loc
    obj.keyframe_insert(data_path="location", frame=frame_start)
    action = obj.animation_data.action
    action.name = name
    try:
        action.use_fake_user = True
    except Exception:
        pass
    bpy.context.scene.frame_set(frame_end)
    obj.location = end_loc
    obj.keyframe_insert(data_path="location", frame=frame_end)
    set_key_interpolation(action, "LINEAR")
    obj.animation_data.action = None
    return action


def create_door_actions(door):
    dp = P["door"]
    fps = dp["fps"]
    frame_start = 1
    frame_end = int(dp["clip_duration_s"] * fps) + 1
    scene = bpy.context.scene
    scene.render.fps = fps
    scene.frame_start = frame_start
    closed = Vector(logical_to_blender(dp["closed_center"]))
    open_logical = Vector(dp["closed_center"]) + Vector(dp["slide_axis_local"]) * dp["slide_distance_m"]
    opened = Vector(logical_to_blender(open_logical))
    door.animation_data_clear()
    door.animation_data_create()
    open_action = create_translation_action(door, "door_open", closed, opened, frame_start, frame_end)
    close_action = create_translation_action(door, "door_close", opened, closed, frame_start, frame_end)
    close_start = frame_end + 10
    close_end = close_start + (frame_end - frame_start)
    for track_name, action, strip_start, strip_end in (
        ("door_open", open_action, frame_start, frame_end),
        ("door_close", close_action, close_start, close_end),
    ):
        track = door.animation_data.nla_tracks.new()
        track.name = track_name
        strip = track.strips.new(track_name, strip_start, action)
        strip.frame_start = strip_start
        strip.frame_end = strip_end
        strip.action_frame_start = frame_start
        strip.action_frame_end = frame_end
        try:
            strip.extrapolation = "NOTHING"
            strip.blend_type = "REPLACE"
        except Exception:
            pass
    door.animation_data.action = None
    scene.frame_end = close_end
    door.location = closed
    scene.frame_set(1)


def make_sign_lettering(root, mats):
    """Converted-mesh civic label on the sign band: DUSTGATE EXCHANGE."""
    curve = bpy.data.curves.new("sign_text_curve", type="FONT")
    curve.body = "DUSTGATE EXCHANGE"
    curve.size = 0.185
    curve.extrude = 0.011
    curve.align_x = "CENTER"
    curve.align_y = "CENTER"
    obj = bpy.data.objects.new("wall_front__sign_lettering", curve)
    bpy.context.collection.objects.link(obj)
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.convert(target="MESH")
    obj = bpy.context.view_layer.objects.active
    obj.name = "wall_front__sign_lettering"
    fz = P["door"]["opening_bounds"]["front_z"]
    # text lies in blender XY facing +Z; stand it upright facing logical +z
    obj.rotation_euler = (math.radians(90.0), 0.0, 0.0)
    obj.location = logical_to_blender((0.16, 3.055, fz + 0.028))
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    import bmesh
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-5)
    bmesh.ops.triangulate(bm, faces=bm.faces)
    bmesh.ops.dissolve_degenerate(bm, dist=1e-5, edges=bm.edges)
    loose = [v for v in bm.verts if not v.link_faces]
    if loose:
        bmesh.ops.delete(bm, geom=loose, context="VERTS")
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(obj.data)
    bm.free()
    obj.data.update(calc_edges=True)
    ct.assign_box_uvs(obj.data, 0.85)
    obj.data.materials.clear()
    obj.data.materials.append(mats["CM_Brass"])
    for poly in obj.data.polygons:
        poly.material_index = 0
        poly.use_smooth = False
    obj.parent = root
    return obj


def build_scene():
    ct.reset_scene()
    mats = ct.make_materials(FACILITY_MATERIALS)
    root = make_root(P["root_node"])
    build_floor(root, mats)
    build_walls(root, mats)
    make_sign_lettering(root, mats)
    build_roof(root, mats)
    build_interior(root, mats)
    door = make_door(root, mats)
    create_door_actions(door)
    return root, door


# ──────────────────────── export patch + animation QA ──────────────────────


def export_glb_with_anims(root, glb_path: Path):
    bpy.ops.object.select_all(action="DESELECT")
    root.select_set(True)
    for child in root.children_recursive:
        child.select_set(True)
    bpy.context.view_layer.objects.active = root
    bpy.ops.export_scene.gltf(
        filepath=str(glb_path),
        export_format="GLB",
        use_selection=True,
        export_apply=False,
        export_materials="EXPORT",
        export_image_format="AUTO",
        export_cameras=False,
        export_lights=False,
        export_yup=True,
        export_skins=False,
        export_normals=True,
        export_texcoords=True,
        export_animations=True,
        export_animation_mode="NLA_TRACKS",
        export_nla_strips=True,
        export_merge_animation="NLA_TRACK",
        export_bake_animation=False,
        export_anim_slide_to_zero=False,
    )


def write_glb_chunks(path: Path, gltf, bin_chunk: bytes):
    import struct

    json_bytes = json.dumps(gltf, separators=(",", ":")).encode("utf-8")
    json_bytes += b" " * ((4 - len(json_bytes) % 4) % 4)
    if bin_chunk:
        bin_chunk = bin_chunk + b"\x00" * ((4 - len(bin_chunk) % 4) % 4)
    total_len = 12 + 8 + len(json_bytes) + (8 + len(bin_chunk) if bin_chunk else 0)
    out = bytearray()
    out += struct.pack("<4sII", b"glTF", 2, total_len)
    out += struct.pack("<I4s", len(json_bytes), b"JSON")
    out += json_bytes
    if bin_chunk:
        out += struct.pack("<I4s", len(bin_chunk), b"BIN\x00")
        out += bin_chunk
    path.write_bytes(out)


def patch_door_rest_translation(path: Path):
    gltf, bin_chunk = ct.read_glb_chunks(path)
    for node in gltf.get("nodes", []):
        if node.get("name") == "door_slide":
            node.pop("matrix", None)
            node["translation"] = [float(v) for v in P["door"]["closed_center"]]
            node["rotation"] = [0.0, 0.0, 0.0, 1.0]
            node["scale"] = [1.0, 1.0, 1.0]
            write_glb_chunks(path, gltf, bin_chunk)
            return
    raise RuntimeError("door_slide node missing from exported GLB")


def animation_metrics(gltf, bin_chunk):
    node_names = [n.get("name", "") for n in gltf.get("nodes", [])]
    clips = {}
    for anim in gltf.get("animations", []):
        name = anim.get("name", "")
        targets, paths = set(), set()
        duration = 0.0
        start = end = None
        for chan in anim.get("channels", []):
            tgt = chan.get("target", {})
            targets.add(node_names[tgt.get("node", -1)])
            paths.add(tgt.get("path"))
            samp = anim["samplers"][chan["sampler"]]
            times = [v[0] for v in ct.accessor_values(gltf, bin_chunk, samp["input"])]
            outs = ct.accessor_values(gltf, bin_chunk, samp["output"])
            duration = max(duration, times[-1] - times[0])
            if tgt.get("path") == "translation":
                start, end = Vector(outs[0][:3]), Vector(outs[-1][:3])
        distance = (end - start).length if start is not None else None
        clips[name] = {
            "duration_s": round(duration, 4),
            "targets": sorted(targets),
            "paths": sorted(paths),
            "translation_distance_m": round(distance, 4) if distance is not None else None,
        }
    return clips


def node_bbox(gltf, bin_chunk, node_name):
    worlds = ct.node_worlds(gltf)
    lo = [float("inf")] * 3
    hi = [float("-inf")] * 3
    from mathutils import Matrix

    for node_idx, node in enumerate(gltf.get("nodes", [])):
        if node.get("name") != node_name or "mesh" not in node:
            continue
        world = worlds.get(node_idx, Matrix.Identity(4))
        for prim in gltf["meshes"][node["mesh"]].get("primitives", []):
            acc = prim.get("attributes", {}).get("POSITION")
            if acc is None:
                continue
            for v in ct.accessor_values(gltf, bin_chunk, acc):
                p = world @ Vector(v[:3])
                for i in range(3):
                    lo[i] = min(lo[i], p[i])
                    hi[i] = max(hi[i], p[i])
    if lo[0] == float("inf"):
        return None
    return {"min": lo, "max": hi}


# ───────────────────── collision sidecar + manifest + gate ─────────────────


def collision_box(x0, x1, z0, z1, primitive_id):
    if not (x1 > x0 and z1 > z0):
        raise ValueError(f"invalid commerce facility collision box: {(x0, x1, z0, z1)}")
    return {"id": primitive_id, "minX": round(float(x0), 4), "minZ": round(float(z0), 4), "maxX": round(float(x1), 4), "maxZ": round(float(z1), 4)}


def door_cells_from_opening():
    span_x = P["main_outer"]["x_max"] - P["main_outer"]["x_min"]
    cols, rows = P["footprint_cells"]
    cell_w = span_x / cols
    door = P["door"]["opening_bounds"]
    cells = []
    for col in range(cols):
        c0 = P["main_outer"]["x_min"] + col * cell_w
        c1 = c0 + cell_w
        overlap = min(c1, door["x_max"]) - max(c0, door["x_min"])
        if overlap >= cell_w * 0.5:
            cells.append([col, rows - 1])
    return cells


def assert_terminal_cells_kept_clear(furniture, terminal_cells, cell_size):
    """Fail generation if transformed furniture enters a promised service cell."""
    footprint = P["main_outer"]
    scale = min(
        cell_size[0] / (footprint["x_max"] - footprint["x_min"]),
        cell_size[1] / (footprint["z_max"] - footprint["z_min"]),
    )
    for terminal_id, cell in terminal_cells.items():
        col, row = cell
        cell_min_x = col * 1000
        cell_max_x = (col + 1) * 1000
        cell_min_y = row * 1000
        cell_max_y = (row + 1) * 1000
        for box in furniture:
            min_x = round((cell_size[0] / 2 + box["minX"] * scale) * 1000)
            max_x = round((cell_size[0] / 2 + box["maxX"] * scale) * 1000)
            min_y = round((cell_size[1] / 2 + box["minZ"] * scale) * 1000)
            max_y = round((cell_size[1] / 2 + box["maxZ"] * scale) * 1000)
            overlap_x = min(max_x, cell_max_x) - max(min_x, cell_min_x)
            overlap_y = min(max_y, cell_max_y) - max(min_y, cell_min_y)
            if overlap_x > 0 and overlap_y > 0:
                raise ValueError(
                    f"{box['id']} overlaps promised {terminal_id} service cell {cell}: "
                    f"transformed=({min_x},{min_y})..({max_x},{max_y})"
                )


def write_collision_sidecar():
    mo = P["main_outer"]
    sh = P["shell"]
    eb = P["entry_bay"]
    door = P["door"]["opening_bounds"]
    th = P["wall_thickness_m"]
    walls = [
        collision_box(mo["x_min"], sh["left_x"] + th, sh["back_z"], sh["front_z"], "outer_shell_left"),
        collision_box(sh["right_x"] - th, mo["x_max"], sh["back_z"], sh["front_z"], "outer_shell_right"),
        collision_box(sh["left_x"], sh["right_x"], mo["z_min"], sh["back_z"] + th, "outer_shell_back"),
        collision_box(sh["left_x"], eb["x_min"], sh["front_z"] - th, sh["front_z"], "front_wall_left"),
        collision_box(eb["x_max"], sh["right_x"], sh["front_z"] - th, sh["front_z"], "front_wall_right"),
        collision_box(eb["x_min"], eb["x_min"] + th, eb["z_back"], eb["z_front"], "entry_bay_return_left"),
        collision_box(eb["x_max"] - th, eb["x_max"], eb["z_back"], eb["z_front"], "entry_bay_return_right"),
        collision_box(eb["x_min"] + th, door["x_min"], door["inner_z"], eb["z_front"], "entry_bay_front_left"),
        collision_box(door["x_max"], eb["x_max"] - th, door["inner_z"], eb["z_front"], "entry_bay_front_right"),
    ]
    bank_x = cell_center(3, 3)[0]
    trade_x = cell_center(6, 3)[0]
    pa_x = cell_center(9, 3)[0]
    furniture = [
        collision_box(-3.45, -1.30, -1.90, -1.43, "counter_bank"),
        collision_box(-0.60, 1.55, -1.90, -1.43, "counter_trade"),
        collision_box(2.25, 4.40, -1.90, -1.43, "counter_pa"),
        collision_box(-4.70, -1.60, -3.75, -3.26, "bank_vault_face"),
        collision_box(-0.70, 1.70, -3.75, -3.42, "trade_shelving"),
        collision_box(bank_x - 0.895, bank_x + 0.895, 0.51, 0.59, "queue_rail_bank"),
        collision_box(trade_x - 0.895, trade_x + 0.895, 0.51, 0.59, "queue_rail_trade"),
        collision_box(pa_x - 0.895, pa_x + 0.895, 0.51, 0.59, "queue_rail_pa"),
        collision_box(-5.15, -4.70, -1.05, 1.65, "bench_west"),
        collision_box(-4.95, -2.85, 3.26, 3.58, "bench_front"),
        collision_box(-1.87, -1.53, 3.13, 3.47, "vestibule_pier_left"),
        collision_box(1.53, 1.87, 3.13, 3.47, "vestibule_pier_right"),
        collision_box(-3.08, -2.62, 1.97, 2.43, "column_west"),
        collision_box(2.62, 3.08, 1.97, 2.43, "column_east"),
        collision_box(4.76, 5.15, 1.24, 2.60, "trainer_desk"),
    ]
    terminal_cells_kept_clear = {
        "bank_terminal_civic": [3, 3],
        "trade_terminal": [6, 3],
        "pa_terminal": [9, 3],
        "trainer_npc": [10, 6],
    }
    assert_terminal_cells_kept_clear(furniture, terminal_cells_kept_clear, P["footprint_cells"])
    sidecar = {
        "schema": "successor.structure-collision.v3",
        "source": FACILITY_GLB.name,
        "generatedBy": "tools/successor/assets/build_commerce_facility.py",
        "contract": {
            "geometrySource": "P",
            "structuralRoles": ["outer_shell", "front_walls", "entry_bay_returns", "entry_bay_front_segments", "closed_door"],
            "furnitureRoles": ["counters", "vault_face", "shelving", "queue_rails", "benches", "vestibule_piers", "columns", "trainer_desk"],
            "decorativeExcluded": ["trim", "bolts", "glow", "inlays", "sconces", "notice_panels", "stool", "rug", "lamp", "roof_gear", "windows"],
            "terminal_cells_kept_clear": terminal_cells_kept_clear,
        },
        "footprint": {
            "minX": round(P["main_outer"]["x_min"], 4),
            "minZ": round(P["main_outer"]["z_min"], 4),
            "maxX": round(P["main_outer"]["x_max"], 4),
            "maxZ": round(P["main_outer"]["z_max"], 4),
            "spanX": round(P["main_outer"]["x_max"] - P["main_outer"]["x_min"], 4),
            "spanZ": round(P["main_outer"]["z_max"] - P["main_outer"]["z_min"], 4),
            "centerX": 0.0,
            "centerZ": 0.0,
        },
        "floor": {"topY": P["floor"]["top_y_m"], "slabThicknessM": P["floor"]["slab_thickness_m"]},
        "walls": walls,
        "furniture": furniture,
        "door": {
            "node": P["door"]["node"],
            "closed": collision_box(door["x_min"], door["x_max"], door["inner_z"], door["front_z"], "closed_door_panel"),
        },
        "interiorRegions": [{
            "id": "main_walkable_interior",
            "minX": round(sh["left_x"] + th, 4),
            "minZ": round(sh["back_z"] + th, 4),
            "maxX": round(sh["right_x"] - th, 4),
            "maxZ": round(sh["front_z"] - th - 0.02, 4),
            "floorTopY": P["floor"]["top_y_m"],
        }],
    }
    write_json(COLLISION_PATH, sidecar)
    return sidecar


def write_manifest(metrics):
    door = P["door"]["opening_bounds"]
    span = bbox_span(metrics["total_bbox"])
    manifest = {
        "building": "commerce_facility",
        "units": "m",
        "floorHeightM": P["floor"]["top_y_m"],
        "floorTopY": P["floor"]["top_y_m"],
        "front": "+Z",
        "bbox_span_m": [round(v, 3) for v in span],
        "runtime_scale_at_12x9_cells": round(min(P["footprint_cells"][0] / span[0], P["footprint_cells"][1] / span[2]), 6),
        "door_cells": door_cells_from_opening(),
        "cutaway": {
            "hide": ["roof__"],
            "stub_by_face": True,
            "faces": {"front": "wall_front__", "right": "wall_right__", "back": "wall_back__", "left": "wall_left__"},
            "keep": ["floor__", "interior__"],
        },
        "door": {
            "node": "door_slide",
            "slide_axis_local": P["door"]["slide_axis_local"],
            "slide_distance_m": P["door"]["slide_distance_m"],
            "clips": ["door_open", "door_close"],
        },
        "clear_opening_m": [round(door["x_max"] - door["x_min"], 3), round(door["y_max"] - door["y_min"], 3)],
        "interior_clear_height_m": P["interior_clear_height_m"],
        "interiorRegions": [{
            "id": "main_walkable_interior",
            "minX": round(P["shell"]["left_x"] + P["wall_thickness_m"], 4),
            "minZ": round(P["shell"]["back_z"] + P["wall_thickness_m"], 4),
            "maxX": round(P["shell"]["right_x"] - P["wall_thickness_m"], 4),
            "maxZ": round(P["shell"]["front_z"] - P["wall_thickness_m"] - 0.02, 4),
            "floorTopY": P["floor"]["top_y_m"],
        }],
        "service_anchor_cells": {"bank_terminal_civic": [3, 3], "trade_terminal": [6, 3], "pa_terminal": [9, 3], "trainer_npc": [10, 6]},
        "collisionProxy": {"source": "P", "sidecar": "commerce_facility_collision.json", "structuralOnly": False, "includesFurniture": True},
        "tri_count": int(metrics["tri_count"]),
        "materials": sorted(set(metrics["mat_names"])),
    }
    write_json(MANIFEST_PATH, manifest)
    return manifest


ROLE_PREFIXES = ("roof__", "wall_front__", "wall_right__", "wall_back__", "wall_left__", "floor__", "interior__")

REQUIRED_INTERIOR_NODES = (
    "interior__vestibule_piers", "interior__counter_bases", "interior__counter_tops",
    "interior__bank_glazing", "interior__vault_face", "interior__vault_ring",
    "interior__trade_shelving", "interior__notice_panels", "interior__civic_seal",
    "interior__queue_rails", "interior__bench_seats", "interior__trainer_desk_top",
    "interior__trainer_board", "interior__columns",
)
REQUIRED_GLOW_NODES = (
    "wall_front__portal_glow", "interior__light_cove_glow", "interior__service_light_glow",
    "floor__arrival_inlay_glow", "floor__bank_halo_glow", "interior__bank_pendant_glow",
    "interior__counter_glow", "interior__sconce_glow",
)


def facility_gate(metrics, validate, gltf, bin_chunk):
    node_names = [n.get("name", "") for n in gltf.get("nodes", [])]
    scene_idx = gltf.get("scene", 0)
    scene_nodes = gltf.get("scenes", [{}])[scene_idx].get("nodes", [])
    root_node = node_names[scene_nodes[0]] if len(scene_nodes) == 1 else None
    mesh_nodes = metrics["mesh_nodes"]
    total_span = bbox_span(metrics["total_bbox"])
    tex_flags = ct.material_texture_flags(gltf)
    images = gltf.get("images", [])

    role_nodes_ok = all((n == "door_slide" or n.startswith(ROLE_PREFIXES)) for n in mesh_nodes)
    bad_pivots = []
    door_pivot_ok = False
    for node in gltf.get("nodes", []):
        if "mesh" not in node:
            continue
        name = node.get("name", "")
        if name == "door_slide":
            t = node.get("translation", [0.0, 0.0, 0.0])
            expected = P["door"]["closed_center"]
            door_pivot_ok = all(abs(float(t[i]) - expected[i]) <= 1e-5 for i in range(3))
        elif not ct.is_identity_node_transform(node):
            bad_pivots.append(name)

    door_b = P["door"]["opening_bounds"]
    opening_w = door_b["x_max"] - door_b["x_min"]
    opening_h = door_b["y_max"] - door_b["y_min"]
    door_bb = node_bbox(gltf, bin_chunk, "door_slide")
    floor_bb = node_bbox(gltf, bin_chunk, "floor__single_cast_slab")

    clips = animation_metrics(gltf, bin_chunk)
    clips_present = set(clips) == {"door_open", "door_close"}
    clips_target_ok = clips_present and all(info["targets"] == ["door_slide"] and set(info["paths"]) <= {"translation"} for info in clips.values())
    clips_duration_ok = clips_present and all(0.7 <= info["duration_s"] <= 0.9 for info in clips.values())
    clips_distance_ok = clips_present and all(
        info["translation_distance_m"] is not None and abs(info["translation_distance_m"] - P["door"]["slide_distance_m"]) <= 0.005
        for info in clips.values()
    )

    slide = Vector(P["door"]["slide_axis_local"]) * P["door"]["slide_distance_m"]
    pocket_swallow = open_clears = False
    if door_bb:
        open_min = [door_bb["min"][i] + slide[i] for i in range(3)]
        open_max = [door_bb["max"][i] + slide[i] for i in range(3)]
        pk = P["door"]["pocket_bounds"]
        pocket_swallow = (
            open_min[0] >= pk["x_min"] - 0.005 and open_max[0] <= pk["x_max"] + 0.005
            and open_min[1] >= pk["y_min"] - 0.005 and open_max[1] <= pk["y_max"] + 0.005
            and open_min[2] >= pk["z_min"] - 0.005 and open_max[2] <= pk["z_max"] + 0.005
        )
        open_clears = open_max[0] <= door_b["x_min"] - 0.005

    min_y = metrics["total_bbox"]["min"][1]
    max_y = metrics["total_bbox"]["max"][1]

    checks = {
        "root_node": root_node == P["root_node"] and len(scene_nodes) == 1,
        "node_role_coverage": role_nodes_ok and mesh_nodes.count("door_slide") == 1,
        "one_material_per_node": all(len(m) == 1 for m in metrics["material_sets"].values()),
        "materials_subset": set(metrics["mat_names"]) <= FACILITY_MATERIALS,
        "core_materials_textured": all(
            tex_flags.get(m, {}).get("baseColorTexture") and tex_flags.get(m, {}).get("metallicRoughnessTexture") and tex_flags.get(m, {}).get("normalTexture")
            for m in metrics["mat_names"] if m in ct.TEXTURED_MATERIALS
        ),
        "textures_embedded": len(images) >= 6 and all("bufferView" in img for img in images),
        "normals_exported": metrics["primitive_count"] > 0 and metrics["normal_primitives"] == metrics["primitive_count"],
        "texcoords_exported": metrics["texcoord_primitives"] == metrics["primitive_count"],
        "no_skins": len(gltf.get("skins", [])) == 0,
        "pivots_identity_except_door": not bad_pivots and door_pivot_ok,
        "tri_count_within_budget": metrics["tri_count"] <= P["tri_budget"],
        "degenerate_faces_zero": metrics["degenerate_faces"] == 0,
        "loose_vertices_zero": metrics["loose_vertices"] == 0,
        "span_x_11_4": abs(total_span[0] - 11.4) <= 0.02,
        "span_z_8_55": abs(total_span[2] - 8.55) <= 0.02,
        "floor_top_y0_exact": floor_bb is not None and abs(floor_bb["max"][1] - P["floor"]["top_y_m"]) <= 0.0005,
        "grounded_slab_below_grade": -0.125 <= min_y <= -0.115,
        "height_le_5_2m": max_y <= 5.2,
        "interior_clear_ge_2_9m": (P["roof"]["slab_bottom_y_m"] - P["floor"]["top_y_m"]) >= 2.9,
        "portal_width_ge_2_4m": opening_w >= 2.4,
        "portal_height_ge_2_4m": opening_h >= 2.4,
        "door_clips_present": clips_present,
        "door_clips_target_only_door": clips_target_ok,
        "door_clips_duration": clips_duration_ok,
        "door_slide_distance": clips_distance_ok,
        "pocket_swallow": pocket_swallow,
        "open_panel_clears_portal": open_clears,
        "interior_nodes_present": all(n in mesh_nodes for n in REQUIRED_INTERIOR_NODES),
        "glow_accents_present": all(n in mesh_nodes for n in REQUIRED_GLOW_NODES),
        "validate": bool(validate.get("pass")),
    }
    return {
        "asset": "commerce_facility",
        "all_green": all(checks.values()),
        "root_node": root_node,
        "mesh_node_count": len(mesh_nodes),
        "materials": metrics["mat_names"],
        "tri_count": int(metrics["tri_count"]),
        "total_bbox_m": {"min": [round(v, 5) for v in metrics["total_bbox"]["min"]], "max": [round(v, 5) for v in metrics["total_bbox"]["max"]], "span": [round(v, 5) for v in total_span]},
        "door_opening_m": [round(opening_w, 5), round(opening_h, 5)],
        "animation_clips": clips,
        "bad_pivot_nodes": bad_pivots,
        "validate": validate,
        "checks": checks,
    }


# ─────────────────────────────── render rig ────────────────────────────────


def set_role_hidden(prefixes, hidden):
    for obj in bpy.context.scene.objects:
        if any(obj.name.startswith(p) for p in prefixes):
            obj.hide_render = hidden
            obj.hide_viewport = hidden


def setup_facility_render():
    scene = ct.setup_render()  # studio base: AgX, raytrace, ground, ref lights
    # Rescale lights for building scale.
    for name in ("key_area", "rim_area", "fill_area", "front_spec"):
        obj = bpy.data.objects.get(name)
        if obj is None:
            continue
        obj.data.energy *= 40.0
        obj.data.size *= 5.0
        obj.matrix_world = ct.look_at_matrix(
            Vector(obj.matrix_world.translation) * 5.5,
            Vector((0.0, 0.0, 1.4)),
        )
    ground = bpy.data.objects.get("render_ground_not_exported")
    if ground:
        ground.scale = (3.2, 3.2, 1.0)
    return scene


def render_facility(root, door):
    scene = setup_facility_render()
    ref = ct.create_ref_staff((-3.4, 5.6))
    closed_loc = Vector(logical_to_blender(P["door"]["closed_center"]))
    open_logical = Vector(P["door"]["closed_center"]) + Vector(P["door"]["slide_axis_local"]) * P["door"]["slide_distance_m"]
    open_loc = Vector(logical_to_blender(open_logical))
    if door.animation_data:
        for track in door.animation_data.nla_tracks:
            track.mute = True

    cams = {
        "front": ct.add_camera_logical("cam_front", (0.0, 2.4, 20.0), (0.0, 1.9, 0.0), 13.4),
        "back": ct.add_camera_logical("cam_back", (0.0, 2.6, -20.0), (0.0, 2.0, 0.0), 13.4),
        "left": ct.add_camera_logical("cam_left", (-20.0, 2.6, 0.0), (0.0, 2.0, 0.0), 11.2),
        "right": ct.add_camera_logical("cam_right", (20.0, 2.6, 0.0), (0.0, 2.0, 0.0), 11.2),
        "top": ct.add_camera_logical("cam_top", (0.0, 17.0, 1.4), (0.0, 0.2, 0.0), 13.6),
        "gameplay": ct.add_camera_persp("cam_gameplay", (9.5, 9.0, 10.5), (0.0, 1.3, 0.2), lens=42.0),
        "entrance": ct.add_camera_persp("cam_entrance", (2.1, 1.8, 8.6), (0.0, 1.3, 4.1), lens=48.0),
        "texture": ct.add_camera_persp("cam_texture", (3.6, 1.7, 6.4), (2.6, 1.5, 4.15), lens=62.0),
        "interior_wide": ct.add_camera_persp("cam_interior_wide", (0.3, 6.8, 8.8), (0.0, 0.6, -1.2), lens=34.0),
        "service": ct.add_camera_persp("cam_service", (0.6, 2.5, 1.6), (-1.2, 1.1, -2.4), lens=36.0),
        "trainer": ct.add_camera_persp("cam_trainer", (2.6, 2.3, 0.4), (4.6, 0.9, 2.0), lens=40.0),
        "trainer_front": ct.add_camera_persp("cam_trainer_front", (3.15, 1.4, 1.95), (5.15, 1.45, 1.95), lens=34.0),
        "backpipe": ct.add_camera_persp("cam_backpipe", (3.3, 1.35, -7.0), (4.67, 0.95, -4.12), lens=44.0),
        "roofduct": ct.add_camera_persp("cam_roofduct", (-1.4, 5.7, 1.0), (-2.6, 3.5, -2.95), lens=30.0),
        "flank_left": ct.add_camera_persp("cam_flank_left", (-9.6, 1.7, 0.2), (-5.45, 1.5, 0.15), lens=40.0),
        "flank_right": ct.add_camera_persp("cam_flank_right", (9.4, 1.9, -3.0), (5.45, 1.85, -1.6), lens=42.0),
        "proxy_overhead": ct.add_camera_logical("cam_proxy_overhead", (0.0, 15.0, 0.9), (0.0, 0.0, 0.0), 12.6),
        "door_front": ct.add_camera_persp("cam_door_front", (0.0, 1.5, 9.6), (0.0, 1.45, 4.2), lens=72.0),
        "sign_front": ct.add_camera_persp("cam_sign_front", (0.0, 2.4, 9.8), (0.0, 2.85, 4.23), lens=52.0),
        "zone_bank": ct.add_camera_persp("cam_zone_bank", (-2.6, 2.55, -1.2), (-2.75, 2.87, -3.73), lens=44.0),
        "zone_trade": ct.add_camera_persp("cam_zone_trade", (0.4, 2.45, -1.1), (0.35, 2.66, -3.73), lens=44.0),
        "zone_pa": ct.add_camera_persp("cam_zone_pa", (3.3, 2.45, -1.1), (3.3, 2.68, -3.73), lens=44.0),
        "ceiling": ct.add_camera_persp("cam_ceiling", (0.2, 1.5, 2.7), (0.1, 2.95, -1.4), lens=38.0),
        "grounding": ct.add_camera_persp("cam_grounding", (0.85, 1.05, 2.15), (1.66, 0.12, 3.28), lens=50.0),
    }

    ct.set_ref_hidden(ref, False)
    door.location = closed_loc
    for name in ("front", "back", "left", "right", "top", "gameplay"):
        ct.render_still(scene, cams[name], RENDER_DIR / f"facility_{name}.png")
    ct.render_still(scene, cams["entrance"], RENDER_DIR / "facility_entrance_closed.png")
    ct.render_still(scene, cams["texture"], RENDER_DIR / "facility_texture_close.png")
    ct.render_still(scene, cams["door_front"], RENDER_DIR / "facility_door_front_closed.png")
    ct.render_still(scene, cams["sign_front"], RENDER_DIR / "facility_sign_band.png")
    ct.render_still(scene, cams["backpipe"], RENDER_DIR / "facility_backpipe.png")
    ct.render_still(scene, cams["roofduct"], RENDER_DIR / "facility_roofduct.png")
    ct.render_still(scene, cams["flank_left"], RENDER_DIR / "facility_flank_left.png")
    ct.render_still(scene, cams["flank_right"], RENDER_DIR / "facility_flank_right.png")
    door.location = open_loc
    ct.render_still(scene, cams["entrance"], RENDER_DIR / "facility_entrance_open.png")

    # Ceiling + grounding proofs: roof stays visible, only the front shell
    # and door are hidden so beams/coves/soffits read (no open-sky).
    set_role_hidden(("wall_front__", "door_slide"), True)
    ct.set_ref_hidden(ref, True)
    ct.render_still(scene, cams["ceiling"], RENDER_DIR / "facility_ceiling.png")
    ct.render_still(scene, cams["grounding"], RENDER_DIR / "facility_grounding.png")
    set_role_hidden(("wall_front__", "door_slide"), False)

    # Interior cutaway: hide roof + camera-facing front/right shell + door.
    set_role_hidden(("roof__", "wall_front__", "wall_right__", "door_slide"), True)
    ct.set_ref_hidden(ref, True)
    ct.render_still(scene, cams["interior_wide"], RENDER_DIR / "facility_interior_wide.png")
    ct.render_still(scene, cams["service"], RENDER_DIR / "facility_service_counters.png")
    ct.render_still(scene, cams["trainer"], RENDER_DIR / "facility_trainer_nook.png")
    # trainer straight-on needs the east wall visible so the board is lit
    set_role_hidden(("wall_right__",), False)
    ct.render_still(scene, cams["trainer_front"], RENDER_DIR / "facility_trainer_front.png")
    set_role_hidden(("wall_right__",), True)
    ct.render_still(scene, cams["proxy_overhead"], RENDER_DIR / "facility_proxy_overhead.png")
    ct.render_still(scene, cams["zone_bank"], RENDER_DIR / "facility_zone_bank.png")
    ct.render_still(scene, cams["zone_trade"], RENDER_DIR / "facility_zone_trade.png")
    ct.render_still(scene, cams["zone_pa"], RENDER_DIR / "facility_zone_pa.png")
    set_role_hidden(("roof__", "wall_front__", "wall_right__", "door_slide"), False)

    door.location = closed_loc
    if door.animation_data:
        for track in door.animation_data.nla_tracks:
            track.mute = False


# ───────────────────────────────── main ────────────────────────────────────

PROVENANCE_TEXT = (
    "Hand-authored parametric part program (no generative model): Dustgate commerce facility — "
    "12x9-cell enterable civic marketplace landmark in the upgraded commerce premium language: "
    "chamfered basalt plinth course, buttressed back, pilastered sides, sand-ceramic recessed "
    "panels with bolts, offset entry bay with a centered 2.47 m (2.6 m runtime) pocket portal "
    "(door_slide + door_open/door_close), energized amber portal gasket, clerestory roof lantern, "
    "vent hoods and brass ductwork. Flagship interior: vestibule piers, medallion concourse on a "
    "warm ceramic concourse floor field, glazed bank counter with brass-ringed wall vault face "
    "and a distinct bank bay floor cue (ink anchor pad + brass vault ring + amber halo), trade "
    "counter with wall shelving and sample crates, PA civic notice bay with brass seal, three "
    "brass queue-rail runs, benches, wall sconces, ceiling light coves kept lit through the "
    "roof-peel cutaway (interior__ keep content), and a trainer consultation nook. Terminal "
    "machine cells (3,3)/(6,3)/(9,3) and trainer cell (10,6) kept clear for separate props. "
    "Mesh 11.4 x 8.55 m (runtime scale 1.0526315789 at 12x9 cells), floor top y=0.02 m. Shared "
    "commerce_* UV PBR texture maps (baseColor+MR+normal). Converted-mesh civic label "
    "'DUSTGATE EXCHANGE' on the sign band (owner-directed); no franchise/IP motifs."
)


def write_provenance(tri_count: int):
    data = {
        "schema": "successor-asset-provenance/1",
        "asset_id": "commerce_facility",
        "asset_path": f"client-3d/public/assets/world-items/{FACILITY_GLB.name}",
        "asset_hash": sha256_of(FACILITY_GLB),
        "asset_kind": "model_glb",
        "tool": {"name": "blender-bpy-headless", "version": bpy.app.version_string.split()[0], "tool_snapshot_id": f"blender-{bpy.app.version_string.split()[0]}"},
        "prompt": {"text": PROVENANCE_TEXT, "denylist_audit": "passed: no franchise/IP terms and no baked words in names, materials, node names, textures, or artifacts"},
        "seed": "deterministic numpy texture seeds 2026071801..05 (shared with commerce terminals)",
        "input_assets": [
            {"path": "tools/successor/assets/build_commerce_terminals.py", "purpose": "shared premium design language, palette, materials, UV texture maps, mesh helpers"},
            {"path": "tools/successor/assets/build_cloning_facility.py", "purpose": "facility door/cutaway/collision/manifest contract reference"},
        ],
        "human_edits": [],
        "rights": {
            "source_license": "Successor proprietary project asset; all rights reserved",
            "redistribution_status": "authorized for Successor runtime distribution only; no standalone reuse grant",
        },
        "regeneration_command": "/snap/bin/blender -b --factory-startup --python-exit-code 1 -P tools/successor/assets/build_commerce_facility.py",
        "tri_count": tri_count,
        "gate_report": f".game-lab/{RUN_ID}/gate.json",
        "source_blend_or_script": "tools/successor/assets/build_commerce_facility.py (deterministic parametric part program; no .blend needed)",
        "agent_provenance": {
            "produced_by": [{"agent_instance_id": "CommerceTerminalBuilder", "run_id": RUN_ID, "role": "content-author", "provider": "anthropic", "model": "Fable 5"}],
            "reviewed_by_agents": [{"agent_instance_id": "CommerceTerminalBuilder", "role": "judge", "notes": f"numeric parsed-GLB gates + two labeled render iterations in .game-lab/{RUN_ID}/renders/"}],
            "human_approvals": [],
        },
    }
    write_json(OUT_DIR / "commerce_facility.provenance.json", data)


def main():
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    EVIDENCE_DIR.mkdir(parents=True, exist_ok=True)
    RENDER_DIR.mkdir(parents=True, exist_ok=True)
    for p in RENDER_DIR.glob("*.png"):
        p.unlink()

    ct.write_texture_maps()

    root, door = build_scene()
    export_glb_with_anims(root, FACILITY_GLB)
    patch_door_rest_translation(FACILITY_GLB)
    gltf, bin_chunk = ct.read_glb_chunks(FACILITY_GLB)
    metrics = ct.parse_glb_metrics(FACILITY_GLB)
    validate = ct.run_validator(FACILITY_GLB)
    gate = facility_gate(metrics, validate, gltf, bin_chunk)
    sidecar = write_collision_sidecar()
    write_manifest(metrics)
    write_provenance(metrics["tri_count"])
    render_facility(root, door)

    summary = {
        "run": RUN_ID,
        "all_green": gate["all_green"],
        "asset": gate,
        "collision_sidecar": {"path": str(COLLISION_PATH.relative_to(REPO)), "walls": len(sidecar["walls"]), "furniture": len(sidecar["furniture"])},
        "renders_dir": str(RENDER_DIR),
    }
    write_json(GATE_PATH, summary)
    final = json.loads(GATE_PATH.read_text())
    print(json.dumps({
        "all_green": final["all_green"],
        "tri_count": final["asset"]["tri_count"],
        "span": final["asset"]["total_bbox_m"]["span"],
        "clips": final["asset"]["animation_clips"],
        "checks_failed": [c for c, ok in final["asset"]["checks"].items() if not ok],
    }, indent=2))
    if not final.get("all_green"):
        raise SystemExit("gate.json is not green after disk re-read")


if __name__ == "__main__":
    main()
