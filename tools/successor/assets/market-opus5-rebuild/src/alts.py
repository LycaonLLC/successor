"""Cheap diagnostic blockouts of materially different architectural schemes.

  blender -b --factory-startup -noaudio -P src/alts.py -- --res 640 --samples 32

Renders every scheme from the locked gameplay ortho camera and a 3/4 eye view so
the massing can be compared bluntly before any final-render time is spent.
"""
import math
import os
import sys

import bpy
from mathutils import Vector

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import mlib as M          # noqa: E402
import plan as PL         # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []


def arg(k, d):
    return argv[argv.index(k) + 1] if k in argv else d


RES = int(arg("--res", "640"))
SAMPLES = int(arg("--samples", "32"))
OUT = os.path.join(ROOT, "proofs", "alts")
os.makedirs(OUT, exist_ok=True)

PL.assert_contract()
FX, FY = PL.FOOT_X, PL.FOOT_Y          # 5.700, 4.275
GREY = {}


def mats():
    GREY["mass"] = M.plain_material("BO_Mass", (0.20, 0.185, 0.165), 0.85)
    GREY["skin"] = M.plain_material("BO_Skin", (0.56, 0.545, 0.515), 0.60)
    GREY["roof"] = M.plain_material("BO_Roof", (0.30, 0.305, 0.30), 0.70)
    GREY["steel"] = M.plain_material("BO_Steel", (0.10, 0.10, 0.105), 0.45, 1.0)
    GREY["brass"] = M.plain_material("BO_Brass", (0.44, 0.33, 0.14), 0.35, 1.0)
    GREY["floor"] = M.plain_material("BO_Floor", (0.13, 0.125, 0.115), 0.75)
    GREY["glass"] = M.plain_material("BO_Glass", (0.30, 0.40, 0.44), 0.10)


def floorplate():
    M.box("floor__slab", GREY["floor"], (0, 0, -0.15), (2 * 5.30, 2 * 3.95, 0.34))


# ---------------------------------------------------------------- scheme A
def scheme_A():
    """CONTROL: the rejected pass-1 language -- stacked rectangular parapets."""
    floorplate()
    ox, oy = 5.30, 3.95
    M.box("A_base", GREY["mass"], (0, 0, 1.075), (2 * ox, 2 * oy, 2.15))
    M.box("A_skin", GREY["skin"], (0, -0.35, 3.25), (2 * (ox - .1), 2 * (oy - .45), 2.10))
    M.box("A_par", GREY["skin"], (0, -0.35, 4.45), (2 * (ox - .05), 2 * (oy - .40), 0.30))
    M.box("A_svc", GREY["skin"], (0, 2.60, 2.90), (2 * (ox - .1), 2.6, 1.40))
    M.box("A_svcpar", GREY["skin"], (0, 2.60, 3.72), (2 * (ox - .05), 2.7, 0.26))
    M.box("A_mon", GREY["skin"], (-0.9, -0.6, 5.05), (7.2, 2.7, 1.5))
    M.box("A_monroof", GREY["roof"], (-0.9, -0.6, 5.87), (7.4, 2.9, 0.14))
    for i in range(9):    # the barcode louvre row the review rejected
        M.box(f"A_lv_{i}", GREY["skin"], (-4.1 + i * 0.80, -1.98, 5.05),
              (0.62, 0.10, 1.30))
    M.box("A_trn", GREY["skin"], (3.6, -2.4, 3.55), (3.2, 3.0, 0.30))
    # loggia recess
    M.box("A_soffit", GREY["skin"], (-1.0, -3.1, 3.05), (6.0, 1.6, 0.22))


