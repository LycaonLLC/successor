import {
  FrontSide,
  ShaderMaterial,
  SkinnedMesh,
  Vector3,
  type Scene,
} from "three";
import type { PlayState } from "@successor/client/src/slice-core/gameState";
import { FX_CONFIG } from "./config";

export interface PsgFormfitShellMeshSet {
  meshes: SkinnedMesh[];
  generation: number;
}

export type PsgFormfitShellMeshProvider = (actorId: string) => PsgFormfitShellMeshSet | null;

interface FormfitShieldRecord {
  alive: boolean;
  actorId: string;
  shells: SkinnedMesh[];
  sources: SkinnedMesh[];
  generation: number;
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
}

const FORMFIT_VERTEX = /* glsl */ `
  #include <common>
  #include <skinning_pars_vertex>

  uniform float uInflate;
  varying vec3 vWorldPos;
  varying vec3 vWorldNormal;
  varying vec3 vViewDir;
  varying vec3 vObjPos;

  void main() {
    vObjPos = position;
    #include <skinbase_vertex>
    #include <beginnormal_vertex>
    #include <skinnormal_vertex>
    #include <begin_vertex>
    #include <skinning_vertex>
    transformed += normalize(objectNormal) * uInflate;
    vec4 worldPos = modelMatrix * vec4(transformed, 1.0);
    vWorldPos = worldPos.xyz;
    vWorldNormal = normalize(mat3(modelMatrix) * objectNormal);
    vViewDir = normalize(cameraPosition - worldPos.xyz);
    gl_Position = projectionMatrix * viewMatrix * worldPos;
  }
`;

const FORMFIT_FRAGMENT = /* glsl */ `
  uniform float uTime;
  uniform float uEnvelope;
  uniform float uCharge;
  uniform vec3 uBaseColor;
  uniform vec3 uLowColor;
  uniform vec3 uRippleDir0;
  uniform vec3 uRippleDir1;
  uniform vec3 uRippleDir2;
  uniform vec3 uRippleAges;   // x,y,z = ages in seconds; < 0.0 inactive
  uniform vec3 uCenter;
  uniform float uHexAz;       // hex cells around the body
  uniform float uHexRows;     // hex rows per metre of bind-pose height
  uniform float uRippleSpeed; // radians of arc per second
  varying vec3 vWorldPos;
  varying vec3 vWorldNormal;
  varying vec3 vViewDir;
  varying vec3 vObjPos;

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
    float fresnel = pow(1.0 - ndv, 2.2);

    vec3 dir = normalize(vWorldPos - uCenter);
    float az = atan(vObjPos.z, vObjPos.x);
    vec2 hexUv = vec2(az * 0.15915494309 * uHexAz, vObjPos.y * uHexRows - uTime * 0.4);
    vec4 cell = hexCell(hexUv);
    float lattice = smoothstep(0.16, 0.02, cell.x);
    // A few cells flicker alive each beat — the generator is WORKING.
    float beat = floor(uTime * 7.0);
    float cellFlicker = step(0.82, hash21(cell.yz + beat)) * 0.6;

    float ripples =
        rippleBand(dir, uRippleDir0, uRippleAges.x)
      + rippleBand(dir, uRippleDir1, uRippleAges.y)
      + rippleBand(dir, uRippleDir2, uRippleAges.z);

    vec3 shellColor = mix(uLowColor, uBaseColor, clamp(uCharge, 0.0, 1.0));
    // Hue discipline mirrors fx/shield.ts: alpha carries punch; brightening
    // pushes only toward this hue's own ceiling, never white.
    float structure = fresnel * 1.45
      + lattice * (0.5 + 0.5 * fresnel + cellFlicker)
      + 0.06
      + ripples * 1.6;
    float alpha = clamp(structure * uEnvelope, 0.0, 0.9);
    vec3 hueCeiling = vec3(shellColor.r * 0.55 + 0.25, shellColor.g, shellColor.b);
    vec3 color = mix(shellColor, hueCeiling, fresnel * 0.5 + clamp(ripples, 0.0, 1.0) * 0.8);

    gl_FragColor = vec4(color, alpha);
  }
`;

export class PsgFormfitFx {
  private readonly records: FormfitShieldRecord[] = [];
  private readonly byActor = new Map<string, FormfitShieldRecord>();
  private readonly _center = new Vector3();
  private provider: PsgFormfitShellMeshProvider | null = null;
  private timeSeconds = 0;

