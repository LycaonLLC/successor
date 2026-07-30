import {
  Color,
  LinearFilter,
  MathUtils,
  Mesh,
  OrthographicCamera,
  PlaneGeometry,
  Scene,
  ShaderMaterial,
  Vector2,
  Vector3,
  WebGLRenderTarget,
  type Camera,
  type Fog,
  type WebGLRenderer,
} from "three";
import { SUCCESSOR_3D_CONFIG, type SuccessorBiomeId } from "../config";
import type { WorldEnvironment } from "./environment";
import type { StormPostDrive } from "./weather/storm";

/**
 * PS2-era presentation pass ("PS2, not PS1" — no vertex snap, no affine warp).
 *
 * The scene renders into a ~1/3-resolution target, then a fullscreen quad
 * upsamples it with hard texel edges (optionally softened ~1 display px to
 * kill iso-pan shimmer), grades it toward sun-bleached bone, dithers on the
 * LOW-RES pixel grid, and posterizes to ~5 bits/channel. This pass also owns
 * the linear fog: near/far are re-derived from the current ortho frustum every
 * frame so the dust haze always swallows the ground-plane horizon regardless
 * of zoom.
 *
 * BORDER ATMOSPHERE ("airfield", owner brief 2026-07-05: "way better
 * sand/dusty screen border effect that actually has some depth and life"):
 * on top of the honest vertical distance haze, three parallax layers of
 * value-noise dust ride the shared Worldfeel wind inside a corner-weighted
 * screen-border field — a far veil tying the frame to the horizon, mid
 * plumes filling the border, and near ridged wisps blowing through the very
 * edge with a faint accent glint (sand glitter on Ashvat, drifting spore
 * pallor on Verdance). Wind direction, gusts, time-of-day, and biome all
 * modulate it; biome switches cross-fade over ~1.2 s so planetfall never
 * pops the air.
 *
 * All defaults live in config.ts (`renderer.post`, `renderer.fog`, and the
 * per-biome `biomes.*.atmosphere` blocks). For live A/B work the current
 * dial values are exposed as `window.__successor3dPost` and are re-applied
 * every frame, e.g.:
 *   __successor3dPost.posterizeLevels = 0     // posterize off
 *   __successor3dPost.ditherStrength = 0      // dither off
 *   __successor3dPost.fogEnabled = false      // fog off
 *   __successor3dPost.atmoBorderStrength = 0  // border atmosphere off
 */
export interface Ps2PostDials {
  /** Render-target scale relative to display resolution. */
  pixelScale: number;
  /** Colour levels per channel; below 2 disables posterization. */
  posterizeLevels: number;
  /** Ordered-dither amplitude in colour units; 0 disables. */
  ditherStrength: number;
  /** Fraction of chroma pulled toward luma. ToD writes this unless overridden. */
  desaturate: number;
  /** Warm cast multiplied in after desaturation. ToD writes this unless overridden. */
  boneTint: [number, number, number];
  /** 0 = raw nearest; >0 softens texel edges over ~n display pixels. */
  texelSoftness: number;
  /** Toggle server-clock time-of-day grading/effects. false = exact legacy post behavior. */
  todEnabled: boolean;
  /** Multiplier over the current ToD bloom anchor; 0 disables bloom. */
  bloomStrength: number;
  /** Raw low-res luma threshold for the pre-grade bloom extract. */
  bloomThreshold: number;
  /** Peak heat-shimmer x wobble in LOW-RES texels (clamped to 1.2). */
  shimmerAmplitude: number;
  /** ToD black-crush lift readout/override. Ignored when todEnabled=false. */
  blackLift: number;
  /** Toggle the zoom-tracking linear fog. */
  fogEnabled: boolean;
  /** Fog start, in frame-relative depth (0 = focus, 1 = top edge). */
  fogNearT: number;
  /** Fog saturation point, frame-relative (slightly past 1 by default). */
  fogFarT: number;
  /** Dust height ramp start, in screen UV (0 = bottom, 1 = top). */
  dustHeightStart: number;
  /** Dust height ramp saturation point (may exceed 1). */
  dustHeightEnd: number;
  /** Peak blend toward the dust colour at max zoom-out, [0,1]. */
  dustMaxStrength: number;
  /** Everywhere-haze floor at max zoom-out (air itself reads dusty). */
  dustAmbient: number;
  /** Value-noise cells across the frame width. */
  dustNoiseScale: number;
  /** Horizontal drift in noise-cells/second. */
  dustDriftSpeed: number;
  /** 0 = flat band, 1 = fully noise-modulated plumes. */
  dustPatchiness: number;
  /** Master multiplier over the biome border-atmosphere strength; 0 disables. */
  atmoBorderStrength: number;
  /** 0 = single flat layer, 1 = full three-layer parallax contrast. */
  atmoLayering: number;
  /** Master multiplier over the biome mote/glint strength. */
  atmoMoteScale: number;
  /**
   * Signature-FX chroma guard (shader overhaul 2026-07-08): scales DOWN the
   * grade's desaturation for high-chroma pixels so effect colour language
   * (PSG cyan, tracer heat, blood red) survives dusk/night/storm grades.
   * 0 = ratified legacy behaviour (guard off).
   */
  chromaGuard: number;
}

/** Per-biome border-atmosphere parameters (config `biomes.*.atmosphere`). */
export interface BiomeAtmosphereParams {
  borderWidth: number;
  cornerBoost: number;
  topBias: number;
  bottomBias: number;
  windRise: number;
  driftScale: number;
  noiseScale: number;
  borderStrength: number;
  accentTint: [number, number, number];
  moteStrength: number;
  gustiness: number;
  nightDensityScale: number;
}

/** Pure: smoothstep-blend two biome atmosphere param sets into `out`. */
export function mixAtmosphereParams(
  out: BiomeAtmosphereParams,
  from: BiomeAtmosphereParams,
  to: BiomeAtmosphereParams,
  rawT: number,
): BiomeAtmosphereParams {
  const t = MathUtils.clamp(rawT, 0, 1);
  const blend = t * t * (3 - 2 * t);
  out.borderWidth = from.borderWidth + (to.borderWidth - from.borderWidth) * blend;
  out.cornerBoost = from.cornerBoost + (to.cornerBoost - from.cornerBoost) * blend;
  out.topBias = from.topBias + (to.topBias - from.topBias) * blend;
  out.bottomBias = from.bottomBias + (to.bottomBias - from.bottomBias) * blend;
  out.windRise = from.windRise + (to.windRise - from.windRise) * blend;
  out.driftScale = from.driftScale + (to.driftScale - from.driftScale) * blend;
  out.noiseScale = from.noiseScale + (to.noiseScale - from.noiseScale) * blend;
  out.borderStrength = from.borderStrength + (to.borderStrength - from.borderStrength) * blend;
  writeTupleLerp(out.accentTint, from.accentTint, to.accentTint, blend);
  out.moteStrength = from.moteStrength + (to.moteStrength - from.moteStrength) * blend;
  out.gustiness = from.gustiness + (to.gustiness - from.gustiness) * blend;
  out.nightDensityScale = from.nightDensityScale + (to.nightDensityScale - from.nightDensityScale) * blend;
  return out;
}

