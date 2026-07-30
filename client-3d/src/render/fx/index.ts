import type { PlayState } from "@successor/client/src/slice-core/gameState";
import { SUCCESSOR_3D_CONFIG } from "../../config";
import type { OrthographicCamera, Scene } from "three";
import { Vector3 } from "three";
import { FX_CONFIG, type BoltStyleId, BLOOD_PALETTE_IDS, type BloodPaletteId } from "./config";
import { FxEventTap } from "./events";
import { MuzzleFx } from "./muzzle";
import { makeGlowSprite, ParticleLayers } from "./particles";
import { PsgFormfitFx, type PsgFormfitShellMeshProvider } from "./shieldFormfit";
import { PsgShieldFx } from "./shield";
import { SurveyPulseFx } from "./surveyPulse";
import { TracerFx } from "./tracers";
import { HIT_PREVIEW_COLORS, HIT_STYLE_IDS, HitFx, type HitStyleId } from "./hits";
import { BEAM_FX_IDS, BeamsFx, type BeamFxId } from "./beams";
import { CampfireFx } from "./campfire";
import { POWER_FX_IDS, PowersFx, type PowerFxId } from "./powers";
import { STATUS_FX_IDS, StatusFx, type StatusFxId } from "./status";
import { ClickMoveMarkerFx } from "./groundMarker";
import { setClickMoveTarget } from "@successor/client/src/slice-core/movementSystem";

/**
 * CombatFx — single entry point the renderer wires in. Owns combat VFX
 * subsystems (particles, muzzle, tracers) and the read-only combat-event
 * tap, all under client-3d/src/render/fx/**. Blood is the particle layer's job.
 *
 * Lifecycle (called by SuccessorThreeRenderer, owned by PawnIntegrator):
 *   const combatFx = new CombatFx(scene, cameraController.camera, canvas);
 *   combatFx.setMuzzleProvider((id) => this.getMuzzleWorldPosition(id));
 *   combatFx.setShellMeshProvider((id) => this.getShellMeshes(id));
 *   // each frame, before post.render:
 *   combatFx.update(state, dtSeconds);
 *   combatFx.dispose();   // in renderer.dispose()
 *
 * `update` computes the orthographic world->render-target-pixel scale itself
 * (displayHeight * pixelScale / orthoFrustumHeight * pointSizeBoost) so the
 * renderer call needs no extra arguments. The returned muzzle Vector3 is a
 * reused scratch — it is .copy()'d immediately inside the tap.
 */

export interface CombatFxDebug {
  activeTracers: number;
  activeHitFx: number;
  activeShieldDomes: number;
  particleAdditiveMax: number;
  particleNormalMax: number;
  /** Last tracer arrival (impact-honesty verification): where the bolt died vs the target centre. */
  lastArrival: {
    count: number;
    kind: number;
    targetActorId: string;
    x: number;
    y: number;
    z: number;
    targetCenterX: number;
    targetCenterZ: number;
    /** Horizontal |arrival - target centre| in cells. */
    surfaceDistance: number;
  };
  /** Click-to-move ground marker lifecycle (movement UX verification). */
  moveMarker: { phase: string; x: number; z: number };
  /** Last authoritative combat event projected into the 3D tracer pool. */
}

declare global {
  interface Window {
    /** Live FX debug/demo hooks (console + verification harness). */
    __successorFx?: {
      psgTest: (mode?: string, flat?: boolean) => boolean;
      boltTest: (style?: string) => boolean;
      hitTest: (style?: string) => boolean;
      bloodTest: (palette?: string) => boolean;
      statusTest: (status?: string) => boolean;
      powerTest: (power?: string) => boolean;
      beamTest: (beam?: string) => boolean;
      campfireTest: () => boolean;
      deflectTest: () => boolean;
      moveMarkerTest: (x?: number, y?: number) => boolean;
      debug: () => CombatFxDebug;
    };
  }
}

