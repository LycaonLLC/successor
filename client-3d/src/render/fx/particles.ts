import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  LinearFilter,
  NormalBlending,
  Points,
  ShaderMaterial,
  type Blending,
  type Scene,
  type Vector3,
} from "three";
import { FX_CONFIG, type BloodPalette } from "./config";

/**
 * Two additive / normal-blend GPU point layers driven by a tiny CPU particle
 * sim (ported from the approved Pawn Forge v1 hitFx.js). Particles live in
 * WORLD space and fall to the ground plane. Point size is computed for the
 * orthographic camera (no perspective depth-divide), in render-target pixels.
 *
 * Zero per-frame allocations: all sim state lives in pre-allocated Float32Array
 * ring buffers; emission writes fixed fields; update uses module-scope scratch.
 */

interface ParticleLayerState {
  points: Points;
  geo: BufferGeometry;
  mat: ShaderMaterial;
  drag: number;
  max: number;
  pos: Float32Array;
  col: Float32Array;
  aAlpha: Float32Array;
  aSize: Float32Array;
  vx: Float32Array;
  vy: Float32Array;
  vz: Float32Array;
  life: Float32Array;
  maxLife: Float32Array;
  grav: Float32Array;
  s0: Float32Array;
  s1: Float32Array;
  aPeak: Float32Array;
  c0: Float32Array;
  c1: Float32Array;
  cursor: number;
}

// --- procedural textures (no external files) --------------------------------

/** Soft round additive sprite with a bright solid core (shared by all points). */
export function makeGlowSprite(): CanvasTexture {
  const size = FX_CONFIG.particles.glowSpriteSize;
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const g = c.getContext("2d")!;
  const half = size / 2;
  const grd = g.createRadialGradient(half, half, 0, half, half, half);
  grd.addColorStop(0.0, "rgba(255,255,255,1)");
  grd.addColorStop(0.3, "rgba(255,255,255,0.95)");
  grd.addColorStop(0.65, "rgba(255,255,255,0.35)");
  grd.addColorStop(1.0, "rgba(255,255,255,0)");
  g.fillStyle = grd;
  g.fillRect(0, 0, size, size);
  const t = new CanvasTexture(c);
  t.minFilter = LinearFilter;
  return t;
}


// --- layer factory ----------------------------------------------------------

const POINT_VERTEX = `
  attribute vec3 aColor;
  attribute float aAlpha;
  attribute float aSize;
  varying vec3 vColor;
  varying float vAlpha;
  uniform float uScale;
  void main() {
    vColor = aColor;
    vAlpha = aAlpha;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = aSize * uScale;
    gl_Position = projectionMatrix * mv;
  }
`;

const POINT_FRAGMENT = `
  uniform sampler2D map;
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    if (vAlpha <= 0.003) discard;
    vec4 t = texture2D(map, gl_PointCoord);
    gl_FragColor = vec4(vColor, vAlpha) * t;
  }
`;

function makeLayer(sprite: CanvasTexture, blending: Blending, drag: number, max: number): ParticleLayerState {
  const geo = new BufferGeometry();
  const pos = new Float32Array(max * 3);
  const col = new Float32Array(max * 3);
  const aAlpha = new Float32Array(max);
  const aSize = new Float32Array(max);
  geo.setAttribute("position", new BufferAttribute(pos, 3));
  geo.setAttribute("aColor", new BufferAttribute(col, 3));
  geo.setAttribute("aAlpha", new BufferAttribute(aAlpha, 1));
  geo.setAttribute("aSize", new BufferAttribute(aSize, 1));

  const mat = new ShaderMaterial({
    uniforms: { map: { value: sprite }, uScale: { value: 1 } },
    transparent: true,
    depthWrite: false,
    blending,
    vertexShader: POINT_VERTEX,
    fragmentShader: POINT_FRAGMENT,
  });
  const points = new Points(geo, mat);
  points.frustumCulled = false;
  points.renderOrder = 10;

  return {
    points, geo, mat, drag, max,
    pos, col, aAlpha, aSize,
    vx: new Float32Array(max), vy: new Float32Array(max), vz: new Float32Array(max),
    life: new Float32Array(max), maxLife: new Float32Array(max), grav: new Float32Array(max),
    s0: new Float32Array(max), s1: new Float32Array(max), aPeak: new Float32Array(max),
    c0: new Float32Array(max * 3), c1: new Float32Array(max * 3),
    cursor: 0,
  };
}

