import {
  Color,
  DoubleSide,
  DynamicDrawUsage,
  InstancedBufferAttribute,
  InstancedMesh,
  MathUtils,
  Matrix4,
  PlaneGeometry,
  Quaternion,
  Scene,
  ShaderMaterial,
  Vector3,
  Vector4,
  type Fog,
} from "three";
import type { SuccessorBiomeId } from "../../config";
import type { WorldEnvironment } from "../environment";

/**
 * WEATHER — in-scene volumetric imposters (owner brief 2026-07-05: "real
 * 3-D weatherlook, not texture slide back and forth").
 *
 * The atmosphere lives IN THE WORLD, not on the lens: a single instanced
 * draw of large horizontal noise strata (the PS2-era mist solution — big
 * soft alpha sheets) drifting downwind through the frustum. Because they
 * render into the low-res scene target with depth testing, they are
 * occluded by megaliths, titans, and pawns, sit under the linear fog, and
 * inherit the ToD grade + posterize + dither for free — real depth cues
 * screen-space post can never fake.
 *
 * Three "back and forth" killers, all deliberate:
 * - Drift is the INTEGRAL of the live Worldfeel wind (offset += dir·speed·dt),
 *   never `time × currentWind` — when the wind wanders back, banks slow and
 *   turn; the field never reverses along its own path.
 * - The noise field EVOLVES: alpha lerps between two time-slices of the
 *   lattice (churn), so banks bloom and dissolve instead of translating.
 * - Sheets are anchored in WORLD space and wrap around the camera focus:
 *   panning moves the player through the weather, not the weather across
 *   the screen.
 *
 * Two strata bands per biome (low bank + high veil) with per-instance seed,
 * phase, and band parallax. Biome switches cross-fade sheet opacity over
 * ~1.2 s (planetfall pop guard). Sheet colour mirrors scene.fog so the
 * banks always belong to the same air as the horizon.
 */

interface WeatherBandSpec {
  /** Instances in this band. */
  count: number;
  /** Sheet size in world units (width along wind, depth across). */
  sizeX: number;
  sizeZ: number;
  /** World-height range the band occupies. */
  heightMin: number;
  heightMax: number;
  /** Fraction of the shared wind drift this band rides (parallax). */
  driftFactor: number;
  /** Peak sheet opacity. */
  opacity: number;
  /** Noise cells across the sheet (bank graininess). */
  noiseScale: number;
  /** Churn rate in slices/second (bank bloom/dissolve speed). */
  churnRate: number;
}

interface WeatherBiomeSpec {
  low: WeatherBandSpec;
  high: WeatherBandSpec;
  /** Wind speed in world units/second at gust01 = 0.5. */
  windSpeed: number;
  /** Extra speed at full gust (multiplier over windSpeed). */
  gustSpeedBoost: number;
  /** Opacity response to the gust cycle (0 = steady air). */
  gustOpacity: number;
  /** Daylight → night opacity blend target (desert settles, mist thickens). */
  nightOpacityScale: number;
}

/**
 * Biome registers. Ashvat: sand banks are shallow, fast, and wind-hungry —
 * a low skimming band plus a thin high veil. Verdance: mist is a resident —
 * dense slow ground pads hugging the floor and a brooding canopy gloom.
 */
const WEATHER_SPECS: Record<SuccessorBiomeId, WeatherBiomeSpec> = {
  desert: {
    low: { count: 12, sizeX: 34, sizeZ: 20, heightMin: 0.5, heightMax: 1.6, driftFactor: 1, opacity: 0.46, noiseScale: 2.6, churnRate: 0.09 },
    high: { count: 6, sizeX: 46, sizeZ: 26, heightMin: 3.4, heightMax: 6.2, driftFactor: 1.45, opacity: 0.26, noiseScale: 1.9, churnRate: 0.06 },
    windSpeed: 2.6,
    gustSpeedBoost: 1.1,
    gustOpacity: 0.75,
    nightOpacityScale: 0.7,
  },
  forest: {
    low: { count: 16, sizeX: 24, sizeZ: 16, heightMin: 0.25, heightMax: 1.1, driftFactor: 1, opacity: 0.5, noiseScale: 3.1, churnRate: 0.05 },
    high: { count: 6, sizeX: 40, sizeZ: 24, heightMin: 4.5, heightMax: 7.5, driftFactor: 0.6, opacity: 0.3, noiseScale: 2.2, churnRate: 0.035 },
    windSpeed: 0.7,
    gustSpeedBoost: 0.5,
    gustOpacity: 0.35,
    nightOpacityScale: 1.35,
  },
};

