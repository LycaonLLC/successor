import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  CylinderGeometry,
  Line,
  LineBasicMaterial,
  Mesh,
  MeshBasicMaterial,
  Sprite,
  SpriteMaterial,
  Vector3,
  type Scene,
  type Texture,
} from "three";
import { FX_CONFIG } from "./config";

/**
 * BeamsFx — full-line weapon effects (owner brief 2026-07-08: "more full line
 * effects like the lightning... for other guns that shoot an electricity
 * style thing... a few diff types"). Three line identities, each distinct
 * from the powers-lightning BRAID:
 *
 *   arcbeam    TRUNK+FORK  one hot jagged trunk with side-forks that flicker
 *                          in and out (electricity rifle)
 *   pulsebeam  DASH-TRAIN  bright dashes TRAVELING along the line — energy
 *                          repeater cadence read
 *   searbeam   LANCE-BLOOM solid core+halo lance that blooms at the contact
 *                          point and dies — one-shot rail read
 *
 * House rules: pooled, zero per-frame alloc, strobe doctrine for electricity,
 * renderOrder 12, depthWrite off, fog off. Caster/target driven like powers.
 */

export type BeamFxId = "arcbeam" | "pulsebeam" | "searbeam";

export const BEAM_FX_IDS: readonly BeamFxId[] = ["arcbeam", "pulsebeam", "searbeam"];

const RENDER_ORDER = 12;
/** World-Y added to `caster.y` by every beam spawn (bore height of a standing
 * pawn). Callers with a REAL muzzle world point subtract this before spawn. */
export const BEAM_MUZZLE_H = 0.95;
const MUZZLE_H = BEAM_MUZZLE_H;
/** World-Y added to `target.y` by every beam spawn (chest-height contact). */
export const BEAM_TARGET_H = 0.7;
const TRUNK_POINTS = 14;
const FORK_POINTS = 4;

interface ArcbeamRecord {
  alive: boolean;
  age: number;
  life: number;
  from: Vector3;
  to: Vector3;
  trunk: Line<BufferGeometry, LineBasicMaterial>;
  trunkArr: Float32Array;
  forks: Line<BufferGeometry, LineBasicMaterial>[];
  forkArrs: Float32Array[];
  mat: LineBasicMaterial;
}

interface PulsebeamRecord {
  alive: boolean;
  age: number;
  life: number;
  from: Vector3;
  to: Vector3;
  count: number;
  dashes: Mesh<CylinderGeometry, MeshBasicMaterial>[];
  mat: MeshBasicMaterial;
  seeds: Float32Array;
}

interface SearbeamRecord {
  alive: boolean;
  age: number;
  life: number;
  from: Vector3;
  to: Vector3;
  core: Mesh<CylinderGeometry, MeshBasicMaterial>;
  coreMat: MeshBasicMaterial;
  halo: Mesh<CylinderGeometry, MeshBasicMaterial>;
  haloMat: MeshBasicMaterial;
  bloom: Sprite;
  bloomMat: SpriteMaterial;
}

const Y_AXIS = new Vector3(0, 1, 0);

export class BeamsFx {
  private readonly arcbeam: ArcbeamRecord[] = [];
  private readonly pulsebeam: PulsebeamRecord[] = [];
  private readonly searbeam: SearbeamRecord[] = [];
  private readonly beamGeometry = new CylinderGeometry(1, 1, 1, 6, 1, true);
  private readonly _dir = new Vector3();
  private readonly _perp = new Vector3();
  private readonly _mid = new Vector3();

  constructor(private readonly scene: Scene, sprite: Texture) {
    const cfg = FX_CONFIG.beamsFx;
    for (let i = 0; i < cfg.poolPerKind; i += 1) {
      this.arcbeam.push(this.makeArcbeam());
      this.pulsebeam.push(this.makePulsebeam());
      this.searbeam.push(this.makeSearbeam(sprite));
    }
  }

  spawn(beam: BeamFxId, caster: Vector3, target: Vector3): void {
    switch (beam) {
      case "arcbeam": return this.spawnArcbeam(caster, target);
      case "pulsebeam": return this.spawnPulsebeam(caster, target);
      case "searbeam": return this.spawnSearbeam(caster, target);
    }
  }

  update(dt: number): void {
    if (dt <= 0) return;
    this.updateArcbeam(dt);
    this.updatePulsebeam(dt);
    this.updateSearbeam(dt);
  }

  get activeCount(): number {
    let n = 0;
    const pools: { alive: boolean }[][] = [this.arcbeam, this.pulsebeam, this.searbeam];
    for (const pool of pools) for (const rec of pool) if (rec.alive) n += 1;
    return n;
  }

