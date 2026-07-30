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
import type { PlayState, ServerAuthorityPlacedCampState, SliceSnapshot } from "@successor/client/src/slice-core/gameState";
import { propsForArea } from "@successor/client/src/slice-core/worldQueries";
import { CAMP_SHELTER_SAFE_HALF_EXTENT_CELLS } from "@successor/client/src/slice-core/campSystem";

/**
 * STORM — the per-planet weather EVENT presentation (Stormfront v1).
 *
 * Server truth (GameShard weather controller → snapshot/delta `weather`):
 * a fixed damage circle per area with a phase machine
 * (idle → warning → active → decay) and an intensity envelope. The Rust sim
 * applies hazard damage inside the circle during `active`; props flagged
 * `shelter: true` exempt actors standing inside their (inset) footprint.
 *
 * Presentation problem: at radius 48 the circle's edge NEVER enters the
 * locked iso frustum (~14–26 cells of visible ground depth), so a
 * ring-shaped wall would be invisible from the spawn at the circle center.
 * The event therefore reads through TWO instruments:
 *
 * 1. THE FRONT — a world-anchored haboob wall (instanced vertical noise
 *    sheets on a straight line perpendicular to a fixed sweep direction)
 *    that physically rolls ACROSS the zone during `warning`. It crosses the
 *    player's view no matter where they stand inside the circle: the
 *    approach is something you SEE coming, then it breaks over you.
 * 2. THE AIR — everything behind the front flips to storm air: strata
 *    density/speed (WeatherRenderer storm drive), sight collapse + grade
 *    shift + border rage (Ps2PostRenderer storm drive), and pinned wind
 *    (WorldEnvironment storm drive). Severity is a pure function of the
 *    server phase envelope × "behind the front" × "inside the circle", so
 *    restarts and reconnects land on the identical look.
 *
 * Shelter: standing inside a `shelter` prop's inset footprint mutes the AIR
 * (interior calm) while the world outside the doorway keeps raging — the
 * same geometry test the server uses for damage exemption (inset 0.25
 * cells), so what you feel visually is what the sim charges you for.
 *
 * Dev loop: `?forceWeather=sandstorm&weatherPhase=active&weatherProgress=0.6`
 * drives the whole choreography without a server (`window.__successor3dStorm`
 * exposes the same dials live).
 */

export type WeatherPhaseId = "idle" | "warning" | "active" | "decay";

export interface WeatherEventView {
  areaId: string;
  eventType: string;
  phase: WeatherPhaseId;
  centerX: number;
  centerY: number;
  radiusCells: number;
  /** 0..1: ramps up across warning, 1 in active, falls across decay. */
  intensity: number;
  /**
   * SERVER-AUTHORITATIVE sweep heading (radians, world x/z plane): the
   * direction the front travels. The server computes it with the shared
   * FNV-1a formula below (`sweepAngleForArea`) or a slice config override;
   * absence falls back to the identical client-side formula, so every
   * observer sees the same front either way.
   */
  sweepDirRad?: number;
  /**
   * Per-instance system strength 0..1 (server-rolled per cycle). Drives the
   * BLIND scale: ≤0.55 = the baseline storm register; →1 = near white-out
   * (sight collapses to metres, the air is more sand than light).
   */
  magnitude?: number;
  /** Absolute tick the current phase ends (server clock; datapad countdowns). */
  phaseEndsAtTick?: number;
  /** Absolute tick the current event instance fully clears (datapad ETA). */
  resolvesAtTick?: number;
}

/** Presentation targets the storm pushes into post/strata/wind at severity 1. */
interface StormSpec {
  /** Front wall sheet height (world units) and per-sheet width. */
  frontHeight: number;
  frontSheetWidth: number;
  /** Number of instanced sheets along the front line. */
  frontSegments: number;
  /**
   * Wall body colours as MULTIPLIERS over the live fog colour — the wall is
   * made of the same air as the horizon (any ToD/biome grade harmonizes):
   * base sits deeper than the fog, crest glows brighter (sun-caught).
   */
  baseFogMul: [number, number, number];
  crestFogMul: [number, number, number];
  /** Overall wall opacity multiplier (sporefall banks are softer). */
  frontAlpha: number;
  /** Ragged top dissolve band (0 tight slab .. 1 shredded). */
  raggedness: number;
  /** Face boil rate (churn slices/sec) — the wall ROLLS, never slides. */
  boilRate: number;
  /** Air register at severity 1 (multiplied over the ToD fog colour). */
  airTint: [number, number, number];
  /** Strata (WeatherRenderer) drive. */
  strataOpacity: number;
  strataWindMul: number;
  strataChurnMul: number;
  /** Post drive. */
  fogNearT: number;
  fogFarT: number;
  dustAmbient: number;
  borderStrength: number;
  accentTint: [number, number, number];
  moteScale: number;
  boneShift: [number, number, number];
  darken: number;
  desatAdd: number;
  /** Wind drive. */
  windStrength: number;
  gustFloor: number;
}

