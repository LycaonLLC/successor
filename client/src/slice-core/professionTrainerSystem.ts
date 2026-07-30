import type {
  ActorSnapshot,
  InteractionOption,
  PlayState,
  ServerAuthorityActorState,
  SliceSnapshot,
} from "./gameState";

export const professionTrainerInteractionRadiusCells = 1.75;

export interface ProfessionTrainerCandidate {
  source: ActorSnapshot;
  authority: ServerAuthorityActorState | null;
  areaId: string;
  x: number;
  y: number;
  distanceCells: number;
}

export function isProfessionTrainerActor(actor: Pick<ActorSnapshot, "role"> & Partial<Pick<ActorSnapshot, "capabilities">>): boolean {
  return actor.role === "profession_trainer"
    || actor.role.endsWith("_trainer")
    || (actor.capabilities ?? []).some((capability) => capability === "train:profession");
}

export function professionTrainerInteractionOptions(
  slice: SliceSnapshot,
  state: PlayState,
): InteractionOption[] {
  return professionTrainerCandidates(slice, state)
    .filter((candidate) => candidate.distanceCells <= professionTrainerInteractionRadiusCells)
    .map((candidate) => ({
      id: `trainer:${candidate.source.id}`,
      kind: "trainer",
      label: candidate.source.label || "Profession Trainer",
      detail: "Profession training",
      targetId: candidate.source.id,
      distanceCells: candidate.distanceCells,
    }));
}

export function nearestProfessionTrainer(
  slice: SliceSnapshot,
  state: PlayState,
): ProfessionTrainerCandidate | null {
  return professionTrainerCandidates(slice, state)
    .find((candidate) => candidate.distanceCells <= professionTrainerInteractionRadiusCells)
    ?? null;
}

export function professionTrainerById(
  slice: SliceSnapshot,
  state: PlayState,
  actorId: string | null | undefined,
): ProfessionTrainerCandidate | null {
  if (!actorId) return null;
  return professionTrainerCandidates(slice, state).find((candidate) => candidate.source.id === actorId) ?? null;
}

function professionTrainerCandidates(
  slice: SliceSnapshot,
  state: PlayState,
): ProfessionTrainerCandidate[] {
  const player = authoritativePlayerActor(state);
  if (!player) return [];
  return slice.actors
    .filter(isProfessionTrainerActor)
    .map((source) => professionTrainerCandidate(source, state, player))
    .filter((candidate): candidate is ProfessionTrainerCandidate => candidate !== null)
    .sort((a, b) => a.distanceCells - b.distanceCells || a.source.id.localeCompare(b.source.id));
}

function professionTrainerCandidate(
  source: ActorSnapshot,
  state: PlayState,
  player: ServerAuthorityActorState,
): ProfessionTrainerCandidate | null {
  const authority = state.serverAuthority.actors[source.id] ?? null;
  if (authority && authority.lifeState !== "alive") return null;
  const areaId = authority?.areaId ?? source.areaId;
  if (areaId !== player.areaId) return null;
  const x = authority?.x ?? source.cell.x + 0.5;
  const y = authority?.y ?? source.cell.y + 0.5;
  return {
    source,
    authority,
    areaId,
    x,
    y,
    distanceCells: Math.hypot(player.x - x, player.y - y),
  };
}

function authoritativePlayerActor(state: PlayState): ServerAuthorityActorState | null {
  const actorId = state.serverAuthority.playerActorId ?? state.playerActorId;
  return state.serverAuthority.actors[actorId] ?? null;
}
