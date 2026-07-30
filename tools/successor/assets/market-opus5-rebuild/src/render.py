"""Inspection / proof renderer for the scheme-E market.

  blender -b build/market_house_full.blend --factory-startup -noaudio \
      -P src/render.py -- --out proofs/pass2 --res 760 --samples 28 --views all

Rig rules learned from the pass-1 failures:
  * the door proof must MUTE the NLA tracks before moving `door_slide`, or the
    manual transform is overwritten by animation evaluation and the closed/open
    images come out pixel-identical;
  * a roof cutaway must hide `roof__`, which is where the ceilings live;
  * interior proofs need real area lights in the RIG (never exported), or the
    authored emissive fixtures alone leave the floor black.
"""
import math
import os
import sys

import bpy
from mathutils import Vector

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []


def arg(k, d=None):
    return argv[argv.index(k) + 1] if k in argv else d


OUT = arg("--out", "proofs/pass2")
RES = int(arg("--res", "760"))
SAMPLES = int(arg("--samples", "28"))
VIEWS = arg("--views", "all").split(",")
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = OUT if os.path.isabs(OUT) else os.path.join(ROOT, OUT)
os.makedirs(OUT, exist_ok=True)
TRAVEL = -2.60
RIG = []


def _clear_rig():
    for ob in RIG:
        if ob.name in bpy.data.objects:
            bpy.data.objects.remove(ob, do_unlink=True)
    RIG.clear()
    for ob in list(bpy.data.objects):
        if ob.type in ('CAMERA', 'LIGHT'):
            bpy.data.objects.remove(ob, do_unlink=True)


def area(name, loc, size, energy, color=(1.0, 0.86, 0.68), rot=(0, 0, 0)):
    ld = bpy.data.lights.new(name, 'AREA')
    ld.shape = 'RECTANGLE'
    ld.size, ld.size_y = size[0], size[1]
    ld.energy = energy
    ld.color = color
    ob = bpy.data.objects.new(name, ld)
    bpy.context.scene.collection.objects.link(ob)
    ob.location = loc
    ob.rotation_euler = rot
    RIG.append(ob)
    return ob


def scene_setup(diagnostic=False, interior=False):
    _clear_rig()
    sc = bpy.context.scene
    sc.render.engine = 'CYCLES'
    sc.cycles.device = 'CPU'
    sc.cycles.samples = SAMPLES
    sc.cycles.use_denoising = True
    sc.cycles.max_bounces = 6 if interior else 4
    sc.cycles.caustics_reflective = False
    sc.cycles.caustics_refractive = False
    sc.render.resolution_x = RES
    sc.render.resolution_y = int(RES * 0.75)
    sc.render.resolution_percentage = 100
    sc.render.film_transparent = False
    sc.view_settings.view_transform = 'AgX'
    sc.view_settings.look = 'AgX - Base Contrast'
    sc.view_settings.exposure = -0.35
    w = bpy.data.worlds[0] if bpy.data.worlds else bpy.data.worlds.new("W")
    sc.world = w
    w.use_nodes = True
    nt = w.node_tree
    nt.nodes.clear()
    out = nt.nodes.new("ShaderNodeOutputWorld")
    bg = nt.nodes.new("ShaderNodeBackground")
    nt.links.new(bg.outputs[0], out.inputs[0])
    if diagnostic:
        bg.inputs[0].default_value = (0.42, 0.44, 0.48, 1)
        bg.inputs[1].default_value = 0.9
    else:
        sky = nt.nodes.new("ShaderNodeTexSky")
        sky.sky_type = 'MULTIPLE_SCATTERING'
        sky.sun_elevation = math.radians(42)
        sky.sun_rotation = math.radians(218)
        if hasattr(sky, "sun_disc"):
            sky.sun_disc = False
        for a, v in (("altitude", 320.0), ("air_density", 1.4),
                     ("dust_density", 3.0), ("ozone_density", 1.0)):
            if hasattr(sky, a):
                setattr(sky, a, v)
        nt.links.new(sky.outputs[0], bg.inputs[0])
        bg.inputs[1].default_value = 0.30
    ld = bpy.data.lights.new("Sun", 'SUN')
    if diagnostic:
        ld.energy, ld.angle, ld.color = 2.8, math.radians(0.6), (1, 1, 1)
    else:
        ld.energy, ld.angle, ld.color = 3.9, math.radians(1.4), (1.0, 0.93, 0.80)
    sun = bpy.data.objects.new("Sun", ld)
    bpy.context.scene.collection.objects.link(sun)
    RIG.append(sun)
    # diagnostic: 22 deg grazing from the south-west -- long shadows and
    # near-tangential incidence, which is what exposes surface defects.
    sun.rotation_euler = ((math.radians(68), 0, math.radians(145)) if diagnostic
                          else (math.radians(48), 0, math.radians(218)))
    if "GroundPlane" not in bpy.data.objects:
        bpy.ops.mesh.primitive_plane_add(size=280, location=(0, 0, 0.0))
        g = bpy.context.active_object
        g.name = "GroundPlane"
        m = bpy.data.materials.new("Ground")
        m.use_nodes = True
        b = m.node_tree.nodes["Principled BSDF"]
        b.inputs["Base Color"].default_value = (0.150, 0.116, 0.079, 1)
        b.inputs["Roughness"].default_value = 0.96
        g.data.materials.append(m)
    if interior:
        # RIG-ONLY practical lighting.  Never exported: render.py builds these
        # after the GLBs are written, and build_market.py creates no lights.
        area("L_hall", (-0.3, -0.9, 3.25), (6.4, 3.4), 260)
        area("L_service", (0.0, 1.35, 3.05), (8.6, 1.1), 150, (1.0, 0.90, 0.76))
        # one practical per niche, standing in for the authored wash fixture at
        # the niche head, so the terminal a player interacts with is legible
        for nx in (-2.375, 0.475, 3.325):
            area(f"L_niche_{nx}", (nx, 1.98, 2.24), (0.84, 0.30), 26,
                 (1.0, 0.88, 0.72), rot=(math.radians(-34), 0, 0))
        area("L_boh", (0.0, 3.05, 2.52), (7.4, 1.2), 150, (0.98, 0.95, 0.90))
        # daylight arriving THROUGH the clerestory: a wide, cool source angled
        # down into the staff aisle from the valley slot. This is the light the
        # roof fold exists to deliver, so the proofs must show it.
        area("L_clerestory", (0.0, 1.98, 3.72), (9.0, 0.55), 420,
             (0.90, 0.94, 1.0), rot=(math.radians(58), 0, 0))
        area("L_bay", (4.2, -2.8, 2.6), (2.0, 1.4), 60)
        area("L_entry", (-0.3, -3.6, 2.9), (3.0, 1.0), 70)
        area("L_vendor", (-4.6, -0.8, 2.6), (1.2, 2.8), 60)


