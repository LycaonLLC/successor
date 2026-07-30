import type { PlayState } from "@successor/client/src/slice-core/gameState";
import { isMeleeWeaponPresentation } from "@successor/client/src/slice-core/weaponSystem";
import {
  ROLL_BURST_ORDINAL_RESET_MS,
  rollBurstDelayMsForOrdinal,
  rollBurstOrdinalKey,
} from "@successor/client/src/slice-core/rollBurstCadence";
import { Vector3 } from "three";
import { FX_CONFIG, boltStyleForWeapon, type BoltStyle } from "./config";
import type { StatusFx } from "./status";
import type { MuzzleFx } from "./muzzle";
import type { ParticleLayers } from "./particles";
import type { TracerFx, TracerOutcomeKind, TracerRecord } from "./tracers";
import type { HitFx, HitStyleId } from "./hits";

/**
 * Read-only combat-event tap. Drives all combat VFX from authoritative state
 * WITHOUT ever mutating shared state.
 *
 * Single read-only source: `state.serverAuthority.eventLog` — every
 * GameCombatEvent is pushed there exactly once. We track the highest id we've
 * processed and read new entries; we never splice or push the log. 3D blood
 * particles are emitted here.
 *
 * Roll-combat events (`ranged_roll`) spawn a cosmetic bolt from muzzle to
 * endpoint, then defer the impact until that bolt arrives. Other lifecycle
 * events dispatch their presentation immediately.
 *
 * Dodge/shield causes produce sparks, sleep produces no burst, and damaging
 * organic hits produce blood.
 *
 * Zero per-frame allocations: fixed-field outcomes on tracer records (no
 * object literals) and class-scope scratch Vector3s for all math.
 */

const OUTCOME_BLOOD = 1;
const OUTCOME_SPARK = 2;
/** Saber deflect: bolt dies on the BLADE, sparks, and a reflected bolt pings off. */
const OUTCOME_DEFLECT = 3;
/** Intercept sits this far from the defender centre toward the shooter (cells). */
const DEFLECT_INTERCEPT_TOWARD_SHOOTER = 0.45;
const DEFLECT_INTERCEPT_HEIGHT = 1.02;
const DEFLECT_REFLECT_SPEED_FACTOR = 0.8;
const rapidCombatVisualWindowMs = 170;
const rapidCombatMajorEvery = 4;
const rapidCombatMinorBloodEmissionFactor = 0.62;
const bleedoutBloodEmissionFactor = 0.72;
/** Cosmetic roll-bolt flight speed (cells/s) — pure theater, established sandbox-style. */
const ROLL_BOLT_SPEED = 34;
/** Misses streak past the target by this many cells before dying. */
const ROLL_MISS_OVERSHOOT_CELLS = 2.2;
const CREATURE_DEATH_BURST_HEIGHT_FACTOR = 0.5;

interface ShieldSink {
  block(actorId: string, incoming: Vector3 | null, chargeT: number): void;
}

interface DeflectSink {
  /** Defender plays a directional parry; incoming = shot direction (world XZ). */
  play(actorId: string, incomingX: number, incomingZ: number): void;
}

export interface FxEventTapParams {
  particles: ParticleLayers;
  muzzle: MuzzleFx;
  tracers: TracerFx;
  hits: HitFx;
  status: StatusFx;
  /** PSG shield sink; optional so tests can omit it. */
  shield?: ShieldSink | null;
  /** Saber-deflect anim sink; optional so tests can omit it. */
  deflect?: DeflectSink | null;
}

interface PendingRollVisual {
  dueMs: number;
  event: StateEvent;
  kind: TracerOutcomeKind;
  mag: number;
  emissionFactor: number;
  killed: boolean;
  downed: boolean;
}

export class FxEventTap {
  private readonly particles: ParticleLayers;
  private readonly muzzle: MuzzleFx;
  private readonly tracers: TracerFx;
  private readonly hits: HitFx;
  private readonly status: StatusFx;
  private readonly shield: ShieldSink | null;
  deflectSink: DeflectSink | null;

  private getMuzzle: ((actorId: string) => Vector3 | null) | null = null;