// Push one particle into a layer ring buffer (17 logical fields, zero alloc).
function pushParticle(
  L: ParticleLayerState,
  px: number, py: number, pz: number,
  vx: number, vy: number, vz: number,
  life: number, s0: number, s1: number, aPeak: number, grav: number,
  c0r: number, c0g: number, c0b: number, c1r: number, c1g: number, c1b: number,
): void {
  const i = L.cursor;
  L.cursor = (i + 1) % L.max;
  const i3 = i * 3;
  L.pos[i3] = px; L.pos[i3 + 1] = py; L.pos[i3 + 2] = pz;
  L.vx[i] = vx; L.vy[i] = vy; L.vz[i] = vz;
  L.life[i] = life; L.maxLife[i] = life; L.grav[i] = grav;
  L.s0[i] = s0; L.s1[i] = s1; L.aPeak[i] = aPeak;
  L.c0[i3] = c0r; L.c0[i3 + 1] = c0g; L.c0[i3 + 2] = c0b;
  L.c1[i3] = c1r; L.c1[i3 + 1] = c1g; L.c1[i3 + 2] = c1b;
}

function stepLayer(L: ParticleLayerState, dt: number, uScale: number, groundY: number): void {
  L.mat.uniforms.uScale!.value = uScale;
  const max = L.max;
  const drag = L.drag;
  for (let i = 0; i < max; i++) {
    const lifeI = L.life[i]!;
    if (lifeI <= 0) continue;
    const remaining = lifeI - dt;
    L.life[i] = remaining;
    if (remaining <= 0) {
      L.aAlpha[i] = 0;
      continue;
    }
    const i3 = i * 3;
    const vx = L.vx[i]!;
    const vy = L.vy[i]!;
    const vz = L.vz[i]!;
    L.pos[i3] = L.pos[i3]! + vx * dt;
    let ny = L.pos[i3 + 1]! + vy * dt;
    L.pos[i3 + 2] = L.pos[i3 + 2]! + vz * dt;
    let nvy = vy - L.grav[i]! * dt;
    // settle on the ground with a damped splat
    if (ny < groundY) {
      ny = groundY;
      nvy *= -0.18;
      L.vx[i] = vx * 0.4;
      L.vz[i] = vz * 0.4;
    }
    L.pos[i3 + 1] = ny;
    L.vy[i] = nvy;
    const d = Math.max(0, 1 - drag * dt);
    L.vx[i] = L.vx[i]! * d;
    L.vz[i] = L.vz[i]! * d;
    const frac = remaining / L.maxLife[i]!; // 1 -> 0
    L.aSize[i] = L.s1[i]! + (L.s0[i]! - L.s1[i]!) * frac;
    L.aAlpha[i] = L.aPeak[i]! * Math.min(1, frac * 1.6);
    L.col[i3] = L.c1[i3]! + (L.c0[i3]! - L.c1[i3]!) * frac;
    L.col[i3 + 1] = L.c1[i3 + 1]! + (L.c0[i3 + 1]! - L.c1[i3 + 1]!) * frac;
    L.col[i3 + 2] = L.c1[i3 + 2]! + (L.c0[i3 + 2]! - L.c1[i3 + 2]!) * frac;
  }
  L.geo.attributes.position!.needsUpdate = true;
  (L.geo.attributes.aColor as BufferAttribute).needsUpdate = true;
  (L.geo.attributes.aAlpha as BufferAttribute).needsUpdate = true;
  (L.geo.attributes.aSize as BufferAttribute).needsUpdate = true;
}

// --- scratch (module scope, reused across calls) ----------------------------
const _emitV = new Float32Array(3); // [x,y,z] scratch for burst directions

export interface CreatureDeathBurstParticlePlan {
  droplets: number;
  drips: number;
  residue: number;
}

export function creatureDeathBurstParticlePlan(mag: number): CreatureDeathBurstParticlePlan {
  return {
    droplets: Math.max(18, Math.round(22 * mag)),
    drips: Math.max(6, Math.round(7 * mag)),
    residue: Math.max(8, Math.round(10 * mag)),
  };
}

export class ParticleLayers {
  readonly additive: ParticleLayerState;
  readonly normal: ParticleLayerState;
  /**
   * Residue layer: 10-18s ground stains. Own ring so long-lived splats never
   * compete with 0.3-1.4s droplets for slots — a 512-deep transient ring
   * wraps in seconds under sustained fire and would evict "persistent"
   * stains mid-fight (capacity ruling 2026-07-08).
   */
  readonly residue: ParticleLayerState;

