"""Procedural PBR surfaces for the Dustgate Clone Vault.

Every authoring surface is a Cycles-evaluable node graph, not a pre-rendered
PNG.  The shipped texture is produced by *baking* these graphs through the
asset's own atlas UV, which is what lets the runtime read authored micro-detail
without the asset carrying a tiling texture library.

Runtime note that shapes the whole material ledger
--------------------------------------------------
`client-3d/src/render/props.ts::convertMaterial` maps a world-prop material
with a base-colour texture to an UNLIT `MeshBasicMaterial`, and a material
without one to a flat-shaded `MeshMatcapMaterial`.  Normal/ORM maps are
dropped.  Therefore:

  * the baked base colour has to carry the lit read (irradiance + AO folded
    in) — the convention `campfire_scout`/`barricade_concrete` already ship;
  * glass and fluid stay *untextured* so the matcap path keeps their authored
    blend transparency (the commerce `CM_TealGlass` precedent);
  * emissive accents stay untextured so the basic-material branch lights them
    with their authored emissive colour.
"""
from __future__ import annotations

import bpy

from cf_spec import PALETTE, SURFACES, SPECIAL, ATLAS_MATERIAL


def hex_to_rgba(h: str, alpha: float = 1.0):
    h = h.lstrip("#")
    return tuple(int(h[i:i + 2], 16) / 255.0 for i in (0, 2, 4)) + (alpha,)


def hex_to_linear(h: str):
    srgb = hex_to_rgba(h)[:3]
    return tuple((c / 12.92) if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4
                 for c in srgb)


def _new(tree, kind, loc):
    n = tree.nodes.new(kind)
    n.location = loc
    return n


def _shade(v, k):
    return tuple(min(1.0, max(0.0, c * k)) for c in v)


# ────────────────────────── procedural recipes ────────────────────────────
#
# Recipes differ in *character*, not merely in seed: mineral surfaces get a
# cut-aggregate Voronoi, rolled metals get a stretched linisher, enamel gets a
# near-flat glaze with a seam grid, rubber gets an isotropic pucker.  Keeping
# them structurally distinct is what stops the palette collapsing into "one
# procedural noise over everything".

_RECIPE = {
    "sinter": "mineral", "screed": "mineral",
    "panel": "cast", "panel_dk": "cast",
    "roofmetal": "rolled", "bronze": "linished", "gunmetal": "linished",
    "steel": "linished",
    "enamel": "glaze", "biotank": "glaze",
    "rubber": "pucker", "hazard": "cast", "skin": "soft",
}


def _noise(tree, loc, scale, detail, seed, rough=0.5):
    """4D value-noise node.  The W axis is the only deterministic seed a
    Blender noise node has; it does not exist until the node is 4D."""
    n = _new(tree, "ShaderNodeTexNoise", loc)
    n.noise_dimensions = "4D"
    n.inputs["Scale"].default_value = scale
    n.inputs["Detail"].default_value = detail
    n.inputs["Roughness"].default_value = rough
    n.inputs["W"].default_value = float(seed)
    return n


