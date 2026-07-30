#!/usr/bin/env python3
"""Measured world-item audit renders for Dustgate production selection."""
import bpy
import hashlib
import json
import math
import os
import shutil
import sys
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from dgpaths import REPO_ROOT, STUDY_DIR, prod
from dgkit import resolve_eevee_engine

SRC = Path(
    os.environ.get(
        "SUCCESSOR_PROP_SOURCE_ROOT",
        str(Path.home() / "dev/games/source-assets/props"),
    )
).resolve()
REPO = Path(REPO_ROOT)
PROMOTED = REPO / "client-3d/public/assets/world-items"
VENDORED = Path(STUDY_DIR) / "source-items"

EXTRACTION_IDS = [
    "successor_extraction_mineral_power_skid", "successor_extraction_mineral_control_panel",
    "successor_extraction_extraction_maintenance_cart", "successor_extraction_extraction_survey_tripod",
    "successor_extraction_mineral_survey_scanner", "successor_extraction_mineral_dust_filter",
    "successor_extraction_petrochemical_separator_skid", "successor_extraction_petrochemical_flowline_manifold",
    "successor_extraction_mineral_core_sampler",
]
VEHICLE_IDS = [
    "successor_vehicle_component_cargo_crate_small", "successor_vehicle_component_cargo_crate_long",
    "successor_vehicle_component_workbench_fold", "successor_vehicle_component_battery_bank_quad",
    "successor_vehicle_component_utility_water_tank", "successor_vehicle_component_rear_worklight",
    "successor_vehicle_component_service_tool_cabinet",
]
PROMOTED_SELECTIONS = [
    ("clone_pod", "clone_pod.glb"),
    ("clone_terminal", "clone_terminal.glb"),
    ("bank_terminal_civic", "bank_terminal_civic.glb"),
    ("trade_terminal", "trade_terminal.glb"),
    ("pa_terminal", "pa_terminal.glb"),
    ("travel_terminal_grok_wedge", "travel_terminal_grok_wedge.glb"),
    ("footlocker_frontier", "footlocker_frontier.glb"),
    # Explicit runtime aliases. Never replace these with fuzzy-name matching.
    ("water_tank_frontier", "tank_water_frontier.glb"),
    ("battery_pack_industrial", "battery_pack_industrial.glb"),
    ("workbench_field", "bench_welder.glb"),
    ("crate_cargo_heavy", "crate_cargo_heavy.glb"),
]

EVERYDAY_SELECTIONS = [
    ("everyday", "successor_everyday_workbench.glb"),
    ("everyday", "successor_everyday_shelf_unit.glb"),
    ("everyday", "successor_everyday_chest_trunk.glb"),
    ("everyday", "successor_everyday_bedroll.glb"),
    ("everyday", "successor_everyday_barrel_rain.glb"),
    ("everyday", "successor_everyday_wooden_crate_open.glb"),
    ("furniture", "successor_home_bunk_bed_standard.glb"),
    ("furniture", "successor_home_open_shelving_standard.glb"),
    ("furniture", "successor_home_base_cabinet_standard.glb"),
    ("furniture", "successor_home_wall_sconce_standard.glb"),
]

