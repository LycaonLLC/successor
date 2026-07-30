#!/usr/bin/env node
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { probeCapabilities } from "./capabilities.mjs";
import { FarmError, errorDocument, parseArgs, printJson, repoRoot } from "./common.mjs";
import { safeName, sha256Json, readJson, validateResultEnvelope, verifyArtifactChecksums, writeJsonAtomic } from "./protocol.mjs";
import { buildVerifyMatrix } from "./matrix-report.mjs";
import {
  buildTaskGraph,
  createWorkerPlan,
  filterTasks,
  loadTimingHistory,
  rematerializePlanForAttempt,
  scheduleTasksLpt,
  updatedTimingHistory,
  validatePlan,
} from "./task-plan.mjs";
import { createLocalSourceIdentity } from "./source-hash.mjs";
import { executeWorkerPlan, FARM_WORKER_SCHEMA } from "./worker.mjs";
import { executeRemoteWorkerPlan } from "./remote-executor.mjs";
import { runMacPreflight } from "./preflight.mjs";
import { REMOTE_CHECKOUT } from "./sync.mjs";

export const FARM_DISPATCH_SCHEMA = "successor.farm-dispatch.v1";

export async function planFarmRun({
  root = repoRoot,
  runId = `farm-${Date.now()}`,
  lanes,
  only,
  hosts,
  timings,
  timingPath = path.join(root, "tools", "verification", "farm", "farm-timings.json"),
  remoteHost,
  remotePreflight = runMacPreflight,
  source,
  deterministic = false,
} = {}) {
  const checkout = path.resolve(root);
  const resolvedSource = source ?? await createLocalSourceIdentity({ root: checkout, includeManifest: true });
  const resolvedTimings = timings ?? await loadTimingHistory(timingPath);
  const remote = remoteHost ? await macHost({ root: checkout, host: remoteHost, sourceHash: resolvedSource.sourceHash, preflight: remotePreflight }) : null;
  const resolvedHosts = hosts ?? [await localHost(checkout), ...(remote ? [remote] : [])];
  const tasks = filterTasks(await buildTaskGraph({ root: checkout, ...(lanes === undefined ? {} : { lanes }) }), only);
  const assignments = scheduleTasksLpt({ tasks, hosts: resolvedHosts, timings: resolvedTimings });
  const plans = assignments.filter((assignment) => assignment.tasks.length > 0).map((assignment) => createWorkerPlan({ runId, hostAssignment: assignment, source: { sourceHash: resolvedSource.sourceHash, paths: resolvedSource.manifest?.entries.map((entry) => entry.path) ?? resolvedSource.paths }, deterministic }));
  return {
    schema: FARM_DISPATCH_SCHEMA,
    kind: "plan",
    runId,
    source: { sourceHash: resolvedSource.sourceHash, paths: resolvedSource.manifest?.entries.map((entry) => entry.path) ?? resolvedSource.paths },
    timings: resolvedTimings,
    plans,
  };
}

/**
 * Dispatches local plans through the worker. Remote plans are intentionally
 * refused here: their source must first be synchronized and accepted by the
 * preflight contract, rather than allowing dispatch to mutate a remote host.
 */