/**
 * Pure: project Worldfeel ground-plane wind into screen UV for the locked
 * north-up camera. +x/east is screen-right; -z/north is screen-up. Vertical
 * drift remains foreshortened and carries biome rise/sink.
 */
export function projectWindToScreenUv(
  dirX: number,
  dirZ: number,
  windRise: number,
): [number, number] {
  const screenX = dirX;
  const screenY = -dirZ * 0.5 + windRise;
  return [screenX, screenY];
}

/**
 * Pure: density multiplier from the live gust cycle and daylight.
 * Gusts breathe the border (calm troughs → kicked-up crests, scaled by the
 * biome's gustiness); daylight blends toward the biome's night register
 * (desert air settles at night, Verdance mist thickens).
 */
export function atmosphereDensityScale(
  gust01: number,
  daylight01: number,
  gustiness: number,
  nightDensityScale: number,
): number {
  const gust = MathUtils.clamp(gust01, 0, 1);
  const eased = gust * gust * (3 - 2 * gust);
  const gustFactor = 1 - gustiness * 0.45 + eased * gustiness * 0.8;
  const nightFactor = nightDensityScale + (1 - nightDensityScale) * MathUtils.clamp(daylight01, 0, 1);
  return Math.max(0, gustFactor * nightFactor);
}

export interface Ps2TimeOfDayGrade {
  /** Normalized RGB fog colour; renderer clearColor uses this same tuple. */
  fogClearColor: [number, number, number];
  /** Alias of fogClearColor so tests can assert the horizon-seam invariant. */
  clearColor: [number, number, number];
  boneTint: [number, number, number];
  desaturate: number;
  sceneDarken: number;
  blackLift: number;
  bloomStrength: number;
}

declare global {
  interface Window {
    __successor3dPost?: Ps2PostDials;
  }
}

const pitchRadians = MathUtils.degToRad(SUCCESSOR_3D_CONFIG.camera.pitchDegrees);
const cameraDistance = SUCCESSOR_3D_CONFIG.camera.distanceCells;
const minutesPerDay = 1_440;
const noonMinute = 720;
const nightFogFarScale = 0.9;
const moonBrightnessMax = 0.72;
const moonReadableDarken = 0.5;
const shimmerCyclesPerSecond = 0.6;

const configPost = SUCCESSOR_3D_CONFIG.renderer.post;
const configFog = SUCCESSOR_3D_CONFIG.renderer.fog;
const configDust = SUCCESSOR_3D_CONFIG.renderer.post.dust;
const configGrade = SUCCESSOR_3D_CONFIG.environment.grade;
const legacyClearColor = hexToRgb01(SUCCESSOR_3D_CONFIG.renderer.clearColor);

interface PreparedGradeAnchor {
  minuteOfDay: number;
  fogClearColor: [number, number, number];
  boneTint: [number, number, number];
  desaturate: number;
  sceneDarken: number;
  blackLift: number;
  bloomStrength: number;
}

interface DialOverrides {
  desaturate: boolean;
  boneTint: boolean;
  blackLift: boolean;
}

const preparedGradeAnchors = configGrade.anchors
  .map((anchor): PreparedGradeAnchor => {
    const fogClearColor = hexToRgb01(anchor.fogClearColor);
    return {
      minuteOfDay: MathUtils.euclideanModulo(anchor.minuteOfDay, minutesPerDay),
      fogClearColor,
      boneTint: [anchor.boneTint[0], anchor.boneTint[1], anchor.boneTint[2]],
      desaturate: anchor.desaturate,
      sceneDarken: anchor.sceneDarken,
      blackLift: anchor.blackLift,
      bloomStrength: anchor.bloomStrength,
    };
  })
  .sort((a, b) => a.minuteOfDay - b.minuteOfDay);

/** Pure test target: smoothstep-blended ToD grade for a server minute-of-day. */
export function interpolatePs2TimeOfDayGrade(minuteOfDay: number, moonBrightness = 0): Ps2TimeOfDayGrade {
  const grade = createMutableGrade();
  writePs2TimeOfDayGrade(grade, minuteOfDay, moonBrightness);
  return grade;
}

function createMutableGrade(): Ps2TimeOfDayGrade {
  const fogClearColor: [number, number, number] = [0, 0, 0];
  return {
    fogClearColor,
    clearColor: fogClearColor,
    boneTint: [1, 1, 1],
    desaturate: 0,
    sceneDarken: 1,
    blackLift: 0,
    bloomStrength: 0,
  };
}

function writePs2TimeOfDayGrade(out: Ps2TimeOfDayGrade, minuteOfDay: number, moonBrightness: number): void {
  const anchors = preparedGradeAnchors;
  const first = anchors[0]!;
  const minute = MathUtils.euclideanModulo(minuteOfDay, minutesPerDay);
  let from = first;
  let to = first;
  let fromMinute = first.minuteOfDay;
  let toMinute = first.minuteOfDay + minutesPerDay;
  let adjustedMinute = minute;

  for (let i = 0; i < anchors.length; i += 1) {
    const current = anchors[i]!;
    const next = anchors[(i + 1) % anchors.length]!;
    const currentMinute = current.minuteOfDay;
    const nextMinute = i === anchors.length - 1 ? next.minuteOfDay + minutesPerDay : next.minuteOfDay;
    const candidateMinute = minute < currentMinute ? minute + minutesPerDay : minute;
    if (candidateMinute >= currentMinute && candidateMinute <= nextMinute) {
      from = current;
      to = next;
      fromMinute = currentMinute;
      toMinute = nextMinute;
      adjustedMinute = candidateMinute;
      break;
    }
  }

  const span = Math.max(1, toMinute - fromMinute);
  const rawBlend = MathUtils.clamp((adjustedMinute - fromMinute) / span, 0, 1);
  const blend = rawBlend * rawBlend * (3 - 2 * rawBlend);
  writeTupleLerp(out.fogClearColor, from.fogClearColor, to.fogClearColor, blend);
  writeTupleLerp(out.boneTint, from.boneTint, to.boneTint, blend);
  out.desaturate = from.desaturate + (to.desaturate - from.desaturate) * blend;
  out.sceneDarken = from.sceneDarken + (to.sceneDarken - from.sceneDarken) * blend;
  out.blackLift = from.blackLift + (to.blackLift - from.blackLift) * blend;
  out.bloomStrength = from.bloomStrength + (to.bloomStrength - from.bloomStrength) * blend;

  const moonT = MathUtils.clamp(moonBrightness / moonBrightnessMax, 0, 1);
  const nightT = 1 - MathUtils.smoothstep(out.sceneDarken, 0.5, 0.85);
  if (moonT > 0 && nightT > 0 && out.sceneDarken < moonReadableDarken) {
    const moonLift = moonT * nightT;
    out.sceneDarken += (moonReadableDarken - out.sceneDarken) * moonLift;
  }
}