# Exact files approved in the 2026-07-29 measured/visual audit. A newer wave or
# bounded per-id rebuild must update this table deliberately; a silent sibling
# substitution is a hard failure.
EXPECTED_SHA256 = {
    "successor_extraction_mineral_power_skid": "b16fbbc4421b953139fef711aa4799b2b9841b2e029618e5afef4346e3177145",
    "successor_extraction_mineral_control_panel": "67177454c7699be6324f98d9b958586a2651b9aa493dea5865c3164a165ca202",
    "successor_extraction_extraction_maintenance_cart": "5f1458288d50a73c577ba3e67920cc3428c86dd01f40aa1c9df054a9fdea8e62",
    "successor_extraction_extraction_survey_tripod": "782a271997eaacd532b5ffc41783bbed86c5bb2a50ae5fdbb5456d94d8d6579e",
    "successor_extraction_mineral_survey_scanner": "3d432a549bc8cd55ef7542d447f0243face1e2cd7663fc5f2c61389b219bc841",
    "successor_extraction_mineral_dust_filter": "cf8d6517cabfa62b10245eb5a0a505f4d6b19adca50da82fb658246167ce2ba5",
    "successor_extraction_petrochemical_separator_skid": "76a07ea99a11d5091fccbe743ca55e8941cde3d256526458efb3df9debe69881",
    "successor_extraction_petrochemical_flowline_manifold": "16d994346f7ba9e57cc878bef421665f1dcd464c5a4a70435e2279aa79afc044",
    "successor_extraction_mineral_core_sampler": "c6b4ea325163586e7babfdb31621c1383e5e196a570b6591ae67d82d5dd89af2",
    "successor_vehicle_component_cargo_crate_small": "d6bba4347b624e6e057e5272a3d81d667aafdaa9370006d2ff93271a45f5bc01",
    "successor_vehicle_component_cargo_crate_long": "3a9ad93fb319da0b1bd4e2e54a2c374b0fbaef9c42a6a77b21b21caae5bbc26c",
    "successor_vehicle_component_workbench_fold": "e174c2be8893c13f389d53ce5d5682f639b46780afb3215cdb9d44b6e05aac70",
    "successor_vehicle_component_battery_bank_quad": "9c5861242be5a602389613f78fbfcf8f92bfd81f4d11764332d65c223756703c",
    "successor_vehicle_component_utility_water_tank": "db6d8045cb39eff428a40d0e2c7fabe83241f2010573ba8946c7d44503f05297",
    "successor_vehicle_component_rear_worklight": "ac89a528082e83551ab3450cf148780d142cec707458d4d23abedcd91e173f9d",
    "successor_vehicle_component_service_tool_cabinet": "d4df11094f1c357dea9c593886a26a147c587898c38857b8c158a5994ffd6f86",
    "clone_pod": "87a99d66eca1c0bf805bdc642d1b154384b360278badbe7e9d931a141a695fc4",
    "clone_terminal": "f7d03b0715d08dddfb18b1c37f7235cce1b7bb05aab5043e87f9c5ec3ca4809f",
    "bank_terminal_civic": "eb825f81370b014660499bcb7fc67480895b3734683ba6647234203b996c2151",
    "trade_terminal": "90a2602192261b3e5f14cc738c49d240ae44776166acf1779239527d23179805",
    "pa_terminal": "237c21c6284b7f6617ae4bc7fbff3e8230888064a6bf5f240c3389abce15086a",
    "travel_terminal_grok_wedge": "a26cc0591111b5456c1ac6822d35f9b5895171cf8c036d792b62643788cbad2a",
    "footlocker_frontier": "f8bbc53ff96b0020466da861e6cdce2ac43090db6384d14e8656fa83a71e75ad",
    "water_tank_frontier": "0878cfb8e4786a61abd551ead78aac370aaa3ed3e32fa0273d38269c96912bc7",
    "battery_pack_industrial": "8cf786cc80df647fd3617749636d41edf76fc8ca736be6f02f1d54bf13c195f3",
    "workbench_field": "1ce0aee01369be20cc83a7975dd9f78e5d537e566b920a6fe0eb51c0ed5d27b8",
    "crate_cargo_heavy": "90eabc45f3ad80badc987c762c7b63cf180a0b06917bbc64a346ae61441a419e",
    "infra_001": "27a0072779c7fc7ec20bfdb1f9f292606f8e329e0f63b741b5eda4d28551b931",
    "infra_021": "f5be4cdfee0c0daf1b0b64293065fefc796a378a15babd729cfcdd3152d550e1",
    "infra_121": "b841f47d33d4d37e851f79cc2dc46341c391ad6be826dd839b125be60f6fed06",
    "successor_everyday_workbench": "94db62185dedae59c4196b07fa9269237e45f811b1a229220537a94d538db89c",
    "successor_everyday_shelf_unit": "7af8a4cf5322c46818317b6fae6de4a9d56ba333b5575a7a591f10b06c237f6c",
    "successor_everyday_chest_trunk": "b8a591a39eab9b98ec66e33b15fe7005c555f9e73135b6d9660f6ab5f959d9e5",
    "successor_everyday_bedroll": "764c4fe2684696792a78eff39f1155b52e809bc4bdcb9ee1b5530700f099768d",
    "successor_everyday_barrel_rain": "90ce36958dc35c3e8688ff7eb378b83ae75f64abf2014cee36fcc4cd4b26b373",
    "successor_everyday_wooden_crate_open": "90eabc45f3ad80badc987c762c7b63cf180a0b06917bbc64a346ae61441a419e",
    "successor_home_bunk_bed_standard": "371436dd20e9972d3ebee5f9e44696aa043de4a5d1a74bb49228ed2c0edbdeca",
    "successor_home_open_shelving_standard": "a132742abc08a6d3ab4ff617d560b8e5df9c1361d53c454c1cf26c9f1894dafa",
    "successor_home_base_cabinet_standard": "b261d41c9a9890767a2462b76c6fe2c12580f36492f9cb8cbaddc0dcf092200d",
    "successor_home_wall_sconce_standard": "18b84cf51855af061e3932856d4ed0c66eab960dd94fd2e8ef8fe3c981820dc5",
}


