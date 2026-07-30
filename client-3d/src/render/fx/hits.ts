import {
  AdditiveBlending,
  Color,
  CylinderGeometry,
  DoubleSide,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  Quaternion,
  RingGeometry,
  Sprite,
  SpriteMaterial,
  Vector3,
  type Scene,
  type Texture,
} from "three";
import { FX_CONFIG } from "./config";

/**
 * Styled impact archetypes layered alongside the legacy spark/blood read.
 * HIT_STYLE_IDS + HIT_PREVIEW_COLORS are THE roster — hitTest and the FX LAB
 * both derive from them, so a new archetype registers everywhere at once.
 */
export type HitStyleId =
  | "splash"
  | "implosion"
  | "discharge"
  | "emberburst"
  | "shatter"
  | "geyser"
  | "petals"
  | "orbit";

export const HIT_STYLE_IDS: readonly HitStyleId[] = [
  "splash",
  "implosion",
  "discharge",
  "emberburst",
  "shatter",
  "geyser",
  "petals",
  "orbit",
];

/** Showcase tint per archetype (demo rigs only; real hits use the bolt's coreColor). */
export const HIT_PREVIEW_COLORS: Readonly<Record<HitStyleId, number>> = {
  splash: 0x3fe8ff,
  implosion: 0x9b4dff,
  discharge: 0x7fd4ff,
  emberburst: 0xff7a1f,
  shatter: 0x9fe8ff,
  geyser: 0xffc36b,
  petals: 0xff6bd8,
  orbit: 0xb0ff6b,
};

interface SplashRecord {
  alive: boolean;
  ageSeconds: number;
  lifeSeconds: number;
  mesh: Mesh<RingGeometry, MeshBasicMaterial>;
  material: MeshBasicMaterial;
  glow: Sprite;
  glowMaterial: SpriteMaterial;
  /** Interference ring: a lagging inner ripple — two wavefronts, one energy event. */
  inner: Mesh<RingGeometry, MeshBasicMaterial>;
  innerMaterial: MeshBasicMaterial;
  popScale: number;
}

interface ImplosionRecord {
  alive: boolean;
  ageSeconds: number;
  lifeSeconds: number;
  x: number;
  y: number;
  z: number;
  count: number;
  start: Float32Array;
  sprites: Sprite[];
  spriteMaterials: SpriteMaterial[];
  center: Sprite;
  centerMaterial: SpriteMaterial;
  popScale: number;
}

interface DischargeBoltSlot {
  segmentA: Mesh<CylinderGeometry, MeshBasicMaterial>;
  segmentB: Mesh<CylinderGeometry, MeshBasicMaterial>;
  material: MeshBasicMaterial;
  /** Arc termination glow riding the bolt tip. */
  tip: Sprite;
  dirX: number;
  dirY: number;
  dirZ: number;
  sideX: number;
  sideZ: number;
}

interface DischargeRecord {
  alive: boolean;
  ageSeconds: number;
  lifeSeconds: number;
  x: number;
  y: number;
  z: number;
  reach: number;
  jitter: number;
  count: number;
  bolts: DischargeBoltSlot[];
  /** Short-circuit core flash — white-hot, spent by t=0.3. */
  flash: Sprite;
  flashMaterial: SpriteMaterial;
  /** One material for all tips: they stutter in lockstep with the arcs. */
  tipMaterial: SpriteMaterial;
}

interface ShatterRecord {
  alive: boolean;
  ageSeconds: number;
  lifeSeconds: number;
  x: number;
  y: number;
  z: number;
  count: number;
  /** Crystal shards: shared geometry, ONE material per record. */
  shards: Mesh<CylinderGeometry, MeshBasicMaterial>[];
  material: MeshBasicMaterial;
  glint: Sprite;
  glintMaterial: SpriteMaterial;
  dirs: Float32Array;
  lens: Float32Array;
  spins: Float32Array;
}

interface GeyserRecord {
  alive: boolean;
  ageSeconds: number;
  lifeSeconds: number;
  count: number;
  sprites: Sprite[];
  material: SpriteMaterial;
  vx: Float32Array;
  vy: Float32Array;
  vz: Float32Array;
  column: Mesh<CylinderGeometry, MeshBasicMaterial>;
  columnMaterial: MeshBasicMaterial;
}

interface PetalRecord {
  alive: boolean;
  ageSeconds: number;
  lifeSeconds: number;
  x: number;
  y: number;
  z: number;
  count: number;
  petals: Mesh<PlaneGeometry, MeshBasicMaterial>[];
  material: MeshBasicMaterial;
  angles: Float32Array;
}

interface OrbitRecord {
  alive: boolean;
  ageSeconds: number;
  lifeSeconds: number;
  x: number;
  y: number;
  z: number;
  count: number;
  sprites: Sprite[];
  material: SpriteMaterial;
  phases: Float32Array;
  radii0: Float32Array;
  flut: Float32Array;
}

interface EmberRecord {
  alive: boolean;
  ageSeconds: number;
  lifeSeconds: number;
  count: number;
  startR: number;
  startG: number;
  startB: number;
  vx: Float32Array;
  vy: Float32Array;
  vz: Float32Array;
  scale: Float32Array;
  stuck: Uint8Array;
  sprites: Sprite[];
  spriteMaterials: SpriteMaterial[];
}

const RENDER_ORDER = 12;
const WHITE = new Color(1, 1, 1);
const MIN_HIT_Y = 0.05;
const EMBER_GROUND_Y = 0.03;
const EMBER_END_R = 0x55 / 255;
const EMBER_END_G = 0x22 / 255;
const EMBER_END_B = 0x11 / 255;
const DISCHARGE_RADIUS = 0.022;
const Y_AXIS = new Vector3(0, 1, 0);

/**
 * Pooled styled impact effects. The pool is per archetype, all materials are
 * created at construction, and update() mutates only pre-existing records.
 */
export class HitFx {
  private readonly splash: SplashRecord[] = [];
  private readonly implosion: ImplosionRecord[] = [];
  private readonly discharge: DischargeRecord[] = [];
  private readonly emberburst: EmberRecord[] = [];
  private readonly shatter: ShatterRecord[] = [];
  private readonly geyser: GeyserRecord[] = [];
  private readonly petals: PetalRecord[] = [];
  private readonly orbit: OrbitRecord[] = [];
  private readonly splashGeometry = new RingGeometry(0.85, 1.0, 24);
  private readonly dischargeGeometry = new CylinderGeometry(1, 1, 1, 5, 1);
  private readonly shardGeometry = new CylinderGeometry(0.35, 1, 1, 4, 1);
  private readonly petalGeometry = new PlaneGeometry(1, 1);
  private readonly _q = new Quaternion();
  private readonly _v1 = new Vector3();
  private readonly _dischargeStart = new Vector3();
  private readonly _dischargeElbow = new Vector3();
  private readonly _dischargeTip = new Vector3();
  private readonly _dischargeMid = new Vector3();
  private readonly _dischargeDir = new Vector3();
  private readonly _flashColor = new Color();

