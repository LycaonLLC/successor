"""Numeric contracts, palette and material ledger for the Dustgate Clone Vault.

Every runtime-visible number the cloning suite has to honour lives here, once.
Nothing downstream may re-derive a contract value by hand.

Coordinate convention used by every authoring module in this package
--------------------------------------------------------------------
"Logical" space is the glTF space the runtime sees: +X right, +Y up, +Z front.
Blender space is +X right, +Y depth, +Z up.  `logical_to_blender` is the only
bridge, and it is applied once, inside the mesh builder.

Why the structural footprint is frozen
--------------------------------------
`tools/successor/configure-open-desert-fixture.mjs` and
`tools/successor/structure-collision-geometry.test.mjs` both assert the cloning
facility ships exactly nine named structural wall proxies, and the fixture
derives door approach points from the sidecar.  The visual rebuild is total;
the *structural* rectangle set is deliberately reproduced bit-for-bit so the
world fixture, its collision graph and its tests are untouched by an art pass.
"""
from __future__ import annotations

# ──────────────────────────────── identity ────────────────────────────────

BUILDING = "cloning_facility"
ROOT_NODE = "Gear_cloning_facility"
UNITS = "m"
FOOTPRINT_CELLS = (10, 8)

# Mesh spans exactly 9.5 x 7.6 m so runtime scale at 10x8 cells is
# 10/9.5 == 8/7.6 == 1.052632 (pawn parity with house_h1 / commerce).
ENVELOPE = {"x_min": -4.75, "x_max": 4.75, "z_min": -3.80, "z_max": 3.80}
RUNTIME_SCALE_AT_10X8 = 1.052632
PAWN_HEIGHT_M = 1.725
# Both the building and a 1x1-cell prop are placed at the same 1.052632 uniform
# scale, so anything authored to read as pawn-height in MESH space must be
# authored smaller by exactly that factor.  1.6388 m of mesh is 1.725 m in the
# world the player walks around in.
PAWN_MESH_HEIGHT_M = PAWN_HEIGHT_M / RUNTIME_SCALE_AT_10X8

# ────────────────────────────── shell geometry ────────────────────────────

# Main mass.  Side and back shells are recessed 0.25 m inside the envelope so
# the buttresses, the filtration tower and the tank bank can reach the exact
# 9.5 x 7.6 extremes without the flat wall doing it.
MAIN = {"x_min": -4.75, "x_max": 4.75, "z_min": -3.80, "z_max": 3.10}
SHELL = {"left_x": -4.50, "right_x": 4.50, "back_z": -3.55, "front_z": 2.80}
WALL_T = 0.30

ENTRY_BAY = {"x_min": -3.25, "x_max": 2.75, "z_back": 3.10, "z_struct": 3.72,
             "z_hood": 3.80}

# Vertical stack.  One story, generous for a process hall.
# The vertical stack is deliberately stepped.  A single parapet height around a
# rectangle is what made the previous asset read as a box from every angle; the
# runs below differ by 0.10-0.60 m so the skyline has a front, a service side
# and a back.
LEVELS = {
    "grade_y": -0.30,           # cast slab bottom / apron
    "curb_top_y": 0.56,         # sinter foundation curb
    "datum_y": 2.32,            # bronze datum band centre-line
    "wall_top_y": 3.35,         # top of the panel skin
    "roof_bottom_y": 3.35,
    "roof_top_y": 3.58,
    "parapet_top_y": 4.02,      # left run (reference)
    "parapet_back_y": 3.90,
    "parapet_right_y": 4.30,    # service side reads taller
    "parapet_front_y": 4.14,
    "entry_parapet_top_y": 4.62,
    "entry_fin_top_y": 4.92,
    "corner_pier_top_y": 4.44,
    "tower_shaft_top_y": 5.34,  # filtration tower shaft
    "tower_top_y": 5.76,        # its capped stack -> the landmark height
}
INTERIOR_CLEAR_HEIGHT = 3.05
FLOOR = {"slab_thickness_m": 0.14, "top_y_m": 0.02}

# ────────────────────────────── door contract ─────────────────────────────

DOOR = {
    "node": "door_slide",
    "leaf_node": "door_slide__leaf",
    # 2.30 m x 2.42 m clear opening, unchanged from the shipped contract.
    "opening": {"x_min": -0.30, "x_max": 2.00, "y_min": 0.0, "y_max": 2.42,
                "inner_z": 3.42, "front_z": 3.76},
    "closed_center": (0.85, 1.22, 3.56),
    "panel_size": (2.42, 2.44, 0.10),
    "slide_axis_local": (-1, 0, 0),
    "slide_distance_m": 2.40,
    "clip_duration_s": 0.8,
    "fps": 30,
    "door_recess": {"x_min": -2.90, "x_max": -0.32, "y_min": -0.01, "y_max": 2.50,
                    "z_min": 3.44, "z_max": 3.70},
}

