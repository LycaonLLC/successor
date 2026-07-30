#!/usr/bin/env node
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";

import { startSuccessorDriverBot } from "../../driver-protocol/successor-driver-bot.mjs";
import { createProcessHost } from "../lib/process-host.mjs";
import { createLocalSourceIdentity, createTreeSourceIdentity, listTreeSourcePaths } from "../farm/source-hash.mjs";
import { createMetricsPoller } from "./metrics.mjs";
import { sha256Json } from "../farm/protocol.mjs";
import { buildPlayerLoadReport, writePlayerLoadReport } from "./report.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..", "..", "..");
const serverRoot = path.join(repoRoot, "server");
const defaultSlicePath = path.join(repoRoot, "client", "public", "successor-slice", "open-desert-slice.json");
const defaultCliPath = path.join(repoRoot, "client", "dist", "headless", "cli.js");
const defaultBridgePath = path.join(repoRoot, "target", "debug", "examples", "authority_bridge_server");
const reportSchema = "successor.player-load-report.v2";
const generatorSchema = "successor.player-load-generator.v2";
const characterStoreSchema = "successor.character-store.v2";
const defaultAppearance = Object.freeze({ skinTone: "#c78f62", hair: "hair_mop", hairMat: "hair_raven", face: null });
const defaultWorn = Object.freeze([
  Object.freeze({ item: "under_bodysuit", colors: Object.freeze(["#89cff0"]) }),
  Object.freeze({ item: "boots_canvas_ankle", colors: Object.freeze(["#303030", "#808080"]) }),
]);
const defaultRunRoot = path.join(repoRoot, "verification", ".runs", "player-load");
const maxDefaultClients = 20;
const maxLargeClients = 600;
export const OPEN_LOOP_PROFILES = Object.freeze({
  "movement-query": Object.freeze({
    name: "movement-query",
    cycle: Object.freeze(["movement", "movement", "movement", "query"]),
    supported: Object.freeze(["movement", "query"]),
  }),
});
const UNSUPPORTED_WORKLOADS = Object.freeze({
  chat: "headless driver has no chat websocket frame or observable chat response",
  combat: "load characters are not provisioned for a truthful combat target/action proof",
  inventory: "load characters are not provisioned for a truthful inventory mutation proof",
  economy: "load characters are not provisioned for a truthful economy/trade proof",
});

export { reportSchema as playerLoadReportSchema, generatorSchema as playerLoadGeneratorSchema };

export function percentile(values, fraction) {
  const ordered = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (ordered.length === 0) return null;
  const index = Math.min(ordered.length - 1, Math.max(0, Math.ceil(ordered.length * fraction) - 1));
  return round(ordered[index]);
}

export function latencySummary(values) {
  return {
    count: values.length,
    p50: percentile(values, 0.5),
    p95: percentile(values, 0.95),
    p99: percentile(values, 0.99),
    max: values.length ? round(Math.max(...values)) : null,
  };
}

export function parsePlayerLoadArgs(argv) {
  const raw = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--") continue;
    if (!token.startsWith("--")) throw new Error(`unexpected argument ${token}`);
    const [name, inline] = token.slice(2).split("=", 2);
    if (["allow-large", "generator-stdin", "json", "open-loop", "capacity"].includes(name)) {
      if (inline !== undefined) throw new Error(`--${name} does not accept a value`);
      raw[name] = true;
      continue;
    }
    const value = inline ?? argv[++index];
    if (value === undefined || value.startsWith("--")) throw new Error(`--${name} requires a value`);
    raw[name] = value;
  }
  return normalizeOptions({
    clients: raw.clients,
    stages: raw.stages,
    durationMs: raw["duration-ms"],
    warmupMs: raw["warmup-ms"],
    steadyMs: raw["steady-ms"],
    drainMs: raw["drain-ms"],
    maxRunDurationMs: raw["max-run-duration-ms"],
    rampIntervalMs: raw["ramp-interval-ms"],
    workloadMs: raw["workload-ms"],
    profile: raw.profile ?? raw["open-loop-profile"],
    sampleIntervalMs: raw["sample-interval-ms"],
    retentionCap: raw["retention-cap"],
    maxClients: raw["max-clients"],
    joinTimeoutMs: raw["join-timeout-ms"],
    maxErrorRate: raw["max-error-rate"],
    maxDisconnects: raw["max-disconnects"],
    maxP95ReceiptMs: raw["max-p95-receipt-ms"],
    maxP99ReceiptMs: raw["max-p99-receipt-ms"],
    maxEventLoopLagMs: raw["max-event-loop-lag-ms"],
    maxRssBytes: raw["max-rss-bytes"],
    drainTimeoutMs: raw["drain-timeout-ms"],
    expectedServerActiveSessions: raw["expected-server-active-sessions"],
    outDir: raw["out-dir"],
    runId: raw["run-id"],
    adoptUrl: raw["adopt-url"],
    port: raw.port,
    processHostKind: raw["process-host"],
    allowLarge: raw["allow-large"] === true,
    generatorStdin: raw["generator-stdin"] === true,
    mode: raw["open-loop"] === true ? "open-loop" : "closed-loop",
    capacityRun: raw.capacity === true,
  });
}

