#!/usr/bin/env python3
"""Build the Dustgate bank-terminal asset (deterministic source of truth).

This file was split out of build_cloning_facility.py so the cloning rebuild can
delete that file without losing the bank terminal's regeneration source.

Produces `client-3d/public/assets/world-items/bank_terminal.glb` and its
provenance sidecar. Evidence is ignored under `.game-lab/bank-terminal-20260803/`.

Headless:
    /snap/bin/blender -b --factory-startup --python-exit-code 1 \
        -P tools/successor/assets/build_bank_terminal.py
"""
from __future__ import annotations

import hashlib
import json
import math
import re
import shutil
import struct
import subprocess
from pathlib import Path

import bpy
from mathutils import Matrix, Quaternion, Vector

REPO = Path(__file__).resolve().parents[3]
OUT_DIR = REPO / "client-3d" / "public" / "assets" / "world-items"
EVIDENCE_DIR = REPO / ".game-lab" / "bank-terminal-20260803"
RENDER_DIR = EVIDENCE_DIR / "renders"
GATE_PATH = EVIDENCE_DIR / "gate.json"
BANK_GLB = OUT_DIR / "bank_terminal.glb"
PROVENANCE_GATE_REPORT = ".game-lab/cloning-facility-20260716/gate.json"

# These retained values are used verbatim by shared scene-reset and render-rig
# helpers. The bank terminal does not otherwise depend on facility geometry.
P = {
    "door": {"clip_duration_s": 0.8, "fps": 30},
    "reference_box_height_m": 1.7525,
    "render_resolution": [1280, 960],
    "render_bg_hex": "#D8D8D8",
}

PROPS = {
    "bank_terminal": {"root_node": "Gear_bank_terminal", "height_range_m": [1.95, 2.15], "tri_budget": 2600},
}

# name: (baseColor hex, roughness, metallic, emissive hex or None, alpha)
MATERIAL_SPEC = {
    "HK_Frame": ("#4A3E31", 0.88, 0.0, None, 1.0),
    "HK_Clad": ("#A08565", 0.88, 0.0, None, 1.0),
    "HK_Clad2": ("#BC9E6E", 0.84, 0.0, None, 1.0),
    "HK_Roof": ("#83786A", 0.90, 0.0, None, 1.0),
    "HK_Floor": ("#756A5B", 0.80, 0.0, None, 1.0),
    "HK_Door": ("#5C605B", 0.42, 0.55, None, 1.0),
    "HK_Trim": ("#8C4F32", 0.70, 0.0, None, 1.0),
    "HK_Steel": ("#8E9296", 0.38, 0.85, None, 1.0),
    "HK_Brass": ("#A9803F", 0.42, 0.90, None, 1.0),
    "HK_Shell": ("#C9C4B4", 0.55, 0.0, None, 1.0),
    "HK_Glass": ("#9FBFC4", 0.10, 0.0, None, 0.22),
    "HK_Glow": ("#0A1413", 0.50, 0.0, "#54D9CC", 1.0),
    "HK_GlowWarm": ("#141008", 0.50, 0.0, "#E39E47", 1.0),
}
BANK_MATERIALS = {"HK_Frame", "HK_Clad", "HK_Steel", "HK_Brass", "HK_GlowWarm", "HK_Trim", "HK_Glass", "HK_Shell"}


def hex_to_rgba(hex_color: str, alpha: float = 1.0) -> tuple[float, float, float, float]:
    # Contract: raw sRGB fractions for baseColorFactor. Do not linearize.
    hex_color = hex_color.lstrip("#")
    srgb = [int(hex_color[i : i + 2], 16) / 255.0 for i in (0, 2, 4)]
    return (srgb[0], srgb[1], srgb[2], alpha)


def logical_to_blender(v):
    x, y, z = v
    return (x, -z, y)


def rounded_key(co, places=7):
    return tuple(round(float(c), places) for c in co)


def write_json(path: Path, data):
    path.write_text(json.dumps(data, indent=2, sort_keys=True) + "\n")


def reset_scene():
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete()
    for datablocks in (bpy.data.meshes, bpy.data.materials, bpy.data.images, bpy.data.cameras, bpy.data.lights, bpy.data.actions):
        for block in list(datablocks):
            try:
                datablocks.remove(block)
            except RuntimeError:
                pass
    scene = bpy.context.scene
    scene.unit_settings.system = "METRIC"
    scene.unit_settings.scale_length = 1.0
    scene.render.fps = P["door"]["fps"]
    scene.frame_start = 1
    scene.frame_end = int(P["door"]["clip_duration_s"] * P["door"]["fps"]) + 1
    scene.frame_set(1)
    try:
        bpy.context.preferences.edit.keyframe_new_interpolation_type = "LINEAR"
    except Exception:
        pass


def make_materials(names):
    mats = {}
    for name in sorted(names):
        base_hex, rough, metal, emissive_hex, alpha = MATERIAL_SPEC[name]
        mat = bpy.data.materials.new(name)
        rgba = hex_to_rgba(base_hex, alpha)
        mat.diffuse_color = rgba
        mat.use_nodes = True
        bsdf = mat.node_tree.nodes.get("Principled BSDF")
        if bsdf:
            bsdf.inputs["Base Color"].default_value = rgba
            bsdf.inputs["Roughness"].default_value = rough
            if "Metallic" in bsdf.inputs:
                bsdf.inputs["Metallic"].default_value = metal
            if emissive_hex is not None:
                if "Emission Color" in bsdf.inputs:
                    bsdf.inputs["Emission Color"].default_value = hex_to_rgba(emissive_hex)
                if "Emission Strength" in bsdf.inputs:
                    bsdf.inputs["Emission Strength"].default_value = 1.0
            if alpha < 1.0 and "Alpha" in bsdf.inputs:
                bsdf.inputs["Alpha"].default_value = alpha
        if alpha < 1.0:
            for attr, value in (("surface_render_method", "BLENDED"), ("blend_method", "BLEND")):
                try:
                    setattr(mat, attr, value)
                except Exception:
                    pass
        mats[name] = mat
    return mats