function writeLegacyGrade(out: Ps2TimeOfDayGrade): void {
  out.fogClearColor[0] = legacyClearColor[0];
  out.fogClearColor[1] = legacyClearColor[1];
  out.fogClearColor[2] = legacyClearColor[2];
  out.boneTint[0] = configPost.boneTint[0];
  out.boneTint[1] = configPost.boneTint[1];
  out.boneTint[2] = configPost.boneTint[2];
  out.desaturate = configPost.desaturate;
  out.sceneDarken = 1;
  out.blackLift = 0;
  out.bloomStrength = 0;
}

function hexToRgb01(hex: string): [number, number, number] {
  const clean = hex.startsWith("#") ? hex.slice(1) : hex;
  const value = Number.parseInt(clean, 16);
  const red = ((value >> 16) & 255) / 255;
  const green = ((value >> 8) & 255) / 255;
  const blue = (value & 255) / 255;
  return [red, green, blue];
}


function writeTupleLerp(
  out: [number, number, number],
  from: readonly [number, number, number],
  to: readonly [number, number, number],
  blend: number,
): void {
  out[0] = from[0] + (to[0] - from[0]) * blend;
  out[1] = from[1] + (to[1] - from[1]) * blend;
  out[2] = from[2] + (to[2] - from[2]) * blend;
}

/** Mutable copy of a biome's config atmosphere block (readonly `as const`). */
function readBiomeAtmosphere(biome: SuccessorBiomeId): BiomeAtmosphereParams {
  const src = SUCCESSOR_3D_CONFIG.biomes[biome].atmosphere;
  return {
    borderWidth: src.borderWidth,
    cornerBoost: src.cornerBoost,
    topBias: src.topBias,
    bottomBias: src.bottomBias,
    windRise: src.windRise,
    driftScale: src.driftScale,
    noiseScale: src.noiseScale,
    borderStrength: src.borderStrength,
    accentTint: [src.accentTint[0], src.accentTint[1], src.accentTint[2]],
    moteStrength: src.moteStrength,
    gustiness: src.gustiness,
    nightDensityScale: src.nightDensityScale,
  };
}

export class Ps2PostRenderer {
  /**
   * Storm event drive (written by StormDirector every frame; see
   * weather/storm.ts). severity01 = 0 leaves the ratified ambient pass
   * byte-identical. Modulates the APPLIED grade/fog/border values — never
   * the user-facing dials, so A/B override detection keeps working.
   */
  readonly storm: StormPostDrive = {
    severity01: 0,
    fogNearT: 0.34,
    fogFarT: 0.86,
    dustAmbient: 0,
    borderStrength: 0,
    accentTint: [1, 1, 1],
    moteScale: 1,
    airTint: [1, 1, 1],
    boneShift: [1, 1, 1],
    darken: 1,
    desatAdd: 0,
    hazardPulse01: 0,
  };

  readonly dials: Ps2PostDials = {
    pixelScale: configPost.pixelScale,
    posterizeLevels: configPost.posterizeLevels,
    ditherStrength: configPost.ditherStrength,
    desaturate: configPost.desaturate,
    boneTint: [configPost.boneTint[0], configPost.boneTint[1], configPost.boneTint[2]],
    texelSoftness: configPost.texelSoftness,
    todEnabled: true,
    bloomStrength: configPost.bloomStrength,
    bloomThreshold: configPost.bloomThreshold,
    shimmerAmplitude: configPost.shimmerAmplitude,
    blackLift: configPost.blackLift,
    fogEnabled: configFog.enabled,
    fogNearT: configFog.nearT,
    fogFarT: configFog.farT,
    dustHeightStart: configDust.heightStart,
    dustHeightEnd: configDust.heightEnd,
    dustMaxStrength: configDust.maxStrength,
    dustAmbient: configDust.ambient,
    dustNoiseScale: configDust.noiseScale,
    dustDriftSpeed: configDust.driftSpeed,
    dustPatchiness: configDust.patchiness,
    atmoBorderStrength: 1,
    atmoLayering: 1,
    atmoMoteScale: 1,
    chromaGuard: 0.65,
  };

