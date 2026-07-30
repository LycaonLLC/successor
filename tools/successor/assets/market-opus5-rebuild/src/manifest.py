"""Final deliverable manifest, generated FROM THE FILES ON DISK.

Run after build_market.py and post_gltf.mjs, so every hash is the hash of the
shipped artefact rather than of an intermediate.

  python3 src/manifest.py
"""
import hashlib
import json
import os
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BUILD = os.path.join(ROOT, "build")
sys.path.insert(0, os.path.join(ROOT, "src"))
import plan as PL  # noqa: E402


def sha(p):
    return hashlib.sha256(open(p, "rb").read()).hexdigest()


def git_rev():
    try:
        return subprocess.check_output(["git", "rev-parse", "--short", "HEAD"],
                                       cwd=ROOT, stderr=subprocess.DEVNULL).decode().strip()
    except Exception:
        return None


def main():
    rep = json.load(open(os.path.join(BUILD, "build_report.json")))
    man = {
        "schema": "successor.market-rebuild-manifest.v1",
        "asset_id": "market_house_opus5",
        "label": "Valley Market (scheme E)",
        "generator": "tools/successor/assets/market-opus5-rebuild/src/build_market.py",
        "generator_sha256": sha(os.path.join(ROOT, "src", "build_market.py")),
        "post_export": "src/post_gltf.mjs (occlusion wiring + unused-attribute prune)",
        "git_rev": git_rev(),
        "units": "m",
        "gltf_conventions": {"up": "+Y", "front": "+Z (public side)",
                             "floor_top_y_m": PL.FLOOR_TOP,
                             "origin": "centre of the 12x9 footprint"},
        "footprint_max_m": {"x": PL.MAX_FOOTPRINT[0], "z": PL.MAX_FOOTPRINT[1]},
        "authority_grid": rep["contract"]["grid"],
        "fixture_cells": rep["contract"]["fixture_cells"],
        "approach_cells": rep["contract"]["approach_cells"],
        "cutaway_prefixes": rep["contract"]["cutaway_prefixes"],
        "permanent_prefixes": ["floor__", "interior__"],
        "interior_bounds_authoring_m": rep["contract"]["interior_bounds_authoring_m"],
        "door": rep["door"],
        "roof": rep["roof"],
        "lods": {},
        "furnished": {},
        "collision": {"schema": "successor.structure-collision.v3",
                      "sidecar": "market_house.collision.json",
                      "box_count": rep["collision"]["box_count"],
                      "clearance_issues": rep["collision"]["clearance_issues"],
                      "clearance_checks": rep["collision"]["clearance_checks"]},
        "props": rep["props"],
        "props_omitted": rep["props_omitted"],
        "textures": rep["textures"],
        "blend_files": {},
        "notes": [],
    }
    for k, v in rep["lods"].items():
        f = os.path.join(BUILD, v["file"])
        man["lods"][k] = {
            "file": v["file"], "triangles": v["triangles"],
            "triangle_budget": v["triangle_budget"],
            "within_budget": v["within_budget"],
            "material_count": v["material_count"], "materials": v["materials"],
            "nodes": v["objects"], "size_m": v["size_m"],
            "bounds_authoring_m": v["bounds_authoring_m"],
            "bytes": os.path.getsize(f), "sha256": sha(f)}
    f = os.path.join(BUILD, rep["furnished"]["file"])
    man["furnished"] = {"file": rep["furnished"]["file"],
                        "triangles_with_props": rep["furnished"]["triangles_with_props"],
                        "bytes": os.path.getsize(f), "sha256": sha(f)}
    for nm in sorted(os.listdir(BUILD)):
        if nm.endswith(".blend"):
            man["blend_files"][nm] = {"bytes": os.path.getsize(os.path.join(BUILD, nm)),
                                      "sha256": sha(os.path.join(BUILD, nm))}
    ck = os.path.join(BUILD, "checkpoints")
    if os.path.isdir(ck):
        for nm in sorted(os.listdir(ck)):
            if nm.endswith(".blend"):
                man["blend_files"]["checkpoints/" + nm] = {
                    "bytes": os.path.getsize(os.path.join(ck, nm)),
                    "sha256": sha(os.path.join(ck, nm))}
    sc = os.path.join(BUILD, "market_house.collision.json")
    man["collision"]["sidecar_sha256"] = sha(sc)
    man["texture_memory"] = {
        "total_png_bytes": sum(t["bytes"] for t in rep["textures"].values()),
        "unique_images": len(rep["textures"]),
        "policy": "7 PBR sets (basecolor 512, normal 512, ORM 256) shared by all "
                  "authored geometry; macro variation lives in COLOR_0, not in "
                  "extra images"}
    out = os.path.join(BUILD, "market_house.manifest.json")
    json.dump(man, open(out, "w"), indent=1)
    print(f"wrote {out}")
    for k, v in man["lods"].items():
        print(f"  {k}: {v['triangles']:>6d}/{v['triangle_budget']} tris  "
              f"{v['material_count']} mats  {v['bytes']/1024:7.1f} KB  {v['sha256'][:16]}")
    print(f"  furnished: {man['furnished']['bytes']/1024:.1f} KB  "
          f"{man['furnished']['triangles_with_props']} tris")
    print(f"  textures: {man['texture_memory']['unique_images']} images, "
          f"{man['texture_memory']['total_png_bytes']/1024/1024:.2f} MB")
    print("MANIFEST_OK")


main()
