import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { FarmError } from "./common.mjs";
import { FARM_TIMINGS_SCHEMA, canonicalJson, safeName, sha256Json, validateId, validateRelativePath } from "./protocol.mjs";
import { scenarioMatrixLanes, scenarioSupportedLanes } from "../scenario/runner.mjs";

export const FARM_PLAN_SCHEMA = "successor.farm-plan.v1";
export const VERIFICATION_PLAN_SCHEMA = "successor.verification-plan.v1";
export const DEFAULT_LANES = ["rust", "node", "accel", "realtime", "tui"];
export const ALL_LANES = [...DEFAULT_LANES, "3d", "audio", "desktop"];
export const FARM_PORT_RANGE = Object.freeze({ start: 29_700, end: 29_799 });
export const RESERVED_FARM_PORTS = Object.freeze([5_179, 18_192, 28_093]);
export const DEFAULT_PHASE1_CONCURRENCY = 4;
export const RESOURCE_CLASSES = Object.freeze({
  CPU_LIGHT: "cpu-light",
  HEADLESS: "headless",
  BACKEND_SCENARIO: "backend-scenario",
  BROWSER_HEAVY: "browser-heavy",
  EXCLUSIVE: "exclusive",
});
export const FARM_SLOT_PORT_WINDOW_SIZE = 8;
const TASK_TIMEOUTS = {
  rust: 15 * 60_000,
  node: 15 * 60_000,
  accel: 10 * 60_000,
  realtime: 20 * 60_000,
  tui: 12 * 60_000,
  "3d": 20 * 60_000,
  audio: 3 * 60_000,
  desktop: 20 * 60_000,
};

const BUILD_TASK_IDS = Object.freeze({
  authorityBridge: "build:authority-bridge",
  server: "build:server",
  clientHeadless: "build:client-headless",
  tui: "build:tui",
  client3d: "build:client-3d",
  desktop: "build:desktop",
});
const VALID_TASK_CATEGORIES = new Set(["build", "static", "test", "gate", "probe"]);
const VALID_GATE_TIERS = new Set(["G0", "G1", "G2", "G3", "G4"]);
const VALID_RESOURCE_CLASSES = new Set(Object.values(RESOURCE_CLASSES));
export const RESOURCE_CLASS_LIMITS = Object.freeze({
  [RESOURCE_CLASSES.CPU_LIGHT]: Infinity,
  [RESOURCE_CLASSES.HEADLESS]: 2,
  [RESOURCE_CLASSES.BACKEND_SCENARIO]: 4,
  [RESOURCE_CLASSES.BROWSER_HEAVY]: 1,
  [RESOURCE_CLASSES.EXCLUSIVE]: 1,
});
const RESERVED_PORT_SET = new Set(RESERVED_FARM_PORTS);
/** Every task CWD is an absolute directory contained by plan.host.checkout. Templates may only declare a relative checkout path. */
export const TASK_CWD_CONTRACT = "Farm task cwd is an absolute path resolved beneath plan.host.checkout; task templates use only checkout-relative paths.";
const KNOWN_CAPABILITY_TAGS = new Set(["linux-only", "macos-only", "node", "pnpm", "rust", "wasm", "process-host", "systemd", "playwright", "ffmpeg"]);

export async function buildTaskGraph({ root, lanes = DEFAULT_LANES } = {}) {
  if (!root) throw new FarmError("task graph requires a repository root", { code: "ROOT_REQUIRED" });
  const selectedLanes = normalizeLanes(lanes);
  const tasks = [...staticTasks()];
  const requiredBuilds = requiredBuildTaskIds(selectedLanes);
  tasks.push(...buildTasks().filter((task) => requiredBuilds.has(task.id)));
  if (selectedLanes.has("rust")) tasks.push(...await rustTasks(root));
  if (selectedLanes.has("node")) tasks.push(...await nodeTasks(root));
  if (selectedLanes.has("accel") || selectedLanes.has("realtime")) tasks.push(...await scenarioTasks(root, selectedLanes));
  if (selectedLanes.has("tui")) tasks.push(...await tuiTasks(root));
  if (selectedLanes.has("3d")) tasks.push(...await client3dTasks(root));
  if (selectedLanes.has("audio")) tasks.push(audioTask());
  if (selectedLanes.has("desktop")) tasks.push(desktopTask());
  tasks.sort(compareTasksByPhase);
  const ids = new Set();
  for (const task of tasks) {
    validateTaskTemplate(task);
    if (ids.has(task.id)) throw new FarmError(`duplicate farm task ${task.id}`, { code: "DUPLICATE_TASK" });
    ids.add(task.id);
  }
  for (const task of tasks) {
    for (const dependency of task.dependencies) {
      if (!ids.has(dependency)) throw new FarmError(`task ${task.id} has unavailable dependency ${dependency}`, { code: "MISSING_TASK_DEPENDENCY" });
    }
  }
  return tasks;
}

export async function buildVerificationPlan({ root, mode = "full", taskIds } = {}) {
  if (mode !== "fast" && mode !== "full") throw new FarmError(`unknown verification mode ${mode}`, { code: "INVALID_MODE" });
  const graph = await buildTaskGraph({ root, lanes: ["rust", "node", "accel", "realtime", "tui", "3d", "desktop"] });
  let tasks;
  if (mode === "full") {
    tasks = graph.filter((task) => task.required && !task.optIn);
  } else {
    const requested = new Set(splitList(taskIds));
    for (const id of requested) validateId(id, "verification task id");
    const exact = graph.filter((task) => requested.has(task.id) || task.category === "static");
    const missing = [...requested].filter((id) => !graph.some((task) => task.id === id));
    if (missing.length > 0) throw new FarmError(`unknown verification task(s): ${missing.join(", ")}`, { code: "NO_TASKS_SELECTED" });
    tasks = withDirectDependencies(graph, exact);
  }
  tasks.sort(compareTasksByPhase);
  return {
    schema: VERIFICATION_PLAN_SCHEMA,
    mode,
    phases: [
      { id: "phase-0", tasks: tasks.filter((task) => task.phase === 0) },
      { id: "phase-1", tasks: tasks.filter((task) => task.phase === 1) },
    ],
    tasks,
  };
}

export function filterTasks(tasks, only) {
  const selectors = splitList(only);
  if (selectors.length === 0) return tasks;
  const selected = tasks.filter((task) => selectors.some((selector) => matchesSelector(task, selector)));
  if (selected.length === 0) throw new FarmError(`--only matched no tasks (${selectors.join(",")})`, { code: "NO_TASKS_SELECTED" });
  return withDirectDependencies(tasks, selected).sort(compareTasksByPhase);
}

