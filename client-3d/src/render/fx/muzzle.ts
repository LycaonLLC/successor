import {
  PointLight,
  Vector3,
} from "three";
import { FX_CONFIG } from "./config";
import type { ParticleLayers } from "./particles";

/**
 * Muzzle flash: a punchy 1-3 frame additive particle burst at the barrel tip
 * (fat core pop + forward cone of hot streaks + lazy embers) plus a brief warm
 * point-light pop. Point lights are budgeted to at most `maxSimultaneousLights`
 * concurrent — extra flashes in the same instant are sprite-only (particles
 * still render, no light). Ported from the approved Pawn Forge v1 weaponFx.js.
 *
 * The light is forward-compatible: current pawn materials are unlit
 * (MeshBasicMaterial) so the light is a no-op visually until lit materials
 * arrive, but the additive particles carry the visible flash regardless.
 */

const MAX_LIGHTS = FX_CONFIG.muzzle.maxSimultaneousLights;

export class MuzzleFx {
  private readonly particles: ParticleLayers;
  private readonly lights: PointLight[] = [];
  private readonly lightT = new Float32Array(MAX_LIGHTS);
  private readonly lightDur = new Float32Array(MAX_LIGHTS);
  private readonly lightPeak = new Float32Array(MAX_LIGHTS);

  // scratch (module-instance scope, reused)
  private readonly _u = new Vector3();
  private readonly _w = new Vector3();
  private readonly _tmp = new Vector3();
  private readonly _d = new Vector3();

  constructor(particles: ParticleLayers, addLight: (light: PointLight) => void) {
    this.particles = particles;
    for (let i = 0; i < MAX_LIGHTS; i++) {
      const light = new PointLight(FX_CONFIG.muzzle.lightColor, 0, FX_CONFIG.muzzle.lightDistance, FX_CONFIG.muzzle.lightDecay);
      light.visible = false;
      this.lights.push(light);
      addLight(light);
    }
  }

