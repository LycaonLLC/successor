import { FarmError, repoRoot, runProcess as defaultRunProcess } from "../farm/common.mjs";
import { runMacPreflight } from "../farm/preflight.mjs";
import { sha256Json, validateId } from "../farm/protocol.mjs";
import { REMOTE_CHECKOUT } from "../farm/sync.mjs";
import { validateRelativeSourcePath } from "../farm/source-hash.mjs";

export const REMOTE_PLAYER_GENERATOR_REQUEST_SCHEMA = "successor.player-load-generator-request.v1";
export const REMOTE_PLAYER_GENERATOR_SCHEMA = "successor.player-load-generator.v2";
export const MAX_REMOTE_PLAYER_CLIENTS = 16;

const SSH_OPTIONS = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=8"];
const REMOTE_PROCESS_HOST = `${REMOTE_CHECKOUT}/tools/verification/farm/remote-process-host.mjs`;
const REMOTE_PROCESS_HOST_REQUEST_SCHEMA = "successor.remote-process-host-request.v1";
const REMOTE_PROCESS_HOST_RESPONSE_SCHEMA = "successor.remote-process-host-response.v1";
const REMOTE_PROCESS_HOST_HANDLE_SCHEMA = "successor.remote-process-host-handle.v1";
const REMOTE_PROCESS_HOST_PHASE_ENVELOPE_SCHEMA = "successor.remote-process-host-phase-envelope.v1";
const REMOTE_PHASES = Object.freeze({
  headlessPreparation: "headless-preparation",
  endpointReachability: "endpoint-reachability",
  generator: "generator",
});
const REMOTE_PHASE_CLEANUP_TIMEOUT_MS = 10_000;
const REMOTE_PHASE_STOP_GRACE_MS = 3_000;
const REMOTE_PHASE_RECOVERY_ATTEMPTS = 3;
const REMOTE_PHASE_CLEANUP_ATTEMPTS = 3;

/**
 * Runs one bounded group of actual player clients on the Mac. The source is
 * synchronized and rebound immediately before the fixed-argv SSH invocation;
 * runtime options enter only the checked JSON stdin envelope.
 */
export async function executeMacPlayerGenerator(options = {}) {
  const prepared = await prepareMacPlayerGenerator(options);
  return launchPreparedMacPlayerGenerator(prepared);
}

export async function prepareMacPlayerGenerator({
  root = repoRoot, host, endpoint, clients, durationMs, rampIntervalMs = 500, sampleIntervalMs = 1_000, runId, sourceHash, sourcePaths, generatorId = "mac", identityNamespace = generatorId, clientOffset = 0, expectedServerActiveSessions, preflight = runMacPreflight, runProcess = defaultRunProcess, syncAttempts, signal, remoteSupervisor,
} = {}) {
  const request = createRemotePlayerGeneratorRequest({ endpoint, clients, durationMs, rampIntervalMs, sampleIntervalMs, runId, sourceHash, sourcePaths, generatorId, identityNamespace, clientOffset, expectedServerActiveSessions });
  validateSshHost(host);
  let preflightDocument;
  try {
    preflightDocument = await preflight({ root, host, ...(syncAttempts === undefined ? {} : { syncAttempts }) });
    assertRemoteGeneratorPreflight(preflightDocument, request, host);
  } catch (error) {
    throw new FarmError("remote player generator preflight failed", { code: "REMOTE_GENERATOR_PREFLIGHT_FAILED", details: remoteDiagnostics({ stage: "preflight", host, request, error }), cause: error });
  }
  const supervisor = remoteSupervisor ?? createRemoteProcessSupervisor({ host, request, runProcess, signal });
  assertRemoteSupervisor(supervisor);
  const headlessPrep = await runRemotePhase({
    supervisor,
    phase: REMOTE_PHASES.headlessPreparation,
    request,
    host,
    timeoutMs: 16 * 60_000,
    stage: "headless-preparation",
    parse: parseRemoteHeadlessPrep,
    validate: assertRemoteHeadlessPrep,
  });
  const endpointProbe = await runRemotePhase({
    supervisor,
    phase: REMOTE_PHASES.endpointReachability,
    request,
    host,
    timeoutMs: 20_000,
    stage: "endpoint-reachability",
    parse: parseRemoteEndpointProbe,
    validate: assertRemoteEndpointProbe,
  });
  return { root, host, request, preflight: preflightDocument, headlessPrep, endpointProbe, runProcess, signal, remoteSupervisor: supervisor };
}

