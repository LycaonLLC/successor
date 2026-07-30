import { randomBytes } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface, type Interface } from "node:readline";
import type { FastifyBaseLogger } from "fastify";

import type { AbilityQueueEvent, AbilityQueueView, ClientCommandEnvelope, GameActorAppearanceSnapshot, GameActorCombatQueueSnapshot, GameActorPosture, GameActorWornPiece, GameCombatActionId, GameCommandReceipt, GameCraftSession, GameDuelOutcome, GameDuelView, GameDraftedSchematic, GameGenomeScan, GameGroupView, GameGuildView, GameSpliceSession, GameTradeSession, GameTradeSessionDelivery, GameResourceSpawn, GameSurveyResult, PlacedCampVM, PlacedExtractorVM, ParcelVM, FarmPlotVM } from "./protocol.js";

export const rustAuthorityTimelineEventCapacity = 256;
const defaultCraftRollKey = "00".repeat(32);

export interface RustAuthorityBridgeOptions {
  enabled?: boolean;
  slicePath: string;
  cwd?: string;
  logger?: Pick<FastifyBaseLogger, "warn" | "debug" | "info">;
  areaInterestRadiusCells?: number;
  command?: string;
  args?: string[];
  /** Hex-encoded 32-byte key; omitted in production to generate once per bridge. */
  craftRollKey?: string;
}
export interface RustAuthorityBridgeDebugStatus {
  closed: boolean;
  childKilled: boolean;
  childExitCode: number | null;
  childSignalCode: NodeJS.Signals | null;
  nextRequestId: number;
  diagnosticPending: number;
  livePending: number;
  /** Recurring fixed-cadence ticks currently executing; not request work awaiting drain. */
  cadencePending: number;
  /** Live authority operations other than the recurring cadence tick. */
  workloadLivePending: number;
  commandBatchPending: number;
  commandBatches: number;
  commandBatchPendingItems: number;
  backlogSize: number;
  /** Delivery/workload authority operations awaiting drain; excludes cadencePending only. */
  workloadBacklogSize: number;
  timings: {
    liveRequests: Record<string, RustAuthorityBridgeTimingSummary>;
  };
  timeouts: Record<string, number>;
}

export interface RustAuthorityBridgeTimingSummary {
  count: number;
  lastMs: number;
  avgMs: number;
  p95Ms: number;
  maxMs: number;
}


export interface RustAuthorityDiagnosticObservation {
  actorId: string;
  envelope: ClientCommandEnvelope;
  receipt: GameCommandReceipt;
}

interface RustAuthorityDiagnosticPending {
  actorId: string;
  commandId: number;
  receipt: GameCommandReceipt;
  commandKind: string;
}

interface RustAuthorityLivePending {
  resolve(output: RustAuthorityBridgeStepOutput | RustAuthorityBridgeTickOutput | RustAuthorityBridgeActorOutput | RustAuthorityBridgeDebugOutput | RustAuthorityBridgeExportStateOutput | RustAuthorityBridgeImportStateOutput | RustAuthorityBridgeExchangeMetricsOutput): void;
  reject(error: Error): void;
  timeout: NodeJS.Timeout;
  requestType: string;
  startedAtMs: number;
}

interface RustAuthorityCommandBatchPending {
  request: RustAuthorityStepRequest;
  resolve(output: RustAuthorityBridgeStepOutput): void;
  reject(error: Error): void;
  timeout?: NodeJS.Timeout;
  settled: boolean;
  batchRequestId?: number;
}
export interface RustAuthorityStepRequest {
  requestId: number;
  config: {
    session: number;
    player: number;
    playerActorId: string;
    areaInterestRadiusCells: number;
    craftRollKey: string;
  };
  envelope: ClientCommandEnvelope;
}

export interface RustAuthorityBatchRequest {
  type: "batch";
  requestId: number;
  steps: RustAuthorityStepRequest[];
}

export interface RustAuthorityWeatherShelterInput {
  minXMilli: number;
  minYMilli: number;
  maxXMilli: number;
  maxYMilli: number;
}

export interface RustAuthorityWeatherHazardInput {
  areaId: string;
  centerXMilli: number;
  centerYMilli: number;
  radiusMilli: number;
  dpsMilliHealth: number;
  shelters: RustAuthorityWeatherShelterInput[];
}

export interface RustAuthorityTickRequest {
  type: "tick";
  requestId: number;
  ticks: number;
  includeAiDebug?: boolean;
  config: {
    session: number;
    player: number;
    playerActorId: string;
    areaInterestRadiusCells: number;
    craftRollKey: string;
  };
  weatherHazards: RustAuthorityWeatherHazardInput[];
  weatherHazardsByTick?: RustAuthorityWeatherHazardInput[][];
}

export interface RustAuthorityDebugRequest {
  type: "debug";
  requestId: number;
}

export interface RustAuthorityMetricsRequest {
  type: "metrics";
  requestId: number;
}

export type RustAuthorityStateBlob = {
  schema?: string;
  version?: number;
  stateHash?: string;
  [key: string]: unknown;
};

export interface RustAuthorityExportStateRequest {
  type: "exportState";
  requestId: number;
}

export interface RustAuthorityImportStateRequest {
  type: "importState";
  requestId: number;
  state: RustAuthorityStateBlob;
  expectedStateHash?: string;
}

export interface RustAuthorityExchangeTotalsSnapshot {
  active?: number;
  closedRetained?: number;
  closedLifetime?: number;
  swings?: number;
  hits?: number;
  misses?: number;
  deflects?: number;
  blocks?: number;
  damage?: number;
}

export interface RustAuthorityExchangeSnapshotBase {
  participants?: string[];
  weaponsUsed?: string[];
  openedTick?: number;
  durationTicks?: number;
  outcome?: string;
  area?: string;
  swings?: number;
  hits?: number;
  misses?: number;
  deflects?: number;
  blocks?: number;
  damageDealt?: Record<string, number>;
  damageTaken?: Record<string, number>;
}

export interface RustAuthorityActiveExchangeSnapshot extends RustAuthorityExchangeSnapshotBase {
  lastActivityTick?: number;
}

export interface RustAuthorityClosedExchangeSnapshot extends RustAuthorityExchangeSnapshotBase {
  closedTick?: number;
}

export interface RustAuthorityWeaponExchangeCounterSnapshot {
  weapon?: string;
  swings?: number;
  closedExchanges?: number;
  totalTtkTicks?: number;
  meanTtkTicks?: number;
  totalDamage?: number;
  meanDamagePerExchange?: number;
}

export interface RustAuthorityExchangeMetricsSnapshot {
  schema?: string;
  tick?: number;
  ringCapacity?: number;
  activeExchanges?: RustAuthorityActiveExchangeSnapshot[];
  closedExchanges?: RustAuthorityClosedExchangeSnapshot[];
  weaponCounters?: RustAuthorityWeaponExchangeCounterSnapshot[];
  totals?: RustAuthorityExchangeTotalsSnapshot;
}

export interface RustAuthorityActorRequest {
  type: "upsertActor";
  requestId: number;
  actor: RustAuthorityActorUpsertInput;
}

export interface RustAuthorityRemoveActorRequest {
  type: "removeActor";
  requestId: number;
  actorId: string;
  purgeInventory?: boolean;
}

export interface RustAuthorityLinkDeadActorRequest {
  type: "setActorLinkDead";
  requestId: number;
  actorId: string;
  linkDead: boolean;
  deadlineTick?: number;
}

export interface RustAuthorityRelocateActorRequest {
  type: "relocateActor";
  requestId: number;
  actorId: string;
  areaId: string;
  x: number;
  y: number;
  direction: string;
}

export interface RustAuthorityRestockActorRequest {
  type: "restockActorLoadout";
  requestId: number;
  actorId: string;
}

export interface RustAuthorityDoorStateRequest {
  type: "setDoorOpen";
  requestId: number;
  propId: string;
  doorOpen: boolean;
}
export interface RustAuthorityVerificationLoadoutItem {
  itemId: number;
  variantId: number;
  quantity: number;
  equipped: boolean;
}


