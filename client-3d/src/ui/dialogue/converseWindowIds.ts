/** Eager converse id + target binding (chip / F-prompt seams). */
export const CONVERSE_WINDOW_ID = "converse";

let converseTargetActorId: string | null = null;
let converseGeneration = 0;

/** Bind the conversation target and start a fresh session (opener calls this before openWindow). */
export function setConverseTarget(actorId: string | null): void {
  converseTargetActorId = actorId;
  converseGeneration += 1;
}

/** Currently bound conversation target (chip-suppression seam). */
export function converseTargetId(): string | null {
  return converseTargetActorId;
}

/** Session generation counter — content mount reads this after load. */
export function converseGenerationToken(): number {
  return converseGeneration;
}

/** Internal read for the deferred converse mount. */
export function converseTargetActorIdRef(): string | null {
  return converseTargetActorId;
}
