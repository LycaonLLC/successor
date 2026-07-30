use super::*;

#[cfg(test)]
pub(super) fn cover_score_for_actor(
    point: &CoverPointAuthorityState,
    actor: &ActorAuthorityState,
    threat: AuthorityPosition,
    profile: SkirmisherProfile,
) -> i64 {
    cover_score_for_tactical_candidate(TacticalCoverScoreRequest {
        rating_milli: point.rating_milli,
        high: point.high,
        anchor_profile: profile.variant == SkirmisherVariant::Anchor,
        actor_distance_milli: position_distance_milli(actor.position, point.position),
        threat_distance_milli: position_distance_milli(threat, point.position),
    })
}

pub(super) fn skirmisher_profile_for_actor(
    actor: &ActorAuthorityState,
    seed: u32,
) -> SkirmisherProfile {
    let variant = skirmisher_variant_for_role(&actor.role, seed);
    match variant {
        SkirmisherVariant::Assault => SkirmisherProfile {
            variant,
            speed_milli_cells_per_second: 5_810,
            min_range_milli: 4_200,
            preferred_range_milli: 8_000,
            max_range_milli: 14_500,
            cover_search_radius_milli: 10_500,
            cover_pressure_milli: 24_000,
            low_action_cover_percent: 20,
            shot_cooldown_min_ticks: 8,
            shot_cooldown_max_ticks: 24,
            burst_min_shots: 4,
            burst_max_shots: 7,
            lateral_move_chance_milli: 760,
            hold_cover_between_shots: true,
        },
        SkirmisherVariant::Anchor => SkirmisherProfile {
            variant,
            speed_milli_cells_per_second: 4_830,
            min_range_milli: 6_000,
            preferred_range_milli: 10_000,
            max_range_milli: 16_500,
            cover_search_radius_milli: 14_500,
            cover_pressure_milli: 7_000,
            low_action_cover_percent: 48,
            shot_cooldown_min_ticks: 18,
            shot_cooldown_max_ticks: 44,
            burst_min_shots: 2,
            burst_max_shots: 4,
            lateral_move_chance_milli: 300,
            hold_cover_between_shots: true,
        },
        SkirmisherVariant::Flanker => SkirmisherProfile {
            variant,
            speed_milli_cells_per_second: 6_090,
            min_range_milli: 4_500,
            preferred_range_milli: 8_500,
            max_range_milli: 15_500,
            cover_search_radius_milli: 12_500,
            cover_pressure_milli: 16_000,
            low_action_cover_percent: 28,
            shot_cooldown_min_ticks: 10,
            shot_cooldown_max_ticks: 30,
            burst_min_shots: 2,
            burst_max_shots: 5,
            lateral_move_chance_milli: 860,
            hold_cover_between_shots: true,
        },
        SkirmisherVariant::Deadeye => SkirmisherProfile {
            variant,
            speed_milli_cells_per_second: 4_550,
            min_range_milli: 8_000,
            preferred_range_milli: 13_000,
            max_range_milli: 18_000,
            cover_search_radius_milli: 15_000,
            cover_pressure_milli: 9_000,
            low_action_cover_percent: 40,
            shot_cooldown_min_ticks: 22,
            shot_cooldown_max_ticks: 48,
            burst_min_shots: 1,
            burst_max_shots: 3,
            lateral_move_chance_milli: 320,
            hold_cover_between_shots: true,
        },
        SkirmisherVariant::Brawler => SkirmisherProfile {
            variant,
            speed_milli_cells_per_second: 8_650,
            min_range_milli: 0,
            preferred_range_milli: 1_700,
            max_range_milli: 2_250,
            cover_search_radius_milli: 2_500,
            cover_pressure_milli: 140_000,
            low_action_cover_percent: 0,
            shot_cooldown_min_ticks: BRAWLER_STOCK_MELEE_COOLDOWN_TICKS,
            shot_cooldown_max_ticks: BRAWLER_STOCK_MELEE_COOLDOWN_TICKS,
            burst_min_shots: 1,
            burst_max_shots: 1,
            lateral_move_chance_milli: 40,
            hold_cover_between_shots: false,
        },
        SkirmisherVariant::Trooper => SkirmisherProfile {
            variant,
            speed_milli_cells_per_second: ROGUE_TROOPER_SPEED_MILLI_CELLS_PER_SECOND,
            min_range_milli: if is_rogue_trooper_actor(actor) {
                ROGUE_TROOPER_MIN_RANGE_MILLI_CELLS
            } else {
                SKIRMISHER_MIN_RANGE_MILLI_CELLS
            },
            preferred_range_milli: if is_rogue_trooper_actor(actor) {
                ROGUE_TROOPER_PREFERRED_RANGE_MILLI_CELLS
            } else {
                SKIRMISHER_PREFERRED_RANGE_MILLI_CELLS
            },
            max_range_milli: if is_rogue_trooper_actor(actor) {
                ROGUE_TROOPER_MAX_RANGE_MILLI_CELLS
            } else {
                SKIRMISHER_MAX_RANGE_MILLI_CELLS
            },
            cover_search_radius_milli: if is_rogue_trooper_actor(actor) {
                3_000
            } else {
                ROGUE_TROOPER_COVER_SEARCH_RADIUS_MILLI_CELLS
            },
            cover_pressure_milli: if is_rogue_trooper_actor(actor) {
                120_000
            } else {
                ROGUE_TROOPER_SUPPRESSION_COVER_MILLI
            },
            low_action_cover_percent: if is_rogue_trooper_actor(actor) { 0 } else { 45 },
            shot_cooldown_min_ticks: ROGUE_TROOPER_SHOT_COOLDOWN_MIN_TICKS,
            shot_cooldown_max_ticks: ROGUE_TROOPER_SHOT_COOLDOWN_MAX_TICKS,
            burst_min_shots: ROGUE_TROOPER_BURST_MIN_SHOTS,
            burst_max_shots: ROGUE_TROOPER_BURST_MAX_SHOTS,
            lateral_move_chance_milli: if is_rogue_trooper_actor(actor) {
                60
            } else {
                360
            },
            hold_cover_between_shots: !is_rogue_trooper_actor(actor),
        },
    }
}

pub(super) fn skirmisher_profile_for_ai_state(actor: &ActorAuthorityState) -> SkirmisherProfile {
    let seed = match actor.ai.as_ref() {
        Some(AuthorityAiState::Skirmisher(ai)) => ai.seed,
        _ => 0,
    };
    let profile = skirmisher_profile_for_actor(actor, seed);
    agent_player_combat_profile(actor, profile)
}

pub(super) fn skirmisher_micro_reversal_blocked(
    actor: &ActorAuthorityState,
    tick: u64,
    move_dx: i32,
    move_dy: i32,
) -> bool {
    let Some(ai) = combat_micro_state(actor.ai.as_ref()) else {
        return false;
    };
    micro_reversal_blocked(MicroReversalRequest {
        tick,
        last_move_tick: ai.last_move_tick,
        last_move_dx_milli: ai.last_move_dx_milli,
        last_move_dy_milli: ai.last_move_dy_milli,
        move_dx_milli: move_dx,
        move_dy_milli: move_dy,
        window_ticks: SKIRMISHER_MICRO_REVERSAL_WINDOW_TICKS,
        max_step_milli: SKIRMISHER_MICRO_REVERSAL_STEP_MILLI_CELLS,
    })
}

pub(super) fn preserve_skirmisher_live_move_memory(
    next_ai: &mut AuthorityAiState,
    live_ai: Option<&AuthorityAiState>,
) {
    let Some(live_ai) = live_ai else {
        return;
    };
    let Some(live) = combat_micro_state(Some(live_ai)) else {
        return;
    };
    let Some(next) = combat_micro_state_mut(next_ai) else {
        return;
    };
    preserve_skirmisher_move_memory(next, live);
}

pub(super) fn combat_micro_state(ai: Option<&AuthorityAiState>) -> Option<&SkirmisherAiState> {
    match ai {
        Some(AuthorityAiState::Skirmisher(ai)) => Some(ai),
        _ => None,
    }
}

pub(super) fn combat_micro_state_mut(ai: &mut AuthorityAiState) -> Option<&mut SkirmisherAiState> {
    match ai {
        AuthorityAiState::Skirmisher(ai) => Some(ai),
        _ => None,
    }
}

pub(super) fn skirmisher_variant_for_role(role: &str, _seed: u32) -> SkirmisherVariant {
    match role {
        "skirmisher_brawler" => SkirmisherVariant::Brawler,
        "skirmisher_assault" => SkirmisherVariant::Assault,
        "skirmisher_anchor" => SkirmisherVariant::Anchor,
        "skirmisher_flanker" => SkirmisherVariant::Flanker,
        "skirmisher_deadeye" => SkirmisherVariant::Deadeye,
        "skirmisher" => SkirmisherVariant::Trooper,
        _ if is_skirmisher_role(role) => SkirmisherVariant::Trooper,
        _ => SkirmisherVariant::Trooper,
    }
}

pub(super) const BRAWLER_SHIELD_DISENGAGE_CHARGE_MILLI: u32 = PERSONAL_SHIELD_MAX_CHARGE_MILLI / 3;
const BRAWLER_STOCK_MELEE_COOLDOWN_TICKS: u64 = 150;

pub(super) fn brawler_personal_shield_ready_for_assault(actor: &ActorAuthorityState) -> bool {
    actor
        .personal_shield
        .as_ref()
        .is_some_and(|shield| shield.charge_milli > BRAWLER_SHIELD_DISENGAGE_CHARGE_MILLI)
}

