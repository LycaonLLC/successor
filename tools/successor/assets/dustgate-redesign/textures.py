"""Deterministic procedural PBR texture set for the settlement construction kit.

    blender -b -P textures.py

Writes seamless tiling albedo / normal / ORM maps into the ignored proof root.
Every map is generated from a fixed seed, so a rebuild is byte-stable.

Design rules taken from `docs/ART_DIRECTION.md` and the first-pass direction
record:
  * wear has a cause - streaks below joints, dust rise at the ground, chipping at
    use points, oxidation where water sits. No global scratch noise.
  * large-scale value variation only; the post stack removes fine detail.
  * one tiling period of 2.0 m per map at 512 px, so texel density is a uniform
    256 texels/m across the whole kit.

ORM packing follows the glTF convention used by the repository's promoted
assets: R = ambient occlusion, G = roughness, B = metallic.
"""

from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import numpy as np

from dgpaths import prod

RES = 1024
TILE_METRES = 2.0
TEXELS_PER_METRE = RES / TILE_METRES  # 512
SEED = 20260729


def m2px(metres: float) -> float:
    """Metres -> texels. Feature periods are authored in metres so the maps
    keep their real-world scale when RES changes."""
    return metres * TEXELS_PER_METRE

# --------------------------------------------------------------------------
# periodic noise helpers: everything must wrap so the maps tile seamlessly
# --------------------------------------------------------------------------


def _lattice(rng: np.random.Generator, cells: int) -> np.ndarray:
    return rng.random((cells, cells), dtype=np.float64)


def periodic_value_noise(rng: np.random.Generator, cells: int, res: int = RES) -> np.ndarray:
    """Bilinear value noise on a wrapping lattice."""
    grid = _lattice(rng, cells)
    coords = np.linspace(0.0, cells, res, endpoint=False)
    i0 = np.floor(coords).astype(int) % cells
    i1 = (i0 + 1) % cells
    frac = coords - np.floor(coords)
    smooth = frac * frac * (3.0 - 2.0 * frac)
    gx0, gx1 = grid[np.ix_(i0, i0)], grid[np.ix_(i0, i1)]
    gy0, gy1 = grid[np.ix_(i1, i0)], grid[np.ix_(i1, i1)]
    fx = smooth[None, :]
    fy = smooth[:, None]
    top = gx0 * (1 - fx) + gx1 * fx
    bottom = gy0 * (1 - fx) + gy1 * fx
    return top * (1 - fy) + bottom * fy


def fbm(rng: np.random.Generator, base_cells: int, octaves: int, gain: float = 0.5) -> np.ndarray:
    total = np.zeros((RES, RES), dtype=np.float64)
    amplitude = 1.0
    norm = 0.0
    cells = base_cells
    for _ in range(octaves):
        total += periodic_value_noise(rng, cells) * amplitude
        norm += amplitude
        amplitude *= gain
        cells *= 2
    return total / norm


def stripes(period_px: float, duty: float, axis: int = 0, phase: float = 0.0) -> np.ndarray:
    """Hard-edged periodic stripe mask; period must divide RES to stay seamless."""
    idx = np.arange(RES, dtype=np.float64)
    pos = ((idx + phase) % period_px) / period_px
    line = (pos < duty).astype(np.float64)
    return np.tile(line, (RES, 1)) if axis == 0 else np.tile(line[:, None], (1, RES))


def ramp(axis: int = 1) -> np.ndarray:
    line = np.linspace(0.0, 1.0, RES, endpoint=False)
    return np.tile(line, (RES, 1)) if axis == 0 else np.tile(line[:, None], (1, RES))


def smoothstep(edge0: float, edge1: float, values: np.ndarray) -> np.ndarray:
    t = np.clip((values - edge0) / max(edge1 - edge0, 1e-9), 0.0, 1.0)
    return t * t * (3.0 - 2.0 * t)