export async function dispatchFarmRun({
  plans,
  root = repoRoot,
  artifactRoot = path.join(os.tmpdir(), "successor-farm-dispatch"),
  lockRoot,
  maxAttempts = 2,
  workerRunner = executeWorkerPlan,
  remoteWorkerRunner = executeRemoteWorkerPlan,
  remotePreflight = runMacPreflight,
  signal,
  timingPath,
  timings,
  selection,
  matrixPath,
} = {}) {
  if (!Array.isArray(plans) || plans.length === 0) throw new FarmError("dispatcher requires at least one worker plan", { code: "NO_PLANS" });
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 2) throw new FarmError("farm maxAttempts must be 1 or 2", { code: "INVALID_ATTEMPT" });
  plans.forEach(validatePlan);
  const remotePlans = plans.filter((plan) => plan.host.transport === "ssh");
  if (remotePlans.length > 0 && typeof remoteWorkerRunner !== "function") {
    throw new FarmError("remote dispatch requires a remote worker runner", { code: "REMOTE_PREFLIGHT_REQUIRED" });
  }
  if (plans.some((plan) => plan.runId !== plans[0].runId || plan.source.sourceHash !== plans[0].source.sourceHash)) {
    throw new FarmError("all dispatched plans must share one run and full source hash", { code: "PLAN_BINDING_MISMATCH" });
  }
  if (selection) {
    const selectionSourceHash = selection.source?.currentHash ?? selection.source?.current?.sourceHash;
    if (selectionSourceHash !== plans[0].source.sourceHash) throw new FarmError("selection source is not bound to the dispatched full source hash", { code: "SELECTION_SOURCE_MISMATCH" });
    if (selection.mode === "full" && selection.cache?.enabled !== false) throw new FarmError("full verification must execute fresh", { code: "FULL_MODE_CACHE_FORBIDDEN" });
    if (selection.cache?.scopePrefixes !== undefined || selection.cache?.scopedHash !== undefined || selection.cache?.dependencyClosure !== undefined) throw new FarmError("scoped-source cache is not supported", { code: "SCOPED_CACHE_FORBIDDEN" });
  }

  const dispatchStarted = performance.now();
  const attemptDocuments = [];
  const passedDependencies = new Map(plans.map((plan) => [plan.leaseId, new Set()]));
  let pendingPlans = plans;
  for (let executionAttempt = 0; executionAttempt < maxAttempts && pendingPlans.length > 0; executionAttempt += 1) {
    const executions = await Promise.all(pendingPlans.map(async (plan) => {
      const remote = plan.host.transport === "ssh";
      return {
        plan,
        document: await (remote ? remoteWorkerRunner : workerRunner)({
          plan,
          root: remote ? root : plan.host.checkout,
          artifactRoot: path.join(artifactRoot, safeName(plan.leaseId), `attempt-${executionAttempt}`),
          ...(remote ? { preflight: remotePreflight } : {}),
          ...(lockRoot && !remote ? { lockRoot } : {}),
          executionAttempt,
          signal,
          satisfiedDependencies: [...(passedDependencies.get(plan.leaseId) ?? [])],
        }),
      };
    }));
    for (const execution of executions) {
      await validateWorkerExecution(execution.document, execution.plan, executionAttempt);
      const passed = passedDependencies.get(execution.plan.leaseId) ?? new Set();
      for (const result of execution.document.results) if (result.status === "pass") passed.add(result.task.id);
      passedDependencies.set(execution.plan.leaseId, passed);
      attemptDocuments.push(execution.document);
    }
    const retryIds = new Set(executions.flatMap(({ plan, document }) => document.results.filter((result) => retryable(result, plan)).map((result) => result.task.id)));
    pendingPlans = executionAttempt + 1 < maxAttempts ? retryPlans(plans, retryIds, executionAttempt + 1) : [];
  }
  const results = attemptDocuments.flatMap((document) => document.results);
  const taskOutcomes = classifyTaskOutcomes(results);
  const document = {
    schema: FARM_DISPATCH_SCHEMA,
    kind: "result",
    runId: plans[0].runId,
    status: taskOutcomes.every((outcome) => outcome.gateStatus === "pass") ? "pass" : "fail",
    attempts: attemptDocuments,
    taskOutcomes,
  };
  if (timingPath || timings) {
    const prior = timings ?? await loadTimingHistory(timingPath);
    const updated = updatedTimingHistory(prior, results.filter((result) => result.command?.started === true));
    if (timingPath) await writeJsonAtomic(timingPath, updated);
    document.timings = updated;
  }
  const wallMs = round(performance.now() - dispatchStarted);
  document.matrix = buildVerifyMatrix({ plans, dispatch: document, selection, wallMs });
  if (matrixPath) await writeJsonAtomic(matrixPath, document.matrix);
  return document;
}

export function classifyTaskOutcomes(results) {
  const grouped = new Map();
  for (const result of results) {
    const key = result.task.id;
    const group = grouped.get(key) ?? [];
    group.push(result);
    grouped.set(key, group);
  }
  return [...grouped.values()].map((attempts) => {
    attempts.sort((left, right) => left.executionAttempt - right.executionAttempt);
    const first = attempts[0];
    const last = attempts.at(-1);
    const recovered = first.status !== "pass" && last.status === "pass";
    const deterministicFailure = attempts.length > 1 && attempts.every((result) => result.status === "fail");
    const status = recovered ? "quarantined" : last.status;
    return {
      // Keep the initial planned task identity so matrix lookup still binds attempt-0 digests.
      task: first.task,
      attempts,
      status,
      gateStatus: status === "pass" ? "pass" : "fail",
      ...(recovered ? { quarantine: { code: "FLAKY_RECOVERY", message: "task failed before a retry passed; it is quarantined and cannot make the farm green" } } : {}),
      ...(deterministicFailure ? { deterministicFailure: true } : {}),
    };
  }).sort((left, right) => byteCompare(left.task.id, right.task.id));
}

