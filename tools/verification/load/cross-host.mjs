import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { FarmError, repoRoot } from "../farm/common.mjs";
import { sha256Json, validateId } from "../farm/protocol.mjs";
import { createLocalSourceIdentity } from "../farm/source-hash.mjs";
import { findFreePort, runPlayerLoadGenerator, startIsolatedServer, stopAndAssert } from "./player-load.mjs";
import { createMetricsPoller } from "./metrics.mjs";
import { executeMacPlayerGenerator, launchPreparedMacPlayerGenerator, prepareMacPlayerGenerator, validateRemoteGeneratorResult } from "./remote-generator.mjs";

export const CROSS_HOST_PLAYER_LOAD_REPORT_SCHEMA = "successor.player-load-cross-host-report.v1";
const MAX_GENERATOR_CLIENTS = 16;
const DEFAULT_MAX_RSS_BYTES = 24 * 1024 ** 3;
const DEFAULT_MAX_EVENT_LOOP_LAG_MS = 500;
const MAX_PC_SERVER_EVIDENCE_SAMPLES = 120;

/**
 * Runs the only currently safe cross-host mode: a Mac-only population against
 * a PC-owned isolated server. A local+Mac population is deliberately refused
 * until a real multi-phase distributed barrier exists.
 */
export async function runCrossHostPlayerLoad({
  root = repoRoot,
  endpoint,
  localEndpoint = endpoint,
  remoteEndpoint = endpoint,
  macHost,
  runId,
  localClients = 0,
  macClients = 5,
  durationMs = 5_000,
  rampIntervalMs = 500,
  sampleIntervalMs = 1_000,
  sourceHash,
  createSourceIdentity = createLocalSourceIdentity,
  remoteGenerator = executeMacPlayerGenerator,
  prepareRemote = prepareMacPlayerGenerator,
  launchRemote = launchPreparedMacPlayerGenerator,
  readServerCounters = readIsolatedServerCounters,
  signal,
} = {}) {
  validateLocalClientCount(localClients);
  validateClientCount(macClients, "Mac");
  if (localClients > 0) {
    throw new FarmError("simultaneous local and Mac player populations are refused until a distributed phase barrier exists", { code: "COMBINED_LOCAL_MAC_UNSUPPORTED" });
  }
  validateId(runId, "load runId");
  const controller = new AbortController();
  const forwardAbort = () => controller.abort(signal?.reason);
  if (signal) {
    if (signal.aborted) forwardAbort();
    else signal.addEventListener("abort", forwardAbort, { once: true });
  }
  try {
    const initial = await createSourceIdentity({ root, includeManifest: true });
    const sharedSourceHash = sourceHash ?? initial.sourceHash;
    if (sharedSourceHash !== initial.sourceHash) {
      throw new FarmError("cross-host player load source hash is stale before generator launch", { code: "SOURCE_CHANGED_BEFORE_GENERATORS" });
    }
    const expectedServerActiveSessions = macClients;
    const request = {
      runId,
      sourceHash: sharedSourceHash,
      sourcePaths: initial.manifest?.entries.map((entry) => entry.path),
      durationMs,
      rampIntervalMs,
      sampleIntervalMs,
      expectedServerActiveSessions,
      endpoint: remoteEndpoint,
      clients: macClients,
      generatorId: "mac",
      identityNamespace: "mac",
      clientOffset: 0,
    };
    const guard = (work) => Promise.resolve().then(work).catch((error) => {
      controller.abort(error);
      throw error;
    });
    const preparedMac = remoteGenerator === executeMacPlayerGenerator
      ? await guard(() => prepareRemote({ root, host: macHost, ...request, signal: controller.signal }))
      : null;
    const baseline = await readServerCounters(localEndpoint);
    const execution = await guard(() => preparedMac
      ? launchRemote(preparedMac)
      : remoteGenerator({ root, host: macHost, ...request, signal: controller.signal }));
    const macResult = execution?.result ?? execution;
    validateRemoteGeneratorResult(macResult, request);
    const finalCounters = await readServerCounters(localEndpoint);
    const counters = reconcileAuthorityCounters({ result: macResult, baseline, final: finalCounters });
    const final = await createSourceIdentity({ root, includeManifest: false });
    if (final.sourceHash !== sharedSourceHash) {
      throw new FarmError("source changed while player generators were active; merged data is refused", { code: "SOURCE_CHANGED_DURING_GENERATORS" });
    }
    return mergePlayerGeneratorResults({ runId, sourceHash: sharedSourceHash, endpoint: remoteEndpoint, generators: [macResult], centralCounters: counters });
  } finally {
    if (signal) signal.removeEventListener("abort", forwardAbort);
  }
}