export interface RustAuthorityActorUpsertInput {
  id: string;
  areaId: string;
  x: number;
  y: number;
  direction: string;
  entity?: string;
  label?: string;
  displayName?: string;
  linkDead?: boolean;
  bareStart?: boolean;
  /** Resume an existing durable actor without changing owned inventory rows. */
  returning?: boolean;
  verificationLoadout?: readonly RustAuthorityVerificationLoadoutItem[];
  appearance?: GameActorAppearanceSnapshot;
  worn?: readonly GameActorWornPiece[];
  wornColors?: Record<string, string[]>;
  sprite?: string | null;
  role?: string;
  professionIds?: string[];
  skillBoxIds?: string[];
  /** Exact banked XP restored only when a retired durable actor is rebuilt. */
  professionXp?: Record<string, number>;
  professionTrackXp?: Record<string, number>;
  skillPointCap?: number;
  activeTitleId?: string | null;
  credits?: number;
  capabilities?: string[];
  careerGoalId?: string | null;
  factionId?: string | null;
  socialGroup?: string | null;
  pvpStatus?: string | null;
  playerOrganizationId?: string | null;
  playerOrganizationTag?: string | null;
  scale?: number;
  vitals?: {
    health: number;
    action: number;
    spirit: number;
  };
  maxVitals?: {
    health: number;
    action: number;
    spirit: number;
  };
}

export interface RustAuthorityAiDebugSnapshot {
  schema: string;
  tick: number;
  squads: RustAuthorityAiSquadDebugSnapshot[];
  actors: RustAuthorityAiActorDebugSnapshot[];
}

export interface RustAuthorityAiDebugPosition {
  xMilli: number;
  yMilli: number;
  cellX: number;
  cellY: number;
}

export interface RustAuthorityAiSquadDebugSnapshot {
  squadId: string;
  areaId: string;
  faction: string;
  order: string;
  confidence: string;
  memberCount: number;
  enemyCount: number;
  center: RustAuthorityAiDebugPosition;
  enemyCenter?: RustAuthorityAiDebugPosition | null;
  directionXMilli: number;
  directionYMilli: number;
  frontWidthMilli: number;
  noMansLand?: RustAuthorityAiDebugPosition | null;
  strengthMilli: number;
  enemyStrengthMilli: number;
}

export interface RustAuthorityAiActorDebugSnapshot {
  actorId: string;
  squadId?: string | null;
  faction?: string | null;
  variant: string;
  mode: string;
  order: string;
  confidence: string;
  targetActorId?: string | null;
  target?: RustAuthorityAiDebugPosition | null;
  cover?: RustAuthorityAiDebugPosition | null;
  moveTarget?: RustAuthorityAiDebugPosition | null;
  slotClaim?: RustAuthorityAiDebugPosition | null;
  laneIndex?: number | null;
  laneCount?: number | null;
  reason: string;
  candidates: RustAuthorityAiTacticalCandidateDebug[];
}

export interface RustAuthorityAreaResourceSpawnsSnapshot {
  areaId: string;
  resourceSpawns: GameResourceSpawn[];
}

