import type { SfxPlayer } from "../audio/sfx";
import { updateCombatAudioBursts } from "./combatAudioSystem";
import type { PlayState, SliceSnapshot } from "./gameState";
import { successorAudioIds } from "./successorAudioIds";

type WorldPhaseAudioId = "deep_night" | "dawn" | "day" | "dusk" | "night";
type FootstepSurface = "grass" | "tile";

interface RuntimeAudioPoint {
  x: number;
  y: number;
}

interface AmbientLoopLayer {
  id: string;
  volume: number;
  dayMix?: number;
  nightMix?: number;
  combatDuck?: number;
  combatOnly?: boolean;
  combatTrack?: boolean;
  fadeMs?: number;
  /** Slow deterministic swell: volume multiplier oscillates in
   * [1-depth, 1] over periodMs with a phase offset per layer id, so
   * layered ambience breathes instead of walling (soundscape remix 2026-07-09).
   * `shape` >= 1 raises the wave to a power: crests stay full, valleys
   * stretch — at shape 3 the layer spends most of the cycle near its floor,
   * so ambience arrives in waves with real quiet between (owner round-2 ear ruling). */
  breathe?: { periodMs: number; depth: number; shape?: number };
}

interface AmbientOneShotLayer {
  key: string;
  clips: readonly string[];
  minDelayMs: number;
  maxDelayMs: number;
  volume: number;
  minDistanceCells: number;
  maxDistanceCells: number;
  dayOnly?: boolean;
  nightOnly?: boolean;
}

interface AmbientProfile {
  areaIds: readonly string[];
  footstepSurface: FootstepSurface;
  loops: readonly AmbientLoopLayer[];
  oneShots: readonly AmbientOneShotLayer[];
  /** Per-area combat-music rotation; falls back to defaultCombatMusicIds when absent. */
  combatMusicIds?: readonly string[];
}

// Open-desert overworld soundscape (the 3D client's primary world). It uses
// settlement ambience, day/night music, and sparse positional wildlife
// one-shots. Music remains clearly audible without drowning combat.
const openDesertProfile: AmbientProfile = {
  areaIds: ["open-desert-overworld"],
  footstepSurface: "grass",
  combatMusicIds: [
    successorAudioIds.musicCombatSandstormRunLoop,
    successorAudioIds.musicCombatRedDunesLoop,
  ],
  loops: [
    // Round-3 owner terminal ruling: no continuous insect loop at night —
    // rare distant cricket one-shots carry the insect story.
    { id: successorAudioIds.settlementMurmurLoop, volume: 0.14, dayMix: 0.5, nightMix: 0.72, combatDuck: 0.18, fadeMs: 1_500 },
    { id: successorAudioIds.musicDesertDayDustSilentWorldLoop, volume: 0.42, dayMix: 0.92, nightMix: 0, combatDuck: 0.6, fadeMs: 1_800 },
    { id: successorAudioIds.musicDesertNightSleepingCityLoop, volume: 0.36, dayMix: 0, nightMix: 0.9, combatDuck: 0.62, fadeMs: 1_800 },
    { id: successorAudioIds.musicCombatSandstormRunLoop, volume: 0.30, combatOnly: true, combatTrack: true, fadeMs: 1_100 },
    { id: successorAudioIds.musicCombatRedDunesLoop, volume: 0.30, combatOnly: true, combatTrack: true, fadeMs: 1_100 },
  ],
  oneShots: [
    {
      key: "desert-birds",
      clips: ["amb_desert_bird_01", "amb_desert_bird_02", "amb_desert_bird_03", "amb_desert_bird_04", "amb_desert_bird_05", "amb_desert_bird_06"],
      minDelayMs: 13_000,
      maxDelayMs: 34_000,
      volume: 0.18,
      minDistanceCells: 10,
      maxDistanceCells: 28,
      dayOnly: true,
    },
    {
      key: "desert-crows",
      clips: ["amb_desert_crow_01", "amb_desert_crow_02", "amb_desert_crow_03", "amb_desert_crow_04"],
      minDelayMs: 24_000,
      maxDelayMs: 58_000,
      volume: 0.15,
      minDistanceCells: 14,
      maxDistanceCells: 34,
    },
    {
      key: "night-crickets",
      clips: ["amb_night_cricket_distant_01", "amb_night_cricket_distant_02"],
      minDelayMs: 90_000,
      maxDelayMs: 240_000,
      // 0.13 @ 18-40c => effective -57..-66: half-level distant detail,
      // always well under footsteps as a delayed one-shot.
      volume: 0.13,
      minDistanceCells: 18,
      maxDistanceCells: 40,
      nightOnly: true,
    },
    {
      key: "desert-twigs",
      clips: ["amb_desert_twig_01", "amb_desert_twig_02", "amb_desert_twig_03", "amb_desert_twig_04"],
      minDelayMs: 18_000,
      maxDelayMs: 44_000,
      volume: 0.13,
      minDistanceCells: 6,
      maxDistanceCells: 18,
    },
  ],
};