  /**
   * Fire a muzzle flash.
   *   point  world muzzle position
   *   dir    bore direction (world, need not be unit)
   *   mag    severity (1 = normal shot)
   *   color  optional hex color tint; null/undefined = warm default
   */
  flash(point: Vector3, dir: Vector3, mag: number, color: number | null): void {
    const d = this._d.copy(dir);
    const len = d.length();
    if (len > 1e-5) d.multiplyScalar(1 / len);
    this.basisPerp(d);

    const cfg = FX_CONFIG.muzzle;
    let r = 1.0, g = 0.7, b = 0.3;
    if (color != null) {
      r = ((color >> 16) & 255) / 255;
      g = ((color >> 8) & 255) / 255;
      b = (color & 255) / 255;
    }
    const cnt = (base: number) => Math.max(1, Math.round(base * mag));
    const P = this.particles;

    // 1) fat core pop right at the lip — a couple of fast-fading hot blobs
    const coreCount = cnt(cfg.coreCount);
    for (let k = 0; k < coreCount; k++) {
      const sz = (0.05 + Math.random() * 0.03) * (0.8 + 0.2 * mag);
      const c0r = Math.min(1, r + 0.2), c0g = Math.min(1, g + 0.2), c0b = Math.min(1, b + 0.2);
      const c1r = r * 0.8, c1g = g * 0.6, c1b = b * 0.6;
      P.pushAdditive(
        point.x + d.x * 0.02, point.y + d.y * 0.02, point.z + d.z * 0.02,
        d.x * 0.6, d.y * 0.6, d.z * 0.6,
        0.045 + Math.random() * 0.03, sz, sz * 0.35, 1.0, 0.0,
        c0r, c0g, c0b, c1r, c1g, c1b);
    }
    // 2) forward cone of hot spark streaks (mostly along the bore, slight spread)
    const coneCount = cnt(cfg.coneCount);
    for (let k = 0; k < coneCount; k++) {
      const ca = Math.random() * Math.PI * 2;
      const spread = 0.26 + Math.random() * 0.2;
      const t = this._tmp.set(
        d.x + this._u.x * (Math.cos(ca) * spread) + this._w.x * (Math.sin(ca) * spread),
        d.y + this._u.y * (Math.cos(ca) * spread) + this._w.y * (Math.sin(ca) * spread),
        d.z + this._u.z * (Math.cos(ca) * spread) + this._w.z * (Math.sin(ca) * spread));
      const tl = t.length();
      if (tl > 1e-5) t.multiplyScalar(1 / tl);
      const sp = (5.5 + Math.random() * 7.0) * (0.85 + 0.15 * mag);
      const life = 0.05 + Math.random() * 0.1;
      const sz = (0.022 + Math.random() * 0.028) * (0.85 + 0.15 * mag);
      P.pushAdditive(point.x, point.y, point.z, t.x * sp, t.y * sp, t.z * sp, life,
        sz, sz * 0.18, 1.0, 6.0, r, g, b, r * 0.5, g * 0.3, b * 0.3);
    }
    // 3) a few lazy embers that drift off and fall
    const emberCount = cnt(cfg.emberCount);
    for (let k = 0; k < emberCount; k++) {
      const ju = (Math.random() * 2 - 1) * 0.5;       // u-basis jitter
      const jw = (Math.random() * 2 - 1) * 0.5 + 0.1; // w-basis jitter (+drift bias)
      const t = this._tmp.set(d.x + this._u.x * ju + this._w.x * jw, d.y + this._u.y * ju + this._w.y * jw, d.z + this._u.z * ju + this._w.z * jw);
      const tl = t.length();
      if (tl > 1e-5) t.multiplyScalar(1 / tl);
      const sp = 0.8 + Math.random() * 1.8;
      const sz = 0.02 + Math.random() * 0.02;
      P.pushAdditive(point.x, point.y, point.z, t.x * sp, t.y * sp, t.z * sp,
        0.18 + Math.random() * 0.22, sz, sz * 0.4, 0.9, 7.0,
        r * 0.8, g * 0.6, b * 0.4, r * 0.3, g * 0.1, b * 0.05);
    }

    // 4) light pop — grab a free slot from the budgeted pool (sprite-only if full)
    const slot = this.freeLightSlot();
    if (slot >= 0) {
      const light = this.lights[slot]!;
      light.position.set(point.x + d.x * 0.04, point.y + d.y * 0.04, point.z + d.z * 0.04);
      light.color.setHex(color ?? FX_CONFIG.muzzle.lightColor);
      light.visible = true;
      this.lightPeak[slot] = cfg.lightPeak * (0.7 + 0.3 * mag);
      this.lightDur[slot] = cfg.lightDurationSec;
      this.lightT[slot] = cfg.lightDurationSec;
    }
  }

  update(dt: number): void {
    if (dt <= 0) return;
    for (let i = 0; i < MAX_LIGHTS; i++) {
      const t = this.lightT[i]!;
      if (t <= 0) continue;
      const nt = t - dt;
      this.lightT[i] = nt;
      if (nt <= 0) {
        this.lights[i]!.visible = false;
        this.lights[i]!.intensity = 0;
      } else {
        this.lights[i]!.intensity = this.lightPeak[i]! * (nt / this.lightDur[i]!);
      }
    }
  }

  /** Find an inactive light slot, or -1 if all are busy (sprite-only fallback). */
  private freeLightSlot(): number {
    for (let i = 0; i < MAX_LIGHTS; i++) {
      if (this.lightT[i]! <= 0) return i;
    }
    return -1;
  }

  /** Build an orthonormal pair (_u, _w) spanning the plane perpendicular to dir. */
  private basisPerp(dir: Vector3): void {
    this._tmp.set(0, 1, 0);
    if (Math.abs(dir.dot(this._tmp)) > 0.92) this._tmp.set(1, 0, 0);
    this._u.crossVectors(dir, this._tmp).normalize();
    this._w.crossVectors(dir, this._u).normalize();
  }

  dispose(): void {
    for (const light of this.lights) light.dispose();
    this.lights.length = 0;
  }
}
