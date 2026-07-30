import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { afterEach, describe, it } from "node:test";

import {
  REMOTE_PROCESS_HOST_REQUEST_SCHEMA,
  handleRemoteProcessHostRequest,
} from "./remote-process-host.mjs";
import { createRemotePlayerGeneratorRequest } from "../load/remote-generator.mjs";
import { sha256Json } from "./protocol.mjs";
import { createProcessHost } from "../lib/process-host.mjs";

const SOURCE_HASH = "a".repeat(64);
const ENDPOINT = "http://100.101.102.103:28093";
const temporaryRoots = [];

function request() {
  return createRemotePlayerGeneratorRequest({
    endpoint: ENDPOINT,
    clients: 1,
    durationMs: 1_000,
    rampIntervalMs: 100,
    sampleIntervalMs: 100,
    runId: "remote-supervisor-test",
    sourceHash: SOURCE_HASH,
    sourcePaths: ["fixture.txt"],
    generatorId: "mac",
  });
}

function protocol({ operation, phase = "generator", handle, ...extra }) {
  return {
    schema: REMOTE_PROCESS_HOST_REQUEST_SCHEMA,
    operation,
    phase,
    request: request(),
    ...(handle ? { handle } : {}),
    ...extra,
  };
}

async function runRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "successor-remote-process-host-"));
  temporaryRoots.push(root);
  return root;
}

const RUNTIME_ENV_KEYS = [
  "SUCCESSOR_PROCESS_HOST",
  "SUCCESSOR_REMOTE_PROCESS_TEST_HOOK_DIR",
  "SUCCESSOR_REMOTE_PROCESS_TEST_DEADLINE_MS",
  "SUCCESSOR_REMOTE_PROCESS_TEST_PAUSE_BEFORE_RELEASE_FILE",
  "SUCCESSOR_TEST_WORKLOAD_MARKER",
  "SUCCESSOR_REMOTE_PROCESS_TEST_FORCE_PS_FAILURE",
  "SUCCESSOR_PROCESS_HOST_TEST_PS_MALFORMED",
];