export async function runPlayerLoad(input = {}) {
  const options = normalizeOptions(input);
  const startedAt = new Date().toISOString();
  const startedMs = performance.now();
  const runDir = path.resolve(options.outDir ?? path.join(defaultRunRoot, options.runId));
  await fs.mkdir(runDir, { recursive: true });
  const sourceCapture = options.captureSourceIdentity ?? captureStableSourceIdentity;
  const sourceIdentity = options.sourceIdentity ?? await sourceCapture();
  const lifecycle = { serverOwned: !options.adoptUrl, serverStarted: false, serverStopped: null, clientsClosed: 0, clean: false };
  const errors = [];
  const disconnects = [];
  const joinLatencies = [];
  const receiptLatencies = [];
  const commands = createCommandAccounting();
  const phases = [];
  const clients = [];
  const readyClients = [];
  const joinedIds = new Set();
  let nextClientIndex = options.clientOffset;
  const deferredDirtyHistory = [];
  let runtime = null;
  let poller = null;
  let stoppedBy = null;
  let finalStatus = null;
  let finalSourceIdentity = null;

  try {
    runtime = options.adoptUrl
      ? await adoptServer(options)
      : await startIsolatedServer({
        ...options,
        runDir,
        sourceHash: sourceIdentity.sourceHash,
        sourcePaths: sourceIdentity.manifest?.entries.map((entry) => entry.path),
      });
    const initialStatus = await fetchJson(`${runtime.gameUrl}/game/status`);
    assertSourceStatus(initialStatus, options.expectedSourceHash ?? null);
    lifecycle.serverStarted = !options.adoptUrl;
    poller = (options.createMetricsPoller ?? createMetricsPoller)({
      gameUrl: runtime.gameUrl,
      processHost: runtime.processHost,
      handle: runtime.handle,
      intervalMs: options.sampleIntervalMs,
      retentionCap: options.retentionCap,
    });
    poller.setLabels?.({ stage: "boot", action: "initial_status" });
    poller.start();

    const runDeadlineMs = startedMs + options.maxRunDurationMs;
    let previousStage = 0;
    for (const target of options.stages) {
      if (performance.now() >= runDeadlineMs) {
        stoppedBy = "max_run_duration";
        break;
      }
      poller.setLabels?.({ stage: `clients-${target}`, action: "join" });
      const phaseStartedAt = new Date().toISOString();
      const phaseStartMs = performance.now();
      const newReadyClients = [];
      for (let count = previousStage; count < target; count += 1) {
        const client = await joinRealPlayer({ options, runtime, index: nextClientIndex, sourceStatus: initialStatus, commands, clients });
        nextClientIndex += 1;
        if (count + 1 < target && options.rampIntervalMs > 0) await delay(options.rampIntervalMs);
        readyClients.push(client);
        newReadyClients.push(client);
        joinedIds.add(client.id);
        joinLatencies.push(client.joinLatencyMs);
        if (performance.now() >= runDeadlineMs) {
          stoppedBy = "max_run_duration";
          break;
        }
      }
      const workloadAccounting = createWorkloadAccounting(options.mode === "open-loop" ? options.profile : null);
      const stageLabel = `clients-${target}`;
      poller.setLabels?.({ stage: stageLabel, action: "warmup", phase: "warmup" });
      if (options.warmupMs > 0) await delay(Math.min(options.warmupMs, Math.max(0, runDeadlineMs - performance.now())));
      const steadyStartedMs = performance.now();
      poller.setLabels?.({ stage: stageLabel, action: options.mode === "open-loop" ? "open_loop_workload" : "movement_workload", phase: "steady" });
      const workload = options.mode === "open-loop"
        ? await runOpenLoopWorkload({
          clients: readyClients,
          durationMs: options.steadyMs,
          intervalMs: options.workloadMs,
          receiptLatencies,
          errors,
          profile: options.profile,
          disconnects,
          accounting: workloadAccounting,
          commands,
          signal: options.signal,
          stopWhen: () => performance.now() >= runDeadlineMs
            ? "max_run_duration"
            : thresholdFailure({ options, receiptLatencies, errors, disconnects, workload: workloadAccounting, samples: poller.samples }),
        })
        : await runStageWorkload({
          clients: readyClients,
          durationMs: options.steadyMs,
          workloadMs: options.workloadMs,
          receiptLatencies,
          errors,
          disconnects,
          accounting: workloadAccounting,
          commands,
          signal: options.signal,
          stopWhen: () => performance.now() >= runDeadlineMs
            ? "max_run_duration"
            : thresholdFailure({ options, receiptLatencies, errors, disconnects, workload: workloadAccounting, samples: poller.samples }),
        });
      const measuredDurationMs = round(performance.now() - steadyStartedMs);
      poller.setLabels?.({ stage: stageLabel, action: "settle", phase: "drain" });
      const settle = await settleActiveClients(readyClients, options.receiptTimeoutMs, errors, commands);
      poller.setLabels?.({ stage: stageLabel, action: "drain", phase: "drain" });
      const drain = await waitForDrain({ poller, intervalMs: options.sampleIntervalMs, timeoutMs: options.drainTimeoutMs, expectedActiveSessions: options.expectedServerActiveSessions ?? readyClients.length });
      const deferredDirty = evaluateDeferredDirtyGrowth(deferredDirtyHistory, drain.final?.deferredDirtyActors, readyClients.length, drain.final?.deferredDirtyActorOldestAgeTicks);
      const workloadThreshold = workload.stoppedBy ?? thresholdFailure({ options, receiptLatencies, errors, disconnects, workload: workloadAccounting, samples: poller.samples });
      const threshold = workloadThreshold ?? (!settle.ok || !drain.ok ? "drain_threshold" : deferredDirty.stop ? "deferred_dirty_threshold" : null);
      phases.push({
        targetClients: target,
        addedClients: newReadyClients.length,
        startedAt: phaseStartedAt,
        finishedAt: new Date().toISOString(),
        durationMs: round(performance.now() - phaseStartMs),
        warmupMs: options.warmupMs,
        steadyMs: measuredDurationMs,
        drainMs: drain.elapsedMs ?? 0,
        workload,
        settle,
        drain,
        deferredDirty,
        threshold,
      });
      previousStage = target;
      if (threshold) {
        stoppedBy = threshold;
        break;
      }
    }
  } catch (error) {
    errors.push(errorRecord(error, "runner"));
    stoppedBy ??= "runner_error";
  } finally {
    const closed = await Promise.allSettled([...clients].reverse().map((client) => client.close()));
    for (let index = 0; index < closed.length; index += 1) {
      const result = closed[index];
      const client = clients[clients.length - 1 - index];
      if (result.status === "fulfilled") lifecycle.clientsClosed += 1;
      else errors.push(errorRecord(result.reason, "client_close", client.id));
    }
    if (poller) await poller.stop().catch((error) => errors.push(errorRecord(error, "metrics_stop")));
    if (runtime) {
      finalStatus = await fetchJson(`${runtime.gameUrl}/game/status`).catch((error) => {
        errors.push(errorRecord(error, "final_status"));
        return null;
      });
    }
    if (runtime?.owned) {
      lifecycle.serverStopped = await stopAndAssert(runtime.processHost, runtime.handle);
      if (!lifecycle.serverStopped.ok) errors.push({ phase: "server_close", message: lifecycle.serverStopped.failures.join("; ") });
    }
    if (sourceIdentity.manifest) {
      finalSourceIdentity = await sourceCapture().catch((error) => {
        errors.push(errorRecord(error, "final_source_identity"));
        return null;
      });
    }
  }
  const sourceChangedPaths = finalSourceIdentity ? diffSourceManifests(sourceIdentity.manifest, finalSourceIdentity.manifest) : null;
  if (finalSourceIdentity && finalSourceIdentity.sourceHash !== sourceIdentity.sourceHash) stoppedBy ??= "source_changed";


  lifecycle.clean = lifecycle.clientsClosed === clients.length
    && (!runtime?.owned || lifecycle.serverStopped?.ok === true);
  const sampleSummary = poller?.summary?.() ?? { sampleCount: poller?.samples?.length ?? 0, collectedSampleCount: poller?.samples?.length ?? 0, droppedSampleCount: 0, retentionCap: options.retentionCap };
  const sampleAccounting = {
    collected: sampleSummary.collectedSampleCount ?? sampleSummary.sampleCount,
    retained: sampleSummary.sampleCount,
    dropped: sampleSummary.droppedSampleCount ?? 0,
    retentionCap: sampleSummary.retentionCap ?? options.retentionCap,
  };
  if (options.capacityRun && sampleAccounting.dropped > 0) stoppedBy ??= "sample_loss";
  const workload = summarizeWorkload(phases);
  const measuredSteadyMs = phases.reduce((sum, phase) => sum + (phase?.steadyMs ?? 0), 0);
  const throughputSeconds = Math.max(0.001, measuredSteadyMs / 1000);
  const throughput = workload.classes
    ? {
      completedOperations: workload.completed,
      operationsPerSecond: round(workload.completed / throughputSeconds),
      authorityReceiptCount: workload.classes.movement.completed,
      authorityReceiptsPerSecond: round(workload.classes.movement.completed / throughputSeconds),
      measuredDurationMs: measuredSteadyMs,
      excludesSetupTeardown: true,
    }
    : {
      receiptCount: workload.accepted,
      receiptsPerSecond: round(workload.accepted / throughputSeconds),
      measuredDurationMs: measuredSteadyMs,
      excludesSetupTeardown: true,
    };
  const status = errors.length === 0 && !stoppedBy && lifecycle.clean ? "pass" : "fail";
  const functional = status === "pass" && !errors.some((error) => error.phase === "runner" || error.phase === "workload_transport");
  const capacity = status === "pass"
    && options.capacityRun
    && options.capacityBudgetsConfigured
    && sampleAccounting.dropped === 0
    && lifecycle.clean;
  const run = {
    schema: reportSchema,
    status,
    verdict: {
      label: options.capacityRun ? "capacity" : "functional",
      functional,
      capacity,
      budgetsConfigured: options.capacityBudgetsConfigured,
    },
    runId: options.runId,
    startedAt,
    finishedAt: new Date().toISOString(),
    durationMs: round(performance.now() - startedMs),
    endpoint: runtime?.gameUrl ?? options.adoptUrl ?? null,
    mode: options.mode,
    ownership: runtime?.owned ? "isolated" : "adopted",
    requested: publicOptions(options),
    source: {
      localStartHash: sourceIdentity.sourceHash,
      localFinalHash: finalSourceIdentity?.sourceHash ?? null,
      localChangedPaths: sourceChangedPaths,
      serverSource: compactSource(runtime?.status?.source),
      finalServerSource: compactSource(finalStatus?.source),
    },
    clients: {
      requested: options.clients,
      spawned: clients.length,
      joined: readyClients.length,
      uniqueIdentityCount: joinedIds.size,
      joinLatencyMs: latencySummary(joinLatencies),
      receiptLatencyMs: latencySummary(receiptLatencies),
    },
    throughput,
    ...(workload.classes ? {} : { commands }),
    unsupportedWorkloads: UNSUPPORTED_WORKLOADS,
    workload,
    sampleAccounting,
    errors,
    disconnects,
    stoppedBy,
    teardown: lifecycle,
  };
  const report = buildPlayerLoadReport({ run, sourceHash: sourceIdentity.sourceHash, samples: poller?.samples ?? [], phases });
  const reportPath = await writePlayerLoadReport({ outDir: runDir, report });
  return { report, reportPath, runDir };
}