/** Authoritative status ids → status FX. Extend as sim statuses land. */
const STATUS_FX_TABLE: readonly { match: (id: string) => boolean; fx: StatusFxId }[] = [
  { match: (id) => id.startsWith("stimpak_"), fx: "stim" },
  { match: (id) => id.startsWith("spice_") && id.endsWith("_rush"), fx: "spicerush" },
  { match: (id) => id.startsWith("spice_") && id.endsWith("_haze"), fx: "spicehaze" },
  { match: (id) => id.startsWith("spice_") && (id.endsWith("_crash") || id.endsWith("_downer")), fx: "spicecrash" },
  { match: (id) => id === "poisoned" || id.startsWith("poison_"), fx: "poison" },
  { match: (id) => id === "diseased" || id.startsWith("disease_"), fx: "disease" },
  { match: (id) => id === "burning" || id.startsWith("burn_"), fx: "burning" },
  { match: (id) => id === "blinded" || id.startsWith("blind_"), fx: "blind" },
  { match: (id) => id === "intimidated" || id.startsWith("intimidate_"), fx: "intimidate" },
  { match: (id) => id.startsWith("heal_over_time") || id.startsWith("regen_"), fx: "hot" },
];

function hitTestStyle(style: string | undefined): HitStyleId | null {
  return style && (HIT_STYLE_IDS as readonly string[]).includes(style) ? (style as HitStyleId) : null;
}

export class CombatFx {
  private readonly particles: ParticleLayers;
  private readonly muzzle: MuzzleFx;
  private readonly tracers: TracerFx;
  private readonly hits: HitFx;
  private readonly surveyPulses: SurveyPulseFx;
  private readonly shield: PsgShieldFx;
  private readonly shieldFormfit: PsgFormfitFx;
  private readonly status: StatusFx;
  private readonly powers: PowersFx;
  private readonly beams: BeamsFx;
  private readonly campfires: CampfireFx;
  private readonly moveMarker: ClickMoveMarkerFx;
  private campfireTestCount = 0;
  private readonly stimSeen = new Map<string, number>();
  private readonly tap: FxEventTap;
  private readonly camera: OrthographicCamera;
  private readonly canvas: HTMLCanvasElement;
  private lastState: PlayState | null = null;
  private readonly _psgDir = new Vector3();
  /** Pending psgTest demo timeouts — cleared on every call so a later (esp. flat) test is never contaminated. */
  private readonly _psgTimeouts: number[] = [];
  private readonly _hitTestPoint = new Vector3();
  private readonly _hitTestIncoming = new Vector3();
  private readonly _powerFrom = new Vector3();
  private readonly _powerTo = new Vector3();

