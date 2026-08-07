"""Headless iteration driver.

    blender -b --factory-startup -noaudio -P cf_lab.py -- <pass> [views...]

The live Blender MCP session is the interactive surface, but its EEVEE context
runs on the software rasteriser behind Xvfb, which makes a 900x675 frame cost
~45 s.  This script builds the identical scene from the identical modules and
renders in a separate process, so a whole view sheet can be produced while the
MCP session stays responsive for scene surgery.
"""
from __future__ import annotations

import os
import sys
import time
from pathlib import Path

SRC = Path(__file__).resolve().parent
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

REPO = SRC.parents[4]
LAB = REPO / ".game-lab" / "cloning-facility-opus5-20260803"

import bpy  # noqa: E402

import cf_bake  # noqa: E402
import cf_build  # noqa: E402
import cf_render  # noqa: E402
from cf_spec import REVEAL_PREFIXES  # noqa: E402


def main():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    tag = argv[0] if argv else "scratch"
    wanted = argv[1:] or ["01_front_three_quarter", "02_rear_three_quarter",
                          "03_front_elevation", "10_interior_wide"]
    samples = int(os.environ.get("CF_SAMPLES", "24"))
    res = int(os.environ.get("CF_RES", "900"))
    night = os.environ.get("CF_NIGHT", "0") == "1"

    t0 = time.time()
    res_build = cf_build.build_facility()
    scene = res_build["scene"]
    root = res_build["root"]
    rig = bpy.data.collections[cf_build.RIG_COLLECTION]
    cf_bake.clear_lights(rig)
    cf_bake.build_world(scene, night=night)
    cf_bake.build_lights(rig, night=night)
    cf_render.build_ground_plane(rig)
    staff = cf_render.build_scale_figure(rig, 2.95, 4.70)
    cf_render.setup_scene(scene, samples=samples,
                          resolution=(res, int(res * 0.75)), night=night)
    print(f"[cf_lab] built {res_build['tri_count']} tris in {time.time() - t0:.2f}s")

    out = LAB / "iter" / tag
    for key in wanted:
        if key not in cf_render.VIEWS:
            print(f"[cf_lab] unknown view {key}")
            continue
        eye, target, lens = cf_render.VIEWS[key]
        ortho = cf_render.ORTHO_SCALE.get(key)
        cam = cf_render.camera("CF_CAM", eye, target,
                               lens=lens or 50.0, ortho=ortho, collection=rig)
        interior = key.startswith(("10", "11", "12", "13", "14", "15", "16", "20"))
        cf_render.show_all(root)
        cf_render.set_ref(staff, key)
        if interior:
            cf_render.hide_prefixes(root, REVEAL_PREFIXES, True)
        if key.startswith("3"):
            # occupant-only: the pose has to be judged without the vat in front
            for obj in root.children_recursive:
                if "occupant" not in obj.name:
                    obj.hide_render = True
        if key == "07_door_open":
            _open_door(res_build["door"])
        t = time.time()
        path = cf_render.render(scene, cam, out / f"{key}.png")
        print(f"[cf_lab] {key} -> {path}  {time.time() - t:.1f}s")
        if key == "07_door_open":
            _close_door(res_build["door"])
    cf_render.show_all(root)
    print(f"[cf_lab] done in {time.time() - t0:.1f}s")


def _open_door(door):
    from cf_spec import DOOR
    axis, dist = DOOR["slide_axis_local"], DOOR["slide_distance_m"]
    door.location = (door.location[0] + axis[0] * dist,
                     door.location[1] - axis[2] * dist,
                     door.location[2] + axis[1] * dist)


def _close_door(door):
    from cf_spec import DOOR
    axis, dist = DOOR["slide_axis_local"], DOOR["slide_distance_m"]
    door.location = (door.location[0] - axis[0] * dist,
                     door.location[1] + axis[2] * dist,
                     door.location[2] - axis[1] * dist)


if __name__ == "__main__":
    main()
