#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomBytes } from "node:crypto";

import { createProcessHost } from "../lib/process-host.mjs";
import {
  createRemotePlayerGeneratorRequest,
  REMOTE_PLAYER_GENERATOR_REQUEST_SCHEMA,
} from "../load/remote-generator.mjs";
import { sha256Json } from "./protocol.mjs";

export const REMOTE_PROCESS_HOST_REQUEST_SCHEMA = "successor.remote-process-host-request.v1";
export const REMOTE_PROCESS_HOST_RESPONSE_SCHEMA = "successor.remote-process-host-response.v1";
export const REMOTE_PROCESS_HOST_HANDLE_SCHEMA = "successor.remote-process-host-handle.v1";
export const REMOTE_PROCESS_HOST_PHASE_ENVELOPE_SCHEMA = "successor.remote-process-host-phase-envelope.v1";

export const REMOTE_PROCESS_HOST_PHASES = Object.freeze([
  "headless-preparation",
  "endpoint-reachability",
  "generator",
]);

const STORED_PHASE_INPUT_SCHEMA = "successor.remote-process-host-phase-input.v1";
const STORED_PHASE_REGISTRATION_SCHEMA = "successor.remote-process-host-registration.v2";
const STORED_PHASE_SENTINEL_SCHEMA = "successor.remote-process-host-sentinel.v1";
const STORED_PHASE_SENTINEL_CHALLENGE_SCHEMA = "successor.remote-process-host-sentinel-challenge.v1";
const STORED_PHASE_SENTINEL_RESPONSE_SCHEMA = "successor.remote-process-host-sentinel-response.v1";
const STORED_PHASE_SENTINEL_AUDIT_SCHEMA = "successor.remote-process-host-sentinel-audit.v1";
const OPERATIONS = new Set(["start", "recover", "await", "stop", "assertStopped"]);
const PHASES = new Set(REMOTE_PROCESS_HOST_PHASES);
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,159}$/u;
const SOURCE_HASH_PATTERN = /^[a-f0-9]{64}$/u;
const MAX_PROTOCOL_INPUT_BYTES = 2 * 1024 * 1024;
const MAX_STORED_INPUT_BYTES = 2 * 1024 * 1024;
const MAX_STORED_HANDLE_BYTES = 16 * 1024;
const MAX_STORED_REGISTRATION_BYTES = 16 * 1024;
const MAX_STDOUT_BYTES = 8 * 1024 * 1024;
const MAX_STDERR_BYTES = 1024 * 1024;
const MAX_PHASE_ENVELOPE_BYTES = 16 * 1024 * 1024;
const MAX_WAIT_MS = 30 * 60_000;
const MAX_STOP_GRACE_MS = 30_000;
const DEFAULT_ASSERT_TIMEOUT_MS = 4_000;
const DEFAULT_STOP_GRACE_MS = 3_000;
const WATCHDOG_SETTLE_MS = 5_000;
const GATE_BOOT_TIMEOUT_MS = 5_000;
const GATE_POLL_INTERVAL_MS = 50;
const SENTINEL_HEARTBEAT_MS = 200;
const SENTINEL_FRESHNESS_MS = 2_000;
const SENTINEL_CHALLENGE_TIMEOUT_MS = 1_000;
const repoRoot = path.resolve(import.meta.dirname, "..", "..", "..");
const defaultRunRoot = path.join(repoRoot, "verification", ".runs", "player-load", "remote-process-host");
const modulePath = fileURLToPath(import.meta.url);

const GENERATOR_REQUEST_KEYS = new Set([
  "schema",
  "runId",
  "sourceHash",
  "sourcePaths",
  "generatorId",
  "identityNamespace",
  "clientOffset",
  "endpoint",
  "clients",
  "durationMs",
  "rampIntervalMs",
  "sampleIntervalMs",
  "expectedServerActiveSessions",
]);

/**
 * Execute one request-scoped ProcessHost operation. The only caller-controlled
 * runtime data is the validated JSON request; no request value is ever used as
 * an executable or argv element.
 */
export async function handleRemoteProcessHostRequest(rawRequest, {
  root = repoRoot,
  runRoot = path.join(path.resolve(root), "verification", ".runs", "player-load", "remote-process-host"),
  processHostFactory = createProcessHost,
} = {}) {
  let context = partialContext(rawRequest);
  try {
    const protocol = validateProtocolRequest(rawRequest);
    context = protocol.context;
    const paths = phasePaths(path.resolve(runRoot), context);
    const processHost = processHostFactory({
      runId: `successor-remote-load-${context.runId}-${context.generatorId}`,
      runDir: paths.runDir,
    });
    validateProcessHost(processHost);

    if (protocol.operation === "start") {
      return await startPhase({ protocol, context, paths, processHost, root: path.resolve(root), runRoot: path.resolve(runRoot) });
    }
    if (protocol.operation === "recover") {
      return await recoverPhase({ context, paths, processHost });
    }

    const handle = await unwrapHandle(protocol.handle, context, processHost, paths);
    if (protocol.operation === "await") {
      return await awaitPhase({ protocol, context, paths, processHost, handle });
    }
    if (protocol.operation === "stop") {
      return await stopPhase({ protocol, context, paths, processHost, handle });
    }
    return await assertPhaseStopped({ protocol, context, paths, processHost, handle });
  } catch (error) {
    return errorDocument(context, error);
  }
}

async function startPhase({ protocol, context, paths, processHost, root, runRoot }) {
  const stored = {
    schema: STORED_PHASE_INPUT_SCHEMA,
    runId: context.runId,
    sourceHash: context.sourceHash,
    generatorId: context.generatorId,
    phase: context.phase,
    requestHash: context.requestHash,
    input: phaseInput(context.phase, protocol.request),
  };
  let registration = phaseRegistration(context, protocol.request);
  await fs.mkdir(paths.phaseDir, { recursive: true });
  await writeJsonAtomicBounded(paths.inputPath, stored, MAX_STORED_INPUT_BYTES, "PHASE_INPUT_TOO_LARGE");
  // State `registered` is intentionally not executable: a runner sees only
  // this durable record until both ProcessHost pidfiles and the sentinel proof
  // have been persisted into `armed`, then atomically released.
  await writeJsonAtomicBounded(paths.registrationPath, registration, MAX_STORED_REGISTRATION_BYTES, "PHASE_REGISTRATION_TOO_LARGE");
  await fs.rm(paths.envelopePath, { force: true });
  await fs.rm(paths.handlePath, { force: true });
  await fs.rm(paths.sentinelPath, { force: true });
  await fs.rm(paths.sentinelChallengePath, { force: true });
  await fs.rm(paths.sentinelResponsePath, { force: true });
  await fs.rm(paths.sentinelAuditPath, { force: true });

  let worker;
  let watchdog;
  try {
    watchdog = await processHost.start({
      name: registration.watchdogName,
      argv: [process.execPath, modulePath, "--watchdog-run"],
      cwd: root,
      env: phaseEnvironment(context, root, runRoot, registration.deadlineAt),
      persist: true,
    });
    validateInternalHandle(watchdog, registration.watchdogName, paths);
    worker = await processHost.start({
      name: registration.workerName,
      argv: [process.execPath, modulePath, "--phase-run"],
      cwd: root,
      env: phaseEnvironment(context, root, runRoot, registration.deadlineAt),
      persist: true,
    });
    validateInternalHandle(worker, registration.workerName, paths);
    const sentinel = await awaitSentinelBoot(paths.sentinelPath, context, registration.gateNonce, worker.pid);
    // Even the still-gated state keeps the original raw ProcessHost handles.
    // This makes a killed protocol caller recoverable without ever allowing
    // its worker to execute a fixed phase.
    registration = {
      ...registration,
      worker: durableInternalHandle(worker, registration.workerName, paths),
      watchdog: durableInternalHandle(watchdog, registration.watchdogName, paths),
      sentinel,
    };
    await writeJsonAtomicBounded(paths.registrationPath, registration, MAX_STORED_REGISTRATION_BYTES, "PHASE_REGISTRATION_TOO_LARGE");
    await awaitTestReleaseBarrier(registration.deadlineAt);
    registration = { ...registration, state: "armed" };
    await writeJsonAtomicBounded(paths.registrationPath, registration, MAX_STORED_REGISTRATION_BYTES, "PHASE_REGISTRATION_TOO_LARGE");
    registration = { ...registration, state: "released", releasedAt: Date.now() };
    await writeJsonAtomicBounded(paths.registrationPath, registration, MAX_STORED_REGISTRATION_BYTES, "PHASE_REGISTRATION_TOO_LARGE");
  } catch (cause) {
    if (registration.worker && registration.sentinel && processGroupAlive(registration.worker.pid)) {
      await reapVerifiedWorkerGroup(paths, context, registration, DEFAULT_STOP_GRACE_MS);
    }
    // A worker without a durable live-sentinel proof remains gated and expires
    // without workload; never fall back to an external numeric group signal.
    if (watchdog) await lifecycleOperation(processHost, "stop", watchdog, { graceMs: DEFAULT_STOP_GRACE_MS });
    throw new ProtocolError("PHASE_GATE_BIND_FAILED", "phase runner was not durably armed and released", { cause });
  }

  const handle = wrapHandle(registration.worker, context, processHost, paths);
  try {
    await writeJsonAtomicBounded(paths.handlePath, handle, MAX_STORED_HANDLE_BYTES, "HANDLE_CACHE_PERSIST_FAILED");
  } catch (cause) {
    // The registration, not this cache, is authoritative; a lost transport
    // cannot release any extra workload and the watchdog still owns expiry.
    throw new ProtocolError("HANDLE_CACHE_PERSIST_FAILED", "detached phase response handle could not be cached", { cause });
  }
  return successDocument(context, { handle });
}

