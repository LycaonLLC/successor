import { Client as ColyseusClient, type Room as ColyseusRoom } from "@colyseus/sdk";
import type { SfxPlayer, SfxPlayOptions } from "../audio/sfx";
import type { LaunchIdentity } from "../runtime/launchIdentity";
import { isAmmoTypeId, type AmmoTypeId } from "./ammoSystem";
import {
  authorityMoveIntentDurationTicks,
  authorityCommandKind,
  deferInFlightAuthorityCommand,
  settleAuthorityCommand,
  type AuthorityClientCommandEnvelope,
  type AuthorityCardinalDirection,
} from "./authorityCommandSystem";
import {
  authorityActorCanSprint,
  authorityMovementDistanceCells,
} from "./authorityMovementSystem";
import {
  createInactiveBleedState,
  type BleedState,
  type CombatStatus,
} from "./combatReducer";
import { playWeaponFireAudio } from "./combatAudioSystem";
import {
  ROLL_BURST_ORDINAL_RESET_MS,
  rollBurstDelayMsForOrdinal,
  rollBurstOrdinalKey,
} from "./rollBurstCadence";
import type { ActorLifeState, BodyZone, CombatStatusId } from "./combatTypes";
import {
  spawnBandageEffect,
  hasActorFloatingFeedback,
  spawnFloatingDamage,
  spawnFloatingExperience,
  spawnFloatingStatusText,
  spawnInventoryTransferEffect,
  spawnPersonalShieldBlockEffect,
  spawnResourceSampleEffect,
  spawnStimpakEffect,
} from "./effectsSystem";
import type {
  AbilityQueueEvent,
  AbilityQueueView,
  PlayState,
  InventoryRow,
  ReservationRow,
  ActorPosture,
  ServerAuthorityCombatQueueState,
  ServerAuthorityActorState,
  ServerAuthoritySurveyResultState,
  ServerAuthorityResourceSpawnState,
  ServerAuthorityPlacedExtractorState,
  ServerAuthorityPlacedCampState,
  ServerAuthorityParcelState,
  ServerAuthorityFarmPlotState,
  ServerAuthorityBuildingState,
  ServerAuthorityCraftSessionState,
  ServerAuthorityGenomeScanState,
  ServerAuthoritySpliceSessionState,
  ServerAuthorityTradeSessionState,
  ServerAuthorityDraftedSchematicState,
  ServerAuthorityDuelViewState,
  ServerAuthorityDuelOutcomeState,
  ServerAuthorityGroupViewState,
  ServerAuthorityGuildViewState,
  ServerAuthorityPropState,
  ServerAuthorityBankState,
  ServerAuthorityPlayerCorpseState,
  ServerAuthorityViewInterestState,
  ServerAuthorityAiAttitude,
  ServerAuthorityWeatherState,
  ServerAuthorityActorAppearanceState,
  ServerAuthorityActorFaceState,
  SliceSnapshot,
} from "./gameState";
import { declaredSliceActorCount } from "./gameState";
import { directionFromVector, normalizeDirection, type Direction, type Point } from "./geometry";
import {
  applyGameSpawnParams,
  runtimeGameWsUrl,
} from "../runtime/runtimeDefaults";
import { isSprintKey, moveIfUnblocked, movementVectorFromKeys } from "./movementSystem";
import { movementInputKeys } from "./runtimeUpdateSystem";
import { cloneFacilityForRespawn } from "./transitionSystem";
import { triggerWeaponFireAnimation, triggerWeaponReloadAnimation } from "./weaponPresentationSystem";
import { isMeleeWeaponPresentation, isWeaponId, weaponSpecs, type WeaponId } from "./weaponSystem";
import { buildBlockedCells, buildMovementBlockers, currentArea } from "./worldQueries";
import { applyWorldClockSnapshot, type WorldClockSnapshot } from "./worldClockSystem";
import { enqueueSpatialBubble } from "./spatialBubbleSystem";
import { successorMoveTraceEnabled, recordSuccessorMoveTrace } from "./moveTraceSystem";
import { successorAudioIds } from "./successorAudioIds";
import {
  BugReportSubmissionError,
  bugReportResultForRequest,
  type AcceptedBugReport,
  type BugReportSubmission,
} from "./bugReportSystem";

const STIMPAK_A_ITEM_ID = 1001;
const FIELD_BANDAGE_ITEM_ID = 1002;
const RESUSCITATION_KIT_ITEM_ID = 1003;
const IRON_SLUG_ITEM_ID = 1101;
const creditsChimeMinSpacingMs = 350;
const resourceSamplePullLoopTicks = 81;
const doorSlideMinSpacingMs = 500;

const creditsChimeByState = new WeakMap<PlayState, number>();
const doorSlideByState = new WeakMap<PlayState, Map<string, number>>();

export interface GameAuthorityClient {
  enabled: boolean;
  flush: () => void;
  initialSnapshot: Promise<void>;
  submitBugReport: (report: BugReportSubmission) => Promise<AcceptedBugReport>;
  close: () => void;
}

export type GameAuthorityLaunchFailureReason = "game-failed" | "session-replaced";

export function gameAuthorityLaunchFailureForLeave(
  code: number,
  reason: string,
): GameAuthorityLaunchFailureReason | null {
  return code === 4000 && reason === "game session replaced"
    ? "session-replaced"
    : null;
}

export interface CreateGameAuthorityClientParams {
  state: PlayState;
  slice: SliceSnapshot;
  launchIdentity: LaunchIdentity;
  sfx: SfxPlayer;
  getViewInterest?: () => GameAuthorityViewInterest | null;
  onLaunchFailure?: (reason: GameAuthorityLaunchFailureReason) => void;
}

export type GameAuthorityViewInterest = ServerAuthorityViewInterestState;

interface CombatVisualCadenceState {
  lastAtMs: number;
  burstIndex: number;
}

interface RollBurstAudioOrdinalState {
  ordinal: number;
  lastAtMs: number;
  firstWallAtMs: number;
}

type CombatEventActorSnapshots = Map<string, ServerAuthorityActorState>;


interface GameActorStatusSnapshot {
  id: string;
  label: string;
  severity: number;
  remainingMs: number;
  stacks?: number;
  threshold?: number;
}
interface GameActorProfessionSnapshot {
  id: string;
  label: string;
  xp: number;
  trackXp?: Record<string, number>;
  skillPoints: number;
  skillBoxes?: string[];
}

interface GameActorProfessionTitleSnapshot {
  id: string;
  label: string;
  skillBoxId: string;
}

