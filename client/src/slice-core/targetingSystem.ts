import { directionFromVector, normalizeDirection, type Cell, type Direction, type Point } from "./geometry";

export interface TargetableActor {
  id: string;
  areaId: string;
  direction: string;
  cell: Cell;
  route: Cell[];
}

export interface TargetingSlice<Actor extends TargetableActor> {
  grid: {
    cellSizePx: number;
  };
  camera: {
    followActor: string;
  };
  actors: Actor[];
}

export interface TargetingActorCombat {
  downed: boolean;
  downedCell: Cell | null;
}

export interface TargetingState {
  activeAreaId: string;
  player: Cell;
  actors: Record<string, TargetingActorCombat | undefined>;
  observerCamera?: {
    followActorId: string | null;
  };
  serverAuthority?: {
    enabled: boolean;
    actors: Record<string, {
      areaId: string;
      x: number;
      y: number;
      renderX?: number;
      renderY?: number;
      lifeState?: string;
      direction?: string;
    } | undefined>;
  };
}

export function actorWorldPosition<Actor extends TargetableActor>(
  actor: Actor,
  slice: TargetingSlice<Actor>,
  state: TargetingState,
  time: number,
): Cell {
  if (actor.id === slice.camera.followActor && !isObserverCameraGhostActor(actor, slice, state)) return state.player;
  const serverActor = state.serverAuthority?.enabled ? state.serverAuthority.actors[actor.id] : null;
  if (serverActor) return { x: serverActor.renderX ?? serverActor.x, y: serverActor.renderY ?? serverActor.y };
  const combat = state.actors[actor.id];
  return combat?.downed && combat.downedCell ? combat.downedCell : actorRoutePosition(actor, time);
}

export function isObserverCameraGhostActor<Actor extends TargetableActor>(
  actor: Actor,
  slice: TargetingSlice<Actor>,
  state: TargetingState,
): boolean {
  const followActorId = state.observerCamera?.followActorId;
  return Boolean(followActorId && actor.id === slice.camera.followActor && actor.id !== followActorId);
}

export function routeDirection(actor: TargetableActor, time: number): Direction {
  if (actor.route.length < 2) return normalizeDirection(actor.direction);
  const segment = closedRouteSegment(actor.route, time);
  const from = segment.from;
  const to = segment.to;
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  return directionFromVector(dx, dy, normalizeDirection(actor.direction));
}

export function pickActor<Actor extends TargetableActor>(
  slice: TargetingSlice<Actor>,
  state: TargetingState,
  time: number,
  point: Point,
): TargetableActor | null {
  const cell = slice.grid.cellSizePx;
  const candidates = [...slice.actors, ...dynamicServerActors(slice, state)]
    .filter((actor) => {
      if (isObserverCameraGhostActor(actor, slice, state)) return false;
      if (actor.id === slice.camera.followActor) return true;
      const serverAuthority = state.serverAuthority;
      const serverAuthorityEnabled = Boolean(serverAuthority?.enabled);
      const serverActor = serverAuthorityEnabled ? serverAuthority?.actors[actor.id] : null;
      if (serverAuthorityEnabled) {
        return Boolean(serverActor && serverActor.lifeState !== "respawning" && serverActor.areaId === state.activeAreaId);
      }
      return (serverActor?.areaId ?? actor.areaId) === state.activeAreaId;
    })
    .map((actor) => ({
      actor,
      pos: actorWorldPosition(actor, slice, state, time),
    }))
    .sort((left, right) => right.pos.y - left.pos.y);

  for (const candidate of candidates) {
    const feetX = candidate.pos.x * cell + cell / 2;
    const feetY = (candidate.pos.y + 1) * cell;
    const insideX = Math.abs(point.x - feetX) <= 24;
    const insideY = point.y >= feetY - 92 && point.y <= feetY + 8;
    if (insideX && insideY) return candidate.actor;
  }
  return null;
}

function dynamicServerActors<Actor extends TargetableActor>(
  slice: TargetingSlice<Actor>,
  state: TargetingState,
): TargetableActor[] {
  if (!state.serverAuthority?.enabled) return [];
  const authoredActorIds = new Set(slice.actors.map((actor) => actor.id));
  return Object.entries(state.serverAuthority.actors)
    .flatMap(([actorId, actor]) => {
      if (
        !actor
        || actorId === slice.camera.followActor
        || authoredActorIds.has(actorId)
        || actor.areaId !== state.activeAreaId
        || actor.lifeState === "respawning"
      ) {
        return [];
      }
      return [{
        id: actorId,
        areaId: actor.areaId,
        direction: actor.direction ?? "front",
        cell: { x: actor.x, y: actor.y },
        route: [],
      }];
    });
}

function actorRoutePosition(actor: TargetableActor, time: number): Cell {
  if (actor.route.length < 2) return actor.cell;
  const segment = closedRouteSegment(actor.route, time);
  return {
    x: segment.from.x + (segment.to.x - segment.from.x) * segment.local,
    y: segment.from.y + (segment.to.y - segment.from.y) * segment.local,
  };
}

function closedRouteSegment(route: Cell[], time: number): { from: Cell; to: Cell; local: number } {
  const cycleMs = 8200;
  const progress = (time % cycleMs) / cycleMs;
  const segmentCount = route.length;
  const exact = progress * segmentCount;
  const segmentIndex = Math.min(Math.floor(exact), segmentCount - 1);
  const from = route[segmentIndex] ?? route[0]!;
  const to = route[(segmentIndex + 1) % route.length] ?? from;
  return {
    from,
    to,
    local: exact - segmentIndex,
  };
}