export interface RustAuthorityBuildComponentSnapshot {
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

export interface RustAuthorityInteriorRegionSnapshot {
  interiorId: string;
  areaId: string;
  parcelId: string;
  cellKeys: string[];
  roofed: boolean;
  enclosed: boolean;
  doorComponentIds: string[];
}

export interface RustAuthorityBuildDeltaPayload {
  schema: string;
  tick: number;
  components: RustAuthorityBuildComponentSnapshot[];
  interiors: RustAuthorityInteriorRegionSnapshot[];
}

export interface RustAuthorityAiTacticalCandidateDebug {
  stage: string;
  kind: string;
  position: RustAuthorityAiDebugPosition;
  score: number;
  accepted: boolean;
  rejection?: string | null;
  hasShot: boolean;
  protected: boolean;
  pathable: boolean;
  terrainPathable: boolean;
  pathfinderPathable: boolean;
  bodyBlocked: boolean;
  claimed: boolean;
  insideLane: boolean;
  crossesNoMansLand: boolean;
  rangeErrorMilli: number;
  laneErrorMilli: number;
  coverPropId?: string | null;
}

export interface RustAuthorityDialogueDelivery {
  actorId?: string;
  speaker?: string;
  body?: string;
  areaId?: string;
  x?: number;
  y?: number;
  tick?: number;
}

export interface RustAuthorityBridgeStepOutput {
  schema?: string;
  requestId?: number;
  commandId?: number;
  status?: "accepted" | "rejected";
  reasonCode?: string | null;
  tick?: number;
  commandHash?: string;
  frameHash?: string;
  targetStateHash?: string;
  dialogueDeliveries?: RustAuthorityDialogueDelivery[];
  bundleHash?: string;
  sectionSubsystems?: string[];
  actor?: RustAuthorityActorSnapshot | null;
  actors?: RustAuthorityActorSnapshot[];
  combatEvents?: RustAuthorityCombatEventSnapshot[];
  abilityQueueEvents?: RustAuthorityAbilityQueueEventSnapshot[];
  surveyResult?: GameSurveyResult | null;
  craftSession?: GameCraftSession | null;
  spliceSession?: GameSpliceSession | null;
  genomeScan?: GameGenomeScan | null;
  tradeSession?: GameTradeSession | null;
  tradeSessionDeliveries?: GameTradeSessionDelivery[];
  duelOutcomes?: GameDuelOutcome[];
  factoryReceipt?: {
    factoryId: string;
    schematicId: string;
    recipeId: string;
    outputItemId: number;
    outputVariantId: number;
    outputQuantity: number;
    remainingUses: number;
    maxUses: number;
    spent: boolean;
    tick: number;
  } | null;
  draftedSchematics?: GameDraftedSchematic[];
  inventory?: RustAuthorityInventorySnapshot[];
  bank?: RustAuthorityBankSnapshot | null;
  playerCorpses?: RustAuthorityPlayerCorpseSnapshot[];
  reservations?: RustAuthorityReservationSnapshot[];
  npcJobs?: RustAuthorityNpcJobSnapshot[];
  timelineEvents?: RustAuthorityTimelineEventSnapshot[];
  resourceSpawns?: GameResourceSpawn[];
  areaResourceSpawns?: RustAuthorityAreaResourceSpawnsSnapshot[];
  placedExtractors?: PlacedExtractorVM[];
  placedCamps?: PlacedCampVM[];
  placedParcels?: ParcelVM[];
  farmPlots?: FarmPlotVM[];
  building?: RustAuthorityBuildDeltaPayload;
  groupViewsByActorId?: Record<string, GameGroupView>;
  guildViewsByActorId?: Record<string, GameGuildView>;
  duelViewsByActorId?: Record<string, GameDuelView>;
  metrics?: {
    tick?: number;
    shotsFired?: number;
    combatEvents?: number;
    hits?: number;
    deaths?: number;
    inventoryStacks?: number;
    reservations?: number;
    npcJobs?: number;
    placedExtractors?: number;
    timelineEvents?: number;
  };
  aiDebug?: RustAuthorityAiDebugSnapshot;
}

interface RustAuthorityBridgeBatchOutput {
  schema?: string;
  requestId?: number;
  tick?: number;
  metrics?: RustAuthorityBridgeStepOutput["metrics"];
  steps?: RustAuthorityBridgeStepOutput[];
}

export interface RustAuthorityBridgeExportStateOutput {
  schema?: string;
  requestId?: number;
  tick?: number;
  stateHash?: string;
  state: RustAuthorityStateBlob;
}

export type RustAuthorityBridgeImportStateOutput = RustAuthorityBridgeTickOutput;

export interface RustAuthorityBridgeExchangeMetricsOutput {
  schema?: string;
  requestId?: number;
  tick?: number;
  exchangeMetrics?: RustAuthorityExchangeMetricsSnapshot;
}

export interface RustAuthorityBridgeTickOutput {
  schema?: string;
  requestId?: number;
  tick?: number;
  targetStateHash?: string;
  actors?: RustAuthorityActorSnapshot[];
  removedActorIds?: string[];
  logoutActors?: RustAuthorityActorSnapshot[];
  combatEvents?: RustAuthorityCombatEventSnapshot[];
  abilityQueueEvents?: RustAuthorityAbilityQueueEventSnapshot[];
  dialogueDeliveries?: RustAuthorityDialogueDelivery[];
  inventory?: RustAuthorityInventorySnapshot[];
  bank?: RustAuthorityBankSnapshot | null;
  playerCorpses?: RustAuthorityPlayerCorpseSnapshot[];
  reservations?: RustAuthorityReservationSnapshot[];
  npcJobs?: RustAuthorityNpcJobSnapshot[];
  timelineEvents?: RustAuthorityTimelineEventSnapshot[];
  resourceSpawns?: GameResourceSpawn[];
  areaResourceSpawns?: RustAuthorityAreaResourceSpawnsSnapshot[];
  placedExtractors?: PlacedExtractorVM[];
  placedCamps?: PlacedCampVM[];
  placedParcels?: ParcelVM[];
  farmPlots?: FarmPlotVM[];
  building?: RustAuthorityBuildDeltaPayload;
  factoryReceipt?: {
    factoryId: string;
    schematicId: string;
    recipeId: string;
    outputItemId: number;
    outputVariantId: number;
    outputQuantity: number;
    remainingUses: number;
    maxUses: number;
    spent: boolean;
    tick: number;
  } | null;
  draftedSchematics?: GameDraftedSchematic[];
  groupViewsByActorId?: Record<string, GameGroupView>;
  guildViewsByActorId?: Record<string, GameGuildView>;
  duelViewsByActorId?: Record<string, GameDuelView>;
  duelOutcomes?: GameDuelOutcome[];
  metrics?: {
    tick?: number;
    shotsFired?: number;
    combatEvents?: number;
    hits?: number;
    deaths?: number;
    inventoryStacks?: number;
    reservations?: number;
    npcJobs?: number;
    placedExtractors?: number;
    timelineEvents?: number;
  };
  timing?: {
    requestedTicks?: number;
    advanceUs?: number;
    advance?: {
      ticks?: number;
      totalUs?: number;
      aiUs?: number;
      aiTacticalStateUs?: number;
      aiPassiveCreatureUs?: number;
      aiSkirmisherUs?: number;
      aiTacticalStateRebuilt?: number;
      aiTacticalStateReused?: number;
      aiUpdates?: number;
      aiSkipped?: number;
      routeUs?: number;
      pathQueries?: number;
      pathExpansions?: number;
    };
    actorSnapshotUs?: number;
    inventoryUs?: number;
    reservationsUs?: number;
    npcJobsUs?: number;
    timelineEventsUs?: number;
    stateHashUs?: number;
    metricsUs?: number;
    aiDebugUs?: number;
    totalBeforeSerializeUs?: number;
  };
  aiDebug?: RustAuthorityAiDebugSnapshot;
}

export interface RustAuthorityBridgeDebugOutput {
  schema?: string;
  requestId?: number;
  tick?: number;
  areaResourceSpawns?: RustAuthorityAreaResourceSpawnsSnapshot[];
  placedExtractors?: PlacedExtractorVM[];
  placedCamps?: PlacedCampVM[];
  placedParcels?: ParcelVM[];
  farmPlots?: FarmPlotVM[];
  building?: RustAuthorityBuildDeltaPayload;
  factoryReceipt?: {
    factoryId: string;
    schematicId: string;
    recipeId: string;
    outputItemId: number;
    outputVariantId: number;
    outputQuantity: number;
    remainingUses: number;
    maxUses: number;
    spent: boolean;
    tick: number;
  } | null;
  draftedSchematics?: GameDraftedSchematic[];
  aiDebug?: RustAuthorityAiDebugSnapshot;
}

export interface RustAuthorityBridgeActorOutput {
  schema?: string;
  requestId?: number;
  tick?: number;
  targetStateHash?: string;
  actor?: RustAuthorityActorSnapshot | null;
  inventory?: RustAuthorityInventorySnapshot[];
  bank?: RustAuthorityBankSnapshot | null;
  playerCorpses?: RustAuthorityPlayerCorpseSnapshot[];
  reservations?: RustAuthorityReservationSnapshot[];
  timelineEvents?: RustAuthorityTimelineEventSnapshot[];
  resourceSpawns?: GameResourceSpawn[];
  areaResourceSpawns?: RustAuthorityAreaResourceSpawnsSnapshot[];
  placedExtractors?: PlacedExtractorVM[];
  placedCamps?: PlacedCampVM[];
  placedParcels?: ParcelVM[];
  farmPlots?: FarmPlotVM[];
  building?: RustAuthorityBuildDeltaPayload;
  factoryReceipt?: {
    factoryId: string;
    schematicId: string;
    recipeId: string;
    outputItemId: number;
    outputVariantId: number;
    outputQuantity: number;
    remainingUses: number;
    maxUses: number;
    spent: boolean;
    tick: number;
  } | null;
  draftedSchematics?: GameDraftedSchematic[];
  groupViewsByActorId?: Record<string, GameGroupView>;
  duelViewsByActorId?: Record<string, GameDuelView>;
  duelOutcomes?: GameDuelOutcome[];
  metrics?: {
    tick?: number;
    shotsFired?: number;
    combatEvents?: number;
    hits?: number;
    deaths?: number;
    inventoryStacks?: number;
    reservations?: number;
    npcJobs?: number;
    timelineEvents?: number;
    placedExtractors?: number;
  };
}

export interface RustAuthorityBridgeDoorStateOutput {
  schema?: string;
  requestId?: number;
  tick?: number;
  propId?: string;
  doorOpen?: boolean;
  applied?: boolean;
  targetStateHash?: string;
  metrics?: RustAuthorityBridgeStepOutput["metrics"];
}

export interface RustAuthorityResourceStatsSnapshot {
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

export interface RustAuthorityInventorySnapshot {
  container: string;
  stackId: number;
  item: string;
  itemId: number;
  variantId: number;
  quantity: number;
  reserved: number;
  equipped?: boolean;
  colors?: string[];
  available: number;
  /** Full Rust-authoritative resource stat block; absent for non-resources or invalid encodings. */
  resourceStats?: RustAuthorityResourceStatsSnapshot;
  /** Optional structured resource potency (1-1000); additive for older bridge rows. */
  potency?: number;
  /** Optional structured resource purity (Rust chemical_purity, 1-1000); additive for older bridge rows. */
  purity?: number;
  /** Additive stable string item id for non-Rust or metadata-heavy items. */
  itemKey?: string;
  /** Additive structured item metadata; travel tickets use metadata.travelTicket. */
  metadata?: Record<string, unknown>;
}
export interface RustAuthorityBankItemSnapshot {
  container: string;
  stackId: number | string;
  item: string;
  itemId: number;
  variantId: number;
  quantity: number;
  reserved: number;
  available: number;
}
export interface RustAuthorityBankSnapshot {
  actorId?: string;
  bankCredits: number;
  items: RustAuthorityBankItemSnapshot[];
  backupPresent: boolean;
  backupSavedTick?: number | null;
  backupSkillCount: number;
  backupCost: number;
}

export interface RustAuthorityPlayerCorpseSnapshot {
  id: string;
  ownerActorId: string;
  ownerLabel: string;
  areaId: string;
  cell: { x: number; y: number };
  position: { x: number; y: number };
  expiryTick: number;
  hasItems: boolean;
  creditsPresent: boolean;
  creditsCount: number;
  isOwner: boolean;
  container: string;
}


export interface RustAuthorityReservationSnapshot {
  id: number;
  actor: string;
  purpose: string;
  from: string;
  item: string;
  quantity: number;
  expiresAtTick?: number | null;
}

export interface RustAuthorityNpcJobSnapshot {
  actor: string;
  kind: string;
  label: string;
  targetPropId?: string | null;
  targetCell?: { x: number; y: number } | null;
  priority: number;
  state: string;
}

export interface RustAuthorityTimelineEventSnapshot {
  tick: number;
  label: string;
  cell?: { x: number; y: number } | null;
}

export interface RustAuthorityProfessionSnapshot {
  id: string;
  label: string;
  xp: number;
  trackXp?: Record<string, number>;
  skillPoints: number;
  skillBoxes?: string[];
}

export interface RustAuthorityProfessionTitleSnapshot {
  id: string;
  label: string;
  skillBoxId: string;
}

export interface RustAuthorityActorCapabilitySnapshot {
  id: string;
}

export interface RustAuthorityPersonalShieldSnapshot {
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

export interface RustAuthorityActorSnapshot {
  id: string;
  entity?: string;
  label?: string;
  display_name?: string;
  displayName?: string;
  descriptor?: string;
  link_dead?: boolean;
  linkDead?: boolean;
  appearance?: GameActorAppearanceSnapshot;
  /** Rust-authoritative worn clothing projection, including per-piece colors. */
  worn?: readonly GameActorWornPiece[];
  sprite?: string | null;
  role?: string;
  scale?: number;
  templateId?: string | null;
  spawnZoneId?: string | null;
  areaId: string;
  x: number;
  y: number;
  direction: string;
  posture?: GameActorPosture | string | null;
  postureUntilTick?: number;
  factionId?: string | null;
  socialGroup?: string | null;
  pvpStatus?: string | null;
  aiAttitude?: "passive" | "alerted" | "hostile" | string | null;
  willAutoAggro?: boolean;
  playerOrganizationId?: string | null;
  playerOrganizationTag?: string | null;
  lifeState: string;
  lifecycleSeq: number;
  vitals: {
    health: number;
    action: number;
    spirit: number;
  };
  maxVitals: {
    health: number;
    action: number;
    spirit: number;
  };
  bleed: {
    active: boolean;
    stackCount: number;
    remainingTicks: number;
    damagePerTick: number;
    damagePerSecondMilli?: number;
  };
  sleep: {
    active: boolean;
    stacks: number;
    threshold: number;
    remainingTicks: number;
  };
  suppression?: {
    active: boolean;
    pressure: number;
    remainingTicks: number;
    source?: { x: number; y: number } | null;
  };
  mobility?: {
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
  };
  stats?: RustAuthorityActorStatsSnapshot;
  activeEffects?: Array<{
    id: string;
    label: string;
    kind: string;
    remainingTicks: number;
    totalTicks: number;
  }>;
  personalShield?: RustAuthorityPersonalShieldSnapshot | null;
  weapon?: RustAuthorityActorWeaponSnapshot | null;
  bodyVanishTick?: number;
  lootable?: boolean;
  hasLoot?: boolean;
  lootRightsActorId?: string | null;
  professions?: RustAuthorityProfessionSnapshot[];
  activeTitle?: RustAuthorityProfessionTitleSnapshot | null;
  careerGoal?: {
    id: string;
    label: string;
    targetSkillPoints: number;
    ownedTargetSkillBoxes: number;
    targetSkillBoxes: number;
    extraSkillBoxes?: string[];
    nextSkillBoxId?: string | null;
    primaryWeaponId: string;
  } | null;
  capabilities?: RustAuthorityActorCapabilitySnapshot[];
  skillPointsUsed?: number;
  skillPointsCap?: number;
  shotSpreadDegreesMilli?: number;
  credits?: number;
  respawnTick?: number;
  nextSampleTick?: number;
  cloneSicknessTicks?: number;
  incapRemainingTicks?: number;
  incapCount?: number;
  incapWindowTicks?: number;
  combatQueue?: GameActorCombatQueueSnapshot | null;
  abilityQueue?: AbilityQueueView | null;
  inCombat?: boolean;
  peaceRequested?: boolean;
  engagementTargetId?: string | null;
}

export interface RustAuthorityActorStatsSnapshot {
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
  recent10s: RustAuthorityActorRecentStatsSnapshot;
  recent60s: RustAuthorityActorRecentStatsSnapshot;
}

export interface RustAuthorityActorWeaponSnapshot {
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

export interface RustAuthorityActorRecentStatsSnapshot {
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

export interface RustAuthorityAbilityQueueEventSnapshot extends Omit<AbilityQueueEvent, "abilityId"> {
  actorId: string;
  abilityId?: GameCombatActionId | string;
}

export interface RustAuthorityCombatEventSnapshot {
  kind?: string;
  id: number;
  commandId?: number | null;
  tick: number;
  shooterActorId: string;
  targetActorId: string;
  attackerActorId?: string;
  actionId?: GameCombatActionId | string;
  hit?: boolean;
  pool?: string;
  rollMilli?: number;
  toHitMilli?: number;
  // Roll-combat event extensions are represented by kind/hit/effect:
  // kind === "ranged_roll", hit === false => miss, effect.kind === "dodge" => dodge.
  originX?: number | null;
  originY?: number | null;
  hitX: number;
  hitY: number;
  damage: number;
  previousLifeState: string;
  lifeState: string;
  targetLifecycleSeq: number;
  bleedStackCount: number;
  lifecycle: string;
  zone?: string;
  weaponId?: string;
  ammoType?: string;
  effect?: {
    kind: string;
    stacks: number;
    threshold: number;
    remainingTicks: number;
  } | null;
  lifecycleCause?: string;
}

const defaultAreaInterestRadiusCells = 64;
// Startup can enqueue one actor upsert per connected session plus a command burst
// before the Rust child drains stdout; keep this above the 1,200-session shard cap.
const maxPendingBridgeRequests = 8_192;
const bridgeTimingSampleLimit = 256;

class RollingBridgeTiming {
  private readonly samples: number[] = [];
  private totalMs = 0;
  private lastMs = 0;
  private maxMs = 0;