export function scheduleTasksLpt({ tasks, hosts, timings }) {
  validateTimings(timings);
  if (!Array.isArray(hosts) || hosts.length === 0) throw new FarmError("scheduler requires at least one host", { code: "NO_HOSTS" });
  const state = hosts.map((host, index) => ({
    host,
    index,
    projectedMs: host.transport === "ssh" ? timings.remoteOverheadMs : 0,
    tasks: [],
  }));
  const phase0 = estimatedTasks(tasks.filter((task) => taskPhase(task) === 0), timings);
  const phase1 = estimatedTasks(tasks.filter((task) => taskPhase(task) === 1), timings);
  let sharedPhase0Host = null;

  if (phase0.length > 0) {
    const dependentPhase1 = phase1.filter(({ task }) => taskDependencies(task).length > 0);
    const candidates = state.filter((entry) =>
      phase0.every(({ task }) => taskEligibleOnHost(task, entry.host)) &&
      dependentPhase1.every(({ task }) => taskEligibleOnHost(task, entry.host))
    );
    if (candidates.length === 0) {
      throw new FarmError("no selected host can own the shared phase-0 build/static phase and all dependent phase-1 tasks", { code: "NO_ELIGIBLE_HOST" });
    }
    candidates.sort((left, right) => left.projectedMs - right.projectedMs || left.index - right.index || byteCompare(left.host.id, right.host.id));
    sharedPhase0Host = candidates[0];
    for (const item of phase0) assignEstimatedTask(sharedPhase0Host, item);
  }

  for (const item of phase1) {
    const eligible = taskDependencies(item.task).length > 0 && sharedPhase0Host
      ? [sharedPhase0Host].filter((entry) => taskEligibleOnHost(item.task, entry.host))
      : state.filter((entry) => taskEligibleOnHost(item.task, entry.host));
    if (eligible.length === 0) {
      throw new FarmError(`no selected host can run ${item.task.id}`, { code: "NO_ELIGIBLE_HOST", details: { task: item.task.id, tags: item.task.tags } });
    }
    eligible.sort((left, right) => left.projectedMs - right.projectedMs || left.index - right.index || byteCompare(left.host.id, right.host.id));
    assignEstimatedTask(eligible[0], item);
  }
  return state.map((entry) => ({ host: entry.host, projectedMs: round(entry.projectedMs), tasks: entry.tasks }));
}

export function createWorkerPlan({ runId, hostAssignment, source, attempt = 0, deterministic = false }) {
  validateId(runId, "farm runId");
  const host = hostAssignment.host;
  validateId(host.id, "farm host id");
  if (!source || !/^[a-f0-9]{64}$/u.test(source.sourceHash ?? "") || !Array.isArray(source.paths)) {
    throw new FarmError("worker plan source identity is invalid", { code: "INVALID_PLAN_SOURCE" });
  }
  const leaseId = deterministic
    ? `lease-${safeName(host.id)}-dry`
    : `lease-${safeName(host.id)}-${sha256Json([runId, host.id, attempt, source.sourceHash]).slice(0, 16)}`;
  const orderedTemplates = hostAssignment.tasks.map((task) => template(task)).sort(compareTasksByPhase);
  const phase1Templates = orderedTemplates.filter((task) => task.phase === 1);
  const windows = phase1Templates.length > 0 ? availablePortWindows(host.capabilities?.networking?.freePortRange) : [];
  const requestedConcurrency = Number.isInteger(hostAssignment.phase1Concurrency) && hostAssignment.phase1Concurrency > 0
    ? hostAssignment.phase1Concurrency
    : DEFAULT_PHASE1_CONCURRENCY;
  const phase1Concurrency = phase1Templates.length === 0 ? 0 : Math.min(requestedConcurrency, phase1Templates.length, windows.length);
  if (phase1Templates.length > 0 && phase1Concurrency < 1) throw new FarmError(`host ${host.id} exposes no safe farm port slot`, { code: "INSUFFICIENT_PORT_RANGE" });
  const slots = assignPhase1Slots(phase1Templates, phase1Concurrency);
  const tasks = orderedTemplates.map((taskTemplate) => {
    const taskRunId = boundedTaskRunId(runId, taskTemplate.id, attempt);
    const slot = taskTemplate.phase === 1 ? slots.get(taskTemplate.id) : null;
    const portWindow = slot === null ? null : { ...windows[slot] };
    if (portWindow && taskTemplate.portCount > portWindow.size) {
      throw new FarmError(`task ${taskTemplate.id} needs more ports than slot ${slot} exposes`, { code: "INSUFFICIENT_PORT_RANGE" });
    }
    const ports = portWindow ? Array.from({ length: taskTemplate.portCount }, (_, index) => portWindow.start + index) : [];
    const replacements = { "$TASK_RUN_ID": taskRunId, "$SOURCE_HASH": source.sourceHash };
    ports.forEach((port, index) => { replacements[`$PORT${index}`] = String(port); });
    const statePaths = materializeStatePaths(host.checkout, taskRunId);
    const declaredEnv = Object.fromEntries(Object.entries(taskTemplate.env ?? {}).map(([key, value]) => [key, replaceToken(value, replacements)]));
    const task = {
      id: taskTemplate.id,
      lane: taskTemplate.lane,
      shard: taskTemplate.shard,
      phase: taskTemplate.phase,
      tier: taskTemplate.tier,
      category: taskTemplate.category,
      resourceClass: resourceClassForTask(taskTemplate),
      dependencies: [...taskTemplate.dependencies],
      required: taskTemplate.required,
      optIn: taskTemplate.optIn,
      defaultFresh: taskTemplate.defaultFresh,
      skipBuild: taskTemplate.skipBuild,
      slot,
      portWindow,
      statePaths,
      attempt,
      argv: replaceTokens(taskTemplate.argv, replacements),
      cwd: resolveTaskCwd(host.checkout, taskTemplate.cwd),
      env: {
        ...declaredEnv,
        SUCCESSOR_PROCESS_RUN_ID: taskRunId,
        SUCCESSOR_PROCESS_RUN_DIR: statePaths.runDir,
        SUCCESSOR_FARM_SHARD_PATH: statePaths.shardPath,
        SUCCESSOR_FARM_STORE_PATH: statePaths.storePath,
      },
      tags: [...taskTemplate.tags],
      deadlineMs: taskTemplate.deadlineMs,
      graceMs: 30_000,
      ports,
      taskRunId,
      artifactPaths: taskTemplate.artifactPaths.map((value) => replaceToken(value, replacements)),
      artifactDiscoveryRoots: [...taskTemplate.artifactDiscoveryRoots],
      digestGroup: taskTemplate.digestGroup ?? null,
      estimateMs: taskTemplate.estimateMs,
    };
    task.digest = taskDigest(task);
    return task;
  });
  const plan = {
    schema: FARM_PLAN_SCHEMA,
    runId,
    leaseId,
    host: { id: host.id, transport: host.transport, checkout: path.resolve(host.checkout) },
    source: { sourceHash: source.sourceHash, paths: [...source.paths].sort(byteCompare) },
    attempt,
    phase1Concurrency,
    createdAt: deterministic ? "1970-01-01T00:00:00.000Z" : new Date().toISOString(),
    tasks,
  };
  plan.digest = sha256Json(plan);
  return validatePlan(plan);
}