export async function runIsolatedCrossHostPlayerLoad({ root = repoRoot, relayAddress, macHost, runId, localClients = 0, macClients = 5, durationMs = 5_000, rampIntervalMs = 500, sampleIntervalMs = 1_000, startServer = startIsolatedServer, allocatePort = findFreePort, waitForRelayStatus = waitForGameStatus, createMetricsPoller: createPcMetricsPoller = createMetricsPoller, maxRssBytes = DEFAULT_MAX_RSS_BYTES, maxEventLoopLagMs = DEFAULT_MAX_EVENT_LOOP_LAG_MS, ...options } = {}) {
  validateRelayAddress(relayAddress);
  validateId(runId, "load runId");
  validateLocalClientCount(localClients);
  validateClientCount(macClients, "Mac");
  if (localClients > 0) throw new FarmError("simultaneous local and Mac player populations are refused until a distributed phase barrier exists", { code: "COMBINED_LOCAL_MAC_UNSUPPORTED" });
  const thresholds = validatePcMetricThresholds({ maxRssBytes, maxEventLoopLagMs });
  const runDir = path.join(root, "verification", ".runs", "player-load", `cross-host-${runId}`);
  await fs.mkdir(runDir, { recursive: true });
  const source = await createLocalSourceIdentity({ root, includeManifest: true });
  let runtime = null;
  let relayHandle = null;
  let poller = null;
  let pollerStopped = false;
  let primaryError = null;
  try {
    runtime = await startServer({
      root,
      runId,
      runDir,
      clients: macClients,
      identityNamespaces: ["mac"],
      processHostKind: "child",
      sourceHash: source.sourceHash,
      sourcePaths: source.manifest?.entries.map((entry) => entry.path),
    });
    poller = createPcMetricsPoller({
      gameUrl: runtime.gameUrl,
      processHost: runtime.processHost,
      handle: runtime.handle,
      intervalMs: sampleIntervalMs,
    });
    assertMetricsPoller(poller);
    poller.start();

    const relayPort = await allocatePort();
    const relayEndpoint = `http://${relayAddress}:${relayPort}`;
    relayHandle = await runtime.processHost.start({
      name: `successor-player-load-${runId}-relay-${relayPort}`,
      argv: ["socat", `TCP-LISTEN:${relayPort},bind=${relayAddress},reuseaddr,fork`, `TCP:127.0.0.1:${new URL(runtime.gameUrl).port}`],
      cwd: root,
    });
    await waitForRelayStatus(relayEndpoint, 10_000);
    const report = await runCrossHostPlayerLoad({
      root,
      endpoint: relayEndpoint,
      localEndpoint: runtime.gameUrl,
      remoteEndpoint: relayEndpoint,
      macHost,
      runId,
      localClients,
      macClients,
      durationMs,
      rampIntervalMs,
      sampleIntervalMs,
      sourceHash: source.sourceHash,
      ...options,
    });
    await stopPcMetricsPoller(poller);
    pollerStopped = true;
    const pcServerMetrics = summarizePcServerMetrics(poller.samples, typeof poller.summary === "function" ? poller.summary() : null);
    validatePcServerMetrics(pcServerMetrics, thresholds);
    return attachIsolatedMetadata(report, {
      pcGameUrl: runtime.gameUrl,
      relayEndpoint,
      characterStorePath: runtime.characterStorePath,
      artifacts: runtime.artifacts ?? null,
      pcServerMetrics,
    });
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    if (runtime) {
      let metricsError = null;
      if (poller && !pollerStopped) {
        try {
          await stopPcMetricsPoller(poller);
          pollerStopped = true;
        } catch (error) {
          metricsError = error;
        }
      }
      const settledCleanup = await Promise.allSettled([
        relayHandle ? stopAndAssert(runtime.processHost, relayHandle) : Promise.resolve({ ok: true, failures: [] }),
        stopAndAssert(runtime.processHost, runtime.handle),
      ]);
      const failures = settledCleanup.flatMap((entry, index) => entry.status === "rejected"
        ? [{ target: index === 0 ? "relay" : "server", failure: `cleanup threw: ${errorMessage(entry.reason)}` }]
        : entry.value.ok ? [] : entry.value.failures.map((failure) => ({ target: index === 0 ? "relay" : "server", failure })));
      const cleanupError = failures.length > 0
        ? new FarmError("isolated PC load server or relay did not tear down cleanly", { code: "ISOLATED_LOAD_TEARDOWN_FAILED", details: { failures } })
        : null;
      const secondaryErrors = [metricsError, cleanupError].filter(Boolean);
      if (primaryError && secondaryErrors.length > 0) {
        throw new AggregateError([primaryError, ...secondaryErrors], "cross-host load failed and isolated cleanup also failed");
      }
      if (!primaryError && secondaryErrors.length === 1) throw secondaryErrors[0];
      if (!primaryError && secondaryErrors.length > 1) throw new AggregateError(secondaryErrors, "isolated cross-host cleanup failed");
    }
  }
}

