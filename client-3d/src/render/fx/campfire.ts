import {
  AdditiveBlending,
  NormalBlending,
  Sprite,
  SpriteMaterial,
  Vector3,
  type Scene,
  type Texture,
} from "three";

/**
 * CampfireFx — persistent always-on world fire (owner brief 2026-07-08:
 * "campfire always on kind of fire"). NOT a transient: keyed handles live
 * until removed, looping forever.
 *
 * World drivers: every placed scout camp keeps one beside its door
 * (render/camps.ts via CombatFx.setWorldCampfire — the live-camp beacon);
 * the fx-lab CAMPFIRE toggle remains the bench test. Both feed the same
 * nearestDistance() crackle-loop audio driver.
 *
 * Reads (bottom to top): coal-bed glow pulsing slow → flame tongues cycling
 * upward with flicker → occasional fast spark pop → soft dark smoke puffs
 * rising and fading. A wide faint warm halo fakes ground light (no dynamic
 * lights in world per renderer constraints).
 *
 * Zero per-frame allocation; materials shared per campfire; dispose-clean.
 */

const TONGUES = 7;
const SMOKE_PUFFS = 3;
const COALS = 3;

interface Campfire {
  x: number;
  y: number;
  z: number;
  age: number;
  nextSparkAt: number;
  tongues: Sprite[];
  tongueSeeds: Float32Array;
  flameMat: SpriteMaterial;
  coals: Sprite[];
  coalSeeds: Float32Array;
  coalMat: SpriteMaterial;
  smoke: Sprite[];
  smokeSeeds: Float32Array;
  smokeMat: SpriteMaterial;
  spark: Sprite;
  sparkMat: SpriteMaterial;
  sparkLaunchedAt: number;
  halo: Sprite;
  haloMat: SpriteMaterial;
}

export class CampfireFx {
  private readonly fires = new Map<string, Campfire>();

  constructor(private readonly scene: Scene, private readonly sprite: Texture) {}

  /** Idempotent: re-adding an id moves it. */
  add(id: string, position: Vector3): void {
    const existing = this.fires.get(id);
    if (existing) {
      existing.x = position.x;
      existing.y = position.y;
      existing.z = position.z;
      return;
    }
    const flameMat = new SpriteMaterial({
      map: this.sprite, color: 0xff8a2a, transparent: true, opacity: 0.95,
      blending: AdditiveBlending, depthWrite: false, fog: false,
    });
    const coalMat = new SpriteMaterial({
      map: this.sprite, color: 0xff5a14, transparent: true, opacity: 0.8,
      blending: AdditiveBlending, depthWrite: false, fog: false,
    });
    const smokeMat = new SpriteMaterial({
      map: this.sprite, color: 0x2a2320, transparent: true, opacity: 0.35,
      blending: NormalBlending, depthWrite: false, fog: true,
    });
    const sparkMat = new SpriteMaterial({
      map: this.sprite, color: 0xffd27a, transparent: true, opacity: 0,
      blending: AdditiveBlending, depthWrite: false, fog: false,
    });
    const haloMat = new SpriteMaterial({
      map: this.sprite, color: 0xff9a3d, transparent: true, opacity: 0.16,
      blending: AdditiveBlending, depthWrite: false, fog: false,
    });
    const mk = (mat: SpriteMaterial, order: number): Sprite => {
      const s = new Sprite(mat);
      s.renderOrder = order;
      s.frustumCulled = false;
      this.scene.add(s);
      return s;
    };
    const fire: Campfire = {
      x: position.x, y: position.y, z: position.z,
      age: Math.random() * 10, nextSparkAt: 0.5,
      tongues: [], tongueSeeds: new Float32Array(TONGUES), flameMat,
      coals: [], coalSeeds: new Float32Array(COALS), coalMat,
      smoke: [], smokeSeeds: new Float32Array(SMOKE_PUFFS), smokeMat,
      spark: mk(sparkMat, 11), sparkMat, sparkLaunchedAt: -1,
      halo: mk(haloMat, 10), haloMat,
    };
    for (let i = 0; i < TONGUES; i += 1) {
      fire.tongueSeeds[i] = Math.random() * Math.PI * 2;
      fire.tongues.push(mk(flameMat, 11));
    }
    for (let i = 0; i < COALS; i += 1) {
      fire.coalSeeds[i] = Math.random() * Math.PI * 2;
      const c = mk(coalMat, 10);
      c.scale.set(0.16, 0.09, 0.16);
      c.position.set(
        position.x + (Math.random() - 0.5) * 0.22,
        position.y + 0.045,
        position.z + (Math.random() - 0.5) * 0.22,
      );
      fire.coals.push(c);
    }
    for (let i = 0; i < SMOKE_PUFFS; i += 1) {
      fire.smokeSeeds[i] = Math.random();
      fire.smoke.push(mk(smokeMat, 11));
    }
    fire.halo.scale.set(1.7, 1.0, 1.7);
    fire.halo.position.set(position.x, position.y + 0.12, position.z);
    this.fires.set(id, fire);
  }