export function rematerializePlanForAttempt(plan, taskIds, attempt) {
  validatePlan(plan);
  if (!Number.isInteger(attempt) || attempt < 0 || attempt > 1) {
    throw new FarmError("plan attempt/tasks are invalid", { code: "INVALID_PLAN" });
  }
  const wanted = new Set(Array.isArray(taskIds) ? taskIds : [...taskIds]);
  if (wanted.size === 0) {
    throw new FarmError("retry rematerialization requires at least one task id", { code: "INVALID_PLAN" });
  }
  const selected = plan.tasks.filter((task) => wanted.has(task.id));
  if (selected.length === 0) return null;
  if (selected.length !== wanted.size) {
    const present = new Set(selected.map((task) => task.id));
    const missing = [...wanted].filter((taskId) => !present.has(taskId));
    throw new FarmError("retry rematerialization referenced tasks absent from the plan", {
      code: "INVALID_PLAN",
      details: { taskIds: missing },
    });
  }
  const tasks = selected.map((task) => rematerializeTaskForAttempt(task, plan.runId, plan.host.checkout, attempt));
  const { digest, ...unsigned } = plan;
  const nextPlan = {
    ...unsigned,
    attempt,
    createdAt: plan.createdAt === "1970-01-01T00:00:00.000Z" ? plan.createdAt : new Date().toISOString(),
    tasks,
  };
  nextPlan.digest = sha256Json(nextPlan);
  return validatePlan(nextPlan);
}

export function validatePlan(plan) {
  if (!plan || plan.schema !== FARM_PLAN_SCHEMA) throw new FarmError("unsupported farm plan schema", { code: "INVALID_PLAN" });
  validateId(plan.runId, "plan runId");
  validateId(plan.leaseId, "plan leaseId");
  validateId(plan.host?.id, "plan host id");
  if (!["local", "ssh"].includes(plan.host?.transport) || typeof plan.host?.checkout !== "string" || !path.isAbsolute(plan.host.checkout)) throw new FarmError("plan host is invalid", { code: "INVALID_PLAN" });
  if (!/^[a-f0-9]{64}$/u.test(plan.source?.sourceHash ?? "") || !Array.isArray(plan.source?.paths)) throw new FarmError("plan source is invalid", { code: "INVALID_PLAN" });
  for (const sourcePath of plan.source.paths) validateRelativePath(sourcePath, "plan source path");
  if (!Number.isInteger(plan.attempt) || plan.attempt < 0 || plan.attempt > 1 || !Array.isArray(plan.tasks)) throw new FarmError("plan attempt/tasks are invalid", { code: "INVALID_PLAN" });
  if (!Number.isInteger(plan.phase1Concurrency) || plan.phase1Concurrency < 0 || plan.phase1Concurrency > 64) throw new FarmError("plan phase1Concurrency is invalid", { code: "INVALID_PLAN" });
  for (const task of plan.tasks) validateMaterializedTask(task, plan.attempt, plan.host.checkout, plan.phase1Concurrency);
  validatePlanTopology(plan);
  const { digest, ...unsignedPlan } = plan;
  const expected = sha256Json(unsignedPlan);
  if (digest !== expected) throw new FarmError("farm plan digest mismatch", { code: "PLAN_DIGEST_MISMATCH" });
  return plan;
}

export function taskDigest(task) {
  const { digest, ...unsignedTask } = task;
  return sha256Json(unsignedTask);
}

export function resourceClassForTask(task) {
  return task.resourceClass ?? inferResourceClass(task);
}

export function normalizeLanes(lanes) {
  const requested = splitList(lanes);
  const expanded = new Set();
  for (const lane of requested.length > 0 ? requested : DEFAULT_LANES) {
    if (lane === "all") ALL_LANES.forEach((item) => expanded.add(item));
    else if (lane === "portable") DEFAULT_LANES.forEach((item) => expanded.add(item));
    else if (lane === "l0") ["rust", "node"].forEach((item) => expanded.add(item));
    else if (lane === "scenarios") ["accel", "realtime"].forEach((item) => expanded.add(item));
    else if (ALL_LANES.includes(lane)) expanded.add(lane);
    else throw new FarmError(`unknown farm lane ${lane}`, { code: "INVALID_LANE" });
  }
  return expanded;
}

export async function loadTimingHistory(filePath) {
  const document = JSON.parse(await fs.readFile(filePath, "utf8"));
  validateTimings(document);
  return document;
}

export function updatedTimingHistory(timings, results) {
  validateTimings(timings);
  const tasks = { ...timings.tasks };
  for (const result of results) {
    if (!["pass", "fail", "killed"].includes(result.status) || !Number.isFinite(result.durationMs) || !result.task?.id) continue;
    const prior = tasks[result.task.id] ?? {};
    const samples = [...(Array.isArray(prior.samplesMs) ? prior.samplesMs : []), Math.round(result.durationMs)].slice(-9);
    const sorted = [...samples].sort((left, right) => left - right);
    tasks[result.task.id] = { samplesMs: samples, medianMs: sorted[Math.floor(sorted.length / 2)] };
  }
  return { ...timings, tasks };
}
function validateTimings(value) {
  if (!value || value.schema !== FARM_TIMINGS_SCHEMA || !Number.isFinite(value.remoteOverheadMs) || !Number.isFinite(value.referenceCores) || !value.laneDefaultsMs || !value.tasks) {
    throw new FarmError("farm timing history is invalid", { code: "INVALID_TIMINGS" });
  }
}

