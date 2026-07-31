//! Deterministic, tileable PBR surface library for world-space terrain shading.

use super::terrain::Biome;

pub const TILE_SIZE: u32 = 256;
pub const SURFACE_COUNT: u32 = 3;
pub const VARIANTS_PER_SURFACE: u32 = 4;
pub const TILE_LAYERS: u32 = SURFACE_COUNT * VARIANTS_PER_SURFACE;

#[derive(Debug)]
pub struct TerrainTiles {
    /// sRGB albedo, tightly packed by array layer.
    pub albedo: Vec<u8>,
    /// Linear normal XY, roughness, AO, tightly packed by array layer.
    pub nrma: Vec<u8>,
}

#[derive(Clone, Copy)]
struct Surface {
    color: [f32; 3],
    roughness: [f32; 2],
    relief: f32,
    grain: f32,
}

const DESERT: [Surface; 3] = [
    Surface {
        color: [0.72, 0.49, 0.22],
        roughness: [0.78, 0.94],
        relief: 0.75,
        grain: 0.55,
    },
    Surface {
        color: [0.64, 0.44, 0.20],
        roughness: [0.66, 0.90],
        relief: 1.10,
        grain: 0.95,
    },
    Surface {
        color: [0.76, 0.56, 0.31],
        roughness: [0.48, 0.82],
        relief: 1.30,
        grain: 0.34,
    },
];

const FOREST: [Surface; 3] = [
    Surface {
        color: [0.38, 0.50, 0.22],
        roughness: [0.84, 0.98],
        relief: 0.80,
        grain: 0.80,
    },
    Surface {
        color: [0.45, 0.38, 0.20],
        roughness: [0.72, 0.94],
        relief: 1.20,
        grain: 0.92,
    },
    Surface {
        color: [0.39, 0.31, 0.18],
        roughness: [0.38, 0.70],
        relief: 0.95,
        grain: 0.46,
    },
];

pub fn generate_terrain_tiles(biome: Biome) -> TerrainTiles {
    let texels = (TILE_SIZE * TILE_SIZE * TILE_LAYERS) as usize;
    let mut albedo = vec![0u8; texels * 4];
    let mut nrma = vec![0u8; texels * 4];
    let surfaces = match biome {
        Biome::Desert => &DESERT,
        Biome::Forest => &FOREST,
    };
    for (surface_index, surface) in surfaces.iter().copied().enumerate() {
        for variant in 0..VARIANTS_PER_SURFACE as usize {
            let layer = surface_index * VARIANTS_PER_SURFACE as usize + variant;
            let seed = 0x9e37_79b9_u32
                ^ (surface_index as u32).wrapping_mul(0x85eb_ca6b)
                ^ (variant as u32).wrapping_mul(0xc2b2_ae35)
                ^ if biome == Biome::Forest {
                    0x4f31_8d22
                } else {
                    0x2b01_5107
                };
            for y in 0..TILE_SIZE {
                for x in 0..TILE_SIZE {
                    let height = surface_height(seed, x as i32, y as i32, surface);
                    let hx0 = surface_height(seed, x as i32 - 1, y as i32, surface);
                    let hx1 = surface_height(seed, x as i32 + 1, y as i32, surface);
                    let hy0 = surface_height(seed, x as i32, y as i32 - 1, surface);
                    let hy1 = surface_height(seed, x as i32, y as i32 + 1, surface);
                    let dx = (hx1 - hx0) * surface.relief;
                    let dy = (hy1 - hy0) * surface.relief;
                    let inv = (dx * dx + dy * dy + 1.0).sqrt().recip();
                    let nx = -dx * inv;
                    let ny = -dy * inv;
                    let variation = 0.65 + height * 0.70;
                    let rough_mix = periodic_noise(seed ^ 0xa511_e9b3, x as i32, y as i32, 37);
                    let roughness = surface.roughness[0]
                        + (surface.roughness[1] - surface.roughness[0]) * rough_mix;
                    let cavity = ((hx0 + hx1 + hy0 + hy1) * 0.25 - height).max(0.0);
                    let ao = (1.0 - cavity * 0.8).clamp(0.62, 1.0);
                    let offset = (layer * (TILE_SIZE * TILE_SIZE) as usize
                        + (y * TILE_SIZE + x) as usize)
                        * 4;
                    for channel in 0..3 {
                        albedo[offset + channel] = to_byte(surface.color[channel] * variation);
                    }
                    albedo[offset + 3] = 255;
                    nrma[offset] = to_byte(nx * 0.5 + 0.5);
                    nrma[offset + 1] = to_byte(ny * 0.5 + 0.5);
                    nrma[offset + 2] = to_byte(roughness);
                    nrma[offset + 3] = to_byte(ao);
                }
            }
        }
    }
    TerrainTiles { albedo, nrma }
}

fn surface_height(seed: u32, x: i32, y: i32, surface: Surface) -> f32 {
    let size = TILE_SIZE as i32;
    let x = x.rem_euclid(size);
    let y = y.rem_euclid(size);
    let grit = hash01(seed, x, y) - 0.5;
    let fine = periodic_noise(seed ^ 0x7f4a_7c15, x, y, 61) - 0.5;
    let grain = periodic_noise(seed ^ 0xa511_e9b3, x, y, 29) - 0.5;
    let broad = periodic_noise(seed ^ 0x63d8_35f1, x, y, 11) - 0.5;
    (0.5 + grit * surface.grain * 0.10
        + fine * surface.grain * 0.24
        + grain * surface.grain * 0.32
        + broad * 0.12)
        .clamp(0.0, 1.0)
}