  private readonly target = new WebGLRenderTarget(1, 1, {
    depthBuffer: true,
    stencilBuffer: false,
  });
  private readonly bloomExtractTarget = new WebGLRenderTarget(1, 1, {
    depthBuffer: false,
    stencilBuffer: false,
  });
  private readonly bloomBlurTarget = new WebGLRenderTarget(1, 1, {
    depthBuffer: false,
    stencilBuffer: false,
  });
  private readonly scene = new Scene();
  private readonly bloomScene = new Scene();
  private readonly camera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly sourceResolution = new Vector2(1, 1);
  private readonly blurTexelStep = new Vector2(1, 0);
  private readonly boneTint = new Vector3(1, 1, 1);
  private readonly dustColor = new Vector3();
  private readonly fogClearColor = new Color(SUCCESSOR_3D_CONFIG.renderer.clearColor);
  private readonly activeGrade = createMutableGrade();
  private readonly dialOverrides: DialOverrides = { desaturate: false, boneTint: false, blackLift: false };
  private autoDesaturate: number = configPost.desaturate;
  private autoBlackLift: number = configPost.blackLift;
  private autoBoneTint: [number, number, number] = [configPost.boneTint[0], configPost.boneTint[1], configPost.boneTint[2]];
  private activeFogFarScale = 1;
  private readonly atmoAccent = new Vector3(1, 1, 1);
  private readonly atmoWind = new Vector2(0.01, 0);
  private atmoLastNowMs = 0;
  private atmoChurnValue = 0;
  private atmoFrom: BiomeAtmosphereParams = readBiomeAtmosphere("desert");
  private atmoTarget: BiomeAtmosphereParams = readBiomeAtmosphere("desert");
  private readonly atmoActive: BiomeAtmosphereParams = readBiomeAtmosphere("desert");
  private atmoBiome: SuccessorBiomeId = "desert";
  private atmoBlendStartMs = 0;
  private readonly uniforms = {
    sourceTexture: { value: this.target.texture },
    bloomTexture: { value: this.bloomExtractTarget.texture },
    sourceResolution: { value: this.sourceResolution },
    upscaleRatio: { value: 3 },
    texelSoftness: { value: 0 },
    posterizeLevels: { value: 32 },
    ditherStrength: { value: 0 },
    desaturate: { value: 0 },
    boneTint: { value: this.boneTint },
    sceneDarken: { value: 1 },
    blackLift: { value: 0 },
    bloomStrength: { value: 0 },
    shimmerAmplitude: { value: 0 },
    shimmerPhase: { value: 0 },
    dustColor: { value: this.dustColor },
    dustHeightStart: { value: configDust.heightStart as number },
    dustHeightEnd: { value: configDust.heightEnd as number },
    dustStrength: { value: 0 },
    dustAmbient: { value: 0 },
    dustNoiseScale: { value: configDust.noiseScale as number },
    dustPatchiness: { value: configDust.patchiness as number },
    dustDrift: { value: 0 },
    dustAspect: { value: 1 },
    atmoStrength: { value: 0 },
    atmoDrift: { value: this.atmoWind },
    atmoChurn: { value: 0 },
    atmoBorderWidth: { value: 0.26 },
    atmoCornerBoost: { value: 0.5 },
    atmoTopBias: { value: 1 },
    atmoBottomBias: { value: 0.3 },
    atmoAccent: { value: this.atmoAccent },
    atmoMote: { value: 0 },
    atmoLayering: { value: 1 },
    atmoNoiseScale: { value: 5 },
    chromaGuard: { value: 0 },
  };
  private readonly material = new ShaderMaterial({
    uniforms: this.uniforms,
    depthTest: false,
    depthWrite: false,
    vertexShader: `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = vec4(position.xy, 0.0, 1.0);
      }
    `,
    fragmentShader: `
      uniform sampler2D sourceTexture;
      uniform sampler2D bloomTexture;
      uniform vec2 sourceResolution;
      uniform float upscaleRatio;
      uniform float texelSoftness;
      uniform float posterizeLevels;
      uniform float ditherStrength;
      uniform float desaturate;
      uniform float chromaGuard;
      uniform vec3 boneTint;
      uniform float sceneDarken;
      uniform float blackLift;
      uniform float bloomStrength;
      uniform float shimmerAmplitude;
      uniform float shimmerPhase;
      uniform float atmoNoiseScale;
      uniform vec3 dustColor;
      uniform float dustHeightStart;
      uniform float dustHeightEnd;
      uniform float dustStrength;
      uniform float dustAmbient;
      uniform float dustNoiseScale;
      uniform float dustPatchiness;
      uniform float dustDrift;
      uniform float dustAspect;
      uniform float atmoStrength;
      uniform vec2 atmoDrift;
      uniform float atmoChurn;
      uniform float atmoBorderWidth;
      uniform float atmoCornerBoost;
      uniform float atmoTopBias;
      uniform float atmoBottomBias;
      uniform vec3 atmoAccent;
      uniform float atmoMote;
      uniform float atmoLayering;
      varying vec2 vUv;

      // Compact 4x4 Bayer matrix, output in [0, 1).
      float bayer2(vec2 a) {
        a = floor(a);
        return fract(a.x / 2.0 + a.y * a.y * 0.75);
      }
      float bayer4(vec2 a) {
        return bayer2(0.5 * a) * 0.25 + bayer2(a);
      }

      // Cheap 2D value noise (hash lattice, bilinear) — two octaves is enough
      // for soft dust plumes at the scales we use.
      float hash2(vec2 p) {
        return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
      }
      float vnoise(vec2 p) {
        vec2 i = floor(p);
        vec2 f = fract(p);
        vec2 u = f * f * (3.0 - 2.0 * f);
        float a = hash2(i);
        float b = hash2(i + vec2(1.0, 0.0));
        float c = hash2(i + vec2(0.0, 1.0));
        float d = hash2(i + vec2(1.0, 1.0));
        return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
      }
      float dustNoise(vec2 p) {
        return vnoise(p) * 0.68 + vnoise(p * 2.7 + 17.3) * 0.32;
      }
      // Time-slice churn: two lattice slices lerped — the field blooms and
      // dissolves as it drifts instead of translating a frozen texture.
      float churnNoise(vec2 p, float slice) {
        float s0 = floor(slice);
        float f = slice - s0;
        f = f * f * (3.0 - 2.0 * f);
        float n0 = dustNoise(p + vec2(s0 * 61.7, s0 * 19.3));
        float n1 = dustNoise(p + vec2((s0 + 1.0) * 61.7, (s0 + 1.0) * 19.3));
        return mix(n0, n1, f);
      }

      void main() {
        // Sharp-bilinear upsample: identical to NEAREST at softness 0 (the
        // target uses linear filtering but we snap to texel centres), with an
        // optional ~1-display-px linear seam between texels to stop shimmer.
        vec2 texel = vUv * sourceResolution - 0.5;
        vec2 base = floor(texel);
        vec2 f = texel - base;
        float sharpen = upscaleRatio / max(texelSoftness, 0.001);
        f = clamp((f - 0.5) * sharpen + 0.5, 0.0, 1.0);
        vec2 uv = (base + 0.5 + f) / sourceResolution;
        float dustBand = smoothstep(dustHeightStart, dustHeightEnd, vUv.y);

        // Noon heat-haze: only the far upper dust band wobbles, in LOW-RES
        // texel units, and the CPU gates amplitude by server sun elevation and
        // the same zoom dust ramp that makes the band visible.
        if (shimmerAmplitude > 0.0) {
          float wave = sin(vUv.y * 37.0 + shimmerPhase) * 0.68
            + sin((vUv.x * 13.0 + vUv.y * 19.0) - shimmerPhase * 0.73) * 0.32;
          uv.x += wave * dustBand * shimmerAmplitude / sourceResolution.x;
          uv.x = clamp(uv.x, 0.5 / sourceResolution.x, 1.0 - 0.5 / sourceResolution.x);
        }

        vec3 color = texture2D(sourceTexture, uv).rgb;

        // Desert grade: pull chroma toward bone, multiply a warm cast back in.
        // Signature-FX chroma guard: pixels that arrive saturated (shield
        // cyan, tracer heat, blood) shed less chroma, so the effect colour
        // language reads through every ToD/storm grade. chromaGuard 0 is
        // byte-identical to the ratified grade.
        float luma = dot(color, vec3(0.299, 0.587, 0.114));
        float chroma = max(color.r, max(color.g, color.b)) - min(color.r, min(color.g, color.b));
        float desatEff = desaturate * (1.0 - chromaGuard * smoothstep(0.22, 0.55, chroma));
        color = mix(color, vec3(luma), desatEff) * boneTint;
        color *= sceneDarken;
        if (blackLift > 0.0) {
          color = vec3(blackLift) + color * (1.0 - blackLift);
        }

        // Ordered dither on the LOW-RES grid so the pattern rides the chunky
        // pixels instead of shimmering inside them.
        if (ditherStrength > 0.0) {
          float d = bayer4(floor(vUv * sourceResolution)) - 0.5;
          color += d * ditherStrength;
        }

        // Posterize (~5 bits/channel by default).
        if (posterizeLevels >= 2.0) {
          float steps = posterizeLevels - 1.0;
          color = floor(clamp(color, 0.0, 1.0) * steps + 0.5) / steps;
        }

        // ── Atmosphere: honest distance haze + the border airfield ────────
        // Applied AFTER posterize so the banks stay smooth. Everything is
        // sampled on the LOW-RES texel grid so wisps ride the same chunky
        // pixels as the dither.
        if (dustStrength > 0.0 || dustAmbient > 0.0 || atmoStrength > 0.0) {
          vec2 px = (floor(vUv * sourceResolution) + 0.5) / sourceResolution;
          vec2 ap = vec2(px.x * dustAspect, px.y);

          // Legacy vertical band: depth rises with screen height in the
          // locked iso frame, so this ramp is the honest distance haze
          // (plus the small everywhere floor), noise-broken as ratified.
          vec2 np = vec2(px.x * dustAspect + dustDrift, px.y * 0.82 + dustDrift * 0.13) * dustNoiseScale;
          float bandNoise = dustNoise(np);
          float band = smoothstep(dustHeightStart, dustHeightEnd, px.y);
          float haze = clamp(dustAmbient + band * dustStrength, 0.0, 1.0);
          haze *= mix(1.0, 0.35 + 0.65 * bandNoise, dustPatchiness);

          float density = haze;
          vec3 atmoCol = dustColor;

          // ── Border airfield: three parallax layers riding the Worldfeel
          // wind inside a corner-weighted screen-border field. Drift is the
          // CPU-integrated wind path (never time x current wind — the field
          // cannot retrace itself when the wander swings), and each layer's
          // lattice CHURNS between time slices so grit blooms and dissolves
          // instead of sliding. ────────────────────────────────────────────
          if (atmoStrength > 0.0) {
            vec2 edge2 = min(px, 1.0 - px);
            float border = 1.0 - smoothstep(0.0, atmoBorderWidth, min(edge2.x, edge2.y));
            float corner = (1.0 - smoothstep(0.0, atmoBorderWidth * 1.7, edge2.x))
                         * (1.0 - smoothstep(0.0, atmoBorderWidth * 1.7, edge2.y));
            border = clamp(border + corner * atmoCornerBoost, 0.0, 1.0);
            border *= mix(atmoBottomBias, atmoTopBias, px.y);

            // Far veil: fine, slow — ties the frame edge to the horizon band.
            vec2 p0 = (ap + atmoDrift * 0.45 + vec2(31.7, 7.9)) * (atmoNoiseScale * 1.7);
            // Mid plumes: the body of the airfield.
            vec2 p1 = (ap + atmoDrift) * atmoNoiseScale;
            // Near wisps: coarse ridged billows blowing past the eye.
            vec2 p2 = (ap + atmoDrift * 1.9 + vec2(-11.3, 23.1)) * (atmoNoiseScale * 0.55);
            float n0 = churnNoise(p0, atmoChurn);
            float n1 = churnNoise(p1, atmoChurn * 1.3 + 5.1);
            float r2 = 1.0 - abs(churnNoise(p2, atmoChurn * 0.8 + 11.7) * 2.0 - 1.0);
            r2 *= r2;

            float aFar = 0.28 * n0 * max(band, border * 0.4);
            float aMid = 0.42 * (0.35 + 0.65 * n1) * border;
            float aNear = 0.62 * r2 * border * border;
            aMid *= mix(0.62, 1.0, atmoLayering);
            aNear *= atmoLayering;

            // Screen-combine the layers, scale by the CPU strength
            // (biome x gust x daylight x zoom x master dial).
            float layered = 1.0 - (1.0 - clamp(aFar, 0.0, 1.0))
                                * (1.0 - clamp(aMid, 0.0, 1.0))
                                * (1.0 - clamp(aNear, 0.0, 1.0));
            layered *= atmoStrength;

            // Near wisps pull toward the biome accent; ridge crests catch a
            // faint glint (sand glitter / drifting spore pallor).
            float nearMix = clamp(aNear * 2.2, 0.0, 1.0);
            atmoCol = mix(dustColor, dustColor * atmoAccent, nearMix);
            atmoCol += atmoMote * smoothstep(0.78, 0.97, r2) * border * atmoAccent;

            density = 1.0 - (1.0 - haze) * (1.0 - layered);
          }

          color = mix(color, atmoCol, clamp(density, 0.0, 1.0));
        }

        // Bloom is extracted from the raw low-res scene target and added AFTER
        // posterize/dust so glow stays smooth instead of inheriting PS2 bands.
        if (bloomStrength > 0.0) {
          color += texture2D(bloomTexture, vUv).rgb * bloomStrength;
        }

        gl_FragColor = vec4(clamp(color, 0.0, 1.0), 1.0);
      }
    `,
  });
  private readonly bloomExtractUniforms = {
    sourceTexture: { value: this.target.texture },
    bloomThreshold: { value: configPost.bloomThreshold as number },
  };
  private readonly bloomExtractMaterial = new ShaderMaterial({
    uniforms: this.bloomExtractUniforms,
    depthTest: false,
    depthWrite: false,
    vertexShader: `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = vec4(position.xy, 0.0, 1.0);
      }
    `,
    fragmentShader: `
      uniform sampler2D sourceTexture;
      uniform float bloomThreshold;
      varying vec2 vUv;

      void main() {
        vec3 color = texture2D(sourceTexture, vUv).rgb;
        float luma = dot(color, vec3(0.299, 0.587, 0.114));
        float threshold = clamp(bloomThreshold, 0.0, 0.99);
        float amount = smoothstep(threshold, 1.0, luma);
        gl_FragColor = vec4(color * amount, 1.0);
      }
    `,
  });
  private readonly bloomBlurUniforms = {
    sourceTexture: { value: this.bloomExtractTarget.texture },
    texelStep: { value: this.blurTexelStep },
  };
  private readonly bloomBlurMaterial = new ShaderMaterial({
    uniforms: this.bloomBlurUniforms,
    depthTest: false,
    depthWrite: false,
    vertexShader: `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = vec4(position.xy, 0.0, 1.0);
      }
    `,
    fragmentShader: `
      uniform sampler2D sourceTexture;
      uniform vec2 texelStep;
      varying vec2 vUv;

      void main() {
        vec3 color = texture2D(sourceTexture, vUv).rgb * 0.171582;
        color += texture2D(sourceTexture, vUv + texelStep * 1.0).rgb * 0.158372;
        color += texture2D(sourceTexture, vUv - texelStep * 1.0).rgb * 0.158372;
        color += texture2D(sourceTexture, vUv + texelStep * 2.0).rgb * 0.124594;
        color += texture2D(sourceTexture, vUv - texelStep * 2.0).rgb * 0.124594;
        color += texture2D(sourceTexture, vUv + texelStep * 3.0).rgb * 0.083523;
        color += texture2D(sourceTexture, vUv - texelStep * 3.0).rgb * 0.083523;
        color += texture2D(sourceTexture, vUv + texelStep * 4.0).rgb * 0.047721;
        color += texture2D(sourceTexture, vUv - texelStep * 4.0).rgb * 0.047721;
        gl_FragColor = vec4(color, 1.0);
      }
    `,
  });
  private readonly quad = new Mesh(new PlaneGeometry(2, 2), this.material);
  private readonly bloomQuad = new Mesh(new PlaneGeometry(2, 2), this.bloomExtractMaterial);
  /** Worldfeel hook (set by the renderer at boot): ToD grade / bloom / shimmer read this. */
  env: WorldEnvironment | null = null;
  /**
   * Lab fog bench opt-out: when true the render pass leaves scene.fog's
   * colour/near/far entirely to the caller (Asset Lab SCENE FOG panel).
   * Never set on the game path — default false is byte-identical.
   */
  sceneFogOwnedExternally = false;
  /** Planetfall hook (set by the renderer per frame): active area's biome grade layer. */
  biome: SuccessorBiomeId = "desert";
  private displayWidth = 1;
  private displayHeight = 1;
  private targetWidth = 1;
  private targetHeight = 1;
  private bloomWidth = 1;
  private bloomHeight = 1;
  private appliedPixelScale = 0;