# ---------------------------------------------------------------- scheme B
def scheme_B():
    """VAULT HALL: sinter mass + a single barrel-vaulted hall + cistern drum."""
    floorplate()
    ox, oy = 5.30, 3.95
    # battered sinter mass
    M.prism("B_mass_s", GREY["mass"], [(-ox, 0), (ox, 0), (ox - .12, 2.30),
                                       (-ox + .12, 2.30)], 1, -oy, -oy + .40)
    M.box("B_mass_ring", GREY["mass"], (0, 0.20, 1.15), (2 * ox, 2 * (oy - .20), 2.30))
    # barrel vault over the hall, axis east-west, springs at 2.30
    vx0, vx1 = -5.10, 2.05
    R, cz = 5.60, 0.30
    half = math.asin(min(1.0, (oy - 0.15) / R))
    pts = M.arc_pts(0, cz, R, math.pi / 2 - half, math.pi / 2 + half, 14, r_in=R - 0.26)
    M.prism("B_vault", GREY["skin"], pts, 0, vx0, vx1)
    for i in range(6):    # expressed ribs, structural not decorative
        x = vx0 + 0.55 + i * (vx1 - vx0 - 1.1) / 5
        rp = M.arc_pts(0, cz, R + 0.10, math.pi / 2 - half, math.pi / 2 + half, 14,
                       r_in=R - 0.02)
        M.prism(f"B_rib_{i}", GREY["steel"], rp, 0, x - 0.07, x + 0.07)
    # east service block, lower and flat
    M.box("B_svc", GREY["skin"], (3.72, 0.20, 2.95), (3.10, 2 * (oy - .30), 1.30))
    M.box("B_svcpar", GREY["roof"], (3.72, 0.20, 3.68), (3.24, 2 * (oy - .24), 0.18))
    # entry portal carved on the trade axis
    px = PL.CELLS["trade"][0]
    M.box("B_portal_head", GREY["brass"], (px, -oy + .18, 2.86), (3.30, 0.5, 0.34))
    M.box("B_portal_soffit", GREY["skin"], (px, -oy + .75, 2.66), (3.00, 1.5, 0.20))
    for s in (-1, 1):
        M.box(f"B_jamb_{s}", GREY["mass"], (px + s * 1.62, -oy + .75, 1.33),
              (0.36, 1.5, 2.66))
    # cistern drum, north-east, fed by the vault gutter
    M.cyl("B_drum", GREY["mass"], (4.30, 2.85, 3.90), 0.98, 2.60, n=18)
    M.cyl("B_drumcap", GREY["roof"], (4.30, 2.85, 5.28), 1.04, 0.16, n=18)


