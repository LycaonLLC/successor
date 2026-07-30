#!/usr/bin/env python3
"""Compare rendered mask sweeps: skin-pixel regression over garment interior.

usage: python3 compare_renders.py BASE_DIR TEST_DIR [--pixel-budget N]
skin = magenta, garment = green, bg = black.
regression px = TEST_skin & erode(BASE_garm, 2) & ~dilate(BASE_skin, 3)
"""
import sys
import json
from pathlib import Path

import numpy as np
from PIL import Image
from scipy import ndimage

base_dir, test_dir = Path(sys.argv[1]), Path(sys.argv[2])
budget = int(sys.argv[sys.argv.index("--pixel-budget") + 1]) if "--pixel-budget" in sys.argv else 10

def masks(path):
    im = np.asarray(Image.open(path).convert("RGB")).astype(int)
    r, g, b = im[..., 0], im[..., 1], im[..., 2]
    skin = (r > 150) & (b > 150) & (g < 150)
    garm = (g > 150) & (r < 150) & (b < 150)
    return skin, garm

results = {}
worst = ("", 0)
for gdir in sorted(base_dir.iterdir()):
    if not gdir.is_dir():
        continue
    gid = gdir.name
    total = 0
    cellmax = 0
    cellmax_name = ""
    for f in sorted(gdir.glob("*.png")):
        b_skin, b_garm = masks(f)
        t_skin, _t_garm = masks(test_dir / gid / f.name)
        reg = t_skin & ndimage.binary_erosion(b_garm, np.ones((9, 9))) \
                     & ~ndimage.binary_dilation(b_skin, np.ones((7, 7)))
        n = int(reg.sum())
        total += n
        if n > cellmax:
            cellmax, cellmax_name = n, f.name
    results[gid] = dict(total_px=total, worst_cell_px=cellmax, worst_cell=cellmax_name)
    if cellmax > worst[1]:
        worst = (f"{gid}/{cellmax_name}", cellmax)
    print(f"{gid:32s} total={total:6d}px worst_cell={cellmax:5d}px ({cellmax_name})")

fail = worst[1] > budget
print(f"[gate] worst cell {worst[0]} = {worst[1]}px, budget {budget}px -> {'FAIL' if fail else 'PASS'}")
json.dump(results, open(str(test_dir) + "_vs_" + base_dir.name + ".json", "w"), indent=1)
sys.exit(1 if fail else 0)
