import { baseActorMaxVitals, baseActorVitals } from "./actorArchetypes";
import { defaultAmmoTypeForCaliber, type AmmoCaliberId, type AmmoTypeId } from "./ammoSystem";
import {
  authorityMoveCommandIntervalMs,
  createAuthorityCommandQueue,
  type AuthorityClientCommandKind,
  type AuthorityCommandQueue,
} from "./authorityCommandSystem";
import type {
  ActorLifeState,
  ActorVitals,
  BodyZone,
  DeathPhase,
} from "./combatTypes";
import {
  createInactiveBleedState,
  type ActorCombatState,
  type CombatStatus,
} from "./combatReducer";
import type { FloatingCombatText } from "./effectsSystem";
import { normalizeDirection, type Cell, type Direction } from "./geometry";
import { buildBlockedCells, buildMovementBlockers } from "./worldQueries";
import {
  professionDefinitions,
  skillNodeDefinitions,
  type AbilityId,
  type ProfessionId,
  type ProfessionProgress,
  type ProgressionState,
} from "./progressionSystem";
import type { MovementBlocker, MovementInputMode } from "./movementSystem";
import type { EquipmentSlot, WeaponId } from "./weaponSystem";
import { createRuntimeWorldClock, type RuntimeWorldClockState } from "./worldClockSystem";
import { createDefaultRuntimeSettings, type InputActionId, type RuntimeSettings } from "./settingsSystem";
import type {
  AreaSnapshot,
  AreaTransitionSnapshot,
  BlockedCellSnapshot,
  CloneFacilitySnapshot,
  PropSnapshot,
} from "./worldTypes";

export interface ActorSnapshot {
  id: string;
  entity: string;
  templateId?: string | null;
  areaId: string;
  label: string;
  guildTag?: string | null;
  role: string;
  professionIds?: string[];
  skillBoxIds?: string[];
  credits?: number;
  capabilities?: string[];
  careerGoalId?: string | null;
  factionId?: string | null;
  socialGroup?: string | null;
  pvpStatus?: "none" | "covert" | "overt" | string | null;
  aiAttitude?: ServerAuthorityAiAttitude;
  playerOrganizationId?: string | null;
  playerOrganizationTag?: string | null;
  sprite: string;
  poseSet: string;
  direction: string;
  cell: Cell;
  route: Cell[];
  scale?: number;
  static?: boolean;
  vitals?: ActorVitals;
  maxVitals?: ActorVitals;
}

export interface ActorTargetSummary {
  id: string;
  name: string;
  self: boolean;
  role: string;
  entity: string;
  guildTag: string | null;
  vitals: ActorVitals;
  maxVitals: ActorVitals;
  lifeState: ActorLifeState;
  statuses: CombatStatus[];
}

export interface InventoryRow {
  container: string;
  item: string;
  itemId: number;
  variantId: number;
  quantity: number;
  reserved: number;
  available: number;
  /** Full Rust-authoritative resource stat block; absent for non-resources or invalid encodings. */
  resourceStats?: ServerAuthorityResourceStatsState;
  /** Optional structured resource potency (1-1000); additive for older rows. */
  potency?: number;
  /** Optional structured resource purity (Rust chemical_purity, 1-1000); additive for older rows. */
  purity?: number;
  /** Stable per-container stack identity (u64 as JSON number in snapshots; commands send it as a decimal string). */
  stackId?: number;
  /** Additive stable string item id for non-Rust or metadata-heavy items. */
  itemKey?: string;
  /** Rust-authoritative creator-clothing equipment state, when present on an inventory row. */
  equipped?: boolean;
  /** Exact Rust-authoritative creator-clothing color selections, when present on an inventory row. */
  colors?: string[];
  /** Additive structured item metadata; travel tickets use metadata.travelTicket. */
  metadata?: Record<string, unknown>;
}

export interface ReservationRow {
  id: number;
  actor: string;
  purpose: string;
  from: string;
  item: string;
  quantity: number;
  expiresAtTick: number | null;
}

export interface InventoryTransferPromptState {
  action: "store-exchange" | "retrieve-exchange";
  itemId: number;
  variantId: number;
  itemName: string;
  maxQuantity: number;
  quantity: number;
}

export interface TimelineEvent {
  tick: number;
  label: string;
  cell: Cell | null;
}

export interface NpcJobSnapshot {
  actor: string;
  kind: string;
  label: string;
  targetPropId: string | null;
  targetCell: Cell | null;
  priority: number;
  state: string;
}

export interface FactionSnapshot {
  id: string;
  label: string;
  playerAllowed?: boolean;
  enemies?: string[];
  allies?: string[];
  adjustFactorMilli?: number;
}

export interface PlayerOrganizationSnapshot {
  id: string;
  label: string;
  tag: string;
  memberActorIds?: string[];
  allyOrganizationIds?: string[];
  enemyOrganizationIds?: string[];
}

export interface PopulationTemplateSnapshot {
  id: string;
  labelPrefix: string;
  labels?: string[];
  role: string;
  factionId?: string | null;
  socialGroup?: string | null;
  pvpStatus?: "none" | "covert" | "overt" | string | null;
  playerOrganizationId?: string | null;
  playerOrganizationTag?: string | null;
  professionIds?: string[];
  skillBoxIds?: string[];
  credits?: number;
  capabilities?: string[];
  careerGoalId?: string | null;
  sprite: string;
  poseSet: string;
  direction: string;
  scale?: number;
  vitals?: ActorVitals;
  maxVitals?: ActorVitals;
}

export interface PopulationSpawnZoneSnapshot {
  id: string;
  actorIdPrefix: string;
  templateId: string;
  areaId: string;
  candidateCells?: Cell[];
  initialCount?: number;
  maxAlive?: number;
  spawnEverySeconds?: number;
  batchMin?: number;
  batchMax?: number;
  seed?: number;
}