function estimateTaskMs(task, timings) {
  return positiveNumber(timings.tasks?.[task.id]?.medianMs, positiveNumber(timings.laneDefaultsMs?.[task.lane], 60_000));
}
export function taskEligibleOnHost(task, host) {
  const caps = host.capabilities;
  for (const tag of task.tags) {
    if (!KNOWN_CAPABILITY_TAGS.has(tag)) return false;
    if (tag === "linux-only" && caps?.host?.os !== "linux") return false;
    if (tag === "macos-only" && caps?.host?.os !== "darwin") return false;
    if (tag === "node" && caps?.toolchain?.node?.available !== true) return false;
    if (tag === "pnpm" && caps?.toolchain?.pnpm?.available !== true) return false;
    if (tag === "rust" && (caps?.toolchain?.rustc?.available !== true || caps?.toolchain?.cargo?.available !== true)) return false;
    if (tag === "wasm" && caps?.toolchain?.wasmTarget?.available !== true) return false;
    if (tag === "process-host" && caps?.runtime?.processHost?.available !== true) return false;
    if (tag === "systemd" && caps?.runtime?.systemd?.userManagerOperational !== true) return false;
    if (tag === "playwright" && (caps?.runtime?.playwright?.available !== true || caps?.runtime?.playwright?.chromiumInstalled !== true)) return false;
    if (tag === "ffmpeg" && caps?.runtime?.ffmpeg?.available !== true) return false;
  }
  return true;
}

function staticTasks() {
  return [
    ["static:commands", "check:commands"],
    ["static:coverage", "check:coverage"],
    ["static:denylist", "denylist"],
    ["static:successor-context", "verify:successor-context"],
    ["static:deploy-contract", "deploy:contract"],
    ["static:fixture", "test:fixture-contract"],
    ["static:zero-gpu", "check:zero-gpu"],
    ["static:wardrobe", "check:wardrobe"],
  ].map(([id, script]) => template({
    id,
    lane: "node",
    shard: `package.json#${script}`,
    argv: ["pnpm", script],
    tags: ["node", "pnpm"],
    phase: 0,
    tier: "G0",
    category: "static",
  }));
}

function buildTasks() {
  return [
    template({ id: BUILD_TASK_IDS.authorityBridge, lane: "rust", shard: "crates/successor-sim#authority_bridge_server", argv: ["cargo", "build", "--locked", "-q", "-p", "successor-sim", "--example", "authority_bridge_server"], env: { CARGO_PROFILE_DEV_OPT_LEVEL: "2" }, tags: ["rust"], phase: 0, tier: "G0", category: "build" }),
    template({ id: BUILD_TASK_IDS.server, lane: "node", shard: "server", argv: ["pnpm", "--dir", "server", "build"], tags: ["node", "pnpm"], phase: 0, tier: "G0", category: "build" }),
    template({ id: BUILD_TASK_IDS.clientHeadless, lane: "node", shard: "client#headless", argv: ["pnpm", "--dir", "client", "build:headless"], tags: ["node", "pnpm"], phase: 0, tier: "G0", category: "build" }),
    template({ id: BUILD_TASK_IDS.tui, lane: "node", shard: "client-tui", argv: ["pnpm", "--dir", "client-tui", "build"], tags: ["node", "pnpm"], phase: 0, tier: "G0", category: "build" }),
    template({ id: BUILD_TASK_IDS.client3d, lane: "node", shard: "client-3d", argv: ["pnpm", "--dir", "client-3d", "build"], env: { SUCCESSOR_STOREFRONT_ORIGIN: "https://www.successorgame.com" }, tags: ["node", "pnpm"], phase: 0, tier: "G0", category: "build" }),
    template({ id: BUILD_TASK_IDS.desktop, lane: "desktop", shard: "desktop", argv: ["pnpm", "--dir", "desktop", "build"], tags: ["node", "pnpm", "linux-only"], phase: 0, tier: "G0", category: "build" }),
  ];
}

function requiredBuildTaskIds(lanes) {
  const ids = new Set();
  if (lanes.has("accel") || lanes.has("realtime")) [BUILD_TASK_IDS.authorityBridge, BUILD_TASK_IDS.server, BUILD_TASK_IDS.clientHeadless].forEach((id) => ids.add(id));
  if (lanes.has("tui")) [BUILD_TASK_IDS.authorityBridge, BUILD_TASK_IDS.server, BUILD_TASK_IDS.tui].forEach((id) => ids.add(id));
  if (lanes.has("3d")) [BUILD_TASK_IDS.authorityBridge, BUILD_TASK_IDS.server, BUILD_TASK_IDS.client3d].forEach((id) => ids.add(id));
  if (lanes.has("desktop")) [BUILD_TASK_IDS.authorityBridge, BUILD_TASK_IDS.server, BUILD_TASK_IDS.client3d, BUILD_TASK_IDS.desktop].forEach((id) => ids.add(id));
  return ids;
}

async function rustTasks(root) {
  const cratesRoot = path.join(root, "crates");
  const entries = await fs.readdir(cratesRoot, { withFileTypes: true });
  const tasks = [];
  for (const entry of entries.filter((item) => item.isDirectory()).sort((a, b) => byteCompare(a.name, b.name))) {
    const manifest = await fs.readFile(path.join(cratesRoot, entry.name, "Cargo.toml"), "utf8").catch(() => null);
    const name = manifest?.match(/^name\s*=\s*"([^"]+)"/mu)?.[1];
    if (!name) continue;
    tasks.push(template({ id: `rust:${name}`, lane: "rust", shard: name, argv: ["cargo", "test", "-p", name, "--locked"], tags: ["rust"], tier: "G1", category: "test" }));
  }
  return tasks;
}

async function nodeTasks(root) {
  const packageRoots = ["server", "client", "client-3d", "client-tui"];
  const tasks = [];
  for (const packageRoot of packageRoots) {
    const pkg = JSON.parse(await fs.readFile(path.join(root, packageRoot, "package.json"), "utf8"));
    if (!pkg.scripts?.test) continue;
    const dependencies = packageRoot === "server"
      ? [BUILD_TASK_IDS.authorityBridge, BUILD_TASK_IDS.server]
      : packageRoot === "client"
        ? [BUILD_TASK_IDS.authorityBridge, BUILD_TASK_IDS.server, BUILD_TASK_IDS.clientHeadless]
        : [];
    tasks.push(template({ id: `node:${packageRoot}`, lane: "node", shard: pkg.name ?? packageRoot, argv: ["pnpm", "--dir", packageRoot, "test"], tags: ["node", "pnpm"], dependencies, tier: "G1", category: "test" }));
  }
  return tasks;
}

