import type { PlayState, SliceSnapshot } from "@successor/client/src/slice-core/gameState";

/**
 * Factory workbench session link — binds a physical factory prop for the
 * datapad SCHEMATICS manufacture shelf. Same session-truth shape as bankLink:
 * boot sets the id when the terminal opens the datapad, clears it on close or
 * when the player leaves reach so Manufacture buttons never advertise a remote
 * station. Authority still rejects out-of-range; this is honest UX only.
 */

/** Shared sim-side terminal reach (matches authority TERMINAL_INTERACTION_RADIUS). */
const FACTORY_REACH_CELLS = 1.75;

let activeFactoryId: string | null = null;
let schematicsOpenRequested = false;
let schematicsOpenListener: (() => void) | null = null;

export function setActiveFactory(propId: string | null): void {
  activeFactoryId = propId && propId.trim().length > 0 ? propId.trim() : null;
}

export function activeFactory(): string | null {
  return activeFactoryId;
}

/** Register the live datapad mount so an already-open pad can switch tabs now. */
export function setFactorySchematicsOpenListener(listener: (() => void) | null): void {
  schematicsOpenListener = listener;
}

/**
 * Ask the datapad to show SCHEMATICS. If mounted, runs immediately; otherwise
 * the next mount/update consumes the pending request.
 */
export function requestFactorySchematicsOpen(): void {
  schematicsOpenRequested = true;
  if (schematicsOpenListener) {
    schematicsOpenRequested = false;
    schematicsOpenListener();
  }
}

export function consumeFactorySchematicsOpenRequest(): boolean {
  if (!schematicsOpenRequested) return false;
  schematicsOpenRequested = false;
  return true;
}

function factoryDistance(state: PlayState, slice: SliceSnapshot, propId: string): number | null {
  const actorId = state.serverAuthority.playerActorId ?? state.playerActorId;
  const me = state.serverAuthority.actors[actorId];
  const areaId = me?.areaId ?? state.activeAreaId;
  const x = me?.x ?? state.player.x;
  const y = me?.y ?? state.player.y;
  const prop = slice.props.find(
    (candidate) =>
      candidate.id === propId
      && candidate.areaId === areaId
      && candidate.interactive
      && candidate.kind === "factory",
  );
  if (!prop) return null;
  return Math.hypot(
    x + 0.5 - (prop.cell.x + prop.size.w / 2),
    y + 0.5 - (prop.cell.y + prop.size.h / 2),
  );
}

export function withinFactoryRange(state: PlayState, slice: SliceSnapshot, propId: string): boolean {
  const distance = factoryDistance(state, slice, propId);
  return distance !== null && distance <= FACTORY_REACH_CELLS;
}

export interface FactorySession {
  factoryId: string | null;
  inReach: boolean;
}

/**
 * Re-derive binding from authority positions. Leaving reach clears the bind so
 * the drafts shelf stops offering Manufacture (no remote-factory lie).
 */
export function resolveFactorySession(state: PlayState, slice: SliceSnapshot): FactorySession {
  if (activeFactoryId !== null && !withinFactoryRange(state, slice, activeFactoryId)) {
    activeFactoryId = null;
  }
  const factoryId = activeFactoryId;
  return {
    factoryId,
    inReach: factoryId !== null && withinFactoryRange(state, slice, factoryId),
  };
}

/** Test helper: wipe module session between cases. */
export function resetFactoryLinkForTests(): void {
  activeFactoryId = null;
  schematicsOpenRequested = false;
  schematicsOpenListener = null;
}
