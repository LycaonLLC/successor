#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { probeCapabilities } from "./capabilities.mjs";
import { FarmError, errorDocument, parseArgs, printJson } from "./common.mjs";
import { acquireHostLock, farmHostRoot } from "./host-lock.mjs";
import {
  FARM_RESULT_SCHEMA,
  checksumTree,
  copyArtifactSource,
  readJson,
  safeName,
  sha256Json,
  tail,
  validateResultEnvelope,
  verifyArtifactChecksums,
} from "./protocol.mjs";
import { RESOURCE_CLASSES, RESOURCE_CLASS_LIMITS, resourceClassForTask, taskEligibleOnHost, validatePlan } from "./task-plan.mjs";
import { createTreeSourceIdentity } from "./source-hash.mjs";

export const FARM_WORKER_SCHEMA = "successor.farm-worker.v1";

/**
 * Executes one materialized host plan while holding one checkout lease and one
 * source firewall. Phase 0 is exclusive and completes before phase 1. Phase-1
 * tasks are serialized within their planned slot and slots run concurrently.
 */
export async function executeWorkerPlan({
  plan,
  root = plan?.host?.checkout,
  artifactRoot,
  lockRoot = farmHostRoot(),
  capabilities,
  signal,
  executionAttempt = 0,
  satisfiedDependencies = [],
} = {}) {
  validatePlan(plan);
  if (!Number.isInteger(executionAttempt) || executionAttempt < 0) throw new FarmError("worker execution attempt is invalid", { code: "INVALID_ATTEMPT" });
  if (!Array.isArray(satisfiedDependencies) || satisfiedDependencies.some((id) => typeof id !== "string")) throw new FarmError("satisfied dependencies are invalid", { code: "INVALID_PLAN" });
  const checkout = path.resolve(root);
  if (checkout !== path.resolve(plan.host.checkout)) throw new FarmError("worker checkout does not match plan checkout", { code: "CHECKOUT_MISMATCH" });
  const outputRoot = path.resolve(artifactRoot ?? path.join(os.tmpdir(), "successor-farm-results", safeName(plan.runId), safeName(plan.leaseId), `attempt-${executionAttempt}`));
  const hostCapabilities = capabilities ?? await probeCapabilities({ root: checkout });
  const host = { id: plan.host.id, transport: plan.host.transport, capabilities: hostCapabilities };
  if (plan.tasks.some((task) => !taskEligibleOnHost(task, { ...plan.host, capabilities: hostCapabilities }))) {
    const results = plan.tasks.map((task) => refusedResult({ plan, task, host, executionAttempt, source: {}, code: "HOST_CAPABILITY_MISMATCH", message: "host capabilities do not satisfy the task tags" }));
    return workerDocument(plan, executionAttempt, results, { initial: null, final: null }, outputRoot);
  }
  const lock = await acquireHostLock({ runId: plan.runId, leaseId: plan.leaseId, hostId: plan.host.id, root: lockRoot });
  try {
    const initialSource = await sourceFirewall(checkout, plan);
    if (!initialSource.match) {
      const results = plan.tasks.map((task) => refusedResult({ plan, task, host, executionAttempt, source: initialSource, code: "SOURCE_MISMATCH", message: "checkout hash does not match the task plan" }));
      return workerDocument(plan, executionAttempt, results, { initial: initialSource, final: null }, outputRoot);
    }
    let results = await executePlanPhases({
      plan,
      checkout,
      outputRoot,
      host,
      executionAttempt,
      signal,
      satisfiedDependencies: new Set(satisfiedDependencies),
    });
    const finalSource = await sourceFirewall(checkout, plan);
    if (!finalSource.match) {
      results = results.map((result) => result.status === "pass"
        ? sourceChangedResult({ result, plan, executionAttempt, source: finalSource })
        : result);
    }
    return workerDocument(plan, executionAttempt, results, { initial: initialSource, final: finalSource }, outputRoot);
  } finally {
    await lock.release();
  }
}

