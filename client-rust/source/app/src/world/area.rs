//! Active-area resolution — exact port of the seed/biome derivation in
//! `client-3d/src/render/terrain/TerrainStreamer.ts` (`worldSeedFromSlice`,
//! `mixWorldSeedWithArea`, `biomeIdFromSliceArea`). The connected scene must
//! render the *streamed* area, so terrain seed and biome are always derived
//! from the accepted snapshot's active area id + the checked-in map bundle —
//! never hard-coded.

use successor_engine_core::json::Json;

use super::terrain::Biome;

/// `SUCCESSOR_3D_CONFIG.terrain.fallbackWorldSeed`.
pub const FALLBACK_WORLD_SEED: u32 = 0x0d3d_071e;

/// FNV-1a over UTF-16 code units (area ids are ASCII, so bytes == charCodes).
/// Mirrors the TS `fnv1a32` including `Math.imul` wrapping semantics.
pub fn fnv1a32(value: &str) -> u32 {
    let mut hash: u32 = 0x811c_9dc5;
    for unit in value.encode_utf16() {
        hash ^= unit as u32;
        hash = hash.wrapping_mul(0x0100_0193);
    }
    hash
}

/// TS `avalanche32` (two multiply-xorshift rounds).
pub fn avalanche32(value: u32) -> u32 {
    let mut hash = value;
    hash = (hash ^ (hash >> 16)).wrapping_mul(0x7feb_352d);
    hash = (hash ^ (hash >> 15)).wrapping_mul(0x846c_a68b);
    hash ^ (hash >> 16)
}

/// The anchor hash the TS streamer salts every area id against.
fn ashvat_area_seed_hash() -> u32 {
    fnv1a32("open-desert-overworld")
}

/// `worldSeedFromSlice`: the slice's finite `worldSeed`, else the fallback.
pub fn world_seed_from_slice(slice: &Json) -> u32 {
    match slice.get("worldSeed").and_then(Json::as_f64) {
        Some(seed) if seed.is_finite() => seed.trunc() as i64 as u32,
        _ => FALLBACK_WORLD_SEED,
    }
}

/// `mixWorldSeedWithArea`: XOR the slice seed with the avalanche of the area
/// hash relative to the anchor area. The anchor area itself keeps the raw
/// slice seed (salt is zero), preserving the shipped desert look.
pub fn mix_world_seed_with_area(slice_world_seed: u32, area_id: &str) -> u32 {
    let area_salt = avalanche32(fnv1a32(area_id) ^ ashvat_area_seed_hash());
    slice_world_seed ^ area_salt
}

/// `effectiveWorldSeedFromSliceArea`.
pub fn effective_world_seed(slice: &Json, area_id: &str) -> u32 {
    mix_world_seed_with_area(world_seed_from_slice(slice), area_id)
}

/// `biomeIdFromSliceArea`: the area's authored biome from `slice.areas`, else
/// a case-insensitive `forest` substring fallback, else desert.
pub fn biome_for_area(slice: &Json, area_id: &str) -> Biome {
    if let Some(areas) = slice.get("areas").and_then(Json::as_array) {
        for area in areas {
            if area.get("id").and_then(Json::as_str) != Some(area_id) {
                continue;
            }
            return match area.get("biome").and_then(Json::as_str) {
                Some("forest") => Biome::Forest,
                Some("desert") => Biome::Desert,
                _ => fallback_biome(area_id),
            };
        }
    }
    fallback_biome(area_id)
}

fn fallback_biome(area_id: &str) -> Biome {
    if area_id.to_ascii_lowercase().contains("forest") {
        Biome::Forest
    } else {
        Biome::Desert
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Reference values computed from the TS implementation (Math.imul
    // semantics) for the shipped slice (`worldSeed` 424242) and both areas.
    #[test]
    fn fnv_matches_ts_reference() {
        assert_eq!(fnv1a32("open-desert-overworld"), 0xe703_dab6);
        assert_eq!(fnv1a32("verdance-forest-overworld"), 0x5019_74ca);
    }

    #[test]
    fn anchor_area_keeps_slice_seed() {
        // avalanche(0) == 0, so the anchor area's salt vanishes.
        assert_eq!(avalanche32(0), 0);
        assert_eq!(
            mix_world_seed_with_area(424_242, "open-desert-overworld"),
            424_242
        );
    }

    #[test]
    fn forest_area_seed_matches_ts_reference() {
        assert_eq!(
            mix_world_seed_with_area(424_242, "verdance-forest-overworld"),
            0xb0d2_cb4f
        );
    }

    #[test]
    fn seed_from_slice_and_fallback() {
        let slice = Json::parse(r#"{ "worldSeed": 424242 }"#).unwrap();
        assert_eq!(world_seed_from_slice(&slice), 424_242);
        let empty = Json::parse("{}").unwrap();
        assert_eq!(world_seed_from_slice(&empty), FALLBACK_WORLD_SEED);
    }

    #[test]
    fn biome_lookup_and_substring_fallback() {
        let slice = Json::parse(
            r#"{ "areas": [
                { "id": "open-desert-overworld", "biome": "desert" },
                { "id": "verdance-forest-overworld", "biome": "forest" }
            ] }"#,
        )
        .unwrap();
        assert_eq!(
            biome_for_area(&slice, "open-desert-overworld"),
            Biome::Desert
        );
        assert_eq!(
            biome_for_area(&slice, "verdance-forest-overworld"),
            Biome::Forest
        );
        // Unknown area: substring fallback.
        assert_eq!(biome_for_area(&slice, "deep-FOREST-test"), Biome::Forest);
        assert_eq!(biome_for_area(&slice, "salt-flats"), Biome::Desert);
    }
}