def srgb_to_linear(value: np.ndarray) -> np.ndarray:
    return np.where(value <= 0.04045, value / 12.92, ((value + 0.055) / 1.055) ** 2.4)


def hex_linear(value: str) -> np.ndarray:
    value = value.lstrip("#")
    raw = np.array([int(value[i:i + 2], 16) / 255.0 for i in (0, 2, 4)])
    return srgb_to_linear(raw)


def normal_from_height(height: np.ndarray, strength: float) -> np.ndarray:
    """Tangent-space normal map from a wrapping height field."""
    dx = (np.roll(height, -1, axis=1) - np.roll(height, 1, axis=1)) * 0.5
    dy = (np.roll(height, -1, axis=0) - np.roll(height, 1, axis=0)) * 0.5
    nx = -dx * strength
    ny = dy * strength
    nz = np.ones_like(height)
    length = np.sqrt(nx * nx + ny * ny + nz * nz)
    out = np.stack([nx / length, ny / length, nz / length], axis=-1)
    return out * 0.5 + 0.5


# --------------------------------------------------------------------------
# per-material authoring
# --------------------------------------------------------------------------


def mix(base: np.ndarray, other: np.ndarray, mask: np.ndarray) -> np.ndarray:
    """Blend two sRGB swatches by a 0..1 mask, in sRGB space."""
    m = np.clip(mask, 0.0, 1.0)[..., None]
    return base * (1.0 - m) + other * m


def hex_srgb(value: str) -> np.ndarray:
    value = value.lstrip("#")
    return np.array([int(value[i:i + 2], 16) / 255.0 for i in (0, 2, 4)])


def flat(value: str) -> np.ndarray:
    return np.broadcast_to(hex_srgb(value), (RES, RES, 3)).copy()


def shade(colour: np.ndarray, amount: np.ndarray) -> np.ndarray:
    """Multiplicative value modulation centred on 1.0, kept in sRGB space."""
    return np.clip(colour * (1.0 + amount)[..., None], 0.0, 1.0)


def build_panel(rng):
    """Ribbed steel wall cladding: 0.5 m ribs, one horizontal panel joint."""
    rib = stripes(m2px(0.5), 0.30, axis=0)                # 4 ribs per 2 m
    rib_lit = smoothstep(0.25, 0.75, rib * 0.7 + 0.15)
    rib_shadow = stripes(m2px(0.5), 0.09, axis=0, phase=m2px(-0.043))
    joint = smoothstep(0.0, 1.0, 1.0 - np.abs(ramp(1) - 0.5) * 26.0)
    grime = fbm(rng, 4, 4)
    streak = np.clip(fbm(rng, 3, 3) * 1.8 - 0.55, 0.0, 1.0)
    streak *= smoothstep(0.5, 0.72, ramp(1))              # only below the joint
    dust = smoothstep(0.88, 1.0, ramp(1))

    albedo = flat("#9a8c72")
    albedo = mix(albedo, flat("#af9f83"), rib_lit * 0.55)
    albedo = mix(albedo, flat("#6f6555"), rib_shadow * 0.7)
    albedo = mix(albedo, flat("#645b4c"), joint * 0.8)
    albedo = mix(albedo, flat("#7d7260"), streak * 0.55)
    albedo = mix(albedo, flat("#b9aa8c"), dust * 0.45)
    albedo = shade(albedo, (grime - 0.5) * 0.16)

    height = rib_lit * 0.6 - rib_shadow * 0.35 - joint * 0.5 + grime * 0.06
    rough = 0.5 + grime * 0.18 + streak * 0.2 + dust * 0.12
    metal = np.full((RES, RES), 0.2) * (1.0 - streak * 0.7)
    ao = 1.0 - joint * 0.35 - rib_shadow * 0.25
    return albedo, height, 3.0, ao, rough, metal