async function recoverPhase({ context, paths, processHost }) {
  const recovered = await recoverPhaseHandles(context, paths, processHost);
  // A missing or stale recovered identity never becomes authority merely
  // because the registration has a historical PID. Ordinary stop/assert use
  // their supplied durable handle and do not call recover at all.
  if (!recovered.worker.handle && !["gone", "pidfile-missing"].includes(recovered.worker.reason)) {
    throw new ProtocolError("PROCESS_HOST_RECOVERY_INVALID", "request-bound phase worker recovery has no trustworthy stopped identity");
  }
  return successDocument(context, { handle: wrapHandle(recovered.registration.worker, context, processHost, paths) });
}

async function awaitPhase({ protocol, context, paths, processHost, handle }) {
  const timeoutMs = boundedInteger(protocol.timeoutMs, "timeoutMs", { min: 0, max: MAX_WAIT_MS, required: true });
  const publicHandle = wrapHandle(handle.worker, context, processHost, paths);
  // Completion is the request-bound envelope, not absence of the worker PGID:
  // a sentinel may correctly retain the group to clean inherited descendants.
  // Final stop→assert owns durable pidfile/group cleanup.
  const lifecycle = { ok: true, name: handle.worker.name, unit: handle.worker.name, pid: handle.worker.pid, finalState: "phase-complete", failures: [] };
  try {
    const envelope = await waitForPhaseEnvelope(paths.envelopePath, context, publicHandle, timeoutMs);
    return successDocument(context, { handle: publicHandle, lifecycle, envelope });
  } catch (error) {
    const code = error instanceof ProtocolError ? error.code : "INVALID_PHASE_ENVELOPE";
    const status = code === "PHASE_ENVELOPE_MISSING" ? "missing" : "invalid";
    return errorDocument(context, error, {
      handle: publicHandle,
      lifecycle,
      envelope: unavailableEnvelope(context, publicHandle, status, code),
    });
  }
}

async function stopPhase({ protocol, context, paths, processHost, handle }) {
  const graceMs = boundedInteger(protocol.graceMs, "graceMs", { min: 0, max: MAX_STOP_GRACE_MS, required: false, fallback: DEFAULT_STOP_GRACE_MS });
  const lifecycles = await stopProcessHandles(processHost, handle, graceMs, paths, context);
  const publicHandle = wrapHandle(handle.worker, context, processHost, paths);
  if (!lifecycles.ok) {
    return errorDocument(context, new ProtocolError("PROCESS_HOST_STOP_FAILED", "phase worker or watchdog survived stop"), {
      handle: publicHandle,
      lifecycle: lifecycles.worker,
      watchdogLifecycle: lifecycles.watchdog,
    });
  }
  return successDocument(context, { handle: publicHandle, lifecycle: lifecycles.worker, watchdogLifecycle: lifecycles.watchdog });
}

async function assertPhaseStopped({ protocol, context, paths, processHost, handle }) {
  const timeoutMs = boundedInteger(protocol.timeoutMs, "timeoutMs", { min: 0, max: MAX_WAIT_MS, required: false, fallback: DEFAULT_ASSERT_TIMEOUT_MS });
  const lifecycles = await assertProcessHandlesStopped(processHost, handle, timeoutMs);
  const publicHandle = wrapHandle(handle.worker, context, processHost, paths);
  if (!lifecycles.ok) {
    return errorDocument(context, new ProtocolError("PROCESS_HOST_ASSERT_FAILED", "phase worker or watchdog is not stopped"), {
      handle: publicHandle,
      lifecycle: lifecycles.worker,
      watchdogLifecycle: lifecycles.watchdog,
    });
  }
  return successDocument(context, { handle: publicHandle, lifecycle: lifecycles.worker, watchdogLifecycle: lifecycles.watchdog });
}

function validateProtocolRequest(value) {
  if (!isRecord(value) || value.schema !== REMOTE_PROCESS_HOST_REQUEST_SCHEMA) {
    throw new ProtocolError("INVALID_PROTOCOL_REQUEST", `request schema must be ${REMOTE_PROCESS_HOST_REQUEST_SCHEMA}`);
  }
  if (!OPERATIONS.has(value.operation)) {
    throw new ProtocolError("INVALID_OPERATION", "operation must be start, recover, await, stop, or assertStopped");
  }
  if (!PHASES.has(value.phase)) {
    throw new ProtocolError("INVALID_PHASE", "phase is not an allowed remote player-load phase");
  }
  const request = canonicalGeneratorRequest(value.request);
  const context = {
    operation: value.operation,
    phase: value.phase,
    runId: request.runId,
    sourceHash: request.sourceHash,
    generatorId: request.generatorId,
    requestHash: sha256Json(request),
  };
  validateOuterKeys(value, value.operation);
  if ((value.operation === "start" || value.operation === "recover") && value.handle !== undefined) {
    throw new ProtocolError("INVALID_HANDLE", `${value.operation} does not accept a process handle`);
  }
  if (value.operation !== "start" && value.operation !== "recover" && !isRecord(value.handle)) {
    throw new ProtocolError("INVALID_HANDLE", `${value.operation} requires a process handle`);
  }
  return {
    operation: value.operation,
    phase: value.phase,
    request,
    handle: value.handle,
    timeoutMs: value.timeoutMs,
    graceMs: value.graceMs,
    context,
  };
}

function validateOuterKeys(value, operation) {
  const allowed = new Set(["schema", "operation", "phase", "request"]);
  if (operation !== "start" && operation !== "recover") allowed.add("handle");
  if (operation === "await" || operation === "assertStopped") allowed.add("timeoutMs");
  if (operation === "stop") allowed.add("graceMs");
  const unexpected = Object.keys(value).filter((key) => !allowed.has(key));
  if (unexpected.length > 0) {
    throw new ProtocolError("INVALID_PROTOCOL_REQUEST", `unexpected protocol field: ${unexpected[0]}`);
  }
}

function canonicalGeneratorRequest(value) {
  if (!isRecord(value) || value.schema !== REMOTE_PLAYER_GENERATOR_REQUEST_SCHEMA) {
    throw new ProtocolError("INVALID_BOUND_REQUEST", `request must use ${REMOTE_PLAYER_GENERATOR_REQUEST_SCHEMA}`);
  }
  const unexpected = Object.keys(value).filter((key) => !GENERATOR_REQUEST_KEYS.has(key));
  if (unexpected.length > 0) {
    throw new ProtocolError("INVALID_BOUND_REQUEST", `unexpected generator request field: ${unexpected[0]}`);
  }
  try {
    return createRemotePlayerGeneratorRequest(value);
  } catch (cause) {
    throw new ProtocolError("INVALID_BOUND_REQUEST", "generator request failed remote player-load validation", { cause });
  }
}

function phaseInput(phase, request) {
  if (phase === "headless-preparation") {
    return { sourceHash: request.sourceHash, sourcePaths: request.sourcePaths };
  }
  if (phase === "endpoint-reachability") {
    return { endpoint: request.endpoint };
  }
  return request;
}

