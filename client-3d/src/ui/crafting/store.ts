import type { PlayState } from "@successor/client/src/slice-core/gameState";
import { resourceTaxonomyForItemId } from "../inventory/resourceInfo";
import type {
  CraftRecipeDetailVM,
  CraftRecipeSummaryVM,
  CraftSessionVM,
  CraftSlotScreenVM,
  DraftedSchematicVM,
} from "./types";

/**
 * CRAFT store — module-level accumulation of the crafting channel state
 * (survey-store pattern: one PlayState per page, reset with the page).
 *
 * Three surfaces feed it:
 *  - the authority receive path ingests known recipes / recipe details /
 *    the live craftSession VM / drafted schematics as they stream
 *    (CONTRACTS-LIVE bind point — one ingest call per section);
 *  - session commands optimistically change NOTHING here (server truth
 *    only — the VM moves when the authority answers);
 *  - the DEV fixture seam (below) drives all four phases for tests,
 *    screenshots and the QA harness without a live sim.
 */

export interface CraftStoreState {
  recipes: CraftRecipeSummaryVM[];
  detailsByRecipeId: Map<string, CraftRecipeDetailVM>;
  session: CraftSessionVM | null;
  drafts: DraftedSchematicVM[];
}

const store: CraftStoreState = {
  recipes: [],
  detailsByRecipeId: new Map(),
  session: null,
  drafts: [],
};

let storeVersion = 0;

/** Monotonic counter bumped on every ingest — cheap re-render detection. */
export function craftStoreVersion(): number {
  return storeVersion;
}

export function craftRecipes(): readonly CraftRecipeSummaryVM[] {
  return store.recipes;
}

export function craftRecipeDetail(recipeId: string): CraftRecipeDetailVM | null {
  return store.detailsByRecipeId.get(recipeId) ?? null;
}

export function craftSession(): CraftSessionVM | null {
  return store.session;
}

export function craftDrafts(): readonly DraftedSchematicVM[] {
  return store.drafts;
}

// ── Ingest (authority receive path + dev seam) ─────────────────────────────

export function ingestCraftRecipes(recipes: readonly CraftRecipeSummaryVM[]): void {
  store.recipes = recipes.slice();
  storeVersion += 1;
}

export function ingestCraftRecipeDetail(detail: CraftRecipeDetailVM): void {
  store.detailsByRecipeId.set(detail.recipeId, detail);
  storeVersion += 1;
}

/** Replace the live session VM (null closes it — finalize/draft/cancel). */
export function ingestCraftSession(session: CraftSessionVM | null): void {
  store.session = session;
  storeVersion += 1;
}

export function ingestCraftDrafts(drafts: readonly DraftedSchematicVM[]): void {
  store.drafts = drafts.slice();
  storeVersion += 1;
}

// ── Authority sync (live bind) ─────────────────────────────────────────────
// Normalizes the streamed craftSession / draftedSchematics channels into the
// store. Called from the surfaces' update paths (window + datapad pane) —
// identity-gated so identical wire objects cost nothing per frame. The
// composition root opts in (`enableCraftAuthoritySync`); harnesses that
// drive the store through fixtures never enable it, so the two feeds can't
// fight.

let authoritySyncEnabled = false;
let syncedSession: unknown = Symbol("never");
let syncedDrafts: unknown = Symbol("never");

/** Composition-root opt-in: the live client owns the store from here on. */
export function enableCraftAuthoritySync(): void {
  authoritySyncEnabled = true;
}

export function syncCraftChannelFromAuthority(state: PlayState): void {
  if (!authoritySyncEnabled) return;
  const wireSession = state.serverAuthority.craftSession;
  if (wireSession !== syncedSession) {
    syncedSession = wireSession;
    applyWireSession(wireSession);
  }
  const wireDrafts = state.serverAuthority.draftedSchematics;
  if (wireDrafts !== syncedDrafts) {
    syncedDrafts = wireDrafts;
    ingestCraftDrafts(Array.isArray(wireDrafts) ? wireDrafts.map(normalizeWireDraft) : []);
  }
}

function applyWireSession(wire: unknown): void {
  if (!wire || typeof wire !== "object") {
    ingestCraftSession(null);
    return;
  }
  const session = wire as {
    phase?: unknown;
    recipeId?: unknown;
    recipes?: unknown;
    detail?: unknown;
    details?: unknown;
    slotScreen?: unknown;
    assembled?: unknown;
  };
  // Browse payload carries the KNOWN-RECIPES list + selected detail(s);
  // it can ride ANY phase (list stays warm while a session runs).
  if (Array.isArray(session.recipes)) {
    ingestCraftRecipes(session.recipes as CraftRecipeSummaryVM[]);
  }
  const details = Array.isArray(session.details)
    ? session.details
    : session.detail && typeof session.detail === "object"
      ? [session.detail]
      : [];
  for (const detail of details) {
    const candidate = detail as CraftRecipeDetailVM;
    if (typeof candidate.recipeId === "string" && Array.isArray(candidate.slots)) {
      ingestCraftRecipeDetail(candidate);
    }
  }
  const phase = session.phase;
  if (phase !== "slots" && phase !== "assembled") {
    ingestCraftSession(null);
    return;
  }
  const recipeId = typeof session.recipeId === "string" ? session.recipeId : "";
  ingestCraftSession({
    phase,
    recipeId,
    slotScreen: normalizeWireSlotScreen(session.slotScreen, recipeId),
    assembled: (session.assembled ?? null) as CraftSessionVM["assembled"],
  });
}