# ───────────────────── frozen structural collision proxy ──────────────────
# Nine boxes, exactly the ids and extents the shipped sidecar carries.
STRUCTURAL_WALLS = [
    ("outer_shell_left",       -4.75, -4.20, -3.55,  3.10),
    ("outer_shell_right",       4.20,  4.75, -3.55,  3.10),
    ("outer_shell_back",       -4.50,  4.50, -3.55, -3.25),
    ("outer_shell_front_left", -4.50, -0.30,  2.80,  3.10),
    ("outer_shell_front_right", 2.00,  4.50,  2.80,  3.10),
    ("entry_bay_return_left",  -3.25, -2.95,  3.10,  3.72),
    ("entry_bay_return_right",  2.45,  2.75,  3.10,  3.72),
    ("entry_bay_front_left",   -2.95, -0.30,  3.42,  3.72),
    ("entry_bay_front_right",   2.00,  2.45,  3.42,  3.72),
]
DOOR_COLLISION = {"id": "closed_door_panel", "minX": -0.30, "maxX": 2.00,
                  "minZ": 3.42, "maxZ": 3.76}
INTERIOR_REGION = {"id": "main_walkable_interior", "minX": -4.20, "maxX": 4.20,
                   "minZ": -3.25, "maxZ": 3.40, "floorTopY": FLOOR["top_y_m"]}

# Cutaway role prefixes the runtime reveal/keep logic depends on.
ROLE_PREFIXES = ("roof__", "wall_front__", "wall_right__", "wall_back__",
                 "wall_left__", "floor__", "interior__")
REVEAL_PREFIXES = ("roof__", "wall_front__", "wall_right__")

# ────────────────────────────── interior plan ─────────────────────────────
# Two world props are placed inside the facility by the open-desert fixture.
# Their cells map to these mesh positions; the fitout must leave them clear.
#   clone_terminal  facilityCell + (5, 3)  ->  mesh ( 0.475, -0.475)
#   clone_pod       facilityCell + (2, 1)  ->  mesh (-2.375, -2.375)
RUNTIME_PROP_SLOTS = {
    "clone_terminal": {"x": 0.475, "z": -0.475, "clear_r": 0.62},
    "clone_pod": {"x": -2.375, "z": -2.375, "clear_r": 0.62},
}

# Built-in full-size vat bank on the left wall.  Each vat is a person-scale
# upright chamber: 1.22 m deep (x) x 1.20 m wide (z) x 2.86 m tall, with a
# 1.96 m clear internal standing height over the foot plate -- 0.23 m of head
# room above a 1.725 m pawn.  The scale claim is measured, not asserted:
# cf_verify checks chamber clear height against PAWN_HEIGHT_M.
VAT_BANK = {
    "wall_x": -4.20,           # inner face of the left wall
    "depth": 1.22,
    "width": 1.20,
    "height": 2.86,
    "slots": [
        # (id, centre z, state)
        ("a", 1.52, "empty"),
        ("b", 0.00, "occupied"),
        ("c", -1.52, "primed"),
    ],
}

# Gantry rail over the vat bank.
# Service gantry runs in the aisle IN FRONT of the bank, so its rails clear the
# vat crowns and its parked arm hangs over the open (empty) unit.
GANTRY = {"x0": -3.02, "x1": -1.72, "z0": -2.40, "z1": 2.40, "rail_y": 2.72,
          "carriage_z": 1.52}

TRI_BUDGET_FACILITY = 250_000
TRI_BUDGET_PROP = 80_000

# ──────────────────────────── standalone props ────────────────────────────

PROPS = {
    "clone_pod": {
        "root_node": "Gear_clone_pod",
        "footprint": (0.95, 0.95),
        "height_range_m": (2.55, 2.80),
        "atlas": 2048,
        "tri_budget": 80_000,
    },
    "clone_terminal": {
        "root_node": "Gear_clone_terminal",
        "footprint": (0.956, 0.792),
        "height_range_m": (1.62, 1.86),
        "atlas": 1024,
        "tri_budget": 80_000,
    },
}

# ──────────────────────────────── palette ─────────────────────────────────
# sRGB hex.  The register is the buildkit-opus5 desert-frontier family
# (sinter / bleached panel / screed / galvanised roofmetal / bronze datum /
# gunmetal) extended with the clinical register a biomedical hall needs
# (enamel, stainless, seal rubber, hazard ochre, bio glass, culture fluid).
PALETTE = {
    "sinter":     "#9C8E76",
    "panel":      "#CEC6B3",
    "panel_dk":   "#8A8072",
    "screed":     "#6E6A62",
    "roofmetal":  "#7D858A",
    "bronze":     "#8F6B2E",
    "gunmetal":   "#3B4045",
    "steel":      "#B2B7BB",
    "enamel":     "#DDE0DE",
    "rubber":     "#2C2F32",
    "hazard":     "#C08A28",
    "biotank":    "#7E8C8A",
    "skin":       "#C4A48C",
    "glass":      "#41565B",
    "glass_clear": "#B6D6DA",
    "fluid":      "#2E8C82",
    "glow_cyan":  "#6FE6D8",
    "glow_amber": "#F0A83C",
    "glow_warm":  "#FFD8A0",
}

