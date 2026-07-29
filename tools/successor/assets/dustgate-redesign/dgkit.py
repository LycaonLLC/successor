"""Deterministic Blender construction kit for the Dustgate Opus-5 redesign study.

Source-stage only. Nothing here writes to runtime asset roots, the fixture, or
any canonical id. Every mesh is built from explicit vertex/face lists so a
rebuild is byte-stable for a given Blender version.

Blender authoring basis (Z-up):
    +X east, +Y north, -Y south, +Z up.
glTF export (Y-up) maps (x, y, z)_blender -> (x, z, -y)_gltf, so the exported
asset lands on the Successor world basis: +X east, -Z north, +Z south, +Y up.
That keeps `front = "+Z"` (south) identical to the shipped structure manifests.
"""

from __future__ import annotations

import math
import os
from typing import Iterable, Sequence

import bmesh  # type: ignore
import bpy  # type: ignore
from mathutils import Euler, Vector  # type: ignore

# --------------------------------------------------------------------------
# scene lifecycle
# --------------------------------------------------------------------------


def reset() -> None:
    """Wipe every datablock so a run is independent of prior state."""
    bpy.ops.wm.read_factory_settings(use_empty=True)
    for collection in (
        bpy.data.objects,
        bpy.data.meshes,
        bpy.data.materials,
        bpy.data.cameras,
        bpy.data.lights,
        bpy.data.images,
        bpy.data.worlds,
    ):
        for block in list(collection):
            collection.remove(block)
    scene = bpy.context.scene
    scene.unit_settings.system = "METRIC"
    scene.unit_settings.scale_length = 1.0


# --------------------------------------------------------------------------
# materials
# --------------------------------------------------------------------------


def srgb_to_linear(component: float) -> float:
    if component <= 0.04045:
        return component / 12.92
    return ((component + 0.055) / 1.055) ** 2.4


def hex_rgb(value: str) -> tuple[float, float, float]:
    value = value.lstrip("#")
    raw = tuple(int(value[i : i + 2], 16) / 255.0 for i in (0, 2, 4))
    return tuple(srgb_to_linear(c) for c in raw)  # type: ignore[return-value]


def relative_luminance(value: str) -> float:
    """sRGB relative luminance of a palette swatch, for value-band planning."""
    r, g, b = hex_rgb(value)
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def mat(
    name: str,
    color: str,
    rough: float = 0.85,
    metal: float = 0.0,
    emission: str | None = None,
    emission_strength: float = 0.0,
) -> bpy.types.Material:
    existing = bpy.data.materials.get(name)
    if existing is not None:
        return existing
    material = bpy.data.materials.new(name)
    material.use_nodes = True
    bsdf = material.node_tree.nodes["Principled BSDF"]
    # Every solid here is closed, so cull backfaces: glTF then exports
    # doubleSided:false instead of doubling the fragment cost of every surface.
    material.use_backface_culling = True
    r, g, b = hex_rgb(color)
    bsdf.inputs["Base Color"].default_value = (r, g, b, 1.0)
    bsdf.inputs["Roughness"].default_value = rough
    bsdf.inputs["Metallic"].default_value = metal
    if emission is not None:
        er, eg, eb = hex_rgb(emission)
        bsdf.inputs["Emission Color"].default_value = (er, eg, eb, 1.0)
        bsdf.inputs["Emission Strength"].default_value = emission_strength
    material["dg_hex"] = color
    material["dg_luminance"] = round(relative_luminance(color), 4)
    return material


# --------------------------------------------------------------------------
# mesh construction
# --------------------------------------------------------------------------
def mesh_from(
    name: str,
    verts: Sequence[Sequence[float]],
    faces: Sequence[Sequence[int]],
    material: bpy.types.Material,
    recalc: bool = True,
) -> bpy.types.Object:
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata([tuple(v) for v in verts], [], [tuple(f) for f in faces])
    mesh.validate(verbose=False)
    mesh.update()
    mesh.materials.append(material)
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.scene.collection.objects.link(obj)
    if recalc:
        recalc_normals(obj)
    return obj


