import type { PlayState, ServerAuthorityActorState } from "@successor/client/src/slice-core/gameState";
import { isFarmableCreatureIdentity } from "@successor/client/src/slice-core/npcSystem";

/**
 * Soft-lock target acquisition (roll-combat era).
 *
 * Tab cycling and world clicks select an explicit target. The selection stays
 * sticky while the actor remains a living hostile in range.
 *
 * Hostility (v1.1): different faction, AND the candidate must HAVE a
 * faction — null-faction camp NPCs (trainer) are civilians, not targets.
 * Farmable Gaia creatures are the exception: passive prey can be locked
 * even before it has aggroed. The server stays the real authority on target
 * validity.
 */

export interface SoftLockTarget {
  actorId: string;
  x: number;
  y: number;
  distanceCells: number;
}

/** Fallback when the slice carries no range tuning. */
const DEFAULT_MAX_ACQUIRE_RANGE_CELLS = 60;

let maxAcquireRangeCells = DEFAULT_MAX_ACQUIRE_RANGE_CELLS;

/**
 * Boot wiring: lock/cycle range scales with the slice's tuned weapon max
 * (×1.25 approach margin — you may TARGET slightly beyond shooting range),
 * capped at the legacy 60: tuning only ever SHORTENS acquisition.
 */
export function setMaxAcquireRangeFromWeaponMax(weaponMaxCells: number | undefined): void {
  maxAcquireRangeCells = weaponMaxCells && weaponMaxCells > 0
    ? Math.min(DEFAULT_MAX_ACQUIRE_RANGE_CELLS, Math.max(10, Math.round(weaponMaxCells * 1.25)))
    : DEFAULT_MAX_ACQUIRE_RANGE_CELLS;
}

let current: SoftLockTarget | null = null;
let explicitTargetId: string | null = null;

export function softLockTarget(): SoftLockTarget | null {
  return current;
}

/** Explicit target override (Tab cycle / selection). */
export function setExplicitLockTarget(actorId: string | null): void {
  explicitTargetId = actorId;
  if (actorId === null) current = null;
}

export function explicitLockTargetId(): string | null {
  return explicitTargetId;
}

/** True when the actor is a lockable hostile relative to `me`. */
export function isLockableHostile(
  actor: ServerAuthorityActorState | undefined,
  me: ServerAuthorityActorState,
): actor is ServerAuthorityActorState {
  if (!actor || actor.lifeState !== "alive" || actor.areaId !== me.areaId) return false;
  // Farmable passive Gaia wildlife stays targetable before
  // any aggro — the neutral faction table would otherwise exclude them.
  if (isFarmableCreatureIdentity({ role: actor.role ?? "" })) return true;
  if (!actor.factionId) return false; // civilians (camp trainer) are not targets
  if (me.factionId && actor.factionId === me.factionId) return false;
  return true;
}

/**
 * Tab: cycle outward from the player through lockable hostiles by distance.
 * Returns the chosen actor id (also set as the explicit target) or null.
 */
export function cycleTargetOutward(state: PlayState, playerActorId: string): string | null {
  const me = state.serverAuthority.actors[playerActorId];
  if (!me) return null;
  const candidates: { id: string; distance: number }[] = [];
  for (const actorId in state.serverAuthority.actors) {
    if (actorId === playerActorId) continue;
    const actor = state.serverAuthority.actors[actorId];
    if (!isLockableHostile(actor, me)) continue;
    const distance = Math.hypot(actor.x - me.x, actor.y - me.y);
    if (distance > maxAcquireRangeCells) continue;
    candidates.push({ id: actorId, distance });
  }
  if (candidates.length === 0) {
    explicitTargetId = null;
    return null;
  }
  candidates.sort((a, b) => a.distance - b.distance || a.id.localeCompare(b.id));
  const currentIndex = explicitTargetId
    ? candidates.findIndex((entry) => entry.id === explicitTargetId)
    : -1;
  const next = candidates[(currentIndex + 1) % candidates.length]!;
  explicitTargetId = next.id;
  return next.id;
}

/**
 * Recompute the explicit lock for this frame and publish it for the shared
 * Roll-combat input path.
 */
export function updateSoftLock(state: PlayState, playerActorId: string): SoftLockTarget | null {
  const result = computeSoftLock(state, playerActorId);
  state.softLockActorId = result?.actorId ?? null;
  return result;
}

function computeSoftLock(state: PlayState, playerActorId: string): SoftLockTarget | null {
  const me = state.serverAuthority.actors[playerActorId];
  if (!me) {
    current = null;
    return current;
  }

  if (explicitTargetId) {
    const explicit = state.serverAuthority.actors[explicitTargetId];
    if (isLockableHostile(explicit, me)) {
      const distance = Math.hypot(explicit.x - me.x, explicit.y - me.y);
      if (distance <= maxAcquireRangeCells) {
        current = {
          actorId: explicit.id,
          x: explicit.x,
          y: explicit.y,
          distanceCells: distance,
        };
        return current;
      }
    }
    explicitTargetId = null;
  }
  current = null;
  return current;
}
