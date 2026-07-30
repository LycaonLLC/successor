/**
 * Exchange + trade — ledger, handshake flows, and the spoken trade table.
 *
 * Item references resolve against the (server-scoped) inventory stream by
 * name or numeric id; trade offers/requests parse the `item×qty` grammar
 * and compose the ProposeTrade wire shape. The double-lock session VM
 * streams to BOTH participants (serverAuthority.tradeSession, TS ids per
 * DEF-3): bare /trade renders the table; the narrator diffs deliveries
 * and speaks ONLY the partner's moves + stage beats — your own moves are
 * echoed by the command line and stamped by receipts.
 */

import type {
  InventoryRow,
  PlayState,
  ServerAuthorityTradeItemLineState,
  ServerAuthorityTradeSessionState,
  ServerAuthorityTradeSideState,
  SliceSnapshot,
} from "@successor/client/src/slice-core/gameState";
import {
  authorityIssuedAtServerTick,
  enqueueAuthorityAcceptTradeCommand,
  enqueueAuthorityAddTradeItemCommand,
  enqueueAuthorityConfirmTradeCommand,
  enqueueAuthorityDeclineTradeCommand,
  enqueueAuthorityProposeTradeCommand,
  enqueueAuthorityRemoveTradeItemCommand,
  enqueueAuthorityRetrieveFromExchangeCommand,
  enqueueAuthoritySetTradeCoinCommand,
  enqueueAuthorityStoreToExchangeCommand,
  type ExchangeTradeItem,
} from "@successor/client/src/slice-core/authorityCommandSystem";

export const EXCHANGE_CONTAINER = "district-exchange";

/**
 * Carried-container flow gate (command-nameable stacks): the own-actor AND
 * own-identity container families — the rule the loot/battery/3D flows ride.
 * Rows are already server-scoped on the wire; this only splits carried from
 * exchange/corpse partitions. `extraIds` carries session identity ids
 * (playerId/characterId) the PlayState alone cannot know.
 */
export function isCarriedContainer(
  state: PlayState,
  container: string,
  extraIds: readonly (string | null | undefined)[] = [],
): boolean {
  const ids = [state.serverAuthority.playerActorId, state.playerActorId, ...extraIds];
  for (const id of ids) {
    if (!id) continue;
    if (container === id || container.startsWith(`${id}:`) || container.startsWith(`${id}/`)) return true;
  }
  return false;
}

export interface ResolvedStack {
  row: InventoryRow;
  label: string;
}

/**
 * Resolve an item token (name substring or numeric itemId) against rows
 * passing `filter`. Exact name match outranks substring; largest stack wins
 * ties. Returns null when nothing (or nothing available) matches.
 */
export function resolveItem(
  state: PlayState,
  token: string,
  filter: (row: InventoryRow) => boolean,
): ResolvedStack | null {
  const needle = token.trim().toLowerCase();
  if (!needle) return null;
  const numeric = Number(needle);
  let best: InventoryRow | null = null;
  let bestScore = -1;
  for (const row of state.inventory) {
    if (row.available <= 0 || !filter(row)) continue;
    const name = row.item.toLowerCase();
    let score = -1;
    if (Number.isInteger(numeric) && row.itemId === numeric) score = 3;
    else if (name === needle) score = 2;
    else if (name.includes(needle)) score = 1;
    if (score < 0) continue;
    if (score > bestScore || (score === bestScore && row.available > (best?.available ?? 0))) {
      best = row;
      bestScore = score;
    }
  }
  return best ? { row: best, label: best.item } : null;
}

/** Exchange ledger rows (the datapad partition). */
export function exchangeRows(state: PlayState): InventoryRow[] {
  return state.inventory.filter((row) => row.container === EXCHANGE_CONTAINER && row.available > 0);
}

export function enqueueStore(state: PlayState, slice: SliceSnapshot, row: InventoryRow, quantity: number): boolean {
  return enqueueAuthorityStoreToExchangeCommand(
    state.authorityCommands,
    row.itemId,
    row.variantId,
    quantity,
    authorityIssuedAtServerTick(state, slice.tickRateHz, slice.tick),
  ) !== null;
}

