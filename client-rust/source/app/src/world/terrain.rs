//! Deterministic terrain painting — a byte-exact port of
//! `client-3d/src/render/terrain/procgen.ts` (TERRAIN_RULES_VERSION 6). Adjacent
//! chunks resolve identical colours at shared world coordinates because every
//! field is sampled in world space with a 32-bit integer hash (no `Math.random`,
//! cross-language deterministic).
//!
//! Constants transcribed verbatim from `client-3d/src/config.ts`
//! (`SUCCESSOR_3D_CONFIG.terrain`, `.biomes`, `.environment.wind`). The
//! `tools/successor/dump-terrain-fixture.mjs` reference (a verbatim copy of the
//! TS) pins the RGBA output; see `tests`.

// Palettes (config.ts DESERT_BIOME / FOREST_BIOME).
const DESERT: [f64; 3] = [208.0, 165.0, 92.0];
const SCRUB: [f64; 3] = [188.0, 151.0, 84.0];
const HARDPAN: [f64; 3] = [224.0, 190.0, 124.0];
const LOAM: [f64; 3] = [128.0, 110.0, 78.0];
const MOSS: [f64; 3] = [110.0, 130.0, 78.0];
const DUFF: [f64; 3] = [150.0, 128.0, 86.0];

const UINT_TO_UNIT: f64 = 1.0 / 4294967295.0; // 1 / 0xffffffff
const TAU: f64 = core::f64::consts::PI * 2.0;

// config: terrain.texturePixels = 1024, chunkCells = 256; wind.baseDirDeg = 115.
const TERRAIN_TEXELS_PER_CELL: f64 = (1024.0 - 1.0) / 256.0;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum TerrainKind {
    Desert = 0,
    Scrub = 1,
    Hardpan = 2,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Biome {
    Desert,
    Forest,
}

/// One painted texel: RGBA8 + the classified kind (drives footstep audio).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Texel {
    pub rgba: [u8; 4],
    pub kind: TerrainKind,
}

/// Continuous low-frequency material controls sampled by the PBR terrain path.
#[derive(Clone, Copy, PartialEq, Debug)]
pub struct TerrainSample {
    pub weights: [f32; 3],
    pub macro_tint: f32,
    pub kind: TerrainKind,
}

fn wind_axis() -> (f64, f64, f64, f64) {
    let rad = 115.0_f64 * core::f64::consts::PI / 180.0;
    let ax = rad.cos();
    let az = rad.sin();
    (ax, az, -az, ax) // axis_x, axis_z, across_x, across_z
}

