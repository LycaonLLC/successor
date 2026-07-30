"""Inspection / proof renderer.

  blender -b <blend> --factory-startup -noaudio -P src/render.py -- \
      --out proofs/blockout --res 900 --samples 48 --views all
"""
import math
import os
import sys

import bpy
from mathutils import Vector

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []


def arg(k, d=None):
    return argv[argv.index(k) + 1] if k in argv else d


OUT = arg("--out", "proofs/blockout")
RES = int(arg("--res", "900"))
SAMPLES = int(arg("--samples", "48"))
VIEWS = arg("--views", "all").split(",")
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = OUT if os.path.isabs(OUT) else os.path.join(ROOT, OUT)
os.makedirs(OUT, exist_ok=True)


def scene_setup(diagnostic=False):
    sc = bpy.context.scene
    sc.render.engine = 'CYCLES'
    sc.cycles.device = 'CPU'
    sc.cycles.samples = SAMPLES
    sc.cycles.use_denoising = True
    sc.cycles.max_bounces = 6
    sc.cycles.caustics_reflective = False
    sc.cycles.caustics_refractive = False
    sc.render.resolution_x = RES
    sc.render.resolution_y = int(RES * 0.75)
    sc.render.resolution_percentage = 100
    sc.render.film_transparent = False
    sc.view_settings.view_transform = 'AgX'
    sc.view_settings.look = 'AgX - Base Contrast'
    sc.view_settings.exposure = 0.0
    # world
    w = bpy.data.worlds.new("W") if not bpy.data.worlds else bpy.data.worlds[0]
    sc.world = w
    w.use_nodes = True
    nt = w.node_tree
    nt.nodes.clear()
    out = nt.nodes.new("ShaderNodeOutputWorld")
    bg = nt.nodes.new("ShaderNodeBackground")
    nt.links.new(bg.outputs[0], out.inputs[0])
    if diagnostic:
        bg.inputs[0].default_value = (0.42, 0.44, 0.48, 1)
        bg.inputs[1].default_value = 0.85
    else:
        sky = nt.nodes.new("ShaderNodeTexSky")
        sky.sky_type = 'MULTIPLE_SCATTERING'
        sky.sun_elevation = math.radians(56)
        sky.sun_rotation = math.radians(214)
        if hasattr(sky, "sun_disc"):
            sky.sun_disc = False   # the sun lamp is the key; avoid double-counting
        for attr, val in (("altitude", 320.0), ("air_density", 1.5),
                          ("dust_density", 3.4), ("ozone_density", 1.0)):
            if hasattr(sky, attr):
                setattr(sky, attr, val)
        nt.links.new(sky.outputs[0], bg.inputs[0])
        bg.inputs[1].default_value = 0.34
    # sun
    for o in list(bpy.data.objects):
        if o.type == 'LIGHT':
            bpy.data.objects.remove(o, do_unlink=True)
    ld = bpy.data.lights.new("Sun", 'SUN')
    if diagnostic:
        ld.energy = 2.6
        ld.angle = math.radians(0.7)
        ld.color = (1.0, 1.0, 1.0)
    else:
        ld.energy = 3.4
        ld.angle = math.radians(1.7)
        ld.color = (1.0, 0.925, 0.80)
    sun = bpy.data.objects.new("Sun", ld)
    bpy.context.scene.collection.objects.link(sun)
    if diagnostic:
        # low raking light: exposes surface defects and unfinished sides
        sun.rotation_euler = (math.radians(76), 0, math.radians(58))
    else:
        sun.rotation_euler = (math.radians(34), 0, math.radians(214))
    # desert ground for bounce and grounding
    if "GroundPlane" not in bpy.data.objects:
        bpy.ops.mesh.primitive_plane_add(size=260, location=(0, 0, 0.0))
        g = bpy.context.active_object
        g.name = "GroundPlane"
        m = bpy.data.materials.new("Ground")
        m.use_nodes = True
        b = m.node_tree.nodes["Principled BSDF"]
        b.inputs["Base Color"].default_value = (0.255, 0.198, 0.138, 1)
        b.inputs["Roughness"].default_value = 0.96
        g.data.materials.append(m)


def cam(loc, target, ortho=None, lens=42, shiftz=0.0):
    c = bpy.data.cameras.new("C")
    if ortho:
        c.type = 'ORTHO'
        c.ortho_scale = ortho
    else:
        c.lens = lens
    ob = bpy.data.objects.new("C", c)
    bpy.context.scene.collection.objects.link(ob)
    ob.location = Vector(loc)
    d = Vector(target) - Vector(loc)
    ob.rotation_euler = d.to_track_quat('-Z', 'Y').to_euler()
    c.shift_y = shiftz
    bpy.context.scene.camera = ob
    return ob


def hide(prefixes, val=True):
    for o in bpy.data.objects:
        if any(o.name.startswith(p) for p in prefixes):
            o.hide_render = val


def door(open_):
    d = bpy.data.objects.get("door_slide")
    if d:
        d.location.x = -2.30 if open_ else 0.0


