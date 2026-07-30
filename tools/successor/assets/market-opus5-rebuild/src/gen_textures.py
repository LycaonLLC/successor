"""Deterministic tileable PBR micro-texture library for the market building.

TEXTURE POLICY (rewritten for pass 2)
=====================================
The pass-1 library was rejected for "repeated elongated steel marks, dotted /
pitted brass, broad cloudy noise, uniform surface damage". The cause was
structural, not cosmetic: the tiles carried LOW-frequency content (Worley cells
at 13-36 cells/tile, fbm at freq 3-6), so every 5 m the same blob pattern
reappeared and read as a stamp.

The rule now enforced by `assert_micro_only()`:

  * A tile may only contain features smaller than 1/8 of the tile. All energy
    below 8 cycles/tile is measured and must stay under a hard amplitude budget.
  * Macro variation (panel-to-panel tone, dust, abrasion, grime, streaks, edge
    response, contact AO) is authored per-vertex in COLOR_0 at architectural
    scale by build_market.py -- never in the tile.
  * Normal amplitude is small: these are surface finishes, not relief maps.
    Every macro relief feature is real geometry.

Uniform density 256 px/m: 512 px maps = 2.0 m tile, 256 px ORM = same 2.0 m.
Run:  python3 src/gen_textures.py
"""
import hashlib
import json
import os

import numpy as np
from PIL import Image

OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                   "build", "textures")
TEXEL_DENSITY = 256.0
TILE_M = 2.0
RES = 512
RES_ORM = 256
LOW_FREQ_CUTOFF = 8          # cycles/tile: below this counts as "macro"
LOW_FREQ_BUDGET = 0.055      # max rms amplitude allowed below the cutoff

WRITTEN = {}
CHECKS = []


# ---------------------------------------------------------------- noise core
def _lattice(seed, freq):
    return np.random.default_rng(seed).random((freq, freq)).astype(np.float32)


def vnoise(u, v, freq, seed):
    """Periodic value noise, period 1.0 in tile units."""
    freq = int(freq)
    g = _lattice(seed, freq)
    cx, cy = u * freq, v * freq
    x0 = np.floor(cx).astype(np.int64)
    y0 = np.floor(cy).astype(np.int64)
    fx = (cx - x0).astype(np.float32)
    fy = (cy - y0).astype(np.float32)
    sx = fx * fx * (3.0 - 2.0 * fx)
    sy = fy * fy * (3.0 - 2.0 * fy)
    X0, X1 = x0 % freq, (x0 + 1) % freq
    Y0, Y1 = y0 % freq, (y0 + 1) % freq
    a = g[Y0, X0] + (g[Y0, X1] - g[Y0, X0]) * sx
    b = g[Y1, X0] + (g[Y1, X1] - g[Y1, X0]) * sx
    return a + (b - a) * sy


def fbm(u, v, freq, octaves, seed, gain=0.5):
    tot = np.zeros_like(u, dtype=np.float32)
    amp, norm = 1.0, 0.0
    for o in range(octaves):
        tot += amp * vnoise(u, v, freq * (2 ** o), seed + o * 97)
        norm += amp
        amp *= gain
    return tot / norm


def worley(u, v, cells, seed, jitter=0.9, order=0):
    """Periodic Worley F(order+1). Used only at HIGH cell counts (fine grain)."""
    cells = int(cells)
    rng = np.random.default_rng(seed)
    off = (rng.random((cells, cells, 2)).astype(np.float32) - 0.5) * jitter
    py, px = v * cells, u * cells
    cy = np.floor(py).astype(np.int64)
    cx = np.floor(px).astype(np.int64)
    ds = []
    for dy in (-1, 0, 1):
        for dx in (-1, 0, 1):
            iy, ix = (cy + dy) % cells, (cx + dx) % cells
            fy = iy + 0.5 + off[iy, ix, 0]
            fx = ix + 0.5 + off[iy, ix, 1]
            ddy = np.abs(py - fy)
            ddy = np.minimum(ddy, cells - ddy)
            ddx = np.abs(px - fx)
            ddx = np.minimum(ddx, cells - ddx)
            ds.append(np.sqrt(ddy * ddy + ddx * ddx))
    st = np.sort(np.stack(ds, 0), axis=0)
    return np.clip(st[order] / 0.75, 0.0, 1.0)