pub(super) fn agent_player_combat_profile(
    actor: &ActorAuthorityState,
    mut profile: SkirmisherProfile,
) -> SkirmisherProfile {
    if actor.role.as_str() != "agent_player" {
        return profile;
    }

    if actor.equipped_weapon_id.is_some_and(is_melee_weapon_id)
        || actor.professions.has(AuthorityProfessionKind::Brawler)
    {
        profile.variant = SkirmisherVariant::Brawler;
        profile.speed_milli_cells_per_second = 9_200;
        profile.min_range_milli = 0;
        profile.preferred_range_milli = 1_550;
        profile.max_range_milli = 2_250;
        profile.cover_search_radius_milli = 2_000;
        profile.cover_pressure_milli = 160_000;
        profile.low_action_cover_percent = if brawler_personal_shield_ready_for_assault(actor) {
            0
        } else {
            18
        };
        profile.shot_cooldown_min_ticks = BRAWLER_STOCK_MELEE_COOLDOWN_TICKS;
        profile.shot_cooldown_max_ticks = BRAWLER_STOCK_MELEE_COOLDOWN_TICKS;
        profile.burst_min_shots = 1;
        profile.burst_max_shots = 1;
        profile.lateral_move_chance_milli = if brawler_personal_shield_ready_for_assault(actor) {
            20
        } else {
            80
        };
        profile.hold_cover_between_shots = false;
        return profile;
    }

    profile.variant = SkirmisherVariant::Flanker;
    profile.speed_milli_cells_per_second = AGENT_PLAYER_TACTICAL_SPEED_MILLI_CELLS_PER_SECOND;
    profile.min_range_milli = AGENT_PLAYER_MIN_RANGE_MILLI_CELLS;
    profile.preferred_range_milli = AGENT_PLAYER_PREFERRED_RANGE_MILLI_CELLS;
    profile.max_range_milli = AGENT_PLAYER_MAX_RANGE_MILLI_CELLS;
    profile.cover_search_radius_milli = AGENT_PLAYER_COVER_SEARCH_RADIUS_MILLI_CELLS;
    profile.cover_pressure_milli = AGENT_PLAYER_SUPPRESSION_COVER_MILLI;
    profile.low_action_cover_percent = AGENT_PLAYER_LOW_ACTION_COVER_PERCENT;
    profile.shot_cooldown_min_ticks = AGENT_PLAYER_SHOT_COOLDOWN_MIN_TICKS;
    profile.shot_cooldown_max_ticks = AGENT_PLAYER_SHOT_COOLDOWN_MAX_TICKS;
    profile.burst_min_shots = AGENT_PLAYER_BURST_MIN_SHOTS;
    profile.burst_max_shots = AGENT_PLAYER_BURST_MAX_SHOTS;
    profile.lateral_move_chance_milli = 940;
    profile.hold_cover_between_shots = true;
    profile
}

pub(super) fn skirmisher_maneuver_step_milli(
    base_step_milli: i32,
    reason: &str,
    under_fire: bool,
) -> i32 {
    tactical_maneuver_step_milli(TacticalManeuverRequest {
        reason,
        under_fire,
        base_step_milli,
    })
}

pub(super) fn skirmisher_cover_threat(
    actor: &ActorAuthorityState,
    fallback_target: AuthorityPosition,
) -> AuthorityPosition {
    actor.suppression.source.unwrap_or(fallback_target)
}

pub(super) fn is_skirmisher_role(role: &str) -> bool {
    role == "skirmisher" || role.starts_with("skirmisher_")
}

pub(super) fn is_rogue_trooper_actor(actor: &ActorAuthorityState) -> bool {
    actor.faction.faction_id.as_deref() == Some("rogue_troopers")
        || actor.faction.social_group.as_deref() == Some("open_desert_rogues")
}

pub(super) fn actor_uses_passive_rogue_attitude(actor: &ActorAuthorityState) -> bool {
    is_skirmisher_role(&actor.role)
        && actor.faction.social_group.as_deref() == Some("open_desert_rogues")
}

pub(super) fn actor_ai_attitude(actor: &ActorAuthorityState) -> Option<NpcAiAttitude> {
    match actor.ai.as_ref()? {
        AuthorityAiState::Skirmisher(ai) if actor_uses_passive_rogue_attitude(actor) => {
            Some(ai.attitude)
        }
        _ => None,
    }
}

/// Threat legibility (owner ruling 2026-07-08): will this actor's brain
/// proactively initiate hostilities (auto-aggro), or only retaliate when
/// attacked (provoked-only)? RED nameplate = auto-aggro, YELLOW = won't aggro
/// unless attacked. Recomputed per snapshot from the LIVE attitude so a provoked
/// open-desert passive rogue flips RED on the hostile transition and decays back
/// to YELLOW with the attitude system.
///
/// SEAM: faction-reputation thresholds (owner: "come later") will gate this per
/// observer; today it is a global disposition read.
pub(super) fn actor_will_auto_aggro(actor: &ActorAuthorityState) -> bool {
    match actor.ai.as_ref() {
        Some(AuthorityAiState::Skirmisher(ai)) => {
            if actor_uses_passive_rogue_attitude(actor) {
                // Open-desert passive rogues hold passive/alerted and only turn
                // hostile on attack or same-`socialGroup` social assist
                // (`tick_ai_attitudes`). Auto-aggro exactly while hostile.
                ai.attitude == NpcAiAttitude::Hostile
            } else {
                // Every other skirmisher runs the engagement brain that
                // proactively acquires and fires on hostile-faction targets.
                true
            }
        }
        // Wildlife roams or flees and never proactively acquires combat targets.
        Some(AuthorityAiState::PassiveCreature(_)) => creature_species_is_proactive(actor),
        None => false,
    }
}

pub(super) fn reset_passive_rogue_attitude(actor: &mut ActorAuthorityState) {
    if !actor_uses_passive_rogue_attitude(actor) {
        return;
    }
    if let Some(AuthorityAiState::Skirmisher(ai)) = actor.ai.as_mut() {
        hold_skirmisher_passive(ai);
        ai.attitude = NpcAiAttitude::Passive;
        ai.alert_until_tick = 0;
    }
    actor.engagement_target_id = None;
    actor.combat_queue = AbilityQueue::default();
}

pub(super) fn hold_skirmisher_passive(ai: &mut SkirmisherAiState) {
    ai.mode = SkirmisherMode::HoldCover;
    ai.target_actor_id = None;
    ai.target = None;
    ai.cover = None;
    ai.burst_shots_remaining = 0;
}

pub(super) fn set_skirmisher_engagement_target(
    actor: &mut ActorAuthorityState,
    target_actor_id: &str,
) {
    actor.engagement_target_id = Some(target_actor_id.to_owned());
    if let Some(AuthorityAiState::Skirmisher(ai)) = actor.ai.as_mut() {
        ai.target_actor_id = Some(target_actor_id.to_owned());
        ai.target = None;
        ai.cover = None;
        ai.mode = SkirmisherMode::Engage;
    }
}

// ---------------------------------------------------------------------------
// Deterministic NPC presentation (deterministic NPC naming doctrine).
//
// EVERY non-player actor gets a GENERATED display identity — NEVER a numbered
// or bare-class label ("Rogue Drifter 1" is banned everywhere). The name is
// (re)generated on spawn/load/respawn seeded ONLY on stable spawn identity
// (actor id + lifecycle_seq + deaths): deterministic + replay-exact, NO
// wall-clock. The `descriptor` (actor descriptor, e.g. "a rogue drifter") is
// derived from role/faction/social group and is stable across respawns.
// ---------------------------------------------------------------------------

// Shared humanoid name banks. Expanded from the original 16x16 so a full
// open-world population (hundreds of spawns) collides rarely; collisions are
// tolerated (two drifters may share a name, as in life).
const HUMANOID_FORENAMES: &[&str] = &[
    "Kade", "Rook", "Vexa", "Juno", "Mika", "Sable", "Nyx", "Dax", "Vera", "Tor", "Zed", "Lio",
    "Nero", "Kira", "Vale", "Mori", "Bex", "Cass", "Dane", "Esk", "Fira", "Garo", "Hale", "Ivo",
    "Jax", "Kem", "Lira", "Mott", "Nadd", "Orin", "Pell", "Quill", "Rhea", "Sten", "Tavi", "Ulla",
    "Varo", "Wrenn", "Yara", "Zane",
];
const HUMANOID_SURNAMES: &[&str] = &[
    "Rill", "Vane", "Maddox", "Sorn", "Kett", "Vale", "Dray", "Lask", "Nix", "Morrow", "Pike",
    "Rook", "Tarn", "Wex", "Brant", "Crow", "Ash", "Kline", "Vell", "Coil", "Fuse", "Grale",
    "Hark", "Ives", "Joss", "Kane", "Lund", "Mabe", "Orr", "Pryn", "Rusk", "Skell", "Thane",
    "Vott", "Ward", "Yorn",
];
const ADVENTURER_PREMIUM_SPRITES: &[&str] =
    &["adventurer-premium-male", "adventurer-premium-female"];

// Restrained epithets for the Gaia wildlife wave — calm herbivore reads only,
// never predatory/aggressive vocabulary.
const GAIA_CREATURE_EPITHETS: &[&str] = &[
    "grazer", "forager", "roamer", "wanderer", "browser", "nibbler", "ambler", "dozer",
];

/// Exact adult sprite registry for the Gaia creature wave (2026-07-12).
/// Species base + descriptor derive from THIS table only; an unknown
/// `creature` sprite falls back to the plain "creature" read.
const GAIA_SPECIES_SPRITES: &[(&str, &str)] = &[
    ("creature-bellback-adult", "bellback"),
    ("creature-pebblehorn-adult", "pebblehorn"),
    ("creature-snufflefin-adult", "snufflefin"),
    ("creature-pocketclod-adult", "pocketclod"),
    ("creature-mossmuff-adult", "mossmuff"),
    ("creature-dapplepod-adult", "dapplepod"),
];

/// The Gaia wildlife naming lane.
pub(super) fn is_creature_naming_actor(actor: &ActorAuthorityState) -> bool {
    actor.role == "creature"
}

fn gaia_species_from_sprite(sprite: &str) -> Option<&'static str> {
    GAIA_SPECIES_SPRITES
        .iter()
        .find(|(registered, _)| *registered == sprite)
        .map(|(_, species)| *species)
}

