import { z } from "zod";
import { authorityWeaponIds } from "./weapons.js";
import type { WorldClockSnapshot } from "./worldClock.js";
import type { AreaWeatherSnapshot } from "./weather.js";

export const cardinalDirectionSchema = z.enum(["Front", "Right", "Back", "Left"]);
export const weaponIdSchema = z.enum(authorityWeaponIds);
export const ammoTypeSchema = z.enum(["slug_iron", "slug_shard", "slug_spike", "melee"]);
export const combatActionIdSchema = z.enum(["basic_shot", "aimed_shot"]);
export const ingressBudgetExhaustedReasonCode = "ingress_budget_exhausted" as const;
// Bare-use reuse-last sentinel for /survey and /sample. The client sends this
// family token when the player issued the command with no explicit family; the
// shard resolves it to the session's last resource family BEFORE forwarding to
// Rust or appending to the journal (ingress-only — the canonical/replayable
// command stream never carries the sentinel). Rust rejects a raw sentinel as an
// unknown family as a last line of defense.
export const lastResourceFamilySentinel = "$last" as const;
export const noSurveyContextReasonCode = "no_survey_context" as const;
export const noSampleContextReasonCode = "no_sample_context" as const;
export const abilityQueueCancelScopeSchema = z.enum(["owner_repeat", "combat", "posture", "all"]);

export const weatherPhaseSchema = z.enum(["idle", "warning", "active", "decay"]);
export const gameWeatherSnapshotSchema = z.object({
  areaId: z.string().min(1).max(96),
  eventType: z.string().min(1).max(64),
  phase: weatherPhaseSchema,
  centerX: z.number().finite(),
  centerY: z.number().finite(),
  radiusCells: z.number().finite().nonnegative(),
  intensity: z.number().finite().min(0).max(1),
  magnitude: z.number().finite().min(0).max(1),
  phaseEndsAtTick: z.number().int().nonnegative(),
  resolvesAtTick: z.number().int().nonnegative(),
  sweepDirRad: z.number().finite(),
});
export const gameWeatherSnapshotsSchema = z.array(gameWeatherSnapshotSchema);

export type GameWeatherSnapshot = AreaWeatherSnapshot;


export const gameClientViewSchema = z.object({
  area_id: z.string().min(1).max(96).optional(),
  viewport_width_cells: z.number().finite().min(1).max(512),
  viewport_height_cells: z.number().finite().min(1).max(512),
  // Cap matches shard.ts maxViewportMarginCells (128): the 3D client widens
  // its margin so the streamed AOI covers the 96-cell radar detection radius.
  margin_cells: z.number().finite().min(0).max(128).optional(),
  // Actor the client's camera is centered on. Normally the player's own actor (so AOI is
  // unchanged), but for a spectator/recording follow-cam this is the followed actor, so the
  // server centers area-of-interest there instead of on the controlled pawn.
  center_actor_id: z.string().min(1).max(96).optional(),
});

const EXCHANGE_TRADE_MAX_LINES = 50;
const CLIENT_COMMAND_KEYS = [
  "Move",
  "SetMoveIntent",
  "QueueCombatAction",
  "Peace",
  "CancelAbilityQueue",
  "ReloadWeapon",
  "SetEquippedWeapon",
  "SetEquippedClothing",
  "DebugGiveItem",
  "DebugGrantSkillBoxes",
  "DebugGiveCredits",
  "EnterTransition",
  "UseConsumable",
  "RefillAmmo",
  "ApplyServiceBuff",
  "CloneRespawn",
  "ReviveActor",
  "SetPosture",
  "SampleResource",
  "SurveyResource",
  "PlaceExtractor",
  "CrankExtractor",
  "StopCrank",
  "InsertBattery",
  "CollectExtractor",
  "DestroyExtractor",
  "SplitStack",
  "DiscardStack",
  "MergeStacks",
  "RedeemCreditChip",
  "HarvestCorpse",
  "BankStoreItem",
  "BankRetrieveItem",
  "BankDepositCredits",
  "BankWithdrawCredits",
  "CloneSaveSkillBackup",
  "CorpseTakeCredits",
  "TakeLootItem",
  "PurchaseTravelTicket",
  "UseTravelTicket",
  "ToggleDoor",
  "CraftItem",
  "CraftBegin",
  "CraftAssignSlot",
  "CraftClearSlot",
  "CraftAssemble",
  "CraftExperiment",
  "CraftFinalizePrototype",
  "CraftFinalizePractice",
  "CraftDraftSchematic",
  "FactoryManufacture",
  "CraftCancel",
  "RequestStarterTool",
  "PurchaseSkillBox",
  "UnlearnSkillBox",
  "SetProfessionTitle",
  "SetCareerGoal",
  "StoreToExchange",
  "RetrieveFromExchange",
  "ProposeTrade",
  "AcceptTrade",
  "DeclineTrade",
  "AddTradeItem",
  "RemoveTradeItem",
  "SetTradeCoin",
  "ConfirmTrade",
  "PlaceCamp",
  "PackUpCamp",
  "GroupInvite",
  "GroupAccept",
  "GroupDecline",
  "GroupLeave",
  "GroupDisband",
  "GroupKick",
  "DuelChallenge",
  "DuelAccept",
  "DuelDecline",
  "DuelYield",
  "Deathblow",
  "GeneSample",
  "ScanGenome",
  "SpliceBegin",
  "SpliceAssignSlot",
  "SpliceClearSlot",
  "SpliceChooseAllele",
  "SpliceAssemble",
  "SpliceExperimentLocus",
  "SpliceMint",
  "SpliceCancel",
  "ClaimParcel",
  "AbandonParcel",
  "RenameParcel",
  "PayUpkeep",
  "TillTile",
  "PlantSeed",
  "ClearTile",
  "WaterTile",
  "TendPlot",
  "PlaceFarmStructure",
  "RemoveFarmStructure",
  "Fertilize",
  "BuildPlace",
  "BuildRemove",
  "BuildToggleDoor",
  "HarvestCrop",
  "GuildCreate",
  "GuildInvite",
  "GuildAcceptInvite",
  "GuildDeclineInvite",
  "GuildLeave",
  "GuildKick",
  "GuildSetRole",
  "GuildSetPermissions",
  "GuildTransferLeadership",
  "GuildDeclareWar",
  "GuildAcceptWar",
  "GuildRescindWar",
  "GuildDisband",
] as const;
const clientCommandKeySet = new Set<string>(CLIENT_COMMAND_KEYS);

function nestedCommandKindKey(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (clientCommandKeySet.has(key)) return key;
    const match = nestedCommandKindKey(nested);
    if (match) return match;
  }
  return null;
}

const tradeItemSchema = z.object({
  item_id: z.number().int().nonnegative(),
  variant_id: z.number().int().nonnegative(),
  quantity: z.number().int().positive(),
});
const exactClientCommandEnvelopeSchema = z.unknown().superRefine((value, ctx) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    ctx.addIssue({ code: "custom", message: "command must be an object" });
    return;
  }
  const keys = Object.keys(value as Record<string, unknown>);
  const commandKeys = keys.filter((key) => clientCommandKeySet.has(key));
  if (commandKeys.length !== 1 || keys.length !== 1) {
    ctx.addIssue({
      code: "custom",
      message: "command must contain exactly one recognized command kind",
    });
    return;
  }
  const nestedKind = nestedCommandKindKey((value as Record<string, unknown>)[commandKeys[0]!]);
  if (nestedKind) {
    ctx.addIssue({
      code: "custom",
      message: `command payload must not contain nested command kind ${nestedKind}`,
    });
  }
});

