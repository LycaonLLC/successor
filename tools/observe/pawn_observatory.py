"""Look at the player character properly, from every surface that draws it.

The character is rendered by four independent paths - the world view and the
inventory, character and examine viewers - and a change to the body can land
correctly in one and wrongly in another. Eyeballing a screenshot and guessing
where the pawn is does not catch that. Neither does a single front-on shot: a
skull can measure right and still read wrong in three-quarter view.

So this drives the live client through `successor-control` and collects the same
subject from every surface and several angles, then lays them out side by side.

Nothing here hardcodes a screen position. The pawn is found by MOTION: disturb
only the subject - spin a viewer, take a step - diff the frames, and the pixels
that changed are the subject. That survives window moves, resolution changes and
UI edits, which a pixel constant does not.

    python3 tools/observe/pawn_observatory.py --port 47779 --out /tmp/obs

Requires a client already running with `--control-port`.
"""
from __future__ import annotations

import argparse
import json
import pathlib
import subprocess
import time

from PIL import Image, ImageDraw

REPO = pathlib.Path(__file__).resolve().parents[2]
CONTROL = REPO / "client-rust" / "target" / "release" / "successor-control"

#: Windows that host a live 3D character viewer, and the key that toggles each.
DOLL_SURFACES = {"inventory": "i", "character": "c"}
#: A pixel has to shift by more than this to count as the subject moving, which
#: keeps dithering and the animated background out of the bounding box.
MOTION_THRESHOLD = 26
#: Ignore motion specks smaller than this share of the largest row/column, so a
#: blinking HUD light never widens the box.
MOTION_FLOOR = 0.18


