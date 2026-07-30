import { cardinalDirectionForVisualDirection, type Direction } from "./geometry";
import type { AmmoTypeId } from "./ammoSystem";
import type { WeaponId } from "./weaponSystem";

export type AuthorityCardinalDirection = "Front" | "Right" | "Back" | "Left";
export interface AuthorityMovePayload {
  dx: number;
  dy: number;
  duration_ticks: number;
  facing?: AuthorityCardinalDirection;
  sprint?: boolean;
}
export interface AuthorityMoveIntentPayload {
  dx: number;
  dy: number;
  facing?: AuthorityCardinalDirection;
  sprint?: boolean;
}

export type AuthorityClientCommand =
  | { Move: AuthorityMovePayload }
  | { SetMoveIntent: AuthorityMoveIntentPayload }
  | { ReloadWeapon: { ammo_type?: AmmoTypeId; weapon_id?: WeaponId } }
  | { SetEquippedWeapon: { weapon_id?: WeaponId | null; weapon_item_id?: number; weapon_variant_id?: number } }
  | { SetEquippedClothing: { item_id: number; equipped: boolean; container?: string; stack_id?: string; variant_id?: number } }
  | { EnterTransition: { transition_id: string } }
  | { UseConsumable: { item_id: string; item_numeric_id?: number; variant_id?: number } }
  | { RefillAmmo: { item_id: string } }
  | { ApplyServiceBuff: { effect_id: string } }
  | { CloneRespawn: { facility_id?: string } }
  | { ReviveActor: { target_actor_id: string } }
  | { SampleResource: { family: string; stop?: boolean } }
  | { SurveyResource: { family: string } }
  | { PlaceExtractor: { family: string } }
  | { CrankExtractor: { extractor_id: string } }
  | { StopCrank: Record<string, never> }
  | { InsertBattery: { extractor_id: string; container: string; stack_id: string; variant_id: number } }
  | { CollectExtractor: { extractor_id: string } }
  | { DestroyExtractor: { extractor_id: string } }
  | { PlaceCamp: Record<string, never> }
  | { PackUpCamp: Record<string, never> }
  | { HarvestCorpse: { target_actor_id: string } }
  | { BankStoreItem: { source_stack_id: string; quantity: number } }
  | { BankRetrieveItem: { bank_stack_id: string; quantity: number } }
  | { BankDepositCredits: { amount: number } }
  | { BankWithdrawCredits: { amount: number } }
  | { CloneSaveSkillBackup: Record<string, never> }
  | { CorpseTakeCredits: { corpse_id: string } }
  | { TakeLootItem: { container: string; itemId: number; variantId: number; quantity: number } }
  | { PurchaseTravelTicket: { terminal_prop_id: string; to_planet_id: string; to_city_id: string } }
  | { UseTravelTicket: { container?: string; stack_id?: string; ticket_id?: string; item_id?: "travel_ticket"; item_numeric_id?: number; variant_id?: number } }
  | { ToggleDoor: { prop_id: string } }
  | { CraftItem: { schematic_id: string; experiment_power: number; experiment_handling: number; experiment_reliability: number } }
  | { CraftBegin: { recipe_id: string } }
  | { CraftAssignSlot: { slot_index: number; container: string; stack_id: string; variant_id: number } }
  | { CraftClearSlot: { slot_index: number } }
  | { CraftAssemble: Record<string, never> }
  | { CraftExperiment: { line_id: number; points: number } }
  | { CraftFinalizePrototype: { custom_name: string } }
  | { CraftFinalizePractice: Record<string, never> }
  | { CraftDraftSchematic: { max_uses: number } }
  | { FactoryManufacture: { factory_id: string; schematic_id: string } }
  | { CraftCancel: Record<string, never> }
  | { RequestStarterTool: { trainer_actor_id: string } }
  | { PurchaseSkillBox: { skill_box_id: string; trainer_actor_id: string } }
  | { UnlearnSkillBox: { skill_box_id: string; trainer_actor_id: string } }
  | { SetProfessionTitle: { title_id?: string | null } }
  | { SetCareerGoal: { goal_id: string; trainer_actor_id: string } }
  | { SetPosture: { posture: "kneel" | "stand" } }
  | { StoreToExchange: { item_id: number; variant_id: number; quantity: number } }
  | { RetrieveFromExchange: { item_id: number; variant_id: number; quantity: number } }
  | { SplitStack: { container: string; stack_id: string; item_id: number; variant_id: number; quantity: number } }
  | { MergeStacks: { container: string; source_stack_id: string; target_stack_id: string } }
  | { RedeemCreditChip: { container: string; stack_id: string } }
  | { DiscardStack: { container: string; stack_id: string; item_id: number; variant_id: number } }
  | { QueueCombatAction: { action_id: string; target_actor_id: string } }
  | { Peace: Record<string, never> }
  | { CancelAbilityQueue: { queue_entry_id?: string; scope?: "owner_repeat" | "combat" | "posture" | "all" } }
  | { ProposeTrade: { partner_actor_id: string; offer: ExchangeTradeItem[]; request: ExchangeTradeItem[] } }
  | { AcceptTrade: { proposal_id: number } }
  | { DeclineTrade: { proposal_id: number } }
  | { AddTradeItem: { proposal_id: number; item: ExchangeTradeItem } }
  | { RemoveTradeItem: { proposal_id: number; item: ExchangeTradeItem } }
  | { SetTradeCoin: { proposal_id: number; amount: number } }
  | { ConfirmTrade: { proposal_id: number } }
  | { GroupInvite: { target_actor_id: string } }
  | { GroupAccept: Record<string, never> }
  | { GroupDecline: Record<string, never> }
  | { GroupLeave: Record<string, never> }
  | { GroupDisband: Record<string, never> }
  | { GroupKick: { target_actor_id: string } }
  | { GuildCreate: { name: string; tag: string; terminal_prop_id: string } }
  | { GuildInvite: { target_actor_id: string } }
  | { GuildAcceptInvite: { invite_id: string } }
  | { GuildDeclineInvite: { invite_id: string } }
  | { GuildLeave: Record<string, never> }
  | { GuildKick: { target_actor_id: string } }
  | { GuildSetRole: { target_actor_id: string; role: "leader" | "officer" | "member" } }
  | { GuildSetPermissions: { target_actor_id: string; permissions: number } }
  | { GuildTransferLeadership: { target_actor_id: string } }
  | { GuildDeclareWar: { opposing_guild_id: string } }
  | { GuildAcceptWar: { opposing_guild_id: string } }
  | { GuildRescindWar: { opposing_guild_id: string } }
  | { GuildDisband: Record<string, never> }
  | { DuelChallenge: { target_actor_id: string } }
  | { DuelAccept: Record<string, never> }
  | { DuelDecline: Record<string, never> }
  | { DuelYield: Record<string, never> }
  | { Deathblow: { target_actor_id: string } }
  | { GeneSample: { species: string } }
  | { ScanGenome: { container: string; stack_id: string; variant_id: number } }
  | { SpliceBegin: { species: string } }
  | { SpliceAssignSlot: { slot_index: number; container: string; stack_id: string; variant_id: number } }
  | { SpliceClearSlot: { slot_index: number } }
  | { SpliceChooseAllele: { locus: number; from_parent: number; allele: number } }
  | { SpliceAssemble: Record<string, never> }
  | { SpliceExperimentLocus: { locus: number; points: number } }
  | { SpliceMint: { cultivar_name?: string } }
  | { SpliceCancel: Record<string, never> }
  | { ClaimParcel: { planet_id: string; area_id: string; x: number; y: number; tier: string } }
  | { AbandonParcel: { parcel_id: string } }
  | { RenameParcel: { parcel_id: string; name: string } }
  | { PayUpkeep: { parcel_id: string } }
  | { TillTile: { parcel_id: string; cell_x: number; cell_y: number } }
  | { PlantSeed: { parcel_id: string; cell_x: number; cell_y: number; container: string; stack_id: string; variant_id: number } }
  | { ClearTile: { parcel_id: string; cell_x: number; cell_y: number } }
  | { WaterTile: { parcel_id: string; cell_x: number; cell_y: number } }
  | { TendPlot: { parcel_id: string; stop?: boolean } }
  | { PlaceFarmStructure: { parcel_id: string; structure_item_id: number; cell_x: number; cell_y: number } }
  | { RemoveFarmStructure: { parcel_id: string; structure_id: string } }
  | { Fertilize: { parcel_id: string; cell_x: number; cell_y: number; container: string; stack_id: string; variant_id: number } }
  | { HarvestCrop: { parcel_id: string; cell_x: number; cell_y: number } }
  | { BuildPlace: { catalog_id: string; parcel_id: string; cell_x: number; cell_y: number; rotation_quarters: number; palette?: { primary?: string; secondary?: string; accent?: string } } }
  | { BuildRemove: { component_id: string } }
  | { BuildToggleDoor: { component_id: string } };

export interface AuthorityClientCommandEnvelope {
  session: number;
  player: number;
  command_id: number;
  issued_at_tick: number;
  command: AuthorityClientCommand;
}

export interface AuthorityCommandQueue {
  schema: "successor.client-authority-command-queue.v1";
  session: number;
  player: number;
  nextCommandId: number;
  totalQueued: number;
  totalByKind: Record<AuthorityClientCommandKind, number>;
  /** Sent but not yet settled by an authoritative accepted/rejected receipt. */
  inFlight: AuthorityClientCommandEnvelope | null;
  pending: AuthorityClientCommandEnvelope[];
}

export interface AuthorityCommandQueueProbe {
  schema: AuthorityCommandQueue["schema"];
  session: number;
  player: number;
  nextCommandId: number;
  inFlight: AuthorityClientCommandEnvelope | null;
  pendingCount: number;
  totalQueued: number;
  totalByKind: Record<AuthorityClientCommandKind, number>;
  lastPending: AuthorityClientCommandEnvelope | null;
}