  record(durationMs: number): void {
    const safeMs = Math.max(0, Math.round(durationMs * 10) / 10);
    this.samples.push(safeMs);
    this.totalMs += safeMs;
    this.lastMs = safeMs;
    this.maxMs = Math.max(this.maxMs, safeMs);
    while (this.samples.length > bridgeTimingSampleLimit) {
      this.totalMs -= this.samples.shift() ?? 0;
    }
  }

  summary(): RustAuthorityBridgeTimingSummary {
    const sorted = [...this.samples].sort((a, b) => a - b);
    const count = sorted.length;
    const p95Index = count > 0 ? Math.min(count - 1, Math.ceil(count * 0.95) - 1) : 0;
    return {
      count,
      lastMs: this.lastMs,
      avgMs: count > 0 ? Math.round((this.totalMs / count) * 10) / 10 : 0,
      p95Ms: count > 0 ? sorted[p95Index] ?? 0 : 0,
      maxMs: this.maxMs,
    };
  }
}

function bridgeRequestType(request: unknown): string {
  const type = typeof request === "object" && request !== null && "type" in request
    ? (request as { type?: unknown }).type
    : undefined;
  return typeof type === "string" && type.length > 0 ? type : "step";
}

type RustAuthorityBridgeLaunch = {
  command: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
};

function defaultRustAuthorityBridgeLaunch(options: RustAuthorityBridgeOptions): RustAuthorityBridgeLaunch {
  const prebuiltBridgeBin = process.env.GAME_RUST_AUTHORITY_BRIDGE_BIN?.trim();
  if (prebuiltBridgeBin) {
    return {
      command: prebuiltBridgeBin,
      args: [options.slicePath],
      env: process.env,
    };
  }
  return {
    command: "cargo",
    args: [
      "run",
      "-q",
      "-p",
      "successor-sim",
      "--example",
      "authority_bridge_server",
      "--",
      options.slicePath,
    ],
    env: optimizedCargoDevEnv(),
  };
}

export function sanitizeRustAuthoritySlicePayload(payload: unknown): unknown {
  return payload;
}

function rustAuthorityLaunchSlice(options: RustAuthorityBridgeOptions): { slicePath: string } {
  return { slicePath: options.slicePath };
}

function optimizedCargoDevEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    CARGO_PROFILE_DEV_OPT_LEVEL: process.env.CARGO_PROFILE_DEV_OPT_LEVEL ?? "2",
  };
}

export class RustAuthorityBridge {
  private readonly logger?: Pick<FastifyBaseLogger, "warn" | "debug" | "info">;
  private readonly craftRollKey: string;
  private readonly areaInterestRadiusCells: number;
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly stdoutLines: Interface;
  private readonly pending = new Map<number, RustAuthorityDiagnosticPending>();
  private readonly livePending = new Map<number, RustAuthorityLivePending>();
  private readonly commandBatches = new Map<number, RustAuthorityCommandBatchPending[]>();
  private commandBatch: RustAuthorityCommandBatchPending[] = [];
  private commandBatchScheduled = false;
  private nextRequestId = 1;
  private closed = false;
  private readonly liveRequestTimings = new Map<string, RollingBridgeTiming>();
  private readonly liveRequestTimeouts = new Map<string, number>();