export async function launchPreparedMacPlayerGenerator({ host, request, preflight, headlessPrep, endpointProbe, runProcess = defaultRunProcess, signal, remoteSupervisor } = {}) {
  const supervisor = remoteSupervisor ?? createRemoteProcessSupervisor({ host, request, runProcess, signal });
  assertRemoteSupervisor(supervisor);
  const result = await runRemotePhase({
    supervisor,
    phase: REMOTE_PHASES.generator,
    request,
    host,
    timeoutMs: remoteGeneratorDeadline(request),
    stage: "launch",
    parse: parseRemoteGeneratorResult,
    validate: validateRemoteGeneratorResult,
  });
  return { result, preflight, headlessPrep, endpointProbe };
}

export function createRemotePlayerGeneratorRequest({ endpoint, clients, durationMs, rampIntervalMs, sampleIntervalMs, runId, sourceHash, sourcePaths, generatorId, identityNamespace = generatorId, clientOffset = 0, expectedServerActiveSessions }) {
  const parsedEndpoint = validateRemoteEndpoint(endpoint);
  validateId(runId, "load runId");
  validateId(generatorId, "generatorId");
  if (typeof sourceHash !== "string" || !/^[a-f0-9]{64}$/u.test(sourceHash)) {
    throw new FarmError("remote player generator requires the full source hash shared with its local generator", { code: "INVALID_SOURCE_HASH" });
  }
  if (!Array.isArray(sourcePaths) || sourcePaths.length === 0 || sourcePaths.some((sourcePath) => typeof sourcePath !== "string")) {
    throw new FarmError("remote player generator requires the signed canonical manifest path list", { code: "INVALID_SOURCE_PATHS" });
  }
  for (const sourcePath of sourcePaths) validateRelativeSourcePath(sourcePath);
  if (!Number.isInteger(clients) || clients < 1 || clients > MAX_REMOTE_PLAYER_CLIENTS) {
    throw new FarmError(`remote player client count must be between 1 and ${MAX_REMOTE_PLAYER_CLIENTS}`, { code: "REMOTE_CLIENT_LIMIT" });
  }
  if (!Number.isInteger(durationMs) || durationMs < 1_000 || durationMs > 10 * 60_000) {
    throw new FarmError("remote player duration must be between 1 second and 10 minutes", { code: "INVALID_LOAD_DURATION" });
  }
  if (!Number.isInteger(rampIntervalMs) || rampIntervalMs < 100 || rampIntervalMs > 30_000) {
    throw new FarmError("remote player ramp interval must be between 100ms and 30s", { code: "INVALID_RAMP_INTERVAL" });
  }
  if (!Number.isInteger(sampleIntervalMs) || sampleIntervalMs < 100 || sampleIntervalMs > 30_000) {
    throw new FarmError("remote player sample interval must be between 100ms and 30s", { code: "INVALID_SAMPLE_INTERVAL" });
  }
  if (typeof identityNamespace !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/u.test(identityNamespace) || !Number.isInteger(clientOffset) || clientOffset < 0) {
    throw new FarmError("remote player generator identity namespace or offset is invalid", { code: "INVALID_IDENTITY_NAMESPACE" });
  }
  if (expectedServerActiveSessions !== undefined && (!Number.isInteger(expectedServerActiveSessions) || expectedServerActiveSessions < clients || expectedServerActiveSessions > 64)) throw new FarmError("expected combined server sessions is invalid", { code: "INVALID_EXPECTED_SERVER_SESSIONS" });
  return {
    schema: REMOTE_PLAYER_GENERATOR_REQUEST_SCHEMA,
    runId,
    sourceHash,
    sourcePaths: [...new Set(sourcePaths)].sort(),
    generatorId,
    identityNamespace,
    clientOffset,
    endpoint: parsedEndpoint.toString(),
    clients,
    durationMs,
    rampIntervalMs,
    sampleIntervalMs,
    ...(expectedServerActiveSessions === undefined ? {} : { expectedServerActiveSessions }),
  };
}