  constructor() {
    // Linear filtering + texel-centre snapping in the shader == NEAREST when
    // texelSoftness is 0, and enables the softening dial when it is not.
    this.target.texture.minFilter = LinearFilter;
    this.target.texture.magFilter = LinearFilter;
    this.target.texture.generateMipmaps = false;
    this.bloomExtractTarget.texture.minFilter = LinearFilter;
    this.bloomExtractTarget.texture.magFilter = LinearFilter;
    this.bloomExtractTarget.texture.generateMipmaps = false;
    this.bloomBlurTarget.texture.minFilter = LinearFilter;
    this.bloomBlurTarget.texture.magFilter = LinearFilter;
    this.bloomBlurTarget.texture.generateMipmaps = false;
    this.scene.add(this.quad);
    this.bloomScene.add(this.bloomQuad);
    window.__successor3dPost = this.dials;
    const dustInit = new Color(SUCCESSOR_3D_CONFIG.ground.fogColor);
    this.dustColor.set(dustInit.r, dustInit.g, dustInit.b);
    writePs2TimeOfDayGrade(this.activeGrade, noonMinute, 0);
    this.applyAutoDialReadouts();
  }

  resize(displayWidth: number, displayHeight: number): void {
    this.displayWidth = Math.max(1, displayWidth);
    this.displayHeight = Math.max(1, displayHeight);
    this.applyTargetSize();
  }

