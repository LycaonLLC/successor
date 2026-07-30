import { normalizeDirection, type Cell, type Direction } from "./geometry";
import type { PlayState, SliceSnapshot } from "./gameState";
import { buildBlockedCells, buildMovementBlockers, transitionsForArea } from "./worldQueries";
import type { AreaTransitionSnapshot, CloneFacilitySnapshot } from "./worldTypes";

export interface TransitionArrival {
  activeAreaId: string;
  player: Cell;
  facing: Direction;
  label: string;
  status: string;
}

export interface CloneRespawnArrival {
  activeAreaId: string;
  player: Cell;
  facing: Direction;
  label: string;
}

export interface TransitionArrivalMutationOptions {
  cooldownMs: number;
  flashMs: number;
  status?: string;
  clearFloatingText?: boolean;
}

export function transitionCenter(player: Cell): Cell {
  return { x: player.x + 0.5, y: player.y + 0.5 };
}

export function transitionAtPlayerPosition(
  transitions: AreaTransitionSnapshot[],
  player: Cell,
): AreaTransitionSnapshot | null {
  const center = transitionCenter(player);
  return transitions.find((transition) => (
    center.x >= transition.fromCell.x &&
    center.x < transition.fromCell.x + transition.triggerSize.w &&
    center.y >= transition.fromCell.y &&
    center.y < transition.fromCell.y + transition.triggerSize.h
  )) ?? null;
}

export function transitionArrival(transition: AreaTransitionSnapshot): TransitionArrival {
  return {
    activeAreaId: transition.toAreaId,
    player: { ...transition.toCell },
    facing: normalizeDirection(transition.toFacing),
    label: transition.label,
    status: transition.label.toLowerCase(),
  };
}

export function cloneFacilityForRespawn(facilities: CloneFacilitySnapshot[]): CloneFacilitySnapshot | null {
  return facilities[0] ?? null;
}

export function cloneRespawnArrival(facility: CloneFacilitySnapshot): CloneRespawnArrival {
  return {
    activeAreaId: facility.areaId,
    player: { ...facility.respawnCell },
    facing: normalizeDirection(facility.respawnFacing),
    label: "Cloning Center Respawn",
  };
}

export function applyTransitionArrivalState(
  state: PlayState,
  slice: Pick<SliceSnapshot, "areas" | "blockedCells" | "props">,
  arrival: TransitionArrival | CloneRespawnArrival,
  options: TransitionArrivalMutationOptions,
) {
  state.activeAreaId = arrival.activeAreaId;
  state.player = { ...arrival.player };
  state.facing = arrival.facing;
  state.blocked = buildBlockedCells(slice, state.activeAreaId);
  state.movementBlockers = buildMovementBlockers(slice, state.activeAreaId, state.serverAuthority?.propStates ?? {}, state.serverAuthority?.placedCamps ?? []);
  if (options.clearFloatingText) state.floatingTexts = [];
  state.selectedActorId = null;
  state.examineActorId = null;
  state.transitionCooldownMs = options.cooldownMs;
  state.transitionFlashMs = options.flashMs;
  state.lastTransitionLabel = arrival.label;
  if (options.status !== undefined) {
    state.status = options.status;
  }
}

export function applyAreaTransitionState(
  state: PlayState,
  slice: Pick<SliceSnapshot, "areas" | "blockedCells" | "props" | "transitions">,
): TransitionArrival | null {
  if (state.transitionCooldownMs > 0) return null;
  const transition = transitionAtPlayerPosition(transitionsForArea(slice, state.activeAreaId), state.player);
  if (!transition) return null;
  const arrival = transitionArrival(transition);
  applyTransitionArrivalState(state, slice, arrival, {
    cooldownMs: 650,
    flashMs: 420,
    status: arrival.status,
  });
  return arrival;
}

export function applyCloneRespawnArrivalState(
  state: PlayState,
  slice: Pick<SliceSnapshot, "areas" | "blockedCells" | "props">,
  arrival: CloneRespawnArrival,
) {
  applyTransitionArrivalState(state, slice, arrival, {
    cooldownMs: 650,
    flashMs: 460,
    clearFloatingText: true,
  });
}