  // hit-detection: highest combat-event id processed
  private maxEventId = -1;
  // Combat-visual cadence: target -> last worldTime/burst index.
  private readonly cadenceLastAtMs = new Map<string, number>();
  private readonly cadenceBurstIndex = new Map<string, number>();
  private readonly pendingRollVisuals: PendingRollVisual[] = [];
  private readonly rollBurstOrdinalByKey = new Map<string, number>();
  private rollBurstOrdinalSweepAtMs = 0;


  // scratch (class scope, reused)
  private readonly _muzzleWorld = new Vector3();
  private readonly _dir = new Vector3();
  private readonly _origin = new Vector3();
  private readonly _hit = new Vector3();
  /**
   * Roll-lane endpoint, recomputed per applyRollEvent call. NEVER `_hit`: a
   * deferred burst pellet drains frames later, and `_hit` belongs to whatever
   * event applyHit processed last (stale target + compounding miss-overshoot
   * mutation were the mid-air/mid-pawn vanish bugs).
   */
  private readonly _rollHit = new Vector3();
  private readonly _incoming = new Vector3();
  private readonly _normal = new Vector3();
  private readonly _arriveNormal = new Vector3();
  private readonly _statusPoint = new Vector3();
  private readonly _deathBurstPoint = new Vector3();
  private readonly _reflectDir = new Vector3();
  private readonly _reflectNormal = new Vector3();
  private readonly _reflectSide = new Vector3();

  // live arrival telemetry (verification surface; assignments only, no alloc)
  arrivalCount = 0;
  lastArrivalKind: TracerOutcomeKind = 0;
  lastArrivalTargetActorId = "";
  readonly lastArrivalPoint = new Vector3();
  /** Target centre (world x/z) captured at the arrival instant. */
  readonly lastArrivalTargetCenter = new Vector3();

  constructor(params: FxEventTapParams) {
    this.particles = params.particles;
    this.muzzle = params.muzzle;
    this.tracers = params.tracers;
    this.hits = params.hits;
    this.status = params.status;
    this.shield = params.shield ?? null;
    this.deflectSink = params.deflect ?? null;
    // stable callback (set once, no per-frame closure). The tracer is the
    // timing authority: when it reaches its stamped hit point it fires the
    // deferred burst exactly when the round lands.
    this.tracers.onArrive = (rec: TracerRecord, state: PlayState) => {
      const ev = eventById(state, rec.outcomeEventId);
      const target = state.serverAuthority.actors[rec.outcomeTargetActorId];
      this.spawnImpact(rec.outcomeKind, rec.hitPoint, rec.dir, rec.outcomeMag, rec.outcomeEmissionFactor, rec.outcomeKilled, rec.outcomeDowned, ev, target, rec.outcomeTargetActorId);
      if (rec.outcomeKind === OUTCOME_BLOOD) {
        // Hit-confirm (owner brief 2026-07-08): a landed bolt visibly ENDS on
        // the surface — brief restrained spark/flash at the impact point.
        // Bolt-borne only (melee blood stays pure blood).
        this._arriveNormal.copy(rec.dir).multiplyScalar(-1);
        this.particles.emitSparkBurst(
          rec.hitPoint,
          this._arriveNormal,
          rec.dir,
          FX_CONFIG.hit.landedImpactSparkMag * Math.min(1.3, rec.outcomeMag),
        );
      }
      if (rec.outcomeKind !== 0) {
        const recStyleId = (rec as TracerRecord & { styleId?: keyof typeof FX_CONFIG.boltStyles }).styleId ?? "ballistic";
        const style = FX_CONFIG.boltStyles[recStyleId] ?? FX_CONFIG.boltStyles.ballistic;
        const hitStyle = hitStyleForBolt(style);
        if (hitStyle) this.hits.spawn(hitStyle, rec.hitPoint, rec.dir, style.coreColor, rec.outcomeMag);
      }
      this.arrivalCount += 1;
      this.lastArrivalKind = rec.outcomeKind;
      this.lastArrivalTargetActorId = rec.outcomeTargetActorId;
      this.lastArrivalPoint.copy(rec.hitPoint);
      if (target) this.lastArrivalTargetCenter.set(target.x + 0.5, rec.hitPoint.y, target.y + 0.5);
      else this.lastArrivalTargetCenter.copy(rec.hitPoint);
    };
  }