fn creature_species_base(actor: &ActorAuthorityState) -> &'static str {
    gaia_species_from_sprite(&actor.sprite).unwrap_or("creature")
}

/// First-wave Gaia danger: Bellback acquires living hostile players in range.
pub(super) fn creature_species_is_proactive(actor: &ActorAuthorityState) -> bool {
    matches!(creature_species_base(actor), "bellback")
}

/// First-wave Gaia danger: Pebblehorn retaliates after player damage.
pub(super) fn creature_species_is_retaliatory(actor: &ActorAuthorityState) -> bool {
    matches!(creature_species_base(actor), "pebblehorn")
}

/// True when the wildlife actor may enter Engage combat under species policy.
pub(super) fn creature_species_can_engage(actor: &ActorAuthorityState) -> bool {
    creature_species_is_proactive(actor) || creature_species_is_retaliatory(actor)
}

fn is_rogue_brawler_actor(actor: &ActorAuthorityState) -> bool {
    actor.role == "skirmisher_brawler"
}

fn indefinite_article(word: &str) -> &'static str {
    match word.chars().next() {
        Some(c) if "aeiouAEIOU".contains(c) => "an",
        _ => "a",
    }
}

/// The actor descriptor — lowercase-article style, derived from role/faction/social
/// group. Empty for human players (they name themselves). Stable across respawn.
pub(super) fn derive_actor_descriptor(actor: &ActorAuthorityState) -> String {
    if actor.role == "player" {
        return String::new();
    }
    if is_creature_naming_actor(actor) {
        let species = creature_species_base(actor);
        return format!("{} {species}", indefinite_article(species));
    }
    // Humanoid NPCs — social group first (drifter vs trooper), then faction, then role.
    if actor.faction.social_group.as_deref() == Some("open_desert_rogues") {
        return "a rogue drifter".to_owned();
    }
    if is_rogue_brawler_actor(actor) {
        return "a rogue brawler".to_owned();
    }
    if is_rogue_trooper_actor(actor) {
        return "a rogue trooper".to_owned();
    }
    // Service/role reads win over the faction fallback: a warden *trainer* is
    // "a profession trainer", not "a desert warden" (the faction line is for
    // the faction's combatants).
    match normalize_command_key(&actor.role).as_str() {
        "profession_trainer" => return "a profession trainer".to_owned(),
        "public_shopkeeper" | "vendor" | "shopkeeper" | "merchant" => {
            return "a shopkeeper".to_owned();
        }
        // `scripted_player` is the authored social-NPC lane. Keep the
        // implementation token out of the world-facing identity; exact body
        // presentation may provide a more useful species read without
        // inventing a job for the actor.
        "scripted_player" if actor.sprite == "droid-grok-humanoid" => {
            return "a humanoid droid".to_owned();
        }
        "scripted_player" => return "a civilian".to_owned(),
        "range_guard" => return "a range guard".to_owned(),
        "combat_npc" => return "a combatant".to_owned(),
        _ => {}
    }
    if actor.faction.faction_id.as_deref() == Some("desert_wardens") {
        return "a desert warden".to_owned();
    }
    // Generic fallback: a readable phrase from the role token.
    let pretty = actor.role.replace('_', " ");
    let pretty = pretty.trim();
    if pretty.is_empty() {
        String::new()
    } else {
        format!("{} {pretty}", indefinite_article(pretty))
    }
}

/// True when the DISPLAY NAME should be generated (vs. an authored personal name
/// preserved). Population spawns (the old prefix+ordinal source) and creatures
/// always generate; authored non-population humanoids keep their authored name
/// and receive only the derived descriptor.
fn should_generate_display_name(actor: &ActorAuthorityState) -> bool {
    is_creature_naming_actor(actor)
        || is_rogue_trooper_actor(actor)
        || (actor.spawn_zone_id.is_some() && actor.role != "player")
}

/// (Re)compute an NPC's full display identity: descriptor (always) + generated
/// name (when owned) + rogue sprite variance. No-op for human players.
pub(super) fn refresh_actor_presentation(actor: &mut ActorAuthorityState, _tick: u64) {
    if actor.role == "player" {
        // Players name themselves (charselect) and carry no NPC type line —
        // guarantee it even if a slot was ever repurposed from an NPC.
        actor.descriptor.clear();
        return;
    }
    actor.descriptor = derive_actor_descriptor(actor);

    if !should_generate_display_name(actor) {
        // Authored NPC (camp trainer, vendor, named guard): keep the authored
        // name; label and display_name stay in lockstep (bare name, no type).
        return;
    }

    let seed = string_hash32(&format!(
        "{}:{}:{}",
        actor.id, actor.lifecycle_seq, actor.stats.deaths
    ));

    let name = if is_creature_naming_actor(actor) {
        let base = creature_species_base(actor);
        let epithets = GAIA_CREATURE_EPITHETS;
        let epithet = epithets[presentation_index(seed, 0x9e37_79b1, epithets.len())];
        format!("{base} {epithet}")
    } else {
        let first =
            HUMANOID_FORENAMES[presentation_index(seed, 0x8a43_2d11, HUMANOID_FORENAMES.len())];
        let mut last =
            HUMANOID_SURNAMES[presentation_index(seed, 0x51f7_3319, HUMANOID_SURNAMES.len())];
        if first == last {
            last =
                HUMANOID_SURNAMES[presentation_index(seed, 0xb909_a6b5, HUMANOID_SURNAMES.len())];
        }
        format!("{first} {last}")
    };

    actor.display_name = name.clone();
    actor.label = name;

    if is_rogue_trooper_actor(actor) {
        actor.sprite = ADVENTURER_PREMIUM_SPRITES
            [presentation_index(seed, 0xce83_4d6f, ADVENTURER_PREMIUM_SPRITES.len())]
        .to_owned();
        reset_passive_rogue_attitude(actor);
    }
}

fn presentation_index(seed: u32, salt: u32, len: usize) -> usize {
    if len == 0 {
        return 0;
    }
    let mut value = seed ^ salt;
    value ^= value >> 16;
    value = value.wrapping_mul(0x7feb_352d);
    value ^= value >> 15;
    value = value.wrapping_mul(0x846c_a68b);
    value ^= value >> 16;
    usize::try_from(value).unwrap_or(0) % len
}

pub(super) fn actor_uses_combat_tactics(actor: &ActorAuthorityState) -> bool {
    is_skirmisher_role(&actor.role) || actor.role == "agent_player"
}

/// A protected civilian/service NPC: authored social actors, trainers, and
/// vendor/shopkeeper-class actors.
/// Never a valid combat target (DEF-10: the sim used to ACCEPT `basic_shot` on the
/// camp trainer). This is a POSITIVE list of service roles — practice dummies
/// (`target_dummy`), shootable props, and actual combatants are NOT civilians.
pub(super) fn is_noncombat_civilian_actor(actor: &ActorAuthorityState) -> bool {
    normalize_command_key(&actor.role) == "scripted_player"
        || is_profession_trainer_authority_actor(actor)
        || is_vendor_class_role(&actor.role)
}

/// Vendor/shopkeeper-class roles — the non-trainer half of the protected civilian
/// set. Kept as an explicit list so a new service role opts in deliberately.
pub(super) fn is_vendor_class_role(role: &str) -> bool {
    matches!(
        normalize_command_key(role).as_str(),
        "public_shopkeeper" | "vendor" | "shopkeeper" | "merchant"
    )
}

pub(super) fn actor_uses_advanced_combat_situation(_actor: &ActorAuthorityState) -> bool {
    false
}

pub(super) fn ai_engagement_target_id(actor: &ActorAuthorityState) -> Option<&str> {
    match actor.ai.as_ref()? {
        AuthorityAiState::Skirmisher(ai) => ai.target_actor_id.as_deref(),
        AuthorityAiState::PassiveCreature(ai) => ai.threat_actor_id.as_deref(),
    }
}

pub(super) fn combat_actor_has_tactical_contact(actor: &ActorAuthorityState) -> bool {
    skirmisher_has_tactical_contact(combat_micro_state(actor.ai.as_ref()))
}

pub(super) fn same_respawn_squad(
    actor_social_group: Option<&str>,
    actor_faction_id: Option<&str>,
    squadmate: &ActorAuthorityState,
) -> bool {
    if let Some(actor_social_group) = actor_social_group {
        return squadmate.faction.social_group.as_deref() == Some(actor_social_group);
    }
    if let Some(actor_faction_id) = actor_faction_id {
        return squadmate.faction.faction_id.as_deref() == Some(actor_faction_id);
    }
    false
}

pub(super) fn scaled_axis_delta(component: i32, amount: i32, distance: i32) -> i32 {
    if distance == 0 {
        return 0;
    }
    let value = i64::from(component) * i64::from(amount) / i64::from(distance);
    value.clamp(i64::from(i32::MIN), i64::from(i32::MAX)) as i32
}

/// True for wildlife actors governed by passive creature behavior.
pub(super) fn is_passive_creature_actor(actor: &ActorAuthorityState) -> bool {
    actor.role == "creature"
}

/// Harvestable Gaia wildlife. Drives corpse harvest eligibility and shared
/// creature respawn timing.
pub(super) fn is_harvestable_creature_actor(actor: &ActorAuthorityState) -> bool {
    actor.role == "creature"
}

pub(super) fn is_creature_body_actor(actor: &ActorAuthorityState) -> bool {
    actor.role == "creature"
}

pub(super) fn is_pressure_reactive_actor(actor: &ActorAuthorityState) -> bool {
    matches!(actor.role.as_str(), "combat_npc" | "creature") || is_skirmisher_role(&actor.role)
}

/// Convert the stored actor anchor (the cell min-corner) to the physical
/// ground/collision center. Keep this conversion saturating at the fixed-point
/// integer boundary.
pub(super) fn ground_center_from_anchor(anchor: AuthorityPosition) -> AuthorityPosition {
    AuthorityPosition {
        x: anchor.x.saturating_add(MILLI_CELLS_PER_CELL / 2),
        y: anchor.y.saturating_add(MILLI_CELLS_PER_CELL / 2),
    }
}

