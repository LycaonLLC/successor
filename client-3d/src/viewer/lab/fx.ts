// fx.ts — Asset Lab combat-FX bench. VIEWER PLUMBING ONLY.
//
// The lab drives the RUNTIME fx subsystems (ParticleLayers / MuzzleFx /
// TracerFx / HitFx / BeamsFx — the exact classes CombatFx composes) with
// explicit world vectors. There is no PlayState and no FxEventTap here: the
// stage rig hands us real muzzle/bore world positions and this module spawns
// the same pooled effects the game renders. Nothing in fx/** is re-implemented.
import { Vector3, type OrthographicCamera, type Scene } from "three";
import type { PlayState } from "@successor/client/src/slice-core/gameState";
import { SUCCESSOR_3D_CONFIG } from "../../config";
import { BEAM_FX_IDS, BEAM_MUZZLE_H, BEAM_TARGET_H, BeamsFx, type BeamFxId } from "../../render/fx/beams";
import { FX_CONFIG, type BoltStyle, type BoltStyleId } from "../../render/fx/config";
import { HIT_STYLE_IDS, HitFx, type HitStyleId } from "../../render/fx/hits";
import { MuzzleFx } from "../../render/fx/muzzle";
import { makeGlowSprite, ParticleLayers } from "../../render/fx/particles";
import { TracerFx } from "../../render/fx/tracers";

export const BOLT_STYLE_IDS = Object.keys(FX_CONFIG.boltStyles) as readonly BoltStyleId[];
export { BEAM_FX_IDS, type BeamFxId, type BoltStyleId, type HitStyleId };

/** Every effect the ATTACK picker can select: bolt styles + full-line beams. */
export type LabFireFxId = BoltStyleId | BeamFxId;

export function isBeamFxId(id: string): id is BeamFxId {
  return (BEAM_FX_IDS as readonly string[]).includes(id);
}

export function isLabFireFxId(id: string): id is LabFireFxId {
  return (BOLT_STYLE_IDS as readonly string[]).includes(id) || isBeamFxId(id);
}

/**
 * TracerFx.update takes the PlayState only to forward it into onArrive; the
 * lab's arrival handler never reads it, so a frozen empty object is safe.
 */
const NO_STATE = Object.freeze({}) as unknown as PlayState;

export interface LabFxDebug {
  activeTracers: number;
  activeBeams: number;
  activeHitFx: number;
  shotsFired: number;
  beamsFired: number;
}

declare global {
  interface Window {
    /** Asset Lab FX bench counters (verification harness / console). */
    __successorLabFx?: { debug: () => LabFxDebug };
  }
}

export interface FireBoltOptions {
  style: BoltStyleId;
  /** Override the bolt style's own hit archetype at arrival. */
  hitStyle?: HitStyleId;
  /** Presentation speed, cells/s. */
  speed?: number;
  /** Bolt-visual + flash severity (1 = normal shot). */
  mag?: number;
  /** Distance to the stamped arrival point, cells. Default 8-15 randomized. */
  hitDistance?: number;
  /** Skip the muzzle flash (fan follow-up rounds of a shotgun spread). */
  noFlash?: boolean;
}

export class LabFx {
  private readonly particles: ParticleLayers;
  private readonly muzzle: MuzzleFx;
  private readonly tracers: TracerFx;
  private readonly hits: HitFx;
  private readonly beams: BeamsFx;
  private shotKey = -9_000_000;
  private shotsFired = 0;
  private beamsFired = 0;
  private readonly _hitPoint = new Vector3();
  private readonly _normal = new Vector3();
  private readonly _from = new Vector3();
  private readonly _to = new Vector3();

  constructor(
    scene: Scene,
    private readonly camera: OrthographicCamera,
    private readonly canvas: HTMLCanvasElement,
  ) {
    const sprite = makeGlowSprite();
    this.particles = new ParticleLayers(scene, sprite);
    this.muzzle = new MuzzleFx(this.particles, (light) => scene.add(light));
    this.tracers = new TracerFx(scene, sprite);
    this.hits = new HitFx(scene, sprite);
    this.beams = new BeamsFx(scene, sprite);
    // Arrival = the tracer visually reaching its stamped hit point (same
    // timing authority the game uses): style archetype + a restrained spark
    // so the round visibly ENDS somewhere.
    this.tracers.onArrive = (rec) => {
      const style: BoltStyle = FX_CONFIG.boltStyles[rec.styleId as BoltStyleId] ?? FX_CONFIG.boltStyles.ballistic;
      this._normal.copy(rec.dir).multiplyScalar(-1);
      this.particles.emitSparkBurst(rec.hitPoint, this._normal, rec.dir, FX_CONFIG.hit.landedImpactSparkMag * rec.mag);
      const override = rec.outcomeTargetActorId;
      const hitStyle = (HIT_STYLE_IDS as readonly string[]).includes(override)
        ? (override as HitStyleId)
        : style.hit ?? null;
      if (hitStyle) this.hits.spawn(hitStyle, rec.hitPoint, rec.dir, style.coreColor, rec.mag);
    };
    window.__successorLabFx = { debug: () => this.debug() };
  }

