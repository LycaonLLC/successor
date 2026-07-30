import fsSync from "node:fs";
import os from "node:os";
import { performance } from "node:perf_hooks";

export function normalizeStatusSnapshot(status, { previous = null, elapsedMs = null } = {}) {
  const authority = status?.authority ?? {};
  const instrumentation = status?.instrumentation;
  const counters = numericTree(status?.counters);
  const counterDeltas = counterDeltaTree(counters, previous?.counters);
  const measuredMs = Number.isFinite(elapsedMs) && elapsedMs > 0 ? elapsedMs : null;
  return {
    tick: finite(status?.tick),
    sessions: { active: finite(status?.sessionCount) ?? 0 },
    actors: finite(status?.actorCount) ?? 0,
    counters,
    ...(Object.keys(counterDeltas).length > 0 ? {
      counterDeltas,
      counterRates: measuredMs === null ? {} : scaleTree(counterDeltas, 1000 / measuredMs),
      counterMeasuredMs: measuredMs,
    } : {}),
    ...(Array.isArray(status?.recentRejections) ? { recentRejections: status.recentRejections.slice(-32) } : {}),
    authority: {
      metrics: authority.metrics ?? null,
      bridge: authority.bridge ?? null,
      tickTiming: authority.tickTiming ?? null,
      cadence: authority.cadence ?? null,
    },
    ...(status?.instrumentation === undefined ? {} : { instrumentation: normalizeInstrumentation(instrumentation) }),
    source: status?.source ? { stateHash: stringOrNull(status.source.stateHash), sliceHash: stringOrNull(status.source.sliceHash) } : null,
  };
}

function counterDeltaTree(current, previous) {
  if (!current || typeof current !== "object") return {};
  return Object.fromEntries(Object.entries(current).flatMap(([key, value]) => {
    const prior = previous && typeof previous === "object" ? previous[key] : null;
    if (Number.isFinite(value)) {
      const delta = Number.isFinite(prior) ? value - prior : null;
      return delta === null ? [] : [[key, delta]];
    }
    const nested = counterDeltaTree(value, prior);
    return Object.keys(nested).length > 0 ? [[key, nested]] : [];
  }));
}

function scaleTree(value, factor) {
  if (!value || typeof value !== "object") return {};
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key,
    Number.isFinite(item) ? round(item * factor) : scaleTree(item, factor),
  ]));
}