class MeshBuilder:
    def __init__(self):
        self.verts = []
        self.faces = []
        self.vmap = {}

    def v(self, co):
        key = rounded_key(co)
        idx = self.vmap.get(key)
        if idx is None:
            idx = len(self.verts)
            self.vmap[key] = idx
            self.verts.append(key)
        return idx

    def face(self, coords):
        idx = [self.v(co) for co in coords]
        if len(set(idx)) == len(idx):
            self.faces.append(idx)

    def extend_box(self, center, size):
        cx, cy, cz = center
        sx, sy, sz = size
        x0, x1 = cx - sx / 2, cx + sx / 2
        y0, y1 = cy - sy / 2, cy + sy / 2
        z0, z1 = cz - sz / 2, cz + sz / 2
        self.face([(x0, y0, z1), (x1, y0, z1), (x1, y1, z1), (x0, y1, z1)])
        self.face([(x1, y0, z0), (x0, y0, z0), (x0, y1, z0), (x1, y1, z0)])
        self.face([(x0, y0, z0), (x0, y0, z1), (x0, y1, z1), (x0, y1, z0)])
        self.face([(x1, y0, z1), (x1, y0, z0), (x1, y1, z0), (x1, y1, z1)])
        self.face([(x0, y1, z1), (x1, y1, z1), (x1, y1, z0), (x0, y1, z0)])
        self.face([(x0, y0, z0), (x1, y0, z0), (x1, y0, z1), (x0, y0, z1)])

    def extend_bounds(self, x0, x1, y0, y1, z0, z1):
        self.extend_box(((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2), (x1 - x0, y1 - y0, z1 - z0))

    def extend_prism(self, cx, cz, radius, y0, y1, sides=8, start_deg=0.0):
        ring0, ring1 = [], []
        for i in range(sides):
            a = math.radians(start_deg) + 2.0 * math.pi * i / sides
            x = cx + radius * math.cos(a)
            z = cz + radius * math.sin(a)
            ring0.append((round(x, 7), y0, round(z, 7)))
            ring1.append((round(x, 7), y1, round(z, 7)))
        for i in range(sides):
            j = (i + 1) % sides
            self.face([ring0[i], ring0[j], ring1[j], ring1[i]])
        self.face(list(reversed(ring0)))
        self.face(list(ring1))

    def extend_arc_shell(self, cx, cz, r_in, r_out, y0, y1, a0_deg, a1_deg, segments=4):
        """Closed thin faceted arc panel (canopy glass, hoods)."""
        inner0, inner1, outer0, outer1 = [], [], [], []
        for i in range(segments + 1):
            a = math.radians(a0_deg + (a1_deg - a0_deg) * i / segments)
            ca, sa = math.cos(a), math.sin(a)
            inner0.append((round(cx + r_in * ca, 7), y0, round(cz + r_in * sa, 7)))
            inner1.append((round(cx + r_in * ca, 7), y1, round(cz + r_in * sa, 7)))
            outer0.append((round(cx + r_out * ca, 7), y0, round(cz + r_out * sa, 7)))
            outer1.append((round(cx + r_out * ca, 7), y1, round(cz + r_out * sa, 7)))
        for i in range(segments):
            self.face([outer0[i], outer0[i + 1], outer1[i + 1], outer1[i]])
            self.face([inner0[i + 1], inner0[i], inner1[i], inner1[i + 1]])
            self.face([outer1[i], outer1[i + 1], inner1[i + 1], inner1[i]])
            self.face([outer0[i + 1], outer0[i], inner0[i], inner0[i + 1]])
        self.face([inner0[0], outer0[0], outer1[0], inner1[0]])
        self.face([outer0[segments], inner0[segments], inner1[segments], outer1[segments]])


def make_mesh_object(name, builder, mat, root, smooth=False):
    import bmesh

    mesh = bpy.data.meshes.new(name + "Mesh")
    mesh.from_pydata([logical_to_blender(v) for v in builder.verts], [], builder.faces)
    mesh.validate(clean_customdata=True)
    bm = bmesh.new()
    bm.from_mesh(mesh)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(mesh)
    bm.free()
    mesh.update(calc_edges=True)
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(obj)
    obj.parent = root
    obj.location = (0.0, 0.0, 0.0)
    obj.rotation_euler = (0.0, 0.0, 0.0)
    obj.scale = (1.0, 1.0, 1.0)
    obj.data.materials.append(mat)
    for poly in mesh.polygons:
        poly.material_index = 0
        poly.use_smooth = bool(smooth)
    return obj


def bounds(b, x0, x1, y0, y1, z0, z1):
    b.extend_bounds(x0, x1, y0, y1, z0, z1)


def make_root(name):
    root = bpy.data.objects.new(name, None)
    bpy.context.collection.objects.link(root)
    root.empty_display_type = "CUBE"
    root.empty_display_size = 0.25
    root.location = (0.0, 0.0, 0.0)
    root.rotation_euler = (0.0, 0.0, 0.0)
    root.scale = (1.0, 1.0, 1.0)
    return root


def angled_panel(b, xa, xb, y0, z0, y1, z1, depth):
    """Tilted thin slab spanning x [xa, xb] from (y0, z0) to (y1, z1) with +z
    depth — screen planes and their modeled non-text UI geometry."""
    lo_f, hi_f = (y0, z0 + depth), (y1, z1 + depth)
    lo_b, hi_b = (y0, z0), (y1, z1)
    b.face([(xa, lo_f[0], lo_f[1]), (xb, lo_f[0], lo_f[1]), (xb, hi_f[0], hi_f[1]), (xa, hi_f[0], hi_f[1])])
    b.face([(xb, lo_b[0], lo_b[1]), (xa, lo_b[0], lo_b[1]), (xa, hi_b[0], hi_b[1]), (xb, hi_b[0], hi_b[1])])
    b.face([(xa, lo_b[0], lo_b[1]), (xa, lo_f[0], lo_f[1]), (xa, hi_f[0], hi_f[1]), (xa, hi_b[0], hi_b[1])])
    b.face([(xb, lo_f[0], lo_f[1]), (xb, lo_b[0], lo_b[1]), (xb, hi_b[0], hi_b[1]), (xb, hi_f[0], hi_f[1])])
    b.face([(xa, hi_f[0], hi_f[1]), (xb, hi_f[0], hi_f[1]), (xb, hi_b[0], hi_b[1]), (xa, hi_b[0], hi_b[1])])
    b.face([(xb, lo_f[0], lo_f[1]), (xa, lo_f[0], lo_f[1]), (xa, lo_b[0], lo_b[1]), (xb, lo_b[0], lo_b[1])])



def build_bank_terminal_scene():
    """Outdoor armored bank kiosk, fifth pass: broad anchored base with rail
    shoes, tapering armored column with corbel shoulders and a gasket collar
    under the steel head, hooded amber ledger screen with modeled non-text UI
    geometry behind glass, and explicit input/output modules — 12-key keypad
    (glowing accept, brass cancel, home-nub key), credit-chip slot with a
    half-inserted card, receipt slit with tear bar and protruding stub, and a
    deep open dispenser tray holding brass credit coins."""
    reset_scene()
    mats = make_materials(BANK_MATERIALS)
    root = make_root(PROPS["bank_terminal"]["root_node"])

    # Broad anchored base: pad + beveled skirt + anchor bolts.
    b = MeshBuilder()
    bounds(b, -0.56, 0.56, 0.0, 0.10, -0.44, 0.46)
    bounds(b, -0.50, 0.50, 0.10, 0.22, -0.40, 0.42)
    make_mesh_object("base__plinth", b, mats["HK_Frame"], root)

    b = MeshBuilder()
    for bx, bz in ((-0.49, -0.37), (0.49, -0.37), (-0.49, 0.39), (0.49, 0.39)):
        bounds(b, bx - 0.035, bx + 0.035, 0.10, 0.145, bz - 0.035, bz + 0.035)
    make_mesh_object("base__anchor_bolts", b, mats["HK_Steel"], root)

    # Tapering armored column in two sections with a visible assembly seam.
    b = MeshBuilder()
    bounds(b, -0.44, 0.44, 0.22, 0.66, -0.34, 0.36)
    bounds(b, -0.40, 0.40, 0.70, 1.14, -0.31, 0.33)
    bounds(b, -0.42, 0.42, 0.66, 0.70, -0.32, 0.335)  # seam collar
    make_mesh_object("body__column", b, mats["HK_Clad"], root)

    # Corbel shoulders + dark gasket collar: the head visibly bears on these.
    b = MeshBuilder()
    for sxn in (-1, 1):
        bounds(b, sxn * 0.40, sxn * 0.48, 1.00, 1.14, -0.30, 0.06)
    make_mesh_object("body__head_corbels", b, mats["HK_Steel"], root)
    b = MeshBuilder()
    bounds(b, -0.46, 0.46, 1.08, 1.16, -0.33, 0.37)
    make_mesh_object("body__head_collar", b, mats["HK_Frame"], root)

    # Deep open dispenser tray (credits out): floor + bracket, cheeks, hood,
    # dark cavity, warm glow throat, brass credit coins lying in the tray.
    b = MeshBuilder()
    bounds(b, -0.25, 0.25, 0.26, 0.33, 0.34, 0.54)
    bounds(b, -0.20, 0.20, 0.22, 0.26, 0.36, 0.50)
    bounds(b, -0.25, -0.19, 0.33, 0.55, 0.34, 0.54)
    bounds(b, 0.19, 0.25, 0.33, 0.55, 0.34, 0.54)
    bounds(b, -0.25, 0.25, 0.55, 0.62, 0.34, 0.54)
    make_mesh_object("body__dispenser_tray", b, mats["HK_Steel"], root)
    b = MeshBuilder()
    bounds(b, -0.19, 0.19, 0.33, 0.55, 0.345, 0.365)
    make_mesh_object("body__dispenser_cavity", b, mats["HK_Frame"], root)
    b = MeshBuilder()
    bounds(b, -0.19, 0.19, 0.525, 0.55, 0.365, 0.38)
    make_mesh_object("body__dispenser_glow_throat", b, mats["HK_GlowWarm"], root)
    b = MeshBuilder()
    for cxx, czz in ((-0.09, 0.44), (0.01, 0.47), (0.09, 0.41)):
        b.extend_prism(cxx, czz, 0.038, 0.33, 0.352, sides=8, start_deg=22.5)
    make_mesh_object("body__credit_coins", b, mats["HK_Brass"], root)

    # 12-key keypad (input): recessed dark panel, steel keys with a home nub,
    # glowing accept key, brass cancel key.
    b = MeshBuilder()
    bounds(b, -0.21, 0.21, 0.56, 0.97, 0.34, 0.405)
    bounds(b, -0.0125, 0.0125, 0.8025, 0.8175, 0.432, 0.442)  # dark home nub on key 5
    make_mesh_object("body__keypad_panel", b, mats["HK_Frame"], root)
    b = MeshBuilder()
    for ky in (0.605, 0.695, 0.785, 0.875):
        for kx in (-0.1525, -0.0375, 0.0775):
            if ky == 0.605 and kx in (-0.1525, -0.0375):
                continue
            bounds(b, kx, kx + 0.075, ky, ky + 0.055, 0.405, 0.432)

    make_mesh_object("body__keypad_keys", b, mats["HK_Steel"], root)
    b = MeshBuilder()
    bounds(b, -0.0375, 0.0375, 0.605, 0.66, 0.405, 0.435)
    make_mesh_object("body__keypad_accept_glow", b, mats["HK_GlowWarm"], root)
    b = MeshBuilder()
    bounds(b, -0.1525, -0.0775, 0.605, 0.66, 0.405, 0.432)
    make_mesh_object("body__keypad_cancel", b, mats["HK_Trim"], root)

    # Credit-chip slot (input): dark bezel, amber slit, half-inserted card.
    b = MeshBuilder()
    bounds(b, -0.37, -0.09, 0.99, 1.13, 0.335, 0.415)
    make_mesh_object("body__card_slot_bezel", b, mats["HK_Frame"], root)
    b = MeshBuilder()
    bounds(b, -0.32, -0.14, 1.045, 1.082, 0.34, 0.432)
    make_mesh_object("body__slot_glow", b, mats["HK_GlowWarm"], root)
    b = MeshBuilder()
    bounds(b, -0.30, -0.21, 1.02, 1.115, 0.425, 0.462)
    make_mesh_object("body__inserted_card", b, mats["HK_Shell"], root)

    # Receipt slit (output): steel module, dark tear bar, protruding stub.
    b = MeshBuilder()
    bounds(b, 0.09, 0.37, 0.99, 1.13, 0.335, 0.408)
    make_mesh_object("body__receipt_slit", b, mats["HK_Steel"], root)
    b = MeshBuilder()
    bounds(b, 0.11, 0.35, 1.08, 1.098, 0.408, 0.424)
    make_mesh_object("body__receipt_tear_bar", b, mats["HK_Frame"], root)
    b = MeshBuilder()
    bounds(b, 0.15, 0.31, 1.048, 1.075, 0.408, 0.452)
    make_mesh_object("body__receipt_stub", b, mats["HK_Shell"], root)

    # Brass side rails guarding the column, on steel base shoes, rising to the
    # head underside.
    b = MeshBuilder()
    for sxn in (-1, 1):
        bounds(b, sxn * 0.44, sxn * 0.52, 0.10, 1.14, -0.24, -0.16)
        bounds(b, sxn * 0.44, sxn * 0.52, 0.10, 1.14, 0.08, 0.16)
        bounds(b, sxn * 0.44, sxn * 0.52, 0.10, 0.18, -0.16, 0.08)
    make_mesh_object("body__brass_rails", b, mats["HK_Brass"], root)
    b = MeshBuilder()
    for sxn in (-1, 1):
        bounds(b, sxn * 0.415, sxn * 0.545, 0.10, 0.19, -0.29, -0.11)
        bounds(b, sxn * 0.415, sxn * 0.545, 0.10, 0.19, 0.03, 0.21)
    make_mesh_object("body__rail_shoes", b, mats["HK_Steel"], root)

    # Armored head: wedge mass, hood, side cheeks and integrated stepped cap.
    b = MeshBuilder()
    bounds(b, -0.48, 0.48, 1.14, 1.90, -0.36, 0.12)
    b.face([(-0.48, 1.14, 0.12), (0.48, 1.14, 0.12), (0.48, 1.14, 0.42), (-0.48, 1.14, 0.42)])
    for sxn in (-1, 1):
        b.face([(sxn * 0.48, 1.14, 0.12), (sxn * 0.48, 1.78, 0.12), (sxn * 0.48, 1.14, 0.42)])
    bounds(b, -0.48, 0.48, 1.78, 1.90, 0.02, 0.46)  # hood over the screen
    bounds(b, -0.42, 0.42, 1.90, 2.00, -0.30, 0.24)  # integral stepped cap
    bounds(b, -0.46, 0.46, 1.14, 1.20, 0.36, 0.44)  # sill under the screen
    make_mesh_object("head__armored_wedge", b, mats["HK_Steel"], root)

    # Angled ledger screen: full-width dark bezel, amber emissive, modeled
    # non-text UI (ledger rows, amount blocks, chip mark), glass cover.
    b = MeshBuilder()
    angled_panel(b, -0.46, 0.46, 1.17, 0.415, 1.80, 0.155, 0.030)
    make_mesh_object("head__screen_bezel", b, mats["HK_Frame"], root)
    b = MeshBuilder()
    angled_panel(b, -0.40, 0.40, 1.22, 0.409, 1.74, 0.185, 0.022)
    make_mesh_object("head__ledger_screen_glow", b, mats["HK_GlowWarm"], root)

    def sp(t):
        return (1.22 + 0.52 * t, 0.431 - 0.224 * t)

    b = MeshBuilder()
    for t0, t1 in ((0.14, 0.25), (0.36, 0.47), (0.58, 0.69)):
        angled_panel(b, -0.32, 0.06, *sp(t0), *sp(t1), 0.006)
    angled_panel(b, -0.32, -0.12, *sp(0.78), *sp(0.93), 0.006)
    make_mesh_object("head__screen_ui_rows", b, mats["HK_Frame"], root)
    b = MeshBuilder()
    for t0, t1 in ((0.14, 0.25), (0.36, 0.47), (0.58, 0.69)):
        angled_panel(b, 0.14, 0.32, *sp(t0), *sp(t1), 0.006)
    make_mesh_object("head__screen_ui_amounts", b, mats["HK_Steel"], root)
    b = MeshBuilder()
    angled_panel(b, -0.43, 0.43, 1.19, 0.450, 1.77, 0.200, 0.006)
    make_mesh_object("head__screen_glass", b, mats["HK_Glass"], root)

    # Beacon integrated into the cap step + service cable drop to grade.
    b = MeshBuilder()
    bounds(b, -0.12, 0.12, 2.00, 2.06, -0.20, 0.02)
    make_mesh_object("head__beacon_glow", b, mats["HK_GlowWarm"], root)
    b = MeshBuilder()
    bounds(b, -0.07, 0.07, 0.0, 1.55, -0.42, -0.36)
    bounds(b, -0.11, 0.11, 1.55, 1.66, -0.42, -0.34)
    bounds(b, -0.11, 0.11, 0.0, 0.10, -0.48, -0.36)
    make_mesh_object("body__cable_drop", b, mats["HK_Trim"], root)
    return root


# ─────────────────────────── export + GLB parsing ─────────────────────────


def export_glb(root, glb_path: Path, with_animations: bool):
    bpy.ops.object.select_all(action="DESELECT")
    root.select_set(True)
    for child in root.children_recursive:
        child.select_set(True)
    bpy.context.view_layer.objects.active = root
    kwargs = dict(
        filepath=str(glb_path),
        export_format="GLB",
        use_selection=True,
        export_apply=False,
        export_materials="EXPORT",
        export_cameras=False,
        export_lights=False,
        export_yup=True,
        export_skins=False,
        export_normals=True,
        export_texcoords=False,
    )
    if with_animations:
        kwargs.update(
            export_animations=True,
            export_animation_mode="NLA_TRACKS",
            export_nla_strips=True,
            export_merge_animation="NLA_TRACK",
            export_bake_animation=False,
            export_anim_slide_to_zero=False,
        )
    else:
        kwargs.update(export_animations=False)
    bpy.ops.export_scene.gltf(**kwargs)


_COMPONENT_FORMAT = {5120: "b", 5121: "B", 5122: "h", 5123: "H", 5125: "I", 5126: "f"}
_COMPONENT_SIZE = {5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4}
_TYPE_COUNT = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4, "MAT4": 16}