  constructor(scene: Scene, camera: OrthographicCamera, canvas: HTMLCanvasElement) {
    this.camera = camera;
    this.canvas = canvas;

    const sprite = makeGlowSprite();
    this.particles = new ParticleLayers(scene, sprite);
    this.muzzle = new MuzzleFx(this.particles, (light) => scene.add(light));
    this.tracers = new TracerFx(scene, sprite);
    this.hits = new HitFx(scene, sprite);
    this.surveyPulses = new SurveyPulseFx(scene);
    this.shield = new PsgShieldFx(scene);
    this.shieldFormfit = new PsgFormfitFx(scene);
    this.status = new StatusFx(scene, sprite);
    this.powers = new PowersFx(scene, sprite, this.status);
    this.beams = new BeamsFx(scene, sprite);
    this.campfires = new CampfireFx(scene, sprite);
    this.moveMarker = new ClickMoveMarkerFx(scene);
    const shieldSink = {
      block: (id: string, dir: Vector3 | null, t: number): void => {
        (FX_CONFIG.psgShield.mode === "formfit" ? this.shieldFormfit : this.shield).block(id, dir, t);
      },
    };
    this.tap = new FxEventTap({
      particles: this.particles,
      muzzle: this.muzzle,
      tracers: this.tracers,
      hits: this.hits,
      status: this.status,
      shield: shieldSink,
    });
    // Demo/verification hook: pop the selected PSG shell on the player pawn with a ripple
    // from screen-left. Returns false when no player actor is resolvable.
    // `flat` pins charge at 1 with no follow-up blocks — colour verification
    // (the default triple-ripple decays charge by design, which reads amber).
    // The demo captures its target shield at schedule time (NOT the live
    // mode-dispatching sink) and cancels any pending demo timeouts, so a
    // mode switch or flat call mid-sequence can't be cross-contaminated.
    window.__successorFx = {
      debug: () => this.debug(),
      psgTest: (mode?: string, flat?: boolean) => {
        if (mode === "bubble" || mode === "formfit") FX_CONFIG.psgShield.mode = mode;
        for (const id of this._psgTimeouts) window.clearTimeout(id);
        this._psgTimeouts.length = 0;
        const state = this.lastState;
        if (!state) return false;
        const actorId = state.serverAuthority.playerActorId ?? state.playerActorId;
        if (!actorId || !state.serverAuthority.actors[actorId]) return false;
        const target = FX_CONFIG.psgShield.mode === "formfit" ? this.shieldFormfit : this.shield;
        this._psgDir.set(-0.8, -0.12, -0.55).normalize();
        target.block(actorId, this._psgDir, 1);
        if (!flat) {
          this._psgTimeouts.push(window.setTimeout(() => target.block(actorId, this._psgDir.set(0.6, -0.1, -0.7).normalize(), 0.55), 170));
          this._psgTimeouts.push(window.setTimeout(() => target.block(actorId, this._psgDir.set(0.1, -0.2, 0.9).normalize(), 0.2), 340));
        }
        return true;
      },
      // Fan six test rounds of a style from the player's muzzle (slugthrower works;
      // chest-height fallback when unarmed). No combat needed.
      boltTest: (style?: string) => {
        const state = this.lastState;
        if (!state) return false;
        const actorId = state.serverAuthority.playerActorId ?? state.playerActorId;
        const actor = actorId ? state.serverAuthority.actors[actorId] : null;
        if (!actor) return false;
        const styles = Object.keys(FX_CONFIG.boltStyles);
        const chosen = (style && styles.includes(style) ? style : null) as BoltStyleId | null;
        const origin = this.tap.muzzleWorldFor(actorId) ?? this._psgDir.set(actor.x + 0.5, FX_CONFIG.chestHeight, actor.y + 0.5);
        const baseKey = -2_000_000 - Math.floor(Math.random() * 100_000);
        for (let i = 0; i < 6; i++) {
          const ang = (-0.55 + (i / 5) * 1.1);
          const dir = new Vector3(Math.cos(ang), 0, Math.sin(ang));
          this.tracers.spawn({
            origin,
            dir,
            speed: 22,
            range: 15,
            key: baseKey - i,
            mag: 1,
            style: chosen ?? (styles[i % styles.length] as BoltStyleId),
          });
        }
        return true;
      },
      // Ring the player with one of each hit archetype (all compass points),
      // or 4x the named one. Roster + tints come straight from hits.ts
      // (HIT_STYLE_IDS / HIT_PREVIEW_COLORS) — new archetypes join the ring
      // automatically.
      hitTest: (style?: string) => {
        const state = this.lastState;
        if (!state) return false;
        const actorId = state.serverAuthority.playerActorId ?? state.playerActorId;
        const actor = actorId ? state.serverAuthority.actors[actorId] : null;
        if (!actor) return false;
        const named = hitTestStyle(style);
        const cx = actor.x + 0.5;
        const cy = FX_CONFIG.chestHeight * 0.6;
        const cz = actor.y + 0.5;
        const count = named ? 4 : HIT_STYLE_IDS.length;
        for (let i = 0; i < count; i += 1) {
          const hitStyle = named ?? HIT_STYLE_IDS[i]!;
          const angle = (i / count) * Math.PI * 2;
          this._hitTestPoint.set(cx + Math.cos(angle) * 1.6, cy, cz + Math.sin(angle) * 1.6);
          this._hitTestIncoming.set(cx - this._hitTestPoint.x, 0, cz - this._hitTestPoint.z);
          const len = this._hitTestIncoming.length();
          if (len > 1e-5) this._hitTestIncoming.multiplyScalar(1 / len);
          else this._hitTestIncoming.set(1, 0, 0);
          this.hits.spawn(hitStyle, this._hitTestPoint, this._hitTestIncoming, HIT_PREVIEW_COLORS[hitStyle], 1);
        }
        return true;
      },
      // Blood identity demo: named palette = one burst on the pawn; no arg =
      // all three ringed (red/green/blue) so the species reads compare.
      bloodTest: (palette?: string) => {
        const state = this.lastState;
        if (!state) return false;
        const actorId = state.serverAuthority.playerActorId ?? state.playerActorId;
        const actor = actorId ? state.serverAuthority.actors[actorId] : null;
        if (!actor) return false;
        const named = palette && (BLOOD_PALETTE_IDS as readonly string[]).includes(palette)
          ? (palette as BloodPaletteId)
          : null;
        const cx = actor.x + 0.5;
        const cy = FX_CONFIG.chestHeight * 0.62;
        const cz = actor.y + 0.5;
        if (named) {
          this._hitTestPoint.set(cx, cy, cz);
          this._hitTestIncoming.set(0.9, 0, 0.45).normalize();
          this.particles.emitBloodBurst(this._hitTestPoint, this._hitTestIncoming, 1.3, FX_CONFIG.blood.palettes[named]);
          return true;
        }
        for (let i = 0; i < BLOOD_PALETTE_IDS.length; i += 1) {
          const angle = (i / BLOOD_PALETTE_IDS.length) * Math.PI * 2;
          this._hitTestPoint.set(cx + Math.cos(angle) * 1.3, cy, cz + Math.sin(angle) * 1.3);
          this._hitTestIncoming.set(Math.cos(angle + 0.7), 0, Math.sin(angle + 0.7));
          this.particles.emitBloodBurst(this._hitTestPoint, this._hitTestIncoming, 1.3, FX_CONFIG.blood.palettes[BLOOD_PALETTE_IDS[i]!]);
        }
        return true;
      },
      // Status-transient demo: named status pops on the pawn; no arg = the
      // whole state language ringed around it (roster from STATUS_FX_IDS).
      statusTest: (status?: string) => {
        const state = this.lastState;
        if (!state) return false;
        const actorId = state.serverAuthority.playerActorId ?? state.playerActorId;
        const actor = actorId ? state.serverAuthority.actors[actorId] : null;
        if (!actor) return false;
        const named = status && (STATUS_FX_IDS as readonly string[]).includes(status)
          ? (status as StatusFxId)
          : null;
        if (named) {
          this._hitTestPoint.set(actor.x + 0.5, 0, actor.y + 0.5);
          this.status.spawn(named, this._hitTestPoint);
          return true;
        }
        for (let i = 0; i < STATUS_FX_IDS.length; i += 1) {
          const angle = (i / STATUS_FX_IDS.length) * Math.PI * 2;
          this._hitTestPoint.set(actor.x + 0.5 + Math.cos(angle) * 1.9, 0, actor.y + 0.5 + Math.sin(angle) * 1.9);
          this.status.spawn(STATUS_FX_IDS[i]!, this._hitTestPoint);
        }
        return true;
      },
      // Power demo: fires from the pawn toward a point 5 cells screen-right
      // (or all four powers fanned when unnamed).
      powerTest: (power?: string) => {
        const state = this.lastState;
        if (!state) return false;
        const actorId = state.serverAuthority.playerActorId ?? state.playerActorId;
        const actor = actorId ? state.serverAuthority.actors[actorId] : null;
        if (!actor) return false;
        const named = power && (POWER_FX_IDS as readonly string[]).includes(power)
          ? (power as PowerFxId)
          : null;
        this._powerFrom.set(actor.x + 0.5, 0, actor.y + 0.5);
        if (named) {
          this._powerTo.set(actor.x + 0.5 + 5, 0, actor.y + 0.5 + 2);
          this.powers.spawn(named, this._powerFrom, this._powerTo);
          return true;
        }
        for (let i = 0; i < POWER_FX_IDS.length; i += 1) {
          const angle = (i / POWER_FX_IDS.length) * Math.PI * 2 + 0.4;
          this._powerTo.set(actor.x + 0.5 + Math.cos(angle) * 5.5, 0, actor.y + 0.5 + Math.sin(angle) * 5.5);
          this.powers.spawn(POWER_FX_IDS[i]!, this._powerFrom, this._powerTo);
        }
        return true;
      },
      // Beam demo: full-line weapon effects fired from the pawn.
      beamTest: (beam?: string) => {
        const state = this.lastState;
        if (!state) return false;
        const actorId = state.serverAuthority.playerActorId ?? state.playerActorId;
        const actor = actorId ? state.serverAuthority.actors[actorId] : null;
        if (!actor) return false;
        const named = beam && (BEAM_FX_IDS as readonly string[]).includes(beam)
          ? (beam as BeamFxId)
          : null;
        this._powerFrom.set(actor.x + 0.5, 0, actor.y + 0.5);
        if (named) {
          this._powerTo.set(actor.x + 0.5 + 6, 0, actor.y + 0.5 + 2.5);
          this.beams.spawn(named, this._powerFrom, this._powerTo);
          return true;
        }
        for (let i = 0; i < BEAM_FX_IDS.length; i += 1) {
          const angle = (i / BEAM_FX_IDS.length) * Math.PI * 2 + 1.1;
          this._powerTo.set(actor.x + 0.5 + Math.cos(angle) * 6, 0, actor.y + 0.5 + Math.sin(angle) * 6);
          this.beams.spawn(BEAM_FX_IDS[i]!, this._powerFrom, this._powerTo);
        }
        return true;
      },
      // Saber deflect: full read on your pawn — incoming bolt from the NE dies
      // on the blade, sparks, reflected bolt pings off, parry anim plays.
      deflectTest: () => {
        const state = this.lastState;
        if (!state) return false;
        const actorId = state.serverAuthority.playerActorId ?? state.playerActorId;
        const actor = actorId ? state.serverAuthority.actors[actorId] : null;
        if (!actor || !actorId) return false;
        this._powerFrom.set(actor.x + 0.5 + 4.2, FX_CONFIG.chestHeight, actor.y + 0.5 - 3.1);
        this.tap.deflectDemo(this._powerFrom, actorId, state);
        return true;
      },
      // Campfire toggle: plants/removes an always-on fire beside the pawn.
      campfireTest: () => {
        const state = this.lastState;
        if (!state) return false;
        const actorId = state.serverAuthority.playerActorId ?? state.playerActorId;
        const actor = actorId ? state.serverAuthority.actors[actorId] : null;
        if (!actor) return false;
        const id = "fx-lab-campfire";
        if (this.campfires.has(id)) {
          this.campfires.remove(id);
          return true;
        }
        this.campfireTestCount += 1;
        this._powerFrom.set(actor.x + 0.5 + 1.4, 0, actor.y + 0.5 + 0.6);
        this.campfires.add(id, this._powerFrom);
        return true;
      },
      // Click-to-move marker demo: stamps the marker (and a real nav intent)
      // at the given authority cell, default 3 cells east of the pawn.
      moveMarkerTest: (x?: number, y?: number) => {
        const state = this.lastState;
        if (!state) return false;
        const actorId = state.serverAuthority.playerActorId ?? state.playerActorId;
        const actor = actorId ? state.serverAuthority.actors[actorId] : null;
        if (!actor) return false;
        setClickMoveTarget(state, x ?? actor.x + 3, y ?? actor.y, actor.areaId);
        return true;
      },
    };
  }

