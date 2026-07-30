import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { attachIsolatedMetadata, mergePlayerGeneratorResults, parseCrossHostPlayerLoadArgs, reconcileAuthorityCounters, runCrossHostPlayerLoad, runIsolatedCrossHostPlayerLoad, summarizePcServerMetrics, validatePcServerMetrics, waitForGameStatus } from "./cross-host.mjs";
import { sha256Json } from "../farm/protocol.mjs";
import { createLocalSourceIdentity } from "../farm/source-hash.mjs";

const SOURCE_HASH = "a".repeat(64);
const ENDPOINT = "http://100.65.141.51:28093";

function generatorResult({ clients = 1, receipts = 3, sourceHash = SOURCE_HASH, generatorId = "mac", samples = [] } = {}) {
  const result = {
    schema: "successor.player-load-generator.v2",
    status: "pass",
    runId: "cross-host-smoke",
    sourceHash,
    generatorId,
    clients: { requested: clients, identityJoined: clients, joined: clients },
    commands: { attempted: receipts, queued: receipts, sent: receipts, receipts, accepted: receipts, rejected: 0 },
    latency: { joinMs: { count: clients, p50: 10, p95: 15, p99: 20 }, receiptMs: { count: receipts, p50: 5, p95: 8, p99: 12 } },
    throughput: { receiptsPerSecond: receipts },
    errors: [],
    disconnects: [],
    samples,
    teardown: { attempted: true, clean: true },
  };
  return { ...result, checksum: sha256Json(result) };
}

const sourceIdentity = async () => ({ sourceHash: SOURCE_HASH, manifest: { entries: [{ path: "fixture.txt" }] } });

function pcServerSamples({ rssBytes = 2_000, memoryCurrentBytes = 4_000, cpuUsageNSec = 600_000_000, eventLoopLagMs = 2, serverP95Ms = 7, serverMaxMs = 8 } = {}) {
  return [
    {
      timestamp: "2026-07-10T00:00:00.000Z",
      eventLoopLagMs: 1,
      process: { pid: 4242, rssBytes: 1_000, memoryCurrentBytes: 3_000, cpuUsageNSec: 100_000_000 },
      status: { instrumentation: { eventLoopLag: { p95Ms: 3, maxMs: 4 } } },
    },
    {
      timestamp: "2026-07-10T00:00:01.000Z",
      eventLoopLagMs,
      process: { pid: 4242, rssBytes, memoryCurrentBytes, cpuUsageNSec },
      status: { instrumentation: { eventLoopLag: { p95Ms: serverP95Ms, maxMs: serverMaxMs } } },
    },
  ];
}

async function runIsolatedFixture({ samples = pcServerSamples(), pollerStop = async () => {}, maxRssBytes, maxEventLoopLagMs, events = [] } = {}) {
  const host = {
    start: async () => { events.push("start:relay"); return { name: "relay" }; },
    stop: async (handle) => { events.push(`stop:${handle.name}`); return { ok: true }; },
    assertStopped: async (handle) => { events.push(`assert:${handle.name}`); return { ok: true }; },
  };
  let counterReads = 0;
  const currentSource = await createLocalSourceIdentity({ root: process.cwd(), includeManifest: true });
  const report = await runIsolatedCrossHostPlayerLoad({
    root: process.cwd(),
    relayAddress: "100.65.141.51",
    macHost: "macbook-codex",
    runId: "cross-host-smoke",
    startServer: async () => ({ gameUrl: "http://127.0.0.1:28120", processHost: host, handle: { name: "server" }, characterStorePath: "fixture/characters.json" }),
    sourceHash: currentSource.sourceHash,
    createSourceIdentity: async () => currentSource,
    macClients: 1,
    allocatePort: async () => 28121,
    waitForRelayStatus: async () => { events.push("ready:relay"); },
    createMetricsPoller: (options) => {
      events.push("create:poller");
      assert.deepEqual(options, { gameUrl: "http://127.0.0.1:28120", processHost: host, handle: { name: "server" }, intervalMs: 1_000 });
      return {
        samples,
        start() { events.push("start:poller"); },
        async stop() { events.push("stop:poller"); await pollerStop(); },
      };
    },
    remoteGenerator: async (request) => ({ result: generatorResult({ sourceHash: request.sourceHash }) }),
    readServerCounters: async () => counterReads++ === 0 ? { accepted: 0, rejected: 0, receipts: 0 } : { accepted: 3, rejected: 0, receipts: 3 },
    ...(maxRssBytes === undefined ? {} : { maxRssBytes }),
    ...(maxEventLoopLagMs === undefined ? {} : { maxEventLoopLagMs }),
  });
  return { report, events };
}