  setMuzzleProvider(fn: ((actorId: string) => Vector3 | null) | null): void {
    this.getMuzzle = fn;
  }

  /** Muzzle world position for an actor (demo hooks); null when unavailable. */
  muzzleWorldFor(actorId: string): Vector3 | null {
    return this.getMuzzle?.(actorId) ?? null;
  }

  update(state: PlayState): void {
    this.drainPendingRollVisuals(state);
    this.processCombatEvents(state);
    this.drainPendingRollVisuals(state);
    this.sweepRollBurstOrdinals(state);
  }

  // --- hits -----------------------------------------------------------------

  private processCombatEvents(state: PlayState): void {
    const log = state.serverAuthority.eventLog;
    if (log.length === 0) return;
    let maxId = this.maxEventId;
    // reconnect/reset guard: if the whole log is older than what we've seen,
    // the session restarted — reset our cursor.
    let logMax = -1;
    for (let i = 0; i < log.length; i++) {
      const id = log[i]!.id;
      if (id > logMax) logMax = id;
    }
    if (logMax < this.maxEventId) {
      maxId = -1;
      this.maxEventId = -1;
      this.pendingRollVisuals.length = 0;
      this.rollBurstOrdinalByKey.clear();
    }

    const activeAreaId = state.activeAreaId;
    for (let i = 0; i < log.length; i++) {
      const ev = log[i]!;
      if (ev.id <= maxId) continue;
      if (ev.id > this.maxEventId) this.maxEventId = ev.id;
      // filter to the active area (target or shooter present here)
      const target = state.serverAuthority.actors[ev.targetActorId];
      if (target && target.areaId !== activeAreaId) continue;
      this.applyHit(state, ev);
    }
  }

  private applyRollEvent(state: PlayState, ev: StateEvent, kind: TracerOutcomeKind, mag: number, emissionFactor: number, killed: boolean, downed: boolean): void {
    // The ranged_roll event is the whole authority truth. Spawn one cosmetic
    // bolt muzzle→endpoint and defer its impact until visual arrival.
    //
    // SELF-CONTAINED endpoint (owner report 2026-07-08): burst pellets 2..6
    // drain 115ms+ after applyHit stamped the shared `_hit` scratch, by which
    // time it holds another event's point (wrong target) or this burst's own
    // miss overshoot (compounding +2.2 cells per miss). Recompute from the
    // event + LIVE target here so staggered pellets track the pawn.
    const shooterId = ev.shooterActorId;
    const shooter = state.serverAuthority.actors[shooterId];
    const target = state.serverAuthority.actors[ev.targetActorId];
    const zoneH = hitHeightFor(ev, target);
    const hp = ev.hitPoint;
    if (target) {
      this._rollHit.set(target.x + 0.5, zoneH, target.y + 0.5);
    } else if (hp) {
      this._rollHit.set(hp.x, zoneH, hp.y);
    } else {
      return;
    }
    const provided = this.getMuzzle?.(shooterId);
    if (provided) {
      this._muzzleWorld.copy(provided);
    } else if (shooter) {
      this._muzzleWorld.set(shooter.x + 0.5, FX_CONFIG.chestHeight, shooter.y + 0.5);
    } else {
      this._muzzleWorld.copy(this._rollHit).setY(FX_CONFIG.chestHeight);
    }
    if (kind === OUTCOME_DEFLECT && target) {
      // The bolt dies on the BLADE, never the body: pull the endpoint from the
      // defender centre toward the shooter at blade height.
      this._dir.set(this._muzzleWorld.x - (target.x + 0.5), 0, this._muzzleWorld.z - (target.y + 0.5));
      const dl = this._dir.length();
      if (dl > 1e-4) this._dir.multiplyScalar(1 / dl);
      else this._dir.set(1, 0, 0);
      this._rollHit.set(
        target.x + 0.5 + this._dir.x * DEFLECT_INTERCEPT_TOWARD_SHOOTER,
        DEFLECT_INTERCEPT_HEIGHT,
        target.y + 0.5 + this._dir.z * DEFLECT_INTERCEPT_TOWARD_SHOOTER,
      );
    }
    this._dir.subVectors(this._rollHit, this._muzzleWorld);
    let travel = this._dir.length();
    if (travel <= 1e-3) return;
    this._dir.multiplyScalar(1 / travel);
    // IMPACT HONESTY (owner report 2026-07-08): a landed round terminates at
    // the target's collision surface facing the shooter — never the centre
    // axis (which read as the bolt burying half a body deep, then vanishing).
    // Deflects already stop at the blade intercept; misses fly past.
    if (kind !== OUTCOME_DEFLECT && target && ev.hit !== false) {
      travel = Math.max(0.05, travel - FX_CONFIG.hit.impactSurfaceRadiusCells);
      this._rollHit.copy(this._muzzleWorld).addScaledVector(this._dir, travel);
    }
    if (isMeleeRollPresentationEvent(ev, state)) {
      if (ev.hit !== false) this.spawnImpact(kind, this._rollHit, this._dir, mag, emissionFactor, killed, downed, ev, target);
      return;
    }
    if (ev.hit === false) {
      // Miss: the bolt streaks PAST the target and dies in the dirt — the
      // read is "shot happened, didn't connect", never a phantom hit.
      travel += ROLL_MISS_OVERSHOOT_CELLS;
      this._rollHit.addScaledVector(this._dir, ROLL_MISS_OVERSHOOT_CELLS);
    }
    this.muzzle.flash(this._muzzleWorld, this._dir, 1, null);
    const key = rollBoltKey(ev.id);
    this.tracers.spawn({
      origin: this._muzzleWorld,
      dir: this._dir,
      speed: ROLL_BOLT_SPEED,
      range: travel,
      key,
      mag,
      style: boltStyleForWeapon(ev.weaponId ?? state.serverAuthority.actors[ev.shooterActorId]?.weapon?.weaponId),
    });
    this.tracers.setOutcome(key, kind, this._rollHit, mag, emissionFactor, killed, downed, ev.id, ev.targetActorId);
  }