export const rawClientCommandSchema = z.union([
  z.object({
    Move: z.object({
      dx: z.number().int().min(-1).max(1),
      dy: z.number().int().min(-1).max(1),
      duration_ticks: z.number().int().min(1).max(30),
      facing: cardinalDirectionSchema.optional(),
      sprint: z.boolean().optional(),
    }),
  }),
  z.object({
    SetMoveIntent: z.object({
      dx: z.number().int().min(-1).max(1),
      dy: z.number().int().min(-1).max(1),
      facing: cardinalDirectionSchema.optional(),
      sprint: z.boolean().optional(),
    }),
  }),
  z.object({
    QueueCombatAction: z.object({
      action_id: combatActionIdSchema,
      target_actor_id: z.string().min(1).max(96),
    }),
  }),
  z.object({
    Peace: z.object({}).strict(),
  }),
  z.object({
    CancelAbilityQueue: z.object({
      queue_entry_id: z.string().min(1).max(96).optional(),
      scope: abilityQueueCancelScopeSchema.optional(),
    }).strict(),
  }),
  z.object({
    ReloadWeapon: z.object({
      ammo_type: ammoTypeSchema.optional(),
      weapon_id: weaponIdSchema.optional(),
    }),
  }),
  z.object({
    SetEquippedWeapon: z.object({
      weapon_id: weaponIdSchema.nullable().optional(),
      weapon_item_id: z.number().int().nonnegative().optional(),
      weapon_variant_id: z.number().int().nonnegative().optional(),
    }),
  }),
  z.object({
    SetEquippedClothing: z.object({
      item_id: z.number().int().nonnegative(),
      equipped: z.boolean(),
      container: z.string().min(1).max(96).optional(),
      stack_id: z.string().max(20).regex(/^[1-9]\d*$/u).optional(),
      variant_id: z.number().int().nonnegative().optional(),
    }).strict(),
  }),
  z.object({
    DebugGiveItem: z.object({
      item_id: z.number().int().nonnegative(),
      variant_id: z.number().int().nonnegative().optional(),
      quantity: z.number().int().positive().max(100_000).optional(),
      equip: z.boolean().optional(),
    }),
  }),
  z.object({
    DebugGrantSkillBoxes: z.object({
      skill_box_ids: z.array(z.string().min(1).max(96)).min(1).max(64),
    }),
  }),
  z.object({
    // Signed: a tester drains a wallet as often as they fill one. Bounded well
    // inside i64 so the authority's saturating add can never be reached.
    DebugGiveCredits: z.object({
      amount: z.number().int().min(-1_000_000_000).max(1_000_000_000),
    }),
  }),
  z.object({
    EnterTransition: z.object({
      transition_id: z.string().min(1).max(96),
    }),
  }),
  z.object({
    UseConsumable: z.object({
      item_id: z.string().min(1).max(64),
      item_numeric_id: z.number().int().nonnegative().optional(),
      variant_id: z.number().int().nonnegative().optional(),
    }),
  }),
  z.object({
    RefillAmmo: z.object({
      item_id: z.string().min(1).max(64),
    }),
  }),
  z.object({
    ApplyServiceBuff: z.object({
      effect_id: z.string().min(1).max(64),
    }),
  }),
  z.object({
    CloneRespawn: z.object({
      facility_id: z.string().min(1).nullable().optional(),
    }).strict(),
  }),
  z.object({
    ReviveActor: z.object({
      target_actor_id: z.string().min(1).max(96),
    }),
  }),
  z.object({
    SetPosture: z.object({
      posture: z.enum(["kneel", "stand"]),
    }),
  }),
  z.object({
    SampleResource: z.object({
      family: z.string().min(1).max(48),
      stop: z.boolean().optional(),
    }).strict(),
  }),
  z.object({
    SurveyResource: z.object({
      family: z.string().min(1).max(48),
    }),
  }),
  z.object({
    PlaceExtractor: z.object({
      family: z.string().min(1).max(48),
    }),
  }),
  z.object({
    CrankExtractor: z.object({
      extractor_id: z.string().min(1).max(128),
    }),
  }),
  z.object({
    StopCrank: z.object({}).strict(),
  }),
  z.object({
    InsertBattery: z.object({
      extractor_id: z.string().min(1).max(128),
      container: z.string().min(1).max(128),
      stack_id: z.string().min(1).max(128),
      variant_id: z.number().int().nonnegative(),
    }),
  }),
  z.object({
    CollectExtractor: z.object({
      extractor_id: z.string().min(1).max(128),
    }),
  }),
  z.object({
    DestroyExtractor: z.object({
      extractor_id: z.string().min(1).max(128),
    }),
  }),
  z.object({
    PlaceCamp: z.object({}).strict(),
  }),
  z.object({
    PackUpCamp: z.object({}).strict(),
  }),
  z.object({
    DiscardStack: z.object({
      container: z.string().min(1).max(128),
      stack_id: z.string().min(1).max(128),
      item_id: z.number().int().nonnegative(),
      variant_id: z.number().int().nonnegative(),
    }),
  }),
  z.object({
    SplitStack: z.object({
      container: z.string().min(1).max(128),
      stack_id: z.string().min(1).max(128),
      item_id: z.number().int().nonnegative(),
      variant_id: z.number().int().nonnegative(),
      quantity: z.number().int().positive().max(100_000),
    }),
  }),
  z.object({
    MergeStacks: z.object({
      container: z.string().min(1).max(128),
      source_stack_id: z.string().min(1).max(128),
      target_stack_id: z.string().min(1).max(128),
    }),
  }),
  z.object({
    RedeemCreditChip: z.object({
      container: z.string().min(1).max(128),
      stack_id: z.string().min(1).max(128),
    }),
  }),
  z.object({
    HarvestCorpse: z.object({
      target_actor_id: z.string().min(1).max(96),
      material: z.string().min(1).max(48).optional(),
    }),
  }),
  z.object({
    BankStoreItem: z.object({
      source_stack_id: z.string().min(1).max(128),
      quantity: z.number().int().positive().max(100_000),
    }).strict(),
  }),
  z.object({
    BankRetrieveItem: z.object({
      bank_stack_id: z.string().min(1).max(128),
      quantity: z.number().int().positive().max(100_000),
    }).strict(),
  }),
  z.object({
    BankDepositCredits: z.object({
      amount: z.number().int().positive(),
    }).strict(),
  }),
  z.object({
    BankWithdrawCredits: z.object({
      amount: z.number().int().positive(),
    }).strict(),
  }),
  z.object({
    CloneSaveSkillBackup: z.object({}).strict(),
  }),
  z.object({
    CorpseTakeCredits: z.object({
      corpse_id: z.string().min(1).max(128),
    }).strict(),
  }),
  z.object({
    TakeLootItem: z.object({
      container: z.string().min(1).max(128),
      itemId: z.number().int().nonnegative(),
      variantId: z.number().int().nonnegative(),
      quantity: z.number().int().positive().max(100_000),
    }),
  }),
  z.object({
    PurchaseTravelTicket: z.object({
      terminal_prop_id: z.string().min(1).max(96),
      to_planet_id: z.string().min(1).max(64),
      to_city_id: z.string().min(1).max(64),
    }),
  }),
  z.object({
    UseTravelTicket: z.object({
      container: z.string().min(1).max(128).optional(),
      stack_id: z.string().min(1).max(128).optional(),
      ticket_id: z.string().min(1).max(128).optional(),
      item_id: z.literal("travel_ticket").optional(),
      item_numeric_id: z.number().int().nonnegative().optional(),
      variant_id: z.number().int().nonnegative().optional(),
    }),
  }),
  z.object({
    ToggleDoor: z.object({
      prop_id: z.string().min(1).max(96),
    }),
  }),
  z.object({
    CraftItem: z.object({
      schematic_id: z.string().min(1).max(96),
      experiment_power: z.number().int().min(0).max(20),
      experiment_handling: z.number().int().min(0).max(20),
      experiment_reliability: z.number().int().min(0).max(20),
    }),
  }),
  z.object({
    CraftBegin: z.object({
      recipe_id: z.string().min(1).max(96),
    }),
  }),
  z.object({
    CraftAssignSlot: z.object({
      slot_index: z.number().int().min(0).max(255),
      container: z.string().min(1).max(128),
      stack_id: z.string().min(1).max(128),
      variant_id: z.number().int().nonnegative(),
    }),
  }),
  z.object({
    CraftClearSlot: z.object({
      slot_index: z.number().int().min(0).max(255),
    }),
  }),
  z.object({
    CraftAssemble: z.object({}).strict(),
  }),
  z.object({
    CraftExperiment: z.object({
      line_id: z.number().int().min(0).max(255),
      points: z.number().int().min(1).max(255),
    }),
  }),
  z.object({
    CraftFinalizePrototype: z.object({
      custom_name: z.string().max(48).optional().default(""),
    }).strict(),
  }),
  z.object({
    CraftFinalizePractice: z.object({}).strict(),
  }),
  z.object({
    CraftDraftSchematic: z.object({
      max_uses: z.number().int().min(1).max(1000),
    }),
  }),
  z.object({
    FactoryManufacture: z.object({
      factory_id: z.string().min(1).max(96),
      schematic_id: z.string().min(1).max(96),
    }),
  }),
  z.object({
    CraftCancel: z.object({}).strict(),
  }),
  z.object({
    RequestStarterTool: z.object({
      trainer_actor_id: z.string().min(1).max(96),
    }),
  }),
  z.object({
    PurchaseSkillBox: z.object({
      skill_box_id: z.string().min(1).max(96),
      trainer_actor_id: z.string().min(1).max(96),
    }),
  }),
  z.object({
    UnlearnSkillBox: z.object({
      skill_box_id: z.string().min(1).max(96),
      trainer_actor_id: z.string().min(1).max(96),
    }),
  }),
  z.object({
    SetProfessionTitle: z.object({
      title_id: z.string().min(1).max(96).nullable().optional(),
    }),
  }),
  z.object({
    SetCareerGoal: z.object({
      goal_id: z.string().min(1).max(96),
      trainer_actor_id: z.string().min(1).max(96),
    }),
  }),
  z.object({
    StoreToExchange: z.object({
      item_id: z.number().int().nonnegative(),
      variant_id: z.number().int().nonnegative(),
      quantity: z.number().int().positive(),
    }),
  }),
  z.object({
    RetrieveFromExchange: z.object({
      item_id: z.number().int().nonnegative(),
      variant_id: z.number().int().nonnegative(),
      quantity: z.number().int().positive(),
    }),
  }),
  z.object({
    ProposeTrade: z.object({
      partner_actor_id: z.string().min(1).max(96),
      offer: z.array(tradeItemSchema).max(EXCHANGE_TRADE_MAX_LINES),
      request: z.array(tradeItemSchema).max(EXCHANGE_TRADE_MAX_LINES),
    }),
  }),
  z.object({
    AcceptTrade: z.object({
      proposal_id: z.number().int().positive(),
    }),
  }),
  z.object({
    DeclineTrade: z.object({
      proposal_id: z.number().int().positive(),
    }),
  }),
  z.object({
    AddTradeItem: z.object({
      proposal_id: z.number().int().positive(),
      item: tradeItemSchema,
    }),
  }),
  z.object({
    RemoveTradeItem: z.object({
      proposal_id: z.number().int().positive(),
      item: tradeItemSchema,
    }),
  }),
  z.object({
    SetTradeCoin: z.object({
      proposal_id: z.number().int().positive(),
      amount: z.number().int().nonnegative(),
    }),
  }),
  z.object({
    ConfirmTrade: z.object({
      proposal_id: z.number().int().positive(),
    }),
  }),
  z.object({
    GroupInvite: z.object({
      target_actor_id: z.string().min(1).max(96),
    }),
  }),
  z.object({
    GroupAccept: z.object({}).strict(),
  }),
  z.object({
    GroupDecline: z.object({}).strict(),
  }),
  z.object({
    GroupLeave: z.object({}).strict(),
  }),
  z.object({
    GroupDisband: z.object({}).strict(),
  }),
  z.object({
    GroupKick: z.object({
      target_actor_id: z.string().min(1).max(96),
    }),
  }),
  z.object({
    GuildCreate: z.object({
      name: z.string().min(1).max(48),
      tag: z.string().min(1).max(8),
      terminal_prop_id: z.string().min(1).max(128),
    }),
  }),
  z.object({
    GuildInvite: z.object({
      target_actor_id: z.string().min(1).max(96),
    }),
  }),
  z.object({
    GuildAcceptInvite: z.object({
      invite_id: z.string().min(1).max(96),
    }),
  }),
  z.object({
    GuildDeclineInvite: z.object({
      invite_id: z.string().min(1).max(96),
    }),
  }),
  z.object({
    GuildLeave: z.object({}).strict(),
  }),
  z.object({
    GuildKick: z.object({
      target_actor_id: z.string().min(1).max(96),
    }),
  }),
  z.object({
    GuildSetRole: z.object({
      target_actor_id: z.string().min(1).max(96),
      role: z.string().min(1).max(16),
    }),
  }),
  z.object({
    GuildSetPermissions: z.object({
      target_actor_id: z.string().min(1).max(96),
      permissions: z.number().int().min(0).max(31),
    }),
  }),
  z.object({
    GuildTransferLeadership: z.object({
      target_actor_id: z.string().min(1).max(96),
    }),
  }),
  z.object({
    GuildDeclareWar: z.object({
      opposing_guild_id: z.string().min(1).max(96),
    }),
  }),
  z.object({
    GuildAcceptWar: z.object({
      opposing_guild_id: z.string().min(1).max(96),
    }),
  }),
  z.object({
    GuildRescindWar: z.object({
      opposing_guild_id: z.string().min(1).max(96),
    }),
  }),
  z.object({
    GuildDisband: z.object({}).strict(),
  }),
  z.object({
    DuelChallenge: z.object({
      target_actor_id: z.string().min(1).max(96),
    }),
  }),
  z.object({
    DuelAccept: z.object({}).strict(),
  }),
  z.object({
    DuelDecline: z.object({}).strict(),
  }),
  z.object({
    DuelYield: z.object({}).strict(),
  }),
  z.object({
    Deathblow: z.object({
      target_actor_id: z.string().min(1).max(96),
    }),
  }),
  z.object({
    GeneSample: z.object({
      species: z.string().min(1).max(96),
    }),
  }),
  z.object({
    ScanGenome: z.object({
      container: z.string().min(1).max(128),
      stack_id: z.string().min(1).max(128),
      variant_id: z.number().int().nonnegative(),
    }),
  }),
  z.object({
    SpliceBegin: z.object({
      species: z.string().min(1).max(96),
    }),
  }),
  z.object({
    SpliceAssignSlot: z.object({
      slot_index: z.number().int().min(0).max(255),
      container: z.string().min(1).max(128),
      stack_id: z.string().min(1).max(128),
      variant_id: z.number().int().nonnegative(),
    }),
  }),
  z.object({
    SpliceClearSlot: z.object({
      slot_index: z.number().int().min(0).max(255),
    }),
  }),
  z.object({
    SpliceChooseAllele: z.object({
      locus: z.number().int().min(0).max(255),
      from_parent: z.number().int().min(0).max(1),
      allele: z.number().int().min(0).max(1),
    }),
  }),
  z.object({
    SpliceAssemble: z.object({}).strict(),
  }),
  z.object({
    SpliceExperimentLocus: z.object({
      locus: z.number().int().min(0).max(255),
      points: z.number().int().min(1).max(255),
    }),
  }),
  z.object({
    SpliceMint: z.object({
      cultivar_name: z.string().min(1).max(96).optional(),
    }),
  }),
  z.object({
    SpliceCancel: z.object({}).strict(),
  }),
  z.object({
    ClaimParcel: z.object({
      planet_id: z.string().min(1).max(128),
      area_id: z.string().min(1).max(128),
      x: z.number().int(),
      y: z.number().int(),
      tier: z.string().min(1).max(32),
    }).strict(),
  }),
  z.object({
    AbandonParcel: z.object({
      parcel_id: z.string().min(1).max(128),
    }).strict(),
  }),
  z.object({
    RenameParcel: z.object({
      parcel_id: z.string().min(1).max(128),
      name: z.string().min(1).max(64),
    }).strict(),
  }),
  z.object({
    PayUpkeep: z.object({
      parcel_id: z.string().min(1).max(128),
    }).strict(),
  }),
  z.object({
    TillTile: z.object({
      parcel_id: z.string().min(1).max(128),
      cell_x: z.number().int(),
      cell_y: z.number().int(),
    }).strict(),
  }),
  z.object({
    PlantSeed: z.object({
      parcel_id: z.string().min(1).max(128),
      cell_x: z.number().int(),
      cell_y: z.number().int(),
      container: z.string().min(1).max(128),
      stack_id: z.string().min(1).max(128),
      variant_id: z.number().int().nonnegative(),
    }).strict(),
  }),
  z.object({
    ClearTile: z.object({
      parcel_id: z.string().min(1).max(128),
      cell_x: z.number().int(),
      cell_y: z.number().int(),
    }).strict(),
  }),
  z.object({
    WaterTile: z.object({
      parcel_id: z.string().min(1).max(128),
      cell_x: z.number().int(),
      cell_y: z.number().int(),
    }).strict(),
  }),
  z.object({
    TendPlot: z.object({
      parcel_id: z.string().min(1).max(128),
      stop: z.boolean().optional(),
    }).strict(),
  }),
  z.object({
    PlaceFarmStructure: z.object({
      parcel_id: z.string().min(1).max(128),
      structure_item_id: z.number().int().nonnegative(),
      cell_x: z.number().int(),
      cell_y: z.number().int(),
    }).strict(),
  }),
  z.object({
    RemoveFarmStructure: z.object({
      parcel_id: z.string().min(1).max(128),
      structure_id: z.string().min(1).max(128),
    }).strict(),
  }),
  z.object({
    Fertilize: z.object({
      parcel_id: z.string().min(1).max(128),
      cell_x: z.number().int(),
      cell_y: z.number().int(),
      container: z.string().min(1).max(128),
      stack_id: z.string().min(1).max(128),
      variant_id: z.number().int().nonnegative(),
    }).strict(),
  }),
  z.object({
    BuildPlace: z.object({
      catalog_id: z.string().min(1).max(64),
      parcel_id: z.string().min(1).max(128),
      cell_x: z.number().int(),
      cell_y: z.number().int(),
      rotation_quarters: z.number().int().min(0).max(3),
      palette: z.object({
        primary: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
        secondary: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
        accent: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
      }).strict().optional(),
    }).strict(),
  }),
  z.object({
    BuildRemove: z.object({ component_id: z.string().min(1).max(128) }).strict(),
  }),
  z.object({
    BuildToggleDoor: z.object({ component_id: z.string().min(1).max(128) }).strict(),
  }),
  z.object({
    HarvestCrop: z.object({
      parcel_id: z.string().min(1).max(128),
      cell_x: z.number().int(),
      cell_y: z.number().int(),
    }).strict(),
  }),
]);