export function enqueueRetrieve(state: PlayState, slice: SliceSnapshot, row: InventoryRow, quantity: number): boolean {
  return enqueueAuthorityRetrieveFromExchangeCommand(
    state.authorityCommands,
    row.itemId,
    row.variantId,
    quantity,
    authorityIssuedAtServerTick(state, slice.tickRateHz, slice.tick),
  ) !== null;
}

// ── trade grammar ───────────────────────────────────────────────────────────

export interface TradeSideSpec {
  items: ExchangeTradeItem[];
  /** Human echo: "Stimpak A ×2 · iron ×5". */
  echo: string;
}

export interface ParsedTradeProposal {
  partnerToken: string;
  offer: TradeSideSpec;
  request: TradeSideSpec;
}

/**
 * `/trade propose <partner> give <item[×:]qty>… for <item[×:]qty>…`
 * Offer items resolve against CARRIED rows (they must exist to escrow);
 * request items resolve against the item CATALOG loosely — unknown names
 * fall back to numeric ids only (the partner's stock is not ours to see).
 */
export function parseTradeProposal(
  state: PlayState,
  args: readonly string[],
  isCarried: (container: string) => boolean,
): ParsedTradeProposal | { error: string } {
  const partnerToken = args[0]?.trim();
  if (!partnerToken) return { error: "Trade with whom? /trade propose <partner> give <item:qty…> for <item:qty…>" };
  const giveAt = args.findIndex((token) => token.toLowerCase() === "give");
  const forAt = args.findIndex((token) => token.toLowerCase() === "for");
  if (giveAt === -1 || forAt === -1 || forAt < giveAt) {
    return { error: "Shape it as: /trade propose <partner> give <item:qty…> for <item:qty…>" };
  }
  const offerTokens = args.slice(giveAt + 1, forAt);
  const requestTokens = args.slice(forAt + 1);
  if (offerTokens.length === 0 || requestTokens.length === 0) {
    return { error: "Both sides need items — give <item:qty…> for <item:qty…>" };
  }
  const offer = parseSide(state, offerTokens, (row) => isCarried(row.container));
  if ("error" in offer) return offer;
  const request = parseSide(state, requestTokens, () => true);
  if ("error" in request) return request;
  return { partnerToken, offer, request };
}

function parseSide(
  state: PlayState,
  tokens: readonly string[],
  filter: (row: InventoryRow) => boolean,
): TradeSideSpec | { error: string } {
  const items: ExchangeTradeItem[] = [];
  const echoes: string[] = [];
  for (const token of tokens) {
    const match = /^(.+?)(?:[:×x](\d+))?$/u.exec(token.trim());
    if (!match) return { error: `Cannot read «${token}» — use item:qty.` };
    const itemToken = match[1]!;
    const quantity = match[2] ? Math.max(1, Number(match[2])) : 1;
    const resolved = resolveItem(state, itemToken, filter);
    if (!resolved) return { error: `No stack answers to «${itemToken}».` };
    items.push({ item_id: resolved.row.itemId, variant_id: resolved.row.variantId, quantity });
    echoes.push(`${resolved.label} ×${quantity}`);
  }
  return { items, echo: echoes.join(" · ") };
}

export function enqueueProposal(
  state: PlayState,
  slice: SliceSnapshot,
  partnerActorId: string,
  proposal: ParsedTradeProposal,
): boolean {
  return enqueueAuthorityProposeTradeCommand(
    state.authorityCommands,
    partnerActorId,
    proposal.offer.items,
    proposal.request.items,
    authorityIssuedAtServerTick(state, slice.tickRateHz, slice.tick),
  ) !== null;
}

export function enqueueTradeAnswer(state: PlayState, slice: SliceSnapshot, accept: boolean, proposalId: number): boolean {
  const tick = authorityIssuedAtServerTick(state, slice.tickRateHz, slice.tick);
  return accept
    ? enqueueAuthorityAcceptTradeCommand(state.authorityCommands, proposalId, tick) !== null
    : enqueueAuthorityDeclineTradeCommand(state.authorityCommands, proposalId, tick) !== null;
}

// ── double-lock session moves (car-5, tags 63-66) ───────────────────────────
// Any offer change clears BOTH accept-locks; dual-lock then dual-confirm
// executes the atomic swap. Copy at the callsite speaks that truth.

