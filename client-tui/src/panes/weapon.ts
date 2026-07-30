/**
 * WEAPON — stenciled designation, ammo pips with the reload refill sweep
 * (timed by the authority's reload tick countdown), reserve count, and the
 * melee swing-timer sweep off the ability queue's nextReadyTick — the
 * statusPlate contract, cell for cell.
 */

import type { PlayState, SliceSnapshot } from "@successor/client/src/slice-core/gameState";
import { activeWeaponSpec } from "@successor/client/src/slice-core/loadoutSystem";
import { authorityIssuedAtServerTick } from "@successor/client/src/slice-core/authorityCommandSystem";
import { STRINGS, weaponDisplayName } from "../theme";
import type { Surface } from "../term/surface";
import type { Palette, Rect } from "./styles";

function decodeSlugthrowerStats(variantId: number): { power: number; handling: number; reliability: number } | null {
  if (variantId < 31_000_000) return null;
  const encoded = variantId - 31_000_000;
  return {
    power: Math.min(100, Math.floor(encoded / 1_000_000)),
    handling: Math.min(100, Math.floor(encoded / 1_000) % 1_000),
    reliability: Math.min(100, encoded % 1_000),
  };
}

const MAX_PIPS = 30;

export interface WeaponPaneState {
  swingStartTick: number;
  swingEndTick: number;
}

export function createWeaponPaneState(): WeaponPaneState {
  return { swingStartTick: 0, swingEndTick: 0 };
}

export function renderWeapon(
  surface: Surface,
  rect: Rect,
  state: PlayState,
  slice: SliceSnapshot,
  pane: WeaponPaneState,
  palette: Palette,
): void {
  const meId = state.serverAuthority.playerActorId ?? state.playerActorId;
  const actor = state.serverAuthority.actors[meId];
  const weapon = actor?.weapon ?? null;
  if (!weapon) {
    surface.text(rect.x, rect.y, "UNARMED", palette.faint);
    return;
  }
  const spec = activeWeaponSpec(state);
  const isMelee = spec?.caliber === "melee";
  const variantId = weapon.weaponVariantId ?? 0;
  const slugStats = weapon.weaponId === "slugthrower" ? decodeSlugthrowerStats(variantId) : null;
  const detail = slugStats
    ? ` v${variantId} P${slugStats.power}/H${slugStats.handling}/R${slugStats.reliability}`
    : ` v${variantId}`;
  surface.text(rect.x, rect.y, `${weaponDisplayName(weapon.weaponId)}${detail}`, palette.inkBold, rect.x + rect.w);

  if (rect.h < 2) return;
  const y = rect.y + 1;

  if (isMelee) {
    // Swing sweep: estimated tick vs queue nextReadyTick (owner ruling 2026-07-08).
    const estimated = authorityIssuedAtServerTick(state, slice.tickRateHz, slice.tick);
    const nextReady = state.abilityQueue.view?.nextReadyTick ?? 0;
    if (nextReady !== pane.swingEndTick) {
      pane.swingStartTick = estimated;
      pane.swingEndTick = nextReady;
    }
    const ready = estimated >= pane.swingEndTick;
    const frac = ready || pane.swingEndTick <= pane.swingStartTick
      ? 1
      : Math.max(0, Math.min(1, (estimated - pane.swingStartTick) / (pane.swingEndTick - pane.swingStartTick)));
    const label = ready ? STRINGS.swingReady : STRINGS.swing;
    const gaugeW = Math.max(4, rect.w - label.length - 1);
    surface.gauge(rect.x, y, gaugeW, frac, ready ? palette.green : palette.brass, palette.gaugeTrack);
    surface.text(rect.x + gaugeW + 1, y, label, ready ? palette.green : palette.dim);
    return;
  }

  // Magazine pips + reserve. Reload sweeps the pips back in on the
  // authority's countdown; the lead pip brightens.
  const magazine = Math.min(weapon.magazineSize, MAX_PIPS);
  const reloading = weapon.reloadRemainingTicks > 0 && weapon.reloadTotalTicks > 0;
  const filled = reloading
    ? Math.floor((1 - weapon.reloadRemainingTicks / weapon.reloadTotalTicks) * magazine)
    : Math.min(weapon.loadedRounds, magazine);
  const pipsW = Math.min(magazine, rect.w);
  for (let i = 0; i < pipsW; i += 1) {
    const on = i < filled;
    const lead = reloading && i === filled - 1;
    surface.set(rect.x + i, y, on ? "▮" : "▯", lead ? palette.brassBold : on ? palette.brass : palette.faint);
  }
  if (rect.h < 3) return;
  const reserve = spec ? state.loadout.ammo[spec.caliber]?.reserve ?? 0 : 0;
  const rounds = reloading
    ? STRINGS.rearming
    : state.loadout.unlimitedAmmo
      ? `${weapon.loadedRounds}/${weapon.magazineSize} ∞`
      : `${weapon.loadedRounds}/${weapon.magazineSize} · ${reserve}`;
  surface.text(rect.x, rect.y + 2, rounds, reloading ? palette.amber : palette.dim, rect.x + rect.w);
}
