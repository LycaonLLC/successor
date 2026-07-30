import fs from "node:fs/promises";
import path from "node:path";

export const playerLoadReportSchema = "successor.player-load-report.v2";

export function buildPlayerLoadReport({ run, sourceHash, samples = [], phases = [] } = {}) {
  if (!run || run.schema !== playerLoadReportSchema) throw new Error("player load report requires a versioned run payload");
  if (typeof sourceHash !== "string" || !/^[a-f0-9]{64}$/u.test(sourceHash)) throw new Error("player load report requires a sha256 source hash");
  const report = {
    ...run,
    sourceHash,
    schema: playerLoadReportSchema,
    phases: phases.map((phase) => ({ ...phase })),
    samples: samples.map((sample) => ({ ...sample })),
  };
  validatePlayerLoadReport(report);
  return { ...report, analysis: analyzePlayerLoadReport(report) };
}

export function validatePlayerLoadReport(report) {
  if (!report || report.schema !== playerLoadReportSchema) throw new Error("player load report schema mismatch");
  if (typeof report.sourceHash !== "string" || !/^[a-f0-9]{64}$/u.test(report.sourceHash)) throw new Error("player load report requires a sha256 source hash");
  if (!Array.isArray(report.phases) || !Array.isArray(report.samples)) throw new Error("player load report requires phases and samples arrays");
  if (report.workload !== undefined) validateWorkload(report.workload);
  if (report.unsupportedWorkloads !== undefined) validateUnsupportedWorkloads(report.unsupportedWorkloads);
}

export function analyzePlayerLoadReport(report) {
  const samples = Array.isArray(report?.samples) ? report.samples : [];
  const rss = samples.map((sample) => sample?.process?.rssBytes).filter(Number.isFinite);
  const highWaterRss = samples.map((sample) => sample?.process?.highWaterRssBytes).filter(Number.isFinite);
  const cpuPercent = samples.map((sample) => sample?.process?.normalizedCpuPercent ?? sample?.process?.cpuPercent).filter(Number.isFinite);
  const threads = samples.map((sample) => sample?.process?.threads).filter(Number.isFinite);
  const fds = samples.map((sample) => sample?.process?.fileDescriptors).filter(Number.isFinite);
  const lag = samples.map((sample) => sample?.eventLoopLagMs).filter(Number.isFinite);
  const ticks = samples.map((sample) => sample?.status?.tick).filter(Number.isFinite);
  const serverLagP95 = samples.map((sample) => sample?.status?.instrumentation?.eventLoopLag?.p95Ms).filter(Number.isFinite);
  const queueDepth = samples.map((sample) => sample?.status?.instrumentation?.delivery?.queueDepth).filter(Number.isFinite);
  const bridgeBacklog = samples.map((sample) => sample?.status?.instrumentation?.bridge?.backlogSize).filter(Number.isFinite);
  const sessions = samples.map((sample) => sample?.status?.instrumentation?.sessions?.active).filter(Number.isFinite);
  const receipts = samples.map((sample) => sample?.status?.instrumentation?.commands?.receipts).filter(Number.isFinite);
  const rssSummary = summary(rss);
  const queueSummary = summary(queueDepth);
  const sampleAccounting = {
    collected: report?.sampleAccounting?.collected ?? samples.length,
    retained: report?.sampleAccounting?.retained ?? samples.length,
    dropped: report?.sampleAccounting?.dropped ?? 0,
    retentionCap: report?.sampleAccounting?.retentionCap ?? null,
  };
  return {
    sampleCount: samples.length,
    sampleAccounting,
    phaseAnalysis: phaseAnalysis(samples, report?.phases ?? []),
    signals: {
      errors: Array.isArray(report?.errors) ? report.errors.length : 0,
      disconnects: Array.isArray(report?.disconnects) ? report.disconnects.length : 0,
      teardownClean: report?.teardown?.clean === true,
      ...(report?.workload ? {
        workload: {
          attempted: report.workload.attempted,
          accepted: report.workload.accepted,
          rejected: report.workload.rejected,
          errorRate: report.workload.rejected / Math.max(1, report.workload.attempted),
          rejectionReasons: { ...report.workload.rejectionReasons },
          ...(report.workload.completed !== undefined ? { completed: report.workload.completed } : {}),
          ...(report.workload.errors !== undefined ? { errors: report.workload.errors } : {}),
          ...(report.workload.classes ? { classes: summarizeClasses(report.workload.classes) } : {}),
        },
      } : {}),
      ...(report?.unsupportedWorkloads ? { unsupportedWorkloads: { ...report.unsupportedWorkloads } } : {}),
    },
  };
}