export function attachIsolatedMetadata(report, isolated) {
  const { checksum: _checksum, ...unsigned } = report;
  const document = { ...unsigned, isolated: { ...isolated } };
  return { ...document, checksum: sha256Json(document) };
}

function validateRelayAddress(value) {
  if (typeof value !== "string" || !/^(?!127\.)(?!0\.0\.0\.0$)[0-9A-Fa-f:.]+$/u.test(value)) throw new FarmError("cross-host load requires a non-loopback Tailscale/LAN relay address", { code: "INVALID_RELAY_ADDRESS" });
}
export function summarizePcServerMetrics(samples, pollerSummary = null) {
  const observed = Array.isArray(samples) ? samples : [];
  const processSamples = observed.map((sample) => sample?.process ?? null);
  const pids = processSamples.map((process) => finite(process?.pid)).filter((value) => value !== null);
  const uniquePids = [...new Set(pids)];
  const leaderRss = processSamples.map((process) => finite(process?.rssBytes));
  const groupMemory = processSamples.map((process) => finite(process?.memoryCurrentBytes));
  const cpu = observed.map((sample) => ({ value: finite(sample?.process?.cpuUsageNSec), observedAtMs: observedAtMs(sample) })).filter((entry) => entry.value !== null);
  const controllerLag = observed.map((sample) => finite(sample?.eventLoopLagMs)).filter((value) => value !== null);
  const serverLagP95 = observed.map((sample) => finite(sample?.status?.instrumentation?.eventLoopLag?.p95Ms)).filter((value) => value !== null);
  const serverLagMax = observed.map((sample) => finite(sample?.status?.instrumentation?.eventLoopLag?.maxMs)).filter((value) => value !== null);
  const firstCpu = cpu[0] ?? null;
  const lastCpu = cpu.at(-1) ?? null;
  const observedIntervalMs = firstCpu && lastCpu && Number.isFinite(firstCpu.observedAtMs) && Number.isFinite(lastCpu.observedAtMs)
    ? lastCpu.observedAtMs - firstCpu.observedAtMs
    : null;
  const cpuDeltaNSec = firstCpu && lastCpu && lastCpu.value >= firstCpu.value ? lastCpu.value - firstCpu.value : null;
  const averageCpuCores = cpuDeltaNSec !== null && observedIntervalMs !== null && observedIntervalMs > 0
    ? cpuDeltaNSec / (observedIntervalMs * 1_000_000)
    : null;
  return {
    sampleCount: observed.length,
    pid: { values: uniquePids, consistent: observed.length >= 2 && pids.length === observed.length && uniquePids.length === 1 },
    leaderRssBytes: sampledBytes(leaderRss),
    groupMemoryCurrentBytes: sampledBytes(groupMemory),
    cpu: {
      firstUsageNSec: firstCpu?.value ?? null,
      lastUsageNSec: lastCpu?.value ?? null,
      deltaNSec: cpuDeltaNSec,
      observedIntervalMs,
      averageCores: averageCpuCores,
    },
    maxControllerEventLoopLagMs: finite(pollerSummary?.maxEventLoopLagMs) ?? maximum(controllerLag),
    serverEventLoopLagMs: { p95Ms: maximum(serverLagP95), maxMs: maximum(serverLagMax) },
    processMetricsAvailable: observed.length >= 2 && processSamples.every((process) => finite(process?.rssBytes) !== null && finite(process?.memoryCurrentBytes) !== null && finite(process?.cpuUsageNSec) !== null),
    samples: boundedSamples(observed),
  };
}

