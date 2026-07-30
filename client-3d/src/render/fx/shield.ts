import {
  FrontSide,
  Mesh,
  ShaderMaterial,
  SphereGeometry,
  Vector3,
  type Scene,
} from "three";
import type { PlayState } from "@successor/client/src/slice-core/gameState";
import { FX_CONFIG } from "./config";

/**
 * PsgShieldFx — the Personal Shield Generator dome (hand-authored shader,
 * owner brief 2026-07-08: "full custom shader set… esp the personal shield
 * generator, me want see better effect").
 *
 * The PSG identity uses a cyan pulse, short envelope, and radial world light.
 * This gives the belt shield its body: a fresnel-edged energy dome wrapped in a
 * scrolling hex lattice, with impact ripples that expand across the surface
 * FROM the blocked hit's direction. Designed for the ratified PS2 post pass:
 * the rim + ripple crests are pushed hot enough to feed the bloom extract,
 * while the dome interior stays faint so the pawn reads through it.
 *
 * House rules honoured:
 *  - pooled records, zero per-frame allocations (scratch Vector3s, fixed
 *    ripple slots as flat uniforms);
 *  - per-record materials created once at construction (tracer precedent);
 *  - all tunables in FX_CONFIG.psgShield;
 *  - additive, depthWrite off, fog off, renderOrder above tracers.
 *
 * Charge read: on block the target actor's personalShield charge tints the
 * dome — healthy shields hum cyan, a nearly-drained cell burns toward ember
 * amber. Pure presentation; the authoritative block already happened.
 *
 * Debug/demo: CombatFx exposes `window.__successorFx.psgTest()` which pops a
 * dome on the player pawn with three staggered ripples — used by the visual
 * verification harness and for live tuning.
 */

interface ShieldRecord {
  alive: boolean;
  actorId: string;
  mesh: Mesh;
  material: ShaderMaterial;
  ageSeconds: number;
  lifeSeconds: number;
  /** Ripple ages in seconds; < 0 = slot inactive. Mirrored into uniforms. */
  rippleAges: [number, number, number];
  nextRippleSlot: number;
}

interface ShieldStateActor {
  x: number;
  y: number;
  renderX?: number;
  renderY?: number;
  areaId?: string;
  personalShield?: { chargeMilli: number; maxChargeMilli: number } | null;
}

const SHIELD_VERTEX = /* glsl */ `
  varying vec3 vDir;
  varying vec3 vWorldNormal;
  varying vec3 vViewDir;

  void main() {
    vDir = normalize(position);
    vec4 worldPos = modelMatrix * vec4(position, 1.0);
    vWorldNormal = normalize(mat3(modelMatrix) * normal);
    vViewDir = normalize(cameraPosition - worldPos.xyz);
    gl_Position = projectionMatrix * viewMatrix * worldPos;
  }
`;