  constructor(scene: Scene, sprite: Texture) {
    const cfg = FX_CONFIG.hitFx;
    for (let i = 0; i < cfg.poolPerKind; i += 1) {
      this.splash.push(createSplashRecord(scene, this.splashGeometry, sprite));
      this.implosion.push(createImplosionRecord(scene, sprite));
      this.discharge.push(createDischargeRecord(scene, this.dischargeGeometry, sprite));
      this.emberburst.push(createEmberRecord(scene, sprite));
      this.shatter.push(createShatterRecord(scene, this.shardGeometry, sprite));
      this.geyser.push(createGeyserRecord(scene, this.dischargeGeometry, sprite));
      this.petals.push(createPetalRecord(scene, this.petalGeometry));
      this.orbit.push(createOrbitRecord(scene, sprite));
    }
  }

  spawn(style: HitStyleId, point: Vector3, incoming: Vector3, color: number, mag: number): void {
    switch (style) {
      case "splash":
        this.spawnSplash(point, color, mag);
        return;
      case "implosion":
        this.spawnImplosion(point, color, mag);
        return;
      case "discharge":
        this.spawnDischarge(point, incoming, color);
        return;
      case "emberburst":
        this.spawnEmberburst(point, incoming, color);
        return;
      case "shatter":
        this.spawnShatter(point, color, mag);
        return;
      case "geyser":
        this.spawnGeyser(point, color);
        return;
      case "petals":
        this.spawnPetals(point, color);
        return;
      case "orbit":
        this.spawnOrbit(point, color);
        return;
    }
  }

  update(dtSeconds: number): void {
    if (dtSeconds <= 0) return;
    this.updateSplash(dtSeconds);
    this.updateImplosion(dtSeconds);
    this.updateDischarge(dtSeconds);
    this.updateEmberburst(dtSeconds);
    this.updateShatter(dtSeconds);
    this.updateGeyser(dtSeconds);
    this.updatePetals(dtSeconds);
    this.updateOrbit(dtSeconds);
  }

  get activeCount(): number {
    let total = 0;
    for (let i = 0; i < this.splash.length; i += 1) if (this.splash[i]!.alive) total += 1;
    for (let i = 0; i < this.implosion.length; i += 1) if (this.implosion[i]!.alive) total += 1;
    for (let i = 0; i < this.discharge.length; i += 1) if (this.discharge[i]!.alive) total += 1;
    for (let i = 0; i < this.emberburst.length; i += 1) if (this.emberburst[i]!.alive) total += 1;
    for (let i = 0; i < this.shatter.length; i += 1) if (this.shatter[i]!.alive) total += 1;
    for (let i = 0; i < this.geyser.length; i += 1) if (this.geyser[i]!.alive) total += 1;
    for (let i = 0; i < this.petals.length; i += 1) if (this.petals[i]!.alive) total += 1;
    for (let i = 0; i < this.orbit.length; i += 1) if (this.orbit[i]!.alive) total += 1;
    return total;
  }

  dispose(): void {
    for (let i = 0; i < this.splash.length; i += 1) {
      const rec = this.splash[i]!;
      rec.material.dispose();
      rec.innerMaterial.dispose();
      rec.glowMaterial.dispose();
      rec.mesh.parent?.remove(rec.mesh);
      rec.inner.parent?.remove(rec.inner);
      rec.glow.parent?.remove(rec.glow);
    }
    for (let i = 0; i < this.implosion.length; i += 1) {
      const rec = this.implosion[i]!;
      for (let s = 0; s < rec.sprites.length; s += 1) {
        rec.spriteMaterials[s]!.dispose();
        rec.sprites[s]!.parent?.remove(rec.sprites[s]!);
      }
      rec.centerMaterial.dispose();
      rec.center.parent?.remove(rec.center);
    }
    for (let i = 0; i < this.discharge.length; i += 1) {
      const rec = this.discharge[i]!;
      for (let l = 0; l < rec.bolts.length; l += 1) {
        const slot = rec.bolts[l]!;
        slot.material.dispose();
        slot.segmentA.parent?.remove(slot.segmentA);
        slot.segmentB.parent?.remove(slot.segmentB);
        slot.tip.parent?.remove(slot.tip);
      }
      rec.flashMaterial.dispose();
      rec.tipMaterial.dispose();
      rec.flash.parent?.remove(rec.flash);
    }
    for (let i = 0; i < this.emberburst.length; i += 1) {
      const rec = this.emberburst[i]!;
      for (let s = 0; s < rec.sprites.length; s += 1) {
        rec.spriteMaterials[s]!.dispose();
        rec.sprites[s]!.parent?.remove(rec.sprites[s]!);
      }
    }
    for (let i = 0; i < this.shatter.length; i += 1) {
      const rec = this.shatter[i]!;
      for (let sIdx = 0; sIdx < rec.shards.length; sIdx += 1) rec.shards[sIdx]!.parent?.remove(rec.shards[sIdx]!);
      rec.material.dispose();
      rec.glintMaterial.dispose();
      rec.glint.parent?.remove(rec.glint);
    }
    for (let i = 0; i < this.geyser.length; i += 1) {
      const rec = this.geyser[i]!;
      for (let sIdx = 0; sIdx < rec.sprites.length; sIdx += 1) rec.sprites[sIdx]!.parent?.remove(rec.sprites[sIdx]!);
      rec.material.dispose();
      rec.columnMaterial.dispose();
      rec.column.parent?.remove(rec.column);
    }
    for (let i = 0; i < this.petals.length; i += 1) {
      const rec = this.petals[i]!;
      for (let pIdx = 0; pIdx < rec.petals.length; pIdx += 1) rec.petals[pIdx]!.parent?.remove(rec.petals[pIdx]!);
      rec.material.dispose();
    }
    for (let i = 0; i < this.orbit.length; i += 1) {
      const rec = this.orbit[i]!;
      for (let sIdx = 0; sIdx < rec.sprites.length; sIdx += 1) rec.sprites[sIdx]!.parent?.remove(rec.sprites[sIdx]!);
      rec.material.dispose();
    }
    this.splashGeometry.dispose();
    this.dischargeGeometry.dispose();
    this.shardGeometry.dispose();
    this.petalGeometry.dispose();
    this.splash.length = 0;
    this.implosion.length = 0;
    this.discharge.length = 0;
    this.emberburst.length = 0;
    this.shatter.length = 0;
    this.geyser.length = 0;
    this.petals.length = 0;
    this.orbit.length = 0;
  }

  private spawnSplash(point: Vector3, color: number, mag: number): void {
    const cfg = FX_CONFIG.hitFx.splash;
    const rec = takeSplashRecord(this.splash);
    rec.alive = true;
    rec.ageSeconds = 0;
    rec.lifeSeconds = cfg.lifeMs / 1000;
    rec.popScale = cfg.popScale * mag;
    rec.material.color.setHex(color);
    rec.material.opacity = 1;
    rec.glowMaterial.color.setHex(color);
    rec.glowMaterial.opacity = 1;
    const y = Math.max(MIN_HIT_Y, point.y);
    rec.mesh.position.set(point.x, y, point.z);
    rec.mesh.scale.set(cfg.startRadius, cfg.startRadius, cfg.startRadius);
    rec.mesh.visible = true;
    rec.innerMaterial.color.setHex(color);
    rec.innerMaterial.opacity = 0.85;
    rec.inner.position.set(point.x, y + 0.012, point.z);
    rec.inner.scale.set(cfg.startRadius * 0.5, cfg.startRadius * 0.5, cfg.startRadius * 0.5);
    rec.inner.visible = true;
    rec.glow.position.set(point.x, y, point.z);
    rec.glow.scale.set(rec.popScale * 0.35, rec.popScale * 0.35, rec.popScale * 0.35);
    rec.glow.visible = true;
  }

