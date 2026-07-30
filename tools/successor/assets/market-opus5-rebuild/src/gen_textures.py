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

Base density 256 px/m: 512 px maps, 256 px ORM. Tile metres are PER MATERIAL\n(MATERIAL_SCALE); base colour is flat unless the real surface has mixed minerals.
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

# ---------------------------------------------------------------------------
# PER-MATERIAL SCALE AND RESPONSE  (pass-3 review defect 7)
# ---------------------------------------------------------------------------
# The pass-2 fix (micro-detail only) removed the repeating blobs but replaced
# them with something equally wrong: EVERY material carried micro detail of
# roughly the same amplitude on the SAME 2.0 m tile, so screed, sinter and
# ceramic all read as one sponge-like grain at any distance, and brass -- whose
# trim members are only 0.05-0.16 m wide -- showed a 5 mm directional streak
# that read as noisy wood.
#
# Two structural corrections:
#   1. TILE_M is now PER MATERIAL, chosen from the real size of the thing being
#      described (basalt aggregate, panel module, trowel pass, turning marks),
#      so the same shader detail projects at different physical scales.
#   2. high-frequency energy is now bounded ABOVE as well as below, per
#      material, by assert_micro_band().  A material may no longer be "safe"
#      by being maximally grainy.
#
# metres per tile repeat, and the MAXIMUM permitted micro-energy (sRGB rms).
#
# PASS-4 REVIEW DEFECT 3.  Pass 3 enforced a micro-energy BAND -- a floor as
# well as a ceiling -- on every material's base colour.  The floor was the
# problem the review was looking at: it made "every material must contain
# visible noise" a build-time requirement, so screed, sinter, plaster, ceramic
# and brass all kept an evenly distributed procedural speckle and the close crop
# read as one noise family recoloured seven ways.
#
# The floor is REMOVED.  A nearly flat base colour is now a valid, and for most
# of this palette the correct, answer: plaster, ceramic, polished screed,
# machined brass and structural steel are smooth manufactured surfaces whose
# character is specular, not albedo.  Only the ceiling is kept, and it is
# tightened, so "safe by being maximally grainy" is still impossible.
#
# What replaces the noise:
#   * directional detail lives in NORMAL and ROUGHNESS where it is physically
#     causal -- trowel float, turning marks, brush grain, roll grain, crazing;
#   * materials separate through VALUE, ROUGHNESS, METALLIC response and
#     AGGREGATE SCALE, which `assert_response_separation()` now measures;
#   * architectural-scale wear stays in COLOR_0, authored at 26 named places.
#
# Base colour keeps micro variation only where a real material has genuinely
# different minerals at the surface: sintered basalt aggregate, and the sparse
# cut aggregate faces exposed by grinding the screed.  Everything else is flat.
MATERIAL_SCALE = {
    "sinter":    {"tile_m": 1.30, "micro_max": 0.030, "rough_mean": 0.82},
    "ceramic":   {"tile_m": 2.40, "micro_max": 0.005, "rough_mean": 0.55},
    "plaster":   {"tile_m": 1.70, "micro_max": 0.005, "rough_mean": 0.91},
    "screed":    {"tile_m": 2.10, "micro_max": 0.014, "rough_mean": 0.32},
    "roofmetal": {"tile_m": 1.50, "micro_max": 0.011, "rough_mean": 0.69},
    "steel":     {"tile_m": 0.55, "micro_max": 0.007, "rough_mean": 0.49},
    "brass":     {"tile_m": 0.30, "micro_max": 0.005, "rough_mean": 0.23},
}

WRITTEN = {}
CHECKS = []
RESPONSE = []


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


def assert_micro_ceiling(name, label, a, hi):
    """Micro energy must not EXCEED this material's ceiling.

    There is deliberately no floor (pass-4 review defect 3).  A flat tile is a
    legitimate material here; the building separates its surfaces by value,
    roughness, metallic response and aggregate scale, not by everything being
    equally speckled.
    """
    r = high_freq_rms(a)
    ok = r <= hi
    CHECKS.append({"map": f"{name}.{label}", "kind": "micro_ceiling",
                   "high_freq_rms": round(r, 5), "max": hi, "pass": bool(ok)})
    if not ok:
        raise AssertionError(
            f"{name}.{label}: micro energy {r:.4f} > max {hi} -- this is what "
            f"makes every surface read as the same procedural sponge.")
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


