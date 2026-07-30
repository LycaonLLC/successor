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


# ---------------------------------------------------------------------------
# SUN DIRECTION (pass-4, found by `build/diag/diag_sundir.py`)
# ---------------------------------------------------------------------------
# The rig's beauty sun was (48, 218), which resolves to a sun in the NORTH-WEST.
# The building's whole daylight premise is a SOUTH-facing clerestory shaded by a
# brise-soleil, and the public facade faces south.  So for three passes:
#   * the public south facade was in shade in every beauty proof;
#   * the clerestory received no direct sun at all -- which is why
#     `diag_daylight.py` measured sun+sky only 6 % brighter than sky alone;
#   * the brise-soleil shaded nothing.
# The sun is moved to the SOUTH-EAST at 42 deg altitude, which lights the public
# face, the clerestory, the east flank and the roof.  Blender's sun Euler is
# (tilt-from-vertical, 0, azimuth), so altitude = 90 - tilt.
SUN_BEAUTY = (48.0, 26.0)          # south-east, 42 deg altitude
SUN_RAKE_SW = (70.0, 305.0)        # low south-west, 20 deg: rakes S and W faces
SUN_RAKE_NE = (70.0, 125.0)        # low north-east, 20 deg: rakes N and E faces


def scene_setup(diagnostic=False, interior=False, sun=None):
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
        # PASS-4: interiors are lit at full sky strength.  Pass 3 rendered
        # interiors at 0.30 and made up the difference with a 420 W rig lamp
        # inside the aisle standing in for daylight the section could not
        # deliver.  The section delivers it now (`build/diag/diag_daylight.py`
        # measures the BOH at 2.96x brighter with sun+sky than with the authored
        # emissives alone), so the light in these pictures arrives through the
        # real glazing instead of from a lamp placed where the glazing should
        # have been.
        # exterior sky lifted 0.30 -> 0.55: with the sun correctly in the south,
        # the north/service elevation is genuinely in shade, and at 0.30 that
        # shade was too dark to read the authored finish.
        bg.inputs[1].default_value = 1.00 if interior else 0.55
    ld = bpy.data.lights.new("Sun", 'SUN')
    if diagnostic:
        ld.energy, ld.angle, ld.color = 2.8, math.radians(0.6), (1, 1, 1)
    else:
        ld.energy, ld.angle, ld.color = 3.9, math.radians(1.4), (1.0, 0.93, 0.80)
    sunob = bpy.data.objects.new("Sun", ld)
    bpy.context.scene.collection.objects.link(sunob)
    RIG.append(sunob)
    # Diagnostic views take a grazing 20 deg sun, and each may choose the side
    # it rakes from, because a corner lit from the opposite side is the least
    # informative picture available -- which is what the pass-3 corner crops
    # were: a south-west corner photographed with the sun in the north-east.
    el, az = sun if sun else ((SUN_RAKE_SW if diagnostic else SUN_BEAUTY))
    sunob.rotation_euler = (math.radians(el), 0, math.radians(az))
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
        # PASS-4: there is no longer a rig lamp standing in for daylight at the
        # clerestory.  In pass 3 the glazing could not be seen from any standing
        # eye, so a 420 W area light inside the aisle stood in for the light the
        # section could not actually deliver -- which meant the proofs showed
        # daylight the building did not have.  The section now delivers it: the
        # world sun and sky reach the BOH THROUGH the real glazing, and
        # `verify.py` measures the difference with the sun on and off.  Only a
        # small cool bounce off the aisle's own surfaces is retained.
        area("L_boh_bounce", (0.0, 2.90, 1.10), (7.0, 1.0), 26,
             (0.88, 0.92, 1.0), rot=(math.radians(-90), 0, 0))
        area("L_bay", (4.2, -2.8, 2.6), (2.0, 1.4), 60)
        area("L_entry", (-0.3, -3.6, 2.9), (3.0, 1.0), 70)
        area("L_vendor", (-4.6, -0.8, 2.6), (1.2, 2.8), 60)


