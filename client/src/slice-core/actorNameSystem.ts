import type { PlayState } from "./gameState";
import { serverAuthorityDisplayName } from "./npcSystem";

const TRAILING_TYPE_READ = /\s*\([^()]*\)\s*$/u;

/** Remove a trailing descriptor such as `(a rogue trooper)` from a label. */
export function stripTypeRead(label: string): string {
  const stripped = label.replace(TRAILING_TYPE_READ, "").trim();
  return stripped.length > 0 ? stripped : label.trim();
}

/** Resolve the clean actor name shared by headed and terminal clients. */
export function cleanActorName(
  actor: { label?: string | null; displayName?: string | null } | null | undefined,
  fallback: string,
): string {
  if (!actor) return fallback;
  const display = serverAuthorityDisplayName(actor.displayName);
  if (display) return display;
  const label = actor.label?.trim();
  return label ? stripTypeRead(label) : fallback;
}

export function cleanActorNameById(state: PlayState, actorId: string): string {
  return cleanActorName(state.serverAuthority.actors[actorId], actorId);
}