async function executePlanPhases({ plan, checkout, outputRoot, host, executionAttempt, signal, satisfiedDependencies }) {
  const results = new Array(plan.tasks.length);
  const completed = new Map();
  const run = async (index) => {
    const task = plan.tasks[index];
    if (signal?.aborted) {
      const result = killedResult({ plan, task, host, executionAttempt, code: "CANCELLED", message: "farm execution was cancelled before task start" });
      results[index] = result;
      completed.set(task.id, result);
      return result;
    }
    const dependencies = Array.isArray(task.dependencies) ? task.dependencies : [];
    const missing = dependencies.filter((id) => !satisfiedDependencies.has(id) && completed.get(id)?.status !== "pass");
    if (missing.length > 0) {
      const result = refusedResult({
        plan,
        task,
        host,
        executionAttempt,
        source: {},
        code: "DEPENDENCY_NOT_PASSED",
        message: "task dependencies did not produce bound passing results",
        details: { dependencies: missing },
      });
      results[index] = result;
      completed.set(task.id, result);
      return result;
    }
    const result = await executeTask({ plan, task, checkout, outputRoot, host, executionAttempt, signal });
    results[index] = result;
    completed.set(task.id, result);
    return result;
  };

  const phase0 = plan.tasks.map((task, index) => ({ task, index })).filter(({ task }) => (task.phase ?? 1) === 0);
  const staticPhase0 = phase0.filter(({ task }) => task.category === "static");
  const buildPhase0 = phase0.filter(({ task }) => task.category !== "static");
  await Promise.all(staticPhase0.map(({ index }) => run(index)));
  if (staticPhase0.some(({ index }) => results[index]?.status !== "pass")) {
    for (const { task, index } of buildPhase0) {
      results[index] = refusedResult({ plan, task, host, executionAttempt, source: {}, code: "DEPENDENCY_NOT_PASSED", message: "phase-0 static checks did not pass", details: { phase: "phase-0-static" } });
      completed.set(task.id, results[index]);
    }
  } else {
    await runResourceQueues(buildPhase0.map(({ index }) => index), plan, run);
  }

  const slotQueues = new Map();
  for (const { task, index } of plan.tasks.map((item, itemIndex) => ({ task: item, index: itemIndex })).filter(({ task }) => (task.phase ?? 1) === 1)) {
    const slot = task.slot ?? 0;
    const queue = slotQueues.get(slot) ?? [];
    queue.push(index);
    slotQueues.set(slot, queue);
  }
  await runPhase1Queues(slotQueues, plan, run, completed, satisfiedDependencies);
  return results;
}

async function runResourceQueues(indices, plan, run) {
  const active = new Map();
  const counts = new Map();
  const pending = [...indices];
  while (pending.length > 0 || active.size > 0) {
    let launched = false;
    for (let cursor = 0; cursor < pending.length;) {
      const index = pending[cursor];
      const resourceClass = resourceClassForTask(plan.tasks[index]);
      if (!canStartResource(resourceClass, counts, active.size)) {
        cursor += 1;
        continue;
      }
      pending.splice(cursor, 1);
      counts.set(resourceClass, (counts.get(resourceClass) ?? 0) + 1);
      const promise = Promise.resolve(run(index)).then(() => index);
      active.set(index, promise);
      promise.finally(() => {
        active.delete(index);
        counts.set(resourceClass, Math.max(0, (counts.get(resourceClass) ?? 1) - 1));
      }).catch(() => {});
      launched = true;
    }
    if (active.size > 0 && (!launched || pending.length > 0)) await Promise.race(active.values());
  }
}

async function runPhase1Queues(slotQueues, plan, run, completed, satisfiedDependencies) {
  const active = new Map();
  const counts = new Map();
  const runningSlots = new Set();
  const pendingSlots = new Set(slotQueues.keys());
  while (pendingSlots.size > 0 || active.size > 0) {
    let launched = false;
    for (const slot of [...pendingSlots].sort((left, right) => left - right)) {
      if (runningSlots.has(slot)) continue;
      const queue = slotQueues.get(slot);
      const index = queue[0];
      const task = plan.tasks[index];
      const deps = Array.isArray(task.dependencies) ? task.dependencies : [];
      if (deps.some((id) => !satisfiedDependencies.has(id) && !completed.has(id))) continue;
      const resourceClass = resourceClassForTask(task);
      if (!canStartResource(resourceClass, counts, active.size)) continue;
      queue.shift();
      if (queue.length === 0) pendingSlots.delete(slot);
      runningSlots.add(slot);
      counts.set(resourceClass, (counts.get(resourceClass) ?? 0) + 1);
      const promise = Promise.resolve(run(index)).then(() => ({ index, slot, resourceClass }));
      active.set(index, promise);
      promise.then(({ slot: finishedSlot, resourceClass: finishedClass }) => {
        runningSlots.delete(finishedSlot);
        counts.set(finishedClass, Math.max(0, (counts.get(finishedClass) ?? 1) - 1));
        active.delete(index);
      }).catch(() => {});
      launched = true;
    }
    if (active.size > 0 && (!launched || pendingSlots.size > 0)) await Promise.race(active.values());
    else if (!launched && active.size === 0 && pendingSlots.size > 0) {
      const [slot] = pendingSlots;
      const index = slotQueues.get(slot)[0];
      await run(index);
      slotQueues.get(slot).shift();
      if (slotQueues.get(slot).length === 0) pendingSlots.delete(slot);
    }
  }
}

