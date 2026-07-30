export type WeatherPhase = "idle" | "warning" | "active" | "decay";

export interface WeatherPeriodTicks {
  idle: number;
  warning: number;
  active: number;
  decay: number;
}

export interface SliceWeatherConfig {
  areaId: string;
  eventType: string;
  centerCell: { x: number; y: number };
  radiusCells: number;
  spawnRadiusCells?: number;
  magnitudeRange?: readonly [number, number] | number[];
  /** Per-cycle SIZE multiplier band applied to `radiusCells` (extreme-weather boost). */
  radiusScaleRange?: readonly [number, number] | number[];
  periodTicks: WeatherPeriodTicks;
  dpsMilliHealth: number;
  phaseOffsetTicks?: number;
  sweepDirRad?: number;
}

export interface AreaWeatherSnapshot {
  areaId: string;
  eventType: string;
  phase: WeatherPhase;
  centerX: number;
  centerY: number;
  radiusCells: number;
  intensity: number;
  magnitude: number;
  phaseEndsAtTick: number;
  resolvesAtTick: number;
  sweepDirRad: number;
}

interface WeatherPhaseState {
  phase: WeatherPhase;
  phaseElapsedTicks: number;
  phaseDurationTicks: number;
  phaseEndsAtTick: number;
  resolvesAtTick: number;
  intensity: number;
  cycleIndex: number;
}

export interface AreaWeatherControllerOptions {
  worldSeed?: number;
  mapWidthCells?: number;
  mapHeightCells?: number;
}

interface WeatherCycleRoll {
  centerX: number;
  centerY: number;
  magnitude: number;
  radiusCells: number;
}

const weatherPhases: readonly WeatherPhase[] = ["idle", "warning", "active", "decay"] as const;

// Test-only override: GAME_WEATHER_PERIOD_SCALE multiplies every configured phase duration.
// Example: 0.01 makes a long production cycle complete quickly in focused local tests.
const weatherPeriodScaleEnv = "GAME_WEATHER_PERIOD_SCALE";
// Test-only override: GAME_WEATHER_FORCE_PHASE pins every controller to idle|warning|active|decay.
// Warning/decay still use tick-derived ramp progress within that forced phase.
const weatherForcePhaseEnv = "GAME_WEATHER_FORCE_PHASE";
// Demo/test override: GAME_WEATHER_PIN_CENTER=1 keeps centers at authored anchors
// and rolls magnitude at the configured maximum for stable visual demos.
const weatherPinCenterEnv = "GAME_WEATHER_PIN_CENTER";

// ── EXTREME-WEATHER SIZE BOOST ──────────────────────────────────────────────
// Owner intent (dawn brief): "they basically never hit me." v2 storms rolled a
// magnitude + a roaming center but a FIXED radius, so a storm whose center rolled
// up to `spawnRadiusCells` away almost never overlapped the player or a camp. We
// now roll a per-cycle SIZE multiplier on top of the configured base radius,
// widening the hazard footprint to 2.5-4x the v2 baseline. Wider storms + the
// existing roaming center means the front actually sweeps the player far more
// often - which is what makes shelter (pod-tents, shelter boxes, scout camps)
// genuinely valuable.
//
// Tunable band [min, max], applied as `baseRadiusCells * scale`:
//   2.5x floor keeps even the smallest boosted storm meaningfully larger than v2;
//   4.0x ceiling gives the rare "the whole basin is gone" event.
// Deterministic: the multiplier is seeded from the same per-cycle splitmix stream
// as magnitude/center (new stream index 3), so replays stay byte-identical and the
// existing magnitude/center rolls are unchanged. Per-fixture override via
// SliceWeatherConfig.radiusScaleRange; this const is the global default.
const WEATHER_SIZE_BOOST_RANGE: readonly [number, number] = [2.5, 4] as const;