def loggia_practicals():
    """Rig lamps standing in for the AUTHORED coffer downlights (log_coffer_lamp_*).

    The loggia soffit faces north and the beauty sun comes from the north-west,
    so the coffers sit in their own shadow.  The building answers that with
    recessed downlights; the render rig has to represent them or the proof
    shows an unlit soffit and proves nothing.
    """
    # The authored coffer downlights are EMISSIVE geometry and light the
    # soffit themselves; a rig lamp in the same place double-counts and blows
    # the pan to white.  The rig therefore adds only a low fill from the
    # arcade's open south side, standing in for ground bounce off the apron.
    area("L_log_fill", (-4.10, -2.60, 1.35), (3.2, 1.8), 26, (1.0, 0.93, 0.84),
         rot=(math.radians(78), 0, 0))


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
    # PASS-4 REVIEW DEFECT 5.  This was a RAISED inspection station at z 2.85,
    # because the pass-3 section made the clerestory invisible from any standing
    # eye.  The section was changed instead of the camera: the service wall head
    # dropped to 2.86 between expressed piers, the valley beam moved south of the
    # glazing plane, and the clerestory sill/head went with it.  This camera is
    # now a NORMAL STANDING EYE (1.65 m) in the BOH aisle.
    # ALONG the staff aisle, not up at the glass from underneath.  The BOH is
    # only 1.42 m deep, so a camera facing the glazing square-on fills the frame
    # with the deck soffit 0.9 m from the lens.  Looking west along the aisle
    # puts the glazed band across the top of the frame WITH the room it lights:
    # aisle floor, service wall, piers, transom and plant all in one view.
    cam((4.62, 3.02, 1.65), (-4.30, 2.68, 2.72), lens=20)
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
    cam((-8.40, -6.10, 2.86), (-5.56, -3.12, 2.62), lens=78)
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
    loggia_practicals()
    # Framed to read, not to maximise fill.  Aiming a long lens straight up at
    # a recessed luminaire gives a clipped white rectangle and proves nothing;
    # this stands at the arcade's east end and looks WEST ALONG it, so the two
    # coffer bays, the joists between them, the brass lips, the three unequal
    # piers, the ledge and the lit shopfront all appear in one frame -- which
    # is what "show the loggia" means.
    # PASS-4 REVIEW DEFECT 7.  The pass-3 station stood UNDER the soffit and
    # looked west along it, which the review read as "upward through a narrow
    # slot at one ceiling lamp".  You cannot show a 0.86 m deep arcade from
    # inside it.  This is an EXTERIOR OBLIQUE from the south-west: all three
    # unequal piers, both coffer bays with their joists and brass lips, the
    # goods ledge, the bench and the lit shopfront read in one frame, with the
    # datum band and corner pier giving it context.
    cam((-8.35, -6.95, 2.15), (-4.05, -3.70, 1.72), lens=42)
    shoot("20_crop_loggia")


@view
def crop_rear_detail():
    scene_setup()
    cam((1.34, 7.05, 1.92), (1.30, 3.80, 1.20), lens=42)
    shoot("26_crop_rear_service_door")


@view
def clerestory_ext_close():
    scene_setup()
    # from above the south roof plane, looking north at the glazing band, its
    # brise-soleil blades and the valley gutter the fold exists to drain
    # CHOSEN BY MEASUREMENT (diag_sweep.py): glazing band + brise + valley fill
    # 61.5% of the sampled frame from here.  Aimed down the fold from above the
    # south plane, which is the only station where the whole system is legible.
    cam((-1.60, -1.60, 5.60), (-0.60, 1.85, 3.80), lens=40)
    shoot("37_crop_clerestory_glazing")


@view
def crop_clerestory_ext():
    scene_setup()
    cam((-1.10, -3.20, 8.10), (0.30, 2.05, 4.10), lens=58)
    shoot("27_crop_clerestory_brise")


# ------------------------------------------------------------ pass-3 views
# These exist because the pass-3 review gate named specific things the old
# proof set did not actually demonstrate.  Each one is aimed at ONE claim.
@view
def term_bank():
    scene_setup(interior=True)
    hide(["roof__"])
    cam((-2.375, -0.62, 1.48), (-2.375, 1.72, 1.18), lens=40)
    shoot("28_term_bank_face")
    hide(["roof__"], False)


@view
def term_trade():
    scene_setup(interior=True)
    hide(["roof__"])
    cam((0.475, -0.62, 1.42), (0.475, 1.72, 1.06), lens=40)
    shoot("29_term_trade_face")
    hide(["roof__"], False)


@view
def term_assoc():
    scene_setup(interior=True)
    hide(["roof__"])
    cam((3.325, -0.62, 1.52), (3.325, 1.72, 1.24), lens=40)
    shoot("30_term_assoc_face")
    hide(["roof__"], False)


@view
def boh_route():
    scene_setup(interior=True)
    hide(["roof__"])
    # Standing IN the rear doorway, looking west along the proven staff route.
    # (A straight-south view from here faces the niche backs 1.16 m away: the
    # corridor runs east-west, so the proof must look along it.)
    # Standing on the rear threshold (y 3.61 is the inner wall face), looking
    # west along the proven staff route.  A straight-south view from here faces
    # the niche backs 1.16 m away, and y > 3.61 puts the camera INSIDE the wall
    # thickness, which is what made the first attempt a field of jamb.
    cam((1.30, 3.56, 1.55), (-2.60, 2.98, 1.02), lens=24)
    shoot("31_boh_route_from_rear_door")
    hide(["roof__"], False)