async function scenarioTasks(root, lanes) {
  const scenarioRoot = path.join(root, "tools", "verification", "scenario", "scenarios");
  const files = await recursiveFiles(scenarioRoot, (name) => name.endsWith(".scenario.json"));
  const tasks = [];
  for (const absolutePath of files) {
    const relativePath = path.relative(root, absolutePath).split(path.sep).join("/");
    const scenario = JSON.parse(await fs.readFile(absolutePath, "utf8"));
    const name = String(scenario.name ?? path.basename(absolutePath, ".scenario.json"));
    const supported = new Set(scenarioSupportedLanes(scenario));
    const matrix = new Set(scenarioMatrixLanes(scenario));
    for (const lane of [...supported, ...matrix]) {
      if (lane !== "accel" && lane !== "realtime") throw new FarmError(`scenario ${name} declares unsupported farm lane ${lane}`, { code: "INVALID_TASK_REGISTRY" });
    }
    for (const lane of matrix) {
      if (!supported.has(lane)) throw new FarmError(`scenario ${name} matrix lane ${lane} is not supported`, { code: "INVALID_TASK_REGISTRY" });
    }
    for (const lane of ["accel", "realtime"]) {
      if (!lanes.has(lane) || !supported.has(lane)) continue;
      const required = matrix.has(lane);
      tasks.push(template({
        id: `${lane}:${name}`,
        lane,
        shard: relativePath,
        argv: ["pnpm", "play:gate", "--skip-build", "--scenario", relativePath, "--lane", lane, "--run-id", "$TASK_RUN_ID", "--port-base", "$PORT0"],
        env: { SUCCESSOR_PLAY_GATE_SKIP_BUILD: "1" },
        tags: ["node", "pnpm", "rust", "process-host"],
        portCount: 1,
        artifactPaths: ["verification/ledgers/artifacts/play-gate/$TASK_RUN_ID"],
        digestGroup: `scenario:${name}`,
        dependencies: [BUILD_TASK_IDS.authorityBridge, BUILD_TASK_IDS.server, BUILD_TASK_IDS.clientHeadless],
        tier: lane === "accel" ? "G2" : "G3",
        category: "gate",
        required,
        optIn: !required,
        skipBuild: true,
      }));
    }
  }
  return tasks;
}

async function tuiTasks(root) {
  const journeyRoot = path.join(root, "client-tui", "journeys", "journeys");
  const files = (await fs.readdir(journeyRoot, { withFileTypes: true })).filter((entry) => entry.isFile() && entry.name.endsWith(".mjs")).sort((a, b) => byteCompare(a.name, b.name));
  return files.map((entry) => {
    const id = entry.name.replace(/^\d+-/u, "").replace(/\.mjs$/u, "");
    return template({
      id: `tui:${id}`,
      lane: "tui",
      shard: `client-tui/journeys/journeys/${entry.name}`,
      argv: ["pnpm", "tui:gate", "--once", "--isolated", "--only", id],
      env: { TUI_GATE_PORT: "$PORT0", TUI_GATE_SKIP_BUILD: "1" },
      tags: ["node", "pnpm", "rust", "process-host"],
      portCount: 1,
      artifactPaths: ["verification/ledgers/artifacts/tui-gate/$TASK_RUN_ID"],
      dependencies: [BUILD_TASK_IDS.authorityBridge, BUILD_TASK_IDS.server, BUILD_TASK_IDS.tui],
      tier: "G3",
      category: "gate",
      skipBuild: true,
    });
  });
}

