//! Per-actor pawn animation lane — port of the L0 locomotion contract from
//! `client-3d/src/render/pawns.ts` (state→clip table at lines 9-41, constants at
//! 120-198): idle/walk_f/run_f/walk_b gait selection with start/stop and
//! walk↔run hysteresis, unarmed/rifle/melee clip lanes, and death hold. Drives
//! the `engine-core::anim` mixer + `Skeleton` palette on a `PawnTemplate`.
//!
//! Base locomotion, authored melee draw/sheath transitions, and rifle
//! support-hand IK are evaluated on the shared runtime skeleton.

use successor_engine_core::anim::{blend_into, JointTransform};
use successor_engine_core::math::{vec3, Mat4, Quat, Vec3};

use super::catalog::SupportArmPosture;
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

#[derive(Clone, Copy)]
struct RifleArm {
    shoulder_parent: usize,
    /// Parent of `shoulder_parent`; the frame the girdle swing rotates in.
    girdle_parent: Option<usize>,
    upper: usize,
    lower: usize,
    hand: usize,
    weapon_hand: usize,
}

pub struct PawnAnimator {
    pose: Vec<JointTransform>,
    transition_pose: Vec<JointTransform>,
    palette: Vec<[f32; 16]>,
    time: f32,
    gait: Gait,
    moving: bool,  // hysteresis latch for idle start/stop
    running: bool, // hysteresis latch for walk/run
    rifle_arm: Option<RifleArm>,
}