def cam(loc, target, ortho=None, lens=42, shift=0.0):
    c = bpy.data.cameras.new("C")
    if ortho:
        c.type = 'ORTHO'
        c.ortho_scale = ortho
    else:
        c.lens = lens
    c.shift_y = shift
    ob = bpy.data.objects.new("C", c)
    bpy.context.scene.collection.objects.link(ob)
    RIG.append(ob)
    ob.location = Vector(loc)
    ob.rotation_euler = (Vector(target) - Vector(loc)).to_track_quat('-Z', 'Y').to_euler()
    bpy.context.scene.camera = ob
    return ob


def hide(prefixes, val=True):
    for ob in bpy.data.objects:
        if any(ob.name.startswith(p) for p in prefixes):
            ob.hide_render = val


def door(open_):
    """Set the door state deterministically: NLA off, then transform."""
    d = bpy.data.objects.get("door_slide")
    if not d:
        return
    if d.animation_data:
        for t in d.animation_data.nla_tracks:
            t.mute = True
        d.animation_data.action = None
        d.animation_data.use_nla = False
    d.location = (TRAVEL if open_ else 0.0, 0.0, 0.0)
    d.matrix_basis = d.matrix_basis      # force recompute
    bpy.context.view_layer.update()


def shoot(name):
    sc = bpy.context.scene
    sc.render.filepath = os.path.join(OUT, name + ".png")
    sc.render.image_settings.file_format = 'PNG'
    bpy.ops.render.render(write_still=True)
    print("RENDERED", name, flush=True)


VIEWDEFS = {}


def view(fn):
    VIEWDEFS[fn.__name__] = fn
    return fn


def cam_top(z, ortho, cx=0.0, cy=0.35):
    c = bpy.data.cameras.new("C")
    c.type = 'ORTHO'
    c.ortho_scale = ortho
    ob = bpy.data.objects.new("C", c)
    bpy.context.scene.collection.objects.link(ob)
    RIG.append(ob)
    ob.location = (cx, cy, z)
    ob.rotation_euler = (0.0, 0.0, 0.0)      # straight down, +Y (north) up
    bpy.context.scene.camera = ob
    return ob


# ------------------------------------------------------------ orthographic set
@view
def front():
    scene_setup()
    cam((0, -26, 6.2), (0, 0, 2.7), ortho=13.6)
    shoot("01_front")


@view
def back():
    scene_setup()
    cam((0, 26, 6.2), (0, 0.4, 2.7), ortho=13.6)
    shoot("02_back")


@view
def left():
    scene_setup()
    cam((-26, 0.4, 6.2), (0, 0.4, 2.7), ortho=11.2)
    shoot("03_left")


@view
def right():
    scene_setup()
    cam((26, 0.4, 6.2), (0, 0.4, 2.7), ortho=11.2)
    shoot("04_right")


@view
def top():
    scene_setup()
    cam_top(46, 13.2)
    shoot("05_top")


@view
def three_quarter():
    scene_setup()
    cam((13.8, -15.2, 9.6), (0.1, -0.7, 2.5), lens=52)
    shoot("06_three_quarter")


