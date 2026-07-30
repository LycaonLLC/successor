import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Line,
  LineBasicMaterial,
  Mesh,
  MeshBasicMaterial,
  NormalBlending,
  RingGeometry,
  Sprite,
  SpriteMaterial,
  Vector3,
  type Scene,
  type Texture,
} from "three";
import { FX_CONFIG } from "./config";
import type { StatusFx } from "./status";

/**
 * PowersFx — force-power-class effects (owner brief 2026-07-08, hand-authored).
 * Caster/target driven, showcase-first: the mechanics land authoritatively
 * later; the visual language ships now (same doctrine as the hit archetypes).
 *
 *   lightning  BRAID      three crackle lines braided caster→target, strobing
 *                         (discharge doctrine: only electricity is discontinuous)
 *   push       COMPRESS   a ring hurled along the push direction + dust wave
 *   channel    IN-SPIRAL  motes converge to the caster's hands over a ground glyph
 *   healcast   ARC-GIFT   golden motes travel a lofted arc, bigheal blooms on arrival
 *
 * House rules: pooled, zero per-frame alloc, materials at construction,
 * additive + depthWrite off (push's dust wave is NORMAL blend — dust occludes),
 * renderOrder 12. healcast composes with StatusFx for the landing bloom.
 */

export type PowerFxId = "lightning" | "push" | "channel" | "healcast";

export const POWER_FX_IDS: readonly PowerFxId[] = ["lightning", "push", "channel", "healcast"];

const RENDER_ORDER = 12;
const HAND = 0.95;
const LIGHTNING_POINTS = 12;
const LIGHTNING_LINES = 3;

interface LightningRecord {
  alive: boolean;
  age: number;
  life: number;
  from: Vector3;
  to: Vector3;
  lines: Line<BufferGeometry, LineBasicMaterial>[];
  positions: Float32Array[];
  mat: LineBasicMaterial;
  handGlow: Sprite;
  tipFlash: Sprite;
  glowMat: SpriteMaterial;
}

interface PushRecord {
  alive: boolean;
  age: number;
  life: number;
  origin: Vector3;
  dir: Vector3;
  ring: Mesh<RingGeometry, MeshBasicMaterial>;
  ringMat: MeshBasicMaterial;
  dust: Mesh<RingGeometry, MeshBasicMaterial>;
  dustMat: MeshBasicMaterial;
  count: number;
  debris: Sprite[];
  debrisMat: SpriteMaterial;
  seeds: Float32Array;
}

interface ChannelRecord {
  alive: boolean;
  age: number;
  life: number;
  x: number;
  y: number;
  z: number;
  count: number;
  motes: Sprite[];
  moteMat: SpriteMaterial;
  glyph: Mesh<RingGeometry, MeshBasicMaterial>;
  glyphMat: MeshBasicMaterial;
  seeds: Float32Array;
}

interface HealcastRecord {
  alive: boolean;
  age: number;
  life: number;
  from: Vector3;
  to: Vector3;
  count: number;
  motes: Sprite[];
  moteMat: SpriteMaterial;
  seeds: Float32Array;
  bloomed: boolean;
}

export class PowersFx {
  private readonly lightning: LightningRecord[] = [];
  private readonly push: PushRecord[] = [];
  private readonly channel: ChannelRecord[] = [];
  private readonly healcast: HealcastRecord[] = [];
  private readonly ringGeometry = new RingGeometry(0.85, 1.0, 28);
  private readonly _perp = new Vector3();
  private readonly _dir = new Vector3();

  constructor(private readonly scene: Scene, sprite: Texture, private readonly status: StatusFx) {
    const cfg = FX_CONFIG.powersFx;
    for (let i = 0; i < cfg.poolPerKind; i += 1) {
      this.lightning.push(this.makeLightning(sprite));
      this.push.push(this.makePush(sprite));
      this.channel.push(this.makeChannel(sprite));
      this.healcast.push(this.makeHealcast(sprite));
    }
  }