const STORM_SPECS: Record<string, StormSpec> = {
  sandstorm: {
    frontHeight: 16,
    frontSheetWidth: 11,
    frontSegments: 40,
    baseFogMul: [0.84, 0.7, 0.52],
    crestFogMul: [1.16, 1.07, 0.92],
    frontAlpha: 1,
    raggedness: 0.62,
    boilRate: 0.34,
    airTint: [1.02, 0.87, 0.62],
    strataOpacity: 0.92,
    strataWindMul: 3.1,
    strataChurnMul: 2.4,
    fogNearT: 0.34,
    fogFarT: 0.86,
    dustAmbient: 0.32,
    borderStrength: 0.82,
    accentTint: [1.18, 0.97, 0.7],
    moteScale: 2.1,
    boneShift: [1.08, 0.93, 0.74],
    darken: 0.85,
    desatAdd: 0.05,
    windStrength: 0.95,
    gustFloor: 0.72,
  },
  sporefall: {
    frontHeight: 9,
    frontSheetWidth: 11,
    frontSegments: 40,
    baseFogMul: [0.58, 0.76, 0.52],
    crestFogMul: [0.98, 1.15, 0.9],
    frontAlpha: 0.72,
    raggedness: 0.4,
    boilRate: 0.18,
    airTint: [0.82, 1.0, 0.74],
    strataOpacity: 0.95,
    strataWindMul: 1.6,
    strataChurnMul: 1.9,
    fogNearT: 0.28,
    fogFarT: 0.72,
    dustAmbient: 0.3,
    borderStrength: 0.9,
    accentTint: [0.92, 1.16, 0.84],
    moteScale: 3.2,
    darken: 0.78,
    desatAdd: 0.02,
    boneShift: [0.88, 1.03, 0.85],
    windStrength: 0.55,
    gustFloor: 0.5,
  },
};

/** Shelter footprint inset (cells) — MUST match the server's shelter box inset. */
const SHELTER_INSET_CELLS = 0.25;
/**
 * Extra client-side margin on top of the server inset before "sheltered"
 * presentation (calm air, roof-peel) engages. The client tests the PREDICTED
 * position while Rust charges the AUTHORITATIVE one — without this margin
 * the calm can flip on at a doorway the server still considers outside, and
 * the player reads "safe" while draining (verified fatal 2026-07-05).
 * Presentation may only ever be LATE about safety, never early.
 */
const SHELTER_SAFETY_MARGIN_CELLS = 0.35;
/** Front travel margin past the circle so the wall starts/ends off any view. */
const SWEEP_MARGIN_CELLS = 34;
/** Air flips over this many cells around the passing front. */
const FRONT_AIR_BAND = 6;
/** Shelter interior calm ramp (per second). */
const SHELTER_MUTE_RATE = 1.5;
/** Severity smoothing so phase flips never pop the air (per second). */
const SEVERITY_RATE = 1.35;
const HAZARD_PULSE_DECAY = 1.7;
/** Stable empty list for the strata cutout sink (no per-frame allocs). */
const NO_CUTOUTS: ReadonlyArray<{ minX: number; minZ: number; maxX: number; maxZ: number }> = [];

const scratchMatrix = new Matrix4();
const scratchPos = new Vector3();
const scratchScale = new Vector3();
const scratchQuat = new Quaternion();
const Y_AXIS = new Vector3(0, 1, 0);
/**
 * Yaw-only billboard heading for front sheets: square to the locked north-up
 * camera bearing (yaw 0°; ortho, never rotates). Yaw-only keeps the
 * sheets vertical and grounded — a full camera-facing quad would pitch with
 * the iso tilt and float off the ground.
 */
const CAMERA_FACING_YAW_RAD = 0;

interface StormForce {
  eventType: string;
  phase: WeatherPhaseId;
  /** 0..1 progress through the forced phase (drives intensity/front travel). */
  progress: number;
  /** Instance magnitude 0..1 (blind scale); omitted = 1 (max). */
  magnitude?: number;
}

export interface StormDials {
  /** Dev force: overrides server weather entirely (null = live). */
  force: StormForce | null;
  /** Read-only view of the live drive for probes/dial passes. */
  readonly severity: number;
  readonly sheltered: boolean;
  readonly phase: WeatherPhaseId;
  readonly eventType: string | null;
}

declare global {
  interface Window {
    __successor3dStorm?: StormDials;
  }
}

/** Runtime guard for the server weather snapshot (PlayState boundary). */
function isWeatherEventView(value: unknown): value is WeatherEventView {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.areaId === "string"
    && typeof record.eventType === "string"
    && (record.phase === "idle" || record.phase === "warning" || record.phase === "active" || record.phase === "decay")
    && typeof record.centerX === "number"
    && typeof record.centerY === "number"
    && typeof record.radiusCells === "number"
    && typeof record.intensity === "number"
  );
}

