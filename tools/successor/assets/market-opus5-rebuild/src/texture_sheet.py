"""Texture contact sheet, generated FROM THE FINAL FILES ON DISK.

Pass 1 shipped a stale sheet. This reads every PNG in build/textures at call
time, stamps its sha256 prefix into the sheet, and writes a sidecar json listing
the exact hashes shown, so a stale sheet is detectable.

  python3 src/texture_sheet.py [outdir]
"""
import hashlib
import json
import os
import sys

import numpy as np
from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TEX = os.path.join(ROOT, "build", "textures")
OUTDIR = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, "proofs", "pass2")
MATS = ["sinter", "ceramic", "plaster", "screed", "roofmetal", "steel", "brass"]
KINDS = ["basecolor", "normal", "orm"]
CELL = 232
PAD = 30
LEFT = 104
TOP = 46


def load(p, size):
    im = Image.open(p).convert("RGB")
    return im.resize((size, size), Image.NEAREST if im.size[0] < size else Image.LANCZOS)


def main():
    W = LEFT + len(KINDS) * (CELL + PAD) + PAD + CELL + PAD
    H = TOP + len(MATS) * (CELL + PAD) + PAD
    sheet = Image.new("RGB", (W, H), (22, 22, 24))
    d = ImageDraw.Draw(sheet)
    shown = {}
    for ci, k in enumerate(KINDS):
        d.text((LEFT + ci * (CELL + PAD) + CELL // 2 - 22, 16), k.upper(),
               fill=(232, 232, 232))
    d.text((LEFT + len(KINDS) * (CELL + PAD) + CELL // 2 - 34, 16), "2x2 TILED",
           fill=(232, 232, 232))
    for ri, m in enumerate(MATS):
        y = TOP + ri * (CELL + PAD)
        d.text((10, y + CELL // 2 - 6), m, fill=(228, 216, 190))
        for ci, k in enumerate(KINDS):
            p = os.path.join(TEX, f"market_{m}_{k}.png")
            if not os.path.exists(p):
                continue
            h = hashlib.sha256(open(p, "rb").read()).hexdigest()
            shown[f"market_{m}_{k}.png"] = h
            im = load(p, CELL)
            x = LEFT + ci * (CELL + PAD)
            sheet.paste(im, (x, y))
            d.rectangle([x - 1, y - 1, x + CELL, y + CELL], outline=(70, 70, 74))
            d.text((x + 3, y + CELL + 4), f"{Image.open(p).size[0]}px {h[:10]}",
                   fill=(150, 150, 155))
        # 2x2 tiled basecolor: makes any residual repetition obvious
        p = os.path.join(TEX, f"market_{m}_basecolor.png")
        if os.path.exists(p):
            half = CELL // 2
            t = load(p, half)
            x = LEFT + len(KINDS) * (CELL + PAD)
            for dy in (0, half):
                for dx in (0, half):
                    sheet.paste(t, (x + dx, y + dy))
            d.rectangle([x - 1, y - 1, x + CELL, y + CELL], outline=(70, 70, 74))
            a = np.asarray(Image.open(p).convert("L"), np.float32) / 255.0
            d.text((x + 3, y + CELL + 4),
                   f"mean {a.mean():.3f} sd {a.std():.3f}", fill=(150, 150, 155))
    os.makedirs(OUTDIR, exist_ok=True)
    out = os.path.join(OUTDIR, "texture_contact_sheet.png")
    sheet.save(out)
    json.dump({"generated_from": TEX, "sheet": os.path.basename(out),
               "hashes_shown": shown},
              open(os.path.join(OUTDIR, "texture_contact_sheet.json"), "w"), indent=1)
    print(f"wrote {out} ({sheet.size[0]}x{sheet.size[1]}) from {len(shown)} files")


main()