/**
 * The wire's slot fills duplicate requirement identity for rendering; older
 * payloads only had it on the recipe DETAIL spec. Join on slotIndex so both
 * current and stale browse/session payloads render the honesty sub-line.
 */
function normalizeWireSlotScreen(wire: unknown, recipeId: string): CraftSessionVM["slotScreen"] {
  if (!wire || typeof wire !== "object") return null;
  const screen = wire as CraftSlotScreenVM;
  if (!Array.isArray(screen.slots)) return null;
  const detail = store.detailsByRecipeId.get(recipeId) ?? null;
  for (const slot of screen.slots) {
    const spec = detail?.slots.find((candidate) => candidate.slotIndex === slot.slotIndex);
    slot.craftRelevantStat = slot.craftRelevantStat ?? spec?.craftRelevantStat ?? null;
    slot.requiredItemId = slot.requiredItemId ?? spec?.requiredItemId ?? null;
    slot.requiredFamily = slot.requiredFamily ?? spec?.requiredFamily ?? null;
    slot.requirementKind = slot.requirementKind ?? spec?.requirementKind;
    slot.requiredItemName = slot.requiredItemName ?? spec?.requiredItemName ?? null;
  }
  return screen;
}

function normalizeWireDraft(wire: unknown): DraftedSchematicVM {
  const draft = (wire ?? {}) as {
    id?: unknown;
    schematicId?: unknown;
    recipeId?: unknown;
    name?: unknown;
    outputItemId?: unknown;
    outputVariantId?: unknown;
    maxUses?: unknown;
    remainingUses?: unknown;
    resourceLocks?: unknown;
    statLines?: unknown;
  };
  const recipeId = typeof draft.recipeId === "string" ? draft.recipeId : "";
  const knownName = store.recipes.find((recipe) => recipe.recipeId === recipeId)?.name;
  const locks = Array.isArray(draft.resourceLocks) ? draft.resourceLocks : [];
  return {
    schematicId: String(draft.schematicId ?? draft.id ?? ""),
    recipeId,
    name: typeof draft.name === "string" && draft.name.length > 0
      ? draft.name
      : knownName ?? fallbackDraftName(recipeId),
    outputItemId: Math.trunc(Number(draft.outputItemId ?? 0)),
    outputVariantId: Math.trunc(Number(draft.outputVariantId ?? 0)),
    maxUses: Math.max(0, Math.trunc(Number(draft.maxUses ?? 0))),
    remainingUses: Math.max(0, Math.trunc(Number(draft.remainingUses ?? 0))),
    resourceLocks: locks.map(normalizeWireLock),
    // The wire freezes stats inside the output variant, not as lines — the
    // pane hides an empty result line rather than inventing numbers.
    statLines: Array.isArray(draft.statLines)
      ? (draft.statLines as DraftedSchematicVM["statLines"])
      : [],
  };
}

function normalizeWireLock(wire: unknown): DraftedSchematicVM["resourceLocks"][number] {
  const lock = (wire ?? {}) as {
    itemId?: unknown;
    variantId?: unknown;
    quantity?: unknown;
    name?: unknown;
  };
  const itemId = Math.trunc(Number(lock.itemId ?? 0));
  const name = typeof lock.name === "string" && lock.name.length > 0
    ? lock.name
    : resourceTaxonomyForItemId(itemId)?.displayName ?? `Material ${itemId}`;
  return {
    itemId,
    variantId: Math.trunc(Number(lock.variantId ?? 0)),
    quantity: Math.max(0, Math.trunc(Number(lock.quantity ?? 0))),
    name,
  };
}

function fallbackDraftName(recipeId: string): string {
  if (!recipeId) return "Pattern";
  return recipeId
    .split(/[_-]/u)
    .filter((word) => word.length > 0)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

// ── Dev fixture seam ───────────────────────────────────────────────────────
// Matches __successorSurveyIngest: lets the QA harness drive the window
// through every phase without the sim round-trip. DEV builds only.

export interface CraftIngestPayload {
  recipes?: readonly CraftRecipeSummaryVM[];
  details?: readonly CraftRecipeDetailVM[];
  session?: CraftSessionVM | null;
  drafts?: readonly DraftedSchematicVM[];
}

declare global {
  interface Window {
    __successorCraftIngest?: (payload: CraftIngestPayload) => number;
  }
}

if (import.meta.env.DEV && typeof window !== "undefined") {
  window.__successorCraftIngest = (payload: CraftIngestPayload): number => {
    if (payload.recipes) ingestCraftRecipes(payload.recipes);
    if (payload.details) {
      for (const detail of payload.details) ingestCraftRecipeDetail(detail);
    }
    if (payload.session !== undefined) ingestCraftSession(payload.session);
    if (payload.drafts) ingestCraftDrafts(payload.drafts);
    return storeVersion;
  };
}