  constructor(options: RustAuthorityBridgeOptions) {
    if (options.enabled === false) throw new Error("RustAuthorityBridge constructed while disabled");
    this.craftRollKey = options.craftRollKey ?? randomBytes(32).toString("hex");
    this.logger = options.logger;
    this.areaInterestRadiusCells = options.areaInterestRadiusCells ?? defaultAreaInterestRadiusCells;
    const launchSlice = rustAuthorityLaunchSlice(options);
    const launchOptions = { ...options, slicePath: launchSlice.slicePath };
    const launch = options.command
      ? {
        command: options.command,
        args: (options.args ?? [launchOptions.slicePath]).map((arg) => arg === options.slicePath ? launchOptions.slicePath : arg),
      }
      : defaultRustAuthorityBridgeLaunch(launchOptions);
    const { command, args } = launch;
    this.child = spawn(command, args, {
      cwd: options.cwd,
      env: launch.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stdin.on("error", (error) => {
      if (!this.closed) this.logger?.warn({ error }, "rust authority bridge stdin failed");
      this.rejectLivePending(error instanceof Error ? error : new Error("rust authority bridge stdin failed"));
    });
    this.stdoutLines = createInterface({ input: this.child.stdout });
    this.stdoutLines.on("line", (line) => this.handleOutputLine(line));
    this.child.stderr.on("data", (chunk: Buffer) => {
      const message = chunk.toString().trim();
      if (message.length > 0) this.logger?.debug({ message }, "rust authority bridge stderr");
    });
    this.child.on("error", (error) => {
      this.logger?.warn({ error }, "rust authority bridge process failed");
      this.pending.clear();
      this.rejectLivePending(error instanceof Error ? error : new Error("rust authority bridge process failed"));
    });
    this.child.on("exit", (code, signal) => {
      if (this.closed) return;
      this.logger?.warn({ code, signal }, "rust authority bridge exited");
      this.pending.clear();
      this.rejectLivePending(new Error(`rust authority bridge exited: code=${code ?? "null"} signal=${signal ?? "null"}`));
    });
    this.logger?.info({ command, args }, "rust authority bridge started");
  }

  observeCommand(observation: RustAuthorityDiagnosticObservation): void {
    if (this.closed || this.child.exitCode !== null || this.child.killed) return;
    if (this.pending.size >= maxPendingBridgeRequests) {
      this.logger?.warn({ pending: this.pending.size }, "rust authority bridge diagnostic dropping command because backlog is full");
      return;
    }
    const request = buildRustAuthorityBridgeRequest({
      requestId: this.nextRequestId++,
      actorId: observation.actorId,
      envelope: observation.envelope,
      areaInterestRadiusCells: this.areaInterestRadiusCells,
      craftRollKey: this.craftRollKey,
    });
    this.pending.set(request.requestId, {
      actorId: observation.actorId,
      commandId: observation.envelope.command_id,
      receipt: observation.receipt,
      commandKind: commandKind(observation.envelope.command),
    });
    const line = `${JSON.stringify(request)}\n`;
    this.child.stdin.write(line, (error) => {
      if (!error) return;
      this.pending.delete(request.requestId);
      this.logger?.warn({ error }, "rust authority bridge diagnostic write failed");
    });
  }

  debugStatus(): RustAuthorityBridgeDebugStatus {
    let commandBatchPendingItems = 0;
    for (const batch of this.commandBatches.values()) {
      for (const item of batch) {
        if (!item.settled) commandBatchPendingItems += 1;
      }
    }
    let cadencePending = 0;
    let workloadLivePending = 0;
    for (const pending of this.livePending.values()) {
      if (pending.requestType === "tick") cadencePending += 1;
      else workloadLivePending += 1;
    }
    const commandBatchPending = this.commandBatch.filter((item) => !item.settled).length;
    const workloadBacklogSize = workloadLivePending + commandBatchPending + commandBatchPendingItems;
    return {
      closed: this.closed,
      childKilled: this.child.killed,
      childExitCode: this.child.exitCode,
      childSignalCode: this.child.signalCode,
      nextRequestId: this.nextRequestId,
      diagnosticPending: this.pending.size,
      livePending: this.livePending.size,
      cadencePending,
      workloadLivePending,
      commandBatchPending,
      commandBatches: this.commandBatches.size,
      commandBatchPendingItems,
      backlogSize: this.liveBacklogSize(),
      workloadBacklogSize,
      timings: {
        liveRequests: this.liveRequestTimingSummary(),
      },
      timeouts: Object.fromEntries(this.liveRequestTimeouts),
    };
  }

  pendingCount(): number {
    return this.pending.size + this.liveBacklogSize();
  }

  submitCommand(options: {
    actorId: string;
    envelope: ClientCommandEnvelope;
    session?: number;
    player?: number;
    timeoutMs?: number;
  }): Promise<RustAuthorityBridgeStepOutput> {
    const request = buildRustAuthorityBridgeRequest({
      requestId: this.nextRequestId++,
      actorId: options.actorId,
      envelope: options.envelope,
      areaInterestRadiusCells: this.areaInterestRadiusCells,
      craftRollKey: this.craftRollKey,
      session: options.session,
      player: options.player,
    });
    return this.submitCommandRequest(request, options.timeoutMs);
  }

  private submitCommandRequest(
    request: RustAuthorityStepRequest,
    timeoutMs?: number,
  ): Promise<RustAuthorityBridgeStepOutput> {
    if (this.closed || this.child.exitCode !== null || this.child.killed) {
      return Promise.reject(new Error("rust authority bridge is closed"));
    }
    if (this.liveBacklogSize() >= maxPendingBridgeRequests) {
      return Promise.reject(new Error("rust authority bridge backlog is full"));
    }
    const responseTimeoutMs = timeoutMs ?? 2_500;
    return new Promise((resolve, reject) => {
      const pending: RustAuthorityCommandBatchPending = {
        request,
        resolve,
        reject,
        settled: false,
        timeout: setTimeout(() => {
          this.clearCommandBatchItemTimeout(pending);
          if (pending.batchRequestId === undefined) {
            this.rejectCommandBatchItem(pending, new Error("rust authority bridge request timed out"));
            return;
          }
          const requestType = bridgeRequestType(pending.request);
          this.liveRequestTimeouts.set(requestType, (this.liveRequestTimeouts.get(requestType) ?? 0) + 1);
          this.logger?.warn({
            batchRequestId: pending.batchRequestId,
            requestId: pending.request.requestId,
            commandId: pending.request.envelope.command_id,
            timeoutMs: responseTimeoutMs,
          }, "rust authority bridge command response delayed after batch handoff; awaiting authoritative output");
        }, responseTimeoutMs),
      };
      this.commandBatch.push(pending);
      this.scheduleCommandBatchFlush();
    });
  }

  private scheduleCommandBatchFlush(): void {
    if (this.commandBatchScheduled) return;
    this.commandBatchScheduled = true;
    setImmediate(() => this.flushCommandBatch());
  }

  private flushCommandBatch(): void {
    this.commandBatchScheduled = false;
    const pending = this.commandBatch.splice(0).filter((item) => !item.settled);
    if (pending.length === 0) return;
    if (this.closed || this.child.exitCode !== null || this.child.killed) {
      const error = new Error("rust authority bridge is closed");
      for (const item of pending) this.rejectCommandBatchItem(item, error);
      return;
    }
    const request = buildRustAuthorityBatchRequest({
      requestId: this.nextRequestId++,
      steps: pending.map((item) => item.request),
    });
    for (const item of pending) item.batchRequestId = request.requestId;
    this.commandBatches.set(request.requestId, pending);
    this.child.stdin.write(`${JSON.stringify(request)}\n`, (error) => {
      if (!error) return;
      for (const item of pending) this.rejectCommandBatchItem(item, error);
    });
  }

  submitTick(options: {
    ticks: number;
    actorId?: string;
    session?: number;
    player?: number;
    includeAiDebug?: boolean;
    timeoutMs?: number;
    weatherHazards?: RustAuthorityWeatherHazardInput[];
    weatherHazardsByTick?: RustAuthorityWeatherHazardInput[][];
  }): Promise<RustAuthorityBridgeTickOutput> {
    const request = buildRustAuthorityTickRequest({
      requestId: this.nextRequestId++,
      ticks: options.ticks,
      actorId: options.actorId ?? "__server_tick_observer__",
      areaInterestRadiusCells: this.areaInterestRadiusCells,
      craftRollKey: this.craftRollKey,
      session: options.session ?? 0,
      player: options.player ?? 0,
      includeAiDebug: options.includeAiDebug,
      weatherHazards: options.weatherHazards,
      weatherHazardsByTick: options.weatherHazardsByTick,
    });
    return this.submitLiveRequest(request, options.timeoutMs) as Promise<RustAuthorityBridgeTickOutput>;
  }

  exportState(options: { timeoutMs?: number } = {}): Promise<RustAuthorityBridgeExportStateOutput> {
    const request = buildRustAuthorityExportStateRequest({ requestId: this.nextRequestId++ });
    return this.submitLiveRequest(request, options.timeoutMs) as Promise<RustAuthorityBridgeExportStateOutput>;
  }

  importState(options: { state: RustAuthorityStateBlob; expectedStateHash?: string; timeoutMs?: number }): Promise<RustAuthorityBridgeImportStateOutput> {
    const request = buildRustAuthorityImportStateRequest({
      requestId: this.nextRequestId++,
      state: options.state,
      expectedStateHash: options.expectedStateHash,
    });
    return this.submitLiveRequest(request, options.timeoutMs) as Promise<RustAuthorityBridgeImportStateOutput>;
  }

  submitAiDebug(options: { timeoutMs?: number } = {}): Promise<RustAuthorityBridgeDebugOutput> {
    const request = buildRustAuthorityDebugRequest({ requestId: this.nextRequestId++ });
    return this.submitLiveRequest(request, options.timeoutMs) as Promise<RustAuthorityBridgeDebugOutput>;
  }

  submitExchangeMetrics(options: { timeoutMs?: number } = {}): Promise<RustAuthorityBridgeExchangeMetricsOutput> {
    const request = buildRustAuthorityMetricsRequest({ requestId: this.nextRequestId++ });
    return this.submitLiveRequest(request, options.timeoutMs) as Promise<RustAuthorityBridgeExchangeMetricsOutput>;
  }

  submitActor(options: { actor: RustAuthorityActorUpsertInput; timeoutMs?: number }): Promise<RustAuthorityBridgeActorOutput> {
    const request = buildRustAuthorityActorRequest({
      requestId: this.nextRequestId++,
      actor: options.actor,
    });
    return this.submitLiveRequest(request, options.timeoutMs) as Promise<RustAuthorityBridgeActorOutput>;
  }

  removeActor(options: { actorId: string; purgeInventory?: boolean; timeoutMs?: number }): Promise<RustAuthorityBridgeActorOutput> {
    const request = buildRustAuthorityRemoveActorRequest({
      requestId: this.nextRequestId++,
      actorId: options.actorId,
      purgeInventory: options.purgeInventory,
    });
    return this.submitLiveRequest(request, options.timeoutMs) as Promise<RustAuthorityBridgeActorOutput>;
  }

  setActorLinkDead(options: { actorId: string; linkDead: boolean; deadlineTick?: number; timeoutMs?: number }): Promise<RustAuthorityBridgeActorOutput> {
    const request = buildRustAuthorityLinkDeadActorRequest({
      requestId: this.nextRequestId++,
      actorId: options.actorId,
      linkDead: options.linkDead,
      deadlineTick: options.deadlineTick,
    });
    return this.submitLiveRequest(request, options.timeoutMs) as Promise<RustAuthorityBridgeActorOutput>;
  }

  relocateActor(options: { actorId: string; areaId: string; x: number; y: number; direction: string; timeoutMs?: number }): Promise<RustAuthorityBridgeActorOutput> {
    const request = buildRustAuthorityRelocateActorRequest({
      requestId: this.nextRequestId++,
      actorId: options.actorId,
      areaId: options.areaId,
      x: options.x,
      y: options.y,
      direction: options.direction,
    });
    return this.submitLiveRequest(request, options.timeoutMs) as Promise<RustAuthorityBridgeActorOutput>;
  }

  restockActorLoadout(options: { actorId: string; timeoutMs?: number }): Promise<RustAuthorityBridgeActorOutput> {
    const request = buildRustAuthorityRestockActorRequest({
      requestId: this.nextRequestId++,
      actorId: options.actorId,
    });
    return this.submitLiveRequest(request, options.timeoutMs) as Promise<RustAuthorityBridgeActorOutput>;
  }

  setDoorOpen(options: { propId: string; doorOpen: boolean; timeoutMs?: number }): Promise<RustAuthorityBridgeDoorStateOutput> {
    const request = buildRustAuthorityDoorStateRequest({
      requestId: this.nextRequestId++,
      propId: options.propId,
      doorOpen: options.doorOpen,
    });
    return this.submitLiveRequest(request, options.timeoutMs) as Promise<RustAuthorityBridgeDoorStateOutput>;
  }

  private submitLiveRequest(
    request: RustAuthorityStepRequest | RustAuthorityTickRequest | RustAuthorityActorRequest | RustAuthorityRemoveActorRequest | RustAuthorityLinkDeadActorRequest | RustAuthorityRelocateActorRequest | RustAuthorityRestockActorRequest | RustAuthorityDoorStateRequest | RustAuthorityDebugRequest | RustAuthorityMetricsRequest | RustAuthorityExportStateRequest | RustAuthorityImportStateRequest,
    timeoutMs?: number,
  ): Promise<RustAuthorityBridgeStepOutput | RustAuthorityBridgeTickOutput | RustAuthorityBridgeActorOutput | RustAuthorityBridgeDoorStateOutput | RustAuthorityBridgeDebugOutput | RustAuthorityBridgeExchangeMetricsOutput | RustAuthorityBridgeExportStateOutput | RustAuthorityBridgeImportStateOutput> {
    if (this.closed || this.child.exitCode !== null || this.child.killed) {
      return Promise.reject(new Error("rust authority bridge is closed"));
    }
    if (this.liveBacklogSize() >= maxPendingBridgeRequests) {
      return Promise.reject(new Error("rust authority bridge backlog is full"));
    }
    return new Promise((resolve, reject) => {
      const requestType = bridgeRequestType(request);
      const startedAtMs = Date.now();
      const timeout = setTimeout(() => {
        this.livePending.delete(request.requestId);
        this.liveRequestTimeouts.set(requestType, (this.liveRequestTimeouts.get(requestType) ?? 0) + 1);
        reject(new Error("rust authority bridge request timed out"));
      }, timeoutMs ?? 2_500);
      this.livePending.set(request.requestId, { resolve, reject, timeout, requestType, startedAtMs });
      this.child.stdin.write(`${JSON.stringify(request)}\n`, (error) => {
        if (!error) return;
        clearTimeout(timeout);
        this.livePending.delete(request.requestId);
        reject(error);
      });
    });
  }

  close(): void {
    this.closed = true;
    this.pending.clear();
    this.rejectLivePending(new Error("rust authority bridge closed"));
    this.stdoutLines.close();
    this.child.stdin.end();
    if (!this.child.killed && this.child.exitCode === null) this.child.kill();
  }

  private handleOutputLine(line: string): void {
    let output: RustAuthorityBridgeStepOutput | RustAuthorityBridgeTickOutput | RustAuthorityBridgeActorOutput | RustAuthorityBridgeDoorStateOutput | RustAuthorityBridgeBatchOutput | RustAuthorityBridgeDebugOutput | RustAuthorityBridgeExchangeMetricsOutput | RustAuthorityBridgeExportStateOutput | RustAuthorityBridgeImportStateOutput;
    try {
      output = JSON.parse(line) as RustAuthorityBridgeStepOutput | RustAuthorityBridgeTickOutput | RustAuthorityBridgeActorOutput | RustAuthorityBridgeDoorStateOutput | RustAuthorityBridgeBatchOutput | RustAuthorityBridgeDebugOutput | RustAuthorityBridgeExchangeMetricsOutput | RustAuthorityBridgeExportStateOutput | RustAuthorityBridgeImportStateOutput;
    } catch (error) {
      this.logger?.warn({ error, line }, "rust authority bridge emitted invalid JSON");
      return;
    }
    if (output.schema === "successor.rust-authority-bridge-error.v1") {
      const message = typeof (output as { error?: unknown }).error === "string"
        ? (output as { error: string }).error
        : "rust authority bridge rejected an input line";
      const error = new Error(message);
      this.logger?.warn({ output }, "rust authority bridge rejected an input line");
      this.rejectLivePending(error);
      return;
    }
    if (output.schema === "successor.rust-authority-bridge-batch.v1") {
      this.handleBatchOutput(output);
      return;
    }
    const requestId = output.requestId;
    if (typeof requestId !== "number") {
      this.logger?.warn({ output }, "rust authority bridge output missed request id");
      return;
    }
    const livePending = this.livePending.get(requestId);
    if (livePending) {
      this.livePending.delete(requestId);
      clearTimeout(livePending.timeout);
      this.recordLiveRequestTiming(livePending.requestType, Date.now() - livePending.startedAtMs);
      livePending.resolve(output);
      return;
    }
    const pending = this.pending.get(requestId);
    if (!pending) {
      this.logger?.debug({ requestId, output }, "rust authority bridge output had no pending request");
      return;
    }
    this.pending.delete(requestId);
    compareRustAuthorityBridgeOutput(output, pending, this.logger);
  }

  private rejectLivePending(error: Error): void {
    for (const pending of this.livePending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.livePending.clear();
    this.rejectCommandBatches(error);
  }

  private handleBatchOutput(output: RustAuthorityBridgeBatchOutput): void {
    const requestId = output.requestId;
    if (typeof requestId !== "number") {
      this.logger?.warn({ output }, "rust authority bridge batch output missed request id");
      return;
    }
    const pending = this.commandBatches.get(requestId);
    if (!pending) {
      this.logger?.debug({ requestId, output }, "rust authority bridge batch output had no pending request");
      return;
    }
    const stepsByRequestId = new Map<number, RustAuthorityBridgeStepOutput>();
    for (const step of output.steps ?? []) {
      if (typeof step.requestId === "number") stepsByRequestId.set(step.requestId, step);
    }
    for (const item of pending) {
      if (item.settled) continue;
      const step = stepsByRequestId.get(item.request.requestId);
      if (step) {
        this.resolveCommandBatchItem(item, step);
      } else {
        this.rejectCommandBatchItem(item, new Error(`rust authority bridge batch missed request ${item.request.requestId}`));
      }
    }
  }

  private liveBacklogSize(): number {
    let count = this.livePending.size;
    for (const item of this.commandBatch) {
      if (!item.settled) count += 1;
    }
    for (const batch of this.commandBatches.values()) {
      for (const item of batch) {
        if (!item.settled) count += 1;
      }
    }
    return count;
  }

  private recordLiveRequestTiming(requestType: string, durationMs: number): void {
    let timing = this.liveRequestTimings.get(requestType);
    if (!timing) {
      timing = new RollingBridgeTiming();
      this.liveRequestTimings.set(requestType, timing);
    }
    timing.record(durationMs);
  }

  private liveRequestTimingSummary(): Record<string, RustAuthorityBridgeTimingSummary> {
    return Object.fromEntries([...this.liveRequestTimings].map(([requestType, timing]) => [requestType, timing.summary()]));
  }

  private clearCommandBatchItemTimeout(item: RustAuthorityCommandBatchPending): void {
    const timeout = item.timeout;
    if (timeout === undefined) return;
    item.timeout = undefined;
    clearTimeout(timeout);
  }

  private resolveCommandBatchItem(item: RustAuthorityCommandBatchPending, output: RustAuthorityBridgeStepOutput): void {
    if (item.settled) return;
    item.settled = true;
    this.clearCommandBatchItemTimeout(item);
    this.releaseSettledCommandBatch(item);
    item.resolve(output);
  }

  private rejectCommandBatchItem(item: RustAuthorityCommandBatchPending, error: Error): void {
    if (item.settled) return;
    item.settled = true;
    this.clearCommandBatchItemTimeout(item);
    this.releaseSettledCommandBatch(item);
    item.reject(error);
  }

  private releaseSettledCommandBatch(item: RustAuthorityCommandBatchPending): void {
    const requestId = item.batchRequestId;
    if (requestId === undefined) return;
    const batch = this.commandBatches.get(requestId);
    if (batch?.every((candidate) => candidate.settled)) this.commandBatches.delete(requestId);
  }

  private rejectCommandBatches(error: Error): void {
    for (const item of this.commandBatch.splice(0)) {
      this.rejectCommandBatchItem(item, error);
    }
    for (const batch of [...this.commandBatches.values()]) {
      for (const item of batch) this.rejectCommandBatchItem(item, error);
    }
    this.commandBatches.clear();
  }
}

export function buildRustAuthorityActorRequest(options: {
  requestId: number;
  actor: RustAuthorityActorUpsertInput;
}): RustAuthorityActorRequest {
  return {
    type: "upsertActor",
    requestId: options.requestId,
    actor: {
      ...options.actor,
      x: Math.trunc(options.actor.x),
      y: Math.trunc(options.actor.y),
    },
  };
}

export function buildRustAuthorityRemoveActorRequest(options: {
  requestId: number;
  actorId: string;
  purgeInventory?: boolean;
}): RustAuthorityRemoveActorRequest {
  return {
    type: "removeActor",
    requestId: options.requestId,
    actorId: options.actorId,
    ...(options.purgeInventory === undefined ? {} : { purgeInventory: options.purgeInventory }),
  };
}

export function buildRustAuthorityLinkDeadActorRequest(options: {
  requestId: number;
  actorId: string;
  linkDead: boolean;
  deadlineTick?: number;
}): RustAuthorityLinkDeadActorRequest {
  return {
    type: "setActorLinkDead",
    requestId: options.requestId,
    actorId: options.actorId,
    linkDead: options.linkDead,
    ...(options.deadlineTick === undefined ? {} : { deadlineTick: options.deadlineTick }),
  };
}

export function buildRustAuthorityRelocateActorRequest(options: {
  requestId: number;
  actorId: string;
  areaId: string;
  x: number;
  y: number;
  direction: string;
}): RustAuthorityRelocateActorRequest {
  return {
    type: "relocateActor",
    requestId: options.requestId,
    actorId: options.actorId,
    areaId: options.areaId,
    x: Math.trunc(options.x),
    y: Math.trunc(options.y),
    direction: options.direction,
  };
}

export function buildRustAuthorityRestockActorRequest(options: {
  requestId: number;
  actorId: string;
}): RustAuthorityRestockActorRequest {
  return {
    type: "restockActorLoadout",
    requestId: options.requestId,
    actorId: options.actorId,
  };
}

export function buildRustAuthorityDoorStateRequest(options: {
  requestId: number;
  propId: string;
  doorOpen: boolean;
}): RustAuthorityDoorStateRequest {
  return {
    type: "setDoorOpen",
    requestId: options.requestId,
    propId: options.propId,
    doorOpen: options.doorOpen,
  };
}

export function buildRustAuthorityBatchRequest(options: {
  requestId: number;
  steps: RustAuthorityStepRequest[];
}): RustAuthorityBatchRequest {
  return {
    type: "batch",
    requestId: options.requestId,
    steps: options.steps,
  };
}


export function buildRustAuthorityBridgeRequest(options: {
  requestId: number;
  actorId: string;
  envelope: ClientCommandEnvelope;
  areaInterestRadiusCells?: number;
  craftRollKey?: string;
  session?: number;
  player?: number;
}): RustAuthorityStepRequest {
  const session = options.session ?? options.envelope.session;
  const player = options.player ?? options.envelope.player;
  return {
    requestId: options.requestId,
    config: {
      session,
      player,
      playerActorId: options.actorId,
      areaInterestRadiusCells: options.areaInterestRadiusCells ?? defaultAreaInterestRadiusCells,
      craftRollKey: options.craftRollKey ?? defaultCraftRollKey,
    },
    envelope: {
      ...options.envelope,
      session,
      player,
    },
  };
}

function normalizeWeatherHazards(hazards: RustAuthorityWeatherHazardInput[]): RustAuthorityWeatherHazardInput[] {
  return hazards.map((hazard) => ({
    areaId: hazard.areaId,
    centerXMilli: Math.trunc(hazard.centerXMilli),
    centerYMilli: Math.trunc(hazard.centerYMilli),
    radiusMilli: Math.max(0, Math.trunc(hazard.radiusMilli)),
    dpsMilliHealth: Math.max(0, Math.trunc(hazard.dpsMilliHealth)),
    shelters: hazard.shelters.map((shelter) => ({
      minXMilli: Math.trunc(shelter.minXMilli),
      minYMilli: Math.trunc(shelter.minYMilli),
      maxXMilli: Math.trunc(shelter.maxXMilli),
      maxYMilli: Math.trunc(shelter.maxYMilli),
    })),
  }));
}

export function buildRustAuthorityTickRequest(options: {
  requestId: number;
  craftRollKey?: string;
  ticks: number;
  actorId: string;
  areaInterestRadiusCells?: number;
  session?: number;
  player?: number;
  includeAiDebug?: boolean;
  weatherHazards?: RustAuthorityWeatherHazardInput[];
  weatherHazardsByTick?: RustAuthorityWeatherHazardInput[][];
}): RustAuthorityTickRequest {
  const ticks = Number.isFinite(options.ticks) ? Math.trunc(options.ticks) : 0;
  if (ticks < 1 || ticks > 65_535) {
    throw new RangeError(`Rust authority tick requests must advance 1..65535 ticks; received ${options.ticks}`);
  }
  if (options.weatherHazardsByTick !== undefined && options.weatherHazardsByTick.length !== ticks) {
    throw new RangeError(`weatherHazardsByTick length must equal ticks; received ${options.weatherHazardsByTick.length} for ${ticks}`);
  }
  return {
    type: "tick",
    requestId: options.requestId,
    ticks,
    includeAiDebug: options.includeAiDebug === true,
    config: {
      session: options.session ?? 0,
      craftRollKey: options.craftRollKey ?? defaultCraftRollKey,
      player: options.player ?? 0,
      playerActorId: options.actorId,
      areaInterestRadiusCells: options.areaInterestRadiusCells ?? defaultAreaInterestRadiusCells,
    },
    weatherHazards: normalizeWeatherHazards(options.weatherHazards ?? []),
    ...(options.weatherHazardsByTick === undefined ? {} : {
      weatherHazardsByTick: options.weatherHazardsByTick.map((hazards) => normalizeWeatherHazards(hazards)),
    }),
  };
}

export function buildRustAuthorityDebugRequest(options: {
  requestId: number;
}): RustAuthorityDebugRequest {
  return {
    type: "debug",
    requestId: options.requestId,
  };
}

export function buildRustAuthorityMetricsRequest(options: {
  requestId: number;
}): RustAuthorityMetricsRequest {
  return {
    type: "metrics",
    requestId: options.requestId,
  };
}

export function buildRustAuthorityExportStateRequest(options: {
  requestId: number;
}): RustAuthorityExportStateRequest {
  return {
    type: "exportState",
    requestId: options.requestId,
  };
}

export function buildRustAuthorityImportStateRequest(options: {
  requestId: number;
  state: RustAuthorityStateBlob;
  expectedStateHash?: string;
}): RustAuthorityImportStateRequest {
  return {
    type: "importState",
    requestId: options.requestId,
    state: options.state,
    ...(options.expectedStateHash ? { expectedStateHash: options.expectedStateHash } : {}),
  };
}

function compareRustAuthorityBridgeOutput(
  output: RustAuthorityBridgeStepOutput,
  pending: RustAuthorityDiagnosticPending,
  logger: Pick<FastifyBaseLogger, "warn" | "debug" | "info"> | undefined,
): void {
  const rustAccepted = output.status === "accepted";
  if (rustAccepted !== pending.receipt.accepted) {
    logger?.warn({
      actorId: pending.actorId,
      commandId: pending.commandId,
      commandKind: pending.commandKind,
      typescriptAccepted: pending.receipt.accepted,
      typescriptReasonCode: pending.receipt.reasonCode,
      rustStatus: output.status,
      rustReasonCode: output.reasonCode,
      rustTick: output.tick,
      rustFrameHash: output.frameHash,
      rustStateHash: output.targetStateHash,
    }, "rust authority bridge diagnostic receipt mismatch");
    return;
  }

  if (!rustAccepted && shouldCompareRejectReason(pending.receipt.reasonCode, output.reasonCode)) {
    logger?.warn({
      actorId: pending.actorId,
      commandId: pending.commandId,
      commandKind: pending.commandKind,
      typescriptReasonCode: pending.receipt.reasonCode,
      rustReasonCode: output.reasonCode,
    }, "rust authority bridge diagnostic rejection reason mismatch");
    return;
  }

  logger?.debug({
    actorId: pending.actorId,
    commandId: pending.commandId,
    commandKind: pending.commandKind,
    accepted: pending.receipt.accepted,
    rustTick: output.tick,
    rustFrameHash: output.frameHash,
    rustMetrics: output.metrics,
  }, "rust authority bridge diagnostic matched receipt");
}

function shouldCompareRejectReason(left: string | undefined, right: string | null | undefined): boolean {
  if (!left || !right) return false;
  if (left === right) return false;
  return !coarseTypescriptRejectReason(left);
}

function coarseTypescriptRejectReason(reasonCode: string): boolean {
  return reasonCode === "move_rejected"
    || reasonCode === "transition_rejected"
    || reasonCode === "fire_rejected"
    || reasonCode === "sample_resource_rejected"
    || reasonCode === "harvest_corpse_rejected"
    || reasonCode === "craft_item_rejected";
}

function commandKind(command: ClientCommandEnvelope["command"]): string {
  if ("Move" in command) return "Move";
  if ("SetMoveIntent" in command) return "SetMoveIntent";
  if ("QueueCombatAction" in command) return "QueueCombatAction";
  if ("CancelAbilityQueue" in command) return "CancelAbilityQueue";
  if ("SetEquippedClothing" in command) return "SetEquippedClothing";
  if ("ReloadWeapon" in command) return "ReloadWeapon";
  if ("SetEquippedWeapon" in command) return "SetEquippedWeapon";
  if ("DebugGiveItem" in command) return "DebugGiveItem";
  if ("DebugGrantSkillBoxes" in command) return "DebugGrantSkillBoxes";
  if ("UseConsumable" in command) return "UseConsumable";
  if ("RefillAmmo" in command) return "RefillAmmo";
  if ("ApplyServiceBuff" in command) return "ApplyServiceBuff";
  if ("CloneRespawn" in command) return "CloneRespawn";
  if ("ReviveActor" in command) return "ReviveActor";
  if ("SetPosture" in command) return "SetPosture";
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
  if ("DiscardStack" in command) return "DiscardStack";
  if ("SplitStack" in command) return "SplitStack";
  if ("MergeStacks" in command) return "MergeStacks";
  if ("RedeemCreditChip" in command) return "RedeemCreditChip";
  if ("HarvestCorpse" in command) return "HarvestCorpse";
  if ("TakeLootItem" in command) return "TakeLootItem";
  if ("PurchaseTravelTicket" in command) return "PurchaseTravelTicket";
  if ("UseTravelTicket" in command) return "UseTravelTicket";
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
  if ("StoreToExchange" in command) return "StoreToExchange";
  if ("RetrieveFromExchange" in command) return "RetrieveFromExchange";
  if ("ProposeTrade" in command) return "ProposeTrade";
  if ("AcceptTrade" in command) return "AcceptTrade";
  if ("DeclineTrade" in command) return "DeclineTrade";
  if ("GroupInvite" in command) return "GroupInvite";
  if ("GroupAccept" in command) return "GroupAccept";
  if ("GroupDecline" in command) return "GroupDecline";
  if ("GroupLeave" in command) return "GroupLeave";
  if ("GroupDisband" in command) return "GroupDisband";
  if ("GroupKick" in command) return "GroupKick";
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
  if ("BuildPlace" in command) return "BuildPlace";
  if ("BuildRemove" in command) return "BuildRemove";
  if ("BuildToggleDoor" in command) return "BuildToggleDoor";
  if ("HarvestCrop" in command) return "HarvestCrop";
  return "EnterTransition";
}
