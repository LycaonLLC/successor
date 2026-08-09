"""Atlas UV packing and Cycles baking for the Dustgate Clone Vault.

The shipped asset carries ONE body material whose base colour is a baked lit
atlas.  That is not a shortcut: the runtime world-prop path renders textured
props with an unlit `MeshBasicMaterial`, so anything that is not already in the
base colour — irradiance, ambient occlusion, the interior practicals — simply
does not exist in game.  Baking is the only way an authored interior reads.

Passes
------
  base colour  COMBINED   diffuse irradiance x albedo + emission, atlas res
  ORM          AO / ROUGHNESS / metallic-through-emission, packed R/G/B
  normal       NORMAL     tangent-space, captures the procedural bump

Every pass shares one atlas UV set so the three maps register exactly.
"""
from __future__ import annotations

import math

import bpy
import numpy as np

from pathlib import Path

from cf_spec import BAKE, SPECIAL

JPEG_DIR = (Path(__file__).resolve().parents[4] / ".game-lab"
            / "cloning-facility-opus5-20260803" / "atlas")

ATLAS_UV = "UVAtlas"


# ───────────────────────────── UV preparation ─────────────────────────────


def _only(objects):
    bpy.ops.object.select_all(action="DESELECT")
    for o in objects:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objects[0]


def pack_atlas_uv(objects, island_margin=None, angle_limit=66.0):
    """Unique, non-overlapping UVs packed across the whole object set."""
    island_margin = BAKE["uv_island_margin"] if island_margin is None else island_margin
    objects = [o for o in objects if o.type == "MESH" and len(o.data.polygons)]
    if not objects:
        return 0
    for o in objects:
        uvs = o.data.uv_layers
        if ATLAS_UV in uvs:
            uvs.remove(uvs[ATLAS_UV])
        uvs.new(name=ATLAS_UV)
        uvs[ATLAS_UV].active = True
        uvs[ATLAS_UV].active_render = True
    _only(objects)
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.uv.select_all(action="SELECT")
    bpy.ops.uv.smart_project(angle_limit=math.radians(angle_limit),
                             island_margin=0.0,
                             area_weight=0.0, correct_aspect=True,
                             scale_to_bounds=False)
    # smart_project alone packs at ~10% of the square on a building-sized set:
    # every island keeps its own scale and the largest one sets the bound.
    # Equalising texel density and repacking with rotation recovers the atlas.
    bpy.ops.uv.select_all(action="SELECT")
    bpy.ops.uv.average_islands_scale()
    try:
        bpy.ops.uv.pack_islands(rotate=True, margin=island_margin, scale=True,
                                shape_method="CONCAVE", margin_method="FRACTION")
    except TypeError:
        bpy.ops.uv.pack_islands(rotate=True, margin=island_margin)
    bpy.ops.object.mode_set(mode="OBJECT")
    return len(objects)


def atlas_uv_coverage(objects) -> float:
    """Fraction of the 0..1 square the packed islands actually occupy."""
    total = 0.0
    for o in objects:
        me = o.data
        layer = me.uv_layers.get(ATLAS_UV)
        if layer is None:
            continue
        uv = np.empty(len(me.loops) * 2, dtype=np.float32)
        layer.data.foreach_get("uv", uv)
        uv = uv.reshape(-1, 2)
        for poly in me.polygons:
            idx = list(range(poly.loop_start, poly.loop_start + poly.loop_total))
            pts = uv[idx]
            a = 0.0
            for i in range(len(pts)):
                j = (i + 1) % len(pts)
                a += pts[i][0] * pts[j][1] - pts[j][0] * pts[i][1]
            total += abs(a) * 0.5
    return float(total)


# ─────────────────────────────── bake world ───────────────────────────────


