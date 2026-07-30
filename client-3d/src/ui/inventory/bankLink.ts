import type { PlayState, SliceSnapshot } from "@successor/client/src/slice-core/gameState";

/**
 * Bank vault link + drag contract — shared between the BANK window (vault
 * grid) and the inventory window (deposit gestures). Lives outside both
 * modules so neither imports the other (lootDrag precedent: the shell exports
 * grid vocabulary the bank window reuses, so the shell must never import the
 * bank window back).
 *
 * Session truth: the bound terminal id. Boot sets it when a terminal opens
 * the BANK window and clears it when the window closes, so a non-null id IS
 * the "bank session live" signal both surfaces key off. Reach is re-derived
 * from authority positions every gesture — walking away kills transfers on
 * the next frame, no cached permission survives.
 */

/** Shared sim-side interaction reach (HARVEST_INTERACTION_RADIUS). */
const BANK_REACH_CELLS = 1.75;

/** One deny voice for every transfer surface once the player steps away. */
export const BANK_LINK_LOST_COPY = "LINK LOST · RETURN TO TERMINAL";

let activeBankTerminalId: string | null = null;

export function setActiveBankTerminal(propId: string | null): void {
  activeBankTerminalId = propId;
}

export function activeBankTerminal(): string | null {
  return activeBankTerminalId;
}

/** Player-to-prop-center distance in authority cells, or null off-area. */
function bankTerminalDistance(state: PlayState, slice: SliceSnapshot, propId: string): number | null {
  const actorId = state.serverAuthority.playerActorId ?? state.playerActorId;
  const me = state.serverAuthority.actors[actorId];
  const areaId = me?.areaId ?? state.activeAreaId;
  const x = me?.x ?? state.player.x;
  const y = me?.y ?? state.player.y;
  const prop = slice.props.find((candidate) => candidate.id === propId && candidate.areaId === areaId);
  if (!prop) return null;
  return Math.hypot(x + 0.5 - (prop.cell.x + prop.size.w / 2), y + 0.5 - (prop.cell.y + prop.size.h / 2));
}

export function withinBankTerminalRange(state: PlayState, slice: SliceSnapshot, propId: string): boolean {
  const distance = bankTerminalDistance(state, slice, propId);
  return distance !== null && distance <= BANK_REACH_CELLS;
}

/** Nearest in-reach bank terminal (dock/`/ui` open adopts the one beside you). */
export function nearestBankTerminalInRange(state: PlayState, slice: SliceSnapshot): string | null {
  let best: string | null = null;
  let bestDistance = Infinity;
  for (const prop of slice.props) {
    if (prop.kind !== "bank_terminal") continue;
    const distance = bankTerminalDistance(state, slice, prop.id);
    if (distance !== null && distance <= BANK_REACH_CELLS && distance < bestDistance) {
      best = prop.id;
      bestDistance = distance;
    }
  }
  return best;
}

export interface BankVaultSession {
  /** A terminal is bound — the BANK window session is live (boot clears on close). */
  open: boolean;
  /** The bound/adopted terminal is currently within interaction reach. */
  inReach: boolean;
  /** Owner bank projection streamed — vault truth is on screen. */
  live: boolean;
}

/**
 * Adopt-nearest + reach resolution shared by the BANK window and the
 * inventory shell's deposit gestures. Re-binds the session to a terminal
 * beside the player when the bound one fell out of reach (travel auto-adopt
 * pattern); never invents a session from nothing — only the BANK window's
 * own update adopts from a null binding, because only it knows it is open.
 */
export function resolveBankVaultSession(state: PlayState, slice: SliceSnapshot): BankVaultSession {
  let terminalId = activeBankTerminalId;
  if (terminalId !== null && !withinBankTerminalRange(state, slice, terminalId)) {
    const nearby = nearestBankTerminalInRange(state, slice);
    if (nearby) {
      activeBankTerminalId = nearby;
      terminalId = nearby;
    }
  }
  const open = terminalId !== null;
  return {
    open,
    inReach: open && withinBankTerminalRange(state, slice, terminalId!),
    live: state.serverAuthority.bank !== null,
  };
}

/**
 * Vault → inventory drag payload. Deliberately NOT the inventory/toolbar
 * item type and NOT the loot type: only the inventory window's drop intake
 * understands it, and dropping it enqueues the authoritative
 * `BankRetrieveItem` — the toolbar, stackOps merge, and loot intake never
 * see vault tiles.
 */
export const BANK_DRAG_MIME = "text/x-sc3d-vault-stack";

export interface BankDragPayload {
  /** Wire bank stack id (u64 decimal string, passed through untouched). */
  stackId: string;
  quantity: number;
  label: string;
}

export function parseBankDragPayload(raw: string): BankDragPayload | null {
  try {
    const parsed = JSON.parse(raw) as Partial<BankDragPayload>;
    if (
      typeof parsed.stackId !== "string" || parsed.stackId.length === 0
      || typeof parsed.quantity !== "number" || !Number.isInteger(parsed.quantity) || parsed.quantity <= 0
    ) {
      return null;
    }
    return {
      stackId: parsed.stackId,
      quantity: parsed.quantity,
      label: typeof parsed.label === "string" ? parsed.label : "",
    };
  } catch {
    return null;
  }
}
