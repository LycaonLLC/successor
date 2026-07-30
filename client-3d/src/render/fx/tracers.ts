import type { PlayState } from "@successor/client/src/slice-core/gameState";
import {
  AdditiveBlending,
  CylinderGeometry,
  Mesh,
  MeshBasicMaterial,
  NormalBlending,
  Object3D,
  Quaternion,
  Sprite,
  SpriteMaterial,
  Vector3,
  type Scene,
  type Texture,
} from "three";
import { BufferAttribute, BufferGeometry, Line, LineBasicMaterial } from "three";
import { FX_CONFIG, type BoltStyle, type BoltStyleId } from "./config";

/**
 * Pooled cosmetic tracer bolts for the orthographic 3D scene.
 *
 * Each tracer is a bright additive streak (a unit cylinder re-spanned
 * prev->cur every frame, gap-free at any speed) plus a soft head glow sprite.
 * Tracers travel straight along their launch direction at the configured
 * presentation speed and despawn at max range.
 *
 * TIMING MODEL (correct hit sequencing): a tracer is the timing authority for
 * Roll-combat hits. `setOutcome()` stamps the authoritative hit
 * point + outcome onto the record. The tracer keeps flying; only when it
 * visually reaches hitDist does it fire `onArrive()`, which spawns the
 * blood/spark/decals exactly when the round lands. This avoids early blood
 * pops and mid-flight tracer vanish.
 *
 * Zero per-frame allocations: pooled records with pre-allocated Vector3s, a
 * fixed geometry + per-record materials created once at warmup, and a bounded
 * key->record map. No closures or object literals on the spawn/update path.
 */

export type TracerOutcomeKind = 0 | 1 | 2 | 3; // 0 none, 1 blood, 2 spark, 3 saber-deflect

export interface TracerRecord {
  alive: boolean;
  group: Object3D;
  core: Mesh;
  head: Sprite;
  pos: Vector3;
  prev: Vector3;
  dir: Vector3;
  speed: number;
  travelled: number;
  range: number;
  radius: number;
  mag: number;
  key: number; // presentation event key
  styleId: string;
  /** Drawn-streak length multiplier from the bolt style (lance stretches, plasma shortens). */
  styleLengthMul: number;
  /** Arc style: jagged polyline crackle instead of a straight core read. */
  styleArc: boolean;
  wobbleAmp: number;
  wobbleHz: number;
  wobblePhase: number;
  stutterHz: number;
  flicker: boolean;
  dark: boolean;
  arcLine: Line;
  arcPositions: Float32Array;
  // deferred outcome (fixed fields; written by setOutcome, no allocation)
  hasOutcome: boolean;
  outcomeKind: TracerOutcomeKind;
  outcomeMag: number;
  outcomeEmissionFactor: number;
  outcomeKilled: boolean;
  outcomeDowned: boolean;
  outcomeEventId: number;
  outcomeTargetActorId: string;
  hitPoint: Vector3;
  hitDist: number;
  hitDone: boolean;
  /** Arrival frame drawn (streak ends exactly on the surface); frees next update. */
  terminal: boolean;
}

const Y_AXIS = new Vector3(0, 1, 0);

export class TracerFx {
  /** Called when a tracer reaches its stamped hit point. Stable ref, no alloc. */
  onArrive: ((rec: TracerRecord, state: PlayState) => void) | null = null;

  private readonly records: TracerRecord[] = [];
  private readonly freeStack: number[] = [];
  private readonly byKey = new Map<number, TracerRecord>();

  // scratch
  private readonly _seg = new Vector3();
  private readonly _mid = new Vector3();
  private readonly _q = new Quaternion();

