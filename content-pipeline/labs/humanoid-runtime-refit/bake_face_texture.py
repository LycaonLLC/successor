"""Bake the default face panel texture with the canonical face kit.

The refined heads reserve `RB_Face`: 56 triangles filling a matching hole in the
head shell with their own rectangular UV island. The dev-only creator paints
that island from a live canvas; the shipped body needs the same pixels baked in
so a plain GLB consumer sees a coherent face.

Compositing stays inside `client-3d/src/assets/faceKit/face-kit.js` -- this
driver only decodes the five canonical atlases to raw RGBA, hands them to the
kit through `compose_face.mjs`, and re-encodes the result. No pixel is invented
here.

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
    """Place one square composite into the top `span` of the panel island.

    The panel border is invisible only while the background is exactly the tone
    the head material carries, so the padding below the canvas is filled with
    the config's own skin colour rather than left transparent or black.
    """
    face = compose(config, size).convert("RGB")
    height = int(round(size / max(1e-3, min(1.0, span))))
    height += height % 2
    tone = tuple(int(config["skinColor"].lstrip("#")[i * 2:i * 2 + 2], 16) for i in range(3))
    panel = Image.new("RGB", (size, height), tone)
    panel.paste(face, (0, 0))
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