function retryable(result, plan) {
  const task = plan.tasks.find((candidate) => candidate.id === result.task.id && candidate.digest === result.task.digest);
  if (!task || (task.phase ?? 1) !== 1) return false;
  if (["CANCELLED", "DEPENDENCY_NOT_PASSED"].includes(result.reason?.code)) return false;
  return result.status === "fail" || result.status === "killed";
}

function retryPlans(plans, retryIds, attempt) {
  return plans.map((plan) => {
    const taskIds = plan.tasks.filter((task) => retryIds.has(task.id)).map((task) => task.id);
    if (taskIds.length === 0) return null;
    return rematerializePlanForAttempt(plan, taskIds, attempt);
  }).filter(Boolean);
}

async function validateWorkerExecution(document, plan, executionAttempt) {
  if (!document || document.schema !== FARM_WORKER_SCHEMA || document.executionAttempt !== executionAttempt || !Array.isArray(document.results)) {
    throw new FarmError("worker emitted an invalid result document", { code: "INVALID_WORKER_RESULT" });
  }
  const { checksum, ...documentWithoutChecksum } = document;
  const unsignedDocument = typeof document.remoteArtifactRoot === "string"
    ? { ...documentWithoutChecksum, artifactRoot: document.remoteArtifactRoot }
    : documentWithoutChecksum;
  if (typeof checksum !== "string" || checksum !== sha256Json(unsignedDocument)) {
    throw new FarmError("worker result document checksum mismatch", { code: "WORKER_RESULT_CHECKSUM_MISMATCH" });
  }
  const planned = new Map(plan.tasks.map((task) => [task.id, task.digest]));
  if (document.results.length !== planned.size) {
    throw new FarmError("worker did not emit exactly one result for every planned task", { code: "WORKER_RESULT_COVERAGE_MISMATCH" });
  }
  const seen = new Set();
  for (const result of document.results) {
    validateResultEnvelope(result, { plan, executionAttempt });
    const expectedDigest = planned.get(result.task.id);
    if (expectedDigest === undefined || expectedDigest !== result.task.digest || seen.has(result.task.id)) {
      throw new FarmError("worker result task coverage is not bound to its plan", { code: "WORKER_RESULT_COVERAGE_MISMATCH" });
    }
    seen.add(result.task.id);
    const { checksum: resultChecksum, ...unsignedResult } = result;
    if (typeof resultChecksum !== "string" || resultChecksum !== sha256Json(unsignedResult)) {
      throw new FarmError("worker task result checksum mismatch", { code: "WORKER_RESULT_CHECKSUM_MISMATCH" });
    }
    if (result.artifacts.length === 0) continue;
    if (typeof document.artifactRoot !== "string" || !path.isAbsolute(document.artifactRoot)) {
      throw new FarmError("worker artifacts are not bound to an absolute artifact root", { code: "INVALID_WORKER_RESULT" });
    }
    const verified = await verifyArtifactChecksums(document.artifactRoot, result.artifacts);
    if (!verified.ok) throw new FarmError("worker artifact checksums failed dispatch verification", { code: "ARTIFACT_CHECKSUM_MISMATCH", details: verified.failures });
  }
  if (seen.size !== planned.size) {
    throw new FarmError("worker omitted one or more planned task results", { code: "WORKER_RESULT_COVERAGE_MISMATCH" });
  }
}