impl PawnAnimator {
    pub fn new(template: &PawnTemplate) -> Self {
        PawnAnimator {
            pose: template.rest_pose(),
            transition_pose: template.rest_pose(),
            palette: Vec::with_capacity(template.joint_count()),
            time: 0.0,
            gait: Gait::Idle,
            moving: false,
            running: false,
            rifle_arm: find_rifle_arm(template),
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

    /// Blend unarmed/armed locomotion while a weapon moves between its hand
    /// and authored stow socket. Melee draw/sheath clips take precedence while
    /// active so the prop transfer and body motion share one normalized phase.
    #[allow(clippy::too_many_arguments)]
    pub fn update_weapon_transition(
        &mut self,
        template: &mut PawnTemplate,
        lane: WeaponLane,
        armed_blend: f32,
        transition: Option<(&str, f32)>,
        speed_cells: f32,
        against_facing: bool,
        alive: bool,
        dt_seconds: f32,
    ) -> &[[f32; 16]] {
        self.resolve_gait(speed_cells, against_facing, alive);
        let armed_clip = self.clip_for(template, lane);
        let unarmed_clip = self.clip_for(template, WeaponLane::Unarmed);
        let nominal = match self.gait {
            Gait::RunF => 3.5,
            Gait::WalkF | Gait::WalkB => 1.4,
            _ => 1.0,
        };
        let time_scale = if matches!(self.gait, Gait::Idle | Gait::Death) {
            1.0
        } else {
            (speed_cells / nominal).clamp(0.5, 1.6)
        };
        let armed_duration = template
            .animation(armed_clip)
            .map(|a| a.duration.max(0.001))
            .unwrap_or(1.0);
        if matches!(self.gait, Gait::Death) {
            self.time = armed_duration;
        } else {
            self.time = (self.time + dt_seconds * time_scale) % armed_duration;
        }
        let phase = (self.time / armed_duration).clamp(0.0, 1.0);

        let transition_applied = transition
            .filter(|(clip, _)| template.animation(clip).is_some())
            .map(|(clip, transition_phase)| {
                let duration = template
                    .animation(clip)
                    .map(|a| a.duration.max(0.001))
                    .unwrap_or(1.0);
                template.pose_at(
                    clip,
                    transition_phase.clamp(0.0, 1.0) * duration,
                    &mut self.pose,
                );
            })
            .is_some();
        if !transition_applied {
            let unarmed_duration = template
                .animation(unarmed_clip)
                .map(|a| a.duration.max(0.001))
                .unwrap_or(1.0);
            template.pose_at(unarmed_clip, phase * unarmed_duration, &mut self.pose);
            let weight = armed_blend.clamp(0.0, 1.0);
            if weight > 0.0 {
                template.pose_at(
                    armed_clip,
                    phase * armed_duration,
                    &mut self.transition_pose,
                );
                blend_into(&mut self.pose, &self.transition_pose, weight, None);
            }
        }
        template
            .skeleton
            .compute_palette(&self.pose, &mut self.palette);
        &self.palette
    }

    /// Pull the support wrist onto the live rifle foregrip after base-clip
    /// sampling. The authored right-hand weld remains untouched.
    pub fn apply_rifle_support_ik(
        &mut self,
        template: &mut PawnTemplate,
        mount: Mat4,
        foregrip: Vec3,
    ) {
        self.apply_rifle_support_ik_weighted(
            template,
            mount,
            foregrip,
            vec3(0.0, -0.02, -0.055),
            1.0,
            None,
        );
    }

    /// `posture` is the model's authored `hold.support_arm` block. Absent, this
    /// is the legacy solve: the wrist is dragged onto the target and, when the
    /// target sits past the arm's own reach, the elbow collapses onto the
    /// shoulder->wrist line. Present, it holds a floor under the elbow bend,
    /// pays for that bend with a bounded clavicle swing, and rolls the elbow to
    /// the authored pole. Same contract and same numbers as
    /// `client-3d/src/render/anim/twoBoneIk.ts`.
    pub fn apply_rifle_support_ik_weighted(
        &mut self,
        template: &mut PawnTemplate,
        mount: Mat4,
        foregrip: Vec3,
        foregrip_contact: Vec3,
        weight: f32,
        posture: Option<SupportArmPosture>,
    ) {
        let weight = weight.clamp(0.0, 1.0);
        if weight <= 0.0 {
            return;
        }
        let Some(arm) = self.rifle_arm else {
            return;
        };

        let target = template
            .skeleton
            .bone_global(arm.weapon_hand)
            .mul(mount)
            .transform_point(foregrip.add(foregrip_contact));
        let shoulder = template
            .skeleton
            .bone_global(arm.upper)
            .transform_point(Vec3::ZERO);
        let elbow = template
            .skeleton
            .bone_global(arm.lower)
            .transform_point(Vec3::ZERO);
        let wrist = template
            .skeleton
            .bone_global(arm.hand)
            .transform_point(Vec3::ZERO);
        let mut upper_vec = elbow.sub(shoulder);
        let mut lower_vec = wrist.sub(elbow);
        let upper_len = upper_vec.length();
        let lower_len = lower_vec.length();
        if upper_len < 1.0e-5 || lower_len < 1.0e-5 {
            return;
        }

        // Longest wrist reach this solve may ask for. Legacy: a hair short of a
        // locked-straight arm. Under a hold posture: the chord that still
        // leaves `min_bend_rad` at the elbow, so the limb can never collapse
        // onto its own axis and lie along the weapon.
        let mut shoulder = shoulder;
        let mut reach_limit = upper_len + lower_len - 1.0e-5;
        if let Some(hold) = posture {
            let interior = core::f32::consts::PI - hold.min_bend_rad * weight;
            let bend_limit = (upper_len * upper_len + lower_len * lower_len
                - 2.0 * upper_len * lower_len * interior.cos())
            .max(0.0)
            .sqrt();
            reach_limit = reach_limit.min(bend_limit);
            if self.advance_shoulder(template, arm, target, reach_limit, hold, weight) {
                shoulder = template
                    .skeleton
                    .bone_global(arm.upper)
                    .transform_point(Vec3::ZERO);
                let elbow = template
                    .skeleton
                    .bone_global(arm.lower)
                    .transform_point(Vec3::ZERO);
                let wrist = template
                    .skeleton
                    .bone_global(arm.hand)
                    .transform_point(Vec3::ZERO);
                upper_vec = elbow.sub(shoulder);
                lower_vec = wrist.sub(elbow);
            }
        }

        let to_target = target.sub(shoulder);
        let reach = to_target
            .length()
            .clamp((upper_len - lower_len).abs() + 1.0e-5, reach_limit);
        let cos_desired = ((upper_len * upper_len + lower_len * lower_len - reach * reach)
            / (2.0 * upper_len * lower_len))
            .clamp(-1.0, 1.0);
        let interior_desired = cos_desired.acos();
        let cos_current = (-upper_vec.dot(lower_vec) / (upper_len * lower_len)).clamp(-1.0, 1.0);
        let interior_current = cos_current.acos();
        let mut hinge = upper_vec.cross(lower_vec);
        if hinge.dot(hinge) < 1.0e-5 {
            hinge = Vec3::Y.cross(upper_vec);
            if hinge.dot(hinge) < 1.0e-5 {
                hinge = vec3(1.0, 0.0, 0.0).cross(upper_vec);
            }
        }
        let elbow_delta = interior_desired - interior_current;
        if elbow_delta.abs() > 1.0e-5 {
            let rotation = Quat::from_axis_angle(hinge.normalize(), -elbow_delta * weight);
            let upper_global = template.skeleton.bone_global(arm.upper);
            apply_world_rotation(&mut self.pose[arm.lower], upper_global, rotation);
            template
                .skeleton
                .compute_palette(&self.pose, &mut self.palette);
        }

        let solved_wrist = template
            .skeleton
            .bone_global(arm.hand)
            .transform_point(Vec3::ZERO);
        let from_dir = solved_wrist.sub(shoulder).normalize();
        let to_dir = to_target.normalize();
        if from_dir.dot(from_dir) > 1.0e-5 && to_dir.dot(to_dir) > 1.0e-5 {
            let rotation = quat_weight(quat_between(from_dir, to_dir), weight);
            let parent_global = template.skeleton.bone_global(arm.shoulder_parent);
            apply_world_rotation(&mut self.pose[arm.upper], parent_global, rotation);
            template
                .skeleton
                .compute_palette(&self.pose, &mut self.palette);
        }

        if let Some(hold) = posture {
            self.roll_elbow(template, arm, hold.pole_rad, weight);
        }
    }

    /// Swing the shoulder girdle toward the target so a retained elbow bend is
    /// paid for in scapular travel instead of a hand that stops short of its
    /// contact. Inert whenever the target already sits inside the bent-arm
    /// reach, which is every pose of every weapon whose support socket is
    /// authored within the arm. Returns true when the girdle moved.
    fn advance_shoulder(
        &mut self,
        template: &mut PawnTemplate,
        arm: RifleArm,
        target: Vec3,
        reach_limit: f32,
        hold: SupportArmPosture,
        weight: f32,
    ) -> bool {
        if hold.shoulder_advance_max_m <= 1.0e-5 {
            return false;
        }
        let Some(girdle_parent) = arm.girdle_parent else {
            return false;
        };
        let shoulder = template
            .skeleton
            .bone_global(arm.upper)
            .transform_point(Vec3::ZERO);
        let to_target = target.sub(shoulder);
        let deficit = to_target.length() - reach_limit;
        if deficit <= 1.0e-5 {
            return false;
        }
        let root = template
            .skeleton
            .bone_global(arm.shoulder_parent)
            .transform_point(Vec3::ZERO);
        let girdle = shoulder.sub(root);
        let girdle_len = girdle.length();
        if girdle_len < 1.0e-5 {
            return false;
        }
        // Rotating about girdle x to_target carries the shoulder along the arc
        // toward the target; chord = 2 R sin(angle / 2).
        let axis = girdle.cross(to_target);
        if axis.dot(axis) < 1.0e-5 {
            return false;
        }
        let chord = (hold.shoulder_advance_max_m * weight).min(deficit);
        let angle = 2.0 * (chord / (2.0 * girdle_len)).min(1.0).asin();
        let rotation = Quat::from_axis_angle(axis.normalize(), angle);
        let parent_global = template.skeleton.bone_global(girdle_parent);
        apply_world_rotation(&mut self.pose[arm.shoulder_parent], parent_global, rotation);
        template
            .skeleton
            .compute_palette(&self.pose, &mut self.palette);
        true
    }

    /// Roll the whole arm about the shoulder->wrist axis until the elbow sits
    /// at the authored pole angle (from world-down, positive toward
    /// axis x down). The wrist lies ON that axis, so the contact never moves.
    fn roll_elbow(
        &mut self,
        template: &mut PawnTemplate,
        arm: RifleArm,
        pole_rad: f32,
        weight: f32,
    ) {
        let shoulder = template
            .skeleton
            .bone_global(arm.upper)
            .transform_point(Vec3::ZERO);
        let elbow = template
            .skeleton
            .bone_global(arm.lower)
            .transform_point(Vec3::ZERO);
        let wrist = template
            .skeleton
            .bone_global(arm.hand)
            .transform_point(Vec3::ZERO);
        let axis = wrist.sub(shoulder);
        if axis.dot(axis) < 1.0e-5 {
            return;
        }
        let axis = axis.normalize();
        // World-down with its along-axis component removed: the pole's zero.
        let reference = vec3(0.0, -1.0, 0.0).add(axis.scale(axis.y));
        if reference.dot(reference) < 1.0e-6 {
            return; // arm points straight up or down
        }
        let reference = reference.normalize();
        let side = axis.cross(reference);
        let radial = elbow.sub(shoulder);
        let radial = radial.sub(axis.scale(radial.dot(axis)));
        if radial.dot(radial) < 1.0e-6 {
            return; // straight arm: no pole plane to aim
        }
        let mut delta = pole_rad - radial.dot(side).atan2(radial.dot(reference));
        if delta > core::f32::consts::PI {
            delta -= core::f32::consts::TAU;
        } else if delta < -core::f32::consts::PI {
            delta += core::f32::consts::TAU;
        }
        delta *= weight;
        if delta.abs() < 1.0e-5 {
            return;
        }
        let rotation = Quat::from_axis_angle(axis, delta);
        let parent_global = template.skeleton.bone_global(arm.shoulder_parent);
        apply_world_rotation(&mut self.pose[arm.upper], parent_global, rotation);
        template
            .skeleton
            .compute_palette(&self.pose, &mut self.palette);
    }

    pub fn palette(&self) -> &[[f32; 16]] {
        &self.palette
    }
}

pub(crate) fn weapon_hand_bone(template: &PawnTemplate) -> Option<usize> {
    template
        .skeleton
        .find_bone("hand_r")
        .or_else(|| template.skeleton.find_bone("RightHand"))
}

fn find_rifle_arm(template: &PawnTemplate) -> Option<RifleArm> {
    let shoulder_parent = template.skeleton.find_bone("clavicle_l")?;
    Some(RifleArm {
        shoulder_parent,
        girdle_parent: template
            .skeleton
            .parent
            .get(shoulder_parent)
            .copied()
            .flatten(),
        upper: template.skeleton.find_bone("upperarm_l")?,
        lower: template.skeleton.find_bone("lowerarm_l")?,
        hand: template.skeleton.find_bone("hand_l")?,
        weapon_hand: weapon_hand_bone(template)?,
    })
}

fn quat_conjugate(q: Quat) -> Quat {
    Quat {
        x: -q.x,
        y: -q.y,
        z: -q.z,
        w: q.w,
    }
}

fn apply_world_rotation(pose: &mut JointTransform, parent_global: Mat4, rotation: Quat) {
    let (_, parent_rotation, _) = parent_global.to_trs();
    let local_rotation = quat_conjugate(parent_rotation)
        .mul(rotation)
        .mul(parent_rotation);
    pose.r = local_rotation.mul(pose.r).normalize();
}

fn quat_weight(mut rotation: Quat, weight: f32) -> Quat {
    if rotation.w < 0.0 {
        rotation = Quat {
            x: -rotation.x,
            y: -rotation.y,
            z: -rotation.z,
            w: -rotation.w,
        };
    }
    Quat {
        x: rotation.x * weight,
        y: rotation.y * weight,
        z: rotation.z * weight,
        w: 1.0 + (rotation.w - 1.0) * weight,
    }
    .normalize()
}

fn quat_between(from: Vec3, to: Vec3) -> Quat {
    let dot = from.dot(to).clamp(-1.0, 1.0);
    if dot < -0.999_999 {
        let mut axis = Vec3::Y.cross(from);
        if axis.dot(axis) < 1.0e-5 {
            axis = vec3(1.0, 0.0, 0.0).cross(from);
        }
        return Quat::from_axis_angle(axis.normalize(), core::f32::consts::PI);
    }
    let cross = from.cross(to);
    Quat {
        x: cross.x,
        y: cross.y,
        z: cross.z,
        w: 1.0 + dot,
    }
    .normalize()
}

#[cfg(test)]
mod tests {
    use super::*;

    // Gait selection is independent of the template; test it directly.
    fn anim() -> PawnAnimator {
        PawnAnimator {
            pose: Vec::new(),
            transition_pose: Vec::new(),
            palette: Vec::new(),
            time: 0.0,
            gait: Gait::Idle,
            moving: false,
            running: false,
            rifle_arm: None,
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

    #[test]
    fn melee_sheath_transition_samples_authored_clip_phase() {
        let body = std::fs::read("../../../client-3d/public/assets/pawn-pack/pawn_male.glb")
            .expect("checked-in pawn body");
        let mut template = PawnTemplate::from_bytes(&body).expect("pawn template");
        let duration = template
            .animation("melee_sheath")
            .expect("authored sheath clip")
            .duration;
        let mut expected = template.rest_pose();
        template.pose_at("melee_sheath", duration * 0.5, &mut expected);

        let mut animator = PawnAnimator::new(&template);
        animator.update_weapon_transition(
            &mut template,
            WeaponLane::Melee,
            0.5,
            Some(("melee_sheath", 0.5)),
            0.0,
            false,
            true,
            0.0,
        );
        assert_eq!(animator.pose, expected);
    }

    #[test]
    fn rifle_support_wrist_reaches_authored_foregrip() {
        let body = std::fs::read("../../../client-3d/public/assets/pawn-pack/pawn_male.glb")
            .expect("checked-in pawn body");
        let attach =
            std::fs::read("../../../client-3d/public/assets/pawn-pack/slugthrower_attach.json")
                .expect("checked-in rifle attachment");
        let hand_spec =
            crate::pawn::catalog::parse_weapon_hand_spec(&attach).expect("rifle hand spec");
        let mut template = PawnTemplate::from_bytes(&body).expect("pawn template");
        let mut animator = PawnAnimator::new(&template);
        animator.update(&mut template, WeaponLane::Rifle, 0.0, false, true, 0.0);
        animator.apply_rifle_support_ik(&mut template, hand_spec.mount, hand_spec.foregrip);

        let arm = animator.rifle_arm.expect("rifle arm bones");
        assert_eq!(
            arm.weapon_hand,
            template.skeleton.find_bone("hand_r").expect("right hand")
        );
        assert_ne!(
            arm.weapon_hand,
            template
                .skeleton
                .find_bone("hand")
                .expect("generic match resolves first hand")
        );
        let target = template
            .skeleton
            .bone_global(arm.weapon_hand)
            .mul(hand_spec.mount)
            .transform_point(hand_spec.foregrip.add(vec3(0.0, -0.02, -0.055)));
        let wrist = template
            .skeleton
            .bone_global(arm.hand)
            .transform_point(Vec3::ZERO);
        assert!(
            wrist.sub(target).length() < 1.0e-3,
            "support wrist missed foregrip target by {} m",
            wrist.sub(target).length()
        );
    }

    /// The two far-forward modular guns author `hold.support_arm` because their
    /// support contact sits past the arm (0.586-0.658 m against 0.584 m of
    /// upperarm+lowerarm), which made this solver clamp to full extension and
    /// lay the support arm along the weapon as a rod.
    fn support_arm_fixture() -> Option<(
        PawnTemplate,
        PawnAnimator,
        crate::pawn::catalog::WeaponHandSpec,
    )> {
        let body =
            std::fs::read("../../../client-3d/public/assets/pawn-pack/pawn_male.glb").ok()?;
        let attach = std::fs::read(
            "../../../client-3d/public/assets/pawn-pack/weapons/custom/wpn_launcher_flare_net_attach.json",
        )
        .ok()?;
        let hand_spec = crate::pawn::catalog::parse_weapon_hand_spec(&attach)?;
        let template = PawnTemplate::from_bytes(&body).ok()?;
        let animator = PawnAnimator::new(&template);
        Some((template, animator, hand_spec))
    }

    fn elbow_off_axis(template: &PawnTemplate, arm: RifleArm) -> f32 {
        let shoulder = template
            .skeleton
            .bone_global(arm.upper)
            .transform_point(Vec3::ZERO);
        let elbow = template
            .skeleton
            .bone_global(arm.lower)
            .transform_point(Vec3::ZERO);
        let wrist = template
            .skeleton
            .bone_global(arm.hand)
            .transform_point(Vec3::ZERO);
        let axis = wrist.sub(shoulder);
        if axis.length() < 1.0e-9 {
            return 0.0;
        }
        let axis = axis.normalize();
        let to_elbow = elbow.sub(shoulder);
        to_elbow.sub(axis.scale(to_elbow.dot(axis))).length()
    }

    #[test]
    fn support_arm_block_parses_with_the_browser_clamps() {
        let attach = std::fs::read(
            "../../../client-3d/public/assets/pawn-pack/weapons/custom/wpn_launcher_flare_net_attach.json",
        )
        .expect("checked-in launcher attachment");
        let hand_spec =
            crate::pawn::catalog::parse_weapon_hand_spec(&attach).expect("launcher hand spec");
        let posture = hand_spec
            .support_arm
            .expect("launcher authors a hold posture");
        assert!((posture.min_bend_rad - 34.0_f32.to_radians()).abs() < 1.0e-6);
        assert!((posture.pole_rad - 56.0_f32.to_radians()).abs() < 1.0e-6);
        assert!((posture.shoulder_advance_max_m - 0.05).abs() < 1.0e-6);

        // Half a block is not a posture: it is ignored, not half-applied.
        let partial = br#"{"mount_hand_r_local":{"pos":[0,0,0],"quat":[0,0,0,1]},
            "sockets":{"grip":[0,0,0],"foregrip":[0,0,0.1],"muzzle":[0,0,0.3]},
            "nodes":{"frame":"f"},"hold":{"support_arm":{"min_elbow_bend_deg":34}}}"#;
        assert!(crate::pawn::catalog::parse_weapon_hand_spec(partial)
            .expect("spec parses")
            .support_arm
            .is_none());

        // Absurd authoring is clamped to anatomy, never propagated raw.
        let wild = br#"{"mount_hand_r_local":{"pos":[0,0,0],"quat":[0,0,0,1]},
            "sockets":{"grip":[0,0,0],"foregrip":[0,0,0.1],"muzzle":[0,0,0.3]},
            "nodes":{"frame":"f"},"hold":{"support_arm":{"min_elbow_bend_deg":400,
            "shoulder_advance_max_m":9.0,"elbow_pole_deg":56}}}"#;
        let clamped = crate::pawn::catalog::parse_weapon_hand_spec(wild)
            .expect("spec parses")
            .support_arm
            .expect("posture present");
        assert!((clamped.min_bend_rad - 80.0_f32.to_radians()).abs() < 1.0e-6);
        assert!((clamped.shoulder_advance_max_m - 0.12).abs() < 1.0e-6);
    }

    #[test]
    fn support_arm_posture_bends_the_elbow_without_moving_the_wrist() {
        let Some((mut template, mut animator, hand_spec)) = support_arm_fixture() else {
            return;
        };
        let posture = hand_spec
            .support_arm
            .expect("launcher authors a hold posture");

        animator.update(&mut template, WeaponLane::Rifle, 0.0, false, true, 0.0);
        animator.apply_rifle_support_ik_weighted(
            &mut template,
            hand_spec.mount,
            hand_spec.foregrip,
            hand_spec.foregrip_contact,
            1.0,
            None,
        );
        let arm = animator.rifle_arm.expect("rifle arm bones");
        let legacy_off_axis = elbow_off_axis(&template, arm);
        let legacy_wrist = template
            .skeleton
            .bone_global(arm.hand)
            .transform_point(Vec3::ZERO);
        let legacy_shoulder = template
            .skeleton
            .bone_global(arm.upper)
            .transform_point(Vec3::ZERO);
        // The defect: the target is past the arm, so the elbow collapses.
        assert!(
            legacy_off_axis < 0.005,
            "expected a collapsed legacy elbow, got {legacy_off_axis} m off axis"
        );

        animator.update(&mut template, WeaponLane::Rifle, 0.0, false, true, 0.0);
        animator.apply_rifle_support_ik_weighted(
            &mut template,
            hand_spec.mount,
            hand_spec.foregrip,
            hand_spec.foregrip_contact,
            1.0,
            Some(posture),
        );
        let posed_off_axis = elbow_off_axis(&template, arm);
        let posed_shoulder = template
            .skeleton
            .bone_global(arm.upper)
            .transform_point(Vec3::ZERO);
        assert!(
            posed_off_axis > 0.06,
            "posture must restore a real elbow bend, got {posed_off_axis} m off axis"
        );
        // The girdle pays for the bend, bounded by the authored cap.
        let advance = posed_shoulder.sub(legacy_shoulder).length();
        assert!(
            advance > 0.04 && advance <= posture.shoulder_advance_max_m + 1.0e-4,
            "girdle advance {advance} m outside the authored cap"
        );
        // The support hand may not be traded away for the elbow: it still ends
        // no further from its contact than the locked-straight arm managed.
        let target = template
            .skeleton
            .bone_global(arm.weapon_hand)
            .mul(hand_spec.mount)
            .transform_point(hand_spec.foregrip.add(hand_spec.foregrip_contact));
        let posed_wrist = template
            .skeleton
            .bone_global(arm.hand)
            .transform_point(Vec3::ZERO);
        assert!(
            posed_wrist.sub(target).length() <= legacy_wrist.sub(target).length() + 1.0e-4,
            "posture pulled the support hand off its contact"
        );
    }

    #[test]
    fn posture_leaves_a_reachable_contact_alone() {
        let Some((mut template, mut animator, hand_spec)) = support_arm_fixture() else {
            return;
        };
        let posture = hand_spec
            .support_arm
            .expect("launcher authors a hold posture");
        animator.update(&mut template, WeaponLane::Rifle, 0.0, false, true, 0.0);
        let arm = animator.rifle_arm.expect("rifle arm bones");
        // A contact 0.3 m below the support shoulder is deep inside the arm's
        // 0.584 m: this is every pose of every weapon whose support socket was
        // authored within reach, and the girdle must stay out of it.
        let shoulder = template
            .skeleton
            .bone_global(arm.upper)
            .transform_point(Vec3::ZERO);
        let reachable = vec3(shoulder.x, shoulder.y - 0.3, shoulder.z);
        let mount = template
            .skeleton
            .bone_global(arm.weapon_hand)
            .inverse()
            .mul(Mat4::from_trs(reachable, Quat::IDENTITY, Vec3::ONE));

        animator.apply_rifle_support_ik_weighted(
            &mut template,
            mount,
            Vec3::ZERO,
            Vec3::ZERO,
            1.0,
            None,
        );
        let girdle = animator.pose[arm.shoulder_parent].r;
        let bare_shoulder = template
            .skeleton
            .bone_global(arm.upper)
            .transform_point(Vec3::ZERO);

        animator.update(&mut template, WeaponLane::Rifle, 0.0, false, true, 0.0);
        animator.apply_rifle_support_ik_weighted(
            &mut template,
            mount,
            Vec3::ZERO,
            Vec3::ZERO,
            1.0,
            Some(posture),
        );
        let posed_girdle = animator.pose[arm.shoulder_parent].r;
        let posed_shoulder = template
            .skeleton
            .bone_global(arm.upper)
            .transform_point(Vec3::ZERO);
        assert!(
            girdle.mul(quat_conjugate(posed_girdle)).w.abs() > 1.0 - 1.0e-6,
            "girdle must not swing for a contact the arm already reaches"
        );
        assert!(posed_shoulder.sub(bare_shoulder).length() < 1.0e-6);
    }
}