class Observatory:
    def __init__(self, port: str, out: pathlib.Path):
        self.port = str(port)
        self.out = out
        self.out.mkdir(parents=True, exist_ok=True)
        self.frame = 0

    # -- plumbing ---------------------------------------------------------
    def run(self, script: str, timeout: int = 60) -> str:
        done = subprocess.run([str(CONTROL), "--port", self.port], input=script,
                              capture_output=True, text=True, timeout=timeout)
        return done.stdout

    def status(self) -> dict:
        for line in self.run("status\n").splitlines():
            line = line.strip()
            if line.startswith("{"):
                try:
                    return json.loads(line)
                except json.JSONDecodeError:
                    continue
        return {}

    def shot(self, tag: str, settle: float = 0.9) -> Image.Image:
        time.sleep(settle)
        self.frame += 1
        path = self.out / f"raw-{self.frame:03d}-{tag}.bmp"
        self.run(f"screenshot {path}\n")
        for _ in range(20):
            if path.exists() and path.stat().st_size > 0:
                break
            time.sleep(0.15)
        return Image.open(path).convert("RGB")

    # -- finding the subject ----------------------------------------------
    @staticmethod
    def motion_box(before: Image.Image, after: Image.Image):
        """Bounding box of what actually moved between two frames."""
        wide, tall = before.size
        a, b = before.load(), after.load()
        rows, cols = [0] * tall, [0] * wide
        for y in range(0, tall, 2):
            for x in range(0, wide, 2):
                pa, pb = a[x, y], b[x, y]
                if (abs(pa[0] - pb[0]) + abs(pa[1] - pb[1])
                        + abs(pa[2] - pb[2])) > MOTION_THRESHOLD:
                    rows[y] += 1
                    cols[x] += 1
        if not any(rows):
            return None
        row_floor = max(rows) * MOTION_FLOOR
        col_floor = max(cols) * MOTION_FLOOR
        ys = [y for y, n in enumerate(rows) if n > row_floor]
        xs = [x for x, n in enumerate(cols) if n > col_floor]
        if not xs or not ys:
            return None
        pad = 14
        return (max(0, min(xs) - pad), max(0, min(ys) - pad),
                min(wide, max(xs) + pad), min(tall, max(ys) + pad))

    def locate(self, disturb: str, tag: str):
        """Find the subject by moving only it and diffing."""
        before = self.shot(f"{tag}-a")
        self.run(disturb)
        after = self.shot(f"{tag}-b")
        return self.motion_box(before, after), after

    def locate_window(self, surface: str):
        """Rect of a doll window, found by closing and reopening it."""
        key = DOLL_SURFACES[surface]
        box, _ = self.locate(f"key tap {key}\nwait 800\n", f"{surface}-window")
        self.run(f"key tap {key}\nwait 800\n")   # restore the state we found it in
        time.sleep(0.9)
        return box

    def locate_idle(self, tag: str, hold: float = 1.6):
        """Rect of whatever moves on its own.

        For the world pawn this is the idle animation. Walking would work too,
        but the camera follows the player, so every pixel changes and the diff
        says nothing. Standing still leaves the pawn as the only thing moving.
        """
        before = self.shot(f"{tag}-a")
        time.sleep(hold)
        after = self.shot(f"{tag}-b")
        return self.motion_box(before, after), after

    # -- capture ----------------------------------------------------------
    def open_only(self, wanted: set[str]) -> None:
        """Leave exactly `wanted` doll windows open."""
        live = set(self.status().get("windows") or [])
        for name, key in DOLL_SURFACES.items():
            is_open = name in live
            if is_open != (name in wanted):
                self.run(f"key tap {key}\nwait 700\n")
                time.sleep(0.9)

    def doll_orbit(self, surface: str, steps: int = 6):
        """Spin one viewer through a full turn, capturing each step.

        Two probes, because one cannot do it: toggling the window finds the
        panel, then spinning inside the panel finds the doll within it.
        """
        self.open_only({surface})
        panel = self.locate_window(surface)
        if panel is None:
            return None, []
        spin = "mouse move abs {x} {y}\nwait 200\nmouse down left\nwait 120\n" \
               "mouse move abs {x2} {y}\nwait 220\nmouse up left\nwait 400\n"
        # The viewer occupies the panel's left column on every surface.
        px = panel[0] + (panel[2] - panel[0]) // 5
        py = (panel[1] + panel[3]) // 2
        box, _ = self.locate(spin.format(x=px, y=py, x2=px + 90), f"{surface}-doll")
        if box is None:
            box = panel
        cx, cy = (box[0] + box[2]) // 2, (box[1] + box[3]) // 2
        shots = []
        per_step = max(24, int(220 / max(1, steps)))
        for index in range(steps):
            self.run(spin.format(x=cx, y=cy, x2=cx + per_step))
            time.sleep(0.5)
            shots.append((self.shot(f"{surface}-{index}"), f"{surface} {index}"))
        return box, shots

    def world_orbit(self, steps: int = 4):
        """Face the pawn each way in turn and capture the world view.

        Located by idle animation, not by walking: the camera follows the
        player, so a step changes every pixel and the diff says nothing. And
        because the camera follows, the pawn does not stay put on screen - each
        heading is located again rather than reusing one box.
        """
        self.open_only(set())
        headings = [("w", "north"), ("d", "east"), ("s", "south"), ("a", "west")]
        shots = []
        for key, label in headings[:steps]:
            self.run(f"key down {key}\nwait 900\nkey up {key}\nwait 500\n")
            time.sleep(1.8)   # the authority rate-limits input; let it breathe
            box, frame = self.locate_idle(f"world-{label}")
            shots.append((frame, f"world {label}", box))
        return None, shots

    # -- output -----------------------------------------------------------
    @staticmethod
    def sheet(entries, box, path: pathlib.Path, cell=(300, 380)) -> pathlib.Path:
        """Contact sheet of one crop per capture, labelled.

        An entry may carry its own box; a moving subject needs one per shot.
        """
        if not entries:
            return path
        pad, label_h = 8, 18
        cols = min(len(entries), 6)
        rows = (len(entries) + cols - 1) // cols
        sheet = Image.new("RGB", (cols * (cell[0] + pad) + pad,
                                  rows * (cell[1] + label_h + pad) + pad), (14, 22, 28))
        pen = ImageDraw.Draw(sheet)
        for index, entry in enumerate(entries):
            image, label = entry[0], entry[1]
            own = entry[2] if len(entry) > 2 else box
            crop = image.crop(own) if own else image
            crop = crop.resize(cell, Image.LANCZOS)
            cx = pad + (index % cols) * (cell[0] + pad)
            cy = pad + (index // cols) * (cell[1] + label_h + pad)
            sheet.paste(crop, (cx, cy))
            pen.text((cx + 3, cy + cell[1] + 3), label, fill=(150, 210, 230))
        sheet.save(path, quality=94)
        return path


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", default="47779")
    parser.add_argument("--out", default="/tmp/pawn-observatory")
    parser.add_argument("--steps", type=int, default=6)
    args = parser.parse_args()

    obs = Observatory(args.port, pathlib.Path(args.out))
    status = obs.status()
    print(f"[observe] {status.get('app_mode')} / {status.get('game_connection')} "
          f"framebuffer {status.get('framebuffer')}")

    made = []
    for surface in DOLL_SURFACES:
        box, shots = obs.doll_orbit(surface, args.steps)
        print(f"[observe] {surface}: {len(shots)} angles, subject at {box}")
        made.append(obs.sheet(shots, box, pathlib.Path(args.out) / f"{surface}-orbit.jpg"))

    box, shots = obs.world_orbit()
    print(f"[observe] world: {len(shots)} headings, subject at {box}")
    made.append(obs.sheet(shots, box, pathlib.Path(args.out) / "world-orbit.jpg"))

    for path in made:
        print(f"[observe] {path}")


if __name__ == "__main__":
    main()