function validateProcessHost(processHost) {
  if (!processHost || processHost.kind !== "child" ||
      ![processHost.start, processHost.stop, processHost.assertStopped, processHost.observeStopped, processHost.recover].every((method) => typeof method === "function")) {
    throw new ProtocolError("INVALID_PROCESS_HOST", "remote endpoint requires a child ProcessHost with persisted-handle observation and recovery");
  }
}

function wrapHandle(rawHandle, context, processHost, paths) {
  const name = processName(context);
  validateInternalHandle(rawHandle, name, paths);
  return {
    schema: REMOTE_PROCESS_HOST_HANDLE_SCHEMA,
    runId: context.runId,
    sourceHash: context.sourceHash,
    generatorId: context.generatorId,
    phase: context.phase,
    requestHash: context.requestHash,
    kind: processHost.kind,
    name,
    pid: positiveInteger(rawHandle.pid, "process handle pid"),
  };
}

async function unwrapHandle(value, context, processHost, paths) {
  const allowed = ["schema", "runId", "sourceHash", "generatorId", "phase", "requestHash", "kind", "name", "pid"];
  if (!isRecord(value) || value.schema !== REMOTE_PROCESS_HOST_HANDLE_SCHEMA ||
      value.runId !== context.runId || value.sourceHash !== context.sourceHash ||
      value.generatorId !== context.generatorId || value.phase !== context.phase ||
      value.requestHash !== context.requestHash || value.kind !== processHost.kind ||
      value.name !== processName(context) || Object.keys(value).length !== allowed.length ||
      Object.keys(value).some((key) => !allowed.includes(key))) {
    throw new ProtocolError("INVALID_HANDLE", "process handle is not bound to this operation request");
  }
  const registration = await readAndValidateRegistration(paths.registrationPath, context, { requireReleased: true });
  const worker = registration.worker;
  if (positiveInteger(value.pid, "process handle pid") !== worker.pid || value.name !== worker.name) {
    throw new ProtocolError("INVALID_HANDLE", "process handle does not match the durable request registration");
  }
  return { registration, worker, watchdog: registration.watchdog };
}

async function recoverPhaseHandles(context, paths, processHost) {
  const registration = await readAndValidateRegistration(paths.registrationPath, context, { requireReleased: true });
  let worker;
  let watchdog;
  try {
    worker = await processHost.recover(registration.workerName);
    watchdog = await processHost.recover(registration.watchdogName);
  } catch (cause) {
    throw new ProtocolError("PROCESS_HOST_RECOVERY_FAILED", "authoritative process handle recovery failed", { cause });
  }
  validateRecoveredHandle(worker, registration.workerName, paths, "worker");
  validateRecoveredHandle(watchdog, registration.watchdogName, paths, "watchdog");
  if (worker.handle && !sameInternalHandle(worker.handle, registration.worker)) {
    throw new ProtocolError("PROCESS_HOST_RECOVERY_INVALID", "worker recovery does not match durable request registration");
  }
  if (watchdog.handle && !sameInternalHandle(watchdog.handle, registration.watchdog)) {
    throw new ProtocolError("PROCESS_HOST_RECOVERY_INVALID", "watchdog recovery does not match durable request registration");
  }
  return { registration, worker, watchdog };
}

function validateRecoveredHandle(recovered, expectedName, paths, label) {
  if (!isRecord(recovered) || typeof recovered.active !== "boolean") {
    throw new ProtocolError("PROCESS_HOST_RECOVERY_INVALID", `${label} recovery record is invalid`);
  }
  if (!recovered.handle) {
    if (recovered.active) throw new ProtocolError("PROCESS_HOST_RECOVERY_INVALID", `${label} recovery is active without a handle`);
    return;
  }
  validateInternalHandle(recovered.handle, expectedName, paths);
  if (typeof recovered.birthToken !== "string" || recovered.birthToken.length === 0) {
    throw new ProtocolError("PROCESS_HOST_RECOVERY_INVALID", `${label} recovery has no process-birth identity`);
  }
}

function validateInternalHandle(rawHandle, name, paths) {
  if (!isRecord(rawHandle) || rawHandle.name !== name || positiveInteger(rawHandle.pid, "process handle pid") <= 0) {
    throw new ProtocolError("INVALID_HANDLE", "process host returned a mismatched process handle");
  }
  if (rawHandle.logPath !== undefined && path.resolve(rawHandle.logPath) !== processLogPath(paths, name)) {
    throw new ProtocolError("INVALID_HANDLE", "process handle log path does not match its request scope");
  }
}

function durableInternalHandle(rawHandle, name, paths) {
  validateInternalHandle(rawHandle, name, paths);
  return { name, pid: rawHandle.pid, logPath: processLogPath(paths, name) };
}

function sameInternalHandle(left, right) {
  return isRecord(left) && isRecord(right) && left.name === right.name && left.pid === right.pid &&
    (left.logPath === undefined || left.logPath === right.logPath);
}

function validateRegistrationHandle(value, name, paths, label) {
  if (!isRecord(value) || value.name !== name || !Number.isInteger(value.pid) || value.pid <= 0 ||
      path.resolve(value.logPath ?? "") !== processLogPath(paths, name)) {
    throw new ProtocolError("INVALID_PHASE_REGISTRATION", `${label} durable handle is invalid`);
  }
}

async function stopProcessHandles(processHost, handles, graceMs, paths, context) {
  // Never let the generic ProcessHost signal a live phase PGID: it has only
  // leader birth identity, whereas this endpoint requires a fresh sentinel
  // challenge before *every* phase-group signal.
  let worker;
  if (processGroupAlive(handles.worker.pid)) {
    const reaped = await reapVerifiedWorkerGroup(paths, context, handles.registration, graceMs);
    worker = reaped.ok
      ? await lifecycleOperation(processHost, "assertStopped", handles.worker, { timeoutMs: DEFAULT_ASSERT_TIMEOUT_MS })
      : reaped;
  } else {
    worker = await lifecycleOperation(processHost, "assertStopped", handles.worker, { timeoutMs: DEFAULT_ASSERT_TIMEOUT_MS });
  }
  const watchdog = await lifecycleOperation(processHost, "stop", handles.watchdog, { graceMs });
  return { ok: worker.ok && watchdog.ok, worker, watchdog };
}

async function assertProcessHandlesStopped(processHost, handles, timeoutMs) {
  const worker = await lifecycleOperation(processHost, "assertStopped", handles.worker, { timeoutMs });
  const watchdog = await lifecycleOperation(processHost, "assertStopped", handles.watchdog, { timeoutMs });
  return { ok: worker.ok && watchdog.ok, worker, watchdog };
}

async function lifecycleOperation(processHost, operation, handle, options) {
  if (!handle) return { ok: true, name: null, unit: null, pid: null, finalState: "inactive", failures: [] };
  try {
    return sanitizeLifecycle(await processHost[operation](handle, options));
  } catch {
    return { ok: false, name: handle.name, unit: null, pid: handle.pid, finalState: "error", failures: [`${operation} threw`] };
  }
}


function sanitizeLifecycle(value) {
  if (!isRecord(value)) return { ok: false, finalState: "invalid", failures: ["process host returned no lifecycle document"] };
  return {
    ok: value.ok === true,
    name: typeof value.name === "string" ? value.name : null,
    unit: typeof value.unit === "string" ? value.unit : null,
    pid: Number.isInteger(value.pid) && value.pid > 0 ? value.pid : null,
    finalState: typeof value.finalState === "string" ? value.finalState : null,
    failures: Array.isArray(value.failures) ? value.failures.filter((failure) => typeof failure === "string").map((failure) => failure.slice(0, 1024)) : [],
    ...(value.stalePidfile === true ? { stalePidfile: true } : {}),
  };
}

function phasePaths(runRoot, context) {
  const runDir = path.join(runRoot, context.runId, context.generatorId);
  const phaseDir = path.join(runDir, "phases", context.phase, context.requestHash);
  return {
    runDir,
    phaseDir,
    inputPath: path.join(phaseDir, "input.json"),
    handlePath: path.join(phaseDir, "handle.json"),
    registrationPath: path.join(phaseDir, "registration.json"),
    envelopePath: path.join(phaseDir, "envelope.json"),
    sentinelPath: path.join(phaseDir, "sentinel.json"),
    sentinelChallengePath: path.join(phaseDir, "sentinel-challenge.json"),
    sentinelResponsePath: path.join(phaseDir, "sentinel-response.json"),
    sentinelAuditPath: path.join(phaseDir, "sentinel-audit.ndjson"),
    logPath: path.join(runDir, "logs", `${processName(context)}.log`),
  };
}


