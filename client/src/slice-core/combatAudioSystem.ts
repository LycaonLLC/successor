import { computeSfxSpatialMix, type SfxPlayOptions, type SfxPlayer } from "../audio/sfx";
import {
  createRuntimeCombatAudioState,
  type PlayState,
  type RuntimeCombatAudioEvent,
  type RuntimeCombatAudioState,
} from "./gameState";
import type { Point } from "./geometry";
import { ROLL_BURST_STAGGER_MS } from "./rollBurstCadence";
import { isMeleeWeaponPresentation, type WeaponId } from "./weaponSystem";

const burstContinuationMs = Math.ceil(ROLL_BURST_STAGGER_MS * 2.25);
const burstCleanupMs = 3_000;
const sustainedTailRefreshMs = 1_200;
const nearSpatialGainThreshold = 0.62;
const midSpatialGainThreshold = 0.22;
// Keep own fire forward of its tail and nearby remote shots without a near-full-scale crack.
const localGunshotTransientVolume = 0.65;
const remoteGunshotTransientScale = 0.34;

interface WeaponFireAudioParams {
  shooterActorId: string | null;
  weaponId: WeaponId;
  position: Point;
  direction: Point;
  eventId?: number | null;
  commandId?: number | null;
  local?: boolean;
}

export function playWeaponFireAudio(
  state: PlayState,
  sfx: SfxPlayer,
  params: WeaponFireAudioParams,
): boolean {
  if (isMeleeWeaponPresentation(params.weaponId)) return false;
  const combat = ensureCombatAudioState(state);
  const metrics = combat.metrics;
  const time = finiteTime(state.worldTimeMs);
  cleanupPlayedShotAudio(combat, time);
  const shotAudioKey = params.eventId === undefined || params.eventId === null
    ? null
    : `${params.shooterActorId ?? "unknown"}:${params.eventId}`;
  if (shotAudioKey && combat.playedShotAudio[shotAudioKey] !== undefined) {
    metrics.duplicateShotEventSuppressions += 1;
    return false;
  }
  if (shotAudioKey) combat.playedShotAudio[shotAudioKey] = time;
  const seed = combatAudioSeed(params.shooterActorId, params.weaponId, params.eventId ?? params.commandId ?? metrics.shotEvents);
  const shooterKey = params.local === true ? "local-player" : (params.shooterActorId ?? "unknown-shooter");
  const previous = combat.shooterBursts[shooterKey];
  const newBurst = !previous
    || previous.weaponId !== params.weaponId
    || previous.burstEnded
    || time - previous.lastShotAtMs > burstContinuationMs;
  const burst = newBurst
    ? {
        weaponId: params.weaponId,
        firstShotAtMs: time,
        lastShotAtMs: time,
        lastTailAtMs: -Infinity,
        shotCount: 0,
        burstEnded: false,
        lastSeed: seed,
        lastPosition: { x: params.position.x, y: params.position.y },
      }
    : previous;
  combat.shooterBursts[shooterKey] = burst;
  burst.shotCount += 1;
  burst.lastShotAtMs = time;
  burst.lastSeed = seed;
  burst.lastPosition = { x: params.position.x, y: params.position.y };
  burst.burstEnded = false;
  metrics.shotEvents += 1;
  if (newBurst) metrics.burstStarts += 1;
  else metrics.burstContinuations += 1;
  const transientOptions = weaponTransientOptions(params.weaponId, params.local === true, seed);
  const transientSpatial = computeSfxSpatialMix(combatAudioListenerPosition(state), params.position, transientOptions);
  recordWeaponSpatialMetric(metrics, transientSpatial);
  recordCombatAudioEvent(combat, {
    kind: newBurst ? "burst-shot-start" : "burst-shot-continue",
    actorId: params.shooterActorId,
    weaponId: params.weaponId,
    atMs: time,
    seed,
    distanceCells: transientSpatial.distanceCells,
    gain: roundAudioMetric(transientSpatial.gain),
    pan: roundAudioMetric(transientSpatial.pan),
  });

  playWeaponTransient(sfx, params.weaponId, params.position, seed, params.local === true, transientOptions);
  metrics.transientPlays += 1;

  if (params.weaponId === "slugthrower" && params.local === true) {
    if (newBurst || time - burst.lastTailAtMs >= sustainedTailRefreshMs) {
      playWeaponTail(sfx, params.position, seed, newBurst ? 0.32 : 0.18, newBurst ? "burst-start" : "sustained");
      burst.lastTailAtMs = time;
      metrics.burstTailPlays += 1;
    } else {
      metrics.burstTailSuppressions += 1;
    }
    if (params.local === true && shouldPlayCasingLayer(seed, burst.shotCount)) {
      playCasingLayer(sfx, params.position, seed, params.direction, 0.38);
      metrics.casingLayerPlays += 1;
    }
  }
  return true;
}

