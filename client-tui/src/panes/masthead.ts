/**
 * MASTHEAD — one row: identity left, world truth right.
 * `SUCCESSOR · OPEN DESERT` … `☀ DAY 13:42 · Third Cycle 12 · E 3 N -12 · ok`
 */

import { currentArea } from "@successor/client/src/slice-core/worldQueries";
import { formatWorldClock, projectedWorldClockState } from "@successor/client/src/slice-core/worldClockSystem";
import type { PlayState, SliceSnapshot } from "@successor/client/src/slice-core/gameState";
import { gridRef } from "../game/bearing";
import { STRINGS } from "../theme";
import { stringWidth } from "../term/surface";
import type { Surface } from "../term/surface";
import type { Palette, Rect } from "./styles";

const PHASE_GLYPH: Record<string, string> = {
  deep_night: "☾",
  night: "☾",
  dawn: "☼",
  day: "☀",
  dusk: "☼",
};

export function renderMasthead(surface: Surface, rect: Rect, state: PlayState, slice: SliceSnapshot, palette: Palette): void {
  surface.hline(rect.x, rect.y, rect.w, palette.frame, " ");
  const area = currentArea(slice, state);
  let x = surface.text(rect.x + 1, rect.y, STRINGS.masthead, palette.inkBold, rect.x + rect.w);
  x = surface.text(x, rect.y, " · ", palette.faint, rect.x + rect.w);
  x = surface.text(x, rect.y, area.name.toUpperCase(), palette.dim, rect.x + rect.w);

  const clock = projectedWorldClockState(state.worldClock, state.worldTimeMs);
  const month = state.worldClock.config.calendar.months[clock.monthIndex]?.label ?? "";
  const me = state.serverAuthority.actors[state.serverAuthority.playerActorId ?? state.playerActorId];
  const px = me?.x ?? state.player.x;
  const py = me?.y ?? state.player.y;
  const conn = state.serverAuthority.connected ? "ok" : state.serverAuthority.status.toUpperCase();
  const right = `${PHASE_GLYPH[clock.phase] ?? ""} ${clock.phaseLabel.toUpperCase()} ${formatWorldClock(clock)} · ${month} ${clock.dayOfMonth} · ${gridRef(px, py, slice.zone.width, slice.zone.height)} · ${conn} ${state.serverAuthority.snapshotTick}`;
  const rightX = rect.x + rect.w - stringWidth(right) - 1;
  if (rightX > x + 2) {
    surface.text(rightX, rect.y, right, state.serverAuthority.connected ? palette.dim : palette.oxideBold, rect.x + rect.w);
  }
}