/** Server weather events mirrored onto PlayState (empty until the field lands/syncs). */
export function weatherEventsFromState(state: PlayState): WeatherEventView[] {
  if (!("weather" in state)) return [];
  const value = state.weather;
  if (!Array.isArray(value)) return [];
  const events: WeatherEventView[] = [];
  for (const entry of value) {
    if (isWeatherEventView(entry)) events.push(entry);
  }
  return events;
}

interface ShelterBox {
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
  propId: string;
}

/**
 * Shelter boxes for an area: slice props flagged `shelter: true` (inset to
 * match the server's damage-exemption geometry) plus placed scout camps.
 * Camp boxes use the wire-honest conservative half-extent (the sim's box is
 * anchored on the owner's exact placement position; the wire carries only
 * the cell) so the calm NEVER engages where the sim might still charge.
 */
export function shelterBoxesForArea(
  slice: SliceSnapshot,
  areaId: string,
  out: ShelterBox[],
  placedCamps: readonly ServerAuthorityPlacedCampState[] = [],
): ShelterBox[] {
  out.length = 0;
  for (const prop of propsForArea(slice, areaId)) {
    if (!("shelter" in prop) || prop.shelter !== true) continue;
    out.push({
      minX: prop.cell.x + SHELTER_INSET_CELLS,
      minZ: prop.cell.y + SHELTER_INSET_CELLS,
      maxX: prop.cell.x + prop.size.w - SHELTER_INSET_CELLS,
      maxZ: prop.cell.y + prop.size.h - SHELTER_INSET_CELLS,
      propId: prop.id,
    });
  }
  for (const camp of placedCamps) {
    if (camp.areaId !== areaId) continue;
    out.push({
      minX: camp.cellX + 0.5 - CAMP_SHELTER_SAFE_HALF_EXTENT_CELLS,
      minZ: camp.cellY + 0.5 - CAMP_SHELTER_SAFE_HALF_EXTENT_CELLS,
      maxX: camp.cellX + 0.5 + CAMP_SHELTER_SAFE_HALF_EXTENT_CELLS,
      maxZ: camp.cellY + 0.5 + CAMP_SHELTER_SAFE_HALF_EXTENT_CELLS,
      propId: camp.campId,
    });
  }
  return out;
}

/** Consumers the director drives each frame (implemented by the render stack). */
export interface StormAirSinks {
  strata: {
    setStormDrive(severity01: number, opacityTarget: number, windMul: number, churnMul: number): void;
    setShelterCutouts(boxes: ReadonlyArray<{ minX: number; minZ: number; maxX: number; maxZ: number }>, strength01: number): void;
  };
  post: {
    readonly storm: StormPostDrive;
  };
  wind: {
    setStormDrive(severity01: number, strengthTarget: number, gustFloor: number, dirRad: number | null): void;
  };
}

/** Mutable drive block owned by Ps2PostRenderer; the director writes it. */
export interface StormPostDrive {
  severity01: number;
  fogNearT: number;
  fogFarT: number;
  dustAmbient: number;
  borderStrength: number;
  accentTint: [number, number, number];
  moteScale: number;
  airTint: [number, number, number];
  boneShift: [number, number, number];
  darken: number;
  desatAdd: number;
  hazardPulse01: number;
}

interface FrontSlot {
  /** Offset along the front line from its midpoint (world units). */
  lateral: number;
  /** Per-sheet advance jitter along the sweep (ragged leading edge). */
  travelJitter: number;
  /** 0 = leading row, 1 = trailing mass row (depth thickness). */
  row: 0 | 1;
  seed: number;
  widthJitter: number;
  heightJitter: number;
}

export class StormDirector {
  private readonly scene: Scene;
  private readonly sinks: StormAirSinks;
  private mesh: InstancedMesh | null = null;
  private material: ShaderMaterial | null = null;
  private geometry: PlaneGeometry | null = null;
  private slots: FrontSlot[] = [];
  /** Scratch: live fog colour sample (wall colours derive from it). */
  private readonly baseColor = new Color();

  /** Smoothed presentation state. */
  private severity = 0;
  private appliedSeverity = 0;
  private shelterMute = 0;
  private hazardPulse = 0;
  private lastHealth: number | null = null;
  private activeEventType: string | null = null;
  private activePhase: WeatherPhaseId = "idle";
  private sheltered = false;
  private shelteredProp: string | null = null;
  private boilTime = 0;
  /** Force-mode anchor (captured at force start so it works on any map). */
  private forceCenterX: number | null = null;
  private forceCenterZ: number | null = null;
  private readonly shelterScratch: ShelterBox[] = [];
  /** Latched occupied-shelter cutout (raw box + expanded uniform form). */
  private readonly cutoutSingle = [{ minX: 0, minZ: 0, maxX: 0, maxZ: 0 }];
  private readonly cutoutBox = new Vector4(0, 0, 0, 0);

  private readonly dials: StormDials;

