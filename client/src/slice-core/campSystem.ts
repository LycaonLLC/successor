import type { ServerAuthorityPlacedCampState } from "./gameState";
import type { MovementBlocker } from "./movementSystem";

/**
 * Scout-camp client truths shared by every client (3D, TUI): item identity,
 * pack-up footprint, the honest weather-shelter test, and the client-side
 * collision profile for placed-camp render kinds.
 *
 * Sim contract (crates/successor-sim authority/camps.rs):
 *  - CAMP KIT (item 3007) is consumed ON PLACEMENT; pack-up returns nothing.
 *  - Pack-up requires the owner to stand inside the rendered, cell-centered
 *    5×5 footprint.
 *  - The weather exemption is a square box centered on the exact placement
 *    position and shelters ANY actor inside it (ownership only gates commands).
 *  - Camps have NO sim collision: the sim treats the tent as walk-through.
 *    Wall collision here is a client-side FEEL layer (local prediction only)
 *    built from the pack's measured `<glb>_collision.json` sidecar — the same
 *    mesh-derived boxes the shelter-house fixture pipeline uses, so jamb
 *    behavior matches the proven swept-circle door feel.
 */

/** Sim CAMP_KIT_ITEM_ID (authority.rs) — single-use deployable camp. */
export const CAMP_KIT_ITEM_ID = 3007;


/**
 * Base authority shelter footprint. The sim validates and shelters a square
 * `camp.position ± 2.5 cells`; the 3D tent, collision sidecar, and roof peel
 * all consume this constant so presentation cannot drift back to 3x3.
 */
export const CAMP_SHELTER_FOOTPRINT_CELLS = 5;

/** Cell-centered half-extent used by both the rendered tent and pack-up gate. */
export const CAMP_INTERACTION_HALF_EXTENT_CELLS = CAMP_SHELTER_FOOTPRINT_CELLS / 2;

/**
 * Honest client-side shelter half-extent. The sim box is `position ± 2.5`
 * where `position` is the owner's exact standing point at placement — but the
 * wire carries only the CELL. `position` lies in `[cell, cell+1)`, so the box
 * guaranteed to be inside the sim's for ANY in-cell position is
 * `(cell + 0.5) ± 2.0` per axis. The HUD may under-claim a fringe cell; it
 * can NEVER claim SHELTERED where the sim would still charge storm damage.
 */
export const CAMP_SHELTER_SAFE_HALF_EXTENT_CELLS = CAMP_SHELTER_FOOTPRINT_CELLS / 2 - 0.5;

/** Is a world point inside ANY camp's guaranteed shelter box in this area? */
export function pointInsideCampShelter(
  camps: readonly ServerAuthorityPlacedCampState[],
  areaId: string,
  x: number,
  y: number,
): boolean {
  for (const camp of camps) {
    if (camp.areaId !== areaId) continue;
    if (
      Math.abs(x - (camp.cellX + 0.5)) <= CAMP_SHELTER_SAFE_HALF_EXTENT_CELLS
      && Math.abs(y - (camp.cellY + 0.5)) <= CAMP_SHELTER_SAFE_HALF_EXTENT_CELLS
    ) {
      return true;
    }
  }
  return false;
}

/** Does a world point occupy the rendered 5×5 pack-up footprint for this camp? */
export function pointInsideCampInteractionFootprint(
  camp: ServerAuthorityPlacedCampState,
  areaId: string,
  x: number,
  y: number,
): boolean {
  if (camp.areaId !== areaId) return false;
  return (
    Math.abs(x - (camp.cellX + 0.5)) <= CAMP_INTERACTION_HALF_EXTENT_CELLS
    && Math.abs(y - (camp.cellY + 0.5)) <= CAMP_INTERACTION_HALF_EXTENT_CELLS
  );
}

/** "M:SS" countdown copy for the armed abandonment grace (owner HUD). */
export function formatAbandonCountdown(seconds: number): string {
  const whole = Math.max(0, Math.trunc(seconds));
  const minutes = Math.trunc(whole / 60);
  const rest = whole % 60;
  return `${minutes}:${String(rest).padStart(2, "0")}`;
}

// ── Client collision profiles (per render kind) ─────────────────────────────