export function validateRemoteGeneratorResult(result, request) {
  validateRemoteGeneratorCompletion(result, request);
  if (result.status !== "pass") {
    throw new FarmError("remote player generator did not return a passing result", { code: "REMOTE_GENERATOR_FAILED" });
  }
  if (result.clients?.requested !== request.clients || result.clients?.identityJoined !== request.clients || result.clients?.joined !== request.clients) {
    throw new FarmError("remote player generator did not identity-join every requested player client", { code: "REMOTE_GENERATOR_JOIN_INCOMPLETE" });
  }
  if (!Number.isInteger(result.commands?.sent) || result.commands.sent < request.clients ||
      !Number.isInteger(result.commands?.receipts) || result.commands.receipts < request.clients) {
    throw new FarmError("remote player generator did not prove authority command receipts for every client", { code: "REMOTE_GENERATOR_RECEIPT_INCOMPLETE" });
  }
  if (result.teardown?.attempted !== true || result.teardown?.clean !== true) {
    throw new FarmError("remote player generator did not prove clean client teardown", { code: "REMOTE_GENERATOR_TEARDOWN_FAILED" });
  }
  assertLatency(result.latency?.joinMs, "join");
  assertLatency(result.latency?.receiptMs, "receipt");
  return result;
}

function validateRemoteGeneratorCompletion(result, request) {
  if (!result || result.schema !== REMOTE_PLAYER_GENERATOR_SCHEMA || !["pass", "fail"].includes(result.status)) {
    throw new FarmError("remote player generator emitted no completed result document", { code: "INVALID_REMOTE_GENERATOR_RESULT" });
  }
  const { checksum, ...unsigned } = result;
  if (typeof checksum !== "string" || checksum !== sha256Json(unsigned)) {
    throw new FarmError("remote player generator result checksum mismatch", { code: "REMOTE_GENERATOR_CHECKSUM_MISMATCH" });
  }
  if (result.runId !== request.runId || result.sourceHash !== request.sourceHash || result.generatorId !== request.generatorId) {
    throw new FarmError("remote player generator result is not bound to its request", { code: "REMOTE_GENERATOR_BINDING_MISMATCH" });
  }
  if (result.status === "fail" && !Array.isArray(result.errors)) {
    throw new FarmError("remote player generator failure report lacks its error records", { code: "INVALID_REMOTE_GENERATOR_RESULT" });
  }
  return result;
}

function assertRemoteGeneratorPreflight(document, request, host) {
  if (!document || !["ready", "ready-with-pending"].includes(document.status) || document.host !== host ||
      document.checkout !== REMOTE_CHECKOUT || document.source?.match !== true ||
      document.source?.localHash !== request.sourceHash || document.source?.remoteHash !== request.sourceHash) {
    throw new FarmError("remote player generator refused because full source parity was not established", { code: "REMOTE_PREFLIGHT_REFUSED" });
  }
  if (document.capabilities?.toolchain?.node?.available !== true || document.capabilities?.toolchain?.pnpm?.available !== true || document.capabilities?.runtime?.processHost?.available !== true) {
    throw new FarmError("remote player generator host lacks required Node/pnpm/process-host capabilities", { code: "REMOTE_GENERATOR_CAPABILITY_MISMATCH" });
  }
}

function assertRemoteHeadlessPrep(document, request, host) {
  const source = document?.source;
  if (document?.status !== "pass" || source?.match !== true ||
      source.beforeHash !== request.sourceHash || source.afterHash !== request.sourceHash || source.expectedHash !== request.sourceHash) {
    throw new FarmError("Mac headless client preparation failed, changed source, or was not bound to this request", {
      code: "REMOTE_HEADLESS_PREPARATION_FAILED",
      details: remoteDiagnostics({ stage: "headless-preparation", host, request, remoteDocument: document }),
    });
  }
}