  render(renderer: WebGLRenderer, scene: Scene, camera: Camera): void {
    this.applyTargetSize();
    this.updateTimeOfDay(renderer, scene);
    this.applyDials();
    this.updateFog(scene, camera);
    this.updateDust(scene, camera);
    renderer.setRenderTarget(this.target);
    renderer.clear();
    renderer.render(scene, camera);
    this.renderBloom(renderer);
    renderer.setRenderTarget(null);
    renderer.clear();
    renderer.render(this.scene, this.camera);
  }

  dispose(): void {
    if (window.__successor3dPost === this.dials) delete window.__successor3dPost;
    this.target.dispose();
    this.bloomExtractTarget.dispose();
    this.bloomBlurTarget.dispose();
    this.material.dispose();
    this.bloomExtractMaterial.dispose();
    this.bloomBlurMaterial.dispose();
    this.quad.geometry.dispose();
    this.bloomQuad.geometry.dispose();
  }

  private applyTargetSize(): void {
    const scale = MathUtils.clamp(this.dials.pixelScale, 0.05, 1);
    const width = Math.max(1, Math.floor(this.displayWidth * scale));
    const height = Math.max(1, Math.floor(this.displayHeight * scale));
    if (width === this.targetWidth && height === this.targetHeight && scale === this.appliedPixelScale) return;
    this.targetWidth = width;
    this.targetHeight = height;
    this.bloomWidth = Math.max(1, Math.floor(width * 0.5));
    this.bloomHeight = Math.max(1, Math.floor(height * 0.5));
    this.appliedPixelScale = scale;
    this.target.setSize(width, height);
    this.bloomExtractTarget.setSize(this.bloomWidth, this.bloomHeight);
    this.bloomBlurTarget.setSize(this.bloomWidth, this.bloomHeight);
    this.sourceResolution.set(width, height);
  }

  private updateTimeOfDay(renderer: WebGLRenderer, scene: Scene): void {
    this.detectDialOverrides();
    if (this.dials.todEnabled) {
      const clock = this.env?.clock;
      writePs2TimeOfDayGrade(this.activeGrade, clock?.minuteOfDay ?? noonMinute, clock?.moon.brightness ?? 0);
      // Biome layer (Planetfall): the forest is enclosed and cool — fog pulls
      // green-grey and sits closer, the grade cools. Desert biome values are
      // identity, so Ashvat renders exactly the ratified Worldfeel grade.
      const biome = SUCCESSOR_3D_CONFIG.biomes[this.biome];
      this.activeGrade.fogClearColor[0] *= biome.fogTint[0];
      this.activeGrade.fogClearColor[1] *= biome.fogTint[1];
      this.activeGrade.fogClearColor[2] *= biome.fogTint[2];
      const cool = biome.gradeCool;
      if (cool > 0) {
        this.activeGrade.boneTint[0] *= 1 - 0.12 * cool;
        this.activeGrade.boneTint[2] *= 1 + 0.14 * cool;
      }
      // ── Storm event grade (StormDirector drive) ────────────────────────
      // Multiplies the APPLIED grade after ToD + biome so the ratified
      // ambient pass stays byte-identical at severity 0. The air tint pulls
      // the fog/clear colour (and with it strata + border, which mirror the
      // fog) into the event's register; the world darkens under the mass.
      const storm = this.storm;
      const stormT = MathUtils.clamp(storm.severity01, 0, 1);
      if (stormT > 0) {
        this.activeGrade.fogClearColor[0] *= MathUtils.lerp(1, storm.airTint[0], stormT * 0.65);
        this.activeGrade.fogClearColor[1] *= MathUtils.lerp(1, storm.airTint[1], stormT * 0.65);
        this.activeGrade.fogClearColor[2] *= MathUtils.lerp(1, storm.airTint[2], stormT * 0.65);
        this.activeGrade.boneTint[0] *= MathUtils.lerp(1, storm.boneShift[0], stormT);
        this.activeGrade.boneTint[1] *= MathUtils.lerp(1, storm.boneShift[1], stormT);
        this.activeGrade.boneTint[2] *= MathUtils.lerp(1, storm.boneShift[2], stormT);
        this.activeGrade.desaturate = MathUtils.clamp(this.activeGrade.desaturate + storm.desatAdd * stormT, 0, 1);
        this.activeGrade.sceneDarken *= MathUtils.lerp(1, storm.darken, stormT);
      }
      this.applyAutoDialReadouts();
      const daylightT = MathUtils.smoothstep(this.activeGrade.sceneDarken, 0.5, 1);
      this.activeFogFarScale = (nightFogFarScale + (1 - nightFogFarScale) * daylightT) * biome.fogFarTScale;
    } else {
      writeLegacyGrade(this.activeGrade);
      this.applyLegacyDialReadouts();
      this.activeFogFarScale = 1;
    }

    this.fogClearColor.setRGB(
      this.activeGrade.fogClearColor[0],
      this.activeGrade.fogClearColor[1],
      this.activeGrade.fogClearColor[2],
    );
    const fog = scene.fog as Fog | null;
    if (fog && !this.sceneFogOwnedExternally) fog.color.copy(this.fogClearColor);
    renderer.setClearColor(this.fogClearColor, 1);
  }

