#!/usr/bin/env python3
"""Capture every registered UI surface, under every theme, and grade it.

A UI regression usually hides in the one pane nobody opened. There are 30
registered surfaces and most of them open from a terminal, a target, or an
item, so clicking through them by hand is not a review anyone repeats. This
drives a live client through `successor-control`, opens each surface on its
own, crops the capture to the frame's own rect, and writes a gallery.

Then it grades what it captured, because a screenshot nobody measures is a
screenshot nobody reads:

* **theme coverage** — the same pane is captured under two themes and the
  pixels are compared. Ink that does not move between an aqua theme and an
  amber one is a hardcoded literal, and the report names the exact colours.
* **readability** — the darkest and lightest tones actually present inside the
  pane, the share of near-black pixels, and the Web Content Accessibility
  Guidelines contrast ratio between the pane's dominant ink and its dominant
  fill. A pane that fails here is unreadable regardless of how it was authored.

Usage:

    python3 tools/observe/pane_gallery.py --port 47778 --out /tmp/gallery
    python3 tools/observe/pane_gallery.py --port 47778 --only inventory,survey

The client must already be running with a control port; this never launches or
kills one.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from collections import Counter

try:
    from PIL import Image
except ImportError:  # pragma: no cover - operator-facing
    print("pane_gallery requires Pillow: pip3 install Pillow", file=sys.stderr)
    raise SystemExit(2)

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
CONTROL = os.path.join(REPO, "client-rust", "out", "bin", "successor-control")

# Theme ids in registry order, mirroring `hud::THEME_IDS`.
THEMES = ["signal", "phosphor", "amber", "oxide"]
# Coverage is measured between the two themes furthest apart in hue. Comparing
# adjacent themes understates a hardcoded literal.
COVERAGE_PAIR = (0, 2)

# A pane fill darker than this reads as a hole punched in the UI rather than a
# surface. The authored panel tones bottom out around 0x0c.
NEAR_BLACK = 24
# WCAG AA for body text. The UI is dense and small, so the small-text bar is
# the right one.
CONTRAST_TARGET = 4.5
# Ignore colours that occupy less of the pane than this; they are antialiasing
# fringes, not design decisions.
MIN_SHARE = 0.004


# Colours that are identity, not chrome, and must not follow the theme: the
# HAM pool tints (`hud::plate::POOL_HEALTH` / `POOL_ACTION`), the reserved-stack
# pip, and the unlit viewer seat a composited model sits on.
IDENTITY_TINTS = {"#d84242", "#68d074", "#d68a3e", "#030708"}
# Below this share of its own rect a pane is not drawing anything worth
# grading — a target plate with no target, a group roster with no group.
MIN_DRAWN_SHARE = 0.02


def control(port: int, *commands: str) -> str:
    script = "\n".join(commands) + "\n"
    done = subprocess.run(
        [CONTROL, "--port", str(port)],
        input=script,
        capture_output=True,
        text=True,
        cwd=os.path.join(REPO, "client-rust"),
    )
    if done.returncode != 0:
        raise RuntimeError(f"control failed: {done.stdout.strip()} {done.stderr.strip()}")
    return done.stdout


def status(port: int) -> dict:
    return json.loads(control(port, "status").splitlines()[0])


def capture(port: int, path_bmp: str) -> Image.Image:
    control(port, f"screenshot {path_bmp}")
    with Image.open(path_bmp) as raw:
        return raw.convert("RGB")


def relative_luminance(rgb: tuple[int, int, int]) -> float:
    channels = []
    for raw in rgb:
        c = raw / 255.0
        channels.append(c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4)
    r, g, b = channels
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def contrast_ratio(a: tuple[int, int, int], b: tuple[int, int, int]) -> float:
    la, lb = relative_luminance(a), relative_luminance(b)
    lighter, darker = max(la, lb), min(la, lb)
    return (lighter + 0.05) / (darker + 0.05)


def crop_to(frame: Image.Image, rect: list[float]) -> Image.Image:
    x, y, w, h = rect
    box = (
        max(0, int(x)),
        max(0, int(y)),
        min(frame.width, int(x + w)),
        min(frame.height, int(y + h)),
    )
    if box[2] <= box[0] or box[3] <= box[1]:
        return Image.new("RGB", (1, 1))
    return frame.crop(box)


def drawn_mask(open_pane: Image.Image, closed_pane: Image.Image) -> list[bool]:
    """Which pixels the pane itself painted.

    A pane that currently has nothing to say paints nothing, and grading the
    terrain showing through it reports a contrast of 1.0 and a theme coverage
    of zero — both meaningless. Capturing the same rect with the frame closed
    and differencing isolates the pane's own ink.
    """
    if open_pane.size != closed_pane.size:
        return [True] * (open_pane.width * open_pane.height)
    return [
        max(abs(a[i] - b[i]) for i in range(3)) > 8
        for a, b in zip(open_pane.getdata(), closed_pane.getdata())
    ]


def grade_readability(pane: Image.Image, mask: list[bool]) -> dict:
    """Tone census over the pixels the pane painted.

    Contrast uses luminance percentiles rather than the two most common
    colours. A sparse pane is mostly flat fill with a little antialiased type,
    and the type's tones each hold a fraction of a percent, so a
    most-common-colour comparison reports the fill against itself and calls a
    perfectly readable pane unreadable.
    """
    pixels = [px for px, drawn in zip(pane.getdata(), mask) if drawn]
    total = len(pixels)
    area = pane.width * pane.height
    if total == 0 or area == 0:
        return {"drawn_share": 0.0, "empty": True}
    census = Counter(pixels)
    near_black = sum(
        count for colour, count in census.items() if max(colour) <= NEAR_BLACK
    )
    ordered = sorted(pixels, key=relative_luminance)
    fill = ordered[len(ordered) // 2]
    ink = ordered[min(len(ordered) - 1, int(len(ordered) * 0.99))]
    return {
        "drawn_share": round(total / area, 4),
        "fill": list(fill),
        "ink": list(ink),
        "contrast": round(contrast_ratio(ink, fill), 2),
        "near_black_share": round(near_black / total, 4),
        "distinct_tones": len(census),
    }


def grade_theme_coverage(
    a: Image.Image, b: Image.Image, mask: list[bool]
) -> dict:
    """Share of the pane's own ink that moved between two themes."""
    if a.size != b.size:
        return {"error": f"size drift {a.size} vs {b.size}"}
    left = [px for px, drawn in zip(a.getdata(), mask) if drawn]
    right = [px for px, drawn in zip(b.getdata(), mask) if drawn]
    total = min(len(left), len(right))
    if total == 0:
        return {"changed_share": 0.0, "frozen_colours": []}
    frozen = Counter()
    changed = 0
    for px_a, px_b in zip(left, right):
        # A hue rotation moves every themed channel; a couple of levels of
        # dither noise does not count as themed.
        if max(abs(px_a[i] - px_b[i]) for i in range(3)) > 6:
            changed += 1
        else:
            frozen[px_a] += 1
    offenders = [
        {"colour": "#%02x%02x%02x" % colour, "share": round(count / total, 4)}
        for colour, count in frozen.most_common(6)
        if count / total >= MIN_SHARE
        and max(colour) > NEAR_BLACK
        and "#%02x%02x%02x" % colour not in IDENTITY_TINTS
    ]
    return {
        "changed_share": round(changed / total, 4),
        "frozen_colours": offenders,
    }