# ---------------------------------------------------------------- scheme C
def scheme_C():
    """FOLD & TOWERS: asymmetric butterfly roof, valley gutter, windcatchers,
    cantilevered entrance canopy on raking struts."""
    floorplate()
    ox, oy = 5.30, 3.95
    vy = 0.55                      # valley line (east-west), north of centre
    zs, zn, zv = 5.15, 4.35, 3.40  # south fascia, north fascia, valley
    # battered sinter mass 0..2.20
    M.prism("C_mass", GREY["mass"],
            [(-ox, -oy), (ox, -oy), (ox, oy), (-ox, oy)], 2, 0.0, 2.20)
    M.box("C_massvoid", GREY["floor"], (0, 0, 1.10), (2 * (ox - .40), 2 * (oy - .40), 2.24))
    # ceramic clerestory band + the two folded roof planes
    M.prism("C_wall_s", GREY["skin"], [(-ox + .06, 2.20), (ox - .06, 2.20),
                                       (ox - .06, zs), (-ox + .06, zs)], 1, -oy, -oy + .28)
    M.prism("C_wall_n", GREY["skin"], [(-ox + .06, 2.20), (ox - .06, 2.20),
                                       (ox - .06, zn), (-ox + .06, zn)], 1, oy - .28, oy)
    # side walls follow the fold: south high -> valley -> north high
    for sx, nmx in ((-ox + .14, "w"), (ox - .14, "e")):
        M.prism(f"C_wall_{nmx}", GREY["skin"],
                [(-oy, 2.20), (oy, 2.20), (oy, zn), (vy, zv), (-oy, zs)], 0,
                sx - .14, sx + .14)
    # roof planes
    M.prism("C_roof_s", GREY["roof"], [(-oy - .22, zs + .10), (vy, zv + .10),
                                       (vy, zv - .04), (-oy - .22, zs - .04)],
            0, -ox - .18, ox + .18)
    M.prism("C_roof_n", GREY["roof"], [(vy, zv + .10), (oy + .22, zn + .10),
                                       (oy + .22, zn - .04), (vy, zv - .04)],
            0, -ox - .18, ox + .18)
    # valley gutter, draining east
    M.box("C_valley", GREY["steel"], (0, vy, zv + 0.02), (2 * ox + .30, 0.34, 0.10))
    # windcatcher stacks on the north plane, unequal
    for i, (tx, ty, h, w) in enumerate(((-3.05, 1.95, 6.55, 1.05),
                                        (-0.55, 2.35, 5.75, 0.85))):
        M.prism(f"C_tower_{i}", GREY["mass"],
                [(tx - w / 2, ty - w / 2), (tx + w / 2, ty - w / 2),
                 (tx + w / 2, ty + w / 2), (tx - w / 2, ty + w / 2)], 2, 2.20, h)
        M.box(f"C_towercap_{i}", GREY["brass"], (tx, ty, h + 0.10), (w + .22, w + .22, .20))
        for k in range(3):
            M.box(f"C_towerlv_{i}_{k}", GREY["steel"],
                  (tx, ty + w / 2 + .04, h - 0.30 - k * 0.22), (w - .16, 0.09, 0.14))
    # cistern drum at the east end of the valley
    M.cyl("C_drum", GREY["mass"], (4.05, vy + .30, 4.55), 0.92, 2.40, n=18)
    M.cyl("C_drumcap", GREY["roof"], (4.05, vy + .30, 5.84), 0.98, 0.18, n=18)
    # ---- entrance: splayed funnel portal + cantilevered canopy on raking struts
    px = PL.CELLS["trade"][0]
    M.box("C_canopy", GREY["roof"], (px, -oy - 0.78, 3.28), (4.60, 1.70, 0.20))
    M.box("C_canopy_fascia", GREY["brass"], (px, -oy - 1.60, 3.22), (4.60, 0.14, 0.34))
    for s in (-1, 1):
        M.prism(f"C_strut_{s}", GREY["steel"],
                [(-oy - 1.52, 3.18), (-oy - 0.10, 3.18), (-oy - 0.10, 2.05)], 0,
                px + s * 2.10 - .08, px + s * 2.10 + .08)
    # splayed jambs cut into the mass
    for s in (-1, 1):
        M.prism(f"C_splay_{s}", GREY["mass"],
                [(-oy, 0.0), (-oy + 1.30, 0.0), (-oy + 1.30, 2.20), (-oy, 2.20)], 0,
                px + s * 1.55, px + s * 2.35) if False else None
        M.prism(f"C_splayw_{s}", GREY["mass"],
                [(px + s * 1.42, -oy), (px + s * 2.30, -oy),
                 (px + s * 2.30, -oy + 1.30), (px + s * 1.62, -oy + 1.30)], 2, 0.0, 2.20)
    M.box("C_portal_head", GREY["brass"], (px, -oy + .55, 2.42), (3.05, 1.55, 0.26))
    M.box("C_door", GREY["glass"], (px, -oy + 1.28, 1.28), (2.10, 0.08, 2.50))
    # trainer bay: angled bay window with brass hood, south-east
    tx = PL.CELLS["trainer"][0]
    M.prism("C_bay", GREY["skin"], [(tx - 1.05, -oy), (tx + 1.05, -oy),
                                    (tx + 0.75, -oy - 0.62), (tx - 0.75, -oy - 0.62)],
            2, 0.95, 2.05)
    M.box("C_bayhood", GREY["brass"], (tx, -oy - 0.40, 2.16), (2.30, 0.90, 0.16))