  private readonly uniforms = {
    baseColor: { value: new Vector3(0.49, 0.36, 0.2) },
    crestColor: { value: new Vector3(0.83, 0.66, 0.42) },
    boilTime: { value: 0 },
    wallAlpha: { value: 0 },
    raggedness: { value: 0.5 },
    fogNear: { value: 85 },
    fogFar: { value: 185 },
    // World-XZ shelter cutouts (minX, minZ, maxX, maxZ): the storm parts
    // around marked shelter interiors instead of painting through them.
    shelterBoxes: { value: [new Vector4(0, 0, 0, 0), new Vector4(0, 0, 0, 0)] },
    shelterCount: { value: 0 },
    /** 0..1: cutout fades with the shelter mute ramp (occupied box only). */
    shelterCutStrength: { value: 0 },
  };

  constructor(scene: Scene, sinks: StormAirSinks) {
    this.scene = scene;
    this.sinks = sinks;
    this.buildMesh();
    const self = this;
    this.dials = {
      force: null,
      get severity() {
        return self.appliedSeverity;
      },
      get sheltered() {
        return self.sheltered;
      },
      get phase() {
        return self.activePhase;
      },
      get eventType() {
        return self.activeEventType;
      },
    };
    if (import.meta.env.DEV) {
      window.__successor3dStorm = this.dials;
      const params = new URLSearchParams(window.location.search);
      const forced = params.get("forceWeather");
      if (forced) {
        const phaseParam = params.get("weatherPhase");
        const phase: WeatherPhaseId = phaseParam === "warning" || phaseParam === "active" || phaseParam === "decay" || phaseParam === "idle"
          ? phaseParam
          : "active";
        const progress = MathUtils.clamp(Number.parseFloat(params.get("weatherProgress") ?? "0.5") || 0.5, 0, 1);
        const magnitudeParam = Number.parseFloat(params.get("weatherMagnitude") ?? "1");
        const magnitude = Number.isFinite(magnitudeParam) ? MathUtils.clamp(magnitudeParam, 0, 1) : 1;
        this.dials.force = { eventType: forced, phase, progress, magnitude };
      }
    }
  }

  /** Live force handle (boot/app wiring may seed this from URL params too). */
  get devDials(): StormDials {
    return this.dials;
  }

  /** Prop id the local player currently stands inside (roof-peel), or null. */
  get shelteredPropId(): string | null {
    return this.shelteredProp;
  }

