"""Deterministic source of truth for the Dustgate Clone Vault suite.

    /snap/bin/blender -b --factory-startup -noaudio --python-exit-code 1 \\
        -P tools/successor/assets/cloning-facility-opus5/src/build_clone_suite.py

Produces, in `client-3d/public/assets/world-items/`:

    cloning_facility.glb + _manifest.json + _collision.json + .provenance.json
    clone_pod.glb        + _manifest.json + .provenance.json
    clone_terminal.glb   + _manifest.json + .provenance.json

and, under the gitignored `.game-lab/cloning-facility-opus5-20260803/`:
    gate.json, plus the baked atlas images carried inside the GLBs.

`bank_terminal` is NOT built here.  It was split out to
`tools/successor/assets/build_bank_terminal.py` when this package replaced
`build_cloning_facility.py`, precisely so a cloning rebuild cannot disturb it.
"""
from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path

SRC = Path(__file__).resolve().parent
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

import bpy  # noqa: E402

import cf_bake  # noqa: E402
import cf_build  # noqa: E402
import cf_export  # noqa: E402
import cf_spec  # noqa: E402
import cf_vat  # noqa: E402
from cf_export import LAB, OUT_DIR, write_json  # noqa: E402
from cf_spec import (BUILDING, DOOR, ENVELOPE, FLOOR, INTERIOR_CLEAR_HEIGHT,
                     PAWN_HEIGHT_M, PAWN_MESH_HEIGHT_M, PROPS, ROLE_PREFIXES,
                     RUNTIME_SCALE_AT_10X8, TRI_BUDGET_FACILITY, VAT_BANK)

FACILITY_GLB = OUT_DIR / f"{BUILDING}.glb"
BLEND_DIR = SRC.parent / "blend"

DESCRIPTION_FACILITY = (
    "Dustgate Clone Vault - a 10x8-cell enterable biomedical-industrial landmark "
    "in the buildkit-opus5 frontier register: sintered ground plate and plinth, "
    "bleached panel skin with deep gunmetal reveals, a bronze datum at the "
    "construction line, corner piers carried past a stepped parapet, a corbelled "
    "filtration tower over the back-left roof, a rooftop process hall, bio "
    "reservoir and condenser bank, and a raised portal mass with an energised "
    "bioseal gasket and a twin-figure resurrection crest. Inside: three "
    "full-size cloning vats on the left wall - one open and vacant, one charged "
    "and occupied by a posed 1.725 m specimen, one primed on amber standby - "
    "served by an aisle gantry with an articulated arm, a back-wall process bank "
    "of buffer vessels, pumps and a valve manifold, and a right-wall control bank "
    "with a monitor wall, reagent rack and autoclave."
)
DESCRIPTION_POD = (
    "Standalone clone vat: octagonal sintered plinth on levelling feet, enamelled "
    "machine base with a louvred service door and bronze data plate, a 300-degree "
    "glazed chamber on a gunmetal service spine holding a foot plate, heel cups, "
    "spine post and cranial cradle, charged with culture fluid to a bronze "
    "meniscus, crowned by twin accumulators, a valve tree and a lift eye, with an "
    "amber standby light stack and looming umbilicals."
)
DESCRIPTION_TERMINAL = (
    "Clone control console: splayed gunmetal foot with a cable gland, enamel "
    "column with a bronze datum, bronze-edged deck carrying a raked switch bank, "
    "palm reader and sample dock, and a raked display head whose emissive face "
    "carries an authored pictogram readout - body chart with growth fill, "
    "viability ring, vitals traces and bay-status pips, with no lettering."
)


def _log(*args):
    print("[clone-suite]", *args, flush=True)


def _envelope_audit(objects):
    """Per-object envelope audit.  A single number saying "too wide" is not
    actionable; the offender list is."""
    lo = [1e9] * 3
    hi = [-1e9] * 3
    offenders = {}
    for obj in objects:
        if obj.type != "MESH":
            continue
        mw = obj.matrix_world
        for v in obj.data.vertices:
            w = mw @ v.co
            x, y, z = w.x, w.z, -w.y
            lo = [min(lo[0], x), min(lo[1], y), min(lo[2], z)]
            hi = [max(hi[0], x), max(hi[1], y), max(hi[2], z)]
            if (x < ENVELOPE["x_min"] - 1e-4 or x > ENVELOPE["x_max"] + 1e-4
                    or z < ENVELOPE["z_min"] - 1e-4 or z > ENVELOPE["z_max"] + 1e-4):
                cur = offenders.setdefault(obj.name, [1e9, 1e9, -1e9, -1e9])
                cur[0] = min(cur[0], round(x, 4))
                cur[1] = min(cur[1], round(z, 4))
                cur[2] = max(cur[2], round(x, 4))
                cur[3] = max(cur[3], round(z, 4))
    return lo, hi, offenders