/// Convert a physical ground/collision center back to the stored actor anchor.
pub(super) fn anchor_from_ground_center(center: AuthorityPosition) -> AuthorityPosition {
    AuthorityPosition {
        x: center.x.saturating_sub(MILLI_CELLS_PER_CELL / 2),
        y: center.y.saturating_sub(MILLI_CELLS_PER_CELL / 2),
    }
}

#[cfg(test)]
mod coordinate_tests {
    use super::*;

    #[test]
    fn anchor_ground_center_conversion_is_saturating_and_reversible_in_range() {
        let anchor = AuthorityPosition { x: 4_250, y: 7_750 };
        let center = ground_center_from_anchor(anchor);
        assert_eq!(center, AuthorityPosition { x: 4_750, y: 8_250 });
        assert_eq!(anchor_from_ground_center(center), anchor);
        assert_eq!(
            ground_center_from_anchor(AuthorityPosition {
                x: i32::MAX,
                y: i32::MIN,
            }),
            AuthorityPosition {
                x: i32::MAX,
                y: i32::MIN + 500,
            }
        );
        assert_eq!(
            anchor_from_ground_center(AuthorityPosition {
                x: i32::MAX,
                y: i32::MIN,
            }),
            AuthorityPosition {
                x: i32::MAX - 500,
                y: i32::MIN,
            }
        );
    }
}

pub(super) fn actor_center_position(actor: &ActorAuthorityState) -> AuthorityPosition {
    ground_center_from_anchor(actor.position)
}

pub(super) fn cell_units_from_milli(milli_cells: i32) -> f64 {
    f64::from(milli_cells) / f64::from(MILLI_CELLS_PER_CELL)
}

pub(super) fn cell_units_from_milli_u64(milli_cells: u64) -> f64 {
    milli_cells as f64 / f64::from(MILLI_CELLS_PER_CELL)
}

pub(super) fn actor_stats_bucket_ticks(tick_rate_hz: u32) -> u64 {
    ACTOR_STATS_BUCKET_SECONDS
        .saturating_mul(u64::from(tick_rate_hz.max(1)))
        .max(1)
}

pub(super) fn actor_hit_box_for_position(
    position: AuthorityPosition,
    scale: u32,
    is_creature_body: bool,
) -> AuthorityActorHitBox {
    let scale = i32::try_from(scale).unwrap_or(1).clamp(1, 6);
    let ground_center = ground_center_from_anchor(position);
    let feet_x = ground_center.x;
    let feet_y = ground_center.y.saturating_add(MILLI_CELLS_PER_CELL / 2);
    if is_creature_body {
        return AuthorityActorHitBox {
            left: feet_x - 740 * scale,
            right: feet_x + 740 * scale,
            top: feet_y - 1_820 * scale,
            bottom: feet_y - 50 * scale,
        };
    }
    AuthorityActorHitBox {
        left: feet_x - 430 * scale,
        right: feet_x + 430 * scale,
        top: feet_y - 1_580 * scale,
        bottom: feet_y - 80 * scale,
    }
}