export function createMetricsPoller({
  gameUrl,
  processHost,
  handle,
  intervalMs = 250,
  retentionCap = 2_000,
  fetchStatus = defaultFetchStatus,
  now = () => performance.now(),
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  host = readHostIdentity(),
} = {}) {
  if (!gameUrl) throw new Error("metrics poller requires gameUrl");
  const cap = positiveInteger(retentionCap, "retentionCap", 1, 1_000_000);
  const samples = [];
  const errors = [];
  let collectedSampleCount = 0;
  let droppedSampleCount = 0;
  let previousProcess = null;
  let previousCpuUsageNSec = null;
  let previousObservedAt = null;
  let labels = { stage: null, action: null, phase: null };
  let timer = null;
  let inFlight = null;
  let expectedAt = null;
  let lifecycle = "idle";
  let stopPromise = null;

  function beginSample({ allowStopping = false } = {}) {
    if (inFlight) return inFlight;
    if (lifecycle === "stopped" || (lifecycle === "stopping" && !allowStopping)) return null;

    const started = now();
    const scheduled = expectedAt ?? started;
    expectedAt = scheduled + intervalMs;
    let task;
    task = Promise.resolve().then(async () => {
      try {
        const [status, process] = await Promise.all([
          fetchStatus(`${gameUrl.replace(/\/$/u, "")}/game/status`),
          processHost && handle ? processHost.inspect(handle).catch(() => null) : Promise.resolve(null),
        ]);
        const observedAt = now();
        const normalizedProcess = normalizeProcess(process, { ...previousProcess, cpuUsageNSec: previousCpuUsageNSec }, previousObservedAt === null ? null : observedAt - previousObservedAt, host);
        previousCpuUsageNSec = finite(process?.cpuUsageNSec);
        const previousStatus = samples.at(-1)?.status ?? null;
        const elapsedSincePrevious = previousObservedAt === null ? null : observedAt - previousObservedAt;
        const entry = {
          timestamp: new Date().toISOString(),
          elapsedMs: round(observedAt - started),
          measuredMs: elapsedSincePrevious === null ? null : round(elapsedSincePrevious),
          eventLoopLagMs: round(Math.max(0, started - scheduled)),
          host,
          labels: { ...labels },
          status: normalizeStatusSnapshot(status, { previous: previousStatus, elapsedMs: elapsedSincePrevious }),
          process: normalizedProcess,
        };
        previousProcess = normalizedProcess;
        previousObservedAt = observedAt;
        collectedSampleCount += 1;
        if (samples.length >= cap) {
          samples.shift();
          droppedSampleCount += 1;
        }
        samples.push(entry);
        return entry;
      } catch (error) {
        recordSamplingError(errors, error);
        throw error;
      } finally {
        if (inFlight === task) inFlight = null;
      }
    });
    inFlight = task;
    return task;
  }

  function sample() {
    return beginSample();
  }

  function scheduleSample() {
    const task = beginSample();
    if (task) void task.catch(() => {});
  }

  function start() {
    if (lifecycle !== "idle") return;
    lifecycle = "running";
    expectedAt = now();
    scheduleSample();
    timer = setIntervalFn(scheduleSample, intervalMs);
    timer?.unref?.();
  }

  function stop() {
    if (stopPromise) return stopPromise;
    lifecycle = "stopping";
    clearIntervalFn(timer);
    timer = null;
    stopPromise = (async () => {
      await settle(inFlight);
      if (errors.length === 0) await settle(beginSample({ allowStopping: true }));
      lifecycle = "stopped";
      throwSamplingErrors(errors);
    })();
    return stopPromise;
  }
  function summary() {
    return { ...summarize(samples), collectedSampleCount, droppedSampleCount, retentionCap: cap, host };
  }

  function setLabels(next = {}) {
    labels = {
      stage: next.stage === undefined ? labels.stage : stringOrNull(next.stage),
      action: next.action === undefined ? labels.action : stringOrNull(next.action),
      phase: next.phase === undefined ? labels.phase : stringOrNull(next.phase),
    };
  }

  function state() {
    return { lifecycle, inFlight: inFlight !== null, scheduled: timer !== null, samplingErrors: errors.length, collectedSampleCount, droppedSampleCount, retentionCap: cap };
  }

  return { start, stop, sample, setLabels, samples, errors, summary, state };
}
export function readHostIdentity() {
  let cpuModel = null;
  if (process.platform === "linux") {
    try {
      const line = fsSync.readFileSync("/proc/cpuinfo", "utf8").split(/\r?\n/u).find((value) => /^model name\s*:/u.test(value));
      cpuModel = line ? line.slice(line.indexOf(":") + 1).trim() : null;
    } catch {
      cpuModel = null;
    }
  }
  return {
    cpuModel,
    cpuCores: Math.max(1, os.cpus().length),
    memoryBytes: Number.isSafeInteger(os.totalmem()) ? os.totalmem() : null,
    platform: process.platform,
    arch: process.arch,
  };
}

function positiveInteger(value, name, min, max) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) throw new Error(`${name} must be an integer between ${min} and ${max}`);
  return number;
}

function normalizeInstrumentation(value) {
  const instrumentation = record(value);
  const sessions = record(instrumentation.sessions);
  const commands = record(instrumentation.commands);
  const events = record(instrumentation.events);
  const rejections = record(instrumentation.rejections);
  const backpressure = record(instrumentation.backpressure);
  const delivery = record(instrumentation.delivery);
  const bridge = record(instrumentation.bridge);
  const eventLoopLag = record(instrumentation.eventLoopLag);
  return {
    sessions: { active: finite(sessions.active), joined: finite(sessions.joined), disconnected: finite(sessions.disconnected) },
    actors: numericTree(instrumentation.actors),
    events: numericTree(events),
    commands: { accepted: finite(commands.accepted), rejected: finite(commands.rejected), receipts: finite(commands.receipts), attempted: finite(commands.attempted) },
    rejections: numericTree(rejections),
    backpressure: numericTree(backpressure),
    delivery: {
      queueDepth: finite(delivery.queueDepth),
      pendingReceipts: finite(delivery.pendingReceipts),
      pendingEvents: finite(delivery.pendingEvents),
      pendingAbilityQueueEvents: finite(delivery.pendingAbilityQueueEvents),
      deferredDirtyActors: finite(delivery.deferredDirtyActors),
      deferredDirtyActorHighWater: finite(delivery.deferredDirtyActorHighWater),
      deferredDirtyActorOldestAgeTicks: finite(delivery.deferredDirtyActorOldestAgeTicks),
    },
    bridge: numericTree(bridge),
    eventLoopLag: {
      p50Ms: finite(eventLoopLag.p50Ms),
      p95Ms: finite(eventLoopLag.p95Ms),
      p99Ms: finite(eventLoopLag.p99Ms),
      maxMs: finite(eventLoopLag.maxMs),
      meanMs: finite(eventLoopLag.meanMs),
    },
  };
}