def recalc_normals(obj: bpy.types.Object) -> None:
    """Force outward-consistent normals so hand-authored winding cannot invert."""
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(obj.data)
    bm.free()
    obj.data.update()


def rect_poly(
    cx: float,
    cy: float,
    sx: float,
    sy: float,
    chamfer: float = 0.0,
    corner_segments: int = 1,
) -> list[tuple[float, float]]:
    """CCW-from-above rectangle outline with chamfered or rounded corners."""
    hx, hy = sx * 0.5, sy * 0.5
    c = max(0.0, min(chamfer, hx - 1e-4, hy - 1e-4))
    if c <= 1e-6:
        return [
            (cx + hx, cy - hy),
            (cx + hx, cy + hy),
            (cx - hx, cy + hy),
            (cx - hx, cy - hy),
        ]
    corners = [
        (cx + hx - c, cy - hy + c, -math.pi * 0.5),
        (cx + hx - c, cy + hy - c, 0.0),
        (cx - hx + c, cy + hy - c, math.pi * 0.5),
        (cx - hx + c, cy - hy + c, math.pi),
    ]
    pts: list[tuple[float, float]] = []
    for ox, oy, start in corners:
        for step in range(corner_segments + 1):
            angle = start + (math.pi * 0.5) * (step / corner_segments)
            pts.append((ox + math.cos(angle) * c, oy + math.sin(angle) * c))
    # drop duplicate seam points introduced by shared corner tangents
    cleaned: list[tuple[float, float]] = []
    for point in pts:
        if not cleaned or (
            abs(point[0] - cleaned[-1][0]) > 1e-6 or abs(point[1] - cleaned[-1][1]) > 1e-6
        ):
            cleaned.append(point)
    if (
        abs(cleaned[0][0] - cleaned[-1][0]) < 1e-6
        and abs(cleaned[0][1] - cleaned[-1][1]) < 1e-6
    ):
        cleaned.pop()
    return cleaned


def loft(
    name: str,
    rings: Sequence[tuple[float, Sequence[tuple[float, float]]]],
    material: bpy.types.Material,
    cap_bottom: bool = True,
    cap_top: bool = True,
) -> bpy.types.Object:
    """Bridge equal-length CCW rings stacked along +Z into a closed solid."""
    count = len(rings[0][1])
    for _, poly in rings:
        if len(poly) != count:
            raise ValueError(f"{name}: ring vertex counts differ")
    verts: list[tuple[float, float, float]] = []
    for height, poly in rings:
        for x, y in poly:
            verts.append((x, y, height))
    faces: list[tuple[int, ...]] = []
    for level in range(len(rings) - 1):
        lower = level * count
        upper = (level + 1) * count
        for i in range(count):
            j = (i + 1) % count
            faces.append((lower + i, lower + j, upper + j, upper + i))
    if cap_bottom:
        faces.append(tuple(reversed(range(count))))
    if cap_top:
        base = (len(rings) - 1) * count
        faces.append(tuple(base + i for i in range(count)))
    return mesh_from(name, verts, faces, material)


def boxm(
    name: str,
    x0: float,
    x1: float,
    y0: float,
    y1: float,
    z0: float,
    z1: float,
    material: bpy.types.Material,
    chamfer: float = 0.0,
    corner_segments: int = 1,
    top_inset: float = 0.0,
    base_flare: float = 0.0,
) -> bpy.types.Object:
    """Axis-bounded solid. `top_inset` batters the top; `base_flare` widens the foot."""
    cx, cy = (x0 + x1) * 0.5, (y0 + y1) * 0.5
    sx, sy = x1 - x0, y1 - y0
    rings: list[tuple[float, Sequence[tuple[float, float]]]] = []
    if base_flare > 0.0:
        rings.append(
            (
                z0,
                rect_poly(cx, cy, sx + base_flare * 2, sy + base_flare * 2, chamfer, corner_segments),
            )
        )
        rings.append((z0 + base_flare, rect_poly(cx, cy, sx, sy, chamfer, corner_segments)))
    else:
        rings.append((z0, rect_poly(cx, cy, sx, sy, chamfer, corner_segments)))
    rings.append(
        (
            z1,
            rect_poly(
                cx,
                cy,
                max(sx - top_inset * 2, 1e-3),
                max(sy - top_inset * 2, 1e-3),
                chamfer,
                corner_segments,
            ),
        )
    )
    return loft(name, rings, material)