def build_roof(rng):
    """Standing-seam roof metal: 0.5 m raised seams, cross battens, oxide pooling."""
    seam = stripes(m2px(0.5), 0.09, axis=0)
    seam_shadow = stripes(m2px(0.5), 0.06, axis=0, phase=m2px(-0.027))
    batten = stripes(m2px(1.0), 0.045, axis=1)
    oxide_pool = np.clip(fbm(rng, 3, 4) * 1.9 - 0.72, 0.0, 1.0)
    grime = fbm(rng, 6, 3)

    albedo = flat("#3b3630")
    albedo = mix(albedo, flat("#514a41"), seam * 0.85)
    albedo = mix(albedo, flat("#26221e"), seam_shadow * 0.8)
    albedo = mix(albedo, flat("#2f2b26"), batten * 0.7)
    albedo = mix(albedo, flat("#6d4128"), oxide_pool * 0.7)
    albedo = shade(albedo, (grime - 0.5) * 0.22)

    height = seam * 0.9 - seam_shadow * 0.4 + batten * 0.35 + grime * 0.05
    rough = 0.42 + grime * 0.16 + oxide_pool * 0.38
    metal = 0.66 - oxide_pool * 0.5
    ao = 1.0 - seam_shadow * 0.3 - oxide_pool * 0.12 - batten * 0.15
    return albedo, height, 3.4, ao, rough, metal


def build_canvas(rng):
    """Woven storm fabric: warp and weft, sun bleaching, stained lower edge."""
    warp = stripes(m2px(1.0 / 32.0), 0.5, axis=0)
    weft = stripes(m2px(1.0 / 32.0), 0.5, axis=1)
    weave = warp * 0.5 + weft * 0.5
    slub = fbm(rng, 10, 3)
    bleach = smoothstep(0.55, 0.85, fbm(rng, 3, 3))
    stain = np.clip(fbm(rng, 4, 4) * 1.6 - 0.6, 0.0, 1.0) * smoothstep(0.62, 1.0, ramp(1))

    albedo = flat("#ab9f85")
    albedo = mix(albedo, flat("#bdb29a"), bleach * 0.5)
    albedo = mix(albedo, flat("#8f8570"), (1.0 - weave) * 0.28)
    albedo = mix(albedo, flat("#6f6553"), stain * 0.65)
    albedo = shade(albedo, (slub - 0.5) * 0.12)

    height = weave * 0.45 + slub * 0.2
    rough = np.full((RES, RES), 0.86) + slub * 0.1
    metal = np.zeros((RES, RES))
    ao = 1.0 - (1.0 - weave) * 0.2
    return albedo, height, 1.4, ao, rough, metal


def build_plinth(rng):
    """Cast footing concrete: form-board lines, exposed aggregate, dust rise."""
    boards = stripes(m2px(0.25), 0.05, axis=1)
    aggregate = fbm(rng, 26, 3)
    pits = smoothstep(0.74, 0.94, fbm(rng, 18, 3))
    dust = smoothstep(0.5, 1.0, ramp(1))
    chip = smoothstep(0.84, 1.0, fbm(rng, 9, 2)) * smoothstep(0.35, 1.0, ramp(1))

    albedo = flat("#6a6154")
    albedo = mix(albedo, flat("#544c42"), boards * 0.8)
    albedo = mix(albedo, flat("#7d7466"), pits * 0.45)
    albedo = mix(albedo, flat("#8d8271"), chip * 0.7)
    albedo = mix(albedo, flat("#b8a68a"), dust * 0.4)
    albedo = shade(albedo, (aggregate - 0.5) * 0.18)

    height = -boards * 0.55 - pits * 0.6 + aggregate * 0.2 - chip * 0.8
    rough = 0.8 + aggregate * 0.14
    metal = np.zeros((RES, RES))
    ao = 1.0 - boards * 0.42 - pits * 0.32
    return albedo, height, 2.2, ao, rough, metal