  constructor(scene: Scene, sprite: CanvasTexture) {
    this.additive = makeLayer(sprite, AdditiveBlending, FX_CONFIG.muzzle.flashDrag, FX_CONFIG.particles.additiveMax);
    this.normal = makeLayer(sprite, NormalBlending, 1.2, FX_CONFIG.particles.normalMax);
    this.residue = makeLayer(sprite, NormalBlending, 0, FX_CONFIG.particles.residueMax);
    // Keep the normal-blend point layer available for shared non-additive puffs.
    this.normal.points.renderOrder = 10;
    this.residue.points.renderOrder = 9;
    scene.add(this.additive.points);
    scene.add(this.normal.points);
    scene.add(this.residue.points);
  }

  /** Raw additive-layer push (used by muzzle.ts for the flash core/cone). */
  pushAdditive(
    px: number, py: number, pz: number,
    vx: number, vy: number, vz: number,
    life: number, s0: number, s1: number, aPeak: number, grav: number,
    c0r: number, c0g: number, c0b: number, c1r: number, c1g: number, c1b: number,
  ): void {
    pushParticle(this.additive, px, py, pz, vx, vy, vz, life, s0, s1, aPeak, grav, c0r, c0g, c0b, c1r, c1g, c1b);
    this.additive.geo.attributes.position!.needsUpdate = true;
  }

  update(dt: number, uScale: number): void {
    if (dt <= 0) return;
    stepLayer(this.additive, dt, uScale, FX_CONFIG.groundY);
    stepLayer(this.normal, dt, uScale, FX_CONFIG.groundY);
    stepLayer(this.residue, dt, uScale, FX_CONFIG.groundY);
  }

  /**
   * Spark burst (additive): a ricochet cone of hot streaks + a few fat impact
   * pops. Used for shield / dodge / deflect hits (no decal).
   *   point   world impact position
   *   normal  surface normal (spray bias)
   *   incoming shot travel direction (ricochet base)
   *   mag     severity multiplier (count + size + speed)
   */
  emitSparkBurst(point: Vector3, normal: Vector3, incoming: Vector3, mag: number): void {
    const sm = 0.84 + 0.16 * mag;
    const vm = 0.84 + 0.16 * mag;
    const cnt = (base: number) => Math.max(1, Math.round(base * mag));
    const jit = () => Math.random() * 2 - 1;
    const L = this.additive;
    // ricochet: reflect incoming about the normal
    const dn = incoming.x * normal.x + incoming.y * normal.y + incoming.z * normal.z;
    const rx = incoming.x - 2 * dn * normal.x;
    const ry = incoming.y - 2 * dn * normal.y;
    const rz = incoming.z - 2 * dn * normal.z;
    const bx = rx * 0.7 + normal.x * 0.4;
    const by = ry * 0.7 + normal.y * 0.4;
    const bz = rz * 0.7 + normal.z * 0.4;
    const streaks = cnt(FX_CONFIG.hit.sparkStreakCount);
    for (let k = 0; k < streaks; k++) {
      _emitV[0] = bx + jit() * 0.7;
      _emitV[1] = by + jit() * 0.7 + 0.15;
      _emitV[2] = bz + jit() * 0.7;
      normalize3(_emitV);
      const sp = (2.6 + Math.random() * 4.5) * vm;
      const life = 0.16 + Math.random() * 0.3;
      const sz = (0.013 + Math.random() * 0.022) * sm;
      pushParticle(L, point.x, point.y, point.z, _emitV[0]! * sp, _emitV[1]! * sp, _emitV[2]! * sp, life,
        sz, sz * 0.2, 1.0, 9.5,
        1.0, 0.95, 0.62, 1.0, 0.32, 0.06);
    }
    const flashes = cnt(FX_CONFIG.hit.sparkFlashCount);
    for (let k = 0; k < flashes; k++) {
      _emitV[0] = normal.x + jit() * 0.5;
      _emitV[1] = normal.y + jit() * 0.5;
      _emitV[2] = normal.z + jit() * 0.5;
      normalize3(_emitV);
      const life = 0.05 + Math.random() * 0.05;
      const sz = (0.05 + Math.random() * 0.035) * sm;
      pushParticle(L, point.x, point.y, point.z, _emitV[0]! * 0.6, _emitV[1]! * 0.6, _emitV[2]! * 0.6, life,
        sz, sz * 0.4, 1.0, 0.0,
        1.0, 0.92, 0.7, 1.0, 0.6, 0.3);
    }
    L.geo.attributes.position!.needsUpdate = true;
  }

