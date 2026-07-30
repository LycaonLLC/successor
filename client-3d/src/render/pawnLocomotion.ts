// pawnLocomotion.ts — pure locomotion retiming math for the pawn renderer
// (pawnYaw.ts precedent: no three.js imports, colocated behavioral tests).

import { SUCCESSOR_3D_CONFIG } from "../config";

/**
 * Playback time scale for a moving base gait clip: ground speed over the
 * clip's authored travel speed, clamped by `pawnPack.timeScaleClamp`.
 *
 * The floor keeps the mixer advancing (stride phase + crossfades), NOT to
 * hide slow movement: the idle gate (`idleSpeedCellsPerSec`) already owns
 * speeds below 0.05 cells/s, so every speed a walk clip has to represent
 * maps to a ratio the clamp passes through nearly untouched — feet track
 * ground displacement instead of sliding.
 */
export function locomotionTimeScale(speedCellsPerSec: number, clipSpeedCellsPerSec: number): number {
  const clampRange = SUCCESSOR_3D_CONFIG.pawnPack.timeScaleClamp;
  const ratio = clipSpeedCellsPerSec > 1e-4 ? speedCellsPerSec / clipSpeedCellsPerSec : 1;
  return Math.min(clampRange.max, Math.max(clampRange.min, ratio));
}