function phaseAnalysis(samples, phases) {
  const groups = new Map();
  for (const sample of samples) {
    const phase = sample?.labels?.phase ?? sample?.labels?.action ?? "unlabelled";
    const list = groups.get(phase) ?? [];
    list.push(sample);
    groups.set(phase, list);
  }
  const planned = phases.reduce((totals, phase) => {
    if (Number.isFinite(phase?.warmupMs)) totals.warmup = (totals.warmup ?? 0) + phase.warmupMs;
    if (Number.isFinite(phase?.steadyMs)) totals.steady = (totals.steady ?? 0) + phase.steadyMs;
    if (Number.isFinite(phase?.drainMs)) totals.drain = (totals.drain ?? 0) + phase.drainMs;
    return totals;
  }, {});
  return Object.fromEntries([...groups.entries()].map(([phase, values]) => {
    const durationMs = planned[phase] ?? measuredDuration(values);
    return [phase, {
      sampleCount: values.length,
      durationMs,
      gauges: {
        rssBytes: summary(values.map((s) => s?.process?.rssBytes).filter(Number.isFinite)),
        normalizedCpuPercent: summary(values.map((s) => s?.process?.normalizedCpuPercent ?? s?.process?.cpuPercent).filter(Number.isFinite)),
        eventLoopLagMs: summary(values.map((s) => s?.eventLoopLagMs).filter(Number.isFinite)),
        queueDepth: summary(values.map((s) => s?.status?.instrumentation?.delivery?.queueDepth).filter(Number.isFinite)),
      },
      counterRates: mergeCounterRates(values, durationMs),
    }];
  }));
}

function measuredDuration(values) {
  if (values.length < 2) return 0;
  const elapsed = values.map((sample) => sample?.elapsedMs).filter(Number.isFinite);
  return elapsed.length < 2 ? 0 : Math.max(0, elapsed.at(-1) - elapsed[0]);
}

function mergeCounterRates(values, durationMs) {
  if (!Number.isFinite(durationMs) || durationMs <= 0) return null;
  const totals = {};
  for (const sample of values) addTree(totals, sample?.status?.counterDeltas ?? {}, 1);
  return scaleTree(totals, 1000 / durationMs);
}


function addTree(target, value, factor) {
  if (!value || typeof value !== "object") return;
  for (const [key, item] of Object.entries(value)) {
    if (Number.isFinite(item)) target[key] = (target[key] ?? 0) + item * factor;
    else {
      target[key] ??= {};
      addTree(target[key], item, factor);
    }
  }
}

function scaleTree(value, factor) {
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, Number.isFinite(item) ? round(item * factor) : scaleTree(item, factor)]));
}

export async function writePlayerLoadReport({ outDir, report, minFreeBytes = 0, statfsFn = fs.statfs } = {}) {
  if (!outDir) throw new Error("player load report requires outDir");
  if (report?.schema !== playerLoadReportSchema) throw new Error("player load report schema mismatch");
  const directory = path.resolve(outDir);
  await fs.mkdir(directory, { recursive: true });
  if (minFreeBytes > 0) {
    const stats = await statfsFn(directory);
    if (Number.isFinite(stats?.bavail) && Number.isFinite(stats?.bsize) && stats.bavail * stats.bsize < minFreeBytes) return null;
  }
  try {
    const target = path.join(directory, "successor.player-load-report.v2.json");
    const samplesPath = path.join(directory, "successor.player-load-samples.v2.jsonl");
    const summaryPath = path.join(directory, "successor.player-load-summary.v2.json");
    await writeAtomic(target, `${JSON.stringify(report, null, 2)}\n`);
    await writeAtomic(samplesPath, `${report.samples.map((sample) => JSON.stringify(sample)).join("\n")}${report.samples.length ? "\n" : ""}`);
    await writeAtomic(summaryPath, `${JSON.stringify(compactReport(report), null, 2)}\n`);
    return target;
  } catch (error) {
    if (error?.code === "ENOSPC" || error?.code === "EDQUOT") return null;
    throw error;
  }
}

async function writeAtomic(target, content) {
  const temporary = `${target}.tmp-${process.pid}`;
  await fs.writeFile(temporary, content, "utf8");
  await fs.rename(temporary, target);
}

function compactReport(report) {
  const { samples: _samples, ...compact } = report;
  return compact;
}
function validateWorkload(workload) {
  if (!workload || !Number.isInteger(workload.attempted) || !Number.isInteger(workload.accepted) || !Number.isInteger(workload.rejected)
    || workload.attempted < 0 || workload.accepted < 0 || workload.rejected < 0
    || workload.accepted + workload.rejected > workload.attempted
    || !workload.rejectionReasons || typeof workload.rejectionReasons !== "object") {
    throw new Error("player load report workload accounting is invalid");
  }
  if (workload.completed !== undefined && (!Number.isInteger(workload.completed) || workload.completed < 0 || workload.completed > workload.attempted)) {
    throw new Error("player load report workload completion accounting is invalid");
  }
  if (workload.errors !== undefined && (!Number.isInteger(workload.errors) || workload.errors < 0 || workload.errors > workload.attempted)) {
    throw new Error("player load report workload error accounting is invalid");
  }
  if (workload.classes !== undefined) {
    for (const [name, item] of Object.entries(workload.classes)) {
      if (!item || !Number.isInteger(item.intended) || !Number.isInteger(item.attempted) || !Number.isInteger(item.completed)
        || !Number.isInteger(item.accepted) || !Number.isInteger(item.rejected) || !Number.isInteger(item.errors)
        || item.intended < 0 || item.attempted < 0 || item.completed < 0 || item.accepted < 0 || item.rejected < 0 || item.errors < 0
        || item.attempted > item.intended || item.completed + item.errors > item.attempted
        || !item.latencyMs || !item.rejectionReasons || !item.errorReasons) {
        throw new Error(`player load report workload class accounting is invalid: ${name}`);
      }
    }
  }
}

