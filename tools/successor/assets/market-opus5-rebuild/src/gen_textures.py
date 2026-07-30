"""Deterministic tileable PBR texture library for the Sinter-Frame Civic market.

Micro detail only: grain, pitting, mill marks, patina, trowel swirl.
Every macro feature (joints, seams, reveals, bolts, louvers) is real geometry.

Uniform texel density: 204.8 px/m across every material.
  1024 px maps -> 5.0 m tile     512 px maps -> 2.5 m tile

Run:  python3 src/gen_textures.py
"""
import hashlib
import json
import os

import numpy as np
from PIL import Image

OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "build", "textures")
TEXEL_DENSITY = 204.8  # px per metre, every material

# ---------------------------------------------------------------- noise core

def _lattice(seed, freq):
    return np.random.default_rng(seed).random((freq, freq)).astype(np.float32)


def vnoise(u, v, freq, seed):
    """Periodic value noise. u,v in tile units (period 1.0)."""
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
    total = np.zeros_like(u, dtype=np.float32)
    amp, norm = 1.0, 0.0
    for o in range(octaves):
        total += amp * vnoise(u, v, freq * (2 ** o), seed + o * 97)
        norm += amp
        amp *= gain
    return total / norm


def worley(u, v, cells, seed, jitter=0.85, order=0):
    """Periodic Worley. order=0 -> F1, order=1 -> F2."""
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
    return np.where(lin <= 0.0031308, lin * 12.92, 1.055 * np.power(lin, 1 / 2.4) - 0.055)


def resize(arr, res):
    # Image.fromarray(..., "F") reinterprets the raw buffer: the array MUST be
    # C-contiguous float32 or the result is silently garbage (NaN/noise).
    arr = np.ascontiguousarray(arr, dtype=np.float32)
    if arr.shape[0] == res:
        out = arr
    elif arr.ndim == 2:
        out = np.asarray(Image.fromarray(arr, "F").resize((res, res), Image.LANCZOS), np.float32)
    else:
        out = np.stack([np.asarray(
            Image.fromarray(np.ascontiguousarray(arr[..., i]), "F")
            .resize((res, res), Image.LANCZOS), np.float32)
            for i in range(arr.shape[2])], -1)
    if not np.isfinite(out).all():
        raise ValueError(f"non-finite value after resize {arr.shape} -> {res}")
    return out


def dblur(a, radius, axis):
    """Periodic box blur along one axis: real anisotropy without lattice stretch."""
    a = np.ascontiguousarray(a, np.float32)
    n = a.shape[axis]
    r = max(1, int(radius))
    acc = np.zeros_like(a)
    for k in range(-r, r + 1):
        acc += np.roll(a, k, axis=axis)
    return acc / float(2 * r + 1)


def height_to_normal(h, strength):
    dx = (np.roll(h, -1, 1) - np.roll(h, 1, 1)) * 0.5
    dy = (np.roll(h, -1, 0) - np.roll(h, 1, 0)) * 0.5
    n = np.stack([-dx * strength, dy * strength, np.ones_like(h)], -1)
    return n / np.linalg.norm(n, axis=-1, keepdims=True)


WRITTEN = {}


def write_set(name, bc_lin, height, rough, metal, ao, res_bc, res_n, res_orm, nstr):
    os.makedirs(OUT, exist_ok=True)
    for lbl, a in (("basecolor", bc_lin), ("height", height), ("roughness", rough),
                   ("metallic", metal), ("ao", ao)):
        if not np.isfinite(a).all():
            raise ValueError(f"{name}.{lbl}: non-finite input")
    bc = (np.clip(srgb(resize(bc_lin, res_bc)), 0, 1) * 255).round().astype(np.uint8)
    nrm = ((height_to_normal(resize(height, res_n), nstr) * 0.5 + 0.5) * 255).round().astype(np.uint8)
    orm = np.stack([resize(ao, res_orm), resize(rough, res_orm), resize(metal, res_orm)], -1)
    orm = (np.clip(orm, 0, 1) * 255).round().astype(np.uint8)
    for suffix, data in (("basecolor", bc), ("normal", nrm), ("orm", orm)):
        # a map that is flat or full-range-noise means the pipeline broke
        for c in range(3):
            ch = data[..., c]
            if suffix == "normal" and c == 2:
                continue
            if int(ch.max()) - int(ch.min()) < 2:
                print(f"    note: {name}_{suffix} channel {c} is flat ({ch.mean():.0f})")
        p = os.path.join(OUT, f"market_{name}_{suffix}.png")
        Image.fromarray(data, "RGB").save(p, optimize=True)
        h = hashlib.sha256(open(p, "rb").read()).hexdigest()
        WRITTEN[f"market_{name}_{suffix}.png"] = {
            "sha256": h, "res": data.shape[0], "bytes": os.path.getsize(p)}
        print(f"  {os.path.basename(p):40s} {data.shape[0]:5d}px {os.path.getsize(p)/1024:8.1f} KB")


