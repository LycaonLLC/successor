import { actorRelationToPlayer, type ActorRelationSubject, type ActorRelationToPlayer } from "./actorRelationSystem";
import type { ActorSnapshot, PlayState, ServerAuthorityActorState, SliceSnapshot } from "./gameState";

/** The presentation-side target row. It is a visibility/name/relation view only;
 * Rust remains the authority for every combat legality decision. */
export interface VisibleTargetActor extends ActorRelationSubject {
  areaId: string;
  x: number;
  y: number;
  lifeState: string;
  relation: ActorRelationToPlayer;
  descriptor?: string;
}

export interface TargetSelectionContext {
  state: PlayState;
  slice: SliceSnapshot;
}

export type TargetSelectionError = "no_target" | "ambiguous_target" | "target_not_visible";

export type TargetSelectionResult =
  | { ok: true; actor: VisibleTargetActor; selector: string }
  | { ok: false; error: TargetSelectionError; selector: string; candidates?: VisibleTargetActor[] };

/** Current AOI/area actors, with one deterministic source and no stale rows. */
export function visibleTargetActors(context: TargetSelectionContext, includeSelf = false): VisibleTargetActor[] {
  const { state, slice } = context;
  const playerId = state.serverAuthority.playerActorId ?? state.playerActorId;
  const localById = new Map(slice.actors.map((actor) => [actor.id, actor]));
  const useAuthority = state.serverAuthority.enabled
    && state.serverAuthority.sourceMatchesClient !== false
    && Object.keys(state.serverAuthority.actors).length > 0;
  const sourceRows = useAuthority
    ? Object.values(state.serverAuthority.actors).map((actor) => actorFromServer(context, actor, localById.get(actor.id) ?? null))
    : slice.actors.map((actor) => actorFromLocal(context, actor));
  return sourceRows
    .filter((actor): actor is VisibleTargetActor => actor !== null)
    .filter((actor) => actor.areaId === state.activeAreaId)
    .filter((actor) => includeSelf || actor.id !== playerId)
    .sort((left, right) => left.id.localeCompare(right.id));
}

/** Resolve the Core3-style selector against visible actors only. */
export function resolveTargetSelector(context: TargetSelectionContext, rawSelector: string): TargetSelectionResult {
  const selector = rawSelector.trim();
  const normalized = selector.toLowerCase();
  const all = visibleTargetActors(context, true);
  const playerId = context.state.serverAuthority.playerActorId ?? context.state.playerActorId;
  if (normalized === "self" || normalized === "me") {
    const self = all.find((actor) => actor.id === playerId);
    return self
      ? { ok: true, actor: self, selector }
      : { ok: false, error: "target_not_visible", selector };
  }
  if (!selector) return { ok: false, error: "no_target", selector };
  const candidates = all.filter((actor) => actor.id !== playerId);
  if (normalized === "nearest hostile") {
    const hostile = candidates
      .filter((actor) => actor.relation === "hostile")
      .map((actor) => ({ actor, distance: distanceFromPlayer(context, actor) }))
      .sort((left, right) => left.distance - right.distance || left.actor.id.localeCompare(right.actor.id));
    const actor = hostile[0]?.actor;
    return actor
      ? { ok: true, actor, selector }
      : { ok: false, error: "no_target", selector };
  }
  if (normalized === "next" || normalized === "previous") {
    const order = candidates;
    if (order.length === 0) return { ok: false, error: "no_target", selector };
    const currentId = context.state.selectedActorId;
    const currentIndex = currentId ? order.findIndex((actor) => actor.id === currentId) : -1;
    const step = normalized === "previous" ? -1 : 1;
    const index = currentIndex < 0
      ? (step > 0 ? 0 : order.length - 1)
      : (currentIndex + step + order.length) % order.length;
    return { ok: true, actor: order[index]!, selector };
  }
  const exact = candidates.filter((actor) => actor.id.toLowerCase() === normalized || actor.label?.toLowerCase() === normalized);
  if (exact.length === 1) return { ok: true, actor: exact[0]!, selector };
  if (exact.length > 1) return { ok: false, error: "ambiguous_target", selector, candidates: exact };
  const prefix = candidates.filter((actor) => actor.id.toLowerCase().startsWith(normalized) || actor.label?.toLowerCase().startsWith(normalized));
  if (prefix.length === 1) return { ok: true, actor: prefix[0]!, selector };
  if (prefix.length > 1) return { ok: false, error: "ambiguous_target", selector, candidates: prefix };
  return { ok: false, error: "target_not_visible", selector };
}

/** Mutate only local presentation selection. Soft-lock is an independent state,
 * so callers choose whether this interaction also requests a soft-lock. */
export function setSelectedTarget(state: PlayState, actorId: string | null, softLock = false): void {
  state.selectedActorId = actorId;
  if (softLock) state.softLockActorId = actorId;
}

/** Drop stale selection/lock when a target leaves the current visible area. */
export function clearInvisibleTargetSelection(context: TargetSelectionContext): void {
  const visible = new Set(visibleTargetActors(context, true).map((actor) => actor.id));
  if (context.state.selectedActorId && !visible.has(context.state.selectedActorId)) context.state.selectedActorId = null;
  if (context.state.softLockActorId && !visible.has(context.state.softLockActorId)) context.state.softLockActorId = null;
}

function actorFromServer(context: TargetSelectionContext, actor: ServerAuthorityActorState, local: ActorSnapshot | null): VisibleTargetActor | null {
  if (actor.lifeState === "respawning") return null;
  const subject = {
    id: actor.id,
    label: actor.label,
    role: actor.role ?? local?.role ?? null,
    sprite: actor.sprite ?? local?.sprite ?? null,
    factionId: actor.factionId ?? local?.factionId ?? null,
    aiAttitude: actor.aiAttitude ?? local?.aiAttitude ?? null,
    willAutoAggro: actor.willAutoAggro ?? null,
    playerOrganizationId: actor.playerOrganizationId ?? local?.playerOrganizationId ?? null,
    playerOrganizationTag: actor.playerOrganizationTag ?? local?.playerOrganizationTag ?? null,
  };
  return {
    ...subject,
    areaId: actor.areaId,
    x: actor.x,
    y: actor.y,
    relation: actorRelationToPlayer(subject, context.slice, context.state),
    lifeState: actor.lifeState,
    descriptor: actor.descriptor,
  };
}

function actorFromLocal(context: TargetSelectionContext, actor: ActorSnapshot): VisibleTargetActor {
  const subject = {
    id: actor.id,
    label: actor.label,
    role: actor.role,
    sprite: actor.sprite,
    factionId: actor.factionId ?? null,
    aiAttitude: actor.aiAttitude ?? null,
    willAutoAggro: null,
    playerOrganizationId: actor.playerOrganizationId ?? null,
    playerOrganizationTag: actor.playerOrganizationTag ?? null,
  };
  return {
    ...subject,
    areaId: actor.areaId,
    x: actor.cell.x,
    y: actor.cell.y,
    relation: actorRelationToPlayer(subject, context.slice, context.state),
    lifeState: context.state.actors[actor.id]?.lifeState ?? "alive",
  };
}

function distanceFromPlayer(context: TargetSelectionContext, actor: VisibleTargetActor): number {
  const playerId = context.state.serverAuthority.playerActorId ?? context.state.playerActorId;
  const serverPlayer = context.state.serverAuthority.actors[playerId];
  const origin = serverPlayer && serverPlayer.areaId === context.state.activeAreaId
    ? { x: serverPlayer.x, y: serverPlayer.y }
    : context.state.player;
  return Math.hypot(actor.x - origin.x, actor.y - origin.y);
}
