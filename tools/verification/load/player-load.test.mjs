import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { describe, it } from "node:test";

import {
  awaitTransportDrain,
  canonicalLoadCharacterId,
  captureStableSourceIdentity,
  captureStableTreeSourceIdentity,
  createWorkloadAccounting,
  evaluateDeferredDirtyGrowth,
  latencySummary,
  parsePlayerLoadArgs,
  percentile,
  playerLoadReportSchema,
  prepareIsolatedArtifacts,
  summarizeWorkload,
  runOpenLoopWorkload,
  runPlayerLoad,
  runPlayerLoadGenerator,
  runBoundedProcess,
  startIsolatedServer,
  thresholdFailure,
  writeLoadCharacterStore,
} from "./player-load.mjs";
import { createMetricsPoller, normalizeStatusSnapshot } from "./metrics.mjs";
import { analyzePlayerLoadReport, buildPlayerLoadReport, validatePlayerLoadReport, writePlayerLoadReport } from "./report.mjs";
import { createTreeSourceIdentity } from "../farm/source-hash.mjs";

const sourceIdentity = Object.freeze({ sourceHash: "a".repeat(64) });
const sourceStatus = Object.freeze({
  shardId: "player-load-test",
  source: { stateHash: "state-test", sliceHash: "slice-test" },
});
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function withStatusServer(callback) {
  const server = http.createServer((request, response) => {
    if (request.url === "/game/status") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(sourceStatus));
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    return await callback(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

async function withRunDirectory(callback) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "successor-player-load-test-"));
  try {
    return await callback(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForFile(target, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      return await readFile(target, "utf8");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    await delay(10);
  }
  throw new Error(`timed out waiting for ${target}`);
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function groupAlive(pid) {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

async function assertFixtureGone({ leader, descendant }, label) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline && (groupAlive(leader) || pidAlive(descendant))) await delay(10);
  assert.equal(groupAlive(leader), false, `${label} owned group must be absent`);
  assert.equal(pidAlive(descendant), false, `${label} descendant must be absent`);
}

function forceFixtureCleanup(pids) {
  if (!pids) return;
  try { process.kill(-pids.leader, "SIGKILL"); } catch { /* already absent */ }
  try { process.kill(pids.descendant, "SIGKILL"); } catch { /* already absent */ }
}

async function withArtifactFixture(callback) {
  await withRunDirectory(async (root) => {
    const paths = {
      serverDist: path.join(root, "server", "dist", "index.js"),
      bridge: path.join(root, "target", "debug", "examples", "authority_bridge_server"),
      cli: path.join(root, "client", "dist", "headless", "cli.js"),
      slice: path.join(root, "client", "public", "successor-slice", "open-desert-slice.json"),
    };
    await Promise.all([
      mkdir(path.dirname(paths.serverDist), { recursive: true }),
      mkdir(path.dirname(paths.bridge), { recursive: true }),
      mkdir(path.dirname(paths.cli), { recursive: true }),
      mkdir(path.dirname(paths.slice), { recursive: true }),
      mkdir(path.join(root, "verification", ".runs", "fixture"), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(paths.serverDist, "server artifact", "utf8"),
      writeFile(paths.bridge, "bridge artifact", "utf8"),
      writeFile(paths.cli, "cli artifact", "utf8"),
      writeFile(paths.slice, "{}", "utf8"),
      writeFile(path.join(root, "fixture.txt"), "source fixture", "utf8"),
    ]);
    execFileSync("git", ["init", "--quiet"], { cwd: root });
    execFileSync("git", ["add", "."], { cwd: root });
    execFileSync("git", ["-c", "user.name=Successor Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "-m", "fixture"], { cwd: root });
    const source = await captureStableSourceIdentity({ root });
    await callback({ root, runDir: path.join(root, "verification", ".runs", "fixture"), paths, sourceHash: source.sourceHash });
  });
}

function createTestMetricsPoller(samples = [{
  timestamp: "2026-07-09T00:00:00.000Z",
  process: { pid: 4242, cpuPercent: 12.5, rssBytes: 64 * 1024 * 1024 },
  status: { sessions: { joined: 1, disconnected: 0 }, receipts: { total: 1 } },
}]) {
  let starts = 0;
  let stops = 0;
  return {
    samples,
    start() { starts += 1; },
    async stop() { stops += 1; },
    state() { return { starts, stops }; },
  };
}
function createArtifactDrainPoller(activeSessions) {
  const artifactSample = {
    status: {
      instrumentation: {
        sessions: { active: activeSessions },
        delivery: { queueDepth: 0, pendingReceipts: 0, pendingEvents: 0, pendingAbilityQueueEvents: 0, deferredDirtyActors: 0 },
        bridge: { cadencePending: 1, workloadLivePending: 0, workloadBacklogSize: 0, backlogSize: 1 },
      },
    },
  };
  const samples = [];
  return {
    samples,
    start() {},
    async stop() {},
    async sample() {
      samples.push(artifactSample);
      return artifactSample;
    },
  };
}

function createDriverFactory({ receiptDelayMs = 0, disconnectOnWorkload = false, disconnectOnWorkloadOnce = false, wrongReceiptKind = false, failReady = false, rejectedWorkloadClientIndexes = [] } = {}) {
  const created = [];
  const factory = (options) => {
    const clientIndex = created.length;
    const envelopes = [];
    let commandId = 0;
    const verbs = [];
    let closed = 0;
    const bot = {
      envelopes,
      send(frame) {
        if (frame.op === "verb") verbs.push(frame.line);
        if (frame.op === "verb") {
          commandId += 1;
          const kind = "SetMoveIntent";
          envelopes.push({ type: "event", event: "authority_queued", line: frame.line, data: { commandId, commandKind: kind } });
          const rejectedWorkload = rejectedWorkloadClientIndexes.includes(clientIndex) && commandId === 2;
          if (!((disconnectOnWorkload && commandId > 1) || (disconnectOnWorkloadOnce && commandId === 2))) {
            envelopes.push({
              type: "receipt",
              commandId,
              commandKind: wrongReceiptKind ? "OtherCommand" : kind,
              accepted: !rejectedWorkload,
              ...(rejectedWorkload ? { reasonCode: "ingress_budget_exhausted" } : {}),
              tick: commandId,
            });
          }
          return;
        }
        if (frame.op === "query") envelopes.push({ type: "query", verb: frame.verb.replace(/^\//u, ""), text: "WHERE open-desert 512,512" });
      },
      async waitFor(predicate, label) {
        const matching = envelopes.find(predicate);
        if (matching) {
          if (matching.type === "receipt" && receiptDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, receiptDelayMs));
          return matching;
        }
        if ((disconnectOnWorkload || disconnectOnWorkloadOnce) && /authority receipt/u.test(label)) throw new Error("driver disconnected before authority receipt");
        throw new Error(`test driver did not emit ${label}`);
      },
      async close() { closed += 1; },
      closed() { return closed; },
      verbs,
    };
    if (!failReady) envelopes.push({ type: "status", status: "ready", data: { endpoint: options.gameUrl, actorId: options.actorId, sessionId: `session-${options.actorId}` } });
    created.push({ options, bot });
    return bot;
  };
  return { factory, created };
}

function createInvalidCharacterIdDriver({ closeRejects = false } = {}) {
  const base = createDriverFactory({ failReady: true });
  return {
    created: base.created,
    factory(options) {
      const bot = base.factory(options);
      const waitLabels = [];
      bot.waitFor = async (_predicate, label) => {
        waitLabels.push(label);
        throw new Error(`invalid-characterId: ${options.characterId}`);
      };
      bot.readyWaitLabels = () => [...waitLabels];
      if (closeRejects) {
        let closeAttempts = 0;
        bot.close = async () => {
          closeAttempts += 1;
          throw new Error("controlled close failure");
        };
        bot.closeAttempts = () => closeAttempts;
      }
      return bot;
    },
  };
}

async function runAdopted(endpoint, input = {}) {
  const poller = input.poller ?? createTestMetricsPoller();
  const driver = input.driver ?? createDriverFactory();
  const result = await runPlayerLoad({
    adoptUrl: endpoint,
    clients: 3,
    stages: [1, 3],
    durationMs: 100,
    workloadMs: 100,
    sampleIntervalMs: 100,
    runId: "contract",
    outDir: input.outDir,
    sourceIdentity,
    createMetricsPoller: () => poller,
    startDriver: driver.factory,
    ...input,
  });
  return { result, poller, driver };
}

describe("successor.player-load-report.v1 options and latency math", () => {
  it("uses bounded, strictly increasing ramps and retains exact percentile boundaries without mutating evidence", () => {
    const values = [23, 3, 19, 7, 11];
    assert.equal(percentile(values, 0), 3);
    assert.equal(percentile(values, 0.5), 11);
    assert.equal(percentile(values, 0.95), 23);
    assert.equal(percentile(values, 0.99), 23);
    assert.equal(percentile(values, 1), 23);
    assert.deepEqual(values, [23, 3, 19, 7, 11]);
    assert.deepEqual(latencySummary(values), { count: 5, p50: 11, p95: 23, p99: 23, max: 23 });

    const parsed = parsePlayerLoadArgs(["--clients", "3", "--stages", "1,3", "--duration-ms", "100", "--workload-ms", "100"]);
    assert.equal(parsed.clients, 3);
    assert.deepEqual(parsed.stages, [1, 3]);
    assert.equal(parsed.durationMs, 100);
    assert.equal(parsed.workloadMs, 100);
    assert.equal(parsed.sampleIntervalMs, 250);
    assert.equal(parsed.joinTimeoutMs, 15000);
    assert.equal(parsed.receiptTimeoutMs, 8000);
    assert.equal(parsed.maxErrorRate, 0);
    assert.equal(parsed.maxDisconnects, 0);
    assert.equal(parsed.maxP95ReceiptMs, 5000);
    assert.equal(parsed.capacityBudgetsConfigured, false);
    assert.match(parsed.runId, /^load-/u);
    assert.equal(parsed.outDir, null);
    assert.equal(parsed.adoptUrl, null);
    assert.equal(parsed.port, null);
    assert.equal(parsed.processHostKind, null);
    assert.equal(parsed.allowLarge, false);
    assert.equal(parsed.generatorStdin, false);
    assert.match(parsed.slicePath, /open-desert-slice\.json$/u);
    assert.match(parsed.cliPath, /headless\/cli\.js$/u);
    assert.equal(parsed.expectedSourceHash, null);
    assert.equal(parsed.expectedServerActiveSessions, null);
    assert.equal(parsed.sourceIdentity, undefined);
    assert.equal(parsed.createMetricsPoller, undefined);
    assert.equal(parsed.startDriver, undefined);
    assert.equal(parsed.signal, undefined);
    assert.throws(() => parsePlayerLoadArgs(["--clients", "21"]), /allow-large/u);
    assert.throws(() => parsePlayerLoadArgs(["--clients", "3", "--stages", "2,1,3"]), /strictly increasing/u);
    assert.throws(() => parsePlayerLoadArgs(["--clients", "3", "--stages", "1,2"]), /ending at clients/u);
  });
});

function createOpenLoopTestBot({ responseDelayMs = 0, rejectMovement = false, queryError = false } = {}) {
  const envelopes = [];
  const sends = [];
  let commandId = 0;
  return {
    envelopes,
    sends,
    send(frame) {
      sends.push({ frame, at: Date.now() });
      if (frame.op === "verb") {
        commandId += 1;
        const id = commandId;
        envelopes.push({ type: "event", event: "authority_queued", line: frame.line, data: { commandId: id, commandKind: "SetMoveIntent" } });
        setTimeout(() => envelopes.push({
          type: "receipt",
          commandId: id,
          commandKind: "SetMoveIntent",
          accepted: !(rejectMovement && id === 1),
          ...(rejectMovement && id === 1 ? { reasonCode: "movement_rejected" } : {}),
        }), responseDelayMs);
      } else if (frame.op === "query" && !queryError) {
        setTimeout(() => envelopes.push({ type: "query", verb: "where", text: "WHERE open-desert 512,512" }), responseDelayMs);
      }
    },
    async waitFor(predicate, label, timeoutMs = 100) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const match = envelopes.find(predicate);
        if (match) return match;
        await delay(1);
      }
      throw new Error(`test driver response error for ${label}`);
    },
  };
}

describe("successor.player-load-report.v2 open-loop workload mix", () => {
  it("schedules the deterministic movement/query cycle independently of response latency", async () => {
    const bot = createOpenLoopTestBot({ responseDelayMs: 35 });
    const accounting = createWorkloadAccounting("movement-query");
    const result = await runOpenLoopWorkload({
      clients: [{ id: "client-a", bot }, { id: "client-b", bot }],
      durationMs: 25,
      intervalMs: 10,
      accounting,
      receiptLatencies: [],
      errors: [],
      disconnects: [],
      commands: { attempted: 0, queued: 0, receipts: 0, accepted: 0, rejected: 0 },
    });
    assert.deepEqual(result.schedule.map((entry) => entry.class), [
      "movement", "movement", "movement", "query", "movement", "movement",
    ]);
    assert.equal(result.intendedSendCount, 6);
    assert.equal(result.attempted, 6);
    assert.equal(result.completed, 6);
    assert.equal(result.classes.movement.intended, 5);
    assert.equal(result.classes.query.intended, 1);
    assert.equal(bot.sends.length, 6);
    const sendTimes = bot.sends.map((send) => send.at);
    assert.ok(sendTimes.at(-1) - sendTimes[0] < 30, "slow responses must not serialize later sends");
  });

  it("keeps rejected receipts and query response errors in their own class accounting", async () => {
    const bot = createOpenLoopTestBot({ rejectMovement: true, queryError: true });
    const errors = [];
    const accounting = createWorkloadAccounting("movement-query");
    const result = await runOpenLoopWorkload({
      clients: [{ id: "client-a", bot }],
      durationMs: 40,
      intervalMs: 10,
      accounting,
      responseTimeoutMs: 20,
      receiptLatencies: [],
      errors,
      disconnects: [],
      commands: { attempted: 0, queued: 0, receipts: 0, accepted: 0, rejected: 0 },
    });
    assert.equal(result.classes.movement.rejected, 1);
    assert.equal(result.classes.movement.completed, 3);
    assert.equal(result.classes.query.errors, 1);
    assert.equal(result.classes.query.completed, 0);
    assert.equal(result.errors, 1);
    assert.equal(errors.length, 1);
  });

  it("does not emit the legacy top-level commands block for mixed v2 reports", async () => {
    await withStatusServer((endpoint) => withRunDirectory(async (outDir) => {
      const { result } = await runAdopted(endpoint, {
        outDir,
        clients: 1,
        stages: [1],
        mode: "open-loop",
        steadyMs: 100,
        durationMs: 100,
        workloadMs: 100,
      });
      assert.equal("commands" in result.report, false);
      assert.ok(result.report.workload.classes);
      assert.equal(result.report.throughput.receiptCount, undefined);
    }));
  });
  it("aggregates exact latency percentiles across unequal phase populations", () => {
    const phaseA = { workload: { classes: { movement: { attempted: 5, completed: 5, accepted: 5, latencyMs: { count: 5, p50: 3, p95: 5, p99: 5, max: 5 }, query: {} } } } };
    const phaseB = { workload: { classes: { movement: { attempted: 1, completed: 1, accepted: 1, latencyMs: { count: 1, p50: 100, p95: 100, p99: 100, max: 100 }, query: {} } } } };
    for (const [phase, values] of [[phaseA, [1, 2, 3, 4, 5]], [phaseB, [100]]]) {
      const item = phase.workload.classes.movement;
      Object.defineProperty(item, "__latencies", { value: values, enumerable: false });
    }
    const summary = summarizeWorkload([phaseA, phaseB]).classes.movement.latencyMs;
    assert.equal(summary.count, 6);
    assert.deepEqual(summary, { ...latencySummary([1, 2, 3, 4, 5, 100]), count: 6 });
  });
});

describe("successor.player-load-report.v1 metrics sampling", () => {
  it("normalizes authoritative counters and samples owned process CPU/RSS with monotonic event-loop lag", async () => {
    const status = {
      tick: 42,
      sessionCount: 3,
      actorCount: 5,
      counters: { sessionsJoined: 3, receiptsDelivered: 9 },
      authority: {
        metrics: { sessionsJoined: 3, receiptsDelivered: 9, deliveryQueueDepth: 2 },
        bridge: { pending: 1, backlog: 2, livePending: 3 },
        tickTiming: { p95Ms: 4 },
      },
      source: { stateHash: "state-test", sliceHash: "slice-test" },
    };
    assert.deepEqual(normalizeStatusSnapshot(status), {
      tick: 42,
      sessions: { active: 3 },
      actors: 5,
      counters: { sessionsJoined: 3, receiptsDelivered: 9 },
      authority: {
        metrics: { sessionsJoined: 3, receiptsDelivered: 9, deliveryQueueDepth: 2 },
        bridge: { pending: 1, backlog: 2, livePending: 3 },
        tickTiming: { p95Ms: 4 },
        cadence: null,
      },
      source: { stateHash: "state-test", sliceHash: "slice-test" },
    });

    const nowValues = [10, 20, 50, 55];
    const poller = createMetricsPoller({
      gameUrl: "http://load.test",
      intervalMs: 10,
      now: () => nowValues.shift(),
      fetchStatus: async (url) => {
        assert.equal(url, "http://load.test/game/status");
        return status;
      },
      processHost: {
        inspect: async () => ({ mainPid: 4242, cpuUsageNSec: 1234, memoryCurrentBytes: 8192, proc: { rssBytes: 4096 }, activeState: "active" }),
      },
      handle: { name: "owned-load-server" },
    });
    const first = await poller.sample();
    const second = await poller.sample();
    assert.deepEqual(first.process, {
      pid: 4242,
      cpuUsageNSec: 1234,
      deltaCpuNSec: null,
      cpuPercent: null,
      normalizedCpuPercent: null,
      memoryCurrentBytes: 8192,
      rssBytes: 4096,
      highWaterRssBytes: null,
      threads: null,
      fileDescriptors: null,
      processGroup: null,
      state: "active",
    });
    assert.equal(first.elapsedMs, 10);
    assert.equal(first.eventLoopLagMs, 0);
    assert.equal(second.eventLoopLagMs, 30);
    const sum = poller.summary();
    assert.equal(sum.sampleCount, 2);
    assert.equal(sum.eventLoopLagMs.max, 30);
    assert.equal(sum.rssBytes.max, 4096);
  });
  it("preserves cadence and workload bridge classification in one status poll", async () => {
    let requests = 0;
    const poller = createMetricsPoller({
      gameUrl: "http://load.test",
      fetchStatus: async (url) => {
        requests += 1;
        assert.equal(url, "http://load.test/game/status");
        return {
          tick: 860,
          sessionCount: 100,
          instrumentation: {
            sessions: { active: 100 },
            delivery: { queueDepth: 0, pendingReceipts: 0, pendingEvents: 0, pendingAbilityQueueEvents: 0 },
            bridge: { cadencePending: 1, workloadLivePending: 0, workloadBacklogSize: 0, backlogSize: 1 },
          },
        };
      },
    });

    const sample = await poller.sample();
    assert.equal(requests, 1);
    assert.deepEqual(sample.status.instrumentation.bridge, {
      cadencePending: 1,
      workloadLivePending: 0,
      workloadBacklogSize: 0,
      backlogSize: 1,
    });
  });

  it("awaits an active scheduled sample before one deterministic final sample, then terminally stops", async () => {
    const scheduled = [];
    const cleared = [];
    const first = deferred();
    const final = deferred();
    const finalStarted = deferred();
    const firstStarted = deferred();
    const requests = [];
    const poller = createMetricsPoller({
      gameUrl: "http://load.test",
      intervalMs: 25,
      fetchStatus: () => {
        const request = requests.length === 0 ? first : final;
        requests.push(request);
        if (requests.length === 1) firstStarted.resolve();
        if (requests.length === 2) finalStarted.resolve();
        return request.promise;
      },
      setIntervalFn: (callback, intervalMs) => {
        assert.equal(intervalMs, 25);
        scheduled.push(callback);
        return { interval: intervalMs };
      },
      clearIntervalFn: (timer) => cleared.push(timer),
    });

    poller.start();
    await firstStarted.promise;
    assert.equal(requests.length, 1);
    assert.equal(scheduled.length, 1);
    const stopping = poller.stop();
    assert.strictEqual(poller.stop(), stopping);
    assert.deepEqual(cleared, [{ interval: 25 }]);

    first.resolve({ tick: 1 });
    await finalStarted.promise;
    let settled = false;
    void stopping.then(() => { settled = true; });
    await Promise.resolve();
    assert.equal(settled, false);
    scheduled[0]();
    assert.equal(requests.length, 2);

    final.resolve({ tick: 2 });
    await stopping;
    assert.deepEqual(poller.samples.map((sample) => sample.status.tick), [1, 2]);
    assert.equal(await poller.sample(), null);
    scheduled[0]();
    assert.equal(poller.samples.length, 2);
  });

  it("contains a rejected interval sample without an unhandled rejection and propagates one bounded stop error", async () => {
    const scheduled = [];
    const first = deferred();
    const rejected = deferred();
    const firstStarted = deferred();
    const rejectedStarted = deferred();
    const requests = [];
    const unhandled = [];
    const onUnhandled = (reason) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      const poller = createMetricsPoller({
        gameUrl: "http://load.test",
        fetchStatus: () => {
          const request = requests.length === 0 ? first : rejected;
          requests.push(request);
          if (requests.length === 1) firstStarted.resolve();
          if (requests.length === 2) rejectedStarted.resolve();
          return request.promise;
        },
        setIntervalFn: (callback) => {
          scheduled.push(callback);
          return callback;
        },
        clearIntervalFn: () => {},
      });

      poller.start();
      await firstStarted.promise;
      const initialSample = poller.sample();
      first.resolve({ tick: 1 });
      await initialSample;
      scheduled[0]();
      await rejectedStarted.promise;
      assert.equal(requests.length, 2);
      rejected.reject(new Error("metrics endpoint refused request"));
      await new Promise((resolve) => setImmediate(resolve));

      await assert.rejects(poller.stop(), (error) => {
        assert.ok(error instanceof AggregateError);
        assert.match(error.message, /metrics/i);
        return true;
      });
      assert.equal(unhandled.length, 0);
      assert.equal(poller.errors.length, 1);
      assert.equal(poller.samples.length, 1);
      assert.equal(await poller.sample(), null);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("bounds retained sampling failures and the final aggregate error", async () => {
    const poller = createMetricsPoller({
      gameUrl: "http://load.test",
      fetchStatus: () => {
        throw new Error("x".repeat(700));
      },
      clearIntervalFn: () => {},
    });

    for (let attempt = 0; attempt < 10; attempt += 1) {
      await assert.rejects(poller.sample());
    }
    assert.equal(poller.errors.length, 8);
    assert.ok(poller.errors.every((error) => error.name === "Error" && error.message.length === 512));
    await assert.rejects(poller.stop(), (error) => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.errors.length, 8);
      assert.match(error.message, /\(8\)/u);
      return true;
    });
  });
});

describe("successor.player-load-report.v1 stage and final transport drain", () => {
  it("accepts the final 100-player artifact shape when only the recurring cadence observation remains", async () => {
    const clock = { value: 0 };
    const artifactSample = {
      status: {
        instrumentation: {
          sessions: { active: 100 },
          commands: { accepted: 400, rejected: 0, receipts: 400 },
          delivery: { queueDepth: 0, pendingReceipts: 0, pendingEvents: 0, pendingAbilityQueueEvents: 0, deferredDirtyActors: 0 },
          bridge: { cadencePending: 1, workloadLivePending: 0, workloadBacklogSize: 0, backlogSize: 1 },
        },
      },
    };
    const result = await awaitTransportDrain({
      sample: async () => artifactSample,
      now: () => clock.value,
      sleep: async (ms) => { clock.value += ms; },
      intervalMs: 18,
      deadlineMs: 36,
      expectedActiveSessions: 100,
    });

    assert.deepEqual(artifactSample.status.instrumentation.commands, { accepted: 400, rejected: 0, receipts: 400 });
    assert.equal(result.ok, true);
    assert.equal(result.expectedActiveSessions, 100);
    assert.deepEqual(result.blockers, { sessionMismatch: false, payloadPending: false, workloadPending: false });
    assert.equal(result.elapsedMs, 0);
    assert.equal(result.samples.length, 1);
    assert.deepEqual(result.final, {
      activeSessions: 100,
      queueDepth: 0,
      pendingReceipts: 0,
      pendingEvents: 0,
      pendingAbilityQueueEvents: 0,
      deferredDirtyActors: 0,
      cadencePending: 1,
      workloadLivePending: 0,
      workloadBacklogSize: 0,
      backlogSize: 1,
    });
  });
  it("falls back to legacy total backlog when the workload backlog field is absent", async () => {
    const clock = { value: 0 };
    const legacyArtifactSample = {
      status: {
        instrumentation: {
          sessions: { active: 100, joined: 100, disconnected: 0 },
          commands: { accepted: 400, rejected: 0, receipts: 400 },
          delivery: { queueDepth: 0, pendingReceipts: 0, pendingEvents: 0, pendingAbilityQueueEvents: 0, deferredDirtyActors: 0, deferredDirtyActorHighWater: 704, deferredDirtyActorOldestAgeTicks: 0 },
          bridge: { diagnosticPending: 0, livePending: 1, cadencePending: 1, workloadLivePending: 0, commandBatchPending: 0, commandBatches: 0, commandBatchPendingItems: 0, backlogSize: 1 },
        },
      },
    };
    const result = await awaitTransportDrain({
      sample: async () => legacyArtifactSample,
      now: () => clock.value,
      sleep: async (ms) => { clock.value += ms; },
      intervalMs: 18,
      deadlineMs: 18,
      expectedActiveSessions: 100,
    });

    assert.equal(result.ok, false);
    assert.equal(result.reason, "drain_deadline");
    assert.equal(result.elapsedMs, 18);
    assert.equal(result.samples.length, 2);
    assert.equal("workloadBacklogSize" in result.final, false);
    assert.equal(result.final.backlogSize, 1);
  });

  it("fails an otherwise reconciled drain when a queued authority batch remains", async () => {
    const clock = { value: 0 };
    const blocked = await awaitTransportDrain({
      sample: async () => ({ status: { instrumentation: {
        sessions: { active: 100 },
        commands: { accepted: 400, rejected: 0, receipts: 400 },
        delivery: { queueDepth: 0, pendingReceipts: 0, pendingEvents: 0, pendingAbilityQueueEvents: 0, deferredDirtyActors: 0 },
        bridge: { cadencePending: 0, workloadLivePending: 0, workloadBacklogSize: 1, backlogSize: 1 },
      } } }),
      now: () => clock.value,
      sleep: async (ms) => { clock.value += ms; },
      intervalMs: 18,
      deadlineMs: 18,
      expectedActiveSessions: 100,
    });

    assert.equal(blocked.ok, false);
    assert.equal(blocked.reason, "drain_deadline");
    assert.equal(blocked.elapsedMs, 18);
    assert.equal(blocked.samples.length, 2);
    assert.equal(blocked.final.workloadBacklogSize, 1);
    assert.equal(blocked.final.backlogSize, 1);
  });

  it("does not turn a coalesced cadence poll and real authority request into a false green", async () => {
    const clock = { value: 0 };
    const blocked = await awaitTransportDrain({
      sample: async () => ({ status: { instrumentation: {
        sessions: { active: 100 },
        delivery: { queueDepth: 0, pendingReceipts: 0, pendingEvents: 0, pendingAbilityQueueEvents: 0, deferredDirtyActors: 0 },
        bridge: { cadencePending: 1, workloadLivePending: 1, workloadBacklogSize: 1, backlogSize: 2 },
      } } }),
      now: () => clock.value,
      sleep: async (ms) => { clock.value += ms; },
      intervalMs: 18,
      deadlineMs: 18,
      expectedActiveSessions: 100,
    });

    assert.equal(blocked.ok, false);
    assert.equal(blocked.reason, "drain_deadline");
    assert.equal(blocked.samples.length, 2);
    assert.deepEqual(blocked.final, {
      activeSessions: 100,
      queueDepth: 0,
      pendingReceipts: 0,
      pendingEvents: 0,
      pendingAbilityQueueEvents: 0,
      deferredDirtyActors: 0,
      cadencePending: 1,
      workloadLivePending: 1,
      workloadBacklogSize: 1,
      backlogSize: 2,
    });
  });

  it("keeps the post-disconnect active-session check separate from the stage drain", async () => {
    const stageClock = { value: 0 };
    const stageDrain = await awaitTransportDrain({
      sample: async () => ({ status: { instrumentation: {
        sessions: { active: 100 },
        delivery: { queueDepth: 0, pendingReceipts: 0, pendingEvents: 0, pendingAbilityQueueEvents: 0 },
        bridge: { cadencePending: 1, workloadLivePending: 0, workloadBacklogSize: 0, backlogSize: 1 },
      } } }),
      now: () => stageClock.value,
      sleep: async (ms) => { stageClock.value += ms; },
      intervalMs: 18,
      deadlineMs: 18,
      expectedActiveSessions: 100,
    });
    const finalClock = { value: 0 };
    const finalDrain = await awaitTransportDrain({
      sample: async () => ({ status: { instrumentation: {
        sessions: { active: 0 },
        delivery: { queueDepth: 0, pendingReceipts: 0, pendingEvents: 0, pendingAbilityQueueEvents: 0 },
        bridge: { cadencePending: 1, workloadLivePending: 0, workloadBacklogSize: 0, backlogSize: 1 },
      } } }),
      now: () => finalClock.value,
      sleep: async (ms) => { finalClock.value += ms; },
      intervalMs: 18,
      deadlineMs: 18,
      expectedActiveSessions: 0,
    });

    assert.equal(stageDrain.ok, true);
    assert.equal(finalDrain.ok, true);
    assert.equal(stageDrain.final.activeSessions, 100);
    assert.equal(finalDrain.final.activeSessions, 0);
  });
});

describe("successor.player-load-report.v1 deferred dirty actor growth", () => {
  it("reports transient count growth without failing when dirty actors are young", () => {
    const history = [];
    assert.equal(evaluateDeferredDirtyGrowth(history, 0, 4, 0).stop, false);
    assert.equal(evaluateDeferredDirtyGrowth(history, 8, 4, 1).stop, false);
    assert.equal(evaluateDeferredDirtyGrowth(history, 24, 4, 1).stop, false);
  });

  it("fails only after deferred dirty actors grow and remain aged across stages", () => {
    const history = [];
    assert.equal(evaluateDeferredDirtyGrowth(history, 1, 1, 2).stop, false);
    assert.equal(evaluateDeferredDirtyGrowth(history, 4, 2, 2).stop, false);
    const growth = evaluateDeferredDirtyGrowth(history, 9, 3, 3);
    assert.equal(growth.stop, true);
    assert.equal(growth.reason, "aged_deferred_dirty_growth");
    assert.deepEqual(growth.current, { activeClients: 3, deferredDirtyActors: 9, perClient: 3, oldestAgeTicks: 3 });
  });
});

describe("successor.player-load-report.v1 report validation mutation teeth", () => {
  it("rejects version and source-hash mutations while persisting the complete validated report atomically", async () => {
    const run = {
      schema: playerLoadReportSchema,
      status: "pass",
      runId: "mutation-contract",
      clients: {
        requested: 2,
        joined: 2,
        uniqueIdentityCount: 2,
        joinLatencyMs: { count: 2, p50: 3, p95: 5, p99: 5, max: 5 },
        receiptLatencyMs: { count: 2, p50: 2, p95: 4, p99: 4, max: 4 },
      },
      throughput: { receiptCount: 2, receiptsPerSecond: 1 },
      errors: [],
      disconnects: [],
      teardown: { clean: true },
    };
    const samples = [
      { eventLoopLagMs: 1, process: { rssBytes: 100 }, status: { tick: 7 } },
      { eventLoopLagMs: 3, process: { rssBytes: 140 }, status: { tick: 10 } },
    ];
    const report = buildPlayerLoadReport({ run, sourceHash: sourceIdentity.sourceHash, samples, phases: [{ targetClients: 2, addedClients: 2 }] });
    assert.equal(report.schema, playerLoadReportSchema);
    assert.equal(report.sourceHash, sourceIdentity.sourceHash);
    const analysis = report.analysis;
    assert.equal(analysis.sampleCount, 2);
    assert.deepEqual(analysis.phaseAnalysis.unlabelled.gauges.rssBytes, { min: 100, p50: 100, p95: 140, p99: 140, max: 140, first: 100, last: 140 });
    assert.deepEqual(analysis.phaseAnalysis.unlabelled.gauges.eventLoopLagMs, { min: 1, p50: 1, p95: 3, p99: 3, max: 3, first: 1, last: 3 });
    assert.equal("cpuUsageNSec" in analysis, false);
    assert.equal(analysis.phaseAnalysis.unlabelled.counterRates, null);
    assert.deepEqual(analysis.signals, { errors: 0, disconnects: 0, teardownClean: true });
    assert.deepEqual(analyzePlayerLoadReport(report), report.analysis);
    assert.throws(() => buildPlayerLoadReport({ run: { ...run, schema: "successor.player-load-report.v1" }, sourceHash: sourceIdentity.sourceHash }), /versioned run payload/u);
    assert.throws(() => buildPlayerLoadReport({ run, sourceHash: "not-a-sha256" }), /sha256/u);
    assert.throws(() => validatePlayerLoadReport({ ...report, schema: "successor.player-load-report.v1" }), /schema mismatch/u);
    assert.throws(() => validatePlayerLoadReport({ ...report, sourceHash: "0".repeat(63) }), /sha256/u);
    assert.throws(() => validatePlayerLoadReport({ ...report, phases: {} }), /phases and samples arrays/u);
    assert.throws(() => validatePlayerLoadReport({ ...report, samples: {} }), /phases and samples arrays/u);

    const instrumented = analyzePlayerLoadReport({
      ...report,
      samples: [
        { eventLoopLagMs: 1, process: { rssBytes: 100 }, status: { tick: 7, instrumentation: { eventLoopLag: { p95Ms: 0 }, delivery: { queueDepth: 0 }, bridge: { backlogSize: 0 }, sessions: { active: 1 }, commands: { receipts: 1 } } } },
        { eventLoopLagMs: 3, process: { rssBytes: 140 }, status: { tick: 10, instrumentation: { eventLoopLag: { p95Ms: 9 }, delivery: { queueDepth: 4 }, bridge: { backlogSize: 2 }, sessions: { active: 2 }, commands: { receipts: 3 } } } },
      ],
    });
    for (const key of ["costPerAddedClient", "highestGrowthCost", "bottlenecks", "growthFlags", "instrumentation", "cpuUsageNSec"]) {
      assert.equal(key in instrumented, false, `v2 analysis must not emit legacy ${key}`);
    }
    assert.ok(instrumented.phaseAnalysis.unlabelled.gauges.queueDepth.max >= 4);

    await withRunDirectory(async (outDir) => {
      const target = await writePlayerLoadReport({ outDir, report });
      assert.match(target, /successor\.player-load-report\.v2\.json$/u);
      assert.deepEqual(JSON.parse(await readFile(target, "utf8")), report);
      await assert.rejects(writePlayerLoadReport({ outDir, report: { ...report, schema: "successor.player-load-report.v1" } }), /schema mismatch/u);
    });
  });

  it("reports one rejected receipt among 2600 commands as passing evidence below the maxErrorRate, while preserving the reason", () => {
    const options = { maxDisconnects: 0, maxErrorRate: 0.01, maxP95ReceiptMs: 5000, maxP99ReceiptMs: 5000, maxRssBytes: 1e12, maxEventLoopLagMs: 5000 };
    const workload = { attempted: 2600, accepted: 2599, rejected: 1, rejectionReasons: { ingress_budget_exhausted: 1 } };
    assert.equal(thresholdFailure({ options, receiptLatencies: [1], errors: [], disconnects: [], workload, samples: [] }), null);
    const report = buildPlayerLoadReport({
      sourceHash: sourceIdentity.sourceHash,
      samples: [],
      phases: [],
      run: {
        schema: playerLoadReportSchema,
        status: "pass",
        workload,
        errors: [],
        disconnects: [],
        teardown: { clean: true },
      },
    });
    assert.equal(report.status, "pass");
    assert.deepEqual(report.analysis.signals.workload, { attempted: 2600, accepted: 2599, rejected: 1, errorRate: 1 / 2600, rejectionReasons: { ingress_budget_exhausted: 1 } });
    assert.equal(thresholdFailure({ options, receiptLatencies: [1], errors: [], disconnects: [], workload: { attempted: 100, accepted: 98, rejected: 2, rejectionReasons: { ingress_budget_exhausted: 2 } }, samples: [] }), "error_rate_threshold");
  });
});


  it("treats the combined active-session count as server-global drain evidence", async () => {
    const drain = async (activeSessions) => {
      let clock = 0;
      return await awaitTransportDrain({ sample: async () => ({ status: { instrumentation: { sessions: { active: activeSessions }, delivery: { queueDepth: 0, pendingReceipts: 0, pendingEvents: 0, pendingAbilityQueueEvents: 0 }, bridge: { backlogSize: 0 } } } }), expectedActiveSessions: 10, deadlineMs: 1, intervalMs: 0, now: () => clock++, sleep: async () => {} });
    };
    assert.equal((await drain(10)).ok, true);
    assert.equal((await drain(5)).ok, false);
    assert.equal((await drain(11)).ok, false);
  });
describe("successor.player-load-report.v1 runner contract", () => {
  it("ramps distinct identity-joined clients, correlates each queued authority receipt, samples metrics, and writes a validated report", async () => {
    await withStatusServer((endpoint) => withRunDirectory(async (outDir) => {
      const { result, poller, driver } = await runAdopted(endpoint, { outDir });
      assert.equal(result.report.schema, playerLoadReportSchema);
      assert.equal(result.report.status, "pass");
      assert.equal(result.report.clients.requested, 3);
      assert.equal(result.report.clients.joined, 3);
      assert.equal(result.report.clients.uniqueIdentityCount, 3);
      assert.deepEqual(result.report.phases.map((phase) => [phase.targetClients, phase.addedClients]), [[1, 1], [3, 2]]);
      assert.ok(result.report.throughput.measuredDurationMs > 0);
      assert.ok(result.report.throughput.receiptCount >= 3, "each joined player must receive a correlated authority receipt");
      assert.ok(result.report.samples.length >= 1, "report must preserve process/status samples");
      assert.equal(poller.state().starts, 1);
      assert.equal(poller.state().stops, 1);
      assert.equal(driver.created.length, 3);
      assert.equal(new Set(driver.created.map(({ options }) => options.actorId)).size, 3);
      for (const { options, bot } of driver.created) {
        assert.equal(options.actorId, options.characterId, "headless player must join with its own character identity");
        assert.equal(options.playerId, `account-${options.actorId}`);
        assert.equal(bot.closed(), 1, "every real-client lifecycle handle must close exactly once");
        assert.ok(bot.verbs.includes("/move-intent 0 0 Right"), "each cumulative stage client must receipt-check a zero move intent before drain");
      }
      assert.deepEqual(result.report.phases.map((phase) => phase.settle?.ok), [true, true]);
      assert.deepEqual(result.report.phases.map((phase) => phase.drain?.ok), [true, true]);
      assert.equal(result.report.teardown.clean, true);
    }));
  });
  it("preserves parsed expected-session values through runner normalization and drain evidence", async () => {
    await withStatusServer((endpoint) => withRunDirectory(async (outDir) => {
      const runParsed = async ({ name, clients, expectedServerActiveSessions } = {}) => {
        const argv = [
          "--adopt-url", endpoint,
          "--clients", String(clients),
          "--stages", String(clients),
          "--allow-large",
          "--duration-ms", "100",
          "--workload-ms", "100",
          "--sample-interval-ms", "100",
          "--ramp-interval-ms", "0",
          "--drain-timeout-ms", "100",
          "--run-id", `expected-sessions-${name}`,
        ];
        if (expectedServerActiveSessions !== undefined) argv.push("--expected-server-active-sessions", String(expectedServerActiveSessions));
        const parsed = parsePlayerLoadArgs(argv);
        const poller = createArtifactDrainPoller(100);
        const driver = createDriverFactory();
        const result = await runPlayerLoad({
          ...parsed,
          outDir: path.join(outDir, name),
          sourceIdentity,
          createMetricsPoller: () => poller,
          startDriver: driver.factory,
        });
        return { parsed, result, driver };
      };

      const unspecified = await runParsed({ name: "unspecified", clients: 100 });
      assert.equal(unspecified.parsed.expectedServerActiveSessions, null);
      assert.equal(unspecified.result.report.status, "pass");
      assert.equal(unspecified.result.report.clients.joined, 100);
      assert.equal(unspecified.driver.created.length, 100);
      const unspecifiedDrain = unspecified.result.report.phases[0].drain;
      assert.equal(unspecifiedDrain.ok, true);
      assert.equal(unspecifiedDrain.expectedActiveSessions, 100);
      assert.equal(unspecifiedDrain.final.activeSessions, 100);
      assert.deepEqual(unspecifiedDrain.blockers, { sessionMismatch: false, payloadPending: false, workloadPending: false });

      const explicitZero = await runParsed({ name: "explicit-zero", clients: 1, expectedServerActiveSessions: 0 });
      assert.equal(explicitZero.parsed.expectedServerActiveSessions, 0);
      assert.equal(explicitZero.result.report.status, "fail");
      assert.equal(explicitZero.result.report.stoppedBy, "drain_threshold");
      assert.equal(explicitZero.result.report.phases[0].drain.expectedActiveSessions, 0);
      assert.equal(explicitZero.result.report.phases[0].drain.final.activeSessions, 100);
      assert.deepEqual(explicitZero.result.report.phases[0].drain.blockers, { sessionMismatch: true, payloadPending: false, workloadPending: false });

      const explicitPositive = await runParsed({ name: "explicit-positive", clients: 1, expectedServerActiveSessions: 100 });
      assert.equal(explicitPositive.parsed.expectedServerActiveSessions, 100);
      assert.equal(explicitPositive.result.report.status, "pass");
      assert.equal(explicitPositive.result.report.phases[0].drain.expectedActiveSessions, 100);
      assert.equal(explicitPositive.result.report.phases[0].drain.final.activeSessions, 100);
      assert.deepEqual(explicitPositive.result.report.phases[0].drain.blockers, { sessionMismatch: false, payloadPending: false, workloadPending: false });
    }));
  });

  it("keeps a spawned invalid-characterId client out of joined identity accounting while closing it cleanly", async () => {
    await withStatusServer((endpoint) => withRunDirectory(async (outDir) => {
      const driver = createInvalidCharacterIdDriver();
      const generated = await runPlayerLoadGenerator({
        endpoint,
        sourceHash: sourceIdentity.sourceHash,
        sourceIdentity,
        clients: 1,
        stages: [1],
        durationMs: 100,
        workloadMs: 100,
        sampleIntervalMs: 100,
        runId: "invalid-character-id",
        outDir,
        createMetricsPoller: () => createTestMetricsPoller(),
        startDriver: driver.factory,
      });
      const report = JSON.parse(await readFile(generated.reportPath, "utf8"));

      assert.equal(driver.created.length, 1, "the first attempted bot must be retained for teardown");
      assert.deepEqual(driver.created[0].bot.readyWaitLabels(), ["source-validated game.hello"]);
      assert.equal(driver.created[0].bot.closed(), 1, "the rejected bot must close exactly once");
      assert.deepEqual(report.clients, {
        requested: 1,
        spawned: 1,
        joined: 0,
        uniqueIdentityCount: 0,
        joinLatencyMs: { count: 0, p50: null, p95: null, p99: null, max: null },
        receiptLatencyMs: { count: 0, p50: null, p95: null, p99: null, max: null },
      });
      assert.deepEqual(generated.clients, { requested: 1, spawned: 1, identityJoined: 0, joined: 0 });
      assert.deepEqual(report.commands, { attempted: 0, queued: 0, receipts: 0, accepted: 0, rejected: 0 });
      assert.deepEqual(report.workload, { attempted: 0, accepted: 0, rejected: 0, rejectionReasons: {} });
      assert.deepEqual(report.phases, [], "no active workload, settle, or drain can run before an identity proof");
      assert.equal(report.teardown.clientsClosed, 1);
      assert.equal(report.teardown.clean, true);
      assert.match(report.errors.map((entry) => entry.message).join("\n"), /invalid-characterId/u);
    }));
  });

  it("accounts one join proof, workload command, and settle receipt exactly for one client with an event-controlled workload stop", async () => {
    await withStatusServer((endpoint) => withRunDirectory(async (outDir) => {
      const poller = createTestMetricsPoller([{
        timestamp: "2026-07-09T00:00:00.000Z",
        process: { pid: 4242, cpuPercent: 0, rssBytes: 0 },
        status: { sessions: { joined: 1, disconnected: 0 }, receipts: { total: 1 } },
      }]);
      const base = createDriverFactory();
      const driver = {
        factory(options) {
          const bot = base.factory(options);
          const send = bot.send.bind(bot);
          bot.send = (frame) => {
            send(frame);
            if (frame.op === "verb" && bot.verbs.length === 2) poller.samples.push({ process: { rssBytes: 2 } });
          };
          return bot;
        },
      };
      const { result } = await runAdopted(endpoint, {
        outDir,
        clients: 1,
        stages: [1],
        driver,
        poller,
        maxRssBytes: 1,
      });
      assert.equal(result.report.stoppedBy, "rss_threshold", "the second authority verb ends the workload before another round can start");
      assert.deepEqual(result.report.commands, {
        attempted: 3,
        queued: 3,
        receipts: 3,
        accepted: 3,
        rejected: 0,
      });
      assert.equal(result.report.throughput.receiptCount, 1);
    }));
  });

  it("marks teardown unclean when an invalid-characterId client cannot close", async () => {
    await withStatusServer((endpoint) => withRunDirectory(async (outDir) => {
      const driver = createInvalidCharacterIdDriver({ closeRejects: true });
      const { result } = await runAdopted(endpoint, { outDir, clients: 1, stages: [1], driver });
      assert.equal(result.report.status, "fail");
      assert.equal(driver.created.length, 1);
      assert.deepEqual(driver.created[0].bot.readyWaitLabels(), ["source-validated game.hello"]);
      assert.equal(driver.created[0].bot.closeAttempts(), 1, "the teardown must still attempt the spawned handle");
      assert.equal(result.report.clients.joined, 0);
      assert.equal(result.report.clients.uniqueIdentityCount, 0);
      assert.deepEqual(result.report.clients.joinLatencyMs, { count: 0, p50: null, p95: null, p99: null, max: null });
      assert.deepEqual(result.report.commands, { attempted: 0, queued: 0, receipts: 0, accepted: 0, rejected: 0 });
      assert.deepEqual(result.report.workload, { attempted: 0, accepted: 0, rejected: 0, rejectionReasons: {} });
      assert.deepEqual(result.report.phases, []);
      assert.equal(result.report.teardown.clean, false);
      assert.equal(result.report.teardown.clientsClosed, 0);
      assert.match(result.report.errors.map((entry) => entry.message).join("\n"), /invalid-characterId|controlled close failure/u);
    }));
  });

  it("fails the run rather than accepting a receipt whose command kind does not match the queued authority command", async () => {
    await withStatusServer((endpoint) => withRunDirectory(async (outDir) => {
      const driver = createDriverFactory({ wrongReceiptKind: true });
      const { result } = await runAdopted(endpoint, { outDir, clients: 1, stages: [1], driver });
      assert.equal(result.report.status, "fail");
      assert.match(result.report.errors.map((entry) => entry.message).join("\n"), /command kind|receipt/u);
      assert.equal(driver.created[0].bot.closed(), 1);
    }));
  });

  it("preserves a correlated rejected receipt as workload evidence and fails all-rejected work by threshold despite low receipt latency", async () => {
    await withStatusServer((endpoint) => withRunDirectory(async (outDir) => {
      const driver = createDriverFactory({ rejectedWorkloadClientIndexes: [0] });
      const { result } = await runAdopted(endpoint, { outDir, clients: 1, stages: [1], driver, maxErrorRate: 0 });
      assert.equal(result.report.status, "fail");
      assert.equal(result.report.stoppedBy, "error_rate_threshold");
      assert.deepEqual(result.report.phases[0].workload, {
        rounds: 1,
        stoppedBy: "error_rate_threshold",
        attempted: 1,
        accepted: 0,
        rejected: 1,
        rejectionReasons: { ingress_budget_exhausted: 1 },
      });
      assert.deepEqual(result.report.workload, {
        attempted: 1,
        accepted: 0,
        rejected: 1,
        rejectionReasons: { ingress_budget_exhausted: 1 },
      });
      assert.ok(result.report.clients.receiptLatencyMs.count >= 1, "a low-latency rejected receipt must not make workload green");
      assert.deepEqual(result.report.errors, [], "receipt rejections are workload evidence, not fatal transport errors before threshold evaluation");
    }));
  });

  it("uses rejected divided by attempted commands at the one-of-N maxErrorRate boundary", async () => {
    await withStatusServer((endpoint) => withRunDirectory(async (outDir) => {
      const atBoundary = await runAdopted(endpoint, {
        outDir,
        clients: 2,
        stages: [2],
        driver: createDriverFactory({ rejectedWorkloadClientIndexes: [0] }),
        maxErrorRate: 0.5,
        workloadMs: 1_000,
      });
      assert.equal(atBoundary.result.report.status, "pass", "a below-threshold receipt rejection remains report evidence rather than a fatal verdict");
      assert.deepEqual(atBoundary.result.report.errors, []);
      assert.equal(atBoundary.result.report.phases[0].threshold, null, "one rejected command out of two equals, but does not exceed, the configured boundary");
      assert.deepEqual(atBoundary.result.report.workload, {
        attempted: 2,
        accepted: 1,
        rejected: 1,
        rejectionReasons: { ingress_budget_exhausted: 1 },
      });

      const belowBoundary = await runAdopted(endpoint, {
        outDir,
        clients: 2,
        stages: [2],
        driver: createDriverFactory({ rejectedWorkloadClientIndexes: [0] }),
        maxErrorRate: 0.49,
        workloadMs: 1_000,
      });
      assert.equal(belowBoundary.result.report.stoppedBy, "error_rate_threshold");
      assert.equal(belowBoundary.result.report.phases[0].threshold, "error_rate_threshold");
      assert.equal(belowBoundary.result.report.workload.attempted, 2);
      assert.equal(belowBoundary.result.report.workload.rejected, 1);
    }));
  });

  it("keeps transport loss fatal even when its rejection rate is permitted", async () => {
    await withStatusServer((endpoint) => withRunDirectory(async (outDir) => {
      const { result } = await runAdopted(endpoint, {
        outDir,
        clients: 1,
        stages: [1],
        driver: createDriverFactory({ disconnectOnWorkloadOnce: true }),
        maxErrorRate: 1,
        maxDisconnects: 1,
      });
      assert.equal(result.report.status, "fail");
      assert.equal(result.report.stoppedBy, null);
      assert.equal(result.report.disconnects.length, 1);
      assert.ok(result.report.errors.length > 0, "transport loss must remain a fatal error rather than workload rejection evidence");
    }));
  });

  it("accounts disconnects and aborts a ramp before adding later clients once the disconnect threshold is breached", async () => {
    await withStatusServer((endpoint) => withRunDirectory(async (outDir) => {
      const driver = createDriverFactory({ disconnectOnWorkload: true });
      const { result } = await runAdopted(endpoint, {
        outDir,
        clients: 3,
        stages: [1, 3],
        driver,
        maxDisconnects: 0,
      });
      assert.equal(result.report.status, "fail");
      assert.equal(result.report.stoppedBy, "disconnect_threshold");
      assert.equal(result.report.disconnects.length, 1);
      assert.equal(result.report.clients.joined, 1, "a bounded ramp must stop before later joins");
      assert.equal(driver.created.length, 1);
      assert.equal(driver.created[0].bot.closed(), 1);
    }));
  });

  it("aborts on p95 receipt threshold and closes every started client", async () => {
    await withStatusServer((endpoint) => withRunDirectory(async (outDir) => {
      const driver = createDriverFactory({ receiptDelayMs: 10 });
      const { result } = await runAdopted(endpoint, {
        outDir,
        clients: 2,
        stages: [1, 2],
        driver,
        maxP95ReceiptMs: 1,
      });
      assert.equal(result.report.status, "fail");
      assert.equal(result.report.stoppedBy, "receipt_latency_threshold");
      assert.equal(result.report.clients.joined, 1);
      assert.equal(driver.created[0].bot.closed(), 1);
    }));
  });

  it("tears down a partially started client when the hello/ready lifecycle fails or the supplied signal aborts", async () => {
    await withStatusServer((endpoint) => withRunDirectory(async (outDir) => {
      const failedDriver = createDriverFactory({ failReady: true });
      const failed = await runAdopted(endpoint, { outDir, clients: 1, stages: [1], driver: failedDriver });
      assert.equal(failed.result.report.status, "fail");
      assert.equal(failedDriver.created[0].bot.closed(), 1);
      assert.equal(failed.result.report.teardown.clean, true);

      const controller = new AbortController();
      controller.abort(new Error("SIGINT test"));
      const abortedDriver = createDriverFactory();
      const aborted = await runAdopted(endpoint, { outDir, clients: 1, stages: [1], driver: abortedDriver, signal: controller.signal });
      assert.equal(aborted.result.report.status, "fail");
      assert.match(aborted.result.report.errors.map((entry) => entry.message).join("\n"), /aborted/u);
      assert.equal(abortedDriver.created[0].bot.closed(), 1);
      assert.equal(aborted.result.report.teardown.clean, true);
    }));
  });

  it("refuses reserved active service ports before attempting an isolated load server", async () => {
    await withRunDirectory(async (outDir) => {
      await assert.rejects(
        runPlayerLoad({ port: 28093, clients: 1, stages: [1], sourceIdentity, outDir }),
        /reserved|active port|28093/u,
      );
    });
  });
  it("refuses to reuse durable state from an earlier isolated load run", async () => {
    await withRunDirectory(async (runDir) => {
      await mkdir(path.join(runDir, "game-state"));
      await writeFile(path.join(runDir, "game-state", "stale.checkpoint.json"), "{}");
      let buildCalled = false;
      await assert.rejects(
        startIsolatedServer({
          root: runDir,
          runDir,
          runId: "stale-state-refusal",
          clients: 1,
          buildArtifacts: async () => {
            buildCalled = true;
          },
        }),
        /refusing to reuse isolated player-load state directory/u,
      );
      assert.equal(buildCalled, false);
    });
  });
  it("refuses stale or missing source-bound artifacts before starting an isolated process host", async () => {
    await withRunDirectory(async (root) => {
      let buildRequest = null;
      await assert.rejects(
        startIsolatedServer({
          root,
          runDir: root,
          runId: "artifact-refusal",
          clients: 1,
          sourceHash: sourceIdentity.sourceHash,
          sourcePaths: ["server/src/main.ts", "client/src/headless.ts"],
          buildArtifacts: async (request) => {
            buildRequest = request;
            throw new Error("stale or missing bound artifact");
          },
        }),
        /stale or missing bound artifact/u,
      );
      assert.deepEqual(buildRequest.sourcePaths, ["server/src/main.ts", "client/src/headless.ts"]);
      assert.equal(buildRequest.sourceHash, sourceIdentity.sourceHash);
      assert.deepEqual(Object.keys(buildRequest.paths).sort(), ["bridge", "cli", "serverDist", "slice"]);
    });
  });
  it("records only a fully clean ordered local artifact build and writes its bound manifest", async () => {
    await withArtifactFixture(async ({ root, runDir, paths, sourceHash }) => {
      const calls = [];
      const artifacts = await prepareIsolatedArtifacts({
        root,
        runDir,
        sourceHash,
        sourcePaths: ["fixture.txt"],
        paths,
        runProcess: async (command, argv, options) => {
          calls.push({ command, argv, options });
          return { ok: true, groupClean: true, exitCode: 0 };
        },
      });
      assert.deepEqual(calls, [
        { command: "pnpm", argv: ["--dir", "server", "build"], options: { cwd: root, timeoutMs: 900_000 } },
        { command: "cargo", argv: ["build", "--locked", "-q", "-p", "successor-sim", "--example", "authority_bridge_server"], options: { cwd: root, timeoutMs: 900_000 } },
        { command: "pnpm", argv: ["--dir", "client", "build:headless"], options: { cwd: root, timeoutMs: 900_000 } },
      ]);
      assert.equal(artifacts.artifacts.length, 4);
      assert.deepEqual(artifacts.artifacts.map((artifact) => artifact.path).sort(), [
        "client/dist/headless/cli.js",
        "client/public/successor-slice/open-desert-slice.json",
        "server/dist/index.js",
        "target/debug/examples/authority_bridge_server",
      ]);
      const marker = JSON.parse(await readFile(path.join(runDir, "isolated-artifacts.json"), "utf8"));
      assert.equal(marker.sourceHash, sourceHash);
      assert.equal(marker.builds.length, 3);
    });
  });

  it("fails closed on an unclean local build, redacts bounded diagnostics, and never starts ProcessHost", async () => {
    await withArtifactFixture(async ({ root, runDir, paths, sourceHash }) => {
      let starts = 0;
      const stderr = `${"x".repeat(10_000)} token=fixture-secret\nterminal compiler cause`;
      const processHost = {
        start: async () => { starts += 1; return { name: "must-not-start" }; },
        stop: async () => ({ ok: true }),
        assertStopped: async () => ({ ok: true }),
      };
      await assert.rejects(
        startIsolatedServer({
          root,
          runDir,
          runId: "unclean-artifact",
          clients: 1,
          sourceHash,
          processHostFactory: () => processHost,
          buildArtifacts: (request) => prepareIsolatedArtifacts({
            ...request,
            runProcess: async () => ({
              ok: true,
              groupClean: false,
              timedOut: true,
              escalated: true,
              errorCode: "PROCESS_GROUP_SURVIVED",
              stderr,
            }),
          }),
        }),
        (error) => error?.code === "ISOLATED_ARTIFACT_BUILD_FAILED"
          && error?.buildFailure?.groupClean === false
          && error?.buildFailure?.timedOut === true
          && error?.buildFailure?.escalated === true
          && error.message.length <= 8_500
          && /token=\[redacted\]/u.test(error.message)
          && /terminal compiler cause/u.test(error.message)
          && !/fixture-secret/u.test(error.message),
      );
      assert.equal(starts, 0, "an unclean artifact group must block ProcessHost startup");
      await assert.rejects(readFile(path.join(runDir, "isolated-artifacts.json"), "utf8"), { code: "ENOENT" });
    });
  });

  it("waits for real owned build groups to die after normal leader exit and timeout TERM before settling", async () => {
    await withRunDirectory(async (root) => {
      const cases = [
        {
          label: "normal leader exit",
          timeoutMs: 1_000,
          onTerm: "process.on('SIGTERM', () => {});",
          leaderExit: "process.exit(0);",
          expected: { ok: true, timedOut: false },
        },
        {
          label: "timeout leader exit",
          timeoutMs: 300,
          onTerm: "process.on('SIGTERM', () => process.exit(0));",
          leaderExit: "setInterval(() => {}, 1_000);",
          expected: { ok: false, timedOut: true },
        },
        {
          label: "timeout TERM ignoring group",
          timeoutMs: 300,
          onTerm: "process.on('SIGTERM', () => {});",
          leaderExit: "setInterval(() => {}, 1_000);",
          expected: { ok: false, timedOut: true },
        },
      ];
      for (const fixture of cases) {
        const pidPath = path.join(root, `${fixture.label.replaceAll(" ", "-")}.json`);
        const readyPath = path.join(root, `${fixture.label.replaceAll(" ", "-")}.ready`);
        const descendantScript = [
          "const fs = require('node:fs');",
          "process.on('SIGTERM', () => {});",
          `fs.writeFileSync(${JSON.stringify(readyPath)}, 'ready');`,
          "setInterval(() => {}, 1_000);",
        ].join("\n");
        const script = [
          "const { spawn } = require('node:child_process');",
          "const fs = require('node:fs');",
          `const descendant = spawn(process.execPath, ['-e', ${JSON.stringify(descendantScript)}], { stdio: 'ignore' });`,
          "const ready = setInterval(() => {",
          `  if (!fs.existsSync(${JSON.stringify(readyPath)})) return;`,
          "  clearInterval(ready);",
          `  fs.writeFileSync(${JSON.stringify(pidPath)}, JSON.stringify({ leader: process.pid, descendant: descendant.pid }));`,
          `  ${fixture.onTerm}`,
          `  ${fixture.leaderExit}`,
          "}, 5);",
        ].join("\n");
        let pids;
        try {
          let settled = false;
          const running = runBoundedProcess(process.execPath, ["-e", script], {
            cwd: root,
            timeoutMs: fixture.timeoutMs,
            termGraceMs: 125,
            killGraceMs: 750,
          }).then((result) => { settled = true; return result; });
          pids = JSON.parse(await waitForFile(pidPath));
          await delay(30);
          assert.equal(settled, false, `${fixture.label} must not settle while its descendant survives`);
          const result = await running;
          assert.equal(result.ok, fixture.expected.ok);
          assert.equal(result.timedOut, fixture.expected.timedOut);
          assert.equal(result.escalated, true);
          assert.equal(result.groupClean, true);
          await assertFixtureGone(pids, fixture.label);
        } finally {
          forceFixtureCleanup(pids);
        }
      }
    });
  });

  it("returns bounded redacted diagnostics when local build spawn fails before ownership exists", async () => {
    const result = await runBoundedProcess("fixture-build", [], {
      cwd: process.cwd(),
      timeoutMs: 100,
      spawnProcess: () => { throw new Error(`${"x".repeat(10_000)} token=spawn-secret final spawn failure`); },
    });
    assert.equal(result.ok, false);
    assert.equal(result.groupClean, true);
    assert.equal(result.errorCode, "SPAWN_FAILED");
    assert.ok(result.error.length <= 8 * 1024);
    assert.match(result.error, /token=\[redacted\]/u);
    assert.match(result.error, /final spawn failure$/u);
    assert.doesNotMatch(result.error, /spawn-secret/u);
  });
  it("asserts server death even when readiness and the first stop attempt both fail", async () => {
    await withRunDirectory(async (root) => {
      const events = [];
      const processHost = {
        start: async () => { events.push("start"); return { name: "isolated-server" }; },
        stop: async () => { events.push("stop"); throw new Error("controlled stop failure"); },
        assertStopped: async () => { events.push("assert"); return { ok: true }; },
      };
      await assert.rejects(
        startIsolatedServer({
          root,
          runDir: root,
          runId: "readiness-cleanup",
          clients: 1,
          sourceHash: sourceIdentity.sourceHash,
          buildArtifacts: async () => ({ sourceHash: sourceIdentity.sourceHash, artifacts: [] }),
          processHostFactory: () => processHost,
          waitForReady: async () => { throw new Error("controlled readiness failure"); },
        }),
        (error) => error?.code === "ISOLATED_SERVER_READINESS_CLEANUP_FAILED"
          && error.errors.some((entry) => /controlled readiness failure|controlled stop failure/u.test(entry.message)),
      );
      assert.deepEqual(events, ["start", "stop", "assert"]);
    });
  });


  it("proves the signed tree identity in a non-Git checkout and refuses missing, extra, or tampered paths", async () => {
    await withRunDirectory(async (root) => {
      await writeFile(path.join(root, "fixture.txt"), "original", "utf8");
      const expected = await createTreeSourceIdentity({ root, expectedPaths: ["fixture.txt"], includeManifest: true });
      const captured = await captureStableTreeSourceIdentity({ root, paths: ["fixture.txt"], expectedHash: expected.sourceHash });
      assert.equal(captured.sourceHash, expected.sourceHash);

      await writeFile(path.join(root, "fixture.txt"), "tampered", "utf8");
      await assert.rejects(captureStableTreeSourceIdentity({ root, paths: ["fixture.txt"], expectedHash: expected.sourceHash }), /hash/u);
      await rm(path.join(root, "fixture.txt"));
      await assert.rejects(captureStableTreeSourceIdentity({ root, paths: ["fixture.txt"], expectedHash: expected.sourceHash }), /mismatch/u);

      await writeFile(path.join(root, "fixture.txt"), "original", "utf8");
      await writeFile(path.join(root, "extra.txt"), "extra", "utf8");
      await assert.rejects(captureStableTreeSourceIdentity({ root, paths: ["fixture.txt"], expectedHash: expected.sourceHash }), /mismatch/u);
    });
  });

  it("canonicalizes mixed-case Mac load identities across store seeding and client joins", async () => {
    await withStatusServer((endpoint) => withRunDirectory(async (outDir) => {
      const runId = "approved-mac5-20260710T110248Z";
      const identityNamespace = "MacBookPro";
      const expected = [
        "player-load-approved-mac5-20260710t110248z-macbookpro-004",
        "player-load-approved-mac5-20260710t110248z-macbookpro-005",
      ];
      const storePath = path.join(outDir, "characters.json");
      await writeLoadCharacterStore(storePath, runId, 5, [identityNamespace]);
      const seededIds = JSON.parse(await readFile(storePath, "utf8")).characters.map((character) => character.id);
      const driver = createDriverFactory();

      await runAdopted(endpoint, { clients: 2, stages: [2], driver, identityNamespace, clientOffset: 3, outDir, runId });

      assert.deepEqual(seededIds.slice(3), expected, "store seeds server-normalized lowercase IDs");
      assert.deepEqual(driver.created.map(({ options }) => options.characterId), expected, "join driver receives its exact seeded identity");
      assert.deepEqual(driver.created.map(({ options }) => options.actorId), expected);
      assert.deepEqual(driver.created.map(({ options }) => options.playerId), expected.map((id) => `account-${id}`));
      assert.equal(canonicalLoadCharacterId("contract", "pc", 1), "player-load-contract-pc-001", "existing lowercase IDs remain unchanged");
    }));
  });

  it("rejects invalid and canonically colliding load identity tokens", async () => {
    await withRunDirectory(async (outDir) => {
      await assert.rejects(
        writeLoadCharacterStore(path.join(outDir, "characters.json"), "approved-mac5-20260710T110248Z", 1, ["Mac", "mac"]),
        /collid/u,
      );
      assert.throws(() => canonicalLoadCharacterId("", "mac", 1), /runId|run id/u);
      assert.throws(() => canonicalLoadCharacterId("run", "", 1), /identityNamespace/u);
    });
  });

  it("seeds disjoint PC and Mac identity namespaces for one isolated run", async () => {
    await withRunDirectory(async (outDir) => {
      const storePath = path.join(outDir, "characters.json");
      await writeLoadCharacterStore(storePath, "combined-load", 3, ["pc", "mac"]);
      const store = JSON.parse(await readFile(storePath, "utf8"));
      const ids = store.characters.map((character) => character.id);
      assert.deepEqual(ids, ["player-load-combined-load-pc-001", "player-load-combined-load-pc-002", "player-load-combined-load-pc-003", "player-load-combined-load-mac-001", "player-load-combined-load-mac-002", "player-load-combined-load-mac-003"]);
      assert.ok(store.characters.every((character) => (
        character.initialProfessionId === "marksman"
        && character.professions?.skillBoxes?.includes("marksman-novice")
        && character.professions?.skillPointCap === 250
      )), "load identities satisfy the normal first-entry profession contract");
      assert.equal(new Set(ids).size, ids.length);
    });
  });

  it("uses clientOffset as the identity ordinal for disjoint same-namespace batches", async () => {
    await withStatusServer(async (endpoint) => {
      const first = createDriverFactory();
      const second = createDriverFactory();
      await runAdopted(endpoint, { clients: 3, stages: [3], driver: first, identityNamespace: "pc", clientOffset: 0 });
      await runAdopted(endpoint, { clients: 3, stages: [3], driver: second, identityNamespace: "pc", clientOffset: 3 });
      const ids = [...first.created, ...second.created].map((entry) => entry.options.actorId);
      assert.deepEqual(ids, ["player-load-contract-pc-001", "player-load-contract-pc-002", "player-load-contract-pc-003", "player-load-contract-pc-004", "player-load-contract-pc-005", "player-load-contract-pc-006"]);
      assert.equal(new Set(ids).size, ids.length);
    });
  });
});