  remove(id: string): void {
    const fire = this.fires.get(id);
    if (!fire) return;
    for (const s of [...fire.tongues, ...fire.coals, ...fire.smoke, fire.spark, fire.halo]) {
      s.parent?.remove(s);
    }
    fire.flameMat.dispose();
    fire.coalMat.dispose();
    fire.smokeMat.dispose();
    fire.sparkMat.dispose();
    fire.haloMat.dispose();
    this.fires.delete(id);
  }

  has(id: string): boolean {
    return this.fires.has(id);
  }

  /** Nearest campfire distance (world XZ units ≈ cells) to a point, or null. */
  nearestDistance(x: number, z: number): number | null {
    let best = Infinity;
    for (const fire of this.fires.values()) {
      const dx = fire.x - x;
      const dz = fire.z - z;
      const d = dx * dx + dz * dz;
      if (d < best) best = d;
    }
    return Number.isFinite(best) ? Math.sqrt(best) : null;
  }

  get activeCount(): number {
    return this.fires.size;
  }

  update(dt: number): void {
    if (dt <= 0) return;
    for (const fire of this.fires.values()) {
      fire.age += dt;
      // tongues: continuous upward cycle, per-tongue phase + flicker
      for (let i = 0; i < TONGUES; i += 1) {
        const seed = fire.tongueSeeds[i]!;
        const phase = (fire.age * (0.75 + (seed % 0.45)) + seed) % 1;
        const flick = 0.55 + 0.45 * Math.sin(fire.age * 12 + seed * 8);
        const w = 0.17 * (1 - phase * 0.55) * (0.72 + 0.28 * flick);
        const h = 0.34 * (1 - phase * 0.45);
        const t = fire.tongues[i]!;
        const wob = Math.sin(fire.age * 3.4 + seed * 5) * 0.045;
        t.position.set(
          fire.x + Math.cos(seed) * 0.09 + wob,
          fire.y + 0.08 + phase * 0.62,
          fire.z + Math.sin(seed) * 0.09 - wob * 0.5,
        );
        t.scale.set(w, h, w);
      }
      fire.flameMat.opacity = 0.88 + 0.1 * Math.sin(fire.age * 8.7);
      // coals: shared slow breathing (per-coal mats not worth it at iso distance)
      fire.coalMat.opacity = 0.62 + 0.22 * Math.sin(fire.age * 1.7);
      // smoke: slow rising loop above the flames
      for (let i = 0; i < SMOKE_PUFFS; i += 1) {
        const seed = fire.smokeSeeds[i]!;
        const phase = (fire.age * 0.22 + seed) % 1;
        const s = fire.smoke[i]!;
        s.position.set(
          fire.x + Math.sin(fire.age * 0.7 + seed * 9) * 0.12 * phase,
          fire.y + 0.75 + phase * 1.05,
          fire.z + Math.cos(fire.age * 0.6 + seed * 7) * 0.1 * phase,
        );
        const g = 0.16 + phase * 0.3;
        s.scale.set(g, g * 0.8, g);
      }
      fire.smokeMat.opacity = 0.32;
      // spark pops: one spark, random cadence
      if (fire.sparkLaunchedAt < 0 && fire.age >= fire.nextSparkAt) {
        fire.sparkLaunchedAt = fire.age;
        fire.spark.position.set(fire.x, fire.y + 0.3, fire.z);
        fire.spark.scale.set(0.04, 0.04, 0.04);
        fire.sparkMat.opacity = 1;
      }
      if (fire.sparkLaunchedAt >= 0) {
        const st = fire.age - fire.sparkLaunchedAt;
        if (st > 0.7) {
          fire.sparkLaunchedAt = -1;
          fire.nextSparkAt = fire.age + 0.6 + Math.random() * 1.1;
          fire.sparkMat.opacity = 0;
        } else {
          fire.spark.position.y = fire.y + 0.3 + st * 1.6;
          fire.spark.position.x = fire.x + Math.sin(st * 9) * 0.05;
          fire.sparkMat.opacity = 1 - st / 0.7;
        }
      }
      // halo: warm breathing ground light
      fire.haloMat.opacity = 0.13 + 0.05 * Math.sin(fire.age * 2.3);
    }
  }

  dispose(): void {
    for (const id of [...this.fires.keys()]) this.remove(id);
  }
}
