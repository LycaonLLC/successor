//! Creature lane — port of the rigged-creature routing in
//! `client-3d/src/render/pawns.ts` (`CREATURE_SPECIES_BY_SPRITE`,
//! `resolveCreatureAnimIntent`). Creatures are ordinary skinned GLBs (clips
//! `idle`/`walk`/`rest`/`feed`) so they reuse `PawnTemplate`; this adds the
//! sprite→species registry and the idle/walk/rest clip selection.

use super::pack::PawnTemplate;

const WALK_TIMESCALE_PER_CELLPERSEC: f32 = 1.0;
const WALK_TIMESCALE_MIN: f32 = 0.5;
const WALK_TIMESCALE_MAX: f32 = 1.6;
/// A creature is considered moving above this ground speed (cells/s).
const MOVE_START: f32 = 0.12;

#[derive(Clone, Copy, PartialEq, Debug)]
pub struct CreatureSpecies {
    pub species_id: &'static str,
    pub asset_path: &'static str,
    pub mesh_scale: f32,
    pub shadow_x: f32,
    pub shadow_z: f32,
}

/// Exact sprite key → species (the only creature routing table).
pub fn species_for_sprite(sprite: &str) -> Option<CreatureSpecies> {
    Some(match sprite {
        "creature-bellback-adult" => CreatureSpecies { species_id: "bellback", asset_path: "/assets/creatures/bellback_adult.glb", mesh_scale: 1.0, shadow_x: 0.5, shadow_z: 2.2 },
        "creature-pebblehorn-adult" => CreatureSpecies { species_id: "pebblehorn", asset_path: "/assets/creatures/pebblehorn_adult.glb", mesh_scale: 1.0, shadow_x: 1.45, shadow_z: 1.19 },
        "creature-snufflefin-adult" => CreatureSpecies { species_id: "snufflefin", asset_path: "/assets/creatures/snufflefin_adult.glb", mesh_scale: 2.4, shadow_x: 0.72, shadow_z: 3.29 },
        "creature-pocketclod-adult" => CreatureSpecies { species_id: "pocketclod", asset_path: "/assets/creatures/pocketclod_adult.glb", mesh_scale: 1.5, shadow_x: 0.95, shadow_z: 0.96 },
        "creature-mossmuff-adult" => CreatureSpecies { species_id: "mossmuff", asset_path: "/assets/creatures/mossmuff_adult.glb", mesh_scale: 1.0, shadow_x: 1.84, shadow_z: 1.56 },
        "creature-dapplepod-adult" => CreatureSpecies { species_id: "dapplepod", asset_path: "/assets/creatures/dapplepod_adult.glb", mesh_scale: 1.3, shadow_x: 0.68, shadow_z: 1.81 },
        _ => return None,
    })
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum CreatureClip {
    Idle,
    Walk,
    Rest,
}

impl CreatureClip {
    pub fn name(self) -> &'static str {
        match self {
            CreatureClip::Idle => "idle",
            CreatureClip::Walk => "walk",
            CreatureClip::Rest => "rest",
        }
    }
}

/// Pure state→clip mapping: dead/downed → rest, moving → walk, else idle.
pub fn resolve_creature_clip(speed_cells: f32, alive: bool) -> CreatureClip {
    if !alive {
        CreatureClip::Rest
    } else if speed_cells >= MOVE_START {
        CreatureClip::Walk
    } else {
        CreatureClip::Idle
    }
}

/// Walk clip time-scale: ~1× per cell/s, clamped so slow wander doesn't freeze
/// and far bursts don't strobe.
pub fn walk_timescale(speed_cells: f32) -> f32 {
    (speed_cells * WALK_TIMESCALE_PER_CELLPERSEC).clamp(WALK_TIMESCALE_MIN, WALK_TIMESCALE_MAX)
}

/// A creature instance: a `PawnTemplate` (the skinned GLB) + clip playback.
pub struct CreatureAnimator {
    pose: Vec<successor_engine_core::anim::JointTransform>,
    palette: Vec<[f32; 16]>,
    time: f32,
    clip: CreatureClip,
}

impl CreatureAnimator {
    pub fn new(template: &PawnTemplate) -> Self {
        CreatureAnimator {
            pose: template.rest_pose(),
            palette: Vec::with_capacity(template.joint_count()),
            time: 0.0,
            clip: CreatureClip::Idle,
        }
    }

    pub fn update(&mut self, template: &mut PawnTemplate, speed_cells: f32, alive: bool, dt: f32) -> &[[f32; 16]] {
        self.clip = resolve_creature_clip(speed_cells, alive);
        let name = self.clip.name();
        let ts = if self.clip == CreatureClip::Walk { walk_timescale(speed_cells) } else { 1.0 };
        let duration = template.animation(name).map(|a| a.duration.max(0.001)).unwrap_or(1.0);
        self.time = (self.time + dt * ts) % duration;
        template.pose_at(name, self.time, &mut self.pose);
        template.skeleton.compute_palette(&self.pose, &mut self.palette);
        &self.palette
    }

    pub fn palette(&self) -> &[[f32; 16]] {
        &self.palette
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registry_lookup() {
        let b = species_for_sprite("creature-bellback-adult").unwrap();
        assert_eq!(b.species_id, "bellback");
        assert_eq!(species_for_sprite("creature-snufflefin-adult").unwrap().mesh_scale, 2.4);
        assert!(species_for_sprite("player").is_none());
    }

    #[test]
    fn clip_selection() {
        assert_eq!(resolve_creature_clip(0.0, true), CreatureClip::Idle);
        assert_eq!(resolve_creature_clip(1.0, true), CreatureClip::Walk);
        assert_eq!(resolve_creature_clip(1.0, false), CreatureClip::Rest);
        assert!((walk_timescale(0.1) - 0.5).abs() < 1e-6); // clamped up
        assert!((walk_timescale(9.0) - 1.6).abs() < 1e-6); // clamped down
    }

    #[test]
    fn loads_real_creature_template() {
        let path = "../../../client-3d/public/assets/creatures/bellback_adult.glb";
        let Ok(bytes) = std::fs::read(path) else {
            eprintln!("skip: {path} not present");
            return;
        };
        let tpl = PawnTemplate::from_bytes(&bytes).expect("parse creature");
        assert!(tpl.joint_count() > 0);
        let clips = tpl.clip_names();
        assert!(clips.contains(&"idle") && clips.contains(&"walk") && clips.contains(&"rest"));
    }
}