@view
def boh_route_along():
    scene_setup(interior=True)
    hide(["roof__"])
    cam((3.98, 3.03, 1.52), (-4.90, 3.02, 1.06), lens=20)
    shoot("32_boh_route_along_aisle")
    hide(["roof__"], False)


@view
def trainer_booth():
    scene_setup(interior=True)
    hide(["roof__"])
    cam((4.20, -0.95, 1.60), (4.24, -3.30, 0.86), lens=26)
    shoot("33_trainer_booth")
    hide(["roof__"], False)


@view
def corner_sealed():
    scene_setup(diagnostic=True, sun=SUN_RAKE_SW)
    cam((-9.10, -7.20, 2.90), (-5.56, -3.12, 2.55), lens=85)
    shoot("34_crop_corner_sealed")


@view
def corner_sealed_ne():
    scene_setup(diagnostic=True, sun=SUN_RAKE_NE)
    cam((9.30, 7.60, 3.05), (5.56, 3.95, 2.60), lens=85)
    shoot("35_crop_corner_sealed_ne")


@view
def hood_smooth():
    scene_setup()
    cam((-0.30, -8.60, 4.62), (-0.30, -4.10, 4.05), lens=105)
    shoot("36_crop_hood_smooth")


# ---------------------------------------------------------------- pass-4 views
@view
def crop_lowcorner_sw():
    """The rebuilt corner BELOW the datum, raked from its own side."""
    scene_setup(diagnostic=True, sun=SUN_RAKE_SW)
    cam((-8.30, -6.30, 1.35), (-5.52, -3.20, 1.05), lens=80)
    shoot("38_crop_lowcorner_sw")


@view
def crop_lowcorner_ne():
    scene_setup(diagnostic=True, sun=SUN_RAKE_NE)
    cam((8.55, 7.05, 1.30), (5.52, 4.00, 1.00), lens=80)
    shoot("39_crop_lowcorner_ne")


@view
def crop_keystone():
    """The redesigned focal insert, close, with its silhouette against sky."""
    scene_setup()
    cam((-0.30, -7.10, 4.45), (-0.30, -4.20, 4.36), lens=135)
    shoot("40_crop_keystone")


@view
def west_flank_service():
    """West flank: buttress, goods hatch, sump discharge."""
    scene_setup()
    cam((-9.60, -1.10, 2.35), (-5.30, 1.05, 1.55), lens=40)
    shoot("41_west_flank_service")


@view
def east_flank_service():
    """East flank: draw-off standpipe, isolator cabinet, conduit drop."""
    scene_setup()
    cam((9.90, 4.60, 2.40), (5.30, 2.45, 1.50), lens=40)
    shoot("42_east_flank_service")


@view
def interior_eye_transom():
    """Standing eye in the HALL: the daylight arrives as a lit transom band."""
    scene_setup(interior=True)
    # stand back far enough that the counter wall, the brass head, the lit
    # transom band and the ceiling's beam edge are all in one frame
    cam((-0.75, -2.35, 1.65), (0.10, 1.90, 2.55), lens=22)
    shoot("43_interior_eye_transom")


@view
def gameplay_daylight():
    """The game camera, framed on the fold so the daylight system reads in it."""
    scene_setup()
    p = math.radians(52)
    d = 21
    cam((1.2, -d * math.cos(p) + 1.6, d * math.sin(p) + 1.0), (1.2, 1.55, 3.20),
        ortho=11.0)
    shoot("44_gameplay_daylight")


@view
def trainer_identity():
    """The booth's training function: column, readout, demonstration rack."""
    scene_setup(interior=True)
    hide(["roof__"])
    cam((3.05, -1.55, 1.62), (4.72, -3.30, 1.20), lens=26)
    shoot("45_trainer_identity")
    hide(["roof__"], False)


@view
def crop_material_family():
    """Full-resolution crop across screed / sinter / ceramic / brass together."""
    scene_setup(interior=True)
    # screed floor, sinter counter mass, ceramic wall, plaster soffit and brass
    # kick all in one full-resolution frame -- the review's "one noise family
    # recoloured seven ways" test.
    cam((-2.35, -0.35, 1.42), (-4.35, 0.55, 0.62), lens=55)
    shoot("46_crop_material_family")


def main():
    names = list(VIEWDEFS) if VIEWS == ["all"] else VIEWS
    for n in names:
        if n not in VIEWDEFS:
            print("UNKNOWN VIEW", n)
            continue
        VIEWDEFS[n]()
    print("RENDER_SET_DONE")


main()
