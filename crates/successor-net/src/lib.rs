//! Snapshot delta bundles and command receipts.
//!
//! This is the useful slice of Strata's net artifact shape: named payload sections, explicit
//! baseline/target ticks, server tick delivery frames, accepted command receipts, and rejected
//! command receipts. Transport and rollback protocol can stay out until Successor has a
//! real multiplayer loop.

#![forbid(unsafe_code)]

use serde::{Deserialize, Serialize};
use successor_core::{StateWriter, TickIndex};

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub struct SessionId(pub u64);

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub struct PlayerId(pub u32);

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub struct PayloadSchemaId(pub u32);

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub enum CardinalDirection {
    Front,
    Right,
    Back,
    Left,
}

impl CardinalDirection {
    const fn code(self) -> u32 {
        match self {
            Self::Front => 1,
            Self::Right => 2,
            Self::Back => 3,
            Self::Left => 4,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub enum AuthorityWeaponId {
    Slugthrower,
    Vibrosword,
    // Synty curated ranged set (2026-07-08). Models are cosmetic (client render
    // registry); the CLASS carries intrinsic ranged stats. Cert/tier gating is
    // the skill-box requirement keyed by inventory item id (CombatDoctrine).
    WpnPistol,
    WpnSmg,
    WpnCarbine,
    /// Optimized electricity carbine promoted from the Storm receiver family.
    LightningCarbine,
    WpnAssault,
    WpnShotgun,
    WpnSniper,
    WpnHeavy,
    WpnLauncher,
    /// Primitive, uncertified Brawler starter blade.
    ScraplineMachete,
    /// Long, plain militia blade; uncertified primitive starter option.
    FieldSaber,
    /// Forward-weighted stone-yard blade; uncertified primitive starter option.
    QuarryChopper,
    /// Universal no-item fallback for the basic combat verb.
    Unarmed,
}

impl AuthorityWeaponId {
    pub const fn code(self) -> u32 {
        match self {
            Self::Slugthrower => 1,
            Self::Vibrosword => 4,
            Self::WpnPistol => 5,
            Self::WpnSmg => 6,
            Self::WpnCarbine => 7,
            Self::LightningCarbine => 17,
            Self::WpnAssault => 8,
            Self::WpnShotgun => 9,
            Self::WpnSniper => 10,
            Self::WpnHeavy => 11,
            Self::WpnLauncher => 12,
            Self::ScraplineMachete => 13,
            Self::FieldSaber => 15,
            Self::QuarryChopper => 16,
            Self::Unarmed => 14,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub enum AuthorityAmmoTypeId {
    SlugIron,
    SlugShard,
    SlugSpike,
    Melee,
}

impl AuthorityAmmoTypeId {
    pub const fn code(self) -> u32 {
        match self {
            Self::SlugIron => 1,
            Self::SlugShard => 2,
            Self::SlugSpike => 3,
            Self::Melee => 5,
        }
    }
}

/// One line of a trade offer/request: a quantity of a specific item stack.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TradeItemSpec {
    pub item_id: u32,
    #[serde(default)]
    pub variant_id: u32,
    pub quantity: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum CommanderPawnOrder {
    MoveTo { area_id: String, x: i32, y: i32 },
    Hold { duration_ticks: u16 },
    ClearOrders,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PawnWorkPrioritySpec {
    pub work_id: String,
    pub priority: u8,
    #[serde(default = "default_enabled")]
    pub enabled: bool,
}

fn default_enabled() -> bool {
    true
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct BuildPalette {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub primary: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub secondary: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub accent: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum ClientCommand {
    Move {
        dx: i32,
        dy: i32,
        duration_ticks: u16,
        #[serde(default)]
        facing: Option<CardinalDirection>,
        #[serde(default)]
        sprint: bool,
    },
    SetMoveIntent {
        dx: i32,
        dy: i32,
        #[serde(default)]
        facing: Option<CardinalDirection>,
        #[serde(default)]
        sprint: bool,
    },
    QueueCombatAction {
        action_id: String,
        target_actor_id: String,
    },
    Peace {},
    CancelAbilityQueue {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        queue_entry_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        scope: Option<String>,
    },
    ReloadWeapon {
        weapon_id: Option<AuthorityWeaponId>,
        ammo_type: Option<AuthorityAmmoTypeId>,
    },
    SetEquippedWeapon {
        #[serde(default)]
        weapon_id: Option<AuthorityWeaponId>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        weapon_item_id: Option<u32>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        weapon_variant_id: Option<u32>,
    },
    SetEquippedClothing {
        item_id: u32,
        equipped: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        container: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        stack_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        variant_id: Option<u32>,
    },
    EnterTransition {
        transition_id: String,
    },
    UseConsumable {
        item_id: String,
        #[serde(default)]
        item_numeric_id: Option<u32>,
        #[serde(default)]
        variant_id: Option<u32>,
    },
    RefillAmmo {
        item_id: String,
    },
    ApplyServiceBuff {
        effect_id: String,
    },
    CloneRespawn {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        facility_id: Option<String>,
    },
    ReviveActor {
        target_actor_id: String,
    },
    BankStoreItem {
        source_stack_id: String,
        quantity: u32,
    },
    BankRetrieveItem {
        bank_stack_id: String,
        quantity: u32,
    },
    BankDepositCredits {
        amount: u64,
    },
    BankWithdrawCredits {
        amount: u64,
    },
    CloneSaveSkillBackup {},
    CorpseTakeCredits {
        corpse_id: String,
    },
    SetPosture {
        posture: String,
    },
    SampleResource {
        family: String,
        #[serde(default)]
        stop: bool,
    },
    SurveyResource {
        family: String,
    },
    PlaceExtractor {
        family: String,
    },
    CrankExtractor {
        extractor_id: String,
    },
    StopCrank {},
    InsertBattery {
        extractor_id: String,
        container: String,
        stack_id: String,
        variant_id: u32,
    },
    CollectExtractor {
        extractor_id: String,
    },
    DestroyExtractor {
        extractor_id: String,
    },
    PlaceCamp {},
    PackUpCamp {},
    DiscardStack {
        container: String,
        stack_id: String,
        item_id: u32,
        variant_id: u32,
    },
    SplitStack {
        container: String,
        stack_id: String,
        item_id: u32,
        variant_id: u32,
        quantity: u32,
    },
    MergeStacks {
        container: String,
        source_stack_id: String,
        target_stack_id: String,
    },
    /// Redeem a Credit Chip stack into the scalar credit balance. `stack_id`
    /// identifies the exact chip in the player-owned `container`; its quantity is
    /// the face value banked on accept.
    RedeemCreditChip {
        container: String,
        stack_id: String,
    },
    HarvestCorpse {
        target_actor_id: String,
    },
    TakeLootItem {
        container: String,
        #[serde(rename = "itemId")]
        item_id: u32,
        #[serde(rename = "variantId")]
        variant_id: u32,
        quantity: i32,
    },
    /// Coordinator-owned travel ticket purchase. Execution remains in the
    /// TypeScript shard coordinator; the Rust client only submits the command.
    PurchaseTravelTicket {
        terminal_prop_id: String,
        to_planet_id: String,
        to_city_id: String,
    },
    /// Consume a coordinator-issued travel ticket.
    UseTravelTicket {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        container: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        stack_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        ticket_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        item_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        item_numeric_id: Option<u32>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        variant_id: Option<u32>,
    },
    /// Coordinator-owned door toggle.
    ToggleDoor {
        prop_id: String,
    },
    CraftItem {
        schematic_id: String,
        experiment_power: u8,
        experiment_handling: u8,
        experiment_reliability: u8,
    },
    CraftBegin {
        recipe_id: String,
    },
    CraftAssignSlot {
        slot_index: u8,
        container: String,
        stack_id: String,
        variant_id: u32,
    },
    CraftClearSlot {
        slot_index: u8,
    },
    CraftAssemble {},
    CraftExperiment {
        line_id: u8,
        points: u8,
    },
    CraftFinalizePrototype {
        custom_name: String,
    },
    CraftFinalizePractice {},
    CraftDraftSchematic {
        max_uses: u16,
    },
    FactoryManufacture {
        factory_id: String,
        schematic_id: String,
    },
    CraftCancel {},
    RequestStarterTool {
        trainer_actor_id: String,
    },
    PurchaseSkillBox {
        skill_box_id: String,
        trainer_actor_id: String,
    },
    UnlearnSkillBox {
        skill_box_id: String,
        trainer_actor_id: String,
    },
    SetProfessionTitle {
        #[serde(default)]
        title_id: Option<String>,
    },
    SetCareerGoal {
        goal_id: String,
        trainer_actor_id: String,
    },
    StoreToExchange {
        item_id: u32,
        variant_id: u32,
        quantity: u32,
    },
    RetrieveFromExchange {
        item_id: u32,
        variant_id: u32,
        quantity: u32,
    },
    ProposeTrade {
        partner_actor_id: String,
        offer: Vec<TradeItemSpec>,
        request: Vec<TradeItemSpec>,
    },
    AcceptTrade {
        proposal_id: u32,
    },
    DeclineTrade {
        proposal_id: u32,
    },
    /// Add one item line to the sender's own side of an open trade session.
    /// Mutating an offer clears BOTH sides' accept-locks (anti-abuse).
    AddTradeItem {
        proposal_id: u32,
        item: TradeItemSpec,
    },
    /// Remove a quantity of one item line from the sender's own side of an
    /// open trade session. Clears BOTH sides' accept-locks.
    RemoveTradeItem {
        proposal_id: u32,
        item: TradeItemSpec,
    },
    /// Set the sender's own wallet-credit offer on an open trade session. Clears
    /// BOTH sides' accept-locks.
    SetTradeCoin {
        proposal_id: u32,
        amount: u64,
    },
    /// Final OK on a fully-locked trade session. When both sides confirm the
    /// existing atomic all-or-nothing swap executes with re-validation.
    ConfirmTrade {
        proposal_id: u32,
    },
    DebugGiveItem {
        item_id: u32,
        #[serde(default)]
        variant_id: u32,
        #[serde(default = "default_debug_give_quantity")]
        quantity: u32,
        #[serde(default)]
        equip: bool,
    },
    DebugGrantSkillBoxes {
        skill_box_ids: Vec<String>,
    },
    GroupInvite {
        target_actor_id: String,
    },
    GroupAccept {},
    GroupDecline {},
    GroupLeave {},
    GroupDisband {},
    GroupKick {
        target_actor_id: String,
    },
    /// Challenge a specific player to a consensual 1v1 duel. Carries the target
    /// actor id — the TS shard MUST map it across the claimed-placeholder
    /// boundary (`rustActorIdFor`) before this reaches the Rust authority.
    DuelChallenge {
        target_actor_id: String,
    },
    /// Accept the pending duel challenge addressed to the issuer.
    DuelAccept {},
    /// Decline (and clear) the pending duel challenge addressed to the issuer.
    DuelDecline {},
    /// Yield the issuer's active duel — the yielder concedes and lives.
    DuelYield {},
    /// Explicitly kill the currently downed opponent in the issuer's active duel.
    Deathblow {
        target_actor_id: String,
    },
    // Bio-Engineer (bioengineer-design.md §3.8): acquire / analyze / splice family.
    // Wire tags 80-89 (Main tag-block arbitration 2026-07-08).
    GeneSample {
        species: String,
    },
    ScanGenome {
        container: String,
        stack_id: String,
        variant_id: u32,
    },
    SpliceBegin {
        species: String,
    },
    SpliceAssignSlot {
        slot_index: u8,
        container: String,
        stack_id: String,
        variant_id: u32,
    },
    SpliceClearSlot {
        slot_index: u8,
    },
    SpliceChooseAllele {
        locus: u8,
        from_parent: u8,
        allele: u8,
    },
    SpliceAssemble {},
    SpliceExperimentLocus {
        locus: u8,
        points: u8,
    },
    SpliceMint {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        cultivar_name: Option<String>,
    },
    SpliceCancel {},
    // ── Farming / land (agriculture-design.md §B; wire tags 69-79) ──
    ClaimParcel {
        planet_id: String,
        area_id: String,
        x: i32,
        y: i32,
        tier: String,
    },
    AbandonParcel {
        parcel_id: String,
    },
    RenameParcel {
        parcel_id: String,
        name: String,
    },
    PayUpkeep {
        parcel_id: String,
    },
    TillTile {
        parcel_id: String,
        cell_x: i32,
        cell_y: i32,
    },
    PlantSeed {
        parcel_id: String,
        cell_x: i32,
        cell_y: i32,
        container: String,
        stack_id: String,
        variant_id: u32,
    },
    ClearTile {
        parcel_id: String,
        cell_x: i32,
        cell_y: i32,
    },
    WaterTile {
        parcel_id: String,
        cell_x: i32,
        cell_y: i32,
    },
    TendPlot {
        parcel_id: String,
        #[serde(default)]
        stop: bool,
    },
    PlaceFarmStructure {
        parcel_id: String,
        structure_item_id: u32,
        cell_x: i32,
        cell_y: i32,
    },
    RemoveFarmStructure {
        parcel_id: String,
        structure_id: String,
    },
    BuildPlace {
        catalog_id: String,
        parcel_id: String,
        cell_x: i32,
        cell_y: i32,
        rotation_quarters: u8,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        palette: Option<BuildPalette>,
    },
    BuildRemove {
        component_id: String,
    },
    BuildToggleDoor {
        component_id: String,
    },
    /// W4 Fertilize: apply one soil amendment to a tilled tile (carries the
    /// fertilizer item container, like PlantSeed).
    Fertilize {
        parcel_id: String,
        cell_x: i32,
        cell_y: i32,
        container: String,
        stack_id: String,
        variant_id: u32,
    },
    /// W5 HarvestCrop: harvest a mature crop (tile-addressed, no container).
    HarvestCrop {
        parcel_id: String,
        cell_x: i32,
        cell_y: i32,
    },
    GuildCreate {
        name: String,
        tag: String,
        terminal_prop_id: String,
    },
    GuildInvite {
        target_actor_id: String,
    },
    GuildAcceptInvite {
        invite_id: String,
    },
    GuildDeclineInvite {
        invite_id: String,
    },
    GuildLeave {},
    GuildKick {
        target_actor_id: String,
    },
    GuildSetRole {
        target_actor_id: String,
        role: String,
    },
    GuildSetPermissions {
        target_actor_id: String,
        permissions: u8,
    },
    GuildTransferLeadership {
        target_actor_id: String,
    },
    GuildDeclareWar {
        opposing_guild_id: String,
    },
    GuildAcceptWar {
        opposing_guild_id: String,
    },
    GuildRescindWar {
        opposing_guild_id: String,
    },
    GuildDisband {},
}

const fn default_debug_give_quantity() -> u32 {
    1
}

impl ClientCommand {
    /// Stable leading command tag used by the canonical writer.
    ///
    /// Keep this exhaustive match in lockstep with `write_to`: adding a
    /// `ClientCommand` variant without assigning a unique tag is a compile-time
    /// failure, and the focused uniqueness test below protects the frozen set.
    pub const fn wire_tag(&self) -> u32 {
        match self {
            Self::Move { .. } => 1,
            Self::SetMoveIntent { .. } => 40,
            Self::QueueCombatAction { .. } => 35,
            Self::Peace {} => 36,
            Self::CancelAbilityQueue { .. } => 41,
            Self::ReloadWeapon { .. } => 30,
            Self::SetEquippedWeapon { .. } => 31,
            Self::SetEquippedClothing { .. } => 118,
            Self::EnterTransition { .. } => 3,
            Self::UseConsumable { .. } => 4,
            Self::RefillAmmo { .. } => 7,
            Self::ApplyServiceBuff { .. } => 5,
            Self::CloneRespawn { .. } => 6,
            Self::ReviveActor { .. } => 10,
            Self::BankStoreItem { .. } => 130,
            Self::BankRetrieveItem { .. } => 131,
            Self::BankDepositCredits { .. } => 132,
            Self::BankWithdrawCredits { .. } => 133,
            Self::CloneSaveSkillBackup {} => 134,
            Self::CorpseTakeCredits { .. } => 135,
            Self::SetPosture { .. } => 32,
            Self::SampleResource { .. } => 8,
            Self::SurveyResource { .. } => 17,
            Self::PlaceExtractor { .. } => 42,
            Self::CrankExtractor { .. } => 43,
            Self::StopCrank {} => 44,
            Self::InsertBattery { .. } => 47,
            Self::CollectExtractor { .. } => 45,
            Self::DestroyExtractor { .. } => 46,
            Self::PlaceCamp {} => 67,
            Self::PackUpCamp {} => 68,
            Self::DiscardStack { .. } => 95,
            Self::SplitStack { .. } => 33,
            Self::MergeStacks { .. } => 34,
            Self::RedeemCreditChip { .. } => 94,
            Self::HarvestCorpse { .. } => 9,
            Self::TakeLootItem { .. } => 37,
            Self::PurchaseTravelTicket { .. } => 155,
            Self::UseTravelTicket { .. } => 156,
            Self::ToggleDoor { .. } => 157,
            Self::CraftItem { .. } => 11,
            Self::CraftBegin { .. } => 48,
            Self::CraftAssignSlot { .. } => 49,
            Self::CraftClearSlot { .. } => 50,
            Self::CraftAssemble {} => 51,
            Self::CraftExperiment { .. } => 52,
            Self::CraftFinalizePrototype { .. } => 53,
            Self::CraftFinalizePractice {} => 119,
            Self::CraftDraftSchematic { .. } => 54,
            Self::FactoryManufacture { .. } => 154,
            Self::CraftCancel {} => 55,
            Self::RequestStarterTool { .. } => 56,
            Self::PurchaseSkillBox { .. } => 18,
            Self::UnlearnSkillBox { .. } => 97,
            Self::SetProfessionTitle { .. } => 19,
            Self::SetCareerGoal { .. } => 25,
            Self::StoreToExchange { .. } => 12,
            Self::RetrieveFromExchange { .. } => 13,
            Self::ProposeTrade { .. } => 14,
            Self::AcceptTrade { .. } => 15,
            Self::DeclineTrade { .. } => 16,
            Self::AddTradeItem { .. } => 63,
            Self::RemoveTradeItem { .. } => 64,
            Self::SetTradeCoin { .. } => 65,
            Self::ConfirmTrade { .. } => 66,
            Self::DebugGiveItem { .. } => 38,
            Self::DebugGrantSkillBoxes { .. } => 39,
            Self::GroupInvite { .. } => 57,
            Self::GroupAccept {} => 58,
            Self::GroupDecline {} => 59,
            Self::GroupLeave {} => 60,
            Self::GroupDisband {} => 61,
            Self::GroupKick { .. } => 62,
            Self::DuelChallenge { .. } => 90,
            Self::DuelAccept {} => 91,
            Self::DuelDecline {} => 92,
            Self::DuelYield {} => 93,
            Self::Deathblow { .. } => 136,
            Self::GeneSample { .. } => 80,
            Self::ScanGenome { .. } => 81,
            Self::SpliceBegin { .. } => 82,
            Self::SpliceAssignSlot { .. } => 83,
            Self::SpliceClearSlot { .. } => 84,
            Self::SpliceChooseAllele { .. } => 85,
            Self::SpliceAssemble {} => 86,
            Self::SpliceExperimentLocus { .. } => 87,
            Self::SpliceMint { .. } => 88,
            Self::SpliceCancel {} => 89,
            Self::ClaimParcel { .. } => 69,
            Self::AbandonParcel { .. } => 70,
            Self::RenameParcel { .. } => 71,
            Self::PayUpkeep { .. } => 72,
            Self::TillTile { .. } => 73,
            Self::PlantSeed { .. } => 74,
            Self::ClearTile { .. } => 75,
            Self::WaterTile { .. } => 76,
            Self::TendPlot { .. } => 77,
            Self::PlaceFarmStructure { .. } => 78,
            Self::BuildPlace { .. } => 151,
            Self::BuildRemove { .. } => 152,
            Self::BuildToggleDoor { .. } => 153,
            Self::RemoveFarmStructure { .. } => 79,
            Self::Fertilize { .. } => 150,
            Self::HarvestCrop { .. } => 96,
            Self::GuildCreate { .. } => 137,
            Self::GuildInvite { .. } => 138,
            Self::GuildAcceptInvite { .. } => 139,
            Self::GuildDeclineInvite { .. } => 140,
            Self::GuildLeave {} => 141,
            Self::GuildKick { .. } => 142,
            Self::GuildSetRole { .. } => 143,
            Self::GuildSetPermissions { .. } => 144,
            Self::GuildTransferLeadership { .. } => 145,
            Self::GuildDeclareWar { .. } => 146,
            Self::GuildAcceptWar { .. } => 147,
            Self::GuildRescindWar { .. } => 148,
            Self::GuildDisband {} => 149,
        }
    }
    /// Debug-only commands are never valid on a production capability path.
    pub const fn is_debug_only(&self) -> bool {
        matches!(
            self,
            Self::DebugGiveItem { .. } | Self::DebugGrantSkillBoxes { .. }
        )
    }
    pub fn write_to(&self, w: &mut StateWriter) {
        match self {
            Self::Move {
                dx,
                dy,
                duration_ticks,
                facing,
                sprint,
            } => {
                w.write_u32(self.wire_tag())
                    .write_i64(i64::from(*dx))
                    .write_i64(i64::from(*dy))
                    .write_u32(u32::from(*duration_ticks))
                    .write_u32(facing.map_or(0, CardinalDirection::code));
                if *sprint {
                    w.write_u32(1);
                }
            }
            Self::SetMoveIntent {
                dx,
                dy,
                facing,
                sprint,
            } => {
                w.write_u32(self.wire_tag())
                    .write_i64(i64::from(*dx))
                    .write_i64(i64::from(*dy))
                    .write_u32(facing.map_or(0, CardinalDirection::code));
                if *sprint {
                    w.write_u32(1);
                }
            }
            Self::QueueCombatAction {
                action_id,
                target_actor_id,
            } => {
                w.write_u32(self.wire_tag());
                write_string(w, action_id);
                write_string(w, target_actor_id);
            }
            Self::Peace {} => {
                w.write_u32(self.wire_tag());
            }
            Self::CancelAbilityQueue {
                queue_entry_id,
                scope,
            } => {
                w.write_u32(self.wire_tag());
                write_optional_string(w, queue_entry_id.as_deref());
                write_optional_string(w, scope.as_deref());
            }
            Self::ReloadWeapon {
                weapon_id,
                ammo_type,
            } => {
                w.write_u32(self.wire_tag())
                    .write_u32(weapon_id.map_or(0, AuthorityWeaponId::code))
                    .write_u32(ammo_type.map_or(0, AuthorityAmmoTypeId::code));
            }
            Self::SetEquippedWeapon {
                weapon_id,
                weapon_item_id,
                weapon_variant_id,
            } => {
                w.write_u32(self.wire_tag())
                    .write_u32(weapon_id.map_or(0, AuthorityWeaponId::code))
                    .write_u32(weapon_item_id.unwrap_or(0))
                    .write_u32(weapon_variant_id.unwrap_or(0));
            }
            Self::SetEquippedClothing {
                item_id,
                equipped,
                container,
                stack_id,
                variant_id,
            } => {
                w.write_u32(self.wire_tag())
                    .write_u32(*item_id)
                    .write_bool(*equipped);
                write_optional_string(w, container.as_deref());
                write_optional_string(w, stack_id.as_deref());
                w.write_u32(variant_id.map(|id| id.saturating_add(1)).unwrap_or(0));
            }
            Self::EnterTransition { transition_id } => {
                w.write_u32(self.wire_tag());
                write_string(w, transition_id);
            }
            Self::UseConsumable {
                item_id,
                item_numeric_id,
                variant_id,
            } => {
                w.write_u32(self.wire_tag());
                write_string(w, item_id);
                w.write_u32(item_numeric_id.unwrap_or(0))
                    .write_u32(variant_id.map(|id| id.saturating_add(1)).unwrap_or(0));
            }
            Self::RefillAmmo { item_id } => {
                w.write_u32(self.wire_tag());
                write_string(w, item_id);
            }
            Self::ApplyServiceBuff { effect_id } => {
                w.write_u32(self.wire_tag());
                write_string(w, effect_id);
            }
            Self::CloneRespawn { facility_id } => {
                w.write_u32(self.wire_tag());
                if let Some(facility_id) = facility_id {
                    write_string(w, facility_id);
                }
            }
            Self::ReviveActor { target_actor_id } => {
                w.write_u32(self.wire_tag());
                write_string(w, target_actor_id);
            }
            Self::BankStoreItem {
                source_stack_id,
                quantity,
            } => {
                w.write_u32(self.wire_tag());
                write_string(w, source_stack_id);
                w.write_u32(*quantity);
            }
            Self::BankRetrieveItem {
                bank_stack_id,
                quantity,
            } => {
                w.write_u32(self.wire_tag());
                write_string(w, bank_stack_id);
                w.write_u32(*quantity);
            }
            Self::BankDepositCredits { amount } => {
                w.write_u32(self.wire_tag()).write_u64(*amount);
            }
            Self::BankWithdrawCredits { amount } => {
                w.write_u32(self.wire_tag()).write_u64(*amount);
            }
            Self::CloneSaveSkillBackup {} => {
                w.write_u32(self.wire_tag());
            }
            Self::CorpseTakeCredits { corpse_id } => {
                w.write_u32(self.wire_tag());
                write_string(w, corpse_id);
            }
            Self::SetPosture { posture } => {
                w.write_u32(self.wire_tag());
                write_string(w, posture);
            }
            Self::SampleResource { family, stop } => {
                w.write_u32(self.wire_tag());
                write_string(w, family);
                w.write_bool(*stop);
            }
            Self::SurveyResource { family } => {
                w.write_u32(self.wire_tag());
                write_string(w, family);
            }
            Self::PlaceExtractor { family } => {
                w.write_u32(self.wire_tag());
                write_string(w, family);
            }
            Self::CrankExtractor { extractor_id } => {
                w.write_u32(self.wire_tag());
                write_string(w, extractor_id);
            }
            Self::StopCrank {} => {
                w.write_u32(self.wire_tag());
            }
            Self::InsertBattery {
                extractor_id,
                container,
                stack_id,
                variant_id,
            } => {
                w.write_u32(self.wire_tag());
                write_string(w, extractor_id);
                write_string(w, container);
                write_string(w, stack_id);
                w.write_u32(*variant_id);
            }
            Self::CollectExtractor { extractor_id } => {
                w.write_u32(self.wire_tag());
                write_string(w, extractor_id);
            }
            Self::DestroyExtractor { extractor_id } => {
                w.write_u32(self.wire_tag());
                write_string(w, extractor_id);
            }
            Self::DiscardStack {
                container,
                stack_id,
                item_id,
                variant_id,
            } => {
                w.write_u32(self.wire_tag());
                write_string(w, container);
                write_string(w, stack_id);
                w.write_u32(*item_id).write_u32(*variant_id);
            }
            Self::SplitStack {
                container,
                stack_id,
                item_id,
                variant_id,
                quantity,
            } => {
                w.write_u32(self.wire_tag());
                write_string(w, container);
                write_string(w, stack_id);
                w.write_u32(*item_id)
                    .write_u32(*variant_id)
                    .write_u32(*quantity);
            }
            Self::MergeStacks {
                container,
                source_stack_id,
                target_stack_id,
            } => {
                w.write_u32(self.wire_tag());
                write_string(w, container);
                write_string(w, source_stack_id);
                write_string(w, target_stack_id);
            }
            Self::RedeemCreditChip {
                container,
                stack_id,
            } => {
                w.write_u32(self.wire_tag());
                write_string(w, container);
                write_string(w, stack_id);
            }
            Self::HarvestCorpse { target_actor_id } => {
                w.write_u32(self.wire_tag());
                write_string(w, target_actor_id);
            }
            Self::TakeLootItem {
                container,
                item_id,
                variant_id,
                quantity,
            } => {
                w.write_u32(self.wire_tag());
                write_string(w, container);
                w.write_u32(*item_id)
                    .write_u32(*variant_id)
                    .write_i64(i64::from(*quantity));
            }
            Self::PurchaseTravelTicket {
                terminal_prop_id,
                to_planet_id,
                to_city_id,
            } => {
                w.write_u32(self.wire_tag());
                write_string(w, terminal_prop_id);
                write_string(w, to_planet_id);
                write_string(w, to_city_id);
            }
            Self::UseTravelTicket {
                container,
                stack_id,
                ticket_id,
                item_id,
                item_numeric_id,
                variant_id,
            } => {
                w.write_u32(self.wire_tag());
                write_optional_string(w, container.as_deref());
                write_optional_string(w, stack_id.as_deref());
                write_optional_string(w, ticket_id.as_deref());
                write_optional_string(w, item_id.as_deref());
                w.write_u32(item_numeric_id.unwrap_or(0));
                w.write_u32(variant_id.map(|v| v.saturating_add(1)).unwrap_or(0));
            }
            Self::ToggleDoor { prop_id } => {
                w.write_u32(self.wire_tag());
                write_string(w, prop_id);
            }
            Self::CraftItem {
                schematic_id,
                experiment_power,
                experiment_handling,
                experiment_reliability,
            } => {
                w.write_u32(self.wire_tag());
                write_string(w, schematic_id);
                w.write_u32(u32::from(*experiment_power))
                    .write_u32(u32::from(*experiment_handling))
                    .write_u32(u32::from(*experiment_reliability));
            }
            Self::CraftBegin { recipe_id } => {
                w.write_u32(self.wire_tag());
                write_string(w, recipe_id);
            }
            Self::CraftAssignSlot {
                slot_index,
                container,
                stack_id,
                variant_id,
            } => {
                w.write_u32(self.wire_tag())
                    .write_u32(u32::from(*slot_index));
                write_string(w, container);
                write_string(w, stack_id);
                w.write_u32(*variant_id);
            }
            Self::CraftClearSlot { slot_index } => {
                w.write_u32(self.wire_tag())
                    .write_u32(u32::from(*slot_index));
            }
            Self::CraftAssemble {} => {
                w.write_u32(self.wire_tag());
            }
            Self::CraftExperiment { line_id, points } => {
                w.write_u32(self.wire_tag())
                    .write_u32(u32::from(*line_id))
                    .write_u32(u32::from(*points));
            }
            Self::CraftFinalizePrototype { custom_name } => {
                w.write_u32(self.wire_tag());
                write_string(w, custom_name);
            }
            Self::CraftFinalizePractice {} => {
                w.write_u32(self.wire_tag());
            }
            Self::CraftDraftSchematic { max_uses } => {
                w.write_u32(self.wire_tag()).write_u32(u32::from(*max_uses));
            }
            Self::FactoryManufacture {
                factory_id,
                schematic_id,
            } => {
                w.write_u32(self.wire_tag());
                write_string(w, factory_id);
                write_string(w, schematic_id);
            }
            Self::CraftCancel {} => {
                w.write_u32(self.wire_tag());
            }
            Self::RequestStarterTool { trainer_actor_id } => {
                w.write_u32(self.wire_tag());
                write_string(w, trainer_actor_id);
            }
            Self::PurchaseSkillBox {
                skill_box_id,
                trainer_actor_id,
            } => {
                w.write_u32(self.wire_tag());
                write_string(w, skill_box_id);
                write_string(w, trainer_actor_id);
            }
            Self::UnlearnSkillBox {
                skill_box_id,
                trainer_actor_id,
            } => {
                w.write_u32(self.wire_tag());
                write_string(w, skill_box_id);
                write_string(w, trainer_actor_id);
            }
            Self::SetProfessionTitle { title_id } => {
                w.write_u32(self.wire_tag());
                write_string(w, title_id.as_deref().unwrap_or(""));
            }
            Self::SetCareerGoal {
                goal_id,
                trainer_actor_id,
            } => {
                w.write_u32(self.wire_tag());
                write_string(w, goal_id);
                write_string(w, trainer_actor_id);
            }
            Self::StoreToExchange {
                item_id,
                variant_id,
                quantity,
            } => {
                w.write_u32(self.wire_tag())
                    .write_u32(*item_id)
                    .write_u32(*variant_id)
                    .write_u32(*quantity);
            }
            Self::RetrieveFromExchange {
                item_id,
                variant_id,
                quantity,
            } => {
                w.write_u32(self.wire_tag())
                    .write_u32(*item_id)
                    .write_u32(*variant_id)
                    .write_u32(*quantity);
            }
            Self::ProposeTrade {
                partner_actor_id,
                offer,
                request,
            } => {
                w.write_u32(self.wire_tag());
                write_string(w, partner_actor_id);
                w.write_u32(u32::try_from(offer.len()).unwrap_or(u32::MAX));
                for item in offer {
                    w.write_u32(item.item_id)
                        .write_u32(item.variant_id)
                        .write_u32(item.quantity);
                }
                w.write_u32(u32::try_from(request.len()).unwrap_or(u32::MAX));
                for item in request {
                    w.write_u32(item.item_id)
                        .write_u32(item.variant_id)
                        .write_u32(item.quantity);
                }
            }
            Self::AcceptTrade { proposal_id } => {
                w.write_u32(self.wire_tag()).write_u32(*proposal_id);
            }
            Self::DeclineTrade { proposal_id } => {
                w.write_u32(self.wire_tag()).write_u32(*proposal_id);
            }
            Self::AddTradeItem { proposal_id, item } => {
                w.write_u32(self.wire_tag()).write_u32(*proposal_id);
                w.write_u32(item.item_id)
                    .write_u32(item.variant_id)
                    .write_u32(item.quantity);
            }
            Self::RemoveTradeItem { proposal_id, item } => {
                w.write_u32(self.wire_tag()).write_u32(*proposal_id);
                w.write_u32(item.item_id)
                    .write_u32(item.variant_id)
                    .write_u32(item.quantity);
            }
            Self::SetTradeCoin {
                proposal_id,
                amount,
            } => {
                w.write_u32(self.wire_tag())
                    .write_u32(*proposal_id)
                    .write_u64(*amount);
            }
            Self::ConfirmTrade { proposal_id } => {
                w.write_u32(self.wire_tag()).write_u32(*proposal_id);
            }
            Self::DebugGiveItem {
                item_id,
                variant_id,
                quantity,
                equip,
            } => {
                w.write_u32(self.wire_tag())
                    .write_u32(*item_id)
                    .write_u32(*variant_id)
                    .write_u32(*quantity)
                    .write_u32(if *equip { 1 } else { 0 });
            }
            Self::DebugGrantSkillBoxes { skill_box_ids } => {
                w.write_u32(self.wire_tag())
                    .write_u32(u32::try_from(skill_box_ids.len()).unwrap_or(u32::MAX));
                for skill_box_id in skill_box_ids {
                    write_string(w, skill_box_id);
                }
            }
            Self::GroupInvite { target_actor_id } => {
                w.write_u32(self.wire_tag());
                write_string(w, target_actor_id);
            }
            Self::GroupAccept {} => {
                w.write_u32(self.wire_tag());
            }
            Self::GroupDecline {} => {
                w.write_u32(self.wire_tag());
            }
            Self::GroupLeave {} => {
                w.write_u32(self.wire_tag());
            }
            Self::GroupDisband {} => {
                w.write_u32(self.wire_tag());
            }
            Self::GroupKick { target_actor_id } => {
                w.write_u32(self.wire_tag());
                write_string(w, target_actor_id);
            }
            Self::PlaceCamp {} => {
                w.write_u32(self.wire_tag());
            }
            Self::PackUpCamp {} => {
                w.write_u32(self.wire_tag());
            }
            Self::ClaimParcel {
                planet_id,
                area_id,
                x,
                y,
                tier,
            } => {
                w.write_u32(self.wire_tag());
                write_string(w, planet_id);
                write_string(w, area_id);
                w.write_i64(i64::from(*x)).write_i64(i64::from(*y));
                write_string(w, tier);
            }
            Self::AbandonParcel { parcel_id } => {
                w.write_u32(self.wire_tag());
                write_string(w, parcel_id);
            }
            Self::RenameParcel { parcel_id, name } => {
                w.write_u32(self.wire_tag());
                write_string(w, parcel_id);
                write_string(w, name);
            }
            Self::PayUpkeep { parcel_id } => {
                w.write_u32(self.wire_tag());
                write_string(w, parcel_id);
            }
            Self::TillTile {
                parcel_id,
                cell_x,
                cell_y,
            } => {
                w.write_u32(self.wire_tag());
                write_string(w, parcel_id);
                w.write_i64(i64::from(*cell_x))
                    .write_i64(i64::from(*cell_y));
            }
            Self::PlantSeed {
                parcel_id,
                cell_x,
                cell_y,
                container,
                stack_id,
                variant_id,
            } => {
                w.write_u32(self.wire_tag());
                write_string(w, parcel_id);
                w.write_i64(i64::from(*cell_x))
                    .write_i64(i64::from(*cell_y));
                write_string(w, container);
                write_string(w, stack_id);
                w.write_u32(*variant_id);
            }
            Self::ClearTile {
                parcel_id,
                cell_x,
                cell_y,
            } => {
                w.write_u32(self.wire_tag());
                write_string(w, parcel_id);
                w.write_i64(i64::from(*cell_x))
                    .write_i64(i64::from(*cell_y));
            }
            Self::WaterTile {
                parcel_id,
                cell_x,
                cell_y,
            } => {
                w.write_u32(self.wire_tag());
                write_string(w, parcel_id);
                w.write_i64(i64::from(*cell_x))
                    .write_i64(i64::from(*cell_y));
            }
            Self::TendPlot { parcel_id, stop } => {
                w.write_u32(self.wire_tag());
                write_string(w, parcel_id);
                w.write_bool(*stop);
            }
            Self::PlaceFarmStructure {
                parcel_id,
                structure_item_id,
                cell_x,
                cell_y,
            } => {
                w.write_u32(self.wire_tag());
                write_string(w, parcel_id);
                w.write_u32(*structure_item_id);
                w.write_i64(i64::from(*cell_x))
                    .write_i64(i64::from(*cell_y));
            }
            Self::RemoveFarmStructure {
                parcel_id,
                structure_id,
            } => {
                w.write_u32(self.wire_tag());
                write_string(w, parcel_id);
                write_string(w, structure_id);
            }
            Self::BuildPlace {
                catalog_id,
                parcel_id,
                cell_x,
                cell_y,
                rotation_quarters,
                palette,
            } => {
                w.write_u32(self.wire_tag());
                write_string(w, catalog_id);
                write_string(w, parcel_id);
                w.write_i64(i64::from(*cell_x))
                    .write_i64(i64::from(*cell_y))
                    .write_u32(u32::from(*rotation_quarters));
                w.write_bool(palette.is_some());
                if let Some(palette) = palette {
                    for value in [&palette.primary, &palette.secondary, &palette.accent] {
                        w.write_bool(value.is_some());
                        if let Some(value) = value {
                            write_string(w, value);
                        }
                    }
                }
            }
            Self::BuildRemove { component_id } | Self::BuildToggleDoor { component_id } => {
                w.write_u32(self.wire_tag());
                write_string(w, component_id);
            }
            Self::Fertilize {
                parcel_id,
                cell_x,
                cell_y,
                container,
                stack_id,
                variant_id,
            } => {
                w.write_u32(self.wire_tag());
                write_string(w, parcel_id);
                w.write_i64(i64::from(*cell_x))
                    .write_i64(i64::from(*cell_y));
                write_string(w, container);
                write_string(w, stack_id);
                w.write_u32(*variant_id);
            }
            Self::HarvestCrop {
                parcel_id,
                cell_x,
                cell_y,
            } => {
                w.write_u32(self.wire_tag());
                write_string(w, parcel_id);
                w.write_i64(i64::from(*cell_x))
                    .write_i64(i64::from(*cell_y));
            }
            Self::DuelChallenge { target_actor_id } => {
                w.write_u32(self.wire_tag());
                write_string(w, target_actor_id);
            }
            Self::DuelAccept {} => {
                w.write_u32(self.wire_tag());
            }
            Self::DuelDecline {} => {
                w.write_u32(self.wire_tag());
            }
            Self::DuelYield {} => {
                w.write_u32(self.wire_tag());
            }
            Self::Deathblow { target_actor_id } => {
                w.write_u32(self.wire_tag());
                write_string(w, target_actor_id);
            }
            Self::GeneSample { species } => {
                w.write_u32(self.wire_tag());
                write_string(w, species);
            }
            Self::ScanGenome {
                container,
                stack_id,
                variant_id,
            } => {
                w.write_u32(self.wire_tag());
                write_string(w, container);
                write_string(w, stack_id);
                w.write_u32(*variant_id);
            }
            Self::SpliceBegin { species } => {
                w.write_u32(self.wire_tag());
                write_string(w, species);
            }
            Self::SpliceAssignSlot {
                slot_index,
                container,
                stack_id,
                variant_id,
            } => {
                w.write_u32(self.wire_tag())
                    .write_u32(u32::from(*slot_index));
                write_string(w, container);
                write_string(w, stack_id);
                w.write_u32(*variant_id);
            }
            Self::SpliceClearSlot { slot_index } => {
                w.write_u32(self.wire_tag())
                    .write_u32(u32::from(*slot_index));
            }
            Self::SpliceChooseAllele {
                locus,
                from_parent,
                allele,
            } => {
                w.write_u32(self.wire_tag())
                    .write_u32(u32::from(*locus))
                    .write_u32(u32::from(*from_parent))
                    .write_u32(u32::from(*allele));
            }
            Self::SpliceAssemble {} => {
                w.write_u32(self.wire_tag());
            }
            Self::SpliceExperimentLocus { locus, points } => {
                w.write_u32(self.wire_tag())
                    .write_u32(u32::from(*locus))
                    .write_u32(u32::from(*points));
            }
            Self::SpliceMint { cultivar_name } => {
                w.write_u32(self.wire_tag());
                write_string(w, cultivar_name.as_deref().unwrap_or(""));
            }
            Self::SpliceCancel {} => {
                w.write_u32(self.wire_tag());
            }
            Self::GuildCreate {
                name,
                tag,
                terminal_prop_id,
            } => {
                w.write_u32(self.wire_tag());
                write_string(w, name);
                write_string(w, tag);
                write_string(w, terminal_prop_id);
            }
            Self::GuildInvite { target_actor_id } => {
                w.write_u32(self.wire_tag());
                write_string(w, target_actor_id);
            }
            Self::GuildAcceptInvite { invite_id } => {
                w.write_u32(self.wire_tag());
                write_string(w, invite_id);
            }
            Self::GuildDeclineInvite { invite_id } => {
                w.write_u32(self.wire_tag());
                write_string(w, invite_id);
            }
            Self::GuildLeave {} => {
                w.write_u32(self.wire_tag());
            }
            Self::GuildKick { target_actor_id } => {
                w.write_u32(self.wire_tag());
                write_string(w, target_actor_id);
            }
            Self::GuildSetRole {
                target_actor_id,
                role,
            } => {
                w.write_u32(self.wire_tag());
                write_string(w, target_actor_id);
                write_string(w, role);
            }
            Self::GuildSetPermissions {
                target_actor_id,
                permissions,
            } => {
                w.write_u32(self.wire_tag());
                write_string(w, target_actor_id);
                w.write_u32(u32::from(*permissions));
            }
            Self::GuildTransferLeadership { target_actor_id } => {
                w.write_u32(self.wire_tag());
                write_string(w, target_actor_id);
            }
            Self::GuildDeclareWar { opposing_guild_id } => {
                w.write_u32(self.wire_tag());
                write_string(w, opposing_guild_id);
            }
            Self::GuildAcceptWar { opposing_guild_id } => {
                w.write_u32(self.wire_tag());
                write_string(w, opposing_guild_id);
            }
            Self::GuildRescindWar { opposing_guild_id } => {
                w.write_u32(self.wire_tag());
                write_string(w, opposing_guild_id);
            }
            Self::GuildDisband {} => {
                w.write_u32(self.wire_tag());
            }
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ClientCommandEnvelope {
    pub session: SessionId,
    pub player: PlayerId,
    pub command_id: u64,
    pub issued_at_tick: u64,
    pub command: ClientCommand,
}

impl ClientCommandEnvelope {
    pub fn stable_hash_hex(&self) -> String {
        let mut w = StateWriter::new();
        w.write_domain_header(b"net-client-command")
            .write_schema_version(1)
            .write_u64(self.session.0)
            .write_u32(self.player.0)
            .write_u64(self.command_id)
            .write_tick(self.issued_at_tick);
        self.command.write_to(&mut w);
        w.finalize_hex()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SnapshotDeltaSection {
    pub subsystem: String,
    pub schema: PayloadSchemaId,
    pub payload_hash: [u8; 32],
    pub payload_bytes: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SnapshotDeltaBundle {
    pub baseline_tick: u64,
    pub target_tick: u64,
    pub previous_state_hash: String,
    pub target_state_hash: String,
    pub sections: Vec<SnapshotDeltaSection>,
}

impl SnapshotDeltaBundle {
    pub fn stable_hash_hex(&self) -> String {
        let mut sections = self.sections.clone();
        sections.sort_by(|left, right| {
            left.subsystem
                .cmp(&right.subsystem)
                .then(left.schema.cmp(&right.schema))
                .then(left.payload_hash.cmp(&right.payload_hash))
                .then(left.payload_bytes.cmp(&right.payload_bytes))
        });

        let mut w = StateWriter::new();
        w.write_domain_header(b"net-delta-bundle")
            .write_schema_version(1)
            .write_tick(self.target_tick)
            .write_u64(self.baseline_tick);
        write_string(&mut w, &self.previous_state_hash);
        write_string(&mut w, &self.target_state_hash);
        w.write_u32(u32::try_from(sections.len()).expect("section count fits in u32"));
        for section in sections {
            write_string(&mut w, &section.subsystem);
            w.write_u32(section.schema.0)
                .write_bytes(&section.payload_hash)
                .write_u32(
                    u32::try_from(section.payload_bytes.len()).expect("payload length fits in u32"),
                )
                .write_bytes(&section.payload_bytes);
        }
        w.finalize_hex()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ServerCommandReceipt {
    pub command_id: u64,
    pub player: PlayerId,
    pub accepted_at_tick: u64,
    pub command_hash: String,
    pub resulting_state_hash: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ServerRejectedCommandReceipt {
    pub command_id: u64,
    pub player: PlayerId,
    pub rejected_at_tick: u64,
    pub command_hash: String,
    pub reason_code: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ServerTickDeliveryFrame {
    pub session: SessionId,
    pub tick: u64,
    pub bundle_hash: String,
    pub server_hash_chain: String,
    pub accepted: Vec<ServerCommandReceipt>,
    pub rejected: Vec<ServerRejectedCommandReceipt>,
}

impl ServerTickDeliveryFrame {
    pub fn from_bundle(session: SessionId, tick: TickIndex, bundle: &SnapshotDeltaBundle) -> Self {
        let bundle_hash = bundle.stable_hash_hex();
        let mut w = StateWriter::new();
        w.write_domain_header(b"net-server-chain")
            .write_schema_version(1)
            .write_u64(session.0)
            .write_tick(tick.0);
        write_string(&mut w, &bundle_hash);
        let server_hash_chain = w.finalize_hex();
        Self {
            session,
            tick: tick.0,
            bundle_hash,
            server_hash_chain,
            accepted: Vec::new(),
            rejected: Vec::new(),
        }
    }

    pub fn stable_hash_hex(&self) -> String {
        let mut accepted = self.accepted.clone();
        accepted
            .sort_by_key(|receipt| (receipt.accepted_at_tick, receipt.player, receipt.command_id));
        let mut rejected = self.rejected.clone();
        rejected
            .sort_by_key(|receipt| (receipt.rejected_at_tick, receipt.player, receipt.command_id));

        let mut w = StateWriter::new();
        w.write_domain_header(b"net-server-frame")
            .write_schema_version(1)
            .write_u64(self.session.0)
            .write_tick(self.tick);
        write_string(&mut w, &self.bundle_hash);
        write_string(&mut w, &self.server_hash_chain);
        w.write_u32(u32::try_from(accepted.len()).expect("accepted count fits in u32"));
        for receipt in accepted {
            w.write_u64(receipt.command_id)
                .write_u32(receipt.player.0)
                .write_tick(receipt.accepted_at_tick);
            write_string(&mut w, &receipt.command_hash);
            write_string(&mut w, &receipt.resulting_state_hash);
        }
        w.write_u32(u32::try_from(rejected.len()).expect("rejected count fits in u32"));
        for receipt in rejected {
            w.write_u64(receipt.command_id)
                .write_u32(receipt.player.0)
                .write_tick(receipt.rejected_at_tick);
            write_string(&mut w, &receipt.command_hash);
            write_string(&mut w, &receipt.reason_code);
        }
        w.finalize_hex()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ServerTickFrameReceipt {
    pub session: SessionId,
    pub tick: u64,
    pub frame_hash: String,
    pub client_seen_at_tick: u64,
}

fn write_string(w: &mut StateWriter, value: &str) {
    w.write_u32(u32::try_from(value.len()).expect("string length fits in u32"))
        .write_bytes(value.as_bytes());
}

fn write_optional_string(w: &mut StateWriter, value: Option<&str>) {
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

#[cfg(test)]
mod tests {
    use super::*;

    fn section(name: &str, byte: u8) -> SnapshotDeltaSection {
        SnapshotDeltaSection {
            subsystem: name.to_owned(),
            schema: PayloadSchemaId(1),
            payload_hash: [byte; 32],
            payload_bytes: vec![byte, byte.wrapping_add(1)],
        }
    }

    #[test]
    fn authority_weapon_wire_codes_append_without_renumbering_existing_ids() {
        let expected = [
            (AuthorityWeaponId::Slugthrower, 1),
            (AuthorityWeaponId::Vibrosword, 4),
            (AuthorityWeaponId::WpnPistol, 5),
            (AuthorityWeaponId::WpnSmg, 6),
            (AuthorityWeaponId::WpnCarbine, 7),
            (AuthorityWeaponId::WpnAssault, 8),
            (AuthorityWeaponId::WpnShotgun, 9),
            (AuthorityWeaponId::WpnSniper, 10),
            (AuthorityWeaponId::WpnHeavy, 11),
            (AuthorityWeaponId::WpnLauncher, 12),
            (AuthorityWeaponId::ScraplineMachete, 13),
            (AuthorityWeaponId::Unarmed, 14),
            (AuthorityWeaponId::FieldSaber, 15),
            (AuthorityWeaponId::QuarryChopper, 16),
            (AuthorityWeaponId::LightningCarbine, 17),
        ];
        for (weapon_id, code) in expected {
            assert_eq!(weapon_id.code(), code);
        }
    }

    #[test]
    fn equipped_clothing_command_hash_includes_container_identity() {
        let command_for_container = |container: Option<&str>| ClientCommandEnvelope {
            session: SessionId(1),
            player: PlayerId(1),
            command_id: 7,
            issued_at_tick: 11,
            command: ClientCommand::SetEquippedClothing {
                item_id: 7_201,
                equipped: true,
                container: container.map(str::to_owned),
                stack_id: Some("3".to_owned()),
                variant_id: Some(60_000_105),
            },
        };
        let first = command_for_container(Some("player:field-pack")).stable_hash_hex();
        let second = command_for_container(Some("player:wardrobe")).stable_hash_hex();
        let legacy = command_for_container(None).stable_hash_hex();
        assert_ne!(first, second);
        assert_ne!(first, legacy);
        assert_ne!(second, legacy);
    }

    #[test]
    fn bundle_hash_ignores_section_order() {
        let left = SnapshotDeltaBundle {
            baseline_tick: 1,
            target_tick: 2,
            previous_state_hash: "a".to_owned(),
            target_state_hash: "b".to_owned(),
            sections: vec![section("inventory", 1), section("spatial", 2)],
        };
        let right = SnapshotDeltaBundle {
            sections: vec![section("spatial", 2), section("inventory", 1)],
            ..left.clone()
        };
        assert_eq!(left.stable_hash_hex(), right.stable_hash_hex());
    }

    #[test]
    fn frame_hash_ignores_receipt_order() {
        let bundle = SnapshotDeltaBundle {
            baseline_tick: 7,
            target_tick: 8,
            previous_state_hash: "old".to_owned(),
            target_state_hash: "new".to_owned(),
            sections: vec![section("spatial", 4)],
        };
        let mut left = ServerTickDeliveryFrame::from_bundle(SessionId(42), TickIndex(8), &bundle);
        left.accepted = vec![
            ServerCommandReceipt {
                command_id: 2,
                player: PlayerId(1),
                accepted_at_tick: 8,
                command_hash: "cmd2".to_owned(),
                resulting_state_hash: "state2".to_owned(),
            },
            ServerCommandReceipt {
                command_id: 1,
                player: PlayerId(1),
                accepted_at_tick: 8,
                command_hash: "cmd1".to_owned(),
                resulting_state_hash: "state1".to_owned(),
            },
        ];

        let mut right = left.clone();
        right.accepted.reverse();
        assert_eq!(left.stable_hash_hex(), right.stable_hash_hex());
    }

    #[test]
    fn client_command_hash_separates_command_intent() {
        let move_right = ClientCommandEnvelope {
            session: SessionId(7),
            player: PlayerId(42),
            command_id: 1,
            issued_at_tick: 30,
            command: ClientCommand::Move {
                dx: 1,
                dy: 0,
                duration_ticks: 2,
                facing: None,
                sprint: false,
            },
        };
        let move_left = ClientCommandEnvelope {
            command: ClientCommand::Move {
                dx: -1,
                dy: 0,
                duration_ticks: 2,
                facing: None,
                sprint: false,
            },
            ..move_right.clone()
        };
        let sprint_right = ClientCommandEnvelope {
            command: ClientCommand::Move {
                dx: 1,
                dy: 0,
                duration_ticks: 2,
                facing: None,
                sprint: true,
            },
            ..move_right.clone()
        };
        let transition = ClientCommandEnvelope {
            command: ClientCommand::EnterTransition {
                transition_id: "bolt-bench-entry".to_owned(),
            },
            ..move_right.clone()
        };
        let queue_basic = ClientCommandEnvelope {
            command: ClientCommand::QueueCombatAction {
                action_id: "basic_shot".to_owned(),
                target_actor_id: "skirmish-1".to_owned(),
            },
            ..move_right.clone()
        };
        let queue_aimed = ClientCommandEnvelope {
            command: ClientCommand::QueueCombatAction {
                action_id: "aimed_shot".to_owned(),
                target_actor_id: "skirmish-1".to_owned(),
            },
            ..move_right.clone()
        };
        let queue_other_target = ClientCommandEnvelope {
            command: ClientCommand::QueueCombatAction {
                action_id: "basic_shot".to_owned(),
                target_actor_id: "skirmish-2".to_owned(),
            },
            ..move_right.clone()
        };
        let clone_nearest = ClientCommandEnvelope {
            command: ClientCommand::CloneRespawn { facility_id: None },
            ..move_right.clone()
        };
        let clone_selected = ClientCommandEnvelope {
            command: ClientCommand::CloneRespawn {
                facility_id: Some("camp-clone-vat".to_owned()),
            },
            ..move_right.clone()
        };
        let take_loot_item = ClientCommandEnvelope {
            command: ClientCommand::TakeLootItem {
                container: "cache:open-desert-cache-01".to_owned(),
                item_id: 3001,
                variant_id: 7,
                quantity: 1,
            },
            ..move_right.clone()
        };

        assert_eq!(
            move_right.stable_hash_hex(),
            move_right.clone().stable_hash_hex()
        );
        assert_ne!(move_right.stable_hash_hex(), move_left.stable_hash_hex());
        assert_ne!(move_right.stable_hash_hex(), sprint_right.stable_hash_hex());
        assert_ne!(move_right.stable_hash_hex(), transition.stable_hash_hex());
        assert_ne!(move_right.stable_hash_hex(), queue_basic.stable_hash_hex());
        assert_ne!(queue_basic.stable_hash_hex(), queue_aimed.stable_hash_hex());
        assert_ne!(
            queue_basic.stable_hash_hex(),
            queue_other_target.stable_hash_hex()
        );
        assert_ne!(
            clone_nearest.stable_hash_hex(),
            clone_selected.stable_hash_hex()
        );
        assert_ne!(
            move_right.stable_hash_hex(),
            take_loot_item.stable_hash_hex()
        );
    }

    #[test]
    fn group_commands_hash_distinctly() {
        let base = ClientCommandEnvelope {
            session: SessionId(3),
            player: PlayerId(9),
            command_id: 5,
            issued_at_tick: 12,
            command: ClientCommand::GroupInvite {
                target_actor_id: "p2".to_owned(),
            },
        };
        let variants = [
            ClientCommand::GroupInvite {
                target_actor_id: "p3".to_owned(),
            },
            ClientCommand::GroupAccept {},
            ClientCommand::GroupDecline {},
            ClientCommand::GroupLeave {},
            ClientCommand::GroupDisband {},
            ClientCommand::GroupKick {
                target_actor_id: "p2".to_owned(),
            },
        ];
        let mut hashes = vec![base.stable_hash_hex()];
        for command in variants {
            hashes.push(
                ClientCommandEnvelope {
                    command,
                    ..base.clone()
                }
                .stable_hash_hex(),
            );
        }
        for (i, a) in hashes.iter().enumerate() {
            for (j, b) in hashes.iter().enumerate() {
                if i != j {
                    assert_ne!(a, b, "group command hashes must differ ({i} vs {j})");
                }
            }
        }
        assert_eq!(base.stable_hash_hex(), base.clone().stable_hash_hex());
    }

    #[test]
    fn duel_commands_hash_distinctly() {
        let base = ClientCommandEnvelope {
            session: SessionId(4),
            player: PlayerId(11),
            command_id: 7,
            issued_at_tick: 20,
            command: ClientCommand::DuelChallenge {
                target_actor_id: "rival".to_owned(),
            },
        };
        let variants = [
            ClientCommand::DuelChallenge {
                target_actor_id: "other-rival".to_owned(),
            },
            ClientCommand::DuelAccept {},
            ClientCommand::DuelDecline {},
            ClientCommand::DuelYield {},
            ClientCommand::Deathblow {
                target_actor_id: "rival".to_owned(),
            },
        ];
        let mut hashes = vec![base.stable_hash_hex()];
        for command in variants {
            hashes.push(
                ClientCommandEnvelope {
                    command,
                    ..base.clone()
                }
                .stable_hash_hex(),
            );
        }
        for (i, a) in hashes.iter().enumerate() {
            for (j, b) in hashes.iter().enumerate() {
                if i != j {
                    assert_ne!(a, b, "duel command hashes must differ ({i} vs {j})");
                }
            }
        }
        assert_eq!(base.stable_hash_hex(), base.clone().stable_hash_hex());
    }

    #[test]
    fn trade_session_commands_hash_distinctly() {
        let base = ClientCommandEnvelope {
            session: SessionId(2),
            player: PlayerId(7),
            command_id: 11,
            issued_at_tick: 30,
            command: ClientCommand::AcceptTrade { proposal_id: 1 },
        };
        let stim = TradeItemSpec {
            item_id: 2_001,
            variant_id: 0,
            quantity: 1,
        };
        let ammo = TradeItemSpec {
            item_id: 3_001,
            variant_id: 7,
            quantity: 5,
        };
        let variants = [
            ClientCommand::AcceptTrade { proposal_id: 2 },
            ClientCommand::DeclineTrade { proposal_id: 1 },
            ClientCommand::ConfirmTrade { proposal_id: 1 },
            ClientCommand::AddTradeItem {
                proposal_id: 1,
                item: stim.clone(),
            },
            ClientCommand::AddTradeItem {
                proposal_id: 1,
                item: ammo.clone(),
            },
            ClientCommand::RemoveTradeItem {
                proposal_id: 1,
                item: stim.clone(),
            },
            ClientCommand::SetTradeCoin {
                proposal_id: 1,
                amount: 100,
            },
            ClientCommand::SetTradeCoin {
                proposal_id: 1,
                amount: 250,
            },
            ClientCommand::ProposeTrade {
                partner_actor_id: "q".to_owned(),
                offer: vec![stim.clone()],
                request: vec![],
            },
        ];
        let mut hashes = vec![base.stable_hash_hex()];
        for command in variants {
            hashes.push(
                ClientCommandEnvelope {
                    command,
                    ..base.clone()
                }
                .stable_hash_hex(),
            );
        }
        for (i, a) in hashes.iter().enumerate() {
            for (j, b) in hashes.iter().enumerate() {
                if i != j {
                    assert_ne!(a, b, "trade command hashes must differ ({i} vs {j})");
                }
            }
        }
        // Add vs Remove of the SAME line must still differ (distinct wire tags 63/64).
        let add = ClientCommandEnvelope {
            command: ClientCommand::AddTradeItem {
                proposal_id: 1,
                item: stim.clone(),
            },
            ..base.clone()
        };
        let remove = ClientCommandEnvelope {
            command: ClientCommand::RemoveTradeItem {
                proposal_id: 1,
                item: stim.clone(),
            },
            ..base.clone()
        };
        assert_ne!(
            add.stable_hash_hex(),
            remove.stable_hash_hex(),
            "add vs remove of the same line differ by tag"
        );
        assert_eq!(
            add.stable_hash_hex(),
            add.clone().stable_hash_hex(),
            "encoding is deterministic"
        );
    }

    #[test]
    fn farming_commands_hash_distinctly() {
        let base = ClientCommandEnvelope {
            session: SessionId(4),
            player: PlayerId(11),
            command_id: 21,
            issued_at_tick: 40,
            command: ClientCommand::ClaimParcel {
                planet_id: "planet-a".to_owned(),
                area_id: "open-desert".to_owned(),
                x: 10,
                y: 12,
                tier: "homestead".to_owned(),
            },
        };
        let variants = [
            // same command, different args must still differ
            ClientCommand::ClaimParcel {
                planet_id: "planet-a".to_owned(),
                area_id: "open-desert".to_owned(),
                x: 11,
                y: 12,
                tier: "homestead".to_owned(),
            },
            ClientCommand::ClaimParcel {
                planet_id: "planet-a".to_owned(),
                area_id: "open-desert".to_owned(),
                x: 10,
                y: 12,
                tier: "plantation".to_owned(),
            },
            ClientCommand::AbandonParcel {
                parcel_id: "parcel:planet-a:1".to_owned(),
            },
            ClientCommand::RenameParcel {
                parcel_id: "parcel:planet-a:1".to_owned(),
                name: "Test Parcel".to_owned(),
            },
            ClientCommand::PayUpkeep {
                parcel_id: "parcel:planet-a:1".to_owned(),
            },
            ClientCommand::TillTile {
                parcel_id: "parcel:planet-a:1".to_owned(),
                cell_x: 3,
                cell_y: 4,
            },
            ClientCommand::TillTile {
                parcel_id: "parcel:planet-a:1".to_owned(),
                cell_x: 4,
                cell_y: 4,
            },
            ClientCommand::PlantSeed {
                parcel_id: "parcel:planet-a:1".to_owned(),
                cell_x: 3,
                cell_y: 4,
                container: "player:field-pack".to_owned(),
                stack_id: "7".to_owned(),
                variant_id: 42,
            },
            ClientCommand::ClearTile {
                parcel_id: "parcel:planet-a:1".to_owned(),
                cell_x: 3,
                cell_y: 4,
            },
            ClientCommand::WaterTile {
                parcel_id: "parcel:planet-a:1".to_owned(),
                cell_x: 3,
                cell_y: 4,
            },
            ClientCommand::TendPlot {
                parcel_id: "parcel:planet-a:1".to_owned(),
                stop: false,
            },
            ClientCommand::TendPlot {
                parcel_id: "parcel:planet-a:1".to_owned(),
                stop: true,
            },
            ClientCommand::PlaceFarmStructure {
                parcel_id: "parcel:planet-a:1".to_owned(),
                structure_item_id: 6_301,
                cell_x: 3,
                cell_y: 4,
            },
            ClientCommand::RemoveFarmStructure {
                parcel_id: "parcel:planet-a:1".to_owned(),
                structure_id: "parcel:planet-a:1:struct:1".to_owned(),
            },
            ClientCommand::Fertilize {
                parcel_id: "parcel:planet-a:1".to_owned(),
                cell_x: 3,
                cell_y: 4,
                container: "player:field-pack".to_owned(),
                stack_id: "9".to_owned(),
                variant_id: 0,
            },
            ClientCommand::HarvestCrop {
                parcel_id: "parcel:planet-a:1".to_owned(),
                cell_x: 3,
                cell_y: 4,
            },
        ];
        let mut hashes = vec![base.stable_hash_hex()];
        for command in variants {
            hashes.push(
                ClientCommandEnvelope {
                    command,
                    ..base.clone()
                }
                .stable_hash_hex(),
            );
        }
        for (i, a) in hashes.iter().enumerate() {
            for (j, b) in hashes.iter().enumerate() {
                if i != j {
                    assert_ne!(a, b, "farming command hashes must differ ({i} vs {j})");
                }
            }
        }
        // TillTile vs ClearTile vs WaterTile of the SAME cell differ purely by wire tag.
        let same = |command| {
            ClientCommandEnvelope {
                command,
                ..base.clone()
            }
            .stable_hash_hex()
        };
        let till = same(ClientCommand::TillTile {
            parcel_id: "p".to_owned(),
            cell_x: 1,
            cell_y: 1,
        });
        let clear = same(ClientCommand::ClearTile {
            parcel_id: "p".to_owned(),
            cell_x: 1,
            cell_y: 1,
        });
        let water = same(ClientCommand::WaterTile {
            parcel_id: "p".to_owned(),
            cell_x: 1,
            cell_y: 1,
        });
        assert_ne!(till, clear);
        assert_ne!(till, water);
        assert_ne!(clear, water);
        assert_eq!(base.stable_hash_hex(), base.clone().stable_hash_hex());
    }

    /// Slugthrower/Coil Slug clean-cutover identity gate.
    /// Numeric weapon and ammo codes are wire-stable; changing them breaks every
    /// persisted snapshot and live client handshake. This test MUST red on any
    /// accidental re-numbering or old-name resurrection.
    #[test]
    fn slugthrower_coil_slug_identity_codes_are_stable() {
        // Weapon code: Slugthrower is weapon 1.
        assert_eq!(
            AuthorityWeaponId::Slugthrower.code(),
            1,
            "Slugthrower weapon code"
        );

        // Ammo codes: slug family occupies codes 1/2/3.
        assert_eq!(
            AuthorityAmmoTypeId::SlugIron.code(),
            1,
            "SlugIron ammo code"
        );
        assert_eq!(
            AuthorityAmmoTypeId::SlugShard.code(),
            2,
            "SlugShard ammo code"
        );
        assert_eq!(
            AuthorityAmmoTypeId::SlugSpike.code(),
            3,
            "SlugSpike ammo code"
        );
    }
    #[test]
    fn every_client_command_wire_tag_is_unique_and_stable() {
        // This is the frozen writer-tag set. The exhaustive `wire_tag` match
        // above forces new enum variants to receive an explicit tag; this
        // cardinality/set gate catches accidental reuse of any existing tag.
        const EXPECTED_WIRE_TAGS: &[u32] = &[
            1, 40, 35, 36, 41, 30, 31, 118, 3, 4, 7, 5, 6, 24, 130, 131, 132, 133, 134, 135, 32, 8,
            17, 42, 43, 44, 47, 45, 46, 67, 68, 95, 33, 34, 94, 9, 37, 11, 48, 49, 50, 51, 52, 53,
            119, 54, 55, 56, 18, 97, 19, 25, 12, 13, 14, 15, 16, 63, 64, 65, 66, 38, 39, 57, 58,
            59, 60, 61, 62, 90, 91, 92, 93, 136, 80, 81, 82, 83, 84, 85, 86, 87, 88, 89, 69, 70,
            71, 72, 73, 74, 75, 76, 77, 78, 79, 150, 96, 137, 138, 139, 140, 141, 142, 143, 144,
            145, 146, 147, 148, 149, 155, 156, 157,
        ];
        assert_eq!(EXPECTED_WIRE_TAGS.len(), 113);
        let unique = EXPECTED_WIRE_TAGS
            .iter()
            .copied()
            .collect::<std::collections::BTreeSet<_>>();
        assert_eq!(
            unique.len(),
            EXPECTED_WIRE_TAGS.len(),
            "writer tag collision"
        );
    }
}