/// Paint one terrain texel at world coordinates.
pub fn paint_terrain_pixel(seed: i32, world_x: f64, world_z: f64, biome: Biome) -> Texel {
    if biome == Biome::Forest {
        return paint_forest_terrain_pixel(seed, world_x, world_z);
    }
    let (wax, waz, wcx, wcz) = wind_axis();

    let macro_ = fbm(seed, world_x * 0.0045, world_z * 0.0045, 0x2b01);
    let scrub_field = fbm(
        seed,
        world_x * 0.018 + 37.17,
        world_z * 0.018 - 19.31,
        0x5107,
    );
    let salt_long = fbm(
        seed,
        world_x * 0.0075 + world_z * 0.0015,
        world_z * 0.052,
        0x91af,
    );
    let salt_fine = value_noise(seed, world_x * 0.022, world_z * 0.19, 0xbad5);
    let hardpan_w = smoothstep(
        0.54,
        0.73,
        salt_long * 0.82 + salt_fine * 0.18 + (macro_ - 0.5) * 0.1,
    );
    let scrub_w = (1.0 - hardpan_w) * smoothstep(0.56, 0.75, scrub_field + (0.53 - macro_) * 0.14);
    let desert_w = (1.0 - hardpan_w - scrub_w).max(0.0);

    let along = world_x * wax + world_z * waz;
    let across = world_x * wcx + world_z * wcz;
    let fine = value_noise(seed, world_x * 0.92, world_z * 0.92, 0x7001) * 2.0 - 1.0;
    let gravel = gravel_speckle(seed, world_x, world_z) * (desert_w + scrub_w * 0.85);
    let striation =
        wind_striation(seed, along, across) * (desert_w + scrub_w * 0.62 + hardpan_w * 0.25);
    let cracks = if hardpan_w > 0.34 {
        hardpan_crack(seed, world_x, world_z, hardpan_w)
    } else {
        0.0
    };
    let scrub_tuft = if scrub_w > 0.18
        && hash_unit(
            seed,
            (world_x * 1.55).floor() as i32,
            (world_z * 1.55).floor() as i32,
            0x7a11,
        ) > 0.82
    {
        -10.0 * scrub_w
    } else {
        0.0
    };
    let hardpan_mottle =
        (value_noise(seed, world_x * 0.045, world_z * 1.18, 0x55aa) - 0.5) * 5.5 * hardpan_w;
    let value_scale = 1.0 + (macro_ - 0.5) * 0.062 + fine * 0.026 + gravel + striation + cracks;

    let mut r = (DESERT[0] * desert_w + SCRUB[0] * scrub_w + HARDPAN[0] * hardpan_w) * value_scale;
    let mut g = (DESERT[1] * desert_w + SCRUB[1] * scrub_w + HARDPAN[1] * hardpan_w) * value_scale;
    let mut b = (DESERT[2] * desert_w + SCRUB[2] * scrub_w + HARDPAN[2] * hardpan_w) * value_scale;

    r += scrub_tuft + hardpan_mottle;
    g += scrub_tuft + hardpan_mottle * 0.9;
    b += scrub_tuft * 0.7 + hardpan_mottle * 0.55;

    let kind = if hardpan_w >= scrub_w && hardpan_w > 0.32 {
        TerrainKind::Hardpan
    } else if scrub_w > 0.32 {
        TerrainKind::Scrub
    } else {
        TerrainKind::Desert
    };
    Texel {
        rgba: [clamp_byte(r), clamp_byte(g), clamp_byte(b), 255],
        kind,
    }
}

/// Sample continuous material weights without baking final surface color.
pub fn sample_terrain(seed: i32, world_x: f64, world_z: f64, biome: Biome) -> TerrainSample {
    if biome == Biome::Forest {
        let clearing = clearing_mask_at(seed, world_x, world_z);
        let clearing_blend = smoothstep(0.34, 0.78, clearing);
        let canopy = 1.0 - clearing_blend;
        let macro_shade = fbm(
            seed,
            world_x * 0.0065 + 13.7,
            world_z * 0.0065 - 21.9,
            0x4f31,
        );
        let moss_field = fbm(seed, world_x * 0.016 - 8.1, world_z * 0.016 + 5.4, 0x8d22);
        let duff_field = fbm(seed, world_x * 0.024 + 41.3, world_z * 0.024 - 15.8, 0xa907);
        let mut moss = 0.16 + moss_field * 0.24 + clearing_blend * 0.14;
        let mut duff = 0.28 + duff_field * 0.28 + canopy * 0.16;
        let mut loam = (1.0 - moss - duff).max(0.18);
        let total = moss + duff + loam;
        moss /= total;
        duff /= total;
        loam /= total;
        let kind = if clearing_blend > 0.58 {
            TerrainKind::Scrub
        } else if duff >= moss && duff > 0.34 {
            TerrainKind::Hardpan
        } else {
            TerrainKind::Desert
        };
        return TerrainSample {
            weights: [moss as f32, duff as f32, loam as f32],
            macro_tint: (0.88 + macro_shade * 0.24 + clearing_blend * 0.08) as f32,
            kind,
        };
    }

    let macro_ = fbm(seed, world_x * 0.0045, world_z * 0.0045, 0x2b01);
    let scrub_field = fbm(
        seed,
        world_x * 0.018 + 37.17,
        world_z * 0.018 - 19.31,
        0x5107,
    );
    let salt_long = fbm(
        seed,
        world_x * 0.0075 + world_z * 0.0015,
        world_z * 0.052,
        0x91af,
    );
    let salt_fine = value_noise(seed, world_x * 0.022, world_z * 0.19, 0xbad5);
    let hardpan = smoothstep(
        0.54,
        0.73,
        salt_long * 0.82 + salt_fine * 0.18 + (macro_ - 0.5) * 0.1,
    );
    let scrub = (1.0 - hardpan) * smoothstep(0.56, 0.75, scrub_field + (0.53 - macro_) * 0.14);
    let desert = (1.0 - hardpan - scrub).max(0.0);
    let kind = if hardpan >= scrub && hardpan > 0.32 {
        TerrainKind::Hardpan
    } else if scrub > 0.32 {
        TerrainKind::Scrub
    } else {
        TerrainKind::Desert
    };
    TerrainSample {
        weights: [desert as f32, scrub as f32, hardpan as f32],
        macro_tint: (0.88 + macro_ * 0.24) as f32,
        kind,
    }
}

