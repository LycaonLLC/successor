export interface WieldPoseParams {
  readonly armed: boolean;
  readonly inCombat: boolean | undefined;
  readonly reloading?: boolean;
}

export interface WieldPose {
  readonly holdWeapon: boolean;
  readonly stowed: boolean;
}

/**
 * Shared Successor 3D weapon-pose rule for world pawns and UI previews.
 *
 * The authority may omit `inCombat` while the actor is out of combat; that is
 * equivalent to false and keeps the weapon stowed.
 */
export function resolveWieldPose(params: WieldPoseParams): WieldPose {
  const inCombat = params.inCombat ?? false;
  const holdWeapon = params.armed && (inCombat || params.reloading === true);
  return {
    holdWeapon,
    stowed: params.armed && !holdWeapon,
  };
}