fn periodic_noise(seed: u32, x: i32, y: i32, period: i32) -> f32 {
    let size = TILE_SIZE as f32;
    let px = x.rem_euclid(TILE_SIZE as i32) as f32 / size * period as f32;
    let py = y.rem_euclid(TILE_SIZE as i32) as f32 / size * period as f32;
    let gx = px.floor() as i32;
    let gy = py.floor() as i32;
    let tx = px - gx as f32;
    let ty = py - gy as f32;
    let sx = tx * tx * (3.0 - 2.0 * tx);
    let sy = ty * ty * (3.0 - 2.0 * ty);
    let x0 = gx.rem_euclid(period);
    let y0 = gy.rem_euclid(period);
    let x1 = (gx + 1).rem_euclid(period);
    let y1 = (gy + 1).rem_euclid(period);
    let a = hash01(seed, x0, y0);
    let b = hash01(seed, x1, y0);
    let c = hash01(seed, x0, y1);
    let d = hash01(seed, x1, y1);
    let top = a + (b - a) * sx;
    let bottom = c + (d - c) * sx;
    top + (bottom - top) * sy
}

fn hash01(seed: u32, x: i32, y: i32) -> f32 {
    let mut value =
        seed ^ (x as u32).wrapping_mul(0x27d4_eb2d) ^ (y as u32).wrapping_mul(0x1656_67b1);
    value = (value ^ (value >> 15)).wrapping_mul(0x2c1b_3c6d);
    value = (value ^ (value >> 12)).wrapping_mul(0x297a_2d39);
    (value ^ (value >> 15)) as f32 / u32::MAX as f32
}

fn to_byte(value: f32) -> u8 {
    (value.clamp(0.0, 1.0) * 255.0 + 0.5) as u8
}

#[derive(Clone, Copy, Debug)]
pub struct TerrainProbe {
    pub luma_mean: f64,
    pub luma_stddev: f64,
    pub neighbor_delta: f64,
}

pub fn probe_rgba(rgba: &[u8], width: u32, height: u32) -> Result<TerrainProbe, String> {
    if rgba.len() != (width * height * 4) as usize || width < 2 || height < 2 {
        return Err("terrain probe received invalid framebuffer".to_string());
    }
    let y_start = height / 2;
    let mut count = 0.0f64;
    let mut sum = 0.0f64;
    let mut sum2 = 0.0f64;
    let mut neighbor_delta = 0.0f64;
    let mut neighbor_count = 0.0f64;
    for y in y_start..height {
        for x in 0..width {
            let offset = ((y * width + x) * 4) as usize;
            let luma = pixel_luma(rgba, offset);
            sum += luma;
            sum2 += luma * luma;
            count += 1.0;
            if x > 0 {
                neighbor_delta += (luma - pixel_luma(rgba, offset - 4)).abs();
                neighbor_count += 1.0;
            }
        }
    }
    let mean = sum / count;
    let probe = TerrainProbe {
        luma_mean: mean,
        luma_stddev: (sum2 / count - mean * mean).max(0.0).sqrt(),
        neighbor_delta: neighbor_delta / neighbor_count,
    };
    if probe.luma_stddev < 0.025 {
        return Err("terrain lacks macro/material variation".to_string());
    }
    if probe.neighbor_delta < 0.0005 {
        return Err("terrain lacks close surface detail".to_string());
    }
    if probe.neighbor_delta > 0.08 {
        return Err("terrain detail aliases excessively".to_string());
    }
    Ok(probe)
}

fn pixel_luma(rgba: &[u8], offset: usize) -> f64 {
    (rgba[offset] as f64 * 0.299
        + rgba[offset + 1] as f64 * 0.587
        + rgba[offset + 2] as f64 * 0.114)
        / 255.0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tile_generation_is_deterministic_and_complete() {
        let first = generate_terrain_tiles(Biome::Desert);
        let second = generate_terrain_tiles(Biome::Desert);
        assert_eq!(first.albedo, second.albedo);
        assert_eq!(first.nrma, second.nrma);
        let expected = (TILE_SIZE * TILE_SIZE * TILE_LAYERS * 4) as usize;
        assert_eq!(first.albedo.len(), expected);
        assert_eq!(first.nrma.len(), expected);
    }

    #[test]
    fn desert_and_forest_libraries_are_distinct() {
        let desert = generate_terrain_tiles(Biome::Desert);
        let forest = generate_terrain_tiles(Biome::Forest);
        assert_ne!(desert.albedo, forest.albedo);
    }

    #[test]
    fn normal_roughness_ao_channels_stay_physical() {
        let tiles = generate_terrain_tiles(Biome::Forest);
        for texel in tiles.nrma.chunks_exact(4) {
            let nx = texel[0] as f32 / 255.0 * 2.0 - 1.0;
            let ny = texel[1] as f32 / 255.0 * 2.0 - 1.0;
            assert!(nx * nx + ny * ny <= 1.01);
            assert!((90..=252).contains(&texel[2]));
            assert!((158..=255).contains(&texel[3]));
        }
    }

    #[test]
    fn height_function_wraps_at_tile_edges() {
        let surface = DESERT[0];
        assert_eq!(
            surface_height(7, 0, 19, surface),
            surface_height(7, TILE_SIZE as i32, 19, surface)
        );
        assert_eq!(
            surface_height(7, 27, 0, surface),
            surface_height(7, 27, TILE_SIZE as i32, surface)
        );
    }
}