export function validatePcServerMetrics(summary, thresholds) {
  if (!summary?.processMetricsAvailable || !summary?.pid?.consistent || summary.sampleCount < 2) {
    throw new FarmError("isolated PC server process metrics are unavailable or inconsistent", {
      code: "PC_SERVER_PROCESS_METRICS_UNAVAILABLE",
      details: { sampleCount: summary?.sampleCount ?? 0, processMetricsAvailable: summary?.processMetricsAvailable === true, pidConsistent: summary?.pid?.consistent === true },
    });
  }
  const violations = [
    ["groupMemoryCurrentBytes.max", summary.groupMemoryCurrentBytes?.max, thresholds.maxRssBytes],
    ["maxControllerEventLoopLagMs", summary.maxControllerEventLoopLagMs, thresholds.maxEventLoopLagMs],
    ["serverEventLoopLagMs.p95Ms", summary.serverEventLoopLagMs?.p95Ms, thresholds.maxEventLoopLagMs],
    ["serverEventLoopLagMs.maxMs", summary.serverEventLoopLagMs?.maxMs, thresholds.maxEventLoopLagMs],
  ].flatMap(([metric, value, limit]) => Number.isFinite(value) && value > limit ? [{ metric, value, limit }] : []);
  if (violations.length > 0) {
    throw new FarmError("isolated PC server metrics exceeded configured performance thresholds", { code: "PC_SERVER_METRICS_THRESHOLD_EXCEEDED", details: { violations } });
  }
  return summary;
}

function validatePcMetricThresholds({ maxRssBytes, maxEventLoopLagMs }) {
  if (!Number.isFinite(maxRssBytes) || maxRssBytes <= 0 || !Number.isFinite(maxEventLoopLagMs) || maxEventLoopLagMs <= 0) {
    throw new FarmError("isolated PC metric thresholds must be positive finite numbers", { code: "INVALID_PC_METRICS_THRESHOLD" });
  }
  return { maxRssBytes, maxEventLoopLagMs };
}

function assertMetricsPoller(poller) {
  if (!poller || typeof poller.start !== "function" || typeof poller.stop !== "function" || !Array.isArray(poller.samples)) {
    throw new FarmError("isolated PC metrics poller is invalid", { code: "PC_SERVER_PROCESS_METRICS_UNAVAILABLE" });
  }
}

async function stopPcMetricsPoller(poller) {
  try {
    await poller.stop();
  } catch (error) {
    throw new FarmError("isolated PC server metrics sampling failed", { code: "PC_SERVER_METRICS_SAMPLING_FAILED", details: { errors: Array.isArray(poller?.errors) ? poller.errors : [] }, cause: error });
  }
}