def build_world(scene, night=False):
    world = bpy.data.worlds.get("CF_BAKE_WORLD") or bpy.data.worlds.new("CF_BAKE_WORLD")
    world.use_nodes = True
    tree = world.node_tree
    tree.nodes.clear()
    out = tree.nodes.new("ShaderNodeOutputWorld")
    bg = tree.nodes.new("ShaderNodeBackground")
    grad = tree.nodes.new("ShaderNodeTexGradient")
    grad.gradient_type = "LINEAR"
    mapping = tree.nodes.new("ShaderNodeMapping")
    mapping.inputs["Rotation"].default_value = (0.0, math.radians(-90.0), 0.0)
    texco = tree.nodes.new("ShaderNodeTexCoord")
    ramp = tree.nodes.new("ShaderNodeValToRGB")
    top = BAKE["sky_top"]
    hor = BAKE["sky_horizon"]
    gnd = BAKE["bounce_ground"]
    if night:
        top = tuple(c * 0.13 for c in top)
        hor = tuple(c * 0.10 for c in hor)
        gnd = tuple(c * 0.08 for c in gnd)
    ramp.color_ramp.elements[0].position = 0.42
    ramp.color_ramp.elements[0].color = (*gnd, 1.0)
    ramp.color_ramp.elements[1].position = 0.58
    ramp.color_ramp.elements[1].color = (*hor, 1.0)
    e = ramp.color_ramp.elements.new(0.82)
    e.color = (*top, 1.0)
    tree.links.new(texco.outputs["Generated"], mapping.inputs["Vector"])
    tree.links.new(mapping.outputs["Vector"], grad.inputs["Vector"])
    tree.links.new(grad.outputs["Fac"], ramp.inputs["Fac"])
    tree.links.new(ramp.outputs["Color"], bg.inputs["Color"])
    bg.inputs["Strength"].default_value = BAKE["sky_strength"] * (0.16 if night else 1.0)
    tree.links.new(bg.outputs["Background"], out.inputs["Surface"])
    scene.world = world
    return world


def build_lights(collection, night=False):
    """Sun + the interior practicals.  Returns the created light objects."""
    from cf_spec import INTERIOR_LIGHTS
    made = []
    elev, azim = BAKE["sun_angle_deg"]
    sun_data = bpy.data.lights.new("CF_BAKE_SUN", type="SUN")
    sun_data.energy = BAKE["sun_energy"] * (0.05 if night else 1.0)
    sun_data.angle = math.radians(2.6)
    sun_data.color = (1.0, 0.95, 0.86) if not night else (0.55, 0.66, 0.92)
    sun = bpy.data.objects.new("CF_BAKE_SUN", sun_data)
    collection.objects.link(sun)
    e, a = math.radians(elev), math.radians(azim)
    # logical direction -> blender: (x, -z, y)
    dx = math.cos(e) * math.sin(a)
    dz = math.cos(e) * math.cos(a)
    dy = math.sin(e)
    sun.location = (dx * 14.0, -dz * 14.0, dy * 14.0)
    sun.rotation_mode = "QUATERNION"
    from mathutils import Vector
    sun.rotation_quaternion = Vector((dx, -dz, dy)).normalized().to_track_quat("Z", "Y")
    made.append(sun)

    for (x, y, z, size, energy, color) in INTERIOR_LIGHTS:
        data = bpy.data.lights.new("CF_BAKE_PRACTICAL", type="AREA")
        data.shape = "SQUARE"
        data.size = size
        data.energy = energy * (1.35 if night else 1.0)
        data.color = color
        obj = bpy.data.objects.new("CF_BAKE_PRACTICAL", data)
        obj.location = (x, -z, y)
        obj.rotation_euler = (math.pi, 0.0, 0.0)   # face down
        collection.objects.link(obj)
        made.append(obj)
    return made


def clear_lights(collection):
    for o in list(collection.objects):
        if o.name.startswith("CF_BAKE_"):
            data = o.data
            bpy.data.objects.remove(o, do_unlink=True)
            if isinstance(data, bpy.types.Light) and data.users == 0:
                bpy.data.lights.remove(data)


# ──────────────────────────────── baking ──────────────────────────────────


def _image(name, size, non_color=False, alpha=False):
    old = bpy.data.images.get(name)
    if old is not None:
        bpy.data.images.remove(old)
    img = bpy.data.images.new(name, size, size, alpha=alpha,
                              float_buffer=False, is_data=non_color)
    if non_color:
        img.colorspace_settings.name = "Non-Color"
    return img


def _attach_target(materials, image):
    """Give every material an active image-texture node aimed at `image`."""
    handles = []
    for mat in materials:
        tree = mat.node_tree
        node = tree.nodes.get("CF_BAKE_TARGET")
        if node is None:
            node = tree.nodes.new("ShaderNodeTexImage")
            node.name = "CF_BAKE_TARGET"
            node.label = "CF_BAKE_TARGET"
            node.location = (600, -400)
        node.image = image
        node.select = True
        tree.nodes.active = node
        handles.append((tree, node))
    return handles


def _detach_targets(materials):
    for mat in materials:
        node = mat.node_tree.nodes.get("CF_BAKE_TARGET")
        if node is not None:
            mat.node_tree.nodes.remove(node)


