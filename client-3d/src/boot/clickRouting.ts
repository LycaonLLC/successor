export const TARGET_DOUBLE_CLICK_MS = 350;

export type ActorClickIntent = "target" | "defaultAction";
export type ActorDefaultAction = "attack" | "examine";
export type PropClickIntent = "examine" | "defaultAction";
export type ActorPointerGrammarDecision =
  | "targetOnly"
  | "openRadial"
  | "defaultAttack"
  | "defaultExamine"
  | "groundOnly"
  | "strafeGround";
export type PropPointerGrammarDecision =
  | "propExamine"
  | "propDefaultLoot"
  | "propRadial";

export interface ActorClickMemory {
  lastActorId: string | null;
  lastAtMs: number;
}

export function createActorClickMemory(): ActorClickMemory {
  return { lastActorId: null, lastAtMs: Number.NEGATIVE_INFINITY };
}

export interface PropClickMemory {
  lastPropId: string | null;
  lastAtMs: number;
}

export function createPropClickMemory(): PropClickMemory {
  return { lastPropId: null, lastAtMs: Number.NEGATIVE_INFINITY };
}

export function classifyActorClick(
  memory: ActorClickMemory,
  actorId: string,
  nowMs: number,
  doubleClickMs = TARGET_DOUBLE_CLICK_MS,
): ActorClickIntent {
  const elapsed = nowMs - memory.lastAtMs;
  const sameActor = memory.lastActorId === actorId;
  memory.lastActorId = actorId;
  memory.lastAtMs = nowMs;
  return sameActor && elapsed >= 0 && elapsed <= doubleClickMs ? "defaultAction" : "target";
}

export function classifyPropClick(
  memory: PropClickMemory,
  propId: string,
  nowMs: number,
  doubleClickMs = TARGET_DOUBLE_CLICK_MS,
): PropClickIntent {
  const elapsed = nowMs - memory.lastAtMs;
  const sameProp = memory.lastPropId === propId;
  memory.lastPropId = propId;
  memory.lastAtMs = nowMs;
  return sameProp && elapsed >= 0 && elapsed <= doubleClickMs ? "defaultAction" : "examine";
}

export function resetActorClickMemory(memory: ActorClickMemory): void {
  memory.lastActorId = null;
  memory.lastAtMs = Number.NEGATIVE_INFINITY;
}

export function resetPropClickMemory(memory: PropClickMemory): void {
  memory.lastPropId = null;
  memory.lastAtMs = Number.NEGATIVE_INFINITY;
}

export function defaultActorAction(attackable: boolean): ActorDefaultAction {
  return attackable ? "attack" : "examine";
}

export function actorPointerGrammarDecision(params: {
  button: "left" | "right";
  actorHit: boolean;
  doubleClick: boolean;
  attackable: boolean;
}): ActorPointerGrammarDecision {
  if (!params.actorHit) return params.button === "left" ? "groundOnly" : "strafeGround";
  if (params.button === "right") return "openRadial";
  if (params.doubleClick) return params.attackable ? "defaultAttack" : "defaultExamine";
  return "targetOnly";
}

export function propPointerGrammarDecision(params: {
  button: "left" | "right";
  doubleClick: boolean;
}): PropPointerGrammarDecision {
  if (params.button === "right") return "propRadial";
  return params.doubleClick ? "propDefaultLoot" : "propExamine";
}
