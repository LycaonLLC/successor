"""Proof packet for the selected Dustgate direction.

    blender -b -P proof.py

Reloads the freshly exported review GLB into an empty scene rather than reusing
live builder state, so every proof frame is evidence about the exported asset.
Ground, scale proxies, lighting, and cameras are added around the import.

Renders:
  * selected-layout top view and a three-quarter gameplay-pitch overview;
  * south (front), north (back), west (left), east (right) elevations;
  * one normal-zoom exterior gameplay frame;
  * one cutaway gameplay frame per structure, hiding exactly the runtime reveal
    set (`roof__`, `wall_front__`, `wall_right__`) for that structure;
  * nine close crops: threshold/ground contact, primary functional detail, and
    the worst-risk cutaway seam or functional side of each building.
"""

from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import bpy  # type: ignore

import dgkit as dg
import layout as L
from build_selected import PALETTE, bx, by
from dgpaths import proof

REVEAL_PREFIXES = ("roof__", "wall_front__", "wall_right__")
STRUCTURE_KEYS = ("clone", "commerce", "shelter")

OVERVIEW_TARGET = (0.5, 4.0, 2.0)
PLAN_FRUSTUM = 44.0
OVERVIEW_FRUSTUM = 34.0
GAMEPLAY_FRUSTUM = 12.5

CROPS = {
    # name: (target, frustum, why this crop is required)
    "clone_threshold": ((-11.1, -0.3, 1.5), 6.5,
                        "clone door, jambs, gantry legs, wall base ground contact"),
    "clone_pod_bank": ((-16.4, 6.4, 1.8), 6.0,
                       "primary functional read: pod drums bulging through the wall"),
    "clone_sawtooth_seam": ((-15.6, 4.6, 3.7), 5.5,
                            "worst-risk seam: sawtooth risers meeting the left wall"),
    "commerce_threshold": ((1.5, -1.0, 1.6), 7.0,
                           "commerce door, threshold piers, sail posts, contact band"),
    "commerce_monitor": ((2.0, 4.4, 5.1), 7.0,
                         "primary functional read: ridge monitor louvres"),
    "commerce_annex_weld": ((8.0, 6.6, 2.6), 6.5,
                            "worst-risk side: strongroom annex against the east gable"),
    "shelter_threshold": ((15.0, 1.1, 1.5), 6.0,
                          "shelter door, storm porch, step, contact band"),
    "shelter_water_catch": ((18.7, 6.4, 1.9), 6.5,
                            "primary functional read: gutter, downpipe, cistern"),
    "shelter_gutter_seam": ((15.2, 7.9, 2.6), 6.5,
                            "worst-risk seam: north eave, gutter, and back wall top"),
}

GAMEPLAY_FRAMES = {
    "exterior_plaza": (1.5, -2.0, 1.0),
    "exterior_clone": (-11.0, -0.5, 1.0),
    "exterior_shelter": (15.0, 1.0, 1.0),
}

CUTAWAY_TARGETS = {
    "clone": (-11.0, 5.2, 1.0),
    "commerce": (2.0, 4.2, 1.0),
    "shelter": (15.0, 5.0, 1.0),
}

INTERIOR_PROXIES = {
    # local cell centres inside each shell, for cutaway scale reading
    "clone": [(9.5, 11.5), (12.5, 7.5), (5.5, 7.5)],
    "commerce": [(21.5, 7.5), (18.5, 8.6), (25.5, 11.5), (23.0, 12.6)],
    "shelter": [(35.0, 10.4), (33.5, 9.4)],
}


def structure_of(name: str) -> str | None:
    for prefix in ("roof__", "wall_front__", "wall_right__", "wall_back__",
                   "wall_left__", "floor__", "interior__"):
        if name.startswith(prefix):
            rest = name[len(prefix):]
            for key in STRUCTURE_KEYS:
                if rest.startswith(key):
                    return key
    return None


def in_reveal_set(name: str) -> bool:
    return name.startswith(REVEAL_PREFIXES)


def load_export() -> str:
    path = proof("glb", "dustgate_selected_review.glb")
    if not os.path.exists(path):
        raise SystemExit(f"missing export: {path}; run build_selected.py first")
    dg.reset()
    bpy.ops.import_scene.gltf(filepath=path)
    return path