def _configure_cycles(scene, samples):
    """CPU Cycles, deliberately.

    `cycles.preferences.get_devices()` segfaults Blender 5.2.0 LTS (snap 7599)
    on this host — reproduced headless under `--factory-startup`, crash trace
    in cycles/properties.py::get_device_list.  Enumerating devices is the only
    way to enable a GPU backend, so the bake runs on CPU and buys the time back
    with adaptive sampling plus OpenImageDenoise.
    """
    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.cycles.samples = samples
    scene.cycles.use_adaptive_sampling = True
    scene.cycles.adaptive_threshold = 0.02
    scene.cycles.use_denoising = True
    scene.cycles.max_bounces = 6
    scene.cycles.diffuse_bounces = 4
    scene.cycles.glossy_bounces = 2
    scene.cycles.transmission_bounces = 4
    scene.cycles.transparent_max_bounces = 8
    scene.render.bake.margin = BAKE["margin_px"]
    # NEVER let the operator clear: with several objects baking into ONE atlas
    # image, `use_clear` wipes the image again for every object, so the file
    # ends up holding only whichever object happened to bake last.  That is how
    # the first full-resolution atlas came out 92% black.  `bake_pass` zeroes
    # the image itself, once.
    scene.render.bake.use_clear = False
    scene.render.bake.use_selected_to_active = False
    return "CPU"


def fill_image(image, value=(0.0, 0.0, 0.0, 1.0)):
    w, h = image.size
    buf = np.tile(np.asarray(value, dtype=np.float32), w * h)
    image.pixels.foreach_set(buf)
    image.update()


def bake_pass(scene, objects, materials, image, bake_type, samples,
              direct=True, indirect=True, color=True, clear=(0.0, 0.0, 0.0, 1.0)):
    if clear is not None:
        fill_image(image, clear)
    _attach_target(materials, image)
    for o in objects:
        layer = o.data.uv_layers.get(ATLAS_UV)
        if layer is not None:
            layer.active = True
            layer.active_render = True
    _only(objects)
    scene.cycles.samples = samples
    bake = scene.render.bake
    if bake_type == "COMBINED":
        bake.use_pass_direct = direct
        bake.use_pass_indirect = indirect
        bake.use_pass_diffuse = True
        bake.use_pass_glossy = False
        bake.use_pass_transmission = False
        bake.use_pass_emit = True
    elif bake_type == "DIFFUSE":
        bake.use_pass_direct = direct
        bake.use_pass_indirect = indirect
        bake.use_pass_color = color
    bpy.ops.object.bake(type=bake_type)
    return image


def image_to_array(img) -> np.ndarray:
    w, h = img.size
    buf = np.empty(w * h * 4, dtype=np.float32)
    img.pixels.foreach_get(buf)
    return buf.reshape(h, w, 4)


def array_to_image(name, arr, non_color=False, file_format="PNG"):
    h, w = arr.shape[:2]
    old = bpy.data.images.get(name)
    if old is not None:
        bpy.data.images.remove(old)
    img = bpy.data.images.new(name, w, h, alpha=False, is_data=non_color)
    if non_color:
        img.colorspace_settings.name = "Non-Color"
    flat = np.ascontiguousarray(arr.astype(np.float32).ravel())
    img.pixels.foreach_set(flat)
    img.file_format = file_format
    img.update()
    return img


def _metallic_probe(materials):
    """Temporarily drive every surface's emission with its metallic value so an
    EMIT bake yields a metallic mask.  Blender has no metallic bake type."""
    saved = []
    for mat in materials:
        tree = mat.node_tree
        bsdf = tree.nodes.get("Principled BSDF")
        if bsdf is None:
            continue
        metal_in = bsdf.inputs["Metallic"]
        value = float(metal_in.default_value)
        emit_col = bsdf.inputs["Emission Color"]
        emit_str = bsdf.inputs["Emission Strength"]
        saved.append((bsdf, tuple(emit_col.default_value), float(emit_str.default_value),
                      [l for l in tree.links if l.to_socket is emit_col]))
        for link in list(tree.links):
            if link.to_socket is emit_col:
                tree.links.remove(link)
        emit_col.default_value = (value, value, value, 1.0)
        emit_str.default_value = 1.0
    return saved


def _metallic_restore(saved):
    for bsdf, col, strength, links in saved:
        bsdf.inputs["Emission Color"].default_value = col
        bsdf.inputs["Emission Strength"].default_value = strength
        for link in links:
            try:
                bsdf.id_data.node_tree.links.new(link.from_socket, bsdf.inputs["Emission Color"])
            except Exception:
                pass


