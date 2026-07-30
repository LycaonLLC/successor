import { CRAFT_COPY, recipeDescription } from "./copy";
import {
  slotMaterialLine,
  slotQtyText,
  slotRequirementLabel,
} from "@successor/client/src/slice-core/crafting/slotPresentation";
export {
  slotMaterialLine,
  slotQtyText,
  slotRequirementLabel,
} from "@successor/client/src/slice-core/crafting/slotPresentation";
import type {
  CraftAssembledVM,
  CraftRecipeCategory,
  CraftRecipeDetailVM,
  CraftRecipeSummaryVM,
  CraftSlotFillVM,
  CraftSlotSpecVM,
  CraftSlotScreenVM,
  CraftStatLineVM,
  DraftedSchematicVM,
  ResourceOptionVM,
  ResourceStatsVM,
} from "./types";

/**
 * CRAFT composers — pure render models for all five bench stages + the
 * datapad SCHEMATICS tab. DOM-free by design: every display decision
 * (ordering, gating, meters, honest notes) lives here where vitest can pin
 * it, and the
 * window layer only paints. Server truth stays server truth — the composers
 * never invent eligibility, recommendations or projected rolls.
 */

// ── Formatting ──────────────────────────────────────────────────────────────

/** Milli (0–1000) → "74.2%" (survey-window percent voice). */
export function formatMilliPercent(milli: number): string {
  return `${(Math.max(0, Math.min(1000, milli)) / 10).toFixed(1)}%`;
}

/** Stat meter width % from a 0–1000 value (resourceInfo meter rule). */
export function statMeterPct(value: number): number {
  return Math.max(1, Math.min(100, Math.round(value / 10)));
}

/**
 * Exact rail position % from a 0–1000 milli value. Unlike statMeterPct
 * (which floors at a VISIBLE 1% for resource meters), pins and carets are
 * survey instruments: 0 milli sits at 0%, 1000 at 100%, fractions kept.
 */
export function railPct(milli: number): number {
  return Math.max(0, Math.min(100, milli / 10));
}

/** Display labels for the 12-stat block (static lookup table). */
const STAT_LABEL_BY_KEY: Record<keyof ResourceStatsVM, string> = {
  conductivity: "CONDUCTIVITY",
  malleability: "MALLEABILITY",
  shock_resistance: "SHOCK RES",
  thermal_resistance: "THERMAL RES",
  chemical_purity: "PURITY",
  density: "DENSITY",
  tensile_strength: "TENSILE",
  flexibility: "FLEX",
  potency: "POTENCY",
  nutrition: "NUTRITION",
  stability: "STABILITY",
  extraction_yield: "EX YIELD",
};

/** Presentation order for full 12-stat readouts (hover ⓘ). */
export const STAT_ORDER = Object.keys(STAT_LABEL_BY_KEY) as ReadonlyArray<keyof ResourceStatsVM>;

export function statLabel(key: keyof ResourceStatsVM): string {
  return STAT_LABEL_BY_KEY[key] ?? String(key).replace(/_/gu, " ").toUpperCase();
}

export interface StatHoverRow {
  key: keyof ResourceStatsVM;
  label: string;
  value: number;
  meterPct: number;
  /** The slot's craft-relevant stat — the row the player is choosing on. */
  relevant: boolean;
}

/** Full 12-stat hover rows; zero-stats stay visible (an honest zero). */
export function composeStatHover(
  stats: ResourceStatsVM,
  relevantKey: keyof ResourceStatsVM | null,
): StatHoverRow[] {
  const rows: StatHoverRow[] = [];
  for (const key of STAT_ORDER) {
    const raw = stats[key];
    const value = Number.isFinite(raw) ? Math.max(0, Math.min(1000, Math.trunc(raw))) : 0;
    rows.push({ key, label: STAT_LABEL_BY_KEY[key], value, meterPct: statMeterPct(value), relevant: key === relevantKey });
  }
  return rows;
}

// ── Phase 1 — browser ──────────────────────────────────────────────────────

export type CraftCategoryFilter = "all" | CraftRecipeCategory;

export const CATEGORY_TABS: ReadonlyArray<readonly [CraftCategoryFilter, string]> = [
  ["all", "ALL"],
  ["weapon", "WEAPONS"],
  ["tool", "TOOLS"],
  ["component", "COMPONENTS"],
  ["supply", "SUPPLIES"],
];

