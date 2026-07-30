import {
  STARTER_MACROS,
  type MacroProvider,
} from "@successor/client/src/slice-core/macroEngine/index";
import {
  ensureLocalMacrosLoaded,
  localMacroDirError,
  localMacroRows,
  localMacrosSupported,
  localMacrosVersion,
} from "./localMacros";
import { macroByName, macroPreviewLine, macroStoreVersion, macros } from "./store";

/**
 * LIBRARY — the merged three-provider macro view (starterPack.ts provenance
 * model): character (server record, writable) > local (read-only disk files,
 * desktop only) > starter (checked-in pack, always present).
 *
 * Name collisions shadow the lower provider — shadowed rows stay listed
 * (dimmed, CLONE-only) so a player can still recover a starter/local body
 * after saving a character macro over its name. Engine resolution
 * (`resolveMacroSource`) always returns the winner and skips errored rows.
 */

export interface MacroLibraryRow {
  /** Stable DOM/row key: `character:<id>` | `local:<name>` | `starter:<name>`. */
  readonly key: string;
  readonly name: string;
  readonly source: MacroProvider;
  /** null only for unreadable local files (error rows without a body). */
  readonly body: string | null;
  readonly iconId: string;
  /** Row preview: starter summary / first body line / error copy. */
  readonly preview: string;
  /** Load or parse failure on a local file; null = healthy. */
  readonly error: string | null;
  /** True when a higher provider owns this name. */
  readonly shadowed: boolean;
  /** Character record id when source === "character". */
  readonly savedId: string | null;
}

export interface MacroSourceHit {
  readonly name: string;
  readonly body: string;
  readonly iconId: string;
  readonly source: MacroProvider;
}

/** Combined re-render version: bumps on record sync or local file refresh. */
export function macroLibraryVersion(): number {
  return macroStoreVersion() + localMacrosVersion();
}

/** Engine/name resolution: character > local > starter, case-insensitive. */
export function resolveMacroSource(name: string): MacroSourceHit | null {
  ensureLocalMacrosLoaded();
  const saved = macroByName(name);
  if (saved) return { name: saved.name, body: saved.body, iconId: saved.iconId, source: "character" };
  const key = name.trim().toLowerCase();
  const local = localMacroRows().find((row) => row.error === null && row.body !== null && row.name.toLowerCase() === key);
  if (local && local.body !== null) {
    return { name: local.name, body: local.body, iconId: "macro:command", source: "local" };
  }
  const starter = STARTER_MACROS.find((macro) => macro.name.toLowerCase() === key);
  if (starter) return { name: starter.name, body: starter.body, iconId: starter.iconId, source: "starter" };
  return null;
}

/** Directory-order rows: character (record order), local (name order), starter. */
export function macroLibraryRows(): MacroLibraryRow[] {
  ensureLocalMacrosLoaded();
  const rows: MacroLibraryRow[] = [];
  const claimed = new Set<string>();

  for (const saved of macros()) {
    claimed.add(saved.name.toLowerCase());
    rows.push({
      key: `character:${saved.id}`,
      name: saved.name,
      source: "character",
      body: saved.body,
      iconId: saved.iconId,
      preview: macroPreviewLine(saved.body),
      error: null,
      shadowed: false,
      savedId: saved.id,
    });
  }

  const localClaimed = new Set<string>();
  for (const local of localMacroRows()) {
    const nameKey = local.name.toLowerCase();
    const shadowed = local.error === null && claimed.has(nameKey);
    if (local.error === null) localClaimed.add(nameKey);
    rows.push({
      key: `local:${local.fileName}`,
      name: local.name,
      source: "local",
      body: local.body,
      iconId: "macro:command",
      preview: local.error ?? (local.body !== null ? macroPreviewLine(local.body) : ""),
      error: local.error,
      shadowed,
      savedId: null,
    });
  }

  for (const starter of STARTER_MACROS) {
    const nameKey = starter.name.toLowerCase();
    rows.push({
      key: `starter:${starter.name}`,
      name: starter.name,
      source: "starter",
      body: starter.body,
      iconId: starter.iconId,
      preview: starter.summary,
      error: null,
      shadowed: claimed.has(nameKey) || localClaimed.has(nameKey),
      savedId: null,
    });
  }

  return rows;
}

/** Library row by its stable key ("character:", "local:", "starter:"). */
export function macroLibraryRowByKey(key: string): MacroLibraryRow | null {
  return macroLibraryRows().find((row) => row.key === key) ?? null;
}

/** Foot-line copy for the local provider; null = nothing to report. */
export function localProviderNotice(): string | null {
  if (!localMacrosSupported()) return null;
  const dirError = localMacroDirError();
  if (dirError) return dirError.toUpperCase();
  const bad = localMacroRows().filter((row) => row.error !== null).length;
  return bad > 0 ? `${bad} LOCAL FILE${bad === 1 ? "" : "S"} FAILED` : null;
}