async function client3dTasks(root) {
  const journeyRoot = path.join(root, "tools", "verification", "client3d", "journeys");
  const entries = (await fs.readdir(journeyRoot, { withFileTypes: true })).filter((entry) => entry.isFile() && entry.name.endsWith(".mjs") && !entry.name.startsWith("_") && entry.name !== "index.mjs").sort((a, b) => byteCompare(a.name, b.name));
  const registered = await import(pathToFileURL(path.join(journeyRoot, "index.mjs")).href);
  if (!Array.isArray(registered.journeys)) throw new FarmError("client-3d journey registry does not export journeys", { code: "INVALID_TASK_REGISTRY" });
  const filesById = new Map();
  for (const entry of entries) {
    const text = await fs.readFile(path.join(journeyRoot, entry.name), "utf8");
    const id = text.match(/export\s+default\s*\{\s*id:\s*["']([^"']+)["']/u)?.[1];
    if (!id) continue;
    if (filesById.has(id)) throw new FarmError(`duplicate client-3d journey id ${id}`, { code: "DUPLICATE_TASK" });
    filesById.set(id, entry.name);
  }
  const tasks = [];
  for (const journey of registered.journeys) {
    const id = journey?.id;
    validateId(id, "client-3d journey id");
    const file = filesById.get(id);
    if (!file) throw new FarmError(`registered client-3d journey ${id} has no canonical source file`, { code: "INVALID_TASK_REGISTRY" });
    tasks.push(template({
      id: `3d:${id}`,
      lane: "3d",
      shard: `tools/verification/client3d/journeys/${file}`,
      argv: ["pnpm", "3d:gate", "--skip-build", "--only", id, "--concurrency", "1", "--run-id", "$TASK_RUN_ID", "--vite-port", "$PORT0", "--backend-base", "$PORT1", "--proofs-dir", "verification/ledgers/artifacts/client3d/$TASK_RUN_ID/proofs"],
      tags: ["node", "pnpm", "rust", "process-host", "playwright", "linux-only"],
      portCount: 2,
      artifactPaths: ["verification/ledgers/artifacts/client3d/$TASK_RUN_ID"],
      dependencies: [BUILD_TASK_IDS.authorityBridge, BUILD_TASK_IDS.server, BUILD_TASK_IDS.client3d],
      tier: "G4",
      category: "gate",
      skipBuild: true,
      ...(typeof journey.required === "boolean" ? { required: journey.required } : {}),
      ...(typeof journey.optIn === "boolean" ? { optIn: journey.optIn } : {}),
    }));
  }
  return tasks;
}

function audioTask() {
  return template({ id: "audio:tone-probe", lane: "audio", shard: "tools/audio/tone-probe.mjs", argv: ["node", "tools/audio/tone-probe.mjs"], tags: ["node", "playwright", "ffmpeg", "linux-only"], tier: "G4", category: "probe", required: false, optIn: true });
}

function desktopTask() {
  return template({
    id: "desktop:smoke",
    lane: "desktop",
    shard: "tools/verification/desktop-smoke.mjs",
    argv: ["pnpm", "desktop:smoke"],
    env: { DESKTOP_SMOKE_RUN_ID: "$TASK_RUN_ID", DESKTOP_SMOKE_GAME_PORT: "$PORT0", DESKTOP_SMOKE_PREVIEW_PORT: "$PORT1", DESKTOP_SMOKE_SKIP_BUILD: "1", DESKTOP_SMOKE_ALLOW_DIRTY_FIXTURE: "1" },
    tags: ["node", "pnpm", "rust", "process-host", "playwright", "linux-only"],
    portCount: 2,
    artifactPaths: ["verification/ledgers/artifacts/desktop-smoke/$TASK_RUN_ID"],
    dependencies: [BUILD_TASK_IDS.authorityBridge, BUILD_TASK_IDS.server, BUILD_TASK_IDS.client3d, BUILD_TASK_IDS.desktop],
    tier: "G4",
    category: "gate",
    required: true,
    optIn: false,
    skipBuild: true,
  });
}

function template(options) {
  return {
    cwd: ".",
    env: {},
    phase: 1,
    tier: "G1",
    category: "test",
    dependencies: [],
    required: true,
    optIn: false,
    defaultFresh: true,
    skipBuild: false,
    portCount: 0,
    artifactPaths: [],
    artifactDiscoveryRoots: [],
    digestGroup: null,
    deadlineMs: TASK_TIMEOUTS[options.lane],
    ...options,
    resourceClass: options.resourceClass ?? inferResourceClass(options),
  };
}

function inferResourceClass(task) {
  if (task.resourceClass) return task.resourceClass;
  if (task.lane === "realtime" || task.lane === "desktop") return RESOURCE_CLASSES.EXCLUSIVE;
  if (task.lane === "accel") return RESOURCE_CLASSES.BACKEND_SCENARIO;
  if (task.lane === "3d") return RESOURCE_CLASSES.BROWSER_HEAVY;
  if (task.lane === "tui") return RESOURCE_CLASSES.HEADLESS;
  if (task.category === "static") return RESOURCE_CLASSES.CPU_LIGHT;
  if (task.category === "build" && (task.lane === "desktop" || task.artifactPaths?.some((value) => value.includes("target/successor-verification")))) {
    return RESOURCE_CLASSES.EXCLUSIVE;
  }
  return task.category === "build" ? RESOURCE_CLASSES.HEADLESS : RESOURCE_CLASSES.CPU_LIGHT;
}


function validateTaskTemplate(task) {
  validateId(task.id, "task id");
  if (!ALL_LANES.includes(task.lane) || typeof task.shard !== "string") throw new FarmError(`invalid task template ${task.id}`, { code: "INVALID_TASK" });
  validateArgv(task.argv);
  validateRelativeTaskCwd(task.cwd);
  validateEnv(task.env, task.id);
  validateCapabilityTags(task.tags, task.id);
  validateTaskMetadata(task);
  if (!Number.isInteger(task.portCount) || task.portCount < 0 || task.portCount > FARM_SLOT_PORT_WINDOW_SIZE) throw new FarmError(`invalid ports for ${task.id}`, { code: "INVALID_TASK" });
  for (const artifactPath of [...task.artifactPaths, ...task.artifactDiscoveryRoots]) validateRelativePath(artifactPath.replaceAll("$TASK_RUN_ID", "run").replaceAll("$SOURCE_HASH", "source"), "task artifact path");
}

function validateMaterializedTask(task, attempt, checkout, phase1Concurrency) {
  validateId(task.id, "task id");
  validateArgv(task.argv);
  if (task.argv.some((value) => value.includes("$PORT") || value.includes("$TASK_RUN_ID") || value.includes("$SOURCE_HASH"))) throw new FarmError(`task ${task.id} contains unresolved argv tokens`, { code: "INVALID_PLAN" });
  if (task.attempt !== attempt || !Number.isFinite(task.deadlineMs) || task.deadlineMs <= 0 || task.graceMs !== 30_000) throw new FarmError(`task ${task.id} deadline is invalid`, { code: "INVALID_PLAN" });
  if (typeof task.cwd !== "string" || !path.isAbsolute(task.cwd) || !isWithin(checkout, task.cwd)) throw new FarmError(`task ${task.id} cwd violates the farm CWD contract`, { code: "INVALID_PLAN" });
  validateEnv(task.env, task.id);
  validateCapabilityTags(task.tags, task.id);
  validateTaskMetadata(task);
  if (Object.values(task.env).some((value) => value.includes("$PORT") || value.includes("$TASK_RUN_ID") || value.includes("$SOURCE_HASH"))) throw new FarmError(`task ${task.id} contains unresolved env tokens`, { code: "INVALID_PLAN" });
  validateStatePaths(task.statePaths, checkout, task.id);
  if (!Array.isArray(task.ports) || task.ports.some((port) => !Number.isInteger(port) || port < FARM_PORT_RANGE.start || port > FARM_PORT_RANGE.end || RESERVED_PORT_SET.has(port))) throw new FarmError(`task ${task.id} ports are invalid`, { code: "INVALID_PLAN" });
  if (task.phase === 0) {
    if (task.slot !== null || task.portWindow !== null || task.ports.length !== 0) throw new FarmError(`phase-0 task ${task.id} cannot own a runtime slot`, { code: "INVALID_PLAN" });
  } else {
    if (!Number.isInteger(task.slot) || task.slot < 0 || task.slot >= phase1Concurrency) throw new FarmError(`task ${task.id} slot is invalid`, { code: "INVALID_PLAN" });
    validatePortWindow(task.portWindow, task.id);
    if (task.ports.some((port) => port < task.portWindow.start || port > task.portWindow.end)) throw new FarmError(`task ${task.id} ports escape its slot window`, { code: "INVALID_PLAN" });
  }
  for (const relative of [...task.artifactPaths, ...task.artifactDiscoveryRoots]) {
    validateRelativePath(relative, "task artifact path");
    if (relative.includes("$PORT") || relative.includes("$TASK_RUN_ID") || relative.includes("$SOURCE_HASH")) throw new FarmError(`task ${task.id} contains unresolved artifact tokens`, { code: "INVALID_PLAN" });
  }
  if (task.digest !== taskDigest(task)) throw new FarmError(`task digest mismatch for ${task.id}`, { code: "TASK_DIGEST_MISMATCH" });
}
function resolveTaskCwd(checkout, templateCwd) {
  if (typeof checkout !== "string" || !path.isAbsolute(checkout)) throw new FarmError("farm host checkout must be absolute", { code: "INVALID_PLAN" });
  validateRelativeTaskCwd(templateCwd);
  const resolved = path.resolve(checkout, templateCwd);
  if (!isWithin(checkout, resolved)) throw new FarmError("task cwd escapes the checkout", { code: "INVALID_PLAN" });
  return resolved;
}

function validateRelativeTaskCwd(value) {
  if (typeof value !== "string" || value.includes("\0") || value.includes("\\") || path.posix.isAbsolute(value)) throw new FarmError("task cwd is invalid", { code: "INVALID_TASK" });
  if (value !== ".") validateRelativePath(value, "task cwd");
}

function validateEnv(env, taskId) {
  if (!env || typeof env !== "object" || Array.isArray(env) || Object.entries(env).some(([key, value]) => !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key) || typeof value !== "string" || value.includes("\0"))) {
    throw new FarmError(`invalid env for ${taskId}`, { code: "INVALID_TASK" });
  }
}