function assertRemoteEndpointProbe(document, request, host) {
  const expectedOrigin = new URL(request.endpoint).origin;
  if (document?.status !== "pass" || document.endpoint !== expectedOrigin ||
      !nonemptyString(document.shardId) || !nonemptyString(document.source?.stateHash) || !nonemptyString(document.source?.sliceHash)) {
    throw new FarmError("Mac endpoint probe failed, was not request-bound, or lacks authoritative source metadata", {
      code: "REMOTE_ENDPOINT_UNREACHABLE",
      details: remoteDiagnostics({ stage: "endpoint-reachability", host, request, remoteDocument: document }),
    });
  }
}

function nonemptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function validateRemoteEndpoint(endpoint) {
  let parsed;
  try {
    parsed = new URL(endpoint);
  } catch (cause) {
    throw new FarmError("remote player endpoint must be an absolute http or https URL", { code: "INVALID_REMOTE_ENDPOINT", cause });
  }
  if (!["http:", "https:"].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash || isLoopbackHost(parsed.hostname)) {
    throw new FarmError("remote player endpoint must be a non-loopback http or https authority URL without credentials", { code: "INVALID_REMOTE_ENDPOINT" });
  }
  return parsed;
}

function isLoopbackHost(hostname) {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/gu, "");
  return normalized === "localhost" || normalized === "::1" || normalized === "0.0.0.0" || normalized.startsWith("127.");
}

function validateSshHost(host) {
  if (typeof host !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/u.test(host)) {
    throw new FarmError("remote player generator host must be a configured safe SSH alias", { code: "INVALID_FARM_HOST" });
  }
}

function parseRemoteGeneratorResult(stdout) {
  try {
    return JSON.parse(stdout);
  } catch (cause) {
    throw new FarmError("remote player generator emitted an invalid JSON result", { code: "INVALID_REMOTE_GENERATOR_RESULT", cause });
  }
}

function parseRemoteHeadlessPrep(stdout) {
  const document = parseJsonOrNull(stdout);
  if (document?.schema === "successor.player-load-headless-prep.v1") return document;
  throw new FarmError("remote headless preparation emitted no valid document", { code: "INVALID_REMOTE_HEADLESS_PREPARATION" });
}

function parseRemoteEndpointProbe(stdout) {
  const document = parseJsonOrNull(stdout);
  if (document?.schema === "successor.player-load-endpoint-probe.v1") return document;
  throw new FarmError("remote endpoint reachability probe emitted no valid document", { code: "INVALID_REMOTE_ENDPOINT_PROBE" });
}

async function runRemotePhase({ supervisor, phase, request, host, timeoutMs, stage, parse, validate }) {
  let handle = null;
  let output;
  let primaryError = null;
  try {
    try {
      const started = await supervisor.start({ phase, request, timeoutMs });
      handle = remotePhaseHandle(started, { phase, request });
    } catch (startError) {
      try {
        handle = await recoverRemotePhase(supervisor, { phase, request });
      } catch (recoveryError) {
        primaryError = new AggregateError([startError, recoveryError], "remote phase launch failed and its request-scoped handle could not be recovered");
      }
    }
    if (!primaryError) {
      let awaited;
      try {
        awaited = await supervisor.await({ phase, request, handle, timeoutMs });
      } catch (error) {
        throw remotePhaseAwaitFailure({ stage, host, request, error });
      }
      const envelope = remotePhaseEnvelope(awaited, { phase, request });
      if (phase === REMOTE_PHASES.generator) {
        output = consumeRemoteGeneratorEnvelope({ stage, host, request, envelope });
      } else {
        if (envelope.status !== "complete" || envelope.process?.exitCode !== 0 || envelope.process?.signal !== null || envelope.stdoutTruncated || envelope.stderrTruncated) {
          throw remotePhaseInvocationFailure({ stage, host, request, envelope });
        }
        output = parse(envelope.stdout);
        validate(output, request, host);
      }
    }
  } catch (error) {
    primaryError = error;
  } finally {
    // A lost public response is not proof that nothing registered remotely.
    // Recover before every cleanup decision; bounded attempts avoid holding the
    // caller forever while the remote watchdog enforces the hard deadline.
    if (!handle) {
      try {
        handle = await recoverRemotePhase(supervisor, { phase, request });
      } catch (recoveryError) {
        primaryError ??= recoveryError;
      }
    }
    if (handle) {
      const cleanup = await stopAndAssertRemotePhase(supervisor, { phase, request, handle });
      if (!cleanup.ok) {
        const cleanupError = new FarmError("remote player phase did not tear down cleanly", {
          code: "REMOTE_GENERATOR_TEARDOWN_FAILED",
          details: { stage, host, phase, failures: cleanup.failures },
        });
        primaryError = primaryError
          ? new AggregateError([primaryError, cleanupError], "remote player phase failed and remote cleanup also failed")
          : cleanupError;
      }
    }
  }
  if (primaryError) throw primaryError;
  return output;
}

