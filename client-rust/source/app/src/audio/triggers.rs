//! Game-event → SFX trigger map (port of the trigger sites in `sfx.ts` +
//! callers). Each trigger names a manifest clip id; combat triggers derive
//! from the same authoritative `CombatEvent`s that drive the particle FX, so
//! audio and visuals fire from one event. Ambience/doors/loop triggers are
//! keyed, bounded, and always stoppable (no orphaned loops).

use super::SfxPlayer;
use crate::game::combat_fx::{CombatEvent, CombatOutcome, WeaponVisual};
use crate::world::terrain::Biome;
use successor_engine_core::audio::{Point, SpatialOpts};

/// Minimum separation in milliseconds between consecutive plays of the same UI cue.
///
/// At 60 Hz, a single frame is ~16.67ms. If multiple events fire the same cue in a
/// single frame or adjacent frames (e.g. bulk loot processing, multi-item transfers,
/// or rapid key repeat), playing identical PCM buffers simultaneously produces
/// constructive phase alignment resulting in digital clipping and an unpleasantly
/// loud click storm. A 35ms retrigger floor suppresses intra-frame and immediate
/// sub-frame duplicates while remaining fully responsive to intentional consecutive
/// user clicks (which typically have >= 100ms separation).
pub const UI_CUE_RETRIGGER_FLOOR_MS: u64 = 35;

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
    Deny,
    CreditsChime,
    ItemTransfer,
    AreaTransition,
}

impl UiCue {
    pub const ALL: [UiCue; 12] = [
        UiCue::PanelOpen,
        UiCue::PanelClose,
        UiCue::ButtonTick,
        UiCue::ToolbarUse,
        UiCue::ToolbarIneligible,
        UiCue::ChatSend,
        UiCue::ChatReceive,
        UiCue::Notification,
        UiCue::Deny,
        UiCue::CreditsChime,
        UiCue::ItemTransfer,
        UiCue::AreaTransition,
    ];

    pub fn index(self) -> usize {
        match self {
            UiCue::PanelOpen => 0,
            UiCue::PanelClose => 1,
            UiCue::ButtonTick => 2,
            UiCue::ToolbarUse => 3,
            UiCue::ToolbarIneligible => 4,
            UiCue::ChatSend => 5,
            UiCue::ChatReceive => 6,
            UiCue::Notification => 7,
            UiCue::Deny => 8,
            UiCue::CreditsChime => 9,
            UiCue::ItemTransfer => 10,
            UiCue::AreaTransition => 11,
        }
    }

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
            UiCue::Deny => "ui_deny",
            UiCue::CreditsChime => "credits_chime",
            UiCue::ItemTransfer => "item_transfer",
            UiCue::AreaTransition => "area_transition",
        }
    }
}

thread_local! {
    static LAST_CUE_TIMES: std::cell::RefCell<[Option<std::time::Instant>; 12]> =
        const { std::cell::RefCell::new([None; 12]) };
}

/// Reset the per-cue retrigger floor timers (primarily for deterministic unit testing).
pub fn clear_retrigger_floor() {
    LAST_CUE_TIMES.with(|cell| {
        *cell.borrow_mut() = [None; 12];
    });
}

/// Play a UI cue, applying the per-cue retrigger floor to prevent click storms.
pub fn play_ui(player: &mut SfxPlayer, cue: UiCue) -> bool {
    let now = std::time::Instant::now();
    let idx = cue.index();
    let floor = std::time::Duration::from_millis(UI_CUE_RETRIGGER_FLOOR_MS);

    let too_soon = LAST_CUE_TIMES.with(|cell| {
        let mut times = cell.borrow_mut();
        if let Some(last) = times[idx] {
            if now.duration_since(last) < floor {
                return true;
            }
        }
        times[idx] = Some(now);
        false
    });

    if too_soon {
        return false;
    }

    player.play_ui(cue.clip_id())
}

/// Footstep clip id for a step index on a surface family. Desert/forest
/// overworld ground round-robins the grass variants; interiors use tile.
pub fn footstep_id(step: u32, interior: bool) -> &'static str {
    const GRASS: [&str; 8] = [
        "footstep_grass_01",
        "footstep_grass_02",
        "footstep_grass_03",
        "footstep_grass_04",
        "footstep_grass_05",
        "footstep_grass_06",
        "footstep_grass_07",
        "footstep_grass_08",
    ];
    const TILE: [&str; 8] = [
        "footstep_tile_01",
        "footstep_tile_02",
        "footstep_tile_03",
        "footstep_tile_04",
        "footstep_tile_05",
        "footstep_tile_06",
        "footstep_tile_07",
        "footstep_tile_08",
    ];
    let table = if interior { &TILE } else { &GRASS };
    table[(step as usize) % table.len()]
}