  private updateSplash(dtSeconds: number): void {
    const cfg = FX_CONFIG.hitFx.splash;
    for (let i = 0; i < this.splash.length; i += 1) {
      const rec = this.splash[i]!;
      if (!rec.alive) continue;
      rec.ageSeconds += dtSeconds;
      const t = rec.ageSeconds / rec.lifeSeconds;
      if (t >= 1) {
        hideSplash(rec);
        continue;
      }
      const out = easeOutCubic(t);
      const radius = cfg.startRadius + (cfg.endRadius - cfg.startRadius) * out;
      const alpha = 1 - t;
      const glowScale = rec.popScale * (0.35 + 0.65 * out);
      rec.mesh.scale.set(radius, radius, radius);
      rec.material.opacity = alpha;
      rec.glow.scale.set(glowScale, glowScale, glowScale);
      rec.glowMaterial.opacity = alpha;
      // Interference read: the inner wavefront launches late and chases the
      // outer — two rings, one event, the gap IS the energy signature.
      const lag = easeOutCubic(Math.max(0, t - 0.18) / 0.82);
      const innerR = cfg.startRadius + (cfg.endRadius * 0.62 - cfg.startRadius) * lag;
      rec.inner.scale.set(innerR, innerR, innerR);
      rec.innerMaterial.opacity = alpha * 0.75;
    }
  }

  private spawnImplosion(point: Vector3, color: number, mag: number): void {
    const cfg = FX_CONFIG.hitFx.implosion;
    const rec = takeImplosionRecord(this.implosion);
    rec.alive = true;
    rec.ageSeconds = 0;
    rec.lifeSeconds = cfg.lifeMs / 1000;
    rec.x = point.x;
    rec.y = Math.max(MIN_HIT_Y, point.y);
    rec.z = point.z;
    rec.count = Math.min(cfg.sprites, rec.sprites.length);
    rec.popScale = cfg.popScale * mag;
    rec.center.visible = false;
    rec.centerMaterial.color.setHex(color);
    rec.centerMaterial.opacity = 0;
    rec.center.position.set(rec.x, rec.y, rec.z);
    rec.center.scale.set(rec.popScale * 0.2, rec.popScale * 0.2, rec.popScale * 0.2);
    for (let i = 0; i < rec.sprites.length; i += 1) {
      const sprite = rec.sprites[i]!;
      const material = rec.spriteMaterials[i]!;
      if (i >= rec.count) {
        sprite.visible = false;
        material.opacity = 0;
        continue;
      }
      const angle = Math.random() * Math.PI * 2;
      const sx = rec.x + Math.cos(angle) * cfg.startRadius;
      const sy = rec.y + (Math.random() * 0.3 - 0.15);
      const sz = rec.z + Math.sin(angle) * cfg.startRadius;
      const i3 = i * 3;
      rec.start[i3] = sx;
      rec.start[i3 + 1] = sy;
      rec.start[i3 + 2] = sz;
      material.color.setHex(color);
      material.opacity = 0.95;
      sprite.position.set(sx, sy, sz);
      sprite.scale.set(0.22, 0.22, 0.22);
      sprite.visible = true;
    }
  }

  private updateImplosion(dtSeconds: number): void {
    for (let i = 0; i < this.implosion.length; i += 1) {
      const rec = this.implosion[i]!;
      if (!rec.alive) continue;
      rec.ageSeconds += dtSeconds;
      const t = rec.ageSeconds / rec.lifeSeconds;
      if (t >= 1) {
        hideImplosion(rec);
        continue;
      }
      if (t < 0.55) {
        const p = t / 0.55;
        // Suction read: sprites ACCELERATE inward (p^2), they don't slide.
        const pIn = p * p;
        const alpha = 1 - p * 0.55;
        const scale = 0.22 * (1 - p * 0.2);
        for (let s = 0; s < rec.count; s += 1) {
          const i3 = s * 3;
          const sx = rec.start[i3]!;
          const sy = rec.start[i3 + 1]!;
          const sz = rec.start[i3 + 2]!;
          rec.sprites[s]!.position.set(
            sx + (rec.x - sx) * pIn,
            sy + (rec.y - sy) * pIn,
            sz + (rec.z - sz) * pIn,
          );
          rec.sprites[s]!.scale.set(scale, scale, scale);
          rec.spriteMaterials[s]!.opacity = alpha;
        }
        rec.center.visible = false;
        rec.centerMaterial.opacity = 0;
      } else {
        for (let s = 0; s < rec.count; s += 1) {
          rec.sprites[s]!.visible = false;
          rec.spriteMaterials[s]!.opacity = 0;
        }
        const p = (t - 0.55) / 0.45;
        const alpha = 1 - p;
        const pop = rec.popScale * easeOutCubic(p);
        rec.center.visible = true;
        rec.center.scale.set(pop, pop, pop);
        rec.centerMaterial.opacity = alpha;
      }
    }
  }

  private spawnDischarge(point: Vector3, incoming: Vector3, color: number): void {
    const cfg = FX_CONFIG.hitFx.discharge;
    const rec = takeDischargeRecord(this.discharge);
    rec.alive = true;
    rec.ageSeconds = 0;
    rec.lifeSeconds = cfg.lifeMs / 1000;
    rec.x = point.x;
    rec.y = Math.max(MIN_HIT_Y, point.y);
    rec.z = point.z;
    rec.reach = cfg.reach;
    rec.jitter = cfg.jitter;
    rec.count = Math.min(cfg.lines, rec.bolts.length);

    // Short-circuit core flash at the strike point; arcs end in tip glows.
    rec.flash.position.set(rec.x, rec.y, rec.z);
    rec.flash.scale.set(cfg.flashScale, cfg.flashScale, cfg.flashScale);
    this._flashColor.setHex(color).lerp(WHITE, 0.55);
    rec.flashMaterial.color.copy(this._flashColor);
    rec.flashMaterial.opacity = 1;
    rec.flash.visible = true;
    rec.tipMaterial.color.setHex(color);
    rec.tipMaterial.opacity = 1;

    let bx = -incoming.x;
    let by = -incoming.y;
    let bz = -incoming.z;
    let bl = Math.hypot(bx, by, bz);
    if (bl <= 1e-5) {
      bx = 1; by = 0; bz = 0; bl = 1;
    }
    bx /= bl; by /= bl; bz /= bl;

    for (let i = 0; i < rec.bolts.length; i += 1) {
      const slot = rec.bolts[i]!;
      if (i >= rec.count) {
        slot.segmentA.visible = false;
        slot.segmentB.visible = false;
        slot.tip.visible = false;
        slot.material.opacity = 0;
        continue;
      }
      let dx = bx + (Math.random() * 2 - 1) * 0.65;
      let dy = by + Math.random() * 0.45;
      let dz = bz + (Math.random() * 2 - 1) * 0.65;
      let dl = Math.hypot(dx, dy, dz);
      if (dl <= 1e-5) {
        dx = bx; dy = by; dz = bz; dl = 1;
      }
      dx /= dl; dy /= dl; dz /= dl;
      if (dx * bx + dy * by + dz * bz < 0) {
        dx = -dx; dy = -dy; dz = -dz;
      }
      let sideX = -dz;
      let sideZ = dx;
      let sl = Math.hypot(sideX, sideZ);
      if (sl <= 1e-5) {
        sideX = 1; sideZ = 0; sl = 1;
      }
      sideX /= sl;
      sideZ /= sl;
      slot.dirX = dx;
      slot.dirY = dy;
      slot.dirZ = dz;
      slot.sideX = sideX;
      slot.sideZ = sideZ;
      slot.material.color.setHex(color);
      slot.material.opacity = 1;
      slot.segmentA.visible = true;
      slot.segmentB.visible = true;
      slot.tip.visible = true;
      slot.tip.scale.set(cfg.tipScale, cfg.tipScale, cfg.tipScale);
      this.writeDischargeBolt(rec, slot);
    }
  }