pub(super) fn expand_actor_hit_box(
    bounds: AuthorityActorHitBox,
    radius_milli: i32,
) -> AuthorityActorHitBox {
    let radius = radius_milli.max(0);
    AuthorityActorHitBox {
        left: bounds.left - radius,
        right: bounds.right + radius,
        top: bounds.top - radius,
        bottom: bounds.bottom + radius,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct CombatAimVectorMilli {
    pub(super) x_milli: i32,
    pub(super) y_milli: i32,
}

pub(super) fn cardinal_aim_vector(direction: CardinalDirection) -> CombatAimVectorMilli {
    let (dx, dy, _) = cardinal_direction_delta(direction);
    CombatAimVectorMilli {
        x_milli: dx.saturating_mul(AIM_VECTOR_SCALE_MILLI),
        y_milli: dy.saturating_mul(AIM_VECTOR_SCALE_MILLI),
    }
}

pub(super) fn normalize_aim_vector_milli(
    x_milli: i32,
    y_milli: i32,
) -> Option<CombatAimVectorMilli> {
    if x_milli == 0 && y_milli == 0 {
        return None;
    }
    let length = f64::from(x_milli).hypot(f64::from(y_milli));
    if length < 1.0 {
        return None;
    }
    let x_milli = (f64::from(x_milli) / length * f64::from(AIM_VECTOR_SCALE_MILLI))
        .round()
        .clamp(
            f64::from(-AIM_VECTOR_SCALE_MILLI),
            f64::from(AIM_VECTOR_SCALE_MILLI),
        ) as i32;
    let y_milli = (f64::from(y_milli) / length * f64::from(AIM_VECTOR_SCALE_MILLI))
        .round()
        .clamp(
            f64::from(-AIM_VECTOR_SCALE_MILLI),
            f64::from(AIM_VECTOR_SCALE_MILLI),
        ) as i32;
    if x_milli == 0 && y_milli == 0 {
        None
    } else {
        Some(CombatAimVectorMilli { x_milli, y_milli })
    }
}

#[cfg(test)]
pub(super) fn shot_spread_degrees_milli_for_actor(
    actor: &ActorAuthorityState,
    weapon: WeaponProfile,
    tick: u64,
) -> i32 {
    shot_spread_degrees_milli_for_actor_at_tick_rate(
        actor,
        weapon,
        tick,
        DEFAULT_AUTHORITY_TICK_RATE_HZ,
        0,
    )
}

pub(super) fn shot_spread_degrees_milli_for_actor_at_tick_rate(
    actor: &ActorAuthorityState,
    weapon: WeaponProfile,
    tick: u64,
    tick_rate_hz: u32,
    aura_spread_reduction_milli: i32,
) -> i32 {
    shot_spread_breakdown_for_actor_at_tick_rate(
        actor,
        weapon,
        tick,
        tick_rate_hz,
        aura_spread_reduction_milli,
    )
    .total_degrees_milli
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct ShotSpreadBreakdown {
    pub(super) weapon_degrees_milli: i32,
    pub(super) role_degrees_milli: i32,
    pub(super) novice_penalty_degrees_milli: i32,
    pub(super) bare_novice_marksman: bool,
    pub(super) movement_degrees_milli: i32,
    pub(super) low_action_degrees_milli: i32,
    pub(super) recoil_degrees_milli: i32,
    pub(super) skill_reduction_milli: i32,
    pub(super) total_degrees_milli: i32,
}

#[cfg(test)]
pub(super) fn shot_spread_breakdown_for_actor(
    actor: &ActorAuthorityState,
    weapon: WeaponProfile,
    tick: u64,
) -> ShotSpreadBreakdown {
    shot_spread_breakdown_for_actor_at_tick_rate(
        actor,
        weapon,
        tick,
        DEFAULT_AUTHORITY_TICK_RATE_HZ,
        0,
    )
}

pub(super) fn shot_spread_breakdown_for_actor_at_tick_rate(
    actor: &ActorAuthorityState,
    weapon: WeaponProfile,
    tick: u64,
    tick_rate_hz: u32,
    aura_spread_reduction_milli: i32,
) -> ShotSpreadBreakdown {
    let actor_accuracy = actor_accuracy_profile(actor, weapon);
    let base_skill_reduction_milli = marksman_rifle_spread_reduction_milli_for_actor(actor, weapon);
    // Fieldcraft: kneeling multiplies the shooter's OWN spread reduction (cover pays,
    // x1.0 -> x1.6 across the track). Squad Fire aura adds a flat reduction on top
    // (a nearby grouped master marksman). Both fold into one effective reduction.
    let kneel_scaled_milli =
        if actor.posture == AuthorityActorPosture::Kneeling && base_skill_reduction_milli > 0 {
            i32::try_from(
                i64::from(base_skill_reduction_milli).saturating_mul(i64::from(
                    actor
                        .professions
                        .marksman_fieldcraft_kneel_spread_mult_milli(),
                )) / 1_000,
            )
            .unwrap_or(base_skill_reduction_milli)
        } else {
            base_skill_reduction_milli
        };
    let skill_reduction_milli = kneel_scaled_milli
        .saturating_add(aura_spread_reduction_milli.max(0))
        .clamp(0, 950);
    let weapon_degrees_milli = weapon.base_spread_degrees_milli.max(0);
    let bare_novice_marksman = weapon.id == AuthorityWeaponId::Slugthrower
        && base_skill_reduction_milli <= 0
        && actor.professions.has(AuthorityProfessionKind::Marksman);
    let novice_penalty_degrees_milli = if bare_novice_marksman {
        MARKSMAN_NOVICE_RIFLE_SPREAD_PENALTY_DEGREES_MILLI
    } else {
        0
    };
    let role_degrees_milli = reduce_spread_degrees_milli(
        actor_accuracy.role_bias_degrees_milli,
        skill_reduction_milli,
    );
    let movement_degrees_milli = if actor.next_move_tick > tick {
        reduce_spread_degrees_milli(
            actor_accuracy.moving_fire_degrees_milli,
            skill_reduction_milli,
        )
    } else {
        0
    };
    let max_action = actor.max_vitals.action.max(1);
    let low_action_degrees_milli = if actor.vitals.action.saturating_mul(1_000) / max_action <= 250
    {
        low_action_fire_spread_degrees_milli_for_actor(actor)
    } else {
        0
    };
    let recoil_degrees_milli = weapon_recoil_spread_degrees_milli_for_actor(
        actor,
        weapon,
        tick,
        tick_rate_hz,
        skill_reduction_milli,
    );
    let total_degrees_milli = weapon_degrees_milli
        .saturating_add(role_degrees_milli)
        .saturating_add(novice_penalty_degrees_milli)
        .saturating_add(movement_degrees_milli)
        .saturating_add(low_action_degrees_milli)
        .saturating_add(recoil_degrees_milli);
    ShotSpreadBreakdown {
        weapon_degrees_milli,
        role_degrees_milli,
        bare_novice_marksman,
        novice_penalty_degrees_milli,
        movement_degrees_milli,
        low_action_degrees_milli,
        recoil_degrees_milli,
        skill_reduction_milli,
        total_degrees_milli,
    }
}

fn marksman_rifle_spread_reduction_milli_for_actor(
    actor: &ActorAuthorityState,
    weapon: WeaponProfile,
) -> i32 {
    if weapon.id != AuthorityWeaponId::Slugthrower {
        return 0;
    }
    actor
        .professions
        .marksman_rifle_spread_reduction_milli()
        .clamp(0, 950)
}

fn reduce_spread_degrees_milli(spread_degrees_milli: i32, reduction_milli: i32) -> i32 {
    if spread_degrees_milli <= 0 || reduction_milli <= 0 {
        return spread_degrees_milli.max(0);
    }
    let retained_milli = 1_000_i64.saturating_sub(i64::from(reduction_milli.clamp(0, 950)));
    i32::try_from(
        i64::from(spread_degrees_milli)
            .saturating_mul(retained_milli)
            .saturating_div(1_000),
    )
    .unwrap_or(i32::MAX)
}

pub(super) fn decayed_weapon_recoil_heat_milli_for_actor(
    actor: &ActorAuthorityState,
    weapon: WeaponProfile,
    tick: u64,
    tick_rate_hz: u32,
) -> i32 {
    let heat = actor
        .weapon_recoil_heat_milli
        .clamp(0, weapon.recoil_max_milli.max(0));
    if heat <= 0 || weapon.recoil_decay_milli_per_second <= 0 {
        return heat;
    }
    let elapsed_ticks = tick.saturating_sub(actor.weapon_recoil_last_tick);
    if elapsed_ticks == 0 {
        return heat;
    }
    let decay_per_second = weapon_recoil_decay_milli_per_second_for_actor(actor, weapon);
    let decay = i64::from(decay_per_second.max(0))
        .saturating_mul(i64::try_from(elapsed_ticks).unwrap_or(i64::MAX))
        .checked_div(i64::from(tick_rate_hz.max(1)))
        .unwrap_or(0);
    heat.saturating_sub(i32::try_from(decay).unwrap_or(i32::MAX))
        .clamp(0, weapon.recoil_max_milli.max(0))
}

fn weapon_recoil_decay_milli_per_second_for_actor(
    actor: &ActorAuthorityState,
    weapon: WeaponProfile,
) -> i32 {
    if weapon.id != AuthorityWeaponId::Slugthrower {
        return weapon.recoil_decay_milli_per_second.max(0);
    }
    let skill_reduction_milli = marksman_rifle_spread_reduction_milli_for_actor(actor, weapon);
    i32::try_from(
        i64::from(weapon.recoil_decay_milli_per_second.max(0))
            .saturating_mul(i64::from(1_000 + skill_reduction_milli.clamp(0, 950)))
            .saturating_div(1_000),
    )
    .unwrap_or(i32::MAX)
}

fn weapon_recoil_spread_degrees_milli_for_actor(
    actor: &ActorAuthorityState,
    weapon: WeaponProfile,
    tick: u64,
    tick_rate_hz: u32,
    reduction_milli: i32,
) -> i32 {
    if weapon.recoil_spread_degrees_milli <= 0 || weapon.recoil_max_spread_degrees_milli <= 0 {
        return 0;
    }
    let heat = decayed_weapon_recoil_heat_milli_for_actor(actor, weapon, tick, tick_rate_hz);
    if heat <= 0 {
        return 0;
    }
    let spread = i32::try_from(
        i64::from(heat)
            .saturating_mul(i64::from(weapon.recoil_spread_degrees_milli))
            .saturating_div(1_000),
    )
    .unwrap_or(i32::MAX)
    .clamp(0, weapon.recoil_max_spread_degrees_milli.max(0));
    reduce_spread_degrees_milli(spread, reduction_milli)
}

pub(super) fn record_actor_weapon_recoil(
    actor: &mut ActorAuthorityState,
    weapon: WeaponProfile,
    tick: u64,
    tick_rate_hz: u32,
) {
    let heat = decayed_weapon_recoil_heat_milli_for_actor(actor, weapon, tick, tick_rate_hz);
    actor.weapon_recoil_heat_milli = heat
        .saturating_add(weapon.recoil_per_shot_milli.max(0))
        .clamp(0, weapon.recoil_max_milli.max(0));
    actor.weapon_recoil_last_tick = tick;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct ActorAccuracyProfile {
    pub(super) role_bias_degrees_milli: i32,
    pub(super) moving_fire_degrees_milli: i32,
}

pub(super) fn actor_accuracy_profile(
    actor: &ActorAuthorityState,
    weapon: WeaponProfile,
) -> ActorAccuracyProfile {
    if weapon.id != AuthorityWeaponId::Slugthrower {
        return ActorAccuracyProfile {
            role_bias_degrees_milli: 0,
            moving_fire_degrees_milli: 0,
        };
    }
    if actor.professions.has(AuthorityProfessionKind::Marksman) {
        return ActorAccuracyProfile {
            role_bias_degrees_milli: SKIRMISHER_SPREAD_BIAS_DEGREES_MILLI,
            moving_fire_degrees_milli: SKIRMISHER_MOVING_FIRE_SPREAD_DEGREES_MILLI,
        };
    }
    match actor.role.as_str() {
        "agent_player" => ActorAccuracyProfile {
            role_bias_degrees_milli: AGENT_PLAYER_SPREAD_BIAS_DEGREES_MILLI,
            moving_fire_degrees_milli: AGENT_PLAYER_MOVING_FIRE_SPREAD_DEGREES_MILLI,
        },
        "player" => ActorAccuracyProfile {
            role_bias_degrees_milli: HUMAN_PLAYER_SPREAD_BIAS_DEGREES_MILLI,
            moving_fire_degrees_milli: HUMAN_PLAYER_MOVING_FIRE_SPREAD_DEGREES_MILLI,
        },
        role if role.ends_with("_deadeye") || role == "skirmisher_deadeye" => {
            ActorAccuracyProfile {
                role_bias_degrees_milli: SKIRMISHER_DEADEYE_SPREAD_BIAS_DEGREES_MILLI,
                moving_fire_degrees_milli: SKIRMISHER_MOVING_FIRE_SPREAD_DEGREES_MILLI,
            }
        }
        role if is_skirmisher_role(role) => ActorAccuracyProfile {
            role_bias_degrees_milli: SKIRMISHER_SPREAD_BIAS_DEGREES_MILLI,
            moving_fire_degrees_milli: SKIRMISHER_MOVING_FIRE_SPREAD_DEGREES_MILLI,
        },
        _ => ActorAccuracyProfile {
            role_bias_degrees_milli: DEFAULT_ACTOR_SPREAD_BIAS_DEGREES_MILLI,
            moving_fire_degrees_milli: DEFAULT_MOVING_FIRE_SPREAD_DEGREES_MILLI,
        },
    }
}

pub(super) fn low_action_fire_spread_degrees_milli_for_actor(actor: &ActorAuthorityState) -> i32 {
    match actor.role.as_str() {
        "agent_player" => AGENT_PLAYER_LOW_ACTION_FIRE_SPREAD_DEGREES_MILLI,
        "player" => HUMAN_PLAYER_LOW_ACTION_FIRE_SPREAD_DEGREES_MILLI,
        _ => LOW_ACTION_FIRE_SPREAD_DEGREES_MILLI,
    }
}
pub(super) fn combat_dodge_chance_milli(target: &ActorAuthorityState, _tick: u64) -> i32 {
    if target.life_state != AuthorityLifeState::Alive || target.sleep.remaining_ticks > 0 {
        return 0;
    }
    target.effective_stats.dodge_chance_milli.clamp(0, 950)
}

pub(super) fn cardinal_direction_for_aim_vector(
    aim_vector: CombatAimVectorMilli,
) -> CardinalDirection {
    if aim_vector.x_milli.abs() >= aim_vector.y_milli.abs() {
        if aim_vector.x_milli >= 0 {
            CardinalDirection::Right
        } else {
            CardinalDirection::Left
        }
    } else if aim_vector.y_milli >= 0 {
        CardinalDirection::Front
    } else {
        CardinalDirection::Back
    }
}

pub(super) fn direction_for_aim_vector(aim_vector: CombatAimVectorMilli) -> &'static str {
    match cardinal_direction_for_aim_vector(aim_vector) {
        CardinalDirection::Front => "front",
        CardinalDirection::Right => "right",
        CardinalDirection::Back => "back",
        CardinalDirection::Left => "left",
    }
}

pub(super) fn direction_vector_from_name(direction: &str) -> (i32, i32) {
    let vector = aim_vector_for_direction_name(direction);
    (vector.x_milli, vector.y_milli)
}

pub(super) fn aim_vector_for_direction_name(direction: &str) -> CombatAimVectorMilli {
    match direction {
        "right" => cardinal_aim_vector(CardinalDirection::Right),
        "left" => cardinal_aim_vector(CardinalDirection::Left),
        "back" => cardinal_aim_vector(CardinalDirection::Back),
        _ => cardinal_aim_vector(CardinalDirection::Front),
    }
}

pub(super) fn ai_for_actor(actor_id: &str, role: &str) -> Option<AuthorityAiState> {
    if is_skirmisher_role(role) || role == "agent_player" {
        return Some(AuthorityAiState::Skirmisher(SkirmisherAiState {
            mode: SkirmisherMode::Engage,
            target_actor_id: None,
            target: None,
            cover: None,
            next_decision_tick: 0,
            next_shot_tick: 0,
            burst_shots_remaining: 0,
            attitude: NpcAiAttitude::Hostile,
            alert_until_tick: 0,
            next_update_tick: 0,
            last_update_tick: 0,
            last_move_dx_milli: 0,
            last_move_dy_milli: 0,
            last_move_tick: 0,
            progress_target: None,
            progress_best_distance_milli: i32::MAX,
            progress_last_improved_tick: 0,
            blocked_target: None,
            blocked_target_until_tick: 0,
            seed: string_hash32(actor_id),
        }));
    }
    if role == "creature" {
        return Some(AuthorityAiState::PassiveCreature(PassiveCreatureAiState {
            mode: PassiveCreatureMode::Roam,
            target: None,
            threat: None,
            threat_actor_id: None,
            panic_until_tick: 0,
            chase_until_tick: 0,
            next_attack_tick: 0,
            next_decision_tick: 0,
            next_update_tick: 0,
            last_update_tick: 0,
            seed: string_hash32(actor_id),
        }));
    }
    None
}

pub(super) fn direction_for_delta(dx: i32, dy: i32) -> &'static str {
    if dy > 0 {
        return "front";
    }
    if dy < 0 {
        return "back";
    }
    if dx > 0 {
        return "right";
    }
    if dx < 0 {
        return "left";
    }
    "front"
}

pub(super) fn direction_for_milli_delta(dx: i32, dy: i32) -> &'static str {
    if dx.abs() >= dy.abs() && dx.abs() > 1 {
        if dx > 0 {
            "right"
        } else {
            "left"
        }
    } else if dy.abs() > 1 {
        if dy > 0 {
            "front"
        } else {
            "back"
        }
    } else {
        "front"
    }
}

pub(super) fn distance_milli_components(dx: i32, dy: i32) -> i32 {
    f64::from(dx)
        .hypot(f64::from(dy))
        .round()
        .clamp(0.0, f64::from(i32::MAX)) as i32
}

pub(super) fn position_distance_milli(left: AuthorityPosition, right: AuthorityPosition) -> i32 {
    distance_milli_components(left.x - right.x, left.y - right.y)
}

pub(super) fn tactical_point_from_authority_position(position: AuthorityPosition) -> TacticalPoint {
    TacticalPoint::new(position.x, position.y)
}

pub(super) fn authority_position_from_tactical_point(point: TacticalPoint) -> AuthorityPosition {
    AuthorityPosition {
        x: point.x_milli,
        y: point.y_milli,
    }
}

pub(super) fn nav_position_from_authority_position(position: AuthorityPosition) -> NavPosition {
    NavPosition::new(position.x, position.y)
}

pub(super) fn authority_position_from_nav_position(position: NavPosition) -> AuthorityPosition {
    AuthorityPosition {
        x: position.x_milli,
        y: position.y_milli,
    }
}

pub(super) fn authority_ai_debug_position_from_position(
    position: AuthorityPosition,
) -> AuthorityAiDebugPosition {
    let cell = position.cell();
    AuthorityAiDebugPosition::from_milli_cell(position.x, position.y, cell.x, cell.y)
}

pub(super) fn push_authority_tactical_candidates(
    candidates: &mut Vec<(
        AuthorityPosition,
        &'static str,
        Option<CoverPointAuthorityState>,
    )>,
    tactical_candidates: Vec<TacticalCandidate>,
) {
    candidates.extend(tactical_candidates.into_iter().map(|candidate| {
        (
            authority_position_from_tactical_point(candidate.point),
            candidate.kind,
            None,
        )
    }));
}

pub(super) fn tactical_range_from_profile(profile: SkirmisherProfile) -> TacticalRangeProfile {
    TacticalRangeProfile {
        min_range_milli: profile.min_range_milli,
        preferred_range_milli: profile.preferred_range_milli,
        max_range_milli: profile.max_range_milli,
    }
}

pub(super) fn tactical_direction_for_stage(
    actor: &ActorAuthorityState,
    target: &ActorAuthorityState,
    context: Option<&SkirmisherActorTacticalContext>,
) -> TacticalDirection {
    if let Some(ctx) = context {
        return TacticalDirection {
            toward_x_milli: ctx.squad.direction_x_milli,
            toward_y_milli: ctx.squad.direction_y_milli,
            lateral_x_milli: ctx.squad.lateral_x_milli,
            lateral_y_milli: ctx.squad.lateral_y_milli,
        };
    }
    let (toward_x_milli, toward_y_milli) = normalize_components_milli(
        target.position.x.saturating_sub(actor.position.x),
        target.position.y.saturating_sub(actor.position.y),
    )
    .unwrap_or_else(|| direction_vector_from_name(&actor.direction));
    TacticalDirection {
        toward_x_milli,
        toward_y_milli,
        lateral_x_milli: -toward_y_milli,
        lateral_y_milli: toward_x_milli,
    }
}

pub(super) fn tactical_formation_from_context(
    context: Option<&SkirmisherActorTacticalContext>,
) -> Option<TacticalFormation> {
    context.map(|ctx| TacticalFormation {
        direction: TacticalDirection {
            toward_x_milli: ctx.squad.direction_x_milli,
            toward_y_milli: ctx.squad.direction_y_milli,
            lateral_x_milli: ctx.squad.lateral_x_milli,
            lateral_y_milli: ctx.squad.lateral_y_milli,
        },
        lane_center_offset_milli: ctx.lane.as_ref().map_or(0, |lane| lane.center_offset_milli),
        lane_width_milli: SKIRMISHER_LANE_WIDTH_MILLI_CELLS,
        front_width_milli: ctx.squad.front_width_milli,
        no_mans_land: ctx
            .squad
            .no_mans_land
            .map(tactical_point_from_authority_position),
    })
}

pub(super) fn distance_for_ticks(
    speed_milli_cells_per_second: i32,
    ticks: u64,
    tick_rate_hz: u32,
) -> i32 {
    let distance = i64::from(speed_milli_cells_per_second)
        .saturating_mul(i64::try_from(ticks).unwrap_or(i64::MAX))
        / i64::from(tick_rate_hz.max(1));
    distance.clamp(0, i64::from(i32::MAX)) as i32
}

pub(super) fn route_patrol_distance_for_ticks(ticks: u64) -> i32 {
    let distance = i64::from(MILLI_CELLS_PER_CELL)
        .saturating_mul(i64::try_from(ticks).unwrap_or(i64::MAX))
        .saturating_add(i64::try_from(NPC_ROUTE_STEP_INTERVAL_TICKS).unwrap_or(i64::MAX) - 1)
        / i64::try_from(NPC_ROUTE_STEP_INTERVAL_TICKS).unwrap_or(1);
    distance.clamp(1, i64::from(i32::MAX)) as i32
}

pub(super) fn scheduled_ai_elapsed_ticks(
    seed: u32,
    tick: u64,
    cadence_ticks: u64,
    salt: u64,
    next_update_tick: &mut u64,
    last_update_tick: &mut u64,
) -> Option<u64> {
    let cadence = cadence_ticks.max(1);
    if *last_update_tick == 0 && *next_update_tick == 0 {
        *next_update_tick = tick;
    }
    if tick < *next_update_tick {
        return None;
    }
    let previous_tick = if *last_update_tick > 0 {
        *last_update_tick
    } else {
        tick.saturating_sub(cadence)
    };
    let elapsed = tick.saturating_sub(previous_tick).max(1).min(cadence);
    *last_update_tick = tick;
    let jitter = (ai_rand(seed, tick, salt) * (cadence.div_ceil(2).max(1)) as f64) as u64;
    *next_update_tick = tick.saturating_add(cadence).saturating_add(jitter);
    Some(elapsed)
}

pub(super) fn string_hash32(value: &str) -> u32 {
    let mut hash = 0x811c9dc5_u32;
    for byte in value.as_bytes() {
        hash ^= u32::from(*byte);
        hash = hash.wrapping_mul(0x01000193);
    }
    hash
}

pub(super) fn ai_rand(seed: u32, tick: u64, salt: u64) -> f64 {
    let mut value = seed
        ^ ((tick as u32).wrapping_add(0x9e3779b9)).wrapping_mul(0x85ebca6b)
        ^ ((salt as u32).wrapping_add(0x165667b1)).wrapping_mul(0xc2b2ae35);
    value ^= value >> 16;
    value = value.wrapping_mul(0x7feb352d);
    value ^= value >> 15;
    value = value.wrapping_mul(0x846ca68b);
    value ^= value >> 16;
    f64::from(value) / 4_294_967_296.0
}

pub(super) fn cardinal_direction_delta(direction: CardinalDirection) -> (i32, i32, &'static str) {
    match direction {
        CardinalDirection::Front => (0, 1, "front"),
        CardinalDirection::Right => (1, 0, "right"),
        CardinalDirection::Back => (0, -1, "back"),
        CardinalDirection::Left => (-1, 0, "left"),
    }
}

pub(super) fn cardinal_direction_code(direction: CardinalDirection) -> u32 {
    match direction {
        CardinalDirection::Front => 1,
        CardinalDirection::Right => 2,
        CardinalDirection::Back => 3,
        CardinalDirection::Left => 4,
    }
}

pub(super) fn distance_sq(left: AuthorityCell, right: AuthorityCell) -> i64 {
    let dx = i64::from(left.x - right.x);
    let dy = i64::from(left.y - right.y);
    dx * dx + dy * dy
}

pub(super) fn bleed_source_actor_id(actor: &ActorAuthorityState) -> String {
    actor
        .bleed_stacks
        .last()
        .map(|stack| stack.source_actor_id.clone())
        .unwrap_or_else(|| actor.id.clone())
}

pub(super) fn bleed_stack_count(actor: &ActorAuthorityState) -> u8 {
    u8::try_from(actor.bleed_stacks.len()).unwrap_or(u8::MAX)
}

pub(super) fn apply_vital_damage(value: &mut i32, damage: i32) {
    if damage <= 0 {
        return;
    }
    *value = value.saturating_sub(damage).max(0);
}

pub(super) fn apply_downed_bleed_pressure(actor: &mut ActorAuthorityState, tick_rate_hz: u32) {
    let target_ticks = u64::from(tick_rate_hz.max(1))
        .saturating_mul(DOWNED_BLEEDOUT_TARGET_SECONDS)
        .max(1);
    let target_ticks_i32 = i32::try_from(target_ticks).unwrap_or(i32::MAX).max(1);
    let action_drain_milli = div_ceil_i32(
        actor.max_vitals.action.saturating_mul(1_000),
        target_ticks_i32,
    );
    let spirit_drain_milli = div_ceil_i32(
        actor.max_vitals.spirit.saturating_mul(1_000),
        target_ticks_i32,
    );

    actor.downed_action_drain_milli = actor
        .downed_action_drain_milli
        .saturating_add(action_drain_milli);
    actor.downed_spirit_drain_milli = actor
        .downed_spirit_drain_milli
        .saturating_add(spirit_drain_milli);

    let action_damage = actor.downed_action_drain_milli / 1_000;
    if action_damage > 0 {
        apply_vital_damage(&mut actor.vitals.action, action_damage);
        actor.downed_action_drain_milli %= 1_000;
    }

    let spirit_damage = actor.downed_spirit_drain_milli / 1_000;
    if spirit_damage > 0 {
        apply_vital_damage(&mut actor.vitals.spirit, spirit_damage);
        actor.downed_spirit_drain_milli %= 1_000;
    }
}

pub(super) fn regen_vital(
    current: &mut i32,
    max: i32,
    carry_milli: &mut i32,
    rate_milli_per_second: i32,
    tick_rate_hz: u32,
) {
    let max = max.max(0);
    if *current >= max {
        *carry_milli = 0;
        return;
    }
    if rate_milli_per_second <= 0 {
        return;
    }
    let divisor = i32::try_from(tick_rate_hz.max(1))
        .unwrap_or(i32::MAX)
        .saturating_mul(1_000)
        .max(1);
    *carry_milli = (*carry_milli).saturating_add(rate_milli_per_second);
    let regen = *carry_milli / divisor;
    if regen <= 0 {
        return;
    }
    *carry_milli %= divisor;
    *current = (*current).saturating_add(regen).min(max);
    if *current >= max {
        *carry_milli = 0;
    }
}

/// Cap on stacked defender damage-taken reduction so defensive tracks never reach
/// immunity (tunable safety clamp; guard brace + fieldcraft cover stack under this).
pub(super) const DEFENDER_DAMAGE_TAKEN_REDUCTION_CAP_MILLI: i32 = 800;

/// Sum of the TARGET's atomic `damage_taken` reductions (permille): guard "brace"
/// (passive, guard-trained — THE WALL tank identity) + fieldcraft "cover" (only while
/// kneeling). Both are 0 for untrained actors, so an untrained defender is unchanged.
pub(super) fn defender_damage_taken_reduction_milli(target: &ActorAuthorityState) -> i32 {
    let mut reduction = target
        .professions
        .brawler_guard_braced_damage_taken_reduction_milli();
    if target.posture == AuthorityActorPosture::Kneeling {
        reduction = reduction.saturating_add(
            target
                .professions
                .marksman_fieldcraft_kneel_damage_taken_reduction_milli(),
        );
    }
    reduction.clamp(0, DEFENDER_DAMAGE_TAKEN_REDUCTION_CAP_MILLI)
}

/// Apply the defender's `damage_taken` reduction to one incoming hit (integer permille).
pub(super) fn apply_defender_damage_taken_reduction(
    target: &ActorAuthorityState,
    damage: i32,
) -> i32 {
    let reduction = defender_damage_taken_reduction_milli(target);
    if reduction <= 0 || damage <= 0 {
        return damage;
    }
    let retained = 1_000 - reduction;
    i32::try_from(i64::from(damage).saturating_mul(i64::from(retained)) / 1_000).unwrap_or(damage)
}

/// Flat melee damage with the attacker's brawler-melee damage bonus (no variance band,
/// used by the direct-contact melee path). 0 bonus for untrained -> unchanged.
pub(super) fn melee_flat_damage_with_bonus(
    attacker: &ActorAuthorityState,
    base_damage: i32,
) -> i32 {
    let bonus = attacker
        .professions
        .brawler_melee_damage_bonus_milli()
        .max(0);
    i32::try_from(i64::from(base_damage).saturating_mul(i64::from(1_000 + bonus)) / 1_000)
        .unwrap_or(base_damage)
}

/// Scale a passive regen rate (milli/s) by a Field Rest multiplier (1000 = x1.0). A rate
/// of 0 stays 0 (a zeroed regen rate is unaffected — camp shelter tests rely on x1.75*0=0).
pub(super) fn field_rest_scaled_rate_milli(rate_milli_per_second: i32, mult_milli: i32) -> i32 {
    if mult_milli == 1_000 || rate_milli_per_second == 0 {
        return rate_milli_per_second;
    }
    i32::try_from(
        i64::from(rate_milli_per_second).saturating_mul(i64::from(mult_milli.max(0))) / 1_000,
    )
    .unwrap_or(rate_milli_per_second)
}

pub(super) fn interest_radius_sq(radius_cells: i32) -> i64 {
    let radius = i64::from(radius_cells.max(0));
    radius * radius
}

pub(super) fn div_ceil_i32(value: i32, divisor: i32) -> i32 {
    if divisor <= 0 {
        return 0;
    }
    value.saturating_add(divisor - 1) / divisor
}

pub(super) fn scaled_milli(value: i32, multiplier_milli: i32) -> i32 {
    let scaled = i64::from(value).saturating_mul(i64::from(multiplier_milli.max(0))) / 1_000;
    i32::try_from(scaled.clamp(0, i64::from(i32::MAX))).unwrap_or(i32::MAX)
}

pub(super) fn spirit_strain_milli(actor: &ActorAuthorityState) -> i32 {
    let max_spirit = actor.max_vitals.spirit.max(1);
    let missing_spirit = max_spirit.saturating_sub(actor.vitals.spirit.clamp(0, max_spirit));
    missing_spirit.saturating_mul(1_000) / max_spirit
}

pub(super) fn body_strain_milli(actor: &ActorAuthorityState) -> i32 {
    let max_health = actor.max_vitals.health.max(1);
    let missing_health = max_health.saturating_sub(actor.vitals.health.clamp(0, max_health));
    missing_health.saturating_mul(1_000) / max_health
}

pub(super) fn body_output_multiplier_milli(actor: &ActorAuthorityState) -> i32 {
    (1_000 - (spirit_strain_milli(actor) * 350 / 1_000).clamp(0, 350)).max(1)
}

pub(super) fn movement_speed_multiplier_milli_for_actor(actor: &ActorAuthorityState) -> i32 {
    let traversal_boxes =
        actor.professions.scout_traversal_bonus() / SCOUT_MOVE_BONUS_PER_BOX_MILLI;
    let traversal_multiplier_milli = 1_000_i32
        .saturating_add(traversal_boxes.saturating_mul(SCOUT_WALK_SPEED_ADD_MILLI_PER_BOX));
    let brawler_movement_multiplier_milli = 1_000_i32.saturating_add(
        actor
            .professions
            .brawler_movement_speed_bonus()
            .saturating_mul(4)
            / 5,
    );
    scaled_milli(
        scaled_milli(
            scaled_milli(
                actor.effective_stats.movement_speed_multiplier_milli,
                traversal_multiplier_milli,
            ),
            brawler_movement_multiplier_milli,
        ),
        body_output_multiplier_milli(actor),
    )
}

pub(super) fn sprint_speed_multiplier_milli_for_actor(actor: &ActorAuthorityState) -> i32 {
    let sprint_boxes = actor.professions.scout_sprinting_bonus() / SCOUT_MOVE_BONUS_PER_BOX_MILLI;
    1_000_i32.saturating_add(sprint_boxes.saturating_mul(SCOUT_SPRINT_SPEED_ADD_MILLI_PER_BOX))
}

pub(super) fn sprint_action_cost_milli(duration_ticks: u16, tick_rate_hz: u32) -> i32 {
    let ticks = i32::from(duration_ticks.max(1));
    let hz = i32::try_from(tick_rate_hz.max(1))
        .unwrap_or(i32::MAX)
        .max(1);
    div_ceil_i32(
        SPRINT_ACTION_DRAIN_PER_SECOND
            .saturating_mul(ticks)
            .saturating_mul(1_000),
        hz,
    )
}

pub(super) fn actor_sprint_action_cost_milli(
    actor: &ActorAuthorityState,
    duration_ticks: u16,
    tick_rate_hz: u32,
) -> i32 {
    let sprint_boxes = actor.professions.scout_sprinting_bonus() / SCOUT_MOVE_BONUS_PER_BOX_MILLI;
    let efficiency_multiplier_milli = (1_000_i32
        .saturating_sub(sprint_boxes.saturating_mul(SCOUT_SPRINT_EFFICIENCY_CUT_MILLI_PER_BOX)))
    .clamp(SCOUT_SPRINT_EFFICIENCY_FLOOR_MILLI, 1_000);
    scaled_milli(
        sprint_action_cost_milli(duration_ticks, tick_rate_hz),
        efficiency_multiplier_milli,
    )
}

pub(super) fn apply_sprint_action_cost(
    actor: &mut ActorAuthorityState,
    duration_ticks: u16,
    tick_rate_hz: u32,
) {
    actor.sprint_action_drain_milli =
        actor
            .sprint_action_drain_milli
            .saturating_add(actor_sprint_action_cost_milli(
                actor,
                duration_ticks,
                tick_rate_hz,
            ));
    let action_damage = actor.sprint_action_drain_milli / 1_000;
    if action_damage > 0 {
        apply_vital_damage(&mut actor.vitals.action, action_damage);
        actor.sprint_action_drain_milli %= 1_000;
    }
}

pub(super) fn suppression_threshold_milli_for_actor(actor: &ActorAuthorityState) -> i32 {
    let spirit_discount_milli = (spirit_strain_milli(actor) * 350 / 1_000).clamp(0, 350);
    let body_discount_milli = (body_strain_milli(actor) * 350 / 1_000).clamp(0, 350);
    let strain_discount_milli = spirit_discount_milli
        .saturating_add(body_discount_milli)
        .min(550);
    scaled_milli(
        actor.effective_stats.suppression_threshold_milli,
        1_000 - strain_discount_milli,
    )
    .max(1)
}

pub(super) fn suppression_decay_milli_per_tick_for_actor(
    actor: &ActorAuthorityState,
    base_decay_milli_per_tick: i32,
) -> i32 {
    scaled_milli(
        base_decay_milli_per_tick.max(1),
        actor.effective_stats.suppression_resistance_milli,
    )
    .max(1)
}

pub(super) fn pressure_active_remaining_ticks(
    pressure_milli: i32,
    threshold_milli: i32,
    resistance_milli: i32,
) -> u16 {
    let base_decay = div_ceil_i32(SUPPRESSION_DECAY_MILLI_PER_SECOND, 30);
    let decay = scaled_milli(base_decay.max(1), resistance_milli).max(1);
    let remaining_pressure = pressure_milli
        .saturating_sub(threshold_milli.max(1))
        .saturating_add(1);
    let ticks = div_ceil_i32(remaining_pressure.max(0), decay);
    u16::try_from(ticks).unwrap_or(u16::MAX)
}

pub(super) fn suppression_spirit_drain_for_actor(
    amount_milli: i32,
    _actor: &ActorAuthorityState,
) -> i32 {
    if amount_milli <= 0 {
        return 0;
    }
    div_ceil_i32(amount_milli.max(0), SUPPRESSION_SPIRIT_DRAIN_DIVISOR_MILLI).max(1)
}

pub(super) fn suppression_panic_ticks_for_actor(
    actor: &ActorAuthorityState,
    threshold_milli: i32,
) -> u64 {
    let pressure_over_threshold = actor
        .suppression
        .pressure_milli
        .saturating_sub(threshold_milli)
        .max(0);
    let pressure = u64::try_from(pressure_over_threshold / 1_000).unwrap_or(0);
    let base_ticks = SUPPRESSION_PANIC_BASE_TICKS
        + pressure * SUPPRESSION_PANIC_SCALE_MILLI_TICKS_PER_PRESSURE / 1_000;
    let scaled =
        u64::try_from(actor.effective_stats.panic_duration_multiplier_milli.max(1)).unwrap_or(1);
    (base_ticks.saturating_mul(scaled) / 1_000).max(1)
}

pub(super) fn reset_ai_transient_state(ai: &mut AuthorityAiState) {
    match ai {
        AuthorityAiState::PassiveCreature(ai) => {
            ai.mode = PassiveCreatureMode::Roam;
            ai.target = None;
            ai.threat = None;
            ai.threat_actor_id = None;
            ai.panic_until_tick = 0;
            ai.chase_until_tick = 0;
            ai.next_attack_tick = 0;
            ai.next_decision_tick = 0;
            ai.next_update_tick = 0;
            ai.last_update_tick = 0;
        }
        AuthorityAiState::Skirmisher(ai) => {
            ai.mode = SkirmisherMode::Engage;
            ai.target_actor_id = None;
            ai.target = None;
            ai.cover = None;
            ai.next_decision_tick = 0;
            ai.next_shot_tick = 0;
            ai.burst_shots_remaining = 0;
            ai.attitude = NpcAiAttitude::Hostile;
            ai.alert_until_tick = 0;
            ai.next_update_tick = 0;
            ai.last_update_tick = 0;
            ai.last_move_dx_milli = 0;
            ai.last_move_dy_milli = 0;
            ai.last_move_tick = 0;
            reset_skirmisher_destination_progress(ai);
        }
    }
}

pub(super) fn write_ai_state_hash(w: &mut StateWriter, ai: Option<&AuthorityAiState>) {
    match ai {
        None => {
            w.write_u32(0);
        }
        Some(AuthorityAiState::PassiveCreature(ai)) => {
            w.write_u32(1)
                .write_u32(match ai.mode {
                    PassiveCreatureMode::Idle => 1,
                    PassiveCreatureMode::Roam => 2,
                    PassiveCreatureMode::Flee => 3,
                    PassiveCreatureMode::Engage => 4,
                })
                .write_tick(ai.panic_until_tick)
                .write_tick(ai.next_decision_tick)
                .write_tick(ai.next_update_tick)
                .write_tick(ai.last_update_tick)
                .write_u32(ai.seed);
            write_optional_position_hash(w, ai.target);
            write_optional_position_hash(w, ai.threat);
            // Empty-gated engage fields: calm wildlife keeps the historical hash
            // by omitting these bytes entirely when no engage state is live.
            let engage_active = ai.threat_actor_id.is_some()
                || ai.chase_until_tick > 0
                || ai.next_attack_tick > 0
                || ai.mode == PassiveCreatureMode::Engage;
            if engage_active {
                w.write_bool(true);
                write_string(w, ai.threat_actor_id.as_deref().unwrap_or(""));
                w.write_tick(ai.chase_until_tick)
                    .write_tick(ai.next_attack_tick);
            }
        }
        Some(AuthorityAiState::Skirmisher(ai)) => {
            w.write_u32(4)
                .write_u32(match ai.mode {
                    SkirmisherMode::Engage => 1,
                    SkirmisherMode::SeekCover => 2,
                    SkirmisherMode::HoldCover => 3,
                })
                .write_tick(ai.next_decision_tick)
                .write_tick(ai.next_shot_tick)
                .write_u32(u32::from(ai.burst_shots_remaining))
                .write_u32(ai.attitude as u32)
                .write_tick(ai.alert_until_tick)
                .write_tick(ai.next_update_tick)
                .write_tick(ai.last_update_tick)
                .write_i64(i64::from(ai.last_move_dx_milli))
                .write_i64(i64::from(ai.last_move_dy_milli))
                .write_tick(ai.last_move_tick)
                .write_i64(i64::from(ai.progress_best_distance_milli))
                .write_tick(ai.progress_last_improved_tick)
                .write_tick(ai.blocked_target_until_tick)
                .write_u32(ai.seed);
            write_string(w, ai.target_actor_id.as_deref().unwrap_or(""));
            write_optional_position_hash(w, ai.target);
            write_optional_position_hash(w, ai.cover);
            write_optional_position_hash(w, ai.progress_target);
            write_optional_position_hash(w, ai.blocked_target);
        }
    }
}

pub(super) fn write_optional_position_hash(
    w: &mut StateWriter,
    position: Option<AuthorityPosition>,
) {
    w.write_bool(position.is_some());
    if let Some(position) = position {
        w.write_i64(i64::from(position.x))
            .write_i64(i64::from(position.y));
    }
}

pub(super) fn ms_to_ticks_round(ms: u64, tick_rate_hz: u32) -> u64 {
    ms.saturating_mul(u64::from(tick_rate_hz.max(1)))
        .saturating_add(500)
        / 1_000
}

pub(super) fn payload_section<T: Serialize>(
    subsystem: &str,
    schema: PayloadSchemaId,
    payload: &T,
) -> SnapshotDeltaSection {
    let payload_bytes = serde_json::to_vec(payload).expect("authority delta payload serializes");
    let mut payload_hash_writer = StateWriter::new();
    payload_hash_writer
        .write_domain_header(b"authority-delta-payload")
        .write_schema_version(1)
        .write_bytes(&payload_bytes);
    SnapshotDeltaSection {
        subsystem: subsystem.to_owned(),
        schema,
        payload_hash: payload_hash_writer.finalize(),
        payload_bytes,
    }
}

pub(super) fn stable_replay_hash(
    initial_state_hash: &str,
    final_state_hash: &str,
    frames: &[AuthorityCommandFrame],
) -> String {
    let mut w = StateWriter::new();
    w.write_domain_header(b"authority-replay")
        .write_schema_version(1);
    write_string(&mut w, initial_state_hash);
    write_string(&mut w, final_state_hash);
    w.write_u32(u32::try_from(frames.len()).expect("frame count fits u32"));
    for frame in frames {
        w.write_u64(frame.command_id).write_tick(frame.tick);
        write_string(&mut w, &frame.command_hash);
        write_string(&mut w, &frame.bundle_hash);
        write_string(&mut w, &frame.frame_hash);
        match frame.status {
            AuthorityCommandStatus::Accepted => w.write_u32(1),
            AuthorityCommandStatus::Rejected => w.write_u32(2),
        };
        if let Some(reason_code) = &frame.reason_code {
            w.write_bool(true);
            write_string(&mut w, reason_code);
        } else {
            w.write_bool(false);
        }
    }
    w.finalize_hex()
}

pub(super) fn write_string(w: &mut StateWriter, value: &str) {
    w.write_u32(u32::try_from(value.len()).expect("string length fits in u32"))
        .write_bytes(value.as_bytes());
}

pub(super) fn write_optional_string(w: &mut StateWriter, value: Option<&str>) {
    match value {
        Some(value) => {
            w.write_bool(true);
            write_string(w, value);
        }
        None => {
            w.write_bool(false);
        }
    }
}

pub(super) fn write_optional_tick(w: &mut StateWriter, value: Option<u64>) {
    match value {
        Some(value) => {
            w.write_bool(true).write_tick(value);
        }
        None => {
            w.write_bool(false);
        }
    }
}

pub(super) fn write_cell_snapshot(w: &mut StateWriter, cell: &CellSnapshot) {
    write_string(w, &cell.x.to_string());
    write_string(w, &cell.y.to_string());
}

pub(super) fn write_optional_cell_snapshot(w: &mut StateWriter, cell: Option<&CellSnapshot>) {
    match cell {
        Some(cell) => {
            w.write_bool(true);
            write_cell_snapshot(w, cell);
        }
        None => {
            w.write_bool(false);
        }
    }
}