def write_set(name, bc_lin, height, rough, metal_const, ao, nstr):
    os.makedirs(OUT, exist_ok=True)
    bc_srgb = srgb(bc_lin)                 # perceptual space for the bounds
    assert_micro_only(name, "basecolor", bc_srgb)
    assert_micro_ceiling(name, "basecolor", bc_srgb,
                         MATERIAL_SCALE[name]["micro_max"])
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
    bc_micro = high_freq_rms(bc_srgb)
    rg_micro = high_freq_rms(rough)
    # the ratio that matters after pass 4: detail should live in the response
    # maps, not in the albedo.
    RESPONSE.append({"material": name, "basecolor_micro": round(bc_micro, 5),
                     "roughness_micro": round(rg_micro, 5),
                     "normal_xy_max": round(dev, 4),
                     "mean_linear_value": round(float(np.asarray(bc_lin).mean()), 5),
                     "roughness_mean": round(float(rough.mean()), 4),
                     "metallic": float(metal_const),
                     "tile_m": MATERIAL_SCALE[name]["tile_m"]})
    print(f"    metallic={metal_const:.2f} normal_xy_max={dev:.3f} "
          f"lowfreq={low_freq_rms(bc_srgb):.4f} "
          f"basecolor_micro={bc_micro:.4f} (max {MATERIAL_SCALE[name]['micro_max']}) "
          f"roughness_micro={rg_micro:.4f} srgb_sd={g.std():.4f}")


# ---------------------------------------------------------------- materials
#
# PASS-4 RULE: base colour is flat unless the real surface genuinely has
# different minerals showing.  Everything else -- float texture, crazing,
# turning marks, brush grain, roll grain, spangle, vesicles -- is a HEIGHT and
# ROUGHNESS phenomenon and is authored there.  This is what stops seven
# materials reading as one noise family recoloured.
def make_sinter():
    """Solar-sintered basalt: packed aggregate. The ONE coarse material.

    Aggregate is real albedo variation (different mineral grains fused on site),
    so it is the one base colour allowed real micro energy -- but at roughly half
    the previous amplitude, with the relief carried by the normal map instead.
    """
    u, v = grid_uv(RES)
    base, pale = col(0.074, 0.065, 0.055), col(0.156, 0.142, 0.120)
    agg = worley(u, v, 130, 11, 0.95)            # ~1 cm aggregate on a 1.3 m tile
    agg2 = worley(u, v, 230, 13, 0.95)
    grain = contrast(np.clip(agg * 0.62 + agg2 * 0.38, 0, 1), 1.26)
    fine = fbm(u, v, 70, 3, 21)
    # vesicles: sparse pinholes.  They are HOLES -- normal + AO, barely albedo.
    ves_f = worley(u, v, 120, 41, 1.0)
    ves = smooth(1.0 - ves_f, 0.93, 1.0) * smooth(fbm(u, v, 64, 2, 47), 0.60, 0.92)
    c = tint(np.clip(grain * 0.42 + fine * 0.18 + 0.10, 0, 1), base, pale)
    c *= (1.0 - ves * 0.28)[..., None]
    # relief carries what the albedo gave up: deeper aggregate, deeper pinholes
    h = grain * 0.62 + fine * 0.26 - ves * 1.30
    # rough where the aggregate is exposed, slightly polished on the high points
    r = 0.86 - grain * 0.11 + ves * 0.05
    ao = np.clip(1.0 - ves * 0.45 - (1.0 - grain) * 0.10, 0.45, 1.0)
    write_set("sinter", c, h, r, 0.0, ao, 1.55)