export type AuthorityClientCommandKind =
  | "Move"
  | "SetMoveIntent"
  | "ReloadWeapon"
  | "SetEquippedWeapon"
  | "SetEquippedClothing"
  | "EnterTransition"
  | "UseConsumable"
  | "RefillAmmo"
  | "ApplyServiceBuff"
  | "CloneRespawn"
  | "ReviveActor"
  | "SampleResource"
  | "SurveyResource"
  | "PlaceExtractor"
  | "CrankExtractor"
  | "StopCrank"
  | "InsertBattery"
  | "CollectExtractor"
  | "DestroyExtractor"
  | "PlaceCamp"
  | "PackUpCamp"
  | "HarvestCorpse"
  | "BankStoreItem"
  | "BankRetrieveItem"
  | "BankDepositCredits"
  | "BankWithdrawCredits"
  | "CloneSaveSkillBackup"
  | "CorpseTakeCredits"
  | "TakeLootItem"
  | "PurchaseTravelTicket"
  | "UseTravelTicket"
  | "ToggleDoor"
  | "CraftItem"
  | "CraftBegin"
  | "CraftAssignSlot"
  | "CraftClearSlot"
  | "CraftAssemble"
  | "CraftExperiment"
  | "CraftFinalizePractice"
  | "CraftFinalizePrototype"
  | "CraftDraftSchematic"
  | "FactoryManufacture"
  | "CraftCancel"
  | "RequestStarterTool"
  | "PurchaseSkillBox"
  | "UnlearnSkillBox"
  | "SetProfessionTitle"
  | "SetCareerGoal"
  | "SetPosture"
  | "StoreToExchange"
  | "RetrieveFromExchange"
  | "SplitStack"
  | "MergeStacks"
  | "DiscardStack"
  | "RedeemCreditChip"
  | "QueueCombatAction"
  | "Peace"
  | "CancelAbilityQueue"
  | "ProposeTrade"
  | "AcceptTrade"
  | "DeclineTrade"
  | "AddTradeItem"
  | "RemoveTradeItem"
  | "SetTradeCoin"
  | "ConfirmTrade"
  | "GroupInvite"
  | "GroupAccept"
  | "GroupDecline"
  | "GroupLeave"
  | "GroupDisband"
  | "GroupKick"
  | "GuildCreate"
  | "GuildInvite"
  | "GuildAcceptInvite"
  | "GuildDeclineInvite"
  | "GuildLeave"
  | "GuildKick"
  | "GuildSetRole"
  | "GuildSetPermissions"
  | "GuildTransferLeadership"
  | "GuildDeclareWar"
  | "GuildAcceptWar"
  | "GuildRescindWar"
  | "GuildDisband"
  | "DuelChallenge"
  | "DuelAccept"
  | "DuelDecline"
  | "DuelYield"
  | "Deathblow"
  | "GeneSample"
  | "ScanGenome"
  | "SpliceBegin"
  | "SpliceAssignSlot"
  | "SpliceClearSlot"
  | "SpliceChooseAllele"
  | "SpliceAssemble"
  | "SpliceExperimentLocus"
  | "SpliceMint"
  | "SpliceCancel"
  | "ClaimParcel"
  | "AbandonParcel"
  | "RenameParcel"
  | "PayUpkeep"
  | "TillTile"
  | "PlantSeed"
  | "ClearTile"
  | "WaterTile"
  | "TendPlot"
  | "PlaceFarmStructure"
  | "RemoveFarmStructure"
  | "Fertilize"
  | "HarvestCrop"
  | "BuildPlace"
  | "BuildRemove"
  | "BuildToggleDoor";

const maxMoveDurationTicks = 30;
const targetMoveCommandsPerSecond = 20;

let runtimeCommandQueueSequence = 0;

/**
 * Fresh command namespace for a real client process. Persisted authority state
 * retains dedupe keys, so reconnects must not restart at command 1. The
 * per-process suffix also separates clients created during the same millisecond.
 */
export function nextRuntimeAuthorityCommandIdFloor(nowMs = Date.now()): number {
  const safeMillis = Number.isFinite(nowMs)
    ? Math.max(1, Math.min(Math.trunc(nowMs), Math.floor(Number.MAX_SAFE_INTEGER / 1_000)))
    : 1;
  runtimeCommandQueueSequence = runtimeCommandQueueSequence >= 999
    ? 1
    : runtimeCommandQueueSequence + 1;
  return safeMillis * 1_000 + runtimeCommandQueueSequence;
}

export function createAuthorityCommandQueue(
  session = 1,
  player = 1,
  commandIdFloor = 1,
): AuthorityCommandQueue {
  const nextCommandId = Number.isSafeInteger(commandIdFloor) && commandIdFloor > 0
    ? Math.trunc(commandIdFloor)
    : 1;
  return {
    schema: "successor.client-authority-command-queue.v1",
    session,
    player,
    nextCommandId,
    totalQueued: 0,
    totalByKind: createEmptyAuthorityCommandKindCounts(),
    inFlight: null,
    pending: [],
  };
}

export function enqueueAuthorityCommand(
  queue: AuthorityCommandQueue,
  command: AuthorityClientCommand,
  issuedAtTick: number,
): AuthorityClientCommandEnvelope {
  const envelope = {
    session: queue.session,
    player: queue.player,
    command_id: queue.nextCommandId,
    issued_at_tick: Math.max(0, Math.trunc(issuedAtTick)),
    command,
  };
  queue.nextCommandId += 1;
  queue.totalQueued += 1;
  queue.totalByKind = { ...createEmptyAuthorityCommandKindCounts(), ...(queue.totalByKind ?? {}) };
  queue.totalByKind[authorityCommandKind(command)] += 1;
  queue.pending.push(envelope);
  return envelope;
}

export function clearAuthorityCommandQueue(queue: AuthorityCommandQueue | null | undefined): number {
  if (!queue) return 0;
  const dropped = queue.pending.length + (queue.inFlight ? 1 : 0);
  queue.inFlight = null;
  queue.pending.length = 0;
  return dropped;
}

/** Requeue an unsettled transmission at the pending head; flush still uses priority ordering. */
export function deferInFlightAuthorityCommand(queue: AuthorityCommandQueue | null | undefined): boolean {
  if (!queue?.inFlight) return false;
  const envelope = queue.inFlight;
  queue.inFlight = null;
  if (!queue.pending.some((pending) => pending.command_id === envelope.command_id)) {
    queue.pending.unshift(envelope);
  }
  return true;
}

/** Settle only the envelope named by an authoritative receipt. */
export function settleAuthorityCommand(queue: AuthorityCommandQueue | null | undefined, commandId: number): boolean {
  if (!queue) return false;
  if (queue.inFlight?.command_id === commandId) {
    queue.inFlight = null;
    return true;
  }
  const pendingIndex = queue.pending.findIndex((envelope) => envelope.command_id === commandId);
  if (pendingIndex < 0) return false;
  queue.pending.splice(pendingIndex, 1);
  return true;
}


export function enqueueAuthorityReloadWeaponCommand(
  queue: AuthorityCommandQueue,
  issuedAtTick: number,
  ammoTypeId?: AmmoTypeId,
  weaponId?: WeaponId,
): AuthorityClientCommandEnvelope {
  const reload: AuthorityClientCommand = {
    ReloadWeapon: {},
  };
  if (ammoTypeId) reload.ReloadWeapon.ammo_type = ammoTypeId;
  if (weaponId) reload.ReloadWeapon.weapon_id = weaponId;
  return enqueueAuthorityCommand(queue, reload, issuedAtTick);
}

export function enqueueAuthoritySetEquippedWeaponCommand(
  queue: AuthorityCommandQueue,
  issuedAtTick: number,
  weaponId: WeaponId | null,
  weaponItemId?: number,
  weaponVariantId?: number,
): AuthorityClientCommandEnvelope {
  const payload: { weapon_id?: WeaponId | null; weapon_item_id?: number; weapon_variant_id?: number } = {
    weapon_id: weaponId,
  };
  if (weaponItemId !== undefined) payload.weapon_item_id = Math.max(0, Math.trunc(weaponItemId));
  if (weaponVariantId !== undefined) payload.weapon_variant_id = Math.max(0, Math.trunc(weaponVariantId));
  return enqueueAuthorityCommand(queue, { SetEquippedWeapon: payload }, issuedAtTick);
}

export function enqueueAuthoritySetEquippedClothingCommand(
  queue: AuthorityCommandQueue,
  issuedAtTick: number,
  itemId: number,
  equipped: boolean,
  stackId?: string,
  variantId?: number,
  container?: string,
): AuthorityClientCommandEnvelope {
  const payload: Extract<AuthorityClientCommand, { SetEquippedClothing: unknown }>["SetEquippedClothing"] = {
    item_id: Math.max(0, Math.trunc(itemId)),
    equipped,
  };
  if (container !== undefined && container.trim().length > 0) payload.container = container;
  if (stackId !== undefined && stackId.trim().length > 0) payload.stack_id = stackId;
  if (variantId !== undefined) payload.variant_id = Math.max(0, Math.trunc(variantId));
  return enqueueAuthorityCommand(queue, { SetEquippedClothing: payload }, issuedAtTick);
}


export function enqueueAuthorityMoveCommand(
  queue: AuthorityCommandQueue,
  dx: number,
  dy: number,
  durationTicks: number,
  issuedAtTick: number,
  sprint = false,
): AuthorityClientCommandEnvelope | null {
  const move = authorityMoveCommand(dx, dy, durationTicks, sprint);
  return move ? enqueueAuthorityCommand(queue, move, issuedAtTick) : null;
}

export function enqueueAuthorityMoveIntentCommand(
  queue: AuthorityCommandQueue,
  dx: number,
  dy: number,
  issuedAtTick: number,
  facing?: AuthorityCardinalDirection,
  sprint = false,
): AuthorityClientCommandEnvelope | null {
  const intent = authorityMoveIntentCommand(dx, dy, facing, sprint);
  return intent ? enqueueAuthorityCommand(queue, intent, issuedAtTick) : null;
}

export function enqueueAuthorityTransitionCommand(
  queue: AuthorityCommandQueue,
  transitionId: string,
  issuedAtTick: number,
): AuthorityClientCommandEnvelope | null {
  const id = transitionId.trim();
  if (!id) return null;
  return enqueueAuthorityCommand(queue, {
    EnterTransition: {
      transition_id: id,
    },
  }, issuedAtTick);
}

export function enqueueAuthorityUseConsumableCommand(
  queue: AuthorityCommandQueue,
  itemId: string,
  issuedAtTick: number,
  itemNumericId?: number,
  variantId?: number,
): AuthorityClientCommandEnvelope | null {
  const id = itemId.trim();
  if (!id) return null;
  const command: AuthorityClientCommand = {
    UseConsumable: {
      item_id: id,
    },
  };
  if (itemNumericId !== undefined) {
    if (!Number.isInteger(itemNumericId) || itemNumericId < 0) return null;
    command.UseConsumable.item_numeric_id = itemNumericId;
  }
  if (variantId !== undefined) {
    if (!Number.isInteger(variantId) || variantId < 0) return null;
    command.UseConsumable.variant_id = variantId;
  }
  return enqueueAuthorityCommand(queue, command, issuedAtTick);
}