def shoot(name):
    sc = bpy.context.scene
    sc.render.filepath = os.path.join(OUT, name + ".png")
    sc.render.image_settings.file_format = 'PNG'
    bpy.ops.render.render(write_still=True)
    print("RENDERED", name, flush=True)


def clear_cams():
    for o in list(bpy.data.objects):
        if o.type == 'CAMERA':
            bpy.data.objects.remove(o, do_unlink=True)


VIEWDEFS = {}


def view(fn):
    VIEWDEFS[fn.__name__] = fn
    return fn


# ------------------------------------------------------------------ views
@view
def front():
    scene_setup()
    cam((0, -22, 7.4), (0, 0, 2.6), ortho=15.0)
    shoot("01_front")


@view
def back():
    scene_setup()
    cam((0, 22, 7.4), (0, 0, 2.6), ortho=15.0)
    shoot("02_back")


@view
def left():
    scene_setup()
    cam((-22, 0, 7.4), (0, 0, 2.6), ortho=13.0)
    shoot("03_left")


@view
def right():
    scene_setup()
    cam((22, 0, 7.4), (0, 0, 2.6), ortho=13.0)
    shoot("04_right")


@view
def top():
    scene_setup()
    cam((0, 0, 40), (0, 0, 0), ortho=14.0)
    shoot("05_top")


@view
def three_quarter():
    scene_setup()
    cam((13.5, -14.5, 9.2), (0.2, -0.3, 2.3), lens=52)
    shoot("06_three_quarter")


@view
def gameplay_ortho():
    """Locked north-up pitched orthographic, as the game camera sees it."""
    scene_setup()
    p = math.radians(52)
    d = 26
    cam((0, -d * math.cos(p), d * math.sin(p) + 1.0), (0, 0.2, 1.9), ortho=17.5)
    shoot("07_gameplay_ortho")


@view
def interior_overview():
    scene_setup()
    hide(["roof__"])
    p = math.radians(62)
    d = 17
    cam((0.2, -d * math.cos(p), d * math.sin(p)), (0.0, 0.35, 1.2), ortho=12.4)
    shoot("08_interior_roofoff")
    hide(["roof__"], False)


@view
def interior_eye():
    scene_setup()
    hide(["wall_front__"])
    door(True)
    cam((-0.5, -2.15, 1.68), (-0.2, 2.2, 1.35), lens=24)
    shoot("09_interior_eye")
    door(False)
    hide(["wall_front__"], False)


@view
def door_closed():
    scene_setup()
    door(False)
    cam((-1.4, -9.4, 2.7), (-0.5, -2.9, 1.5), lens=54)
    shoot("10_door_closed")


@view
def door_open():
    scene_setup()
    door(True)
    cam((-1.4, -9.4, 2.7), (-0.5, -2.9, 1.5), lens=54)
    shoot("11_door_open")
    door(False)


@view
def crop_entrance():
    scene_setup()
    door(True)
    cam((0.9, -6.2, 2.05), (-1.1, -3.0, 1.55), lens=70)
    shoot("12_crop_entrance_door")
    door(False)


@view
def crop_facade():
    scene_setup()
    cam((-6.6, -8.4, 3.3), (-4.4, -4.2, 2.35), lens=85)
    shoot("13_crop_facade_datum")


@view
def crop_contact():
    scene_setup(diagnostic=True)
    cam((-8.2, -3.1, 1.05), (-5.6, -1.6, 0.35), lens=88)
    shoot("14_crop_floor_wall_contact")


@view
def crop_counter():
    scene_setup()
    hide(["roof__", "wall_front__"])
    cam((-0.4, -3.4, 1.72), (-0.45, 1.5, 1.35), lens=50)
    shoot("15_crop_service_counter")
    hide(["roof__", "wall_front__"], False)


@view
def crop_seam():
    scene_setup(diagnostic=True)
    cam((7.6, -7.4, 2.9), (5.3, -4.3, 2.2), lens=95)
    shoot("16_crop_uv_seam_corner")


@view
def rear_service():
    scene_setup()
    cam((-8.5, 13.5, 6.4), (-0.6, 3.4, 2.2), lens=48)
    shoot("17_rear_service")


@view
def roof_plant():
    scene_setup()
    cam((6.4, 10.6, 11.4), (0.4, 2.4, 3.9), lens=52)
    shoot("18_roof_plant_deck")


@view
def diag_massing():
    scene_setup(diagnostic=True)
    cam((12.0, -13.0, 8.4), (0.2, -0.3, 2.3), lens=52)
    shoot("19_diag_massing")


@view
def trainer_bay():
    scene_setup()
    hide(["roof__", "wall_front__"])
    cam((0.9, -3.9, 2.25), (4.6, -2.6, 1.15), lens=40)
    shoot("20_trainer_bay")
    hide(["roof__", "wall_front__"], False)


def main():
    names = list(VIEWDEFS) if VIEWS == ["all"] else VIEWS
    for n in names:
        clear_cams()
        VIEWDEFS[n]()
    print("RENDER_SET_DONE")


main()