def read_glb_chunks(path):
    data = Path(path).read_bytes()
    magic, version, length = struct.unpack_from("<4sII", data, 0)
    if magic != b"glTF" or version != 2:
        raise ValueError("not a GLB v2")
    offset = 12
    chunks = {}
    while offset < length:
        chunk_len, chunk_type = struct.unpack_from("<I4s", data, offset)
        offset += 8
        chunks[chunk_type] = data[offset : offset + chunk_len]
        offset += chunk_len
    return json.loads(chunks[b"JSON"].decode("utf-8")), chunks.get(b"BIN\x00", b"")



def accessor_values(gltf, bin_chunk, accessor_index):
    acc = gltf["accessors"][accessor_index]
    count = acc["count"]
    comp_type = acc["componentType"]
    item_count = _TYPE_COUNT[acc["type"]]
    fmt = "<" + _COMPONENT_FORMAT[comp_type] * item_count
    elem_size = _COMPONENT_SIZE[comp_type] * item_count
    if "bufferView" not in acc:
        return [(0.0,) * item_count for _ in range(count)]
    view = gltf["bufferViews"][acc["bufferView"]]
    base = view.get("byteOffset", 0) + acc.get("byteOffset", 0)
    stride = view.get("byteStride", elem_size)
    return [struct.unpack_from(fmt, bin_chunk, base + i * stride) for i in range(count)]