const SHIELD_FRAGMENT = /* glsl */ `
  uniform float uTime;
  uniform float uEnvelope;
  uniform float uCharge;
  uniform vec3 uBaseColor;
  uniform vec3 uLowColor;
  uniform vec3 uRippleDir0;
  uniform vec3 uRippleDir1;
  uniform vec3 uRippleDir2;
  uniform vec3 uRippleAges;   // x,y,z = ages in seconds; < 0.0 inactive
  uniform float uHexAz;       // hex cells around the equator
  uniform float uHexH;        // hex rows pole to pole
  uniform float uRippleSpeed; // radians of arc per second
  varying vec3 vDir;
  varying vec3 vWorldNormal;
  varying vec3 vViewDir;

  // Pointy-top hex distance on a plane: 0 at cell centre, ~1 at edges.
  // Classic axial-round trick, cheap enough to run per-fragment at PS2 res.
  vec4 hexCell(vec2 p) {
    vec2 q = vec2(p.x * 1.15470053838, p.y + p.x * 0.57735026919);
    vec2 pi = floor(q);
    vec2 pf = fract(q);
    float v = mod(pi.x + pi.y, 3.0);
    float ca = step(1.0, v);
    float cb = step(2.0, v);
    vec2 ma = step(pf.xy, pf.yx);
    float e = dot(ma, 1.0 - pf.yx + ca * (pf.x + pf.y - 1.0) + cb * (pf.yx - 2.0 * pf.xy));
    vec2 cellId = pi + ca - cb * ma;
    return vec4(e, cellId, v);
  }

  float hash21(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
  }

  float rippleBand(vec3 dir, vec3 rippleDir, float age) {
    if (age < 0.0) return 0.0;
    float ang = acos(clamp(dot(dir, normalize(rippleDir)), -1.0, 1.0));
    float radius = age * uRippleSpeed;
    float band = exp(-pow((ang - radius) * 7.0, 2.0));
    // The ring brightens for an instant, then decays as it expands.
    float life = max(0.0, 1.0 - age * 1.5);
    return band * life * life;
  }

  void main() {
    vec3 n = normalize(vWorldNormal);
    vec3 v = normalize(vViewDir);
    float ndv = clamp(dot(n, v), 0.0, 1.0);
    // Bubble read: hot rim, faint face — the pawn stays legible inside.
    float fresnel = pow(1.0 - ndv, 2.35);

    // Cylindrical map for the lattice: azimuth x height. The az seam hides
    // on the dome's far side under the locked iso yaw.
    float az = atan(vDir.z, vDir.x);
    float h = vDir.y * 0.5 + 0.5;
    vec2 hexUv = vec2(az * 0.15915494309 * uHexAz, (h - uTime * 0.045) * uHexH);
    vec4 cell = hexCell(hexUv);
    float lattice = smoothstep(0.16, 0.02, cell.x);
    // A few cells flicker alive each beat — the generator is WORKING.
    float beat = floor(uTime * 7.0);
    float cellFlicker = step(0.82, hash21(cell.yz + beat)) * 0.6;

    // Slow energy wash climbing the dome.
    float wash = 0.5 + 0.5 * sin(h * 12.0 - uTime * 3.1);

    float ripples =
        rippleBand(vDir, uRippleDir0, uRippleAges.x)
      + rippleBand(vDir, uRippleDir1, uRippleAges.y)
      + rippleBand(vDir, uRippleDir2, uRippleAges.z);

    vec3 shellColor = mix(uLowColor, uBaseColor, clamp(uCharge, 0.0, 1.0));
    // HUE DISCIPLINE (the hard lesson of this shader): the low-res target is
    // LDR — any colour multiplier past ~1 clamps channels toward white and
    // the cyan identity dies at the framebuffer, before the grade can even
    // be blamed. So: colour stays AT the canon hue (rim leans only slightly
    // toward white, ripple crests a bit more), and ALPHA carries all the
    // punch — the field imposes cyan on whatever is behind it.
    float structure = fresnel * 1.5
      + lattice * (0.62 + 0.5 * fresnel + cellFlicker)
      + wash * 0.06
      + 0.10
      + ripples * 1.6;
    float alpha = clamp(structure * uEnvelope, 0.0, 0.96);
    // Everything stays IN HUE: whitening any term raises r+g over b and the
    // cyan bleaches from inside the shader (measured, not theorized). The rim
    // and ripple crests brighten by pushing toward the hue's own ceiling.
    vec3 hueCeiling = vec3(shellColor.r * 0.55 + 0.25, shellColor.g, shellColor.b);
    vec3 color = mix(shellColor, hueCeiling, fresnel * 0.5 + clamp(ripples, 0.0, 1.0) * 0.8);

    gl_FragColor = vec4(color, alpha);
  }
`;

export class PsgShieldFx {
  private readonly records: ShieldRecord[] = [];
  private readonly byActor = new Map<string, ShieldRecord>();
  private readonly _center = new Vector3();
  private timeSeconds = 0;

  constructor(scene: Scene) {
    const cfg = FX_CONFIG.psgShield;
    const geometry = new SphereGeometry(1, 28, 20);
    for (let i = 0; i < cfg.poolSize; i += 1) {
      const material = new ShaderMaterial({
        uniforms: {
          uTime: { value: 0 },
          uEnvelope: { value: 0 },
          uCharge: { value: 1 },
          uBaseColor: { value: new Vector3(...hexToRgb(cfg.color)) },
          uLowColor: { value: new Vector3(...hexToRgb(cfg.lowChargeColor)) },
          uRippleDir0: { value: new Vector3(1, 0, 0) },
          uRippleDir1: { value: new Vector3(0, 1, 0) },
          uRippleDir2: { value: new Vector3(0, 0, 1) },
          uRippleAges: { value: new Vector3(-1, -1, -1) },
          uHexAz: { value: cfg.hexCellsAround },
          uHexH: { value: cfg.hexRows },
          uRippleSpeed: { value: cfg.rippleArcPerSecond },
        },
        vertexShader: SHIELD_VERTEX,
        fragmentShader: SHIELD_FRAGMENT,
        transparent: true,
        depthWrite: false,
        side: FrontSide,
        fog: false,
      });
      const mesh = new Mesh(geometry, material);
      mesh.visible = false;
      mesh.renderOrder = 13;
      mesh.frustumCulled = false;
      mesh.scale.set(cfg.radiusX, cfg.radiusY, cfg.radiusX);
      scene.add(mesh);
      this.records.push({
        alive: false,
        actorId: "",
        mesh,
        material,
        ageSeconds: 0,
        lifeSeconds: cfg.lifeMs / 1000,
        rippleAges: [-1, -1, -1],
        nextRippleSlot: 0,
      });
    }
  }

