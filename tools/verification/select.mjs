#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { FarmError, errorDocument, parseArgs, printJson, repoRoot } from "./farm/common.mjs";
import { buildTaskGraph } from "./farm/task-plan.mjs";
import { SOURCE_MANIFEST_SCHEMA, createLocalSourceIdentity } from "./farm/source-hash.mjs";
import { writeJsonAtomic } from "./farm/protocol.mjs";

export const VERIFY_SELECTION_SCHEMA = "successor.verify-selection.v1";

const COVERAGE_MAP_PATH = "tools/verification/coverage/coverage-map.json";
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const DOC_PATH_PATTERN = /^(?:docs\/|README(?:\.|$)|AGENTS\.md$|[^/]+\.md$)/u;
const SCENARIO_PATH_PATTERN = /^tools\/verification\/scenario\/scenarios\/(?:.*\/)?([^/]+)\.scenario\.json$/u;
const TUI_JOURNEY_PATH_PATTERN = /^client-tui\/journeys\/journeys\/([^/]+)\.mjs$/u;
const CLIENT3D_JOURNEY_PATH_PATTERN = /^tools\/verification\/client3d\/journeys\/([^/]+)\.mjs$/u;
const CODE_LIKE_PATH_PATTERN = /(?:^|\/)(?:Cargo\.(?:lock|toml)|package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|tsconfig[^/]*\.json|vite[^/]*\.[cm]?[jt]s|[^/]+\.(?:cjs|css|html|js|json|jsx|mjs|rs|scss|toml|ts|tsx|wasm|yaml|yml))$/u;
const OPT_IN_WORD_PATTERN = /(?:^|[-_:])(feel|perf|performance|soak|audio)(?:$|[-_:])/iu;
const FIXTURE_PATH_PATTERN = /^(?:client\/public\/successor-slice\/|tools\/successor\/(?:configure-open-desert-fixture|compile-map-bundle|structure-collision))/u;
const SAVE_WIRE_PATH_PATTERN = /^(?:server-rs\/|server\/.*(?:schema|wire|state|checkpoint|protocol|command)|spec\/(?:.*(?:wire|save|schema))|crates\/successor-(?:core|net|inventory|wasm|sim)\/.*(?:schema|wire|state|checkpoint|protocol|command)|tools\/codegen\/generated\/)/iu;
const DEPLOY_PATH_PATTERN = /^(?:ops\/(?:deploy|docker)\/|\.github\/workflows\/.*(?:deploy|release|staging))/iu;

export function validateSourceManifest(manifest, label = "source manifest") {
  if (!manifest || manifest.schema !== SOURCE_MANIFEST_SCHEMA || !SHA256_PATTERN.test(manifest.sourceHash ?? "")) {
    throw new FarmError(`${label} is invalid`, { code: "INVALID_SOURCE_MANIFEST" });
  }
  if (!Number.isSafeInteger(manifest.fileCount) || manifest.fileCount < 0 || !Number.isSafeInteger(manifest.totalBytes) || manifest.totalBytes < 0 || !Array.isArray(manifest.entries)) {
    throw new FarmError(`${label} counters are invalid`, { code: "INVALID_SOURCE_MANIFEST" });
  }
  if (manifest.fileCount !== manifest.entries.length) {
    throw new FarmError(`${label} fileCount does not match its entries`, { code: "INVALID_SOURCE_MANIFEST" });
  }
  const paths = new Set();
  let totalBytes = 0;
  for (const entry of manifest.entries) {
    validateManifestEntry(entry, label);
    if (paths.has(entry.path)) throw new FarmError(`${label} contains duplicate path ${entry.path}`, { code: "INVALID_SOURCE_MANIFEST" });
    paths.add(entry.path);
    totalBytes += entry.size;
  }
  if (totalBytes !== manifest.totalBytes) {
    throw new FarmError(`${label} totalBytes does not match its entries`, { code: "INVALID_SOURCE_MANIFEST" });
  }
  return manifest;
}