  /**
   * Table-driven status→FX dispatch (owner ruling 2026-07-08: every effect
   * wired into the real runtime wherever a hook exists). Counts matching
   * statuses per actor per FX; first observation seeds silently (no replayed
   * aura on boot/area-join); TTL drift never re-triggers; count INCREASE
   * spawns. Bleed intentionally absent — it rides spawnImpact off combat
   * events (single source). New sim statuses light up by adding a row here.
   */
  private watchStatusFx(state: PlayState): void {
    const actors = state.serverAuthority.actors as Record<string, { x: number; y: number; statuses?: { id: string }[] } | undefined>;
    for (const actorId in actors) {
      const actor = actors[actorId];
      if (!actor?.statuses) continue;
      for (let m = 0; m < STATUS_FX_TABLE.length; m += 1) {
        const row = STATUS_FX_TABLE[m]!;
        let count = 0;
        for (let i = 0; i < actor.statuses.length; i += 1) {
          if (row.match(actor.statuses[i]!.id)) count += 1;
        }
        const key = actorId + "\u0000" + row.fx;
        const prev = this.stimSeen.get(key);
        if (prev === undefined) {
          this.stimSeen.set(key, count);
          continue;
        }
        if (count > prev) {
          this._powerFrom.set(actor.x + 0.5, 0, actor.y + 0.5);
          this.status.spawn(row.fx, this._powerFrom);
        }
        if (count !== prev) this.stimSeen.set(key, count);
      }
    }
    for (const key of this.stimSeen.keys()) {
      const actorId = key.slice(0, key.indexOf("\u0000"));
      if (!actors[actorId]) this.stimSeen.delete(key);
    }
  }