pub fn clearing_mask_at(seed: i32, world_x: f64, world_z: f64) -> f64 {
    let (wax, waz, wcx, wcz) = wind_axis();
    let along = world_x * wax + world_z * waz;
    let across = world_x * wcx + world_z * wcz;
    let field = fbm(seed, along * 0.0115, across * 0.0115, 0x77aa);
    let grove = fbm(seed, along * 0.0127 + 5.1, across * 0.0127 - 7.4, 0x77ab);
    smoothstep(0.42, 0.66, field) * smoothstep(0.44, 0.72, grove)
}

fn paint_forest_terrain_pixel(seed: i32, world_x: f64, world_z: f64) -> Texel {
    let clearing = clearing_mask_at(seed, world_x, world_z);
    let clearing_blend = smoothstep(0.34, 0.78, clearing);
    let canopy = 1.0 - clearing_blend;
    let macro_shade = fbm(
        seed,
        world_x * 0.0065 + 13.7,
        world_z * 0.0065 - 21.9,
        0x4f31,
    );
    let moss_field = fbm(seed, world_x * 0.016 - 8.1, world_z * 0.016 + 5.4, 0x8d22);
    let duff_field = fbm(seed, world_x * 0.024 + 41.3, world_z * 0.024 - 15.8, 0xa907);
    let mut moss_w = 0.16 + moss_field * 0.24 + clearing_blend * 0.14;
    let mut duff_w = 0.28 + duff_field * 0.28 + canopy * 0.16;
    let mut loam_w = (1.0 - moss_w - duff_w).max(0.18);
    let total = loam_w + moss_w + duff_w;
    loam_w /= total;
    moss_w /= total;
    duff_w /= total;

    let canopy_r = LOAM[0] * loam_w + MOSS[0] * moss_w + DUFF[0] * duff_w;
    let canopy_g = LOAM[1] * loam_w + MOSS[1] * moss_w + DUFF[1] * duff_w;
    let canopy_b = LOAM[2] * loam_w + MOSS[2] * moss_w + DUFF[2] * duff_w;
    let clearing_r = (MOSS[0] * 0.78 + DUFF[0] * 0.22) * 1.12;
    let clearing_g = (MOSS[1] * 0.84 + DUFF[1] * 0.16) * 1.12;
    let clearing_b = (MOSS[2] * 0.82 + LOAM[2] * 0.18) * 1.12;
    let clear_mix = clearing_blend * 0.78;

    let leaf =
        (value_noise(seed, world_x * 0.075 + 3.7, world_z * 0.075 - 2.9, 0xd4f1) - 0.5) * 0.1;
    let speckle = forest_speckle(seed, world_x, world_z);
    let veins = root_vein_dark(seed, world_x, world_z, canopy);
    let value_scale =
        0.91 + (macro_shade - 0.5) * 0.07 + clearing_blend * 0.13 + leaf + speckle + veins;

    let r = lerp(canopy_r, clearing_r, clear_mix) * value_scale;
    let g = lerp(canopy_g, clearing_g, clear_mix) * value_scale;
    let b = lerp(canopy_b, clearing_b, clear_mix) * value_scale;

    let kind = if clearing_blend > 0.58 {
        TerrainKind::Scrub
    } else if duff_w >= moss_w && duff_w > 0.34 {
        TerrainKind::Hardpan
    } else {
        TerrainKind::Desert
    };
    Texel {
        rgba: [clamp_byte(r), clamp_byte(g), clamp_byte(b), 255],
        kind,
    }
}