def prism(
    name: str,
    profile: Sequence[tuple[float, float]],
    axis: str,
    a0: float,
    a1: float,
    material: bpy.types.Material,
) -> bpy.types.Object:
    """Extrude a closed 2D profile along a world axis.

    axis 'x': profile points are (y, z); axis 'y': profile points are (x, z).
    Profile must be CCW in its own plane as seen from +axis.
    """
    verts: list[tuple[float, float, float]] = []
    count = len(profile)
    for a in (a0, a1):
        for p, q in profile:
            if axis == "x":
                verts.append((a, p, q))
            elif axis == "y":
                verts.append((p, a, q))
            else:
                raise ValueError("axis must be 'x' or 'y'")
    faces: list[tuple[int, ...]] = []
    for i in range(count):
        j = (i + 1) % count
        faces.append((i, j, count + j, count + i))
    faces.append(tuple(reversed(range(count))))
    faces.append(tuple(count + i for i in range(count)))
    obj = mesh_from(name, verts, faces, material)
    obj.data.validate(verbose=False)
    return obj


def arc_profile(
    radius: float,
    segments: int,
    base_z: float,
    center_u: float = 0.0,
    springing: float = 0.0,
    flatten: float = 1.0,
) -> list[tuple[float, float]]:
    """Half-arc profile (u, z) closed along its base, CCW."""
    pts: list[tuple[float, float]] = [(center_u + radius, base_z)]
    for step in range(1, segments):
        angle = math.pi * (step / segments)
        pts.append(
            (
                center_u + math.cos(angle) * radius,
                base_z + springing + math.sin(angle) * radius * flatten,
            )
        )
    pts.append((center_u - radius, base_z))
    return pts


def capsule(
    name: str,
    x: float,
    y: float,
    z0: float,
    radius: float,
    height: float,
    material: bpy.types.Material,
    radial: int = 16,
    cap_rings: int = 4,
) -> bpy.types.Object:
    """Plain scale proxy: a capsule of exactly `height` from `z0`."""
    if height < radius * 2:
        raise ValueError("capsule height must exceed its diameter")
    body = height - radius * 2
    rings: list[tuple[float, Sequence[tuple[float, float]]]] = []

    def circle(r: float) -> list[tuple[float, float]]:
        return [
            (
                x + math.cos(2 * math.pi * i / radial) * r,
                y + math.sin(2 * math.pi * i / radial) * r,
            )
            for i in range(radial)
        ]

    for step in range(cap_rings + 1):
        theta = (math.pi * 0.5) * (step / cap_rings)
        rings.append((z0 + radius - math.cos(theta) * radius, circle(math.sin(theta) * radius)))
    rings.append((z0 + radius + body, circle(radius)))
    for step in range(1, cap_rings + 1):
        theta = (math.pi * 0.5) * (step / cap_rings)
        rings.append(
            (
                z0 + radius + body + math.sin(theta) * radius,
                circle(math.cos(theta) * radius),
            )
        )
    return loft(name, rings, material, cap_bottom=True, cap_top=True)


def ground_plane(name: str, size: float, material: bpy.types.Material, z: float = 0.0) -> bpy.types.Object:
    half = size * 0.5
    verts = [(-half, -half, z), (half, -half, z), (half, half, z), (-half, half, z)]
    return mesh_from(name, verts, [(0, 1, 2, 3)], material, recalc=False)


def circle_poly(cx: float, cy: float, radius: float, segments: int) -> list[tuple[float, float]]:
    """CCW-from-above circle outline."""
    return [
        (
            cx + math.cos(2 * math.pi * i / segments) * radius,
            cy + math.sin(2 * math.pi * i / segments) * radius,
        )
        for i in range(segments)
    ]