  /**
   * Blood burst (normal blend): the classic 3D on-hit blood — a cone of
   * matte droplets biased along the shot direction plus a few heavy DRIPS
   * that arc down and splat on the ground (the layer's settle physics).
   *   point    world impact position (torso height)
   *   incoming shot travel direction
   *   mag      severity multiplier (count + speed); kills read heavier
   */
  emitBloodBurst(point: Vector3, incoming: Vector3, mag: number, palette: BloodPalette = FX_CONFIG.blood.palettes.red): void {
    const jit = () => Math.random() * 2 - 1;
    const L = this.normal;
    const [sprR, sprG, sprB] = palette.spray;
    const [drpR, drpG, drpB] = palette.drip;
    const droplets = Math.max(6, Math.round(10 * mag));
    for (let k = 0; k < droplets; k++) {
      // Spray cone: mostly forward along the shot, wide jitter, upward bias.
      _emitV[0] = incoming.x * 0.8 + jit() * 0.55;
      _emitV[1] = 0.45 + Math.random() * 0.5;
      _emitV[2] = incoming.z * 0.8 + jit() * 0.55;
      normalize3(_emitV);
      const sp = (1.4 + Math.random() * 2.2) * (0.8 + 0.2 * mag);
      const life = 0.34 + Math.random() * 0.3;
      const sz = 0.028 + Math.random() * 0.03;
      pushParticle(L, point.x, point.y, point.z, _emitV[0]! * sp, _emitV[1]! * sp, _emitV[2]! * sp, life,
        sz, sz * 0.55, 0.95, 7.5,
        sprR!, sprG!, sprB!, sprR! * 0.4, sprG! * 0.4, sprB! * 0.6);
    }
    // Heavy drips: slower, bigger, longer-lived — they fall and splat.
    const drips = Math.max(2, Math.round(3 * mag));
    for (let k = 0; k < drips; k++) {
      const sp = 0.35 + Math.random() * 0.5;
      const life = 0.9 + Math.random() * 0.5;
      const sz = 0.042 + Math.random() * 0.028;
      pushParticle(L, point.x + jit() * 0.08, point.y - 0.1, point.z + jit() * 0.08,
        jit() * sp * 0.4, -0.2 - Math.random() * 0.4, jit() * sp * 0.4, life,
        sz, sz * 0.8, 0.9, 5.5,
        drpR!, drpG!, drpB!, drpR! * 0.4, drpG! * 0.4, drpB! * 0.55);
    }
    this.emitBloodResidue(point, incoming, mag, palette);
    L.geo.attributes.position!.needsUpdate = true;
  }

  /**
   * Persistent ground residue for a blood hit (owner brief 2026-07-08:
   * "ground bloodspats... make everything better"). Splats pin to the
   * ground plane and outlive the flying droplets — the fight leaves a
   * readable stain map. Biased FORWARD along the shot: blood carries
   * through the target and lands past it.
   */
  private emitBloodResidue(point: Vector3, incoming: Vector3, mag: number, palette: BloodPalette): void {
    const jit = () => Math.random() * 2 - 1;
    const L = this.residue;
    const cfg = FX_CONFIG.blood;
    const [resR, resG, resB] = palette.residue;
    const splats = Math.max(1, Math.round(cfg.residuePerHit * (0.7 + 0.5 * mag)));
    for (let k = 0; k < splats; k++) {
      const forward = 0.1 + Math.random() * 0.55;
      const side = jit() * 0.3;
      const life = cfg.residueLifeMinS + Math.random() * (cfg.residueLifeMaxS - cfg.residueLifeMinS);
      const sz = (0.07 + Math.random() * 0.09) * (0.85 + 0.3 * mag);
      pushParticle(L,
        point.x + incoming.x * forward - incoming.z * side,
        FX_CONFIG.groundY + 0.006,
        point.z + incoming.z * forward + incoming.x * side,
        0, 0, 0, life,
        sz, sz * 1.15, 0.44, 0,
        resR!, resG!, resB!, resR! * 0.42, resG! * 0.42, resB! * 0.5);
    }
    L.geo.attributes.position!.needsUpdate = true;
  }