/** World-space field the sheets wrap inside, centred on the camera focus. */
const FIELD_HALF_X = 42;
const FIELD_HALF_Z = 34;
/** Sheets fade in past this distance from the focus (combat stays readable). */
const FOCUS_CLEAR_RADIUS = 5;
const FOCUS_FADE_RADIUS = 12;
const BIOME_FADE_SECONDS = 1.2;

const scratchMatrix = new Matrix4();
const scratchScale = new Vector3();
const scratchPos = new Vector3();
const flatAxis = new Vector3(1, 0, 0);
const yawAxis = new Vector3(0, 0, 1);
const scratchYawQuat = new Quaternion();

interface SheetSlot {
  /** Field-local anchor (pre-drift), wrapped into the field box. */
  baseX: number;
  baseZ: number;
  height: number;
  band: 0 | 1;
  seed: number;
  /** Precomposed lie-flat + per-sheet yaw rotation (no per-frame allocs). */
  rotation: Quaternion;
}

export class WeatherRenderer {
  private readonly scene: Scene;
  private readonly env: WorldEnvironment;
  private mesh: InstancedMesh | null = null;
  private material: ShaderMaterial | null = null;
  private geometry: PlaneGeometry | null = null;
  private slots: SheetSlot[] = [];
  private spec: WeatherBiomeSpec = WEATHER_SPECS.desert;
  private biome: SuccessorBiomeId = "desert";
  private pendingBiome: SuccessorBiomeId | null = null;
  /** 1 = fully faded in; during biome swap fades 1→0, swaps, 0→1. */
  private biomeFade = 1;
  private fadingOut = false;
  /** Integrated wind drift (world units) — THE anti-back-and-forth. */
  private driftX = 0;
  private driftZ = 0;
  /** Storm drive (StormDirector): 0 = ambient weather, 1 = full event air. */
  private stormSeverity = 0;
  private stormOpacityTarget = 0;
  private stormWindMul = 1;
  private stormChurnMul = 1;
  private readonly fogColor = new Color("#c9ad82");

  private readonly uniforms = {
    weatherColor: { value: new Vector3(0.79, 0.68, 0.51) },
    churnTime: { value: 0 },
    globalOpacity: { value: 0 },
    focusXZ: { value: { x: 0, y: 0 } },
    clearRadius: { value: FOCUS_CLEAR_RADIUS },
    fadeRadius: { value: FOCUS_FADE_RADIUS },
    fogNear: { value: 85 },
    fogFar: { value: 185 },
    // World-XZ shelter cutouts (minX, minZ, maxX, maxZ) — banks part around
    // marked shelter interiors (see weather/storm.ts).
    shelterBoxes: { value: [new Vector4(0, 0, 0, 0), new Vector4(0, 0, 0, 0)] },
    shelterCount: { value: 0 },
    /** 0..1: cutout strength rides the occupant's shelter-mute ramp. */
    shelterCutStrength: { value: 0 },
  };

  constructor(scene: Scene, env: WorldEnvironment) {
    this.scene = scene;
    this.env = env;
    this.buildMesh();
  }

  setBiome(biome: SuccessorBiomeId): void {
    if (biome === this.biome && this.pendingBiome === null) return;
    this.pendingBiome = biome;
    this.fadingOut = true;
  }
  /**
   * Storm event drive: at severity 1 the banks race (windMul), boil
   * (churnMul), and thicken toward opacityTarget. Severity 0 restores the
   * ambient register untouched.
   */
  setStormDrive(severity01: number, opacityTarget: number, windMul: number, churnMul: number): void {
    this.stormSeverity = MathUtils.clamp(severity01, 0, 1);
    this.stormOpacityTarget = opacityTarget;
    this.stormWindMul = Math.max(0, windMul);
    this.stormChurnMul = Math.max(0, churnMul);
  }