export interface BrowserRow {
  recipeId: string;
  name: string;
  categoryLabel: string;
  unlocked: boolean;
  /** "TRAINED" / "LEARNED" source chip. */
  sourceLabel: string;
  /** "3 uses left" on limited learned recipes, else null. */
  remainingLine: string | null;
  /** Hover reason on locked rows, null when selectable. */
  lockedNote: string | null;
}

const CATEGORY_LABEL: Readonly<Record<CraftRecipeCategory, string>> = {
  weapon: "WEAPON",
  tool: "TOOL",
  component: "COMPONENT",
  supply: "SUPPLY",
};

const CATEGORY_PLURAL: Readonly<Record<CraftRecipeCategory, string>> = {
  weapon: "WEAPONS",
  tool: "TOOLS",
  component: "COMPONENTS",
  supply: "SUPPLIES",
};

/** "craftsman-assembly-i" → { profession "Craftsman", progression "Assembly I" }. */
export function parseProgressionId(requiredProfession: string): { profession: string; progression: string } {
  const tokens = requiredProfession.trim().toLowerCase().replace(/_/gu, "-").split("-").filter(Boolean);
  const word = (token: string): string =>
    /^(?:i|ii|iii|iv|v|vi|vii|viii|ix|x)$/u.test(token)
      ? token.toUpperCase()
      : token.charAt(0).toUpperCase() + token.slice(1);
  const [professionToken, ...rest] = tokens;
  return {
    profession: professionToken ? word(professionToken) : "Unknown",
    progression: rest.length > 0 ? rest.map(word).join(" ") : "Novice",
  };
}

/** One progression box in the browser: a consecutive authority-stream run of
 * recipes sharing category + required skill box. */
export interface BrowserGroup {
  /** `${category}:${requiredProfession}` — stable render identity. */
  key: string;
  professionLabel: string;
  progressionLabel: string;
  /** Plural tab-voice label ("WEAPONS") — repeats legibly under ALL. */
  categoryLabel: string;
  unlockedCount: number;
  /** First fully-locked progression for its category+profession — the
   * player's next training target, flagged so it reads as NEXT UP. */
  nextUp: boolean;
  rows: BrowserRow[];
}

/**
 * Browser groups for one category tab + name filter. The authority stream is
 * already sorted (category → profession → tier → skill box → id) and is
 * NEVER re-sorted here: groups are consecutive runs of the same category +
 * required skill box, so headers land exactly where the authority order
 * changes progression. Filters and search only REMOVE rows — survivors keep
 * stream order. Ineligible rows are opt-in: the normal crafting surface only
 * contains recipes the authority says this player can begin learning now.
 */
export function composeBrowserGroups(
  recipes: readonly CraftRecipeSummaryVM[],
  category: CraftCategoryFilter,
  query = "",
  showIneligible = false,
): BrowserGroup[] {
  const needle = query.trim().toLowerCase();
  const groups: BrowserGroup[] = [];
  for (const recipe of recipes) {
    if (!showIneligible && !recipe.unlocked) continue;
    if (category !== "all" && recipe.category !== category) continue;
    if (needle && !recipe.name.toLowerCase().includes(needle)) continue;
    const learned = recipe.source === "learned";
    const remaining = typeof recipe.remainingUses === "number" ? recipe.remainingUses : null;
    const { profession, progression } = parseProgressionId(recipe.requiredProfession);
    const row: BrowserRow = {
      recipeId: recipe.recipeId,
      name: recipe.name,
      categoryLabel: CATEGORY_LABEL[recipe.category],
      unlocked: recipe.unlocked,
      sourceLabel: learned ? CRAFT_COPY.browser.sourceLearned : CRAFT_COPY.browser.sourceTrained,
      remainingLine: remaining !== null ? CRAFT_COPY.browser.limitedUses(remaining) : null,
      lockedNote: recipe.unlocked ? null : `${CRAFT_COPY.browser.locked} — ${profession} · ${progression}`,
    };
    const key = `${recipe.category}:${recipe.requiredProfession}`;
    const last = groups[groups.length - 1];
    if (last && last.key === key) {
      last.rows.push(row);
      if (row.unlocked) last.unlockedCount += 1;
    } else {
      groups.push({
        key,
        professionLabel: profession.toUpperCase(),
        progressionLabel: progression.toUpperCase(),
        categoryLabel: CATEGORY_PLURAL[recipe.category],
        unlockedCount: row.unlocked ? 1 : 0,
        nextUp: false,
        rows: [row],
      });
    }
  }
  // NEXT UP: the first fully-locked box per category+profession run.
  const lockedSeen = new Set<string>();
  for (const group of groups) {
    if (group.unlockedCount > 0) continue;
    const professionKey = `${group.categoryLabel}:${group.professionLabel}`;
    if (!lockedSeen.has(professionKey)) {
      group.nextUp = true;
      lockedSeen.add(professionKey);
    }
  }
  return groups;
}