def _mineral(tree, uv, tint, seed):
    vor = _new(tree, "ShaderNodeTexVoronoi", (-980, 280))
    vor.feature = "F1"
    vor.inputs["Scale"].default_value = 14.0
    vor.inputs["Randomness"].default_value = 0.92
    tree.links.new(uv, vor.inputs["Vector"])
    cell = _new(tree, "ShaderNodeTexVoronoi", (-980, 60))
    cell.feature = "F1"
    cell.voronoi_dimensions = "3D"
    cell.inputs["Scale"].default_value = 14.0
    tree.links.new(uv, cell.inputs["Vector"])
    grit = _noise(tree, (-980, -180), 42.0, 6.0, float(seed), rough=0.62)
    tree.links.new(uv, grit.inputs["Vector"])
    swell = _noise(tree, (-980, -420), 3.1, 3.0, float(seed) + 4.0)
    tree.links.new(uv, swell.inputs["Vector"])
    # colour: aggregate grains carry mineral variation, grooves darken
    ramp = _new(tree, "ShaderNodeValToRGB", (-720, 280))
    ramp.color_ramp.elements[0].position = 0.02
    ramp.color_ramp.elements[0].color = (0.34, 0.34, 0.34, 1.0)
    ramp.color_ramp.elements[1].position = 0.30
    ramp.color_ramp.elements[1].color = (1.0, 1.0, 1.0, 1.0)
    tree.links.new(vor.outputs["Distance"], ramp.inputs["Fac"])
    mixa = _new(tree, "ShaderNodeMix", (-480, 300))
    mixa.data_type = "RGBA"
    mixa.inputs["Factor"].default_value = 0.30
    mixa.inputs[6].default_value = (*_shade(tint, 0.80), 1.0)
    mixa.inputs[7].default_value = (*_shade(tint, 1.16), 1.0)
    tree.links.new(cell.outputs["Color"], mixa.inputs["Factor"])
    mixb = _new(tree, "ShaderNodeMix", (-300, 300))
    mixb.data_type = "RGBA"
    mixb.inputs["Factor"].default_value = 0.55
    tree.links.new(ramp.outputs["Color"], mixb.inputs["Factor"])
    mixb.inputs[6].default_value = (*_shade(tint, 0.62), 1.0)
    tree.links.new(mixa.outputs[2], mixb.inputs[7])
    # roughness: grooves are rougher than cut faces
    rmap = _new(tree, "ShaderNodeMapRange", (-480, 60))
    rmap.inputs["From Min"].default_value = 0.0
    rmap.inputs["From Max"].default_value = 1.0
    tree.links.new(ramp.outputs["Color"], rmap.inputs["Value"])
    height = _new(tree, "ShaderNodeMix", (-480, -240))
    height.data_type = "FLOAT"
    height.inputs["Factor"].default_value = 0.34
    tree.links.new(ramp.outputs["Color"], height.inputs[2])
    tree.links.new(grit.outputs["Fac"], height.inputs[3])
    return mixb.outputs[2], rmap, height.outputs[0], swell.outputs["Fac"]


def _cast(tree, uv, tint, seed):
    swell = _noise(tree, (-980, 280), 2.4, 4.0, float(seed), rough=0.48)
    tree.links.new(uv, swell.inputs["Vector"])
    micro = _noise(tree, (-980, 40), 58.0, 4.0, float(seed) + 11.0)
    tree.links.new(uv, micro.inputs["Vector"])
    blot = _new(tree, "ShaderNodeTexVoronoi", (-980, -200))
    blot.feature = "SMOOTH_F1"
    blot.inputs["Scale"].default_value = 5.5
    blot.inputs["Smoothness"].default_value = 0.85
    tree.links.new(uv, blot.inputs["Vector"])
    mix = _new(tree, "ShaderNodeMix", (-480, 280))
    mix.data_type = "RGBA"
    mix.inputs[6].default_value = (*_shade(tint, 0.88), 1.0)
    mix.inputs[7].default_value = (*_shade(tint, 1.09), 1.0)
    tree.links.new(swell.outputs["Fac"], mix.inputs["Factor"])
    stain = _new(tree, "ShaderNodeMix", (-300, 280))
    stain.data_type = "RGBA"
    stain.inputs["Factor"].default_value = 0.16
    tree.links.new(blot.outputs["Distance"], stain.inputs["Factor"])
    tree.links.new(mix.outputs[2], stain.inputs[6])
    stain.inputs[7].default_value = (*_shade(tint, 0.70), 1.0)
    rmap = _new(tree, "ShaderNodeMapRange", (-480, 40))
    tree.links.new(blot.outputs["Distance"], rmap.inputs["Value"])
    return stain.outputs[2], rmap, micro.outputs["Fac"], swell.outputs["Fac"]


