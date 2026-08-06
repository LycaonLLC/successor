#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";

import { appendLedgerEntry, createRunId, repoSnapshot, writeJsonArtifact } from "./ledger.mjs";
import { allocatePorts, failureRecord, loadScenario, runScenarioFile, scenarioSupportedLanes } from "./scenario/runner.mjs";
import { checkZeroGpuDependencyGraph, formatZeroGpuReport } from "./scenario/zero-gpu-check.mjs";
import {
  acceptGoldenDigestRegistry,
  compareLaneParity,
  goldenDigestMismatches,
  loadDigestRegistry,
  speedRatios,
  writeDigestRegistry,
} from "./scenario/digest-registry.mjs";
import { createLocalSourceIdentity } from "./farm/source-hash.mjs";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const defaultScenarioDir = path.join(repoRoot, "tools", "verification", "scenario", "scenarios");

const args = parseArgs(process.argv.slice(2));
const runId = args.get("run-id") ?? createRunId("play-gate");
const startedAt = new Date().toISOString();
const started = performance.now();
const artifactRoot = path.join("verification", "ledgers", "artifacts", "play-gate", runId);
const runtimeRoot = path.join(os.tmpdir(), "successor-play-gate", runId);
let sourceIdentity = null;
let sourceIdentityAfter = null;

