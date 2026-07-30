import {
  AdditiveBlending,
  CylinderGeometry,
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

/**
 * StatusFx — the state-effect language (owner brief 2026-07-08, hand-authored).
 *
 * One transient per status LANDING, popped at the afflicted pawn. Identity
 * doctrine (from the hit archetypes): each status owns ONE motion verb that
 * nothing else uses —
 *   blind      IRIS        veil flash + a bright ring contracting to nothing
 *   bleed      ARTERIAL    directional spurt jets arcing under gravity
 *   poison     RISE-BUBBLE motes bubble upward with wobble, pop at apex
 *   disease    SWARM       erratic jittered orbit of dark spores
 *   burning    LICK        flame tongues climbing and flickering
 *   intimidate SLAM-RADIAL dark ground shock ring + chest flash (only DARK one)
 *   hot        DRIFT-UP    calm sparkles spiraling gently up (long, soft)
 *   bigheal    PILLAR-BLOOM golden light pillar + feet ring + rising sparkles
 *   stim       VITALS-SURGE clinical ring snap + rising tick blips (secular heal)
 *   spicerush  SNAP-SATURATE double ring pulse + speed streaks (the upper)
 *   spicehaze  WOBBLE-ORBIT  lazy lissajous motes + breathing halo (the trip)
 *   spicecrash DRAIN-DOWN    grey motes sinking + slumping feet ring (comedown)
 *
 * House rules: pooled records, zero per-frame allocation, materials built at
 * construction, additive + depthWrite off (intimidate's shock ring is the one
 * sanctioned NORMAL-blend piece — darkness must occlude), renderOrder 12.
 * Colors are inherent per status; real dispatch keys off authority statuses
 * where they exist (bleed today), the FX LAB drives the rest until their
 * mechanics land authoritatively.
 */

export type StatusFxId =
  | "blind"
  | "bleed"
  | "poison"
  | "disease"
  | "burning"
  | "intimidate"
  | "hot"
  | "bigheal"
  | "stim"
  | "spicerush"
  | "spicehaze"
  | "spicecrash";

export const STATUS_FX_IDS: readonly StatusFxId[] = [
  "blind",
  "bleed",
  "poison",
  "disease",
  "burning",
  "intimidate",
  "hot",
  "bigheal",
  "stim",
  "spicerush",
  "spicehaze",
  "spicecrash",
];

interface BlindRecord {
  alive: boolean;
  age: number;
  life: number;
  veil: Sprite;
  veilMat: SpriteMaterial;
  iris: Mesh<RingGeometry, MeshBasicMaterial>;
  irisMat: MeshBasicMaterial;
}

interface BleedRecord {
  alive: boolean;
  age: number;
  life: number;
  count: number;
  sprites: Sprite[];
  mat: SpriteMaterial;
  vx: Float32Array;
  vy: Float32Array;
  vz: Float32Array;
}

interface MoteRecord {
  alive: boolean;
  age: number;
  life: number;
  count: number;
  sprites: Sprite[];
  mat: SpriteMaterial;
  x: number;
  y: number;
  z: number;
  seeds: Float32Array;
}

interface BurnRecord {
  alive: boolean;
  age: number;
  life: number;
  count: number;
  tongues: Sprite[];
  mat: SpriteMaterial;
  x: number;
  y: number;
  z: number;
  seeds: Float32Array;
}

interface IntimidateRecord {
  alive: boolean;
  age: number;
  life: number;
  ring: Mesh<RingGeometry, MeshBasicMaterial>;
  ringMat: MeshBasicMaterial;
  flash: Sprite;
  flashMat: SpriteMaterial;
}

interface StimRecord {
  alive: boolean;
  age: number;
  life: number;
  ring: Mesh<RingGeometry, MeshBasicMaterial>;
  ringMat: MeshBasicMaterial;
  count: number;
  ticks: Sprite[];
  tickMat: SpriteMaterial;
  seeds: Float32Array;
}

interface RushRecord {
  alive: boolean;
  age: number;
  life: number;
  x: number;
  y: number;
  z: number;
  rings: Mesh<RingGeometry, MeshBasicMaterial>[];
  ringMat: MeshBasicMaterial;
  count: number;
  streaks: Sprite[];
  streakMat: SpriteMaterial;
  seeds: Float32Array;
}

interface PillarRecord {
  alive: boolean;
  age: number;
  life: number;
  pillar: Mesh<CylinderGeometry, MeshBasicMaterial>;
  pillarMat: MeshBasicMaterial;
  ring: Mesh<RingGeometry, MeshBasicMaterial>;
  ringMat: MeshBasicMaterial;
  count: number;
  sparkles: Sprite[];
  sparkleMat: SpriteMaterial;
  seeds: Float32Array;
}

const RENDER_ORDER = 12;
const CHEST = 0.85;
const HEAD = 1.45;

export class StatusFx {
  private readonly blind: BlindRecord[] = [];
  private readonly bleed: BleedRecord[] = [];
  private readonly poison: MoteRecord[] = [];
  private readonly disease: MoteRecord[] = [];
  private readonly burning: BurnRecord[] = [];
  private readonly intimidate: IntimidateRecord[] = [];
  private readonly hot: MoteRecord[] = [];
  private readonly bigheal: PillarRecord[] = [];
  private readonly stim: StimRecord[] = [];
  private readonly spicerush: RushRecord[] = [];
  private readonly spicehaze: MoteRecord[] = [];
  private readonly spicecrash: MoteRecord[] = [];
  private readonly ringGeometry = new RingGeometry(0.82, 1.0, 28);
  private readonly pillarGeometry = new CylinderGeometry(1, 1, 1, 10, 1, true);

  constructor(private readonly scene: Scene, sprite: Texture) {
    const cfg = FX_CONFIG.statusFx;
    for (let i = 0; i < cfg.poolPerKind; i += 1) {
      this.blind.push(this.makeBlind(sprite));
      this.bleed.push(this.makeBleed(sprite));
      this.poison.push(this.makeMotes(sprite, cfg.poison.motes, cfg.poison.color));
      this.disease.push(this.makeMotes(sprite, cfg.disease.spores, cfg.disease.color));
      this.burning.push(this.makeBurn(sprite));
      this.intimidate.push(this.makeIntimidate(sprite));
      this.hot.push(this.makeMotes(sprite, cfg.hot.sparkles, cfg.hot.color));
      this.bigheal.push(this.makePillar(sprite));
      this.stim.push(this.makeStim(sprite));
      this.spicerush.push(this.makeRush(sprite));
      this.spicehaze.push(this.makeMotes(sprite, cfg.spicehaze.motes, cfg.spicehaze.color));
      this.spicecrash.push(this.makeMotes(sprite, cfg.spicecrash.motes, cfg.spicecrash.color));
    }
  }

  /** Pop `status` on a pawn at `point` (feet-origin cell center). */
  spawn(status: StatusFxId, point: Vector3): void {
    switch (status) {
      case "blind": return this.spawnBlind(point);
      case "bleed": return this.spawnBleed(point);
      case "poison": return this.spawnMotes(this.poison, FX_CONFIG.statusFx.poison.lifeMs, point);
      case "disease": return this.spawnMotes(this.disease, FX_CONFIG.statusFx.disease.lifeMs, point);
      case "burning": return this.spawnBurn(point);
      case "intimidate": return this.spawnIntimidate(point);
      case "hot": return this.spawnMotes(this.hot, FX_CONFIG.statusFx.hot.lifeMs, point);
      case "bigheal": return this.spawnPillar(point);
      case "stim": return this.spawnStim(point);
      case "spicerush": return this.spawnRush(point);
      case "spicehaze": return this.spawnMotes(this.spicehaze, FX_CONFIG.statusFx.spicehaze.lifeMs, point);
      case "spicecrash": return this.spawnMotes(this.spicecrash, FX_CONFIG.statusFx.spicecrash.lifeMs, point);
    }
  }

  update(dt: number): void {
    if (dt <= 0) return;
    this.updateBlind(dt);
    this.updateBleed(dt);
    this.updatePoison(dt);
    this.updateDisease(dt);
    this.updateBurn(dt);
    this.updateIntimidate(dt);
    this.updateHot(dt);
    this.updatePillar(dt);
    this.updateStim(dt);
    this.updateRush(dt);
    this.updateHaze(dt);
    this.updateCrash(dt);
  }

  get activeCount(): number {
    let n = 0;
    const pools: { alive: boolean }[][] = [
      this.blind, this.bleed, this.poison, this.disease,
      this.burning, this.intimidate, this.hot, this.bigheal,
      this.stim, this.spicerush, this.spicehaze, this.spicecrash,
    ];
    for (const pool of pools) for (const rec of pool) if (rec.alive) n += 1;
    return n;
  }

  dispose(): void {
    for (const rec of this.blind) {
      rec.veilMat.dispose(); rec.irisMat.dispose();
      rec.veil.parent?.remove(rec.veil); rec.iris.parent?.remove(rec.iris);
    }
    for (const rec of this.bleed) {
      rec.mat.dispose();
      for (const s of rec.sprites) s.parent?.remove(s);
    }
    for (const pool of [this.poison, this.disease, this.hot]) {
      for (const rec of pool) {
        rec.mat.dispose();
        for (const s of rec.sprites) s.parent?.remove(s);
      }
    }
    for (const rec of this.burning) {
      rec.mat.dispose();
      for (const s of rec.tongues) s.parent?.remove(s);
    }
    for (const rec of this.intimidate) {
      rec.ringMat.dispose(); rec.flashMat.dispose();
      rec.ring.parent?.remove(rec.ring); rec.flash.parent?.remove(rec.flash);
    }
    for (const rec of this.bigheal) {
      rec.pillarMat.dispose(); rec.ringMat.dispose(); rec.sparkleMat.dispose();
      rec.pillar.parent?.remove(rec.pillar); rec.ring.parent?.remove(rec.ring);
      for (const s of rec.sparkles) s.parent?.remove(s);
    }
    for (const rec of this.stim) {
      rec.ringMat.dispose(); rec.tickMat.dispose();
      rec.ring.parent?.remove(rec.ring);
      for (const t of rec.ticks) t.parent?.remove(t);
    }
    for (const rec of this.spicerush) {
      rec.ringMat.dispose(); rec.streakMat.dispose();
      for (const r of rec.rings) r.parent?.remove(r);
      for (const st of rec.streaks) st.parent?.remove(st);
    }
    for (const pool of [this.spicehaze, this.spicecrash]) {
      for (const rec of pool) {
        rec.mat.dispose();
        for (const s of rec.sprites) s.parent?.remove(s);
      }
    }
    this.ringGeometry.dispose();
    this.pillarGeometry.dispose();
  }

  // ── BLIND — IRIS: veil flash at the eyes, ring contracts to nothing ──────

  private makeBlind(sprite: Texture): BlindRecord {
    const cfg = FX_CONFIG.statusFx.blind;
    const veilMat = spriteMat(sprite);
    const veil = new Sprite(veilMat);
    prepFx(veil);
    this.scene.add(veil);
    const irisMat = ringMat();
    const iris = new Mesh(this.ringGeometry, irisMat);
    prepFx(iris);
    iris.rotation.x = -Math.PI / 2;
    this.scene.add(iris);
    veilMat.color.setHex(cfg.color);
    irisMat.color.setHex(cfg.color);
    return { alive: false, age: 0, life: cfg.lifeMs / 1000, veil, veilMat, iris, irisMat };
  }

  private spawnBlind(point: Vector3): void {
    const cfg = FX_CONFIG.statusFx.blind;
    const rec = take(this.blind, hideBlind);
    rec.alive = true;
    rec.age = 0;
    rec.life = cfg.lifeMs / 1000;
    rec.veil.position.set(point.x, point.y + HEAD, point.z);
    rec.veil.scale.set(cfg.veilScale, cfg.veilScale, cfg.veilScale);
    rec.veilMat.opacity = 1;
    rec.veil.visible = true;
    rec.iris.position.set(point.x, point.y + HEAD, point.z);
    rec.iris.rotation.x = 0; // camera-ish facing: leave vertical, reads as a halo
    rec.iris.scale.set(cfg.irisStart, cfg.irisStart, cfg.irisStart);
    rec.irisMat.opacity = 0.9;
    rec.iris.visible = true;
  }

  private updateBlind(dt: number): void {
    for (const rec of this.blind) {
      if (!rec.alive) continue;
      rec.age += dt;
      const t = rec.age / rec.life;
      if (t >= 1) { hideBlind(rec); continue; }
      // veil: hot flash, fast decay
      rec.veilMat.opacity = Math.max(0, 1 - t * 2.2);
      const v = FX_CONFIG.statusFx.blind.veilScale * (1 + t * 0.5);
      rec.veil.scale.set(v, v, v);
      // iris: contract to nothing over the full life — the world "closing"
      const irisS = FX_CONFIG.statusFx.blind.irisStart * (1 - t * t);
      rec.iris.scale.set(Math.max(0.01, irisS), Math.max(0.01, irisS), Math.max(0.01, irisS));
      rec.irisMat.opacity = 0.9 * (1 - t * 0.4);
    }
  }

  // ── BLEED — ARTERIAL: directional spurt jets under gravity ───────────────

  private makeBleed(sprite: Texture): BleedRecord {
    const cfg = FX_CONFIG.statusFx.bleed;
    const mat = spriteMat(sprite, NormalBlending);
    mat.color.setHex(cfg.color);
    const n = cfg.jets * cfg.dropsPerJet;
    const sprites: Sprite[] = [];
    for (let i = 0; i < n; i += 1) {
      const s = new Sprite(mat);
      prepFx(s);
      this.scene.add(s);
      sprites.push(s);
    }
    return {
      alive: false, age: 0, life: cfg.lifeMs / 1000, count: n, sprites, mat,
      vx: new Float32Array(n), vy: new Float32Array(n), vz: new Float32Array(n),
    };
  }

  private spawnBleed(point: Vector3): void {
    const cfg = FX_CONFIG.statusFx.bleed;
    const rec = take(this.bleed, hideSprites);
    rec.alive = true;
    rec.age = 0;
    rec.life = cfg.lifeMs / 1000;
    let i = 0;
    for (let j = 0; j < cfg.jets; j += 1) {
      // each jet gets one arterial direction; drops fan tightly around it
      const az = Math.random() * Math.PI * 2;
      const up = 0.55 + Math.random() * 0.5;
      for (let d = 0; d < cfg.dropsPerJet; d += 1, i += 1) {
        const sp = cfg.speed * (0.55 + 0.45 * (d / cfg.dropsPerJet)) * (0.85 + Math.random() * 0.3);
        rec.vx[i] = (Math.cos(az) + (Math.random() - 0.5) * 0.25) * sp;
        rec.vy[i] = up * sp;
        rec.vz[i] = (Math.sin(az) + (Math.random() - 0.5) * 0.25) * sp;
        const s = rec.sprites[i]!;
        s.position.set(point.x, point.y + CHEST, point.z);
        const sc = 0.05 + Math.random() * 0.04;
        s.scale.set(sc, sc, sc);
        s.visible = true;
      }
    }
    rec.mat.opacity = 1;
  }

  private updateBleed(dt: number): void {
    const g = FX_CONFIG.statusFx.bleed.gravity;
    for (const rec of this.bleed) {
      if (!rec.alive) continue;
      rec.age += dt;
      const t = rec.age / rec.life;
      if (t >= 1) { hideSprites(rec); continue; }
      rec.mat.opacity = 1 - t * t;
      for (let i = 0; i < rec.count; i += 1) {
        const s = rec.sprites[i]!;
        s.position.x += rec.vx[i]! * dt;
        s.position.y += rec.vy[i]! * dt;
        s.position.z += rec.vz[i]! * dt;
        rec.vy[i] = rec.vy[i]! - g * dt;
        if (s.position.y < 0.03) { s.position.y = 0.03; rec.vx[i] = 0; rec.vy[i] = 0; rec.vz[i] = 0; }
      }
    }
  }

  // ── POISON / DISEASE / HOT — shared mote machinery, distinct verbs ───────

  private makeMotes(sprite: Texture, count: number, color: number): MoteRecord {
    const mat = spriteMat(sprite);
    mat.color.setHex(color);
    const sprites: Sprite[] = [];
    for (let i = 0; i < count; i += 1) {
      const s = new Sprite(mat);
      prepFx(s);
      this.scene.add(s);
      sprites.push(s);
    }
    return {
      alive: false, age: 0, life: 1, count, sprites, mat,
      x: 0, y: 0, z: 0, seeds: new Float32Array(count),
    };
  }

  private spawnMotes(pool: MoteRecord[], lifeMs: number, point: Vector3): void {
    const rec = take(pool, hideSprites);
    rec.alive = true;
    rec.age = 0;
    rec.life = lifeMs / 1000;
    rec.x = point.x; rec.y = point.y; rec.z = point.z;
    for (let i = 0; i < rec.count; i += 1) {
      rec.seeds[i] = Math.random() * Math.PI * 2;
      const s = rec.sprites[i]!;
      s.visible = true;
      const sc = 0.075 + Math.random() * 0.05;
      s.scale.set(sc, sc, sc);
    }
    rec.mat.opacity = 1;
  }

  private updatePoison(dt: number): void {
    // RISE-BUBBLE: wobbling ascent, pop (scale-out) near apex.
    const cfg = FX_CONFIG.statusFx.poison;
    for (const rec of this.poison) {
      if (!rec.alive) continue;
      rec.age += dt;
      const t = rec.age / rec.life;
      if (t >= 1) { hideSprites(rec); continue; }
      rec.mat.opacity = t < 0.8 ? 0.95 : 0.95 * (1 - (t - 0.8) / 0.2);
      for (let i = 0; i < rec.count; i += 1) {
        const seed = rec.seeds[i]!;
        const phase = (t + (seed % 1)) % 1;
        const y = rec.y + 0.15 + phase * (CHEST + 0.6);
        const wob = Math.sin(rec.age * cfg.wobbleHz * Math.PI * 2 + seed) * 0.12;
        const az = seed + phase * 0.8;
        rec.sprites[i]!.position.set(rec.x + Math.cos(az) * (0.22 + wob), y, rec.z + Math.sin(az) * (0.22 - wob));
        const pop = phase > 0.92 ? 1 + (phase - 0.92) * 6 : 1;
        const base = 0.07 * pop;
        rec.sprites[i]!.scale.set(base, base, base);
      }
    }
  }

  private updateDisease(dt: number): void {
    // SWARM: erratic jittered orbit — organic, uncomfortable.
    const cfg = FX_CONFIG.statusFx.disease;
    for (const rec of this.disease) {
      if (!rec.alive) continue;
      rec.age += dt;
      const t = rec.age / rec.life;
      if (t >= 1) { hideSprites(rec); continue; }
      rec.mat.opacity = 0.85 * (t < 0.85 ? 1 : 1 - (t - 0.85) / 0.15);
      for (let i = 0; i < rec.count; i += 1) {
        const seed = rec.seeds[i]!;
        const ang = seed + rec.age * (1.6 + (seed % 0.9));
        const jitter = (Math.random() - 0.5) * cfg.jitter;
        const r = cfg.orbitR + Math.sin(rec.age * 3.1 + seed * 7) * 0.09 + jitter;
        const y = rec.y + 0.5 + Math.sin(rec.age * 2.3 + seed * 3) * 0.35 + 0.35;
        rec.sprites[i]!.position.set(rec.x + Math.cos(ang) * r, y, rec.z + Math.sin(ang) * r);
      }
    }
  }

  private updateHot(dt: number): void {
    // DRIFT-UP: the calm one — slow spiral ascent, no jitter, long life.
    const cfg = FX_CONFIG.statusFx.hot;
    for (const rec of this.hot) {
      if (!rec.alive) continue;
      rec.age += dt;
      const t = rec.age / rec.life;
      if (t >= 1) { hideSprites(rec); continue; }
      rec.mat.opacity = 0.9 * (t < 0.75 ? 1 : 1 - (t - 0.75) / 0.25);
      for (let i = 0; i < rec.count; i += 1) {
        const seed = rec.seeds[i]!;
        const phase = (t * 1.4 + (seed % 1)) % 1;
        const y = rec.y + 0.1 + phase * (HEAD + 0.35);
        const ang = seed + phase * 2.4;
        const r = 0.3 * (1 - phase * 0.4);
        rec.sprites[i]!.position.set(rec.x + Math.cos(ang) * r, y, rec.z + Math.sin(ang) * r);
      }
    }
  }

  // ── BURNING — LICK: flame tongues climb and flicker ─────────────────────

  private makeBurn(sprite: Texture): BurnRecord {
    const cfg = FX_CONFIG.statusFx.burning;
    const mat = spriteMat(sprite);
    mat.color.setHex(cfg.color);
    const tongues: Sprite[] = [];
    for (let i = 0; i < cfg.tongues; i += 1) {
      const s = new Sprite(mat);
      prepFx(s);
      this.scene.add(s);
      tongues.push(s);
    }
    return { alive: false, age: 0, life: cfg.lifeMs / 1000, count: cfg.tongues, tongues, mat, x: 0, y: 0, z: 0, seeds: new Float32Array(cfg.tongues) };
  }

  private spawnBurn(point: Vector3): void {
    const cfg = FX_CONFIG.statusFx.burning;
    const rec = take(this.burning, hideBurn);
    rec.alive = true;
    rec.age = 0;
    rec.life = cfg.lifeMs / 1000;
    rec.x = point.x; rec.y = point.y; rec.z = point.z;
    for (let i = 0; i < rec.count; i += 1) {
      rec.seeds[i] = Math.random() * Math.PI * 2;
      rec.tongues[i]!.visible = true;
    }
    rec.mat.opacity = 1;
  }

  private updateBurn(dt: number): void {
    const cfg = FX_CONFIG.statusFx.burning;
    for (const rec of this.burning) {
      if (!rec.alive) continue;
      rec.age += dt;
      const t = rec.age / rec.life;
      if (t >= 1) { hideBurn(rec); continue; }
      rec.mat.opacity = (t < 0.8 ? 1 : 1 - (t - 0.8) / 0.2) * (0.85 + 0.15 * Math.sin(rec.age * cfg.flickerHz * 2));
      for (let i = 0; i < rec.count; i += 1) {
        const seed = rec.seeds[i]!;
        const phase = (rec.age * (0.9 + (seed % 0.5)) + seed) % 1;
        const y = rec.y + 0.12 + phase * cfg.height;
        const ang = seed + Math.sin(rec.age * 4 + seed) * 0.4;
        const flick = 0.5 + 0.5 * Math.sin(rec.age * cfg.flickerHz * Math.PI + seed * 9);
        // tongue: tall thin sprite, squashes as it tops out
        const w = 0.15 * (1 - phase * 0.45) * (0.7 + 0.3 * flick);
        const h = 0.42 * (1 - phase * 0.5);
        rec.tongues[i]!.position.set(rec.x + Math.cos(ang) * 0.18, y, rec.z + Math.sin(ang) * 0.18);
        rec.tongues[i]!.scale.set(w, h, w);
      }
    }
  }

  // ── INTIMIDATE — SLAM-RADIAL: the only dark one; fear occludes ───────────

  private makeIntimidate(sprite: Texture): IntimidateRecord {
    const cfg = FX_CONFIG.statusFx.intimidate;
    const ringMaterial = ringMat(NormalBlending);
    ringMaterial.color.setHex(0x14040a); // near-black core color — darkness
    const ring = new Mesh(this.ringGeometry, ringMaterial);
    prepFx(ring);
    ring.rotation.x = -Math.PI / 2;
    this.scene.add(ring);
    const flashMat = spriteMat(sprite);
    flashMat.color.setHex(cfg.color);
    const flash = new Sprite(flashMat);
    prepFx(flash);
    this.scene.add(flash);
    return { alive: false, age: 0, life: cfg.lifeMs / 1000, ring, ringMat: ringMaterial, flash, flashMat };
  }

  private spawnIntimidate(point: Vector3): void {
    const cfg = FX_CONFIG.statusFx.intimidate;
    const rec = take(this.intimidate, hideIntimidate);
    rec.alive = true;
    rec.age = 0;
    rec.life = cfg.lifeMs / 1000;
    rec.ring.position.set(point.x, point.y + 0.04, point.z);
    rec.ring.scale.set(0.2, 0.2, 0.2);
    rec.ringMat.opacity = 0.85;
    rec.ring.visible = true;
    rec.flash.position.set(point.x, point.y + CHEST, point.z);
    rec.flash.scale.set(cfg.flashScale, cfg.flashScale, cfg.flashScale);
    rec.flashMat.opacity = 1;
    rec.flash.visible = true;
  }

  private updateIntimidate(dt: number): void {
    const cfg = FX_CONFIG.statusFx.intimidate;
    for (const rec of this.intimidate) {
      if (!rec.alive) continue;
      rec.age += dt;
      const t = rec.age / rec.life;
      if (t >= 1) { hideIntimidate(rec); continue; }
      const r = 0.2 + (cfg.ringEnd - 0.2) * easeOutCubic(t);
      rec.ring.scale.set(r, r, r);
      rec.ringMat.opacity = 0.85 * (1 - t);
      rec.flashMat.opacity = Math.max(0, 1 - t * 2.6);
      const f = cfg.flashScale * (1 + t * 0.8);
      rec.flash.scale.set(f, f, f);
    }
  }

  // ── BIGHEAL — PILLAR-BLOOM: the celebration ──────────────────────────────

  private makePillar(sprite: Texture): PillarRecord {
    const cfg = FX_CONFIG.statusFx.bigheal;
    const pillarMat = new MeshBasicMaterial({
      color: cfg.color, transparent: true, opacity: 0,
      blending: AdditiveBlending, depthWrite: false, fog: false,
    });
    const pillar = new Mesh(this.pillarGeometry, pillarMat);
    prepFx(pillar);
    this.scene.add(pillar);
    const ringMaterial = ringMat();
    ringMaterial.color.setHex(cfg.color);
    const ring = new Mesh(this.ringGeometry, ringMaterial);
    prepFx(ring);
    ring.rotation.x = -Math.PI / 2;
    this.scene.add(ring);
    const sparkleMat = spriteMat(sprite);
    sparkleMat.color.setHex(0xfff3d0);
    const sparkles: Sprite[] = [];
    for (let i = 0; i < cfg.sparkles; i += 1) {
      const s = new Sprite(sparkleMat);
      prepFx(s);
      this.scene.add(s);
      sparkles.push(s);
    }
    return {
      alive: false, age: 0, life: cfg.lifeMs / 1000,
      pillar, pillarMat, ring, ringMat: ringMaterial,
      count: cfg.sparkles, sparkles, sparkleMat, seeds: new Float32Array(cfg.sparkles),
    };
  }

  private spawnPillar(point: Vector3): void {
    const cfg = FX_CONFIG.statusFx.bigheal;
    const rec = take(this.bigheal, hidePillar);
    rec.alive = true;
    rec.age = 0;
    rec.life = cfg.lifeMs / 1000;
    rec.pillar.position.set(point.x, point.y + cfg.pillarHeight * 0.5, point.z);
    rec.pillar.scale.set(0.22, cfg.pillarHeight, 0.22);
    rec.pillarMat.opacity = 0.9;
    rec.pillar.visible = true;
    rec.ring.position.set(point.x, point.y + 0.05, point.z);
    rec.ring.scale.set(0.15, 0.15, 0.15);
    rec.ringMat.opacity = 1;
    rec.ring.visible = true;
    for (let i = 0; i < rec.count; i += 1) {
      rec.seeds[i] = Math.random() * Math.PI * 2;
      rec.sparkles[i]!.visible = true;
      rec.sparkles[i]!.scale.set(0.08, 0.08, 0.08);
    }
    rec.sparkleMat.opacity = 1;
  }

  private updatePillar(dt: number): void {
    const cfg = FX_CONFIG.statusFx.bigheal;
    for (const rec of this.bigheal) {
      if (!rec.alive) continue;
      rec.age += dt;
      const t = rec.age / rec.life;
      if (t >= 1) { hidePillar(rec); continue; }
      // pillar: bright arrival, narrowing as it fades skyward
      rec.pillarMat.opacity = 0.9 * (1 - t * t);
      const pw = 0.22 * (1 - t * 0.55);
      rec.pillar.scale.set(pw, cfg.pillarHeight, pw);
      // feet ring: blooms out once
      const r = 0.15 + (cfg.ringEnd - 0.15) * easeOutCubic(Math.min(1, t * 1.6));
      rec.ring.scale.set(r, r, r);
      rec.ringMat.opacity = Math.max(0, 1 - t * 1.4);
      // sparkles rise inside the pillar
      rec.sparkleMat.opacity = t < 0.7 ? 1 : 1 - (t - 0.7) / 0.3;
      for (let i = 0; i < rec.count; i += 1) {
        const seed = rec.seeds[i]!;
        const phase = (t * 1.3 + (seed % 1)) % 1;
        const ang = seed + phase * 3;
        const rr = 0.16 * (1 - phase * 0.3);
        rec.sparkles[i]!.position.set(
          rec.pillar.position.x + Math.cos(ang) * rr,
          rec.ring.position.y + 0.1 + phase * (cfg.pillarHeight * 0.8),
          rec.pillar.position.z + Math.sin(ang) * rr,
        );
      }
    }
  }
  // ── STIM — VITALS-SURGE: the secular heal; clinical, brisk, no ceremony ──

  private makeStim(sprite: Texture): StimRecord {
    const cfg = FX_CONFIG.statusFx.stim;
    const ringMaterial = ringMat();
    ringMaterial.color.setHex(cfg.color);
    const ring = new Mesh(this.ringGeometry, ringMaterial);
    prepFx(ring);
    this.scene.add(ring);
    const tickMat = spriteMat(sprite);
    tickMat.color.setHex(0xeafff6);
    const ticks: Sprite[] = [];
    for (let i = 0; i < cfg.ticks; i += 1) {
      const t = new Sprite(tickMat);
      prepFx(t);
      this.scene.add(t);
      ticks.push(t);
    }
    return { alive: false, age: 0, life: cfg.lifeMs / 1000, ring, ringMat: ringMaterial, count: cfg.ticks, ticks, tickMat, seeds: new Float32Array(cfg.ticks) };
  }

  private spawnStim(point: Vector3): void {
    const cfg = FX_CONFIG.statusFx.stim;
    const rec = take(this.stim, hideStim);
    rec.alive = true;
    rec.age = 0;
    rec.life = cfg.lifeMs / 1000;
    rec.ring.position.set(point.x, point.y + CHEST, point.z);
    rec.ring.rotation.x = 0; // vertical halo at the chest — the injector snap
    rec.ring.scale.set(cfg.ringScale * 0.4, cfg.ringScale * 0.4, cfg.ringScale * 0.4);
    rec.ringMat.opacity = 1;
    rec.ring.visible = true;
    for (let i = 0; i < rec.count; i += 1) {
      rec.seeds[i] = i / rec.count + Math.random() * 0.06;
      const t = rec.ticks[i]!;
      // vitals blips: thin vertical ticks (tall narrow sprites)
      t.scale.set(0.035, 0.14, 0.035);
      t.visible = true;
    }
    rec.tickMat.opacity = 1;
  }

  private updateStim(dt: number): void {
    const cfg = FX_CONFIG.statusFx.stim;
    for (const rec of this.stim) {
      if (!rec.alive) continue;
      rec.age += dt;
      const t = rec.age / rec.life;
      if (t >= 1) { hideStim(rec); continue; }
      // ring: one clinical snap out, quick fade — no lingering ceremony
      const rs = cfg.ringScale * (0.4 + 0.6 * (1 - (1 - Math.min(1, t * 2.2)) ** 3));
      rec.ring.scale.set(rs, rs, rs);
      rec.ringMat.opacity = Math.max(0, 1 - t * 1.8);
      // ticks: staggered vitals blips climbing a short column beside the pawn
      for (let i = 0; i < rec.count; i += 1) {
        const phase = Math.max(0, Math.min(1, (t - rec.seeds[i]! * 0.4) * 2.2));
        const tick = rec.ticks[i]!;
        tick.position.set(
          rec.ring.position.x + 0.34,
          rec.ring.position.y - 0.3 + phase * 0.85,
          rec.ring.position.z,
        );
        tick.visible = phase > 0 && phase < 1;
      }
      rec.tickMat.opacity = t < 0.7 ? 1 : 1 - (t - 0.7) / 0.3;
    }
  }

  // ── SPICERUSH — SNAP-SATURATE: the upper kicks in ────────────────────────

  private makeRush(sprite: Texture): RushRecord {
    const cfg = FX_CONFIG.statusFx.spicerush;
    const ringMaterial = ringMat();
    ringMaterial.color.setHex(cfg.color);
    const rings: Mesh<RingGeometry, MeshBasicMaterial>[] = [];
    for (let i = 0; i < cfg.rings; i += 1) {
      const r = new Mesh(this.ringGeometry, ringMaterial);
      prepFx(r);
      r.rotation.x = -Math.PI / 2;
      this.scene.add(r);
      rings.push(r);
    }
    const streakMat = spriteMat(sprite);
    streakMat.color.setHex(cfg.color);
    const streaks: Sprite[] = [];
    for (let i = 0; i < cfg.streaks; i += 1) {
      const st = new Sprite(streakMat);
      prepFx(st);
      this.scene.add(st);
      streaks.push(st);
    }
    return { alive: false, age: 0, life: cfg.lifeMs / 1000, x: 0, y: 0, z: 0, rings, ringMat: ringMaterial, count: cfg.streaks, streaks, streakMat, seeds: new Float32Array(cfg.streaks) };
  }

  private spawnRush(point: Vector3): void {
    const cfg = FX_CONFIG.statusFx.spicerush;
    const rec = take(this.spicerush, hideRush);
    rec.alive = true;
    rec.age = 0;
    rec.life = cfg.lifeMs / 1000;
    rec.x = point.x; rec.y = point.y; rec.z = point.z;
    for (const r of rec.rings) {
      r.position.set(point.x, point.y + 0.06, point.z);
      r.scale.set(0.2, 0.2, 0.2);
      r.visible = true;
    }
    rec.ringMat.opacity = 1;
    for (let i = 0; i < rec.count; i += 1) {
      rec.seeds[i] = Math.random() * Math.PI * 2;
      const st = rec.streaks[i]!;
      // speed streaks: tall thin verticals whipping around the pawn
      st.scale.set(0.03, 0.5, 0.03);
      st.visible = true;
    }
    rec.streakMat.opacity = 1;
  }

  private updateRush(dt: number): void {
    for (const rec of this.spicerush) {
      if (!rec.alive) continue;
      rec.age += dt;
      const t = rec.age / rec.life;
      if (t >= 1) { hideRush(rec); continue; }
      // double pulse: two rings launched half a beat apart
      for (let i = 0; i < rec.rings.length; i += 1) {
        const p = Math.max(0, Math.min(1, t * 1.6 - i * 0.3));
        const rs = 0.2 + p * 1.15;
        rec.rings[i]!.scale.set(rs, rs, rs);
      }
      rec.ringMat.opacity = Math.max(0, 1 - t * 1.3);
      // streaks orbit FAST — amphetamine read
      for (let i = 0; i < rec.count; i += 1) {
        const seed = rec.seeds[i]!;
        const ang = seed + rec.age * 9;
        rec.streaks[i]!.position.set(
          rec.x + Math.cos(ang) * 0.5,
          rec.y + 0.55 + Math.sin(rec.age * 7 + seed) * 0.25,
          rec.z + Math.sin(ang) * 0.5,
        );
      }
      rec.streakMat.opacity = t < 0.6 ? 0.95 : 0.95 * (1 - (t - 0.6) / 0.4);
    }
  }

  // ── SPICEHAZE — WOBBLE-ORBIT: the trip ───────────────────────────────────

  private updateHaze(dt: number): void {
    const cfg = FX_CONFIG.statusFx.spicehaze;
    for (const rec of this.spicehaze) {
      if (!rec.alive) continue;
      rec.age += dt;
      const t = rec.age / rec.life;
      if (t >= 1) { hideSprites(rec); continue; }
      rec.mat.opacity = 0.8 * (t < 0.8 ? 1 : 1 - (t - 0.8) / 0.2);
      // lazy lissajous — nothing else in the language moves this slowly/roundly
      for (let i = 0; i < rec.count; i += 1) {
        const seed = rec.seeds[i]!;
        const a = rec.age * cfg.drift + seed;
        rec.sprites[i]!.position.set(
          rec.x + Math.sin(a * 1.3 + seed) * 0.55,
          rec.y + 0.7 + Math.sin(a * 0.9 + seed * 2) * 0.45,
          rec.z + Math.sin(a * 1.1 + seed * 3) * 0.55,
        );
      }
    }
  }

  // ── SPICECRASH — DRAIN-DOWN: the comedown ────────────────────────────────

  private updateCrash(dt: number): void {
    const cfg = FX_CONFIG.statusFx.spicecrash;
    for (const rec of this.spicecrash) {
      if (!rec.alive) continue;
      rec.age += dt;
      const t = rec.age / rec.life;
      if (t >= 1) { hideSprites(rec); continue; }
      rec.mat.opacity = 0.7 * (1 - t * 0.6);
      // motes SINK off the pawn — the only slow downward status
      for (let i = 0; i < rec.count; i += 1) {
        const seed = rec.seeds[i]!;
        const phase = (t + (seed % 1)) % 1;
        const y = rec.y + 1.3 - phase * (1.3 * cfg.sink + 0.7);
        const ang = seed + phase * 0.6;
        rec.sprites[i]!.position.set(
          rec.x + Math.cos(ang) * 0.3,
          Math.max(0.05, y),
          rec.z + Math.sin(ang) * 0.3,
        );
      }
    }
  }
}

// ── shared plumbing ────────────────────────────────────────────────────────

function prepFx(obj: { renderOrder: number; frustumCulled: boolean; visible: boolean }): void {
  obj.renderOrder = RENDER_ORDER;
  obj.frustumCulled = false;
  obj.visible = false;
}

function spriteMat(map: Texture, blending: typeof AdditiveBlending | typeof NormalBlending = AdditiveBlending): SpriteMaterial {
  return new SpriteMaterial({ map, color: 0xffffff, transparent: true, opacity: 0, blending, depthWrite: false, fog: false });
}

function ringMat(blending: typeof AdditiveBlending | typeof NormalBlending = AdditiveBlending): MeshBasicMaterial {
  return new MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, blending, depthWrite: false, fog: false });
}