  constructor(scene: Scene, sprite: Texture) {
    const geo = new CylinderGeometry(1, 1, 1, 6, 1, true);
    const ARC_POINTS = 9;
    for (let i = 0; i < FX_CONFIG.tracers.poolSize; i++) {
      const core = new Mesh(geo, new MeshBasicMaterial({
        color: FX_CONFIG.tracers.coreColor,
        transparent: true,
        opacity: 1,
        blending: AdditiveBlending,
        depthWrite: false,
        fog: false,
      }));
      core.renderOrder = 11;
      const head = new Sprite(new SpriteMaterial({
        map: sprite,
        color: FX_CONFIG.tracers.headColor,
        transparent: true,
        opacity: 1,
        blending: AdditiveBlending,
        depthWrite: false,
        fog: false,
      }));
      head.renderOrder = 12;
      const group = new Object3D();
      group.visible = false;
      group.add(core);
      group.add(head);
      // arc-style crackle polyline (hidden unless the style asks for it)
      const arcPositions = new Float32Array(ARC_POINTS * 3);
      const arcGeo = new BufferGeometry();
      arcGeo.setAttribute("position", new BufferAttribute(arcPositions, 3));
      const arcLine = new Line(arcGeo, new LineBasicMaterial({
        color: 0x7fd4ff,
        transparent: true,
        opacity: 1,
        blending: AdditiveBlending,
        depthWrite: false,
        fog: false,
      }));
      arcLine.renderOrder = 12;
      arcLine.visible = false;
      arcLine.frustumCulled = false;
      scene.add(arcLine);
      scene.add(group);
      const rec: TracerRecord = {
        alive: false,
        group, core, head,
        pos: new Vector3(), prev: new Vector3(), dir: new Vector3(),
        speed: 0, travelled: 0, range: 0, radius: FX_CONFIG.tracers.radiusBase, mag: 1,
        key: -1,
        styleId: "ballistic",
        styleLengthMul: 1,
        styleArc: false,
        wobbleAmp: 0, wobbleHz: 0, wobblePhase: 0, stutterHz: 0,
        flicker: false, dark: false,
        arcLine,
        arcPositions,
        hasOutcome: false, outcomeKind: 0, outcomeMag: 1, outcomeEmissionFactor: 1,
        outcomeKilled: false, outcomeDowned: false,
        outcomeEventId: -1, outcomeTargetActorId: "",
        hitPoint: new Vector3(), hitDist: Infinity, hitDone: false,
        terminal: false,
      };
      this.records.push(rec);
      this.freeStack.push(i);
    }
  }

  /**
   * Spawn a tracer.
   * Returns false if the pool is exhausted (rare burst — drop silently).
   */
  spawn(opts: {
    origin: Vector3;
    dir: Vector3;
    speed: number;
    range: number;
    key: number;
    mag?: number;
    color?: number;
    style?: BoltStyleId;
  }): boolean {
    const idx = this.freeStack.pop();
    if (idx === undefined) return false;
    const rec = this.records[idx]!;
    const styleId = opts.style ?? "ballistic";
    const style: BoltStyle = FX_CONFIG.boltStyles[styleId];
    rec.pos.copy(opts.origin);
    rec.prev.copy(opts.origin);
    rec.dir.copy(opts.dir);
    const dl = rec.dir.length();
    if (dl > 1e-5) rec.dir.multiplyScalar(1 / dl);
    rec.speed = opts.speed;
    rec.range = opts.range;
    rec.mag = opts.mag ?? 1;
    rec.styleId = styleId;
    rec.radius = (FX_CONFIG.tracers.radiusBase + FX_CONFIG.tracers.radiusPerMag * rec.mag) * style.radiusMul;
    rec.styleLengthMul = style.lengthMul;
    rec.styleArc = style.arc;
    rec.wobbleAmp = style.wobbleAmp ?? 0;
    rec.wobbleHz = style.wobbleHz ?? 0;
    rec.wobblePhase = rec.wobbleAmp > 0 ? Math.random() * Math.PI * 2 : 0;
    rec.stutterHz = style.stutterHz ?? 0;
    rec.flicker = style.flicker ?? false;
    rec.dark = style.dark ?? false;
    rec.arcLine.visible = false;
    rec.travelled = 0;
    rec.alive = true;
    rec.key = opts.key;
    rec.hasOutcome = false;
    rec.outcomeKind = 0;
    rec.outcomeMag = 1;
    rec.outcomeEmissionFactor = 1;
    rec.outcomeKilled = false;
    rec.outcomeDowned = false;
    rec.outcomeEventId = -1;
    rec.outcomeTargetActorId = "";
    rec.hitDist = Infinity;
    rec.hitDone = false;
    rec.terminal = false;
    const coreMat = rec.core.material as MeshBasicMaterial;
    const headMat = rec.head.material as SpriteMaterial;
    const arcMat = rec.arcLine.material as LineBasicMaterial;
    const desiredCoreBlending = rec.dark ? NormalBlending : AdditiveBlending;
    if (coreMat.blending !== desiredCoreBlending) {
      coreMat.blending = desiredCoreBlending;
      coreMat.needsUpdate = true;
    }
    const col = opts.color ?? style.coreColor;
    coreMat.color.setHex(col);
    coreMat.opacity = 1;
    headMat.color.setHex(opts.color ?? style.headColor);
    headMat.opacity = 1;
    arcMat.color.setHex(style.coreColor);
    arcMat.opacity = 1;
    const hs = rec.radius * 7.0 * style.headScaleMul;
    rec.head.scale.set(hs, hs, hs);
    rec.group.visible = true;
    rec.head.position.copy(rec.pos);
    this.byKey.set(opts.key, rec);
    return true;
  }
  /**
   * Stamp a deferred outcome onto the tracer matching `key`. The tracer keeps
   * flying; onArrive fires when it reaches hitDist. No-op if no matching tracer
   * (for example, when the bolt has already despawned).
   */
  setOutcome(
    key: number,
    kind: TracerOutcomeKind,
    hitPoint: Vector3,
    mag: number,
    emissionFactor: number,
    killed: boolean,
    downed: boolean,
    eventId: number,
    targetActorId: string,
  ): boolean {
    const rec = this.byKey.get(key);
    if (!rec || !rec.alive || rec.hasOutcome) return false;
    rec.hasOutcome = true;
    rec.outcomeKind = kind;
    rec.outcomeMag = mag;
    rec.outcomeEmissionFactor = emissionFactor;
    rec.outcomeKilled = killed;
    rec.outcomeDowned = downed;
    rec.outcomeEventId = eventId;
    rec.outcomeTargetActorId = targetActorId;
    rec.hitPoint.copy(hitPoint);
    // signed projection along the bore: a round that already flew past the hit
    // point (e.g. predicted shots where the event lags by ~RTT) gets a negative
    // remaining, clamped to 0 so the burst fires on the next frame instead of
    // re-flying the overshoot distance.
    const remaining = this._seg.subVectors(hitPoint, rec.pos).dot(rec.dir);
    rec.hitDist = rec.travelled + Math.max(0, remaining);
    return true;
  }