try {
  const zeroGpu = await checkZeroGpuDependencyGraph({
    repoRoot,
    simulateImport: args.get("simulate-zero-gpu-import"),
  });
  if (args.has("zero-gpu-check-only")) {
    console.log(formatZeroGpuReport(zeroGpu));
    if (!zeroGpu.ok) process.exitCode = 1;
    process.exit();
  }
  if (!zeroGpu.ok) throw new Error(formatZeroGpuReport(zeroGpu));

  const selection = await scenarioSelection(args);
  if (selection.length === 0) throw new Error(`no scenario files found in ${defaultScenarioDir}`);
  const requestedLane = parseLane(args.get("lane") ?? "accel");
  const runtimeBundle = await prepareRuntimeBundle({
    runtimeRoot,
    skipBuild: args.has("skip-build") || process.env.SUCCESSOR_PLAY_GATE_SKIP_BUILD === "1",
  });
  const build = runtimeBundle.build;
  sourceIdentity = await createLocalSourceIdentity({ root: repoRoot, includeManifest: false });
  const repo = await repoSnapshot(repoRoot, { sourceIdentity });
  let repoAfter = null;
  const registry = await loadDigestRegistry();
  const lanes = requestedLane === "all" ? ["accel", "realtime"] : [requestedLane];
  const ports = await allocatePorts(selection.length, { base: args.get("port-base") });
  const laneRuns = [];
  const scenarioResults = [];
  for (const lane of lanes) {
    const concurrency = laneConcurrency({ lane, count: selection.length, parsed: args });
    const laneStarted = performance.now();
    const results = await runScenarioQueue({
      selection,
      ports,
      concurrency,
      runId,
      lane,
      sourceHash: sourceIdentity.sourceHash,
      sourceIdentity,
      runtimePaths: runtimeBundle.paths,
    });
    const wallDurationMs = round(performance.now() - laneStarted);
    laneRuns.push({
      lane,
      concurrency,
      wallDurationMs,
      virtualDurationMs: round(results.reduce((total, result) => total + (Number(result.virtualDurationMs) || 0), 0)),
      passed: results.filter((result) => result.status === "pass").length,
      skipped: results.filter((result) => result.status === "skip").length,
      failed: results.filter((result) => result.status === "fail").length,
    });
    scenarioResults.push(...results);
  }
  sourceIdentityAfter = await createLocalSourceIdentity({ root: repoRoot, includeManifest: false });
  repoAfter = await repoSnapshot(repoRoot, { sourceIdentity: sourceIdentityAfter });
  for (const result of scenarioResults) {
    result.sourceIdentity = {
      before: result.sourceIdentity?.before ?? sourceIdentity,
      after: sourceIdentityAfter,
    };
  }


  const parity = requestedLane === "all" ? compareLaneParity(scenarioResults, registry) : [];
  for (const mismatch of parity.filter((comparison) => comparison.status === "fail")) {
    const message = `accel/realtime parity failed at step ${mismatch.divergenceStep ?? "unknown"}: ${mismatch.reason}; accel=${mismatch.accelDigest} realtime=${mismatch.realtimeDigest}`;
    for (const result of scenarioResults.filter((candidate) => candidate.scenario === mismatch.scenario && (candidate.lane === "accel" || candidate.lane === "realtime"))) {
      addResultFailure(result, message, { parity: mismatch });
    }
  }

  const acceptDigests = args.has("accept-digests");
  const goldenMismatches = acceptDigests ? [] : goldenDigestMismatches(scenarioResults, registry);
  for (const mismatch of goldenMismatches) {
    const result = scenarioResults.find((candidate) => candidate.scenario === mismatch.scenario && candidate.lane === mismatch.lane);
    if (!result) continue;
    addResultFailure(
      result,
      `golden digest mismatch at step ${mismatch.divergenceStep ?? "unknown"}: expected ${mismatch.expectedDigest}, got ${mismatch.actualDigest}`,
      { goldenDigest: mismatch },
    );
  }

  const goldenAcceptance = acceptDigests
    ? acceptGoldenDigestRegistry(registry, scenarioResults, repo.commit, requestedLane)
    : null;
  if (goldenAcceptance && !goldenAcceptance.ok) {
    const reason = goldenAcceptance.reasons.map((entry) => entry.code).join(", ");
    for (const result of scenarioResults) addResultFailure(result, `golden acceptance rejected: ${reason}`, { goldenAcceptance });
  }
  if (goldenAcceptance?.ok) await writeDigestRegistry(goldenAcceptance.registry);
  await persistScenarioResults(scenarioResults);

  const status = scenarioResults.every((result) => result.status === "pass" || result.status === "skip") ? "pass" : "fail";
  const durationMs = round(performance.now() - started);
  const ratios = speedRatios(scenarioResults);
  const demotions = parity.filter((comparison) => comparison.status !== "pass");
  const report = {
    schema: "successor.play-gate.v1",
    status,
    runId,
    startedAt,
    completedAt: new Date().toISOString(),
    durationMs,
    sourceHash: sourceIdentity.sourceHash,
    sourceIdentity: { before: sourceIdentity, after: sourceIdentityAfter },
    build,
    config: {
      requestedLane,
      lanes,
      concurrency: Object.fromEntries(laneRuns.map((laneRun) => [laneRun.lane, laneRun.concurrency])),
      scenarioCount: selection.length,
      runCount: scenarioResults.length,
      scenarios: selection.map((entry) => path.relative(repoRoot, entry.scenarioPath)),
      ports,
      only: args.getAll("only"),
      acceptDigests,
      goldenAcceptance,
    },
    laneRuns,
    speedRatios: ratios,
    digestParity: parity,
    demotions,
    results: scenarioResults,
  };
  const artifactPath = await writeJsonArtifact(repoRoot, path.join(artifactRoot, "play-gate-report.json"), report);
  await appendLedgerEntry(repoRoot, "play-gate-ledger", {
    runId,
    phase: "successor-scripted-play-scenarios",
    status,
    summary: status === "pass"
      ? `play:gate passed ${scenarioResults.filter((result) => result.status === "pass").length} lane-separated scenario run(s).`
      : `play:gate failed ${scenarioResults.filter((result) => result.status === "fail").length}/${scenarioResults.length} lane-separated scenario run(s).`,
    repo: { before: repo, after: repoAfter },
    sourceHash: sourceIdentity.sourceHash,
    sourceIdentity: { before: sourceIdentity, after: sourceIdentityAfter },
    command: {
      argv: ["pnpm", "play:gate", ...process.argv.slice(2)],
      cwd: repoRoot,
      durationMs,
      exitCode: status === "pass" ? 0 : 1,
      signal: null,
    },
    metrics: {
      scenarioCount: selection.length,
      runCount: scenarioResults.length,
      passed: scenarioResults.filter((result) => result.status === "pass").length,
      skipped: scenarioResults.filter((result) => result.status === "skip").length,
      failed: scenarioResults.filter((result) => result.status === "fail").length,
      zeroGpuFileCount: zeroGpu.fileCount,
      lanes: Object.fromEntries(laneRuns.map((laneRun) => [laneRun.lane, laneRun])),
      speedRatios: ratios,
      finalSnapshotDigests: Object.fromEntries(scenarioResults.map((result) => [`${result.scenario}:${result.lane}`, result.finalSnapshotDigest])),
    },
    artifacts: {
      report: artifactPath,
      scenarios: scenarioResults.map((result) => result.artifactPath).filter(Boolean),
    },
    details: {
      zeroGpu,
      build,
      digestParity: parity,
      demotions,
      goldenDigestMismatches: goldenMismatches,
      goldenAcceptance,
      failures: scenarioResults.flatMap((result) => result.failures.map((failure) => `${result.scenario}:${result.lane}: ${failure}`)),
    },
  });
  printSummary(report, artifactPath);
  if (status !== "pass") process.exitCode = 1;
} catch (error) {
  const durationMs = round(performance.now() - started);
  const message = error instanceof Error ? error.message : String(error);
  const report = {
    schema: "successor.play-gate.v1",
    status: "fail",
    runId,
    startedAt,
    completedAt: new Date().toISOString(),
    durationMs,
    sourceHash: sourceIdentity?.sourceHash ?? null,
    error: message,
  };
  const artifactPath = await writeJsonArtifact(repoRoot, path.join(artifactRoot, "play-gate-report.json"), report).catch(() => null);
  await appendLedgerEntry(repoRoot, "play-gate-ledger", {
    runId,
    phase: "successor-scripted-play-scenarios",
    status: "fail",
    summary: message.split("\n")[0],
    repo: await repoSnapshot(repoRoot, { sourceIdentity }).catch(() => ({ root: repoRoot, error: "repo snapshot failed" })),
    ...(sourceIdentity ? { sourceHash: sourceIdentity.sourceHash, sourceIdentity } : {}),
    command: { argv: ["pnpm", "play:gate", ...process.argv.slice(2)], cwd: repoRoot, durationMs, exitCode: 1, signal: null },
    metrics: {},
    artifacts: artifactPath ? { report: artifactPath } : {},
    details: { error: message },
  }).catch(() => undefined);
  console.error(message);
  process.exitCode = 1;
} finally {
  await archiveRuntimeEvidence();
}