async function recoverRemotePhase(supervisor, { phase, request }) {
  const failures = [];
  for (let attempt = 1; attempt <= REMOTE_PHASE_RECOVERY_ATTEMPTS; attempt += 1) {
    try {
      const recovered = await supervisor.recover({ phase, request });
      return remotePhaseHandle(recovered, { phase, request });
    } catch (error) {
      failures.push(error);
    }
  }
  throw new AggregateError(failures, `request-bound remote phase recovery failed after ${REMOTE_PHASE_RECOVERY_ATTEMPTS} attempts`);
}

async function stopAndAssertRemotePhase(supervisor, { phase, request, handle }) {
  const failures = [];
  let stopped = null;
  let asserted = null;
  for (let attempt = 1; attempt <= REMOTE_PHASE_CLEANUP_ATTEMPTS; attempt += 1) {
    const attemptFailures = [];
    try {
      stopped = await supervisor.stop({ phase, request, handle, graceMs: REMOTE_PHASE_STOP_GRACE_MS });
      if (stopped?.lifecycle?.ok !== true && stopped?.ok !== true) attemptFailures.push(`attempt ${attempt}: stop returned non-ok`);
    } catch (error) {
      attemptFailures.push(`attempt ${attempt}: stop threw: ${errorMessage(error)}`);
    }
    try {
      asserted = await supervisor.assertStopped({ phase, request, handle, timeoutMs: REMOTE_PHASE_CLEANUP_TIMEOUT_MS });
      if (asserted?.lifecycle?.ok !== true && asserted?.ok !== true) attemptFailures.push(`attempt ${attempt}: assertStopped returned non-ok`);
    } catch (error) {
      attemptFailures.push(`attempt ${attempt}: assertStopped threw: ${errorMessage(error)}`);
    }
    if (attemptFailures.length === 0) return { ok: true, stopped, asserted, failures: [] };
    failures.push(...attemptFailures);
  }
  return { ok: false, stopped, asserted, failures };
}

function remotePhaseHandle(started, { phase, request }) {
  const handle = started?.handle ?? started;
  if (!handle || handle.schema !== REMOTE_PROCESS_HOST_HANDLE_SCHEMA || handle.runId !== request.runId ||
      handle.sourceHash !== request.sourceHash || handle.generatorId !== request.generatorId || handle.phase !== phase ||
      handle.requestHash !== sha256Json(request)) {
    throw new FarmError("remote ProcessHost did not register a request-bound phase handle", { code: "REMOTE_PROCESS_HANDLE_INVALID" });
  }
  return handle;
}

function remotePhaseEnvelope(awaited, { phase, request }) {
  const envelope = awaited?.envelope;
  if (awaited?.status === "error") {
    throw new FarmError("remote ProcessHost could not await the registered phase", {
      code: "REMOTE_PROCESS_AWAIT_FAILED",
      details: { phase, remote: summarizeRemoteDocument(awaited) },
    });
  }
  if (!envelope || envelope.schema !== REMOTE_PROCESS_HOST_PHASE_ENVELOPE_SCHEMA || envelope.runId !== request.runId ||
      envelope.sourceHash !== request.sourceHash || envelope.generatorId !== request.generatorId || envelope.phase !== phase ||
      envelope.requestHash !== sha256Json(request)) {
    throw new FarmError("remote ProcessHost emitted an invalid phase envelope", { code: "INVALID_REMOTE_PHASE_ENVELOPE" });
  }
  return envelope;
}

