import {
  AdditiveBlending,
  CylinderGeometry,
  Mesh,
  MeshBasicMaterial,
  Sprite,
  SpriteMaterial,
  type Object3D,
  type Texture,
} from "three";

/**
 * PlasmaBlade — the bladeless sword (owner brief 2026-07-08: "plasma sword...
 * 0.65x the size... could be any color, doesn't use any model at all for
 * blade, only hilt — pure effect for bladepart").
 *
 * Attaches into a weapon frame (SwordRig weaponRoot precedent: glTF weapon
 * space, +Z = tip). Three nested reads:
 *   core   thin white-hot center line — steady (the plasma is CONTAINED)
 *   shell  colored glow sleeve — breathes/hums, carries the ANY-COLOR identity
 *   tip    small glow bead capping the blade + emitter glow at the base
 *
 * Sized 0.65x the vibrosword reach. No geometry model for the blade — these
 * primitives ARE the blade. Zero per-frame allocation; one instance per
 * attach point, dispose cleanly.
 */

const CORE_RADIUS = 0.009;
const SHELL_RADIUS = 0.024;
/** Vibro blade reach ~1.15m; plasma = 0.65x per the owner spec. */
export const PLASMA_BLADE_LENGTH_M = 0.75;
/** Blade starts just past the hilt emitter. */
const EMITTER_OFFSET_M = 0.09;

export class PlasmaBlade {
  private readonly root: Object3D;
  private readonly core: Mesh<CylinderGeometry, MeshBasicMaterial>;
  private readonly shell: Mesh<CylinderGeometry, MeshBasicMaterial>;
  private readonly coreMat: MeshBasicMaterial;
  private readonly shellMat: MeshBasicMaterial;
  private readonly tip: Sprite;
  private readonly tipMat: SpriteMaterial;
  private readonly emitter: Sprite;
  private readonly emitterMat: SpriteMaterial;
  private readonly geometry: CylinderGeometry;
  private readonly lengthM: number;
  private ageSeconds = 0;
  /** 0 = retracted into the hilt (sheathed), 1 = full blade. */
  private extension = 1;

  constructor(parent: Object3D, sprite: Texture, colorHex: number, lengthM: number = PLASMA_BLADE_LENGTH_M) {
    this.root = parent;
    this.lengthM = lengthM;
    this.geometry = new CylinderGeometry(1, 1, 1, 8, 1, true);
    this.coreMat = new MeshBasicMaterial({
      color: 0xfff8ec, transparent: true, opacity: 0.95,
      blending: AdditiveBlending, depthWrite: false, fog: false,
    });
    this.shellMat = new MeshBasicMaterial({
      color: colorHex, transparent: true, opacity: 0.55,
      blending: AdditiveBlending, depthWrite: false, fog: false,
    });
    this.core = new Mesh(this.geometry, this.coreMat);
    this.shell = new Mesh(this.geometry, this.shellMat);
    for (const m of [this.core, this.shell]) {
      // weapon frame: +Z = tip; cylinder axis is +Y — pitch onto the blade axis
      m.rotation.x = Math.PI / 2;
      m.renderOrder = 12;
      m.frustumCulled = false;
      parent.add(m);
    }
    this.core.scale.set(CORE_RADIUS, lengthM, CORE_RADIUS);
    this.shell.scale.set(SHELL_RADIUS, lengthM, SHELL_RADIUS);
    this.core.position.z = EMITTER_OFFSET_M + lengthM / 2;
    this.shell.position.z = EMITTER_OFFSET_M + lengthM / 2;

    this.tipMat = new SpriteMaterial({
      map: sprite, color: colorHex, transparent: true, opacity: 0.9,
      blending: AdditiveBlending, depthWrite: false, fog: false,
    });
    this.tip = new Sprite(this.tipMat);
    this.tip.scale.set(0.07, 0.07, 0.07);
    this.tip.position.z = EMITTER_OFFSET_M + lengthM;
    this.tip.renderOrder = 12;
    this.tip.frustumCulled = false;
    parent.add(this.tip);

    this.emitterMat = new SpriteMaterial({
      map: sprite, color: 0xffffff, transparent: true, opacity: 0.8,
      blending: AdditiveBlending, depthWrite: false, fog: false,
    });
    this.emitter = new Sprite(this.emitterMat);
    this.emitter.scale.set(0.05, 0.05, 0.05);
    this.emitter.position.z = EMITTER_OFFSET_M;
    this.emitter.renderOrder = 12;
    this.emitter.frustumCulled = false;
    parent.add(this.emitter);
  }

  setColor(colorHex: number): void {
    this.shellMat.color.setHex(colorHex);
    this.tipMat.color.setHex(colorHex);
  }

  /**
   * Ignition state: the blade grows out of the emitter (owner brief
   * 2026-07-07: "when sheathed blade goes away, comes out when unsheathed —
   * fast but animated"). t=0 hides every blade element (hilt only); the
   * emitter bead flares while the plasma is moving.
   */
  setExtension(t: number): void {
    const clamped = Math.min(1, Math.max(0, t));
    this.extension = clamped;
    const lit = clamped > 0.02;
    this.core.visible = lit;
    this.shell.visible = lit;
    this.tip.visible = lit;
    this.emitter.visible = clamped > 0.001;
    if (!lit) return;
    const length = this.lengthM * clamped;
    this.core.scale.y = length;
    this.shell.scale.y = length;
    this.core.position.z = EMITTER_OFFSET_M + length / 2;
    this.shell.position.z = EMITTER_OFFSET_M + length / 2;
    this.tip.position.z = EMITTER_OFFSET_M + length;
    // mid-travel flare: emitter runs hot while the blade moves
    this.emitterMat.opacity = clamped < 1 ? 1 : 0.8;
  }

  /** Hum: the shell breathes; the core stays contained. Rare micro-dropouts. */
  update(dtSeconds: number): void {
    this.ageSeconds += dtSeconds;
    if (this.extension <= 0.02) return;
    const hum = 0.5 + 0.08 * Math.sin(this.ageSeconds * 37) + 0.04 * Math.sin(this.ageSeconds * 9.3);
    const dropout = Math.random() < 0.008 ? 0.6 : 1;
    this.shellMat.opacity = hum * dropout;
    this.tipMat.opacity = (0.8 + 0.15 * Math.sin(this.ageSeconds * 21)) * dropout;
  }

  dispose(): void {
    this.coreMat.dispose();
    this.shellMat.dispose();
    this.tipMat.dispose();
    this.emitterMat.dispose();
    this.geometry.dispose();
    this.root.remove(this.core);
    this.root.remove(this.shell);
    this.root.remove(this.tip);
    this.root.remove(this.emitter);
  }
}