function isWithin(root, target) {
  const absoluteRoot = path.resolve(root);
  const absoluteTarget = path.resolve(target);
  return absoluteTarget === absoluteRoot || absoluteTarget.startsWith(`${absoluteRoot}${path.sep}`);
}


function validateArgv(argv) {
  if (!Array.isArray(argv) || argv.length === 0 || argv.some((value) => typeof value !== "string" || value.length === 0 || value.includes("\0"))) throw new FarmError("task argv is invalid", { code: "INVALID_TASK" });
}

function replaceTokens(values, replacements) {
  return values.map((value) => replaceToken(value, replacements));
}

function replaceToken(value, replacements) {
  let output = String(value);
  for (const [token, replacement] of Object.entries(replacements)) output = output.replaceAll(token, replacement);
  return output;
}

function matchesSelector(task, selector) {
  const escaped = selector.replace(/[.+?^${}()|[\]\\]/gu, "\\$&").replaceAll("*", ".*");
  const regex = new RegExp(`^${escaped}$`, "u");
  return regex.test(task.id) || regex.test(task.shard) || (!selector.includes("*") && (task.id.includes(selector) || task.shard.includes(selector)));
}

async function recursiveFiles(root, predicate) {
  const output = [];
  async function visit(directory) {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => byteCompare(left.name, right.name));
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile() && predicate(entry.name)) output.push(absolute);
    }
  }
  await visit(root);
  return output;
}

function splitList(value) {
  if (Array.isArray(value)) return value.flatMap(splitList);
  if (value === undefined || value === null || value === "") return [];
  return String(value).split(",").map((item) => item.trim()).filter(Boolean);
}

function validateTaskMetadata(task) {
  const resourceClass = resourceClassForTask(task);
  if (!VALID_RESOURCE_CLASSES.has(resourceClass)) throw new FarmError(`task ${task.id} resource class is invalid`, { code: "INVALID_TASK" });
  if (task.phase !== 0 && task.phase !== 1) throw new FarmError(`task ${task.id} phase is invalid`, { code: "INVALID_TASK" });
  if (!VALID_GATE_TIERS.has(task.tier) || !VALID_TASK_CATEGORIES.has(task.category)) throw new FarmError(`task ${task.id} verification metadata is invalid`, { code: "INVALID_TASK" });
  if (!Array.isArray(task.dependencies) || new Set(task.dependencies).size !== task.dependencies.length) throw new FarmError(`task ${task.id} dependencies are invalid`, { code: "INVALID_TASK" });
  task.dependencies.forEach((dependency) => validateId(dependency, `task ${task.id} dependency`));
  if (task.phase === 0 && task.dependencies.length > 0) throw new FarmError(`phase-0 task ${task.id} cannot depend on another task`, { code: "INVALID_TASK" });
  if (task.phase === 0 && task.tier !== "G0") throw new FarmError(`phase-0 task ${task.id} must be tier G0`, { code: "INVALID_TASK" });
  if (typeof task.required !== "boolean" || typeof task.optIn !== "boolean" || typeof task.defaultFresh !== "boolean" || typeof task.skipBuild !== "boolean") throw new FarmError(`task ${task.id} policy metadata is invalid`, { code: "INVALID_TASK" });
  if (task.required && task.optIn) throw new FarmError(`task ${task.id} cannot be both required and opt-in`, { code: "INVALID_TASK" });
  if (task.phase === 1 && task.category === "gate" && !task.skipBuild) throw new FarmError(`phase-1 gate ${task.id} must declare skip-build`, { code: "INVALID_TASK" });
}

function validateCapabilityTags(tags, taskId) {
  if (!Array.isArray(tags) || new Set(tags).size !== tags.length || tags.some((tag) => typeof tag !== "string" || !KNOWN_CAPABILITY_TAGS.has(tag))) throw new FarmError(`invalid tags for ${taskId}`, { code: "INVALID_TASK" });
  if (tags.includes("linux-only") && tags.includes("macos-only")) throw new FarmError(`conflicting platform tags for ${taskId}`, { code: "INVALID_TASK" });
}

function validateStatePaths(statePaths, checkout, taskId) {
  if (!statePaths || typeof statePaths !== "object") throw new FarmError(`task ${taskId} state paths are missing`, { code: "INVALID_PLAN" });
  for (const key of ["runDir", "shardPath", "storePath"]) {
    const value = statePaths[key];
    if (typeof value !== "string" || !path.isAbsolute(value) || !isWithin(checkout, value)) throw new FarmError(`task ${taskId} ${key} violates state isolation`, { code: "INVALID_PLAN" });
  }
  if (!isWithin(statePaths.runDir, statePaths.shardPath) || !isWithin(statePaths.runDir, statePaths.storePath)) throw new FarmError(`task ${taskId} state files escape its run directory`, { code: "INVALID_PLAN" });
}

function validatePortWindow(window, taskId) {
  if (!window || !Number.isInteger(window.start) || !Number.isInteger(window.end) || !Number.isInteger(window.size) || window.size !== window.end - window.start + 1 || window.size !== FARM_SLOT_PORT_WINDOW_SIZE) throw new FarmError(`task ${taskId} port window is invalid`, { code: "INVALID_PLAN" });
  if (window.start < FARM_PORT_RANGE.start || window.end > FARM_PORT_RANGE.end) throw new FarmError(`task ${taskId} port window escapes the farm capability range`, { code: "INVALID_PLAN" });
  for (let port = window.start; port <= window.end; port += 1) if (RESERVED_PORT_SET.has(port)) throw new FarmError(`task ${taskId} port window contains reserved port ${port}`, { code: "RESERVED_PORT" });
}