def candidate(group, item_id, path):
    path = Path(path)
    if not path.is_file():
        raise FileNotFoundError(f"pinned candidate missing: {path}")
    expected = EXPECTED_SHA256[item_id]
    actual = sha256(path)
    if actual != expected:
        raise RuntimeError(
            f"pinned candidate changed for {item_id}: {actual} != {expected} ({path})"
        )
    if path.is_relative_to(REPO):
        short = str(path.relative_to(REPO))
    else:
        short = str(path.relative_to(SRC))
    return {
        "id": item_id,
        "group": group,
        "sourcePath": str(path),
        "path": short,
        "pinnedSha256": expected,
    }


def upstream_candidates():
    result = []
    extraction = SRC / "successor/full-spectrum-wave-20260720/extraction-installations/parent-reset-01/assets"
    vehicles = SRC / "vehicles/successor/grok45-wave-20260718/components/assets"
    for item_id in EXTRACTION_IDS:
        result.append(("extraction", item_id, extraction / (item_id + ".glb")))
    for item_id in VEHICLE_IDS:
        result.append(("vehicle", item_id, vehicles / (item_id + ".glb")))
    infra = SRC / "successor/full-spectrum-wave-20260720/infrastructure-computing/parent-reset-01/assets"
    for token in ("infra_001", "infra_021", "infra_121"):
        result.append(("infrastructure", token, infra / f"{token}.glb"))
    everyday = SRC / "successor/everyday-wave-20260719/everyday-world-props/assets"
    furniture = SRC / "successor/homebuilder-wave-20260719/furniture/assets"
    roots = {"everyday": everyday, "furniture": furniture}
    for lane, filename in EVERYDAY_SELECTIONS:
        path = roots[lane] / filename
        result.append(("everyday", path.stem, path))
    return result


def preferred_source(item_id, upstream):
    vendored = VENDORED / f"{item_id}.glb"
    return vendored if vendored.is_file() else upstream


def build_candidates():
    rows = upstream_candidates()
    result = [
        candidate(group, item_id, preferred_source(item_id, path))
        for group, item_id, path in rows
        if group in {"extraction", "vehicle"}
    ]
    for item_id, filename in PROMOTED_SELECTIONS:
        result.append(candidate("promoted", item_id, PROMOTED / filename))
    result.extend(
        candidate(group, item_id, preferred_source(item_id, path))
        for group, item_id, path in rows
        if group not in {"extraction", "vehicle"}
    )
    return result


