#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { open, lstat, readlink, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { FarmError, errorDocument, parseArgs, printJson, processFailure, repoRoot, runProcess } from "./common.mjs";

export const SOURCE_MANIFEST_SCHEMA = "successor.source-manifest.v1";
export const SOURCE_IDENTITY_SCHEMA = "successor.source-identity.v1";
const HASH_DOMAIN = Buffer.from("successor-source-hash-v1\0", "utf8");
const READ_BUFFER_BYTES = 256 * 1024;

export class SourceChangedError extends FarmError {
  constructor(message = "source changed while it was being hashed") {
    super(message, { code: "SOURCE_CHANGED" });
  }
}

export async function createLocalSourceIdentity({ root = repoRoot, includeManifest = true } = {}) {
  const absoluteRoot = path.resolve(root);
  const selection = await listGitSourcePaths(absoluteRoot);
  const manifest = await hashSourcePaths(absoluteRoot, selection.paths);
  const provenance = await readGitProvenance(absoluteRoot, selection.untrackedCount);
  return {
    schema: SOURCE_IDENTITY_SCHEMA,
    sourceHash: manifest.sourceHash,
    fileCount: manifest.fileCount,
    totalBytes: manifest.totalBytes,
    provenance,
    ...(includeManifest ? { manifest } : {}),
  };
}

export async function createTreeSourceIdentity({
  root,
  expectedPaths,
  includeManifest = true,
} = {}) {
  if (!root) throw new FarmError("tree source identity requires a root", { code: "ROOT_REQUIRED" });
  const absoluteRoot = path.resolve(root);
  const paths = await listTreeSourcePaths(absoluteRoot, { expectedPaths });
  const manifest = await hashSourcePaths(absoluteRoot, paths);
  return {
    schema: SOURCE_IDENTITY_SCHEMA,
    sourceHash: manifest.sourceHash,
    fileCount: manifest.fileCount,
    totalBytes: manifest.totalBytes,
    provenance: null,
    ...(includeManifest ? { manifest } : {}),
  };
}

export async function listGitSourcePaths(root) {
  const [trackedResult, untrackedResult] = await Promise.all([
    runProcess("git", ["ls-files", "--cached", "-z"], { cwd: root, maxOutputBytes: 32 * 1024 * 1024 }),
    runProcess("git", ["ls-files", "--others", "--exclude-standard", "-z"], {
      cwd: root,
      maxOutputBytes: 32 * 1024 * 1024,
    }),
  ]);
  if (!trackedResult.ok) throw processFailure(trackedResult, "git tracked source listing");
  if (!untrackedResult.ok) throw processFailure(untrackedResult, "git untracked source listing");

  // Runtime outputs must not contaminate local parity, but no broad generated-
  // path rule belongs here: all other untracked source remains hash-authoritative.
  const tracked = splitNulPaths(trackedResult.stdout).filter((sourcePath) => !isRuntimeFarmArtifactPath(sourcePath));
  const untracked = splitNulPaths(untrackedResult.stdout).filter((sourcePath) => !isRuntimeFarmArtifactPath(sourcePath));
  const blockedCount = [...tracked, ...untracked].filter(isSensitiveSourcePath).length;
  if (blockedCount > 0) {
    throw new FarmError(`source transfer policy blocked ${blockedCount} sensitive path(s)`, {
      code: "SENSITIVE_SOURCE_BLOCKED",
      details: { count: blockedCount },
    });
  }

  const candidates = [
    ...tracked.map((sourcePath) => ({ path: sourcePath, tracked: true })),
    ...untracked.map((sourcePath) => ({ path: sourcePath, tracked: false })),
  ];
  const paths = [];
  for (const candidate of candidates) {
    validateRelativeSourcePath(candidate.path);
    try {
      const stats = await lstat(path.join(root, ...candidate.path.split("/")));
      if (!stats.isFile() && !stats.isSymbolicLink()) {
        throw new FarmError("source contains an unsupported non-file entry", {
          code: "UNSUPPORTED_SOURCE_ENTRY",
          details: { path: candidate.path },
        });
      }
      paths.push(candidate.path);
    } catch (error) {
      if (error?.code === "ENOENT" && candidate.tracked) continue;
      if (error?.code === "ENOENT") throw new SourceChangedError();
      throw error;
    }
  }
  assertPortablePathSet(paths);
  return { paths: sortPaths(paths), trackedCount: tracked.length, untrackedCount: untracked.length };
}