def grid_uv(res):
    a = (np.arange(res, dtype=np.float32) + 0.5) / res
    return np.meshgrid(a, a, indexing="xy")[0], np.meshgrid(a, a, indexing="ij")[0]


def smooth(x, a, b):
    t = np.clip((x - a) / (b - a + 1e-9), 0.0, 1.0)
    return t * t * (3.0 - 2.0 * t)


def srgb(lin):
    lin = np.clip(lin, 0.0, 1.0)
    return np.where(lin <= 0.0031308, lin * 12.92,
                    1.055 * np.power(lin, 1 / 2.4) - 0.055)


def dblur(a, radius, axis):
    """Periodic box blur along one axis: anisotropy without lattice stretching."""
    a = np.ascontiguousarray(a, np.float32)
    r = max(1, int(radius))
    acc = np.zeros_like(a)
    for k in range(-r, r + 1):
        acc += np.roll(a, k, axis=axis)
    return acc / float(2 * r + 1)


def resize(arr, res):
    arr = np.ascontiguousarray(arr, dtype=np.float32)
    if arr.shape[0] == res:
        out = arr
    elif arr.ndim == 2:
        out = np.asarray(Image.fromarray(arr, "F").resize((res, res), Image.LANCZOS),
                         np.float32)
    else:
        out = np.stack([np.asarray(
            Image.fromarray(np.ascontiguousarray(arr[..., i]), "F")
            .resize((res, res), Image.LANCZOS), np.float32)
            for i in range(arr.shape[2])], -1)
    if not np.isfinite(out).all():
        raise ValueError("non-finite after resize")
    return out


def height_to_normal(h, strength):
    dx = (np.roll(h, -1, 1) - np.roll(h, 1, 1)) * 0.5
    dy = (np.roll(h, -1, 0) - np.roll(h, 1, 0)) * 0.5
    n = np.stack([-dx * strength, dy * strength, np.ones_like(h)], -1)
    return n / np.linalg.norm(n, axis=-1, keepdims=True)


# ------------------------------------------------------- micro-only assertion
def low_freq_rms(a, cutoff=LOW_FREQ_CUTOFF):
    """RMS amplitude of content below `cutoff` cycles/tile, DC removed."""
    a = np.asarray(a, np.float32)
    if a.ndim == 3:
        a = a.mean(-1)
    F = np.fft.rfft2(a - a.mean())
    n = a.shape[0]
    fy = np.fft.fftfreq(n) * n
    fx = np.fft.rfftfreq(n) * n
    R = np.sqrt(fy[:, None] ** 2 + fx[None, :] ** 2)
    keep = (R > 0) & (R < cutoff)
    # Parseval: rms of the low band
    p = (np.abs(F[keep]) ** 2).sum() * 2.0 / (n * n) ** 2
    return float(np.sqrt(max(p, 0.0)))


def high_freq_rms(a, cutoff=LOW_FREQ_CUTOFF):
    """RMS amplitude of content AT OR ABOVE `cutoff` cycles/tile."""
    a = np.asarray(a, np.float32)
    if a.ndim == 3:
        a = a.mean(-1)
    F = np.fft.rfft2(a - a.mean())
    n = a.shape[0]
    fy = np.fft.fftfreq(n) * n
    fx = np.fft.rfftfreq(n) * n
    R = np.sqrt(fy[:, None] ** 2 + fx[None, :] ** 2)
    keep = R >= cutoff
    p = (np.abs(F[keep]) ** 2).sum() * 2.0 / (n * n) ** 2
    return float(np.sqrt(max(p, 0.0)))


def assert_micro_present(name, label, a, floor):
    """A tile with no high-frequency energy is a flat swatch, not a material."""
    r = high_freq_rms(a)
    CHECKS.append({"map": f"{name}.{label}", "kind": "high_freq_floor",
                   "high_freq_rms": round(r, 5), "floor": floor,
                   "pass": bool(r >= floor)})
    if r < floor:
        raise AssertionError(
            f"{name}.{label}: micro energy {r:.4f} < floor {floor} "
            f"(>={LOW_FREQ_CUTOFF} cycles/tile). Tile is visually flat.")
    return r