function canStartResource(resourceClass, counts, activeCount) {
  // Browser-heavy work owns the same whole-host barrier as realtime/desktop
  // work. Chromium/WebGL contention is cross-class: no browser task may share
  // a phase-one runtime window with headless, backend, realtime, desktop, or
  // another browser task. Phase-zero static/build work remains governed by
  // its separate queues above.
  const browserHeavy = RESOURCE_CLASSES.BROWSER_HEAVY;
  const exclusive = RESOURCE_CLASSES.EXCLUSIVE;
  if (resourceClass === exclusive || resourceClass === browserHeavy) return activeCount === 0;
  if ((counts.get(exclusive) ?? 0) > 0 || (counts.get(browserHeavy) ?? 0) > 0) return false;
  const limit = RESOURCE_CLASS_LIMITS[resourceClass] ?? 1;
  return (counts.get(resourceClass) ?? 0) < limit;
}

async function executeTask({ plan, task, checkout, outputRoot, host, executionAttempt, signal }) {
  const startedAt = new Date().toISOString();
  const started = performance.now();
  const command = await runBoundedCommand(task, signal);
  const durationMs = round(performance.now() - started);
  let status = command.cancelled || command.timedOut ? "killed" : command.ok ? "pass" : "fail";
  let reason = command.cancelled
    ? { code: "CANCELLED", message: "farm execution was cancelled" }
    : command.timedOut
      ? { code: "TASK_DEADLINE_EXCEEDED", message: `task exceeded its ${task.deadlineMs}ms deadline` }
      : command.ok
        ? null
        : { code: "TASK_EXIT_FAILED", message: `task exited ${command.exitCode ?? "without a code"}` };
  const completedAt = new Date().toISOString();
  const taskArtifactRelative = path.posix.join("tasks", safeName(task.id));
  const taskArtifactRoot = path.join(outputRoot, ...taskArtifactRelative.split("/"));
  await writeCommandEvidence({ plan, task, taskArtifactRoot, executionAttempt, startedAt, completedAt, durationMs, command });
  const collected = await collectAndVerifyArtifacts({
    task,
    checkout,
    outputRoot,
    taskArtifactRoot,
    taskArtifactRelative,
    requireDeclared: status === "pass",
  });
  const artifacts = collected.artifacts;
  if (status === "pass" && !collected.ok) {
    status = "fail";
    reason = { code: collected.code, message: collected.message, details: collected.failures };
  }
  const result = {
    schema: FARM_RESULT_SCHEMA,
    runId: plan.runId,
    leaseId: plan.leaseId,
    host,
    sourceHash: plan.source.sourceHash,
    task: { id: task.id, digest: task.digest, lane: task.lane, shard: task.shard },
    executionAttempt,
    status,
    startedAt,
    completedAt,
    durationMs,
    command: {
      started: command.started,
      argv: task.argv,
      cwd: task.cwd,
      exitCode: command.exitCode,
      signal: command.signal,
      timedOut: command.timedOut,
      cancelled: command.cancelled,
      stdout: tail(command.stdout),
      stderr: tail(command.stderr),
      ...(command.error ? { error: { code: command.error.code ?? null, message: command.error.message } } : {}),
    },
    ...(reason ? { reason } : {}),
    artifacts,
    ledgerEntries: [],
  };
  return validateResultEnvelope(result, { plan, executionAttempt });
}

async function sourceFirewall(checkout, plan) {
  try {
    const observed = await createTreeSourceIdentity({ root: checkout, expectedPaths: plan.source.paths, includeManifest: false });
    return { match: observed.sourceHash === plan.source.sourceHash, observedHash: observed.sourceHash };
  } catch (error) {
    return { match: false, observedHash: null, error: { code: error?.code ?? "SOURCE_CHECK_FAILED", message: error instanceof Error ? error.message : String(error) } };
  }
}

function sourceChangedResult({ result, plan, executionAttempt, source }) {
  return validateResultEnvelope({
    ...result,
    status: "refused",
    reason: {
      code: "SOURCE_CHANGED_DURING_EXECUTION",
      message: "checkout source changed before result acceptance",
      ...(source.observedHash ? { observedHash: source.observedHash } : {}),
      ...(source.error ? { sourceError: source.error } : {}),
    },
  }, { plan, executionAttempt });
}

