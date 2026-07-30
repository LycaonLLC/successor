#!/usr/bin/env node
import { lstat, readdir, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { FarmError, errorDocument, parseArgs, printJson, processFailure, repoRoot, runProcess } from "./common.mjs";
import {
  SOURCE_IDENTITY_SCHEMA,
  SourceChangedError,
  createLocalSourceIdentity,
  validateRelativeSourcePath,
} from "./source-hash.mjs";

export const SYNC_RESULT_SCHEMA = "successor.farm-sync.v1";
const REMOTE_ACCOUNT = process.env.SUCCESSOR_FARM_REMOTE_ACCOUNT ?? "michaelkelly";
if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(REMOTE_ACCOUNT)) {
  throw new Error("SUCCESSOR_FARM_REMOTE_ACCOUNT must be one safe macOS account name");
}
export const REMOTE_HOME = path.posix.join("/Users", REMOTE_ACCOUNT);
export const REMOTE_FARM_ROOT = `${REMOTE_HOME}/successor-farm`;
export const REMOTE_CHECKOUT = `${REMOTE_FARM_ROOT}/checkout`;
export const DEFAULT_HOSTS = ["macbook", "macbook-codex"];
const SSH_OPTIONS = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=8"];
const MAX_SYNC_ATTEMPTS = 3;
const EXACT_PRESERVED_CACHE_ROOTS = new Set([
  "target",
  ".pnpm-store",
  "desktop/release",
  "verification/.runs",
]);

export class SourceMismatchError extends FarmError {
  constructor(localHash, remoteHash, { host } = {}) {
    super("remote source hash does not match the synchronized local source hash", {
      code: "SOURCE_MISMATCH",
      details: { localHash, remoteHash, host: host ?? null },
    });
    this.localHash = localHash;
    this.remoteHash = remoteHash;
    this.host = host ?? null;
  }
}

export async function resolveFarmHost({ host, candidates = DEFAULT_HOSTS } = {}) {
  const choices = host ? [host] : candidates;
  const failures = [];
  for (const candidate of choices) {
    validateHost(candidate);
    const result = await runProcess("ssh", [...SSH_OPTIONS, candidate, "true"], { timeoutMs: 12_000 });
    if (result.ok) return candidate;
    failures.push({ host: candidate, reason: processReason(result) });
  }
  throw new FarmError("no configured Mac farm SSH alias is reachable", {
    code: "FARM_HOST_UNREACHABLE",
    details: { attempts: failures },
  });
}

