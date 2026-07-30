import { Color, MathUtils, Vector3 } from "three";
import type { PlayState } from "@successor/client/src/slice-core/gameState";
import {
  projectedWorldClockForState,
  ticksPerGameDay,
  worldClockStateAtTick,
  type WorldClockState,
  type WorldPhaseId,
} from "@successor/client/src/slice-core/worldClockSystem";
import { SUCCESSOR_3D_CONFIG } from "../../config";
import { SunShadowSystem } from "./sunShadow";

/**
 * WorldEnvironment — the single presentation-side view of "what the world
 * feels like right now" (Worldfeel Update spine).
 *
 * Time is SERVER-AUTHORITATIVE: everything derives from the shared
 * `state.worldClock` (`projectedWorldClockForState`), the same clock both
 * supported clients consume. This class owns NO day length, epoch, or phase table —
 * it maps the projected clock into render-space terms (sun direction/tint,
 * shadow strength, daylight scalars) and adds client-ambient WIND (wind is
 * presentation-only flavor; it never feeds back into anything authoritative).
 *
 * Consumers:
 * - SunShadowSystem (owned here): projected long shadows.
 * - Ps2PostRenderer: time-of-day grade / bloom / shimmer via `env`.
 * - FloraRenderer: wind sway + tumbleweed drive.
 *
 * Dev A/B: `window.__successor3dEnv.timeOverrideMinute = 330` forces a clock
 * minute (dawn) locally — DEV builds only, never authoritative.
 */

const ENV_CONFIG = SUCCESSOR_3D_CONFIG.environment;
const MINUTES_PER_DAY = 1_440;
const CLOCK_REFRESH_MS = 100; // minuteOfDay quantizes server-side; 10Hz is plenty

export interface EnvSun {
  /** World-plane azimuth (radians) straight from the server clock + offset. */
  azimuthRad: number;
  /** Elevation above the horizon (radians); negative = below. */
  elevationRad: number;
  /** Normalized light direction: FROM the sun TOWARD the ground. */
  readonly dir: Vector3;
  /** Light presence 0..1 — sun by day, scaled moonlight by night. */
  intensity01: number;
  /** 0 = full night .. 1 = full day (twilight-smoothed, mirrors server curve). */
  daylight01: number;
  /** Server warmth term: ≥0 ember (dawn/dusk), <0 cold night. */
  warmth: number;
  /** Sun/moon light tint (bone-white noon, ember horizon, slate-blue night). */
  readonly tint: Color;
  /** Projected-shadow darkening 0..1; 0 must disable the shadow pass. */
  shadowStrength01: number;
  /** Elevation used for shadow PROJECTION (clamped so dawn shadows stay finite). */
  shadowElevationRad: number;
}

export interface EnvWind {
  dirRad: number;
  /** Unit direction on the ground plane (world x/z). */
  dirX: number;
  dirZ: number;
  /** Steady strength 0..1 (base + gust). */
  strength01: number;
  /** Gust envelope 0..1 (fast component only — drive twitch, hops, shiver). */
  gust01: number;
}

interface EnvDials {
  /** DEV: force a clock minute-of-day (0–1439) for A/B; null = live server clock. */
  timeOverrideMinute: number | null;
}

declare global {
  interface Window {
    __successor3dEnv?: EnvDials & { readonly clock: WorldClockState | null };
  }
}

const scratchColor = new Color();

export class WorldEnvironment {
  readonly sunShadow = new SunShadowSystem();
  readonly sun: EnvSun = {
    azimuthRad: 0,
    elevationRad: 0,
    dir: new Vector3(0, -1, 0),
    intensity01: 1,
    daylight01: 1,
    warmth: 0,
    tint: new Color(ENV_CONFIG.sun.tints.noon),
    shadowStrength01: 0,
    shadowElevationRad: 0,
  };
  readonly wind: EnvWind = { dirRad: 0, dirX: 1, dirZ: 0, strength01: 0, gust01: 0 };
  readonly dials: EnvDials = { timeOverrideMinute: null };
  /** Storm drive (StormDirector): pins the ambient wind into event weather. */
  private stormSeverity = 0;
  private stormStrengthTarget = 0;
  private stormGustFloor = 0;
  private stormDirRad: number | null = null;

  private clockState: WorldClockState | null = null;
  private lastClockSampleMs = -Infinity;
  private readonly tintNoon = new Color(ENV_CONFIG.sun.tints.noon);
  private readonly tintEmber = new Color(ENV_CONFIG.sun.tints.dawnDusk);
  private readonly tintNight = new Color(ENV_CONFIG.sun.tints.night);

  constructor() {
    if (import.meta.env.DEV) {
      const self = this;
      window.__successor3dEnv = {
        get timeOverrideMinute() {
          return self.dials.timeOverrideMinute;
        },
        set timeOverrideMinute(value: number | null) {
          self.dials.timeOverrideMinute = value;
          self.lastClockSampleMs = -Infinity; // resample immediately
        },
        get clock() {
          return self.clockState;
        },
      };
    }
  }

  /** Projected server clock (or the DEV override view of it). Null until first update. */
  get clock(): WorldClockState | null {
    return this.clockState;
  }

  get phase(): WorldPhaseId {
    return this.clockState?.phase ?? "day";
  }
  /**
   * Storm event drive: at severity 1 the wind blows hard and steady out of
   * the front's sweep heading (flora, strata drift, and the border airfield
   * all inherit it — wind stays presentation-only). Severity 0 restores the
   * ambient wander untouched.
   */
  setStormDrive(severity01: number, strengthTarget: number, gustFloor: number, dirRad: number | null): void {
    this.stormSeverity = MathUtils.clamp(severity01, 0, 1);
    this.stormStrengthTarget = MathUtils.clamp(strengthTarget, 0, 1);
    this.stormGustFloor = MathUtils.clamp(gustFloor, 0, 1);
    this.stormDirRad = dirRad;
  }