  update(slice: SliceSnapshot, state: PlayState, focusX: number, focusZ: number, dtSeconds: number): void {
    const dt = Math.min(0.1, Math.max(0, dtSeconds));
    const event = this.resolveEvent(state, focusX, focusZ);
    const spec = event ? STORM_SPECS[event.eventType] ?? STORM_SPECS.sandstorm! : null;

    // ── Geometry of the moment: behind-the-front × inside-the-circle ──────
    let targetSeverity = 0;
    let frontVisible = false;
    let frontTravel = 0;
    let sweepDirX = 1;
    let sweepDirZ = 0;
    let wallAlpha = 0;
    if (event && spec) {
      const sweepRad = typeof event.sweepDirRad === "number" && Number.isFinite(event.sweepDirRad)
        ? event.sweepDirRad
        : sweepAngleForArea(event.areaId);
      sweepDirX = Math.cos(sweepRad);
      sweepDirZ = Math.sin(sweepRad);
      const sweepSpan = event.radiusCells + 30;
      const relX = focusX - event.centerX;
      const relZ = focusZ - event.centerY;
      const distToCenter = Math.hypot(relX, relZ);
      const inCircle = 1 - MathUtils.smoothstep(distToCenter, event.radiusCells - 6, event.radiusCells + 10);

      if (event.phase === "warning") {
        // The front rolls from -span to +span across the warning envelope,
        // eased so the crossing LINGERS in view around the zone center
        // (~45% speed mid-sweep, faster at the far edges).
        const swing = event.intensity * 2 - 1;
        const easedT = MathUtils.lerp(event.intensity, 0.5 + 0.5 * swing * swing * swing, 0.55);
        frontTravel = MathUtils.lerp(-sweepSpan, sweepSpan, easedT);
        const alongFocus = relX * sweepDirX + relZ * sweepDirZ;
        const behind = MathUtils.smoothstep(alongFocus, frontTravel - FRONT_AIR_BAND, frontTravel + FRONT_AIR_BAND);
        // Air behind the passed front is already near-full storm; ahead of it
        // the air only pre-thickens with the server intensity ramp.
        targetSeverity = Math.max(event.intensity * 0.3, (1 - behind) * 0.9) * inCircle;
        frontVisible = true;
        wallAlpha = MathUtils.clamp(event.intensity * 6, 0, 1) * spec.frontAlpha;
      } else if (event.phase === "active") {
        targetSeverity = inCircle;
        // The wall has rolled past the far edge and dissolves into the air.
        frontTravel = sweepSpan;
        frontVisible = false;
      } else if (event.phase === "decay") {
        targetSeverity = event.intensity * inCircle;
        frontVisible = false;
      }
      this.activeEventType = event.eventType;
      this.activePhase = event.phase;
    } else {
      this.activeEventType = null;
      this.activePhase = "idle";
    }

    // ── Shelter: same inset boxes the server exempts damage inside. ──────
    // Checked storm-or-shine: the roof-peel (props renderer) wants occupancy
    // whenever the player is under a shelter roof, not only mid-event.
    // COORDINATE TRUTH: Rust charges the AUTHORITATIVE actor origin
    // (actor.position, milli-cells) — prefer the mirrored authoritative
    // position (one-snapshot latency) over the local prediction, and keep a
    // safety margin on top: presentation may only ever be LATE about
    // safety, never early (predicted-position calm proved fatal 2026-07-05).
    const playerActorId = state.serverAuthority.playerActorId ?? state.playerActorId;
    const authorityMe = playerActorId ? state.serverAuthority.actors[playerActorId] : null;
    const playerX = authorityMe ? authorityMe.x : state.player.x;
    const playerZ = authorityMe ? authorityMe.y : state.player.y;
    let inShelter = false;
    let shelteredProp: string | null = null;
    const boxes = shelterBoxesForArea(slice, state.activeAreaId, this.shelterScratch, state.serverAuthority.placedCamps);
    const margin = SHELTER_SAFETY_MARGIN_CELLS;
    let occupiedBox: ShelterBox | null = null;
    for (const box of boxes) {
      if (
        playerX >= box.minX + margin && playerX <= box.maxX - margin
        && playerZ >= box.minZ + margin && playerZ <= box.maxZ - margin
      ) {
        inShelter = true;
        shelteredProp = box.propId;
        occupiedBox = box;
        break;
      }
    }
    this.shelteredProp = shelteredProp;
    this.sheltered = inShelter;
    const muteTarget = inShelter ? 1 : 0;
    this.shelterMute = MathUtils.clamp(
      this.shelterMute + Math.sign(muteTarget - this.shelterMute) * SHELTER_MUTE_RATE * dt,
      0,
      1,
    );
    // Latch the last occupied box so the cutout can fade OUT after exit.
    if (occupiedBox) {
      this.cutoutBox.set(occupiedBox.minX - 0.1, occupiedBox.minZ - 0.1, occupiedBox.maxX + 0.1, occupiedBox.maxZ + 0.1);
      const raw = this.cutoutSingle[0]!;
      raw.minX = occupiedBox.minX;
      raw.minZ = occupiedBox.minZ;
      raw.maxX = occupiedBox.maxX;
      raw.maxZ = occupiedBox.maxZ;
    }
    // Visual cutout: ONLY the OCCUPIED shelter parts the storm, scaled by
    // the mute ramp — a roofed house you are NOT inside keeps dust streaming
    // over it (no calm halo); the carve fades in as the roof peels.
    const cutStrength = this.shelterMute;
    this.uniforms.shelterBoxes.value[0]!.copy(this.cutoutBox);
    this.uniforms.shelterCount.value = cutStrength > 0.002 ? 1 : 0;
    this.uniforms.shelterCutStrength.value = cutStrength;
    this.sinks.strata.setShelterCutouts(cutStrength > 0.002 ? this.cutoutSingle : NO_CUTOUTS, cutStrength);

    // ── Smoothed severity + interior calm ────────────────────────────────
    this.severity = MathUtils.clamp(
      this.severity + Math.sign(targetSeverity - this.severity) * SEVERITY_RATE * dt,
      Math.min(this.severity, targetSeverity),
      Math.max(this.severity, targetSeverity),
    );
    // Interior calm: near-total mute (10% floor keeps a breath of the event
    // in the grade so shelter never reads as a hard scene cut).
    const applied = this.severity * (1 - 0.9 * this.shelterMute);
    this.appliedSeverity = applied;

    // ── Hazard feedback: health drained while exposed → brief pulse ──────
    const health = playerHealthFromState(state);
    if (health !== null) {
      if (this.lastHealth !== null && health < this.lastHealth && this.severity > 0.3 && this.shelterMute < 0.5) {
        this.hazardPulse = 1;
      }
      this.lastHealth = health;
    }
    this.hazardPulse = Math.max(0, this.hazardPulse - HAZARD_PULSE_DECAY * dt);

    // ── Drive the air ─────────────────────────────────────────────────────
    if (spec) {
      // BLIND scale: the instance magnitude pushes every channel past the
      // baseline register toward white-out. Baseline (mag ≤ 0.55) is exactly
      // the ratified storm; magnitude 1 collapses the fog window into the
      // pawn, floods the frame with even dust, and saturates the border.
      // Absent/zero magnitude (older snapshot or in-flight mirror) = the
      // ratified BASELINE register (blind 0) — only an explicit server roll
      // (contract floor 0.45) or force may push toward white-out.
      const magnitude = normalizedMagnitude(event?.magnitude);
      const blind = MathUtils.clamp((magnitude - 0.55) / 0.45, 0, 1);
      this.sinks.strata.setStormDrive(
        applied,
        MathUtils.lerp(spec.strataOpacity, 1, blind),
        spec.strataWindMul * (1 + blind),
        spec.strataChurnMul * (1 + blind * 0.8),
      );
      const drive = this.sinks.post.storm;
      drive.severity01 = applied;
      drive.fogNearT = MathUtils.lerp(spec.fogNearT, 0.1, blind);
      drive.fogFarT = MathUtils.lerp(spec.fogFarT, 0.55, blind);
      drive.dustAmbient = MathUtils.lerp(spec.dustAmbient, 0.85, blind);
      drive.borderStrength = MathUtils.lerp(spec.borderStrength, 1, blind);
      drive.accentTint[0] = spec.accentTint[0];
      drive.accentTint[1] = spec.accentTint[1];
      drive.accentTint[2] = spec.accentTint[2];
      drive.moteScale = spec.moteScale * (1 + blind * 1.5);
      drive.airTint[0] = spec.airTint[0];
      drive.airTint[1] = spec.airTint[1];
      drive.airTint[2] = spec.airTint[2];
      drive.boneShift[0] = spec.boneShift[0];
      drive.boneShift[1] = spec.boneShift[1];
      drive.boneShift[2] = spec.boneShift[2];
      drive.darken = MathUtils.lerp(spec.darken, 0.72, blind);
      drive.desatAdd = spec.desatAdd + blind * 0.05;
      drive.hazardPulse01 = this.hazardPulse;
      const sweepDirRad = Math.atan2(sweepDirZ, sweepDirX);
      this.sinks.wind.setStormDrive(applied, spec.windStrength, spec.gustFloor, sweepDirRad);
    } else {
      this.sinks.strata.setStormDrive(0, 0, 1, 1);
      this.sinks.post.storm.severity01 = 0;
      this.sinks.post.storm.hazardPulse01 = this.hazardPulse;
      this.sinks.wind.setStormDrive(0, 0, 0, null);
    }

    // ── The front wall ────────────────────────────────────────────────────
    this.updateFrontMesh(event, spec, frontVisible, frontTravel, sweepDirX, sweepDirZ, wallAlpha, dt);
  }