  dispose(): void {
    for (const rec of this.arcbeam) {
      rec.mat.dispose();
      rec.trunk.geometry.dispose();
      rec.trunk.parent?.remove(rec.trunk);
      for (const f of rec.forks) { f.geometry.dispose(); f.parent?.remove(f); }
    }
    for (const rec of this.pulsebeam) {
      rec.mat.dispose();
      for (const d of rec.dashes) d.parent?.remove(d);
    }
    for (const rec of this.searbeam) {
      rec.coreMat.dispose(); rec.haloMat.dispose(); rec.bloomMat.dispose();
      rec.core.parent?.remove(rec.core);
      rec.halo.parent?.remove(rec.halo);
      rec.bloom.parent?.remove(rec.bloom);
    }
    this.beamGeometry.dispose();
  }

  // ── ARCBEAM — TRUNK+FORK ─────────────────────────────────────────────────

  private makeArcbeam(): ArcbeamRecord {
    const cfg = FX_CONFIG.beamsFx.arcbeam;
    const mat = new LineBasicMaterial({
      color: cfg.color, transparent: true, opacity: 0,
      blending: AdditiveBlending, depthWrite: false, fog: false,
    });
    const trunkArr = new Float32Array(TRUNK_POINTS * 3);
    const trunkGeo = new BufferGeometry();
    trunkGeo.setAttribute("position", new BufferAttribute(trunkArr, 3));
    const trunk = new Line(trunkGeo, mat);
    trunk.renderOrder = RENDER_ORDER;
    trunk.frustumCulled = false;
    trunk.visible = false;
    this.scene.add(trunk);
    const forks: Line<BufferGeometry, LineBasicMaterial>[] = [];
    const forkArrs: Float32Array[] = [];
    for (let i = 0; i < cfg.forks; i += 1) {
      const arr = new Float32Array(FORK_POINTS * 3);
      const geo = new BufferGeometry();
      geo.setAttribute("position", new BufferAttribute(arr, 3));
      const fork = new Line(geo, mat);
      fork.renderOrder = RENDER_ORDER;
      fork.frustumCulled = false;
      fork.visible = false;
      this.scene.add(fork);
      forks.push(fork);
      forkArrs.push(arr);
    }
    return {
      alive: false, age: 0, life: cfg.lifeMs / 1000,
      from: new Vector3(), to: new Vector3(),
      trunk, trunkArr, forks, forkArrs, mat,
    };
  }

  private spawnArcbeam(caster: Vector3, target: Vector3): void {
    const cfg = FX_CONFIG.beamsFx.arcbeam;
    const rec = takeBeam(this.arcbeam, hideArcbeam);
    rec.alive = true;
    rec.age = 0;
    rec.life = cfg.lifeMs / 1000;
    rec.from.set(caster.x, caster.y + MUZZLE_H, caster.z);
    rec.to.set(target.x, target.y + 0.7, target.z);
    rec.trunk.visible = true;
    rec.mat.opacity = 1;
  }

  private updateArcbeam(dt: number): void {
    const cfg = FX_CONFIG.beamsFx.arcbeam;
    for (const rec of this.arcbeam) {
      if (!rec.alive) continue;
      rec.age += dt;
      const t = rec.age / rec.life;
      if (t >= 1) { hideArcbeam(rec); continue; }
      const phase = rec.age * cfg.strobeHz;
      const strobe = phase - Math.floor(phase) < 0.65 ? 1 : 0.25;
      rec.mat.opacity = strobe * (t < 0.85 ? 1 : 1 - (t - 0.85) / 0.15);
      this._dir.subVectors(rec.to, rec.from);
      const len = this._dir.length();
      if (len < 1e-4) continue;
      this._dir.multiplyScalar(1 / len);
      this._perp.set(-this._dir.z, 0, this._dir.x);
      // trunk: single jagged line
      for (let p = 0; p < TRUNK_POINTS; p += 1) {
        const f = p / (TRUNK_POINTS - 1);
        const ends = p === 0 || p === TRUNK_POINTS - 1;
        const jag = ends ? 0 : (Math.random() - 0.5) * cfg.jitter * 2;
        const jagY = ends ? 0 : (Math.random() - 0.5) * cfg.jitter;
        rec.trunkArr[p * 3] = rec.from.x + (rec.to.x - rec.from.x) * f + this._perp.x * jag;
        rec.trunkArr[p * 3 + 1] = rec.from.y + (rec.to.y - rec.from.y) * f + jagY;
        rec.trunkArr[p * 3 + 2] = rec.from.z + (rec.to.z - rec.from.z) * f + this._perp.z * jag;
      }
      (rec.trunk.geometry.getAttribute("position") as BufferAttribute).needsUpdate = true;
      // forks: each anchored at a random trunk fraction, flickering existence
      for (let fi = 0; fi < rec.forks.length; fi += 1) {
        const on = Math.random() < 0.55;
        rec.forks[fi]!.visible = on;
        if (!on) continue;
        const anchorF = 0.2 + Math.random() * 0.6;
        const ax = rec.from.x + (rec.to.x - rec.from.x) * anchorF;
        const ay = rec.from.y + (rec.to.y - rec.from.y) * anchorF;
        const az = rec.from.z + (rec.to.z - rec.from.z) * anchorF;
        const side = Math.random() < 0.5 ? 1 : -1;
        const arr = rec.forkArrs[fi]!;
        for (let p = 0; p < FORK_POINTS; p += 1) {
          const g = p / (FORK_POINTS - 1);
          arr[p * 3] = ax + this._perp.x * side * g * cfg.forkLen + (Math.random() - 0.5) * cfg.jitter;
          arr[p * 3 + 1] = ay + g * 0.2 * (Math.random() - 0.3);
          arr[p * 3 + 2] = az + this._perp.z * side * g * cfg.forkLen + (Math.random() - 0.5) * cfg.jitter;
        }
        (rec.forks[fi]!.geometry.getAttribute("position") as BufferAttribute).needsUpdate = true;
      }
    }
  }