function boundedSamples(samples) {
  if (samples.length <= MAX_PC_SERVER_EVIDENCE_SAMPLES) return samples.map((sample) => ({ ...sample }));
  const half = MAX_PC_SERVER_EVIDENCE_SAMPLES / 2;
  return [...samples.slice(0, half), ...samples.slice(-half)].map((sample) => ({ ...sample }));
}

function observedAtMs(sample) {
  const value = Date.parse(sample?.timestamp ?? "");
  return Number.isFinite(value) ? value : null;
}

function maximum(values) {
  const finiteValues = values.filter((value) => value !== null && Number.isFinite(value));
  return finiteValues.length > 0 ? Math.max(...finiteValues) : null;
}
function sampledBytes(values) {
  return {
    first: values[0] ?? null,
    last: values.at(-1) ?? null,
    max: maximum(values),
  };
}


function finite(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}


export async function waitForGameStatus(endpoint, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const remainingMs = Math.max(1, deadline - Date.now());
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), remainingMs);
    const status = await fetch(`${endpoint}/game/status`, { signal: controller.signal })
      .then((response) => response.ok ? response.json() : null)
      .catch(() => null)
      .finally(() => clearTimeout(timeout));
    if (status?.shardId && status?.source?.stateHash) return status;
    await new Promise((resolve) => setTimeout(resolve, Math.min(100, Math.max(1, deadline - Date.now()))));
  }
  throw new FarmError("temporary Tailscale relay did not expose the isolated PC server", { code: "RELAY_UNREACHABLE" });
}

export async function readIsolatedServerCounters(endpoint) {
  const response = await fetch(`${endpoint}/game/status`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(4_000) });
  if (!response.ok) throw new FarmError("isolated server counter read failed", { code: "ISOLATED_COUNTER_READ_FAILED", details: { status: response.status } });
  const status = await response.json();
  const commands = status?.instrumentation?.commands;
  if (!commands || ![commands.accepted, commands.rejected, commands.receipts].every(Number.isInteger)) {
    throw new FarmError("isolated server status lacks exact authority command counters", { code: "ISOLATED_COUNTERS_UNAVAILABLE" });
  }
  return { accepted: commands.accepted, rejected: commands.rejected, receipts: commands.receipts };
}

export function reconcileAuthorityCounters({ result, baseline, final }) {
  const command = result?.commands;
  if (!command || ![command.attempted, command.queued, command.receipts, command.accepted, command.rejected].every(Number.isInteger)
    || command.attempted !== command.queued || command.queued !== command.receipts || command.accepted + command.rejected !== command.receipts) {
    throw new FarmError("generator authority command accounting is not exact", { code: "GENERATOR_COMMAND_ACCOUNTING_INVALID" });
  }
  if (![baseline, final].every((counter) => counter && [counter.accepted, counter.rejected, counter.receipts].every(Number.isInteger))) {
    throw new FarmError("isolated server counter baseline/final is invalid", { code: "ISOLATED_COUNTERS_INVALID" });
  }
  const delta = {
    accepted: final.accepted - baseline.accepted,
    rejected: final.rejected - baseline.rejected,
    receipts: final.receipts - baseline.receipts,
  };
  if (delta.accepted !== command.accepted || delta.rejected !== command.rejected || delta.receipts !== command.receipts) {
    throw new FarmError("generator command totals do not reconcile to isolated server authority counters", {
      code: "AUTHORITY_COUNTER_RECONCILIATION_FAILED",
      details: { generator: command, baseline, final, delta },
    });
  }
  return { baseline, final, delta };
}