def add_context() -> None:
    sand = dg.mat("PROOF_sand", PALETTE["sand"][0], rough=PALETTE["sand"][1])
    proxy_mat = dg.mat("PROOF_proxy", PALETTE["proxy"][0], rough=PALETTE["proxy"][1])
    dg.ground_plane("ground", 200.0, sand)
    outdoor = [
        ("spawn", L.POINTS[0]["cell"]["centre"]),
        ("grok", next(i for i in L.FREESTANDING
                      if i["id"] == "study-grok")["anchor"]["centre"]),
        ("commerce_threshold", [21.5, 15.6]),
        ("clone_threshold", [8.9, 14.6]),
        ("shelter_threshold", [35.0, 13.6]),
        ("travel", [22.0, 21.8]),
    ]
    for name, (lx, ly) in outdoor:
        dg.capsule(f"proxy__out_{name}", bx(lx), by(ly), 0.0, 0.3, 1.75, proxy_mat)
    for key, spots in INTERIOR_PROXIES.items():
        for i, (lx, ly) in enumerate(spots):
            dg.capsule(f"proxy__in_{key}_{i:02d}", bx(lx), by(ly), 0.05, 0.3, 1.75,
                       proxy_mat)


def set_cutaway(active: str | None) -> None:
    for obj in bpy.context.scene.objects:
        if obj.type != "MESH":
            continue
        key = structure_of(obj.name)
        hide = active is not None and key == active and in_reveal_set(obj.name)
        obj.hide_render = hide
        if obj.name.startswith("proxy__in_"):
            obj.hide_render = active is not None and f"proxy__in_{active}_" not in obj.name
        elif obj.name.startswith("proxy__out_"):
            obj.hide_render = False


def main() -> None:
    path = load_export()
    imported = [o.name for o in dg.mesh_objects()]
    add_context()
    dg.setup_world()
    dg.add_sun(azimuth_deg=215.0, elevation_deg=54.0)
    dg.configure_render(res_x=1600, res_y=900, samples=64)

    families: dict[str, int] = {}
    for name in imported:
        head = name.split("__", 1)[0] + "__" if "__" in name else "(none)"
        families[head] = families.get(head, 0) + 1
    print(f"[proof] reloaded {len(imported)} meshes from {path}")
    print(f"[proof] node families: {families}")

    set_cutaway(None)

    plan = dg.add_ortho_camera_axis("proof_plan", OVERVIEW_TARGET, "top", PLAN_FRUSTUM)
    dg.render_to(proof("packet", "01_layout_top.png"), plan, 1400, 1400)

    overview = dg.add_camera("proof_overview", OVERVIEW_TARGET, OVERVIEW_FRUSTUM)
    dg.render_to(proof("packet", "02_overview_three_quarter.png"), overview, 1800, 1012)

    for label, axis, frustum in (("03_elevation_front_south", "south", 22.0),
                                 ("04_elevation_back_north", "north", 22.0),
                                 ("05_elevation_left_west", "west", 13.0),
                                 ("06_elevation_right_east", "east", 13.0)):
        cam = dg.add_ortho_camera_axis(f"proof_{axis}", OVERVIEW_TARGET, axis, frustum)
        dg.render_to(proof("packet", f"{label}.png"), cam, 1800, 1012)

    for i, (label, target) in enumerate(GAMEPLAY_FRAMES.items()):
        cam = dg.add_camera(f"proof_play_{label}", target, GAMEPLAY_FRUSTUM)
        dg.render_to(proof("packet", f"07_{i}_gameplay_{label}.png"), cam, 1600, 900)

    for key in STRUCTURE_KEYS:
        set_cutaway(key)
        cam = dg.add_camera(f"proof_cut_{key}", CUTAWAY_TARGETS[key], GAMEPLAY_FRUSTUM)
        dg.render_to(proof("packet", f"08_cutaway_{key}.png"), cam, 1600, 900)
    set_cutaway(None)

    for name, (target, frustum, _why) in CROPS.items():
        cam = dg.add_camera(f"proof_crop_{name}", target, frustum)
        dg.render_to(proof("crops", f"{name}.png"), cam, 1100, 1100)

    print("[proof] packet complete")


if __name__ == "__main__":
    main()