# ---------------------------------------------------------------- scheme D
def scheme_D():
    """COLONNADE RING: deep brise-soleil colonnade wrapping a taller inner hall."""
    floorplate()
    ix, iy = 4.30, 3.10
    M.box("D_inner_mass", GREY["mass"], (0, 0, 1.10), (2 * ix, 2 * iy, 2.20))
    M.box("D_inner_skin", GREY["skin"], (0, 0, 3.45), (2 * ix - .1, 2 * iy - .1, 2.50))
    M.box("D_lantern", GREY["skin"], (-0.6, 0.2, 5.15), (5.4, 3.4, 0.90))
    M.box("D_lanternroof", GREY["roof"], (-0.6, 0.2, 5.66), (5.6, 3.6, 0.14))
    M.box("D_innerroof", GREY["roof"], (0, 0, 4.76), (2 * ix + .1, 2 * iy + .1, 0.14))
    # colonnade: piers at irregular plan-driven spacing, 0.92 m deep
    px = PL.CELLS["trade"][0]
    xs = [-5.10, -3.95, -2.80, -1.65, px - 1.55, px + 1.55, 2.90, 4.05, 5.10]
    for i, x in enumerate(xs):
        M.box(f"D_pier_s_{i}", GREY["mass"], (x, -3.72, 1.95), (0.34, 0.34, 3.90))
    for i, y in enumerate((-2.35, -1.10, 0.15, 1.40, 2.65)):
        for s in (-1, 1):
            M.box(f"D_pier_{s}_{i}", GREY["mass"], (s * 5.10, y, 1.95), (0.34, 0.34, 3.90))
    M.box("D_arch_s", GREY["skin"], (0, -3.72, 4.02), (2 * 5.30, 0.44, 0.28))
    for s in (-1, 1):
        M.box(f"D_arch_{s}", GREY["skin"], (s * 5.10, 0.15, 4.02), (0.44, 6.6, 0.28))
    for i in range(11):   # brise-soleil slats over the colonnade
        M.box(f"D_slat_{i}", GREY["steel"], (0, -3.60 + 0 * i, 4.16 + 0 * i),
              (2 * 5.2, 0.10, 0.06)) if False else None
    for i in range(7):
        M.box(f"D_slat_s_{i}", GREY["steel"], (0, -3.42 + i * 0.14, 4.18),
              (2 * 5.2, 0.07, 0.10))
    M.box("D_portal", GREY["brass"], (px, -3.72, 3.10), (3.30, 0.50, 0.30))
    M.box("D_door", GREY["glass"], (px, -3.05, 1.28), (2.10, 0.08, 2.50))



