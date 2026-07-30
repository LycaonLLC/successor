// Benchmark harness: measures AOI spatial-index wall-clock throughput via
// Instant::now. Not part of the deterministic tick; not compiled into wasm32.
#![allow(clippy::disallowed_methods)]
use std::time::Instant;

use serde::Serialize;
use successor_core::{
    AoiPriorityRing, AoiRadii, CellCoord2, EntityId, Level, SpatialCategory, SpatialEntry,
    SpatialIndex, SpatialOccupancyKind, ZoneCell, ZoneId,
};

const PLAYER_COUNT: u32 = 1_000;
const PROP_COUNT: u32 = 240;
const ZONE_WIDTH: i32 = 96;
const ZONE_HEIGHT: i32 = 64;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct BenchOutput {
    schema: &'static str,
    config: BenchConfig,
    aoi: AoiStats,
    snapshot: SnapshotBudgetStats,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct BenchConfig {
    players: u32,
    props: u32,
    zone_width: i32,
    zone_height: i32,
    radii: RadiiOutput,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RadiiOutput {
    high: u32,
    nearby: u32,
    interactable: u32,
    far: u32,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AoiStats {
    observers: u32,
    total_entries: u64,
    p50_entries: u32,
    p95_entries: u32,
    max_entries: u32,
    p50_query_ms: f64,
    p95_query_ms: f64,
    max_query_ms: f64,
    total_query_ms: f64,
    index_hash: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SnapshotBudgetStats {
    p50_bytes: u32,
    p95_bytes: u32,
    max_bytes: u32,
    p95_bytes_per_second_at_20hz: u32,
    p95_bytes_per_second_degraded: u32,
    budgeted_p95_target_bytes_per_second: u32,
    budgeted_p95_passes: bool,
}

fn main() {
    let zone = ZoneId(1);
    let level = Level(0);
    let radii = AoiRadii::new(3, 6, 8, 10);
    let mut index = SpatialIndex::new();
    let mut observers = Vec::new();

    for player_index in 0..PLAYER_COUNT {
        let entity = EntityId::first(player_index + 1);
        observers.push(entity);
        index.insert(SpatialEntry::new(
            entity,
            ZoneCell::new(zone, level, player_coord(player_index)),
            if player_index == 0 {
                SpatialCategory::Player
            } else {
                SpatialCategory::Npc
            },
            SpatialOccupancyKind::Exclusive,
        ));
    }

    for prop_index in 0..PROP_COUNT {
        let entity = EntityId::first(10_000 + prop_index);
        index.insert(SpatialEntry::new(
            entity,
            ZoneCell::new(zone, level, prop_coord(prop_index)),
            if prop_index % 3 == 0 {
                SpatialCategory::Door
            } else if prop_index % 3 == 1 {
                SpatialCategory::Item
            } else {
                SpatialCategory::CraftingStation
            },
            SpatialOccupancyKind::Interaction,
        ));
    }

    let mut query_ns = Vec::with_capacity(observers.len());
    let mut entry_counts = Vec::with_capacity(observers.len());
    let mut byte_counts = Vec::with_capacity(observers.len());
    let mut budgeted_byte_rates = Vec::with_capacity(observers.len());

    let total_started = Instant::now();
    for observer in observers {
        let started = Instant::now();
        let entries = index.aoi_entries_for(observer, radii);
        query_ns.push(started.elapsed().as_nanos());
        entry_counts.push(u32::try_from(entries.len()).expect("AOI entry count fits u32"));
        byte_counts.push(mock_snapshot_bytes(&entries));
        budgeted_byte_rates.push(mock_snapshot_bytes_per_second_degraded(&entries));
    }
    let total_query_ms = total_started.elapsed().as_secs_f64() * 1_000.0;

    entry_counts.sort_unstable();
    query_ns.sort_unstable();
    byte_counts.sort_unstable();
    budgeted_byte_rates.sort_unstable();

    let p50_bytes = percentile_u32(&byte_counts, 50);
    let p95_bytes = percentile_u32(&byte_counts, 95);
    let p95_budgeted_bps = percentile_u32(&budgeted_byte_rates, 95);
    let budget_target_bps = 16_000;
    let output = BenchOutput {
        schema: "successor.aoi-bench.v1",
        config: BenchConfig {
            players: PLAYER_COUNT,
            props: PROP_COUNT,
            zone_width: ZONE_WIDTH,
            zone_height: ZONE_HEIGHT,
            radii: RadiiOutput {
                high: radii.high,
                nearby: radii.nearby,
                interactable: radii.interactable,
                far: radii.far,
            },
        },
        aoi: AoiStats {
            observers: PLAYER_COUNT,
            total_entries: entry_counts.iter().map(|count| u64::from(*count)).sum(),
            p50_entries: percentile_u32(&entry_counts, 50),
            p95_entries: percentile_u32(&entry_counts, 95),
            max_entries: *entry_counts.last().unwrap_or(&0),
            p50_query_ms: ns_to_ms(percentile_u128(&query_ns, 50)),
            p95_query_ms: ns_to_ms(percentile_u128(&query_ns, 95)),
            max_query_ms: ns_to_ms(*query_ns.last().unwrap_or(&0)),
            total_query_ms: round_ms(total_query_ms),
            index_hash: index.stable_hash_hex(),
        },
        snapshot: SnapshotBudgetStats {
            p50_bytes,
            p95_bytes,
            max_bytes: *byte_counts.last().unwrap_or(&0),
            p95_bytes_per_second_at_20hz: p95_bytes.saturating_mul(20),
            p95_bytes_per_second_degraded: p95_budgeted_bps,
            budgeted_p95_target_bytes_per_second: budget_target_bps,
            budgeted_p95_passes: p95_budgeted_bps <= budget_target_bps,
        },
    };

    println!(
        "{}",
        serde_json::to_string_pretty(&output).expect("benchmark output serializes")
    );
}

fn player_coord(index: u32) -> CellCoord2 {
    let index = i32::try_from(index).expect("player index fits i32");
    CellCoord2::new(
        (index * 17).rem_euclid(ZONE_WIDTH),
        (index * 31).rem_euclid(ZONE_HEIGHT),
    )
}

fn prop_coord(index: u32) -> CellCoord2 {
    let index = i32::try_from(index).expect("prop index fits i32");
    CellCoord2::new(
        (index * 19 + 11).rem_euclid(ZONE_WIDTH),
        (index * 23 + 7).rem_euclid(ZONE_HEIGHT),
    )
}

fn mock_snapshot_bytes(entries: &[successor_core::AoiEntry]) -> u32 {
    entries
        .iter()
        .map(|entry| match entry.ring {
            AoiPriorityRing::SelfState => 112,
            AoiPriorityRing::High => 72,
            AoiPriorityRing::Nearby => 48,
            AoiPriorityRing::Interactable => 28,
            AoiPriorityRing::Far => 20,
        })
        .sum()
}

fn mock_snapshot_bytes_per_second_degraded(entries: &[successor_core::AoiEntry]) -> u32 {
    entries
        .iter()
        .map(|entry| match entry.ring {
            AoiPriorityRing::SelfState => 112 * 20,
            AoiPriorityRing::High => 72 * 20,
            AoiPriorityRing::Nearby => 48 * 10,
            AoiPriorityRing::Interactable => 28 * 2,
            AoiPriorityRing::Far => 20,
        })
        .sum()
}

fn percentile_u32(values: &[u32], percentile: usize) -> u32 {
    values[index_for_percentile(values.len(), percentile)]
}

fn percentile_u128(values: &[u128], percentile: usize) -> u128 {
    values[index_for_percentile(values.len(), percentile)]
}

fn index_for_percentile(len: usize, percentile: usize) -> usize {
    if len == 0 {
        return 0;
    }
    let index = len.saturating_mul(percentile).saturating_div(100);
    index.min(len - 1)
}

fn ns_to_ms(value: u128) -> f64 {
    round_ms(value as f64 / 1_000_000.0)
}

fn round_ms(value: f64) -> f64 {
    (value * 1_000.0).round() / 1_000.0
}
