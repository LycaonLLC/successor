"""Bake the default transparent face-component overlay.

The refined heads reserve `RB_Face`: 56 triangles filling a matching hole in
the head shell. Promotion emits that panel first as ordinary opaque head skin,
then duplicates it 1.5 mm forward for this RGBA texture. Only eyes, brows, nose,
and mouth survive the compositor's background key; transparent pixels reveal
the skin panel instead of painting a second, darker skin rectangle over it.

Compositing stays inside `client-3d/src/assets/faceKit/face-kit.js`; this driver
only decodes the canonical atlases, invokes the compositor, and re-encodes its
straight-alpha output.

    python3 bake_face_texture.py
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile

from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import refit_config as CFG  # noqa: E402


def compose(config: dict, size: int, transparent: bool = False) -> Image.Image:
    """Run the canonical compositor and return the RGBA result."""
    with tempfile.TemporaryDirectory() as scratch:
        assets = {}
        for key, filename in CFG.FACE_ATLASES.items():
            image = Image.open(os.path.join(CFG.FACE_KIT_ASSETS, filename)).convert("RGBA")
            raw = os.path.join(scratch, f"{key}.rgba")
            with open(raw, "wb") as handle:
                handle.write(image.tobytes())
            assets[key] = {"path": raw, "width": image.width, "height": image.height}
        out = os.path.join(scratch, "face.rgba")
        job = os.path.join(scratch, "job.json")
        with open(job, "w", encoding="utf-8") as handle:
            json.dump({"assets": assets, "config": config, "size": size,
                       "transparent": transparent, "out": out}, handle)
        subprocess.run(["node", os.path.join(CFG.LAB_DIR, "compose_face.mjs"), job],
                       check=True, cwd=CFG.LAB_DIR, stdout=subprocess.DEVNULL)
        with open(out, "rb") as handle:
            return Image.frombytes("RGBA", (size, size), handle.read())


def panel_texture(config: dict, span: float, size: int) -> Image.Image:
    """Place a background-erased square composite at the top of the panel UV."""
    face = compose(config, size, transparent=True)
    height = int(round(size / max(1e-3, min(1.0, span))))
    height += height % 2
    panel = Image.new("RGBA", (size, height), (0, 0, 0, 0))
    panel.paste(face, (0, 0))

    alpha = panel.getchannel("A")
    corners = (alpha.getpixel((0, 0)), alpha.getpixel((size - 1, 0)),
               alpha.getpixel((0, height - 1)), alpha.getpixel((size - 1, height - 1)))
    if any(corners):
        raise SystemExit(f"face compositor leaked background into panel corners: {corners}")
    transparent_pixels = alpha.histogram()[0]
    if transparent_pixels < size * height // 2:
        raise SystemExit("face compositor retained a skin-coloured background")
    return panel


def main() -> None:
    CFG.ensure_dirs()
    written = {}
    path = os.path.join(CFG.TEXTURE_DIR, "face_default.png")
    panel_texture(CFG.DEFAULT_FACE, CFG.FACE_PANEL_V_SPAN,
                  CFG.FACE_TEXTURE_SIZE).save(path, optimize=True)
    written["face_default.png"] = os.path.getsize(path)
    print(json.dumps(written, indent=2))


if __name__ == "__main__":
    main()
