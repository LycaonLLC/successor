import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";

import { createTreeSourceIdentity } from "../farm/source-hash.mjs";

export const HEADLESS_PREP_SCHEMA = "successor.player-load-headless-prep.v1";
const STDERR_TAIL_BYTES = 8 * 1024;
const DEFAULT_TERM_GRACE_MS = 2_000;
const DEFAULT_KILL_GRACE_MS = 2_000;
const repoRoot = path.resolve(import.meta.dirname, "..", "..", "..");

function inheritsProcessHostGroup() {
  return process.platform !== "win32" && process.env.SUCCESSOR_PROCESS_HOST === "child";
}

export async function prepareHeadlessCli({ root = repoRoot, sourceHash, sourcePaths, runProcess = defaultRunProcess } = {}) {
  if (!/^[a-f0-9]{64}$/u.test(sourceHash ?? "") || !Array.isArray(sourcePaths) || sourcePaths.length === 0) {
    return { schema: HEADLESS_PREP_SCHEMA, status: "fail", phase: "source", error: { code: "INVALID_SOURCE_BINDING" } };
  }
  const cliPath = path.join(root, "client", "dist", "headless", "cli.js");
  const sourceMarkerPath = path.join(root, "client", "dist", "headless", ".successor-source-hash");
  const vitePath = path.join(root, "client", "node_modules", ".bin", "vite");
  const lockMarkerPath = path.join(root, "client", "node_modules", ".successor-lock-hash");
  const lockHash = await lockfileHash(root);
  if (!lockHash) return { schema: HEADLESS_PREP_SCHEMA, status: "fail", phase: "install", error: { code: "LOCKFILE_MISSING" } };
  const before = await createTreeSourceIdentity({ root, expectedPaths: sourcePaths, includeManifest: false });
  if (before.sourceHash !== sourceHash) return sourceMismatch("before", before.sourceHash, sourceHash);
  let installed = false;
  if (!(await regularFileExists(vitePath)) || await readMarker(lockMarkerPath) !== lockHash) {
    installed = true;
    const install = await runProcess("pnpm", ["--dir", "client", "install", "--frozen-lockfile"], { cwd: root, timeoutMs: 15 * 60_000 });
    if (!install.ok) return { schema: HEADLESS_PREP_SCHEMA, status: "fail", phase: "install", error: { code: "DEPENDENCY_INSTALL_FAILED", reason: processReason(install), stderr: redactedStderr(install.stderr) }, source: { beforeHash: before.sourceHash, expectedHash: sourceHash } };
    if (!(await regularFileExists(vitePath))) return { schema: HEADLESS_PREP_SCHEMA, status: "fail", phase: "verify", error: { code: "VITE_MISSING_AFTER_INSTALL" }, source: { beforeHash: before.sourceHash, expectedHash: sourceHash } };
    await fs.writeFile(lockMarkerPath, `${lockHash}\n`, "utf8");
  }
  const artifactHash = await fileHash(cliPath);
  const toolchain = await headlessToolchain(vitePath);
  const cached = await readBuildMarker(sourceMarkerPath);
  let built = false;
  if (!isCurrentBuildMarker(cached, { sourceHash, artifactHash, toolchain })) {
    built = true;
    const build = await runProcess("pnpm", ["--dir", "client", "build:headless"], { cwd: root, timeoutMs: 15 * 60_000 });
    if (!build.ok) return { schema: HEADLESS_PREP_SCHEMA, status: "fail", phase: "build", error: { code: "HEADLESS_BUILD_FAILED", reason: processReason(build), stderr: redactedStderr(build.stderr) }, source: { beforeHash: before.sourceHash, expectedHash: sourceHash } };
    const builtArtifactHash = await fileHash(cliPath);
    if (!builtArtifactHash) return { schema: HEADLESS_PREP_SCHEMA, status: "fail", phase: "verify", error: { code: "HEADLESS_CLI_MISSING" }, source: { beforeHash: before.sourceHash, expectedHash: sourceHash } };
    const builtToolchain = await headlessToolchain(vitePath);
    await fs.writeFile(sourceMarkerPath, `${JSON.stringify({ sourceHash, artifactHash: builtArtifactHash, toolchain: builtToolchain })}\n`, "utf8");
  }
  const after = await createTreeSourceIdentity({ root, expectedPaths: sourcePaths, includeManifest: false });
  if (after.sourceHash !== sourceHash) return sourceMismatch("after", after.sourceHash, sourceHash);
  const verifiedArtifactHash = await fileHash(cliPath);
  const verifiedToolchain = await headlessToolchain(vitePath);
  if (!verifiedArtifactHash || !isCurrentBuildMarker(await readBuildMarker(sourceMarkerPath), { sourceHash, artifactHash: verifiedArtifactHash, toolchain: verifiedToolchain })) {
    return { schema: HEADLESS_PREP_SCHEMA, status: "fail", phase: "verify", error: { code: "HEADLESS_BUILD_BINDING_MISMATCH" }, source: { beforeHash: before.sourceHash, expectedHash: sourceHash } };
  }
  return { schema: HEADLESS_PREP_SCHEMA, status: "pass", installed, built, cliPath: "client/dist/headless/cli.js", artifact: { hash: verifiedArtifactHash, toolchain: verifiedToolchain }, source: { beforeHash: before.sourceHash, afterHash: after.sourceHash, expectedHash: sourceHash, match: true } };
}

