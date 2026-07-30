/**
 * Toolbar persistence — pure doc logic, kept DOM-free so the migration and
 * slot-assignment rules can be unit-tested without a window.
 *
 * Storage shape (schema 3):
 *   { schema: 3, slots: ({ kind: "action", id } | { kind: "item", itemId } | null)[12], binds: string[12] }
 *
 * Migration policy (owner spec, 2026-07-04):
 *   - BLANK BY DEFAULT: a fresh profile (no stored doc) gets an all-empty
 *     toolbar. Device muscle memory is the binds, not pre-seeded verbs.
 *   - AIM REMOVAL: the Aim action was deleted from the registry, so any slot
 *     still holding `aimed_shot` is stripped on load (the isValidActionId
 *     predicate rejects it). Everything else the player saved is preserved.
 *   - Legacy `successor3d.toolbar.v1` docs are read once and promoted through v2 to v3.
 */

export interface ToolbarActionSlotRef {
  kind: "action";
  id: string;
}

export interface ToolbarItemSlotRef {
  kind: "item";
  itemId: string;
}

export type ToolbarFilledSlotRef = ToolbarActionSlotRef | ToolbarItemSlotRef;
export type ToolbarSlotRef = ToolbarFilledSlotRef | null;

export interface ToolbarDoc {
  slots: ToolbarSlotRef[];
  binds: string[];
}

export interface ToolbarDocDefaults {
  /** Slot count (12 — three groups of four). */
  slotCount: number;
  /** Default hotkey code per slot (number row 1-=). */
  defaultBinds: readonly string[];
}

/**
 * Read + migrate a stored toolbar doc. `rawV3` wins, `rawV2` is promoted next,
 * and the legacy `rawV1` shape is the final fallback. When all are absent the
 * blank default is returned. Invalid action ids become null — this is the
 * Aim-removal migration (`aimed_shot` is no longer valid).
 */
export function loadToolbarDoc(
  rawV3: string | null,
  rawV2: string | null,
  rawV1: string | null,
  defaults: ToolbarDocDefaults,
  isValidActionId: (id: string) => boolean,
): ToolbarDoc {
  const parsed = parseDoc(rawV3) ?? parseDoc(rawV2) ?? parseDoc(rawV1);
  return migrateToolbarDoc(parsed, defaults, isValidActionId);
}

function parseDoc(raw: string | null): ParsedDoc | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as unknown;
    if (value && typeof value === "object" && ("slots" in value || "binds" in value)) {
      return value as ParsedDoc;
    }
  } catch {
    // corrupt or non-JSON — fall through to blank default
  }
  return null;
}

interface ParsedDoc {
  schema?: unknown;
  slots?: unknown[];
  binds?: unknown[];
}

/**
 * Pure migration: coerce an arbitrary parsed value into a valid schema-3 doc.
 * Exported for direct unit testing of the Aim-strip + clamp rules.
 */
export function migrateToolbarDoc(
  parsed: ParsedDoc | null,
  defaults: ToolbarDocDefaults,
  isValidActionId: (id: string) => boolean,
): ToolbarDoc {
  const slots = Array.from({ length: defaults.slotCount }, (_, i) =>
    migrateSlotRef(parsed?.slots?.[i], isValidActionId),
  );
  const binds = Array.from({ length: defaults.slotCount }, (_, i) => {
    const code = parsed?.binds?.[i];
    return typeof code === "string" && code.length > 0 ? code : (defaults.defaultBinds[i] ?? "");
  });
  return { slots, binds };
}

function migrateSlotRef(raw: unknown, isValidActionId: (id: string) => boolean): ToolbarSlotRef {
  if (typeof raw === "string") {
    return isValidActionId(raw) ? { kind: "action", id: raw } : null;
  }
  if (!raw || typeof raw !== "object") return null;
  const ref = raw as { kind?: unknown; id?: unknown; itemId?: unknown };
  if (ref.kind === "action") {
    return typeof ref.id === "string" && isValidActionId(ref.id) ? { kind: "action", id: ref.id } : null;
  }
  if (ref.kind === "item") {
    return typeof ref.itemId === "string" && ref.itemId.length > 0 ? { kind: "item", itemId: ref.itemId } : null;
  }
  return null;
}

/** Assign a ref to a slot (browser/inventory → slot drop). Returns a new array. */
export function assignSlot(
  slots: readonly ToolbarSlotRef[],
  slot: number,
  ref: ToolbarFilledSlotRef,
): ToolbarSlotRef[] {
  if (slot < 0 || slot >= slots.length) return [...slots];
  const next = [...slots];
  next[slot] = cloneSlotRef(ref);
  return next;
}

/**
 * Move a ref between slots, swapping if the target is occupied.
 * Empty target → move (source clears); occupied target → swap. from===to or
 * out-of-range is a no-op copy.
 */
export function moveOrSwapSlot(slots: readonly ToolbarSlotRef[], from: number, to: number): ToolbarSlotRef[] {
  if (from === to || from < 0 || from >= slots.length || to < 0 || to >= slots.length) return [...slots];
  const next = [...slots];
  const sourceRef = next[from];
  if (!sourceRef) return next;
  next[from] = next[to] ?? null;
  next[to] = sourceRef;
  return next;
}

/** Clear a slot (drag-off-toolbar). Out-of-range is a no-op copy. */
export function clearSlot(slots: readonly ToolbarSlotRef[], slot: number): ToolbarSlotRef[] {
  if (slot < 0 || slot >= slots.length) return [...slots];
  const next = [...slots];
  next[slot] = null;
  return next;
}

function cloneSlotRef(ref: ToolbarFilledSlotRef): ToolbarFilledSlotRef {
  return ref.kind === "action" ? { kind: "action", id: ref.id } : { kind: "item", itemId: ref.itemId };
}