def assert_micro_only(name, label, a, budget=LOW_FREQ_BUDGET):
    r = low_freq_rms(a)
    CHECKS.append({"map": f"{name}.{label}", "kind": "low_freq_ceiling",
                   "low_freq_rms": round(r, 5),
                   "budget": budget, "pass": bool(r <= budget)})
    if r > budget:
        raise AssertionError(
            f"{name}.{label}: macro energy {r:.4f} > budget {budget} "
            f"(<{LOW_FREQ_CUTOFF} cycles/tile). Tiles must carry micro detail only.")
    return r


def contrast(x, k, pivot=None):
    """Expand local contrast of a normalised mask about its own mean."""
    x = np.asarray(x, np.float32)
    m = float(x.mean()) if pivot is None else pivot
    return np.clip((x - m) * k + m, 0.0, 1.0)


def col(r, g, b):
    return np.array([r, g, b], np.float32)


def tint(mask, base, other):
    return base[None, None, :] + (other - base)[None, None, :] * mask[..., None]


def write_set(name, bc_lin, height, rough, metal_const, ao, nstr, micro_floor=0.012):
    os.makedirs(OUT, exist_ok=True)
    bc_srgb = srgb(bc_lin)                 # perceptual space for both bounds
    assert_micro_only(name, "basecolor", bc_srgb)
    assert_micro_present(name, "basecolor", bc_srgb, micro_floor)
    assert_micro_only(name, "height", height, budget=LOW_FREQ_BUDGET * 1.6)
    assert_micro_only(name, "roughness", rough, budget=LOW_FREQ_BUDGET * 1.6)
    bc = (np.clip(srgb(resize(bc_lin, RES)), 0, 1) * 255).round().astype(np.uint8)
    nrm = ((height_to_normal(resize(height, RES), nstr) * 0.5 + 0.5) * 255
           ).round().astype(np.uint8)
    m = np.full((RES_ORM, RES_ORM), float(metal_const), np.float32)
    orm = np.stack([resize(ao, RES_ORM), resize(rough, RES_ORM), m], -1)
    orm = (np.clip(orm, 0, 1) * 255).round().astype(np.uint8)
    for suffix, data in (("basecolor", bc), ("normal", nrm), ("orm", orm)):
        p = os.path.join(OUT, f"market_{name}_{suffix}.png")
        Image.fromarray(data, "RGB").save(p, optimize=True)
        WRITTEN[f"market_{name}_{suffix}.png"] = {
            "sha256": hashlib.sha256(open(p, "rb").read()).hexdigest(),
            "res": int(data.shape[0]), "bytes": os.path.getsize(p)}
        print(f"  {os.path.basename(p):38s} {data.shape[0]:4d}px "
              f"{os.path.getsize(p)/1024:7.1f} KB")
    dev = float(np.abs(height_to_normal(resize(height, RES), nstr)[..., :2]).max())
    g = np.asarray(Image.fromarray(bc, "RGB").convert("L"), np.float32) / 255.0
    print(f"    metallic={metal_const:.2f} normal_xy_max={dev:.3f} "
          f"lowfreq={low_freq_rms(srgb(bc_lin)):.4f} "
          f"microfreq={high_freq_rms(srgb(bc_lin)):.4f} "
          f"srgb_sd={g.std():.4f}")


# ---------------------------------------------------------------- materials
def make_sinter():
    """Solar-sintered basalt: fine packed aggregate + sparse vesicles. No blobs."""
    u, v = grid_uv(RES)
    base, pale = col(0.030, 0.026, 0.022), col(0.176, 0.158, 0.130)
    agg = worley(u, v, 190, 11, 0.95)            # ~1 cm aggregate on a 2 m tile
    agg2 = worley(u, v, 330, 13, 0.95)
    grain = contrast(np.clip(agg * 0.62 + agg2 * 0.38, 0, 1), 1.55)
    fine = fbm(u, v, 96, 3, 21)
    # vesicles: sparse pinholes, NOT a dot grid -- threshold hard, keep ~2%
    ves_f = worley(u, v, 120, 41, 1.0)
    ves = smooth(1.0 - ves_f, 0.93, 1.0) * smooth(fbm(u, v, 64, 2, 47), 0.60, 0.92)
    c = tint(np.clip(grain * 0.78 + fine * 0.34 - 0.06, 0, 1), base, pale)
    c *= (1.0 - ves * 0.55)[..., None]
    h = grain * 0.42 + fine * 0.20 - ves * 0.95
    r = 0.86 - grain * 0.07 + ves * 0.04
    ao = np.clip(1.0 - ves * 0.45 - (1.0 - grain) * 0.10, 0.45, 1.0)
    write_set("sinter", c, h, r, 0.0, ao, 1.15, micro_floor=0.030)