export function enqueueAuthorityBankStoreItemCommand(
  queue: AuthorityCommandQueue,
  sourceStackId: string,
  quantity: number,
  issuedAtTick: number,
): AuthorityClientCommandEnvelope | null {
  const stackId = sourceStackId.trim();
  if (!stackId || !Number.isSafeInteger(quantity) || quantity <= 0) return null;
  return enqueueAuthorityCommand(queue, {
    BankStoreItem: { source_stack_id: stackId, quantity },
  }, issuedAtTick);
}

export function enqueueAuthorityBankRetrieveItemCommand(
  queue: AuthorityCommandQueue,
  bankStackId: string,
  quantity: number,
  issuedAtTick: number,
): AuthorityClientCommandEnvelope | null {
  const stackId = bankStackId.trim();
  if (!stackId || !Number.isSafeInteger(quantity) || quantity <= 0) return null;
  return enqueueAuthorityCommand(queue, {
    BankRetrieveItem: { bank_stack_id: stackId, quantity },
  }, issuedAtTick);
}

export function enqueueAuthorityBankDepositCreditsCommand(
  queue: AuthorityCommandQueue,
  amount: number,
  issuedAtTick: number,
): AuthorityClientCommandEnvelope | null {
  if (!Number.isSafeInteger(amount) || amount <= 0) return null;
  return enqueueAuthorityCommand(queue, { BankDepositCredits: { amount } }, issuedAtTick);
}

export function enqueueAuthorityBankWithdrawCreditsCommand(
  queue: AuthorityCommandQueue,
  amount: number,
  issuedAtTick: number,
): AuthorityClientCommandEnvelope | null {
  if (!Number.isSafeInteger(amount) || amount <= 0) return null;
  return enqueueAuthorityCommand(queue, { BankWithdrawCredits: { amount } }, issuedAtTick);
}

export function enqueueAuthorityCloneSaveSkillBackupCommand(
  queue: AuthorityCommandQueue,
  issuedAtTick: number,
): AuthorityClientCommandEnvelope {
  return enqueueAuthorityCommand(queue, { CloneSaveSkillBackup: {} }, issuedAtTick);
}

/** PA charter: name + tag are trimmed; the tag uppercases (nameplate `<TAG>` face). */
export function enqueueAuthorityGuildCreateCommand(
  queue: AuthorityCommandQueue,
  name: string,
  tag: string,
  terminalPropId: string,
  issuedAtTick: number,
): AuthorityClientCommandEnvelope | null {
  const charterName = name.trim();
  const charterTag = tag.trim().toUpperCase();
  const propId = terminalPropId.trim();
  if (!charterName || !charterTag || !propId) return null;
  return enqueueAuthorityCommand(queue, {
    GuildCreate: { name: charterName, tag: charterTag, terminal_prop_id: propId },
  }, issuedAtTick);
}

export function enqueueAuthorityGuildInviteCommand(
  queue: AuthorityCommandQueue,
  targetActorId: string,
  issuedAtTick: number,
): AuthorityClientCommandEnvelope | null {
  const target = targetActorId.trim();
  if (!target) return null;
  return enqueueAuthorityCommand(queue, { GuildInvite: { target_actor_id: target } }, issuedAtTick);
}

export function enqueueAuthorityGuildAcceptInviteCommand(
  queue: AuthorityCommandQueue,
  inviteId: string,
  issuedAtTick: number,
): AuthorityClientCommandEnvelope | null {
  const invite = inviteId.trim();
  if (!invite) return null;
  return enqueueAuthorityCommand(queue, { GuildAcceptInvite: { invite_id: invite } }, issuedAtTick);
}

export function enqueueAuthorityGuildDeclineInviteCommand(
  queue: AuthorityCommandQueue,
  inviteId: string,
  issuedAtTick: number,
): AuthorityClientCommandEnvelope | null {
  const invite = inviteId.trim();
  if (!invite) return null;
  return enqueueAuthorityCommand(queue, { GuildDeclineInvite: { invite_id: invite } }, issuedAtTick);
}

export function enqueueAuthorityGuildLeaveCommand(
  queue: AuthorityCommandQueue,
  issuedAtTick: number,
): AuthorityClientCommandEnvelope {
  return enqueueAuthorityCommand(queue, { GuildLeave: {} }, issuedAtTick);
}

export function enqueueAuthorityGuildKickCommand(
  queue: AuthorityCommandQueue,
  targetActorId: string,
  issuedAtTick: number,
): AuthorityClientCommandEnvelope | null {
  const target = targetActorId.trim();
  if (!target) return null;
  return enqueueAuthorityCommand(queue, { GuildKick: { target_actor_id: target } }, issuedAtTick);
}

export function enqueueAuthorityGuildSetRoleCommand(
  queue: AuthorityCommandQueue,
  targetActorId: string,
  role: "officer" | "member",
  issuedAtTick: number,
): AuthorityClientCommandEnvelope | null {
  const target = targetActorId.trim();
  if (!target) return null;
  return enqueueAuthorityCommand(queue, { GuildSetRole: { target_actor_id: target, role } }, issuedAtTick);
}

/** `permissions` is the frozen u8 wire mask (invite=1 kick=2 roles=4 war=8 disband=16). */
export function enqueueAuthorityGuildSetPermissionsCommand(
  queue: AuthorityCommandQueue,
  targetActorId: string,
  permissionsMask: number,
  issuedAtTick: number,
): AuthorityClientCommandEnvelope | null {
  const target = targetActorId.trim();
  if (!target || !Number.isInteger(permissionsMask) || permissionsMask < 0 || permissionsMask > 0xff) return null;
  return enqueueAuthorityCommand(queue, {
    GuildSetPermissions: { target_actor_id: target, permissions: permissionsMask },
  }, issuedAtTick);
}

export function enqueueAuthorityGuildTransferLeadershipCommand(
  queue: AuthorityCommandQueue,
  targetActorId: string,
  issuedAtTick: number,
): AuthorityClientCommandEnvelope | null {
  const target = targetActorId.trim();
  if (!target) return null;
  return enqueueAuthorityCommand(queue, { GuildTransferLeadership: { target_actor_id: target } }, issuedAtTick);
}

export function enqueueAuthorityGuildDeclareWarCommand(
  queue: AuthorityCommandQueue,
  opposingGuildId: string,
  issuedAtTick: number,
): AuthorityClientCommandEnvelope | null {
  const opposing = opposingGuildId.trim();
  if (!opposing) return null;
  return enqueueAuthorityCommand(queue, { GuildDeclareWar: { opposing_guild_id: opposing } }, issuedAtTick);
}

export function enqueueAuthorityGuildAcceptWarCommand(
  queue: AuthorityCommandQueue,
  opposingGuildId: string,
  issuedAtTick: number,
): AuthorityClientCommandEnvelope | null {
  const opposing = opposingGuildId.trim();
  if (!opposing) return null;
  return enqueueAuthorityCommand(queue, { GuildAcceptWar: { opposing_guild_id: opposing } }, issuedAtTick);
}

export function enqueueAuthorityGuildRescindWarCommand(
  queue: AuthorityCommandQueue,
  opposingGuildId: string,
  issuedAtTick: number,
): AuthorityClientCommandEnvelope | null {
  const opposing = opposingGuildId.trim();
  if (!opposing) return null;
  return enqueueAuthorityCommand(queue, { GuildRescindWar: { opposing_guild_id: opposing } }, issuedAtTick);
}

export function enqueueAuthorityGuildDisbandCommand(
  queue: AuthorityCommandQueue,
  issuedAtTick: number,
): AuthorityClientCommandEnvelope {
  return enqueueAuthorityCommand(queue, { GuildDisband: {} }, issuedAtTick);
}

export function enqueueAuthorityDeathblowCommand(
  queue: AuthorityCommandQueue,
  targetActorId: string,
  issuedAtTick: number,
): AuthorityClientCommandEnvelope | null {
  const target = targetActorId.trim();
  if (!target) return null;
  return enqueueAuthorityCommand(queue, { Deathblow: { target_actor_id: target } }, issuedAtTick);
}

export function enqueueAuthorityCorpseTakeCreditsCommand(
  queue: AuthorityCommandQueue,
  corpseId: string,
  issuedAtTick: number,
): AuthorityClientCommandEnvelope | null {
  const id = corpseId.trim();
  if (!id) return null;
  return enqueueAuthorityCommand(queue, { CorpseTakeCredits: { corpse_id: id } }, issuedAtTick);
}

export function enqueueAuthorityCloneRespawnCommand(
  queue: AuthorityCommandQueue,
  issuedAtTick: number,
  facilityId?: string,
): AuthorityClientCommandEnvelope {
  const payload: { facility_id?: string } = {};
  if (facilityId !== undefined) payload.facility_id = facilityId;
  return enqueueAuthorityCommand(queue, { CloneRespawn: payload }, issuedAtTick);
}

export function enqueueAuthorityReviveActorCommand(
  queue: AuthorityCommandQueue,
  targetActorId: string,
  issuedAtTick: number,
): AuthorityClientCommandEnvelope | null {
  const target = targetActorId.trim();
  if (!target) return null;
  return enqueueAuthorityCommand(queue, { ReviveActor: { target_actor_id: target } }, issuedAtTick);
}

export function enqueueAuthoritySampleResourceCommand(
  queue: AuthorityCommandQueue,
  family: string,
  issuedAtTick: number,
  options: { stop?: boolean } = {},
): AuthorityClientCommandEnvelope | null {
  const normalized = family.trim();
  if (!normalized) return null;
  return enqueueAuthorityCommand(queue, { SampleResource: { family: normalized, ...(options.stop ? { stop: true } : {}) } }, issuedAtTick);
}

export function enqueueAuthorityStopResourceSampleCommand(
  queue: AuthorityCommandQueue,
  family: string,
  issuedAtTick: number,
): AuthorityClientCommandEnvelope | null {
  return enqueueAuthoritySampleResourceCommand(queue, family, issuedAtTick, { stop: true });
}

export function enqueueAuthoritySurveyResourceCommand(
  queue: AuthorityCommandQueue,
  family: string,
  issuedAtTick: number,
): AuthorityClientCommandEnvelope | null {
  const normalized = family.trim();
  if (!normalized) return null;
  return enqueueAuthorityCommand(queue, { SurveyResource: { family: normalized } }, issuedAtTick);
}

export function enqueueAuthorityPlaceExtractorCommand(
  queue: AuthorityCommandQueue,
  family: string,
  issuedAtTick: number,
): AuthorityClientCommandEnvelope | null {
  const normalized = family.trim();
  if (!normalized) return null;
  return enqueueAuthorityCommand(queue, { PlaceExtractor: { family: normalized } }, issuedAtTick);
}