export function updateCombatAudioBursts(state: PlayState, sfx: SfxPlayer, timeMs: number): void {
  const combat = ensureCombatAudioState(state);
  const metrics = combat.metrics;
  const time = finiteTime(timeMs);
  cleanupPlayedShotAudio(combat, time);
  for (const [shooterKey, burst] of Object.entries(combat.shooterBursts)) {
    const ageMs = time - burst.lastShotAtMs;
    if (!burst.burstEnded && ageMs >= burstContinuationMs) {
      if (shooterKey === "local-player" && burst.weaponId === "slugthrower" && burst.shotCount >= 2 && time - burst.lastTailAtMs >= 90) {
        playWeaponTail(sfx, burst.lastPosition, burst.lastSeed + burst.shotCount * 17, 0.14, "burst-end");
        metrics.burstTailPlays += 1;
        burst.lastTailAtMs = time;
      }
      if (shooterKey === "local-player" && burst.weaponId === "slugthrower" && burst.shotCount >= 2) {
        playCasingLayer(sfx, burst.lastPosition, burst.lastSeed + 29, { x: 0, y: 0 }, 0.18);
        metrics.casingLayerPlays += 1;
      }
      burst.burstEnded = true;
      recordCombatAudioEvent(combat, {
        kind: "burst-end",
        actorId: shooterKey === "local-player" ? null : shooterKey,
        weaponId: burst.weaponId,
        atMs: time,
        seed: burst.lastSeed,
      });
    }
    if (ageMs > burstCleanupMs) delete combat.shooterBursts[shooterKey];
  }
}

export function combatAudioSeed(actorId: string | null, weaponId: WeaponId, eventId: number | null | undefined): number {
  let hash = 2166136261;
  const input = `${actorId ?? "local"}:${weaponId}:${eventId ?? 0}`;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash >>> 0;
}

export function deterministicAudioUnit(seed: number, salt: number): number {
  return (Math.imul(seed ^ Math.imul(salt, 0x45d9f3b), 1103515245) >>> 0) / 0x100000000;
}

export function combatAudioListenerPosition(state: Pick<PlayState, "player">): Point {
  return {
    x: state.player.x + 0.5,
    y: state.player.y + 0.5,
  };
}

function ensureCombatAudioState(state: PlayState): RuntimeCombatAudioState {
  state.runtimeAudio.combat ??= createRuntimeCombatAudioState();
  return state.runtimeAudio.combat;
}

function cleanupPlayedShotAudio(combat: RuntimeCombatAudioState, time: number): void {
  for (const [key, lastSeenAtMs] of Object.entries(combat.playedShotAudio)) {
    if (time - lastSeenAtMs > burstCleanupMs) delete combat.playedShotAudio[key];
  }
}

function playWeaponTransient(sfx: SfxPlayer, weaponId: WeaponId, position: Point, seed: number, local: boolean, options: SfxPlayOptions): void {
  void weaponId;
  void seed;
  void local;
  sfx.playAt("slugthrower_fire", position, options);
}

function weaponTransientOptions(weaponId: WeaponId, local: boolean, seed: number): SfxPlayOptions {
  void weaponId;
  return {
    volume: local ? localGunshotTransientVolume : 0.78 * remoteGunshotTransientScale,
    minDistanceCells: local ? 2.5 : 3.2,
    maxDistanceCells: local ? 44 : 58,
    panDistanceCells: local ? 18 : 24,
    maxPan: 0.96,
    rolloff: local ? 1.75 : 2.35,
    farGainFloor: local ? 0.04 : 0.025,
    playbackRate: 0.94 + deterministicAudioUnit(seed, 17) * 0.12,
  };
}

