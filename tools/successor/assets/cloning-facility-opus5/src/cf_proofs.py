"""Proof render set for the Dustgate Clone Vault.

    blender -b --factory-startup -noaudio -P cf_proofs.py -- [authored|shipped|night]

Three modes, because they answer different questions:

`authored`  the Blender scene with its procedural PBR materials under the bake
            rig.  This is what the source looks like and what the bake is
            approximating.

`shipped`   the exported GLB re-imported and re-shaded the way
            `client-3d/src/render/props.ts::convertMaterial` shades it: textured
            materials become UNLIT emission of their base colour, untextured ones
            keep their authored colour and blend, emissive ones emit.  This is
            the only render that shows what a player actually sees, and it is the
            render that proves the bake did its job.

`night`     the authored scene at dusk, for the emissive read.
"""
from __future__ import annotations

import sys
import time
from pathlib import Path

SRC = Path(__file__).resolve().parent
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

import bpy  # noqa: E402

import cf_bake  # noqa: E402
import cf_build  # noqa: E402
import cf_render  # noqa: E402
from cf_export import LAB, OUT_DIR  # noqa: E402
from cf_spec import DOOR, REVEAL_PREFIXES, ROOT_NODE  # noqa: E402

EXTERIOR = ["01_front_three_quarter", "02_rear_three_quarter", "03_front_elevation",
            "04_left_flank", "05_right_flank", "06_door_closed", "07_door_open",
            "21_gameplay_ortho"]
INTERIOR = ["10_interior_wide", "11_interior_from_door", "12_vat_empty_close",
            "13_vat_occupied_close", "14_terminal_close", "15_control_bank",
            "16_process_wall", "20_topdown_cutaway"]
OCCUPANT = ["30_occupant_front", "31_occupant_side"]


def _slide(door, sign):
    axis, dist = DOOR["slide_axis_local"], DOOR["slide_distance_m"]
    door.location = (door.location[0] + sign * axis[0] * dist,
                     door.location[1] - sign * axis[2] * dist,
                     door.location[2] + sign * axis[1] * dist)


def unlit_conversion(root):
    """Re-shade an imported GLB the way the runtime world-prop path does."""
    seen = {}
    for obj in [root, *root.children_recursive]:
        if obj.type != "MESH":
            continue
        for slot in obj.material_slots:
            src = slot.material
            if src is None or src.name in seen:
                if src is not None:
                    slot.material = seen[src.name]
                continue
            mat = bpy.data.materials.new(src.name + ":unlit")
            mat.use_nodes = True
            tree = mat.node_tree
            tree.nodes.clear()
            out = tree.nodes.new("ShaderNodeOutputMaterial")
            emit = tree.nodes.new("ShaderNodeEmission")
            emit.inputs["Strength"].default_value = 1.0

            base_tex = None
            base_col = (0.56, 0.56, 0.56, 1.0)
            emissive = (0.0, 0.0, 0.0, 1.0)
            emissive_tex = None
            alpha = 1.0
            for node in src.node_tree.nodes:
                if node.type != "BSDF_PRINCIPLED":
                    continue
                bc = node.inputs["Base Color"]
                if bc.links:
                    from_node = bc.links[0].from_node
                    if from_node.type == "TEX_IMAGE":
                        base_tex = from_node.image
                else:
                    base_col = tuple(bc.default_value)
                ec = node.inputs["Emission Color"]
                if ec.links:
                    fn = ec.links[0].from_node
                    if fn.type == "TEX_IMAGE":
                        emissive_tex = fn.image
                else:
                    emissive = tuple(ec.default_value)
                alpha = float(node.inputs["Alpha"].default_value)

            image = base_tex or emissive_tex
            if image is not None:
                tex = tree.nodes.new("ShaderNodeTexImage")
                tex.image = image
                tex.location = (-320, 0)
                tree.links.new(tex.outputs["Color"], emit.inputs["Color"])
            elif sum(emissive[:3]) > 0.003:
                emit.inputs["Color"].default_value = emissive
            else:
                # untextured, non-emissive: the runtime uses a matcap here, which
                # a path tracer cannot reproduce; a flat diffuse of the authored
                # colour is the closest honest stand-in.
                diff = tree.nodes.new("ShaderNodeBsdfDiffuse")
                diff.inputs["Color"].default_value = base_col
                tree.links.new(diff.outputs["BSDF"], out.inputs["Surface"])
                tree.nodes.remove(emit)
                if alpha < 1.0:
                    mat.diffuse_color = (*base_col[:3], alpha)
                slot.material = mat
                seen[src.name] = mat
                continue
            if alpha < 1.0:
                mix = tree.nodes.new("ShaderNodeMixShader")
                trans = tree.nodes.new("ShaderNodeBsdfTransparent")
                mix.inputs["Fac"].default_value = alpha
                tree.links.new(trans.outputs["BSDF"], mix.inputs[1])
                tree.links.new(emit.outputs["Emission"], mix.inputs[2])
                tree.links.new(mix.outputs["Shader"], out.inputs["Surface"])
                for attr, value in (("surface_render_method", "BLENDED"),
                                    ("blend_method", "BLEND")):
                    try:
                        setattr(mat, attr, value)
                    except Exception:
                        pass
            else:
                tree.links.new(emit.outputs["Emission"], out.inputs["Surface"])
            slot.material = mat
            seen[src.name] = mat
    return seen