  private applyHit(state: PlayState, ev: StateEvent): void {
    const target = state.serverAuthority.actors[ev.targetActorId];
    const isDodge = isDodgeEffect(ev);
    const isShield = isShieldEffect(ev);
    const isSleep = ev.effect?.kind === "sleep";
    const killed = ev.lifecycle?.kind === "killed"
      || (ev.previousLifeState !== ev.lifeState && ev.lifeState === "respawning");
    const downed = ev.lifecycle?.kind === "downed"
      || (ev.previousLifeState !== ev.lifeState && ev.lifeState === "downed");
    const zoneH = hitHeightFor(ev, target);
    const mag = killed ? 1 + FX_CONFIG.hit.killedMagnitudeBoost : 1;

    // hit point world (already in pawn-centre space; zone sets the burst height)
    const hp = ev.hitPoint;
    if (hp) {
      this._hit.set(hp.x, zoneH, hp.y);
    } else if (target) {
      this._hit.set(target.x + 0.5, zoneH, target.y + 0.5);
    } else {
      return;
    }
    // Dodge/shield lifecycle causes beat damage blood; sleep darts
    // intentionally no-op rather than faking blood.
    let kind: TracerOutcomeKind;
    if (isDeflectedEffect(ev)) {
      kind = OUTCOME_DEFLECT;
    } else if (isDodge || isShield) {
      kind = OUTCOME_SPARK;
    } else if (isSleep) {
      kind = 0;
    } else if (ev.damage <= 0) {
      kind = OUTCOME_SPARK;
    } else {
      kind = OUTCOME_BLOOD;
    }

    let emissionFactor = 1;
    if (!isDodge && !isShield && !isSleep) {
      const major = this.combatVisualCadenceMajorFor(state, ev.targetActorId, killed, downed);
      emissionFactor = bloodEmissionFactorFor(ev, major);
    }

    if (ev.kind === "ranged_roll") {
      // A server burst arrives as up to six same-tick ranged_roll events;
      // stagger only the cosmetic
      // muzzle/tracer read here, never the authoritative health result.
      this.scheduleRollEvent(state, ev, kind, mag, emissionFactor, killed, downed);
      return;
    }

    // incoming shot direction (origin -> hit), for spray/ricochet bias
    const op = ev.originPoint;
    if (op) {
      this._origin.set(op.x, FX_CONFIG.chestHeight, op.y);
    } else if (target) {
      this._origin.set(target.x + 0.5, FX_CONFIG.chestHeight, target.y + 0.5);
    } else {
      this._origin.copy(this._hit);
    }
    this._incoming.subVectors(this._hit, this._origin);
    const il = this._incoming.length();
    if (il > 1e-4) this._incoming.multiplyScalar(1 / il);
    else this._incoming.set(1, 0, 0);
    // IMPACT HONESTY: same surface clamp as the roll lane — body hits resolve
    // at the surface facing the shooter (deferred tracer stamp AND immediate
    // fallback), so the burst never pops from inside the mesh.
    if (kind !== OUTCOME_DEFLECT && target && il > 1e-4) {
      const pull = Math.min(FX_CONFIG.hit.impactSurfaceRadiusCells, Math.max(0, il - 0.05));
      this._hit.addScaledVector(this._incoming, -pull);
    }

    this.spawnImpact(kind, this._hit, this._incoming, mag, emissionFactor, killed, downed, ev, target);
    if (kind !== 0) {
      const style = FX_CONFIG.boltStyles[boltStyleForWeapon(ev.weaponId)] ?? FX_CONFIG.boltStyles.ballistic;
      const hitStyle = hitStyleForBolt(style);
      if (hitStyle) this.hits.spawn(hitStyle, this._hit, this._incoming, style.coreColor, mag);
    }
  }