export function enqueueAuthorityCrankExtractorCommand(
  queue: AuthorityCommandQueue,
  extractorId: string,
  issuedAtTick: number,
): AuthorityClientCommandEnvelope | null {
  const normalized = extractorId.trim();
  if (!normalized) return null;
  return enqueueAuthorityCommand(queue, { CrankExtractor: { extractor_id: normalized } }, issuedAtTick);
}

export function enqueueAuthorityStopCrankCommand(
  queue: AuthorityCommandQueue,
  issuedAtTick: number,
): AuthorityClientCommandEnvelope {
  return enqueueAuthorityCommand(queue, { StopCrank: {} }, issuedAtTick);
}

export function enqueueAuthorityInsertBatteryCommand(
  queue: AuthorityCommandQueue,
  payload: { extractorId: string; container: string; stackId: number | string; variantId: number },
  issuedAtTick: number,
): AuthorityClientCommandEnvelope | null {
  const extractorId = payload.extractorId.trim();
  const container = payload.container.trim();
  const stackId = String(payload.stackId).trim();
  if (!extractorId || !container || !stackId || !Number.isInteger(payload.variantId) || payload.variantId < 0) return null;
  return enqueueAuthorityCommand(queue, {
    InsertBattery: {
      extractor_id: extractorId,
      container,
      stack_id: stackId,
      variant_id: payload.variantId,
    },
  }, issuedAtTick);
}

export function enqueueAuthorityCollectExtractorCommand(
  queue: AuthorityCommandQueue,
  extractorId: string,
  issuedAtTick: number,
): AuthorityClientCommandEnvelope | null {
  const normalized = extractorId.trim();
  if (!normalized) return null;
  return enqueueAuthorityCommand(queue, { CollectExtractor: { extractor_id: normalized } }, issuedAtTick);
}

export function enqueueAuthorityPlaceCampCommand(
  queue: AuthorityCommandQueue,
  issuedAtTick: number,
): AuthorityClientCommandEnvelope {
  return enqueueAuthorityCommand(queue, { PlaceCamp: {} }, issuedAtTick);
}

export function enqueueAuthorityPackUpCampCommand(
  queue: AuthorityCommandQueue,
  issuedAtTick: number,
): AuthorityClientCommandEnvelope {
  return enqueueAuthorityCommand(queue, { PackUpCamp: {} }, issuedAtTick);
}

export function enqueueAuthorityClaimParcelCommand(
  queue: AuthorityCommandQueue,
  issuedAtTick: number,
  planetId: string,
  areaId: string,
  x: number,
  y: number,
  tier: string,
): AuthorityClientCommandEnvelope {
  return enqueueAuthorityCommand(queue, { ClaimParcel: { planet_id: planetId, area_id: areaId, x, y, tier } }, issuedAtTick);
}

export function enqueueAuthorityAbandonParcelCommand(
  queue: AuthorityCommandQueue,
  issuedAtTick: number,
  parcelId: string,
): AuthorityClientCommandEnvelope {
  return enqueueAuthorityCommand(queue, { AbandonParcel: { parcel_id: parcelId } }, issuedAtTick);
}

export function enqueueAuthorityRenameParcelCommand(
  queue: AuthorityCommandQueue,
  issuedAtTick: number,
  parcelId: string,
  name: string,
): AuthorityClientCommandEnvelope {
  return enqueueAuthorityCommand(queue, { RenameParcel: { parcel_id: parcelId, name } }, issuedAtTick);
}

export function enqueueAuthorityPayUpkeepCommand(
  queue: AuthorityCommandQueue,
  issuedAtTick: number,
  parcelId: string,
): AuthorityClientCommandEnvelope {
  return enqueueAuthorityCommand(queue, { PayUpkeep: { parcel_id: parcelId } }, issuedAtTick);
}

export function enqueueAuthorityTillTileCommand(
  queue: AuthorityCommandQueue,
  issuedAtTick: number,
  parcelId: string,
  cellX: number,
  cellY: number,
): AuthorityClientCommandEnvelope {
  return enqueueAuthorityCommand(queue, { TillTile: { parcel_id: parcelId, cell_x: cellX, cell_y: cellY } }, issuedAtTick);
}

export function enqueueAuthorityPlantSeedCommand(
  queue: AuthorityCommandQueue,
  issuedAtTick: number,
  parcelId: string,
  cellX: number,
  cellY: number,
  container: string,
  stackId: string,
  variantId: number,
): AuthorityClientCommandEnvelope {
  return enqueueAuthorityCommand(
    queue,
    { PlantSeed: { parcel_id: parcelId, cell_x: cellX, cell_y: cellY, container, stack_id: stackId, variant_id: variantId } },
    issuedAtTick,
  );
}

export function enqueueAuthorityClearTileCommand(
  queue: AuthorityCommandQueue,
  issuedAtTick: number,
  parcelId: string,
  cellX: number,
  cellY: number,
): AuthorityClientCommandEnvelope {
  return enqueueAuthorityCommand(queue, { ClearTile: { parcel_id: parcelId, cell_x: cellX, cell_y: cellY } }, issuedAtTick);
}

export function enqueueAuthorityWaterTileCommand(
  queue: AuthorityCommandQueue,
  issuedAtTick: number,
  parcelId: string,
  cellX: number,
  cellY: number,
): AuthorityClientCommandEnvelope {
  return enqueueAuthorityCommand(queue, { WaterTile: { parcel_id: parcelId, cell_x: cellX, cell_y: cellY } }, issuedAtTick);
}

export function enqueueAuthorityTendPlotCommand(
  queue: AuthorityCommandQueue,
  issuedAtTick: number,
  parcelId: string,
  stop = false,
): AuthorityClientCommandEnvelope {
  return enqueueAuthorityCommand(queue, { TendPlot: { parcel_id: parcelId, stop } }, issuedAtTick);
}

export function enqueueAuthorityPlaceFarmStructureCommand(
  queue: AuthorityCommandQueue,
  issuedAtTick: number,
  parcelId: string,
  structureItemId: number,
  cellX: number,
  cellY: number,
): AuthorityClientCommandEnvelope {
  return enqueueAuthorityCommand(
    queue,
    { PlaceFarmStructure: { parcel_id: parcelId, structure_item_id: structureItemId, cell_x: cellX, cell_y: cellY } },
    issuedAtTick,
  );
}

export function enqueueAuthorityRemoveFarmStructureCommand(
  queue: AuthorityCommandQueue,
  issuedAtTick: number,
  parcelId: string,
  structureId: string,
): AuthorityClientCommandEnvelope {
  return enqueueAuthorityCommand(queue, { RemoveFarmStructure: { parcel_id: parcelId, structure_id: structureId } }, issuedAtTick);
}

export function enqueueAuthorityFertilizeCommand(
  queue: AuthorityCommandQueue,
  issuedAtTick: number,
  parcelId: string,
  cellX: number,
  cellY: number,
  container: string,
  stackId: string,
  variantId: number,
): AuthorityClientCommandEnvelope {
  return enqueueAuthorityCommand(
    queue,
    { Fertilize: { parcel_id: parcelId, cell_x: cellX, cell_y: cellY, container, stack_id: stackId, variant_id: variantId } },
    issuedAtTick,
  );
}

export function enqueueAuthorityHarvestCropCommand(
  queue: AuthorityCommandQueue,
  issuedAtTick: number,
  parcelId: string,
  cellX: number,
  cellY: number,
): AuthorityClientCommandEnvelope {
  return enqueueAuthorityCommand(queue, { HarvestCrop: { parcel_id: parcelId, cell_x: cellX, cell_y: cellY } }, issuedAtTick);
}

export function enqueueAuthorityBuildPlaceCommand(
  queue: AuthorityCommandQueue,
  issuedAtTick: number,
  payload: Extract<AuthorityClientCommand, { BuildPlace: unknown }>["BuildPlace"],
): AuthorityClientCommandEnvelope {
  return enqueueAuthorityCommand(queue, { BuildPlace: payload }, issuedAtTick);
}

export function enqueueAuthorityBuildRemoveCommand(
  queue: AuthorityCommandQueue,
  issuedAtTick: number,
  componentId: string,
): AuthorityClientCommandEnvelope {
  return enqueueAuthorityCommand(queue, { BuildRemove: { component_id: componentId } }, issuedAtTick);
}

export function enqueueAuthorityBuildToggleDoorCommand(
  queue: AuthorityCommandQueue,
  issuedAtTick: number,
  componentId: string,
): AuthorityClientCommandEnvelope {
  return enqueueAuthorityCommand(queue, { BuildToggleDoor: { component_id: componentId } }, issuedAtTick);
}

export function enqueueAuthorityDestroyExtractorCommand(
  queue: AuthorityCommandQueue,
  extractorId: string,
  issuedAtTick: number,
): AuthorityClientCommandEnvelope | null {
  const normalized = extractorId.trim();
  if (!normalized) return null;
  return enqueueAuthorityCommand(queue, { DestroyExtractor: { extractor_id: normalized } }, issuedAtTick);
}

export function enqueueAuthoritySetPostureCommand(
  queue: AuthorityCommandQueue,
  posture: "kneel" | "stand",
  issuedAtTick: number,
): AuthorityClientCommandEnvelope | null {
  return enqueueAuthorityCommand(queue, { SetPosture: { posture } }, issuedAtTick);
}

export type CombatActionId = "basic_shot" | "aimed_shot";

export function enqueueAuthorityQueueCombatActionCommand(
  queue: AuthorityCommandQueue,
  actionId: CombatActionId,
  targetActorId: string,
  issuedAtTick: number,
): AuthorityClientCommandEnvelope | null {
  const target = targetActorId.trim();
  if (target.length === 0) return null;
  return enqueueAuthorityCommand(
    queue,
    { QueueCombatAction: { action_id: actionId, target_actor_id: target } },
    issuedAtTick,
  );
}

export function enqueueAuthorityPeaceCommand(
  queue: AuthorityCommandQueue,
  issuedAtTick: number,
): AuthorityClientCommandEnvelope {
  return enqueueAuthorityCommand(queue, { Peace: {} }, issuedAtTick);
}

export function enqueueAuthorityCancelAbilityQueueCommand(
  queue: AuthorityCommandQueue,
  issuedAtTick: number,
  options: { queueEntryId?: string; scope?: "owner_repeat" | "combat" | "posture" | "all" } = {},
): AuthorityClientCommandEnvelope {
  const payload: { queue_entry_id?: string; scope?: "owner_repeat" | "combat" | "posture" | "all" } = {};
  const queueEntryId = options.queueEntryId?.trim();
  if (queueEntryId) payload.queue_entry_id = queueEntryId;
  if (options.scope) payload.scope = options.scope;
  return enqueueAuthorityCommand(queue, { CancelAbilityQueue: payload }, issuedAtTick);
}