function processName(context) {
  return `phase-${context.phase}-${context.requestHash}`;
}

function watchdogName(context) {
  return `watchdog-${processName(context)}`;
}

function processHostRunId(context) {
  return `successor-remote-load-${context.runId}-${context.generatorId}`;
}

function processLogPath(paths, name) {
  return path.join(paths.runDir, "logs", `${name}.log`);
}

function phaseRegistration(context, request) {
  const deadlineMs = phaseDeadlineMs(context.phase, request) + WATCHDOG_SETTLE_MS;
  const testDeadlineMs = testDeadlineOverride();
  return {
    schema: STORED_PHASE_REGISTRATION_SCHEMA,
    runId: context.runId,
    sourceHash: context.sourceHash,
    generatorId: context.generatorId,
    phase: context.phase,
    requestHash: context.requestHash,
    processHostRunId: processHostRunId(context),
    workerName: processName(context),
    watchdogName: watchdogName(context),
    deadlineAt: Date.now() + (testDeadlineMs === null ? deadlineMs : Math.min(deadlineMs, testDeadlineMs)),
    state: "registered",
    gateNonce: randomBytes(32).toString("hex"),
  };
}

function phaseDeadlineMs(phase, request) {
  if (phase === "headless-preparation") return 16 * 60_000;
  if (phase === "endpoint-reachability") return 20_000;
  return Math.min(12 * 60_000, request.durationMs + request.clients * request.rampIntervalMs + 120_000);
}

function phaseEnvironment(context, root, runRoot, deadlineAt) {
  return {
    SUCCESSOR_REMOTE_PROCESS_RUN_ROOT: runRoot,
    SUCCESSOR_REMOTE_PROCESS_RUN_ID: context.runId,
    SUCCESSOR_REMOTE_PROCESS_SOURCE_HASH: context.sourceHash,
    SUCCESSOR_REMOTE_PROCESS_GENERATOR_ID: context.generatorId,
    SUCCESSOR_REMOTE_PROCESS_PHASE: context.phase,
    SUCCESSOR_REMOTE_PROCESS_REQUEST_HASH: context.requestHash,
    SUCCESSOR_REMOTE_PROCESS_REPO_ROOT: root,
    SUCCESSOR_REMOTE_PROCESS_DEADLINE_AT: String(deadlineAt),
  };
}

async function readAndValidateRegistration(file, context, { requireReleased = false } = {}) {
  const registrationPaths = { runDir: path.resolve(path.dirname(file), "..", "..", "..") };
  let value;
  try {
    value = await readJsonBounded(file, MAX_STORED_REGISTRATION_BYTES);
  } catch (cause) {
    throw new ProtocolError("PHASE_REGISTRATION_UNAVAILABLE", "request registration is unavailable", { cause });
  }
  if (!isRecord(value) || value.schema !== STORED_PHASE_REGISTRATION_SCHEMA ||
      value.runId !== context.runId || value.sourceHash !== context.sourceHash ||
      value.generatorId !== context.generatorId || value.phase !== context.phase ||
      value.requestHash !== context.requestHash || value.processHostRunId !== processHostRunId(context) ||
      value.workerName !== processName(context) || value.watchdogName !== watchdogName(context) ||
      !Number.isInteger(value.deadlineAt) || value.deadlineAt <= 0 ||
      !["registered", "armed", "released"].includes(value.state) ||
      !/^[a-f0-9]{64}$/u.test(value.gateNonce ?? "")) {
    throw new ProtocolError("INVALID_PHASE_REGISTRATION", "request registration failed binding validation");
  }
  const hasDurableBindings = value.worker !== undefined || value.watchdog !== undefined || value.sentinel !== undefined;
  if (value.state !== "registered" || hasDurableBindings) {
    validateRegistrationHandle(value.worker, value.workerName, registrationPaths, "worker");
    validateRegistrationHandle(value.watchdog, value.watchdogName, registrationPaths, "watchdog");
    validateSentinelIdentity(value.sentinel, context, value.gateNonce, value.worker.pid);
  }
  if (value.state === "released" && (!Number.isInteger(value.releasedAt) || value.releasedAt <= 0)) {
    throw new ProtocolError("INVALID_PHASE_REGISTRATION", "released phase registration lacks its release timestamp");
  }
  if (requireReleased && value.state !== "released") {
    throw new ProtocolError("PHASE_NOT_RELEASED", "phase request is registered but has not been durably released");
  }
  return value;
}

function successDocument(context, extra = {}) {
  return signedDocument({
    schema: REMOTE_PROCESS_HOST_RESPONSE_SCHEMA,
    status: "ok",
    operation: context.operation,
    phase: context.phase,
    runId: context.runId,
    sourceHash: context.sourceHash,
    generatorId: context.generatorId,
    requestHash: context.requestHash,
    ...extra,
  });
}

function errorDocument(context, error, extra = {}) {
  const code = error instanceof ProtocolError ? error.code : "REMOTE_PROCESS_HOST_FAILURE";
  const message = error instanceof ProtocolError ? error.message : "remote ProcessHost operation failed";
  return signedDocument({
    schema: REMOTE_PROCESS_HOST_RESPONSE_SCHEMA,
    status: "error",
    operation: context.operation,
    phase: context.phase,
    runId: context.runId,
    sourceHash: context.sourceHash,
    generatorId: context.generatorId,
    requestHash: context.requestHash,
    error: { code, message },
    ...extra,
  });
}

function signedDocument(unsigned) {
  return { ...unsigned, checksum: sha256Json(unsigned) };
}

function partialContext(value) {
  const request = isRecord(value?.request) ? value.request : {};
  return {
    operation: OPERATIONS.has(value?.operation) ? value.operation : null,
    phase: PHASES.has(value?.phase) ? value.phase : null,
    runId: validIdentifierOrNull(request.runId),
    sourceHash: SOURCE_HASH_PATTERN.test(request.sourceHash ?? "") ? request.sourceHash : null,
    generatorId: validIdentifierOrNull(request.generatorId),
    requestHash: null,
  };
}

function unavailableEnvelope(context, handle, status, code) {
  return {
    schema: REMOTE_PROCESS_HOST_PHASE_ENVELOPE_SCHEMA,
    status,
    runId: context.runId,
    sourceHash: context.sourceHash,
    generatorId: context.generatorId,
    phase: context.phase,
    requestHash: context.requestHash,
    runner: runnerIdentity(handle),
    error: { code },
  };
}

async function readAndValidatePhaseEnvelope(file, context, handle) {
  let document;
  try {
    document = await readJsonBounded(file, MAX_PHASE_ENVELOPE_BYTES);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new ProtocolError("PHASE_ENVELOPE_MISSING", "phase process group stopped without writing an output envelope");
    }
    if (error instanceof ProtocolError) throw error;
    throw new ProtocolError("INVALID_PHASE_ENVELOPE", "phase output envelope could not be read", { cause: error });
  }
  if (!isRecord(document) || document.schema !== REMOTE_PROCESS_HOST_PHASE_ENVELOPE_SCHEMA ||
      !["complete", "error"].includes(document.status) ||
      document.runId !== context.runId || document.sourceHash !== context.sourceHash ||
      document.generatorId !== context.generatorId || document.phase !== context.phase ||
      document.requestHash !== context.requestHash || !sameRunner(document.runner, runnerIdentity(handle)) ||
      !isRecord(document.process) || !isRecord(document.command) || document.command.id !== context.phase ||
      typeof document.stdout !== "string" || typeof document.stderr !== "string" ||
      !Number.isInteger(document.stdoutBytes) || document.stdoutBytes < 0 ||
      !Number.isInteger(document.stderrBytes) || document.stderrBytes < 0 ||
      typeof document.stdoutTruncated !== "boolean" || typeof document.stderrTruncated !== "boolean" ||
      Buffer.byteLength(document.stdout) > MAX_STDOUT_BYTES || Buffer.byteLength(document.stderr) > MAX_STDERR_BYTES) {
    throw new ProtocolError("INVALID_PHASE_ENVELOPE", "phase output envelope failed binding or shape validation");
  }
  return document;
}