  /** Fire `power` from caster position toward target position (world). */
  spawn(power: PowerFxId, caster: Vector3, target: Vector3): void {
    switch (power) {
      case "lightning": return this.spawnLightning(caster, target);
      case "push": return this.spawnPush(caster, target);
      case "channel": return this.spawnChannel(caster);
      case "healcast": return this.spawnHealcast(caster, target);
    }
  }

  update(dt: number): void {
    if (dt <= 0) return;
    this.updateLightning(dt);
    this.updatePush(dt);
    this.updateChannel(dt);
    this.updateHealcast(dt);
  }

  get activeCount(): number {
    let n = 0;
    const pools: { alive: boolean }[][] = [this.lightning, this.push, this.channel, this.healcast];
    for (const pool of pools) for (const rec of pool) if (rec.alive) n += 1;
    return n;
  }

  dispose(): void {
    for (const rec of this.lightning) {
      rec.mat.dispose();
      rec.glowMat.dispose();
      for (const l of rec.lines) { l.geometry.dispose(); l.parent?.remove(l); }
      rec.handGlow.parent?.remove(rec.handGlow);
      rec.tipFlash.parent?.remove(rec.tipFlash);
    }
    for (const rec of this.push) {
      rec.ringMat.dispose(); rec.dustMat.dispose(); rec.debrisMat.dispose();
      rec.ring.parent?.remove(rec.ring);
      rec.dust.parent?.remove(rec.dust);
      for (const s of rec.debris) s.parent?.remove(s);
    }
    for (const rec of this.channel) {
      rec.moteMat.dispose(); rec.glyphMat.dispose();
      rec.glyph.parent?.remove(rec.glyph);
      for (const s of rec.motes) s.parent?.remove(s);
    }
    for (const rec of this.healcast) {
      rec.moteMat.dispose();
      for (const s of rec.motes) s.parent?.remove(s);
    }
    this.ringGeometry.dispose();
  }

  // ── LIGHTNING — BRAID: three strobing crackle lines caster→target ────────

  private makeLightning(sprite: Texture): LightningRecord {
    const cfg = FX_CONFIG.powersFx.lightning;
    const mat = new LineBasicMaterial({
      color: cfg.color, transparent: true, opacity: 0,
      blending: AdditiveBlending, depthWrite: false, fog: false,
    });
    const lines: Line<BufferGeometry, LineBasicMaterial>[] = [];
    const positions: Float32Array[] = [];
    for (let i = 0; i < LIGHTNING_LINES; i += 1) {
      const arr = new Float32Array(LIGHTNING_POINTS * 3);
      const geo = new BufferGeometry();
      geo.setAttribute("position", new BufferAttribute(arr, 3));
      const line = new Line(geo, mat);
      line.renderOrder = RENDER_ORDER;
      line.frustumCulled = false;
      line.visible = false;
      this.scene.add(line);
      lines.push(line);
      positions.push(arr);
    }
    const glowMat = new SpriteMaterial({
      map: sprite, color: 0xdaf6ff, transparent: true, opacity: 0,
      blending: AdditiveBlending, depthWrite: false, fog: false,
    });
    const handGlow = new Sprite(glowMat);
    const tipFlash = new Sprite(glowMat);
    for (const s of [handGlow, tipFlash]) {
      s.renderOrder = RENDER_ORDER;
      s.frustumCulled = false;
      s.visible = false;
      this.scene.add(s);
    }
    return {
      alive: false, age: 0, life: cfg.lifeMs / 1000,
      from: new Vector3(), to: new Vector3(),
      lines, positions, mat, handGlow, tipFlash, glowMat,
    };
  }