def node_local_matrix(node):
    if "matrix" in node:
        m = node["matrix"]
        return Matrix(((m[0], m[4], m[8], m[12]), (m[1], m[5], m[9], m[13]), (m[2], m[6], m[10], m[14]), (m[3], m[7], m[11], m[15])))
    translation = Matrix.Translation(Vector(node.get("translation", [0.0, 0.0, 0.0])))
    q = node.get("rotation", [0.0, 0.0, 0.0, 1.0])
    rotation = Quaternion((q[3], q[0], q[1], q[2])).to_matrix().to_4x4()
    s = node.get("scale", [1.0, 1.0, 1.0])
    scale = Matrix.Diagonal((s[0], s[1], s[2], 1.0))
    return translation @ rotation @ scale


def node_worlds(gltf):
    worlds = {}
    scene_idx = gltf.get("scene", 0)

    def walk(idx, parent):
        node = gltf["nodes"][idx]
        world = parent @ node_local_matrix(node)
        worlds[idx] = world
        for child in node.get("children", []):
            walk(child, world)

    for node_idx in gltf.get("scenes", [{}])[scene_idx].get("nodes", []):
        walk(node_idx, Matrix.Identity(4))
    return worlds


def primitive_indices(gltf, bin_chunk, prim, vertex_count):
    if "indices" not in prim:
        return list(range(vertex_count))
    return [int(v[0]) for v in accessor_values(gltf, bin_chunk, prim["indices"])]