# name -> (palette key, roughness, metallic, tile metres, normal strength)
SURFACES = {
    "CF_sinter":    ("sinter",    0.86, 0.00, 1.30, 0.55),
    "CF_panel":     ("panel",     0.62, 0.00, 2.40, 0.40),
    "CF_panel_dk":  ("panel_dk",  0.68, 0.00, 2.40, 0.40),
    "CF_screed":    ("screed",    0.74, 0.00, 2.10, 0.55),
    "CF_roofmetal": ("roofmetal", 0.52, 0.75, 1.50, 0.45),
    "CF_bronze":    ("bronze",    0.38, 0.92, 0.55, 0.55),
    "CF_gunmetal":  ("gunmetal",  0.58, 0.70, 0.30, 0.50),
    "CF_steel":     ("steel",     0.28, 0.90, 0.45, 0.35),
    "CF_enamel":    ("enamel",    0.24, 0.00, 1.10, 0.22),
    "CF_rubber":    ("rubber",    0.82, 0.00, 0.24, 0.60),
    "CF_hazard":    ("hazard",    0.55, 0.00, 0.60, 0.35),
    "CF_biotank":   ("biotank",   0.44, 0.30, 0.85, 0.40),
    "CF_skin":      ("skin",      0.58, 0.00, 0.60, 0.25),
}

# Materials that never enter the baked atlas: they carry runtime behaviour
# (blend transparency, unlit emission) the unlit world-prop path reads
# directly.  See client-3d/src/render/props.ts convertMaterial.
SPECIAL = {
    # Architectural glazing is a DARK slot from outside: the exterior needs the
    # value contrast far more than it needs to see the room through a slit.
    "CF_Glass":     {"kind": "glass", "color": "glass", "alpha": 0.62, "rough": 0.08},
    # Vat canopies are the opposite job -- the occupant has to be legible.
    "CF_GlassClear": {"kind": "glass", "color": "glass_clear", "alpha": 0.20, "rough": 0.04},
    "CF_Fluid":     {"kind": "fluid", "color": "fluid", "alpha": 0.74, "rough": 0.12,
                     "emit": "fluid", "emit_strength": 0.42},
    "CF_Glow":      {"kind": "emit", "color": "glow_cyan", "emit_strength": 3.2},
    "CF_GlowAmber": {"kind": "emit", "color": "glow_amber", "emit_strength": 2.6},
    "CF_GlowWarm":  {"kind": "emit", "color": "glow_warm", "emit_strength": 2.0},
    "CF_Screen":    {"kind": "screen", "emit_strength": 2.4},
}
ATLAS_MATERIAL = "CF_Body"

# ─────────────────────────────── bake rig ─────────────────────────────────

BAKE = {
    "facility_atlas": 4096,
    # The runtime never reads ORM or normal maps (see cf_mat's header note), so
    # they ship at a modest resolution purely to keep the material PBR-complete
    # for any other consumer instead of adding megabytes of dead payload.
    "orm_atlas": 512,
    "samples": 220,
    "margin_px": 4,
    "uv_island_margin": 0.0010,
    # Daylight the unlit basecolor has to stand in for.  Deliberately
    # dome-dominant so the read holds at any yaw the placer may use.
    "sun_energy": 3.7,
    "sun_angle_deg": (52.0, -128.0),   # elevation, azimuth (logical)
    "sky_top": (0.42, 0.52, 0.66),
    "sky_horizon": (0.62, 0.58, 0.50),
    "sky_strength": 1.35,
    # Fraction of flat albedo a texel keeps when the ray passes resolve nothing.
    "ambient_floor": 0.16,
    "basecolor_jpeg_quality": 92,
    "bounce_ground": (0.46, 0.40, 0.32),
}

# Interior practicals baked into the atlas so the roof-off view reads as a lit
# hall rather than a black box.  (x, y, z, size, energy, colour)
INTERIOR_LIGHTS = [
    (-1.60, 2.94, 1.90, 1.30, 185.0, (0.86, 0.94, 1.00)),
    (1.90, 2.94, 1.90, 1.30, 170.0, (0.86, 0.94, 1.00)),
    (-1.60, 2.94, -1.70, 1.30, 185.0, (0.86, 0.94, 1.00)),
    (1.90, 2.94, -1.70, 1.30, 170.0, (0.86, 0.94, 1.00)),
    (-3.40, 1.45, 1.52, 0.70, 60.0, (0.52, 0.94, 0.92)),
    (-3.40, 1.45, 0.00, 0.70, 96.0, (0.46, 0.96, 0.90)),
    (-3.40, 1.45, -1.52, 0.70, 52.0, (0.98, 0.72, 0.30)),
    (3.60, 1.70, -0.40, 0.60, 46.0, (0.60, 0.92, 1.00)),
]

VERSION = "cloning-facility-opus5-20260803"