def render_set(mode="authored", views=None, samples=64, res=1400):
    out = LAB / "proofs" / mode
    scene = cf_build.ensure_scene()
    rig = bpy.data.collections[cf_build.RIG_COLLECTION]
    cf_bake.clear_lights(rig)

    if mode == "shipped":
        cf_build.clear_collection(cf_build.BUILD_COLLECTION)
        col = bpy.data.collections[cf_build.BUILD_COLLECTION]
        before = set(bpy.data.objects)
        bpy.ops.import_scene.gltf(filepath=str(OUT_DIR / "cloning_facility.glb"))
        fresh = [o for o in bpy.data.objects if o not in before]
        for obj in fresh:
            for c in list(obj.users_collection):
                c.objects.unlink(obj)
            col.objects.link(obj)
        root = next(o for o in fresh if o.name.startswith(ROOT_NODE))
        unlit_conversion(root)
        door = next((o for o in fresh if o.name == DOOR["node"]), None)
        if door is not None and door.animation_data is not None:
            # The importer assigns the door_close action, which would drive the
            # node's location and silently ignore the manual slide below.
            door.animation_data_clear()
        # a flat sky only, so nothing but the baked colour lights the frame
        cf_bake.build_world(scene)
        world = scene.world
        for node in world.node_tree.nodes:
            if node.type == "BACKGROUND":
                node.inputs["Strength"].default_value = 0.16
    else:
        result = cf_build.build_facility()
        root = result["root"]
        door = result["door"]
        cf_bake.build_world(scene, night=(mode == "night"))
        cf_bake.build_lights(rig, night=(mode == "night"))

    cf_render.build_ground_plane(rig)
    staff = cf_render.build_scale_figure(rig, 2.95, 4.70)
    cf_render.setup_scene(scene, samples=samples, resolution=(res, int(res * 0.75)),
                          night=(mode == "night"))
    if mode == "shipped":
        scene.view_settings.view_transform = "Standard"
        scene.view_settings.look = "None"
        scene.view_settings.exposure = 0.0

    wanted = views or (EXTERIOR + INTERIOR + OCCUPANT)
    for key in wanted:
        if key not in cf_render.VIEWS:
            continue
        eye, target, lens = cf_render.VIEWS[key]
        cam = cf_render.camera("CF_CAM", eye, target, lens=lens or 50.0,
                               ortho=cf_render.ORTHO_SCALE.get(key), collection=rig)
        cf_render.show_all(root)
        cf_render.set_ref(staff, key)
        if key in INTERIOR:
            cf_render.hide_prefixes(root, REVEAL_PREFIXES, True)
        if key in OCCUPANT:
            for obj in root.children_recursive:
                if "occupant" not in obj.name:
                    obj.hide_render = True
        if key == "07_door_open" and door is not None:
            _slide(door, 1)
        t = time.time()
        cf_render.render(scene, cam, out / f"{key}.png")
        print(f"[cf_proofs:{mode}] {key} {time.time() - t:.1f}s", flush=True)
        if key == "07_door_open" and door is not None:
            _slide(door, -1)
    cf_render.show_all(root)
    return out


def main():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    modes = argv or ["authored", "shipped", "night"]
    for mode in modes:
        views = None
        if mode == "night":
            views = ["01_front_three_quarter", "02_rear_three_quarter",
                     "06_door_closed", "10_interior_wide"]
        out = render_set(mode, views=views)
        print(f"[cf_proofs] {mode} -> {out}", flush=True)


if __name__ == "__main__":
    main()