def cylinder(
    name: str,
    cx: float,
    cy: float,
    z0: float,
    z1: float,
    radius: float,
    material: bpy.types.Material,
    segments: int = 24,
    top_radius: float | None = None,
) -> bpy.types.Object:
    """Straight or tapered drum. `top_radius` near zero gives a cone."""
    top = radius if top_radius is None else max(top_radius, 1e-3)
    rings = [
        (z0, circle_poly(cx, cy, radius, segments)),
        (z1, circle_poly(cx, cy, top, segments)),
    ]
    return loft(name, rings, material)


def slab_sloped(
    name: str,
    x0: float,
    x1: float,
    y0: float,
    y1: float,
    z_south: float,
    z_north: float,
    thickness: float,
    material: bpy.types.Material,
) -> bpy.types.Object:
    """Monopitch slab. Top plane runs from `z_south` at y0 to `z_north` at y1."""
    top = [
        (x0, y0, z_south),
        (x1, y0, z_south),
        (x1, y1, z_north),
        (x0, y1, z_north),
    ]
    verts = [(x, y, z - thickness) for x, y, z in top] + list(top)
    faces = [
        (0, 1, 2, 3),
        (4, 5, 6, 7),
        (0, 1, 5, 4),
        (1, 2, 6, 5),
        (2, 3, 7, 6),
        (3, 0, 4, 7),
    ]
    return mesh_from(name, verts, faces, material)


def join(name: str, objects: Sequence[bpy.types.Object]) -> bpy.types.Object:
    """Join meshes into one object, preserving the first object's transform."""
    objects = [o for o in objects if o is not None]
    if not objects:
        raise ValueError("join needs at least one object")
    if len(objects) == 1:
        objects[0].name = name
        objects[0].data.name = name
        return objects[0]
    bpy.ops.object.select_all(action="DESELECT")
    for obj in objects:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = objects[0]
    bpy.ops.object.join()
    result = bpy.context.view_layer.objects.active
    result.name = name
    result.data.name = name
    return result


# --------------------------------------------------------------------------
# lighting, world, camera
# --------------------------------------------------------------------------


def setup_world(
    horizon: str = "#c9ad82",
    zenith: str = "#8fa9c4",
    strength: float = 0.62,
) -> None:
    world = bpy.data.worlds.new("DG_World")
    world.use_nodes = True
    bpy.context.scene.world = world
    tree = world.node_tree
    tree.nodes.clear()
    out = tree.nodes.new("ShaderNodeOutputWorld")
    bg = tree.nodes.new("ShaderNodeBackground")
    grad = tree.nodes.new("ShaderNodeTexGradient")
    grad.gradient_type = "LINEAR"
    ramp = tree.nodes.new("ShaderNodeValToRGB")
    ramp.color_ramp.elements[0].position = 0.42
    ramp.color_ramp.elements[0].color = (*hex_rgb(horizon), 1.0)
    ramp.color_ramp.elements[1].position = 0.62
    ramp.color_ramp.elements[1].color = (*hex_rgb(zenith), 1.0)
    mapping = tree.nodes.new("ShaderNodeMapping")
    tex = tree.nodes.new("ShaderNodeTexCoord")
    mapping.inputs["Rotation"].default_value = (math.radians(90.0), 0.0, 0.0)
    tree.links.new(tex.outputs["Generated"], mapping.inputs["Vector"])
    tree.links.new(mapping.outputs["Vector"], grad.inputs["Vector"])
    tree.links.new(grad.outputs["Fac"], ramp.inputs["Fac"])
    tree.links.new(ramp.outputs["Color"], bg.inputs["Color"])
    bg.inputs["Strength"].default_value = strength
    tree.links.new(bg.outputs["Background"], out.inputs["Surface"])