  private spawnLightning(caster: Vector3, target: Vector3): void {
    const cfg = FX_CONFIG.powersFx.lightning;
    const rec = takePower(this.lightning, hideLightning);
    rec.alive = true;
    rec.age = 0;
    rec.life = cfg.lifeMs / 1000;
    rec.from.set(caster.x, caster.y + HAND, caster.z);
    rec.to.set(target.x, target.y + 0.7, target.z);
    for (const l of rec.lines) l.visible = true;
    rec.mat.opacity = 1;
    rec.handGlow.position.copy(rec.from);
    rec.handGlow.scale.set(0.34, 0.34, 0.34);
    rec.handGlow.visible = true;
    rec.tipFlash.position.copy(rec.to);
    rec.tipFlash.scale.set(0.5, 0.5, 0.5);
    rec.tipFlash.visible = true;
    rec.glowMat.opacity = 1;
  }

  private updateLightning(dt: number): void {
    const cfg = FX_CONFIG.powersFx.lightning;
    for (const rec of this.lightning) {
      if (!rec.alive) continue;
      rec.age += dt;
      const t = rec.age / rec.life;
      if (t >= 1) { hideLightning(rec); continue; }
      // discharge doctrine: strobe, never fade smoothly
      const phase = rec.age * cfg.strobeHz;
      const strobe = phase - Math.floor(phase) < 0.6 ? 1 : 0.2;
      rec.mat.opacity = strobe * (t < 0.85 ? 1 : 1 - (t - 0.85) / 0.15);
      rec.glowMat.opacity = rec.mat.opacity;
      // braid: each line snakes around the chord at its own phase
      this._dir.subVectors(rec.to, rec.from);
      const len = this._dir.length();
      if (len < 1e-4) continue;
      this._dir.multiplyScalar(1 / len);
      this._perp.set(-this._dir.z, 0, this._dir.x);
      for (let li = 0; li < rec.lines.length; li += 1) {
        const arr = rec.positions[li]!;
        const linePhase = (li / rec.lines.length) * Math.PI * 2;
        for (let p = 0; p < LIGHTNING_POINTS; p += 1) {
          const f = p / (LIGHTNING_POINTS - 1);
          const bx = rec.from.x + (rec.to.x - rec.from.x) * f;
          const by = rec.from.y + (rec.to.y - rec.from.y) * f;
          const bz = rec.from.z + (rec.to.z - rec.from.z) * f;
          const ends = p === 0 || p === LIGHTNING_POINTS - 1;
          const braid = ends ? 0 : Math.sin(f * Math.PI * 3 + rec.age * 22 + linePhase) * cfg.braidR * Math.sin(f * Math.PI);
          const jag = ends ? 0 : (Math.random() - 0.5) * cfg.jitter;
          const jagY = ends ? 0 : (Math.random() - 0.5) * cfg.jitter * 0.7;
          arr[p * 3] = bx + this._perp.x * (braid + jag);
          arr[p * 3 + 1] = by + jagY;
          arr[p * 3 + 2] = bz + this._perp.z * (braid + jag);
        }
        (rec.lines[li]!.geometry.getAttribute("position") as BufferAttribute).needsUpdate = true;
      }
      const tf = 0.5 * (0.8 + 0.4 * Math.random());
      rec.tipFlash.scale.set(tf, tf, tf);
    }
  }

  // ── PUSH — COMPRESS: a ring hurled along the push direction ──────────────

  private makePush(sprite: Texture): PushRecord {
    const cfg = FX_CONFIG.powersFx.push;
    const ringMat = new MeshBasicMaterial({
      color: cfg.color, transparent: true, opacity: 0,
      blending: AdditiveBlending, depthWrite: false, fog: false,
    });
    const ring = new Mesh(this.ringGeometry, ringMat);
    ring.renderOrder = RENDER_ORDER;
    ring.frustumCulled = false;
    ring.visible = false;
    this.scene.add(ring);
    const dustMat = new MeshBasicMaterial({
      color: 0x6b5233, transparent: true, opacity: 0,
      blending: NormalBlending, depthWrite: false, fog: false,
    });
    const dust = new Mesh(this.ringGeometry, dustMat);
    dust.renderOrder = RENDER_ORDER - 1;
    dust.frustumCulled = false;
    dust.visible = false;
    dust.rotation.x = -Math.PI / 2;
    this.scene.add(dust);
    const debrisMat = new SpriteMaterial({
      map: sprite, color: 0xcdb48f, transparent: true, opacity: 0,
      blending: NormalBlending, depthWrite: false, fog: false,
    });
    const debris: Sprite[] = [];
    for (let i = 0; i < cfg.debris; i += 1) {
      const s = new Sprite(debrisMat);
      s.renderOrder = RENDER_ORDER;
      s.frustumCulled = false;
      s.visible = false;
      this.scene.add(s);
      debris.push(s);
    }
    return {
      alive: false, age: 0, life: cfg.lifeMs / 1000,
      origin: new Vector3(), dir: new Vector3(1, 0, 0),
      ring, ringMat, dust, dustMat,
      count: cfg.debris, debris, debrisMat, seeds: new Float32Array(cfg.debris),
    };
  }