const profiles = [openDesertProfile] as const;
/** Default combat-music rotation for profiles that don't declare their own pool. */
const defaultCombatMusicIds = [
  successorAudioIds.musicCombatSwampfirePursuitLoop,
  successorAudioIds.musicCombatBayouWarDanceLoop,
] as const;

const footstepClips: Record<FootstepSurface, readonly string[]> = {
  grass: [
    "footstep_grass_01",
    "footstep_grass_02",
    "footstep_grass_03",
    "footstep_grass_04",
    "footstep_grass_05",
    "footstep_grass_06",
    "footstep_grass_07",
    "footstep_grass_08",
  ],
  tile: [
    "footstep_tile_01",
    "footstep_tile_02",
    "footstep_tile_03",
    "footstep_tile_04",
    "footstep_tile_05",
    "footstep_tile_06",
    "footstep_tile_07",
    "footstep_tile_08",
  ],
};

const weatherThunderMinStrength = 0.5;
const weatherThunderMinDelayMs = 8_000;
const weatherThunderMaxDelayMs = 19_000;
const weatherThunderClips = successorAudioIds.thunder;

export function updateRuntimeAudio(
  state: PlayState,
  slice: SliceSnapshot,
  sfx: SfxPlayer,
  time: number,
): void {
  const profile = profileForArea(state.activeAreaId);
  if (state.runtimeAudio.ambientAreaId !== state.activeAreaId) {
    sfx.stopAllLoops?.(900);
    state.runtimeAudio.ambientAreaId = state.activeAreaId;
    state.runtimeAudio.loopVolumes = {};
    state.runtimeAudio.nextOneShotAtMs = {};
    state.runtimeAudio.footstepDistanceCells = 0;
    state.runtimeAudio.lastFootstepPlayer = { ...state.player };
    state.runtimeAudio.activeCombatMusicId = null;
    state.runtimeAudio.npcFootsteps = {};
    state.runtimeAudio.surveyPullLoopActive = false;
  }

  const phase = currentWorldPhase(state);
  updateCombatAudioClock(state, profile, time);
  const combatFactor = combatAudioFactor(state, time);
  updateCombatAudioBursts(state, sfx, time);
  updateAmbientLoops(state, sfx, profile, phase, combatFactor, time);
  updateWeatherAudio(state, slice, sfx, time);
  updateSurveyPullLoop(state, sfx, time);
  updateAmbientOneShots(state, slice, sfx, profile, time, phase);
  updateFootsteps(state, sfx, profile.footstepSurface, time);
  updateNpcFootsteps(state, sfx, profile.footstepSurface, time);
}

export function profileForArea(areaId: string): AmbientProfile {
  return profiles.find((profile) => profile.areaIds.includes(areaId)) ?? openDesertProfile;
}

/** Combat-music + ambient-duck linger: ~6s tail after the local player's engagement ends (owner-tuned). */
const combatMusicLingerMs = 6_000;

export function combatAudioFactor(state: PlayState, time: number): number {
  const elapsed = time - state.runtimeAudio.lastCombatAudioAtMs;
  if (!Number.isFinite(elapsed) || elapsed >= combatMusicLingerMs) return 0;
  return clamp(1 - elapsed / combatMusicLingerMs, 0, 1);
}