export function enqueueAuthoritySplitStackCommand(
  queue: AuthorityCommandQueue,
  container: string,
  stackId: string,
  itemId: number,
  variantId: number,
  quantity: number,
  issuedAtTick: number,
): AuthorityClientCommandEnvelope | null {
  if (quantity <= 0) return null;
  return enqueueAuthorityCommand(
    queue,
    { SplitStack: { container, stack_id: stackId, item_id: itemId, variant_id: variantId, quantity } },
    issuedAtTick,
  );
}

export function enqueueAuthorityMergeStacksCommand(
  queue: AuthorityCommandQueue,
  container: string,
  sourceStackId: string,
  targetStackId: string,
  issuedAtTick: number,
): AuthorityClientCommandEnvelope | null {
  if (sourceStackId === targetStackId) return null;
  return enqueueAuthorityCommand(
    queue,
    { MergeStacks: { container, source_stack_id: sourceStackId, target_stack_id: targetStackId } },
    issuedAtTick,
  );
}

export function enqueueAuthorityRedeemCreditChipCommand(
  queue: AuthorityCommandQueue,
  container: string,
  stackId: string,
  issuedAtTick: number,
): AuthorityClientCommandEnvelope | null {
  const trimmedContainer = container.trim();
  const trimmedStackId = stackId.trim();
  if (trimmedContainer.length === 0 || trimmedStackId.length === 0) return null;
  return enqueueAuthorityCommand(
    queue,
    { RedeemCreditChip: { container: trimmedContainer, stack_id: trimmedStackId } },
    issuedAtTick,
  );
}
export function enqueueAuthorityDiscardStackCommand(
  queue: AuthorityCommandQueue,
  container: string,
  stackId: string,
  itemId: number,
  variantId: number,
  issuedAtTick: number,
): AuthorityClientCommandEnvelope | null {
  const trimmedContainer = container.trim();
  const trimmedStackId = stackId.trim();
  if (trimmedContainer.length === 0 || trimmedStackId.length === 0) return null;
  return enqueueAuthorityCommand(
    queue,
    { DiscardStack: { container: trimmedContainer, stack_id: trimmedStackId, item_id: itemId, variant_id: variantId } },
    issuedAtTick,
  );
}


export function enqueueAuthorityCraftItemCommand(
  queue: AuthorityCommandQueue,
  schematicId: string,
  issuedAtTick: number,
  experiment = { power: 0, handling: 0, reliability: 0 },
): AuthorityClientCommandEnvelope | null {
  const normalized = schematicId.trim();
  if (!normalized) return null;
  return enqueueAuthorityCommand(queue, {
    CraftItem: {
      schematic_id: normalized,
      experiment_power: clampExperimentPoints(experiment.power),
      experiment_handling: clampExperimentPoints(experiment.handling),
      experiment_reliability: clampExperimentPoints(experiment.reliability),
    },
  }, issuedAtTick);
}

export function enqueueAuthorityCraftBeginCommand(
  queue: AuthorityCommandQueue,
  recipeId: string,
  issuedAtTick: number,
): AuthorityClientCommandEnvelope | null {
  const normalized = recipeId.trim();
  if (!normalized) return null;
  return enqueueAuthorityCommand(queue, { CraftBegin: { recipe_id: normalized } }, issuedAtTick);
}

export function enqueueAuthorityCraftAssignSlotCommand(
  queue: AuthorityCommandQueue,
  payload: { slotIndex: number; container: string; stackId: number | string; variantId: number },
  issuedAtTick: number,
): AuthorityClientCommandEnvelope | null {
  const slotIndex = Math.trunc(payload.slotIndex);
  const container = payload.container.trim();
  const stackId = String(payload.stackId).trim();
  const variantId = Math.trunc(payload.variantId);
  if (!Number.isInteger(slotIndex) || slotIndex < 0 || slotIndex > 255 || !container || !stackId || !Number.isInteger(variantId) || variantId < 0) return null;
  return enqueueAuthorityCommand(queue, {
    CraftAssignSlot: {
      slot_index: slotIndex,
      container,
      stack_id: stackId,
      variant_id: variantId,
    },
  }, issuedAtTick);
}

export function enqueueAuthorityCraftClearSlotCommand(
  queue: AuthorityCommandQueue,
  slotIndex: number,
  issuedAtTick: number,
): AuthorityClientCommandEnvelope | null {
  const normalized = Math.trunc(slotIndex);
  if (!Number.isInteger(normalized) || normalized < 0 || normalized > 255) return null;
  return enqueueAuthorityCommand(queue, { CraftClearSlot: { slot_index: normalized } }, issuedAtTick);
}

export function enqueueAuthorityCraftAssembleCommand(
  queue: AuthorityCommandQueue,
  issuedAtTick: number,
): AuthorityClientCommandEnvelope {
  return enqueueAuthorityCommand(queue, { CraftAssemble: {} }, issuedAtTick);
}

export function enqueueAuthorityCraftExperimentCommand(
  queue: AuthorityCommandQueue,
  lineId: number,
  points: number,
  issuedAtTick: number,
): AuthorityClientCommandEnvelope | null {
  const normalizedLineId = Math.trunc(lineId);
  const normalizedPoints = Math.trunc(points);
  if (!Number.isInteger(normalizedLineId) || normalizedLineId < 0 || normalizedLineId > 255) return null;
  if (!Number.isInteger(normalizedPoints) || normalizedPoints <= 0 || normalizedPoints > 255) return null;
  return enqueueAuthorityCommand(queue, {
    CraftExperiment: {
      line_id: normalizedLineId,
      points: normalizedPoints,
    },
  }, issuedAtTick);
}

export function enqueueAuthorityCraftFinalizePrototypeCommand(
  queue: AuthorityCommandQueue,
  issuedAtTick: number,
  customName = "",
): AuthorityClientCommandEnvelope {
  return enqueueAuthorityCommand(
    queue,
    { CraftFinalizePrototype: { custom_name: customName } },
    issuedAtTick,
  );
}

export function enqueueAuthorityCraftFinalizePracticeCommand(
  queue: AuthorityCommandQueue,
  issuedAtTick: number,
): AuthorityClientCommandEnvelope {
  return enqueueAuthorityCommand(queue, { CraftFinalizePractice: {} }, issuedAtTick);
}

export function enqueueAuthorityCraftDraftSchematicCommand(
  queue: AuthorityCommandQueue,
  maxUses: number,
  issuedAtTick: number,
): AuthorityClientCommandEnvelope | null {
  const normalized = Math.trunc(maxUses);
  if (!Number.isInteger(normalized) || normalized <= 0 || normalized > 1_000) return null;
  return enqueueAuthorityCommand(queue, { CraftDraftSchematic: { max_uses: normalized } }, issuedAtTick);
}


export function enqueueAuthorityFactoryManufactureCommand(
  queue: AuthorityCommandQueue,
  factoryId: string,
  schematicId: string,
  issuedAtTick = 0,
): AuthorityClientCommandEnvelope | null {
  const factory = factoryId.trim();
  const schematic = schematicId.trim();
  if (!factory || !schematic) return null;
  return enqueueAuthorityCommand(queue, {
    FactoryManufacture: { factory_id: factory, schematic_id: schematic },
  }, issuedAtTick);
}
export function enqueueAuthorityCraftCancelCommand(
  queue: AuthorityCommandQueue,
  issuedAtTick: number,
): AuthorityClientCommandEnvelope {
  return enqueueAuthorityCommand(queue, { CraftCancel: {} }, issuedAtTick);
}

// ── Bio-Engineer gene bench (GeneSample / ScanGenome / Splice*) ─────────────
// Typed fronts over the shared enqueue for the splice-bench command union
// (already in AuthorityClientCommand). Mirror the craft helpers: normalize +
// refuse bad input with null so the window's deny path stays honest. Wire
// landed with DEF-6 (spliceSession / genomeScan fanout); the SEND path was the
// only missing seam (SpliceFE lane).

export function enqueueAuthorityGeneSampleCommand(
  queue: AuthorityCommandQueue,
  species: string,
  issuedAtTick: number,
): AuthorityClientCommandEnvelope | null {
  const normalized = species.trim().toLowerCase();
  if (!normalized) return null;
  return enqueueAuthorityCommand(queue, { GeneSample: { species: normalized } }, issuedAtTick);
}

export function enqueueAuthorityScanGenomeCommand(
  queue: AuthorityCommandQueue,
  payload: { container: string; stackId: number | string; variantId: number },
  issuedAtTick: number,
): AuthorityClientCommandEnvelope | null {
  const container = payload.container.trim();
  const stackId = String(payload.stackId).trim();
  const variantId = Math.trunc(payload.variantId);
  if (!container || !stackId || !Number.isInteger(variantId) || variantId < 0) return null;
  return enqueueAuthorityCommand(queue, {
    ScanGenome: { container, stack_id: stackId, variant_id: variantId },
  }, issuedAtTick);
}

export function enqueueAuthoritySpliceBeginCommand(
  queue: AuthorityCommandQueue,
  species: string,
  issuedAtTick: number,
): AuthorityClientCommandEnvelope | null {
  const normalized = species.trim().toLowerCase();
  if (!normalized) return null;
  return enqueueAuthorityCommand(queue, { SpliceBegin: { species: normalized } }, issuedAtTick);
}

export function enqueueAuthoritySpliceAssignSlotCommand(
  queue: AuthorityCommandQueue,
  payload: { slotIndex: number; container: string; stackId: number | string; variantId: number },
  issuedAtTick: number,
): AuthorityClientCommandEnvelope | null {
  const slotIndex = Math.trunc(payload.slotIndex);
  const container = payload.container.trim();
  const stackId = String(payload.stackId).trim();
  const variantId = Math.trunc(payload.variantId);
  if (!Number.isInteger(slotIndex) || slotIndex < 0 || slotIndex > 255 || !container || !stackId || !Number.isInteger(variantId) || variantId < 0) return null;
  return enqueueAuthorityCommand(queue, {
    SpliceAssignSlot: { slot_index: slotIndex, container, stack_id: stackId, variant_id: variantId },
  }, issuedAtTick);
}

export function enqueueAuthoritySpliceClearSlotCommand(
  queue: AuthorityCommandQueue,
  slotIndex: number,
  issuedAtTick: number,
): AuthorityClientCommandEnvelope | null {
  const normalized = Math.trunc(slotIndex);
  if (!Number.isInteger(normalized) || normalized < 0 || normalized > 255) return null;
  return enqueueAuthorityCommand(queue, { SpliceClearSlot: { slot_index: normalized } }, issuedAtTick);
}

