import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  MAX_REMOTE_PLAYER_CLIENTS,
  REMOTE_PLAYER_GENERATOR_SCHEMA,
  createRemotePlayerGeneratorRequest,
  executeMacPlayerGenerator,
  launchPreparedMacPlayerGenerator,
} from "./remote-generator.mjs";
import { sha256Json } from "../farm/protocol.mjs";
import { REMOTE_CHECKOUT } from "../farm/sync.mjs";

const SOURCE_HASH = "a".repeat(64);
const SOURCE_PATHS = ["fixture.txt"];
const HOST = "macbook-codex";
const ENDPOINT = "http://100.101.102.103:28093";
const HANDLE_SCHEMA = "successor.remote-process-host-handle.v1";
const ENVELOPE_SCHEMA = "successor.remote-process-host-phase-envelope.v1";
const PHASES = ["headless-preparation", "endpoint-reachability", "generator"];

function preflight(overrides = {}) {
  return {
    schema: "successor.farm-preflight.v1",
    status: "ready",
    host: HOST,
    checkout: REMOTE_CHECKOUT,
    source: { match: true, localHash: SOURCE_HASH, remoteHash: SOURCE_HASH },
    capabilities: {
      toolchain: { node: { available: true }, pnpm: { available: true } },
      runtime: { processHost: { available: true } },
    },
    ...overrides,
  };
}

function request(overrides = {}) {
  return createRemotePlayerGeneratorRequest({
    endpoint: ENDPOINT,
    clients: 5,
    durationMs: 2_000,
    rampIntervalMs: 500,
    sampleIntervalMs: 1_000,
    runId: "load-smoke",
    sourceHash: SOURCE_HASH,
    sourcePaths: SOURCE_PATHS,
    generatorId: "mac",
    ...overrides,
  });
}

function passingResult(boundRequest, overrides = {}) {
  const result = {
    schema: REMOTE_PLAYER_GENERATOR_SCHEMA,
    status: "pass",
    runId: boundRequest.runId,
    sourceHash: boundRequest.sourceHash,
    generatorId: boundRequest.generatorId,
    clients: { requested: boundRequest.clients, identityJoined: boundRequest.clients, joined: boundRequest.clients, disconnected: 0 },
    commands: { sent: boundRequest.clients, receipts: boundRequest.clients, accepted: boundRequest.clients, rejected: 0 },
    latency: {
      joinMs: { p50: 10, p95: 12, p99: 15 },
      receiptMs: { p50: 5, p95: 9, p99: 11 },
    },
    throughput: { commandsPerSecond: 1, receiptsPerSecond: 1 },
    errors: [],
    teardown: { attempted: true, clean: true },
    ...overrides,
  };
  result.checksum = sha256Json(result);
  return result;
}

function failingResult(boundRequest, overrides = {}) {
  const { checksum: _checksum, ...passing } = passingResult(boundRequest);
  const result = {
    ...passing,
    status: "fail",
    stoppedBy: "runner_error",
    errors: [{ phase: "runner", message: "remote workload fixture failed" }],
    ...overrides,
  };
  result.checksum = sha256Json(result);
  return result;
}

function passingPreparation() {
  return {
    schema: "successor.player-load-headless-prep.v1",
    status: "pass",
    built: true,
    source: { beforeHash: SOURCE_HASH, afterHash: SOURCE_HASH, expectedHash: SOURCE_HASH, match: true },
  };
}

function passingProbe() {
  return {
    schema: "successor.player-load-endpoint-probe.v1",
    status: "pass",
    endpoint: ENDPOINT,
    shardId: "fixture-shard",
    source: { stateHash: "fixture-state", sliceHash: "fixture-slice" },
  };
}

function phaseOutput(boundRequest, phase) {
  if (phase === "headless-preparation") return JSON.stringify(passingPreparation());
  if (phase === "endpoint-reachability") return JSON.stringify(passingProbe());
  return JSON.stringify(passingResult(boundRequest));
}