  private spawnPush(caster: Vector3, target: Vector3): void {
    const cfg = FX_CONFIG.powersFx.push;
    const rec = takePower(this.push, hidePush);
    rec.alive = true;
    rec.age = 0;
    rec.life = cfg.lifeMs / 1000;
    rec.origin.set(caster.x, caster.y + 0.7, caster.z);
    rec.dir.set(target.x - caster.x, 0, target.z - caster.z);
    if (rec.dir.lengthSq() < 1e-6) rec.dir.set(1, 0, 0);
    rec.dir.normalize();
    // ring faces the travel direction (vertical hoop flying forward)
    rec.ring.position.copy(rec.origin);
    rec.ring.scale.set(0.3, 0.3, 0.3);
    rec.ring.rotation.set(0, Math.atan2(rec.dir.x, rec.dir.z), 0);
    rec.ringMat.opacity = 0.95;
    rec.ring.visible = true;
    rec.dust.position.set(caster.x, 0.04, caster.z);
    rec.dust.scale.set(0.3, 0.3, 0.3);
    rec.dustMat.opacity = 0.5;
    rec.dust.visible = true;
    for (let i = 0; i < rec.count; i += 1) {
      rec.seeds[i] = Math.random() * Math.PI * 2;
      const s = rec.debris[i]!;
      s.position.set(caster.x, 0.15, caster.z);
      const sc = 0.05 + Math.random() * 0.05;
      s.scale.set(sc, sc, sc);
      s.visible = true;
    }
    rec.debrisMat.opacity = 0.9;
  }

  private updatePush(dt: number): void {
    const cfg = FX_CONFIG.powersFx.push;
    for (const rec of this.push) {
      if (!rec.alive) continue;
      rec.age += dt;
      const t = rec.age / rec.life;
      if (t >= 1) { hidePush(rec); continue; }
      const out = 1 - (1 - t) * (1 - t); // ease-out
      // hoop flies forward, expanding
      const dist = cfg.range * out;
      rec.ring.position.set(rec.origin.x + rec.dir.x * dist, rec.origin.y, rec.origin.z + rec.dir.z * dist);
      const rs = 0.3 + out * 1.1;
      rec.ring.scale.set(rs, rs, rs);
      rec.ringMat.opacity = 0.95 * (1 - t);
      // ground dust blooms behind it
      const ds = 0.3 + out * cfg.range * 0.75;
      rec.dust.scale.set(ds, ds, ds);
      rec.dustMat.opacity = 0.5 * (1 - t);
      // debris hurled in the push cone
      for (let i = 0; i < rec.count; i += 1) {
        const seed = rec.seeds[i]!;
        const spread = ((seed % 1) - 0.5) * 1.1;
        const d = dist * (0.6 + (seed % 0.4));
        rec.debris[i]!.position.set(
          rec.origin.x + rec.dir.x * d - rec.dir.z * spread,
          0.15 + Math.sin(seed + t * 6) * 0.12 + out * 0.25,
          rec.origin.z + rec.dir.z * d + rec.dir.x * spread,
        );
      }
      rec.debrisMat.opacity = 0.9 * (1 - t);
    }
  }

  // ── CHANNEL — IN-SPIRAL: power gathers to the caster's hands ─────────────

