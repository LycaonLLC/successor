/**
 * Device credential at rest — one scoped opaque token, one file, strict modes.
 *
 * Layout: `$XDG_STATE_HOME/successor/credential.json` (falling back to
 * `~/.local/state/successor`). The directory must be 0700 and the file 0600,
 * both owned by the running user. Reads open with O_NOFOLLOW and re-check
 * everything on the open handle; writes go through an exclusive temp file
 * (O_CREAT|O_EXCL|O_NOFOLLOW, mode 0600) fsynced and renamed into place.
 * Anything off — symlink, wrong owner, permissive modes, malformed token —
 * is refused with the exact command that fixes it. Never auto-repaired.
 */
import { constants } from "node:fs";
import { mkdir, lstat, open, rename, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";

export const CREDENTIAL_SCHEMA = "successor.tui-credential.v1";
export const CREDENTIAL_FILE = "credential.json";
/** Matches the server's bearer shape (http.ts bearerToken). */
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{20,128}$/u;
const KNOWN_SCOPES: Record<string, true> = { "character:list": true, "play-ticket": true };
const MAX_FILE_BYTES = 4096;
const GROUP_OTHER_BITS = 0o077;

export type CredentialStoreErrorCode =
  | "CREDENTIAL_PLATFORM_UNSUPPORTED"
  | "CREDENTIAL_DIR_SYMLINK"
  | "CREDENTIAL_DIR_NOT_DIRECTORY"
  | "CREDENTIAL_DIR_WRONG_OWNER"
  | "CREDENTIAL_DIR_PERMISSIVE"
  | "CREDENTIAL_FILE_SYMLINK"
  | "CREDENTIAL_FILE_NOT_REGULAR"
  | "CREDENTIAL_FILE_WRONG_OWNER"
  | "CREDENTIAL_FILE_PERMISSIVE"
  | "CREDENTIAL_MALFORMED";

export class CredentialStoreError extends Error {
  readonly code: CredentialStoreErrorCode;
  constructor(code: CredentialStoreErrorCode, message: string) {
    super(message);
    this.name = "CredentialStoreError";
    this.code = code;
  }
}

export interface StoredCredential {
  readonly schema: typeof CREDENTIAL_SCHEMA;
  readonly apiUrl: string;
  readonly credential: string;
  readonly scopes: readonly string[];
  readonly obtainedAt: string;
}

export interface CredentialStoreContext {
  /** Directory holding the credential file; defaults to the XDG state dir. */
  dir?: string;
  env?: NodeJS.ProcessEnv;
  /** Expected owner uid; defaults to process.getuid(). Injectable for tests. */
  uid?: number;
}

export function credentialDir(env: NodeJS.ProcessEnv = process.env): string {
  const stateHome = env.XDG_STATE_HOME && path.isAbsolute(env.XDG_STATE_HOME)
    ? env.XDG_STATE_HOME
    : path.join(os.homedir(), ".local", "state");
  return path.join(stateHome, "successor");
}

function resolveContext(context: CredentialStoreContext): { dir: string; file: string; uid: number } {
  const uid = context.uid ?? process.getuid?.();
  if (uid === undefined) {
    throw new CredentialStoreError(
      "CREDENTIAL_PLATFORM_UNSUPPORTED",
      "Credential storage needs a POSIX filesystem with file ownership. This platform has none.",
    );
  }
  const dir = context.dir ?? credentialDir(context.env);
  return { dir, file: path.join(dir, CREDENTIAL_FILE), uid };
}

/** Rejects unless `dir` is a real directory, owned by `uid`, mode 0700. */
async function assertDirSafe(dir: string, uid: number): Promise<void> {
  const stat = await lstat(dir);
  if (stat.isSymbolicLink()) {
    throw new CredentialStoreError("CREDENTIAL_DIR_SYMLINK", `${dir} is a symlink. Remove it; the client only trusts a real directory here.`);
  }
  if (!stat.isDirectory()) {
    throw new CredentialStoreError("CREDENTIAL_DIR_NOT_DIRECTORY", `${dir} exists but is not a directory. Move it aside and sign in again.`);
  }
  if (stat.uid !== uid) {
    throw new CredentialStoreError("CREDENTIAL_DIR_WRONG_OWNER", `${dir} is owned by uid ${stat.uid}, not you (uid ${uid}). Fix the ownership or remove the directory.`);
  }
  if ((stat.mode & GROUP_OTHER_BITS) !== 0) {
    throw new CredentialStoreError("CREDENTIAL_DIR_PERMISSIVE", `${dir} is readable by other users. Run: chmod 700 ${dir}`);
  }
}

function parseStoredCredential(raw: string, file: string): StoredCredential {
  const malformed = (detail: string): CredentialStoreError =>
    new CredentialStoreError("CREDENTIAL_MALFORMED", `${file} ${detail}. Run \`successor-tui login\` to replace it.`);
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw malformed("is not valid JSON");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw malformed("is not a credential record");
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.join(",") !== "apiUrl,credential,obtainedAt,schema,scopes") throw malformed("has unexpected fields");
  if (record.schema !== CREDENTIAL_SCHEMA) throw malformed(`has schema ${String(record.schema)}; this client expects ${CREDENTIAL_SCHEMA}`);
  if (typeof record.apiUrl !== "string" || record.apiUrl.length === 0) throw malformed("has no account service URL");
  if (typeof record.credential !== "string" || !TOKEN_PATTERN.test(record.credential)) throw malformed("holds a malformed access token");
  if (!Array.isArray(record.scopes) || record.scopes.length === 0 || record.scopes.some((scope) => typeof scope !== "string" || !KNOWN_SCOPES[scope])) {
    throw malformed("names scopes this client does not know");
  }
  if (typeof record.obtainedAt !== "string" || Number.isNaN(Date.parse(record.obtainedAt))) throw malformed("has no valid obtained-at time");
  return {
    schema: CREDENTIAL_SCHEMA,
    apiUrl: record.apiUrl,
    credential: record.credential,
    scopes: [...(record.scopes as string[])],
    obtainedAt: record.obtainedAt,
  };
}