def open_only(port: int, target: str, every: list[str], hud: set[str]) -> None:
    """Leave exactly one workspace frame open so its crop is unobstructed."""
    commands = []
    for wid in every:
        if wid in hud:
            continue
        commands.append(f"ui window {'open' if wid == target else 'close'} {wid}")
    commands.append("wait 260")
    control(port, *commands)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=47778)
    parser.add_argument("--out", default="/tmp/successor-gallery")
    parser.add_argument("--only", default="", help="comma-separated surface ids")
    parser.add_argument(
        "--themes",
        default=",".join(str(i) for i in range(len(THEMES))),
        help="comma-separated theme indices",
    )
    args = parser.parse_args()

    os.makedirs(args.out, exist_ok=True)
    scratch = os.path.join(args.out, "_frame.bmp")

    snapshot = status(args.port)
    if snapshot.get("app_mode") != "Connected":
        print(f"client is {snapshot.get('app_mode')}, not Connected", file=sys.stderr)
        return 2
    frames = {row["id"]: row for row in snapshot["window_frames"]}
    hud = {wid for wid in frames if wid.startswith("hud.") or wid == "ground-radar"}
    wanted = [w.strip() for w in args.only.split(",") if w.strip()] or sorted(frames)
    missing = [w for w in wanted if w not in frames]
    if missing:
        print(f"unknown surfaces: {', '.join(missing)}", file=sys.stderr)
        return 2
    themes = [int(t) for t in args.themes.split(",") if t.strip()]

    gallery: dict[str, dict] = {}
    masks: dict[str, list[bool]] = {}
    for theme in themes:
        control(args.port, f"ui theme {theme}", "wait 220")
        theme_dir = os.path.join(args.out, THEMES[theme])
        os.makedirs(theme_dir, exist_ok=True)
        for wid in wanted:
            if wid not in hud:
                open_only(args.port, wid, list(frames), hud)
            else:
                control(args.port, f"ui window open {wid}", "wait 200")
            # Re-read the rect: a pane can clamp or reflow when it opens.
            live = {row["id"]: row for row in status(args.port)["window_frames"]}[wid]
            if not live["open"]:
                gallery.setdefault(wid, {})[THEMES[theme]] = {"skipped": "would not open"}
                continue
            pane = crop_to(capture(args.port, scratch), live["rect"])
            control(args.port, f"ui window close {wid}", "wait 200")
            behind = crop_to(capture(args.port, scratch), live["rect"])
            control(args.port, f"ui window open {wid}", "wait 160")

            mask = drawn_mask(pane, behind)
            masks[wid] = mask
            png = os.path.join(theme_dir, f"{wid.replace('.', '_')}.png")
            pane.save(png)
            entry = {"path": png, "rect": [round(v, 1) for v in live["rect"]]}
            entry.update(grade_readability(pane, mask))
            gallery.setdefault(wid, {})[THEMES[theme]] = entry

    first, second = (THEMES[i] for i in COVERAGE_PAIR)
    for wid, per_theme in gallery.items():
        if first in per_theme and second in per_theme:
            a, b = per_theme[first], per_theme[second]
            if "path" in a and "path" in b:
                with Image.open(a["path"]) as ia, Image.open(b["path"]) as ib:
                    per_theme["coverage"] = grade_theme_coverage(
                        ia.convert("RGB"), ib.convert("RGB"), masks.get(wid, [])
                    )

    index = os.path.join(args.out, "index.json")
    with open(index, "w", encoding="utf-8") as handle:
        json.dump({"schema": "successor.pane-gallery.v1", "panes": gallery}, handle, indent=2)

    print(f"{len(gallery)} surfaces -> {args.out}")
    header = f"{'surface':22} {'drawn':>6} {'contrast':>8} {'black':>6} {'themed':>7}  frozen ink"
    print(header)
    worst = []
    for wid in sorted(gallery):
        base = gallery[wid].get(THEMES[themes[0]], {})
        cover = gallery[wid].get("coverage", {})
        if base.get("empty") or base.get("drawn_share", 0.0) < MIN_DRAWN_SHARE:
            print(f"{wid:22}      -  (nothing to draw in this state)")
            continue
        frozen = ",".join(o["colour"] for o in cover.get("frozen_colours", [])[:3])
        print(
            f"{wid:22} {base['drawn_share']:6.3f} {base['contrast']:8.2f} "
            f"{base['near_black_share']:6.3f} "
            f"{cover.get('changed_share', float('nan')):7.3f}  {frozen}"
        )
        if base["contrast"] < CONTRAST_TARGET or base["near_black_share"] > 0.25 or frozen:
            worst.append(wid)
    if worst:
        print(f"\nneeds work: {', '.join(worst)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