/**
 * Parse ONE `item[:×x]qty` token for /trade add|remove. Add resolves
 * against CARRIED rows (the offer escrows our own stacks); remove names an
 * item already on the table — same carried resolution, since nothing is
 * consumed pre-execute and the stack stays in our inventory.
 */
export function parseTradeLineItem(
  state: PlayState,
  tokens: readonly string[],
  isCarried: (container: string) => boolean,
): { item: ExchangeTradeItem; echo: string } | { error: string } {
  const side = parseSide(state, tokens, (row) => isCarried(row.container));
  if ("error" in side) return side;
  if (side.items.length !== 1) return { error: "One item per move — /trade add|remove <id> <item:qty>." };
  return { item: side.items[0]!, echo: side.echo };
}

export function enqueueTradeItemChange(
  state: PlayState,
  slice: SliceSnapshot,
  add: boolean,
  proposalId: number,
  item: ExchangeTradeItem,
): boolean {
  const tick = authorityIssuedAtServerTick(state, slice.tickRateHz, slice.tick);
  return add
    ? enqueueAuthorityAddTradeItemCommand(state.authorityCommands, proposalId, item, tick) !== null
    : enqueueAuthorityRemoveTradeItemCommand(state.authorityCommands, proposalId, item, tick) !== null;
}

export function enqueueTradeCoin(state: PlayState, slice: SliceSnapshot, proposalId: number, amount: number): boolean {
  return enqueueAuthoritySetTradeCoinCommand(
    state.authorityCommands,
    proposalId,
    amount,
    authorityIssuedAtServerTick(state, slice.tickRateHz, slice.tick),
  ) !== null;
}

export function enqueueTradeConfirm(state: PlayState, slice: SliceSnapshot, proposalId: number): boolean {
  return enqueueAuthorityConfirmTradeCommand(
    state.authorityCommands,
    proposalId,
    authorityIssuedAtServerTick(state, slice.tickRateHz, slice.tick),
  ) !== null;
}

// ── the spoken trade table ──────────────────────────────────────────────────

export type TradeSessionSource = () => ServerAuthorityTradeSessionState | null;

export interface TradeLine {
  register: "world" | "system" | "receipt" | "help";
  text: string;
}

function sideEcho(side: ServerAuthorityTradeSideState): string {
  const parts = side.items.map((item) => `${item.name} ×${item.quantity}`);
  if (side.coin > 0) parts.push(`${side.coin} credits`);
  return parts.length > 0 ? parts.join(" · ") : "nothing yet";
}

function sideState(side: ServerAuthorityTradeSideState): string {
  if (side.confirmed) return "HAND DOWN";
  if (side.locked) return "LOCKED";
  return "open";
}

/** Bare /trade — the live table, both sides, states, and the moves left. */
export function renderTradeTable(vm: ServerAuthorityTradeSessionState, partnerName: string): TradeLine[] {
  const stage = vm.stage === "negotiating" && vm.bothLocked ? "BOTH LOCKED" : vm.stage.toUpperCase();
  const lines: TradeLine[] = [
    { register: "help", text: `TRADE — offer ${vm.proposalId} with «${partnerName}» · ${stage}` },
    { register: "system", text: `  yours  — ${sideEcho(vm.mine)}   [${sideState(vm.mine)}]` },
    { register: "system", text: `  theirs — ${sideEcho(vm.theirs)}   [${sideState(vm.theirs)}]` },
  ];
  if (vm.stage === "executed") {
    lines.push({ register: "world", text: "Done and dusted — the goods have changed hands." });
  } else if (vm.stage === "declined") {
    lines.push({ register: "system", text: "The table is closed." });
  } else {
    lines.push({
      register: "help",
      text: `  /trade add|remove ${vm.proposalId} <item:qty> · credits ${vm.proposalId} <n> · accept ${vm.proposalId} · confirm ${vm.proposalId} · decline ${vm.proposalId}`,
    });
  }
  return lines;
}