export async function syncToFarm({
  root = repoRoot,
  host,
  maxAttempts = MAX_SYNC_ATTEMPTS,
} = {}) {
  const absoluteRoot = path.resolve(root);
  const selectedHost = await resolveFarmHost({ host });
  await ensureRemoteCheckout(selectedHost);
  const attempts = [];

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let before;
    try {
      before = await createLocalSourceIdentity({ root: absoluteRoot, includeManifest: true });
    } catch (error) {
      if (error instanceof SourceChangedError) {
        attempts.push({ attempt, status: "source-raced-before-transfer" });
        if (attempt < maxAttempts) continue;
        throw sourceRaceError(attempts);
      }
      throw error;
    }
    const paths = before.manifest.entries.map((entry) => entry.path);
    const transfer = await transferSourceList(selectedHost, absoluteRoot, paths);
    if (transfer.ok) {
      await runRemoteReconcile(selectedHost, paths);
    }

    let after;
    try {
      after = await createLocalSourceIdentity({ root: absoluteRoot, includeManifest: true });
    } catch (error) {
      if (error instanceof SourceChangedError) {
        attempts.push({ attempt, status: "source-raced-after-transfer" });
        if (attempt < maxAttempts) continue;
        throw sourceRaceError(attempts);
      }
      throw error;
    }
    if (before.sourceHash !== after.sourceHash) {
      attempts.push({ attempt, status: "source-changed-during-transfer" });
      if (attempt < maxAttempts) continue;
      throw new FarmError("local source did not remain stable during the bounded sync attempts", {
        code: "SOURCE_SYNC_RACE",
        details: { attempts },
      });
    }
    if (!transfer.ok) throw processFailure(transfer, "rsync source transfer");

    const remote = await recomputeRemoteSourceIdentity({
      host: selectedHost,
      expectedPaths: paths,
    });
    let finalLocal;
    try {
      finalLocal = await createLocalSourceIdentity({ root: absoluteRoot, includeManifest: true });
    } catch (error) {
      if (error instanceof SourceChangedError) {
        attempts.push({ attempt, status: "source-raced-during-remote-verification" });
        if (attempt < maxAttempts) continue;
        throw sourceRaceError(attempts);
      }
      throw error;
    }
    if (finalLocal.sourceHash !== after.sourceHash) {
      attempts.push({ attempt, status: "source-changed-during-remote-verification" });
      if (attempt < maxAttempts) continue;
      throw new FarmError("local source changed before remote parity could be accepted", {
        code: "SOURCE_SYNC_RACE",
        details: { attempts },
      });
    }
    if (remote.sourceHash !== finalLocal.sourceHash) {
      throw new SourceMismatchError(finalLocal.sourceHash, remote.sourceHash, { host: selectedHost });
    }
    attempts.push({ attempt, status: "synchronized" });
    return {
      schema: SYNC_RESULT_SCHEMA,
      status: "synchronized",
      host: selectedHost,
      checkout: REMOTE_CHECKOUT,
      sourceHash: finalLocal.sourceHash,
      remoteSourceHash: remote.sourceHash,
      fileCount: finalLocal.fileCount,
      totalBytes: finalLocal.totalBytes,
      provenance: finalLocal.provenance,
      attempts,
      identity: finalLocal,
    };
  }
  throw new FarmError("source sync attempts were exhausted", { code: "SOURCE_SYNC_RACE", details: { attempts } });
}

function sourceRaceError(attempts) {
  return new FarmError("local source did not remain stable during the bounded sync attempts", {
    code: "SOURCE_SYNC_RACE",
    details: { attempts },
  });
}

export async function compareRemoteSource({
  root = repoRoot,
  host,
  maxAttempts = MAX_SYNC_ATTEMPTS,
} = {}) {
  const selectedHost = await resolveFarmHost({ host });
  const attempts = [];
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let local;
    try {
      local = await createLocalSourceIdentity({ root, includeManifest: true });
    } catch (error) {
      if (error instanceof SourceChangedError) {
        attempts.push({ attempt, status: "source-raced-before-comparison" });
        if (attempt < maxAttempts) continue;
        break;
      }
      throw error;
    }
    const expectedPaths = local.manifest.entries.map((entry) => entry.path);
    const remote = await recomputeRemoteSourceIdentity({ host: selectedHost, expectedPaths });
    let finalLocal;
    try {
      finalLocal = await createLocalSourceIdentity({ root, includeManifest: true });
    } catch (error) {
      if (error instanceof SourceChangedError) {
        attempts.push({ attempt, status: "source-raced-during-comparison" });
        if (attempt < maxAttempts) continue;
        break;
      }
      throw error;
    }
    if (finalLocal.sourceHash !== local.sourceHash) {
      attempts.push({ attempt, status: "source-changed-during-comparison" });
      if (attempt < maxAttempts) continue;
      break;
    }
    if (finalLocal.sourceHash !== remote.sourceHash) {
      throw new SourceMismatchError(finalLocal.sourceHash, remote.sourceHash, { host: selectedHost });
    }
    attempts.push({ attempt, status: "matched" });
    return {
      schema: SYNC_RESULT_SCHEMA,
      status: "matched",
      host: selectedHost,
      checkout: REMOTE_CHECKOUT,
      sourceHash: finalLocal.sourceHash,
      remoteSourceHash: remote.sourceHash,
      fileCount: finalLocal.fileCount,
      totalBytes: finalLocal.totalBytes,
      provenance: finalLocal.provenance,
      attempts,
      identity: finalLocal,
    };
  }
  throw new FarmError("local source did not remain stable during the bounded remote comparison attempts", {
    code: "SOURCE_COMPARISON_RACE",
    details: { attempts },
  });
}

