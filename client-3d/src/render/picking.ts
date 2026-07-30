import type {
  ActorSnapshot,
  PlayState,
  ServerAuthorityActorState,
  SliceSnapshot,
} from "@successor/client/src/slice-core/gameState";
import { SUCCESSOR_3D_CONFIG } from "../config";
import type { ScreenPoint } from "./camera";
import type { WorldPropPickResult } from "./props";

export interface ScreenProjector {
  worldToScreen: (x: number, z: number, y?: number, target?: ScreenPoint) => ScreenPoint;
}

type PickActor = ActorSnapshot | ServerAuthorityActorState;

export interface PropPickSurface {
  pickPropAtScreenPoint: (screenX: number, screenY: number) => WorldPropPickResult | null;
}

export function pickPropAtScreenPoint3d(
  surface: PropPickSurface,
  screenX: number,
  screenY: number,
): WorldPropPickResult | null {
  return surface.pickPropAtScreenPoint(screenX, screenY);
}

type PickActorCombat = PlayState["actors"][string];

const HUMANOID_PICK_HEIGHT_UNITS = SUCCESSOR_3D_CONFIG.pawnPack.heightTargetUnits;
const PICK_WIDTH_UNITS = 0.7;
const ROUTE_CYCLE_MS = 8200;
const PICK_EPSILON = 1e-6;

const cameraYawRadians = SUCCESSOR_3D_CONFIG.camera.yawDegrees * Math.PI / 180;
const screenRightX = Math.cos(cameraYawRadians);
const screenRightZ = -Math.sin(cameraYawRadians);

const scratchGroundScreen: ScreenPoint = { px: 0, py: 0 };
const scratchHeadScreen: ScreenPoint = { px: 0, py: 0 };
const scratchMidScreen: ScreenPoint = { px: 0, py: 0 };
const scratchSideScreen: ScreenPoint = { px: 0, py: 0 };
const scratchPosition = { x: 0, y: 0 };

let bestSilhouetteActorId: string | null = null;
let bestSilhouetteDepthY = -Infinity;
let bestSilhouetteDistanceSq = Infinity;
let bestGroundActorId: string | null = null;
let bestGroundDepthY = -Infinity;
let groundFallbackCellSizePx = 1;

/**
 * 3D-client cursor picking: first test the visible upright on-screen actor
 * silhouette, then use a ground-plane footprint pick as fallback.
 *
 * The return value is an actor id rather than an actor object so server-only
 * authority actors can be selected without allocating transient TargetableActor
 * wrappers on the input path.
 */
export function pickActorAtScreenPoint3d(
  slice: SliceSnapshot,
  state: PlayState,
  timeMs: number,
  screenX: number,
  screenY: number,
  groundX: number,
  groundZ: number,
  projector: ScreenProjector,
): string | null {
  bestSilhouetteActorId = null;
  bestSilhouetteDepthY = -Infinity;
  bestSilhouetteDistanceSq = Infinity;
  visitPickCandidates(slice, state, timeMs, visitSilhouetteCandidate, projector, screenX, screenY);
  if (bestSilhouetteActorId !== null) return bestSilhouetteActorId;

  bestGroundActorId = null;
  bestGroundDepthY = -Infinity;
  groundFallbackCellSizePx = slice.grid.cellSizePx;
  visitPickCandidates(slice, state, timeMs, visitGroundFallbackCandidate, null, groundX, groundZ);
  return bestGroundActorId;
}

function visitSilhouetteCandidate(
  actorId: string,
  actor: PickActor,
  _sourceActor: ActorSnapshot | null,
  posX: number,
  posY: number,
  projector: ScreenProjector | null,
  screenX: number,
  screenY: number,
): void {
  if (!projector) return;
  const distanceSq = silhouetteDistanceSq(actorId, actor, posX + 0.5, posY + 0.5, screenX, screenY, projector);
  if (!Number.isFinite(distanceSq)) return;
  if (posY > bestSilhouetteDepthY + PICK_EPSILON) {
    bestSilhouetteActorId = actorId;
    bestSilhouetteDepthY = posY;
    bestSilhouetteDistanceSq = distanceSq;
    return;
  }
  if (Math.abs(posY - bestSilhouetteDepthY) <= PICK_EPSILON && distanceSq < bestSilhouetteDistanceSq) {
    bestSilhouetteActorId = actorId;
    bestSilhouetteDistanceSq = distanceSq;
  }
}