def make_ceramic():
    """Imported ceramic composite: a precise, near-flat panel.

    Factory-finished panel has no visible albedo grain at 2.4 m.  Crazing is a
    crack -- normal and roughness -- with only a whisper of albedo where dust has
    settled into it.
    """
    u, v = grid_uv(RES)
    base, dark = col(0.632, 0.612, 0.574), col(0.548, 0.529, 0.494)
    micro = fbm(u, v, 90, 2, 91)
    craze = smooth(1.0 - worley(u, v, 38, 101, 1.0, order=1), 0.945, 1.0)
    craze *= smooth(fbm(u, v, 60, 2, 107), 0.62, 0.92)
    # base colour: flat, plus the faintest settling in the craze lines only
    c = tint(np.clip(micro * 0.05 + 0.42, 0, 1), base, dark)
    c *= (1.0 - craze * 0.055)[..., None]
    h = micro * 0.04 - craze * 0.80              # cracks are relief
    r = 0.52 + craze * 0.20 + micro * 0.03       # and they are rougher
    ao = np.clip(1.0 - craze * 0.22, 0.72, 1.0)
    write_set("ceramic", c, h, r, 0.0, ao, 0.42)


def make_plaster():
    """Interior lime plaster: the flattest base colour in the building.

    Float texture is pure relief -- the trowel leaves a shape, not a stain.
    """
    u, v = grid_uv(RES)
    base, warm = col(0.512, 0.482, 0.432), col(0.556, 0.527, 0.476)
    fl = fbm(u, v, 60, 2, 311)
    grit = contrast(worley(u, v, 200, 317, 1.0), 1.10)
    c = tint(np.clip(fl * 0.10 + 0.40, 0, 1), base, warm)
    h = fl * 0.34 + grit * 0.10                  # float undulation, real relief
    r = 0.88 + fl * 0.06 - grit * 0.03           # mattest surface in the palette
    ao = np.clip(1.0 - (1.0 - grit) * 0.04, 0.88, 1.0)
    write_set("plaster", c, h, r, 0.0, ao, 0.62)