  /** Wire the PawnIntegrator muzzle socket (null when unarmed/not visible). */
  /** Wire the saber-deflect anim sink (pawns.playDeflect). */
  setDeflectSink(sink: ((actorId: string, incomingX: number, incomingZ: number) => void) | null): void {
    this.tap.deflectSink = sink ? { play: sink } : null;
  }

  /** Nearest always-on campfire distance to a world point (crackle-loop driver). */
  nearestCampfireDistance(x: number, z: number): number | null {
    return this.campfires.nearestDistance(x, z);
  }

  /**
   * World-driven always-on campfire (placed scout camps): keyed add/move +
   * remove, forwarded to the same CampfireFx the fx-lab toggle exercises —
   * the crackle audio loop keys off nearestCampfireDistance either way.
   */
  setWorldCampfire(id: string, x: number, y: number, z: number): void {
    this._powerFrom.set(x, y, z);
    this.campfires.add(id, this._powerFrom);
  }

  removeWorldCampfire(id: string): void {
    this.campfires.remove(id);
  }

  setMuzzleProvider(fn: ((actorId: string) => Vector3 | null) | null): void {
    this.tap.setMuzzleProvider(fn);
  }

  /** Wire live pawn skinned meshes for the form-fit shield shell. */
  setShellMeshProvider(fn: PsgFormfitShellMeshProvider | null): void {
    this.shieldFormfit.setProvider(fn);
  }