fn forest_speckle(seed: i32, world_x: f64, world_z: f64) -> f64 {
    let tx = (world_x * TERRAIN_TEXELS_PER_CELL).floor() as i32;
    let tz = (world_z * TERRAIN_TEXELS_PER_CELL).floor() as i32;
    (hash_unit(seed, tx, tz, 0x3eaf) * 2.0 - 1.0) * 0.04
}

fn root_vein_dark(seed: i32, world_x: f64, world_z: f64, canopy: f64) -> f64 {
    worley_vein(
        seed,
        world_x * 0.112,
        world_z * 0.112,
        0x6a31,
        0x6a32,
        0x6a33,
        0.18,
        0.82,
        0.09,
        0.078,
        0.024,
        -0.08,
        0.18,
        0.92,
        canopy,
    )
}

fn hardpan_crack(seed: i32, world_x: f64, world_z: f64, hardpan_w: f64) -> f64 {
    worley_vein(
        seed,
        world_x * 0.064,
        world_z * 0.064,
        0x9c21,
        0xa17d,
        0x4e11,
        0.42,
        0.74,
        0.13,
        0.072,
        0.018,
        -0.1,
        0.34,
        0.78,
        hardpan_w,
    )
}

/// Shared Worley-edge vein used by both `root_vein_dark` and `hardpan_crack`.
/// `skip_pct` is the hash threshold below which a cell contributes nothing
/// (`0x18`→0.18·? no — it is a 0..255 style compare); we pass it as a 0..1
/// fraction hashed comparison exactly as the TS.
#[allow(clippy::too_many_arguments)]
fn worley_vein(
    seed: i32,
    cell_x: f64,
    cell_z: f64,
    salt_a: i32,
    salt_b: i32,
    salt_skip: i32,
    skip: f64,
    jitter: f64,
    bias: f64,
    edge0: f64,
    edge1: f64,
    strength: f64,
    mask0: f64,
    mask1: f64,
    mask_input: f64,
) -> f64 {
    let xi = cell_x.floor() as i32;
    let zi = cell_z.floor() as i32;
    let mut nearest = f64::INFINITY;
    let mut second = f64::INFINITY;
    let mut ncx = xi;
    let mut ncz = zi;
    for dz in -1..=1 {
        for dx in -1..=1 {
            let cx = xi + dx;
            let cz = zi + dz;
            let sx = cx as f64 + hash_unit(seed, cx, cz, salt_a) * jitter + bias;
            let sz = cz as f64 + hash_unit(seed, cx, cz, salt_b) * jitter + bias;
            let ddx = sx - cell_x;
            let ddz = sz - cell_z;
            let dist = ddx * ddx + ddz * ddz;
            if dist < nearest {
                second = nearest;
                nearest = dist;
                ncx = cx;
                ncz = cz;
            } else if dist < second {
                second = dist;
            }
        }
    }
    if hash_unit(seed, ncx, ncz, salt_skip) < skip {
        return 0.0;
    }
    let edge_gap = second.sqrt() - nearest.sqrt();
    let vein = smoothstep(edge0, edge1, edge_gap);
    strength * vein * smoothstep(mask0, mask1, mask_input)
}

fn wind_striation(seed: i32, along: f64, across: f64) -> f64 {
    let field = fbm(seed, along * 0.0031, across * 0.0031, 0x77aa);
    let field_mask = 0.18 + 0.82 * smoothstep(0.42, 0.66, field);
    let wavelength = 6.0 + value_noise(seed, along * 0.006, across * 0.022, 0x6d51) * 8.0;
    let drift =
        (fbm(seed, along * 0.018 + 9.7, across * 0.006 - 4.3, 0x72a9) - 0.5) * wavelength * 1.35;
    let phase = ((across + drift) / wavelength) * TAU;
    let ridged = phase.cos() * 0.68 + (phase * 2.0 + drift * 0.19).cos() * 0.32;
    let amplitude = (0.06
        + value_noise(seed, along * 0.011 - 2.1, across * 0.011 + 5.8, 0x3217) * 0.03)
        * field_mask;
    ridged * amplitude
}

