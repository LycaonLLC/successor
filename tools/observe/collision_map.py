"""Draw what the authority actually blocks, and answer whether a player fits.

Walking into a wall tells you one number. It does not tell you the shape of the
blocked field, whether a doorway is passable, or where the gap actually is - and
probing it a step at a time is slow and easy to misread. This rasterises the
authority's own collision rule over a building and renders it, so the whole
field is visible at once.

It reproduces the runtime rule rather than approximating it:

  * the streamed player position is an ANCHOR; the collision circle sits at
    `ground_center_from_anchor`, half a cell along both axes
  * that circle has radius `CIRCLE_COLLISION_RADIUS_MILLI` = 300 milli-cells
  * it is tested against the prop's `collisionBounds`, which are always solid,
    plus the `door.blocker`, which is only solid while the door is shut

The decisive output is not the picture but the flood fill: starting outside the
building and spreading through free space, does any interior sample get reached?
That answers "can the player get in" for real, with the door open and shut, for
every building in the slice, without walking anywhere.

    python3 tools/observe/collision_map.py                      # every building
    python3 tools/observe/collision_map.py --prop dustgate-home-starter
"""
from __future__ import annotations

import argparse
import json
import pathlib
from collections import deque

from PIL import Image, ImageDraw

REPO = pathlib.Path(__file__).resolve().parents[2]
SLICE = REPO / "client" / "public" / "successor-slice" / "open-desert-slice.json"

#: Player collision circle, from `swept_circle.rs`.
RADIUS_CELLS = 0.300
#: The streamed position is an anchor; the collision circle sits here relative
#: to it, from `ground_center_from_anchor`.
ANCHOR_TO_CENTER = 0.5
#: Samples per cell. 16 puts a sample every 62 mm, well under the radius.
SAMPLES_PER_CELL = 16
#: How far outside the footprint to sample, so there is somewhere to start from.
MARGIN_CELLS = 2


def boxes_for(prop, door_open: bool):
    """Solid rectangles in prop-local cells, honouring door state."""
    out = []
    for bound in prop.get("collisionBounds") or []:
        out.append((
            bound["xMilli"] / 1000.0,
            bound["yMilli"] / 1000.0,
            (bound["xMilli"] + bound["wMilli"]) / 1000.0,
            (bound["yMilli"] + bound["hMilli"]) / 1000.0,
            bound.get("id", "?"),
            "wall",
        ))
    blocker = (prop.get("door") or {}).get("blocker")
    if blocker and not door_open:
        out.append((
            blocker["xMilli"] / 1000.0,
            blocker["yMilli"] / 1000.0,
            (blocker["xMilli"] + blocker["wMilli"]) / 1000.0,
            (blocker["yMilli"] + blocker["hMilli"]) / 1000.0,
            blocker.get("id", "door"),
            "door",
        ))
    return out


def circle_hits(cx: float, cy: float, box) -> bool:
    """Circle/AABB overlap, the same test `circle_intersects_aabb` makes."""
    left, top, right, bottom = box[0], box[1], box[2], box[3]
    nearest_x = min(max(cx, left), right)
    nearest_y = min(max(cy, top), bottom)
    dx, dy = cx - nearest_x, cy - nearest_y
    return dx * dx + dy * dy < RADIUS_CELLS * RADIUS_CELLS


def rasterise(prop, door_open: bool):
    """Free/blocked grid over the footprint plus a margin, in anchor space."""
    width = prop["size"]["w"]
    height = prop["size"]["h"]
    boxes = boxes_for(prop, door_open)
    cols = (width + MARGIN_CELLS * 2) * SAMPLES_PER_CELL
    rows = (height + MARGIN_CELLS * 2) * SAMPLES_PER_CELL
    step = 1.0 / SAMPLES_PER_CELL
    free = bytearray(cols * rows)
    for row in range(rows):
        anchor_y = -MARGIN_CELLS + row * step
        center_y = anchor_y + ANCHOR_TO_CENTER
        base = row * cols
        for col in range(cols):
            anchor_x = -MARGIN_CELLS + col * step
            center_x = anchor_x + ANCHOR_TO_CENTER
            blocked = any(circle_hits(center_x, center_y, box) for box in boxes)
            free[base + col] = 0 if blocked else 1
    return free, cols, rows, boxes