export interface LedgerRequirementRow {
  symbol: string;
  kindLabel: string;
  materialLine: string | null;
  qtyText: string;
  statLabel: string;
  requiredQty: number;
  /** Carried quantity from local authoritative inventory; null = no counter wired. */
  ownedQty: number | null;
  /** "120 carried" line under the quantity, null when ownership is unknown. */
  carriedLine: string | null;
  /** READY / MISSING chip state; null when ownership is unknown. */
  ready: boolean | null;
  stateLabel: string | null;
}

export interface LedgerLimitRow {
  label: string;
  capText: string;
  meterPct: number;
}

export interface RecipeLedger {
  recipeId: string;
  name: string;
  /** "TOOL · TRAINED" meta line. */
  metaLine: string;
  description: string;
  requirements: LedgerRequirementRow[];
  limits: LedgerLimitRow[];
  /** BEGIN gate + honest note (bare hands / tool gate / locked). */
  canBegin: boolean;
  beginNote: string | null;
}

/**
 * Right-hand ledger for the selected recipe. The begin gate is honest about
 * WHY: locked recipes name training; tool-gated recipes name the missing
 * tool; hands-craftable recipes stay live bare-handed but carry the
 * rough-results warning (owner canon — improvised assembly is penalized).
 */
export function composeRecipeLedger(
  summary: CraftRecipeSummaryVM,
  detail: CraftRecipeDetailVM | null,
  deps: { toolCarried: boolean; ownedQtyOf?: (slot: CraftSlotSpecVM) => number },
): RecipeLedger {
  const requirements: LedgerRequirementRow[] = [];
  const limits: LedgerLimitRow[] = [];
  if (detail) {
    for (const slot of detail.slots) {
      const owned = deps.ownedQtyOf ? Math.max(0, Math.trunc(deps.ownedQtyOf(slot))) : null;
      const ready = owned === null ? null : owned >= slot.requiredQty;
      requirements.push({
        symbol: slot.symbol,
        kindLabel: slotRequirementLabel(slot),
        materialLine: slotMaterialLine(slot),
        qtyText: slotQtyText(slot),
        statLabel: statLabel(slot.craftRelevantStat),
        requiredQty: slot.requiredQty,
        ownedQty: owned,
        carriedLine: owned === null ? null : CRAFT_COPY.browser.carried(owned),
        ready,
        stateLabel: ready === null ? null : ready ? CRAFT_COPY.browser.ready : CRAFT_COPY.browser.missing,
      });
    }
    for (const line of detail.statLines) {
      limits.push({
        label: line.label,
        capText: `≤ ${Math.max(0, Math.trunc(line.capEstimateMilli))}`,
        meterPct: statMeterPct(line.capEstimateMilli),
      });
    }
  }
  const spent = typeof summary.remainingUses === "number" && summary.remainingUses <= 0;
  let canBegin = summary.unlocked && !spent;
  let beginNote: string | null = null;
  if (!summary.unlocked) {
    const { profession, progression } = parseProgressionId(summary.requiredProfession);
    beginNote = `${CRAFT_COPY.browser.locked} — ${profession} · ${progression}`;
  } else if (spent) {
    beginNote = CRAFT_COPY.drafts.spent;
  } else if (!deps.toolCarried) {
    if (summary.handsCraftable) {
      beginNote = CRAFT_COPY.browser.bareHandsHint;
    } else {
      canBegin = false;
      beginNote = CRAFT_COPY.browser.toolGateHint;
    }
  }
  const meta = [CATEGORY_LABEL[summary.category]];
  meta.push(summary.source === "learned" ? CRAFT_COPY.browser.sourceLearned : CRAFT_COPY.browser.sourceTrained);
  if (typeof summary.remainingUses === "number") {
    meta.push(CRAFT_COPY.browser.limitedUses(summary.remainingUses).toUpperCase());
  }
  return {
    recipeId: summary.recipeId,
    name: summary.name,
    metaLine: meta.join(" · "),
    description: recipeDescription(summary.recipeId),
    requirements,
    limits,
    canBegin,
    beginNote,
  };
}

