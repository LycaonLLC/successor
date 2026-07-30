/**
 * Credit Chip redemption — the TUI face of RedeemCreditChip.
 *
 * A chip is a physical stack in the player's own pack whose quantity is its
 * face value. `/redeem` banks the largest carried chip into the credit balance
 * (the whole stack — owner ruling: "chip consumed"); repeat to bank the rest.
 * Loot containers (corpse:/cache:) and the shared exchange are excluded — you
 * take a chip first, then redeem it, exactly like the authority gate.
 */
import type { InventoryRow, PlayState, SliceSnapshot } from "@successor/client/src/slice-core/gameState";
import {
  authorityIssuedAtServerTick,
  enqueueAuthorityRedeemCreditChipCommand,
} from "@successor/client/src/slice-core/authorityCommandSystem";

/** Credit Chip item id — mirrors CREDIT_CHIP_ITEM_ID in successor-sim authority.rs. */
export const CREDIT_CHIP_ITEM_ID = 9002;

function isOwnPackContainer(container: string): boolean {
  return !container.startsWith("corpse:")
    && !container.startsWith("cache:")
    && container !== "district-exchange";
}

/** Carried credit-chip stacks (own pack, unreserved), richest first. */
export function redeemableChips(state: PlayState): InventoryRow[] {
  return state.inventory
    .filter((row) => row.itemId === CREDIT_CHIP_ITEM_ID
      && row.stackId !== undefined
      && Number(row.available ?? 0) > 0
      && isOwnPackContainer(row.container))
    .sort((left, right) => right.available - left.available);
}

export interface RedeemResult {
  redeemed: boolean;
  value: number;
  remainingChips: number;
  remainingValue: number;
  reason: "no_chip" | null;
}

/** Redeem the richest carried chip; returns its face value + what remains. */
export function redeemLargestChip(state: PlayState, slice: SliceSnapshot): RedeemResult {
  const chips = redeemableChips(state);
  const chip = chips[0];
  if (!chip || chip.stackId === undefined) {
    return { redeemed: false, value: 0, remainingChips: 0, remainingValue: 0, reason: "no_chip" };
  }
  const value = Math.max(0, Math.trunc(Number(chip.available ?? 0)));
  const envelope = enqueueAuthorityRedeemCreditChipCommand(
    state.authorityCommands,
    chip.container,
    String(chip.stackId),
    authorityIssuedAtServerTick(state, slice.tickRateHz, slice.tick),
  );
  if (!envelope) {
    return { redeemed: false, value: 0, remainingChips: chips.length, remainingValue: 0, reason: "no_chip" };
  }
  const rest = chips.slice(1);
  return {
    redeemed: true,
    value,
    remainingChips: rest.length,
    remainingValue: rest.reduce((sum, row) => sum + Math.max(0, Math.trunc(Number(row.available ?? 0))), 0),
    reason: null,
  };
}