function updateCombatAudioClock(state: PlayState, profile: AmbientProfile, time: number): void {
  const wasInCombat = combatAudioFactor(state, time) > 0;
  const playerActorId = state.serverAuthority.playerActorId ?? state.playerActorId;
  const localActor = playerActorId ? state.serverAuthority.actors?.[playerActorId] : undefined;
  const localInCombat = localActor?.inCombat === true;
  if (localInCombat) {
    state.runtimeAudio.lastCombatAudioAtMs = time;
    if (!wasInCombat || !state.runtimeAudio.activeCombatMusicId) {
      const pool = profile.combatMusicIds ?? defaultCombatMusicIds;
      state.runtimeAudio.activeCombatMusicId = pick(pool);
    }
  }
  if (combatAudioFactor(state, time) <= 0) state.runtimeAudio.activeCombatMusicId = null;
}

function updateAmbientLoops(
  state: PlayState,
  sfx: SfxPlayer,
  profile: AmbientProfile,
  phase: WorldPhaseAudioId,
  combatFactor: number,
  time: number,
): void {
  for (const layer of profile.loops) {
    const targetVolume = layer.combatTrack && layer.id !== state.runtimeAudio.activeCombatMusicId
      ? 0
      : ambientLayerVolume(layer, phase, combatFactor, time);
    setRuntimeLoopVolume(state, sfx, layer.id, targetVolume, layer.fadeMs ?? 1_000);
  }
}

function setRuntimeLoopVolume(
  state: PlayState,
  sfx: SfxPlayer,
  id: string,
  targetVolume: number,
  fadeMs: number,
): void {
  const previousVolume = state.runtimeAudio.loopVolumes[id];
  if (previousVolume !== undefined && Math.abs(previousVolume - targetVolume) < 0.025) return;
  state.runtimeAudio.loopVolumes[id] = targetVolume;
  if (targetVolume > 0.01) {
    sfx.setLoop?.(id, { volume: targetVolume, fadeMs });
  } else {
    sfx.stopLoop?.(id, fadeMs);
  }
}

function updateSurveyPullLoop(state: PlayState, sfx: SfxPlayer, time: number): void {
  const activeUntil = state.runtimeAudio.surveyPullLoopUntilMs;
  const active = typeof activeUntil === "number" && time <= activeUntil && state.death.phase === "alive";
  if (active) {
    if (!state.runtimeAudio.surveyPullLoopActive) {
      sfx.setLoop?.(successorAudioIds.surveyPullLoop, { volume: 0.42, fadeMs: 260 });
      state.runtimeAudio.surveyPullLoopActive = true;
    }
    return;
  }
  if (state.runtimeAudio.surveyPullLoopActive) {
    sfx.stopLoop?.(successorAudioIds.surveyPullLoop, 320);
  }
  state.runtimeAudio.surveyPullLoopActive = false;
  if (typeof activeUntil === "number" && time > activeUntil) state.runtimeAudio.surveyPullLoopUntilMs = null;
}

function updateWeatherAudio(state: PlayState, slice: SliceSnapshot, sfx: SfxPlayer, time: number): void {
  const weather = dominantWeatherForArea(state);
  const strength = weather ? weatherAudioStrength(weather) : 0;
  const rain = weather && isRainWeather(weather.eventType) ? rainLoopForWeather(weather) : null;
  setRuntimeLoopVolume(state, sfx, successorAudioIds.rainLightLoop, rain === "light" ? roundAudio(0.14 + strength * 0.28) : 0, 1_200);
  setRuntimeLoopVolume(state, sfx, successorAudioIds.rainHeavyLoop, rain === "heavy" ? roundAudio(0.18 + strength * 0.36) : 0, 1_200);

  if (!weather || strength < weatherThunderMinStrength) {
    delete state.runtimeAudio.nextOneShotAtMs[`${state.activeAreaId}:weather-thunder`];
    return;
  }
  updateWeatherThunder(state, slice, sfx, weather, strength, time);
}

function dominantWeatherForArea(state: PlayState): PlayState["weather"][number] | null {
  let best: PlayState["weather"][number] | null = null;
  let bestStrength = 0;
  for (const weather of state.weather ?? []) {
    if (weather.areaId !== state.activeAreaId) continue;
    const strength = weatherAudioStrength(weather);
    if (!best || strength > bestStrength) {
      best = weather;
      bestStrength = strength;
    }
  }
  return best;
}

