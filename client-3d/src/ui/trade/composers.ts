import { TRADE_COPY, tradeCloseLine } from "./copy";
import { isTerminalTradeStage } from "./machine";
import type { TradeItemLineVM, TradeSelection, TradeSessionVM, TradeSideId } from "./types";

/**
 * TRADE composers — pure session-VM → render-model functions. Everything the
 * window paints is decided here (testable, no DOM); the window's renderers
 * only reconcile these models into elements. Server truth in, pixels out:
 * the composer invents no state the sim didn't stream.
 */

/** Minimum visible grid per column (2 rows of 3 — compact table). */
export const TRADE_GRID_COLUMNS = 3;
export const TRADE_GRID_MIN_ROWS = 2;

export interface TradeCellModel {
  /** Render + selection key — also the 3D turntable rect key. */
  key: string;
  side: TradeSideId;
  itemId: number;
  variantId: number;
  name: string;
  quantity: number;
  /** Stack badge ("×4") — null hides the badge. */
  countText: string | null;
  selected: boolean;
  /** My cells stay withdrawable until the session closes. */
  removable: boolean;
}

export interface TradeColumnModel {
  side: TradeSideId;
  title: string;
  cells: TradeCellModel[];
  /** Trailing empty cells to square the grid (min 2×3). */
  emptyCount: number;
  coinValue: number;
  coinText: string;
  coinEditable: boolean;
  /** Wallet-balance hint under MY coin field; null on theirs. */
  heldLine: string | null;
  locked: boolean;
  /** Diagonal stamp across the column: SEALED / COUNTERSIGNED / null. */
  sealText: string | null;
}

export interface TradeCtaModel {
  accept: { visible: boolean; enabled: boolean; hint: string; stateLine: string | null };
  confirm: { visible: boolean; enabled: boolean; hint: string; stateLine: string | null };
  decline: { label: string; hint: string };
}

export interface TradeBannerModel {
  kind: "none" | "executed" | "declined";
  title: string;
  line: string;
}

export interface TradeViewModel {
  open: boolean;
  partnerName: string;
  /** Status-strip stage tag ("NEGOTIATING", "SEALED BOTH SIDES", …). */
  stageLine: string;
  mine: TradeColumnModel;
  theirs: TradeColumnModel;
  ctas: TradeCtaModel;
  banner: TradeBannerModel;
  /** Selection validated against the live offer lines (vanished line → null). */
  selection: TradeSelection | null;
  /** The line backing the turntable preview, or null for the empty well. */
  previewCell: TradeCellModel | null;
}

export interface ComposeTradeViewOptions {
  selection: TradeSelection | null;
  /** Scalar credits available in my wallet (coin-field hint). */
  heldCoin: number;
}

export function tradeCellKey(side: TradeSideId, itemId: number, variantId: number): string {
  return `trade:${side}:${itemId}:${variantId}`;
}