  private updateDischarge(dtSeconds: number): void {
    const cfg = FX_CONFIG.hitFx.discharge;
    for (let i = 0; i < this.discharge.length; i += 1) {
      const rec = this.discharge[i]!;
      if (!rec.alive) continue;
      rec.ageSeconds += dtSeconds;
      const t = rec.ageSeconds / rec.lifeSeconds;
      if (t >= 1) {
        hideDischarge(rec);
        continue;
      }
      // ELECTRIC IDENTITY: arcs don't fade, they STUTTER — a square-ish
      // strobe (duty 62%) modulating a slow power decay, so the crackle
      // blinks like a shorting main. Every other archetype eases; only
      // electricity is allowed to be discontinuous.
      const decay = Math.pow(1 - t, 0.7);
      const phase = rec.ageSeconds * cfg.strobeHz;
      const strobe = phase - Math.floor(phase) < 0.62 ? 1 : 0.15;
      const alpha = decay * strobe;
      // Core flash: white-hot pop, spent by t=0.3, growing as it dies.
      const flashT = t / 0.3;
      rec.flash.visible = flashT < 1;
      rec.flashMaterial.opacity = flashT >= 1 ? 0 : Math.pow(1 - flashT, 1.5);
      const flashScale = cfg.flashScale * (1 + t * 0.9);
      rec.flash.scale.set(flashScale, flashScale, flashScale);
      rec.tipMaterial.opacity = alpha;
      for (let l = 0; l < rec.count; l += 1) {
        const slot = rec.bolts[l]!;
        slot.material.opacity = alpha;
        this.writeDischargeBolt(rec, slot);
      }
    }
  }

  private writeDischargeBolt(rec: DischargeRecord, slot: DischargeBoltSlot): void {
    this._dischargeStart.set(rec.x, rec.y, rec.z);
    this._dischargeTip.set(
      rec.x + slot.dirX * rec.reach,
      rec.y + slot.dirY * rec.reach,
      rec.z + slot.dirZ * rec.reach,
    );
    const sideJitter = (Math.random() * 2 - 1) * rec.jitter * 2;
    const yJitter = (Math.random() * 2 - 1) * rec.jitter;
    this._dischargeElbow.set(
      rec.x + slot.dirX * rec.reach * 0.5 + slot.sideX * sideJitter,
      rec.y + slot.dirY * rec.reach * 0.5 + yJitter,
      rec.z + slot.dirZ * rec.reach * 0.5 + slot.sideZ * sideJitter,
    );
    this.positionDischargeSegment(slot.segmentA, this._dischargeStart, this._dischargeElbow);
    this.positionDischargeSegment(slot.segmentB, this._dischargeElbow, this._dischargeTip);
    slot.tip.position.copy(this._dischargeTip);
  }

  private positionDischargeSegment(mesh: Mesh<CylinderGeometry, MeshBasicMaterial>, start: Vector3, end: Vector3): void {
    this._dischargeDir.subVectors(end, start);
    const len = this._dischargeDir.length();
    if (len <= 1e-5) {
      mesh.visible = false;
      return;
    }
    this._dischargeMid.copy(start).add(end).multiplyScalar(0.5);
    mesh.position.copy(this._dischargeMid);
    mesh.quaternion.setFromUnitVectors(Y_AXIS, this._dischargeDir.multiplyScalar(1 / len));
    mesh.scale.set(DISCHARGE_RADIUS, len, DISCHARGE_RADIUS);
    mesh.visible = true;
  }

  private spawnEmberburst(point: Vector3, incoming: Vector3, color: number): void {
    const cfg = FX_CONFIG.hitFx.emberburst;
    const rec = takeEmberRecord(this.emberburst);
    rec.alive = true;
    rec.ageSeconds = 0;
    rec.lifeSeconds = cfg.lifeMs / 1000;
    rec.count = Math.min(cfg.sprites, rec.sprites.length);
    rec.startR = ((color >> 16) & 255) / 255;
    rec.startG = ((color >> 8) & 255) / 255;
    rec.startB = (color & 255) / 255;

    let bx = -incoming.x;
    let by = -incoming.y;
    let bz = -incoming.z;
    let bl = Math.hypot(bx, by, bz);
    if (bl <= 1e-5) {
      bx = 1; by = 0; bz = 0; bl = 1;
    }
    bx /= bl; by /= bl; bz /= bl;
    const y = Math.max(EMBER_GROUND_Y, point.y);

    for (let i = 0; i < rec.sprites.length; i += 1) {
      const sprite = rec.sprites[i]!;
      const material = rec.spriteMaterials[i]!;
      if (i >= rec.count) {
        sprite.visible = false;
        material.opacity = 0;
        continue;
      }
      let dx = bx + (Math.random() * 2 - 1) * 0.9;
      let dy = by + 0.2 + Math.random() * 0.8;
      let dz = bz + (Math.random() * 2 - 1) * 0.9;
      let dl = Math.hypot(dx, dy, dz);
      if (dl <= 1e-5) {
        dx = bx; dy = Math.max(0.2, by); dz = bz; dl = Math.hypot(dx, dy, dz);
      }
      dx /= dl; dy /= dl; dz /= dl;
      if (dx * bx + dy * by + dz * bz < 0) {
        dx = -dx; dy = Math.abs(dy); dz = -dz;
      }
      const speed = cfg.speed * (0.4 + Math.random() * 0.6);
      rec.vx[i] = dx * speed;
      rec.vy[i] = dy * speed;
      rec.vz[i] = dz * speed;
      rec.scale[i] = cfg.spriteScale * (0.6 + Math.random() * 0.7);
      rec.stuck[i] = 0;
      material.color.setHex(color);
      material.opacity = 1;
      sprite.position.set(point.x, y, point.z);
      sprite.scale.set(rec.scale[i]!, rec.scale[i]!, rec.scale[i]!);
      sprite.visible = true;
    }
  }

