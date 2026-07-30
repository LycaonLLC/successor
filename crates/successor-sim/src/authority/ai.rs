use super::*;

pub(in crate::authority) const MELEE_STRIKE_RANGE_MILLI_CELLS: i32 = 2_350;
const MELEE_KEEP_AWAY_PRESSURE_BUFFER_MILLI_CELLS: i32 = 5_000;
const RANGED_CLOSE_MELEE_NO_FIRE_RADIUS_BONUS_MILLI_CELLS: i32 = 3_000;
const RANGED_FIRE_AND_MELEE_DISENGAGE_STEP_MULTIPLIER_MILLI: i32 = 550;
const BRAWLER_MELEE_CONTACT_BUFFER_MILLI_CELLS: i32 = 600;
const BRAWLER_MELEE_LUNGE_START_MARGIN_MILLI_CELLS: i32 = 850;
const BRAWLER_INTERCEPT_MOVE_MEMORY_MAX_AGE_TICKS: u64 = 12;
const BRAWLER_INTERCEPT_LEAD_STEPS: i32 = 3;
const BRAWLER_INTERCEPT_LEAD_MAX_MILLI_CELLS: i32 = 2_400;
const BRAWLER_MELEE_LUNGE_UNDER_FIRE_MARGIN_MILLI_CELLS: i32 = 450;
const BRAWLER_SHIELD_RUSH_COMMIT_RANGE_MILLI_CELLS: i32 = 12_000;
const BRAWLER_SHIELD_RUSH_STEP_MULTIPLIER_MILLI: i32 = 1_700;
const SKIRMISHER_DIRECTED_CREATURE_PRESSURE_RADIUS_MILLI_CELLS: i32 = 32_000;
const SKIRMISHER_FAR_CONTACT_ACQUIRE_MULTIPLIER: i32 = 3;

fn melee_strike_range_milli(profile: SkirmisherProfile) -> i32 {
    MELEE_STRIKE_RANGE_MILLI_CELLS.max(profile.max_range_milli)
}

fn close_melee_pressure_radius_milli(profile: SkirmisherProfile) -> i32 {
    melee_strike_range_milli(profile).saturating_add(MELEE_KEEP_AWAY_PRESSURE_BUFFER_MILLI_CELLS)
}

fn actor_applies_close_melee_pressure(actor: &ActorAuthorityState) -> bool {
    skirmisher_profile_for_ai_state(actor).variant == SkirmisherVariant::Brawler
}

fn ranged_close_melee_threat_requires_disengage_before_fire(
    actor: &ActorAuthorityState,
    threat: &ActorAuthorityState,
) -> bool {
    position_distance_milli(actor.position, threat.position)
        <= melee_strike_range_milli(skirmisher_profile_for_ai_state(threat))
            .saturating_add(RANGED_CLOSE_MELEE_NO_FIRE_RADIUS_BONUS_MILLI_CELLS)
}

fn ranged_fire_and_melee_disengage_step_milli(base_step_milli: i32, fired_this_tick: bool) -> i32 {
    if fired_this_tick {
        return scaled_milli(
            base_step_milli,
            RANGED_FIRE_AND_MELEE_DISENGAGE_STEP_MULTIPLIER_MILLI,
        )
        .max(1);
    }
    skirmisher_maneuver_step_milli(base_step_milli, "melee_disengage", true)
}

fn brawler_melee_advance_step_milli(
    actor: &ActorAuthorityState,
    target: &ActorAuthorityState,
    base_step_milli: i32,
    target_gap: i32,
    strike_range: i32,
    incoming_fire: bool,
    under_immediate_pressure: bool,
) -> i32 {
    if brawler_personal_shield_ready_for_assault(actor)
        && skirmisher_enemy_applies_ranged_pressure(target)
        && target_gap <= BRAWLER_SHIELD_RUSH_COMMIT_RANGE_MILLI_CELLS
        && (incoming_fire || under_immediate_pressure || target_gap > strike_range)
    {
        return scaled_milli(base_step_milli, BRAWLER_SHIELD_RUSH_STEP_MULTIPLIER_MILLI)
            .max(base_step_milli.saturating_add(180));
    }

    let shielded_harasser_lunge = brawler_personal_shield_ready_for_assault(actor)
        && under_immediate_pressure
        && target_gap > strike_range;
    let lunge_to_contact = shielded_harasser_lunge
        || target_gap > strike_range.saturating_add(BRAWLER_MELEE_LUNGE_START_MARGIN_MILLI_CELLS)
        || (incoming_fire
            && target_gap
                > strike_range.saturating_add(BRAWLER_MELEE_LUNGE_UNDER_FIRE_MARGIN_MILLI_CELLS));
    skirmisher_maneuver_step_milli(base_step_milli, "melee_advance", lunge_to_contact)
}

fn actor_counts_as_squad_combat_threat(actor: &ActorAuthorityState) -> bool {
    !is_passive_creature_actor(actor) && skirmisher_enemy_applies_ranged_pressure(actor)
}

fn actor_uses_roll_simple_ranged_brain(actor: &ActorAuthorityState) -> bool {
    match actor.ai.as_ref() {
        Some(AuthorityAiState::Skirmisher(ai)) => {
            skirmisher_profile_for_actor(actor, ai.seed).variant != SkirmisherVariant::Brawler
        }
        _ => false,
    }
}

fn actor_requires_skirmisher_tactical_apparatus(actor: &ActorAuthorityState) -> bool {
    actor_uses_combat_tactics(actor) && !actor_uses_roll_simple_ranged_brain(actor)
}

mod combat_actions;
mod debug_trace;
mod locomotion;
mod passive_npcs;
mod rogue_trooper;
#[cfg(test)]
pub(in crate::authority) use rogue_trooper::direct_contact_approach_allowed;
mod scheduler;
mod tactical_state;
mod targeting;

fn combat_squad_order_hint(order: SkirmisherSquadOrder) -> CombatSquadOrderHint {
    match order {
        SkirmisherSquadOrder::Retreat => CombatSquadOrderHint::Retreat,
        SkirmisherSquadOrder::Defend => CombatSquadOrderHint::Defend,
        SkirmisherSquadOrder::Advance => CombatSquadOrderHint::Advance,
    }
}