export async function recomputeRemoteSourceIdentity({ host, expectedPaths }) {
  validateHost(host);
  for (const sourcePath of expectedPaths) validateRelativeSourcePath(sourcePath);
  const modulePath = `${REMOTE_CHECKOUT}/tools/verification/farm/source-hash.mjs`;
  const input = JSON.stringify({ paths: expectedPaths });
  const result = await runProcess(
    "ssh",
    [
      ...SSH_OPTIONS,
      host,
      "node",
      modulePath,
      "--root",
      REMOTE_CHECKOUT,
      "--expected-stdin",
    ],
    { input, timeoutMs: 10 * 60_000, maxOutputBytes: 4 * 1024 * 1024 },
  );
  if (!result.ok) throw processFailure(result, "remote source hash recomputation");
  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch (cause) {
    throw new FarmError("remote source hash did not emit valid JSON", {
      code: "INVALID_REMOTE_SOURCE_DOCUMENT",
      cause,
    });
  }
  if (parsed?.schema !== SOURCE_IDENTITY_SCHEMA || !/^[a-f0-9]{64}$/u.test(parsed?.sourceHash ?? "")) {
    throw new FarmError("remote source hash emitted an invalid identity document", {
      code: "INVALID_REMOTE_SOURCE_DOCUMENT",
    });
  }
  return parsed;
}

async function transferSourceList(host, root, sourcePaths) {
  const fileList = Buffer.from(`${sourcePaths.join("\0")}${sourcePaths.length ? "\0" : ""}`, "utf8");
  return runProcess(
    "rsync",
    [
      "--archive",
      "--checksum",
      "--from0",
      "--files-from=-",
      "-e",
      "ssh -o BatchMode=yes -o ConnectTimeout=8",
      "./",
      `${host}:${REMOTE_CHECKOUT}/`,
    ],
    { cwd: root, input: fileList, timeoutMs: 30 * 60_000, maxOutputBytes: 2 * 1024 * 1024 },
  );
}

async function runRemoteReconcile(host, sourcePaths) {
  const modulePath = `${REMOTE_CHECKOUT}/tools/verification/farm/sync.mjs`;
  const result = await runProcess(
    "ssh",
    [...SSH_OPTIONS, host, "node", modulePath, "reconcile", "--allowlist-stdin"],
    {
      input: JSON.stringify({ paths: sourcePaths }),
      timeoutMs: 10 * 60_000,
      maxOutputBytes: 2 * 1024 * 1024,
    },
  );
  if (!result.ok) throw processFailure(result, "remote checkout reconciliation");
  let document;
  try {
    document = JSON.parse(result.stdout);
  } catch (cause) {
    throw new FarmError("remote reconciliation did not emit valid JSON", {
      code: "INVALID_RECONCILE_DOCUMENT",
      cause,
    });
  }
  if (document?.schema !== SYNC_RESULT_SCHEMA || document.status !== "reconciled") {
    throw new FarmError("remote reconciliation refused the checkout", { code: "REMOTE_RECONCILE_REFUSED" });
  }
  return document;
}

