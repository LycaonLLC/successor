//! Authority delta payloads and combat event projections.

use super::*;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct AuthorityDeltaPayload {
    pub(super) schema: String,
    pub(super) tick: u64,
    pub(super) state_hash: String,
    pub(super) actors: Vec<AuthorityActorSnapshot>,
}

impl AuthorityDeltaPayload {
    pub(super) fn from_state_for_observer(
        state: &SliceAuthorityState,
        config: &SliceAuthorityConfig,
    ) -> Self {
        Self {
            schema: "successor.authority-delta.v1".to_owned(),
            tick: state.runtime.durable.tick,
            state_hash: state.stable_state_hash_hex(),
            actors: state.actor_snapshots_for(config),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthorityCombatEventSnapshot {
    pub id: u64,
    pub command_id: Option<u64>,
    pub tick: u64,
    pub shooter_actor_id: String,
    pub target_actor_id: String,
    pub origin_x: Option<f64>,
    pub origin_y: Option<f64>,
    pub hit_x: f64,
    pub hit_y: f64,
    pub damage: i32,
    pub previous_life_state: AuthorityLifeState,
    pub life_state: AuthorityLifeState,
    pub target_lifecycle_seq: u64,
    pub bleed_stack_count: u8,
    pub lifecycle: AuthorityCombatLifecycleKind,
    pub zone: String,
    pub weapon_id: AuthorityWeaponId,
    pub ammo_type: AuthorityAmmoTypeId,
    pub effect: Option<AuthorityCombatEffectSnapshot>,
    pub lifecycle_cause: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attacker_actor_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub action_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hit: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pool: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub roll_milli: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub to_hit_milli: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub block_roll_milli: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub block_chance_milli: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthorityCombatEffectSnapshot {
    pub kind: String,
    pub stacks: u8,
    pub threshold: u8,
    pub remaining_ticks: u16,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct AuthorityCombatEventDeltaPayload {
    pub(super) schema: String,
    pub(super) tick: u64,
    pub(super) events: Vec<AuthorityCombatEventSnapshot>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct AuthorityInventoryDeltaPayload {
    pub(super) schema: String,
    pub(super) tick: u64,
    pub(super) inventory: Vec<InventoryStackSnapshot>,
    pub(super) reservations: Vec<ReservationSnapshot>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct AuthorityNpcJobsDeltaPayload {
    pub(super) schema: String,
    pub(super) tick: u64,
    pub(super) npc_jobs: Vec<NpcJobSnapshot>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct AuthorityTimelineEventsDeltaPayload {
    pub(super) schema: String,
    pub(super) tick: u64,
    pub(super) events: Vec<TimelineEventSnapshot>,
}

/// One authoritative hostile-NPC bark delivered to nearby observers. The
/// server applies AOI/privacy filtering; clients only enqueue the bubble.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthorityDialogueDelivery {
    pub actor_id: String,
    pub speaker: String,
    pub body: String,
    pub area_id: String,
    pub x: i32,
    pub y: i32,
    pub tick: u64,
}