export function diffSourceManifests(baselineManifest, currentManifest) {
  validateSourceManifest(baselineManifest, "baseline source manifest");
  validateSourceManifest(currentManifest, "current source manifest");
  const baseline = new Map(baselineManifest.entries.map((entry) => [entry.path, entry]));
  const current = new Map(currentManifest.entries.map((entry) => [entry.path, entry]));
  const changed = [];
  for (const sourcePath of new Set([...baseline.keys(), ...current.keys()])) {
    const before = baseline.get(sourcePath);
    const after = current.get(sourcePath);
    if (!before || !after || manifestEntryFingerprint(before) !== manifestEntryFingerprint(after)) changed.push(sourcePath);
  }
  return changed.sort(byteCompare);
}

export function buildCoverageIndex({ coverageMap, tasks }) {
  validateCoverageMap(coverageMap);
  validateTasks(tasks);
  const taskById = new Map(tasks.map((task) => [task.id, task]));
  const systemById = new Map(coverageMap.systems.map((system) => [system.id, system]));
  const systemsByFile = new Map();
  for (const command of coverageMap.commands) {
    if (!systemById.has(command.systemId)) continue;
    for (const ref of command.refs?.files ?? []) addMapSet(systemsByFile, normalizeSourcePath(ref.path), command.systemId);
  }

  const scenarioTaskIds = preferredScenarioTaskMap(tasks);
  const taskIdsBySystem = new Map();
  for (const system of coverageMap.systems) {
    const taskIds = new Set();
    for (const scenarioName of system.scenarioRefs ?? []) {
      const taskId = scenarioTaskIds.get(scenarioName);
      if (taskId) taskIds.add(taskId);
    }
    for (const journeyPath of system.tuiJourneys ?? []) addExistingShardTask(taskIds, tasks, normalizeSourcePath(journeyPath), "tui");
    for (const journeyPath of system.client3dJourneys ?? []) addExistingShardTask(taskIds, tasks, normalizeSourcePath(journeyPath), "3d");
    taskIdsBySystem.set(system.id, taskIds);
  }

  return {
    taskById,
    systemsByFile,
    taskIdsBySystem,
    scenarioTaskIds,
    tuiTaskIdsByShard: shardTaskMap(tasks, "tui"),
    client3dTaskIdsByShard: shardTaskMap(tasks, "3d"),
  };
}

export function selectVerificationTasks({
  tasks,
  coverageMap,
  changedPaths,
  mode = "fast",
  currentManifest,
  baselineManifest,
  baselinePath = null,
} = {}) {
  validateTasks(tasks);
  if (!new Set(["fast", "full"]).has(mode)) throw new FarmError(`unsupported verification mode ${mode}`, { code: "INVALID_VERIFY_MODE" });
  validateSourceManifest(currentManifest, "current source manifest");
  if (mode === "fast" && changedPaths === undefined && !baselineManifest) {
    throw new FarmError("verify:fast requires an explicit verified baseline source manifest; pass --base <manifest.json> or explicitly choose full selection", { code: "BASELINE_REQUIRED" });
  }
  if (baselineManifest) validateSourceManifest(baselineManifest, "baseline source manifest");

  const resolvedChangedPaths = mode === "full"
    ? []
    : normalizeChangedPaths(changedPaths ?? diffSourceManifests(baselineManifest, currentManifest));
  const index = buildCoverageIndex({ coverageMap, tasks });
  const selected = new Set();
  const ruleRecords = [];
  const evidence = [];
  const staticTaskIds = tasks.filter(isStaticTruthTask).map((task) => task.id).sort(byteCompare);
  if (staticTaskIds.length === 0) {
    throw new FarmError("farm task graph exposes no static G0 truth checks", { code: "G0_TASKS_MISSING" });
  }
  selectRule({ selected, ruleRecords, evidence, id: "static-g0", kind: "static", paths: [], taskIds: staticTaskIds });

  if (mode === "full") {
    const fullIds = tasks.filter(isDefaultRequiredTask).map((task) => task.id).sort(byteCompare);
    selectRule({ selected, ruleRecords, evidence, id: "full-required-g0-g4", kind: "full", paths: [], taskIds: fullIds });
  } else {
    for (const changedPath of resolvedChangedPaths) selectChangedPath({ changedPath, tasks, coverageMap, index, selected, ruleRecords, evidence });
    if (resolvedChangedPaths.length === 0) {
      selectRule({ selected, ruleRecords, evidence, id: "no-source-changes", kind: "scope-noop", paths: [], taskIds: [] });
    }
  }

  const taskIds = [...selected].sort(byteCompare);
  const nonStaticIds = taskIds.filter((taskId) => !staticTaskIds.includes(taskId));
  const noOpScope = mode === "fast" && nonStaticIds.length === 0;
  const current = manifestSummary(currentManifest);
  const baseline = baselineManifest ? { ...manifestSummary(baselineManifest), path: baselinePath } : null;
  return {
    schema: VERIFY_SELECTION_SCHEMA,
    mode,
    source: {
      currentHash: current.sourceHash,
      current,
      baselineHash: baseline?.sourceHash ?? null,
      baseline,
    },
    changedPaths: resolvedChangedPaths,
    rules: normalizeRules(ruleRecords),
    taskIds,
    noOpScope,
    coverageEvidence: normalizeEvidence(evidence),
    cache: {
      enabled: false,
      sourceHash: current.sourceHash,
      reason: mode === "full" ? "full-mode-fresh" : "no-provenance-cache",
    },
  };
}