def vendor_pinned_candidates():
    VENDORED.mkdir(parents=True, exist_ok=True)
    records = []
    for group, item_id, upstream in upstream_candidates():
        source = candidate(group, item_id, upstream)
        destination = VENDORED / f"{item_id}.glb"
        if destination.exists() and sha256(destination) != EXPECTED_SHA256[item_id]:
            raise RuntimeError(f"refusing to replace changed vendored candidate: {destination}")
        if not destination.exists():
            shutil.copy2(upstream, destination)
        candidate(group, item_id, destination)
        records.append({
            "bytes": destination.stat().st_size,
            "filename": destination.name,
            "group": group,
            "id": item_id,
            "sha256": EXPECTED_SHA256[item_id],
            "upstreamLineage": str(upstream.relative_to(SRC)),
        })
    manifest = {
        "schemaVersion": 1,
        "generatedBy": "tools/successor/assets/dustgate-redesign/proditems.py --vendor-pinned",
        "candidateCount": len(records),
        "candidates": records,
    }
    manifest_path = VENDORED / "manifest.json"
    manifest_path.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(f"[proditems] vendored {len(records)} pinned candidates at {VENDORED}")


def reset_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)


def rgba(hex_color):
    hex_color = hex_color.lstrip("#")
    return tuple(int(hex_color[i:i+2], 16) / 255.0 for i in (0, 2, 4)) + (1.0,)


def material(name, color, roughness=0.65):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    bsdf.inputs["Base Color"].default_value = color
    bsdf.inputs["Roughness"].default_value = roughness
    return mat


def setup_scene(center, scale, mode):
    scene = bpy.context.scene
    scene.render.engine = resolve_eevee_engine()
    eevee = getattr(scene, "eevee", None)
    if eevee is not None and hasattr(eevee, "taa_render_samples"):
        eevee.taa_render_samples = 64
    scene.render.resolution_x = 900
    scene.render.resolution_y = 900
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGB"
    scene.render.image_settings.color_depth = "8"
    scene.render.film_transparent = False
    scene.render.image_settings.color_management = "FOLLOW_SCENE"
    scene.view_settings.view_transform = "AgX"
    scene.view_settings.look = "AgX - Medium High Contrast"
    scene.render.resolution_percentage = 100
    # Ground and proxy are deliberately added after candidate measurement.
    bpy.ops.mesh.primitive_plane_add(size=max(30.0, scale * 4.0), location=(center[0], center[1], 0.0))
    ground = bpy.context.object
    ground.data.materials.append(material("Audit sand #c1ad8d", rgba("#c1ad8d")))
    proxy_x = center[0] + 1.2
    bpy.ops.mesh.primitive_cylinder_add(vertices=20, radius=0.19, depth=1.37, location=(proxy_x, center[1], 0.875))
    proxy = bpy.context.object
    proxy.name = "Scale proxy 1.75m capsule"
    proxy.data.materials.append(material("Scale proxy", (0.16, 0.22, 0.28, 1.0)))
    bpy.ops.mesh.primitive_uv_sphere_add(segments=20, ring_count=10, radius=0.19, location=(proxy_x, center[1], 1.56))
    bpy.context.object.data.materials.append(proxy.data.materials[0])
    bpy.ops.mesh.primitive_uv_sphere_add(segments=20, ring_count=10, radius=0.19, location=(proxy_x, center[1], 0.19))
    bpy.context.object.data.materials.append(proxy.data.materials[0])
    bpy.ops.object.camera_add()
    camera = bpy.context.object
    camera.data.type = "ORTHO"
    camera.data.ortho_scale = 6.0 if mode == "normal" else max(scale * 1.5, 0.75)
    yaw = 0.0 if mode == "normal" else math.radians(35.0)
    pitch = math.radians(60.0 if mode == "normal" else 22.0)
    distance = max(8.0, camera.data.ortho_scale * 1.5)
    target = __import__("mathutils").Vector((center[0], center[1], max(center[2], 0.8)))
    camera.location = target + __import__("mathutils").Vector((math.sin(yaw) * distance, -math.cos(yaw) * distance, math.tan(pitch) * distance))
    camera.rotation_euler = (target - camera.location).to_track_quat("-Z", "Y").to_euler()
    scene.camera = camera
    bpy.ops.object.light_add(type="SUN")
    sun = bpy.context.object
    sun.data.energy = 4.1
    sun.data.color = rgba("#ffe9c6")[:3]
    az, el = math.radians(215.0), math.radians(52.0)
    sun.location = target + __import__("mathutils").Vector((math.sin(az) * math.cos(el), math.cos(az) * math.cos(el), math.sin(el))) * 10.0
    sun.rotation_euler = (target - sun.location).to_track_quat("-Z", "Y").to_euler()
    world = bpy.data.worlds.new("Audit gradient world")
    scene.world = world
    world.use_nodes = True
    nodes, links = world.node_tree.nodes, world.node_tree.links
    nodes.clear()
    out = nodes.new("ShaderNodeOutputWorld")
    bg = nodes.new("ShaderNodeBackground")
    ramp = nodes.new("ShaderNodeValToRGB")
    gradient = nodes.new("ShaderNodeTexGradient")
    texcoord = nodes.new("ShaderNodeTexCoord")
    ramp.color_ramp.elements[0].color = (0.07, 0.10, 0.14, 1)
    ramp.color_ramp.elements[1].color = (0.37, 0.45, 0.54, 1)
    bg.inputs["Strength"].default_value = 0.35
    links.new(texcoord.outputs["Normal"], gradient.inputs["Vector"])
    links.new(gradient.outputs["Fac"], ramp.inputs["Fac"])
    links.new(ramp.outputs["Color"], bg.inputs["Color"])
    links.new(bg.outputs["Background"], out.inputs["Surface"])