export const clientCommandSchema = exactClientCommandEnvelopeSchema.pipe(rawClientCommandSchema);

export const clientCommandEnvelopeSchema = z.object({
  session: z.number().int().nonnegative(),
  player: z.number().int().nonnegative(),
  command_id: z.number().int().positive(),
  issued_at_tick: z.number().int().nonnegative(),
  command: clientCommandSchema,
});

export const gameClientPacketSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("game.command"),
    envelope: clientCommandEnvelopeSchema,
  }),
  z.object({
    type: z.literal("game.view"),
    view: gameClientViewSchema,
  }),
  z.object({
    type: z.literal("exit_world"),
  }),
  z.object({
    type: z.literal("ping"),
    requestId: z.string().min(1).max(64).optional(),
    at: z.number().finite().optional(),
  }),
]);

export type CardinalDirection = z.infer<typeof cardinalDirectionSchema>;
export type ClientCommand = z.infer<typeof clientCommandSchema>;
export type ClientCommandEnvelope = z.infer<typeof clientCommandEnvelopeSchema>;
export type GameClientPacket = z.infer<typeof gameClientPacketSchema>;
export type GameClientView = z.infer<typeof gameClientViewSchema>;

export interface GameActorVitals {
  health: number;
  action: number;
  spirit: number;
}