  /**
   * Shelter cutouts (world-XZ boxes) the banks part around — only the
   * OCCUPIED shelter, faded by strength01 (see weather/storm.ts).
   */
  setShelterCutouts(boxes: ReadonlyArray<{ minX: number; minZ: number; maxX: number; maxZ: number }>, strength01: number): void {
    const cutouts = this.uniforms.shelterBoxes.value;
    const count = Math.min(boxes.length, cutouts.length);
    for (let i = 0; i < count; i += 1) {
      const box = boxes[i]!;
      cutouts[i]!.set(box.minX - 0.1, box.minZ - 0.1, box.maxX + 0.1, box.maxZ + 0.1);
    }
    this.uniforms.shelterCount.value = count;
    this.uniforms.shelterCutStrength.value = MathUtils.clamp(strength01, 0, 1);
  }

  update(focusX: number, focusZ: number, dtSeconds: number, _timeMs: number): void {
    const mesh = this.mesh;
    const material = this.material;
    if (!mesh || !material) return;
    const dt = Math.min(0.1, Math.max(0, dtSeconds));

    // Biome cross-fade: drain, swap the register, refill.
    if (this.fadingOut) {
      this.biomeFade = Math.max(0, this.biomeFade - dt / BIOME_FADE_SECONDS);
      if (this.biomeFade === 0 && this.pendingBiome !== null) {
        this.biome = this.pendingBiome;
        this.pendingBiome = null;
        this.spec = WEATHER_SPECS[this.biome];
        this.reseedSlots();
        this.fadingOut = false;
      }
    } else if (this.biomeFade < 1) {
      this.biomeFade = Math.min(1, this.biomeFade + dt / BIOME_FADE_SECONDS);
    }

    // Integrate the live wind: banks slow and TURN when the wander swings —
    // they never retrace their own path.
    const wind = this.env.wind;
    const spec = this.spec;
    const stormT = this.stormSeverity;
    const speed = spec.windSpeed
      * (1 + (wind.gust01 - 0.5) * spec.gustSpeedBoost)
      * MathUtils.lerp(1, this.stormWindMul, stormT);
    this.driftX += wind.dirX * speed * dt;
    this.driftZ += wind.dirZ * speed * dt;

    // Churn evolves the banks themselves (bloom/dissolve between lattice
    // slices); gusts and daylight breathe global opacity; sheet colour
    // mirrors the live fog so the banks belong to the horizon air.
    const fog = this.scene.fog as Fog | null;
    if (fog) this.fogColor.copy(fog.color);
    this.uniforms.weatherColor.value.set(this.fogColor.r, this.fogColor.g, this.fogColor.b);
    this.uniforms.churnTime.value += dt
      * (spec.low.churnRate + spec.high.churnRate) * 0.5
      * MathUtils.lerp(1, this.stormChurnMul, stormT);
    const clock = this.env.clock;
    const daylight = clock ? MathUtils.clamp(clock.sun.elevation, 0, 1) : 1;
    const nightScale = spec.nightOpacityScale + (1 - spec.nightOpacityScale) * daylight;
    const gustScale = 1 - spec.gustOpacity * 0.5 + wind.gust01 * spec.gustOpacity;
    const ambientOpacity = this.biomeFade * nightScale * gustScale;
    // Storm air: pull the whole field toward the event's density target —
    // never below ambient (a storm cannot thin the resident register).
    this.uniforms.globalOpacity.value = MathUtils.lerp(
      ambientOpacity,
      Math.max(ambientOpacity, this.stormOpacityTarget),
      stormT,
    );
    this.uniforms.focusXZ.value.x = focusX;
    this.uniforms.focusXZ.value.y = focusZ;
    // Sync the linear-fog window (post.ts re-derives it every frame): banks
    // genuinely DISSOLVE into the horizon haze with camera depth instead of
    // floating as alpha cards over already-fogged terrain.
    if (fog && "near" in fog) {
      this.uniforms.fogNear.value = fog.near;
      this.uniforms.fogFar.value = fog.far;
    }

    // Re-anchor every sheet in world space, wrapped into the field box
    // around the focus. Wrapping in WORLD coordinates (not screen) keeps
    // each bank stationary relative to the ground while you pan past it.
    const fieldX = FIELD_HALF_X * 2;
    const fieldZ = FIELD_HALF_Z * 2;
    for (let i = 0; i < this.slots.length; i += 1) {
      const slot = this.slots[i]!;
      const band = slot.band === 0 ? spec.low : spec.high;
      const worldX = slot.baseX + this.driftX * band.driftFactor;
      const worldZ = slot.baseZ + this.driftZ * band.driftFactor;
      // Wrap into [focus - half, focus + half) on both axes.
      const wrappedX = MathUtils.euclideanModulo(worldX - (focusX - FIELD_HALF_X), fieldX) + (focusX - FIELD_HALF_X);
      const wrappedZ = MathUtils.euclideanModulo(worldZ - (focusZ - FIELD_HALF_Z), fieldZ) + (focusZ - FIELD_HALF_Z);
      scratchPos.set(wrappedX, slot.height, wrappedZ);
      scratchScale.set(band.sizeX, band.sizeZ, 1);
      scratchMatrix.compose(scratchPos, slot.rotation, scratchScale);
      mesh.setMatrixAt(i, scratchMatrix);
    }
    mesh.instanceMatrix.needsUpdate = true;
  }