def flood(free, cols, rows):
    """Everything reachable from the outside margin, 4-connected."""
    seen = bytearray(cols * rows)
    queue = deque()
    for col in range(cols):
        for row in (0, rows - 1):
            if free[row * cols + col] and not seen[row * cols + col]:
                seen[row * cols + col] = 1
                queue.append((col, row))
    for row in range(rows):
        for col in (0, cols - 1):
            if free[row * cols + col] and not seen[row * cols + col]:
                seen[row * cols + col] = 1
                queue.append((col, row))
    while queue:
        col, row = queue.popleft()
        for dc, dr in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            nc, nr = col + dc, row + dr
            if 0 <= nc < cols and 0 <= nr < rows:
                index = nr * cols + nc
                if free[index] and not seen[index]:
                    seen[index] = 1
                    queue.append((nc, nr))
    return seen


def interior_samples(prop, cols, rows):
    """Sample indices inside the building's authored interior regions."""
    regions = prop.get("interiorRegions") or []
    step = 1.0 / SAMPLES_PER_CELL
    inside = []
    for row in range(rows):
        y = -MARGIN_CELLS + row * step
        for col in range(cols):
            x = -MARGIN_CELLS + col * step
            for region in regions:
                if (region["xMilli"] / 1000.0 <= x <= (region["xMilli"] + region["wMilli"]) / 1000.0
                        and region["yMilli"] / 1000.0 <= y
                        <= (region["yMilli"] + region["hMilli"]) / 1000.0):
                    inside.append(row * cols + col)
                    break
    return inside


def render(prop, door_open, out_path):
    free, cols, rows, boxes = rasterise(prop, door_open)
    seen = flood(free, cols, rows)
    inside = interior_samples(prop, cols, rows)
    reachable = sum(1 for index in inside if seen[index])

    scale = max(1, 720 // max(cols, rows))
    image = Image.new("RGB", (cols * scale, rows * scale), (16, 20, 26))
    pen = ImageDraw.Draw(image)
    for row in range(rows):
        for col in range(cols):
            index = row * cols + col
            if not free[index]:
                colour = (150, 40, 40)          # solid for the player
            elif seen[index]:
                colour = (40, 110, 60)          # reachable from outside
            else:
                colour = (40, 60, 130)          # free but sealed off
            pen.rectangle([col * scale, row * scale,
                           col * scale + scale - 1, row * scale + scale - 1], fill=colour)
    # Authored boxes on top, so geometry and blocking can be compared directly.
    for left, top, right, bottom, name, kind in boxes:
        outline = (255, 210, 90) if kind == "door" else (230, 120, 120)
        pen.rectangle([(left + MARGIN_CELLS) * SAMPLES_PER_CELL * scale,
                       (top + MARGIN_CELLS) * SAMPLES_PER_CELL * scale,
                       (right + MARGIN_CELLS) * SAMPLES_PER_CELL * scale,
                       (bottom + MARGIN_CELLS) * SAMPLES_PER_CELL * scale],
                      outline=outline)
    image.save(out_path)
    return reachable, len(inside)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--prop", help="only this prop id")
    parser.add_argument("--out", default="/tmp/successor-collision-map")
    args = parser.parse_args()
    out_dir = pathlib.Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)

    slice_doc = json.loads(SLICE.read_text())
    props = [p for p in slice_doc["props"]
             if p.get("kind") == "building" and (p.get("collisionBounds") or p.get("door"))]
    if args.prop:
        props = [p for p in props if p.get("id") == args.prop]

    print(f"{'building':32} {'door':>6} {'interior reachable':>20}  verdict")
    for prop in props:
        if not (prop.get("interiorRegions") or []):
            continue
        for door_open in (False, True):
            state = "open" if door_open else "shut"
            path = out_dir / f"{prop['id']}-{state}.png"
            reached, total = render(prop, door_open, path)
            share = (reached / total * 100.0) if total else 0.0
            verdict = "SEALED - player cannot enter" if reached == 0 else f"{share:.0f}% of interior reachable"
            print(f"{prop['id']:32} {state:>6} {reached:>9}/{total:<10} {verdict}")
    print(f"\nmaps written to {out_dir}")


if __name__ == "__main__":
    main()