  dispose(): void {
    if (this.mesh) this.scene.remove(this.mesh);
    this.geometry?.dispose();
    this.material?.dispose();
    this.mesh = null;
    this.material = null;
    this.geometry = null;
    if (import.meta.env.DEV && window.__successor3dStorm === this.dials) delete window.__successor3dStorm;
  }

  private resolveEvent(state: PlayState, focusX: number, focusZ: number): WeatherEventView | null {
    const force = this.dials.force;
    if (force) {
      // Anchor the forced storm on the focus; re-capture when the focus
      // jumps teleport-far (spawn settle / area travel), else hold stable
      // so the front sweep geometry stays coherent while iterating.
      let anchorX = this.forceCenterX;
      let anchorZ = this.forceCenterZ;
      if (anchorX === null || anchorZ === null || Math.hypot(focusX - anchorX, focusZ - anchorZ) > 40) {
        anchorX = focusX;
        anchorZ = focusZ;
        this.forceCenterX = anchorX;
        this.forceCenterZ = anchorZ;
      }
      return {
        areaId: state.activeAreaId,
        eventType: force.eventType,
        phase: force.phase,
        centerX: anchorX,
        centerY: anchorZ,
        radiusCells: 48,
        intensity: force.phase === "warning" ? force.progress : force.phase === "decay" ? 1 - force.progress : force.phase === "active" ? 1 : 0,
        magnitude: force.magnitude,
      };
    }
    this.forceCenterX = null;
    this.forceCenterZ = null;
    for (const event of weatherEventsFromState(state)) {
      if (event.areaId === state.activeAreaId && event.phase !== "idle") return event;
    }
    return null;
  }