def make_ceramic():
    """Imported ceramic composite: very fine speckle + micro crazing only."""
    u, v = grid_uv(RES)
    base, dark = col(0.632, 0.612, 0.574), col(0.428, 0.412, 0.382)
    speck = contrast(worley(u, v, 300, 71, 1.0), 1.45)
    micro = fbm(u, v, 120, 3, 91)
    craze = smooth(1.0 - worley(u, v, 46, 101, 1.0, order=1), 0.90, 1.0)
    craze *= smooth(fbm(u, v, 72, 2, 107), 0.55, 0.90)
    c = tint(np.clip(micro * 0.50 + speck * 0.46 - 0.06, 0, 1), base, dark)
    c *= (1.0 - craze * 0.16)[..., None]
    h = micro * 0.16 + speck * 0.12 - craze * 0.50
    r = 0.42 + micro * 0.07 + craze * 0.16
    ao = np.clip(1.0 - craze * 0.22, 0.62, 1.0)
    write_set("ceramic", c, h, r, 0.0, ao, 0.55, micro_floor=0.014)


def make_plaster():
    """Interior lime plaster on the soffits/ceilings: float texture, warm."""
    u, v = grid_uv(RES)
    base, warm = col(0.512, 0.482, 0.432), col(0.706, 0.680, 0.622)
    fl = fbm(u, v, 80, 3, 311)
    grit = contrast(worley(u, v, 260, 317, 1.0), 1.45)
    c = tint(np.clip(fl * 0.58 + grit * 0.40 - 0.07, 0, 1), base, warm)
    h = fl * 0.22 + grit * 0.10
    r = 0.72 + fl * 0.08
    ao = np.clip(1.0 - (1.0 - grit) * 0.07, 0.80, 1.0)
    write_set("plaster", c, h, r, 0.0, ao, 0.50, micro_floor=0.014)


