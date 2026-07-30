import { FarmError } from "./common.mjs";
import { VERIFY_MATRIX_SCHEMA, validateId, validateVerifyMatrix } from "./protocol.mjs";

const SELECTION_SCHEMA = "successor.verify-selection.v1";

/**
 * Joins signed task plans and their bound farm-result envelopes into the
 * machine-readable verification roll-up. Farm results remain v1 documents;
 * this report is a separate schema so existing result consumers do not need to
 * understand selection, cache, or scheduling metadata.
 */
export function buildVerifyMatrix({ plans, dispatch, selection, wallMs, generatedAt } = {}) {
  if (!Array.isArray(plans) || plans.length === 0) {
    throw new FarmError("verify matrix requires at least one task plan", { code: "NO_PLANS" });
  }
  if (!dispatch || !Array.isArray(dispatch.taskOutcomes) || !Array.isArray(dispatch.attempts)) {
    throw new FarmError("verify matrix requires a completed farm dispatch", { code: "INVALID_DISPATCH_RESULT" });
  }

  const runId = plans[0].runId;
  const sourceHash = plans[0].source?.sourceHash;
  for (const plan of plans) {
    if (plan.runId !== runId || plan.source?.sourceHash !== sourceHash) {
      throw new FarmError("verify matrix plans do not share one run and source", { code: "MATRIX_PLAN_MISMATCH" });
    }
  }
  validateId(runId, "matrix runId");
  if (!/^[a-f0-9]{64}$/u.test(sourceHash ?? "")) {
    throw new FarmError("verify matrix source hash is invalid", { code: "MATRIX_PLAN_MISMATCH" });
  }

  const taskPlans = plannedTasks(plans);
  const normalizedSelection = normalizeSelection(selection, taskPlans, sourceHash);
  const resultRoots = artifactRoots(dispatch.attempts);
  const outcomes = new Map(dispatch.taskOutcomes.map((outcome) => [taskKey(outcome.task), outcome]));
  const coverageEvidence = normalizedSelection.coverageEvidence ?? [];
  const tasks = taskPlans.map(({ plan, task }) => {
    const outcome = outcomes.get(taskKey(task));
    if (!outcome) {
      throw new FarmError(`verify matrix has no outcome for ${task.id}`, { code: "MATRIX_RESULT_MISSING", details: { taskId: task.id } });
    }
    const attempts = outcome.attempts.map((result) => ({
      executionAttempt: result.executionAttempt,
      status: result.status,
      startedAt: result.startedAt ?? null,
      completedAt: result.completedAt ?? null,
      durationMs: result.durationMs,
      host: result.host,
      leaseId: result.leaseId,
      reason: result.reason ?? null,
      artifactRoot: resultRoots.get(resultKey(result)) ?? null,
      artifacts: result.artifacts,
      cache: cacheProvenance(normalizedSelection, sourceHash, false),
    }));
    const taskEvidence = coverageEvidence.filter((entry) => !Array.isArray(entry?.taskIds) || entry.taskIds.includes(task.id));
    return {
      id: task.id,
      digest: task.digest,
      lane: task.lane,
      shard: task.shard,
      phase: task.phase ?? 1,
      slot: task.slot === undefined ? 0 : task.slot,
      dependencies: Array.isArray(task.dependencies) ? task.dependencies : [],
      plan: { digest: plan.digest, leaseId: plan.leaseId, hostId: plan.host.id },
      sourceHash,
      selected: normalizedSelection.taskIds.includes(task.id),
      selectionRules: normalizedSelection.rules.filter((rule) => Array.isArray(rule.taskIds) && rule.taskIds.includes(task.id)).map((rule) => rule.id),
      coverageEvidence: taskEvidence,
      status: outcome.status,
      gateStatus: outcome.gateStatus,
      durationMs: round(attempts.reduce((sum, attempt) => sum + attempt.durationMs, 0)),
      artifacts: attempts.map((attempt) => ({ executionAttempt: attempt.executionAttempt, artifactRoot: attempt.artifactRoot, files: attempt.artifacts })),

      cache: cacheProvenance(normalizedSelection, sourceHash, false),
      attempts,
      ...(outcome.quarantine ? { quarantine: outcome.quarantine } : {}),
      ...(outcome.deterministicFailure ? { deterministicFailure: true } : {}),
    };
  });

  if (outcomes.size !== tasks.length) {
    throw new FarmError("verify matrix contains outcomes not present in its task plans", { code: "MATRIX_PLAN_MISMATCH" });
  }
  const sumTaskMs = round(tasks.reduce((sum, task) => sum + task.durationMs, 0));
  const resolvedWallMs = round(wallMs ?? deriveWallMs(tasks));
  const matrix = {
    schema: VERIFY_MATRIX_SCHEMA,
    runId,
    status: dispatch.status,
    generatedAt: generatedAt ?? new Date().toISOString(),
    mode: normalizedSelection.mode,
    sourceHash,
    selection: normalizedSelection,
    coverageEvidence,
    cache: cacheProvenance(normalizedSelection, sourceHash, false),
    plan: {
      schemas: [...new Set(plans.map((plan) => plan.schema))],
      digests: plans.map((plan) => plan.digest),
      taskCount: taskPlans.length,
      phase0TaskIds: taskPlans.filter(({ task }) => (task.phase ?? 1) === 0).map(({ task }) => task.id),
      phase1Concurrency: Math.max(...plans.map((plan) => plan.phase1Concurrency ?? 1)),
    },
    durations: {
      wallMs: resolvedWallMs,
      sumTaskMs,
      parallelismRatio: resolvedWallMs > 0 ? round(sumTaskMs / resolvedWallMs) : 0,
    },
    tasks,
  };
  return validateVerifyMatrix(matrix);
}