  update(dt: number, state: PlayState): void {
    if (dt <= 0) return;
    const cfg = FX_CONFIG.tracers;
    const groundY = FX_CONFIG.groundY;
    const records = this.records;
    for (let i = 0; i < records.length; i++) {
      const rec = records[i]!;
      if (!rec.alive) continue;
      if (rec.terminal) {
        // the arrival frame has been shown ending exactly at the hit point —
        // release the record now.
        this.despawn(rec);
        continue;
      }
      rec.prev.copy(rec.pos);
      const step = rec.speed * dt;
      rec.pos.addScaledVector(rec.dir, step);
      rec.travelled += step;

      // deferred outcome: crossed the stamped hit distance -> clamp the visual
      // back to the exact impact point, fire onArrive once, and draw ONE final
      // frame whose streak ENDS on the surface (no overshoot, no early vanish).
      if (rec.hasOutcome && !rec.hitDone && rec.travelled >= rec.hitDist) {
        rec.hitDone = true;
        rec.terminal = true;
        const over = rec.travelled - rec.hitDist;
        if (over > 0) {
          rec.pos.addScaledVector(rec.dir, -over);
          rec.travelled = rec.hitDist;
        }
        if (this.onArrive) this.onArrive(rec, state);
      }
      // settle if it noses into the floor
      if (rec.pos.y < groundY) rec.pos.y = groundY;

      // span the streak prev->cur (min length so a near-still frame still
      // reads); the bolt style stretches (lance) or shortens (plasma) the read
      this._seg.subVectors(rec.pos, rec.prev);
      let len = this._seg.length() * rec.styleLengthMul;
      const minLen = (cfg.minStreakLength + 0.5 * rec.radius) * rec.styleLengthMul;
      if (len < minLen) {
        len = minLen;
      }
      this._seg.copy(rec.dir).multiplyScalar(len);
      this._mid.copy(rec.pos).addScaledVector(this._seg, -0.5);
      rec.group.position.copy(this._mid);
      this._q.setFromUnitVectors(Y_AXIS, len > 1e-5 ? this._seg.multiplyScalar(1 / len) : Y_AXIS);
      rec.core.quaternion.copy(this._q);
      rec.core.scale.set(rec.radius, len, rec.radius);
      if (rec.stutterHz > 0) {
        const ageSeconds = rec.speed > 1e-5 ? rec.travelled / rec.speed : 0;
        rec.core.scale.y = len * (0.4 + 0.6 * Math.abs(Math.sin(ageSeconds * rec.stutterHz * Math.PI)));
      }
      rec.head.position.copy(rec.pos).sub(this._mid);
      if (rec.wobbleAmp > 0) {
        const ageSeconds = rec.speed > 1e-5 ? rec.travelled / rec.speed : 0;
        const wobble = Math.sin(ageSeconds * rec.wobbleHz * Math.PI * 2 + rec.wobblePhase) * rec.wobbleAmp;
        rec.group.position.x += -rec.dir.z * wobble;
        rec.group.position.z += rec.dir.x * wobble;
      }

      // arc style: regenerate the crackle polyline prev->cur with
      // perpendicular jitter (fixed-size buffer, no allocation)
      if (rec.styleArc) {
        // NOTE: this._seg is already normalized by the quaternion step above —
        // span the crackle along dir * len (the drawn streak), tail from the
        // head position.
        rec.arcLine.visible = rec.group.visible;
        const arr = rec.arcPositions;
        const n = arr.length / 3;
        // perpendicular basis in the ground plane
        const px = -rec.dir.z;
        const pz = rec.dir.x;
        for (let a = 0; a < n; a++) {
          const t = a / (n - 1);
          const bx = rec.pos.x - rec.dir.x * len * t;
          const by = rec.pos.y - rec.dir.y * len * t;
          const bz = rec.pos.z - rec.dir.z * len * t;
          const j = (a === 0 || a === n - 1) ? 0 : (Math.random() - 0.5) * rec.radius * 14;
          const jy = (a === 0 || a === n - 1) ? 0 : (Math.random() - 0.5) * rec.radius * 8;
          arr[a * 3] = bx + px * j;
          arr[a * 3 + 1] = by + jy;
          arr[a * 3 + 2] = bz + pz * j;
        }
        (rec.arcLine.geometry.getAttribute("position") as BufferAttribute).needsUpdate = true;
      }

      // fade over the final fraction of range — but ONLY for bolts with no
      // stamped arrival. A round that will visibly CONNECT (hit, deflect, or
      // miss dying in the dirt) stays hot to its endpoint; the old fade had
      // every roll bolt at opacity 0 by its own hit distance (hitDist ==
      // range), which read as a mid-flight vanish (owner report 2026-07-08).
      const k = rec.range > 0 ? rec.travelled / rec.range : 1;
      const a = rec.hasOutcome
        ? 1
        : k < cfg.fadeStartFraction ? 1 : Math.max(0, 1 - (k - cfg.fadeStartFraction) / (1 - cfg.fadeStartFraction));
      let coreOpacity = a * (rec.dark ? 0.85 : 1);
      let headOpacity = a;
      if (rec.flicker) {
        const flicker = 0.55 + 0.45 * Math.random();
        coreOpacity *= flicker;
        headOpacity *= flicker;
      }
      (rec.core.material as MeshBasicMaterial).opacity = coreOpacity;
      (rec.head.material as SpriteMaterial).opacity = headOpacity;
      if (rec.styleArc) (rec.arcLine.material as LineBasicMaterial).opacity = a;

      // terminal records own their lifetime (freed next update AFTER the
      // arrival frame is shown) — roll bolts stamp hitDist == range, so the
      // range check must not hide the arrival frame early.
      if (!rec.terminal && rec.travelled >= rec.range) this.despawn(rec);
    }
  }

  private despawn(rec: TracerRecord): void {
    rec.alive = false;
    rec.group.visible = false;
    rec.arcLine.visible = false;
    this.byKey.delete(rec.key);
    // reclaim pool slot
    for (let i = 0; i < this.records.length; i++) {
      if (this.records[i] === rec) {
        this.freeStack.push(i);
        break;
      }
    }
  }

  /** Active tracer count (debug). */
  get activeCount(): number {
    return this.records.length - this.freeStack.length;
  }

  dispose(): void {
    for (const rec of this.records) {
      (rec.core.material as MeshBasicMaterial).dispose();
      (rec.head.material as SpriteMaterial).dispose();
      (rec.arcLine.material as LineBasicMaterial).dispose();
      rec.arcLine.geometry.dispose();
      rec.arcLine.parent?.remove(rec.arcLine);
      rec.group.parent?.remove(rec.group);
    }
    this.records[0]?.core.geometry.dispose();
    this.records.length = 0;
    this.freeStack.length = 0;
    this.byKey.clear();
  }
}
