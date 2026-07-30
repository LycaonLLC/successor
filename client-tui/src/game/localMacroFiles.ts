import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  LOCAL_MACRO_FILE_RULES,
  STARTER_MACROS,
  starterMacroByName,
  type MacroProvider,
} from "@successor/client/src/slice-core/macroEngine/index";

/**
 * TUI local macro files + the three-provider library.
 *
 * Directory: `$XDG_CONFIG_HOME/successor/macros` (or `~/.config/successor/
 * macros`) — read-only player-authored `*.macro` text files. Semantics are
 * identical to the desktop shell's `<userData>/macros` IPC (desktop/src/
 * macro-library.mjs); both obey slice-core LOCAL_MACRO_FILE_RULES:
 *   - regular files only — directories, sockets, and symlinks are rejected
 *     (a symlink pointing anywhere, inside or out, never loads);
 *   - the basename (minus `.macro`) must match the store-name pattern —
 *     traversal characters never match;
 *   - the resolved path must stay inside the resolved macro directory;
 *   - bodies over maxBytes or containing invalid UTF-8 are per-file errors;
 *   - listings above maxFiles are truncated deterministically (byte-order
 *     name sort) and flagged.
 *
 * The library merges the three providers with character > local > starter
 * precedence (name collisions shadow the lower provider). Only the
 * character tier is writable; local files and starters run directly but
 * must be copied into the character record to edit.
 */

export interface LocalMacroFileRow {
  readonly name: string;
  readonly fileName: string;
  readonly bytes?: number;
  readonly body?: string;
  readonly error?: string;
}

export interface LocalMacroListing {
  readonly ok: boolean;
  readonly dir: string;
  readonly files: readonly LocalMacroFileRow[];
  readonly truncated: boolean;
  readonly error?: string;
}

/** `$XDG_CONFIG_HOME/successor/macros`, falling back to `~/.config`. */
export function defaultTuiMacroDir(env: NodeJS.ProcessEnv = process.env): string {
  const configHome = env.XDG_CONFIG_HOME && path.isAbsolute(env.XDG_CONFIG_HOME)
    ? env.XDG_CONFIG_HOME
    : path.join(os.homedir(), ".config");
  return path.join(configHome, "successor", "macros");
}

/** List every `*.macro` file in `dir` with its body (desktop IPC parity). */
export function loadLocalMacroFiles(dir: string): LocalMacroListing {
  const rules = LOCAL_MACRO_FILE_RULES;
  let realDir: string;
  try {
    realDir = fs.realpathSync(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      return { ok: true, dir, files: [], truncated: false };
    }
    return { ok: false, dir, files: [], truncated: false, error: `macro directory unreadable: ${(error as NodeJS.ErrnoException)?.code ?? "error"}` };
  }

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(realDir, { withFileTypes: true });
  } catch (error) {
    return { ok: false, dir, files: [], truncated: false, error: `macro directory unreadable: ${(error as NodeJS.ErrnoException)?.code ?? "error"}` };
  }

  const candidates = entries
    .filter((entry) => entry.name.endsWith(rules.extension))
    .map((entry) => entry.name)
    .sort();
  const truncated = candidates.length > rules.maxFiles;
  const files: LocalMacroFileRow[] = [];
  for (const fileName of candidates.slice(0, rules.maxFiles)) {
    files.push(readLocalMacroFile(realDir, fileName));
  }
  return { ok: true, dir, files, truncated };
}

function readLocalMacroFile(realDir: string, fileName: string): LocalMacroFileRow {
  const rules = LOCAL_MACRO_FILE_RULES;
  const name = fileName.slice(0, -rules.extension.length);
  const row = { name, fileName };
  if (!rules.namePattern.test(name)) {
    return { ...row, error: "invalid name" };
  }
  const filePath = path.join(realDir, fileName);
  if (path.dirname(path.resolve(filePath)) !== realDir) {
    return { ...row, error: "path escapes macro directory" };
  }
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(filePath);
  } catch {
    return { ...row, error: "unreadable" };
  }
  if (stat.isSymbolicLink()) return { ...row, error: "symlink rejected" };
  if (!stat.isFile()) return { ...row, error: "not a regular file" };
  if (stat.size > rules.maxBytes) {
    return { ...row, error: `oversize (${stat.size} > ${rules.maxBytes} bytes)` };
  }
  let raw: Buffer;
  try {
    raw = fs.readFileSync(filePath);
  } catch {
    return { ...row, error: "unreadable" };
  }
  let body: string;
  try {
    body = new TextDecoder("utf-8", { fatal: true }).decode(raw);
  } catch {
    return { ...row, error: "invalid UTF-8" };
  }
  return { ...row, bytes: raw.byteLength, body };
}