  update(state: PlayState, dtSeconds: number): void {
    // orthographic world->render-target-pixel scale. Ortho has no perspective
    // foreshortening, so point size is a plain multiply (no depth divide). The
    // scene draws to the ~1/3-res PS2 target, so size is in target pixels.
    const frustumH = this.camera.top - this.camera.bottom;
    const pixelScale = SUCCESSOR_3D_CONFIG.renderer.post.pixelScale;
    const targetH = this.canvas.clientHeight * pixelScale;
    const uScale = (targetH / Math.max(1, frustumH)) * FX_CONFIG.particles.pointSizeBoost;

    // ORDER MATTERS: the tap detects fires (muzzle pushes) and stamps deferred
    // outcomes; tracers.update fires onArrive -> impact side effects;
    // particles/muzzle then advance just-pushed records on the same frame.
    this.lastState = state;
    this.tap.update(state);
    this.tracers.update(dtSeconds, state);
    this.hits.update(dtSeconds);
    this.surveyPulses.update(dtSeconds);
    this.shield.update(dtSeconds, state);
    this.shieldFormfit.update(dtSeconds, state);
    this.status.update(dtSeconds);
    this.powers.update(dtSeconds);
    this.beams.update(dtSeconds);
    this.campfires.update(dtSeconds);
    this.moveMarker.update(state, dtSeconds);
    // Stimpak aura: authoritative status-insertion watch (advisor ruling:
    // never key off the UseConsumable enqueue — rejected uses must not flash).
    // Keyed per actor by a monotonic count of stim-family statuses; TTL drift
    // never re-triggers, insertion does. Swept when actors vanish.
    this.watchStatusFx(state);
    this.particles.update(dtSeconds, uScale);
    this.muzzle.update(dtSeconds);
  }

