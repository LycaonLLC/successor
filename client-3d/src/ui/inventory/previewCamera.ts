/**
 * Pure orthographic-bounds math for the inventory/examine preview viewports.
 *
 * Both the Target Examine mannequin and the item-slot turntables render into
 * scissored viewports whose aspect follows layout, not authorship. These
 * helpers keep the AUTHORED VERTICAL FRAMING and scale the horizontal bounds
 * from the live viewport aspect, so nothing squashes when a window resizes.
 *
 * Deliberately dependency-free: unit-testable without Three/DOM.
 */

export interface ActorPreviewCameraBounds {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export const ACTOR_PREVIEW_AUTHORED_CAMERA = {
  left: -0.9,
  right: 0.9,
  top: 1.35,
  bottom: -0.35,
} as const;

const AUTHORED_CAMERA_ASPECT =
  (ACTOR_PREVIEW_AUTHORED_CAMERA.right - ACTOR_PREVIEW_AUTHORED_CAMERA.left) /
  (ACTOR_PREVIEW_AUTHORED_CAMERA.top - ACTOR_PREVIEW_AUTHORED_CAMERA.bottom);

export function writeActorPreviewCameraBounds(
  width: number,
  height: number,
  target: ActorPreviewCameraBounds,
): ActorPreviewCameraBounds {
  const viewportAspect = Math.max(1, width) / Math.max(1, height);
  const horizontalScale = viewportAspect / AUTHORED_CAMERA_ASPECT;
  const centerX = (ACTOR_PREVIEW_AUTHORED_CAMERA.left + ACTOR_PREVIEW_AUTHORED_CAMERA.right) * 0.5;
  const halfWidth = (ACTOR_PREVIEW_AUTHORED_CAMERA.right - ACTOR_PREVIEW_AUTHORED_CAMERA.left) * 0.5 * horizontalScale;
  target.left = centerX - halfWidth;
  target.right = centerX + halfWidth;
  target.top = ACTOR_PREVIEW_AUTHORED_CAMERA.top;
  target.bottom = ACTOR_PREVIEW_AUTHORED_CAMERA.bottom;
  return target;
}

export interface SlotCameraBounds {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export const SLOT_CAMERA_HALF_HEIGHT = 0.92;

export function writeSlotCameraBoundsForAspect(aspect: number, target: SlotCameraBounds): SlotCameraBounds {
  const viewportAspect = Math.max(1e-4, aspect);
  target.left = -SLOT_CAMERA_HALF_HEIGHT * viewportAspect;
  target.right = SLOT_CAMERA_HALF_HEIGHT * viewportAspect;
  target.top = SLOT_CAMERA_HALF_HEIGHT;
  target.bottom = -SLOT_CAMERA_HALF_HEIGHT;
  return target;
}

// ── Paper-doll (inventory mannequin) framing ────────────────────────────────

export type PaperDollFramingMode = "default" | "sword-held";
export type PaperDollWeaponFramingLane = "none" | "rifle" | "melee";

/** Authored vertical framing for the paper doll: unarmed, rifle, stowed. */
export const DOLL_CAMERA_HALF_HEIGHT = 1.18;

/**
 * Held-vibrosword framing. Geometry (vibrosword_attach.json + melee_idle):
 * the blade tip sits at +Z 0.782m from the guard hub and the grip socket at
 * z=-0.13, so the tip reaches 0.912m past the hand. melee_idle bottoms out
 * near 30° below horizontal at broadside and hand_r orbits the turntable
 * axis at ~0.34m, so the worst-case tip radius across yaw is
 *   0.34 + 0.912·cos(30°) ≈ 1.13m.
 * The paper-doll well is ~209x350 CSS px (aspect ≈ 0.60); with a ~4% edge
 * margin the half-WIDTH must reach ≈1.175m → half-height 1.175/0.60 ≈ 1.96.
 * Smallest value that keeps blade+guard+hilt+hands in frame at every yaw
 * without shrinking the pawn further than the sword demands.
 */
export const DOLL_CAMERA_HALF_HEIGHT_SWORD_HELD = 1.96;

/** Wider framing applies ONLY while a melee weapon is actually in hand. */
export function resolvePaperDollFramingMode(
  weaponLane: PaperDollWeaponFramingLane,
  holdWeapon: boolean,
): PaperDollFramingMode {
  return weaponLane === "melee" && holdWeapon ? "sword-held" : "default";
}

/**
 * Dirty-tracked orthographic bounds for the paper-doll camera. `writeBounds`
 * returns false (and writes nothing) when neither the clamped aspect nor the
 * framing half-height moved, so the caller skips updateProjectionMatrix.
 * A mode change refreshes bounds even at an unchanged aspect. User turntable
 * zoom stays a separate multiplier (camera.zoom) and is never touched here.
 * Zero-allocation: scalar state only, writes into the caller's target.
 */
export class PaperDollCameraFraming {
  private halfHeight = DOLL_CAMERA_HALF_HEIGHT;
  private lastAspect = 0;
  private lastHalfHeight = 0;

  setMode(mode: PaperDollFramingMode): void {
    this.halfHeight = mode === "sword-held" ? DOLL_CAMERA_HALF_HEIGHT_SWORD_HELD : DOLL_CAMERA_HALF_HEIGHT;
  }

  writeBounds(aspect: number, target: SlotCameraBounds): boolean {
    const safeAspect = Math.max(0.4, Math.min(2.5, aspect));
    if (Math.abs(safeAspect - this.lastAspect) < 1e-4 && this.halfHeight === this.lastHalfHeight) return false;
    this.lastAspect = safeAspect;
    this.lastHalfHeight = this.halfHeight;
    target.left = -this.halfHeight * safeAspect;
    target.right = this.halfHeight * safeAspect;
    target.top = this.halfHeight;
    target.bottom = -this.halfHeight;
    return true;
  }
}