/** One axis-aligned box in CAMP-LOCAL cell units, relative to the camp center. */
export interface CampCollisionBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface CampCollisionProfile {
  walls: CampCollisionBox[];
  /** Doorway blocker, active only while the (client-driven) door is closed. */
  door: CampCollisionBox | null;
}

/** Sidecar JSON shape (`tools/successor/extract-structure-collision.mjs`). */
interface StructureCollisionSidecar {
  footprint: { spanX: number; spanZ: number; centerX: number; centerZ: number };
  walls: Array<{ minX: number; minZ: number; maxX: number; maxZ: number }>;
  door?: { node?: string; closed: { minX: number; minZ: number; maxX: number; maxZ: number } } | null;
}

/**
 * Sidecar (GLB-local metres) → camp-local cell boxes, the EXACT fixture math
 * (`structureCollisionFromSidecar`): uniform scale into the cell rect,
 * centered. Rotation is unsupported by the sidecar pipeline, so placed camps
 * always render/collide at yaw 0 (door faces +Z, the house front contract).
 */
export function campCollisionProfileFromSidecar(
  sidecar: StructureCollisionSidecar,
  cellSpan: number,
): CampCollisionProfile {
  const { footprint } = sidecar;
  const scale = Math.min(cellSpan / footprint.spanX, cellSpan / footprint.spanZ);
  const toBox = (box: { minX: number; minZ: number; maxX: number; maxZ: number }): CampCollisionBox => ({
    minX: (box.minX - footprint.centerX) * scale,
    minY: (box.minZ - footprint.centerZ) * scale,
    maxX: (box.maxX - footprint.centerX) * scale,
    maxY: (box.maxZ - footprint.centerZ) * scale,
  });
  return {
    walls: sidecar.walls.map(toBox),
    door: sidecar.door ? toBox(sidecar.door.closed) : null,
  };
}

const collisionProfileByRenderKind = new Map<string, CampCollisionProfile>();

/**
 * Register the collision profile for a camp render kind (examine-opener
 * pattern: the 3D client fetches the pack sidecar and installs it at boot;
 * clients without one — TUI, tests — simply get walk-through camps, which
 * matches the sim's own truth).
 */
export function registerCampCollisionProfile(renderKind: string, profile: CampCollisionProfile | null): void {
  if (profile) collisionProfileByRenderKind.set(renderKind, profile);
  else collisionProfileByRenderKind.delete(renderKind);
}

// ── Client-driven door state (proximity drive lives in the renderer) ────────

const doorOpenByCampId = new Map<string, boolean>();

/** Record a camp door's visual open state. True when the value CHANGED. */
export function setCampDoorOpen(campId: string, open: boolean): boolean {
  if ((doorOpenByCampId.get(campId) ?? false) === open) return false;
  if (open) doorOpenByCampId.set(campId, true);
  else doorOpenByCampId.delete(campId);
  return true;
}

export function campDoorOpen(campId: string): boolean {
  return doorOpenByCampId.get(campId) ?? false;
}

/** Drop door state for a despawned camp (renderer despawn reconcile). */
export function clearCampDoorState(campId: string): void {
  doorOpenByCampId.delete(campId);
}

/**
 * Movement blockers for every placed camp in the area — appended by
 * `buildMovementBlockers`. The door blocker joins only while the door is
 * visually closed; the auto-door drops it as the panel slides, so the doorway
 * is exactly as passable as it LOOKS.
 */
export function appendCampMovementBlockers(
  blockers: MovementBlocker[],
  camps: readonly ServerAuthorityPlacedCampState[],
  areaId: string,
): void {
  for (const camp of camps) {
    if (camp.areaId !== areaId) continue;
    const profile = collisionProfileByRenderKind.get(camp.renderKind);
    if (!profile) continue;
    const centerX = camp.cellX + 0.5;
    const centerY = camp.cellY + 0.5;
    for (const box of profile.walls) {
      blockers.push({
        left: centerX + box.minX,
        top: centerY + box.minY,
        right: centerX + box.maxX,
        bottom: centerY + box.maxY,
      });
    }
    if (profile.door && !campDoorOpen(camp.campId)) {
      blockers.push({
        left: centerX + profile.door.minX,
        top: centerY + profile.door.minY,
        right: centerX + profile.door.maxX,
        bottom: centerY + profile.door.maxY,
      });
    }
  }
}