  /**
   * Creature death burst (normal blend): a radial organic pop. It deliberately
   * reuses the blood vocabulary rather than fragments, so the rigged corpse
   * remains readable as the harvest target after the flourish.
   */
  emitCreatureDeathBurst(point: Vector3, seed: number, mag: number, palette: BloodPalette = FX_CONFIG.blood.palettes.red): void {
    const [sprR, sprG, sprB] = palette.spray;
    const [drpR, drpG, drpB] = palette.drip;
    const [resR, resG, resB] = palette.residue;
    const L = this.normal;
    const plan = creatureDeathBurstParticlePlan(mag);
    const baseAngle = (seededUnit(seed, 3) * Math.PI * 2);
    const droplets = plan.droplets;
    for (let k = 0; k < droplets; k++) {
      const angle = baseAngle + (k / droplets) * Math.PI * 2 + (seededUnit(seed, k * 17 + 5) - 0.5) * 0.34;
      const out = 1.0 + seededUnit(seed, k * 19 + 7) * 1.8;
      const up = 0.36 + seededUnit(seed, k * 23 + 11) * 0.9;
      const life = 0.34 + seededUnit(seed, k * 29 + 13) * 0.38;
      const sz = 0.034 + seededUnit(seed, k * 31 + 17) * 0.038;
      const ca = Math.cos(angle);
      const sa = Math.sin(angle);
      pushParticle(L, point.x + ca * 0.06, point.y, point.z + sa * 0.06,
        ca * out, up, sa * out, life,
        sz, sz * 0.52, 0.98, 7.8,
        sprR! * 1.06, sprG! * 1.06, sprB! * 1.06, sprR! * 0.38, sprG! * 0.38, sprB! * 0.55);
    }
    const drips = plan.drips;
    for (let k = 0; k < drips; k++) {
      const angle = baseAngle + seededUnit(seed, k * 37 + 41) * Math.PI * 2;
      const sp = 0.32 + seededUnit(seed, k * 41 + 43) * 0.62;
      const life = 0.95 + seededUnit(seed, k * 43 + 47) * 0.6;
      const sz = 0.052 + seededUnit(seed, k * 47 + 53) * 0.03;
      const ca = Math.cos(angle);
      const sa = Math.sin(angle);
      pushParticle(L, point.x + ca * 0.1, point.y - 0.08, point.z + sa * 0.1,
        ca * sp, -0.1 - seededUnit(seed, k * 53 + 59) * 0.45, sa * sp, life,
        sz, sz * 0.74, 0.92, 5.6,
        drpR!, drpG!, drpB!, drpR! * 0.38, drpG! * 0.38, drpB! * 0.5);
    }
    // Persistent ground residue: flat-feeling dark red point splats pinned to
    // the ground plane. They outlive the flying droplets so a killed creature leaves
    // a harvestable corpse with visible blood context instead of a clean floor.
    const residue = plan.residue;
    const RL = this.residue;
    for (let k = 0; k < residue; k++) {
      const angle = baseAngle + seededUnit(seed, k * 61 + 67) * Math.PI * 2;
      const distance = 0.08 + seededUnit(seed, k * 67 + 71) * 0.38;
      const life = 12.0 + seededUnit(seed, k * 71 + 73) * 8.0;
      const sz = 0.09 + seededUnit(seed, k * 73 + 79) * 0.11;
      pushParticle(RL, point.x + Math.cos(angle) * distance, FX_CONFIG.groundY + 0.006, point.z + Math.sin(angle) * distance,
        0, 0, 0, life,
        sz, sz * 1.15, 0.44, 0,
        resR!, resG!, resB!, resR! * 0.42, resG! * 0.42, resB! * 0.5);
    }
    RL.geo.attributes.position!.needsUpdate = true;
    L.geo.attributes.position!.needsUpdate = true;
  }



  dispose(): void {
    for (const L of [this.additive, this.normal, this.residue]) {
      L.geo.dispose();
      L.mat.dispose();
    }
  }
}

function normalize3(v: Float32Array): void {
  const len = Math.hypot(v[0]!, v[1]!, v[2]!);
  if (len > 1e-5) {
    const inv = 1 / len;
    v[0] = v[0]! * inv;
    v[1] = v[1]! * inv;
    v[2] = v[2]! * inv;
  }
}

function seededUnit(seed: number, salt: number): number {
  let mixed = Math.imul(seed ^ Math.imul(salt, 374761393), 668265263);
  mixed = Math.imul(mixed ^ (mixed >>> 13), 1274126177);
  return ((mixed ^ (mixed >>> 16)) >>> 0) / 0xffffffff;
}