export class AreaWeatherController {
  readonly areaId: string;
  readonly eventType: string;
  readonly centerCell: { x: number; y: number };
  readonly radiusCells: number;
  readonly spawnRadiusCells: number;
  readonly magnitudeRange: readonly [number, number];
  readonly radiusScaleRange: readonly [number, number];
  readonly periodTicks: WeatherPeriodTicks;
  readonly dpsMilliHealth: number;
  readonly phaseOffsetTicks: number;
  readonly sweepDirRad: number;
  private readonly cycleTicks: number;
  private readonly forcedPhase?: WeatherPhase;
  private readonly pinCenter: boolean;
  private readonly worldSeed: number;
  private readonly mapWidthCells: number;
  private readonly mapHeightCells: number;

  constructor(
    config: SliceWeatherConfig,
    env: NodeJS.ProcessEnv = process.env,
    options: AreaWeatherControllerOptions = {},
  ) {
    this.areaId = nonEmptyString(config.areaId, "unknown-area");
    this.eventType = nonEmptyString(config.eventType, "weather");
    this.centerCell = {
      x: finiteNumber(config.centerCell?.x, 0),
      y: finiteNumber(config.centerCell?.y, 0),
    };
    this.radiusCells = Math.max(0, finiteNumber(config.radiusCells, 0));
    this.spawnRadiusCells = Math.max(0, finiteNumber(config.spawnRadiusCells, 0));
    this.magnitudeRange = normalizeMagnitudeRange(config.magnitudeRange);
    this.radiusScaleRange = normalizeRadiusScaleRange(config.radiusScaleRange);
    const scale = weatherPeriodScale(env);
    this.periodTicks = {
      idle: scaledPeriodTicks(config.periodTicks?.idle, scale),
      warning: scaledPeriodTicks(config.periodTicks?.warning, scale),
      active: scaledPeriodTicks(config.periodTicks?.active, scale),
      decay: scaledPeriodTicks(config.periodTicks?.decay, scale),
    };
    this.dpsMilliHealth = Math.max(0, Math.trunc(finiteNumber(config.dpsMilliHealth, 0)));
    this.phaseOffsetTicks = Math.trunc(finiteNumber(config.phaseOffsetTicks, 0));
    this.sweepDirRad = normalizeSweepDirRad(config.sweepDirRad, this.areaId);
    this.cycleTicks = this.periodTicks.idle + this.periodTicks.warning + this.periodTicks.active + this.periodTicks.decay;
    this.forcedPhase = parseForcedPhase(env[weatherForcePhaseEnv]);
    this.pinCenter = env[weatherPinCenterEnv] === "1";
    this.worldSeed = Math.trunc(finiteNumber(options.worldSeed, 0));
    this.mapWidthCells = Math.max(1, finiteNumber(options.mapWidthCells, defaultMapSizeForCenter(this.centerCell.x, this.radiusCells)));
    this.mapHeightCells = Math.max(1, finiteNumber(options.mapHeightCells, defaultMapSizeForCenter(this.centerCell.y, this.radiusCells)));
  }

  snapshotAtTick(tick: number): AreaWeatherSnapshot {
    const state = this.stateAtTick(tick);
    const roll = this.rollForCycle(state.cycleIndex);
    return {
      areaId: this.areaId,
      eventType: this.eventType,
      phase: state.phase,
      centerX: roll.centerX,
      centerY: roll.centerY,
      radiusCells: roll.radiusCells,
      intensity: round3(state.intensity),
      magnitude: roll.magnitude,
      phaseEndsAtTick: state.phaseEndsAtTick,
      resolvesAtTick: state.resolvesAtTick,
      sweepDirRad: this.sweepDirRad,
    };
  }