  private updateEmberburst(dtSeconds: number): void {
    const gravity = FX_CONFIG.hitFx.emberburst.gravity;
    for (let i = 0; i < this.emberburst.length; i += 1) {
      const rec = this.emberburst[i]!;
      if (!rec.alive) continue;
      rec.ageSeconds += dtSeconds;
      const t = rec.ageSeconds / rec.lifeSeconds;
      if (t >= 1) {
        hideEmber(rec);
        continue;
      }
      const remain = 1 - t;
      const alpha = remain * remain;
      const r = rec.startR + (EMBER_END_R - rec.startR) * t;
      const g = rec.startG + (EMBER_END_G - rec.startG) * t;
      const b = rec.startB + (EMBER_END_B - rec.startB) * t;
      for (let s = 0; s < rec.count; s += 1) {
        const sprite = rec.sprites[s]!;
        if (rec.stuck[s]! === 0) {
          sprite.position.x += rec.vx[s]! * dtSeconds;
          sprite.position.y += rec.vy[s]! * dtSeconds;
          sprite.position.z += rec.vz[s]! * dtSeconds;
          rec.vy[s] = rec.vy[s]! - gravity * dtSeconds;
          if (sprite.position.y <= EMBER_GROUND_Y) {
            sprite.position.y = EMBER_GROUND_Y;
            rec.vx[s] = 0;
            rec.vy[s] = 0;
            rec.vz[s] = 0;
            rec.stuck[s] = 1;
          }
        }
        rec.spriteMaterials[s]!.color.setRGB(r, g, b);
        rec.spriteMaterials[s]!.opacity = alpha;
      }
    }
  }

  // ── SHATTER — crystal burst that FREEZES mid-air, then drops ─────────────
  // Identity: the unnatural pause. Shards blast out, hang frozen (shimmering
  // faintly), then gravity remembers them. No other archetype stops time.

  private spawnShatter(point: Vector3, color: number, mag: number): void {
    const cfg = FX_CONFIG.hitFx.shatter;
    const rec = takeShatterRecord(this.shatter);
    rec.alive = true;
    rec.ageSeconds = 0;
    rec.lifeSeconds = cfg.lifeMs / 1000;
    rec.x = point.x;
    rec.y = Math.max(MIN_HIT_Y + 0.15, point.y);
    rec.z = point.z;
    rec.count = Math.min(cfg.shards, rec.shards.length);
    rec.material.color.setHex(color);
    rec.material.opacity = 1;
    this._flashColor.setHex(color).lerp(WHITE, 0.6);
    rec.glintMaterial.color.copy(this._flashColor);
    rec.glintMaterial.opacity = 1;
    rec.glint.position.set(rec.x, rec.y, rec.z);
    rec.glint.scale.set(cfg.glintScale * mag, cfg.glintScale * mag, cfg.glintScale * mag);
    rec.glint.visible = true;
    for (let i = 0; i < rec.shards.length; i += 1) {
      const shard = rec.shards[i]!;
      if (i >= rec.count) {
        shard.visible = false;
        continue;
      }
      // tilted-disc burst: mostly lateral, slight upward bias
      const az = Math.random() * Math.PI * 2;
      const up = 0.15 + Math.random() * 0.4;
      const i3 = i * 3;
      const inv = 1 / Math.hypot(Math.cos(az), up, Math.sin(az));
      rec.dirs[i3] = Math.cos(az) * inv;
      rec.dirs[i3 + 1] = up * inv;
      rec.dirs[i3 + 2] = Math.sin(az) * inv;
      rec.lens[i] = 0.12 + Math.random() * 0.1;
      rec.spins[i] = (Math.random() - 0.5) * 22;
      shard.visible = true;
    }
  }

  private updateShatter(dtSeconds: number): void {
    const cfg = FX_CONFIG.hitFx.shatter;
    for (let i = 0; i < this.shatter.length; i += 1) {
      const rec = this.shatter[i]!;
      if (!rec.alive) continue;
      rec.ageSeconds += dtSeconds;
      const t = rec.ageSeconds / rec.lifeSeconds;
      if (t >= 1) {
        hideShatter(rec);
        continue;
      }
      // glint: spent in the first fifth
      const glintT = t / 0.2;
      rec.glint.visible = glintT < 1;
      rec.glintMaterial.opacity = glintT >= 1 ? 0 : 1 - glintT;
      // burst -> FREEZE -> drop
      const burstP = t < 0.25 ? easeOutCubic(t / 0.25) : 1;
      const frozen = t >= 0.25 && t < 0.55;
      const dropQ = t >= 0.55 ? (t - 0.55) / 0.45 : 0;
      const spinAge = Math.min(rec.ageSeconds, 0.25 * rec.lifeSeconds);
      rec.material.opacity = frozen
        ? 0.85 + 0.15 * Math.sin(rec.ageSeconds * 34)
        : dropQ > 0 ? 1 - dropQ : 1;
      for (let sIdx = 0; sIdx < rec.count; sIdx += 1) {
        const shard = rec.shards[sIdx]!;
        const i3 = sIdx * 3;
        const r = cfg.burstRadius * burstP;
        const drop = 2.6 * dropQ * dropQ;
        shard.position.set(
          rec.x + rec.dirs[i3]! * r,
          Math.max(EMBER_GROUND_Y, rec.y + rec.dirs[i3 + 1]! * r - drop),
          rec.z + rec.dirs[i3 + 2]! * r,
        );
        this._v1.set(rec.dirs[i3]!, rec.dirs[i3 + 1]!, rec.dirs[i3 + 2]!);
        shard.quaternion.setFromUnitVectors(Y_AXIS, this._v1);
        this._q.setFromAxisAngle(this._v1, rec.spins[sIdx]! * spinAge);
        shard.quaternion.premultiply(this._q);
        shard.scale.set(0.018, rec.lens[sIdx]!, 0.018);
      }
    }
  }

  // ── GEYSER — vertical eruption; the only archetype that goes UP ──────────

  private spawnGeyser(point: Vector3, color: number): void {
    const cfg = FX_CONFIG.hitFx.geyser;
    const rec = takeGeyserRecord(this.geyser);
    rec.alive = true;
    rec.ageSeconds = 0;
    rec.lifeSeconds = cfg.lifeMs / 1000;
    rec.count = Math.min(cfg.sprites, rec.sprites.length);
    const y = Math.max(EMBER_GROUND_Y, point.y);
    rec.material.color.setHex(color);
    rec.material.opacity = 1;
    this._flashColor.setHex(color).lerp(WHITE, 0.45);
    rec.columnMaterial.color.copy(this._flashColor);
    rec.columnMaterial.opacity = 0.9;
    rec.column.position.set(point.x, y + cfg.columnHeight * 0.5, point.z);
    rec.column.scale.set(0.04, cfg.columnHeight, 0.04);
    rec.column.visible = true;
    for (let i = 0; i < rec.sprites.length; i += 1) {
      const sprite = rec.sprites[i]!;
      if (i >= rec.count) {
        sprite.visible = false;
        continue;
      }
      rec.vx[i] = (Math.random() - 0.5) * 0.9;
      rec.vy[i] = cfg.speedY * (0.6 + Math.random() * 0.55);
      rec.vz[i] = (Math.random() - 0.5) * 0.9;
      sprite.position.set(point.x, y, point.z);
      const sc = 0.13 + Math.random() * 0.07;
      sprite.scale.set(sc, sc, sc);
      sprite.visible = true;
    }
  }

