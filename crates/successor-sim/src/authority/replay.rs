//! Command replay and live-frame protocol types.

use super::*;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthorityReplay {
    pub schema: String,
    pub initial_state_hash: String,
    pub final_state_hash: String,
    pub replay_hash: String,
    pub metrics: SliceAuthorityMetrics,
    pub frames: Vec<AuthorityCommandFrame>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthorityCommandFrame {
    pub command_id: u64,
    pub status: AuthorityCommandStatus,
    pub reason_code: Option<String>,
    pub tick: u64,
    pub command_hash: String,
    pub previous_state_hash: String,
    pub target_state_hash: String,
    pub bundle_hash: String,
    pub frame_hash: String,
    #[serde(skip_serializing)]
    pub bundle: SnapshotDeltaBundle,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub craft_session: Option<AuthorityCraftSessionSnapshot>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub splice_session: Option<AuthoritySpliceSessionSnapshot>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub genome_scan: Option<AuthorityGenomeScanSnapshot>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub harvest: Option<AuthorityHarvestSnapshot>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub factory_receipt: Option<AuthorityFactoryManufactureSnapshot>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parcel_claim: Option<AuthorityParcelClaimSnapshot>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub trade_session_deliveries: Vec<AuthorityTradeSessionDelivery>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub dialogue_deliveries: Vec<AuthorityDialogueDelivery>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub duel_outcomes: Vec<AuthorityDuelOutcomeSnapshot>,
    #[serde(skip_serializing)]
    pub frame: ServerTickDeliveryFrame,
    pub actor: Option<AuthorityActorSnapshot>,
    pub combat_events: Vec<AuthorityCombatEventSnapshot>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub ability_queue_events: Vec<AuthorityAbilityQueueEventSnapshot>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub survey_result: Option<AuthoritySurveyResultSnapshot>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct AuthorityLiveCommandFrame {
    pub command_id: u64,
    pub craft_session: Option<AuthorityCraftSessionSnapshot>,
    pub splice_session: Option<AuthoritySpliceSessionSnapshot>,
    pub genome_scan: Option<AuthorityGenomeScanSnapshot>,
    pub harvest: Option<AuthorityHarvestSnapshot>,
    pub factory_receipt: Option<AuthorityFactoryManufactureSnapshot>,
    pub parcel_claim: Option<AuthorityParcelClaimSnapshot>,
    pub trade_session_deliveries: Vec<AuthorityTradeSessionDelivery>,
    pub dialogue_deliveries: Vec<AuthorityDialogueDelivery>,
    pub duel_outcomes: Vec<AuthorityDuelOutcomeSnapshot>,
    pub status: AuthorityCommandStatus,
    pub reason_code: Option<String>,
    pub tick: u64,
    pub actor: Option<AuthorityActorSnapshot>,
    pub combat_events: Vec<AuthorityCombatEventSnapshot>,
    pub ability_queue_events: Vec<AuthorityAbilityQueueEventSnapshot>,
    pub survey_result: Option<AuthoritySurveyResultSnapshot>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AuthorityCommandStatus {
    Accepted,
    Rejected,
}