interface GameActorPersonalShieldSnapshot {
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

interface GameActorWeaponSnapshot {
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


interface GameActorFaceSnapshot {
  eyes: string;
  brows: string;
  nose: string;
  mouth: string;
  eye_color: string;
  brow_color: string;
  lip_color: string;
}

interface GameActorAppearanceSnapshot {
  skin: string;
  hair: string | null;
  hair_mat: string;
  face?: GameActorFaceSnapshot | null;
}

interface GameActorWornPiece {
  item: string;
  colors: string[];
}

interface GameActorSnapshot {
  id: string;
  label: string;
  display_name?: string;
  descriptor?: string;
  link_dead?: boolean;
  appearance?: GameActorAppearanceSnapshot;
  worn?: GameActorWornPiece[];
  wornColors?: Record<string, string[]>;
  role?: string | null;
  sprite?: string | null;
  areaId: string;
  x: number;
  y: number;
  direction: Direction;
  lifeState: ActorLifeState;
  lifecycleSeq: number;
  vitals: { health: number; action: number; spirit: number };
  maxVitals: { health: number; action: number; spirit: number };
  bleed: {
    active: boolean;
    stackCount: number;
    severity: number;
    remainingMs: number;
    ratesPerSecond: { health: number; action: number; spirit: number };
  };
  statuses: GameActorStatusSnapshot[];
  personalShield?: GameActorPersonalShieldSnapshot | null;
  weapon?: GameActorWeaponSnapshot | null;
  professions?: GameActorProfessionSnapshot[];
  activeTitle?: GameActorProfessionTitleSnapshot | null;
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
  aiAttitude?: ServerAuthorityAiAttitude;
  willAutoAggro?: boolean;
  playerOrganizationId?: string | null;
  playerOrganizationTag?: string | null;
  posture?: ActorPosture;
  postureUntilTick?: number;
  combatQueue?: ServerAuthorityCombatQueueState;
  inCombat?: boolean;
  peaceRequested?: boolean;
  engagementTargetId?: string | null;
  /** Sprint recovery projection (see ServerAuthorityActorState.mobility). */
  mobility?: { sprintRecoveryLocked?: boolean } | null;
}

type GameActorPatch = Pick<GameActorSnapshot, "id"> & Partial<Omit<GameActorSnapshot, "id" | "maxVitals" | "vitals" | "bleed" | "statuses" | "combatQueue" | "aiAttitude">> & {
  vitals?: GameActorSnapshot["vitals"];
  maxVitals?: GameActorSnapshot["maxVitals"];
  bleed?: GameActorSnapshot["bleed"];
  statuses?: GameActorStatusSnapshot[];
  weapon?: GameActorSnapshot["weapon"];
  combatQueue?: GameActorSnapshot["combatQueue"] | null;
  aiAttitude?: GameActorSnapshot["aiAttitude"] | null;
};

type GameCompactVitals = [health: number, action: number, spirit: number];
type GameCompactBleed = [
  active: 0 | 1,
  stackCount: number,
  severity: number,
  remainingMs: number,
  healthRate: number,
  actionRate: number,
  spiritRate: number,
];
type GameCompactDirection = 0 | 1 | 2 | 3;
type GameCompactLifeState = 0 | 1 | 2;

type GameActorNetRef = [netId: number, actorId: string];
type GameCompactActorMove = [
  netId: number,
  qx: number,
  qy: number,
  direction: GameCompactDirection,
];

type GameCompactActorSnapshot = [
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
  posture?: ActorPosture,
  postureUntilTick?: number,
  combatQueue?: ServerAuthorityCombatQueueState | null,
  inCombat?: 0 | 1 | boolean | null,
  cloneSicknessRemainingMs?: number,
  peaceRequested?: 0 | 1 | boolean | null,
  aiAttitude?: ServerAuthorityAiAttitude | null,
  engagementTargetId?: string | null,
  lootable?: 0 | 1 | boolean | null,
  hasLoot?: 0 | 1 | boolean | null,
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
  willAutoAggro?: 0 | 1 | boolean | null,
  descriptor?: string,
  sprintRecoveryLocked?: 0 | 1,
];
type GameCompactActorPatch = [
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
  posture?: ActorPosture | null,
  postureUntilTick?: number | null,
  combatQueue?: ServerAuthorityCombatQueueState | null | false,
  inCombat?: 0 | 1 | boolean | null,
  cloneSicknessRemainingMs?: number | null,
  peaceRequested?: 0 | 1 | boolean | null,
  aiAttitude?: ServerAuthorityAiAttitude | null,
  engagementTargetId?: string | null | false,
  lootable?: 0 | 1 | boolean | null,
  hasLoot?: 0 | 1 | boolean | null,
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
  willAutoAggro?: 0 | 1 | boolean | null,
  descriptor?: string | null,
  sprintRecoveryLocked?: 0 | 1 | null,
];

type GamePlayerPositionAck = [x: number, y: number];

type GamePropState = ServerAuthorityPropState;
type GameWeatherSnapshot = ServerAuthorityWeatherState;

interface GameShardSnapshot {
  schema: "successor.authoritative-shard-snapshot.v1";
  shardId: string;
  tick: number;
  playerActorId: string;
  actors: Record<string, GameActorSnapshot>;
  inventory?: InventoryRow[];
  reservations?: ReservationRow[];
  bank?: ServerAuthorityBankState | null;
  playerCorpses?: ServerAuthorityPlayerCorpseState[];
  resourceSpawns?: ServerAuthorityResourceSpawnState[];
  placedExtractors?: ServerAuthorityPlacedExtractorState[];
  placedCamps?: ServerAuthorityPlacedCampState[];
  placedParcels?: ServerAuthorityParcelState[];
  building?: ServerAuthorityBuildingState;
  farmPlots?: ServerAuthorityFarmPlotState[];
  craftSession?: ServerAuthorityCraftSessionState | null;
  draftedSchematics?: ServerAuthorityDraftedSchematicState[];
  groups?: ServerAuthorityGroupViewState;
  guilds?: ServerAuthorityGuildViewState;
  duels?: ServerAuthorityDuelViewState;
  propStates?: Record<string, GamePropState>;
  actorRefs?: GameActorNetRef[];
  sourceStateHash?: string;
  sourceActorCount?: number;
  worldClock?: WorldClockSnapshot;
  weather?: GameWeatherSnapshot[];
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

interface GameDialogueDelivery {
  actorId?: unknown;
  speaker?: unknown;
  body?: unknown;
}
interface GameShardDelta {
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
  inventory?: InventoryRow[];
  reservations?: ReservationRow[];
  bank?: ServerAuthorityBankState | null;
  playerCorpses?: ServerAuthorityPlayerCorpseState[];
  resourceSpawns?: ServerAuthorityResourceSpawnState[];
  placedExtractors?: ServerAuthorityPlacedExtractorState[];
  placedCamps?: ServerAuthorityPlacedCampState[];
  placedParcels?: ServerAuthorityParcelState[];
  building?: ServerAuthorityBuildingState;
  farmPlots?: ServerAuthorityFarmPlotState[];
  craftSession?: ServerAuthorityCraftSessionState | null;
  draftedSchematics?: ServerAuthorityDraftedSchematicState[];
  groups?: ServerAuthorityGroupViewState;
  guilds?: ServerAuthorityGuildViewState;
  duels?: ServerAuthorityDuelViewState;
  propStates?: Record<string, GamePropState>;
  sourceStateHash?: string;
  sourceActorCount?: number;
  worldClock?: WorldClockSnapshot;
  weather?: GameWeatherSnapshot[];
  abilityQueue?: AbilityQueueView | null;
  abilityQueueEvents?: AbilityQueueEvent[];
  dialogueDeliveries?: GameDialogueDelivery[];
  counters?: GameShardSnapshot["counters"];
}

interface GameCommandReceipt {
  commandId: number;
  accepted: boolean;
  tick: number;
  reasonCode?: string;
  fireDebug?: GameFireDebug;
}

type GameCompactReceipt = [commandId: number, accepted: 0 | 1, tick: number, reasonCode?: string];
export const staleInFlightMoveExpiryMs = 2_000;


interface GameFireDebug {
  shooterActorId: string;
  areaId: string;
  direction: "front" | "right" | "back" | "left";
  aimOffsetDegrees?: number;
  aimSpreadDegrees?: number;
  recoilBefore?: number;
  recoilAfter?: number;
  suppressionPressure?: number;
  actor: {
    x: number;
    y: number;
  };
  muzzle: {
    x: number;
    y: number;
  };
  start: {
    x: number;
    y: number;
  };
  end: {
    x: number;
    y: number;
  };
  expandedCollisionRadiusCells: number;
  hitActorId: string | null;
  hitPoint: {
    x: number;
    y: number;
  } | null;
  hitZone: BodyZone | null;
  distanceCells: number | null;
  terrainPoint?: {
    x: number;
    y: number;
  } | null;
  terrainDistanceCells?: number | null;
  blockedBeforeActor?: boolean;
  actorIntersections?: Array<{
    actorId: string;
    lifeState: ActorLifeState;
    point: {
      x: number;
      y: number;
    };
    hitZone: BodyZone;
    distanceCells: number;
    t: number;
    expandedBox: {
      left: number;
      right: number;
      top: number;
      bottom: number;
    };
  }>;
}

interface GameCombatEvent {
  id: number;
  commandId?: number | null;
  tick: number;
  shooterActorId: string;
  targetActorId: string;
  originPoint?: {
    x: number;
    y: number;
  };
  hitPoint?: {
    x: number;
    y: number;
  };
  damage: number;
  zone: BodyZone;
  previousLifeState: ActorLifeState;
  lifeState: ActorLifeState;
  targetLifecycleSeq: number;
  bleedStackCount: number;
  weaponId?: WeaponId;
  ammoTypeId?: AmmoTypeId;
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
  lifecycle?: {
    kind: "hit" | "downed" | "killed";
    from: ActorLifeState;
    to: ActorLifeState;
    cause: string;
  };
  /** Roll-combat (ranged_roll) extensions. */
  kind?: string;
  actionId?: string;
  hit?: boolean;
  pool?: string;
  rollMilli?: number;
  toHitMilli?: number;
  /** Roll-combat events: hit=false is MISS; effect.kind=dodge is DODGE. */
}

type GameCompactCombatEvent = [
  id: number,
  commandId: number | null,
  tick: number,
  shooterActorId: string,
  targetActorId: string,
  hitX: number | null,
  hitY: number | null,
  damage: number,
  zone: BodyZone,
  previousLifeState: ActorLifeState,
  lifeState: ActorLifeState,
  targetLifecycleSeq: number,
  bleedStackCount: number,
  lifecycleKind: "hit" | "downed" | "killed" | null,
  lifecycleFrom: ActorLifeState | null,
  lifecycleTo: ActorLifeState | null,
  lifecycleCause: string | null,
  weaponId?: WeaponId | null,
  ammoTypeId?: AmmoTypeId | null,
  effectKind?: "sleep" | "dodge" | "shield" | null,
  effectStacks?: number | null,
  effectThreshold?: number | null,
  effectRemainingMs?: number | null,
  originX?: number | null,
  originY?: number | null,
  kind?: string | null,
  attackerActorId?: string | null,
  actionId?: string | null,
  hit?: 0 | 1 | boolean | null,
  pool?: string | null,
  rollMilli?: number | null,
  toHitMilli?: number | null,
];

type GameServerPacket =
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

const rapidCombatVisualWindowMs = 170;
const rapidCombatMajorEvery = 4;
const maxServerAuthorityEventLog = 256;
const actorMovementQuantization = 100;
const remoteActorInterpolationResetCells = 12;
const remoteActorInterpolationSampleLimit = 12;
const authoritativeHitFlashMs = 220;
const authoritativeDownedHitFlashMs = 320;
const authorityReconnectBaseMs = 500;
const authorityReconnectMaxMs = 2_500;
const localPlayerWalkPredictionLeadCells = 0.82;
const localPlayerSprintPredictionLeadCells = 0.9;
const localPlayerWalkCorrectionLeadCells = 0.58;
const localPlayerSprintCorrectionLeadCells = 0.65;
const combatVisualCadenceByState = new WeakMap<PlayState, Map<string, CombatVisualCadenceState>>();
const rollBurstAudioOrdinalByState = new WeakMap<PlayState, Map<string, RollBurstAudioOrdinalState>>();
const inventoryFeedbackSfxMinIntervalMs = 900;
const inventoryFeedbackSfxByState = new WeakMap<PlayState, Map<string, number>>();
const inventoryFeedbackVisualMinIntervalMs = 2_500;
const inventoryFeedbackVisualByState = new WeakMap<PlayState, Map<string, number>>();

/**
 * Receipt delivery is at-least-once. Keep a bounded, per-client window so a
 * duplicate cannot replay acknowledgement bookkeeping or presentation effects.
 */
const receiptDedupeByState = new WeakMap<PlayState, Map<number, undefined>>();
const maxRememberedAuthorityReceipts = 512;

export function createGameAuthorityClient(params: CreateGameAuthorityClientParams): GameAuthorityClient {
  const { state, slice, launchIdentity, sfx, getViewInterest, onLaunchFailure } = params;
  const enabled = true;
  state.serverAuthority.enabled = true;

  const endpoint = gameAuthorityColyseusEndpoint(launchIdentity);
  const joinOptions = gameAuthorityJoinOptions(launchIdentity);
  state.serverAuthority.wsUrl = endpoint;
  let room: ColyseusRoom | null = null;
  let reconnectTimer: number | null = null;
  let reconnectAttempt = 0;
  let connectSeq = 0;
  let closed = false;
  const pendingBugReports = new Map<string, {
    resolve: (report: AcceptedBugReport) => void;
    reject: (error: BugReportSubmissionError) => void;
    timeout: number;
  }>();
  const rejectPendingBugReports = (reasonCode: "unavailable" | "connection_lost"): void => {
    for (const pending of pendingBugReports.values()) {
      window.clearTimeout(pending.timeout);
      pending.reject(new BugReportSubmissionError(reasonCode));
    }
    pendingBugReports.clear();
  };
  let resolveInitialSnapshot: (() => void) | null = null;
  const initialSnapshot = new Promise<void>((resolve) => {
    resolveInitialSnapshot = resolve;
  });
  state.serverAuthority.exitWorld = () => {
    if (!room || !room.connection.isOpen) return false;
    // This is an intentional terminal transition, not a transport drop.
    // Fence reconnect before sending so the server's clean close cannot race
    // the ordinary onLeave reconnect path while the host changes characters.
    closed = true;
    connectSeq += 1;
    if (reconnectTimer !== null) {
      window.clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    room.send("exit_world", {});
    return true;
  };

  const clearDisconnectedAuthorityState = () => {
    deferInFlightAuthorityCommand(state.authorityCommands);
    state.serverAuthority.sourceStateHash = null;
    state.serverAuthority.sourceActorCount = null;
    state.serverAuthority.sourceMatchesClient = null;
    state.serverAuthority.playerActorId = null;
    state.serverAuthority.inFlightMoves = [];
    state.serverAuthority.actors = {};
    state.serverAuthority.propStates = {};
    state.serverAuthority.bank = null;
    state.serverAuthority.playerCorpses = [];
    state.serverAuthority.group = { members: [] };
    state.serverAuthority.guilds = { roster: [], pendingInvites: [], directory: [] };
    state.serverAuthority.authoritativePlayer = null;
    state.serverAuthority.lastMoveIssuedAtTick = null;
    state.serverAuthority.visualLog = [];
    state.actorPresentationFrames = {};
  };

  const scheduleReconnect = () => {
    if (closed || reconnectTimer !== null) return;
    const delayMs = Math.min(authorityReconnectMaxMs, authorityReconnectBaseMs * 2 ** reconnectAttempt);
    reconnectAttempt += 1;
    state.serverAuthority.status = "connecting";
    state.status = "server authority reconnecting";
    reconnectTimer = window.setTimeout(() => {
      reconnectTimer = null;
      void connect();
    }, delayMs);
  };

  const connect = async () => {
    if (closed) return;
    const seq = ++connectSeq;
    state.serverAuthority.status = "connecting";
    state.serverAuthority.wsUrl = endpoint;
    try {
      const client = new ColyseusClient(endpoint);
      const nextRoom = await client.joinOrCreate("game", joinOptions);
      if (launchIdentity.standalone) launchIdentity.gameTicket = undefined;
      if (closed || seq !== connectSeq) {
        void nextRoom.leave(true);
        return;
      }
      room = nextRoom;
      reconnectAttempt = 0;
      nextRoom.onMessage("game.packet", (packet) => {
        if (room !== nextRoom) return;
        try {
          const serverPacket = packet as GameServerPacket;
          applyServerPacket(state, slice, serverPacket, sfx);
          if (
            serverPacket.type === "game.hello"
            && state.serverAuthority.authoritativePlayer
            && resolveInitialSnapshot
          ) {
            resolveInitialSnapshot();
            resolveInitialSnapshot = null;
          }
        } catch (error) {
          state.serverAuthority.status = "error";
          state.status = error instanceof Error ? error.message : "server authority packet error";
        }
      });
      nextRoom.onMessage("surveyResult", (payload) => {
        if (room !== nextRoom) return;
        const queue = state.serverAuthority.surveyResults;
        queue.push(payload as ServerAuthoritySurveyResultState);
        // Bounded ring: render clients drain this every frame, while headless
        // consumers may leave it unread, so cap growth defensively.
        if (queue.length > 8) queue.splice(0, queue.length - 8);
      });
      nextRoom.onMessage("craftSession", (payload) => {
        if (room !== nextRoom) return;
        state.serverAuthority.craftSession = cloneCraftSession(payload as ServerAuthorityCraftSessionState);
      });
      nextRoom.onMessage("spliceSession", (payload) => {
        if (room !== nextRoom) return;
        state.serverAuthority.spliceSession = payload
          ? cloneSpliceSession(payload as ServerAuthoritySpliceSessionState)
          : null;
      });
      nextRoom.onMessage("genomeScan", (payload) => {
        if (room !== nextRoom) return;
        state.serverAuthority.genomeScan = payload
          ? cloneGenomeScan(payload as ServerAuthorityGenomeScanState)
          : null;
      });
      nextRoom.onMessage("tradeSession", (payload) => {
        if (room !== nextRoom) return;
        state.serverAuthority.tradeSession = payload
          ? cloneTradeSession(payload as ServerAuthorityTradeSessionState)
          : null;
      });
      nextRoom.onMessage("duelOutcome", (payload) => {
        if (room !== nextRoom) return;
        const queue = state.serverAuthority.duelOutcomes;
        queue.push(payload as ServerAuthorityDuelOutcomeState);
        // Bounded ring: FE (radial/HUD) + probes drain the tail; cap growth.
        if (queue.length > 16) queue.splice(0, queue.length - 16);
      });
      nextRoom.onMessage("bugReportResult", (payload) => {
        if (room !== nextRoom || typeof payload !== "object" || payload === null) return;
        const requestId = "requestId" in payload && typeof payload.requestId === "string"
          ? payload.requestId
          : "";
        const pending = pendingBugReports.get(requestId);
        if (!pending) return;
        const result = bugReportResultForRequest(payload, requestId);
        if (!result) return;
        window.clearTimeout(pending.timeout);
        pendingBugReports.delete(requestId);
        if (result instanceof BugReportSubmissionError) pending.reject(result);
        else pending.resolve(result);
      });
      nextRoom.onLeave((code, reason) => {
        if (room !== nextRoom) return;
        rejectPendingBugReports("connection_lost");
        room = null;
        state.serverAuthority.connected = false;
        state.serverAuthority.status = "disconnected";
        clearDisconnectedAuthorityState();
        const launchFailure = gameAuthorityLaunchFailureForLeave(code, reason ?? "");
        state.status = launchFailure === "session-replaced"
          ? "server authority session replaced"
          : "server authority disconnected";
        if (launchFailure === "session-replaced") {
          closed = true;
          connectSeq += 1;
          if (launchIdentity.standalone) onLaunchFailure?.(launchFailure);
          return;
        }
        scheduleReconnect();
      });
      nextRoom.onError((code, message) => {
        if (room !== nextRoom) return;
        rejectPendingBugReports("connection_lost");
        state.serverAuthority.connected = false;
        state.serverAuthority.status = "error";
        clearDisconnectedAuthorityState();
        state.status = message ?? `server authority error ${code}`;
      });
      state.serverAuthority.connected = true;
      state.serverAuthority.status = "connecting";
      state.status = "server authority connecting";
      const initialViewInterest = getViewInterest?.() ?? null;
      if (initialViewInterest) recordSentViewInterest(state, initialViewInterest);
      nextRoom.send("game.ready", initialViewInterest ?? undefined);
    } catch (error) {
      if (launchIdentity.standalone) {
        launchIdentity.gameTicket = undefined;
        onLaunchFailure?.("game-failed");
      }
      if (closed || seq !== connectSeq) return;
      room = null;
      clearDisconnectedAuthorityState();
      state.serverAuthority.connected = false;
      state.serverAuthority.status = "error";
      state.status = error instanceof Error ? error.message : "server authority join error";
      scheduleReconnect();
    }
  };

  void connect();

  const flush = () => {
    if (!room) {
      deferInFlightAuthorityCommand(state.authorityCommands);
      return 0;
    }
    const viewSent = flushGameAuthorityViewInterest(state, room, getViewInterest);
    return flushGameAuthorityCommands(state, room) + (viewSent ? 1 : 0);
  };
  const interval = window.setInterval(flush, 16);
  const submitBugReport = (report: BugReportSubmission): Promise<AcceptedBugReport> => {
    if (!room || !room.connection.isOpen || !state.serverAuthority.connected) {
      return Promise.reject(new BugReportSubmissionError("unavailable"));
    }
    if (pendingBugReports.has(report.requestId)) {
      return Promise.reject(new BugReportSubmissionError("unavailable"));
    }
    return new Promise<AcceptedBugReport>((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        pendingBugReports.delete(report.requestId);
        reject(new BugReportSubmissionError("unavailable"));
      }, 10_000);
      pendingBugReports.set(report.requestId, { resolve, reject, timeout });
      try {
        room!.send("support.bug-report", report);
      } catch {
        window.clearTimeout(timeout);
        pendingBugReports.delete(report.requestId);
        reject(new BugReportSubmissionError("unavailable"));
      }
    });
  };
  return {
    enabled,
    initialSnapshot,
    flush,
    submitBugReport,
    close: () => {
      closed = true;
      connectSeq += 1;
      rejectPendingBugReports("connection_lost");
      window.clearInterval(interval);
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
      void room?.leave(true);
      room = null;
      clearDisconnectedAuthorityState();
    },
  };
}

export function sendExitWorld(state: PlayState): boolean {
  return state.serverAuthority.exitWorld?.() ?? false;
}


export function gameAuthorityColyseusEndpoint(launchIdentity: LaunchIdentity): string {
  const params = new URLSearchParams(window.location.search);
  const explicit = launchIdentity.gameWsUrl;
  const url = new URL(runtimeGameWsUrl({ gameWsUrl: explicit, searchParams: params }));
  url.protocol = url.protocol.replace("ws", "http");
  url.pathname = "";
  url.search = "";
  url.hash = "";
  return url.toString();
}

export function gameAuthorityWsUrl(launchIdentity: LaunchIdentity): string {
  return gameAuthorityColyseusEndpoint(launchIdentity);
}

export function gameAuthorityJoinOptions(launchIdentity: LaunchIdentity): Record<string, string> {
  if (launchIdentity.standalone) {
    return launchIdentity.gameTicket && launchIdentity.clientReleaseId
      ? { gameTicket: launchIdentity.gameTicket, release: launchIdentity.clientReleaseId }
      : {};
  }
  const params = new URLSearchParams(window.location.search);
  const explicit = launchIdentity.gameWsUrl;
  const url = new URL(runtimeGameWsUrl({ gameWsUrl: explicit, searchParams: params }));
  const actorId = params.get("actorId") ?? params.get("characterId") ?? launchIdentity.characterId ?? launchIdentity.playerId;
  url.searchParams.set("playerId", launchIdentity.playerId);
  url.searchParams.set("displayName", launchIdentity.displayName);
  url.searchParams.set("zoneId", launchIdentity.zoneId);
  url.searchParams.set("actorId", actorId);
  if (launchIdentity.characterId) url.searchParams.set("characterId", launchIdentity.characterId);
  applyGameSpawnParams(url, params, !explicit);
  if (launchIdentity.ticket) url.searchParams.set("ticket", launchIdentity.ticket);
  return Object.fromEntries(url.searchParams.entries());
}

function authoritySourceReadyForCommands(state: Pick<PlayState, "playerActorId" | "serverAuthority">): boolean {
  return state.serverAuthority.sourceMatchesClient === true
    && state.serverAuthority.playerActorId === state.playerActorId;
}


export function flushGameAuthorityViewInterest(
  state: PlayState,
  room: ColyseusRoom,
  getViewInterest?: () => GameAuthorityViewInterest | null,
): boolean {
  if (
    !state.serverAuthority.enabled
    || !state.serverAuthority.connected
    || !authoritySourceReadyForCommands(state)
    || !room.connection.isOpen
    || !getViewInterest
  ) {
    return false;
  }
  const view = getViewInterest();
  if (!view) return false;
  const lastSentAt = state.serverAuthority.lastViewInterestSentAtMs;
  const viewChanged = !sameViewInterest(view, state.serverAuthority.lastViewInterest);
  const refreshDue = lastSentAt === null || state.worldTimeMs - lastSentAt >= 500;
  if (!viewChanged && !refreshDue) return false;
  room.send("game.view", view);
  recordSentViewInterest(state, view);
  return true;
}

export function flushGameAuthorityCommands(state: PlayState, room: ColyseusRoom): number {
  expireStaleInFlightMoves(state, state.worldTimeMs);
  if (!state.serverAuthority.enabled) return 0;
  if (!state.serverAuthority.connected || !room.connection.isOpen) {
    deferInFlightAuthorityCommand(state.authorityCommands);
    return 0;
  }
  if (!authoritySourceReadyForCommands(state) || state.authorityCommands.inFlight !== null) return 0;

  const envelope = orderAuthorityCommandsForFlush(state.authorityCommands.pending)[0];
  if (!envelope) return 0;
  const pendingIndex = state.authorityCommands.pending.findIndex((pending) => pending.command_id === envelope.command_id);
  if (pendingIndex < 0) return 0;
  state.authorityCommands.pending.splice(pendingIndex, 1);
  state.authorityCommands.inFlight = envelope;
  try {
    room.send("game.command", envelope);
  } catch (error) {
    deferInFlightAuthorityCommand(state.authorityCommands);
    throw error;
  }

  const sentCommand: PlayState["serverAuthority"]["sentCommandLog"][number] = {
    commandId: envelope.command_id,
    kind: authorityCommandKind(envelope.command),
    sentAtMs: Number(state.worldTimeMs.toFixed(3)),
    issuedAtTick: envelope.issued_at_tick,
  };
  if ("Move" in envelope.command) {
    sentCommand.dx = envelope.command.Move.dx;
    sentCommand.dy = envelope.command.Move.dy;
    sentCommand.durationTicks = envelope.command.Move.duration_ticks;
    sentCommand.sprint = envelope.command.Move.sprint === true;
  } else if ("SetMoveIntent" in envelope.command) {
    sentCommand.dx = envelope.command.SetMoveIntent.dx;
    sentCommand.dy = envelope.command.SetMoveIntent.dy;
    sentCommand.durationTicks = null;
    sentCommand.sprint = envelope.command.SetMoveIntent.sprint === true;
  } else if ("ToggleDoor" in envelope.command) {
    sentCommand.propId = envelope.command.ToggleDoor.prop_id;
  } else if ("HarvestCorpse" in envelope.command) {
    sentCommand.targetActorId = envelope.command.HarvestCorpse.target_actor_id;
  }
  state.serverAuthority.sentCommandLog.push(sentCommand);
  if (state.serverAuthority.sentCommandLog.length > 256) {
    state.serverAuthority.sentCommandLog.splice(0, state.serverAuthority.sentCommandLog.length - 256);
  }
  if ("Move" in envelope.command) {
    state.serverAuthority.inFlightMoves.push({
      commandId: envelope.command_id,
      dx: envelope.command.Move.dx,
      dy: envelope.command.Move.dy,
      durationTicks: envelope.command.Move.duration_ticks,
      issuedAtTick: envelope.issued_at_tick,
      sprint: envelope.command.Move.sprint === true,
      facing: directionFromAuthorityFacing(envelope.command.Move.facing),
      sentAtMs: state.worldTimeMs,
    });
    if (state.serverAuthority.inFlightMoves.length > 128) {
      state.serverAuthority.inFlightMoves.splice(0, state.serverAuthority.inFlightMoves.length - 128);
    }
  }
  state.serverAuthority.sentCommands += 1;
  return 1;
}

/**
 * Command transmission is priority-ordered, with command id as a stable
 * tiebreaker within a priority class. It is deliberately not global FIFO.
 */
function orderAuthorityCommandsForFlush(commands: readonly AuthorityClientCommandEnvelope[]): AuthorityClientCommandEnvelope[] {
  return [...commands].sort((left, right) => (
    commandPriority(left) - commandPriority(right) || left.command_id - right.command_id
  ));
}

function commandPriority(envelope: AuthorityClientCommandEnvelope): number {
  const kind = authorityCommandKind(envelope.command);
  if (
    kind === "CloneRespawn"
    || kind === "ReviveActor"
    || kind === "UseConsumable"
    || kind === "RefillAmmo"
    || kind === "ApplyServiceBuff"
    || kind === "SampleResource"
    || kind === "HarvestCorpse"
    || kind === "TakeLootItem"
    || kind === "CraftItem"
    || kind === "PurchaseSkillBox"
    || kind === "SetProfessionTitle"
    || kind === "SetCareerGoal"
  ) return 0;
  if (kind === "Move") return 2;
  return 3;
}

function recordSentViewInterest(state: PlayState, view: GameAuthorityViewInterest): void {
  state.serverAuthority.sentViewInterests += 1;
  state.serverAuthority.lastViewInterest = { ...view };
  state.serverAuthority.lastViewInterestSentAtMs = state.worldTimeMs;
}

function sameViewInterest(left: GameAuthorityViewInterest, right: GameAuthorityViewInterest | null): boolean {
  return Boolean(right)
    && (left.area_id ?? "") === (right?.area_id ?? "")
    && left.viewport_width_cells === right?.viewport_width_cells
    && left.viewport_height_cells === right?.viewport_height_cells
    && (left.margin_cells ?? 0) === (right?.margin_cells ?? 0);
}

function recordServerPacketMetrics(state: PlayState, packet: GameServerPacket): void {
  const encoded = JSON.stringify(packet);
  const bytes = encoded.length;
  const type = packet.type;
  const authority = state.serverAuthority;
  authority.receivedPackets += 1;
  authority.receivedBytes += bytes;
  authority.receivedBytesByType[type] = (authority.receivedBytesByType[type] ?? 0) + bytes;
  authority.lastPacketBytes = bytes;
  authority.lastPacketType = type;
  authority.recentInboundBytes.push({ atMs: state.worldTimeMs, bytes });
  while (
    authority.recentInboundBytes.length > 0
    && state.worldTimeMs - authority.recentInboundBytes[0]!.atMs > 5_000
  ) {
    authority.recentInboundBytes.shift();
  }
}

export function applyServerPacket(
  state: PlayState,
  slice: SliceSnapshot,
  packet: GameServerPacket,
  sfx: SfxPlayer,
): void {
  recordServerPacketMetrics(state, packet);
  if (packet.type === "game.error") {
    state.serverAuthority.status = "error";
    state.status = packet.message;
    return;
  }
  if (packet.type === "pong") return;
  if (packet.type === "game.hello") {
    // The hello envelope names the actor that owns this room. Validate it
    // before mutating session/source state or trusting its snapshot.
    if (packet.playerActorId !== state.playerActorId) {
      state.serverAuthority.status = "error";
      state.serverAuthority.sourceMatchesClient = false;
      state.status = authoritySourceMismatchMessage(state, slice, null, null, packet.playerActorId);
      clearMismatchedAuthorityState(state);
      return;
    }
    state.serverAuthority.sessionId = packet.sessionId;
    syncServerClock(state, packet.serverTime);
    applyAuthoritativeSnapshot(state, slice, packet.snapshot, sfx);
    return;
  }
  if (packet.type === "game.delta") {
    const events = packetEvents(packet);
    const eventActorSnapshots = captureCombatEventActorSnapshots(state, events);
    if (applyAuthoritativeDelta(state, slice, packet.delta, sfx)) {
      applyReceipts(state, slice, packet.receipts, sfx);
      for (const event of events) applyCombatEventVisuals(state, event, sfx, eventActorSnapshots);
      applyAbilityQueuePayload(state, packet.abilityQueue, packet.abilityQueueEvents);
      enqueueDialogueDeliveries(state, packet.delta.dialogueDeliveries);
    }
    return;
  }
  if (packet.type === "game.receipts") {
    if (!authoritySourceReadyForCommands(state)) return;
    applyReceipts(state, slice, packet.receipts, sfx);
    for (const event of packetEvents(packet)) applyCombatEventVisuals(state, event, sfx);
    applyAbilityQueuePayload(state, packet.abilityQueue, packet.abilityQueueEvents);
    return;
  }
  if (packet.type === "game.acks") {
    if (!authoritySourceReadyForCommands(state)) return;
    const receipts = packet.acks.map(receiptFromCompact);
    applyReceipts(state, slice, receipts, sfx);
    const ackTick = latestReceiptTick(receipts) ?? state.serverAuthority.snapshotTick;
    if (packet.playerActor) applyAckPlayerActor(state, slice, packet.playerActor, ackTick, sfx);
    else if (packet.playerPosition) applyAckPlayerPosition(state, slice, packet.playerPosition, ackTick);
    for (const event of packetEvents(packet)) applyCombatEventVisuals(state, event, sfx);
    applyAbilityQueuePayload(state, packet.abilityQueue, packet.abilityQueueEvents);
    return;
  }
  if (applyAuthoritativeSnapshot(state, slice, packet.snapshot, sfx)) {
    applyReceipts(state, slice, packet.receipts, sfx);
    for (const event of packetEvents(packet)) applyCombatEventVisuals(state, event, sfx);
    applyAbilityQueuePayload(state, packet.abilityQueue, packet.abilityQueueEvents);
  }
}

export function drainAbilityQueueEvents(state: PlayState): AbilityQueueEvent[] {
  return state.abilityQueue.events.splice(0);
}

function cloneAbilityQueueEntry(entry: AbilityQueueView["entries"][number]): AbilityQueueView["entries"][number] {
  return {
    id: String(entry.id),
    abilityId: String(entry.abilityId),
    iconId: String(entry.iconId),
    class: entry.class,
    ...(entry.targetActorId ? { targetActorId: entry.targetActorId } : {}),
    lifecycle: entry.lifecycle,
    enqueuedAtTick: Number.isFinite(entry.enqueuedAtTick) ? Math.trunc(entry.enqueuedAtTick) : 0,
    ...(typeof entry.readyTick === "number" ? { readyTick: Math.trunc(entry.readyTick) } : {}),
    ...(typeof entry.firedAtTick === "number" ? { firedAtTick: Math.trunc(entry.firedAtTick) } : {}),
    ...(typeof entry.dismissedAtTick === "number" ? { dismissedAtTick: Math.trunc(entry.dismissedAtTick) } : {}),
    ...(entry.reasonCode ? { reasonCode: entry.reasonCode } : {}),
    ...(typeof entry.fireSeq === "number" ? { fireSeq: Math.trunc(entry.fireSeq) } : {}),
  };
}

function cloneAbilityQueueView(view: AbilityQueueView | null | undefined): AbilityQueueView | null {
  if (!view || !Array.isArray(view.entries)) return null;
  return {
    actorId: String(view.actorId),
    nextReadyTick: Number.isFinite(view.nextReadyTick) ? Math.trunc(view.nextReadyTick) : 0,
    entries: view.entries.map(cloneAbilityQueueEntry),
    repeatIntent: view.repeatIntent ? cloneAbilityQueueEntry(view.repeatIntent) : undefined,
  };
}

function cloneAbilityQueueEvent(event: AbilityQueueEvent): AbilityQueueEvent {
  return {
    id: String(event.id),
    lifecycle: event.lifecycle,
    tick: Number.isFinite(event.tick) ? Math.trunc(event.tick) : 0,
    ...(event.reasonCode ? { reasonCode: event.reasonCode } : {}),
    ...(typeof event.fireSeq === "number" ? { fireSeq: Math.trunc(event.fireSeq) } : {}),
    ...(event.abilityId ? { abilityId: event.abilityId } : {}),
    ...(event.iconId ? { iconId: event.iconId } : {}),
  };
}

function applyAbilityQueuePayload(
  state: PlayState,
  view: AbilityQueueView | null | undefined,
  events: AbilityQueueEvent[] | undefined,
): void {
  if (view !== undefined) state.abilityQueue.view = cloneAbilityQueueView(view);
  if (Array.isArray(events) && events.length > 0) {
    state.abilityQueue.events.push(...events.map(cloneAbilityQueueEvent));
  }
}
function enqueueDialogueDeliveries(state: PlayState, deliveries: readonly GameDialogueDelivery[] | undefined): void {
  for (const delivery of deliveries ?? []) {
    if (typeof delivery.actorId !== "string" || typeof delivery.body !== "string" || typeof delivery.speaker !== "string") continue;
    if (!delivery.body.trim() || !delivery.speaker.trim()) continue;
    enqueueSpatialBubble(state, { actorId: delivery.actorId, body: delivery.body, sender: delivery.speaker, own: false });
  }
}

function packetEvents(packet: { events?: GameCombatEvent[]; compactEvents?: GameCompactCombatEvent[] }): GameCombatEvent[] {
  return [
    ...(packet.events ?? []),
    ...(packet.compactEvents ?? []).map(eventFromCompact),
  ];
}

function eventFromCompact([
  id,
  commandId,
  tick,
  shooterActorId,
  targetActorId,
  hitX,
  hitY,
  damage,
  zone,
  previousLifeState,
  lifeState,
  targetLifecycleSeq,
  bleedStackCount,
  lifecycleKind,
  lifecycleFrom,
  lifecycleTo,
  lifecycleCause,
  weaponId,
  ammoTypeId,
  effectKind,
  effectStacks,
  effectThreshold,
  effectRemainingMs,
  originX,
  originY,
  kind,
  attackerActorId,
  actionId,
  hit,
  pool,
  rollMilli,
  toHitMilli,
]: GameCompactCombatEvent): GameCombatEvent {
  return {
    id,
    commandId,
    tick,
    shooterActorId: shooterActorId || attackerActorId || "",
    targetActorId,
    originPoint: originX === undefined || originY === undefined || originX === null || originY === null
      ? undefined
      : { x: originX, y: originY },
    hitPoint: hitX === null || hitY === null ? undefined : { x: hitX, y: hitY },
    damage,
    zone,
    previousLifeState,
    lifeState,
    targetLifecycleSeq,
    bleedStackCount,
    weaponId: weaponId ?? undefined,
    ammoTypeId: ammoTypeId ?? undefined,
    effect: effectKind === "sleep"
      ? {
          kind: "sleep",
          stacks: effectStacks ?? 0,
          threshold: effectThreshold ?? 0,
          remainingMs: effectRemainingMs ?? 0,
        }
      : effectKind === "dodge"
        ? { kind: "dodge" }
        : effectKind === "shield"
          ? {
              kind: "shield",
              stacks: effectStacks ?? 0,
              threshold: effectThreshold ?? 0,
              remainingMs: effectRemainingMs ?? 0,
            }
        : undefined,
    lifecycle: lifecycleKind && lifecycleFrom && lifecycleTo && lifecycleCause
      ? { kind: lifecycleKind, from: lifecycleFrom, to: lifecycleTo, cause: lifecycleCause }
      : undefined,
    kind: typeof kind === "string" && kind.length > 0 ? kind : undefined,
    actionId: typeof actionId === "string" && actionId.length > 0 ? actionId : undefined,
    hit: hit === null || hit === undefined ? undefined : hit === true || hit === 1,
    pool: typeof pool === "string" && pool.length > 0 ? pool : undefined,
    rollMilli: typeof rollMilli === "number" ? rollMilli : undefined,
    toHitMilli: typeof toHitMilli === "number" ? toHitMilli : undefined,
  };
}

function actorSnapshotsFromCompact(compactActors: GameCompactActorSnapshot[]): Record<string, GameActorSnapshot> {
  return Object.fromEntries(compactActors.map((actor) => {
    const snapshot = actorSnapshotFromCompactTuple(actor);
    return [snapshot.id, snapshot];
  }));
}

function actorPatchesFromCompact(compactPatches: GameCompactActorPatch[]): Record<string, GameActorPatch> {
  return Object.fromEntries(compactPatches.map((patch) => {
    const decoded = actorPatchFromCompactTuple(patch);
    return [decoded.id, decoded];
  }));
}

function applyActorRefs(state: PlayState, refs: GameActorNetRef[] | undefined): void {
  for (const [netId, actorId] of refs ?? []) {
    state.serverAuthority.actorNetIds[actorId] = netId;
    state.serverAuthority.actorIdsByNetId[netId] = actorId;
  }
}

function actorPatchFromCompactMove(
  state: PlayState,
  [netId, qx, qy, direction]: GameCompactActorMove,
): GameActorPatch | null {
  const id = state.serverAuthority.actorIdsByNetId[netId];
  if (!id) return null;
  return {
    id,
    x: qx / actorMovementQuantization,
    y: qy / actorMovementQuantization,
    direction: directionFromCompact(direction),
  };
}

function actorSnapshotFromCompactTuple([
  id,
  label,
  areaId,
  x,
  y,
  direction,
  lifeState,
  lifecycleSeq,
  vitals,
  maxVitals,
  bleed,
  statuses,
  factionId,
  socialGroup,
  pvpStatus,
  bodyVanishAtTick,
  respawnAtTick,
  professions,
  activeTitle,
  skillPointsUsed,
  skillPointsCap,
  credits,
  personalShield,
  sprite,
  role,
  playerOrganizationId,
  playerOrganizationTag,
  weapon,
  shotSpreadDegreesMilli,
  posture,
  postureUntilTick,
  combatQueue,
  inCombat,
  cloneSicknessRemainingMs,
  peaceRequested,
  aiAttitude,
  engagementTargetId,
  lootable,
  hasLoot,
  lootRightsActorId,
  bodyVanishTick,
  incapRemainingMs,
  incapCount,
  incapWindowMs,
  displayName,
  linkDead,
  appearance,
  nextSampleTick,
  worn,
  willAutoAggro,
  descriptor,
  sprintRecoveryLocked,
]: GameCompactActorSnapshot): GameActorSnapshot {
  return {
    id,
    label,
    display_name: typeof displayName === "string" && displayName.length > 0 ? displayName : label,
    descriptor: typeof descriptor === "string" ? descriptor : "",
    link_dead: linkDead === 1,
    appearance: normalizeAuthorityActorAppearance(appearance),
    ...(() => {
      const normalizedWorn = Array.isArray(worn) ? normalizeAuthorityActorWorn(worn) : undefined;
      const derivedWornColors = mergeAuthorityActorWornColors(undefined, normalizedWorn);
      return {
        ...(normalizedWorn ? { worn: normalizedWorn } : {}),
        ...(derivedWornColors ? { wornColors: derivedWornColors } : {}),
      };
    })(),
    role: normalizeActorRole(role),
    sprite: normalizeActorSprite(sprite),
    areaId,
    x,
    y,
    direction: directionFromCompact(direction),
    lifeState: lifeStateFromCompact(lifeState),
    lifecycleSeq: typeof lifecycleSeq === "number" ? lifecycleSeq : 1,
    vitals: vitalsFromCompact(vitals),
    maxVitals: vitalsFromCompact(maxVitals),
    bleed: bleedFromCompact(bleed),
    statuses,
    bodyVanishAtTick: typeof bodyVanishAtTick === "number" ? bodyVanishAtTick : undefined,
    respawnAtTick: typeof respawnAtTick === "number" ? respawnAtTick : undefined,
    nextSampleTick: typeof nextSampleTick === "number" ? nextSampleTick : undefined,
    cloneSicknessRemainingMs: typeof cloneSicknessRemainingMs === "number" ? cloneSicknessRemainingMs : 0,
    professions: cloneGameActorProfessions(professions),
    activeTitle: cloneGameActorProfessionTitle(activeTitle),
    skillPointsUsed: typeof skillPointsUsed === "number" ? skillPointsUsed : undefined,
    skillPointsCap: typeof skillPointsCap === "number" ? skillPointsCap : undefined,
    credits: typeof credits === "number" ? credits : undefined,
    shotSpreadDegreesMilli: typeof shotSpreadDegreesMilli === "number" ? shotSpreadDegreesMilli : undefined,
    personalShield: cloneGameActorPersonalShield(personalShield),
    weapon: cloneGameActorWeapon(weapon),
    factionId,
    socialGroup,
    pvpStatus: pvpStatus ?? "none",
    aiAttitude: normalizeActorAiAttitude(aiAttitude),
    willAutoAggro: willAutoAggro === true || willAutoAggro === 1,
    playerOrganizationId,
    playerOrganizationTag,
    posture: actorPostureFromWire(posture),
    postureUntilTick: typeof postureUntilTick === "number" ? postureUntilTick : 0,
    combatQueue: cloneCombatQueue(combatQueue),
    inCombat: inCombat === undefined || inCombat === null ? undefined : inCombat === true || inCombat === 1,
    peaceRequested: peaceRequested === undefined || peaceRequested === null ? false : peaceRequested === true || peaceRequested === 1,
    engagementTargetId: typeof engagementTargetId === "string" && engagementTargetId.length > 0 ? engagementTargetId : undefined,
    lootable: lootable === undefined || lootable === null ? undefined : lootable === true || lootable === 1,
    hasLoot: hasLoot === undefined || hasLoot === null ? undefined : hasLoot === true || hasLoot === 1,
    lootRightsActorId: typeof lootRightsActorId === "string" && lootRightsActorId.length > 0 ? lootRightsActorId : undefined,
    bodyVanishTick: typeof bodyVanishTick === "number" ? bodyVanishTick : undefined,
    incapRemainingMs: typeof incapRemainingMs === "number" ? incapRemainingMs : 0,
    incapCount: typeof incapCount === "number" ? incapCount : 0,
    incapWindowMs: typeof incapWindowMs === "number" ? incapWindowMs : 0,
    mobility: { sprintRecoveryLocked: sprintRecoveryLocked === 1 },
  };
}

function actorPatchFromCompactTuple([
  id,
  areaId,
  x,
  y,
  direction,
  lifeState,
  lifecycleSeq,
  vitals,
  maxVitals,
  bleed,
  statuses,
  bodyVanishAtTick,
  respawnAtTick,
  professions,
  activeTitle,
  skillPointsUsed,
  skillPointsCap,
  credits,
  personalShield,
  label,
  sprite,
  role,
  playerOrganizationId,
  playerOrganizationTag,
  weapon,
  factionId,
  socialGroup,
  pvpStatus,
  shotSpreadDegreesMilli,
  posture,
  postureUntilTick,
  combatQueue,
  inCombat,
  cloneSicknessRemainingMs,
  peaceRequested,
  aiAttitude,
  engagementTargetId,
  lootable,
  hasLoot,
  lootRightsActorId,
  bodyVanishTick,
  incapRemainingMs,
  incapCount,
  incapWindowMs,
  displayName,
  linkDead,
  appearance,
  nextSampleTick,
  worn,
  willAutoAggro,
  descriptor,
  sprintRecoveryLocked,
]: GameCompactActorPatch): GameActorPatch {
  const patch: GameActorPatch = { id };
  if (typeof label === "string" && label.length > 0) patch.label = label;
  if (typeof descriptor === "string") patch.descriptor = descriptor;
  if (sprintRecoveryLocked !== undefined && sprintRecoveryLocked !== null) {
    patch.mobility = { sprintRecoveryLocked: sprintRecoveryLocked === 1 };
  }
  if (typeof sprite === "string" && sprite.length > 0) patch.sprite = sprite;
  if (typeof role === "string" && role.length > 0) patch.role = normalizeActorRole(role);
  if (factionId !== undefined && factionId !== false) patch.factionId = factionId;
  if (socialGroup !== undefined && socialGroup !== false) patch.socialGroup = socialGroup;
  if (pvpStatus !== undefined && pvpStatus !== false) patch.pvpStatus = pvpStatus;
  if (aiAttitude !== undefined) patch.aiAttitude = normalizeActorAiAttitude(aiAttitude) ?? null;
  if (willAutoAggro !== undefined && willAutoAggro !== null) patch.willAutoAggro = willAutoAggro === true || willAutoAggro === 1;
  if (playerOrganizationId !== undefined && playerOrganizationId !== false) patch.playerOrganizationId = playerOrganizationId;
  if (playerOrganizationTag !== undefined && playerOrganizationTag !== false) patch.playerOrganizationTag = playerOrganizationTag;
  if (areaId !== null) patch.areaId = areaId;
  if (x !== null) patch.x = x;
  if (y !== null) patch.y = y;
  if (direction !== null) patch.direction = directionFromCompact(direction);
  if (lifeState !== null) patch.lifeState = lifeStateFromCompact(lifeState);
  if (lifecycleSeq !== null) patch.lifecycleSeq = lifecycleSeq;
  if (vitals !== null) patch.vitals = vitalsFromCompact(vitals);
  if (maxVitals !== null) patch.maxVitals = vitalsFromCompact(maxVitals);
  if (bleed !== null) patch.bleed = bleedFromCompact(bleed);
  if (statuses !== null) patch.statuses = statuses;
  if (typeof bodyVanishAtTick === "number") patch.bodyVanishAtTick = bodyVanishAtTick;
  if (typeof respawnAtTick === "number") patch.respawnAtTick = respawnAtTick;
  if (Array.isArray(professions)) patch.professions = cloneGameActorProfessions(professions);
  if (activeTitle && typeof activeTitle === "object") patch.activeTitle = cloneGameActorProfessionTitle(activeTitle);
  if (typeof skillPointsUsed === "number") patch.skillPointsUsed = skillPointsUsed;
  if (typeof skillPointsCap === "number") patch.skillPointsCap = skillPointsCap;
  if (typeof credits === "number") patch.credits = credits;
  if (typeof shotSpreadDegreesMilli === "number") patch.shotSpreadDegreesMilli = shotSpreadDegreesMilli;
  if (typeof posture === "string") patch.posture = actorPostureFromWire(posture);
  if (typeof postureUntilTick === "number") patch.postureUntilTick = postureUntilTick;
  if (combatQueue !== undefined && combatQueue !== false) patch.combatQueue = combatQueue === null ? null : cloneCombatQueue(combatQueue);
  if (inCombat !== undefined && inCombat !== null) patch.inCombat = inCombat === true || inCombat === 1;
  if (peaceRequested !== undefined && peaceRequested !== null) patch.peaceRequested = peaceRequested === true || peaceRequested === 1;
  if (engagementTargetId !== undefined && engagementTargetId !== false) patch.engagementTargetId = typeof engagementTargetId === "string" && engagementTargetId.length > 0 ? engagementTargetId : null;
  if (lootable !== undefined && lootable !== null) patch.lootable = lootable === true || lootable === 1;
  if (hasLoot !== undefined && hasLoot !== null) patch.hasLoot = hasLoot === true || hasLoot === 1;
  if (lootRightsActorId !== undefined && lootRightsActorId !== false) patch.lootRightsActorId = typeof lootRightsActorId === "string" && lootRightsActorId.length > 0 ? lootRightsActorId : null;
  if (typeof bodyVanishTick === "number") patch.bodyVanishTick = bodyVanishTick;
  if (typeof cloneSicknessRemainingMs === "number") patch.cloneSicknessRemainingMs = cloneSicknessRemainingMs;
  if (typeof incapRemainingMs === "number") patch.incapRemainingMs = incapRemainingMs;
  if (typeof incapCount === "number") patch.incapCount = incapCount;
  if (typeof incapWindowMs === "number") patch.incapWindowMs = incapWindowMs;
  if (typeof nextSampleTick === "number") patch.nextSampleTick = nextSampleTick;
  if (typeof displayName === "string" && displayName.length > 0) patch.display_name = displayName;
  if (linkDead !== undefined && linkDead !== null) patch.link_dead = linkDead === 1;
  if (appearance !== undefined && appearance !== null) patch.appearance = normalizeAuthorityActorAppearance(appearance);
  if (worn !== undefined && worn !== null) patch.worn = normalizeAuthorityActorWorn(worn);
  if (personalShield !== false && personalShield !== undefined) {
    patch.personalShield = cloneGameActorPersonalShield(personalShield);
  }
  if (weapon !== false && weapon !== undefined) {
    patch.weapon = cloneGameActorWeapon(weapon);
  }
  return patch;
}

function normalizeAuthorityActorFace(value: GameActorFaceSnapshot | null | undefined): ServerAuthorityActorFaceState | null {
  if (!value || typeof value !== "object") return null;
  const fields = [value.eyes, value.brows, value.nose, value.mouth, value.eye_color, value.brow_color, value.lip_color];
  if (fields.some((field) => typeof field !== "string" || field.length === 0 || field.length > 33)) return null;
  return {
    eyes: value.eyes,
    brows: value.brows,
    nose: value.nose,
    mouth: value.mouth,
    eye_color: value.eye_color,
    brow_color: value.brow_color,
    lip_color: value.lip_color,
  };
}

function normalizeAuthorityActorAppearance(
  value: GameActorAppearanceSnapshot | ServerAuthorityActorAppearanceState | null | undefined,
  previous?: ServerAuthorityActorAppearanceState,
): ServerAuthorityActorAppearanceState {
  const skin = typeof value?.skin === "string" && /^#[0-9a-f]{6}$/i.test(value.skin)
    ? value.skin.toLowerCase()
    : previous?.skin ?? "#9f6f4d";
  const hair = typeof value?.hair === "string" && value.hair.length > 0 ? value.hair : null;
  const hair_mat = typeof value?.hair_mat === "string" && value.hair_mat.length > 0
    ? value.hair_mat
    : previous?.hair_mat ?? "hair_raven";
  // Absent face field (older wire) keeps the previous face; explicit null blanks it.
  const face = value !== null && value !== undefined && value.face === undefined
    ? previous?.face ?? null
    : normalizeAuthorityActorFace(value?.face);
  return { skin, hair, hair_mat, face };
}

function normalizeAuthorityActorWorn(value: readonly GameActorWornPiece[]): GameActorWornPiece[] {
  const worn: GameActorWornPiece[] = [];
  for (const piece of value) {
    if (!piece || typeof piece.item !== "string" || piece.item.length === 0) continue;
    const colors = Array.isArray(piece.colors)
      ? piece.colors.filter((color): color is string => typeof color === "string" && /^#[0-9a-f]{6}$/iu.test(color)).map((color) => color.toLowerCase())
      : [];
    worn.push({ item: piece.item, colors });
  }
  return worn;
}
function cloneAuthorityActorWornColors(value: Record<string, string[]> | undefined | null): Record<string, string[]> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const next: Record<string, string[]> = {};
  for (const [item, colors] of Object.entries(value)) {
    if (!Array.isArray(colors)) continue;
    next[item] = colors.filter((color): color is string => typeof color === "string").map((color) => color);
  }
  return Object.keys(next).length > 0 ? next : undefined;
}
function wornColorsFromWornPieces(worn: readonly GameActorWornPiece[] | undefined): Record<string, string[]> | undefined {
  if (!Array.isArray(worn) || worn.length === 0) return undefined;
  const next: Record<string, string[]> = {};
  for (const piece of worn) {
    if (!piece || typeof piece.item !== "string" || piece.item.length === 0) continue;
    next[piece.item] = Array.isArray(piece.colors) ? piece.colors.filter((color: unknown): color is string => typeof color === "string") : [];
  }
  return Object.keys(next).length > 0 ? next : undefined;
}
function mergeAuthorityActorWornColors(
  explicit: Record<string, string[]> | undefined | null,
  worn: readonly GameActorWornPiece[] | undefined,
): Record<string, string[]> | undefined {
  const fromMap = cloneAuthorityActorWornColors(explicit);
  const fromWorn = wornColorsFromWornPieces(worn);
  if (!fromMap && !fromWorn) return undefined;
  // Prior map keeps unequipped keys; worn[].colors win for currently equipped pieces.
  return { ...(fromMap ?? {}), ...(fromWorn ?? {}) };
}


function actorPostureFromWire(value: unknown): ActorPosture {
  return value === "kneeling" || value === "kneeling_down" || value === "standing_up"
    ? value
    : "standing";
}

function normalizeActorAiAttitude(value: unknown): ServerAuthorityAiAttitude | undefined {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  return normalized === "passive" || normalized === "alerted" || normalized === "hostile" ? normalized : undefined;
}

function cloneCombatQueue(
  queue: ServerAuthorityCombatQueueState | null | undefined,
): ServerAuthorityCombatQueueState | undefined {
  if (!queue || typeof queue !== "object") return undefined;
  return {
    nextReadyTick: queue.nextReadyTick,
    entries: (queue.entries ?? []).map((entry) => ({
      actionId: entry.actionId,
      targetActorId: entry.targetActorId,
      ...(entry.auto === true ? { auto: true } : {}),
    })),
  };
}

function cloneGameActorProfessions(
  professions: GameActorProfessionSnapshot[] | null | undefined,
): GameActorProfessionSnapshot[] | undefined {
  if (!Array.isArray(professions)) return undefined;
  return professions.map((profession) => ({
    ...profession,
    trackXp: profession.trackXp ? { ...profession.trackXp } : undefined,
    skillBoxes: profession.skillBoxes?.slice(),
  }));
}

function cloneGameActorProfessionTitle(
  title: GameActorProfessionTitleSnapshot | null | undefined,
): GameActorProfessionTitleSnapshot | null {
  if (!title || typeof title !== "object") return null;
  return {
    id: title.id,
    label: title.label,
    skillBoxId: title.skillBoxId,
  };
}

function cloneGameActorPersonalShield(
  personalShield: GameActorPersonalShieldSnapshot | null | undefined | false,
): GameActorPersonalShieldSnapshot | null {
  if (!personalShield || typeof personalShield !== "object") return null;
  const maxChargeMilli = Math.max(1, finiteNumber(personalShield.maxChargeMilli, 1));
  const durabilityCharges = finiteNumber(personalShield.durabilityCharges, 0);
  const maxDurabilityCharges = Math.max(1, finiteNumber(personalShield.maxDurabilityCharges, 1));
  const maxDurabilityMilli = Math.max(
    maxChargeMilli,
    finiteNumber(personalShield.maxDurabilityMilli, maxChargeMilli * maxDurabilityCharges),
  );
  return {
    chargeMilli: finiteNumber(personalShield.chargeMilli, 0),
    maxChargeMilli,
    durabilityMilli: Math.max(0, finiteNumber(personalShield.durabilityMilli, durabilityCharges * maxChargeMilli)),
    maxDurabilityMilli,
    durabilityCharges,
    maxDurabilityCharges,
    rechargeAvailableTick: finiteNumber(personalShield.rechargeAvailableTick, 0),
    rechargeBlocked: personalShield.rechargeBlocked === true,
    lastDamageTick: nullableFiniteNumber(personalShield.lastDamageTick),
    lastBlockTick: nullableFiniteNumber(personalShield.lastBlockTick),
  };
}

function cloneGameActorWeapon(
  weapon: GameActorWeaponSnapshot | null | undefined | false,
): GameActorWeaponSnapshot | null {
  if (!weapon || typeof weapon !== "object") return null;
  return {
    weaponId: normalizeNonEmptyString(weapon.weaponId, "slugthrower"),
    weaponItemId: Math.max(0, finiteNumber(weapon.weaponItemId, 0)),
    weaponVariantId: Math.max(0, finiteNumber(weapon.weaponVariantId, 0)),
    ammoType: normalizeNonEmptyString(weapon.ammoType, "slug_iron"),
    loadedRounds: Math.max(0, finiteNumber(weapon.loadedRounds, 0)),
    magazineSize: Math.max(1, finiteNumber(weapon.magazineSize, 1)),
    reloadUntilTick: Math.max(0, finiteNumber(weapon.reloadUntilTick, 0)),
    reloadRemainingTicks: Math.max(0, finiteNumber(weapon.reloadRemainingTicks, 0)),
    reloadTotalTicks: Math.max(1, finiteNumber(weapon.reloadTotalTicks, 1)),
  };
}

function cloneWeatherSnapshots(weather: GameWeatherSnapshot[]): GameWeatherSnapshot[] {
  return weather.map((snapshot) => ({
    areaId: snapshot.areaId,
    eventType: snapshot.eventType,
    phase: snapshot.phase,
    centerX: finiteNumber(snapshot.centerX, 0),
    centerY: finiteNumber(snapshot.centerY, 0),
    radiusCells: Math.max(0, finiteNumber(snapshot.radiusCells, 0)),
    intensity: Math.min(1, Math.max(0, finiteNumber(snapshot.intensity, 0))),
    magnitude: Math.min(1, Math.max(0, finiteNumber(snapshot.magnitude, 0))),
    phaseEndsAtTick: Math.max(0, Math.trunc(finiteNumber(snapshot.phaseEndsAtTick, 0))),
    resolvesAtTick: Math.max(0, Math.trunc(finiteNumber(snapshot.resolvesAtTick, 0))),
    sweepDirRad: finiteNumber(snapshot.sweepDirRad, 0),
  }));
}

function normalizeNonEmptyString(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : fallback;
}

function normalizeActorSprite(sprite: string | null | undefined): string | null {
  return typeof sprite === "string" && sprite.trim().length > 0 ? sprite.trim() : null;
}

function normalizeActorRole(role: string | null | undefined): string | null {
  return typeof role === "string" && role.trim().length > 0 ? role.trim() : null;
}

function finiteNumber(value: unknown, fallback: number): number {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : fallback;
}

function nullableFiniteNumber(value: unknown): number | null {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : null;
}

function vitalsFromCompact([health, action, spirit]: GameCompactVitals): GameActorSnapshot["vitals"] {
  return { health, action, spirit };
}

function bleedFromCompact([
  active,
  stackCount,
  severity,
  remainingMs,
  healthRate,
  actionRate,
  spiritRate,
]: GameCompactBleed): GameActorSnapshot["bleed"] {
  return {
    active: active === 1,
    stackCount,
    severity,
    remainingMs,
    ratesPerSecond: {
      health: healthRate,
      action: actionRate,
      spirit: spiritRate,
    },
  };
}

function directionFromCompact(direction: GameCompactDirection): Direction {
  return (["front", "right", "back", "left"] as const)[direction] ?? "front";
}

function lifeStateFromCompact(lifeState: GameCompactLifeState): ActorLifeState {
  return (["alive", "downed", "respawning"] as const)[lifeState] ?? "alive";
}

function recordRecentMoveRejection(
  state: Pick<PlayState, "serverAuthority">,
  move: PlayState["serverAuthority"]["inFlightMoves"][number],
  receipt: GameCommandReceipt,
): void {
  const entries = state.serverAuthority.recentMoveRejections;
  if (!entries || entries.length === 0) return;
  const index = (state.serverAuthority.recentMoveRejectionWriteIndex ?? 0) % entries.length;
  const entry = entries[index]!;
  entry.commandId = receipt.commandId;
  entry.reasonCode = receipt.reasonCode ?? "unknown";
  entry.serverTick = receipt.tick;
  entry.dx = move.dx;
  entry.dy = move.dy;
  state.serverAuthority.recentMoveRejectionWriteIndex = (index + 1) % entries.length;
  state.serverAuthority.recentMoveRejectionCount = Math.min(entries.length, (state.serverAuthority.recentMoveRejectionCount ?? 0) + 1);
}

export function expireStaleInFlightMoves(
  state: PlayState,
  nowMs = state.worldTimeMs,
  expiryMs = staleInFlightMoveExpiryMs,
): number {
  const now = Number.isFinite(nowMs) ? nowMs : state.worldTimeMs;
  if (!Number.isFinite(now) || state.serverAuthority.inFlightMoves.length === 0) return 0;
  const maxAgeMs = Number.isFinite(expiryMs) && expiryMs > 0 ? expiryMs : staleInFlightMoveExpiryMs;
  const retained: PlayState["serverAuthority"]["inFlightMoves"] = [];
  const expired: PlayState["serverAuthority"]["inFlightMoves"] = [];
  for (const move of state.serverAuthority.inFlightMoves) {
    const sentAtMs = move.sentAtMs;
    if (typeof sentAtMs === "number" && Number.isFinite(sentAtMs) && now - sentAtMs >= maxAgeMs) {
      expired.push(move);
    } else {
      retained.push(move);
    }
  }
  if (expired.length === 0) return 0;
  state.serverAuthority.inFlightMoves = retained;
  for (const move of expired) {
    recordExpiredMoveReceipt(state, move, now);
  }
  if (
    retained.length === 0
    && state.serverAuthority.lastMoveIssuedAtTick !== null
    && state.serverAuthority.snapshotTick < state.serverAuthority.lastMoveIssuedAtTick
  ) {
    state.serverAuthority.lastMoveIssuedAtTick = Math.max(0, Math.trunc(state.serverAuthority.snapshotTick));
  }
  return expired.length;
}

function recordExpiredMoveReceipt(
  state: Pick<PlayState, "serverAuthority">,
  move: PlayState["serverAuthority"]["inFlightMoves"][number],
  nowMs: number,
): void {
  const receipt: GameCommandReceipt = {
    commandId: move.commandId,
    accepted: false,
    tick: Math.max(0, Math.trunc(state.serverAuthority.snapshotTick)),
    reasonCode: "expired",
  };
  recordRecentMoveRejection(state, move, receipt);
  const lastReceipt: NonNullable<PlayState["serverAuthority"]["lastReceipt"]> = {
    ...receipt,
    receivedAtMs: Number(nowMs.toFixed(3)),
  };
  state.serverAuthority.lastReceipt = lastReceipt;
  state.serverAuthority.receiptLog.push(lastReceipt);
  if (state.serverAuthority.receiptLog.length > 128) {
    state.serverAuthority.receiptLog.splice(0, state.serverAuthority.receiptLog.length - 128);
  }
}

function applyReceipts(state: PlayState, slice: SliceSnapshot, receipts: GameCommandReceipt[], sfx?: SfxPlayer): void {
  const settledCommandIds = new Set<number>();
  for (const receipt of receipts) {
    const sentCommand = state.serverAuthority.sentCommandLog.find((entry) => entry.commandId === receipt.commandId);
    const receiptMove = state.serverAuthority.inFlightMoves.find((candidate) => candidate.commandId === receipt.commandId);
    const inFlightEnvelope = state.authorityCommands.inFlight?.command_id === receipt.commandId;
    const receiptHasAuthoritativeFireDebug = receipt.fireDebug !== undefined;
    // Receipts have no actor/source payload of their own, so accept them only
    // after packet source validation and only for a command we have sent or
    // explicitly marked in flight. Fire debug is authority-produced telemetry
    // and may arrive after the client has pruned its local command history;
    // it is admissible but never settles an unrelated queued command.
    if ((!sentCommand && !receiptMove && !inFlightEnvelope && !receiptHasAuthoritativeFireDebug) || receiptDedupeByState.get(state)?.has(receipt.commandId)) continue;
    rememberAuthorityReceipt(state, receipt.commandId);

    const sentMovement = sentCommand?.kind === "Move" || sentCommand?.kind === "SetMoveIntent" ? sentCommand : undefined;
    // LATE receipts: the in-flight entry may already be gone (2s expiry, or
    // a receipt the shard emitted on an error path after we aged the entry
    // out). The sentCommandLog is the durable record of what we sent — a
    // Move receipt still corrects the observed authority tick used by probes
    // and by subsequent current-tick estimates.
    const receiptWasMove = receiptMove !== undefined || sentMovement?.kind === "Move";
    const receiptWasMovementCommand = receiptWasMove || sentMovement?.kind === "SetMoveIntent";
    const receiptTick = Number.isFinite(receipt.tick) ? Math.max(0, Math.trunc(receipt.tick)) : null;
    if (receiptTick !== null && receiptTick >= state.serverAuthority.snapshotTick) {
      state.serverAuthority.snapshotTick = receiptTick;
      state.serverAuthority.lastSnapshotReceivedAtMs = Number(state.worldTimeMs.toFixed(3));
    }
    if (receiptWasMove && receiptTick !== null) {
      // The client stamps move commands from a projected authority clock; the
      // Rust shard clamps unusable future issued_at_tick values back to its
      // current tick before applying cooldown. Trust the receipt's applied tick
      // for every Move outcome so diagnostics and subsequent current-tick
      // estimates follow the authority, not stale optimism.
      state.serverAuthority.lastMoveIssuedAtTick = Math.max(receiptTick, state.serverAuthority.snapshotTick);
    }
    const settledQueueCommand = (sentCommand || receiptMove || inFlightEnvelope)
      ? settleAuthorityCommand(state.authorityCommands, receipt.commandId)
      : false;
    if (receiptMove || settledQueueCommand) {
      settledCommandIds.add(receipt.commandId);
    }
    applyAcceptedMoveReceiptToAuthoritativeMirror(state, slice, receipt);
    applyAcceptedCommandAudioHooks(state, slice, receipt, sentCommand, sfx);
    const lastReceipt: PlayState["serverAuthority"]["lastReceipt"] = {
      commandId: receipt.commandId,
      accepted: receipt.accepted,
      tick: receipt.tick,
      reasonCode: receipt.reasonCode,
      receivedAtMs: Number(state.worldTimeMs.toFixed(3)),
    };
    if (receipt.fireDebug) lastReceipt.fireDebug = receipt.fireDebug;
    state.serverAuthority.lastReceipt = lastReceipt;
    state.serverAuthority.receiptLog.push(lastReceipt);
    if (state.serverAuthority.receiptLog.length > 128) {
      state.serverAuthority.receiptLog.splice(0, state.serverAuthority.receiptLog.length - 128);
    }
    if (receipt.accepted) state.serverAuthority.acceptedCommands += 1;
    else {
      state.serverAuthority.rejectedCommands += 1;
      if (receiptMove) recordRecentMoveRejection(state, receiptMove, receipt);
    }
    if (receiptWasMovementCommand && successorMoveTraceEnabled()) {
      const pendingMoves = (state.authorityCommands?.pending ?? [])
        .filter((envelope) => "Move" in envelope.command || "SetMoveIntent" in envelope.command)
        .length;
      recordSuccessorMoveTrace({
        kind: "command-acked",
        worldTimeMs: Number(state.worldTimeMs.toFixed(3)),
        commandId: receipt.commandId,
        accepted: receipt.accepted,
        reasonCode: receipt.reasonCode ?? null,
        ackTick: receipt.tick,
        snapshotTick: state.serverAuthority.snapshotTick,
        sentAtMs: sentMovement?.sentAtMs ?? null,
        latencyMs: sentMovement ? Number((state.worldTimeMs - sentMovement.sentAtMs).toFixed(3)) : null,
        issuedAtTick: sentMovement?.issuedAtTick ?? null,
        dx: receiptMove?.dx ?? sentMovement?.dx ?? null,
        dy: receiptMove?.dy ?? sentMovement?.dy ?? null,
        durationTicks: receiptMove?.durationTicks ?? sentMovement?.durationTicks ?? null,
        sprint: receiptMove?.sprint ?? sentMovement?.sprint ?? null,
        pendingMoves,
        inFlightMoves: state.serverAuthority.inFlightMoves.length,
        predictionErrorCells: state.serverAuthority.predictionErrorCells,
      });
    }
  }
  if (settledCommandIds.size > 0) {
    state.serverAuthority.inFlightMoves = state.serverAuthority.inFlightMoves
      .filter((move) => !settledCommandIds.has(move.commandId));
  }
}


function rememberAuthorityReceipt(state: PlayState, commandId: number): void {
  let receipts = receiptDedupeByState.get(state);
  if (!receipts) {
    receipts = new Map();
    receiptDedupeByState.set(state, receipts);
  }
  receipts.set(commandId, undefined);
  if (receipts.size <= maxRememberedAuthorityReceipts) return;
  const oldestCommandId = receipts.keys().next().value;
  if (oldestCommandId !== undefined) receipts.delete(oldestCommandId);
}

function applyAcceptedCommandAudioHooks(
  state: PlayState,
  slice: SliceSnapshot,
  receipt: GameCommandReceipt,
  sentCommand: PlayState["serverAuthority"]["sentCommandLog"][number] | undefined,
  sfx?: SfxPlayer,
): void {
  if (!receipt.accepted || !sentCommand) return;
  if (sentCommand.kind === "SampleResource" || sentCommand.kind === "SurveyResource") armSurveyPullLoop(state, slice);
  if (sentCommand.kind === "ToggleDoor" && sentCommand.propId) playDoorSlideFeedback(state, slice, sentCommand.propId, sfx);
  if (sentCommand.kind === "HarvestCorpse" && sentCommand.targetActorId) applyAcceptedHarvestCorpseFeedback(state, slice, sentCommand.targetActorId, sfx);
}

function applyAcceptedHarvestCorpseFeedback(
  state: PlayState,
  slice: SliceSnapshot,
  targetActorId: string,
  sfx?: SfxPlayer,
): void {
  const serverActor = state.serverAuthority.actors[targetActorId];
  const sliceActor = (slice.actors || []).find((candidate) => candidate.id === targetActorId);
  const areaId = serverActor ? serverActor.areaId : sliceActor?.areaId;
  if (areaId !== state.activeAreaId) return;

  const pos: { x: number; y: number } | null = serverActor
    ? { x: serverActor.x, y: serverActor.y }
    : sliceActor
      ? sliceActor.cell
      : null;
  if (!pos) return;

  spawnFloatingStatusText(state, pos, "HARVESTED", "#a3be8c", targetActorId);

  if (sfx) {
    sfx.playAt("inventory_transfer", { x: pos.x + 0.5, y: pos.y + 0.5 }, {
      volume: 0.5,
      minDistanceCells: 2,
      maxDistanceCells: 24,
      rolloff: 1.8,
      farGainFloor: 0,
      panDistanceCells: 8,
    });
  }
}

function armSurveyPullLoop(state: PlayState, slice: SliceSnapshot): void {
  const tickRateHz = Math.max(1, Math.trunc(slice.tickRateHz || 30));
  const durationMs = Math.ceil((resourceSamplePullLoopTicks / tickRateHz) * 1000);
  const startedAtMs = Number.isFinite(state.worldTimeMs) ? state.worldTimeMs : 0;
  const activeUntilMs = startedAtMs + durationMs;
  state.runtimeAudio.surveyPullLoopUntilMs = Math.max(state.runtimeAudio.surveyPullLoopUntilMs ?? -Infinity, activeUntilMs);
}



function latestReceiptTick(receipts: GameCommandReceipt[]): number | undefined {
  let tick: number | undefined;
  for (const receipt of receipts) {
    if (!Number.isFinite(receipt.tick)) continue;
    tick = tick === undefined ? receipt.tick : Math.max(tick, receipt.tick);
  }
  return tick;
}

function applyAckPlayerActor(state: PlayState, slice: SliceSnapshot, actor: GameActorSnapshot, tick?: number, sfx?: SfxPlayer): void {
  const previous = state.serverAuthority.actors[actor.id];
  emitAuthoritativeActorAttitudeFeedback(state, previous, actor);
  emitAuthoritativeActorMedicalFeedback(state, previous, actor, sfx);
  state.serverAuthority.actors[actor.id] = toRuntimeActor(actor, previous, state.worldTimeMs, tick);
  applyAuthoritativeActors(state, slice, actor.id, { [actor.id]: actor }, sfx);
  reconcileLocalPlayerFromMoveAck(state, slice, actor.id);
}

function applyAckPlayerPosition(state: PlayState, slice: SliceSnapshot, ack: GamePlayerPositionAck, tick?: number): void {
  const actorId = state.serverAuthority.playerActorId ?? state.playerActorId;
  const previous = state.serverAuthority.actors[actorId];
  if (!previous) return;
  const actor = actorSnapshotFromPatch(previous, {
    id: actorId,
    x: ack[0],
    y: ack[1],
  });
  state.serverAuthority.actors[actorId] = toRuntimeActor(actor, previous, state.worldTimeMs, tick);
  applyAuthoritativeActors(state, slice, actorId, { [actorId]: actor });
  reconcileLocalPlayerFromMoveAck(state, slice, actorId);
}

function reconcileLocalPlayerFromMoveAck(state: PlayState, slice: SliceSnapshot, actorId: string): void {
  const playerActorId = state.serverAuthority.playerActorId ?? state.playerActorId;
  if (actorId !== playerActorId) return;
  const authoritative = state.serverAuthority.actors[playerActorId];
  if (!authoritative || authoritative.areaId !== state.activeAreaId) return;
  const target = replayPendingMoveInputsFromAuthority(state, slice, {
    x: authoritative.x,
    y: authoritative.y,
  });
  state.serverAuthority.authoritativePlayer = { x: authoritative.x, y: authoritative.y };
  state.serverAuthority.predictionTarget = target;
  const dx = target.x - state.player.x;
  const dy = target.y - state.player.y;
  const distance = Math.hypot(dx, dy);
  if (distance <= 0.015) return;
  if (!state.moving || distance > 2.25) {
    state.player = target;
    return;
  }
  const correction = movingAckCorrection(state, {
    authoritative: { x: authoritative.x, y: authoritative.y },
    target,
  });
  const correctionDistance = Math.hypot(correction.x, correction.y);
  if (correctionDistance <= 0.015) return;
  const maxAckStepCells = 0.02;
  const scale = Math.min(1, maxAckStepCells / correctionDistance);
  state.player = {
    x: state.player.x + correction.x * scale,
    y: state.player.y + correction.y * scale,
  };
}

function replayPendingMoveInputsFromAuthority(
  state: PlayState,
  slice: SliceSnapshot,
  authoritative: Point,
): Point {
  const area = currentArea(slice, state);
  let target = { ...authoritative };
  const moves = [
    ...state.serverAuthority.inFlightMoves,
    ...pendingQueuedMoveInputs(state),
  ];
  for (const move of moves) {
    const distance = authorityMovementDistanceCells(playerAuthorityActor(state), playerCombatActor(state), move.durationTicks, slice.tickRateHz, move.sprint);
    const delta = movementDeltaForDistance(move.dx, move.dy, distance);
    target = moveIfUnblocked(target, area, state.blocked, {
      x: target.x + delta.x,
      y: target.y + delta.y,
    }, state.movementBlockers);
  }
  if (moves.length > 0 || !state.moving) {
    return capAckPredictionLeadFromAuthority(authoritative, target, moves.some((move) => move.sprint));
  }
  const currentInput = currentMoveInput(state, slice);
  if (!currentInput) return target;
  const distance = authorityMovementDistanceCells(playerAuthorityActor(state), playerCombatActor(state), currentInput.durationTicks, slice.tickRateHz, currentInput.sprint);
  const delta = movementDeltaForDistance(currentInput.dx, currentInput.dy, distance);
  const speculative = moveIfUnblocked(target, area, state.blocked, {
    x: target.x + delta.x,
    y: target.y + delta.y,
  }, state.movementBlockers);
  return capAckPredictionLeadFromAuthority(
    authoritative,
    capAckPredictionTargetToLocalPlayer(state, speculative),
    currentInput.sprint,
  );
}

function pendingQueuedMoveInputs(state: PlayState): PlayState["serverAuthority"]["inFlightMoves"] {
  return (state.authorityCommands?.pending ?? []).flatMap((envelope) => {
    if (!("Move" in envelope.command)) return [];
    return [{
      commandId: envelope.command_id,
      dx: envelope.command.Move.dx,
      dy: envelope.command.Move.dy,
      durationTicks: envelope.command.Move.duration_ticks,
      issuedAtTick: envelope.issued_at_tick,
      sprint: envelope.command.Move.sprint === true,
      facing: directionFromAuthorityFacing(envelope.command.Move.facing),
      sentAtMs: null,
    }];
  });
}

function currentMoveInput(
  state: PlayState,
  slice: SliceSnapshot,
): PlayState["serverAuthority"]["inFlightMoves"][number] | null {
  const vector = movementVectorFromKeys(movementInputKeys(state), state.movementInputMode);
  if (vector.x === 0 && vector.y === 0) return null;
  const durationTicks = authorityMoveIntentDurationTicks(slice.tickRateHz);
  const sprint = sprintCorrectionEligible(state);
  return {
    commandId: 0,
    dx: Math.sign(vector.x),
    dy: Math.sign(vector.y),
    durationTicks,
    sprint,
    facing: state.facing,
    sentAtMs: null,
  };
}

function sprintRequestedFromKeys(keys: Iterable<string>): boolean {
  for (const key of keys) {
    if (isSprintKey(key)) return true;
  }
  return false;
}

function capAckPredictionTargetToLocalPlayer(state: PlayState, target: Point): Point {
  const vector = movementVectorFromKeys(movementInputKeys(state), state.movementInputMode);
  const capped = { ...target };
  if (vector.x !== 0 && (capped.x - state.player.x) * vector.x > 0) capped.x = state.player.x;
  if (vector.y !== 0 && (capped.y - state.player.y) * vector.y > 0) capped.y = state.player.y;
  return capped;
}

function capAckPredictionLeadFromAuthority(
  authoritative: Point,
  target: Point,
  sprintLeadEligible: boolean,
): Point {
  const dx = target.x - authoritative.x;
  const dy = target.y - authoritative.y;
  const distance = Math.hypot(dx, dy);
  const maxLeadCells = sprintLeadEligible ? localPlayerSprintPredictionLeadCells : localPlayerWalkPredictionLeadCells;
  if (distance <= maxLeadCells || distance <= 0.001) return target;
  const scale = maxLeadCells / distance;
  return {
    x: authoritative.x + dx * scale,
    y: authoritative.y + dy * scale,
  };
}

function movingAckCorrection(
  state: Pick<PlayState, "actors" | "keys" | "movementInputMode" | "movementKeyOrder" | "player" | "playerActorId" | "worldClock">,
  positions: { authoritative: Point; target: Point },
): Point {
  const vector = movementVectorFromKeys(movementInputKeys(state), state.movementInputMode);
  const targetError = {
    x: positions.target.x - state.player.x,
    y: positions.target.y - state.player.y,
  };
  if (vector.x === 0 && vector.y === 0) return targetError;

  const authoritativeError = {
    x: positions.authoritative.x - state.player.x,
    y: positions.authoritative.y - state.player.y,
  };
  const targetParallel = targetError.x * vector.x + targetError.y * vector.y;
  const authoritativeParallel = authoritativeError.x * vector.x + authoritativeError.y * vector.y;
  const perpendicular = {
    x: targetError.x - targetParallel * vector.x,
    y: targetError.y - targetParallel * vector.y,
  };
  const perpendicularDistance = Math.hypot(perpendicular.x, perpendicular.y);
  const permittedPredictionLeadCells = sprintCorrectionEligible(state)
    ? localPlayerSprintCorrectionLeadCells
    : localPlayerWalkCorrectionLeadCells;
  const excessiveLeadCells = targetParallel < -permittedPredictionLeadCells
    ? targetParallel + permittedPredictionLeadCells
    : 0;
  const authorityAheadCells = authoritativeParallel > 0.08 ? authoritativeParallel : 0;
  const parallelCorrection = excessiveLeadCells < -0.08 || authorityAheadCells > 0
    ? excessiveLeadCells + authorityAheadCells
    : 0;

  return {
    x: (perpendicularDistance > 0.045 ? perpendicular.x : 0) + parallelCorrection * vector.x,
    y: (perpendicularDistance > 0.045 ? perpendicular.y : 0) + parallelCorrection * vector.y,
  };
}

function sprintCorrectionEligible(
  state: Pick<PlayState, "actors" | "keys" | "playerActorId" | "worldClock"> & Partial<Pick<PlayState, "serverAuthority">>,
): boolean {
  if (!sprintRequestedFromKeys(state.keys)) return false;
  const tickRateHz = state.worldClock.config.tickRateHz;
  return authorityActorCanSprint(
    playerAuthorityActor(state),
    playerCombatActor(state),
    1,
    tickRateHz,
  );
}

function playerAuthorityActor(
  state: Pick<PlayState, "playerActorId"> & Partial<Pick<PlayState, "serverAuthority">>,
): ServerAuthorityActorState | null {
  const actorId = state.serverAuthority?.playerActorId ?? state.playerActorId;
  return state.serverAuthority?.actors[actorId] ?? null;
}

function playerCombatActor(
  state: Pick<PlayState, "actors" | "playerActorId"> & Partial<Pick<PlayState, "serverAuthority">>,
): PlayState["actors"][string] | null {
  const actorId = state.serverAuthority?.playerActorId ?? state.playerActorId;
  return state.actors[actorId] ?? state.actors[state.playerActorId] ?? null;
}

function applyAcceptedMoveReceiptToAuthoritativeMirror(
  state: PlayState,
  slice: SliceSnapshot,
  receipt: GameCommandReceipt,
): void {
  if (!receipt.accepted) return;
  const playerActorId = state.serverAuthority.playerActorId ?? state.playerActorId;
  const actor = state.serverAuthority.actors[playerActorId];
  if (!actor || actor.areaId !== state.activeAreaId) return;
  const move = state.serverAuthority.inFlightMoves.find((candidate) => candidate.commandId === receipt.commandId);
  if (!move) return;
  const area = currentArea(slice, state);
  const distance = authorityMovementDistanceCells(playerAuthorityActor(state), playerCombatActor(state), move.durationTicks, slice.tickRateHz, move.sprint);
  const delta = movementDeltaForDistance(move.dx, move.dy, distance);
  const next = moveIfUnblocked({ x: actor.x, y: actor.y }, area, state.blocked, {
    x: actor.x + delta.x,
    y: actor.y + delta.y,
  }, state.movementBlockers);
  actor.x = next.x;
  actor.y = next.y;
  actor.direction = move.facing ?? directionFromMoveDelta(move.dx, move.dy, actor.direction);
  state.serverAuthority.authoritativePlayer = { x: actor.x, y: actor.y };
}

function movementDeltaForDistance(dx: number, dy: number, distance: number): { x: number; y: number } {
  const length = Math.hypot(dx, dy);
  if (length <= 0.001 || distance <= 0) return { x: 0, y: 0 };
  const scale = distance / length;
  return { x: dx * scale, y: dy * scale };
}

function directionFromMoveDelta(dx: number, dy: number, fallback: Direction): Direction {
  return directionFromVector(dx, dy, fallback);
}

function directionFromAuthorityFacing(facing: AuthorityCardinalDirection | undefined): Direction | undefined {
  switch (facing) {
    case "Front":
      return "front";
    case "Right":
      return "right";
    case "Back":
      return "back";
    case "Left":
      return "left";
    default:
      return undefined;
  }
}

function receiptFromCompact([commandId, accepted, tick, reasonCode]: GameCompactReceipt): GameCommandReceipt {
  return {
    commandId,
    accepted: accepted === 1,
    tick,
    reasonCode,
  };
}

export function applyAuthoritativeDelta(
  state: PlayState,
  slice: SliceSnapshot,
  delta: GameShardDelta,
  sfx?: SfxPlayer,
): boolean {
  state.serverAuthority.snapshotTick = delta.tick;
  state.serverAuthority.lastSnapshotReceivedAtMs = Number(state.worldTimeMs.toFixed(3));
  state.serverAuthority.receivedSnapshots += 1;
  if (!applyAuthoritySourceMetadata(state, slice, delta, true)) {
    clearMismatchedAuthorityState(state);
    return false;
  }
  state.worldClock = applyWorldClockSnapshot(state.worldClock, delta.worldClock, state.worldTimeMs);
  if (delta.weather) state.weather = cloneWeatherSnapshots(delta.weather);
  state.serverAuthority.playerActorId = delta.playerActorId;
  applyAuthorityBankProjection(state, delta.bank, delta.playerCorpses, false);
  applyAuthorityInventory(state, delta.inventory, delta.reservations, delta.resourceSpawns, delta.placedExtractors, delta.placedCamps, delta.placedParcels, delta.farmPlots, delta.draftedSchematics, delta.craftSession, sfx);
  applyAuthorityBuilding(state, delta.building, false);
  applyAuthorityGroups(state, delta.groups);
  applyAuthorityGuilds(state, delta.guilds);
  applyAuthorityDuels(state, delta.duels);
  applyAuthorityPropStates(state, slice, delta.propStates, false, sfx);
  applyAbilityQueuePayload(state, delta.abilityQueue, delta.abilityQueueEvents);
  applyActorRefs(state, delta.actorRefs);
  const removedActorIds = new Set(delta.actorRemovals ?? []);
  for (const actorId of removedActorIds) {
    removeAuthorityActorState(state, actorId, delta.playerActorId);
  }
  const changedActors: Record<string, GameActorSnapshot> = {};
  const deltaActors = {
    ...delta.actors,
    ...actorSnapshotsFromCompact(delta.compactActors ?? []),
  };
  for (const [id, actor] of Object.entries(deltaActors)) {
    if (removedActorIds.has(id)) continue;
    if (isStaleActorGeneration(state, id, actor)) continue;
    if (dropRespawningAuthorityActor(state, id, actor, delta.playerActorId, removedActorIds)) continue;
    const previous = state.serverAuthority.actors[id];
    emitAuthoritativeActorCreditsFeedback(state, previous, actor, sfx);
    emitAuthoritativeActorAttitudeFeedback(state, previous, actor);
    emitAuthoritativeActorMedicalFeedback(state, previous, actor, sfx);
    state.serverAuthority.actors[id] = toRuntimeActor(actor, previous, state.worldTimeMs, delta.tick);
    changedActors[id] = actor;
  }
  const deltaActorPatches: Record<string, GameActorPatch> = {
    ...(delta.actorPatches ?? {}),
    ...actorPatchesFromCompact(delta.compactActorPatches ?? []),
  };
  for (const move of delta.compactActorMoves ?? []) {
    const patch = actorPatchFromCompactMove(state, move);
    if (patch && !removedActorIds.has(patch.id)) deltaActorPatches[patch.id] = patch;
  }
  for (const [id, patch] of Object.entries(deltaActorPatches)) {
    if (removedActorIds.has(id)) continue;
    const previous = state.serverAuthority.actors[id];
    const actor = previous ? actorSnapshotFromPatch(previous, patch) : null;
    if (!actor) continue;
    if (isStaleActorGeneration(state, id, actor)) continue;
    if (dropRespawningAuthorityActor(state, id, actor, delta.playerActorId, removedActorIds)) continue;
    emitAuthoritativeActorCreditsFeedback(state, previous, actor, sfx);
    emitAuthoritativeActorAttitudeFeedback(state, previous, actor);
    emitAuthoritativeActorMedicalFeedback(state, previous, actor, sfx);
    state.serverAuthority.actors[id] = toRuntimeActor(actor, previous, state.worldTimeMs, delta.tick);
    changedActors[id] = actor;
  }
  syncAuthoritativePlayerLoadout(state);
  applyAuthoritativeActors(state, slice, delta.playerActorId, changedActors, sfx);
  clearNonAuthoritativePresentationFrames(state);
  return true;
}

export function applyAuthoritativeSnapshot(
  state: PlayState,
  slice: SliceSnapshot,
  snapshot: GameShardSnapshot,
  sfx?: SfxPlayer,
): boolean {
  state.serverAuthority.snapshotTick = snapshot.tick;
  state.serverAuthority.lastSnapshotReceivedAtMs = Number(state.worldTimeMs.toFixed(3));
  state.serverAuthority.receivedSnapshots += 1;
  if (!applyAuthoritySourceMetadata(state, slice, snapshot)) {
    clearMismatchedAuthorityState(state);
    return false;
  }
  state.worldClock = applyWorldClockSnapshot(state.worldClock, snapshot.worldClock, state.worldTimeMs);
  state.weather = cloneWeatherSnapshots(snapshot.weather ?? []);
  state.serverAuthority.playerActorId = snapshot.playerActorId;
  applyAuthorityBankProjection(state, snapshot.bank, snapshot.playerCorpses, true);
  applyAuthorityInventory(state, snapshot.inventory, snapshot.reservations, snapshot.resourceSpawns, snapshot.placedExtractors, snapshot.placedCamps, snapshot.placedParcels, snapshot.farmPlots, snapshot.draftedSchematics, snapshot.craftSession, sfx);
  applyAuthorityBuilding(state, snapshot.building, true);
  applyAuthorityGroups(state, snapshot.groups);
  applyAuthorityGuilds(state, snapshot.guilds);
  applyAuthorityDuels(state, snapshot.duels);
  applyAuthorityPropStates(state, slice, snapshot.propStates, true, sfx);
  applyAbilityQueuePayload(state, snapshot.abilityQueue, snapshot.abilityQueueEvents);
  state.serverAuthority.actorNetIds = {};
  state.serverAuthority.actorIdsByNetId = {};
  applyActorRefs(state, snapshot.actorRefs);
  const snapshotActors = Object.fromEntries(
    Object.entries(snapshot.actors)
      .filter(([id, actor]) => id === snapshot.playerActorId || actor.lifeState !== "respawning"),
  );
  for (const [id, actor] of Object.entries(snapshot.actors)) {
    if (id !== snapshot.playerActorId && actor.lifeState === "respawning") removeAuthorityActorState(state, id, snapshot.playerActorId);
  }
  const previousAuthorityActors = state.serverAuthority.actors;
  for (const [id, actor] of Object.entries(snapshotActors)) {
    emitAuthoritativeActorCreditsFeedback(state, previousAuthorityActors[id], actor, sfx);
    emitAuthoritativeActorAttitudeFeedback(state, previousAuthorityActors[id], actor);
    emitAuthoritativeActorMedicalFeedback(state, previousAuthorityActors[id], actor, sfx);
  }
  state.serverAuthority.actors = Object.fromEntries(
    Object.entries(snapshotActors).map(([id, actor]) => [
      id,
      toRuntimeActor(actor, previousAuthorityActors[id], state.worldTimeMs, snapshot.tick),
    ]),
  );
  syncAuthoritativePlayerLoadout(state);
  applyAuthoritativeActors(state, slice, snapshot.playerActorId, snapshotActors, sfx);
  clearNonAuthoritativePresentationFrames(state);
  return true;
}

function applyAuthorityBankProjection(
  state: PlayState,
  bank: ServerAuthorityBankState | null | undefined,
  playerCorpses: ServerAuthorityPlayerCorpseState[] | undefined,
  replace: boolean,
): void {
  if (bank !== undefined) {
    state.serverAuthority.bank = bank
      ? {
          ...bank,
          items: bank.items.map((row) => ({
            ...row,
            metadata: row.metadata ? { ...row.metadata } : undefined,
            colors: row.colors ? [...row.colors] : undefined,
          })),
        }
      : null;
  } else if (replace) {
    state.serverAuthority.bank = null;
  }
  if (Array.isArray(playerCorpses)) {
    state.serverAuthority.playerCorpses = playerCorpses.map((corpse) => ({ ...corpse }));
  } else if (replace) {
    state.serverAuthority.playerCorpses = [];
  }
}

function applyAuthorityInventory(
  state: PlayState,
  inventory: InventoryRow[] | undefined,
  reservations: ReservationRow[] | undefined,
  resourceSpawns: ServerAuthorityResourceSpawnState[] | undefined,
  placedExtractors: ServerAuthorityPlacedExtractorState[] | undefined,
  placedCamps: ServerAuthorityPlacedCampState[] | undefined,
  placedParcels: ServerAuthorityParcelState[] | undefined,
  farmPlots: ServerAuthorityFarmPlotState[] | undefined,
  draftedSchematics: ServerAuthorityDraftedSchematicState[] | undefined,
  craftSession: ServerAuthorityCraftSessionState | null | undefined,
  sfx?: SfxPlayer,
): void {
  if (Array.isArray(inventory)) {
    const visibleInventory = inventory.filter((row) => Number(row.quantity) > 0);
    applyAuthorityInventoryFeedback(state, visibleInventory, sfx);
    state.inventory = visibleInventory.map((row) => ({ ...row }));
    syncAuthoritativePlayerLoadout(state);
  }
  if (Array.isArray(reservations)) state.reservations = reservations.map((row) => ({ ...row }));
  if (Array.isArray(resourceSpawns)) {
    state.serverAuthority.resourceSpawns = resourceSpawns.map((spawn) => ({
      ...spawn,
      stats: { ...spawn.stats },
    }));
  }
  if (Array.isArray(placedExtractors)) {
    state.serverAuthority.placedExtractors = placedExtractors.map((extractor) => ({
      ...extractor,
      collectableUnits: Math.max(0, Math.trunc(Number(extractor.collectableUnits) || 0)),
    }));
  }
  if (Array.isArray(placedCamps)) {
    state.serverAuthority.placedCamps = placedCamps.map((camp) => ({ ...camp }));
  }
  if (Array.isArray(placedParcels)) {
    state.serverAuthority.placedParcels = placedParcels.map((parcel) => ({
      ...parcel,
      rect: { ...parcel.rect },
      buildZone: { ...parcel.buildZone },
      farmYard: { ...parcel.farmYard },
    }));
  }
  if (Array.isArray(farmPlots)) {
    state.serverAuthority.farmPlots = farmPlots.map((plot) => ({
      ...plot,
      tiles: plot.tiles.map((tile) => ({
        ...tile,
        crop: tile.crop ? { ...tile.crop } : tile.crop,
        legalVerbs: [...tile.legalVerbs],
      })),
    }));
  }
  if (Array.isArray(draftedSchematics)) {

    state.serverAuthority.draftedSchematics = draftedSchematics.map(cloneDraftedSchematic);
  }
  if (craftSession !== undefined) {
    state.serverAuthority.craftSession = craftSession ? cloneCraftSession(craftSession) : null;
  }
}

function applyAuthorityBuilding(
  state: PlayState,
  building: ServerAuthorityBuildingState | undefined,
  replace: boolean,
): void {
  if (building) {
    state.serverAuthority.building = {
      schema: "successor.authority-building.v1",
      tick: building.tick,
      components: building.components.map((component) => ({ ...component, palette: { ...component.palette } })),
      interiors: building.interiors.map((interior) => ({
        ...interior,
        cellKeys: [...interior.cellKeys],
        doorComponentIds: [...interior.doorComponentIds],
      })),
    };
  } else if (replace) {
    state.serverAuthority.building = {
      schema: "successor.authority-building.v1",
      tick: 0,
      components: [],
      interiors: [],
    };
  }
}

function applyAuthorityGroups(state: PlayState, groups: ServerAuthorityGroupViewState | undefined): void {
  if (groups !== undefined) state.serverAuthority.group = cloneGroupView(groups);
}

/**
 * `authority.guilds` (wire key `guilds`): a PRESENT view replaces the whole
 * projection (charter/membership/directory transitions clear stale facts);
 * an ABSENT key retains the last view (delta omission = no change).
 */
function applyAuthorityGuilds(state: PlayState, guilds: ServerAuthorityGuildViewState | undefined): void {
  if (guilds !== undefined) state.serverAuthority.guilds = cloneGuildView(guilds);
}

function applyAuthorityDuels(state: PlayState, duels: ServerAuthorityDuelViewState | undefined): void {
  if (duels !== undefined) state.serverAuthority.duel = cloneDuelView(duels);
}

function cloneSpliceSession(session: ServerAuthoritySpliceSessionState): ServerAuthoritySpliceSessionState {
  return {
    ...session,
    slots: session.slots.map((slot) => ({ ...slot })),
    lines: session.lines.map((line) => ({ ...line })),
  };
}

function cloneGenomeScan(scan: ServerAuthorityGenomeScanState): ServerAuthorityGenomeScanState {
  return {
    ...scan,
    profile: { ...scan.profile },
    loci: scan.loci.map((locus) => ({ ...locus })),
  };
}

function cloneTradeSession(session: ServerAuthorityTradeSessionState): ServerAuthorityTradeSessionState {
  const cloneSide = (side: ServerAuthorityTradeSideStateLike): ServerAuthorityTradeSideStateLike => ({
    ...side,
    items: side.items.map((item) => ({ ...item })),
  });
  return {
    ...session,
    mine: cloneSide(session.mine),
    theirs: cloneSide(session.theirs),
  };
}
type ServerAuthorityTradeSideStateLike = ServerAuthorityTradeSessionState["mine"];

function cloneCraftSession(session: ServerAuthorityCraftSessionState): ServerAuthorityCraftSessionState {
  return {
    ...session,
    recipes: session.recipes.map((recipe) => ({ ...recipe })),
    detail: session.detail ? {
      ...session.detail,
      slots: session.detail.slots.map((slot) => ({ ...slot })),
      statLines: session.detail.statLines.map((line) => ({ ...line })),
    } : session.detail ?? null,
    details: Array.isArray(session.details)
      ? session.details.map((detail) => ({
        ...detail,
        slots: detail.slots.map((slot) => ({ ...slot })),
        statLines: detail.statLines.map((line) => ({ ...line })),
      }))
      : session.details,
    slotScreen: session.slotScreen ? {
      ...session.slotScreen,
      slots: session.slotScreen.slots.map((slot) => ({
        ...slot,
        eligible: slot.eligible.map((option) => ({
          ...option,
          stats: { ...option.stats },
        })),
        assigned: slot.assigned ? { ...slot.assigned } : slot.assigned ?? null,
      })),
    } : session.slotScreen ?? null,
    assembled: session.assembled ? {
      ...session.assembled,
      lines: session.assembled.lines.map((line) => ({ ...line })),
    } : session.assembled ?? null,
  };
}

function cloneDraftedSchematic(schematic: ServerAuthorityDraftedSchematicState): ServerAuthorityDraftedSchematicState {
  return {
    ...schematic,
    resourceLocks: schematic.resourceLocks.map((lock) => ({ ...lock })),
  };
}

function cloneGroupView(view: ServerAuthorityGroupViewState): ServerAuthorityGroupViewState {
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

function cloneGuildView(view: ServerAuthorityGuildViewState): ServerAuthorityGuildViewState {
  return {
    ...(view.guild ? {
      guild: {
        ...view.guild,
        wars: (view.guild.wars ?? []).map((war) => ({ ...war })),
      },
    } : {}),
    roster: (view.roster ?? []).map((entry) => ({
      ...entry,
      permissions: (entry.permissions ?? []).slice(),
      // Privacy floor is client-enforced too: an offline row NEVER carries an
      // area even if a wire payload slipped one through.
      areaId: entry.online ? entry.areaId ?? null : null,
    })),
    pendingInvites: (view.pendingInvites ?? []).map((invite) => ({ ...invite })),
    directory: (view.directory ?? []).map((entry) => ({ ...entry })),
  };
}

function cloneDuelView(view: ServerAuthorityDuelViewState): ServerAuthorityDuelViewState {
  return {
    ...(view.activeDuel ? { activeDuel: { ...view.activeDuel } } : {}),
    ...(view.incomingChallenge ? { incomingChallenge: { ...view.incomingChallenge } } : {}),
    ...(view.outgoingChallenge ? { outgoingChallenge: { ...view.outgoingChallenge } } : {}),
  };
}

function applyAuthorityPropStates(
  state: PlayState,
  slice: SliceSnapshot,
  propStates: Record<string, GamePropState> | undefined,
  replace = false,
  sfx?: SfxPlayer,
): void {
  if (!propStates || typeof propStates !== "object") {
    if (replace) state.serverAuthority.propStates = {};
    state.movementBlockers = buildMovementBlockers(slice, state.activeAreaId, state.serverAuthority.propStates ?? {}, state.serverAuthority.placedCamps);
    return;
  }
  const previous = state.serverAuthority.propStates ?? {};
  const next = replace ? {} : { ...previous };
  for (const [propId, propState] of Object.entries(propStates)) {
    const previousDoorOpen = previous[propId]?.doorOpen;
    const nextPropState = { ...propState };
    next[propId] = nextPropState;
    if (!replace && typeof nextPropState.doorOpen === "boolean" && previousDoorOpen !== nextPropState.doorOpen) {
      playDoorSlideFeedback(state, slice, propId, sfx);
    }
  }
  state.serverAuthority.propStates = next;
  state.movementBlockers = buildMovementBlockers(slice, state.activeAreaId, state.serverAuthority.propStates ?? {}, state.serverAuthority.placedCamps);
}

function playDoorSlideFeedback(
  state: PlayState,
  slice: SliceSnapshot,
  propId: string,
  sfx?: SfxPlayer,
): void {
  if (!sfx) return;
  const prop = slice.props.find((candidate) => candidate.id === propId);
  if (!prop?.door || prop.areaId !== state.activeAreaId) return;
  if (!doorSlideFeedbackDue(state, propId)) return;
  sfx.playAt(successorAudioIds.doorSlide, propAudioCenter(prop), {
    volume: 0.64,
    minDistanceCells: 1.5,
    maxDistanceCells: 30,
    panDistanceCells: 10,
    rolloff: 1.35,
  });
}

function doorSlideFeedbackDue(state: PlayState, propId: string): boolean {
  let cadence = doorSlideByState.get(state);
  if (!cadence) {
    cadence = new Map();
    doorSlideByState.set(state, cadence);
  }
  const now = Number.isFinite(state.worldTimeMs) ? state.worldTimeMs : 0;
  const lastAt = cadence.get(propId);
  if (typeof lastAt === "number" && now - lastAt < doorSlideMinSpacingMs) return false;
  cadence.set(propId, now);
  return true;
}

function propAudioCenter(prop: SliceSnapshot["props"][number]): { x: number; y: number } {
  const blocker = prop.door?.blocker;
  if (!blocker) return { x: prop.cell.x + prop.size.w / 2, y: prop.cell.y + prop.size.h / 2 };
  return {
    x: prop.cell.x + (blocker.xMilli + blocker.wMilli / 2) / 1000,
    y: prop.cell.y + (blocker.yMilli + blocker.hMilli / 2) / 1000,
  };
}

function syncAuthoritativePlayerLoadout(state: PlayState): void {
  if (!state.serverAuthority.enabled) return;
  const actorId = state.serverAuthority.playerActorId ?? state.playerActorId;
  const actor = state.serverAuthority.actors[actorId];
  const weapon = actor?.weapon;
  if (!actor) return;
  if (!weapon) {
    state.loadout.unlimitedAmmo = false;
    state.loadout.activeWeaponId = null;
    state.loadout.equipped.longGun = null;
    delete state.weaponFireAnimations[state.playerActorId];
    return;
  }
  if (!isWeaponId(weapon.weaponId)) return;
  const spec = weaponSpecs[weapon.weaponId];
  const caliber = spec.caliber;
  const ammoType = isAmmoTypeId(weapon.ammoType) ? weapon.ammoType : spec.defaultAmmoType;
  const loaded = Math.max(0, Math.min(Math.trunc(weapon.loadedRounds), Math.max(1, Math.trunc(weapon.magazineSize))));
  const packRounds = ammoType === "slug_iron" ? actorInventoryItemAvailable(state, actorId, IRON_SLUG_ITEM_ID) : 0;
  state.loadout.unlimitedAmmo = false;
  state.loadout.activeWeaponId = weapon.weaponId;
  state.loadout.equipped[spec.slot] = weapon.weaponId;
  state.loadout.activeAmmo[caliber] = ammoType;
  state.loadout.ammo[caliber].loaded = loaded;
  state.loadout.ammo[caliber].reserve = Math.max(0, packRounds);
}

function actorInventoryItemAvailable(state: PlayState, actorId: string, itemId: number): number {
  return state.inventory.reduce((sum, row) => {
    if (row.itemId !== itemId || !actorOwnsContainer(actorId, row.container)) return sum;
    return sum + Math.max(0, Number(row.available ?? row.quantity ?? 0));
  }, 0);
}

function actorOwnsContainer(actorId: string, container: string): boolean {
  return container === actorId || container.startsWith(`${actorId}:`);
}

function applyAuthorityInventoryFeedback(
  state: PlayState,
  nextInventory: InventoryRow[],
  sfx?: SfxPlayer,
): void {
  if (state.inventory.length === 0 && state.serverAuthority.receivedSnapshots <= 0) return;
  const previous = new Map(state.inventory.map((row) => [inventoryStackKey(row), row]));
  const next = new Map(nextInventory.map((row) => [inventoryStackKey(row), row]));
  const emittedFeedback = new Set<string>();
  const actorsWithVisibleGain = new Set<string>();

  for (const row of nextInventory) {
    const before = previous.get(inventoryStackKey(row));
    const beforeAvailable = Number(before?.available ?? 0);
    const afterAvailable = Number(row.available ?? 0);
    if (!Number.isFinite(afterAvailable)) continue;
    const actorId = actorIdFromInventoryContainer(row.container);
    if (!actorId) continue;
    const actor = state.serverAuthority.actors[actorId];
    if (!actor || actor.areaId !== state.activeAreaId || actor.lifeState !== "alive") continue;
    if (row.itemId === STIMPAK_A_ITEM_ID && afterAvailable < beforeAvailable) {
      const key = `${actorId}:stimpak`;
      if (emittedFeedback.has(key)) continue;
      emittedFeedback.add(key);
      emitStimpakFeedback(state, actor, actorId, sfx);
      continue;
    }
    if (row.itemId === FIELD_BANDAGE_ITEM_ID && afterAvailable < beforeAvailable) {
      const key = `${actorId}:bandage`;
      if (emittedFeedback.has(key)) continue;
      emittedFeedback.add(key);
      emitBandageFeedback(state, actor, actorId, sfx);
      continue;
    }
    if (!inventoryGainShouldBeVisible(row)) continue;
    if (afterAvailable <= beforeAvailable) continue;
    const key = `${actorId}:inventory`;
    if (emittedFeedback.has(key)) continue;
    emittedFeedback.add(key);
    actorsWithVisibleGain.add(actorId);
    emitInventoryGainFeedback(state, actor, actorId, row, sfx);
  }

  for (const row of state.inventory) {
    if (!exchangeStackAvailableIncreased(previous, next, row)) continue;
    const beforeAvailable = Number(row.available ?? 0);
    const afterAvailable = Number(next.get(inventoryStackKey(row))?.available ?? 0);
    if (!Number.isFinite(beforeAvailable) || afterAvailable >= beforeAvailable) continue;
    const actorId = actorIdFromInventoryContainer(row.container);
    if (!actorId || actorsWithVisibleGain.has(actorId)) continue;
    const actor = state.serverAuthority.actors[actorId];
    if (!actor || actor.areaId !== state.activeAreaId || actor.lifeState !== "alive") continue;
    const key = `${actorId}:store`;
    if (emittedFeedback.has(key)) continue;
    emittedFeedback.add(key);
    spawnInventoryTransferEffect(state, actor, {
      actorId,
      label: "STORE",
      color: "#b78cff",
    });
    playInventoryFeedbackSfx(state, sfx, "store", actor, actorId, 0.45, 18);
  }
}

function emitInventoryGainFeedback(
  state: PlayState,
  actor: Pick<GameActorSnapshot, "x" | "y">,
  actorId: string,
  row: InventoryRow,
  sfx?: SfxPlayer,
): void {
  const feedback = inventoryGainFeedback(row);
  const visualKey = `${actorId}:${row.itemId}:${row.variantId}:${feedback.label}`;
  if (!hasActorFloatingFeedback(state, actorId, feedback.label) && inventoryFeedbackVisualDue(state, visualKey)) {
    if (isResourceInventoryItem(row.itemId)) {
      spawnResourceSampleEffect(state, actor, actorId, feedback.label, feedback.color);
    } else {
      spawnInventoryTransferEffect(state, actor, {
        actorId,
        label: feedback.label,
        color: feedback.color,
      });
    }
  }
  playInventoryFeedbackSfx(state, sfx, `gain:${feedback.label}`, actor, actorId, 0.5, 24);
}

function inventoryFeedbackVisualDue(state: PlayState, key: string): boolean {
  let cadence = inventoryFeedbackVisualByState.get(state);
  if (!cadence) {
    cadence = new Map();
    inventoryFeedbackVisualByState.set(state, cadence);
  }
  const lastAt = cadence.get(key);
  if (typeof lastAt === "number" && state.worldTimeMs - lastAt < inventoryFeedbackVisualMinIntervalMs) {
    return false;
  }
  cadence.set(key, state.worldTimeMs);
  return true;
}

function playInventoryFeedbackSfx(
  state: PlayState,
  sfx: SfxPlayer | undefined,
  key: string,
  actor: Pick<GameActorSnapshot, "x" | "y">,
  actorId: string,
  volume: number,
  maxDistanceCells: number,
): void {
  if (!sfx) return;
  const mix = inventoryFeedbackSfxMix(state, actor, actorId, volume, maxDistanceCells);
  if (!mix) return;
  let cadence = inventoryFeedbackSfxByState.get(state);
  if (!cadence) {
    cadence = new Map();
    inventoryFeedbackSfxByState.set(state, cadence);
  }
  const lastAt = cadence.get(key);
  if (typeof lastAt === "number" && state.worldTimeMs - lastAt < inventoryFeedbackSfxMinIntervalMs) {
    return;
  }
  cadence.set(key, state.worldTimeMs);
  sfx.playAt("inventory_transfer", { x: actor.x + 0.5, y: actor.y + 0.5 }, {
    volume: mix.volume,
    minDistanceCells: 2,
    maxDistanceCells: mix.maxDistanceCells,
    rolloff: 1.8,
    farGainFloor: 0,
    panDistanceCells: 8,
  });
}

function inventoryFeedbackSfxMix(
  state: PlayState,
  _actor: Pick<GameActorSnapshot, "x" | "y">,
  actorId: string,
  volume: number,
  maxDistanceCells: number,
): { volume: number; maxDistanceCells: number } | null {
  if (authorityFeedbackActorIsLocal(state, actorId)) {
    return { volume, maxDistanceCells };
  }
  return null;
}

function authorityFeedbackActorIsLocal(state: PlayState, actorId: string): boolean {
  const playerActorId = state.serverAuthority.playerActorId ?? state.playerActorId;
  return actorId === playerActorId || actorId === state.playerActorId;
}

function inventoryGainShouldBeVisible(row: InventoryRow): boolean {
  return row.itemId === IRON_SLUG_ITEM_ID
    || row.itemId === STIMPAK_A_ITEM_ID
    || row.itemId === FIELD_BANDAGE_ITEM_ID
    || row.itemId === RESUSCITATION_KIT_ITEM_ID
    || isResourceInventoryItem(row.itemId);
}

function inventoryGainFeedback(row: Pick<InventoryRow, "item" | "itemId">): { label: string; color: string } {
  const itemName = row.item.toLowerCase();
  if (row.itemId === IRON_SLUG_ITEM_ID) return { label: "+AMMO", color: "#ffd36b" };
  if (row.itemId === STIMPAK_A_ITEM_ID) return { label: "+STIM", color: "#ff4c66" };
  if (row.itemId === FIELD_BANDAGE_ITEM_ID) return { label: "+BANDAGE", color: "#fff0ca" };
  if (row.itemId === RESUSCITATION_KIT_ITEM_ID) return { label: "+RES KIT", color: "#72f4d0" };
  if (row.itemId === 2006 || itemName.includes("powder")) {
    return { label: "+POWDER", color: "#ffb45f" };
  }
  if (row.itemId === 2001 || itemName.includes("iron") || itemName.includes("mineral")) {
    return { label: "+IRON", color: "#a7d9c4" };
  }
  return { label: "+RES", color: "#72f4a1" };
}

function isResourceInventoryItem(itemId: number): boolean {
  return itemId >= 2001 && itemId <= 2104;
}

function exchangeStackAvailableIncreased(
  previous: Map<string, InventoryRow>,
  next: Map<string, InventoryRow>,
  row: Pick<InventoryRow, "itemId" | "variantId">,
): boolean {
  const exchangeKey = inventoryStackKey({
    container: "district-exchange",
    itemId: row.itemId,
    variantId: row.variantId,
  });
  const beforeAvailable = Number(previous.get(exchangeKey)?.available ?? 0);
  const afterAvailable = Number(next.get(exchangeKey)?.available ?? 0);
  return Number.isFinite(beforeAvailable)
    && Number.isFinite(afterAvailable)
    && afterAvailable > beforeAvailable;
}

function inventoryStackKey(row: Pick<InventoryRow, "container" | "itemId" | "variantId">): string {
  return `${row.container}:${row.itemId}:${row.variantId}`;
}

function actorIdFromInventoryContainer(container: string): string | null {
  const actorId = container.split(":")[0]?.trim();
  return actorId && !actorId.startsWith("stockpile") ? actorId : null;
}

function emitAuthoritativeActorAttitudeFeedback(
  state: PlayState,
  previous: ServerAuthorityActorState | undefined,
  actor: GameActorSnapshot,
): void {
  const nextAttitude = normalizeActorAiAttitude(actor.aiAttitude);
  const previousAttitude = normalizeActorAiAttitude(previous?.aiAttitude);
  if (nextAttitude !== "alerted" || previousAttitude === "alerted") return;
  if (actor.areaId !== state.activeAreaId || actor.lifeState !== "alive") return;
  enqueueSpatialBubble(state, {
    body: "?",
    sender: actor.label || actor.id,
    own: false,
    actorId: actor.id,
  });
}

function emitAuthoritativeActorMedicalFeedback(
  state: PlayState,
  previous: ServerAuthorityActorState | undefined,
  actor: GameActorSnapshot,
  sfx?: SfxPlayer,
): void {
  if (!previous || actor.areaId !== state.activeAreaId || actor.lifeState !== "alive") return;
  const previousStimpak = previous.statuses.some((status) => status.id === "stimpak_a_heal");
  const nextStimpak = actor.statuses.some((status) => structuredCombatStatusId(status.id) === "stimpak_a_heal");
  const previousBleeding = previous.bleed.active || previous.statuses.some((status) => status.id === "bleeding");
  const nextBleeding = actor.bleed.active || actor.statuses.some((status) => structuredCombatStatusId(status.id) === "bleeding");
  if (nextStimpak && !previousStimpak) emitStimpakFeedback(state, actor, actor.id, sfx);
  if (previousBleeding && !nextBleeding) emitBandageFeedback(state, actor, actor.id, sfx);
  emitAuthoritativeActorProfessionFeedback(state, previous, actor);
}

function emitAuthoritativeActorProfessionFeedback(
  state: PlayState,
  previous: ServerAuthorityActorState,
  actor: GameActorSnapshot,
): void {
  if (!authorityFeedbackActorIsLocal(state, actor.id)) return;
  const event = professionXpGainEvent(previous.professions, actor.professions);
  if (!event) return;
  spawnFloatingExperience(state, actor, event.amount, event.label, event.color, actor.id);
}

function professionXpGainEvent(
  previous: GameActorProfessionSnapshot[] | undefined,
  next: GameActorProfessionSnapshot[] | undefined,
): { amount: number; label: string; color: string } | null {
  if (!Array.isArray(previous) || !Array.isArray(next)) return null;
  let best: { amount: number; label: string; color: string; score: number } | null = null;
  const previousById = new Map(previous.map((profession) => [profession.id, profession]));
  for (const profession of next) {
    const before = previousById.get(profession.id);
    if (!before) continue;
    const professionGain = Math.max(0, Math.trunc(profession.xp - before.xp));
    const trackGain = bestProfessionTrackGain(before.trackXp, profession.trackXp);
    const amount = trackGain?.amount ?? professionGain;
    if (amount <= 0) continue;
    const label = trackGain ? `${trackGain.track} XP` : `${profession.id} XP`;
    const candidate = {
      amount,
      label,
      color: professionXpColor(profession.id),
      score: amount + (trackGain ? 1_000 : 0),
    };
    if (!best || candidate.score > best.score) best = candidate;
  }
  return best ? { amount: best.amount, label: best.label, color: best.color } : null;
}

function bestProfessionTrackGain(
  previous: Record<string, number> | undefined,
  next: Record<string, number> | undefined,
): { track: string; amount: number } | null {
  if (!next) return null;
  let best: { track: string; amount: number } | null = null;
  for (const [track, xp] of Object.entries(next)) {
    const gain = Math.max(0, Math.trunc(xp - Number(previous?.[track] ?? 0)));
    if (gain <= 0) continue;
    if (!best || gain > best.amount) best = { track, amount: gain };
  }
  return best;
}

function professionXpColor(professionId: string): string {
  switch (professionId) {
    case "marksman":
      return "#ffd36b";
    case "brawler":
      return "#ff8a6b";
    case "scout":
      return "#73f7a8";
    case "medic":
      return "#ff6c88";
    case "craftsman":
      return "#9bd4ff";
    default:
      return "#7ef7ff";
  }
}


function emitStimpakFeedback(
  state: PlayState,
  actor: Pick<GameActorSnapshot, "x" | "y">,
  actorId: string,
  sfx?: SfxPlayer,
): void {
  if (hasActorFloatingFeedback(state, actorId, "STIMPAK")) return;
  spawnStimpakEffect(state, actor, actorId);
  if (authorityFeedbackActorIsLocal(state, actorId)) {
    sfx?.playAt("stimpak_apply", { x: actor.x + 0.5, y: actor.y + 0.5 }, {
      volume: 0.76,
      minDistanceCells: 2,
      maxDistanceCells: 24,
    });
  }
}

function emitBandageFeedback(
  state: PlayState,
  actor: Pick<GameActorSnapshot, "x" | "y">,
  actorId: string,
  sfx?: SfxPlayer,
): void {
  if (hasActorFloatingFeedback(state, actorId, "BANDAGE")) return;
  spawnBandageEffect(state, actor, actorId);
  if (authorityFeedbackActorIsLocal(state, actorId)) {
    sfx?.playAt("bandage_apply", { x: actor.x + 0.5, y: actor.y + 0.5 }, {
      volume: 0.68,
      minDistanceCells: 2,
      maxDistanceCells: 22,
    });
  }
}

function emitAuthoritativeActorCreditsFeedback(
  state: PlayState,
  previous: Pick<ServerAuthorityActorState, "credits"> | undefined,
  actor: Pick<GameActorSnapshot, "id" | "credits">,
  sfx?: SfxPlayer,
): void {
  if (!sfx || !authorityFeedbackActorIsLocal(state, actor.id)) return;
  const before = typeof previous?.credits === "number" ? previous.credits : null;
  const after = typeof actor.credits === "number" ? actor.credits : null;
  if (before === null || after === null || after <= before) return;
  const lastAt = creditsChimeByState.get(state);
  if (typeof lastAt === "number" && state.worldTimeMs - lastAt < creditsChimeMinSpacingMs) return;
  creditsChimeByState.set(state, state.worldTimeMs);
  sfx.play(successorAudioIds.creditsChime, { volume: 0.76 });
}

function clearNonAuthoritativePresentationFrames(state: PlayState): void {
  const playerActorId = state.serverAuthority.playerActorId ?? state.playerActorId;
  const authorityActors = state.serverAuthority.actors;
  for (const actorId of Object.keys(state.actorPresentationFrames)) {
    if (actorId === "player" || actorId === state.playerActorId || actorId === playerActorId) continue;
    if (!authorityActors[actorId]) delete state.actorPresentationFrames[actorId];
  }
}

function applyAuthoritySourceMetadata(
  state: PlayState,
  slice: SliceSnapshot,
  packet: Pick<GameShardSnapshot, "sourceStateHash" | "sourceActorCount" | "playerActorId">,
  allowMetadataOmission = false,
): boolean {
  const sourceStateHash = packet.sourceStateHash === undefined && allowMetadataOmission
    ? state.serverAuthority.sourceStateHash
    : typeof packet.sourceStateHash === "string" && packet.sourceStateHash.length > 0
      ? packet.sourceStateHash
      : null;
  const sourceActorCount = packet.sourceActorCount === undefined && allowMetadataOmission
    ? state.serverAuthority.sourceActorCount
    : typeof packet.sourceActorCount === "number"
      && Number.isFinite(packet.sourceActorCount)
      && Number.isInteger(packet.sourceActorCount)
      ? packet.sourceActorCount
      : null;
  const playerMatches = packet.playerActorId === state.playerActorId;
  const metadataOmitted = allowMetadataOmission
    && packet.sourceStateHash === undefined
    && packet.sourceActorCount === undefined;
  const declaredActorCount = declaredSliceActorCount(slice);
  const metadataPresent = sourceStateHash !== null && sourceActorCount !== null;
  const metadataMatches = metadataPresent
    && sourceStateHash === slice.stateHash
    && sourceActorCount === declaredActorCount;
  const matchesClient = metadataMatches && playerMatches;

  state.serverAuthority.sourceStateHash = sourceStateHash;
  state.serverAuthority.sourceActorCount = sourceActorCount;
  state.serverAuthority.sourceMatchesClient = matchesClient;
  if (!matchesClient) {
    if (metadataOmitted) return true;
    state.serverAuthority.status = "error";
    state.status = authoritySourceMismatchMessage(state, slice, sourceStateHash, sourceActorCount, packet.playerActorId);
    return false;
  }
  if (state.serverAuthority.connected) state.serverAuthority.status = "connected";
  if (
    state.status.startsWith("server authority source mismatch")
    || state.status === "server authority connecting"
    || state.status === "server authority reconnecting"
  ) {
    state.status = state.serverAuthority.connected ? "server authority" : "server authority connecting";
  }
  return true;
}

function clearMismatchedAuthorityState(state: PlayState): void {
  deferInFlightAuthorityCommand(state.authorityCommands);
  state.serverAuthority.inFlightMoves = [];
  state.serverAuthority.actors = {};
  state.serverAuthority.actorNetIds = {};
  state.serverAuthority.actorIdsByNetId = {};
  state.serverAuthority.group = { members: [] };
  state.serverAuthority.guilds = { roster: [], pendingInvites: [], directory: [] };
  state.serverAuthority.bank = null;
  state.serverAuthority.playerCorpses = [];
  state.serverAuthority.authoritativePlayer = null;
  state.serverAuthority.predictionTarget = null;
  state.serverAuthority.lastMoveIssuedAtTick = null;
  state.abilityQueue.view = null;
  state.abilityQueue.events = [];
}

function authoritySourceMismatchMessage(
  state: Pick<PlayState, "playerActorId">,
  slice: SliceSnapshot,
  sourceStateHash: string | null,
  sourceActorCount: number | null,
  serverPlayerActorId: string,
): string {
  if (serverPlayerActorId !== state.playerActorId) {
    return `server authority source mismatch: client actor ${state.playerActorId} server actor ${serverPlayerActorId}`;
  }
  return `server authority source mismatch: client ${slice.stateHash}/${declaredSliceActorCount(slice)}`
    + ` server ${sourceStateHash ?? "unknown"}/${sourceActorCount ?? "unknown"}`;
}

function syncServerClock(state: PlayState, serverTime: string): void {
  const serverTimeMs = Date.parse(serverTime);
  if (!Number.isFinite(serverTimeMs)) return;
  state.serverAuthority.serverTimeOffsetMs = serverTimeMs - Date.now();
  state.serverAuthority.lastServerTimeSyncAtMs = Number(state.worldTimeMs.toFixed(3));
}

function applyAuthoritativeActors(
  state: PlayState,
  slice: SliceSnapshot,
  playerActorId: string,
  actors: Record<string, GameActorSnapshot>,
  sfx?: SfxPlayer,
): void {
  const player = actors[playerActorId];
  if (player) {
    const previousAuthoritativePlayer = state.serverAuthority.authoritativePlayer;
    state.playerActorId = playerActorId;
    state.serverAuthority.authoritativePlayer = { x: player.x, y: player.y };
    state.facing = normalizeDirection(player.direction);
    if (!previousAuthoritativePlayer) {
      state.player = { x: player.x, y: player.y };
    }
    if (state.activeAreaId !== player.areaId) {
      const previousAreaId = state.activeAreaId;
      const transitionLabel = transitionLabelForAreaChange(slice, previousAreaId, player);
      state.activeAreaId = player.areaId;
      state.player = { x: player.x, y: player.y };
      state.blocked = buildBlockedCells(slice, state.activeAreaId);
      state.movementBlockers = buildMovementBlockers(slice, state.activeAreaId, state.serverAuthority.propStates ?? {}, state.serverAuthority.placedCamps);
      state.selectedActorId = null;
      state.examineActorId = null;
      state.transitionCooldownMs = Math.max(state.transitionCooldownMs, 650);
      state.transitionFlashMs = 420;
      state.lastTransitionLabel = transitionLabel;
      state.status = transitionLabel.toLowerCase();
      sfx?.play("area_transition");
    }
    applyAuthoritativePlayerDeathState(state, slice, player);
  }

  for (const actor of Object.values(actors)) {
    applyActorCombatSnapshot(state, slice, actor, actor.id, sfx);
    if (actor.id === playerActorId && actor.id !== slice.camera.followActor) {
      applyActorCombatSnapshot(state, slice, actor, slice.camera.followActor, sfx);
    }
  }
}

function transitionLabelForAreaChange(
  slice: SliceSnapshot,
  fromAreaId: string,
  player: GameActorSnapshot,
): string {
  const exact = slice.transitions.find((transition) => (
    transition.fromAreaId === fromAreaId
    && transition.toAreaId === player.areaId
    && Math.abs(transition.toCell.x - player.x) < 0.75
    && Math.abs(transition.toCell.y - player.y) < 0.75
  ));
  if (exact) return exact.label;
  return slice.transitions.find((transition) => (
    transition.fromAreaId === fromAreaId && transition.toAreaId === player.areaId
  ))?.label ?? "Area Transition";
}

function applyActorCombatSnapshot(
  state: PlayState,
  slice: SliceSnapshot,
  actor: GameActorSnapshot,
  combatId: string,
  sfx?: SfxPlayer,
): void {
  const combat = state.actors[combatId] ?? cloneCombatTemplate(state, slice.camera.followActor);
  if (!combat) return;
  state.actors[combatId] = combat;
  const previousSleeping = combat.statuses.some((status) => status.id === "sleeping");
  const previousStimpak = combat.statuses.some((status) => status.id === "stimpak_a_heal");
  const previousBleeding = combat.bleed.active || combat.statuses.some((status) => status.id === "bleeding");
  const previousReloading = combat.statuses.some((status) => status.id === "reloading");
  const previousLifecycleSeq = combat.lifecycleSeq;
  const lifecycleSeq = typeof actor.lifecycleSeq === "number" ? actor.lifecycleSeq : previousLifecycleSeq ?? 1;
  if (previousLifecycleSeq !== lifecycleSeq) invalidateActorPresentationCaches(state, combatId);
  combat.lifecycleSeq = lifecycleSeq;
  combat.lifeState = actor.lifeState;
  combat.downed = actor.lifeState !== "alive";
  combat.downedCell = actor.lifeState !== "alive" ? { x: actor.x, y: actor.y } : null;
  const statuses = normalizeAuthoritativeStatuses(actor.lifeState, actor.statuses.map(statusFromSnapshot));
  const sleeping = statuses.some((status) => status.id === "sleeping");
  combat.vitals = localPlayerVitalsFromAuthority(state, actor, combatId, combat.vitals);
  combat.maxVitals = { ...actor.maxVitals };
  combat.bleed = bleedFromSnapshot(actor.bleed);
  combat.statuses = statuses;
  const actorVisible = combatId === actor.id && actor.areaId === state.activeAreaId && actor.lifeState === "alive";
  if (actorVisible) {
    const stimpakActive = statuses.some((status) => status.id === "stimpak_a_heal");
    const bleeding = combat.bleed.active || statuses.some((status) => status.id === "bleeding");
    const reloadingStatus = statuses.find((status) => status.id === "reloading");
    const reloading = Boolean(reloadingStatus);
    if (stimpakActive && !previousStimpak) {
      emitStimpakFeedback(state, actor, combatId, sfx);
    }
    if (previousBleeding && !bleeding) {
      emitBandageFeedback(state, actor, combatId, sfx);
    }
    if (reloading && !previousReloading) {
      const actorWeaponId = state.actorWeaponIds[combatId];
      const weaponId = actorWeaponId && isWeaponId(actorWeaponId) ? actorWeaponId : "slugthrower";
      const weapon = weaponSpecs[weaponId];
      triggerWeaponReloadAnimation(state, combatId, weaponId, reloadingStatus?.ttlMs ?? weapon.reloadMs);
      sfx?.playAt(weapon.reloadSfx, { x: actor.x + 0.5, y: actor.y + 0.5 }, {
        volume: 0.72,
        minDistanceCells: 2,
        maxDistanceCells: 32,
        panDistanceCells: 20,
      });
    }
  }
  if (previousSleeping && !sleeping && actor.lifeState === "alive" && actor.areaId === state.activeAreaId) {
    spawnFloatingStatusText(state, { x: actor.x, y: actor.y }, "AWAKE");
  }
  combat.hitFlashMs = Math.max(combat.hitFlashMs, actor.lifeState !== "alive" ? 100 : 0);
  if (actor.lifeState !== "alive") delete state.actorPresentationFrames[combatId];
  if (actor.lifeState === "respawning") clearActorSelectionCaches(state, combatId);
}

function localPlayerVitalsFromAuthority(
  state: PlayState,
  actor: GameActorSnapshot,
  combatId: string,
  previousVitals: GameActorSnapshot["vitals"],
): GameActorSnapshot["vitals"] {
  const next = { ...actor.vitals };
  const playerActorId = state.serverAuthority.playerActorId ?? state.playerActorId;
  if (
    combatId === playerActorId
    && state.moving
    && sprintRequestedFromKeys(state.keys)
    && actor.lifeState === "alive"
  ) {
    next.action = Math.min(next.action, previousVitals.action);
  }
  return next;
}

function invalidateActorPresentationCaches(state: PlayState, actorId: string): void {
  delete state.actorPresentationFrames[actorId];
  delete state.weaponFireAnimations[actorId];
}

function removeAuthorityActorState(state: PlayState, actorId: string, playerActorId: string | null | undefined): void {
  if (actorId === playerActorId) return;
  delete state.serverAuthority.actors[actorId];
  delete state.actors[actorId];
  invalidateActorPresentationCaches(state, actorId);
  clearActorSelectionCaches(state, actorId);
}

function dropRespawningAuthorityActor(
  state: PlayState,
  actorId: string,
  actor: GameActorSnapshot,
  playerActorId: string | null | undefined,
  removedActorIds: Set<string>,
): boolean {
  if (actorId === playerActorId || actor.lifeState !== "respawning") return false;
  removedActorIds.add(actorId);
  removeAuthorityActorState(state, actorId, playerActorId);
  return true;
}

function isStaleActorGeneration(state: PlayState, actorId: string, actor: GameActorSnapshot): boolean {
  const incoming = typeof actor.lifecycleSeq === "number" ? actor.lifecycleSeq : 1;
  const authoritySeq = state.serverAuthority.actors[actorId]?.lifecycleSeq;
  const combatSeq = state.actors[actorId]?.lifecycleSeq;
  const latest = Math.max(
    typeof authoritySeq === "number" ? authoritySeq : 1,
    typeof combatSeq === "number" ? combatSeq : 1,
  );
  return incoming < latest;
}

function clearActorSelectionCaches(state: PlayState, actorId: string): void {
  if (state.selectedActorId === actorId) state.selectedActorId = null;
  if (state.examineActorId === actorId) state.examineActorId = null;
}

function normalizeAuthoritativeStatuses(lifeState: ActorLifeState, statuses: CombatStatus[]): CombatStatus[] {
  if (lifeState !== "alive") return statuses;
  return statuses.filter((status) => (
    status.id !== "dead" &&
    status.id !== "downed" &&
    status.id !== "evacuating"
  ));
}

function cloneCombatTemplate(state: PlayState, fallbackActorId: string) {
  const template = state.actors[fallbackActorId] ?? Object.values(state.actors)[0];
  if (!template) return null;
  return {
    ...template,
    vitals: { ...template.vitals },
    maxVitals: { ...template.maxVitals },
    bleed: {
      ...template.bleed,
      ratesPerSecond: { ...template.bleed.ratesPerSecond },
    },
    statuses: template.statuses.map((status) => ({ ...status })),
    downedCell: template.downedCell ? { ...template.downedCell } : null,
  };
}

function applyAuthoritativePlayerDeathState(
  state: PlayState,
  slice: SliceSnapshot,
  player: GameActorSnapshot,
): void {
  if (player.lifeState === "alive") {
    if (state.death.phase !== "alive") {
      state.death = {
        ...state.death,
        phase: "alive",
        downedAtMs: null,
        downedRemainingMs: 0,
      };
    }
    return;
  }

  const facility = cloneFacilityForRespawn(slice.cloneFacilities ?? []);
  state.keys.clear();
  state.movementKeyOrder = [];
  state.moving = false;

  if (player.lifeState === "downed") {
    const downedRemainingMs = reviveWindowRemainingMs(state, slice, player) ?? 14_000;
    state.death = {
      ...state.death,
      phase: "downed",
      downedAtMs: state.death.downedAtMs ?? state.worldTimeMs,
      downedRemainingMs,
      lastCause: state.death.lastCause ?? "server trauma",
      cloneFacilityId: facility?.id ?? null,
      cloneFacilityLabel: facility?.label ?? null,
    };
    return;
  }

  state.death = {
    phase: "clone_pending",
    deaths: state.death.phase === "clone_pending" ? state.death.deaths : state.death.deaths + 1,
    downedAtMs: state.death.downedAtMs ?? state.worldTimeMs,
    downedRemainingMs: 0,
    lastCause: state.death.lastCause ?? "server trauma",
    cloneFacilityId: facility?.id ?? null,
    cloneFacilityLabel: facility?.label ?? null,
  };
}

function reviveWindowRemainingMs(
  state: PlayState,
  slice: SliceSnapshot,
  actor: GameActorSnapshot,
): number | null {
  if (typeof actor.bodyVanishAtTick !== "number" || actor.bodyVanishAtTick <= 0) return null;
  const tickRateHz = Number.isFinite(slice.tickRateHz) && slice.tickRateHz > 0 ? slice.tickRateHz : 20;
  const currentTick = Math.max(slice.tick ?? 0, state.serverAuthority.snapshotTick ?? 0);
  const remainingTicks = Math.max(0, actor.bodyVanishAtTick - currentTick);
  return Math.ceil((remainingTicks / tickRateHz) * 1000);
}

function captureCombatEventActorSnapshots(state: PlayState, events: GameCombatEvent[]): CombatEventActorSnapshots {
  const snapshots: CombatEventActorSnapshots = new Map();
  for (const event of events) {
    for (const actorId of [event.targetActorId, event.shooterActorId]) {
      if (snapshots.has(actorId)) continue;
      const actor = state.serverAuthority.actors[actorId];
      if (actor) snapshots.set(actorId, cloneServerAuthorityActorState(actor));
    }
  }
  return snapshots;
}

function applyCombatEventVisuals(
  state: PlayState,
  event: GameCombatEvent,
  sfx: SfxPlayer,
  actorSnapshots?: CombatEventActorSnapshots,
): void {
  const target = state.serverAuthority.actors[event.targetActorId]
    ?? actorSnapshots?.get(event.targetActorId)
    ?? fallbackCombatEventTarget(event, state.activeAreaId);
  const shooter = state.serverAuthority.actors[event.shooterActorId] ?? actorSnapshots?.get(event.shooterActorId);
  if (!target) return;
  state.serverAuthority.receivedEvents += 1;
  const eventState = {
    ...event,
    receivedAtMs: Number(state.worldTimeMs.toFixed(3)),
  };
  state.serverAuthority.lastEvent = eventState;
  state.serverAuthority.eventLog.push(eventState);
  if (state.serverAuthority.eventLog.length > maxServerAuthorityEventLog) {
    state.serverAuthority.eventLog.splice(0, state.serverAuthority.eventLog.length - maxServerAuthorityEventLog);
  }
  const lifecycleKind = event.lifecycle?.kind ?? (
    event.previousLifeState !== event.lifeState && event.lifeState === "respawning"
      ? "killed"
      : event.previousLifeState !== event.lifeState
        ? "downed"
        : "hit"
  );
  applyCombatEventLifecycleState(state, event, target, lifecycleKind);
  if (target.areaId !== state.activeAreaId) return;

  const impactPoint = event.hitPoint ?? { x: target.x + 0.5, y: target.y + 0.45 };
  const bleedoutLifecycle = isBleedoutLifecycleEvent(event);
  const shooterWeaponId = shooter?.weapon && isWeaponId(shooter.weapon.weaponId) ? shooter.weapon.weaponId : null;
  const eventWeaponId = event.weaponId ?? shooterWeaponId;
  const eventAmmoTypeId = event.ammoTypeId ?? shooter?.weapon?.ammoType ?? null;
  const meleePresentation = isMeleeWeaponPresentation(eventWeaponId, eventAmmoTypeId);
  if (meleePresentation && event.kind !== "ranged_roll" && eventWeaponId && shooter?.areaId === state.activeAreaId && shooter.lifeState === "alive") {
    triggerWeaponFireAnimation(state, event.shooterActorId, eventWeaponId);
  }
  if (event.kind === "ranged_roll" && shooter && shooter.areaId === state.activeAreaId && shooter.lifeState === "alive") {
    // Trigger the shared fire montage immediately from the Roll event, but
    // schedule ranged gunshot audio only for
    // non-melee families; melee keeps the outcome thud/down audio below.
    const rollWeaponId = eventWeaponId ?? "slugthrower";
    triggerWeaponFireAnimation(state, event.shooterActorId, rollWeaponId);
    scheduleRangedRollCombatAudio(
      state,
      sfx,
      event,
      shooter,
      impactPoint,
      lifecycleKind,
      rollWeaponId,
      !meleePresentation,
      meleePresentation,
    );
  }
  if (event.kind === "ranged_roll" && event.hit === false) {
    // A miss touched nobody: the bang/montage above and the 3D miss bolt
    // (FxEventTap, overshooting past the target) are the whole story —
    // never spark, flinch, or thud the target with a phantom impact.
    spawnFloatingStatusText(state, { x: target.x, y: target.y }, "MISS", "#bac4cf", target.id);
    return;
  }
  playCombatEventVisualEffects(
    state,
    event,
    sfx,
    lifecycleKind,
    target,
    impactPoint,
    bleedoutLifecycle,
    meleePresentation,
  );
}

function scheduleRangedRollCombatAudio(
  state: PlayState,
  sfx: SfxPlayer,
  event: GameCombatEvent,
  shooter: ServerAuthorityActorState,
  impactPoint: Point,
  lifecycleKind: "hit" | "downed" | "killed",
  weaponId: WeaponId,
  playWeaponFireAudioForEvent: boolean,
  meleePresentation: boolean,
): void {
  const originX = shooter.x + 0.5;
  const originY = shooter.y + 0.45;
  let dx = impactPoint.x - originX;
  let dy = impactPoint.y - originY;
  const len = Math.hypot(dx, dy);
  if (len > 1e-4) {
    dx /= len;
    dy /= len;
  } else {
    dx = 1;
    dy = 0;
  }
  const delayMs = rollBurstAudioDelayMs(state, event);
  const play = () => {
    if (playWeaponFireAudioForEvent) {
      const localPlayerActorId = state.serverAuthority.playerActorId ?? state.playerActorId;
      playWeaponFireAudio(state, sfx, {
        shooterActorId: event.shooterActorId,
        weaponId,
        position: { x: originX, y: originY },
        direction: { x: dx, y: dy },
        eventId: event.id,
        commandId: event.commandId ?? null,
        local: event.shooterActorId === localPlayerActorId,
      });
    }
    playRangedRollOutcomeAudio(sfx, event, impactPoint, lifecycleKind, meleePresentation);
  };
  if (delayMs <= 0) {
    play();
    return;
  }
  globalThis.setTimeout(play, delayMs);
}

function rollBurstAudioDelayMs(state: PlayState, event: GameCombatEvent): number {
  let byKey = rollBurstAudioOrdinalByState.get(state);
  if (!byKey) {
    byKey = new Map();
    rollBurstAudioOrdinalByState.set(state, byKey);
  }
  const now = Number.isFinite(state.worldTimeMs) ? state.worldTimeMs : 0;
  const wallNow = performance.now();
  const key = rollBurstOrdinalKey(event);
  const previous = byKey.get(key);
  const continuing = previous !== undefined && now - previous.lastAtMs <= ROLL_BURST_ORDINAL_RESET_MS;
  const ordinal = continuing ? previous.ordinal + 1 : 0;
  const firstWallAtMs = continuing ? previous.firstWallAtMs : wallNow;
  byKey.set(key, { ordinal, lastAtMs: now, firstWallAtMs });
  if (byKey.size > 64) {
    for (const [entryKey, entry] of byKey.entries()) {
      if (now - entry.lastAtMs > ROLL_BURST_ORDINAL_RESET_MS) byKey.delete(entryKey);
    }
  }
  return Math.max(0, firstWallAtMs + rollBurstDelayMsForOrdinal(ordinal) - wallNow);
}

function playRangedRollOutcomeAudio(
  sfx: SfxPlayer,
  event: GameCombatEvent,
  impactPoint: Point,
  lifecycleKind: "hit" | "downed" | "killed",
  meleePresentation: boolean,
): void {
  if (event.hit === false) return;
  const point = { x: impactPoint.x, y: impactPoint.y };
  const dodgeEffect = event.effect?.kind === "dodge" || event.lifecycle?.cause === "dodged";
  if (dodgeEffect) {
    // Placeholder until a dedicated dodge foley exists: the dart flesh tick is
    // a short, light cloth/flesh beat that reads distinct from miss silence and
    // from the meatier body_hit bag.
    sfx.playAt(dartImpactSfxId(event.id), point, {
      ...combatImpactSpatialOptions(meleePresentation, "light"),
      volume: 0.32,
      playbackRate: 1.12,
    });
    return;
  }
  const shieldEffect = event.effect?.kind === "shield" || event.lifecycle?.cause === "personal shield";
  if (shieldEffect) {
    sfx.playAt("projectile_hit", point, {
      ...combatImpactSpatialOptions(meleePresentation, "light"),
      volume: 0.34,
      playbackRate: 1.32,
    });
    return;
  }
  if (event.effect?.kind === "sleep") {
    const spatial = combatImpactSpatialOptions(meleePresentation, "light");
    sfx.playAt(dartImpactSfxId(event.id), point, { ...spatial, volume: 0.48 });
    sfx.playAt(sleepPuffSfxId(event.id), point, {
      ...spatial,
      volume: lifecycleKind === "killed" ? 0.5 : 0.36,
    });
    return;
  }
  if (lifecycleKind === "downed" || lifecycleKind === "killed") {
    sfx.playAt("target_down", point, {
      ...combatImpactSpatialOptions(meleePresentation, "down"),
      volume: lifecycleKind === "killed" ? 1 : 0.92,
    });
    return;
  }
  if (event.damage > 0) {
    sfx.playAt(bodyHitSfxId(event.id), point, {
      ...combatImpactSpatialOptions(meleePresentation, "body"),
      volume: bodyHitSfxVolume({ major: true }),
      playbackRate: bodyHitSfxPlaybackRate(event.id),
    });
  }
}

function playCombatEventVisualEffects(
  state: PlayState,
  event: GameCombatEvent,
  sfx: SfxPlayer,
  lifecycleKind: "hit" | "downed" | "killed",
  target: ServerAuthorityActorState,
  impactPoint: Point,
  bleedoutLifecycle: boolean,
  meleePresentation: boolean,
): void {
  const dodgeEffect = event.effect?.kind === "dodge" || event.lifecycle?.cause === "dodged";
  if (!dodgeEffect) state.hits += 1;
  const playerActorId = state.serverAuthority.playerActorId ?? state.playerActorId;
  // Combat feedback may seed an empty target plate, but it must never steal a manual selection.
  if (event.lifeState !== "respawning" && event.shooterActorId === playerActorId && state.selectedActorId === null) {
    state.selectedActorId = event.targetActorId;
  }
  const actorPos = { x: target.x, y: target.y };
  const point = {
    x: impactPoint.x,
    y: impactPoint.y,
  };
  const downed = event.lifeState !== "alive";
  const isSleepEffect = event.effect?.kind === "sleep";
  const rollAudioDeferred = event.kind === "ranged_roll";
  if (dodgeEffect) {
    spawnFloatingStatusText(state, actorPos, "DODGE", "#e9fbff", target.id);
    if (!rollAudioDeferred) {
      sfx.playAt("projectile_hit", point, {
        ...combatImpactSpatialOptions(meleePresentation, "light"),
        volume: 0.26,
        playbackRate: 1.18,
      });
    }
    recordCombatVisualLog(state, event, lifecycleKind);
    return;
  }
  const shieldEffect = event.effect?.kind === "shield" || event.lifecycle?.cause === "personal shield";
  if (shieldEffect) {
    spawnPersonalShieldBlockEffect(state, actorPos, target.id);
    if (!rollAudioDeferred) {
      sfx.playAt("projectile_hit", point, {
        ...combatImpactSpatialOptions(meleePresentation, "light"),
        volume: 0.34,
        playbackRate: 1.32,
      });
    }
    recordCombatVisualLog(state, event, lifecycleKind);
    return;
  }
  applyAuthoritativeHitReaction(state, event, lifecycleKind);
  if (isSleepEffect) {
    syncSleepEffectStatus(state, event);
    if (!rollAudioDeferred) {
      const spatial = combatImpactSpatialOptions(meleePresentation, "light");
      sfx.playAt(dartImpactSfxId(event.id), point, { ...spatial, volume: 0.48 });
      sfx.playAt(sleepPuffSfxId(event.id), point, {
        ...spatial,
        volume: lifecycleKind === "killed" ? 0.5 : 0.36,
      });
      if (lifecycleKind === "killed") {
        sfx.playAt("target_down", point, {
          ...combatImpactSpatialOptions(meleePresentation, "down"),
          volume: 0.72,
        });
      }
    }
    recordCombatVisualLog(state, event, lifecycleKind);
    return;
  }
  const visualCadence = combatVisualCadenceFor(state, event.targetActorId, lifecycleKind);
  if (bleedoutLifecycle) {
    spawnFloatingStatusText(state, actorPos, "BLEEDOUT", "#8af5d1", target.id);
  } else if (visualCadence.showFloatingDamage) {
    spawnFloatingDamage(state, actorPos, event.damage, event.zone, downed, target.id);
  }
  recordCombatVisualLog(state, event, lifecycleKind);
  if (!rollAudioDeferred) {
    if (lifecycleKind === "downed" || lifecycleKind === "killed") {
      sfx.playAt("target_down", point, {
        ...combatImpactSpatialOptions(meleePresentation, "down"),
        volume: lifecycleKind === "killed" ? 1 : 0.92,
      });
    } else {
      sfx.playAt(bodyHitSfxId(event.id), point, {
        ...combatImpactSpatialOptions(meleePresentation, "body"),
        volume: bodyHitSfxVolume(visualCadence),
        playbackRate: bodyHitSfxPlaybackRate(event.id),
      });
    }
  }
}

function fallbackCombatEventTarget(event: GameCombatEvent, activeAreaId: string): ServerAuthorityActorState | null {
  if (!event.hitPoint) return null;
  const health = event.lifeState === "alive" ? Math.max(0, 100 - Math.max(0, event.damage)) : 0;
  return {
    id: event.targetActorId,
    label: event.targetActorId,
    areaId: activeAreaId,
    x: event.hitPoint.x - 0.5,
    y: event.hitPoint.y - 0.45,
    direction: "right",
    lifeState: event.previousLifeState,
    lifecycleSeq: typeof event.targetLifecycleSeq === "number" ? event.targetLifecycleSeq : 1,
    vitals: { health, action: 100, spirit: 100 },
    maxVitals: { health: 100, action: 100, spirit: 100 },
    bleed: {
      active: false,
      stackCount: event.bleedStackCount,
      severity: 0,
      remainingMs: 0,
      ratesPerSecond: { health: 0, action: 0, spirit: 0 },
    },
    statuses: [],
  };
}

function cloneServerAuthorityActorState(actor: ServerAuthorityActorState): ServerAuthorityActorState {
  return {
    ...actor,
    vitals: { ...actor.vitals },
    maxVitals: { ...actor.maxVitals },
    bleed: {
      ...actor.bleed,
      ratesPerSecond: { ...actor.bleed.ratesPerSecond },
    },
    statuses: actor.statuses.map((status) => ({ ...status })),
    personalShield: cloneGameActorPersonalShield(actor.personalShield),
    professions: cloneGameActorProfessions(actor.professions),
    activeTitle: cloneGameActorProfessionTitle(actor.activeTitle),
    interpolationSamples: actor.interpolationSamples?.map((sample) => ({ ...sample })),
  };
}

function recordCombatVisualLog(
  state: PlayState,
  event: GameCombatEvent,
  lifecycleKind: "hit" | "downed" | "killed",
): void {
  state.serverAuthority.visualLog.push({
    eventId: event.id,
    commandId: event.commandId ?? null,
    targetActorId: event.targetActorId,
    atMs: Number(state.worldTimeMs.toFixed(3)),
    lifecycleKind,
    lifecycleCause: event.lifecycle?.cause ?? "hit",
    floatingTextCount: state.floatingTexts.length,
  });
  if (state.serverAuthority.visualLog.length > maxServerAuthorityEventLog) {
    state.serverAuthority.visualLog.splice(0, state.serverAuthority.visualLog.length - maxServerAuthorityEventLog);
  }
}

function positiveModulo(value: number, divisor: number): number {
  return ((value % divisor) + divisor) % divisor;
}

function syncSleepEffectStatus(state: PlayState, event: GameCombatEvent): void {
  const effect = event.effect;
  if (effect?.kind !== "sleep") return;
  const combat = state.actors[event.targetActorId];
  if (!combat) return;
  if (effect.stacks >= effect.threshold) {
    combat.statuses = combat.statuses.filter((status) => status.id !== "sleeping");
    return;
  }
  const label = "Sleeping";
  const severity = Math.max(1, Math.min(9, effect.stacks));
  const existing = combat.statuses.find((status) => status.id === "sleeping");
  if (existing) {
    existing.label = label;
    existing.severity = severity;
    existing.ttlMs = Math.max(0, effect.remainingMs);
    existing.stacks = effect.stacks;
    existing.threshold = effect.threshold;
    return;
  }
  combat.statuses.push({
    id: "sleeping",
    label,
    severity,
    ttlMs: Math.max(0, effect.remainingMs),
    stacks: effect.stacks,
    threshold: effect.threshold,
  });
}

function applyAuthoritativeHitReaction(
  state: PlayState,
  event: GameCombatEvent,
  lifecycleKind: "hit" | "downed" | "killed",
): void {
  const combat = state.actors[event.targetActorId];
  if (!combat) return;
  combat.hitFlashMs = Math.max(
    combat.hitFlashMs,
    lifecycleKind === "hit" ? authoritativeHitFlashMs : authoritativeDownedHitFlashMs,
  );
}

function applyCombatEventLifecycleState(
  state: PlayState,
  event: GameCombatEvent,
  target: ServerAuthorityActorState,
  lifecycleKind: "hit" | "downed" | "killed",
): void {
  const targetLifecycleSeq = typeof event.targetLifecycleSeq === "number" ? event.targetLifecycleSeq : target.lifecycleSeq;
  target.lifecycleSeq = targetLifecycleSeq;
  const combat = state.actors[event.targetActorId];
  if (combat) {
    const previousLifecycleSeq = combat.lifecycleSeq;
    if (previousLifecycleSeq !== targetLifecycleSeq) invalidateActorPresentationCaches(state, event.targetActorId);
    combat.lifecycleSeq = targetLifecycleSeq;
  }
  if (event.lifeState === "alive" && lifecycleKind === "hit") return;

  target.lifeState = event.lifeState;
  if (event.lifeState !== "alive") {
    target.vitals = {
      health: Math.min(0, target.vitals.health),
      action: Math.min(0, target.vitals.action),
      spirit: Math.min(0, target.vitals.spirit),
    };
    delete state.actorPresentationFrames[event.targetActorId];
  }

  if (!combat) return;
  combat.lifeState = event.lifeState;
  combat.downed = event.lifeState !== "alive";
  if (event.lifeState !== "alive") {
    combat.downedCell = { x: target.x, y: target.y };
    delete state.actorPresentationFrames[event.targetActorId];
    if (event.lifeState === "respawning") {
      removeAuthorityActorState(state, event.targetActorId, state.serverAuthority.playerActorId);
      return;
    }
    combat.vitals = {
      health: Math.min(0, combat.vitals.health),
      action: Math.min(0, combat.vitals.action),
      spirit: Math.min(0, combat.vitals.spirit),
    };
  }

  const lifecycleStatus = combatStatusForLifecycleEvent(event, lifecycleKind);
  if (!lifecycleStatus) return;
  combat.statuses = [
    ...combat.statuses.filter((status) => status.id !== "dead" && status.id !== "downed" && status.id !== "evacuating"),
    lifecycleStatus,
  ];
}

function combatStatusForLifecycleEvent(
  event: GameCombatEvent,
  lifecycleKind: "hit" | "downed" | "killed",
): CombatStatus | null {
  if (event.lifeState === "alive") return null;
  if (lifecycleKind === "killed" || event.lifeState === "respawning") {
    return { id: "dead", label: "Dead", severity: 3, ttlMs: 30_000 };
  }
  return { id: "downed", label: "Downed", severity: 3, ttlMs: 14_000 };
}

function isBleedoutLifecycleEvent(event: GameCombatEvent): boolean {
  return event.lifecycle?.cause === "bleedout" || event.lifecycle?.cause === "downed expiration";
}

function combatVisualCadenceFor(
  state: PlayState,
  targetActorId: string,
  lifecycleKind: "hit" | "downed" | "killed",
): { major: boolean; showFloatingDamage: boolean } {
  if (lifecycleKind === "downed" || lifecycleKind === "killed") {
    return { major: true, showFloatingDamage: true };
  }
  let cadenceByTarget = combatVisualCadenceByState.get(state);
  if (!cadenceByTarget) {
    cadenceByTarget = new Map();
    combatVisualCadenceByState.set(state, cadenceByTarget);
  }
  const now = state.worldTimeMs;
  const previous = cadenceByTarget.get(targetActorId);
  const burstIndex = previous && now - previous.lastAtMs <= rapidCombatVisualWindowMs
    ? previous.burstIndex + 1
    : 0;
  cadenceByTarget.set(targetActorId, { lastAtMs: now, burstIndex });
  const major = burstIndex === 0 || burstIndex % rapidCombatMajorEvery === 0;
  return {
    major,
    showFloatingDamage: true,
  };
}

function toRuntimeActor(
  actor: GameActorSnapshot,
  previous: ServerAuthorityActorState | undefined,
  receivedAtMs: number,
  tick?: number,
): ServerAuthorityActorState {
  const shouldResetRender = shouldResetRemoteActorInterpolation(actor, previous);
  const renderX = shouldResetRender ? actor.x : previous?.renderX ?? previous?.x ?? actor.x;
  const renderY = shouldResetRender ? actor.y : previous?.renderY ?? previous?.y ?? actor.y;
  const interpolationSamples = actorInterpolationSamples(actor, previous, receivedAtMs, shouldResetRender, tick);
  const lifecycleSeq = typeof actor.lifecycleSeq === "number" ? actor.lifecycleSeq : previous?.lifecycleSeq ?? 1;
  const appearance = normalizeAuthorityActorAppearance(actor.appearance, previous?.appearance);
  const wornColors = mergeAuthorityActorWornColors(actor.wornColors, actor.worn);
  return {
    ...actor,
    lifecycleSeq,
    displayName: typeof actor.display_name === "string" && actor.display_name.length > 0 ? actor.display_name : actor.label,
    linkDead: actor.link_dead === true,
    appearance,
    ...(wornColors ? { wornColors } : {}),
    statuses: actor.statuses.map(authorityStatusSnapshot),
    personalShield: cloneGameActorPersonalShield(actor.personalShield),
    weapon: cloneGameActorWeapon(actor.weapon),
    professions: cloneGameActorProfessions(actor.professions),
    activeTitle: cloneGameActorProfessionTitle(actor.activeTitle),
    direction: normalizeDirection(actor.direction),
    renderX,
    renderY,
    receivedAtMs,
    interpolationSamples,
  };
}

function authorityStatusSnapshot(status: GameActorStatusSnapshot): ServerAuthorityActorState["statuses"][number] {
  return {
    ...status,
    id: structuredCombatStatusId(status.id),
  };
}

function actorInterpolationSamples(
  actor: GameActorSnapshot,
  previous: ServerAuthorityActorState | undefined,
  receivedAtMs: number,
  shouldReset: boolean,
  tick?: number,
) {
  const sample = {
    x: actor.x,
    y: actor.y,
    receivedAtMs,
    ...(Number.isFinite(tick) ? { tick: Math.max(0, Math.trunc(tick as number)) } : {}),
  };
  if (!previous || shouldReset) return [sample];

  const samples = [...(previous.interpolationSamples ?? [{
    x: previous.x,
    y: previous.y,
    receivedAtMs: previous.receivedAtMs ?? receivedAtMs,
    ...(Number.isFinite(tick) ? { tick: Math.max(0, Math.trunc(tick as number)) } : {}),
  }])];
  const last = samples.at(-1);
  const sampleTick = typeof sample.tick === "number" ? sample.tick : null;
  const lastTick = typeof last?.tick === "number" ? last.tick : null;
  if (
    !last
    || Math.abs(last.x - sample.x) > 0.0005
    || Math.abs(last.y - sample.y) > 0.0005
    || (sampleTick !== null && lastTick !== null && sampleTick > lastTick)
    || (sampleTick !== null && lastTick === null)
    || sample.receivedAtMs - last.receivedAtMs > 1
  ) {
    samples.push(sample);
  } else if (last) {
    last.receivedAtMs = sample.receivedAtMs;
    if (sampleTick !== null) last.tick = sampleTick;
  }
  return samples
    .filter((entry) => receivedAtMs - entry.receivedAtMs <= 900)
    .slice(-remoteActorInterpolationSampleLimit);
}

function shouldResetRemoteActorInterpolation(
  actor: GameActorSnapshot,
  previous: ServerAuthorityActorState | undefined,
): boolean {
  if (!previous) return true;
  return actor.areaId !== previous.areaId
    || actor.lifeState !== previous.lifeState
    || actor.lifecycleSeq !== previous.lifecycleSeq
    || Math.hypot(actor.x - previous.x, actor.y - previous.y) > remoteActorInterpolationResetCells;
}

function actorSnapshotFromPatch(previous: ServerAuthorityActorState, patch: GameActorPatch): GameActorSnapshot {
  const wornColors = mergeAuthorityActorWornColors(
    patch.wornColors ?? previous.wornColors,
    patch.worn ?? previous.worn,
  );
  return {
    id: patch.id,
    label: patch.label ?? previous.label,
    display_name: patch.display_name === undefined ? previous.displayName : patch.display_name,
    descriptor: patch.descriptor === undefined ? previous.descriptor : patch.descriptor,
    link_dead: patch.link_dead === undefined ? previous.linkDead : patch.link_dead,
    appearance: patch.appearance === undefined
      ? normalizeAuthorityActorAppearance(previous.appearance)
      : normalizeAuthorityActorAppearance(patch.appearance, previous.appearance),
    ...((patch.worn ?? previous.worn) ? { worn: normalizeAuthorityActorWorn(patch.worn ?? previous.worn ?? []) } : {}),
    ...(wornColors ? { wornColors } : {}),
    sprite: patch.sprite === undefined ? previous.sprite : normalizeActorSprite(patch.sprite),
    role: patch.role === undefined ? previous.role : normalizeActorRole(patch.role),
    areaId: patch.areaId ?? previous.areaId,
    x: patch.x ?? previous.x,
    y: patch.y ?? previous.y,
    direction: patch.direction ?? previous.direction,
    lifeState: patch.lifeState ?? previous.lifeState,
    lifecycleSeq: patch.lifecycleSeq ?? previous.lifecycleSeq,
    vitals: patch.vitals ?? previous.vitals,
    maxVitals: patch.maxVitals ?? previous.maxVitals,
    bleed: patch.bleed ?? previous.bleed,
    statuses: patch.statuses ?? previous.statuses,
    personalShield: patch.personalShield === undefined
      ? cloneGameActorPersonalShield(previous.personalShield)
      : cloneGameActorPersonalShield(patch.personalShield),
    weapon: patch.weapon === undefined
      ? cloneGameActorWeapon(previous.weapon)
      : cloneGameActorWeapon(patch.weapon),
    bodyVanishAtTick: patch.bodyVanishAtTick ?? previous.bodyVanishAtTick,
    respawnAtTick: patch.respawnAtTick ?? previous.respawnAtTick,
    nextSampleTick: patch.nextSampleTick ?? previous.nextSampleTick,
    cloneSicknessRemainingMs: patch.cloneSicknessRemainingMs ?? previous.cloneSicknessRemainingMs ?? 0,
    incapRemainingMs: patch.incapRemainingMs ?? previous.incapRemainingMs ?? 0,
    incapCount: patch.incapCount ?? previous.incapCount ?? 0,
    incapWindowMs: patch.incapWindowMs ?? previous.incapWindowMs ?? 0,
    factionId: patch.factionId === undefined ? previous.factionId : patch.factionId,
    socialGroup: patch.socialGroup === undefined ? previous.socialGroup : patch.socialGroup,
    pvpStatus: patch.pvpStatus === undefined ? previous.pvpStatus : patch.pvpStatus,
    aiAttitude: patch.aiAttitude === undefined ? previous.aiAttitude : patch.aiAttitude ?? undefined,
    willAutoAggro: patch.willAutoAggro === undefined ? previous.willAutoAggro : patch.willAutoAggro,
    playerOrganizationId: patch.playerOrganizationId === undefined ? previous.playerOrganizationId : patch.playerOrganizationId,
    playerOrganizationTag: patch.playerOrganizationTag === undefined ? previous.playerOrganizationTag : patch.playerOrganizationTag,
    posture: patch.posture ?? previous.posture ?? "standing",
    postureUntilTick: patch.postureUntilTick ?? previous.postureUntilTick ?? 0,
    // combatQueue is tri-state: absent = unchanged, null = cleared, object = set.
    combatQueue: patch.combatQueue === undefined ? previous.combatQueue : patch.combatQueue ?? undefined,
    inCombat: patch.inCombat === undefined ? previous.inCombat : patch.inCombat,
    peaceRequested: patch.peaceRequested === undefined ? previous.peaceRequested : patch.peaceRequested,
    engagementTargetId: patch.engagementTargetId === undefined ? previous.engagementTargetId : patch.engagementTargetId ?? undefined,
    lootable: patch.lootable === undefined ? previous.lootable : patch.lootable,
    hasLoot: patch.hasLoot === undefined ? previous.hasLoot : patch.hasLoot,
    lootRightsActorId: patch.lootRightsActorId === undefined ? previous.lootRightsActorId : patch.lootRightsActorId,
    bodyVanishTick: patch.bodyVanishTick ?? previous.bodyVanishTick,
    professions: patch.professions ?? previous.professions,
    activeTitle: patch.activeTitle ?? previous.activeTitle,
    skillPointsUsed: patch.skillPointsUsed ?? previous.skillPointsUsed,
    skillPointsCap: patch.skillPointsCap ?? previous.skillPointsCap,
    credits: patch.credits ?? previous.credits,
    shotSpreadDegreesMilli: patch.shotSpreadDegreesMilli ?? previous.shotSpreadDegreesMilli,
    // Mobility is sparse in compact patches; preserve the last authority
    // projection until an explicit sprint-lock update arrives.
    mobility: patch.mobility === undefined ? previous.mobility : patch.mobility,
  };
}

function bleedFromSnapshot(bleed: GameActorSnapshot["bleed"]): BleedState {
  if (!bleed.active) return createInactiveBleedState();
  return {
    active: true,
    severity: bleed.severity,
    stackCount: bleed.stackCount,
    remainingMs: bleed.remainingMs,
    ratesPerSecond: { ...bleed.ratesPerSecond },
  };
}

function statusFromSnapshot(status: GameActorStatusSnapshot): CombatStatus {
  return {
    id: structuredCombatStatusId(status.id),
    label: status.label,
    severity: Math.max(1, Math.min(9, Math.round(status.severity))),
    ttlMs: Math.max(0, status.remainingMs),
    stacks: status.stacks,
    threshold: status.threshold,
  };
}

function structuredCombatStatusId(id: string): CombatStatusId {
  const normalized = id.toLowerCase();
  return isCombatStatusId(normalized) ? normalized : "staggered";
}


function isCombatStatusId(value: string): value is CombatStatusId {
  return value === "bleeding"
    || value === "suppressed"
    || value === "sleeping"
    || value === "staggered"
    || value === "arm_hit"
    || value === "limping"
    || value === "downed"
    || value === "dead"
    || value === "evacuating"
    || value === "stabilized"
    || value === "medic-prep"
    || value === "entertainer-session"
    || value === "stimpak_a_heal"
    || value === "reloading"
    || value === "clone_sickness";
}

function bodyHitSfxId(seed: number): string {
  return `body_hit_${(seed % 4) + 1}`;
}

function bodyHitSfxVolume(visualCadence: { major: boolean }): number {
  return visualCadence.major ? 0.58 : 0.34;
}

function bodyHitSfxPlaybackRate(seed: number): number {
  return 0.94 + (positiveModulo(seed * 37, 13) / 100);
}

function combatImpactSpatialOptions(
  meleePresentation: boolean,
  weight: "light" | "body" | "down",
): SfxPlayOptions {
  const maxDistanceCells = meleePresentation
    ? (weight === "light" ? 11 : weight === "body" ? 14 : 18)
    : (weight === "light" ? 22 : weight === "body" ? 24 : 28);
  return {
    minDistanceCells: meleePresentation ? 1.25 : 1.75,
    maxDistanceCells,
    panDistanceCells: meleePresentation ? 7 : 11,
    maxPan: 0.9,
    rolloff: meleePresentation ? 2.1 : 1.7,
    farGainFloor: 0,
  };
}

function dartImpactSfxId(seed: number): string {
  return indexedSfxId("dart_flesh_tick", seed, 4);
}

function sleepPuffSfxId(seed: number): string {
  return indexedSfxId("sleep_puff_soft", seed, 4);
}

function indexedSfxId(prefix: string, seed: number, count: number): string {
  return `${prefix}_${String((seed % count) + 1).padStart(2, "0")}`;
}

export function authorityCommandEnvelopeProbe(envelope: AuthorityClientCommandEnvelope): string {
  return `${envelope.command_id}:${authorityCommandKind(envelope.command)}`;
}