def _rolled(tree, uv, tint, seed):
    stretch = _new(tree, "ShaderNodeMapping", (-1200, 200))
    stretch.inputs["Scale"].default_value = (1.0, 26.0, 1.0)
    tree.links.new(uv, stretch.inputs["Vector"])
    roll = _noise(tree, (-980, 280), 9.0, 4.0, float(seed))
    tree.links.new(stretch.outputs["Vector"], roll.inputs["Vector"])
    spangle = _new(tree, "ShaderNodeTexVoronoi", (-980, 40))
    spangle.feature = "F1"
    spangle.inputs["Scale"].default_value = 8.0
    tree.links.new(uv, spangle.inputs["Vector"])
    mix = _new(tree, "ShaderNodeMix", (-480, 280))
    mix.data_type = "RGBA"
    mix.inputs[6].default_value = (*_shade(tint, 0.84), 1.0)
    mix.inputs[7].default_value = (*_shade(tint, 1.12), 1.0)
    tree.links.new(spangle.outputs["Color"], mix.inputs["Factor"])
    rmap = _new(tree, "ShaderNodeMapRange", (-480, 40))
    tree.links.new(roll.outputs["Fac"], rmap.inputs["Value"])
    return mix.outputs[2], rmap, roll.outputs["Fac"], spangle.outputs["Distance"]


def _linished(tree, uv, tint, seed):
    stretch = _new(tree, "ShaderNodeMapping", (-1200, 200))
    stretch.inputs["Scale"].default_value = (1.0, 46.0, 1.0)
    tree.links.new(uv, stretch.inputs["Vector"])
    lin = _noise(tree, (-980, 280), 16.0, 3.0, float(seed))
    tree.links.new(stretch.outputs["Vector"], lin.inputs["Vector"])
    patina = _noise(tree, (-980, 20), 3.6, 5.0, float(seed) + 3.0)
    tree.links.new(uv, patina.inputs["Vector"])
    mix = _new(tree, "ShaderNodeMix", (-480, 280))
    mix.data_type = "RGBA"
    mix.inputs[6].default_value = (*_shade(tint, 0.82), 1.0)
    mix.inputs[7].default_value = (*_shade(tint, 1.14), 1.0)
    tree.links.new(lin.outputs["Fac"], mix.inputs["Factor"])
    dull = _new(tree, "ShaderNodeMix", (-300, 280))
    dull.data_type = "RGBA"
    dull.inputs["Factor"].default_value = 0.22
    tree.links.new(patina.outputs["Fac"], dull.inputs["Factor"])
    tree.links.new(mix.outputs[2], dull.inputs[6])
    dull.inputs[7].default_value = (*_shade(tint, 0.60), 1.0)
    rmap = _new(tree, "ShaderNodeMapRange", (-480, 20))
    tree.links.new(patina.outputs["Fac"], rmap.inputs["Value"])
    return dull.outputs[2], rmap, lin.outputs["Fac"], patina.outputs["Fac"]


def _glaze(tree, uv, tint, seed):
    haze = _noise(tree, (-980, 280), 4.2, 3.0, float(seed))
    tree.links.new(uv, haze.inputs["Vector"])
    grime = _noise(tree, (-980, 40), 22.0, 5.0, float(seed) + 7.0)
    tree.links.new(uv, grime.inputs["Vector"])
    mix = _new(tree, "ShaderNodeMix", (-480, 280))
    mix.data_type = "RGBA"
    mix.inputs[6].default_value = (*_shade(tint, 0.95), 1.0)
    mix.inputs[7].default_value = (*_shade(tint, 1.04), 1.0)
    tree.links.new(haze.outputs["Fac"], mix.inputs["Factor"])
    rmap = _new(tree, "ShaderNodeMapRange", (-480, 40))
    tree.links.new(grime.outputs["Fac"], rmap.inputs["Value"])
    return mix.outputs[2], rmap, grime.outputs["Fac"], haze.outputs["Fac"]