def _bbox_of_objects(objects):
    lo = [1e9] * 3
    hi = [-1e9] * 3
    for obj in objects:
        if obj.type != "MESH":
            continue
        mw = obj.matrix_world
        for v in obj.data.vertices:
            w = mw @ v.co
            for i, value in enumerate((w.x, w.z, -w.y)):   # logical x, y, z
                lo[i] = min(lo[i], value)
                hi[i] = max(hi[i], value)
    return lo, hi


# ────────────────────────────── the facility ──────────────────────────────


def build_facility_asset(samples=None, atlas=None, save_blend=True):
    t0 = time.time()
    result = cf_build.build_facility()
    scene = result["scene"]
    root = result["root"]
    _log(f"facility scene: {result['tri_count']} tris, "
         f"{len(result['objects'])} objects, {time.time() - t0:.1f}s")

    lo, hi, offenders = _envelope_audit(result["objects"])
    envelope_ok = not offenders
    if offenders:
        _log("OUT OF ENVELOPE:", json.dumps(offenders))

    rig = bpy.data.collections[cf_build.RIG_COLLECTION]
    cf_bake.clear_lights(rig)
    cf_bake.build_world(scene)
    cf_bake.build_lights(rig)

    if save_blend:
        BLEND_DIR.mkdir(parents=True, exist_ok=True)
        bpy.ops.wm.save_as_mainfile(
            filepath=str(BLEND_DIR / "clone_facility_source.blend"),
            compress=True, copy=True)

    t = time.time()
    bake = cf_export.bake_and_collapse(
        scene, result["objects"],
        atlas or cf_spec.BAKE["facility_atlas"], BUILDING, samples=samples)
    _log(f"bake: {bake['atlas_objects']} atlas objects, "
         f"{bake['special_objects']} runtime-special, uv coverage "
         f"{bake['uv_coverage']}, {time.time() - t:.1f}s on {bake['device']}")

    cf_bake.clear_lights(rig)
    cf_export.export_glb(root, FACILITY_GLB, with_animations=True)
    cf_export.patch_door_rest_translation(FACILITY_GLB)
    metrics = cf_export.parse_glb_metrics(FACILITY_GLB)

    collision_path = OUT_DIR / f"{BUILDING}_collision.json"
    write_json(collision_path, cf_export.collision_sidecar())
    manifest = cf_export.facility_manifest(metrics, bake, collision_path, FACILITY_GLB)
    write_json(OUT_DIR / f"{BUILDING}_manifest.json", manifest)

    if save_blend:
        bpy.ops.wm.save_as_mainfile(
            filepath=str(BLEND_DIR / "clone_facility_baked.blend"),
            compress=True, copy=True)

    gate = facility_gate(metrics, manifest, bake, envelope_ok, (lo, hi))
    cf_export.write_provenance(
        BUILDING, FACILITY_GLB, metrics["tri_count"], DESCRIPTION_FACILITY,
        gate_summary=("numeric gates on the parsed GLB plus a multi-angle render "
                      f"review under .game-lab/{LAB.name}/proofs/"))
    return {"metrics": metrics, "manifest": manifest, "gate": gate, "bake": bake}