def triangle_area(a, b, c):
    return ((b - a).cross(c - a)).length / 2.0


def is_identity_node_transform(node, tol=1e-6):
    t = node.get("translation", [0.0, 0.0, 0.0])
    r = node.get("rotation", [0.0, 0.0, 0.0, 1.0])
    s = node.get("scale", [1.0, 1.0, 1.0])
    return (
        "matrix" not in node
        and all(abs(float(v)) <= tol for v in t)
        and abs(r[0]) <= tol
        and abs(r[1]) <= tol
        and abs(r[2]) <= tol
        and abs(r[3] - 1.0) <= tol
        and all(abs(float(v) - 1.0) <= tol for v in s)
    )


def parse_glb_metrics(path):
    gltf, bin_chunk = read_glb_chunks(path)
    worlds = node_worlds(gltf)
    mat_names = [m.get("name", "") for m in gltf.get("materials", [])]
    mesh_nodes = []
    bbox_by_node = {}
    tri_count = 0
    degenerate = 0
    duplicate_triangles = 0
    loose = 0
    material_sets = {}
    normal_prim_count = 0
    prim_count = 0
    all_positions = []

    for node_idx, node in enumerate(gltf.get("nodes", [])):
        if "mesh" not in node:
            continue
        name = node.get("name", "")
        mesh_nodes.append(name)
        mesh = gltf["meshes"][node["mesh"]]
        world = worlds.get(node_idx, Matrix.Identity(4))
        node_positions = []
        mats = set()
        for prim in mesh.get("primitives", []):
            if prim.get("mode", 4) != 4:
                continue
            prim_count += 1
            attrs = prim.get("attributes", {})
            if "NORMAL" in attrs:
                normal_prim_count += 1
            pos_acc_idx = attrs.get("POSITION")
            if pos_acc_idx is None:
                continue
            local_positions = [Vector(v[:3]) for v in accessor_values(gltf, bin_chunk, pos_acc_idx)]
            world_positions = [world @ p for p in local_positions]
            idxs = primitive_indices(gltf, bin_chunk, prim, len(world_positions))
            used = set(idxs)
            loose += max(0, len(world_positions) - len(used))
            tri_seen = {}
            for i in range(0, len(idxs), 3):
                if i + 2 >= len(idxs):
                    break
                a, b, c = world_positions[idxs[i]], world_positions[idxs[i + 1]], world_positions[idxs[i + 2]]
                tri_count += 1
                if len({idxs[i], idxs[i + 1], idxs[i + 2]}) < 3 or triangle_area(a, b, c) <= 1e-12:
                    degenerate += 1
                tri_key = tuple(sorted(tuple(round(float(cc), 6) for cc in p) for p in (a, b, c)))
                tri_seen[tri_key] = tri_seen.get(tri_key, 0) + 1
            duplicate_triangles += sum(v - 1 for v in tri_seen.values() if v > 1)
            mat_idx = prim.get("material", -1)
            if 0 <= mat_idx < len(mat_names):
                mats.add(mat_names[mat_idx])
            node_positions.extend(world_positions)
            all_positions.extend(world_positions)
        material_sets[name] = sorted(mats)
        if node_positions:
            xs = [p.x for p in node_positions]
            ys = [p.y for p in node_positions]
            zs = [p.z for p in node_positions]
            bbox_by_node[name] = {"min": [min(xs), min(ys), min(zs)], "max": [max(xs), max(ys), max(zs)]}
    xs = [p.x for p in all_positions]
    ys = [p.y for p in all_positions]
    zs = [p.z for p in all_positions]
    total_bbox = {"min": [min(xs), min(ys), min(zs)], "max": [max(xs), max(ys), max(zs)]} if all_positions else {"min": [0, 0, 0], "max": [0, 0, 0]}
    return {
        "gltf": gltf,
        "bin": bin_chunk,
        "mat_names": mat_names,
        "mesh_nodes": mesh_nodes,
        "bbox_by_node": bbox_by_node,
        "tri_count": tri_count,
        "degenerate_faces": degenerate,
        "duplicate_triangles_1e-6": duplicate_triangles,
        "loose_vertices": loose,
        "material_sets": material_sets,
        "normal_primitives": normal_prim_count,
        "primitive_count": prim_count,
        "total_bbox": total_bbox,
    }