// ── Phase 2 — slot screen ──────────────────────────────────────────────────

export interface SlotCard {
  slotIndex: number;
  symbol: string;
  kindLabel: string;
  qtyText: string;
  materialLine: string | null;
  /** Assigned option name + qty, or null while empty. */
  assignedLine: string | null;
  filled: boolean;
  selected: boolean;
}

export interface OptionRow {
  /** Stable row key (`container:stackId:variantId`). */
  key: string;
  container: string;
  stackId: string;
  variantId: number;
  name: string;
  qtyText: string;
  statValue: number;
  meterPct: number;
  recommended: boolean;
  /** Stack can't cover requiredQty — visible but honestly disabled. */
  shortStack: boolean;
  /** Player-language reason the LOAD path is disabled, null when loadable. */
  unavailableNote: string | null;
  assigned: boolean;
  hover: StatHoverRow[];
}

export interface SlotScreenModel {
  cards: SlotCard[];
  /** Options for the SELECTED slot, server order (DESC by craft stat). */
  options: OptionRow[];
  /** Craft-relevant stat label for the options column header. */
  optionStatLabel: string;
  canAssemble: boolean;
  /** Honest gate line under ASSEMBLE while slots are missing. */
  assembleNote: string | null;
  /** "LOADING · IRON CASING · ×80" — names the active slot for the options pane. */
  activeSlotLine: string | null;
}

function optionMatchesAssignment(option: ResourceOptionVM, slot: CraftSlotFillVM): boolean {
  const assigned = slot.assigned;
  return assigned !== null
    && assigned.container === option.container
    && assigned.stackId === option.stackId
    && assigned.variantId === option.variantId;
}

/**
 * Slot cards + the selected slot's eligible list. Assignment display joins
 * the assigned fingerprint back to its option row for the name; the server
 * recommendation renders as a BEST FIT tag on the row it marked — the FE
 * re-ranks nothing.
 */
export function composeSlotScreen(
  screen: CraftSlotScreenVM,
  selectedSlotIndex: number,
): SlotScreenModel {
  const cards: SlotCard[] = [];
  let selected: CraftSlotFillVM | null = null;
  let unfilled = 0;
  for (const slot of screen.slots) {
    const isSelected = slot.slotIndex === selectedSlotIndex;
    if (isSelected) selected = slot;
    let assignedLine: string | null = null;
    if (slot.assigned !== null) {
      const source = slot.eligible.find((option) => optionMatchesAssignment(option, slot));
      assignedLine = source
        ? `${source.name} ×${slot.requiredQty}`
        : `LOADED ×${slot.requiredQty}`;
    } else {
      unfilled += 1;
    }
    cards.push({
      slotIndex: slot.slotIndex,
      symbol: slot.symbol,
      kindLabel: slotRequirementLabel(slot),
      materialLine: slotMaterialLine(slot),
      qtyText: slotQtyText(slot),
      assignedLine,
      filled: slot.assigned !== null,
      selected: isSelected,
    });
  }
  const options: OptionRow[] = [];
  if (selected) {
    for (const option of selected.eligible) {
      options.push({
        key: `${option.container}:${option.stackId}:${option.variantId}`,
        container: option.container,
        stackId: option.stackId,
        variantId: option.variantId,
        name: option.name,
        qtyText: `×${option.qtyAvailable}`,
        statValue: option.craftRelevantStatValue,
        meterPct: statMeterPct(option.craftRelevantStatValue),
        recommended: option.recommended,
        shortStack: option.qtyAvailable < selected.requiredQty,
        unavailableNote: option.qtyAvailable < selected.requiredQty
          ? CRAFT_COPY.slots.shortStackNeed(option.qtyAvailable, selected.requiredQty)
          : null,
        assigned: optionMatchesAssignment(option, selected),
        hover: composeStatHover(option.stats, selected.craftRelevantStat),
      });
    }
  }
  return {
    cards,
    options,
    optionStatLabel: selected?.craftRelevantStat ? statLabel(selected.craftRelevantStat) : "",
    canAssemble: screen.canAssemble,
    assembleNote: screen.canAssemble
      ? CRAFT_COPY.slots.assembleWarn
      : unfilled > 0
        ? CRAFT_COPY.slots.assembleGate
        : null,
    activeSlotLine: selected
      ? CRAFT_COPY.slots.activeSlot(slotRequirementLabel(selected), selected.requiredQty)
      : null,
  };
}