export async function createVerificationSelection({
  root = repoRoot,
  mode = "fast",
  baselinePath,
  changedPaths,
  tasks,
  coverageMap,
} = {}) {
  if (mode === "fast" && changedPaths === undefined && !baselinePath) {
    throw new FarmError("verify:fast requires an explicit verified baseline source manifest; pass --base <manifest.json> or explicitly choose full selection", { code: "BASELINE_REQUIRED" });
  }
  const absoluteRoot = path.resolve(root);
  const [resolvedTasks, resolvedCoverage, currentIdentity] = await Promise.all([
    tasks ?? buildTaskGraph({ root: absoluteRoot, lanes: "all" }),
    coverageMap ?? readJson(path.join(absoluteRoot, COVERAGE_MAP_PATH), "coverage map"),
    createLocalSourceIdentity({ root: absoluteRoot, includeManifest: true }),
  ]);
  let baselineManifest = null;
  let absoluteBaselinePath = null;
  if (baselinePath) {
    absoluteBaselinePath = path.resolve(absoluteRoot, baselinePath);
    baselineManifest = extractSourceManifest(await readJson(absoluteBaselinePath, "baseline source manifest"));
  }
  return selectVerificationTasks({
    tasks: resolvedTasks,
    coverageMap: resolvedCoverage,
    changedPaths,
    mode,
    currentManifest: currentIdentity.manifest,
    baselineManifest,
    baselinePath: absoluteBaselinePath,
  });
}

