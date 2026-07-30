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
# metres per tile repeat, and the permitted micro-energy band (sRGB rms)
# tile_m: metres per repeat.  micro: permitted sRGB high-frequency rms band.
# The bands are DELIBERATELY different: sinter is the one coarse material in
# the palette (exposed basalt aggregate) and everything else is quiet, so the
# plinth reads apart from the screed it meets at every wall base instead of
# both being the same sponge.  roughness spans 0.23 (brass) to 0.91 (plaster),
# which is what makes the materials separate under one lamp.
MATERIAL_SCALE = {
    "sinter":    {"tile_m": 1.30, "micro": (0.026, 0.044), "rough_mean": 0.82},
    "ceramic":   {"tile_m": 2.40, "micro": (0.008, 0.014), "rough_mean": 0.55},
    "plaster":   {"tile_m": 1.70, "micro": (0.007, 0.012), "rough_mean": 0.91},
    "screed":    {"tile_m": 2.10, "micro": (0.013, 0.022), "rough_mean": 0.32},
    "roofmetal": {"tile_m": 1.50, "micro": (0.014, 0.025), "rough_mean": 0.69},
    "steel":     {"tile_m": 0.55, "micro": (0.013, 0.023), "rough_mean": 0.49},
    "brass":     {"tile_m": 0.30, "micro": (0.007, 0.012), "rough_mean": 0.23},
}

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


def assert_micro_band(name, label, a, lo, hi):
    """Micro energy must sit inside this material's own band.

    A floor alone lets every tile sit at maximum grain, which is what made the
    whole building read as one procedural sponge (pass-3 review defect 7).
    """
    r = high_freq_rms(a)
    ok = lo <= r <= hi
    CHECKS.append({"map": f"{name}.{label}", "kind": "micro_band",
                   "high_freq_rms": round(r, 5), "band": [lo, hi], "pass": bool(ok)})
    if not ok:
        raise AssertionError(
            f"{name}.{label}: micro energy {r:.4f} outside band [{lo}, {hi}] -- "
            f"{'too smooth to be a material' if r < lo else 'too grainy; this is '
               'what makes every surface read as the same sponge'}")
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
    band = MATERIAL_SCALE[name]["micro"]
    assert_micro_band(name, "basecolor", bc_srgb, band[0], band[1])
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
    # albedo floor raised to a physically real sintered-basalt value: the old
    # 0.036 linear was darker than any basalt, so the plinth collapsed to black
    # in raking light and read as missing geometry (pass-3 review defect 5).
    base, pale = col(0.074, 0.065, 0.055), col(0.196, 0.177, 0.148)
    agg = worley(u, v, 130, 11, 0.95)            # ~1 cm aggregate on a 1.3 m tile
    agg2 = worley(u, v, 230, 13, 0.95)
    grain = contrast(np.clip(agg * 0.62 + agg2 * 0.38, 0, 1), 1.26)
    fine = fbm(u, v, 70, 3, 21)
    # vesicles: sparse pinholes, NOT a dot grid -- threshold hard, keep ~2%
    ves_f = worley(u, v, 120, 41, 1.0)
    ves = smooth(1.0 - ves_f, 0.93, 1.0) * smooth(fbm(u, v, 64, 2, 47), 0.60, 0.92)
    c = tint(np.clip(grain * 0.78 + fine * 0.34 - 0.06, 0, 1), base, pale)
    c *= (1.0 - ves * 0.55)[..., None]
    h = grain * 0.42 + fine * 0.20 - ves * 0.95
    r = 0.86 - grain * 0.07 + ves * 0.04
    ao = np.clip(1.0 - ves * 0.45 - (1.0 - grain) * 0.10, 0.45, 1.0)
    write_set("sinter", c, h, r, 0.0, ao, 1.35, micro_floor=0.018)


def make_ceramic():
    """Imported ceramic composite: very fine speckle + micro crazing only."""
    u, v = grid_uv(RES)
    base, dark = col(0.632, 0.612, 0.574), col(0.428, 0.412, 0.382)
    speck = contrast(worley(u, v, 240, 71, 1.0), 1.10)
    micro = fbm(u, v, 90, 2, 91)
    craze = smooth(1.0 - worley(u, v, 38, 101, 1.0, order=1), 0.945, 1.0)
    craze *= smooth(fbm(u, v, 60, 2, 107), 0.62, 0.92)
    c = tint(np.clip(micro * 0.30 + speck * 0.26 + 0.16, 0, 1), base, dark)
    c *= (1.0 - craze * 0.10)[..., None]
    h = micro * 0.07 + speck * 0.05 - craze * 0.34
    # semi-matte, and clearly flatter than brass and clearly glossier than
    # plaster, so the three read apart under the same lamp
    r = 0.52 + micro * 0.05 + craze * 0.12
    ao = np.clip(1.0 - craze * 0.16, 0.72, 1.0)
    write_set("ceramic", c, h, r, 0.0, ao, 0.30, micro_floor=0.004)


def make_plaster():
    """Interior lime plaster on the soffits/ceilings: float texture, warm."""
    u, v = grid_uv(RES)
    base, warm = col(0.512, 0.482, 0.432), col(0.706, 0.680, 0.622)
    fl = fbm(u, v, 60, 2, 311)
    grit = contrast(worley(u, v, 200, 317, 1.0), 1.10)
    c = tint(np.clip(fl * 0.34 + grit * 0.22 + 0.18, 0, 1), base, warm)
    h = fl * 0.11 + grit * 0.04
    r = 0.88 + fl * 0.05          # the mattest surface in the building
    ao = np.clip(1.0 - (1.0 - grit) * 0.04, 0.88, 1.0)
    write_set("plaster", c, h, r, 0.0, ao, 0.26, micro_floor=0.004)