def add_sun(
    name: str = "DG_Sun",
    azimuth_deg: float = 215.0,
    elevation_deg: float = 52.0,
    energy: float = 4.1,
    color: str = "#ffe9c6",
    angle_deg: float = 1.4,
) -> bpy.types.Object:
    """Azimuth is compass degrees (0 = north, 90 = east) of the sun's position."""
    light = bpy.data.lights.new(name, type="SUN")
    light.energy = energy
    light.color = hex_rgb(color)
    light.angle = math.radians(angle_deg)
    obj = bpy.data.objects.new(name, light)
    bpy.context.scene.collection.objects.link(obj)
    az = math.radians(azimuth_deg)
    el = math.radians(elevation_deg)
    position = Vector(
        (
            math.sin(az) * math.cos(el),
            math.cos(az) * math.cos(el),
            math.sin(el),
        )
    )
    obj.rotation_euler = (-position).to_track_quat("-Z", "Y").to_euler()
    obj["dg_azimuth_deg"] = azimuth_deg
    obj["dg_elevation_deg"] = elevation_deg
    return obj


GAMEPLAY_PITCH_DEG = 60.0
GAMEPLAY_YAW_DEG = 0.0
GAMEPLAY_DISTANCE_CELLS = 96.0
GAMEPLAY_BASE_FRUSTUM_CELLS = 12.5


def add_camera(
    name: str,
    target: tuple[float, float, float],
    frustum_height_cells: float,
    pitch_deg: float = GAMEPLAY_PITCH_DEG,
    yaw_deg: float = GAMEPLAY_YAW_DEG,
    distance: float = GAMEPLAY_DISTANCE_CELLS,
) -> bpy.types.Object:
    """Successor gameplay camera: orthographic, north-up, yaw locked at 0."""
    cam = bpy.data.cameras.new(name)
    cam.type = "ORTHO"
    cam.ortho_scale = frustum_height_cells
    cam.sensor_fit = "VERTICAL"
    cam.clip_start = 0.1
    cam.clip_end = distance * 4.0
    obj = bpy.data.objects.new(name, cam)
    bpy.context.scene.collection.objects.link(obj)
    pitch = math.radians(pitch_deg)
    yaw = math.radians(yaw_deg)
    # Blender: -Y is south. Camera sits south of and above the target.
    back = Vector(
        (
            math.sin(yaw) * math.cos(pitch),
            -math.cos(yaw) * math.cos(pitch),
            math.sin(pitch),
        )
    )
    obj.location = Vector(target) + back * distance
    obj.rotation_euler = Euler(
        (math.radians(90.0 - pitch_deg), 0.0, math.radians(yaw_deg)), "XYZ"
    )
    obj["dg_pitch_deg"] = pitch_deg
    obj["dg_frustum_cells"] = frustum_height_cells
    return obj


def add_ortho_camera_axis(
    name: str,
    target: tuple[float, float, float],
    axis: str,
    frustum_height: float,
    distance: float = 120.0,
) -> bpy.types.Object:
    """Elevation/plan cameras for the proof packet."""
    cam = bpy.data.cameras.new(name)
    cam.type = "ORTHO"
    cam.ortho_scale = frustum_height
    cam.sensor_fit = "VERTICAL"
    cam.clip_start = 0.1
    cam.clip_end = distance * 4.0
    obj = bpy.data.objects.new(name, cam)
    bpy.context.scene.collection.objects.link(obj)
    directions = {
        # name -> (offset direction from target, euler)
        "south": ((0.0, -1.0, 0.0), (math.radians(90.0), 0.0, 0.0)),
        "north": ((0.0, 1.0, 0.0), (math.radians(90.0), 0.0, math.radians(180.0))),
        "east": ((1.0, 0.0, 0.0), (math.radians(90.0), 0.0, math.radians(90.0))),
        "west": ((-1.0, 0.0, 0.0), (math.radians(90.0), 0.0, math.radians(-90.0))),
        "top": ((0.0, 0.0, 1.0), (0.0, 0.0, 0.0)),
    }
    offset, euler = directions[axis]
    obj.location = Vector(target) + Vector(offset) * distance
    obj.rotation_euler = Euler(euler, "XYZ")
    return obj