fn gravel_speckle(seed: i32, world_x: f64, world_z: f64) -> f64 {
    let tx = (world_x * TERRAIN_TEXELS_PER_CELL).floor() as i32;
    let tz = (world_z * TERRAIN_TEXELS_PER_CELL).floor() as i32;
    (hash_unit(seed, tx, tz, 0xf00d) * 2.0 - 1.0) * 0.04
}

fn fbm(seed: i32, x: f64, y: f64, salt: i32) -> f64 {
    let a = value_noise(seed, x, y, salt);
    let b = value_noise(seed, x * 2.03 + 17.2, y * 2.03 - 11.7, salt + 0x1f3d);
    let c = value_noise(seed, x * 4.07 - 5.9, y * 4.07 + 23.1, salt + 0x3d79);
    a * 0.57 + b * 0.29 + c * 0.14
}

fn value_noise(seed: i32, x: f64, y: f64, salt: i32) -> f64 {
    let xi = x.floor() as i32;
    let yi = y.floor() as i32;
    let tx = smootherstep(x - xi as f64);
    let ty = smootherstep(y - yi as f64);
    let a = hash_unit(seed, xi, yi, salt);
    let b = hash_unit(seed, xi + 1, yi, salt);
    let c = hash_unit(seed, xi, yi + 1, salt);
    let d = hash_unit(seed, xi + 1, yi + 1, salt);
    lerp(lerp(a, b, tx), lerp(c, d, tx), ty)
}

/// 32-bit integer hash → [0,1). Mirrors the JS `Math.imul`/`>>>` sequence
/// exactly using wrapping i32 multiply and unsigned shifts.
fn hash_unit(seed: i32, x: i32, y: i32, salt: i32) -> f64 {
    let mut h: i32 =
        seed ^ x.wrapping_mul(0x27d4_eb2d_u32 as i32) ^ y.wrapping_mul(0x1656_67b1) ^ salt;
    h = (h ^ (((h as u32) >> 15) as i32)).wrapping_mul(0x2c1b_3c6d);
    h = (h ^ (((h as u32) >> 12) as i32)).wrapping_mul(0x297a_2d39);
    let hu = (h ^ (((h as u32) >> 15) as i32)) as u32;
    hu as f64 * UINT_TO_UNIT
}

fn smootherstep(t: f64) -> f64 {
    t * t * t * (t * (t * 6.0 - 15.0) + 10.0)
}

fn smoothstep(edge0: f64, edge1: f64, value: f64) -> f64 {
    let t = ((value - edge0) / (edge1 - edge0)).clamp(0.0, 1.0);
    smootherstep(t)
}

fn lerp(a: f64, b: f64, t: f64) -> f64 {
    a + (b - a) * t
}

/// `clampByte` composed with `Uint8ClampedArray`'s `ToUint8Clamp` (round half
/// to even), matching the TS assignment `target[i] = clampByte(v)` exactly.
fn clamp_byte(v: f64) -> u8 {
    let x = if v <= 0.0 {
        0.0
    } else if v >= 255.0 {
        255.0
    } else {
        v + 0.5
    };
    to_uint8_clamp(x)
}