export interface GameActorBleed {
  active: boolean;
  stackCount: number;
  severity: number;
  remainingMs: number;
  ratesPerSecond: GameActorVitals;
}

export type GameActorLifeState = "alive" | "downed" | "respawning";

export interface GameActorStatusSnapshot {
  id: string;
  label: string;
  severity: number;
  remainingMs: number;
  stacks?: number;
  threshold?: number;
}

export type GameCombatLifecycleKind = "hit" | "downed" | "killed";
export type GameCombatActionId = z.infer<typeof combatActionIdSchema>;

export interface GameActorCombatQueueSnapshot {
  nextReadyTick: number;
  entries: Array<{
    actionId: GameCombatActionId;
    targetActorId: string;
    auto?: boolean;
  }>;
}
export type AbilityQueueEntryClass = "combat" | "posture" | "utility";
export type AbilityQueueLifecycle = "enqueued" | "pending" | "fired" | "dismissed";

export interface AbilityQueueEntryVM {
  id: string;
  abilityId: string;
  iconId: string;
  class: AbilityQueueEntryClass;
  targetActorId?: string;
  lifecycle: AbilityQueueLifecycle;
  enqueuedAtTick: number;
  readyTick?: number;
  firedAtTick?: number;
  dismissedAtTick?: number;
  reasonCode?: string;
  fireSeq?: number;
}

export interface AbilityQueueView {
  actorId: string;
  nextReadyTick: number;
  entries: AbilityQueueEntryVM[];
  repeatIntent?: AbilityQueueEntryVM;
}

export interface AbilityQueueEvent {
  id: string;
  lifecycle: AbilityQueueLifecycle;
  tick: number;
  reasonCode?: string;
  fireSeq?: number;
  abilityId?: string;
  iconId?: string;
}



export interface GameActorProfessionSnapshot {
  id: string;
  label: string;
  xp: number;
  trackXp?: Record<string, number>;
  skillPoints: number;
  skillBoxes?: string[];
}

export interface GameActorProfessionTitleSnapshot {
  id: string;
  label: string;
  skillBoxId: string;
}

export interface GameActorPersonalShieldSnapshot {
  chargeMilli: number;
  maxChargeMilli: number;
  durabilityMilli?: number;
  maxDurabilityMilli?: number;
  durabilityCharges: number;
  maxDurabilityCharges: number;
  rechargeAvailableTick: number;
  rechargeBlocked: boolean;
  lastDamageTick?: number | null;
  lastBlockTick?: number | null;
}

export interface GameActorWeaponSnapshot {
  weaponId: string;
  weaponItemId?: number;
  weaponVariantId?: number;
  ammoType: string;
  loadedRounds: number;
  magazineSize: number;
  reloadUntilTick: number;
  reloadRemainingTicks: number;
  reloadTotalTicks: number;
}

export type GameActorPosture = "standing" | "kneeling_down" | "kneeling" | "standing_up";
export type GameActorAiAttitude = "passive" | "alerted" | "hostile";

/** Face-kit feature selection on the wire (snake_case like hair_mat).
 * null = blank legacy face; style/color validity is enforced at creation
 * (characterStore + face.gen registry), the wire only carries the shape. */
export interface GameActorFaceSnapshot {
  eyes: string;
  brows: string;
  nose: string;
  mouth: string;
  eye_color: string;
  brow_color: string;
  lip_color: string;
}

export interface GameActorAppearanceSnapshot {
  skin: string;
  hair: string | null;
  hair_mat: string;
  /** Absent on older payloads; null = blank legacy face. */
  face?: GameActorFaceSnapshot | null;
}

/** One worn wardrobe piece: pack equipment id + player zone colors
 * (index-aligned with the piece's manifest palette zones; short arrays fall
 * back to zone defaults). Creator-set, server-validated, cosmetic-only. */
export interface GameActorWornPiece {
  item: string;
  colors: string[];
}



export interface GameActorSnapshot {
  id: string;
  label: string;
  /** Durable creator palette cache, including currently unequipped clothing. */
  wornColors?: Record<string, string[]>;
  display_name: string;
  /** actor descriptor (lowercase-article, e.g. "a rogue drifter"). Empty for players. */
  descriptor?: string;
  link_dead: boolean;
  appearance: GameActorAppearanceSnapshot;
  /** Worn wardrobe set (players only; shard-owned, never sourced from Rust). */
  worn?: GameActorWornPiece[];
  role?: string | null;
  sprite?: string | null;
  areaId: string;
  x: number;
  y: number;
  direction: "front" | "right" | "back" | "left";
  posture: GameActorPosture;
  postureUntilTick: number;
  lifeState: GameActorLifeState;
  lifecycleSeq: number;
  vitals: GameActorVitals;
  maxVitals: GameActorVitals;
  bleed: GameActorBleed;
  statuses: GameActorStatusSnapshot[];
  personalShield?: GameActorPersonalShieldSnapshot | null;
  weapon?: GameActorWeaponSnapshot | null;
  mobility?: GameActorMobilitySnapshot;
  stats?: GameActorStatsSnapshot;
  professions?: GameActorProfessionSnapshot[];
  activeTitle?: GameActorProfessionTitleSnapshot | null;
  careerGoalId?: string | null;
  skillPointsUsed?: number;
  skillPointsCap?: number;
  credits?: number;
  shotSpreadDegreesMilli?: number;
  bodyVanishAtTick?: number;
  bodyVanishTick?: number;
  lootable?: boolean;
  hasLoot?: boolean;
  lootRightsActorId?: string | null;
  respawnAtTick?: number;
  nextSampleTick?: number;
  cloneSicknessRemainingMs?: number;
  incapRemainingMs?: number;
  incapCount?: number;
  incapWindowMs?: number;
  factionId?: string | null;
  socialGroup?: string | null;
  pvpStatus?: "none" | "covert" | "overt";
  aiAttitude?: GameActorAiAttitude;
  /** Threat legibility: will this actor auto-aggro (red) vs provoked-only (yellow). */
  willAutoAggro?: boolean;
  playerOrganizationId?: string | null;
  playerOrganizationTag?: string | null;
  combatQueue?: GameActorCombatQueueSnapshot;
  inCombat?: boolean;
  peaceRequested?: boolean;
  engagementTargetId?: string | null;
}

