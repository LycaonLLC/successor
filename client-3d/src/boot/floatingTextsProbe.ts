import type { FloatingCombatText } from "@successor/client/src/slice-core/effectsSystem";

/** Live floating combat text / status label evidence on window.__successor3d. */
export interface FloatingTextProbeEntry {
  id: number;
  label: string;
  actorId: string | null;
  ttlMs: number;
  color: string;
}

/**
 * Project live visual effect floating texts onto caller-owned probe storage.
 * Reads straight from state.floatingTexts without mutating gameplay state.
 */
export function projectFloatingTextsProbe(texts: readonly FloatingCombatText[]): FloatingTextProbeEntry[] {
  return texts.map((text) => ({
    id: text.id,
    label: text.label ?? (text.value !== null && text.value !== undefined ? String(text.value) : ""),
    actorId: text.actorId ?? null,
    ttlMs: text.ttlMs,
    color: text.color,
  }));
}