  private scheduleRollEvent(state: PlayState, ev: StateEvent, kind: TracerOutcomeKind, mag: number, emissionFactor: number, killed: boolean, downed: boolean): void {
    const delayMs = this.rollBurstDelayMs(ev);
    if (delayMs <= 0) {
      this.applyRollEvent(state, ev, kind, mag, emissionFactor, killed, downed);
      return;
    }
    this.pendingRollVisuals.push({
      dueMs: state.worldTimeMs + delayMs,
      event: ev,
      kind,
      mag,
      emissionFactor,
      killed,
      downed,
    });
  }

  private rollBurstDelayMs(ev: StateEvent): number {
    const key = rollBurstOrdinalKey(ev);
    const ordinal = this.rollBurstOrdinalByKey.get(key) ?? 0;
    this.rollBurstOrdinalByKey.set(key, ordinal + 1);
    return rollBurstDelayMsForOrdinal(ordinal);
  }

  private drainPendingRollVisuals(state: PlayState): void {
    const now = state.worldTimeMs;
    for (let i = 0; i < this.pendingRollVisuals.length;) {
      const pending = this.pendingRollVisuals[i]!;
      if (pending.dueMs > now) {
        i += 1;
        continue;
      }
      this.applyRollEvent(
        state,
        pending.event,
        pending.kind,
        pending.mag,
        pending.emissionFactor,
        pending.killed,
        pending.downed,
      );
      const last = this.pendingRollVisuals.pop();
      if (i < this.pendingRollVisuals.length && last) {
        this.pendingRollVisuals[i] = last;
      }
    }
  }

  private sweepRollBurstOrdinals(state: PlayState): void {
    if (state.worldTimeMs - this.rollBurstOrdinalSweepAtMs < ROLL_BURST_ORDINAL_RESET_MS) return;
    this.rollBurstOrdinalSweepAtMs = state.worldTimeMs;
    this.rollBurstOrdinalByKey.clear();
  }