function selectChangedPath({ changedPath, tasks, coverageMap, index, selected, ruleRecords, evidence }) {
  if (isDocumentationPath(changedPath)) {
    selectRule({ selected, ruleRecords, evidence, id: "documentation-only", kind: "scope-noop", paths: [changedPath], taskIds: [] });
    return;
  }

  if (FIXTURE_PATH_PATTERN.test(changedPath)) {
    selectAlphaSurface({ changedPath, ruleId: "fixture-map", kind: "fixture-gate", tasks, selected, ruleRecords, evidence, taskIds: tasks.filter((task) => task.id === "static:fixture" || task.id === "rust:successor-sim" || task.id === "node:server").map((task) => task.id) });
    return;
  }

  if (SAVE_WIRE_PATH_PATTERN.test(changedPath)) {
    const taskIds = tasks.filter((task) => isDefaultRequiredTask(task) && (task.lane === "rust" || task.id === "node:server" || ["accel", "tui", "3d"].includes(task.lane))).map((task) => task.id);
    selectAlphaSurface({ changedPath, ruleId: "save-wire-contract", kind: "contract-gate", tasks, selected, ruleRecords, evidence, taskIds });
    return;
  }

  if (DEPLOY_PATH_PATTERN.test(changedPath)) {
    const taskIds = tasks.filter((task) => task.id === "static:deploy-contract" || task.id === "node:server").map((task) => task.id);
    selectAlphaSurface({ changedPath, ruleId: "deploy-runtime", kind: "deploy-gate", tasks, selected, ruleRecords, evidence, taskIds });
    return;
  }

  const scenarioMatch = changedPath.match(SCENARIO_PATH_PATTERN);
  if (scenarioMatch) {
    const taskId = index.scenarioTaskIds.get(scenarioMatch[1]);
    selectRule({ selected, ruleRecords, evidence, id: "scenario-ref", kind: "scenario-ref", paths: [changedPath], taskIds: taskId ? [taskId] : [] });
    if (!taskId) selectUnknownPath({ changedPath, tasks, selected, ruleRecords, evidence });
    return;
  }

  if (TUI_JOURNEY_PATH_PATTERN.test(changedPath)) {
    const taskId = index.tuiTaskIdsByShard.get(changedPath);
    selectRule({ selected, ruleRecords, evidence, id: "tui-journey", kind: "tui-journey", paths: [changedPath], taskIds: taskId ? [taskId] : [] });
    if (!taskId) selectUnknownPath({ changedPath, tasks, selected, ruleRecords, evidence });
    return;
  }

  if (CLIENT3D_JOURNEY_PATH_PATTERN.test(changedPath)) {
    const taskId = index.client3dTaskIdsByShard.get(changedPath);
    selectRule({ selected, ruleRecords, evidence, id: "client3d-journey", kind: "client3d-journey", paths: [changedPath], taskIds: taskId ? [taskId] : [] });
    if (!taskId) selectUnknownPath({ changedPath, tasks, selected, ruleRecords, evidence });
    return;
  }

  if (changedPath === COVERAGE_MAP_PATH) {
    selectRule({
      selected,
      ruleRecords,
      evidence,
      id: "coverage-registry-change",
      kind: "coverage-ref",
      paths: [changedPath],
      systemIds: coverageMap.systems.map((system) => system.id),
      taskIds: tasks.filter(isDefaultRequiredTask).map((task) => task.id),
    });
    return;
  }

  const directTaskIds = tasks.filter((task) => task.shard === changedPath).map((task) => task.id);
  if (directTaskIds.length > 0) {
    selectRule({ selected, ruleRecords, evidence, id: "farm-shard", kind: "farm-shard", paths: [changedPath], taskIds: directTaskIds });
  }

  const systemIds = [...(index.systemsByFile.get(changedPath) ?? [])].sort(byteCompare);
  if (systemIds.length > 0) {
    const taskIds = systemIds.flatMap((systemId) => [...(index.taskIdsBySystem.get(systemId) ?? [])]);
    selectRule({ selected, ruleRecords, evidence, id: "coverage-file-ref", kind: "coverage-ref", paths: [changedPath], systemIds, taskIds });
  }

  const structural = structuralTaskSelection(changedPath, tasks);
  if (structural.taskIds.length > 0) {
    selectRule({ selected, ruleRecords, evidence, id: structural.ruleId, kind: "package-fallback", paths: [changedPath], taskIds: structural.taskIds });
    return;
  }
  if (systemIds.length === 0 && directTaskIds.length === 0) selectUnknownPath({ changedPath, tasks, selected, ruleRecords, evidence });
}

function selectAlphaSurface({ changedPath, ruleId, kind, tasks, selected, ruleRecords, evidence, taskIds }) {
  selectRule({ selected, ruleRecords, evidence, id: ruleId, kind, paths: [changedPath], taskIds: taskIds.filter((taskId) => tasks.some((task) => task.id === taskId)) });
}