function validateUnsupportedWorkloads(value) {
  if (!value || typeof value !== "object" || Object.values(value).some((reason) => typeof reason !== "string" || reason.length === 0)) {
    throw new Error("player load report unsupported workload declaration is invalid");
  }
}

function summarizeClasses(classes) {
  return Object.fromEntries(Object.entries(classes).map(([name, item]) => [name, {
    intended: item.intended,
    attempted: item.attempted,
    completed: item.completed,
    accepted: item.accepted,
    rejected: item.rejected,
    errors: item.errors,
    latencyMs: item.latencyMs,
  }]));
}

function summary(values) {
  if (values.length === 0) return { min: null, p50: null, p95: null, p99: null, max: null, first: null, last: null };
  const ordered = [...values].sort((left, right) => left - right);
  const percentile = (fraction) => ordered[Math.min(ordered.length - 1, Math.max(0, Math.ceil(ordered.length * fraction) - 1))];
  return { min: ordered[0], p50: percentile(0.5), p95: percentile(0.95), p99: percentile(0.99), max: ordered.at(-1), first: values[0], last: values.at(-1) };
}

function stageDeltas(samples) {
  const grouped = new Map();
  for (const sample of samples) {
    const stage = sample?.labels?.stage ?? "unlabelled";
    const bucket = grouped.get(stage) ?? [];
    bucket.push(sample);
    grouped.set(stage, bucket);
  }
  return Object.fromEntries([...grouped.entries()].map(([stage, values]) => {
    const metric = (selector) => {
      const series = values.map(selector).filter(Number.isFinite);
      const first = series[0] ?? null;
      const last = series.at(-1) ?? null;
      const max = series.length ? Math.max(...series) : null;
      return { first, last, max, delta: first !== null && last !== null ? last - first : null };
    };
    return [stage, {
      sampleCount: values.length,
      actions: [...new Set(values.map((sample) => sample?.labels?.action).filter(Boolean))],
      cpuPercent: metric((sample) => sample?.process?.normalizedCpuPercent ?? sample?.process?.cpuPercent),
      rssBytes: metric((sample) => sample?.process?.rssBytes),
      highWaterRssBytes: metric((sample) => sample?.process?.highWaterRssBytes),
      threads: metric((sample) => sample?.process?.threads),
      fileDescriptors: metric((sample) => sample?.process?.fileDescriptors),
      tick: metric((sample) => sample?.status?.tick),
    }];
  }));
}

function growthCosts({ cpu, rss, serverLag, queue, bridge, receipts, clients }) {
  const divisor = Math.max(1, clients);
  return {
    cpuUsageNSec: cost(cpu, divisor),
    rssBytes: cost(rss, divisor),
    serverEventLoopLagP95Ms: cost(serverLag, divisor),
    deliveryQueueDepth: cost(queue, divisor),
    bridgeBacklog: cost(bridge, divisor),
    receipts: cost(receipts, divisor),
  };
}

function cost(summaryValue, divisor) {
  if (summaryValue.first === null || summaryValue.max === null) return null;
  const delta = summaryValue.max - summaryValue.first;
  return { baseline: summaryValue.first, maximum: summaryValue.max, last: summaryValue.last, observedDelta: delta, sustainedDelta: summaryValue.last - summaryValue.first, perAddedClient: delta / divisor, relativeGrowth: delta / Math.max(1, Math.abs(summaryValue.first)) };
}

function highestGrowthCost(costs) {
  if (!costs) return null;
  const candidates = Object.entries(costs).filter(([metric, value]) => metric !== "receipts" && value && value.observedDelta > 0);
  if (candidates.length === 0) return null;
  const [metric, value] = candidates.sort(([, left], [, right]) => right.relativeGrowth - left.relativeGrowth)[0];
  return { metric, perAddedClient: value.perAddedClient, observedDelta: value.observedDelta, relativeGrowth: value.relativeGrowth };
}

function bottlenecks(costs) {
  if (!costs) return [];
  return Object.entries(costs)
    .filter(([metric, value]) => metric !== "receipts" && value && value.sustainedDelta > 0)
    .sort(([, left], [, right]) => right.relativeGrowth - left.relativeGrowth)
    .map(([metric, value]) => ({ metric, reason: "measured sustained growth from first to final sample", observedDelta: value.observedDelta, sustainedDelta: value.sustainedDelta, perAddedClient: value.perAddedClient, relativeGrowth: value.relativeGrowth }));
}
function round(value) {
  return Math.round(value * 1000) / 1000;
}
