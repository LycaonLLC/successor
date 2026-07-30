/**
 * VITALS — the field gauges (statusPlate parity: HEALTH oxide, ACTION olive,
 * SPIRIT brass), posture line, status chips, and the DOWN/RESPAWN stamp.
 * Reads the owning session's server actor only.
 */

import type { PlayState } from "@successor/client/src/slice-core/gameState";
import { STRINGS } from "../theme";
import type { Surface, Style } from "../term/surface";
import type { Palette, Rect } from "./styles";

export function renderVitals(surface: Surface, rect: Rect, state: PlayState, palette: Palette): void {
  if (rect.w < 14 || rect.h < 3) return;
  const meId = state.serverAuthority.playerActorId ?? state.playerActorId;
  const actor = state.serverAuthority.actors[meId];
  const labelW = 3;
  const valueW = 4;
  const gaugeW = Math.max(4, rect.w - labelW - valueW - 2);

  const gauges: Array<{ tag: string; value: number; max: number; fill: Style }> = [
    { tag: "HP", value: actor?.vitals.health ?? 0, max: actor?.maxVitals.health ?? 0, fill: palette.oxide },
    { tag: "AC", value: actor?.vitals.action ?? 0, max: actor?.maxVitals.action ?? 0, fill: palette.olive },
    { tag: "SP", value: actor?.vitals.spirit ?? 0, max: actor?.maxVitals.spirit ?? 0, fill: palette.brass },
  ];
  let y = rect.y;
  for (const gauge of gauges) {
    if (y >= rect.y + rect.h) break;
    const frac = gauge.max > 0 ? gauge.value / gauge.max : 0;
    const low = gauge.max > 0 && frac <= 0.25;
    surface.text(rect.x, y, gauge.tag, low ? palette.oxideBold : palette.dim);
    surface.gauge(rect.x + labelW, y, gaugeW, frac, low ? palette.oxideBold : gauge.fill, palette.gaugeTrack);
    const value = gauge.max > 0 ? String(Math.max(0, Math.round(gauge.value))) : "—";
    surface.text(rect.x + labelW + gaugeW + 1, y, value.padStart(valueW - 1), low ? palette.oxideBold : palette.ink);
    y += 1;
  }

  if (y < rect.y + rect.h) {
    const life = actor?.lifeState ?? "alive";
    if (life !== "alive") {
      const stamp = life === "respawning" ? STRINGS.respawnStamp : STRINGS.downStamp;
      surface.text(rect.x, y, `▌${stamp}▐`, palette.stampDown);
    } else {
      const posture = actor?.posture === "kneeling" || actor?.posture === "kneeling_down" ? "KNEELING" : "STANDING";
      const chips = (actor?.statuses ?? []).slice(0, 2).map((status) => status.label.toUpperCase()).join(" ");
      surface.text(rect.x, y, posture, palette.faint);
      if (chips) surface.text(rect.x + posture.length + 1, y, chips, palette.amber, rect.x + rect.w);
    }
  }
}