  private updateGeyser(dtSeconds: number): void {
    const cfg = FX_CONFIG.hitFx.geyser;
    for (let i = 0; i < this.geyser.length; i += 1) {
      const rec = this.geyser[i]!;
      if (!rec.alive) continue;
      rec.ageSeconds += dtSeconds;
      const t = rec.ageSeconds / rec.lifeSeconds;
      if (t >= 1) {
        hideGeyser(rec);
        continue;
      }
      // eruption column flash dies in the first third
      const colT = t / 0.3;
      rec.column.visible = colT < 1;
      rec.columnMaterial.opacity = colT >= 1 ? 0 : 0.9 * (1 - colT);
      rec.material.opacity = 1 - t * t;
      for (let sIdx = 0; sIdx < rec.count; sIdx += 1) {
        const sprite = rec.sprites[sIdx]!;
        sprite.position.x += rec.vx[sIdx]! * dtSeconds;
        sprite.position.y += rec.vy[sIdx]! * dtSeconds;
        sprite.position.z += rec.vz[sIdx]! * dtSeconds;
        rec.vy[sIdx] = rec.vy[sIdx]! - cfg.gravity * dtSeconds;
        if (sprite.position.y < EMBER_GROUND_Y) sprite.position.y = EMBER_GROUND_Y;
      }
    }
  }

  // ── PETALS — organic unfold, hold, wilt; the only archetype that grows ───

  private spawnPetals(point: Vector3, color: number): void {
    const cfg = FX_CONFIG.hitFx.petals;
    const rec = takePetalRecord(this.petals);
    rec.alive = true;
    rec.ageSeconds = 0;
    rec.lifeSeconds = cfg.lifeMs / 1000;
    rec.x = point.x;
    rec.y = Math.max(MIN_HIT_Y, point.y);
    rec.z = point.z;
    rec.count = Math.min(cfg.petals, rec.petals.length);
    rec.material.color.setHex(color);
    rec.material.opacity = 1;
    for (let i = 0; i < rec.petals.length; i += 1) {
      const petal = rec.petals[i]!;
      if (i >= rec.count) {
        petal.visible = false;
        continue;
      }
      rec.angles[i] = (i / rec.count) * Math.PI * 2 + Math.random() * 0.25;
      petal.visible = true;
    }
  }

  private updatePetals(dtSeconds: number): void {
    const cfg = FX_CONFIG.hitFx.petals;
    for (let i = 0; i < this.petals.length; i += 1) {
      const rec = this.petals[i]!;
      if (!rec.alive) continue;
      rec.ageSeconds += dtSeconds;
      const t = rec.ageSeconds / rec.lifeSeconds;
      if (t >= 1) {
        hidePetals(rec);
        continue;
      }
      const unfold = easeOutCubic(Math.min(1, t / 0.45));
      const wiltQ = t >= 0.7 ? (t - 0.7) / 0.3 : 0;
      // open 85deg->30deg from vertical, then droop past horizontal as it dies
      const tilt = (85 - 55 * unfold + 80 * wiltQ) * (Math.PI / 180);
      rec.material.opacity = wiltQ > 0 ? 1 - wiltQ : 1;
      for (let pIdx = 0; pIdx < rec.count; pIdx += 1) {
        const petal = rec.petals[pIdx]!;
        const a = rec.angles[pIdx]!;
        const r = cfg.radius * (0.3 + 0.7 * unfold);
        petal.position.set(rec.x + Math.cos(a) * r, rec.y, rec.z + Math.sin(a) * r);
        petal.rotation.set(tilt, -a + Math.PI / 2, 0);
        petal.scale.set(cfg.petalW * unfold, cfg.petalH * unfold, 1);
      }
    }
  }

  // ── ORBIT — luminous moths spiral off the wound; angular momentum ────────

  private spawnOrbit(point: Vector3, color: number): void {
    const cfg = FX_CONFIG.hitFx.orbit;
    const rec = takeOrbitRecord(this.orbit);
    rec.alive = true;
    rec.ageSeconds = 0;
    rec.lifeSeconds = cfg.lifeMs / 1000;
    rec.x = point.x;
    rec.y = Math.max(MIN_HIT_Y, point.y);
    rec.z = point.z;
    rec.count = Math.min(cfg.sprites, rec.sprites.length);
    rec.material.color.setHex(color);
    rec.material.opacity = 1;
    for (let i = 0; i < rec.sprites.length; i += 1) {
      const sprite = rec.sprites[i]!;
      if (i >= rec.count) {
        sprite.visible = false;
        continue;
      }
      rec.phases[i] = Math.random() * Math.PI * 2;
      rec.radii0[i] = cfg.baseRadius * (0.7 + Math.random() * 0.6);
      rec.flut[i] = Math.random() * Math.PI * 2;
      sprite.scale.set(cfg.spriteScale, cfg.spriteScale, cfg.spriteScale);
      sprite.visible = true;
    }
  }

  private updateOrbit(dtSeconds: number): void {
    const cfg = FX_CONFIG.hitFx.orbit;
    for (let i = 0; i < this.orbit.length; i += 1) {
      const rec = this.orbit[i]!;
      if (!rec.alive) continue;
      rec.ageSeconds += dtSeconds;
      const t = rec.ageSeconds / rec.lifeSeconds;
      if (t >= 1) {
        hideOrbit(rec);
        continue;
      }
      rec.material.opacity = t < 0.75 ? 1 : (1 - t) / 0.25;
      const escape = t > 0.6 ? (t - 0.6) * (t - 0.6) * 2.2 : 0;
      for (let sIdx = 0; sIdx < rec.count; sIdx += 1) {
        const sprite = rec.sprites[sIdx]!;
        const ang = rec.phases[sIdx]! + rec.ageSeconds * cfg.omega;
        const r = rec.radii0[sIdx]! + t * cfg.growth + escape;
        sprite.position.set(
          rec.x + Math.cos(ang) * r,
          rec.y + Math.sin(rec.ageSeconds * 5 + rec.flut[sIdx]!) * 0.07,
          rec.z + Math.sin(ang) * r,
        );
      }
    }
  }
}

function createSplashRecord(scene: Scene, geometry: RingGeometry, sprite: Texture): SplashRecord {
  const material = new MeshBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 0,
    blending: AdditiveBlending,
    depthWrite: false,
    side: DoubleSide,
    fog: false,
  });
  const mesh = new Mesh(geometry, material);
  mesh.visible = false;
  mesh.renderOrder = RENDER_ORDER;
  mesh.frustumCulled = false;
  mesh.rotation.set(-Math.PI / 2, 0, 0);
  scene.add(mesh);

  const innerMaterial = new MeshBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 0,
    blending: AdditiveBlending,
    depthWrite: false,
    side: DoubleSide,
    fog: false,
  });
  const inner = new Mesh(geometry, innerMaterial);
  inner.visible = false;
  inner.renderOrder = RENDER_ORDER;
  inner.frustumCulled = false;
  inner.rotation.set(-Math.PI / 2, 0, 0);
  scene.add(inner);

  const glowMaterial = new SpriteMaterial({
    map: sprite,
    color: 0xffffff,
    transparent: true,
    opacity: 0,
    blending: AdditiveBlending,
    depthWrite: false,
    fog: false,
  });
  const glow = new Sprite(glowMaterial);
  glow.visible = false;
  glow.renderOrder = RENDER_ORDER;
  glow.frustumCulled = false;
  scene.add(glow);

  return { alive: false, ageSeconds: 0, lifeSeconds: 1, mesh, material, glow, glowMaterial, inner, innerMaterial, popScale: 1 };
}