  // ── PULSEBEAM — DASH-TRAIN ───────────────────────────────────────────────

  private makePulsebeam(): PulsebeamRecord {
    const cfg = FX_CONFIG.beamsFx.pulsebeam;
    const mat = new MeshBasicMaterial({
      color: cfg.color, transparent: true, opacity: 0,
      blending: AdditiveBlending, depthWrite: false, fog: false,
    });
    const dashes: Mesh<CylinderGeometry, MeshBasicMaterial>[] = [];
    for (let i = 0; i < cfg.dashes; i += 1) {
      const d = new Mesh(this.beamGeometry, mat);
      d.renderOrder = RENDER_ORDER;
      d.frustumCulled = false;
      d.visible = false;
      this.scene.add(d);
      dashes.push(d);
    }
    return {
      alive: false, age: 0, life: cfg.lifeMs / 1000,
      from: new Vector3(), to: new Vector3(),
      count: cfg.dashes, dashes, mat, seeds: new Float32Array(cfg.dashes),
    };
  }

  private spawnPulsebeam(caster: Vector3, target: Vector3): void {
    const cfg = FX_CONFIG.beamsFx.pulsebeam;
    const rec = takeBeam(this.pulsebeam, hidePulsebeam);
    rec.alive = true;
    rec.age = 0;
    rec.life = cfg.lifeMs / 1000;
    rec.from.set(caster.x, caster.y + MUZZLE_H, caster.z);
    rec.to.set(target.x, target.y + 0.7, target.z);
    for (let i = 0; i < rec.count; i += 1) {
      rec.seeds[i] = i / rec.count;
      rec.dashes[i]!.visible = true;
    }
    rec.mat.opacity = 1;
  }

  private updatePulsebeam(dt: number): void {
    const cfg = FX_CONFIG.beamsFx.pulsebeam;
    for (const rec of this.pulsebeam) {
      if (!rec.alive) continue;
      rec.age += dt;
      const t = rec.age / rec.life;
      if (t >= 1) { hidePulsebeam(rec); continue; }
      rec.mat.opacity = t < 0.8 ? 1 : 1 - (t - 0.8) / 0.2;
      this._dir.subVectors(rec.to, rec.from);
      const len = this._dir.length();
      if (len < 1e-4) continue;
      this._dir.multiplyScalar(1 / len);
      const travel = (rec.age * cfg.speed) / len;
      for (let i = 0; i < rec.count; i += 1) {
        const f = (rec.seeds[i]! + travel) % 1;
        const dash = rec.dashes[i]!;
        this._mid.set(
          rec.from.x + (rec.to.x - rec.from.x) * f,
          rec.from.y + (rec.to.y - rec.from.y) * f,
          rec.from.z + (rec.to.z - rec.from.z) * f,
        );
        dash.position.copy(this._mid);
        dash.quaternion.setFromUnitVectors(Y_AXIS, this._dir);
        dash.scale.set(0.035, cfg.dashLen, 0.035);
      }
    }
  }

  // ── SEARBEAM — LANCE-BLOOM ───────────────────────────────────────────────