  /**
   * Fire one bolt from `origin` along `dir` (world, need not be unit).
   * Terminates 8-15 cells out with the style's (or the override's) hit read.
   */
  fireBolt(origin: Vector3, dir: Vector3, opts: FireBoltOptions): void {
    const mag = opts.mag ?? 1;
    const hitDist = opts.hitDistance ?? 8 + Math.random() * 7;
    const key = this.shotKey--;
    this.shotsFired += 1;
    if (!opts.noFlash) this.muzzle.flash(origin, dir, mag, null);
    const spawned = this.tracers.spawn({
      origin,
      dir,
      speed: opts.speed ?? 22,
      range: hitDist + 4,
      key,
      mag,
      style: opts.style,
    });
    if (!spawned) return; // pool exhausted under a burst — drop silently
    this._hitPoint.copy(dir).normalize().multiplyScalar(hitDist).add(origin);
    // Kind/eventId are FxEventTap concerns; the lab smuggles the hit-style
    // override through targetActorId (a free-form string field it owns).
    this.tracers.setOutcome(key, 2, this._hitPoint, mag, 1, false, false, -1, opts.hitStyle ?? "");
  }

  /** Muzzle flash only (beam shots pair this with fireBeam). */
  flash(origin: Vector3, dir: Vector3, mag = 1): void {
    this.muzzle.flash(origin, dir, mag, null);
  }

  /**
   * Full-line beam from a REAL muzzle world point toward `dir`, `distance`
   * cells out. BeamsFx re-adds the standing-pawn bore heights internally, so
   * both endpoints are pre-compensated here.
   */
  fireBeam(beam: BeamFxId, origin: Vector3, dir: Vector3, distance = 10): void {
    this.beamsFired += 1;
    this._from.copy(origin);
    this._from.y -= BEAM_MUZZLE_H;
    this._to.copy(dir).normalize().multiplyScalar(distance).add(origin);
    this._to.y -= BEAM_TARGET_H;
    this.beams.spawn(beam, this._from, this._to);
  }

  /** Melee contact read: spark burst (+ optional archetype) at the blade. */
  spark(point: Vector3, incoming: Vector3, mag = 1, hitStyle: HitStyleId | null = null, color = 0xffe39a): void {
    this._normal.copy(incoming).multiplyScalar(-1);
    this.particles.emitSparkBurst(point, this._normal, incoming, mag);
    if (hitStyle) this.hits.spawn(hitStyle, point, incoming, color, mag);
  }

  update(dtSeconds: number): void {
    // Same ortho world->render-target-pixel scale CombatFx derives, so lab
    // sparks read at game size on the PS2 low-res target.
    const frustumH = this.camera.top - this.camera.bottom;
    const pixelScale = window.__successor3dPost?.pixelScale ?? SUCCESSOR_3D_CONFIG.renderer.post.pixelScale;
    const uScale = (this.canvas.clientHeight * pixelScale / Math.max(1, frustumH)) * FX_CONFIG.particles.pointSizeBoost;
    this.tracers.update(dtSeconds, NO_STATE);
    this.hits.update(dtSeconds);
    this.beams.update(dtSeconds);
    this.particles.update(dtSeconds, uScale);
    this.muzzle.update(dtSeconds);
  }

  debug(): LabFxDebug {
    return {
      activeTracers: this.tracers.activeCount,
      activeBeams: this.beams.activeCount,
      activeHitFx: this.hits.activeCount,
      shotsFired: this.shotsFired,
      beamsFired: this.beamsFired,
    };
  }

  dispose(): void {
    if (window.__successorLabFx) delete window.__successorLabFx;
    this.tracers.onArrive = null;
    this.particles.dispose();
    this.muzzle.dispose();
    this.tracers.dispose();
    this.hits.dispose();
    this.beams.dispose();
  }
}