// ── Three-provider library ──────────────────────────────────────────────────

export interface TuiMacroDef {
  readonly name: string;
  readonly body: string;
  readonly source: MacroProvider;
}

export interface TuiMacroLibrary {
  /** Engine resolution: character > local > starter, case-insensitive. */
  getMacro(name: string): { name: string; body: string; iconId?: string } | null;
  listMacros(): readonly { name: string; iconId?: string }[];
  /** Define/replace a character-tier macro (the only writable provider). */
  define(name: string, body: string): void;
  /** Remove a character-tier macro; local/starter tiers are immutable. */
  remove(name: string): boolean;
  /** Effective merged list (shadowed lower-tier entries omitted). */
  listDefs(): readonly TuiMacroDef[];
  /** Local file load errors, human-readable ("name: error"); [] = clean. */
  localIssues(): readonly string[];
}

export interface TuiMacroLibraryOptions {
  /** Local `.macro` directory; null disables the local provider. */
  localDir?: string | null;
}

export function createTuiMacroLibrary(options: TuiMacroLibraryOptions = {}): TuiMacroLibrary {
  const characterTier = new Map<string, { name: string; body: string }>();

  const localTier = new Map<string, { name: string; body: string }>();
  const issues: string[] = [];
  const localDir = options.localDir === undefined ? defaultTuiMacroDir() : options.localDir;
  if (localDir) {
    const listing = loadLocalMacroFiles(localDir);
    if (!listing.ok) {
      issues.push(listing.error ?? "macro directory unreadable");
    } else {
      if (listing.truncated) issues.push(`macro directory truncated to ${LOCAL_MACRO_FILE_RULES.maxFiles} files`);
      for (const row of listing.files) {
        if (row.error !== undefined || row.body === undefined) {
          issues.push(`${row.fileName}: ${row.error ?? "unreadable"}`);
          continue;
        }
        localTier.set(row.name.toLowerCase(), { name: row.name, body: row.body });
      }
    }
  }

  const resolve = (name: string): { entry: { name: string; body: string }; source: MacroProvider } | null => {
    const key = name.trim().toLowerCase();
    const character = characterTier.get(key);
    if (character) return { entry: character, source: "character" };
    const local = localTier.get(key);
    if (local) return { entry: local, source: "local" };
    const starter = starterMacroByName(key);
    if (starter) return { entry: { name: starter.name, body: starter.body }, source: "starter" };
    return null;
  };

  const listDefs = (): TuiMacroDef[] => {
    const merged = new Map<string, TuiMacroDef>();
    for (const starter of STARTER_MACROS) {
      merged.set(starter.name.toLowerCase(), { name: starter.name, body: starter.body, source: "starter" });
    }
    for (const [key, entry] of localTier) {
      merged.set(key, { name: entry.name, body: entry.body, source: "local" });
    }
    for (const [key, entry] of characterTier) {
      merged.set(key, { name: entry.name, body: entry.body, source: "character" });
    }
    return [...merged.values()].sort((a, b) => a.name.localeCompare(b.name));
  };

  return {
    getMacro(name) {
      const hit = resolve(name);
      return hit ? { name: hit.entry.name, body: hit.entry.body } : null;
    },
    listMacros() {
      return listDefs().map((def) => ({ name: def.name }));
    },
    define(name, body) {
      const trimmed = name.trim();
      characterTier.set(trimmed.toLowerCase(), { name: trimmed, body });
    },
    remove(name) {
      return characterTier.delete(name.trim().toLowerCase());
    },
    listDefs,
    localIssues() {
      return issues;
    },
  };
}