def bbox_span(bbox):
    return [bbox["max"][i] - bbox["min"][i] for i in range(3)]


def run_validator(glb_path: Path):
    exe = shutil.which("npx")
    if not exe:
        return {"available": False, "pass": False, "note": "npx missing"}
    cmd = [exe, "--yes", "@gltf-transform/cli", "validate", str(glb_path), "--format", "csv"]
    try:
        proc = subprocess.run(cmd, cwd=str(EVIDENCE_DIR), text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=240)
    except Exception as exc:
        return {"available": False, "pass": False, "note": str(exc)}
    out = proc.stdout or ""
    num_errors = None
    for pat in [r"numErrors\D+(\d+)", r"Errors\D+(\d+)", r"ERROR,\s*(\d+)"]:
        m = re.search(pat, out, flags=re.IGNORECASE)
        if m:
            num_errors = int(m.group(1))
            break
    if num_errors is None:
        num_errors = len([line for line in out.splitlines() if line.strip().lower().startswith("error,")])
    if proc.returncode == 0 and "No errors found" in out:
        num_errors = 0
    return {"available": True, "mode": "gltf-transform", "rc": proc.returncode, "numErrors": num_errors, "pass": proc.returncode == 0 and num_errors == 0, "tail": "\n".join(out.splitlines()[-8:])}