export interface TravelTicketDataSnapshot {
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

export interface TravelCatalogCitySnapshot {
  id: string;
  label: string;
  terminalPropId: string;
  spawn: Cell;
}

export interface TravelCatalogPlanetSnapshot {
  id: string;
  label: string;
  biome: "desert" | "forest" | string;
  areaId: string;
  cities: TravelCatalogCitySnapshot[];
}

export interface TravelCatalogSnapshot {
  schema: "successor.travel-catalog.v1" | string;
  planets: TravelCatalogPlanetSnapshot[];
}

export interface SliceWeatherPeriodTicks {
  idle: number;
  warning: number;
  active: number;
  decay: number;
}

export interface SliceWeatherConfig {
  areaId: string;
  eventType: string;
  centerCell: Cell;
  radiusCells: number;
  spawnRadiusCells?: number;
  magnitudeRange?: [number, number];
  periodTicks: SliceWeatherPeriodTicks;
  dpsMilliHealth: number;
  phaseOffsetTicks?: number;
  sweepDirRad?: number;
}

export interface SliceSnapshot {
  schema: string;
  tick: number;
  tickRateHz: number;
  /** Successor's server-authoritative combat contract. */
  combatModel: "roll";
  grid: {
    cellSizePx: number;
  };
  zone: {
    id: number;
    name: string;
    width: number;
    height: number;
    level: number;
  };
  areas: AreaSnapshot[];
  worldSeed?: number;
  stateHash: string;
  camera: {
    followActor: string;
    zoom: number;
  };
  factions?: FactionSnapshot[];
  playerOrganizations?: PlayerOrganizationSnapshot[];
  populationTemplates?: PopulationTemplateSnapshot[];
  spawnZones?: PopulationSpawnZoneSnapshot[];
  actors: ActorSnapshot[];
  props: PropSnapshot[];
  blockedCells: BlockedCellSnapshot[];
  transitions: AreaTransitionSnapshot[];
  cloneFacilities?: CloneFacilitySnapshot[];
  travelCatalog?: TravelCatalogSnapshot;
  weather?: SliceWeatherConfig[];
  /** Roll-combat tuning overrides (weapon range band distances, cells). */
  combatTuning?: {
    weaponRangeBands?: Record<string, { pointBlankCells: number; idealCells: number; maxCells: number }>;
  };
  inventory: InventoryRow[];
  reservations: ReservationRow[];
  npcJobs?: NpcJobSnapshot[];
  events: TimelineEvent[];
}

export function declaredSliceActorCount(slice: Pick<SliceSnapshot, "actors" | "spawnZones">): number {
  const authoredCount = Array.isArray(slice.actors) ? slice.actors.length : 0;
  const initialGeneratedCount = (slice.spawnZones ?? []).reduce((total, zone) => {
    const count = typeof zone.initialCount === "number" && Number.isFinite(zone.initialCount)
      ? Math.max(0, Math.trunc(zone.initialCount))
      : 0;
    return total + count;
  }, 0);
  return authoredCount + initialGeneratedCount;
}

export interface SpatialChatBubble {
  body: string;
  sender: string;
  own: boolean;
  actorId?: string;
  ttlMs: number;
  totalTtlMs: number;
}

export interface RuntimeCombatAudioShooterState {
  weaponId: WeaponId;
  firstShotAtMs: number;
  lastShotAtMs: number;
  lastTailAtMs: number;
  shotCount: number;
  burstEnded: boolean;
  lastSeed: number;
  lastPosition: Cell;
}

export interface RuntimeCombatAudioEvent {
  kind: string;
  actorId: string | null;
  weaponId: WeaponId | null;
  atMs: number;
  seed: number;
  distanceCells?: number | null;
  gain?: number | null;
  pan?: number | null;
}

export interface RuntimeCombatAudioMetrics {
  shotEvents: number;
  transientPlays: number;
  burstStarts: number;
  burstContinuations: number;
  burstTailPlays: number;
  burstTailSuppressions: number;
  casingLayerPlays: number;
  duplicateShotEventSuppressions: number;
  weaponSpatialSamples: number;
  weaponSpatialGainSum: number;
  weaponSpatialGainMin: number | null;
  weaponSpatialGainMax: number | null;
  weaponSpatialNearEvents: number;
  weaponSpatialMidEvents: number;
  weaponSpatialFarEvents: number;
  weaponSpatialPanAbsSum: number;
  weaponSpatialPanAbsMax: number;
  recentEvents: RuntimeCombatAudioEvent[];
}

export interface RuntimeCombatAudioState {
  shooterBursts: Record<string, RuntimeCombatAudioShooterState>;
  playedShotAudio: Record<string, number>;
  metrics: RuntimeCombatAudioMetrics;
}

export type AbilityToolbarBinding =
  | { kind: "ability"; abilityId: AbilityId }
  | {
    kind: "item";
    itemId: number;
    variantId: number;
    commandId: string;
    label: string;
  };

export interface AbilityToolbarState {
  slots: Array<AbilityToolbarBinding | null>;
  browserOpen: boolean;
  lastMessage: string | null;
  lastFlashSlot: number | null;
  lastErrorSlot: number | null;
}

export interface NpcFootstepTracker {
  distanceCells: number;
  lastStepAtMs: number;
  index: number;
  lastX: number;
  lastY: number;
}

export interface RuntimeAudioState {
  ambientAreaId: string | null;
  loopVolumes: Record<string, number>;
  nextOneShotAtMs: Record<string, number>;
  footstepDistanceCells: number;
  footstepIndex: number;
  lastFootstepPlayer: Cell | null;
  lastStepAtMs: number;
  lastCombatAudioAtMs: number;
  activeCombatMusicId: string | null;
  combat: RuntimeCombatAudioState;
  /** Per-actor accumulated travel for positional NPC footsteps (ambientAudioSystem). */
  npcFootsteps?: Record<string, NpcFootstepTracker>;
  /** Runtime-only pull-loop latch armed by accepted SampleResource receipts. */
  surveyPullLoopActive?: boolean;
  surveyPullLoopUntilMs?: number | null;
}

export function createRuntimeCombatAudioState(): RuntimeCombatAudioState {
  return {
    shooterBursts: {},
    playedShotAudio: {},
    metrics: {
      shotEvents: 0,
      transientPlays: 0,
      burstStarts: 0,
      burstContinuations: 0,
      burstTailPlays: 0,
      burstTailSuppressions: 0,
      casingLayerPlays: 0,
      duplicateShotEventSuppressions: 0,
      weaponSpatialSamples: 0,
      weaponSpatialGainSum: 0,
      weaponSpatialGainMin: null,
      weaponSpatialGainMax: null,
      weaponSpatialNearEvents: 0,
      weaponSpatialMidEvents: 0,
      weaponSpatialFarEvents: 0,
      weaponSpatialPanAbsSum: 0,
      weaponSpatialPanAbsMax: 0,
      recentEvents: [],
    },
  };
}


export interface AmmoState {
  loaded: number;
  reserve: number;
}

export interface LoadoutState {
  equipped: Record<EquipmentSlot, WeaponId | null>;
  activeWeaponId: WeaponId | null;
  ammo: Record<AmmoCaliberId, AmmoState>;
  activeAmmo: Record<AmmoCaliberId, AmmoTypeId>;
  unlimitedAmmo: boolean;
}

export interface PlayerDeathState {
  phase: DeathPhase;
  deaths: number;
  downedAtMs: number | null;
  downedRemainingMs: number;
  lastCause: string | null;
  cloneFacilityId: string | null;
  cloneFacilityLabel: string | null;
}

export interface ServerAuthorityProfessionState {
  id: string;
  label: string;
  xp: number;
  trackXp?: Record<string, number>;
  skillPoints: number;
  skillBoxes?: string[];
}

export interface ServerAuthorityProfessionTitleState {
  id: string;
  label: string;
  skillBoxId: string;
}

export interface InteractionOption {
  id: string;
  kind: "exchange" | "corpse" | "trainer" | "lootCache" | "travelTerminal" | "bankTerminal" | "cloneTerminal" | "factoryTerminal" | "paTerminal" | "door" | "extractor" | "camp";
  label: string;
  detail: string;
  targetId: string;
  distanceCells: number;
  doorOpen?: boolean;
  /** Authored loot container identity, when present on the source prop. */
  container?: string;
  takeOnly?: boolean;
}

export interface ServerAuthorityPropState {
  cacheEmptied?: boolean;
  doorOpen?: boolean;
}

export interface InteractionRuntimeState {
  options: InteractionOption[];
  menuOpen: boolean;
  selectedIndex: number;
  lastPrompt: string | null;
}

export interface ProfessionUiState {
  selectedProfessionId: ProfessionId | null;
  showAll: boolean;
  trainerActorId: string | null;
}

export interface ServerAuthorityStatusState {
  id: string;
  label: string;
  severity: number;
  remainingMs: number;
  stacks?: number;
  threshold?: number;
}

export type ActorPosture = "standing" | "kneeling_down" | "kneeling" | "standing_up";
export type ServerAuthorityAiAttitude = "passive" | "alerted" | "hostile";

/** Face-kit selection streamed with appearance (snake_case wire shape). */
export interface ServerAuthorityActorFaceState {
  eyes: string;
  brows: string;
  nose: string;
  mouth: string;
  eye_color: string;
  brow_color: string;
  lip_color: string;
}

export interface ServerAuthorityActorAppearanceState {
  skin: string;
  hair: string | null;
  hair_mat: string;
  face: ServerAuthorityActorFaceState | null;
}

/** One worn wardrobe piece from the authority wire (creator outfit). */
export interface ServerAuthorityActorWornPiece {
  item: string;
  colors: string[];
}



export interface ServerAuthorityCombatQueueState {
  nextReadyTick: number;
  entries: Array<{ actionId: string; targetActorId: string; auto?: boolean }>;
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

export interface AbilityQueueRuntimeState {
  view: AbilityQueueView | null;
  events: AbilityQueueEvent[];
}

export interface ServerAuthorityActorState {
  id: string;
  label: string;
  displayName?: string;
  /** actor descriptor (lowercase-article, e.g. "a rogue drifter"); empty/absent for players. */
  descriptor?: string;
  linkDead?: boolean;
  appearance?: ServerAuthorityActorAppearanceState;
  worn?: ServerAuthorityActorWornPiece[];
  /** Durable creator palette cache from the authority wire (may include unequipped pieces). */
  wornColors?: Record<string, string[]>;
  role?: string | null;
  sprite?: string | null;
  areaId: string;
  x: number;
  y: number;
  direction: Direction;
  lifeState: ActorLifeState;
  lifecycleSeq: number;
  vitals: ActorVitals;
  maxVitals: ActorVitals;
  bleed: {
    active: boolean;
    stackCount: number;
    severity: number;
    remainingMs: number;
    ratesPerSecond: ActorVitals;
  };
  personalShield?: ServerAuthorityPersonalShieldState | null;
  weapon?: ServerAuthorityWeaponState | null;
  statuses: ServerAuthorityStatusState[];
  bodyVanishAtTick?: number;
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
  /** Threat legibility (server-derived): auto-aggro (red) vs provoked-only (yellow). */
  willAutoAggro?: boolean;
  playerOrganizationId?: string | null;
  playerOrganizationTag?: string | null;
  professions?: ServerAuthorityProfessionState[];
  activeTitle?: ServerAuthorityProfessionTitleState | null;
  careerGoalId?: string | null;
  skillPointsUsed?: number;
  skillPointsCap?: number;
  credits?: number;
  shotSpreadDegreesMilli?: number;
  posture?: ActorPosture;
  postureUntilTick?: number;
  /** Roll-combat: true while the actor's combat linger window is open (drives stow/unsling). */
  inCombat?: boolean;
  /** Roll-combat: true after /peace suppresses server auto-return-fire. */
  peaceRequested?: boolean;
  /** Roll-combat: authoritative actor id this pawn is engaged with, used for idle facing. */
  engagementTargetId?: string | null;
  /** Loot: server-authoritative lootable-corpse flag (dead body, loot window may open). */
  lootable?: boolean;
  /** Loot: corpse container still holds items. */
  hasLoot?: boolean;
  /** Loot: exclusive loot-rights holder actor id; null/absent = free loot. */
  lootRightsActorId?: string | null;
  /** Loot: authority tick when the body despawns (unclaimed loot poofs with it). */
  bodyVanishTick?: number;
  /** Roll-combat: pending action queue (UI strip); absent when idle. */
  combatQueue?: ServerAuthorityCombatQueueState;
  /** Sprint recovery projection: sim locks sprint at Action exhaustion and
   *  clears only at full Action; absent (older snapshots) reads unlocked. */
  mobility?: { sprintRecoveryLocked?: boolean } | null;
  renderX?: number;
  renderY?: number;
  /** Rendered visual velocity in cells/second (not a per-frame delta). */
  renderVelocityX?: number;
  /** Rendered visual velocity in cells/second (not a per-frame delta). */
  renderVelocityY?: number;
  receivedAtMs?: number;
  interpolationSamples?: ServerAuthorityActorSample[];
}

export interface ServerAuthorityPersonalShieldState {
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

export interface ServerAuthorityWeaponState {
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

export interface ServerAuthorityActorSample {
  x: number;
  y: number;
  receivedAtMs: number;
  tick?: number;
}

export interface ServerAuthorityGroupVitalsState {
  health: number;
  action: number;
  spirit: number;
}

export interface ServerAuthorityGroupMemberFrameState {
  actorId: string;
  name: string;
  areaId: string;
  vitals: ServerAuthorityGroupVitalsState;
  maxVitals: ServerAuthorityGroupVitalsState;
  lifeState: ActorLifeState;
  isLeader: boolean;
  linkDead: boolean;
}

export interface ServerAuthorityGroupSummaryState {
  groupId: number;
  leaderActorId: string;
  createdTick: number;
  memberActorIds: string[];
}

export interface ServerAuthorityGroupPendingInviteState {
  inviterActorId: string;
  inviterName: string;
  issuedTick: number;
  expiresTick: number;
}

export interface ServerAuthorityGroupViewState {
  group?: ServerAuthorityGroupSummaryState | null;
  members: ServerAuthorityGroupMemberFrameState[];
  pendingInvite?: ServerAuthorityGroupPendingInviteState | null;
}

export type ServerAuthorityGuildRole = "leader" | "officer" | "member";

/** Stable-order member permission strings (contract freeze 2026-07-18). */
export type ServerAuthorityGuildPermission = "invite" | "kick" | "roles" | "war" | "disband";

export type ServerAuthorityGuildWarStance = "outgoing" | "incoming" | "mutual";

export interface ServerAuthorityGuildWarEntryState {
  opposingGuildId: string;
  opposingName: string;
  opposingTag: string;
  state: ServerAuthorityGuildWarStance;
  declaredTick: number;
}

export interface ServerAuthorityGuildSummaryState {
  id: string;
  name: string;
  tag: string;
  leaderActorId: string;
  createdTick: number;
  memberCount: number;
  wars: ServerAuthorityGuildWarEntryState[];
}

/**
 * Member-only roster frame. Privacy contract: `areaId` is present ONLY while
 * `online` is true; offline members carry `lastSeenTick` and a null area.
 * Outsiders never receive roster entries at all (directory only).
 */
export interface ServerAuthorityGuildRosterEntryState {
  actorId: string;
  name: string;
  role: ServerAuthorityGuildRole;
  permissions: ServerAuthorityGuildPermission[];
  online: boolean;
  areaId: string | null;
  lastSeenTick: number;
}

export interface ServerAuthorityGuildPendingInviteState {
  inviteId: string;
  guildId: string;
  guildName: string;
  guildTag: string;
  inviterActorId: string;
  inviterName: string;
  issuedTick: number;
  expiresTick: number;
}

/** Public directory row — id/name/tag/memberCount ONLY (privacy floor). */
export interface ServerAuthorityGuildDirectoryEntryState {
  id: string;
  name: string;
  tag: string;
  memberCount: number;
}

/** `authority.guilds` projection (wire key `guilds`, camelCase fields). */
export interface ServerAuthorityGuildViewState {
  guild?: ServerAuthorityGuildSummaryState | null;
  roster: ServerAuthorityGuildRosterEntryState[];
  pendingInvites: ServerAuthorityGuildPendingInviteState[];
  directory: ServerAuthorityGuildDirectoryEntryState[];
}

export interface ServerAuthorityDuelSummaryState {
  duelId: number;
  opponentActorId: string;
  opponentName: string;
  startedTick: number;
  expiresTick: number;
}

export interface ServerAuthorityDuelChallengeState {
  otherActorId: string;
  otherName: string;
  issuedTick: number;
  expiresTick: number;
}

export interface ServerAuthorityDuelViewState {
  activeDuel?: ServerAuthorityDuelSummaryState | null;
  incomingChallenge?: ServerAuthorityDuelChallengeState | null;
  outgoingChallenge?: ServerAuthorityDuelChallengeState | null;
}

export interface ServerAuthorityDuelOutcomeState {
  actorId: string;
  duelId: number;
  opponentActorId: string;
  opponentName: string;
  result: "won" | "lost" | "dissolved";
  reason: "yield" | "down" | "range" | "timeout" | "disconnect";
  tick: number;
}

export interface ServerAuthorityCombatEventState {
  id: number;
  tick: number;
  commandId?: number | null;
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
  receivedAtMs: number;
}

export interface ServerAuthorityCombatVisualState {
  eventId: number;
  targetActorId: string;
  commandId?: number | null;
  atMs: number;
  lifecycleKind: "hit" | "downed" | "killed";
  lifecycleCause: string;
  floatingTextCount: number;
}

export interface ServerAuthorityFireDebugState {
  shooterActorId: string;
  areaId: string;
  direction: Direction;
  aimOffsetDegrees?: number;
  aimSpreadDegrees?: number;
  recoilBefore?: number;
  recoilAfter?: number;
  suppressionPressure?: number;
  actor: Cell;
  muzzle: Cell;
  start: Cell;
  end: Cell;
  expandedCollisionRadiusCells: number;
  hitActorId: string | null;
  hitPoint: Cell | null;
  hitZone: BodyZone | null;
  distanceCells: number | null;
  terrainPoint?: Cell | null;
  terrainDistanceCells?: number | null;
  blockedBeforeActor?: boolean;
  actorIntersections?: ServerAuthorityFireDebugActorIntersection[];
}

export interface ServerAuthorityFireDebugActorIntersection {
  actorId: string;
  lifeState: ActorLifeState;
  point: Cell;
  hitZone: BodyZone;
  distanceCells: number;
  t: number;
  expandedBox: {
    left: number;
    right: number;
    top: number;
    bottom: number;
  };
}

export interface ServerAuthorityViewInterestState {
  area_id?: string;
  viewport_width_cells: number;
  viewport_height_cells: number;
  margin_cells?: number;
  /** Actor the camera is centered on (the followed actor for a spectator cam) so server AOI follows it. */
  center_actor_id?: string;
}

export interface ServerAuthorityInboundSample {
  atMs: number;
  bytes: number;
}

export interface ServerAuthorityRecentMoveRejectionState {
  commandId: number;
  reasonCode: string;
  serverTick: number;
  dx: number;
  dy: number;
}

export interface ServerAuthorityRuntimeState {
  enabled: boolean;
  connected: boolean;
  status: "off" | "connecting" | "connected" | "disconnected" | "error";
  wsUrl: string | null;
  sessionId: string | null;
  snapshotTick: number;
  lastSnapshotReceivedAtMs: number | null;
  serverTimeOffsetMs: number | null;
  lastServerTimeSyncAtMs: number | null;
  playerActorId: string | null;
  sourceStateHash: string | null;
  sourceActorCount: number | null;
  sourceMatchesClient: boolean | null;
  sentCommands: number;
  acceptedCommands: number;
  rejectedCommands: number;
  recentMoveRejections?: ServerAuthorityRecentMoveRejectionState[];
  recentMoveRejectionWriteIndex?: number;
  recentMoveRejectionCount?: number;
  receivedSnapshots: number;
  sentViewInterests: number;
  lastViewInterest: ServerAuthorityViewInterestState | null;
  lastViewInterestSentAtMs: number | null;
  receivedPackets: number;
  receivedBytes: number;
  receivedBytesByType: Record<string, number>;
  recentInboundBytes: ServerAuthorityInboundSample[];
  lastPacketBytes: number;
  lastPacketType: string | null;
  receivedEvents: number;
  lastReceipt: {
    commandId: number;
    accepted: boolean;
    tick: number;
    reasonCode?: string;
    receivedAtMs: number;
    fireDebug?: ServerAuthorityFireDebugState;
  } | null;
  sentCommandLog: Array<{
    commandId: number;
    kind: AuthorityClientCommandKind;
    sentAtMs: number;
    issuedAtTick?: number;
    propId?: string;
    targetActorId?: string;
    dx?: number;
    dy?: number;
    durationTicks?: number | null;
    sprint?: boolean;
  }>;
  receiptLog: NonNullable<ServerAuthorityRuntimeState["lastReceipt"]>[];
  lastEvent: ServerAuthorityCombatEventState | null;
  eventLog: ServerAuthorityCombatEventState[];
  visualLog: ServerAuthorityCombatVisualState[];
  inFlightMoves: ServerAuthorityPendingMoveState[];
  authoritativePlayer: Cell | null;
  predictionTarget: Cell | null;
  predictionErrorCells: number;
  maxPredictionErrorCells: number;
  lastCorrectionCells: number;
  totalCorrectionCells: number;
  playerCorrectionCount: number;
  maxPlayerCorrectionDistance: number;
  nextMoveCommandAtMs: number;
  moveCommandIntervalMs: number;
  lastMoveCommandAtMs: number | null;
  lastMoveIssuedAtTick: number | null;
  lastMoveIntent: ServerAuthorityMoveIntentState | null;
  lastMoveIntentSentAtMs: number | null;
  lastMoveVector: Cell | null;
  wasMovingLastFrame: boolean;
  actors: Record<string, ServerAuthorityActorState>;
  actorNetIds: Record<string, number>;
  actorIdsByNetId: Record<number, string>;
  /** Session-targeted survey scan results (drained each frame by the 3D client). */
  surveyResults: ServerAuthoritySurveyResultState[];
  /** Active resource spawns per the authority (survey/detail-pane joins). */
  resourceSpawns: ServerAuthorityResourceSpawnState[];
  /** Placed field extractors streamed by authority (area-scoped, full-replace). */
  placedExtractors: ServerAuthorityPlacedExtractorState[];
  /** Placed scout camps streamed by authority (area-scoped, full-replace). */
  placedCamps: ServerAuthorityPlacedCampState[];
  placedParcels: ServerAuthorityParcelState[];
  farmPlots: ServerAuthorityFarmPlotState[];
  building: ServerAuthorityBuildingState;
  /** Current crafting-window VM streamed by authority session commands. */
  craftSession: ServerAuthorityCraftSessionState | null;
  /** Current splice-bench VM streamed by authority session commands (DEF-6). */
  spliceSession: ServerAuthoritySpliceSessionState | null;
  /** Latest genome-scanner reveal streamed by authority ScanGenome (DEF-6). */
  genomeScan: ServerAuthorityGenomeScanState | null;
  /** Current trade-window VM streamed to BOTH participants by authority session commands. */
  tradeSession: ServerAuthorityTradeSessionState | null;
  /** Owner-visible drafted factory schematics stored in the datapad. */
  draftedSchematics: ServerAuthorityDraftedSchematicState[];
  /** Owning-session-safe group channel; non-members receive an empty members list. */
  group: ServerAuthorityGroupViewState;
  /** Owning-session-safe Player Association channel; outsiders receive the public directory only. */
  guilds: ServerAuthorityGuildViewState;
  /** Owning-session-safe duel channel: the observer's own active duel + challenges. */
  duel: ServerAuthorityDuelViewState;
  /** One-shot duel-end receipts received by this session (bounded, most-recent-last). */
  duelOutcomes: ServerAuthorityDuelOutcomeState[];
  /** Interactable prop state streamed by authority (loot caches, doors, etc.). */
  /** Owning-session bank account projection; strangers receive null. */
  bank: ServerAuthorityBankState | null;
  /** Public player corpses currently inside this session's AOI. */
  playerCorpses: ServerAuthorityPlayerCorpseState[];
  propStates?: Record<string, ServerAuthorityPropState>;
  exitWorld?: () => boolean;
}

/**
 * One `surveyResult` message — the server's answer to a SurveyResource
 * command (world-anchored concentration grid, sent only to the issuing
 * session). Contract frozen with the sim lanes.
 */
export interface ServerAuthoritySurveyResultState {
  areaId: string;
  family: string;
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

/** established sandbox-style rolled stat axes carried by every resource spawn. */
export interface ServerAuthorityResourceStatsState {
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

export interface ServerAuthorityResourceSpawnState {
  spawnId: string;
  family: string;
  name: string;
  variantId: number;
  /** Human material label ("Iron") — spawnId is a composite dev id, never shown. */
  classLabel: string;
  stats: ServerAuthorityResourceStatsState;
  activeFromTick: number;
  activeUntilTick: number | null;
}

/**
 * One placed field extractor as the authority streams it (W3/W4 extraction
 * wire, full-replace per snapshot/delta like resourceSpawns). `isOwner` is
 * per-session truth — command gates are owner-only server-side.
 */
export interface ServerAuthorityPlacedExtractorState {
  extractorId: string;
  areaId: string;
  cellX: number;
  cellY: number;
  mode: "idle" | "manual" | "battery";
  biome: "desert" | "forest";
  hopperPct: number;
  /** Whole resource units currently banked in the hopper (authority floor). */
  collectableUnits: number;
  batteryPct: number;
  isOwner: boolean;
  familyLabel: string;
}

/**
 * One placed scout camp as the authority streams it (car-6 camp wire,
 * full-replace per snapshot/delta like placedExtractors). `isOwner` is
 * per-session truth; `abandonSecondsRemaining` is the armed-abandonment
 * countdown and arrives for the OWNING session only (shard-redacted) —
 * absent means the camp persists indefinitely (owner present) or the camp
 * is someone else's.
 */
export interface ServerAuthorityPlacedCampState {
  campId: string;
  areaId: string;
  cellX: number;
  cellY: number;
  isOwner: boolean;
  /** Stable render identity ("scout-camp" → pod-tent GLB). */
  renderKind: string;
  abandonSecondsRemaining?: number | null;
}

/**
 * One claimed parcel as the authority streams it (DEF-9 farm-view forwarding,
 * full-replace per snapshot/delta like placedCamps). `isOwner` is per-session
 * truth; `upkeepDueInGameDays` (owner finance HUD hint) arrives for the OWNING
 * session only (shard-redacted). Boundary/tier/crop-counts are world-visible.
 */
export interface ServerAuthorityParcelState {
  parcelId: string;
  planetId: string;
  areaId: string;
  name: string;
  rect: { x: number; y: number; w: number; h: number };
  tier: string;
  buildZone: { x: number; y: number; w: number; h: number };
  farmYard: { x: number; y: number; w: number; h: number };
  isOwner: boolean;
  upkeepDueInGameDays?: number | null;
  tilledTiles: number;
  plantedTiles: number;
}

export interface ServerAuthorityFarmCropState {
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

export interface ServerAuthorityFarmTileState {
  cellX: number;
  cellY: number;
  tilled: boolean;
  moisturePct: number;
  /** "none" | "speed" | "quality" | "yield" (W4 soil amendment, §E.4). */
  fertilizer: string;
  crop?: ServerAuthorityFarmCropState | null;
  legalVerbs: string[];
}

/**
 * One parcel's per-tile crop detail. Crop render state is world-visible;
 * `legalVerbs` arrive only for the OWNING session (shard blanks them for others).
 */
export interface ServerAuthorityFarmPlotState {
  parcelId: string;
  areaId: string;
  tiles: ServerAuthorityFarmTileState[];
}

export interface ServerAuthorityBuildComponentState {
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

export interface ServerAuthorityInteriorRegionState {
  interiorId: string;
  areaId: string;
  parcelId: string;
  cellKeys: string[];
  roofed: boolean;
  enclosed: boolean;
  doorComponentIds: string[];
}

export interface ServerAuthorityBuildingState {
  schema: "successor.authority-building.v1";
  tick: number;
  components: ServerAuthorityBuildComponentState[];
  interiors: ServerAuthorityInteriorRegionState[];
}
export interface ServerAuthorityBankItemState {
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

export interface ServerAuthorityBankState {
  credits: number;
  items: ServerAuthorityBankItemState[];
  backupPresent: boolean;
  backupSavedTick: number | null;
  backupSkillCount: number;
  backupCost: number;
}

export interface ServerAuthorityPlayerCorpseState {
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

export type ServerAuthorityCraftPhase = "browse" | "slots" | "assembled" | string;

export interface ServerAuthorityCraftRecipeSummaryState {
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

export interface ServerAuthorityCraftSlotSpecState {
  slotIndex: number;
  symbol: string;
  resourceKindLabel: string;
  requiredItemId?: number | null;
  requiredFamily?: string | null;
  requirementKind?: "material_family" | "item" | string;
  requiredItemName?: string | null;
  requiredQty: number;
  craftRelevantStat: keyof ServerAuthorityResourceStatsState | string;
}

export interface ServerAuthorityCraftRecipeDetailState {
  recipeId: string;
  outputItemId: number;
  outputPreviewVariantId: number;
  slots: ServerAuthorityCraftSlotSpecState[];
  statLines: Array<{ lineId: number; label: string; capEstimateMilli: number }>;
}

export interface ServerAuthorityCraftResourceOptionState {
  container: string;
  stackId: string;
  itemId: number;
  variantId: number;
  name: string;
  qtyAvailable: number;
  craftRelevantStatValue: number;
  recommended: boolean;
  stats: ServerAuthorityResourceStatsState;
}

export interface ServerAuthorityCraftSlotFillState {
  slotIndex: number;
  symbol: string;
  resourceKindLabel: string;
  requiredQty: number;
  requiredItemId?: number | null;
  requiredFamily?: string | null;
  requirementKind?: "material_family" | "item" | string;
  requiredItemName?: string | null;
  eligible: ServerAuthorityCraftResourceOptionState[];
  assigned?: { container: string; stackId: string; variantId: number } | null;
}

export interface ServerAuthorityCraftSessionState {
  phase: ServerAuthorityCraftPhase;
  recipeId?: string | null;
  recipes: ServerAuthorityCraftRecipeSummaryState[];
  detail?: ServerAuthorityCraftRecipeDetailState | null;
  details?: ServerAuthorityCraftRecipeDetailState[];
  slotScreen?: { recipeId: string; slots: ServerAuthorityCraftSlotFillState[]; canAssemble: boolean } | null;
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

// Bio-Engineer splice bench + genome scanner VMs streamed by authority session
// commands (DEF-6). Mirror the wire GameSpliceSession / GameGenomeScan shapes.
export interface ServerAuthoritySpliceSessionSlotState {
  slotIndex: number;
  kind: string;
  label: string;
  filled: boolean;
  itemId: number;
  variantId: number;
}

export interface ServerAuthoritySpliceSessionLineState {
  locus: number;
  label: string;
  baseMilli: number;
  valueMilli: number;
  capMilli: number;
  canRaise: boolean;
}

export interface ServerAuthoritySpliceSessionState {
  phase: string;
  speciesId: number;
  speciesName: string;
  slots: ServerAuthoritySpliceSessionSlotState[];
  lines: ServerAuthoritySpliceSessionLineState[];
  assemblyQualityMilli: number;
  pointsTotal: number;
  pointsRemaining: number;
  canAssemble: boolean;
  tick: number;
}

export interface ServerAuthorityAgronomicProfileState {
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

export interface ServerAuthorityGenomeScanLocusState {
  locus: number;
  label: string;
  expressMilli: number;
  heterozygous?: boolean;
  a1?: number;
  a2?: number;
}

export interface ServerAuthorityGenomeScanState {
  itemId: number;
  variantId: number;
  speciesName: string;
  cultivarName: string;
  tier: string;
  fertile: boolean;
  profile: ServerAuthorityAgronomicProfileState;
  loci: ServerAuthorityGenomeScanLocusState[];
  mutationPotentialMilli?: number;
  generation?: number;
  breederId?: string;
  tick: number;
}

export interface ServerAuthorityTradeItemLineState {
  itemId: number;
  variantId: number;
  name: string;
  quantity: number;
}

export interface ServerAuthorityTradeSideState {
  actorId: string;
  items: ServerAuthorityTradeItemLineState[];
  coin: number;
  locked: boolean;
  confirmed: boolean;
}

/** Streamed trade-window VM (both participants get their own perspective mine/theirs). */
export interface ServerAuthorityTradeSessionState {
  proposalId: number;
  partnerActorId: string;
  mine: ServerAuthorityTradeSideState;
  theirs: ServerAuthorityTradeSideState;
  bothLocked: boolean;
  stage: "negotiating" | "confirm" | "executed" | "declined";
  closeReason?: "declined" | "range" | "death" | "link" | null;
  tick: number;
}

export interface ServerAuthorityCraftResourceLockState {
  itemId: number;
  variantId: number;
  quantity: number;
}

export interface ServerAuthorityDraftedSchematicState {
  id: string;
  ownerActorId: string;
  recipeId: string;
  resourceLocks: ServerAuthorityCraftResourceLockState[];
  outputItemId: number;
  outputVariantId: number;
  schematicItemVariantId: number;
  maxUses: number;
  remainingUses: number;
}

export type ServerAuthorityWeatherPhase = "idle" | "warning" | "active" | "decay";

export interface ServerAuthorityWeatherState {
  areaId: string;
  eventType: string;
  phase: ServerAuthorityWeatherPhase;
  centerX: number;
  centerY: number;
  radiusCells: number;
  intensity: number;
  magnitude: number;
  phaseEndsAtTick: number;
  resolvesAtTick: number;
  sweepDirRad: number;
}

export interface ServerAuthorityPendingMoveState {
  commandId: number;
  dx: number;
  dy: number;
  durationTicks: number;
  issuedAtTick?: number;
  sprint: boolean;
  facing?: Direction;
  sentAtMs: number | null;
}

export interface ServerAuthorityMoveIntentState {
  dx: number;
  dy: number;
  sprint: boolean;
  facing?: Direction;
}

export interface ActorPresentationFrameState {
  actorId: string;
  label: string;
  sheetId: string;
  lifecycleSeq: number;
  frameLabel: string | null;
  animated: boolean;
  animatedHoldUntilMs?: number;
  running?: boolean;
  runningHoldUntilMs?: number;
  direction: Direction;
  frameIndex: number;
  runtimeFrameIndex: number;
  x: number;
  y: number;
  nameplateVisible: boolean;
  statusChipsVisible: boolean;
}

export interface WeaponFireAnimationState {
  weaponId: WeaponId;
  kind: "fire" | "reload";
  startedAtMs: number;
  durationMs: number;
}


export interface PlayState {
  playerActorId: string;
  player: Cell;
  facing: Direction;
  rotationLockFacing: Direction | null;
  moving: boolean;
  keys: Set<string>;
  movementKeyOrder: string[];
  movementInputMode: MovementInputMode;
  observerCamera: {
    followActorId: string | null;
    inputLocked: boolean;
  };
  /** Current explicit 3D Roll-combat target. */
  softLockActorId: string | null;
  settings: RuntimeSettings;
  pendingBindingAction: InputActionId | null;
  blocked: Set<string>;
  movementBlockers: MovementBlocker[];
  floatingTexts: FloatingCombatText[];
  actors: Record<string, ActorCombatState>;
  nextFloatingTextId: number;
  progression: ProgressionState;
  death: PlayerDeathState;
  cooldownMs: number;
  cooldownTotalMs: number;
  lastFrameMs: number | null;
  worldTimeMs: number;
  /** Roll-combat: currently armed owner-repeat target; null means no held repeat. */
  rollRepeatTargetId: string | null;
  /** Owning-session ability queue view plus lifecycle event buffer; drain via drainAbilityQueueEvents. */
  abilityQueue: AbilityQueueRuntimeState;
  worldClock: RuntimeWorldClockState;
  weather: ServerAuthorityWeatherState[];
  hits: number;
  status: string;
  chatBubbles: SpatialChatBubble[];
  activeAreaId: string;
  transitionCooldownMs: number;
  transitionFlashMs: number;
  lastTransitionLabel: string | null;
  selectedActorId: string | null;
  interactions: InteractionRuntimeState;
  examineActorId: string | null;
  abilityToolbar: AbilityToolbarState;
  professionUi: ProfessionUiState;
  inventory: InventoryRow[];
  reservations: ReservationRow[];
  inventoryTransferPrompt: InventoryTransferPromptState | null;
  loadout: LoadoutState;
  authorityCommands: AuthorityCommandQueue;
  serverAuthority: ServerAuthorityRuntimeState;
  actorPresentationFrames: Record<string, ActorPresentationFrameState>;
  equipPulseMs: number;
  weaponFireAnimations: Record<string, WeaponFireAnimationState>;
  actorWeaponIds: Record<string, WeaponId>;
  runtimeAudio: RuntimeAudioState;
}

const recentMoveRejectionCapacity = 32;

function createServerAuthorityRecentMoveRejections(): ServerAuthorityRecentMoveRejectionState[] {
  return Array.from({ length: recentMoveRejectionCapacity }, () => ({
    commandId: 0,
    reasonCode: "",
    serverTick: 0,
    dx: 0,
    dy: 0,
  }));
}

export function createPlayState(
  slice: SliceSnapshot,
  playerActorIdOverride?: string,
  commandIdFloor = 1,
): PlayState {
  const requestedPlayerActor = playerActorIdOverride
    ? slice.actors.find((actor) => actor.id === playerActorIdOverride)
    : undefined;
  const playerActor = requestedPlayerActor
    ?? slice.actors.find((actor) => actor.id === slice.camera.followActor)
    ?? slice.actors[0];
  const playerActorId = playerActorIdOverride ?? playerActor?.id ?? slice.camera.followActor;
  const player = playerActor?.cell ?? { x: 1, y: 1 };
  const activeAreaId = playerActor?.areaId ?? slice.areas[0]?.id ?? "default";
  return {
    playerActorId,
    player: { ...player },
    facing: normalizeDirection(playerActor?.direction ?? "right"),
    rotationLockFacing: null,
    moving: false,
    keys: new Set<string>(),
    movementKeyOrder: [],
    movementInputMode: "world",
    observerCamera: {
      followActorId: null,
      inputLocked: false,
    },
    softLockActorId: null,
    blocked: buildBlockedCells(slice, activeAreaId),
    movementBlockers: buildMovementBlockers(slice, activeAreaId),
    floatingTexts: [],
    actors: createActorCombatStates(slice),
    nextFloatingTextId: 1,
    progression: createInitialProgressionState(),
    death: {
      phase: "alive",
      deaths: 0,
      downedAtMs: null,
      downedRemainingMs: 0,
      lastCause: null,
      cloneFacilityId: null,
      cloneFacilityLabel: null,
    },
    cooldownMs: 0,
    cooldownTotalMs: 0,
    lastFrameMs: null,
    worldTimeMs: 0,
    rollRepeatTargetId: null,
    abilityQueue: { view: null, events: [] },
    worldClock: createRuntimeWorldClock(slice.tickRateHz, slice.tick),
    weather: [],
    hits: 0,
    status: "ready",
    chatBubbles: [],
    activeAreaId,
    transitionCooldownMs: 0,
    transitionFlashMs: 0,
    lastTransitionLabel: null,
    selectedActorId: null,
    examineActorId: null,
    interactions: {
      options: [],
      menuOpen: false,
      selectedIndex: 0,
      lastPrompt: null,
    },
    abilityToolbar: {
      slots: Array.from({ length: 12 }, () => null),
      browserOpen: false,
      lastMessage: null,
      lastFlashSlot: null,
      lastErrorSlot: null,
    },
    professionUi: {
      selectedProfessionId: null,
      showAll: false,
      trainerActorId: null,
    },
    inventory: slice.inventory.map((row) => ({ ...row })),
    reservations: slice.reservations.map((row) => ({ ...row })),
    inventoryTransferPrompt: null,
    settings: createDefaultRuntimeSettings(),
    pendingBindingAction: null,
    loadout: {
      equipped: {
        longGun: "slugthrower",
      },
      activeWeaponId: "slugthrower",
      ammo: {
        slug: { loaded: 30, reserve: 180 },
        "melee": { loaded: 1, reserve: 0 },
      },
      activeAmmo: {
        slug: defaultAmmoTypeForCaliber("slug"),
        "melee": defaultAmmoTypeForCaliber("melee"),
      },
      unlimitedAmmo: false,
    },
    authorityCommands: createAuthorityCommandQueue(1, 1, commandIdFloor),
    serverAuthority: {
      enabled: true,
      connected: false,
      status: "connecting",
      wsUrl: null,
      sessionId: null,
      snapshotTick: 0,
      lastSnapshotReceivedAtMs: null,
      serverTimeOffsetMs: null,
      lastServerTimeSyncAtMs: null,
      playerActorId: null,
      sourceStateHash: null,
      sourceActorCount: null,
      sourceMatchesClient: null,
      sentCommands: 0,
      acceptedCommands: 0,
      rejectedCommands: 0,
      recentMoveRejections: createServerAuthorityRecentMoveRejections(),
      recentMoveRejectionWriteIndex: 0,
      recentMoveRejectionCount: 0,
      receivedSnapshots: 0,
      sentViewInterests: 0,
      lastViewInterest: null,
      lastViewInterestSentAtMs: null,
      receivedPackets: 0,
      receivedBytes: 0,
      receivedBytesByType: {},
      recentInboundBytes: [],
      lastPacketBytes: 0,
      lastPacketType: null,
      receivedEvents: 0,
      lastReceipt: null,
      receiptLog: [],
      sentCommandLog: [],
      lastEvent: null,
      eventLog: [],
      visualLog: [],
      inFlightMoves: [],
      authoritativePlayer: null,
      predictionTarget: null,
      predictionErrorCells: 0,
      maxPredictionErrorCells: 0,
      lastCorrectionCells: 0,
      totalCorrectionCells: 0,
      playerCorrectionCount: 0,
      maxPlayerCorrectionDistance: 0,
      nextMoveCommandAtMs: 0,
      moveCommandIntervalMs: authorityMoveCommandIntervalMs(slice.tickRateHz),
      lastMoveCommandAtMs: null,
      lastMoveIssuedAtTick: null,
      lastMoveIntent: null,
      lastMoveIntentSentAtMs: null,
      lastMoveVector: null,
      wasMovingLastFrame: false,
      actors: {},
      actorNetIds: {},
      actorIdsByNetId: {},
      surveyResults: [],
      resourceSpawns: [],
      placedExtractors: [],
      placedCamps: [],
      placedParcels: [],
      farmPlots: [],
      building: {
        schema: "successor.authority-building.v1",
        tick: 0,
        components: [],
        interiors: [],
      },
      craftSession: null,
      spliceSession: null,
      genomeScan: null,
      tradeSession: null,
      draftedSchematics: [],
      group: { members: [] },
      guilds: { roster: [], pendingInvites: [], directory: [] },
      duel: {},
      duelOutcomes: [],
      bank: null,
      playerCorpses: [],
      propStates: {},
    },
    actorPresentationFrames: {},
    equipPulseMs: 0,
    actorWeaponIds: playerActor?.id ? { [playerActor.id]: "slugthrower" } : {},
    weaponFireAnimations: {},
    runtimeAudio: {
      ambientAreaId: null,
      loopVolumes: {},
      nextOneShotAtMs: {},
      footstepDistanceCells: 0,
      footstepIndex: 0,
      lastFootstepPlayer: null,
      lastStepAtMs: -Infinity,
      lastCombatAudioAtMs: -Infinity,
      activeCombatMusicId: null,
      npcFootsteps: {},
      surveyPullLoopActive: false,
      surveyPullLoopUntilMs: null,
      combat: createRuntimeCombatAudioState(),
    },
  };
}

export function createActorCombatStates(slice: Pick<SliceSnapshot, "actors">): Record<string, ActorCombatState> {
  const states: Record<string, ActorCombatState> = {};
  for (const actor of slice.actors) {
    const vitals = actor.vitals ? { ...actor.vitals } : baseActorVitals(actor);
    const maxVitals = actor.maxVitals ? { ...actor.maxVitals } : baseActorMaxVitals(actor);
    states[actor.id] = {
      actorId: actor.id,
      downedCell: null,
      lifeState: "alive",
      lifecycleSeq: 1,
      vitals,
      maxVitals: { ...maxVitals },
      bleed: createInactiveBleedState(),
      statuses: [],
      hitFlashMs: 0,
      downed: false,
    };
  }
  return states;
}

export function createInitialProgressionState(): ProgressionState {
  const professions = Object.fromEntries(
    Object.entries(professionDefinitions).map(([id, label]) => [
      id,
      {
        id: id as ProfessionId,
        label,
        xp: id === "marksman" ? 35 : 0,
        rank: 0,
      },
    ]),
  ) as Record<ProfessionId, ProfessionProgress>;

  return {
    professions,
    skillNodes: skillNodeDefinitions.map((node) => ({ ...node, grants: [...node.grants] })),
    certificates: ["cert_rifle", "cert_combat_medic", "cert_brawler"],
    abilities: ["ability_leg_shot", "ability_quick_reload", "ability_medic_prep", "ability_entertainer_session"],
  };
}