  private makeSearbeam(sprite: Texture): SearbeamRecord {
    const cfg = FX_CONFIG.beamsFx.searbeam;
    const coreMat = new MeshBasicMaterial({
      color: cfg.coreColor, transparent: true, opacity: 0,
      blending: AdditiveBlending, depthWrite: false, fog: false,
    });
    const haloMat = new MeshBasicMaterial({
      color: cfg.haloColor, transparent: true, opacity: 0,
      blending: AdditiveBlending, depthWrite: false, fog: false,
    });
    const core = new Mesh(this.beamGeometry, coreMat);
    const halo = new Mesh(this.beamGeometry, haloMat);
    for (const m of [core, halo]) {
      m.renderOrder = RENDER_ORDER;
      m.frustumCulled = false;
      m.visible = false;
      this.scene.add(m);
    }
    const bloomMat = new SpriteMaterial({
      map: sprite, color: cfg.haloColor, transparent: true, opacity: 0,
      blending: AdditiveBlending, depthWrite: false, fog: false,
    });
    const bloom = new Sprite(bloomMat);
    bloom.renderOrder = RENDER_ORDER;
    bloom.frustumCulled = false;
    bloom.visible = false;
    this.scene.add(bloom);
    return {
      alive: false, age: 0, life: cfg.lifeMs / 1000,
      from: new Vector3(), to: new Vector3(),
      core, coreMat, halo, haloMat, bloom, bloomMat,
    };
  }

  private spawnSearbeam(caster: Vector3, target: Vector3): void {
    const cfg = FX_CONFIG.beamsFx.searbeam;
    const rec = takeBeam(this.searbeam, hideSearbeam);
    rec.alive = true;
    rec.age = 0;
    rec.life = cfg.lifeMs / 1000;
    rec.from.set(caster.x, caster.y + MUZZLE_H, caster.z);
    rec.to.set(target.x, target.y + 0.7, target.z);
    this._dir.subVectors(rec.to, rec.from);
    const len = this._dir.length();
    this._mid.copy(rec.from).add(rec.to).multiplyScalar(0.5);
    this._dir.multiplyScalar(1 / Math.max(1e-5, len));
    for (const m of [rec.core, rec.halo]) {
      m.position.copy(this._mid);
      m.quaternion.setFromUnitVectors(Y_AXIS, this._dir);
      m.visible = true;
    }
    rec.core.scale.set(0.03, len, 0.03);
    rec.halo.scale.set(0.09, len, 0.09);
    rec.coreMat.opacity = 1;
    rec.haloMat.opacity = 0.6;
    rec.bloom.position.copy(rec.to);
    rec.bloom.scale.set(cfg.bloomScale * 0.3, cfg.bloomScale * 0.3, cfg.bloomScale * 0.3);
    rec.bloomMat.opacity = 1;
    rec.bloom.visible = true;
  }

  private updateSearbeam(dt: number): void {
    const cfg = FX_CONFIG.beamsFx.searbeam;
    for (const rec of this.searbeam) {
      if (!rec.alive) continue;
      rec.age += dt;
      const t = rec.age / rec.life;
      if (t >= 1) { hideSearbeam(rec); continue; }
      // lance: holds hot briefly, then thins and dies
      const hold = t < 0.3 ? 1 : 1 - (t - 0.3) / 0.7;
      rec.coreMat.opacity = hold;
      rec.haloMat.opacity = 0.6 * hold;
      const thin = 1 - t * 0.7;
      rec.core.scale.x = 0.03 * thin;
      rec.core.scale.z = 0.03 * thin;
      rec.halo.scale.x = 0.09 * thin;
      rec.halo.scale.z = 0.09 * thin;
      // contact bloom grows as the lance dies — energy delivered
      const b = cfg.bloomScale * (0.3 + 0.7 * (1 - (1 - t) * (1 - t)));
      rec.bloom.scale.set(b, b, b);
      rec.bloomMat.opacity = 1 - t * t;
    }
  }
}

// ── shared plumbing ─────────────────────────────────────────────────────────

function takeBeam<T extends { alive: boolean; age: number }>(pool: T[], hide: (rec: T) => void): T {
  let oldest = pool[0]!;
  for (const rec of pool) {
    if (!rec.alive) return rec;
    if (rec.age > oldest.age) oldest = rec;
  }
  hide(oldest);
  return oldest;
}

function hideArcbeam(rec: ArcbeamRecord): void {
  rec.alive = false;
  rec.trunk.visible = false;
  for (const f of rec.forks) f.visible = false;
  rec.mat.opacity = 0;
}

function hidePulsebeam(rec: PulsebeamRecord): void {
  rec.alive = false;
  for (const d of rec.dashes) d.visible = false;
  rec.mat.opacity = 0;
}

function hideSearbeam(rec: SearbeamRecord): void {
  rec.alive = false;
  rec.core.visible = false;
  rec.halo.visible = false;
  rec.coreMat.opacity = 0;
  rec.haloMat.opacity = 0;
  rec.bloom.visible = false;
  rec.bloomMat.opacity = 0;
}