  /** Spawn the impact visual: sparks for deflects, particle blood for flesh. */
  private spawnImpact(
    kind: TracerOutcomeKind,
    hitPoint: Vector3,
    incoming: Vector3,
    mag: number,
    emissionFactor: number,
    killed: boolean,
    _downed: boolean,
    ev: StateEvent | undefined,
    target: StateActor | undefined,
    targetActorId?: string,
  ): void {
    if (kind === 0) {
      // Sleep hits do nothing rather than emitting misleading sparks. A lethal
      // wildlife hit still gets the current rigged-creature death flourish.
      this.emitCreatureDeathBurstIfNeeded(killed, ev, target, hitPoint, mag);
      return;
    }
    // Status language: a landing that ADDS bleed stacks pops the arterial
    // transient at the target — spawnImpact is the convergence point for the
    // deferred (tracer-arrival) and immediate paths, so the pop matches the
    // round's visual landing. Event-log ids process exactly once: no TTL churn.
    if (ev && (ev.bleedStackCount ?? 0) > 0 && target) {
      this._statusPoint.set(target.x + 0.5, 0, target.y + 0.5);
      this.status.spawn("bleed", this._statusPoint);
    }
    // surface normal ~ back toward the shooter (ricochet/spurt direction)
    this._normal.copy(incoming).multiplyScalar(-1);
    if (kind === OUTCOME_DEFLECT) {
      this.deflectBurst(hitPoint, incoming, ev, targetActorId ?? ev?.targetActorId ?? "");
      return;
    }
    if (kind === OUTCOME_SPARK) {
      this.particles.emitSparkBurst(hitPoint, this._normal, incoming, killed ? 1.2 : mag);
      // PSG identity: a shield-caused deflect ALSO raises the energy dome on
      // the blocked actor, rippling from the arriving hit's direction. The
      // spark stays (metal-on-field read); the dome is the shield's body.
      if (this.shield && ev && isShieldEffect(ev)) {
        const shieldState = target?.personalShield;
        const chargeT = shieldState && shieldState.maxChargeMilli > 0
          ? shieldState.chargeMilli / shieldState.maxChargeMilli
          : 1;
        this.shield.block(ev.targetActorId, incoming, chargeT);
      }
      this.emitCreatureDeathBurstIfNeeded(killed, ev, target, hitPoint, mag);
      return;
    }
    // OUTCOME_BLOOD: particle blood + drips. The particle layer with its
    // ground-splat physics is the single blood visual. The
    // cadence emissionFactor throttles automatic-volley over-spawn; floored
    // so landed hits never go visually silent.
    this.particles.emitBloodBurst(hitPoint, incoming, (killed ? 1.35 : mag) * Math.max(0.4, emissionFactor), FX_CONFIG.blood.palettes.red);
    this.emitCreatureDeathBurstIfNeeded(killed, ev, target, hitPoint, mag);
  }

  private emitCreatureDeathBurstIfNeeded(
    killed: boolean,
    ev: StateEvent | undefined,
    target: StateActor | undefined,
    fallbackPoint: Vector3,
    mag: number,
  ): void {
    const creatureHeight = target ? gaiaCreatureHeight(target.sprite) : null;
    if (!killed || !ev || creatureHeight === null) return;
    const seed = creatureDeathBurstSeed(ev);
    const burstHeight = creatureHeight * CREATURE_DEATH_BURST_HEIGHT_FACTOR;
    if (target) this._deathBurstPoint.set(target.x + 0.5, burstHeight, target.y + 0.5);
    else this._deathBurstPoint.copy(fallbackPoint).setY(burstHeight);
    this.particles.emitCreatureDeathBurst(this._deathBurstPoint, seed, Math.max(1, mag), FX_CONFIG.blood.palettes.red);
  }

  private combatVisualCadenceMajorFor(state: PlayState, targetActorId: string, killed: boolean, downed: boolean): boolean {
    // The shared authority-visuals path also uses cadence to gate damage text
    // and body-hit SFX. This read-only tap keeps its own cadence fields for
    // tracer-outcome timing compatibility.
    if (killed || downed) return true;
    const now = state.worldTimeMs;
    const previousAt = this.cadenceLastAtMs.get(targetActorId);
    const previousIndex = this.cadenceBurstIndex.get(targetActorId) ?? 0;
    const burstIndex = previousAt !== undefined && now - previousAt <= rapidCombatVisualWindowMs
      ? previousIndex + 1
      : 0;
    this.cadenceLastAtMs.set(targetActorId, now);
    this.cadenceBurstIndex.set(targetActorId, burstIndex);
    return burstIndex === 0 || burstIndex % rapidCombatMajorEvery === 0;
  }