def sha256(path):
    h = hashlib.sha256()
    with open(path, 'rb') as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b''):
            h.update(chunk)
    return h.hexdigest()


def measure(path):
    bpy.ops.import_scene.gltf(filepath=str(path))
    meshes = [o for o in bpy.context.scene.objects if o.type == 'MESH']
    if not meshes:
        raise RuntimeError("GLB imported no mesh objects")
    depsgraph = bpy.context.evaluated_depsgraph_get()
    points = []
    triangles = 0
    uv_layers = {}
    materials = set()
    for obj in meshes:
        for corner in obj.bound_box:
            points.append(obj.matrix_world @ __import__('mathutils').Vector(corner))
        evaluated = obj.evaluated_get(depsgraph)
        mesh = evaluated.to_mesh()
        try:
            triangles += sum(len(poly.vertices) - 2 for poly in mesh.polygons)
        finally:
            evaluated.to_mesh_clear()
        uv_layers[obj.name] = [uv.name for uv in obj.data.uv_layers]
        materials.update(slot.material.name for slot in obj.material_slots if slot.material)
    lo = [min(p[i] for p in points) for i in range(3)]
    hi = [max(p[i] for p in points) for i in range(3)]
    spans = [hi[i] - lo[i] for i in range(3)]
    center = [(lo[i] + hi[i]) / 2.0 for i in range(3)]
    images = sorted({image.name for image in bpy.data.images if image.name and image.source != 'GENERATED'})
    sockets = []
    for obj in bpy.context.scene.objects:
        if obj.name.startswith(("Socket", "socket")):
            sockets.append({"name": obj.name, "localTranslation": [float(v) for v in obj.location]})
    return {"bbox": {"min": lo, "max": hi}, "spans": {"x": spans[0], "y": spans[1], "z": spans[2]},
            "groundContactY": abs(lo[1]) <= 0.01, "xzCenterOffset": {"x": center[0], "z": center[2]},
            "triangles": triangles, "meshCount": len(meshes), "materials": sorted(materials), "images": images,
            "uvLayers": dict(sorted(uv_layers.items())), "sockets": sorted(sockets, key=lambda s: s['name']), "_center": center}


