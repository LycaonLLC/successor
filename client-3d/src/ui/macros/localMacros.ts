import {
  MacroParseError,
  parseMacroBody,
} from "@successor/client/src/slice-core/macroEngine/index";

/**
 * LOCAL macros — read-only `.macro` files from the player's disk.
 *
 * Only the desktop shell can reach the filesystem: the Electron preload
 * exposes `window.__successorDesktop.macroFiles()`, one IPC call that lists
 * and reads `<userData>/macros/*.macro` under the containment rules in
 * desktop/src/macro-library.mjs (regular UTF-8 files only, no symlinks,
 * 64 files / 8192-byte bodies, deterministic per-file errors). Browser
 * builds have no bridge — the provider reports unsupported and stays empty.
 *
 * Every readable body is parse-checked here so the library can show load
 * AND parse failures on the row instead of a dead RUN button. Files are
 * immutable from the game: editing means cloning into the character record.
 */

export interface LocalMacroRow {
  readonly name: string;
  readonly fileName: string;
  /** Raw file body; kept for errored-but-decodable files so CLONE can fix them. */
  readonly body: string | null;
  readonly bytes: number;
  /** Load or parse failure, human-readable; null = runnable. */
  readonly error: string | null;
}

interface DesktopMacroFilesResult {
  readonly ok?: unknown;
  readonly files?: unknown;
  readonly truncated?: unknown;
  readonly error?: unknown;
}

interface DesktopBridge {
  readonly isDesktopShell?: boolean;
  macroFiles?: () => Promise<DesktopMacroFilesResult>;
}

declare global {
  // Injected by the Electron preload (desktop/src/preload.cjs); absent in browsers.
  // eslint-disable-next-line no-var
  var __successorDesktop: DesktopBridge | undefined;
}

type LoadPhase = "unsupported" | "idle" | "loading" | "loaded" | "failed";

let rows: LocalMacroRow[] = [];
let dirError: string | null = null;
let truncated = false;
let phase: LoadPhase = "idle";
let version = 0;
let bridgeOverride: DesktopBridge | null | undefined;

function bridge(): DesktopBridge | null {
  if (bridgeOverride !== undefined) return bridgeOverride;
  const candidate = globalThis.__successorDesktop;
  return typeof candidate?.macroFiles === "function" ? candidate : null;
}

export function localMacrosSupported(): boolean {
  return bridge() !== null;
}

export function localMacroRows(): readonly LocalMacroRow[] {
  return rows;
}

export function localMacrosVersion(): number {
  return version;
}

/** Directory-level failure ("macro directory unreadable: …"); null = fine. */
export function localMacroDirError(): string | null {
  return dirError;
}

export function localMacrosTruncated(): boolean {
  return truncated;
}

/** Runnable local macro by name (case-insensitive); errored rows never match. */
export function localMacroByName(name: string): LocalMacroRow | null {
  const key = name.trim().toLowerCase();
  return rows.find((row) => row.error === null && row.body !== null && row.name.toLowerCase() === key) ?? null;
}

/** Idempotent boot kick: first call starts the one initial load. */
export function ensureLocalMacrosLoaded(): void {
  if (phase !== "idle") return;
  void refreshLocalMacros();
}

/** Re-read the directory through the desktop bridge (no-op in browsers). */
export async function refreshLocalMacros(): Promise<void> {
  const shell = bridge();
  if (!shell?.macroFiles) {
    phase = "unsupported";
    return;
  }
  phase = "loading";
  let result: DesktopMacroFilesResult;
  try {
    result = await shell.macroFiles();
  } catch {
    applyFailure("macro file bridge unavailable");
    return;
  }
  if (!result || result.ok !== true) {
    applyFailure(typeof result?.error === "string" ? result.error : "macro directory unreadable");
    return;
  }
  const fileRows: unknown[] = Array.isArray(result.files) ? result.files : [];
  rows = fileRows.map((file) => normalizeRow(file));
  dirError = null;
  truncated = result.truncated === true;
  phase = "loaded";
  version += 1;
}

function applyFailure(error: string): void {
  rows = [];
  dirError = error;
  truncated = false;
  phase = "failed";
  version += 1;
}

function normalizeRow(file: unknown): LocalMacroRow {
  const record: object = file !== null && typeof file === "object" ? file : {};
  const rawFileName = "fileName" in record ? record.fileName : undefined;
  const fileName = typeof rawFileName === "string" ? rawFileName : "?";
  const rawName = "name" in record ? record.name : undefined;
  const name = typeof rawName === "string" ? rawName : fileName;
  const rawBytes = "bytes" in record ? record.bytes : undefined;
  const bytes = typeof rawBytes === "number" ? rawBytes : 0;
  const rawError = "error" in record ? record.error : undefined;
  if (typeof rawError === "string") {
    return { name, fileName, body: null, bytes, error: rawError };
  }
  const rawBody = "body" in record ? record.body : undefined;
  if (typeof rawBody !== "string") {
    return { name, fileName, body: null, bytes, error: "unreadable" };
  }
  // Parse check up front: a broken file shows its line, not a dead RUN.
  try {
    parseMacroBody(rawBody);
  } catch (error) {
    const detail = error instanceof MacroParseError ? `L${error.line}: ${error.code}` : "error";
    return { name, fileName, body: rawBody, bytes, error: `parse ${detail}` };
  }
  return { name, fileName, body: rawBody, bytes, error: null };
}

/** Test hook: inject a fake bridge (null = browser) and clear state. */
export function resetLocalMacrosForTest(nextBridge?: DesktopBridge | null): void {
  rows = [];
  dirError = null;
  truncated = false;
  phase = "idle";
  version = 0;
  bridgeOverride = nextBridge;
}