# ---------------------------------------------------------------- scheme E
def scheme_E():
    """SYNTHESIS: heavy battered sinter mass + asymmetric butterfly roof draining
    to a cistern drum + two unequal windcatcher towers + ONE curved vaulted entry
    hood that breaks the roofline + a partial (never ringed) west loggia.

    Hierarchy: exactly one curved focal element (the portal), one folded roof
    gesture, three unequal vertical service objects, and a plan-stepped south
    facade with three different setbacks. Nothing is a repeated bay."""
    floorplate()
    ox = 5.28
    yn, ys = 3.92, -3.12            # main mass north / south faces
    px = PL.CELLS["trade"][0]       # entry sits on the trade axis
    zsf, znf, zv, vy = 4.30, 4.62, 3.60, 1.05   # fascias, valley, valley line

    # --- battered sinter base mass 0..2.42, plan-stepped on the south
    M.prism("E_mass", GREY["mass"], [(-ox, ys), (ox, ys), (ox, yn), (-ox, yn)],
            2, 0.0, 2.42)
    M.box("E_massvoid", GREY["floor"], (0, 0.4, 1.21), (2 * (ox - .38), 6.4, 2.5))
    # trainer bay projects south-east, lower
    M.prism("E_trnbay", GREY["mass"], [(2.62, -4.06), (ox, -4.06), (ox, ys), (2.62, ys)],
            2, 0.0, 2.42)
    M.box("E_trnroof", GREY["roof"], (3.98, -3.60, 2.96), (2.80, 1.14, 0.16))
    M.box("E_trnhood", GREY["brass"], (4.275, -4.10, 2.26), (2.20, 0.62, 0.14))
    # --- ceramic upper skin + butterfly roof planes
    M.prism("E_skin_s", GREY["skin"], [(-ox + .06, 2.42), (ox - .06, 2.42),
                                       (ox - .06, zsf), (-ox + .06, zsf)], 1, ys, ys + .26)
    M.prism("E_skin_n", GREY["skin"], [(-ox + .06, 2.42), (ox - .06, 2.42),
                                       (ox - .06, znf), (-ox + .06, znf)], 1, yn - .26, yn)
    for sx, nm in ((-ox + .13, "w"), (ox - .13, "e")):
        M.prism(f"E_skin_{nm}", GREY["skin"],
                [(ys, 2.42), (yn, 2.42), (yn, znf), (vy, zv), (ys, zsf)], 0,
                sx - .13, sx + .13)
    M.prism("E_roof_s", GREY["roof"], [(ys - .20, zsf + .09), (vy, zv + .09),
                                       (vy, zv - .05), (ys - .20, zsf - .05)],
            0, -ox - .16, ox + .16)
    M.prism("E_roof_n", GREY["roof"], [(vy, zv + .09), (yn + .20, znf + .09),
                                       (yn + .20, znf - .05), (vy, zv - .05)],
            0, -ox - .16, ox + .16)
    M.box("E_valley", GREY["steel"], (0, vy, zv + 0.03), (2 * ox + .28, 0.32, 0.09))
    # --- two UNEQUAL windcatcher towers on the north plane
    for i, (tx, ty, h, w) in enumerate(((-3.35, 2.15, 6.45, 1.10),
                                        (-1.05, 2.62, 5.60, 0.82))):
        M.prism(f"E_tower_{i}", GREY["mass"],
                [(tx - w / 2, ty - w / 2), (tx + w / 2, ty - w / 2),
                 (tx + w / 2, ty + w / 2), (tx - w / 2, ty + w / 2)], 2, 2.42, h)
        M.box(f"E_towercap_{i}", GREY["brass"], (tx, ty, h + .11), (w + .24, w + .24, .22))
        for k in range(3):
            M.box(f"E_towerlv_{i}_{k}", GREY["steel"],
                  (tx, ty + w / 2 + .05, h - .34 - k * .26), (w - .18, 0.10, 0.16))
    # --- cistern drum at the east end of the valley
    M.cyl("E_drum", GREY["mass"], (3.95, vy + .28, 4.62), 0.94, 2.20, n=18)
    M.cyl("E_drumcap", GREY["roof"], (3.95, vy + .28, 5.80), 1.00, 0.18, n=18)
    M.box("E_downpipe", GREY["steel"], (4.62, vy + .05, 4.05), (0.16, 0.16, 1.10))
    # --- THE FOCAL ELEMENT: one curved vaulted entry hood breaking the roofline
    spr, ri, ro = 2.85, 1.62, 1.90
    hood = M.arc_pts(px, spr, ro, 0.0, math.pi, 16, r_in=ri)
    M.prism("E_hood", GREY["skin"], hood, 1, -4.20, ys)
    for s in (-1, 1):
        M.box(f"E_hoodjamb_{s}", GREY["mass"], (px + s * (ri + ro) / 2, -3.66, spr / 2),
              (ro - ri, 1.08, spr))
    M.prism("E_hoodface", GREY["brass"],
            M.arc_pts(px, spr, ro, 0.0, math.pi, 16, r_in=ro - 0.12), 1, -4.28, -4.20)
    # glazed tympanum + door at the back of the throat
    M.prism("E_tymp", GREY["glass"], M.arc_pts(px, spr, ri, 0.0, math.pi, 14), 1,
            ys - .06, ys)
    M.box("E_door", GREY["glass"], (px, ys - .04, 1.28), (2.10, 0.08, 2.50))
    M.box("E_thresh", GREY["brass"], (px, ys - .55, 0.04), (3.00, 1.00, 0.08))
    # --- partial west loggia (three unequal bays, never a ring)
    for i, (x, w) in enumerate(((-4.86, 0.42), (-3.42, 0.34), (-2.20, 0.30))):
        M.box(f"E_logpier_{i}", GREY["mass"], (x, -3.86, 1.42), (w, w, 2.84))
    M.box("E_logbeam", GREY["mass"], (-3.55, -3.86, 2.98), (3.85, 0.52, 0.28))
    for i in range(6):
        M.box(f"E_logslat_{i}", GREY["steel"], (-3.55, -3.72 + i * 0.15, 3.20),
              (3.70, 0.08, 0.11))
    # --- fixture cell markers (plan sanity check only)
    for k, (cx, cy) in PL.CELLS.items():
        M.box(f"E_mark_{k}", GREY["brass"], (cx, cy, 0.06), (0.90, 0.90, 0.04))