function take<T extends { alive: boolean; age: number }>(pool: T[], hide: (rec: T) => void): T {
  let oldest = pool[0]!;
  for (const rec of pool) {
    if (!rec.alive) return rec;
    if (rec.age > oldest.age) oldest = rec;
  }
  hide(oldest);
  return oldest;
}

function hideBlind(rec: BlindRecord): void {
  rec.alive = false;
  rec.veil.visible = false; rec.veilMat.opacity = 0;
  rec.iris.visible = false; rec.irisMat.opacity = 0;
}

function hideSprites(rec: { alive: boolean; sprites: Sprite[]; mat: SpriteMaterial }): void {
  rec.alive = false;
  for (const s of rec.sprites) s.visible = false;
  rec.mat.opacity = 0;
}

function hideBurn(rec: BurnRecord): void {
  rec.alive = false;
  for (const s of rec.tongues) s.visible = false;
  rec.mat.opacity = 0;
}

function hideIntimidate(rec: IntimidateRecord): void {
  rec.alive = false;
  rec.ring.visible = false; rec.ringMat.opacity = 0;
  rec.flash.visible = false; rec.flashMat.opacity = 0;
}

function hideStim(rec: StimRecord): void {
  rec.alive = false;
  rec.ring.visible = false; rec.ringMat.opacity = 0;
  for (const t of rec.ticks) t.visible = false;
  rec.tickMat.opacity = 0;
}

function hideRush(rec: RushRecord): void {
  rec.alive = false;
  for (const r of rec.rings) r.visible = false;
  rec.ringMat.opacity = 0;
  for (const st of rec.streaks) st.visible = false;
  rec.streakMat.opacity = 0;
}

function hidePillar(rec: PillarRecord): void {
  rec.alive = false;
  rec.pillar.visible = false; rec.pillarMat.opacity = 0;
  rec.ring.visible = false; rec.ringMat.opacity = 0;
  for (const s of rec.sparkles) s.visible = false;
  rec.sparkleMat.opacity = 0;
}

function easeOutCubic(t: number): number {
  const inv = 1 - t;
  return 1 - inv * inv * inv;
}