def _pucker(tree, uv, tint, seed):
    bumpy = _new(tree, "ShaderNodeTexVoronoi", (-980, 280))
    bumpy.feature = "SMOOTH_F1"
    bumpy.inputs["Scale"].default_value = 38.0
    bumpy.inputs["Smoothness"].default_value = 0.6
    tree.links.new(uv, bumpy.inputs["Vector"])
    mix = _new(tree, "ShaderNodeMix", (-480, 280))
    mix.data_type = "RGBA"
    mix.inputs[6].default_value = (*_shade(tint, 0.86), 1.0)
    mix.inputs[7].default_value = (*_shade(tint, 1.18), 1.0)
    tree.links.new(bumpy.outputs["Distance"], mix.inputs["Factor"])
    rmap = _new(tree, "ShaderNodeMapRange", (-480, 40))
    tree.links.new(bumpy.outputs["Distance"], rmap.inputs["Value"])
    return mix.outputs[2], rmap, bumpy.outputs["Distance"], bumpy.outputs["Distance"]


def _soft(tree, uv, tint, seed):
    pore = _noise(tree, (-980, 280), 90.0, 3.0, float(seed))
    tree.links.new(uv, pore.inputs["Vector"])
    tone = _noise(tree, (-980, 40), 2.6, 3.0, float(seed) + 2.0)
    tree.links.new(uv, tone.inputs["Vector"])
    mix = _new(tree, "ShaderNodeMix", (-480, 280))
    mix.data_type = "RGBA"
    mix.inputs[6].default_value = (*_shade(tint, 0.90), 1.0)
    mix.inputs[7].default_value = (*_shade(tint, 1.08), 1.0)
    tree.links.new(tone.outputs["Fac"], mix.inputs["Factor"])
    rmap = _new(tree, "ShaderNodeMapRange", (-480, 40))
    tree.links.new(pore.outputs["Fac"], rmap.inputs["Value"])
    return mix.outputs[2], rmap, pore.outputs["Fac"], tone.outputs["Fac"]


_BUILDERS = {"mineral": _mineral, "cast": _cast, "rolled": _rolled,
             "linished": _linished, "glaze": _glaze, "pucker": _pucker,
             "soft": _soft}


def surface_material(name: str):
    key, rough, metal, tile, nrm = SURFACES[name]
    tint = hex_to_linear(PALETTE[key])
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    tree = mat.node_tree
    bsdf = tree.nodes["Principled BSDF"]
    out_uv = _new(tree, "ShaderNodeTexCoord", (-1420, 200)).outputs["UV"]

    seed = sum(ord(c) for c in name) % 97
    col, rmap, height, macro = _BUILDERS[_RECIPE[key]](tree, out_uv, tint, seed)

    rmap.inputs["To Min"].default_value = max(0.03, rough - 0.13)
    rmap.inputs["To Max"].default_value = min(1.0, rough + 0.13)
    tree.links.new(col, bsdf.inputs["Base Color"])
    tree.links.new(rmap.outputs["Result"], bsdf.inputs["Roughness"])
    bsdf.inputs["Metallic"].default_value = metal

    bump = _new(tree, "ShaderNodeBump", (-140, -220))
    bump.inputs["Strength"].default_value = nrm * 0.5
    bump.inputs["Distance"].default_value = 0.006
    tree.links.new(height, bump.inputs["Height"])
    tree.links.new(bump.outputs["Normal"], bsdf.inputs["Normal"])

    if key in ("enamel", "biotank"):
        if "Coat Weight" in bsdf.inputs:
            bsdf.inputs["Coat Weight"].default_value = 0.42
            bsdf.inputs["Coat Roughness"].default_value = 0.07
    mat.diffuse_color = hex_to_rgba(PALETTE[key])
    return mat


def _set_blend(mat):
    for attr, value in (("surface_render_method", "BLENDED"), ("blend_method", "BLEND")):
        try:
            setattr(mat, attr, value)
        except Exception:
            pass


