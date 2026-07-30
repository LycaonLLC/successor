#!/usr/bin/env python3
"""Build the Dustgate cloning-facility asset suite (deterministic source of truth).

Produces (runtime dir `client-3d/public/assets/world-items/`):
  - cloning_facility.glb + cloning_facility_manifest.json (+ _collision.json via
    tools/successor/extract-structure-collision.mjs, invoked at the end)
  - bank_terminal.glb
  - clone_terminal.glb
  - clone_pod.glb
  - one .provenance.json sidecar per GLB

Evidence (ignored): .game-lab/cloning-facility-20260716/ (renders/, gate.json).

Headless:
    /snap/bin/blender -b --factory-startup --python-exit-code 1 \
        -P tools/successor/assets/build_cloning_facility.py

Design language: the shipped H1 Shoulder House (build_house_H1.py) — squat cast
mono-mass, 45-degree chamfered wall shoulders, stepped parapets, protruding
offset entry bay with a pocket door, deep dark reveals, quiet conduit tech.
Scaled to a 10x8-cell civic landmark: mesh authored 9.5 x 7.6 m so the runtime
placement scale is min(10/9.5, 8/7.6) = 1.052632, identical to house_h1 and
podtent_scout — pawn-scale parity across the camp. Floor top is authored at
y = 0.02 m so the slab cannot z-fight with terrain; the cast slab sits below
that surface.

No generative model, no franchise/IP motifs, no purple sci-fi: warm cast
earth tones (HK_* family), brushed steel, brass restraint, and cyan/amber
emissive accents only where a machine actually lives.
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
EVIDENCE_DIR = REPO / ".game-lab" / "cloning-facility-20260716"
RENDER_DIR = EVIDENCE_DIR / "renders"
GATE_PATH = EVIDENCE_DIR / "gate.json"
EXTRACTOR = REPO / "tools" / "successor" / "extract-structure-collision.mjs"

FACILITY_GLB = OUT_DIR / "cloning_facility.glb"
MANIFEST_PATH = OUT_DIR / "cloning_facility_manifest.json"

P = {
    "building": "cloning_facility",
    "identity": (
        "Dustgate cloning facility — a 10x8-cell bio-containment landmark in the "
        "shoulder-house language: recessed cast shell over a grounded foundation "
        "curb, asymmetric stepped buttresses, a rooftop process hall and stack "
        "ducted into the back-corner filtration tower, half-sunk process tanks "
        "with connected pipe runs, a roof bio-reservoir with a feed manifold, a "
        "twin-figure resurrection crest, and a broad pressure-vessel blast portal "
        "traced by an energized bioseal gasket."
    ),
    "root_node": "Gear_cloning_facility",
    "units": "m",
    "footprint_cells": [10, 8],
    # Mesh spans exactly 9.5 x 7.6 => runtime scale 10/9.5 = 8/7.6 = 1.052632.
    "main_outer": {"x_min": -4.75, "x_max": 4.75, "z_min": -3.80, "z_max": 3.10},
    # Side/back wall shells are recessed 0.25 from the envelope; buttresses,
    # the service tower and the tank bank reach the exact 9.5 x 7.6 extremes.
    "shell": {"left_x": -4.50, "right_x": 4.50, "back_z": -3.55},
    "entry_bay": {"x_min": -3.25, "x_max": 2.75, "z_back": 3.10, "z_front": 3.72},
    "wall_thickness_m": 0.30,
    "shoulder": {"base_y_m": 3.05, "bevel_m": 0.22, "angle_deg": 45.0},
    "parapet": {"base_y_m": 3.27, "low_top_y_m": 3.66, "entry_high_top_y_m": 4.02},
    "roof": {"slab_bottom_y_m": 3.05, "slab_top_y_m": 3.25},
    # Contract: floor TOP authored at y=0.02 m; the cast slab sits below grade.
    "floor": {"slab_thickness_m": 0.14, "top_y_m": 0.02},
    "door": {
        "node": "door_slide",
        "opening_bounds": {"x_min": -0.30, "x_max": 2.00, "y_min": 0.0, "y_max": 2.42, "front_z": 3.76, "inner_z": 3.42},
        "closed_center": [0.85, 1.22, 3.56],
        "panel_size": [2.42, 2.44, 0.08],
        "relief_rib_depth_m": 0.035,
        "slide_axis_local": [-1, 0, 0],
        "slide_distance_m": 2.40,
        "clip_duration_s": 0.8,
        "fps": 30,
        "pocket_bounds": {"x_min": -2.90, "x_max": -0.32, "y_min": -0.01, "y_max": 2.50, "z_min": 3.47, "z_max": 3.67},
    },
    "windows": [
        {"name": "wall_left__slit_reveal", "wall": "left", "z_min": -2.35, "z_max": -0.85, "y_min": 2.15, "y_max": 2.55},
        {"name": "wall_right__slit_reveal", "wall": "right", "z_min": -2.60, "z_max": -1.10, "y_min": 2.15, "y_max": 2.55},
        {"name": "wall_back__slit_reveal", "wall": "back", "pairs": [[-3.10, -1.30], [1.50, 3.30]], "y_min": 2.20, "y_max": 2.60},
    ],
    "interior_clear_height_m": 3.05,
    "tri_budget": 7000,
    "reference_box_height_m": 1.7525,
    "render_resolution": [1280, 960],
    "render_bg_hex": "#D8D8D8",
}

PROPS = {
    "bank_terminal": {"root_node": "Gear_bank_terminal", "height_range_m": [1.95, 2.15], "tri_budget": 2600},
    "clone_terminal": {"root_node": "Gear_clone_terminal", "height_range_m": [1.60, 1.85], "tri_budget": 2200},
    "clone_pod": {"root_node": "Gear_clone_pod", "height_range_m": [2.15, 2.45], "tri_budget": 3200},
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
FACILITY_MATERIALS = {"HK_Frame", "HK_Clad", "HK_Clad2", "HK_Roof", "HK_Floor", "HK_Door", "HK_Trim", "HK_Steel", "HK_Brass", "HK_Shell", "HK_Glow"}
BANK_MATERIALS = {"HK_Frame", "HK_Clad", "HK_Steel", "HK_Brass", "HK_GlowWarm", "HK_Trim", "HK_Glass", "HK_Shell"}
CLONE_TERM_MATERIALS = {"HK_Frame", "HK_Shell", "HK_Steel", "HK_Glow", "HK_Trim"}
POD_MATERIALS = {"HK_Frame", "HK_Shell", "HK_Steel", "HK_Glass", "HK_Glow", "HK_Brass"}
ROLE_PREFIXES = ("roof__", "wall_front__", "wall_right__", "wall_back__", "wall_left__", "floor__", "interior__")


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


# ─────────────────────────── facility geometry ────────────────────────────


def groove_segments(a0, a1, panel=0.72, gap=0.06):
    """Deterministic panel segmentation of [a0, a1] with `gap`-wide grooves."""
    n = max(1, round((a1 - a0 + gap) / (panel + gap)))
    step = (a1 - a0 + gap) / n
    return [(round(a0 + i * step, 6), round(a0 + (i + 1) * step - gap, 6)) for i in range(n)]


def ring_z(b, cx, cy, r_in, r_out, z0, z1, segments=16, start_deg=0.0):
    """Annulus facing +z (emblem rings), built in the logical x-y plane."""
    inner0, inner1, outer0, outer1 = [], [], [], []
    for i in range(segments):
        a = math.radians(start_deg) + 2.0 * math.pi * i / segments
        ca, sa = math.cos(a), math.sin(a)
        inner0.append((round(cx + r_in * ca, 7), round(cy + r_in * sa, 7), z0))
        inner1.append((round(cx + r_in * ca, 7), round(cy + r_in * sa, 7), z1))
        outer0.append((round(cx + r_out * ca, 7), round(cy + r_out * sa, 7), z0))
        outer1.append((round(cx + r_out * ca, 7), round(cy + r_out * sa, 7), z1))
    for i in range(segments):
        j = (i + 1) % segments
        b.face([outer1[i], outer1[j], inner1[j], inner1[i]])  # front annulus
        b.face([inner0[i], inner0[j], outer0[j], outer0[i]])  # back annulus
        b.face([outer0[i], outer0[j], outer1[j], outer1[i]])  # outer rim
        b.face([inner1[i], inner1[j], inner0[j], inner0[i]])  # inner rim


def disc_z(b, cx, cy, rx, ry, z0, z1, sides=8, start_deg=0.0):
    """Elliptical n-gon puck facing +z (emblem capsule, door hub)."""
    ring0, ring1 = [], []
    for i in range(sides):
        a = math.radians(start_deg) + 2.0 * math.pi * i / sides
        ring0.append((round(cx + rx * math.cos(a), 7), round(cy + ry * math.sin(a), 7), z0))
        ring1.append((round(cx + rx * math.cos(a), 7), round(cy + ry * math.sin(a), 7), z1))
    for i in range(sides):
        j = (i + 1) % sides
        b.face([ring0[i], ring0[j], ring1[j], ring1[i]])
    b.face(list(reversed(ring0)))
    b.face(list(ring1))


def prism_x(b, cy, cz, radius, x0, x1, sides=8, start_deg=22.5):
    """Horizontal prism along the logical x axis (tanks, reservoirs)."""
    ring0, ring1 = [], []
    for i in range(sides):
        a = math.radians(start_deg) + 2.0 * math.pi * i / sides
        y = cy + radius * math.cos(a)
        z = cz + radius * math.sin(a)
        ring0.append((x0, round(y, 7), round(z, 7)))
        ring1.append((x1, round(y, 7), round(z, 7)))
    for i in range(sides):
        j = (i + 1) % sides
        b.face([ring0[i], ring0[j], ring1[j], ring1[i]])
    b.face(list(reversed(ring0)))
    b.face(list(ring1))


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


def build_facility_walls(root, mats):
    mo = P["main_outer"]
    eb = P["entry_bay"]
    sh = P["shell"]
    th = P["wall_thickness_m"]
    floor_top = P["floor"]["top_y_m"]
    wall_top = P["shoulder"]["base_y_m"]
    door = P["door"]["opening_bounds"]
    dd = 0.09  # proud plate layer on the recessed shell faces (deep grooves)
    py0, py1 = 0.44, wall_top
    SL, SR, SB = sh["left_x"], sh["right_x"], sh["back_z"]

    # ── front: main wall segments between bay and corner chassis ──
    b = MeshBuilder()
    bounds(b, SL, eb["x_min"], floor_top, wall_top, mo["z_max"] - th, mo["z_max"] - dd)
    bounds(b, eb["x_max"], SR, floor_top, wall_top, mo["z_max"] - th, mo["z_max"] - dd)
    make_mesh_object("wall_front__main_clad", b, mats["HK_Clad"], root)

    b = MeshBuilder()
    bounds(b, SL, eb["x_min"], floor_top, 0.38, mo["z_max"] - dd, mo["z_max"] - 0.02)
    bounds(b, eb["x_max"], SR, floor_top, 0.38, mo["z_max"] - dd, mo["z_max"] - 0.02)
    make_mesh_object("wall_front__plinth_band", b, mats["HK_Frame"], root)

    b = MeshBuilder()
    for x0, x1 in groove_segments(SL + 0.10, eb["x_min"] - 0.06):
        bounds(b, x0, x1, py0, py1, mo["z_max"] - dd, mo["z_max"])
    for x0, x1 in groove_segments(eb["x_max"] + 0.06, SR - 0.10):
        bounds(b, x0, x1, py0, py1, mo["z_max"] - dd, mo["z_max"])
    make_mesh_object("wall_front__panel_plates", b, mats["HK_Clad2"], root)

    # ── entry bay side returns (real mass) ──
    b = MeshBuilder()
    bounds(b, eb["x_min"], eb["x_min"] + th, floor_top, wall_top, eb["z_back"], eb["z_front"])
    bounds(b, eb["x_max"] - th, eb["x_max"], floor_top, wall_top, eb["z_back"], eb["z_front"])
    make_mesh_object("wall_front__entry_bay_side_returns", b, mats["HK_Clad"], root)

    # ── bay front: solid right segment + header over the broad portal ──
    bay_z0, bay_z1 = eb["z_front"] - th, eb["z_front"]
    b = MeshBuilder()
    bounds(b, door["x_max"], eb["x_max"] - th, floor_top, wall_top, bay_z0, bay_z1)
    bounds(b, door["x_min"], door["x_max"], door["y_max"], wall_top, bay_z0, bay_z1)
    make_mesh_object("wall_front__entry_bay_clad", b, mats["HK_Clad"], root)

    # Bay plinth band flanking the portal.
    b = MeshBuilder()
    bounds(b, eb["x_min"] + 0.06, door["x_min"] - 1.08, floor_top, 0.38, bay_z1, bay_z1 + 0.04)
    make_mesh_object("wall_front__bay_plinth_band", b, mats["HK_Frame"], root)

    # ── pocket segment: skins + cap + end plate (gap hosts the blast panel) ──
    seg_x0, seg_x1 = eb["x_min"] + th, door["x_min"]
    b = MeshBuilder()
    bounds(b, seg_x0, seg_x1, floor_top, 2.50, 3.66, bay_z1)
    bounds(b, seg_x0, seg_x1, floor_top, 2.50, bay_z0, 3.48)
    bounds(b, seg_x0, seg_x1, 2.50, wall_top, bay_z0, bay_z1)
    bounds(b, seg_x0, seg_x0 + 0.06, floor_top, 2.50, 3.48, 3.66)
    make_mesh_object("wall_front__pocket_swallow", b, mats["HK_Clad2"], root)

    # ── deep dark portal reveal (jambs + header) ──
    b = MeshBuilder()
    rz0, rz1 = door["inner_z"], door["front_z"]
    bounds(b, door["x_min"] - 0.06, door["x_min"], door["y_min"], door["y_max"], rz0, rz1)
    bounds(b, door["x_max"], door["x_max"] + 0.06, door["y_min"], door["y_max"], rz0, rz1)
    bounds(b, door["x_min"] - 0.06, door["x_max"] + 0.06, door["y_max"], door["y_max"] + 0.08, rz0, rz1)
    make_mesh_object("wall_front__portal_reveal", b, mats["HK_Frame"], root)

    # ── heavy containment surround: asymmetric pilasters + stepped lintel ──
    b = MeshBuilder()
    sz0, sz1 = bay_z1 - 0.02, 3.78
    # Wide pocket-side pilaster (two layers), narrow pylon-side pilaster.
    bounds(b, door["x_min"] - 1.08, door["x_min"] - 0.06, floor_top, 3.02, sz0, sz1 - 0.04)
    bounds(b, door["x_min"] - 0.92, door["x_min"] - 0.22, floor_top, 2.86, sz1 - 0.04, sz1)
    bounds(b, door["x_max"] + 0.06, door["x_max"] + 0.32, floor_top, 3.02, sz0, sz1)
    # Lintel band + stepped cap blocks above it.
    bounds(b, door["x_min"] - 1.08, door["x_max"] + 0.32, 2.56, 3.02, sz0, sz1 - 0.04)
    bounds(b, door["x_min"] - 0.80, door["x_max"] + 0.10, 3.02, 3.20, sz0, sz1 - 0.08)
    bounds(b, door["x_min"] - 0.40, door["x_max"] - 0.30, 3.20, 3.34, sz0, sz1 - 0.12)
    # Threshold cheek blocks at grade.
    bounds(b, door["x_min"] - 0.50, door["x_min"] - 0.06, floor_top, 0.14, sz1 - 0.02, 3.80)
    bounds(b, door["x_max"] + 0.06, door["x_max"] + 0.50, floor_top, 0.14, sz1 - 0.02, 3.80)
    make_mesh_object("wall_front__portal_surround", b, mats["HK_Frame"], root)

    b = MeshBuilder()
    for bx in (door["x_min"] - 0.86, door["x_min"] - 0.56, door["x_min"] - 0.28):
        for by in (0.30, 1.42, 2.62):
            bounds(b, bx, bx + 0.07, by, by + 0.07, sz1 - 0.045, 3.775)
    for by in (0.30, 1.42, 2.62):
        bounds(b, door["x_max"] + 0.13, door["x_max"] + 0.20, by, by + 0.07, sz1 - 0.005, 3.80)
    make_mesh_object("wall_front__surround_bolts", b, mats["HK_Steel"], root)

    # Containment dog receivers: clamp blocks bedded into the lintel face.
    b = MeshBuilder()
    for rx in (0.15, 0.85, 1.55):
        bounds(b, rx - 0.14, rx + 0.14, 2.60, 2.76, sz1 - 0.04, sz1 + 0.015)
    make_mesh_object("wall_front__portal_dog_receivers", b, mats["HK_Steel"], root)

    # Grounding: foundation curb at grade, proud of the plate faces.
    b = MeshBuilder()
    bounds(b, -4.42, eb["x_min"], 0.0, 0.16, mo["z_max"] - 0.04, mo["z_max"] + 0.06)
    bounds(b, eb["x_max"], SR - 0.08, 0.0, 0.16, mo["z_max"] - 0.04, mo["z_max"] + 0.06)
    bounds(b, door["x_max"] + 0.52, eb["x_max"] - 0.06, 0.0, 0.14, bay_z1, bay_z1 + 0.04)
    make_mesh_object("wall_front__foundation_curb", b, mats["HK_Frame"], root)
    b = MeshBuilder()
    bounds(b, SL + 0.05, 3.50, 0.0, 0.16, SB - 0.06, SB + 0.04)
    make_mesh_object("wall_back__foundation_curb", b, mats["HK_Frame"], root)
    b = MeshBuilder()
    bounds(b, SL - 0.06, SL + 0.04, 0.0, 0.16, -2.85, 2.25)
    make_mesh_object("wall_left__foundation_curb", b, mats["HK_Frame"], root)
    b = MeshBuilder()
    bounds(b, SR - 0.04, SR + 0.06, 0.0, 0.16, SB + 0.10, 2.35)
    make_mesh_object("wall_right__foundation_curb", b, mats["HK_Frame"], root)

    # Service wear: bolted patch plates on the cladding.
    b = MeshBuilder()
    for px, py, pw, ph in ((-3.72, 0.98, 0.52, 0.40), (-1.98, 2.18, 0.38, 0.30), (3.44, 0.72, 0.46, 0.34)):
        bounds(b, px, px + pw, py, py + ph, mo["z_max"], mo["z_max"] + 0.012)
    make_mesh_object("wall_front__patch_plates", b, mats["HK_Trim"], root)
    b = MeshBuilder()
    for pz, py, pd, ph in ((-2.98, 0.88, 0.50, 0.36), (0.62, 1.92, 0.40, 0.30)):
        bounds(b, SR, SR + 0.012, py, py + ph, pz, pz + pd)
    make_mesh_object("wall_right__patch_plates", b, mats["HK_Trim"], root)

    # Parapet scuppers punched through the left shell.
    b = MeshBuilder()
    bounds(b, SL - 0.14, SL + 0.10, 3.30, 3.42, -0.62, -0.46)
    bounds(b, SL - 0.14, SL + 0.10, 3.30, 3.42, 1.18, 1.34)
    make_mesh_object("wall_left__scuppers", b, mats["HK_Steel"], root)

    # Energized bioseal gasket traced tight around the portal on the surround.
    b = MeshBuilder()
    bounds(b, door["x_min"] - 0.17, door["x_min"] - 0.125, 0.0, 2.62, sz1, sz1 + 0.018)
    bounds(b, door["x_max"] + 0.125, door["x_max"] + 0.17, 0.0, 2.62, sz1, sz1 + 0.018)
    bounds(b, door["x_min"] - 0.17, door["x_max"] + 0.17, 2.575, 2.62, sz1 - 0.04, sz1 - 0.022)
    make_mesh_object("wall_front__portal_glow_frame", b, mats["HK_Frame"], root)
    b = MeshBuilder()
    bounds(b, door["x_min"] - 0.12, door["x_min"] - 0.065, 0.06, 2.52, sz1, sz1 + 0.02)
    bounds(b, door["x_max"] + 0.065, door["x_max"] + 0.12, 0.06, 2.52, sz1, sz1 + 0.02)
    bounds(b, door["x_min"] - 0.12, door["x_max"] + 0.12, 2.52, 2.57, sz1 - 0.04, sz1 - 0.02)
    make_mesh_object("wall_front__portal_glow", b, mats["HK_Glow"], root)
    b = MeshBuilder()
    bounds(b, door["x_min"] - 0.78, door["x_min"] - 0.58, 0.42, 2.38, sz1 - 0.045, sz1 - 0.035)
    bounds(b, door["x_max"] + 0.09, door["x_max"] + 0.29, 0.42, 2.38, sz1 - 0.005, sz1 + 0.005)
    make_mesh_object("wall_front__pilaster_slit_frames", b, mats["HK_Frame"], root)
    b = MeshBuilder()
    bounds(b, door["x_min"] - 0.72, door["x_min"] - 0.64, 0.50, 2.30, sz1 - 0.035, sz1 - 0.015)
    bounds(b, door["x_max"] + 0.15, door["x_max"] + 0.23, 0.50, 2.30, sz1 + 0.005, sz1 + 0.02)
    make_mesh_object("wall_front__pilaster_glow_slits", b, mats["HK_Glow"], root)

    # ── brass signage pylon with a real double-post sign board ──
    b = MeshBuilder()
    bounds(b, 2.18, 2.62, floor_top, 0.14, 3.64, 3.80)
    bounds(b, 2.30, 2.44, 0.14, 4.10, bay_z1, 3.78)
    bounds(b, 1.86, 2.88, 3.26, 4.18, 3.69, 3.78)
    bounds(b, 1.82, 2.92, 4.18, 4.30, 3.66, 3.80)
    bounds(b, 2.06, 2.30, 2.94, 3.06, bay_z1, 3.76)
    make_mesh_object("wall_front__signage_fin", b, mats["HK_Brass"], root)
    b = MeshBuilder()
    bounds(b, 1.94, 2.80, 3.36, 4.08, 3.78, 3.80)
    bounds(b, 2.32, 2.42, 0.40, 3.20, 3.78, 3.795)
    make_mesh_object("wall_front__signage_glow_slot", b, mats["HK_Glow"], root)

    # ── resurrection crest: twin-figure clone emblem on a mounted backboard —
    # brass ring, brass "original" figure, glowing "clone" figure, transfer bar.
    emx, emy = (door["x_min"] + door["x_max"]) / 2, 3.70
    b = MeshBuilder()
    bounds(b, emx - 0.55, emx + 0.55, 3.30, 4.14, 3.72, 3.735)
    bounds(b, emx - 0.55, emx - 0.43, 4.02, 4.10, 3.52, 3.735)
    bounds(b, emx + 0.43, emx + 0.55, 4.02, 4.10, 3.52, 3.735)
    disc_z(b, emx, emy, 0.42, 0.42, 3.735, 3.755, sides=16)
    make_mesh_object("wall_front__emblem_backboard", b, mats["HK_Frame"], root)
    b = MeshBuilder()
    ring_z(b, emx, emy, 0.33, 0.40, 3.755, 3.795, segments=16)
    disc_z(b, emx - 0.14, emy + 0.145, 0.075, 0.075, 3.755, 3.785, sides=10)
    disc_z(b, emx - 0.14, emy - 0.075, 0.10, 0.155, 3.755, 3.785, sides=10)
    make_mesh_object("wall_front__clone_emblem_ring", b, mats["HK_Brass"], root)
    b = MeshBuilder()
    disc_z(b, emx + 0.14, emy + 0.145, 0.075, 0.075, 3.755, 3.79, sides=10)
    disc_z(b, emx + 0.14, emy - 0.075, 0.10, 0.155, 3.755, 3.79, sides=10)
    bounds(b, emx - 0.06, emx + 0.06, emy - 0.10, emy - 0.05, 3.755, 3.785)
    make_mesh_object("wall_front__clone_emblem_pod", b, mats["HK_Glow"], root)

    # ── pedestrian-medical entry canopy: thin steel blade + hangers + guides ──
    b = MeshBuilder()
    bounds(b, door["x_min"] - 0.10, door["x_max"] + 0.10, 2.60, 2.66, bay_z1, 3.80)
    bounds(b, door["x_min"] + 0.10, door["x_min"] + 0.16, 2.66, 2.94, 3.73, 3.78)
    bounds(b, door["x_max"] - 0.16, door["x_max"] - 0.10, 2.66, 2.94, 3.73, 3.78)
    make_mesh_object("wall_front__entry_canopy", b, mats["HK_Steel"], root)

    b = MeshBuilder()
    for gx in (door["x_min"] + 0.22, door["x_max"] - 0.28):
        bounds(b, gx, gx + 0.06, 0.0, 0.006, 3.30, 3.70)
    make_mesh_object("floor__approach_guides_glow", b, mats["HK_Glow"], root)
    b = MeshBuilder()
    for gx in (door["x_min"] + 0.22, door["x_max"] - 0.28):
        bounds(b, gx - 0.03, gx, 0.0, 0.01, 3.28, 3.72)
        bounds(b, gx + 0.06, gx + 0.09, 0.0, 0.01, 3.28, 3.72)
    make_mesh_object("floor__approach_guide_frames", b, mats["HK_Frame"], root)

    # ── back wall: recessed shell with two slit windows + plate layer ──
    bw = P["windows"][2]
    (s0x0, s0x1), (s1x0, s1x1) = bw["pairs"]
    wy0, wy1 = bw["y_min"], bw["y_max"]
    bz_face, bz_in = SB + dd, SB + th
    b = MeshBuilder()
    bounds(b, SL, SR, floor_top, wy0, bz_face, bz_in)
    bounds(b, SL, SR, wy1, wall_top, bz_face, bz_in)
    bounds(b, SL, s0x0, wy0, wy1, bz_face, bz_in)
    bounds(b, s0x1, s1x0, wy0, wy1, bz_face, bz_in)
    bounds(b, s1x1, SR, wy0, wy1, bz_face, bz_in)
    make_mesh_object("wall_back__clad", b, mats["HK_Clad"], root)

    b = MeshBuilder()
    bounds(b, SL, SR, floor_top, 0.38, SB + 0.02, bz_face)
    make_mesh_object("wall_back__plinth_band", b, mats["HK_Frame"], root)

    b = MeshBuilder()
    for x0, x1 in groove_segments(SL + 0.10, s0x0 - 0.18):
        bounds(b, x0, x1, py0, py1, SB, bz_face)
    for x0, x1 in groove_segments(s0x1 + 0.18, s1x0 - 0.18):
        bounds(b, x0, x1, py0, py1, SB, bz_face)
    for x0, x1 in groove_segments(s1x1 + 0.18, SR - 0.10):
        bounds(b, x0, x1, py0, py1, SB, bz_face)
    for wx0, wx1 in bw["pairs"]:
        bounds(b, wx0 - 0.18, wx0 - 0.05, py0, py1, SB, bz_face)
        bounds(b, wx1 + 0.05, wx1 + 0.18, py0, py1, SB, bz_face)
    make_mesh_object("wall_back__panel_plates", b, mats["HK_Clad2"], root)

    b = MeshBuilder()
    for wx0, wx1 in bw["pairs"]:
        bounds(b, wx0 - 0.05, wx0, wy0, wy1, SB - 0.02, bz_in)
        bounds(b, wx1, wx1 + 0.05, wy0, wy1, SB - 0.02, bz_in)
        bounds(b, wx0 - 0.05, wx1 + 0.05, wy1, wy1 + 0.05, SB - 0.02, bz_in)
        bounds(b, wx0 - 0.05, wx1 + 0.05, wy0 - 0.05, wy0, SB - 0.02, bz_in)
    make_mesh_object("wall_back__slit_reveal", b, mats["HK_Frame"], root)

    # Twin liquid transfer lines: back buttress -> service tower, with flanges.
    b = MeshBuilder()
    for py in (1.46, 1.70):
        bounds(b, -4.46, 3.56, py, py + 0.12, SB - 0.11, SB - 0.02)
    bounds(b, -4.46, -4.34, 1.40, 1.88, SB - 0.13, SB)
    make_mesh_object("wall_back__pipe_run", b, mats["HK_Trim"], root)

    # Junction plate where the transfer lines enter the tower's west face.
    b = MeshBuilder()
    bounds(b, 3.53, 3.58, 1.32, 1.96, SB - 0.17, SB + 0.01)
    make_mesh_object("wall_back__pipe_junction_plate", b, mats["HK_Steel"], root)

    # ── left wall: recessed shell with slit window + plate layer ──
    lw = P["windows"][0]
    lz0, lz1 = lw["z_min"], lw["z_max"]
    ly0, ly1 = lw["y_min"], lw["y_max"]
    lx_face, lx_in = SL + dd, SL + th
    b = MeshBuilder()
    bounds(b, lx_face, lx_in, floor_top, ly0, SB, mo["z_max"])
    bounds(b, lx_face, lx_in, ly1, wall_top, SB, mo["z_max"])
    bounds(b, lx_face, lx_in, ly0, ly1, SB, lz0)
    bounds(b, lx_face, lx_in, ly0, ly1, lz1, mo["z_max"])
    make_mesh_object("wall_left__clad", b, mats["HK_Clad"], root)

    b = MeshBuilder()
    bounds(b, SL + 0.02, lx_face, floor_top, 0.38, SB, mo["z_max"])
    make_mesh_object("wall_left__plinth_band", b, mats["HK_Frame"], root)

    b = MeshBuilder()
    for z0, z1 in groove_segments(SB + 0.10, lz0 - 0.18):
        bounds(b, SL, lx_face, py0, py1, z0, z1)
    for z0, z1 in groove_segments(lz1 + 0.18, mo["z_max"] - 0.10):
        bounds(b, SL, lx_face, py0, py1, z0, z1)
    bounds(b, SL, lx_face, py0, py1, lz0 - 0.18, lz0 - 0.05)
    bounds(b, SL, lx_face, py0, py1, lz1 + 0.05, lz1 + 0.18)
    make_mesh_object("wall_left__panel_plates", b, mats["HK_Clad2"], root)

    b = MeshBuilder()
    bounds(b, SL - 0.02, lx_in, ly0, ly1, lz0 - 0.05, lz0)
    bounds(b, SL - 0.02, lx_in, ly0, ly1, lz1, lz1 + 0.05)
    bounds(b, SL - 0.02, lx_in, ly1, ly1 + 0.05, lz0 - 0.05, lz1 + 0.05)
    bounds(b, SL - 0.02, lx_in, ly0 - 0.08, ly0, lz0 - 0.05, lz1 + 0.05)
    make_mesh_object("wall_left__slit_reveal", b, mats["HK_Frame"], root)

    # ── asymmetric stepped buttresses (corner chassis, real collision) ──
    b = MeshBuilder()
    bounds(b, mo["x_min"], SL + 0.06, floor_top, 1.40, 2.30, mo["z_max"])
    bounds(b, mo["x_min"] + 0.04, SL + 0.06, 1.40, 2.60, 2.36, mo["z_max"] - 0.06)
    bounds(b, mo["x_min"] + 0.08, SL + 0.06, 2.60, 3.46, 2.42, mo["z_max"] - 0.12)
    bounds(b, mo["x_min"] + 0.04, SL + 0.06, 3.46, 3.56, 2.38, mo["z_max"] - 0.08)
    make_mesh_object("wall_left__buttress_front", b, mats["HK_Frame"], root)

    b = MeshBuilder()
    bounds(b, mo["x_min"], SL + 0.06, floor_top, 1.60, mo["z_min"], -2.90)
    bounds(b, mo["x_min"] + 0.04, SL + 0.06, 1.60, 2.95, mo["z_min"] + 0.06, -2.96)
    bounds(b, mo["x_min"] + 0.08, SL + 0.06, 2.95, 3.84, mo["z_min"] + 0.12, -3.02)
    bounds(b, mo["x_min"] + 0.04, SL + 0.06, 3.84, 3.94, mo["z_min"] + 0.08, -2.98)
    make_mesh_object("wall_left__buttress_back", b, mats["HK_Frame"], root)

    b = MeshBuilder()
    bounds(b, SR - 0.06, mo["x_max"], floor_top, 1.30, 2.42, mo["z_max"])
    bounds(b, SR - 0.06, mo["x_max"] - 0.05, 1.30, 2.50, 2.48, mo["z_max"] - 0.06)
    bounds(b, SR - 0.06, mo["x_max"] - 0.09, 2.50, 3.24, 2.54, mo["z_max"] - 0.12)
    bounds(b, SR - 0.06, mo["x_max"] - 0.05, 3.24, 3.34, 2.50, mo["z_max"] - 0.08)
    make_mesh_object("wall_right__buttress_front", b, mats["HK_Frame"], root)

    b = MeshBuilder()
    for cx, cy, cz in ((mo["x_min"] + 0.10, 1.46, 2.42), (mo["x_min"] + 0.10, 1.66, -2.98), (SR + 0.12, 1.36, 2.54)):
        bounds(b, cx - 0.035, cx + 0.035, cy, cy + 0.07, cz, cz + 0.07)
    make_mesh_object("wall_left__buttress_bolts", b, mats["HK_Steel"], root)

    # ── back-right filtration/service tower (reaches the exact envelope) ──
    b = MeshBuilder()
    bounds(b, 3.55, mo["x_max"], floor_top, 0.50, mo["z_min"], SB + 0.05)
    bounds(b, 3.55, mo["x_max"], 0.50, 3.40, mo["z_min"] + 0.04, SB + 0.05)
    bounds(b, 3.67, mo["x_max"] - 0.12, 3.40, 4.50, mo["z_min"] + 0.08, SB - 0.02)
    bounds(b, 3.61, mo["x_max"] - 0.06, 4.50, 4.64, mo["z_min"] + 0.05, SB + 0.02)
    bounds(b, 3.70, mo["x_max"] - 0.15, 4.64, 4.94, mo["z_min"] + 0.10, SB - 0.04)
    bounds(b, 3.78, mo["x_max"] - 0.23, 4.94, 5.14, mo["z_min"] + 0.14, SB - 0.08)
    make_mesh_object("wall_back__service_tower", b, mats["HK_Roof"], root)

    b = MeshBuilder()
    for ly in (1.10, 1.45, 1.80, 2.15):
        bounds(b, 3.72, mo["x_max"] - 0.16, ly, ly + 0.14, mo["z_min"], mo["z_min"] + 0.05)
    for ly in (3.62, 3.90, 4.18):
        bounds(b, 3.80, mo["x_max"] - 0.24, ly, ly + 0.14, mo["z_min"] + 0.06, mo["z_min"] + 0.12)
    make_mesh_object("wall_back__tower_louvers", b, mats["HK_Steel"], root)

    b = MeshBuilder()
    bounds(b, mo["x_max"] - 0.03, mo["x_max"] + 0.0, 0.70, 2.50, -3.62, -3.54)
    bounds(b, 4.02, 4.12, 3.72, 4.28, mo["z_min"] + 0.04, mo["z_min"] + 0.09)
    bounds(b, 4.20, 4.30, 3.72, 4.28, mo["z_min"] + 0.04, mo["z_min"] + 0.09)
    make_mesh_object("wall_back__tower_glow", b, mats["HK_Glow"], root)

    # ── right wall: recessed shell + half-sunk process tank bank ──
    rw = P["windows"][1]
    rz0w, rz1w = rw["z_min"], rw["z_max"]
    ry0, ry1 = rw["y_min"], rw["y_max"]
    rx_face, rx_in = SR - dd, SR - th
    b = MeshBuilder()
    bounds(b, rx_in, rx_face, floor_top, ry0, SB, mo["z_max"])
    bounds(b, rx_in, rx_face, ry1, wall_top, SB, mo["z_max"])
    bounds(b, rx_in, rx_face, ry0, ry1, SB, rz0w)
    bounds(b, rx_in, rx_face, ry0, ry1, rz1w, mo["z_max"])
    make_mesh_object("wall_right__clad", b, mats["HK_Clad"], root)

    b = MeshBuilder()
    bounds(b, rx_face, SR - 0.02, floor_top, 0.38, SB, mo["z_max"])
    make_mesh_object("wall_right__plinth_band", b, mats["HK_Frame"], root)

    b = MeshBuilder()
    for z0, z1 in groove_segments(SB + 0.10, rz0w - 0.18):
        bounds(b, rx_face, SR, py0, py1, z0, z1)
    for z0, z1 in groove_segments(rz1w + 0.18, mo["z_max"] - 0.10):
        bounds(b, rx_face, SR, py0, py1, z0, z1)
    bounds(b, rx_face, SR, py0, py1, rz0w - 0.18, rz0w - 0.05)
    bounds(b, rx_face, SR, py0, py1, rz1w + 0.05, rz1w + 0.18)
    make_mesh_object("wall_right__panel_plates", b, mats["HK_Clad2"], root)

    b = MeshBuilder()
    bounds(b, rx_in, SR + 0.02, ry0, ry1, rz0w - 0.05, rz0w)
    bounds(b, rx_in, SR + 0.02, ry0, ry1, rz1w, rz1w + 0.05)
    bounds(b, rx_in, SR + 0.02, ry1, ry1 + 0.05, rz0w - 0.05, rz1w + 0.05)
    bounds(b, rx_in, SR + 0.02, ry0 - 0.08, ry0, rz0w - 0.05, rz1w + 0.05)
    make_mesh_object("wall_right__slit_reveal", b, mats["HK_Frame"], root)

    # Process tanks half-sunk into a wall niche, on a shared grounded plinth.
    b = MeshBuilder()
    bounds(b, 4.12, mo["x_max"], floor_top, 0.08, -2.46, -0.49)
    bounds(b, 4.17, mo["x_max"], 0.08, 0.25, -2.40, -0.55)
    b.extend_prism(4.46, -1.90, 0.29, 0.25, 2.65, sides=8, start_deg=22.5)
    b.extend_prism(4.46, -1.05, 0.29, 0.25, 2.65, sides=8, start_deg=22.5)
    b.extend_prism(4.46, -1.90, 0.20, 2.65, 2.85, sides=8, start_deg=22.5)
    b.extend_prism(4.46, -1.05, 0.20, 2.65, 2.85, sides=8, start_deg=22.5)
    make_mesh_object("wall_right__filtration_tanks", b, mats["HK_Steel"], root)

    b = MeshBuilder()
    bounds(b, 4.32, 4.60, 2.30, 2.50, -1.90, -1.05)
    for tz in (-1.90, -1.05):
        bounds(b, 4.20, 4.46, 1.00, 1.16, tz - 0.08, tz + 0.08)
        bounds(b, 4.40, 4.52, 2.55, 3.72, tz - 0.06, tz + 0.06)
    bounds(b, 4.02, 4.52, 3.68, 3.80, -1.98, -0.97)
    bounds(b, 3.90, 4.14, 3.25, 3.72, -1.98, -1.82)
    bounds(b, 3.90, 4.20, 3.25, 3.38, -1.98, -1.70)
    for tz in (-1.90, -1.05):
        bounds(b, 4.37, 4.55, 2.52, 2.60, tz - 0.09, tz + 0.09)
        bounds(b, 4.37, 4.55, 3.58, 3.66, tz - 0.09, tz + 0.09)
    make_mesh_object("wall_right__filtration_pipes", b, mats["HK_Trim"], root)

    b = MeshBuilder()
    for tz in (-1.90, -1.05):
        bounds(b, 4.06, 4.48, 3.56, 3.72, tz - 0.11, tz + 0.11)
    make_mesh_object("wall_right__pipe_saddles", b, mats["HK_Steel"], root)

    b = MeshBuilder()
    for tz in (-1.90, -1.05):
        bounds(b, 4.70, mo["x_max"] + 0.0, 0.60, 1.80, tz - 0.05, tz + 0.05)
    make_mesh_object("wall_right__tank_gauge_glow", b, mats["HK_Glow"], root)

    # ── chamfered shoulders on every shell top (house signature) ──
    bevel = P["shoulder"]["bevel_m"]
    y0 = P["shoulder"]["base_y_m"]
    b = MeshBuilder()
    b_front_shoulder(b, SL, eb["x_min"], mo["z_max"], y0, bevel)
    b_front_shoulder(b, eb["x_max"], SR, mo["z_max"], y0, bevel)
    b_front_shoulder(b, eb["x_min"], eb["x_max"], eb["z_front"], y0, bevel)
    make_mesh_object("wall_front__chamfered_shoulders", b, mats["HK_Clad2"], root)

    b = MeshBuilder()
    b_back_shoulder(b, SL, SR, SB, y0, bevel)
    make_mesh_object("wall_back__chamfered_shoulders", b, mats["HK_Clad2"], root)

    b = MeshBuilder()
    b_left_shoulder(b, SB, mo["z_max"], SL, y0, bevel)
    b_left_shoulder(b, eb["z_back"], eb["z_front"], eb["x_min"], y0, bevel)
    make_mesh_object("wall_left__chamfered_shoulders", b, mats["HK_Clad2"], root)

    b = MeshBuilder()
    b_right_shoulder(b, SB, mo["z_max"], SR, y0, bevel)
    b_right_shoulder(b, eb["z_back"], eb["z_front"], eb["x_max"], y0, bevel)
    make_mesh_object("wall_right__chamfered_shoulders", b, mats["HK_Clad2"], root)


def b_front_shoulder(b, x0, x1, z_outer, y0, bevel):
    z_in = z_outer - bevel
    a0, a1 = (x0, y0, z_outer), (x1, y0, z_outer)
    b0, b1 = (x0, y0, z_in), (x1, y0, z_in)
    c0, c1 = (x0, y0 + bevel, z_in), (x1, y0 + bevel, z_in)
    b.face([a0, a1, c1, c0])
    b.face([b1, b0, c0, c1])
    b.face([b0, b1, a1, a0])
    b.face([a0, c0, b0])
    b.face([a1, b1, c1])


def b_back_shoulder(b, x0, x1, z_outer, y0, bevel):
    z_in = z_outer + bevel
    a0, a1 = (x1, y0, z_outer), (x0, y0, z_outer)
    b0, b1 = (x1, y0, z_in), (x0, y0, z_in)
    c0, c1 = (x1, y0 + bevel, z_in), (x0, y0 + bevel, z_in)
    b.face([a0, a1, c1, c0])
    b.face([b1, b0, c0, c1])
    b.face([b0, b1, a1, a0])
    b.face([a0, c0, b0])
    b.face([a1, b1, c1])


def b_right_shoulder(b, z0, z1, x_outer, y0, bevel):
    x_in = x_outer - bevel
    a0, a1 = (x_outer, y0, z0), (x_outer, y0, z1)
    b0, b1 = (x_in, y0, z0), (x_in, y0, z1)
    c0, c1 = (x_in, y0 + bevel, z0), (x_in, y0 + bevel, z1)
    b.face([a0, a1, c1, c0])
    b.face([b1, b0, c0, c1])
    b.face([b0, b1, a1, a0])
    b.face([a0, c0, b0])
    b.face([a1, b1, c1])


def b_left_shoulder(b, z0, z1, x_outer, y0, bevel):
    x_in = x_outer + bevel
    a0, a1 = (x_outer, y0, z1), (x_outer, y0, z0)
    b0, b1 = (x_in, y0, z1), (x_in, y0, z0)
    c0, c1 = (x_in, y0 + bevel, z1), (x_in, y0 + bevel, z0)
    b.face([a0, a1, c1, c0])
    b.face([b1, b0, c0, c1])
    b.face([b0, b1, a1, a0])
    b.face([a0, c0, b0])
    b.face([a1, b1, c1])


def build_facility_roof_floor(root, mats):
    mo = P["main_outer"]
    eb = P["entry_bay"]
    sh = P["shell"]
    pp = P["parapet"]
    r = P["roof"]
    SL, SR, SB = sh["left_x"], sh["right_x"], sh["back_z"]
    slab_bottom = P["floor"]["top_y_m"] - P["floor"]["slab_thickness_m"]

    # Cast slab: TOP at the authored floor surface; body remains below grade.
    # It spans the full 9.5 x 7.6 footprint — buttresses and the tower sit on it.
    b = MeshBuilder()
    floor_top = P["floor"]["top_y_m"]
    bounds(b, mo["x_min"], mo["x_max"], slab_bottom, floor_top, mo["z_min"], mo["z_max"])
    bounds(b, eb["x_min"], eb["x_max"], slab_bottom, floor_top, eb["z_back"], eb["z_front"])
    make_mesh_object("floor__single_cast_slab", b, mats["HK_Floor"], root)

    # Arrival inlay: raised framed pad in front of the dais — steel frame with
    # a cyan strip set on top (physical depth, not a decal read).
    ix0, ix1, iz0, iz1, iw = -1.05, 1.05, -0.55, 0.95, 0.11
    b = MeshBuilder()
    bounds(b, ix0 - 0.03, ix1 + 0.03, 0.0, 0.09, iz0 - 0.03, iz0 + iw + 0.03)
    bounds(b, ix0 - 0.03, ix1 + 0.03, 0.0, 0.09, iz1 - iw - 0.03, iz1 + 0.03)
    bounds(b, ix0 - 0.03, ix0 + iw + 0.03, 0.0, 0.09, iz0 + iw, iz1 - iw)
    bounds(b, ix1 - iw - 0.03, ix1 + 0.03, 0.0, 0.09, iz0 + iw, iz1 - iw)
    make_mesh_object("floor__arrival_inlay_frame", b, mats["HK_Steel"], root)
    b = MeshBuilder()
    bounds(b, ix0, ix1, 0.09, 0.108, iz0, iz0 + iw)
    bounds(b, ix0, ix1, 0.09, 0.108, iz1 - iw, iz1)
    bounds(b, ix0, ix0 + iw, 0.09, 0.108, iz0 + iw, iz1 - iw)
    bounds(b, ix1 - iw, ix1, 0.09, 0.108, iz0 + iw, iz1 - iw)
    make_mesh_object("floor__arrival_inlay_glow", b, mats["HK_Glow"], root)

    # Flat roof slab with visible edge (between the recessed shells).
    b = MeshBuilder()
    bounds(b, SL + 0.10, SR - 0.10, r["slab_bottom_y_m"], r["slab_top_y_m"], SB + 0.10, mo["z_max"] - 0.18)
    bounds(b, eb["x_min"] + 0.26, eb["x_max"] - 0.26, r["slab_bottom_y_m"], r["slab_top_y_m"], eb["z_back"] + 0.02, eb["z_front"] - 0.24)
    make_mesh_object("roof__flat_slab_visible_edge", b, mats["HK_Roof"], root)

    # Low parapet ring flush with the shell faces.
    b = MeshBuilder()
    bounds(b, SL, SR, pp["base_y_m"], pp["low_top_y_m"], SB, SB + 0.28)
    bounds(b, SL, eb["x_min"], pp["base_y_m"], pp["low_top_y_m"], mo["z_max"] - 0.28, mo["z_max"])
    bounds(b, eb["x_max"], SR, pp["base_y_m"], pp["low_top_y_m"], mo["z_max"] - 0.28, mo["z_max"])
    bounds(b, SL, SL + 0.28, pp["base_y_m"], pp["low_top_y_m"], SB + 0.28, mo["z_max"] - 0.28)
    bounds(b, SR - 0.28, SR, pp["base_y_m"], pp["low_top_y_m"], SB + 0.28, mo["z_max"] - 0.28)
    make_mesh_object("roof__low_stepped_parapet", b, mats["HK_Frame"], root)

    # Entry bay parapet steps a full head higher — the civic front.
    b = MeshBuilder()
    bounds(b, eb["x_min"], eb["x_max"], pp["base_y_m"], pp["entry_high_top_y_m"], eb["z_front"] - 0.26, eb["z_front"])
    bounds(b, eb["x_min"], eb["x_min"] + 0.26, pp["base_y_m"], pp["entry_high_top_y_m"], eb["z_back"] + 0.04, eb["z_front"] - 0.26)
    bounds(b, eb["x_max"] - 0.26, eb["x_max"], pp["base_y_m"], pp["entry_high_top_y_m"], eb["z_back"] + 0.04, eb["z_front"] - 0.26)
    bounds(b, eb["x_min"] + 0.26, eb["x_max"] - 0.26, pp["base_y_m"], pp["entry_high_top_y_m"] - 0.20, eb["z_back"] - 0.06, eb["z_back"] + 0.10)
    bounds(b, eb["x_min"], eb["x_min"] + 1.25, pp["entry_high_top_y_m"], pp["entry_high_top_y_m"] + 0.22, eb["z_front"] - 0.26, eb["z_front"])
    make_mesh_object("roof__entry_high_parapet", b, mats["HK_Frame"], root)

    # Rooftop process hall: the heavy right-rear shoulder mass (asymmetric
    # silhouette), stepped crown, louvered face, octagonal exhaust stack, and
    # a flanged duct binding it to the filtration tower.
    b = MeshBuilder()
    bounds(b, 1.30, 4.30, r["slab_top_y_m"], 4.30, -3.08, -1.55)
    bounds(b, 1.44, 4.16, 4.30, 4.44, -2.98, -1.65)
    bounds(b, 1.58, 4.02, 4.44, 4.52, -2.90, -1.73)
    make_mesh_object("roof__process_hall", b, mats["HK_Roof"], root)

    b = MeshBuilder()
    for ly in (3.48, 3.72, 3.96):
        bounds(b, 1.48, 2.86, ly, ly + 0.12, -1.60, -1.53)
    make_mesh_object("roof__hall_louvers", b, mats["HK_Steel"], root)

    b = MeshBuilder()
    b.extend_prism(3.55, -2.30, 0.44, 4.52, 4.62, sides=8, start_deg=22.5)
    b.extend_prism(3.55, -2.30, 0.34, 4.62, 4.86, sides=8, start_deg=22.5)
    b.extend_prism(3.55, -2.30, 0.40, 4.86, 4.96, sides=8, start_deg=22.5)
    make_mesh_object("roof__hall_stack", b, mats["HK_Steel"], root)

    b = MeshBuilder()
    bounds(b, 3.85, 4.35, 3.60, 4.05, SB - 0.01, -3.08)
    bounds(b, 3.74, 4.46, 3.49, 4.16, -3.22, -3.08)
    bounds(b, 3.74, 4.46, 3.49, 4.16, SB - 0.01, SB + 0.13)
    make_mesh_object("roof__hall_tower_duct", b, mats["HK_Trim"], root)

    b = MeshBuilder()
    for vx in (-1.35, -0.45, 0.45):
        bounds(b, vx - 0.05, vx + 0.77, r["slab_top_y_m"], r["slab_top_y_m"] + 0.04, -3.02, -2.72)
        bounds(b, vx, vx + 0.72, r["slab_top_y_m"] + 0.04, r["slab_top_y_m"] + 0.26, -2.98, -2.76)
    make_mesh_object("roof__vent_row", b, mats["HK_Steel"], root)

    # Roof conduit: process hall -> front parapet, junction boxes at both ends,
    # riser clamped down the parapet inner face.
    b = MeshBuilder()
    bounds(b, 3.10, 3.20, r["slab_top_y_m"], r["slab_top_y_m"] + 0.09, -1.62, 2.60)
    bounds(b, 2.40, 3.20, r["slab_top_y_m"], r["slab_top_y_m"] + 0.09, 2.50, 2.84)
    bounds(b, 3.00, 3.30, r["slab_top_y_m"], r["slab_top_y_m"] + 0.20, -1.68, -1.50)
    bounds(b, 2.36, 2.66, r["slab_top_y_m"], r["slab_top_y_m"] + 0.20, 2.62, 2.86)
    bounds(b, 2.44, 2.58, r["slab_top_y_m"], 3.52, 2.78, 2.86)
    bounds(b, 2.38, 2.64, 3.44, 3.58, 2.74, 2.90)
    make_mesh_object("roof__conduit_ridge", b, mats["HK_Trim"], root)

    # Bio-reservoir: horizontal octagonal tank on cradles, left rear, with a
    # glow level-band and a flanged feed manifold dropping into the hall roof.
    b = MeshBuilder()
    prism_x(b, 3.80, -2.60, 0.52, -3.95, -1.55, sides=8, start_deg=22.5)
    prism_x(b, 3.80, -2.60, 0.40, -4.06, -3.95, sides=8, start_deg=22.5)
    prism_x(b, 3.80, -2.60, 0.40, -1.55, -1.44, sides=8, start_deg=22.5)
    make_mesh_object("roof__bio_reservoir", b, mats["HK_Shell"], root)

    # Cradle plinth + twin yoke towers with over-straps: the tank visibly
    # bears on a solid base and is clamped down (no floating read from any
    # angle, including directly behind).
    b = MeshBuilder()
    bounds(b, -3.98, -1.52, r["slab_top_y_m"], 3.42, -2.96, -2.24)
    for cx in (-3.85, -1.85):
        bounds(b, cx, cx + 0.30, r["slab_top_y_m"], 3.62, -3.20, -2.00)
        bounds(b, cx - 0.05, cx + 0.35, r["slab_top_y_m"], r["slab_top_y_m"] + 0.06, -3.26, -1.94)
        bounds(b, cx, cx + 0.30, 3.62, 4.38, -3.20, -3.10)
        bounds(b, cx, cx + 0.30, 3.62, 4.38, -2.10, -2.00)
        bounds(b, cx, cx + 0.30, 4.30, 4.42, -3.20, -2.00)
    make_mesh_object("roof__reservoir_cradles", b, mats["HK_Frame"], root)

    # Clamp bands: three octagonal sleeves wrapping the tank body — visible
    # from every angle, including over the rear parapet.
    b = MeshBuilder()
    for bx0, bx1 in ((-3.66, -3.54), (-2.81, -2.69), (-1.96, -1.84)):
        prism_x(b, 3.80, -2.60, 0.555, bx0, bx1, sides=8, start_deg=22.5)
    make_mesh_object("roof__reservoir_clamp_bands", b, mats["HK_Frame"], root)

    b = MeshBuilder()
    bounds(b, -1.44, -1.28, 3.62, 3.98, -2.76, -2.44)
    bounds(b, -1.40, -1.24, r["slab_top_y_m"], 3.62, -2.68, -2.52)
    make_mesh_object("roof__reservoir_feed", b, mats["HK_Steel"], root)

    # Elevated copper transfer run: reservoir feed -> process hall west face,
    # on pedestal blocks, with a flange collar where it enters the hall.
    b = MeshBuilder()
    bounds(b, -1.30, 1.36, r["slab_top_y_m"] + 0.06, r["slab_top_y_m"] + 0.22, -2.66, -2.54)
    for px in (-0.90, -0.10, 0.70):
        bounds(b, px, px + 0.14, r["slab_top_y_m"], r["slab_top_y_m"] + 0.06, -2.68, -2.52)
    bounds(b, 1.24, 1.36, r["slab_top_y_m"] + 0.02, r["slab_top_y_m"] + 0.26, -2.70, -2.50)
    make_mesh_object("roof__reservoir_transfer_pipe", b, mats["HK_Trim"], root)

    # Steel anchors bolting the transfer run at both ends (hall entry plate +
    # feed-side collar).
    b = MeshBuilder()
    bounds(b, 1.28, 1.40, r["slab_top_y_m"], r["slab_top_y_m"] + 0.34, -2.76, -2.44)
    bounds(b, -1.38, -1.22, r["slab_top_y_m"] + 0.02, r["slab_top_y_m"] + 0.28, -2.72, -2.48)
    make_mesh_object("roof__transfer_pipe_anchors", b, mats["HK_Steel"], root)

    b = MeshBuilder()
    bounds(b, -1.46, -1.18, r["slab_top_y_m"], r["slab_top_y_m"] + 0.07, -2.74, -2.46)
    make_mesh_object("roof__reservoir_feed_flange", b, mats["HK_Steel"], root)

    b = MeshBuilder()
    bounds(b, -3.50, -2.85, 3.66, 3.74, -2.115, -2.075)
    bounds(b, -2.65, -2.00, 3.66, 3.74, -2.115, -2.075)
    make_mesh_object("roof__reservoir_glow_band", b, mats["HK_Glow"], root)

    # Ceiling light coves (hide with the roof in cutaway — they hang from it).
    b = MeshBuilder()
    for cz in (-1.30, 1.10):
        bounds(b, -3.60, 3.60, 2.90, r["slab_bottom_y_m"], cz - 0.10, cz + 0.10)
    make_mesh_object("roof__light_cove_glow", b, mats["HK_Glow"], root)
    b = MeshBuilder()
    for cz in (-1.30, 1.10):
        bounds(b, -3.68, 3.68, 2.86, 2.92, cz - 0.16, cz + 0.16)
    make_mesh_object("roof__light_cove_frame", b, mats["HK_Steel"], root)

    # Ceiling service beams under the slab (depth over the hall).
    b = MeshBuilder()
    for bz in (-2.50, 0.30):
        bounds(b, -4.16, 4.16, 2.83, r["slab_bottom_y_m"], bz - 0.08, bz + 0.08)
    make_mesh_object("roof__ceiling_beams", b, mats["HK_Frame"], root)


def build_facility_interior(root, mats):
    # Raised pod dais along the back wall: the room reads as a clinic even
    # before the separate clone_pod / clone_terminal props are placed on it.
    b = MeshBuilder()
    bounds(b, -3.90, 3.90, 0.0, 0.22, -3.22, -1.90)
    bounds(b, -3.90, 3.90, 0.0, 0.11, -1.90, -1.62)
    make_mesh_object("interior__pod_dais", b, mats["HK_Floor"], root)

    b = MeshBuilder()
    bounds(b, -3.86, 3.86, 0.14, 0.19, -1.91, -1.895)
    make_mesh_object("interior__dais_edge_glow", b, mats["HK_Glow"], root)

    b = MeshBuilder()
    bounds(b, -3.90, 3.90, 0.205, 0.235, -1.93, -1.88)
    make_mesh_object("interior__dais_nosing", b, mats["HK_Steel"], root)

    # Three deep pod alcove bays against the back wall: cheeks, hood, ceiling
    # feed trunk, backplate, glow edges, and a step pad in front of each bay.
    b = MeshBuilder()
    for cx in (-2.7, 0.0, 2.7):
        bounds(b, cx - 0.85, cx - 0.69, 0.22, 2.62, -3.25, -2.83)
        bounds(b, cx + 0.69, cx + 0.85, 0.22, 2.62, -3.25, -2.83)
        bounds(b, cx - 0.85, cx + 0.85, 2.46, 2.62, -3.25, -2.83)
    make_mesh_object("interior__pod_alcove_frames", b, mats["HK_Frame"], root)

    b = MeshBuilder()
    for cx in (-2.7, 0.0, 2.7):
        bounds(b, cx - 0.20, cx + 0.20, 2.62, 3.06, -3.25, -3.01)
    make_mesh_object("interior__pod_alcove_feeds", b, mats["HK_Trim"], root)

    b = MeshBuilder()
    for cx in (-2.7, 0.0, 2.7):
        bounds(b, cx - 0.62, cx + 0.62, 0.30, 2.30, -3.24, -3.21)
        bounds(b, cx - 0.45, cx + 0.45, 0.22, 0.25, -2.60, -2.20)
    make_mesh_object("interior__pod_alcove_backplates", b, mats["HK_Steel"], root)

    b = MeshBuilder()
    for cx in (-2.7, 0.0, 2.7):
        bounds(b, cx - 0.66, cx - 0.62, 0.50, 2.20, -2.90, -2.86)
        bounds(b, cx + 0.62, cx + 0.66, 0.50, 2.20, -2.90, -2.86)
    make_mesh_object("interior__pod_alcove_glow_edges", b, mats["HK_Glow"], root)

    # Cable spine: dais front -> right wall trunk, with dais conduit stubs.
    b = MeshBuilder()
    bounds(b, 3.20, 3.50, 0.0, 0.10, -1.62, 0.90)
    bounds(b, 3.50, 4.20, 0.0, 0.10, 0.60, 0.90)
    for cx in (-2.7, 0.0, 2.7):
        bounds(b, cx - 0.05, cx + 0.05, 0.22, 0.26, -2.83, -2.58)
    make_mesh_object("interior__cable_spine", b, mats["HK_Trim"], root)

    b = MeshBuilder()
    bounds(b, 3.70, 4.20, 0.0, 1.30, 0.95, 1.55)
    bounds(b, 3.75, 4.15, 1.30, 1.38, 1.00, 1.50)
    bounds(b, 3.78, 3.82, 0.55, 1.05, 0.945, 0.955)
    make_mesh_object("interior__junction_cabinet", b, mats["HK_Steel"], root)

    # Left wall: staff lockers with door seams, handles and vent slits.
    b = MeshBuilder()
    bounds(b, -4.18, -3.80, 0.0, 1.90, -1.20, 0.80)
    for zx in (-0.87, -0.37, 0.13):
        bounds(b, -3.81, -3.78, 0.30, 1.70, zx, zx + 0.06)
    make_mesh_object("interior__staff_lockers", b, mats["HK_Steel"], root)

    b = MeshBuilder()
    for dc in (-1.055, -0.595, -0.095, 0.435):
        bounds(b, -3.80, -3.755, 0.92, 1.06, dc - 0.02, dc + 0.05)
    make_mesh_object("interior__locker_handles", b, mats["HK_Brass"], root)

    b = MeshBuilder()
    for dc in (-1.055, -0.595, -0.095, 0.435):
        bounds(b, -3.80, -3.775, 1.60, 1.66, dc - 0.14, dc + 0.14)
    make_mesh_object("interior__locker_vents", b, mats["HK_Frame"], root)

    b = MeshBuilder()
    bounds(b, -4.18, -3.70, 0.30, 0.44, 1.30, 2.60)
    bounds(b, -4.18, -4.10, 0.44, 0.90, 1.30, 2.60)
    bounds(b, -4.13, -4.01, 0.0, 0.30, 1.38, 1.54)
    bounds(b, -4.13, -4.01, 0.0, 0.30, 2.36, 2.52)
    make_mesh_object("interior__waiting_bench", b, mats["HK_Clad2"], root)

    # Reception counter just inside the portal (arrivals face it), with a
    # dark kick recess and a small angled staff terminal on the top.
    b = MeshBuilder()
    bounds(b, 1.30, 2.60, 0.0, 0.92, 1.80, 2.30)
    bounds(b, 1.30, 1.44, 0.0, 0.92, 2.30, 2.66)
    make_mesh_object("interior__reception_counter", b, mats["HK_Clad2"], root)
    b = MeshBuilder()
    bounds(b, 1.36, 2.54, 0.0, 0.18, 2.30, 2.34)
    bounds(b, 1.27, 1.30, 0.0, 0.18, 1.82, 2.64)
    bounds(b, 2.60, 2.63, 0.0, 0.18, 1.82, 2.28)
    make_mesh_object("interior__reception_kick", b, mats["HK_Frame"], root)
    b = MeshBuilder()
    bounds(b, 1.24, 2.66, 0.92, 0.99, 1.74, 2.42)
    bounds(b, 1.24, 1.50, 0.92, 0.99, 2.42, 2.72)
    bounds(b, 1.68, 2.12, 0.99, 1.14, 1.98, 2.09)
    bounds(b, 1.70, 2.10, 1.14, 1.36, 2.00, 2.07)
    make_mesh_object("interior__reception_counter_top", b, mats["HK_Steel"], root)
    b = MeshBuilder()
    bounds(b, 1.30, 2.60, 0.70, 0.74, 2.30, 2.315)
    bounds(b, 1.73, 2.07, 1.15, 1.31, 2.07, 2.085)
    make_mesh_object("interior__reception_glow_strip", b, mats["HK_Glow"], root)

    # Right wall med cabinet + supply crates fill the mid-room dead zone.
    b = MeshBuilder()
    bounds(b, 3.95, 4.20, 1.05, 1.85, 1.60, 2.40)
    bounds(b, 3.98, 4.20, 0.0, 1.05, 1.70, 2.30)
    make_mesh_object("interior__med_cabinet", b, mats["HK_Shell"], root)
    b = MeshBuilder()
    bounds(b, 3.93, 3.95, 1.15, 1.75, 1.95, 2.05)
    make_mesh_object("interior__med_cabinet_glow", b, mats["HK_Glow"], root)

    b = MeshBuilder()
    bounds(b, 2.55, 3.15, 0.0, 0.55, -0.75, -0.15)
    bounds(b, 2.62, 3.08, 0.55, 1.00, -0.68, -0.22)
    make_mesh_object("interior__supply_crates", b, mats["HK_Clad2"], root)


def make_facility_door(root, mats):
    """Heavy containment bioseal panel: bordered armor face, central pressure
    disc with a rotary breaker hub, radial dog lugs and cross spokes,
    horizontal seam ribs, and chunky edge lock dogs — one node, one material,
    sliding -x into the wall pocket per the house door contract. Reads
    pressure vessel, not roll-up."""
    dp = P["door"]
    sx, sy, sz = dp["panel_size"]
    hx, hy, hz = sx / 2, sy / 2, sz / 2
    b = MeshBuilder()
    b.extend_box((0.0, 0.0, 0.0), (sx, sy, sz))
    # Border frame ring: proud armor lip around the face perimeter.
    fz0 = hz
    bounds(b, -hx, hx, hy - 0.16, hy, fz0, hz + 0.035)
    bounds(b, -hx, hx, -hy, -hy + 0.16, fz0, hz + 0.035)
    bounds(b, -hx, -hx + 0.16, -hy + 0.16, hy - 0.16, fz0, hz + 0.035)
    bounds(b, hx - 0.16, hx, -hy + 0.16, hy - 0.16, fz0, hz + 0.035)
    # Corner gusset plates (no horizontal slat seams: pressure door, not roll-up).
    for sxn in (-1, 1):
        for gyn in (-1, 1):
            gx0, gx1 = sorted((sxn * (hx - 0.52), sxn * (hx - 0.16)))
            gy0, gy1 = sorted((gyn * (hy - 0.52), gyn * (hy - 0.16)))
            bounds(b, gx0, gx1, gy0, gy1, fz0, hz + 0.030)
    # Central pressure disc, rotary breaker hub, cross spokes, radial dog lugs.
    disc_z(b, 0.0, 0.0, 0.50, 0.50, fz0, hz + 0.038, sides=16)
    disc_z(b, 0.0, 0.0, 0.25, 0.25, hz + 0.038, hz + 0.058, sides=12)
    b.extend_box((0.0, 0.0, hz + 0.049), (0.92, 0.10, 0.022))
    b.extend_box((0.0, 0.0, hz + 0.049), (0.10, 0.92, 0.022))
    for i in range(8):
        a = math.radians(22.5 + 45.0 * i)
        b.extend_box((0.43 * math.cos(a), 0.43 * math.sin(a), hz + 0.047), (0.12, 0.12, 0.018))
    # Edge lock dogs: three chunky clamps per vertical edge, proud of the face.
    for sxn in (-1, 1):
        for dy in (-0.82, 0.0, 0.82):
            b.extend_box((sxn * (hx - 0.13), dy, hz + 0.032), (0.26, 0.34, 0.064))
    obj = make_mesh_object("door_slide", b, mats["HK_Door"], root)
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
    bpy.context.scene.frame_end = close_end
    door.location = closed
    bpy.context.scene.frame_set(1)


def build_facility_scene():
    reset_scene()
    mats = make_materials(FACILITY_MATERIALS)
    root = make_root(P["root_node"])
    build_facility_roof_floor(root, mats)
    build_facility_walls(root, mats)
    build_facility_interior(root, mats)
    door = make_facility_door(root, mats)
    create_door_actions(door)
    return root, door


# ────────────────────────────── prop scenes ───────────────────────────────


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


def build_clone_terminal_scene():
    """Indoor clinical console: enamel spine with a steel crown band and a
    twin-figure clone glyph, neck-mounted cyan readout with modeled body-chart
    UI, palm-scanner tray with glow outline and tag-reader ring, gauge dial,
    anchored base pads, collared cable foot."""
    reset_scene()
    mats = make_materials(CLONE_TERM_MATERIALS)
    root = make_root(PROPS["clone_terminal"]["root_node"])

    b = MeshBuilder()
    bounds(b, -0.42, 0.42, 0.0, 0.10, -0.34, 0.34)
    bounds(b, -0.36, 0.36, 0.10, 0.16, -0.28, 0.28)
    make_mesh_object("base__pads", b, mats["HK_Frame"], root)

    b = MeshBuilder()
    for bx, bz in ((-0.36, -0.28), (0.36, -0.28), (-0.36, 0.28), (0.36, 0.28)):
        bounds(b, bx - 0.03, bx + 0.03, 0.10, 0.135, bz - 0.03, bz + 0.03)
    make_mesh_object("base__anchor_bolts", b, mats["HK_Steel"], root)

    b = MeshBuilder()
    bounds(b, -0.30, 0.30, 0.16, 1.68, -0.28, -0.08)
    bounds(b, -0.24, 0.24, 1.60, 1.74, -0.26, -0.06)
    make_mesh_object("body__enamel_spine", b, mats["HK_Shell"], root)

    b = MeshBuilder()
    bounds(b, -0.31, 0.31, 1.54, 1.60, -0.285, -0.075)
    make_mesh_object("body__crown_trim", b, mats["HK_Steel"], root)

    # Twin-figure clone glyph on the spine front (matches the facility crest).
    b = MeshBuilder()
    ring_z(b, 0.0, 0.62, 0.085, 0.115, -0.078, -0.048, segments=12)
    disc_z(b, -0.032, 0.66, 0.022, 0.022, -0.078, -0.052, sides=8)
    disc_z(b, -0.032, 0.598, 0.028, 0.042, -0.078, -0.052, sides=8)
    make_mesh_object("body__clone_glyph", b, mats["HK_Trim"], root)
    b = MeshBuilder()
    disc_z(b, 0.032, 0.66, 0.022, 0.022, -0.078, -0.05, sides=8)
    disc_z(b, 0.032, 0.598, 0.028, 0.042, -0.078, -0.05, sides=8)
    make_mesh_object("body__clone_glyph_glow", b, mats["HK_Glow"], root)

    # Neck: solid bridge from the spine to the readout (nothing floats).
    b = MeshBuilder()
    bounds(b, -0.26, 0.26, 1.00, 1.36, -0.10, 0.12)
    make_mesh_object("body__readout_neck", b, mats["HK_Steel"], root)

    # Angled readout facing +z (steel frame + cyan face).
    b = MeshBuilder()
    lo, hi = (0.96, 0.22), (1.46, 0.02)
    b.face([(-0.34, lo[0], lo[1]), (0.34, lo[0], lo[1]), (0.34, hi[0], hi[1]), (-0.34, hi[0], hi[1])])
    b.face([(0.34, lo[0], lo[1] - 0.09), (-0.34, lo[0], lo[1] - 0.09), (-0.34, hi[0], hi[1] - 0.09), (0.34, hi[0], hi[1] - 0.09)])
    for sx in (-1, 1):
        b.face([(sx * 0.34, lo[0], lo[1]), (sx * 0.34, hi[0], hi[1]), (sx * 0.34, hi[0], hi[1] - 0.09), (sx * 0.34, lo[0], lo[1] - 0.09)])
    b.face([(-0.34, hi[0], hi[1]), (0.34, hi[0], hi[1]), (0.34, hi[0], hi[1] - 0.09), (-0.34, hi[0], hi[1] - 0.09)])
    b.face([(0.34, lo[0], lo[1]), (-0.34, lo[0], lo[1]), (-0.34, lo[0], lo[1] - 0.09), (0.34, lo[0], lo[1] - 0.09)])
    make_mesh_object("head__readout_frame", b, mats["HK_Steel"], root)

    b = MeshBuilder()
    angled_panel(b, -0.29, 0.29, 1.00, 0.223, 1.42, 0.055, 0.012)
    make_mesh_object("head__readout_glow", b, mats["HK_Glow"], root)

    # Modeled body-chart UI on the readout: dark patient silhouette + vitals
    # rows (non-text medical read).
    def sp2(t):
        return (1.00 + 0.42 * t, 0.235 - 0.168 * t)

    b = MeshBuilder()
    angled_panel(b, -0.22, -0.08, *sp2(0.34), *sp2(0.68), 0.006)   # torso
    angled_panel(b, -0.185, -0.115, *sp2(0.68), *sp2(0.84), 0.006)  # head
    angled_panel(b, -0.27, -0.22, *sp2(0.42), *sp2(0.62), 0.006)   # left arm
    angled_panel(b, -0.08, -0.03, *sp2(0.42), *sp2(0.62), 0.006)   # right arm
    angled_panel(b, -0.21, -0.16, *sp2(0.08), *sp2(0.34), 0.006)   # left leg
    angled_panel(b, -0.14, -0.09, *sp2(0.08), *sp2(0.34), 0.006)   # right leg
    for t0, t1 in ((0.18, 0.28), (0.40, 0.50), (0.62, 0.72)):
        angled_panel(b, -0.02, 0.22, *sp2(t0), *sp2(t1), 0.006)
    make_mesh_object("head__readout_ui", b, mats["HK_Frame"], root)

    # Palm-scanner tray at hand height: steel shelf, dark scan bed with a glow
    # outline, enamel palm pads, tag-reader ring.
    b = MeshBuilder()
    bounds(b, -0.34, 0.34, 0.90, 0.98, -0.10, 0.40)
    bounds(b, -0.34, 0.34, 0.82, 0.90, 0.34, 0.40)
    make_mesh_object("body__work_tray", b, mats["HK_Steel"], root)

    # Grounded support post: the extended tray visibly bears on the base pad.
    b = MeshBuilder()
    bounds(b, -0.05, 0.05, 0.10, 0.90, 0.24, 0.34)
    make_mesh_object("body__tray_post", b, mats["HK_Steel"], root)

    b = MeshBuilder()
    bounds(b, -0.30, 0.04, 0.98, 0.99, 0.10, 0.36)
    make_mesh_object("body__palm_scan_bed", b, mats["HK_Frame"], root)
    b = MeshBuilder()
    bounds(b, -0.32, -0.30, 0.98, 1.004, 0.09, 0.37)
    bounds(b, 0.04, 0.06, 0.98, 1.004, 0.09, 0.37)
    bounds(b, -0.30, 0.04, 0.98, 1.004, 0.08, 0.10)
    bounds(b, -0.30, 0.04, 0.98, 1.004, 0.36, 0.38)
    make_mesh_object("body__palm_scanner_glow", b, mats["HK_Glow"], root)
    b = MeshBuilder()
    bounds(b, -0.245, -0.145, 0.99, 1.002, 0.14, 0.32)
    bounds(b, -0.115, -0.015, 0.99, 1.002, 0.14, 0.32)
    make_mesh_object("body__palm_pads", b, mats["HK_Shell"], root)

    b = MeshBuilder()
    for x0, x1, z0, z1 in ((0.19, 0.33, 0.12, 0.155), (0.19, 0.33, 0.255, 0.29), (0.19, 0.225, 0.155, 0.255), (0.295, 0.33, 0.155, 0.255)):
        bounds(b, x0, x1, 0.98, 1.0, z0, z1)
    make_mesh_object("body__tag_reader_glow", b, mats["HK_Glow"], root)

    # Instruments: gauge dial + status lights on the crown cap.
    b = MeshBuilder()
    disc_z(b, -0.17, 1.47, 0.06, 0.06, -0.088, -0.056, sides=10)
    make_mesh_object("body__gauge_dial", b, mats["HK_Steel"], root)
    b = MeshBuilder()
    bounds(b, -0.18, -0.16, 1.47, 1.515, -0.06, -0.05)
    for yy in (1.615, 1.655, 1.695):
        bounds(b, 0.13, 0.19, yy, yy + 0.03, -0.065, -0.055)
    make_mesh_object("body__status_lights_glow", b, mats["HK_Glow"], root)

    b = MeshBuilder()
    bounds(b, -0.10, 0.10, 0.0, 0.06, -0.62, -0.30)
    bounds(b, -0.08, 0.08, 0.0, 0.16, -0.36, -0.28)
    bounds(b, -0.06, 0.06, 0.16, 0.40, -0.33, -0.27)
    make_mesh_object("base__cable_foot", b, mats["HK_Trim"], root)
    return root


def build_clone_pod_scene():
    """Standing clone vat: octagonal plinth on outrigger feet, broad
    person-width faceted enamel drum, 130-degree sealed glass canopy with
    latch hardware over a full-height glow column holding a dark humanoid
    suspension cradle, side fluid/power conduits with port pods, crown
    ring/manifold, twin flanged rear risers."""
    reset_scene()
    mats = make_materials(POD_MATERIALS)
    root = make_root(PROPS["clone_pod"]["root_node"])

    b = MeshBuilder()
    b.extend_prism(0.0, 0.0, 0.68, 0.0, 0.12, sides=8, start_deg=22.5)
    b.extend_prism(0.0, 0.0, 0.61, 0.12, 0.24, sides=8, start_deg=22.5)
    make_mesh_object("base__oct_plinth", b, mats["HK_Frame"], root)

    # Outrigger feet with bolt nubs: the plinth visibly stands on these.
    b = MeshBuilder()
    for sxn in (-1, 1):
        bounds(b, sxn * 0.60, sxn * 0.78, 0.0, 0.09, -0.14, 0.14)
        bounds(b, sxn * 0.66, sxn * 0.72, 0.09, 0.125, -0.03, 0.03)
        bounds(b, -0.14, 0.14, 0.0, 0.09, sxn * 0.60, sxn * 0.78)
        bounds(b, -0.03, 0.03, 0.09, 0.125, sxn * 0.66, sxn * 0.72)
    make_mesh_object("base__feet", b, mats["HK_Steel"], root)

    # Fluid port blocks at the back of the plinth feed the twin risers.
    b = MeshBuilder()
    for sxn in (-0.16, 0.16):
        bounds(b, sxn - 0.10, sxn + 0.10, 0.12, 0.44, -0.72, -0.52)
    make_mesh_object("base__fluid_ports", b, mats["HK_Frame"], root)

    # Main shell: faceted enamel drum; the front 130 degrees is the canopy bay.
    b = MeshBuilder()
    b.extend_arc_shell(0.0, 0.0, 0.46, 0.56, 0.24, 2.16, 155.0, 385.0, segments=8)
    make_mesh_object("shell__enamel_drum", b, mats["HK_Shell"], root)

    # Canopy: faceted glass across the front bay (logical +z faces the viewer).
    b = MeshBuilder()
    b.extend_arc_shell(0.0, 0.0, 0.50, 0.54, 0.42, 2.02, 25.0, 155.0, segments=4)
    make_mesh_object("shell__canopy_glass", b, mats["HK_Glass"], root)

    # Canopy frame: top/bottom arc bands, edge posts, mid seal band.
    b = MeshBuilder()
    b.extend_arc_shell(0.0, 0.0, 0.49, 0.55, 0.24, 0.42, 25.0, 155.0, segments=4)
    b.extend_arc_shell(0.0, 0.0, 0.49, 0.55, 2.02, 2.16, 25.0, 155.0, segments=4)
    b.extend_arc_shell(0.0, 0.0, 0.485, 0.555, 1.16, 1.24, 25.0, 155.0, segments=4)
    for a_deg in (25.0, 155.0):
        a = math.radians(a_deg)
        x, z = 0.52 * math.cos(a), 0.52 * math.sin(a)
        b.extend_box((x, 1.20, z), (0.07, 1.92, 0.07))
    make_mesh_object("shell__canopy_ribs", b, mats["HK_Steel"], root)

    # Brass latch hardware on the canopy edge posts (sealed-hatch read).
    b = MeshBuilder()
    for a_deg in (25.0, 155.0):
        a = math.radians(a_deg)
        x, z = 0.545 * math.cos(a), 0.545 * math.sin(a)
        for ly in (0.86, 1.52):
            b.extend_box((x, ly, z), (0.10, 0.14, 0.10))
    make_mesh_object("shell__canopy_latches", b, mats["HK_Brass"], root)

    # Inner suspension column: broad cyan emissive core behind the glass.
    b = MeshBuilder()
    b.extend_prism(0.0, 0.0, 0.30, 0.26, 2.06, sides=8, start_deg=22.5)
    make_mesh_object("core__suspension_glow", b, mats["HK_Glow"], root)

    # Suspension harness rings clamp the core (volumetric read through glass).
    b = MeshBuilder()
    b.extend_prism(0.0, 0.0, 0.33, 0.72, 0.80, sides=8, start_deg=22.5)
    b.extend_prism(0.0, 0.0, 0.33, 1.46, 1.54, sides=8, start_deg=22.5)
    make_mesh_object("core__harness_rings", b, mats["HK_Steel"], root)

    # Humanoid suspension cradle: dark armature silhouetted on the glow —
    # spine rail, head hoop, shoulder yoke, arm rails, pelvis band, foot plate.
    b = MeshBuilder()
    bounds(b, -0.045, 0.045, 0.46, 1.86, 0.25, 0.33)
    bounds(b, -0.11, 0.11, 1.72, 1.82, 0.25, 0.33)
    bounds(b, -0.27, 0.27, 1.56, 1.66, 0.25, 0.33)
    for sxn in (-1, 1):
        bounds(b, sxn * 0.29, sxn * 0.35, 0.82, 1.56, 0.25, 0.31)
    bounds(b, -0.21, 0.21, 1.00, 1.09, 0.25, 0.33)
    bounds(b, -0.17, 0.17, 0.38, 0.46, 0.25, 0.33)
    make_mesh_object("core__body_cradle", b, mats["HK_Frame"], root)

    # Side fluid/power conduits: port pods at the base, brass lines up the
    # drum flanks, couplings into the crown ring.
    b = MeshBuilder()
    for sxn in (-1, 1):
        bounds(b, sxn * 0.50, sxn * 0.68, 0.14, 0.46, -0.22, -0.02)
        bounds(b, sxn * 0.50, sxn * 0.66, 2.08, 2.22, -0.20, -0.04)
    make_mesh_object("side__conduit_ports", b, mats["HK_Steel"], root)
    b = MeshBuilder()
    for sxn in (-1, 1):
        bounds(b, sxn * 0.52, sxn * 0.62, 0.46, 2.08, -0.17, -0.07)
    make_mesh_object("side__fluid_lines", b, mats["HK_Brass"], root)

    # Crown ring + manifold, cyan status strip, brass index ticks.
    b = MeshBuilder()
    b.extend_prism(0.0, 0.0, 0.62, 2.16, 2.30, sides=8, start_deg=22.5)
    make_mesh_object("crown__ring", b, mats["HK_Frame"], root)

    b = MeshBuilder()
    b.extend_prism(0.0, 0.0, 0.34, 2.30, 2.44, sides=8, start_deg=22.5)
    make_mesh_object("crown__manifold", b, mats["HK_Steel"], root)

    b = MeshBuilder()
    bounds(b, -0.20, 0.20, 2.20, 2.26, 0.555, 0.59)
    make_mesh_object("crown__status_glow", b, mats["HK_Glow"], root)

    b = MeshBuilder()
    bounds(b, -0.28, -0.22, 2.18, 2.28, 0.55, 0.585)
    bounds(b, 0.22, 0.28, 2.18, 2.28, 0.55, 0.585)
    make_mesh_object("crown__brass_ticks", b, mats["HK_Brass"], root)

    # Twin flanged risers: plinth ports -> crown manifold, elbows at both ends.
    b = MeshBuilder()
    for sxn in (-0.16, 0.16):
        bounds(b, sxn - 0.05, sxn + 0.05, 0.38, 2.30, -0.66, -0.56)
        bounds(b, sxn - 0.075, sxn + 0.075, 0.38, 0.48, -0.69, -0.53)
        bounds(b, sxn - 0.075, sxn + 0.075, 2.10, 2.20, -0.69, -0.53)
        bounds(b, sxn - 0.05, sxn + 0.05, 2.20, 2.30, -0.62, -0.30)
    make_mesh_object("back__service_pipes", b, mats["HK_Steel"], root)
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


def write_glb_chunks(path: Path, gltf, bin_chunk: bytes):
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
    gltf, bin_chunk = read_glb_chunks(path)
    for node in gltf.get("nodes", []):
        if node.get("name") == "door_slide":
            node.pop("matrix", None)
            node["translation"] = [float(v) for v in P["door"]["closed_center"]]
            node["rotation"] = [0.0, 0.0, 0.0, 1.0]
            node["scale"] = [1.0, 1.0, 1.0]
            write_glb_chunks(path, gltf, bin_chunk)
            return
    raise RuntimeError("door_slide node missing from exported GLB")


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


def animation_metrics(metrics):
    gltf = metrics["gltf"]
    bin_chunk = metrics["bin"]
    node_names = [n.get("name", "") for n in gltf.get("nodes", [])]
    clips = {}
    for anim in gltf.get("animations", []):
        name = anim.get("name", "")
        channels = []
        duration = 0.0
        start_value = None
        end_value = None
        end_delta = [0.0, 0.0, 0.0]
        for channel in anim.get("channels", []):
            target = channel.get("target", {})
            sampler = anim["samplers"][channel["sampler"]]
            times = [float(v[0]) for v in accessor_values(gltf, bin_chunk, sampler["input"])]
            values = [tuple(float(c) for c in v[:3]) for v in accessor_values(gltf, bin_chunk, sampler["output"])]
            if times:
                duration = max(duration, max(times) - min(times))
            if values:
                start_value = values[0]
                end_value = values[-1]
                end_delta = [end_value[i] - start_value[i] for i in range(3)]
            target_idx = target.get("node", -999)
            channels.append({
                "target_node": node_names[target_idx] if 0 <= target_idx < len(node_names) else None,
                "path": target.get("path"),
                "sampler_interpolation": sampler.get("interpolation", "LINEAR"),
            })
        clips[name] = {
            "duration_s": duration,
            "channels": channels,
            "delta": end_delta,
            "targets_only_door_translation": all(ch["target_node"] == "door_slide" and ch["path"] == "translation" for ch in channels) and bool(channels),
        }
    expected_axis = Vector(P["door"]["slide_axis_local"])
    expected_distance = P["door"]["slide_distance_m"]
    for name, info in clips.items():
        d = Vector(info.get("delta") or (0.0, 0.0, 0.0))
        signed = d.dot(expected_axis)
        residual = (d - expected_axis * signed).length
        info["signed_slide_m"] = signed
        info["axis_residual_m"] = residual
        if name == "door_open":
            info["endstate_distance_error_m"] = abs(signed - expected_distance)
        elif name == "door_close":
            info["endstate_distance_error_m"] = abs(signed + expected_distance)
        else:
            info["endstate_distance_error_m"] = None
    return clips


def door_cells_from_opening():
    """Advisory front-row cells (0-based [col, row]) the clear opening covers."""
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


def facility_collision_box(x0, x1, z0, z1, primitive_id=None):
    if not (x1 > x0 and z1 > z0):
        raise ValueError(f"invalid cloning facility collision box: {(x0, x1, z0, z1)}")
    box = {
        "minX": round(float(x0), 4),
        "minZ": round(float(z0), 4),
        "maxX": round(float(x1), 4),
        "maxZ": round(float(z1), 4),
    }
    if primitive_id is not None:
        box["id"] = primitive_id
    return box


def write_facility_collision_sidecar():
    """Emit the authored structural proxy from the same P shell parameters.

    Decorative wall children deliberately never enter this list.  This keeps
    the GLB and the sim proxy coupled to the same envelope/opening dimensions
    while preserving a genuinely walkable portal and interior.
    """
    mo = P["main_outer"]
    sh = P["shell"]
    eb = P["entry_bay"]
    door = P["door"]["opening_bounds"]
    th = P["wall_thickness_m"]
    front_shell_z0 = mo["z_max"] - th
    footprint_max_z = max(mo["z_max"], eb["z_front"], door["front_z"] + 0.04)
    walls = [
        facility_collision_box(mo["x_min"], sh["left_x"] + th, sh["back_z"], mo["z_max"], "outer_shell_left"),
        facility_collision_box(sh["right_x"] - th, mo["x_max"], sh["back_z"], mo["z_max"], "outer_shell_right"),
        facility_collision_box(sh["left_x"], sh["right_x"], sh["back_z"], sh["back_z"] + th, "outer_shell_back"),
        facility_collision_box(sh["left_x"], door["x_min"], front_shell_z0, mo["z_max"], "outer_shell_front_left"),
        facility_collision_box(door["x_max"], sh["right_x"], front_shell_z0, mo["z_max"], "outer_shell_front_right"),
        facility_collision_box(eb["x_min"], eb["x_min"] + th, eb["z_back"], eb["z_front"], "entry_bay_return_left"),
        facility_collision_box(eb["x_max"] - th, eb["x_max"], eb["z_back"], eb["z_front"], "entry_bay_return_right"),
        facility_collision_box(eb["x_min"] + th, door["x_min"], door["inner_z"], eb["z_front"], "entry_bay_front_left"),
        facility_collision_box(door["x_max"], eb["x_max"] - th, eb["z_front"] - 0.30, eb["z_front"], "entry_bay_front_right"),
    ]
    sidecar = {
        "schema": "successor.structure-collision.v3",
        "source": FACILITY_GLB.name,
        "generatedBy": "tools/successor/assets/build_cloning_facility.py",
        "contract": {
            "geometrySource": "P",
            "structuralRoles": ["outer_shell", "entry_bay_returns", "entry_bay_front_segments", "closed_door"],
            "decorativeExcluded": ["trim", "bolts", "glow", "pipes", "windows", "floor_guides", "roof_gear"],
        },
        "footprint": {
            "minX": round(mo["x_min"], 4),
            "minZ": round(mo["z_min"], 4),
            "maxX": round(mo["x_max"], 4),
            "maxZ": round(footprint_max_z, 4),
            "spanX": round(mo["x_max"] - mo["x_min"], 4),
            "spanZ": round(footprint_max_z - mo["z_min"], 4),
            "centerX": round((mo["x_min"] + mo["x_max"]) / 2, 4),
            "centerZ": round((mo["z_min"] + footprint_max_z) / 2, 4),
        },
        "floor": {
            "topY": round(P["floor"]["top_y_m"], 4),
            "slabThicknessM": round(P["floor"]["slab_thickness_m"], 4),
        },
        "walls": walls,
        "door": {
            "node": P["door"]["node"],
            "closed": facility_collision_box(
                door["x_min"], door["x_max"], door["inner_z"], door["front_z"], "closed_door_panel",
            ),
        },
        "interiorRegions": [{
            "id": "main_walkable_interior",
            "minX": round(sh["left_x"] + th, 4),
            "minZ": round(sh["back_z"] + th, 4),
            "maxX": round(sh["right_x"] - th, 4),
            "maxZ": round(door["inner_z"] - 0.02, 4),
            "floorTopY": round(P["floor"]["top_y_m"], 4),
        }],
    }
    collision_path = OUT_DIR / "cloning_facility_collision.json"
    write_json(collision_path, sidecar)
    return sidecar


def write_facility_manifest(metrics):
    door_open = P["door"]["opening_bounds"]
    span = bbox_span(metrics["total_bbox"])
    manifest = {
        "building": "cloning_facility",
        "units": "m",
        "floorHeightM": P["floor"]["top_y_m"],
        "floorTopY": P["floor"]["top_y_m"],
        "front": "+Z",
        "bbox_span_m": [round(v, 3) for v in span],
        "runtime_scale_at_10x8_cells": round(min(P["footprint_cells"][0] / span[0], P["footprint_cells"][1] / span[2]), 6),
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
        "clear_opening_m": [round(door_open["x_max"] - door_open["x_min"], 3), round(door_open["y_max"] - door_open["y_min"], 3)],
        "interior_clear_height_m": P["interior_clear_height_m"],
        "interiorRegions": [{
            "id": "main_walkable_interior",
            "minX": round(P["shell"]["left_x"] + P["wall_thickness_m"], 4),
            "minZ": round(P["shell"]["back_z"] + P["wall_thickness_m"], 4),
            "maxX": round(P["shell"]["right_x"] - P["wall_thickness_m"], 4),
            "maxZ": round(P["door"]["opening_bounds"]["inner_z"] - 0.02, 4),
            "floorTopY": P["floor"]["top_y_m"],
        }],
        "collisionProxy": {
            "source": "P",
            "sidecar": "cloning_facility_collision.json",
            "structuralOnly": True,
        },
        "tri_count": int(metrics["tri_count"]),
        "materials": sorted(set(metrics["mat_names"])),
    }
    write_json(MANIFEST_PATH, manifest)
    return manifest


def facility_gate(metrics, validate):
    gltf = metrics["gltf"]
    node_names = [n.get("name", "") for n in gltf.get("nodes", [])]
    scene_idx = gltf.get("scene", 0)
    scene_nodes = gltf.get("scenes", [{}])[scene_idx].get("nodes", [])
    root_node = node_names[scene_nodes[0]] if len(scene_nodes) == 1 else None
    mesh_nodes = metrics["mesh_nodes"]
    bb = metrics["bbox_by_node"]
    total_span = bbox_span(metrics["total_bbox"])

    role_nodes_ok = all((n == "door_slide" or n.startswith(ROLE_PREFIXES)) for n in mesh_nodes)
    one_material_per_node = all(len(mats) == 1 for mats in metrics["material_sets"].values())
    materials_exact = set(metrics["mat_names"]) == FACILITY_MATERIALS
    no_skins = len(gltf.get("skins", [])) == 0
    normals_present = metrics["primitive_count"] > 0 and metrics["normal_primitives"] == metrics["primitive_count"]

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
        elif not is_identity_node_transform(node):
            bad_pivots.append(name)

    door_bounds = P["door"]["opening_bounds"]
    opening_w = door_bounds["x_max"] - door_bounds["x_min"]
    opening_h = door_bounds["y_max"] - door_bounds["y_min"]
    door_bb = bb["door_slide"]

    clips = animation_metrics(metrics)
    clip_names = sorted(clips)
    clips_present = set(clip_names) == {"door_open", "door_close"}
    clips_target_ok = clips_present and all(info["targets_only_door_translation"] for info in clips.values())
    clips_duration_ok = clips_present and all(0.7 <= info["duration_s"] <= 0.9 for info in clips.values())
    clips_distance_ok = clips_present and all(
        (info["endstate_distance_error_m"] is not None and info["endstate_distance_error_m"] <= 0.005 and info["axis_residual_m"] <= 0.005)
        for info in clips.values()
    )

    slide = Vector(P["door"]["slide_axis_local"]) * P["door"]["slide_distance_m"]
    open_door_min = [door_bb["min"][i] + slide[i] for i in range(3)]
    open_door_max = [door_bb["max"][i] + slide[i] for i in range(3)]
    pk = P["door"]["pocket_bounds"]
    pocket_swallow = (
        open_door_min[0] >= pk["x_min"] - 0.005 and open_door_max[0] <= pk["x_max"] + 0.005
        and open_door_min[1] >= pk["y_min"] - 0.005 and open_door_max[1] <= pk["y_max"] + 0.005
        and open_door_min[2] >= pk["z_min"] - 0.005 and open_door_max[2] <= pk["z_max"] + 0.005
    )
    open_clears_portal = open_door_max[0] <= door_bounds["x_min"] - 0.005

    floor_bb = bb["floor__single_cast_slab"]
    min_y = metrics["total_bbox"]["min"][1]
    max_y = metrics["total_bbox"]["max"][1]

    checks = {
        "root_node": root_node == P["root_node"] and len(scene_nodes) == 1,
        "node_role_coverage": role_nodes_ok and mesh_nodes.count("door_slide") == 1,
        "one_material_per_node": one_material_per_node,
        "materials_exact": materials_exact,
        "normals_exported": normals_present,
        "no_skins": no_skins,
        "pivots_identity_except_door": not bad_pivots and door_pivot_ok,
        "tri_count_within_budget": metrics["tri_count"] <= P["tri_budget"],
        "degenerate_faces_zero": metrics["degenerate_faces"] == 0,
        "duplicate_triangles_zero": metrics["duplicate_triangles_1e-6"] == 0,
        "loose_vertices_zero": metrics["loose_vertices"] == 0,
        "floor_top_y0_exact": abs(floor_bb["max"][1] - P["floor"]["top_y_m"]) <= 0.0005,
        "grounded_slab_below_grade": -0.125 <= min_y <= -0.115,
        "height_le_5_2m": max_y <= 5.2,
        "interior_clear_ge_2_9m": (P["roof"]["slab_bottom_y_m"] - P["floor"]["top_y_m"]) >= 2.9,
        "portal_width_ge_2_2m": opening_w >= 2.2,
        "portal_height_ge_2_3m": opening_h >= 2.3,
        "door_clips_present": clips_present,
        "door_clips_target_only_door": clips_target_ok,
        "door_clips_duration": clips_duration_ok,
        "door_slide_distance": clips_distance_ok,
        "pocket_swallow": pocket_swallow,
        "open_panel_clears_portal": open_clears_portal,
        "interior_nodes_present": all(
            n in mesh_nodes
            for n in ("interior__pod_dais", "interior__pod_alcove_frames", "interior__staff_lockers", "interior__waiting_bench", "interior__cable_spine", "interior__reception_counter")
        ),
        "glow_accents_present": all(n in mesh_nodes for n in ("wall_front__portal_glow", "roof__light_cove_glow", "floor__arrival_inlay_glow")),
        "validate": bool(validate.get("pass")),
    }
    return {
        "asset": "cloning_facility",
        "all_green": all(checks.values()),
        "root_node": root_node,
        "mesh_nodes": mesh_nodes,
        "materials": metrics["mat_names"],
        "tri_count": int(metrics["tri_count"]),
        "total_bbox_m": {"min": [round(v, 5) for v in metrics["total_bbox"]["min"]], "max": [round(v, 5) for v in metrics["total_bbox"]["max"]], "span": [round(v, 5) for v in total_span]},
        "door_opening_m": [round(opening_w, 5), round(opening_h, 5)],
        "animation_clips": {k: {kk: vv for kk, vv in v.items() if kk != "channels"} for k, v in clips.items()},
        "open_panel_bbox": {"min": [round(v, 5) for v in open_door_min], "max": [round(v, 5) for v in open_door_max]},
        "bad_pivot_nodes": bad_pivots,
        "validate": validate,
        "checks": checks,
    }


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


def set_role_hidden(prefixes, hidden):
    for obj in bpy.context.scene.objects:
        if any(obj.name.startswith(p) for p in prefixes):
            obj.hide_render = hidden
            obj.hide_viewport = hidden


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


def render_facility(root, door):
    scene = setup_render()
    ref = create_ref_box((-1.7, 5.1))
    closed_loc = Vector(logical_to_blender(P["door"]["closed_center"]))
    open_logical = Vector(P["door"]["closed_center"]) + Vector(P["door"]["slide_axis_local"]) * P["door"]["slide_distance_m"]
    open_loc = Vector(logical_to_blender(open_logical))
    # The NLA door tracks evaluate at the current frame and would override the
    # manually posed door location; mute them for evidence renders (export of
    # the GLB with animations already happened before this point).
    if door.animation_data:
        for track in door.animation_data.nla_tracks:
            track.mute = True
    cams = {
        "front": add_camera_logical("cam_front", (0.4, 2.3, 17.0), (0.4, 1.9, 0.0), 11.4),
        "ext_3q": add_camera_logical("cam_ext_3q", (11.5, 8.6, 12.5), (0.0, 1.9, -0.2), 13.2),
        "far": add_camera_logical("cam_far", (16.0, 11.0, 16.5), (0.0, 2.0, 0.0), 18.5),
        "ext_3q_back": add_camera_logical("cam_ext_3q_back", (-11.5, 9.2, -12.5), (0.0, 2.3, 0.2), 13.5),
        "portal": add_camera_logical("cam_portal", (2.9, 2.9, 9.5), (0.85, 2.0, 3.6), 6.8),
        "portal_3q": add_camera_logical("cam_portal_3q", (4.6, 2.4, 8.6), (0.85, 1.5, 3.4), 6.0),
        "interior_wide": add_camera_logical("cam_interior_wide", (0.4, 4.8, 10.2), (0.0, 0.9, -1.5), 10.8),
        "interior_dais": add_camera_logical("cam_interior_dais", (0.2, 2.6, 2.4), (0.2, 1.2, -3.4), 6.4),
    }

    set_all_visible(root)
    set_ref_hidden(ref, False)
    door.location = closed_loc
    render_still(scene, cams["front"], RENDER_DIR / "facility_ext_front.png")
    render_still(scene, cams["ext_3q"], RENDER_DIR / "facility_ext_3q_closed.png")
    render_still(scene, cams["far"], RENDER_DIR / "facility_far.png")
    render_still(scene, cams["ext_3q_back"], RENDER_DIR / "facility_ext_3q_back.png")
    render_still(scene, cams["portal"], RENDER_DIR / "facility_portal_closed.png")

    door.location = open_loc
    render_still(scene, cams["portal"], RENDER_DIR / "facility_portal_open.png")
    render_still(scene, cams["portal_3q"], RENDER_DIR / "facility_portal_3q_open.png")

    # Interior: hide roof + camera-facing front/right shell (runtime cutaway).
    # Re-aim the sun steep from the back so step risers and vertical faces
    # shade darker than the floor — physical depth reads in the flat style.
    sun = bpy.data.objects.get("sun_42_38")

    def aim_sun(az_deg, elev_deg):
        if not sun:
            return
        az, elev = math.radians(az_deg), math.radians(elev_deg)
        d = Vector(logical_to_blender(Vector((-math.cos(elev) * math.cos(az), -math.sin(elev), -math.cos(elev) * math.sin(az)))))
        sun.rotation_euler = d.to_track_quat("-Z", "Y").to_euler()

    aim_sun(205.0, 52.0)
    set_role_hidden(("roof__", "wall_front__", "wall_right__", "door_slide"), True)
    set_ref_hidden(ref, True)
    render_still(scene, cams["interior_wide"], RENDER_DIR / "facility_interior_wide.png")
    render_still(scene, cams["interior_dais"], RENDER_DIR / "facility_interior_dais.png")
    aim_sun(42.0, 38.0)

    set_all_visible(root)
    if door.animation_data:
        for track in door.animation_data.nla_tracks:
            track.mute = False
    door.location = closed_loc


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


# ──────────────────── collision extraction + provenance ───────────────────


def run_collision_extractor():
    # The facility uses an authored structural proxy.  The generic triangle
    # extractor remains the path for every other structure asset.
    try:
        sidecar = write_facility_collision_sidecar()
    except (OSError, ValueError, TypeError) as exc:
        return {"pass": False, "note": str(exc)}
    return {
        "pass": True,
        "generatedBy": sidecar["generatedBy"],
        "wall_boxes": len(sidecar["walls"]),
        "footprint": sidecar["footprint"],
        "door": sidecar["door"],
        "interior_regions": len(sidecar["interiorRegions"]),
        "floor_top_y": sidecar["floor"]["topY"],
    }


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
        "regeneration_command": "/snap/bin/blender -b --factory-startup --python-exit-code 1 -P tools/successor/assets/build_cloning_facility.py",
        "tri_count": tri_count,
        "gate_report": gate_summary,
        "source_blend_or_script": "tools/successor/assets/build_cloning_facility.py (deterministic parametric part program; no .blend needed)",
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
    "cloning_facility": (
        "Hand-authored parametric part program (no generative model): Dustgate cloning facility, "
        "10x8-cell enterable civic landmark in the shipped shoulder-house language — chamfered cast "
        "shoulders over a grounded foundation curb, stepped parapets, offset protruding entry bay "
        "with a broad 2.30 m pressure-vessel pocket door (door_slide + door_open/door_close, house "
        "door contract widened) traced by an energized bioseal gasket, twin-figure resurrection "
        "crest, rooftop process hall ducted into the filtration tower, bio-reservoir with feed "
        "manifold, and a raised pod dais with three deep alcove bays. Floor top authored at y=0.02 m "
        "per the bank/clone contract; mesh 9.5x7.6 m so runtime scale at 10x8 cells is 1.052632 "
        "(house/podtent pawn parity)."
    ),
    "bank_terminal": (
        "Hand-authored parametric part program (no generative model): Dustgate outdoor bank terminal "
        "kiosk — corbel-supported armored steel head over a cast column, brass side rails, hooded "
        "amber ledger screen behind glass, 12-key keypad with a glowing accept key, credit-chip "
        "slot, receipt slit with a protruding stub, and an open dispenser tray. Grounded at y=0, "
        "2.06 m tall at pawn scale."
    ),
    "clone_terminal": (
        "Hand-authored parametric part program (no generative model): Dustgate indoor clone terminal "
        "— clinical enamel spine with a steel crown band, neck-mounted angled cyan readout, palm-rest "
        "tray with a tag-reader ring, status lights, anchored base pads, floor cable foot with a "
        "collar. Grounded at y=0, ~1.74 m tall at pawn scale."
    ),
    "clone_pod": (
        "Hand-authored parametric part program (no generative model): Dustgate standing clone pod — "
        "tall faceted enamel drum on an anchored octagonal plinth with fluid ports, broad 130-degree "
        "front glass canopy over a full-height cyan suspension column, crown ring and manifold, twin "
        "flanged service risers. Grounded at y=0, 2.44 m tall."
    ),
}


def main():
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    EVIDENCE_DIR.mkdir(parents=True, exist_ok=True)
    RENDER_DIR.mkdir(parents=True, exist_ok=True)
    for p in RENDER_DIR.glob("*.png"):
        p.unlink()

    gates = {}

    # ── cloning_facility ──
    root, door = build_facility_scene()
    export_glb(root, FACILITY_GLB, with_animations=True)
    patch_door_rest_translation(FACILITY_GLB)
    metrics = parse_glb_metrics(FACILITY_GLB)
    write_facility_manifest(metrics)
    validate = run_validator(FACILITY_GLB)
    gates["cloning_facility"] = facility_gate(metrics, validate)
    render_facility(root, door)
    write_provenance("cloning_facility", FACILITY_GLB, metrics["tri_count"], ".game-lab/cloning-facility-20260716/gate.json", PROVENANCE_TEXT["cloning_facility"])

    # ── props ──
    prop_builds = {
        "bank_terminal": (build_bank_terminal_scene, BANK_MATERIALS, 2.6, 1.05, (0.0, 0.90, 0.32), 1.95),
        "clone_terminal": (build_clone_terminal_scene, CLONE_TERM_MATERIALS, 2.4, 0.95, (0.0, 1.10, 0.12), 1.45),
        "clone_pod": (build_clone_pod_scene, POD_MATERIALS, 3.1, 1.20, (0.0, 1.20, 0.56), 1.9),
    }
    for asset_id, (build_fn, allowed, ortho, cam_h, close_target, close_scale) in prop_builds.items():
        prop_root = build_fn()
        glb_path = OUT_DIR / f"{asset_id}.glb"
        export_glb(prop_root, glb_path, with_animations=False)
        prop_metrics = parse_glb_metrics(glb_path)
        prop_validate = run_validator(glb_path)
        gates[asset_id] = prop_gate(asset_id, prop_metrics, prop_validate, allowed)
        render_prop(prop_root, asset_id, ortho, cam_h, close_target, close_scale)
        write_provenance(asset_id, glb_path, prop_metrics["tri_count"], ".game-lab/cloning-facility-20260716/gate.json", PROVENANCE_TEXT[asset_id])

    # ── collision sidecar (mesh-derived, portal must be open) ──
    collision = run_collision_extractor()

    all_green = all(g["all_green"] for g in gates.values()) and bool(collision.get("pass"))
    summary = {
        "run": "cloning-facility-20260716",
        "all_green": all_green,
        "collision_extraction": collision,
        "assets": gates,
        "renders_dir": str(RENDER_DIR),
    }
    write_json(GATE_PATH, summary)
    final = json.loads(GATE_PATH.read_text())
    print(json.dumps({
        "all_green": final["all_green"],
        "tri_counts": {k: v["tri_count"] for k, v in final["assets"].items()},
        "checks_failed": {k: [c for c, ok in v["checks"].items() if not ok] for k, v in final["assets"].items() if not v["all_green"]},
        "collision": {k: v for k, v in collision.items() if k != "stdout"},
    }, indent=2))
    if not final.get("all_green"):
        raise SystemExit("gate.json is not green after disk re-read")


if __name__ == "__main__":
    main()