export interface GameActorMobilitySnapshot {
  sprintActionDrainMilli: number;
  sprintRecoveryLocked: boolean;
  sprintRegenBlockUntilTick: number;
  sprintRegenBlocked: boolean;
  sprintMoves: number;
  sprintTicks: number;
  sprintActionSpentMilli: number;
  sprintDistanceCells: number;
  tacticalSprintMoves: number;
  tacticalSprintTicks: number;
  tacticalSprintActionSpentMilli: number;
  tacticalSprintDistanceCells: number;
  lastSprintTick?: number | null;
  lastSprintReason?: string | null;
}

export interface GameActorStatsSnapshot {
  damageDone: number;
  damageTaken: number;
  kills: number;
  npcKills: number;
  playerKills: number;
  deaths: number;
  shotsFired: number;
  hitsDealt: number;
  hitsTaken: number;
  distanceMovedCells: number;
  lastDamageDealtTick?: number | null;
  lastDamageTakenTick?: number | null;
  lastKillTick?: number | null;
  lastDeath?: {
    tick: number;
    killerActorId: string;
    cause: string;
    weaponId: string;
    ammoType: string;
  } | null;
  recent10s: GameActorRecentStatsSnapshot;
  recent60s: GameActorRecentStatsSnapshot;
  longArc?: GameActorLongArcProfileSnapshot;
}

export interface GameActorRecentStatsSnapshot {
  windowSeconds: number;
  damageDone: number;
  damageTaken: number;
  kills: number;
  npcKills: number;
  playerKills: number;
  deaths: number;
  shotsFired: number;
  hitsDealt: number;
  hitsTaken: number;
  distanceMovedCells: number;
}

export interface GameActorLongArcProfileSnapshot {
  schema: "successor.actor-long-arc-profile.v1";
  sample: "authority_lifetime";
  combat: {
    hitRate: number;
    killDeathRatio: number;
    damageTradeRatio: number;
    damagePerShot: number;
    damagePerHit: number;
    damageTakenPerDeath: number;
    netDamage: number;
  };
  mobility: {
    distanceMovedCells: number;
    damageDonePerCell: number;
    damageTakenPerCell: number;
    cellsPerDeath: number;
  };
  recent: {
    pressureScore: number;
    damageDone10s: number;
    damageTaken10s: number;
    damageDone60s: number;
    damageTaken60s: number;
    kills60s: number;
    deaths60s: number;
    shots60s: number;
    hits60s: number;
    moved60s: number;
  };
  engagement: {
    lastDamageDealtTick: number | null;
    lastDamageTakenTick: number | null;
    lastKillTick: number | null;
    lastDeathCause: string | null;
    lastDeathKillerActorId: string | null;
  };
}

export interface GameActorPatch {
  id: string;
  label?: string;
  display_name?: string;
  descriptor?: string;
  link_dead?: boolean;
  appearance?: GameActorAppearanceSnapshot;
  worn?: GameActorWornPiece[];
  sprite?: string | null;
  role?: string | null;
  areaId?: string;
  x?: number;
  y?: number;
  direction?: "front" | "right" | "back" | "left";
  posture?: GameActorPosture;
  postureUntilTick?: number;
  lifeState?: GameActorLifeState;
  lifecycleSeq?: number;
  vitals?: GameActorVitals;
  maxVitals?: GameActorVitals;
  bleed?: GameActorBleed;
  statuses?: GameActorStatusSnapshot[];
  personalShield?: GameActorSnapshot["personalShield"];
  weapon?: GameActorSnapshot["weapon"];
  mobility?: GameActorMobilitySnapshot;
  professions?: GameActorProfessionSnapshot[];
  activeTitle?: GameActorProfessionTitleSnapshot | null;
  skillPointsUsed?: number;
  skillPointsCap?: number;
  credits?: number;
  shotSpreadDegreesMilli?: number;
  bodyVanishAtTick?: number;
  bodyVanishTick?: number | null;
  lootable?: boolean | null;
  hasLoot?: boolean | null;
  lootRightsActorId?: string | null;
  respawnAtTick?: number;
  nextSampleTick?: number | null;
  cloneSicknessRemainingMs?: number;
  incapRemainingMs?: number | null;
  incapCount?: number | null;
  incapWindowMs?: number | null;
  factionId?: string | null;
  socialGroup?: string | null;
  pvpStatus?: "none" | "covert" | "overt";
  aiAttitude?: GameActorAiAttitude | null;
  willAutoAggro?: boolean;
  playerOrganizationId?: string | null;
  playerOrganizationTag?: string | null;
  combatQueue?: GameActorCombatQueueSnapshot | null;
  inCombat?: boolean;
  peaceRequested?: boolean;
  engagementTargetId?: string | null;
}

export type GameCompactVitals = [health: number, action: number, spirit: number];

export type GameCompactBleed = [
  active: 0 | 1,
  stackCount: number,
  severity: number,
  remainingMs: number,
  healthRate: number,
  actionRate: number,
  spiritRate: number,
];

export type GameCompactDirection = 0 | 1 | 2 | 3;
export type GameCompactLifeState = 0 | 1 | 2;

export type GameActorNetRef = [netId: number, actorId: string];
export type GameCompactActorMove = [
  netId: number,
  qx: number,
  qy: number,
  direction: GameCompactDirection,
];

export type GameCompactActorSnapshot = [
  id: string,
  label: string,
  areaId: string,
  x: number,
  y: number,
  direction: GameCompactDirection,
  lifeState: GameCompactLifeState,
  lifecycleSeq: number,
  vitals: GameCompactVitals,
  maxVitals: GameCompactVitals,
  bleed: GameCompactBleed,
  statuses: GameActorStatusSnapshot[],
  factionId: string | null,
  socialGroup: string | null,
  pvpStatus: "none" | "covert" | "overt",
  bodyVanishAtTick?: number,
  respawnAtTick?: number,
  professions?: GameActorProfessionSnapshot[],
  activeTitle?: GameActorProfessionTitleSnapshot | null,
  skillPointsUsed?: number,
  skillPointsCap?: number,
  credits?: number,
  personalShield?: GameActorPersonalShieldSnapshot | null,
  sprite?: string | null,
  role?: string | null,
  playerOrganizationId?: string | null,
  playerOrganizationTag?: string | null,
  weapon?: GameActorWeaponSnapshot | null,
  shotSpreadDegreesMilli?: number,
  posture?: GameActorPosture,
  postureUntilTick?: number,
  combatQueue?: GameActorCombatQueueSnapshot | null,
  inCombat?: 0 | 1,
  cloneSicknessRemainingMs?: number,
  peaceRequested?: 0 | 1,
  aiAttitude?: GameActorAiAttitude | null,
  engagementTargetId?: string | null,
  lootable?: 0 | 1,
  hasLoot?: 0 | 1,
  lootRightsActorId?: string | null,
  bodyVanishTick?: number,
  incapRemainingMs?: number,
  incapCount?: number,
  incapWindowMs?: number,
  displayName?: string,
  linkDead?: 0 | 1,
  appearance?: GameActorAppearanceSnapshot,
  nextSampleTick?: number,
  worn?: GameActorWornPiece[],
  willAutoAggro?: 0 | 1,
  descriptor?: string,
  sprintRecoveryLocked?: 0 | 1,
];