function refusedResult({ plan, task, host, executionAttempt, source, code, message, details }) {
  const result = {
    schema: FARM_RESULT_SCHEMA,
    runId: plan.runId,
    leaseId: plan.leaseId,
    host,
    sourceHash: plan.source.sourceHash,
    task: { id: task.id, digest: task.digest, lane: task.lane, shard: task.shard },
    executionAttempt,
    status: "refused",
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    durationMs: 0,
    reason: { code, message, ...(details ? { details } : {}), ...(source.observedHash ? { observedHash: source.observedHash } : {}), ...(source.error ? { sourceError: source.error } : {}) },
    artifacts: [],
    ledgerEntries: [],
  };
  return validateResultEnvelope(result, { plan, executionAttempt });
}

function killedResult({ plan, task, host, executionAttempt, code, message }) {
  return validateResultEnvelope({
    schema: FARM_RESULT_SCHEMA,
    runId: plan.runId,
    leaseId: plan.leaseId,
    host,
    sourceHash: plan.source.sourceHash,
    task: { id: task.id, digest: task.digest, lane: task.lane, shard: task.shard },
    executionAttempt,
    status: "killed",
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    durationMs: 0,
    reason: { code, message },
    artifacts: [],
    ledgerEntries: [],
  }, { plan, executionAttempt });
}

function workerDocument(plan, executionAttempt, results, source, artifactRoot) {
  const signedResults = results.map((result) => {
    const { checksum: _ignored, ...unsigned } = result;
    return { ...unsigned, checksum: sha256Json(unsigned) };
  });
  const document = {
    schema: FARM_WORKER_SCHEMA,
    runId: plan.runId,
    leaseId: plan.leaseId,
    host: plan.host.id,
    executionAttempt,
    source,
    artifactRoot,
    phase1Concurrency: plan.phase1Concurrency ?? 1,
    status: signedResults.every((result) => result.status === "pass") ? "pass" : signedResults.some((result) => result.status === "killed") ? "killed" : signedResults.some((result) => result.status === "refused") ? "refused" : "fail",
    results: signedResults,
  };
  return { ...document, checksum: sha256Json(document) };
}

async function collectAndVerifyArtifacts({ task, checkout, outputRoot, taskArtifactRoot, taskArtifactRelative, requireDeclared }) {
  const required = [...new Set(task.artifactPaths)];
  const discovered = [...new Set(task.artifactDiscoveryRoots)];
  const missing = [];
  for (const source of required) {
    if (!(await exists(path.join(checkout, ...source.split("/"))))) missing.push(source);
  }
  const requested = minimizeArtifactRoots([...required, ...discovered]);
  for (const source of requested) {
    if (await exists(path.join(checkout, ...source.split("/")))) await copyArtifactSource(checkout, source, taskArtifactRoot);
  }
  const artifacts = await checksumTree(outputRoot, [taskArtifactRelative]);
  const verified = await verifyArtifactChecksums(outputRoot, artifacts);
  if (!verified.ok) return { ok: false, code: "ARTIFACT_CHECKSUM_MISMATCH", message: "collected task artifacts failed checksum verification", failures: verified.failures, artifacts };
  if (requireDeclared && missing.length > 0) return { ok: false, code: "ARTIFACT_MISSING", message: "required task artifacts were not produced", failures: missing.map((source) => ({ path: source })), artifacts };
  return { ok: true, artifacts };
}

async function writeCommandEvidence({ plan, task, taskArtifactRoot, executionAttempt, startedAt, completedAt, durationMs, command }) {
  const commandRoot = path.join(taskArtifactRoot, "command");
  await fs.mkdir(commandRoot, { recursive: true });
  await Promise.all([
    fs.writeFile(path.join(commandRoot, "stdout.log"), command.stdout, "utf8"),
    fs.writeFile(path.join(commandRoot, "stderr.log"), command.stderr, "utf8"),
    fs.writeFile(path.join(commandRoot, "status.json"), `${JSON.stringify({
      schema: "successor.farm-command-evidence.v1",
      runId: plan.runId,
      leaseId: plan.leaseId,
      sourceHash: plan.source.sourceHash,
      executionAttempt,
      task: { id: task.id, digest: task.digest },
      started: command.started,
      startedAt,
      completedAt,
      durationMs,
      exitCode: command.exitCode,
      signal: command.signal,
      timedOut: command.timedOut,
      cancelled: command.cancelled,
      error: command.error ? { code: command.error.code ?? null, message: command.error.message } : null,
    }, null, 2)}\n`, "utf8"),
  ]);
}