SCHEMES = {"A_control_stepped_box": scheme_A, "B_vault_hall": scheme_B,
           "C_fold_towers": scheme_C, "D_colonnade_ring": scheme_D,
           "E_synthesis": scheme_E}


def setup_render():
    sc = bpy.context.scene
    sc.render.engine = 'CYCLES'
    sc.cycles.device = 'CPU'
    sc.cycles.samples = SAMPLES
    sc.cycles.use_denoising = True
    sc.cycles.max_bounces = 3
    sc.render.resolution_x = RES
    sc.render.resolution_y = int(RES * 0.75)
    sc.view_settings.view_transform = 'AgX'
    w = bpy.data.worlds.new("W")
    sc.world = w
    w.use_nodes = True
    nt = w.node_tree
    nt.nodes.clear()
    o = nt.nodes.new("ShaderNodeOutputWorld")
    bg = nt.nodes.new("ShaderNodeBackground")
    bg.inputs[0].default_value = (0.46, 0.50, 0.58, 1)
    bg.inputs[1].default_value = 0.55
    nt.links.new(bg.outputs[0], o.inputs[0])
    ld = bpy.data.lights.new("Sun", 'SUN')
    ld.energy = 3.2
    ld.angle = math.radians(1.4)
    ld.color = (1.0, 0.95, 0.88)
    sun = bpy.data.objects.new("Sun", ld)
    sc.collection.objects.link(sun)
    sun.rotation_euler = (math.radians(42), 0, math.radians(212))
    bpy.ops.mesh.primitive_plane_add(size=200, location=(0, 0, 0))
    g = bpy.context.active_object
    g.name = "GroundPlane"
    gm = bpy.data.materials.new("G")
    gm.use_nodes = True
    gm.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (
        0.26, 0.20, 0.14, 1)
    g.data.materials.append(gm)


def cam(loc, target, ortho=None, lens=44):
    c = bpy.data.cameras.new("C")
    if ortho:
        c.type = 'ORTHO'
        c.ortho_scale = ortho
    else:
        c.lens = lens
    ob = bpy.data.objects.new("C", c)
    bpy.context.scene.collection.objects.link(ob)
    ob.location = Vector(loc)
    ob.rotation_euler = (Vector(target) - Vector(loc)).to_track_quat('-Z', 'Y').to_euler()
    bpy.context.scene.camera = ob
    return ob


def shoot(path):
    sc = bpy.context.scene
    sc.render.filepath = path
    sc.render.image_settings.file_format = 'PNG'
    bpy.ops.render.render(write_still=True)
    print("RENDERED", os.path.basename(path), flush=True)


for name, fn in SCHEMES.items():
    M.clear()
    mats()
    fn()
    for ob in M.SCENE_OBJS:
        M.ensure_vcolor(ob)
    setup_render()
    tris = M.tri_count(M.SCENE_OBJS)
    mn, mx = M.world_bounds(M.SCENE_OBJS)
    print(f"[{name}] tris={tris} bounds x=[{mn[0]:.2f},{mx[0]:.2f}] "
          f"y=[{mn[1]:.2f},{mx[1]:.2f}] z=[{mn[2]:.2f},{mx[2]:.2f}]", flush=True)
    p = math.radians(52)
    d = 26
    cam((0, -d * math.cos(p), d * math.sin(p) + 1.0), (0, 0.1, 2.0), ortho=15.5)
    shoot(os.path.join(OUT, f"{name}_ortho.png"))
    for o in list(bpy.data.objects):
        if o.type == 'CAMERA':
            bpy.data.objects.remove(o, do_unlink=True)
    cam((12.6, -13.4, 8.0), (0.0, -0.4, 2.2), lens=50)
    shoot(os.path.join(OUT, f"{name}_3q.png"))
print("ALTS_DONE")
