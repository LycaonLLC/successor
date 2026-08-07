//! Enterable-prop cutaway state machine — a verbatim port of the pure machine
//! in `client-3d/src/render/props.ts` (lines 228-334). Advances only on new
//! authority snapshot ticks, with inner/outer hysteresis and a two-snapshot
//! dwell before any enter/exit flip. All coordinates are milli-cells.

/// Entering requires the point at least this far INSIDE a region.
pub const INNER_INSET_MILLI: f64 = 250.0;
/// Exiting requires the point at least this far OUTSIDE every region.
pub const OUTER_EXPAND_MILLI: f64 = 250.0;
/// Consecutive agreeing snapshots before an enter/exit flip commits.
pub const DWELL_SNAPSHOTS: u32 = 2;

/// An axis-aligned interior region in milli-cells (min corner + size).
#[derive(Clone, Copy, PartialEq, Debug)]
pub struct RegionMilli {
    pub x_milli: f64,
    pub y_milli: f64,
    pub w_milli: f64,
    pub h_milli: f64,
}

#[derive(Clone, Copy, PartialEq, Debug)]
pub struct CutawayState {
    pub inside: bool,
    pub dwell: u32,
    pub last_sampled_tick: f64,
    /// Fade progress 0 (exterior) .. 1 (interior).
    pub t: f64,
}

impl Default for CutawayState {
    fn default() -> Self {
        CutawayState {
            inside: false,
            dwell: 0,
            last_sampled_tick: f64::NEG_INFINITY,
            t: 0.0,
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum CutawayPhase {
    Exterior,
    Entering,
    Interior,
    Exiting,
}

/// Positive margin expands the region; negative insets it (clamped so a narrow
/// region keeps a core).
fn region_contains(region: &RegionMilli, x: f64, z: f64, margin: f64) -> bool {
    let mx = margin.max(1.0 - region.w_milli / 2.0);
    let mz = margin.max(1.0 - region.h_milli / 2.0);
    x >= region.x_milli - mx
        && x <= region.x_milli + region.w_milli + mx
        && z >= region.y_milli - mz
        && z <= region.y_milli + region.h_milli + mz
}

pub fn inside_inner(regions: &[RegionMilli], x: f64, z: f64) -> bool {
    regions
        .iter()
        .any(|r| region_contains(r, x, z, -INNER_INSET_MILLI))
}

pub fn inside_outer(regions: &[RegionMilli], x: f64, z: f64) -> bool {
    regions
        .iter()
        .any(|r| region_contains(r, x, z, OUTER_EXPAND_MILLI))
}

/// Advance the enter/exit decision — ONLY on a new snapshot tick.
pub fn sample(
    state: &mut CutawayState,
    snapshot_tick: f64,
    regions: &[RegionMilli],
    x: f64,
    z: f64,
) {
    if snapshot_tick == state.last_sampled_tick {
        return;
    }
    state.last_sampled_tick = snapshot_tick;
    let wants_flip = if state.inside {
        !inside_outer(regions, x, z)
    } else {
        inside_inner(regions, x, z)
    };
    if !wants_flip {
        state.dwell = 0;
        return;
    }
    state.dwell += 1;
    if state.dwell >= DWELL_SNAPSHOTS {
        state.inside = !state.inside;
        state.dwell = 0;
    }
}

pub fn phase(state: &CutawayState) -> CutawayPhase {
    if state.inside {
        if state.t >= 1.0 {
            CutawayPhase::Interior
        } else {
            CutawayPhase::Entering
        }
    } else if state.t <= 0.0 {
        CutawayPhase::Exterior
    } else {
        CutawayPhase::Exiting
    }
}

/// Advance the fade toward the current decision; returns the eased hide amount
/// (0 = walls visible, 1 = hidden). Reduced motion snaps after the same decision.
pub fn advance_fade(
    state: &mut CutawayState,
    dt_seconds: f64,
    fade_seconds: f64,
    reduced_motion: bool,
) -> f64 {
    let target = if state.inside { 1.0 } else { 0.0 };
    if reduced_motion {
        state.t = target;
    } else {
        let step_seconds = if dt_seconds.is_finite() {
            dt_seconds.clamp(0.0, 0.1)
        } else {
            0.0
        };
        let step = step_seconds / fade_seconds.max(0.01);
        state.t = if state.t < target {
            (state.t + step).min(target)
        } else {
            (state.t - step).max(target)
        };
    }
    state.t * state.t * (3.0 - 2.0 * state.t)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn region() -> Vec<RegionMilli> {
        // A 4000×4000 milli-cell (4×4 cell) room at origin.
        vec![RegionMilli {
            x_milli: 0.0,
            y_milli: 0.0,
            w_milli: 4000.0,
            h_milli: 4000.0,
        }]
    }

    #[test]
    fn enters_after_dwell_when_inside_inner() {
        let regs = region();
        let mut s = CutawayState::default();
        // Deep inside (well past inner inset). First tick arms dwell, second flips.
        sample(&mut s, 1.0, &regs, 2000.0, 2000.0);
        assert!(!s.inside);
        assert_eq!(s.dwell, 1);
        sample(&mut s, 2.0, &regs, 2000.0, 2000.0);
        assert!(s.inside);
    }

    #[test]
    fn same_tick_is_ignored() {
        let regs = region();
        let mut s = CutawayState::default();
        sample(&mut s, 5.0, &regs, 2000.0, 2000.0);
        let after = s;
        sample(&mut s, 5.0, &regs, 2000.0, 2000.0); // same tick → no change
        assert_eq!(s, after);
    }

    #[test]
    fn holds_between_thresholds() {
        let regs = region();
        let mut s = CutawayState {
            inside: true,
            ..Default::default()
        };
        // Point just outside the room but within the outer-expand band: inside
        // actor should NOT want to flip out.
        sample(&mut s, 1.0, &regs, 4100.0, 2000.0);
        assert!(s.inside, "still inside outer band → holds");
    }

    #[test]
    fn exits_after_leaving_outer() {
        let regs = region();
        let mut s = CutawayState {
            inside: true,
            ..Default::default()
        };
        // Far outside the outer band.
        sample(&mut s, 1.0, &regs, 100000.0, 100000.0);
        sample(&mut s, 2.0, &regs, 100000.0, 100000.0);
        assert!(!s.inside);
    }

    #[test]
    fn fade_tween_and_snap() {
        let mut s = CutawayState {
            inside: true,
            ..Default::default()
        };
        let a = advance_fade(&mut s, 0.05, 0.2, false);
        assert!(a > 0.0 && s.t > 0.0 && s.t < 1.0);
        // Reduced motion snaps to the target.
        let mut s2 = CutawayState {
            inside: true,
            ..Default::default()
        };
        advance_fade(&mut s2, 0.0, 0.2, true);
        assert_eq!(s2.t, 1.0);
    }
}
