//! Local-player movement prediction — port of the client-prediction feel from
//! `authorityMovementSystem.ts` + `gameAuthoritySystem.ts`. The predicted
//! position advances with held intent but is capped a small "lead" ahead of the
//! authoritative position so the local player feels responsive without running
//! away from the server; acks reconcile the authoritative point and clamp the
//! predicted point back within a tighter correction lead. Remote actors use the
//! interpolation buffer in `interp.rs`, not this.
//!
//! Constants: base/sprint speed from `tuning.v1.json`
//! (`playerSpeedCellsPerSecond` 1.357, `sprintSpeedMultiplier` 4.809); lead caps
//! from `gameAuthoritySystem.ts` (walk 0.82 / sprint 0.9 prediction, 0.58 / 0.65
//! correction).

pub const BASE_SPEED_CELLS: f32 = 1.357;
pub const SPRINT_MULTIPLIER: f32 = 4.809;
const WALK_LEAD: f32 = 0.82;
const SPRINT_LEAD: f32 = 0.9;
const WALK_CORRECTION_LEAD: f32 = 0.58;
const SPRINT_CORRECTION_LEAD: f32 = 0.65;

/// Ground speed in cells/second for the local player. `role_multiplier` folds in
/// role/profession/strain effects the caller resolves (1.0 for a plain player).
pub fn speed_cells_per_second(sprint: bool, role_multiplier: f32) -> f32 {
    BASE_SPEED_CELLS * role_multiplier * if sprint { SPRINT_MULTIPLIER } else { 1.0 }
}

#[derive(Clone, Copy, Debug, Default)]
pub struct MovePredictor {
    auth_x: f32,
    auth_y: f32,
    pred_x: f32,
    pred_y: f32,
}

impl MovePredictor {
    pub fn new(x: f32, y: f32) -> Self {
        MovePredictor {
            auth_x: x,
            auth_y: y,
            pred_x: x,
            pred_y: y,
        }
    }

    pub fn render_pos(&self) -> (f32, f32) {
        (self.pred_x, self.pred_y)
    }

    pub fn authoritative(&self) -> (f32, f32) {
        (self.auth_x, self.auth_y)
    }

    /// Advance the predicted position by held intent `(dx, dy)` (unit-ish; not
    /// necessarily normalized) for `dt` seconds, then clamp it within `lead`
    /// cells of the authoritative position.
    pub fn predict(&mut self, dx: f32, dy: f32, sprint: bool, role_multiplier: f32, dt: f32) {
        let len = (dx * dx + dy * dy).sqrt();
        if len > 1e-4 {
            let speed = speed_cells_per_second(sprint, role_multiplier);
            let step = speed * dt;
            self.pred_x += dx / len * step;
            self.pred_y += dy / len * step;
        }
        let lead = if sprint { SPRINT_LEAD } else { WALK_LEAD };
        self.clamp_to_lead(lead);
    }

    /// Apply an authoritative position (from an ack/delta), then clamp the
    /// predicted point within the tighter correction lead. When not moving, the
    /// predicted point snaps exactly to authoritative.
    pub fn reconcile(&mut self, auth_x: f32, auth_y: f32, moving: bool, sprint: bool) {
        self.auth_x = auth_x;
        self.auth_y = auth_y;
        if !moving {
            self.pred_x = auth_x;
            self.pred_y = auth_y;
            return;
        }
        let lead = if sprint {
            SPRINT_CORRECTION_LEAD
        } else {
            WALK_CORRECTION_LEAD
        };
        self.clamp_to_lead(lead);
    }

    fn clamp_to_lead(&mut self, lead: f32) {
        let dx = self.pred_x - self.auth_x;
        let dy = self.pred_y - self.auth_y;
        let d = (dx * dx + dy * dy).sqrt();
        if d > lead && d > 1e-6 {
            let k = lead / d;
            self.pred_x = self.auth_x + dx * k;
            self.pred_y = self.auth_y + dy * k;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn speed_sprint_scales() {
        assert!((speed_cells_per_second(false, 1.0) - 1.357).abs() < 1e-4);
        assert!((speed_cells_per_second(true, 1.0) - 1.357 * 4.809).abs() < 1e-3);
    }

    #[test]
    fn prediction_capped_at_lead() {
        let mut p = MovePredictor::new(0.0, 0.0);
        // Hold north (−y) for a long time; predicted must not exceed walk lead.
        for _ in 0..600 {
            p.predict(0.0, -1.0, false, 1.0, 1.0 / 60.0);
        }
        let (_, y) = p.render_pos();
        assert!((y + WALK_LEAD).abs() < 1e-3, "capped at walk lead, got {y}");
    }

    #[test]
    fn sprint_lead_is_larger() {
        let mut p = MovePredictor::new(0.0, 0.0);
        for _ in 0..600 {
            p.predict(1.0, 0.0, true, 1.0, 1.0 / 60.0);
        }
        let (x, _) = p.render_pos();
        assert!((x - SPRINT_LEAD).abs() < 1e-3);
    }

    #[test]
    fn reconcile_snaps_when_stopped() {
        let mut p = MovePredictor::new(0.0, 0.0);
        p.predict(1.0, 0.0, false, 1.0, 0.5); // predicted moved ahead
        assert!(p.render_pos().0 > 0.0);
        p.reconcile(5.0, 0.0, false, false);
        assert_eq!(p.render_pos(), (5.0, 0.0));
    }

    #[test]
    fn reconcile_clamps_correction_lead() {
        let mut p = MovePredictor::new(0.0, 0.0);
        // Predict far ahead, then authority lags well behind.
        for _ in 0..600 {
            p.predict(1.0, 0.0, false, 1.0, 1.0 / 60.0);
        }
        p.reconcile(0.0, 0.0, true, false);
        let (x, _) = p.render_pos();
        assert!(
            x <= WALK_CORRECTION_LEAD + 1e-3,
            "clamped to correction lead, got {x}"
        );
    }
}