  dispose(): void {
    if (this.mesh) this.scene.remove(this.mesh);
    this.geometry?.dispose();
    this.material?.dispose();
    this.mesh = null;
    this.material = null;
    this.geometry = null;
  }

  private totalCount(): number {
    // Allocate for the densest biome so swaps never rebuild the mesh.
    let max = 0;
    for (const spec of Object.values(WEATHER_SPECS)) {
      max = Math.max(max, spec.low.count + spec.high.count);
    }
    return max;
  }

  private buildMesh(): void {
    const count = this.totalCount();
    this.geometry = new PlaneGeometry(1, 1, 1, 1);
    const seedAttr = new Float32Array(count);
    const noiseAttr = new Float32Array(count);
    const opacityAttr = new Float32Array(count);
    this.geometry.setAttribute("instanceSeed", new InstancedBufferAttribute(seedAttr, 1));
    this.geometry.setAttribute("instanceNoise", new InstancedBufferAttribute(noiseAttr, 1));
    this.geometry.setAttribute("instanceOpacity", new InstancedBufferAttribute(opacityAttr, 1));

    this.material = new ShaderMaterial({
      uniforms: this.uniforms,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      side: DoubleSide,
      vertexShader: `
        attribute float instanceSeed;
        attribute float instanceNoise;
        attribute float instanceOpacity;
        varying vec2 vWorldXZ;
        varying vec2 vLocal;
        varying float vSeed;
        varying float vNoiseScale;
        varying float vOpacity;
        varying float vViewDepth;
        void main() {
          vLocal = uv - 0.5;
          vec4 world = instanceMatrix * vec4(position, 1.0);
          vec4 worldPos = modelMatrix * world;
          vWorldXZ = worldPos.xz;
          vSeed = instanceSeed;
          vNoiseScale = instanceNoise;
          vOpacity = instanceOpacity;
          vec4 viewPos = viewMatrix * worldPos;
          vViewDepth = -viewPos.z;
          gl_Position = projectionMatrix * viewPos;
        }
      `,
      fragmentShader: `
        uniform vec3 weatherColor;
        uniform float churnTime;
        uniform float globalOpacity;
        uniform vec2 focusXZ;
        uniform float clearRadius;
        uniform float fadeRadius;
        uniform float fogNear;
        uniform float fogFar;
        uniform vec4 shelterBoxes[2];
        uniform int shelterCount;
        uniform float shelterCutStrength;
        varying vec2 vWorldXZ;
        varying vec2 vLocal;
        varying float vSeed;
        varying float vNoiseScale;
        varying float vOpacity;
        varying float vViewDepth;

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
        // Time-slice churn: the bank blooms and dissolves between two
        // lattice slices instead of translating — evolution, not slide.
        float bankNoise(vec2 p, float slice) {
          float s0 = floor(slice);
          float s1 = s0 + 1.0;
          float f = slice - s0;
          f = f * f * (3.0 - 2.0 * f);
          float n0 = vnoise(p + vec2(s0 * 61.7, s0 * 19.3));
          float n1 = vnoise(p + vec2(s1 * 61.7, s1 * 19.3));
          return mix(n0, n1, f);
        }

        void main() {
          // Sheet-local soft footprint: banks are lozenges, never rectangles.
          float rim = 1.0 - smoothstep(0.18, 0.5, length(vLocal * vec2(1.0, 1.35)));
          if (rim <= 0.001) discard;

          // WORLD-anchored bank body with churn evolution (two octaves).
          vec2 wp = vWorldXZ * (vNoiseScale * 0.06) + vSeed * 37.1;
          float slice = churnTime + vSeed * 3.7;
          float n = bankNoise(wp, slice) * 0.66 + bankNoise(wp * 2.3 + 11.9, slice * 1.7) * 0.34;
          float body = smoothstep(0.30, 0.78, n);

          // Gameplay clarity: banks thin out over the camera focus.
          float focusDist = distance(vWorldXZ, focusXZ);
          float focusFade = smoothstep(clearRadius, fadeRadius, focusDist);

          // Depth: banks dissolve toward the linear fog window like any
          // other world surface, but keep a floor of presence — fully
          // fog-killed banks left the frame bottom-heavy and read as a
          // top-only effect (owner sizing pass 2026-07-05).
          float fogT = clamp((vViewDepth - fogNear) / max(1.0, fogFar - fogNear), 0.0, 1.0);

          // Shelter cutout: banks part around marked shelter interiors
          // (soft world-space edge; matches the storm-front wall shader).
          float shelterKeep = 1.0;
          for (int i = 0; i < 2; i += 1) {
            if (i >= shelterCount) break;
            vec4 sbox = shelterBoxes[i];
            vec2 inset = max(vec2(sbox.x, sbox.y) - vWorldXZ, vWorldXZ - vec2(sbox.z, sbox.w));
            float outside = max(inset.x, inset.y);
            shelterKeep = min(shelterKeep, smoothstep(0.0, 0.9, max(outside, 0.0)));
          }
          shelterKeep = mix(1.0, shelterKeep, shelterCutStrength);

          float alpha = rim * body * vOpacity * globalOpacity * mix(0.35, 1.0, focusFade) * (1.0 - fogT * 0.65) * shelterKeep;
          if (alpha <= 0.004) discard;
          gl_FragColor = vec4(weatherColor, alpha);
        }
      `,
    });

    this.mesh = new InstancedMesh(this.geometry, this.material, count);
    this.mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 40;
    this.scene.add(this.mesh);
    this.reseedSlots();
  }