function validatePlanTopology(plan) {
  let sawPhase1 = false;
  const statePaths = new Set();
  const windowsBySlot = new Map();
  for (const task of plan.tasks) {
    if (task.phase === 1) sawPhase1 = true;
    else if (sawPhase1) throw new FarmError("phase-0 tasks must precede phase-1 tasks", { code: "INVALID_PLAN" });
    for (const value of Object.values(task.statePaths)) {
      if (statePaths.has(value)) throw new FarmError(`task state path is reused: ${value}`, { code: "STATE_PATH_COLLISION" });
      statePaths.add(value);
    }
    if (task.slot === null) continue;
    const prior = windowsBySlot.get(task.slot);
    if (prior && canonicalJson(prior) !== canonicalJson(task.portWindow)) throw new FarmError(`slot ${task.slot} has inconsistent port windows`, { code: "PORT_WINDOW_COLLISION" });
    windowsBySlot.set(task.slot, task.portWindow);
  }
  const slots = [...windowsBySlot.entries()];
  for (let left = 0; left < slots.length; left += 1) {
    for (let right = left + 1; right < slots.length; right += 1) {
      const [leftSlot, leftWindow] = slots[left];
      const [rightSlot, rightWindow] = slots[right];
      if (leftWindow.start <= rightWindow.end && rightWindow.start <= leftWindow.end) throw new FarmError(`slots ${leftSlot} and ${rightSlot} overlap`, { code: "PORT_WINDOW_COLLISION" });
    }
  }
  if (plan.tasks.some((task) => task.phase === 1) !== (plan.phase1Concurrency > 0)) throw new FarmError("phase1Concurrency does not match plan tasks", { code: "INVALID_PLAN" });
}

function availablePortWindows(range) {
  const start = Number(range?.start);
  const size = Number(range?.size);
  const end = Number.isInteger(range?.end) ? range.end : start + size - 1;
  if (!Number.isInteger(start) || !Number.isInteger(size) || size <= 0 || !Number.isInteger(end) || end !== start + size - 1 || start < FARM_PORT_RANGE.start || end > FARM_PORT_RANGE.end) {
    throw new FarmError("host capability does not expose a proven 29700-29799 farm port range", { code: "INSUFFICIENT_PORT_RANGE" });
  }
  const windows = [];
  let cursor = start;
  while (cursor + FARM_SLOT_PORT_WINDOW_SIZE - 1 <= end && windows.length < DEFAULT_PHASE1_CONCURRENCY) {
    const windowEnd = cursor + FARM_SLOT_PORT_WINDOW_SIZE - 1;
    const reserved = RESERVED_FARM_PORTS.find((port) => port >= cursor && port <= windowEnd);
    if (reserved !== undefined) {
      cursor = reserved + 1;
      continue;
    }
    windows.push({ start: cursor, end: windowEnd, size: FARM_SLOT_PORT_WINDOW_SIZE });
    cursor = windowEnd + 1;
  }
  if (windows.length === 0) throw new FarmError("host capability range has no safe farm port window", { code: "INSUFFICIENT_PORT_RANGE" });
  return windows;
}

function assignPhase1Slots(tasks, concurrency) {
  const slots = Array.from({ length: concurrency }, (_, slot) => ({ slot, projectedMs: 0 }));
  const assigned = new Map();
  const ordered = [...tasks].sort((left, right) => positiveNumber(right.estimateMs, 60_000) - positiveNumber(left.estimateMs, 60_000) || byteCompare(left.id, right.id));
  for (const task of ordered) {
    slots.sort((left, right) => left.projectedMs - right.projectedMs || left.slot - right.slot);
    const target = slots[0];
    assigned.set(task.id, target.slot);
    target.projectedMs += positiveNumber(task.estimateMs, 60_000);
  }
  return assigned;
}

function rematerializeTaskForAttempt(task, runId, checkout, attempt) {
  const previousTaskRunId = task.taskRunId;
  if (typeof previousTaskRunId !== "string" || previousTaskRunId.length === 0) {
    throw new FarmError(`task ${task.id} is missing a materialized taskRunId`, { code: "INVALID_PLAN" });
  }
  const taskRunId = boundedTaskRunId(runId, task.id, attempt);
  const statePaths = materializeStatePaths(checkout, taskRunId);
  const rewrite = (value) => String(value).replaceAll(previousTaskRunId, taskRunId);
  const env = Object.fromEntries(Object.entries(task.env ?? {}).map(([key, value]) => [key, rewrite(value)]));
  env.SUCCESSOR_PROCESS_RUN_ID = taskRunId;
  env.SUCCESSOR_PROCESS_RUN_DIR = statePaths.runDir;
  env.SUCCESSOR_FARM_SHARD_PATH = statePaths.shardPath;
  env.SUCCESSOR_FARM_STORE_PATH = statePaths.storePath;
  const rematerialized = {
    ...task,
    attempt,
    taskRunId,
    statePaths,
    argv: task.argv.map(rewrite),
    env,
    artifactPaths: task.artifactPaths.map(rewrite),
  };
  rematerialized.digest = taskDigest(rematerialized);
  return rematerialized;
}

function materializeStatePaths(checkout, taskRunId) {
  const runDir = path.resolve(checkout, "verification", ".runs", "farm", safeName(taskRunId));
  return { runDir, shardPath: path.join(runDir, "shard"), storePath: path.join(runDir, "characters.json") };
}

function boundedTaskRunId(runId, taskId, attempt) {
  const candidate = `${runId}-${safeName(taskId)}-a${attempt}`;
  if (candidate.length <= 150) return candidate;
  return `${candidate.slice(0, 133)}-${sha256Json([runId, taskId, attempt]).slice(0, 16)}`;
}

function withDirectDependencies(allTasks, selectedTasks) {
  const wanted = new Set(selectedTasks.map((task) => task.id));
  for (const task of selectedTasks) task.dependencies.forEach((dependency) => wanted.add(dependency));
  return allTasks.filter((task) => wanted.has(task.id));
}

function estimatedTasks(tasks, timings) {
  return tasks.map((task) => ({ task, estimateMs: estimateTaskMs(task, timings) }))
    .sort((left, right) => right.estimateMs - left.estimateMs || byteCompare(left.task.id, right.task.id));
}

function assignEstimatedTask(target, item) {
  const coreWeight = positiveNumber(target.host.coreWeight, 1);
  const projectedDurationMs = item.estimateMs / coreWeight;
  target.tasks.push({ ...item.task, estimateMs: item.estimateMs, projectedDurationMs });
  target.projectedMs += projectedDurationMs;
}

function compareTasksByPhase(left, right) {
  return taskPhase(left) - taskPhase(right) || byteCompare(left.id, right.id);
}

function taskPhase(task) {
  return task.phase === 0 ? 0 : 1;
}

function taskDependencies(task) {
  return Array.isArray(task.dependencies) ? task.dependencies : [];
}


function positiveNumber(value, fallback) {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function byteCompare(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function round(value) {
  return Math.round(value * 1000) / 1000;
}
