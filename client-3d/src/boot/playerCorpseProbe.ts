import type { PlayState } from "@successor/client/src/slice-core/gameState";

/**
 * Read-only harness projection of one AOI player corpse bag (verification
 * probe seam). The journey harness drives the REAL picker route — it reads
 * these world/screen coordinates and physically double-clicks the canvas —
 * so this module must never expose a mutation.
 */
export interface Successor3dPlayerCorpseDebugProjection {
  id: string;
  ownerLabel: string;
  isOwner: boolean;
  hasItems: boolean;
  creditsPresent: boolean;
  areaId: string;
  /** Authority cell coordinates (sim space). */
  x: number;
  y: number;
  /** CSS-px canvas anchor at the bag's resting height; null off the active area. */
  screen: { px: number; py: number } | null;
}

/** Renderer projection seam: worldToScreen(x, z, y) — z is SIM y, y is HEIGHT. */
export type WorldToScreenFn = (x: number, z: number, y: number) => { px: number; py: number };

/** Bag anchor height in cells — the lying capsule's center (playerCorpses.ts BAG_RADIUS_CELLS * 0.82). */
const CORPSE_SCREEN_ANCHOR_HEIGHT_CELLS = 0.22;

/**
 * Project the streamed `serverAuthority.playerCorpses` rows for the debug
 * probe. Rendered bags sit at cell centers (cell + 0.5, playerCorpses.ts
 * spawn contract), so the screen anchor targets the same point the raycast
 * picker resolves. Off-area corpses keep their facts but carry no screen
 * anchor — the renderer never spawned a bag for them.
 */
export function playerCorpseProbeProjections(
  state: Pick<PlayState, "activeAreaId"> & { serverAuthority: Pick<PlayState["serverAuthority"], "playerCorpses"> },
  worldToScreen: WorldToScreenFn,
): Successor3dPlayerCorpseDebugProjection[] {
  return state.serverAuthority.playerCorpses.map((corpse) => {
    const onArea = corpse.areaId === state.activeAreaId;
    const screen = onArea
      ? worldToScreen(corpse.x + 0.5, corpse.y + 0.5, CORPSE_SCREEN_ANCHOR_HEIGHT_CELLS)
      : null;
    return {
      id: corpse.id,
      ownerLabel: corpse.ownerLabel,
      isOwner: corpse.isOwner,
      hasItems: corpse.hasItems,
      creditsPresent: corpse.creditsPresent,
      areaId: corpse.areaId,
      x: Math.round(corpse.x * 1000) / 1000,
      y: Math.round(corpse.y * 1000) / 1000,
      screen: screen ? { px: Math.round(screen.px), py: Math.round(screen.py) } : null,
    };
  });
}