function createImplosionRecord(scene: Scene, spriteTexture: Texture): ImplosionRecord {
  const count = FX_CONFIG.hitFx.implosion.sprites;
  const sprites: Sprite[] = [];
  const spriteMaterials: SpriteMaterial[] = [];
  for (let i = 0; i < count; i += 1) {
    const material = makeSpriteMaterial(spriteTexture);
    const sprite = new Sprite(material);
    sprite.visible = false;
    sprite.renderOrder = RENDER_ORDER;
    sprite.frustumCulled = false;
    scene.add(sprite);
    sprites.push(sprite);
    spriteMaterials.push(material);
  }
  const centerMaterial = makeSpriteMaterial(spriteTexture);
  const center = new Sprite(centerMaterial);
  center.visible = false;
  center.renderOrder = RENDER_ORDER;
  center.frustumCulled = false;
  scene.add(center);
  return {
    alive: false,
    ageSeconds: 0,
    lifeSeconds: 1,
    x: 0,
    y: 0,
    z: 0,
    count,
    start: new Float32Array(count * 3),
    sprites,
    spriteMaterials,
    center,
    centerMaterial,
    popScale: 1,
  };
}

function createDischargeRecord(scene: Scene, geometry: CylinderGeometry, spriteTexture: Texture): DischargeRecord {
  const tipMaterial = makeSpriteMaterial(spriteTexture);
  const lineCount = FX_CONFIG.hitFx.discharge.lines;
  const bolts: DischargeBoltSlot[] = [];
  for (let i = 0; i < lineCount; i += 1) {
    const material = new MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0,
      blending: AdditiveBlending,
      depthWrite: false,
      fog: false,
    });
    const segmentA = new Mesh(geometry, material);
    const segmentB = new Mesh(geometry, material);
    segmentA.visible = false;
    segmentB.visible = false;
    segmentA.renderOrder = RENDER_ORDER;
    segmentB.renderOrder = RENDER_ORDER;
    segmentA.frustumCulled = false;
    segmentB.frustumCulled = false;
    scene.add(segmentA);
    scene.add(segmentB);
    const tip = new Sprite(tipMaterial);
    tip.visible = false;
    tip.renderOrder = RENDER_ORDER;
    tip.frustumCulled = false;
    scene.add(tip);
    bolts.push({ segmentA, segmentB, material, tip, dirX: 1, dirY: 0, dirZ: 0, sideX: 0, sideZ: 1 });
  }
  const flashMaterial = makeSpriteMaterial(spriteTexture);
  const flash = new Sprite(flashMaterial);
  flash.visible = false;
  flash.renderOrder = RENDER_ORDER;
  flash.frustumCulled = false;
  scene.add(flash);
  return {
    alive: false,
    ageSeconds: 0,
    lifeSeconds: 1,
    x: 0,
    y: 0,
    z: 0,
    reach: 1,
    jitter: 0,
    count: lineCount,
    bolts,
    flash,
    flashMaterial,
    tipMaterial,
  };
}

function createEmberRecord(scene: Scene, spriteTexture: Texture): EmberRecord {
  const count = FX_CONFIG.hitFx.emberburst.sprites;
  const sprites: Sprite[] = [];
  const spriteMaterials: SpriteMaterial[] = [];
  for (let i = 0; i < count; i += 1) {
    const material = makeSpriteMaterial(spriteTexture);
    const sprite = new Sprite(material);
    sprite.visible = false;
    sprite.renderOrder = RENDER_ORDER;
    sprite.frustumCulled = false;
    scene.add(sprite);
    sprites.push(sprite);
    spriteMaterials.push(material);
  }
  return {
    alive: false,
    ageSeconds: 0,
    lifeSeconds: 1,
    count,
    startR: 1,
    startG: 1,
    startB: 1,
    vx: new Float32Array(count),
    vy: new Float32Array(count),
    vz: new Float32Array(count),
    scale: new Float32Array(count),
    stuck: new Uint8Array(count),
    sprites,
    spriteMaterials,
  };
}

function makeSpriteMaterial(sprite: Texture): SpriteMaterial {
  return new SpriteMaterial({
    map: sprite,
    color: 0xffffff,
    transparent: true,
    opacity: 0,
    blending: AdditiveBlending,
    depthWrite: false,
    fog: false,
  });
}

function takeSplashRecord(records: SplashRecord[]): SplashRecord {
  let chosen = records[0]!;
  for (let i = 0; i < records.length; i += 1) {
    const rec = records[i]!;
    if (!rec.alive) return rec;
    if (rec.ageSeconds > chosen.ageSeconds) chosen = rec;
  }
  hideSplash(chosen);
  return chosen;
}

function takeImplosionRecord(records: ImplosionRecord[]): ImplosionRecord {
  let chosen = records[0]!;
  for (let i = 0; i < records.length; i += 1) {
    const rec = records[i]!;
    if (!rec.alive) return rec;
    if (rec.ageSeconds > chosen.ageSeconds) chosen = rec;
  }
  hideImplosion(chosen);
  return chosen;
}

function takeDischargeRecord(records: DischargeRecord[]): DischargeRecord {
  let chosen = records[0]!;
  for (let i = 0; i < records.length; i += 1) {
    const rec = records[i]!;
    if (!rec.alive) return rec;
    if (rec.ageSeconds > chosen.ageSeconds) chosen = rec;
  }
  hideDischarge(chosen);
  return chosen;
}

function takeEmberRecord(records: EmberRecord[]): EmberRecord {
  let chosen = records[0]!;
  for (let i = 0; i < records.length; i += 1) {
    const rec = records[i]!;
    if (!rec.alive) return rec;
    if (rec.ageSeconds > chosen.ageSeconds) chosen = rec;
  }
  hideEmber(chosen);
  return chosen;
}

function hideSplash(rec: SplashRecord): void {
  rec.alive = false;
  rec.mesh.visible = false;
  rec.material.opacity = 0;
  rec.inner.visible = false;
  rec.innerMaterial.opacity = 0;
  rec.glow.visible = false;
  rec.glowMaterial.opacity = 0;
}

function hideImplosion(rec: ImplosionRecord): void {
  rec.alive = false;
  for (let i = 0; i < rec.sprites.length; i += 1) {
    rec.sprites[i]!.visible = false;
    rec.spriteMaterials[i]!.opacity = 0;
  }
  rec.center.visible = false;
  rec.centerMaterial.opacity = 0;
}

function hideDischarge(rec: DischargeRecord): void {
  rec.alive = false;
  for (let i = 0; i < rec.bolts.length; i += 1) {
    const slot = rec.bolts[i]!;
    slot.segmentA.visible = false;
    slot.segmentB.visible = false;
    slot.tip.visible = false;
    slot.material.opacity = 0;
  }
  rec.flash.visible = false;
  rec.flashMaterial.opacity = 0;
  rec.tipMaterial.opacity = 0;
}

