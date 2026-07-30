#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { FarmError, errorDocument, parseArgs, printJson, repoRoot } from "./farm/common.mjs";
import { writeJsonAtomic } from "./farm/protocol.mjs";
import { buildTaskGraph } from "./farm/task-plan.mjs";
import { createLocalSourceIdentity } from "./farm/source-hash.mjs";
import { VERIFY_SELECTION_SCHEMA, selectVerificationTasks } from "./select.mjs";

export const VERIFY_FULL_PLAN_SCHEMA = "successor.verify-full-plan.v1";
const COVERAGE_MAP_PATH = "tools/verification/coverage/coverage-map.json";

export function buildFullVerificationPlan({ tasks, selection, buildOnly = false } = {}) {
  if (!Array.isArray(tasks) || tasks.some((task) => !task || typeof task.id !== "string")) {
    throw new FarmError("full verification requires a task graph", { code: "INVALID_TASK_GRAPH" });
  }
  if (!selection || selection.schema !== VERIFY_SELECTION_SCHEMA || selection.mode !== "full" || !Array.isArray(selection.taskIds)) {
    throw new FarmError("full verification requires a full selection document", { code: "INVALID_VERIFY_SELECTION" });
  }
  if (selection.cache?.enabled !== false || selection.cache?.sourceHash !== selection.source?.currentHash || selection.cache?.reason !== "full-mode-fresh") {
    throw new FarmError("verify:full must use the full canonical source hash and execute fresh", { code: "INVALID_FULL_PROVENANCE" });
  }
  const taskById = new Map(tasks.map((task) => [task.id, task]));
  const missing = selection.taskIds.filter((taskId) => !taskById.has(taskId));
  if (missing.length > 0) throw new FarmError(`full selection contains unknown task IDs: ${missing.join(", ")}`, { code: "UNKNOWN_TASK_ID" });

  const selectedTasks = selection.taskIds.map((taskId) => taskById.get(taskId));
  const requestedTasks = buildOnly ? selectedTasks.filter(isSharedBuildTask) : selectedTasks;
  if (requestedTasks.length === 0) {
    throw new FarmError(buildOnly ? "task graph exposes no required shared build tasks" : "full verification selected no tasks", { code: buildOnly ? "BUILD_TASKS_MISSING" : "NO_TASKS_SELECTED" });
  }
  const taskIds = requestedTasks.map((task) => task.id).sort(byteCompare);
  const phase0TaskIds = requestedTasks.filter((task) => task.phase === 0).map((task) => task.id).sort(byteCompare);
  const phase1TaskIds = requestedTasks.filter((task) => task.phase !== 0).map((task) => task.id).sort(byteCompare);
  if (!buildOnly && phase0TaskIds.length === 0) throw new FarmError("verify:full plan has no shared phase-0 work", { code: "PHASE0_TASKS_MISSING" });
  if (!buildOnly && phase1TaskIds.length === 0) throw new FarmError("verify:full plan has no phase-1 verification shards", { code: "PHASE1_TASKS_MISSING" });

  return {
    schema: VERIFY_FULL_PLAN_SCHEMA,
    mode: "full",
    fresh: true,
    buildOnly,
    sourceHash: selection.source.currentHash,
    taskIds,
    phases: [
      { id: "phase-0", taskIds: phase0TaskIds },
      ...(buildOnly ? [] : [{ id: "phase-1", taskIds: phase1TaskIds }]),
    ],
    selection,
  };
}

export async function createFullVerificationPlan({ root = repoRoot, tasks, coverageMap, buildOnly = false } = {}) {
  const absoluteRoot = path.resolve(root);
  const [resolvedTasks, resolvedCoverageMap, currentIdentity] = await Promise.all([
    tasks ?? buildTaskGraph({ root: absoluteRoot, lanes: "all" }),
    coverageMap ?? readJson(path.join(absoluteRoot, COVERAGE_MAP_PATH), "coverage map"),
    createLocalSourceIdentity({ root: absoluteRoot, includeManifest: true }),
  ]);
  const selection = selectVerificationTasks({
    tasks: resolvedTasks,
    coverageMap: resolvedCoverageMap,
    mode: "full",
    currentManifest: currentIdentity.manifest,
  });
  return buildFullVerificationPlan({ tasks: resolvedTasks, selection, buildOnly });
}

function isSharedBuildTask(task) {
  return task.phase === 0 && task.category === "build" && task.required !== false && task.optIn !== true;
}

async function readJson(filePath, label) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (cause) {
    throw new FarmError(`could not read ${label} ${filePath}`, { code: "JSON_READ_FAILED", cause });
  }
}

function byteCompare(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

async function runFullCli() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write("usage: verify-full.mjs [--dry-run] [--build-only] [--out REPORT.json] [--pretty]\n");
    return;
  }
  const root = path.resolve(String(args.root ?? repoRoot));
  const plan = await createFullVerificationPlan({ root, buildOnly: Boolean(args["build-only"]) });
  if (args["dry-run"] || args["plan-only"]) {
    printJson(plan, Boolean(args.pretty));
    return;
  }
  const { runVerificationFarm } = await import("./farm/dispatch.mjs");
  if (typeof runVerificationFarm !== "function") throw new FarmError("farm dispatcher does not expose runVerificationFarm", { code: "FARM_DISPATCH_UNAVAILABLE" });
  const executionSelection = plan.buildOnly
    ? {
        ...plan.selection,
        taskIds: plan.taskIds,
        rules: [{ id: "shared-build-phase", paths: [], taskIds: plan.taskIds }],
        noOpScope: false,
        coverageEvidence: [{ kind: "build", path: null, systemIds: [], taskIds: plan.taskIds }],
      }
    : plan.selection;
  const outcome = await runVerificationFarm({
    root,
    runId: String(args["run-id"] ?? `${plan.buildOnly ? "build-verify" : "verify-full"}-${Date.now()}`),
    taskIds: plan.taskIds,
    mode: "full",
    selection: executionSelection,
    ...(args["artifact-root"] ? { artifactRoot: path.resolve(String(args["artifact-root"])) } : {}),
    ...(args["max-attempts"] ? { maxAttempts: Number(args["max-attempts"]) } : {}),
  });
  if (args.out) await writeJsonAtomic(path.resolve(String(args.out)), outcome.matrix);
  printJson(outcome.matrix, Boolean(args.pretty));
  if (outcome.matrix.status !== "pass") process.exitCode = 1;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  runFullCli().catch((error) => {
    printJson(errorDocument(VERIFY_FULL_PLAN_SCHEMA, error), true);
    process.exitCode = 1;
  });
}