async function waitForPhaseEnvelope(file, context, handle, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let missing;
  do {
    try {
      return await readAndValidatePhaseEnvelope(file, context, handle);
    } catch (error) {
      if (!(error instanceof ProtocolError) || error.code !== "PHASE_ENVELOPE_MISSING") throw error;
      missing = error;
    }
    await delay(GATE_POLL_INTERVAL_MS);
  } while (Date.now() <= deadline);
  throw missing ?? new ProtocolError("PHASE_ENVELOPE_MISSING", "phase output envelope was not written before await timed out");
}

function runnerIdentity(handle) {
  return { kind: "child", pid: handle.pid };
}

function sameRunner(left, right) {
  return isRecord(left) && left.kind === right.kind && left.pid === right.pid;
}

async function phaseRunMain() {
  const runtime = phaseRuntimeFromEnvironment();
  let envelope;
  try {
    const registration = await readAndValidateRegistration(runtime.paths.registrationPath, runtime.context);
    await startPhaseSentinel(runtime, registration);
    await testHook("runner-gated");
    await waitForPhaseRelease(runtime, registration.gateNonce);
    await testHook("release-observed");
    const stored = await readJsonBounded(runtime.paths.inputPath, MAX_STORED_INPUT_BYTES);
    validateStoredPhaseInput(stored, runtime.context);
    envelope = await runFixedPhase(runtime, stored.input);
  } catch (error) {
    envelope = phaseRunnerErrorEnvelope(runtime, error);
  }
  // The sentinel is intentionally left alive: it is the sole group signaler
  // and exits itself only after every other member of this PGID is gone.
  await writePhaseEnvelope(runtime.paths.envelopePath, envelope);
  process.exit(envelope.status === "complete" && envelope.process.exitCode === 0 && envelope.process.signal === null ? 0 : 1);
}
async function watchdogRunMain() {
  const runtime = phaseRuntimeFromEnvironment();
  const deadlineAt = Number(process.env.SUCCESSOR_REMOTE_PROCESS_DEADLINE_AT);
  if (!Number.isSafeInteger(deadlineAt) || deadlineAt <= 0) throw new ProtocolError("INVALID_WATCHDOG_ENVIRONMENT", "watchdog deadline is invalid");
  await delay(Math.max(0, deadlineAt - Date.now()));
  const settleDeadline = deadlineAt + WATCHDOG_SETTLE_MS;
  while (Date.now() <= settleDeadline) {
    const registration = await readAndValidateRegistration(runtime.paths.registrationPath, runtime.context).catch(() => null);
    if (registration && registration.state !== "registered") {
      // A leader PID or a PGID alone is never authority: the sentinel must prove
      // it is the original nonce-bearing member of that exact worker group.
      await testHook("watchdog-reap-attempted");
      await reapVerifiedWorkerGroup(runtime.paths, runtime.context, registration, DEFAULT_STOP_GRACE_MS);
      await testHook("watchdog-reap-finished");
      return;
    }
    await delay(GATE_POLL_INTERVAL_MS);
  }
}

async function startPhaseSentinel(runtime, registration) {
  const child = spawn(process.execPath, [modulePath, "--sentinel-run"], {
    cwd: runtime.root,
    env: {
      ...process.env,
      SUCCESSOR_REMOTE_PROCESS_SENTINEL_NONCE: registration.gateNonce,
      SUCCESSOR_REMOTE_PROCESS_SENTINEL_PARENT_PID: String(process.pid),
    },
    detached: false,
    shell: false,
    stdio: "ignore",
  });
  await waitForSpawn(child);
  child.unref();
  return child;
}

async function sentinelRunMain() {
  const runtime = phaseRuntimeFromEnvironment();
  const nonce = process.env.SUCCESSOR_REMOTE_PROCESS_SENTINEL_NONCE;
  const expectedParentPid = positiveInteger(Number(process.env.SUCCESSOR_REMOTE_PROCESS_SENTINEL_PARENT_PID), "sentinel parent pid");
  if (!/^[a-f0-9]{64}$/u.test(nonce ?? "")) throw new ProtocolError("INVALID_SENTINEL_ENVIRONMENT", "sentinel nonce is invalid");
  const identity = requireProcessIdentity(process.pid);
  if (identity.pgid !== expectedParentPid) throw new ProtocolError("INVALID_SENTINEL_ENVIRONMENT", "sentinel is not in its phase worker process group");
  // The sentinel must survive its own TERM broadcast long enough to issue a
  // fresh KILL command when a descendant ignores TERM.
  process.on("SIGTERM", () => undefined);
  const writeHeartbeat = async () => writeJsonAtomicBounded(runtime.paths.sentinelPath, {
    schema: STORED_PHASE_SENTINEL_SCHEMA,
    runId: runtime.context.runId,
    sourceHash: runtime.context.sourceHash,
    generatorId: runtime.context.generatorId,
    phase: runtime.context.phase,
    requestHash: runtime.context.requestHash,
    nonce,
    pid: identity.pid,
    pgid: identity.pgid,
    birthToken: identity.birthToken,
    heartbeatAt: Date.now(),
  }, MAX_STORED_REGISTRATION_BYTES, "SENTINEL_PROOF_TOO_LARGE");
  const deadlineAt = Number(process.env.SUCCESSOR_REMOTE_PROCESS_DEADLINE_AT);
  while (Number.isSafeInteger(deadlineAt) && Date.now() <= deadlineAt + WATCHDOG_SETTLE_MS) {
    await writeHeartbeat();
    await answerSentinelChallenge(runtime, nonce, identity);
    if (!processGroupHasOtherMembers(identity.pgid, identity.pid)) {
      await testHook("sentinel-sole-member", { signalerPid: identity.pid, mode: "in-group-sentinel" });
      return;
    }
    await delay(SENTINEL_HEARTBEAT_MS);
  }
}

async function answerSentinelChallenge(runtime, nonce, identity) {
  let challenge;
  try {
    challenge = await readJsonBounded(runtime.paths.sentinelChallengePath, MAX_STORED_REGISTRATION_BYTES);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  validateSentinelChallenge(challenge, runtime.context, nonce);
  if (Date.now() > challenge.expiresAt) return;
  const claimPath = await claimSentinelChallenge(runtime.paths, challenge);
  if (!claimPath) return;
  const claimed = await readJsonBounded(claimPath, MAX_STORED_REGISTRATION_BYTES);
  if (claimed.challenge !== challenge.challenge) return;
  await appendSentinelAudit(runtime.paths.sentinelAuditPath, runtime.context, challenge, identity, claimPath);
  await writeJsonAtomicBounded(runtime.paths.sentinelResponsePath, {
    schema: STORED_PHASE_SENTINEL_RESPONSE_SCHEMA,
    runId: runtime.context.runId,
    sourceHash: runtime.context.sourceHash,
    generatorId: runtime.context.generatorId,
    phase: runtime.context.phase,
    requestHash: runtime.context.requestHash,
    nonce,
    challenge: challenge.challenge,
    signal: challenge.signal,
    requestedAt: challenge.requestedAt,
    pid: identity.pid,
    pgid: identity.pgid,
    birthToken: identity.birthToken,
    respondedAt: Date.now(),
  }, MAX_STORED_REGISTRATION_BYTES, "SENTINEL_RESPONSE_TOO_LARGE");
  const audit = { signalerPid: process.pid, mode: "in-group-sentinel", signal: challenge.signal, challengeId: challenge.challenge, claimPath: path.basename(claimPath) };
  await testHook(`sentinel-command-${challenge.challenge}`, audit);
  // Only the claimed sentinel command signals its own current group. A failed
  // syscall leaves this claim consumed; the reaper can only retry with a new
  // challenge, never replay this command on a later heartbeat.
  try {
    process.kill(0, challenge.signal);
  } catch (error) {
    await testHook(`sentinel-command-failed-${challenge.challenge}`, { ...audit, error: error?.code ?? "UNKNOWN" });
  }
}

async function claimSentinelChallenge(paths, challenge) {
  const claimPath = path.join(paths.phaseDir, `sentinel-challenge.${challenge.challenge}.executing.json`);
  try {
    // link is create-only: unlike rename, it cannot overwrite an existing
    // claim. A crash after link still leaves a durable consumed record.
    await fs.link(paths.sentinelChallengePath, claimPath);
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "EEXIST") return null;
    throw error;
  }
  await fs.rm(paths.sentinelChallengePath, { force: true });
  return claimPath;
}

