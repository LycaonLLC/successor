import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

/**
 * Owner-only persistence for the revocable hosted device credential.
 *
 * This deliberately does not use Electron safeStorage (or any platform
 * keychain). On POSIX, the v2 token is kept in a 0700 owner directory and a
 * 0600 owner file. Other platforms are memory-only. Existing v1 ciphertext is
 * never read, decrypted, repaired, or removed.
 */

const CREDENTIAL_FILE = "hosted-device-credential.v2.json";
const MAX_TOKEN_LENGTH = 512;
const MAX_JSON_BYTES = 4096;
const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const POSIX_PLATFORMS = new Set(["aix", "android", "darwin", "freebsd", "linux", "openbsd", "sunos"]);
let tempCounter = 0;

function isPosix(platform) {
  return POSIX_PLATFORMS.has(platform);
}

function ownerId() {
  return typeof process.getuid === "function" ? process.getuid() : null;
}

function modeIs(stat, expected) {
  return (stat.mode & 0o777) === expected;
}

function ownedByCurrentUser(stat, uid) {
  return uid !== null && stat.uid === uid;
}

function safeDirectory(stat, uid) {
  return stat.isDirectory() && modeIs(stat, DIRECTORY_MODE) && ownedByCurrentUser(stat, uid);
}

function safeFile(stat, uid) {
  return stat.isFile() && modeIs(stat, FILE_MODE) && ownedByCurrentUser(stat, uid);
}

async function inspectDirectory(fsImpl, directory, uid) {
  try {
    const stat = await fsImpl.lstat(directory);
    return safeDirectory(stat, uid);
  } catch (error) {
    if (error?.code !== "ENOENT") return false;
    try {
      await fsImpl.mkdir(directory, { mode: DIRECTORY_MODE });
      const stat = await fsImpl.lstat(directory);
      return safeDirectory(stat, uid);
    } catch {
      return false;
    }
  }
}

function validToken(token) {
  return typeof token === "string"
    && token.length >= 20
    && token.length <= MAX_TOKEN_LENGTH
    && !/[\u0000-\u001f\u007f]/u.test(token);
}

function parsePayload(raw) {
  if (Buffer.byteLength(raw, "utf8") > MAX_JSON_BYTES) return null;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || parsed.v !== 2 || !validToken(parsed.token)) {
    return null;
  }
  const keys = Object.keys(parsed);
  if (keys.length !== 2 || !keys.includes("v") || !keys.includes("token")) return null;
  return parsed.token;
}

function tempPath(filePath) {
  tempCounter = (tempCounter + 1) % 1_000_000;
  return `${filePath}.tmp-${process.pid}-${tempCounter}-${crypto.randomBytes(8).toString("hex")}`;
}

async function syncDirectory(fsImpl, directory) {
  const handle = await fsImpl.open(directory, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export function credentialFilePath(userDataDir) {
  return path.join(userDataDir, CREDENTIAL_FILE);
}

export function canPersistCredential(platform = process.platform) {
  return isPosix(platform) && ownerId() !== null;
}

export function createCredentialStore({ userDataDir, platform = process.platform, fsImpl = fs }) {
  const filePath = credentialFilePath(userDataDir);
  const directory = path.dirname(filePath);
  const uid = ownerId();
  const posix = canPersistCredential(platform);

  async function safeTargetStat() {
    try {
      return await fsImpl.lstat(filePath);
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      return false;
    }
  }

  return {
    filePath,

    persistAvailable() {
      return posix;
    },

    /** Returns { persisted } — false means memory-only or unsafe storage. */
    async save(credential) {
      if (!posix || !validToken(credential)) return { persisted: false, reason: "memory-only" };
      if (!(await inspectDirectory(fsImpl, directory, uid))) return { persisted: false, reason: "unsafe-storage" };

      const existing = await safeTargetStat();
      if (existing === false || (existing && !safeFile(existing, uid))) {
        return { persisted: false, reason: "unsafe-storage" };
      }
      if (existing) {
        let existingHandle;
        try {
          existingHandle = await fsImpl.open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
          const stat = await existingHandle.stat();
          const prior = stat.size <= MAX_JSON_BYTES ? parsePayload(await existingHandle.readFile("utf8")) : null;
          if (!safeFile(stat, uid) || !prior) return { persisted: false, reason: "unsafe-storage" };
        } catch {
          return { persisted: false, reason: "unsafe-storage" };
        } finally {
          await existingHandle?.close().catch(() => undefined);
        }
      }

      const payload = `${JSON.stringify({ v: 2, token: credential })}\n`;
      if (Buffer.byteLength(payload, "utf8") > MAX_JSON_BYTES) return { persisted: false, reason: "credential-too-large" };
      const tmp = tempPath(filePath);
      let handle;
      try {
        handle = await fsImpl.open(
          tmp,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
          FILE_MODE,
        );
        await handle.chmod(FILE_MODE);
        await handle.writeFile(payload, "utf8");
        await handle.sync();
        await handle.close();
        handle = null;
        await fsImpl.rename(tmp, filePath);
        await syncDirectory(fsImpl, directory);
        return { persisted: true };
      } catch {
        if (handle) await handle.close().catch(() => undefined);
        await fsImpl.unlink(tmp).catch(() => undefined);
        return { persisted: false, reason: "storage-failed" };
      }
    },

    /** Returns the v2 token, or null for absent/invalid/unsafe state. */
    async load() {
      if (!posix || !(await inspectDirectory(fsImpl, directory, uid))) return null;
      const target = await safeTargetStat();
      if (!target || target === false || !safeFile(target, uid)) return null;

      let handle;
      try {
        handle = await fsImpl.open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
        const stat = await handle.stat();
        if (!safeFile(stat, uid) || stat.size > MAX_JSON_BYTES) return null;
        const raw = await handle.readFile("utf8");
        return parsePayload(raw);
      } catch {
        return null;
      } finally {
        await handle?.close().catch(() => undefined);
      }
    },

    /** Explicitly clear a safe v2 file; unsafe state is left untouched. */
    async clear() {
      if (!posix || !(await inspectDirectory(fsImpl, directory, uid))) return { cleared: false, reason: "unsafe-storage" };
      const target = await safeTargetStat();
      if (target === null) return { cleared: true };
      if (target === false || !safeFile(target, uid)) return { cleared: false, reason: "unsafe-storage" };
      try {
        await fsImpl.unlink(filePath);
        await syncDirectory(fsImpl, directory);
        return { cleared: true };
      } catch {
        return { cleared: false, reason: "storage-failed" };
      }
    },
  };
}