/** First unfilled slot index (post-assign auto-advance), or the last slot. */
export function nextSlotIndex(screen: CraftSlotScreenVM, fromIndex: number): number {
  for (const slot of screen.slots) {
    if (slot.assigned === null) return slot.slotIndex;
  }
  return fromIndex;
}

// ── Phase 4/5 — TUNE (experiment allocator) + FINISH (exits) ───────────────

/**
 * Authority experimentation pool at grant time (crafting.rs
 * craft_experimentation_points) — presentation ceiling for the pip row.
 * The live remaining count is server truth; a profession bonus above 7
 * simply widens the row.
 */
export const TUNE_POOL_MAX = 7;

/**
 * Exact success chance for one experiment command of `points` on one line:
 * clamp(onePointSuccessMilli − batchRiskPerExtraPointMilli × (points − 1),
 * 100, 950) — the authority experiment contract verbatim. Never rolled
 * client-side; this only names the odds the server will use.
 */
export function batchSuccessMilli(
  onePointSuccessMilli: number,
  batchRiskPerExtraPointMilli: number,
  points: number,
): number {
  const staged = Math.max(1, Math.trunc(points));
  return Math.max(100, Math.min(950, onePointSuccessMilli - batchRiskPerExtraPointMilli * (staged - 1)));
}

// Authority line milli is NORMALIZED GOODNESS: experiment success always
// pushes valueMilli toward capMilli, no line projects a raw lower-is-better
// display unit. The rail badge is therefore one neutral truth (TOWARD CAP ·
// BETTER) — no per-label direction guessing, which could lie.

/** Local pending experiment spend, lineId → points (never sent until APPLY). */
export type PendingSpend = ReadonlyMap<number, number>;

export function totalPending(pending: PendingSpend): number {
  let total = 0;
  for (const points of pending.values()) total += points;
  return total;
}

/**
 * Clamp a +/- adjustment on one line: never negative, never past the pool,
 * never onto a line the server says can't raise. Returns the new map (the
 * old one is never mutated — render diffing keys off identity).
 */
export function adjustPendingSpend(
  pending: PendingSpend,
  assembled: CraftAssembledVM,
  lineId: number,
  delta: number,
): PendingSpend {
  const line = assembled.lines.find((candidate) => candidate.lineId === lineId);
  if (!line) return pending;
  const current = pending.get(lineId) ?? 0;
  const poolLeft = assembled.experimentationPointsRemaining - (totalPending(pending) - current);
  const ceiling = line.canRaise ? Math.max(0, poolLeft) : 0;
  const next = Math.max(0, Math.min(ceiling, current + delta));
  if (next === current) return pending;
  const map = new Map(pending);
  if (next === 0) map.delete(lineId);
  else map.set(lineId, next);
  return map;
}

export interface FinishLine {
  lineId: number;
  label: string;
  valueText: string;
  capText: string;
  /** Caret position % of the 0–1000 scale (current authority value). */
  valuePct: number;
  /** Cap-pin position % of the 0–1000 scale (weighted material ceiling). */
  capPct: number;
  /** Displayed under the label — one neutral truth for the milli rail. */
  dirLabel: string;
  canRaise: boolean;
  pendingPoints: number;
  /**
   * Exact authority success chance for the staged batch (≥1 point staged)
   * or the one-point baseline. Null when the wire omitted the risk fields
   * or the line can't raise — the UI shows nothing rather than inventing.
   */
  holdChanceText: string | null;
  /** 100% − hold — the slip/degradation chance of the same attempt. */
  slipChanceText: string | null;
  /** "+2 marked" while a spend is staged, "At its ceiling" when capped. */
  noteLine: string | null;
}