function itemChanges(prev: readonly ServerAuthorityTradeItemLineState[], next: readonly ServerAuthorityTradeItemLineState[]): string[] {
  const key = (line: ServerAuthorityTradeItemLineState): string => `${line.itemId}:${line.variantId}`;
  const before = new Map(prev.map((line) => [key(line), line]));
  const moves: string[] = [];
  for (const line of next) {
    const old = before.get(key(line));
    before.delete(key(line));
    if (!old) moves.push(`sets ${line.name} ×${line.quantity} on the table`);
    else if (line.quantity > old.quantity) moves.push(`adds ${line.name} — ×${old.quantity} becomes ×${line.quantity}`);
    else if (line.quantity < old.quantity) moves.push(`takes ${line.name} back to ×${line.quantity}`);
  }
  for (const old of before.values()) moves.push(`takes ${old.name} back off the table`);
  return moves;
}

/**
 * Pure delivery diff — the partner's moves and the table's stage beats.
 * Your own moves are deliberately silent here (echo + receipts speak them);
 * the exception is their move popping the locks, which rides their line.
 */
export function tradeDeltaLines(
  prev: ServerAuthorityTradeSessionState | null,
  next: ServerAuthorityTradeSessionState | null,
  partnerName: string,
): TradeLine[] {
  if (!next) {
    if (prev && prev.stage !== "executed" && prev.stage !== "declined") {
      return [{ register: "system", text: "The trade table is gone." }];
    }
    return [];
  }
  if (!prev || prev.proposalId !== next.proposalId) {
    const lines: TradeLine[] = [
      { register: "world", text: `«${partnerName}» is at the table — offer ${next.proposalId}: yours ${sideEcho(next.mine)} · theirs ${sideEcho(next.theirs)}.` },
      { register: "help", text: `  /trade accept ${next.proposalId} locks your side · confirm seals · add/remove/credits reshape the table · decline walks.` },
    ];
    return lines;
  }
  const lines: TradeLine[] = [];
  const moves = itemChanges(prev.theirs.items, next.theirs.items);
  if (next.theirs.coin > prev.theirs.coin) moves.push(`puts ${next.theirs.coin} credits on the table`);
  else if (next.theirs.coin < prev.theirs.coin) moves.push(next.theirs.coin === 0 ? "clears their credits" : `pulls credits back to ${next.theirs.coin}`);
  if (moves.length > 0) {
    const popped = (prev.mine.locked || prev.theirs.locked) && !next.mine.locked && !next.theirs.locked;
    lines.push({ register: "world", text: `«${partnerName}» ${moves.join("; ")}${popped ? " — the locks come off" : ""}.` });
  }
  if (!prev.theirs.locked && next.theirs.locked) {
    lines.push({ register: "world", text: `«${partnerName}» locks their side.` });
    if (next.bothLocked) lines.push({ register: "help", text: `  Both sides stand locked — /trade confirm ${next.proposalId} seals it.` });
  }
  if (!prev.theirs.confirmed && next.theirs.confirmed && next.stage !== "executed") {
    lines.push({ register: "world", text: `«${partnerName}»'s hand comes down.` });
  }
  if (prev.stage !== "executed" && next.stage === "executed") {
    lines.push({ register: "world", text: "Hands shake — the trade is done." });
  }
  if (prev.stage !== "declined" && next.stage === "declined") {
    const reason = next.closeReason;
    const text = reason === "range" ? "The table breaks — too far apart."
      : reason === "death" ? "The table collapses — someone is down."
      : reason === "link" ? "The table breaks — link lost."
      : `«${partnerName}» closes the table.`;
    lines.push({ register: "system", text });
  }
  return lines;
}

export interface TradeNarrator {
  /** Speak the latest delivery: diff against the cached VM, advance the cache. */
  render(): TradeLine[];
}

function cloneTradeVm(vm: ServerAuthorityTradeSessionState): ServerAuthorityTradeSessionState {
  return {
    ...vm,
    mine: { ...vm.mine, items: vm.mine.items.map((line) => ({ ...line })) },
    theirs: { ...vm.theirs, items: vm.theirs.items.map((line) => ({ ...line })) },
  };
}

export function createTradeNarrator(source: TradeSessionSource, partnerName: (actorId: string) => string): TradeNarrator {
  let prev: ServerAuthorityTradeSessionState | null = null;
  return {
    render() {
      const next = source();
      const lines = tradeDeltaLines(prev, next, next ? partnerName(next.partnerActorId) : prev ? partnerName(prev.partnerActorId) : "your partner");
      prev = next ? cloneTradeVm(next) : null;
      return lines;
    },
  };
}