function normalizeSelection(selection, taskPlans, sourceHash) {
  const taskIds = taskPlans.map(({ task }) => task.id).sort(byteCompare);
  const value = selection ?? {
    schema: SELECTION_SCHEMA,
    mode: "full",
    source: { currentHash: sourceHash, baselineHash: null, current: { sourceHash }, baseline: null },
    changedPaths: [],
    rules: [],
    taskIds,
    noOpScope: false,
    coverageEvidence: [],
    cache: { enabled: false, sourceHash, reason: "full-mode-fresh" },
  };
  if (value.schema !== SELECTION_SCHEMA || !["fast", "full"].includes(value.mode)) {
    throw new FarmError("verify selection metadata is invalid", { code: "INVALID_SELECTION" });
  }
  const currentHash = value.source?.currentHash ?? value.source?.current?.sourceHash;
  if (currentHash !== sourceHash) {
    throw new FarmError("selection source is not the full source bound to the task plan", { code: "SELECTION_SOURCE_MISMATCH" });
  }
  if (!Array.isArray(value.changedPaths) || !Array.isArray(value.rules) || !Array.isArray(value.taskIds) || !Array.isArray(value.coverageEvidence ?? [])) {
    throw new FarmError("verify selection arrays are invalid", { code: "INVALID_SELECTION" });
  }
  const plannedIds = new Set(taskIds);
  if (value.taskIds.length === 0 || new Set(value.taskIds).size !== value.taskIds.length || value.taskIds.some((id) => !plannedIds.has(id))) {
    throw new FarmError("verify selection task ids are not bound to the task plan", { code: "INVALID_SELECTION" });
  }
  for (const rule of value.rules) {
    validateId(rule?.id, "selection rule id");
    if (!Array.isArray(rule.taskIds) || rule.taskIds.some((id) => !plannedIds.has(id))) throw new FarmError("selection rule references an unplanned task", { code: "INVALID_SELECTION" });
  }
  for (const evidence of value.coverageEvidence ?? []) {
    if (!Array.isArray(evidence?.taskIds) || evidence.taskIds.some((id) => !plannedIds.has(id))) throw new FarmError("coverage evidence references an unplanned task", { code: "INVALID_SELECTION" });
  }
  const cache = value.cache;
  if (!cache || typeof cache !== "object" || cache.sourceHash !== sourceHash) {
    throw new FarmError("cache provenance must be bound to the full canonical source hash", { code: "INVALID_CACHE_PROVENANCE" });
  }
  if (cache.scopePrefixes !== undefined || cache.scopedHash !== undefined || cache.dependencyClosure !== undefined) {
    throw new FarmError("scoped-source cache provenance is not supported", { code: "SCOPED_CACHE_FORBIDDEN" });
  }
  if (value.mode === "full" && cache.enabled !== false) {
    throw new FarmError("full verification must execute fresh and cannot use cache", { code: "FULL_MODE_CACHE_FORBIDDEN" });
  }
  return value;
}

function plannedTasks(plans) {
  const seen = new Set();
  const output = [];
  for (const plan of plans) {
    for (const task of plan.tasks) {
      const key = taskKey(task);
      if (seen.has(key)) throw new FarmError(`duplicate planned matrix task ${task.id}`, { code: "MATRIX_PLAN_MISMATCH" });
      seen.add(key);
      output.push({ plan, task });
    }
  }
  return output.sort((left, right) => byteCompare(left.task.id, right.task.id));
}

function artifactRoots(attempts) {
  const roots = new Map();
  for (const attempt of attempts) {
    for (const result of attempt.results ?? []) roots.set(resultKey(result), attempt.artifactRoot ?? null);
  }
  return roots;
}

function cacheProvenance(selection, sourceHash, hit) {
  return {
    hit,
    disposition: hit ? "cache" : "fresh",
    sourceHash,
    enabled: selection.cache.enabled,
    reason: selection.cache.reason,
  };
}

function deriveWallMs(tasks) {
  const starts = [];
  const completions = [];
  for (const task of tasks) {
    for (const attempt of task.attempts) {
      const started = Date.parse(attempt.startedAt ?? "");
      const completed = Date.parse(attempt.completedAt ?? "");
      if (Number.isFinite(started)) starts.push(started);
      if (Number.isFinite(completed)) completions.push(completed);
    }
  }
  return starts.length > 0 && completions.length > 0 ? Math.max(0, Math.max(...completions) - Math.min(...starts)) : 0;
}

function taskKey(task) {
  return `${task.id}\0${task.digest}`;
}

function resultKey(result) {
  return `${result.leaseId}\0${result.executionAttempt}`;
}

function byteCompare(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function round(value) {
  return Math.round(value * 1000) / 1000;
}