function normalizeProcess(process, previous, elapsedMs, host) {
  if (!process || typeof process !== "object") return null;
  const proc = process.proc ?? null;
  const cpuUsageNSec = finite(process.cpuUsageNSec);
  const previousCpu = finite(previous?.cpuUsageNSec);
  const deltaCpuNSec = cpuUsageNSec !== null && previousCpu !== null ? Math.max(0, cpuUsageNSec - previousCpu) : null;
  const wallNs = Number.isFinite(elapsedMs) && elapsedMs > 0 ? elapsedMs * 1e6 : null;
  const cpuPercent = deltaCpuNSec !== null && wallNs ? round((deltaCpuNSec / wallNs) * 100) : null;
  return {
    pid: finite(process.mainPid ?? process.pid ?? proc?.pid),
    cpuUsageNSec,
    deltaCpuNSec,
    cpuPercent,
    normalizedCpuPercent: cpuPercent === null ? null : round(cpuPercent / Math.max(1, host?.cpuCores ?? os.cpus().length)),
    memoryCurrentBytes: finite(process.memoryCurrentBytes),
    rssBytes: finite(proc?.rssBytes ?? process.rssBytes),
    highWaterRssBytes: finite(proc?.highWaterRssBytes ?? process.highWaterRssBytes),
    threads: finite(proc?.threads ?? process.threads),
    fileDescriptors: finite(proc?.fileDescriptors ?? process.fileDescriptors),
    processGroup: Array.isArray(process.processGroup) ? process.processGroup.map((row) => ({
      pid: finite(row.pid), cpuUsageNSec: finite(row.cpuNSec ?? row.cpuUsageNSec), rssBytes: finite(row.rssBytes),
      highWaterRssBytes: finite(row.highWaterRssBytes), threads: finite(row.threads), fileDescriptors: finite(row.fileDescriptors),
    })) : null,
    state: stringOrNull(process.activeState ?? process.state),
  };
}

function summarize(samples) {
  const lag = samples.map((sample) => sample.eventLoopLagMs).filter(Number.isFinite);
  const rss = samples.map((sample) => sample.process?.rssBytes).filter(Number.isFinite);
  const highWater = samples.map((sample) => sample.process?.highWaterRssBytes).filter(Number.isFinite);
  const cpu = samples.map((sample) => sample.process?.normalizedCpuPercent).filter(Number.isFinite);
  const ticks = samples.map((sample) => sample.status?.tick).filter(Number.isFinite);
  return {
    sampleCount: samples.length,
    eventLoopLagMs: distribution(lag),
    rssBytes: distribution(rss),
    highWaterRssBytes: distribution(highWater),
    normalizedCpuPercent: distribution(cpu),
    tick: { first: ticks[0] ?? null, last: ticks.at(-1) ?? null, delta: ticks.length > 1 ? ticks.at(-1) - ticks[0] : null },
  };
}

function distribution(values) {
  if (values.length === 0) return { p50: null, p95: null, p99: null, max: null };
  const ordered = [...values].sort((a, b) => a - b);
  const at = (fraction) => ordered[Math.min(ordered.length - 1, Math.max(0, Math.ceil(ordered.length * fraction) - 1))];
  return { p50: round(at(0.5)), p95: round(at(0.95)), p99: round(at(0.99)), max: round(ordered.at(-1)) };
}

function numericTree(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).flatMap(([key, item]) => {
    if (Number.isFinite(item)) return [[key, item]];
    if (item && typeof item === "object" && !Array.isArray(item)) {
      const nested = numericTree(item);
      return Object.keys(nested).length ? [[key, nested]] : [];
    }
    return [];
  }));
}


async function defaultFetchStatus(url) {
  const response = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(4_000) });
  if (!response.ok) throw new Error(`metrics status HTTP ${response.status}`);
  return response.json();
}

async function settle(task) {
  if (!task) return;
  try {
    await task;
  } catch {
    // Sampling failures are recorded by the task and propagated by stop().
  }
}

function recordSamplingError(errors, error) {
  if (errors.length >= 8) return;
  const message = error instanceof Error ? error.message : String(error);
  errors.push({ name: error instanceof Error ? error.name : "Error", message: message.slice(0, 512) });
}

function throwSamplingErrors(errors) {
  if (errors.length === 0) return;
  throw new AggregateError(errors.map(({ name, message }) => Object.assign(new Error(message), { name })), `metrics sampling failed (${errors.length})`);
}

function finite(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringOrNull(value) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function record(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function round(value) {
  return Math.round(value * 1000) / 1000;
}