export interface FinishModel {
  qualityText: string;
  pointsLeft: number;
  /** Pool minus staged marks — what APPLY would leave. */
  pointsAfterPending: number;
  /** Pip-row width: the 7-point grant, widened if the server sent more. */
  poolMax: number;
  poolText: string;
  lines: FinishLine[];
  canExperiment: boolean;
  /** Draft/prototype/practice stay live regardless of experiment state. */
  canFinalize: boolean;
}

function lineChanceMilli(line: CraftStatLineVM, points: number): number | null {
  if (line.onePointSuccessMilli === undefined || line.batchRiskPerExtraPointMilli === undefined) return null;
  return batchSuccessMilli(line.onePointSuccessMilli, line.batchRiskPerExtraPointMilli, points);
}

export function composeFinish(assembled: CraftAssembledVM, pending: PendingSpend): FinishModel {
  const lines: FinishLine[] = [];
  for (const line of assembled.lines) {
    const points = pending.get(line.lineId) ?? 0;
    const capped = !line.canRaise;
    const chance = capped ? null : lineChanceMilli(line, Math.max(1, points));
    lines.push({
      lineId: line.lineId,
      label: line.label,
      valueText: String(Math.max(0, Math.trunc(line.valueMilli))),
      capText: String(Math.max(0, Math.trunc(line.capMilli))),
      valuePct: railPct(line.valueMilli),
      capPct: railPct(line.capMilli),
      dirLabel: CRAFT_COPY.tune.towardCap,
      canRaise: line.canRaise,
      pendingPoints: points,
      holdChanceText: chance === null ? null : formatMilliPercent(chance),
      slipChanceText: chance === null ? null : formatMilliPercent(1000 - chance),
      noteLine: points > 0
        ? CRAFT_COPY.finish.lineRaised(points)
        : capped
          ? CRAFT_COPY.finish.lineCapped
          : null,
    });
  }
  const staged = totalPending(pending);
  const pointsAfterPending = Math.max(0, assembled.experimentationPointsRemaining - staged);
  const poolMax = Math.max(TUNE_POOL_MAX, assembled.experimentationPointsRemaining);
  return {
    qualityText: formatMilliPercent(assembled.assemblyQualityMilli),
    pointsLeft: assembled.experimentationPointsRemaining,
    pointsAfterPending,
    poolMax,
    poolText: CRAFT_COPY.tune.poolOf(pointsAfterPending, poolMax),
    lines,
    canExperiment: staged > 0,
    canFinalize: true,
  };
}

/** Clamp a draft max-uses entry to the owner cap (1..1000). */
export function clampDraftUses(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.max(1, Math.min(1000, Math.trunc(value)));
}

// ── Datapad SCHEMATICS tab ─────────────────────────────────────────────────

export interface DraftRow {
  schematicId: string;
  name: string;
  usesText: string;
  spent: boolean;
  /** "Copper ×24 · Fuel ×12" frozen-lock summary. */
  lockLine: string;
  /** "POWER 412 · HANDLING 655" frozen-result summary. */
  statLine: string;
}

export function composeDraftRows(drafts: readonly DraftedSchematicVM[]): DraftRow[] {
  const rows: DraftRow[] = [];
  for (const draft of drafts) {
    rows.push({
      schematicId: draft.schematicId,
      name: draft.name,
      usesText: CRAFT_COPY.drafts.uses(draft.remainingUses, draft.maxUses),
      spent: draft.remainingUses <= 0,
      lockLine: draft.resourceLocks
        .map((lock) => `${lock.name} ×${lock.quantity}`)
        .join(" · "),
      statLine: draft.statLines
        .map((line) => `${line.label.toUpperCase()} ${Math.max(0, Math.trunc(line.valueMilli))}`)
        .join(" · "),
    });
  }
  rows.sort((a, b) => Number(a.spent) - Number(b.spent) || a.name.localeCompare(b.name));
  return rows;
}