function sourceMismatch(phase, observedHash, expectedHash) {
  return { schema: HEADLESS_PREP_SCHEMA, status: "fail", phase: "source", error: { code: "SOURCE_MISMATCH" }, source: { phase, observedHash, expectedHash, match: false } };
}

async function regularFileExists(target) {
  try {
    return (await fs.stat(target)).isFile();
  } catch {
    return false;
  }
}

async function readMarker(target) {
  try {
    return (await fs.readFile(target, "utf8")).trim();
  } catch {
    return null;
  }
}

async function readBuildMarker(target) {
  const value = await readMarker(target);
  if (!value) return null;
  try {
    const marker = JSON.parse(value);
    return marker && typeof marker === "object" ? marker : null;
  } catch {
    return null;
  }
}

async function fileHash(target) {
  try {
    return createHash("sha256").update(await fs.readFile(target)).digest("hex");
  } catch {
    return null;
  }
}

async function headlessToolchain(vitePath) {
  return {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    viteHash: await fileHash(vitePath),
  };
}

function isCurrentBuildMarker(marker, expected) {
  return marker?.sourceHash === expected.sourceHash &&
    marker.artifactHash === expected.artifactHash &&
    marker.artifactHash !== null &&
    marker.toolchain?.node === expected.toolchain.node &&
    marker.toolchain?.platform === expected.toolchain.platform &&
    marker.toolchain?.arch === expected.toolchain.arch &&
    marker.toolchain?.viteHash === expected.toolchain.viteHash &&
    marker.toolchain.viteHash !== null;
}

async function lockfileHash(root) {
  try {
    const lockfile = await fs.readFile(path.join(root, "pnpm-lock.yaml"));
    return createHash("sha256").update(lockfile).digest("hex");
  } catch {
    return null;
  }
}