def facility_gate(metrics, manifest, bake, envelope_ok, bounds):
    lo, hi = bounds
    gltf = metrics["gltf"]
    names = metrics["node_names"]
    mesh_nodes = [n.get("name", "") for n in gltf.get("nodes", []) if "mesh" in n]
    op = DOOR["opening"]
    clips = {c["name"]: c for c in cf_export.animation_clips(metrics)}
    door_node = next((n for n in gltf["nodes"] if n.get("name") == DOOR["node"]), None)
    door_rest = door_node.get("translation") if door_node else None
    prefixed = [n for n in mesh_nodes if n.startswith(ROLE_PREFIXES)]
    unprefixed = [n for n in mesh_nodes
                  if not n.startswith(ROLE_PREFIXES)
                  and not n.startswith(DOOR["leaf_node"])]

    checks = {
        "envelope_9_5_by_7_6": bool(
            envelope_ok and abs(metrics["span"][0] - 9.5) < 2e-3
            and abs(metrics["span"][2] - 7.6) < 2e-3),
        "floor_top_0_02": abs(FLOOR["top_y_m"] - manifest["floorTopY"]) < 1e-9,
        "front_plus_z": manifest["front"] == "+Z",
        "role_prefixes_complete": not unprefixed,
        "every_role_prefix_used": all(
            any(n.startswith(p) for n in mesh_nodes) for p in ROLE_PREFIXES),
        "door_node_present": DOOR["node"] in names,
        "door_leaf_present": any(n.startswith(DOOR["leaf_node"]) for n in names),
        "door_clips_present": "door_open" in clips and "door_close" in clips,
        "door_travel_2_40": all(
            abs(clips[c]["translation_travel_m"] - DOOR["slide_distance_m"]) < 1e-3
            for c in ("door_open", "door_close") if c in clips),
        "door_clip_duration": all(
            abs(clips[c]["duration_s"] - DOOR["clip_duration_s"]) < 5e-3
            for c in ("door_open", "door_close") if c in clips),
        "door_rest_closed": door_rest is not None and all(
            abs(door_rest[i] - DOOR["closed_center"][i]) < 1e-4 for i in range(3)),
        "clear_opening_2_30_by_2_42": bool(
            abs((op["x_max"] - op["x_min"]) - 2.30) < 1e-6
            and abs((op["y_max"] - op["y_min"]) - 2.42) < 1e-6),
        "tri_budget": metrics["tri_count"] <= TRI_BUDGET_FACILITY,
        "textures_embedded": all(i["embedded"] for i in metrics["images"]),
        "atlas_material_present": cf_spec.ATLAS_MATERIAL in metrics["materials"],
        "material_count_lean": len(metrics["materials"]) <= 12,
        "vat_fits_pawn": cf_vat.chamber_clear_height() >= PAWN_MESH_HEIGHT_M + 0.08,
        "vat_bank_three_states": len({s[2] for s in VAT_BANK["slots"]}) == 3,
        "occupant_present": any("occupant" in n for n in mesh_nodes),
        "interior_clear_height": INTERIOR_CLEAR_HEIGHT >= 3.0,
        "uv_coverage_reasonable": 0.20 <= bake["uv_coverage"] <= 1.0,
        # A gate on the shipped PIXELS, not on the scene: the whole point of the
        # bake is that the base colour carries the read, and an atlas that is
        # mostly black passes every geometric check ever written.  The bound is
        # HALF the UV coverage because roughly a third of the packed area belongs
        # to faces buried inside solids, which legitimately receive nothing; the
        # regression this catches measured 0.023 against a 0.26 bound.
        "atlas_carries_light": bake["basecolor_lit_fraction"] >= bake["uv_coverage"] * 0.50,
        "atlas_mean_reasonable": 0.06 <= bake["basecolor_mean"] <= 0.85,
        "no_skins_or_armatures": "skins" not in gltf,
    }
    return {
        "asset": BUILDING,
        "all_green": all(checks.values()),
        "checks": checks,
        "span_m": [round(v, 4) for v in metrics["span"]],
        "logical_bounds": {"min": [round(v, 4) for v in lo],
                           "max": [round(v, 4) for v in hi]},
        "tri_count": metrics["tri_count"],
        "mesh_nodes": len(mesh_nodes),
        "unprefixed_mesh_nodes": unprefixed,
        "role_prefixed_nodes": len(prefixed),
        "materials": metrics["materials"],
        "images": metrics["images"],
        "animations": cf_export.animation_clips(metrics),
        "door_rest_translation": door_rest,
        "bake": {k: v for k, v in bake.items() if k not in ("images", "material")},
        "vat": {
            "chamber_clear_height_m": round(cf_vat.chamber_clear_height(), 4),
            "chamber_clear_width_m": round(cf_vat.chamber_clear_width(), 4),
            "runtime_clear_height_m": round(
                cf_vat.chamber_clear_height() * RUNTIME_SCALE_AT_10X8, 4),
            "occupant_mesh_height_m": round(PAWN_MESH_HEIGHT_M, 4),
            "occupant_runtime_height_m": PAWN_HEIGHT_M,
            "states": [s[2] for s in VAT_BANK["slots"]],
        },
        "bytes": metrics["bytes"],
    }


# ──────────────────────────────── the props ───────────────────────────────