function weatherAudioStrength(weather: PlayState["weather"][number]): number {
  if (weather.phase === "idle") return 0;
  const intensity = clamp(finiteNumber(weather.intensity, 0), 0, 1);
  const magnitude = clamp(finiteNumber(weather.magnitude, 0) > 0 ? weather.magnitude : 0.55, 0, 1);
  return roundAudio(intensity * magnitude);
}

function isRainWeather(eventType: string): boolean {
  const normalized = eventType.toLowerCase();
  return normalized.includes("rain") || normalized.includes("shower");
}

function rainLoopForWeather(weather: PlayState["weather"][number]): "light" | "heavy" {
  const magnitude = clamp(finiteNumber(weather.magnitude, 0), 0, 1);
  return magnitude >= 0.72 || weather.intensity >= 0.75 ? "heavy" : "light";
}

function updateWeatherThunder(
  state: PlayState,
  slice: SliceSnapshot,
  sfx: SfxPlayer,
  weather: PlayState["weather"][number],
  strength: number,
  time: number,
): void {
  const key = `${state.activeAreaId}:weather-thunder`;
  const nextAt = state.runtimeAudio.nextOneShotAtMs[key] ?? time;
  if (time < nextAt) return;
  const seed = `${weather.areaId}:${weather.eventType}:${weather.resolvesAtTick}:${weather.phaseEndsAtTick}:${Math.floor(time / 1000)}`;
  const clip = pickSeeded(weatherThunderClips, `${seed}:clip`);
  const point = seededPointNearPlayer(state, slice, `${seed}:point`, 24, 58);
  sfx.playAt(clip, point, {
    volume: roundAudio(0.28 + strength * 0.34),
    minDistanceCells: 16,
    maxDistanceCells: 82,
    panDistanceCells: 30,
    rolloff: 0.85,
    playbackRate: seededRange(`${seed}:rate`, 0.94, 1.04),
  });
  state.runtimeAudio.nextOneShotAtMs[key] = time + seededRange(`${seed}:delay`, weatherThunderMinDelayMs, weatherThunderMaxDelayMs);
}

function ambientLayerVolume(layer: AmbientLoopLayer, phase: WorldPhaseAudioId, combatFactor: number, time: number): number {
  if (layer.combatOnly) return roundAudio(layer.volume * combatFactor);
  const isNight = phase === "night" || phase === "deep_night" || phase === "dusk";
  const phaseMix = isNight ? (layer.nightMix ?? 1) : (layer.dayMix ?? 1);
  const duck = 1 - combatFactor * (layer.combatDuck ?? 0);
  return roundAudio(layer.volume * phaseMix * duck * breatheMultiplier(layer, time));
}

/** Deterministic slow swell in [1-depth, 1]; phase offset comes from the layer
 * id hash so co-resident layers never crest together. `shape` bends the duty
 * cycle: wave^shape keeps full crests but stretches the quiet valleys (shape
 * 3 ~= one swell per period, near-floor the rest of the time). Floors are
 * chosen to stay above the runtime stop threshold so the loop never churns
 * through stop/start across a wave. */
function breatheMultiplier(layer: AmbientLoopLayer, time: number): number {
  const breathe = layer.breathe;
  if (!breathe || breathe.depth <= 0 || breathe.periodMs <= 0) return 1;
  const phase = stableUnit(`breathe:${layer.id}`) * Math.PI * 2;
  const wave = 0.5 + 0.5 * Math.sin((time / breathe.periodMs) * Math.PI * 2 + phase);
  const shaped = Math.pow(wave, Math.max(1, breathe.shape ?? 1));
  return 1 - breathe.depth * (1 - shaped);
}