def make_screed():
    """Ground/polished screed floor: fine trowel grain + sparse fine aggregate."""
    u, v = grid_uv(RES)
    base, poli = col(0.055, 0.051, 0.046), col(0.182, 0.172, 0.154)
    trowel = dblur(fbm(u, v, 90, 2, 141), RES // 90, axis=1)
    trowel = (trowel - trowel.min()) / (np.ptp(trowel) + 1e-9)
    # ground finish: aggregate is EXPOSED but sparse -- a few cut faces per
    # tile, not a dense speckle field.  Threshold hard and keep ~8%.
    agg_f = worley(u, v, 150, 151, 0.95)
    agg = smooth(1.0 - agg_f, 0.80, 1.0)
    hair = smooth(1.0 - worley(u, v, 34, 161, 1.0, order=1), 0.955, 1.0)
    hair *= smooth(fbm(u, v, 48, 2, 167), 0.66, 0.94)
    c = tint(np.clip(trowel * 0.30 + agg * 0.62 + 0.05, 0, 1), base, poli)
    c *= (1.0 - hair * 0.30)[..., None]
    h = agg * 0.13 + trowel * 0.05 - hair * 0.45
    # polished screed is the SMOOTHEST large surface in the building; that is
    # how it separates from the sinter plinth it meets at every wall base.
    r = 0.34 + agg * 0.16 - trowel * 0.05 + hair * 0.12
    ao = np.clip(1.0 - hair * 0.28 - (1.0 - agg) * 0.03, 0.66, 1.0)
    write_set("screed", c, h, r, 0.0, ao, 0.44, micro_floor=0.008)


def make_roofmetal():
    """Chalky galvanised sheet: fine spangle + faint roll grain. No oxide blobs."""
    u, v = grid_uv(RES)
    base, brt = col(0.222, 0.226, 0.220), col(0.406, 0.412, 0.402)
    spangle = contrast(worley(u, v, 120, 181, 1.0), 1.22)
    roll = dblur(fbm(u, v, 100, 1, 191), RES // 64, axis=0)
    roll = (roll - roll.min()) / (np.ptp(roll) + 1e-9)
    grit = fbm(u, v, 120, 1, 199)
    c = tint(np.clip(spangle * 0.40 + roll * 0.16 + grit * 0.12 + 0.08, 0, 1),
             base, brt)
    h = spangle * 0.12 + roll * 0.07 + grit * 0.05
    r = 0.64 + spangle * 0.06 + grit * 0.04       # chalky, not shiny
    ao = np.clip(1.0 - (1.0 - spangle) * 0.05, 0.88, 1.0)
    write_set("roofmetal", c, h, r, 1.0, ao, 0.36, micro_floor=0.006)


def make_steel():
    """Dark structural steel: fine unidirectional brush grain, no drag streaks."""
    u, v = grid_uv(RES)
    base, brt = col(0.042, 0.044, 0.047), col(0.178, 0.184, 0.193)
    brush = dblur(fbm(u, v, 240, 1, 211), max(2, RES // 150), axis=1)
    brush = contrast(brush, 1.18)
    brush = (brush - brush.min()) / (np.ptp(brush) + 1e-9)
    fineb = dblur(fbm(u, v, 320, 1, 213), max(2, RES // 200), axis=1)
    fineb = (fineb - fineb.min()) / (np.ptp(fineb) + 1e-9)
    micro = fbm(u, v, 150, 1, 229)
    c = tint(np.clip(brush * 0.44 + fineb * 0.24 + micro * 0.10 + 0.06, 0, 1),
             base, brt)
    h = brush * 0.12 + fineb * 0.07 + micro * 0.03
    # dark, semi-gloss: reads as machinery against the matte ceramic
    r = 0.44 + brush * 0.06 + fineb * 0.03
    ao = np.clip(1.0 - (1.0 - brush) * 0.03, 0.90, 1.0)
    write_set("steel", c, h, r, 1.0, ao, 0.30, micro_floor=0.004)


def make_brass():
    """Satin brass: fine turning marks only. No pits, no dots, no verdigris blobs.

    Patina and handled polish are authored per-vertex where hands actually go.
    """
    u, v = grid_uv(RES)
    # tight tonal range: satin brass is a NARROW value band with a specular
    # response, not a two-tone streak.  The old 0.340->0.622 swing is halved.
    base, pol = col(0.352, 0.258, 0.100), col(0.474, 0.372, 0.176)
    # turning marks stay directional but become fine and low-amplitude: on a
    # 0.30 m tile these are ~2 mm, which is what satin brass actually is.
    turn = dblur(fbm(u, v, 260, 1, 241), max(2, RES // 200), axis=0)
    turn = contrast(turn, 1.16)
    turn = (turn - turn.min()) / (np.ptp(turn) + 1e-9)
    fineg = fbm(u, v, 300, 1, 257)
    c = tint(np.clip(turn * 0.52 + fineg * 0.20 + 0.10, 0, 1), base, pol)
    h = turn * 0.07 + fineg * 0.03
    # the identity is in the RESPONSE, not the colour: brass is the glossiest
    # thing in the palette, so it catches the lamps and reads as metal.
    r = 0.19 + turn * 0.05 + fineg * 0.03
    ao = np.clip(1.0 - (1.0 - turn) * 0.03, 0.92, 1.0)
    write_set("brass", c, h, r, 1.0, ao, 0.22, micro_floor=0.004)


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