def make_screed():
    """Ground/polished screed floor: fine trowel grain + sparse fine aggregate."""
    u, v = grid_uv(RES)
    base, poli = col(0.055, 0.051, 0.046), col(0.182, 0.172, 0.154)
    trowel = dblur(fbm(u, v, 110, 3, 141), RES // 90, axis=1)
    trowel = (trowel - trowel.min()) / (np.ptp(trowel) + 1e-9)
    agg = contrast(worley(u, v, 240, 151, 0.95), 1.5)
    hair = smooth(1.0 - worley(u, v, 40, 161, 1.0, order=1), 0.94, 1.0)
    hair *= smooth(fbm(u, v, 56, 2, 167), 0.62, 0.94)
    c = tint(np.clip(trowel * 0.40 + agg * 0.56 - 0.06, 0, 1), base, poli)
    c *= (1.0 - hair * 0.42)[..., None]
    h = agg * 0.18 + trowel * 0.10 - hair * 0.62
    r = 0.50 + agg * 0.10 - trowel * 0.10 + hair * 0.16
    ao = np.clip(1.0 - hair * 0.36 - (1.0 - agg) * 0.06, 0.55, 1.0)
    write_set("screed", c, h, r, 0.0, ao, 0.70, micro_floor=0.026)


def make_roofmetal():
    """Chalky galvanised sheet: fine spangle + faint roll grain. No oxide blobs."""
    u, v = grid_uv(RES)
    base, brt = col(0.222, 0.226, 0.220), col(0.406, 0.412, 0.402)
    spangle = contrast(worley(u, v, 150, 181, 1.0), 1.45)
    roll = dblur(fbm(u, v, 128, 2, 191), RES // 64, axis=0)
    roll = (roll - roll.min()) / (np.ptp(roll) + 1e-9)
    grit = fbm(u, v, 150, 2, 199)
    c = tint(np.clip(spangle * 0.52 + roll * 0.26 + grit * 0.20 - 0.06, 0, 1), base, brt)
    h = spangle * 0.20 + roll * 0.14 + grit * 0.10
    r = 0.56 + spangle * 0.08 + grit * 0.05
    ao = np.clip(1.0 - (1.0 - spangle) * 0.07, 0.80, 1.0)
    write_set("roofmetal", c, h, r, 1.0, ao, 0.62, micro_floor=0.022)


def make_steel():
    """Dark structural steel: fine unidirectional brush grain, no drag streaks."""
    u, v = grid_uv(RES)
    base, brt = col(0.042, 0.044, 0.047), col(0.178, 0.184, 0.193)
    brush = dblur(fbm(u, v, 220, 2, 211), RES // 64, axis=1)
    brush = contrast(brush, 1.45)
    brush = (brush - brush.min()) / (np.ptp(brush) + 1e-9)
    fineb = dblur(fbm(u, v, 340, 1, 213), RES // 96, axis=1)
    fineb = (fineb - fineb.min()) / (np.ptp(fineb) + 1e-9)
    micro = fbm(u, v, 170, 2, 229)
    c = tint(np.clip(brush * 0.66 + fineb * 0.40 + micro * 0.20 - 0.08, 0, 1), base, brt)
    h = brush * 0.26 + fineb * 0.16 + micro * 0.08
    r = 0.40 + brush * 0.08 + fineb * 0.05
    ao = np.clip(1.0 - (1.0 - brush) * 0.05, 0.86, 1.0)
    write_set("steel", c, h, r, 1.0, ao, 0.55, micro_floor=0.018)


def make_brass():
    """Satin brass: fine turning marks only. No pits, no dots, no verdigris blobs.

    Patina and handled polish are authored per-vertex where hands actually go.
    """
    u, v = grid_uv(RES)
    base, pol = col(0.340, 0.242, 0.086), col(0.622, 0.494, 0.238)
    turn = dblur(fbm(u, v, 200, 2, 241), RES // 72, axis=0)
    turn = contrast(turn, 1.40)
    turn = (turn - turn.min()) / (np.ptp(turn) + 1e-9)
    fineg = fbm(u, v, 260, 2, 257)
    c = tint(np.clip(turn * 0.70 + fineg * 0.32 - 0.07, 0, 1), base, pol)
    h = turn * 0.20 + fineg * 0.09
    r = 0.32 + turn * 0.09 + fineg * 0.05
    ao = np.clip(1.0 - (1.0 - turn) * 0.05, 0.88, 1.0)
    write_set("brass", c, h, r, 1.0, ao, 0.50, micro_floor=0.016)


MAKERS = [make_sinter, make_ceramic, make_plaster, make_screed, make_roofmetal,
          make_steel, make_brass]

if __name__ == "__main__":
    print(f"Micro-only PBR library @ {TEXEL_DENSITY:.0f} px/m "
          f"({RES}px = {TILE_M} m tile):")
    for f in MAKERS:
        print(f"\n[{f.__name__[5:]}]")
        f()
    meta = {
        "texel_density_px_per_m": TEXEL_DENSITY,
        "tile_metres": TILE_M,
        "resolution": {"basecolor": RES, "normal": RES, "orm": RES_ORM},
        "orm_packing": "R=micro AO, G=roughness, B=metallic (constant per material)",
        "colour_space": {"basecolor": "sRGB",
                         "normal": "linear tangent-space (OpenGL +Y)",
                         "orm": "linear"},
        "micro_only_policy": {
            "low_freq_cutoff_cycles_per_tile": LOW_FREQ_CUTOFF,
            "low_freq_rms_budget": LOW_FREQ_BUDGET,
            "rationale": "macro variation lives in COLOR_0, not in the tile",
        },
        "micro_only_checks": CHECKS,
        "textures": WRITTEN,
    }
    json.dump(meta, open(os.path.join(OUT, "textures.json"), "w"), indent=1)
    tot = sum(x["bytes"] for x in WRITTEN.values())
    lo = [c for c in CHECKS if c["kind"] == "low_freq_ceiling"]
    worst = max(lo, key=lambda c: c["low_freq_rms"] / c["budget"])
    print(f"\n{len(WRITTEN)} textures, {tot/1024/1024:.2f} MB on disk")
    print(f"micro-only checks: {sum(1 for c in CHECKS if c['pass'])}/{len(CHECKS)} pass"
          f" | tightest: {worst['map']} {worst['low_freq_rms']:.4f}/{worst['budget']}")
    print("TEXTURES_OK")