export function composeTradeView(session: TradeSessionVM | null, opts: ComposeTradeViewOptions): TradeViewModel {
  if (!session) {
    return {
      open: false,
      partnerName: "",
      stageLine: "",
      mine: emptyColumn("mine", TRADE_COPY.mineTitle, true),
      theirs: emptyColumn("theirs", "\u2014", false),
      ctas: {
        accept: { visible: false, enabled: false, hint: TRADE_COPY.cta.acceptHint, stateLine: null },
        confirm: { visible: false, enabled: false, hint: TRADE_COPY.cta.confirmHint, stateLine: null },
        decline: { label: TRADE_COPY.cta.close, hint: TRADE_COPY.cta.declineHint },
      },
      banner: { kind: "none", title: "", line: "" },
      selection: null,
      previewCell: null,
    };
  }

  const terminal = isTerminalTradeStage(session.stage);
  const stage = session.stage;

  const mine = composeColumn(session, "mine", TRADE_COPY.mineTitle, opts, terminal);
  const theirs = composeColumn(session, "theirs", session.theirs.name.toUpperCase(), opts, terminal);

  // Selection survives only while its line is still on the table.
  const selectedCell = opts.selection
    ? [...mine.cells, ...theirs.cells].find((cell) => cell.selected) ?? null
    : null;

  const ctas: TradeCtaModel = {
    accept: {
      visible: stage === "negotiating",
      enabled: stage === "negotiating" && !session.mine.locked,
      hint: TRADE_COPY.cta.acceptHint,
      stateLine: stage === "negotiating" && session.mine.locked ? TRADE_COPY.cta.acceptSealed : null,
    },
    confirm: {
      visible: stage === "confirm",
      enabled: stage === "confirm" && !session.mine.confirmed,
      hint: TRADE_COPY.cta.confirmHint,
      stateLine: stage === "confirm" && session.mine.confirmed ? TRADE_COPY.cta.confirmGiven : null,
    },
    decline: {
      label: terminal ? TRADE_COPY.cta.close : TRADE_COPY.cta.decline,
      hint: TRADE_COPY.cta.declineHint,
    },
  };

  const banner: TradeBannerModel = stage === "executed"
    ? { kind: "executed", title: TRADE_COPY.executed.title, line: TRADE_COPY.executed.line }
    : stage === "declined"
      ? { kind: "declined", title: TRADE_COPY.declinedTitle, line: tradeCloseLine(session.closeReason) }
      : { kind: "none", title: "", line: "" };

  return {
    open: true,
    partnerName: session.theirs.name,
    stageLine: TRADE_COPY.stage[stage],
    mine,
    theirs,
    ctas,
    banner,
    selection: selectedCell ? { side: selectedCell.side, itemId: selectedCell.itemId, variantId: selectedCell.variantId } : null,
    previewCell: selectedCell,
  };
}

function composeColumn(
  session: TradeSessionVM,
  side: TradeSideId,
  title: string,
  opts: ComposeTradeViewOptions,
  terminal: boolean,
): TradeColumnModel {
  const sideVm = session[side];
  const cells: TradeCellModel[] = sideVm.items.map((line: TradeItemLineVM) => ({
    key: tradeCellKey(side, line.itemId, line.variantId),
    side,
    itemId: line.itemId,
    variantId: line.variantId,
    name: line.name,
    quantity: line.quantity,
    countText: line.quantity > 1 ? `\u00d7${line.quantity.toLocaleString("en-US")}` : null,
    selected: opts.selection !== null
      && opts.selection.side === side
      && opts.selection.itemId === line.itemId
      && opts.selection.variantId === line.variantId,
    removable: side === "mine" && !terminal,
  }));
  const minCells = TRADE_GRID_COLUMNS * TRADE_GRID_MIN_ROWS;
  const rows = Math.max(TRADE_GRID_MIN_ROWS, Math.ceil(Math.max(cells.length, minCells) / TRADE_GRID_COLUMNS));
  return {
    side,
    title,
    cells,
    emptyCount: Math.max(0, rows * TRADE_GRID_COLUMNS - cells.length),
    coinValue: sideVm.coin,
    coinText: sideVm.coin.toLocaleString("en-US"),
    coinEditable: side === "mine" && !terminal,
    heldLine: side === "mine" ? TRADE_COPY.coin.held(opts.heldCoin) : null,
    locked: sideVm.locked,
    sealText: sideVm.confirmed ? TRADE_COPY.seal.confirmed : sideVm.locked ? TRADE_COPY.seal.locked : null,
  };
}

function emptyColumn(side: TradeSideId, title: string, mine: boolean): TradeColumnModel {
  return {
    side,
    title,
    cells: [],
    emptyCount: TRADE_GRID_COLUMNS * TRADE_GRID_MIN_ROWS,
    coinValue: 0,
    coinText: "0",
    coinEditable: false,
    heldLine: mine ? TRADE_COPY.coin.held(0) : null,
    locked: false,
    sealText: null,
  };
}

/**
 * Coin-field commit clamp: whole non-negative credits, bounded by the
 * wallet (server re-validates — the clamp is an honesty affordance, the
 * field never STAGES coin the wallet can't cover).
 */
export function clampTradeCoin(raw: number, heldCoin: number): number {
  if (!Number.isFinite(raw)) return 0;
  const whole = Math.max(0, Math.trunc(raw));
  return Math.min(whole, Math.max(0, Math.trunc(heldCoin)));
}
