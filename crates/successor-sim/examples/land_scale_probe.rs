//! 10K FEASIBILITY SPIKE probe — measures the from_snapshot build cost as the area
//! grows, isolating the O(area) AI-clearance build (the scaling landmine). Resizes
//! the shipped open-desert areas and times the real `from_snapshot`. NOT a scale
//! build — a measurement to inform the owner's call.
// This is a measurement PROBE, not sim authority: wall-clock timing is the point, so the
// deterministic `disallowed_methods` lint (which guards the sim) is intentionally allowed.
#![allow(clippy::disallowed_methods)]
use std::time::Instant;
use successor_sim::{SliceAuthorityState, SliceSnapshot};

fn main() {
    let fixture = include_str!("../../../client/public/successor-slice/open-desert-slice.json");
    let base: SliceSnapshot = serde_json::from_str(fixture).expect("slice parses");
    let n_areas = base.areas.len();
    println!(
        "areas_in_slice={n_areas} (each resized to size^2); collision OFF (blocked_cells empty)"
    );
    println!("size_cells,total_cells_all_areas,from_snapshot_ms,ms_per_million_cells");
    for size in [1024u32, 2048, 3072, 4096] {
        let mut snap = base.clone();
        for a in &mut snap.areas {
            a.width = size;
            a.height = size;
        }
        let t = Instant::now();
        let state = SliceAuthorityState::from_snapshot(&snap).expect("build");
        let ms = t.elapsed().as_secs_f64() * 1000.0;
        let total_cells = u64::from(size) * u64::from(size) * n_areas as u64;
        let per_m = ms / (total_cells as f64 / 1_000_000.0);
        std::hint::black_box(&state);
        println!("{size},{total_cells},{ms:.1},{per_m:.2}");
    }
    println!("--- projection to the 10,240^2 desert (SINGLE area) ---");
    // Single-area 10k^2 = 104.86M cells. Extrapolate O(area) clearance at the measured
    // ms/million from the largest sample (steady-state, cache-warm).
}