function visitGroundFallbackCandidate(
  actorId: string,
  _actor: PickActor,
  _sourceActor: ActorSnapshot | null,
  posX: number,
  posY: number,
  _projector: ScreenProjector | null,
  groundX: number,
  groundZ: number,
): void {
  if (posY <= bestGroundDepthY) return;
  const cell = groundFallbackCellSizePx;
  const pointX = groundX * cell;
  const pointY = groundZ * cell;
  const feetX = posX * cell + cell / 2;
  const feetY = (posY + 1) * cell;
  if (Math.abs(pointX - feetX) > 24) return;
  if (pointY < feetY - 92 || pointY > feetY + 8) return;
  bestGroundActorId = actorId;
  bestGroundDepthY = posY;
}

function visitPickCandidates(
  slice: SliceSnapshot,
  state: PlayState,
  timeMs: number,
  visitor: (
    actorId: string,
    actor: PickActor,
    sourceActor: ActorSnapshot | null,
    posX: number,
    posY: number,
    projector: ScreenProjector | null,
    pointerX: number,
    pointerY: number,
  ) => void,
  projector: ScreenProjector | null,
  pointerX: number,
  pointerY: number,
): void {
  const actors = slice.actors;
  for (let i = 0; i < actors.length; i += 1) {
    const actor = actors[i]!;
    const serverActor = state.serverAuthority.enabled ? state.serverAuthority.actors[actor.id] : undefined;
    if (!authoredActorPickable(actor, serverActor, slice, state)) continue;
    actorPosition(actor, serverActor, slice, state, timeMs, scratchPosition);
    visitor(actor.id, serverActor ?? actor, actor, scratchPosition.x, scratchPosition.y, projector, pointerX, pointerY);
  }

  if (!state.serverAuthority.enabled) return;
  const serverActors = state.serverAuthority.actors;
  for (const actorId in serverActors) {
    const actor = serverActors[actorId];
    if (!actor || !dynamicServerActorPickable(actorId, actor, slice, state)) continue;
    scratchPosition.x = actor.renderX ?? actor.x;
    scratchPosition.y = actor.renderY ?? actor.y;
    visitor(actorId, actor, null, scratchPosition.x, scratchPosition.y, projector, pointerX, pointerY);
  }
}

function authoredActorPickable(
  actor: ActorSnapshot,
  serverActor: ServerAuthorityActorState | undefined,
  slice: SliceSnapshot,
  state: PlayState,
): boolean {
  if (isObserverCameraGhostActorId(actor.id, slice, state)) return false;
  if (actor.id === slice.camera.followActor) return true;
  if (state.serverAuthority.enabled) {
    return Boolean(serverActor && serverActor.lifeState !== "respawning" && serverActor.areaId === state.activeAreaId);
  }
  return (serverActor?.areaId ?? actor.areaId) === state.activeAreaId;
}

function dynamicServerActorPickable(
  actorId: string,
  actor: ServerAuthorityActorState,
  slice: SliceSnapshot,
  state: PlayState,
): boolean {
  if (actorId === slice.camera.followActor) return false;
  if (actor.areaId !== state.activeAreaId || actor.lifeState === "respawning") return false;
  return !sliceHasActor(slice, actorId);
}


function actorPosition(
  actor: ActorSnapshot,
  serverActor: ServerAuthorityActorState | undefined,
  slice: SliceSnapshot,
  state: PlayState,
  timeMs: number,
  out: { x: number; y: number },
): void {
  if (actor.id === slice.camera.followActor && !isObserverCameraGhostActorId(actor.id, slice, state)) {
    out.x = state.player.x;
    out.y = state.player.y;
    return;
  }
  if (serverActor) {
    out.x = serverActor.renderX ?? serverActor.x;
    out.y = serverActor.renderY ?? serverActor.y;
    return;
  }
  const combat: PickActorCombat | undefined = state.actors[actor.id];
  if (combat?.downed && combat.downedCell) {
    out.x = combat.downedCell.x;
    out.y = combat.downedCell.y;
    return;
  }
  routePosition(actor, timeMs, out);
}