function phaseEnvelope(boundRequest, phase, overrides = {}) {
  return {
    schema: ENVELOPE_SCHEMA,
    status: "complete",
    runId: boundRequest.runId,
    sourceHash: boundRequest.sourceHash,
    generatorId: boundRequest.generatorId,
    phase,
    requestHash: sha256Json(boundRequest),
    process: { exitCode: 0, signal: null },
    stdout: phaseOutput(boundRequest, phase),
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
    ...overrides,
  };
}

function phaseHandle(boundRequest, phase) {
  return {
    schema: HANDLE_SCHEMA,
    runId: boundRequest.runId,
    sourceHash: boundRequest.sourceHash,
    generatorId: boundRequest.generatorId,
    phase,
    requestHash: sha256Json(boundRequest),
    kind: "child",
    name: `phase-${phase}`,
    pid: 4242 + PHASES.indexOf(phase),
  };
}

function createSupervisor({ events = [], awaitPhase, recover = async ({ phase, request: boundRequest }) => ({ handle: phaseHandle(boundRequest, phase) }), stop = async () => ({ ok: true }), assertStopped = async () => ({ ok: true }) } = {}) {
  return {
    start: async ({ phase, request: boundRequest, timeoutMs }) => {
      events.push({ operation: "start", phase, request: boundRequest, timeoutMs });
      return { handle: phaseHandle(boundRequest, phase) };
    },
    recover: async ({ phase, request: boundRequest }) => {
      events.push({ operation: "recover", phase, request: boundRequest });
      return recover({ phase, request: boundRequest });
    },
    await: async ({ phase, request: boundRequest, handle, timeoutMs }) => {
      events.push({ operation: "await", phase, request: boundRequest, handle, timeoutMs });
      return awaitPhase
        ? awaitPhase({ phase, request: boundRequest, handle, timeoutMs })
        : { envelope: phaseEnvelope(boundRequest, phase) };
    },
    stop: async ({ phase, request: boundRequest, handle, graceMs }) => {
      events.push({ operation: "stop", phase, request: boundRequest, handle, graceMs });
      return stop({ phase, request: boundRequest, handle, graceMs });
    },
    assertStopped: async ({ phase, request: boundRequest, handle, timeoutMs }) => {
      events.push({ operation: "assertStopped", phase, request: boundRequest, handle, timeoutMs });
      return assertStopped({ phase, request: boundRequest, handle, timeoutMs });
    },
  };
}

async function runRemote({ remoteSupervisor, signal, preflightDocument = preflight(), requestOverrides = {} } = {}) {
  return executeMacPlayerGenerator({
    root: "/fixture/root",
    host: HOST,
    preflight: async () => preflightDocument,
    remoteSupervisor,
    signal,
    ...requestOverrides,
    endpoint: requestOverrides.endpoint ?? ENDPOINT,
    clients: requestOverrides.clients ?? 5,
    durationMs: requestOverrides.durationMs ?? 2_000,
    runId: requestOverrides.runId ?? "load-smoke",
    sourceHash: requestOverrides.sourceHash ?? SOURCE_HASH,
    sourcePaths: requestOverrides.sourcePaths ?? SOURCE_PATHS,
    generatorId: requestOverrides.generatorId ?? "mac",
  });
}

function lifecycle(events) {
  return events.map(({ operation, phase }) => `${operation}:${phase}`);
}