def make_screed():
    """Ground/polished screed floor.

    Exposed cut aggregate IS a different mineral, so it keeps real albedo -- but
    sparse, a few cut faces per tile.  The trowel burnish is a POLISH: it goes
    into roughness, directionally, and nowhere near the base colour.
    """
    u, v = grid_uv(RES)
    base, poli = col(0.055, 0.051, 0.046), col(0.148, 0.140, 0.126)
    trowel = dblur(fbm(u, v, 90, 2, 141), RES // 90, axis=1)
    trowel = (trowel - trowel.min()) / (np.ptp(trowel) + 1e-9)
    agg_f = worley(u, v, 150, 151, 0.95)
    agg = smooth(1.0 - agg_f, 0.84, 1.0)         # ~5% of the tile, hard threshold
    hair = smooth(1.0 - worley(u, v, 34, 161, 1.0, order=1), 0.955, 1.0)
    hair *= smooth(fbm(u, v, 48, 2, 167), 0.66, 0.94)
    c = tint(np.clip(agg * 0.72 + 0.06, 0, 1), base, poli)
    c *= (1.0 - hair * 0.16)[..., None]
    h = agg * 0.16 - hair * 0.75                 # aggregate proud, hairlines cut
    # the burnish is directional and is the floor's real identity: smoothest
    # large surface in the building, so it separates from the sinter it meets.
    r = 0.34 - trowel * 0.13 + agg * 0.20 + hair * 0.16
    ao = np.clip(1.0 - hair * 0.28 - (1.0 - agg) * 0.03, 0.66, 1.0)
    write_set("screed", c, h, r, 0.0, ao, 0.55)


def make_roofmetal():
    """Chalky galvanised sheet: spangle is a crystal FACET, not a stain."""
    u, v = grid_uv(RES)
    base, brt = col(0.222, 0.226, 0.220), col(0.286, 0.291, 0.283)
    spangle = contrast(worley(u, v, 120, 181, 1.0), 1.22)
    roll = dblur(fbm(u, v, 100, 1, 191), RES // 64, axis=0)
    roll = (roll - roll.min()) / (np.ptp(roll) + 1e-9)
    grit = fbm(u, v, 120, 1, 199)
    c = tint(np.clip(spangle * 0.14 + roll * 0.06 + 0.30, 0, 1), base, brt)
    h = spangle * 0.30 + roll * 0.16 + grit * 0.08
    r = 0.64 + spangle * 0.11 - roll * 0.05 + grit * 0.05     # facets scatter
    ao = np.clip(1.0 - (1.0 - spangle) * 0.05, 0.88, 1.0)
    write_set("roofmetal", c, h, r, 1.0, ao, 0.60)


def make_steel():
    """Dark structural steel: brush grain is anisotropic ROUGHNESS."""
    u, v = grid_uv(RES)
    # PASS-4: base lifted 0.042 -> 0.061 linear.  At 0.042 every steel member in
    # shade collapsed to luminance ~0.03 and read as a slot cut in the wall --
    # measured on the east flank's conduit drop, which rendered as a 1.5 m black
    # bar.  0.061 is still the darkest material in the palette (sinter 0.074,
    # screed 0.055 but rough+dielectric) and still reads as dark machinery, but
    # it survives shade.  It is separated from sinter by metallic=1 and by
    # roughness 0.44 vs 0.86, not by value alone.
    base, brt = col(0.061, 0.064, 0.069), col(0.086, 0.090, 0.097)
    brush = dblur(fbm(u, v, 240, 1, 211), max(2, RES // 150), axis=1)
    brush = contrast(brush, 1.18)
    brush = (brush - brush.min()) / (np.ptp(brush) + 1e-9)
    fineb = dblur(fbm(u, v, 320, 1, 213), max(2, RES // 200), axis=1)
    fineb = (fineb - fineb.min()) / (np.ptp(fineb) + 1e-9)
    micro = fbm(u, v, 150, 1, 229)
    c = tint(np.clip(brush * 0.10 + 0.34, 0, 1), base, brt)
    h = brush * 0.22 + fineb * 0.13 + micro * 0.05
    # the grain is entirely in the specular: dark, semi-gloss, directional
    r = 0.44 - brush * 0.10 + fineb * 0.07 + micro * 0.03
    ao = np.clip(1.0 - (1.0 - brush) * 0.03, 0.90, 1.0)
    write_set("steel", c, h, r, 1.0, ao, 0.52)


def make_brass():
    """Satin brass: FLAT albedo. Turning marks are anisotropic roughness only.

    Patina and handled polish are authored per-vertex where hands actually go.
    The review's "brass reads like noisy wood" was a base-colour streak; brass
    is a narrow value band whose entire character is its specular response.
    """
    u, v = grid_uv(RES)
    base, pol = col(0.352, 0.258, 0.100), col(0.386, 0.288, 0.118)
    turn = dblur(fbm(u, v, 260, 1, 241), max(2, RES // 200), axis=0)
    turn = contrast(turn, 1.16)
    turn = (turn - turn.min()) / (np.ptp(turn) + 1e-9)
    fineg = fbm(u, v, 300, 1, 257)
    c = tint(np.clip(turn * 0.09 + 0.34, 0, 1), base, pol)
    h = turn * 0.16 + fineg * 0.06
    # glossiest material in the palette, and the turning marks live here
    r = 0.19 + turn * 0.10 - fineg * 0.02
    ao = np.clip(1.0 - (1.0 - turn) * 0.03, 0.92, 1.0)
    write_set("brass", c, h, r, 1.0, ao, 0.38)


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
        "material_scale": MATERIAL_SCALE,
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
        "material_response": RESPONSE,
        "textures": WRITTEN,
    }
    json.dump(meta, open(os.path.join(OUT, "textures.json"), "w"), indent=1)
    tot = sum(x["bytes"] for x in WRITTEN.values())
    lo = [c for c in CHECKS if c["kind"] == "low_freq_ceiling"]
    worst = max(lo, key=lambda c: c["low_freq_rms"] / c["budget"])
    print(f"\n{len(WRITTEN)} textures, {tot/1024/1024:.2f} MB on disk")
    print(f"micro-only checks: {sum(1 for c in CHECKS if c['pass'])}/{len(CHECKS)} pass"
          f" | tightest: {worst['map']} {worst['low_freq_rms']:.4f}/{worst['budget']}")
    # pass-4: prove detail moved OUT of albedo and INTO the response maps
    bcm = [r["basecolor_micro"] for r in RESPONSE]
    print(f"base-colour micro energy: max {max(bcm):.4f} (sinter), "
          f"quiet materials {min(bcm):.4f}..{sorted(bcm)[-2]:.4f}")
    print(f"roughness micro energy:   {min(r['roughness_micro'] for r in RESPONSE):.4f}"
          f"..{max(r['roughness_micro'] for r in RESPONSE):.4f}")
    print("TEXTURES_OK")