def build_steel(rng):
    """Structural plate: brushed direction, weld beads, bolt rows."""
    brush = fbm(rng, 72, 2)
    weld = stripes(m2px(1.0), 0.03, axis=1)
    bolts = np.zeros((RES, RES))
    yy, xx = np.ogrid[:RES, :RES]
    bolt_radius = m2px(0.039)
    for cy in (RES // 8, RES * 3 // 8, RES * 5 // 8, RES * 7 // 8):
        for cx in (RES // 8, RES * 3 // 8, RES * 5 // 8, RES * 7 // 8):
            bolts += smoothstep(bolt_radius, bolt_radius * 0.45,
                                np.sqrt((yy - cy) ** 2 + (xx - cx) ** 2))
    bolts = np.clip(bolts, 0.0, 1.0)
    grime = fbm(rng, 5, 3)

    albedo = flat("#4a4842")
    albedo = mix(albedo, flat("#5e5b53"), bolts * 0.75)
    albedo = mix(albedo, flat("#565349"), weld * 0.7)
    albedo = mix(albedo, flat("#393731"), grime * 0.3)
    albedo = shade(albedo, (brush - 0.5) * 0.2)

    height = weld * 0.5 + bolts * 0.95 + brush * 0.08
    rough = 0.36 + brush * 0.2 + grime * 0.2
    metal = np.full((RES, RES), 0.9) - grime * 0.15
    ao = 1.0 - weld * 0.18
    return albedo, height, 2.8, ao, rough, metal


def build_oxide(rng):
    """Oxide-painted equipment metal: chipped paint over steel at use points."""
    chip_field = fbm(rng, 13, 4)
    chip = smoothstep(0.64, 0.79, chip_field)
    edge_wear = smoothstep(0.55, 0.85, fbm(rng, 4, 3))
    scuff = np.clip(fbm(rng, 22, 2) * 1.4 - 0.4, 0.0, 1.0) * edge_wear
    ribs = stripes(m2px(0.5), 0.16, axis=1)

    albedo = flat("#93502e")
    albedo = mix(albedo, flat("#a55c34"), ribs * 0.4)
    albedo = mix(albedo, flat("#4a4842"), chip * 0.85)
    albedo = mix(albedo, flat("#6b665f"), scuff * 0.5)
    albedo = shade(albedo, (chip_field - 0.5) * 0.16)

    height = -chip * 0.4 + ribs * 0.45
    rough = 0.52 + chip * 0.18 + scuff * 0.16
    metal = 0.24 + chip * 0.6
    ao = 1.0 - chip * 0.18 - ribs * 0.1
    return albedo, height, 2.0, ao, rough, metal


def build_ancient(rng):
    """Irreproducible older construction: cool cast mass, wind-scoured flutes,
    spalled arrises. Deliberately hue-separated from every warm human panel."""
    flute = stripes(m2px(0.4), 0.42, axis=0)
    flute_soft = smoothstep(0.15, 0.85, flute * 0.8 + 0.1)
    scour = fbm(rng, 5, 4)
    scour_bias = smoothstep(0.35, 1.0, ramp(1))          # wind cuts hardest low
    spall = smoothstep(0.78, 0.93, fbm(rng, 11, 3))
    grain = fbm(rng, 34, 3)

    albedo = flat("#5f6060")
    albedo = mix(albedo, flat("#6e7070"), flute_soft * 0.42)
    albedo = mix(albedo, flat("#4a4c4c"), (1.0 - flute_soft) * 0.35)
    albedo = mix(albedo, flat("#787774"), spall * 0.55)
    albedo = mix(albedo, flat("#9d8f77"), scour * scour_bias * 0.30)
    albedo = shade(albedo, (grain - 0.5) * 0.14)

    height = flute_soft * 0.7 - spall * 0.85 + grain * 0.12
    rough = 0.72 + grain * 0.14 + spall * 0.1
    metal = np.zeros((RES, RES))
    ao = 1.0 - (1.0 - flute_soft) * 0.28 - spall * 0.25
    return albedo, height, 2.6, ao, rough, metal


def build_sand(rng):
    """Ashvat ground: coarse lag gravel over fine drift, no route-shaped marks."""
    drift = fbm(rng, 3, 4)
    ripple = smoothstep(0.42, 0.58, fbm(rng, 14, 2))
    lag = smoothstep(0.72, 0.88, fbm(rng, 40, 3))
    grain = fbm(rng, 96, 2)

    albedo = flat("#c1ad8d")
    albedo = mix(albedo, flat("#cbb897"), ripple * 0.4)
    albedo = mix(albedo, flat("#a8967a"), (1.0 - ripple) * 0.3)
    albedo = mix(albedo, flat("#8d8272"), lag * 0.6)
    albedo = shade(albedo, (drift - 0.5) * 0.16 + (grain - 0.5) * 0.1)

    height = ripple * 0.35 + lag * 0.55 + grain * 0.15
    rough = 0.9 + grain * 0.08
    metal = np.zeros((RES, RES))
    ao = 1.0 - lag * 0.14
    return albedo, height, 1.1, ao, rough, metal


BUILDERS = {
    "panel": build_panel,
    "roof": build_roof,
    "canvas": build_canvas,
    "plinth": build_plinth,
    "steel": build_steel,
    "oxide": build_oxide,
    "ancient": build_ancient,
    "sand": build_sand,
}


# --------------------------------------------------------------------------
# writing
# --------------------------------------------------------------------------


def save_png(path: str, rgb: np.ndarray, colorspace: str) -> str:
    """Write a float RGB array through Blender so the PNG is deterministic."""
    import bpy  # type: ignore

    name = os.path.basename(path)
    existing = bpy.data.images.get(name)
    if existing is not None:
        bpy.data.images.remove(existing)
    image = bpy.data.images.new(name, RES, RES, alpha=False, float_buffer=False)
    image.colorspace_settings.name = colorspace
    flat = np.zeros((RES, RES, 4), dtype=np.float32)
    flat[..., :3] = np.clip(rgb, 0.0, 1.0)[::-1]  # Blender rows run bottom-up
    flat[..., 3] = 1.0
    image.pixels.foreach_set(flat.reshape(-1))
    image.filepath_raw = path
    image.file_format = "PNG"
    image.save()
    bpy.data.images.remove(image)
    return path


def texture_dir() -> str:
    return os.path.dirname(prod("textures", "keep"))


def paths_for(name: str) -> dict[str, str]:
    return {
        "albedo": prod("textures", f"kit_{name}_albedo.png"),
        "normal": prod("textures", f"kit_{name}_normal.png"),
        "orm": prod("textures", f"kit_{name}_orm.png"),
    }


def generate() -> dict[str, dict[str, str]]:
    written: dict[str, dict[str, str]] = {}
    for index, (name, builder) in enumerate(BUILDERS.items()):
        rng = np.random.default_rng(SEED + index * 977)
        albedo, height, strength, ao, rough, metal = builder(rng)
        normal = normal_from_height(height, strength)
        orm = np.stack([np.clip(ao, 0.0, 1.0),
                        np.clip(rough, 0.0, 1.0),
                        np.clip(metal, 0.0, 1.0)], axis=-1)
        out = paths_for(name)
        save_png(out["albedo"], srgb_to_linear(albedo), "sRGB")
        save_png(out["normal"], normal, "Non-Color")
        save_png(out["orm"], orm, "Non-Color")
        written[name] = out
        mean = (albedo.reshape(-1, 3).mean(axis=0) * 255).round().astype(int)
        print(f"[textures] {name:7s} mean albedo #{mean[0]:02x}{mean[1]:02x}{mean[2]:02x} "
              f"rough {rough.mean():.2f} metal {metal.mean():.2f} "
              f"{RES}x{RES} @ {TEXELS_PER_METRE:.0f} texels/m")
    return written


if __name__ == "__main__":
    generate()
    print(f"[textures] {len(BUILDERS)} materials written to {texture_dir()}")