def configure_render(
    res_x: int = 1600,
    res_y: int = 900,
    samples: int = 64,
    engine: str = "BLENDER_EEVEE_NEXT",
    film_transparent: bool = False,
    view_transform: str = "AgX",
    look: str = "AgX - Base Contrast",
) -> None:
    scene = bpy.context.scene
    scene.render.engine = engine
    scene.render.resolution_x = res_x
    scene.render.resolution_y = res_y
    scene.render.resolution_percentage = 100
    scene.render.film_transparent = film_transparent
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGBA" if film_transparent else "RGB"
    scene.render.image_settings.compression = 20
    if engine == "CYCLES":
        scene.cycles.samples = samples
        scene.cycles.use_denoising = True
        scene.cycles.device = "CPU"
        scene.cycles.seed = 20260729
    else:
        scene.eevee.taa_render_samples = samples
        scene.eevee.use_shadows = True
        if hasattr(scene.eevee, "use_raytracing"):
            scene.eevee.use_raytracing = True
        if hasattr(scene.eevee, "shadow_ray_count"):
            scene.eevee.shadow_ray_count = 2
        if hasattr(scene.eevee, "shadow_step_count"):
            scene.eevee.shadow_step_count = 6
    scene.view_settings.view_transform = view_transform
    try:
        scene.view_settings.look = look
    except TypeError:
        scene.view_settings.look = "None"


def render_to(path: str, camera: bpy.types.Object, res_x: int | None = None, res_y: int | None = None) -> str:
    scene = bpy.context.scene
    scene.camera = camera
    if res_x is not None:
        scene.render.resolution_x = res_x
    if res_y is not None:
        scene.render.resolution_y = res_y
    os.makedirs(os.path.dirname(path), exist_ok=True)
    scene.render.filepath = path
    bpy.ops.render.render(write_still=True)
    return path


# --------------------------------------------------------------------------
# measurement
# --------------------------------------------------------------------------


def world_bounds(objects: Iterable[bpy.types.Object]) -> dict[str, float]:
    lo = [float("inf")] * 3
    hi = [float("-inf")] * 3
    for obj in objects:
        if obj.type != "MESH":
            continue
        for corner in obj.bound_box:
            world = obj.matrix_world @ Vector(corner)
            for axis in range(3):
                lo[axis] = min(lo[axis], world[axis])
                hi[axis] = max(hi[axis], world[axis])
    return {
        "minX": round(lo[0], 5),
        "maxX": round(hi[0], 5),
        "minY": round(lo[1], 5),
        "maxY": round(hi[1], 5),
        "minZ": round(lo[2], 5),
        "maxZ": round(hi[2], 5),
        "spanX": round(hi[0] - lo[0], 5),
        "spanY": round(hi[1] - lo[1], 5),
        "spanZ": round(hi[2] - lo[2], 5),
    }


def triangle_count(objects: Iterable[bpy.types.Object]) -> int:
    total = 0
    for obj in objects:
        if obj.type != "MESH":
            continue
        for poly in obj.data.polygons:
            total += max(0, len(poly.vertices) - 2)
    return total


def mesh_objects() -> list[bpy.types.Object]:
    return [o for o in bpy.context.scene.objects if o.type == "MESH"]


# --------------------------------------------------------------------------
# export
# --------------------------------------------------------------------------


def export_glb(path: str, objects: Sequence[bpy.types.Object]) -> str:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    bpy.ops.object.select_all(action="DESELECT")
    for obj in objects:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = objects[0] if objects else None
    kwargs = dict(
        filepath=path,
        export_format="GLB",
        use_selection=True,
        export_apply=True,
        export_yup=True,
        export_materials="EXPORT",
        export_cameras=False,
        export_lights=False,
        export_extras=False,
        export_animations=False,
    )
    try:
        bpy.ops.export_scene.gltf(**kwargs)
    except TypeError:
        kwargs.pop("export_animations", None)
        bpy.ops.export_scene.gltf(**kwargs)
    return path


def save_blend(path: str) -> str:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    bpy.ops.wm.save_as_mainfile(filepath=path, compress=False, copy=False)
    return path