def col(r, g, b):
    return np.array([r, g, b], np.float32)


def tint(mask, base, other):
    return base[None, None, :] + (other - base)[None, None, :] * mask[..., None]


# ---------------------------------------------------------------- materials

def make_sinter(res=1024):
    """Solar-sintered basalt sand: coarse aggregate, pitting, casting lift lines."""
    u, v = grid_uv(res)
    base = col(0.052, 0.046, 0.040)
    pale = col(0.115, 0.104, 0.088)   # exposed lighter aggregate
    warm = col(0.078, 0.058, 0.041)   # iron-warm firing blotch

    # ~14 cm aggregate over a 5 m tile, with a second finer grain population
    agg_c = worley(u, v, 36, 11, 0.95)
    agg_f = worley(u, v, 84, 13, 0.95)
    grain = np.clip(agg_c * 0.62 + agg_f * 0.38, 0, 1)
    # soft, wide transition reads as packed aggregate rather than leopard spots
    facet = smooth(grain, 0.12, 1.00) * 0.72 + grain * 0.28
    facet = facet * (0.80 + 0.20 * fbm(u, v, 2, 3, 17))
    fine = fbm(u, v, 30, 4, 21)

    blotch = fbm(u, v, 3, 4, 31)
    # blowholes: sparse, round, genuinely dark
    pit_f = worley(u, v, 22, 41, 1.0)
    pits = smooth(1.0 - pit_f, 0.80, 1.0) * smooth(fbm(u, v, 5, 3, 47), 0.42, 0.85)
    vesic = smooth(1.0 - worley(u, v, 64, 43, 1.0), 0.86, 1.0)

    # casting lift lines: 8 per 5 m tile = one every 0.625 m, softened + wavering
    wob = (fbm(u, v, 4, 3, 53) - 0.5) * 0.06
    band = np.abs((((v + wob) * 8.0) % 1.0) - 0.5) * 2.0
    lift = smooth(band, 0.80, 1.0) * (0.45 + 0.55 * fbm(u, v, 6, 3, 59))

    c = tint(facet * 0.62 + fine * 0.22, base, pale)
    c = c + (warm - base)[None, None, :] * (smooth(blotch, 0.45, 0.95) * 0.55)[..., None]
    c *= (1.0 - pits * 0.62)[..., None]
    c *= (1.0 - vesic * 0.30)[..., None]
    c *= (1.0 - lift * 0.13)[..., None]

    h = facet * 0.70 + fine * 0.22 - pits * 1.6 - vesic * 0.55 - lift * 0.40 + blotch * 0.10
    r = 0.88 - facet * 0.12 + pits * 0.05 + vesic * 0.03
    m = np.zeros_like(u)
    ao = np.clip(1.0 - pits * 0.75 - vesic * 0.30 - lift * 0.20 - (1.0 - facet) * 0.16, 0.15, 1.0)
    write_set("sinter", c, h, r, m, ao, res, res, res // 2, 3.2)


def make_ceramic(res=1024):
    """Imported ceramic composite panel: fine speckle, mottle, micro scratches."""
    u, v = grid_uv(res)
    base = col(0.560, 0.530, 0.487)
    dark = col(0.470, 0.443, 0.405)
    speck = worley(u, v, 220, 71, 1.0)
    mottle = fbm(u, v, 5, 5, 81)
    micro = fbm(u, v, 60, 3, 91)
    scratch = smooth(fbm(u + fbm(u, v, 4, 2, 95) * 0.05, v, 2, 2, 101), 0.62, 0.66)
    scratch *= smooth(fbm(u, v, 9, 3, 107), 0.45, 0.85)

    c = tint(smooth(mottle, 0.3, 0.9) * 0.55 + micro * 0.12, base, dark)
    c += (col(0.62, 0.60, 0.56) - base)[None, None, :] * (smooth(speck, 0.55, 1.0) * 0.35)[..., None]
    c *= (1.0 - scratch * 0.10)[..., None]

    h = micro * 0.30 + speck * 0.18 - scratch * 0.55 + mottle * 0.08
    r = 0.44 + mottle * 0.14 + scratch * 0.22 + micro * 0.05
    m = np.zeros_like(u)
    ao = np.clip(1.0 - scratch * 0.18 - (1.0 - speck) * 0.06, 0.35, 1.0)
    write_set("ceramic", c, h, r, m, ao, res, res, res // 2, 1.2)


def make_screed(res=1024):
    """Polished sinter floor screed: trowel swirl, aggregate, hairline cracks."""
    u, v = grid_uv(res)
    base = col(0.085, 0.079, 0.071)
    poli = col(0.115, 0.107, 0.096)
    wx = fbm(u, v, 3, 3, 131) - 0.5
    wy = fbm(u, v, 3, 3, 137) - 0.5
    swirl = fbm(u + wx * 0.22, v + wy * 0.22, 6, 5, 141)
    agg = worley(u, v, 110, 151, 0.95)
    crack = 1.0 - worley(u, v, 13, 161, 1.0, order=1)
    crack = smooth(crack, 0.80, 0.99) * smooth(fbm(u, v, 4, 3, 167), 0.35, 0.8)
    grind = smooth(swirl, 0.42, 0.92)

    c = tint(grind * 0.7 + agg * 0.3, base, poli)
    c += (col(0.14, 0.132, 0.118) - base)[None, None, :] * (smooth(agg, 0.6, 1.0) * grind * 0.5)[..., None]
    c *= (1.0 - crack * 0.55)[..., None]

    h = agg * 0.25 + swirl * 0.12 - crack * 0.9
    r = 0.62 - grind * 0.34 + crack * 0.25
    m = np.zeros_like(u)
    ao = np.clip(1.0 - crack * 0.6 - (1.0 - agg) * 0.08, 0.25, 1.0)
    write_set("screed", c, h, r, m, ao, res, res, res // 2, 1.6)


def make_roofmetal(res=512):
    """Chalky galvanised sheet: spangle, roll marks, dull oxide patches."""
    u, v = grid_uv(res)
    base = col(0.300, 0.305, 0.300)
    ox = col(0.170, 0.155, 0.140)
    spangle = worley(u, v, 26, 181, 1.0)
    roll = fbm(u * 0.12, v * 26.0, 6, 3, 191)
    patch = smooth(fbm(u, v, 4, 4, 197), 0.56, 0.92)
    grit = fbm(u, v, 40, 3, 199)

    c = tint(smooth(spangle, 0.3, 0.95) * 0.5 + roll * 0.18 + grit * 0.1, base, col(0.36, 0.365, 0.36))
    c = c + (ox - base)[None, None, :] * (patch * 0.85)[..., None]

    h = spangle * 0.22 + roll * 0.30 + grit * 0.12 - patch * 0.2
    r = 0.46 + spangle * 0.10 + patch * 0.34 + grit * 0.05
    m = np.clip(1.0 - patch * 0.85, 0.0, 1.0)
    ao = np.clip(1.0 - patch * 0.16, 0.5, 1.0)
    write_set("roofmetal", c, h, r, m, ao, res, res, res // 2, 1.1)


def make_steel(res=512):
    """Dark machined structural steel: brushed grain, drag scratches, mill flats."""
    u, v = grid_uv(res)
    base = col(0.086, 0.088, 0.093)
    # anisotropy by filtering isotropic noise, never by stretching the lattice
    brush = dblur(fbm(u, v, 128, 2, 211), res // 24, axis=1)
    brush = (brush - brush.min()) / (np.ptp(brush) + 1e-9)
    fineb = dblur(fbm(u, v, 200, 1, 213), res // 40, axis=1)
    fineb = (fineb - fineb.min()) / (np.ptp(fineb) + 1e-9)
    coarse = fbm(u, v, 5, 4, 217)
    drag = dblur(smooth(fbm(u, v, 150, 1, 223), 0.74, 0.80), res // 10, axis=1)
    drag = np.clip(drag * 3.0, 0, 1)
    micro = fbm(u, v, 90, 2, 229)

    c = tint(brush * 0.55 + fineb * 0.25 + micro * 0.08, base, col(0.128, 0.131, 0.137))
    c += (col(0.185, 0.188, 0.196) - base)[None, None, :] * (drag * 0.55)[..., None]
    c *= (1.0 - smooth(coarse, 0.72, 1.0) * 0.10)[..., None]

    h = brush * 0.45 + fineb * 0.25 + micro * 0.10 - drag * 0.35
    r = 0.42 + brush * 0.10 + fineb * 0.08 + coarse * 0.08 - drag * 0.14
    m = np.full_like(u, 1.0) - drag * 0.03
    ao = np.clip(1.0 - drag * 0.06 - (1.0 - brush) * 0.05, 0.7, 1.0)
    write_set("steel", c, h, r, m, ao, res, res, res // 2, 1.1)


def make_brass(res=512):
    """Aged brass: fine turning marks, patina in the cavities, handled polish."""
    u, v = grid_uv(res)
    base = col(0.482, 0.352, 0.132)
    pat = col(0.232, 0.244, 0.168)   # muted green-grey verdigris
    pol = col(0.640, 0.508, 0.238)   # rubbed highlight
    turn = dblur(fbm(u, v, 110, 2, 241), res // 36, axis=0)
    turn = (turn - turn.min()) / (np.ptp(turn) + 1e-9)
    cav = smooth(fbm(u, v, 6, 5, 251), 0.62, 0.96)      # patina only in the low areas
    grain = fbm(u, v, 70, 2, 257)
    # shallow dents: darken, never brighten
    dent = smooth(1.0 - worley(u, v, 18, 263, 1.0), 0.84, 1.0)

    c = tint(turn * 0.55 + grain * 0.15, base, pol)
    c = c + (pat - base)[None, None, :] * (cav * 0.62)[..., None]
    c *= (1.0 - dent * 0.20)[..., None]

    h = turn * 0.30 + grain * 0.12 - dent * 0.9 - cav * 0.20
    r = 0.26 + cav * 0.40 + turn * 0.08 + dent * 0.16
    m = np.clip(1.0 - cav * 0.45, 0.0, 1.0)
    ao = np.clip(1.0 - cav * 0.26 - dent * 0.30, 0.4, 1.0)
    write_set("brass", c, h, r, m, ao, res, res, res // 2, 1.4)


if __name__ == "__main__":
    print("Generating market PBR texture library (204.8 px/m):")
    make_sinter()
    make_ceramic()
    make_screed()
    make_roofmetal()
    make_steel()
    make_brass()
    meta = {
        "texel_density_px_per_m": TEXEL_DENSITY,
        "tile_metres": {"1024": 5.0, "512": 2.5},
        "orm_packing": "R=occlusion, G=roughness, B=metallic",
        "colour_space": {"basecolor": "sRGB", "normal": "linear tangent-space (OpenGL +Y)",
                         "orm": "linear"},
        "textures": WRITTEN,
    }
    json.dump(meta, open(os.path.join(OUT, "textures.json"), "w"), indent=1)
    total = sum(v["bytes"] for v in WRITTEN.values())
    print(f"\n{len(WRITTEN)} textures, {total/1024/1024:.2f} MB on disk")
