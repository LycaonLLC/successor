"""Emissive console graphics for the clone terminal.

Deterministic numpy raster, no fonts and no glyphs: the display speaks in
pictograms — a body chart with a growth-progress fill, vitals traces, a
viability ring and bay-status pips.  Nothing on it is a wordmark, so nothing on
it can collide with a real one.
"""
from __future__ import annotations

import numpy as np

W, H = 512, 384


def _lin(hex_color: str):
    h = hex_color.lstrip("#")
    srgb = [int(h[i:i + 2], 16) / 255.0 for i in (0, 2, 4)]
    return np.array([(c / 12.92) if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4
                     for c in srgb], dtype=np.float32)


CYAN = _lin("#6FE6D8")
DIM = _lin("#1B4A48")
AMBER = _lin("#F0A83C")
BG = _lin("#04100F")


def _rect(img, x0, x1, y0, y1, color, alpha=1.0):
    x0, x1 = max(0, int(x0)), min(W, int(x1))
    y0, y1 = max(0, int(y0)), min(H, int(y1))
    if x1 <= x0 or y1 <= y0:
        return
    img[y0:y1, x0:x1] = img[y0:y1, x0:x1] * (1 - alpha) + color * alpha


def _ring(img, cx, cy, r0, r1, color, a0=0.0, a1=360.0, alpha=1.0):
    yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
    d = np.sqrt((xx - cx) ** 2 + (yy - cy) ** 2)
    ang = (np.degrees(np.arctan2(-(yy - cy), xx - cx)) + 360.0) % 360.0
    m = (d >= r0) & (d <= r1) & (ang >= a0) & (ang <= a1)
    img[m] = img[m] * (1 - alpha) + color * alpha


def _body_chart(img, cx, base_y, scale, color, alpha=1.0):
    """Abstract standing figure: head disc, tapered torso, four limbs."""
    s = scale
    _ring(img, cx, base_y - 92 * s, 0, 13 * s, color, alpha=alpha)
    _rect(img, cx - 15 * s, cx + 15 * s, base_y - 76 * s, base_y - 30 * s, color, alpha)
    _rect(img, cx - 26 * s, cx - 16 * s, base_y - 72 * s, base_y - 34 * s, color, alpha)
    _rect(img, cx + 16 * s, cx + 26 * s, base_y - 72 * s, base_y - 34 * s, color, alpha)
    _rect(img, cx - 13 * s, cx - 3 * s, base_y - 30 * s, base_y, color, alpha)
    _rect(img, cx + 3 * s, cx + 13 * s, base_y - 30 * s, base_y, color, alpha)


def terminal_screen() -> np.ndarray:
    img = np.zeros((H, W, 4), dtype=np.float32)
    img[:, :, :3] = BG
    img[:, :, 3] = 1.0
    rgb = img[:, :, :3]

    # frame + header rule
    _rect(rgb, 8, W - 8, 8, 11, DIM)
    _rect(rgb, 8, W - 8, H - 11, H - 8, DIM)
    _rect(rgb, 8, 11, 8, H - 8, DIM)
    _rect(rgb, W - 11, W - 8, 8, H - 8, DIM)
    _rect(rgb, 22, W - 22, 30, 33, CYAN * 0.8)
    for i in range(6):
        _rect(rgb, 22 + i * 15, 30 + i * 15, 16, 26, CYAN * (0.9 if i < 4 else 0.25))

    # left panel: the specimen under culture, filled to its growth fraction
    _rect(rgb, 26, 176, 46, H - 40, DIM * 0.5)
    _body_chart(rgb, 101, H - 74, 1.55, DIM * 1.5)
    growth = 0.62
    cut = int((H - 74) - (H - 74 - 60) * growth)
    band = rgb[cut:H - 60, 26:176]
    mask = np.any(np.abs(band - DIM * 1.5) < 1e-4, axis=-1)
    band[mask] = CYAN
    _rect(rgb, 34, 168, H - 56, H - 48, DIM)
    _rect(rgb, 34, 34 + int(134 * growth), H - 56, H - 48, CYAN)

    # centre: viability ring with a sector readout
    cx, cy = 268, 150
    _ring(rgb, cx, cy, 52, 56, DIM)
    _ring(rgb, cx, cy, 52, 56, CYAN, a0=0.0, a1=252.0)
    _ring(rgb, cx, cy, 30, 33, DIM * 1.4)
    _ring(rgb, cx, cy, 0, 9, CYAN)
    for k in range(12):
        a = k * 30.0
        _ring(rgb, cx, cy, 60, 66, CYAN * (0.85 if k < 8 else 0.2), a0=a - 3, a1=a + 3)

    # centre-bottom: two vitals traces
    xs = np.arange(196, 344)
    for row, (amp, freq, col) in enumerate(((10.0, 0.22, CYAN), (6.0, 0.55, CYAN * 0.6))):
        base = 250 + row * 44
        ys = base - (amp * np.sin(xs * freq)
                     * np.exp(-((xs - 270) % 74) / 60.0)).astype(int)
        for x, y in zip(xs, ys):
            _rect(rgb, x, x + 1, y, y + 2, col)
        _rect(rgb, 196, 344, base + 18, base + 19, DIM)

    # right column: bay status pips and reservoir bars
    for i in range(4):
        y = 54 + i * 34
        col = CYAN if i < 2 else (AMBER if i == 2 else DIM * 1.6)
        _ring(rgb, 380, y + 8, 0, 8, col)
        _rect(rgb, 396, 470, y + 4, y + 12, col * 0.55)
    for i, frac in enumerate((0.82, 0.47, 0.93)):
        x = 372 + i * 38
        _rect(rgb, x, x + 22, 208, 330, DIM * 0.7)
        _rect(rgb, x, x + 22, int(330 - 122 * frac), 330, CYAN if frac > 0.5 else AMBER)
    _rect(rgb, 372, 470, 342, 350, DIM)
    _rect(rgb, 372, 430, 342, 350, CYAN)

    # scanline tint keeps it reading as a display rather than a poster
    rgb[::3, :, :] *= 0.86
    img[:, :, :3] = np.clip(rgb, 0.0, 1.0)
    return img


def make_image(bpy, name="clone_screen_emissive"):
    old = bpy.data.images.get(name)
    if old is not None:
        bpy.data.images.remove(old)
    arr = terminal_screen()
    img = bpy.data.images.new(name, W, H, alpha=False)
    img.pixels.foreach_set(np.ascontiguousarray(arr).ravel())
    img.update()
    return img