  /**
   * FX-LAB demo: spawn a cosmetic incoming bolt from `muzzle` at the actor and
   * stamp a DEFLECT outcome at the blade intercept — the arrival then runs the
   * exact production deflectBurst path (flash/sparks/reflect/anim).
   */
  deflectDemo(muzzle: Vector3, targetActorId: string, state: PlayState): void {
    const target = state.serverAuthority.actors[targetActorId];
    if (!target) return;
    this._dir.set(target.x + 0.5 - muzzle.x, 0, target.y + 0.5 - muzzle.z);
    const dl = this._dir.length();
    if (dl <= 1e-3) return;
    this._dir.multiplyScalar(1 / dl);
    this._hit.set(
      target.x + 0.5 - this._dir.x * DEFLECT_INTERCEPT_TOWARD_SHOOTER,
      DEFLECT_INTERCEPT_HEIGHT,
      target.y + 0.5 - this._dir.z * DEFLECT_INTERCEPT_TOWARD_SHOOTER,
    );
    this._origin.copy(muzzle).setY(FX_CONFIG.chestHeight);
    this._incoming.subVectors(this._hit, this._origin);
    const travel = this._incoming.length();
    if (travel <= 1e-3) return;
    this._incoming.multiplyScalar(1 / travel);
    this.muzzle.flash(this._origin, this._incoming, 1, null);
    const key = reflectBoltKey(1 + ((state.worldTimeMs | 0) % 800_000));
    this.tracers.spawn({
      origin: this._origin,
      dir: this._incoming,
      speed: ROLL_BOLT_SPEED,
      range: travel,
      key,
      mag: 1,
      style: boltStyleForWeapon(state.serverAuthority.actors[targetActorId]?.weapon?.weaponId),
    });
    this.tracers.setOutcome(key, OUTCOME_DEFLECT, this._hit, 1, 1, false, false, -1, targetActorId);
  }

  /**
   * The saber-deflect read (owner brief 2026-07-07, Core3 RICOCHET homage):
   * white-hot flash at the blade, a metal spark cone, and the bolt VISIBLY
   * reflected — a second cosmetic bolt pings off along the mirrored direction
   * with an upward/lateral scatter, dying in the air. Defender plays a
   * directional parry via the deflect sink. Deterministic per event id.
   */
  private deflectBurst(intercept: Vector3, incoming: Vector3, ev: StateEvent | undefined, targetActorId: string): void {
    const seed = ev?.id ?? (Math.abs((intercept.x * 7919 + intercept.z * 104729) | 0));
    const lateral = (((seed * 2654435761) >>> 0) / 0xffffffff) - 0.5; // [-0.5, 0.5)
    // blade normal: back toward the shooter, tilted up, laterally jittered
    this._reflectSide.set(-incoming.z, 0, incoming.x).multiplyScalar(lateral * 1.4);
    this._reflectNormal.copy(incoming).multiplyScalar(-1)
      .add(this._reflectSide)
      .setY(0.9)
      .normalize();
    // r = i - 2(i.n)n
    const dot = incoming.dot(this._reflectNormal);
    this._reflectDir.copy(incoming).addScaledVector(this._reflectNormal, -2 * dot).normalize();
    this.muzzle.flash(intercept, this._reflectDir, 1.4, null);
    this.particles.emitSparkBurst(intercept, this._reflectNormal, incoming, 1.6);
    this.tracers.spawn({
      origin: intercept,
      dir: this._reflectDir,
      speed: ROLL_BOLT_SPEED * DEFLECT_REFLECT_SPEED_FACTOR,
      range: 3.2 + Math.abs(lateral) * 2.5,
      key: reflectBoltKey(seed),
      mag: 0.65,
      style: boltStyleForWeapon(ev?.weaponId),
    });
    if (targetActorId) this.deflectSink?.play(targetActorId, incoming.x, incoming.z);
  }

}
function isDeflectedEffect(ev: StateEvent): boolean {
  return ev.effect?.kind === "deflected";
}

/** Synthetic key-space for reflected bolts, distinct from Roll event keys. */
function reflectBoltKey(seed: number): number {
  return -2_000_000 - (seed % 900_000);
}

function eventById(state: PlayState, eventId: number): StateEvent | undefined {
  const log = state.serverAuthority.eventLog;
  for (let i = log.length - 1; i >= 0; i -= 1) {
    if (log[i]!.id === eventId) return log[i] as StateEvent;
  }
  return undefined;
}

function isDodgeEffect(ev: StateEvent): boolean {
  return ev.effect?.kind === "dodge" || ev.lifecycle?.cause === "dodged";
}

function isShieldEffect(ev: StateEvent): boolean {
  const cause = ev.lifecycle?.cause;
  return ev.effect?.kind === "shield" || cause === "personal shield" || cause === "personal-shield";
}