async function appendSentinelAudit(file, context, challenge, identity, claimPath) {
  const record = {
    schema: STORED_PHASE_SENTINEL_AUDIT_SCHEMA,
    runId: context.runId,
    sourceHash: context.sourceHash,
    generatorId: context.generatorId,
    phase: context.phase,
    requestHash: context.requestHash,
    challengeId: challenge.challenge,
    signal: challenge.signal,
    signalerPid: identity.pid,
    mode: "in-group-sentinel",
    claim: path.basename(claimPath),
    claimedAt: Date.now(),
  };
  await fs.appendFile(file, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600, flag: "a" });
}

function validateSentinelChallenge(value, context, nonce) {
  if (!isRecord(value) || value.schema !== STORED_PHASE_SENTINEL_CHALLENGE_SCHEMA ||
      value.runId !== context.runId || value.sourceHash !== context.sourceHash ||
      value.generatorId !== context.generatorId || value.phase !== context.phase ||
      value.requestHash !== context.requestHash || value.nonce !== nonce ||
      !["SIGTERM", "SIGKILL"].includes(value.signal) ||
      !/^[a-f0-9]{64}$/u.test(value.challenge ?? "") ||
      !Number.isInteger(value.requestedAt) || !Number.isInteger(value.expiresAt) || value.expiresAt < value.requestedAt) {
    throw new ProtocolError("INVALID_SENTINEL_CHALLENGE", "sentinel challenge failed request binding validation");
  }
}