  private updateFrontMesh(
    event: WeatherEventView | null,
    spec: StormSpec | null,
    visible: boolean,
    frontTravel: number,
    sweepDirX: number,
    sweepDirZ: number,
    wallAlpha: number,
    dt: number,
  ): void {
    const mesh = this.mesh;
    const material = this.material;
    if (!mesh || !material) return;
    if (!event || !spec || !visible || wallAlpha <= 0.002) {
      mesh.visible = false;
      return;
    }
    mesh.visible = true;
    this.boilTime += dt * spec.boilRate;
    const fog = this.scene.fog as Fog | null;
    if (fog) this.baseColor.copy(fog.color);
    else this.baseColor.set("#c9ad82");
    // Fog-relative wall colours: the wall is the horizon air, condensed —
    // base deeper than the fog, crest sun-caught above it (see StormSpec).
    this.uniforms.baseColor.value.set(
      this.baseColor.r * spec.baseFogMul[0],
      this.baseColor.g * spec.baseFogMul[1],
      this.baseColor.b * spec.baseFogMul[2],
    );
    this.uniforms.crestColor.value.set(
      this.baseColor.r * spec.crestFogMul[0],
      this.baseColor.g * spec.crestFogMul[1],
      this.baseColor.b * spec.crestFogMul[2],
    );
    this.uniforms.boilTime.value = this.boilTime;
    this.uniforms.wallAlpha.value = wallAlpha;
    this.uniforms.raggedness.value = spec.raggedness;
    if (fog && "near" in fog) {
      this.uniforms.fogNear.value = fog.near;
      this.uniforms.fogFar.value = fog.far;
    }

    // Front line: midpoint at center + sweepDir·travel, extending laterally
    // (perpendicular to the sweep). Sheet POSITIONS are world-true; each
    // sheet FACE is a yaw-only billboard square to the locked north-up camera
    // bearing (0°) so the full crest-lit face reads — sweep-facing sheets
    // showed mostly their dark base at a glancing angle and the wall
    // scanned as a ground shadow (taste pass 2026-07-05).
    const midX = event.centerX + sweepDirX * frontTravel;
    const midZ = event.centerY + sweepDirZ * frontTravel;
    const latX = -sweepDirZ;
    const latZ = sweepDirX;
    scratchQuat.setFromAxisAngle(Y_AXIS, CAMERA_FACING_YAW_RAD);
    for (let i = 0; i < this.slots.length; i += 1) {
      const slot = this.slots[i]!;
      const height = spec.frontHeight * slot.heightJitter;
      // Trailing row sits behind the leading edge (depth thickness); per-
      // sheet travel jitter shreds the leading line so it never reads as a
      // ruler.
      const advance = slot.travelJitter - (slot.row === 1 ? 4.6 : 0);
      scratchPos.set(
        midX + latX * slot.lateral + sweepDirX * advance,
        height * 0.5,
        midZ + latZ * slot.lateral + sweepDirZ * advance,
      );
      scratchScale.set(spec.frontSheetWidth * slot.widthJitter, height, 1);
      scratchMatrix.compose(scratchPos, scratchQuat, scratchScale);
      mesh.setMatrixAt(i, scratchMatrix);
    }
    mesh.instanceMatrix.needsUpdate = true;
  }