  private makeChannel(sprite: Texture): ChannelRecord {
    const cfg = FX_CONFIG.powersFx.channel;
    const moteMat = new SpriteMaterial({
      map: sprite, color: cfg.color, transparent: true, opacity: 0,
      blending: AdditiveBlending, depthWrite: false, fog: false,
    });
    const motes: Sprite[] = [];
    for (let i = 0; i < cfg.motes; i += 1) {
      const s = new Sprite(moteMat);
      s.renderOrder = RENDER_ORDER;
      s.frustumCulled = false;
      s.visible = false;
      this.scene.add(s);
      motes.push(s);
    }
    const glyphMat = new MeshBasicMaterial({
      color: cfg.color, transparent: true, opacity: 0,
      blending: AdditiveBlending, depthWrite: false, fog: false,
    });
    const glyph = new Mesh(this.ringGeometry, glyphMat);
    glyph.renderOrder = RENDER_ORDER - 1;
    glyph.frustumCulled = false;
    glyph.visible = false;
    glyph.rotation.x = -Math.PI / 2;
    this.scene.add(glyph);
    return {
      alive: false, age: 0, life: cfg.lifeMs / 1000, x: 0, y: 0, z: 0,
      count: cfg.motes, motes, moteMat, glyph, glyphMat, seeds: new Float32Array(cfg.motes),
    };
  }

  private spawnChannel(caster: Vector3): void {
    const cfg = FX_CONFIG.powersFx.channel;
    const rec = takePower(this.channel, hideChannel);
    rec.alive = true;
    rec.age = 0;
    rec.life = cfg.lifeMs / 1000;
    rec.x = caster.x; rec.y = caster.y; rec.z = caster.z;
    for (let i = 0; i < rec.count; i += 1) {
      rec.seeds[i] = Math.random() * Math.PI * 2;
      rec.motes[i]!.visible = true;
      const sc = 0.07 + Math.random() * 0.04;
      rec.motes[i]!.scale.set(sc, sc, sc);
    }
    rec.moteMat.opacity = 1;
    rec.glyph.position.set(rec.x, rec.y + 0.05, rec.z);
    rec.glyph.scale.set(0.85, 0.85, 0.85);
    rec.glyphMat.opacity = 0.7;
    rec.glyph.visible = true;
  }

  private updateChannel(dt: number): void {
    for (const rec of this.channel) {
      if (!rec.alive) continue;
      rec.age += dt;
      const t = rec.age / rec.life;
      if (t >= 1) { hideChannel(rec); continue; }
      const fade = t < 0.85 ? 1 : 1 - (t - 0.85) / 0.15;
      rec.moteMat.opacity = fade;
      // glyph breathes
      rec.glyphMat.opacity = 0.7 * fade * (0.75 + 0.25 * Math.sin(rec.age * 5));
      const g = 0.85 * (1 + 0.06 * Math.sin(rec.age * 5));
      rec.glyph.scale.set(g, g, g);
      // motes: repeating in-spiral to the hands
      for (let i = 0; i < rec.count; i += 1) {
        const seed = rec.seeds[i]!;
        const phase = (rec.age * 0.7 + (seed % 1)) % 1;
        const r = 1.25 * (1 - phase);
        const ang = seed + phase * 5;
        rec.motes[i]!.position.set(
          rec.x + Math.cos(ang) * r,
          rec.y + 0.15 + phase * (HAND - 0.15),
          rec.z + Math.sin(ang) * r,
        );
      }
    }
  }

  // ── HEALCAST — ARC-GIFT: golden motes loft to the target, bloom lands ────

  private makeHealcast(sprite: Texture): HealcastRecord {
    const cfg = FX_CONFIG.powersFx.healcast;
    const moteMat = new SpriteMaterial({
      map: sprite, color: cfg.color, transparent: true, opacity: 0,
      blending: AdditiveBlending, depthWrite: false, fog: false,
    });
    const motes: Sprite[] = [];
    for (let i = 0; i < cfg.motes; i += 1) {
      const s = new Sprite(moteMat);
      s.renderOrder = RENDER_ORDER;
      s.frustumCulled = false;
      s.visible = false;
      this.scene.add(s);
      motes.push(s);
    }
    return {
      alive: false, age: 0, life: cfg.lifeMs / 1000,
      from: new Vector3(), to: new Vector3(),
      count: cfg.motes, motes, moteMat, seeds: new Float32Array(cfg.motes), bloomed: false,
    };
  }