async function challengeLiveSentinel(paths, context, registration, signal) {
  const requestedAt = Date.now();
  const expiresAt = requestedAt + SENTINEL_CHALLENGE_TIMEOUT_MS;
  const challenge = randomBytes(32).toString("hex");
  await fs.rm(paths.sentinelResponsePath, { force: true });
  await writeJsonAtomicBounded(paths.sentinelChallengePath, {
    schema: STORED_PHASE_SENTINEL_CHALLENGE_SCHEMA,
    runId: context.runId,
    sourceHash: context.sourceHash,
    generatorId: context.generatorId,
    phase: context.phase,
    requestHash: context.requestHash,
    nonce: registration.gateNonce,
    challenge,
    signal,
    requestedAt,
    expiresAt,
  }, MAX_STORED_REGISTRATION_BYTES, "SENTINEL_CHALLENGE_TOO_LARGE");
  do {
    try {
      const response = await readJsonBounded(paths.sentinelResponsePath, MAX_STORED_REGISTRATION_BYTES);
      if (isLiveChallengeResponse(response, context, registration, challenge, signal, requestedAt, expiresAt)) return response;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    await delay(GATE_POLL_INTERVAL_MS);
  } while (Date.now() <= expiresAt);
  throw new ProtocolError("SENTINEL_CHALLENGE_TIMEOUT", "live sentinel did not answer this authorization challenge");
}

function isLiveChallengeResponse(value, context, registration, challenge, signal, requestedAt, expiresAt) {
  return isRecord(value) && value.schema === STORED_PHASE_SENTINEL_RESPONSE_SCHEMA &&
    value.runId === context.runId && value.sourceHash === context.sourceHash &&
    value.generatorId === context.generatorId && value.phase === context.phase &&
    value.requestHash === context.requestHash && value.nonce === registration.gateNonce &&
    value.challenge === challenge && value.signal === signal && value.requestedAt === requestedAt &&
    Number.isInteger(value.respondedAt) && value.respondedAt >= requestedAt && value.respondedAt <= expiresAt &&
    sameSentinel(value, registration.sentinel);
}

async function waitForPhaseRelease(runtime, nonce) {
  for (;;) {
    if (Date.now() > Number(process.env.SUCCESSOR_REMOTE_PROCESS_DEADLINE_AT)) {
      throw new ProtocolError("PHASE_GATE_EXPIRED", "phase was never durably released before its deadline");
    }
    const registration = await readAndValidateRegistration(runtime.paths.registrationPath, runtime.context);
    if (registration.state === "released" && registration.gateNonce === nonce && registration.worker.pid === process.pid) {
      return registration;
    }
    await delay(GATE_POLL_INTERVAL_MS);
  }
}

async function awaitSentinelBoot(file, context, nonce, workerPid) {
  const deadline = Date.now() + GATE_BOOT_TIMEOUT_MS;
  let lastError;
  do {
    try {
      const proof = await readJsonBounded(file, MAX_STORED_REGISTRATION_BYTES);
      validateSentinelIdentity(proof, context, nonce, workerPid);
      if (Date.now() - proof.heartbeatAt <= SENTINEL_FRESHNESS_MS) return proof;
      lastError = new ProtocolError("STALE_SENTINEL_PROOF", "phase sentinel heartbeat is stale during gate bootstrap");
    } catch (error) {
      lastError = error;
    }
    await delay(GATE_POLL_INTERVAL_MS);
  } while (Date.now() <= deadline);
  throw new ProtocolError("SENTINEL_BOOT_TIMEOUT", "phase sentinel did not establish a fresh cryptographic proof", { cause: lastError });
}

function validateSentinelIdentity(value, context, nonce, workerPid) {
  if (!isRecord(value) || value.schema !== STORED_PHASE_SENTINEL_SCHEMA ||
      value.runId !== context.runId || value.sourceHash !== context.sourceHash ||
      value.generatorId !== context.generatorId || value.phase !== context.phase ||
      value.requestHash !== context.requestHash || value.nonce !== nonce ||
      !Number.isInteger(value.pid) || value.pid <= 0 || value.pgid !== workerPid ||
      typeof value.birthToken !== "string" || value.birthToken.length === 0 ||
      !Number.isInteger(value.heartbeatAt) || value.heartbeatAt <= 0) {
    throw new ProtocolError("INVALID_SENTINEL_PROOF", "phase sentinel proof failed request or process-group binding validation");
  }
}

async function readFreshSentinelProof(paths, context, registration) {
  const proof = await readJsonBounded(paths.sentinelPath, MAX_STORED_REGISTRATION_BYTES);
  validateSentinelIdentity(proof, context, registration.gateNonce, registration.worker.pid);
  if (!sameSentinel(proof, registration.sentinel) || Date.now() - proof.heartbeatAt > SENTINEL_FRESHNESS_MS) {
    throw new ProtocolError("STALE_SENTINEL_PROOF", "phase sentinel proof is stale or no longer matches its durable registration");
  }
  const current = requireProcessIdentity(proof.pid);
  if (current.pgid !== registration.worker.pid || current.birthToken !== proof.birthToken) {
    throw new ProtocolError("SENTINEL_IDENTITY_MISMATCH", "phase sentinel PID no longer has its registered birth identity or process group");
  }
  return proof;
}

function sameSentinel(left, right) {
  return isRecord(left) && isRecord(right) && left.pid === right.pid && left.pgid === right.pgid && left.birthToken === right.birthToken && left.nonce === right.nonce;
}

async function reapVerifiedWorkerGroup(paths, context, registration, graceMs) {
  const handle = registration.worker;
  if (!processGroupAlive(handle.pid)) return inactiveLifecycle(handle);
  try {
    await challengeLiveSentinel(paths, context, registration, "SIGTERM");
  } catch (error) {
    return unsafeGroupLifecycle(handle, error instanceof ProtocolError ? error.code : "SENTINEL_PROOF_UNAVAILABLE");
  }
  if (await waitForProcessGroupExit(handle.pid, graceMs)) return inactiveLifecycle(handle);
  try {
    await challengeLiveSentinel(paths, context, registration, "SIGKILL");
  } catch (error) {
    return unsafeGroupLifecycle(handle, error instanceof ProtocolError ? error.code : "SENTINEL_PROOF_UNAVAILABLE");
  }
  return (await waitForProcessGroupExit(handle.pid, Math.max(500, Math.min(3_000, graceMs))))
    ? inactiveLifecycle(handle)
    : unsafeGroupLifecycle(handle, "GROUP_SURVIVED_KILL");
}

function requireProcessIdentity(pid) {
  const result = spawnSync("ps", ["-o", "pid=,pgid=,lstart=", "-p", String(pid)], { encoding: "utf8", timeout: 1500 });
  const match = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/u.exec(String(result.stdout ?? ""));
  if (result.status !== 0 || !match) throw new ProtocolError("PROCESS_IDENTITY_UNAVAILABLE", "process identity is unavailable");
  return { pid: Number(match[1]), pgid: Number(match[2]), birthToken: `ps:${match[3].replace(/\s+/gu, " ")}` };
}

function processGroupAlive(pgid) {
  if (process.env.SUCCESSOR_REMOTE_PROCESS_TEST_FORCE_PS_FAILURE === "1") return true;
  const result = spawnSync("ps", ["-axo", "pid=,pgid=,stat="], { encoding: "utf8", timeout: 1500 });
  if (result.status !== 0) return true;
  let rows = 0;
  for (const line of String(result.stdout ?? "").split(/\r?\n/u)) {
    if (!line.trim()) continue;
    const match = /^\s*\d+\s+(\d+)\s+(\S+)\s*$/u.exec(line);
    if (!match) return true;
    rows += 1;
    if (Number(match[1]) === pgid && !match[2].startsWith("Z")) return true;
  }
  return rows === 0;
}

function processGroupHasOtherMembers(pgid, ownPid) {
  if (process.env.SUCCESSOR_REMOTE_PROCESS_TEST_FORCE_PS_FAILURE === "1") return true;
  const result = spawnSync("ps", ["-axo", "pid=,pgid=,stat="], { encoding: "utf8", timeout: 1500 });
  if (result.status !== 0) return true;
  let rows = 0;
  for (const line of String(result.stdout ?? "").split(/\r?\n/u)) {
    if (!line.trim()) continue;
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s*$/u.exec(line);
    if (!match) return true;
    rows += 1;
    if (Number(match[2]) === pgid && Number(match[1]) !== ownPid && !match[3].startsWith("Z")) return true;
  }
  return rows === 0;
}

async function waitForProcessGroupExit(pgid, timeoutMs) {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  while (Date.now() <= deadline) {
    if (!processGroupAlive(pgid)) return true;
    await delay(50);
  }
  return !processGroupAlive(pgid);
}

function inactiveLifecycle(handle) {
  return { ok: true, name: handle.name, unit: handle.name, pid: handle.pid, finalState: "inactive", failures: [] };
}

function unsafeGroupLifecycle(handle, reason) {
  return { ok: false, name: handle.name, unit: handle.name, pid: handle.pid, finalState: "ownership-unproven", failures: [reason] };
}

function waitForSpawn(child) {
  return new Promise((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
}


function phaseRuntimeFromEnvironment() {
  const runId = requiredEnvironmentIdentifier("SUCCESSOR_REMOTE_PROCESS_RUN_ID", "runId");
  const generatorId = requiredEnvironmentIdentifier("SUCCESSOR_REMOTE_PROCESS_GENERATOR_ID", "generatorId");
  const phase = process.env.SUCCESSOR_REMOTE_PROCESS_PHASE;
  const sourceHash = process.env.SUCCESSOR_REMOTE_PROCESS_SOURCE_HASH;
  const requestHash = process.env.SUCCESSOR_REMOTE_PROCESS_REQUEST_HASH;
  if (!PHASES.has(phase)) throw new ProtocolError("INVALID_PHASE", "phase runner environment names an unsupported phase");
  if (!SOURCE_HASH_PATTERN.test(sourceHash ?? "")) throw new ProtocolError("INVALID_SOURCE_HASH", "phase runner source hash is invalid");
  if (!SOURCE_HASH_PATTERN.test(requestHash ?? "")) throw new ProtocolError("INVALID_REQUEST_HASH", "phase runner request hash is invalid");
  const root = path.resolve(process.env.SUCCESSOR_REMOTE_PROCESS_REPO_ROOT ?? repoRoot);
  const runRoot = path.resolve(process.env.SUCCESSOR_REMOTE_PROCESS_RUN_ROOT ?? defaultRunRoot);
  const context = { operation: "start", runId, sourceHash, generatorId, phase, requestHash };
  return { root, context, paths: phasePaths(runRoot, context) };
}

function validateStoredPhaseInput(value, context) {
  if (!isRecord(value) || value.schema !== STORED_PHASE_INPUT_SCHEMA ||
      value.runId !== context.runId || value.sourceHash !== context.sourceHash ||
      value.generatorId !== context.generatorId || value.phase !== context.phase ||
      value.requestHash !== context.requestHash || !isRecord(value.input)) {
    throw new ProtocolError("INVALID_STORED_PHASE_INPUT", "stored phase input failed request binding validation");
  }
  if (context.phase === "generator") {
    const canonical = canonicalGeneratorRequest(value.input);
    if (sha256Json(canonical) !== context.requestHash) {
      throw new ProtocolError("INVALID_STORED_PHASE_INPUT", "stored generator input does not match its request hash");
    }
    value.input = canonical;
    return;
  }
  if (context.phase === "headless-preparation") {
    if (value.input.sourceHash !== context.sourceHash || !Array.isArray(value.input.sourcePaths) ||
        value.input.sourcePaths.length === 0 || value.input.sourcePaths.some((entry) => typeof entry !== "string")) {
      throw new ProtocolError("INVALID_STORED_PHASE_INPUT", "stored headless preparation input is invalid");
    }
    return;
  }
  if (typeof value.input.endpoint !== "string" || value.input.endpoint.length > 2048) {
    throw new ProtocolError("INVALID_STORED_PHASE_INPUT", "stored endpoint probe input is invalid");
  }
}

async function runFixedPhase(runtime, input) {
  const selected = fixedPhaseCommand(runtime.root, runtime.context.phase);
  const stdin = `${JSON.stringify(input)}\n`;
  if (Buffer.byteLength(stdin) > MAX_STORED_INPUT_BYTES) {
    throw new ProtocolError("PHASE_INPUT_TOO_LARGE", "stored phase stdin exceeds its byte limit");
  }
  const startedAt = new Date();
  const stdout = createBoundedCollector(MAX_STDOUT_BYTES);
  const stderr = createBoundedCollector(MAX_STDERR_BYTES);
  let spawnError = null;
  let inputError = null;
  let supervisorSignal = null;
  const child = spawn(selected.argv[0], selected.argv.slice(1), {
    cwd: runtime.root,
    env: process.env,
    detached: false,
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => stdout.add(chunk));
  child.stderr.on("data", (chunk) => stderr.add(chunk));
  child.once("error", (error) => {
    spawnError = errorSummary(error);
  });
  child.stdin.once("error", (error) => {
    inputError = errorSummary(error);
  });
  await waitForSpawn(child);
  await testHook("workload-spawned");
  const signalListeners = new Map();
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    const listener = () => {
      supervisorSignal ??= signal;
      try {
        child.kill(signal);
      } catch {
        // ProcessHost still owns the complete detached group.
      }
    };
    signalListeners.set(signal, listener);
    process.once(signal, listener);
  }
  child.stdin.end(stdin);
  const closed = await new Promise((resolve) => {
    child.once("close", (exitCode, signal) => resolve({ exitCode, signal }));
  });
  for (const [signal, listener] of signalListeners) process.removeListener(signal, listener);
  const finishedAt = new Date();
  const stdoutResult = stdout.result();
  const stderrResult = stderr.result();
  const captureError = stdoutResult.truncated || stderrResult.truncated
    ? { code: "PHASE_OUTPUT_LIMIT", message: "phase output exceeded its persisted byte limit" }
    : spawnError ? { code: "PHASE_SPAWN_FAILED", message: "fixed phase subprocess could not be spawned" }
      : inputError ? { code: "PHASE_STDIN_FAILED", message: "fixed phase subprocess did not accept its stored input" }
        : null;
  return {
    schema: REMOTE_PROCESS_HOST_PHASE_ENVELOPE_SCHEMA,
    status: captureError ? "error" : "complete",
    runId: runtime.context.runId,
    sourceHash: runtime.context.sourceHash,
    generatorId: runtime.context.generatorId,
    phase: runtime.context.phase,
    requestHash: runtime.context.requestHash,
    runner: { kind: "child", pid: process.pid },
    command: selected.public,
    process: {
      exitCode: Number.isInteger(closed.exitCode) ? closed.exitCode : null,
      signal: typeof closed.signal === "string" ? closed.signal : null,
      supervisorSignal,
      spawnError,
      inputError,
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs: Math.max(0, finishedAt.getTime() - startedAt.getTime()),
    },
    stdout: stdoutResult.text,
    stderr: stderrResult.text,
    stdoutBytes: stdoutResult.bytes,
    stderrBytes: stderrResult.bytes,
    stdoutTruncated: stdoutResult.truncated,
    stderrTruncated: stderrResult.truncated,
    ...(captureError ? { error: captureError } : {}),
  };
}

function fixedPhaseCommand(root, phase) {
  const definition = phase === "headless-preparation"
    ? { module: "tools/verification/load/headless-prep.mjs", flag: "--stdin" }
    : phase === "endpoint-reachability"
      ? { module: "tools/verification/load/endpoint-probe.mjs", flag: "--stdin" }
      : { module: "tools/verification/load/player-load.mjs", flag: "--generator-stdin" };
  return {
    argv: [process.execPath, path.join(root, ...definition.module.split("/")), definition.flag],
    public: { id: phase, executable: "node", module: definition.module, argv: [definition.flag] },
  };
}

function phaseRunnerErrorEnvelope(runtime, error) {
  const now = new Date().toISOString();
  return {
    schema: REMOTE_PROCESS_HOST_PHASE_ENVELOPE_SCHEMA,
    status: "error",
    runId: runtime.context.runId,
    sourceHash: runtime.context.sourceHash,
    generatorId: runtime.context.generatorId,
    phase: runtime.context.phase,
    requestHash: runtime.context.requestHash,
    runner: { kind: "child", pid: process.pid },
    command: { id: runtime.context.phase, executable: "node", module: null, argv: [] },
    process: {
      exitCode: null,
      signal: null,
      supervisorSignal: null,
      spawnError: null,
      inputError: null,
      startedAt: now,
      finishedAt: now,
      durationMs: 0,
    },
    stdout: "",
    stderr: "",
    stdoutBytes: 0,
    stderrBytes: 0,
    stdoutTruncated: false,
    stderrTruncated: false,
    error: {
      code: error instanceof ProtocolError ? error.code : "PHASE_RUNNER_FAILED",
      message: error instanceof ProtocolError ? error.message : "phase runner failed before subprocess completion",
    },
  };
}

function createBoundedCollector(limit) {
  const chunks = [];
  let captured = 0;
  let bytes = 0;
  return {
    add(value) {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      bytes += chunk.length;
      const remaining = limit - captured;
      if (remaining <= 0) return;
      const accepted = chunk.length <= remaining ? chunk : chunk.subarray(0, remaining);
      chunks.push(accepted);
      captured += accepted.length;
    },
    result() {
      return { text: Buffer.concat(chunks, captured).toString("utf8"), bytes, truncated: bytes > captured };
    },
  };
}

async function writePhaseEnvelope(file, envelope) {
  let document = envelope;
  const encoded = `${JSON.stringify(document)}\n`;
  if (Buffer.byteLength(encoded) > MAX_PHASE_ENVELOPE_BYTES) {
    document = {
      ...envelope,
      status: "error",
      stdout: "",
      stderr: "",
      stdoutTruncated: true,
      stderrTruncated: true,
      error: { code: "PHASE_ENVELOPE_LIMIT", message: "serialized phase envelope exceeded its byte limit" },
    };
  }
  await writeJsonAtomicBounded(file, document, MAX_PHASE_ENVELOPE_BYTES, "PHASE_ENVELOPE_LIMIT");
}

async function writeJsonAtomicBounded(file, value, maxBytes, code) {
  const text = `${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(text) > maxBytes) throw new ProtocolError(code, `JSON document exceeds ${maxBytes} bytes`);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temporary, text, { encoding: "utf8", flag: "wx", mode: 0o600 });
  try {
    await fs.rename(temporary, file);
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function readJsonBounded(file, maxBytes) {
  const stat = await fs.lstat(file);
  if (!stat.isFile()) throw new ProtocolError("INVALID_JSON_DOCUMENT", "protocol path is not a regular file");
  if (stat.size > maxBytes) throw new ProtocolError("INVALID_JSON_DOCUMENT", "protocol JSON document exceeds its byte limit");
  const text = await fs.readFile(file, "utf8");
  try {
    return JSON.parse(text);
  } catch (cause) {
    throw new ProtocolError("INVALID_JSON_DOCUMENT", "protocol JSON document is malformed", { cause });
  }
}

async function readProtocolStdin() {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > MAX_PROTOCOL_INPUT_BYTES) {
      throw new ProtocolError("PROTOCOL_INPUT_TOO_LARGE", "remote ProcessHost request exceeds its byte limit");
    }
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks, bytes).toString("utf8").trim();
  if (!text) throw new ProtocolError("INVALID_PROTOCOL_REQUEST", "remote ProcessHost request is empty");
  try {
    return JSON.parse(text);
  } catch (cause) {
    throw new ProtocolError("INVALID_PROTOCOL_REQUEST", "remote ProcessHost request is not valid JSON", { cause });
  }
}

async function protocolMain() {
  let request;
  let document;
  try {
    request = await readProtocolStdin();
    document = await handleRemoteProcessHostRequest(request);
  } catch (error) {
    document = errorDocument(partialContext(request), error);
  }
  process.stdout.write(`${JSON.stringify(document)}\n`);
  process.exitCode = document.status === "ok" ? 0 : 1;
}

function boundedInteger(value, label, { min, max, required, fallback } = {}) {
  if (value === undefined && !required) return fallback;
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new ProtocolError("INVALID_TIMEOUT", `${label} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function positiveInteger(value, label) {
  if (!Number.isInteger(value) || value <= 0 || value > Number.MAX_SAFE_INTEGER) {
    throw new ProtocolError("INVALID_HANDLE", `${label} must be a positive integer`);
  }
  return value;
}

function requiredEnvironmentIdentifier(name, label) {
  const value = process.env[name];
  if (!IDENTIFIER_PATTERN.test(value ?? "")) throw new ProtocolError("INVALID_PHASE_ENVIRONMENT", `phase runner ${label} is invalid`);
  return value;
}
function testDeadlineOverride() {
  const value = Number(process.env.SUCCESSOR_REMOTE_PROCESS_TEST_DEADLINE_MS);
  return Number.isSafeInteger(value) && value >= 100 && value <= 60_000 ? value : null;
}

async function testHook(event, fields = {}) {
  const directory = process.env.SUCCESSOR_REMOTE_PROCESS_TEST_HOOK_DIR;
  if (!directory) return;
  const root = path.resolve(directory);
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(path.join(root, `${event}.json`), `${JSON.stringify({ event, pid: process.pid, at: Date.now(), ...fields })}\n`, { encoding: "utf8", mode: 0o600 });
}

async function awaitTestReleaseBarrier(deadlineAt) {
  const file = process.env.SUCCESSOR_REMOTE_PROCESS_TEST_PAUSE_BEFORE_RELEASE_FILE;
  if (!file) return;
  const barrier = path.resolve(file);
  await testHook("protocol-before-release");
  while (Date.now() <= deadlineAt) {
    const released = await fs.stat(barrier).then(() => true, (error) => error?.code === "ENOENT" ? false : Promise.reject(error));
    if (released) return;
    await delay(GATE_POLL_INTERVAL_MS);
  }
  throw new ProtocolError("TEST_RELEASE_BARRIER_EXPIRED", "test-only release barrier was not opened before the phase deadline");
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}


function validIdentifierOrNull(value) {
  return IDENTIFIER_PATTERN.test(value ?? "") ? value : null;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function errorSummary(error) {
  return {
    code: typeof error?.code === "string" ? error.code : "UNKNOWN_ERROR",
    message: String(error?.message ?? "process error").slice(0, 1024),
  };
}

class ProtocolError extends Error {
  constructor(code, message, { cause } = {}) {
    super(message, { cause });
    this.name = "ProtocolError";
    this.code = code;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2);
  const run = argv.length === 1 && argv[0] === "--phase-run"
    ? phaseRunMain
    : argv.length === 1 && argv[0] === "--watchdog-run"
      ? watchdogRunMain
      : argv.length === 1 && argv[0] === "--sentinel-run"
        ? sentinelRunMain
        : null;
  if (run) {
    run().catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
  } else if (argv.length === 0 || (argv.length === 1 && argv[0] === "--protocol-stdin")) {
    protocolMain().catch((error) => {
      const document = errorDocument(partialContext(null), error);
      process.stdout.write(`${JSON.stringify(document)}\n`);
      process.exitCode = 1;
    });
  } else {
    const document = errorDocument(partialContext(null), new ProtocolError("INVALID_CLI_MODE", "expected --protocol-stdin, --phase-run, --watchdog-run, or --sentinel-run"));
    process.stdout.write(`${JSON.stringify(document)}\n`);
    process.exitCode = 1;
  }
}
