//! Per-actor pawn animation lane — port of the L0 locomotion contract from
//! `client-3d/src/render/pawns.ts` (state→clip table at lines 9-41, constants at
//! 120-198): idle/walk_f/run_f/walk_b gait selection with start/stop and
//! walk↔run hysteresis, unarmed/rifle/melee clip lanes, and death hold. Drives
//! the `engine-core::anim` mixer + `Skeleton` palette on a `PawnTemplate`.
//!
//! Upper-body/grip/montage layers (L1/L3/L4: aim, fire, swing) are follow-on
//! refinements; this lands the visible base locomotion.

use successor_engine_core::anim::JointTransform;

use super::pack::PawnTemplate;

// pawns.ts constants.
const IDLE_START: f32 = 0.12; // cells/s: above this a stopped pawn starts moving
const IDLE_STOP: f32 = 0.035; // cells/s: below this a moving pawn returns to idle
const WALK_RUN_HYSTERESIS: f32 = 0.12;
const RUN_START: f32 = 2.2; // cells/s: walk→run
const RUN_STOP: f32 = RUN_START - WALK_RUN_HYSTERESIS;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum WeaponLane {
    Unarmed,
    Rifle,
    Melee,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Gait {
    Idle,
    WalkF,
    RunF,
    WalkB,
    Death,
}

impl WeaponLane {
    /// (idle, walk_f, run_f, walk_b, kneel) clip names for the lane.
    fn base_clips(self) -> [&'static str; 5] {
        match self {
            WeaponLane::Unarmed => ["idle", "walk_f", "run_f", "walk_b", "kneel_loop"],
            WeaponLane::Rifle => [
                "rifle_idle",
                "rifle_walk_f",
                "rifle_run_f",
                "walk_b",
                "kneel_loop",
            ],
            WeaponLane::Melee => [
                "melee_idle",
                "melee_walk_f",
                "melee_run_f",
                "walk_b",
                "kneel_loop",
            ],
        }
    }
}

pub struct PawnAnimator {
    pose: Vec<JointTransform>,
    palette: Vec<[f32; 16]>,
    time: f32,
    gait: Gait,
    moving: bool,  // hysteresis latch for idle start/stop
    running: bool, // hysteresis latch for walk/run
}

impl PawnAnimator {
    pub fn new(template: &PawnTemplate) -> Self {
        PawnAnimator {
            pose: template.rest_pose(),
            palette: Vec::with_capacity(template.joint_count()),
            time: 0.0,
            gait: Gait::Idle,
            moving: false,
            running: false,
        }
    }

    /// Update the hysteresis latches and pick the gait for this frame.
    pub fn resolve_gait(&mut self, speed_cells: f32, against_facing: bool, alive: bool) -> Gait {
        if !alive {
            self.gait = Gait::Death;
            return Gait::Death;
        }
        // Idle start/stop hysteresis.
        if self.moving {
            if speed_cells < IDLE_STOP {
                self.moving = false;
            }
        } else if speed_cells >= IDLE_START {
            self.moving = true;
        }
        if !self.moving {
            self.gait = Gait::Idle;
            return Gait::Idle;
        }
        if against_facing {
            self.running = false;
            self.gait = Gait::WalkB;
            return Gait::WalkB;
        }
        // Walk/run hysteresis.
        if self.running {
            if speed_cells < RUN_STOP {
                self.running = false;
            }
        } else if speed_cells >= RUN_START {
            self.running = true;
        }
        self.gait = if self.running {
            Gait::RunF
        } else {
            Gait::WalkF
        };
        self.gait
    }

    /// The clip name for the current gait in a lane, with unarmed fallback when
    /// the lane-specific clip is absent from the template.
    fn clip_for(&self, template: &PawnTemplate, lane: WeaponLane) -> &'static str {
        let clips = lane.base_clips();
        let name = match self.gait {
            Gait::Idle => clips[0],
            Gait::WalkF => clips[1],
            Gait::RunF => clips[2],
            Gait::WalkB => clips[3],
            Gait::Death => "death_f",
        };
        if template.animation(name).is_some() {
            name
        } else {
            // Fall back to the unarmed equivalent, else plain idle.
            let un = WeaponLane::Unarmed.base_clips();
            let fallback = match self.gait {
                Gait::Idle => un[0],
                Gait::WalkF => un[1],
                Gait::RunF => un[2],
                Gait::WalkB => un[3],
                Gait::Death => "death_f",
            };
            if template.animation(fallback).is_some() {
                fallback
            } else {
                "idle"
            }
        }
    }

    /// Advance the clip and compute the skinning palette for this frame.
    pub fn update(
        &mut self,
        template: &mut PawnTemplate,
        lane: WeaponLane,
        speed_cells: f32,
        against_facing: bool,
        alive: bool,
        dt_seconds: f32,
    ) -> &[[f32; 16]] {
        self.resolve_gait(speed_cells, against_facing, alive);
        let clip = self.clip_for(template, lane);
        // timeScale ≈ movement speed relative to a nominal gait speed, clamped
        // so slow drift doesn't freeze and fast bursts don't strobe.
        let nominal = match self.gait {
            Gait::RunF => 3.5,
            Gait::WalkF | Gait::WalkB => 1.4,
            _ => 1.0,
        };
        let ts = if matches!(self.gait, Gait::Idle | Gait::Death) {
            1.0
        } else {
            (speed_cells / nominal).clamp(0.5, 1.6)
        };
        let duration = template
            .animation(clip)
            .map(|a| a.duration.max(0.001))
            .unwrap_or(1.0);
        // Death holds on the last frame; others loop.
        if matches!(self.gait, Gait::Death) {
            self.time = duration;
        } else {
            self.time = (self.time + dt_seconds * ts) % duration;
        }
        template.pose_at(clip, self.time, &mut self.pose);
        template
            .skeleton
            .compute_palette(&self.pose, &mut self.palette);
        &self.palette
    }

    pub fn palette(&self) -> &[[f32; 16]] {
        &self.palette
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Gait selection is independent of the template; test it directly.
    fn anim() -> PawnAnimator {
        PawnAnimator {
            pose: Vec::new(),
            palette: Vec::new(),
            time: 0.0,
            gait: Gait::Idle,
            moving: false,
            running: false,
        }
    }

    #[test]
    fn idle_below_start_walks_above() {
        let mut a = anim();
        assert_eq!(a.resolve_gait(0.05, false, true), Gait::Idle);
        assert_eq!(a.resolve_gait(0.5, false, true), Gait::WalkF);
    }

    #[test]
    fn idle_hysteresis_holds_moving_until_stop_threshold() {
        let mut a = anim();
        a.resolve_gait(1.0, false, true); // moving
                                          // Between stop (0.035) and start (0.12): stays moving (walk).
        assert_eq!(a.resolve_gait(0.08, false, true), Gait::WalkF);
        // Below stop: idle.
        assert_eq!(a.resolve_gait(0.01, false, true), Gait::Idle);
    }

    #[test]
    fn run_above_threshold_with_hysteresis() {
        let mut a = anim();
        assert_eq!(a.resolve_gait(1.5, false, true), Gait::WalkF);
        assert_eq!(a.resolve_gait(2.3, false, true), Gait::RunF);
        // Between run stop (2.08) and start (2.2): stays running.
        assert_eq!(a.resolve_gait(2.15, false, true), Gait::RunF);
        assert_eq!(a.resolve_gait(2.0, false, true), Gait::WalkF);
    }

    #[test]
    fn backpedal_and_death() {
        let mut a = anim();
        assert_eq!(a.resolve_gait(1.0, true, true), Gait::WalkB);
        assert_eq!(a.resolve_gait(1.0, false, false), Gait::Death);
    }

    #[test]
    fn lane_clip_names() {
        assert_eq!(WeaponLane::Rifle.base_clips()[0], "rifle_idle");
        assert_eq!(WeaponLane::Melee.base_clips()[2], "melee_run_f");
        assert_eq!(WeaponLane::Unarmed.base_clips()[1], "walk_f");
    }
}