function structuralTaskSelection(changedPath, tasks) {
  const ids = new Set();
  const addId = (taskId) => { if (tasks.some((task) => task.id === taskId)) ids.add(taskId); };
  const addLane = (lane) => tasks.filter((task) => task.lane === lane && isDefaultRequiredTask(task)).forEach((task) => ids.add(task.id));
  const crateMatch = changedPath.match(/^crates\/([^/]+)\//u);
  if (crateMatch) {
    addId(`rust:${crateMatch[1]}`);
    if (crateMatch[1] === "successor-sim" && changedPath.startsWith("crates/successor-sim/src/authority/")) addLane("accel");
    return { ruleId: "rust-package", taskIds: [...ids] };
  }
  if (changedPath.startsWith("server/")) {
    addId("node:server");
    if (changedPath.startsWith("server/src/game/")) addLane("accel");
    return { ruleId: "server-package", taskIds: [...ids] };
  }
  if (changedPath.startsWith("client-tui/")) {
    addId("node:client-tui");
    addLane("tui");
    return { ruleId: "client-tui-package", taskIds: [...ids] };
  }
  if (changedPath.startsWith("client-3d/")) {
    addId("node:client-3d");
    addLane("3d");
    return { ruleId: "client-3d-package", taskIds: [...ids] };
  }
  if (changedPath.startsWith("desktop/")) {
    addId("desktop:smoke");
    return { ruleId: "desktop-package", taskIds: [...ids] };
  }
  if (changedPath.startsWith("client/")) {
    addId("node:client");
    if (changedPath.startsWith("client/src/headless/")) addLane("accel");
    return { ruleId: "client-package", taskIds: [...ids] };
  }
  if (changedPath.startsWith("tools/verification/scenario/")) {
    addLane("accel");
    return { ruleId: "scenario-infrastructure", taskIds: [...ids] };
  }
  if (changedPath.startsWith("tools/verification/client3d/")) {
    addId("node:client-3d");
    addLane("3d");
    return { ruleId: "client3d-infrastructure", taskIds: [...ids] };
  }
  return { ruleId: "unmapped", taskIds: [] };
}

function selectUnknownPath({ changedPath, tasks, selected, ruleRecords, evidence }) {
  const taskIds = CODE_LIKE_PATH_PATTERN.test(changedPath)
    ? tasks.filter((task) => (task.lane === "node" || task.lane === "rust") && isDefaultRequiredTask(task)).map((task) => task.id)
    : [];
  selectRule({
    selected,
    ruleRecords,
    evidence,
    id: taskIds.length > 0 ? "unknown-code-conservative-units" : "unknown-noncode-noop",
    kind: taskIds.length > 0 ? "package-fallback" : "scope-noop",
    paths: [changedPath],
    taskIds,
  });
}

function selectRule({ selected, ruleRecords, evidence, id, kind, paths, taskIds, systemIds = [] }) {
  const normalizedIds = [...new Set(taskIds)].sort(byteCompare);
  normalizedIds.forEach((taskId) => selected.add(taskId));
  ruleRecords.push({ id, paths: [...paths], taskIds: normalizedIds });
  evidence.push({ kind, path: paths[0] ?? null, systemIds: [...new Set(systemIds)].sort(byteCompare), taskIds: normalizedIds });
}

function isStaticTruthTask(task) {
  if (task.id.startsWith("static:") || task.id.startsWith("g0:") || task.category === "static" || task.group === "static-g0") return true;
  if (task.category === "build") return false;
  return task.tier === "G0" || task.gate === "G0" || task.verificationTier === "G0";
}

function isDefaultRequiredTask(task) {
  if (task.required === false || task.optIn === true) return false;
  const category = String(task.category ?? task.tier ?? task.group ?? "");
  if (OPT_IN_WORD_PATTERN.test(category) || OPT_IN_WORD_PATTERN.test(task.id)) return false;
  if (Array.isArray(task.tags) && task.tags.some((tag) => OPT_IN_WORD_PATTERN.test(String(tag)))) return false;
  return true;
}

function normalizeRules(records) {
  const merged = new Map();
  for (const record of records) {
    const prior = merged.get(record.id) ?? { id: record.id, paths: new Set(), taskIds: new Set() };
    record.paths.forEach((value) => prior.paths.add(value));
    record.taskIds.forEach((value) => prior.taskIds.add(value));
    merged.set(record.id, prior);
  }
  return [...merged.values()].map((record) => ({
    id: record.id,
    paths: [...record.paths].sort(byteCompare),
    taskIds: [...record.taskIds].sort(byteCompare),
  })).sort((left, right) => byteCompare(left.id, right.id));
}

function normalizeEvidence(records) {
  const seen = new Set();
  const output = [];
  for (const record of records) {
    const normalized = {
      kind: record.kind,
      path: record.path,
      systemIds: [...record.systemIds].sort(byteCompare),
      taskIds: [...record.taskIds].sort(byteCompare),
    };
    const key = JSON.stringify(normalized);
    if (!seen.has(key)) {
      seen.add(key);
      output.push(normalized);
    }
  }
  return output.sort((left, right) => byteCompare(`${left.path ?? ""}\0${left.kind}\0${left.taskIds.join("\0")}`, `${right.path ?? ""}\0${right.kind}\0${right.taskIds.join("\0")}`));
}

function validateManifestEntry(entry, label) {
  if (!entry || typeof entry.path !== "string" || entry.path.length === 0 || entry.path.startsWith("/") || entry.path.includes("\\") || entry.path.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new FarmError(`${label} contains an invalid entry path`, { code: "INVALID_SOURCE_MANIFEST" });
  }
  if (!new Set(["file", "symlink"]).has(entry.type) || typeof entry.executable !== "boolean" || !Number.isSafeInteger(entry.size) || entry.size < 0 || !SHA256_PATTERN.test(entry.contentSha256 ?? "")) {
    throw new FarmError(`${label} contains invalid entry metadata for ${entry.path}`, { code: "INVALID_SOURCE_MANIFEST" });
  }
  if (entry.type === "symlink" && typeof entry.symlinkTarget !== "string") {
    throw new FarmError(`${label} contains an invalid symlink entry for ${entry.path}`, { code: "INVALID_SOURCE_MANIFEST" });
  }
}

function manifestEntryFingerprint(entry) {
  return JSON.stringify([entry.type, entry.executable, entry.size, entry.contentSha256, entry.type === "symlink" ? entry.symlinkTarget : null]);
}

function manifestSummary(manifest) {
  return { schema: manifest.schema, sourceHash: manifest.sourceHash, fileCount: manifest.fileCount, totalBytes: manifest.totalBytes };
}

function extractSourceManifest(document) {
  const candidates = [document, document?.manifest, document?.sourceManifest, document?.currentManifest, document?.selection?.sourceManifest];
  const manifest = candidates.find((candidate) => candidate?.schema === SOURCE_MANIFEST_SCHEMA);
  if (!manifest) throw new FarmError("baseline document does not contain a successor.source-manifest.v1 manifest", { code: "INVALID_SOURCE_MANIFEST" });
  return validateSourceManifest(manifest, "baseline source manifest");
}

function validateCoverageMap(coverageMap) {
  if (!coverageMap || coverageMap.schema !== "successor.coverage-registry.v1" || !Array.isArray(coverageMap.systems) || !Array.isArray(coverageMap.commands)) {
    throw new FarmError("coverage map is invalid", { code: "INVALID_COVERAGE_MAP" });
  }
}

function validateTasks(tasks) {
  if (!Array.isArray(tasks) || tasks.some((task) => !task || typeof task.id !== "string" || typeof task.lane !== "string" || typeof task.shard !== "string")) {
    throw new FarmError("verification task graph is invalid", { code: "INVALID_TASK_GRAPH" });
  }
  if (new Set(tasks.map((task) => task.id)).size !== tasks.length) throw new FarmError("verification task graph has duplicate IDs", { code: "INVALID_TASK_GRAPH" });
}

function preferredScenarioTaskMap(tasks) {
  const output = new Map();
  for (const task of tasks.filter((candidate) => candidate.lane === "accel")) output.set(task.id.slice("accel:".length), task.id);
  for (const task of tasks.filter((candidate) => candidate.lane === "realtime" && candidate.required !== false && candidate.optIn !== true)) {
    const scenarioName = task.id.slice("realtime:".length);
    if (!output.has(scenarioName)) output.set(scenarioName, task.id);
  }
  return output;
}

function shardTaskMap(tasks, lane) {
  return new Map(tasks.filter((task) => task.lane === lane).map((task) => [normalizeSourcePath(task.shard), task.id]));
}


function addExistingShardTask(output, tasks, shard, lane) {
  const task = tasks.find((candidate) => candidate.lane === lane && normalizeSourcePath(candidate.shard) === shard);
  if (task) output.add(task.id);
}

function addMapSet(map, key, value) {
  const values = map.get(key) ?? new Set();
  values.add(value);
  map.set(key, values);
}

function normalizeChangedPaths(paths) {
  if (!Array.isArray(paths)) throw new FarmError("changed paths must be an array", { code: "INVALID_CHANGED_PATHS" });
  return [...new Set(paths.map(normalizeSourcePath))].sort(byteCompare);
}

function normalizeSourcePath(value) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) throw new FarmError("source path is invalid", { code: "INVALID_SOURCE_PATH" });
  const normalized = value.replaceAll("\\", "/").replace(/^\.\//u, "");
  if (normalized.startsWith("/") || normalized.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new FarmError(`source path ${value} is invalid`, { code: "INVALID_SOURCE_PATH" });
  }
  return normalized;
}