  private spawnHealcast(caster: Vector3, target: Vector3): void {
    const cfg = FX_CONFIG.powersFx.healcast;
    const rec = takePower(this.healcast, hideHealcast);
    rec.alive = true;
    rec.age = 0;
    rec.life = cfg.lifeMs / 1000;
    rec.bloomed = false;
    rec.from.set(caster.x, caster.y + HAND, caster.z);
    rec.to.set(target.x, target.y + 0.2, target.z);
    for (let i = 0; i < rec.count; i += 1) {
      rec.seeds[i] = Math.random();
      rec.motes[i]!.visible = true;
      const sc = 0.07 + Math.random() * 0.05;
      rec.motes[i]!.scale.set(sc, sc, sc);
    }
    rec.moteMat.opacity = 1;
  }

  private updateHealcast(dt: number): void {
    const cfg = FX_CONFIG.powersFx.healcast;
    for (const rec of this.healcast) {
      if (!rec.alive) continue;
      rec.age += dt;
      const t = rec.age / rec.life;
      if (t >= 1) { hideHealcast(rec); continue; }
      // motes travel the lofted arc, staggered by seed
      const travelWindow = 0.75; // fraction of life spent traveling
      for (let i = 0; i < rec.count; i += 1) {
        const seed = rec.seeds[i]!;
        const f = Math.max(0, Math.min(1, (t - seed * 0.25) / (travelWindow - 0.0)));
        const bx = rec.from.x + (rec.to.x - rec.from.x) * f;
        const bz = rec.from.z + (rec.to.z - rec.from.z) * f;
        const by = rec.from.y + (rec.to.y - rec.from.y) * f + Math.sin(f * Math.PI) * cfg.arcHeight;
        rec.motes[i]!.position.set(bx, by, bz);
      }
      rec.moteMat.opacity = t < travelWindow ? 1 : Math.max(0, 1 - (t - travelWindow) / (1 - travelWindow));
      // the gift lands: bigheal bloom exactly once when the lead motes arrive
      if (!rec.bloomed && t >= travelWindow * 0.9) {
        rec.bloomed = true;
        this.status.spawn("bigheal", rec.to);
      }
    }
  }
}

// ── shared plumbing ─────────────────────────────────────────────────────────

function takePower<T extends { alive: boolean; age: number }>(pool: T[], hide: (rec: T) => void): T {
  let oldest = pool[0]!;
  for (const rec of pool) {
    if (!rec.alive) return rec;
    if (rec.age > oldest.age) oldest = rec;
  }
  hide(oldest);
  return oldest;
}

function hideLightning(rec: LightningRecord): void {
  rec.alive = false;
  for (const l of rec.lines) l.visible = false;
  rec.mat.opacity = 0;
  rec.handGlow.visible = false;
  rec.tipFlash.visible = false;
  rec.glowMat.opacity = 0;
}

function hidePush(rec: PushRecord): void {
  rec.alive = false;
  rec.ring.visible = false; rec.ringMat.opacity = 0;
  rec.dust.visible = false; rec.dustMat.opacity = 0;
  for (const s of rec.debris) s.visible = false;
  rec.debrisMat.opacity = 0;
}

function hideChannel(rec: ChannelRecord): void {
  rec.alive = false;
  for (const s of rec.motes) s.visible = false;
  rec.moteMat.opacity = 0;
  rec.glyph.visible = false;
  rec.glyphMat.opacity = 0;
}

function hideHealcast(rec: HealcastRecord): void {
  rec.alive = false;
  for (const s of rec.motes) s.visible = false;
  rec.moteMat.opacity = 0;
}