export function mergePlayerGeneratorResults({ runId, sourceHash, endpoint, generators, centralCounters = null }) {
  validateId(runId, "load runId");
  if (typeof sourceHash !== "string" || !/^[a-f0-9]{64}$/u.test(sourceHash)) throw new FarmError("cross-host report source hash is invalid", { code: "INVALID_SOURCE_HASH" });
  if (!Array.isArray(generators) || generators.length < 1) throw new FarmError("cross-host report requires a generator result", { code: "MISSING_GENERATOR_RESULTS" });
  const identities = new Set();
  const byGenerator = {};
  for (const generator of generators) {
    if (!generator || generator.runId !== runId || generator.sourceHash !== sourceHash || typeof generator.generatorId !== "string" || identities.has(generator.generatorId)) {
      throw new FarmError("cross-host report generators must have distinct IDs and identical run/source bindings", { code: "GENERATOR_BINDING_MISMATCH" });
    }
    identities.add(generator.generatorId);
    byGenerator[generator.generatorId] = { ...generator, samples: transportStatusSamples(generator.samples) };
  }
  const ordered = [...generators].sort((left, right) => left.generatorId.localeCompare(right.generatorId));
  const report = {
    schema: CROSS_HOST_PLAYER_LOAD_REPORT_SCHEMA,
    mode: "remote-only",
    status: ordered.every((generator) => generator.status === "pass" && generator.teardown?.clean === true) ? "pass" : "fail",
    runId,
    sourceHash,
    endpoint,
    generators: byGenerator,
    aggregate: {
      clients: sumClients(ordered),
      commands: {
        attempted: sum(ordered, (generator) => generator.commands?.attempted),
        queued: sum(ordered, (generator) => generator.commands?.queued),
        sent: sum(ordered, (generator) => generator.commands?.sent),
        receipts: sum(ordered, (generator) => generator.commands?.receipts),
        accepted: sum(ordered, (generator) => generator.commands?.accepted),
        rejected: sum(ordered, (generator) => generator.commands?.rejected),
      },
      throughput: {
        aggregation: "by-generator-window-only",
        byGenerator: Object.fromEntries(ordered.map((generator) => [generator.generatorId, generator.throughput])),
      },
      ...(centralCounters ? { centralCounters } : {}),
      errors: ordered.flatMap((generator) => annotate(generator.generatorId, generator.errors)),
      disconnects: ordered.flatMap((generator) => annotate(generator.generatorId, generator.disconnects)),
      latency: {
        aggregation: "not-derived-from-percentiles",
        byGenerator: Object.fromEntries(ordered.map((generator) => [generator.generatorId, generator.latency])),
      },
      transportStatus: {
        aggregation: "remote-transport-status-only-not-process-metrics",
        byGenerator: Object.fromEntries(ordered.map((generator) => [generator.generatorId, transportStatusSamples(generator.samples)])),
      },
    },
  };
  return { ...report, checksum: sha256Json(report) };
}