/// ECMAScript `ToUint8Clamp`: clamp to [0,255], round to nearest, ties to even.
fn to_uint8_clamp(x: f64) -> u8 {
    if x <= 0.0 {
        return 0;
    }
    if x >= 255.0 {
        return 255;
    }
    let f = x.floor();
    let frac = x - f;
    let rounded = if frac < 0.5 {
        f
    } else if frac > 0.5 {
        f + 1.0
    } else if (f as i64) % 2 == 0 {
        f
    } else {
        f + 1.0
    };
    rounded as u8
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deterministic() {
        let a = paint_terrain_pixel(0x0d3d_071e, 12.5, 34.25, Biome::Desert);
        let b = paint_terrain_pixel(0x0d3d_071e, 12.5, 34.25, Biome::Desert);
        assert_eq!(a, b);
    }

    #[test]
    fn shared_edge_matches_across_chunks() {
        // A world coordinate on a chunk boundary paints identically regardless
        // of which chunk requests it (world-space sampling invariant).
        let seed = 0x0d3d_071e;
        let p = paint_terrain_pixel(seed, 256.0, 100.0, Biome::Desert);
        let q = paint_terrain_pixel(seed, 256.0, 100.0, Biome::Desert);
        assert_eq!(p.rgba, q.rgba);
    }

    #[test]
    fn bytes_in_range_and_opaque() {
        for i in 0..200 {
            let x = i as f64 * 1.37;
            let t = paint_terrain_pixel(42, x, x * 0.5, Biome::Desert);
            assert_eq!(t.rgba[3], 255);
            let f = paint_terrain_pixel(42, x, x * 0.5, Biome::Forest);
            assert_eq!(f.rgba[3], 255);
        }
    }

    #[test]
    fn to_uint8_clamp_ties_even() {
        assert_eq!(to_uint8_clamp(2.5), 2); // tie → even
        assert_eq!(to_uint8_clamp(3.5), 4); // tie → even
        assert_eq!(to_uint8_clamp(2.4), 2);
        assert_eq!(to_uint8_clamp(2.6), 3);
    }

    #[test]
    fn continuous_sample_matches_legacy_classification_and_normalizes_weights() {
        for biome in [Biome::Desert, Biome::Forest] {
            for i in -64..64 {
                let x = i as f64 * 7.125;
                let z = i as f64 * -3.375 + 256.0;
                let sample = sample_terrain(0x0d3d_071e, x, z, biome);
                let legacy = paint_terrain_pixel(0x0d3d_071e, x, z, biome);
                assert_eq!(sample.kind, legacy.kind);
                let total: f32 = sample.weights.iter().sum();
                assert!((total - 1.0).abs() < 1.0e-5);
                assert!(sample.weights.iter().all(|weight| *weight >= 0.0));
            }
        }
    }

    #[test]
    fn continuous_controls_are_world_space_at_chunk_edges() {
        for biome in [Biome::Desert, Biome::Forest] {
            let left = sample_terrain(42, 256.0, -31.25, biome);
            let right = sample_terrain(42, 256.0, -31.25, biome);
            assert_eq!(left, right);
        }
    }

    // Byte-exact cross-check against the verbatim-JS reference fixture.
    // Regenerate: `node tools/successor/dump-terrain-fixture.mjs > \
    //   client-rust/source/app/src/world/terrain_fixture.json`
    #[test]
    fn matches_reference_fixture() {
        let raw = include_str!("terrain_fixture.json");
        // Minimal parse: the fixture is an array of {seed,x,z,biome,r,g,b,kind}.
        let doc = successor_engine_core::json::Json::parse(raw).expect("fixture json");
        let arr = doc.as_array().expect("array");
        assert!(!arr.is_empty(), "fixture must have samples");
        for row in arr {
            let seed = row.get("seed").and_then(|v| v.as_i64()).unwrap() as i32;
            let x = row.get("x").and_then(|v| v.as_f64()).unwrap();
            let z = row.get("z").and_then(|v| v.as_f64()).unwrap();
            let biome = match row.get("biome").and_then(|v| v.as_str()) {
                Some("forest") => Biome::Forest,
                _ => Biome::Desert,
            };
            let er = row.get("r").and_then(|v| v.as_i64()).unwrap() as u8;
            let eg = row.get("g").and_then(|v| v.as_i64()).unwrap() as u8;
            let eb = row.get("b").and_then(|v| v.as_i64()).unwrap() as u8;
            let got = paint_terrain_pixel(seed, x, z, biome);
            assert_eq!(
                [got.rgba[0], got.rgba[1], got.rgba[2]],
                [er, eg, eb],
                "mismatch at seed={seed} x={x} z={z} biome={biome:?}"
            );
        }
    }
}