/// The weapon-fire clip id for the event's weapon family.
pub fn weapon_fire_id(weapon: WeaponVisual) -> &'static str {
    match weapon {
        WeaponVisual::Plasma => "gunshot_4",
        WeaponVisual::Melee => "saber_deflect_01",
        WeaponVisual::Slugthrower | WeaponVisual::Unknown => "slugthrower_fire",
    }
}

/// The impact clip id for a combat outcome (None → intentionally silent).
pub fn impact_id(outcome: CombatOutcome) -> Option<&'static str> {
    match outcome {
        CombatOutcome::Blood => Some("body_hit_1"),
        CombatOutcome::Spark => Some("projectile_hit"),
        CombatOutcome::Deflect => Some("ricochet_ping"),
        CombatOutcome::Dodge => None,
        CombatOutcome::Sleep => Some("sleep_puff_soft_01"),
    }
}

/// The door slide clip (fixture props, buildings, and camp auto-doors share
/// the ratified door).
pub const DOOR_CLIP: &str = "door_slide";
/// Death sting (target killed).
pub const DEATH_CLIP: &str = "death";
/// Reload pair.
pub const RELOAD_CLIP: &str = "slugthrower_reload";

/// Fire the audio for one combat event at its resolved world points: a weapon
/// report at the origin (ranged only) and the outcome impact at the hit
/// point. Mirrors the visual `CombatFx` fan-out so both read one event.
pub fn play_combat(
    player: &mut SfxPlayer,
    ev: &CombatEvent,
    origin_world: [f32; 3],
    hit_world: [f32; 3],
) {
    let opts = SpatialOpts::default();
    if ev.ranged {
        let origin = Point {
            x: origin_world[0],
            y: origin_world[2],
        };
        player.play_at(weapon_fire_id(ev.weapon), origin, opts);
    }
    let hit = Point {
        x: hit_world[0],
        y: hit_world[2],
    };
    if let Some(clip) = impact_id(ev.outcome) {
        player.play_at(clip, hit, opts);
    }
    if ev.killed {
        player.play_at(DEATH_CLIP, hit, opts);
    }
}

/// One-shot ambience beds per biome/day-phase — bounded, no loop lifecycle.
/// Returns the clip id to fire when the ambience timer elapses.
pub fn ambience_one_shot(biome: Biome, is_day: bool, roll: u32) -> &'static str {
    const DESERT_DAY: [&str; 6] = [
        "amb_desert_bird_01",
        "amb_desert_bird_02",
        "amb_desert_bird_03",
        "amb_desert_crow_01",
        "amb_desert_twig_01",
        "amb_desert_twig_02",
    ];
    const DESERT_NIGHT: [&str; 2] = [
        "amb_night_cricket_distant_01",
        "amb_night_cricket_distant_02",
    ];
    const FOREST_DAY: [&str; 4] = [
        "amb_desert_bird_04",
        "amb_desert_bird_05",
        "amb_desert_bird_06",
        "amb_desert_twig_03",
    ];
    match (biome, is_day) {
        (Biome::Desert, true) => DESERT_DAY[(roll as usize) % DESERT_DAY.len()],
        (_, false) => DESERT_NIGHT[(roll as usize) % DESERT_NIGHT.len()],
        (Biome::Forest, true) => FOREST_DAY[(roll as usize) % FOREST_DAY.len()],
    }
}
/// Canonical open-desert score selection. Combat alternates only when a new
/// combat session starts; callers keep the selected index stable until combat
/// ends so frame updates never restart or thrash the music loop.
pub fn open_desert_music_id(is_day: bool, in_combat: bool, combat_index: u32) -> &'static str {
    if in_combat {
        if combat_index.is_multiple_of(2) {
            "music_combat_sandstorm_run_loop"
        } else {
            "music_combat_red_dunes_loop"
        }
    } else if is_day {
        "music_desert_day_dust_silent_world_loop"
    } else {
        "music_desert_night_sleeping_city_loop"
    }
}

/// Low settlement bed shared with the browser open-desert profile.
pub const SETTLEMENT_LOOP: &str = "settlement_murmur_loop";

/// Weather loop clip for the current streamed weather, if any.
pub fn weather_loop_id(
    kind: successor_engine_render::weather::WeatherKind,
    intensity: f32,
) -> Option<&'static str> {
    use successor_engine_render::weather::WeatherKind;
    match kind {
        WeatherKind::Rain if intensity >= 0.55 => Some("rain_heavy_loop"),
        WeatherKind::Rain => Some("rain_light_loop"),
        // The dust bed reuses the settlement murmur-free desert music stem's
        // silence; dust reads through particles + grade, not a loop.
        WeatherKind::DustStorm | WeatherKind::Clear => None,
    }
}

