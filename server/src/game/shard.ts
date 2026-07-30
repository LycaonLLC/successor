import fs from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { dirname } from "node:path";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import type { FastifyBaseLogger } from "fastify";
import { systemClock, type ShardClock, type ShardTimer } from "./clock.js";
import { commitHostedFirstEntry, type LaunchTicketEntitlement } from "../auth/tickets.js";
import type { LaunchSessionRevocationSink } from "../auth/runtime.js";
import {
  controlSchemaHeadCanUpgrade,
  type LaunchProvenance,
} from "../alpha/control-store.js";

import { deriveEffectiveActorStatsForRole, type EffectiveActorStats } from "./actorEffectiveStats.js";
import { deriveActorLongArcProfile } from "./actorLongArcProfile.js";
import {
  gameClientPacketSchema,
  ingressBudgetExhaustedReasonCode,
  lastResourceFamilySentinel,
  noSampleContextReasonCode,
  noSurveyContextReasonCode,
  type AbilityQueueEvent,
  type AbilityQueueView,
  type CardinalDirection,
  type ClientCommand,
  type ClientCommandEnvelope,
  type GameActorBleed,
  type GameActorCombatQueueSnapshot,
  type GameCombatLifecycleKind,
  type GameActorLifeState,
  type GameActorPosture,
  type GameActorPatch,
  type GameActorSnapshot,
  type GameActorAppearanceSnapshot,
  type GameActorFaceSnapshot,
  type GameActorWornPiece,
  type GameActorWeaponSnapshot,
  type GameActorVitals,
  type GameActorStatusSnapshot,
  type GameCommandReceipt,
  type GameResourceSpawn,
  type GamePropState,
  type PlacedExtractorVM,
  type PlacedCampVM,
  type ParcelVM,
  type FarmPlotVM,
  type GameBuildingProjection,
  type GameSurveyResult,
  type GameCraftSession,
  type GameGenomeScan,
  type GameSpliceSession,
  type GameTradeSession,
  type GameTradeSessionDelivery,
  type GameDraftedSchematic,
  type GameBankSnapshot,
  type GamePlayerCorpseSnapshot,
  type GameDuelOutcome,
  type GameDuelView,
  type GameGuildView,
  type GameGroupView,
  type GameActorNetRef,
  type GameCompactActorPatch,
  type GameCompactActorSnapshot,
  type GameCompactActorMove,
  type GameCompactBleed,
  type GameCompactReceipt,
  type GameCombatEvent,
  type GameCompactCombatEvent,
  type GameCompactDirection,
  type GameCompactLifeState,
  type GameCompactVitals,
  type GamePlayerPositionAck,
  type GameShardDelta,
  type GameServerPacket,
  type GameShardSnapshot,
  type GameClientView,
  type GameWeatherSnapshot,
  type GameDialogueDelivery,
} from "./protocol.js";
import { type AmmoTypeId } from "./ammo.js";
import {
  authorityWeaponProfile,
  authorityWeaponMagazineSize,
  isAuthorityWeaponId,
  normalizeAuthorityWeaponAmmoType,
  type AuthorityWeaponId,
} from "./weapons.js";
import {
  createWorldClockConfig,
  worldClockSnapshot,
  type WorldClockConfig,
  type WorldClockSnapshot,
} from "./worldClock.js";
import {
  AreaWeatherController,
  weatherSnapshotsAtTick,
  type AreaWeatherSnapshot,
  type SliceWeatherConfig,
} from "./weather.js";
import {
  RustAuthorityBridge,
  rustAuthorityTimelineEventCapacity,
  type RustAuthorityActorSnapshot,
  type RustAuthorityActorStatsSnapshot,
  type RustAuthorityActorUpsertInput,
  type RustAuthorityAreaResourceSpawnsSnapshot,
  type RustAuthorityAiDebugSnapshot,
  type RustAuthorityAbilityQueueEventSnapshot,
  type RustAuthorityBridgeStepOutput,
  type RustAuthorityBridgeTickOutput,
  type RustAuthorityBridgeExchangeMetricsOutput,
  type RustAuthorityBridgeImportStateOutput,
  type RustAuthorityCombatEventSnapshot,
  type RustAuthorityBridgeOptions,
  type RustAuthorityBridgeDebugStatus,
  type RustAuthorityInventorySnapshot,
  type RustAuthorityResourceStatsSnapshot,
  type RustAuthorityReservationSnapshot,
  type RustAuthorityTimelineEventSnapshot,
  type RustAuthorityWeatherHazardInput,
  type RustAuthorityStateBlob,
  type RustAuthorityBankSnapshot,
  type RustAuthorityPlayerCorpseSnapshot,
  type RustAuthorityExchangeMetricsSnapshot,
  type RustAuthorityDialogueDelivery,
  type RustAuthorityBuildDeltaPayload,
} from "./rustAuthorityBridge.js";
import type { VerificationFixtureLoadouts } from "./verificationFixtureLoadout.js";
import { hostedStateLockHealthy } from "../lifecycleSupervisor.js";

export interface GameSocket {
  readyState: number;
  /** Bytes accepted by the transport but not yet handed to the peer. */
  readonly bufferedAmount?: number;
  send(data: string): void;
  sendMessage?(type: string, data: unknown): void;
  close(code?: number, reason?: string): void;
  on(event: "message", listener: (data: unknown) => void): void;
  on(event: "close", listener: () => void): void;
  on(event: "error", listener: (error: Error) => void): void;
}

export interface GameSessionIdentity {
  actorId: string;
  playerId: string;
  displayName: string;
  zoneId: string;
  spawn?: {
    areaId?: string;
    x?: number;
    y?: number;
    facing?: Direction;
  };
  characterId?: string;
  /** True once this durable character has previously claimed world entry. */
  returningCharacter?: boolean;
  entitlement?: LaunchTicketEntitlement;
  /** Hosted control-plane first-entry marker, committed after local durability. */
  pendingFirstEntryCommit?: { entryNonce: string; shardId: string; releaseId: string };
  appearance?: GameActorAppearanceSnapshot;
  /** Creator worn wardrobe set (validated by the character store). */
  worn?: GameActorWornPiece[];
  /** Durable creator palette cache, including unequipped pieces. */
  wornColors?: Record<string, string[]>;
  /** Durable gameplay grants used only to seed a character's first world entry. */
  professionIds?: string[];
  skillBoxIds?: string[];
  /** Exact retired-actor progression mirror, including banked general/track XP. */
  professions?: GameActorSnapshot["professions"];
  skillPointsCap?: number;
  credits?: number;
  vitals?: GameActorVitals;
  activeTitleId?: string | null;
  careerGoalId?: string | null;
  ownerRef?: string;
  launchProvenance?: LaunchProvenance;
}

export type GameCharacterLiveState = "offline" | "online" | "linkdead";

export interface GameCharacterPersistenceOptions {
  checkpointIntervalMs?: number;
  /** True only for an id present in the durable character index. */
  hasCharacter?(characterId: string): boolean;
  /** Commit the one-way first-world-entry marker after Rust state is durable. */
  claimWorldEntry?(
    characterId: string,
    ownerRef?: string,
  ): { returning: boolean } | null;
  saveSnapshot(
    characterId: string,
    snapshot: GameActorSnapshot,
    options: {
      reason: "checkpoint" | "disconnect" | "linkdead_timeout";
      atMs?: number;
      logout?: boolean;
      playMs?: number;
    },
  ): void;
  markSeen?(characterId: string, atMs?: number): void;
}

interface RustAuthorityActorUpsertMode {
  bareStart?: boolean;
  returning?: boolean;
}

export interface GameShardCharacterSpawn {
  areaId: string;
  x: number;
  y: number;
  facing: Direction;
}
export interface GameShardIngressBudgetRuleOptions {
  capacity?: number;
  refillPerSecond?: number;
}

export interface GameShardIngressBudgetOptions {
  capacity?: number;
  refillPerSecond?: number;
  commandKinds?: Record<string, GameShardIngressBudgetRuleOptions>;
  nowMs?: () => number;
}

interface IngressBudgetRule {
  capacity: number;
  refillPerSecond: number;
}

interface IngressBudgetConfig {
  default: IngressBudgetRule;
  commandKinds: Record<string, IngressBudgetRule>;
  nowMs: () => number;
}

interface IngressBudgetBucket {
  tokens: number;
  updatedAtMs: number;
}


export interface GameShardOptions {
  shardId?: string;
  slicePath: string;
  logger?: Pick<FastifyBaseLogger, "warn" | "info" | "debug">;
  maxSessions?: number;
  maxPacketBytes?: number;
  areaInterestRadiusCells?: number;
  snapshotIntervalMs?: number;
  clock?: ShardClock;
  worldClock?: {
    realSecondsPerGameDay?: number;
    epochMinuteOfDay?: number;
  };
  persistence?: GameShardPersistenceOptions;
  mapBundlePath?: string;
  /** Startup loss guard: at least one durable character has entered the world. */
  hasEnteredCharacters?: boolean;
  characterPersistence?: GameCharacterPersistenceOptions;
  /** Private, non-persistent harness fixture only; never character-store state. */
  verificationFixtureLoadouts?: VerificationFixtureLoadouts;
  /**
   * Runtime must provide Rust authority. This flag exists only for focused
   * in-process reducer tests that do not exercise live gameplay authority.
   */
  rustAuthorityBridge?: GameShardRustAuthorityBridgeOptions;
  allowInProcessAuthorityForTests?: boolean;
  /** Private reserved/existing-actor session harness escape hatch; production transports must never enable this. */
  allowReservedActorSessionsForTests?: boolean;
  ingressBudget?: GameShardIngressBudgetOptions;
  /** Bounded per-session transport backlog before the session is isolated. */
  slowConsumerBufferCapBytes?: number;
  sessionRevocations?: LaunchSessionRevocationSink;
}

export interface GameShardPersistenceOptions {
  checkpointPath?: string;
  journalPath?: string;
  manifestPath?: string;
  controlSchemaHead?: { version: number; checksum: string };
  checkpointIntervalMs?: number
}

export interface GameShardCheckpointEvidence {
  schema: "successor.game-shard-checkpoint-evidence.v1";
  shardId: string;
  tick: number;
  stateHash: string;
  projectionStateHash: string;
  persistence: {
    enabled: true;
    checkpointPath: string;
    journalPath?: string;
    checkpointWriteCount: number;
    lastCheckpointAt: string;
    lastCheckpointTick: number;
    lastCheckpointReason: string;
    stateHash: string;
  };
}

export type GameShardCheckpointErrorCode = "persistence_disabled" | "checkpoint_failed";

export class GameShardCheckpointError extends Error {
  constructor(
    readonly code: GameShardCheckpointErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "GameShardCheckpointError";
  }
}

export interface GameShardRustAuthorityBridgeOptions {
  enabled?: boolean;
  cwd?: string;
  command?: string;
  args?: string[];
  /**
   * Private deterministic craft-roll key injection for focused GameShard
   * harnesses. Production callers must not configure this.
   */
  craftRollKey?: string;
}

type GameShardAuthorityMode = "live" | "in-process-test";

interface SliceActor {
  id: string;
  /** Stable authored entity identity used by the Rust fixture. */
  entity?: string;
  label: string;
  areaId: string;
  role?: string;
  professionIds?: string[];
  skillBoxIds?: string[];
  activeTitleId?: string | null;
  capabilities?: string[];
  careerGoalId?: string | null;
  credits?: number;
  factionId?: string | null;
  socialGroup?: string | null;
  pvpStatus?: string | null;
  playerOrganizationId?: string | null;
  playerOrganizationTag?: string | null;
  sprite?: string;
  direction: string;
  cell: Cell;
  route?: Cell[];
  static?: boolean;
  scale?: number;
  vitals?: Partial<GameActorVitals>;
  maxVitals?: Partial<GameActorVitals>;
}

interface SliceArea {
  id: string;
  width: number;
  height: number;
  biome?: "desert" | "forest" | string;
}

interface SliceTransition {
  id: string;
  label: string;
  fromAreaId: string;
  fromCell: Cell;
  triggerSize: { w: number; h: number };
  toAreaId: string;
  toCell: Cell;
  toFacing: string;
}

interface SliceCloneFacility {
  id: string;
  label: string;
  areaId: string;
  respawnCell: Cell;
  respawnFacing: string;
  sicknessDurationMs?: number;
}
interface SliceFaction {
  id: string;
  enemies?: string[];
  allies?: string[];
}
interface SliceCellSize {
  w: number;
  h: number;
}

interface SliceCoverProfile {
  rating: number;
  height: "low" | "high" | string;
}

interface SliceCollisionBounds {
  xMilli: number;
  yMilli: number;
  wMilli: number;
  hMilli: number;
}

interface SliceDoorMetadata {
  blocker: SliceCollisionBounds;
  interactRadiusCells?: number;
}



interface SliceProp {
  id: string;
  areaId: string;
  kind: string;
  cell: Cell;
  size: SliceCellSize;
  label?: string;
  entity?: string;
  interactive?: boolean;
  solid?: boolean;
  rotation?: 0 | 90 | 180 | 270;
  shelter?: boolean;
  cover?: SliceCoverProfile;
  collisionBounds?: SliceCollisionBounds[];
  door?: SliceDoorMetadata;
  container?: string;
}

interface SliceTravelCatalogCity {
  id: string;
  label: string;
  areaId?: string;
  terminalPropId: string;
  spawn: Cell;
}

interface SliceTravelCatalogPlanet {
  id: string;
  name?: string;
  label?: string;
  biome?: "desert" | "forest" | string;
  areaId?: string;
  cities: SliceTravelCatalogCity[];
}

interface SliceTravelCatalog {
  schema: "successor.travel-catalog.v1" | string;
  ticketItem?: { id: "travel_ticket" | string; numericId: number; name?: string; label?: string };
  planets: SliceTravelCatalogPlanet[];
}

interface TravelTicketData {
  ticketId: string;
  fromPlanetId: string;
  fromCityId: string;
  toPlanetId: string;
  toCityId: string;
  originTerminalPropId: string;
  originAreaId: string;
  destAreaId: string;
  destSpawn: Cell;
}

interface SliceWeaponRangeBandTuning {
  pointBlankCells: number;
  idealCells: number;
  maxCells: number;
}

interface SliceCombatTuning {
  weaponRangeBands?: Record<string, SliceWeaponRangeBandTuning>;
}

interface SlicePayload {
  tick?: number;
  tickRateHz?: number;
  stateHash?: string;
  combatModel?: string;
  combatTuning?: SliceCombatTuning;
  worldSeed?: number;
  factions?: SliceFaction[];
  populationTemplates?: unknown[];
  spawnZones?: SliceSpawnZone[];
  actors: SliceActor[];
  areas: SliceArea[];
  props?: SliceProp[];
  weather?: SliceWeatherConfig[];
  blockedCells: Array<Cell & { areaId: string }>;
  transitions: SliceTransition[];
  cloneFacilities?: SliceCloneFacility[];
  inventory?: RustAuthorityInventorySnapshot[];
  reservations?: RustAuthorityReservationSnapshot[];
  travelCatalog?: SliceTravelCatalog;
}

interface SliceSpawnZone {
  initialCount?: number;
}

function declaredSliceActorCount(payload: Pick<SlicePayload, "actors" | "spawnZones">): number {
  const authoredCount = Array.isArray(payload.actors) ? payload.actors.length : 0;
  const initialGeneratedCount = (payload.spawnZones ?? []).reduce((total, zone) => {
    const count = typeof zone.initialCount === "number" && Number.isFinite(zone.initialCount)
      ? Math.max(0, Math.trunc(zone.initialCount))
      : 0;
    return total + count;
  }, 0);
  return authoredCount + initialGeneratedCount;
}

interface Cell {
  x: number;
  y: number;
}

type Direction = "front" | "right" | "back" | "left";
type BodyZone = GameCombatEvent["zone"];

interface AuthoritySuppressionState {
  pressure: number;
  source: Cell | null;
}

interface AuthoritySleepState {
  active: boolean;
  stacks: number;
  remainingMs: number;
}

interface AuthorityActor {
  id: string;
  label: string;
  displayName: string;
  descriptor?: string;
  linkDead: boolean;
  appearance: GameActorAppearanceSnapshot;
  /** Durable palette cache retained when Rust unequips creator clothing. */
  wornColors: Record<string, string[]>;
  /** Worn wardrobe set — shard-owned cosmetic truth, never sourced from Rust. */
  worn?: GameActorWornPiece[];
  characterId?: string;
  sprite: string | null;
  role: string;
  templateId?: string | null;
  spawnZoneId?: string | null;
  factionId: string | null;
  socialGroup: string | null;
  pvpStatus: "none" | "covert" | "overt";
  aiAttitude?: GameActorSnapshot["aiAttitude"];
  willAutoAggro: boolean;
  playerOrganizationId: string | null;
  playerOrganizationTag: string | null;
  areaId: string;
  x: number;
  y: number;
  direction: Direction;
  posture: GameActorSnapshot["posture"];
  postureUntilTick: number;
  lifeState: GameActorLifeState;
  lifecycleSeq: number;
  vitals: GameActorVitals;
  maxVitals: GameActorVitals;
  effectiveStats: EffectiveActorStats;
  bleed: AuthorityBleedState;
  statuses: AuthorityStatus[];
  mobility?: GameActorSnapshot["mobility"];
  personalShield?: GameActorSnapshot["personalShield"];
  weapon?: GameActorWeaponSnapshot | null;
  stats?: GameActorSnapshot["stats"];
  professions?: GameActorSnapshot["professions"];
  activeTitle?: GameActorSnapshot["activeTitle"];
  professionIds?: string[];
  skillBoxIds?: string[];
  activeTitleId?: string | null;
  capabilities?: string[];
  careerGoalId?: string | null;
  skillPointsUsed?: number;
  skillPointsCap?: number;
  credits?: number;
  shotSpreadDegreesMilli?: number;
  combatQueue?: GameActorCombatQueueSnapshot;
  abilityQueue?: AbilityQueueView | null;
  inCombat: boolean;
  peaceRequested: boolean;
  engagementTargetId: string | null;
  sleep: AuthoritySleepState;
  seenCommands: Set<number>;
  nextBleedStackId: number;
  recentIncomingDamage: number;
  respawnAtTick: number;
  nextSampleTick: number;
  suppression: AuthoritySuppressionState;
  nextMoveTick: number;
  sprintRegenBlockedUntilTick: number;
  sprintActionDrainMilli: number;
  bodyVanishAtTick: number;
  lootable: boolean;
  hasLoot: boolean;
  lootRightsActorId: string | null;
  cloneSicknessRemainingMs: number;
  incapRemainingMs: number;
  incapCount: number;
  incapWindowMs: number;
  route: Cell[];
  routeIndex: number;
  homeAreaId: string;
  homeCell: Cell;
  homeDirection: Direction;
  homeRoute: Cell[];
  scale: number;
}

interface AuthorityBleedState extends GameActorBleed {
  stacks: AuthorityBleedStack[];
}

interface AuthorityBleedStack {
  id: number;
  severity: number;
  remainingMs: number;
  ratesPerSecond: GameActorVitals;
}

interface AuthorityStatus {
  id: string;
  label: string;
  severity: number;
  remainingMs: number;
  stacks?: number;
  threshold?: number;
}


interface SessionInterestView {
  viewportWidthCells: number;
  viewportHeightCells: number;
  marginCells: number;
  updatedAtTick: number;
  /** Actor the camera is centered on (normally the player's own; the followed actor for a spectator cam). */
  centerActorId?: string;
}

type ActorInterestTier = "visible" | "warm";

interface ActorInterestMatch {
  tier: ActorInterestTier;
  distanceSq: number;
}

interface GameSession {
  id: string;
  actorId: string;
  socket: GameSocket;
  /** Fail-closes this one transport without sending another packet. */
  failClose: () => void;
  slowConsumerClosing: boolean;
  connectedAt: string;
  connectedAtMs: number;
  characterId?: string;
  // Bare /survey //sample reuse-last memory (reuse-last-parameters). Session-scoped,
  // NOT persisted — dropped with the session on disconnect. Never enters Rust
  // state or the journal; it only expands an ingress sentinel to a concrete family.
  lastResourceFamily?: string;
  seenCommands: Set<number>;
  ingressBudgets: Map<string, IngressBudgetBucket>;
  lastSnapshotTick: number;
  lastActorDeltaTick: number;
  pendingReceipts: GameCommandReceipt[];
  pendingDialogueDeliveries: GameDialogueDelivery[];
  pendingEvents: GameCombatEvent[];
  pendingAbilityQueueEvents: AbilityQueueEvent[];
  lastCombatEventDeltaTick: number;
  deferredDirtyActorIds: Set<string>;
  deferredDirtyActorFirstSeenTicks: Map<string, number>;
  knownActorIds: Set<string>;
  knownActorSnapshots: Map<string, GameActorSnapshot>;
  knownInventoryRows?: Map<string, RustAuthorityInventorySnapshot>;
  knownReservationRows?: Map<string, RustAuthorityReservationSnapshot>;
  needsFullSnapshot: boolean;
  viewInterest: SessionInterestView | null;
  interestDirty: boolean;
  launchProvenance?: LaunchProvenance;
  unregisterRevocation?: () => void;
}

export interface GameShardDurabilityManifest {
  schema: "successor.state-generation-manifest.v1";
  release: string;
  sourceStateHash: string;
  fixtureHash: string;
  mapBundleHash: string;
  wireSchema: "successor.authoritative-shard-delta.v1";
  saveSchema: "successor.game-shard-checkpoint.v1";
  journalAnchor: "checkpoint";
  characterMirror: "successor.character-store.v2";
  craftRollKeyId: string;
  controlSchemaHead: { version: number; checksum: string };
  generation: string
}

interface GameShardPersistenceStatus {
  enabled: boolean;
  checkpointPath?: string;
  journalPath?: string;
  checkpointIntervalMs: number;
  checkpointWriteCount: number;
  journalBufferedEntries: number;
  commitWorkerInFlight: boolean;
  journalCommitCount: number;
  lastJournalCommitAt?: string;
  writeFailure?: string;
  lastCheckpointAt?: string;
  lastCheckpointTick?: number;
  lastCheckpointReason?: string;
  restore?: {
    loaded: boolean;
    reason?: string;
    at?: string;
    tick?: number;
    actorCount?: number;
    rustStateHash?: string;
    journalReplayed?: number;
    error?: string;
  };
  stateHash: string;
}

interface RustAuthorityCheckpointState {
  schema: "authority.checkpoint-state.v1";
  version: 1;
  tick: number;
  stateHash: string;
  state: RustAuthorityStateBlob;
}

interface GameShardCheckpointProjection {
  schema: "successor.game-shard-checkpoint.v1";
  shardId: string;
  sliceHash: string;
  /** Authored semantic source hash used to decide raw-slice compatibility. */
  sourceStateHash?: string;
  tick: number;
  tickRateHz: number;
  nextCombatEventId: number;
  nextBotSeq: number;
  counters: GameShardCounters;
  actors: PersistedAuthorityActor[];
  /** Authored Rust placeholder id -> durable owning character id. */
  authoredPlaceholderOwners?: Record<string, string>;
  propStates?: Record<string, GamePropState>;
  travelTickets?: RustAuthorityInventorySnapshot[];
  manifest?: GameShardDurabilityManifest;
}

interface GameShardCheckpoint extends GameShardCheckpointProjection {
  savedAt: string;
  stateHash: string;
  projectionStateHash?: string;
  rustAuthority?: RustAuthorityCheckpointState;
}

type GameShardCounters = GameShardSnapshot["counters"] & {
  packetsIn: number;
  packetsOut: number;
  bytesOut: number;
  rejectedPackets: number;
};

export interface GameShardRecentRejection {
  tick: number;
  actorId: string;
  kind: string;
  reasonCode: string;
}

type PersistedAuthorityActor = Omit<AuthorityActor, "seenCommands" | "effectiveStats" | "role"> & { effectiveStats?: EffectiveActorStats; role?: string };

type JournalEntry =
  | {
      type: "session.connect";
      at: string;
      tick: number;
      sessionId: string;
      actorId: string;
      playerId: string;
      zoneId: string;
    }
  | {
      type: "session.disconnect";
      at: string;
      tick: number;
      sessionId: string;
      actorId: string;
      removedTransientActor: boolean;
    }
  | {
      type: "command.receipt";
      at: string;
      tick: number;
      actorId: string;
      commandId: number;
      commandKind: string;
      accepted: boolean;
      reasonCode?: string;
      eventIds: number[];
      rust?: {
        actorId: string;
        rustActorId: string;
        envelope: ClientCommandEnvelope;
        session?: number;
        player?: number;
        stateHash?: string;
      };
    }
  | {
      type: "combat.event";
      at: string;
      tick: number;
      event: GameCombatEvent;
    }
  | {
      type: "checkpoint";
      at: string;
      tick: number;
      reason: string;
      actorCount: number;
      stateHash: string;
    };

interface ApplyCommandResult {
  accepted: boolean;
  reasonCode?: string;
  events: GameCombatEvent[];
}

interface DirtyActorSpatialEntry {
  id: string;
  actor: AuthorityActor;
}
type DirtyActorSpatialIndex = Map<string, Map<string, DirtyActorSpatialEntry[]>>;
interface ActorInterestBucketRef {
  areaId: string;
  bucketKey: string;
  bucketX: number;
  bucketY: number;
  x: number;
  y: number;
}

interface AoiBookkeepingMetrics {
  bucketRebuilds: number;
  bucketReconciles: number;
  bucketTransitions: number;
  bucketCandidateVisits: number;
  sessionRefreshes: number;
  sessionDiffAdds: number;
  sessionDiffRemoves: number;
  routineEntriesFromSet: number;
}

type ActorInterestSpatialIndex = Map<string, Map<string, AuthorityActor[]>>;

interface RuntimeTimingSummary {
  count: number;
  last: number;
  avg: number;
  p95: number;
  max: number;
}

interface AuthorityCadenceStatus {
  clockSource: "rust-fixed-interval" | "snapshot-flush";
  targetTickMs: number;
  authorityIntervalMs: number;
  snapshotIntervalMs: number;
  flushes: number;
  skippedInFlight: number;
  zeroTickFlushes: number;
  lastTickCount: number;
  maxTickCount: number;
  tickStep: RuntimeTimingSummary;
  flushDurationMs: RuntimeTimingSummary;
  snapshotBuildMs: RuntimeTimingSummary;
}

const runtimeTimingSampleLimit = 512;

class RuntimeTimingTracker {
  private readonly samples: number[] = [];
  private total = 0;
  private last = 0;
  private max = 0;

  record(value: number): void {
    const safeValue = Math.max(0, Math.round(value * 10) / 10);
    this.samples.push(safeValue);
    this.total += safeValue;
    this.last = safeValue;
    this.max = Math.max(this.max, safeValue);
    while (this.samples.length > runtimeTimingSampleLimit) {
      this.total -= this.samples.shift() ?? 0;
    }
  }

  summary(): RuntimeTimingSummary {
    const sorted = [...this.samples].sort((a, b) => a - b);
    const count = sorted.length;
    const p95Index = count > 0 ? Math.min(count - 1, Math.ceil(count * 0.95) - 1) : 0;
    return {
      count,
      last: this.last,
      avg: count > 0 ? Math.round((this.total / count) * 10) / 10 : 0,
      p95: count > 0 ? sorted[p95Index] ?? 0 : 0,
      max: this.max,
    };
  }
}

export interface GameShardWeatherStatus extends GameWeatherSnapshot {
  actorsInStorm: number;
  shelteredActors: number;
}

export interface GameShardStatus {
  shardId: string;
  tick: number;
  clock: { mode: ShardClock["mode"] };
  worldClock: WorldClockSnapshot;
  weather: GameShardWeatherStatus[];
  sessionCount: number;
  actorCount: number;
  counters: GameShardCounters;
  instrumentation: {
    sessions: { active: number; joined: number; disconnected: number };
    commands: { accepted: number; rejected: number; receipts: number };
    delivery: {
      queueDepth: number;
      pendingReceipts: number;
      pendingEvents: number;
      pendingAbilityQueueEvents: number;
      deferredDirtyActors: number;
      deferredDirtyActorHighWater: number;
      deferredDirtyActorOldestAgeTicks: number;
      backpressure: {
        queuedBytes: number;
        maxQueuedBytes: number;
        currentBufferedBytes: number;
        maxBufferedBytes: number;
        capBytes: number;
        slowConsumerCount: number;
        slowConsumerDisconnects: number;
      };
    };
    bridge: { diagnosticPending: number; livePending: number; cadencePending: number; workloadLivePending: number; commandBatchPending: number; commandBatchPendingItems: number; backlogSize: number; workloadBacklogSize: number };
    eventLoopLag: { p50Ms: number; p95Ms: number; maxMs: number; meanMs: number };
  };
  recentRejections: GameShardRecentRejection[];
  authority: {
    mode: GameShardAuthorityMode;
    rustLive: boolean;
    inProcessAuthorityForTests: boolean;
    metrics?: RustAuthorityBridgeStepOutput["metrics"] | RustAuthorityBridgeTickOutput["metrics"];
    exchangeMetrics?: RustAuthorityExchangeMetricsSnapshot;
    tickTiming?: RustAuthorityBridgeTickOutput["timing"];
    bridge?: RustAuthorityBridgeDebugStatus | null;
    cadence: AuthorityCadenceStatus;
  };
  source: {
    stateHash: string;
    sliceHash: string;
    actorCount: number;
    areas: Array<{ id: string; width: number; height: number; biome?: string; actorCount: number; resourceSpawns: GameResourceSpawn[] }>;
  };
  limits: {
    maxSessions: number;
    maxPacketBytes: number;
    areaInterestRadiusCells: number;
    slowConsumerBufferCapBytes: number;
  };
  persistence: GameShardPersistenceStatus;
  durabilityManifest?: GameShardDurabilityManifest;
  readiness: {
    ready: boolean;
    lock: boolean;
    preflight: boolean;
    restore: boolean;
    writablePersistence: boolean;
    commitWorker: boolean;
    rustChild: boolean;
  };
}

export interface GameShardDebugOracle {
  schema: "successor.game-shard-oracle.v1";
  shardId: string;
  tick: number;
  worldClock: WorldClockSnapshot;
  weather: GameShardWeatherStatus[];
  authority: GameShardStatus["authority"];
  source: GameShardStatus["source"];
  counters: GameShardCounters;
  actors: Record<string, GameActorSnapshot & {
    authored: boolean;
    transientSession: boolean;
    netId: number | null;
  }>;
  inventory: RustAuthorityInventorySnapshot[];
  reservations: RustAuthorityReservationSnapshot[];
  timelineEvents: RustAuthorityTimelineEventSnapshot[];
  resourceSpawns: GameResourceSpawn[];
  placedExtractors: PlacedExtractorVM[];
  placedCamps: PlacedCampVM[];
  building: GameBuildingProjection;
  placedParcels: ParcelVM[];
  farmPlots: FarmPlotVM[];
  draftedSchematics: GameDraftedSchematic[];
  groupViews: Record<string, GameGroupView>;
  propStates: Record<string, GamePropState>;
  sessions: Array<{
    id: string;
    actorId: string;
    knownActorCount: number;
    pendingReceiptCount: number;
    pendingEventCount: number;
    needsFullSnapshot: boolean;
    interestDirty: boolean;
    deferredDirtyActorCount: number;
    lastSnapshotTick: number;
    lastActorDeltaTick: number;
    viewInterest: SessionInterestView | null;
  }>;
  aiDebug?: RustAuthorityAiDebugSnapshot;
}

interface AbilityQueueEventDelivery {
  actorId: string;
  event: AbilityQueueEvent;
}

export interface SubmitCommandResult {
  receipt: GameCommandReceipt;
  events: GameCombatEvent[];
  delta: GameShardDelta;
  abilityQueueEvents?: AbilityQueueEvent[];
  surveyResult?: GameSurveyResult;
  craftSession?: GameCraftSession;
  spliceSession?: GameSpliceSession;
  genomeScan?: GameGenomeScan;
  tradeSessionDeliveries?: GameTradeSessionDelivery[];
  duelOutcomes?: GameDuelOutcome[];
  draftedSchematics?: GameDraftedSchematic[];
}

export interface DebugAuthorityCommandResult extends SubmitCommandResult {
  actorId: string;
  commandId: number;
  commandKind: string;
}

const websocketOpen = 1;
const gameMoveTraceEnabled = process.env.GAME_MOVE_TRACE === "1";
const defaultMaxSessions = 1_200;
const gameMaxSessionsEnv = "GAME_MAX_SESSIONS";
const defaultMaxPacketBytes = 65_536;
const defaultSnapshotIntervalMs = 25;
const defaultSlowConsumerBufferCapBytes = 1_048_576;
const slowConsumerBufferCapEnv = "GAME_SLOW_CONSUMER_BUFFER_CAP_BYTES";
const defaultCheckpointIntervalMs = 5_000;
const defaultInterestRadiusCells = 192;
const defaultTickRateHz = 30;
const milliCellsPerCell = 1_000;
const exchangeInteractionRadiusCells = 1.5;
const harvestInteractionRadiusCells = 1.75;
const ammoRefillRadiusCells = 3;
const travelTerminalInteractionRadiusCells = 10;
const travelTicketItemKey = "travel_ticket";
const travelTicketNumericItemId = 5_001;
const standardDeployLoadoutItemIds = [1_001, 1_002, 1_101] as const;
const globalInventoryContainerNamespaceRoots = ["corpse", "cache", "district-exchange"] as const;
const checkpointSchema = "successor.game-shard-checkpoint.v1" as const;
const journalFlushEntryThreshold = 64;
// MUST equal the Rust authority's PLAYER_SPEED_MILLI_CELLS_PER_SECOND (1_357)
// and client tuning.v1.json — this constant drives ONLY the in-process test
// authority (rustAuthorityMode !== "live"); the stale 4.35 value made that
// path move 3.2x faster than live Rust and would distort any in-process
// movement/collision test.
const playerSpeedCellsPerSecond = 1.357;
const sprintSpeedMultiplier = 4.809;
const sprintActionDrainPerSecond = 10;
const maxSnapshotActors = 256;
const maxDeltaActors = maxSnapshotActors;
const maxDirtyDeltaActors = maxSnapshotActors;
const maxNewActorsPerDelta = maxSnapshotActors;
const actorMovementQuantization = 100;
const nearActorMovementRadiusCells = 36;
const midActorMovementRadiusCells = 68;
// Per-actor movement delta cadence by distance tier. Halved so NEAR actors (combat you're
// watching) stream every sim tick (30Hz) instead of every 2 (15Hz) — the binding throttle behind
// the reported choppy "netcode lag". Mid/far tightened too. Local play has few actors, so the
// extra fan-out is cheap; the per-flush session/actor budgets still bound worst case.
const nearActorMovementCadenceTicks = 1;
const midActorMovementCadenceTicks = 2;
const farActorMovementCadenceTicks = 3;
const defaultViewportWidthCells = 84;
const defaultViewportHeightCells = 48;
const defaultViewportMarginCells = 8;
const maxViewportWidthCells = 256;
const maxViewportHeightCells = 144;
const maxViewportMarginCells = 128;
const warmInterestMarginCells = 10;
const dirtyActorSpatialBucketCells = 8;
const actorInterestSpatialBucketCells = 8;
const maxEventFocusActors = maxSnapshotActors;
const maxCombatEventInterestRadiusCells = 192;
const maxPendingCombatEventsPerSession = 512;
// Deliver actor/combat deltas every sim tick (30Hz). The per-flush
// session/actor budgets below still bound worst-case fan-out.
const observerCombatEventIntervalTicks = 1;
const routineDeltaIntervalTicks = 1;
const maxDeferredDirtyActorsPerSession = maxSnapshotActors * 2;
const maxRoutineInterestActorsPerDelta = maxSnapshotActors;
const priorityRoutineInterestActorsPerDelta = 32;
const maxRoutineActorDeliveriesPerDelta = maxSnapshotActors;
const maxRoutineSessionsPerFlush = 8;
const maxObserverUrgentSessionsPerFlush = 72;
const maxStatusDetailActorsPerDelta = maxSnapshotActors;
const maxActorRemovalsPerDelta = 64;
const commandPrioritySnapshotDeferMs = 0;
const maxSnapshotDeferMs = 90;
const maxAuthorityTicksPerFlush = 30;
const maxRustAuthorityTickRequestTicks = 65_535;
const rustAiDebugOracleRefreshIntervalMs = 750;
const rustAiDebugOracleTimeoutMs = 1_000;
const npcDeadBodyVisibleSeconds = 30;
const npcRespawnDelayAfterBodyVanishSeconds = 30;
const skirmisherDeadBodyVisibleSeconds = 120;
const skirmisherRespawnDelayAfterBodyVanishSeconds = 5;
const recentRejectionCapacity = 32;
const defaultCharacterCheckpointIntervalMs = 30_000;
const defaultActorAppearance: GameActorAppearanceSnapshot = {
  skin: "#c78f62",
  hair: null,
  hair_mat: "hair_raven",
  face: null,
};

export interface GameShardDebugClockAdvanceStats {
  authorityBridgeRequests: number;
  authorityBridgeTicks: number;
  authorityBridgeBatchedRequests: number;
  authorityBridgeMaxTicksPerRequest: number;
}

interface ActiveDebugClockAdvance extends GameShardDebugClockAdvanceStats {
  callbacksRemaining: number;
  skipCallbacks: number;
}

export class GameShard {
  private readonly shardId: string;
  private readonly logger?: Pick<FastifyBaseLogger, "warn" | "info" | "debug">;
  private readonly maxSessions: number;
  private readonly maxPacketBytes: number;
  private readonly areaInterestRadiusCells: number;
  private readonly slowConsumerBufferCapBytes: number;
  private readonly sessionRevocations?: LaunchSessionRevocationSink;
  private readonly clock: ShardClock;
  private readonly snapshotInterval: ShardTimer;
  private readonly snapshotIntervalMs: number;
  private readonly authorityIntervalMs: number;
  private rustAuthorityInterval?: ShardTimer;
  private readonly allowInProcessAuthorityForTests: boolean;
  private readonly allowReservedActorSessionsForTests: boolean;
  private readonly ingressBudgetConfig: IngressBudgetConfig;
  private rustAuthorityBridge?: RustAuthorityBridge;
  private rustAuthorityBridgeGeneration = 0;
  private readonly rustAuthorityBridgeOptions?: RustAuthorityBridgeOptions;
  private readonly craftRollKey: string;
  private readonly rustAuthorityMode: "live" | null;
  private closed = false;
  private rustAuthorityFlushInFlight = false;
  private liveAuthorityNextTickAtMs = 0;
  private activeDebugClockAdvance: ActiveDebugClockAdvance | null = null;
  private lastRustAuthorityMetrics?: RustAuthorityBridgeStepOutput["metrics"] | RustAuthorityBridgeTickOutput["metrics"];
  private lastRustAuthorityExchangeMetrics?: RustAuthorityExchangeMetricsSnapshot;
  private lastRustAuthorityTickTiming?: RustAuthorityBridgeTickOutput["timing"];
  private lastRustAuthorityAiDebug?: RustAuthorityAiDebugSnapshot;
  private lastRustAuthorityAiDebugRefreshAtMs = 0;
  private lastRustAuthorityPlacedExtractors: PlacedExtractorVM[] = [];
  private lastRustAuthorityPlacedCamps: PlacedCampVM[] = [];
  private lastRustAuthorityBuilding: GameBuildingProjection = {
    schema: "successor.authority-building.v1",
    tick: 0,
    components: [],
    interiors: [],
  };
  private readonly lastRustAuthorityBankByActorId = new Map<string, GameBankSnapshot>();
  private lastRustAuthorityPlayerCorpses: Array<GamePlayerCorpseSnapshot & { ownerActorId: string }> = [];
  private lastRustAuthorityPlacedParcels: ParcelVM[] = [];
  private lastRustAuthorityFarmPlots: FarmPlotVM[] = [];
  private lastRustAuthorityDraftedSchematics: GameDraftedSchematic[] = [];
  private lastRustAuthorityGuildViewsByActorId = new Map<string, GameGuildView>();
  private lastRustAuthorityGroupViewsByActorId = new Map<string, GameGroupView>();
  private lastRustAuthorityDuelViewsByActorId = new Map<string, GameDuelView>();
  private rustAuthorityAiDebugRefreshInFlight: Promise<void> | null = null;
  private rustAuthorityRestorePromise?: Promise<void>;
  private rustAuthorityRestoreError?: Error;
  private rustAuthorityCheckpointPromise?: Promise<void>;
  private lastRustAuthorityStateHash?: string;
  private readonly characterPersistence?: GameCharacterPersistenceOptions;
  private readonly characterCheckpointIntervalMs: number;
  private readonly verificationFixtureLoadouts: VerificationFixtureLoadouts;
  private readonly durabilityManifest: GameShardDurabilityManifest;
  private readonly mapBundleHash: string;
  private readonly persistence: Required<Pick<GameShardPersistenceOptions, "checkpointIntervalMs">> & {
    checkpointPath?: string;
    journalPath?: string;
    manifestPath?: string;
    controlSchemaHead?: { version: number; checksum: string };
  };
  private readonly worldClockConfig: WorldClockConfig;
  private readonly weatherControllers = new Map<string, AreaWeatherController>();
  private readonly weatherSheltersByArea = new Map<string, RustAuthorityWeatherHazardInput["shelters"]>();
  private tickRateHz = defaultTickRateHz;
  private sliceHash = "";
  private sourceStateHash = "";
  private sourceActorCount = 0;
  private readonly areas = new Map<string, SliceArea>();
  private readonly transitions = new Map<string, SliceTransition>();
  private readonly cloneFacilities = new Map<string, SliceCloneFacility>();
  private readonly factions = new Map<string, SliceFaction>();
  private readonly blockedByArea = new Map<string, Set<string>>();
  private readonly actors = new Map<string, AuthorityActor>();
  private readonly initialAuthoredActors = new Map<string, PersistedAuthorityActor>();
  private inventory: RustAuthorityInventorySnapshot[] = [];
  private initialInventory: RustAuthorityInventorySnapshot[] = [];
  private travelCatalog: SliceTravelCatalog | null = null;
  private readonly travelTicketRows = new Map<string, RustAuthorityInventorySnapshot>();
  private readonly travelTicketStackCounters = new Map<string, number>();
  private reservations: RustAuthorityReservationSnapshot[] = [];
  private timelineEvents: RustAuthorityTimelineEventSnapshot[] = [];
  private readonly recentRejections: GameShardRecentRejection[] = [];
  private recentRejectionWriteIndex = 0;
  private resourceSpawns: GameResourceSpawn[] = [];
  private readonly resourceSpawnsByArea = new Map<string, GameResourceSpawn[]>();
  private readonly placedExtractorsByArea = new Map<string, PlacedExtractorVM[]>();
  private readonly placedCampsByArea = new Map<string, PlacedCampVM[]>();
  private readonly placedParcelsByArea = new Map<string, ParcelVM[]>();
  private readonly farmPlotsByArea = new Map<string, FarmPlotVM[]>();
  private readonly props = new Map<string, SliceProp>();
  private readonly propStates = new Map<string, GamePropState>();
  private readonly initialPropStates = new Map<string, GamePropState>();
  private readonly actorNetIds = new Map<string, number>();
  private readonly actorIdsByNetId = new Map<number, string>();
  private readonly sessions = new Map<string, GameSession>();
  private readonly activeTradeSessionsByActorId = new Map<string, GameTradeSession>();
  private readonly characterIdsByActorId = new Map<string, string>();
  private readonly characterActorIds = new Map<string, string>();
  private readonly lastCharacterCheckpointMs = new Map<string, number>();
  private readonly debugSeenCommandsByActor = new Map<string, Set<number>>();
  private readonly debugNextCommandIdByActor = new Map<string, number>();
  private tick = 0;
  private nextSessionSeq = 1;
  private nextRoutineSessionId: string | null = null;
  private deferredDirtyActorHighWater = 0;
  private nextCombatEventId = 1;
  private nextBotSeq = 1;
  private nextActorNetId = 1;
  private deferSnapshotsUntilMs = 0;
  private lastSnapshotFlushMs: number;
  private lastAuthorityAdvanceMs: number;
  private authorityTickRemainderMs = 0;
  private authorityFlushCount = 0;
  private authoritySkippedInFlightCount = 0;
  private authorityZeroTickFlushCount = 0;
  private lastAuthorityTickCount = 0;
  private maxAuthorityTickCount = 0;
  private readonly authorityTickStepTiming = new RuntimeTimingTracker();
  private readonly authorityFlushDurationTiming = new RuntimeTimingTracker();
  private readonly snapshotBuildTiming = new RuntimeTimingTracker();
  private readonly eventLoopLag = monitorEventLoopDelay({ resolution: 20 });
  private sessionJoinCount = 0;
  private sessionDisconnectCount = 0;
  private slowConsumerDisconnectCount = 0;
  private maxTransportBufferedBytes = 0;
  private lastCheckpointAttemptMs: number;
  private lastCheckpointAt: string | undefined;
  private lastCheckpointTick: number | undefined;
  private lastCheckpointReason: string | undefined;
  private checkpointWriteCount = 0;
  private persistenceDirty = false;
  private restoredCheckpoint: GameShardPersistenceStatus["restore"];
  private readonly journalBuffer: string[] = [];
  private journalCommitCount = 0;
  private lastJournalCommitAt: string | undefined;
  private persistenceWriteFailure: string | undefined;
  private journalCommitPromise: Promise<boolean> | undefined;
  private journalCommitTimer: NodeJS.Timeout | undefined;
  private checkpointCapturePromise: Promise<void> | undefined;
  private dirty = false;
  private readonly authoredActorIds = new Set<string>();
  private readonly authoredRustEntityByActorId = new Map<string, string>();
  private readonly transientSessionActorIds = new Set<string>();
  private readonly dirtyActorIds = new Set<string>();
  private readonly highDetailDirtyActorIds = new Set<string>();
  private readonly statusDirtyActorIds = new Set<string>();
  private readonly pendingLinkDeadRebroadcastActorIds = new Set<string>();
  private readonly claimedAuthoredPlaceholders = new Map<string, string>();
  private readonly authoredPlaceholderOwners = new Map<string, string>();
  private readonly realCharacterActorIds = new Set<string>();
  private readonly returningCharacterActorIds = new Set<string>();
  private defaultCharacterSpawn: GameShardCharacterSpawn | null = null;
  private readonly rustAuthorityRegisteredActorIds = new Set<string>();
  private readonly rustAuthorityLinkDeadActorIds = new Set<string>();
  private readonly rustAuthorityDesiredLinkDead = new Map<string, boolean>();
  private readonly rustAuthorityActorUpserts = new Map<string, Promise<void>>();
  private readonly rustAuthorityLinkDeadEffects = new Map<string, Promise<void>>();
  // AOI bookkeeping: maintained actor buckets + reciprocal session interest sets.
  private cachedActorInterestSpatialIndex: ActorInterestSpatialIndex = new Map<string, Map<string, AuthorityActor[]>>();
  private actorInterestSpatialIndexReady = false;
  private actorInterestSpatialIndexDirty = false;
  private readonly actorInterestBucketRefs = new Map<string, ActorInterestBucketRef>();
  private readonly actorInterestOrder = new Map<string, number>();
  private nextActorInterestOrder = 1;
  private readonly sessionInterestActorIds = new WeakMap<GameSession, Set<string>>();
  private readonly sessionInterestSignatures = new WeakMap<GameSession, string>();
  private readonly actorInterestedSessions = new Map<string, Set<GameSession>>();
  private readonly aoiBookkeepingMetrics: AoiBookkeepingMetrics = {
    bucketRebuilds: 0,
    bucketReconciles: 0,
    bucketTransitions: 0,
    bucketCandidateVisits: 0,
    sessionRefreshes: 0,
    sessionDiffAdds: 0,
    sessionDiffRemoves: 0,
    routineEntriesFromSet: 0,
  };
  private readonly counters = {
    acceptedCommands: 0,
    rejectedCommands: 0,
    shotsFired: 0,
    hits: 0,
    deaths: 0,
    packetsIn: 0,
    packetsOut: 0,
    bytesOut: 0,
    rejectedPackets: 0,
  };

  constructor(options: GameShardOptions) {
    this.clock = options.clock ?? systemClock;
    this.shardId = options.shardId ?? "authority-test";
    this.logger = options.logger;
    this.maxSessions = normalizeMaxSessions(options.maxSessions ?? defaultMaxSessions);
    this.maxPacketBytes = options.maxPacketBytes ?? defaultMaxPacketBytes;
    this.slowConsumerBufferCapBytes = normalizeSlowConsumerBufferCapBytes(
      options.slowConsumerBufferCapBytes ?? slowConsumerBufferCapBytesFromEnv(),
    );
    this.sessionRevocations = options.sessionRevocations;
    this.areaInterestRadiusCells = options.areaInterestRadiusCells ?? defaultInterestRadiusCells;
    this.snapshotIntervalMs = options.snapshotIntervalMs ?? defaultSnapshotIntervalMs;
    this.lastSnapshotFlushMs = this.clock.nowMs();
    this.lastAuthorityAdvanceMs = this.clock.nowMs();
    this.lastCheckpointAttemptMs = this.clock.nowMs();
    this.allowInProcessAuthorityForTests = options.allowInProcessAuthorityForTests === true;
    this.allowReservedActorSessionsForTests = options.allowReservedActorSessionsForTests === true;
    if (this.allowReservedActorSessionsForTests && !this.allowInProcessAuthorityForTests) {
      throw new Error("reserved actor sessions are allowed only in the in-process test harness");
    }
    this.ingressBudgetConfig = createIngressBudgetConfig(options.ingressBudget, process.env, () => this.clock.nowMs());
    if (!options.rustAuthorityBridge?.enabled && !this.allowInProcessAuthorityForTests) {
      throw new Error("Rust authority is required for GameShard runtime construction.");
    }
    assertConfiguredPersistenceCanStart(options.persistence, options.hasEnteredCharacters === true);
    this.persistence = {
      checkpointPath: options.persistence?.checkpointPath,
      journalPath: options.persistence?.journalPath,
      manifestPath: options.persistence?.manifestPath,
      controlSchemaHead: options.persistence?.controlSchemaHead,
      checkpointIntervalMs: options.persistence?.checkpointIntervalMs ?? defaultCheckpointIntervalMs,
    };
    this.craftRollKey = resolveGameShardCraftRollKey(
      this.persistence.checkpointPath,
      options.rustAuthorityBridge?.craftRollKey,
    );
    this.characterPersistence = options.characterPersistence;
    this.characterCheckpointIntervalMs = options.characterPersistence?.checkpointIntervalMs ?? defaultCharacterCheckpointIntervalMs;
    this.verificationFixtureLoadouts = options.verificationFixtureLoadouts ?? new Map();
    this.tick = this.loadSlice(options.slicePath);
    this.mapBundleHash = options.mapBundlePath && fs.existsSync(options.mapBundlePath)
      ? sha256(fs.readFileSync(options.mapBundlePath, "utf8"))
      : "";
    this.durabilityManifest = createDurabilityManifest({
      release: process.env.GAME_RELEASE_ID ?? process.env.GIT_COMMIT ?? process.env.npm_package_version ?? "unknown",
      sourceStateHash: this.sourceStateHash,
      fixtureHash: this.sliceHash,
      mapBundleHash: this.mapBundleHash,
      craftRollKey: this.craftRollKey,
      controlSchemaHead: this.persistence.controlSchemaHead ?? { version: 0, checksum: "" },
    });
    this.authorityIntervalMs = Math.max(1, 1000 / Math.max(1, this.tickRateHz));
    this.rustAuthorityMode = options.rustAuthorityBridge?.enabled ? "live" : null;
    if (this.rustAuthorityMode) {
      this.rustAuthorityBridgeOptions = {
        slicePath: options.slicePath,
        cwd: options.rustAuthorityBridge?.cwd,
        logger: this.logger,
        areaInterestRadiusCells: this.areaInterestRadiusCells,
        command: options.rustAuthorityBridge?.command,
        args: options.rustAuthorityBridge?.args,
        craftRollKey: this.craftRollKey,
      };
      this.rustAuthorityBridge = new RustAuthorityBridge(this.rustAuthorityBridgeOptions);
      this.rustAuthorityBridgeGeneration += 1;
    }
    this.worldClockConfig = createWorldClockConfig({
      tickRateHz: this.tickRateHz,
      realSecondsPerGameDay: options.worldClock?.realSecondsPerGameDay,
      epochMinuteOfDay: options.worldClock?.epochMinuteOfDay,
    });
    const checkpointExpected = Boolean(
      this.persistence.checkpointPath && fs.existsSync(this.persistence.checkpointPath),
    );
    try {
      this.restoreCheckpoint();
      const restore = this.restoredCheckpoint;
      if (
        checkpointExpected
        && restore?.loaded !== true
        && restore?.reason !== "rust_restore_pending"
      ) {
        const checkpointPath = this.persistence.checkpointPath!;
        throw new Error(
          `refusing to start game shard because durable checkpoint restore failed (${restore?.reason ?? "unknown"}); checkpoint retained at ${checkpointPath}`,
        );
      }
    } catch (error) {
      this.rustAuthorityBridge?.close();
      throw error;
    }
    this.snapshotInterval = this.clock.setInterval(() => this.flushSnapshots(), this.snapshotIntervalMs);
    if (this.rustAuthorityMode === "live") {
      const startLiveAuthorityTicks = () => {
        if (this.closed || this.rustAuthorityRestoreError) return;
        this.liveAuthorityNextTickAtMs = this.clock.monotonicMs() + this.authorityIntervalMs;
        this.scheduleLiveRustAuthorityTick();
      };
      if (this.rustAuthorityRestorePromise) {
        void this.rustAuthorityRestorePromise.then(startLiveAuthorityTicks).catch((error) => {
          this.logger?.warn({ error }, "rust authority checkpoint restore failed; live authority ticks disabled");
        });
      } else {
        startLiveAuthorityTicks();
      }
    }
    this.eventLoopLag.enable();
  }
  async close(): Promise<void> {
    this.eventLoopLag.disable();
    this.closed = true;
    this.clock.clearInterval(this.snapshotInterval);
    if (this.rustAuthorityInterval) this.clock.clearTimeout(this.rustAuthorityInterval);
    // Persist commands already accepted by the shard before awaiting the
    // asynchronous authority drain. Callers that do not await close() still
    // must not observe a missing journal tail.
    let closeError: unknown;
    const retainCloseError = (error: unknown, message: string): void => {
      closeError ??= error;
      this.logger?.warn({ error }, message);
    };
    if (!this.flushJournal()) {
      retainCloseError(new Error("failed to flush game shard journal before close"), "failed to flush game shard journal before close");
    }
    try {
      await this.settleForDebug();
    } catch (error) {
      retainCloseError(error, "failed to settle game shard authority during close");
    }
    try {
      // A clean restart/update is a hard persistence barrier. Export the exact
      // final Rust state even if a future mutation path forgets to reopen the
      // ordinary dirty gate.
      const closeCheckpoint = this.writeCheckpoint("close", true);
      if (closeCheckpoint && typeof closeCheckpoint.then === "function") await closeCheckpoint;
    } catch (error) {
      retainCloseError(error, "failed to flush game shard checkpoint during close");
    } finally {
      try {
        this.rustAuthorityBridge?.close();
      } catch (error) {
        retainCloseError(error, "failed to close Rust authority bridge");
      }
    }
    if (!this.flushJournal()) {
      retainCloseError(new Error("failed to flush game shard journal after final checkpoint"), "failed to flush game shard journal after final checkpoint");
    }
    for (const session of this.sessions.values()) {
      try {
        session.socket.close();
      } catch (error) {
        retainCloseError(error, "failed to close game shard session socket");
      }
    }
    this.sessions.clear();
    if (closeError) throw closeError;
  }

  async settleForDebug(): Promise<void> {
    for (;;) {
      if (this.rustAuthorityRestorePromise || this.rustAuthorityRestoreError || this.rustAuthorityCheckpointPromise) {
        await this.awaitRustAuthorityReady();
      }
      const settled = !this.rustAuthorityFlushInFlight && (this.rustAuthorityBridge?.pendingCount?.() ?? 0) === 0;
      if (settled) {
        await Promise.resolve();
        const asyncSetupPending = Boolean(this.rustAuthorityCheckpointPromise);
        if (!asyncSetupPending && !this.rustAuthorityFlushInFlight && (this.rustAuthorityBridge?.pendingCount?.() ?? 0) === 0) return;
        continue;
      }
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }

  async checkpoint(reason = "manual", _options: { skipCommandQueue?: boolean } = {}): Promise<GameShardCheckpointEvidence> {
    const checkpointPath = this.persistence.checkpointPath;
    if (!checkpointPath) {
      throw new GameShardCheckpointError("persistence_disabled", "game shard checkpoint persistence is disabled");
    }
    if (this.closed) {
      throw new GameShardCheckpointError("checkpoint_failed", "cannot checkpoint a closed game shard");
    }

    try {
      await this.settleForDebug();
      const previousWriteCount = this.checkpointWriteCount;
      await this.writeCheckpoint(reason, true);
      if (this.checkpointWriteCount <= previousWriteCount) {
        throw new Error("game shard checkpoint file was not written");
      }
      if (this.persistence.journalPath && this.journalBuffer.length > 0) {
        throw new Error("game shard checkpoint journal was not flushed");
      }

      const checkpoint = JSON.parse(fs.readFileSync(checkpointPath, "utf8")) as GameShardCheckpoint;
      const projectionStateHash = this.checkpointProjectionStateHash(checkpoint);
      const validCheckpoint = checkpoint.schema === checkpointSchema
        && checkpoint.shardId === this.shardId
        && checkpoint.sliceHash === this.sliceHash
        && Number.isSafeInteger(checkpoint.tick)
        && typeof checkpoint.savedAt === "string"
        && checkpoint.savedAt.length > 0
        && typeof checkpoint.stateHash === "string"
        && checkpoint.stateHash.length > 0
        && checkpoint.projectionStateHash === projectionStateHash
        && checkpoint.savedAt === this.lastCheckpointAt
        && checkpoint.tick === this.lastCheckpointTick
        && reason === this.lastCheckpointReason;
      if (!validCheckpoint) {
        throw new Error("persisted game shard checkpoint evidence did not validate");
      }
      if (this.rustAuthorityMode === "live") {
        if (!this.isRustAuthorityCheckpointState(checkpoint.rustAuthority)
          || checkpoint.rustAuthority.tick !== checkpoint.tick
          || checkpoint.rustAuthority.stateHash !== checkpoint.stateHash) {
          throw new Error("persisted Rust authority checkpoint evidence did not validate");
        }
      } else if (checkpoint.stateHash !== projectionStateHash) {
        throw new Error("persisted in-process checkpoint hash did not validate");
      }

      return {
        schema: "successor.game-shard-checkpoint-evidence.v1",
        shardId: checkpoint.shardId,
        tick: checkpoint.tick,
        stateHash: checkpoint.stateHash,
        projectionStateHash,
        persistence: {
          enabled: true,
          checkpointPath,
          journalPath: this.persistence.journalPath,
          checkpointWriteCount: this.checkpointWriteCount,
          lastCheckpointAt: checkpoint.savedAt,
          lastCheckpointTick: checkpoint.tick,
          lastCheckpointReason: reason,
          stateHash: checkpoint.stateHash,
        },
      };
    } catch (error) {
      if (error instanceof GameShardCheckpointError) throw error;
      throw new GameShardCheckpointError("checkpoint_failed", "game shard checkpoint did not complete", { cause: error });
    }
  }

  beginDebugClockAdvance(ticks: number): void {
    if (this.rustAuthorityMode !== "live") return;
    if (this.activeDebugClockAdvance) throw new Error("debug clock advance is already active");
    if (!Number.isInteger(ticks) || ticks < 0) throw new RangeError(`debug clock ticks must be a non-negative integer; received ${ticks}`);
    this.activeDebugClockAdvance = {
      callbacksRemaining: ticks,
      skipCallbacks: 0,
      authorityBridgeRequests: 0,
      authorityBridgeTicks: 0,
      authorityBridgeBatchedRequests: 0,
      authorityBridgeMaxTicksPerRequest: 0,
    };
  }

  endDebugClockAdvance(): GameShardDebugClockAdvanceStats {
    const active = this.activeDebugClockAdvance;
    this.activeDebugClockAdvance = null;
    return active ? {
      authorityBridgeRequests: active.authorityBridgeRequests,
      authorityBridgeTicks: active.authorityBridgeTicks,
      authorityBridgeBatchedRequests: active.authorityBridgeBatchedRequests,
      authorityBridgeMaxTicksPerRequest: active.authorityBridgeMaxTicksPerRequest,
    } : {
      authorityBridgeRequests: 0,
      authorityBridgeTicks: 0,
      authorityBridgeBatchedRequests: 0,
      authorityBridgeMaxTicksPerRequest: 0,
    };
  }

  connect(socket: GameSocket, identity: GameSessionIdentity, initialView?: GameClientView): GameSession {
    if (this.sessions.size >= this.maxSessions) {
      this.counters.rejectedPackets += 1;
      socket.close(1013, "game shard full");
      throw new Error("game shard full");
    }
    if (this.rustAuthorityMode === "live" && this.rustAuthorityRestoreError) {
      this.counters.rejectedPackets += 1;
      socket.close(1011, "rust authority restore failed");
      throw new Error("rust authority restore failed");
    }
    const rustAuthorityRestorePending = this.rustAuthorityMode === "live" && (
      this.restoredCheckpoint?.reason === "rust_restore_pending"
      || Boolean(this.rustAuthorityRestorePromise && this.restoredCheckpoint?.loaded !== true)
    );
    if (rustAuthorityRestorePending) {
      this.counters.rejectedPackets += 1;
      socket.close(1013, "rust authority restore pending");
      throw new Error("rust authority restore pending");
    }

    const actorId = this.actorIdForIdentity(identity);
    if (!identity.characterId && this.characterPersistence?.hasCharacter?.(actorId) === true) {
      this.counters.rejectedPackets += 1;
      socket.close(1008, "durable character identity required");
      throw new Error("durable character identity required");
    }
    if (identity.characterId && identity.characterId !== actorId) {
      this.counters.rejectedPackets += 1;
      socket.close(1008, "character identity does not match actor id");
      throw new Error("character identity does not match actor id");
    }
    if ((
      this.isReservedCharacterId(actorId)
      || (identity.characterId ? this.isReservedCharacterId(identity.characterId) : false)
    ) && !(this.allowReservedActorSessionsForTests && !identity.characterId)) {
      this.counters.rejectedPackets += 1;
      socket.close(1008, "character id collides with authored actor");
      throw new Error("character id collides with authored actor");
    }
    const existingActor = this.actors.get(actorId);
    const durableAuthorityStateExists = Boolean(identity.characterId && this.durableAuthorityStateExistsForJoin(
      identity.characterId,
      actorId,
      existingActor,
    ));
    if (existingActor && !this.allowReservedActorSessionsForTests) {
      const boundCharacterIds = new Set([
        this.characterIdsByActorId.get(actorId),
        existingActor.characterId,
      ].filter((value): value is string => Boolean(value)));
      const reverseBoundActorId = identity.characterId
        ? this.characterActorIds.get(identity.characterId)
        : undefined;
      const existingActorMatchesCharacter = Boolean(
        identity.characterId
        && boundCharacterIds.size === 1
        && boundCharacterIds.has(identity.characterId)
        && (reverseBoundActorId === undefined || reverseBoundActorId === actorId),
      );
      if (!existingActorMatchesCharacter) {
        this.counters.rejectedPackets += 1;
        socket.close(1008, "actor identity collision");
        throw new Error("actor identity collision");
      }
    }
    const actorWasCreated = !existingActor;
    // The authored `player` remains fixture content. A CharacterStore-backed
    // roster character must never newly adopt it: doing so on reconnect leaks
    // the fixture's position, professions, inventory, and home cell into the
    // real character. Keep the alias path only for an owner already recorded
    // by a legacy checkpoint, plus raw fixture identities used by harnesses.
    const durableRosterCharacter = Boolean(
      identity.characterId
      && this.characterPersistence?.hasCharacter?.(identity.characterId) === true
    );
    const ownedAuthoredPlaceholderId = identity.characterId
      ? this.authoredPlaceholderIdOwnedByCharacter(identity.characterId)
      : null;
    const allowAuthoredPlaceholderClaim = !durableRosterCharacter || Boolean(ownedAuthoredPlaceholderId);
    const authoredPlaceholder = allowAuthoredPlaceholderClaim
      ? this.claimableAuthoredPlayerPlaceholder(actorId, identity.characterId)
      : null;
    const candidateRustActorId = this.rustActorIdFor(
      existingActor?.id ?? authoredPlaceholder?.id ?? actorId,
    );
    const claimedRustRegistrationMatchesCharacter = Boolean(
      identity.characterId
      && this.claimedAuthoredPlaceholders.get(actorId) === candidateRustActorId
      && this.authoredPlaceholderOwners.get(candidateRustActorId) === identity.characterId
    );
    const restoredRegistrationMatchesCharacter = candidateRustActorId === actorId
      || claimedRustRegistrationMatchesCharacter
      || Boolean(
        authoredPlaceholder
        && identity.appearance
        && authoredPlaceholder.displayName === identity.displayName
        && sameActorAppearance(authoredPlaceholder.appearance, identity.appearance),
      );
    const reattachingLinkDead = Boolean(identity.characterId && (
      existingActor?.linkDead
      || (
        !existingActor
        && restoredRegistrationMatchesCharacter
        && this.rustAuthorityRegisteredActorIds.has(candidateRustActorId)
        && this.rustAuthorityLinkDeadActorIds.has(candidateRustActorId)
      )
    ));
    const registeredRustActorForJoin = restoredRegistrationMatchesCharacter
      && this.rustAuthorityRegisteredActorIds.has(candidateRustActorId);
    const replacingLiveSession = this.sessionActorExists(actorId);
    if (replacingLiveSession) this.closeSessionsForActor(actorId);
    // Explicit fresh durable first entry (returningCharacter === false) with no
    // live/link-dead/restored actor: pick clone-facility shelter before ensureActor
    // so ticket-auth and dev-roster share one selector and the first checkpoint
    // already holds a safe cell. Absent flag, live actors, and returning positions win.
    this.applyFirstEntryShelteredSpawn(identity, {
      durableAuthorityStateExists,
      existingActor,
      reattachingLinkDead,
      replacingLiveSession,
    });
    // CharacterStore snapshots are a first-entry seed, not gameplay or
    // equipment authority. Returning actors keep the state restored by Rust;
    // if Rust lost the actor, the durable profile seeds its replacement.
    const applyCharacterSeed = identity.returningCharacter !== true
      || (this.rustAuthorityMode === "live" && !registeredRustActorForJoin);
    const actor = this.ensureActor(identity, {
      applySpawn: !replacingLiveSession && !reattachingLinkDead,
      applyGameplaySeed: applyCharacterSeed,
      allowAuthoredPlaceholderClaim,
    });
    if (identity.characterId) {
      const ownedPlaceholderId = this.authoredPlaceholderIdOwnedByCharacter(actor.id);
      if (ownedPlaceholderId && this.claimedAuthoredPlaceholders.get(actor.id) !== ownedPlaceholderId) {
        this.claimedAuthoredPlaceholders.set(actor.id, ownedPlaceholderId);
        this.remapProjectedRustOwnership(ownedPlaceholderId, actor.id);
      }
      this.bindCharacterActor(identity.characterId, actor, identity, reattachingLinkDead, applyCharacterSeed);
      this.realCharacterActorIds.add(actor.id);
      if (identity.returningCharacter || durableAuthorityStateExists) {
        this.returningCharacterActorIds.add(actor.id);
      } else {
        this.returningCharacterActorIds.delete(actor.id);
      }
    } else {
      this.realCharacterActorIds.delete(actor.id);
      this.returningCharacterActorIds.delete(actor.id);
    }
    if (actorWasCreated && !reattachingLinkDead) this.invalidateRustAuthorityActorRegistration(actor);
    const connectedAtMs = Date.now();
    const session: GameSession = {
      id: `g_${this.nextSessionSeq++}`,
      actorId: actor.id,
      socket,
      failClose: () => {},
      slowConsumerClosing: false,
      connectedAt: new Date(connectedAtMs).toISOString(),
      connectedAtMs,
      characterId: identity.characterId,
      seenCommands: new Set<number>(),
      ingressBudgets: new Map<string, IngressBudgetBucket>(),
      lastSnapshotTick: -1,
      lastActorDeltaTick: -1,
      pendingDialogueDeliveries: [],
      pendingReceipts: [],
      pendingEvents: [],
      pendingAbilityQueueEvents: [],
      lastCombatEventDeltaTick: -1,
      deferredDirtyActorIds: new Set<string>(),
      deferredDirtyActorFirstSeenTicks: new Map<string, number>(),
      knownActorIds: new Set<string>(),
      knownActorSnapshots: new Map<string, GameActorSnapshot>(),
      knownInventoryRows: new Map<string, RustAuthorityInventorySnapshot>(),
      knownReservationRows: new Map<string, RustAuthorityReservationSnapshot>(),
      needsFullSnapshot: false,
      viewInterest: normalizeClientViewInterest(initialView, this.tick),
      interestDirty: Boolean(initialView),
      launchProvenance: identity.launchProvenance,
    };
    session.failClose = () => this.failCloseSlowConsumer(session);
    if (identity.launchProvenance && this.sessionRevocations) {
      session.unregisterRevocation = this.sessionRevocations.register(identity.launchProvenance, () => session.socket.close(4001, "launch revoked"));
    }

    this.sessions.set(session.id, session);
    this.sessionJoinCount += 1;
    const reentryState = reattachingLinkDead
      ? this.clearRustActorLinkDeadForReentry(actor)
      : null;
    // A restored, already-registered actor produces no ordinary upsert. Refresh
    // its link-dead projection before hello while preserving Rust gameplay,
    // clothing, and current-schema appearance authority.
    const returningAuthorityRefresh = !reentryState
      && identity.returningCharacter === true
      && registeredRustActorForJoin
      ? this.clearRustActorLinkDeadForReentry(actor)
      : null;
    const authorityStateReady = reentryState ?? returningAuthorityRefresh;
    const shouldSeedDeployLoadout = !identity.characterId && !replacingLiveSession && !reattachingLinkDead;
    const firstEntryRustReconciliation = Boolean(
      identity.characterId
      && identity.returningCharacter !== true
      && authoredPlaceholder
      && restoredRegistrationMatchesCharacter
      && registeredRustActorForJoin,
    );
    const registration = authorityStateReady
      ? null
      : firstEntryRustReconciliation
        ? this.forceRustAuthorityActorUpsert(actor, candidateRustActorId)
        : this.registerRustAuthorityActor(actor);
    const deployLoadout = shouldSeedDeployLoadout
      ? registration
        ? registration.then(() => this.ensureRustDeployLoadoutIfMissing(actor))
        : this.ensureRustDeployLoadoutIfMissing(actor)
      : registration;
    this.markDetailDirty(actor.id);
    this.deferNewActorForInterestedSessions(actor.id, session.id);
    this.appendLifecycleJournal({
      type: "session.connect",
      at: new Date().toISOString(),
      tick: this.tick,
      sessionId: session.id,
      actorId: actor.id,
      playerId: identity.playerId,
      zoneId: identity.zoneId,
    });
    socket.on("message", (data) => {
      void this.handleRawMessage(session.id, data).catch((error: unknown) => {
        this.logger?.warn({ error, sessionId: session.id }, "game message handler failed");
        this.sendError(session, "internal_error", "game command failed");
      });
    });
    socket.on("close", () => this.disconnectSession(session.id));
    socket.on("error", (error) => this.logger?.warn({ error, sessionId: session.id }, "game socket error"));
    const sendHello = (): void => {
      if (!this.sessions.has(session.id) || session.socket.readyState !== 1) return;
      const snapshot = this.snapshotForSession(session);
      this.replaceKnownActorSnapshots(session, snapshot.actors);
      this.send(session, {
        type: "game.hello",
        sessionId: session.id,
        playerActorId: actor.id,
        snapshot,
        serverTime: new Date().toISOString(),
      });
      session.lastSnapshotTick = this.tick;
      session.lastActorDeltaTick = this.tick;
      this.deliverActiveTradeSessionToSession(session);
    };
    const authorityReady = authorityStateReady && deployLoadout
      ? Promise.all([authorityStateReady, deployLoadout]).then(() => undefined)
      : authorityStateReady ?? deployLoadout;
    const ready = this.finalizeFirstWorldEntry(identity, actor, authorityReady);
    if (ready) {
      void ready.then(sendHello).catch(() => {
        this.logger?.warn({ reason: "durable_character_entry_failed" }, "durable character entry failed before hello");
        socket.close(1011, "durable character entry failed");
      });
    } else {
      sendHello();
    }
    return session;
  }

  private finalizeFirstWorldEntry(
    identity: GameSessionIdentity,
    actor: AuthorityActor,
    authorityReady: Promise<unknown> | null,
  ): Promise<void> | null {
    const characterId = identity.characterId;
    const claimWorldEntry = this.characterPersistence?.claimWorldEntry;
    const needsLocalFirstEntry = Boolean(characterId && identity.returningCharacter !== true && claimWorldEntry);
    const pendingHostedCommit = identity.pendingFirstEntryCommit;
    if (pendingHostedCommit && !characterId) return Promise.reject(new Error("hosted first-entry commit requires a character identity"));
    if (!needsLocalFirstEntry && !pendingHostedCommit) {
      return authorityReady ? authorityReady.then(() => undefined) : null;
    }
    return Promise.resolve(authorityReady).then(async () => {
      if (needsLocalFirstEntry) {
        // Publish the Rust actor, starter inventory, and placeholder ownership in
        // a forced checkpoint before flipping the CharacterStore marker. A crash
        // at any earlier point therefore retries the safe first-entry path.
        await this.checkpoint("character-first-entry");
        const claimed = claimWorldEntry!(characterId!, identity.ownerRef);
        if (!claimed) throw new Error("failed to durably claim first world entry");
        this.returningCharacterActorIds.add(actor.id);
        identity.returningCharacter = true;
      }
      if (characterId && pendingHostedCommit) {
        await commitHostedFirstEntry(characterId, pendingHostedCommit);
        identity.pendingFirstEntryCommit = undefined;
      }
    });
  }

  status(): GameShardStatus {
    return {
      shardId: this.shardId,
      tick: this.tick,
      clock: { mode: this.clock.mode },
      worldClock: this.clockSnapshot(false),
      weather: this.weatherStatusSnapshot(),
      sessionCount: this.sessions.size,
      actorCount: this.actors.size,
      counters: { ...this.counters },
      instrumentation: this.loadInstrumentation(),
      recentRejections: this.recentRejectionsForStatus(),
      authority: {
        mode: this.rustAuthorityMode ?? "in-process-test",
        rustLive: this.rustAuthorityMode === "live",
        inProcessAuthorityForTests: this.rustAuthorityMode !== "live",
        metrics: this.lastRustAuthorityMetrics,
        exchangeMetrics: this.lastRustAuthorityExchangeMetrics,
        tickTiming: this.lastRustAuthorityTickTiming,
        bridge: this.rustAuthorityBridge?.debugStatus() ?? null,
        cadence: this.authorityCadenceStatus(),
      },
      source: {
        stateHash: this.sourceStateHash,
        sliceHash: this.sliceHash,
        actorCount: this.sourceActorCount,
        areas: [...this.areas.values()].map((area) => ({
          id: area.id,
          width: area.width,
          height: area.height,
          ...(area.biome ? { biome: area.biome } : {}),
          actorCount: this.actorCountForArea(area.id),
          resourceSpawns: this.resourceSpawnsForArea(area.id),
        })),
      },
      limits: {
        maxSessions: this.maxSessions,
        maxPacketBytes: this.maxPacketBytes,
        areaInterestRadiusCells: this.areaInterestRadiusCells,
        slowConsumerBufferCapBytes: this.slowConsumerBufferCapBytes,
      },
      persistence: this.persistenceStatus(),
      durabilityManifest: this.durabilityManifest,
      readiness: this.readinessStatus(),
    };
  }

  async metrics(): Promise<{
    schema: "successor.metrics.v1";
    tick: number;
    authority: GameShardStatus["authority"]["metrics"] | null;
    exchange: RustAuthorityExchangeMetricsSnapshot | null;
  }> {
    if (this.rustAuthorityMode === "live" && this.rustAuthorityBridge) {
      try {
        await this.awaitRustAuthorityReady();
        const output = await this.rustAuthorityBridge.submitExchangeMetrics({ timeoutMs: 2_500 });
        this.syncTickFromRust(output.tick);
        this.syncRustExchangeMetrics(output.exchangeMetrics);
      } catch (error) {
        this.logger?.warn({ error }, "rust authority exchange metrics query failed");
      }
    }
    const status = this.status();
    return {
      schema: "successor.metrics.v1",
      tick: status.tick,
      authority: status.authority.metrics ?? null,
      exchange: status.authority.exchangeMetrics ?? null,
    };
  }

  characterLiveState(characterId: string): GameCharacterLiveState {
    const actorId = this.characterActorIds.get(characterId) ?? characterId;
    const actor = this.actors.get(actorId);
    const hasSession = [...this.sessions.values()].some((session) => session.characterId === characterId || session.actorId === actorId);
    if (hasSession && actor?.linkDead !== true) return "online";
    if (actor?.linkDead) return "linkdead";
    return "offline";
  }

  characterJoinSpawnForActor(characterId: string, fallback?: GameShardCharacterSpawn | null): GameShardCharacterSpawn {
    const actorId = this.characterActorIds.get(characterId) ?? characterId;
    const actor = this.actors.get(actorId);
    if (actor) return { areaId: actor.areaId, x: round(actor.x), y: round(actor.y), facing: actor.direction };
    return fallback ? { ...fallback } : this.defaultJoinSpawnForActor(characterId);
  }

  defaultJoinSpawnForActor(_actorId: string): GameShardCharacterSpawn {
    if (this.defaultCharacterSpawn) return { ...this.defaultCharacterSpawn };
    const areaId = this.defaultSpawnAreaId();
    const area = this.areas.get(areaId);
    const cell = this.clampedUnblockedCell(areaId, (area?.width ?? 64) / 2, (area?.height ?? 36) / 2);
    return { areaId, x: cell.x, y: cell.y, facing: "front" };
  }

  private bindCharacterActor(
    characterId: string,
    actor: AuthorityActor,
    identity: GameSessionIdentity,
    wasLinkDeadOverride = false,
    applyIdentitySeed = true,
  ): void {
    const wasLinkDead = actor.linkDead || wasLinkDeadOverride;
    actor.characterId = characterId;
    actor.displayName = normalizeDisplayName(identity.displayName, actor.displayName || actor.label);
    actor.label = actor.displayName;
    if (applyIdentitySeed) {
      actor.appearance = identity.appearance ? cloneActorAppearance(identity.appearance) : actor.appearance;
      if (identity.wornColors) actor.wornColors = cloneWornColors(identity.wornColors);
      actor.worn = identity.worn ? cloneActorWorn(identity.worn) : actor.worn;
    }
    actor.linkDead = false;
    if (wasLinkDead) this.pendingLinkDeadRebroadcastActorIds.add(actor.id);
    this.characterIdsByActorId.set(actor.id, characterId);
    this.characterActorIds.set(characterId, actor.id);
    this.lastCharacterCheckpointMs.delete(characterId);
    try {
      this.characterPersistence?.markSeen?.(characterId, Date.now());
    } catch (error) {
      // lastSeenAt is roster metadata, not authority state. A metadata write
      // failure must not strand a partially bound character before its
      // first-entry checkpoint and starter inventory are committed.
      this.logger?.warn({ error, characterId, actorId: actor.id }, "failed to persist character last-seen metadata");
    }
    if (wasLinkDead) {
      this.markDirty(actor.id);
      this.markDetailDirty(actor.id);
    }
  }

  private beginCharacterLinkDead(characterId: string, session: GameSession): void {
    const actor = this.actors.get(session.actorId);
    if (!actor) return;
    actor.characterId = characterId;
    actor.linkDead = true;
    this.characterIdsByActorId.set(actor.id, characterId);
    this.characterActorIds.set(characterId, actor.id);
    const nowMs = Date.now();
    this.saveCharacterSnapshot(characterId, actor, {
      reason: "disconnect",
      atMs: nowMs,
      logout: true,
      playMs: Math.max(0, nowMs - session.connectedAtMs),
    });
    this.markDirty(actor.id);
    this.markDetailDirty(actor.id);
    this.setRustActorLinkDead(actor.id, true);
  }

  private saveCharacterSnapshot(
    characterId: string,
    actor: AuthorityActor,
    options: Parameters<GameCharacterPersistenceOptions["saveSnapshot"]>[2],
  ): void {
    if (!this.characterPersistence) return;
    try {
      this.characterPersistence.saveSnapshot(characterId, actorSnapshot(actor), options);
    } catch (error) {
      this.persistenceWriteFailure = error instanceof Error ? error.message : String(error);
      this.logger?.warn({ error, characterId, actorId: actor.id, reason: options.reason }, "failed to persist character snapshot");
      if (this.persistence.checkpointPath || this.persistence.journalPath) throw error;
    }
  }

  private checkpointCharacterActorIfDue(actorId: string, nowMs = Date.now()): void {
    const characterId = this.characterIdsByActorId.get(actorId);
    if (!characterId || !this.characterPersistence) return;
    const lastCheckpointMs = this.lastCharacterCheckpointMs.get(characterId) ?? 0;
    if (nowMs - lastCheckpointMs < this.characterCheckpointIntervalMs) return;
    const actor = this.actors.get(actorId);
    if (!actor || actor.linkDead) return;
    this.lastCharacterCheckpointMs.set(characterId, nowMs);
    this.saveCharacterSnapshot(characterId, actor, { reason: "checkpoint", atMs: nowMs });
  }

  private async persistAcceptedWorldTransition(actorId: string, command: ClientCommand): Promise<void> {
    if (!("EnterTransition" in command) && !("UseTravelTicket" in command)) return;

    // World changes are rare and materially important. Close the ordinary
    // interval-checkpoint crash window before acknowledging the command.
    if (this.persistence.checkpointPath) {
      await this.checkpoint("world-transition");
    }

    const characterId = this.characterIdsByActorId.get(actorId);
    const actor = this.actors.get(actorId);
    if (!characterId || !actor || actor.linkDead || !this.characterPersistence) return;
    const nowMs = Date.now();
    this.saveCharacterSnapshot(characterId, actor, { reason: "checkpoint", atMs: nowMs });
    this.lastCharacterCheckpointMs.set(characterId, nowMs);
  }

  private setRustActorLinkDead(actorId: string, linkDead: boolean): void {
    const rustActorId = this.rustActorIdFor(actorId);
    this.rustAuthorityDesiredLinkDead.set(rustActorId, linkDead);
    if (!this.rustAuthorityBridge || !this.rustAuthorityRegisteredActorIds.has(rustActorId)) return;
    void this.enqueueRustActorLinkDead(rustActorId, actorId).catch((error) => {
      this.logger?.warn({ error, actorId: rustActorId }, "rust authority link-dead update failed");
    });
  }

  private async applyRustActorLinkDead(
    rustActorId: string,
    actorId: string,
    linkDead: boolean,
  ): Promise<void> {
    const bridge = this.rustAuthorityBridge;
    if (!bridge) return;
    const bridgeGeneration = this.rustAuthorityBridgeGeneration;
    const output = await bridge.setActorLinkDead({ actorId: rustActorId, linkDead });
    if (
      bridgeGeneration !== this.rustAuthorityBridgeGeneration
      || bridge !== this.rustAuthorityBridge
      || !this.rustAuthorityRegisteredActorIds.has(rustActorId)
      || this.rustAuthorityDesiredLinkDead.get(rustActorId) !== linkDead
    ) return;
    this.syncTickFromRust(output.tick);
    this.recordRustAuthorityStateHash(output.targetStateHash);
    this.syncRustMetrics(output.metrics);
    this.syncRustInventory(output.inventory, output.reservations, output.timelineEvents);
    this.syncRustResourceSpawns(output);
    this.syncRustPlacedExtractors(output);
    this.syncRustPlacedCamps(output);
    this.syncRustPlacedParcels(output);
    this.syncRustBuilding(output);
    this.syncRustFarmPlots(output);
    this.syncRustDraftedSchematics(output);
    this.syncRustGroupViews(output);
    this.syncRustDuelViews(output);
    if (output.actor) {
      this.applyRustActorSnapshot(
        this.typescriptActorIdForRustActorId(output.actor.id, actorId, rustActorId),
        output.actor,
      );
    }
  }

  private recordCommandRejection(actorId: string, command: ClientCommand, reasonCode: string | undefined, tick = this.tick): void {
    const safeTick = Number.isFinite(tick) ? Math.trunc(tick) : this.tick;
    const entry: GameShardRecentRejection = {
      tick: safeTick,
      actorId,
      kind: commandKind(command),
      reasonCode: reasonCode || reasonForRejectedNoEventCommand(command),
    };
    if (this.recentRejections.length < recentRejectionCapacity) {
      this.recentRejections.push(entry);
      this.recentRejectionWriteIndex = this.recentRejections.length % recentRejectionCapacity;
      return;
    }
    this.recentRejections[this.recentRejectionWriteIndex] = entry;
    this.recentRejectionWriteIndex = (this.recentRejectionWriteIndex + 1) % recentRejectionCapacity;
  }

  private recentRejectionsForStatus(): GameShardRecentRejection[] {
    const count = this.recentRejections.length;
    if (count === 0) return [];
    const out: GameShardRecentRejection[] = [];
    const start = count >= recentRejectionCapacity ? this.recentRejectionWriteIndex : 0;
    for (let i = 0; i < count; i += 1) {
      const entry = this.recentRejections[(start + i) % recentRejectionCapacity]!;
      out.push({
        tick: entry.tick,
        actorId: entry.actorId,
        kind: entry.kind,
        reasonCode: entry.reasonCode,
      });
    }
    return out;
  }
  private async applyDesiredRustActorLinkDead(actor: AuthorityActor, rustActorId: string): Promise<void> {
    if (!this.rustAuthorityBridge) return;
    await this.enqueueRustActorLinkDead(rustActorId, actor.id);
  }
  private enqueueRustActorLinkDead(rustActorId: string, actorId: string): Promise<void> {
    const existing = this.rustAuthorityLinkDeadEffects.get(rustActorId);
    if (existing) return existing;
    if (!this.rustAuthorityRegisteredActorIds.has(rustActorId)) return Promise.resolve();
    let applied: boolean | undefined;
    const effect = (async () => {
      for (;;) {
        const desired = this.rustAuthorityDesiredLinkDead.get(rustActorId);
        if (
          desired === undefined
          || !this.rustAuthorityRegisteredActorIds.has(rustActorId)
          || desired === applied
        ) return;
        await this.applyRustActorLinkDead(rustActorId, actorId, desired);
        applied = desired;
      }
    })().finally(() => {
      if (this.rustAuthorityLinkDeadEffects.get(rustActorId) === effect) {
        this.rustAuthorityLinkDeadEffects.delete(rustActorId);
      }
    });
    this.rustAuthorityLinkDeadEffects.set(rustActorId, effect);
    return effect;
  }
  private recordDeferredDirtyActorHighWater(): void {
    let deferredDirtyActors = 0;
    for (const session of this.sessions.values()) {
      deferredDirtyActors += session.deferredDirtyActorIds.size;
    }
    this.deferredDirtyActorHighWater = Math.max(this.deferredDirtyActorHighWater, deferredDirtyActors);
  }

  private loadInstrumentation(): GameShardStatus["instrumentation"] {
    let pendingReceipts = 0;
    let pendingEvents = 0;
    let pendingAbilityQueueEvents = 0;
    let deferredDirtyActors = 0;
    let deferredDirtyActorOldestAgeTicks = 0;
    for (const session of this.sessions.values()) {
      pendingReceipts += session.pendingReceipts.length;
      pendingEvents += session.pendingEvents.length;
      pendingAbilityQueueEvents += session.pendingAbilityQueueEvents.length;
      deferredDirtyActors += session.deferredDirtyActorIds.size;
      for (const actorId of session.deferredDirtyActorIds) {
        const firstSeenTick = session.deferredDirtyActorFirstSeenTicks.get(actorId) ?? this.tick;
        deferredDirtyActorOldestAgeTicks = Math.max(deferredDirtyActorOldestAgeTicks, this.tick - firstSeenTick);
      }
    }
    this.deferredDirtyActorHighWater = Math.max(this.deferredDirtyActorHighWater, deferredDirtyActors);
    const queueDepth = pendingReceipts + pendingEvents + pendingAbilityQueueEvents + deferredDirtyActors;
    const bridge = this.rustAuthorityBridge?.debugStatus();
    const milliseconds = (nanoseconds: number): number => (
      Number.isFinite(nanoseconds) ? Math.round((nanoseconds / 1_000_000) * 1000) / 1000 : 0
    );
    return {
      sessions: {
        active: this.sessions.size,
        joined: this.sessionJoinCount,
        disconnected: this.sessionDisconnectCount,
      },
      commands: {
        accepted: this.counters.acceptedCommands,
        rejected: this.counters.rejectedCommands,
        receipts: this.counters.acceptedCommands + this.counters.rejectedCommands,
      },
      delivery: {
        queueDepth,
        pendingReceipts,
        pendingEvents,
        pendingAbilityQueueEvents,
        deferredDirtyActors,
        deferredDirtyActorHighWater: this.deferredDirtyActorHighWater,
        deferredDirtyActorOldestAgeTicks,
        backpressure: this.backpressureInstrumentation(),
      },
      bridge: {
        diagnosticPending: bridge?.diagnosticPending ?? 0,
        livePending: bridge?.livePending ?? 0,
        cadencePending: bridge?.cadencePending ?? 0,
        workloadLivePending: bridge?.workloadLivePending ?? 0,
        commandBatchPending: bridge?.commandBatchPending ?? 0,
        commandBatchPendingItems: bridge?.commandBatchPendingItems ?? 0,
        backlogSize: bridge?.backlogSize ?? 0,
        workloadBacklogSize: bridge?.workloadBacklogSize ?? 0,
      },
      eventLoopLag: {
        p50Ms: milliseconds(this.eventLoopLag.percentile(50)),
        p95Ms: milliseconds(this.eventLoopLag.percentile(95)),
        maxMs: milliseconds(this.eventLoopLag.max),
        meanMs: milliseconds(this.eventLoopLag.mean),
      },
    };
  }

  private backpressureInstrumentation(): GameShardStatus["instrumentation"]["delivery"]["backpressure"] {
    let currentBufferedBytes = 0;
    for (const session of this.sessions.values()) {
      const bufferedAmount = this.observeBufferedAmount(session.socket);
      currentBufferedBytes = currentBufferedBytes > Number.MAX_SAFE_INTEGER - bufferedAmount
        ? Number.MAX_SAFE_INTEGER
        : currentBufferedBytes + bufferedAmount;
    }
    this.maxTransportBufferedBytes = Math.max(this.maxTransportBufferedBytes, currentBufferedBytes);
    return {
      queuedBytes: currentBufferedBytes,
      maxQueuedBytes: this.maxTransportBufferedBytes,
      currentBufferedBytes,
      maxBufferedBytes: this.maxTransportBufferedBytes,
      capBytes: this.slowConsumerBufferCapBytes,
      slowConsumerCount: this.slowConsumerDisconnectCount,
      slowConsumerDisconnects: this.slowConsumerDisconnectCount,
    };
  }


  private authorityCadenceStatus(): AuthorityCadenceStatus {
    return {
      clockSource: this.rustAuthorityMode === "live" ? "rust-fixed-interval" : "snapshot-flush",
      targetTickMs: Math.round((1000 / Math.max(1, this.tickRateHz)) * 10) / 10,
      authorityIntervalMs: this.authorityIntervalMs,
      snapshotIntervalMs: this.snapshotIntervalMs,
      flushes: this.authorityFlushCount,
      skippedInFlight: this.authoritySkippedInFlightCount,
      zeroTickFlushes: this.authorityZeroTickFlushCount,
      lastTickCount: this.lastAuthorityTickCount,
      maxTickCount: this.maxAuthorityTickCount,
      tickStep: this.authorityTickStepTiming.summary(),
      flushDurationMs: this.authorityFlushDurationTiming.summary(),
      snapshotBuildMs: this.snapshotBuildTiming.summary(),
    };
  }

  async debugOracle(options: { refreshAiDebug?: boolean; awaitAiDebug?: boolean } = {}): Promise<GameShardDebugOracle> {
    if (options.refreshAiDebug !== false) {
      if (options.awaitAiDebug === true) await this.refreshRustAiDebugForOracle({ force: true });
      else this.scheduleRustAiDebugRefreshForOracle();
    }
    const status = this.status();
    return {
      schema: "successor.game-shard-oracle.v1",
      shardId: this.shardId,
      tick: this.tick,
      worldClock: this.clockSnapshot(false),
      weather: this.weatherStatusSnapshot(),
      authority: status.authority,
      source: status.source,
      counters: { ...this.counters },
      actors: Object.fromEntries([...this.actors.values()].map((actor) => [actor.id, {
        ...actorSnapshot(actor),
        authored: this.authoredActorIds.has(actor.id),
        transientSession: this.transientSessionActorIds.has(actor.id),
        netId: this.actorNetIds.get(actor.id) ?? null,
      }])),
      inventory: this.inventory.filter((row) => !row.container.startsWith("bank:")).map((row) => ({ ...row })),
      reservations: this.reservations.map((row) => ({ ...row })),
      // Deployable rows go through the SESSION redaction with no observer:
      // the oracle is unauthenticated (CORS *), so it gets the stranger shape.
      placedExtractors: this.lastRustAuthorityPlacedExtractors.map((row) => this.projectPlacedExtractor(row, null)),
      placedCamps: this.lastRustAuthorityPlacedCamps.map((row) => this.projectPlacedCamp(row, null)),
      placedParcels: this.lastRustAuthorityPlacedParcels.map((row) => this.projectParcel(row, null)),
      farmPlots: this.lastRustAuthorityFarmPlots.map((row) => this.projectFarmPlot(row, null)),
      building: this.lastRustAuthorityBuilding,
      // Oracle is unauthenticated (stranger shape): never leak owner drafts.
      draftedSchematics: [],
      groupViews: this.groupViewsSnapshot(),
      propStates: this.propStatesSnapshot(),
      timelineEvents: this.timelineEvents.map((row) => ({ ...row })),
      resourceSpawns: this.resourceSpawns.map((spawn) => copyResourceSpawn(spawn)),
      sessions: [...this.sessions.values()].map((session) => ({
        id: session.id,
        actorId: session.actorId,
        pendingReceiptCount: session.pendingReceipts.length,
        pendingEventCount: session.pendingEvents.length,
        needsFullSnapshot: session.needsFullSnapshot,
        interestDirty: session.interestDirty,
        knownActorCount: session.knownActorIds.size,
        deferredDirtyActorCount: session.deferredDirtyActorIds.size,
        lastSnapshotTick: session.lastSnapshotTick,
        lastActorDeltaTick: session.lastActorDeltaTick,
        viewInterest: session.viewInterest,
      })),
      aiDebug: this.lastRustAuthorityAiDebug,
    };
  }

  async resetDebugFixture(): Promise<{
    schema: string;
    accepted: boolean;
    tick: number;
    actorIds: string[];
    inventory: RustAuthorityInventorySnapshot[];
  }> {
    const actorIds = [...this.initialAuthoredActors.keys()];
    this.inventory = this.initialInventory.map((row) => ({ ...row }));
    this.travelTicketRows.clear();
    this.travelTicketStackCounters.clear();
    this.propStates.clear();
    for (const [id, state] of this.initialPropStates) this.propStates.set(id, { ...state });
    this.reservations = [];
    this.timelineEvents = [];
    this.recentRejections.length = 0;
    this.recentRejectionWriteIndex = 0;
    this.clearRustProjectedWorldState();
    this.characterIdsByActorId.clear();
    this.characterActorIds.clear();
    this.claimedAuthoredPlaceholders.clear();
    this.authoredPlaceholderOwners.clear();
    this.lastCharacterCheckpointMs.clear();
    this.nextCombatEventId = 1;
    for (const key of Object.keys(this.counters) as Array<keyof GameShardCounters>) {
      this.counters[key] = 0;
    }
    for (const session of this.sessions.values()) session.ingressBudgets.clear();

    for (const [actorId, initial] of this.initialAuthoredActors) {
      const previousLifecycleSeq = this.actors.get(actorId)?.lifecycleSeq ?? initial.lifecycleSeq ?? 1;
      const actor = restorePersistedActor(initial);
      actor.lifecycleSeq = Math.max(positiveIntegerOr(previousLifecycleSeq, 1) + 1, positiveIntegerOr(actor.lifecycleSeq, 1));
      this.actors.set(actorId, actor);
      this.actorNetId(actorId);
    }

    if (this.rustAuthorityMode === "live" && this.rustAuthorityBridgeOptions) {
      this.rustAuthorityBridge?.close();
      this.rustAuthorityBridge = new RustAuthorityBridge(this.rustAuthorityBridgeOptions);
      this.rustAuthorityBridgeGeneration += 1;
      this.rustAuthorityRegisteredActorIds.clear();
      this.rustAuthorityLinkDeadActorIds.clear();
      this.rustAuthorityDesiredLinkDead.clear();
      this.rustAuthorityLinkDeadEffects.clear();
      this.rustAuthorityActorUpserts.clear();
      this.lastRustAuthorityMetrics = undefined;
      this.lastRustAuthorityExchangeMetrics = undefined;
      this.lastRustAuthorityAiDebug = undefined;
      this.lastRustAuthorityGroupViewsByActorId.clear();
      this.lastRustAuthorityGuildViewsByActorId.clear();
      this.lastRustAuthorityDuelViewsByActorId.clear();
      this.clearRustProjectedWorldState();
      await Promise.all(actorIds.map((actorId) => {
        const actor = this.actors.get(actorId);
        return actor ? this.queueRustAuthorityActorUpsert(actor, actor.id) : Promise.resolve();
      }));
    }

    this.invalidateActorSpatialIndex();
    this.markDetailDirty(...actorIds);
    this.persistenceDirty = true;
    return {
      schema: "successor.debug-reset-fixture.v1",
      accepted: true,
      tick: this.tick,
      actorIds,
      inventory: this.inventory.map((row) => ({ ...row })),
    };
  }

  snapshotFor(actorId: string): GameShardSnapshot {
    return this.createSnapshot(actorId, { compact: false });
  }

  private snapshotForSession(session: GameSession): GameShardSnapshot {
    const snapshot = this.createSnapshot(session.actorId, { compact: false, session });
    this.replaceKnownInventoryRows(session, snapshot.inventory ?? []);
    this.replaceKnownReservationRows(session, snapshot.reservations ?? []);
    return snapshot;
  }

  private clockSnapshot(includeConfig: boolean): WorldClockSnapshot {
    return worldClockSnapshot(this.worldClockConfig, this.tick, includeConfig);
  }

  private weatherSnapshot(tick = this.tick): GameWeatherSnapshot[] {
    return weatherSnapshotsAtTick(this.weatherControllers.values(), tick);
  }

  private weatherStatusSnapshot(tick = this.tick): GameShardWeatherStatus[] {
    return this.weatherSnapshot(tick).map((snapshot) => {
      const counters = this.weatherActorCounters(snapshot);
      return { ...snapshot, ...counters };
    });
  }

  private weatherHazardsForTick(tick: number): RustAuthorityWeatherHazardInput[] {
    return this.weatherSnapshot(tick)
      .filter((snapshot) => snapshot.phase === "active")
      .map((snapshot) => {
        const controller = this.weatherControllers.get(snapshot.areaId);
        return controller ? {
          areaId: snapshot.areaId,
          centerXMilli: cellToMilli(snapshot.centerX),
          centerYMilli: cellToMilli(snapshot.centerY),
          radiusMilli: Math.max(0, Math.trunc(snapshot.radiusCells * milliCellsPerCell)),
          dpsMilliHealth: controller.dpsMilliHealth,
          shelters: (this.weatherSheltersByArea.get(snapshot.areaId) ?? []).map((shelter) => ({ ...shelter })),
        } : null;
      })
      .filter((hazard): hazard is RustAuthorityWeatherHazardInput => Boolean(hazard));
  }

  private weatherHazardsByTick(startTick: number, tickCount: number): RustAuthorityWeatherHazardInput[][] {
    return Array.from(
      { length: tickCount },
      (_unused, index) => this.weatherHazardsForTick(startTick + index + 1),
    );
  }

  private submitRustAuthorityTicks(
    tickCount: number,
    startTick: number,
    timeoutMs = Math.min(60_000, Math.max(5_000, tickCount * 10)),
  ): Promise<RustAuthorityBridgeTickOutput> {
    if (!this.rustAuthorityBridge) throw new Error("rust authority bridge disappeared while advancing ticks");
    return this.rustAuthorityBridge.submitTick({
      ticks: tickCount,
      timeoutMs,
      // Rust applies the singular hazard input to one tick. Multi-tick batches
      // must carry the exact per-tick schedule used by live advancement.
      weatherHazards: tickCount === 1 ? this.weatherHazardsForTick(startTick + 1) : [],
      ...(tickCount === 1 ? {} : {
        weatherHazardsByTick: this.weatherHazardsByTick(startTick, tickCount),
      }),
    });
  }

  private weatherActorCounters(snapshot: AreaWeatherSnapshot): Pick<GameShardWeatherStatus, "actorsInStorm" | "shelteredActors"> {
    const centerXMilli = cellToMilli(snapshot.centerX);
    const centerYMilli = cellToMilli(snapshot.centerY);
    const radiusMilli = Math.max(0, Math.trunc(snapshot.radiusCells * milliCellsPerCell));
    const shelters = this.weatherSheltersByArea.get(snapshot.areaId) ?? [];
    let actorsInStorm = 0;
    let shelteredActors = 0;
    for (const actor of this.actors.values()) {
      if (actor.areaId !== snapshot.areaId || actor.lifeState === "respawning") continue;
      const actorXMilli = cellToMilli(actor.x);
      const actorYMilli = cellToMilli(actor.y);
      if (!pointInRadiusMilli(actorXMilli, actorYMilli, centerXMilli, centerYMilli, radiusMilli)) continue;
      actorsInStorm += 1;
      if (shelters.some((shelter) => pointInShelterBox(actorXMilli, actorYMilli, shelter))) shelteredActors += 1;
    }
    return { actorsInStorm, shelteredActors };
  }

  private propStatesSnapshot(): Record<string, GamePropState> {
    return Object.fromEntries([...this.propStates.entries()].map(([id, state]) => [id, { ...state }]));
  }
  private restoreLocalCheckpointProjection(checkpoint: GameShardCheckpointProjection): void {
    this.restoreAuthoredPlaceholderOwners(checkpoint.authoredPlaceholderOwners);
    if (checkpoint.propStates && typeof checkpoint.propStates === "object" && !Array.isArray(checkpoint.propStates)) {
      for (const [propId, candidate] of Object.entries(checkpoint.propStates)) {
        if (!this.propStates.has(propId) || !candidate || typeof candidate !== "object") continue;
        const restored: GamePropState = {};
        if (typeof candidate.cacheEmptied === "boolean") restored.cacheEmptied = candidate.cacheEmptied;
        if (typeof candidate.doorOpen === "boolean") restored.doorOpen = candidate.doorOpen;
        if (Object.keys(restored).length > 0) this.propStates.set(propId, restored);
      }
    }
    if (Array.isArray(checkpoint.travelTickets)) {
      this.travelTicketRows.clear();
      for (const candidate of checkpoint.travelTickets) {
        if (!candidate || typeof candidate !== "object") continue;
        const row = normalizeInventoryRowForStream({
          ...candidate,
          metadata: cloneInventoryMetadata(candidate.metadata),
        });
        const ticket = this.travelTicketDataFromRow(row);
        if (!ticket || row.itemId !== travelTicketNumericItemId || row.itemKey !== travelTicketItemKey || row.available < 1) continue;
        this.travelTicketRows.set(ticket.ticketId, row);
      }
      this.mergeTravelTicketRowsIntoInventory();
    }
  }

  private restoreAuthoredPlaceholderOwners(value: unknown): void {
    this.validateCheckpointAuthoredPlaceholderOwners(value);
    if (value === undefined) return;
    for (const [rawPlaceholderId, rawCharacterId] of Object.entries(value as Record<string, string>)) {
      const placeholderId = normalizeId(rawPlaceholderId);
      const characterId = normalizeId(rawCharacterId);
      this.authoredPlaceholderOwners.set(placeholderId, characterId);
      // The authored actor remains an unclaimed pristine placeholder until
      // its owner joins. Keep the durable alias separate from actor state so
      // stale identity never leaks into placeholder snapshots.
    }
  }

  private validateCheckpointAuthoredPlaceholderOwners(value: unknown): void {
    if (value === undefined) return;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("checkpoint authored placeholder owners must be an object");
    }
    const owners = new Set<string>();
    for (const [rawPlaceholderId, rawCharacterId] of Object.entries(value)) {
      const placeholderId = normalizeId(rawPlaceholderId);
      if (placeholderId !== rawPlaceholderId) {
        throw new Error(`checkpoint authored placeholder id is not canonical: ${rawPlaceholderId}`);
      }
      if (typeof rawCharacterId !== "string" || normalizeId(rawCharacterId) !== rawCharacterId) {
        throw new Error(`checkpoint character owner for ${placeholderId} is not canonical`);
      }
      const characterId = rawCharacterId;
      const authoredActor = this.initialAuthoredActors.get(placeholderId);
      if (!authoredActor || authoredActor.role !== "player") {
        throw new Error(`checkpoint placeholder ${placeholderId} is not an authored player actor`);
      }
      if (placeholderId === characterId || this.isReservedCharacterId(characterId)) {
        throw new Error(`authored placeholder ${placeholderId} has reserved character owner ${characterId}`);
      }
      if (owners.has(characterId)) {
        throw new Error(`durable character ${characterId} owns multiple authored placeholders`);
      }
      if (this.characterPersistence?.hasCharacter?.(characterId) !== true) {
        throw new Error(`authored placeholder ${placeholderId} references missing durable character ${characterId}`);
      }
      owners.add(characterId);
    }
  }

  private seedAuthoredPlaceholderOwnersFromRustActors(
    snapshots: readonly RustAuthorityActorSnapshot[],
  ): void {
    for (const snapshot of snapshots) {
      const characterId = this.durableCharacterIdFromRustPlaceholderSnapshot(snapshot);
      if (!characterId) continue;
      this.authoredPlaceholderOwners.set(snapshot.id, characterId);
      this.claimedAuthoredPlaceholders.set(characterId, snapshot.id);
      this.remapProjectedRustOwnership(snapshot.id, characterId);
      const placeholder = this.actors.get(snapshot.id);
      if (placeholder && !this.actors.has(characterId)) {
        placeholder.characterId = characterId;
        this.moveProjectedActorId(snapshot.id, characterId, placeholder);
      } else if (placeholder) {
        placeholder.characterId = characterId;
      }
    }
  }

  private durableCharacterIdFromRustPlaceholderSnapshot(
    snapshot: RustAuthorityActorSnapshot,
  ): string | undefined {
    if (snapshot.id !== "player" || typeof snapshot.entity !== "string") return undefined;
    const rawEntity = snapshot.entity.trim();
    if (!rawEntity || rawEntity === this.authoredRustEntityByActorId.get(snapshot.id)) return undefined;
    const characterId = normalizeId(rawEntity);
    if (!characterId || characterId === snapshot.id || this.isReservedCharacterId(characterId)) return undefined;
    const durableOwner = this.authoredPlaceholderOwners.get(snapshot.id);
    if (durableOwner) return durableOwner === characterId ? durableOwner : undefined;
    return this.characterPersistence?.hasCharacter?.(characterId) === true ? characterId : undefined;
  }

  private durableCharacterIdFromDirectRustActorSnapshot(
    actorId: string,
    snapshot: RustAuthorityActorSnapshot,
  ): string | undefined {
    if (
      snapshot.id !== actorId
      || snapshot.entity !== actorId
      || snapshot.role !== "player"
      || this.isReservedCharacterId(actorId)
    ) return undefined;
    return this.characterPersistence?.hasCharacter?.(actorId) === true ? actorId : undefined;
  }

  private assertRestoredRustPlaceholderOwnership(snapshots: readonly RustAuthorityActorSnapshot[]): void {
    for (const snapshot of snapshots) {
      if (snapshot.id !== "player" || typeof snapshot.entity !== "string") continue;
      const rawEntity = snapshot.entity.trim();
      const baselineEntity = this.authoredRustEntityByActorId.get(snapshot.id);
      const durableOwner = this.authoredPlaceholderOwners.get(snapshot.id);
      if (rawEntity === baselineEntity) {
        if (durableOwner) {
          throw new Error(`Rust placeholder ${snapshot.id} lost durable owner ${durableOwner}`);
        }
        continue;
      }
      const characterId = normalizeId(rawEntity);
      if (!characterId || characterId === snapshot.id || this.isReservedCharacterId(characterId)) {
        throw new Error(`Rust placeholder ${snapshot.id} has invalid durable entity ${JSON.stringify(rawEntity)}`);
      }
      if (durableOwner && durableOwner !== characterId) {
        throw new Error(`Rust placeholder ${snapshot.id} owner mismatch: checkpoint=${durableOwner}, rust=${characterId}`);
      }
      if (this.characterPersistence?.hasCharacter?.(characterId) !== true) {
        throw new Error(`Rust placeholder ${snapshot.id} references missing durable character ${characterId}`);
      }
    }
    // A link-dead timeout removes the Rust actor while intentionally retaining
    // both `player:*` inventory and the durable alias. Absence is therefore a
    // valid offline state; any present player snapshot still has to match above.
  }

  private restoreDurableCharacterActorBindingsFromRustSnapshots(
    snapshots: readonly RustAuthorityActorSnapshot[],
  ): void {
    for (const snapshot of snapshots) {
      const actorId = this.typescriptActorIdForRustPlaceholder(snapshot.id);
      const characterId = this.authoredPlaceholderOwners.get(snapshot.id)
        ?? this.durableCharacterIdFromDirectRustActorSnapshot(actorId, snapshot);
      if (!characterId) continue;
      if (actorId !== characterId) {
        throw new Error(`restored Rust actor ${snapshot.id} resolved to mismatched character actor ${actorId}`);
      }
      const boundCharacterId = this.characterIdsByActorId.get(actorId);
      if (boundCharacterId && boundCharacterId !== characterId) {
        throw new Error(`restored actor ${actorId} is already bound to character ${boundCharacterId}`);
      }
      const boundActorId = this.characterActorIds.get(characterId);
      if (boundActorId && boundActorId !== actorId) {
        throw new Error(`restored character ${characterId} is already bound to actor ${boundActorId}`);
      }
      this.characterIdsByActorId.set(actorId, characterId);
      this.characterActorIds.set(characterId, actorId);
      this.realCharacterActorIds.add(actorId);
      this.returningCharacterActorIds.add(actorId);
    }
  }



  private createSnapshot(
    actorId: string,
    options: { compact: boolean; focusActorIds?: string[]; session?: GameSession },
  ): GameShardSnapshot {
    const actor = this.actors.get(actorId) ?? this.actors.values().next().value as AuthorityActor | undefined;
    const actors: Record<string, GameActorSnapshot> = {};
    if (!actor) {
      const inventory = options.session ? [] : this.inventory.map((row) => ({ ...row }));
      const reservations = options.session ? [] : this.reservations.map((row) => ({ ...row }));
      return {
        schema: "successor.authoritative-shard-snapshot.v1",
        resourceSpawns: [],
        placedExtractors: [],
        placedCamps: [],
        placedParcels: [],
        farmPlots: [],
        guilds: this.guildViewForActor(actorId),
        draftedSchematics: [],
        groups: emptyGameGroupView(),
        duels: emptyGameDuelView(),
        building: {
          schema: "successor.authority-building.v1",
          tick: this.lastRustAuthorityBuilding.tick,
          components: [],
          interiors: [],
        },
        shardId: this.shardId,
        tick: this.tick,
        playerActorId: actorId,
        actors,
        inventory,
        reservations,
        bank: null,
        playerCorpses: [],
        propStates: this.propStatesSnapshot(),
        actorRefs: [],
        sourceStateHash: this.sourceStateHash,
        sourceActorCount: this.sourceActorCount,
        worldClock: this.clockSnapshot(true),
        weather: this.weatherSnapshot(),
        counters: this.gameCounters(),
      };
    }

    // AOI centers on the camera's followed actor for a spectator session (else the player's own
    // actor) so a follow-cam actually receives the action it's pointed at. playerActorId below
    // stays the controlled pawn.
    const aoiCenter = (options.session && this.aoiObserverFor(options.session)) || actor;
    const focus = new Set([actor.id, aoiCenter.id, ...(options.focusActorIds ?? [])]);
    const candidates = options.compact
      ? [...focus]
          .map((id) => this.actors.get(id))
          .filter((candidate): candidate is AuthorityActor => Boolean(candidate))
          .map((candidate) => ({
            actor: candidate,
            distance: candidate.id === actor.id ? 0 : Math.hypot(candidate.x - aoiCenter.x, candidate.y - aoiCenter.y),
          }))
      : this.interestCandidates(aoiCenter, options.session, maxSnapshotActors);

    for (const candidate of candidates) {
      if (
        options.session
        && !this.shouldSendActorSnapshotToSession(options.session, actor.id, candidate.actor)
      ) {
        continue;
      }
      actors[candidate.actor.id] = this.actorSnapshotForObserver(actor.id, candidate.actor);
    }

    const inventory = options.session
      ? this.inventoryRowsForSession(options.session, actor)
      : this.inventory.map((row) => ({ ...row }));
    const reservations = options.session
      ? this.reservationsForSession(options.session, actor, inventory)
      : this.reservations.map((row) => ({ ...row }));

    return {
      schema: "successor.authoritative-shard-snapshot.v1",
      resourceSpawns: this.resourceSpawnsForArea(actor.areaId),
      placedExtractors: this.placedExtractorsForArea(actor.areaId, actor.id),
      placedCamps: this.placedCampsForArea(actor.areaId, actor.id),
      placedParcels: this.placedParcelsForArea(actor.areaId, actor.id),
      farmPlots: this.farmPlotsForArea(actor.areaId, actor.id),
      building: this.buildingForArea(actor.areaId),
      draftedSchematics: this.draftedSchematicsForActor(actor.id),
      guilds: this.guildViewForActor(actor.id),
      groups: this.groupViewForActor(actor.id),
      duels: this.duelViewForActor(actor.id),
      shardId: this.shardId,
      tick: this.tick,
      playerActorId: actor.id,
      actors,
      inventory,
      reservations,
      bank: options.session ? this.bankForActor(actor.id) : null,
      playerCorpses: this.playerCorpsesForObserver(actor, options.session, aoiCenter),
      propStates: this.propStatesSnapshot(),
      actorRefs: this.actorRefsFor(Object.keys(actors)),
      sourceStateHash: this.sourceStateHash,
      sourceActorCount: this.sourceActorCount,
      worldClock: this.clockSnapshot(!options.compact),
      weather: this.weatherSnapshot(),
      abilityQueue: this.abilityQueueForActor(actor.id),
      counters: this.gameCounters(),
    };
  }

  private shouldSendActorSnapshotToSession(
    session: GameSession,
    observerActorId: string,
    actor: AuthorityActor,
  ): boolean {
    if (actor.id === observerActorId || actor.id === session.actorId) return true;
    if (this.isUnclaimedAuthoredPlayerPlaceholder(actor)) return false;
    return actor.lifeState !== "respawning";
  }

  private isUnclaimedAuthoredPlayerPlaceholder(actor: AuthorityActor): boolean {
    if (this.initialAuthoredActors.get(actor.id)?.role !== "player") return false;
    for (const placeholderId of this.claimedAuthoredPlaceholders.values()) {
      if (placeholderId === actor.id) return false;
    }
    return true;
  }

  private actorNetId(actorId: string): number {
    const existing = this.actorNetIds.get(actorId);
    if (existing !== undefined) return existing;
    const netId = this.nextActorNetId++;
    this.actorNetIds.set(actorId, netId);
    this.actorIdsByNetId.set(netId, actorId);
    return netId;
  }

  private debugSeenCommands(actorId: string): Set<number> {
    let seenCommands = this.debugSeenCommandsByActor.get(actorId);
    if (!seenCommands) {
      seenCommands = new Set<number>();
      this.debugSeenCommandsByActor.set(actorId, seenCommands);
    }
    return seenCommands;
  }

  private nextDebugCommandId(actorId: string, requestedCommandId?: number): number {
    const current = this.debugNextCommandIdByActor.get(actorId) ?? 1;
    const requested = Number(requestedCommandId);
    const next = Number.isInteger(requested) && requested >= 1 ? requested : current;
    this.debugNextCommandIdByActor.set(actorId, Math.max(current, next + 1));
    return next;
  }

  private actorRefsFor(actorIds: Iterable<string>): GameActorNetRef[] {
    return [...actorIds].map((actorId) => [this.actorNetId(actorId), actorId]);
  }

  /** Test-only in-process authority adapter retained for packet/AOI reducer coverage. Runtime construction still requires Rust authority. */
  submitCommandForTest(actorId: string, envelope: ClientCommandEnvelope, seenCommands?: Set<number>, allowDebugCommand = false, ingressBudgetSession?: GameSession): SubmitCommandResult {
    const actor = this.actors.get(actorId);
    if (!actor) {
      const receipt = this.reject(envelope.command_id, "unknown_actor");
      this.recordCommandRejection(actorId, envelope.command, receipt.reasonCode, receipt.tick);
      this.persistenceDirty = true;
      this.appendJournal({
        type: "command.receipt",
        at: new Date().toISOString(),
        tick: this.tick,
        actorId,
        commandId: envelope.command_id,
        commandKind: commandKind(envelope.command),
        accepted: false,
        reasonCode: receipt.reasonCode,
        eventIds: [],
      });
      return { receipt, events: [], delta: this.receiptDeltaFor(actorId) };
    }
    if (!allowDebugCommand && isDebugAuthorityCommand(envelope.command)) {
      const receipt = this.reject(envelope.command_id, "debug_authority_command_disabled");
      this.recordCommandRejection(actor.id, envelope.command, receipt.reasonCode, receipt.tick);
      this.persistenceDirty = true;
      this.appendJournal({
        type: "command.receipt",
        at: new Date().toISOString(),
        tick: this.tick,
        actorId: actor.id,
        commandId: envelope.command_id,
        commandKind: commandKind(envelope.command),
        accepted: false,
        reasonCode: receipt.reasonCode,
        eventIds: [],
      });
      return { receipt, events: [], delta: this.receiptDeltaFor(actor.id) };
    }
    const commandLedger = seenCommands ?? actor.seenCommands;
    if (commandLedger.has(envelope.command_id)) {
      const receipt = this.reject(envelope.command_id, "duplicate_command");
      this.recordCommandRejection(actor.id, envelope.command, receipt.reasonCode, receipt.tick);
      this.persistenceDirty = true;
      this.appendJournal({
        type: "command.receipt",
        at: new Date().toISOString(),
        tick: this.tick,
        actorId: actor.id,
        commandId: envelope.command_id,
        commandKind: commandKind(envelope.command),
        accepted: false,
        reasonCode: receipt.reasonCode,
        eventIds: [],
      });
      this.observeRustAuthorityCommand(actor, envelope, receipt);
      return { receipt, events: [], delta: this.receiptDeltaFor(actor.id) };
    }
    commandLedger.add(envelope.command_id);
    trimSeenCommands(commandLedger);
    if (ingressBudgetSession) {
      const budgetRejection = this.rejectIngressBudgetIfExhausted(ingressBudgetSession, actor, envelope);
      if (budgetRejection) return budgetRejection;
    }

    const applied = this.applyCommand(actor, envelope);
    const receipt: GameCommandReceipt = {
      commandId: envelope.command_id,
      accepted: applied.accepted,
      tick: this.tick,
    };
    if (!receipt.accepted) {
      receipt.reasonCode = applied.reasonCode ?? reasonForRejectedNoEventCommand(envelope.command);
      this.counters.rejectedCommands += 1;
      this.recordCommandRejection(actor.id, envelope.command, receipt.reasonCode, receipt.tick);
    } else {
      this.counters.acceptedCommands += 1;
    }
    this.persistenceDirty = true;
    this.appendJournal({
      type: "command.receipt",
      at: new Date().toISOString(),
      tick: this.tick,
      actorId: actor.id,
      commandId: envelope.command_id,
      commandKind: commandKind(envelope.command),
      accepted: receipt.accepted,
      reasonCode: receipt.reasonCode,
      eventIds: applied.events.map((event) => event.id),
    });
    this.observeRustAuthorityCommand(actor, envelope, receipt);
    this.appendCombatEventJournal(applied.events);
    this.markDirty(actor.id, ...applied.events.map((event) => event.targetActorId));
    const isMoveCommand = "Move" in envelope.command;
    const changedActorIds = applied.accepted
      ? [actor.id, ...applied.events.map((event) => event.targetActorId)]
      : [];
    const delta = !applied.accepted || (isMoveCommand && ingressBudgetSession)
      ? this.receiptDeltaFor(actor.id)
      : this.deltaForCommand(actor.id, changedActorIds, ingressBudgetSession);
    return {
      receipt,
      events: applied.events,
      delta,
    };
  }

  async submitDebugAuthorityCommand(actorId: string, command: ClientCommand, requestedCommandId?: number): Promise<DebugAuthorityCommandResult> {
    const actor = this.actors.get(actorId);
    if (!actor) {
      const commandId = this.nextDebugCommandId(actorId, requestedCommandId);
      const receipt = this.reject(commandId, "unknown_actor");
      this.recordCommandRejection(actorId, command, receipt.reasonCode, receipt.tick);
      return {
        actorId,
        commandId,
        commandKind: commandKind(command),
        receipt,
        events: [],
        delta: this.receiptDeltaFor(actorId),
      };
    }

    // Debug commands always ride authority session 0. Successive disposable
    // verification actors can claim the same authored Rust placeholder, so
    // their idempotency namespace is the Rust actor identity, not the current
    // TypeScript projection id. Keeping the counter on the transient id would
    // restart at 1 for every journey and Rust would honestly reject the later
    // setup command as a duplicate.
    const debugAuthorityActorId = this.rustActorIdFor(actor.id);
    const commandId = this.nextDebugCommandId(debugAuthorityActorId, requestedCommandId);
    const player = this.actorNetId(actor.id);
    const envelope: ClientCommandEnvelope = {
      session: 0,
      player,
      command_id: commandId,
      issued_at_tick: this.tick,
      command,
    };
    const seenCommands = this.debugSeenCommands(actor.id);
    const result = this.rustAuthorityMode === "live"
      ? await this.submitRustAuthorityCommandForActor(actor.id, envelope, seenCommands, { session: 0, player, allowDebugCommand: true })
      : this.allowInProcessAuthorityForTests
        ? this.submitCommandForTest(actor.id, envelope, seenCommands, true)
        : this.rejectMissingRustAuthorityForActor(actor.id, envelope);
    if (result.tradeSessionDeliveries) {
      this.deliverTradeSessionsToParticipants(result.tradeSessionDeliveries);
    }
    if (result.duelOutcomes) {
      this.deliverDuelOutcomesToParticipants(result.duelOutcomes);
    }
    return {
      ...result,
      actorId: actor.id,
      commandId,
      commandKind: commandKind(command),
    };
  }

  async restockDebugActorLoadout(actorId: string): Promise<{
    schema: string;
    actorId: string;
    accepted: boolean;
    reasonCode?: string;
    tick: number;
    inventory: RustAuthorityInventorySnapshot[];
  }> {
    const actor = this.actors.get(actorId);
    if (!actor) {
      return {
        schema: "successor.debug-restock-loadout.v1",
        actorId,
        accepted: false,
        reasonCode: "unknown_actor",
        tick: this.tick,
        inventory: this.inventory.map((row) => ({ ...row })),
      };
    }
    if (!this.rustAuthorityBridge || this.rustAuthorityMode !== "live") {
      return {
        schema: "successor.debug-restock-loadout.v1",
        actorId: actor.id,
        accepted: false,
        reasonCode: "rust_authority_required",
        tick: this.tick,
        inventory: this.inventory.map((row) => ({ ...row })),
      };
    }

    const rustActorId = this.rustActorIdFor(actor.id);
    await this.ensureRustAuthorityActor(actor, rustActorId);
    const output = await this.rustAuthorityBridge.restockActorLoadout({ actorId: rustActorId });
    this.syncTickFromRust(output.tick);
    this.recordRustAuthorityStateHash(output.targetStateHash);
    this.syncRustMetrics(output.metrics);
    this.syncRustInventory(output.inventory, output.reservations, output.timelineEvents);
    this.syncRustResourceSpawns(output);
    this.syncRustPlacedExtractors(output);
    this.syncRustPlacedCamps(output);
    this.syncRustPlacedParcels(output);
    this.syncRustBuilding(output);
    this.syncRustFarmPlots(output);
    this.syncRustDraftedSchematics(output);
    this.syncRustGroupViews(output);
    this.syncRustDuelViews(output);
    if (output.actor) this.applyRustActorSnapshot(this.typescriptActorIdForRustActorId(output.actor.id, actor.id, rustActorId), output.actor);
    this.markDirty(actor.id);
    this.persistenceDirty = true;
    return {
      schema: "successor.debug-restock-loadout.v1",
      actorId: actor.id,
      accepted: true,
      tick: this.tick,
      inventory: this.inventory.map((row) => ({ ...row })),
    };
  }

  private observeRustAuthorityCommand(
    actor: AuthorityActor,
    envelope: ClientCommandEnvelope,
    receipt: GameCommandReceipt,
  ): void {
    if (!this.rustAuthorityBridge || !this.authoredActorIds.has(actor.id)) return;
    this.rustAuthorityBridge.observeCommand({
      actorId: actor.id,
      envelope,
      receipt,
    });
  }

  private rejectMissingRustAuthority(session: GameSession, envelope: ClientCommandEnvelope): SubmitCommandResult {
    return this.rejectMissingRustAuthorityForActor(session.actorId, envelope);
  }

  /**
   * Resolve the bare-use reuse-last sentinel for /survey //sample against the
   * session's last resource family. INGRESS-ONLY: the returned envelope always
   * carries a CONCRETE family, so nothing downstream (Rust bridge, journal,
   * replica/restore) ever sees "$last". No sentinel -> the envelope passes
   * through untouched. No session context -> an honest prompt reason code.
   */
  private resolveResourceSentinelForSession(
    session: GameSession,
    envelope: ClientCommandEnvelope,
  ): { envelope: ClientCommandEnvelope } | { reject: string } {
    const command = envelope.command;
    const isSurvey = "SurveyResource" in command;
    const isSample = "SampleResource" in command;
    if (!isSurvey && !isSample) return { envelope };
    const family = isSurvey ? command.SurveyResource.family : command.SampleResource.family;
    if (family !== lastResourceFamilySentinel) return { envelope };
    const last = session.lastResourceFamily;
    if (!last) {
      return { reject: isSurvey ? noSurveyContextReasonCode : noSampleContextReasonCode };
    }
    const resolvedCommand: ClientCommand = isSurvey
      ? { SurveyResource: { family: last } }
      : {
          SampleResource: {
            family: last,
            ...(command.SampleResource.stop === undefined ? {} : { stop: command.SampleResource.stop }),
          },
        };
    return { envelope: { ...envelope, command: resolvedCommand } };
  }

  /**
   * After an ACCEPTED survey/sample, remember its (concrete) family so a later
   * bare /survey //sample reuses it. Sentinels never reach here (resolved at
   * ingress); this only ever stores a real family.
   */
  private recordSessionResourceContext(session: GameSession, envelope: ClientCommandEnvelope): void {
    const command = envelope.command;
    const family = "SurveyResource" in command
      ? command.SurveyResource.family
      : "SampleResource" in command
        ? command.SampleResource.family
        : null;
    if (family && family !== lastResourceFamilySentinel) {
      session.lastResourceFamily = family;
    }
  }

  private async submitRustAuthorityCommand(
    session: GameSession,
    envelope: ClientCommandEnvelope,
  ): Promise<SubmitCommandResult> {
    return this.submitRustAuthorityCommandForActor(session.actorId, envelope, session.seenCommands, {
      session: rustSessionNumber(session),
      player: this.actorNetId(session.actorId),
      ingressBudgetSession: session,
    });
  }

  private rejectMissingRustAuthorityForActor(actorId: string, envelope: ClientCommandEnvelope): SubmitCommandResult {
    const receipt = this.reject(envelope.command_id, "rust_authority_required");
    this.counters.rejectedCommands += 1;
    this.recordCommandRejection(actorId, envelope.command, receipt.reasonCode, receipt.tick);
    return { receipt, events: [], delta: this.receiptDeltaFor(actorId) };
  }

  private rejectIngressBudgetIfExhausted(
    session: GameSession,
    actor: AuthorityActor,
    envelope: ClientCommandEnvelope,
  ): SubmitCommandResult | null {
    if (this.consumeIngressBudget(session, envelope.command)) return null;
    const receipt = this.reject(envelope.command_id, ingressBudgetExhaustedReasonCode);
    this.recordCommandRejection(actor.id, envelope.command, receipt.reasonCode, receipt.tick);
    return { receipt, events: [], delta: this.receiptDeltaFor(actor.id) };
  }

  private consumeIngressBudget(session: GameSession, command: ClientCommand): boolean {
    const kind = commandKind(command);
    const rule = this.ingressBudgetRuleForKind(kind);
    const nowMs = finiteNumberOr(this.ingressBudgetConfig.nowMs(), this.clock.nowMs());
    const previous = session.ingressBudgets.get(kind);
    const bucket = previous ?? { tokens: rule.capacity, updatedAtMs: nowMs };
    const elapsedSeconds = Math.max(0, nowMs - bucket.updatedAtMs) / 1000;
    const refilledTokens = Math.min(rule.capacity, bucket.tokens + elapsedSeconds * rule.refillPerSecond);
    bucket.updatedAtMs = nowMs;
    if (refilledTokens < 1) {
      bucket.tokens = refilledTokens;
      session.ingressBudgets.set(kind, bucket);
      return false;
    }
    bucket.tokens = refilledTokens - 1;
    session.ingressBudgets.set(kind, bucket);
    return true;
  }

  private ingressBudgetRuleForKind(kind: string): IngressBudgetRule {
    return this.ingressBudgetConfig.commandKinds[kind] ?? this.ingressBudgetConfig.default;
  }

  private async submitLocalAuthorityCommandForActor(
    actor: AuthorityActor,
    envelope: ClientCommandEnvelope,
    applied: ApplyCommandResult,
    session?: GameSession,
  ): Promise<SubmitCommandResult> {
    if (applied.accepted && "UseTravelTicket" in envelope.command && this.rustAuthorityMode === "live") {
      await this.relocateRustAuthorityActor(actor, this.rustActorIdFor(actor.id));
    }
    if (applied.accepted && "ToggleDoor" in envelope.command && this.rustAuthorityMode === "live") {
      const propId = envelope.command.ToggleDoor.prop_id;
      const output = await this.rustAuthorityBridge?.setDoorOpen({
        propId,
        doorOpen: this.propStates.get(propId)?.doorOpen === true,
      });
      this.recordRustAuthorityStateHash(output?.targetStateHash);
    }
    const receipt: GameCommandReceipt = {
      commandId: envelope.command_id,
      accepted: applied.accepted,
      tick: this.tick,
    };
    if (!receipt.accepted) {
      receipt.reasonCode = applied.reasonCode ?? reasonForRejectedNoEventCommand(envelope.command);
      this.counters.rejectedCommands += 1;
      this.recordCommandRejection(actor.id, envelope.command, receipt.reasonCode, receipt.tick);
    } else {
      this.counters.acceptedCommands += 1;
    }
    this.persistenceDirty = true;
    this.appendJournal({
      type: "command.receipt",
      at: new Date().toISOString(),
      tick: this.tick,
      actorId: actor.id,
      commandId: envelope.command_id,
      commandKind: commandKind(envelope.command),
      accepted: receipt.accepted,
      reasonCode: receipt.reasonCode,
      eventIds: applied.events.map((event) => event.id),
    });
    this.appendCombatEventJournal(applied.events);
    this.markDirty(actor.id, ...applied.events.map((event) => event.targetActorId));
    const changedActorIds = applied.accepted ? [actor.id, ...applied.events.map((event) => event.targetActorId)] : [];
    const delta = applied.accepted
      ? this.deltaForCommand(actor.id, changedActorIds, session)
      : this.receiptDeltaFor(actor.id);
    if (receipt.accepted) {
      await this.persistAcceptedWorldTransition(actor.id, envelope.command);
    }
    return {
      receipt,
      events: applied.events,
      delta,
    };
  }

  private async awaitRustAuthorityReady(): Promise<void> {
    if (this.rustAuthorityRestorePromise) await this.rustAuthorityRestorePromise;
    if (this.rustAuthorityRestoreError) throw this.rustAuthorityRestoreError;
    if (this.rustAuthorityCheckpointPromise) await this.rustAuthorityCheckpointPromise;
  }

  private recordRustAuthorityStateHash(stateHash: string | undefined): void {
    if (typeof stateHash === "string" && stateHash.length > 0) {
      // A changed Rust target hash means authoritative state changed even when
      // the output came from an autonomous tick rather than a player command.
      // Keep the checkpoint gate open until that exact state is durably saved.
      if (stateHash !== this.lastRustAuthorityStateHash) this.persistenceDirty = true;
      this.lastRustAuthorityStateHash = stateHash;
    }
  }


  private async submitRustAuthorityCommandForActor(
    actorId: string,
    envelope: ClientCommandEnvelope,
    seenCommands: Set<number>,
    identity: { session?: number; player?: number; allowDebugCommand?: boolean; ingressBudgetSession?: GameSession } = {},
  ): Promise<SubmitCommandResult> {
    const actor = this.actors.get(actorId);
    if (!actor) {
      const receipt = this.reject(envelope.command_id, "unknown_actor");
      this.recordCommandRejection(actorId, envelope.command, receipt.reasonCode, receipt.tick);
      return { receipt, events: [], delta: this.receiptDeltaFor(actorId) };
    }
    await this.awaitRustAuthorityReady();
    if (this.checkpointCapturePromise) await this.checkpointCapturePromise;
    if (seenCommands.has(envelope.command_id)) {
      const receipt = this.reject(envelope.command_id, "duplicate_command");
      this.recordCommandRejection(actor.id, envelope.command, receipt.reasonCode, receipt.tick);
      return { receipt, events: [], delta: this.receiptDeltaFor(actor.id) };
    }
    seenCommands.add(envelope.command_id);
    trimSeenCommands(seenCommands);
    if (!identity.allowDebugCommand && isDebugAuthorityCommand(envelope.command)) {
      const receipt = this.reject(envelope.command_id, "debug_authority_command_disabled");
      this.recordCommandRejection(actor.id, envelope.command, receipt.reasonCode, receipt.tick);
      return { receipt, events: [], delta: this.receiptDeltaFor(actor.id) };
    }
    if (identity.ingressBudgetSession) {
      const budgetRejection = this.rejectIngressBudgetIfExhausted(identity.ingressBudgetSession, actor, envelope);
      if (budgetRejection) return budgetRejection;
    }
    const localApplied = this.applyLocalAuthorityCommand(actor, envelope);
    if (localApplied) return this.submitLocalAuthorityCommandForActor(actor, envelope, localApplied, identity.ingressBudgetSession);


    const rustActorId = this.rustActorIdFor(actor.id);
    await this.ensureRustAuthorityActor(actor, rustActorId);
    const rustEnvelope = this.rustEnvelopeForCommand(envelope);
    const output = await this.rustAuthorityBridge!.submitCommand({
      actorId: rustActorId,
      envelope: rustEnvelope,
      session: identity.session,
      player: identity.player ?? this.actorNetId(actor.id),
    });
    this.recordRustAuthorityStateHash(output.targetStateHash);
    const accepted = output.status === "accepted";
    const rejectedActorIds: string[] = [];
    if (!accepted) {
      const rejectedSnapshots = [
        ...(output.actor ? [output.actor] : []),
        ...(output.actors ?? []),
      ];
      const seenRejectedActorIds = new Set<string>();
      for (const rejectedSnapshot of rejectedSnapshots) {
        const snapshotActorId = this.typescriptActorIdForRustActorId(rejectedSnapshot.id, actor.id, rustActorId);
        if (seenRejectedActorIds.has(snapshotActorId)) continue;
        seenRejectedActorIds.add(snapshotActorId);
        this.applyRustActorSnapshot(snapshotActorId, rejectedSnapshot);
        rejectedActorIds.push(snapshotActorId);
      }
    }
    const applied = accepted
      ? this.applyRustAuthorityOutput(actor.id, rustActorId, output)
      : { events: [], abilityQueueEvents: [] };
    if (accepted && "SetEquippedClothing" in envelope.command) {
      const characterId = this.characterIdsByActorId.get(actor.id);
      if (characterId) this.saveCharacterSnapshot(characterId, actor, { reason: "checkpoint", atMs: Date.now() });
    }
    const events = applied.events;
    const abilityQueueEvents = applied.abilityQueueEvents
      .filter((delivery) => delivery.actorId === actor.id)
      .map((delivery) => delivery.event);
    const receipt: GameCommandReceipt = {
      commandId: envelope.command_id,
      accepted,
      tick: Number.isFinite(output.tick) ? Number(output.tick) : this.tick,
    };
    if (!accepted) {
      receipt.reasonCode = output.reasonCode ?? reasonForRejectedNoEventCommand(envelope.command);
      this.counters.rejectedCommands += 1;
      this.recordCommandRejection(actor.id, envelope.command, receipt.reasonCode, receipt.tick);
    } else {
      this.counters.acceptedCommands += 1;
    }

    this.persistenceDirty = true;
    this.appendJournal({
      type: "command.receipt",
      at: new Date().toISOString(),
      tick: this.tick,
      actorId: actor.id,
      commandId: envelope.command_id,
      commandKind: commandKind(envelope.command),
      accepted: receipt.accepted,
      reasonCode: receipt.reasonCode,
      eventIds: events.map((event) => event.id),
      rust: {
        actorId: actor.id,
        rustActorId,
        envelope: rustEnvelope,
        ...(identity.session === undefined ? {} : { session: identity.session }),
        player: identity.player ?? this.actorNetId(actor.id),
        stateHash: output.targetStateHash,
      },
    });
    this.appendCombatEventJournal(events);
    this.markDirty(actor.id, ...events.map((event) => event.targetActorId));
    const isMoveCommand = "Move" in envelope.command;
    const changedActorIds = accepted
      ? [actor.id, ...events.map((event) => event.targetActorId)]
      : rejectedActorIds;
    const delta = isMoveCommand
      ? this.receiptDeltaFor(actor.id)
      : !accepted
        ? changedActorIds.length > 0
          ? this.deltaForCommand(actor.id, changedActorIds, identity.ingressBudgetSession)
          : this.receiptDeltaFor(actor.id)
        : this.deltaForCommand(actor.id, changedActorIds, identity.ingressBudgetSession);
    if (receipt.accepted) {
      await this.persistAcceptedWorldTransition(actor.id, envelope.command);
    }
    return {
      receipt,
      events,
      delta,
      abilityQueueEvents,
      surveyResult: output.surveyResult ?? undefined,
      craftSession: output.craftSession ?? undefined,
      spliceSession: output.spliceSession ?? undefined,
      genomeScan: output.genomeScan ?? undefined,
      tradeSessionDeliveries: output.tradeSessionDeliveries ?? undefined,
      duelOutcomes: output.duelOutcomes ?? undefined,
      draftedSchematics: this.draftedSchematicsForActor(actor.id),
    };
  }

  private applyRustAuthorityOutput(
    actorId: string,
    rustActorId: string,
    output: RustAuthorityBridgeStepOutput,
  ): { events: GameCombatEvent[]; abilityQueueEvents: AbilityQueueEventDelivery[] } {
    this.syncTickFromRust(output.tick);
    this.recordRustAuthorityStateHash(output.targetStateHash);
    this.syncRustMetrics(output.metrics);
    this.syncRustAiDebug(output.aiDebug);
    this.syncRustResourceSpawns(output);
    this.syncRustPlacedExtractors(output);
    this.syncRustPlacedCamps(output);
    this.syncRustPlacedParcels(output);
    this.syncRustBuilding(output);
    this.syncRustFarmPlots(output);
    this.syncRustDraftedSchematics(output);
    this.syncRustGroupViews(output);
    this.syncRustDuelViews(output);
    this.syncRustInventory(output.inventory, output.reservations, output.timelineEvents);
    this.syncRustPlayerCorpses(output.playerCorpses);
    const actorSnapshots = new Map<string, RustAuthorityActorSnapshot>();
    if (output.actor) {
      actorSnapshots.set(
        this.typescriptActorIdForRustActorId(output.actor.id, actorId, rustActorId),
        output.actor,
      );
    }
    for (const actor of output.actors ?? []) {
      actorSnapshots.set(this.typescriptActorIdForRustActorId(actor.id, actorId, rustActorId), actor);
    }
    const snapshottedActorIds = new Set(actorSnapshots.keys());
    const events = (output.combatEvents ?? []).map((event) => (
      this.rustCombatEventToGameEvent(event, actorId, rustActorId)
    ));
    this.applyRustCombatEventsToProjection(events, snapshottedActorIds);
    this.queueDialogueDeliveries(output.dialogueDeliveries ?? []);
    for (const [snapshotActorId, actor] of actorSnapshots) this.applyRustActorSnapshot(snapshotActorId, actor);
    this.syncRustBankProjection(output.bank, actorId);
    for (const snapshotActorId of actorSnapshots.keys()) this.checkpointCharacterActorIfDue(snapshotActorId);
    this.repairRustProjectionLifecycleDeadlines();
    return { events, abilityQueueEvents: this.abilityQueueEventsFromRust(output.abilityQueueEvents ?? []) };
  }

  private applyRustAuthorityTickOutput(output: RustAuthorityBridgeTickOutput): GameCombatEvent[] {
    this.seedAuthoredPlaceholderOwnersFromRustActors([
      ...(output.actors ?? []),
      ...(output.logoutActors ?? []),
    ]);
    this.syncTickFromRust(output.tick);
    this.recordRustAuthorityStateHash(output.targetStateHash);
    this.syncRustMetrics(output.metrics);
    this.lastRustAuthorityTickTiming = output.timing;
    this.syncRustAiDebug(output.aiDebug);
    this.syncRustResourceSpawns(output);
    this.syncRustPlacedExtractors(output);
    this.syncRustPlacedCamps(output);
    this.syncRustPlacedParcels(output);
    this.syncRustBuilding(output);
    this.syncRustFarmPlots(output);
    this.syncRustDraftedSchematics(output);
    this.syncRustGroupViews(output);
    this.syncRustDuelViews(output);
    this.syncRustInventory(output.inventory, output.reservations, output.timelineEvents);
    this.syncRustBankProjection(output.bank);
    this.syncRustPlayerCorpses(output.playerCorpses);
    if (output.duelOutcomes && output.duelOutcomes.length > 0) {
      this.deliverDuelOutcomesToParticipants(output.duelOutcomes);
    }
    const actorSnapshots = (output.actors ?? []).map((actor) => ({
      actorId: this.typescriptActorIdForRustActorId(actor.id, "__server_tick_observer__", "__server_tick_observer__"),
      actor,
    }));
    const snapshottedActorIds = new Set(actorSnapshots.map((actor) => actor.actorId));
    const events = (output.combatEvents ?? []).map((event) => (
      this.rustCombatEventToGameEvent(event, "__server_tick_observer__", "__server_tick_observer__")
    ));
    this.queueAbilityQueueEvents(this.abilityQueueEventsFromRust(output.abilityQueueEvents ?? []));
    this.applyRustCombatEventsToProjection(events, snapshottedActorIds);
    for (const { actorId, actor } of actorSnapshots) {
      this.applyRustActorSnapshot(actorId, actor);
      this.checkpointCharacterActorIfDue(actorId);
    }
    this.queueDialogueDeliveries(output.dialogueDeliveries ?? []);
    this.applyRustLogoutActorSnapshots(output.logoutActors ?? []);
    this.applyRustActorRemovals(output.removedActorIds ?? []);
    this.repairRustProjectionLifecycleDeadlines();
    return events;
  }

  private queueDialogueDeliveries(rows: readonly RustAuthorityDialogueDelivery[]): void {
    const radius = Math.min(this.areaInterestRadiusCells, maxCombatEventInterestRadiusCells);
    const radiusSq = radius * radius;
    for (const row of rows) {
      const actorId = typeof row.actorId === "string" ? this.typescriptActorIdForRustPlaceholder(row.actorId) : "";
      const actor = this.actors.get(actorId);
      const areaId = typeof row.areaId === "string" ? row.areaId : actor?.areaId ?? "";
      const x = Number(row.x) / 1000;
      const y = Number(row.y) / 1000;
      const body = typeof row.body === "string" ? row.body.trim() : "";
      if (!actorId || !areaId || !body || !Number.isFinite(x) || !Number.isFinite(y)) continue;
      const speaker = typeof row.speaker === "string" && row.speaker.trim() ? row.speaker.trim() : actor?.label ?? actorId;
      const delivery: GameDialogueDelivery = { actorId, speaker, body, areaId, x, y, tick: Number.isFinite(row.tick) ? Number(row.tick) : this.tick };
      for (const session of this.sessions.values()) {
        const observer = this.actors.get(session.actorId);
        if (!observer || observer.areaId !== areaId) continue;
        const dx = observer.x - x;
        const dy = observer.y - y;
        if (dx * dx + dy * dy <= radiusSq) session.pendingDialogueDeliveries.push(delivery);
      }
    }
  }

  private abilityQueueEventsFromRust(
    events: readonly RustAuthorityAbilityQueueEventSnapshot[],
  ): AbilityQueueEventDelivery[] {
    return events
      .map((event) => {
        const actorId = this.typescriptActorIdForRustPlaceholder(event.actorId);
        const mapped: AbilityQueueEvent = {
          id: event.id,
          lifecycle: event.lifecycle,
          tick: finiteInteger(event.tick, this.tick),
          ...(event.reasonCode ? { reasonCode: event.reasonCode } : {}),
          ...(typeof event.fireSeq === "number" ? { fireSeq: event.fireSeq } : {}),
          ...(event.abilityId ? { abilityId: event.abilityId } : {}),
          ...(event.iconId ? { iconId: event.iconId } : {}),
        };
        return { actorId, event: mapped };
      });
  }

  private queueAbilityQueueEvents(deliveries: readonly AbilityQueueEventDelivery[]): void {
    if (deliveries.length === 0) return;
    for (const delivery of deliveries) {
      for (const session of this.sessions.values()) {
        if (session.actorId !== delivery.actorId) continue;
        session.pendingAbilityQueueEvents.push(delivery.event);
      }
    }
  }

  private takePendingAbilityQueueEvents(session: GameSession): AbilityQueueEvent[] {
    return session.pendingAbilityQueueEvents.splice(0);
  }

  private applyRustLogoutActorSnapshots(logoutActors: readonly RustAuthorityActorSnapshot[]): void {
    for (const actor of logoutActors) {
      const actorId = this.typescriptActorIdForRustPlaceholder(actor.id);
      this.applyRustActorSnapshot(actorId, actor);
      const characterId = this.characterIdsByActorId.get(actorId);
      const projected = this.actors.get(actorId);
      if (!characterId || !projected) continue;
      this.saveCharacterSnapshot(characterId, projected, {
        reason: "linkdead_timeout",
        atMs: Date.now(),
        logout: true,
      });
      this.lastCharacterCheckpointMs.delete(characterId);
      this.characterIdsByActorId.delete(actorId);
      this.characterActorIds.delete(characterId);
    }
  }

  private applyRustActorRemovals(rustActorIds: readonly string[]): void {
    if (rustActorIds.length === 0) return;
    for (const rustActorId of rustActorIds) {
      this.rustAuthorityRegisteredActorIds.delete(rustActorId);
      this.rustAuthorityActorUpserts.delete(rustActorId);
      this.rustAuthorityLinkDeadActorIds.delete(rustActorId);
      this.rustAuthorityDesiredLinkDead.delete(rustActorId);
      this.rustAuthorityLinkDeadEffects.delete(rustActorId);
    }
    const removedActorIds = uniqueActorIds(
      rustActorIds.map((actorId) => this.typescriptActorIdForRustPlaceholder(actorId)),
    );
    let removed = false;
    for (const actorId of removedActorIds) {
      removed = this.removeProjectedRustActor(actorId) || removed;
    }
    if (removed) {
      this.invalidateActorSpatialIndex();
      this.dirty = true;
      this.persistenceDirty = true;
    }
  }

  private removeProjectedRustActor(actorId: string): boolean {
    const actor = this.actors.get(actorId);
    if (!actor) return false;
    if (this.authoredActorIds.has(actorId) || this.sessionActorExists(actorId)) return false;

    const characterId = this.characterIdsByActorId.get(actorId);
    if (characterId) {
      this.characterIdsByActorId.delete(actorId);
      this.characterActorIds.delete(characterId);
      this.lastCharacterCheckpointMs.delete(characterId);
    }
    this.actors.delete(actorId);
    this.restoreClaimedAuthoredPlaceholder(actorId, actor, true);
    const netId = this.actorNetIds.get(actorId);
    if (netId !== undefined) {
      this.actorNetIds.delete(actorId);
      this.actorIdsByNetId.delete(netId);
    }
    this.transientSessionActorIds.delete(actorId);
    this.realCharacterActorIds.delete(actorId);
    this.returningCharacterActorIds.delete(actorId);
    this.claimedAuthoredPlaceholders.delete(actorId);
    this.dirtyActorIds.delete(actorId);
    this.highDetailDirtyActorIds.delete(actorId);
    this.statusDirtyActorIds.delete(actorId);
    for (const session of this.sessions.values()) {
      if (!session.knownActorIds.has(actorId)) continue;
      session.interestDirty = true;
    }
    return true;
  }

  private applyRustCombatEventsToProjection(
    events: GameCombatEvent[],
    snapshottedActorIds: ReadonlySet<string>,
  ): void {
    for (const event of events) {
      if (snapshottedActorIds.has(event.targetActorId)) continue;
      const target = this.actors.get(event.targetActorId);
      if (target) {
        target.lifeState = event.lifeState;
        target.lifecycleSeq = Math.max(target.lifecycleSeq, positiveIntegerOr(event.targetLifecycleSeq, target.lifecycleSeq));
        this.markStatusDirty(target.id);
      }
    }
  }

  private repairRustProjectionLifecycleDeadlines(): void {
    // Rust authority owns corpse lifetime and the downed→respawning transition.
    // Keep TS projection from applying stale local body-vanish deadlines when a
    // corpse has not yet been reported as respawning/removed by Rust.
  }

  private syncTickFromRust(tick: number | undefined): void {
    if (typeof tick !== "number" || !Number.isFinite(tick)) return;
    this.tick = Math.trunc(tick);
  }

  private syncRustExchangeMetrics(exchangeMetrics: RustAuthorityBridgeExchangeMetricsOutput["exchangeMetrics"] | undefined): void {
    if (!exchangeMetrics) return;
    this.lastRustAuthorityExchangeMetrics = exchangeMetrics;
  }

  private syncRustMetrics(metrics: RustAuthorityBridgeStepOutput["metrics"] | RustAuthorityBridgeTickOutput["metrics"] | undefined): void {
    if (!metrics) return;
    this.lastRustAuthorityMetrics = metrics;
    if (typeof metrics.shotsFired === "number" && Number.isFinite(metrics.shotsFired)) {
      this.counters.shotsFired = Math.max(this.counters.shotsFired, Math.trunc(metrics.shotsFired));
    }
    if (typeof metrics.hits === "number" && Number.isFinite(metrics.hits)) {
      this.counters.hits = Math.max(this.counters.hits, Math.trunc(metrics.hits));
    }
    if (typeof metrics.deaths === "number" && Number.isFinite(metrics.deaths)) {
      this.counters.deaths = Math.max(this.counters.deaths, Math.trunc(metrics.deaths));
    }
  }

  private scheduleRustAiDebugRefreshForOracle(): void {
    void this.refreshRustAiDebugForOracle();
  }

  private async refreshRustAiDebugForOracle(options: { force?: boolean } = {}): Promise<void> {
    if (this.rustAuthorityMode !== "live" || !this.rustAuthorityBridge) return;
    if (this.rustAuthorityAiDebugRefreshInFlight) {
      if (options.force === true) await this.rustAuthorityAiDebugRefreshInFlight;
      return;
    }
    if (this.rustAuthorityFlushInFlight && options.force !== true) return;
    const bridgeStatus = this.rustAuthorityBridge.debugStatus();
    if (options.force !== true && (bridgeStatus.livePending > 0 || bridgeStatus.backlogSize > 0)) return;
    const now = Date.now();
    if (options.force !== true && now - this.lastRustAuthorityAiDebugRefreshAtMs < rustAiDebugOracleRefreshIntervalMs) return;
    this.lastRustAuthorityAiDebugRefreshAtMs = now;
    const refresh = this.rustAuthorityBridge.submitAiDebug({ timeoutMs: rustAiDebugOracleTimeoutMs })
      .then((output) => {
        this.syncTickFromRust(output.tick);
        this.syncRustAiDebug(output.aiDebug);
        this.syncRustResourceSpawns(output);
        this.syncRustPlacedExtractors(output);
        this.syncRustPlacedCamps(output);
        this.syncRustPlacedParcels(output);
        this.syncRustBuilding(output);
        this.syncRustFarmPlots(output);
        this.syncRustDraftedSchematics(output);
      })
      .catch((error) => {
        this.logger?.warn({ error }, "rust authority AI debug snapshot failed");
      })
      .finally(() => {
        if (this.rustAuthorityAiDebugRefreshInFlight === refresh) this.rustAuthorityAiDebugRefreshInFlight = null;
      });
    this.rustAuthorityAiDebugRefreshInFlight = refresh;
    if (options.force === true) await refresh;
  }

  private syncRustAiDebug(aiDebug: RustAuthorityAiDebugSnapshot | undefined): void {
    if (!aiDebug) return;
    this.lastRustAuthorityAiDebug = aiDebug;
  }

  private syncRustResourceSpawns(output: {
    resourceSpawns?: GameResourceSpawn[] | null;
    areaResourceSpawns?: RustAuthorityAreaResourceSpawnsSnapshot[] | null;
  }): void {
    if (Array.isArray(output.areaResourceSpawns)) {
      this.resourceSpawnsByArea.clear();
      const all: GameResourceSpawn[] = [];
      for (const area of output.areaResourceSpawns) {
        const spawns = Array.isArray(area.resourceSpawns)
          ? area.resourceSpawns.map((spawn) => copyResourceSpawn(spawn))
          : [];
        this.resourceSpawnsByArea.set(area.areaId, spawns);
        all.push(...spawns);
      }
      this.resourceSpawns = all;
      return;
    }
    if (Array.isArray(output.resourceSpawns)) {
      this.resourceSpawns = output.resourceSpawns.map((spawn) => copyResourceSpawn(spawn));
    }
  }

  private syncRustPlacedExtractors(output: { placedExtractors?: PlacedExtractorVM[] | null }): void {
    if (!Array.isArray(output.placedExtractors)) return;
    this.placedExtractorsByArea.clear();
    this.lastRustAuthorityPlacedExtractors = output.placedExtractors.map((extractor) => ({
      ...extractor,
      ownerActorId: extractor.ownerActorId
        ? this.typescriptActorIdForRustPlaceholder(extractor.ownerActorId)
        : null,
    }));
    for (const extractor of this.lastRustAuthorityPlacedExtractors) {
      const areaRows = this.placedExtractorsByArea.get(extractor.areaId) ?? [];
      areaRows.push({ ...extractor });
      this.placedExtractorsByArea.set(extractor.areaId, areaRows);
    }
  }

  private syncRustPlacedCamps(output: { placedCamps?: PlacedCampVM[] | null }): void {
    if (!Array.isArray(output.placedCamps)) return;
    this.placedCampsByArea.clear();
    this.lastRustAuthorityPlacedCamps = output.placedCamps.map((camp) => ({
      ...camp,
      ownerActorId: camp.ownerActorId
        ? this.typescriptActorIdForRustPlaceholder(camp.ownerActorId)
        : null,
    }));
    for (const camp of this.lastRustAuthorityPlacedCamps) {
      const areaRows = this.placedCampsByArea.get(camp.areaId) ?? [];
      areaRows.push({ ...camp });
      this.placedCampsByArea.set(camp.areaId, areaRows);
    }
  }

  private syncRustPlacedParcels(output: { placedParcels?: ParcelVM[] | null }): void {
    if (!Array.isArray(output.placedParcels)) return;
    this.placedParcelsByArea.clear();
    this.lastRustAuthorityPlacedParcels = output.placedParcels.map((parcel) => ({
      ...parcel,
      ownerActorId: parcel.ownerActorId
        ? this.typescriptActorIdForRustPlaceholder(parcel.ownerActorId)
        : null,
    }));
    for (const parcel of this.lastRustAuthorityPlacedParcels) {
      const areaRows = this.placedParcelsByArea.get(parcel.areaId) ?? [];
      areaRows.push({ ...parcel });
      this.placedParcelsByArea.set(parcel.areaId, areaRows);
    }
  }

  private syncRustFarmPlots(output: { farmPlots?: FarmPlotVM[] | null }): void {
    if (!Array.isArray(output.farmPlots)) return;
    this.farmPlotsByArea.clear();
    this.lastRustAuthorityFarmPlots = output.farmPlots.map((plot) => ({
      ...plot,
      ownerActorId: plot.ownerActorId
        ? this.typescriptActorIdForRustPlaceholder(plot.ownerActorId)
        : null,
    }));
    for (const plot of this.lastRustAuthorityFarmPlots) {
      const areaRows = this.farmPlotsByArea.get(plot.areaId) ?? [];
      areaRows.push({ ...plot, tiles: plot.tiles.map((t) => ({ ...t })) });
      this.farmPlotsByArea.set(plot.areaId, areaRows);
    }
  }

  private syncRustBuilding(output: { building?: RustAuthorityBuildDeltaPayload | null }): void {
    if (!output.building || output.building.schema !== "successor.authority-building.v1") return;
    this.lastRustAuthorityBuilding = {
      schema: "successor.authority-building.v1",
      tick: output.building.tick,
      components: output.building.components.map((component) => ({
        ...component,
        ownerActorId: this.typescriptActorIdForRustPlaceholder(component.ownerActorId),
        palette: { ...component.palette },
      })),
      interiors: output.building.interiors.map((interior) => ({
        ...interior,
        cellKeys: [...interior.cellKeys],
        doorComponentIds: [...interior.doorComponentIds],
      })),
    };
  }

  private syncRustDraftedSchematics(output: { draftedSchematics?: GameDraftedSchematic[] | null }): void {
    if (!Array.isArray(output.draftedSchematics)) return;
    this.lastRustAuthorityDraftedSchematics = output.draftedSchematics.map((schematic) => ({
      ...schematic,
      ownerActorId: this.typescriptActorIdForRustPlaceholder(schematic.ownerActorId),
      resourceLocks: schematic.resourceLocks.map((lock) => ({ ...lock })),
    }));
  }

  private syncRustGroupViews(output: { groupViewsByActorId?: Record<string, GameGroupView> | null; guildViewsByActorId?: Record<string, GameGuildView> | null }): void {
    this.syncRustGuildViews(output);
    if (!output.groupViewsByActorId || typeof output.groupViewsByActorId !== "object") return;
    const next = new Map<string, GameGroupView>();
    for (const [rustActorId, view] of Object.entries(output.groupViewsByActorId)) {
      next.set(this.typescriptActorIdForRustPlaceholder(rustActorId), this.typescriptGroupView(view));
    }
    if (sameGroupViewMap(this.lastRustAuthorityGroupViewsByActorId, next)) return;
    const changedActorIds = uniqueActorIds([
      ...this.lastRustAuthorityGroupViewsByActorId.keys(),
      ...next.keys(),
    ]);
    this.lastRustAuthorityGroupViewsByActorId = next;
    this.markDetailDirty(...changedActorIds);
  }

  private typescriptGroupView(view: GameGroupView): GameGroupView {
    const leaderActorId = view.group ? this.typescriptActorIdForRustPlaceholder(view.group.leaderActorId) : "";
    const group = view.group
      ? {
        ...view.group,
        leaderActorId,
        memberActorIds: view.group.memberActorIds
          .map((actorId) => this.typescriptActorIdForRustPlaceholder(actorId))
          .sort((left, right) => compareGroupMemberActorIds(left, right, leaderActorId)),
      }
      : undefined;
    const pendingInvite = view.pendingInvite
      ? {
        ...view.pendingInvite,
        inviterActorId: this.typescriptActorIdForRustPlaceholder(view.pendingInvite.inviterActorId),
      }
      : undefined;
    const members = (view.members ?? [])
      .map((member) => ({
        ...member,
        actorId: this.typescriptActorIdForRustPlaceholder(member.actorId),
        vitals: { ...member.vitals },
        maxVitals: { ...member.maxVitals },
      }))
      .sort((left, right) => compareGroupMemberActorIds(left.actorId, right.actorId, leaderActorId));
    return {
      ...(group ? { group } : {}),
      members,
      ...(pendingInvite ? { pendingInvite } : {}),
    };
  }

  private groupViewForActor(actorId: string): GameGroupView {
    return cloneGameGroupView(this.lastRustAuthorityGroupViewsByActorId.get(actorId));
  }

  private syncRustGuildViews(output: { guildViewsByActorId?: Record<string, GameGuildView> | null }): void {
    if (!output.guildViewsByActorId || typeof output.guildViewsByActorId !== "object") return;
    const next = new Map<string, GameGuildView>();
    for (const [rustActorId, view] of Object.entries(output.guildViewsByActorId)) {
      next.set(this.typescriptActorIdForRustPlaceholder(rustActorId), {
        ...(view.guild ? {
          guild: {
            ...view.guild,
            leaderActorId: this.typescriptActorIdForRustPlaceholder(view.guild.leaderActorId),
          },
        } : {}),
        roster: (view.roster ?? []).map((member) => ({
          ...member,
          actorId: this.typescriptActorIdForRustPlaceholder(member.actorId),
          areaId: member.online ? member.areaId : null,
        })),
        pendingInvites: (view.pendingInvites ?? []).map((invite) => ({
          ...invite,
          inviterActorId: this.typescriptActorIdForRustPlaceholder(invite.inviterActorId),
        })),
        directory: (view.directory ?? []).map((entry) => ({ ...entry })),
      });
    }
    const changedActorIds = uniqueActorIds([
      ...this.lastRustAuthorityGuildViewsByActorId.keys(),
      ...next.keys(),
    ]);
    if (sameGuildViewMap(this.lastRustAuthorityGuildViewsByActorId, next)) return;
    this.lastRustAuthorityGuildViewsByActorId = next;
    this.markDetailDirty(...changedActorIds);
  }

  private guildViewForActor(actorId: string): GameGuildView {
    return cloneGameGuildView(this.lastRustAuthorityGuildViewsByActorId.get(actorId));
  }

  private syncRustDuelViews(output: { duelViewsByActorId?: Record<string, GameDuelView> | null }): void {
    if (!output.duelViewsByActorId || typeof output.duelViewsByActorId !== "object") return;
    const next = new Map<string, GameDuelView>();
    for (const [rustActorId, view] of Object.entries(output.duelViewsByActorId)) {
      next.set(this.typescriptActorIdForRustPlaceholder(rustActorId), this.typescriptDuelView(view));
    }
    if (sameDuelViewMap(this.lastRustAuthorityDuelViewsByActorId, next)) return;
    const changedActorIds = uniqueActorIds([
      ...this.lastRustAuthorityDuelViewsByActorId.keys(),
      ...next.keys(),
    ]);
    this.lastRustAuthorityDuelViewsByActorId = next;
    this.markDetailDirty(...changedActorIds);
  }

  private typescriptDuelView(view: GameDuelView): GameDuelView {
    const activeDuel = view.activeDuel
      ? { ...view.activeDuel, opponentActorId: this.typescriptActorIdForRustPlaceholder(view.activeDuel.opponentActorId) }
      : undefined;
    const incomingChallenge = view.incomingChallenge
      ? { ...view.incomingChallenge, otherActorId: this.typescriptActorIdForRustPlaceholder(view.incomingChallenge.otherActorId) }
      : undefined;
    const outgoingChallenge = view.outgoingChallenge
      ? { ...view.outgoingChallenge, otherActorId: this.typescriptActorIdForRustPlaceholder(view.outgoingChallenge.otherActorId) }
      : undefined;
    return {
      ...(activeDuel ? { activeDuel } : {}),
      ...(incomingChallenge ? { incomingChallenge } : {}),
      ...(outgoingChallenge ? { outgoingChallenge } : {}),
    };
  }

  private duelViewForActor(actorId: string): GameDuelView {
    return cloneGameDuelView(this.lastRustAuthorityDuelViewsByActorId.get(actorId));
  }

  private groupViewsSnapshot(): Record<string, GameGroupView> {
    return Object.fromEntries(
      [...this.lastRustAuthorityGroupViewsByActorId.entries()].map(([actorId, view]) => [actorId, cloneGameGroupView(view)]),
    );
  }

  private draftedSchematicsForActor(actorId: string): GameDraftedSchematic[] {
    return this.lastRustAuthorityDraftedSchematics
      .filter((schematic) => schematic.ownerActorId === actorId)
      .map((schematic) => ({
        ...schematic,
        resourceLocks: schematic.resourceLocks.map((lock) => ({ ...lock })),
      }));
  }

  /**
   * Extractor projection — same law as projectPlacedCamp, applied to
   * ExtractorFE's landed surface under Main's oracle-hardening ruling:
   * ownerActorId never leaves the shard; the observer-less oracle path reads
   * as a stranger. Yield/battery telemetry stays — sessions already get it.
   */
  private projectPlacedExtractor(extractor: PlacedExtractorVM, observerActorId: string | null): PlacedExtractorVM {
    const { ownerActorId, ...visible } = extractor;
    return {
      ...visible,
      isOwner: observerActorId !== null
        && (ownerActorId ? ownerActorId === observerActorId : extractor.isOwner),
    };
  }

  private placedExtractorsForArea(areaId: string, observerActorId: string): PlacedExtractorVM[] {
    return (this.placedExtractorsByArea.get(areaId) ?? [])
      .map((extractor) => this.projectPlacedExtractor(extractor, observerActorId));
  }

  /**
   * Camp projection — the ONLY shape camp rows leave the shard in, for
   * per-session forwards AND the debug oracle: `ownerActorId` stays inside,
   * `isOwner` is recomputed for the observer (always false when there is
   * none), and the armed-abandonment countdown is the OWNER's HUD hint only —
   * strangers see the tent, not its clock. The observer-less oracle path
   * exists because /game/debug/oracle is unauthenticated + CORS `*`: debug
   * surfaces must never carry fields a live session is denied (day-2 P1-4).
   */
  private projectPlacedCamp(camp: PlacedCampVM, observerActorId: string | null): PlacedCampVM {
    const { ownerActorId, abandonSecondsRemaining, ...visible } = camp;
    const isOwner = observerActorId !== null
      && (ownerActorId ? ownerActorId === observerActorId : camp.isOwner);
    return {
      ...visible,
      isOwner,
      ...(isOwner && abandonSecondsRemaining !== undefined && abandonSecondsRemaining !== null
        ? { abandonSecondsRemaining }
        : {}),
    };
  }

  private placedCampsForArea(areaId: string, observerActorId: string): PlacedCampVM[] {
    return (this.placedCampsByArea.get(areaId) ?? [])
      .map((camp) => this.projectPlacedCamp(camp, observerActorId));
  }

  /**
   * Parcel projection — the ONLY shape parcel rows leave the shard in (per-session
   * forwards AND the observer-less debug oracle): `ownerActorId` stays inside,
   * `isOwner` is recomputed for the observer (false when there is none), and
   * `upkeepDueInGameDays` (owner finance HUD hint) is stripped from strangers, per
   * Main's DEF-9 ruling and the day-2 P1-4 oracle-hardening law.
   */
  private projectParcel(parcel: ParcelVM, observerActorId: string | null): ParcelVM {
    const { ownerActorId, upkeepDueInGameDays, ...visible } = parcel;
    const isOwner = observerActorId !== null
      && (ownerActorId ? ownerActorId === observerActorId : parcel.isOwner);
    return {
      ...visible,
      isOwner,
      ...(isOwner && upkeepDueInGameDays !== undefined && upkeepDueInGameDays !== null
        ? { upkeepDueInGameDays }
        : {}),
    };
  }

  private placedParcelsForArea(areaId: string, observerActorId: string): ParcelVM[] {
    return (this.placedParcelsByArea.get(areaId) ?? [])
      .map((parcel) => this.projectParcel(parcel, observerActorId));
  }

  private buildingForArea(areaId: string): GameBuildingProjection {
    return {
      schema: "successor.authority-building.v1",
      tick: this.lastRustAuthorityBuilding.tick,
      components: this.lastRustAuthorityBuilding.components
        .filter((component) => component.areaId === areaId)
        .map((component) => ({ ...component, palette: { ...component.palette } })),
      interiors: this.lastRustAuthorityBuilding.interiors
        .filter((interior) => interior.areaId === areaId)
        .map((interior) => ({
          ...interior,
          cellKeys: [...interior.cellKeys],
          doorComponentIds: [...interior.doorComponentIds],
        })),
    };
  }

  /**
   * Farm-plot projection — crop render state is world-visible; `legalVerbs` are
   * blanked for non-owners (a passer-by sees the crop, not its actions) and for the
   * observer-less oracle path. `ownerActorId` never leaves the shard.
   */
  private projectFarmPlot(plot: FarmPlotVM, observerActorId: string | null): FarmPlotVM {
    const { ownerActorId, ...visible } = plot;
    const isOwner = observerActorId !== null
      && ownerActorId !== null
      && ownerActorId !== undefined
      && ownerActorId === observerActorId;
    return {
      ...visible,
      tiles: visible.tiles.map((tile) => ({
        ...tile,
        legalVerbs: isOwner ? tile.legalVerbs : [],
      })),
    };
  }

  private farmPlotsForArea(areaId: string, observerActorId: string): FarmPlotVM[] {
    return (this.farmPlotsByArea.get(areaId) ?? [])
      .map((plot) => this.projectFarmPlot(plot, observerActorId));
  }

  private resourceSpawnsForArea(areaId: string): GameResourceSpawn[] {
    const byArea = this.resourceSpawnsByArea.get(areaId);
    if (byArea) return byArea.map((spawn) => copyResourceSpawn(spawn));
    const prefix = `${areaId}:`;
    return this.resourceSpawns
      .filter((spawn) => spawn.spawnId.startsWith(prefix))
      .map((spawn) => copyResourceSpawn(spawn));
  }

  private actorCountForArea(areaId: string): number {
    let count = 0;
    for (const actor of this.actors.values()) {
      if (actor.areaId === areaId) count += 1;
    }
    return count;
  }

  private clearRustProjectedWorldState(): void {
    this.lastRustAuthorityPlacedExtractors = [];
    this.lastRustAuthorityPlacedCamps = [];
    this.lastRustAuthorityPlacedParcels = [];
    this.lastRustAuthorityFarmPlots = [];
    this.lastRustAuthorityDraftedSchematics = [];
    this.lastRustAuthorityGroupViewsByActorId.clear();
    this.lastRustAuthorityGuildViewsByActorId.clear();
    this.lastRustAuthorityDuelViewsByActorId.clear();
    this.lastRustAuthorityBankByActorId.clear();
    this.lastRustAuthorityPlayerCorpses = [];
    this.placedExtractorsByArea.clear();
    this.placedCampsByArea.clear();
    this.placedParcelsByArea.clear();
    this.farmPlotsByArea.clear();
  }

  private syncRustBankProjection(
    bank: RustAuthorityBankSnapshot | null | undefined,
    fallbackActorId?: string,
  ): void {
    if (!bank) return;
    const actorId = bank.actorId
      ? this.typescriptActorIdForRustPlaceholder(bank.actorId)
      : fallbackActorId;
    if (!actorId || !this.actors.has(actorId)) return;
    const snapshot: GameBankSnapshot = {
      credits: Number.isFinite(bank.bankCredits) ? Math.max(0, Math.trunc(bank.bankCredits)) : 0,
      items: (bank.items ?? []).map((row) => ({
        ...row,
        stackId: String(row.stackId),
        container: this.typescriptInventoryContainerForRustContainer(row.container),
      })),
      backupPresent: bank.backupPresent === true,
      backupSavedTick: typeof bank.backupSavedTick === "number" && Number.isFinite(bank.backupSavedTick)
        ? Math.trunc(bank.backupSavedTick)
        : null,
      backupSkillCount: Number.isFinite(bank.backupSkillCount) ? Math.max(0, Math.trunc(bank.backupSkillCount)) : 0,
      backupCost: Number.isFinite(bank.backupCost) ? Math.max(0, Math.trunc(bank.backupCost)) : 1_000,
    };
    this.lastRustAuthorityBankByActorId.set(actorId, snapshot);
    this.markDetailDirty(actorId);
  }

  private syncRustPlayerCorpses(corpses: RustAuthorityPlayerCorpseSnapshot[] | null | undefined): void {
    if (!Array.isArray(corpses)) return;
    this.lastRustAuthorityPlayerCorpses = corpses.map((corpse) => ({
      id: String(corpse.id),
      ownerActorId: this.typescriptActorIdForRustPlaceholder(String(corpse.ownerActorId)),
      ownerLabel: String(corpse.ownerLabel),
      areaId: String(corpse.areaId),
      cellX: Math.trunc(corpse.cell.x),
      cellY: Math.trunc(corpse.cell.y),
      x: corpse.position.x / milliCellsPerCell,
      y: corpse.position.y / milliCellsPerCell,
      expiryTick: Math.trunc(corpse.expiryTick),
      hasItems: corpse.hasItems === true,
      creditsPresent: corpse.creditsPresent === true,
      creditsCount: Number.isFinite(corpse.creditsCount) ? Math.max(0, Math.trunc(corpse.creditsCount)) : 0,
      isOwner: corpse.isOwner === true,
      container: String(corpse.container || `corpse:${corpse.id}`),
    }));
    for (const actor of this.actors.values()) this.markDetailDirty(actor.id);
  }

  private bankForActor(actorId: string): GameBankSnapshot | null {
    const bank = this.lastRustAuthorityBankByActorId.get(actorId);
    if (!bank) return null;
    return {
      ...bank,
      items: bank.items.map((row) => ({
        ...row,
        metadata: row.metadata ? cloneInventoryMetadata(row.metadata) : undefined,
        colors: row.colors ? [...row.colors] : undefined,
      })),
    };
  }

  private playerCorpsesForObserver(observer: AuthorityActor, session?: GameSession, center = observer): GamePlayerCorpseSnapshot[] {
    const view = session?.viewInterest;
    const halfWidth = (view?.viewportWidthCells ?? this.areaInterestRadiusCells) / 2 + (view?.marginCells ?? 0) + warmInterestMarginCells;
    const halfHeight = (view?.viewportHeightCells ?? this.areaInterestRadiusCells) / 2 + (view?.marginCells ?? 0) + warmInterestMarginCells;
    return this.lastRustAuthorityPlayerCorpses
      .filter((corpse) => corpse.areaId === center.areaId)
      .filter((corpse) => Math.abs(corpse.x - center.x) <= halfWidth && Math.abs(corpse.y - center.y) <= halfHeight)
      .map((corpse) => ({
        id: corpse.id,
        ownerLabel: corpse.ownerLabel,
        areaId: corpse.areaId,
        cellX: corpse.cellX,
        cellY: corpse.cellY,
        x: corpse.x,
        y: corpse.y,
        expiryTick: corpse.expiryTick,
        hasItems: corpse.hasItems,
        creditsPresent: corpse.creditsPresent,
        creditsCount: corpse.creditsCount,
        isOwner: corpse.ownerActorId === observer.id,
        container: corpse.container,
      }));
  }

  private syncRustInventory(
    inventory: RustAuthorityInventorySnapshot[] | null | undefined,
    reservations: RustAuthorityReservationSnapshot[] | null | undefined,
    timelineEvents?: RustAuthorityTimelineEventSnapshot[] | null,
    complete = true,
  ): void {
    if (Array.isArray(inventory)) {
      const previousInventory = this.inventory;
      this.inventory = inventory.map((row) => normalizeInventoryRowForStream({
        ...row,
        container: this.typescriptInventoryContainerForRustContainer(row.container),
      }));
      this.mergeTravelTicketRowsIntoInventory();
      this.syncRustClothingProjection(this.inventory, complete);
      if (!sameInventoryRowList(previousInventory, this.inventory)) this.dirty = true;
    }
    if (Array.isArray(reservations)) {
      const nextReservations = reservations.map((row) => ({
        ...row,
        actor: this.typescriptActorIdForRustPlaceholder(row.actor),
        from: this.typescriptInventoryContainerForRustContainer(row.from),
      }));
      if (!sameReservationRowList(this.reservations, nextReservations)) this.dirty = true;
      this.reservations = nextReservations;
    }
    if (Array.isArray(timelineEvents)) {
      this.timelineEvents = timelineEvents
        .slice(-rustAuthorityTimelineEventCapacity)
        .map((row) => ({
          ...row,
          label: this.typescriptTimelineLabelForRustLabel(row.label),
        }));
    }
  }
  private syncRustClothingProjection(
    _rows: readonly RustAuthorityInventorySnapshot[],
    _complete = false,
  ): void {
    // Inventory rows are not equipment authority. Rust actor snapshots carry
    // the authoritative worn set and per-piece colors; projecting rows here
    // could clear that set when equipped metadata is omitted.
  }

  private mergeTravelTicketRowsIntoInventory(): void {
    const rustRows = this.inventory.filter((row) => row.itemKey !== travelTicketItemKey && row.itemId !== travelTicketNumericItemId);
    const ticketRows = [...this.travelTicketRows.values()]
      .map((row) => ({ ...row, metadata: cloneInventoryMetadata(row.metadata) }))
      .sort((left, right) => left.container.localeCompare(right.container) || left.stackId - right.stackId);
    this.inventory = [...rustRows, ...ticketRows];
  }

  private typescriptInventoryContainerForRustContainer(container: string): string {
    for (const [actorId, rustActorId] of this.claimedAuthoredPlaceholders) {
      const mapped = replaceContainerActorId(container, rustActorId, actorId);
      if (mapped !== container) return mapped;
    }
    return container;
  }

  private rustInventoryContainerForTypescriptContainer(container: string): string {
    for (const [actorId, rustActorId] of this.claimedAuthoredPlaceholders) {
      const mapped = replaceContainerActorId(container, actorId, rustActorId);
      if (mapped !== container) return mapped;
    }
    return container;
  }

  private rustEnvelopeForCommand(envelope: ClientCommandEnvelope): ClientCommandEnvelope {
    const command = envelope.command;
    const [commandKind, rawPayload] = Object.entries(command)[0] ?? [];
    if (
      commandKind
      && rawPayload
      && typeof rawPayload === "object"
      && "target_actor_id" in rawPayload
      && typeof rawPayload.target_actor_id === "string"
    ) {
      const target_actor_id = this.rustActorIdFor(rawPayload.target_actor_id);
      if (target_actor_id === rawPayload.target_actor_id) return envelope;
      return {
        ...envelope,
        command: {
          [commandKind]: {
            ...rawPayload,
            target_actor_id,
          },
        } as ClientCommandEnvelope["command"],
      };
    }
    if ("SetEquippedClothing" in command) {
      const clothing = command.SetEquippedClothing;
      const sourceContainer = clothing.container;
      if (sourceContainer === undefined) return envelope;
      const container = this.rustInventoryContainerForTypescriptContainer(sourceContainer);
      if (container === sourceContainer) return envelope;
      return {
        ...envelope,
        command: {
          SetEquippedClothing: {
            ...clothing,
            container,
          },
        },
      };
    }
    if ("DiscardStack" in command) {
      const discard = command.DiscardStack;
      const container = this.rustInventoryContainerForTypescriptContainer(discard.container);
      if (container === discard.container) return envelope;
      return {
        ...envelope,
        command: {
          DiscardStack: {
            ...discard,
            container,
          },
        },
      };
    }
    if ("SplitStack" in command) {
      const split = command.SplitStack;
      const container = this.rustInventoryContainerForTypescriptContainer(split.container);
      if (container === split.container) return envelope;
      return {
        ...envelope,
        command: {
          SplitStack: {
            ...split,
            container,
          },
        },
      };
    }
    if ("MergeStacks" in command) {
      const merge = command.MergeStacks;
      const container = this.rustInventoryContainerForTypescriptContainer(merge.container);
      if (container === merge.container) return envelope;
      return {
        ...envelope,
        command: {
          MergeStacks: {
            ...merge,
            container,
          },
        },
      };
    }
    if ("RedeemCreditChip" in command) {
      const redeem = command.RedeemCreditChip;
      const container = this.rustInventoryContainerForTypescriptContainer(redeem.container);
      if (container === redeem.container) return envelope;
      return {
        ...envelope,
        command: {
          RedeemCreditChip: {
            ...redeem,
            container,
          },
        },
      };
    }
    if ("CraftAssignSlot" in command) {
      const slot = command.CraftAssignSlot;
      const container = this.rustInventoryContainerForTypescriptContainer(slot.container);
      if (container === slot.container) return envelope;
      return {
        ...envelope,
        command: {
          CraftAssignSlot: {
            ...slot,
            container,
          },
        },
      };
    }
    if ("InsertBattery" in command) {
      const battery = command.InsertBattery;
      const container = this.rustInventoryContainerForTypescriptContainer(battery.container);
      if (container === battery.container) return envelope;
      return {
        ...envelope,
        command: {
          InsertBattery: {
            ...battery,
            container,
          },
        },
      };
    }
    if ("TakeLootItem" in command) {
      const loot = command.TakeLootItem;
      const container = this.rustInventoryContainerForTypescriptContainer(loot.container);
      if (container === loot.container) return envelope;
      return {
        ...envelope,
        command: {
          TakeLootItem: {
            ...loot,
            container,
          },
        },
      };
    }
    if ("PlantSeed" in command) {
      const seed = command.PlantSeed;
      const container = this.rustInventoryContainerForTypescriptContainer(seed.container);
      if (container === seed.container) return envelope;
      return {
        ...envelope,
        command: {
          PlantSeed: {
            ...seed,
            container,
          },
        },
      };
    }
    if ("Fertilize" in command) {
      // W4 Fertilize carries an inventory container (the fertilizer stack), like
      // PlantSeed — remap the claimed-placeholder container to its rust prefix.
      const fert = command.Fertilize;
      const container = this.rustInventoryContainerForTypescriptContainer(fert.container);
      if (container === fert.container) return envelope;
      return {
        ...envelope,
        command: {
          Fertilize: {
            ...fert,
            container,
          },
        },
      };
    }
    // BioECore commands (ScanGenome/SpliceAssignSlot) carry the same
    // {container, stack_id, variant_id} seed/sample shape; their container is a
    // claimed-placeholder inventory ref and needs the same rust-prefix mapping.
    if ("ScanGenome" in command) {
      const scan = command.ScanGenome;
      const container = this.rustInventoryContainerForTypescriptContainer(scan.container);
      if (container === scan.container) return envelope;
      return {
        ...envelope,
        command: {
          ScanGenome: {
            ...scan,
            container,
          },
        },
      };
    }
    if ("SpliceAssignSlot" in command) {
      const splice = command.SpliceAssignSlot;
      const container = this.rustInventoryContainerForTypescriptContainer(splice.container);
      if (container === splice.container) return envelope;
      return {
        ...envelope,
        command: {
          SpliceAssignSlot: {
            ...splice,
            container,
          },
        },
      };
    }
    if ("ProposeTrade" in command) {
      // The partner id is a TS actor id; claimed-placeholder sessions live under a
      // different rust id, so map it or apply_propose_trade misses self.actors -> target_unavailable.
      const propose = command.ProposeTrade;
      const partner_actor_id = this.rustActorIdFor(propose.partner_actor_id);
      if (partner_actor_id === propose.partner_actor_id) return envelope;
      return {
        ...envelope,
        command: { ProposeTrade: { ...propose, partner_actor_id } },
      };
    }
    return envelope;
  }

  private typescriptActorIdForRustPlaceholder(rustActorId: string): string {
    for (const [actorId, placeholderId] of this.claimedAuthoredPlaceholders) {
      if (rustActorId === placeholderId) return actorId;
    }
    return rustActorId;
  }

  private typescriptCombatQueueForRustQueue(
    queue: RustAuthorityActorSnapshot["combatQueue"],
  ): GameActorCombatQueueSnapshot | undefined {
    const cloned = cloneActorCombatQueue(queue);
    if (!cloned) return undefined;
    return {
      ...cloned,
      entries: cloned.entries.map((entry) => ({
        ...entry,
        targetActorId: this.typescriptActorIdForRustPlaceholder(entry.targetActorId),
      })),
    };
  }

  private typescriptAbilityQueueEntry(
    entry: AbilityQueueView["entries"][number],
  ): AbilityQueueView["entries"][number] {
    return {
      ...entry,
      targetActorId: entry.targetActorId ? this.typescriptActorIdForRustPlaceholder(entry.targetActorId) : undefined,
    };
  }

  private typescriptAbilityQueueForRustQueue(
    queue: RustAuthorityActorSnapshot["abilityQueue"],
  ): AbilityQueueView | null {
    if (!queue) return null;
    return {
      actorId: this.typescriptActorIdForRustPlaceholder(queue.actorId),
      nextReadyTick: finiteInteger(queue.nextReadyTick, 0),
      entries: queue.entries.map((entry) => this.typescriptAbilityQueueEntry(entry)),
      repeatIntent: queue.repeatIntent
        ? this.typescriptAbilityQueueEntry(queue.repeatIntent)
        : undefined,
    };
  }

  private actorSnapshotForObserver(observerActorId: string, actor: AuthorityActor): GameActorSnapshot {
    const snapshot = actorSnapshot(actor);
    if (actor.id !== observerActorId) {
      delete snapshot.combatQueue;
      delete snapshot.nextSampleTick;
    }
    return snapshot;
  }

  private abilityQueueForActor(actorId: string): AbilityQueueView | null {
    return cloneAbilityQueueView(this.actors.get(actorId)?.abilityQueue);
  }

  private abilityQueueForSession(session: GameSession): AbilityQueueView | null {
    return this.abilityQueueForActor(session.actorId);
  }

  private typescriptTimelineLabelForRustLabel(label: string): string {
    let next = label;
    for (const [actorId, rustActorId] of this.claimedAuthoredPlaceholders) {
      next = next.replaceAll(rustActorId, actorId);
    }
    return next;
  }

  private applyRustActorSnapshot(actorId: string, snapshot: RustAuthorityActorSnapshot): void {
    // Snapshot entities are untrusted bridge data. Authored placeholders require
    // an explicit durable owner map. Direct actors additionally require the
    // canonical Rust id/entity pair, player role, and a durable-store record.
    const snapshotCharacterId = this.authoredPlaceholderOwners.get(snapshot.id)
      ?? this.durableCharacterIdFromDirectRustActorSnapshot(actorId, snapshot);
    const snapshotLinkDead = snapshot.link_dead ?? snapshot.linkDead;
    const forceLinkDeadRebroadcast = snapshotLinkDead === false
      && this.pendingLinkDeadRebroadcastActorIds.delete(actorId);
    if (snapshotLinkDead === true) this.rustAuthorityLinkDeadActorIds.add(snapshot.id);
    else if (snapshotLinkDead === false) this.rustAuthorityLinkDeadActorIds.delete(snapshot.id);
    let actor = this.actors.get(actorId);
    const nextDirection = normalizeDirection(snapshot.direction);
    if (!actor) {
      actor = createActor(
        actorId,
        normalizeDisplayName(snapshot.label ?? actorId, actorId),
        snapshot.areaId,
        { x: snapshot.x, y: snapshot.y },
        nextDirection,
        [],
        {
          displayName: snapshot.display_name ?? snapshot.displayName,
          characterId: snapshotCharacterId,
          linkDead: snapshot.link_dead ?? snapshot.linkDead,
          appearance: normalizeRustActorAppearance(snapshot),
          role: snapshot.role,
          sprite: snapshot.sprite,
          scale: snapshot.scale,
          templateId: snapshot.templateId,
          spawnZoneId: snapshot.spawnZoneId,
          factionId: snapshot.factionId,
          socialGroup: snapshot.socialGroup,
          pvpStatus: snapshot.pvpStatus,
          aiAttitude: snapshot.aiAttitude,
          willAutoAggro: snapshot.willAutoAggro,
          playerOrganizationId: snapshot.playerOrganizationId,
          playerOrganizationTag: snapshot.playerOrganizationTag,
          vitals: snapshot.vitals,
          maxVitals: snapshot.maxVitals,
          engagementTargetId: snapshot.engagementTargetId,
        },
      );
      this.actors.set(actor.id, actor);
      this.actorNetId(actor.id);
      this.invalidateActorSpatialIndex();
      this.markStatusDirty(actor.id);
    }
    const nextPosture = normalizeActorPosture(snapshot.posture);
    const nextPostureUntilTick = finiteInteger(snapshot.postureUntilTick, actor.postureUntilTick ?? 0);
    const nextLifeState = rustLifeState(snapshot.lifeState);
    const bleedRemainingMs = Math.round((snapshot.bleed.remainingTicks / this.tickRateHz) * 1000);
    const nextSleepRemainingMs = Math.round((snapshot.sleep.remainingTicks / this.tickRateHz) * 1000);
    const nextBodyVanishAtTick = typeof snapshot.bodyVanishTick === "number" && Number.isFinite(snapshot.bodyVanishTick)
      ? Math.trunc(snapshot.bodyVanishTick)
      : actor.bodyVanishAtTick;
    const nextLootable = typeof snapshot.lootable === "boolean" ? snapshot.lootable : actor.lootable;
    const nextHasLoot = typeof snapshot.hasLoot === "boolean" ? snapshot.hasLoot : actor.hasLoot;
    const rawLootRightsActorId = snapshot.lootRightsActorId === undefined
      ? actor.lootRightsActorId
      : normalizeNullableString(snapshot.lootRightsActorId);
    const nextLootRightsActorId = rawLootRightsActorId
      ? this.typescriptActorIdForRustPlaceholder(rawLootRightsActorId)
      : null;
    const nextRespawnAtTick = typeof snapshot.respawnTick === "number" && Number.isFinite(snapshot.respawnTick)
      ? Math.trunc(snapshot.respawnTick)
      : actor.respawnAtTick;
    const nextSampleTick = typeof snapshot.nextSampleTick === "number" && Number.isFinite(snapshot.nextSampleTick)
      ? Math.max(0, Math.trunc(snapshot.nextSampleTick))
      : 0;
    const nextCloneSicknessRemainingMs = typeof snapshot.cloneSicknessTicks === "number" && Number.isFinite(snapshot.cloneSicknessTicks)
      ? Math.round((Math.trunc(snapshot.cloneSicknessTicks) / this.tickRateHz) * 1000)
      : actor.cloneSicknessRemainingMs;
    const nextIncapRemainingMs = typeof snapshot.incapRemainingTicks === "number" && Number.isFinite(snapshot.incapRemainingTicks)
      ? Math.round((Math.trunc(snapshot.incapRemainingTicks) / this.tickRateHz) * 1000)
      : actor.incapRemainingMs;
    const nextIncapCount = typeof snapshot.incapCount === "number" && Number.isFinite(snapshot.incapCount)
      ? Math.trunc(snapshot.incapCount)
      : actor.incapCount;
    const nextIncapWindowMs = typeof snapshot.incapWindowTicks === "number" && Number.isFinite(snapshot.incapWindowTicks)
      ? Math.round((Math.trunc(snapshot.incapWindowTicks) / this.tickRateHz) * 1000)
      : actor.incapWindowMs;
    const incomingLifecycleSeq = positiveIntegerOr(snapshot.lifecycleSeq, actor.lifecycleSeq);
    const nextLifecycleSeq = Math.max(actor.lifecycleSeq, incomingLifecycleSeq);
    const nextBleedHealthRate = typeof snapshot.bleed.damagePerSecondMilli === "number" && Number.isFinite(snapshot.bleed.damagePerSecondMilli)
      ? snapshot.bleed.damagePerSecondMilli / 1000
      : snapshot.bleed.damagePerTick * this.tickRateHz;
    const nextBleedSeverity = snapshot.bleed.active
      ? Math.max(snapshot.bleed.stackCount, Math.round(nextBleedHealthRate * 10) / 10)
      : 0;
    const nextSuppressionPressure = typeof snapshot.suppression?.pressure === "number" && Number.isFinite(snapshot.suppression.pressure)
      ? snapshot.suppression.pressure
      : actor.suppression.pressure;
    const nextSuppressionSource = snapshot.suppression
      ? snapshot.suppression.source ? { ...snapshot.suppression.source } : null
      : actor.suppression.source;
    const nextMobility = normalizeActorMobility(snapshot.mobility);
    const nextPersonalShield = normalizeActorPersonalShield(snapshot.personalShield);
    const nextWeapon = snapshot.weapon === undefined ? actor.weapon : normalizeActorWeapon(snapshot.weapon);
    const nextFactionId = normalizeFactionId(snapshot.factionId);
    const nextSocialGroup = normalizeFactionId(snapshot.socialGroup);
    const nextPvpStatus = normalizeFactionPvpStatus(snapshot.pvpStatus);
    const nextAiAttitude = normalizeActorAiAttitude(snapshot.aiAttitude);
    const nextWillAutoAggro = snapshot.willAutoAggro === true;
    const nextPlayerOrganizationId = normalizeNullableString(snapshot.playerOrganizationId);
    const nextPlayerOrganizationTag = normalizeNullableString(snapshot.playerOrganizationTag);
    const nextLabel = normalizeDisplayName(snapshot.label ?? actor.label, actor.label);
    const nextDisplayName = normalizeDisplayName(snapshot.display_name ?? snapshot.displayName ?? nextLabel, nextLabel);
    // Descriptor is the actor descriptor; rust skips serializing it empty (players),
    // so an omitted field means unchanged (preserve), never force-clear.
    const nextDescriptor = snapshot.descriptor ?? actor.descriptor ?? "";
    const nextLinkDead = snapshot.link_dead ?? snapshot.linkDead ?? actor.linkDead;
    const nextAppearance = normalizeRustActorAppearance(snapshot, actor.appearance);
    const nextWorn = snapshot.worn === undefined
      ? actor.worn
      : normalizeActorWorn(snapshot.worn) ?? [];
    // Live AuthorityActorSnapshot omits wornColors. Explicit wornColors/worn_colors is a
    // full replace. Omitted map preserves durable unequipped palette keys and only upserts
    // colors for currently present worn pieces.
    const snapshotWornColorsRaw = (snapshot as { wornColors?: unknown; worn_colors?: unknown }).wornColors
      ?? (snapshot as { worn_colors?: unknown }).worn_colors;
    const hasExplicitWornColors = snapshotWornColorsRaw !== undefined
      && snapshotWornColorsRaw !== null
      && typeof snapshotWornColorsRaw === "object"
      && !Array.isArray(snapshotWornColorsRaw);
    let nextWornColors: Record<string, string[]>;
    if (hasExplicitWornColors) {
      nextWornColors = normalizeWornColorsMap(snapshotWornColorsRaw, nextWorn ?? []);
    } else if (snapshot.worn === undefined) {
      nextWornColors = actor.wornColors;
    } else {
      nextWornColors = cloneWornColors(actor.wornColors);
      for (const piece of nextWorn ?? []) {
        nextWornColors[piece.item] = [...piece.colors];
      }
    }
    const nextSprite = normalizeNullableString(snapshot.sprite);
    const nextRole = typeof snapshot.role === "string" && snapshot.role.length > 0 ? snapshot.role : actor.role;
    const nextTemplateId = normalizeNullableString(snapshot.templateId);
    const nextSpawnZoneId = normalizeNullableString(snapshot.spawnZoneId);
    const nextScale = normalizeActorScale(snapshot.scale ?? actor.scale);
    const nextStats = normalizeActorStats(snapshot.stats);
    // Delta convention (C3): an OMITTED field means unchanged; only an explicit empty
    // clears. The Rust actor snapshot skips serializing empty professions, so a sync whose
    // snapshot omits professions must PRESERVE the mirror — clobbering to undefined
    // silently zeroed a second concurrent session's earned XP (DEF-2).
    const nextProfessions = snapshot.professions === undefined
      ? actor.professions
      : normalizeActorProfessions(snapshot.professions);
    const nextSkillBoxIds = skillBoxIdsFromProfessionSnapshots(nextProfessions);
    const nextActiveTitle = normalizeActorProfessionTitle(snapshot.activeTitle);
    const nextActiveTitleId = nextActiveTitle?.id ?? null;
    const nextCareerGoalId = snapshot.careerGoal === undefined
      ? actor.careerGoalId ?? null
      : normalizeNullableString(snapshot.careerGoal?.id);
    // Omit-means-unchanged: live bridge snapshots always carry these when known, but
    // partial/link-dead replies must not zero a real profession loadout just because the
    // field was absent. Only an explicit number replaces the mirror.
    const rawSkillPointsUsed = (snapshot as { skillPointsUsed?: unknown; skill_points_used?: unknown }).skillPointsUsed
      ?? (snapshot as { skill_points_used?: unknown }).skill_points_used;
    const rawSkillPointsCap = (snapshot as { skillPointsCap?: unknown; skill_points_cap?: unknown }).skillPointsCap
      ?? (snapshot as { skill_points_cap?: unknown }).skill_points_cap;
    const nextSkillPointsUsed = rawSkillPointsUsed === undefined
      ? actor.skillPointsUsed
      : finiteInteger(rawSkillPointsUsed, actor.skillPointsUsed ?? 0);
    const nextSkillPointsCap = rawSkillPointsCap === undefined
      ? actor.skillPointsCap
      : finiteInteger(rawSkillPointsCap, actor.skillPointsCap ?? 0);
    const nextCredits = finiteInteger(snapshot.credits, actor.credits ?? 0);
    const nextShotSpreadDegreesMilli = finiteInteger(snapshot.shotSpreadDegreesMilli, actor.shotSpreadDegreesMilli ?? 0);
    const nextCombatQueue = this.typescriptCombatQueueForRustQueue(snapshot.combatQueue);
    const nextAbilityQueue = this.typescriptAbilityQueueForRustQueue(snapshot.abilityQueue);
    const nextInCombat = snapshot.inCombat === true;
    const nextPeaceRequested = snapshot.peaceRequested === true;
    const rawEngagementTargetId = normalizeNullableString(snapshot.engagementTargetId);
    const nextEngagementTargetId = rawEngagementTargetId
      ? this.typescriptActorIdForRustPlaceholder(rawEngagementTargetId)
      : null;
    const previousStatuses = actor.statuses.map((status) => ({ ...status }));
    const professionsChanged = JSON.stringify(actor.professions ?? []) !== JSON.stringify(nextProfessions);
    const skillBoxesChanged = JSON.stringify(actor.skillBoxIds ?? []) !== JSON.stringify(nextSkillBoxIds ?? []);
    const statsChanged = JSON.stringify(actor.stats ?? null) !== JSON.stringify(nextStats ?? null);
    const weaponChanged = !sameActorWeapon(actor.weapon, nextWeapon);
    const personalShieldChanged = !sameActorPersonalShield(actor.personalShield, nextPersonalShield);
    const combatQueueChanged = !sameActorCombatQueue(actor.combatQueue, nextCombatQueue);
    const abilityQueueChanged = !sameAbilityQueueView(actor.abilityQueue, nextAbilityQueue);
    const inCombatChanged = actor.inCombat !== nextInCombat;
    const peaceRequestedChanged = actor.peaceRequested !== nextPeaceRequested;
    const engagementTargetChanged = actor.engagementTargetId !== nextEngagementTargetId;
    const lootProjectionChanged = actor.lootable !== nextLootable
      || actor.hasLoot !== nextHasLoot
      || actor.lootRightsActorId !== nextLootRightsActorId;
    const wornChanged = !sameActorWorn(actor.worn, nextWorn);
    const wornColorsChanged = JSON.stringify(actor.wornColors ?? {}) !== JSON.stringify(nextWornColors ?? {});
    const identityProjectionChanged = forceLinkDeadRebroadcast
      || actor.displayName !== nextDisplayName
      || actor.linkDead !== nextLinkDead
      || !sameActorAppearance(actor.appearance, nextAppearance)
      || wornChanged
      || wornColorsChanged;
    const aiAttitudeChanged = actor.aiAttitude !== nextAiAttitude;
    const willAutoAggroChanged = actor.willAutoAggro !== nextWillAutoAggro;
    const titleChanged = !sameProfessionTitle(actor.activeTitle, nextActiveTitle)
      || actor.activeTitleId !== nextActiveTitleId;
    const shouldDirtyAoiProjection = actor.lifeState !== nextLifeState
      || actor.lifecycleSeq !== nextLifecycleSeq
      || actor.bodyVanishAtTick !== nextBodyVanishAtTick
      || actor.respawnAtTick !== nextRespawnAtTick
      || actor.incapRemainingMs !== nextIncapRemainingMs
      || actor.incapCount !== nextIncapCount
      || actor.incapWindowMs !== nextIncapWindowMs
      || identityProjectionChanged
      || lootProjectionChanged
      || nextLifeState !== "alive";
    const shouldDirtyDetailProjection = actor.label !== nextLabel
      || (actor.descriptor ?? "") !== nextDescriptor
      || identityProjectionChanged
      || actor.sprite !== nextSprite
      || actor.role !== nextRole
      || actor.templateId !== nextTemplateId
      || actor.spawnZoneId !== nextSpawnZoneId
      || actor.scale !== nextScale
      || actor.factionId !== nextFactionId
      || actor.socialGroup !== nextSocialGroup
      || actor.pvpStatus !== nextPvpStatus
      || actor.aiAttitude !== nextAiAttitude
      || actor.playerOrganizationId !== nextPlayerOrganizationId
      || actor.playerOrganizationTag !== nextPlayerOrganizationTag
      || actor.posture !== nextPosture
      || actor.postureUntilTick !== nextPostureUntilTick
      || statsChanged
      || professionsChanged
      || titleChanged
      || actor.careerGoalId !== nextCareerGoalId
      || skillBoxesChanged
      || actor.skillPointsUsed !== nextSkillPointsUsed
      || actor.skillPointsCap !== nextSkillPointsCap
      || actor.shotSpreadDegreesMilli !== nextShotSpreadDegreesMilli
      || actor.credits !== nextCredits
      || weaponChanged
      || personalShieldChanged
      || combatQueueChanged
      || abilityQueueChanged
      || inCombatChanged
      || peaceRequestedChanged
      || engagementTargetChanged
      || lootProjectionChanged
      || actor.nextSampleTick !== nextSampleTick
      || aiAttitudeChanged
      || willAutoAggroChanged;
    let changed = actor.areaId !== snapshot.areaId
      || actor.label !== nextLabel
      || identityProjectionChanged
      || actor.sprite !== nextSprite
      || actor.role !== nextRole
      || actor.templateId !== nextTemplateId
      || actor.spawnZoneId !== nextSpawnZoneId
      || actor.scale !== nextScale
      || actor.x !== snapshot.x
      || actor.y !== snapshot.y
      || actor.direction !== nextDirection
      || actor.posture !== nextPosture
      || actor.postureUntilTick !== nextPostureUntilTick
      || actor.lifeState !== nextLifeState
      || actor.lifecycleSeq !== nextLifecycleSeq
      || actor.vitals.health !== snapshot.vitals.health
      || actor.vitals.action !== snapshot.vitals.action
      || actor.vitals.spirit !== snapshot.vitals.spirit
      || actor.maxVitals.health !== snapshot.maxVitals.health
      || actor.maxVitals.action !== snapshot.maxVitals.action
      || actor.maxVitals.spirit !== snapshot.maxVitals.spirit
      || actor.bleed.active !== snapshot.bleed.active
      || actor.bleed.stackCount !== snapshot.bleed.stackCount
      || actor.bleed.severity !== nextBleedSeverity
      || actor.bleed.ratesPerSecond.health !== nextBleedHealthRate
      || actor.bleed.remainingMs !== bleedRemainingMs
      || actor.sleep.active !== snapshot.sleep.active
      || actor.sleep.stacks !== snapshot.sleep.stacks
      || actor.sleep.remainingMs !== nextSleepRemainingMs
      || actor.suppression.pressure !== nextSuppressionPressure
      || !sameOptionalCell(actor.suppression.source, nextSuppressionSource)
      || JSON.stringify(actor.mobility ?? null) !== JSON.stringify(nextMobility ?? null)
      || personalShieldChanged
      || weaponChanged
      || actor.bodyVanishAtTick !== nextBodyVanishAtTick
      || actor.respawnAtTick !== nextRespawnAtTick
      || actor.cloneSicknessRemainingMs !== nextCloneSicknessRemainingMs
      || actor.incapRemainingMs !== nextIncapRemainingMs
      || actor.nextSampleTick !== nextSampleTick
      || actor.incapCount !== nextIncapCount
      || actor.incapWindowMs !== nextIncapWindowMs
      || actor.factionId !== nextFactionId
      || actor.socialGroup !== nextSocialGroup
      || actor.pvpStatus !== nextPvpStatus
      || actor.aiAttitude !== nextAiAttitude
      || willAutoAggroChanged
      || actor.playerOrganizationId !== nextPlayerOrganizationId
      || actor.playerOrganizationTag !== nextPlayerOrganizationTag
      || statsChanged
      || professionsChanged
      || titleChanged
      || actor.careerGoalId !== nextCareerGoalId
      || skillBoxesChanged
      || actor.skillPointsUsed !== nextSkillPointsUsed
      || actor.skillPointsCap !== nextSkillPointsCap
      || actor.credits !== nextCredits
      || combatQueueChanged
      || abilityQueueChanged
      || inCombatChanged
      || engagementTargetChanged
      || lootProjectionChanged
      || peaceRequestedChanged;
    actor.areaId = snapshot.areaId;
    actor.label = nextLabel;
    actor.displayName = nextDisplayName;
    if (snapshotCharacterId) actor.characterId = snapshotCharacterId;
    actor.descriptor = nextDescriptor;
    actor.linkDead = nextLinkDead;
    actor.appearance = nextAppearance;
    actor.worn = nextWorn;
    actor.wornColors = nextWornColors;
    actor.sprite = nextSprite;
    actor.role = nextRole;
    actor.templateId = nextTemplateId;
    actor.spawnZoneId = nextSpawnZoneId;
    actor.scale = nextScale;
    actor.x = snapshot.x;
    actor.y = snapshot.y;
    actor.direction = nextDirection;
    actor.posture = nextPosture;
    actor.postureUntilTick = nextPostureUntilTick;
    actor.lifeState = nextLifeState;
    actor.lifecycleSeq = nextLifecycleSeq;
    actor.vitals = {
      health: snapshot.vitals.health,
      action: snapshot.vitals.action,
      spirit: snapshot.vitals.spirit,
    };
    actor.maxVitals = {
      health: snapshot.maxVitals.health,
      action: snapshot.maxVitals.action,
      spirit: snapshot.maxVitals.spirit,
    };
    actor.bleed = {
      active: snapshot.bleed.active,
      stackCount: snapshot.bleed.stackCount,
      severity: nextBleedSeverity,
      remainingMs: bleedRemainingMs,
      ratesPerSecond: {
        health: nextBleedHealthRate,
        action: 0,
        spirit: 0,
      },
      stacks: [],
    };
    actor.sleep = {
      active: snapshot.sleep.active,
      stacks: snapshot.sleep.stacks,
      remainingMs: nextSleepRemainingMs,
    };
    actor.suppression = {
      pressure: nextSuppressionPressure,
      source: nextSuppressionSource,
    };
    actor.mobility = nextMobility;
    actor.personalShield = nextPersonalShield;
    actor.weapon = nextWeapon;
    actor.bodyVanishAtTick = nextBodyVanishAtTick;
    actor.lootable = nextLootable;
    actor.hasLoot = nextHasLoot;
    actor.lootRightsActorId = nextLootRightsActorId;
    actor.respawnAtTick = nextRespawnAtTick;
    actor.nextSampleTick = nextSampleTick;
    actor.cloneSicknessRemainingMs = nextCloneSicknessRemainingMs;
    actor.incapRemainingMs = nextIncapRemainingMs;
    actor.incapCount = nextIncapCount;
    actor.incapWindowMs = nextIncapWindowMs;
    actor.factionId = nextFactionId;
    actor.socialGroup = nextSocialGroup;
    actor.pvpStatus = nextPvpStatus;
    actor.aiAttitude = nextAiAttitude;
    actor.willAutoAggro = nextWillAutoAggro;
    actor.playerOrganizationId = nextPlayerOrganizationId;
    actor.playerOrganizationTag = nextPlayerOrganizationTag;
    actor.stats = nextStats;
    actor.professions = nextProfessions;
    actor.activeTitle = nextActiveTitle;
    actor.activeTitleId = nextActiveTitleId;
    actor.careerGoalId = nextCareerGoalId;
    actor.skillBoxIds = nextSkillBoxIds;
    actor.skillPointsUsed = nextSkillPointsUsed;
    actor.skillPointsCap = nextSkillPointsCap;
    actor.shotSpreadDegreesMilli = nextShotSpreadDegreesMilli;
    actor.credits = nextCredits;
    actor.combatQueue = nextCombatQueue;
    actor.abilityQueue = nextAbilityQueue;
    actor.inCombat = nextInCombat;
    actor.peaceRequested = nextPeaceRequested;
    actor.engagementTargetId = nextEngagementTargetId;
    actor.statuses = rustActiveEffectStatuses(snapshot.activeEffects, this.tickRateHz);
    actor.statuses = rustStatusSnapshots(actor, this.tick, this.tickRateHz);
    changed = changed || !sameStatusShapes(actor.statuses, previousStatuses);
    if (changed) {
      this.invalidateActorSpatialIndex();
      if (shouldDirtyAoiProjection) this.markDirty(actor.id);
      this.markStatusDirty(actor.id);
      if (isHighFrequencyAuthorityActor(actor) || shouldDirtyDetailProjection) this.markDetailDirty(actor.id);
    }
  }

  private rustCombatEventToGameEvent(
    event: RustAuthorityCombatEventSnapshot,
    actorId: string,
    rustActorId: string,
  ): GameCombatEvent {
    const previousLifeState = rustLifeState(event.previousLifeState);
    const lifeState = rustLifeState(event.lifeState);
    const targetActorId = this.typescriptActorIdForRustActorId(event.targetActorId, actorId, rustActorId);
    const shooterActorId = this.typescriptActorIdForRustActorId(event.shooterActorId, actorId, rustActorId);
    const attackerActorId = event.attackerActorId
      ? this.typescriptActorIdForRustActorId(event.attackerActorId, actorId, rustActorId)
      : shooterActorId;
    const actionId = event.actionId === "aimed_shot" || event.actionId === "basic_shot"
      ? event.actionId
      : undefined;
    const rangedRollKind = event.kind === "ranged_roll" ? "ranged_roll" : undefined;
    const targetProjection = this.actors.get(targetActorId);
    const targetLifecycleSeq = Math.max(
      targetProjection?.lifecycleSeq ?? 1,
      positiveIntegerOr(event.targetLifecycleSeq, targetProjection?.lifecycleSeq ?? 1),
    );
    const weaponId = event.weaponId ? rustWeaponId(event.weaponId) : undefined;
    const ammoTypeId = event.ammoType ? rustAmmoType(event.ammoType) : undefined;
    return {
      id: event.id,
      lifecycle: {
        kind: rustLifecycleKind(event.lifecycle),
        from: previousLifeState,
        to: lifeState,
        cause: event.lifecycle,
      },
      commandId: event.commandId ?? null,
      tick: event.tick,
      shooterActorId,
      targetActorId,
      originPoint: typeof event.originX === "number" && typeof event.originY === "number"
        ? { x: event.originX, y: event.originY }
        : undefined,
      hitPoint: { x: event.hitX, y: event.hitY },
      damage: event.damage,
      zone: rustCombatZone(event.zone),
      previousLifeState,
      lifeState,
      targetLifecycleSeq,
      bleedStackCount: event.bleedStackCount,
      weaponId: weaponId ?? undefined,
      ammoTypeId,
      ...(rangedRollKind ? {
        kind: rangedRollKind,
        attackerActorId,
        actionId,
        hit: event.hit === true,
        pool: event.pool === "health" ? "health" : undefined,
        rollMilli: finiteInteger(event.rollMilli, 0),
        toHitMilli: finiteInteger(event.toHitMilli, 0),
      } : {}),
      effect: event.effect?.kind === "sleep" ? {
        kind: "sleep",
        stacks: event.effect.stacks,
        threshold: event.effect.threshold,
        remainingMs: Math.round((event.effect.remainingTicks / this.tickRateHz) * 1000),
      } : event.effect?.kind === "dodge" ? {
        kind: "dodge",
      } : event.effect?.kind === "shield" ? {
        kind: "shield",
        stacks: event.effect.stacks,
        threshold: event.effect.threshold,
        remainingMs: Math.round((event.effect.remainingTicks / this.tickRateHz) * 1000),
      } : undefined,
    };
  }

  private async ensureRustAuthorityActor(actor: AuthorityActor, rustActorId: string): Promise<void> {
    if (!this.rustAuthorityBridge || !this.shouldUpsertRustAuthorityActor(actor, rustActorId)) return;
    if (this.rustAuthorityRegisteredActorIds.has(rustActorId)) return;
    await this.queueRustAuthorityActorUpsert(actor, rustActorId);
  }

  private async relocateRustAuthorityActor(actor: AuthorityActor, rustActorId: string): Promise<void> {
    const bridge = this.rustAuthorityBridge;
    if (!bridge) return;
    await this.ensureRustAuthorityActor(actor, rustActorId);
    const output = await bridge.relocateActor({
      actorId: rustActorId,
      areaId: actor.areaId,
      x: actor.x,
      y: actor.y,
      direction: actor.direction,
      timeoutMs: 8_000,
    });
    this.syncTickFromRust(output.tick);
    this.recordRustAuthorityStateHash(output.targetStateHash);
    this.syncRustMetrics(output.metrics);
    this.syncRustInventory(output.inventory, output.reservations, output.timelineEvents);
    this.syncRustResourceSpawns(output);
    this.syncRustPlacedExtractors(output);
    this.syncRustPlacedCamps(output);
    this.syncRustPlacedParcels(output);
    this.syncRustBuilding(output);
    this.syncRustFarmPlots(output);
    this.syncRustDraftedSchematics(output);
    this.syncRustGroupViews(output);
    this.syncRustDuelViews(output);
    this.syncRustBankProjection(output.bank, actor.id);
    this.syncRustPlayerCorpses(output.playerCorpses);
    if (output.actor) {
      this.applyRustActorSnapshot(
        this.typescriptActorIdForRustActorId(output.actor.id, actor.id, rustActorId),
        output.actor,
      );
    }
  }

  private registerRustAuthorityActor(actor: AuthorityActor): Promise<void> | null {
    if (!this.rustAuthorityBridge) return null;
    const rustActorId = this.rustActorIdFor(actor.id);
    if (!this.shouldUpsertRustAuthorityActor(actor, rustActorId) || this.rustAuthorityRegisteredActorIds.has(rustActorId)) return null;
    return this.queueRustAuthorityActorUpsert(actor, rustActorId);
  }

  private async forceRustAuthorityActorUpsert(actor: AuthorityActor, rustActorId: string): Promise<void> {
    if (!this.rustAuthorityBridge) return;
    const existing = this.rustAuthorityActorUpserts.get(rustActorId);
    if (existing) {
      await existing;
      return;
    }
    this.rustAuthorityRegisteredActorIds.delete(rustActorId);
    await this.queueRustAuthorityActorUpsert(actor, rustActorId);
  }

  private clearRustActorLinkDeadForReentry(
    actor: AuthorityActor,
  ): Promise<void> | null {
    if (!this.rustAuthorityBridge || this.rustAuthorityMode !== "live") return null;
    const rustActorId = this.rustActorIdFor(actor.id);
    this.rustAuthorityDesiredLinkDead.set(rustActorId, false);
    // Keep the current TS clothing projection until Rust confirms reentry. Blanking
    // worn/wornColors here raced hello/probe against the still-correct durable outfit.
    if (this.rustAuthorityRegisteredActorIds.has(rustActorId)) {
      return this.enqueueRustActorLinkDead(rustActorId, actor.id);
    }
    const upsert = this.rustAuthorityActorUpserts.get(rustActorId);
    const registration = upsert ?? this.forceRustAuthorityActorUpsert(actor, rustActorId);
    return registration;
  }

  private invalidateRustAuthorityActorRegistration(actor: AuthorityActor): void {
    const rustActorId = this.rustActorIdFor(actor.id);
    this.rustAuthorityRegisteredActorIds.delete(rustActorId);
    this.rustAuthorityLinkDeadActorIds.delete(rustActorId);
    this.rustAuthorityActorUpserts.delete(rustActorId);
    this.rustAuthorityDesiredLinkDead.delete(rustActorId);
    this.rustAuthorityLinkDeadEffects.delete(rustActorId);
  }


  private shouldUpsertRustAuthorityActor(actor: AuthorityActor, rustActorId: string): boolean {
    return !this.authoredActorIds.has(rustActorId) || this.claimedAuthoredPlaceholders.get(actor.id) === rustActorId;
  }

  private queueRustAuthorityActorUpsert(
    actor: AuthorityActor,
    rustActorId: string,
    mode: RustAuthorityActorUpsertMode = {},
  ): Promise<void> {
    const existing = this.rustAuthorityActorUpserts.get(rustActorId);
    if (existing) return existing;
    // The callbacks compare against the exact promise, so assignment must happen
    // after their closures have been created.
    let upsert!: Promise<void>;
    // eslint-disable-next-line prefer-const
    upsert = this.upsertRustAuthorityActor(
      actor,
      rustActorId,
      mode,
      () => this.rustAuthorityActorUpserts.get(rustActorId) === upsert,
    ).finally(() => {
      if (this.rustAuthorityActorUpserts.get(rustActorId) === upsert) {
        this.rustAuthorityActorUpserts.delete(rustActorId);
      }
    });
    this.rustAuthorityActorUpserts.set(rustActorId, upsert);
    return upsert;
  }

  private async upsertRustAuthorityActor(
    actor: AuthorityActor,
    rustActorId: string,
    mode: RustAuthorityActorUpsertMode = {},
    registrationStillCurrent: () => boolean,
  ): Promise<void> {
    const output = await this.rustAuthorityBridge!.submitActor({
      actor: this.rustActorUpsertInput(actor, rustActorId, mode),
      timeoutMs: 8_000,
    });
    if (!registrationStillCurrent()) return;
    this.syncTickFromRust(output.tick);
    this.recordRustAuthorityStateHash(output.targetStateHash);
    this.syncRustMetrics(output.metrics);
    this.syncRustInventory(output.inventory, output.reservations, output.timelineEvents, false);
    this.syncRustResourceSpawns(output);
    this.syncRustPlacedExtractors(output);
    this.syncRustPlacedCamps(output);
    this.syncRustPlacedParcels(output);
    this.syncRustBuilding(output);
    this.syncRustFarmPlots(output);
    this.syncRustDraftedSchematics(output);
    this.syncRustGroupViews(output);
    this.syncRustDuelViews(output);
    if (output.actor) {
      this.applyRustActorSnapshot(
        this.typescriptActorIdForRustActorId(output.actor.id, actor.id, rustActorId),
        output.actor,
      );
    }
    this.syncRustBankProjection(output.bank, actor.id);
    this.rustAuthorityRegisteredActorIds.add(rustActorId);
    await this.applyDesiredRustActorLinkDead(actor, rustActorId);
  }
  private ensureRustDeployLoadoutIfMissing(actor: AuthorityActor): Promise<void> | null {
    if (!this.rustAuthorityBridge || this.rustAuthorityMode !== "live" || !isPlayerLikeActor(actor) || this.realCharacterActorIds.has(actor.id)) return null;
    const missingLoadout = standardDeployLoadoutItemIds.some((itemId) => (
      !this.inventory.some((row) => (
        row.itemId === itemId
        && row.available > 0
        && this.actorOwnsInventoryContainer(actor.id, row.container)
      ))
    ));
    if (!missingLoadout) return null;
    return this.forceRustAuthorityActorUpsert(actor, this.rustActorIdFor(actor.id));
  }

  private resetRustAuthorityActor(actor: AuthorityActor, preserveOwnedInventory = false): void {
    if (!this.rustAuthorityBridge || this.rustAuthorityMode !== "live") return;
    this.rustAuthorityRegisteredActorIds.delete(actor.id);
    this.rustAuthorityActorUpserts.delete(actor.id);
    const mode = preserveOwnedInventory ? { bareStart: true, returning: true } : {};
    void this.queueRustAuthorityActorUpsert(actor, actor.id, mode).catch((error) => {
      this.logger?.warn({ error, actorId: actor.id }, "rust authority actor reset failed");
    });
  }


  private removeRustAuthorityActor(actorId: string): Promise<void> {
    const rustActorId = this.rustActorIdFor(actorId);
    const pendingUpsert = this.rustAuthorityActorUpserts.get(rustActorId);
    const pendingLinkDeadEffect = this.rustAuthorityLinkDeadEffects.get(rustActorId);
    const wasRegistered = this.rustAuthorityRegisteredActorIds.delete(rustActorId);
    this.rustAuthorityLinkDeadActorIds.delete(rustActorId);
    this.rustAuthorityDesiredLinkDead.delete(rustActorId);
    this.rustAuthorityActorUpserts.delete(rustActorId);
    this.rustAuthorityLinkDeadEffects.delete(rustActorId);
    const waitForPending = Promise.allSettled(
      [pendingUpsert, pendingLinkDeadEffect].filter((pending): pending is Promise<void> => pending !== undefined),
    );
    if ((!wasRegistered && !pendingUpsert) || this.authoredActorIds.has(rustActorId)) {
      return waitForPending.then(() => undefined);
    }
    return waitForPending.then(async () => {
      const output = await this.rustAuthorityBridge?.removeActor({ actorId: rustActorId });
      if (!output) return;
      this.syncTickFromRust(output.tick);
      this.recordRustAuthorityStateHash(output.targetStateHash);
      this.syncRustMetrics(output.metrics);
      this.syncRustGroupViews(output);
      this.syncRustDuelViews(output);
    }).catch((error) => {
      this.logger?.warn({ error, actorId: rustActorId }, "rust authority actor removal failed");
    });
  }

  private rustActorUpsertInput(
    actor: AuthorityActor,
    rustActorId: string,
    mode: RustAuthorityActorUpsertMode = {},
  ): RustAuthorityActorUpsertInput {
    const verificationLoadout = this.verificationFixtureLoadoutForActor(actor.id);
    const bareStart = verificationLoadout === null
      && (mode.bareStart ?? this.realCharacterActorIds.has(actor.id));
    const returning = verificationLoadout === null
      && (mode.returning ?? this.returningCharacterActorIds.has(actor.id));
    return {
      id: rustActorId,
      areaId: actor.areaId,
      x: actor.x,
      y: actor.y,
      direction: actor.direction,
      entity: actor.characterId ?? this.authoredRustEntityByActorId.get(rustActorId) ?? actor.id,
      worn: cloneActorWorn(actor.worn ?? []),
      wornColors: cloneWornColors(actor.wornColors),
      label: actor.label,
      displayName: actor.displayName,
      linkDead: actor.linkDead,
      bareStart,
      returning,
      ...(verificationLoadout ? { verificationLoadout } : {}),
      appearance: cloneActorAppearance(actor.appearance),
      sprite: actor.sprite,
      role: actor.role,
      professionIds: actor.professionIds?.slice(),
      skillBoxIds: actorSkillBoxIds(actor),
      professionXp: professionXpSeed(actor.professions),
      professionTrackXp: professionTrackXpSeed(actor.professions),
      skillPointCap: actor.skillPointsCap,
      activeTitleId: actor.activeTitleId ?? null,
      capabilities: actor.capabilities?.slice(),
      credits: actor.credits,
      careerGoalId: actor.careerGoalId,
      factionId: actor.factionId,
      socialGroup: actor.socialGroup,
      pvpStatus: actor.pvpStatus,
      playerOrganizationId: actor.playerOrganizationId,
      playerOrganizationTag: actor.playerOrganizationTag,
      scale: actor.scale,
      vitals: { ...actor.vitals },
      maxVitals: { ...actor.maxVitals },
    };
  }

  private verificationFixtureLoadoutForActor(actorId: string) {
    const characterId = this.characterIdsByActorId.get(actorId);
    return characterId ? this.verificationFixtureLoadouts.get(characterId) ?? null : null;
  }

  private rustActorIdFor(actorId: string): string {
    return this.claimedAuthoredPlaceholders.get(actorId) ?? actorId;
  }

  private authoredPlaceholderIdOwnedByCharacter(characterId: string): string | null {
    for (const [placeholderId, ownerCharacterId] of this.authoredPlaceholderOwners) {
      if (ownerCharacterId === characterId) return placeholderId;
    }
    return null;
  }

  private durableAuthorityStateExistsForJoin(
    characterId: string,
    actorId: string,
    existingActor: AuthorityActor | undefined,
  ): boolean {
    if (this.authoredPlaceholderIdOwnedByCharacter(characterId)) return true;
    const boundCharacterId = this.characterIdsByActorId.get(actorId) ?? existingActor?.characterId;
    if (boundCharacterId === characterId) return true;
    return this.inventory.some((row) => this.actorOwnsInventoryContainer(actorId, row.container));
  }

  /**
   * Delete-time guard for the two-file first-entry commit. The Rust checkpoint
   * is published before CharacterStore flips its marker, so a crash in that
   * narrow window can leave a false marker beside real durable authority
   * state. Callers must treat the authority evidence as the stronger truth.
   */
  /** Authority-derived guild membership id for live chat routing. */
  guildIdForActor(actorId: string): string | null {
    const resolvedActorId = this.characterActorIds.get(actorId) ?? actorId;
    const guildView = this.lastRustAuthorityGuildViewsByActorId.get(resolvedActorId);
    if (guildView) return guildView.guild?.id ?? null;
    return this.actors.get(resolvedActorId)?.playerOrganizationId ?? null;
  }
  /** Live authority position for proximity/current-area chat routing. */
  chatPositionForActor(actorId: string): { areaId: string; x: number; y: number } | null {
    const resolvedActorId = this.characterActorIds.get(actorId) ?? actorId;
    const actor = this.actors.get(resolvedActorId);
    if (!actor || !Number.isFinite(actor.x) || !Number.isFinite(actor.y)) return null;
    return { areaId: actor.areaId, x: actor.x, y: actor.y };
  }
  characterHasDurableAuthorityState(characterId: string): boolean {
    const actorId = this.characterActorIds.get(characterId) ?? characterId;
    return this.durableAuthorityStateExistsForJoin(
      characterId,
      actorId,
      this.actors.get(actorId),
    );
  }
  async retireOfflineCharacter(characterId: string): Promise<void> {
    if (this.characterLiveState(characterId) !== "offline") {
      throw new Error(`character ${characterId} is not offline`);
    }
    if (!this.rustAuthorityBridge) {
      throw new Error("rust authority unavailable for character retirement");
    }
    const actorId = this.characterActorIds.get(characterId) ?? characterId;
    const placeholderId = this.authoredPlaceholderIdOwnedByCharacter(characterId)
      ?? this.claimedAuthoredPlaceholders.get(actorId)
      ?? (actorId !== characterId ? this.claimedAuthoredPlaceholders.get(characterId) : undefined);
    const rustActorId = placeholderId ?? this.rustActorIdFor(actorId);
    const pendingUpsert = this.rustAuthorityActorUpserts.get(rustActorId);
    if (placeholderId && this.sessionActorExists(placeholderId)) {
      throw new Error(`authored placeholder ${placeholderId} is still in use`);
    }
    const pendingLinkDead = this.rustAuthorityLinkDeadEffects.get(rustActorId);
    if (pendingUpsert) await pendingUpsert;
    if (pendingLinkDead) await pendingLinkDead;
    const output = this.rustAuthorityBridge
      ? await this.rustAuthorityBridge.removeActor({
        actorId: rustActorId,
        purgeInventory: true,
        timeoutMs: 8_000,
      })
      : undefined;
    if (output) {
      this.syncTickFromRust(output.tick);
      this.recordRustAuthorityStateHash(output.targetStateHash);
      this.syncRustMetrics(output.metrics);
      this.syncRustInventory(output.inventory, output.reservations, output.timelineEvents);
      this.syncRustResourceSpawns(output);
      this.syncRustPlacedExtractors(output);
      this.syncRustPlacedCamps(output);
      this.syncRustPlacedParcels(output);
      this.syncRustFarmPlots(output);
      this.syncRustBuilding(output);
      this.syncRustDraftedSchematics(output);
      this.syncRustGroupViews(output);
      this.syncRustDuelViews(output);
      this.syncRustBankProjection(output.bank);
      this.syncRustPlayerCorpses(output.playerCorpses);
    }

    const ownerIds = new Set([characterId, actorId, rustActorId, placeholderId].filter((id): id is string => Boolean(id)));
    this.inventory = this.inventory.filter((row) => ![...ownerIds].some((id) => this.actorOwnsInventoryContainer(id, row.container)));
    this.travelTicketRows.forEach((row, key) => {
      if ([...ownerIds].some((id) => this.actorOwnsInventoryContainer(id, row.container))) {
        this.travelTicketRows.delete(key);
      }
    });
    this.reservations = this.reservations.filter((row) => (
      !ownerIds.has(row.actor)
      && ![...ownerIds].some((id) => this.actorOwnsInventoryContainer(id, row.from))
    ));
    this.timelineEvents = this.timelineEvents.filter((row) => ![...ownerIds].some((id) => row.label.includes(id)));
    this.lastRustAuthorityPlacedExtractors = this.lastRustAuthorityPlacedExtractors.filter((row) => !row.ownerActorId || !ownerIds.has(row.ownerActorId));
    this.lastRustAuthorityPlacedCamps = this.lastRustAuthorityPlacedCamps.filter((row) => !row.ownerActorId || !ownerIds.has(row.ownerActorId));
    this.lastRustAuthorityPlacedParcels = this.lastRustAuthorityPlacedParcels.filter((row) => !row.ownerActorId || !ownerIds.has(row.ownerActorId));
    this.lastRustAuthorityFarmPlots = this.lastRustAuthorityFarmPlots.filter((row) => !row.ownerActorId || !ownerIds.has(row.ownerActorId));
    this.lastRustAuthorityDraftedSchematics = this.lastRustAuthorityDraftedSchematics.filter((row) => !ownerIds.has(row.ownerActorId));
    this.lastRustAuthorityPlayerCorpses = this.lastRustAuthorityPlayerCorpses.filter((row) => !ownerIds.has(row.ownerActorId));
    this.lastRustAuthorityBuilding = {
      ...this.lastRustAuthorityBuilding,
      components: this.lastRustAuthorityBuilding.components.filter((row) => !ownerIds.has(row.ownerActorId)),
    };
    for (const [container] of this.travelTicketStackCounters) {
      if ([...ownerIds].some((id) => this.actorOwnsInventoryContainer(id, container))) {
        this.travelTicketStackCounters.delete(container);
      }
    }
    for (const map of [
      this.lastRustAuthorityBankByActorId,
      this.lastRustAuthorityGroupViewsByActorId,
      this.lastRustAuthorityGuildViewsByActorId,
      this.lastRustAuthorityDuelViewsByActorId,
    ]) {
      for (const id of ownerIds) map.delete(id);
    }
    this.placedExtractorsByArea.clear();
    for (const row of this.lastRustAuthorityPlacedExtractors) {
      const rows = this.placedExtractorsByArea.get(row.areaId) ?? [];
      rows.push(row);
      this.placedExtractorsByArea.set(row.areaId, rows);
    }
    this.placedCampsByArea.clear();
    for (const row of this.lastRustAuthorityPlacedCamps) {
      const rows = this.placedCampsByArea.get(row.areaId) ?? [];
      rows.push(row);
      this.placedCampsByArea.set(row.areaId, rows);
    }
    this.placedParcelsByArea.clear();
    for (const row of this.lastRustAuthorityPlacedParcels) {
      const rows = this.placedParcelsByArea.get(row.areaId) ?? [];
      rows.push(row);
      this.placedParcelsByArea.set(row.areaId, rows);
    }
    this.farmPlotsByArea.clear();
    for (const row of this.lastRustAuthorityFarmPlots) {
      const rows = this.farmPlotsByArea.get(row.areaId) ?? [];
      rows.push(row);
      this.farmPlotsByArea.set(row.areaId, rows);
    }

    this.actors.delete(actorId);
    this.transientSessionActorIds.delete(actorId);
    const netId = this.actorNetIds.get(actorId);
    this.actorNetIds.delete(actorId);
    if (netId !== undefined) this.actorIdsByNetId.delete(netId);
    this.invalidateActorSpatialIndex();
    this.dirtyActorIds.delete(actorId);
    this.highDetailDirtyActorIds.delete(actorId);
    this.statusDirtyActorIds.delete(actorId);
    this.realCharacterActorIds.delete(actorId);
    this.returningCharacterActorIds.delete(actorId);
    this.characterIdsByActorId.delete(actorId);
    this.characterActorIds.delete(characterId);
    this.lastCharacterCheckpointMs.delete(characterId);
    this.claimedAuthoredPlaceholders.delete(actorId);
    this.authoredPlaceholderOwners.delete(placeholderId ?? "");
    this.rustAuthorityRegisteredActorIds.delete(rustActorId);
    this.rustAuthorityActorUpserts.delete(rustActorId);
    this.rustAuthorityLinkDeadActorIds.delete(rustActorId);
    this.rustAuthorityDesiredLinkDead.delete(rustActorId);
    this.rustAuthorityLinkDeadEffects.delete(rustActorId);

    for (const id of ownerIds) {
      this.activeTradeSessionsByActorId.delete(id);
      this.debugSeenCommandsByActor.delete(id);
      this.debugNextCommandIdByActor.delete(id);
      this.rustAuthorityRegisteredActorIds.delete(id);
      this.rustAuthorityActorUpserts.delete(id);
      this.rustAuthorityLinkDeadActorIds.delete(id);
      this.rustAuthorityDesiredLinkDead.delete(id);
      this.rustAuthorityLinkDeadEffects.delete(id);
    }
    if (placeholderId) {
      const initial = this.initialAuthoredActors.get(placeholderId);
      if (initial && !this.sessionActorExists(placeholderId)) {
        const previousPlaceholder = this.actors.get(placeholderId);
        if (previousPlaceholder) {
          const placeholderNetId = this.actorNetIds.get(placeholderId);
          this.actors.delete(placeholderId);
          this.actorNetIds.delete(placeholderId);
          if (placeholderNetId !== undefined) this.actorIdsByNetId.delete(placeholderNetId);
        }
        const restoredActor = restorePersistedActor(initial);
        this.actors.set(placeholderId, restoredActor);
        this.actorNetId(placeholderId);
        this.invalidateActorSpatialIndex();
        this.dirtyActorIds.add(placeholderId);
        await this.queueRustAuthorityActorUpsert(restoredActor, placeholderId);
      }
    }
    this.dirty = true;
    this.persistenceDirty = true;
  }

  private typescriptActorIdForRustActorId(
    rustActorId: string,
    sessionActorId: string,
    sessionRustActorId: string,
  ): string {
    if (rustActorId === sessionRustActorId) return sessionActorId;
    for (const [actorId, placeholderId] of this.claimedAuthoredPlaceholders) {
      if (placeholderId === rustActorId) return actorId;
    }
    return rustActorId;
  }

  private receiptDeltaFor(actorId: string): GameShardDelta {
    const actor = this.actors.get(actorId);
    return {
      schema: "successor.authoritative-shard-delta.v1",
      shardId: this.shardId,
      tick: this.tick,
      playerActorId: actorId,
      actors: {},
      worldClock: this.clockSnapshot(false),
      weather: this.weatherSnapshot(),
      abilityQueue: this.abilityQueueForActor(actorId),
      placedExtractors: actor ? this.placedExtractorsForArea(actor.areaId, actor.id) : [],
      placedCamps: actor ? this.placedCampsForArea(actor.areaId, actor.id) : [],
      placedParcels: actor ? this.placedParcelsForArea(actor.areaId, actor.id) : [],
      farmPlots: actor ? this.farmPlotsForArea(actor.areaId, actor.id) : [],
      building: actor ? this.buildingForArea(actor.areaId) : {
        schema: "successor.authority-building.v1",
        tick: this.lastRustAuthorityBuilding.tick,
        components: [],
        interiors: [],
      },
      draftedSchematics: actor ? this.draftedSchematicsForActor(actor.id) : [],
      groups: this.groupViewForActor(actorId),
      guilds: this.guildViewForActor(actorId),
      duels: this.duelViewForActor(actorId),
      counters: this.gameCounters(),
    };
  }

  private deltaFor(
    actorId: string,
    focusActorIds: string[],
  ): GameShardDelta {
    const snapshot = this.createSnapshot(actorId, {
      compact: true,
      focusActorIds: focusActorIds.slice(0, maxDeltaActors),
    });
    return {
      schema: "successor.authoritative-shard-delta.v1",
      shardId: snapshot.shardId,
      tick: snapshot.tick,
      playerActorId: snapshot.playerActorId,
      actors: snapshot.actors,
      inventory: snapshot.inventory,
      reservations: snapshot.reservations,
      resourceSpawns: snapshot.resourceSpawns,
      bank: snapshot.bank,
      playerCorpses: snapshot.playerCorpses,
      placedExtractors: snapshot.placedExtractors,
      placedCamps: snapshot.placedCamps,
      placedParcels: snapshot.placedParcels,
      farmPlots: snapshot.farmPlots,
      building: snapshot.building,
      draftedSchematics: snapshot.draftedSchematics,
      groups: snapshot.groups,
      guilds: snapshot.guilds,
      duels: snapshot.duels,
      propStates: snapshot.propStates,
      actorRefs: snapshot.actorRefs,
      worldClock: snapshot.worldClock,
      weather: snapshot.weather,
      abilityQueue: snapshot.abilityQueue ?? null,
      counters: snapshot.counters,
    };
  }

  private deltaForCommand(
    actorId: string,
    focusActorIds: string[],
    session: GameSession | undefined,
  ): GameShardDelta {
    return session
      ? this.deltaForSession(session, focusActorIds)
      : this.deltaFor(actorId, focusActorIds);
  }

  private deltaForSession(
    session: GameSession,
    focusActorIds: string[],
    options: { highDetailActorIds?: Iterable<string>; statusDetailActorIds?: Iterable<string>; includeActorRemovals?: boolean } = {},
  ): GameShardDelta {
    const highDetailActorIds = new Set(options.highDetailActorIds ?? []);
    const statusDetailActorIds = new Set(options.statusDetailActorIds ?? options.highDetailActorIds ?? []);
    const snapshot = this.createSnapshot(session.actorId, {
      compact: true,
      focusActorIds: focusActorIds.slice(0, maxDeltaActors),
      session,
    });
    const actors: Record<string, GameActorSnapshot> = {};
    const actorPatches: Record<string, GameActorPatch> = {};
    const movedActors: Record<string, GameActorSnapshot> = {};
    let compactActorMoves: GameCompactActorMove[] = [];
    let newActorCount = 0;
    for (const [actorId, actor] of Object.entries(snapshot.actors)) {
      if (session.knownActorIds.has(actorId)) {
        const detail = highDetailActorIds.has(actorId);
        const patch = actorPatch(actor, session.knownActorSnapshots.get(actorId), detail, detail || statusDetailActorIds.has(actorId));
        if (!hasActorPatchFields(patch)) continue;
        if (canSendAsCompactMove(patch, detail)) {
          compactActorMoves.push(compactActorMove(this.actorNetId(actorId), actor));
          movedActors[actorId] = actor;
        } else {
          actorPatches[actorId] = patch;
        }
      } else {
        if (!highDetailActorIds.has(actorId) && newActorCount >= maxNewActorsPerDelta) continue;
        actors[actorId] = actor;
        newActorCount += 1;
      }
    }
    const actorRemovals = options.includeActorRemovals === false ? [] : this.actorRemovalsForSession(session);
    if (actorRemovals.length > 0) {
      const removedActorIds = new Set(actorRemovals);
      for (const actorId of removedActorIds) {
        delete actors[actorId];
        delete actorPatches[actorId];
        delete movedActors[actorId];
      }
      compactActorMoves = compactActorMoves.filter((move) => !removedActorIds.has(this.actorIdsByNetId.get(move[0]) ?? ""));
    }
    this.rememberActorSnapshots(session, actors);
    this.rememberActorSnapshots(session, movedActors);
    this.rememberActorSnapshots(session, Object.fromEntries(
      Object.keys(actorPatches)
        .map((actorId) => [actorId, snapshot.actors[actorId]])
        .filter((entry): entry is [string, GameActorSnapshot] => Boolean(entry[1])),
    ));
    const actorRefs = this.actorRefsFor(Object.keys(actors));
    const inventory = this.inventoryDeltaForSession(session, snapshot.inventory ?? []);
    const reservations = this.reservationDeltaForSession(session, snapshot.reservations ?? []);
    return {
      schema: "successor.authoritative-shard-delta.v1",
      shardId: snapshot.shardId,
      tick: snapshot.tick,
      playerActorId: snapshot.playerActorId,
      actors,
      actorPatches: Object.keys(actorPatches).length > 0 ? actorPatches : undefined,
      compactActorMoves: compactActorMoves.length > 0 ? compactActorMoves : undefined,
      actorRefs: actorRefs.length > 0 ? actorRefs : undefined,
      actorRemovals: actorRemovals.length > 0 ? actorRemovals : undefined,
      inventory,
      reservations,
      bank: snapshot.bank,
      playerCorpses: snapshot.playerCorpses,
      resourceSpawns: snapshot.resourceSpawns,
      placedExtractors: snapshot.placedExtractors,
      placedCamps: snapshot.placedCamps,
      placedParcels: snapshot.placedParcels,
      farmPlots: snapshot.farmPlots,
      building: snapshot.building,
      draftedSchematics: snapshot.draftedSchematics,
      groups: snapshot.groups,
      guilds: snapshot.guilds,
      dialogueDeliveries: (session.pendingDialogueDeliveries ?? []).splice(0),
      duels: snapshot.duels,
      propStates: snapshot.propStates,
      worldClock: snapshot.worldClock,
      weather: snapshot.weather,
      abilityQueue: snapshot.abilityQueue ?? null,
      counters: snapshot.counters,
    };
  }

  private markDirty(...actorIds: string[]): void {
    for (const actorId of actorIds) {
      if (this.actors.has(actorId)) this.dirtyActorIds.add(actorId);
    }
    if (this.dirtyActorIds.size > 0) this.dirty = true;
    if (actorIds.length > 0) this.persistenceDirty = true;
  }

  private markDetailDirty(...actorIds: string[]): void {
    this.markDirty(...actorIds);
    for (const actorId of actorIds) {
      if (this.actors.has(actorId)) this.highDetailDirtyActorIds.add(actorId);
    }
  }

  private markStatusDirty(...actorIds: string[]): void {
    this.markDirty(...actorIds);
    for (const actorId of actorIds) {
      if (this.actors.has(actorId)) this.statusDirtyActorIds.add(actorId);
    }
  }

  private deferNewActorForInterestedSessions(actorId: string, exceptSessionId: string): void {
    const actor = this.actors.get(actorId);
    if (!actor) return;
    this.actorInterestSpatialIndex();
    for (const session of this.sessions.values()) {
      if (session.id === exceptSessionId) continue;
      if (!session.viewInterest) continue;
      const observer = this.aoiObserverFor(session);
      if (!observer) continue;
      this.interestActorIdsForSession(session, observer);
      if (!this.setSessionActorInterest(session, actorId, Boolean(this.actorInterestFor(session, observer, actor)), { markDirty: true })) continue;
      this.deferDirtyActorIds(session, [actorId]);
      session.interestDirty = true;
    }
  }


  private invalidateActorSpatialIndex(): void {
    // AOI bookkeeping: actor movement/removal is reconciled into maintained buckets before next fan-out.
    this.actorInterestSpatialIndexDirty = true;
  }

  private loadSlice(slicePath: string): number {
    const raw = fs.readFileSync(slicePath, "utf8");
    this.sliceHash = sha256(raw);
    const payload = JSON.parse(raw) as SlicePayload;
    this.sourceStateHash = typeof payload.stateHash === "string" && payload.stateHash.length > 0
      ? payload.stateHash
      : this.sliceHash;
    this.sourceActorCount = declaredSliceActorCount(payload);
    const tickRateHz = payload.tickRateHz;
    this.tickRateHz = typeof tickRateHz === "number" && Number.isFinite(tickRateHz) && tickRateHz > 0
      ? tickRateHz
      : defaultTickRateHz;
    this.travelCatalog = payload.travelCatalog ?? null;
    for (const area of payload.areas) this.areas.set(area.id, area);
    for (const faction of payload.factions ?? []) this.factions.set(faction.id, faction);
    for (const transition of payload.transitions) this.transitions.set(transition.id, transition);
    for (const facility of payload.cloneFacilities ?? []) this.cloneFacilities.set(facility.id, facility);
    this.inventory = (payload.inventory ?? []).map((row) => normalizeInventoryRowForStream(row));
    this.initialInventory = this.inventory.map((row) => ({ ...row }));
    this.reservations = (payload.reservations ?? []).map((row) => ({ ...row }));
    const blockCell = (areaId: string, x: number, y: number): void => {
      let blocked = this.blockedByArea.get(areaId);
      if (!blocked) {
        blocked = new Set<string>();
        this.blockedByArea.set(areaId, blocked);
      }
      blocked.add(cellKey(x, y));
    };
    for (const cell of payload.blockedCells) blockCell(cell.areaId, cell.x, cell.y);
    for (const prop of payload.props ?? []) {
      this.props.set(prop.id, { ...prop });
      if (isLootCacheProp(prop)) this.propStates.set(prop.id, { ...(this.propStates.get(prop.id) ?? {}), cacheEmptied: false });
      if (prop.door) this.propStates.set(prop.id, { ...(this.propStates.get(prop.id) ?? {}), doorOpen: false });
      if (!propBlocksMovement(prop)) continue;
      for (const cell of integerCellsForRect(prop.cell, prop.size)) blockCell(prop.areaId, cell.x, cell.y);
    }
    this.weatherSheltersByArea.clear();
    for (const prop of this.props.values()) {
      if (prop.shelter !== true) continue;
      const box = shelterBoxForProp(prop);
      const shelters = this.weatherSheltersByArea.get(prop.areaId) ?? [];
      shelters.push(box);
      this.weatherSheltersByArea.set(prop.areaId, shelters);
    }
    this.weatherControllers.clear();
    const worldSeed = Math.trunc(finiteNumber(payload.worldSeed, 0));
    for (const config of payload.weather ?? []) {
      const area = this.areas.get(config.areaId);
      const controller = new AreaWeatherController(config, process.env, {
        worldSeed,
        mapWidthCells: area?.width,
        mapHeightCells: area?.height,
      });
      this.weatherControllers.set(controller.areaId, controller);
    }
    this.initialPropStates.clear();
    for (const [id, state] of this.propStates) this.initialPropStates.set(id, { ...state });
    for (const actor of payload.actors) {
      this.authoredActorIds.add(actor.id);
      if (typeof actor.entity === "string" && actor.entity.trim().length > 0) {
        this.authoredRustEntityByActorId.set(actor.id, actor.entity.trim());
      }
      const created = createActor(
        actor.id,
        actor.label,
        actor.areaId,
        actor.cell,
        normalizeDirection(actor.direction),
        actor.route ?? [],
        {
          role: actor.role,
          sprite: actor.sprite,
          scale: actor.scale,
          factionId: actor.factionId,
          socialGroup: actor.socialGroup,
          pvpStatus: actor.pvpStatus,
          playerOrganizationId: actor.playerOrganizationId,
          playerOrganizationTag: actor.playerOrganizationTag,
          professionIds: actor.professionIds,
          skillBoxIds: actor.skillBoxIds,
          activeTitleId: actor.activeTitleId,
          capabilities: actor.capabilities,
          careerGoalId: actor.careerGoalId,
          credits: actor.credits,
          vitals: actor.vitals,
          maxVitals: actor.maxVitals,
        },
      );
      this.actors.set(actor.id, created);
      this.initialAuthoredActors.set(actor.id, persistActor(created));
      this.actorNetId(actor.id);
      if (!this.defaultCharacterSpawn && (actor.id === "player" || actor.role === "player")) {
        this.defaultCharacterSpawn = {
          areaId: actor.areaId,
          x: actor.cell.x,
          y: actor.cell.y,
          facing: normalizeDirection(actor.direction),
        };
      }
    }
    return Math.max(0, Math.trunc(payload.tick ?? 0));
  }


  /**
   * Shared first-entry spawn selector for ticket-auth and dev-roster joins.
   * Only an explicit never-entered durable character (returningCharacter === false)
   * without live/link-dead/restored authority state receives the clone facility
   * respawnCell. Absent/undefined returningCharacter is NOT treated as fresh, so
   * ordinary joins and fixture helpers keep their supplied spawn. No immunity,
   * timers, or teleports for returning/live actors.
   */
  private applyFirstEntryShelteredSpawn(
    identity: GameSessionIdentity,
    context: {
      durableAuthorityStateExists: boolean;
      existingActor: AuthorityActor | undefined;
      reattachingLinkDead: boolean;
      replacingLiveSession: boolean;
    },
  ): void {
    const characterId = identity.characterId;
    if (!characterId) return;
    // Product first-entry is an explicit false from CharacterStore.worldEntryClaimed
    // on a durable roster row about to claim. Undefined/omitted is ordinary join.
    if (identity.returningCharacter !== false) return;
    if (this.characterPersistence?.hasCharacter?.(characterId) !== true) return;
    if (!this.characterPersistence?.claimWorldEntry) return;
    if (context.durableAuthorityStateExists) return;
    if (context.existingActor || context.reattachingLinkDead || context.replacingLiveSession) return;
    const sheltered = this.cloneFacilityShelteredSpawn();
    if (!sheltered) return;
    identity.spawn = sheltered;
  }

  /** Coordinate source: slice cloneFacilities[].respawnCell / respawnFacing. */
  private cloneFacilityShelteredSpawn(): NonNullable<GameSessionIdentity["spawn"]> | null {
    const facility = this.cloneFacilityForRespawn();
    if (!facility || !this.areas.has(facility.areaId)) return null;
    const cell = this.clampedUnblockedCell(facility.areaId, facility.respawnCell.x, facility.respawnCell.y);
    return {
      areaId: facility.areaId,
      x: cell.x,
      y: cell.y,
      facing: normalizeDirection(facility.respawnFacing),
    };
  }

  private ensureActor(
    identity: GameSessionIdentity,
    options: {
      applySpawn?: boolean;
      applyGameplaySeed?: boolean;
      allowAuthoredPlaceholderClaim?: boolean;
    } = {},
  ): AuthorityActor {
    const actorId = normalizeId(identity.actorId || identity.playerId || `player-${this.nextBotSeq++}`);
    let actor = this.actors.get(actorId);
    if (!actor) {
      // Validate the requested spawn area at CREATION too (the apply-spawn
      // path below already does): an invalid/stale spawnArea param must not
      // create an actor in a nonexistent area.
      const requestedSpawnAreaId = identity.spawn?.areaId;
      const spawnAreaId = requestedSpawnAreaId && this.areas.has(requestedSpawnAreaId)
        ? requestedSpawnAreaId
        : this.defaultSpawnAreaId();
      const fallbackSpawnCell = this.spawnCell(actorId, spawnAreaId);
      const initialSpawn = identity.spawn === undefined
        ? this.defaultJoinSpawnForActor(actorId)
        : {
          areaId: spawnAreaId,
          ...fallbackSpawnCell,
          facing: identity.spawn.facing ?? "front",
        };
      actor = (options.allowAuthoredPlaceholderClaim === false
        ? null
        : this.claimAuthoredPlayerPlaceholder(actorId, identity.characterId))
        ?? createActor(
          actorId,
          identity.displayName,
          initialSpawn.areaId,
          { x: initialSpawn.x, y: initialSpawn.y },
          initialSpawn.facing,
          [],
          { role: "player" },
        );
      actor.id = actorId;
      this.actors.set(actor.id, actor);
      this.actorNetId(actor.id);
    }
    this.actorNetId(actor.id);
    if (!this.authoredActorIds.has(actorId) && !identity.characterId) this.transientSessionActorIds.add(actorId);
    const displayName = normalizeDisplayName(identity.displayName, actor.label);
    const previousLinkDead = actor.linkDead;
    actor.label = displayName;
    actor.displayName = displayName;
    const applyGameplaySeed = options.applyGameplaySeed ?? true;
    if (applyGameplaySeed) {
      actor.appearance = identity.appearance ? cloneActorAppearance(identity.appearance) : actor.appearance ?? cloneActorAppearance(defaultActorAppearance);
      if (identity.worn) actor.worn = cloneActorWorn(identity.worn);
      if (identity.professionIds !== undefined) actor.professionIds = normalizeProfessionIds(identity.professionIds);
      if (identity.skillBoxIds !== undefined) actor.skillBoxIds = normalizeSkillBoxIds(identity.skillBoxIds);
      if (identity.professions !== undefined) actor.professions = cloneProfessionSnapshots(identity.professions);
      if (identity.skillPointsCap !== undefined) {
        actor.skillPointsCap = Math.min(65_535, Math.max(0, finiteInteger(identity.skillPointsCap, 250)));
      }
      if (identity.activeTitleId !== undefined) {
        actor.activeTitleId = normalizeNullableString(identity.activeTitleId);
        actor.activeTitle = titleFromSkillBoxes(actor.activeTitleId, actor.skillBoxIds, actor.professionIds);
      }
      if (identity.careerGoalId !== undefined) actor.careerGoalId = normalizeNullableString(identity.careerGoalId);
      if (identity.credits !== undefined) actor.credits = normalizeCredits(identity.credits);
      if (identity.vitals !== undefined) actor.vitals = mergeVitals(actor.maxVitals, identity.vitals);
    }
    if (identity.characterId) actor.characterId = identity.characterId;
    actor.linkDead = false;
    if (previousLinkDead) this.markDetailDirty(actor.id);
    if ((options.applySpawn ?? true) && identity.spawn?.areaId && this.areas.has(identity.spawn.areaId)) actor.areaId = identity.spawn.areaId;
    if ((options.applySpawn ?? true) && Number.isFinite(identity.spawn?.x) && Number.isFinite(identity.spawn?.y)) {
      const moved = this.rustAuthorityMode === "live"
        ? this.clampedUnblockedUnoccupiedCell(actor.areaId, identity.spawn!.x!, identity.spawn!.y!, actor.id)
        : this.clampedUnblockedCell(actor.areaId, identity.spawn!.x!, identity.spawn!.y!);
      actor.x = moved.x;
      actor.y = moved.y;
    }
    if ((options.applySpawn ?? true) && identity.spawn?.facing) actor.direction = identity.spawn.facing;
    this.invalidateActorSpatialIndex();
    return actor;
  }

  private actorIdForIdentity(identity: GameSessionIdentity): string {
    return normalizeId(identity.actorId || identity.playerId || `player-${this.nextBotSeq}`);
  }

  isReservedCharacterId(characterId: string): boolean {
    return this.authoredActorIds.has(normalizeId(characterId))
      || isGlobalInventoryContainerNamespaceId(characterId);
  }

  private closeSessionsForActor(actorId: string): void {
    for (const session of [...this.sessions.values()]) {
      if (session.actorId !== actorId) continue;
      this.sessions.delete(session.id);
      this.sessionDisconnectCount += 1;
      this.clearSessionInterest(session);
      session.pendingReceipts = [];
      session.pendingEvents = [];
      this.clearDeferredDirtyActorIds(session);
      session.socket.close(4000, "game session replaced");
    }
  }

  private failCloseSlowConsumer(session: GameSession): void {
    if (session.slowConsumerClosing) return;
    session.slowConsumerClosing = true;
    this.slowConsumerDisconnectCount += 1;
    try {
      // Do not send an error frame here: this transport is already over its cap.
      session.socket.close(1013, "slow consumer");
    } catch (error) {
      this.logger?.warn({ error }, "failed to close slow game consumer");
    } finally {
      // Some close adapters do not synchronously emit `close`.
      this.disconnectSession(session.id);
    }
  }

  private disconnectSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.sessions.delete(sessionId);
    session.unregisterRevocation?.();
    session.unregisterRevocation = undefined;
    this.sessionDisconnectCount += 1;
    this.clearSessionInterest(session);
    this.clearDeferredDirtyActorIds(session);
    const characterId = session.characterId ?? this.characterIdsByActorId.get(session.actorId);
    const removeTransientActor = !characterId && !this.sessionActorExists(session.actorId) && this.transientSessionActorIds.has(session.actorId);
    this.appendLifecycleJournal({
      type: "session.disconnect",
      at: new Date().toISOString(),
      tick: this.tick,
      sessionId,
      actorId: session.actorId,
      removedTransientActor: removeTransientActor,
    });
    if (characterId && !this.sessionActorExists(session.actorId)) {
      this.beginCharacterLinkDead(characterId, session);
      return;
    }
    if (!removeTransientActor) return;
    this.despawnSessionActor(session.actorId, this.actors.get(session.actorId));
  }

  private cleanExitSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.sessions.delete(sessionId);
    session.unregisterRevocation?.();
    session.unregisterRevocation = undefined;
    this.sessionDisconnectCount += 1;
    this.clearSessionInterest(session);
    this.clearDeferredDirtyActorIds(session);
    const characterId = session.characterId ?? this.characterIdsByActorId.get(session.actorId);
    const removeTransientActor = !characterId && !this.sessionActorExists(session.actorId) && this.transientSessionActorIds.has(session.actorId);
    this.appendLifecycleJournal({
      type: "session.disconnect",
      at: new Date().toISOString(),
      tick: this.tick,
      sessionId,
      actorId: session.actorId,
      removedTransientActor: Boolean(characterId) || removeTransientActor,
    });
    if (characterId && !this.sessionActorExists(session.actorId)) {
      const actor = this.actors.get(session.actorId);
      if (actor) {
        this.saveCharacterSnapshot(characterId, actor, {
          reason: "disconnect",
          atMs: Date.now(),
          logout: true,
          playMs: Math.max(0, Date.now() - session.connectedAtMs),
        });
      }
      this.characterIdsByActorId.delete(session.actorId);
      this.characterActorIds.delete(characterId);
      this.lastCharacterCheckpointMs.delete(characterId);
      this.despawnSessionActor(session.actorId, actor, { preserveOwnedInventory: true });
      return;
    }
    if (removeTransientActor) this.despawnSessionActor(session.actorId, this.actors.get(session.actorId));
  }

  private despawnSessionActor(
    actorId: string,
    removedActor: AuthorityActor | undefined,
    options: { preserveOwnedInventory?: boolean } = {},
  ): void {
    this.actors.delete(actorId);
    this.transientSessionActorIds.delete(actorId);
    const restoredActor = this.restoreClaimedAuthoredPlaceholder(actorId, removedActor);
    this.invalidateActorSpatialIndex();
    this.dirtyActorIds.delete(actorId);
    this.realCharacterActorIds.delete(actorId);
    this.returningCharacterActorIds.delete(actorId);
    const rustRemoval = this.removeRustAuthorityActor(actorId);
    if (restoredActor) {
      void rustRemoval.then(() => {
        this.resetRustAuthorityActor(restoredActor, options.preserveOwnedInventory === true);
      });
    }
    this.dirty = true;
    this.persistenceDirty = true;
  }

  private claimableAuthoredPlayerPlaceholder(actorId: string, ownerCharacterId?: string): AuthorityActor | null {
    if (actorId === "player" || this.sessionActorExists("player")) return null;
    const placeholder = this.actors.get("player");
    if (!placeholder) return null;
    const owner = this.authoredPlaceholderOwners.get("player") ?? placeholder.characterId;
    const claimant = ownerCharacterId ?? actorId;
    return owner && owner !== claimant ? null : placeholder;
  }

  private claimAuthoredPlayerPlaceholder(actorId: string, ownerCharacterId?: string): AuthorityActor | null {
    const placeholder = this.claimableAuthoredPlayerPlaceholder(actorId, ownerCharacterId);
    if (!placeholder) return null;
    placeholder.seenCommands.clear();
    if (ownerCharacterId) this.authoredPlaceholderOwners.set("player", ownerCharacterId);
    this.claimedAuthoredPlaceholders.set(actorId, "player");
    this.remapProjectedRustOwnership("player", actorId);
    this.moveProjectedActorId("player", actorId, placeholder);
    return placeholder;
  }

  private moveProjectedActorId(fromActorId: string, toActorId: string, actor: AuthorityActor): void {
    if (fromActorId === toActorId) return;
    const previousInterestBucketRef = this.actorInterestBucketRefs.get(fromActorId);
    if (this.actorInterestSpatialIndexReady && previousInterestBucketRef) {
      this.removeActorFromInterestBucket({ id: fromActorId }, previousInterestBucketRef);
    }
    this.actors.delete(fromActorId);
    actor.id = toActorId;
    this.actors.set(toActorId, actor);

    const existingNetId = this.actorNetIds.get(fromActorId);
    this.actorNetIds.delete(fromActorId);
    if (existingNetId === undefined) {
      this.actorNetId(toActorId);
    } else {
      this.actorNetIds.set(toActorId, existingNetId);
      this.actorIdsByNetId.set(existingNetId, toActorId);
    }
    const characterId = this.characterIdsByActorId.get(fromActorId);
    if (characterId) {
      this.characterIdsByActorId.delete(fromActorId);
      this.characterIdsByActorId.set(toActorId, characterId);
      this.characterActorIds.set(characterId, toActorId);
    }
    for (const set of [
      this.transientSessionActorIds,
      this.dirtyActorIds,
      this.highDetailDirtyActorIds,
      this.statusDirtyActorIds,
    ]) {
      if (set.delete(fromActorId)) set.add(toActorId);
    }
    const interestOrder = this.actorInterestOrder.get(fromActorId);
    this.actorInterestOrder.delete(fromActorId);
    if (interestOrder !== undefined) this.actorInterestOrder.set(toActorId, interestOrder);
    this.actorInterestBucketRefs.delete(fromActorId);
    this.invalidateActorSpatialIndex();
  }

  private remapProjectedRustOwnership(fromActorId: string, toActorId: string): void {
    if (fromActorId === toActorId) return;
    this.inventory = this.inventory.map((row) => ({
      ...row,
      container: replaceContainerActorId(row.container, fromActorId, toActorId),
    }));
    this.reservations = this.reservations.map((row) => ({
      ...row,
      actor: row.actor === fromActorId ? toActorId : row.actor,
      from: replaceContainerActorId(row.from, fromActorId, toActorId),
    }));
    this.timelineEvents = this.timelineEvents.map((row) => ({
      ...row,
      label: row.label.replaceAll(fromActorId, toActorId),
    }));
  }

  private restoreClaimedAuthoredPlaceholder(
    actorId: string,
    actor: AuthorityActor | undefined,
    restorePristine = false,
  ): AuthorityActor | null {
    const placeholderId = this.claimedAuthoredPlaceholders.get(actorId);
    if (!placeholderId || this.actors.has(placeholderId) || this.sessionActorExists(placeholderId)) return null;
    this.claimedAuthoredPlaceholders.delete(actorId);
    this.remapProjectedRustOwnership(actorId, placeholderId);
    if (!actor) return null;
    const initial = this.initialAuthoredActors.get(placeholderId);
    if (restorePristine && !initial) return null;
    if (restorePristine) {
      const restoredActor = restorePersistedActor(initial!);
      this.moveProjectedActorId(actorId, placeholderId, restoredActor);
      this.dirtyActorIds.add(placeholderId);
      return restoredActor;
    }
    if (actor.characterId) this.authoredPlaceholderOwners.set(placeholderId, actor.characterId);
    const restoredActor = createActor(
      placeholderId,
      actor.label,
      actor.homeAreaId,
      actor.homeCell,
      actor.homeDirection,
      actor.homeRoute,
      createActorOptionsFromActor(actor),
    );
    this.moveProjectedActorId(actorId, placeholderId, restoredActor);
    this.dirtyActorIds.add(placeholderId);
    return restoredActor;
  }

  private sessionActorExists(actorId: string): boolean {
    for (const session of this.sessions.values()) {
      if (session.actorId === actorId) return true;
    }
    return false;
  }

  /**
   * Identity joins and bots without explicit spawn params land in the shard's
   * OWN primary area — never a hardcoded fixture constant. The old
   * "authority-test-overworld" default silently spawned session actors into a
   * nonexistent area on any fixture with a different area id (first hit:
   * open-desert), stranding the client in an empty world.
   */
  private defaultSpawnAreaId(): string {
    return this.areas.keys().next().value ?? "authority-test-overworld";
  }

  private spawnCell(actorId: string, spawnAreaId?: string): Cell {
    const index = this.nextBotSeq++;
    const areaId = spawnAreaId && this.areas.has(spawnAreaId) ? spawnAreaId : this.defaultSpawnAreaId();
    const cell = this.spawnCellForIndex(index, areaId);
    if (cell.x !== 2 || cell.y !== 2 || !this.isBlocked(areaId, 2, 2)) return cell;
    this.logger?.warn({ actorId }, "failed to find unblocked bot spawn, using fallback");
    return cell;
  }

  private spawnCellForIndex(index: number, areaId: string): Cell {
    const area = this.areas.get(areaId);
    const width = area?.width ?? 64;
    const height = area?.height ?? 36;
    for (let attempt = 0; attempt < width * height; attempt += 1) {
      const x = 2 + ((index * 7 + attempt * 3) % Math.max(1, width - 4));
      const y = 2 + ((index * 11 + attempt * 5) % Math.max(1, height - 4));
      if (!this.isBlocked(areaId, x, y)) return { x, y };
    }
    return { x: 2, y: 2 };
  }

  private async handleRawMessage(sessionId: string, data: unknown): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    const text = Buffer.isBuffer(data) ? data.toString("utf8") : String(data);
    if (Buffer.byteLength(text, "utf8") > this.maxPacketBytes) {
      this.sendError(session, "packet_too_large", "game packet too large");
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      this.sendError(session, "invalid_json", "game packet must be JSON");
      return;
    }

    const packet = gameClientPacketSchema.safeParse(parsed);
    if (!packet.success) {
      this.sendError(session, "invalid_packet", "game packet schema mismatch");
      return;
    }

    this.counters.packetsIn += 1;
    if (packet.data.type === "ping") {
      this.send(session, { type: "pong", requestId: packet.data.requestId, at: Date.now() });
      return;
    }
    if (packet.data.type === "game.view") {
      this.updateSessionInterest(session, packet.data.view);
      return;
    }
    if (packet.data.type === "exit_world") {
      this.cleanExitSession(session.id);
      session.socket.close(1000, "exit_world");
      return;
    }


    this.deferSnapshotsUntilMs = Math.max(this.deferSnapshotsUntilMs, Date.now() + commandPrioritySnapshotDeferMs);
    const moveTraceReceivedAtMs = gameMoveTraceEnabled
      && ("Move" in packet.data.envelope.command || "SetMoveIntent" in packet.data.envelope.command)
      ? performance.now()
      : 0;
    // Bare /survey //sample reuse-last: resolve the ingress sentinel to a
    // concrete family (or an honest prompt) BEFORE anything is forwarded to Rust
    // or appended to the journal.
    const resolvedResource = this.resolveResourceSentinelForSession(session, packet.data.envelope);
    let result: SubmitCommandResult;
    if ("reject" in resolvedResource) {
      this.recordCommandRejection(
        session.actorId,
        packet.data.envelope.command,
        resolvedResource.reject,
        this.tick,
      );
      result = {
        receipt: this.reject(packet.data.envelope.command_id, resolvedResource.reject),
        events: [],
        delta: this.receiptDeltaFor(session.actorId),
      };
    } else {
      const resolvedEnvelope = resolvedResource.envelope;
      try {
        result = this.rustAuthorityMode === "live"
          ? await this.submitRustAuthorityCommand(session, resolvedEnvelope)
          : this.allowInProcessAuthorityForTests
            ? this.submitCommandForTest(session.actorId, resolvedEnvelope, session.seenCommands, false, session)
            : this.rejectMissingRustAuthority(session, resolvedEnvelope);
      } catch (error) {
        this.logger?.warn({ error, sessionId: session.id }, "rust authority live command failed");
        this.sendError(session, "rust_authority_unavailable", "rust authority unavailable");
        return;
      }
      if (result.receipt.accepted) {
        this.recordSessionResourceContext(session, resolvedEnvelope);
      }
    }
    if (gameMoveTraceEnabled && ("Move" in packet.data.envelope.command || "SetMoveIntent" in packet.data.envelope.command)) {
      this.writeMoveTraceReceipt(session, packet.data.envelope, result.receipt, moveTraceReceivedAtMs);
    }
    // A receipt is an acknowledgement, not merely an in-memory result. Do not
    // release it to a client until this command group has reached stable media.
    const committed = process.env.GAME_HOSTED_DURABILITY === "1"
      ? await this.commitJournalGroup()
      : this.flushJournal();
    if (!committed) {
      this.sendError(session, "persistence_unavailable", "durable command commit failed");
      return;
    }
    if (result.events.length > 0) this.queueCombatEvents(result.events, session.id);
    session.pendingReceipts.push(result.receipt);
    session.pendingEvents.push(...result.events);
    session.pendingAbilityQueueEvents.push(...(result.abilityQueueEvents ?? []));
    if (result.surveyResult) {
      this.sendSessionMessage(session, "surveyResult", result.surveyResult);
    }
    if (result.craftSession) {
      this.sendSessionMessage(session, "craftSession", result.craftSession);
    }
    if (result.spliceSession) {
      this.sendSessionMessage(session, "spliceSession", result.spliceSession);
    }
    if (result.genomeScan) {
      this.sendSessionMessage(session, "genomeScan", result.genomeScan);
    }
    if (result.tradeSessionDeliveries) {
      this.deliverTradeSessionsToParticipants(result.tradeSessionDeliveries);
    }
    if (result.duelOutcomes) {
      this.deliverDuelOutcomesToParticipants(result.duelOutcomes);
    }
    if ("Move" in packet.data.envelope.command || "SetMoveIntent" in packet.data.envelope.command) {
      const playerActor = this.actors.get(session.actorId);
      const playerSnapshot = playerActor ? this.actorSnapshotForObserver(session.actorId, playerActor) : undefined;
      const shouldSendFullMoveAck = playerSnapshot && "Move" in packet.data.envelope.command && shouldSendPlayerActorMoveAck(
        packet.data.envelope.command.Move,
        playerSnapshot ? session.knownActorSnapshots.get(playerSnapshot.id) : undefined,
        playerSnapshot,
      );
      const playerMoveAck = shouldSendFullMoveAck
        ? { playerActor: playerSnapshot }
        : { playerPosition: playerSnapshot ? playerPositionAck(playerSnapshot) : undefined };
      if (playerSnapshot) this.rememberActorSnapshots(session, { [playerSnapshot.id]: playerSnapshot });
      const ackEventsDue = this.pendingCombatEventsDue(session);
      this.send(session, {
        type: "game.acks",
        acks: session.pendingReceipts.splice(0).map(compactReceipt),
        ...playerMoveAck,
        events: this.takePendingCombatEvents(session, ackEventsDue),
        abilityQueue: this.abilityQueueForSession(session),
        abilityQueueEvents: this.takePendingAbilityQueueEvents(session),
      });
      return;
    }
    this.send(session, {
      type: "game.delta",
      delta: result.delta,
      receipts: session.pendingReceipts.splice(0),
      events: session.pendingEvents.splice(0),
      abilityQueueEvents: this.takePendingAbilityQueueEvents(session),
    });
    this.markKnownActorsFromDelta(session, result.delta);
    session.lastSnapshotTick = result.delta.tick;
    if (Object.keys(result.delta.actors).length > 0) session.lastActorDeltaTick = result.delta.tick;
  }

  private writeMoveTraceReceipt(
    session: GameSession,
    envelope: ClientCommandEnvelope,
    receipt: GameCommandReceipt,
    receivedAtMs: number,
  ): void {
    if (!gameMoveTraceEnabled || (!("Move" in envelope.command) && !("SetMoveIntent" in envelope.command))) return;
    const elapsedMs = receivedAtMs > 0 ? performance.now() - receivedAtMs : 0;
    const move = "Move" in envelope.command ? envelope.command.Move : envelope.command.SetMoveIntent;
    process.stdout.write(`${JSON.stringify({
      schema: "successor.move-trace.v1",
      event: "move.receipt",
      atMs: Date.now(),
      shardId: this.shardId,
      actor: session.actorId,
      sessionId: session.id,
      commandId: envelope.command_id,
      commandKind: "Move" in envelope.command ? "Move" : "SetMoveIntent",
      issuedAtTick: envelope.issued_at_tick,
      accepted: receipt.accepted,
      reason: receipt.reasonCode ?? null,
      tick: receipt.tick,
      shardTick: this.tick,
      dx: move.dx,
      dy: move.dy,
      durationTicks: "duration_ticks" in move ? move.duration_ticks : null,
      sprint: move.sprint === true,
      receiptMs: Number(elapsedMs.toFixed(3)),
    })}\n`);
  }

  private applyCommand(actor: AuthorityActor, envelope: ClientCommandEnvelope): ApplyCommandResult {
    const command = envelope.command;
    const localApplied = this.applyLocalAuthorityCommand(actor, envelope);
    if (localApplied) return localApplied;
    if ("Move" in command) {
      const facing = command.Move.facing ? directionFromCardinal(command.Move.facing) : null;
      if (facing) actor.direction = facing;
      return this.applyMove(actor, command.Move.dx, command.Move.dy, command.Move.duration_ticks, !facing, command.Move.sprint === true);
    }
    if ("SetMoveIntent" in command) {
      const facing = command.SetMoveIntent.facing ? directionFromCardinal(command.SetMoveIntent.facing) : null;
      if (facing) actor.direction = facing;
      return { accepted: true, events: [] };
    }
    if ("EnterTransition" in command) {
      return this.applyTransition(actor, command.EnterTransition.transition_id)
        ? { accepted: true, events: [] }
        : { accepted: false, reasonCode: "transition_rejected", events: [] };
    }
    if ("UseConsumable" in command || "RefillAmmo" in command || "ApplyServiceBuff" in command) {
      return { accepted: true, events: [] };
    }
    if ("CloneRespawn" in command) {
      return this.applyCloneRespawn(actor, command.CloneRespawn.facility_id ?? null);
    }
    if ("ReviveActor" in command) {
      return { accepted: true, events: [] };
    }
    if ("Peace" in command) {
      actor.peaceRequested = true;
      this.dirtyActorIds.add(actor.id);
      return { accepted: true, events: [] };
    }
    if ("SetProfessionTitle" in command) {
      const requestedTitleId = command.SetProfessionTitle.title_id ?? null;
      const nextTitle = titleFromSkillBoxes(requestedTitleId, actor.skillBoxIds, actor.professionIds);
      if (requestedTitleId && !nextTitle) {
        return { accepted: false, reasonCode: "unknown_profession_title", events: [] };
      }
      actor.activeTitle = nextTitle;
      actor.activeTitleId = nextTitle?.id ?? null;
      this.dirtyActorIds.add(actor.id);
      return { accepted: true, events: [] };
    }
    if ("SetCareerGoal" in command) {
      actor.careerGoalId = command.SetCareerGoal.goal_id;
      this.dirtyActorIds.add(actor.id);
      return { accepted: true, events: [] };
    }
    if ("DiscardStack" in command) {
      return { accepted: true, events: [] };
    }
    if ("SetPosture" in command || "SampleResource" in command || "SurveyResource" in command || "PlaceExtractor" in command || "CrankExtractor" in command || "StopCrank" in command || "InsertBattery" in command || "CollectExtractor" in command || "DestroyExtractor" in command || "PlaceCamp" in command || "PackUpCamp" in command || "SplitStack" in command || "MergeStacks" in command || "RedeemCreditChip" in command || "HarvestCorpse" in command || "CraftItem" in command || "CraftBegin" in command || "CraftAssignSlot" in command || "CraftClearSlot" in command || "CraftAssemble" in command || "CraftExperiment" in command || "CraftFinalizePrototype" in command || "CraftFinalizePractice" in command || "CraftDraftSchematic" in command || "CraftCancel" in command || "RequestStarterTool" in command || "PurchaseSkillBox" in command || "UnlearnSkillBox" in command || "ClaimParcel" in command || "AbandonParcel" in command || "RenameParcel" in command || "PayUpkeep" in command || "TillTile" in command || "PlantSeed" in command || "ClearTile" in command || "WaterTile" in command || "TendPlot" in command || "PlaceFarmStructure" in command || "RemoveFarmStructure" in command || "Fertilize" in command || "HarvestCrop" in command) {
      return { accepted: true, events: [] };
    }
    if ("ReloadWeapon" in command) {
      return { accepted: true, events: [] };
    }
    if ("SetEquippedWeapon" in command) {
      const requestedWeaponId = command.SetEquippedWeapon.weapon_id;
      const weaponItemId = Math.max(0, Math.trunc(command.SetEquippedWeapon.weapon_item_id ?? 0));
      const weaponVariantId = Math.max(0, Math.trunc(command.SetEquippedWeapon.weapon_variant_id ?? 0));
      const itemWeaponId = weaponItemId > 0 ? authorityWeaponIdForInventoryItemId(weaponItemId) : null;
      if (weaponItemId > 0 && !itemWeaponId) {
        return { accepted: false, reasonCode: "unknown_item", events: [] };
      }
      const weaponId = itemWeaponId ?? requestedWeaponId;
      if (!weaponId) {
        actor.weapon = null;
      } else if (!isAuthorityWeaponId(weaponId)) {
        return { accepted: false, reasonCode: "unknown_weapon", events: [] };
      } else if (requestedWeaponId && itemWeaponId && requestedWeaponId !== itemWeaponId) {
        return { accepted: false, reasonCode: "no_weapon_equipped", events: [] };
      } else if (weaponItemId > 0 && !this.inventory.some((row) => row.itemId === weaponItemId && this.actorOwnsInventoryContainer(actor.id, row.container) && row.available > 0)) {
        return { accepted: false, reasonCode: "item_unavailable", events: [] };
      } else {
        actor.weapon = authorityActorWeaponSnapshot(weaponId, weaponItemId, weaponVariantId);
      }
      this.dirtyActorIds.add(actor.id);
      return { accepted: true, events: [] };
    }
    if ("DebugGiveItem" in command) {
      const itemId = Math.max(0, Math.trunc(command.DebugGiveItem.item_id));
      const variantId = Math.max(0, Math.trunc(command.DebugGiveItem.variant_id ?? 0));
      const quantity = Math.max(0, Math.trunc(command.DebugGiveItem.quantity ?? 1));
      if (quantity <= 0) return { accepted: false, reasonCode: "item_unavailable", events: [] };
      const item = inventoryItemNameForId(itemId);
      if (!item) return { accepted: false, reasonCode: "unknown_item", events: [] };
      const container = `${actor.id}:field-pack`;
      const existing = this.inventory.find((row) => row.container === container && row.itemId === itemId && row.variantId === variantId);
      if (existing) {
        existing.quantity += quantity;
        existing.available += quantity;
      } else {
        this.inventory.push(normalizeInventoryRowForStream({
          container,
          stackId: this.nextInventoryStackId(container),
          item,
          itemId,
          variantId,
          quantity,
          reserved: 0,
          available: quantity,
        }));
      }
      if (command.DebugGiveItem.equip === true) {
        const weaponId = authorityWeaponIdForInventoryItemId(itemId);
        if (!weaponId) return { accepted: false, reasonCode: "unknown_item", events: [] };
        actor.weapon = authorityActorWeaponSnapshot(weaponId, itemId);
      }
      this.dirtyActorIds.add(actor.id);
      this.persistenceDirty = true;
      return { accepted: true, events: [] };
    }
    if ("DebugGrantSkillBoxes" in command) {
      const skillBoxIds = normalizeSkillBoxIds(command.DebugGrantSkillBoxes.skill_box_ids);
      if (!skillBoxIds || skillBoxIds.length === 0) {
        return { accepted: false, reasonCode: "unknown_skill_box", events: [] };
      }
      actor.skillBoxIds = normalizeSkillBoxIds([...(actorSkillBoxIds(actor) ?? []), ...skillBoxIds]);
      actor.activeTitle = titleFromSkillBoxes(actor.activeTitleId, actor.skillBoxIds, actor.professionIds);
      this.dirtyActorIds.add(actor.id);
      this.persistenceDirty = true;
      return { accepted: true, events: [] };
    }
    return { accepted: false, reasonCode: "unknown_command", events: [] };
  }

  advanceAuthorityForTest(ticks = 1): GameCombatEvent[] {
    return this.advanceTick(ticks);
  }

  flushSnapshotsForTest(): void {
    void this.flushSnapshots({ force: true });
  }

  private advanceTick(ticks = 1): GameCombatEvent[] {
    const safeTicks = Math.max(1, Math.min(30, Math.trunc(ticks)));
    this.tick += safeTicks;
    const dtMs = (1000 / this.tickRateHz) * safeTicks;
    this.tickBleeds(dtMs);
    this.tickPassiveRegen(dtMs);
    this.tickSleep(dtMs);
    this.tickStatuses(dtMs);
    return [];
  }

  private applyMove(actor: AuthorityActor, dx: number, dy: number, durationTicks: number, updateDirection: boolean, sprintRequested: boolean): ApplyCommandResult {
    if (actor.lifeState !== "alive" || this.actorIsAsleep(actor)) return { accepted: false, reasonCode: "move_rejected", events: [] };
    if (!validMoveVector(dx, dy)) return { accepted: false, reasonCode: "move_rejected", events: [] };
    if (this.tick < actor.nextMoveTick) return { accepted: false, reasonCode: "move_cooldown", events: [] };
    const sprintCost = pendingSprintActionCostForActor(actor, durationTicks, this.tickRateHz);
    const sprinting = sprintRequested && isPlayerLikeActor(actor) && actor.vitals.action > 0 && actor.vitals.action >= sprintCost;
    const sprintMultiplier = sprinting
      ? sprintSpeedMultiplier * (1 + professionTrackSkillBonusForActor(actor, "scout", "sprinting") * 6 / 5 / 1_000)
      : 1;
    const distance = playerSpeedCellsPerSecond * movementSpeedMultiplierForActor(actor) * sprintMultiplier * (Math.max(1, durationTicks) / this.tickRateHz);
    const delta = movementDeltaForDistance(dx, dy, distance);
    const next = this.clampedUnblockedPosition(actor.areaId, actor.x, actor.y, actor.x + delta.x, actor.y + delta.y);
    if (next.x === actor.x && next.y === actor.y) return { accepted: false, reasonCode: "move_rejected", events: [] };
    actor.x = next.x;
    actor.y = next.y;
    if (sprinting) {
      applySprintActionCostForActor(actor, durationTicks, this.tickRateHz);
      actor.sprintRegenBlockedUntilTick = Math.max(actor.sprintRegenBlockedUntilTick, this.tick + Math.max(1, durationTicks));
    }
    actor.nextMoveTick = this.tick + Math.max(1, durationTicks);
    this.invalidateActorSpatialIndex();
    if (updateDirection) {
      if (dx > 0) actor.direction = "right";
      if (dx < 0) actor.direction = "left";
      if (dy > 0) actor.direction = "front";
      if (dy < 0) actor.direction = "back";
    }
    return { accepted: true, events: [] };
  }

  private applyTransition(actor: AuthorityActor, transitionId: string): boolean {
    if (actor.lifeState !== "alive" || this.actorIsAsleep(actor)) return false;
    const transition = this.transitions.get(transitionId);
    if (!transition || transition.fromAreaId !== actor.areaId) return false;
    const centerX = actor.x + 0.5;
    const centerY = actor.y + 0.5;
    const inside = centerX >= transition.fromCell.x
      && centerX < transition.fromCell.x + transition.triggerSize.w
      && centerY >= transition.fromCell.y
      && centerY < transition.fromCell.y + transition.triggerSize.h;
    if (!inside) return false;
    actor.areaId = transition.toAreaId;
    actor.x = transition.toCell.x;
    actor.y = transition.toCell.y;
    this.invalidateActorSpatialIndex();
    actor.direction = normalizeDirection(transition.toFacing);
    return true;
  }

  private applyLocalAuthorityCommand(actor: AuthorityActor, envelope: ClientCommandEnvelope): ApplyCommandResult | null {
    const command = envelope.command;
    if ("ToggleDoor" in command) {
      return this.applyToggleDoor(actor, command.ToggleDoor.prop_id);
    }
    if ("PurchaseTravelTicket" in command) {
      return this.applyPurchaseTravelTicket(actor, command.PurchaseTravelTicket, envelope.command_id);
    }
    if ("UseTravelTicket" in command) {
      return this.applyUseTravelTicket(actor, command.UseTravelTicket);
    }
    return null;
  }

  private applyToggleDoor(actor: AuthorityActor, propId: string): ApplyCommandResult {
    if (actor.lifeState !== "alive" || this.actorIsAsleep(actor)) return { accepted: false, reasonCode: "door_actor_unavailable", events: [] };
    const prop = this.props.get(propId);
    if (!prop || !prop.door || prop.areaId !== actor.areaId) return { accepted: false, reasonCode: "door_unknown", events: [] };
    if (!this.actorWithinDoorRadius(actor, prop)) return { accepted: false, reasonCode: "door_out_of_range", events: [] };
    const current = this.propStates.get(prop.id) ?? {};
    this.propStates.set(prop.id, { ...current, doorOpen: current.doorOpen !== true });
    return { accepted: true, events: [] };
  }

  private applyPurchaseTravelTicket(
    actor: AuthorityActor,
    payload: { terminal_prop_id: string; to_planet_id: string; to_city_id: string },
    commandId: number,
  ): ApplyCommandResult {
    if (actor.lifeState !== "alive" || this.actorIsAsleep(actor)) {
      return { accepted: false, reasonCode: "travel_actor_not_alive", events: [] };
    }
    const origin = this.travelCityForTerminal(payload.terminal_prop_id);
    const terminal = this.travelTerminalProp(payload.terminal_prop_id);
    if (!origin || !terminal) return { accepted: false, reasonCode: "travel_terminal_unknown", events: [] };
    if (terminal.areaId !== actor.areaId || terminal.areaId !== this.travelCityAreaId(origin) || !terminal.interactive) {
      return { accepted: false, reasonCode: "travel_terminal_unavailable", events: [] };
    }
    if (!this.actorWithinPropRadius(actor, terminal, travelTerminalInteractionRadiusCells)) {
      return { accepted: false, reasonCode: "travel_out_of_range", events: [] };
    }
    const destination = this.travelCityByDestination(payload.to_planet_id, payload.to_city_id);
    if (!destination || !this.areas.has(this.travelCityAreaId(destination))) {
      return { accepted: false, reasonCode: "travel_destination_unknown", events: [] };
    }
    if (origin.planet.id === destination.planet.id && origin.city.id === destination.city.id) {
      return { accepted: false, reasonCode: "travel_same_destination", events: [] };
    }
    this.grantTravelTicket(actor, origin, destination, terminal, commandId);
    return { accepted: true, events: [] };
  }

  private applyUseTravelTicket(
    actor: AuthorityActor,
    payload: { container?: string; stack_id?: string; ticket_id?: string; item_id?: string; item_numeric_id?: number; variant_id?: number },
  ): ApplyCommandResult {
    if (actor.lifeState !== "alive" || this.actorIsAsleep(actor)) {
      return { accepted: false, reasonCode: "travel_actor_not_alive", events: [] };
    }
    const row = this.travelTicketRowForCommand(actor, payload);
    if (!row) return { accepted: false, reasonCode: "travel_ticket_not_found", events: [] };
    const ticket = this.travelTicketDataFromRow(row);
    if (!ticket) return { accepted: false, reasonCode: "travel_ticket_malformed", events: [] };
    const originTerminal = this.travelTerminalProp(ticket.originTerminalPropId);
    if (!originTerminal) return { accepted: false, reasonCode: "travel_origin_terminal_unknown", events: [] };
    const nearbyTerminal = this.nearbyTravelTerminal(actor);
    if (nearbyTerminal && nearbyTerminal.id !== originTerminal.id) {
      return { accepted: false, reasonCode: "travel_origin_wrong_terminal", events: [] };
    }
    if (actor.areaId !== ticket.originAreaId || actor.areaId !== originTerminal.areaId) {
      return { accepted: false, reasonCode: "travel_origin_wrong_area", events: [] };
    }
    if (!this.actorWithinPropRadius(actor, originTerminal, travelTerminalInteractionRadiusCells)) {
      return { accepted: false, reasonCode: "travel_out_of_range", events: [] };
    }
    if (!this.areas.has(ticket.destAreaId)) {
      return { accepted: false, reasonCode: "travel_destination_unknown", events: [] };
    }
    if (this.blockedByArea.get(ticket.destAreaId)?.has(cellKey(ticket.destSpawn.x, ticket.destSpawn.y))) {
      return { accepted: false, reasonCode: "travel_destination_blocked", events: [] };
    }
    this.consumeTravelTicket(row, ticket.ticketId);
    this.teleportActorToTravelDestination(actor, ticket);
    return { accepted: true, events: [] };
  }

  private grantTravelTicket(
    actor: AuthorityActor,
    origin: { planet: SliceTravelCatalogPlanet; city: SliceTravelCatalogCity },
    destination: { planet: SliceTravelCatalogPlanet; city: SliceTravelCatalogCity },
    terminal: SliceProp,
    commandId: number,
  ): void {
    const ticketId = `${actor.id}:travel:${commandId}`;
    const ticket: TravelTicketData = {
      ticketId,
      fromPlanetId: origin.planet.id,
      fromCityId: origin.city.id,
      toPlanetId: destination.planet.id,
      toCityId: destination.city.id,
      originTerminalPropId: terminal.id,
      originAreaId: this.travelCityAreaId(origin),
      destAreaId: this.travelCityAreaId(destination),
      destSpawn: { ...destination.city.spawn },
    };
    const container = `${actor.id}:field-pack`;
    const row: RustAuthorityInventorySnapshot = normalizeInventoryRowForStream({
      container,
      stackId: this.nextTravelTicketStackId(container),
      item: `Travel Ticket — ${this.travelCityLabel(origin.city)} to ${this.travelCityLabel(destination.city)}`,
      itemId: travelTicketNumericItemId,
      itemKey: travelTicketItemKey,
      variantId: Math.max(1, Math.trunc(commandId)),
      quantity: 1,
      reserved: 0,
      available: 1,
      metadata: { travelTicket: ticket },
    });
    this.travelTicketRows.set(ticketId, row);
    this.mergeTravelTicketRowsIntoInventory();
  }

  private consumeTravelTicket(row: RustAuthorityInventorySnapshot, ticketId: string): void {
    this.travelTicketRows.delete(ticketId);
    for (const [candidateTicketId, candidateRow] of this.travelTicketRows) {
      if (candidateRow.container === row.container && candidateRow.stackId === row.stackId) {
        this.travelTicketRows.delete(candidateTicketId);
      }
    }
    this.mergeTravelTicketRowsIntoInventory();
  }

  private teleportActorToTravelDestination(actor: AuthorityActor, ticket: TravelTicketData): void {
    actor.areaId = ticket.destAreaId;
    actor.x = ticket.destSpawn.x;
    actor.y = ticket.destSpawn.y;
    actor.direction = "front";
    actor.route = [];
    actor.routeIndex = 0;
    actor.nextMoveTick = this.tick;
    this.invalidateActorSpatialIndex();
  }

  private travelTicketRowForCommand(
    actor: AuthorityActor,
    payload: { container?: string; stack_id?: string; ticket_id?: string; item_id?: string; item_numeric_id?: number; variant_id?: number },
  ): RustAuthorityInventorySnapshot | null {
    if (payload.item_id !== undefined && payload.item_id !== travelTicketItemKey) return null;
    if (payload.item_numeric_id !== undefined && payload.item_numeric_id !== travelTicketNumericItemId) return null;
    if (payload.ticket_id) {
      const row = this.travelTicketRows.get(payload.ticket_id);
      if (row && this.actorOwnsInventoryContainer(actor.id, row.container)) return row;
      return null;
    }
    const stackId = payload.stack_id?.trim();
    const container = payload.container?.trim();
    const rows = [...this.travelTicketRows.values()]
      .filter((row) => this.actorOwnsInventoryContainer(actor.id, row.container))
      .filter((row) => !container || row.container === container)
      .filter((row) => !stackId || String(row.stackId) === stackId)
      .filter((row) => payload.variant_id === undefined || row.variantId === payload.variant_id)
      .sort((left, right) => left.container.localeCompare(right.container) || left.stackId - right.stackId);
    if (rows.length > 0) return rows[0] ?? null;
    if (payload.item_id === travelTicketItemKey || payload.item_numeric_id === travelTicketNumericItemId) return null;
    return null;
  }

  private travelTicketDataFromRow(row: RustAuthorityInventorySnapshot): TravelTicketData | null {
    const metadata = row.metadata as { travelTicket?: unknown } | undefined;
    const ticket = metadata?.travelTicket;
    if (!ticket || typeof ticket !== "object" || Array.isArray(ticket)) return null;
    const record = ticket as Record<string, unknown>;
    const destSpawn = record.destSpawn;
    if (!destSpawn || typeof destSpawn !== "object" || Array.isArray(destSpawn)) return null;
    const spawn = destSpawn as Record<string, unknown>;
    const spawnX = integerValue(spawn.x);
    const spawnY = integerValue(spawn.y);
    const data = {
      ticketId: stringValue(record.ticketId),
      fromPlanetId: stringValue(record.fromPlanetId),
      fromCityId: stringValue(record.fromCityId),
      toPlanetId: stringValue(record.toPlanetId),
      toCityId: stringValue(record.toCityId),
      originTerminalPropId: stringValue(record.originTerminalPropId),
      originAreaId: stringValue(record.originAreaId),
      destAreaId: stringValue(record.destAreaId),
    };
    if (
      !data.ticketId
      || !data.fromPlanetId
      || !data.fromCityId
      || !data.toPlanetId
      || !data.toCityId
      || !data.originTerminalPropId
      || !data.originAreaId
      || !data.destAreaId
      || spawnX === null
      || spawnY === null
    ) {
      return null;
    }
    return {
      ...data,
      destSpawn: { x: spawnX, y: spawnY },
    };
  }

  private travelCityForTerminal(terminalPropId: string): { planet: SliceTravelCatalogPlanet; city: SliceTravelCatalogCity } | null {
    const catalog = this.travelCatalog;
    if (!catalog) return null;
    for (const planet of catalog.planets) {
      for (const city of planet.cities) {
        if (city.terminalPropId === terminalPropId) return { planet, city };
      }
    }
    return null;
  }

  private travelCityByDestination(planetId: string, cityId: string): { planet: SliceTravelCatalogPlanet; city: SliceTravelCatalogCity } | null {
    const catalog = this.travelCatalog;
    if (!catalog) return null;
    for (const planet of catalog.planets) {
      if (planet.id !== planetId) continue;
      for (const city of planet.cities) {
        if (city.id === cityId) return { planet, city };
      }
    }
    return null;
  }

  private travelCityAreaId(entry: { planet: SliceTravelCatalogPlanet; city: SliceTravelCatalogCity }): string {
    const areaId = entry.city.areaId ?? entry.planet.areaId ?? "";
    return areaId;
  }

  private travelCityLabel(city: SliceTravelCatalogCity): string {
    const label = city.label || city.id;
    return label;
  }

  private travelTerminalProp(propId: string): SliceProp | null {
    const prop = this.props.get(propId);
    if (!prop || prop.kind !== "travel_terminal" || prop.interactive !== true) return null;
    return prop;
  }

  private nearbyTravelTerminal(actor: AuthorityActor): SliceProp | null {
    const terminals = [...this.props.values()]
      .filter((prop) => prop.kind === "travel_terminal" && prop.interactive === true && prop.areaId === actor.areaId)
      .filter((prop) => this.actorWithinPropRadius(actor, prop, travelTerminalInteractionRadiusCells))
      .sort((left, right) => left.id.localeCompare(right.id));
    return terminals[0] ?? null;
  }

  private actorWithinPropRadius(actor: AuthorityActor, prop: SliceProp, radiusCells: number): boolean {
    const actorX = cellToMilli(actor.x);
    const actorY = cellToMilli(actor.y);
    const left = Math.trunc(prop.cell.x) * milliCellsPerCell;
    const top = Math.trunc(prop.cell.y) * milliCellsPerCell;
    const right = Math.trunc(prop.cell.x + Math.max(1, prop.size.w)) * milliCellsPerCell;
    const bottom = Math.trunc(prop.cell.y + Math.max(1, prop.size.h)) * milliCellsPerCell;
    const dx = actorX < left ? left - actorX : actorX > right ? actorX - right : 0;
    const dy = actorY < top ? top - actorY : actorY > bottom ? actorY - bottom : 0;
    const radius = Math.max(0, Math.trunc(radiusCells * milliCellsPerCell));
    return dx * dx + dy * dy <= radius * radius;
  }

  private actorWithinDoorRadius(actor: AuthorityActor, prop: SliceProp): boolean {
    const door = prop.door;
    if (!door) return false;
    const actorX = cellToMilli(actor.x);
    const actorY = cellToMilli(actor.y);
    const centerX = Math.trunc(prop.cell.x * milliCellsPerCell) + door.blocker.xMilli + Math.trunc(door.blocker.wMilli / 2);
    const centerY = Math.trunc(prop.cell.y * milliCellsPerCell) + door.blocker.yMilli + Math.trunc(door.blocker.hMilli / 2);
    const radiusCells = typeof door.interactRadiusCells === "number" && Number.isFinite(door.interactRadiusCells)
      ? door.interactRadiusCells
      : 2.2;
    const radius = Math.max(0, Math.trunc(radiusCells * milliCellsPerCell));
    const dx = actorX - centerX;
    const dy = actorY - centerY;
    return dx * dx + dy * dy <= radius * radius;
  }

  private actorOwnsInventoryContainer(actorId: string, container: string): boolean {
    if (container === actorId) return true;
    return container.startsWith(`${actorId}:`) || container.startsWith(`${actorId}/`);
  }

  private inventoryRowsForSession(session: GameSession, actor = this.actors.get(session.actorId)): RustAuthorityInventorySnapshot[] {
    if (!actor) return [];
    return this.inventory
      .filter((row) => this.inventoryContainerVisibleToActor(actor, row.container, row.itemId))
      .map((row) => ({ ...row }));
  }

  private reservationsForSession(
    session: GameSession,
    actor = this.actors.get(session.actorId),
    visibleInventory = this.inventoryRowsForSession(session, actor),
  ): RustAuthorityReservationSnapshot[] {
    if (!actor) return [];
    const visibleContainers = new Set(visibleInventory.map((row) => row.container));
    return this.reservations
      .filter((row) => row.actor === actor.id || visibleContainers.has(row.from) || this.inventoryContainerVisibleToActor(actor, row.from))
      .map((row) => ({ ...row }));
  }

  private inventoryContainerVisibleToActor(actor: AuthorityActor, container: string, itemId?: number): boolean {
    if (this.actorOwnsInventoryContainer(actor.id, container)) return true;
    if (container === "district-exchange") return this.actorCanUseDistrictExchange(actor);
    const authoredLootContainer = [...this.props.values()].some((prop) => (
      prop.container === container && isLootCacheProp(prop)
    ));
    if (container.startsWith("corpse:") || container.startsWith("cache:") || authoredLootContainer) {
      return this.actorCanTakeLootFromContainer(actor, container);
    }
    return this.actorCanUseAmmoStockpileContainer(actor, container, itemId);
  }

  private actorCanUseDistrictExchange(actor: AuthorityActor): boolean {
    return actor.lifeState === "alive" && [...this.props.values()].some((prop) => (
      prop.areaId === actor.areaId
        && isExchangeContainerProp(prop)
        && this.actorCanAccessExchangeContainer(actor, prop)
        && this.actorWithinPropRadius(actor, prop, exchangeInteractionRadiusCells)
    ));
  }

  private actorCanAccessExchangeContainer(actor: AuthorityActor, prop: SliceProp): boolean {
    const permissions = exchangeContainerPermissions(prop);
    if (!permissions.ownerActorId && permissions.allowedActorIds.size === 0 && permissions.allowedFactionIds.size === 0) {
      return true;
    }
    return permissions.ownerActorId === actor.id
      || permissions.allowedActorIds.has(actor.id)
      || (actor.factionId !== null && permissions.allowedFactionIds.has(actor.factionId));
  }

  private actorCanTakeLootFromContainer(actor: AuthorityActor, container: string): boolean {
    if (actor.lifeState !== "alive" || actor.sleep.remainingMs > 0) return false;
    const source = this.lootSourceForContainer(container);
    if (!source || source.areaId !== actor.areaId) return false;
    if (source.lootRightsActorId !== null && source.lootRightsActorId !== actor.id) return false;
    const actorX = cellToMilli(actor.x);
    const actorY = cellToMilli(actor.y);
    const radius = Math.trunc(harvestInteractionRadiusCells * milliCellsPerCell);
    const dx = actorX - source.xMilli;
    const dy = actorY - source.yMilli;
    return dx * dx + dy * dy <= radius * radius;
  }

  private lootSourceForContainer(container: string): { areaId: string; xMilli: number; yMilli: number; lootRightsActorId: string | null } | null {
    const corpseActorId = container.startsWith("corpse:") ? container.slice("corpse:".length) : "";
    const playerCorpse = this.lastRustAuthorityPlayerCorpses.find((corpse) => (
      corpse.container === container
        && corpse.expiryTick > this.tick
        && corpse.hasItems
    ));
    if (playerCorpse) {
      return {
        areaId: playerCorpse.areaId,
        xMilli: cellToMilli(playerCorpse.x),
        yMilli: cellToMilli(playerCorpse.y),
        lootRightsActorId: null,
      };
    }
    if (corpseActorId) {
      const target = this.actors.get(corpseActorId);
      if (!target || !this.corpseContainerIsLootableItemSource(target, container)) return null;
      return {
        areaId: target.areaId,
        xMilli: cellToMilli(target.x),
        yMilli: cellToMilli(target.y),
        lootRightsActorId: target.lootRightsActorId,
      };
    }
    const prop = [...this.props.values()].find((candidate) => (
      isLootCacheProp(candidate)
        && (candidate.container === container || (!candidate.container && container === `cache:${candidate.id}`))
    ));
    if (!prop) return null;
    if (this.propStates.get(prop.id)?.cacheEmptied === true) return null;
    return {
      areaId: prop.areaId,
      xMilli: Math.trunc(prop.cell.x * milliCellsPerCell) + Math.trunc(Math.max(1, prop.size.w) * milliCellsPerCell / 2),
      yMilli: Math.trunc(prop.cell.y * milliCellsPerCell) + Math.trunc(Math.max(1, prop.size.h) * milliCellsPerCell / 2),
      lootRightsActorId: null,
    };
  }

  private corpseContainerIsLootableItemSource(actor: AuthorityActor, container: string): boolean {
    return actor.lifeState === "downed"
      && actor.bodyVanishAtTick > 0
      && this.tick < actor.bodyVanishAtTick
      && !isPlayerLikeActor(actor)
      && this.lootContainerHasAvailableItems(container);
  }

  private lootContainerHasAvailableItems(container: string): boolean {
    return this.inventory.some((row) => row.container === container && row.available > 0);
  }

  private actorCanUseAmmoStockpileContainer(actor: AuthorityActor, container: string, itemId?: number): boolean {
    if (actor.lifeState !== "alive" || actor.sleep.remainingMs > 0) return false;
    if (itemId !== undefined && itemId !== 1101) return false;
    if (!container.endsWith(":ammo-stockpile")) return false;
    const propId = container.slice(0, -":ammo-stockpile".length);
    const prop = this.props.get(propId);
    if (!prop || !isAmmoStockpileProp(prop) || prop.areaId !== actor.areaId) return false;
    const factionId = ammoStockpileFaction(prop);
    if (factionId !== null && actor.factionId !== factionId) return false;
    const center = propCenterMilli(prop);
    const actorX = cellToMilli(actor.x);
    const actorY = cellToMilli(actor.y);
    const radius = Math.trunc(ammoRefillRadiusCells * milliCellsPerCell);
    const dx = actorX - center.xMilli;
    const dy = actorY - center.yMilli;
    return dx * dx + dy * dy <= radius * radius;
  }

  private knownInventoryRows(session: GameSession): Map<string, RustAuthorityInventorySnapshot> {
    session.knownInventoryRows ??= new Map<string, RustAuthorityInventorySnapshot>();
    return session.knownInventoryRows;
  }

  private knownReservationRows(session: GameSession): Map<string, RustAuthorityReservationSnapshot> {
    session.knownReservationRows ??= new Map<string, RustAuthorityReservationSnapshot>();
    return session.knownReservationRows;
  }

  private hasInventoryStateDeltaForSession(session: GameSession): boolean {
    const actor = this.actors.get(session.actorId);
    const inventory = this.inventoryRowsForSession(session, actor);
    if (this.inventoryRowsChanged(session, inventory)) return true;
    return this.reservationRowsChanged(session, this.reservationsForSession(session, actor, inventory));
  }

  private inventoryDeltaForSession(
    session: GameSession,
    rows: RustAuthorityInventorySnapshot[],
  ): RustAuthorityInventorySnapshot[] | undefined {
    if (!this.inventoryRowsChanged(session, rows)) return undefined;
    this.replaceKnownInventoryRows(session, rows);
    return rows.map((row) => ({ ...row }));
  }

  private reservationDeltaForSession(
    session: GameSession,
    rows: RustAuthorityReservationSnapshot[],
  ): RustAuthorityReservationSnapshot[] | undefined {
    if (!this.reservationRowsChanged(session, rows)) return undefined;
    this.replaceKnownReservationRows(session, rows);
    return rows.map((row) => ({ ...row }));
  }

  private inventoryRowsChanged(session: GameSession, rows: RustAuthorityInventorySnapshot[]): boolean {
    return !sameInventoryRowsByKey(this.knownInventoryRows(session), rows);
  }

  private reservationRowsChanged(session: GameSession, rows: RustAuthorityReservationSnapshot[]): boolean {
    return !sameReservationRowsByKey(this.knownReservationRows(session), rows);
  }

  private replaceKnownInventoryRows(session: GameSession, rows: RustAuthorityInventorySnapshot[]): void {
    const known = this.knownInventoryRows(session);
    known.clear();
    for (const row of rows) known.set(inventoryRowKey(row), { ...row });
  }

  private replaceKnownReservationRows(session: GameSession, rows: RustAuthorityReservationSnapshot[]): void {
    const known = this.knownReservationRows(session);
    known.clear();
    for (const row of rows) known.set(reservationRowKey(row), { ...row });
  }

  private nextInventoryStackId(container: string): number {
    let maxStackId = 0;
    for (const row of this.inventory) {
      if (row.container !== container || !Number.isFinite(row.stackId)) continue;
      maxStackId = Math.max(maxStackId, Math.trunc(row.stackId));
    }
    return maxStackId + 1;
  }

  private nextTravelTicketStackId(container: string): number {
    let maxStackId = 0;
    for (const row of this.inventory) {
      if (row.container !== container || !Number.isFinite(row.stackId)) continue;
      maxStackId = Math.max(maxStackId, Math.trunc(row.stackId));
    }
    const current = this.travelTicketStackCounters.get(container) ?? maxStackId + 1;
    const next = Math.max(current, maxStackId + 1);
    this.travelTicketStackCounters.set(container, next + 1);
    return next;
  }

  private applyCloneRespawn(actor: AuthorityActor, facilityId: string | null): ApplyCommandResult {
    if (!this.isSessionActor(actor.id) && !isPlayerLikeActor(actor)) {
      return { accepted: false, reasonCode: "invalid_clone_respawn", events: [] };
    }
    const facility = this.cloneFacilityForRespawn(facilityId);
    if (facilityId !== null && !facility) {
      return { accepted: false, reasonCode: "unknown_clone_facility", events: [] };
    }
    if (!facility) {
      return { accepted: false, reasonCode: "no_clone_facility", events: [] };
    }
    if (actor.lifeState === "alive") {
      return { accepted: false, reasonCode: "invalid_clone_respawn", events: [] };
    }
    this.respawnActor(actor, facility);
    return { accepted: true, events: [] };
  }

  private isDeadBodyWaitingForRespawn(actor: AuthorityActor): boolean {
    return actor.lifeState === "downed" && actor.bodyVanishAtTick > this.tick;
  }

  private actorIsAsleep(actor: AuthorityActor): boolean {
    return actor.sleep.active && actor.sleep.remainingMs > 0;
  }

  private killActorForRespawn(actor: AuthorityActor): void {
    actor.vitals = { health: 0, action: 0, spirit: 0 };
    this.clearActorTransientRespawnState(actor);
    if (this.usesNpcCorpseRespawnTimer(actor)) {
      setActorLifeState(actor, "downed");
      const respawnTiming = npcRespawnTimingSeconds(actor);
      actor.bodyVanishAtTick = this.tick + Math.round(respawnTiming.bodyVisible * this.tickRateHz);
      actor.respawnAtTick = this.tick + Math.round((respawnTiming.bodyVisible + respawnTiming.hiddenDelay) * this.tickRateHz);
      this.addStatus(actor, "dead", "Dead", 3, respawnTiming.bodyVisible * 1000);
      this.invalidateActorSpatialIndex();
      return;
    }
    setActorLifeState(actor, "respawning");
    actor.bodyVanishAtTick = 0;
    actor.respawnAtTick = this.tick + 90;
    this.addStatus(actor, "dead", "Dead", 3, 4_500);
    this.invalidateActorSpatialIndex();
  }

  private usesNpcCorpseRespawnTimer(actor: AuthorityActor): boolean {
    return !isPlayerLikeActor(actor) && !actor.id.startsWith("game-ws-") && !this.isSessionActor(actor.id);
  }

  private clearActorTransientRespawnState(actor: AuthorityActor): void {
    actor.bleed = inactiveBleed();
    actor.statuses = actor.statuses.filter((status) => (
      status.id !== "downed" &&
      status.id !== "bleeding" &&
      status.id !== "suppressed" &&
      status.id !== "sleeping" &&
      status.id !== "dead"
    ));
    actor.suppression = inactiveSuppression();
    actor.sleep = inactiveSleep();
    actor.nextBleedStackId = 1;
    actor.nextMoveTick = 0;
    actor.sprintRegenBlockedUntilTick = 0;
    actor.recentIncomingDamage = 0;
  }

  private tickSleep(dtMs: number): void {
    for (const actor of this.actors.values()) {
      if (!actor.sleep.active) continue;
      actor.sleep.remainingMs = Math.max(0, actor.sleep.remainingMs - dtMs);
      if (actor.sleep.remainingMs > 0) continue;
      actor.sleep = inactiveSleep();
      actor.statuses = actor.statuses.filter((status) => status.id !== "sleeping");
      this.markStatusDirty(actor.id);
    }
  }

  private recalculateBleed(actor: AuthorityActor): void {
    actor.bleed.stacks = actor.bleed.stacks.filter((stack) => stack.remainingMs > 0).slice(0, 5);
    if (actor.bleed.stacks.length === 0) {
      actor.bleed = inactiveBleed();
      actor.statuses = actor.statuses.filter((status) => status.id !== "bleeding");
      return;
    }
    const rates = { health: 0, action: 0, spirit: 0 };
    let severity = 0;
    for (const stack of actor.bleed.stacks) {
      severity += stack.severity;
      rates.health += stack.ratesPerSecond.health;
      rates.action += stack.ratesPerSecond.action;
      rates.spirit += stack.ratesPerSecond.spirit;
    }
    actor.bleed.active = true;
    actor.bleed.stackCount = actor.bleed.stacks.length;
    actor.bleed.severity = round(Math.min(5, severity));
    actor.bleed.remainingMs = Math.max(...actor.bleed.stacks.map((stack) => stack.remainingMs));
    actor.bleed.ratesPerSecond = {
      health: round(rates.health),
      action: round(rates.action),
      spirit: round(rates.spirit),
    };
    this.addStatus(actor, "bleeding", `Bleed S${Math.max(1, Math.ceil(actor.bleed.severity))} x${actor.bleed.stackCount}`, 2, actor.bleed.remainingMs);
  }

  private tickBleeds(dtMs: number): void {
    const dtSeconds = dtMs / 1000;
    for (const actor of this.actors.values()) {
      actor.recentIncomingDamage *= 0.96;
      if (actor.lifeState === "respawning") {
        if (actor.respawnAtTick > 0 && this.tick >= actor.respawnAtTick) this.respawnActor(actor);
        continue;
      }
      if (actor.lifeState === "downed" && actor.bodyVanishAtTick > 0) {
        if (this.tick >= actor.bodyVanishAtTick) {
          setActorLifeState(actor, "respawning");
          this.invalidateActorSpatialIndex();
          actor.bodyVanishAtTick = 0;
          this.clearActorTransientRespawnState(actor);
          this.markDetailDirty(actor.id);
        }
        continue;
      }
      if (!actor.bleed.active) continue;
      const hadBleed = actor.bleed.active;
      for (const stack of actor.bleed.stacks) stack.remainingMs = Math.max(0, stack.remainingMs - dtMs);
      this.recalculateBleed(actor);
      if (!actor.bleed.active) {
        if (hadBleed) {
          if (this.isSessionActor(actor.id)) this.markDetailDirty(actor.id);
          else this.markStatusDirty(actor.id);
        }
        continue;
      }
      const downedMultiplier = actor.lifeState === "downed" ? 8.5 : 1;
      actor.vitals.health = Math.max(-actor.maxVitals.health, actor.vitals.health - actor.bleed.ratesPerSecond.health * dtSeconds * downedMultiplier);
      actor.vitals.action = Math.max(0, actor.vitals.action - actor.bleed.ratesPerSecond.action * dtSeconds * downedMultiplier);
      actor.vitals.spirit = Math.max(0, actor.vitals.spirit - actor.bleed.ratesPerSecond.spirit * dtSeconds * downedMultiplier);
      if (actor.lifeState === "alive" && actor.vitals.health <= 0) {
        setActorLifeState(actor, "downed");
        this.invalidateActorSpatialIndex();
        this.addStatus(actor, "downed", "Downed", 3, 14_000);
        this.markDetailDirty(actor.id);
        continue;
      }
      if (actor.lifeState === "downed" && actor.vitals.action <= 0 && actor.vitals.spirit <= 0) {
        const alreadyDead = this.isDeadBodyWaitingForRespawn(actor);
        this.killActorForRespawn(actor);
        if (!alreadyDead) this.counters.deaths += 1;
        this.markDetailDirty(actor.id);
        continue;
      }
      if (this.isSessionActor(actor.id)) this.markDetailDirty(actor.id);
    }
  }

  private tickPassiveRegen(dtMs: number): void {
    const dtSeconds = dtMs / 1000;
    for (const actor of this.actors.values()) {
      if (actor.lifeState !== "alive" || actor.bleed.active || this.actorIsAsleep(actor)) continue;
      const before = { ...actor.vitals };
      // Parity with Rust tick_passive_regen: player-like actors regen to their
      // full (possibly fixture-raised) max pools at a boosted health rate;
      // NPCs keep the spawn-vitals wound cap.
      const playerLike = isPlayerLikeActor(actor);
      const healthTarget = playerLike
        ? actor.maxVitals.health
        : Math.min(actor.effectiveStats.spawnVitals.health, actor.maxVitals.health);
      const healthRate = playerLike
        ? Math.max(actor.effectiveStats.regenRatesPerSecond.health, 6)
        : actor.effectiveStats.regenRatesPerSecond.health;
      actor.vitals.health = regenVital(actor.vitals.health, healthTarget, healthRate, dtSeconds);
      if (this.tick > actor.sprintRegenBlockedUntilTick) {
        const actionTarget = playerLike
          ? actor.maxVitals.action
          : Math.min(actor.effectiveStats.spawnVitals.action, actor.maxVitals.action);
        actor.vitals.action = regenVital(
          actor.vitals.action,
          actionTarget,
          actor.effectiveStats.regenRatesPerSecond.action,
          dtSeconds,
        );
      }
      const spiritTarget = playerLike
        ? actor.maxVitals.spirit
        : Math.min(actor.effectiveStats.spawnVitals.spirit, actor.maxVitals.spirit);
      actor.vitals.spirit = regenVital(
        actor.vitals.spirit,
        spiritTarget,
        actor.effectiveStats.regenRatesPerSecond.spirit,
        dtSeconds,
      );
      if (sameVitals(before, actor.vitals)) continue;
      if (this.isSessionActor(actor.id)) this.markDetailDirty(actor.id);
      else this.markStatusDirty(actor.id);
    }
  }

  private tickStatuses(dtMs: number): void {
    for (const actor of this.actors.values()) {
      const previousStatuses = actor.statuses.map(statusSnapshot);
      actor.statuses = actor.statuses
        .map((status) => ({ ...status, remainingMs: Math.max(0, status.remainingMs - dtMs) }))
        .filter((status) => status.remainingMs > 0 || (status.id === "bleeding" && actor.bleed.active));
      const nextStatuses = actor.statuses.map(statusSnapshot);
      if (!sameStatusSnapshots(previousStatuses, nextStatuses)
        && (!sameStatusShapes(previousStatuses, nextStatuses) || this.isSessionActor(actor.id))) {
        this.markStatusDirty(actor.id);
      }
    }
  }

  private respawnActor(actor: AuthorityActor, facilityOverride?: SliceCloneFacility | null): void {
    setActorLifeState(actor, "alive");
    actor.vitals = { ...actor.maxVitals };
    this.clearActorTransientRespawnState(actor);
    actor.statuses = [];
    actor.respawnAtTick = 0;
    actor.bodyVanishAtTick = 0;
    actor.cloneSicknessRemainingMs = 0;
    if (isSkirmisherRole(actor.role)) {
      actor.areaId = actor.homeAreaId;
      actor.x = actor.homeCell.x;
      actor.y = actor.homeCell.y;
      actor.direction = actor.homeDirection;
      actor.route = actor.homeRoute.map((point) => ({ ...point }));
      actor.routeIndex = routeIndexAfterReturn(actor.route, actor.homeCell);
      this.invalidateActorSpatialIndex();
      this.markDetailDirty(actor.id);
      return;
    }
    if (!this.isSessionActor(actor.id) && !isPlayerLikeActor(actor)) {
      actor.areaId = actor.homeAreaId;
      actor.x = actor.homeCell.x;
      actor.y = actor.homeCell.y;
      actor.direction = actor.homeDirection;
      actor.route = actor.homeRoute.map((point) => ({ ...point }));
      actor.routeIndex = routeIndexAfterReturn(actor.route, actor.homeCell);
      this.invalidateActorSpatialIndex();
      this.markDetailDirty(actor.id);
      return;
    }

    const facility = facilityOverride ?? this.cloneFacilityForRespawn();
    if (!facility) {
      actor.areaId = actor.homeAreaId;
      actor.x = actor.homeCell.x;
      actor.y = actor.homeCell.y;
      actor.direction = actor.homeDirection;
      actor.route = actor.homeRoute.map((point) => ({ ...point }));
      actor.routeIndex = routeIndexAfterReturn(actor.route, actor.homeCell);
      this.invalidateActorSpatialIndex();
      this.markDetailDirty(actor.id);
      return;
    }

    const respawnCell = this.clampedUnblockedCell(facility.areaId, facility.respawnCell.x, facility.respawnCell.y);
    actor.areaId = facility.areaId;
    actor.x = respawnCell.x;
    actor.y = respawnCell.y;
    actor.direction = normalizeDirection(facility.respawnFacing);
    actor.route = [];
    actor.routeIndex = 0;
    actor.cloneSicknessRemainingMs = Math.max(0, Math.round(facility.sicknessDurationMs ?? 0));
    this.invalidateActorSpatialIndex();
    this.markDetailDirty(actor.id);
  }

  private addStatus(
    actor: AuthorityActor,
    id: string,
    label: string,
    severity: number,
    remainingMs: number,
    metadata: Pick<AuthorityStatus, "stacks" | "threshold"> = {},
  ): void {
    const existing = actor.statuses.find((status) => status.id === id);
    if (existing) {
      existing.label = label;
      existing.severity = Math.max(existing.severity, severity);
      existing.remainingMs = Math.max(existing.remainingMs, remainingMs);
      if (metadata.stacks !== undefined) existing.stacks = metadata.stacks;
      else delete existing.stacks;
      if (metadata.threshold !== undefined) existing.threshold = metadata.threshold;
      else delete existing.threshold;
      return;
    }
    actor.statuses.push({ id, label, severity, remainingMs, ...metadata });
  }

  private clampedUnblockedCell(areaId: string, x: number, y: number): Cell {
    const area = this.areas.get(areaId);
    const clamped = {
      x: Math.max(1, Math.min((area?.width ?? 64) - 2, Math.round(x))),
      y: Math.max(1, Math.min((area?.height ?? 36) - 2, Math.round(y))),
    };
    const blocked = this.blockedByArea.get(areaId);
    if (!blocked || blocked.size === 0) return clamped;
    return blocked.has(cellKey(clamped.x, clamped.y)) ? {
      x: Math.max(1, Math.min((area?.width ?? 64) - 2, Math.floor(x))),
      y: Math.max(1, Math.min((area?.height ?? 36) - 2, Math.floor(y))),
    } : clamped;
  }

  private clampedUnblockedUnoccupiedCell(areaId: string, x: number, y: number, actorId: string): Cell {
    const area = this.areas.get(areaId);
    const maxX = (area?.width ?? 64) - 2;
    const maxY = (area?.height ?? 36) - 2;
    const origin = this.clampedUnblockedCell(areaId, x, y);
    if (!this.isBlocked(areaId, origin.x, origin.y) && !this.actorOccupiesCell(areaId, origin.x, origin.y, actorId)) {
      return origin;
    }
    const maxRadius = Math.max(maxX, maxY);
    for (let radius = 1; radius <= maxRadius; radius += 1) {
      for (let dy = -radius; dy <= radius; dy += 1) {
        for (let dx = -radius; dx <= radius; dx += 1) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== radius) continue;
          const candidate = {
            x: Math.max(1, Math.min(maxX, origin.x + dx)),
            y: Math.max(1, Math.min(maxY, origin.y + dy)),
          };
          if (this.isBlocked(areaId, candidate.x, candidate.y)) continue;
          if (this.actorOccupiesCell(areaId, candidate.x, candidate.y, actorId)) continue;
          return candidate;
        }
      }
    }
    return origin;
  }

  private actorOccupiesCell(areaId: string, x: number, y: number, exceptActorId: string): boolean {
    for (const actor of this.actors.values()) {
      if (actor.id === exceptActorId || actor.areaId !== areaId || actor.lifeState === "respawning") continue;
      if (Math.floor(actor.x) === x && Math.floor(actor.y) === y) return true;
    }
    return false;
  }

  private clampedUnblockedPosition(areaId: string, currentX: number, currentY: number, x: number, y: number): Cell {
    const area = this.areas.get(areaId);
    const clamped = {
      x: Math.max(1, Math.min((area?.width ?? 64) - 2, x)),
      y: Math.max(1, Math.min((area?.height ?? 36) - 2, y)),
    };
    const blocked = this.blockedByArea.get(areaId);
    if (!blocked || blocked.size === 0 || !blocked.has(cellKey(clamped.x, clamped.y))) return clamped;
    const dx = clamped.x - currentX;
    const dy = clamped.y - currentY;
    const xCandidate = { x: clamped.x, y: currentY };
    const yCandidate = { x: currentX, y: clamped.y };
    const candidates = Math.abs(dx) >= Math.abs(dy)
      ? [xCandidate, yCandidate]
      : [yCandidate, xCandidate];
    for (const candidate of candidates) {
      if ((candidate.x !== currentX || candidate.y !== currentY) && !blocked.has(cellKey(candidate.x, candidate.y))) {
        return candidate;
      }
    }
    return { x: currentX, y: currentY };
  }

  private isBlocked(areaId: string, x: number, y: number): boolean {
    const blocked = this.blockedByArea.get(areaId);
    if (!blocked || blocked.size === 0) return false;
    return blocked.has(cellKey(Math.floor(x), Math.floor(y)));
  }

  private outsideArea(areaId: string, x: number, y: number): boolean {
    const area = this.areas.get(areaId);
    if (!area) return true;
    return x < 0 || y < 0 || x >= area.width || y >= area.height;
  }

  private shouldAdvanceLiveAuthority(): boolean {
    return this.activeDebugClockAdvance !== null || this.sessions.size > 0 || this.hasLinkDeadActors();
  }

  private hasLinkDeadActors(): boolean {
    for (const actor of this.actors.values()) {
      if (actor.linkDead) return true;
    }
    return false;
  }

  private flushSnapshots(options: { force?: boolean } = {}): void {
    const now = this.clock.nowMs();
    const flushStartedAt = Date.now();
    if (!options.force && now < this.deferSnapshotsUntilMs && now - this.lastSnapshotFlushMs < maxSnapshotDeferMs) return;
    this.lastSnapshotFlushMs = now;
    if (this.rustAuthorityMode === "live") {
      if (options.force) {
        void this.advanceLiveRustAuthorityTick(options);
        return;
      }
      if (this.rustAuthorityFlushInFlight) return;
      this.finishFlushSnapshots(now, []);
      return;
    }
    const tickCount = this.consumeAuthorityTickCount(now, options.force === true);
    if (tickCount <= 0) {
      this.authorityZeroTickFlushCount += 1;
      return;
    }
    this.recordAuthorityTickStep(tickCount);
    this.finishFlushSnapshots(now, this.advanceTick(tickCount));
    this.authorityFlushDurationTiming.record(Date.now() - flushStartedAt);
  }

  private async advanceLiveRustAuthorityTick(options: { force?: boolean } = {}): Promise<void> {
    const now = this.clock.nowMs();
    const flushStartedAt = Date.now();
    if (this.rustAuthorityMode !== "live" || !this.rustAuthorityBridge) return;
    await this.awaitRustAuthorityReady();
    if (!options.force && !this.shouldAdvanceLiveAuthority()) {
      this.resetAuthorityTickClock(now);
      return;
    }
    if (this.rustAuthorityFlushInFlight) {
      this.authoritySkippedInFlightCount += 1;
      this.resetAuthorityTickClock(now);
      return;
    }

    const tickCount = this.consumeDebugAuthorityTickCount();
    if (tickCount <= 0) return;
    this.recordAuthorityTickStep(tickCount);
    this.rustAuthorityFlushInFlight = true;
    try {
      // Manual-clock batches can exercise the full generated population.
      const output = await this.submitRustAuthorityTicks(tickCount, this.tick);
      const events = this.applyRustAuthorityTickOutput(output);
      this.appendCombatEventJournal(events);
      this.finishFlushSnapshots(now, events);
      this.authorityFlushDurationTiming.record(Date.now() - flushStartedAt);
    } catch (error) {
      this.logger?.warn({ error }, "rust authority live tick failed; retaining last authoritative state");
    } finally {
      this.rustAuthorityFlushInFlight = false;
    }
  }

  private scheduleLiveRustAuthorityTick(now = this.clock.monotonicMs()): void {
    if (this.closed || this.rustAuthorityMode !== "live") return;
    if (this.liveAuthorityNextTickAtMs <= 0) {
      this.liveAuthorityNextTickAtMs = now + this.authorityIntervalMs;
    }
    const delayMs = Math.max(0, this.liveAuthorityNextTickAtMs - now);
    this.rustAuthorityInterval = this.clock.setTimeout(() => this.runLiveRustAuthorityTickLoop(), delayMs);
  }

  private async runLiveRustAuthorityTickLoop(): Promise<void> {
    if (this.closed || this.rustAuthorityMode !== "live") return;
    if (this.liveAuthorityNextTickAtMs <= 0) {
      this.liveAuthorityNextTickAtMs = this.clock.monotonicMs();
    }
    this.liveAuthorityNextTickAtMs += this.authorityIntervalMs;
    await this.advanceLiveRustAuthorityTick();
    if (this.closed || this.rustAuthorityMode !== "live") return;
    const now = this.clock.monotonicMs();
    if (this.liveAuthorityNextTickAtMs < now - this.authorityIntervalMs) {
      this.liveAuthorityNextTickAtMs = now;
    }
    this.scheduleLiveRustAuthorityTick(now);
  }

  private recordAuthorityTickStep(tickCount: number): void {
    this.authorityFlushCount += 1;
    this.lastAuthorityTickCount = tickCount;
    this.maxAuthorityTickCount = Math.max(this.maxAuthorityTickCount, tickCount);
    this.authorityTickStepTiming.record(tickCount);
  }

  private consumeDebugAuthorityTickCount(): number {
    const active = this.activeDebugClockAdvance;
    if (!active) return 1;
    if (active.callbacksRemaining <= 0) return 1;
    active.callbacksRemaining -= 1;
    if (active.skipCallbacks > 0) {
      active.skipCallbacks -= 1;
      return 0;
    }

    const tickCount = Math.min(active.callbacksRemaining + 1, maxRustAuthorityTickRequestTicks);
    active.skipCallbacks = tickCount - 1;
    active.authorityBridgeRequests += 1;
    active.authorityBridgeTicks += tickCount;
    if (tickCount > 1) active.authorityBridgeBatchedRequests += 1;
    active.authorityBridgeMaxTicksPerRequest = Math.max(active.authorityBridgeMaxTicksPerRequest, tickCount);
    return tickCount;
  }

  private consumeAuthorityTickCount(now: number, force: boolean): number {
    if (force) {
      this.lastAuthorityAdvanceMs = now;
      this.authorityTickRemainderMs = 0;
      return Math.max(1, Math.round((this.snapshotIntervalMs / 1000) * this.tickRateHz));
    }
    const tickMs = 1000 / Math.max(1, this.tickRateHz);
    const elapsedMs = Math.max(0, now - this.lastAuthorityAdvanceMs);
    this.lastAuthorityAdvanceMs = now;
    this.authorityTickRemainderMs = Math.min(1000, this.authorityTickRemainderMs + elapsedMs);
    const ticks = Math.floor(this.authorityTickRemainderMs / tickMs);
    if (ticks <= 0) return 0;
    const safeTicks = Math.min(maxAuthorityTicksPerFlush, ticks);
    this.authorityTickRemainderMs = Math.max(0, this.authorityTickRemainderMs - safeTicks * tickMs);
    return safeTicks;
  }

  private resetAuthorityTickClock(now: number): void {
    this.lastAuthorityAdvanceMs = now;
    this.authorityTickRemainderMs = 0;
  }

  private finishFlushSnapshots(
    now: number,
    events: GameCombatEvent[],
  ): void {
    const snapshotBuildStartedAt = Date.now();
    this.recordDeferredDirtyActorHighWater();
    if (events.length > 0) this.queueCombatEvents(events);
    const dirtyActorIds = [...this.dirtyActorIds];
    const highDetailDirtyActorIds = new Set(this.highDetailDirtyActorIds);
    const statusDirtyActorIds = new Set(this.statusDirtyActorIds);
    this.dirtyActorIds.clear();
    this.highDetailDirtyActorIds.clear();
    this.statusDirtyActorIds.clear();
    const hasSessionWork = [...this.sessions.values()].some((session) => (
      session.needsFullSnapshot
        || session.interestDirty
        || session.pendingReceipts.length > 0
        || session.pendingEvents.length > 0
        || session.pendingAbilityQueueEvents.length > 0
    ));
    const hasDeferredDirty = [...this.sessions.values()].some((session) => session.deferredDirtyActorIds.size > 0);
    if (!this.dirty && !hasSessionWork && !hasDeferredDirty && dirtyActorIds.length === 0) {
      this.maybeWriteCheckpoint(now);
      this.flushJournalIfNeeded();
      this.snapshotBuildTiming.record(Date.now() - snapshotBuildStartedAt);
      return;
    }
    this.dirty = false;
    const dirtyActorIndex = dirtyActorIds.length > 0 ? this.dirtyActorSpatialIndex(dirtyActorIds) : null;
    let routineSessionsThisFlush = 0;
    let observerUrgentSessionsThisFlush = 0;
    const sessions = [...this.sessions.values()];
    const routineStartIndex = this.nextRoutineSessionId === null
      ? 0
      : Math.max(0, sessions.findIndex((session) => session.id === this.nextRoutineSessionId));
    let nextRoutineSessionId: string | null = null;
    for (let offset = 0; offset < sessions.length; offset += 1) {
      const sessionIndex = (routineStartIndex + offset) % sessions.length;
      const session = sessions[sessionIndex]!;
      if (session.socket.readyState !== websocketOpen) continue;
      if (session.needsFullSnapshot) {
        const snapshot = this.snapshotForSession(session);
        this.replaceKnownActorSnapshots(session, snapshot.actors);
        this.send(session, {
          type: "game.snapshot",
          snapshot,
          receipts: session.pendingReceipts.splice(0),
          events: session.pendingEvents.splice(0),
          abilityQueueEvents: this.takePendingAbilityQueueEvents(session),
        });
        session.lastSnapshotTick = snapshot.tick;
        session.lastActorDeltaTick = snapshot.tick;
        this.clearDeferredDirtyActorIds(session);
        session.needsFullSnapshot = false;
        session.interestDirty = false;
        continue;
      }
      const pendingEventsDue = this.pendingCombatEventsDue(session);
      const packetEvents = pendingEventsDue ? session.pendingEvents : [];
      const eventFocusActors = uniqueActorIds(combatEventActorIds(packetEvents)).slice(0, maxEventFocusActors);
      const eventDetailActors = uniqueActorIds(packetEvents.map((event) => event.targetActorId)).slice(0, maxEventFocusActors);
      const hasVisibleInventoryDelta = this.hasInventoryStateDeltaForSession(session);
      const hasUrgentState = session.pendingReceipts.length > 0
        || pendingEventsDue
        || hasVisibleInventoryDelta
        || session.pendingAbilityQueueEvents.length > 0;
      const interestRefreshDue = session.interestDirty;
      const routineDeltaDue = interestRefreshDue
        || session.lastActorDeltaTick < 0
        || this.tick - session.lastActorDeltaTick >= routineDeltaIntervalTicks;
      const routineBudgeted = routineDeltaDue && !hasUrgentState && !interestRefreshDue;
      if (routineBudgeted) {
        if (routineSessionsThisFlush >= maxRoutineSessionsPerFlush) {
          continue;
        }
        routineSessionsThisFlush += 1;
        nextRoutineSessionId = sessions[(sessionIndex + 1) % sessions.length]?.id ?? null;
      }
      const observerUrgentBudgeted = hasUrgentState
        && !interestRefreshDue
        && session.pendingReceipts.length === 0
        && !this.pendingCombatEventsInvolveSession(session);
      if (observerUrgentBudgeted) {
        if (observerUrgentSessionsThisFlush >= maxObserverUrgentSessionsPerFlush) {
          continue;
        }
        observerUrgentSessionsThisFlush += 1;
      }
      if (!routineDeltaDue && !hasUrgentState) {
        continue;
      }
      const includeRoutineState = routineDeltaDue || interestRefreshDue;
      const relevantHighDetailDirtyActors = includeRoutineState && highDetailDirtyActorIds.size > 0
        ? this.relevantDirtyActorsFor(session, [...highDetailDirtyActorIds])
        : [];
      const deferredDirtyActors = includeRoutineState && session.deferredDirtyActorIds.size > 0
        ? this.relevantDirtyActorsFor(session, [...session.deferredDirtyActorIds])
        : [];
      const relevantDirtyActors = includeRoutineState && dirtyActorIndex
        ? uniqueActorIds([...deferredDirtyActors, ...this.relevantDirtyActorsFromIndex(session, dirtyActorIndex)])
        : deferredDirtyActors;
      const urgentStatusDirtyActors = !includeRoutineState && statusDirtyActorIds.size > 0
        ? this.relevantDirtyActorsFor(session, [...statusDirtyActorIds])
        : [];
      const routineInterestActors = includeRoutineState
        ? this.routineInterestActorIds(session)
        : [];
      const hasKnownActorRemovals = includeRoutineState && this.hasActorRemovalsForSession(session);
      const selfHighDetailDirty = highDetailDirtyActorIds.has(session.actorId);
      const focusActorIds = uniqueActorIds([
        ...(selfHighDetailDirty ? [session.actorId] : []),
        ...eventFocusActors,
        ...urgentStatusDirtyActors,
        ...relevantHighDetailDirtyActors,
        ...relevantDirtyActors,
        ...routineInterestActors,
      ]).slice(0, maxDeltaActors);
      const highDetailCandidateActorIds = uniqueActorIds([
        ...(selfHighDetailDirty ? [session.actorId] : []),
        ...eventDetailActors,
        ...relevantHighDetailDirtyActors,
      ]);
      const statusDetailCandidateActorIds = uniqueActorIds([
        ...highDetailCandidateActorIds,
        ...focusActorIds.filter((actorId) => statusDirtyActorIds.has(actorId)).slice(0, maxStatusDetailActorsPerDelta),
      ]);
      const urgentActorIds = new Set([session.actorId, ...eventFocusActors, ...highDetailCandidateActorIds, ...statusDetailCandidateActorIds]);
      const urgentFocusActorIds = focusActorIds.filter((actorId) => urgentActorIds.has(actorId));
      const routineDeliveryActorIds = focusActorIds
        .filter((actorId) => !urgentActorIds.has(actorId) && this.shouldSendRoutineActorMove(session, actorId))
        .slice(0, maxRoutineActorDeliveriesPerDelta);
      const deliveryFocusActorIds = uniqueActorIds([...urgentFocusActorIds, ...routineDeliveryActorIds])
        .slice(0, maxDeltaActors);
      const skippedFocusActorIds = focusActorIds
        .filter((actorId) => !deliveryFocusActorIds.includes(actorId));
      const highDetailActorIds = highDetailCandidateActorIds
        .filter((actorId) => deliveryFocusActorIds.includes(actorId));
      const statusDetailActorIds = statusDetailCandidateActorIds
        .filter((actorId) => deliveryFocusActorIds.includes(actorId));
      if (
        deliveryFocusActorIds.length === 0
        && session.pendingReceipts.length === 0
        && !pendingEventsDue
        && session.pendingAbilityQueueEvents.length === 0
        && !hasKnownActorRemovals
        && !hasVisibleInventoryDelta
      ) {
        if (includeRoutineState) {
          this.replaceDeferredDirtyActorIds(session, skippedFocusActorIds);
        }
        session.interestDirty = false;
        continue;
      }
      if (deliveryFocusActorIds.length > 0 || hasKnownActorRemovals || hasVisibleInventoryDelta) {
        const delta = this.deltaForSession(session, deliveryFocusActorIds, {
          highDetailActorIds,
          statusDetailActorIds,
          includeActorRemovals: includeRoutineState || statusDetailActorIds.length > 0 || hasKnownActorRemovals,
        });
        this.markKnownActorsFromDelta(session, delta);
        this.send(session, {
          type: "game.delta",
          delta,
          receipts: session.pendingReceipts.splice(0),
          events: this.takePendingCombatEvents(session, pendingEventsDue),
          abilityQueueEvents: this.takePendingAbilityQueueEvents(session),
        });
        session.lastSnapshotTick = delta.tick;
        if (includeRoutineState) {
          session.lastActorDeltaTick = delta.tick;
          this.replaceDeferredDirtyActorIds(session, skippedFocusActorIds);
        }
        session.interestDirty = false;
        continue;
      }
      const snapshot = this.snapshotForSession(session);
      this.replaceKnownActorSnapshots(session, snapshot.actors);
      this.send(session, {
        type: "game.snapshot",
        snapshot,
        receipts: session.pendingReceipts.splice(0),
        events: this.takePendingCombatEvents(session, pendingEventsDue),
        abilityQueueEvents: this.takePendingAbilityQueueEvents(session),
      });
      session.lastSnapshotTick = snapshot.tick;
      session.lastActorDeltaTick = snapshot.tick;
      this.clearDeferredDirtyActorIds(session);
      session.interestDirty = false;
    }
    if (nextRoutineSessionId !== null) this.nextRoutineSessionId = nextRoutineSessionId;
    this.maybeWriteCheckpoint(now);
    this.flushJournalIfNeeded();
    this.snapshotBuildTiming.record(Date.now() - snapshotBuildStartedAt);
  }

  private queueCombatEvents(events: GameCombatEvent[], excludeSessionId?: string): void {
    if (events.length === 0) return;
    const sessionsByActorId = new Map<string, GameSession[]>();
    for (const session of this.sessions.values()) {
      if (session.id === excludeSessionId) continue;
      const sessions = sessionsByActorId.get(session.actorId);
      if (sessions) {
        sessions.push(session);
      } else {
        sessionsByActorId.set(session.actorId, [session]);
      }
    }
    const eventsBySession = new Map<string, { session: GameSession; events: GameCombatEvent[] }>();
    for (const event of events) {
      for (const actorId of this.combatEventObserverActorIds(event)) {
        const sessions = sessionsByActorId.get(actorId);
        if (!sessions) continue;
        for (const session of sessions) {
          let entry = eventsBySession.get(session.id);
          if (!entry) {
            entry = { session, events: [] };
            eventsBySession.set(session.id, entry);
          }
          entry.events.push(event);
        }
      }
    }
    for (const entry of eventsBySession.values()) {
      this.appendPendingCombatEvents(entry.session, entry.events);
    }
  }

  private combatEventObserverActorIds(event: GameCombatEvent): Set<string> {
    const actorIds = new Set<string>([event.shooterActorId, event.targetActorId]);
    const shooter = this.actors.get(event.shooterActorId);
    const target = this.actors.get(event.targetActorId);
    const areaId = target?.areaId ?? shooter?.areaId;
    if (!areaId) return actorIds;
    const areaIndex = this.actorInterestSpatialIndex().get(areaId);
    if (!areaIndex) return actorIds;
    const radius = Math.min(this.areaInterestRadiusCells, maxCombatEventInterestRadiusCells);
    const radiusSq = radius * radius;
    const bucketRadius = Math.ceil(radius / actorInterestSpatialBucketCells);
    const points = [
      shooter ? { x: shooter.x, y: shooter.y } : null,
      target ? { x: target.x, y: target.y } : null,
      event.hitPoint ?? null,
    ].filter((point): point is Cell => Boolean(point));
    const seen = new Set<string>();
    for (const point of points) {
      const originBucketX = Math.floor(point.x / actorInterestSpatialBucketCells);
      const originBucketY = Math.floor(point.y / actorInterestSpatialBucketCells);
      for (let bx = originBucketX - bucketRadius; bx <= originBucketX + bucketRadius; bx += 1) {
        for (let by = originBucketY - bucketRadius; by <= originBucketY + bucketRadius; by += 1) {
          const bucket = areaIndex.get(dirtyActorBucketKey(bx, by));
          if (!bucket) continue;
          for (const actor of bucket) {
            if (seen.has(actor.id)) continue;
            seen.add(actor.id);
            if (actor.areaId !== areaId) continue;
            const dx = actor.x - point.x;
            const dy = actor.y - point.y;
            if (dx * dx + dy * dy <= radiusSq) actorIds.add(actor.id);
          }
        }
      }
    }
    return actorIds;
  }

  private appendPendingCombatEvents(session: GameSession, events: GameCombatEvent[]): void {
    const merged = new Map<number, GameCombatEvent>();
    for (const event of session.pendingEvents) merged.set(event.id, event);
    for (const event of events) merged.set(event.id, event);
    const ranked = [...merged.values()]
      .map((event) => ({
        event,
        score: this.combatEventRelevanceScoreFor(session, event),
      }))
      .filter((entry): entry is { event: GameCombatEvent; score: number } => entry.score !== null)
      .sort((left, right) => (
        left.score - right.score
        || right.event.tick - left.event.tick
        || right.event.id - left.event.id
      ))
      .slice(0, maxPendingCombatEventsPerSession)
      .sort((left, right) => left.event.tick - right.event.tick || left.event.id - right.event.id);
    session.pendingEvents = ranked.map((entry) => entry.event);
  }

  private pendingCombatEventsDue(session: GameSession): boolean {
    if (session.pendingEvents.length === 0) return false;
    if (this.pendingCombatEventsInvolveSession(session)) return true;
    return session.lastCombatEventDeltaTick < 0
      || this.tick - session.lastCombatEventDeltaTick >= observerCombatEventIntervalTicks;
  }

  private pendingCombatEventsInvolveSession(session: GameSession): boolean {
    return session.pendingEvents.some((event) => (
      event.shooterActorId === session.actorId
        || event.attackerActorId === session.actorId
        || event.targetActorId === session.actorId
    ));
  }

  private takePendingCombatEvents(session: GameSession, due: boolean): GameCombatEvent[] {
    if (!due) return [];
    const events = session.pendingEvents.splice(0);
    if (events.length > 0) session.lastCombatEventDeltaTick = this.tick;
    return events;
  }

  private combatEventRelevanceScoreFor(session: GameSession, event: GameCombatEvent): number | null {
    const observer = this.aoiObserverFor(session);
    if (!observer) return null;
    if (observer.id === event.shooterActorId || observer.id === event.targetActorId) return 0;
    const shooter = this.actors.get(event.shooterActorId);
    const target = this.actors.get(event.targetActorId);
    const areaId = target?.areaId ?? shooter?.areaId;
    if (!areaId || observer.areaId !== areaId) return null;
    const points = [
      shooter ? { x: shooter.x, y: shooter.y } : null,
      target ? { x: target.x, y: target.y } : null,
      event.hitPoint ?? null,
    ].filter((point): point is Cell => Boolean(point));
    let best = Number.POSITIVE_INFINITY;
    for (const point of points) {
      best = Math.min(best, Math.hypot(observer.x - point.x, observer.y - point.y));
    }
    return best <= Math.min(this.areaInterestRadiusCells, maxCombatEventInterestRadiusCells) ? best : null;
  }

  private cloneFacilityForRespawn(facilityId?: string | null): SliceCloneFacility | null {
    if (facilityId !== undefined && facilityId !== null) return this.cloneFacilities.get(facilityId) ?? null;
    return (this.cloneFacilities.values().next().value as SliceCloneFacility | undefined) ?? null;
  }

  private isSessionActor(actorId: string): boolean {
    for (const session of this.sessions.values()) {
      if (session.actorId === actorId) return true;
    }
    return false;
  }

  private updateSessionInterest(session: GameSession, view: GameClientView): void {
    const next = normalizeClientViewInterest(view, this.tick);
    if (!next) return;
    const previous = session.viewInterest;
    session.viewInterest = next;
    const protocolRefreshDirty = !previous
      || Math.abs(previous.viewportWidthCells - next.viewportWidthCells) >= 0.5
      || Math.abs(previous.viewportHeightCells - next.viewportHeightCells) >= 0.5
      || Math.abs(previous.marginCells - next.marginCells) >= 0.5;
    const interestChanged = this.refreshSessionInterest(session, { markDirty: false });
    if (protocolRefreshDirty || interestChanged) session.interestDirty = true;
  }

  private aoiBookkeepingMetricsForTest(): AoiBookkeepingMetrics & {
    activeSessionInterestActors: number;
    actorReciprocalLinks: number;
  } {
    let activeSessionInterestActors = 0;
    for (const session of this.sessions.values()) {
      activeSessionInterestActors += this.sessionInterestActorIds.get(session)?.size ?? 0;
    }
    let actorReciprocalLinks = 0;
    for (const sessions of this.actorInterestedSessions.values()) actorReciprocalLinks += sessions.size;
    return {
      ...this.aoiBookkeepingMetrics,
      activeSessionInterestActors,
      actorReciprocalLinks,
    };
  }

  private interestCandidates(
    observer: AuthorityActor,
    session: GameSession | undefined,
    limit: number,
  ): Array<{ actor: AuthorityActor; distance: number }> {
    return this.actorInterestEntries(observer, session)
      .sort(compareActorInterestEntry)
      .slice(0, limit)
      .map((entry) => ({ actor: entry.actor, distance: Math.sqrt(entry.interest.distanceSq) }));
  }

  private actorInterestEntries(
    observer: AuthorityActor,
    session: GameSession | undefined,
  ): Array<{ actor: AuthorityActor; interest: ActorInterestMatch }> {
    if (!session) return this.actorInterestEntriesFromBuckets(observer, session);
    const entries = this.actorInterestEntriesFromSessionSet(session, observer);
    this.aoiBookkeepingMetrics.routineEntriesFromSet += entries.length;
    return entries;
  }

  private actorInterestEntriesFromSessionSet(
    session: GameSession,
    observer: AuthorityActor,
  ): Array<{ actor: AuthorityActor; interest: ActorInterestMatch }> {
    this.actorInterestSpatialIndex();
    const actorIds = this.interestActorIdsForSession(session, observer);
    const entries: Array<{ actor: AuthorityActor; interest: ActorInterestMatch }> = [];
    for (const actorId of [...actorIds]) {
      const actor = this.actors.get(actorId);
      if (!actor) {
        this.setSessionActorInterest(session, actorId, false, { markDirty: true });
        continue;
      }
      const interest = this.actorInterestFor(session, observer, actor);
      if (interest) {
        entries.push({ actor, interest });
      } else {
        this.setSessionActorInterest(session, actorId, false, { markDirty: true });
      }
    }
    return entries.sort((left, right) => this.compareActorInterestBucketOrder(left.actor, right.actor));
  }

  private actorInterestEntriesFromBuckets(
    observer: AuthorityActor,
    session: GameSession | undefined,
  ): Array<{ actor: AuthorityActor; interest: ActorInterestMatch }> {
    const areaIndex = this.actorInterestSpatialIndex().get(observer.areaId);
    if (!areaIndex) return [];
    const searchRadius = this.sessionInterestSearchRadius(session);
    const bucketRadius = Math.ceil(searchRadius / actorInterestSpatialBucketCells);
    const originBucketX = Math.floor(observer.x / actorInterestSpatialBucketCells);
    const originBucketY = Math.floor(observer.y / actorInterestSpatialBucketCells);
    const seen = new Set<string>();
    const entries: Array<{ actor: AuthorityActor; interest: ActorInterestMatch }> = [];
    for (let bx = originBucketX - bucketRadius; bx <= originBucketX + bucketRadius; bx += 1) {
      for (let by = originBucketY - bucketRadius; by <= originBucketY + bucketRadius; by += 1) {
        const bucket = areaIndex.get(dirtyActorBucketKey(bx, by));
        if (!bucket) continue;
        for (const actor of bucket) {
          this.aoiBookkeepingMetrics.bucketCandidateVisits += 1;
          if (seen.has(actor.id)) continue;
          seen.add(actor.id);
          const interest = this.actorInterestFor(session, observer, actor);
          if (interest) entries.push({ actor, interest });
        }
      }
    }
    if (!seen.has(observer.id)) {
      const interest = this.actorInterestFor(session, observer, observer);
      if (interest) entries.push({ actor: observer, interest });
    }
    return entries;
  }

  private actorInterestSpatialIndex(): ActorInterestSpatialIndex {
    if (!this.actorInterestSpatialIndexReady) this.rebuildActorInterestSpatialIndex();
    if (this.actorInterestSpatialIndexDirty) this.reconcileActorInterestSpatialIndex();
    return this.cachedActorInterestSpatialIndex;
  }

  private rebuildActorInterestSpatialIndex(): void {
    const index: ActorInterestSpatialIndex = new Map<string, Map<string, AuthorityActor[]>>();
    this.cachedActorInterestSpatialIndex = index;
    this.actorInterestBucketRefs.clear();
    this.actorInterestOrder.clear();
    this.nextActorInterestOrder = 1;
    for (const actor of this.actors.values()) {
      this.actorInterestOrder.set(actor.id, this.nextActorInterestOrder++);
      const ref = this.actorInterestBucketRef(actor);
      this.actorInterestBucketRefs.set(actor.id, ref);
      this.addActorToInterestBucket(actor, ref);
    }
    this.actorInterestSpatialIndexReady = true;
    this.actorInterestSpatialIndexDirty = false;
    this.aoiBookkeepingMetrics.bucketRebuilds += 1;
  }

  private reconcileActorInterestSpatialIndex(): void {
    if (!this.actorInterestSpatialIndexReady) {
      this.rebuildActorInterestSpatialIndex();
      return;
    }
    this.actorInterestSpatialIndexDirty = false;
    this.aoiBookkeepingMetrics.bucketReconciles += 1;
    const seen = new Set<string>();
    const movedActorIds: string[] = [];
    const removedActorIds: string[] = [];
    for (const actor of this.actors.values()) {
      seen.add(actor.id);
      if (!this.actorInterestOrder.has(actor.id)) this.actorInterestOrder.set(actor.id, this.nextActorInterestOrder++);
      const next = this.actorInterestBucketRef(actor);
      const previous = this.actorInterestBucketRefs.get(actor.id);
      const bucketChanged = !previous
        || previous.areaId !== next.areaId
        || previous.bucketKey !== next.bucketKey;
      const moved = !previous
        || bucketChanged
        || previous.x !== next.x
        || previous.y !== next.y;
      if (bucketChanged) {
        if (previous) this.removeActorFromInterestBucket(actor, previous);
        this.addActorToInterestBucket(actor, next);
        this.aoiBookkeepingMetrics.bucketTransitions += 1;
      }
      if (moved) movedActorIds.push(actor.id);
      this.actorInterestBucketRefs.set(actor.id, next);
    }
    for (const [actorId, previous] of [...this.actorInterestBucketRefs.entries()]) {
      if (seen.has(actorId)) continue;
      const actor = { id: actorId } as AuthorityActor;
      this.removeActorFromInterestBucket(actor, previous);
      this.actorInterestBucketRefs.delete(actorId);
      this.actorInterestOrder.delete(actorId);
      removedActorIds.push(actorId);
      this.aoiBookkeepingMetrics.bucketTransitions += 1;
    }
    for (const actorId of movedActorIds) this.refreshInterestForActorTransition(actorId, { markDirty: true });
    for (const actorId of removedActorIds) this.removeActorFromAllSessionInterests(actorId, { markDirty: true });
  }

  private actorInterestBucketRef(actor: AuthorityActor): ActorInterestBucketRef {
    const bucketX = Math.floor(actor.x / actorInterestSpatialBucketCells);
    const bucketY = Math.floor(actor.y / actorInterestSpatialBucketCells);
    return {
      areaId: actor.areaId,
      bucketKey: dirtyActorBucketKey(bucketX, bucketY),
      bucketX,
      bucketY,
      x: actor.x,
      y: actor.y,
    };
  }

  private addActorToInterestBucket(actor: AuthorityActor, ref: ActorInterestBucketRef): void {
    let areaIndex = this.cachedActorInterestSpatialIndex.get(ref.areaId);
    if (!areaIndex) {
      areaIndex = new Map<string, AuthorityActor[]>();
      this.cachedActorInterestSpatialIndex.set(ref.areaId, areaIndex);
    }
    let bucket = areaIndex.get(ref.bucketKey);
    if (!bucket) {
      bucket = [];
      areaIndex.set(ref.bucketKey, bucket);
    }
    const order = this.actorInterestOrder.get(actor.id) ?? this.nextActorInterestOrder++;
    if (!this.actorInterestOrder.has(actor.id)) this.actorInterestOrder.set(actor.id, order);
    const insertAt = bucket.findIndex((candidate) => (this.actorInterestOrder.get(candidate.id) ?? Number.MAX_SAFE_INTEGER) > order);
    if (insertAt < 0) {
      bucket.push(actor);
    } else {
      bucket.splice(insertAt, 0, actor);
    }
  }

  private removeActorFromInterestBucket(actor: Pick<AuthorityActor, "id">, ref: ActorInterestBucketRef): void {
    const areaIndex = this.cachedActorInterestSpatialIndex.get(ref.areaId);
    const bucket = areaIndex?.get(ref.bucketKey);
    if (!bucket) return;
    const index = bucket.findIndex((candidate) => candidate.id === actor.id);
    if (index >= 0) bucket.splice(index, 1);
    if (bucket.length === 0) areaIndex?.delete(ref.bucketKey);
    if (areaIndex && areaIndex.size === 0) this.cachedActorInterestSpatialIndex.delete(ref.areaId);
  }

  private compareActorInterestBucketOrder(left: AuthorityActor, right: AuthorityActor): number {
    const leftRef = this.actorInterestBucketRefs.get(left.id) ?? this.actorInterestBucketRef(left);
    const rightRef = this.actorInterestBucketRefs.get(right.id) ?? this.actorInterestBucketRef(right);
    return leftRef.bucketX - rightRef.bucketX
      || leftRef.bucketY - rightRef.bucketY
      || (this.actorInterestOrder.get(left.id) ?? Number.MAX_SAFE_INTEGER)
        - (this.actorInterestOrder.get(right.id) ?? Number.MAX_SAFE_INTEGER)
      || left.id.localeCompare(right.id);
  }

  private interestActorIdsForSession(session: GameSession, observer = this.aoiObserverFor(session)): Set<string> {
    if (!observer) {
      this.clearSessionInterest(session);
      return new Set<string>();
    }
    const signature = this.sessionInterestSignature(session, observer);
    if (!this.sessionInterestActorIds.has(session) || this.sessionInterestSignatures.get(session) !== signature) {
      this.refreshSessionInterest(session, { observer, markDirty: false });
    }
    return this.sessionInterestActorIds.get(session) ?? new Set<string>();
  }

  private refreshSessionInterest(
    session: GameSession,
    options: { observer?: AuthorityActor; markDirty: boolean },
  ): boolean {
    const observer = options.observer ?? this.aoiObserverFor(session);
    if (!observer) {
      const hadInterest = (this.sessionInterestActorIds.get(session)?.size ?? 0) > 0;
      this.clearSessionInterest(session);
      if (hadInterest && options.markDirty) session.interestDirty = true;
      return hadInterest;
    }
    const nextActorIds = new Set(this.actorInterestEntriesFromBuckets(observer, session).map((entry) => entry.actor.id));
    const changed = this.replaceSessionInterest(session, nextActorIds, { observer, markDirty: options.markDirty });
    this.sessionInterestSignatures.set(session, this.sessionInterestSignature(session, observer));
    this.aoiBookkeepingMetrics.sessionRefreshes += 1;
    return changed;
  }

  private replaceSessionInterest(
    session: GameSession,
    nextActorIds: Set<string>,
    options: { observer: AuthorityActor; markDirty: boolean },
  ): boolean {
    const previous = this.sessionInterestActorIds.get(session) ?? new Set<string>();
    let changed = false;
    for (const actorId of previous) {
      if (nextActorIds.has(actorId)) continue;
      this.removeActorInterestedSession(actorId, session);
      this.aoiBookkeepingMetrics.sessionDiffRemoves += 1;
      changed = true;
    }
    for (const actorId of nextActorIds) {
      if (previous.has(actorId)) continue;
      this.addActorInterestedSession(actorId, session);
      this.aoiBookkeepingMetrics.sessionDiffAdds += 1;
      changed = true;
    }
    this.sessionInterestActorIds.set(session, nextActorIds);
    this.sessionInterestSignatures.set(session, this.sessionInterestSignature(session, options.observer));
    if (changed && options.markDirty) session.interestDirty = true;
    return changed;
  }

  private setSessionActorInterest(
    session: GameSession,
    actorId: string,
    interested: boolean,
    options: { markDirty: boolean },
  ): boolean {
    const actorIds = this.sessionInterestActorIds.get(session);
    if (!actorIds) return interested;
    const had = actorIds.has(actorId);
    if (interested) {
      if (!had) {
        actorIds.add(actorId);
        this.addActorInterestedSession(actorId, session);
        this.aoiBookkeepingMetrics.sessionDiffAdds += 1;
        if (options.markDirty) session.interestDirty = true;
      }
      return true;
    }
    if (had) {
      actorIds.delete(actorId);
      this.removeActorInterestedSession(actorId, session);
      this.aoiBookkeepingMetrics.sessionDiffRemoves += 1;
      if (options.markDirty) session.interestDirty = true;
    }
    return false;
  }

  private addActorInterestedSession(actorId: string, session: GameSession): void {
    let sessions = this.actorInterestedSessions.get(actorId);
    if (!sessions) {
      sessions = new Set<GameSession>();
      this.actorInterestedSessions.set(actorId, sessions);
    }
    sessions.add(session);
  }

  private removeActorInterestedSession(actorId: string, session: GameSession): void {
    const sessions = this.actorInterestedSessions.get(actorId);
    if (!sessions) return;
    sessions.delete(session);
    if (sessions.size === 0) this.actorInterestedSessions.delete(actorId);
  }

  private removeActorFromAllSessionInterests(actorId: string, options: { markDirty: boolean }): void {
    const sessions = this.actorInterestedSessions.get(actorId);
    if (!sessions) return;
    for (const session of [...sessions]) {
      const actorIds = this.sessionInterestActorIds.get(session);
      if (!actorIds?.delete(actorId)) continue;
      this.aoiBookkeepingMetrics.sessionDiffRemoves += 1;
      if (options.markDirty) session.interestDirty = true;
    }
    this.actorInterestedSessions.delete(actorId);
  }

  private clearSessionInterest(session: GameSession): void {
    const actorIds = this.sessionInterestActorIds.get(session);
    if (actorIds) {
      for (const actorId of actorIds) this.removeActorInterestedSession(actorId, session);
    }
    this.sessionInterestActorIds.delete(session);
    this.sessionInterestSignatures.delete(session);
  }

  private refreshInterestForActorTransition(actorId: string, options: { markDirty: boolean }): void {
    for (const session of this.sessions.values()) {
      if (!this.sessionInterestActorIds.has(session)) continue;
      const observer = this.aoiObserverFor(session);
      if (!observer) {
        this.refreshSessionInterest(session, options);
        continue;
      }
      if (observer.id === actorId) {
        this.refreshSessionInterest(session, { observer, markDirty: options.markDirty });
        continue;
      }
      const actor = this.actors.get(actorId);
      const interested = Boolean(actor && this.actorInterestFor(session, observer, actor));
      this.setSessionActorInterest(session, actorId, interested, options);
    }
  }

  private sessionInterestSignature(session: GameSession, observer: AuthorityActor): string {
    const view = session.viewInterest;
    return [
      observer.id,
      observer.areaId,
      observer.x,
      observer.y,
      view?.viewportWidthCells ?? this.areaInterestRadiusCells,
      view?.viewportHeightCells ?? this.areaInterestRadiusCells,
      view?.marginCells ?? 0,
      view?.centerActorId ?? "",
    ].join("|");
  }

  /**
   * The actor that area-of-interest is centered on for a session. Normally the session's own
   * controlled actor, but when the client reports a camera `centerActorId` (a spectator/recording
   * follow-cam) and that actor exists, AOI centers there so the followed action is actually
   * delivered. Falls back to the session actor, so normal play is byte-identical.
   */
  private aoiObserverFor(session: GameSession | undefined): AuthorityActor | undefined {
    const centerActorId = session?.viewInterest?.centerActorId;
    if (centerActorId && centerActorId !== session?.actorId) {
      const center = this.actors.get(centerActorId);
      if (center) return center;
    }
    return session ? this.actors.get(session.actorId) : undefined;
  }

  private actorInterestFor(
    session: GameSession | undefined,
    observer: AuthorityActor,
    actor: AuthorityActor,
  ): ActorInterestMatch | null {
    if (actor.id === observer.id) return { tier: "visible", distanceSq: 0 };
    if (actor.areaId !== observer.areaId) return null;
    const dx = actor.x - observer.x;
    const dy = actor.y - observer.y;
    const distanceSq = dx * dx + dy * dy;
    const view = session?.viewInterest;
    if (!view) {
      const radiusSq = this.areaInterestRadiusCells * this.areaInterestRadiusCells;
      return distanceSq <= radiusSq ? { tier: "visible", distanceSq } : null;
    }

    const halfWidth = view.viewportWidthCells / 2 + view.marginCells;
    const halfHeight = view.viewportHeightCells / 2 + view.marginCells;
    if (Math.abs(dx) <= halfWidth && Math.abs(dy) <= halfHeight) {
      return { tier: "visible", distanceSq };
    }

    return Math.abs(dx) <= halfWidth + warmInterestMarginCells
      && Math.abs(dy) <= halfHeight + warmInterestMarginCells
      ? { tier: "warm", distanceSq }
      : null;
  }

  private sessionInterestSearchRadius(session: GameSession | undefined): number {
    const view = session?.viewInterest;
    if (!view) return this.areaInterestRadiusCells;
    const halfWidth = view.viewportWidthCells / 2 + view.marginCells;
    const halfHeight = view.viewportHeightCells / 2 + view.marginCells;
    return Math.max(halfWidth, halfHeight) + warmInterestMarginCells;
  }

  private routineInterestActorIds(session: GameSession): string[] {
    const observer = this.aoiObserverFor(session);
    if (!observer) return [];
    const candidates = this.actorInterestEntries(observer, session);
    if (candidates.length <= maxRoutineInterestActorsPerDelta) {
      return candidates
        .sort(compareActorInterestEntry)
        .map((entry) => entry.actor.id);
    }
    const priorityCount = Math.min(priorityRoutineInterestActorsPerDelta, maxRoutineInterestActorsPerDelta);
    const priority = selectPriorityInterestEntries(candidates, priorityCount);
    const priorityIds = new Set(priority.map((entry) => entry.actor.id));
    const rotatingBudget = maxRoutineInterestActorsPerDelta - priority.length;
    if (rotatingBudget <= 0) return priority.map((entry) => entry.actor.id);
    const rotating = candidates
      .filter((entry) => !priorityIds.has(entry.actor.id))
      .map((entry) => entry.actor.id);
    if (rotating.length === 0) return priority.map((entry) => entry.actor.id);
    const start = (this.tick + this.actorNetId(session.actorId)) % rotating.length;
    const selected = priority.map((entry) => entry.actor.id);
    for (let index = 0; index < rotatingBudget; index += 1) {
      selected.push(rotating[(start + index) % rotating.length]!);
    }
    return selected;
  }

  private relevantDirtyActorsFor(session: GameSession, dirtyActorIds: string[]): string[] {
    const observer = this.aoiObserverFor(session);
    if (!observer) return [];
    const interestActorIds = this.interestActorIdsForSession(session, observer);
    const relevant: Array<{ id: string; interest: ActorInterestMatch }> = [];
    for (const dirtyId of dirtyActorIds) {
      if (dirtyId === session.actorId || !interestActorIds.has(dirtyId)) continue;
      const actor = this.actors.get(dirtyId);
      if (!actor) continue;
      const interest = this.actorInterestFor(session, observer, actor);
      if (interest) relevant.push({ id: dirtyId, interest });
    }
    return relevant
      .sort(compareActorIdInterest)
      .slice(0, maxDirtyDeltaActors)
      .map((entry) => entry.id);
  }

  private relevantDirtyActorsFromIndex(session: GameSession, index: DirtyActorSpatialIndex): string[] {
    const observer = this.aoiObserverFor(session);
    if (!observer) return [];
    const interestActorIds = this.interestActorIdsForSession(session, observer);
    const relevant: Array<{ id: string; interest: ActorInterestMatch }> = [];
    const seen = new Set<string>();
    for (const areaIndex of index.values()) {
      for (const bucket of areaIndex.values()) {
        for (const entry of bucket) {
          if (seen.has(entry.id) || entry.id === session.actorId || !interestActorIds.has(entry.id)) continue;
          seen.add(entry.id);
          const interest = this.actorInterestFor(session, observer, entry.actor);
          if (interest) relevant.push({ id: entry.id, interest });
        }
      }
    }
    return relevant
      .sort(compareActorIdInterest)
      .slice(0, maxDirtyDeltaActors)
      .map((entry) => entry.id);
  }

  private dirtyActorSpatialIndex(dirtyActorIds: string[]): DirtyActorSpatialIndex {
    const index: DirtyActorSpatialIndex = new Map<string, Map<string, DirtyActorSpatialEntry[]>>();
    const seen = new Set<string>();
    for (const actorId of dirtyActorIds) {
      if (seen.has(actorId)) continue;
      seen.add(actorId);
      const actor = this.actors.get(actorId);
      if (!actor) continue;
      let areaIndex = index.get(actor.areaId);
      if (!areaIndex) {
        areaIndex = new Map<string, DirtyActorSpatialEntry[]>();
        index.set(actor.areaId, areaIndex);
      }
      const key = dirtyActorBucketKey(
        Math.floor(actor.x / dirtyActorSpatialBucketCells),
        Math.floor(actor.y / dirtyActorSpatialBucketCells),
      );
      let bucket = areaIndex.get(key);
      if (!bucket) {
        bucket = [];
        areaIndex.set(key, bucket);
      }
      bucket.push({ id: actorId, actor });
    }
    return index;
  }
  private deferDirtyActorIds(session: GameSession, actorIds: Iterable<string>): void {
    const firstSeenTicks = this.deferredDirtyActorFirstSeenTicksFor(session);
    for (const actorId of actorIds) {
      if (!this.actors.has(actorId) || actorId === session.actorId) continue;
      session.deferredDirtyActorIds.add(actorId);
      if (!firstSeenTicks.has(actorId)) firstSeenTicks.set(actorId, this.tick);
      if (session.deferredDirtyActorIds.size > maxDeferredDirtyActorsPerSession) {
        const oldest = session.deferredDirtyActorIds.values().next().value as string | undefined;
        if (!oldest) break;
        session.deferredDirtyActorIds.delete(oldest);
        firstSeenTicks.delete(oldest);
      }
    }
    this.deferredDirtyActorHighWater = Math.max(this.deferredDirtyActorHighWater, session.deferredDirtyActorIds.size);
  }

  private replaceDeferredDirtyActorIds(session: GameSession, actorIds: Iterable<string>): void {
    session.deferredDirtyActorIds.clear();
    this.deferDirtyActorIds(session, actorIds);
    const firstSeenTicks = this.deferredDirtyActorFirstSeenTicksFor(session);
    for (const actorId of firstSeenTicks.keys()) {
      if (!session.deferredDirtyActorIds.has(actorId)) firstSeenTicks.delete(actorId);
    }
  }

  private clearDeferredDirtyActorIds(session: GameSession): void {
    session.deferredDirtyActorIds.clear();
    this.deferredDirtyActorFirstSeenTicksFor(session).clear();
  }

  private deferredDirtyActorFirstSeenTicksFor(session: GameSession): Map<string, number> {
    return session.deferredDirtyActorFirstSeenTicks ??= new Map<string, number>();
  }

  private shouldSendRoutineActorMove(session: GameSession, actorId: string): boolean {
    if (actorId === session.actorId) return true;
    const actor = this.actors.get(actorId);
    const observer = this.aoiObserverFor(session);
    if (!actor || !observer) return false;
    if (!this.interestActorIdsForSession(session, observer).has(actorId)) return false;
    const interest = this.actorInterestFor(session, observer, actor);
    if (!interest) return false;
    if (!session.knownActorIds.has(actorId)) return interest.tier === "visible";
    const previous = session.knownActorSnapshots.get(actorId);
    if (previous && (
      actor.areaId !== previous.areaId ||
      actor.lifeState !== previous.lifeState ||
      actor.lifecycleSeq !== previous.lifecycleSeq
    )) {
      return true;
    }
    if (actor.lifeState !== "alive") return false;
    const cadence = interest.tier === "visible"
      ? actorMovementCadenceForDistanceSq(interest.distanceSq)
      : farActorMovementCadenceTicks;
    return actorMovementCadenceBucketChanged(this.tick, session.lastActorDeltaTick, this.actorNetId(actorId), cadence);
  }

  private markKnownActors(session: GameSession, actorIds: Iterable<string>): void {
    for (const actorId of actorIds) session.knownActorIds.add(actorId);
  }

  private rememberActorSnapshots(session: GameSession, actors: Record<string, GameActorSnapshot>): void {
    for (const [actorId, actor] of Object.entries(actors)) {
      if (actorId !== session.actorId && actor.lifeState === "respawning") {
        this.forgetKnownActor(session, actorId);
        continue;
      }
      session.knownActorIds.add(actorId);
      session.knownActorSnapshots.set(actorId, actor);
    }
  }

  private replaceKnownActorSnapshots(session: GameSession, actors: Record<string, GameActorSnapshot>): void {
    session.knownActorIds.clear();
    session.knownActorSnapshots.clear();
    this.clearDeferredDirtyActorIds(session);
    this.rememberActorSnapshots(session, actors);
  }

  private forgetKnownActor(session: GameSession, actorId: string): void {
    session.knownActorIds.delete(actorId);
    session.knownActorSnapshots.delete(actorId);
    session.deferredDirtyActorIds.delete(actorId);
    this.deferredDirtyActorFirstSeenTicksFor(session).delete(actorId);
  }

  private shouldRetainDownedActorUntilRustLifecycle(actor: AuthorityActor): boolean {
    return actor.lifeState === "downed";
  }

  private hasActorRemovalsForSession(session: GameSession): boolean {
    if (session.knownActorIds.size === 0) return false;
    const observer = this.aoiObserverFor(session);
    if (!observer) return false;
    const interestActorIds = this.interestActorIdsForSession(session, observer);
    for (const actorId of session.knownActorIds) {
      if (actorId === session.actorId) continue;
      const actor = this.actors.get(actorId);
      if (actor && this.shouldRetainDownedActorUntilRustLifecycle(actor)) continue;
      if (actor?.lifeState === "respawning") return true;
      if (actor && interestActorIds.has(actorId)) continue;
      return true;
    }
    return false;
  }

  private actorRemovalsForSession(session: GameSession): string[] {
    if (session.knownActorIds.size === 0) return [];
    const observer = this.aoiObserverFor(session);
    if (!observer) return [];
    const interestActorIds = this.interestActorIdsForSession(session, observer);
    const removals: string[] = [];
    for (const actorId of session.knownActorIds) {
      if (actorId === session.actorId) continue;
      const actor = this.actors.get(actorId);
      if (actor && this.shouldRetainDownedActorUntilRustLifecycle(actor)) continue;
      if (actor?.lifeState === "respawning") {
        removals.push(actorId);
        if (removals.length >= maxActorRemovalsPerDelta) break;
        continue;
      }
      if (actor && interestActorIds.has(actorId)) continue;
      removals.push(actorId);
      if (removals.length >= maxActorRemovalsPerDelta) break;
    }
    for (const actorId of removals) this.forgetKnownActor(session, actorId);
    return removals;
  }

  private markKnownActorsFromDelta(session: GameSession, delta: GameShardDelta): void {
    for (const actorId of delta.actorRemovals ?? []) this.forgetKnownActor(session, actorId);
    this.rememberActorSnapshots(session, delta.actors);
    for (const [actorId, patch] of Object.entries(delta.actorPatches ?? {})) {
      const previous = session.knownActorSnapshots.get(actorId);
      if (!previous) {
        this.forgetKnownActor(session, actorId);
        continue;
      }
      const next = actorSnapshotFromPatch(previous, patch);
      this.rememberActorSnapshots(session, { [actorId]: next });
    }
    if (Array.isArray(delta.inventory)) this.replaceKnownInventoryRows(session, delta.inventory);
    if (Array.isArray(delta.reservations)) this.replaceKnownReservationRows(session, delta.reservations);
  }

  private reject(commandId: number, reasonCode: string): GameCommandReceipt {
    this.counters.rejectedCommands += 1;
    return {
      commandId,
      accepted: false,
      tick: this.tick,
      reasonCode,
    };
  }

  private sendError(session: GameSession, code: string, message: string): void {
    this.counters.rejectedPackets += 1;
    this.send(session, { type: "game.error", code, message });
  }

  private send(session: GameSession, packet: GameServerPacket): void {
    if (!this.canSendToSession(session)) return;
    const data = JSON.stringify(compactServerPacket(packet));
    session.socket.send(data);
    this.counters.packetsOut += 1;
    this.counters.bytesOut += Buffer.byteLength(data, "utf8");
  }

  private deliverTradeSessionsToParticipants(deliveries: GameTradeSessionDelivery[]): void {
    // The trade session VM is streamed to BOTH participants only (participants-only
    // visibility law): the acting player and their counterparty each receive their own
    // perspective-relative VM. Fired on every path a trade command is applied. The sim
    // works in rust actor ids; sessions + the FE work in TS actor ids, so map both the
    // delivery routing AND the VM's actor ids back through the placeholder table.
    for (const delivery of deliveries) {
      const targetActorId = this.typescriptActorIdForRustPlaceholder(delivery.actorId);
      const session = this.typescriptTradeSessionForFe(delivery.session);
      if (session.stage === "negotiating" || session.stage === "confirm") {
        this.activeTradeSessionsByActorId.set(targetActorId, session);
      } else {
        this.activeTradeSessionsByActorId.delete(targetActorId);
        this.activeTradeSessionsByActorId.delete(session.mine.actorId);
        this.activeTradeSessionsByActorId.delete(session.theirs.actorId);
      }
      for (const target of this.sessions.values()) {
        if (target.actorId !== targetActorId) continue;
        this.sendSessionMessage(target, "tradeSession", session);
      }
    }
  }

  private deliverActiveTradeSessionToSession(session: GameSession): void {
    const activeTradeSession = this.activeTradeSessionsByActorId.get(session.actorId);
    if (!activeTradeSession) return;
    this.sendSessionMessage(session, "tradeSession", activeTradeSession);
  }

  private deliverDuelOutcomesToParticipants(outcomes: GameDuelOutcome[]): void {
    // One-shot duel-end receipt to each participant's OWN session (participants-only
    // visibility). The sim works in rust ids; map routing + payload ids back to TS.
    // opponentName is resolved by the sim (falls back to the id for a departed foe).
    for (const outcome of outcomes) {
      const targetActorId = this.typescriptActorIdForRustPlaceholder(outcome.actorId);
      const payload: GameDuelOutcome = {
        ...outcome,
        actorId: targetActorId,
        opponentActorId: this.typescriptActorIdForRustPlaceholder(outcome.opponentActorId),
      };
      for (const target of this.sessions.values()) {
        if (target.actorId !== targetActorId) continue;
        this.sendSessionMessage(target, "duelOutcome", payload);
      }
    }
  }

  private typescriptTradeSessionForFe(session: GameTradeSession): GameTradeSession {
    return {
      ...session,
      partnerActorId: this.typescriptActorIdForRustPlaceholder(session.partnerActorId),
      mine: { ...session.mine, actorId: this.typescriptActorIdForRustPlaceholder(session.mine.actorId) },
      theirs: { ...session.theirs, actorId: this.typescriptActorIdForRustPlaceholder(session.theirs.actorId) },
    };
  }

  private sendSessionMessage(session: GameSession, type: string, payload: unknown): void {
    if (!this.canSendToSession(session)) return;
    if (session.socket.sendMessage) {
      session.socket.sendMessage(type, payload);
      const data = JSON.stringify(payload);
      this.counters.packetsOut += 1;
      this.counters.bytesOut += Buffer.byteLength(data, "utf8");
      return;
    }
    const data = JSON.stringify({ type, payload });
    session.socket.send(data);
    this.counters.packetsOut += 1;
    this.counters.bytesOut += Buffer.byteLength(data, "utf8");
  }

  private canSendToSession(session: GameSession): boolean {
    if (session.slowConsumerClosing || session.socket.readyState !== websocketOpen) return false;
    const bufferedAmount = this.observeBufferedAmount(session.socket);
    if (bufferedAmount > this.slowConsumerBufferCapBytes) {
      session.failClose();
      return false;
    }
    return true;
  }

  private observeBufferedAmount(socket: GameSocket): number {
    const bufferedAmount = transportBufferedAmount(socket);
    this.maxTransportBufferedBytes = Math.max(this.maxTransportBufferedBytes, bufferedAmount);
    return bufferedAmount;
  }

  checkpointNowForTest(reason = "test"): void | Promise<void> {
    return this.writeCheckpoint(reason);
  }

  private restoreCheckpoint(): void {
    const path = this.persistence.checkpointPath;
    if (!path) {
      this.restoredCheckpoint = { loaded: false, reason: "disabled" };
      return;
    }
    if (!fs.existsSync(path)) {
      this.restoredCheckpoint = { loaded: false, reason: "missing" };
      return;
    }

    let checkpoint: GameShardCheckpoint;
    try {
      checkpoint = JSON.parse(fs.readFileSync(path, "utf8")) as GameShardCheckpoint;
    } catch (error) {
      this.restoredCheckpoint = { loaded: false, reason: "invalid_json" };
      this.logger?.warn({ error, checkpointPath: path }, "failed to read game shard checkpoint");
      return;
    }

    if (checkpoint.schema !== checkpointSchema) {
      this.restoredCheckpoint = { loaded: false, reason: "schema_mismatch" };
      return;
    }
    if (this.persistence.manifestPath) {
      let standalone: unknown;
      try { standalone = JSON.parse(fs.readFileSync(this.persistence.manifestPath, "utf8")); } catch {
        this.restoredCheckpoint = { loaded: false, reason: "manifest_missing" };
        return;
      }
      if (
        !checkpoint.manifest
        || !durabilityManifestMatches(
          standalone,
          this.durabilityManifest,
          this.rustAuthorityMode === "live",
        )
        || !durabilityManifestMatches(
          checkpoint.manifest,
          this.durabilityManifest,
          this.rustAuthorityMode === "live",
        )
      ) {
        this.restoredCheckpoint = { loaded: false, reason: "manifest_mismatch" };
        return;
      }
    }
    if (checkpoint.shardId !== this.shardId) {
      this.restoredCheckpoint = { loaded: false, reason: "shard_mismatch" };
      return;
    }
    if (checkpoint.sliceHash !== this.sliceHash) {
      const checkpointSourceStateHash = typeof checkpoint.sourceStateHash === "string" && checkpoint.sourceStateHash.length > 0
        ? checkpoint.sourceStateHash
        : undefined;
      const reason = checkpointSourceStateHash !== undefined
        && checkpointSourceStateHash !== this.sourceStateHash
        ? "source_state_hash_mismatch"
        : "slice_hash_mismatch";
      this.restoredCheckpoint = { loaded: false, reason };
      this.logger?.info?.({
        checkpointPath: path,
        checkpointSliceHash: checkpoint.sliceHash,
        currentSliceHash: this.sliceHash,
        checkpointSourceStateHash,
        currentSourceStateHash: this.sourceStateHash,
        reason,
      }, "refusing game shard checkpoint after authored slice bytes changed");
      return;
    }
    if ((!checkpoint.manifest && this.rustAuthorityMode === "live") || (checkpoint.manifest && !durabilityManifestMatches(checkpoint.manifest, this.durabilityManifest, this.rustAuthorityMode === "live"))) {
      this.restoredCheckpoint = { loaded: false, reason: "manifest_mismatch" };
      this.logger?.warn?.({
        checkpointManifest: checkpoint.manifest ?? null,
        expectedManifest: this.durabilityManifest,
      }, "refusing game shard checkpoint with a divergent durability manifest");
      return;
    }
    if (!Array.isArray(checkpoint.actors)) {
      this.restoredCheckpoint = { loaded: false, reason: "invalid_actors" };
      return;
    }
    let projectionStateHash: string;
    try {
      projectionStateHash = this.checkpointProjectionStateHash(checkpoint);
    } catch (error) {
      this.restoredCheckpoint = { loaded: false, reason: "invalid_projection" };
      this.logger?.warn({ error, checkpointPath: path }, "failed to validate game shard checkpoint projection");
      return;
    }
    if (checkpoint.projectionStateHash !== projectionStateHash) {
      this.restoredCheckpoint = { loaded: false, reason: "projection_state_hash_mismatch" };
      this.logger?.warn({ checkpointPath: path }, "refusing game shard checkpoint with a divergent projection hash");
      return;
    }
    if (this.rustAuthorityMode !== "live" && checkpoint.stateHash !== projectionStateHash) {
      this.restoredCheckpoint = { loaded: false, reason: "projection_state_hash_mismatch" };
      this.logger?.warn({ checkpointPath: path }, "refusing in-process checkpoint with a divergent state hash");
      return;
    }
    try {
      this.validateCheckpointAuthoredPlaceholderOwners(checkpoint.authoredPlaceholderOwners);
    } catch (error) {
      this.restoredCheckpoint = { loaded: false, reason: "invalid_placeholder_ownership" };
      this.logger?.warn({ error, checkpointPath: path }, "refusing invalid authored placeholder ownership");
      return;
    }

    if (this.rustAuthorityMode === "live") {
      if (!this.isRustAuthorityCheckpointState(checkpoint.rustAuthority)) {
        const error = new Error("rust live authority checkpoint is missing a versioned Rust state blob");
        this.rustAuthorityRestoreError = error;
        this.restoredCheckpoint = {
          loaded: false,
          reason: "rust_state_missing",
          at: checkpoint.savedAt,
          tick: checkpoint.tick,
          error: error.message,
        };
        this.logger?.warn({ checkpointPath: path }, "refusing to boot live Rust authority from checkpoint without Rust state");
        return;
      }
      if (checkpoint.stateHash !== checkpoint.rustAuthority.stateHash) {
        const error = new Error("rust live authority checkpoint hash does not match embedded Rust state hash");
        this.rustAuthorityRestoreError = error;
        this.restoredCheckpoint = {
          loaded: false,
          reason: "rust_state_hash_mismatch",
          at: checkpoint.savedAt,
          tick: checkpoint.tick,
          rustStateHash: checkpoint.rustAuthority.stateHash,
          error: error.message,
        };
        this.logger?.warn({ checkpointPath: path }, "refusing divergent Rust authority checkpoint");
        return;
      }
      this.restoredCheckpoint = {
        loaded: false,
        reason: "rust_restore_pending",
        at: checkpoint.savedAt,
        tick: checkpoint.tick,
        rustStateHash: checkpoint.rustAuthority.stateHash,
      };
      this.rustAuthorityRestorePromise = this.restoreLiveRustAuthorityCheckpoint(checkpoint, path).catch((error) => {
        const restoreError = error instanceof Error ? error : new Error(String(error));
        this.rustAuthorityRestoreError = restoreError;
        this.restoredCheckpoint = {
          loaded: false,
          reason: "rust_restore_failed",
          at: checkpoint.savedAt,
          tick: checkpoint.tick,
          rustStateHash: checkpoint.rustAuthority?.stateHash,
          error: restoreError.message,
        };
        throw restoreError;
      });
      return;
    }

    const restored: AuthorityActor[] = [];
    try {
      for (const persisted of checkpoint.actors) {
        if (persisted.id === "player") continue;
        if (!this.authoredActorIds.has(persisted.id) || !this.actors.has(persisted.id)) continue;
        restored.push(restorePersistedActor(persisted));
      }
    } catch (error) {
      this.restoredCheckpoint = { loaded: false, reason: "invalid_actor_state" };
      this.logger?.warn({ error, checkpointPath: path }, "failed to restore game shard checkpoint actor state");
      return;
    }

    for (const actor of restored) {
      this.actors.set(actor.id, actor);
      this.dirtyActorIds.add(actor.id);
    }

    this.tick = Math.max(this.tick, integerOr(checkpoint.tick, this.tick));
    this.tickRateHz = positiveNumberOr(checkpoint.tickRateHz, this.tickRateHz);
    this.nextCombatEventId = Math.max(this.nextCombatEventId, integerOr(checkpoint.nextCombatEventId, this.nextCombatEventId));
    this.nextBotSeq = Math.max(this.nextBotSeq, integerOr(checkpoint.nextBotSeq, this.nextBotSeq));
    this.restoreCounters(checkpoint.counters);
    this.restoreLocalCheckpointProjection(checkpoint);
    this.dirty = restored.length > 0;
    this.persistenceDirty = false;
    this.restoredCheckpoint = {
      loaded: true,
      at: checkpoint.savedAt,
      tick: checkpoint.tick,
      actorCount: restored.length,
    };
    this.logger?.info?.({ checkpointPath: path, restoredActors: restored.length }, "restored game shard checkpoint");
  }

  private isRustAuthorityCheckpointState(value: unknown): value is RustAuthorityCheckpointState {
    if (!value || typeof value !== "object") return false;
    const candidate = value as Partial<RustAuthorityCheckpointState>;
    return candidate.schema === "authority.checkpoint-state.v1"
      && candidate.version === 1
      && typeof candidate.tick === "number"
      && Number.isFinite(candidate.tick)
      && typeof candidate.stateHash === "string"
      && candidate.stateHash.length > 0
      && Boolean(candidate.state && typeof candidate.state === "object");
  }

  private async restoreLiveRustAuthorityCheckpoint(checkpoint: GameShardCheckpoint, checkpointPath: string): Promise<void> {
    if (!this.rustAuthorityBridge || !checkpoint.rustAuthority) {
      throw new Error("rust live authority restore requested without a bridge or Rust state");
    }
    // Restore durable alias ownership before importing Rust inventory so
    // `player:*` containers are never exposed to or claimed by another PC.
    this.restoreAuthoredPlaceholderOwners(checkpoint.authoredPlaceholderOwners);
    const output = await this.rustAuthorityBridge.importState({
      state: checkpoint.rustAuthority.state,
      expectedStateHash: checkpoint.rustAuthority.stateHash,
      timeoutMs: 10_000,
    });
    const importedStateHash = output.targetStateHash;
    if (typeof importedStateHash !== "string" || importedStateHash.length === 0) {
      throw new Error("rust authority import did not return a target state hash");
    }
    const restoredActorSnapshots = [
      ...(output.actors ?? []),
      ...(output.logoutActors ?? []),
    ];
    this.assertRestoredRustPlaceholderOwnership(restoredActorSnapshots);
    this.seedAuthoredPlaceholderOwnersFromRustActors(restoredActorSnapshots);
    this.restoreDurableCharacterActorBindingsFromRustSnapshots(restoredActorSnapshots);
    const events = this.applyRustAuthorityImportOutput(output);
    if (events.length > 0) {
      throw new Error("rust authority import emitted combat events; refusing non-idempotent checkpoint restore");
    }
    this.tickRateHz = positiveNumberOr(checkpoint.tickRateHz, this.tickRateHz);
    this.nextCombatEventId = Math.max(this.nextCombatEventId, integerOr(checkpoint.nextCombatEventId, this.nextCombatEventId));
    this.nextBotSeq = Math.max(this.nextBotSeq, integerOr(checkpoint.nextBotSeq, this.nextBotSeq));
    this.restoreCounters(checkpoint.counters);
    // Rust validates an oversized legacy checkpoint before trimming its timeline.
    // Its old journal hashes cannot match the normalized replacement state.
    // Restore the local projection before replaying autonomous ticks and
    // commands. Replay outputs must be the final projection, not overwritten
    // by stale checkpoint-side state afterward.
    this.restoreLocalCheckpointProjection(checkpoint);
    const replay = await this.replayRustAuthorityJournalTail(checkpoint, {
      initialStateHash: importedStateHash,
      initialTick: integerOr(output.tick, integerOr(checkpoint.rustAuthority.tick, checkpoint.tick)),
      verifyStateHashes: importedStateHash === checkpoint.rustAuthority.stateHash,
    });
    const rustStateHash = replay.finalStateHash ?? importedStateHash;
    this.persistenceDirty = false;
    this.restoredCheckpoint = {
      loaded: true,
      at: checkpoint.savedAt,
      tick: this.tick,
      actorCount: output.actors?.length ?? 0,
      rustStateHash,
      journalReplayed: replay.count,
    };
    this.logger?.info?.({
      checkpointPath,
      rustStateHash,
      replayedCommands: replay.count,
      restoredActors: output.actors?.length ?? 0,
    }, "restored live Rust authority checkpoint");
  }

  private applyRustAuthorityImportOutput(output: RustAuthorityBridgeImportStateOutput): GameCombatEvent[] {
    const events = this.applyRustAuthorityTickOutput(output);
    for (const actor of output.actors ?? []) this.rustAuthorityRegisteredActorIds.add(actor.id);
    return events;
  }

  private async replayRustAuthorityJournalTail(
    checkpoint: GameShardCheckpoint,
    options: { initialStateHash: string; initialTick?: number; verifyStateHashes: boolean },
  ): Promise<{ count: number; finalStateHash?: string }> {
    const path = this.persistence.journalPath;
    if (!path) return { count: 0, finalStateHash: options.initialStateHash };
    let rawJournal: string;
    try {
      rawJournal = fs.readFileSync(path, "utf8");
    } catch (error) {
      throw new Error(
        `configured journal disappeared or became unreadable while restoring Rust authority at ${path}`,
        { cause: error },
      );
    }
    const completeRaw = rawJournal.endsWith("\n") ? rawJournal : rawJournal.slice(0, rawJournal.lastIndexOf("\n") + 1);
    const lines = completeRaw.split(/\r?\n/).filter((line) => line.trim().length > 0);
    if (lines.length === 0) {
      throw new Error(`configured journal became empty while restoring Rust authority at ${path}`);
    }
    const entries: JournalEntry[] = [];
    for (const line of lines) {
      try {
        entries.push(JSON.parse(line) as JournalEntry);
      } catch (error) {
        throw new Error(
          `journal tail contains invalid JSON while restoring Rust authority: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      }
    }
    let checkpointIndex = -1;
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index];
      if (entry?.type === "checkpoint"
        && entry.at === checkpoint.savedAt
        && entry.tick === checkpoint.tick
        && entry.stateHash === checkpoint.stateHash) {
        checkpointIndex = index;
        break;
      }
    }
    if (checkpointIndex < 0) {
      throw new Error("journal tail does not contain the checkpoint marker; refusing ambiguous Rust authority replay");
    }
    let replayTick = integerOr(
      options.initialTick,
      integerOr(checkpoint.rustAuthority?.tick, checkpoint.tick),
    );
    if (replayTick < 0) throw new Error(`journal replay imported an invalid Rust tick ${replayTick}`);
    let count = 0;
    let finalStateHash = options.initialStateHash;
    const replayedCommands = new Map<string, string>();
    for (const entry of entries.slice(checkpointIndex + 1)) {
      if (entry.type !== "command.receipt" || !entry.rust) continue;
      const issuedAtTick = entry.rust.envelope.issued_at_tick;
      if (!Number.isInteger(issuedAtTick) || issuedAtTick < 0) {
        throw new Error(`journal replay command ${entry.commandId} has invalid issued_at_tick ${String(issuedAtTick)}`);
      }
      const receiptTick = entry.tick;
      if (!Number.isInteger(receiptTick) || receiptTick < 0 || receiptTick < issuedAtTick) {
        throw new Error(`journal replay command ${entry.commandId} has invalid receipt tick ${String(receiptTick)} for issued_at_tick ${issuedAtTick}`);
      }
      if (receiptTick < replayTick) {
        throw new Error(`journal replay command ${entry.commandId} is out of order: receipt tick ${receiptTick} is behind replay tick ${replayTick}`);
      }
      const replayKey = `${entry.rust.rustActorId}:${entry.commandId}`;
      const replayFingerprint = stableStringify({ commandId: entry.commandId, accepted: entry.accepted, reasonCode: entry.reasonCode, eventIds: entry.eventIds, rust: entry.rust });
      const previousFingerprint = replayedCommands.get(replayKey);
      if (previousFingerprint !== undefined) {
        if (previousFingerprint !== replayFingerprint) throw new Error(`journal replay duplicate command mismatch for ${replayKey}`);
        continue;
      }
      replayedCommands.set(replayKey, replayFingerprint);
      if (!this.rustAuthorityBridge) throw new Error("rust authority bridge disappeared during journal replay");
      const tickGap = receiptTick - replayTick;
      if (tickGap > 0) {
        const tickOutput = await this.submitRustAuthorityTicks(tickGap, replayTick);
        const tickOutputTick = tickOutput.tick;
        if (typeof tickOutputTick !== "number" || !Number.isInteger(tickOutputTick) || tickOutputTick !== receiptTick) {
          throw new Error(`journal replay tick advance failed before command ${entry.commandId}: expected tick ${receiptTick}, received ${String(tickOutputTick)}`);
        }
        this.applyRustAuthorityTickOutput(tickOutput);
      }
      const output = await this.rustAuthorityBridge.submitCommand({
        actorId: entry.rust.rustActorId,
        envelope: entry.rust.envelope,
        session: entry.rust.session,
        player: entry.rust.player,
        timeoutMs: 10_000,
      });
      if (options.verifyStateHashes && entry.rust.stateHash && output.targetStateHash !== entry.rust.stateHash) {
        throw new Error(`journal replay hash mismatch for command ${entry.commandId}: expected ${entry.rust.stateHash}, received ${output.targetStateHash ?? "missing"}`);
      }
      this.recordRustAuthorityStateHash(output.targetStateHash);
      finalStateHash = output.targetStateHash ?? finalStateHash;
      if (output.status === "accepted") this.applyRustAuthorityOutput(entry.rust.actorId, entry.rust.rustActorId, output);
      if (typeof output.tick === "number") {
        if (!Number.isInteger(output.tick) || output.tick !== receiptTick) {
          throw new Error(`journal replay command ${entry.commandId} returned tick ${String(output.tick)} but receipt tick is ${receiptTick}`);
        }
        replayTick = output.tick;
        this.syncTickFromRust(output.tick);
      } else {
        replayTick = receiptTick;
        this.tick = replayTick;
      }
      count += 1;
    }
    return { count, finalStateHash };
  }

  private restoreCounters(counters: Partial<GameShardCounters> | undefined): void {
    if (!counters) return;
    for (const key of Object.keys(this.counters) as Array<keyof GameShardCounters>) {
      const value = counters[key];
      if (typeof value === "number" && Number.isFinite(value) && value >= 0) this.counters[key] = Math.floor(value);
    }
  }

  private maybeWriteCheckpoint(nowMs: number): void {
    if (!this.persistence.checkpointPath || !this.persistenceDirty) return;
    if (nowMs - this.lastCheckpointAttemptMs < this.persistence.checkpointIntervalMs) return;
    try {
      const pending = this.writeCheckpoint("interval");
      if (pending && typeof pending.then === "function") {
        void pending.catch((error) => {
          this.logger?.warn({ error }, "interval game shard checkpoint failed; state remains dirty");
        });
      }
    } catch (error) {
      this.logger?.warn({ error }, "interval game shard checkpoint failed; state remains dirty");
    }
  }

  private writeCheckpoint(reason: string, force = false): void | Promise<void> {
    const path = this.persistence.checkpointPath;
    if (!path || (!this.persistenceDirty && !force)) return;
    if (this.rustAuthorityMode === "live" && this.rustAuthorityBridge) {
      return this.writeLiveRustAuthorityCheckpoint(reason, path);
    }
    this.writeCheckpointFile(this.createCheckpoint(), reason, path);
  }

  private writeLiveRustAuthorityCheckpoint(reason: string, path: string): Promise<void> {
    if (this.rustAuthorityCheckpointPromise) return this.rustAuthorityCheckpointPromise;
    const promise = (async () => {
      if (this.rustAuthorityRestorePromise) await this.rustAuthorityRestorePromise;
      if (this.checkpointCapturePromise) await this.checkpointCapturePromise;
      if (this.rustAuthorityRestoreError) throw this.rustAuthorityRestoreError;
      if (!this.rustAuthorityBridge) throw new Error("rust authority bridge is unavailable for checkpoint export");
      let releaseCapture!: () => void;
      this.checkpointCapturePromise = new Promise<void>((resolve) => { releaseCapture = resolve; });
      try {
        const exported = await this.rustAuthorityBridge.exportState({ timeoutMs: 10_000 });
        const stateHash = exported.stateHash ?? exported.state?.stateHash;
        if (!exported.state || typeof stateHash !== "string" || stateHash.length === 0
          || (typeof exported.state.stateHash === "string" && exported.state.stateHash !== stateHash)) {
          throw new Error("rust authority bridge exported an invalid checkpoint state");
        }
        const rustAuthority: RustAuthorityCheckpointState = {
          schema: "authority.checkpoint-state.v1",
          version: 1,
          tick: Number.isFinite(exported.tick) ? Number(exported.tick) : this.tick,
          stateHash,
          state: exported.state,
        };
        this.recordRustAuthorityStateHash(stateHash);
        this.writeCheckpointFile(this.createCheckpoint(rustAuthority), reason, path);
      } finally {
        releaseCapture();
        this.checkpointCapturePromise = undefined;
      }
    })();
    const inFlight: Promise<void> = promise.finally(() => {
      if (this.rustAuthorityCheckpointPromise === inFlight) this.rustAuthorityCheckpointPromise = undefined;
    });
    this.rustAuthorityCheckpointPromise = inFlight;
    return inFlight.catch((error) => {
      this.persistenceWriteFailure = error instanceof Error ? error.message : String(error);
      this.logger?.warn({ error, checkpointPath: path }, "failed to write live Rust authority checkpoint");
      throw error;
    });
  }

  private writeCheckpointFile(checkpoint: GameShardCheckpoint, reason: string, path: string): void {
    this.lastCheckpointAttemptMs = this.clock.nowMs();
    try {
      const dir = dirname(path);
      fs.mkdirSync(dir, { recursive: true });
      const tmpPath = `${path}.tmp-${process.pid}`;
      let fd: number | undefined;
      try {
        fd = fs.openSync(tmpPath, "w", 0o600);
        fs.writeFileSync(fd, `${JSON.stringify(checkpoint, null, 2)}\n`);
        fs.fsyncSync(fd);
        fs.closeSync(fd);
        fd = undefined;
        // The checkpoint marker anchors Rust journal replay. Persist all
        // pending journal rows plus that marker before making the checkpoint
        // visible, so a journal failure can never publish an unanchored save.
        this.appendJournal({
          type: "checkpoint",
          at: checkpoint.savedAt,
          tick: checkpoint.tick,
          reason,
          actorCount: checkpoint.actors.length,
          stateHash: checkpoint.stateHash,
        });
        if (!this.flushJournal()) throw new Error("game shard checkpoint journal flush failed");
        fs.renameSync(tmpPath, path);
        fsyncDirectory(dir);
        const manifestPath = this.persistence.manifestPath;
        if (manifestPath) {
          const manifestTmp = `${manifestPath}.tmp-${process.pid}`;
          let manifestFd: number | undefined;
          try {
            manifestFd = fs.openSync(manifestTmp, "w", 0o600);
            fs.writeFileSync(manifestFd, `${JSON.stringify(this.durabilityManifest, null, 2)}\n`);
            fs.fsyncSync(manifestFd);
            fs.closeSync(manifestFd);
            manifestFd = undefined;
            fs.renameSync(manifestTmp, manifestPath);
            fsyncDirectory(dirname(manifestPath));
          } finally {
            if (manifestFd !== undefined) fs.closeSync(manifestFd);
            fs.rmSync(manifestTmp, { force: true });
          }
        }
      } finally {
        if (fd !== undefined) fs.closeSync(fd);
        fs.rmSync(tmpPath, { force: true });
      }
      this.lastCheckpointAt = checkpoint.savedAt;
      this.lastCheckpointTick = checkpoint.tick;
      this.lastCheckpointReason = reason;
      this.checkpointWriteCount += 1;
      this.persistenceDirty = false;
    } catch (error) {
      this.persistenceDirty = true;
      this.persistenceWriteFailure = error instanceof Error ? error.message : String(error);
      this.logger?.warn({ error, checkpointPath: path }, "failed to write game shard checkpoint");
      throw error;
    }
  }

  private createCheckpoint(rustAuthority?: RustAuthorityCheckpointState): GameShardCheckpoint {
    const actors = [...this.actors.values()]
      .filter((actor) => this.authoredActorIds.has(actor.id) && actor.id !== "player")
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((actor) => persistActor(actor));
    const checkpointState: GameShardCheckpointProjection = {
      schema: checkpointSchema,
      shardId: this.shardId,
      sliceHash: this.sliceHash,
      sourceStateHash: this.sourceStateHash,
      tick: rustAuthority?.tick ?? this.tick,
      tickRateHz: this.tickRateHz,
      nextCombatEventId: this.nextCombatEventId,
      nextBotSeq: this.nextBotSeq,
      counters: { ...this.counters },
      actors,
      ...(this.authoredPlaceholderOwners.size > 0 ? {
        authoredPlaceholderOwners: Object.fromEntries(
          [...this.authoredPlaceholderOwners.entries()].sort(([left], [right]) => left.localeCompare(right)),
        ),
      } : {}),
      propStates: this.propStatesSnapshot(),
      travelTickets: [...this.travelTicketRows.values()]
        .map((row) => ({ ...row, metadata: cloneInventoryMetadata(row.metadata) }))
        .sort((left, right) => left.container.localeCompare(right.container) || left.stackId - right.stackId),
      manifest: this.durabilityManifest,
    };
    const projectionStateHash = this.checkpointProjectionStateHash(checkpointState);
    return {
      ...checkpointState,
      savedAt: new Date().toISOString(),
      stateHash: rustAuthority?.stateHash ?? projectionStateHash,
      projectionStateHash,
      ...(rustAuthority ? { rustAuthority } : {}),
    };
  }

  private checkpointProjectionStateHash(checkpoint: GameShardCheckpointProjection): string {
    const persistedProjection = JSON.parse(JSON.stringify({
      schema: checkpoint.schema,
      shardId: checkpoint.shardId,
      ...(typeof checkpoint.sourceStateHash === "string" ? { sourceStateHash: checkpoint.sourceStateHash } : {}),
      sliceHash: checkpoint.sliceHash,
      tick: checkpoint.tick,
      tickRateHz: checkpoint.tickRateHz,
      nextCombatEventId: checkpoint.nextCombatEventId,
      nextBotSeq: checkpoint.nextBotSeq,
      counters: checkpoint.counters,
      actors: checkpoint.actors,
      ...(checkpoint.authoredPlaceholderOwners ? {
        authoredPlaceholderOwners: checkpoint.authoredPlaceholderOwners,
      } : {}),
      propStates: checkpoint.propStates ?? {},
      travelTickets: checkpoint.travelTickets ?? [],
      ...(checkpoint.manifest ? { manifest: checkpoint.manifest } : {}),
    })) as unknown;
    return hashStable(persistedProjection);
  }

  private persistenceStatus(): GameShardPersistenceStatus {
    const checkpoint = this.createCheckpoint();
    return {
      enabled: Boolean(this.persistence.checkpointPath || this.persistence.journalPath),
      checkpointPath: this.persistence.checkpointPath,
      journalPath: this.persistence.journalPath,
      checkpointIntervalMs: this.persistence.checkpointIntervalMs,
      checkpointWriteCount: this.checkpointWriteCount,
      journalBufferedEntries: this.journalBuffer.length,
      commitWorkerInFlight: Boolean(this.journalCommitPromise),
      journalCommitCount: this.journalCommitCount,
      lastJournalCommitAt: this.lastJournalCommitAt,
      ...(this.persistenceWriteFailure ? { writeFailure: this.persistenceWriteFailure } : {}),
      lastCheckpointAt: this.lastCheckpointAt,
      lastCheckpointTick: this.lastCheckpointTick,
      lastCheckpointReason: this.lastCheckpointReason,
      restore: this.restoredCheckpoint,
      stateHash: this.lastRustAuthorityStateHash ?? checkpoint.stateHash,
    };
  }

  private readinessStatus(): GameShardStatus["readiness"] {
    const persistenceEnabled = Boolean(this.persistence.checkpointPath || this.persistence.journalPath);
    const lock = !persistenceEnabled || hostedStateLockHealthy();
    const restore = this.restoredCheckpoint?.loaded === true || this.restoredCheckpoint?.reason === "missing" || this.restoredCheckpoint?.reason === "disabled";
    const writablePersistence = !this.persistenceWriteFailure;
    const commitWorker = !this.closed && (!this.persistence.journalPath || this.journalBuffer.length === 0);
    const bridge = this.rustAuthorityBridge?.debugStatus();
    const rustChild = this.rustAuthorityMode !== "live" || Boolean(bridge && !bridge.closed && bridge.childExitCode === null && bridge.childSignalCode === null);
    const ready = lock && restore && writablePersistence && commitWorker && rustChild;
    return { ready, lock, preflight: restore, restore, writablePersistence, commitWorker, rustChild };
  }

  private appendCombatEventJournal(events: GameCombatEvent[]): void {
    for (const event of events) {
      this.appendJournal({
        type: "combat.event",
        at: new Date().toISOString(),
        tick: this.tick,
        event,
      });
    }
  }

  private appendJournal(entry: JournalEntry): void {
    if (!this.persistence.journalPath) return;
    this.journalBuffer.push(JSON.stringify(entry));
    // Commit worker batches all commands that arrive within the bounded window.
  }

  private appendLifecycleJournal(entry: JournalEntry): void {
    this.appendJournal(entry);
    // Session lifecycle events have no command receipt that can await the
    // ordinary commit worker. Commit them now so a routine join or leave never
    // strands an uncommitted journal tail and drops hosted readiness.
    this.flushJournal();
  }

  private flushJournalIfNeeded(): void {
    if (this.journalBuffer.length >= journalFlushEntryThreshold) void this.commitJournalGroup();
  }

  private commitJournalGroup(): Promise<boolean> {
    if (!this.persistence.journalPath || this.journalBuffer.length === 0) return Promise.resolve(true);
    if (this.journalCommitPromise) return this.journalCommitPromise;
    this.journalCommitPromise = new Promise<boolean>((resolve) => {
      this.journalCommitTimer = setTimeout(() => {
        this.journalCommitTimer = undefined;
        const ok = this.flushJournal();
        this.journalCommitPromise = undefined;
        resolve(ok);
      }, 5);
      this.journalCommitTimer.unref();
    });
    return this.journalCommitPromise;
  }

  private flushJournal(): boolean {
    const path = this.persistence.journalPath;
    if (!path || this.journalBuffer.length === 0) return true;
    const entryCount = this.journalBuffer.length;
    const chunk = `${this.journalBuffer.slice(0, entryCount).join("\n")}\n`;
    let fd: number | undefined;
    try {
      const dir = dirname(path);
      fs.mkdirSync(dir, { recursive: true });
      fd = fs.openSync(path, "a", 0o600);
      fs.writeFileSync(fd, chunk);
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = undefined;
      fsyncDirectory(dir);
      this.journalBuffer.splice(0, entryCount);
      this.journalCommitCount += 1;
      this.lastJournalCommitAt = new Date().toISOString();
      return true;
    } catch (error) {
      this.persistenceWriteFailure = error instanceof Error ? error.message : String(error);
      this.logger?.warn({ error, journalPath: path }, "failed to write game shard journal");
      return false;
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  }

  private gameCounters(): GameShardSnapshot["counters"] {
    return {
      acceptedCommands: this.counters.acceptedCommands,
      rejectedCommands: this.counters.rejectedCommands,
      shotsFired: this.counters.shotsFired,
      hits: this.counters.hits,
      deaths: this.counters.deaths,
    };
  }
}

function persistActor(actor: AuthorityActor): PersistedAuthorityActor {
  return {
    id: actor.id,
    wornColors: cloneWornColors(actor.wornColors),
    label: actor.label,
    displayName: actor.displayName,
    linkDead: actor.linkDead,
    appearance: normalizeActorAppearance(actor.appearance),
    ...(actor.worn && actor.worn.length > 0 ? { worn: cloneActorWorn(actor.worn) } : {}),
    characterId: actor.characterId,
    sprite: actor.sprite,
    role: actor.role,
    factionId: actor.factionId,
    socialGroup: actor.socialGroup,
    pvpStatus: actor.pvpStatus,
    willAutoAggro: actor.willAutoAggro ?? false,
    playerOrganizationId: actor.playerOrganizationId,
    playerOrganizationTag: actor.playerOrganizationTag,
    areaId: actor.areaId,
    x: actor.x,
    y: actor.y,
    direction: actor.direction,
    posture: actor.posture,
    postureUntilTick: actor.postureUntilTick,
    inCombat: actor.inCombat,
    combatQueue: actor.combatQueue,
    peaceRequested: actor.peaceRequested,
    engagementTargetId: actor.engagementTargetId,
    scale: actor.scale,
    professionIds: actor.professionIds?.slice(),
    skillBoxIds: actorSkillBoxIds(actor),
    activeTitleId: actor.activeTitleId ?? actor.activeTitle?.id ?? null,
    capabilities: actor.capabilities?.slice(),
    careerGoalId: actor.careerGoalId,
    credits: actor.credits,
    lifeState: actor.lifeState,
    lifecycleSeq: positiveIntegerOr(actor.lifecycleSeq, 1),
    vitals: { ...actor.vitals },
    maxVitals: { ...actor.maxVitals },
    effectiveStats: actor.effectiveStats,
    bleed: {
      active: actor.bleed.active,
      stackCount: actor.bleed.stackCount,
      severity: actor.bleed.severity,
      remainingMs: actor.bleed.remainingMs,
      ratesPerSecond: { ...actor.bleed.ratesPerSecond },
      stacks: actor.bleed.stacks.map((stack) => ({
        id: stack.id,
        severity: stack.severity,
        remainingMs: stack.remainingMs,
        ratesPerSecond: { ...stack.ratesPerSecond },
      })),
    },
    statuses: actor.statuses.filter((status) => status.id !== "sleeping").map((status) => ({ ...status })),
    suppression: cloneSuppression(actor.suppression),
    sleep: inactiveSleep(),
    nextMoveTick: actor.nextMoveTick,
    sprintRegenBlockedUntilTick: actor.sprintRegenBlockedUntilTick,
    sprintActionDrainMilli: actor.sprintActionDrainMilli ?? 0,
    nextBleedStackId: actor.nextBleedStackId,
    recentIncomingDamage: actor.recentIncomingDamage,
    respawnAtTick: actor.respawnAtTick,
    nextSampleTick: finiteInteger(actor.nextSampleTick, 0),
    bodyVanishAtTick: actor.bodyVanishAtTick,
    lootable: actor.lootable,
    hasLoot: actor.hasLoot,
    lootRightsActorId: actor.lootRightsActorId,
    cloneSicknessRemainingMs: actor.cloneSicknessRemainingMs,
    incapRemainingMs: actor.incapRemainingMs,
    incapCount: actor.incapCount,
    incapWindowMs: actor.incapWindowMs,
    route: actor.route.map((point) => ({ ...point })),
    routeIndex: actor.routeIndex,
    homeAreaId: actor.homeAreaId,
    homeCell: { ...actor.homeCell },
    homeDirection: actor.homeDirection,
    homeRoute: actor.homeRoute.map((point) => ({ ...point })),
  };
}

function restorePersistedActor(actor: PersistedAuthorityActor): AuthorityActor {
  const restored: AuthorityActor = {
    ...persistActor(actor as AuthorityActor),
    suppression: cloneSuppression(actor.suppression),
    sleep: inactiveSleep(),
    nextMoveTick: actor.nextMoveTick ?? 0,
    sprintRegenBlockedUntilTick: actor.sprintRegenBlockedUntilTick ?? 0,
    lifecycleSeq: positiveIntegerOr(actor.lifecycleSeq, 1),
    posture: normalizeActorPosture(actor.posture),
    postureUntilTick: finiteInteger(actor.postureUntilTick, 0),
    wornColors: normalizeWornColorsMap(actor.wornColors, actor.worn ?? []),
    displayName: normalizeDisplayName(actor.displayName ?? actor.label, actor.label),
    linkDead: actor.linkDead === true,
    appearance: normalizeActorAppearance(actor.appearance),
    worn: normalizeActorWorn((actor as { worn?: unknown }).worn),
    role: actor.role ?? "default",
    factionId: normalizeFactionId(actor.factionId),
    socialGroup: normalizeFactionId(actor.socialGroup),
    pvpStatus: normalizeFactionPvpStatus(actor.pvpStatus),
    playerOrganizationId: normalizeNullableString(actor.playerOrganizationId),
    playerOrganizationTag: normalizeNullableString(actor.playerOrganizationTag),
    effectiveStats: normalizeEffectiveActorStats(actor.role, actor.effectiveStats),
    professionIds: normalizeProfessionIds(actor.professionIds),
    skillBoxIds: normalizeSkillBoxIds(actor.skillBoxIds),
    activeTitleId: normalizeNullableString(actor.activeTitleId),
    capabilities: normalizeCapabilityGrants(actor.capabilities),
    careerGoalId: normalizeNullableString(actor.careerGoalId),
    credits: normalizeCredits(actor.credits),
    nextSampleTick: finiteInteger(actor.nextSampleTick, 0),
    cloneSicknessRemainingMs: actor.cloneSicknessRemainingMs ?? 0,
    incapRemainingMs: actor.incapRemainingMs ?? 0,
    incapCount: actor.incapCount ?? 0,
    incapWindowMs: actor.incapWindowMs ?? 0,
    peaceRequested: actor.peaceRequested === true,
    engagementTargetId: normalizeNullableString(actor.engagementTargetId),
    lootable: actor.lootable === true,
    hasLoot: actor.hasLoot === true,
    lootRightsActorId: normalizeNullableString(actor.lootRightsActorId),
    scale: normalizeActorScale(actor.scale),
    seenCommands: new Set<number>(),
  };
  restored.activeTitle = titleFromSkillBoxes(
    restored.activeTitleId,
    restored.skillBoxIds,
    restored.professionIds,
  );
  restored.statuses = restored.statuses.filter((status) => (
    status.id !== "sleeping" &&
    (restored.lifeState !== "alive" || (status.id !== "dead" && status.id !== "downed"))
  ));
  if (restored.lifeState === "alive") {
    restored.respawnAtTick = 0;
    restored.bodyVanishAtTick = 0;
    restored.cloneSicknessRemainingMs = 0;
  }
  return restored;
}

interface CreateActorOptions {
  displayName?: string | null;
  linkDead?: boolean | null;
  appearance?: GameActorAppearanceSnapshot | null;
  characterId?: string | null;
  role?: string;
  sprite?: string | null;
  scale?: number;
  templateId?: string | null;
  spawnZoneId?: string | null;
  factionId?: string | null;
  socialGroup?: string | null;
  pvpStatus?: string | null;
  aiAttitude?: string | null;
  willAutoAggro?: boolean;
  playerOrganizationId?: string | null;
  playerOrganizationTag?: string | null;
  professionIds?: string[];
  skillBoxIds?: string[];
  activeTitleId?: string | null;
  capabilities?: string[];
  careerGoalId?: string | null;
  credits?: number;
  vitals?: Partial<GameActorVitals>;
  maxVitals?: Partial<GameActorVitals>;
  combatQueue?: GameActorCombatQueueSnapshot | null;
  inCombat?: boolean;
  peaceRequested?: boolean;
  engagementTargetId?: string | null;
}

function createActorOptionsFromActor(actor: AuthorityActor): CreateActorOptions {
  return {
    displayName: actor.displayName,
    linkDead: actor.linkDead,
    appearance: cloneActorAppearance(actor.appearance),
    characterId: actor.characterId,
    role: actor.role,
    sprite: actor.sprite,
    scale: actor.scale,
    templateId: actor.templateId,
    spawnZoneId: actor.spawnZoneId,
    factionId: actor.factionId,
    socialGroup: actor.socialGroup,
    pvpStatus: actor.pvpStatus,
    aiAttitude: actor.aiAttitude,
    willAutoAggro: actor.willAutoAggro,
    playerOrganizationId: actor.playerOrganizationId,
    playerOrganizationTag: actor.playerOrganizationTag,
    professionIds: actor.professionIds,
    skillBoxIds: actorSkillBoxIds(actor),
    activeTitleId: actor.activeTitleId ?? actor.activeTitle?.id ?? null,
    capabilities: actor.capabilities,
    careerGoalId: actor.careerGoalId,
    credits: actor.credits,
    maxVitals: actor.maxVitals,
    combatQueue: cloneActorCombatQueue(actor.combatQueue),
    inCombat: actor.inCombat,
    peaceRequested: actor.peaceRequested,
    engagementTargetId: actor.engagementTargetId,
  };
}

function normalizeEffectiveActorStats(role: string | undefined, stats: EffectiveActorStats | undefined): EffectiveActorStats {
  const derived = deriveEffectiveActorStatsForRole(role);
  if (!stats) return derived;
  return {
    ...derived,
    ...stats,
    spawnVitals: stats.spawnVitals ?? derived.spawnVitals,
  };
}

function createActor(
  id: string,
  label: string,
  areaId: string,
  cell: Cell,
  direction: Direction,
  route: Cell[] = [],
  options: CreateActorOptions = {},
): AuthorityActor {
  const role = options.role ?? (id === "player" ? "player" : undefined);
  const effectiveStats = deriveEffectiveActorStatsForRole(role);
  const maxVitals = mergeVitals(effectiveStats.maxVitals, options.maxVitals);
  const vitals = mergeVitals(maxVitals, options.vitals);
  const routePath = route.length > 1 ? route.map((point) => ({ ...point })) : [];
  const routeIndex = routePath.findIndex((point) => point.x !== cell.x || point.y !== cell.y);
  return {
    id,
    label,
    displayName: normalizeDisplayName(options.displayName ?? label, label),
    linkDead: options.linkDead === true,
    appearance: normalizeActorAppearance(options.appearance),
    characterId: normalizeNullableString(options.characterId) ?? undefined,
    sprite: normalizeNullableString(options.sprite),
    wornColors: {},
    role: role ?? "default",
    templateId: normalizeNullableString(options.templateId),
    spawnZoneId: normalizeNullableString(options.spawnZoneId),
    factionId: normalizeFactionId(options.factionId),
    socialGroup: normalizeFactionId(options.socialGroup),
    pvpStatus: normalizeFactionPvpStatus(options.pvpStatus),
    aiAttitude: normalizeActorAiAttitude(options.aiAttitude),
    willAutoAggro: options.willAutoAggro ?? false,
    playerOrganizationId: normalizeNullableString(options.playerOrganizationId),
    playerOrganizationTag: normalizeNullableString(options.playerOrganizationTag),
    professionIds: normalizeProfessionIds(options.professionIds),
    skillBoxIds: normalizeSkillBoxIds(options.skillBoxIds),
    activeTitleId: normalizeNullableString(options.activeTitleId),
    activeTitle: titleFromSkillBoxes(options.activeTitleId, options.skillBoxIds, options.professionIds),
    capabilities: normalizeCapabilityGrants(options.capabilities),
    careerGoalId: normalizeNullableString(options.careerGoalId),
    credits: normalizeCredits(options.credits),
    areaId,
    x: cell.x,
    y: cell.y,
    direction,
    posture: "standing",
    postureUntilTick: 0,
    lifeState: "alive",
    lifecycleSeq: 1,
    vitals,
    maxVitals,
    effectiveStats,
    bleed: inactiveBleed(),
    statuses: [],
    mobility: undefined,
    seenCommands: new Set<number>(),
    nextBleedStackId: 1,
    recentIncomingDamage: 0,
    suppression: inactiveSuppression(),
    sleep: inactiveSleep(),
    nextMoveTick: 0,
    sprintRegenBlockedUntilTick: 0,
    sprintActionDrainMilli: 0,
    combatQueue: cloneActorCombatQueue(options.combatQueue),
    inCombat: options.inCombat === true,
    peaceRequested: options.peaceRequested === true,
    engagementTargetId: normalizeNullableString(options.engagementTargetId),
    respawnAtTick: 0,
    nextSampleTick: 0,
    bodyVanishAtTick: 0,
    lootable: false,
    hasLoot: false,
    lootRightsActorId: null,
    cloneSicknessRemainingMs: 0,
    incapRemainingMs: 0,
    incapCount: 0,
    incapWindowMs: 0,
    route: routePath,
    routeIndex: routeIndex >= 0 ? routeIndex : 0,
    homeAreaId: areaId,
    homeCell: { ...cell },
    homeDirection: direction,
    homeRoute: routePath.map((point) => ({ ...point })),
    scale: normalizeActorScale(options.scale),
  };
}

function mergeVitals(base: GameActorVitals, overrides?: Partial<GameActorVitals>): GameActorVitals {
  return {
    health: positiveNumberOr(overrides?.health, base.health),
    action: positiveNumberOr(overrides?.action, base.action),
    spirit: positiveNumberOr(overrides?.spirit, base.spirit),
  };
}

function normalizeActorScale(value: unknown): number {
  const numeric = typeof value === "number" ? value : Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? Math.min(6, Math.max(0.25, numeric)) : 1;
}

function normalizeActorFace(value: unknown): GameActorFaceSnapshot | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Partial<GameActorFaceSnapshot>;
  const token = (field: unknown): string | null =>
    typeof field === "string" && /^[a-z][a-z0-9_]{0,32}$/u.test(field) ? field : null;
  const color = (field: unknown): string | null =>
    typeof field === "string" && /^#[0-9a-f]{6}$/u.test(field.toLowerCase()) ? field.toLowerCase() : null;
  const eyes = token(raw.eyes);
  const brows = token(raw.brows);
  const nose = token(raw.nose);
  const mouth = token(raw.mouth);
  const eye_color = color(raw.eye_color);
  const brow_color = color(raw.brow_color);
  const lip_color = color(raw.lip_color);
  if (!eyes || !brows || !nose || !mouth || !eye_color || !brow_color || !lip_color) return null;
  return { eyes, brows, nose, mouth, eye_color, brow_color, lip_color };
}

function normalizeActorAppearance(value: unknown): GameActorAppearanceSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) return cloneActorAppearance(defaultActorAppearance);
  const raw = value as Partial<GameActorAppearanceSnapshot>;
  const skin = typeof raw.skin === "string" && /^#[0-9a-f]{6}$/u.test(raw.skin.toLowerCase())
    ? raw.skin.toLowerCase()
    : defaultActorAppearance.skin;
  const hair = typeof raw.hair === "string" && raw.hair.length > 0 ? raw.hair : null;
  const hair_mat = typeof raw.hair_mat === "string" && raw.hair_mat.length > 0 ? raw.hair_mat : defaultActorAppearance.hair_mat;
  return { skin, hair, hair_mat, face: normalizeActorFace(raw.face) };
}

function normalizeRustActorAppearance(
  snapshot: RustAuthorityActorSnapshot,
  fallback: GameActorAppearanceSnapshot = defaultActorAppearance,
): GameActorAppearanceSnapshot {
  if (!snapshot.appearance) return cloneActorAppearance(fallback);
  return normalizeActorAppearance(snapshot.appearance);
}

function cloneActorAppearance(appearance: GameActorAppearanceSnapshot): GameActorAppearanceSnapshot {
  return {
    skin: appearance.skin,
    hair: appearance.hair ?? null,
    hair_mat: appearance.hair_mat,
    face: appearance.face ? { ...appearance.face } : null,
  };
}

function sameActorFace(left: GameActorFaceSnapshot | null, right: GameActorFaceSnapshot | null): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  return left.eyes === right.eyes
    && left.brows === right.brows
    && left.nose === right.nose
    && left.mouth === right.mouth
    && left.eye_color === right.eye_color
    && left.brow_color === right.brow_color
    && left.lip_color === right.lip_color;
}

function sameActorAppearance(left: GameActorAppearanceSnapshot, right: GameActorAppearanceSnapshot): boolean {
  return left.skin === right.skin && left.hair === right.hair && left.hair_mat === right.hair_mat
    && sameActorFace(left.face ?? null, right.face ?? null);
}

function cloneActorWorn(worn: readonly GameActorWornPiece[]): GameActorWornPiece[] {
  return worn.map((piece) => ({ item: piece.item, colors: [...piece.colors] }));
}

function cloneWornColors(value: Record<string, string[]> | undefined): Record<string, string[]> {
  return Object.fromEntries(Object.entries(value ?? {}).map(([item, colors]) => [item, [...colors]]));
}


function normalizeWornColorsMap(value: unknown, worn: readonly GameActorWornPiece[]): Record<string, string[]> {
  const source = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const normalized: Record<string, string[]> = {};
  for (const [item, colors] of Object.entries(source)) {
    if (!wornItemIdPattern.test(item) || !Array.isArray(colors)) continue;
    normalized[item] = colors.filter((color): color is string => typeof color === "string" && wornColorHexPattern.test(color.toLowerCase()));
  }
  if (Object.keys(normalized).length > 0) return normalized;
  return Object.fromEntries(worn.map((piece) => [piece.item, [...piece.colors]]));
}

function sameActorWorn(left: readonly GameActorWornPiece[] | undefined, right: readonly GameActorWornPiece[] | undefined): boolean {
  const a = left ?? [];
  const b = right ?? [];
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i]!.item !== b[i]!.item) return false;
    if (a[i]!.colors.length !== b[i]!.colors.length) return false;
    for (let c = 0; c < a[i]!.colors.length; c += 1) {
      if (a[i]!.colors[c] !== b[i]!.colors[c]) return false;
    }
  }
  return true;
}

const maxWornPieces = 8;
const maxWornColors = 3;
const wornItemIdPattern = /^[a-z0-9][a-z0-9_]{0,63}$/u;
const wornColorHexPattern = /^#[0-9a-f]{6}$/u;

/** Shape-normalize an untrusted worn list (checkpoint restore path). */
function normalizeActorWorn(value: unknown): GameActorWornPiece[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const worn: GameActorWornPiece[] = [];
  for (const raw of value) {
    if (worn.length >= maxWornPieces) break;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const item = typeof (raw as { item?: unknown }).item === "string" ? (raw as { item: string }).item.trim() : "";
    if (!wornItemIdPattern.test(item)) continue;
    const rawColors = (raw as { colors?: unknown }).colors;
    const colors: string[] = [];
    if (Array.isArray(rawColors)) {
      for (const color of rawColors) {
        if (colors.length >= maxWornColors) break;
        if (typeof color === "string" && wornColorHexPattern.test(color.trim().toLowerCase())) {
          colors.push(color.trim().toLowerCase());
        }
      }
    }
    worn.push({ item, colors });
  }
  return worn.length > 0 ? worn : undefined;
}

function normalizeCredits(value: unknown): number | undefined {
  const numeric = typeof value === "number" ? value : Number(value);
  return Number.isFinite(numeric) ? Math.max(0, Math.trunc(numeric)) : undefined;
}

function normalizeStringGrants(values: unknown): string[] | undefined {
  if (!Array.isArray(values)) return undefined;
  const grants = [...new Set(values
    .map((value) => typeof value === "string" ? value.trim() : "")
    .filter((value) => value.length > 0))];
  return grants.length > 0 ? grants : undefined;
}

function normalizeCapabilityGrants(capabilities: unknown): string[] | undefined {
  return normalizeStringGrants(capabilities);
}

function normalizeProfessionIds(professionIds: unknown): string[] | undefined {
  return normalizeStringGrants(professionIds);
}

function normalizeSkillBoxIds(skillBoxIds: unknown): string[] | undefined {
  return normalizeStringGrants(skillBoxIds);
}

function normalizeNullableString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function titleFromSkillBoxes(
  activeTitleId: string | null | undefined,
  skillBoxIds: string[] | undefined,
  professionIds: string[] | undefined,
): GameActorSnapshot["activeTitle"] {
  const grantedSkillBoxes = new Set([
    ...(normalizeSkillBoxIds(skillBoxIds) ?? []),
    ...(normalizeProfessionIds(professionIds) ?? []).map((professionId) => `${professionId}-novice`),
  ]);
  const requested = normalizeNullableString(activeTitleId);
  const titleId = requested && grantedSkillBoxes.has(requested)
    ? requested
    : defaultTitleSkillBoxId(grantedSkillBoxes);
  if (!titleId) return null;
  const label = skillBoxTitle(titleId);
  return label ? { id: titleId, label, skillBoxId: titleId } : null;
}

function defaultTitleSkillBoxId(grantedSkillBoxes: Set<string>): string | null {
  const titleSkillBoxIds = [...grantedSkillBoxes].filter((skillBoxId) => skillBoxTitle(skillBoxId) !== null);
  return titleSkillBoxIds.find((skillBoxId) => skillBoxProfessionId(skillBoxId) !== "marksman")
    ?? titleSkillBoxIds[0]
    ?? null;
}

function skillBoxTitle(skillBoxId: string): string | null {
  const normalized = skillBoxId.trim().toLowerCase();
  const novice = normalized.match(/^([a-z0-9]+)-novice$/);
  if (novice) return `Novice ${professionTitleLabel(novice[1]!)}`;
  const master = normalized.match(/^([a-z0-9]+)-master$/);
  if (master) return `Master ${professionTitleLabel(master[1]!)}`;
  return null;
}

function skillBoxProfessionId(skillBoxId: string): string | null {
  return skillBoxId.trim().toLowerCase().match(/^([a-z0-9]+)-(?:novice|master)$/)?.[1] ?? null;
}

function professionTitleLabel(professionId: string): string {
  if (professionId === "marksman") return "Marksman";
  if (professionId === "brawler") return "Brawler";
  if (professionId === "craftsman") return "Craftsman";
  if (professionId === "medic") return "Medic";
  if (professionId === "scout") return "Scout";
  return professionId.slice(0, 1).toUpperCase() + professionId.slice(1);
}

function actorSkillBoxIds(actor: Pick<AuthorityActor, "skillBoxIds" | "professions">): string[] | undefined {
  return normalizeSkillBoxIds([
    ...(actor.skillBoxIds ?? []),
    ...((actor.professions ?? []).flatMap((profession) => profession.skillBoxes ?? [])),
  ]);
}

function routeIndexAfterReturn(route: Cell[], cell: Cell): number {
  if (route.length < 2) return 0;
  const index = route.findIndex((point) => Math.hypot(point.x - cell.x, point.y - cell.y) > 0.001);
  return index >= 0 ? index : 0;
}

function isSkirmisherRole(role: string): boolean {
  return role === "skirmisher"
    || role.startsWith("skirmisher_");
}

function npcRespawnTimingSeconds(actor: Pick<AuthorityActor, "id" | "role">): { bodyVisible: number; hiddenDelay: number } {
  if (isSkirmisherRole(actor.role)) {
    return {
      bodyVisible: skirmisherDeadBodyVisibleSeconds,
      hiddenDelay: skirmisherRespawnDelayAfterBodyVanishSeconds,
    };
  }
  return {
    bodyVisible: npcDeadBodyVisibleSeconds,
    hiddenDelay: npcRespawnDelayAfterBodyVanishSeconds,
  };
}


function actorSnapshot(actor: AuthorityActor): GameActorSnapshot {
  return {
    id: actor.id,
    label: actor.label,
    display_name: actor.displayName,
    descriptor: actor.descriptor,
    link_dead: actor.linkDead,
    appearance: cloneActorAppearance(actor.appearance),
    ...(actor.worn && actor.worn.length > 0 ? { worn: cloneActorWorn(actor.worn) } : {}),
    wornColors: cloneWornColors(actor.wornColors),
    sprite: actor.sprite,
    role: actor.role,
    factionId: actor.factionId,
    socialGroup: actor.socialGroup,
    pvpStatus: actor.pvpStatus,
    playerOrganizationId: actor.playerOrganizationId,
    playerOrganizationTag: actor.playerOrganizationTag,
    areaId: actor.areaId,
    x: round(actor.x),
    y: round(actor.y),
    direction: actor.direction,
    posture: actor.posture,
    postureUntilTick: actor.postureUntilTick,
    lifeState: actor.lifeState,
    lifecycleSeq: actor.lifecycleSeq,
    vitals: {
      health: round(actor.vitals.health),
      action: round(actor.vitals.action),
      spirit: round(actor.vitals.spirit),
    },
    maxVitals: { ...actor.maxVitals },
    bleed: {
      active: actor.bleed.active,
      stackCount: actor.bleed.stackCount,
      severity: round(actor.bleed.severity),
      remainingMs: Math.round(actor.bleed.remainingMs),
      ratesPerSecond: { ...actor.bleed.ratesPerSecond },
    },
    statuses: actor.statuses.map(statusSnapshot),
    ...(actor.mobility ? { mobility: { ...actor.mobility } } : {}),
    personalShield: normalizeActorPersonalShield(actor.personalShield),
    weapon: normalizeActorWeapon(actor.weapon),
    bodyVanishAtTick: actor.bodyVanishAtTick,
    bodyVanishTick: actor.bodyVanishAtTick,
    lootable: actor.lootable,
    hasLoot: actor.hasLoot,
    lootRightsActorId: actor.lootRightsActorId,
    respawnAtTick: actor.respawnAtTick,
    cloneSicknessRemainingMs: actor.cloneSicknessRemainingMs,
    ...(actor.nextSampleTick > 0 ? { nextSampleTick: actor.nextSampleTick } : {}),
    incapRemainingMs: actor.incapRemainingMs,
    incapCount: actor.incapCount,
    incapWindowMs: actor.incapWindowMs,
    professions: cloneProfessionSnapshots(actor.professions),
    activeTitle: normalizeActorProfessionTitle(actor.activeTitle),
    careerGoalId: actor.careerGoalId,
    skillPointsUsed: actor.skillPointsUsed,
    skillPointsCap: actor.skillPointsCap,
    shotSpreadDegreesMilli: actor.shotSpreadDegreesMilli,
    credits: actor.credits,
    ...(actor.combatQueue ? { combatQueue: cloneActorCombatQueue(actor.combatQueue) } : {}),
    ...(actor.inCombat ? { inCombat: true } : {}),
    ...(actor.peaceRequested ? { peaceRequested: true } : {}),
    ...(actor.engagementTargetId ? { engagementTargetId: actor.engagementTargetId } : {}),
    ...(actor.aiAttitude ? { aiAttitude: actor.aiAttitude } : {}),
    ...(actor.willAutoAggro ? { willAutoAggro: true } : {}),
    ...(actor.stats ? { stats: cloneActorStats(actor.stats) } : {}),
  };
}

function cloneActorStats(stats: NonNullable<GameActorSnapshot["stats"]>): NonNullable<GameActorSnapshot["stats"]> {
  return {
    ...stats,
    lastDeath: stats.lastDeath ? { ...stats.lastDeath } : null,
    recent10s: { ...stats.recent10s },
    recent60s: { ...stats.recent60s },
    ...(stats.longArc ? { longArc: cloneActorLongArcProfile(stats.longArc) } : {}),
  };
}

function cloneActorLongArcProfile(
  profile: NonNullable<NonNullable<GameActorSnapshot["stats"]>["longArc"]>,
): NonNullable<NonNullable<GameActorSnapshot["stats"]>["longArc"]> {
  return {
    ...profile,
    combat: { ...profile.combat },
    mobility: { ...profile.mobility },
    recent: { ...profile.recent },
    engagement: { ...profile.engagement },
  };
}

function statusSnapshot(status: AuthorityStatus): GameActorStatusSnapshot {
  return {
    id: status.id,
    label: status.id === "sleeping" ? "Sleeping" : status.label,
    severity: status.severity,
    remainingMs: Math.round(status.remainingMs),
    ...(status.stacks === undefined ? {} : { stacks: status.stacks }),
    ...(status.threshold === undefined ? {} : { threshold: status.threshold }),
  };
}

function actorPatch(actor: GameActorSnapshot, previous?: GameActorSnapshot, detail = false, includeStatuses = detail): GameActorPatch {
  const patch: GameActorPatch = {
    id: actor.id,
  };
  const contextChanged = previous
    ? actor.areaId !== previous.areaId || actor.lifeState !== previous.lifeState || actor.lifecycleSeq !== previous.lifecycleSeq
    : true;
  if (!previous) {
    patch.label = actor.label;
    patch.display_name = actor.display_name;
    patch.descriptor = actor.descriptor ?? "";
    patch.mobility = actor.mobility ? { ...actor.mobility } : undefined;
    patch.link_dead = actor.link_dead;
    patch.appearance = cloneActorAppearance(actor.appearance);
    if (actor.worn && actor.worn.length > 0) patch.worn = cloneActorWorn(actor.worn);
    patch.sprite = actor.sprite ?? null;
    patch.role = actor.role ?? null;
    patch.factionId = actor.factionId ?? null;
    patch.socialGroup = actor.socialGroup ?? null;
    patch.pvpStatus = actor.pvpStatus ?? "none";
    patch.aiAttitude = actor.aiAttitude ?? null;
    patch.playerOrganizationId = actor.playerOrganizationId ?? null;
    patch.playerOrganizationTag = actor.playerOrganizationTag ?? null;
    patch.areaId = actor.areaId;
    patch.x = actor.x;
    patch.y = actor.y;
    patch.direction = actor.direction;
    patch.posture = actor.posture;
    patch.postureUntilTick = actor.postureUntilTick;
    patch.lifeState = actor.lifeState;
    patch.lifecycleSeq = actor.lifecycleSeq;
    patch.bodyVanishAtTick = actor.bodyVanishAtTick;
    patch.bodyVanishTick = actor.bodyVanishAtTick;
    patch.lootable = actor.lootable;
    patch.hasLoot = actor.hasLoot;
    patch.lootRightsActorId = actor.lootRightsActorId;
    patch.respawnAtTick = actor.respawnAtTick;
    patch.nextSampleTick = actor.nextSampleTick ?? 0;
    patch.cloneSicknessRemainingMs = actor.cloneSicknessRemainingMs;
    patch.incapRemainingMs = actor.incapRemainingMs;
    patch.incapCount = actor.incapCount;
    patch.incapWindowMs = actor.incapWindowMs;
    if (actor.combatQueue) patch.combatQueue = cloneActorCombatQueue(actor.combatQueue);
    if (actor.inCombat) patch.inCombat = true;
    if (actor.peaceRequested) patch.peaceRequested = true;
  } else {
    if (contextChanged || actor.label !== previous.label) patch.label = actor.label;
    if (contextChanged || actor.display_name !== previous.display_name) patch.display_name = actor.display_name;
    if (contextChanged || (actor.descriptor ?? "") !== (previous.descriptor ?? "")) patch.descriptor = actor.descriptor ?? "";
    if (
      contextChanged
      || actor.mobility?.sprintRecoveryLocked !== previous.mobility?.sprintRecoveryLocked
    ) {
      patch.mobility = actor.mobility ? { ...actor.mobility } : undefined;
    }
    if (contextChanged || actor.link_dead !== previous.link_dead) patch.link_dead = actor.link_dead;
    if (contextChanged || !sameActorAppearance(actor.appearance, previous.appearance)) patch.appearance = cloneActorAppearance(actor.appearance);
    if ((contextChanged && actor.worn && actor.worn.length > 0) || !sameActorWorn(actor.worn, previous.worn)) patch.worn = cloneActorWorn(actor.worn ?? []);
    if (contextChanged || actor.sprite !== previous.sprite) patch.sprite = actor.sprite ?? null;
    if (contextChanged || actor.role !== previous.role) patch.role = actor.role ?? null;
    if (contextChanged || actor.factionId !== previous.factionId) patch.factionId = actor.factionId ?? null;
    if (contextChanged || actor.socialGroup !== previous.socialGroup) patch.socialGroup = actor.socialGroup ?? null;
    if (contextChanged || actor.pvpStatus !== previous.pvpStatus) patch.pvpStatus = actor.pvpStatus ?? "none";
    if (contextChanged || actor.aiAttitude !== previous.aiAttitude) patch.aiAttitude = actor.aiAttitude ?? null;
    if (contextChanged || actor.playerOrganizationId !== previous.playerOrganizationId) patch.playerOrganizationId = actor.playerOrganizationId ?? null;
    if (contextChanged || actor.playerOrganizationTag !== previous.playerOrganizationTag) patch.playerOrganizationTag = actor.playerOrganizationTag ?? null;
    if (contextChanged || actor.areaId !== previous.areaId) patch.areaId = actor.areaId;
    if (contextChanged || actor.x !== previous.x) patch.x = actor.x;
    if (contextChanged || actor.y !== previous.y) patch.y = actor.y;
    if (contextChanged || actor.direction !== previous.direction) patch.direction = actor.direction;
    if (contextChanged || actor.posture !== previous.posture) patch.posture = actor.posture;
    if (contextChanged || actor.postureUntilTick !== previous.postureUntilTick) patch.postureUntilTick = actor.postureUntilTick;
    if (contextChanged || actor.lifeState !== previous.lifeState) patch.lifeState = actor.lifeState;
    if (contextChanged || actor.lifecycleSeq !== previous.lifecycleSeq) patch.lifecycleSeq = actor.lifecycleSeq;
    if (contextChanged || actor.bodyVanishAtTick !== previous.bodyVanishAtTick) patch.bodyVanishAtTick = actor.bodyVanishAtTick;
    if (contextChanged || actor.bodyVanishAtTick !== previous.bodyVanishAtTick) patch.bodyVanishTick = actor.bodyVanishAtTick;
    if (contextChanged || actor.lootable !== previous.lootable) patch.lootable = actor.lootable;
    if (contextChanged || actor.hasLoot !== previous.hasLoot) patch.hasLoot = actor.hasLoot;
    if (contextChanged || actor.lootRightsActorId !== previous.lootRightsActorId) patch.lootRightsActorId = actor.lootRightsActorId ?? null;
    if (contextChanged || actor.respawnAtTick !== previous.respawnAtTick) patch.respawnAtTick = actor.respawnAtTick;
    if (contextChanged || actor.nextSampleTick !== previous.nextSampleTick) patch.nextSampleTick = actor.nextSampleTick ?? null;
    if (contextChanged || actor.cloneSicknessRemainingMs !== previous.cloneSicknessRemainingMs) patch.cloneSicknessRemainingMs = actor.cloneSicknessRemainingMs;
    if (contextChanged || actor.incapRemainingMs !== previous.incapRemainingMs) patch.incapRemainingMs = actor.incapRemainingMs;
    if (contextChanged || actor.incapCount !== previous.incapCount) patch.incapCount = actor.incapCount;
    if (contextChanged || actor.incapWindowMs !== previous.incapWindowMs) patch.incapWindowMs = actor.incapWindowMs;
  }
  const includeCombatDetail = detail || includeStatuses || contextChanged;
  if (includeCombatDetail) {
    if (!previous || contextChanged || !sameVitals(actor.vitals, previous.vitals)) patch.vitals = actor.vitals;
    if (!previous || contextChanged || !sameVitals(actor.maxVitals, previous.maxVitals)) patch.maxVitals = actor.maxVitals;
    if (!previous || contextChanged || !sameBleed(actor.bleed, previous.bleed)) patch.bleed = actor.bleed;
  }
  if (includeStatuses) {
    if (!previous || !sameStatusSnapshots(actor.statuses, previous.statuses)) patch.statuses = actor.statuses;
  } else if (previous && contextChanged && !sameStatusSnapshots(actor.statuses, previous.statuses)) {
    patch.statuses = actor.statuses;
  }
  if (!previous || !sameProfessionSnapshots(actor.professions, previous.professions)) {
    patch.professions = actor.professions?.map((profession) => ({ ...profession }));
  }
  if (!previous || !sameActorPersonalShield(actor.personalShield, previous.personalShield)) {
    patch.personalShield = normalizeActorPersonalShield(actor.personalShield);
  }
  if (!previous || !sameActorWeapon(actor.weapon, previous.weapon)) {
    patch.weapon = normalizeActorWeapon(actor.weapon);
  }
  if (!previous || !sameProfessionTitle(actor.activeTitle, previous.activeTitle)) {
    patch.activeTitle = normalizeActorProfessionTitle(actor.activeTitle);
  }
  if (!previous || actor.skillPointsUsed !== previous.skillPointsUsed) patch.skillPointsUsed = actor.skillPointsUsed;
  if (!previous || actor.skillPointsCap !== previous.skillPointsCap) patch.skillPointsCap = actor.skillPointsCap;
  if (!previous || actor.shotSpreadDegreesMilli !== previous.shotSpreadDegreesMilli) patch.shotSpreadDegreesMilli = actor.shotSpreadDegreesMilli;
  if (!previous || actor.credits !== previous.credits) patch.credits = actor.credits;
  if (!previous || !sameActorCombatQueue(actor.combatQueue, previous.combatQueue)) {
    patch.combatQueue = cloneActorCombatQueue(actor.combatQueue) ?? null;
  }
  if (!previous || actor.inCombat !== previous.inCombat) patch.inCombat = actor.inCombat === true;
  if (!previous || actor.peaceRequested !== previous.peaceRequested) patch.peaceRequested = actor.peaceRequested === true;
  if (!previous || actor.aiAttitude !== previous.aiAttitude) patch.aiAttitude = actor.aiAttitude ?? null;
  if (!previous || actor.willAutoAggro !== previous.willAutoAggro) patch.willAutoAggro = actor.willAutoAggro;
  if (!previous || actor.cloneSicknessRemainingMs !== previous.cloneSicknessRemainingMs) patch.cloneSicknessRemainingMs = actor.cloneSicknessRemainingMs;
  return patch;
}

function hasActorPatchFields(patch: GameActorPatch): boolean {
  return Object.keys(patch).length > 1;
}

function actorSnapshotFromPatch(previous: GameActorSnapshot, patch: GameActorPatch): GameActorSnapshot {
  return {
    id: patch.id,
    label: patch.label ?? previous.label,
    display_name: patch.display_name ?? previous.display_name,
    descriptor: patch.descriptor ?? previous.descriptor,
    link_dead: patch.link_dead ?? previous.link_dead,
    appearance: patch.appearance ?? cloneActorAppearance(previous.appearance),
    ...((patch.worn ?? previous.worn) ? { worn: cloneActorWorn(patch.worn ?? previous.worn ?? []) } : {}),
    sprite: patch.sprite === undefined ? previous.sprite : patch.sprite,
    role: patch.role === undefined ? previous.role : patch.role,
    areaId: patch.areaId ?? previous.areaId,
    x: patch.x ?? previous.x,
    y: patch.y ?? previous.y,
    direction: patch.direction ?? previous.direction,
    posture: patch.posture ?? previous.posture ?? "standing",
    postureUntilTick: patch.postureUntilTick ?? previous.postureUntilTick ?? 0,
    lifeState: patch.lifeState ?? previous.lifeState,
    lifecycleSeq: patch.lifecycleSeq ?? previous.lifecycleSeq,
    vitals: patch.vitals ?? previous.vitals,
    maxVitals: patch.maxVitals ?? previous.maxVitals,
    bleed: patch.bleed ?? previous.bleed,
    statuses: patch.statuses ?? previous.statuses,
    personalShield: patch.personalShield === undefined
      ? normalizeActorPersonalShield(previous.personalShield)
      : normalizeActorPersonalShield(patch.personalShield),
    weapon: patch.weapon === undefined
      ? normalizeActorWeapon(previous.weapon)
      : normalizeActorWeapon(patch.weapon),
    mobility: patch.mobility === undefined
      ? (previous.mobility ? { ...previous.mobility } : undefined)
      : { ...patch.mobility },
    bodyVanishAtTick: patch.bodyVanishAtTick ?? previous.bodyVanishAtTick,
    bodyVanishTick: patch.bodyVanishTick ?? patch.bodyVanishAtTick ?? previous.bodyVanishTick ?? previous.bodyVanishAtTick,
    lootable: patch.lootable === undefined ? previous.lootable : patch.lootable ?? false,
    hasLoot: patch.hasLoot === undefined ? previous.hasLoot : patch.hasLoot ?? false,
    lootRightsActorId: patch.lootRightsActorId === undefined ? previous.lootRightsActorId : patch.lootRightsActorId,
    respawnAtTick: patch.respawnAtTick ?? previous.respawnAtTick,
    nextSampleTick: patch.nextSampleTick ?? previous.nextSampleTick,
    cloneSicknessRemainingMs: patch.cloneSicknessRemainingMs ?? previous.cloneSicknessRemainingMs ?? 0,
    incapRemainingMs: patch.incapRemainingMs ?? previous.incapRemainingMs ?? 0,
    incapCount: patch.incapCount ?? previous.incapCount ?? 0,
    incapWindowMs: patch.incapWindowMs ?? previous.incapWindowMs ?? 0,
    stats: previous.stats ? cloneActorStats(previous.stats) : undefined,
    playerOrganizationId: patch.playerOrganizationId === undefined ? previous.playerOrganizationId : patch.playerOrganizationId,
    playerOrganizationTag: patch.playerOrganizationTag === undefined ? previous.playerOrganizationTag : patch.playerOrganizationTag,
    professions: patch.professions ?? previous.professions,
    activeTitle: patch.activeTitle ?? previous.activeTitle,
    skillPointsUsed: patch.skillPointsUsed ?? previous.skillPointsUsed,
    skillPointsCap: patch.skillPointsCap ?? previous.skillPointsCap,
    shotSpreadDegreesMilli: patch.shotSpreadDegreesMilli ?? previous.shotSpreadDegreesMilli,
    credits: patch.credits ?? previous.credits,
    combatQueue: patch.combatQueue === undefined
      ? cloneActorCombatQueue(previous.combatQueue)
      : cloneActorCombatQueue(patch.combatQueue),
    inCombat: patch.inCombat === undefined ? previous.inCombat : patch.inCombat,
    peaceRequested: patch.peaceRequested === undefined ? previous.peaceRequested : patch.peaceRequested,
    factionId: previous.factionId,
    socialGroup: previous.socialGroup,
    pvpStatus: previous.pvpStatus,
    aiAttitude: patch.aiAttitude === undefined ? previous.aiAttitude : patch.aiAttitude ?? undefined,
    willAutoAggro: patch.willAutoAggro === undefined ? previous.willAutoAggro : patch.willAutoAggro,
  };
}

function sameVitals(left: GameActorVitals, right: GameActorVitals): boolean {
  return left.health === right.health && left.action === right.action && left.spirit === right.spirit;
}

function sameBleed(left: GameActorBleed, right: GameActorBleed): boolean {
  return left.active === right.active
    && left.stackCount === right.stackCount
    && left.severity === right.severity
    && left.remainingMs === right.remainingMs
    && sameVitals(left.ratesPerSecond, right.ratesPerSecond);
}

function normalizeCombatActionId(actionId: unknown): GameActorCombatQueueSnapshot["entries"][number]["actionId"] {
  return actionId === "aimed_shot" ? "aimed_shot" : "basic_shot";
}

function cloneActorCombatQueue(
  queue: GameActorCombatQueueSnapshot | null | undefined,
): GameActorCombatQueueSnapshot | undefined {
  if (!queue || !Array.isArray(queue.entries)) return undefined;
  return {
    nextReadyTick: finiteInteger(queue.nextReadyTick, 0),
    entries: queue.entries
      .filter((entry) => entry && typeof entry.targetActorId === "string" && entry.targetActorId.length > 0)
      .map((entry) => ({
        actionId: normalizeCombatActionId(entry.actionId),
        targetActorId: entry.targetActorId,
        ...(entry.auto === true ? { auto: true } : {}),
      })),
  };
}

function sameActorCombatQueue(
  left: GameActorCombatQueueSnapshot | null | undefined,
  right: GameActorCombatQueueSnapshot | null | undefined,
): boolean {
  const leftQueue = cloneActorCombatQueue(left);
  const rightQueue = cloneActorCombatQueue(right);
  if (!leftQueue || !rightQueue) return leftQueue === rightQueue;
  return leftQueue.nextReadyTick === rightQueue.nextReadyTick
    && leftQueue.entries.length === rightQueue.entries.length
    && leftQueue.entries.every((entry, index) => {
      const other = rightQueue.entries[index];
      return other !== undefined
        && entry.actionId === other.actionId
        && entry.targetActorId === other.targetActorId
        && (entry.auto === true) === (other.auto === true);
    });
}

function cloneAbilityQueueEntry(
  entry: AbilityQueueView["entries"][number],
): AbilityQueueView["entries"][number] {
  return {
    id: String(entry.id),
    abilityId: String(entry.abilityId),
    iconId: String(entry.iconId),
    class: entry.class,
    ...(entry.targetActorId ? { targetActorId: entry.targetActorId } : {}),
    lifecycle: entry.lifecycle,
    enqueuedAtTick: finiteInteger(entry.enqueuedAtTick, 0),
    ...(typeof entry.readyTick === "number" ? { readyTick: finiteInteger(entry.readyTick, 0) } : {}),
    ...(typeof entry.firedAtTick === "number" ? { firedAtTick: finiteInteger(entry.firedAtTick, 0) } : {}),
    ...(typeof entry.dismissedAtTick === "number" ? { dismissedAtTick: finiteInteger(entry.dismissedAtTick, 0) } : {}),
    ...(entry.reasonCode ? { reasonCode: entry.reasonCode } : {}),
    ...(typeof entry.fireSeq === "number" ? { fireSeq: finiteInteger(entry.fireSeq, 0) } : {}),
  };
}

function cloneAbilityQueueView(queue: AbilityQueueView | null | undefined): AbilityQueueView | null {
  if (!queue || !Array.isArray(queue.entries)) return null;
  return {
    actorId: String(queue.actorId),
    nextReadyTick: finiteInteger(queue.nextReadyTick, 0),
    entries: queue.entries.map(cloneAbilityQueueEntry),
    repeatIntent: queue.repeatIntent ? cloneAbilityQueueEntry(queue.repeatIntent) : undefined,
  };
}

function sameAbilityQueueView(
  left: AbilityQueueView | null | undefined,
  right: AbilityQueueView | null | undefined,
): boolean {
  return JSON.stringify(cloneAbilityQueueView(left)) === JSON.stringify(cloneAbilityQueueView(right));
}

function sameProfessionSnapshots(
  left: GameActorSnapshot["professions"] | undefined,
  right: GameActorSnapshot["professions"] | undefined,
): boolean {
  const leftList = left ?? [];
  const rightList = right ?? [];
  return leftList.length === rightList.length && leftList.every((profession, index) => {
    const other = rightList[index];
    return other !== undefined
      && profession.id === other.id
      && profession.label === other.label
      && profession.xp === other.xp
      && profession.skillPoints === other.skillPoints
      && sameNumberRecords(profession.trackXp, other.trackXp)
      && sameStringLists(profession.skillBoxes, other.skillBoxes);
  });
}

function cloneProfessionSnapshots(
  professions: GameActorSnapshot["professions"] | undefined,
): GameActorSnapshot["professions"] {
  return professions?.map((profession) => ({
    ...profession,
    trackXp: profession.trackXp ? { ...profession.trackXp } : undefined,
    skillBoxes: profession.skillBoxes?.slice(),
  }));
}

function professionXpSeed(
  professions: GameActorSnapshot["professions"] | undefined,
): Record<string, number> | undefined {
  if (!professions) return undefined;
  const entries = professions
    .filter((profession) => profession.id.length > 0)
    .map((profession) => [profession.id, Math.max(0, Math.trunc(profession.xp))] as const);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function professionTrackXpSeed(
  professions: GameActorSnapshot["professions"] | undefined,
): Record<string, number> | undefined {
  if (!professions) return undefined;
  const entries = professions.flatMap((profession) => Object.entries(profession.trackXp ?? {})
    .filter(([track]) => profession.id.length > 0 && track.trim().length > 0)
    .map(([track, xp]) => [
      `${profession.id}:${track.trim()}`,
      Math.max(0, Math.trunc(xp)),
    ] as const));
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function sameNumberRecords(
  left: Record<string, number> | undefined,
  right: Record<string, number> | undefined,
): boolean {
  const leftEntries = Object.entries(left ?? {}).sort(([a], [b]) => a.localeCompare(b));
  const rightEntries = Object.entries(right ?? {}).sort(([a], [b]) => a.localeCompare(b));
  if (leftEntries.length !== rightEntries.length) return false;
  return leftEntries.every(([key, value], index) => {
    const [rightKey, rightValue] = rightEntries[index] ?? ["", NaN];
    return key === rightKey && value === rightValue;
  });
}

function copyResourceSpawn(spawn: GameResourceSpawn): GameResourceSpawn {
  return {
    ...spawn,
    stats: { ...spawn.stats },
    activeUntilTick: spawn.activeUntilTick ?? null,
  };
}

function sameStringLists(left: string[] | undefined, right: string[] | undefined): boolean {
  const leftList = left ?? [];
  const rightList = right ?? [];
  return leftList.length === rightList.length && leftList.every((value, index) => value === rightList[index]);
}


function sameStatusSnapshots(left: GameActorStatusSnapshot[], right: GameActorStatusSnapshot[]): boolean {
  return left.length === right.length && left.every((status, index) => {
    const other = right[index];
    return other !== undefined
      && status.id === other.id
      && status.label === other.label
      && status.severity === other.severity
      && status.remainingMs === other.remainingMs
      && status.stacks === other.stacks
      && status.threshold === other.threshold;
  });
}

function sameStatusShapes(left: GameActorStatusSnapshot[], right: GameActorStatusSnapshot[]): boolean {
  return left.length === right.length && left.every((status, index) => {
    const other = right[index];
    return other !== undefined
      && status.id === other.id
      && status.label === other.label
      && status.severity === other.severity
      && status.stacks === other.stacks
      && status.threshold === other.threshold;
  });
}

function compactReceipt(receipt: GameCommandReceipt): GameCompactReceipt {
  return receipt.reasonCode
    ? [receipt.commandId, receipt.accepted ? 1 : 0, receipt.tick, receipt.reasonCode]
    : [receipt.commandId, receipt.accepted ? 1 : 0, receipt.tick];
}

function playerPositionAck(actor: GameActorSnapshot): GamePlayerPositionAck {
  return [actor.x, actor.y];
}

function shouldSendPlayerActorMoveAck(
  move: Extract<ClientCommand, { Move: unknown }>["Move"],
  previous: GameActorSnapshot | undefined,
  current: GameActorSnapshot,
): boolean {
  if (move.sprint === true || !previous) return true;
  return current.areaId !== previous.areaId
    || current.direction !== previous.direction
    || current.lifeState !== previous.lifeState
    || current.lifecycleSeq !== previous.lifecycleSeq
    || current.display_name !== previous.display_name
    || current.link_dead !== previous.link_dead
    || !sameActorAppearance(current.appearance, previous.appearance)
    || !sameVitals(current.vitals, previous.vitals)
    || !sameVitals(current.maxVitals, previous.maxVitals)
    || !sameBleed(current.bleed, previous.bleed)
    || !sameActorPersonalShield(current.personalShield, previous.personalShield)
    || !sameActorWeapon(current.weapon, previous.weapon)
    || !sameStatusSnapshots(current.statuses, previous.statuses);
}

function compactServerPacket(packet: GameServerPacket): GameServerPacket {
  const deltaCompacted = packet.type === "game.delta"
    ? { ...packet, delta: compactDelta(packet.delta) } as GameServerPacket
    : packet;
  const events = "events" in deltaCompacted ? deltaCompacted.events ?? [] : [];
  if (events.length === 0) return deltaCompacted;
  return {
    ...deltaCompacted,
    events: [],
    compactEvents: events.map(compactCombatEvent),
  } as GameServerPacket;
}

function compactDelta(delta: GameShardDelta): GameShardDelta {
  const compactActors = Object.values(delta.actors).map(compactActorSnapshot);
  const compactActorPatches = Object.values(delta.actorPatches ?? {}).map(compactActorPatch);
  return {
    ...delta,
    actors: {},
    actorPatches: undefined,
    compactActors: compactActors.length > 0 ? compactActors : undefined,
    compactActorPatches: compactActorPatches.length > 0 ? compactActorPatches : undefined,
    counters: undefined,
  };
}

function compactActorSnapshot(actor: GameActorSnapshot): GameCompactActorSnapshot {
  return [
    actor.id,
    actor.label,
    actor.areaId,
    actor.x,
    actor.y,
    compactDirection(actor.direction),
    compactLifeState(actor.lifeState),
    actor.lifecycleSeq,
    compactVitals(actor.vitals),
    compactVitals(actor.maxVitals),
    compactBleed(actor.bleed),
    actor.statuses,
    actor.factionId ?? null,
    actor.socialGroup ?? null,
    actor.pvpStatus ?? "none",
    actor.bodyVanishAtTick ?? 0,
    actor.respawnAtTick ?? 0,
    actor.professions ?? [],
    normalizeActorProfessionTitle(actor.activeTitle),
    actor.skillPointsUsed ?? 0,
    actor.skillPointsCap ?? 0,
    actor.credits ?? 0,
    normalizeActorPersonalShield(actor.personalShield),
    actor.sprite ?? null,
    actor.role ?? null,
    actor.playerOrganizationId ?? null,
    actor.playerOrganizationTag ?? null,
    normalizeActorWeapon(actor.weapon),
    actor.shotSpreadDegreesMilli ?? 0,
    actor.posture,
    actor.postureUntilTick,
    cloneActorCombatQueue(actor.combatQueue) ?? null,
    actor.inCombat ? 1 : 0,
    actor.cloneSicknessRemainingMs ?? 0,
    actor.peaceRequested ? 1 : 0,
    actor.aiAttitude ?? null,
    actor.engagementTargetId ?? null,
    actor.lootable ? 1 : 0,
    actor.hasLoot ? 1 : 0,
    actor.lootRightsActorId ?? null,
    actor.bodyVanishTick ?? actor.bodyVanishAtTick ?? 0,
    actor.incapRemainingMs ?? 0,
    actor.incapCount ?? 0,
    actor.incapWindowMs ?? 0,
    actor.display_name,
    actor.link_dead ? 1 : 0,
    cloneActorAppearance(actor.appearance),
    actor.nextSampleTick ?? 0,
    actor.worn && actor.worn.length > 0 ? cloneActorWorn(actor.worn) : undefined,
    actor.willAutoAggro ? 1 : 0,
    actor.descriptor ?? "",
    actor.mobility?.sprintRecoveryLocked ? 1 : 0,
  ];
}

function compactActorPatch(patch: GameActorPatch): GameCompactActorPatch {
  return [
    patch.id,
    patch.areaId ?? null,
    patch.x ?? null,
    patch.y ?? null,
    patch.direction ? compactDirection(patch.direction) : null,
    patch.lifeState ? compactLifeState(patch.lifeState) : null,
    patch.lifecycleSeq ?? null,
    patch.vitals ? compactVitals(patch.vitals) : null,
    patch.maxVitals ? compactVitals(patch.maxVitals) : null,
    patch.bleed ? compactBleed(patch.bleed) : null,
    patch.statuses ?? null,
    patch.bodyVanishAtTick ?? null,
    patch.respawnAtTick ?? null,
    patch.professions ?? null,
    patch.activeTitle === undefined ? null : normalizeActorProfessionTitle(patch.activeTitle),
    patch.skillPointsUsed ?? null,
    patch.skillPointsCap ?? null,
    patch.credits ?? null,
    patch.personalShield === undefined ? false : normalizeActorPersonalShield(patch.personalShield),
    patch.label ?? null,
    patch.sprite ?? null,
    patch.role ?? null,
    patch.playerOrganizationId === undefined ? false : patch.playerOrganizationId,
    patch.playerOrganizationTag === undefined ? false : patch.playerOrganizationTag,
    patch.weapon === undefined ? false : normalizeActorWeapon(patch.weapon),
    patch.factionId === undefined ? false : patch.factionId,
    patch.socialGroup === undefined ? false : patch.socialGroup,
    patch.pvpStatus === undefined ? false : patch.pvpStatus,
    patch.shotSpreadDegreesMilli ?? null,
    patch.posture ?? null,
    patch.postureUntilTick ?? null,
    patch.combatQueue === undefined ? false : cloneActorCombatQueue(patch.combatQueue) ?? null,
    patch.inCombat === undefined ? null : patch.inCombat ? 1 : 0,
    patch.cloneSicknessRemainingMs ?? null,
    patch.peaceRequested === undefined ? null : patch.peaceRequested ? 1 : 0,
    patch.aiAttitude === undefined ? null : patch.aiAttitude ?? null,
    patch.engagementTargetId === undefined ? false : patch.engagementTargetId,
    patch.lootable === undefined ? null : patch.lootable ? 1 : 0,
    patch.hasLoot === undefined ? null : patch.hasLoot ? 1 : 0,
    patch.lootRightsActorId === undefined ? false : patch.lootRightsActorId,
    patch.bodyVanishTick ?? null,
    patch.incapRemainingMs ?? null,
    patch.incapCount ?? null,
    patch.incapWindowMs ?? null,
    patch.display_name ?? null,
    patch.link_dead === undefined ? null : patch.link_dead ? 1 : 0,
    patch.appearance ?? null,
    patch.nextSampleTick ?? null,
    patch.worn ?? null,
    patch.willAutoAggro === undefined ? null : patch.willAutoAggro ? 1 : 0,
    patch.descriptor ?? null,
    patch.mobility === undefined ? null : patch.mobility.sprintRecoveryLocked ? 1 : 0,
  ];
}

function canSendAsCompactMove(patch: GameActorPatch, detail: boolean): boolean {
  return !detail
    && patch.label === undefined
    && patch.descriptor === undefined
    && patch.display_name === undefined
    && patch.link_dead === undefined
    && patch.appearance === undefined
    && patch.worn === undefined
    && patch.mobility === undefined
    && patch.sprite === undefined
    && patch.areaId === undefined
    && patch.lifeState === undefined
    && patch.lifecycleSeq === undefined
    && patch.vitals === undefined
    && patch.maxVitals === undefined
    && patch.bleed === undefined
    && patch.statuses === undefined
    && patch.bodyVanishAtTick === undefined
    && patch.respawnAtTick === undefined
    && patch.nextSampleTick === undefined
    && patch.cloneSicknessRemainingMs === undefined
    && patch.professions === undefined
    && patch.activeTitle === undefined
    && patch.skillPointsUsed === undefined
    && patch.skillPointsCap === undefined
    && patch.shotSpreadDegreesMilli === undefined
    && patch.credits === undefined
    && patch.personalShield === undefined
    && patch.weapon === undefined
    && patch.role === undefined
    && patch.playerOrganizationId === undefined
    && patch.playerOrganizationTag === undefined
    && patch.factionId === undefined
    && patch.socialGroup === undefined
    && patch.pvpStatus === undefined
    && patch.posture === undefined
    && patch.postureUntilTick === undefined
    && patch.combatQueue === undefined
    && patch.inCombat === undefined
    && patch.peaceRequested === undefined
    && patch.engagementTargetId === undefined
    && patch.lootable === undefined
    && patch.hasLoot === undefined
    && patch.lootRightsActorId === undefined
    && patch.bodyVanishTick === undefined
    && patch.incapRemainingMs === undefined
    && patch.incapCount === undefined
    && patch.incapWindowMs === undefined
    && patch.aiAttitude === undefined
    && patch.willAutoAggro === undefined
    && (patch.x !== undefined || patch.y !== undefined || patch.direction !== undefined);
}

function compactActorMove(netId: number, actor: GameActorSnapshot): GameCompactActorMove {
  return [
    netId,
    Math.round(actor.x * actorMovementQuantization),
    Math.round(actor.y * actorMovementQuantization),
    compactDirection(actor.direction),
  ];
}

function compactVitals(vitals: GameActorVitals): GameCompactVitals {
  return [vitals.health, vitals.action, vitals.spirit];
}

function compactBleed(bleed: GameActorBleed): GameCompactBleed {
  return [
    bleed.active ? 1 : 0,
    bleed.stackCount,
    bleed.severity,
    bleed.remainingMs,
    bleed.ratesPerSecond.health,
    bleed.ratesPerSecond.action,
    bleed.ratesPerSecond.spirit,
  ];
}

function compactDirection(direction: GameActorSnapshot["direction"]): GameCompactDirection {
  if (direction === "right") return 1;
  if (direction === "back") return 2;
  if (direction === "left") return 3;
  return 0;
}

function compactLifeState(lifeState: GameActorLifeState): GameCompactLifeState {
  if (lifeState === "downed") return 1;
  if (lifeState === "respawning") return 2;
  return 0;
}

function compactCombatEvent(event: GameCombatEvent): GameCompactCombatEvent {
  const meteredEffect = event.effect?.kind === "sleep" || event.effect?.kind === "shield"
    ? event.effect
    : null;
  return [
    event.id,
    event.commandId ?? null,
    event.tick,
    event.shooterActorId,
    event.targetActorId,
    event.hitPoint?.x ?? null,
    event.hitPoint?.y ?? null,
    event.damage,
    event.zone,
    event.previousLifeState,
    event.lifeState,
    event.targetLifecycleSeq,
    event.bleedStackCount,
    event.lifecycle?.kind ?? null,
    event.lifecycle?.from ?? null,
    event.lifecycle?.to ?? null,
    event.lifecycle?.cause ?? null,
    event.weaponId ?? null,
    event.ammoTypeId ?? null,
    event.effect?.kind ?? null,
    meteredEffect?.stacks ?? null,
    meteredEffect?.threshold ?? null,
    meteredEffect?.remainingMs ?? null,
    event.originPoint?.x ?? null,
    event.originPoint?.y ?? null,
    event.kind ?? null,
    event.attackerActorId ?? null,
    event.actionId ?? null,
    event.hit === undefined ? null : event.hit ? 1 : 0,
    event.pool ?? null,
    event.rollMilli ?? null,
    event.toHitMilli ?? null,
  ];
}

function combatEventActorIds(events: GameCombatEvent[]): string[] {
  return events.flatMap((event) => [event.targetActorId, event.shooterActorId, event.attackerActorId ?? event.shooterActorId]);
}

function rustSessionNumber(session: GameSession): number {
  const parsed = Number(session.id.replace(/^g_/u, ""));
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : 1;
}

function normalizeActorPosture(
  value: RustAuthorityActorSnapshot["posture"] | GameActorPosture | null | undefined,
): GameActorPosture {
  if (value === "kneeling_down" || value === "kneeling" || value === "standing_up") return value;
  return "standing";
}

function rustLifeState(value: string): GameActorLifeState {
  if (value === "downed" || value === "Downed") return "downed";
  if (value === "respawning" || value === "Respawning") return "respawning";
  return "alive";
}

function rustLifecycleKind(value: string): GameCombatLifecycleKind {
  if (value === "downed" || value === "Downed") return "downed";
  if (value === "killed" || value === "Killed") return "killed";
  return "hit";
}

function rustCombatZone(value: string | undefined): BodyZone {
  if (value === "head" || value === "left_arm" || value === "right_arm" || value === "legs" || value === "torso") {
    return value;
  }
  return "torso";
}

function rustWeaponId(value: string): AuthorityWeaponId | null {
  switch (value) {
    case "Slugthrower": return "slugthrower";
    case "Vibrosword": return "vibrosword";
    case "ScraplineMachete": return "scrapline-machete";
    case "FieldSaber": return "field-saber";
    case "QuarryChopper": return "quarry-chopper";
    case "Unarmed": return "unarmed";
    case "WpnPistol": return "wpn-pistol";
    case "WpnSmg": return "wpn-smg";
    case "WpnCarbine": return "wpn-carbine";
    case "LightningCarbine": return "lightning-carbine";
    case "WpnAssault": return "wpn-assault";
    case "WpnShotgun": return "wpn-shotgun";
    case "WpnSniper": return "wpn-sniper";
    case "WpnHeavy": return "wpn-heavy";
    case "WpnLauncher": return "wpn-launcher";
    default: return isAuthorityWeaponId(value) ? value : null;
  }
}

function rustAmmoType(value: string): AmmoTypeId {
  if (value === "SlugIron" || value === "slug_iron") return "slug_iron";
  if (value === "SlugShard" || value === "slug_shard") return "slug_shard";
  if (value === "SlugSpike" || value === "slug_spike") return "slug_spike";
  if (value === "Melee" || value === "melee") return "melee";
  return "slug_iron";
}

function rustActiveEffectStatuses(
  activeEffects: RustAuthorityActorSnapshot["activeEffects"] | null | undefined,
  tickRateHz: number,
): AuthorityStatus[] {
  if (!Array.isArray(activeEffects)) return [];
  const hz = Number.isFinite(tickRateHz) && tickRateHz > 0 ? tickRateHz : defaultTickRateHz;
  return activeEffects
    .map((effect) => ({
      id: normalizeStatusId(effect.id),
      label: typeof effect.label === "string" && effect.label.trim() ? effect.label.trim() : effect.id,
      severity: effect.kind === "consumable" ? 0 : 1,
      remainingMs: Math.round((Math.max(0, Number(effect.remainingTicks) || 0) / hz) * 1000),
    }))
    .filter((status) => status.id.length > 0);
}

function normalizeActorProfessions(
  professions: RustAuthorityActorSnapshot["professions"] | null | undefined,
): GameActorSnapshot["professions"] {
  if (!Array.isArray(professions)) return undefined;
  return professions
    .map((profession) => ({
      id: typeof profession.id === "string" ? profession.id : "",
      label: typeof profession.label === "string" && profession.label.trim() ? profession.label.trim() : String(profession.id ?? ""),
      xp: finiteNumber(profession.xp, 0),
      trackXp: normalizeProfessionTrackXp(profession.trackXp),
      skillPoints: finiteInteger(profession.skillPoints, 0),
      skillBoxes: normalizeStringGrants(profession.skillBoxes),
    }))
    .filter((profession) => profession.id.length > 0);
}

function normalizeProfessionTrackXp(trackXp: Record<string, unknown> | null | undefined): Record<string, number> | undefined {
  if (!trackXp || typeof trackXp !== "object") return undefined;
  const entries = Object.entries(trackXp)
    .map(([track, xp]) => [track.trim(), finiteNumber(xp, 0)] as const)
    .filter(([track]) => track.length > 0);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function normalizeActorProfessionTitle(
  title: RustAuthorityActorSnapshot["activeTitle"] | GameActorSnapshot["activeTitle"] | null | undefined,
): GameActorSnapshot["activeTitle"] {
  if (!title || typeof title !== "object") return null;
  const id = typeof title.id === "string" ? title.id.trim() : "";
  const label = typeof title.label === "string" ? title.label.trim() : "";
  const skillBoxId = typeof title.skillBoxId === "string" ? title.skillBoxId.trim() : id;
  if (!id || !label || !skillBoxId) return null;
  return { id, label, skillBoxId };
}

function sameProfessionTitle(
  left: GameActorSnapshot["activeTitle"] | undefined,
  right: GameActorSnapshot["activeTitle"] | undefined,
): boolean {
  const leftTitle = normalizeActorProfessionTitle(left);
  const rightTitle = normalizeActorProfessionTitle(right);
  if (!leftTitle || !rightTitle) return leftTitle === rightTitle;
  return leftTitle.id === rightTitle.id
    && leftTitle.label === rightTitle.label
    && leftTitle.skillBoxId === rightTitle.skillBoxId;
}

function normalizeActorPersonalShield(
  shield: RustAuthorityActorSnapshot["personalShield"] | GameActorSnapshot["personalShield"] | null | undefined,
): GameActorSnapshot["personalShield"] {
  if (!shield || typeof shield !== "object") return null;
  const maxChargeMilli = Math.max(1, finiteInteger(shield.maxChargeMilli, 1));
  const durabilityCharges = finiteInteger(shield.durabilityCharges, 0);
  const maxDurabilityCharges = Math.max(1, finiteInteger(shield.maxDurabilityCharges, 1));
  const maxDurabilityMilli = Math.max(
    maxChargeMilli,
    finiteInteger(shield.maxDurabilityMilli, maxChargeMilli * maxDurabilityCharges),
  );
  return {
    chargeMilli: finiteInteger(shield.chargeMilli, 0),
    maxChargeMilli,
    durabilityMilli: Math.max(0, finiteInteger(shield.durabilityMilli, durabilityCharges * maxChargeMilli)),
    maxDurabilityMilli,
    durabilityCharges,
    maxDurabilityCharges,
    rechargeAvailableTick: finiteInteger(shield.rechargeAvailableTick, 0),
    rechargeBlocked: shield.rechargeBlocked === true,
    lastDamageTick: nullableFiniteNumber(shield.lastDamageTick),
    lastBlockTick: nullableFiniteNumber(shield.lastBlockTick),
  };
}

function sameActorPersonalShield(
  left: GameActorSnapshot["personalShield"] | undefined,
  right: GameActorSnapshot["personalShield"] | undefined,
): boolean {
  const leftShield = normalizeActorPersonalShield(left);
  const rightShield = normalizeActorPersonalShield(right);
  if (!leftShield || !rightShield) return leftShield === rightShield;
  return leftShield.chargeMilli === rightShield.chargeMilli
    && leftShield.maxChargeMilli === rightShield.maxChargeMilli
    && leftShield.durabilityMilli === rightShield.durabilityMilli
    && leftShield.maxDurabilityMilli === rightShield.maxDurabilityMilli
    && leftShield.durabilityCharges === rightShield.durabilityCharges
    && leftShield.maxDurabilityCharges === rightShield.maxDurabilityCharges
    && leftShield.rechargeAvailableTick === rightShield.rechargeAvailableTick
    && leftShield.rechargeBlocked === rightShield.rechargeBlocked
    && leftShield.lastDamageTick === rightShield.lastDamageTick
    && leftShield.lastBlockTick === rightShield.lastBlockTick;
}

function normalizeActorWeapon(
  weapon: RustAuthorityActorSnapshot["weapon"] | GameActorSnapshot["weapon"] | null | undefined | false,
): GameActorSnapshot["weapon"] {
  if (!weapon || typeof weapon !== "object") return null;
  if (!isAuthorityWeaponId(weapon.weaponId)) return null;
  const weaponId = weapon.weaponId;
  const profile = authorityWeaponProfile(weaponId);
  return {
    weaponId,
    weaponItemId: Math.max(0, finiteInteger(weapon.weaponItemId, 0)),
    weaponVariantId: Math.max(0, finiteInteger(weapon.weaponVariantId, 0)),
    ammoType: normalizeAuthorityWeaponAmmoType(profile, weapon.ammoType),
    loadedRounds: finiteInteger(weapon.loadedRounds, 0),
    magazineSize: Math.max(1, finiteInteger(weapon.magazineSize, 1)),
    reloadUntilTick: finiteInteger(weapon.reloadUntilTick, 0),
    reloadRemainingTicks: finiteInteger(weapon.reloadRemainingTicks, 0),
    reloadTotalTicks: Math.max(1, finiteInteger(weapon.reloadTotalTicks, 1)),
  };
}

function sameActorWeapon(
  left: GameActorSnapshot["weapon"] | undefined,
  right: GameActorSnapshot["weapon"] | undefined,
): boolean {
  const leftWeapon = normalizeActorWeapon(left);
  const rightWeapon = normalizeActorWeapon(right);
  if (!leftWeapon || !rightWeapon) return leftWeapon === rightWeapon;
  return leftWeapon.weaponId === rightWeapon.weaponId
    && leftWeapon.weaponItemId === rightWeapon.weaponItemId
    && leftWeapon.weaponVariantId === rightWeapon.weaponVariantId
    && leftWeapon.ammoType === rightWeapon.ammoType
    && leftWeapon.loadedRounds === rightWeapon.loadedRounds
    && leftWeapon.magazineSize === rightWeapon.magazineSize
    && leftWeapon.reloadUntilTick === rightWeapon.reloadUntilTick
    && leftWeapon.reloadRemainingTicks === rightWeapon.reloadRemainingTicks
    && leftWeapon.reloadTotalTicks === rightWeapon.reloadTotalTicks;
}

function authorityWeaponIdForInventoryItemId(itemId: number | undefined): AuthorityWeaponId | null {
  switch (Math.trunc(itemId ?? 0)) {
    case 3101:
      return "slugthrower";
    case 3103:
    case 3104:
      return "vibrosword";
    case 3105:
      return "scrapline-machete";
    case 3106:
      return "field-saber";
    case 3107:
      return "quarry-chopper";
    case 3111:
      return "wpn-smg";
    case 3112:
      return "wpn-carbine";
    case 3121:
      return "lightning-carbine";
    default:
      return null;
  }
}

function authorityActorWeaponSnapshot(weaponId: AuthorityWeaponId, weaponItemId = 0, weaponVariantId = 0): GameActorWeaponSnapshot {
  const weapon = authorityWeaponProfile(weaponId);
  const magazineSize = authorityWeaponMagazineSize(weaponId);
  return {
    weaponId: weapon.id,
    ...(weaponItemId > 0 ? { weaponItemId } : {}),
    weaponVariantId: Math.max(0, Math.trunc(weaponVariantId)),
    ammoType: weapon.defaultAmmoType,
    loadedRounds: magazineSize,
    magazineSize,
    reloadUntilTick: 0,
    reloadRemainingTicks: 0,
    reloadTotalTicks: 1,
  };
}

function inventoryItemNameForId(itemId: number): string | null {
  switch (Math.trunc(itemId)) {
    case 1001:
      return "Stimpak A";
    case 1002:
      return "Field Bandage";
    case 1003:
      return "Resuscitation Kit";
    case 1004:
      return "Personal Shield Generator";
    case 1005:
      return "Body Enhancement Pack A";
    case 1006:
      return "Spirit Enhancement Pack A";
    case 1101:
      return "Iron Slug";
    case 1102:
      return "Shard Slug";
    case 1103:
      return "Spike Slug";
    case 2001:
      return "Iron";
    case 2002:
      return "Petrochemical";
    case 2003:
      return "Flora";
    case 2004:
      return "Gas";
    case 2005:
      return "Liquid";
    case 2006:
      return "Clodpowder";
    case 2007:
      return "Copper";
    case 2008:
      return "Carbon";
    case 2009:
      return "Fuel";
    case 2010:
      return "Polymer";
    case 2101:
      return "Creature Hide";
    case 2102:
      return "Creature Meat";
    case 2103:
      return "Clodbone";
    case 2104:
      return "Creature Tissue";
    case 3001:
      return "Field Multitool";
    case 3004:
      return "Scout Processing Kit";
    case 3006:
      return "Personal Mineral Sampler";
    case 3008:
      return "Mineral Survey Tool";
    case 3009:
      return "Chemical Survey Device";
    case 3010:
      return "Gas Survey Tool";
    case 3011:
      return "Water Survey Tool";
    case 3012:
      return "Personal Chemical Extractor";
    case 3013:
      return "Personal Gas Harvester";
    case 3014:
      return "Survival Moisture Vaporator";
    case 3101:
      return "Slugthrower";
    case 3103:
      return "Vibrosword";
    case 3104:
      return "Plasma Sword";
    case 3105:
      return "Scrapline Machete";
    case 3106:
      return "Field Saber";
    case 3107:
      return "Quarry Chopper";
    case 3111:
      return "STEN Mk II";
    case 3112:
      return "Kiln Energy Cell Carbine";
    case 3121:
      return "Lightning Carbine";
    case 7103:
      return "Combat Helm";
    case 4001:
      return "Clod Contract";
    case 5001:
      return "Travel Ticket";
    default:
      return null;
  }
}

function skillBoxIdsFromProfessionSnapshots(
  professions: GameActorSnapshot["professions"],
): string[] | undefined {
  const skillBoxIds = normalizeStringGrants(
    (professions ?? []).flatMap((profession) => profession.skillBoxes ?? []),
  );
  return skillBoxIds;
}

function finiteInteger(value: unknown, fallback: number): number {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? Math.trunc(numberValue) : fallback;
}

function emptyGameGroupView(): GameGroupView {
  return { members: [] };
}

function cloneGameGroupView(view: GameGroupView | null | undefined): GameGroupView {
  if (!view) return emptyGameGroupView();
  return {
    ...(view.group ? {
      group: {
        ...view.group,
        memberActorIds: view.group.memberActorIds.slice(),
      },
    } : {}),
    members: (view.members ?? []).map((member) => ({
      ...member,
      vitals: { ...member.vitals },
      maxVitals: { ...member.maxVitals },
    })),
    ...(view.pendingInvite ? { pendingInvite: { ...view.pendingInvite } } : {}),
  };
}

function compareGroupMemberActorIds(left: string, right: string, leaderActorId: string | null): number {
  if (left === right) return 0;
  if (leaderActorId) {
    if (left === leaderActorId) return -1;
    if (right === leaderActorId) return 1;
  }
  return left < right ? -1 : 1;
}

function sameGroupViewMap(left: Map<string, GameGroupView>, right: Map<string, GameGroupView>): boolean {
  if (left.size !== right.size) return false;
  for (const [actorId, leftView] of left) {
    const rightView = right.get(actorId);
    if (!rightView || JSON.stringify(leftView) !== JSON.stringify(rightView)) return false;
  }
  return true;
}

function cloneGameGuildView(view: GameGuildView | null | undefined): GameGuildView {
  if (!view) return { roster: [], pendingInvites: [], directory: [] };
  return {
    ...(view.guild ? { guild: { ...view.guild, wars: view.guild.wars.map((war) => ({ ...war })) } } : {}),
    roster: (view.roster ?? []).map((member) => ({ ...member, permissions: member.permissions.slice() })),
    pendingInvites: (view.pendingInvites ?? []).map((invite) => ({ ...invite })),
    directory: (view.directory ?? []).map((entry) => ({ ...entry })),
  };
}

function sameGuildViewMap(left: Map<string, GameGuildView>, right: Map<string, GameGuildView>): boolean {
  if (left.size !== right.size) return false;
  for (const [actorId, leftView] of left) {
    const rightView = right.get(actorId);
    if (!rightView || JSON.stringify(leftView) !== JSON.stringify(rightView)) return false;
  }
  return true;
}

function emptyGameDuelView(): GameDuelView {
  return {};
}

function cloneGameDuelView(view: GameDuelView | null | undefined): GameDuelView {
  if (!view) return emptyGameDuelView();
  return {
    ...(view.activeDuel ? { activeDuel: { ...view.activeDuel } } : {}),
    ...(view.incomingChallenge ? { incomingChallenge: { ...view.incomingChallenge } } : {}),
    ...(view.outgoingChallenge ? { outgoingChallenge: { ...view.outgoingChallenge } } : {}),
  };
}

function sameDuelViewMap(left: Map<string, GameDuelView>, right: Map<string, GameDuelView>): boolean {
  if (left.size !== right.size) return false;
  for (const [actorId, leftView] of left) {
    const rightView = right.get(actorId);
    if (!rightView || JSON.stringify(leftView) !== JSON.stringify(rightView)) return false;
  }
  return true;
}

function normalizeActorMobility(
  mobility: RustAuthorityActorSnapshot["mobility"] | null | undefined,
): GameActorSnapshot["mobility"] | undefined {
  if (!mobility) return undefined;
  return {
    sprintActionDrainMilli: finiteNumber(mobility.sprintActionDrainMilli, 0),
    sprintRecoveryLocked: mobility.sprintRecoveryLocked === true,
    sprintRegenBlockUntilTick: finiteNumber(mobility.sprintRegenBlockUntilTick, 0),
    sprintRegenBlocked: mobility.sprintRegenBlocked === true,
    sprintMoves: finiteNumber(mobility.sprintMoves, 0),
    sprintTicks: finiteNumber(mobility.sprintTicks, 0),
    sprintActionSpentMilli: finiteNumber(mobility.sprintActionSpentMilli, 0),
    sprintDistanceCells: round(finiteNumber(mobility.sprintDistanceCells, 0)),
    tacticalSprintMoves: finiteNumber(mobility.tacticalSprintMoves, 0),
    tacticalSprintTicks: finiteNumber(mobility.tacticalSprintTicks, 0),
    tacticalSprintActionSpentMilli: finiteNumber(mobility.tacticalSprintActionSpentMilli, 0),
    tacticalSprintDistanceCells: round(finiteNumber(mobility.tacticalSprintDistanceCells, 0)),
    lastSprintTick: nullableFiniteNumber(mobility.lastSprintTick),
    lastSprintReason: typeof mobility.lastSprintReason === "string" ? mobility.lastSprintReason : null,
  };
}

function normalizeActorStats(
  stats: RustAuthorityActorSnapshot["stats"] | null | undefined,
): GameActorSnapshot["stats"] | undefined {
  if (!stats) return undefined;
  const recent = (row: RustAuthorityActorStatsSnapshot["recent10s"] | undefined) => ({
    windowSeconds: finiteNumber(row?.windowSeconds, 0),
    damageDone: finiteNumber(row?.damageDone, 0),
    damageTaken: finiteNumber(row?.damageTaken, 0),
    kills: finiteNumber(row?.kills, 0),
    npcKills: finiteNumber(row?.npcKills, 0),
    playerKills: finiteNumber(row?.playerKills, 0),
    deaths: finiteNumber(row?.deaths, 0),
    shotsFired: finiteNumber(row?.shotsFired, 0),
    hitsDealt: finiteNumber(row?.hitsDealt, 0),
    hitsTaken: finiteNumber(row?.hitsTaken, 0),
    distanceMovedCells: round(finiteNumber(row?.distanceMovedCells, 0)),
  });
  const normalized = {
    damageDone: finiteNumber(stats.damageDone, 0),
    damageTaken: finiteNumber(stats.damageTaken, 0),
    kills: finiteNumber(stats.kills, 0),
    npcKills: finiteNumber(stats.npcKills, 0),
    playerKills: finiteNumber(stats.playerKills, 0),
    deaths: finiteNumber(stats.deaths, 0),
    shotsFired: finiteNumber(stats.shotsFired, 0),
    hitsDealt: finiteNumber(stats.hitsDealt, 0),
    hitsTaken: finiteNumber(stats.hitsTaken, 0),
    distanceMovedCells: round(finiteNumber(stats.distanceMovedCells, 0)),
    lastDamageDealtTick: nullableFiniteNumber(stats.lastDamageDealtTick),
    lastDamageTakenTick: nullableFiniteNumber(stats.lastDamageTakenTick),
    lastKillTick: nullableFiniteNumber(stats.lastKillTick),
    lastDeath: stats.lastDeath ? {
      tick: finiteNumber(stats.lastDeath.tick, 0),
      killerActorId: String(stats.lastDeath.killerActorId ?? ""),
      cause: String(stats.lastDeath.cause ?? ""),
      weaponId: String(stats.lastDeath.weaponId ?? ""),
      ammoType: String(stats.lastDeath.ammoType ?? ""),
    } : null,
    recent10s: recent(stats.recent10s),
    recent60s: recent(stats.recent60s),
  };
  return {
    ...normalized,
    longArc: deriveActorLongArcProfile(normalized),
  };
}

function finiteNumber(value: unknown, fallback: number): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function nullableFiniteNumber(value: unknown): number | null {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function normalizeStatusId(value: unknown): string {
  return typeof value === "string"
    ? value
      .normalize("NFKC")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_.-]+/gu, "_")
      .replace(/^_+|_+$/gu, "")
      .slice(0, 64)
    : "";
}

function rustStatusSnapshots(actor: AuthorityActor, currentTick: number, tickRateHz: number): AuthorityStatus[] {
  const statuses = actor.statuses.filter((status) => (
    status.id !== "bleeding" &&
    status.id !== "sleeping" &&
    status.id !== "suppressed" &&
    status.id !== "clone_sickness" &&
    status.id !== "downed" &&
    status.id !== "dead"
  ));
  if (actor.bleed.active) {
    statuses.push({
      id: "bleeding",
      label: `Bleed S${Math.max(1, Math.ceil(actor.bleed.severity))} x${actor.bleed.stackCount}`,
      severity: 2,
      remainingMs: actor.bleed.remainingMs,
    });
  }
  if (actor.sleep.active) {
    statuses.push({
      id: "sleeping",
      label: "Sleeping",
      severity: 2,
      remainingMs: actor.sleep.remainingMs,
      stacks: actor.sleep.stacks,
      threshold: 4,
    });
  }
  if (actor.suppression.pressure >= suppressionThresholdForActor(actor)) {
    statuses.push({
      id: "suppressed",
      label: "Suppressed",
      severity: 1,
      remainingMs: 600,
    });
  }
  if (actor.cloneSicknessRemainingMs > 0) {
    statuses.push({
      id: "clone_sickness",
      label: "Clone sickness",
      severity: 1,
      remainingMs: actor.cloneSicknessRemainingMs,
    });
  }
  if (actor.lifeState === "downed") {
    statuses.push(actor.bodyVanishAtTick > 0 ? {
      id: "dead",
      label: "Dead",
      severity: 3,
      remainingMs: remainingTickMs(actor.bodyVanishAtTick, currentTick, tickRateHz, 30_000),
    } : {
      id: "downed",
      label: "Downed",
      severity: 3,
      remainingMs: 14_000,
    });
  } else if (actor.lifeState === "respawning") {
    statuses.push({
      id: "dead",
      label: "Dead",
      severity: 3,
      remainingMs: remainingTickMs(actor.respawnAtTick, currentTick, tickRateHz, 4_500),
    });
  }
  return statuses;
}

function remainingTickMs(targetTick: number, currentTick: number, tickRateHz: number, fallbackMs: number): number {
  if (
    typeof targetTick !== "number" ||
    !Number.isFinite(targetTick) ||
    targetTick <= 0 ||
    typeof currentTick !== "number" ||
    !Number.isFinite(currentTick) ||
    typeof tickRateHz !== "number" ||
    !Number.isFinite(tickRateHz) ||
    tickRateHz <= 0
  ) {
    return fallbackMs;
  }
  return Math.max(0, Math.round(((targetTick - currentTick) / tickRateHz) * 1000));
}

function uniqueActorIds(actorIds: string[]): string[] {
  return [...new Set(actorIds)];
}

function inactiveBleed(): AuthorityBleedState {
  return {
    active: false,
    stackCount: 0,
    severity: 0,
    remainingMs: 0,
    ratesPerSecond: { health: 0, action: 0, spirit: 0 },
    stacks: [],
  };
}

function inactiveSuppression(): AuthoritySuppressionState {
  return { pressure: 0, source: null };
}

function inactiveSleep(): AuthoritySleepState {
  return { active: false, stacks: 0, remainingMs: 0 };
}


function cloneSuppression(suppression: AuthoritySuppressionState | undefined): AuthoritySuppressionState {
  return suppression
    ? { pressure: suppression.pressure, source: suppression.source ? { ...suppression.source } : null }
    : inactiveSuppression();
}

function sameOptionalCell(left: Cell | null | undefined, right: Cell | null | undefined): boolean {
  if (!left || !right) return !left && !right;
  return left.x === right.x && left.y === right.y;
}


function suppressionThresholdForActor(actor: AuthorityActor): number {
  const spiritDiscount = Math.min(0.35, Math.max(0, spiritStrainForActor(actor) * 0.35));
  const bodyDiscount = Math.min(0.35, Math.max(0, bodyStrainForActor(actor) * 0.35));
  const strainDiscount = Math.min(0.55, spiritDiscount + bodyDiscount);
  return Math.max(1, round(actor.effectiveStats.suppressionThreshold * (1 - strainDiscount)));
}

function movementSpeedMultiplierForActor(actor: AuthorityActor): number {
  const scoutTraversalMultiplier = 1 + professionTrackSkillBonusForActor(actor, "scout", "traversal") * 4 / 5 / 1_000;
  const brawlerMovementMultiplier = 1 + professionTrackSkillBonusForActor(actor, "brawler", "movement-speed") * 4 / 5 / 1_000;
  return actor.effectiveStats.movementSpeedMultiplier
    * scoutTraversalMultiplier
    * brawlerMovementMultiplier
    * bodyOutputMultiplierForActor(actor);
}


function professionTrackSkillBonusForActor(
  actor: AuthorityActor,
  professionId: "brawler" | "scout",
  track: string,
): number {
  const skillBoxes = new Set(actorSkillBoxIds(actor) ?? []);
  const professionKnown = actor.professionIds?.includes(professionId)
    || actor.professions?.some((profession) => profession.id === professionId)
    || skillBoxes.has(`${professionId}-novice`);
  if (!professionKnown) return 0;
  skillBoxes.add(`${professionId}-novice`);
  let bonus = 50;
  for (const tier of ["i", "ii", "iii", "iv"] as const) {
    if (skillBoxes.has(`${professionId}-${track}-${tier}`)) bonus += 50;
  }
  if (skillBoxes.has(`${professionId}-master`)) bonus += 50;
  return bonus;
}

function validMoveVector(dx: number, dy: number): boolean {
  return Number.isInteger(dx)
    && Number.isInteger(dy)
    && Math.abs(dx) <= 1
    && Math.abs(dy) <= 1
    && (dx !== 0 || dy !== 0);
}

function movementDeltaForDistance(dx: number, dy: number, distance: number): Cell {
  const length = Math.hypot(dx, dy);
  if (length <= 0.001 || distance <= 0) return { x: 0, y: 0 };
  const scale = distance / length;
  return { x: dx * scale, y: dy * scale };
}

function sprintActionCostMilliForActor(actor: AuthorityActor, durationTicks: number, tickRateHz: number): number {
  const baseMilli = Math.ceil(
    (sprintActionDrainPerSecond * Math.max(1, durationTicks) * 1_000) / Math.max(1, tickRateHz),
  );
  const rawEfficiencyMilli = 1_000 - professionTrackSkillBonusForActor(actor, "scout", "sprinting") * 2;
  const efficiencyMilli = Number.isFinite(rawEfficiencyMilli)
    ? Math.max(700, Math.min(1_000, Math.trunc(rawEfficiencyMilli)))
    : 700;
  return Math.floor((baseMilli * efficiencyMilli) / 1_000);
}

function pendingSprintActionCostForActor(actor: AuthorityActor, durationTicks: number, tickRateHz: number): number {
  return Math.floor(((actor.sprintActionDrainMilli ?? 0) + sprintActionCostMilliForActor(actor, durationTicks, tickRateHz)) / 1_000);
}

function applySprintActionCostForActor(actor: AuthorityActor, durationTicks: number, tickRateHz: number): void {
  actor.sprintActionDrainMilli = (actor.sprintActionDrainMilli ?? 0) + sprintActionCostMilliForActor(actor, durationTicks, tickRateHz);
  const actionDamage = Math.floor(actor.sprintActionDrainMilli / 1_000);
  if (actionDamage <= 0) return;
  actor.vitals.action = Math.max(0, actor.vitals.action - actionDamage);
  actor.sprintActionDrainMilli %= 1_000;
}

function regenVital(current: number, target: number, ratePerSecond: number, dtSeconds: number): number {
  if (current >= target || ratePerSecond <= 0 || dtSeconds <= 0) return current;
  return Math.min(target, current + ratePerSecond * dtSeconds);
}

function bodyOutputMultiplierForActor(actor: AuthorityActor): number {
  return 1 - Math.min(0.35, Math.max(0, spiritStrainForActor(actor) * 0.35));
}

function bodyStrainForActor(actor: AuthorityActor): number {
  const maxHealth = Math.max(1, actor.maxVitals.health);
  return 1 - Math.min(1, Math.max(0, actor.vitals.health) / maxHealth);
}

function spiritStrainForActor(actor: AuthorityActor): number {
  const maxSpirit = Math.max(1, actor.maxVitals.spirit);
  return 1 - Math.min(1, Math.max(0, actor.vitals.spirit) / maxSpirit);
}

function replaceContainerActorId(container: string, fromActorId: string, toActorId: string): string {
  if (container === fromActorId) return toActorId;
  if (container.startsWith(`${fromActorId}:`) || container.startsWith(`${fromActorId}/`)) {
    return `${toActorId}${container.slice(fromActorId.length)}`;
  }
  const corpsePrefix = `corpse:${fromActorId}`;
  if (container === corpsePrefix) return `corpse:${toActorId}`;
  if (container.startsWith(`${corpsePrefix}:`) || container.startsWith(`${corpsePrefix}/`)) {
    return `corpse:${toActorId}${container.slice(corpsePrefix.length)}`;
  }
  return container;
}

function fsyncDirectory(dirPath: string): void {
  const fd = fs.openSync(dirPath, "r");
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}
const craftRollKeySidecarSuffix = ".craft-roll-key";
const craftRollKeyPattern = /^[0-9a-fA-F]{64}$/u;

function resolveGameShardCraftRollKey(checkpointPath: string | undefined, configuredKey: string | undefined): string {
  const injectedKey = configuredKey === undefined
    ? undefined
    : validateCraftRollKey(configuredKey, "configured craft-roll key");
  if (!checkpointPath) return injectedKey ?? randomBytes(32).toString("hex");

  const stateDirectory = dirname(checkpointPath);
  const sidecarPath = `${checkpointPath}${craftRollKeySidecarSuffix}`;
  fs.mkdirSync(stateDirectory, { recursive: true });

  while (true) {
    const existing = readCraftRollKeySidecar(sidecarPath);
    if (existing !== undefined) {
      if (injectedKey !== undefined && existing !== injectedKey) {
        throw new Error("configured craft-roll key does not match the persisted shard key");
      }
      return existing;
    }

    const key = injectedKey ?? randomBytes(32).toString("hex");
    const tempPath = `${sidecarPath}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
    let fd: number;
    try {
      fd = fs.openSync(tempPath, "wx", 0o600);
    } catch (error) {
      throw new Error("failed to create a temporary private shard craft-roll key sidecar", { cause: error });
    }

    try {
      fs.fchmodSync(fd, 0o600);
      fs.writeFileSync(fd, key, "utf8");
      fs.fsyncSync(fd);
    } catch (error) {
      fs.closeSync(fd);
      fs.rmSync(tempPath, { force: true });
      throw new Error("failed to durably write the private shard craft-roll key sidecar", { cause: error });
    }
    fs.closeSync(fd);

    try {
      fs.linkSync(tempPath, sidecarPath);
    } catch (error) {
      fs.rmSync(tempPath, { force: true });
      if ((error as NodeJS.ErrnoException)?.code === "EEXIST") continue;
      throw new Error("failed to install the private shard craft-roll key sidecar", { cause: error });
    }
    try {
      fsyncDirectory(stateDirectory);
    } finally {
      fs.rmSync(tempPath, { force: true });
    }
    fsyncDirectory(stateDirectory);
    return key;
  }
}

function readCraftRollKeySidecar(sidecarPath: string): string | undefined {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(sidecarPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return undefined;
    throw new Error("failed to inspect the private shard craft-roll key sidecar", { cause: error });
  }
  if (!stat.isFile() || (stat.mode & 0o777) !== 0o600) {
    throw new Error("refusing to use a non-private shard craft-roll key sidecar");
  }
  let contents: string;
  try {
    contents = fs.readFileSync(sidecarPath, "utf8");
  } catch (error) {
    throw new Error("failed to read the private shard craft-roll key sidecar", { cause: error });
  }
  return validateCraftRollKey(contents, "persisted craft-roll key");
}

function validateCraftRollKey(value: string, label: string): string {
  if (!craftRollKeyPattern.test(value)) throw new Error(`${label} must be exactly 64 hexadecimal characters`);
  return value.toLowerCase();
}

function assertConfiguredPersistenceCanStart(
  persistence: GameShardPersistenceOptions | undefined,
  hasEnteredCharacters: boolean,
): void {
  const checkpointPath = persistence?.checkpointPath;
  if (!checkpointPath) {
    if (hasEnteredCharacters) {
      throw new Error(
        "refusing to start game shard because durable characters have already entered the world but checkpoint persistence is disabled; explicit recovery or reset is required",
      );
    }
    return;
  }

  const checkpointBytes = durableFileBytes(checkpointPath, "checkpoint");
  const journalPath = persistence?.journalPath;
  const journalBytes = journalPath ? durableFileBytes(journalPath, "journal") : null;
  const journalHasEntries = journalPath && journalBytes !== null
    ? durableJournalHasEntries(journalPath)
    : false;
  if (checkpointBytes === null) {
    const hazards: string[] = [];
    if (journalHasEntries) hazards.push(`configured journal contains ${journalBytes} bytes`);
    if (hasEnteredCharacters) hazards.push("durable characters have already entered the world");
    if (hazards.length > 0) {
      throw new Error(
        `refusing to start game shard because configured durable checkpoint is missing at ${checkpointPath} while ${hazards.join(" and ")}; explicit recovery or reset is required`,
      );
    }
    return;
  }

  if (journalPath && !journalHasEntries) {
    throw new Error(
      `refusing to start game shard because checkpoint ${checkpointPath} exists but its configured journal ${journalPath} is missing or empty; published checkpoints require a durable journal marker, and explicit no-journal mode requires omitting journalPath`,
    );
  }
}

function durableJournalHasEntries(filePath: string): boolean {
  try {
    return fs.readFileSync(filePath, "utf8").split(/\r?\n/u).some((line) => line.trim().length > 0);
  } catch (error) {
    const message = error instanceof Error ? `: ${error.message}` : "";
    throw new Error(`failed to inspect configured game shard journal at ${filePath}${message}`, { cause: error });
  }
}

function durableFileBytes(filePath: string, label: string): number | null {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) throw new Error(`${label} path is not a regular file`);
    return stat.size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return null;
    const message = error instanceof Error ? `: ${error.message}` : "";
    throw new Error(`failed to inspect configured game shard ${label} at ${filePath}${message}`, { cause: error });
  }
}

function directionFromCardinal(direction: CardinalDirection): Direction {
  switch (direction) {
    case "Right":
      return "right";
    case "Left":
      return "left";
    case "Back":
      return "back";
    case "Front":
      return "front";
  }
}

function commandKind(command: ClientCommand): string {
  if ("Move" in command) return "Move";
  if ("SetMoveIntent" in command) return "SetMoveIntent";
  if ("QueueCombatAction" in command) return "QueueCombatAction";
  if ("Peace" in command) return "Peace";
  if ("CancelAbilityQueue" in command) return "CancelAbilityQueue";
  if ("ReloadWeapon" in command) return "ReloadWeapon";
  if ("SetEquippedWeapon" in command) return "SetEquippedWeapon";
  if ("SetEquippedClothing" in command) return "SetEquippedClothing";
  if ("DebugGiveItem" in command) return "DebugGiveItem";
  if ("DebugGrantSkillBoxes" in command) return "DebugGrantSkillBoxes";
  if ("DiscardStack" in command) return "DiscardStack";
  if ("EnterTransition" in command) return "EnterTransition";
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
  if ("SplitStack" in command) return "SplitStack";
  if ("MergeStacks" in command) return "MergeStacks";
  if ("RedeemCreditChip" in command) return "RedeemCreditChip";
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
  if ("StoreToExchange" in command) return "StoreToExchange";
  if ("RetrieveFromExchange" in command) return "RetrieveFromExchange";
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
  if ("DuelChallenge" in command) return "DuelChallenge";
  if ("DuelAccept" in command) return "DuelAccept";
  if ("DuelDecline" in command) return "DuelDecline";
  if ("DuelYield" in command) return "DuelYield";
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
  if ("Deathblow" in command) return "Deathblow";
  if ("TendPlot" in command) return "TendPlot";
  if ("PlaceFarmStructure" in command) return "PlaceFarmStructure";
  if ("RemoveFarmStructure" in command) return "RemoveFarmStructure";
  if ("Fertilize" in command) return "Fertilize";
  if ("BuildPlace" in command) return "BuildPlace";
  if ("BuildRemove" in command) return "BuildRemove";
  if ("BuildToggleDoor" in command) return "BuildToggleDoor";
  if ("HarvestCrop" in command) return "HarvestCrop";
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
  const unclassified: never = command;
  return `Unclassified:${Object.keys(unclassified as Record<string, unknown>)[0] ?? "unknown"}`;
}

const ingressBudgetCapacityEnv = "GAME_INGRESS_BUDGET_CAPACITY";
const ingressBudgetRefillEnv = "GAME_INGRESS_BUDGET_REFILL_PER_SECOND";
const defaultIngressBudgetRule = { capacity: 10, refillPerSecond: 5 } as const;
const ingressBudgetCommandKinds = [
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
  "PlaceCamp",
  "PackUpCamp",
  "DiscardStack",
  "SplitStack",
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
  "GroupInvite",
  "GroupAccept",
  "GroupDecline",
  "GroupLeave",
  "GroupDisband",
  "GroupKick",
  "DuelChallenge",
  "DuelAccept",
  "Deathblow",
  "DuelDecline",
  "DuelYield",
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

export function slowConsumerBufferCapBytesFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[slowConsumerBufferCapEnv];
  if (raw === undefined) return defaultSlowConsumerBufferCapBytes;
  if (!/^\d+$/u.test(raw.trim())) {
    throw new RangeError(`${slowConsumerBufferCapEnv} must be a positive integer byte count`);
  }
  return normalizeSlowConsumerBufferCapBytes(Number(raw));
}

export function gameSessionAdmissionCapFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[gameMaxSessionsEnv];
  if (raw === undefined) return defaultMaxSessions;
  if (!/^\d+$/u.test(raw.trim())) {
    throw new RangeError(`${gameMaxSessionsEnv} must be a positive integer session count`);
  }
  return normalizeMaxSessions(Number(raw));
}

function normalizeMaxSessions(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError("maxSessions must be a positive safe integer session count");
  }
  return value;
}

function normalizeSlowConsumerBufferCapBytes(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError("slowConsumerBufferCapBytes must be a positive safe integer byte count");
  }
  return value;
}

function transportBufferedAmount(socket: GameSocket): number {
  try {
    const bufferedAmount = socket.bufferedAmount;
    return typeof bufferedAmount === "number" && Number.isFinite(bufferedAmount) && bufferedAmount >= 0
      ? Math.floor(bufferedAmount)
      : 0;
  } catch {
    return 0;
  }
}

function createIngressBudgetConfig(
  options: GameShardIngressBudgetOptions | undefined,
  env: NodeJS.ProcessEnv,
  defaultNowMs: () => number,
): IngressBudgetConfig {
  const defaultCapacity = options?.capacity ?? envNumber(env[ingressBudgetCapacityEnv]) ?? defaultIngressBudgetRule.capacity;
  const defaultRefill = options?.refillPerSecond ?? envNumber(env[ingressBudgetRefillEnv]) ?? defaultIngressBudgetRule.refillPerSecond;
  const defaultRule = normalizeIngressBudgetRule({
    capacity: defaultCapacity,
    refillPerSecond: defaultRefill,
  }, defaultIngressBudgetRule);
  const commandKinds: Record<string, IngressBudgetRule> = {};
  for (const kind of ingressBudgetCommandKinds) {
    const override = options?.commandKinds?.[kind];
    commandKinds[kind] = normalizeIngressBudgetRule({
      capacity: override?.capacity ?? defaultRule.capacity,
      refillPerSecond: override?.refillPerSecond ?? defaultRule.refillPerSecond,
    }, defaultRule);
  }
  return {
    default: defaultRule,
    commandKinds,
    nowMs: options?.nowMs ?? defaultNowMs,
  };
}

function normalizeIngressBudgetRule(
  input: { capacity: unknown; refillPerSecond: unknown },
  fallback: IngressBudgetRule,
): IngressBudgetRule {
  return {
    capacity: nonNegativeFiniteNumber(input.capacity) ?? fallback.capacity,
    refillPerSecond: nonNegativeFiniteNumber(input.refillPerSecond) ?? fallback.refillPerSecond,
  };
}

function envNumber(value: string | undefined): number | null {
  if (value === undefined || value.trim() === "") return null;
  return nonNegativeFiniteNumber(Number(value));
}

function nonNegativeFiniteNumber(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  return value;
}

function finiteNumberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function isDebugAuthorityCommand(command: ClientCommand): boolean {
  return "DebugGiveItem" in command || "DebugGrantSkillBoxes" in command;
}

function cardinalFromDirection(direction: Direction): CardinalDirection {
  switch (direction) {
    case "right":
      return "Right";
    case "left":
      return "Left";
    case "back":
      return "Back";
    case "front":
      return "Front";
  }
}

function normalizeDirection(direction: string | undefined): Direction {
  if (direction === "right" || direction === "left" || direction === "back" || direction === "front") return direction;
  if (direction === "Right" || direction === "Left" || direction === "Back" || direction === "Front") {
    return directionFromCardinal(direction);
  }
  return "front";
}

function normalizeFactionId(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const normalized = value
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/gu, "_")
    .replace(/^_+|_+$/gu, "")
    .slice(0, 64);
  return normalized.length > 0 ? normalized : null;
}

function normalizeFactionPvpStatus(value: string | null | undefined): "none" | "covert" | "overt" {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  return normalized === "covert" || normalized === "overt" ? normalized : "none";
}

function normalizeActorAiAttitude(value: string | null | undefined): GameActorSnapshot["aiAttitude"] | undefined {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  return normalized === "passive" || normalized === "alerted" || normalized === "hostile" ? normalized : undefined;
}

function cellKey(x: number, y: number): string {
  return `${Math.floor(x)},${Math.floor(y)}`;
}


function normalizeInventoryRowForStream(row: RustAuthorityInventorySnapshot): RustAuthorityInventorySnapshot {
  const normalized: RustAuthorityInventorySnapshot = { ...row };
  normalized.item = resourceItemLabelWithoutStatsSuffix(normalized.item);

  let resourceStats: RustAuthorityResourceStatsSnapshot | null = null;
  if (!(normalized.itemId >= 2001 && normalized.itemId < 3000)) {
    delete normalized.resourceStats;
  } else if (normalized.itemId === 2009 && (!Number.isFinite(normalized.variantId) || normalized.variantId < 47000000)) {
    delete normalized.resourceStats;
  } else if (normalized.itemId === 2010 && (!Number.isFinite(normalized.variantId) || normalized.variantId < 48000000)) {
    delete normalized.resourceStats;
  } else {
    resourceStats = sanitizeAuthoritativeResourceStats(normalized.resourceStats);
    if (resourceStats === null) delete normalized.resourceStats;
    else normalized.resourceStats = resourceStats;
  }

  const potency = clampResourceStat(resourceStats ? resourceStats.potency : normalized.potency);
  const purity = clampResourceStat(resourceStats ? resourceStats.chemical_purity : normalized.purity);
  if (potency === null) delete normalized.potency;
  else normalized.potency = potency;
  if (purity === null) delete normalized.purity;
  else normalized.purity = purity;
  return normalized;
}

function resourceItemLabelWithoutStatsSuffix(item: string): string {
  const match = /\s+P\d{1,4}\s+Q\d{1,4}$/u.exec(item);
  if (!match) return item;
  return item.slice(0, match.index).trim() || item;
}

function sanitizeAuthoritativeResourceStats(value: unknown): RustAuthorityResourceStatsSnapshot | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const stats = value as Partial<Record<keyof RustAuthorityResourceStatsSnapshot, unknown>>;
  if (!isResourceStatChannel(stats.conductivity)
    || !isResourceStatChannel(stats.malleability)
    || !isResourceStatChannel(stats.shock_resistance)
    || !isResourceStatChannel(stats.thermal_resistance)
    || !isResourceStatChannel(stats.chemical_purity)
    || !isResourceStatChannel(stats.density)
    || !isResourceStatChannel(stats.tensile_strength)
    || !isResourceStatChannel(stats.flexibility)
    || !isResourceStatChannel(stats.potency)
    || !isResourceStatChannel(stats.nutrition)
    || !isResourceStatChannel(stats.stability)
    || !isResourceStatChannel(stats.extraction_yield)) return null;
  return value as RustAuthorityResourceStatsSnapshot;
}

function isResourceStatChannel(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 1_000;
}

function clampResourceStat(value: unknown): number | null {
  const numeric = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  return Math.max(1, Math.min(1000, Math.round(numeric)));
}

function isLootCacheProp(prop: SliceProp): boolean {
  const kind = prop.kind.toLowerCase();
  const id = prop.id.toLowerCase();
  const entity = prop.entity?.toLowerCase() ?? "";
  return prop.interactive === true && (kind === "storage_chest" || entity.startsWith("cache:") || entity.startsWith("loot-cache:") || id.includes("cache"));
}

function isExchangeContainerProp(prop: SliceProp): boolean {
  const entity = prop.entity?.toLowerCase() ?? "";
  const id = prop.id.toLowerCase();
  const kind = prop.kind.toLowerCase();
  return entity.startsWith("container:district-exchange")
    || entity.startsWith("container:district_exchange")
    || id.includes("district-exchange")
    || id.includes("district_exchange")
    || (kind === "resource_container" && entity.includes("district-exchange"))
    || (kind === "resource_container" && entity.includes("district_exchange"));
}

function exchangeContainerPermissions(prop: SliceProp): { ownerActorId: string | null; allowedActorIds: Set<string>; allowedFactionIds: Set<string> } {
  const allowedActorIds = new Set<string>();
  const allowedFactionIds = new Set<string>();
  let ownerActorId: string | null = null;
  for (const token of (prop.entity ?? "").split(":").slice(2)) {
    const trimmed = token.trim();
    if (!trimmed) continue;
    const owner = trimmed.startsWith("owner=") ? trimmed.slice("owner=".length).trim() : null;
    if (owner !== null) {
      if (owner) ownerActorId = owner;
      continue;
    }
    const allowed = trimmed.startsWith("allow=") ? trimmed.slice("allow=".length) : null;
    if (allowed !== null) {
      for (const actorId of allowed.split(",").map((value) => value.trim()).filter(Boolean)) allowedActorIds.add(actorId);
      continue;
    }
    const factions = trimmed.startsWith("faction=") ? trimmed.slice("faction=".length) : null;
    if (factions !== null) {
      for (const factionId of factions.split(",").map((value) => value.trim()).filter(Boolean)) allowedFactionIds.add(factionId);
      continue;
    }
    if (trimmed.includes("_")) allowedFactionIds.add(trimmed);
    else allowedActorIds.add(trimmed);
  }
  return { ownerActorId, allowedActorIds, allowedFactionIds };
}

function isAmmoStockpileProp(prop: SliceProp): boolean {
  const entity = prop.entity?.toLowerCase() ?? "";
  const id = prop.id.toLowerCase();
  return entity.startsWith("stockpile:ammo") || id.includes("ammo-stockpile");
}

function ammoStockpileFaction(prop: SliceProp): string | null {
  const entity = prop.entity?.trim() ?? "";
  const faction = entity.startsWith("stockpile:ammo:") ? entity.slice("stockpile:ammo:".length).trim() : "";
  return faction || null;
}

function propCenterMilli(prop: SliceProp): { xMilli: number; yMilli: number } {
  return {
    xMilli: Math.trunc(prop.cell.x * milliCellsPerCell) + Math.trunc(Math.max(1, prop.size.w) * milliCellsPerCell / 2),
    yMilli: Math.trunc(prop.cell.y * milliCellsPerCell) + Math.trunc(Math.max(1, prop.size.h) * milliCellsPerCell / 2),
  };
}

function inventoryRowKey(row: RustAuthorityInventorySnapshot): string {
  return `${row.container}\u0000${row.stackId}`;
}

function reservationRowKey(row: RustAuthorityReservationSnapshot): string {
  return String(row.id);
}

function sameInventoryRowList(left: RustAuthorityInventorySnapshot[], right: RustAuthorityInventorySnapshot[]): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    const leftRow = left[index];
    const rightRow = right[index];
    if (!leftRow || !rightRow || !sameInventoryRow(leftRow, rightRow)) return false;
  }
  return true;
}

function sameReservationRowList(left: RustAuthorityReservationSnapshot[], right: RustAuthorityReservationSnapshot[]): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    const leftRow = left[index];
    const rightRow = right[index];
    if (!leftRow || !rightRow || !sameReservationRow(leftRow, rightRow)) return false;
  }
  return true;
}

function sameInventoryRowsByKey(known: Map<string, RustAuthorityInventorySnapshot>, rows: RustAuthorityInventorySnapshot[]): boolean {
  if (known.size !== rows.length) return false;
  const knownKeys = known.keys();
  for (const row of rows) {
    const key = inventoryRowKey(row);
    if (knownKeys.next().value !== key) return false;
    const previous = known.get(key);
    if (!previous || !sameInventoryRow(previous, row)) return false;
  }
  return true;
}

function sameReservationRowsByKey(known: Map<string, RustAuthorityReservationSnapshot>, rows: RustAuthorityReservationSnapshot[]): boolean {
  if (known.size !== rows.length) return false;
  const knownKeys = known.keys();
  for (const row of rows) {
    const key = reservationRowKey(row);
    if (knownKeys.next().value !== key) return false;
    const previous = known.get(key);
    if (!previous || !sameReservationRow(previous, row)) return false;
  }
  return true;
}

function sameInventoryRow(left: RustAuthorityInventorySnapshot, right: RustAuthorityInventorySnapshot): boolean {
  return left.container === right.container
    && left.stackId === right.stackId
    && left.item === right.item
    && left.itemId === right.itemId
    && left.variantId === right.variantId
    && left.quantity === right.quantity
    && left.reserved === right.reserved
    && left.available === right.available
    && left.potency === right.potency
    && left.equipped === right.equipped
    && sameStringList(left.colors, right.colors)
    && left.purity === right.purity
    && sameResourceStats(left.resourceStats, right.resourceStats)
    && left.itemKey === right.itemKey
    && sameMetadataRecord(left.metadata, right.metadata);
}

function sameStringList(left: readonly string[] | undefined, right: readonly string[] | undefined): boolean {
  if (left === right) return true;
  if (!left || !right || left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

function sameResourceStats(
  left: RustAuthorityResourceStatsSnapshot | undefined,
  right: RustAuthorityResourceStatsSnapshot | undefined,
): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  return left.conductivity === right.conductivity
    && left.malleability === right.malleability
    && left.shock_resistance === right.shock_resistance
    && left.thermal_resistance === right.thermal_resistance
    && left.chemical_purity === right.chemical_purity
    && left.density === right.density
    && left.tensile_strength === right.tensile_strength
    && left.flexibility === right.flexibility
    && left.potency === right.potency
    && left.nutrition === right.nutrition
    && left.stability === right.stability
    && left.extraction_yield === right.extraction_yield;
}

function sameReservationRow(left: RustAuthorityReservationSnapshot, right: RustAuthorityReservationSnapshot): boolean {
  return left.id === right.id
    && left.actor === right.actor
    && left.purpose === right.purpose
    && left.from === right.from
    && left.item === right.item
    && left.quantity === right.quantity
    && left.expiresAtTick === right.expiresAtTick;
}

function sameMetadataRecord(left: Record<string, unknown> | undefined, right: Record<string, unknown> | undefined): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every((key) => JSON.stringify(left[key]) === JSON.stringify(right[key]));
}

function propBlocksMovement(prop: SliceProp): boolean {
  return prop.kind !== "sign" && prop.solid !== false;
}

function integerCellsForRect(cell: Cell, size: SliceCellSize): Cell[] {
  const cells: Cell[] = [];
  const minX = Math.floor(cell.x);
  const minY = Math.floor(cell.y);
  const maxX = Math.ceil(cell.x + size.w);
  const maxY = Math.ceil(cell.y + size.h);
  for (let y = minY; y < maxY; y += 1) {
    for (let x = minX; x < maxX; x += 1) cells.push({ x, y });
  }
  return cells;
}

function normalizeClientViewInterest(view: GameClientView | undefined, tick: number): SessionInterestView | null {
  if (!view) return null;
  return {
    viewportWidthCells: clampRounded(view.viewport_width_cells, defaultViewportWidthCells, 1, maxViewportWidthCells),
    viewportHeightCells: clampRounded(view.viewport_height_cells, defaultViewportHeightCells, 1, maxViewportHeightCells),
    marginCells: clampRounded(view.margin_cells ?? defaultViewportMarginCells, defaultViewportMarginCells, 0, maxViewportMarginCells),
    updatedAtTick: tick,
    centerActorId: view.center_actor_id,
  };
}

function clampRounded(value: number, fallback: number, min: number, max: number): number {
  const finite = Number.isFinite(value) ? value : fallback;
  return Math.round(Math.min(max, Math.max(min, finite)) * 10) / 10;
}

function compareActorInterestEntry(
  left: { actor: AuthorityActor; interest: ActorInterestMatch },
  right: { actor: AuthorityActor; interest: ActorInterestMatch },
): number {
  return actorInterestPriorityRank(left.actor) - actorInterestPriorityRank(right.actor)
    || compareActorInterest(left.interest, right.interest)
    || left.actor.id.localeCompare(right.actor.id);
}

function compareActorIdInterest(
  left: { id: string; interest: ActorInterestMatch },
  right: { id: string; interest: ActorInterestMatch },
): number {
  return compareActorInterest(left.interest, right.interest) || left.id.localeCompare(right.id);
}

function compareActorInterest(left: ActorInterestMatch, right: ActorInterestMatch): number {
  return interestTierRank(left.tier) - interestTierRank(right.tier)
    || left.distanceSq - right.distanceSq;
}

function isHighFrequencyAuthorityActor(actor: AuthorityActor): boolean {
  return actor.id.startsWith("skirmish-")
    || (actor.route.length >= 2 && actor.lifeState === "alive");
}

function isPlayerLikeActor(actor: Pick<AuthorityActor, "id" | "role">): boolean {
  return actor.id === "player" || actor.role === "player" || actor.role === "agent_player";
}

function actorInterestPriorityRank(actor: AuthorityActor): number {
  if (actor.route.length >= 2 && actor.lifeState === "alive") return 0;
  if (actor.id.startsWith("skirmish-")) return 1;
  return 2;
}

function selectPriorityInterestEntries(
  entries: Array<{ actor: AuthorityActor; interest: ActorInterestMatch }>,
  count: number,
): Array<{ actor: AuthorityActor; interest: ActorInterestMatch }> {
  if (count <= 0) return [];
  const priority: Array<{ actor: AuthorityActor; interest: ActorInterestMatch }> = [];
  for (const entry of entries) {
    let insertAt = priority.length;
    for (let index = 0; index < priority.length; index += 1) {
      if (compareActorInterestEntry(entry, priority[index]!) < 0) {
        insertAt = index;
        break;
      }
    }
    if (insertAt >= count) continue;
    priority.splice(insertAt, 0, entry);
    if (priority.length > count) priority.pop();
  }
  return priority;
}

function interestTierRank(tier: ActorInterestTier): number {
  return tier === "visible" ? 0 : 1;
}

function actorMovementCadenceForDistanceSq(distanceSq: number): number {
  if (distanceSq <= nearActorMovementRadiusCells * nearActorMovementRadiusCells) return nearActorMovementCadenceTicks;
  if (distanceSq <= midActorMovementRadiusCells * midActorMovementRadiusCells) return midActorMovementCadenceTicks;
  return farActorMovementCadenceTicks;
}

function actorMovementCadenceBucketChanged(currentTick: number, previousTick: number, actorNetId: number, cadence: number): boolean {
  const safeCadence = Math.max(1, cadence);
  const previous = Math.max(0, previousTick);
  return Math.floor((currentTick + actorNetId) / safeCadence) !== Math.floor((previous + actorNetId) / safeCadence);
}

function dirtyActorBucketKey(x: number, y: number): string {
  return `${x},${y}`;
}

function normalizeId(value: string): string {
  return value
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 64) || "player";
}

function isGlobalInventoryContainerNamespaceId(value: string): boolean {
  const candidate = value.normalize("NFKC").trim().toLowerCase();
  return globalInventoryContainerNamespaceRoots.some((root) => (
    candidate === root
    || candidate.startsWith(`${root}:`)
    || candidate.startsWith(`${root}/`)
    // Actor-id normalization maps ':' and '/' to '-', so reserve the canonical
    // transport spelling as well as the authoritative container spelling.
    || candidate.startsWith(`${root}-`)
  ));
}

function normalizeDisplayName(value: string, fallback: string): string {
  return value
    .normalize("NFKC")
    .trim()
    .replace(/\s+/gu, " ")
    .slice(0, 32) || fallback;
}

function trimSeenCommands(commands: Set<number>): void {
  if (commands.size <= 256) return;
  const sorted = [...commands].sort((left, right) => right - left).slice(0, 160);
  commands.clear();
  for (const id of sorted) commands.add(id);
}

function reasonForRejectedNoEventCommand(command: ClientCommand): string {
  if ("Move" in command) return "move_rejected";
  if ("SetMoveIntent" in command) return "move_intent_rejected";
  if ("EnterTransition" in command) return "transition_rejected";
  if ("UseConsumable" in command) return "consumable_rejected";
  if ("RefillAmmo" in command) return "ammo_refill_rejected";
  if ("ApplyServiceBuff" in command) return "service_buff_rejected";
  if ("CloneRespawn" in command) return "clone_respawn_rejected";
  if ("ReviveActor" in command) return "revive_actor_rejected";
  if ("SetPosture" in command) return "posture_rejected";
  if ("Peace" in command) return "peace_rejected";
  if ("SampleResource" in command) return "sample_resource_rejected";
  if ("SurveyResource" in command) return "survey_resource_rejected";
  if ("DiscardStack" in command) return "discard_stack_rejected";
  if ("SplitStack" in command) return "split_stack_rejected";
  if ("MergeStacks" in command) return "merge_stacks_rejected";
  if ("RedeemCreditChip" in command) return "redeem_credit_chip_rejected";
  if ("HarvestCorpse" in command) return "harvest_corpse_rejected";
  if ("BankStoreItem" in command) return "bank_store_item_rejected";
  if ("BankRetrieveItem" in command) return "bank_retrieve_item_rejected";
  if ("BankDepositCredits" in command) return "bank_deposit_credits_rejected";
  if ("BankWithdrawCredits" in command) return "bank_withdraw_credits_rejected";
  if ("CloneSaveSkillBackup" in command) return "clone_save_skill_backup_rejected";
  if ("CorpseTakeCredits" in command) return "corpse_take_credits_rejected";
  if ("ToggleDoor" in command) return "door_toggle_rejected";
  if ("TakeLootItem" in command) return "loot_target_unknown";
  if ("PurchaseTravelTicket" in command) return "travel_purchase_rejected";
  if ("UseTravelTicket" in command) return "travel_use_rejected";
  if ("CraftBegin" in command || "CraftAssignSlot" in command || "CraftClearSlot" in command || "CraftAssemble" in command || "CraftExperiment" in command || "CraftFinalizePrototype" in command || "CraftFinalizePractice" in command || "CraftDraftSchematic" in command || "CraftCancel" in command || "RequestStarterTool" in command) return "craft_session_rejected";
  if ("CraftItem" in command) return "craft_item_rejected";
  if ("PurchaseSkillBox" in command) return "purchase_skill_box_rejected";
  if ("UnlearnSkillBox" in command) return "unlearn_skill_box_rejected";
  if ("SetProfessionTitle" in command) return "profession_title_rejected";
  if ("SetCareerGoal" in command) return "career_goal_rejected";
  return "fire_rejected";
}

function stringValue(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.trim();
}

function integerValue(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.trunc(value);
}

function cloneInventoryMetadata(metadata: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!metadata) return undefined;
  return JSON.parse(JSON.stringify(metadata)) as Record<string, unknown>;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function createDurabilityManifest(options: { release: string; sourceStateHash: string; fixtureHash: string; mapBundleHash: string; craftRollKey: string; controlSchemaHead: { version: number; checksum: string } }): GameShardDurabilityManifest {
  const base = {
    schema: "successor.state-generation-manifest.v1" as const,
    release: options.release,
    sourceStateHash: options.sourceStateHash,
    fixtureHash: options.fixtureHash,
    mapBundleHash: options.mapBundleHash,
    wireSchema: "successor.authoritative-shard-delta.v1" as const,
    saveSchema: "successor.game-shard-checkpoint.v1" as const,
    journalAnchor: "checkpoint" as const,
    characterMirror: "successor.character-store.v2" as const,
    craftRollKeyId: sha256(options.craftRollKey),
    controlSchemaHead: options.controlSchemaHead,
  };
  return { ...base, generation: sha256(stableStringify(base)) };
}

function durabilityManifestMatches(candidate: unknown, expected: GameShardDurabilityManifest, strict = false): boolean {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return false;
  const value = candidate as Partial<GameShardDurabilityManifest>;
  const candidateRecord = { ...value } as Record<string, unknown>;
  const candidateGeneration = candidateRecord.generation;
  delete candidateRecord.generation;
  if (
    typeof candidateGeneration !== "string"
    || candidateGeneration !== sha256(stableStringify(candidateRecord))
    || !controlSchemaHeadCanUpgrade(value.controlSchemaHead, expected.controlSchemaHead)
  ) {
    return false;
  }
  const candidateBase = { ...candidateRecord };
  const expectedBase = { ...expected } as Record<string, unknown>;
  delete candidateBase.controlSchemaHead;
  delete expectedBase.controlSchemaHead;
  delete expectedBase.generation;
  if (!strict) {
    delete candidateBase.craftRollKeyId;
    delete expectedBase.craftRollKeyId;
  }
  return stableStringify(candidateBase) === stableStringify(expectedBase);
}

function hashStable(value: unknown): string {
  return sha256(stableStringify(value));
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}

function setActorLifeState(actor: AuthorityActor, lifeState: GameActorLifeState): boolean {
  if (actor.lifeState === lifeState) return false;
  actor.lifeState = lifeState;
  actor.lifecycleSeq = positiveIntegerOr(actor.lifecycleSeq, 1) + 1;
  return true;
}

function integerOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : fallback;
}

function positiveIntegerOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function positiveNumberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function cellToMilli(value: number): number {
  return Math.round(value * milliCellsPerCell);
}

function pointInRadiusMilli(x: number, y: number, centerX: number, centerY: number, radius: number): boolean {
  const dx = x - centerX;
  const dy = y - centerY;
  return dx * dx + dy * dy <= radius * radius;
}

function pointInShelterBox(
  x: number,
  y: number,
  shelter: RustAuthorityWeatherHazardInput["shelters"][number],
): boolean {
  return x >= shelter.minXMilli && x <= shelter.maxXMilli && y >= shelter.minYMilli && y <= shelter.maxYMilli;
}

function shelterBoxForProp(prop: SliceProp): RustAuthorityWeatherHazardInput["shelters"][number] {
  const left = Math.trunc(prop.cell.x) * milliCellsPerCell;
  const top = Math.trunc(prop.cell.y) * milliCellsPerCell;
  const right = Math.trunc(prop.cell.x + Math.max(1, prop.size.w)) * milliCellsPerCell;
  const bottom = Math.trunc(prop.cell.y + Math.max(1, prop.size.h)) * milliCellsPerCell;
  const inset = 250;
  return {
    minXMilli: Math.min(left + inset, right),
    minYMilli: Math.min(top + inset, bottom),
    maxXMilli: Math.max(right - inset, left),
    maxYMilli: Math.max(bottom - inset, top),
  };
}

export const gameShardInternalsForTest = {
  cardinalFromDirection,
  directionFromCardinal,
  actorPatch,
  normalizeRustActorAppearance,
  commandKind,
};