  /**
   * A block landed on `actorId`'s shield. Re-triggering an actor's live dome
   * refreshes its life and adds a ripple instead of stacking domes.
   * `incoming` is the attack's travel direction (world); the ripple expands
   * from where the hit ARRIVED on the shell (i.e. -incoming side).
   */
  block(actorId: string, incoming: Vector3 | null, chargeT: number): void {
    let rec: ShieldRecord | null = this.byActor.get(actorId) ?? null;
    if (!rec || !rec.alive) {
      rec = this.acquire(actorId);
      if (!rec) return;
    }
    rec.ageSeconds = 0;
    rec.material.uniforms.uCharge!.value = Math.min(1, Math.max(0, chargeT));
    // ripple origin: the shell point facing the attacker.
    const slot = rec.nextRippleSlot;
    rec.nextRippleSlot = (slot + 1) % 3;
    rec.rippleAges[slot] = 0;
    const dirUniform = slot === 0
      ? rec.material.uniforms.uRippleDir0!.value as Vector3
      : slot === 1
        ? rec.material.uniforms.uRippleDir1!.value as Vector3
        : rec.material.uniforms.uRippleDir2!.value as Vector3;
    if (incoming && incoming.lengthSq() > 1e-8) {
      dirUniform.copy(incoming).multiplyScalar(-1).normalize();
    } else {
      dirUniform.set(1, 0.15, 0).normalize();
    }
  }

  update(dtSeconds: number, state: PlayState): void {
    if (dtSeconds <= 0) return;
    this.timeSeconds += dtSeconds;
    const cfg = FX_CONFIG.psgShield;
    const popSeconds = cfg.popMs / 1000;
    // Named-const structural view: the full authority actor type satisfies
    // this subset; importing it would pull the shared-state transitive graph
    // into the fx layer (events.ts uses the same alias technique).
    const actors: Record<string, ShieldStateActor | undefined> = state.serverAuthority.actors;
    for (let i = 0; i < this.records.length; i += 1) {
      const rec = this.records[i]!;
      if (!rec.alive) continue;
      rec.ageSeconds += dtSeconds;
      const actor = actors[rec.actorId];
      if (!actor || rec.ageSeconds >= rec.lifeSeconds) {
        this.release(rec);
        continue;
      }
      const ax = actor.renderX ?? actor.x;
      const ay = actor.renderY ?? actor.y;
      this._center.set(ax + 0.5, cfg.centerY, ay + 0.5);
      rec.mesh.position.copy(this._center);

      // Envelope: fast pop-in, brief sustain, smooth configured decay.
      const t = rec.ageSeconds / rec.lifeSeconds;
      const pop = Math.min(1, rec.ageSeconds / popSeconds);
      const decay = t < 0.55 ? 1 : 1 - (t - 0.55) / 0.45;
      const envelope = pop * pop * (3 - 2 * pop) * Math.max(0, decay);

      const u = rec.material.uniforms;
      u.uTime!.value = this.timeSeconds;
      u.uEnvelope!.value = envelope * cfg.intensity;
      const ages = u.uRippleAges!.value as Vector3;
      for (let s = 0; s < 3; s += 1) {
        if (rec.rippleAges[s]! >= 0) rec.rippleAges[s] = rec.rippleAges[s]! + dtSeconds;
      }
      ages.set(rec.rippleAges[0]!, rec.rippleAges[1]!, rec.rippleAges[2]!);
    }
  }

  get activeCount(): number {
    let n = 0;
    for (let i = 0; i < this.records.length; i += 1) if (this.records[i]!.alive) n += 1;
    return n;
  }

  dispose(): void {
    for (const rec of this.records) {
      rec.material.dispose();
      rec.mesh.parent?.remove(rec.mesh);
    }
    this.records[0]?.mesh.geometry.dispose();
    this.records.length = 0;
    this.byActor.clear();
  }

  private acquire(actorId: string): ShieldRecord | null {
    for (let i = 0; i < this.records.length; i += 1) {
      const rec = this.records[i]!;
      if (rec.alive) continue;
      rec.alive = true;
      rec.actorId = actorId;
      rec.ageSeconds = 0;
      rec.rippleAges[0] = -1;
      rec.rippleAges[1] = -1;
      rec.rippleAges[2] = -1;
      rec.nextRippleSlot = 0;
      rec.mesh.visible = true;
      this.byActor.set(actorId, rec);
      return rec;
    }
    return null;
  }

  private release(rec: ShieldRecord): void {
    rec.alive = false;
    rec.mesh.visible = false;
    this.byActor.delete(rec.actorId);
    rec.actorId = "";
  }
}

/** Names the bit-unpack; used per pooled material at construction. */
function hexToRgb(hex: number): [number, number, number] {
  return [((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255];
}