export async function writeCrossHostPlayerLoadReport({ root = repoRoot, report }) {
  if (report?.schema !== CROSS_HOST_PLAYER_LOAD_REPORT_SCHEMA || typeof report.runId !== "string") {
    throw new FarmError("cannot write an invalid cross-host player load report", { code: "INVALID_CROSS_HOST_REPORT" });
  }
  const output = path.join(root, "verification", ".runs", "player-load", report.runId, "cross-host-report.json");
  await fs.mkdir(path.dirname(output), { recursive: true });
  const temporary = `${output}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(temporary, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  await fs.rename(temporary, output);
  return output;
}

function validateClientCount(value, host) {
  if (!Number.isInteger(value) || value < 1 || value > MAX_GENERATOR_CLIENTS) {
    throw new FarmError(`${host} client count must be between 1 and ${MAX_GENERATOR_CLIENTS}`, { code: "REMOTE_CLIENT_LIMIT" });
  }
}

function validateLocalClientCount(value) {
  if (!Number.isInteger(value) || value < 0 || value > MAX_GENERATOR_CLIENTS) {
    throw new FarmError(`local client count must be between 0 and ${MAX_GENERATOR_CLIENTS}`, { code: "LOCAL_CLIENT_LIMIT" });
  }
}

function sum(generators, select) {
  return generators.reduce((total, generator) => total + (Number.isFinite(select(generator)) ? select(generator) : 0), 0);
}

function sumClients(generators) {
  return {
    requested: sum(generators, (generator) => generator.clients?.requested),
    identityJoined: sum(generators, (generator) => generator.clients?.identityJoined),
    joined: sum(generators, (generator) => generator.clients?.joined),
  };
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function annotate(generatorId, entries) {
  return Array.isArray(entries) ? entries.map((entry) => ({ generatorId, ...entry })) : [];
}

function transportStatusSamples(samples) {
  if (!Array.isArray(samples)) return [];
  return samples.map(({ process: _process, ...sample }) => ({ ...sample, evidenceKind: "remote-transport-status" }));
}

export function parseCrossHostPlayerLoadArgs(argv) {
  const values = {};
  const known = new Set(["endpoint", "mac-host", "run-id", "local-clients", "mac-clients", "duration-ms", "ramp-interval-ms", "sample-interval-ms"]);
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) throw new FarmError(`unexpected argument ${token}`, { code: "INVALID_LOAD_ARGUMENT" });
    const [name, inline] = token.slice(2).split("=", 2);
    if (!known.has(name)) throw new FarmError(`unknown argument --${name}`, { code: "INVALID_LOAD_ARGUMENT" });
    const value = inline ?? argv[++index];
    if (!value || value.startsWith("--")) throw new FarmError(`--${name} requires a value`, { code: "INVALID_LOAD_ARGUMENT" });
    values[name] = value;
  }
  if (!values.endpoint || !values["mac-host"] || !values["run-id"]) {
    throw new FarmError("--endpoint, --mac-host, and --run-id are required", { code: "INVALID_LOAD_ARGUMENT" });
  }
  return {
    endpoint: values.endpoint,
    macHost: values["mac-host"],
    runId: values["run-id"],
    localClients: nonnegativeNumericArgument(values["local-clients"] ?? "0", "local-clients"),
    macClients: numericArgument(values["mac-clients"] ?? "5", "mac-clients"),
    durationMs: numericArgument(values["duration-ms"] ?? "5000", "duration-ms"),
    rampIntervalMs: numericArgument(values["ramp-interval-ms"] ?? "500", "ramp-interval-ms"),
    sampleIntervalMs: numericArgument(values["sample-interval-ms"] ?? "1000", "sample-interval-ms"),
  };
}

function numericArgument(value, label) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new FarmError(`--${label} must be a positive integer`, { code: "INVALID_LOAD_ARGUMENT" });
  return parsed;
}

function nonnegativeNumericArgument(value, label) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw new FarmError(`--${label} must be a non-negative integer`, { code: "INVALID_LOAD_ARGUMENT" });
  return parsed;
}

async function main() {
  const options = parseCrossHostPlayerLoadArgs(process.argv.slice(2));
  const report = await runIsolatedCrossHostPlayerLoad({ ...options, relayAddress: new URL(options.endpoint).hostname });
  const reportPath = await writeCrossHostPlayerLoadReport({ report });
  process.stdout.write(`${JSON.stringify({ schema: CROSS_HOST_PLAYER_LOAD_REPORT_SCHEMA, mode: "remote-only", status: report.status, reportPath, checksum: report.checksum })}\n`);
  process.exitCode = report.status === "pass" ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    const failures = Array.isArray(error?.details?.failures)
      ? error.details.failures.map((failure) => ({ code: failure?.code ?? "GENERATOR_FAILED", ...(failure?.details ? { details: failure.details } : {}) }))
      : undefined;
    process.stderr.write(`${JSON.stringify({ schema: CROSS_HOST_PLAYER_LOAD_REPORT_SCHEMA, status: "error", error: { code: error?.code ?? "UNEXPECTED_ERROR", ...(failures ? { failures } : {}) } })}\n`);
    process.exitCode = 1;
  });
}