export type GameCompactActorPatch = [
  id: string,
  areaId: string | null,
  x: number | null,
  y: number | null,
  direction: GameCompactDirection | null,
  lifeState: GameCompactLifeState | null,
  lifecycleSeq: number | null,
  vitals: GameCompactVitals | null,
  maxVitals: GameCompactVitals | null,
  bleed: GameCompactBleed | null,
  statuses: GameActorStatusSnapshot[] | null,
  bodyVanishAtTick?: number | null,
  respawnAtTick?: number | null,
  professions?: GameActorProfessionSnapshot[] | null,
  activeTitle?: GameActorProfessionTitleSnapshot | null,
  skillPointsUsed?: number | null,
  skillPointsCap?: number | null,
  credits?: number | null,
  personalShield?: GameActorPersonalShieldSnapshot | null | false,
  label?: string | null,
  sprite?: string | null,
  role?: string | null,
  playerOrganizationId?: string | null | false,
  playerOrganizationTag?: string | null | false,
  weapon?: GameActorWeaponSnapshot | null | false,
  factionId?: string | null | false,
  socialGroup?: string | null | false,
  pvpStatus?: "none" | "covert" | "overt" | false,
  shotSpreadDegreesMilli?: number | null,
  posture?: GameActorPosture | null,
  postureUntilTick?: number | null,
  combatQueue?: GameActorCombatQueueSnapshot | null | false,
  inCombat?: 0 | 1 | null,
  cloneSicknessRemainingMs?: number | null,
  peaceRequested?: 0 | 1 | null,
  aiAttitude?: GameActorAiAttitude | null,
  engagementTargetId?: string | null | false,
  lootable?: 0 | 1 | null,
  hasLoot?: 0 | 1 | null,
  lootRightsActorId?: string | null | false,
  bodyVanishTick?: number | null,
  incapRemainingMs?: number | null,

  incapCount?: number | null,
  incapWindowMs?: number | null,
  displayName?: string | null,
  linkDead?: 0 | 1 | null,
  appearance?: GameActorAppearanceSnapshot | null,
  nextSampleTick?: number | null,
  worn?: GameActorWornPiece[] | null,
  willAutoAggro?: 0 | 1 | null,
  descriptor?: string | null,
  sprintRecoveryLocked?: 0 | 1 | null,
];

export interface GameInventoryRow {
  container: string;
  stackId: number;
  item: string;
  itemId: number;
  variantId: number;
  quantity: number;
  reserved: number;
  available: number;
  /** Rust-authoritative creator clothing state. */
  equipped?: boolean;
  /** Exact palette preserved by Rust across unequip/re-equip. */
  colors?: string[];
  /** Optional structured resource potency (1-1000); additive for older rows. */
  potency?: number;
  /** Optional structured resource purity (Rust chemical_purity, 1-1000); additive for older rows. */
  purity?: number;
  /** Additive stable string item id for non-Rust or metadata-heavy items. */
  itemKey?: string;
  /** Additive structured item metadata; travel tickets use metadata.travelTicket. */
  metadata?: Record<string, unknown>;
  /** Full Rust-authoritative resource stat block; absent for non-resources or invalid encodings. */
  resourceStats?: GameResourceStats;
}
export interface GameBankItemRow {
  container: string;
  stackId: string;
  item: string;
  itemId: number;
  variantId: number;
  quantity: number;
  reserved: number;
  available: number;
  itemKey?: string;
  metadata?: Record<string, unknown>;
  colors?: string[];
  equipped?: boolean;
}

export interface GameBankSnapshot {
  credits: number;
  items: GameBankItemRow[];
  backupPresent: boolean;
  backupSavedTick: number | null;
  backupSkillCount: number;
  backupCost: number;
}

export interface GamePlayerCorpseSnapshot {
  id: string;
  ownerLabel: string;
  areaId: string;
  cellX: number;
  cellY: number;
  x: number;
  y: number;
  expiryTick: number;
  hasItems: boolean;
  creditsPresent: boolean;
  creditsCount: number;
  isOwner: boolean;
  container: string;
}

export interface GameReservationRow {
  id: number;
  actor: string;
  purpose: string;
  from: string;
  item: string;
  quantity: number;
  expiresAtTick?: number | null;
}

export interface GameResourceStats {
  conductivity: number;
  malleability: number;
  shock_resistance: number;
  thermal_resistance: number;
  chemical_purity: number;
  density: number;
  tensile_strength: number;
  flexibility: number;
  potency: number;
  nutrition: number;
  stability: number;
  extraction_yield: number;
}

export interface PlacedExtractorVM {
  extractorId: string;
  ownerActorId?: string | null;
  areaId: string;
  cellX: number;
  cellY: number;
  mode: "idle" | "manual" | "battery";
  biome: "desert" | "forest";
  hopperPct: number;
  /** Rust-authoritative whole resource units currently eligible for collection. */
  collectableUnits: number;
  batteryPct: number;
  isOwner: boolean;
  familyLabel: string;
}

/**
 * One placed scout camp as streamed to sessions (car-6 camp wire; sibling of
 * PlacedExtractorVM). `ownerActorId` exists only shard-side for per-session
 * isOwner recompute and is stripped before send; `abandonSecondsRemaining`
 * (armed-teardown countdown) is redacted to the owning session.
 */
export interface PlacedCampVM {
  campId: string;
  ownerActorId?: string | null;
  areaId: string;
  cellX: number;
  cellY: number;
  isOwner: boolean;
  renderKind: string;
  abandonSecondsRemaining?: number | null;
}