  stateAtTick(tick: number): WeatherPhaseState {
    const safeTick = Math.max(0, Math.trunc(finiteNumber(tick, 0)));
    if (this.forcedPhase) return this.forcedStateAtTick(this.forcedPhase, safeTick);
    const cyclePosition = safeTick + this.phaseOffsetTicks;
    const cycleIndex = Math.floor(cyclePosition / this.cycleTicks);
    const cycleOffset = floorModulo(cyclePosition, this.cycleTicks);
    const cycleEndsAtTick = safeTick + (this.cycleTicks - cycleOffset);
    let cursor = 0;
    for (const phase of weatherPhases) {
      const duration = this.periodTicks[phase];
      const phaseEnd = cursor + duration;
      if (cycleOffset < phaseEnd) {
        const elapsed = cycleOffset - cursor;
        const phaseEndsAtTick = safeTick + (phaseEnd - cycleOffset);
        return {
          phase,
          phaseElapsedTicks: elapsed,
          phaseDurationTicks: duration,
          phaseEndsAtTick,
          resolvesAtTick: phase === "idle" ? phaseEndsAtTick : cycleEndsAtTick,
          intensity: intensityForPhase(phase, elapsed, duration),
          cycleIndex,
        };
      }
      cursor = phaseEnd;
    }
    return {
      phase: "idle",
      phaseElapsedTicks: 0,
      phaseDurationTicks: this.periodTicks.idle,
      phaseEndsAtTick: safeTick + this.periodTicks.idle,
      resolvesAtTick: safeTick + this.periodTicks.idle,
      intensity: 0,
      cycleIndex,
    };
  }

  private forcedStateAtTick(phase: WeatherPhase, tick: number): WeatherPhaseState {
    const duration = this.periodTicks[phase];
    const elapsed = floorModulo(tick + this.phaseOffsetTicks, duration);
    const phaseEndsAtTick = tick + (duration - elapsed);
    return {
      phase,
      phaseElapsedTicks: elapsed,
      phaseDurationTicks: duration,
      phaseEndsAtTick,
      resolvesAtTick: phaseEndsAtTick,
      intensity: intensityForPhase(phase, elapsed, duration),
      cycleIndex: Math.floor((tick + this.phaseOffsetTicks) / this.cycleTicks),
    };
  }

  private rollForCycle(cycleIndex: number): WeatherCycleRoll {
    if (this.pinCenter) {
      // Demos pin the center AND the maximum boosted footprint so the forced storm
      // is reliably huge and reproducible (GAME_WEATHER_PIN_CENTER).
      return {
        centerX: this.centerCell.x,
        centerY: this.centerCell.y,
        magnitude: round3(this.magnitudeRange[1]),
        radiusCells: round3(this.radiusCells * this.radiusScaleRange[1]),
      };
    }
    const seed = weatherCycleSeed(this.areaId, cycleIndex, this.worldSeed);
    const magnitude = lerp(this.magnitudeRange[0], this.magnitudeRange[1], splitmixUnit(seed, 0));
    const angle = splitmixUnit(seed, 1) * Math.PI * 2;
    const radius = splitmixUnit(seed, 2) * this.spawnRadiusCells;
    // Stream 3: per-cycle SIZE multiplier (extreme-weather boost). Rolled AFTER the
    // center streams so magnitude/center stay byte-identical to v2 replays.
    const radiusScale = lerp(this.radiusScaleRange[0], this.radiusScaleRange[1], splitmixUnit(seed, 3));
    const radiusCells = round3(this.radiusCells * radiusScale);
    return {
      centerX: round3(clampWeatherCenter(this.centerCell.x + Math.cos(angle) * radius, radiusCells, this.mapWidthCells)),
      centerY: round3(clampWeatherCenter(this.centerCell.y + Math.sin(angle) * radius, radiusCells, this.mapHeightCells)),
      magnitude: round3(magnitude),
      radiusCells,
    };
  }
}

export function weatherSnapshotsAtTick(
  controllers: Iterable<AreaWeatherController>,
  tick: number,
): AreaWeatherSnapshot[] {
  return [...controllers]
    .sort((left, right) => left.areaId.localeCompare(right.areaId) || left.eventType.localeCompare(right.eventType))
    .map((controller) => controller.snapshotAtTick(tick));
}