export async function listTreeSourcePaths(root, { expectedPaths } = {}) {
  const expected = expectedPaths === undefined ? undefined : new Set(expectedPaths);
  if (expected) {
    for (const sourcePath of expected) validateRelativeSourcePath(sourcePath);
    assertPortablePathSet([...expected]);
  }

  // A checkout that still has Git metadata can apply the exact same ignore
  // semantics as the planner. Unexpected non-ignored paths remain in the
  // worker set and change its hash; ignored build output stays out of parity.
  if (await hasGitMetadata(root)) {
    const selection = await listGitSourcePaths(root);
    const paths = new Set(selection.paths);
    await addExistingExpectedPaths(root, expected, paths);
    const unique = [...paths];
    assertPortablePathSet(unique);
    return sortPaths(unique);
  }

  // Farm transports intentionally omit .git. The fallback walker below uses
  // the explicit expected-path contract plus narrow artifact rules.
  const expectedPrefixes = new Set();
  for (const sourcePath of expected ?? []) {
    const segments = sourcePath.split("/");
    for (let index = 1; index < segments.length; index += 1) {
      expectedPrefixes.add(segments.slice(0, index).join("/"));
    }
  }

  const found = [];
  async function walk(relativeDirectory) {
    const absoluteDirectory = relativeDirectory
      ? path.join(root, ...relativeDirectory.split("/"))
      : root;
    let directoryEntries;
    try {
      directoryEntries = await readdir(absoluteDirectory, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") throw new SourceChangedError("source tree changed while it was scanned");
      throw error;
    }
    directoryEntries.sort((left, right) => Buffer.compare(Buffer.from(left.name), Buffer.from(right.name)));
    for (const directoryEntry of directoryEntries) {
      const sourcePath = (relativeDirectory ? `${relativeDirectory}/${directoryEntry.name}` : directoryEntry.name).normalize("NFC");
      if (!relativeDirectory && directoryEntry.name === ".git") continue;
      validateRelativeSourcePath(sourcePath);
      if (directoryEntry.isDirectory()) {
        const required = expectedPrefixes.has(sourcePath);
        if (!required && isGeneratedOrIgnoredPath(sourcePath, true)) continue;
        await walk(sourcePath);
        continue;
      }
      if (!directoryEntry.isFile() && !directoryEntry.isSymbolicLink()) {
        throw new FarmError("source tree contains an unsupported entry type", {
          code: "UNSUPPORTED_SOURCE_ENTRY",
          details: { path: sourcePath },
        });
      }
      const isExpected = expected?.has(sourcePath) ?? false;
      if (!isExpected && (isSensitiveSourcePath(sourcePath) || isGeneratedOrIgnoredPath(sourcePath, false))) continue;
      found.push(sourcePath);
    }
  }
  await walk("");

  if (expected) {
    for (const sourcePath of expected) {
      if (found.includes(sourcePath)) continue;
      try {
        const stats = await lstat(path.join(root, ...sourcePath.split("/")));
        if (stats.isFile() || stats.isSymbolicLink()) found.push(sourcePath);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
  }
  const unique = [...new Set(found)];
  assertPortablePathSet(unique);
  return sortPaths(unique);
}

async function hasGitMetadata(root) {
  try {
    const stats = await lstat(path.join(root, ".git"));
    return stats.isDirectory() || stats.isFile();
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function addExistingExpectedPaths(root, expected, paths) {
  if (!expected) return;
  for (const sourcePath of expected) {
    if (paths.has(sourcePath)) continue;
    try {
      const stats = await lstat(path.join(root, ...sourcePath.split("/")));
      if (stats.isFile() || stats.isSymbolicLink()) paths.add(sourcePath);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
}

export async function hashSourcePaths(root, sourcePaths) {
  const paths = sortPaths([...new Set(sourcePaths)]);
  assertPortablePathSet(paths);
  const sourceHasher = createHash("sha256");
  sourceHasher.update(HASH_DOMAIN);
  const entries = [];
  let totalBytes = 0;
  for (const sourcePath of paths) {
    const entry = await hashSourceEntry(root, sourcePath, sourceHasher);
    entries.push(entry);
    totalBytes += entry.size;
  }
  return {
    schema: SOURCE_MANIFEST_SCHEMA,
    sourceHash: sourceHasher.digest("hex"),
    fileCount: entries.length,
    totalBytes,
    entries,
  };
}

async function hashSourceEntry(root, sourcePath, sourceHasher) {
  validateRelativeSourcePath(sourcePath);
  const absolutePath = path.join(root, ...sourcePath.split("/"));
  let initial;
  try {
    initial = await lstat(absolutePath, { bigint: true });
  } catch (error) {
    if (error?.code === "ENOENT") throw new SourceChangedError();
    throw error;
  }
  const pathBytes = Buffer.from(sourcePath, "utf8");
  const pathLength = Buffer.allocUnsafe(4);
  pathLength.writeUInt32BE(pathBytes.length);

  if (initial.isSymbolicLink()) {
    const target = await readlink(absolutePath, { encoding: "buffer" });
    const final = await lstat(absolutePath, { bigint: true });
    if (!sameFileState(initial, final)) throw new SourceChangedError();
    updateEntryHeader(sourceHasher, pathLength, pathBytes, "symlink", false, target.length);
    sourceHasher.update(target);
    return {
      path: sourcePath,
      type: "symlink",
      executable: false,
      size: target.length,
      contentSha256: createHash("sha256").update(target).digest("hex"),
      symlinkTarget: target.toString("utf8"),
    };
  }
  if (!initial.isFile()) {
    throw new FarmError("source entry is not a regular file or symlink", {
      code: "UNSUPPORTED_SOURCE_ENTRY",
      details: { path: sourcePath },
    });
  }
  if (initial.size > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new FarmError("source entry is too large to manifest safely", {
      code: "SOURCE_ENTRY_TOO_LARGE",
      details: { path: sourcePath },
    });
  }

  const size = Number(initial.size);
  const executable = (initial.mode & 0o111n) !== 0n;
  updateEntryHeader(sourceHasher, pathLength, pathBytes, "file", executable, size);
  const contentHasher = createHash("sha256");
  const file = await open(absolutePath, "r");
  try {
    const opened = await file.stat({ bigint: true });
    if (!sameFileState(initial, opened)) throw new SourceChangedError();
    const buffer = Buffer.allocUnsafe(READ_BUFFER_BYTES);
    let position = 0;
    while (position < size) {
      const length = Math.min(buffer.length, size - position);
      const { bytesRead } = await file.read(buffer, 0, length, position);
      if (bytesRead === 0) throw new SourceChangedError();
      const chunk = buffer.subarray(0, bytesRead);
      sourceHasher.update(chunk);
      contentHasher.update(chunk);
      position += bytesRead;
    }
    const closedState = await file.stat({ bigint: true });
    if (!sameFileState(opened, closedState)) throw new SourceChangedError();
  } finally {
    await file.close();
  }
  const final = await lstat(absolutePath, { bigint: true });
  if (!sameFileState(initial, final)) throw new SourceChangedError();
  return {
    path: sourcePath,
    type: "file",
    executable,
    size,
    contentSha256: contentHasher.digest("hex"),
  };
}

function updateEntryHeader(hasher, pathLength, pathBytes, type, executable, size) {
  const sizeBuffer = Buffer.allocUnsafe(8);
  sizeBuffer.writeBigUInt64BE(BigInt(size));
  hasher.update(Buffer.from("entry\0", "utf8"));
  hasher.update(pathLength);
  hasher.update(pathBytes);
  hasher.update(Buffer.from([type === "file" ? 1 : 2, executable ? 1 : 0]));
  hasher.update(sizeBuffer);
}

function sameFileState(left, right) {
  return left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs;
}

export async function readGitProvenance(root, untrackedCount) {
  const commitResult = await runProcess("git", ["rev-parse", "HEAD"], { cwd: root });
  if (!commitResult.ok) throw processFailure(commitResult, "git HEAD provenance");
  const diff = await hashGitDiff(root);
  return {
    headCommit: commitResult.stdout.trim(),
    dirty: diff.hasBytes || untrackedCount > 0,
    trackedDiffSha256: diff.sha256,
    trackedDiffBytes: diff.bytes,
    untrackedFileCount: untrackedCount,
  };
}

async function hashGitDiff(root) {
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["diff", "HEAD", "--binary", "--no-ext-diff", "--no-textconv", "--"], {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const hasher = createHash("sha256");
    let bytes = 0;
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      bytes += chunk.length;
      hasher.update(chunk);
    });
    child.stderr.on("data", (chunk) => {
      if (stderr.length < 4_096) stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (exitCode, signal) => {
      if (exitCode !== 0) {
        reject(new FarmError(`git dirty provenance failed (exit-${exitCode}${signal ? `-${signal}` : ""})`, {
          code: "PROCESS_FAILED",
        }));
        return;
      }
      resolve({ sha256: hasher.digest("hex"), bytes, hasBytes: bytes > 0 });
    });
  });
}

export function isSensitiveSourcePath(sourcePath) {
  const lower = sourcePath.toLowerCase();
  const segments = lower.split("/");
  const base = segments.at(-1);
  if (segments.some((segment) => [".ssh", ".gnupg", ".aws", ".direnv"].includes(segment))) return true;
  if (segments[0] === ".docker" && segments[1] === "config.json") return true;
  if (base === ".env" || base?.startsWith(".env.") || base === ".envrc") return true;
  if ([".npmrc", ".netrc", ".pypirc", ".authinfo", ".git-credentials"].includes(base)) return true;
  if (/^(id_(rsa|dsa|ecdsa|ed25519)(\.pub)?|credentials\.json|auth\.json|secrets?\.json|tokens?\.json)$/u.test(base ?? "")) return true;
  if (/^service-account.*\.json$/u.test(base ?? "")) return true;
  return /\.(pem|key|p12|pfx|jks)$/u.test(base ?? "");
}

/** Declared farm runtime roots excluded from source transfer and source identity. */
function isRuntimeFarmArtifactPath(sourcePath) {
  const segments = sourcePath.toLowerCase().split("/");
  const base = segments.at(-1);
  if (segments[0] !== "verification") return false;
  if (segments[1] === ".runs") return true;
  return segments[1] === "ledgers" && (segments[2] === "artifacts" || base?.endsWith(".jsonl"));
}

export function isGeneratedOrIgnoredPath(sourcePath, isDirectory = false) {
  const segments = sourcePath.toLowerCase().split("/");
  const base = segments.at(-1);
  const generatedDirectories = new Set([
    "target", "node_modules", ".pnpm-store", "dist", "build", ".cache", ".vite", "__pycache__",
    "test-results", "tmp", "logs", ".checkpoints", ".game-lab",
  ]);
  if (segments.some((segment) => generatedDirectories.has(segment))) return true;
  // Mirror the narrow ignore patterns used by transported farm checkouts.
  // Unknown source files must remain hash-authoritative.
  if (segments.some((segment) => segment === ".terraform" || segment === "pkg")) return true;
  if (/\.tfstate(?:\..*)?$/u.test(base ?? "")) return true;
  if (/^temp-.*\.json$/u.test(base ?? "") && segments.at(-2) === "coverage") return true;
  if (base?.endsWith(".local.toml")) return true;
  if (segments[0] === "desktop" && base === "release" && isDirectory) return true;
  if (segments[0] === "verification" && segments[1] === ".runs") return true;
  if (segments[0] === "server" && [".local-state", "data"].includes(segments[1])) return true;
  if (segments[0] === "verification" && segments[1] === "ledgers") {
    if (segments[2] === "artifacts") return true;
    if (!isDirectory && base?.endsWith(".jsonl")) return true;
  }
  if (base === ".ds_store") return true;
  if (/\.(pyc|wasm|log|swp|swo|rs\.bk)$/u.test(base ?? "")) return true;
  if (segments[0] === "client-3d" && segments[1] === ".generated") return true;
  if (segments[0] === "client-3d" && segments.slice(1, 5).join("/") === "public/assets/asset-lab") return true;
  return false;
}

export function validateRelativeSourcePath(sourcePath) {
  if (typeof sourcePath !== "string" || sourcePath.length === 0 || sourcePath.includes("\0")) {
    throw new FarmError("source path is empty or invalid", { code: "INVALID_SOURCE_PATH" });
  }
  if (sourcePath !== sourcePath.normalize("NFC")) {
    throw new FarmError("source path is not Unicode NFC-normalized", { code: "NON_PORTABLE_SOURCE_PATH" });
  }
  if (path.posix.isAbsolute(sourcePath) || sourcePath.includes("\\")) {
    throw new FarmError("source path is not a portable relative path", { code: "NON_PORTABLE_SOURCE_PATH" });
  }
  const segments = sourcePath.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..") || segments[0] === ".git") {
    throw new FarmError("source path escapes or targets repository metadata", { code: "INVALID_SOURCE_PATH" });
  }
}

function assertPortablePathSet(paths) {
  const folded = new Map();
  for (const sourcePath of paths) {
    validateRelativeSourcePath(sourcePath);
    const key = sourcePath.normalize("NFC").toLocaleLowerCase("en-US");
    const prior = folded.get(key);
    if (prior !== undefined && prior !== sourcePath) {
      throw new FarmError("source contains a case-insensitive path collision", {
        code: "NON_PORTABLE_SOURCE_PATH_SET",
        details: { count: 2 },
      });
    }
    folded.set(key, sourcePath);
  }
}

function splitNulPaths(text) {
  if (text.includes("\uFFFD")) {
    throw new FarmError("git returned a non-UTF-8 source path", { code: "NON_PORTABLE_SOURCE_PATH" });
  }
  const paths = text.split("\0");
  if (paths.at(-1) === "") paths.pop();
  return paths;
}

function sortPaths(paths) {
  return paths.sort((left, right) => Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8")));
}

async function readStdinJson() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString("utf8");
  const parsed = JSON.parse(text);
  if (!Array.isArray(parsed?.paths) || parsed.paths.some((entry) => typeof entry !== "string")) {
    throw new FarmError("expected-path input must be an object with a string paths array", {
      code: "INVALID_EXPECTED_PATHS",
    });
  }
  return parsed;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const root = path.resolve(String(args.root ?? repoRoot));
  const expected = args["expected-stdin"] ? await readStdinJson() : undefined;
  const identity = args["all-files"] || expected
    ? await createTreeSourceIdentity({ root, expectedPaths: expected?.paths, includeManifest: true })
    : await createLocalSourceIdentity({ root, includeManifest: true });
  if (args.hash) {
    process.stdout.write(`${identity.sourceHash}\n`);
    return;
  }
  if (args.manifest) {
    printJson(identity.manifest, Boolean(args.pretty));
    return;
  }
  const output = {
    schema: identity.schema,
    sourceHash: identity.sourceHash,
    fileCount: identity.fileCount,
    totalBytes: identity.totalBytes,
    provenance: identity.provenance,
  };
  printJson(output, Boolean(args.pretty));
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error) => {
    printJson(errorDocument(SOURCE_IDENTITY_SCHEMA, error), true);
    process.exitCode = 1;
  });
}