export interface FarmRectVM {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * One claimed land parcel as streamed to sessions (DEF-9 farm-view forwarding;
 * placed-entity sibling of PlacedCampVM/PlacedExtractorVM). `ownerActorId` exists
 * only shard-side for per-session isOwner recompute and is stripped before send;
 * `upkeepDueInGameDays` is the OWNER's finance HUD hint only (redacted to strangers,
 * per Main's DEF-9 ruling). Boundary + tier + crop counts are world-visible.
 */
export interface ParcelVM {
  parcelId: string;
  ownerActorId?: string | null;
  planetId: string;
  areaId: string;
  name: string;
  rect: FarmRectVM;
  tier: string;
  buildZone: FarmRectVM;
  farmYard: FarmRectVM;
  isOwner: boolean;
  upkeepDueInGameDays?: number | null;
  tilledTiles: number;
  plantedTiles: number;
}

export interface FarmCropVM {
  seedItemId: number;
  seedVariantId: number;
  species: string;
  stage: number;
  stageCount: number;
  health: string;
  blight: string;
  timeToMatureGameDays?: number | null;
  qualitySoFarMilli: number;
  footprintW: number;
  footprintH: number;
  mature: boolean;
}

export interface FarmTileVM {
  cellX: number;
  cellY: number;
  tilled: boolean;
  moisturePct: number;
  crop?: FarmCropVM | null;
  legalVerbs: string[];
}

/**
 * One parcel's per-tile crop detail as streamed to sessions. Crop render state
 * (stage/species/mature/health) is world-visible; `legalVerbs` are blanked by the
 * shard for non-owners (a passer-by sees the crop, not its actions). `ownerActorId`
 * is stripped shard-side.
 */
export interface FarmPlotVM {
  parcelId: string;
  ownerActorId?: string | null;
  areaId: string;
  tiles: FarmTileVM[];
}

export interface GameBuildComponent {
  componentId: string;
  ownerActorId: string;
  areaId: string;
  parcelId: string;
  catalogId: string;
  kind: string;
  cellX: number;
  cellY: number;
  rotationQuarters: number;
  palette: { primary?: string; secondary?: string; accent?: string };
  doorOpen: boolean;
}

export interface GameInteriorRegion {
  interiorId: string;
  areaId: string;
  parcelId: string;
  cellKeys: string[];
  roofed: boolean;
  enclosed: boolean;
  doorComponentIds: string[];
}

export interface GameBuildingProjection {
  schema: "successor.authority-building.v1";
  tick: number;
  components: GameBuildComponent[];
  interiors: GameInteriorRegion[];
}

export interface GameResourceSpawn {
  spawnId: string;
  family: string;
  name: string;
  classLabel: string;
  variantId: number;
  stats: GameResourceStats;
  activeFromTick: number;
  activeUntilTick: number | null;
}

export interface GamePropState {
  cacheEmptied?: boolean;
  doorOpen?: boolean;
}

export interface GameSurveyResult {
  family: string;
  areaId: string;
  spawnId: string;
  spawnName: string;
  centerX: number;
  centerY: number;
  rangeCells: number;
  stepCells: number;
  cols: number;
  rows: number;
  concentrationMilli: number[];
  cooldownUntilTick: number;
  tick: number;
}

export interface GameCraftRecipeSummary {
  recipeId: string;
  name: string;
  category: string;
  outputItemId: number;
  outputPreviewVariantId: number;
  unlocked: boolean;
  requiredToolItemId: number;
  requiredProfession: string;
  handsCraftable: boolean;
  source: string;
  remainingUses?: number;
}

export interface GameCraftSlotSpec {
  slotIndex: number;
  symbol: string;
  resourceKindLabel: string;
  requiredItemId?: number | null;
  requiredFamily?: string | null;
  requirementKind?: "material_family" | "item" | string;
  requiredItemName?: string | null;
  requiredQty: number;
  craftRelevantStat: string;
}

export interface GameCraftRecipeDetail {
  recipeId: string;
  outputItemId: number;
  outputPreviewVariantId: number;
  slots: GameCraftSlotSpec[];
  statLines: Array<{ lineId: number; label: string; capEstimateMilli: number }>;
}

export interface GameCraftResourceOption {
  container: string;
  stackId: string;
  itemId: number;
  variantId: number;
  name: string;
  qtyAvailable: number;
  craftRelevantStatValue: number;
  recommended: boolean;
  stats: GameResourceStats;
}

export interface GameCraftSlotFill {
  slotIndex: number;
  symbol: string;
  resourceKindLabel: string;
  requiredQty: number;
  requiredItemId?: number | null;
  requiredFamily?: string | null;
  requirementKind?: "material_family" | "item" | string;
  requiredItemName?: string | null;
  eligible: GameCraftResourceOption[];
  assigned?: { container: string; stackId: string; variantId: number } | null;
}

export interface GameCraftSession {
  phase: string;
  recipeId?: string | null;
  recipes: GameCraftRecipeSummary[];
  detail?: GameCraftRecipeDetail | null;
  details?: GameCraftRecipeDetail[];
  slotScreen?: { recipeId: string; slots: GameCraftSlotFill[]; canAssemble: boolean } | null;
  assembled?: {
    recipeId: string;
    assemblyQualityMilli: number;
    experimentationPointsRemaining: number;
    lines: Array<{
      lineId: number;
      label: string;
      valueMilli: number;
      capMilli: number;
      canRaise: boolean;
      onePointSuccessMilli?: number;
      batchRiskPerExtraPointMilli?: number;
    }>;
    outputPreviewVariantId: number;
  } | null;
  tick: number;
}

// Bio-Engineer splice bench VM (mirrors AuthoritySpliceSessionSnapshot; DEF-6).
// Forwarded per-observer as a 'spliceSession' room message, craftSession pattern.
export interface GameSpliceSessionSlot {
  slotIndex: number;
  kind: string; // "parent" | "reagent"
  label: string;
  filled: boolean;
  itemId: number;
  variantId: number;
}

export interface GameSpliceSessionLine {
  locus: number;
  label: string;
  baseMilli: number;
  valueMilli: number;
  capMilli: number;
  canRaise: boolean;
}

export interface GameSpliceSession {
  phase: string; // "browse" | "slots" | "assembled"
  speciesId: number;
  speciesName: string;
  slots: GameSpliceSessionSlot[];
  lines: GameSpliceSessionLine[];
  assemblyQualityMilli: number;
  pointsTotal: number;
  pointsRemaining: number;
  canAssemble: boolean;
  tick: number;
}

// Genome scanner reveal VM (mirrors AuthorityGenomeScanSnapshot). a1/a2/heterozygous
// are present only at the tier the Sequencing track has earned.
export interface GameAgronomicProfile {
  growthDaysBase: number;
  waterNeedMilli: number;
  yieldBase: number;
  hardinessMilli: number;
  seasonAffinity: number;
  offSeasonPenaltyMilli: number;
  stormResistanceMilli: number;
  blightResistanceMilli: number;
  regrowthDays: number;
  tileFootprint: number;
  qualityPotentialMilli: number;
}

export interface GameGenomeScanLocus {
  locus: number;
  label: string;
  expressMilli: number;
  heterozygous?: boolean;
  a1?: number;
  a2?: number;
}

export interface GameGenomeScan {
  itemId: number;
  variantId: number;
  speciesName: string;
  cultivarName: string;
  tier: string; // "phenotype" | "hidden_presence" | "allele_values" | "full"
  fertile: boolean;
  profile: GameAgronomicProfile;
  loci: GameGenomeScanLocus[];
  mutationPotentialMilli?: number;
  generation?: number;
  breederId?: string;
  tick: number;
}

export interface GameTradeItemLine {
  itemId: number;
  variantId: number;
  name: string;
  quantity: number;
}

export interface GameTradeSide {
  actorId: string;
  items: GameTradeItemLine[];
  coin: number;
  locked: boolean;
  confirmed: boolean;
}

export interface GameTradeSession {
  proposalId: number;
  partnerActorId: string;
  mine: GameTradeSide;
  theirs: GameTradeSide;
  bothLocked: boolean;
  stage: "negotiating" | "confirm" | "executed" | "declined";
  closeReason?: "declined" | "range" | "death" | "link" | null;
  tick: number;
}

export interface GameTradeSessionDelivery {
  actorId: string;
  session: GameTradeSession;
}

export interface GameCraftResourceLock {
  itemId: number;
  variantId: number;
  quantity: number;
}

export interface GameDraftedSchematic {
  id: string;
  ownerActorId: string;
  recipeId: string;
  resourceLocks: GameCraftResourceLock[];
  outputItemId: number;
  outputVariantId: number;
  schematicItemVariantId: number;
  maxUses: number;
  remainingUses: number;
}

export interface GameGroupVitals {
  health: number;
  action: number;
  spirit: number;
}

export interface GameGroupMemberFrame {
  actorId: string;
  name: string;
  areaId: string;
  vitals: GameGroupVitals;
  maxVitals: GameGroupVitals;
  lifeState: GameActorLifeState;
  isLeader: boolean;
  linkDead: boolean;
}

export interface GameGroupSummary {
  groupId: number;
  leaderActorId: string;
  createdTick: number;
  memberActorIds: string[];
}

export interface GameGroupPendingInvite {
  inviterActorId: string;
  inviterName: string;
  issuedTick: number;
  expiresTick: number;
}

export interface GameGroupView {
  group?: GameGroupSummary | null;
  members: GameGroupMemberFrame[];
  pendingInvite?: GameGroupPendingInvite | null;
}

export interface GameDuelSummary {
  duelId: number;
  opponentActorId: string;
  opponentName: string;
  startedTick: number;
  expiresTick: number;
}

export interface GameDuelChallenge {
  otherActorId: string;
  otherName: string;
  issuedTick: number;
  expiresTick: number;
}

export interface GameDuelView {
  activeDuel?: GameDuelSummary | null;
  incomingChallenge?: GameDuelChallenge | null;
  outgoingChallenge?: GameDuelChallenge | null;
}

export type GameGuildPermission = "invite" | "kick" | "roles" | "war" | "disband";
export type GameGuildWarState = "outgoing" | "incoming" | "mutual";
export interface GameGuildWar {
  opposingGuildId: string;
  opposingName: string;
  opposingTag: string;
  state: GameGuildWarState;
  declaredTick: number;
}
export interface GameGuildSummary {
  id: string;
  name: string;
  tag: string;
  leaderActorId: string;
  createdTick: number;
  memberCount: number;
  wars: GameGuildWar[];
}
export interface GameGuildRosterEntry {
  actorId: string;
  name: string;
  role: "leader" | "officer" | "member";
  permissions: GameGuildPermission[];
  online: boolean;
  areaId: string | null;
  lastSeenTick: number;
}
export interface GameGuildPendingInvite {
  inviteId: string;
  guildId: string;
  guildName: string;
  guildTag: string;
  inviterActorId: string;
  inviterName: string;
  issuedTick: number;
  expiresTick: number;
}
export interface GameGuildDirectoryEntry {
  id: string;
  name: string;
  tag: string;
  memberCount: number;
}
export interface GameGuildView {
  guild?: GameGuildSummary | null;
  roster: GameGuildRosterEntry[];
  pendingInvites: GameGuildPendingInvite[];
  directory: GameGuildDirectoryEntry[];
}

export interface GameDuelOutcome {
  actorId: string;
  duelId: number;
  opponentActorId: string;
  opponentName: string;
  result: "won" | "lost" | "dissolved";
  reason: "yield" | "down" | "range" | "timeout" | "disconnect";
  tick: number;
}

export interface GameShardSnapshot {
  schema: "successor.authoritative-shard-snapshot.v1";
  shardId: string;
  tick: number;
  playerActorId: string;
  actors: Record<string, GameActorSnapshot>;
  inventory?: GameInventoryRow[];
  reservations?: GameReservationRow[];
  bank?: GameBankSnapshot | null;
  playerCorpses?: GamePlayerCorpseSnapshot[];
  resourceSpawns?: GameResourceSpawn[];
  placedExtractors?: PlacedExtractorVM[];
  placedCamps?: PlacedCampVM[];
  placedParcels?: ParcelVM[];
  farmPlots?: FarmPlotVM[];
  building?: GameBuildingProjection;
  draftedSchematics?: GameDraftedSchematic[];
  groups?: GameGroupView;
  duels?: GameDuelView;
  guilds?: GameGuildView;
  propStates?: Record<string, GamePropState>;
  actorRefs?: GameActorNetRef[];
  sourceStateHash?: string;
  sourceActorCount?: number;
  worldClock: WorldClockSnapshot;
  weather: GameWeatherSnapshot[];
  abilityQueue?: AbilityQueueView | null;
  abilityQueueEvents?: AbilityQueueEvent[];
  counters: {
    acceptedCommands: number;
    rejectedCommands: number;
    shotsFired: number;
    hits: number;
    deaths: number;
  };
}

export interface GameDialogueDelivery {
  actorId: string;
  speaker: string;
  body: string;
  areaId: string;
  x: number;
  y: number;
  tick: number;
}

export interface GameShardDelta {
  schema: "successor.authoritative-shard-delta.v1";
  shardId: string;
  tick: number;
  playerActorId: string;
  actors: Record<string, GameActorSnapshot>;
  actorPatches?: Record<string, GameActorPatch>;
  compactActors?: GameCompactActorSnapshot[];
  compactActorPatches?: GameCompactActorPatch[];
  compactActorMoves?: GameCompactActorMove[];
  actorRefs?: GameActorNetRef[];
  actorRemovals?: string[];
  inventory?: GameInventoryRow[];
  reservations?: GameReservationRow[];
  resourceSpawns?: GameResourceSpawn[];
  dialogueDeliveries?: GameDialogueDelivery[];
  bank?: GameBankSnapshot | null;
  playerCorpses?: GamePlayerCorpseSnapshot[];
  placedExtractors?: PlacedExtractorVM[];
  placedCamps?: PlacedCampVM[];
  placedParcels?: ParcelVM[];
  farmPlots?: FarmPlotVM[];
  building?: GameBuildingProjection;
  draftedSchematics?: GameDraftedSchematic[];
  groups?: GameGroupView;
  duels?: GameDuelView;
  guilds?: GameGuildView;
  propStates?: Record<string, GamePropState>;
  sourceStateHash?: string;
  sourceActorCount?: number;
  worldClock: WorldClockSnapshot;
  weather: GameWeatherSnapshot[];
  abilityQueue?: AbilityQueueView | null;
  abilityQueueEvents?: AbilityQueueEvent[];
  counters?: GameShardSnapshot["counters"];
}

export interface GameCommandReceipt {
  commandId: number;
  accepted: boolean;
  tick: number;
  reasonCode?: string;
}

export type GameCompactReceipt = [commandId: number, accepted: 0 | 1, tick: number, reasonCode?: string];

export type GamePlayerPositionAck = [x: number, y: number, appliedMoveCommandId: number];

export interface GameMovementProfileAck {
  walkSpeedMilliPerSecond: number;
  sprintSpeedMilliPerSecond: number;
}

export interface GameCombatEvent {
  kind?: "ranged_roll";
  id: number;
  commandId?: number | null;
  tick: number;
  shooterActorId: string;
  targetActorId: string;
  attackerActorId?: string;
  actionId?: GameCombatActionId;
  hit?: boolean;
  pool?: "health";
  rollMilli?: number;
  toHitMilli?: number;
  originPoint?: {
    x: number;
    y: number;
  };
  hitPoint?: {
    x: number;
    y: number;
  };
  damage: number;
  zone: "head" | "torso" | "left_arm" | "right_arm" | "legs";
  previousLifeState: GameActorLifeState;
  lifeState: GameActorLifeState;
  targetLifecycleSeq: number;
  bleedStackCount: number;
  weaponId?: z.infer<typeof weaponIdSchema>;
  ammoTypeId?: z.infer<typeof ammoTypeSchema>;
  effect?: {
    kind: "sleep";
    stacks: number;
    threshold: number;
    remainingMs: number;
  } | {
    kind: "dodge";
  } | {
    kind: "shield";
    stacks: number;
    threshold: number;
    remainingMs: number;
  };
  lifecycle: {
    kind: GameCombatLifecycleKind;
    from: GameActorLifeState;
    to: GameActorLifeState;
    cause: string;
  };
}

export type GameCompactCombatEvent = [
  id: number,
  commandId: number | null,
  tick: number,
  shooterActorId: string,
  targetActorId: string,
  hitX: number | null,
  hitY: number | null,
  damage: number,
  zone: "head" | "torso" | "left_arm" | "right_arm" | "legs",
  previousLifeState: GameActorLifeState,
  lifeState: GameActorLifeState,
  targetLifecycleSeq: number,
  bleedStackCount: number,
  lifecycleKind: GameCombatLifecycleKind | null,
  lifecycleFrom: GameActorLifeState | null,
  lifecycleTo: GameActorLifeState | null,
  lifecycleCause: string | null,
  weaponId: z.infer<typeof weaponIdSchema> | null,
  ammoTypeId: z.infer<typeof ammoTypeSchema> | null,
  effectKind: "sleep" | "dodge" | "shield" | null,
  effectStacks: number | null,
  effectThreshold: number | null,
  effectRemainingMs: number | null,
  originX?: number | null,
  originY?: number | null,
  kind?: "ranged_roll" | null,
  attackerActorId?: string | null,
  actionId?: GameCombatActionId | null,
  hit?: 0 | 1 | null,
  pool?: "health" | null,
  rollMilli?: number | null,
  toHitMilli?: number | null,
];

export type GameServerPacket =
  | {
      type: "game.hello";
      sessionId: string;
      playerActorId: string;
      snapshot: GameShardSnapshot;
      serverTime: string;
    }
  | {
      type: "game.snapshot";
      snapshot: GameShardSnapshot;
      receipts: GameCommandReceipt[];
      events: GameCombatEvent[];
      compactEvents?: GameCompactCombatEvent[];
      abilityQueue?: AbilityQueueView | null;
      abilityQueueEvents?: AbilityQueueEvent[];
    }
  | {
      type: "game.delta";
      delta: GameShardDelta;
      receipts: GameCommandReceipt[];
      events: GameCombatEvent[];
      compactEvents?: GameCompactCombatEvent[];
      abilityQueue?: AbilityQueueView | null;
      abilityQueueEvents?: AbilityQueueEvent[];
    }
  | {
      type: "game.receipts";
      receipts: GameCommandReceipt[];
      events: GameCombatEvent[];
      compactEvents?: GameCompactCombatEvent[];
      abilityQueue?: AbilityQueueView | null;
      abilityQueueEvents?: AbilityQueueEvent[];
    }
  | {
      type: "game.acks";
      acks: GameCompactReceipt[];
      playerActor?: GameActorSnapshot;
      playerPosition?: GamePlayerPositionAck;
      movementProfile?: GameMovementProfileAck;
      events?: GameCombatEvent[];
      compactEvents?: GameCompactCombatEvent[];
      abilityQueue?: AbilityQueueView | null;
      abilityQueueEvents?: AbilityQueueEvent[];
    }
  | {
      type: "game.error";
      code: string;
      message: string;
    }
  | {
      type: "pong";
      requestId?: string;
      at: number;
    };