async function withRuntimeEnvironment(values, work) {
  const previous = new Map(RUNTIME_ENV_KEYS.map((key) => [key, process.env[key]]));
  try {
    for (const key of RUNTIME_ENV_KEYS) {
      if (values[key] === undefined) delete process.env[key];
      else process.env[key] = values[key];
    }
    return await work();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function runtimePaths(root, boundRequest = request(), phase = "headless-preparation") {
  const requestHash = sha256Json(boundRequest);
  const runDir = path.join(root, boundRequest.runId, boundRequest.generatorId);
  const phaseDir = path.join(runDir, "phases", phase, requestHash);
  const workerName = `phase-${phase}-${requestHash}`;
  return {
    requestHash,
    runDir,
    phaseDir,
    workerName,
    watchdogName: `watchdog-${workerName}`,
    workerPidfile: path.join(runDir, "pids", `${workerName}.pid`),
    watchdogPidfile: path.join(runDir, "pids", `watchdog-${workerName}.pid`),
    sentinelAuditPath: path.join(phaseDir, "sentinel-audit.ndjson"),
    registrationPath: path.join(phaseDir, "registration.json"),
    sentinelPath: path.join(phaseDir, "sentinel.json"),
  };
}

async function installPhaseFixture(root, { persistent = false, exitAfterSpawn = false } = {}) {
  const modulePath = path.join(root, "tools", "verification", "load", "headless-prep.mjs");
  await fs.mkdir(path.dirname(modulePath), { recursive: true });
  const source = persistent || exitAfterSpawn
    ? `import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const descendant = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"], { stdio: "ignore" });
writeFileSync(process.env.SUCCESSOR_TEST_WORKLOAD_MARKER, JSON.stringify({ pid: process.pid, descendantPid: descendant.pid }));
${exitAfterSpawn ? "process.exit(0);" : "process.on(\"SIGTERM\", () => {}); setInterval(() => {}, 1000);"}
`
    : `import { writeFileSync } from "node:fs";
if (process.env.SUCCESSOR_TEST_WORKLOAD_MARKER) writeFileSync(process.env.SUCCESSOR_TEST_WORKLOAD_MARKER, JSON.stringify({ pid: process.pid }));
process.stdout.write("{}\\n");
`;
  await fs.writeFile(modulePath, source, "utf8");
}

function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function isGroupAlive(pgid) {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

async function eventually(predicate, message, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  do {
    try {
      const value = await predicate();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  } while (Date.now() <= deadline);
  throw new Error(`${message}${lastError ? `: ${lastError.message}` : ""}`);
}

async function readHook(hookDir, name) {
  return JSON.parse(await fs.readFile(path.join(hookDir, `${name}.json`), "utf8"));
}

async function readSentinelAudit(paths) {
  const text = await fs.readFile(paths.sentinelAuditPath, "utf8").catch((error) => error?.code === "ENOENT" ? "" : Promise.reject(error));
  return text.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function startExternalProtocol(root, rawRequest, environment) {
  const driverPath = path.join(root, "protocol-driver.mjs");
  const requestPath = path.join(root, "protocol-request.json");
  const remoteModule = path.join(import.meta.dirname, "remote-process-host.mjs");
  const driver = `import fs from "node:fs/promises";
import { handleRemoteProcessHostRequest } from ${JSON.stringify(remoteModule)};
const request = JSON.parse(await fs.readFile(process.env.SUCCESSOR_TEST_PROTOCOL_REQUEST_PATH, "utf8"));
const response = await handleRemoteProcessHostRequest(request, { root: process.env.SUCCESSOR_TEST_PROTOCOL_ROOT, runRoot: process.env.SUCCESSOR_TEST_PROTOCOL_RUN_ROOT });
process.stdout.write(JSON.stringify(response));
`;
  return Promise.all([
    fs.writeFile(driverPath, driver, "utf8"),
    fs.writeFile(requestPath, JSON.stringify(rawRequest), "utf8"),
  ]).then(() => spawn(process.execPath, [driverPath], {
    cwd: root,
    env: {
      ...process.env,
      ...environment,
      SUCCESSOR_PROCESS_HOST: "child",
      SUCCESSOR_TEST_PROTOCOL_REQUEST_PATH: requestPath,
      SUCCESSOR_TEST_PROTOCOL_ROOT: root,
      SUCCESSOR_TEST_PROTOCOL_RUN_ROOT: root,
    },
    stdio: ["ignore", "pipe", "pipe"],
  }));
}

async function waitForChildExit(child, timeoutMs = 5_000) {
  return await Promise.race([
    new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal }))),
    new Promise((_, reject) => setTimeout(() => reject(new Error(`protocol subprocess ${child.pid} did not exit`)), timeoutMs)),
  ]);
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

function fakeHost(events, {
  state = fakeState(events),
  stop = () => ({ ok: true, finalState: "stopped", failures: [] }),
  assertStopped = () => ({ ok: true, finalState: "stopped", failures: [] }),
  observeStopped = () => ({ ok: true, finalState: "stopped", failures: [] }),
  recover,
} = {}) {
  return {
    kind: "child",
    start: async ({ name, ...options }) => {
      const environment = options.env;
      const handle = {
        name,
        pid: 4242 + state.size,
        logPath: path.join(environment.SUCCESSOR_REMOTE_PROCESS_RUN_ROOT, environment.SUCCESSOR_REMOTE_PROCESS_RUN_ID, environment.SUCCESSOR_REMOTE_PROCESS_GENERATOR_ID, "logs", `${name}.log`),
      };
      state.set(name, { handle, birthToken: `birth-${handle.pid}`, active: true });
      if (name.startsWith("phase-")) {
        const phaseDir = path.join(
          environment.SUCCESSOR_REMOTE_PROCESS_RUN_ROOT,
          environment.SUCCESSOR_REMOTE_PROCESS_RUN_ID,
          environment.SUCCESSOR_REMOTE_PROCESS_GENERATOR_ID,
          "phases",
          environment.SUCCESSOR_REMOTE_PROCESS_PHASE,
          environment.SUCCESSOR_REMOTE_PROCESS_REQUEST_HASH,
        );
        const registration = JSON.parse(await fs.readFile(path.join(phaseDir, "registration.json"), "utf8"));
        await fs.writeFile(path.join(phaseDir, "sentinel.json"), JSON.stringify({
          schema: "successor.remote-process-host-sentinel.v1",
          runId: environment.SUCCESSOR_REMOTE_PROCESS_RUN_ID,
          sourceHash: environment.SUCCESSOR_REMOTE_PROCESS_SOURCE_HASH,
          generatorId: environment.SUCCESSOR_REMOTE_PROCESS_GENERATOR_ID,
          phase: environment.SUCCESSOR_REMOTE_PROCESS_PHASE,
          requestHash: environment.SUCCESSOR_REMOTE_PROCESS_REQUEST_HASH,
          nonce: registration.gateNonce,
          pid: handle.pid + 1,
          pgid: handle.pid,
          birthToken: `birth-${handle.pid + 1}`,
          heartbeatAt: Date.now(),
        }), "utf8");
      }
      events.push(`start:${name}`);
      events.push({ operation: "start", name, options });
      return handle;
    },
    recover: async (name) => {
      events.push(`recover:${name}`);
      if (recover) return recover(name, state);
      const record = state.get(name);
      return record?.active === true
        ? { handle: record.handle, birthToken: record.birthToken, active: true }
        : record
          ? { handle: record.handle, birthToken: record.birthToken, active: false, reason: "expired" }
          : { active: false, reason: "missing" };
    },
    stop: async (handle, options) => {
      events.push(`stop:${handle.name}:${options.graceMs}`);
      const record = state.get(handle.name);
      if (record) record.active = false;
      return stop(handle, options);
    },
    assertStopped: async (handle, options) => {
      events.push(`assert:${handle.name}:${options.timeoutMs}`);
      return assertStopped(handle, options);
    },
    observeStopped: async (handle, options) => {
      events.push(`observe:${handle.name}:${options.timeoutMs}`);
      return observeStopped(handle, options);
    },
  };
}

const fakeStates = new WeakMap();

function fakeState(events) {
  let state = fakeStates.get(events);
  if (!state) {
    state = new Map();
    fakeStates.set(events, state);
  }
  return state;
}

function eventStrings(events) {
  return events.filter((entry) => typeof entry === "string");
}

describe("remote ProcessHost request binding and lifecycle", () => {
  it("registers a watchdog before its worker and stops/asserts both authoritative handles", async () => {
    const events = [];
    const root = await runRoot();
    const processHostFactory = () => fakeHost(events);
    const started = await handleRemoteProcessHostRequest(
      protocol({ operation: "start" }),
      { root, runRoot: root, processHostFactory },
    );

    assert.equal(started.status, "ok");
    assert.equal(started.handle.runId, "remote-supervisor-test");
    assert.equal(started.handle.sourceHash, SOURCE_HASH);
    assert.equal(started.handle.generatorId, "mac");
    assert.equal(started.handle.phase, "generator");
    assert.equal(started.handle.pid, 4243);
    const workerName = started.handle.name;
    const watchdogName = `watchdog-${workerName}`;
    assert.deepEqual(eventStrings(events).slice(0, 2), [`start:${watchdogName}`, `start:${workerName}`]);
    const startedOptions = events.filter((entry) => entry?.operation === "start");
    assert.equal(startedOptions[0].options.persist, true);
    assert.equal(startedOptions[1].options.persist, true);

    const stopped = await handleRemoteProcessHostRequest(
      protocol({ operation: "stop", handle: started.handle, graceMs: 17 }),
      { root, runRoot: root, processHostFactory },
    );
    const asserted = await handleRemoteProcessHostRequest(
      protocol({ operation: "assertStopped", handle: started.handle, timeoutMs: 23 }),
      { root, runRoot: root, processHostFactory },
    );

    assert.equal(stopped.status, "ok");
    assert.equal(asserted.status, "ok");
    assert.equal(stopped.lifecycle.ok, true);
    assert.equal(stopped.watchdogLifecycle.ok, true);
    assert.equal(asserted.lifecycle.ok, true);
    assert.equal(asserted.watchdogLifecycle.ok, true);
    const strings = eventStrings(events);
    assert.equal(strings.includes(`stop:${workerName}:17`), false, "a non-live worker group must not reach generic ProcessHost.stop");
    assert.ok(strings.includes(`assert:${workerName}:23`), `assertStopped must reach ${workerName}`);
    assert.ok(strings.includes(`stop:${watchdogName}:17`), `stop must reach ${watchdogName}`);
    assert.ok(strings.includes(`assert:${watchdogName}:23`), `assertStopped must reach ${watchdogName}`);
  });

  it("recovers from ProcessHost state after the public handle cache is lost", async () => {
    const events = [];
    const root = await runRoot();
    const processHostFactory = () => fakeHost(events);
    const started = await handleRemoteProcessHostRequest(protocol({ operation: "start" }), { root, runRoot: root, processHostFactory });
    const requestHash = sha256Json(request());
    const phaseDir = path.join(root, "remote-supervisor-test", "mac", "phases", "generator", requestHash);
    const registration = JSON.parse(await fs.readFile(path.join(phaseDir, "registration.json"), "utf8"));
    assert.deepEqual(
      {
        schema: registration.schema,
        runId: registration.runId,
        sourceHash: registration.sourceHash,
        generatorId: registration.generatorId,
        phase: registration.phase,
        requestHash: registration.requestHash,
        workerName: registration.workerName,
        watchdogName: registration.watchdogName,
      },
      {
        schema: "successor.remote-process-host-registration.v2",
        runId: started.handle.runId,
        sourceHash: started.handle.sourceHash,
        generatorId: started.handle.generatorId,
        phase: started.handle.phase,
        requestHash: started.handle.requestHash,
        workerName: started.handle.name,
        watchdogName: `watchdog-${started.handle.name}`,
      },
    );
    await fs.rm(path.join(phaseDir, "handle.json"));

    const recovered = await handleRemoteProcessHostRequest(protocol({ operation: "recover" }), { root, runRoot: root, processHostFactory });

    assert.equal(recovered.status, "ok", JSON.stringify(recovered));
    assert.deepEqual(recovered.handle, started.handle);
    assert.deepEqual(eventStrings(events).filter((entry) => entry.startsWith("recover:")), [
      `recover:${started.handle.name}`,
      `recover:watchdog-${started.handle.name}`,
    ]);
  });

  it("refuses a handle rebound to a different request before it can reach the host", async () => {
    const events = [];
    const root = await runRoot();
    const processHostFactory = () => fakeHost(events);
    const started = await handleRemoteProcessHostRequest(protocol({ operation: "start" }), { root, runRoot: root, processHostFactory });
    const tampered = { ...started.handle, sourceHash: "b".repeat(64) };

    const response = await handleRemoteProcessHostRequest(
      protocol({ operation: "stop", handle: tampered }),
      { root, runRoot: root, processHostFactory },
    );

    assert.equal(response.status, "error");
    assert.equal(response.error.code, "INVALID_HANDLE");
    assert.equal(eventStrings(events).some((entry) => entry.startsWith("recover:") || entry.startsWith("stop:") || entry.startsWith("assert:")), false);
  });

  it("rejects stale ProcessHost identity or rebound registration before lifecycle operations", async () => {
    const cases = [
      {
        label: "reused pid/birth identity",
        mutate: async ({ state, workerName }) => state.set(workerName, { active: false, reason: "pid-reused" }),
        code: "PROCESS_HOST_RECOVERY_INVALID",
      },
      {
        label: "rebound request registration",
        mutate: async ({ registrationPath }) => {
          const registration = JSON.parse(await fs.readFile(registrationPath, "utf8"));
          registration.sourceHash = "b".repeat(64);
          await fs.writeFile(registrationPath, JSON.stringify(registration), "utf8");
        },
        code: "INVALID_PHASE_REGISTRATION",
      },
    ];
    for (const testCase of cases) {
      const events = [];
      const state = new Map();
      const root = await runRoot();
      const processHostFactory = () => fakeHost(events, { state });
      const started = await handleRemoteProcessHostRequest(protocol({ operation: "start" }), { root, runRoot: root, processHostFactory });
      const registrationPath = path.join(root, "remote-supervisor-test", "mac", "phases", "generator", sha256Json(request()), "registration.json");
      await testCase.mutate({ state, workerName: started.handle.name, registrationPath });

      const recovered = await handleRemoteProcessHostRequest(protocol({ operation: "recover" }), { root, runRoot: root, processHostFactory });

      assert.equal(recovered.status, "error", testCase.label);
      assert.equal(recovered.error.code, testCase.code, testCase.label);
      assert.equal(eventStrings(events).some((entry) => entry.startsWith("stop:") || entry.startsWith("assert:")), false, testCase.label);
    }
  });

  // These cases use a real child ProcessHost and real protocol subprocesses.
  // The older fake-host cases above only cover response shaping; every crash
  // assertion below owns and proves actual local PID/PGID cleanup in its temp run.
  it("keeps real pidfiles through await, then stop/assert cleanly and idempotently remove both phase handles", async () => {
    const root = await runRoot();
    const hookDir = path.join(root, "hooks");
    const workloadMarker = path.join(root, "workload.json");
    await installPhaseFixture(root);
    await withRuntimeEnvironment({
      SUCCESSOR_PROCESS_HOST: "child",
      SUCCESSOR_REMOTE_PROCESS_TEST_HOOK_DIR: hookDir,
      SUCCESSOR_TEST_WORKLOAD_MARKER: workloadMarker,
    }, async () => {
      const started = await handleRemoteProcessHostRequest(protocol({ operation: "start", phase: "headless-preparation" }), { root, runRoot: root });
      assert.equal(started.status, "ok");
      const paths = runtimePaths(root);
      const registration = JSON.parse(await fs.readFile(paths.registrationPath, "utf8"));
      assert.equal(registration.state, "released");
      assert.match(registration.gateNonce, /^[a-f0-9]{64}$/u);
      assert.deepEqual(registration.worker, { name: started.handle.name, pid: started.handle.pid, logPath: path.join(paths.runDir, "logs", `${started.handle.name}.log`) });
      await eventually(() => readHook(hookDir, "workload-spawned"), "fixed workload never spawned after release");

      const awaited = await handleRemoteProcessHostRequest(protocol({ operation: "await", phase: "headless-preparation", handle: started.handle, timeoutMs: 5_000 }), { root, runRoot: root });
      assert.equal(awaited.status, "ok", JSON.stringify(awaited));
      assert.equal(await fs.stat(paths.workerPidfile).then(() => true), true, "await must retain the worker pidfile for mandatory cleanup");
      assert.equal(await fs.stat(paths.watchdogPidfile).then(() => true), true, "await must retain the watchdog pidfile for mandatory cleanup");

      const stopped = await handleRemoteProcessHostRequest(protocol({ operation: "stop", phase: "headless-preparation", handle: started.handle, graceMs: 20 }), { root, runRoot: root });
      const asserted = await handleRemoteProcessHostRequest(protocol({ operation: "assertStopped", phase: "headless-preparation", handle: started.handle, timeoutMs: 1_000 }), { root, runRoot: root });
      const stoppedAgain = await handleRemoteProcessHostRequest(protocol({ operation: "stop", phase: "headless-preparation", handle: started.handle, graceMs: 20 }), { root, runRoot: root });
      const assertedAgain = await handleRemoteProcessHostRequest(protocol({ operation: "assertStopped", phase: "headless-preparation", handle: started.handle, timeoutMs: 1_000 }), { root, runRoot: root });
      for (const response of [stopped, asserted, stoppedAgain, assertedAgain]) assert.equal(response.status, "ok");
      assert.equal(isPidAlive(registration.worker.pid), false, "worker leader PID must be absent after cleanup");
      assert.equal(isPidAlive(registration.watchdog.pid), false, "watchdog PID must be absent after cleanup");
      assert.equal(isGroupAlive(registration.worker.pid), false, "worker process group must be absent after cleanup");
      await assert.rejects(fs.stat(paths.workerPidfile), { code: "ENOENT" });
      await assert.rejects(fs.stat(paths.watchdogPidfile), { code: "ENOENT" });
    });
  });

  it("kills an actual protocol caller at the pre-release barrier without ever starting fixed workload", async () => {
    const root = await runRoot();
    const hookDir = path.join(root, "hooks");
    const barrier = path.join(root, "release-barrier");
    const workloadMarker = path.join(root, "workload.json");
    await installPhaseFixture(root);
    const child = await startExternalProtocol(root, protocol({ operation: "start", phase: "headless-preparation" }), {
      SUCCESSOR_REMOTE_PROCESS_TEST_HOOK_DIR: hookDir,
      SUCCESSOR_REMOTE_PROCESS_TEST_PAUSE_BEFORE_RELEASE_FILE: barrier,
      SUCCESSOR_TEST_WORKLOAD_MARKER: workloadMarker,
      SUCCESSOR_REMOTE_PROCESS_TEST_DEADLINE_MS: "60000",
    });
    const paths = runtimePaths(root);
    try {
      await eventually(() => readHook(hookDir, "runner-gated"), "runner never reached the non-executable gate");
      await eventually(() => readHook(hookDir, "protocol-before-release"), "protocol never reached deterministic pre-release crash point");
      const registration = JSON.parse(await fs.readFile(paths.registrationPath, "utf8"));
      assert.equal(registration.state, "registered", "crash point must precede durable armed/released registration");
      await assert.rejects(fs.stat(workloadMarker), { code: "ENOENT" });
      process.kill(child.pid, "SIGKILL");
      await waitForChildExit(child);
      await assert.rejects(fs.stat(workloadMarker), { code: "ENOENT" });

      const host = createProcessHost({ runId: registration.processHostRunId, runDir: paths.runDir, kind: "child" });
      const recovered = await host.recover(paths.workerName);
      assert.equal(recovered.active, true, "crashed caller must leave only the gated worker to clean up");
      const stopped = await host.stop(recovered.handle, { graceMs: 20 });
      assert.equal(stopped.ok, true);
      assert.equal(isPidAlive(registration.worker.pid), false);
      assert.equal(isGroupAlive(registration.worker.pid), false);
    } finally {
      if (isPidAlive(child.pid)) process.kill(child.pid, "SIGKILL");
      await waitForChildExit(child).catch(() => undefined);
      const registration = await fs.readFile(paths.registrationPath, "utf8").then(JSON.parse).catch(() => null);
      if (registration?.worker) {
        const host = createProcessHost({ runId: registration.processHostRunId, runDir: paths.runDir, kind: "child" });
        await host.stop(registration.worker, { graceMs: 20 }).catch(() => undefined);
      }
    }
  });

  it("watchdog nonce proof reaps a released leaderless group with TERM-ignoring workload descendants", async () => {
    const root = await runRoot();
    const hookDir = path.join(root, "hooks");
    const workloadMarker = path.join(root, "workload.json");
    await installPhaseFixture(root, { persistent: true });
    await withRuntimeEnvironment({
      SUCCESSOR_PROCESS_HOST: "child",
      SUCCESSOR_REMOTE_PROCESS_TEST_HOOK_DIR: hookDir,
      SUCCESSOR_REMOTE_PROCESS_TEST_DEADLINE_MS: "1500",
      SUCCESSOR_TEST_WORKLOAD_MARKER: workloadMarker,
    }, async () => {
      const started = await handleRemoteProcessHostRequest(protocol({ operation: "start", phase: "headless-preparation" }), { root, runRoot: root });
      assert.equal(started.status, "ok");
      const paths = runtimePaths(root);
      const registration = JSON.parse(await fs.readFile(paths.registrationPath, "utf8"));
      const workload = await eventually(() => fs.readFile(workloadMarker, "utf8").then(JSON.parse), "released workload did not report its inherited descendant");
      assert.equal(isPidAlive(workload.pid), true);
      assert.equal(isPidAlive(workload.descendantPid), true);
      process.kill(registration.worker.pid, "SIGKILL");
      await eventually(() => readHook(hookDir, "watchdog-reap-finished"), "watchdog did not attempt nonce-authorized leaderless-group cleanup", 8_000);
      await eventually(() => !isPidAlive(workload.pid), "TERM-ignoring workload leader remained after watchdog escalation");
      await eventually(() => !isPidAlive(workload.descendantPid), "TERM-ignoring inherited descendant remained after watchdog escalation");
      await eventually(() => !isGroupAlive(registration.worker.pid), "leaderless worker PGID remained after watchdog cleanup");
      const host = createProcessHost({ runId: registration.processHostRunId, runDir: paths.runDir, kind: "child" });
      assert.equal((await host.assertStopped(registration.worker, { timeoutMs: 1_000 })).ok, true);
      assert.equal((await host.assertStopped(registration.watchdog, { timeoutMs: 1_000 })).ok, true);
    });
  });

  it("expires a real released phase with no caller and proves PID/PGID absence after watchdog cleanup", async () => {
    const root = await runRoot();
    const hookDir = path.join(root, "hooks");
    const workloadMarker = path.join(root, "workload.json");
    await installPhaseFixture(root, { persistent: true });
    await withRuntimeEnvironment({
      SUCCESSOR_PROCESS_HOST: "child",
      SUCCESSOR_REMOTE_PROCESS_TEST_HOOK_DIR: hookDir,
      SUCCESSOR_REMOTE_PROCESS_TEST_DEADLINE_MS: "1200",
      SUCCESSOR_TEST_WORKLOAD_MARKER: workloadMarker,
    }, async () => {
      const started = await handleRemoteProcessHostRequest(protocol({ operation: "start", phase: "headless-preparation" }), { root, runRoot: root });
      assert.equal(started.status, "ok");
      const paths = runtimePaths(root);
      const registration = JSON.parse(await fs.readFile(paths.registrationPath, "utf8"));
      const workload = await eventually(() => fs.readFile(workloadMarker, "utf8").then(JSON.parse), "workload did not begin before no-caller expiry test");
      await eventually(() => readHook(hookDir, "watchdog-reap-finished"), "watchdog did not self-expire abandoned phase", 8_000);
      await eventually(() => !isPidAlive(workload.pid), "no-caller workload leader remained after watchdog expiry");
      await eventually(() => !isPidAlive(workload.descendantPid), "no-caller inherited descendant remained after watchdog expiry");
      await eventually(() => !isGroupAlive(registration.worker.pid), "no-caller worker PGID remained after watchdog expiry");
      const host = createProcessHost({ runId: registration.processHostRunId, runDir: paths.runDir, kind: "child" });
      assert.equal((await host.assertStopped(registration.worker, { timeoutMs: 1_000 })).ok, true);
      assert.equal((await host.assertStopped(registration.watchdog, { timeoutMs: 1_000 })).ok, true);
    });
  });
  it("refuses stale heartbeats, wrong nonces, and reused PID/PGID records without signaling an unrelated controlled group", async () => {
    const variants = ["stale-heartbeat", "wrong-nonce", "reused-pid-pgid"];
    for (const variant of variants) {
      const root = await runRoot();
      const hookDir = path.join(root, "hooks");
      const workloadMarker = path.join(root, "workload.json");
      const foreignRoot = path.join(root, "foreign");
      await installPhaseFixture(root, { persistent: true });
      await withRuntimeEnvironment({
        SUCCESSOR_PROCESS_HOST: "child",
        SUCCESSOR_REMOTE_PROCESS_TEST_HOOK_DIR: hookDir,
        SUCCESSOR_REMOTE_PROCESS_TEST_DEADLINE_MS: "1500",
        SUCCESSOR_TEST_WORKLOAD_MARKER: workloadMarker,
      }, async () => {
        const started = await handleRemoteProcessHostRequest(protocol({ operation: "start", phase: "headless-preparation" }), { root, runRoot: root });
        assert.equal(started.status, "ok", variant);
        const paths = runtimePaths(root);
        const original = JSON.parse(await fs.readFile(paths.registrationPath, "utf8"));
        const foreignHost = createProcessHost({ runId: `foreign-${variant}`, runDir: foreignRoot, kind: "child" });
        const foreign = await foreignHost.start({
          name: "unrelated-controlled-group",
          argv: [process.execPath, "-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"],
          persist: true,
        });
        try {
          const tampered = structuredClone(original);
          const sentinel = JSON.parse(await fs.readFile(paths.sentinelPath, "utf8"));
          if (variant === "stale-heartbeat") {
            sentinel.heartbeatAt = Date.now() - 60_000;
          } else if (variant === "wrong-nonce") {
            sentinel.nonce = "f".repeat(64);
          } else {
            tampered.worker.pid = foreign.pid;
            tampered.sentinel.pid = foreign.pid;
            tampered.sentinel.pgid = foreign.pid;
            tampered.sentinel.birthToken = "ps:reused-pid";
            sentinel.pid = foreign.pid;
            sentinel.pgid = foreign.pid;
            sentinel.birthToken = "ps:reused-pid";
          }
          await fs.writeFile(paths.registrationPath, JSON.stringify(tampered), "utf8");
          await fs.writeFile(paths.sentinelPath, JSON.stringify(sentinel), "utf8");
          const phaseHost = createProcessHost({ runId: original.processHostRunId, runDir: paths.runDir, kind: "child" });
          await phaseHost.observeStopped(original.watchdog, { timeoutMs: 8_000 });
          assert.equal(isPidAlive(foreign.pid), true, `${variant} must not authorize a signal to an unrelated controlled PID`);
          assert.equal(isGroupAlive(foreign.pid), true, `${variant} must not authorize a signal to an unrelated controlled PGID`);
          await phaseHost.stop(original.worker, { graceMs: 20 });
          await phaseHost.assertStopped(original.worker, { timeoutMs: 1_000 });
        } finally {
          await foreignHost.stop(foreign, { graceMs: 20 }).catch(() => undefined);
          await foreignHost.assertStopped(foreign, { timeoutMs: 1_000 }).catch(() => undefined);
        }
      });
    }
  });
  it("requires a fresh live sentinel challenge before stop reaps the original leaderless group", async () => {
    const root = await runRoot();
    const hookDir = path.join(root, "hooks");
    const workloadMarker = path.join(root, "workload.json");
    await installPhaseFixture(root, { persistent: true });
    await withRuntimeEnvironment({
      SUCCESSOR_PROCESS_HOST: "child",
      SUCCESSOR_REMOTE_PROCESS_TEST_HOOK_DIR: hookDir,
      SUCCESSOR_REMOTE_PROCESS_TEST_DEADLINE_MS: "60000",
      SUCCESSOR_TEST_WORKLOAD_MARKER: workloadMarker,
    }, async () => {
      const started = await handleRemoteProcessHostRequest(protocol({ operation: "start", phase: "headless-preparation" }), { root, runRoot: root });
      assert.equal(started.status, "ok");
      const paths = runtimePaths(root);
      const registration = JSON.parse(await fs.readFile(paths.registrationPath, "utf8"));
      const workload = await eventually(() => fs.readFile(workloadMarker, "utf8").then(JSON.parse), "workload did not start for live challenge proof");
      process.kill(registration.worker.pid, "SIGKILL");
      const stopped = await handleRemoteProcessHostRequest(protocol({ operation: "stop", phase: "headless-preparation", handle: started.handle, graceMs: 20 }), { root, runRoot: root });
      assert.equal(stopped.status, "ok", JSON.stringify(stopped));
      const audit = await readSentinelAudit(paths);
      assert.deepEqual(audit.map((entry) => entry.signal).sort(), ["SIGKILL", "SIGTERM"]);
      assert.equal(new Set(audit.map((entry) => entry.challengeId)).size, 2, "each live cleanup signal must claim its own fresh challenge");
      const response = JSON.parse(await fs.readFile(path.join(paths.phaseDir, "sentinel-response.json"), "utf8"));
      assert.equal(response.challenge, audit.find((entry) => entry.signal === "SIGKILL").challengeId, "live sentinel must answer the exact final signal challenge");
      assert.ok(audit.every((entry) => entry.challengeId !== registration.gateNonce), "command challenge IDs must be distinct from the durable nonce");
      await eventually(() => !isPidAlive(workload.pid), "fresh live challenge did not authorize original group cleanup");
      await eventually(() => !isPidAlive(workload.descendantPid), "fresh live challenge did not authorize descendant cleanup");
      await eventually(() => !isGroupAlive(registration.worker.pid), "fresh live challenge did not clear original PGID");
    });
  });

  it("rejects a replayed dead-sentinel response before it can signal a reused unrelated PID/PGID", async () => {
    const root = await runRoot();
    const hookDir = path.join(root, "hooks");
    const workloadMarker = path.join(root, "workload.json");
    const foreignRoot = path.join(root, "foreign");
    await installPhaseFixture(root, { persistent: true });
    await withRuntimeEnvironment({
      SUCCESSOR_PROCESS_HOST: "child",
      SUCCESSOR_REMOTE_PROCESS_TEST_HOOK_DIR: hookDir,
      SUCCESSOR_REMOTE_PROCESS_TEST_DEADLINE_MS: "1800",
      SUCCESSOR_TEST_WORKLOAD_MARKER: workloadMarker,
    }, async () => {
      const started = await handleRemoteProcessHostRequest(protocol({ operation: "start", phase: "headless-preparation" }), { root, runRoot: root });
      assert.equal(started.status, "ok");
      const paths = runtimePaths(root);
      const original = JSON.parse(await fs.readFile(paths.registrationPath, "utf8"));
      await eventually(() => fs.readFile(workloadMarker, "utf8"), "workload did not start for replay proof");
      const oldChallenge = {
        schema: "successor.remote-process-host-sentinel-challenge.v1",
        runId: original.runId,
        sourceHash: original.sourceHash,
        generatorId: original.generatorId,
        phase: original.phase,
        requestHash: original.requestHash,
        nonce: original.gateNonce,
        challenge: "c".repeat(64),
        signal: "SIGTERM",
        requestedAt: Date.now() - 2_000,
        expiresAt: Date.now() - 1_000,
      };
      const replay = {
        schema: "successor.remote-process-host-sentinel-response.v1",
        runId: original.runId,
        sourceHash: original.sourceHash,
        generatorId: original.generatorId,
        phase: original.phase,
        requestHash: original.requestHash,
        nonce: original.gateNonce,
        challenge: oldChallenge.challenge,
        signal: oldChallenge.signal,
        requestedAt: oldChallenge.requestedAt,
        pid: original.sentinel.pid,
        pgid: original.sentinel.pgid,
        birthToken: original.sentinel.birthToken,
        respondedAt: oldChallenge.requestedAt,
      };
      const foreignHost = createProcessHost({ runId: "challenge-replay-foreign", runDir: foreignRoot, kind: "child" });
      const foreign = await foreignHost.start({
        name: "unrelated-reused-group",
        argv: [process.execPath, "-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"],
        persist: true,
      });
      try {
        process.kill(original.sentinel.pid, "SIGKILL");
        const tampered = structuredClone(original);
        tampered.worker.pid = foreign.pid;
        tampered.sentinel.pgid = foreign.pid;
        await fs.writeFile(paths.registrationPath, JSON.stringify(tampered), "utf8");
        await fs.writeFile(path.join(paths.phaseDir, "sentinel-response.json"), JSON.stringify(replay), "utf8");
        await eventually(() => readHook(hookDir, "watchdog-reap-finished"), "watchdog did not finish dead-sentinel replay refusal", 8_000);
        const freshChallenge = JSON.parse(await fs.readFile(path.join(paths.phaseDir, "sentinel-challenge.json"), "utf8"));
        assert.notEqual(freshChallenge.challenge, replay.challenge, "reaper must issue a fresh unpredictable challenge rather than accept replay evidence");
        await assert.rejects(fs.stat(path.join(paths.phaseDir, "sentinel-response.json")), { code: "ENOENT" });
        assert.equal(isPidAlive(foreign.pid), true, "dead-sentinel replay must not signal unrelated controlled PID");
        assert.equal(isGroupAlive(foreign.pid), true, "dead-sentinel replay must not signal unrelated controlled PGID");
        const phaseHost = createProcessHost({ runId: original.processHostRunId, runDir: paths.runDir, kind: "child" });
        await phaseHost.stop(original.worker, { graceMs: 20 });
      } finally {
        await foreignHost.stop(foreign, { graceMs: 20 }).catch(() => undefined);
        await foreignHost.assertStopped(foreign, { timeoutMs: 1_000 }).catch(() => undefined);
      }
    });
  });
  it("uses two distinct sentinel-originated signal challenges when a fixed child exits and leaves a TERM-ignoring descendant", async () => {
    const root = await runRoot();
    const hookDir = path.join(root, "hooks");
    const workloadMarker = path.join(root, "workload.json");
    await installPhaseFixture(root, { exitAfterSpawn: true });
    const supervisorSource = await fs.readFile(path.join(import.meta.dirname, "remote-process-host.mjs"), "utf8");
    assert.doesNotMatch(supervisorSource, /process\.kill\(\s*-\s*[^,]+,\s*["']SIG(?:TERM|KILL)["']/u, "caller/watchdog source must not contain an external negative-PGID signal path");
    await withRuntimeEnvironment({
      SUCCESSOR_PROCESS_HOST: "child",
      SUCCESSOR_REMOTE_PROCESS_TEST_HOOK_DIR: hookDir,
      SUCCESSOR_REMOTE_PROCESS_TEST_DEADLINE_MS: "60000",
      SUCCESSOR_TEST_WORKLOAD_MARKER: workloadMarker,
    }, async () => {
      const genericStops = [];
      const processHostFactory = ({ runId, runDir }) => {
        const host = createProcessHost({ runId, runDir, kind: "child" });
        return {
          ...host,
          stop: async (handle, options) => {
            genericStops.push(handle.name);
            return await host.stop(handle, options);
          },
        };
      };
      const started = await handleRemoteProcessHostRequest(protocol({ operation: "start", phase: "headless-preparation" }), { root, runRoot: root, processHostFactory });
      assert.equal(started.status, "ok");
      const paths = runtimePaths(root);
      const registration = JSON.parse(await fs.readFile(paths.registrationPath, "utf8"));
      const workload = await eventually(() => fs.readFile(workloadMarker, "utf8").then(JSON.parse), "fixed child never spawned inherited descendant");
      await eventually(() => !isPidAlive(registration.worker.pid), "phase runner leader did not exit after fixed child completed");
      assert.equal(isPidAlive(workload.descendantPid), true, "inherited TERM-ignoring descendant must outlive normal fixed-child exit");
      assert.equal(isPidAlive(registration.sentinel.pid), true, "sentinel must remain to self-signal its current group");

      const stopping = handleRemoteProcessHostRequest(protocol({ operation: "stop", phase: "headless-preparation", handle: started.handle, graceMs: 650 }), { root, runRoot: root, processHostFactory });
      const termAudit = await eventually(async () => (await readSentinelAudit(paths)).find((entry) => entry.signal === "SIGTERM") ?? null, "sentinel did not record its claimed TERM command");
      const termResponse = JSON.parse(await fs.readFile(path.join(paths.phaseDir, "sentinel-response.json"), "utf8"));
      const termHook = await readHook(hookDir, `sentinel-command-${termAudit.challengeId}`);
      assert.deepEqual(
        { signalerPid: termAudit.signalerPid, mode: termAudit.mode, signal: termAudit.signal, challengeId: termAudit.challengeId },
        { signalerPid: registration.sentinel.pid, mode: "in-group-sentinel", signal: "SIGTERM", challengeId: termResponse.challenge },
        "TERM audit must bind the registered sentinel to its one-shot fresh command",
      );
      assert.deepEqual(
        { signalerPid: termHook.signalerPid, mode: termHook.mode, signal: termHook.signal, challengeId: termHook.challengeId },
        { signalerPid: registration.sentinel.pid, mode: "in-group-sentinel", signal: "SIGTERM", challengeId: termAudit.challengeId },
      );
      await fs.stat(path.join(paths.phaseDir, termAudit.claim));

      const killAudit = await eventually(async () => (await readSentinelAudit(paths)).find((entry) => entry.signal === "SIGKILL") ?? null, "sentinel did not record its claimed KILL command after the long TERM grace");
      const killResponse = JSON.parse(await fs.readFile(path.join(paths.phaseDir, "sentinel-response.json"), "utf8"));
      const killHook = await readHook(hookDir, `sentinel-command-${killAudit.challengeId}`);
      assert.deepEqual(
        { signalerPid: killAudit.signalerPid, mode: killAudit.mode, signal: killAudit.signal, challengeId: killAudit.challengeId },
        { signalerPid: registration.sentinel.pid, mode: "in-group-sentinel", signal: "SIGKILL", challengeId: killResponse.challenge },
        "KILL audit must bind the registered sentinel to a second one-shot fresh command",
      );
      assert.deepEqual(
        { signalerPid: killHook.signalerPid, mode: killHook.mode, signal: killHook.signal, challengeId: killHook.challengeId },
        { signalerPid: registration.sentinel.pid, mode: "in-group-sentinel", signal: "SIGKILL", challengeId: killAudit.challengeId },
      );
      await fs.stat(path.join(paths.phaseDir, killAudit.claim));
      assert.notEqual(killAudit.challengeId, termAudit.challengeId, "TERM and KILL must use distinct challenge IDs");

      const stopped = await stopping;
      assert.equal(stopped.status, "ok", JSON.stringify(stopped));
      const audit = await readSentinelAudit(paths);
      assert.equal(audit.length, 2, "atomic challenge claim must yield exactly one execution audit per TERM/KILL command");
      assert.deepEqual(audit.map((entry) => entry.signal).sort(), ["SIGKILL", "SIGTERM"]);
      assert.equal(new Set(audit.map((entry) => entry.challengeId)).size, 2, "audit must not contain duplicate challenge execution");

      assert.equal(genericStops.includes(registration.worker.name), false, "live worker group must take sentinel self-signal path rather than generic ProcessHost.stop");
      await eventually(() => !isPidAlive(workload.descendantPid), "sentinel-issued KILL did not remove inherited descendant");
      await eventually(() => !isPidAlive(registration.sentinel.pid), "sentinel did not self-terminate after its SIGKILL command");
      await eventually(() => !isGroupAlive(registration.worker.pid), "phase PGID survived sentinel-originated TERM/KILL cleanup");
    });
  });
  it("treats phase-group ps observation failure as live and refuses cleanup when the sentinel proof is gone", async () => {
    const root = await runRoot();
    const hookDir = path.join(root, "hooks");
    const workloadMarker = path.join(root, "workload.json");
    await installPhaseFixture(root, { persistent: true });
    await withRuntimeEnvironment({
      SUCCESSOR_PROCESS_HOST: "child",
      SUCCESSOR_REMOTE_PROCESS_TEST_HOOK_DIR: hookDir,
      SUCCESSOR_REMOTE_PROCESS_TEST_DEADLINE_MS: "1800",
      SUCCESSOR_REMOTE_PROCESS_TEST_FORCE_PS_FAILURE: "1",
      SUCCESSOR_TEST_WORKLOAD_MARKER: workloadMarker,
    }, async () => {
      const started = await handleRemoteProcessHostRequest(protocol({ operation: "start", phase: "headless-preparation" }), { root, runRoot: root });
      assert.equal(started.status, "ok");
      const paths = runtimePaths(root);
      const registration = JSON.parse(await fs.readFile(paths.registrationPath, "utf8"));
      const workload = await eventually(() => fs.readFile(workloadMarker, "utf8").then(JSON.parse), "workload did not start before ps failure proof");
      process.kill(registration.sentinel.pid, "SIGKILL");
      await eventually(() => readHook(hookDir, "watchdog-reap-finished"), "watchdog did not finish fail-closed ps-observation path", 8_000);
      await assert.rejects(fs.stat(path.join(hookDir, "sentinel-command-SIGTERM.json")), { code: "ENOENT" });
      assert.equal(isPidAlive(workload.pid), true, "ps failure plus dead sentinel must not authorize a phase signal");
      assert.equal(isPidAlive(workload.descendantPid), true, "ps failure plus dead sentinel must preserve inherited descendant");
      const phaseHost = createProcessHost({ runId: registration.processHostRunId, runDir: paths.runDir, kind: "child" });
      await phaseHost.stop(registration.worker, { graceMs: 20 });
      await phaseHost.assertStopped(registration.worker, { timeoutMs: 1_000 });
    });
  });
  it("treats malformed-success ps output as ambiguous and preserves a leaderless descendant group", async () => {
    const root = await runRoot();
    await withRuntimeEnvironment({
      SUCCESSOR_PROCESS_HOST: "child",
      SUCCESSOR_PROCESS_HOST_TEST_PS_MALFORMED: "1",
    }, async () => {
      const host = createProcessHost({ runId: "malformed-ps-proof", runDir: root, kind: "child" });
      const handle = await host.start({
        name: "leaderless-descendant",
        argv: [process.execPath, "-e", `const { spawn } = require('node:child_process'); const child = spawn(${JSON.stringify(process.execPath)}, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }); console.log('DESCENDANT=' + child.pid); process.exit(0);`],
        persist: true,
      });
      let descendantPid;
      try {
        descendantPid = Number((await eventually(async () => {
          const match = /DESCENDANT=(\d+)/u.exec(await host.logs(handle));
          return match?.[1] ?? null;
        }, "leader did not report inherited descendant")).toString());
        await eventually(() => !isPidAlive(handle.pid), "fixture leader did not exit");
        const observed = await host.assertStopped(handle, { timeoutMs: 0 });
        assert.equal(observed.ok, false, "malformed-success ps output must not classify a live inherited group as stopped");
        assert.ok(["identity-unavailable", "leader-gone-group-live"].includes(observed.finalState), "ambiguous ps must remain a fail-closed live-group state");
        assert.equal(isPidAlive(descendantPid), true);
      } finally {
        try { process.kill(-handle.pid, "SIGKILL"); } catch {}
        await host.assertStopped(handle, { timeoutMs: 1_000 }).catch(() => undefined);
      }
    });
  });
  it("surfaces non-ok and thrown cleanup operations as protocol failures without leaking raw handles", async () => {
    const root = await runRoot();
    const state = new Map();
    const startEvents = [];
    const startingFactory = () => fakeHost(startEvents, { state });
    const started = await handleRemoteProcessHostRequest(protocol({ operation: "start" }), { root, runRoot: root, processHostFactory: startingFactory });
    const cleanupEvents = [];
    const failingFactory = () => fakeHost(cleanupEvents, {
      state,
      stop: () => ({ ok: false, finalState: "surviving", failures: ["TERM ignored"] }),
      assertStopped: () => { throw new Error("remote ssh disconnected"); },
    });

    const stopped = await handleRemoteProcessHostRequest(
      protocol({ operation: "stop", handle: started.handle }),
      { root, runRoot: root, processHostFactory: failingFactory },
    );
    const asserted = await handleRemoteProcessHostRequest(
      protocol({ operation: "assertStopped", handle: started.handle }),
      { root, runRoot: root, processHostFactory: failingFactory },
    );

    assert.equal(stopped.status, "error");
    assert.equal(stopped.error.code, "PROCESS_HOST_STOP_FAILED");
    assert.deepEqual(stopped.lifecycle, {
      ok: false,
      name: started.handle.name,
      unit: null,
      pid: started.handle.pid,
      finalState: "error",
      failures: ["assertStopped threw"],
    });
    assert.equal(asserted.status, "error");
    assert.equal(asserted.error.code, "PROCESS_HOST_ASSERT_FAILED");
    const operations = eventStrings(cleanupEvents);
    assert.equal(operations.includes(`stop:${started.handle.name}:3000`), false);
    assert.ok(operations.includes(`assert:${started.handle.name}:4000`));
    assert.ok(operations.includes(`stop:watchdog-${started.handle.name}:3000`));
    assert.ok(operations.includes(`assert:watchdog-${started.handle.name}:4000`));
  });
});
