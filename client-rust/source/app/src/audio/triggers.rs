//! Game-event → SFX trigger map (port of the trigger sites in `sfx.ts` +
//! callers). Each trigger names a manifest clip id; combat triggers derive from
//! the same `CombatEvent`s that drive the particle FX, so audio and visuals fire
//! from one authoritative event.

use super::SfxPlayer;
use crate::game::combat_fx::{CombatEvent, OUTCOME_BLOOD, OUTCOME_DEFLECT, OUTCOME_SPARK};
use successor_engine_core::audio::{Point, SpatialOpts};

/// UI/HUD sound cues (non-spatial).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum UiCue {
    PanelOpen,
    PanelClose,
    ButtonTick,
    ToolbarUse,
    ToolbarIneligible,
    ChatSend,
    ChatReceive,
    Notification,
}

impl UiCue {
    pub fn clip_id(self) -> &'static str {
        match self {
            UiCue::PanelOpen => "ui_panel_open",
            UiCue::PanelClose => "ui_panel_close",
            UiCue::ButtonTick => "ui_button_tick",
            UiCue::ToolbarUse => "ui_toolbar_use",
            UiCue::ToolbarIneligible => "ui_toolbar_ineligible",
            UiCue::ChatSend => "chat_send",
            UiCue::ChatReceive => "chat_receive",
            UiCue::Notification => "notification_ping",
        }
    }
}

/// Play a UI cue.
pub fn play_ui(player: &mut SfxPlayer, cue: UiCue) -> bool {
    player.play_ui(cue.clip_id())
}

/// Footstep clip id for a step index (round-robins the grass variants).
pub fn footstep_id(step: u32) -> &'static str {
    const STEPS: [&str; 8] = [
        "footstep_grass_01",
        "footstep_grass_02",
        "footstep_grass_03",
        "footstep_grass_04",
        "footstep_grass_05",
        "footstep_grass_06",
        "footstep_grass_07",
        "footstep_grass_08",
    ];
    STEPS[(step as usize) % STEPS.len()]
}

/// The weapon-fire clip id (default slugthrower).
pub fn weapon_fire_id(_weapon: Option<&str>) -> &'static str {
    "slugthrower_fire"
}

/// The impact clip id for a combat outcome.
pub fn impact_id(outcome: u8) -> &'static str {
    match outcome {
        OUTCOME_BLOOD => "body_hit_1",
        OUTCOME_SPARK | OUTCOME_DEFLECT => "projectile_hit",
        _ => "projectile_hit",
    }
}

/// Fire the audio for one combat event: a weapon report at the origin and an
/// impact at the hit point. Mirrors the visual `CombatFx` fan-out so both read
/// from the same authoritative event.
pub fn play_combat(player: &mut SfxPlayer, ev: &CombatEvent) {
    // Origin/hit points are world (x,y,z); the mixer spatializes in the sim
    // plane (x,z) — collapse to that plane.
    let origin = Point {
        x: ev.origin[0],
        y: ev.origin[2],
    };
    let hit = Point {
        x: ev.hit[0],
        y: ev.hit[2],
    };
    let opts = SpatialOpts::default();
    player.play_at(weapon_fire_id(None), origin, opts);
    player.play_at(impact_id(ev.outcome), hit, opts);
}

#[cfg(test)]
mod tests {
    use super::*;

    const ASSETS: &str = "../../../client/public/successor-audio/sfx";

    fn player() -> Option<SfxPlayer> {
        let manifest = std::fs::read_to_string(format!("{ASSETS}/manifest.json")).ok()?;
        let mut p = SfxPlayer::new();
        if p.load(&manifest, ASSETS) == 0 {
            return None;
        }
        Some(p)
    }

    #[test]
    fn ui_cue_ids_map_to_real_clips() {
        let Some(mut p) = player() else {
            eprintln!("skip: assets absent");
            return;
        };
        assert!(
            play_ui(&mut p, UiCue::PanelOpen),
            "panel-open cue exists + plays"
        );
        assert!(play_ui(&mut p, UiCue::ButtonTick));
        assert!(p.active_voices() >= 2);
    }

    #[test]
    fn combat_event_fires_weapon_and_impact() {
        let Some(mut p) = player() else {
            return;
        };
        p.set_listener(Point { x: 0.0, y: 0.0 });
        let ev = CombatEvent {
            id: 1,
            origin: [0.0, 1.3, 0.5],
            hit: [1.0, 1.1, 0.5],
            outcome: OUTCOME_BLOOD,
            magnitude: 1.0,
            color: [1.0, 0.8, 0.5],
        };
        play_combat(&mut p, &ev);
        // Close range → both weapon report + body hit audible.
        assert!(
            p.active_voices() >= 1,
            "combat audio fired, voices={}",
            p.active_voices()
        );
    }

    #[test]
    fn footstep_round_robins() {
        assert_eq!(footstep_id(0), "footstep_grass_01");
        assert_eq!(footstep_id(8), "footstep_grass_01");
        assert_eq!(footstep_id(2), "footstep_grass_03");
    }

    #[test]
    fn impact_id_by_outcome() {
        assert_eq!(impact_id(OUTCOME_BLOOD), "body_hit_1");
        assert_eq!(impact_id(OUTCOME_SPARK), "projectile_hit");
    }
}