  update(state: PlayState, _dtSeconds: number, nowMs: number): void {
    if (nowMs - this.lastClockSampleMs >= CLOCK_REFRESH_MS) {
      this.lastClockSampleMs = nowMs;
      this.clockState = this.sampleClock(state);
      this.deriveSun(this.clockState);
    }
    this.deriveWind(nowMs);
  }

  dispose(): void {
    this.sunShadow.dispose();
    if (import.meta.env.DEV) delete window.__successor3dEnv;
  }

  private sampleClock(state: PlayState): WorldClockState {
    const override = import.meta.env.DEV ? this.dials.timeOverrideMinute : null;
    if (override !== null && Number.isFinite(override)) {
      const config = state.worldClock.config;
      const minute = MathUtils.euclideanModulo(override, MINUTES_PER_DAY);
      const minuteDelta = MathUtils.euclideanModulo(minute - config.epochMinuteOfDay, MINUTES_PER_DAY);
      const overrideTick = config.epochTick + (minuteDelta / MINUTES_PER_DAY) * ticksPerGameDay(config);
      return worldClockStateAtTick(config, overrideTick);
    }
    return projectedWorldClockForState(state);
  }

  private deriveSun(clock: WorldClockState): void {
    const sun = this.sun;
    const sunConfig = ENV_CONFIG.sun;
    const elevation = MathUtils.clamp(clock.sun.elevation, -1, 1);
    sun.azimuthRad = clock.sun.azimuth + sunConfig.azimuthWorldOffsetRad;
    sun.elevationRad = Math.asin(elevation);
    sun.warmth = clock.sun.warmth;
    sun.daylight01 = MathUtils.smoothstep(elevation, -0.06, 0.16);

    const moonlight01 = clock.moon.brightness * (1 - sun.daylight01);
    sun.intensity01 = Math.max(sun.daylight01, moonlight01 * 0.35);

    // Shadow: full-strength long shadows as soon as the sun is meaningfully
    // up (the dawn/dusk drama IS the look), faint under a bright moon, gone
    // only in the horizon trough / deep night. Projection elevation is
    // clamped both ways: floor stops infinite dawn smears, ceiling stops the
    // zenith sun deleting noon shadows entirely.
    const dayShadow = sun.daylight01 * MathUtils.smoothstep(elevation, 0.01, 0.08);
    const moonShadow = moonlight01 * sunConfig.moonShadowFactor;
    sun.shadowStrength01 = MathUtils.clamp(dayShadow + moonShadow, 0, 1) * sunConfig.maxShadowStrength;
    sun.shadowElevationRad = MathUtils.clamp(
      sun.elevationRad,
      MathUtils.degToRad(sunConfig.minShadowElevationDeg),
      MathUtils.degToRad(sunConfig.maxShadowElevationDeg),
    );

    // Light direction from azimuth/elevation (shadow-projection elevation so
    // the pass and the tint agree at the horizon).
    const cosEl = Math.cos(sun.shadowElevationRad);
    sun.dir
      .set(
        -Math.cos(sun.azimuthRad) * cosEl,
        -Math.sin(sun.shadowElevationRad),
        -Math.sin(sun.azimuthRad) * cosEl,
      )
      .normalize();

    // Tint: noon bone → ember toward dawn/dusk (warmth ≥ 0) → slate night.
    const emberT = MathUtils.clamp(sun.warmth / 0.85, 0, 1);
    const nightT = 1 - sun.daylight01;
    sun.tint
      .copy(this.tintNoon)
      .lerp(this.tintEmber, emberT)
      .lerp(scratchColor.copy(this.tintNight), nightT);
  }

  private deriveWind(nowMs: number): void {
    const windConfig = ENV_CONFIG.wind;
    const wind = this.wind;
    const t = nowMs / 1000;
    const wander = Math.sin((t * Math.PI * 2) / windConfig.wanderPeriodSec + 0.8 * Math.sin(t * 0.011));
    wind.dirRad = MathUtils.degToRad(windConfig.baseDirDeg + wander * windConfig.wanderDeg);
    wind.dirX = Math.cos(wind.dirRad);
    wind.dirZ = Math.sin(wind.dirRad);
    const gustPhase = (t * Math.PI * 2) / windConfig.gustPeriodSec;
    wind.gust01 = MathUtils.clamp(0.5 + 0.55 * Math.sin(gustPhase) + 0.25 * Math.sin(gustPhase * 2.7 + 1.3), 0, 1);
    wind.strength01 = MathUtils.clamp(windConfig.baseStrength + wind.gust01 * windConfig.gustStrength, 0, 1);

    // Storm drive: heading swings toward the front's sweep (shortest arc),
    // gusts ride a raised floor, strength pins toward the event target.
    const stormT = this.stormSeverity;
    if (stormT > 0) {
      if (this.stormDirRad !== null) {
        const delta = Math.atan2(Math.sin(this.stormDirRad - wind.dirRad), Math.cos(this.stormDirRad - wind.dirRad));
        wind.dirRad += delta * stormT * 0.85;
        wind.dirX = Math.cos(wind.dirRad);
        wind.dirZ = Math.sin(wind.dirRad);
      }
      wind.gust01 = MathUtils.lerp(wind.gust01, this.stormGustFloor + (1 - this.stormGustFloor) * wind.gust01, stormT);
      wind.strength01 = MathUtils.lerp(wind.strength01, Math.max(wind.strength01, this.stormStrengthTarget), stormT);
    }
  }
}
