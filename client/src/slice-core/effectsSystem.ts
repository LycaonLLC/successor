import type { BodyZone } from "./combatTypes";
import type { Cell } from "./geometry";

const maxFloatingCombatTexts = 128;

export interface FloatingCombatText {
  id: number;
  actorId?: string;
  x: number;
  y: number;
  driftX: number;
  value: number | null;
  label: string | null;
  ttlMs: number;
  totalTtlMs: number;
  color: string;
  scale: number;
}

export interface VisualEffectState {
  floatingTexts: FloatingCombatText[];
  nextFloatingTextId: number;
}

export function tickVisualEffects(state: VisualEffectState, dtMs: number) {
  let writeIndex = 0;
  for (let readIndex = 0; readIndex < state.floatingTexts.length; readIndex += 1) {
    const text = state.floatingTexts[readIndex]!;
    text.ttlMs = Math.max(0, text.ttlMs - dtMs);
    if (text.ttlMs <= 0) continue;
    state.floatingTexts[writeIndex] = text;
    writeIndex += 1;
  }
  state.floatingTexts.length = writeIndex;
}

export function spawnStimpakEffect(state: VisualEffectState, actorPos: Cell, actorId?: string): void {
  spawnFloatingStatusText(state, actorPos, "STIMPAK", "#ff4c66", actorId);
}

export function spawnBandageEffect(state: VisualEffectState, actorPos: Cell, actorId?: string): void {
  spawnFloatingStatusText(state, actorPos, "BANDAGE", "#fff0ca", actorId);
}

export function spawnPersonalShieldBlockEffect(
  state: VisualEffectState,
  actorPos: Cell,
  actorId?: string,
): void {
  spawnFloatingStatusText(state, actorPos, "PSG", "#9dfcff", actorId);
}

export function spawnInventoryTransferEffect(
  state: VisualEffectState,
  actorPos: Cell,
  options: { actorId?: string; label?: string; color?: string } = {},
): void {
  spawnFloatingStatusText(
    state,
    actorPos,
    options.label ?? "+AMMO",
    options.color ?? "#ffd36b",
    options.actorId,
  );
}

export function spawnResourceSampleEffect(
  state: VisualEffectState,
  actorPos: Cell,
  actorId?: string,
  label = "+RES",
  color = "#72f4a1",
): void {
  spawnFloatingStatusText(state, actorPos, label, color, actorId);
}

export function spawnFloatingDamage(
  state: VisualEffectState,
  actorPos: Cell,
  damage: number,
  zone: BodyZone,
  downed: boolean,
  actorId?: string,
) {
  const id = state.nextFloatingTextId;
  const ttlMs = downed ? 1050 : 780;
  const driftX = floatingDamageDriftX(id);
  const verticalStack = floatingDamageVerticalStack(id);
  state.floatingTexts.push({
    id,
    actorId,
    x: actorPos.x + 0.5,
    y: actorPos.y - 1.55 - verticalStack,
    driftX,
    value: damage,
    label: downed ? "DOWN" : zone === "head" ? "HEAD" : null,
    ttlMs,
    totalTtlMs: ttlMs,
    color: downed ? "#ffffff" : zone === "head" ? "#ffe66d" : "#ff4747",
    scale: downed ? 1.22 : zone === "head" ? 1.12 : 1,
  });
  state.nextFloatingTextId += 1;
  trimFloatingCombatTexts(state);
}

export function hasActorFloatingFeedback(
  state: Pick<VisualEffectState, "floatingTexts">,
  actorId: string | undefined,
  label: string,
): boolean {
  if (!actorId) return false;
  for (let index = 0; index < state.floatingTexts.length; index += 1) {
    const text = state.floatingTexts[index]!;
    if (text.actorId === actorId && text.label === label && text.ttlMs > 0) return true;
  }
  return false;
}

export function spawnFloatingStatusText(
  state: VisualEffectState,
  actorPos: Cell,
  label: string,
  color = "#8af5d1",
  actorId?: string,
): void {
  // Suppress identical live status shouts on the same actor (MISS/DODGE/PSG
  // spam during burst fire). Damage numbers stay uncapped here — cadence
  // lives in gameAuthoritySystem.
  if (actorId && hasActorFloatingFeedback(state, actorId, label)) return;
  const id = state.nextFloatingTextId;
  const ttlMs = 900;
  state.floatingTexts.push({
    id,
    actorId,
    x: actorPos.x + 0.5,
    y: actorPos.y - 1.72,
    driftX: ((id % 5) - 2) * 0.045,
    value: null,
    label,
    ttlMs,
    totalTtlMs: ttlMs,
    color,
    scale: 1.02,
  });
  state.nextFloatingTextId += 1;
  trimFloatingCombatTexts(state);
}

export function spawnFloatingExperience(
  state: VisualEffectState,
  actorPos: Cell,
  amount: number,
  xpType: string,
  color = "#7ef7ff",
  actorId?: string,
): void {
  const id = state.nextFloatingTextId;
  const ttlMs = 960;
  const safeAmount = Math.max(0, Math.trunc(Number.isFinite(amount) ? amount : 0));
  const compactType = xpType.trim().toUpperCase().replace(/[^A-Z0-9 -]/g, "").slice(0, 18);
  state.floatingTexts.push({
    id,
    actorId,
    x: actorPos.x + 0.5,
    y: actorPos.y - 1.96 - floatingDamageVerticalStack(id),
    driftX: floatingDamageDriftX(id) * 0.72,
    value: null,
    label: `+${safeAmount} ${compactType || "XP"}`,
    ttlMs,
    totalTtlMs: ttlMs,
    color,
    scale: 0.96,
  });
  state.nextFloatingTextId += 1;
  trimFloatingCombatTexts(state);
}

function floatingDamageDriftX(id: number): number {
  return (((id % 11) - 5) * 0.055) + (((Math.floor(id / 11) % 2) * 2 - 1) * 0.018);
}

function floatingDamageVerticalStack(id: number): number {
  return (Math.floor(id / 11) % 4) * 0.07;
}

function trimFloatingCombatTexts(state: VisualEffectState): void {
  if (state.floatingTexts.length > maxFloatingCombatTexts) {
    state.floatingTexts.splice(0, state.floatingTexts.length - maxFloatingCombatTexts);
  }
}