function routePosition(actor: ActorSnapshot, timeMs: number, out: { x: number; y: number }): void {
  const route = actor.route;
  if (route.length < 2) {
    out.x = actor.cell.x;
    out.y = actor.cell.y;
    return;
  }
  const progress = (timeMs % ROUTE_CYCLE_MS) / ROUTE_CYCLE_MS;
  const segmentCount = route.length;
  const exact = progress * segmentCount;
  const segmentIndex = Math.min(Math.floor(exact), segmentCount - 1);
  const from = route[segmentIndex] ?? route[0]!;
  const to = route[(segmentIndex + 1) % route.length] ?? from;
  const local = exact - segmentIndex;
  out.x = from.x + (to.x - from.x) * local;
  out.y = from.y + (to.y - from.y) * local;
}

function silhouetteDistanceSq(
  _actorId: string,
  actor: PickActor,
  centerX: number,
  centerZ: number,
  screenX: number,
  screenY: number,
  projector: ScreenProjector,
): number {
  const sprite = "sprite" in actor && typeof actor.sprite === "string" ? actor.sprite : "";
  const creatureBounds = GAIA_CREATURE_PICK_BOUNDS[sprite];
  const visualScale = actorVisualScale(actor);
  const height = creatureBounds ? creatureBounds.height * visualScale : HUMANOID_PICK_HEIGHT_UNITS;
  const width = creatureBounds ? creatureBounds.width * visualScale : PICK_WIDTH_UNITS;
  const midY = height * 0.5;
  const halfWidth = width * 0.5;

  projector.worldToScreen(centerX, centerZ, 0, scratchGroundScreen);
  projector.worldToScreen(centerX, centerZ, height, scratchHeadScreen);
  projector.worldToScreen(centerX, centerZ, midY, scratchMidScreen);
  projector.worldToScreen(
    centerX + screenRightX * halfWidth,
    centerZ + screenRightZ * halfWidth,
    midY,
    scratchSideScreen,
  );

  const radiusDx = scratchSideScreen.px - scratchMidScreen.px;
  const radiusDy = scratchSideScreen.py - scratchMidScreen.py;
  const radiusSq = radiusDx * radiusDx + radiusDy * radiusDy;
  const distanceSq = pointSegmentDistanceSq(
    screenX,
    screenY,
    scratchGroundScreen.px,
    scratchGroundScreen.py,
    scratchHeadScreen.px,
    scratchHeadScreen.py,
  );
  return distanceSq <= radiusSq ? distanceSq : Infinity;
}

function pointSegmentDistanceSq(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const abx = bx - ax;
  const aby = by - ay;
  const lenSq = abx * abx + aby * aby;
  if (lenSq <= PICK_EPSILON) {
    const dx = px - ax;
    const dy = py - ay;
    return dx * dx + dy * dy;
  }
  const t = Math.max(0, Math.min(1, ((px - ax) * abx + (py - ay) * aby) / lenSq));
  const cx = ax + abx * t;
  const cy = ay + aby * t;
  const dx = px - cx;
  const dy = py - cy;
  return dx * dx + dy * dy;
}

function actorVisualScale(actor: PickActor): number {
  const scale = "scale" in actor ? actor.scale : undefined;
  if (typeof scale === "number" && Number.isFinite(scale) && scale > 0) return scale;
  return 1;
}

/** Pick envelopes measured from the six current rigged Gaia creature GLBs. */
const GAIA_CREATURE_PICK_BOUNDS: Readonly<Record<string, { height: number; width: number }>> = {
  "creature-bellback-adult": { height: 1.52, width: 0.72 },
  "creature-pebblehorn-adult": { height: 0.97, width: 1.62 },
  "creature-snufflefin-adult": { height: 0.94, width: 0.65 },
  "creature-pocketclod-adult": { height: 0.98, width: 1.07 },
  "creature-mossmuff-adult": { height: 1.37, width: 2.05 },
  "creature-dapplepod-adult": { height: 0.99, width: 0.75 },
};

function isObserverCameraGhostActorId(actorId: string, slice: SliceSnapshot, state: PlayState): boolean {
  const followActorId = state.observerCamera.followActorId;
  return Boolean(followActorId && actorId === slice.camera.followActor && actorId !== followActorId);
}

function sliceHasActor(slice: SliceSnapshot, actorId: string): boolean {
  const actors = slice.actors;
  for (let i = 0; i < actors.length; i += 1) {
    if (actors[i]!.id === actorId) return true;
  }
  return false;
}