export function enqueueAuthoritySpliceChooseAlleleCommand(
  queue: AuthorityCommandQueue,
  payload: { locus: number; fromParent: number; allele: number },
  issuedAtTick: number,
): AuthorityClientCommandEnvelope | null {
  const locus = Math.trunc(payload.locus);
  const fromParent = Math.trunc(payload.fromParent);
  const allele = Math.trunc(payload.allele);
  if (!Number.isInteger(locus) || locus < 0 || locus > 255) return null;
  if (fromParent !== 0 && fromParent !== 1) return null;
  if (allele !== 0 && allele !== 1) return null;
  return enqueueAuthorityCommand(queue, {
    SpliceChooseAllele: { locus, from_parent: fromParent, allele },
  }, issuedAtTick);
}

export function enqueueAuthoritySpliceAssembleCommand(
  queue: AuthorityCommandQueue,
  issuedAtTick: number,
): AuthorityClientCommandEnvelope {
  return enqueueAuthorityCommand(queue, { SpliceAssemble: {} }, issuedAtTick);
}

export function enqueueAuthoritySpliceExperimentLocusCommand(
  queue: AuthorityCommandQueue,
  payload: { locus: number; points: number },
  issuedAtTick: number,
): AuthorityClientCommandEnvelope | null {
  const locus = Math.trunc(payload.locus);
  const points = Math.trunc(payload.points);
  if (!Number.isInteger(locus) || locus < 0 || locus > 255) return null;
  if (!Number.isInteger(points) || points <= 0 || points > 255) return null;
  return enqueueAuthorityCommand(queue, {
    SpliceExperimentLocus: { locus, points },
  }, issuedAtTick);
}

export function enqueueAuthoritySpliceMintCommand(
  queue: AuthorityCommandQueue,
  cultivarName: string | null,
  issuedAtTick: number,
): AuthorityClientCommandEnvelope {
  const name = cultivarName?.trim();
  const command: AuthorityClientCommand = name
    ? { SpliceMint: { cultivar_name: name } }
    : { SpliceMint: {} };
  return enqueueAuthorityCommand(queue, command, issuedAtTick);
}

export function enqueueAuthoritySpliceCancelCommand(
  queue: AuthorityCommandQueue,
  issuedAtTick: number,
): AuthorityClientCommandEnvelope {
  return enqueueAuthorityCommand(queue, { SpliceCancel: {} }, issuedAtTick);
}

export function enqueueAuthorityRequestStarterToolCommand(
  queue: AuthorityCommandQueue,
  trainerActorId: string,
  issuedAtTick: number,
): AuthorityClientCommandEnvelope | null {
  const trainer = trainerActorId.trim();
  if (!trainer) return null;
  return enqueueAuthorityCommand(queue, { RequestStarterTool: { trainer_actor_id: trainer } }, issuedAtTick);
}

export function enqueueAuthorityPurchaseSkillBoxCommand(
  queue: AuthorityCommandQueue,
  skillBoxId: string,
  trainerActorId: string,
  issuedAtTick: number,
): AuthorityClientCommandEnvelope | null {
  const skill = skillBoxId.trim();
  const trainer = trainerActorId.trim();
  if (!skill || !trainer) return null;
  return enqueueAuthorityCommand(queue, {
    PurchaseSkillBox: {
      skill_box_id: skill,
      trainer_actor_id: trainer,
    },
  }, issuedAtTick);
}

export function enqueueAuthorityUnlearnSkillBoxCommand(
  queue: AuthorityCommandQueue,
  skillBoxId: string,
  trainerActorId: string,
  issuedAtTick: number,
): AuthorityClientCommandEnvelope | null {
  const skill = skillBoxId.trim();
  const trainer = trainerActorId.trim();
  if (!skill || !trainer) return null;
  return enqueueAuthorityCommand(queue, {
    UnlearnSkillBox: {
      skill_box_id: skill,
      trainer_actor_id: trainer,
    },
  }, issuedAtTick);
}

export function enqueueAuthoritySetProfessionTitleCommand(
  queue: AuthorityCommandQueue,
  titleId: string | null,
  issuedAtTick: number,
): AuthorityClientCommandEnvelope | null {
  const normalized = titleId?.trim() ?? "";
  return enqueueAuthorityCommand(queue, {
    SetProfessionTitle: {
      title_id: normalized.length > 0 ? normalized : null,
    },
  }, issuedAtTick);
}

export function enqueueAuthoritySetCareerGoalCommand(
  queue: AuthorityCommandQueue,
  goalId: string,
  trainerActorId: string,
  issuedAtTick: number,
): AuthorityClientCommandEnvelope | null {
  const goal = goalId.trim();
  const trainer = trainerActorId.trim();
  if (!goal || !trainer) return null;
  return enqueueAuthorityCommand(queue, {
    SetCareerGoal: {
      goal_id: goal,
      trainer_actor_id: trainer,
    },
  }, issuedAtTick);
}

export interface ExchangeTradeItem {
  item_id: number;
  variant_id: number;
  quantity: number;
}

function normalizeTradeItems(items: ExchangeTradeItem[]): ExchangeTradeItem[] | null {
  const normalized: ExchangeTradeItem[] = [];
  for (const item of items) {
    if (
      !Number.isInteger(item.item_id)
      || item.item_id < 0
      || !Number.isInteger(item.variant_id)
      || item.variant_id < 0
      || !Number.isInteger(item.quantity)
      || item.quantity <= 0
    ) {
      return null;
    }
    normalized.push({
      item_id: item.item_id,
      variant_id: item.variant_id,
      quantity: item.quantity,
    });
  }
  return normalized;
}

export function enqueueAuthorityToggleDoorCommand(
  queue: AuthorityCommandQueue,
  propId: string,
  issuedAtTick: number,
): AuthorityClientCommandEnvelope | null {
  const prop = normalizeTravelId(propId);
  if (!prop) return null;
  return enqueueAuthorityCommand(queue, { ToggleDoor: { prop_id: prop } }, issuedAtTick);
}

export function enqueueAuthorityStoreToExchangeCommand(
  queue: AuthorityCommandQueue,
  itemId: number,
  variantId: number,
  quantity: number,
  issuedAtTick: number,
): AuthorityClientCommandEnvelope | null {
  if (!Number.isInteger(itemId) || itemId < 0 || quantity <= 0) return null;
  return enqueueAuthorityCommand(
    queue,
    { StoreToExchange: { item_id: itemId, variant_id: Math.max(0, Math.trunc(variantId)), quantity } },
    issuedAtTick,
  );
}

export function enqueueAuthorityRetrieveFromExchangeCommand(
  queue: AuthorityCommandQueue,
  itemId: number,
  variantId: number,
  quantity: number,
  issuedAtTick: number,
): AuthorityClientCommandEnvelope | null {
  if (!Number.isInteger(itemId) || itemId < 0 || quantity <= 0) return null;
  return enqueueAuthorityCommand(
    queue,
    { RetrieveFromExchange: { item_id: itemId, variant_id: Math.max(0, Math.trunc(variantId)), quantity } },
    issuedAtTick,
  );
}

export function enqueueAuthorityProposeTradeCommand(
  queue: AuthorityCommandQueue,
  partnerActorId: string,
  offer: ExchangeTradeItem[],
  request: ExchangeTradeItem[],
  issuedAtTick: number,
): AuthorityClientCommandEnvelope | null {
  const partner = partnerActorId.trim();
  if (!partner) return null;
  const normalizedOffer = normalizeTradeItems(offer);
  const normalizedRequest = normalizeTradeItems(request);
  if (!normalizedOffer || !normalizedRequest) return null;
  return enqueueAuthorityCommand(
    queue,
    { ProposeTrade: { partner_actor_id: partner, offer: normalizedOffer, request: normalizedRequest } },
    issuedAtTick,
  );
}

export function enqueueAuthorityAcceptTradeCommand(
  queue: AuthorityCommandQueue,
  proposalId: number,
  issuedAtTick: number,
): AuthorityClientCommandEnvelope | null {
  if (!Number.isInteger(proposalId) || proposalId <= 0) return null;
  return enqueueAuthorityCommand(queue, { AcceptTrade: { proposal_id: proposalId } }, issuedAtTick);
}

export function enqueueAuthorityDeclineTradeCommand(
  queue: AuthorityCommandQueue,
  proposalId: number,
  issuedAtTick: number,
): AuthorityClientCommandEnvelope | null {
  if (!Number.isInteger(proposalId) || proposalId <= 0) return null;
  return enqueueAuthorityCommand(queue, { DeclineTrade: { proposal_id: proposalId } }, issuedAtTick);
}

function normalizeTradeLine(item: ExchangeTradeItem): ExchangeTradeItem | null {
  if (!Number.isInteger(item.item_id) || item.item_id < 0) return null;
  const quantity = Math.trunc(item.quantity);
  if (!Number.isInteger(quantity) || quantity <= 0) return null;
  return { item_id: item.item_id, variant_id: Math.max(0, Math.trunc(item.variant_id)), quantity };
}

export function enqueueAuthorityAddTradeItemCommand(
  queue: AuthorityCommandQueue,
  proposalId: number,
  item: ExchangeTradeItem,
  issuedAtTick: number,
): AuthorityClientCommandEnvelope | null {
  if (!Number.isInteger(proposalId) || proposalId <= 0) return null;
  const line = normalizeTradeLine(item);
  if (!line) return null;
  return enqueueAuthorityCommand(queue, { AddTradeItem: { proposal_id: proposalId, item: line } }, issuedAtTick);
}

export function enqueueAuthorityRemoveTradeItemCommand(
  queue: AuthorityCommandQueue,
  proposalId: number,
  item: ExchangeTradeItem,
  issuedAtTick: number,
): AuthorityClientCommandEnvelope | null {
  if (!Number.isInteger(proposalId) || proposalId <= 0) return null;
  const line = normalizeTradeLine(item);
  if (!line) return null;
  return enqueueAuthorityCommand(queue, { RemoveTradeItem: { proposal_id: proposalId, item: line } }, issuedAtTick);
}

export function enqueueAuthoritySetTradeCoinCommand(
  queue: AuthorityCommandQueue,
  proposalId: number,
  amount: number,
  issuedAtTick: number,
): AuthorityClientCommandEnvelope | null {
  if (!Number.isInteger(proposalId) || proposalId <= 0) return null;
  const coin = Math.trunc(amount);
  if (!Number.isFinite(coin) || coin < 0) return null;
  return enqueueAuthorityCommand(queue, { SetTradeCoin: { proposal_id: proposalId, amount: coin } }, issuedAtTick);
}