def render_item(item, measured):
    center = measured.pop('_center')
    span = max(measured['spans'].values())
    paths = {}
    for mode in ('normal', 'close'):
        setup_scene(center, span, mode)
        output = prod('items', 'renders', item['id'] + '_' + mode + '.png')
        bpy.context.scene.render.filepath = output
        bpy.ops.render.render(write_still=True)
        paths[mode] = os.path.relpath(output, os.path.dirname(prod('items', 'item_audit.json')))
        # Preserve imported geometry for the next view only; remove audit objects.
        for obj in [o for o in bpy.context.scene.objects if o.name.startswith(('Plane', 'Scale proxy', 'Cylinder', 'Sphere', 'Camera', 'Sun'))]:
            bpy.data.objects.remove(obj, do_unlink=True)
    return paths


def contact_sheets(records):
    import numpy as np
    for group in ('extraction', 'vehicle', 'promoted', 'infrastructure', 'everyday'):
        entries = [r for r in records if r.get('group') == group and 'renderPaths' in r]
        tile, cols = 300, 4
        rows = max(1, math.ceil(len(entries) / cols))
        canvas = np.ones((rows * tile, cols * tile, 4), dtype=np.float32)
        for index, entry in enumerate(entries):
            source = prod('items', entry['renderPaths']['normal'])
            image = bpy.data.images.load(source, check_existing=False)
            try:
                data = np.array(image.pixels[:], dtype=np.float32).reshape((image.size[1], image.size[0], 4))
                # Nearest-neighbour keeps audit sheets deterministic and dependency-free.
                yidx = np.linspace(0, data.shape[0] - 1, tile).astype(np.int32)
                xidx = np.linspace(0, data.shape[1] - 1, tile).astype(np.int32)
                resized = data[yidx][:, xidx]
                row, col = divmod(index, cols)
                canvas[row * tile:(row + 1) * tile, col * tile:(col + 1) * tile] = resized
            finally:
                bpy.data.images.remove(image)
        sheet = bpy.data.images.new('audit_sheet_' + group, width=cols * tile, height=rows * tile, alpha=True, float_buffer=False)
        sheet.pixels.foreach_set(canvas.ravel())
        sheet.filepath_raw = prod('items', 'audit_sheet_' + group + '.png')
        sheet.file_format = 'PNG'
        sheet.save()
        bpy.data.images.remove(sheet)


def main():
    records = []
    for item in build_candidates():
        record = dict(item)
        path = Path(record['sourcePath'])
        try:
            if not path.exists():
                raise FileNotFoundError(str(path))
            record['sha256'] = sha256(path)
            record['sizeBytes'] = path.stat().st_size
            reset_scene()
            measured = measure(path)
            record.update(measured)
            record['renderPaths'] = render_item(record, record)
        except Exception as exc:
            record['error'] = type(exc).__name__ + ': ' + str(exc)
        finally:
            records.append(record)
    contact_sheets(records)
    failures = [record for record in records if "error" in record]
    report = {"generatedBy": "tools/successor/assets/dustgate-redesign/proditems.py", "blenderVersion": bpy.app.version_string,
              "candidateCount": len(records), "errorCount": len(failures), "candidates": records}
    with open(prod('items', 'item_audit.json'), 'w', encoding='utf-8') as handle:
        handle.write(json.dumps(report, indent=2, sort_keys=True) + '\n')
    print("id\tspanX x spanY x spanZ\ttriangles\tmaterials\tgroundContact")
    for record in records:
        if 'error' in record:
            print(record['id'] + "\tERROR " + record['error'])
        else:
            s = record['spans']
            print(f"{record['id']}\t{s['x']:.3f} x {s['y']:.3f} x {s['z']:.3f}\t{record['triangles']}\t{len(record['materials'])}\t{record['groundContactY']}")
    if failures:
        failed_ids = ", ".join(record["id"] for record in failures)
        raise RuntimeError(f"{len(failures)} item audit(s) failed: {failed_ids}")

if __name__ == '__main__':
    script_args = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    if "--vendor-pinned" in script_args:
        vendor_pinned_candidates()
    else:
        main()