  private detectDialOverrides(): void {
    if (!this.dialOverrides.desaturate && Math.abs(this.dials.desaturate - this.autoDesaturate) > 0.0001) {
      this.dialOverrides.desaturate = true;
    }
    if (!this.dialOverrides.blackLift && Math.abs(this.dials.blackLift - this.autoBlackLift) > 0.0001) {
      this.dialOverrides.blackLift = true;
    }
    if (
      !this.dialOverrides.boneTint
      && (Math.abs(this.dials.boneTint[0] - this.autoBoneTint[0]) > 0.0001
        || Math.abs(this.dials.boneTint[1] - this.autoBoneTint[1]) > 0.0001
        || Math.abs(this.dials.boneTint[2] - this.autoBoneTint[2]) > 0.0001)
    ) {
      this.dialOverrides.boneTint = true;
    }
  }

  private applyAutoDialReadouts(): void {
    if (!this.dialOverrides.desaturate) {
      this.dials.desaturate = this.activeGrade.desaturate;
      this.autoDesaturate = this.activeGrade.desaturate;
    }
    if (!this.dialOverrides.blackLift) {
      this.dials.blackLift = this.activeGrade.blackLift;
      this.autoBlackLift = this.activeGrade.blackLift;
    }
    if (!this.dialOverrides.boneTint) {
      this.dials.boneTint[0] = this.activeGrade.boneTint[0];
      this.dials.boneTint[1] = this.activeGrade.boneTint[1];
      this.dials.boneTint[2] = this.activeGrade.boneTint[2];
      this.autoBoneTint[0] = this.activeGrade.boneTint[0];
      this.autoBoneTint[1] = this.activeGrade.boneTint[1];
      this.autoBoneTint[2] = this.activeGrade.boneTint[2];
    }
  }

  private applyLegacyDialReadouts(): void {
    if (!this.dialOverrides.desaturate) {
      this.dials.desaturate = configPost.desaturate;
      this.autoDesaturate = configPost.desaturate;
    }
    if (!this.dialOverrides.blackLift) {
      this.dials.blackLift = configPost.blackLift;
      this.autoBlackLift = configPost.blackLift;
    }
    if (!this.dialOverrides.boneTint) {
      this.dials.boneTint[0] = configPost.boneTint[0];
      this.dials.boneTint[1] = configPost.boneTint[1];
      this.dials.boneTint[2] = configPost.boneTint[2];
      this.autoBoneTint[0] = configPost.boneTint[0];
      this.autoBoneTint[1] = configPost.boneTint[1];
      this.autoBoneTint[2] = configPost.boneTint[2];
    }
  }

  private applyDials(): void {
    const uniforms = this.uniforms;
    const todEnabled = this.dials.todEnabled;
    uniforms.upscaleRatio!.value = this.displayWidth / this.targetWidth;
    uniforms.texelSoftness!.value = Math.max(0, this.dials.texelSoftness);
    uniforms.posterizeLevels!.value = this.dials.posterizeLevels;
    uniforms.ditherStrength!.value = Math.max(0, this.dials.ditherStrength);
    uniforms.desaturate!.value = MathUtils.clamp(this.dials.desaturate, 0, 1);
    uniforms.chromaGuard!.value = MathUtils.clamp(this.dials.chromaGuard, 0, 1);
    this.boneTint.set(this.dials.boneTint[0], this.dials.boneTint[1], this.dials.boneTint[2]);
    uniforms.sceneDarken!.value = todEnabled ? MathUtils.clamp(this.activeGrade.sceneDarken, 0, 1) : 1;
    uniforms.blackLift!.value = todEnabled ? MathUtils.clamp(this.dials.blackLift, 0, 0.35) : 0;
    uniforms.bloomStrength!.value = todEnabled
      ? Math.max(0, this.activeGrade.bloomStrength * this.dials.bloomStrength)
      : 0;
    this.bloomExtractUniforms.bloomThreshold.value = MathUtils.clamp(this.dials.bloomThreshold, 0, 0.99);
    uniforms.dustHeightStart!.value = this.dials.dustHeightStart;
    uniforms.dustHeightEnd!.value = Math.max(this.dials.dustHeightStart + 0.01, this.dials.dustHeightEnd);
    uniforms.dustNoiseScale!.value = Math.max(0.5, this.dials.dustNoiseScale);
    uniforms.dustPatchiness!.value = MathUtils.clamp(this.dials.dustPatchiness, 0, 1);
    uniforms.dustAspect!.value = this.displayWidth / Math.max(1, this.displayHeight);
  }

  private renderBloom(renderer: WebGLRenderer): void {
    if (this.uniforms.bloomStrength.value <= 0) return;
    this.bloomQuad.material = this.bloomExtractMaterial;
    renderer.setRenderTarget(this.bloomExtractTarget);
    renderer.clear();
    renderer.render(this.bloomScene, this.camera);

    this.bloomQuad.material = this.bloomBlurMaterial;
    this.bloomBlurUniforms.sourceTexture.value = this.bloomExtractTarget.texture;
    this.blurTexelStep.set(1 / this.bloomWidth, 0);
    renderer.setRenderTarget(this.bloomBlurTarget);
    renderer.clear();
    renderer.render(this.bloomScene, this.camera);

    this.bloomBlurUniforms.sourceTexture.value = this.bloomBlurTarget.texture;
    this.blurTexelStep.set(0, 1 / this.bloomHeight);
    renderer.setRenderTarget(this.bloomExtractTarget);
    renderer.clear();
    renderer.render(this.bloomScene, this.camera);
  }

  /**
   * Linear fog tuned to the visual frame: with the locked ortho iso camera,
   * camera-space depth on the ground plane varies only with screen height.
   * halfDepth is the depth spread between the focus row and the top edge, so
   * nearT/farT dial the haze in screen-relative terms at every zoom level.
   */
  private updateFog(scene: Scene, camera: Camera): void {
    if (this.sceneFogOwnedExternally) return;
    const fog = scene.fog as Fog | null;
    if (!fog || !("near" in fog)) return;
    if (!this.dials.fogEnabled) {
      fog.near = 1e6;
      fog.far = 2e6;
      return;
    }
    const ortho = camera as OrthographicCamera;
    const frustumHeight = ortho.isOrthographicCamera ? ortho.top - ortho.bottom : 72;
    const halfDepth = frustumHeight / 2 / Math.tan(pitchRadians);
    // Storm sight collapse: the event pulls the fog window INTO the frame
    // (depth-honest — never a screen-border treatment).
    const stormT = MathUtils.clamp(this.storm.severity01, 0, 1);
    const nearT = MathUtils.lerp(this.dials.fogNearT, this.storm.fogNearT, stormT);
    const farT = MathUtils.lerp(this.dials.fogFarT * this.activeFogFarScale, this.storm.fogFarT, stormT);
    fog.near = cameraDistance + halfDepth * nearT;
    fog.far = Math.max(fog.near + 1, cameraDistance + halfDepth * farT);
  }