export function sweepDirRadForArea(areaId: string): number {
  let hash = 2_166_136_261;
  for (let index = 0; index < areaId.length; index += 1) {
    hash ^= areaId.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return ((hash >>> 0) % 3_600) * (Math.PI / 1_800);
}

function weatherCycleSeed(areaId: string, cycleIndex: number, worldSeed: number): number {
  let hash = 2_166_136_261;
  for (let index = 0; index < areaId.length; index += 1) {
    hash ^= areaId.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  hash = fnvMixUint32(hash, worldSeed);
  hash = fnvMixUint32(hash, cycleIndex);
  return hash >>> 0;
}

function fnvMixUint32(hash: number, value: number): number {
  let word = Math.trunc(value) >>> 0;
  for (let byteIndex = 0; byteIndex < 4; byteIndex += 1) {
    hash ^= word & 0xff;
    hash = Math.imul(hash, 16_777_619);
    word >>>= 8;
  }
  return hash >>> 0;
}

function splitmixUnit(seed: number, stream: number): number {
  return splitmix32((seed + Math.imul(stream + 1, 0x9e37_79b9)) >>> 0) / 0x1_0000_0000;
}

function splitmix32(seed: number): number {
  let state = seed >>> 0;
  state = (state + 0x9e37_79b9) >>> 0;
  state = Math.imul(state ^ (state >>> 16), 0x85eb_ca6b) >>> 0;
  state = Math.imul(state ^ (state >>> 13), 0xc2b2_ae35) >>> 0;
  return (state ^ (state >>> 16)) >>> 0;
}

function normalizeMagnitudeRange(value: SliceWeatherConfig["magnitudeRange"]): readonly [number, number] {
  if (!Array.isArray(value) || value.length < 2) return [1, 1];
  const left = clamp01(finiteNumber(value[0], 1));
  const right = clamp01(finiteNumber(value[1], left));
  return left <= right ? [left, right] : [right, left];
}

function normalizeRadiusScaleRange(value: SliceWeatherConfig["radiusScaleRange"]): readonly [number, number] {
  // Scales are multipliers (>= 0, unbounded above), so no clamp01. Absent/invalid
  // config falls back to the global WEATHER_SIZE_BOOST_RANGE default.
  if (!Array.isArray(value) || value.length < 2) return WEATHER_SIZE_BOOST_RANGE;
  const left = Math.max(0, finiteNumber(value[0], WEATHER_SIZE_BOOST_RANGE[0]));
  const right = Math.max(0, finiteNumber(value[1], left));
  return left <= right ? [left, right] : [right, left];
}

function clampWeatherCenter(value: number, radiusCells: number, mapSizeCells: number): number {
  const min = Math.max(0, radiusCells + 16);
  const max = Math.max(0, mapSizeCells - radiusCells - 16);
  if (max < min) return mapSizeCells / 2;
  return Math.min(max, Math.max(min, value));
}

function defaultMapSizeForCenter(center: number, radiusCells: number): number {
  return Math.max(1, Math.ceil(Math.max(center * 2, radiusCells * 2 + 32)));
}

function lerp(min: number, max: number, unit: number): number {
  return min + (max - min) * clamp01(unit);
}

function normalizeSweepDirRad(value: unknown, areaId: string): number {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : sweepDirRadForArea(areaId);
}

function intensityForPhase(phase: WeatherPhase, elapsedTicks: number, durationTicks: number): number {
  const duration = Math.max(1, durationTicks);
  if (phase === "active") return 1;
  if (phase === "warning") return clamp01(elapsedTicks / duration);
  if (phase === "decay") return clamp01(1 - elapsedTicks / duration);
  return 0;
}

function weatherPeriodScale(env: NodeJS.ProcessEnv): number {
  const raw = env[weatherPeriodScaleEnv];
  if (raw === undefined || raw.trim() === "") return 1;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

function scaledPeriodTicks(value: unknown, scale: number): number {
  return Math.max(1, Math.round(Math.max(1, finiteNumber(value, 1)) * scale));
}

function parseForcedPhase(value: string | undefined): WeatherPhase | undefined {
  return weatherPhases.includes(value as WeatherPhase) ? value as WeatherPhase : undefined;
}

function finiteNumber(value: unknown, fallback: number): number {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : fallback;
}

function nonEmptyString(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : fallback;
}

function floorModulo(value: number, divisor: number): number {
  const safeDivisor = Math.max(1, Math.trunc(divisor));
  return ((Math.trunc(value) % safeDivisor) + safeDivisor) % safeDivisor;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function round3(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}