def special_material(name: str, screen_image=None):
    spec = SPECIAL[name]
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes["Principled BSDF"]
    kind = spec["kind"]
    if kind == "glass":
        rgba = hex_to_rgba(PALETTE[spec["color"]], spec["alpha"])
        bsdf.inputs["Base Color"].default_value = rgba
        bsdf.inputs["Roughness"].default_value = spec["rough"]
        bsdf.inputs["Metallic"].default_value = 0.0
        bsdf.inputs["Alpha"].default_value = spec["alpha"]
        if "IOR" in bsdf.inputs:
            bsdf.inputs["IOR"].default_value = 1.46
        mat.diffuse_color = rgba
        _set_blend(mat)
    elif kind == "fluid":
        rgba = hex_to_rgba(PALETTE[spec["color"]], spec["alpha"])
        bsdf.inputs["Base Color"].default_value = rgba
        bsdf.inputs["Roughness"].default_value = spec["rough"]
        bsdf.inputs["Alpha"].default_value = spec["alpha"]
        bsdf.inputs["Emission Color"].default_value = hex_to_rgba(PALETTE[spec["emit"]])
        bsdf.inputs["Emission Strength"].default_value = spec["emit_strength"]
        mat.diffuse_color = rgba
        _set_blend(mat)
    elif kind == "emit":
        body = hex_to_rgba("#0A1413")
        bsdf.inputs["Base Color"].default_value = body
        bsdf.inputs["Roughness"].default_value = 0.42
        bsdf.inputs["Emission Color"].default_value = hex_to_rgba(PALETTE[spec["color"]])
        bsdf.inputs["Emission Strength"].default_value = spec["emit_strength"]
        mat.diffuse_color = hex_to_rgba(PALETTE[spec["color"]])
    elif kind == "screen":
        tree = mat.node_tree
        tex = _new(tree, "ShaderNodeTexImage", (-520, -160))
        tex.image = screen_image
        tex.interpolation = "Closest"
        bsdf.inputs["Base Color"].default_value = hex_to_rgba("#07100F")
        bsdf.inputs["Roughness"].default_value = 0.24
        tree.links.new(tex.outputs["Color"], bsdf.inputs["Emission Color"])
        bsdf.inputs["Emission Strength"].default_value = spec["emit_strength"]
        mat.diffuse_color = hex_to_rgba("#07100F")
    return mat


def build_library(screen_image=None) -> dict:
    """Fresh material library.  Never reuses datablocks between builds so a
    rebuild in a live session cannot inherit a half-edited graph."""
    lib = {}
    for name in SURFACES:
        for old in list(bpy.data.materials):
            if old.name == name:
                bpy.data.materials.remove(old)
        lib[name] = surface_material(name)
    for name in SPECIAL:
        for old in list(bpy.data.materials):
            if old.name == name:
                bpy.data.materials.remove(old)
        lib[name] = special_material(name, screen_image=screen_image)
    return lib


ATLAS_EXCLUDED = tuple(SPECIAL.keys())


def make_atlas_material(image, orm_image=None, name: str = ATLAS_MATERIAL):
    """The single shipped body material: baked lit base colour (+ optional
    baked ORM for PBR consumers)."""
    for old in list(bpy.data.materials):
        if old.name == name:
            bpy.data.materials.remove(old)
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    tree = mat.node_tree
    bsdf = tree.nodes["Principled BSDF"]
    tex = _new(tree, "ShaderNodeTexImage", (-520, 240))
    tex.image = image
    tree.links.new(tex.outputs["Color"], bsdf.inputs["Base Color"])
    if orm_image is not None:
        orm = _new(tree, "ShaderNodeTexImage", (-520, -60))
        orm.image = orm_image
        sep = _new(tree, "ShaderNodeSeparateColor", (-240, -60))
        tree.links.new(orm.outputs["Color"], sep.inputs["Color"])
        tree.links.new(sep.outputs["Green"], bsdf.inputs["Roughness"])
        tree.links.new(sep.outputs["Blue"], bsdf.inputs["Metallic"])
    else:
        bsdf.inputs["Roughness"].default_value = 0.72
        bsdf.inputs["Metallic"].default_value = 0.0
    mat.diffuse_color = (0.72, 0.70, 0.66, 1.0)
    return mat