export async function runPlayerLoadGenerator(input = {}) {
  const options = normalizeOptions({
    ...input,
    adoptUrl: input.endpoint ?? input.adoptUrl,
    outDir: input.outDir ?? path.join(defaultRunRoot, `generator-${safeName(input.runId ?? createRunId())}`),
    allowLarge: input.allowLarge ?? false,
  });
  if (!options.adoptUrl) throw new Error("player load generator requires endpoint");
  if (!input.sourceHash || typeof input.sourceHash !== "string") throw new Error("player load generator requires sourceHash");
  if (options.clients > 16) throw new Error("player load generator caps clients at 16");
  const sourceCapture = Array.isArray(input.sourcePaths)
    ? () => captureStableTreeSourceIdentity({ paths: input.sourcePaths, expectedHash: input.sourceHash })
    : undefined;
  const result = await runPlayerLoad({ ...options, ...(sourceCapture ? { captureSourceIdentity: sourceCapture } : {}) });
  const unsigned = {
    schema: generatorSchema,
    status: result.report.status,
    runId: options.runId,
    generatorId: safeName(input.generatorId ?? "local-generator"),
    sourceHash: input.sourceHash,
    startedAt: result.report.startedAt,
    finishedAt: result.report.finishedAt,
    clients: {
      requested: options.clients,
      spawned: result.report.clients.spawned,
      identityJoined: result.report.clients.joined,
      joined: result.report.clients.joined,
    },
    commands: {
      ...result.report.commands,
      sent: result.report.commands.queued,
    },
    latency: {
      joinMs: result.report.clients.joinLatencyMs,
      receiptMs: result.report.clients.receiptLatencyMs,
    },
    throughput: result.report.throughput,
    errors: result.report.errors,
    disconnects: result.report.disconnects,
    samples: result.report.samples ?? [],
    teardown: { attempted: true, clean: result.report.teardown.clean },
    reportPath: result.reportPath,
  };
  return { ...unsigned, checksum: sha256Json(unsigned) };
}