function updateAmbientOneShots(
  state: PlayState,
  slice: SliceSnapshot,
  sfx: SfxPlayer,
  profile: AmbientProfile,
  time: number,
  phase: WorldPhaseAudioId,
): void {
  const isNight = phase === "night" || phase === "deep_night";
  for (const layer of profile.oneShots) {
    if (layer.dayOnly && isNight) continue;
    if (layer.nightOnly && !isNight) continue;
    const key = `${state.activeAreaId}:${layer.key}`;
    const nextAt = state.runtimeAudio.nextOneShotAtMs[key];
    if (nextAt === undefined) {
      state.runtimeAudio.nextOneShotAtMs[key] = time + randomBetween(layer.minDelayMs * 0.35, layer.maxDelayMs * 0.7);
      continue;
    }
    if (time < nextAt) continue;
    const clip = pick(layer.clips);
    const point = randomPointNearPlayer(state, slice, layer.minDistanceCells, layer.maxDistanceCells);
    sfx.playAt(clip, point, {
      volume: layer.volume,
      minDistanceCells: Math.max(2, layer.minDistanceCells * 0.4),
      maxDistanceCells: layer.maxDistanceCells + 10,
      panDistanceCells: Math.max(7, layer.maxDistanceCells * 0.75),
      rolloff: 1.1,
      playbackRate: randomBetween(0.94, 1.06),
    });
    state.runtimeAudio.nextOneShotAtMs[key] = time + randomBetween(layer.minDelayMs, layer.maxDelayMs);
  }
}

function updateFootsteps(state: PlayState, sfx: SfxPlayer, surface: FootstepSurface, time: number): void {
  const previous = state.runtimeAudio.lastFootstepPlayer;
  state.runtimeAudio.lastFootstepPlayer = { ...state.player };
  if (!previous || !state.moving || state.death.phase !== "alive") return;
  const distance = Math.hypot(state.player.x - previous.x, state.player.y - previous.y);
  if (distance <= 0.0001) return;
  state.runtimeAudio.footstepDistanceCells += distance;
  // Stride length stays surface-authored. Cap the inter-step floor by this
  // frame's streamed displacement so authority sprint (higher cells/frame)
  // can raise cadence; walk frames keep the old ~155ms floor.
  const spacingCells = surface === "grass" ? 0.53 : 0.5;
  // 0.22 cells/frame ~= sprint tick step; map that to ~80ms floor, walk step
  // (~0.07 cells @ 20Hz presentation) stays near 155ms.
  const sprintish = distance >= 0.16;
  const minIntervalMs = sprintish ? 80 : 155;
  if (state.runtimeAudio.footstepDistanceCells < spacingCells || time - state.runtimeAudio.lastStepAtMs < minIntervalMs) return;
  state.runtimeAudio.footstepDistanceCells %= spacingCells;
  state.runtimeAudio.lastStepAtMs = time;
  const clips = footstepClips[surface];
  const clip = clips[state.runtimeAudio.footstepIndex % clips.length] ?? clips[0];
  if (!clip) return;
  state.runtimeAudio.footstepIndex += 1;
  sfx.playAt(clip, { x: state.player.x + 0.5, y: state.player.y + 0.5 }, {
    volume: surface === "grass" ? 0.42 : 0.34,
    minDistanceCells: 0.5,
    maxDistanceCells: 9,
    panDistanceCells: 6,
    rolloff: 1.65,
    playbackRate: randomBetween(0.93, 1.08),
  });
}

const npcFootstepSpacingCells = 0.62;
const npcFootstepMinIntervalMs = 190;
const npcFootstepMaxDistanceCells = 18;
const npcFootstepTeleportCells = 3;
const npcFootstepVolume = 0.22;

/**
 * Positional footsteps for nearby living NPCs (excluding the local player),
 * driven by the same distance-cadenced contract as the local player but
 * quieter and culled beyond npcFootstepMaxDistanceCells so distant patrol
 * chatter never crowds the mix. Reconciliation jumps (>teleport threshold in a
 * single frame) resync without firing, so authority snaps stay silent.
 */