function minimizeArtifactRoots(paths) {
  return [...new Set(paths)].sort((left, right) => left.length - right.length || byteCompare(left, right)).filter((candidate, index, ordered) => !ordered.slice(0, index).some((parent) => candidate.startsWith(`${parent}/`) || candidate === parent));
}

function runBoundedCommand(task, signal) {
  if (signal?.aborted) return Promise.resolve({ started: false, ok: false, exitCode: null, signal: null, timedOut: false, cancelled: true, error: null, stdout: "", stderr: "" });
  return new Promise((resolve) => {
    const child = spawn(task.argv[0], task.argv.slice(1), {
      cwd: task.cwd,
      env: { ...process.env, ...task.env },
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let terminationKind = null;
    let spawnError = null;
    let closed = false;
    let forceTimer = null;
    const terminate = (kind) => {
      if (closed || terminationKind) return;
      terminationKind = kind;
      killProcessGroup(child, "SIGTERM");
      forceTimer = setTimeout(() => killProcessGroup(child, "SIGKILL"), task.graceMs);
      forceTimer.unref();
    };
    const timer = setTimeout(() => terminate("timeout"), task.deadlineMs);
    const onAbort = () => terminate("cancel");
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
    child.stdout.on("data", (chunk) => { stdoutBytes = collect(stdout, chunk, stdoutBytes); });
    child.stderr.on("data", (chunk) => { stderrBytes = collect(stderr, chunk, stderrBytes); });
    child.once("error", (error) => { spawnError = error; });
    child.once("close", (exitCode, childSignal) => {
      closed = true;
      clearTimeout(timer);
      clearTimeout(forceTimer);
      signal?.removeEventListener("abort", onAbort);
      resolve({
        started: true,
        ok: exitCode === 0 && !terminationKind && !spawnError,
        exitCode,
        signal: childSignal,
        timedOut: terminationKind === "timeout",
        cancelled: terminationKind === "cancel",
        error: spawnError,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
  });
}

function collect(chunks, chunk, currentBytes, maxBytes = 4 * 1024 * 1024) {
  if (currentBytes >= maxBytes) return currentBytes;
  const accepted = chunk.subarray(0, Math.max(0, maxBytes - currentBytes));
  chunks.push(accepted);
  return currentBytes + accepted.length;
}

function killProcessGroup(child, signal) {
  if (!child.pid) return;
  try {
    process.kill(process.platform === "win32" ? child.pid : -child.pid, signal);
  } catch (error) {
    if (error?.code !== "ESRCH") child.kill(signal);
  }
}

async function exists(candidate) {
  try {
    await fs.lstat(candidate);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function byteCompare(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function round(value) {
  return Math.round(value * 1000) / 1000;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write("usage: worker.mjs --plan PLAN.json [--output-root DIR] [--lock-root DIR] [--attempt N] | --protocol-stdin\n");
    return;
  }
  let protocol;
  if (args["protocol-stdin"]) {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    try {
      protocol = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch (cause) {
      throw new FarmError("worker protocol stdin is not valid JSON", { code: "INVALID_WORKER_PROTOCOL", cause });
    }
    if (!protocol || typeof protocol !== "object" || !protocol.plan || !Number.isInteger(protocol.executionAttempt) || typeof protocol.artifactRoot !== "string" || Object.keys(protocol).some((key) => !["plan", "executionAttempt", "artifactRoot"].includes(key))) {
      throw new FarmError("worker protocol stdin has an invalid shape", { code: "INVALID_WORKER_PROTOCOL" });
    }
  } else if (!args.plan) {
    throw new FarmError("usage: worker.mjs --plan PLAN.json [--output-root DIR] [--lock-root DIR]", { code: "USAGE" });
  }
  const plan = protocol ? protocol.plan : await readJson(path.resolve(args.plan));
  const result = await executeWorkerPlan({
    plan,
    ...(protocol ? { root: plan.host.checkout, artifactRoot: protocol.artifactRoot, executionAttempt: protocol.executionAttempt } : {}),
    ...(!protocol && args.root ? { root: path.resolve(args.root) } : {}),
    ...(!protocol && args["output-root"] ? { artifactRoot: path.resolve(args["output-root"]) } : {}),
    ...(!protocol && args["lock-root"] ? { lockRoot: path.resolve(args["lock-root"]) } : {}),
    ...(!protocol && args.attempt === undefined ? {} : !protocol ? { executionAttempt: Number(args.attempt) } : {}),
  });
  printJson(result, Boolean(args.pretty));
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error) => {
    printJson(errorDocument(FARM_WORKER_SCHEMA, error), true);
    process.exitCode = 1;
  });
}