def build_prop_asset(kind, samples=None, save_blend=True):
    result = cf_build.build_prop(kind)
    scene = result["scene"]
    root = result["root"]
    spec = PROPS[kind]
    lo, hi = _bbox_of_objects(result["objects"])

    rig = bpy.data.collections[cf_build.RIG_COLLECTION]
    cf_bake.clear_lights(rig)
    cf_bake.build_world(scene)
    cf_bake.build_lights(rig)

    bake = cf_export.bake_and_collapse(scene, result["objects"], spec["atlas"],
                                       kind, samples=samples)
    cf_bake.clear_lights(rig)
    glb = OUT_DIR / f"{kind}.glb"
    cf_export.export_glb(root, glb, with_animations=False)
    metrics = cf_export.parse_glb_metrics(glb)
    manifest = cf_export.prop_manifest(kind, metrics, bake, glb)
    write_json(OUT_DIR / f"{kind}_manifest.json", manifest)

    height = metrics["span"][1]
    checks = {
        "footprint_matches_spec": bool(
            abs(metrics["span"][0] - spec["footprint"][0]) < 5e-3
            and abs(metrics["span"][2] - spec["footprint"][1]) < 5e-3),
        "height_in_range": bool(
            spec["height_range_m"][0] <= height <= spec["height_range_m"][1]),
        "root_node_present": spec["root_node"] in metrics["node_names"],
        "tri_budget": metrics["tri_count"] <= spec["tri_budget"],
        "textures_embedded": all(i["embedded"] for i in metrics["images"]),
        "atlas_material_present": cf_spec.ATLAS_MATERIAL in metrics["materials"],
        "no_animations": not metrics["animations"],
        "sits_on_grade": abs(lo[1]) < 1e-3,
    }
    if kind == "clone_pod":
        from cf_props import POD_CHAMBER_TOP, POD_FOOT_PLATE
        checks["chamber_fits_pawn"] = bool(
            POD_CHAMBER_TOP - POD_FOOT_PLATE >= PAWN_MESH_HEIGHT_M + 0.05)
    gate = {"asset": kind, "all_green": all(checks.values()), "checks": checks,
            "span_m": [round(v, 4) for v in metrics["span"]],
            "tri_count": metrics["tri_count"], "materials": metrics["materials"],
            "images": metrics["images"], "bytes": metrics["bytes"]}
    description = DESCRIPTION_POD if kind == "clone_pod" else DESCRIPTION_TERMINAL
    cf_export.write_provenance(kind, glb, metrics["tri_count"], description,
                               gate_summary=f"numeric gate: {json.dumps(checks)}")
    if save_blend:
        BLEND_DIR.mkdir(parents=True, exist_ok=True)
        bpy.ops.wm.save_as_mainfile(
            filepath=str(BLEND_DIR / f"{kind}_baked.blend"), compress=True, copy=True)
    return {"metrics": metrics, "manifest": manifest, "gate": gate}


# ──────────────────────────────── driver ──────────────────────────────────


def main():
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    LAB.mkdir(parents=True, exist_ok=True)
    samples = int(os.environ.get("CF_BAKE_SAMPLES", "0")) or None
    atlas = int(os.environ.get("CF_ATLAS", "0")) or None
    validate = os.environ.get("CF_VALIDATE", "1") == "1"
    save_blend = os.environ.get("CF_SAVE_BLEND", "1") == "1"

    t0 = time.time()
    facility = build_facility_asset(samples=samples, atlas=atlas, save_blend=save_blend)
    _log("facility gate:", "GREEN" if facility["gate"]["all_green"] else "RED")

    gates = {"cloning_facility": facility["gate"]}
    for kind in ("clone_pod", "clone_terminal"):
        prop = build_prop_asset(kind, samples=samples, save_blend=save_blend)
        gates[kind] = prop["gate"]
        _log(f"{kind} gate:", "GREEN" if prop["gate"]["all_green"] else "RED")

    if validate:
        for key, path in (("cloning_facility", FACILITY_GLB),
                          ("clone_pod", OUT_DIR / "clone_pod.glb"),
                          ("clone_terminal", OUT_DIR / "clone_terminal.glb")):
            report = cf_export.run_validator(path)
            gates[key]["validator"] = report
            gates[key]["all_green"] = gates[key]["all_green"] and report.get("pass", False)
            _log(f"{key} validator: pass={report.get('pass')} "
                 f"errors={report.get('numErrors')}")

    summary = {
        "run": cf_spec.VERSION,
        "seconds": round(time.time() - t0, 1),
        "blender": bpy.app.version_string,
        "all_green": all(g["all_green"] for g in gates.values()),
        "assets": gates,
    }
    write_json(LAB / "gate.json", summary)
    _log("total", summary["seconds"], "s",
         "ALL GREEN" if summary["all_green"] else "NOT GREEN")
    if not summary["all_green"]:
        failed = {k: [c for c, ok in g["checks"].items() if not ok]
                  for k, g in gates.items() if not g["all_green"]}
        _log("failures:", json.dumps(failed))
        raise SystemExit(1)


if __name__ == "__main__":
    main()