@view
def gameplay_ortho():
    """Locked north-up pitched orthographic -- the game camera."""
    scene_setup()
    p = math.radians(52)
    d = 27
    cam((0, -d * math.cos(p), d * math.sin(p) + 1.0), (0, 0.35, 2.0), ortho=17.2)
    shoot("07_gameplay_ortho")


# ------------------------------------------------------------ interior set
@view
def interior_overview():
    scene_setup(interior=True)
    hide(["roof__"])
    p = math.radians(64)
    d = 18
    cam((0.0, -d * math.cos(p) + 0.4, d * math.sin(p)), (0.0, 0.35, 1.0), ortho=12.6)
    shoot("08_interior_roofoff")
    hide(["roof__"], False)


@view
def interior_eye():
    scene_setup(interior=True)
    door(True)
    cam((-0.30, -2.42, 1.66), (-0.15, 1.9, 1.45), lens=24)
    shoot("09_interior_eye_hall")
    door(False)


@view
def interior_vendor():
    scene_setup(interior=True)
    cam((2.35, -0.35, 1.66), (-5.2, -1.0, 1.15), lens=30)
    shoot("21_interior_eye_vendor")


@view
def interior_trainer():
    scene_setup(interior=True)
    cam((0.95, -0.55, 1.72), (4.45, -3.05, 1.00), lens=35)
    shoot("22_interior_eye_trainer")


@view
def interior_boh():
    scene_setup(interior=True)
    cam((1.30, 2.95, 1.62), (-4.90, 3.05, 1.05), lens=24)
    shoot("23_interior_eye_backofhouse")


@view
def interior_clerestory():
    scene_setup(interior=True)
    cam((-1.95, 2.95, 1.70), (2.90, 2.20, 3.60), lens=26)
    shoot("24_interior_clerestory")


# ------------------------------------------------------------ door proofs
@view
def door_closed():
    scene_setup()
    door(False)
    cam((3.60, -12.4, 3.30), (-0.35, -3.05, 1.75), lens=38)
    shoot("10_door_closed")


@view
def door_open():
    scene_setup()
    door(True)
    cam((3.60, -12.4, 3.30), (-0.35, -3.05, 1.75), lens=38)
    shoot("11_door_open")
    door(False)


@view
def crop_entrance():
    scene_setup()
    door(False)
    cam((3.15, -9.10, 2.35), (-0.45, -3.30, 1.75), lens=45)
    shoot("12_crop_entrance_door")


@view
def door_mechanism():
    scene_setup(interior=True)
    door(False)
    cam((2.30, -1.30, 2.30), (-1.45, -2.72, 2.40), lens=48)
    shoot("25_crop_door_mechanism")


# ------------------------------------------------------------ mandatory crops
@view
def crop_facade():
    scene_setup()
    cam((2.85, -7.0, 3.75), (-0.55, -3.55, 3.05), lens=92)
    shoot("13_crop_facade_hood")


@view
def crop_contact():
    scene_setup(diagnostic=True, interior=True)
    cam((0.55, -1.02, 1.18), (1.36, -2.76, 0.05), lens=52)
    shoot("14_crop_floor_wall_contact")


@view
def crop_counter():
    scene_setup(interior=True)
    hide(["roof__"])
    cam((-1.05, -2.25, 1.72), (-2.42, 2.10, 1.28), lens=32)
    shoot("15_crop_service_counter")
    hide(["roof__"], False)


@view
def crop_seam():
    scene_setup(diagnostic=True)
    cam((7.95, -6.35, 2.62), (5.42, -3.55, 2.18), lens=80)
    shoot("16_crop_uv_seam_corner")


@view
def rear_service():
    scene_setup()
    cam((-9.5, 12.8, 7.2), (-0.4, 3.2, 2.4), lens=50)
    shoot("17_rear_service")


@view
def roof_plant():
    scene_setup()
    cam((7.8, 10.6, 12.2), (0.4, 2.5, 4.4), lens=55)
    shoot("18_roof_plant_deck")


@view
def diag_massing():
    scene_setup(diagnostic=True)
    cam((12.6, -13.8, 8.8), (0.1, -0.6, 2.5), lens=52)
    shoot("19_diag_massing_raking")


@view
def crop_loggia():
    scene_setup()
    cam((-7.0, -6.9, 2.35), (-4.25, -3.55, 1.75), lens=58)
    shoot("20_crop_loggia")


@view
def crop_rear_detail():
    scene_setup()
    cam((-3.60, 8.2, 2.55), (0.85, 4.0, 1.85), lens=72)
    shoot("26_crop_rear_service_door")


@view
def crop_clerestory_ext():
    scene_setup()
    cam((-2.20, -5.6, 7.4), (0.20, 1.75, 4.05), lens=70)
    shoot("27_crop_clerestory_brise")


def main():
    names = list(VIEWDEFS) if VIEWS == ["all"] else VIEWS
    for n in names:
        if n not in VIEWDEFS:
            print("UNKNOWN VIEW", n)
            continue
        VIEWDEFS[n]()
    print("RENDER_SET_DONE")


main()
