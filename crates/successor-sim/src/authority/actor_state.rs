//! Actor identity, vitals, equipment, effects, and projections.

use super::*;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AuthorityLifeState {
    Alive,
    Downed,
    Respawning,
}

impl AuthorityLifeState {
    pub(super) const fn code(self) -> u32 {
        match self {
            Self::Alive => 1,
            Self::Downed => 2,
            Self::Respawning => 3,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AuthorityCombatLifecycleKind {
    Hit,
    Downed,
    Killed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthorityVitals {
    pub health: i32,
    pub action: i32,
    pub spirit: i32,
}

impl Default for AuthorityVitals {
    fn default() -> Self {
        Self {
            health: DEFAULT_HEALTH,
            action: DEFAULT_ACTION,
            spirit: DEFAULT_SPIRIT,
        }
    }
}

impl AuthorityVitals {
    pub(super) fn clamp_to_max(self, max_vitals: Self) -> Self {
        Self {
            health: self.health.clamp(1, max_vitals.health.max(1)),
            action: self.action.clamp(1, max_vitals.action.max(1)),
            spirit: self.spirit.clamp(1, max_vitals.spirit.max(1)),
        }
    }

    pub(super) fn zero() -> Self {
        Self {
            health: 0,
            action: 0,
            spirit: 0,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub(super) struct ActorTraits {
    pub(super) body: i32,
    pub(super) spirit: i32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub(super) struct ActorEffectiveStats {
    pub(super) traits: ActorTraits,
    pub(super) spawn_vitals: AuthorityVitals,
    pub(super) max_vitals: AuthorityVitals,
    pub(super) regen_rates_milli_per_second: AuthorityVitals,
    pub(super) movement_speed_multiplier_milli: i32,
    pub(super) suppression_resistance_milli: i32,
    pub(super) suppression_threshold_milli: i32,
    pub(super) panic_duration_multiplier_milli: i32,
    pub(super) bleed_tolerance_milli: i32,
    pub(super) dodge_chance_milli: i32,
    pub(super) clone_sickness_tolerance_milli: i32,
    /// MEDIC WAVE: the ONE unified defense_vs_state permille (sum of active buffs,
    /// clamp 0..1000). Read by C4's soft-state apply path via defended_state_ticks.
    pub(super) defense_vs_state_milli: i32,
}

pub(super) fn actor_traits_for_role(role: &str) -> ActorTraits {
    match role {
        "player" => ActorTraits {
            body: 100,
            spirit: 100,
        },
        "agent_player" => ActorTraits {
            body: 180,
            spirit: 150,
        },
        "public_shopkeeper" => ActorTraits {
            body: 92,
            spirit: 86,
        },
        "scripted_player" => ActorTraits {
            body: 88,
            spirit: 82,
        },
        "creature" => ActorTraits {
            body: 58,
            spirit: 42,
        },
        "skirmisher" => ActorTraits {
            body: 74,
            spirit: 68,
        },
        "skirmisher_assault" => ActorTraits {
            body: 80,
            spirit: 58,
        },
        "skirmisher_anchor" => ActorTraits {
            body: 86,
            spirit: 82,
        },
        "skirmisher_flanker" => ActorTraits {
            body: 72,
            spirit: 76,
        },
        "skirmisher_deadeye" => ActorTraits {
            body: 68,
            spirit: 92,
        },
        "skirmisher_brawler" => ActorTraits {
            body: 124,
            spirit: 62,
        },
        _ => ActorTraits {
            body: 75,
            spirit: 75,
        },
    }
}

pub(super) fn derive_effective_actor_stats_for_role(role: &str) -> ActorEffectiveStats {
    let mut stats = derive_effective_actor_stats(actor_traits_for_role(role));
    apply_role_effective_stat_overrides(role, &mut stats);
    stats
}

pub(super) fn derive_effective_actor_stats_for_role_and_buffs(
    role: &str,
    buffs: &[ServiceBuffAuthorityState],
) -> ActorEffectiveStats {
    let mut traits = actor_traits_for_role(role);
    let mut defense_vs_state_milli = 0_i32;
    for buff in buffs {
        traits.body = traits.body.saturating_add(buff.body_delta);
        traits.spirit = traits.spirit.saturating_add(buff.spirit_delta);
        // MEDIC WAVE: ONE unified defense_vs_state — sum active buff contributions.
        defense_vs_state_milli = defense_vs_state_milli.saturating_add(buff.defense_vs_state_milli);
    }
    let mut stats = derive_effective_actor_stats(traits);
    stats.defense_vs_state_milli = defense_vs_state_milli.clamp(0, 1_000);
    apply_role_effective_stat_overrides(role, &mut stats);
    stats
}

fn apply_role_effective_stat_overrides(role: &str, stats: &mut ActorEffectiveStats) {
    stats.dodge_chance_milli = dodge_chance_milli_for_role(role);
    if is_player_like_role(role) {
        stats.regen_rates_milli_per_second.health =
            stats.regen_rates_milli_per_second.health.max(6_000);
    }
    match role {
        "agent_player" => {
            stats.movement_speed_multiplier_milli = stats
                .movement_speed_multiplier_milli
                .max(AGENT_PLAYER_MOVEMENT_MULTIPLIER_MIN_MILLI);
        }
        "skirmisher" | "skirmisher_brawler" => {
            stats.movement_speed_multiplier_milli = stats
                .movement_speed_multiplier_milli
                .min(ROGUE_TROOPER_MOVEMENT_MULTIPLIER_CAP_MILLI);
        }
        _ => {}
    }
}

pub(super) fn refresh_actor_effective_stats(actor: &mut ActorAuthorityState) {
    let old_max_vitals = actor.max_vitals;
    let next_stats =
        derive_effective_actor_stats_for_role_and_buffs(&actor.role, &actor.service_buffs);
    actor.effective_stats = next_stats;
    actor.max_vitals = next_stats.max_vitals;
    actor.vitals.health = adjust_vital_for_max_change(
        actor.vitals.health,
        old_max_vitals.health,
        actor.max_vitals.health,
    );
    actor.vitals.action = adjust_vital_for_max_change(
        actor.vitals.action,
        old_max_vitals.action,
        actor.max_vitals.action,
    );
    actor.vitals.spirit = adjust_vital_for_max_change(
        actor.vitals.spirit,
        old_max_vitals.spirit,
        actor.max_vitals.spirit,
    );
}

pub(super) fn adjust_vital_for_max_change(current: i32, old_max: i32, new_max: i32) -> i32 {
    if new_max > old_max {
        current
            .saturating_add(new_max - old_max)
            .clamp(1, new_max.max(1))
    } else {
        current.clamp(1, new_max.max(1))
    }
}

pub(super) fn active_effect_label(effect_id: &str) -> &'static str {
    match effect_id {
        "stimpak_a_heal" => "Stimpak A",
        "advanced_stimpak_heal" => "Advanced Stimpak",
        MEDIC_PREP_EFFECT_ID => "Body Enhancement Pack A",
        ENTERTAINER_SESSION_EFFECT_ID => "Spirit Enhancement Pack A",
        STATE_DEFENSE_EFFECT_ID => "State Defense",
        _ => "Active effect",
    }
}

pub(super) fn actor_owns_inventory_container(actor_id: &str, container: &str) -> bool {
    container == actor_id
        || container
            .strip_prefix(actor_id)
            .is_some_and(|suffix| suffix.starts_with(':') || suffix.starts_with('/'))
}

pub(super) fn actor_can_access_exchange_container(
    actor: &ActorAuthorityState,
    container: &ExchangeContainerAuthorityState,
) -> bool {
    let unrestricted = container.owner_actor_id.is_none()
        && container.allowed_actor_ids.is_empty()
        && container.allowed_faction_ids.is_empty();
    unrestricted
        || container
            .owner_actor_id
            .as_deref()
            .is_some_and(|owner| owner == actor.id)
        || container.allowed_actor_ids.contains(&actor.id)
        || actor
            .faction
            .faction_id
            .as_ref()
            .is_some_and(|faction_id| container.allowed_faction_ids.contains(faction_id))
}

pub(super) fn consumable_duration_ticks(duration_ms: u64, tick_rate_hz: u32) -> u16 {
    let ticks = ms_to_ticks_round(duration_ms, tick_rate_hz).max(1);
    u16::try_from(ticks).unwrap_or(u16::MAX)
}

pub(super) fn service_buff_duration_ticks(tick_rate_hz: u32) -> u64 {
    ms_to_ticks_round(SERVICE_BUFF_DURATION_MS, tick_rate_hz).max(1)
}

pub(super) fn is_player_like_role(role: &str) -> bool {
    matches!(role, "player" | "agent_player")
}

pub(super) fn actor_can_use_personal_shield(actor: &ActorAuthorityState) -> bool {
    is_player_like_role(&actor.role)
        && actor.life_state == AuthorityLifeState::Alive
        && actor.equipped_weapon_id.is_some_and(is_melee_weapon_id)
}

pub(super) fn dodge_chance_milli_for_role(role: &str) -> i32 {
    if is_player_like_role(role) {
        PLAYER_LIKE_BASE_DODGE_CHANCE_MILLI
    } else {
        0
    }
}

pub(super) fn is_human_player_actor(actor: &ActorAuthorityState) -> bool {
    actor.role == "player" || actor.id == "player" || actor.id.starts_with("game-ws-")
}

pub(super) fn actor_uses_unlimited_ammo(actor: &ActorAuthorityState) -> bool {
    !is_human_player_actor(actor)
}

pub(super) fn actor_is_visible_corpse(actor: &ActorAuthorityState, tick: u64) -> bool {
    actor.life_state == AuthorityLifeState::Downed
        && actor.body_vanish_tick > 0
        && tick < actor.body_vanish_tick
}

pub(super) fn actor_is_lootable_corpse(
    actor: &ActorAuthorityState,
    has_loot: bool,
    tick: u64,
) -> bool {
    actor_is_visible_corpse(actor, tick)
        && (has_loot
            || (is_harvestable_creature_actor(actor) && actor.corpse_exhausted_tick.is_none()))
}

pub(super) fn derive_effective_actor_stats(traits: ActorTraits) -> ActorEffectiveStats {
    let body = traits.body.max(1);
    let spirit = traits.spirit.max(1);
    let normalized = ActorTraits { body, spirit };
    let action = action_capacity(body, spirit);
    let max_vitals = AuthorityVitals {
        health: DEFAULT_HEALTH.max(body),
        action: DEFAULT_ACTION.max(action),
        spirit: DEFAULT_SPIRIT.max(spirit),
    };
    let regen_rates_milli_per_second = actor_regen_rates_milli_per_second(body, spirit);
    let spawn_vitals = AuthorityVitals {
        health: body.clamp(1, max_vitals.health),
        action: action.clamp(1, max_vitals.action),
        spirit: spirit.clamp(1, max_vitals.spirit),
    };
    let movement_speed_multiplier_milli = (750
        + body
            .saturating_mul(750)
            .saturating_add(spirit.saturating_mul(250))
            / 400)
        .clamp(550, 1_000);
    let suppression_resistance_milli = spirit.saturating_mul(10).clamp(250, i32::MAX);
    let suppression_threshold_milli = div_ceil_i32(
        RANGED_SUPPRESSION_THRESHOLD_MILLI.saturating_mul(suppression_resistance_milli),
        1_000,
    )
    .max(1);
    let panic_duration_multiplier_milli = (1_350 - spirit.saturating_mul(4)).clamp(350, 1_250);
    let bleed_tolerance_milli = (550 + body.saturating_mul(1_000) / 220).clamp(450, i32::MAX);
    let clone_sickness_tolerance_milli =
        (450 + body.saturating_add(spirit).saturating_mul(1_000) / 360).clamp(450, i32::MAX);

    ActorEffectiveStats {
        traits: normalized,
        spawn_vitals,
        max_vitals,
        regen_rates_milli_per_second,
        movement_speed_multiplier_milli,
        suppression_resistance_milli,
        suppression_threshold_milli,
        panic_duration_multiplier_milli,
        bleed_tolerance_milli,
        dodge_chance_milli: 0,
        clone_sickness_tolerance_milli,
        defense_vs_state_milli: 0,
    }
}
pub(super) fn action_capacity(body: i32, spirit: i32) -> i32 {
    body.saturating_mul(850)
        .saturating_add(spirit.saturating_mul(150))
        .saturating_add(500)
        / 1_000
}

pub(super) fn actor_regen_rates_milli_per_second(body: i32, spirit: i32) -> AuthorityVitals {
    AuthorityVitals {
        health: (333 + body.saturating_mul(542) / 100 + spirit.saturating_mul(125) / 100).max(10),
        action: (450 + div_round_nearest_i32(body.saturating_mul(195), 10))
            .saturating_mul(ACTION_REGEN_RATE_MULTIPLIER)
            .max(10),
        spirit: (150
            + div_round_nearest_i32(body.saturating_mul(55), 10)
            + spirit.saturating_mul(14))
        .max(10),
    }
}

pub(super) fn div_round_nearest_i32(value: i32, divisor: i32) -> i32 {
    if divisor <= 0 {
        return 0;
    }
    value.saturating_add(divisor / 2) / divisor
}

pub(super) fn authority_vitals_from_actor_snapshot(
    vitals: crate::ActorVitalsSnapshot,
) -> AuthorityVitals {
    AuthorityVitals {
        health: vitals.health,
        action: vitals.action,
        spirit: vitals.spirit,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthorityBleedSnapshot {
    pub active: bool,
    pub stack_count: u8,
    pub remaining_ticks: u16,
    pub damage_per_tick: i32,
    pub damage_per_second_milli: i32,
}

impl AuthorityBleedSnapshot {
    pub(super) fn from_actor(actor: &ActorAuthorityState, tick_rate_hz: u32) -> Self {
        let remaining_ticks = actor
            .bleed_stacks
            .iter()
            .map(|stack| stack.remaining_ticks)
            .max()
            .unwrap_or(0);
        let damage_milli_per_tick: i32 = actor
            .bleed_stacks
            .iter()
            .map(|stack| stack.damage_milli_per_tick)
            .sum();
        let damage_per_tick = div_ceil_i32(damage_milli_per_tick, 1_000);
        let damage_per_second_milli =
            damage_milli_per_tick.saturating_mul(tick_rate_hz.max(1) as i32);
        Self {
            active: !actor.bleed_stacks.is_empty(),
            stack_count: u8::try_from(actor.bleed_stacks.len()).expect("bleed stack count fits u8"),
            remaining_ticks,
            damage_per_tick,
            damage_per_second_milli,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthoritySleepSnapshot {
    pub active: bool,
    pub stacks: u8,
    pub threshold: u8,
    pub remaining_ticks: u16,
}

impl AuthoritySleepSnapshot {
    pub(super) fn from_actor(actor: &ActorAuthorityState) -> Self {
        Self {
            active: actor.sleep.remaining_ticks > 0,
            stacks: actor.sleep.stacks,
            threshold: SLEEP_KILL_THRESHOLD,
            remaining_ticks: actor.sleep.remaining_ticks,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthoritySuppressionSnapshot {
    pub active: bool,
    pub pressure: f64,
    pub remaining_ticks: u16,
    pub source: Option<CellSnapshot>,
}

impl AuthoritySuppressionSnapshot {
    pub(super) fn from_actor(actor: &ActorAuthorityState) -> Self {
        let threshold = suppression_threshold_milli_for_actor(actor);
        let active = actor.suppression.pressure_milli >= threshold;
        let remaining_ticks = if active {
            pressure_active_remaining_ticks(
                actor.suppression.pressure_milli,
                threshold,
                actor.effective_stats.suppression_resistance_milli,
            )
        } else {
            0
        };
        Self {
            active,
            pressure: f64::from(actor.suppression.pressure_milli) / 1_000.0,
            remaining_ticks,
            source: actor
                .suppression
                .source
                .map(|source| CellSnapshot::new(source.cell().x, source.cell().y)),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthorityPersonalShieldSnapshot {
    pub charge_milli: u32,
    pub max_charge_milli: u32,
    #[serde(default)]
    pub durability_milli: u32,
    #[serde(default)]
    pub max_durability_milli: u32,
    pub durability_charges: u16,
    pub max_durability_charges: u16,
    pub recharge_available_tick: u64,
    pub recharge_blocked: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_damage_tick: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_block_tick: Option<u64>,
}

impl AuthorityPersonalShieldSnapshot {
    pub(super) fn from_actor(
        actor: &ActorAuthorityState,
        tick: u64,
        tick_rate_hz: u32,
    ) -> Option<Self> {
        if !actor_can_use_personal_shield(actor) {
            return None;
        }
        let shield = actor.personal_shield.as_ref()?;
        let recharge_delay_ticks =
            ms_to_ticks_round(PERSONAL_SHIELD_RECHARGE_DELAY_MS, tick_rate_hz).max(1);
        let recharge_available_tick = shield.last_damage_tick.saturating_add(recharge_delay_ticks);
        Some(Self {
            charge_milli: shield.charge_milli,
            max_charge_milli: PERSONAL_SHIELD_MAX_CHARGE_MILLI,
            durability_milli: shield.durability_milli,
            max_durability_milli: PERSONAL_SHIELD_MAX_DURABILITY_MILLI,
            durability_charges: shield.durability_charges,
            max_durability_charges: PERSONAL_SHIELD_MAX_DURABILITY_CHARGES,
            recharge_available_tick,
            recharge_blocked: tick < recharge_available_tick,
            last_damage_tick: Some(shield.last_damage_tick),
            last_block_tick: Some(shield.last_block_tick),
        })
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthorityActorStatsSnapshot {
    pub damage_done: u64,
    pub damage_taken: u64,
    pub kills: u64,
    pub npc_kills: u64,
    pub player_kills: u64,
    pub deaths: u64,
    pub shots_fired: u64,
    pub hits_dealt: u64,
    pub hits_taken: u64,
    pub distance_moved_cells: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_damage_dealt_tick: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_damage_taken_tick: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_kill_tick: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_death: Option<AuthorityActorDeathStatsSnapshot>,
    #[serde(rename = "recent10s")]
    pub recent_10s: AuthorityActorRecentStatsSnapshot,
    #[serde(rename = "recent60s")]
    pub recent_60s: AuthorityActorRecentStatsSnapshot,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthorityMobilitySnapshot {
    pub sprint_action_drain_milli: i32,
    pub sprint_recovery_locked: bool,
    pub sprint_regen_block_until_tick: u64,
    pub sprint_regen_blocked: bool,
    pub sprint_moves: u64,
    pub sprint_ticks: u64,
    pub sprint_action_spent_milli: u64,
    pub sprint_distance_cells: f64,
    pub tactical_sprint_moves: u64,
    pub tactical_sprint_ticks: u64,
    pub tactical_sprint_action_spent_milli: u64,
    pub tactical_sprint_distance_cells: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_sprint_tick: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_sprint_reason: Option<String>,
}

impl AuthorityMobilitySnapshot {
    pub(super) fn from_actor(actor: &ActorAuthorityState, tick: u64) -> Self {
        Self {
            sprint_action_drain_milli: actor.sprint_action_drain_milli,
            sprint_recovery_locked: actor.sprint_recovery_locked,
            sprint_regen_block_until_tick: actor.sprint_regen_block_until_tick,
            sprint_regen_blocked: actor.sprint_regen_block_until_tick > tick,
            sprint_moves: actor.mobility.sprint_moves,
            sprint_ticks: actor.mobility.sprint_ticks,
            sprint_action_spent_milli: actor.mobility.sprint_action_spent_milli,
            sprint_distance_cells: cell_units_from_milli_u64(actor.mobility.sprint_distance_milli),
            tactical_sprint_moves: actor.mobility.tactical_sprint_moves,
            tactical_sprint_ticks: actor.mobility.tactical_sprint_ticks,
            tactical_sprint_action_spent_milli: actor.mobility.tactical_sprint_action_spent_milli,
            tactical_sprint_distance_cells: cell_units_from_milli_u64(
                actor.mobility.tactical_sprint_distance_milli,
            ),
            last_sprint_tick: actor.mobility.last_sprint_tick,
            last_sprint_reason: actor.mobility.last_sprint_reason.clone(),
        }
    }
}

impl AuthorityActorStatsSnapshot {
    pub(super) fn from_actor(actor: &ActorAuthorityState, tick: u64, tick_rate_hz: u32) -> Self {
        Self {
            damage_done: actor.stats.damage_done,
            damage_taken: actor.stats.damage_taken,
            kills: actor.stats.kills,
            npc_kills: actor.stats.npc_kills,
            player_kills: actor.stats.player_kills,
            deaths: actor.stats.deaths,
            shots_fired: actor.stats.shots_fired,
            hits_dealt: actor.stats.hits_dealt,
            hits_taken: actor.stats.hits_taken,
            distance_moved_cells: cell_units_from_milli_u64(actor.stats.distance_moved_milli),
            last_damage_dealt_tick: actor.stats.last_damage_dealt_tick,
            last_damage_taken_tick: actor.stats.last_damage_taken_tick,
            last_kill_tick: actor.stats.last_kill_tick,
            last_death: actor
                .stats
                .last_death
                .as_ref()
                .map(AuthorityActorDeathStatsSnapshot::from_stats),
            recent_10s: AuthorityActorRecentStatsSnapshot::from_actor(
                actor,
                tick,
                tick_rate_hz,
                ACTOR_STATS_RECENT_10_SECONDS,
            ),
            recent_60s: AuthorityActorRecentStatsSnapshot::from_actor(
                actor,
                tick,
                tick_rate_hz,
                ACTOR_STATS_RECENT_60_SECONDS,
            ),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthorityActorDeathStatsSnapshot {
    pub tick: u64,
    pub killer_actor_id: String,
    pub cause: String,
    pub weapon_id: AuthorityWeaponId,
    pub ammo_type: AuthorityAmmoTypeId,
}

impl AuthorityActorDeathStatsSnapshot {
    pub(super) fn from_stats(stats: &ActorDeathStats) -> Self {
        Self {
            tick: stats.tick,
            killer_actor_id: stats.killer_actor_id.clone(),
            cause: stats.cause.clone(),
            weapon_id: stats.weapon_id,
            ammo_type: stats.ammo_type,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthorityActorRecentStatsSnapshot {
    pub window_seconds: u64,
    pub damage_done: u64,
    pub damage_taken: u64,
    pub kills: u64,
    pub npc_kills: u64,
    pub player_kills: u64,
    pub deaths: u64,
    pub shots_fired: u64,
    pub hits_dealt: u64,
    pub hits_taken: u64,
    pub distance_moved_cells: f64,
}

impl AuthorityActorRecentStatsSnapshot {
    pub(super) fn from_actor(
        actor: &ActorAuthorityState,
        tick: u64,
        tick_rate_hz: u32,
        window_seconds: u64,
    ) -> Self {
        let mut aggregate = ActorStatsBucket::default();
        let window_ticks = window_seconds.saturating_mul(u64::from(tick_rate_hz.max(1)));
        let bucket_ticks = actor_stats_bucket_ticks(tick_rate_hz);
        let start_cutoff = tick.saturating_sub(window_ticks);
        for bucket in &actor.stats.buckets {
            if bucket.start_tick == 0
                && bucket.damage_done == 0
                && bucket.damage_taken == 0
                && bucket.kills == 0
                && bucket.deaths == 0
                && bucket.shots_fired == 0
                && bucket.hits_dealt == 0
                && bucket.hits_taken == 0
                && bucket.distance_moved_milli == 0
            {
                continue;
            }
            if bucket.start_tick.saturating_add(bucket_ticks) <= start_cutoff {
                continue;
            }
            aggregate.damage_done = aggregate.damage_done.saturating_add(bucket.damage_done);
            aggregate.damage_taken = aggregate.damage_taken.saturating_add(bucket.damage_taken);
            aggregate.kills = aggregate.kills.saturating_add(bucket.kills);
            aggregate.npc_kills = aggregate.npc_kills.saturating_add(bucket.npc_kills);
            aggregate.player_kills = aggregate.player_kills.saturating_add(bucket.player_kills);
            aggregate.deaths = aggregate.deaths.saturating_add(bucket.deaths);
            aggregate.shots_fired = aggregate.shots_fired.saturating_add(bucket.shots_fired);
            aggregate.hits_dealt = aggregate.hits_dealt.saturating_add(bucket.hits_dealt);
            aggregate.hits_taken = aggregate.hits_taken.saturating_add(bucket.hits_taken);
            aggregate.distance_moved_milli = aggregate
                .distance_moved_milli
                .saturating_add(bucket.distance_moved_milli);
        }
        Self {
            window_seconds,
            damage_done: aggregate.damage_done,
            damage_taken: aggregate.damage_taken,
            kills: aggregate.kills,
            npc_kills: aggregate.npc_kills,
            player_kills: aggregate.player_kills,
            deaths: aggregate.deaths,
            shots_fired: aggregate.shots_fired,
            hits_dealt: aggregate.hits_dealt,
            hits_taken: aggregate.hits_taken,
            distance_moved_cells: cell_units_from_milli_u64(aggregate.distance_moved_milli),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthorityActorWeaponSnapshot {
    pub weapon_id: String,
    pub ammo_type: String,
    #[serde(default, skip_serializing_if = "is_zero_u32")]
    pub weapon_item_id: u32,
    #[serde(default, skip_serializing_if = "is_zero_u32")]
    pub weapon_variant_id: u32,
    pub loaded_rounds: u32,
    pub magazine_size: u32,
    pub reload_until_tick: u64,
    pub reload_remaining_ticks: u64,
    pub reload_total_ticks: u64,
}

impl AuthorityActorWeaponSnapshot {
    pub(super) fn from_actor(
        actor: &ActorAuthorityState,
        tick: u64,
        tick_rate_hz: u32,
    ) -> Option<Self> {
        match actor.equipped_weapon_id {
            Some(AuthorityWeaponId::Slugthrower) => {
                let reload_total_ticks = ms_to_ticks_round(
                    slugthrower_reload_time_ms(
                        SLUGTHROWER_RELOAD_MS,
                        actor.equipped_weapon_variant_id,
                    ),
                    tick_rate_hz,
                )
                .max(1);
                Some(Self {
                    weapon_id: authority_weapon_id_label(AuthorityWeaponId::Slugthrower).to_owned(),
                    ammo_type: authority_ammo_type_label(AuthorityAmmoTypeId::SlugIron).to_owned(),
                    weapon_item_id: actor.equipped_weapon_item_id,
                    weapon_variant_id: actor.equipped_weapon_variant_id,
                    loaded_rounds: actor.slugthrower_magazine.loaded_rounds,
                    magazine_size: SLUGTHROWER_MAGAZINE_SIZE,
                    reload_until_tick: actor.slugthrower_magazine.reload_until_tick,
                    reload_remaining_ticks: reload_remaining_ticks(
                        actor.slugthrower_magazine,
                        tick,
                    ),
                    reload_total_ticks,
                })
            }
            Some(
                weapon_id @ (AuthorityWeaponId::Vibrosword
                | AuthorityWeaponId::ScraplineMachete
                | AuthorityWeaponId::FieldSaber
                | AuthorityWeaponId::QuarryChopper
                | AuthorityWeaponId::Unarmed),
            ) => Some(Self {
                weapon_id: authority_weapon_id_label(weapon_id).to_owned(),
                ammo_type: authority_ammo_type_label(AuthorityAmmoTypeId::Melee).to_owned(),
                weapon_item_id: actor.equipped_weapon_item_id,
                weapon_variant_id: actor.equipped_weapon_variant_id,
                loaded_rounds: 1,
                magazine_size: 1,
                reload_until_tick: 0,
                reload_remaining_ticks: 0,
                reload_total_ticks: 1,
            }),
            Some(
                weapon_id @ (AuthorityWeaponId::WpnPistol
                | AuthorityWeaponId::WpnSmg
                | AuthorityWeaponId::WpnCarbine
                | AuthorityWeaponId::LightningCarbine
                | AuthorityWeaponId::WpnAssault
                | AuthorityWeaponId::WpnShotgun
                | AuthorityWeaponId::WpnSniper
                | AuthorityWeaponId::WpnHeavy
                | AuthorityWeaponId::WpnLauncher),
            ) => {
                // Ranged catalog weapons share the Coil Slug magazine. Crafted
                // carbine variants use the existing reliability reload dimension.
                let reload_ms = if uses_crafted_ranged_variant(weapon_id) {
                    slugthrower_reload_time_ms(
                        SLUGTHROWER_RELOAD_MS,
                        actor.equipped_weapon_variant_id,
                    )
                } else {
                    SLUGTHROWER_RELOAD_MS
                };
                let reload_total_ticks = ms_to_ticks_round(reload_ms, tick_rate_hz).max(1);
                Some(Self {
                    weapon_id: authority_weapon_id_label(weapon_id).to_owned(),
                    ammo_type: authority_ammo_type_label(AuthorityAmmoTypeId::SlugIron).to_owned(),
                    weapon_item_id: actor.equipped_weapon_item_id,
                    weapon_variant_id: actor.equipped_weapon_variant_id,
                    loaded_rounds: actor.slugthrower_magazine.loaded_rounds,
                    magazine_size: SLUGTHROWER_MAGAZINE_SIZE,
                    reload_until_tick: actor.slugthrower_magazine.reload_until_tick,
                    reload_remaining_ticks: reload_remaining_ticks(
                        actor.slugthrower_magazine,
                        tick,
                    ),
                    reload_total_ticks,
                })
            }
            None => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthorityCombatQueueEntrySnapshot {
    pub action_id: String,
    pub target_actor_id: String,
    #[serde(default, skip_serializing_if = "is_false")]
    pub auto: bool,
}

fn is_false(value: &bool) -> bool {
    !*value
}

fn is_zero_u32(value: &u32) -> bool {
    *value == 0
}

fn is_zero_u64(value: &u64) -> bool {
    *value == 0
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthorityCombatQueueSnapshot {
    pub next_ready_tick: u64,
    pub entries: Vec<AuthorityCombatQueueEntrySnapshot>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AbilityQueueLifecycle {
    Enqueued,
    Pending,
    Fired,
    Dismissed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthorityAbilityQueueEventSnapshot {
    pub actor_id: String,
    pub id: String,
    pub lifecycle: AbilityQueueLifecycle,
    pub tick: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason_code: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fire_seq: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ability_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon_id: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AbilityQueueEntryClass {
    Combat,
    Posture,
    Utility,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthorityAbilityQueueEntrySnapshot {
    pub id: String,
    pub ability_id: String,
    pub icon_id: String,
    #[serde(rename = "class")]
    pub entry_class: AbilityQueueEntryClass,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_actor_id: Option<String>,
    pub lifecycle: AbilityQueueLifecycle,
    pub enqueued_at_tick: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ready_tick: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fired_at_tick: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dismissed_at_tick: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason_code: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fire_seq: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthorityAbilityQueueSnapshot {
    pub actor_id: String,
    pub next_ready_tick: u64,
    pub entries: Vec<AuthorityAbilityQueueEntrySnapshot>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub repeat_intent: Option<AuthorityAbilityQueueEntrySnapshot>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct AuthorityActorFaceSnapshot {
    pub eyes: String,
    pub brows: String,
    pub nose: String,
    pub mouth: String,
    pub eye_color: String,
    pub brow_color: String,
    pub lip_color: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct AuthorityActorAppearanceSnapshot {
    pub skin: String,
    pub hair: Option<String>,
    pub hair_mat: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub face: Option<AuthorityActorFaceSnapshot>,
}

impl Default for AuthorityActorAppearanceSnapshot {
    fn default() -> Self {
        Self {
            skin: "#c78f62".to_owned(),
            hair: Some("hair_mop".to_owned()),
            hair_mat: "hair_raven".to_owned(),
            face: None,
        }
    }
}
pub(super) fn link_dead_hold_ticks(tick_rate_hz: u32) -> u64 {
    link_dead_hold_seconds().saturating_mul(u64::from(tick_rate_hz.max(1)))
}

/// Host-only config override for the link-dead hold window; gated out of the
/// wasm32 deterministic build. Read once at construction, never inside the tick.
#[allow(clippy::disallowed_methods)]
fn link_dead_hold_seconds() -> u64 {
    #[cfg(not(target_arch = "wasm32"))]
    {
        if let Ok(value) = std::env::var("GAME_LD_SECONDS") {
            if let Ok(seconds) = value.trim().parse::<u64>() {
                return seconds.clamp(1, 86_400);
            }
        }
    }
    300
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthorityActorSnapshot {
    pub id: String,
    /// Durable logical owner/entity. This can differ from `id` when a real
    /// character occupies an authored placeholder such as `player`.
    pub entity: String,
    pub label: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub display_name: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub descriptor: String,
    #[serde(default)]
    pub link_dead: bool,
    #[serde(default)]
    pub appearance: AuthorityActorAppearanceSnapshot,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub worn: Vec<AuthorityActorWornPiece>,
    pub sprite: String,
    pub role: String,
    pub scale: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub template_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub spawn_zone_id: Option<String>,
    pub area_id: String,
    pub x: f64,
    pub y: f64,
    pub direction: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub faction_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub social_group: Option<String>,
    pub pvp_status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ai_attitude: Option<String>,
    /// Threat legibility (owner 2026-07-08): true when this actor will auto-aggro
    /// (RED nameplate); false = provoked-only (YELLOW). Recomputed per snapshot
    /// from the live attitude — see `actor_will_auto_aggro`.
    #[serde(default)]
    pub will_auto_aggro: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub player_organization_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub player_organization_tag: Option<String>,
    pub life_state: AuthorityLifeState,
    pub lifecycle_seq: u64,
    pub posture: AuthorityActorPosture,
    pub posture_until_tick: u64,
    pub vitals: AuthorityVitals,
    pub max_vitals: AuthorityVitals,
    pub bleed: AuthorityBleedSnapshot,
    pub sleep: AuthoritySleepSnapshot,
    pub suppression: AuthoritySuppressionSnapshot,
    pub mobility: AuthorityMobilitySnapshot,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub personal_shield: Option<AuthorityPersonalShieldSnapshot>,
    #[serde(default)]
    pub weapon: Option<AuthorityActorWeaponSnapshot>,
    pub stats: AuthorityActorStatsSnapshot,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub active_effects: Vec<AuthorityActiveEffectSnapshot>,
    // Full actor snapshots must distinguish "no professions" from an omitted
    // field in a partial/delta payload. Emitting [] lets the TypeScript mirror
    // clear the final novice box after an accepted unlearn while preserving its
    // established omit-means-unchanged convention for true partial snapshots.
    #[serde(default)]
    pub professions: Vec<AuthorityProfessionSnapshot>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active_title: Option<AuthorityProfessionTitleSnapshot>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub capabilities: Vec<AuthorityActorCapabilitySnapshot>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub career_goal: Option<AuthorityCareerGoalSnapshot>,
    #[serde(default)]
    pub skill_points_used: u16,
    #[serde(default)]
    pub skill_points_cap: u16,
    #[serde(default)]
    pub shot_spread_degrees_milli: i32,
    #[serde(default)]
    pub walk_speed_milli_per_second: i32,
    #[serde(default)]
    pub sprint_speed_milli_per_second: i32,
    #[serde(default)]
    pub credits: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub combat_queue: Option<AuthorityCombatQueueSnapshot>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ability_queue: Option<AuthorityAbilityQueueSnapshot>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub in_combat: Option<bool>,
    #[serde(default)]
    pub peace_requested: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub engagement_target_id: Option<String>,
    #[serde(default)]
    pub lootable: bool,
    #[serde(default)]
    pub has_loot: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub loot_rights_actor_id: Option<String>,
    #[serde(default)]
    pub incap_remaining_ticks: u64,
    #[serde(default)]
    pub incap_count: u8,
    #[serde(default)]
    pub incap_window_ticks: u64,
    #[serde(default, skip_serializing_if = "is_zero_u64")]
    pub body_vanish_tick: u64,
    #[serde(default, skip_serializing_if = "is_zero_u64")]
    pub next_sample_tick: u64,
    pub respawn_tick: u64,
    pub clone_sickness_ticks: u64,
}

impl AuthorityActorSnapshot {
    pub(super) fn from_actor_with_loot(
        actor: &ActorAuthorityState,
        tick: u64,
        tick_rate_hz: u32,
        has_loot: bool,
    ) -> Self {
        Self {
            id: actor.id.clone(),
            entity: actor.entity.clone(),
            label: actor.label.clone(),
            display_name: actor.display_name.clone(),
            descriptor: actor.descriptor.clone(),
            link_dead: actor.link_dead,
            appearance: actor.appearance.clone(),
            worn: actor.worn.clone(),
            sprite: actor.sprite.clone(),
            role: actor.role.clone(),
            scale: actor.scale,
            template_id: actor.template_id.clone(),
            spawn_zone_id: actor.spawn_zone_id.clone(),
            area_id: actor.area_id.clone(),
            x: actor.position.world_x(),
            y: actor.position.world_y(),
            direction: actor.direction.clone(),
            faction_id: actor.faction.faction_id.clone(),
            social_group: actor.faction.social_group.clone(),
            pvp_status: actor.faction.pvp_status.label().to_owned(),
            ai_attitude: actor_ai_attitude(actor).map(|attitude| attitude.label().to_owned()),
            will_auto_aggro: actor_will_auto_aggro(actor),
            player_organization_id: actor.player_organization_id.clone(),
            player_organization_tag: actor.player_organization_tag.clone(),
            life_state: actor.life_state,
            lifecycle_seq: actor.lifecycle_seq,
            posture: actor.posture,
            posture_until_tick: actor.posture_until_tick,
            vitals: actor.vitals,
            max_vitals: actor.max_vitals,
            bleed: AuthorityBleedSnapshot::from_actor(actor, tick_rate_hz),
            sleep: AuthoritySleepSnapshot::from_actor(actor),
            suppression: AuthoritySuppressionSnapshot::from_actor(actor),
            mobility: AuthorityMobilitySnapshot::from_actor(actor, tick),
            personal_shield: AuthorityPersonalShieldSnapshot::from_actor(actor, tick, tick_rate_hz),
            weapon: AuthorityActorWeaponSnapshot::from_actor(actor, tick, tick_rate_hz),
            stats: AuthorityActorStatsSnapshot::from_actor(actor, tick, tick_rate_hz),
            active_effects: AuthorityActiveEffectSnapshot::from_actor(actor, tick, tick_rate_hz),
            professions: AuthorityProfessionSnapshot::from_actor(actor),
            active_title: actor.professions.active_title(),
            capabilities: AuthorityActorCapabilitySnapshot::from_actor(actor),
            career_goal: AuthorityCareerGoalSnapshot::from_actor(actor),
            skill_points_used: actor.professions.skill_points_used(),
            skill_points_cap: actor.professions.skill_point_cap,
            shot_spread_degrees_milli: actor
                .equipped_weapon_id
                .map(|weapon_id| {
                    shot_spread_degrees_milli_for_actor_at_tick_rate(
                        actor,
                        weapon_profile(Some(weapon_id)),
                        tick,
                        tick_rate_hz,
                        0,
                    )
                })
                .unwrap_or(0),
            walk_speed_milli_per_second: scaled_milli(
                PLAYER_SPEED_MILLI_CELLS_PER_SECOND,
                movement_speed_multiplier_milli_for_actor(actor),
            ),
            sprint_speed_milli_per_second: scaled_milli(
                PLAYER_SPEED_MILLI_CELLS_PER_SECOND,
                scaled_milli(
                    movement_speed_multiplier_milli_for_actor(actor),
                    scaled_milli(
                        SPRINT_SPEED_MULTIPLIER_MILLI,
                        sprint_speed_multiplier_milli_for_actor(actor),
                    ),
                ),
            ),
            credits: actor.professions.credits,
            combat_queue: AuthorityCombatQueueSnapshot::from_actor(actor),
            ability_queue: AuthorityAbilityQueueSnapshot::from_actor(actor),
            in_combat: actor.in_combat_snapshot(tick),
            peace_requested: actor.peace_requested,
            engagement_target_id: actor.engagement_target_id.clone(),
            lootable: actor_is_lootable_corpse(actor, has_loot, tick),
            has_loot,
            loot_rights_actor_id: actor.loot_rights_actor_id.clone(),
            body_vanish_tick: actor.body_vanish_tick,
            next_sample_tick: actor
                .resource_sample_loop
                .as_ref()
                .map(|sample_loop| sample_loop.next_sample_tick)
                .unwrap_or_default(),
            respawn_tick: actor.respawn_tick,
            clone_sickness_ticks: actor.clone_sickness_ticks,
            incap_remaining_ticks: actor.incap_remaining_ticks(tick),
            incap_count: actor.active_incap_count(tick, tick_rate_hz),
            incap_window_ticks: actor.incap_window_remaining_ticks(tick, tick_rate_hz),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthorityActiveEffectSnapshot {
    pub id: String,
    pub label: String,
    pub kind: String,
    pub remaining_ticks: u64,
    pub total_ticks: u64,
}

impl AuthorityActiveEffectSnapshot {
    pub(super) fn from_actor(
        actor: &ActorAuthorityState,
        tick: u64,
        tick_rate_hz: u32,
    ) -> Vec<Self> {
        let mut effects = Vec::new();
        if actor.slugthrower_magazine.reload_until_tick > tick {
            effects.push(Self {
                id: "reloading".to_owned(),
                label: "Reloading".to_owned(),
                kind: "weapon_reload".to_owned(),
                remaining_ticks: reload_remaining_ticks(actor.slugthrower_magazine, tick),
                total_ticks: ms_to_ticks_round(
                    slugthrower_reload_time_ms(
                        SLUGTHROWER_RELOAD_MS,
                        actor.equipped_weapon_variant_id,
                    ),
                    tick_rate_hz,
                )
                .max(1),
            });
        }
        for effect in &actor.consumable_effects {
            effects.push(Self {
                id: effect.effect_id.clone(),
                label: active_effect_label(&effect.effect_id).to_owned(),
                kind: "consumable".to_owned(),
                remaining_ticks: u64::from(effect.remaining_ticks),
                total_ticks: u64::from(effect.total_ticks),
            });
        }
        for buff in &actor.service_buffs {
            effects.push(Self {
                id: buff.effect_id.clone(),
                label: active_effect_label(&buff.effect_id).to_owned(),
                kind: "service_buff".to_owned(),
                remaining_ticks: buff.remaining_ticks,
                total_ticks: buff.total_ticks.max(1),
            });
        }
        effects
    }
}

impl AuthorityProfessionSnapshot {
    pub(super) fn from_actor(actor: &ActorAuthorityState) -> Vec<Self> {
        // Emit any profession with progress — learned, base XP, or banked track XP — not
        // learned-only. earlier sandbox design semantics: XP accrues boxless (e.g. combat kill XP paid to every
        // damager) and must be visible before a trainer box is bought so the FE/oracle can
        // price teach lists against banked XP. Deterministic order via all().
        AuthorityProfessionKind::all()
            .into_iter()
            .filter(|profession| {
                actor.professions.learned.contains(profession)
                    || actor
                        .professions
                        .xp
                        .get(profession)
                        .is_some_and(|xp| *xp > 0)
                    || !actor
                        .professions
                        .track_xp_for_profession(*profession)
                        .is_empty()
            })
            .map(|profession| Self {
                id: profession.id().to_owned(),
                label: profession.label().to_owned(),
                xp: *actor.professions.xp.get(&profession).unwrap_or(&0),
                track_xp: actor.professions.track_xp_for_profession(profession),
                skill_points: actor.professions.skill_points_for_profession(profession),
                skill_boxes: actor.professions.skill_boxes_for_profession(profession),
            })
            .collect()
    }
}

impl AuthorityActorCapabilitySnapshot {
    pub(super) fn from_actor(actor: &ActorAuthorityState) -> Vec<Self> {
        actor
            .capabilities
            .granted
            .iter()
            .map(|capability| Self {
                id: capability.clone(),
            })
            .collect()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AuthorityActorPosture {
    Standing,
    KneelingDown,
    Kneeling,
    StandingUp,
}

impl AuthorityActorPosture {
    pub(super) const fn code(self) -> u32 {
        match self {
            Self::Standing => 1,
            Self::KneelingDown => 2,
            Self::Kneeling => 3,
            Self::StandingUp => 4,
        }
    }
}

pub(super) const fn posture_allows_melee_attack(posture: AuthorityActorPosture) -> bool {
    matches!(posture, AuthorityActorPosture::Standing)
}