export async function runVerificationFarm({
  root = repoRoot,
  runId = `verify-${Date.now()}`,
  taskIds,
  mode = "full",
  selection,
  artifactRoot,
  maxAttempts = 2,
  timingPath = path.join(root, "tools", "verification", "farm", "farm-timings.json"),
  signal,
  matrixPath,
  planner = planFarmRun,
  dispatcher = dispatchFarmRun,
} = {}) {
  if (!["fast", "full"].includes(mode) || selection?.mode && selection.mode !== mode) throw new FarmError("verification mode does not match selection", { code: "INVALID_SELECTION" });
  if (!Array.isArray(taskIds) || taskIds.length === 0) throw new FarmError("verification requires selected task ids", { code: "NO_TASKS_SELECTED" });
  if (mode === "full" && selection?.cache?.enabled !== false) throw new FarmError("full verification must execute fresh", { code: "FULL_MODE_CACHE_FORBIDDEN" });
  const planDocument = await planner({ root, runId, lanes: "all", only: taskIds });
  const plannedTaskIds = new Set(planDocument.plans.flatMap((plan) => plan.tasks.map((task) => task.id)));
  const missingTaskIds = taskIds.filter((taskId) => !plannedTaskIds.has(taskId));
  if (missingTaskIds.length > 0) throw new FarmError("selected tasks are missing from the materialized farm plan", { code: "MISSING_SELECTED_TASK", details: { taskIds: missingTaskIds } });
  const selectionSourceHash = selection?.source?.currentHash ?? selection?.source?.current?.sourceHash;
  if (selectionSourceHash !== planDocument.source.sourceHash) throw new FarmError("selection source changed before farm execution", { code: "SELECTION_SOURCE_MISMATCH" });
  const dispatchDocument = await dispatcher({
    plans: planDocument.plans,
    ...(artifactRoot ? { artifactRoot } : {}),
    maxAttempts,
    timingPath,
    signal,
    selection,
    matrixPath,
  });
  return { planDocument, dispatchDocument, matrix: dispatchDocument.matrix };
}

async function localHost(checkout) {
  const capabilities = await probeCapabilities({ root: checkout });
  return {
    id: `local-${safeName(capabilities.host.hostname)}`,
    transport: "local",
    checkout,
    capabilities,
    coreWeight: Math.max(1, capabilities.host.logicalCores),
  };
}

async function macHost({ root, host, sourceHash, preflight }) {
  const document = await preflight({ root, host });
  if (!document || !["ready", "ready-with-pending"].includes(document.status) || document.host !== host || document.checkout !== REMOTE_CHECKOUT || document.source?.match !== true || document.source?.localHash !== sourceHash || document.source?.remoteHash !== sourceHash || !document.capabilities) {
    throw new FarmError("remote host did not establish full source parity during planning", { code: "REMOTE_PREFLIGHT_REFUSED" });
  }
  return {
    id: host,
    transport: "ssh",
    checkout: REMOTE_CHECKOUT,
    capabilities: document.capabilities,
    coreWeight: Math.max(1, document.capabilities.host?.logicalCores ?? 1),
  };
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
    process.stdout.write("usage: dispatch.mjs plan|dispatch [--root DIR] [--plan PLAN.json]\n");
    return;
  }
  const command = args._[0] ?? "plan";
  const root = path.resolve(args.root ?? repoRoot);
  if (command === "plan") {
    const document = await planFarmRun({
      root,
      ...(args["run-id"] ? { runId: args["run-id"] } : {}),
      ...(args.lanes ? { lanes: args.lanes } : {}),
      ...(args.only ? { only: args.only } : {}),
      ...(args["remote-host"] ? { remoteHost: args["remote-host"] } : {}),
      deterministic: Boolean(args.deterministic),
    });
    if (args.out) await writeJsonAtomic(path.resolve(args.out), document);
    printJson(document, Boolean(args.pretty));
    return;
  }
  if (command === "dispatch") {
    if (!args.plan) throw new FarmError("dispatch requires --plan PLAN.json", { code: "USAGE" });
    const input = await readJson(path.resolve(args.plan));
    const plans = Array.isArray(input.plans) ? input.plans : [input];
    const document = await dispatchFarmRun({
      plans,
      root,
      ...(args["artifact-root"] ? { artifactRoot: path.resolve(args["artifact-root"]) } : {}),
      ...(args["lock-root"] ? { lockRoot: path.resolve(args["lock-root"]) } : {}),
      ...(args["max-attempts"] ? { maxAttempts: Number(args["max-attempts"]) } : {}),
      ...(input.selection ? { selection: input.selection } : {}),
      ...(args["matrix-out"] ? { matrixPath: path.resolve(args["matrix-out"]) } : {}),
      timingPath: path.resolve(args["timing-path"] ?? path.join(root, "tools", "verification", "farm", "farm-timings.json")),
    });
    printJson(document, Boolean(args.pretty));
    return;
  }
  throw new FarmError("usage: dispatch.mjs plan|dispatch", { code: "USAGE" });
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error) => {
    printJson(errorDocument(FARM_DISPATCH_SCHEMA, error), true);
    process.exitCode = 1;
  });
}