function updateNpcFootsteps(state: PlayState, sfx: SfxPlayer, surface: FootstepSurface, time: number): void {
  const trackers = state.runtimeAudio.npcFootsteps;
  if (!trackers) return;
  const playerActorId = state.serverAuthority.playerActorId ?? state.playerActorId;
  const listenerX = state.player.x + 0.5;
  const listenerY = state.player.y + 0.5;
  const clips = footstepClips[surface];
  const seen = new Set<string>();
  for (const actorId in state.serverAuthority.actors) {
    if (actorId === playerActorId) continue;
    const actor = state.serverAuthority.actors[actorId];
    if (!actor || actor.lifeState !== "alive") continue;
    if (actor.areaId !== state.activeAreaId) continue;
    const ax = actor.x + 0.5;
    const ay = actor.y + 0.5;
    if (Math.hypot(ax - listenerX, ay - listenerY) > npcFootstepMaxDistanceCells) continue;
    seen.add(actorId);
    const existing = trackers[actorId];
    if (!existing) {
      trackers[actorId] = { distanceCells: 0, lastStepAtMs: -Infinity, index: 0, lastX: ax, lastY: ay };
      continue;
    }
    const moved = Math.hypot(ax - existing.lastX, ay - existing.lastY);
    existing.lastX = ax;
    existing.lastY = ay;
    if (moved <= 0.0001) continue;
    if (moved > npcFootstepTeleportCells) {
      existing.distanceCells = 0;
      continue;
    }
    existing.distanceCells += moved;
    if (existing.distanceCells < npcFootstepSpacingCells || time - existing.lastStepAtMs < npcFootstepMinIntervalMs) continue;
    existing.distanceCells = 0;
    existing.lastStepAtMs = time;
    const clip = clips[existing.index % clips.length] ?? clips[0];
    if (!clip) continue;
    existing.index += 1;
    sfx.playAt(clip, { x: ax, y: ay }, {
      volume: npcFootstepVolume,
      minDistanceCells: 1.5,
      maxDistanceCells: npcFootstepMaxDistanceCells,
      panDistanceCells: 9,
      rolloff: 1.8,
      playbackRate: randomBetween(0.92, 1.08),
    });
  }
  for (const id in trackers) {
    if (!seen.has(id)) delete trackers[id];
  }
}

function currentWorldPhase(state: PlayState): WorldPhaseAudioId {
  const phase = state.worldClock.lastSnapshot.phase;
  return (phase === "deep_night" || phase === "dawn" || phase === "day" || phase === "dusk" || phase === "night")
    ? phase
    : "day";
}

function randomPointNearPlayer(
  state: PlayState,
  slice: SliceSnapshot,
  minDistanceCells: number,
  maxDistanceCells: number,
): RuntimeAudioPoint {
  const angle = Math.random() * Math.PI * 2;
  const distance = randomBetween(minDistanceCells, maxDistanceCells);
  const area = slice.areas.find((candidate) => candidate.id === state.activeAreaId);
  const maxX = Math.max(0, (area?.width ?? slice.zone.width) - 0.2);
  const maxY = Math.max(0, (area?.height ?? slice.zone.height) - 0.2);
  return {
    x: clamp(state.player.x + 0.5 + Math.cos(angle) * distance, 0.2, maxX),
    y: clamp(state.player.y + 0.5 + Math.sin(angle) * distance, 0.2, maxY),
  };
}

function seededPointNearPlayer(
  state: PlayState,
  slice: SliceSnapshot,
  seed: string,
  minDistanceCells: number,
  maxDistanceCells: number,
): RuntimeAudioPoint {
  const angle = seededRange(`${seed}:angle`, 0, Math.PI * 2);
  const distance = seededRange(`${seed}:distance`, minDistanceCells, maxDistanceCells);
  const area = slice.areas.find((candidate) => candidate.id === state.activeAreaId);
  const maxX = Math.max(0, (area?.width ?? slice.zone.width) - 0.2);
  const maxY = Math.max(0, (area?.height ?? slice.zone.height) - 0.2);
  return {
    x: clamp(state.player.x + 0.5 + Math.cos(angle) * distance, 0.2, maxX),
    y: clamp(state.player.y + 0.5 + Math.sin(angle) * distance, 0.2, maxY),
  };
}

function pickSeeded<T>(values: readonly T[], seed: string): T {
  return values[Math.floor(stableUnit(seed) * values.length)] ?? values[0]!;
}

function seededRange(seed: string, min: number, max: number): number {
  return min + stableUnit(seed) * Math.max(0, max - min);
}

function stableUnit(seed: string): number {
  let hash = 2166136261;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 0x100000000;
}

function finiteNumber(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

function pick<T>(values: readonly T[]): T {
  return values[Math.floor(Math.random() * values.length)] ?? values[0]!;
}

function randomBetween(min: number, max: number): number {
  return min + Math.random() * Math.max(0, max - min);
}

function roundAudio(value: number): number {
  return Math.round(clamp(value, 0, 1) * 1000) / 1000;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