function assertPollerStoppedBeforeBothCleanups(events) {
  const stopped = events.indexOf("stop:poller");
  assert.ok(stopped >= 0, "metrics poller must stop");
  for (const name of ["relay", "server"]) {
    const stop = events.indexOf(`stop:${name}`);
    const assertion = events.indexOf(`assert:${name}`);
    assert.ok(stop > stopped, `metrics poller must stop before ${name} cleanup`);
    assert.ok(assertion > stop, `${name} must be asserted absent after stop`);
  }
}

describe("cross-host player load remote-only safety contract", () => {
  it("refuses a combined local and Mac population before source, server, or generator work begins", async () => {
    let touched = false;
    await assert.rejects(
      runCrossHostPlayerLoad({
        endpoint: ENDPOINT,
        macHost: "macbook-codex",
        runId: "cross-host-smoke",
        localClients: 1,
        macClients: 1,
        createSourceIdentity: async () => { touched = true; return sourceIdentity(); },
        remoteGenerator: async () => { touched = true; return generatorResult(); },
        readServerCounters: async () => { touched = true; return { accepted: 0, rejected: 0, receipts: 0 }; },
      }),
      (error) => error?.code === "COMBINED_LOCAL_MAC_UNSUPPORTED",
    );
    assert.equal(touched, false);
  });

  it("runs one request-bound Mac generator against the PC-owned server and reconciles exact authority deltas", async () => {
    const calls = [];
    const counters = [{ accepted: 7, rejected: 2, receipts: 9 }, { accepted: 10, rejected: 2, receipts: 12 }];
    const report = await runCrossHostPlayerLoad({
      root: "/fixture/root",
      endpoint: ENDPOINT,
      macHost: "macbook-codex",
      runId: "cross-host-smoke",
      localClients: 0,
      macClients: 1,
      sourceHash: SOURCE_HASH,
      createSourceIdentity: sourceIdentity,
      readServerCounters: async (endpoint) => { calls.push(["counters", endpoint]); return counters.shift(); },
      remoteGenerator: async (request) => {
        calls.push(["generator", request]);
        assert.equal(request.generatorId, "mac");
        assert.equal(request.identityNamespace, "mac");
        assert.equal(request.clients, 1);
        assert.equal(request.expectedServerActiveSessions, 1);
        assert.equal(request.endpoint, ENDPOINT);
        return { result: generatorResult({ clients: 1, receipts: 3 }) };
      },
    });
    assert.equal(report.mode, "remote-only");
    assert.deepEqual(report.aggregate.clients, { requested: 1, identityJoined: 1, joined: 1 });
    assert.deepEqual(report.aggregate.commands, { attempted: 3, queued: 3, sent: 3, receipts: 3, accepted: 3, rejected: 0 });
    assert.deepEqual(report.aggregate.centralCounters.delta, { accepted: 3, rejected: 0, receipts: 3 });
    assert.deepEqual(report.aggregate.throughput, { aggregation: "by-generator-window-only", byGenerator: { mac: { receiptsPerSecond: 3 } } });
    assert.equal(calls.filter(([kind]) => kind === "generator").length, 1);
  });

  it("rejects malformed client accounting and mismatched authoritative server deltas", async () => {
    const result = generatorResult({ receipts: 3 });
    assert.throws(
      () => reconcileAuthorityCounters({ result: { ...result, commands: { ...result.commands, queued: 2 } }, baseline: { accepted: 0, rejected: 0, receipts: 0 }, final: { accepted: 3, rejected: 0, receipts: 3 } }),
      (error) => error?.code === "GENERATOR_COMMAND_ACCOUNTING_INVALID",
    );
    let counterReads = 0;
    await assert.rejects(
      runCrossHostPlayerLoad({
        root: "/fixture/root", endpoint: ENDPOINT, macHost: "macbook-codex", runId: "cross-host-smoke", sourceHash: SOURCE_HASH, macClients: 1,
        createSourceIdentity: sourceIdentity,
        remoteGenerator: async () => ({ result }),
        readServerCounters: async () => counterReads++ === 0 ? { accepted: 0, rejected: 0, receipts: 0 } : { accepted: 3, rejected: 0, receipts: 4 },
      }),
      (error) => error?.code === "AUTHORITY_COUNTER_RECONCILIATION_FAILED",
    );
  });

  it("removes its parent abort listener after a normal remote-only run", async () => {
    let added = 0;
    let removed = 0;
    const signal = {
      aborted: false,
      reason: undefined,
      addEventListener() { added += 1; },
      removeEventListener() { removed += 1; },
    };
    let counterReads = 0;
    await runCrossHostPlayerLoad({
      root: "/fixture/root", endpoint: ENDPOINT, macHost: "macbook-codex", runId: "cross-host-smoke", sourceHash: SOURCE_HASH, macClients: 1,
      createSourceIdentity: sourceIdentity,
      signal,
      remoteGenerator: async () => ({ result: generatorResult() }),
      readServerCounters: async () => counterReads++ === 0 ? { accepted: 0, rejected: 0, receipts: 0 } : { accepted: 3, rejected: 0, receipts: 3 },
    });
    assert.equal(added, 1);
    assert.equal(removed, 1);
  });

  it("retains distinct remote transport samples without importing or summing remote process snapshots", () => {
    const macSamples = [{ timestamp: "remote-mac", process: { rssBytes: 1_000 } }];
    const pcSamples = [{ timestamp: "remote-pc", process: { rssBytes: 9_000 } }];
    const slow = generatorResult({ receipts: 4, samples: macSamples });
    const fast = generatorResult({ receipts: 20, generatorId: "pc", samples: pcSamples });
    const report = mergePlayerGeneratorResults({ runId: "cross-host-smoke", sourceHash: SOURCE_HASH, endpoint: ENDPOINT, generators: [slow, fast] });
    assert.equal(report.aggregate.throughput.aggregation, "by-generator-window-only");
    assert.equal("receiptsPerSecond" in report.aggregate.throughput, false);
    assert.deepEqual(report.aggregate.transportStatus, {
      aggregation: "remote-transport-status-only-not-process-metrics",
      byGenerator: {
        mac: [{ timestamp: "remote-mac", evidenceKind: "remote-transport-status" }],
        pc: [{ timestamp: "remote-pc", evidenceKind: "remote-transport-status" }],
      },
    });
    assert.equal("serverMetrics" in report.aggregate, false);
  });

  it("signs valid PC-owned leader and process-group metrics from two consistent ProcessHost samples before cleanup", async () => {
    const { report, events } = await runIsolatedFixture({ maxRssBytes: 4_000 });
    assert.deepEqual(report.isolated.pcServerMetrics, {
      sampleCount: 2,
      pid: { values: [4242], consistent: true },
      leaderRssBytes: { first: 1_000, last: 2_000, max: 2_000 },
      groupMemoryCurrentBytes: { first: 3_000, last: 4_000, max: 4_000 },
      cpu: { firstUsageNSec: 100_000_000, lastUsageNSec: 600_000_000, deltaNSec: 500_000_000, observedIntervalMs: 1_000, averageCores: 0.5 },
      maxControllerEventLoopLagMs: 2,
      serverEventLoopLagMs: { p95Ms: 7, maxMs: 8 },
      processMetricsAvailable: true,
      samples: pcServerSamples(),
    });
    assert.ok(events.indexOf("start:poller") < events.indexOf("start:relay"), "poller must start before relay launch");
    assertPollerStoppedBeforeBothCleanups(events);
    const { checksum, ...unsigned } = report;
    assert.equal(checksum, sha256Json(unsigned));
    const mutated = {
      ...unsigned,
      isolated: {
        ...unsigned.isolated,
        pcServerMetrics: {
          ...unsigned.isolated.pcServerMetrics,
          groupMemoryCurrentBytes: { ...unsigned.isolated.pcServerMetrics.groupMemoryCurrentBytes, max: 4_001 },
        },
      },
    };
    assert.notEqual(checksum, sha256Json(mutated), "a group-memory mutation must invalidate the signed report");
  });

  it("fails closed for one sample or unavailable PC group memory while still stopping and asserting relay and server", async () => {
    const missingGroupMemory = pcServerSamples().map((sample) => ({ ...sample, process: { ...sample.process, memoryCurrentBytes: null } }));
    assert.ok(missingGroupMemory.every((sample) => Number.isFinite(sample.process.rssBytes) && Number.isFinite(sample.process.cpuUsageNSec)), "fixture retains leader RSS and CPU while group memory is unavailable");
    for (const samples of [pcServerSamples().slice(0, 1), missingGroupMemory]) {
      const events = [];
      await assert.rejects(
        runIsolatedFixture({ samples, events }),
        (error) => error?.code === "PC_SERVER_PROCESS_METRICS_UNAVAILABLE",
      );
      assertPollerStoppedBeforeBothCleanups(events);
    }
  });

  it("rejects fail-closed ProcessHost inspections as PC performance evidence and still cleans up", async () => {
    const inspection = {
      activeState: "unknown",
      subState: "stale-pidfile",
      mainPid: 4242,
      memoryCurrentBytes: null,
      cpuUsageNSec: null,
      proc: null,
      error: "pidfile birth token mismatch for isolated server",
    };
    const samples = pcServerSamples().map((sample) => ({
      ...sample,
      inspection,
      process: {
        pid: inspection.mainPid,
        rssBytes: inspection.proc?.rssBytes ?? null,
        memoryCurrentBytes: inspection.memoryCurrentBytes,
        cpuUsageNSec: inspection.cpuUsageNSec,
        state: inspection.activeState,
      },
    }));
    const events = [];
    await assert.rejects(
      runIsolatedFixture({ samples, events }),
      (error) => error?.code === "PC_SERVER_PROCESS_METRICS_UNAVAILABLE",
    );
    assertPollerStoppedBeforeBothCleanups(events);
  });

  it("fails closed on PC metrics sampling rejection and still stops and asserts relay and server", async () => {
    const events = [];
    let stops = 0;
    await assert.rejects(
      runIsolatedFixture({
        events,
        pollerStop: async () => {
          if (stops++ === 0) throw new Error("fake sampling rejection");
        },
      }),
      (error) => error?.code === "PC_SERVER_METRICS_SAMPLING_FAILED",
    );
    assert.equal(events.filter((event) => event === "stop:poller").length, 2, "a failed first stop must be retried before cleanup");
    assertPollerStoppedBeforeBothCleanups(events);
  });

  it("enforces aggregate group memory rather than leader RSS and server event-loop thresholds before relay and server cleanup", async () => {
    const cases = [
      { samples: pcServerSamples({ rssBytes: 2_000, memoryCurrentBytes: 2_001 }), maxRssBytes: 2_000, expectedMetric: "groupMemoryCurrentBytes.max" },
      { samples: pcServerSamples({ eventLoopLagMs: 1, serverP95Ms: 9, serverMaxMs: 10 }), maxEventLoopLagMs: 8, expectedMetric: "serverEventLoopLagMs.p95Ms" },
    ];
    for (const { expectedMetric, ...options } of cases) {
      const events = [];
      await assert.rejects(
        runIsolatedFixture({ ...options, events }),
        (error) => error?.code === "PC_SERVER_METRICS_THRESHOLD_EXCEEDED" && error.details?.violations?.some((violation) => violation.metric === expectedMetric),
      );
      assertPollerStoppedBeforeBothCleanups(events);
    }
  });

  it("rejects an inconsistent PID in PC-owned process evidence", () => {
    const inconsistent = pcServerSamples();
    inconsistent[1] = { ...inconsistent[1], process: { ...inconsistent[1].process, pid: 4343 } };
    assert.throws(
      () => validatePcServerMetrics(summarizePcServerMetrics(inconsistent), { maxRssBytes: 10_000, maxEventLoopLagMs: 100 }),
      (error) => error?.code === "PC_SERVER_PROCESS_METRICS_UNAVAILABLE",
    );
  });
  it("bounds a blackholed readiness fetch at the advertised deadline", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (_url, { signal }) => await new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new Error("deadline aborted")), { once: true });
    });
    try {
      await assert.rejects(waitForGameStatus(ENDPOINT, 10), (error) => error?.code === "RELAY_UNREACHABLE");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("attempts server stop and death assertion even when relay teardown throws after readiness fails", async () => {
    const events = [];
    const host = {
      start: async () => ({ name: "relay" }),
      stop: async (handle) => { events.push(`stop:${handle.name}`); if (handle.name === "relay") throw new Error("relay stop failed"); return { ok: true }; },
      assertStopped: async (handle) => { events.push(`assert:${handle.name}`); if (handle.name === "relay") throw new Error("relay assert failed"); return { ok: true }; },
    };
    await assert.rejects(
      runIsolatedCrossHostPlayerLoad({
        root: process.cwd(), relayAddress: "100.65.141.51", macHost: "macbook-codex", runId: "cross-host-smoke",
        startServer: async () => ({ gameUrl: "http://127.0.0.1:28120", processHost: host, handle: { name: "server" }, characterStorePath: "fixture/characters.json" }),
        allocatePort: async () => 28121,
        waitForRelayStatus: async () => { throw new Error("readiness failed"); },
        createMetricsPoller: () => ({ samples: [], start() {}, async stop() {} }),
      }),
      (error) => error?.code === "ISOLATED_LOAD_TEARDOWN_FAILED" || error instanceof AggregateError,
    );
    assert.deepEqual(events.sort(), ["assert:relay", "assert:server", "stop:relay", "stop:server"]);
  });

  it("keeps isolated metadata in the signed remote-only report", () => {
    const base = mergePlayerGeneratorResults({ runId: "cross-host-smoke", sourceHash: SOURCE_HASH, endpoint: ENDPOINT, generators: [generatorResult()] });
    const report = attachIsolatedMetadata(base, { pcGameUrl: "http://127.0.0.1:28120", relayEndpoint: ENDPOINT, characterStorePath: "verification/.runs/fixture/characters.json" });
    const { checksum, ...unsigned } = report;
    assert.equal(checksum, sha256Json(unsigned));
    assert.equal(report.mode, "remote-only");
  });

  it("parses remote-only CLI defaults and rejects malformed binding", () => {
    assert.deepEqual(
      parseCrossHostPlayerLoadArgs(["--endpoint", ENDPOINT, "--mac-host", "macbook-codex", "--run-id", "cross-host-smoke"]),
      { endpoint: ENDPOINT, macHost: "macbook-codex", runId: "cross-host-smoke", localClients: 0, macClients: 5, durationMs: 5_000, rampIntervalMs: 500, sampleIntervalMs: 1_000 },
    );
    assert.throws(() => parseCrossHostPlayerLoadArgs(["--endpoint", ENDPOINT]), (error) => error?.code === "INVALID_LOAD_ARGUMENT");
  });
});