async function archiveRuntimeEvidence() {
  const durableRuntimeRoot = path.join(repoRoot, artifactRoot, "runtime");
  try {
    await Promise.all([
      fs.rm(path.join(runtimeRoot, "server-dist", "node_modules"), { force: true }),
      fs.rm(path.join(runtimeRoot, "client-headless", "node_modules"), { force: true }),
    ]);
    await fs.rm(durableRuntimeRoot, { recursive: true, force: true });
    await fs.cp(runtimeRoot, durableRuntimeRoot, { recursive: true });
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  } finally {
    await fs.rm(runtimeRoot, { recursive: true, force: true });
  }
}

async function scenarioSelection(parsed) {
  const explicit = parsed.getAll("scenario");
  const scenarioPaths = explicit.length > 0
    ? explicit.map((item) => path.resolve(repoRoot, item))
    : (await fs.readdir(defaultScenarioDir, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith(".scenario.json"))
      .map((entry) => path.join(defaultScenarioDir, entry.name))
      .sort();
  const loaded = await Promise.all(scenarioPaths.map(async (scenarioPath) => ({
    scenarioPath,
    scenario: await loadScenario(scenarioPath),
  })));
  const only = new Set(parsed.getAll("only").flatMap((value) => String(value).split(",")).map((value) => value.trim()).filter(Boolean));
  if (only.size === 0) return loaded;
  const selected = loaded.filter(({ scenario, scenarioPath }) => {
    const basename = path.basename(scenarioPath);
    const stem = basename.replace(/\.scenario\.json$/u, "");
    return only.has(scenario.name) || only.has(basename) || only.has(stem);
  });
  const matched = new Set(selected.flatMap(({ scenario, scenarioPath }) => [scenario.name, path.basename(scenarioPath), path.basename(scenarioPath).replace(/\.scenario\.json$/u, "")]));
  const missing = [...only].filter((name) => !matched.has(name));
  if (missing.length > 0) throw new Error(`--only did not match scenario(s): ${missing.join(", ")}`);
  return selected;
}

async function prepareRuntimeBundle({ runtimeRoot, skipBuild }) {
  const serverDist = path.join(runtimeRoot, "server-dist");
  const clientHeadlessDist = path.join(runtimeRoot, "client-headless");
  await fs.rm(runtimeRoot, { recursive: true, force: true });
  await fs.mkdir(runtimeRoot, { recursive: true });

  const build = skipBuild
    ? await snapshotBuiltRuntime({ serverDist, clientHeadlessDist })
    : buildPrerequisites({ serverDist, clientHeadlessDist });
  const rustBridgeBin = path.join(runtimeRoot, "authority_bridge_server");
  await fs.copyFile(path.join(repoRoot, "target", "debug", "examples", "authority_bridge_server"), rustBridgeBin);
  await fs.chmod(rustBridgeBin, 0o755);
  await Promise.all([
    writeRuntimePackageBoundary(serverDist, path.join(repoRoot, "server", "node_modules")),
    writeRuntimePackageBoundary(clientHeadlessDist, path.join(repoRoot, "client", "node_modules")),
  ]);

  const paths = {
    serverEntrypoint: path.join(serverDist, "index.js"),
    clientCliPath: path.join(clientHeadlessDist, "cli.js"),
    rustBridgeBin,
  };
  await Promise.all([
    assertLocalModuleGraph(paths.serverEntrypoint),
    assertLocalModuleGraph(paths.clientCliPath),
    fs.access(paths.rustBridgeBin),
  ]);
  return {
    paths,
    build: {
      ...build,
      runtime: Object.fromEntries(Object.entries(paths).map(([key, value]) => [key, path.relative(repoRoot, value)])),
    },
  };
}

function buildPrerequisites({ serverDist, clientHeadlessDist }) {
  const commands = [
    ["cargo", "build", "-q", "-p", "successor-sim", "--example", "authority_bridge_server"],
    ["pnpm", "--dir", "server", "exec", "tsc", "--outDir", serverDist],
    ["pnpm", "--dir", "client", "exec", "vite", "build", "--config", "vite.headless.config.ts", "--outDir", clientHeadlessDist, "--emptyOutDir"],
  ];
  const results = [];
  for (const argv of commands) {
    const startedCommand = performance.now();
    const result = spawnSync(argv[0], argv.slice(1), {
      cwd: repoRoot,
      env: {
        ...process.env,
        CARGO_PROFILE_DEV_OPT_LEVEL: process.env.CARGO_PROFILE_DEV_OPT_LEVEL ?? "2",
      },
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    });
    const record = {
      argv,
      exitCode: result.status,
      signal: result.signal,
      durationMs: round(performance.now() - startedCommand),
      stdoutTail: tail(result.stdout),
      stderrTail: tail(result.stderr),
    };
    results.push(record);
    if (result.status !== 0) throw new Error(`${argv.join(" ")} failed ${result.status}\n${result.stdout ?? ""}${result.stderr ?? ""}`.trim());
  }
  return { skipped: false, commands: results };
}

async function snapshotBuiltRuntime({ serverDist, clientHeadlessDist }) {
  const snapshots = [
    { source: path.join(repoRoot, "server", "dist"), destination: serverDist },
    { source: path.join(repoRoot, "client", "dist", "headless"), destination: clientHeadlessDist },
  ];
  for (const snapshot of snapshots) {
    await fs.cp(snapshot.source, snapshot.destination, { recursive: true, force: true });
  }
  return {
    skipped: true,
    commands: [],
    snapshots: snapshots.map(({ source, destination }) => ({
      source: path.relative(repoRoot, source),
      destination: path.relative(repoRoot, destination),
    })),
  };
}

async function writeRuntimePackageBoundary(distDir, dependencyDir) {
  await fs.writeFile(path.join(distDir, "package.json"), `${JSON.stringify({ type: "module", private: true }, null, 2)}\n`, "utf8");
  await fs.symlink(dependencyDir, path.join(distDir, "node_modules"), "dir");
}

async function assertLocalModuleGraph(entrypoint) {
  const pending = [entrypoint];
  const visited = new Set();
  while (pending.length > 0) {
    const current = pending.pop();
    if (visited.has(current)) continue;
    visited.add(current);
    const source = await fs.readFile(current, "utf8");
    for (const specifier of localModuleSpecifiers(source)) {
      const resolved = await resolveLocalModule(path.dirname(current), specifier);
      if (resolved.endsWith(".js") || resolved.endsWith(".mjs")) pending.push(resolved);
    }
  }
}

function localModuleSpecifiers(source) {
  const matches = new Set();
  const patterns = [
    /\b(?:import|export)\s+(?:[^"']*?\s+from\s+)?["'](\.[^"']+)["']/gu,
    /\bimport\s*\(\s*["'](\.[^"']+)["']\s*\)/gu,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) matches.add(match[1]);
  }
  return matches;
}

async function resolveLocalModule(parentDir, specifier) {
  const barePath = path.resolve(parentDir, specifier.split(/[?#]/u, 1)[0]);
  const candidates = [barePath, `${barePath}.js`, `${barePath}.mjs`, `${barePath}.json`, path.join(barePath, "index.js")];
  for (const candidate of candidates) {
    try {
      const stat = await fs.stat(candidate);
      if (stat.isFile()) return candidate;
    } catch {
      // Try the next ESM resolution candidate.
    }
  }
  throw new Error(`isolated play-gate runtime is missing ${specifier} imported from ${parentDir}`);
}

function parseLane(value) {
  const lane = String(value).trim().toLowerCase();
  if (lane !== "accel" && lane !== "realtime" && lane !== "all") {
    throw new Error(`--lane must be accel, realtime, or all; got ${JSON.stringify(value)}`);
  }
  return lane;
}

function laneConcurrency({ lane, count, parsed }) {
  const configured = parsed.get("concurrency") ?? process.env.SUCCESSOR_PLAY_GATE_CONCURRENCY;
  let value;
  if (configured !== undefined) value = Number(configured);
  else if (lane === "accel") value = Math.max(1, Math.floor(os.availableParallelism() / 3));
  else value = 2;
  if (!Number.isInteger(value) || value <= 0) throw new Error(`--concurrency must be a positive integer; got ${configured}`);
  return Math.max(1, Math.min(value, count));
}

async function runScenarioQueue({ selection, ports, concurrency, runId, lane, sourceHash, sourceIdentity, runtimePaths }) {
  const results = new Array(selection.length);
  let nextIndex = 0;
  async function worker() {
    for (;;) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= selection.length) return;
      const entry = selection[index];
      results[index] = await scenarioRunOrSkip({ entry, port: ports[index], runId, lane, sourceHash, sourceIdentity, runtimePaths })
        .catch((error) => {
          const failure = failureRecord(error, { lane, sourceIdentity: { before: sourceIdentity, after: null } });
          return {
            schema: "successor.scenario-transcript.v2",
            status: "fail",
            runId: `${runId}-${entry.scenario.name}-${lane}`,
            scenario: entry.scenario.name,
            lane,
            fixture: { name: entry.scenario.fixture },
            fixtureName: entry.scenario.fixture,
            sourceHash,
            sourceIdentity: { before: sourceIdentity, after: null },
            port: ports[index],
            durationMs: null,
            wallDurationMs: null,
            virtualDurationMs: null,
            steps: [],
            stateProbes: [],
            failures: [failure.message],
            failure,
            failureDetails: [failure],
            finalSnapshotDigest: null,
            finalStateHash: null,
            artifactPath: null,
          };
        });
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return results;
}

async function scenarioRunOrSkip({ entry, port, runId, lane, sourceHash, sourceIdentity, runtimePaths }) {
  const { scenario, scenarioPath } = entry;
  const supportedLanes = scenarioSupportedLanes(scenario);
  if (!supportedLanes.includes(lane)) {
    return skippedScenarioResult({ scenario, scenarioPath, port, runId, lane, sourceHash, sourceIdentity, skip: `scenario lanes exclude ${lane}` });
  }
  const skip = scenario.skip ?? scenario.expectedFail ?? null;
  if (skip) return skippedScenarioResult({ scenario, scenarioPath, port, runId, lane, sourceHash, sourceIdentity, skip });
  return runScenarioFile({
    repoRoot,
    scenarioPath,
    runId,
    port,
    lane,
    sourceHash,
    sourceIdentity,
    ...runtimePaths,
    artifactDir: path.join(repoRoot, artifactRoot, lane),
  });
}

function skippedScenarioResult({ scenario, scenarioPath, port, runId, lane, sourceHash, sourceIdentity, skip }) {
  const reason = typeof skip === "string"
    ? skip
    : skip === true
      ? "scenario marked skip"
      : skip?.reason ?? skip?.reference ?? "scenario marked skip";
  return {
    schema: "successor.scenario-transcript.v2",
    status: "skip",
    skipped: true,
    expectedFail: Boolean(scenario.expectedFail),
    runId: `${runId}-${scenario.name}-${lane}`,
    scenario: scenario.name,
    lane,
    fixture: { name: scenario.fixture },
    fixtureName: scenario.fixture,
    sourceHash,
    sourceIdentity: { before: sourceIdentity, after: null },
    port,
    durationMs: 0,
    wallDurationMs: 0,
    virtualDurationMs: 0,
    failures: [],
    steps: [],
    stateProbes: [],
    skip: {
      reason,
      ...(typeof skip === "object" && skip !== null && !Array.isArray(skip) ? skip : {}),
    },
    artifactPath: null,
    scenarioPath: path.relative(repoRoot, scenarioPath),
    finalSnapshotDigest: null,
    finalStateHash: null,
  };
}

function addResultFailure(result, message, details) {
  result.failures ??= [];
  result.failures.push(message);
  result.status = "fail";
  result.digestPolicy = { ...(result.digestPolicy ?? {}), ...details };
}

async function persistScenarioResults(results) {
  await Promise.all(results.map(async (result) => {
    if (!result.artifactPath) return;
    const outputPath = path.join(repoRoot, result.artifactPath);
    await fs.writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  }));
}

function printSummary(report, artifactPath) {
  console.log(`play:gate ${report.status} · runs=${report.results.length} · sourceHash=${report.sourceHash} · artifact=${artifactPath}`);
  for (const laneRun of report.laneRuns) {
    console.log(`lane ${laneRun.lane} · wall=${laneRun.wallDurationMs}ms · virtual=${laneRun.virtualDurationMs}ms · concurrency=${laneRun.concurrency}`);
  }
  for (const result of report.results) {
    console.log(`- ${result.status} ${result.scenario} lane=${result.lane} port=${result.port} wall=${result.wallDurationMs ?? "n/a"}ms virtual=${result.virtualDurationMs ?? "n/a"}ms digest=${result.finalSnapshotDigest ?? "n/a"}`);
    if (result.status === "skip") console.log(`  skip: ${result.skip?.reference ? `${result.skip.reference} · ` : ""}${result.skip?.reason ?? "scenario marked skip"}`);
    for (const failure of result.failures ?? []) console.log(`  failure: ${failure}`);
  }
  for (const ratio of report.speedRatios) console.log(`speed ${ratio.scenario} · realtime/accel=${ratio.realtimeOverAccel ?? "n/a"}x`);
  for (const demotion of report.demotions) console.log(`demotion ${demotion.scenario} · step=${demotion.divergenceStep ?? "unknown"} · ${demotion.reason}`);
}

function parseArgs(argv) {
  const values = new Map();
  values.getAll = (key) => values.get(key) ?? [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) continue;
    const body = arg.slice(2);
    const eq = body.indexOf("=");
    const key = eq >= 0 ? body.slice(0, eq) : body;
    const value = eq >= 0 ? body.slice(eq + 1) : argv[index + 1] && !argv[index + 1].startsWith("--") ? argv[++index] : "1";
    if (key === "scenario" || key === "only") values.set(key, [...(values.get(key) ?? []), value]);
    else values.set(key, value);
  }
  values.has = Map.prototype.has.bind(values);
  values.get = Map.prototype.get.bind(values);
  return values;
}

function tail(text, max = 1600) {
  if (!text) return "";
  return text.length > max ? text.slice(text.length - max) : text;
}

function round(value) {
  return Math.round(value * 1000) / 1000;
}