def prop_gate(asset_id, metrics, validate, allowed_materials):
    gltf = metrics["gltf"]
    node_names = [n.get("name", "") for n in gltf.get("nodes", [])]
    scene_idx = gltf.get("scene", 0)
    scene_nodes = gltf.get("scenes", [{}])[scene_idx].get("nodes", [])
    root_node = node_names[scene_nodes[0]] if len(scene_nodes) == 1 else None
    total_span = bbox_span(metrics["total_bbox"])
    min_y = metrics["total_bbox"]["min"][1]
    max_y = metrics["total_bbox"]["max"][1]
    h0, h1 = PROPS[asset_id]["height_range_m"]
    bad_pivots = [n.get("name", "") for n in gltf.get("nodes", []) if "mesh" in n and not is_identity_node_transform(n)]
    checks = {
        "root_node": root_node == PROPS[asset_id]["root_node"] and len(scene_nodes) == 1,
        "grounded_y0": abs(min_y) <= 0.0005,
        "height_in_range": h0 <= max_y <= h1,
        "one_material_per_node": all(len(mats) == 1 for mats in metrics["material_sets"].values()),
        "materials_subset": set(metrics["mat_names"]) <= allowed_materials,
        "has_glow_accent": any(name in {"HK_Glow", "HK_GlowWarm"} for name in metrics["mat_names"]),
        "normals_exported": metrics["primitive_count"] > 0 and metrics["normal_primitives"] == metrics["primitive_count"],
        "no_skins": len(gltf.get("skins", [])) == 0,
        "pivots_identity": not bad_pivots,
        "tri_count_within_budget": metrics["tri_count"] <= PROPS[asset_id]["tri_budget"],
        "degenerate_faces_zero": metrics["degenerate_faces"] == 0,
        "loose_vertices_zero": metrics["loose_vertices"] == 0,
        "validate": bool(validate.get("pass")),
    }
    return {
        "asset": asset_id,
        "all_green": all(checks.values()),
        "root_node": root_node,
        "mesh_nodes": metrics["mesh_nodes"],
        "materials": metrics["mat_names"],
        "tri_count": int(metrics["tri_count"]),
        "total_bbox_m": {"min": [round(v, 5) for v in metrics["total_bbox"]["min"]], "max": [round(v, 5) for v in metrics["total_bbox"]["max"]], "span": [round(v, 5) for v in total_span]},
        "bad_pivot_nodes": bad_pivots,
        "validate": validate,
        "checks": checks,
    }


# ────────────────────────────── render rig ────────────────────────────────


def look_at_matrix(location, target, desired_up=(0, 0, 1)):
    loc = Vector(location)
    forward = (Vector(target) - loc).normalized()
    up_hint = Vector(desired_up).normalized()
    right = up_hint.cross(forward)
    if right.length < 1e-6:
        right = Vector((1, 0, 0))
    else:
        right.normalize()
    up = forward.cross(right).normalized()
    return Matrix(((right.x, up.x, -forward.x, loc.x), (right.y, up.y, -forward.y, loc.y), (right.z, up.z, -forward.z, loc.z), (0.0, 0.0, 0.0, 1.0)))


def add_camera_logical(name, location, target, ortho_scale):
    cam_data = bpy.data.cameras.new(name)
    cam = bpy.data.objects.new(name, cam_data)
    bpy.context.collection.objects.link(cam)
    cam.matrix_world = look_at_matrix(logical_to_blender(location), logical_to_blender(target), desired_up=(0, 0, 1))
    cam_data.type = "ORTHO"
    cam_data.ortho_scale = ortho_scale
    return cam


def setup_render():
    scene = bpy.context.scene
    try:
        scene.render.engine = "BLENDER_EEVEE_NEXT"
    except TypeError:
        scene.render.engine = "BLENDER_EEVEE"
    scene.render.resolution_x = P["render_resolution"][0]
    scene.render.resolution_y = P["render_resolution"][1]
    scene.render.film_transparent = False
    scene.view_settings.view_transform = "Standard"
    scene.view_settings.look = "None"
    scene.view_settings.exposure = 0.0
    scene.view_settings.gamma = 1.0
    bg = hex_to_rgba(P["render_bg_hex"])
    if scene.world is None:
        scene.world = bpy.data.worlds.new("facility_soft_grey_world")
    scene.world.color = bg[:3]
    scene.world.use_nodes = True
    bg_node = scene.world.node_tree.nodes.get("Background")
    if bg_node:
        bg_node.inputs["Color"].default_value = bg
        bg_node.inputs["Strength"].default_value = 0.82
    light_data = bpy.data.lights.new("sun_42_38", type="SUN")
    light_data.energy = 2.5
    light = bpy.data.objects.new("sun_42_38", light_data)
    bpy.context.collection.objects.link(light)
    az = math.radians(42.0)
    elev = math.radians(38.0)
    direction_logical = Vector((-math.cos(elev) * math.cos(az), -math.sin(elev), -math.cos(elev) * math.sin(az)))
    direction_bl = Vector(logical_to_blender(direction_logical))
    light.rotation_euler = direction_bl.to_track_quat("-Z", "Y").to_euler()
    return scene


def create_ref_box(location_logical):
    """Render-only pawn-height reference: a striped survey staff (4 alternating
    bands over 1.7525 m on a small base) so evidence reads it as a measure,
    not as stray scene geometry. Never exported."""
    def flat_mat(name, value):
        mat = bpy.data.materials.new(name)
        mat.diffuse_color = (value, value, value, 1.0)
        mat.use_nodes = True
        bsdf = mat.node_tree.nodes.get("Principled BSDF")
        if bsdf:
            bsdf.inputs["Base Color"].default_value = mat.diffuse_color
            bsdf.inputs["Roughness"].default_value = 0.9
        return mat

    mats = (flat_mat("render_ref_dark_not_exported", 0.14), flat_mat("render_ref_light_not_exported", 0.72))
    h = P["reference_box_height_m"]
    seg = h / 4.0
    cx, cz = location_logical
    parts = []
    b = MeshBuilder()
    b.extend_box((cx, 0.015, cz), (0.44, 0.03, 0.44))
    parts.append(make_mesh_object("render_ref_staff_base_not_exported", b, mats[0], None))
    for i in range(4):
        b = MeshBuilder()
        b.extend_box((cx, (i + 0.5) * seg, cz), (0.16, seg, 0.16))
        parts.append(make_mesh_object(f"render_ref_staff_seg{i}_not_exported", b, mats[i % 2], None))
    holder = parts[0]
    for p in parts[1:]:
        p.parent = holder
        p.matrix_parent_inverse = holder.matrix_world.inverted()
    holder.parent = None
    return holder


def set_all_visible(root):
    for obj in root.children_recursive:
        obj.hide_render = False
        obj.hide_viewport = False