export async function reconcileCheckout({
  root = path.join(os.homedir(), "successor-farm", "checkout"),
  allowedPaths,
} = {}) {
  const absoluteRoot = path.resolve(root);
  const absoluteRequiredRoot = path.resolve(os.homedir(), "successor-farm", "checkout");
  if (absoluteRoot !== absoluteRequiredRoot) {
    throw new FarmError("checkout reconciliation is confined to the fixed farm checkout", {
      code: "UNSAFE_RECONCILE_ROOT",
    });
  }
  const rootStats = await lstat(absoluteRoot);
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
    throw new FarmError("farm checkout root is not a real directory", { code: "UNSAFE_RECONCILE_ROOT" });
  }
  const canonicalRoot = await realpath(absoluteRoot);
  if (canonicalRoot !== absoluteRequiredRoot) {
    throw new FarmError("farm checkout resolves outside the fixed farm root", { code: "UNSAFE_RECONCILE_ROOT" });
  }
  if (!Array.isArray(allowedPaths)) {
    throw new FarmError("checkout reconciliation requires an explicit source allowlist", {
      code: "INVALID_ALLOWLIST",
    });
  }

  const allowed = new Set(allowedPaths);
  const allowedDirectories = new Set();
  const packageRoots = new Set([""]);
  for (const sourcePath of allowed) {
    validateRelativeSourcePath(sourcePath);
    if (sourcePath === "package.json") packageRoots.add("");
    if (sourcePath.endsWith("/package.json")) packageRoots.add(path.posix.dirname(sourcePath));
    const segments = sourcePath.split("/");
    for (let index = 1; index < segments.length; index += 1) {
      allowedDirectories.add(segments.slice(0, index).join("/"));
    }
  }
  for (const cacheRoot of EXACT_PRESERVED_CACHE_ROOTS) {
    const segments = cacheRoot.split("/");
    for (let index = 1; index < segments.length; index += 1) {
      allowedDirectories.add(segments.slice(0, index).join("/"));
    }
  }
  let removedEntries = 0;
  let preservedCacheRoots = 0;

  async function reconcileDirectory(relativeDirectory) {
    const absoluteDirectory = relativeDirectory
      ? path.join(absoluteRoot, ...relativeDirectory.split("/"))
      : absoluteRoot;
    const entries = await readdir(absoluteDirectory, { withFileTypes: true });
    for (const entry of entries) {
      const sourcePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      if (!relativeDirectory && entry.name === ".git") continue;
      const absolutePath = path.join(absoluteRoot, ...sourcePath.split("/"));
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        if (isPreservedCacheDirectory(sourcePath, packageRoots)) {
          preservedCacheRoots += 1;
          continue;
        }
        if (!allowedDirectories.has(sourcePath)) {
          await rm(absolutePath, { recursive: true, force: true });
          removedEntries += 1;
          continue;
        }
        await reconcileDirectory(sourcePath);
        continue;
      }
      if (!allowed.has(sourcePath)) {
        await rm(absolutePath, { recursive: true, force: true });
        removedEntries += 1;
      }
    }
  }
  await reconcileDirectory("");
  return { removedEntries, preservedCacheRoots, allowedEntries: allowed.size };
}

export function isPreservedCacheDirectory(sourcePath, packageRoots = new Set([""])) {
  const segments = sourcePath.split("/");
  const base = segments.at(-1);
  // Preserve only the cache root itself. Its source-bearing parents must still
  // be traversed so stale non-cache files cannot survive reconciliation.
  if (EXACT_PRESERVED_CACHE_ROOTS.has(sourcePath)) return true;
  if (segments.includes("node_modules")) return true;
  if (base === ".cache" || base === ".vite") return true;
  const parent = path.posix.dirname(sourcePath);
  if (base === "dist" && packageRoots.has(parent === "." ? "" : parent)) return true;
  return false;
}