async function assertFreshIsolatedState(runDir) {
  const stateDir = path.join(runDir, "game-state");
  try {
    await fs.lstat(stateDir);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  throw new Error(`refusing to reuse isolated player-load state directory ${stateDir}; choose a new run id or output directory`);
}

export async function startIsolatedServer({ root = repoRoot, runId, runDir, clients, identityNamespaces = ["local"], port: requestedPort, processHostKind, slicePath, cliPath, sourceHash, sourcePaths, buildArtifacts = prepareIsolatedArtifacts, waitForReady = waitForStatus, processHostFactory = createProcessHost } = {}) {
  if (requestedPort === 28093 || requestedPort === 5179) throw new Error(`refusing reserved active port ${requestedPort}`);
  await assertFreshIsolatedState(runDir);
  const port = requestedPort ?? await findFreePort();
  const paths = {
    serverDist: path.join(root, "server", "dist", "index.js"),
    bridge: path.join(root, "target", "debug", "examples", "authority_bridge_server"),
    cli: cliPath ?? path.join(root, "client", "dist", "headless", "cli.js"),
    slice: slicePath ?? path.join(root, "client", "public", "successor-slice", "open-desert-slice.json"),
  };
  const boundSource = sourceHash ?? (await captureStableSourceIdentity({ root })).sourceHash;
  const artifacts = await buildArtifacts({ root, runDir, sourceHash: boundSource, sourcePaths, paths });
  const characterStorePath = path.join(runDir, "characters.json");
  await writeLoadCharacterStore(characterStorePath, runId, maxLargeClients, identityNamespaces);
  const shardId = `player-load-${safeName(runId)}`;
  const stateDir = path.join(runDir, "game-state");
  const processHost = processHostFactory({ runId: `successor-player-load-${safeName(runId)}`, runDir, kind: processHostKind });
  const name = `successor-player-load-${safeName(runId)}-${port}`;
  const handle = await processHost.start({
    name,
    argv: [process.execPath, paths.serverDist],
    cwd: path.join(root, "server"),
    env: {
      PORT: String(port),
      HOST: "127.0.0.1",
      LOG_LEVEL: process.env.SUCCESSOR_PLAYER_LOAD_LOG_LEVEL ?? "silent",
      GAME_ALLOW_DEV_IDENTITY: "1",
      GAME_SHARD_ID: shardId,
      GAME_SHARD_PERSISTENCE: "1",
      GAME_SHARD_STATE_DIR: stateDir,
      GAME_SHARD_CHECKPOINT_PATH: path.join(stateDir, `${shardId}.checkpoint.json`),
      GAME_SHARD_JOURNAL_PATH: path.join(stateDir, `${shardId}.journal.jsonl`),
      GAME_DEBUG_AUTHORITY_COMMANDS: "0",
      GAME_MAX_SESSIONS: String(Math.max(64, clients + 16)),
      GAME_CHARACTER_STORE_PATH: characterStorePath,
      GAME_SLICE_PATH: paths.slice,
      GAME_RUST_AUTHORITY_BRIDGE_BIN: paths.bridge,
    },
  });
  const gameUrl = `http://127.0.0.1:${port}`;
  try {
    const status = await waitForReady(gameUrl, 25_000);
    return { owned: true, processHost, handle, gameUrl, status, characterStorePath, artifacts };
  } catch (error) {
    const cleanup = await stopAndAssert(processHost, handle);
    const failure = new AggregateError(
      [error, ...(cleanup.failures.map((message) => new Error(message)))],
      "isolated player-load server readiness failed and cleanup was attempted",
    );
    failure.code = cleanup.ok ? "ISOLATED_SERVER_READINESS_FAILED" : "ISOLATED_SERVER_READINESS_CLEANUP_FAILED";
    throw failure;
  }
}

export async function prepareIsolatedArtifacts({ root = repoRoot, runDir, sourceHash, sourcePaths, paths, runProcess = runBoundedProcess } = {}) {
  if (!/^[a-f0-9]{64}$/u.test(sourceHash ?? "")) throw new Error("isolated artifact preparation requires a source hash");
  if (!paths?.serverDist || !paths?.bridge || !paths?.cli || !paths?.slice) throw new Error("isolated artifact preparation requires all artifact paths");
  const before = await captureStableSourceIdentity({ root });
  if (before.sourceHash !== sourceHash) throw new Error("isolated artifact preparation source changed before build");
  const builds = [
    { id: "server-dist", command: "pnpm", argv: ["--dir", "server", "build"] },
    { id: "authority-bridge", command: "cargo", argv: ["build", "--locked", "-q", "-p", "successor-sim", "--example", "authority_bridge_server"] },
    { id: "headless-cli", command: "pnpm", argv: ["--dir", "client", "build:headless"] },
  ];
  const completed = [];
  for (const build of builds) {
    const result = await runProcess(build.command, build.argv, { cwd: root, timeoutMs: 15 * 60_000 });
    if (result?.ok !== true || result?.groupClean !== true) throw artifactBuildError(build, result);
    completed.push({ id: build.id, command: build.command, argv: build.argv });
  }
  for (const required of Object.values(paths)) {
    if (!existsSync(required)) throw new Error(`required load artifact is missing after bound build: ${required}`);
  }
  const after = await captureStableSourceIdentity({ root });
  if (after.sourceHash !== sourceHash) throw new Error("isolated artifact preparation source changed during build");
  const artifacts = await Promise.all([
    artifactDigest(root, "server-dist", paths.serverDist),
    artifactDigest(root, "authority-bridge", paths.bridge),
    artifactDigest(root, "headless-cli", paths.cli),
    artifactDigest(root, "slice", paths.slice),
  ]);
  const manifest = {
    schema: "successor.player-load-isolated-artifacts.v1",
    sourceHash,
    sourcePathCount: Array.isArray(sourcePaths) ? sourcePaths.length : null,
    builtAt: new Date().toISOString(),
    builds: completed,
    artifacts,
  };
  const markerPath = path.join(runDir, "isolated-artifacts.json");
  const temporary = `${markerPath}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  await fs.rename(temporary, markerPath);
  return { ...manifest, markerPath };
}

export async function stopAndAssert(processHost, handle) {
  const failures = [];
  let stopped = null;
  let asserted = null;
  try {
    stopped = await processHost.stop(handle, { graceMs: 30_000 });
    if (stopped?.ok !== true) failures.push(`stop returned non-ok: ${JSON.stringify(stopped ?? null)}`);
  } catch (error) {
    failures.push(`stop threw: ${errorMessage(error)}`);
  }
  try {
    asserted = await processHost.assertStopped(handle);
    if (asserted?.ok !== true) failures.push(`assertStopped returned non-ok: ${JSON.stringify(asserted ?? null)}`);
  } catch (error) {
    failures.push(`assertStopped threw: ${errorMessage(error)}`);
  }
  return { ok: failures.length === 0, stopped, asserted, failures };
}

async function artifactDigest(root, id, artifactPath) {
  const bytes = await fs.readFile(artifactPath);
  return { id, path: path.relative(root, artifactPath), sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length };
}

function artifactBuildError(build, result) {
  const detail = redactedStderr(result?.stderr);
  const reason = result?.groupClean === false ? " (owned build process group was not clean)" : "";
  const error = new Error(`isolated ${build.id} build failed${reason}${detail ? `: ${detail}` : ""}`);
  error.code = "ISOLATED_ARTIFACT_BUILD_FAILED";
  error.buildFailure = {
    errorCode: result?.errorCode ?? null,
    error: result?.error ?? null,
    timedOut: result?.timedOut === true,
    aborted: result?.aborted === true,
    escalated: result?.escalated === true,
    groupClean: result?.groupClean === true,
  };
  return error;
}

/**
 * Run one local artifact build in an owned process group.  Resolution is held
 * until the group is absent, including after a successful direct child exit:
 * build wrappers may otherwise leave compiler workers behind.
 *
 * `spawnProcess`, `killProcess`, and `delay` are injectable only to exercise
 * lifecycle branches without invoking a real build.
 */
export function runBoundedProcess(command, argv, {
  cwd,
  timeoutMs,
  termGraceMs = 2_000,
  killGraceMs = 2_000,
  signal,
  spawnProcess = spawn,
  killProcess = process.kill,
  delay = (durationMs) => new Promise((resolve) => setTimeout(resolve, durationMs)),
} = {}) {
  return new Promise((resolve) => {
    const stderr = Buffer.alloc(8 * 1024);
    let stderrBytes = 0;
    let timedOut = false;
    let aborted = false;
    let escalated = false;
    let settled = false;
    let closing = false;
    let closeResult = null;
    let child = null;
    let timeout = null;
    let abortListener = null;

    const appendStderr = (chunk) => {
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (value.length >= stderr.length) {
        value.copy(stderr, 0, value.length - stderr.length);
        stderrBytes = stderr.length;
        return;
      }
      if (stderrBytes + value.length <= stderr.length) {
        value.copy(stderr, stderrBytes);
        stderrBytes += value.length;
        return;
      }
      const discarded = stderrBytes + value.length - stderr.length;
      stderr.copyWithin(0, discarded, stderrBytes);
      value.copy(stderr, stderrBytes - discarded);
      stderrBytes = stderr.length;
    };
    const finish = ({ exitCode = closeResult?.exitCode ?? null, signal: exitSignal = closeResult?.signal ?? null, error = null, groupClean = false } = {}) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      if (abortListener) signal?.removeEventListener("abort", abortListener);
      resolve({
        ok: exitCode === 0 && !timedOut && !aborted && !error && groupClean,
        exitCode,
        signal: exitSignal,
        timedOut,
        aborted,
        escalated,
        groupClean,
        error: error ? redactedStderr(errorMessage(error)) : null,
        errorCode: error?.code ?? null,
        stderr: redactedStderr(stderr.subarray(0, stderrBytes).toString("utf8")),
      });
    };
    const noOwnedGroup = () => !Number.isInteger(child?.pid) || child.pid <= 0;
    const groupExists = () => {
      if (noOwnedGroup()) return false;
      try {
        if (process.platform !== "win32") killProcess(-child.pid, 0);
        else killProcess(child.pid, 0);
        return true;
      } catch (error) {
        return error?.code !== "ESRCH";
      }
    };
    const signalGroup = (signalName) => {
      if (noOwnedGroup()) return null;
      try {
        if (process.platform !== "win32") killProcess(-child.pid, signalName);
        else child.kill(signalName);
      } catch (error) {
        if (error?.code !== "ESRCH") return error;
      }
      return null;
    };
    const waitForGroupExit = async (durationMs) => {
      const deadline = Date.now() + durationMs;
      do {
        if (!groupExists()) return true;
        if (Date.now() >= deadline) return false;
        await delay(Math.min(25, Math.max(1, deadline - Date.now())));
      } while (true);
    };
    const finishAfterGroupExit = async (initialError = null) => {
      if (!groupExists()) {
        finish({ error: initialError, groupClean: true });
        return;
      }
      const termError = signalGroup("SIGTERM");
      if (termError) {
        finish({ error: termError, groupClean: false });
        return;
      }
      if (await waitForGroupExit(termGraceMs)) {
        finish({ error: initialError, groupClean: true });
        return;
      }
      escalated = true;
      const killError = signalGroup("SIGKILL");
      if (killError) {
        finish({ error: killError, groupClean: false });
        return;
      }
      if (await waitForGroupExit(killGraceMs)) {
        finish({ error: initialError, groupClean: true });
        return;
      }
      finish({
        error: Object.assign(new Error("owned build process group survived TERM and KILL"), { code: "PROCESS_GROUP_SURVIVED" }),
        groupClean: false,
      });
    };
    const beginCleanup = (error = null) => {
      if (closing || settled) return;
      closing = true;
      void finishAfterGroupExit(error);
    };

    if (signal?.aborted) {
      aborted = true;
      beginCleanup(Object.assign(new Error("build aborted before spawn"), { code: "ABORTED" }));
      return;
    }
    try {
      child = spawnProcess(command, argv, {
        cwd,
        stdio: ["ignore", "ignore", "pipe"],
        detached: process.platform !== "win32",
      });
    } catch (error) {
      beginCleanup(withErrorCode(error, "SPAWN_FAILED"));
      return;
    }
    timeout = setTimeout(() => {
      timedOut = true;
      beginCleanup(Object.assign(new Error("build timed out"), { code: "TIMEOUT" }));
    }, timeoutMs);
    abortListener = () => {
      aborted = true;
      beginCleanup(Object.assign(new Error("build aborted"), { code: "ABORTED" }));
    };
    signal?.addEventListener("abort", abortListener, { once: true });
    if (signal?.aborted) abortListener();
    child.stderr?.on("data", appendStderr);
    child.once("close", (exitCode, exitSignal) => {
      closeResult = { exitCode, signal: exitSignal };
      beginCleanup();
    });
    child.once("error", (error) => beginCleanup(error));
  });
}

function redactedStderr(value) {
  return String(value ?? "").slice(-8 * 1024).replace(/(token|password|secret)=\S+/giu, "$1=[redacted]");
}

function withErrorCode(error, fallbackCode) {
  const normalized = error instanceof Error ? error : new Error(String(error));
  if (!normalized.code) normalized.code = fallbackCode;
  return normalized;
}
async function adoptServer(options) {
  const gameUrl = normalizeUrl(options.adoptUrl);
  const status = await waitForStatus(gameUrl, 10_000);
  return { owned: false, processHost: null, handle: null, gameUrl, status, characterStorePath: null };
}

async function joinRealPlayer({ options, runtime, index, sourceStatus, commands, clients }) {
  const id = canonicalLoadCharacterId(options.runId, options.identityNamespace, index + 1);
  const started = performance.now();
  const bot = (options.startDriver ?? startSuccessorDriverBot)({
    cliPath: options.cliPath ?? defaultCliPath,
    gameUrl: runtime.gameUrl,
    slicePath: options.slicePath ?? defaultSlicePath,
    actorId: id,
    playerId: `account-${id}`,
    characterId: id,
    displayName: `Load ${index + 1}`,
    spawnArea: "open-desert-overworld",
    spawnX: 512 + (index % 8),
    spawnY: 512 + Math.floor(index / 8),
    facing: "right",
  });
  const client = { id, bot, close: onceClose(bot), ready: null, joinLatencyMs: null };
  clients.push(client);
  client.ready = await bot.waitFor((envelope) => envelope.type === "status" && envelope.status === "ready", "source-validated game.hello", options.joinTimeoutMs);
  const source = await fetchJson(`${runtime.gameUrl}/game/status`);
  assertSourceStatus(source, sourceStatus?.source?.stateHash ?? null);
  const proof = await sendAuthorityWork(bot, "/move 1 0 1 Right", options.receiptTimeoutMs, commands);
  if (!proof.receipt.accepted) throw new Error(`source-validated movement receipt was rejected: ${proof.receipt.reasonCode ?? "unknown"}`);
  client.joinLatencyMs = round(performance.now() - started);
  return client;
}
export function createWorkloadAccounting(profile = null) {
  const accounting = { attempted: 0, accepted: 0, rejected: 0, rejectionReasons: {} };
  if (profile) {
    const classes = OPEN_LOOP_PROFILES[profile]?.supported ?? [];
    accounting.completed = 0;
    accounting.errors = 0;
    accounting.classes = Object.fromEntries(classes.map((name) => [name, createWorkloadClassAccounting()]));
  }
  return accounting;
}

function createWorkloadClassAccounting() {
  return { intended: 0, attempted: 0, completed: 0, accepted: 0, rejected: 0, errors: 0, rejectionReasons: {}, errorReasons: {}, latencies: [], latencyCount: 0 };
}

export function createCommandAccounting() {
  return { attempted: 0, queued: 0, receipts: 0, accepted: 0, rejected: 0 };
}
export function recordWorkloadRejection(accounting, reason, className = null) {
  const key = typeof reason === "string" && reason.length > 0 ? reason : "unknown";
  accounting.rejected += 1;
  accounting.rejectionReasons[key] = (accounting.rejectionReasons[key] ?? 0) + 1;
  if (className && accounting.classes?.[className]) {
    const item = accounting.classes[className];
    item.rejected += 1;
    item.rejectionReasons[key] = (item.rejectionReasons[key] ?? 0) + 1;
  }
}

export function workloadErrorRate(workload) {
  return (workload?.rejected ?? 0) / Math.max(1, workload?.attempted ?? 0);
}

async function runStageWorkload({ clients, durationMs, workloadMs, receiptLatencies, errors, disconnects, accounting, commands, signal, stopWhen }) {
  const started = performance.now();
  let rounds = 0;
  while (performance.now() - started < durationMs) {
    if (signal?.aborted) throw new Error("player load aborted");
    const threshold = stopWhen();
    if (threshold) return { rounds, stoppedBy: threshold, ...accounting };
    const settled = await Promise.allSettled(clients.map(async (client, index) => {
      const move = index % 2 === 0 ? "/move-intent 1 0 Right" : "/move-intent -1 0 Left";
      accounting.attempted += 1;
      let authority;
      try {
        authority = await sendAuthorityWork(client.bot, move, 8_000, commands);
      } catch (error) {
        recordWorkloadRejection(accounting, `receipt_error:${errorMessage(error)}`);
        throw error;
      }
      receiptLatencies.push(authority.latencyMs);
      if (authority.receipt.accepted !== true) {
        const reason = authority.receipt.reasonCode ?? authority.receipt.reason ?? "rejected";
        recordWorkloadRejection(accounting, reason);
        throw rejectedWorkloadReceipt(reason);
      }
      accounting.accepted += 1;
      client.bot.send({ op: "query", verb: "/where" });
      await client.bot.waitFor((envelope) => envelope.type === "query" && envelope.verb === "where", "/where query", 8_000);
    }));
    for (let index = 0; index < settled.length; index += 1) {
      const result = settled[index];
      if (result.status === "rejected") {
        if (result.reason?.workloadReceiptRejected === true) continue;
        const message = errorMessage(result.reason);
        if (message.includes("disconnected") || message.includes("exited")) {
          disconnects.push({ client: clients[index].id, message });
          errors.push(errorRecord(result.reason, "workload_transport", clients[index].id));
        } else errors.push(errorRecord(result.reason, "workload", clients[index].id));
      }
    }
    rounds += 1;
    const postRoundThreshold = stopWhen();
    if (postRoundThreshold) return { rounds, stoppedBy: postRoundThreshold, ...accounting };
    await delay(workloadMs);
  }
  return { rounds, stoppedBy: null, ...accounting };
}
export async function runOpenLoopWorkload({
  clients,
  durationMs,
  intervalMs,
  profile = "movement-query",
  receiptLatencies,
  errors,
  disconnects,
  accounting,
  responseTimeoutMs = 8_000,
  commands,
  signal,
  stopWhen,
  now = () => performance.now(),
  sleep = delay,
} = {}) {
  const selected = OPEN_LOOP_PROFILES[profile];
  if (!selected) throw new Error(`unknown open-loop profile ${profile}`);
  const started = now();
  const schedule = [];
  const observations = [];
  const slots = Math.max(0, Math.ceil(durationMs / intervalMs));
  let sequence = 0;
  for (let slot = 0; slot < slots; slot += 1) {
    const intendedAt = started + slot * intervalMs;
    if (intendedAt - started >= durationMs) break;
    for (let index = 0; index < clients.length; index += 1) {
      const client = clients[index];
      const className = selected.cycle[(slot * clients.length + index) % selected.cycle.length];
      const item = accounting.classes[className];
      item.intended += 1;
      schedule.push({ client: client.id, class: className, sequence, intendedAtMs: round(intendedAt - started) });
      sequence += 1;
    }
  }
  for (const entry of schedule) {
    if (signal?.aborted) throw new Error("player load aborted");
    const intendedAt = started + entry.intendedAtMs;
    const wait = intendedAt - now();
    if (wait > 0) await sleep(wait);
    const sentAt = now();
    entry.sentAtMs = round(sentAt - started);
    entry.scheduleMissMs = round(Math.max(0, sentAt - intendedAt));
    const clientIndex = clients.findIndex((client) => client.id === entry.client);
    const client = clients[clientIndex];
    const item = accounting.classes[entry.class];
    item.attempted += 1;
    accounting.attempted += 1;
    const observation = observeOpenLoopWork(client, clientIndex, entry.class, item, {
      receiptLatencies,
      errors,
      disconnects,
      accounting,
      commands,
      responseTimeoutMs,
    });
    observations.push(observation);
  }
  const remaining = started + durationMs - now();
  if (remaining > 0) await sleep(remaining);
  const settled = await Promise.allSettled(observations);
  for (const result of settled) if (result.status === "rejected") errors.push(errorRecord(result.reason, "open_loop"));
  const stoppedBy = stopWhen?.() ?? null;
  return {
    rounds: schedule.length,
    stoppedBy,
    schedule,
    scheduleMissCount: schedule.filter((entry) => entry.scheduleMissMs > 0).length,
    scheduleMissMs: latencySummary(schedule.map((entry) => entry.scheduleMissMs)),
    intendedSendCount: schedule.length,
    ...materializeWorkload(accounting),
  };
}
async function observeOpenLoopWork(client, clientIndex, className, item, { receiptLatencies, errors, disconnects, accounting, commands, responseTimeoutMs }) {
  try {
    const result = className === "movement"
      ? await sendAuthorityWork(client.bot, clientIndex % 2 === 0 ? "/move-intent 1 0 Right" : "/move-intent -1 0 Left", responseTimeoutMs, commands)
      : await sendQueryWork(client.bot, "/where", responseTimeoutMs);
    item.completed += 1;
    accounting.completed += 1;
    item.latencies.push(result.latencyMs);
    item.latencyCount += 1;
    if (className === "movement") receiptLatencies.push(result.latencyMs);
    if (className === "movement" && result.receipt.accepted !== true) {
      const reason = result.receipt.reasonCode ?? result.receipt.reason ?? "rejected";
      recordWorkloadRejection(accounting, reason, className);
    } else {
      item.accepted += 1;
      accounting.accepted += 1;
    }
  } catch (error) {
    item.errors += 1;
    accounting.errors += 1;
    const key = `error:${errorMessage(error)}`;
    item.errorReasons[key] = (item.errorReasons[key] ?? 0) + 1;
    const message = errorMessage(error);
    if (message.includes("disconnected") || message.includes("exited")) {
      disconnects.push({ client: client.id, message });
      errors.push(errorRecord(error, "workload_transport", client.id));
    } else errors.push(errorRecord(error, "workload", client.id));
  }
}
function materializeWorkload(accounting) {
  if (!accounting.classes) return { ...accounting };
  return {
    ...accounting,
    classes: Object.fromEntries(Object.entries(accounting.classes).map(([name, item]) => {
      const { latencies, latencyCount, ...rest } = item;
      const materialized = { ...rest, latencyMs: { ...latencySummary(latencies), count: latencyCount ?? latencies.length } };
      Object.defineProperty(materialized, "__latencies", { value: [...latencies], enumerable: false });
      return [name, materialized];
    })),
  };
}

async function sendQueryWork(bot, verb, timeoutMs) {
  const before = bot.envelopes.length;
  const sentAt = performance.now();
  bot.send({ op: "query", verb });
  const response = await bot.waitFor((envelope) => bot.envelopes.indexOf(envelope) >= before
    && envelope.type === "query" && envelope.verb === verb.replace(/^\//u, ""), `query ${verb}`, timeoutMs);
  return { response, latencyMs: round(performance.now() - sentAt) };
}
function rejectedWorkloadReceipt(reason) {
  const error = new Error(`workload authority receipt was rejected: ${reason}`);
  error.workloadReceiptRejected = true;
  return error;
}


async function sendAuthorityWork(bot, line, timeoutMs, commands) {
  commands.attempted += 1;
  const before = bot.envelopes.length;
  const sentAt = performance.now();
  bot.send({ op: "verb", line });
  const queued = await bot.waitFor((envelope) => bot.envelopes.indexOf(envelope) >= before
    && envelope.type === "event" && envelope.event === "authority_queued" && envelope.line === line, `authority queue ${line}`, timeoutMs);
  commands.queued += 1;
  const commandId = queued?.data?.commandId;
  const queuedKind = queued?.data?.commandKind;
  if (!Number.isInteger(commandId)) throw new Error(`authority queue omitted command id for ${line}`);
  if (typeof queuedKind !== "string" || queuedKind.length === 0) throw new Error(`authority queue omitted command kind for ${line}`);
  const receipt = await bot.waitFor((envelope) => envelope.type === "receipt" && envelope.commandId === commandId, `authority receipt ${commandId}`, timeoutMs);
  commands.receipts += 1;
  if (receipt.commandKind !== queuedKind) throw new Error(`authority receipt command kind mismatch for ${line}: queued ${queuedKind}, received ${receipt.commandKind ?? "missing"}`);
  if (receipt.accepted === true) commands.accepted += 1;
  else commands.rejected += 1;
  return { receipt, latencyMs: round(performance.now() - sentAt) };
}

async function settleActiveClients(clients, timeoutMs, errors, commands) {
  const settled = await Promise.allSettled(clients.map(async (client) => {
    const result = await sendAuthorityWork(client.bot, "/move-intent 0 0 Right", timeoutMs, commands);
    if (!result.receipt.accepted) throw new Error(`zero move intent was rejected: ${result.receipt.reasonCode ?? "unknown"}`);
  }));
  const failures = settled.flatMap((result, index) => result.status === "rejected"
    ? [{ client: clients[index]?.id ?? "unknown", message: errorMessage(result.reason) }]
    : []);
  for (const failure of failures) errors.push({ phase: "settle", ...failure });
  return { ok: failures.length === 0, failures };
}

export async function awaitTransportDrain({ sample, now = () => performance.now(), sleep = delay, deadlineMs = 10_000, intervalMs = 250, expectedActiveSessions } = {}) {
  if (typeof sample !== "function") return { ok: true, unavailable: true, expectedActiveSessions, blockers: { sessionMismatch: null, payloadPending: null, workloadPending: null }, samples: [] };
  const started = now();
  const samples = [];
  while (true) {
    const entry = await sample();
    if (entry) samples.push(entry);
    const current = entry ?? samples.at(-1) ?? null;
    const state = transportDrainState(current);
    const decision = transportDrainDecision(state, expectedActiveSessions);
    if (decision.ok) {
      return { ok: true, elapsedMs: round(now() - started), samples, final: state, expectedActiveSessions, blockers: decision.blockers };
    }
    if (now() - started >= deadlineMs) return { ok: false, elapsedMs: round(now() - started), samples, final: state, expectedActiveSessions, blockers: decision.blockers, reason: "drain_deadline" };
    await sleep(Math.min(intervalMs, Math.max(1, deadlineMs - (now() - started))));
  }
}

export function transportDrainDecision(state, expectedActiveSessions) {
  const payloadQueue = [state?.pendingReceipts, state?.pendingEvents, state?.pendingAbilityQueueEvents].every((value) => value === null)
    ? state?.queueDepth
    : (state?.pendingReceipts ?? 0) + (state?.pendingEvents ?? 0) + (state?.pendingAbilityQueueEvents ?? 0);
  const workloadBacklogSize = state?.workloadBacklogSize ?? state?.backlogSize ?? 0;
  const blockers = {
    sessionMismatch: state?.activeSessions !== expectedActiveSessions,
    payloadPending: payloadQueue !== 0,
    workloadPending: workloadBacklogSize !== 0,
  };
  return { ok: state !== null && !blockers.sessionMismatch && !blockers.payloadPending && !blockers.workloadPending, expectedActiveSessions, blockers };
}

async function waitForDrain({ poller, intervalMs, timeoutMs, expectedActiveSessions }) {
  return awaitTransportDrain({
    sample: typeof poller?.sample === "function" ? async () => (await poller.sample()) ?? poller.samples.at(-1) : null,
    intervalMs,
    deadlineMs: timeoutMs,
    expectedActiveSessions,
  });
}

function transportDrainState(sample) {
  const instrumentation = sample?.status?.instrumentation;
  if (!instrumentation) return null;
  const delivery = instrumentation.delivery ?? {};
  const bridge = instrumentation.bridge ?? {};
  const cadencePending = numericOrNull(bridge.cadencePending);
  const workloadLivePending = numericOrNull(bridge.workloadLivePending);
  const workloadBacklogSize = numericOrNull(bridge.workloadBacklogSize);
  return {
    activeSessions: numericOrNull(instrumentation.sessions?.active),
    queueDepth: numericOrNull(delivery.queueDepth),
    pendingReceipts: numericOrNull(delivery.pendingReceipts),
    pendingEvents: numericOrNull(delivery.pendingEvents),
    pendingAbilityQueueEvents: numericOrNull(delivery.pendingAbilityQueueEvents),
    deferredDirtyActors: numericOrNull(delivery.deferredDirtyActors),
    ...(numericOrNull(delivery.deferredDirtyActorOldestAgeTicks) === null ? {} : { deferredDirtyActorOldestAgeTicks: numericOrNull(delivery.deferredDirtyActorOldestAgeTicks) }),
    backlogSize: numericOrNull(bridge.backlogSize),
    ...(cadencePending === null ? {} : { cadencePending }),
    ...(workloadBacklogSize === null ? {} : { workloadBacklogSize }),
    ...(workloadLivePending === null ? {} : { workloadLivePending }),
  };
}
export function evaluateDeferredDirtyGrowth(history, deferredDirtyActors, activeClients, oldestAgeTicks = 0) {
  const current = Number.isFinite(deferredDirtyActors) && activeClients > 0
    ? { activeClients, deferredDirtyActors, perClient: deferredDirtyActors / activeClients, oldestAgeTicks: Number.isFinite(oldestAgeTicks) ? oldestAgeTicks : 0 }
    : null;
  if (!current) return { stop: false, current: null, reason: null };
  history.push(current);
  const recent = history.slice(-3);
  const sustainedIncrease = recent.length === 3
    && recent[0].perClient < recent[1].perClient
    && recent[1].perClient < recent[2].perClient
    && recent.every((entry) => entry.oldestAgeTicks > 1);
  return {
    stop: sustainedIncrease,
    current,
    reason: sustainedIncrease ? "aged_deferred_dirty_growth" : null,
  };
}

export function thresholdFailure({ options, receiptLatencies, errors, disconnects, workload, samples = [] }) {
  if (disconnects.length > options.maxDisconnects) return "disconnect_threshold";
  if (workloadErrorRate(workload) > options.maxErrorRate) return "error_rate_threshold";
  const p95 = percentile(receiptLatencies, 0.95);
  const p99 = percentile(receiptLatencies, 0.99);
  if (p95 !== null && p95 > options.maxP95ReceiptMs) return "receipt_latency_threshold";
  if (p99 !== null && p99 > options.maxP99ReceiptMs) return "receipt_p99_threshold";
  const rss = samples.map((sample) => sample?.process?.rssBytes).filter(Number.isFinite);
  if (rss.some((value) => value > options.maxRssBytes)) return "rss_threshold";
  const lag = samples.flatMap((sample) => [sample?.eventLoopLagMs, sample?.status?.instrumentation?.eventLoopLag?.maxMs]).filter(Number.isFinite);
  if (lag.some((value) => value > options.maxEventLoopLagMs)) return "event_loop_lag_threshold";
  return null;
}

export async function captureStableSourceIdentity({ root = repoRoot } = {}) {
  const first = await createLocalSourceIdentity({ root, includeManifest: true });
  const second = await createLocalSourceIdentity({ root, includeManifest: true });
  if (first.sourceHash !== second.sourceHash) throw new Error(`source changed during identity capture: ${first.sourceHash} -> ${second.sourceHash}`);
  return second;
}

export async function captureStableTreeSourceIdentity({ paths, expectedHash, root = repoRoot } = {}) {
  if (!Array.isArray(paths) || paths.length === 0 || paths.some((sourcePath) => typeof sourcePath !== "string") || !/^[a-f0-9]{64}$/u.test(expectedHash ?? "")) {
    throw new Error("remote generator source identity requires a signed non-empty manifest path list and hash");
  }
  const expected = [...new Set(paths)].sort();
  const capture = async () => {
    const observedPaths = (await listTreeSourcePaths(root, { expectedPaths: expected })).sort();
    const missing = expected.filter((sourcePath) => !observedPaths.includes(sourcePath));
    const extra = observedPaths.filter((sourcePath) => !expected.includes(sourcePath));
    if (missing.length > 0 || extra.length > 0) throw new Error(`remote source path set mismatch (missing=${missing.length}, extra=${extra.length})`);
    const identity = await createTreeSourceIdentity({ root, expectedPaths: expected, includeManifest: true });
    if (identity.sourceHash !== expectedHash) throw new Error("remote source tree hash does not match the signed generator request");
    return identity;
  };
  const first = await capture();
  const second = await capture();
  if (first.sourceHash !== second.sourceHash) throw new Error("remote source tree changed during generator identity capture");
  return second;
}

export function diffSourceManifests(startManifest, finalManifest) {
  if (!startManifest || !finalManifest) return null;
  const start = new Map(startManifest.entries.map((entry) => [entry.path, entry]));
  const final = new Map(finalManifest.entries.map((entry) => [entry.path, entry]));
  return [...new Set([...start.keys(), ...final.keys()])].sort().flatMap((sourcePath) => {
    const before = start.get(sourcePath) ?? null;
    const after = final.get(sourcePath) ?? null;
    if (before?.contentSha256 === after?.contentSha256 && before?.type === after?.type && before?.executable === after?.executable) return [];
    return [{
      path: sourcePath,
      change: before === null ? "added" : after === null ? "removed" : "modified",
      startContentSha256: before?.contentSha256 ?? null,
      finalContentSha256: after?.contentSha256 ?? null,
    }];
  });
}


function normalizeOptions(input = {}) {
  const maxClients = numberValue(input.maxClients ?? (input.allowLarge === true ? maxLargeClients : maxDefaultClients), "maxClients", { integer: true, min: 1, max: maxLargeClients });
  const clients = numberValue(input.clients ?? 5, "clients", { integer: true, min: 1, max: maxLargeClients });
  const allowLarge = input.allowLarge === true;
  if (clients > maxDefaultClients && !allowLarge) throw new Error(`clients above ${maxDefaultClients} require --allow-large`);
  if (clients > maxClients) throw new Error(`clients above configured maxClients ${maxClients}`);
  const profile = input.profile ?? "movement-query";
  if (!Object.hasOwn(OPEN_LOOP_PROFILES, profile)) throw new Error(`unknown open-loop profile ${profile}`);
  const stages = parseStages(input.stages ?? [clients], clients, allowLarge);
  const runId = safeName(input.runId ?? createRunId());
  const port = input.port === undefined || input.port === null ? null : numberValue(input.port, "port", { integer: true, min: 1024, max: 65535 });
  const identityNamespace = String(input.identityNamespace ?? "local");
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/u.test(identityNamespace)) throw new Error("identityNamespace is invalid");
  const clientOffset = numberValue(input.clientOffset ?? 0, "clientOffset", { integer: true, min: 0, max: maxLargeClients });
  if (clientOffset + clients > maxLargeClients) throw new Error("clientOffset plus clients exceeds the seeded identity range");
  if (port === 28093 || port === 5179) throw new Error(`refusing reserved active port ${port}`);
  const defaultBudgets = { maxErrorRate: 0, maxDisconnects: 0, maxP95ReceiptMs: 5_000, maxP99ReceiptMs: 5_000, maxEventLoopLagMs: 500, maxRssBytes: 24 * 1024 ** 3 };
  const capacityBudgetsConfigured = ["maxErrorRate", "maxDisconnects", "maxP95ReceiptMs", "maxP99ReceiptMs", "maxEventLoopLagMs", "maxRssBytes"]
    .some((key) => input[key] !== undefined && Number(input[key]) !== defaultBudgets[key]);
  const warmupMs = numberValue(input.warmupMs ?? 0, "warmupMs", { integer: true, min: 0, max: 300_000 });
  const steadyMs = numberValue(input.steadyMs ?? input.durationMs ?? 1_500, "steadyMs", { integer: true, min: 100, max: 300_000 });
  return {
    maxClients,
    clients,
    stages,
    durationMs: steadyMs,
    warmupMs,
    steadyMs,
    maxRunDurationMs: numberValue(input.maxRunDurationMs ?? 300_000, "maxRunDurationMs", { integer: true, min: 1_000, max: 3_600_000 }),
    workloadMs: numberValue(input.workloadMs ?? 400, "workloadMs", { integer: true, min: 100, max: 60_000 }),
    sampleIntervalMs: numberValue(input.sampleIntervalMs ?? 250, "sampleIntervalMs", { integer: true, min: 100, max: 60_000 }),
    retentionCap: numberValue(input.retentionCap ?? (input.capacityRun ? 1_000_000 : 2_000), "retentionCap", { integer: true, min: 1, max: 1_000_000 }),
    profile,
    rampIntervalMs: numberValue(input.rampIntervalMs ?? 100, "rampIntervalMs", { integer: true, min: 0, max: 60_000 }),
    joinTimeoutMs: numberValue(input.joinTimeoutMs ?? 15_000, "joinTimeoutMs", { integer: true, min: 1_000, max: 60_000 }),
    receiptTimeoutMs: numberValue(input.receiptTimeoutMs ?? 8_000, "receiptTimeoutMs", { integer: true, min: 1_000, max: 60_000 }),
    maxErrorRate: numberValue(input.maxErrorRate ?? 0, "maxErrorRate", { min: 0, max: 1 }),
    maxDisconnects: numberValue(input.maxDisconnects ?? 0, "maxDisconnects", { integer: true, min: 0, max: maxLargeClients }),
    maxP95ReceiptMs: numberValue(input.maxP95ReceiptMs ?? 5_000, "maxP95ReceiptMs", { min: 1, max: 60_000 }),
    maxP99ReceiptMs: numberValue(input.maxP99ReceiptMs ?? 5_000, "maxP99ReceiptMs", { min: 1, max: 60_000 }),
    drainTimeoutMs: numberValue(input.drainTimeoutMs ?? 10_000, "drainTimeoutMs", { integer: true, min: 1, max: 60_000 }),
    expectedServerActiveSessions: input.expectedServerActiveSessions === undefined || input.expectedServerActiveSessions === null ? null : numberValue(input.expectedServerActiveSessions, "expectedServerActiveSessions", { integer: true, min: 0, max: maxLargeClients }),
    maxEventLoopLagMs: numberValue(input.maxEventLoopLagMs ?? 500, "maxEventLoopLagMs", { min: 1, max: 60_000 }),
    maxRssBytes: numberValue(input.maxRssBytes ?? (24 * 1024 ** 3), "maxRssBytes", { integer: true, min: 1, max: 128 * 1024 ** 3 }),
    drainMs: numberValue(input.drainMs ?? 1_000, "drainMs", { integer: true, min: 0, max: 60_000 }),
    runId,
    identityNamespace,
    clientOffset,
    outDir: input.outDir ? path.resolve(input.outDir) : null,
    adoptUrl: input.adoptUrl ? normalizeUrl(input.adoptUrl) : null,
    port,
    processHostKind: input.processHostKind ?? null,
    allowLarge,
    generatorStdin: input.generatorStdin === true,
    mode: input.mode === "open-loop" ? "open-loop" : "closed-loop",
    capacityRun: input.capacityRun === true,
    capacityBudgetsConfigured,
    slicePath: input.slicePath ?? defaultSlicePath,
    cliPath: input.cliPath ?? defaultCliPath,
    expectedSourceHash: input.expectedSourceHash ?? null,
    sourceIdentity: input.sourceIdentity,
    captureSourceIdentity: input.captureSourceIdentity,
    createMetricsPoller: input.createMetricsPoller,
    startDriver: input.startDriver,
    signal: input.signal,
  };
}

function parseStages(value, clients, allowLarge) {
  const parsed = (Array.isArray(value) ? value : String(value).split(","))
    .map((entry) => numberValue(entry, "stages", { integer: true, min: 1, max: maxLargeClients }));
  if (parsed.length === 0 || parsed.at(-1) !== clients) throw new Error("stages must be an increasing ramp ending at clients");
  for (let index = 1; index < parsed.length; index += 1) {
    if (parsed[index] <= parsed[index - 1]) throw new Error("stages must be strictly increasing");
  }
  if (parsed.some((stage) => stage > maxDefaultClients) && !allowLarge) throw new Error(`stages above ${maxDefaultClients} require --allow-large`);
  return parsed;
}
export function canonicalLoadCharacterId(runId, identityNamespace, ordinal) {
  const canonicalRunId = canonicalActorIdToken(runId, "runId");
  const canonicalNamespace = canonicalActorIdToken(identityNamespace, "identityNamespace");
  const canonicalOrdinal = numberValue(ordinal, "ordinal", { integer: true, min: 1 });
  const id = `player-load-${canonicalRunId}-${canonicalNamespace}-${String(canonicalOrdinal).padStart(3, "0")}`;
  if (id.length > 64) throw new Error("canonical load character ID exceeds the server actor-ID length limit");
  return id;
}

function canonicalActorIdToken(value, label) {
  const normalized = String(value)
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 64);
  if (!normalized) throw new Error(`${label} must include a server-safe token`);
  return normalized;
}

function loadStarterProfessionState(initialProfessionId) {
  return {
    learned: [],
    trackXp: {},
    skillBoxes: [`${initialProfessionId}-novice`],
    activeTitleId: null,
    credits: 5_000,
    skillPointCap: 250,
  };
}

export function summarizeWorkload(phases) {
  const hasClasses = phases.some((phase) => phase?.workload?.classes);
  const total = createWorkloadAccounting(hasClasses ? "movement-query" : null);
  for (const phase of phases) {
    const workload = phase?.workload ?? {};
    total.attempted += workload.attempted ?? 0;
    total.accepted += workload.accepted ?? 0;
    total.rejected += workload.rejected ?? 0;
    if (hasClasses) {
      total.completed += workload.completed ?? 0;
      total.errors += workload.errors ?? 0;
    }
    for (const [reason, count] of Object.entries(workload.rejectionReasons ?? {})) {
      total.rejectionReasons[reason] = (total.rejectionReasons[reason] ?? 0) + count;
    }
    for (const [name, item] of Object.entries(workload.classes ?? {})) {
      const target = total.classes[name];
      if (!target) continue;
      for (const key of ["intended", "attempted", "completed", "accepted", "rejected", "errors"]) target[key] += item[key] ?? 0;
      for (const [reason, count] of Object.entries(item.rejectionReasons ?? {})) target.rejectionReasons[reason] = (target.rejectionReasons[reason] ?? 0) + count;
      target.latencyCount += item.latencyMs?.count ?? 0;
      for (const [reason, count] of Object.entries(item.errorReasons ?? {})) target.errorReasons[reason] = (target.errorReasons[reason] ?? 0) + count;
      if (item.__latencies?.length) target.latencies.push(...item.__latencies);
      else if (item.latencyMs) target.latencies.push(...expandLatencySummary(item.latencyMs));
    }
  }
  return materializeWorkload(total);
}

function expandLatencySummary(summary) {
  if (!summary || !Number.isFinite(summary.count)) return [];
  if (summary.count === 1 && Number.isFinite(summary.p50)) return [summary.p50];
  return [summary.first, summary.p50, summary.p95, summary.p99, summary.max].filter(Number.isFinite);
}

export async function writeLoadCharacterStore(storePath, runId, count, identityNamespaces = ["local"]) {
  const now = new Date().toISOString();
  const namespaces = identityNamespaces.map((namespace) => ({
    firstId: canonicalLoadCharacterId(runId, namespace, 1),
    namespace,
  }));
  if (namespaces.length === 0) throw new Error("character store requires at least one identity namespace");
  if (new Set(namespaces.map(({ firstId }) => firstId)).size !== namespaces.length) {
    throw new Error("identity namespaces collide after server actor-ID canonicalization");
  }
  const characters = namespaces.flatMap(({ namespace }, namespaceIndex) => Array.from({ length: count }, (_, index) => {
    const id = canonicalLoadCharacterId(runId, namespace, index + 1);
    return {
      id,
      ownerRef: "local",
      name: loadCharacterName(namespaceIndex * count + index),
      appearance: defaultAppearance,
      worn: defaultWorn,
      wornColors: Object.fromEntries(defaultWorn.map((entry) => [entry.item, entry.colors])),
      position: { areaId: "open-desert-overworld", x: 512 + (index % 8), y: 512 + Math.floor(index / 8), facing: "right" },
      vitals: { health: 280, action: 160, spirit: 100 },
      initialProfessionId: "marksman",
      professions: loadStarterProfessionState("marksman"),
      activeTitleId: null,
      careerGoalId: null,
      recordKinds: { "successor.macros.v1": { version: 1, items: [] } },
      worldEntryClaimed: false,
      createdAt: now,
      lastSeenAt: now,
      lastLogoutAt: null,
      totalPlayMs: 0,
    };
  }));
  await fs.writeFile(storePath, `${JSON.stringify({ schema: characterStoreSchema, characters }, null, 2)}\n`, "utf8");
}

function loadCharacterName(index) {
  let value = index + 1;
  let suffix = "";
  while (value > 0) {
    value -= 1;
    suffix = String.fromCharCode(65 + (value % 26)) + suffix;
    value = Math.floor(value / 26);
  }
  return `Load-${suffix}`;
}

export async function findFreePort() {
  for (let port = 28120; port < 28220; port += 1) {
    // Never probe or bind a known active interactive service port.
    if (port === 28093 || port === 5179) continue;
    if (await portIsFree(port)) return port;
  }
  throw new Error("no isolated player-load port available in 28120-28219");
}

function portIsFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => server.close(() => resolve(true)));
    server.listen(port, "127.0.0.1");
  });
}

async function waitForStatus(gameUrl, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() <= deadline) {
    last = await fetchJson(`${gameUrl}/game/status`).catch(() => null);
    if (last?.shardId && last?.source?.stateHash) return last;
    await delay(100);
  }
  throw new Error(`timed out waiting for isolated player-load server: ${JSON.stringify(last)}`);
}

function assertSourceStatus(status, expectedStateHash) {
  if (!status?.source?.stateHash || !status?.source?.sliceHash) throw new Error("server status lacks source validation metadata");
  if (expectedStateHash && status.source.stateHash !== expectedStateHash) {
    throw new Error(`server source hash mismatch: expected ${expectedStateHash}, got ${status.source.stateHash}`);
  }
}

async function fetchJson(url) {
  const response = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(4_000) });
  const text = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status} ${url}: ${text.slice(0, 300)}`);
  try {
    return text ? JSON.parse(text) : null;
  } catch (error) {
    throw new Error(`invalid JSON from ${url}: ${errorMessage(error)}`);
  }
}