  /** Deterministic per-biome sheet layout (xorshift hash; runtime stays alloc-free). */
  private reseedSlots(): void {
    const mesh = this.mesh;
    const geometry = this.geometry;
    if (!mesh || !geometry) return;
    const spec = this.spec;
    const bands: Array<{ band: 0 | 1; spec: WeatherBandSpec }> = [
      { band: 0, spec: spec.low },
      { band: 1, spec: spec.high },
    ];
    const slots: SheetSlot[] = [];
    const seedAttr = geometry.getAttribute("instanceSeed") as InstancedBufferAttribute;
    const noiseAttr = geometry.getAttribute("instanceNoise") as InstancedBufferAttribute;
    const opacityAttr = geometry.getAttribute("instanceOpacity") as InstancedBufferAttribute;
    let rng = this.biome === "desert" ? 0x51f1_5eed : 0x7e2d_a11d;
    const next = (): number => {
      rng ^= rng << 13;
      rng ^= rng >>> 17;
      rng ^= rng << 5;
      rng >>>= 0;
      return rng / 0xffff_ffff;
    };
    for (const { band, spec: bandSpec } of bands) {
      for (let i = 0; i < bandSpec.count; i += 1) {
        const index = slots.length;
        const rotation = new Quaternion().setFromAxisAngle(flatAxis, -Math.PI / 2);
        scratchYawQuat.setFromAxisAngle(yawAxis, (next() * 2 - 1) * 0.5);
        rotation.multiply(scratchYawQuat);
        slots.push({
          baseX: (next() * 2 - 1) * FIELD_HALF_X,
          baseZ: (next() * 2 - 1) * FIELD_HALF_Z,
          height: MathUtils.lerp(bandSpec.heightMin, bandSpec.heightMax, next()),
          band,
          seed: next() * 8,
          rotation,
        });
        seedAttr.setX(index, slots[index]!.seed);
        noiseAttr.setX(index, bandSpec.noiseScale);
        opacityAttr.setX(index, bandSpec.opacity);
      }
    }
    // Park any surplus instances (denser other-biome allocation) at zero alpha.
    for (let i = slots.length; i < mesh.count; i += 1) {
      seedAttr.setX(i, 0);
      noiseAttr.setX(i, 1);
      opacityAttr.setX(i, 0);
      scratchMatrix.makeScale(0.0001, 0.0001, 0.0001);
      mesh.setMatrixAt(i, scratchMatrix);
    }
    seedAttr.needsUpdate = true;
    noiseAttr.needsUpdate = true;
    opacityAttr.needsUpdate = true;
    this.slots = slots;
    mesh.instanceMatrix.needsUpdate = true;
  }
}