def bake_asset(scene, objects, materials, atlas_size, prefix,
               samples=None, want_orm=True, want_normal=True):
    """Run every pass and return {'basecolor': img, 'orm': img|None, ...}."""
    samples = samples or BAKE["samples"]
    device = _configure_cycles(scene, samples)
    out = {}

    # Two passes, composited.
    #
    # `COMBINED` is the lit read, but a third of the atlas belongs to faces
    # buried inside solids (every `box()` writes all six sides) and to arrises
    # whose ambient rays self-hit on a coincident neighbour, and those texels
    # bake to exact zero.  A ray-free albedo pass provides the ambient floor, so
    # a surface that the ray passes could not resolve degrades to flat albedo
    # instead of to a black hole.
    albedo = _image(f"{prefix}_albedo_tmp", atlas_size)
    bake_pass(scene, objects, materials, albedo, "DIFFUSE", 1,
              direct=False, indirect=False, color=True)
    lit = _image(f"{prefix}_lit_tmp", atlas_size)
    bake_pass(scene, objects, materials, lit, "COMBINED", samples)
    a = image_to_array(albedo)
    l = image_to_array(lit)
    comp = np.maximum(l[:, :, :3], a[:, :, :3] * BAKE["ambient_floor"])
    out_rgba = np.ones_like(l)
    out_rgba[:, :, :3] = np.clip(comp, 0.0, 1.0)
    # The baked base colour is a soft irradiance-modulated map, which is exactly
    # what JPEG is good at: 4096 PNG costs 6.5 MB against roughly 1.6 MB at q92,
    # with no visible difference on a surface the runtime renders unlit.  The
    # data maps stay PNG.
    #
    # Blender's glTF exporter decides PNG-vs-JPEG from the image DATABLOCK's
    # source, not from `file_format` on a generated image, so the map is written
    # to disk and re-loaded as a file-backed image.  `save()` (not
    # `save_render()`) is required: the latter would bake the view transform in.
    base = array_to_image(f"{prefix}_basecolor_tmp", out_rgba, file_format="JPEG")
    jpeg_dir = JPEG_DIR
    jpeg_dir.mkdir(parents=True, exist_ok=True)
    jpeg_path = jpeg_dir / f"{prefix}_basecolor.jpg"
    prev_quality = scene.render.image_settings.quality
    prev_format = scene.render.image_settings.file_format
    scene.render.image_settings.file_format = "JPEG"
    scene.render.image_settings.quality = BAKE["basecolor_jpeg_quality"]
    base.filepath_raw = str(jpeg_path)
    base.save()
    scene.render.image_settings.quality = prev_quality
    scene.render.image_settings.file_format = prev_format
    bpy.data.images.remove(base)
    stale = bpy.data.images.get(f"{prefix}_basecolor")
    if stale is not None:
        bpy.data.images.remove(stale)
    base = bpy.data.images.load(str(jpeg_path), check_existing=False)
    base.name = f"{prefix}_basecolor"
    lit_fraction = float((l[:, :, :3].max(axis=2) > 0.012).mean())
    for tmp in (albedo, lit):
        bpy.data.images.remove(tmp)
    out["basecolor"] = base
    out["lit_fraction"] = round(lit_fraction, 4)

    if want_orm:
        orm_size = min(atlas_size, BAKE["orm_atlas"])
        ao = _image(f"{prefix}_ao_tmp", orm_size, non_color=True)
        bake_pass(scene, objects, materials, ao, "AO", max(64, samples // 3))
        rough = _image(f"{prefix}_rough_tmp", orm_size, non_color=True)
        bake_pass(scene, objects, materials, rough, "ROUGHNESS", 8)
        saved = _metallic_probe(materials)
        metal = _image(f"{prefix}_metal_tmp", orm_size, non_color=True)
        bake_pass(scene, objects, materials, metal, "EMIT", 8)
        _metallic_restore(saved)
        a = image_to_array(ao)
        r = image_to_array(rough)
        m = image_to_array(metal)
        packed = np.ones((orm_size, orm_size, 4), dtype=np.float32)
        packed[:, :, 0] = np.clip(a[:, :, 0], 0.0, 1.0)
        packed[:, :, 1] = np.clip(r[:, :, 0], 0.02, 1.0)
        packed[:, :, 2] = np.clip(m[:, :, 0], 0.0, 1.0)
        out["orm"] = array_to_image(f"{prefix}_orm", packed, non_color=True)
        for tmp in (ao, rough, metal):
            bpy.data.images.remove(tmp)

    if want_normal:
        nrm_size = min(atlas_size, BAKE["orm_atlas"])
        nrm = _image(f"{prefix}_normal", nrm_size, non_color=True)
        bake_pass(scene, objects, materials, nrm, "NORMAL", 12,
                  clear=(0.5, 0.5, 1.0, 1.0))
        out["normal"] = nrm

    _detach_targets(materials)
    out["device"] = device
    return out


def is_special(mat_name: str) -> bool:
    return mat_name in SPECIAL