function onceClose(bot) {
  let closePromise = null;
  return () => {
    closePromise ??= bot.close();
    return closePromise;
  };
}

function compactSource(source) {
  if (!source || typeof source !== "object") return null;
  return {
    stateHash: typeof source.stateHash === "string" ? source.stateHash : null,
    sliceHash: typeof source.sliceHash === "string" ? source.sliceHash : null,
    actorCount: Number.isFinite(source.actorCount) ? source.actorCount : null,
  };
}

function publicOptions(options) {
  return {
    clients: options.clients,
    stages: options.stages,
    durationMs: options.durationMs,
    warmupMs: options.warmupMs,
    steadyMs: options.steadyMs,
    workloadMs: options.workloadMs,
    profile: options.profile,
    maxClients: options.maxClients,
    maxRunDurationMs: options.maxRunDurationMs,
    retentionCap: options.retentionCap,
    sampleIntervalMs: options.sampleIntervalMs,
    mode: options.mode,
    capacityRun: options.capacityRun,
    capacityBudgetsConfigured: options.capacityBudgetsConfigured,
    maxErrorRate: options.maxErrorRate,
    maxDisconnects: options.maxDisconnects,
    maxP95ReceiptMs: options.maxP95ReceiptMs,
    maxP99ReceiptMs: options.maxP99ReceiptMs,
    maxEventLoopLagMs: options.maxEventLoopLagMs,
    maxRssBytes: options.maxRssBytes,
    drainMs: options.drainMs,
    allowLarge: options.allowLarge,
  };
}