export function enqueueAuthorityConfirmTradeCommand(
  queue: AuthorityCommandQueue,
  proposalId: number,
  issuedAtTick: number,
): AuthorityClientCommandEnvelope | null {
  if (!Number.isInteger(proposalId) || proposalId <= 0) return null;
  return enqueueAuthorityCommand(queue, { ConfirmTrade: { proposal_id: proposalId } }, issuedAtTick);
}

export function enqueueAuthorityHarvestCorpseCommand(
  queue: AuthorityCommandQueue,
  targetActorId: string,
  issuedAtTick: number,
): AuthorityClientCommandEnvelope | null {
  const target = targetActorId.trim();
  if (!target) return null;
  const command: AuthorityClientCommand = { HarvestCorpse: { target_actor_id: target } };
  return enqueueAuthorityCommand(queue, command, issuedAtTick);
}

/**
 * Per-stack loot take from a corpse (`corpse:<actorId>`) or loot cache
 * (`cache:<propId>`) container into the requester's pack. Wire payload is
 * camelCase — the shard schema rejects snake_case for this command.
 */
export function enqueueAuthorityTakeLootItemCommand(
  queue: AuthorityCommandQueue,
  container: string,
  itemId: number,
  variantId: number,
  quantity: number,
  issuedAtTick: number,
): AuthorityClientCommandEnvelope | null {
  const target = container.trim();
  if (!target || !Number.isInteger(itemId) || itemId < 0 || !Number.isInteger(quantity) || quantity <= 0) return null;
  return enqueueAuthorityCommand(
    queue,
    { TakeLootItem: { container: target, itemId, variantId: Math.max(0, Math.trunc(variantId)), quantity } },
    issuedAtTick,
  );
}

export function enqueueAuthorityPurchaseTravelTicketCommand(
  queue: AuthorityCommandQueue,
  payload: { terminalPropId: string; toPlanetId: string; toCityId: string },
  issuedAtTick: number,
): AuthorityClientCommandEnvelope | null {
  const terminalPropId = normalizeTravelId(payload.terminalPropId);
  const toPlanetId = normalizeTravelId(payload.toPlanetId);
  const toCityId = normalizeTravelId(payload.toCityId);
  if (!terminalPropId || !toPlanetId || !toCityId) return null;
  return enqueueAuthorityCommand(queue, {
    PurchaseTravelTicket: {
      terminal_prop_id: terminalPropId,
      to_planet_id: toPlanetId,
      to_city_id: toCityId,
    },
  }, issuedAtTick);
}

export function enqueueAuthorityUseTravelTicketCommand(
  queue: AuthorityCommandQueue,
  payload: { container?: string; stackId?: number | string; ticketId?: string; variantId?: number },
  issuedAtTick: number,
): AuthorityClientCommandEnvelope | null {
  const command: { container?: string; stack_id?: string; ticket_id?: string; item_id?: "travel_ticket"; item_numeric_id?: number; variant_id?: number } = { item_id: "travel_ticket", item_numeric_id: 5001 };
  const container = payload.container?.trim();
  const stackId = payload.stackId === undefined ? "" : String(payload.stackId).trim();
  const ticketId = payload.ticketId?.trim();
  if (container) command.container = container;
  if (stackId) command.stack_id = stackId;
  if (ticketId) command.ticket_id = ticketId;
  if (payload.variantId !== undefined) {
    if (!Number.isInteger(payload.variantId) || payload.variantId < 0) return null;
    command.variant_id = payload.variantId;
  }
  if (!command.stack_id && !command.ticket_id && !command.container) return null;
  return enqueueAuthorityCommand(queue, { UseTravelTicket: command }, issuedAtTick);
}


export function authorityMoveCommand(
  dx: number,
  dy: number,
  durationTicks: number,
  sprint = false,
): AuthorityClientCommand | null {
  const stepX = Math.trunc(dx);
  const stepY = Math.trunc(dy);
  const ticks = Math.trunc(durationTicks);
  if (Math.abs(stepX) > 1 || Math.abs(stepY) > 1 || (stepX === 0 && stepY === 0)) return null;
  if (ticks <= 0 || ticks > maxMoveDurationTicks) return null;
  const move: AuthorityMovePayload = {
    dx: stepX,
    dy: stepY,
    duration_ticks: ticks,
  };
  if (sprint) move.sprint = true;
  return { Move: move };
}

export function authorityMoveIntentCommand(
  dx: number,
  dy: number,
  facing?: AuthorityCardinalDirection,
  sprint = false,
): AuthorityClientCommand | null {
  const stepX = Math.trunc(dx);
  const stepY = Math.trunc(dy);
  if (Math.abs(stepX) > 1 || Math.abs(stepY) > 1) return null;
  const intent: AuthorityMoveIntentPayload = {
    dx: stepX,
    dy: stepY,
  };
  if (facing) intent.facing = facing;
  if (sprint && (stepX !== 0 || stepY !== 0)) intent.sprint = true;
  return { SetMoveIntent: intent };
}

export function authorityCommandKind(command: AuthorityClientCommand): AuthorityClientCommandKind {
  if ("Move" in command) return "Move";
  if ("SetMoveIntent" in command) return "SetMoveIntent";
  if ("ReloadWeapon" in command) return "ReloadWeapon";
  if ("SetEquippedWeapon" in command) return "SetEquippedWeapon";
  if ("SetEquippedClothing" in command) return "SetEquippedClothing";
  if ("UseConsumable" in command) return "UseConsumable";
  if ("RefillAmmo" in command) return "RefillAmmo";
  if ("ApplyServiceBuff" in command) return "ApplyServiceBuff";
  if ("CloneRespawn" in command) return "CloneRespawn";
  if ("ReviveActor" in command) return "ReviveActor";
  if ("SampleResource" in command) return "SampleResource";
  if ("SurveyResource" in command) return "SurveyResource";
  if ("PlaceExtractor" in command) return "PlaceExtractor";
  if ("CrankExtractor" in command) return "CrankExtractor";
  if ("StopCrank" in command) return "StopCrank";
  if ("InsertBattery" in command) return "InsertBattery";
  if ("CollectExtractor" in command) return "CollectExtractor";
  if ("DestroyExtractor" in command) return "DestroyExtractor";
  if ("PlaceCamp" in command) return "PlaceCamp";
  if ("PackUpCamp" in command) return "PackUpCamp";
  if ("HarvestCorpse" in command) return "HarvestCorpse";
  if ("BankStoreItem" in command) return "BankStoreItem";
  if ("BankRetrieveItem" in command) return "BankRetrieveItem";
  if ("BankDepositCredits" in command) return "BankDepositCredits";
  if ("BankWithdrawCredits" in command) return "BankWithdrawCredits";
  if ("CloneSaveSkillBackup" in command) return "CloneSaveSkillBackup";
  if ("CorpseTakeCredits" in command) return "CorpseTakeCredits";
  if ("TakeLootItem" in command) return "TakeLootItem";
  if ("PurchaseTravelTicket" in command) return "PurchaseTravelTicket";
  if ("UseTravelTicket" in command) return "UseTravelTicket";
  if ("ToggleDoor" in command) return "ToggleDoor";
  if ("CraftItem" in command) return "CraftItem";
  if ("CraftBegin" in command) return "CraftBegin";
  if ("CraftAssignSlot" in command) return "CraftAssignSlot";
  if ("CraftClearSlot" in command) return "CraftClearSlot";
  if ("CraftAssemble" in command) return "CraftAssemble";
  if ("CraftExperiment" in command) return "CraftExperiment";
  if ("CraftFinalizePrototype" in command) return "CraftFinalizePrototype";
  if ("CraftFinalizePractice" in command) return "CraftFinalizePractice";
  if ("CraftDraftSchematic" in command) return "CraftDraftSchematic";
  if ("FactoryManufacture" in command) return "FactoryManufacture";
  if ("CraftCancel" in command) return "CraftCancel";
  if ("RequestStarterTool" in command) return "RequestStarterTool";
  if ("PurchaseSkillBox" in command) return "PurchaseSkillBox";
  if ("UnlearnSkillBox" in command) return "UnlearnSkillBox";
  if ("SetProfessionTitle" in command) return "SetProfessionTitle";
  if ("SetCareerGoal" in command) return "SetCareerGoal";
  if ("SetPosture" in command) return "SetPosture";
  if ("StoreToExchange" in command) return "StoreToExchange";
  if ("RetrieveFromExchange" in command) return "RetrieveFromExchange";
  if ("SplitStack" in command) return "SplitStack";
  if ("MergeStacks" in command) return "MergeStacks";
  if ("DiscardStack" in command) return "DiscardStack";
  if ("RedeemCreditChip" in command) return "RedeemCreditChip";
  if ("QueueCombatAction" in command) return "QueueCombatAction";
  if ("Peace" in command) return "Peace";
  if ("CancelAbilityQueue" in command) return "CancelAbilityQueue";
  if ("ProposeTrade" in command) return "ProposeTrade";
  if ("AcceptTrade" in command) return "AcceptTrade";
  if ("DeclineTrade" in command) return "DeclineTrade";
  if ("AddTradeItem" in command) return "AddTradeItem";
  if ("RemoveTradeItem" in command) return "RemoveTradeItem";
  if ("SetTradeCoin" in command) return "SetTradeCoin";
  if ("ConfirmTrade" in command) return "ConfirmTrade";
  if ("GroupInvite" in command) return "GroupInvite";
  if ("GroupAccept" in command) return "GroupAccept";
  if ("GroupDecline" in command) return "GroupDecline";
  if ("GroupLeave" in command) return "GroupLeave";
  if ("GroupDisband" in command) return "GroupDisband";
  if ("GroupKick" in command) return "GroupKick";
  if ("GuildCreate" in command) return "GuildCreate";
  if ("GuildInvite" in command) return "GuildInvite";
  if ("GuildAcceptInvite" in command) return "GuildAcceptInvite";
  if ("GuildDeclineInvite" in command) return "GuildDeclineInvite";
  if ("GuildLeave" in command) return "GuildLeave";
  if ("GuildKick" in command) return "GuildKick";
  if ("GuildSetRole" in command) return "GuildSetRole";
  if ("GuildSetPermissions" in command) return "GuildSetPermissions";
  if ("GuildTransferLeadership" in command) return "GuildTransferLeadership";
  if ("GuildDeclareWar" in command) return "GuildDeclareWar";
  if ("GuildAcceptWar" in command) return "GuildAcceptWar";
  if ("GuildRescindWar" in command) return "GuildRescindWar";
  if ("GuildDisband" in command) return "GuildDisband";
  if ("DuelChallenge" in command) return "DuelChallenge";
  if ("DuelAccept" in command) return "DuelAccept";
  if ("DuelDecline" in command) return "DuelDecline";
  if ("DuelYield" in command) return "DuelYield";
  if ("Deathblow" in command) return "Deathblow";
  if ("GeneSample" in command) return "GeneSample";
  if ("ScanGenome" in command) return "ScanGenome";
  if ("SpliceBegin" in command) return "SpliceBegin";
  if ("SpliceAssignSlot" in command) return "SpliceAssignSlot";
  if ("SpliceClearSlot" in command) return "SpliceClearSlot";
  if ("SpliceChooseAllele" in command) return "SpliceChooseAllele";
  if ("SpliceAssemble" in command) return "SpliceAssemble";
  if ("SpliceExperimentLocus" in command) return "SpliceExperimentLocus";
  if ("SpliceMint" in command) return "SpliceMint";
  if ("SpliceCancel" in command) return "SpliceCancel";
  if ("ClaimParcel" in command) return "ClaimParcel";
  if ("AbandonParcel" in command) return "AbandonParcel";
  if ("RenameParcel" in command) return "RenameParcel";
  if ("PayUpkeep" in command) return "PayUpkeep";
  if ("TillTile" in command) return "TillTile";
  if ("PlantSeed" in command) return "PlantSeed";
  if ("ClearTile" in command) return "ClearTile";
  if ("WaterTile" in command) return "WaterTile";
  if ("TendPlot" in command) return "TendPlot";
  if ("PlaceFarmStructure" in command) return "PlaceFarmStructure";
  if ("RemoveFarmStructure" in command) return "RemoveFarmStructure";
  if ("Fertilize" in command) return "Fertilize";
  if ("HarvestCrop" in command) return "HarvestCrop";
  if ("BuildPlace" in command) return "BuildPlace";
  if ("BuildRemove" in command) return "BuildRemove";
  if ("BuildToggleDoor" in command) return "BuildToggleDoor";
  return "EnterTransition";
}