function isDocumentationPath(sourcePath) {
  return DOC_PATH_PATTERN.test(sourcePath) || sourcePath.endsWith(".md");
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

async function runFastCli() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write("usage: select.mjs --base MANIFEST.json [--dry-run] [--out REPORT.json] [--pretty]\n       select.mjs --on-missing-baseline full [--dry-run] [--pretty]\n");
    return;
  }
  const root = path.resolve(String(args.root ?? repoRoot));
  const missingBaselinePolicy = String(args["on-missing-baseline"] ?? "fail");
  if (!args.base && !new Set(["fail", "full"]).has(missingBaselinePolicy)) {
    throw new FarmError("--on-missing-baseline must be fail or full", { code: "USAGE" });
  }
  const mode = args.base ? "fast" : missingBaselinePolicy === "full" ? "full" : "fast";
  const selection = await createVerificationSelection({ root, mode, ...(args.base ? { baselinePath: String(args.base) } : {}) });
  if (args["dry-run"]) {
    printJson(selection, Boolean(args.pretty));
    return;
  }
  const { runVerificationFarm } = await import("./farm/dispatch.mjs");
  if (typeof runVerificationFarm !== "function") throw new FarmError("farm dispatcher does not expose runVerificationFarm", { code: "FARM_DISPATCH_UNAVAILABLE" });
  const outcome = await runVerificationFarm({
    root,
    runId: String(args["run-id"] ?? `verify-fast-${Date.now()}`),
    taskIds: selection.taskIds,
    mode: selection.mode,
    selection,
    ...(args["artifact-root"] ? { artifactRoot: path.resolve(String(args["artifact-root"])) } : {}),
    ...(args["max-attempts"] ? { maxAttempts: Number(args["max-attempts"]) } : {}),
  });
  if (args.out) await writeJsonAtomic(path.resolve(String(args.out)), outcome.matrix);
  printJson(outcome.matrix, Boolean(args.pretty));
  if (outcome.matrix.status !== "pass") process.exitCode = 1;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  runFastCli().catch((error) => {
    printJson(errorDocument(VERIFY_SELECTION_SCHEMA, error), true);
    process.exitCode = 1;
  });
}