  /**
   * Zoom-aware atmosphere: the ratified vertical distance haze PLUS the
   * border airfield.
   *
   * Legacy band density ramps with zoom exactly as ratified (~0 at max
   * zoom-IN). The border airfield keeps a floor at zoom-in (the air near
   * the eye does not vanish when you lean in) and is driven by the shared
   * Worldfeel wind: direction sets layer drift (projected into the locked
   * iso frame), the gust cycle breathes density and speed, daylight blends
   * toward the biome night register, and biome switches cross-fade over
   * ~1.2 s so planetfall never pops the air. The dust colour mirrors
   * scene.fog so both systems match the horizon haze.
   */
  private updateDust(scene: Scene, camera: Camera): void {
    const fog = scene.fog as Fog | null;
    if (fog) this.dustColor.set(fog.color.r, fog.color.g, fog.color.b);

    const ortho = camera as OrthographicCamera;
    const frustumHeight = ortho.isOrthographicCamera ? ortho.top - ortho.bottom : 0;
    const base = SUCCESSOR_3D_CONFIG.camera.baseFrustumHeightCells;
    const zoomIn = SUCCESSOR_3D_CONFIG.camera.maxZoomPercent;
    const zoomOut = SUCCESSOR_3D_CONFIG.camera.minZoomPercent;
    let zoomT = 0;
    if (frustumHeight > 0 && zoomIn > zoomOut) {
      const zoomPercent = (base / frustumHeight) * 100;
      zoomT = MathUtils.clamp((zoomIn - zoomPercent) / (zoomIn - zoomOut), 0, 1);
    }
    const nowMs = performance.now();
    const nowSeconds = nowMs / 1000;
    const storm = this.storm;
    const stormT = MathUtils.clamp(storm.severity01, 0, 1);
    this.uniforms.dustStrength!.value = zoomT * Math.max(0, this.dials.dustMaxStrength);
    // Storm haze is the air itself — even, whole-frame, NOT zoom-gated
    // (uniform-air ruling mechanism; the ambient term is the ratified path).
    this.uniforms.dustAmbient!.value = Math.max(
      zoomT * Math.max(0, this.dials.dustAmbient),
      stormT * Math.max(0, storm.dustAmbient),
    );
    this.uniforms.dustDrift!.value = nowSeconds * this.dials.dustDriftSpeed;

    // ── Border airfield ─────────────────────────────────────────────────
    // Biome cross-fade (planetfall pop guard): freeze the current blend as
    // the new FROM, then ease toward the new biome's register.
    if (this.biome !== this.atmoBiome) {
      mixAtmosphereParams(this.atmoFrom, this.atmoActive, this.atmoActive, 1);
      this.atmoTarget = readBiomeAtmosphere(this.biome);
      this.atmoBiome = this.biome;
      this.atmoBlendStartMs = nowMs;
    }
    const blendT = this.atmoBlendStartMs === 0
      ? 1
      : MathUtils.clamp((nowMs - this.atmoBlendStartMs) / 1200, 0, 1);
    const atmo = mixAtmosphereParams(this.atmoActive, this.atmoFrom, this.atmoTarget, blendT);

    const wind = this.env?.wind ?? null;
    const gust01 = wind?.gust01 ?? 0.5;
    const daylight = this.dials.todEnabled
      ? MathUtils.smoothstep(this.activeGrade.sceneDarken, 0.5, 1)
      : 1;
    // Drift is the INTEGRATED wind path in UV units (offset += dir·speed·dt):
    // when the Worldfeel wander swings the wind back, the field slows and
    // curves — it never retraces its own path (the old `time × currentWind`
    // exactly reversed, reading as a texture sliding back and forth).
    // Speed unit = the ratified dustDriftSpeed dial; gusts push the pace.
    const dt = this.atmoLastNowMs === 0 ? 0 : Math.min(0.1, Math.max(0, (nowMs - this.atmoLastNowMs) / 1000));
    this.atmoLastNowMs = nowMs;
    const [windX, windY] = projectWindToScreenUv(wind?.dirX ?? 1, wind?.dirZ ?? 0, atmo.windRise);
    const driftUnit = this.dials.dustDriftSpeed * atmo.driftScale * (0.7 + 0.6 * gust01);
    this.atmoWind.x += windX * driftUnit * dt;
    this.atmoWind.y += windY * driftUnit * dt;
    // Churn advances with its own clock so grit evolves even in still air.
    this.atmoChurnValue += dt * 0.075 * (0.6 + 0.8 * gust01);

    const densityScale = atmosphereDensityScale(gust01, daylight, atmo.gustiness, atmo.nightDensityScale);
    const zoomFloor = 0.55 + 0.45 * zoomT;
    const strength = Math.max(0, this.dials.atmoBorderStrength)
      * atmo.borderStrength * densityScale * zoomFloor;
    // Storm rage: the border airfield surges toward the event register and
    // kicks briefly on hazard damage ticks (exposed-drain feedback).
    const pulse = MathUtils.clamp(storm.hazardPulse01, 0, 1);
    const stormStrength = Math.max(strength, stormT * storm.borderStrength) + pulse * 0.22;
    this.uniforms.atmoStrength!.value = MathUtils.clamp(stormStrength, 0, 1);
    this.uniforms.atmoChurn!.value = this.atmoChurnValue;
    this.uniforms.atmoBorderWidth!.value = Math.max(0.02, atmo.borderWidth);
    this.uniforms.atmoCornerBoost!.value = Math.max(0, atmo.cornerBoost);
    this.uniforms.atmoTopBias!.value = Math.max(0, atmo.topBias);
    this.uniforms.atmoBottomBias!.value = Math.max(0, atmo.bottomBias);
    this.atmoAccent.set(
      MathUtils.lerp(MathUtils.lerp(atmo.accentTint[0], storm.accentTint[0], stormT), 1.3, pulse * 0.6),
      MathUtils.lerp(MathUtils.lerp(atmo.accentTint[1], storm.accentTint[1], stormT), 0.6, pulse * 0.6),
      MathUtils.lerp(MathUtils.lerp(atmo.accentTint[2], storm.accentTint[2], stormT), 0.52, pulse * 0.6),
    );
    this.uniforms.atmoMote!.value = Math.max(0, atmo.moteStrength * this.dials.atmoMoteScale)
      * densityScale * MathUtils.lerp(1, Math.max(1, storm.moteScale), stormT);
    this.uniforms.atmoLayering!.value = MathUtils.clamp(this.dials.atmoLayering, 0, 1);
    // The airfield's own lattice scale; the legacy band keeps its dial.
    this.uniforms.atmoNoiseScale!.value = Math.max(0.5, atmo.noiseScale);

    let shimmerGate = 0;
    const clock = this.env?.clock;
    if (this.dials.todEnabled && clock && clock.sun.elevation > 0.55 && zoomT > 0.3) {
      const sunGate = MathUtils.smoothstep(clock.sun.elevation, 0.55, 0.85);
      const zoomGate = MathUtils.smoothstep(zoomT, 0.3, 1);
      shimmerGate = sunGate * zoomGate;
    }
    this.uniforms.shimmerAmplitude!.value = MathUtils.clamp(this.dials.shimmerAmplitude, 0, 1.2) * shimmerGate;
    this.uniforms.shimmerPhase!.value = nowMs * 0.001 * Math.PI * 2 * shimmerCyclesPerSecond;
  }
}