function remotePhaseInvocationFailure({ stage, host, request, envelope }) {
  const code = stage === "headless-preparation"
    ? "REMOTE_HEADLESS_PREPARATION_INVOCATION_FAILED"
    : stage === "endpoint-reachability"
      ? "REMOTE_ENDPOINT_PROBE_INVOCATION_FAILED"
      : "REMOTE_GENERATOR_SSH_LOST";
  return new FarmError("remote player phase did not complete successfully", {
    code,
    details: remoteDiagnostics({ stage, host, request, remoteDocument: envelope }),
  });
}

function consumeRemoteGeneratorEnvelope({ stage, host, request, envelope }) {
  if (envelope.status !== "complete") throw remotePhaseInvocationFailure({ stage, host, request, envelope });
  if (envelope.stdoutTruncated) throw remoteGeneratorProcessFailure({ stage, host, request, envelope });

  let result;
  try {
    result = parseRemoteGeneratorResult(envelope.stdout);
    validateRemoteGeneratorCompletion(result, request);
  } catch (error) {
    if (["REMOTE_GENERATOR_CHECKSUM_MISMATCH", "REMOTE_GENERATOR_BINDING_MISMATCH"].includes(error?.code)) throw error;
    if (!remotePhaseProcessSucceeded(envelope)) {
      throw remoteGeneratorProcessFailure({ stage, host, request, envelope, error });
    }
    throw error;
  }

  if (result.status === "fail" && envelope.process?.signal === null) {
    throw remoteGeneratorReportedFailure({ stage, host, request, envelope, result });
  }
  if (!remotePhaseProcessSucceeded(envelope)) {
    throw remoteGeneratorProcessFailure({ stage, host, request, envelope });
  }
  return validateRemoteGeneratorResult(result, request);
}

function remotePhaseProcessSucceeded(envelope) {
  return envelope.process?.exitCode === 0 && envelope.process?.signal === null && !envelope.stdoutTruncated && !envelope.stderrTruncated;
}

function remoteGeneratorReportedFailure({ stage, host, request, envelope, result }) {
  return new FarmError("remote player generator reported a failure", {
    code: "REMOTE_GENERATOR_REPORTED_FAILURE",
    details: remoteDiagnostics({ stage, host, request, remoteDocument: result, phaseEnvelope: envelope }),
  });
}

function remoteGeneratorProcessFailure({ stage, host, request, envelope, error }) {
  return new FarmError("remote player generator process ended without a valid failure report", {
    code: "REMOTE_GENERATOR_PROCESS_FAILED",
    details: remoteDiagnostics({ stage, host, request, remoteDocument: parseJsonOrNull(envelope.stdout), phaseEnvelope: envelope, error }),
    cause: error,
  });
}

function remotePhaseAwaitFailure({ stage, host, request, error }) {
  if (stage !== "launch" || error?.code === "REMOTE_PROCESS_AWAIT_FAILED") return error;
  return new FarmError("remote player generator await channel was lost before a completed result was received", {
    code: "REMOTE_GENERATOR_SSH_LOST",
    details: remoteDiagnostics({ stage, host, request, error }),
    cause: error,
  });
}

function assertRemoteSupervisor(supervisor) {
  if (!supervisor || !["start", "recover", "await", "stop", "assertStopped"].every((method) => typeof supervisor[method] === "function")) {
    throw new FarmError("remote player generator requires a request-scoped remote ProcessHost supervisor", { code: "REMOTE_PROCESS_SUPERVISOR_REQUIRED" });
  }
}