function hideEmber(rec: EmberRecord): void {
  rec.alive = false;
  for (let i = 0; i < rec.sprites.length; i += 1) {
    rec.sprites[i]!.visible = false;
    rec.spriteMaterials[i]!.opacity = 0;
    rec.stuck[i] = 0;
  }
}


function createShatterRecord(scene: Scene, geometry: CylinderGeometry, spriteTexture: Texture): ShatterRecord {
  const cfg = FX_CONFIG.hitFx.shatter;
  const material = new MeshBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 0,
    blending: AdditiveBlending,
    depthWrite: false,
    fog: false,
  });
  const shards: Mesh<CylinderGeometry, MeshBasicMaterial>[] = [];
  for (let i = 0; i < cfg.shards; i += 1) {
    const shard = new Mesh(geometry, material);
    shard.visible = false;
    shard.renderOrder = RENDER_ORDER;
    shard.frustumCulled = false;
    scene.add(shard);
    shards.push(shard);
  }
  const glintMaterial = makeSpriteMaterial(spriteTexture);
  const glint = new Sprite(glintMaterial);
  glint.visible = false;
  glint.renderOrder = RENDER_ORDER;
  glint.frustumCulled = false;
  scene.add(glint);
  return {
    alive: false,
    ageSeconds: 0,
    lifeSeconds: 1,
    x: 0,
    y: 0,
    z: 0,
    count: cfg.shards,
    shards,
    material,
    glint,
    glintMaterial,
    dirs: new Float32Array(cfg.shards * 3),
    lens: new Float32Array(cfg.shards),
    spins: new Float32Array(cfg.shards),
  };
}

function createGeyserRecord(scene: Scene, geometry: CylinderGeometry, spriteTexture: Texture): GeyserRecord {
  const cfg = FX_CONFIG.hitFx.geyser;
  const material = makeSpriteMaterial(spriteTexture);
  const sprites: Sprite[] = [];
  for (let i = 0; i < cfg.sprites; i += 1) {
    const sprite = new Sprite(material);
    sprite.visible = false;
    sprite.renderOrder = RENDER_ORDER;
    sprite.frustumCulled = false;
    scene.add(sprite);
    sprites.push(sprite);
  }
  const columnMaterial = new MeshBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 0,
    blending: AdditiveBlending,
    depthWrite: false,
    fog: false,
  });
  const column = new Mesh(geometry, columnMaterial);
  column.visible = false;
  column.renderOrder = RENDER_ORDER;
  column.frustumCulled = false;
  scene.add(column);
  return {
    alive: false,
    ageSeconds: 0,
    lifeSeconds: 1,
    count: cfg.sprites,
    sprites,
    material,
    vx: new Float32Array(cfg.sprites),
    vy: new Float32Array(cfg.sprites),
    vz: new Float32Array(cfg.sprites),
    column,
    columnMaterial,
  };
}

function createPetalRecord(scene: Scene, geometry: PlaneGeometry): PetalRecord {
  const cfg = FX_CONFIG.hitFx.petals;
  const material = new MeshBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 0,
    blending: AdditiveBlending,
    depthWrite: false,
    side: DoubleSide,
    fog: false,
  });
  const petals: Mesh<PlaneGeometry, MeshBasicMaterial>[] = [];
  for (let i = 0; i < cfg.petals; i += 1) {
    const petal = new Mesh(geometry, material);
    petal.visible = false;
    petal.renderOrder = RENDER_ORDER;
    petal.frustumCulled = false;
    scene.add(petal);
    petals.push(petal);
  }
  return {
    alive: false,
    ageSeconds: 0,
    lifeSeconds: 1,
    x: 0,
    y: 0,
    z: 0,
    count: cfg.petals,
    petals,
    material,
    angles: new Float32Array(cfg.petals),
  };
}

function createOrbitRecord(scene: Scene, spriteTexture: Texture): OrbitRecord {
  const cfg = FX_CONFIG.hitFx.orbit;
  const material = makeSpriteMaterial(spriteTexture);
  const sprites: Sprite[] = [];
  for (let i = 0; i < cfg.sprites; i += 1) {
    const sprite = new Sprite(material);
    sprite.visible = false;
    sprite.renderOrder = RENDER_ORDER;
    sprite.frustumCulled = false;
    scene.add(sprite);
    sprites.push(sprite);
  }
  return {
    alive: false,
    ageSeconds: 0,
    lifeSeconds: 1,
    x: 0,
    y: 0,
    z: 0,
    count: cfg.sprites,
    sprites,
    material,
    phases: new Float32Array(cfg.sprites),
    radii0: new Float32Array(cfg.sprites),
    flut: new Float32Array(cfg.sprites),
  };
}

function takeShatterRecord(records: ShatterRecord[]): ShatterRecord {
  let chosen = records[0]!;
  for (let i = 0; i < records.length; i += 1) {
    const rec = records[i]!;
    if (!rec.alive) return rec;
    if (rec.ageSeconds > chosen.ageSeconds) chosen = rec;
  }
  hideShatter(chosen);
  return chosen;
}

function takeGeyserRecord(records: GeyserRecord[]): GeyserRecord {
  let chosen = records[0]!;
  for (let i = 0; i < records.length; i += 1) {
    const rec = records[i]!;
    if (!rec.alive) return rec;
    if (rec.ageSeconds > chosen.ageSeconds) chosen = rec;
  }
  hideGeyser(chosen);
  return chosen;
}

function takePetalRecord(records: PetalRecord[]): PetalRecord {
  let chosen = records[0]!;
  for (let i = 0; i < records.length; i += 1) {
    const rec = records[i]!;
    if (!rec.alive) return rec;
    if (rec.ageSeconds > chosen.ageSeconds) chosen = rec;
  }
  hidePetals(chosen);
  return chosen;
}

function takeOrbitRecord(records: OrbitRecord[]): OrbitRecord {
  let chosen = records[0]!;
  for (let i = 0; i < records.length; i += 1) {
    const rec = records[i]!;
    if (!rec.alive) return rec;
    if (rec.ageSeconds > chosen.ageSeconds) chosen = rec;
  }
  hideOrbit(chosen);
  return chosen;
}

function hideShatter(rec: ShatterRecord): void {
  rec.alive = false;
  for (let i = 0; i < rec.shards.length; i += 1) rec.shards[i]!.visible = false;
  rec.material.opacity = 0;
  rec.glint.visible = false;
  rec.glintMaterial.opacity = 0;
}

function hideGeyser(rec: GeyserRecord): void {
  rec.alive = false;
  for (let i = 0; i < rec.sprites.length; i += 1) rec.sprites[i]!.visible = false;
  rec.material.opacity = 0;
  rec.column.visible = false;
  rec.columnMaterial.opacity = 0;
}

function hidePetals(rec: PetalRecord): void {
  rec.alive = false;
  for (let i = 0; i < rec.petals.length; i += 1) rec.petals[i]!.visible = false;
  rec.material.opacity = 0;
}

function hideOrbit(rec: OrbitRecord): void {
  rec.alive = false;
  for (let i = 0; i < rec.sprites.length; i += 1) rec.sprites[i]!.visible = false;
  rec.material.opacity = 0;
}

function easeOutCubic(t: number): number {
  const inv = 1 - t;
  return 1 - inv * inv * inv;
}