function isBleedoutLifecycleEvent(ev: StateEvent): boolean {
  return ev.lifecycle?.cause === "bleedout" || ev.lifecycle?.cause === "downed expiration";
}

function bloodEmissionFactorFor(ev: StateEvent, major: boolean): number {
  if (isBleedoutLifecycleEvent(ev)) return bleedoutBloodEmissionFactor;
  if (!major) return rapidCombatMinorBloodEmissionFactor;
  return 1 + (ev.bleedStackCount ?? 0) * 0.2;
}

/** Measured adult heights for the current rigged Gaia creature set. */
const GAIA_CREATURE_HEIGHTS: Readonly<Record<string, number>> = {
  "creature-bellback-adult": 1.52,
  "creature-pebblehorn-adult": 0.97,
  "creature-snufflefin-adult": 0.94,
  "creature-pocketclod-adult": 0.98,
  "creature-mossmuff-adult": 1.37,
  "creature-dapplepod-adult": 0.99,
};

function gaiaCreatureHeight(sprite: string | null | undefined): number | null {
  if (!sprite) return null;
  return GAIA_CREATURE_HEIGHTS[sprite] ?? null;
}

export function creatureHitHeight(sprite: string | null | undefined, zone: string): number | null {
  const height = gaiaCreatureHeight(sprite);
  if (height === null) return null;
  if (zone === "head") return height * 0.78;
  if (zone === "legs") return height * 0.28;
  return height * 0.52;
}

/** Burst height follows the current rigged creature model when applicable. */
function hitHeightFor(ev: StateEvent, target: StateActor | undefined): number {
  return creatureHitHeight(target?.sprite, ev.zone)
    ?? FX_CONFIG.zoneHeight[ev.zone]
    ?? FX_CONFIG.zoneHeight.torso
    ?? 1.15;
}

function isMeleeRollPresentationEvent(ev: StateEvent, state: PlayState): boolean {
  const shooterWeapon = state.serverAuthority.actors[ev.shooterActorId]?.weapon;
  return isMeleeWeaponPresentation(
    ev.weaponId ?? shooterWeapon?.weaponId ?? null,
    ev.ammoTypeId ?? shooterWeapon?.ammoType ?? null,
  );
}

function creatureDeathBurstSeed(ev: StateEvent): number {
  let hash = ev.id * 1103515245 + ev.tick * 97;
  for (let index = 0; index < ev.targetActorId.length; index += 1) {
    hash = Math.imul(hash ^ ev.targetActorId.charCodeAt(index), 16777619);
  }
  return positiveModulo(hash, 0x7fffffff);
}

function positiveModulo(value: number, divisor: number): number {
  return ((value % divisor) + divisor) % divisor;
}






function hitStyleForBolt(style: BoltStyle | undefined): HitStyleId | undefined {
  return style?.hit;
}

/**
 * Minimal structural view of ServerAuthorityCombatEventState — we read fields
 * by name, so a structural alias avoids importing the full shared type (which
 * pulls a large transitive graph) while staying type-safe on the fields used.
 */
interface StateEvent {
  id: number;
  targetActorId: string;
  shooterActorId: string;
  originPoint?: { x: number; y: number } | null;
  hitPoint?: { x: number; y: number } | null;
  damage: number;
  zone: string;
  tick: number;
  bleedStackCount?: number;
  previousLifeState: string;
  lifeState: string;
  effect?: { kind: "sleep" | "dodge" | "shield" | "deflected" } | null;
  lifecycle?: { kind: "hit" | "downed" | "killed"; cause?: string } | null;
  /** Roll-combat extensions (ranged_roll events). */
  kind?: string;
  hit?: boolean;
  actionId?: string;
  weaponId?: string;
  ammoTypeId?: string;
}

/** Stable negative key-space for cosmetic Roll-combat bolts. */
function rollBoltKey(eventId: number): number {
  return -1_000_000 - eventId;
}

interface StateActor {
  x: number;
  y: number;
  role?: string | null;
  /** Species sprite (e.g. creature-bellback-adult) — keys blood palette per species. */
  sprite?: string | null;
  label?: string | null;
  areaId?: string;
  lifeState?: string;
  /** PSG charge read for the dome tint (fx/shield.ts). */
  personalShield?: { chargeMilli: number; maxChargeMilli: number } | null;
}