  private buildMesh(): void {
    let maxSegments = 0;
    for (const spec of Object.values(STORM_SPECS)) {
      maxSegments = Math.max(maxSegments, spec.frontSegments);
    }
    this.geometry = new PlaneGeometry(1, 1, 1, 1);
    const seedAttr = new Float32Array(maxSegments);
    this.geometry.setAttribute("instanceSeed", new InstancedBufferAttribute(seedAttr, 1));

    // Deterministic lateral layout (xorshift, mirrors weather/index.ts).
    let rng = 0x5a4d_57a1;
    const next = (): number => {
      rng ^= rng << 13;
      rng ^= rng >>> 17;
      rng ^= rng << 5;
      rng >>>= 0;
      return rng / 0xffff_ffff;
    };
    const slots: FrontSlot[] = [];
    for (let i = 0; i < maxSegments; i += 1) {
      // Two staggered rows: even = leading edge, odd = trailing mass. Rows
      // interleave laterally with ~35% overlap so the line is a continuous
      // cloud body with real thickness.
      const row: 0 | 1 = (i % 2) as 0 | 1;
      const pairIndex = Math.floor(i / 2);
      const spread = (pairIndex - (maxSegments / 2 - 1) / 2) * 6.4 + (row === 1 ? 3.2 : 0);
      slots.push({
        lateral: spread + (next() * 2 - 1) * 1.8,
        travelJitter: (next() * 2 - 1) * 2.6,
        row,
        seed: next() * 8,
        widthJitter: 0.85 + next() * 0.5,
        heightJitter: 0.8 + next() * 0.45,
      });
      seedAttr[i] = slots[i]!.seed;
    }
    this.slots = slots;

    this.material = new ShaderMaterial({
      uniforms: this.uniforms,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      side: DoubleSide,
      vertexShader: `
        attribute float instanceSeed;
        varying vec2 vLocal;
        varying vec2 vWorldXZ;
        varying float vSeed;
        varying float vViewDepth;
        void main() {
          vLocal = uv;
          vec4 world = instanceMatrix * vec4(position, 1.0);
          vec4 worldPos = modelMatrix * world;
          vWorldXZ = worldPos.xz;
          vSeed = instanceSeed;
          vec4 viewPos = viewMatrix * worldPos;
          vViewDepth = -viewPos.z;
          gl_Position = projectionMatrix * viewPos;
        }
      `,
      fragmentShader: `
        uniform vec3 baseColor;
        uniform vec3 crestColor;
        uniform float boilTime;
        uniform float wallAlpha;
        uniform float raggedness;
        uniform float fogNear;
        uniform float fogFar;
        uniform vec4 shelterBoxes[2];
        uniform int shelterCount;
        uniform float shelterCutStrength;
        varying vec2 vLocal;
        varying vec2 vWorldXZ;
        varying float vSeed;
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
        // Boil: two lattice time-slices lerped — the face blooms and churns
        // in place (a rolling wall), never a texture slide.
        float boilNoise(vec2 p, float slice) {
          float s0 = floor(slice);
          float f = slice - s0;
          f = f * f * (3.0 - 2.0 * f);
          float n0 = vnoise(p + vec2(s0 * 61.7, s0 * 19.3));
          float n1 = vnoise(p + vec2((s0 + 1.0) * 61.7, (s0 + 1.0) * 19.3));
          return mix(n0, n1, f);
        }

        void main() {
          // BILLOW footprint: an elliptical puff centred low on the quad —
          // the wall is a ridge of overlapping cumulus billows; no rectangle
          // edge can ever show (strata-sheet doctrine).
          vec2 c = vLocal - vec2(0.5, 0.34);
          float rim = 1.0 - smoothstep(0.14, 0.5, length(c * vec2(1.0, 1.45)));
          if (rim <= 0.002) discard;

          // World-anchored face detail: sample in world-x/z + height so
          // neighbouring billows share one continuous cloud body.
          vec2 wp = vec2(vWorldXZ.x + vWorldXZ.y, vLocal.y * 3.0) * 0.22 + vSeed * 13.7;
          float slice = boilTime + vSeed * 2.3;
          float body = boilNoise(wp, slice) * 0.62 + boilNoise(wp * 2.6 + 7.7, slice * 1.6) * 0.38;

          // Raggedness shreds the billow rim where the boil thins.
          float density = rim * (0.4 + 0.6 * smoothstep(0.5 - raggedness * 0.32, 0.62, body));
          if (density <= 0.004) discard;

          // Colour: fog-relative — deep churned base lifting to a sun-caught
          // crest where the billow tops thin (the wall GLOWS against the
          // haze instead of reading as a shadow).
          float crestT = smoothstep(0.12, 0.78, vLocal.y + (body - 0.5) * 0.35);
          vec3 color = mix(baseColor, crestColor, crestT);

          // Shelter cutout: the storm parts around marked shelter interiors
          // (soft world-space edge) — dust never lands INSIDE the house.
          float shelterKeep = 1.0;
          for (int i = 0; i < 2; i += 1) {
            if (i >= shelterCount) break;
            vec4 box = shelterBoxes[i];
            vec2 inset = max(vec2(box.x, box.y) - vWorldXZ, vWorldXZ - vec2(box.z, box.w));
            float outside = max(inset.x, inset.y);
            shelterKeep = min(shelterKeep, smoothstep(0.0, 0.9, max(outside, 0.0)));
          }
          shelterKeep = mix(1.0, shelterKeep, shelterCutStrength);

          // Dissolve into the linear fog window like any world surface, with
          // a presence floor so the wall still reads at the frame top.
          float fogT = clamp((vViewDepth - fogNear) / max(1.0, fogFar - fogNear), 0.0, 1.0);
          float alpha = density * wallAlpha * (1.0 - fogT * 0.6) * shelterKeep;
          if (alpha <= 0.004) discard;
          gl_FragColor = vec4(color, alpha);
        }
      `,
    });

    this.mesh = new InstancedMesh(this.geometry, this.material, maxSegments);
    this.mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    // Under the strata sheets (40): the wall is a world mass, the strata are
    // the air in front of it.
    this.mesh.renderOrder = 39;
    this.mesh.visible = false;
    this.scene.add(this.mesh);
  }
}

/**
 * Deterministic per-area sweep heading (radians; stable across sessions):
 * the front always arrives from the same quarter on a given planet, so the
 * event has a geography ("storms come out of the north-west on Ashvat").
 * FNV-1a over the areaId — the server MUST use this exact formula when it
 * does not carry an explicit config override (see WeatherEventView.sweepDirRad).
 */
export function sweepAngleForArea(areaId: string): number {
  let hash = 2166136261;
  for (let i = 0; i < areaId.length; i += 1) {
    hash ^= areaId.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return ((hash >>> 0) % 3600) * (Math.PI / 1800);
}
/**
 * Contract: server magnitude rolls live in [0.45, 1]; 0/absent/invalid means
 * "unset" (older snapshot or in-flight mirror) and coerces to the BASELINE
 * register (0.55 = blind 0) so nothing ever renders or displays a phantom
 * SEV 0%/100%. Shared by the storm drive and the datapad readouts.
 */
export function normalizedMagnitude(raw: number | undefined): number {
  return typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? Math.min(1, raw) : 0.55;
}

/** Local player health if streamed (hazard feedback), else null. */
function playerHealthFromState(state: PlayState): number | null {
  const actorId = state.serverAuthority.playerActorId ?? state.playerActorId;
  const actor = actorId ? state.serverAuthority.actors[actorId] : null;
  if (!actor) return null;
  if (!("vitals" in actor)) return null;
  const vitals = actor.vitals;
  if (!vitals || typeof vitals !== "object" || !("health" in vitals)) return null;
  const health = vitals.health;
  return typeof health === "number" && Number.isFinite(health) ? health : null;
}