/// Campfire crackle loop (placed camps / campfire props).
pub const CAMPFIRE_LOOP: &str = "campfire_crackle_loop";

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
        clear_retrigger_floor();
        assert!(play_ui(&mut p, UiCue::PanelOpen));
        assert!(play_ui(&mut p, UiCue::ButtonTick));
        assert!(p.active_voices() >= 2);
    }

    #[test]
    fn all_ui_cues_map_to_real_clips() {
        let Some(mut p) = player() else {
            eprintln!("skip: assets absent");
            return;
        };
        for cue in UiCue::ALL {
            clear_retrigger_floor();
            let clip_id = cue.clip_id();
            assert!(
                play_ui(&mut p, cue),
                "UiCue::{cue:?} with clip_id '{clip_id}' failed to play"
            );
        }
    }

    #[test]
    fn ui_cue_retrigger_floor_suppresses_bursts() {
        let Some(mut p) = player() else {
            return;
        };
        clear_retrigger_floor();
        // First trigger plays
        assert!(play_ui(&mut p, UiCue::ButtonTick));
        // Immediate duplicate trigger suppressed by retrigger floor
        assert!(!play_ui(&mut p, UiCue::ButtonTick));
        // Distinct cue variant plays independently
        assert!(play_ui(&mut p, UiCue::ItemTransfer));
        // Wait out the floor duration
        std::thread::sleep(std::time::Duration::from_millis(UI_CUE_RETRIGGER_FLOOR_MS + 5));
        // Play succeeds again after floor elapses
        assert!(play_ui(&mut p, UiCue::ButtonTick));
    }

    #[test]
    fn combat_event_fires_weapon_and_impact() {
        let Some(mut p) = player() else {
            return;
        };
        p.set_listener(Point { x: 0.0, y: 0.0 });
        let ev = CombatEvent {
            id: 1,
            tick: 0,
            shooter_actor_id: "a".into(),
            target_actor_id: "b".into(),
            origin: Some([0.0, 0.5]),
            hit_point: Some([1.0, 0.5]),
            damage: 12.0,
            outcome: CombatOutcome::Blood,
            killed: false,
            downed: false,
            ranged: true,
            weapon: WeaponVisual::Slugthrower,
        };
        play_combat(&mut p, &ev, [0.0, 1.3, 0.5], [1.0, 1.0, 0.5]);
        assert!(p.active_voices() >= 1, "voices={}", p.active_voices());
    }
    #[test]
    fn footstep_round_robins_by_surface() {
        assert_eq!(footstep_id(0, false), "footstep_grass_01");
        assert_eq!(footstep_id(8, false), "footstep_grass_01");
        assert_eq!(footstep_id(2, true), "footstep_tile_03");
    }

    #[test]
    fn impact_id_by_outcome() {
        assert_eq!(impact_id(CombatOutcome::Blood), Some("body_hit_1"));
        assert_eq!(impact_id(CombatOutcome::Spark), Some("projectile_hit"));
        assert_eq!(impact_id(CombatOutcome::Deflect), Some("ricochet_ping"));
        assert_eq!(impact_id(CombatOutcome::Dodge), None, "dodge is silent");
    }

    #[test]
    fn ambience_tables_never_panic_and_stay_in_family() {
        for roll in 0..16 {
            assert!(ambience_one_shot(Biome::Desert, true, roll).starts_with("amb_"));
            assert!(ambience_one_shot(Biome::Forest, true, roll).starts_with("amb_"));
            assert!(ambience_one_shot(Biome::Desert, false, roll).starts_with("amb_night"));
        }
    }

    #[test]
    fn open_desert_score_tracks_day_night_and_stable_combat_rotation() {
        assert_eq!(
            open_desert_music_id(true, false, 0),
            "music_desert_day_dust_silent_world_loop"
        );
        assert_eq!(
            open_desert_music_id(false, false, 0),
            "music_desert_night_sleeping_city_loop"
        );
        assert_eq!(
            open_desert_music_id(true, true, 0),
            "music_combat_sandstorm_run_loop"
        );
        assert_eq!(
            open_desert_music_id(false, true, 1),
            "music_combat_red_dunes_loop"
        );
    }

    #[test]
    fn open_desert_score_ids_map_to_real_loop_clips() {
        let Some(mut p) = player() else {
            return;
        };
        for (index, id) in [
            open_desert_music_id(true, false, 0),
            open_desert_music_id(false, false, 0),
            open_desert_music_id(true, true, 0),
            open_desert_music_id(true, true, 1),
            SETTLEMENT_LOOP,
        ]
        .into_iter()
        .enumerate()
        {
            let key = 0x4155_4400 + index as u32;
            assert!(p.play_loop(id, key, None, 1.0), "missing loop {id}");
            p.stop_loop(key);
        }
    }
}
