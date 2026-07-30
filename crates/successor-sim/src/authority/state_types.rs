//! Internal authority world, actor, AI, and durable-state records.

use super::*;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(super) struct AreaAuthorityState {
    pub(super) id: String,
    pub(super) kind: String,
    pub(super) width: u32,
    pub(super) height: u32,
    pub(super) level: i32,
}

impl AreaAuthorityState {
    pub(super) fn from_area(area: &AreaSpec) -> Self {
        Self {
            id: area.id.clone(),
            kind: area.kind.clone(),
            width: area.width,
            height: area.height,
            level: area.level,
        }
    }

    pub(super) fn contains(&self, cell: AuthorityCell) -> bool {
        cell.x >= 0
            && cell.y >= 0
            && u32::try_from(cell.x).is_ok_and(|x| x < self.width)
            && u32::try_from(cell.y).is_ok_and(|y| y < self.height)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(super) struct PlayerDamageLedgerEntry {
    pub(super) source_actor_id: String,
    pub(super) cumulative_damage: u32,
    pub(super) first_damage_tick: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthorityWeatherShelterBox {
    pub min_x_milli: i32,
    pub min_y_milli: i32,
    pub max_x_milli: i32,
    pub max_y_milli: i32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthorityWeatherHazard {
    pub area_id: String,
    pub center_x_milli: i32,
    pub center_y_milli: i32,
    pub radius_milli: i32,
    pub dps_milli_health: i32,
    #[serde(default)]
    pub shelters: Vec<AuthorityWeatherShelterBox>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub(super) struct MoveIntentAuthorityState {
    pub(super) dx: i32,
    pub(super) dy: i32,
    pub(super) facing: Option<CardinalDirection>,
    pub(super) sprint: bool,
    pub(super) updated_tick: u64,
    pub(super) expires_tick: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(super) struct SkillBackupAuthorityState {
    pub(super) learned: BTreeSet<AuthorityProfessionKind>,
    pub(super) xp: BTreeMap<AuthorityProfessionKind, u64>,
    pub(super) track_xp: BTreeMap<String, u64>,
    pub(super) skill_boxes: BTreeSet<String>,
    pub(super) active_title_id: Option<String>,
    pub(super) skill_point_cap: u16,
    pub(super) saved_tick: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub(super) struct BankAccountAuthorityState {
    pub(super) bank_credits: u64,
    pub(super) skill_backup: Option<SkillBackupAuthorityState>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(super) struct PlayerCorpseState {
    pub(super) id: String,
    pub(super) owner_actor_id: String,
    pub(super) owner_label: String,
    pub(super) area_id: String,
    pub(super) cell: AuthorityCell,
    pub(super) position: AuthorityPosition,
    pub(super) created_tick: u64,
    pub(super) expiry_tick: u64,
    pub(super) credits: u64,
    pub(super) container: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(super) struct AuthorityTerminalState {
    pub(super) id: String,
    pub(super) kind: String,
    pub(super) area_id: String,
    pub(super) cell: AuthorityCell,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthorityBankSnapshot {
    pub actor_id: String,
    pub bank_credits: u64,
    pub items: Vec<InventoryStackSnapshot>,
    pub backup_present: bool,
    pub backup_saved_tick: Option<u64>,
    pub backup_skill_count: u32,
    pub backup_cost: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthorityBankDeltaPayload {
    pub schema: String,
    pub tick: u64,
    pub bank: Option<AuthorityBankSnapshot>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthorityPlayerCorpseSnapshot {
    pub id: String,
    pub owner_actor_id: String,
    pub owner_label: String,
    pub area_id: String,
    pub cell: AuthorityCell,
    pub position: AuthorityPosition,
    pub expiry_tick: u64,
    pub has_items: bool,
    pub credits_present: bool,
    pub credits_count: u64,
    pub is_owner: bool,
    pub container: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthorityPlayerCorpsesDeltaPayload {
    pub schema: String,
    pub tick: u64,
    pub corpses: Vec<AuthorityPlayerCorpseSnapshot>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(super) struct ActorAuthorityState {
    pub(super) id: String,
    pub(super) entity: String,
    pub(super) label: String,
    pub(super) display_name: String,
    /// established sandbox-style type read (lowercase-article, e.g. "a rogue drifter"). Empty for
    /// players (they name themselves). Derived from role/faction; see helpers.rs
    /// derive_actor_descriptor. Rendered as the nameplate/examine secondary line.
    pub(super) descriptor: String,
    pub(super) link_dead: bool,
    pub(super) link_dead_expires_tick: u64,
    pub(super) appearance: AuthorityActorAppearanceSnapshot,
    #[serde(default)]
    pub(super) worn: Vec<AuthorityActorWornPiece>,
    #[serde(default)]
    pub(super) equipped_clothing: Vec<AuthorityEquippedClothingInstance>,
    #[serde(default)]
    pub(super) worn_colors: BTreeMap<String, Vec<String>>,
    pub(super) sprite: String,
    pub(super) template_id: Option<String>,
    pub(super) spawn_zone_id: Option<String>,
    pub(super) role: String,
    pub(super) faction: ActorFactionState,
    pub(super) player_organization_id: Option<String>,
    pub(super) player_organization_tag: Option<String>,
    pub(super) area_id: String,
    pub(super) cell: AuthorityCell,
    pub(super) position: AuthorityPosition,
    pub(super) direction: String,
    pub(super) scale: u32,
    pub(super) home_area_id: String,
    pub(super) home_cell: AuthorityCell,
    pub(super) home_direction: String,
    pub(super) home_route: Vec<AuthorityCell>,
    pub(super) life_state: AuthorityLifeState,
    pub(super) lifecycle_seq: u64,
    pub(super) posture: AuthorityActorPosture,
    pub(super) posture_until_tick: u64,
    pub(super) vitals: AuthorityVitals,
    pub(super) max_vitals: AuthorityVitals,
    pub(super) effective_stats: ActorEffectiveStats,
    pub(super) professions: ActorProfessionState,
    pub(super) capabilities: ActorCapabilityState,
    pub(super) capability_grants: Vec<String>,
    pub(super) career_goal_id: Option<String>,
    pub(super) passive_regen_milli: AuthorityVitals,
    pub(super) weather_damage_accumulated_milli: i32,
    pub(super) bleed_stacks: Vec<BleedStackAuthorityState>,
    pub(super) consumable_effects: Vec<ConsumableEffectAuthorityState>,
    pub(super) service_buffs: Vec<ServiceBuffAuthorityState>,
    pub(super) personal_shield: Option<PersonalShieldAuthorityState>,
    pub(super) sprint_action_drain_milli: i32,
    #[serde(default)]
    pub(super) sprint_recovery_locked: bool,
    #[serde(default)]
    pub(super) sprint_recovery_regen_carry: i64,
    pub(super) sprint_regen_block_until_tick: u64,
    pub(super) mobility: ActorMobilityTelemetry,
    pub(super) downed_action_drain_milli: i32,
    pub(super) downed_spirit_drain_milli: i32,
    pub(super) incap_expires_tick: u64,
    pub(super) incap_count: u8,
    pub(super) incap_window_start_tick: u64,
    pub(super) incap_grace_until_tick: u64,
    pub(super) sleep: SleepAuthorityState,
    pub(super) suppression: SuppressionAuthorityState,
    pub(super) ai: Option<AuthorityAiState>,
    pub(super) next_fire_tick: u64,
    pub(super) weapon_recoil_heat_milli: i32,
    pub(super) weapon_recoil_last_tick: u64,
    pub(super) equipped_weapon_id: Option<AuthorityWeaponId>,
    pub(super) equipped_weapon_item_id: u32,
    #[serde(default)]
    pub(super) equipped_weapon_variant_id: u32,
    pub(super) slugthrower_magazine: WeaponMagazineState,
    pub(super) combat_queue: AbilityQueue,
    pub(super) combat_until_tick: u64,
    pub(super) engagement_target_id: Option<String>,
    pub(super) peace_requested: bool,
    pub(super) next_move_tick: u64,
    pub(super) move_intent: Option<MoveIntentAuthorityState>,
    pub(super) next_economy_action_tick: u64,
    pub(super) next_resource_survey_tick: u64,
    pub(super) pending_resource_sample: Option<PendingResourceSampleState>,
    #[serde(default)]
    pub(super) resource_sample_loop: Option<ResourceSampleLoopState>,
    pub(super) cranking_extractor_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) craft_session: Option<CraftSessionState>,
    #[serde(default)]
    pub(super) known_recipe_ids: BTreeSet<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) splice_session: Option<SpliceSessionState>,
    /// Genome handles this actor has scanned (design §3.3: reveal is permanent).
    #[serde(default)]
    pub(super) scanned_genomes: BTreeSet<u32>,
    #[serde(default)]
    pub(super) next_starter_tool_request_tick: u64,
    pub(super) shots_fired: u64,
    pub(super) last_shot_tick: Option<u64>,
    pub(super) last_moved_tick: Option<u64>,
    pub(super) stats: ActorAuthorityStats,
    pub(super) route: Vec<AuthorityCell>,
    pub(super) route_index: usize,
    pub(super) next_route_tick: u64,
    pub(super) player_damage_ledger: Vec<PlayerDamageLedgerEntry>,
    pub(super) loot_rights_actor_id: Option<String>,
    #[serde(default, skip_serializing_if = "BTreeSet::is_empty")]
    pub(super) gaia_harvest_entitled_actor_ids: BTreeSet<String>,
    #[serde(default, skip_serializing_if = "BTreeSet::is_empty")]
    pub(super) gaia_harvest_claimed_actor_ids: BTreeSet<String>,
    pub(super) body_vanish_tick: u64,
    pub(super) respawn_tick: u64,
    pub(super) corpse_exhausted_tick: Option<u64>,
    pub(super) creature_corpse_harvested_tick: Option<u64>,
    pub(super) clone_sickness_ticks: u64,
    pub(super) respawn_return: Vec<RespawnReturnStepAuthorityState>,
}

impl ActorAuthorityState {
    pub(super) fn incap_remaining_ticks(&self, tick: u64) -> u64 {
        if self.life_state == AuthorityLifeState::Downed && self.incap_expires_tick > tick {
            self.incap_expires_tick.saturating_sub(tick)
        } else {
            0
        }
    }

    pub(super) fn active_incap_count(&self, tick: u64, tick_rate_hz: u32) -> u8 {
        if self.incap_count == 0 {
            return 0;
        }
        let window_ends = self
            .incap_window_start_tick
            .saturating_add(incap_window_ticks(tick_rate_hz));
        if tick >= window_ends {
            0
        } else {
            self.incap_count
        }
    }

    pub(super) fn incap_window_remaining_ticks(&self, tick: u64, tick_rate_hz: u32) -> u64 {
        if self.incap_count == 0 {
            return 0;
        }
        self.incap_window_start_tick
            .saturating_add(incap_window_ticks(tick_rate_hz))
            .saturating_sub(tick)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub(super) struct ActorMobilityTelemetry {
    pub(super) sprint_moves: u64,
    pub(super) sprint_ticks: u64,
    pub(super) sprint_action_spent_milli: u64,
    pub(super) sprint_distance_milli: u64,
    pub(super) tactical_sprint_moves: u64,
    pub(super) tactical_sprint_ticks: u64,
    pub(super) tactical_sprint_action_spent_milli: u64,
    pub(super) tactical_sprint_distance_milli: u64,
    pub(super) last_sprint_tick: Option<u64>,
    pub(super) last_sprint_reason: Option<String>,
}

impl ActorMobilityTelemetry {
    pub(super) fn record_sprint(
        &mut self,
        tick: u64,
        duration_ticks: u16,
        distance_milli: i32,
        action_cost_milli: i32,
        tactical: bool,
        reason: &str,
    ) {
        let distance = u64::try_from(distance_milli.max(0)).unwrap_or(0);
        let ticks = u64::from(duration_ticks.max(1));
        let action_cost = u64::try_from(action_cost_milli.max(0)).unwrap_or(0);
        self.sprint_moves = self.sprint_moves.saturating_add(1);
        self.sprint_ticks = self.sprint_ticks.saturating_add(ticks);
        self.sprint_action_spent_milli = self.sprint_action_spent_milli.saturating_add(action_cost);
        self.sprint_distance_milli = self.sprint_distance_milli.saturating_add(distance);
        if tactical {
            self.tactical_sprint_moves = self.tactical_sprint_moves.saturating_add(1);
            self.tactical_sprint_ticks = self.tactical_sprint_ticks.saturating_add(ticks);
            self.tactical_sprint_action_spent_milli = self
                .tactical_sprint_action_spent_milli
                .saturating_add(action_cost);
            self.tactical_sprint_distance_milli =
                self.tactical_sprint_distance_milli.saturating_add(distance);
        }
        self.last_sprint_tick = Some(tick);
        self.last_sprint_reason = Some(reason.to_owned());
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(super) struct ActorAuthorityStats {
    pub(super) damage_done: u64,
    pub(super) damage_taken: u64,
    pub(super) kills: u64,
    pub(super) npc_kills: u64,
    pub(super) player_kills: u64,
    pub(super) deaths: u64,
    pub(super) shots_fired: u64,
    pub(super) hits_dealt: u64,
    pub(super) hits_taken: u64,
    pub(super) distance_moved_milli: u64,
    pub(super) last_damage_dealt_tick: Option<u64>,
    pub(super) last_damage_taken_tick: Option<u64>,
    pub(super) last_kill_tick: Option<u64>,
    pub(super) last_death: Option<ActorDeathStats>,
    pub(super) buckets: [ActorStatsBucket; ACTOR_STATS_BUCKET_COUNT],
}

impl Default for ActorAuthorityStats {
    fn default() -> Self {
        Self {
            damage_done: 0,
            damage_taken: 0,
            kills: 0,
            npc_kills: 0,
            player_kills: 0,
            deaths: 0,
            shots_fired: 0,
            hits_dealt: 0,
            hits_taken: 0,
            distance_moved_milli: 0,
            last_damage_dealt_tick: None,
            last_damage_taken_tick: None,
            last_kill_tick: None,
            last_death: None,
            buckets: [ActorStatsBucket::default(); ACTOR_STATS_BUCKET_COUNT],
        }
    }
}

impl ActorAuthorityStats {
    pub(super) fn record_distance(&mut self, tick: u64, tick_rate_hz: u32, distance_milli: i32) {
        let amount = u64::try_from(distance_milli.max(0)).unwrap_or(0);
        if amount == 0 {
            return;
        }
        self.distance_moved_milli = self.distance_moved_milli.saturating_add(amount);
        let bucket = self.bucket_mut(tick, tick_rate_hz);
        bucket.distance_moved_milli = bucket.distance_moved_milli.saturating_add(amount);
    }

    pub(super) fn record_shot(&mut self, tick: u64, tick_rate_hz: u32) {
        self.shots_fired = self.shots_fired.saturating_add(1);
        let bucket = self.bucket_mut(tick, tick_rate_hz);
        bucket.shots_fired = bucket.shots_fired.saturating_add(1);
    }

    pub(super) fn record_damage_dealt(&mut self, tick: u64, tick_rate_hz: u32, damage: i32) {
        let amount = u64::try_from(damage.max(0)).unwrap_or(0);
        if amount == 0 {
            return;
        }
        self.damage_done = self.damage_done.saturating_add(amount);
        self.last_damage_dealt_tick = Some(tick);
        let bucket = self.bucket_mut(tick, tick_rate_hz);
        bucket.damage_done = bucket.damage_done.saturating_add(amount);
    }

    pub(super) fn record_damage_taken(&mut self, tick: u64, tick_rate_hz: u32, damage: i32) {
        let amount = u64::try_from(damage.max(0)).unwrap_or(0);
        if amount == 0 {
            return;
        }
        self.damage_taken = self.damage_taken.saturating_add(amount);
        self.last_damage_taken_tick = Some(tick);
        let bucket = self.bucket_mut(tick, tick_rate_hz);
        bucket.damage_taken = bucket.damage_taken.saturating_add(amount);
    }

    pub(super) fn record_hit_dealt(&mut self, tick: u64, tick_rate_hz: u32) {
        self.hits_dealt = self.hits_dealt.saturating_add(1);
        let bucket = self.bucket_mut(tick, tick_rate_hz);
        bucket.hits_dealt = bucket.hits_dealt.saturating_add(1);
    }

    pub(super) fn record_hit_taken(&mut self, tick: u64, tick_rate_hz: u32) {
        self.hits_taken = self.hits_taken.saturating_add(1);
        let bucket = self.bucket_mut(tick, tick_rate_hz);
        bucket.hits_taken = bucket.hits_taken.saturating_add(1);
    }

    pub(super) fn record_kill(&mut self, tick: u64, tick_rate_hz: u32, target_player_like: bool) {
        self.kills = self.kills.saturating_add(1);
        if target_player_like {
            self.player_kills = self.player_kills.saturating_add(1);
        } else {
            self.npc_kills = self.npc_kills.saturating_add(1);
        }
        self.last_kill_tick = Some(tick);
        let bucket = self.bucket_mut(tick, tick_rate_hz);
        bucket.kills = bucket.kills.saturating_add(1);
        if target_player_like {
            bucket.player_kills = bucket.player_kills.saturating_add(1);
        } else {
            bucket.npc_kills = bucket.npc_kills.saturating_add(1);
        }
    }

    pub(super) fn record_death(&mut self, tick: u64, tick_rate_hz: u32, death: ActorDeathStats) {
        self.deaths = self.deaths.saturating_add(1);
        self.last_death = Some(death);
        let bucket = self.bucket_mut(tick, tick_rate_hz);
        bucket.deaths = bucket.deaths.saturating_add(1);
    }

    pub(super) fn bucket_mut(&mut self, tick: u64, tick_rate_hz: u32) -> &mut ActorStatsBucket {
        let bucket_ticks = actor_stats_bucket_ticks(tick_rate_hz);
        let bucket_start_tick = tick.checked_div(bucket_ticks).unwrap_or(0) * bucket_ticks;
        let index =
            usize::try_from((bucket_start_tick / bucket_ticks) % ACTOR_STATS_BUCKET_COUNT as u64)
                .expect("actor stats bucket index fits usize");
        let bucket = &mut self.buckets[index];
        if bucket.start_tick != bucket_start_tick {
            *bucket = ActorStatsBucket {
                start_tick: bucket_start_tick,
                ..ActorStatsBucket::default()
            };
        }
        bucket
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(super) struct ActorDeathStats {
    pub(super) tick: u64,
    pub(super) killer_actor_id: String,
    pub(super) cause: String,
    pub(super) weapon_id: AuthorityWeaponId,
    pub(super) ammo_type: AuthorityAmmoTypeId,
}

pub(super) fn personal_shield_hit_points_from_charge(charge_milli: u32) -> u16 {
    let hit_points = charge_milli.saturating_add(PERSONAL_SHIELD_HIT_POINT_MILLI.saturating_sub(1))
        / PERSONAL_SHIELD_HIT_POINT_MILLI;
    u16::try_from(hit_points.min(PERSONAL_SHIELD_MAX_HIT_POINTS)).unwrap_or(u16::MAX)
}

pub(super) fn personal_shield_durability_charges_from_milli(durability_milli: u32) -> u16 {
    if durability_milli == 0 {
        return 0;
    }
    let charges = durability_milli
        .saturating_add(PERSONAL_SHIELD_MAX_CHARGE_MILLI.saturating_sub(1))
        / PERSONAL_SHIELD_MAX_CHARGE_MILLI.max(1);
    u16::try_from(charges.min(u32::from(PERSONAL_SHIELD_MAX_DURABILITY_CHARGES)))
        .unwrap_or(u16::MAX)
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub(super) struct ActorStatsBucket {
    pub(super) start_tick: u64,
    pub(super) damage_done: u64,
    pub(super) damage_taken: u64,
    pub(super) kills: u64,
    pub(super) npc_kills: u64,
    pub(super) player_kills: u64,
    pub(super) deaths: u64,
    pub(super) shots_fired: u64,
    pub(super) hits_dealt: u64,
    pub(super) hits_taken: u64,
    pub(super) distance_moved_milli: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(super) struct ConsumableEffectAuthorityState {
    pub(super) item_id: String,
    pub(super) effect_id: String,
    pub(super) remaining_ticks: u16,
    pub(super) total_ticks: u16,
    pub(super) heal_remaining_milli: i32,
    pub(super) accumulated_heal_milli: i32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(super) struct ServiceBuffAuthorityState {
    pub(super) effect_id: String,
    pub(super) remaining_ticks: u64,
    /// MEDIC WAVE: ticks at grant — anti-state defense buff (~30 min) differs from
    /// the 3 h service default, so per-buff total is needed for honest HUD progress.
    pub(super) total_ticks: u64,
    pub(super) body_delta: i32,
    pub(super) spirit_delta: i32,
    /// MEDIC WAVE: the ONE unified defense_vs_state permille this buff contributes
    /// (0 for the classic body/spirit service buffs).
    pub(super) defense_vs_state_milli: i32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(super) struct PersonalShieldAuthorityState {
    pub(super) charge_milli: u32,
    pub(super) durability_milli: u32,
    pub(super) durability_charges: u16,
    pub(super) last_damage_tick: u64,
    pub(super) last_block_tick: u64,
}

impl PersonalShieldAuthorityState {
    pub(super) fn fresh(tick: u64) -> Self {
        Self {
            charge_milli: PERSONAL_SHIELD_MAX_CHARGE_MILLI,
            durability_milli: PERSONAL_SHIELD_MAX_DURABILITY_MILLI,
            durability_charges: PERSONAL_SHIELD_MAX_DURABILITY_CHARGES,
            last_damage_tick: tick,
            last_block_tick: 0,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[allow(dead_code)]
pub(super) enum RespawnReturnStepAuthorityState {
    Walk {
        area_id: String,
        cell: AuthorityCell,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(super) struct BleedStackAuthorityState {
    pub(super) damage_milli_per_tick: i32,
    pub(super) accumulated_damage_milli: i32,
    pub(super) source_actor_id: String,
    pub(super) remaining_ticks: u16,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub(super) struct SleepAuthorityState {
    pub(super) stacks: u8,
    pub(super) remaining_ticks: u16,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub(super) struct SuppressionAuthorityState {
    pub(super) pressure_milli: i32,
    pub(super) source: Option<AuthorityPosition>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub(super) enum CoverSide {
    North,
    South,
    East,
    West,
}

impl CoverSide {
    pub(super) const fn code(self) -> u32 {
        match self {
            CoverSide::North => 1,
            CoverSide::South => 2,
            CoverSide::East => 3,
            CoverSide::West => 4,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(super) struct FineCollisionBoundsAuthorityState {
    pub(super) prop_id: String,
    pub(super) area_id: String,
    pub(super) left: i32,
    pub(super) right: i32,
    pub(super) top: i32,
    pub(super) bottom: i32,
}

impl FineCollisionBoundsAuthorityState {
    pub(super) const fn hit_box(&self) -> AuthorityActorHitBox {
        AuthorityActorHitBox {
            left: self.left,
            right: self.right,
            top: self.top,
            bottom: self.bottom,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(super) struct DoorCollisionBoundsAuthorityState {
    pub(super) prop_id: String,
    pub(super) area_id: String,
    pub(super) left: i32,
    pub(super) right: i32,
    pub(super) top: i32,
    pub(super) bottom: i32,
    pub(super) open: bool,
}

impl DoorCollisionBoundsAuthorityState {
    pub(super) const fn hit_box(&self) -> AuthorityActorHitBox {
        AuthorityActorHitBox {
            left: self.left,
            right: self.right,
            top: self.top,
            bottom: self.bottom,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(super) struct CoverPointAuthorityState {
    pub(super) prop_id: String,
    pub(super) area_id: String,
    pub(super) position: AuthorityPosition,
    pub(super) cell: AuthorityCell,
    pub(super) side: CoverSide,
    pub(super) rating_milli: i32,
    pub(super) high: bool,
    pub(super) prop_left: i32,
    pub(super) prop_right: i32,
    pub(super) prop_top: i32,
    pub(super) prop_bottom: i32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(super) struct ExchangeContainerAuthorityState {
    pub(super) prop_id: String,
    pub(super) area_id: String,
    pub(super) position: AuthorityPosition,
    pub(super) cell: AuthorityCell,
    pub(super) left_milli: i32,
    pub(super) right_milli: i32,
    pub(super) top_milli: i32,
    pub(super) bottom_milli: i32,
    pub(super) interaction_radius_milli: i32,
    pub(super) owner_actor_id: Option<String>,
    pub(super) allowed_actor_ids: BTreeSet<String>,
    pub(super) allowed_faction_ids: BTreeSet<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(super) struct LootCacheAuthorityState {
    pub(super) prop_id: String,
    pub(super) area_id: String,
    pub(super) position: AuthorityPosition,
    pub(super) cell: AuthorityCell,
    pub(super) container: String,
    pub(super) interaction_radius_milli: i32,
    pub(super) emptied: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(super) struct AmmoStockpileAuthorityState {
    pub(super) prop_id: String,
    pub(super) area_id: String,
    pub(super) position: AuthorityPosition,
    pub(super) cell: AuthorityCell,
    pub(super) container: String,
    pub(super) faction_id: Option<String>,
    pub(super) item_id: u32,
    pub(super) quantity: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(super) enum AuthorityAiState {
    PassiveCreature(PassiveCreatureAiState),
    Skirmisher(SkirmisherAiState),
}

pub(super) type SkirmisherAiState = CombatSkirmisherAiState<AuthorityPosition>;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub(super) enum PassiveCreatureMode {
    Idle,
    Roam,
    Flee,
    Engage,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(super) struct PassiveCreatureAiState {
    pub(super) mode: PassiveCreatureMode,
    pub(super) target: Option<AuthorityPosition>,
    pub(super) threat: Option<AuthorityPosition>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) threat_actor_id: Option<String>,
    pub(super) panic_until_tick: u64,
    #[serde(default)]
    pub(super) chase_until_tick: u64,
    #[serde(default)]
    pub(super) next_attack_tick: u64,
    pub(super) next_decision_tick: u64,
    pub(super) next_update_tick: u64,
    pub(super) last_update_tick: u64,
    pub(super) seed: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub(super) enum SkirmisherVariant {
    Trooper,
    Assault,
    Anchor,
    Flanker,
    Deadeye,
    Brawler,
}

impl SkirmisherVariant {
    pub(super) const fn label(self) -> &'static str {
        match self {
            Self::Trooper => "trooper",
            Self::Assault => "assault",
            Self::Anchor => "anchor",
            Self::Flanker => "flanker",
            Self::Deadeye => "deadeye",
            Self::Brawler => "brawler",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub(super) struct SkirmisherProfile {
    pub(super) variant: SkirmisherVariant,
    pub(super) speed_milli_cells_per_second: i32,
    pub(super) min_range_milli: i32,
    pub(super) preferred_range_milli: i32,
    pub(super) max_range_milli: i32,
    pub(super) cover_search_radius_milli: i32,
    pub(super) cover_pressure_milli: i32,
    pub(super) low_action_cover_percent: i32,
    pub(super) shot_cooldown_min_ticks: u64,
    pub(super) shot_cooldown_max_ticks: u64,
    pub(super) burst_min_shots: u8,
    pub(super) burst_max_shots: u8,
    pub(super) lateral_move_chance_milli: i32,
    pub(super) hold_cover_between_shots: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub(super) enum SkirmisherConfidence {
    Panicked,
    Worried,
    Neutral,
    Confident,
    Heroic,
}

impl SkirmisherConfidence {
    pub(super) const fn label(self) -> &'static str {
        match self {
            Self::Panicked => "panicked",
            Self::Worried => "worried",
            Self::Neutral => "neutral",
            Self::Confident => "confident",
            Self::Heroic => "heroic",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub(super) enum SkirmisherSquadOrder {
    Retreat,
    Defend,
    Advance,
}

impl SkirmisherSquadOrder {
    pub(super) const fn label(self) -> &'static str {
        match self {
            Self::Retreat => "retreat",
            Self::Defend => "defend",
            Self::Advance => "advance",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct SkirmisherLaneAssignment {
    pub(super) lane_index: usize,
    pub(super) lane_count: usize,
    pub(super) center_offset_milli: i32,
    pub(super) min_offset_milli: i32,
    pub(super) max_offset_milli: i32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct SkirmisherSquadTactics {
    pub(super) squad_id: String,
    pub(super) area_id: String,
    pub(super) faction: String,
    pub(super) members: Vec<String>,
    pub(super) enemy_count: usize,
    pub(super) center: AuthorityPosition,
    pub(super) enemy_center: Option<AuthorityPosition>,
    pub(super) direction_x_milli: i32,
    pub(super) direction_y_milli: i32,
    pub(super) lateral_x_milli: i32,
    pub(super) lateral_y_milli: i32,
    pub(super) front_width_milli: i32,
    pub(super) no_mans_land: Option<AuthorityPosition>,
    pub(super) confidence: SkirmisherConfidence,
    pub(super) order: SkirmisherSquadOrder,
    pub(super) strength_milli: i32,
    pub(super) enemy_strength_milli: i32,
    pub(super) lanes: BTreeMap<String, SkirmisherLaneAssignment>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct SkirmisherActorTacticalContext {
    pub(super) squad: SkirmisherSquadTactics,
    pub(super) lane: Option<SkirmisherLaneAssignment>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct SkirmisherTacticalState {
    pub(super) by_actor: BTreeMap<String, SkirmisherActorTacticalContext>,
    pub(super) reservations: SkirmisherReservations,
    pub(super) squads_debug: Vec<AuthorityAiSquadDebugSnapshot>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(super) struct SkirmisherReservations {
    pub(super) claims: Vec<SkirmisherPositionClaim>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct SkirmisherPositionClaim {
    pub(super) actor_id: String,
    pub(super) area_id: String,
    pub(super) position: AuthorityPosition,
}

pub(super) fn tactical_position_claim(
    claim: &SkirmisherPositionClaim,
) -> TacticalPositionClaim<'_, AuthorityPosition> {
    TacticalPositionClaim {
        actor_id: claim.actor_id.as_str(),
        area_id: claim.area_id.as_str(),
        position: claim.position,
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct SkirmisherTacticalChoice {
    pub(super) position: AuthorityPosition,
    pub(super) reason: &'static str,
    pub(super) candidates: Vec<AuthorityAiTacticalCandidateDebug>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum SkirmisherTacticalStage {
    GoodCover,
    SoftCover,
    Evasion,
    FiringLane,
    AdvanceLine,
    Flank,
    Retreat,
}

impl SkirmisherTacticalStage {
    pub(super) const fn label(self) -> &'static str {
        match self {
            Self::GoodCover => "good_cover",
            Self::SoftCover => "soft_cover",
            Self::Evasion => "evasion",
            Self::FiringLane => "firing_lane",
            Self::AdvanceLine => "advance_line",
            Self::Flank => "flank",
            Self::Retreat => "retreat",
        }
    }
}

impl From<TacticalStageKind> for SkirmisherTacticalStage {
    fn from(kind: TacticalStageKind) -> Self {
        match kind {
            TacticalStageKind::GoodCover => Self::GoodCover,
            TacticalStageKind::SoftCover => Self::SoftCover,
            TacticalStageKind::Evasion => Self::Evasion,
            TacticalStageKind::FiringLane => Self::FiringLane,
            TacticalStageKind::AdvanceLine => Self::AdvanceLine,
            TacticalStageKind::Flank => Self::Flank,
            TacticalStageKind::Retreat => Self::Retreat,
        }
    }
}

pub(super) const fn tactical_stage_kind(stage: SkirmisherTacticalStage) -> TacticalStageKind {
    match stage {
        SkirmisherTacticalStage::GoodCover => TacticalStageKind::GoodCover,
        SkirmisherTacticalStage::SoftCover => TacticalStageKind::SoftCover,
        SkirmisherTacticalStage::Evasion => TacticalStageKind::Evasion,
        SkirmisherTacticalStage::FiringLane => TacticalStageKind::FiringLane,
        SkirmisherTacticalStage::AdvanceLine => TacticalStageKind::AdvanceLine,
        SkirmisherTacticalStage::Flank => TacticalStageKind::Flank,
        SkirmisherTacticalStage::Retreat => TacticalStageKind::Retreat,
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(super) struct TransitionAuthorityState {
    pub(super) id: String,
    pub(super) from_area_id: String,
    pub(super) from_cell: AuthorityCell,
    pub(super) trigger_size: CellSizeSnapshot,
    pub(super) to_area_id: String,
    pub(super) to_cell: AuthorityCell,
    pub(super) to_facing: String,
}

impl TransitionAuthorityState {
    pub(super) fn from_snapshot(
        transition: &AreaTransitionSnapshot,
    ) -> Result<Self, SliceAuthorityBuildError> {
        Ok(Self {
            id: transition.id.clone(),
            from_area_id: transition.from_area_id.clone(),
            from_cell: AuthorityCell::from_snapshot(&transition.from_cell, "transition.fromCell")?,
            trigger_size: transition.trigger_size,
            to_area_id: transition.to_area_id.clone(),
            to_cell: AuthorityCell::from_snapshot(&transition.to_cell, "transition.toCell")?,
            to_facing: transition.to_facing.clone(),
        })
    }

    pub(super) fn contains_trigger(&self, position: AuthorityPosition) -> bool {
        let width = i32::try_from(self.trigger_size.w).unwrap_or(i32::MAX);
        let height = i32::try_from(self.trigger_size.h).unwrap_or(i32::MAX);
        let center_x = position.x.saturating_add(MILLI_CELLS_PER_CELL / 2);
        let center_y = position.y.saturating_add(MILLI_CELLS_PER_CELL / 2);
        center_x >= self.from_cell.x.saturating_mul(MILLI_CELLS_PER_CELL)
            && center_y >= self.from_cell.y.saturating_mul(MILLI_CELLS_PER_CELL)
            && center_x
                < self
                    .from_cell
                    .x
                    .saturating_add(width)
                    .saturating_mul(MILLI_CELLS_PER_CELL)
            && center_y
                < self
                    .from_cell
                    .y
                    .saturating_add(height)
                    .saturating_mul(MILLI_CELLS_PER_CELL)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(super) struct CloneFacilityAuthorityState {
    pub(super) id: String,
    pub(super) area_id: String,
    pub(super) respawn_cell: AuthorityCell,
    pub(super) respawn_facing: String,
    pub(super) sickness_duration_ticks: u64,
}

impl CloneFacilityAuthorityState {
    pub(super) fn from_snapshot(
        facility: &CloneFacilitySnapshot,
        respawn_cell: AuthorityCell,
        tick_rate_hz: u32,
    ) -> Self {
        Self {
            id: facility.id.clone(),
            area_id: facility.area_id.clone(),
            respawn_cell,
            respawn_facing: facility.respawn_facing.clone(),
            sickness_duration_ticks: ms_to_ticks_round(facility.sickness_duration_ms, tick_rate_hz),
        }
    }
}