function numericOrNull(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function normalizeUrl(value) {
  const parsed = new URL(value);
  if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("adopt-url must be http(s)");
  return parsed.toString().replace(/\/$/u, "");
}

function numberValue(value, label, { integer = false, min = -Infinity, max = Infinity } = {}) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || (integer && !Number.isInteger(parsed)) || parsed < min || parsed > max) {
    throw new Error(`${label} must be ${integer ? "an integer" : "a number"} from ${min} to ${max}; got ${value}`);
  }
  return parsed;
}

function safeName(value) {
  const normalized = String(value).replace(/[^a-zA-Z0-9_-]/gu, "-").replace(/-+/gu, "-").replace(/^-|-$/gu, "");
  if (!normalized) throw new Error("run id must include an alphanumeric character");
  return normalized.slice(0, 64);
}

function createRunId() {
  return `load-${new Date().toISOString().replace(/[^0-9]/gu, "").slice(0, 14)}-${process.pid}`;
}

function errorRecord(error, phase, client = null) {
  return { phase, ...(client ? { client } : {}), message: errorMessage(error) };
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function round(value) {
  return Math.round(value * 1000) / 1000;
}

async function readGeneratorRequest() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) throw new Error("--generator-stdin requires one JSON request on stdin");
  return JSON.parse(raw);
}

function installAbortSignal() {
  const controller = new AbortController();
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.once(signal, () => controller.abort(new Error(`received ${signal}`)));
  }
  return controller;
}

async function main() {
  const options = parsePlayerLoadArgs(process.argv.slice(2));
  const controller = installAbortSignal();
  if (options.generatorStdin) {
    const request = await readGeneratorRequest();
    const result = await runPlayerLoadGenerator({ ...request, signal: controller.signal });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.exitCode = result.status === "pass" && result.teardown.clean ? 0 : 1;
    return;
  }
  const result = await runPlayerLoad({ ...options, signal: controller.signal });
  process.stdout.write(`${JSON.stringify({ schema: reportSchema, status: result.report.status, reportPath: result.reportPath, teardown: result.report.teardown })}\n`);
  process.exitCode = result.report.status === "pass" ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  });
}