  constructor(private readonly scene: Scene) {
    const cfg = FX_CONFIG.psgShield;
    const formfit = cfg.formfit;
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
          uCenter: { value: new Vector3(0, formfit.centerHeight, 0) },
          uHexAz: { value: formfit.hexCellsAround },
          uHexRows: { value: formfit.hexHeightRows },
          uRippleSpeed: { value: cfg.rippleArcPerSecond },
          uInflate: { value: formfit.inflate },
        },
        vertexShader: FORMFIT_VERTEX,
        fragmentShader: FORMFIT_FRAGMENT,
        transparent: true,
        depthWrite: false,
        side: FrontSide,
        fog: false,
      });
      this.records.push({
        alive: false,
        actorId: "",
        shells: [],
        sources: [],
        generation: -1,
        material,
        ageSeconds: 0,
        lifeSeconds: cfg.lifeMs / 1000,
        rippleAges: [-1, -1, -1],
        nextRippleSlot: 0,
      });
    }
  }

  setProvider(fn: PsgFormfitShellMeshProvider | null): void {
    this.provider = fn;
  }

  /**
   * A block landed on `actorId`'s form-fit shield. Re-triggering an actor's
   * live shell refreshes its life and adds a ripple instead of stacking shells.
   * `incoming` is the attack's travel direction (world); the ripple expands
   * from where the hit ARRIVED on the shell (i.e. -incoming side).
   */
  block(actorId: string, incoming: Vector3 | null, chargeT: number): void {
    const provided = this.provider?.(actorId) ?? null;
    if (!provided || provided.meshes.length === 0) return;

    let rec: FormfitShieldRecord | null = this.byActor.get(actorId) ?? null;
    if (!rec || !rec.alive) {
      rec = this.acquire(actorId);
      if (!rec) return;
    }
    this.ensureShells(rec, provided.meshes, provided.generation);
    this.setShellVisibility(rec, true);

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
    const formfit = cfg.formfit;
    const popSeconds = cfg.popMs / 1000;
    // Named-const structural view: the full authority actor type satisfies
    // this subset; importing it would pull the shared-state transitive graph
    // into the fx layer (shield.ts uses the same alias technique).
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
      const provided = this.provider?.(rec.actorId) ?? null;
      if (!provided || provided.meshes.length === 0) {
        this.release(rec);
        continue;
      }
      if (!this.shellsMatch(rec, provided.meshes, provided.generation)) {
        this.teardownShells(rec);
        this.release(rec);
        continue;
      }

      const ax = actor.renderX ?? actor.x;
      const ay = actor.renderY ?? actor.y;
      this._center.set(ax + 0.5, formfit.centerHeight, ay + 0.5);

      // Envelope: fast pop-in, brief sustain, smooth configured decay.
      const t = rec.ageSeconds / rec.lifeSeconds;
      const pop = Math.min(1, rec.ageSeconds / popSeconds);
      const decay = t < 0.55 ? 1 : 1 - (t - 0.55) / 0.45;
      const envelope = pop * pop * (3 - 2 * pop) * Math.max(0, decay);

      // Normal blending sorts transparents by object position; scene-root
      // shells would all sort from world origin. Attached bind mode cancels
      // the node transform in skinning, so parking each shell at the actor
      // centre is free and fixes depth-sort vs other transparents.
      for (let s = 0; s < rec.shells.length; s += 1) rec.shells[s]!.position.copy(this._center);

      const u = rec.material.uniforms;
      u.uTime!.value = this.timeSeconds;
      u.uEnvelope!.value = envelope * formfit.intensity;
      (u.uCenter!.value as Vector3).copy(this._center);
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
    for (let i = 0; i < this.records.length; i += 1) {
      const rec = this.records[i]!;
      this.teardownShells(rec);
      rec.material.dispose();
    }
    this.records.length = 0;
    this.byActor.clear();
    this.provider = null;
  }

  private acquire(actorId: string): FormfitShieldRecord | null {
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
      this.byActor.set(actorId, rec);
      return rec;
    }
    return null;
  }

  private release(rec: FormfitShieldRecord): void {
    rec.alive = false;
    this.setShellVisibility(rec, false);
    rec.material.uniforms.uEnvelope!.value = 0;
    this.byActor.delete(rec.actorId);
    rec.actorId = "";
  }

  private ensureShells(rec: FormfitShieldRecord, meshes: SkinnedMesh[], generation: number): void {
    if (this.shellsMatch(rec, meshes, generation)) return;
    this.teardownShells(rec);
    for (let i = 0; i < meshes.length; i += 1) {
      const src = meshes[i]!;
      const shell = new SkinnedMesh(src.geometry, rec.material);
      shell.bindMode = "attached";
      shell.bind(src.skeleton, src.bindMatrix);
      shell.frustumCulled = false;
      shell.renderOrder = 13;
      shell.castShadow = false;
      shell.receiveShadow = false;
      shell.visible = rec.alive;
      this.scene.add(shell);
      rec.sources.push(src);
      rec.shells.push(shell);
    }
    rec.generation = generation;
  }

  private shellsMatch(rec: FormfitShieldRecord, meshes: SkinnedMesh[], generation: number): boolean {
    if (rec.generation !== generation || rec.sources.length !== meshes.length || rec.shells.length !== meshes.length) return false;
    for (let i = 0; i < meshes.length; i += 1) {
      if (rec.sources[i] !== meshes[i]) return false;
    }
    return true;
  }

  private setShellVisibility(rec: FormfitShieldRecord, visible: boolean): void {
    for (let i = 0; i < rec.shells.length; i += 1) rec.shells[i]!.visible = visible;
  }

  private teardownShells(rec: FormfitShieldRecord): void {
    for (let i = 0; i < rec.shells.length; i += 1) {
      const shell = rec.shells[i]!;
      shell.visible = false;
      this.scene.remove(shell);
    }
    rec.shells.length = 0;
    rec.sources.length = 0;
    rec.generation = -1;
  }
}

/** Names the bit-unpack; used per pooled material at construction. */
function hexToRgb(hex: number): [number, number, number] {
  return [((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255];
}