  /** Snapshot V8 heap (Chrome only) for the zero-alloc growth check. */
  sampleHeap(): { usedJSHeapSize: number; totalJSHeapSize: number; jsHeapSizeLimit: number } | null {
    const mem = (performance as Performance & {
      memory?: { usedJSHeapSize: number; totalJSHeapSize: number; jsHeapSizeLimit: number };
    }).memory;
    if (!mem) return null;
    return {
      usedJSHeapSize: mem.usedJSHeapSize,
      totalJSHeapSize: mem.totalJSHeapSize,
      jsHeapSizeLimit: mem.jsHeapSizeLimit,
    };
  }

  debug(): CombatFxDebug {
    const tap = this.tap;
    return {
      activeTracers: this.tracers.activeCount,
      activeHitFx: this.hits.activeCount,
      activeShieldDomes: this.shield.activeCount + this.shieldFormfit.activeCount,
      particleAdditiveMax: FX_CONFIG.particles.additiveMax,
      particleNormalMax: FX_CONFIG.particles.normalMax,
      lastArrival: {
        count: tap.arrivalCount,
        kind: tap.lastArrivalKind,
        targetActorId: tap.lastArrivalTargetActorId,
        x: tap.lastArrivalPoint.x,
        y: tap.lastArrivalPoint.y,
        z: tap.lastArrivalPoint.z,
        targetCenterX: tap.lastArrivalTargetCenter.x,
        targetCenterZ: tap.lastArrivalTargetCenter.z,
        surfaceDistance: Math.hypot(
          tap.lastArrivalPoint.x - tap.lastArrivalTargetCenter.x,
          tap.lastArrivalPoint.z - tap.lastArrivalTargetCenter.z,
        ),
      },
      moveMarker: {
        phase: this.moveMarker.debugPhase,
        x: this.moveMarker.debugX,
        z: this.moveMarker.debugZ,
      },
    };
  }

  dispose(): void {
    for (const id of this._psgTimeouts) window.clearTimeout(id);
    this._psgTimeouts.length = 0;
    if (window.__successorFx) delete window.__successorFx;
    this.particles.dispose();
    this.muzzle.dispose();
    this.tracers.dispose();
    this.hits.dispose();
    this.surveyPulses.dispose();
    this.shield.dispose();
    this.shieldFormfit.dispose();
    this.status.dispose();
    this.powers.dispose();
    this.beams.dispose();
    this.campfires.dispose();
    this.moveMarker.dispose();
  }
}
