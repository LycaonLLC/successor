// plasmaPresentation.ts — the plasma sword's blade FX, in ONE place.
//
// World pawns, the paper doll and the actor preview all used to hand-roll this
// and drifted apart. They also all inherited the same defect: the hilt was
// parented straight onto the SwordRig's weaponRoot, which for the borrowed
// Vibrosword spec sits 0.1525 m up the blade from the palm, so hilt and blade
// floated in mid-air ahead of hand_r.
//
// The plasma sword is now a real catalogue model (plasma_hilt_attach.json), so
// SwordRig welds the hilt correctly on its own. All that is left here is the
// pure-effect blade, which must emit from the hilt's authored `emitter`
// socket rather than from the weapon root.
import type { Object3D, Texture, Vector3 } from "three";
import { Group } from "three";
import { PlasmaBlade } from "./plasmaBlade";
import type { SlugthrowerAttachSpec, VibroswordAttachSpec } from "../../assets/pawnRigTypes";

/** Ignition ramp: full blade in ~0.13 s, retract slightly faster (~0.10 s). */
export const PLASMA_IGNITE_PER_SECOND = 1 / 0.13;
export const PLASMA_RETRACT_PER_SECOND = 1 / 0.1;
export const PLASMA_SWORD_ITEM_ID = 3104;
/** Registry asset key the plasma item resolves to (weaponModelRegistry). */
export const PLASMA_SWORD_MODEL_KEY = "plasma_sword";
export const PLASMA_SWORD_COLOR = 0x63f0ff;

/**
 * Emitter offset baked into PlasmaBlade. The authored hilt puts its emitter at
 * exactly this z, so mounting the blade at the emitter socket and letting
 * PlasmaBlade apply its own offset would double it.
 */
const BLADE_BUILTIN_EMITTER_OFFSET_M = 0.09;

/** Minimal surface the presentation needs from a melee rig. */
export interface PlasmaHost {
  frameRoot(): Object3D;
}

/**
 * Blade FX welded to a plasma hilt. One instance per presentation surface;
 * `dispose()` releases the blade and detaches the mount.
 */
export class PlasmaPresentation {
  private readonly mount = new Group();
  private readonly blade: PlasmaBlade;
  private extension: number;
  private targetExtension: number;

  constructor(host: PlasmaHost, sprite: Texture, colorHex: number, ignited: boolean) {
    const root = host.frameRoot();
    // PlasmaBlade builds along +Z from its parent origin and adds its own
    // emitter offset, so the mount sits at the hilt origin, not the emitter
    // socket — the authored emitter z and the blade's built-in offset are the
    // same 0.09 m by construction.
    this.mount.name = "plasma:blade-mount";
    this.mount.position.set(0, 0, 0);
    root.add(this.mount);
    this.blade = new PlasmaBlade(this.mount, sprite, colorHex);
    this.extension = ignited ? 1 : 0;
    this.targetExtension = this.extension;
    this.blade.setExtension(this.extension);
  }

  /** Stowed = retracted into the hilt; wielded = ignited. Ramps, never pops. */
  setIgnited(ignited: boolean, options?: { readonly snap?: boolean }): void {
    this.targetExtension = ignited ? 1 : 0;
    if (options?.snap === true) {
      this.extension = this.targetExtension;
      this.blade.setExtension(this.extension);
    }
  }

  isIgnited(): boolean {
    return this.targetExtension > 0.5;
  }

  currentExtension(): number {
    return this.extension;
  }

  update(dtSeconds: number): void {
    if (this.extension !== this.targetExtension) {
      const rate = this.targetExtension > this.extension
        ? PLASMA_IGNITE_PER_SECOND
        : -PLASMA_RETRACT_PER_SECOND;
      this.extension = Math.min(1, Math.max(0, this.extension + rate * dtSeconds));
      this.blade.setExtension(this.extension);
    }
    this.blade.update(dtSeconds);
  }

  dispose(): void {
    this.blade.dispose();
    this.mount.parent?.remove(this.mount);
  }
}

/**
 * Blade-tip position in the hilt's own local space, for reach/FX queries.
 * Uses the authored muzzle socket when the model supplies one.
 */
export function plasmaTipLocal(spec: SlugthrowerAttachSpec | VibroswordAttachSpec, out: Vector3): Vector3 {
  if ("muzzle" in spec.sockets) return out.copy(spec.sockets.muzzle);
  return out.set(0, 0, BLADE_BUILTIN_EMITTER_OFFSET_M);
}
