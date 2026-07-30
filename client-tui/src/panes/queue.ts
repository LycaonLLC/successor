/**
 * QUEUE — the ability queue, beat-accurate.
 *
 * Structure from the view snapshot; the FIRED flash and dismissal stamps
 * key off drained lifecycle EVENTS (spec §F one-tick transients — the same
 * rule the 3D combat queue lives by). Repeat intent pins to the top with
 * its ×fireSeq counter and pulses on every fire.
 */

import type { AbilityQueueEvent, PlayState } from "@successor/client/src/slice-core/gameState";
import { abilityLabel, reasonCopy } from "../language/copy";
import type { Surface } from "../term/surface";
import type { Palette, Rect } from "./styles";

const FIRE_FLASH_MS = 320;
const REJECT_HOLD_MS = 1_100;

export interface QueuePaneState {
  flashes: Map<string, number>;
  rejects: Map<string, { reason: string; untilMs: number }>;
  lastSeq: number;
}

export function createQueuePaneState(): QueuePaneState {
  return { flashes: new Map(), rejects: new Map(), lastSeq: 0 };
}

export function ingestQueueEvents(pane: QueuePaneState, events: readonly AbilityQueueEvent[], now = Date.now()): void {
  for (const event of events) {
    if (event.lifecycle === "fired") pane.flashes.set(event.id, now + FIRE_FLASH_MS);
    if (event.lifecycle === "dismissed" && event.reasonCode) {
      pane.rejects.set(event.id, { reason: event.reasonCode, untilMs: now + REJECT_HOLD_MS });
    }
  }
}

export function renderQueue(
  surface: Surface,
  rect: Rect,
  state: PlayState,
  pane: QueuePaneState,
  palette: Palette,
  now = Date.now(),
): void {
  if (rect.w < 12 || rect.h < 1) return;
  const view = state.abilityQueue.view;
  let y = rect.y;

  const rows: Array<{ id: string; label: string; lifecycle: string; fireSeq?: number; repeat: boolean; reason?: string }> = [];
  if (view?.repeatIntent) {
    rows.push({
      id: view.repeatIntent.id,
      label: abilityLabel(view.repeatIntent.abilityId),
      lifecycle: view.repeatIntent.lifecycle,
      fireSeq: view.repeatIntent.fireSeq,
      repeat: true,
    });
  }
  for (const entry of view?.entries ?? []) {
    if (entry.lifecycle === "dismissed" && !pane.rejects.has(entry.id)) continue;
    rows.push({
      id: entry.id,
      label: abilityLabel(entry.abilityId),
      lifecycle: entry.lifecycle,
      fireSeq: entry.fireSeq,
      repeat: false,
      reason: entry.reasonCode,
    });
  }
  // expired holds
  for (const [id, hold] of pane.rejects) {
    if (hold.untilMs <= now) pane.rejects.delete(id);
  }
  for (const [id, until] of pane.flashes) {
    if (until <= now) pane.flashes.delete(id);
  }

  if (rows.length === 0) {
    surface.text(rect.x, y, "queue idle", palette.faint);
    return;
  }
  for (const row of rows) {
    if (y >= rect.y + rect.h) break;
    const firing = (pane.flashes.get(row.id) ?? 0) > now;
    const reject = pane.rejects.get(row.id);
    const glyph = row.repeat ? "⟳" : firing ? "▶" : row.lifecycle === "pending" ? "·" : "▸";
    const glyphStyle = firing ? palette.greenBold : row.repeat ? palette.accent : palette.dim;
    surface.text(rect.x, y, glyph, glyphStyle);
    const nameStyle = firing ? palette.greenBold : reject ? palette.oxide : palette.ink;
    let x = surface.text(rect.x + 2, y, row.label, nameStyle, rect.x + rect.w);
    if (row.repeat && row.fireSeq !== undefined && row.fireSeq > 0) {
      x = surface.text(x + 1, y, `×${row.fireSeq}`, palette.green, rect.x + rect.w);
    }
    if (reject) {
      surface.text(x + 1, y, reasonCopy(reject.reason), palette.oxideBold, rect.x + rect.w);
    } else if (firing) {
      surface.text(x + 1, y, "FIRED", palette.greenBold, rect.x + rect.w);
    }
    y += 1;
  }
}
