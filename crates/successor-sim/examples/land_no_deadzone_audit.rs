//! NO-DEADZONE AUDIT TOOL (§A LAND WAVE). Loads the SHIPPED open-desert slice,
//! builds the real authority state (central hub zone + POI/road buffers live), and
//! proves the GLOBAL invariant: every FREE (in-bounds, unexcluded, unclaimed) lattice
//! slot is claimable by at least one legal Homestead (2x2 quantum). Prints the report
//! per area and PANICS if any trapped cell exists — a broken lattice/exclusion fails
//! loudly. The 10k ship-scale proof lives in the unit suite
//! (`no_deadzone_audit_holds_at_10k_with_central_2km_zone`).
use successor_sim::{SliceAuthorityState, SliceSnapshot};

fn main() {
    let fixture = include_str!("../../../client/public/successor-slice/open-desert-slice.json");
    let snapshot: SliceSnapshot = serde_json::from_str(fixture).expect("open-desert slice parses");
    let area_ids: Vec<String> = snapshot.areas.iter().map(|a| a.id.clone()).collect();
    let state = SliceAuthorityState::from_snapshot(&snapshot).expect("build authority state");

    println!(
        "NO-DEADZONE AUDIT — shipped open-desert slice (lattice quantum {} cells)",
        successor_sim::LATTICE_QUANTUM_CELLS
    );
    let mut all_pass = true;
    for area_id in &area_ids {
        let r = state.audit_no_deadzone(area_id);
        println!(
            "  [{}] lattice {}x{} quantum | free {} | coverable {} | trapped {} => {}",
            r.area_id,
            r.area_quantum_w,
            r.area_quantum_h,
            r.free_cells,
            r.coverable_cells,
            r.trapped_total,
            if r.passed { "PASS" } else { "FAIL" },
        );
        if !r.passed {
            all_pass = false;
            println!("    trapped sample (cell-space): {:?}", r.trapped_cells);
        }
        assert_eq!(
            r.free_cells, r.coverable_cells,
            "{}: every free lattice cell must be coverable by a legal Homestead",
            r.area_id
        );
    }
    assert!(all_pass, "deadzone detected — the invariant is broken");
    println!("RESULT: PASS — every free lattice slot on the shipped map is claimable (no sliver, no deadzone).");
}