function playWeaponTail(sfx: SfxPlayer, position: Point, seed: number, volume: number, phase: "burst-start" | "sustained" | "burst-end"): void {
  sfx.playAt(gunshotTailSfxId(seed), position, {
    volume: phase === "burst-end" ? volume * 0.7 : volume,
    minDistanceCells: phase === "burst-start" ? 7 : 9,
    maxDistanceCells: phase === "burst-start" ? 82 : 74,
    panDistanceCells: 34,
    maxPan: 0.9,
    rolloff: 2.05,
    farGainFloor: 0.018,
    playbackRate: 0.9 + deterministicAudioUnit(seed, 23) * 0.16,
  });
}

function playCasingLayer(sfx: SfxPlayer, position: Point, seed: number, direction: Point, volume: number): void {
  const lateral = deterministicAudioUnit(seed, 31) - 0.5;
  sfx.playAt(indexedSfxId("casing_bounce_slugthrower", seed, 6), {
    x: position.x - direction.y * lateral * 0.75,
    y: position.y + direction.x * lateral * 0.75,
  }, {
    volume,
    minDistanceCells: 0.75,
    maxDistanceCells: 13,
    panDistanceCells: 7,
    maxPan: 0.96,
    rolloff: 2.2,
    farGainFloor: 0.01,
    playbackRate: 0.86 + deterministicAudioUnit(seed, 37) * 0.26,
  });
}

function shouldPlayCasingLayer(seed: number, shotCount: number): boolean {
  const cadence = 3 + Math.floor(deterministicAudioUnit(seed, 41) * 3);
  return shotCount === 1 || shotCount % cadence === 0;
}

function gunshotTailSfxId(seed: number): string {
  const tailIds = ["gunshot_3", "gunshot_4", "gunshot_5"];
  return tailIds[positiveModulo(seed, tailIds.length)]!;
}

function indexedSfxId(prefix: string, seed: number, count: number): string {
  return `${prefix}_${String(positiveModulo(seed, count) + 1).padStart(2, "0")}`;
}

function recordWeaponSpatialMetric(metrics: RuntimeCombatAudioState["metrics"], spatial: { gain: number; pan: number }): void {
  const gain = Number.isFinite(spatial.gain) ? spatial.gain : 0;
  const panAbs = Math.abs(Number.isFinite(spatial.pan) ? spatial.pan : 0);
  metrics.weaponSpatialSamples += 1;
  metrics.weaponSpatialGainSum += gain;
  metrics.weaponSpatialGainMin = metrics.weaponSpatialGainMin === null ? gain : Math.min(metrics.weaponSpatialGainMin, gain);
  metrics.weaponSpatialGainMax = metrics.weaponSpatialGainMax === null ? gain : Math.max(metrics.weaponSpatialGainMax, gain);
  metrics.weaponSpatialPanAbsSum += panAbs;
  metrics.weaponSpatialPanAbsMax = Math.max(metrics.weaponSpatialPanAbsMax, panAbs);
  if (gain >= nearSpatialGainThreshold) metrics.weaponSpatialNearEvents += 1;
  else if (gain >= midSpatialGainThreshold) metrics.weaponSpatialMidEvents += 1;
  else metrics.weaponSpatialFarEvents += 1;
}

function recordCombatAudioEvent(combat: RuntimeCombatAudioState, event: RuntimeCombatAudioEvent): void {
  combat.metrics.recentEvents.push(event);
  if (combat.metrics.recentEvents.length > 32) {
    combat.metrics.recentEvents.splice(0, combat.metrics.recentEvents.length - 32);
  }
}

function finiteTime(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

function positiveModulo(value: number, divisor: number): number {
  return ((value % divisor) + divisor) % divisor;
}

function roundAudioMetric(value: number): number {
  return Math.round(value * 1000) / 1000;
}