export function defaultRunProcess(command, argv, { cwd, timeoutMs, termGraceMs = DEFAULT_TERM_GRACE_MS, killGraceMs = DEFAULT_KILL_GRACE_MS } = {}) {
  return new Promise((resolve) => {
    const stderr = Buffer.alloc(STDERR_TAIL_BYTES);
    let stderrBytes = 0;
    let timedOut = false;
    let escalated = false;
    let settled = false;
    let closing = false;
    let closeResult = null;
    let child;
    let timeout = null;
    const appendStderr = (chunk) => {
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (value.length >= STDERR_TAIL_BYTES) {
        value.copy(stderr, 0, value.length - STDERR_TAIL_BYTES);
        stderrBytes = STDERR_TAIL_BYTES;
        return;
      }
      if (stderrBytes + value.length <= STDERR_TAIL_BYTES) {
        value.copy(stderr, stderrBytes);
        stderrBytes += value.length;
        return;
      }
      const discarded = stderrBytes + value.length - STDERR_TAIL_BYTES;
      stderr.copyWithin(0, discarded, stderrBytes);
      value.copy(stderr, stderrBytes - discarded);
      stderrBytes = STDERR_TAIL_BYTES;
    };
    const finish = ({ exitCode = closeResult?.exitCode ?? null, signal = closeResult?.signal ?? null, error = null, groupClean = false } = {}) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      resolve({
        ok: exitCode === 0 && !timedOut && !error && groupClean,
        exitCode,
        signal,
        timedOut,
        escalated,
        groupClean,
        error,
        stderr: redactedStderr(stderr.subarray(0, stderrBytes).toString("utf8")),
      });
    };
    const ownsProcessGroup = process.platform !== "win32" && !inheritsProcessHostGroup();
    try {
      child = spawn(command, argv, { cwd, detached: ownsProcessGroup, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      finish({ error });
      return;
    }
    const groupId = child.pid;
    const groupExists = () => {
      if (!ownsProcessGroup) return false;
      try {
        process.kill(-groupId, 0);
        return true;
      } catch (error) {
        return error?.code !== "ESRCH";
      }
    };
    const processExited = () => ownsProcessGroup ? !groupExists() : closeResult !== null;
    const signalProcess = (signal) => {
      if (!ownsProcessGroup) {
        try {
          child.kill(signal);
        } catch (error) {
          if (error?.code !== "ESRCH") return error;
        }
        return null;
      }
      try {
        process.kill(-groupId, signal);
      } catch (error) {
        if (error?.code !== "ESRCH") return error;
      }
      return null;
    };
    const waitForProcessExit = (durationMs) => new Promise((resolveExit) => {
      const deadline = Date.now() + durationMs;
      const check = () => {
        if (processExited()) return resolveExit(true);
        if (Date.now() >= deadline) return resolveExit(false);
        setTimeout(check, 25);
      };
      check();
    });
    const finishAfterProcessExit = async () => {
      if (processExited()) {
        finish({ groupClean: true });
        return;
      }
      const termError = signalProcess("SIGTERM");
      if (termError) {
        finish({ error: termError });
        return;
      }
      if (await waitForProcessExit(termGraceMs)) {
        finish({ groupClean: true });
        return;
      }
      escalated = true;
      const killError = signalProcess("SIGKILL");
      if (killError) {
        finish({ error: killError });
        return;
      }
      if (await waitForProcessExit(killGraceMs)) {
        finish({ groupClean: true });
        return;
      }
      const error = Object.assign(
        new Error(ownsProcessGroup ? "process group survived TERM and KILL" : "direct child survived TERM and KILL"),
        { code: ownsProcessGroup ? "PROCESS_GROUP_SURVIVED" : "DIRECT_CHILD_SURVIVED" },
      );
      finish({ error, groupClean: false });
    };
    timeout = setTimeout(() => {
      timedOut = true;
      if (closing || settled) return;
      closing = true;
      void finishAfterProcessExit();
    }, timeoutMs);
    child.stdout.on("data", () => {});
    child.stderr.on("data", appendStderr);
    child.once("close", (exitCode, signal) => {
      closeResult = { exitCode, signal };
      if (closing || settled) return;
      closing = true;
      void finishAfterProcessExit();
    });
    child.once("error", (error) => {
      if (closing || settled) return;
      closing = true;
      finish({ error });
    });
  });
}

function redactedStderr(value) {
  return String(value ?? "").slice(-STDERR_TAIL_BYTES).replace(/(token|password|secret)=\S+/giu, "$1=[redacted]");
}

function processReason(result) {
  if (result.error) return result.error.code ?? "spawn-error";
  if (result.timedOut) return "timeout";
  return `exit-${result.exitCode}${result.signal ? `-${result.signal}` : ""}`;
}

async function main() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const document = await prepareHeadlessCli(JSON.parse(Buffer.concat(chunks).toString("utf8")));
  process.stdout.write(`${JSON.stringify(document)}\n`);
  process.exitCode = document.status === "pass" ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    process.stdout.write(`${JSON.stringify({ schema: HEADLESS_PREP_SCHEMA, status: "fail", phase: "source", error: { code: "INVALID_PREP_REQUEST" } })}\n`);
    process.exitCode = 1;
  });
}