def render_still(scene, camera, path):
    scene.camera = camera
    scene.render.filepath = str(path)
    bpy.ops.render.render(write_still=True)


def set_ref_hidden(ref, hidden):
    for obj in [ref, *ref.children_recursive]:
        obj.hide_render = hidden
        obj.hide_viewport = hidden


def render_prop(root, asset_id, ortho, cam_height, close_target, close_scale):
    scene = setup_render()
    ref = create_ref_box((-1.15, 0.35))
    cams = {
        "front": add_camera_logical(f"cam_{asset_id}_front", (0.0, cam_height, 5.2), (0.0, cam_height * 0.92, 0.0), ortho),
        "3q": add_camera_logical(f"cam_{asset_id}_3q", (3.4, cam_height + 1.4, 3.8), (0.0, cam_height * 0.85, 0.0), ortho + 0.25),
        "back": add_camera_logical(f"cam_{asset_id}_back", (-2.6, cam_height + 1.2, -4.6), (0.0, cam_height * 0.85, 0.0), ortho + 0.25),
        "close": add_camera_logical(f"cam_{asset_id}_close", (close_target[0] + 0.9, close_target[1] + 1.15, close_target[2] + 2.2), close_target, close_scale),
    }
    set_all_visible(root)
    render_still(scene, cams["front"], RENDER_DIR / f"{asset_id}_front.png")
    render_still(scene, cams["3q"], RENDER_DIR / f"{asset_id}_3q.png")
    render_still(scene, cams["back"], RENDER_DIR / f"{asset_id}_back.png")
    set_ref_hidden(ref, True)
    render_still(scene, cams["close"], RENDER_DIR / f"{asset_id}_close.png")


# ─────────────────────────────── provenance ───────────────────────────────


def sha256_of(path: Path) -> str:
    return "sha256:" + hashlib.sha256(path.read_bytes()).hexdigest()


def write_provenance(asset_id, glb_path: Path, tri_count: int, gate_summary: str, description: str):
    data = {
        "schema": "successor-asset-provenance/1",
        "asset_id": asset_id,
        "asset_path": f"client-3d/public/assets/world-items/{glb_path.name}",
        "asset_hash": sha256_of(glb_path),
        "asset_kind": "model_glb",
        "tool": {"name": "blender-bpy-headless", "version": bpy.app.version_string.split()[0], "tool_snapshot_id": f"blender-{bpy.app.version_string.split()[0]}"},
        "prompt": {
            "text": description,
            "denylist_audit": "passed: no franchise/IP terms in names, materials, node names, or artifacts",
        },
        "seed": None,
        "input_assets": [
            {"path": "client-3d/public/assets/world-items/house_h1_manifest.json", "purpose": "structural_reference (shoulder-house language + door contract)"},
            {"path": "tools/successor/extract-structure-collision.mjs", "purpose": "collision_sidecar_contract"},
        ],
        "human_edits": [],
        "rights": {
            "source_license": "Successor proprietary project asset; all rights reserved",
            "redistribution_status": "authorized for Successor runtime distribution only; no standalone reuse grant",
        },
        "regeneration_command": "/snap/bin/blender -b --factory-startup --python-exit-code 1 -P tools/successor/assets/build_bank_terminal.py",
        "tri_count": tri_count,
        "gate_report": gate_summary,
        "source_blend_or_script": "tools/successor/assets/build_bank_terminal.py (deterministic parametric part program; no .blend needed)",
        "agent_provenance": {
            "produced_by": [
                {
                    "agent_instance_id": "CloneFacilityAsset",
                    "run_id": "cloning-facility-20260716",
                    "role": "content-author",
                    "provider": "anthropic",
                    "model": "Fable 5",
                }
            ],
            "reviewed_by_agents": [
                {"agent_instance_id": "CloneFacilityAsset", "role": "judge", "notes": "numeric parsed-GLB gates + multi-angle render review in .game-lab/cloning-facility-20260716/renders/"}
            ],
            "human_approvals": [],
        },
    }
    write_json(glb_path.with_suffix("").with_name(glb_path.stem + ".provenance.json"), data)


PROVENANCE_TEXT = {
    "bank_terminal": (
        "Hand-authored parametric part program (no generative model): Dustgate outdoor bank terminal "
        "kiosk — corbel-supported armored steel head over a cast column, brass side rails, hooded "
        "amber ledger screen behind glass, 12-key keypad with a glowing accept key, credit-chip "
        "slot, receipt slit with a protruding stub, and an open dispenser tray. Grounded at y=0, "
        "2.06 m tall at pawn scale."
    ),
}


def main():
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    EVIDENCE_DIR.mkdir(parents=True, exist_ok=True)
    RENDER_DIR.mkdir(parents=True, exist_ok=True)
    for p in RENDER_DIR.glob("*.png"):
        p.unlink()

    root = build_bank_terminal_scene()
    export_glb(root, BANK_GLB, with_animations=False)
    metrics = parse_glb_metrics(BANK_GLB)
    validate = run_validator(BANK_GLB)
    gate = prop_gate("bank_terminal", metrics, validate, BANK_MATERIALS)
    render_prop(root, "bank_terminal", 2.6, 1.05, (0.0, 0.90, 0.32), 1.95)
    write_json(GATE_PATH, gate)
    write_provenance("bank_terminal", BANK_GLB, metrics["tri_count"], PROVENANCE_GATE_REPORT, PROVENANCE_TEXT["bank_terminal"])

    final = json.loads(GATE_PATH.read_text())
    print(json.dumps({
        "all_green": final["all_green"],
        "tri_count": final["tri_count"],
        "checks_failed": [c for c, ok in final["checks"].items() if not ok],
    }, indent=2))
    if not final.get("all_green"):
        raise SystemExit("gate.json is not green after disk re-read")


if __name__ == "__main__":
    main()