function createRemoteProcessSupervisor({ host, request, runProcess, signal }) {
  const invoke = async (operation, phase, handle, options = {}, { cleanup = false, boundRequest = request } = {}) => {
    const protocol = {
      schema: REMOTE_PROCESS_HOST_REQUEST_SCHEMA,
      operation,
      phase,
      request: boundRequest,
      ...(handle ? { handle } : {}),
      ...options,
    };
    const invocation = await runProcess(
      "ssh",
      [...SSH_OPTIONS, host, "env", "SUCCESSOR_PROCESS_HOST=child", "node", REMOTE_PROCESS_HOST, "--protocol-stdin"],
      {
        input: JSON.stringify(protocol),
        timeoutMs: cleanup
          ? REMOTE_PHASE_CLEANUP_TIMEOUT_MS
          : Math.min(31 * 60_000, Math.max(20_000, (options.timeoutMs ?? 20_000) + 10_000)),
        maxOutputBytes: 2 * 1024 * 1024,
        ...(!cleanup && signal ? { signal } : {}),
      },
    );
    const document = parseJsonOrNull(invocation?.stdout);
    if (!invocation?.ok && !document) {
      throw new FarmError("remote ProcessHost SSH operation was lost or timed out", {
        code: "REMOTE_PROCESS_SUPERVISOR_SSH_LOST",
        details: remoteDiagnostics({ stage: "remote-process-supervisor", host, request: boundRequest, invocation, remoteDocument: document }),
        cause: invocation?.error,
      });
    }
    validateRemoteProcessHostResponse(document, { operation, phase, request: boundRequest });
    if (document.status !== "ok") {
      throw new FarmError("remote ProcessHost rejected a lifecycle operation", {
        code: "REMOTE_PROCESS_SUPERVISOR_OPERATION_FAILED",
        details: remoteDiagnostics({ stage: "remote-process-supervisor", host, request: boundRequest, invocation, remoteDocument: document }),
      });
    }
    if (!invocation.ok && operation !== "start") {
      throw new FarmError("remote ProcessHost transport exited non-zero after a pass-shaped response", {
        code: "REMOTE_PROCESS_SUPERVISOR_SSH_LOST",
        details: remoteDiagnostics({ stage: "remote-process-supervisor", host, request: boundRequest, invocation, remoteDocument: document }),
        cause: invocation.error,
      });
    }
    return document;
  };
  return {
    start: ({ phase, request: boundRequest }) => invoke("start", phase, null, {}, { boundRequest, cleanup: false }),
    recover: ({ phase, request: boundRequest }) => invoke("recover", phase, null, {}, { boundRequest, cleanup: true }),
    await: ({ phase, request: boundRequest, handle, timeoutMs }) => invoke("await", phase, handle, { timeoutMs }, { boundRequest, cleanup: false }),
    stop: ({ phase, request: boundRequest, handle, graceMs }) => invoke("stop", phase, handle, { graceMs }, { boundRequest, cleanup: true }),
    assertStopped: ({ phase, request: boundRequest, handle, timeoutMs }) => invoke("assertStopped", phase, handle, { timeoutMs }, { boundRequest, cleanup: true }),
  };
}