async function ensureRemoteCheckout(host) {
  const farmExists = await remoteTest(host, "-e", REMOTE_FARM_ROOT);
  if (farmExists) {
    if (await remoteTest(host, "-L", REMOTE_FARM_ROOT)) {
      throw new FarmError("remote farm root must not be a symlink", { code: "UNSAFE_REMOTE_ROOT" });
    }
    if (!(await remoteTest(host, "-d", REMOTE_FARM_ROOT))) {
      throw new FarmError("remote farm root is not a directory", { code: "UNSAFE_REMOTE_ROOT" });
    }
  } else {
    const createFarm = await runSsh(host, ["mkdir", REMOTE_FARM_ROOT]);
    if (!createFarm.ok) throw processFailure(createFarm, "remote farm-root creation");
  }

  const checkoutExists = await remoteTest(host, "-e", REMOTE_CHECKOUT);
  if (checkoutExists) {
    if (await remoteTest(host, "-L", REMOTE_CHECKOUT)) {
      throw new FarmError("remote checkout must not be a symlink", { code: "UNSAFE_REMOTE_ROOT" });
    }
    if (!(await remoteTest(host, "-d", REMOTE_CHECKOUT))) {
      throw new FarmError("remote checkout is not a directory", { code: "UNSAFE_REMOTE_ROOT" });
    }
  } else {
    const createCheckout = await runSsh(host, ["mkdir", REMOTE_CHECKOUT]);
    if (!createCheckout.ok) throw processFailure(createCheckout, "remote checkout creation");
  }

  const canonical = await runSsh(host, ["realpath", REMOTE_CHECKOUT]);
  if (!canonical.ok) throw processFailure(canonical, "remote checkout canonical-path check");
  if (canonical.stdout.trim() !== REMOTE_CHECKOUT) {
    throw new FarmError("remote checkout resolves outside the fixed farm path", { code: "UNSAFE_REMOTE_ROOT" });
  }
}

async function remoteTest(host, operator, remotePath) {
  const result = await runSsh(host, ["test", operator, remotePath]);
  if (result.exitCode === 0) return true;
  if (result.exitCode === 1 && !result.error && !result.timedOut && !result.overflow) return false;
  throw processFailure(result, "remote path safety check");
}

function runSsh(host, remoteArgv, options = {}) {
  return runProcess("ssh", [...SSH_OPTIONS, host, ...remoteArgv], { timeoutMs: 30_000, ...options });
}

function validateHost(host) {
  if (typeof host !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/u.test(host)) {
    throw new FarmError("invalid SSH host alias", { code: "INVALID_FARM_HOST" });
  }
}

function processReason(result) {
  if (result.error) return result.error.code ?? "spawn-error";
  if (result.timedOut) return "timeout";
  if (result.overflow) return "output-limit";
  return `exit-${result.exitCode}${result.signal ? `-${result.signal}` : ""}`;
}

async function readAllowlistStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!Array.isArray(parsed?.paths) || parsed.paths.some((entry) => typeof entry !== "string")) {
    throw new FarmError("reconcile input requires a string paths array", { code: "INVALID_ALLOWLIST" });
  }
  return parsed.paths;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0] ?? "sync";
  if (command === "reconcile") {
    if (!args["allowlist-stdin"]) {
      throw new FarmError("reconcile is an internal command requiring --allowlist-stdin", {
        code: "INVALID_RECONCILE_INVOCATION",
      });
    }
    const allowedPaths = await readAllowlistStdin();
    const result = await reconcileCheckout({ allowedPaths });
    printJson({ schema: SYNC_RESULT_SCHEMA, status: "reconciled", checkout: REMOTE_CHECKOUT, ...result });
    return;
  }
  const options = {
    root: args.root ?? repoRoot,
    host: args.host,
    maxAttempts: Number(args.attempts ?? MAX_SYNC_ATTEMPTS),
  };
  const result = command === "compare"
    ? await compareRemoteSource(options)
    : await syncToFarm(options);
  const publicResult = { ...result };
  delete publicResult.identity;
  printJson(publicResult, Boolean(args.pretty));
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error) => {
    printJson(errorDocument(SYNC_RESULT_SCHEMA, error), true);
    process.exitCode = error?.code === "SOURCE_MISMATCH" ? 2 : 1;
  });
}