export function createEmptyAuthorityCommandKindCounts(): Record<AuthorityClientCommandKind, number> {
  return {
    Move: 0,
    SetMoveIntent: 0,
    ReloadWeapon: 0,
    SetEquippedWeapon: 0,
    SetEquippedClothing: 0,
    EnterTransition: 0,
    UseConsumable: 0,
    RefillAmmo: 0,
    ApplyServiceBuff: 0,
    CloneRespawn: 0,
    ReviveActor: 0,
    SampleResource: 0,
    SurveyResource: 0,
    PlaceExtractor: 0,
    CrankExtractor: 0,
    StopCrank: 0,
    InsertBattery: 0,
    CollectExtractor: 0,
    DestroyExtractor: 0,
    PlaceCamp: 0,
    PackUpCamp: 0,
    HarvestCorpse: 0,
    BankStoreItem: 0,
    BankRetrieveItem: 0,
    BankDepositCredits: 0,
    BankWithdrawCredits: 0,
    CloneSaveSkillBackup: 0,
    CorpseTakeCredits: 0,
    TakeLootItem: 0,
    PurchaseTravelTicket: 0,
    UseTravelTicket: 0,
    ToggleDoor: 0,
    CraftItem: 0,
    CraftBegin: 0,
    CraftAssignSlot: 0,
    CraftClearSlot: 0,
    CraftAssemble: 0,
    CraftExperiment: 0,
    CraftFinalizePrototype: 0,
    CraftFinalizePractice: 0,
    CraftDraftSchematic: 0,
    FactoryManufacture: 0,
    CraftCancel: 0,
    RequestStarterTool: 0,
    PurchaseSkillBox: 0,
    UnlearnSkillBox: 0,
    SetProfessionTitle: 0,
    SetCareerGoal: 0,
    SetPosture: 0,
    StoreToExchange: 0,
    RetrieveFromExchange: 0,
    SplitStack: 0,
    MergeStacks: 0,
    DiscardStack: 0,
    RedeemCreditChip: 0,
    QueueCombatAction: 0,
    Peace: 0,
    CancelAbilityQueue: 0,
    ProposeTrade: 0,
    AcceptTrade: 0,
    DeclineTrade: 0,
    AddTradeItem: 0,
    RemoveTradeItem: 0,
    SetTradeCoin: 0,
    ConfirmTrade: 0,
    GroupInvite: 0,
    GroupAccept: 0,
    GroupDecline: 0,
    GroupLeave: 0,
    GroupDisband: 0,
    GroupKick: 0,
    GuildCreate: 0,
    GuildInvite: 0,
    GuildAcceptInvite: 0,
    GuildDeclineInvite: 0,
    GuildLeave: 0,
    GuildKick: 0,
    GuildSetRole: 0,
    GuildSetPermissions: 0,
    GuildTransferLeadership: 0,
    GuildDeclareWar: 0,
    GuildAcceptWar: 0,
    GuildRescindWar: 0,
    GuildDisband: 0,
    DuelChallenge: 0,
    DuelAccept: 0,
    DuelDecline: 0,
    DuelYield: 0,
    Deathblow: 0,
    GeneSample: 0,
    ScanGenome: 0,
    SpliceBegin: 0,
    SpliceAssignSlot: 0,
    SpliceClearSlot: 0,
    SpliceChooseAllele: 0,
    SpliceAssemble: 0,
    SpliceExperimentLocus: 0,
    SpliceMint: 0,
    SpliceCancel: 0,
    ClaimParcel: 0,
    AbandonParcel: 0,
    RenameParcel: 0,
    PayUpkeep: 0,
    TillTile: 0,
    PlantSeed: 0,
    ClearTile: 0,
    WaterTile: 0,
    TendPlot: 0,
    PlaceFarmStructure: 0,
    RemoveFarmStructure: 0,
    Fertilize: 0,
    HarvestCrop: 0,
    BuildPlace: 0,
    BuildRemove: 0,
    BuildToggleDoor: 0,
  };
}

function normalizeTravelId(value: string): string | null {
  const normalized = value
    .trim()
    .replace(/[^A-Za-z0-9_.:-]/g, "")
    .slice(0, 96);
  if (normalized.length === 0) return null;
  return normalized;
}

function clampExperimentPoints(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(20, Math.trunc(value)));
}

export function authorityDirectionFromFacing(direction: Direction): AuthorityCardinalDirection {
  switch (cardinalDirectionForVisualDirection(direction)) {
    case "front":
      return "Front";
    case "right":
      return "Right";
    case "back":
      return "Back";
    case "left":
      return "Left";
  }
}

export function authorityMoveCommandWithFacing(
  dx: number,
  dy: number,
  durationTicks: number,
  facing: Direction,
  sprint = false,
): AuthorityClientCommand | null {
  const move = authorityMoveCommand(dx, dy, durationTicks, sprint);
  if (!move || !("Move" in move)) return null;
  return {
    Move: {
      ...move.Move,
      facing: authorityDirectionFromFacing(facing),
    },
  };
}

export function authorityMoveIntentCommandWithFacing(
  dx: number,
  dy: number,
  facing: Direction,
  sprint = false,
): AuthorityClientCommand | null {
  return authorityMoveIntentCommand(dx, dy, authorityDirectionFromFacing(facing), sprint);
}

export function authorityMoveIntentDurationTicks(tickRateHz: number): number {
  const hz = Number.isFinite(tickRateHz) && tickRateHz > 0 ? tickRateHz : 30;
  return Math.max(1, Math.min(maxMoveDurationTicks, Math.round(hz / targetMoveCommandsPerSecond)));
}

export function authorityMoveCommandIntervalMs(tickRateHz: number): number {
  const hz = Number.isFinite(tickRateHz) && tickRateHz > 0 ? tickRateHz : 30;
  return (authorityMoveIntentDurationTicks(hz) / hz) * 1000;
}

export function authorityIssuedAtTick(
  worldTimeMs: number,
  tickRateHz: number,
  fallbackTick: number,
): number {
  const hz = Number.isFinite(tickRateHz) && tickRateHz > 0 ? tickRateHz : 20;
  const tickFromTime = elapsedAuthorityTicks(Math.max(0, worldTimeMs), hz);
  return Math.max(0, Math.trunc(Math.max(fallbackTick, tickFromTime)));
}

export function authorityIssuedAtServerTick(
  state: {
    worldTimeMs: number;
    serverAuthority?: {
      snapshotTick: number;
      lastSnapshotReceivedAtMs: number | null;
    };
  },
  tickRateHz: number,
  fallbackTick: number,
  commandWorldTimeMs = state.worldTimeMs,
): number {
  const hz = Number.isFinite(tickRateHz) && tickRateHz > 0 ? tickRateHz : 20;
  const receivedAtMs = state.serverAuthority?.lastSnapshotReceivedAtMs;
  const snapshotTick = state.serverAuthority?.snapshotTick;
  if (typeof receivedAtMs === "number" && Number.isFinite(receivedAtMs)
    && typeof snapshotTick === "number" && Number.isFinite(snapshotTick)) {
    const elapsedMs = Math.max(0, commandWorldTimeMs - receivedAtMs);
    const elapsedTicks = elapsedAuthorityTicks(elapsedMs, hz);
    return Math.max(0, Math.trunc(Math.max(fallbackTick, snapshotTick + elapsedTicks)));
  }
  return authorityIssuedAtTick(commandWorldTimeMs, tickRateHz, fallbackTick);
}

function elapsedAuthorityTicks(elapsedMs: number, tickRateHz: number): number {
  return Math.floor((elapsedMs / (1000 / tickRateHz)) + 1e-6);
}

export function authorityCommandQueueProbe(
  queue: AuthorityCommandQueue | null | undefined,
): AuthorityCommandQueueProbe {
  if (!queue) {
    return {
      schema: "successor.client-authority-command-queue.v1",
      session: 1,
      player: 1,
      nextCommandId: 1,
      pendingCount: 0,
      inFlight: null,
      totalQueued: 0,
      totalByKind: createEmptyAuthorityCommandKindCounts(),
      lastPending: null,
    };
  }
  return {
    schema: queue.schema,
    session: queue.session,
    player: queue.player,
    nextCommandId: queue.nextCommandId,
    inFlight: queue.inFlight,
    pendingCount: queue.pending.length + (queue.inFlight ? 1 : 0),
    totalQueued: queue.totalQueued,
    totalByKind: { ...createEmptyAuthorityCommandKindCounts(), ...(queue.totalByKind ?? {}) },
    lastPending: queue.pending.at(-1) ?? null,
  };
}