/** Loads the stored credential; null when none exists. Refuses unsafe state. */
export async function loadCredential(context: CredentialStoreContext = {}): Promise<StoredCredential | null> {
  const { dir, file, uid } = resolveContext(context);
  try {
    await assertDirSafe(dir, uid);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    if (code === "ELOOP" || code === "EMLINK") {
      throw new CredentialStoreError("CREDENTIAL_FILE_SYMLINK", `${file} is a symlink. Remove it and sign in again.`);
    }
    throw error;
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) {
      throw new CredentialStoreError("CREDENTIAL_FILE_NOT_REGULAR", `${file} is not a regular file. Remove it and sign in again.`);
    }
    if (stat.uid !== uid) {
      throw new CredentialStoreError("CREDENTIAL_FILE_WRONG_OWNER", `${file} is owned by uid ${stat.uid}, not you (uid ${uid}). Remove it and sign in again.`);
    }
    if ((stat.mode & GROUP_OTHER_BITS) !== 0) {
      throw new CredentialStoreError("CREDENTIAL_FILE_PERMISSIVE", `${file} is readable by other users. Run: chmod 600 ${file} — then sign in again to be safe.`);
    }
    if (stat.size > MAX_FILE_BYTES) {
      throw new CredentialStoreError("CREDENTIAL_MALFORMED", `${file} is too large to be a credential. Remove it and sign in again.`);
    }
    const raw = await handle.readFile({ encoding: "utf8" });
    return parseStoredCredential(raw, file);
  } finally {
    await handle.close();
  }
}

/** Atomically writes the credential: 0700 dir, exclusive 0600 temp, fsync, rename. */
export async function saveCredential(value: Omit<StoredCredential, "schema">, context: CredentialStoreContext = {}): Promise<string> {
  const { dir, file, uid } = resolveContext(context);
  if (!TOKEN_PATTERN.test(value.credential)) {
    throw new CredentialStoreError("CREDENTIAL_MALFORMED", "The server returned an access token this client refuses to store.");
  }
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await assertDirSafe(dir, uid);
  const record: StoredCredential = {
    schema: CREDENTIAL_SCHEMA,
    apiUrl: value.apiUrl,
    credential: value.credential,
    scopes: [...value.scopes],
    obtainedAt: value.obtainedAt,
  };
  const tempPath = path.join(dir, `.${CREDENTIAL_FILE}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
  const handle = await open(
    tempPath,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`, { encoding: "utf8" });
    await handle.sync();
  } catch (error) {
    await handle.close();
    await unlink(tempPath).catch(() => {});
    throw error;
  }
  await handle.close();
  try {
    await rename(tempPath, file);
  } catch (error) {
    await unlink(tempPath).catch(() => {});
    throw error;
  }
  return file;
}

/** Removes the stored credential. True when a file was actually deleted. */
export async function deleteCredential(context: CredentialStoreContext = {}): Promise<boolean> {
  const { file } = resolveContext(context);
  try {
    await unlink(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export function credentialFilePath(context: CredentialStoreContext = {}): string {
  const { file } = resolveContext(context);
  return file;
}