function cleanupAfterEveryRegisteredPhase(events) {
  const starts = events.filter((entry) => entry.operation === "start");
  for (const started of starts) {
    const operations = events.filter((entry) => entry.phase === started.phase).map((entry) => entry.operation);
    assert.deepEqual(operations.slice(-2), ["stop", "assertStopped"], `${started.phase} must stop and prove group absence`);
  }
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

describe("Mac remote player generator request-scoped supervisor", () => {
  it("runs source-bound prep and generator phases through start, await, stop, and absence assertion", async () => {
    const events = [];
    const output = await runRemote({ remoteSupervisor: createSupervisor({ events }) });

    assert.equal(output.result.clients.joined, 5);
    assert.deepEqual(lifecycle(events), PHASES.flatMap((phase) => [`start:${phase}`, `await:${phase}`, `stop:${phase}`, `assertStopped:${phase}`]));
    for (const event of events) {
      assert.equal(event.request.runId, "load-smoke");
      assert.equal(event.request.sourceHash, SOURCE_HASH);
      assert.equal(event.request.generatorId, "mac");
    }
    cleanupAfterEveryRegisteredPhase(events);
  });

  it("fails closed before a worker can register when source parity or required host capabilities are absent", async () => {
    let starts = 0;
    const supervisor = createSupervisor({ events: [], awaitPhase: () => { throw new Error("unreachable"); } });
    supervisor.start = async () => { starts += 1; throw new Error("must not start"); };
    await assert.rejects(
      runRemote({ remoteSupervisor: supervisor, preflightDocument: preflight({ source: { match: true, localHash: "b".repeat(64), remoteHash: SOURCE_HASH } }) }),
      (error) => error?.code === "REMOTE_GENERATOR_PREFLIGHT_FAILED",
    );
    await assert.rejects(
      runRemote({ remoteSupervisor: supervisor, preflightDocument: preflight({ capabilities: { toolchain: { node: { available: false } }, runtime: { processHost: { available: true } } } }) }),
      (error) => error?.code === "REMOTE_GENERATOR_PREFLIGHT_FAILED",
    );
    assert.equal(starts, 0);
  });

  it("reports a valid completed generator fail document instead of claiming SSH loss", async () => {
    const events = [];
    const secretFragment = "remote-secret-must-not-leak";
    const message = `token=${secretFragment.repeat(200)}\nrunner exhausted its bounded retry budget`;
    assert.ok(message.length > 1024, "fixture must exercise bounded failure diagnostics");
    const supervisor = createSupervisor({
      events,
      awaitPhase: ({ request: boundRequest, phase }) => phase === "generator"
        ? { envelope: phaseEnvelope(boundRequest, phase, {
          process: { exitCode: 1, signal: null },
          stdout: JSON.stringify(failingResult(boundRequest, {
            stoppedBy: "runner_error",
            errors: [{ phase: "runner", message }],
          })),
        }) }
        : { envelope: phaseEnvelope(boundRequest, phase) },
    });

    await assert.rejects(
      runRemote({ remoteSupervisor: supervisor }),
      (error) => error?.code === "REMOTE_GENERATOR_REPORTED_FAILURE"
        && error.details.remote.stoppedBy === "runner_error"
        && error.details.remote.errors?.length === 1
        && error.details.remote.errors[0].phase === "runner"
        && error.details.remote.errors[0].message.includes("token=[redacted]")
        && !error.details.remote.errors[0].message.includes(secretFragment)
        && error.details.remote.errors[0].message.endsWith("runner exhausted its bounded retry budget")
        && error.details.remote.errors[0].message.length <= 1024,
    );
    assert.deepEqual(lifecycle(events), PHASES.flatMap((phase) => [`start:${phase}`, `await:${phase}`, `stop:${phase}`, `assertStopped:${phase}`]));
    cleanupAfterEveryRegisteredPhase(events);
  });

  it("keeps completed remote process failures separate from malformed output and await transport loss", async () => {
    const cases = [
      {
        label: "completed exit one with invalid JSON",
        awaitPhase: ({ request: boundRequest, phase }) => phase === "generator"
          ? { envelope: phaseEnvelope(boundRequest, phase, { process: { exitCode: 1, signal: null }, stdout: "not-json" }) }
          : { envelope: phaseEnvelope(boundRequest, phase) },
        code: "REMOTE_GENERATOR_PROCESS_FAILED",
      },
      {
        label: "timed-out await without completed envelope",
        awaitPhase: ({ request: boundRequest, phase }) => {
          if (phase !== "generator") return { envelope: phaseEnvelope(boundRequest, phase) };
          throw Object.assign(new Error("remote wait timed out"), { code: "ETIMEDOUT" });
        },
        code: "REMOTE_GENERATOR_SSH_LOST",
      },
      {
        label: "aborted await without completed envelope",
        awaitPhase: ({ request: boundRequest, phase }) => {
          if (phase !== "generator") return { envelope: phaseEnvelope(boundRequest, phase) };
          throw new DOMException("caller aborted after registration", "AbortError");
        },
        code: "REMOTE_GENERATOR_SSH_LOST",
      },
      {
        label: "lost SSH await without completed envelope",
        awaitPhase: ({ request: boundRequest, phase }) => {
          if (phase !== "generator") return { envelope: phaseEnvelope(boundRequest, phase) };
          throw Object.assign(new Error("SSH transport disappeared"), { code: "SSH_LOST" });
        },
        code: "REMOTE_GENERATOR_SSH_LOST",
      },
    ];

    for (const testCase of cases) {
      const events = [];
      const supervisor = createSupervisor({ events, awaitPhase: testCase.awaitPhase });
      await assert.rejects(
        runRemote({ remoteSupervisor: supervisor }),
        (error) => error?.code === testCase.code,
        testCase.label,
      );
      assert.deepEqual(lifecycle(events), PHASES.flatMap((phase) => [`start:${phase}`, `await:${phase}`, `stop:${phase}`, `assertStopped:${phase}`]), testCase.label);
      cleanupAfterEveryRegisteredPhase(events);
    }
  });

  it("rejects checksum-invalid and request-rebound completed fail reports before failure classification", async () => {
    const cases = [
      {
        label: "checksum-invalid failure report",
        result: (boundRequest) => ({ ...failingResult(boundRequest), checksum: "b".repeat(64) }),
        code: "REMOTE_GENERATOR_CHECKSUM_MISMATCH",
      },
      {
        label: "request-rebound failure report",
        result: (boundRequest) => failingResult(boundRequest, { sourceHash: "b".repeat(64) }),
        code: "REMOTE_GENERATOR_BINDING_MISMATCH",
      },
    ];

    for (const testCase of cases) {
      const events = [];
      const supervisor = createSupervisor({
        events,
        awaitPhase: ({ request: boundRequest, phase }) => phase === "generator"
          ? { envelope: phaseEnvelope(boundRequest, phase, {
            process: { exitCode: 1, signal: null },
            stdout: JSON.stringify(testCase.result(boundRequest)),
          }) }
          : { envelope: phaseEnvelope(boundRequest, phase) },
      });
      await assert.rejects(runRemote({ remoteSupervisor: supervisor }), (error) => error?.code === testCase.code, testCase.label);
      assert.deepEqual(lifecycle(events), PHASES.flatMap((phase) => [`start:${phase}`, `await:${phase}`, `stop:${phase}`, `assertStopped:${phase}`]), testCase.label);
      cleanupAfterEveryRegisteredPhase(events);
    }
  });
  it("recovers a request-bound handle after a lost start response, then awaits and tears it down before continuing", async () => {
    const events = [];
    const supervisor = createSupervisor({ events });
    supervisor.start = async ({ phase, request: boundRequest, timeoutMs }) => {
      events.push({ operation: "start", phase, request: boundRequest, timeoutMs });
      if (phase === "headless-preparation") throw Object.assign(new Error("SSH lost after the remote worker registered"), { code: "SSH_LOST" });
      return { handle: phaseHandle(boundRequest, phase) };
    };

    const output = await runRemote({ remoteSupervisor: supervisor });

    assert.equal(output.result.status, "pass");
    assert.deepEqual(lifecycle(events).slice(0, 5), [
      "start:headless-preparation",
      "recover:headless-preparation",
      "await:headless-preparation",
      "stop:headless-preparation",
      "assertStopped:headless-preparation",
    ]);
    const recovered = events.find((entry) => entry.operation === "recover");
    const stopped = events.find((entry) => entry.operation === "stop");
    assert.equal(stopped.handle.sourceHash, recovered.request.sourceHash);
    assert.equal(stopped.handle.generatorId, recovered.request.generatorId);
    cleanupAfterEveryRegisteredPhase(events);
  });

  it("bounds recovery and cleanup retries without spawning a second remote worker", async () => {
    const events = [];
    let recoveryAttempts = 0;
    let cleanupAttempts = 0;
    const supervisor = createSupervisor({
      events,
      recover: ({ phase, request: boundRequest }) => {
        recoveryAttempts += 1;
        if (recoveryAttempts < 3) throw Object.assign(new Error("SSH still unavailable"), { code: "SSH_LOST" });
        return { handle: phaseHandle(boundRequest, phase) };
      },
      awaitPhase: ({ phase }) => {
        if (phase === "headless-preparation") throw new Error("remote await failed after recovery");
        throw new Error("unreachable");
      },
      stop: () => {
        cleanupAttempts += 1;
        return cleanupAttempts === 1 ? { ok: false } : { ok: true };
      },
      assertStopped: () => cleanupAttempts === 1 ? { ok: false } : { ok: true },
    });
    supervisor.start = async ({ phase, request: boundRequest, timeoutMs }) => {
      events.push({ operation: "start", phase, request: boundRequest, timeoutMs });
      throw Object.assign(new Error("lost start response"), { code: "SSH_LOST" });
    };

    await assert.rejects(runRemote({ remoteSupervisor: supervisor }), /remote await failed after recovery/u);

    assert.deepEqual(lifecycle(events), [
      "start:headless-preparation",
      "recover:headless-preparation",
      "recover:headless-preparation",
      "recover:headless-preparation",
      "await:headless-preparation",
      "stop:headless-preparation",
      "assertStopped:headless-preparation",
      "stop:headless-preparation",
      "assertStopped:headless-preparation",
    ]);
    assert.equal(events.filter((entry) => entry.operation === "start").length, 1);
  });

  it("bounds sustained transport loss and relies on the remote watchdog rather than inventing a handle", async () => {
    const events = [];
    const supervisor = createSupervisor({
      events,
      recover: () => { throw Object.assign(new Error("SSH remains unavailable"), { code: "SSH_LOST" }); },
    });
    supervisor.start = async ({ phase, request: boundRequest, timeoutMs }) => {
      events.push({ operation: "start", phase, request: boundRequest, timeoutMs });
      throw Object.assign(new Error("SSH dropped during registered start"), { code: "SSH_LOST" });
    };

    await assert.rejects(runRemote({ remoteSupervisor: supervisor }), AggregateError);

    assert.deepEqual(lifecycle(events), [
      "start:headless-preparation",
      "recover:headless-preparation",
      "recover:headless-preparation",
      "recover:headless-preparation",
      "recover:headless-preparation",
      "recover:headless-preparation",
      "recover:headless-preparation",
    ]);
    assert.equal(events.filter((entry) => entry.operation === "start").length, 1);
    assert.equal(events.some((entry) => entry.operation === "stop" || entry.operation === "assertStopped"), false);
  });


  it("does not settle launch success until stop and remote absence assertion have completed", async () => {
    const releaseAssertion = deferred();
    const events = [];
    const boundRequest = request();
    const supervisor = createSupervisor({
      events,
      assertStopped: async () => await releaseAssertion.promise,
    });
    let settled = false;
    const launched = launchPreparedMacPlayerGenerator({
      host: HOST,
      request: boundRequest,
      preflight: preflight(),
      headlessPrep: passingPreparation(),
      endpointProbe: passingProbe(),
      remoteSupervisor: supervisor,
    }).then((value) => { settled = true; return value; });

    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(lifecycle(events), ["start:generator", "await:generator", "stop:generator", "assertStopped:generator"]);
    assert.equal(settled, false);
    releaseAssertion.resolve({ ok: true });
    const result = await launched;
    assert.equal(result.result.status, "pass");
    assert.equal(settled, true);
  });

  it("aggregates primary phase failures with stop/assert failures while still attempting both cleanup operations", async () => {
    const events = [];
    const supervisor = createSupervisor({
      events,
      awaitPhase: ({ request: boundRequest, phase }) => phase === "generator"
        ? { envelope: phaseEnvelope(boundRequest, phase, { stdout: "not-json" }) }
        : { envelope: phaseEnvelope(boundRequest, phase) },
      stop: ({ phase }) => {
        if (phase === "generator") throw new Error("TERM ignored by worker group");
        return { ok: true };
      },
      assertStopped: ({ phase }) => phase === "generator"
        ? { ok: false }
        : { ok: true },
    });

    await assert.rejects(
      runRemote({ remoteSupervisor: supervisor }),
      (error) => error instanceof AggregateError
        && error.errors.some((item) => item?.code === "INVALID_REMOTE_GENERATOR_RESULT")
        && error.errors.some((item) => item?.code === "REMOTE_GENERATOR_TEARDOWN_FAILED"),
    );
    const generatorOperations = events.filter((entry) => entry.phase === "generator").map((entry) => entry.operation);
    assert.deepEqual(generatorOperations, ["start", "await", "stop", "assertStopped", "stop", "assertStopped", "stop", "assertStopped"]);
  });

  it("retains a bounded redacted remote endpoint error message in await diagnostics", async () => {
    const events = [];
    const secretFragment = "must-not-leak";
    const remoteMessage = `token=${secretFragment.repeat(200)}\npersisted handle cleanup proof is unavailable`;
    assert.ok(remoteMessage.length > 1024, "credential value must cross the retained suffix boundary");
    const supervisor = createSupervisor({
      events,
      awaitPhase: ({ request: boundRequest, phase }) => phase === "generator"
        ? { status: "error", error: { code: "HANDLE_PERSIST_FAILED", message: remoteMessage } }
        : { envelope: phaseEnvelope(boundRequest, phase) },
    });

    await assert.rejects(
      runRemote({ remoteSupervisor: supervisor }),
      (error) => error?.code === "REMOTE_PROCESS_AWAIT_FAILED"
        && error.details.remote.errorCode === "HANDLE_PERSIST_FAILED"
        && error.details.remote.errorMessage.includes("token=[redacted]")
        && !error.details.remote.errorMessage.includes(secretFragment)
        && error.details.remote.errorMessage.endsWith("persisted handle cleanup proof is unavailable")
        && error.details.remote.errorMessage.length <= 1024,
    );
    cleanupAfterEveryRegisteredPhase(events);
  });

  it("recovers a canonical handle after rejecting an untrusted start response", async () => {
    const handleEvents = [];
    const wrongHandleSupervisor = createSupervisor({ events: handleEvents });
    wrongHandleSupervisor.start = async ({ phase, request: boundRequest }) => ({
      handle: { ...phaseHandle(boundRequest, phase), requestHash: "b".repeat(64) },
    });
    const output = await runRemote({ remoteSupervisor: wrongHandleSupervisor });
    assert.equal(output.result.status, "pass");
    assert.deepEqual(lifecycle(handleEvents).slice(0, 4), ["recover:headless-preparation", "await:headless-preparation", "stop:headless-preparation", "assertStopped:headless-preparation"]);
    cleanupAfterEveryRegisteredPhase(handleEvents);

    const envelopeEvents = [];
    const wrongEnvelopeSupervisor = createSupervisor({
      events: envelopeEvents,
      awaitPhase: ({ request: boundRequest, phase }) => ({
        envelope: phaseEnvelope(boundRequest, phase, { requestHash: "b".repeat(64) }),
      }),
    });
    await assert.rejects(
      runRemote({ remoteSupervisor: wrongEnvelopeSupervisor }),
      (error) => error?.code === "INVALID_REMOTE_PHASE_ENVELOPE",
    );
    cleanupAfterEveryRegisteredPhase(envelopeEvents);
  });

  it("rejects a checksum-valid generator result rebound to another request source", async () => {
    const events = [];
    const supervisor = createSupervisor({
      events,
      awaitPhase: ({ request: boundRequest, phase }) => phase === "generator"
        ? { envelope: phaseEnvelope(boundRequest, phase, { stdout: JSON.stringify(passingResult(boundRequest, { sourceHash: "b".repeat(64) })) }) }
        : { envelope: phaseEnvelope(boundRequest, phase) },
    });

    await assert.rejects(
      runRemote({ remoteSupervisor: supervisor }),
      (error) => error?.code === "REMOTE_GENERATOR_BINDING_MISMATCH",
    );
    cleanupAfterEveryRegisteredPhase(events);
  });

  it("retains strict endpoint, source, and client-count request validation", () => {
    for (const endpoint of ["http://localhost:28093", "http://127.0.0.1:28093", "http://user:secret@100.101.102.103:28093"]) {
      assert.throws(
        () => request({ endpoint }),
        (error) => error?.code === "INVALID_REMOTE_ENDPOINT",
      );
    }
    assert.throws(
      () => request({ clients: MAX_REMOTE_PLAYER_CLIENTS + 1 }),
      (error) => error?.code === "REMOTE_CLIENT_LIMIT",
    );
  });
});
