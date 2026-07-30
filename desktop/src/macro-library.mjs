import fs from "node:fs";
import path from "node:path";

/**
 * Local macro files — read-only list/read surface for the renderer.
 *
 * Directory: `<app userData>/macros/*.macro` (the IPC layer in main.mjs owns
 * the userData resolution; this module owns every filesystem rule). Files are
 * player-authored text macros: read-only until copied into the character
 * record by the UI. Rules mirror slice-core LOCAL_MACRO_FILE_RULES /
 * MACRO_ENGINE_DEFAULT_CAPS (64 files / 8192-byte bodies / .macro):
 *   - regular files only — directories, sockets, and symlinks are rejected
 *     (a symlink pointing anywhere, inside or out, never loads);
 *   - names must match the store-name pattern plus the .macro extension —
 *     traversal characters never match;
 *   - the resolved path must stay inside the resolved macro directory;
 *   - bodies over maxBytes or containing invalid UTF-8 are per-file errors;
 *   - listings above maxFiles are truncated deterministically (byte-order
 *     name sort) and flagged.
 * Bad files come back as `{ name, error }` rows so the UI can show the
 * failure instead of silently dropping the file.
 */

export const MACRO_FILE_LIMITS = Object.freeze({
  extension: ".macro",
  maxFiles: 64,
  maxBytes: 8192,
});

const MACRO_FILE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 _-]{0,47}\.macro$/u;

/**
 * List every `*.macro` file in `dir` with its body.
 * Returns `{ ok: true, dir, files, truncated }`; a missing directory is an
 * empty listing, any other directory-level failure is `{ ok: false, error }`.
 * File rows: `{ name, fileName, bytes, body }` or `{ name, fileName, error }`.
 */
export function listMacroFiles(dir, limits = MACRO_FILE_LIMITS) {
  let realDir;
  try {
    realDir = fs.realpathSync(dir);
  } catch (error) {
    if (error?.code === "ENOENT") return { ok: true, dir, files: [], truncated: false };
    return { ok: false, dir, error: `macro directory unreadable: ${error?.code ?? "error"}` };
  }

  let entries;
  try {
    entries = fs.readdirSync(realDir, { withFileTypes: true });
  } catch (error) {
    return { ok: false, dir, error: `macro directory unreadable: ${error?.code ?? "error"}` };
  }

  const candidates = entries
    .filter((entry) => entry.name.endsWith(limits.extension))
    .map((entry) => entry.name)
    .sort();
  const truncated = candidates.length > limits.maxFiles;
  const files = [];
  for (const fileName of candidates.slice(0, limits.maxFiles)) {
    files.push(readMacroFile(realDir, fileName, limits));
  }
  return { ok: true, dir, files, truncated };
}

function readMacroFile(realDir, fileName, limits) {
  const name = fileName.slice(0, -limits.extension.length);
  const row = { name, fileName };
  if (!MACRO_FILE_NAME_PATTERN.test(fileName)) {
    return { ...row, error: "invalid name" };
  }
  const filePath = path.join(realDir, fileName);
  if (path.dirname(path.resolve(filePath)) !== realDir) {
    return { ...row, error: "path escapes macro directory" };
  }
  let stat;
  try {
    stat = fs.lstatSync(filePath);
  } catch {
    return { ...row, error: "unreadable" };
  }
  if (stat.isSymbolicLink()) return { ...row, error: "symlink rejected" };
  if (!stat.isFile()) return { ...row, error: "not a regular file" };
  if (stat.size > limits.maxBytes) {
    return { ...row, error: `oversize (${stat.size} > ${limits.maxBytes} bytes)` };
  }
  let raw;
  try {
    raw = fs.readFileSync(filePath);
  } catch {
    return { ...row, error: "unreadable" };
  }
  let body;
  try {
    body = new TextDecoder("utf-8", { fatal: true }).decode(raw);
  } catch {
    return { ...row, error: "invalid UTF-8" };
  }
  return { ...row, bytes: raw.byteLength, body };
}