function validateRemoteProcessHostResponse(document, { operation, phase, request }) {
  if (!document || document.schema !== REMOTE_PROCESS_HOST_RESPONSE_SCHEMA ||
      !["ok", "error"].includes(document.status) || document.operation !== operation || document.phase !== phase ||
      document.runId !== request.runId || document.sourceHash !== request.sourceHash || document.generatorId !== request.generatorId ||
      document.requestHash !== sha256Json(request)) {
    throw new FarmError("remote ProcessHost response was not bound to its request", { code: "REMOTE_PROCESS_SUPERVISOR_BINDING_MISMATCH" });
  }
  const { checksum, ...unsigned } = document;
  if (typeof checksum !== "string" || checksum !== sha256Json(unsigned)) {
    throw new FarmError("remote ProcessHost response checksum mismatch", { code: "REMOTE_PROCESS_SUPERVISOR_CHECKSUM_MISMATCH" });
  }
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function remoteDiagnostics({ stage, host, request, invocation, remoteDocument, phaseEnvelope, error }) {
  return {
    stage,
    host,
    checkout: REMOTE_CHECKOUT,
    endpoint: new URL(request.endpoint).origin,
    node: { command: "node", module: REMOTE_PROCESS_HOST },
    ...(phaseEnvelope ? { process: summarizeRemotePhaseProcess(phaseEnvelope) } : invocation ? { process: { reason: remoteFailureReason(invocation), exitCode: invocation.exitCode, signal: invocation.signal, timedOut: Boolean(invocation.timedOut), aborted: Boolean(invocation.aborted), stderr: redactedStderr(invocation.stderr) } } : {}),
    ...(remoteDocument ? { remote: summarizeRemoteDocument(remoteDocument) } : {}),
    ...(error ? { causeCode: error?.code ?? "UNEXPECTED_ERROR" } : {}),
  };
}

function summarizeRemotePhaseProcess(envelope) {
  return {
    reason: `exit-${envelope.process?.exitCode}${envelope.process?.signal ? `-${envelope.process.signal}` : ""}`,
    exitCode: envelope.process?.exitCode ?? null,
    signal: envelope.process?.signal ?? null,
    stdoutTruncated: Boolean(envelope.stdoutTruncated),
    stderrTruncated: Boolean(envelope.stderrTruncated),
    stderr: redactedStderr(envelope.stderr),
  };
}

function summarizeRemoteDocument(document) {
  return {
    schema: typeof document?.schema === "string" ? document.schema : null,
    status: typeof document?.status === "string" ? document.status : null,
    errorCode: typeof document?.error?.code === "string" ? document.error.code : null,
    errorReason: typeof document?.error?.reason === "string" ? redactedStderr(document.error.reason) : null,
    errorMessage: typeof document?.error?.message === "string" ? redactedStderr(document.error.message) : null,
    errorStderr: typeof document?.error?.stderr === "string" ? redactedStderr(document.error.stderr) : null,
    stoppedBy: remoteGeneratorStoppedBy(document),
    errors: summarizeRemoteGeneratorErrors(document?.errors),
    teardownClean: typeof document?.teardown?.clean === "boolean" ? document.teardown.clean : null,
    errorCount: Array.isArray(document?.errors) ? document.errors.length : null,
    disconnectCount: Array.isArray(document?.disconnects) ? document.disconnects.length : null,
  };
}

function remoteGeneratorStoppedBy(document) {
  if (nonemptyString(document?.stoppedBy)) return redactedStderr(document.stoppedBy);
  return document?.errors?.some((error) => error?.phase === "runner") ? "runner_error" : null;
}

function summarizeRemoteGeneratorErrors(errors) {
  if (!Array.isArray(errors)) return [];
  return errors.slice(0, 16).map((error) => ({
    phase: nonemptyString(error?.phase) ? error.phase.slice(0, 128) : null,
    reason: nonemptyString(error?.reason)
      ? redactedStderr(error.reason)
      : nonemptyString(error?.code)
        ? redactedStderr(error.code)
        : nonemptyString(error?.message)
          ? redactedStderr(error.message)
          : null,
    ...(nonemptyString(error?.message) ? { message: redactedStderr(error.message) } : {}),
  }));
}

function parseJsonOrNull(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function redactedStderr(text) {
  return String(text ?? "").replace(/(token|password|secret)=\S+/giu, "$1=[redacted]").slice(-1024);
}


function assertLatency(latency, label) {
  if (!latency || !["p50", "p95", "p99"].every((key) => Number.isFinite(latency[key]) && latency[key] >= 0) ||
      latency.p50 > latency.p95 || latency.p95 > latency.p99) {
    throw new FarmError(`remote player generator emitted invalid ${label} latency percentiles`, { code: "INVALID_REMOTE_GENERATOR_RESULT" });
  }
}

function remoteGeneratorDeadline(request) {
  return Math.min(12 * 60_000, request.durationMs + request.clients * request.rampIntervalMs + 120_000);
}

function remoteFailureReason(invocation) {
  if (invocation.error) return invocation.error.code ?? invocation.error.name ?? "spawn-error";
  if (invocation.timedOut) return "timeout";
  if (invocation.overflow) return "output-limit";
  return `exit-${invocation.exitCode}${invocation.signal ? `-${invocation.signal}` : ""}`;
}
