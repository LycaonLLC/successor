import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";

import {
  ScenarioAssertionError,
  assertComparison,
  assertMatch,
  compactOracleForDigest,
  distanceCells,
  findInventoryRow,
  getPath,
  interpolate,
  matchObject,
  resolveValue,
  sha256Json,
} from "./assertions.mjs";
import { actorDriverOptions, materializeFixtureSlice, resolveFixture, writeFixtureCharacterStore } from "./fixture-registry.mjs";
import { dispatchScenarioAction } from "./actions.mjs";
import { createProcessHost } from "../lib/process-host.mjs";
import { createLocalSourceIdentity } from "../farm/source-hash.mjs";

const driverVersion = "successor.driver.v1";
const defaultReadyTimeoutMs = 18_000;
const defaultStepTimeoutMs = 12_000;
const scenarioTranscriptSchema = "successor.scenario-transcript.v2";
const supportedScenarioLanes = new Set(["accel", "realtime"]);
const defaultStateProbeIntervalSteps = 25;
const defaultMaxAdvanceTicksPerRequest = 3_000;
const defaultMaxAdvanceTicksPerOperation = 200_000;
const defaultAdvanceWallTimeoutMs = 30_000;
const defaultActionFrameTimeoutMs = 12_000;
const defaultManualPollTicks = 1;
const defaultManualClockMode = "manual";
const defaultRealtimeClockMode = "system";
const defaultSourceHash = null;
const defaultMaxParallelBranches = 3;
const clockAdvanceSchema = "successor.debug-clock-advance.v1";
const clockSnapshotSchema = "successor.debug-clock.v1";
const nodeBin = process.env.NODE_BIN ?? process.execPath;

function positiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export async function loadScenario(filePath) {
  const scenario = JSON.parse(await fs.readFile(filePath, "utf8"));
  validateScenario(scenario, filePath);
  return scenario;
}
export function validateScenario(scenario, label = "scenario") {
  if (scenario?.schema !== "successor.scenario.v1") throw new Error(`${label}: schema must be successor.scenario.v1`);
  if (!scenario.name || typeof scenario.name !== "string") throw new Error(`${label}: name is required`);
  if (!scenario.fixture || typeof scenario.fixture !== "string") throw new Error(`${label}: fixture is required`);
  if (!scenario.actors || typeof scenario.actors !== "object" || Array.isArray(scenario.actors)) throw new Error(`${label}: actors object is required`);
  if (Object.keys(scenario.actors).length === 0) throw new Error(`${label}: at least one actor is required`);
  if (!Array.isArray(scenario.steps) || scenario.steps.length === 0) throw new Error(`${label}: steps[] is required`);
  const lanes = validateScenarioLanes(scenario.lanes ?? ["accel"], `${label}: lanes`);
  const matrixLanes = validateScenarioLanes(scenario.matrixLanes ?? ["accel"], `${label}: matrixLanes`);
  if (lanes.includes("realtime") && (typeof scenario.realtimeReason !== "string" || scenario.realtimeReason.trim().length === 0)) {
    throw new Error(`${label}: realtime lane requires a non-empty realtimeReason`);
  }
  for (const lane of matrixLanes) {
    if (!lanes.includes(lane)) throw new Error(`${label}: matrixLanes lane ${lane} is not present in lanes`);
  }
  const restartSteps = scenario.steps.map(parseScenarioStep).filter((step) => step.restart !== undefined);
  if (restartSteps.length > 0 && scenario.persistence !== true) {
    throw new Error(`${label}: restart steps require persistence:true`);
  }
  if (
    scenario.linkDeadHoldSeconds !== undefined
    && (!Number.isInteger(scenario.linkDeadHoldSeconds)
      || scenario.linkDeadHoldSeconds < 1
      || scenario.linkDeadHoldSeconds > 86_400)
  ) {
    throw new Error(`${label}: linkDeadHoldSeconds must be an integer from 1 to 86400`);
  }
  for (const step of restartSteps) {
    const restart = step.restart;
    if (!restart || typeof restart !== "object" || Array.isArray(restart)) {
      throw new Error(`${label}: restart step must be an object`);
    }
  }
  for (const [index, rawStep] of scenario.steps.entries()) {
    validateParallelStep(parseScenarioStep(rawStep), `${label}: steps[${index}]`, scenario.actors);
  }
  for (const [alias, spec] of Object.entries(scenario.actors)) {
    if (!/^[A-Za-z][A-Za-z0-9_-]*$/u.test(alias)) throw new Error(`${label}: invalid actor alias ${alias}`);
    if (!spec?.character) throw new Error(`${label}: actor ${alias} requires a fixture character`);
  }
}

function validateParallelStep(step, label, actors) {
  if (step.parallel === undefined) return;
  if (!Array.isArray(step.parallel) || step.parallel.length < 2) throw new Error(`${label}: parallel must contain at least two branches`);
  if (step.parallel.length > Number(step.maxBranches ?? defaultMaxParallelBranches)) {
    throw new Error(`${label}: parallel exceeds maxBranches`);
  }
  for (const [index, branch] of step.parallel.entries()) {
    if (!branch || typeof branch !== "object" || Array.isArray(branch) || !Object.hasOwn(actors, branch.actor)) {
      throw new Error(`${label}.parallel[${index}]: actor must reference a scenario actor`);
    }
    if (!Array.isArray(branch.steps) || branch.steps.length === 0) {
      throw new Error(`${label}.parallel[${index}]: steps[] is required`);
    }
    for (const [stepIndex, branchStep] of branch.steps.entries()) {
      const parsed = parseScenarioStep(branchStep);
      if (parsed.parallel !== undefined) throw new Error(`${label}.parallel[${index}].steps[${stepIndex}]: nested parallel is not supported`);
    }
  }
}

export function scenarioSupportedLanes(scenario) {
  return [...(scenario?.lanes ?? ["accel"])];
}

export function scenarioMatrixLanes(scenario) {
  return [...(scenario?.matrixLanes ?? ["accel"])];
}

function validateScenarioLanes(value, label) {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${label} must be a non-empty array`);
  for (const lane of value) {
    if (!supportedScenarioLanes.has(lane)) throw new Error(`${label} contains unsupported lane ${lane}`);
  }
  if (new Set(value).size !== value.length) throw new Error(`${label} must not contain duplicates`);
  return value;
}

export function parseScenarioStep(step) {
  if (typeof step === "string") {
    const actorLine = step.match(/^([A-Za-z][A-Za-z0-9_-]*)>\s*(\/.+)$/u);
    if (actorLine) return { send: { actor: actorLine[1], line: actorLine[2] } };
    const pauseLine = step.match(/^(?:pause|\/pause)\s+([0-9]+(?:\.[0-9]+)?(?:ms|s)?)$/iu);
    if (pauseLine) return { pauseMs: parseDurationMs(pauseLine[1]) };
    throw new Error(`unsupported scenario step string ${JSON.stringify(step)}`);
  }
  if (!step || typeof step !== "object" || Array.isArray(step)) throw new Error(`scenario step must be string/object: ${JSON.stringify(step)}`);
  return step;
}

export function parseDurationMs(value, fallbackMs = defaultStepTimeoutMs) {
  if (value === undefined || value === null || value === "") return fallbackMs;
  if (typeof value === "number") return value;
  const raw = String(value).trim().toLowerCase();
  if (raw.endsWith("ms")) return Number(raw.slice(0, -2));
  if (raw.endsWith("s")) return Number(raw.slice(0, -1)) * 1000;
  return Number(raw);
}

export async function allocatePorts(count, options = {}) {
  const base = Number(options.base ?? process.env.SUCCESSOR_PLAY_GATE_BASE_PORT ?? 28600);
  const min = Number(options.min ?? 28000);
  const max = Number(options.max ?? 65535);
  const ports = [];
  for (let candidate = Math.max(base, min); candidate <= max && ports.length < count; candidate += 1) {
    if (ports.includes(candidate)) continue;
    if (await portIsFree(candidate)) ports.push(candidate);
  }
  if (ports.length !== count) throw new Error(`could not allocate ${count} free ports in ${min}-${max} from base ${base}`);
  return ports;
}

export async function runScenarioFile(options) {
  const scenario = await loadScenario(options.scenarioPath);
  return runScenario({ ...options, scenario });
}

export async function runScenario({ repoRoot, scenario, runId, port, artifactDir, lane = "accel", sourceHash = defaultSourceHash, sourceIdentity = null, serverEntrypoint, clientCliPath, rustBridgeBin }) {
  if (!supportedScenarioLanes.has(lane)) throw new Error(`unsupported scenario lane ${lane}`);
  const started = performance.now();
  const root = path.resolve(repoRoot);
  const resolvedFixture = await resolveFixture(scenario.fixture, root);
  const scenarioRunId = `${runId}-${safeName(scenario.name)}-${lane}`;
  const runDir = path.resolve(artifactDir, safeName(scenario.name));
  await fs.mkdir(runDir, { recursive: true });
  const fixture = await materializeFixtureSlice(resolvedFixture, runDir, scenario.actors);
  const beforeSourceIdentity = compactSourceIdentity(sourceIdentity) ?? await createLocalSourceIdentity({ root, includeManifest: false });
  const characterStore = await writeFixtureCharacterStore(fixture, runDir, scenario.actors);
  const runtime = await startFixtureServer({
    repoRoot: root,
    fixture,
    scenario,
    runId: scenarioRunId,
    runDir,
    port,
    characterStorePath: characterStore.path,
    lane,
    serverEntrypoint,
    rustBridgeBin,
  });
  runtime.transport = createTransportMetrics();
  const sessions = new Map();
  const chatSessions = new Map();
  const initialClock = await readClockSnapshot(runtime);
  const detectedTickRateHz = tickRateFromStatus(runtime.status)
    ?? (Number.isFinite(Number(fixture.sourceTickRateHz)) ? Number(fixture.sourceTickRateHz) : 30);
  const context = {
    scenario,
    fixture,
    lane,
    sourceHash: beforeSourceIdentity.sourceHash ?? sourceHash ?? process.env.SUCCESSOR_SOURCE_HASH ?? null,
    sourceIdentity: {
      before: beforeSourceIdentity,
      after: null,
    },
    port,
    gameUrl: runtime.gameUrl,
    captures: {},
    vars: {},
    actors: {},
    chatSessions,
    lastReceipt: null,
    lastEvent: null,
    transcript: [],
    stepRecords: [],
    stateProbes: [],
    scheduler: {
      clockMode: runtime.status?.clock?.mode ?? initialClock.mode,
      tickRateHz: detectedTickRateHz,
      currentTick: Number.isFinite(Number(initialClock.tick)) ? Math.trunc(Number(initialClock.tick)) : null,
      currentVirtualNowMs: Number.isFinite(Number(initialClock.virtualNowMs)) ? Number(initialClock.virtualNowMs) : null,
      nextCommandTick: Number(scenario.timing?.firstCommandTick ?? 6),
      commandGapTicks: Number(scenario.timing?.commandGapTicks ?? 1),
      advancedTicks: 0,
    },
  };
  let initialStateHash = null;
  const failures = [];
  const failureDetails = [];
  let finalStatus = null;
  let finalOracle = null;
  let finalDigest = null;
  let finalStateHash = null;
  let finalClock = initialClock;
  let teardown = null;

  try {
    assertRequestedClockMode(lane, context.scheduler.clockMode);
    for (const [alias, spec] of Object.entries(scenario.actors)) {
      const driverOptions = actorDriverOptions(fixture, alias, spec);
      const session = new DriverSession({ repoRoot: root, gameUrl: runtime.gameUrl, slicePath: fixture.slicePath, cliPath: clientCliPath, tickMs: deterministicDriverTickMs(), ...driverOptions });
      sessions.set(alias, session);
      context.actors[alias] = { id: driverOptions.actorId, characterId: driverOptions.characterId, displayName: driverOptions.displayName };
      await session.start();
      const ready = await session.waitFor((envelope) => envelope.type === "status" && envelope.status === "ready", `${alias} ready`, defaultReadyTimeoutMs);
      context.transcript.push({ actor: alias, recv: ready });
    }

    const initialOracle = await runtimeFetchJson(runtime, `${runtime.gameUrl}/game/debug/oracle?freshAiDebug=1`);
    initialStateHash = sha256Json(compactOracleForDigest(initialOracle));

    const wholeRunDeadline = started + positiveNumber(scenario.limits?.maxWallDurationMs, 300_000);
    for (let index = 0; index < scenario.steps.length; index += 1) {
      if (performance.now() > wholeRunDeadline) throw new ScenarioAssertionError("scenario whole-run wall ceiling exceeded", { maxWallDurationMs: wholeRunDeadline - started });
      const step = parseScenarioStep(scenario.steps[index]);
      const beforeClock = await scenarioClockSnapshot(context, runtime);
      const stepStarted = performance.now();
      const startedAtWallTime = new Date().toISOString();
      const traceStart = context.transcript.length;
      const actor = scenarioStepActor(step);
      const preOracle = await runtimeFetchJson(runtime, `${runtime.gameUrl}/game/debug/oracle?freshAiDebug=1`).catch(() => null);
      const processStart = await sampleProcessResources(runtime);
      const record = {
        index: index + 1,
        kind: scenarioStepKind(step),
        ...(actor ? { actor } : {}),
        issuedAtTick: beforeClock.tick,
        virtualNowMs: beforeClock.virtualNowMs,
        startedAtWallTime,
        expandedStep: step,
        preStateHash: preOracle ? sha256Json(compactOracleForDigest(preOracle)) : null,
        expandedFrames: [],
        receipts: [],
      };
      context.stepRecords.push(record);
      let stepFailure = null;
      try {
        const stepTimeoutMs = step.restart && typeof step.restart === "object" && Number.isFinite(Number(step.restart.timeoutMs))
          ? Number(step.restart.timeoutMs)
          : step.timeoutMs ?? scenario.limits?.perStepTimeoutMs;
        const result = await runStepWithTimeout(
          (signal) => executeStep(step, context, sessions, runtime, signal),
          positiveNumber(stepTimeoutMs, defaultStepTimeoutMs),
          `scenario step ${index + 1}`,
        );
        if (step.action) recordActionStepResult({ context, stepRecord: record, actionResult: result, appendFrames: false });
        if (step.parallel && result?.branches) record.parallel = result.branches;
      } catch (error) {
        stepFailure = error;
        if (error?.details?.schema === "successor.scenario-action.v1") record.action = error.details;
      } finally {
        const afterClock = await scenarioClockSnapshot(context, runtime).catch(() => ({ mode: context.scheduler.clockMode, tick: context.scheduler.currentTick, virtualNowMs: context.scheduler.currentVirtualNowMs }));
        const postOracle = await runtimeFetchJson(runtime, `${runtime.gameUrl}/game/debug/oracle?freshAiDebug=1`).catch(() => null);
        const processEnd = await sampleProcessResources(runtime);
        if (stepFailure) {
          record.failure = failureRecord(stepFailure, { step: record.index, lane, sourceIdentity: context.sourceIdentity });
          record.failureArtifactPath = await writeStepFailureArtifact(root, runDir, record, stepFailure);
        }
        record.completedAtTick = afterClock.tick;
        record.completedVirtualNowMs = afterClock.virtualNowMs;
        record.completedAtWallTime = new Date().toISOString();
        record.wallDurationMs = round(performance.now() - stepStarted);
        record.postStateHash = postOracle ? sha256Json(compactOracleForDigest(postOracle)) : null;
        record.processResources = { start: processStart, end: processEnd };
        record.expandedFrames = context.transcript.slice(traceStart);
        record.receipts = enrichReceipts({
          frames: record.expandedFrames,
          actor: record.actor ?? null,
          issuedAtTick: record.issuedAtTick,
          receipts: record.action?.receipts ?? [],
        });
        if (record.receipts.length === 1) record.receipt = record.receipts[0];
      }
      if (stepFailure) throw stepFailure;
      if ((index + 1) % stateProbeIntervalSteps(scenario) === 0 || isMacroHookStep(step)) {
        await recordStateProbe(context, runtime, index + 1, isMacroHookStep(step) ? "macro" : "interval");
      }
    }

    finalStatus = await runtimeFetchJson(runtime, `${runtime.gameUrl}/game/status`);
    finalOracle = await runtimeFetchJson(runtime, `${runtime.gameUrl}/game/debug/oracle?freshAiDebug=1`);
    finalStateHash = sha256Json(compactOracleForDigest(finalOracle));
    finalDigest = lastStableHashDigest(context) ?? finalStateHash;
    recordFinalStateProbe(context, finalOracle, scenario.steps.length, finalStateHash);
    finalClock = await readClockSnapshot(runtime);
  } catch (error) {
    const failure = failureRecord(error, {
      step: context.stepRecords.at(-1)?.index ?? null,
      lane,
      sourceIdentity: context.sourceIdentity,
    });
    failures.push(failure.message);
    failureDetails.push(failure);
    finalStatus = await runtimeFetchJson(runtime, `${runtime.gameUrl}/game/status`).catch((statusError) => ({ error: String(statusError) }));
    finalOracle = await runtimeFetchJson(runtime, `${runtime.gameUrl}/game/debug/oracle`).catch((oracleError) => ({ error: String(oracleError) }));
    finalStateHash = finalOracle?.error ? null : sha256Json(compactOracleForDigest(finalOracle));
    finalDigest = finalOracle?.error ? null : lastStableHashDigest(context) ?? finalStateHash;
    if (!finalOracle?.error) recordFinalStateProbe(context, finalOracle, context.stepRecords.length, finalStateHash);
    finalClock = await readClockSnapshot(runtime).catch(() => finalClock);
  } finally {
    for (const session of chatSessions.values()) await session.close().catch(() => undefined);
    for (const session of sessions.values()) await session.close().catch(() => undefined);
    teardown = await runtime.stop();
    context.sourceIdentity.after = compactSourceIdentity(await createLocalSourceIdentity({ root, includeManifest: false }).catch(() => null));
  }

  attachDriverReceiptsToSteps(context.stepRecords, sessions);
  const wallDurationMs = round(performance.now() - started);
  const virtualDurationMs = durationBetweenClockSnapshots(initialClock, finalClock, {
    advancedTicks: context.scheduler.advancedTicks,
    tickRateHz: context.scheduler.tickRateHz,
  });
  const fixtureRecord = {
    name: scenario.fixture,
    sourceStateHash: fixture.sourceStateHash,
    sliceHash: runtime.status?.source?.sliceHash ?? finalStatus?.source?.sliceHash ?? null,
    slicePath: path.relative(root, fixture.slicePath),
    actorCount: fixture.sourceActorCount,
    characterStore: path.relative(root, characterStore.path),
  };
  const report = {
    schema: scenarioTranscriptSchema,
    status: failures.length === 0 && teardown.ok ? "pass" : "fail",
    runId: scenarioRunId,
    scenario: scenario.name,
    lane,
    fixture: fixtureRecord,
    fixtureName: scenario.fixture,
    sourceHash: context.sourceHash,
    port,
    gameUrl: runtime.gameUrl,
    unit: runtime.handle.unit ?? runtime.handle.name,
    durationMs: wallDurationMs,
    wallDurationMs,
    virtualDurationMs,
    performance: {
      transport: snapshotTransportMetrics(runtime.transport),
    },
    clock: {
      mode: context.scheduler.clockMode,
      tickRateHz: context.scheduler.tickRateHz,
      initialTick: initialClock.tick,
      finalTick: finalClock.tick,
      initialVirtualNowMs: initialClock.virtualNowMs,
      finalVirtualNowMs: finalClock.virtualNowMs,
      advancedTicks: context.scheduler.advancedTicks,
    },
    actors: context.actors,
    failures: [...failures, ...(teardown.ok ? [] : teardown.failures)],
    failure: failureDetails.at(0) ?? null,
    failureDetails,
    sourceIdentity: context.sourceIdentity,
    stateHashes: { initial: initialStateHash, final: finalStateHash },
    finalStateHash,
    steps: context.stepRecords,
    stateProbes: context.stateProbes,
    transcript: context.transcript,
    commandStream: admittedCommandStream([...sessions.values()].flatMap((session) => session.envelopes)),
    commandReceipts: allCommandReceipts(context.stepRecords, sessions),
    receipts: Object.fromEntries([...sessions.entries()].map(([alias, session]) => [alias, session.envelopes.filter((envelope) => envelope.type === "receipt").map((receipt) => compactReceipt(receipt, { actor: alias }))])),
    events: Object.fromEntries([...sessions.entries()].map(([alias, session]) => [alias, session.envelopes.filter((envelope) => envelope.type === "event")])),
    chat: Object.fromEntries([...chatSessions.entries()].map(([key, session]) => [key, session.envelopes])),
    finalStatus: compactStatus(finalStatus),
    finalSnapshotDigest: finalDigest,
    teardown,
  };
  if (report.failures.length > 0) report.status = "fail";
  const reportPath = path.join(runDir, "scenario-run.json");
  await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return { ...report, artifactPath: path.relative(root, reportPath) };
}

export async function executeStep(step, context, sessions, runtime, signal = null) {
  throwIfAborted(signal);
  if (step.pauseMs !== undefined) {
    const pauseMs = parseDurationMs(step.pauseMs, 0);
    return deterministicPauseStep(pauseMs, context, sessions, runtime, null, null, signal);
  }
  if (step.parallel) return executeParallelStep(step, context, sessions, runtime, signal);
  if (step.restart) return restartFixtureRuntime(step.restart, context, sessions, runtime, signal);
  if (step.disconnect) return disconnectActorStep(step.disconnect, context, sessions, signal);
  if (step.reconnect) return reconnectActorStep(step.reconnect, context, sessions, runtime, signal);
  if (step.action) return actionStep(step.action, context, sessions, runtime, step.as, signal);
  if (step.send) return sendVerbStep(step.send, context, sessions, runtime, signal);
  if (step.query) return queryStep(step.query, context, sessions, signal);
  if (step.command) return commandStep(step.command, context, runtime, signal);
  if (step.chatConnect) return chatConnectStep(step.chatConnect, context, runtime, signal);
  if (step.chatSend) return chatSendStep(step.chatSend, context, signal);
  if (step.await) return awaitStep(step.await, context, sessions, runtime, signal);
  if (step.expect) return expectStep(step.expect, context, sessions, runtime, signal);
  throw new Error(`unsupported scenario step ${JSON.stringify(step)}`);
}

async function executeParallelStep(spec, context, sessions, runtime, parentSignal = null) {
  const branches = spec.parallel;
  const maxBranches = Number(spec.maxBranches ?? defaultMaxParallelBranches);
  if (!Array.isArray(branches) || branches.length < 2 || branches.length > maxBranches) {
    throw new ScenarioAssertionError(`parallel step requires 2-${maxBranches} branches`);
  }
  const cancellation = new AbortController();
  const unlinkParent = linkAbortSignal(parentSignal, cancellation);
  const tasks = branches.map((branch, branchIndex) => {
    const branchController = new AbortController();
    const unlinkBranch = linkAbortSignal(cancellation.signal, branchController);
    const task = runParallelBranch(branch, branchIndex, cancellation, context, sessions, runtime, branchController.signal)
      .finally(unlinkBranch);
    return task;
  });
  let firstFailure = null;
  let remaining = tasks.length;
  let resolveDone;
  let rejectDone;
  const done = new Promise((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });
  tasks.forEach((task) => task.then(() => {
    remaining -= 1;
    if (remaining === 0 && !firstFailure) resolveDone();
  }).catch((error) => {
    if (!firstFailure) {
      firstFailure = error;
      cancellation.abort(error);
      rejectDone(error);
    }
  }));
  try {
    await done;
  } catch (error) {
    cancellation.abort(error);
    await Promise.allSettled(tasks);
    throw new ScenarioAssertionError(`parallel step failed: ${error instanceof Error ? error.message : String(error)}`, {
      cause: error instanceof Error ? error.message : String(error),
      cancelled: true,
    });
  } finally {
    unlinkParent();
  }
  const results = await Promise.all(tasks);
  return { status: "pass", branches: results.sort((left, right) => left.branchIndex - right.branchIndex) };
}
async function runParallelBranch(branch, branchIndex, cancellation, context, sessions, runtime, signal) {
  const records = [];
  for (let index = 0; index < branch.steps.length; index += 1) {
    throwIfAborted(signal);
    const rawStep = parseScenarioStep(branch.steps[index]);
    const step = bindParallelActor(rawStep, branch.actor);
    const started = performance.now();
    const startedAtWallTime = new Date().toISOString();
    const beforeClock = await scenarioClockSnapshot(context, runtime, signal);
    const preOracle = await runtimeFetchJson(runtime, `${runtime.gameUrl}/game/debug/oracle?freshAiDebug=1`, signal).catch((error) => {
      if (signal?.aborted) throw error;
      return null;
    });
    let result;
    let failure = null;
    try {
      result = await executeStep(step, context, sessions, runtime, signal);
    } catch (error) {
      failure = error;
    }
    throwIfAborted(signal);
    const afterClock = await scenarioClockSnapshot(context, runtime, signal).catch(() => beforeClock);
    const postOracle = await runtimeFetchJson(runtime, `${runtime.gameUrl}/game/debug/oracle?freshAiDebug=1`, signal).catch((error) => {
      if (signal?.aborted) throw error;
      return null;
    });
    const record = {
      index: index + 1,
      actor: branch.actor,
      kind: scenarioStepKind(step),
      expandedStep: step,
      issuedAtTick: beforeClock.tick,
      completedAtTick: afterClock.tick,
      startedAtWallTime,
      completedAtWallTime: new Date().toISOString(),
      wallDurationMs: round(performance.now() - started),
      preStateHash: preOracle ? sha256Json(compactOracleForDigest(preOracle)) : null,
      postStateHash: postOracle ? sha256Json(compactOracleForDigest(postOracle)) : null,
      receipts: enrichReceipts({ actor: branch.actor, issuedAtTick: beforeClock.tick, receipts: result?.receipts ?? [] }),
      ...(failure ? { failure: failureRecord(failure, { step: index + 1, lane: context.lane, sourceIdentity: context.sourceIdentity }) } : {}),
    };
    records.push(record);
    if (failure) throw failure;
  }
  return { branchIndex, actor: branch.actor, steps: records };
}

function bindParallelActor(step, actor) {
  if (typeof step === "string") return step;
  for (const key of ["action", "send", "query", "command", "chatConnect", "chatSend", "await", "expect"]) {
    if (step[key] && typeof step[key] === "object" && !Array.isArray(step[key])) {

      return { ...step, [key]: { ...step[key], ...(step[key].actor === undefined ? { actor } : {}) } };
    }
  }
  return step;
}

function runStepWithTimeout(task, timeoutMs, label) {
  const controller = new AbortController();
  let timer;
  let timedOut = false;
  const taskPromise = Promise.resolve().then(() => task(controller.signal));
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort(new ScenarioAssertionError(`${label} exceeded wall ceiling`, { timeoutMs }));
      reject(controller.signal.reason);
    }, timeoutMs);
  });
  return Promise.race([taskPromise, timeout]).finally(async () => {
    clearTimeout(timer);
    if (timedOut) await taskPromise.catch(() => undefined);
  }).catch((error) => {
    if (timedOut && error?.details?.timeoutMs === timeoutMs) throw error;
    throw error;
  });
}

async function restartFixtureRuntime(spec, context, sessions, runtime, signal = null) {
  throwIfAborted(signal);
  if (context.scenario?.persistence !== true) throw new ScenarioAssertionError("restart source validation failed: scenario must declare persistence:true");
  if (!runtime?.checkpoint || !runtime?.stop || !runtime?.relaunch || !runtime?.readOracle || !runtime?.readStatus) {
    throw new ScenarioAssertionError("restart source validation failed: runtime does not expose the isolated restart lifecycle");
  }
  const timeoutMs = parseDurationMs(spec.timeoutMs, defaultStepTimeoutMs);
  const pendingCommands = pendingAuthorityCommands(sessions);
  if (pendingCommands.length > 0) {
    throw new ScenarioAssertionError("restart pending command failed: authority receipts must settle before checkpoint", { pendingCommands });
  }
  throwIfAborted(signal);
  const preOracle = await runtime.readOracle({ signal });
  const preAuthorityHash = sha256Json(compactOracleForDigest(preOracle));
  const oldProcess = await runtimeProcessIdentity(runtime);
  let checkpoint;
  try {
    throwIfAborted(signal);
    checkpoint = await runtime.checkpoint({ timeoutMs, signal });
  } catch (error) {
    throw restartFailure("restart checkpoint failed", error);
  }
  const disconnects = [];
  for (const [alias, session] of sessions) {
    try {
      throwIfAborted(signal);
      const startIndex = Array.isArray(session.envelopes) ? session.envelopes.length : 0;
      await session.close();
      disconnects.push({ actor: alias, envelopeCount: startIndex, closed: true });
    } catch (error) {
      throw restartFailure(`restart actor disconnect failed: ${alias}`, error);
    }
  }
  let stopped;
  try {
    throwIfAborted(signal);
    stopped = await runtime.stop({ graceMs: Math.min(timeoutMs, 10_000), signal });
  } catch (error) {
    throw restartFailure("restart teardown failed", error);
  }
  if (stopped?.ok !== true) throw new ScenarioAssertionError("restart teardown failed: ProcessHost reported surviving fixture process", { stopped });
  try {
    throwIfAborted(signal);
    await runtime.relaunch({ timeoutMs, signal });
  } catch (error) {
    throw restartFailure("restart relaunch failed", error);
  }
  const newProcess = await runtimeProcessIdentity(runtime);
  assertDistinctProcessIdentity(oldProcess, newProcess);
  let status;
  try {
    throwIfAborted(signal);
    status = await runtime.readStatus({ signal });
    assertRestartStatus(status, runtime, checkpoint);
  } catch (error) {
    throw restartFailure("restart source validation failed", error);
  }
  const reconnects = [];
  context.restartCommandFloors ??= {};
  context.restartDebugCommandFloors ??= {};
  for (const [alias, session] of sessions) {
    try {
      throwIfAborted(signal);
      const startIndex = Array.isArray(session.envelopes) ? session.envelopes.length : 0;
      const commandIdFloor = nextDriverCommandIdFloor(session);
      context.restartCommandFloors[alias] = commandIdFloor;
      context.restartDebugCommandFloors[alias] = nextDebugCommandIdFloor(context, alias);
      if (typeof session.reconnect === "function") await session.reconnect(runtime.gameUrl, commandIdFloor);
      else await session.start();
      const hello = await session.waitFor(
        (envelope) => envelope.type === "status" && envelope.status === "ready",
        `${alias} source-validated authority hello`,
        timeoutMs,
        startIndex,
        signal,
      );
      reconnects.push({ actor: alias, hello, envelopeCount: startIndex, commandIdFloor });
    } catch (error) {
      throw restartFailure(`restart actor reconnect failed: ${alias}`, error);
    }
  }
  try {
    throwIfAborted(signal);
    assertRestartStatus(await runtime.readStatus({ signal }), runtime, checkpoint);
  } catch (error) {
    throw restartFailure("restart source validation failed", error);
  }
  throwIfAborted(signal);
  const postOracle = await runtime.readOracle({ signal });
  const postAuthorityHash = sha256Json(compactOracleForDigest(postOracle));
  // Restart restores authority at the checkpoint tick. Re-baseline the manual
  // scheduler from the restored status/oracle tick so later command alignment
  // and pauses stay relative to the live clock instead of any pre-restart absolute.
  const restoredTick = Number(status?.tick ?? postOracle?.tick);
  if (Number.isFinite(restoredTick)) {
    const normalizedRestoredTick = Math.max(0, Math.trunc(restoredTick));
    context.scheduler.currentTick = normalizedRestoredTick;
    context.scheduler.nextCommandTick = normalizedRestoredTick + commandGapTicks(context);
    const restoredVirtualNowMs = Number(status?.clock?.virtualNowMs ?? postOracle?.virtualNowMs);
    if (Number.isFinite(restoredVirtualNowMs)) {
      context.scheduler.currentVirtualNowMs = restoredVirtualNowMs;
    } else {
      context.scheduler.currentVirtualNowMs = (normalizedRestoredTick * 1000) / scenarioTickRateHz(context);
    }
  }
  const evidence = {
    schema: "successor.scenario-restart-evidence.v1",
    shardId: runtime.shardId ?? status?.shardId ?? null,
    paths: runtime.paths ?? (runtime.persistence ? { checkpointPath: runtime.persistence.checkpointPath, journalPath: runtime.persistence.journalPath } : null),
    oldProcess, newProcess, checkpoint, disconnects, reconnects, preAuthorityHash, postAuthorityHash,
    restoredTick: Number.isFinite(restoredTick) ? Math.max(0, Math.trunc(restoredTick)) : null,
  };
  if (spec.as) context.captures[spec.as] = evidence;
  context.transcript.push({ restart: evidence });
  return evidence;
}
async function disconnectActorStep(spec, context, sessions, signal = null) {
  throwIfAborted(signal);
  const actor = spec?.actor;
  const session = requireActorSession(sessions, actor);
  const envelopeCount = session.envelopes.length;
  await session.close();
  const evidence = { schema: "successor.scenario-actor-disconnect.v1", actor, envelopeCount, closed: true };
  if (spec?.as) context.captures[spec.as] = evidence;
  context.transcript.push({ disconnect: evidence });
  return evidence;
}

async function reconnectActorStep(spec, context, sessions, runtime, signal = null) {
  throwIfAborted(signal);
  const actor = spec?.actor;
  const session = requireActorSession(sessions, actor);
  if (!session.exit) throw new ScenarioAssertionError(`actor ${actor} reconnect requires a closed driver session`);
  const commandIdFloor = nextDriverCommandIdFloor(session);
  const startIndex = session.envelopes.length;
  await session.reconnect(runtime.gameUrl, commandIdFloor);
  const ready = await session.waitFor(
    (candidate) => candidate.type === "status" && candidate.status === "ready",
    `${actor} reconnect ready`,
    parseDurationMs(spec?.timeoutMs, defaultReadyTimeoutMs),
    startIndex,
    signal,
  );
  context.restartCommandFloors ??= {};
  context.restartCommandFloors[actor] = commandIdFloor;
  const evidence = { schema: "successor.scenario-actor-reconnect.v1", actor, commandIdFloor, ready: ready.status };
  if (spec?.as) context.captures[spec.as] = evidence;
  context.transcript.push({ reconnect: evidence });
  return evidence;
}


function pendingAuthorityCommands(sessions) {
  const pending = [];
  for (const [actor, session] of sessions) {
    const receipts = new Set((session.envelopes ?? [])
      .filter((envelope) => envelope?.type === "receipt" && envelope.commandId !== undefined && envelope.commandId !== null)
      .map((envelope) => String(envelope.commandId)));
    for (const envelope of session.envelopes ?? []) {
      if (envelope?.type !== "event" || envelope.event !== "authority_queued") continue;
      const commandId = envelope.data?.commandId;
      if (commandId === undefined || commandId === null || receipts.has(String(commandId))) continue;
      pending.push({ actor, commandId, commandKind: envelope.data?.commandKind ?? null, line: envelope.line ?? null });
    }
  }
  return pending;
}

function nextDriverCommandIdFloor(session) {
  const observed = (session?.envelopes ?? [])
    .flatMap((envelope) => [envelope?.commandId, envelope?.data?.commandId])
    .map((value) => Number(value))
    .filter((value) => Number.isInteger(value) && value >= 1);
  return Math.max(1, ...observed.map((value) => value + 1));
}

function nextDebugCommandIdFloor(context, actor) {
  const commandIds = (context.transcript ?? [])
    .filter((entry) => entry?.actor === actor && entry?.command)
    .map((entry) => Number(entry.recv?.commandId ?? entry.recv?.receipt?.commandId))
    .filter((value) => Number.isInteger(value) && value >= 1);
  return Math.max(1, ...commandIds.map((value) => value + 1));
}

function restartFailure(prefix, error) {
  return new ScenarioAssertionError(`${prefix}: ${error instanceof Error ? error.message : String(error)}`, { cause: error instanceof Error ? error.message : String(error) });
}

async function runtimeProcessIdentity(runtime) {
  const inspection = typeof runtime.inspect === "function" ? await runtime.inspect() : null;
  const handle = runtime.handle ?? null;
  const mainPid = inspection?.mainPid ?? handle?.pid ?? null;
  if (!Number.isInteger(mainPid) || mainPid <= 0) {
    throw new ScenarioAssertionError("restart source validation failed: ProcessHost did not expose a live process identity", { inspection, handle });
  }
  return {
    kind: runtime.processHost?.kind ?? null,
    unit: handle?.unit ?? handle?.name ?? null,
    mainPid,
  };
}

function assertDistinctProcessIdentity(oldProcess, newProcess) {
  if (oldProcess.mainPid === newProcess.mainPid) {
    throw new ScenarioAssertionError("restart relaunch failed: ProcessHost identity did not change", { oldProcess, newProcess });
  }
}

function assertRestartStatus(status, runtime, checkpoint) {
  if (!status || status.shardId !== (runtime.shardId ?? checkpoint?.checkpoint?.shardId)) throw new Error("shard identity changed across restart");
  if (runtime.fixture?.sourceStateHash && status.source?.stateHash !== runtime.fixture.sourceStateHash) throw new Error("fixture source hash changed across restart");
  if (runtime.persistence && (status.persistence?.enabled !== true
    || status.persistence?.checkpointPath !== runtime.persistence.checkpointPath
    || status.persistence?.journalPath !== runtime.persistence.journalPath
    || status.persistence?.restore?.loaded !== true)) {
    throw new Error("persistence restore evidence is missing or paths changed across restart");
  }
}

async function actionStep(spec, context, sessions, runtime, captureAs, signal = null) {
  throwIfAborted(signal);
  const actionContext = scenarioActionContext(spec, context, sessions, runtime, signal);
  const resolvedSpec = typeof spec === "object" && spec !== null && !Array.isArray(spec)
    ? { ...spec, args: resolveActionArgs(spec.args, context) }
    : spec;
  const result = await dispatchScenarioAction(resolvedSpec, actionContext);
  throwIfAborted(signal);
  if (captureAs ?? spec?.as) context.captures[captureAs ?? spec.as] = result;
  return result;
}

function resolveActionArgs(value, context) {
  if (typeof value === "string") {
    const resolved = resolveValue(value, context);
    if (resolved !== value) return resolveActionArgs(resolved, context);
    for (const [token] of value.matchAll(/\$[A-Za-z_][A-Za-z0-9_.-]*/gu)) {
      const tokenValue = resolveValue(token, context);
      if (tokenValue === token || tokenValue === null) {
        throw new ScenarioAssertionError(`scenario action argument references missing value ${token}`);
      }
    }
    const interpolated = interpolate(value, context);
    return interpolated === value ? interpolated : resolveActionArgs(interpolated, context);
  }
  if (Array.isArray(value)) return value.map((entry) => resolveActionArgs(entry, context));
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, resolveActionArgs(entry, context)]));
}

function isPlainObject(value) {
  if (!value || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function scenarioActionContext(spec, context, sessions, runtime, signal = null) {
  const aliases = [...sessions.keys()];
  const defaultAlias = spec?.actor ?? aliases[0];
  const bind = (alias) => {
    const session = requireActorSession(sessions, alias);
    const actor = context.actors[alias];
    return {
      driver: session,
      gameUrl: runtime.gameUrl,
      actor: { alias, id: actor.id, actorId: actor.id },
      actorId: actor.id,
      tickRateHz: scenarioTickRateHz(context),
      defaultTimeoutMs: defaultStepTimeoutMs,
      signal,
      fetchJson: (url) => runtimeFetchJson(runtime, url, signal),
      async oracle() {
        throwIfAborted(signal);
        const oracle = await runtimeFetchJson(runtime, `${runtime.gameUrl}/game/debug/oracle?freshAiDebug=1`, signal);
        recordObservedTick(context, oracle?.tick);
        context.transcript.push({
          actor: alias,
          actionOracle: {
            tick: oracle?.tick ?? null,
            oracleDigest: sha256Json(compactOracleForDigest(oracle)),
          },
        });
        return oracle;
      },
      sleep: (ms) => deterministicPauseStep(parseDurationMs(ms, 0), context, sessions, runtime, alias, "action:sleep", signal),
      async advanceTicks(ticks) {
        throwIfAborted(signal);
        const count = Math.max(0, Math.trunc(Number(ticks) || 0));
        if (count === 0) return context.scheduler.currentTick;
        const baseTick = Number.isFinite(context.scheduler.currentTick)
          ? context.scheduler.currentTick
          : await currentScenarioTick(context, sessions, runtime, signal);
        return waitForScenarioTick(context, sessions, runtime, baseTick + count, signal);
      },
      recordFrame(frame) {
        context.transcript.push(frame);
      },
      forActor: bind,
    };
  };
  return bind(defaultAlias);
}

async function sendVerbStep(rawSpec, context, sessions, runtime, signal = null) {
  throwIfAborted(signal);
  const spec = typeof rawSpec === "string" ? parseScenarioStep(rawSpec).send : rawSpec;
  const session = requireActorSession(sessions, spec.actor);
  const line = interpolate(spec.line, context);
  const pause = line.match(/^\/pause\s+(.+)$/u);
  if (pause) {
    const pauseMs = parseDurationMs(pause[1], 0);
    return deterministicPauseStep(pauseMs, context, sessions, runtime, spec.actor, line, signal);
  }
  if (shouldAlignCommandLine(line) && spec.alignTick !== false) {
    await alignCommandTick({ spec, line, context, sessions, runtime, session, signal });
  }
  const startIndex = session.envelopes.length;
  context.transcript.push({ actor: spec.actor, send: { op: "verb", line } });
  session.send({ op: "verb", line });
  const envelope = await session.waitFor(
    (candidate) => (candidate.type === "event" && candidate.line === line) || (candidate.type === "status" && candidate.data?.line === line),
    `${spec.actor} ${line}`,
    parseDurationMs(spec.timeoutMs, defaultStepTimeoutMs),
    startIndex,
    signal,
  );
  await assertPostRestartCommandContinuity({ context, session, actor: spec.actor, envelope, startIndex, runtime, timeoutMs: parseDurationMs(spec.timeoutMs, defaultStepTimeoutMs), signal });
  recordObservedTick(context, envelope?.data?.result?.data?.issuedAtTick ?? envelope?.data?.event?.tick);
  context.lastEvent = envelope.type === "event" ? envelope : context.lastEvent;
  updateVarsFromEnvelope(context, envelope);
  if (spec.as) context.captures[spec.as] = envelope;
  context.transcript.push({ actor: spec.actor, recv: envelope });
  return envelope;
}

async function assertPostRestartCommandContinuity({ context, session, actor, envelope, startIndex, runtime, timeoutMs, signal = null }) {
  const floor = Number(context.restartCommandFloors?.[actor]);
  const commandId = Number(envelope?.data?.commandId);
  if (!Number.isInteger(floor) || floor < 1 || !Number.isInteger(commandId)) return;
  if (commandId < floor) {
    throw new ScenarioAssertionError("restart command continuity failed: reconnected driver reused a persisted command ID", { actor, commandId, commandIdFloor: floor });
  }
  const receipt = await waitForDriverEnvelope(
    session,
    (candidate) => candidate.type === "receipt" && Number(candidate.commandId) === commandId,
    `${actor} post-restart command receipt ${commandId}`,
    timeoutMs,
    startIndex,
    context,
    runtime,
    signal,
  );
  if (receipt.accepted !== true) {
    throw new ScenarioAssertionError("restart command continuity failed: reconnected command was not accepted", { actor, commandId, commandIdFloor: floor, receipt });
  }
  context.transcript.push({ actor, restartCommandContinuity: { commandIdFloor: floor, receipt: compactReceipt(receipt, { actor }) } });
  delete context.restartCommandFloors[actor];
}

async function queryStep(spec, context, sessions, signal = null) {
  throwIfAborted(signal);
  const session = requireActorSession(sessions, spec.actor);
  const line = interpolate(spec.line ?? spec.verb, context);
  const startIndex = session.envelopes.length;
  context.transcript.push({ actor: spec.actor, send: { op: "query", verb: line } });
  session.send({ op: "query", verb: line });
  const envelope = await session.waitFor(
    (candidate) => candidate.type === "query" && (candidate.line === line || `/${candidate.verb}` === line || candidate.verb === line.replace(/^\//u, "")),
    `${spec.actor} query ${line}`,
    parseDurationMs(spec.timeoutMs, defaultStepTimeoutMs),
    startIndex,
    signal,
  );
  recordObservedTick(context, envelope?.data?.serverTick ?? envelope?.data?.tick);
  if (spec.as) context.captures[spec.as] = envelope;
  context.transcript.push({ actor: spec.actor, recv: envelope });
  return envelope;
}

async function commandStep(spec, context, runtime, signal = null) {
  throwIfAborted(signal);
  const actorId = context.actors[spec.actor]?.id ?? interpolate(String(resolveValue(spec.actorId, context)), context);
  const actor = spec.actor ?? actorId;
  const command = interpolateDeep(spec.body ?? spec.command, context);
  const commandIdFloor = Number(context.restartDebugCommandFloors?.[actor]);
  const payload = { actorId, command, ...(Number.isInteger(commandIdFloor) && commandIdFloor >= 1 ? { commandId: commandIdFloor } : {}) };
  const response = await runtimePostJson(runtime, `${runtime.gameUrl}/game/debug/authority-command`, payload, 1500, signal);
  if (Number.isInteger(commandIdFloor) && commandIdFloor >= 1) {
    if (Number(response.commandId) < commandIdFloor || response.receipt?.accepted !== true) {
      throw new ScenarioAssertionError("restart command continuity failed: post-restart debug authority command was not accepted above its command ID floor", { actor, commandIdFloor, response });
    }
    context.transcript.push({ actor, restartCommandContinuity: { commandIdFloor, receipt: compactReceipt(response.receipt, { actor }) } });
    delete context.restartDebugCommandFloors[actor];
  }
  context.lastReceipt = response.receipt ?? null;
  if (spec.as) context.captures[spec.as] = response;
  context.transcript.push({ actor, command, recv: response });
  return response;
}

async function chatConnectStep(spec, context, runtime, signal = null) {
  throwIfAborted(signal);
  const key = spec.as ?? spec.client ?? spec.actor;
  if (!key) throw new Error("chatConnect requires actor/client/as");
  const actor = context.actors[spec.actor] ?? { id: spec.playerId, displayName: spec.displayName };
  const playerId = interpolate(String(spec.playerId ?? actor.id), context);
  const displayName = interpolate(String(spec.displayName ?? actor.displayName ?? playerId), context);
  const zone = interpolate(String(spec.zone ?? "open-desert-overworld"), context);
  const url = new URL("/chat/ws", runtime.gameUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("playerId", playerId);
  url.searchParams.set("displayName", displayName);
  url.searchParams.set("zone", zone);
  const session = new ChatSession(key, url.href);
  context.chatSessions.set(key, session);
  await session.start();
  const hello = await session.waitFor((packet) => packet.type === "chat.hello", `${key} chat hello`, parseDurationMs(spec.timeoutMs, defaultReadyTimeoutMs), 0, signal);
  if (spec.as) context.captures[spec.as] = hello;
  context.transcript.push({ chat: key, connect: { playerId, displayName, zone }, recv: hello });
  return hello;
}

async function chatSendStep(spec, context, signal = null) {
  throwIfAborted(signal);
  const session = requireChatSession(context, spec.client ?? spec.actor);
  const packet = {
    type: "chat.send",
    requestId: spec.requestId ?? `scenario-${session.envelopes.length + 1}`,
    channel: spec.channel ?? "local",
    body: interpolate(String(spec.body ?? ""), context),
    ...(spec.targetId ? { targetId: interpolate(String(spec.targetId), context) } : {}),
  };
  const startIndex = session.envelopes.length;
  context.transcript.push({ chat: session.key, send: packet });
  session.send(packet);
  const expectDelivery = spec.expectDelivery !== false;
  const envelope = await session.waitFor(
    (candidate) => expectDelivery
      ? candidate.type === "chat.message" && candidate.message?.body === packet.body
      : candidate.type === "chat.error" && candidate.requestId === packet.requestId,
    `${session.key} chat ${expectDelivery ? "echo" : "error"} ${packet.body}`,
    parseDurationMs(spec.timeoutMs, defaultStepTimeoutMs),
    startIndex,
    signal,
  );
  if (spec.as) context.captures[spec.as] = envelope;
  context.transcript.push({ chat: session.key, recv: envelope });
  return envelope;
}

async function awaitStep(spec, context, sessions, runtime, signal = null) {
  throwIfAborted(signal);
  const timeoutMs = parseDurationMs(spec.timeoutMs ?? spec.timeout, defaultStepTimeoutMs);
  if (spec.kind === "receipt" || spec.receipt) {
    const actor = spec.actor ?? spec.receipt?.actor;
    const session = requireActorSession(sessions, actor);
    const match = spec.match ?? spec.receipt?.match ?? spec.receipt ?? {};
    const expectedCommandId = resolveValue(match.commandId, context);
    const envelope = await waitForDriverEnvelope(session, (candidate) => candidate.type === "receipt" && (
      matchObject(candidate, match, context).ok
      || (match.accepted === true && candidate.commandId === expectedCommandId && candidate.accepted === false)
    ), `${actor} receipt ${JSON.stringify(match)}`, timeoutMs, 0, context, runtime, signal);
    context.lastReceipt = envelope;
    recordObservedTick(context, envelope.tick);
    if (spec.as) context.captures[spec.as] = envelope;
    context.transcript.push({ actor, await: "receipt", recv: envelope });
    if (!matchObject(envelope, match, context).ok) {
      throw new ScenarioAssertionError(`${actor} command ${envelope.commandKind ?? "unknown"} receipt rejected: ${envelope.reasonCode ?? "rejected"}`, { expected: match, receipt: envelope });
    }
    return envelope;
  }
  if (spec.kind === "event" || spec.event) {
    const actor = spec.actor;
    const session = requireActorSession(sessions, actor);
    const eventName = spec.event ?? spec.name;
    const match = spec.match ?? {};
    const envelope = await waitForDriverEnvelope(session, (candidate) => candidate.type === "event" && (!eventName || candidate.event === eventName) && matchObject(candidate, match, context).ok, `${actor} event ${eventName ?? "*"} ${JSON.stringify(match)}`, timeoutMs, 0, context, runtime, signal);
    context.lastEvent = envelope;
    recordObservedTick(context, envelope?.data?.event?.tick);
    updateVarsFromEnvelope(context, envelope);
    if (spec.as) context.captures[spec.as] = envelope;
    context.transcript.push({ actor, await: "event", recv: envelope });
    return envelope;
  }
  if (spec.kind === "query" || spec.query) return pollQuery(spec, context, sessions, runtime, timeoutMs, signal);
  if (spec.kind === "oracle" || spec.oracle) {
    const condition = spec.condition ?? spec.match ?? {};
    if (condition.type === "extractorCollectableUnits") {
      const extractor = await waitExtractorCollectable({
        extractorId: condition.extractorId ?? condition.extractor_id,
        target: condition.min ?? condition.target ?? 1,
        context, sessions, runtime, timeoutMs, actor: spec.actor ?? null, signal,
      });
      if (spec.as) context.captures[spec.as] = extractor;
      return extractor;
    }
    return pollHttpCondition(`${runtime.gameUrl}/game/debug/oracle?freshAiDebug=1`, spec, context, runtime, timeoutMs, "oracle", signal);
  }
  if (spec.kind === "shard" || spec.shard) return pollHttpCondition(`${runtime.gameUrl}/game/status`, spec, context, runtime, timeoutMs, "shard", signal);
  if (spec.kind === "chat" || spec.chat) return awaitChatStep(spec, context, timeoutMs, signal);
  throw new Error(`unsupported await step ${JSON.stringify(spec)}`);
}

async function expectStep(spec, context, sessions, runtime, signal = null) {
  throwIfAborted(signal);
  switch (spec.kind) {
    case "envelopeCount": return expectEnvelopeCount(spec, context, sessions);
    case "queryDelta": return expectQueryDelta(spec, context);
    case "captureCompare": return expectCaptureCompare(spec, context);
    case "oraclePredictionError": return expectOraclePredictionError(spec, context, runtime, signal);
    case "shard": return expectHttpMatch(`${runtime.gameUrl}/game/status`, spec, context, runtime, "shard", signal);
    case "oracle": return expectHttpMatch(`${runtime.gameUrl}/game/debug/oracle?freshAiDebug=1`, spec, context, runtime, "oracle", signal);
    case "chatEnvelopeCount": return expectChatEnvelopeCount(spec, context);
    case "commandStreamNoMatch": return expectCommandStreamNoMatch(spec, context, sessions);
    case "stableHash": return expectStableHash(spec, context, runtime, sessions, signal);
    default: throw new Error(`unsupported expect kind ${spec.kind}`);
  }
}

async function pollQuery(spec, context, sessions, runtime, timeoutMs, signal = null) {
  const actor = spec.actor;
  const query = interpolate(spec.query ?? spec.line, context);
  const deadline = Date.now() + timeoutMs;
  const pollState = manualPollState(context, timeoutMs);
  let latest = null;
  while (Date.now() <= deadline) {
    throwIfAborted(signal);
    latest = await queryStep({ actor, line: query }, context, sessions, signal);
    if (matchObject(latest, spec.match ?? {}, context).ok) {
      if (spec.as) context.captures[spec.as] = latest;
      return latest;
    }
    await waitBetweenPolls({ context, runtime, intervalMs: parseDurationMs(spec.intervalMs ?? spec.interval, 250), deadline, pollState, label: `${actor} query ${query}`, signal });
  }
  throw new ScenarioAssertionError(`timed out waiting for ${actor} query ${query}`, { latest, match: spec.match, ...pollState });
}

export async function runManualClockPoll({ observe, evaluate, advance, nextAdvanceTicks = () => 1, tickBudget, deadline, now = Date.now, label = "condition", signal = null }) {
  const pollState = {
    tickBudget: positiveInteger(tickBudget, 1),
    advancedTicks: 0,
    polls: 0,
    advanceCalls: 0,
  };
  let observation = null;
  while (now() <= deadline) {
    throwIfAborted(signal);
    observation = await observe(signal);
    pollState.polls += 1;
    const value = evaluate(observation);
    if (value !== false && value !== null && value !== undefined) return { observation, value, pollState };
    const remainingTicks = pollState.tickBudget - pollState.advancedTicks;
    if (remainingTicks <= 0) {
      throw new ScenarioAssertionError(`manual-clock tick budget exhausted while waiting for ${label}`, { ...pollState, latest: observation });
    }
    const requestedTicks = Number(nextAdvanceTicks(observation, pollState));
    if (!Number.isInteger(requestedTicks) || requestedTicks <= 0) {
      throw new ScenarioAssertionError(`manual-clock poll for ${label} produced an invalid advance quantum`, { ...pollState, requestedTicks, latest: observation });
    }
    const ticks = Math.min(requestedTicks, remainingTicks);
    await advance(ticks, observation, pollState, signal);
    pollState.advancedTicks += ticks;
    pollState.advanceCalls += 1;
  }
  throw new ScenarioAssertionError(`timed out waiting for ${label}`, { ...pollState, latest: observation });
}

function nextManualOraclePollTicks(payload, condition, context) {
  const currentTick = Number(payload?.tick ?? context.scheduler.currentTick);
  if (!Number.isFinite(currentTick)) return defaultManualPollTicks;
  if (condition.type === "inventoryRow") {
    const nextSampleTick = Object.values(payload?.actors ?? {})
      .map((actor) => Number(actor?.nextSampleTick))
      .filter((tick) => Number.isFinite(tick) && tick > currentTick)
      .sort((left, right) => left - right)[0];
    if (Number.isFinite(nextSampleTick)) return Math.max(1, Math.trunc(nextSampleTick - currentTick));
  }
  if (condition.type === "actor") {
    const actorId = interpolate(String(resolveValue(condition.actor ?? condition.actorId, context)), context);
    const postureUntilTick = Number(payload?.actors?.[actorId]?.postureUntilTick);
    if (Number.isFinite(postureUntilTick) && postureUntilTick > currentTick) {
      return Math.max(1, Math.trunc(postureUntilTick - currentTick));
    }
  }
  return defaultManualPollTicks;
}

async function pollHttpCondition(url, spec, context, runtime, timeoutMs, label, signal = null) {
  const deadline = Date.now() + timeoutMs;
  const condition = spec.condition ?? spec.match ?? {};
  let latest = null;
  let result = null;
  if (isManualClock(context)) {
    try {
      const outcome = await runManualClockPoll({
        observe: () => runtimeFetchJson(runtime, url, signal),
        evaluate(observation) {
          const evaluated = evaluateOracleCondition(observation, condition, context);
          return evaluated.ok ? evaluated : false;
        },
        async advance(ticks) {
          const baseTick = Number.isFinite(context.scheduler.currentTick)
            ? context.scheduler.currentTick
            : await currentScenarioTick(context, null, runtime, signal);
          await advanceManualClockToTick(context, runtime, baseTick + ticks, Math.max(1, deadline - Date.now()), `${label} condition`, signal);
        },
        nextAdvanceTicks: (observation) => nextManualOraclePollTicks(observation, condition, context),
        tickBudget: manualPollState(context, timeoutMs).tickBudget,
        deadline,
        label: `${label} condition`,
        signal,
      });
      latest = outcome.observation;
      result = outcome.value;
    } catch (error) {
      latest = error?.details?.latest ?? latest;
      context.transcript.push({ await: label, timeout: true, latest: compactHttpPayload(latest), condition, pollState: error?.details ?? null });
      throw error;
    }
  } else {
    while (Date.now() <= deadline) {
      throwIfAborted(signal);
      latest = await runtimeFetchJson(runtime, url, signal);
      result = evaluateOracleCondition(latest, condition, context);
      if (result.ok) break;
      await delayWithSignal(Math.min(parseDurationMs(spec.intervalMs ?? spec.interval, 250), Math.max(0, deadline - Date.now())), signal);
    }
    if (!result?.ok) {
      context.transcript.push({ await: label, timeout: true, latest: compactHttpPayload(latest), condition });
      throw new ScenarioAssertionError(`timed out waiting for ${label} condition`, { condition, latest: compactHttpPayload(latest) });
    }
  }
  if (spec.as) context.captures[spec.as] = result.capture ?? latest;
  if (result.vars) Object.assign(context.vars, result.vars);
  context.transcript.push({ await: label, recv: result.capture ?? compactHttpPayload(latest) });
  recordObservedTick(context, result.capture?.tick ?? latest?.tick);
  return result.capture ?? latest;
}

export async function waitExtractorCollectable({ extractorId, target = 1, context, sessions, runtime, timeoutMs = defaultStepTimeoutMs, actor = null, fetchOracle = null, advancePoll = null, signal = null }) {
  throwIfAborted(signal);
  const resolvedExtractorId = interpolate(String(resolveValue(extractorId, context)), context);
  const minimum = Number(resolveValue(target, context));
  const wallStarted = performance.now();
  if (!resolvedExtractorId) throw new Error("extractor collectable wait requires extractorId");
  if (!Number.isInteger(minimum) || minimum < 1) throw new Error(`extractor collectable wait target must be a positive integer; got ${target}`);
  const deadline = Date.now() + timeoutMs;
  const pollState = manualPollState(context, timeoutMs);
  const readOracle = fetchOracle ?? (() => runtimeFetchJson(runtime, `${runtime.gameUrl}/game/debug/oracle?freshAiDebug=1`, signal));
  let latest = null;
  while (Date.now() <= deadline) {
    throwIfAborted(signal);
    latest = await readOracle(signal);
    const extractor = Array.isArray(latest?.placedExtractors)
      ? latest.placedExtractors.find((candidate) => candidate?.extractorId === resolvedExtractorId)
      : null;
    const collectableUnits = Number(extractor?.collectableUnits);
    if (Number.isInteger(collectableUnits) && collectableUnits >= minimum) {
      const tick = recordObservedTick(context, latest?.tick);
      const capture = {
        ...extractor,
        tick: Number.isFinite(Number(tick))
          ? Math.trunc(Number(tick))
          : (Number.isFinite(Number(latest?.tick)) ? Math.trunc(Number(latest.tick)) : null),
      };
      context.transcript?.push({ actor, await: "extractorCollectableUnits", extractorId: resolvedExtractorId, target: minimum, wallElapsedMs: round(performance.now() - wallStarted), recv: { extractorId: resolvedExtractorId, collectableUnits, tick: capture.tick } });
      return capture;
    }
    if (advancePoll) {
      await advancePoll({ latest, extractorId: resolvedExtractorId, target: minimum, pollState, signal });
    } else {
      await waitBetweenPolls({ context, runtime, intervalMs: 250, deadline, pollState, label: `extractor ${resolvedExtractorId} collectableUnits >= ${minimum}`, signal });
    }
  }
  throw new ScenarioAssertionError(`timed out waiting for extractor ${resolvedExtractorId} collectableUnits >= ${minimum}`, {
    extractorId: resolvedExtractorId, target: minimum, latest: compactHttpPayload(latest), ...pollState,
  });
}

export function evaluateOracleCondition(payload, condition, context) {
  if (condition.type === "actor") {
    const actorId = interpolate(String(resolveValue(condition.actor ?? condition.actorId, context)), context);
    const actor = payload?.actors?.[actorId] ?? null;
    if (!actor) return { ok: false };
    const result = matchObject(actor, condition.match ?? {}, context);
    return { ok: result.ok, capture: actor, vars: condition.setLastKill ? { last_kill: actorId } : undefined };
  }
  if (condition.type === "inventoryRow") {
    const row = findInventoryRow(payload, condition, context);
    if (!row) return { ok: false };
    const result = matchObject(row, condition.match ?? {}, context);
    return { ok: result.ok, capture: row };
  }
  if (condition.type === "farmTile") {
    const parcelId = interpolate(String(resolveValue(condition.parcelId, context)), context);
    const cellX = Number(resolveValue(condition.cellX, context));
    const cellY = Number(resolveValue(condition.cellY, context));
    const plot = Array.isArray(payload?.farmPlots) ? payload.farmPlots.find((candidate) => candidate?.parcelId === parcelId) : null;
    const tile = Array.isArray(plot?.tiles) ? plot.tiles.find((candidate) => candidate?.cellX === cellX && candidate?.cellY === cellY) : null;
    if (!tile) return { ok: false };
    const result = matchObject(tile, condition.match ?? {}, context);
    return { ok: result.ok, capture: { parcelId, ...tile } };
  }
  return { ok: matchObject(payload, condition, context).ok, capture: payload };
}

async function awaitChatStep(spec, context, timeoutMs, signal = null) {
  const session = requireChatSession(context, spec.client ?? spec.actor);
  const match = spec.match ?? spec.chat?.match ?? {};
  const envelope = await session.waitFor(
    (candidate) => matchObject(candidate, match, context).ok,
    `${session.key} chat ${JSON.stringify(match)}`,
    timeoutMs,
    0,
    signal,
  );
  if (spec.as) context.captures[spec.as] = envelope;
  context.transcript.push({ chat: session.key, await: "chat", recv: envelope });
  return envelope;
}

function expectEnvelopeCount(spec, context, sessions) {
  const session = requireActorSession(sessions, spec.actor);
  const count = session.envelopes.filter((envelope) => {
    if (spec.envelopeType && envelope.type !== spec.envelopeType) return false;
    return matchObject(envelope, spec.match ?? {}, context).ok;
  }).length;
  assertComparison({ actual: count, op: spec.op ?? "eq", expected: Number(resolveValue(spec.value ?? spec.count, context)), label: `envelope count ${spec.actor}` });
  context.transcript.push({ expect: "envelopeCount", actor: spec.actor, count, match: spec.match ?? {} });
  return count;
}

function expectCommandStreamNoMatch(spec, context, sessions) {
  const match = spec.match ?? { commandKind: spec.commandKind ?? { regex: "^Debug" } };
  const commands = admittedCommandStream([...sessions.values()].flatMap((session) => session.envelopes));
  const matching = commands.filter((command) => matchObject(command, match, context).ok);
  if (matching.length > 0) throw new ScenarioAssertionError("command stream matched forbidden command", { match, matching });
  context.transcript.push({ expect: "commandStreamNoMatch", match, count: commands.length });
  return commands.length;
}

function expectChatEnvelopeCount(spec, context) {
  const session = requireChatSession(context, spec.client ?? spec.actor);
  const count = session.envelopes.filter((envelope) => matchObject(envelope, spec.match ?? {}, context).ok).length;
  assertComparison({ actual: count, op: spec.op ?? "eq", expected: Number(resolveValue(spec.value ?? spec.count, context)), label: `chat envelope count ${session.key}` });
  context.transcript.push({ expect: "chatEnvelopeCount", chat: session.key, count, match: spec.match ?? {} });
  return count;
}

function expectQueryDelta(spec, context) {
  const from = context.captures[spec.from];
  const to = context.captures[spec.to];
  if (!from || !to) throw new ScenarioAssertionError(`queryDelta missing captures ${spec.from}/${spec.to}`);
  if (spec.minDistanceCells !== undefined) {
    const start = { x: getPath(from, spec.xPath ?? "data.x"), y: getPath(from, spec.yPath ?? "data.y") };
    const end = { x: getPath(to, spec.xPath ?? "data.x"), y: getPath(to, spec.yPath ?? "data.y") };
    const distance = distanceCells(start, end);
    assertComparison({ actual: distance, op: "gte", expected: Number(spec.minDistanceCells), label: `distance ${spec.from}->${spec.to}` });
    context.transcript.push({ expect: "queryDelta", from: spec.from, to: spec.to, distanceCells: round(distance) });
    return distance;
  }
  const before = Number(getPath(from, spec.path));
  const after = Number(getPath(to, spec.path));
  const delta = after - before;
  if (spec.minDelta !== undefined) assertComparison({ actual: delta, op: "gte", expected: Number(resolveValue(spec.minDelta, context)), label: `delta ${spec.path}` });
  else assertComparison({ actual: delta, op: spec.op ?? "eq", expected: Number(resolveValue(spec.value, context)), label: `delta ${spec.path}` });
  context.transcript.push({ expect: "queryDelta", from: spec.from, to: spec.to, path: spec.path, delta: round(delta) });
  return delta;
}

function expectCaptureCompare(spec, context) {
  const actual = getPath(context.captures[spec.capture], spec.path);
  const expected = resolveValue(spec.value, context);
  assertComparison({ actual, op: spec.op ?? "eq", expected, label: `capture ${spec.capture}.${spec.path}` });
  context.transcript.push({ expect: "captureCompare", capture: spec.capture, path: spec.path, actual });
  return actual;
}

async function expectOraclePredictionError(spec, context, runtime, signal = null) {
  const oracle = await runtimeFetchJson(runtime, `${runtime.gameUrl}/game/debug/oracle?freshAiDebug=1`, signal);
  const actorId = context.actors[spec.actor]?.id ?? interpolate(String(resolveValue(spec.actorId, context)), context);
  const actor = oracle.actors?.[actorId];
  const query = context.captures[spec.query];
  if (!actor || !query) throw new ScenarioAssertionError(`predictionError missing actor/query ${actorId}/${spec.query}`);
  const error = distanceCells({ x: actor.x, y: actor.y }, { x: getPath(query, "data.x"), y: getPath(query, "data.y") });
  assertComparison({ actual: error, op: "lte", expected: Number(spec.maxCells), label: `prediction error ${actorId}` });
  context.transcript.push({ expect: "oraclePredictionError", actor: actorId, predictionErrorCells: round(error) });
  return error;
}

async function expectHttpMatch(url, spec, context, runtime, label, signal = null) {
  const payload = await runtimeFetchJson(runtime, url, signal);
  recordObservedTick(context, payload?.tick);
  if (spec.condition) {
    const result = evaluateOracleCondition(payload, spec.condition, context);
    if (!result.ok) throw new ScenarioAssertionError(`${label} condition failed`, { condition: spec.condition, payload: compactHttpPayload(payload) });
    if (spec.as) context.captures[spec.as] = result.capture ?? payload;
    return result.capture ?? payload;
  }
  assertMatch(payload, spec.match ?? {}, context, label);
  context.transcript.push({ expect: label, match: spec.match ?? {}, recv: compactHttpPayload(payload) });
  return payload;
}

async function expectStableHash(spec, context, runtime, sessions, signal = null) {
  await waitForStableHashTick(spec, context, sessions, runtime, signal);
  const oracle = await runtimeFetchJson(runtime, `${runtime.gameUrl}/game/debug/oracle?freshAiDebug=1`, signal);
  recordObservedTick(context, oracle?.tick);
  const digest = sha256Json(compactOracleForDigest(oracle));
  const sourceHash = oracle?.source?.stateHash ?? null;
  if (spec.sourceStateHash === "fixture") {
    assertComparison({ actual: sourceHash, op: "eq", expected: context.fixture.sourceStateHash, label: "fixture source stateHash" });
  }
  if (spec.equals) assertComparison({ actual: digest, op: "eq", expected: resolveValue(spec.equals, context), label: "stable snapshot digest" });
  if (spec.as) context.captures[spec.as] = { digest, sourceHash, tick: oracle?.tick ?? null };
  context.vars.last_stable_hash = digest;
  context.transcript.push({ expect: "stableHash", digest, sourceHash, tick: oracle?.tick ?? null });
  return { digest, sourceHash, tick: oracle?.tick ?? null };
}

export async function startFixtureServer({ repoRoot, fixture, scenario, runId, runDir, port, characterStorePath, lane = "accel", slowConsumerBufferCapBytes, serverEntrypoint, rustBridgeBin }) {
  const serverRoot = path.join(repoRoot, "server");
  const resolvedServerEntrypoint = serverEntrypoint
    ? path.resolve(serverEntrypoint)
    : path.join(serverRoot, "dist", "index.js");
  const resolvedRustBridgeBin = rustBridgeBin
    ? path.resolve(rustBridgeBin)
    : path.join(repoRoot, "target", "debug", "examples", "authority_bridge_server");
  await Promise.all([fs.access(resolvedServerEntrypoint), fs.access(resolvedRustBridgeBin)]);
  const unitRunToken = sha256Json(runId).replace(/^sha256:/u, "").slice(0, 12);
  const unit = `${fixture.defaults.serverUnitPrefix ?? "successor-play-gate"}-${safeName(scenario.name)}-${port}-${unitRunToken}`;
  const shardId = `${safeName(scenario.name)}-${runId}`;
  // Every scenario session uses a durable CharacterStore identity. Give even
  // non-restart scenarios an isolated checkpoint lane so first-world entry can
  // commit authority state before the roster marker. `scenario.persistence`
  // still declares and gates explicit restart assertions.
  const persistence = {
    stateDir: path.join(runDir, "persistence"),
    checkpointPath: path.join(runDir, "persistence", `${shardId}.checkpoint.json`),
    journalPath: path.join(runDir, "persistence", `${shardId}.journal.jsonl`),
  };
  await fs.mkdir(persistence.stateDir, { recursive: true });
  if (slowConsumerBufferCapBytes !== undefined && (!Number.isSafeInteger(slowConsumerBufferCapBytes) || slowConsumerBufferCapBytes <= 0)) {
    throw new RangeError("slowConsumerBufferCapBytes must be a positive safe integer");
  }
  const processHost = createProcessHost({ runId, runDir });
  const env = {
    PORT: String(port),
    HOST: "127.0.0.1",
    LOG_LEVEL: process.env.SUCCESSOR_PLAY_GATE_LOG_LEVEL ?? "silent",
    GAME_SHARD_ID: shardId,
    GAME_SHARD_PERSISTENCE: persistence ? "1" : "0",
    ...(persistence ? {
      GAME_SHARD_STATE_DIR: persistence.stateDir,
      GAME_SHARD_CHECKPOINT_PATH: persistence.checkpointPath,
      GAME_SHARD_JOURNAL_PATH: persistence.journalPath,
    } : {}),
    GAME_DEBUG_AUTHORITY_COMMANDS: "1",
    GAME_CLOCK: lane === "accel" ? defaultManualClockMode : defaultRealtimeClockMode,
    GAME_CHARACTER_STORE_PATH: characterStorePath,
    GAME_SLICE_PATH: fixture.slicePath,
    GAME_RUST_AUTHORITY_BRIDGE_BIN: resolvedRustBridgeBin,
    ...(scenario.linkDeadHoldSeconds === undefined ? {} : {
      GAME_LD_SECONDS: String(scenario.linkDeadHoldSeconds),
    }),
    GAME_MOVE_TRACE: process.env.GAME_MOVE_TRACE ?? "0",
    ...(slowConsumerBufferCapBytes === undefined ? {} : {
      GAME_SLOW_CONSUMER_BUFFER_CAP_BYTES: String(slowConsumerBufferCapBytes),
    }),
  };
  const gameUrl = `http://127.0.0.1:${port}`;
  const runtime = {
    handle: null,
    processHost,
    port,
    gameUrl,
    status: null,
    shardId,
    fixture,
    serverEntrypoint: resolvedServerEntrypoint,
    persistence,
    paths: {
      characterStorePath,
      slicePath: fixture.slicePath,
      ...(persistence ? { stateDir: persistence.stateDir, checkpointPath: persistence.checkpointPath, journalPath: persistence.journalPath } : {}),
    },
    transport: null,
    async readStatus() {
      return this.transport ? runtimeFetchJson(this, `${this.gameUrl}/game/status`) : fetchJson(`${this.gameUrl}/game/status`);
    },
    async readOracle() {
      return this.transport ? runtimeFetchJson(this, `${this.gameUrl}/game/debug/oracle?freshAiDebug=1`) : fetchJson(`${this.gameUrl}/game/debug/oracle?freshAiDebug=1`);
    },
    async checkpoint({ timeoutMs = defaultStepTimeoutMs } = {}) {
      if (!this.persistence) throw new Error("restart checkpoint failed: fixture runtime persistence is disabled");
      const preparedStatus = await this.readStatus();
      const checkpoint = this.transport
        ? await runtimePostJson(this, `${this.gameUrl}/game/debug/checkpoint`, {}, timeoutMs)
        : await postJson(`${this.gameUrl}/game/debug/checkpoint`, {}, timeoutMs);
      assertCheckpointEvidence(checkpoint, { shardId: this.shardId, persistence: this.persistence, preparedTick: preparedStatus?.tick });
      const status = await waitFor(() => this.readStatus(), timeoutMs, (candidate) => checkpointStatusConfirmed(candidate, checkpoint, preparedStatus?.tick));
      this.status = status;
      return { checkpoint, preparedStatus: compactStatus(preparedStatus), status: compactStatus(status) };
    },
    async stop(options) {
      if (!this.handle) return { ok: true, finalState: "not-started", failures: [] };
      return this.processHost.stop(this.handle, options);
    },
    async inspect() {
      if (!this.handle) return null;
      return this.processHost.inspect(this.handle);
    },
    async relaunch({ timeoutMs = 20_000 } = {}) {
      if (!this.persistence) throw new Error("restart relaunch failed: fixture runtime persistence is disabled");
      await launchFixtureRuntime(this, { processHost, unit, serverRoot, env, timeoutMs, restored: true });
      return this;
    },
    logs: (options) => runtime.handle ? processHost.logs(runtime.handle, options) : Promise.resolve(""),
  };
  await launchFixtureRuntime(runtime, { processHost, unit, serverRoot, env, timeoutMs: 20_000, restored: false });
  return runtime;
}

async function launchFixtureRuntime(runtime, { processHost, unit, serverRoot, env, timeoutMs, restored }) {
  const handle = await processHost.start({
    name: unit,
    argv: [nodeBin, runtime.serverEntrypoint],
    env,
    cwd: serverRoot,
  });
  try {
    const status = await waitFor(
      () => (runtime.transport
        ? runtimeFetchJson(runtime, `${runtime.gameUrl}/game/status`)
        : fetchJson(`${runtime.gameUrl}/game/status`)).catch(() => null),
      timeoutMs,
      (candidate) => {
        try {
          assertFixtureRuntimeStatus(candidate, runtime, { restored });
          return true;
        } catch {
          return false;
        }
      },
    );
    runtime.handle = handle;
    runtime.status = status;
  } catch (error) {
    const log = await processHost.logs(handle).catch(() => "");
    await processHost.stop(handle).catch(() => undefined);
    const detail = log.trim() ? `\n${log.slice(-4000)}` : "";
    throw new Error(`${error instanceof Error ? error.message : String(error)}${detail}`);
  }
}

function assertFixtureRuntimeStatus(status, runtime, { restored }) {
  if (!status?.shardId || status.shardId !== runtime.shardId) {
    throw new Error(`restart source validation failed: shardId ${status?.shardId ?? "missing"} !== ${runtime.shardId}`);
  }
  if (runtime.fixture.sourceStateHash && status.source?.stateHash !== runtime.fixture.sourceStateHash) {
    throw new Error(`restart source validation failed: fixture ${runtime.fixture.name} source hash ${status.source?.stateHash ?? "missing"} !== ${runtime.fixture.sourceStateHash}`);
  }
  if (!runtime.persistence) return;
  if (status.persistence?.enabled !== true
    || status.persistence?.checkpointPath !== runtime.persistence.checkpointPath
    || status.persistence?.journalPath !== runtime.persistence.journalPath) {
    throw new Error("restart source validation failed: shard persistence paths do not match the isolated fixture runtime");
  }
  if (restored && status.persistence?.restore?.loaded !== true) {
    throw new Error(`restart source validation failed: persisted authority state was not restored (${status.persistence?.restore?.reason ?? "unknown"})`);
  }
}

function assertCheckpointEvidence(checkpoint, { shardId, persistence, preparedTick }) {
  if (checkpoint?.schema !== "successor.game-shard-checkpoint-evidence.v1") throw new Error("restart checkpoint failed: invalid checkpoint evidence schema");
  if (checkpoint.shardId !== shardId) throw new Error(`restart checkpoint failed: shardId ${checkpoint.shardId ?? "missing"} !== ${shardId}`);
  if (!Number.isFinite(Number(checkpoint.tick)) || Number(checkpoint.tick) < Number(preparedTick ?? 0)) throw new Error("restart checkpoint failed: checkpoint tick predates prepared authority state");
  if (typeof checkpoint.stateHash !== "string" || checkpoint.stateHash.length === 0) throw new Error("restart checkpoint failed: checkpoint state hash is missing");
  if (checkpoint.persistence?.enabled !== true
    || checkpoint.persistence.checkpointPath !== persistence.checkpointPath
    || checkpoint.persistence.journalPath !== persistence.journalPath
    || Number(checkpoint.persistence.lastCheckpointTick) < Number(preparedTick ?? 0)) {
    throw new Error("restart checkpoint failed: checkpoint persistence evidence did not validate");
  }
}

function checkpointStatusConfirmed(status, checkpoint, preparedTick) {
  return status?.shardId === checkpoint.shardId
    && status.persistence?.enabled === true
    && status.persistence?.lastCheckpointTick >= Number(preparedTick ?? 0)
    && status.persistence?.lastCheckpointTick >= Number(checkpoint.tick)
    && status.persistence?.stateHash === checkpoint.stateHash;
}

class ChatSession {
  constructor(key, url) {
    this.key = key;
    this.url = url;
    this.envelopes = [];
    this.waiters = new Set();
    this.socket = null;
    this.closed = false;
  }

  async start() {
    if (typeof WebSocket !== "function") throw new Error("global WebSocket is unavailable for chat scenario steps");
    this.socket = new WebSocket(this.url);
    this.socket.addEventListener("message", (event) => this.recordMessage(event.data));
    this.socket.addEventListener("close", (event) => {
      this.closed = true;
      for (const waiter of this.waiters) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error(`chat ${this.key} closed before ${waiter.label}: ${event.code} ${event.reason}`));
      }
      this.waiters.clear();
    });
    this.socket.addEventListener("error", () => {
      for (const waiter of this.waiters) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error(`chat ${this.key} socket error before ${waiter.label}`));
      }
      this.waiters.clear();
    });
  }

  send(packet) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) throw new Error(`chat ${this.key} is not open`);
    this.socket.send(JSON.stringify(packet));
  }

  waitFor(predicate, label, timeoutMs = defaultStepTimeoutMs, startIndex = 0, signal = null) {
    const existing = this.envelopes.slice(startIndex).find(predicate);
    if (existing) return Promise.resolve(existing);
    if (signal?.aborted) return Promise.reject(signal.reason ?? cancellationError());
    if (this.closed) return Promise.reject(new Error(`chat ${this.key} already closed before ${label}`));
    const gate = Promise.withResolvers();
    const waiter = {
      predicate, label, startIndex, resolve: gate.resolve, reject: gate.reject, signal, onAbort: null,
      timer: setTimeout(() => {
        this.waiters.delete(waiter);
        signal?.removeEventListener("abort", waiter.onAbort);
        gate.reject(new Error(`timed out waiting for chat ${this.key} ${label}; recent=${JSON.stringify(this.envelopes.slice(-12))}`));
      }, timeoutMs),
    };
    waiter.onAbort = () => {
      clearTimeout(waiter.timer);
      this.waiters.delete(waiter);
      gate.reject(signal.reason ?? cancellationError());
    };
    signal?.addEventListener("abort", waiter.onAbort, { once: true });
    this.waiters.add(waiter);
    return gate.promise;
  }

  async close() {
    if (!this.socket || this.closed) return;
    this.socket.close(1000, "scenario complete");
    await waitFor(() => this.closed, 2_000).catch(() => undefined);
  }

  recordMessage(data) {
    const text = typeof data === "string" ? data : String(data);
    let envelope;
    try {
      envelope = JSON.parse(text);
    } catch {
      envelope = { type: "chat.parse_error", raw: text };
    }
    this.envelopes.push(envelope);
    this.pumpWaiters();
  }

  pumpWaiters() {
    for (const waiter of [...this.waiters]) {
      const match = this.envelopes.slice(waiter.startIndex).find(waiter.predicate);
      if (!match) continue;
      clearTimeout(waiter.timer);
      this.waiters.delete(waiter);
      waiter.resolve(match);
    }
  }
}

class DriverSession {
  constructor(options) {
    this.options = options;
    this.envelopes = [];
    this.stderr = [];
    this.waiters = new Set();
    this.stdoutBuffer = "";
    this.stderrBuffer = "";
    this.exit = null;
    this.child = null;
  }

  async start() {
    const cliPath = this.options.cliPath
      ? path.resolve(this.options.cliPath)
      : path.join(this.options.repoRoot, "client", "dist", "headless", "cli.js");
    const argv = [
      cliPath,
      "--game-url", this.options.gameUrl,
      "--slice", this.options.slicePath,
      "--actor-id", this.options.actorId,
      "--player-id", this.options.playerId,
      "--display-name", this.options.displayName,
      "--character-id", this.options.characterId,
      "--spawn-area", this.options.spawnArea,
      "--spawn-x", String(this.options.spawnX),
      "--spawn-y", String(this.options.spawnY),
      "--facing", this.options.facing,
      "--tick-ms", String(this.options.tickMs),
      ...(Number.isInteger(this.options.commandIdFloor) && this.options.commandIdFloor > 0
        ? ["--command-id-floor", String(this.options.commandIdFloor)]
        : []),
    ];
    this.child = spawn(process.execPath, argv, {
      cwd: this.options.repoRoot,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stdout.setEncoding("utf8");
    this.child.stderr.setEncoding("utf8");
    this.child.stdout.on("data", (chunk) => this.recordStdout(chunk));
    this.child.stderr.on("data", (chunk) => this.recordStderr(chunk));
    this.child.on("exit", (code, signal) => {
      this.flushBuffers();
      this.exit = { code, signal };
      for (const waiter of this.waiters) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error(`successor-play ${this.options.actorId} exited before ${waiter.label}: ${JSON.stringify(this.exit)}\n${this.stderr.join("\n")}`));
      }
      this.waiters.clear();
    });
  }

  async reconnect(gameUrl, commandIdFloor = nextDriverCommandIdFloor(this)) {
    if (typeof gameUrl !== "string" || gameUrl.length === 0) throw new Error(`driver ${this.options.actorId} reconnect requires a game URL`);
    if (!this.exit) throw new Error(`driver ${this.options.actorId} reconnect requires a closed prior session`);
    if (!Number.isInteger(commandIdFloor) || commandIdFloor < 1) throw new Error(`driver ${this.options.actorId} reconnect requires a positive command ID floor`);
    this.options = { ...this.options, gameUrl, commandIdFloor };
    this.child = null;
    this.exit = null;
    this.stdoutBuffer = "";
    this.stderrBuffer = "";
    await this.start();
  }

  send(frame) {
    if (!this.child || this.child.stdin.destroyed) throw new Error(`driver ${this.options.actorId} is not writable`);
    this.child.stdin.write(`${JSON.stringify(frame)}\n`);
  }

  waitFor(predicate, label, timeoutMs = defaultStepTimeoutMs, startIndex = 0, signal = null) {
    const existing = this.envelopes.slice(startIndex).find(predicate);
    if (existing) return Promise.resolve(existing);
    if (signal?.aborted) return Promise.reject(signal.reason ?? cancellationError());
    if (this.exit) return Promise.reject(new Error(`successor-play ${this.options.actorId} already exited before ${label}: ${JSON.stringify(this.exit)}\n${this.stderr.join("\n")}`));
    const gate = Promise.withResolvers();
    const waiter = {
      predicate, label, startIndex, resolve: gate.resolve, reject: gate.reject, signal, onAbort: null,
      timer: setTimeout(() => {
        this.waiters.delete(waiter);
        signal?.removeEventListener("abort", waiter.onAbort);
        gate.reject(new Error(`timed out waiting for ${this.options.actorId} ${label}; recent=${JSON.stringify(this.envelopes.slice(-12))}; stderr=${this.stderr.join("\n")}`));
      }, timeoutMs),
    };
    waiter.onAbort = () => {
      clearTimeout(waiter.timer);
      this.waiters.delete(waiter);
      gate.reject(signal.reason ?? cancellationError());
    };
    signal?.addEventListener("abort", waiter.onAbort, { once: true });
    this.waiters.add(waiter);
    return gate.promise;
  }

  async close() {
    if (!this.child || this.exit) return;
    this.send({ op: "quit" });
    await this.waitFor((envelope) => envelope.type === "status" && envelope.status === "closed", "driver closed", 3_000).catch(() => {
      if (this.child && !this.child.killed) this.child.kill("SIGTERM");
    });
    await waitFor(() => this.exit !== null, 3_000).catch(() => {
      if (this.child && !this.child.killed) this.child.kill("SIGKILL");
    });
    if (!this.exit) throw new Error(`driver ${this.options.actorId} leaked after close`);
  }

  recordStdout(chunk) {
    this.stdoutBuffer += chunk;
    let newline = this.stdoutBuffer.indexOf("\n");
    while (newline !== -1) {
      const line = this.stdoutBuffer.slice(0, newline).trimEnd();
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      this.recordStdoutLine(line);
      newline = this.stdoutBuffer.indexOf("\n");
    }
  }

  recordStderr(chunk) {
    this.stderrBuffer += chunk;
    let newline = this.stderrBuffer.indexOf("\n");
    while (newline !== -1) {
      this.stderr.push(this.stderrBuffer.slice(0, newline));
      this.stderrBuffer = this.stderrBuffer.slice(newline + 1);
      newline = this.stderrBuffer.indexOf("\n");
    }
  }

  flushBuffers() {
    if (this.stdoutBuffer.trim()) this.recordStdoutLine(this.stdoutBuffer.trimEnd());
    if (this.stderrBuffer.trim()) this.stderr.push(this.stderrBuffer.trimEnd());
    this.stdoutBuffer = "";
    this.stderrBuffer = "";
  }

  recordStdoutLine(line) {
    if (!line) return;
    let envelope;
    try {
      envelope = JSON.parse(line);
    } catch {
      this.stderr.push(`non-json stdout: ${line}`);
      return;
    }
    if (envelope?.v !== driverVersion) this.stderr.push(`unexpected driver envelope version: ${line}`);
    this.envelopes.push(envelope);
    this.pumpWaiters();
  }

  pumpWaiters() {
    for (const waiter of [...this.waiters]) {
      const match = this.envelopes.slice(waiter.startIndex).find(waiter.predicate);
      if (!match) continue;
      clearTimeout(waiter.timer);
      this.waiters.delete(waiter);
      waiter.resolve(match);
    }
  }
}

function updateVarsFromEnvelope(context, envelope) {
  const targetId = envelope?.data?.result?.data?.target?.id;
  if (typeof targetId === "string" && targetId.length > 0) context.vars.target = targetId;
  const event = envelope?.data?.event;
  if (event && typeof event.targetActorId === "string" && /kill|death|down/i.test(String(event.kind ?? event.type ?? event.lifecycle ?? ""))) {
    context.vars.last_kill = event.targetActorId;
  }
}

function admittedCommandStream(envelopes) {
  const queued = envelopes
    .filter((envelope) => envelope.type === "event" && envelope.event === "authority_queued")
    .map((envelope) => ({
      line: envelope.line,
      commandId: envelope.data?.commandId,
      commandKind: envelope.data?.commandKind,
      flushed: envelope.data?.flushed,
    }));
  const receiptsById = new Map(envelopes
    .filter((envelope) => envelope.type === "receipt")
    .map((receipt) => [receipt.commandId, receipt]));
  return queued.map((entry) => ({ ...entry, receipt: receiptsById.get(entry.commandId) ?? null })).filter((entry) => entry.receipt?.accepted === true);
}

function requireActorSession(sessions, alias) {
  if (!alias) throw new Error("scenario step requires actor");
  const session = sessions.get(alias);
  if (!session) throw new Error(`unknown scenario actor ${alias}`);
  return session;
}

function requireChatSession(context, key) {
  if (!key) throw new Error("scenario chat step requires actor/client");
  const session = context.chatSessions.get(key);
  if (!session) throw new Error(`unknown scenario chat client ${key}`);
  return session;
}

async function deterministicPauseStep(pauseMs, context, sessions, runtime, actor = null, line = null, signal = null) {
  throwIfAborted(signal);
  const tickRateHz = scenarioTickRateHz(context);
  const ticks = Math.max(0, Math.round((pauseMs / 1000) * tickRateHz));
  if (ticks <= 0) {
    context.transcript.push({ pauseMs, pauseTicks: 0, ...(actor ? { actor, line } : {}) });
    return null;
  }
  const baseTick = Number.isFinite(context.scheduler.currentTick) ? context.scheduler.currentTick : await currentScenarioTick(context, sessions, runtime, signal);
  const targetTick = baseTick + ticks;
  const observedTick = await waitForScenarioTick(context, sessions, runtime, targetTick, signal);
  context.transcript.push({ pauseMs, pauseTicks: ticks, targetTick, observedTick, ...(actor ? { actor, line } : {}) });
  return null;
}

async function alignCommandTick({ spec, line, context, sessions, runtime, session, signal = null }) {
  const targetTick = await nextCommandTargetTick(spec, context, sessions, runtime, signal);
  const observedTick = await waitForShardTick(context, runtime, targetTick, parseDurationMs(spec.alignTimeoutMs, defaultStepTimeoutMs), signal);
  recordObservedTick(context, observedTick);
  context.scheduler.nextCommandTick = Math.max(context.scheduler.nextCommandTick ?? 0, observedTick + commandGapTicks(context));
  context.transcript.push({ actor: spec.actor, sync: "commandTick", line, targetTick, observedTick });
  return observedTick;
}

async function nextCommandTargetTick(spec, context, sessions, runtime, signal = null) {
  const explicit = spec.atTick ?? spec.tick;
  if (explicit !== undefined) return Number(resolveValue(explicit, context));
  const configured = Number(context.scheduler.nextCommandTick);
  const current = Number.isFinite(context.scheduler.currentTick) ? context.scheduler.currentTick : await currentScenarioTick(context, sessions, runtime, signal);
  if (Number.isFinite(configured) && configured > current) return Math.trunc(configured);
  return current + commandGapTicks(context);
}

async function waitForStableHashTick(spec, context, sessions, runtime, signal = null) {
  const settleTicks = Math.max(0, Number(resolveValue(spec.settleTicks ?? 0, context)));
  const after = spec.after ?? spec.afterTick;
  if (after === undefined && settleTicks === 0) return null;
  const base = after === undefined
    ? Number.isFinite(context.scheduler.currentTick) ? context.scheduler.currentTick : await currentScenarioTick(context, sessions, runtime, signal)
    : Number(resolveValue(after, context));
  const targetTick = Math.max(0, Math.trunc(base + settleTicks));
  const observedTick = await waitForScenarioTick(context, sessions, runtime, targetTick, signal);
  context.transcript.push({ sync: "stableHashTick", targetTick, observedTick });
  return observedTick;
}

async function waitForDriverEnvelope(session, predicate, label, timeoutMs, startIndex, context, runtime, signal = null) {
  if (!isManualClock(context)) return session.waitFor(predicate, label, timeoutMs, startIndex, signal);
  const deadline = Date.now() + timeoutMs;
  const pollState = manualPollState(context, timeoutMs);
  while (Date.now() <= deadline) {
    throwIfAborted(signal);
    const existing = session.envelopes.slice(startIndex).find(predicate);
    if (existing) return existing;
    if (session.exit) {
      throw new Error(`successor-play ${session.options.actorId} exited before ${label}: ${JSON.stringify(session.exit)}\n${session.stderr.join("\n")}`);
    }
    await waitBetweenPolls({ context, runtime, intervalMs: 1_000 / scenarioTickRateHz(context), deadline, pollState, label, signal });
  }
  throw new ScenarioAssertionError(`timed out waiting for ${session.options.actorId} ${label}`, { recent: session.envelopes.slice(-12), stderr: session.stderr, ...pollState });
}

function manualPollState(context, timeoutMs) {
  return {
    tickBudget: isManualClock(context) ? Math.max(1, Math.ceil((timeoutMs / 1_000) * scenarioTickRateHz(context))) : 0,
    advancedTicks: 0,
  };
}

async function waitBetweenPolls({ context, runtime, intervalMs, deadline, pollState, label, signal = null }) {
  throwIfAborted(signal);
  if (!isManualClock(context)) {
    await delayWithSignal(Math.min(intervalMs, Math.max(0, deadline - Date.now())), signal);
    return;
  }
  const remainingBudget = pollState.tickBudget - pollState.advancedTicks;
  if (remainingBudget <= 0) throw new ScenarioAssertionError(`manual-clock tick budget exhausted while waiting for ${label}`, {
    tickBudget: pollState.tickBudget, advancedTicks: pollState.advancedTicks, currentTick: context.scheduler.currentTick,
  });
  const ticks = Math.min(Math.max(defaultManualPollTicks, commandGapTicks(context)), remainingBudget);
  const baseTick = Number.isFinite(context.scheduler.currentTick)
    ? context.scheduler.currentTick
    : await currentScenarioTick(context, null, runtime, signal);
  await advanceManualClockToTick(context, runtime, baseTick + ticks, Math.max(1, deadline - Date.now()), label, signal);
  pollState.advancedTicks += ticks;
}

async function advanceManualClockToTick(context, runtime, rawTargetTick, timeoutMs = defaultAdvanceWallTimeoutMs, label = "tick advance", signal = null) {
  throwIfAborted(signal);
  const queued = (context.scheduler.advanceQueue ?? Promise.resolve())
    .catch(() => {})
    .then(() => advanceManualClockToTickUnlocked(context, runtime, rawTargetTick, timeoutMs, label, signal));
  context.scheduler.advanceQueue = queued;
  return queued;
}

async function advanceManualClockToTickUnlocked(context, runtime, rawTargetTick, timeoutMs = defaultAdvanceWallTimeoutMs, label = "tick advance", signal = null) {
  throwIfAborted(signal);
  if (!isManualClock(context)) throw new Error(`${label}: manual clock required; detected=${context.scheduler.clockMode}`);
  const targetTick = Math.max(0, Math.trunc(Number(rawTargetTick)));
  if (!Number.isFinite(targetTick)) throw new Error(`${label}: target tick must be finite`);
  const deadline = Date.now() + Math.max(1, timeoutMs);
  let currentTick = Number.isFinite(context.scheduler.currentTick) ? context.scheduler.currentTick : await currentScenarioTick(context, null, runtime, signal);
  if (currentTick >= targetTick) return currentTick;
  const totalTicks = targetTick - currentTick;
  const operationBudget = maxAdvanceTicksPerOperation();
  if (totalTicks > operationBudget) throw new ScenarioAssertionError(`${label}: requested ${totalTicks} ticks exceeds bounded operation budget ${operationBudget}`, { currentTick, targetTick, operationBudget });
  const chunkLimit = maxAdvanceTicksPerRequest();
  while (currentTick < targetTick) {
    throwIfAborted(signal);
    const wallRemainingMs = deadline - Date.now();
    if (wallRemainingMs <= 0) throw new ScenarioAssertionError(`${label}: wall-clock deadline expired during manual advance`, { currentTick, targetTick, timeoutMs });
    const requestedTicks = Math.min(chunkLimit, targetTick - currentTick);
    const requestedTargetTick = currentTick + requestedTicks;
    const intervalMs = 1_000 / scenarioTickRateHz(context);
    const requestedMs = requestedTicks * intervalMs + intervalMs / 1_000_000;
    let response;
    try {
      response = await runtimePostJson(runtime, `${runtime.gameUrl}/game/debug/clock/advance`, { toTick: requestedTargetTick }, Math.min(defaultAdvanceWallTimeoutMs, wallRemainingMs), signal);
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new ScenarioAssertionError(`${label}: manual clock advance failed loudly: ${error instanceof Error ? error.message : String(error)}`, { currentTick, targetTick, requestedTargetTick });
    }
    if (response?.schema !== clockAdvanceSchema || response?.mode !== defaultManualClockMode) throw new ScenarioAssertionError(`${label}: invalid manual clock response`, { response });
    const observedTick = Number(response.tick);
    if (!Number.isFinite(observedTick) || observedTick !== requestedTargetTick || Number(response.advancedTicks) !== requestedTicks) throw new ScenarioAssertionError(`${label}: manual clock advance did not reach exact tick`, { currentTick, requestedTicks, requestedTargetTick, response });
    context.scheduler.advancedTicks += requestedTicks;
    currentTick = recordObservedTick(context, observedTick);
    context.scheduler.currentVirtualNowMs = Number(response.virtualNowMs);
    recordAuthorityBridgeMetrics(runtime.transport, response);
    context.transcript.push({ clockAdvance: { toTick: requestedTargetTick, requestedTicks, requestedMs, label }, recv: compactClockAdvance(response) });
  }
  return currentTick;
}

function maxAdvanceTicksPerRequest() {
  return positiveInteger(process.env.SUCCESSOR_SCENARIO_ADVANCE_CHUNK_TICKS, defaultMaxAdvanceTicksPerRequest);
}

function maxAdvanceTicksPerOperation() {
  return positiveInteger(process.env.SUCCESSOR_SCENARIO_MAX_ADVANCE_TICKS, defaultMaxAdvanceTicksPerOperation);
}

function positiveInteger(value, fallback) {
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric > 0 ? numeric : fallback;
}

function isManualClock(context) {
  return context.scheduler.clockMode === defaultManualClockMode;
}
async function currentScenarioTick(context, _sessions, runtime, signal = null) {
  const status = await runtimeFetchJson(runtime, `${runtime.gameUrl}/game/status`, signal);
  recordObservedTick(context, status?.tick);
  return Number(status?.tick ?? 0);
}

async function waitForScenarioTick(context, _sessions, runtime, targetTick, signal = null) {
  return waitForShardTick(context, runtime, targetTick, defaultStepTimeoutMs, signal);
}

async function waitForDriverTick(session, targetTick, timeoutMs = defaultStepTimeoutMs, signal = null) {
  const deadline = Date.now() + timeoutMs;
  let latest = null;
  while (Date.now() <= deadline) {
    throwIfAborted(signal);
    const startIndex = session.envelopes.length;
    session.send({ op: "query", verb: "/where" });
    const envelope = await session.waitFor((candidate) => candidate.type === "query" && candidate.verb === "where", `driver tick >= ${targetTick}`, Math.min(1500, Math.max(100, deadline - Date.now())), startIndex, signal);
    latest = Number(envelope?.data?.serverTick ?? envelope?.data?.tick);
    if (Number.isFinite(latest) && latest >= targetTick) return Math.trunc(latest);
    await delayWithSignal(1, signal);
  }
  throw new ScenarioAssertionError(`timed out waiting for driver tick >= ${targetTick}`, { latest });
}

async function waitForShardTick(context, runtime, rawTargetTick, timeoutMs = defaultStepTimeoutMs, signal = null) {
  const targetTick = Math.max(0, Math.trunc(Number(rawTargetTick)));
  if (!Number.isFinite(targetTick)) throw new ScenarioAssertionError(`target tick must be finite`, { rawTargetTick });
  if (isManualClock(context)) return advanceManualClockToTick(context, runtime, targetTick, timeoutMs, `wait for shard tick ${targetTick}`, signal);
  const deadline = Date.now() + timeoutMs;
  let latest = null;
  while (Date.now() <= deadline) {
    throwIfAborted(signal);
    const status = await runtimeFetchJson(runtime, `${runtime.gameUrl}/game/status`, signal);
    latest = Number(status?.tick);
    recordObservedTick(context, latest);
    if (Number.isFinite(latest) && latest >= targetTick) return Math.trunc(latest);
    await delayWithSignal(1, signal);
  }
  throw new ScenarioAssertionError(`timed out waiting for shard tick >= ${targetTick}`, { latest });
}

function firstDriverSession(sessions) {
  for (const session of sessions.values()) return session;
  return null;
}

function recordObservedTick(context, rawTick) {
  const tick = Number(rawTick);
  if (!Number.isFinite(tick)) return null;
  const normalized = Math.max(0, Math.trunc(tick));
  context.scheduler.currentTick = Math.max(context.scheduler.currentTick ?? 0, normalized);
  return normalized;
}

function scenarioTickRateHz(context) {
  const value = Number(context.scheduler.tickRateHz);
  return Number.isFinite(value) && value > 0 ? value : 30;
}

function commandGapTicks(context) {
  const value = Number(context.scheduler.commandGapTicks);
  return Number.isFinite(value) && value >= 0 ? Math.trunc(value) : 1;
}

function shouldAlignCommandLine(line) {
  const verb = String(line).trim().split(/\s+/u)[0]?.replace(/^\//u, "").toLowerCase();
  return Boolean(verb) && !new Set(["target", "ui", "camp", "where", "vitals", "inv", "nearby", "queue", "budget", "pause"]).has(verb);
}

function lastStableHashDigest(context) {
  const stableHashes = Object.values(context.captures).filter((capture) => capture && typeof capture === "object" && typeof capture.digest === "string");
  return stableHashes.at(-1)?.digest ?? null;
}
function scenarioClockSnapshot(context, runtime, signal = null) {
  if (!isManualClock(context)) return readClockSnapshot(runtime, signal);
  throwIfAborted(signal);
  return Promise.resolve({
    mode: context.scheduler.clockMode,
    tick: context.scheduler.currentTick,
    virtualNowMs: context.scheduler.currentVirtualNowMs,
  });
}

async function readClockSnapshot(runtime, signal = null) {
  const clock = await runtimeFetchJson(runtime, `${runtime.gameUrl}/game/debug/clock`, signal);
  if (clock?.schema !== clockSnapshotSchema || !supportedClockMode(clock.mode)) {
    throw new Error(`invalid debug clock snapshot: ${JSON.stringify(clock)}`);
  }
  const tick = Number(clock.tick);
  const virtualNowMs = Number(clock.virtualNowMs);
  if (!Number.isFinite(tick) || !Number.isFinite(virtualNowMs)) {
    throw new Error(`debug clock snapshot has non-finite values: ${JSON.stringify(clock)}`);
  }
  return { mode: clock.mode, tick: Math.trunc(tick), virtualNowMs };
}

function supportedClockMode(mode) {
  return mode === defaultManualClockMode || mode === defaultRealtimeClockMode;
}

function assertRequestedClockMode(lane, detectedMode) {
  const expectedMode = lane === "accel" ? defaultManualClockMode : defaultRealtimeClockMode;
  if (detectedMode !== expectedMode) {
    throw new Error(`scenario lane ${lane} requires ${expectedMode} clock; server reported ${detectedMode ?? "unknown"}`);
  }
}

function tickRateFromStatus(status) {
  const intervalMs = Number(status?.authority?.cadence?.authorityIntervalMs);
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) return null;
  const rate = 1_000 / intervalMs;
  return Number.isFinite(rate) && rate > 0 ? rate : null;
}

function scenarioStepKind(step) {
  if (step.pauseMs !== undefined) return "pause";
  return ["restart", "send", "query", "command", "action", "chatConnect", "chatSend", "await", "expect"].find((key) => step[key] !== undefined) ?? "unknown";
}

function scenarioStepActor(step) {
  const kind = scenarioStepKind(step);
  const spec = step[kind];
  return spec && typeof spec === "object" ? spec.actor ?? null : null;
}

function stateProbeIntervalSteps(scenario) {
  return positiveInteger(scenario.transcript?.stateProbeIntervalSteps, defaultStateProbeIntervalSteps);
}

function isMacroHookStep(step) {
  return step.action !== undefined;
}

async function recordStateProbe(context, runtime, afterStep, reason) {
  const oracle = await runtimeFetchJson(runtime, `${runtime.gameUrl}/game/debug/oracle?freshAiDebug=1`);
  recordObservedTick(context, oracle?.tick);
  const probe = {
    afterStep,
    reason,
    tick: Number.isFinite(Number(oracle?.tick)) ? Math.trunc(Number(oracle.tick)) : null,
    stateHash: sha256Json(compactOracleForDigest(oracle)),
  };
  context.stateProbes.push(probe);
  context.transcript.push({ oracleProbe: probe });
  return probe;
}

function recordFinalStateProbe(context, oracle, afterStep, stateHash = null) {
  const probe = {
    afterStep,
    reason: "final",
    tick: Number.isFinite(Number(oracle?.tick)) ? Math.trunc(Number(oracle.tick)) : null,
    stateHash: stateHash ?? sha256Json(compactOracleForDigest(oracle)),
  };
  const previous = context.stateProbes.at(-1);
  if (previous?.afterStep === probe.afterStep && previous.stateHash === probe.stateHash) {
    previous.reason = `${previous.reason}+final`;
    previous.tick = probe.tick;
    return previous;
  }
  context.stateProbes.push(probe);
  context.transcript.push({ oracleProbe: probe });
  return probe;
}

export function enrichReceipts({ frames = [], actor = null, issuedAtTick = null, receipts = [] } = {}) {
  const observed = [];
  for (const frame of frames) collectReceipts(frame, observed);
  return uniqueReceipts([
    ...observed.map((receipt) => compactReceipt(receipt, { actor, issuedAtTick })),
    ...receipts.map((receipt) => compactReceipt(receipt, { actor, issuedAtTick })),
  ]);
}

export function recordActionStepResult({ context, stepRecord, actionResult, appendFrames = true }) {
  if (!stepRecord || typeof stepRecord !== "object") throw new Error("action step record is required");
  stepRecord.action = actionResult;
  const frames = Array.isArray(actionResult?.expandedFrames) ? actionResult.expandedFrames : [];
  if (appendFrames && Array.isArray(context?.transcript)) context.transcript.push(...frames);
  stepRecord.expandedFrames ??= [];
  stepRecord.expandedFrames.push(...frames);
  stepRecord.receipts = enrichReceipts({
    frames: stepRecord.expandedFrames,
    actor: stepRecord.actor ?? actionResult?.actor ?? null,
    issuedAtTick: stepRecord.issuedAtTick ?? null,
    receipts: stepRecord.receipts ?? actionResult?.receipts ?? [],
  });
  if (stepRecord.receipts.length === 1) stepRecord.receipt = stepRecord.receipts[0];
  else delete stepRecord.receipt;
  return stepRecord;
}

function collectReceipts(value, receipts) {
  if (!value || typeof value !== "object") return;
  if (value.type === "receipt") receipts.push(value);
  if (value.receipt && typeof value.receipt === "object") receipts.push(value.receipt);
  if (Array.isArray(value.receipts)) receipts.push(...value.receipts.filter((receipt) => receipt && typeof receipt === "object"));
  if (value.recv && typeof value.recv === "object") collectReceipts(value.recv, receipts);
}

function compactReceipt(receipt, identity = {}) {
  return {
    actor: identity.actor ?? receipt?.actor ?? null,
    commandId: receipt?.commandId ?? null,
    commandKind: receipt?.commandKind ?? null,
    issuedAtTick: finiteInteger(receipt?.issuedAtTick ?? receipt?.issued_at_tick ?? identity.issuedAtTick),
    accepted: receipt?.accepted === true,
    reasonCode: receipt?.reasonCode ?? receipt?.reason_code ?? null,
    tick: finiteInteger(receipt?.tick),
  };
}

function uniqueReceipts(receipts) {
  const unique = new Map();
  for (const receipt of receipts) {
    const key = `${receipt.actor ?? "none"}:${receipt.commandId ?? "none"}:${receipt.commandKind ?? "none"}:${receipt.tick ?? "none"}:${receipt.accepted}`;
    unique.set(key, receipt);
  }
  return [...unique.values()];
}

function attachDriverReceiptsToSteps(stepRecords, sessions) {
  const receiptsById = new Map([...sessions.entries()].flatMap(([actor, session]) => session.envelopes
    .filter((envelope) => envelope.type === "receipt")
    .map((receipt) => [receipt.commandId, compactReceipt(receipt, { actor })])));
  for (const record of stepRecords) {
    const matched = commandIdsFromStep(record).map((id) => receiptsById.get(id)).filter(Boolean);
    record.receipts = uniqueReceipts([...(record.receipts ?? []), ...matched]);
    if (record.receipts.length === 1) record.receipt = record.receipts[0];
    else delete record.receipt;
  }
}

function commandIdsFromStep(record) {
  const ids = new Set();
  const visit = (value) => {
    if (!value || typeof value !== "object") return;
    if (typeof value.commandId === "string") ids.add(value.commandId);
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry);
      return;
    }
    for (const entry of Object.values(value)) visit(entry);
  };
  visit(record.expandedFrames);
  visit(record.action);
  return [...ids];
}

function allCommandReceipts(stepRecords, sessions) {
  const stepReceipts = stepRecords.flatMap((record) => record.receipts ?? []);
  const driverReceipts = [...sessions.entries()].flatMap(([actor, session]) => session.envelopes
    .filter((envelope) => envelope.type === "receipt")
    .map((receipt) => compactReceipt(receipt, { actor })));
  return uniqueReceipts([...stepReceipts, ...driverReceipts]);
}

export function durationBetweenClockSnapshots(initialClock, finalClock, { advancedTicks = 0, tickRateHz = null } = {}) {
  const accumulatedMs = Number(advancedTicks) > 0 && Number(tickRateHz) > 0
    ? (Number(advancedTicks) * 1_000) / Number(tickRateHz)
    : null;
  if (Number.isFinite(accumulatedMs)) return round(accumulatedMs);
  const durationMs = Number(finalClock?.virtualNowMs) - Number(initialClock?.virtualNowMs);
  return Number.isFinite(durationMs) && durationMs >= 0 ? round(durationMs) : null;
}

function compactClockAdvance(response) {
  return {
    schema: response.schema,
    mode: response.mode,
    tick: response.tick,
    virtualNowMs: response.virtualNowMs,
    advancedTicks: response.advancedTicks,
    advancedMs: response.advancedMs,
    stateHashAvailable: response.stateHashAvailable,
    authorityBridgeRequests: response.authorityBridgeRequests ?? 0,
    authorityBridgeTicks: response.authorityBridgeTicks ?? 0,
    authorityBridgeBatchedRequests: response.authorityBridgeBatchedRequests ?? 0,
    authorityBridgeMaxTicksPerRequest: response.authorityBridgeMaxTicksPerRequest ?? 0,
  };
}

async function waitForStatus(gameUrl, timeoutMs) {
  return waitFor(async () => fetchJson(`${gameUrl}/game/status`).catch(() => null), timeoutMs, (status) => status?.shardId);
}

async function waitFor(producer, timeoutMs, predicate = (value) => Boolean(value)) {
  const deadline = Date.now() + timeoutMs;
  let latest;
  while (Date.now() <= deadline) {
    latest = await producer();
    if (predicate(latest)) return latest;
    await delay(100);
  }
  throw new Error(`timed out waiting; latest=${JSON.stringify(latest)}`);
}

function interpolateDeep(value, context) {
  if (typeof value === "string") return interpolate(value, context);
  if (Array.isArray(value)) return value.map((entry) => interpolateDeep(entry, context));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, interpolateDeep(entry, context)]));
}

function createTransportMetrics() {
  const counters = { total: 0, clockSnapshot: 0, status: 0, clockAdvance: 0, oracle: 0, authorityCommand: 0, other: 0 };
  return {
    requests: { ...counters },
    wallMs: { ...counters },
    authorityBridge: { requests: 0, ticks: 0, batchedRequests: 0, maxTicksPerRequest: 0 },
  };
}

function transportKind(url) {
  const pathname = new URL(url).pathname;
  if (pathname === "/game/debug/clock") return "clockSnapshot";
  if (pathname === "/game/status") return "status";
  if (pathname === "/game/debug/clock/advance") return "clockAdvance";
  if (pathname === "/game/debug/oracle") return "oracle";
  if (pathname === "/game/debug/authority-command") return "authorityCommand";
  return "other";
}

async function recordTransportRequest(runtime, url, operation) {
  const kind = transportKind(url);
  const started = performance.now();
  runtime.transport.requests.total += 1;
  runtime.transport.requests[kind] += 1;
  try {
    return await operation();
  } finally {
    const elapsed = performance.now() - started;
    runtime.transport.wallMs.total += elapsed;
    runtime.transport.wallMs[kind] += elapsed;
  }
}

function runtimeFetchJson(runtime, url, signal = null) {
  return recordTransportRequest(runtime, url, () => fetchJson(url, signal));
}

function runtimePostJson(runtime, url, payload, timeoutMs = 1500, signal = null) {
  return recordTransportRequest(runtime, url, () => postJson(url, payload, timeoutMs, signal));
}

function recordAuthorityBridgeMetrics(transport, response) {
  const requests = Math.max(0, Number(response?.authorityBridgeRequests) || 0);
  const ticks = Math.max(0, Number(response?.authorityBridgeTicks) || 0);
  const batchedRequests = Math.max(0, Number(response?.authorityBridgeBatchedRequests) || 0);
  const maxTicks = Math.max(0, Number(response?.authorityBridgeMaxTicksPerRequest) || 0);
  transport.authorityBridge.requests += requests;
  transport.authorityBridge.ticks += ticks;
  transport.authorityBridge.batchedRequests += batchedRequests;
  transport.authorityBridge.maxTicksPerRequest = Math.max(transport.authorityBridge.maxTicksPerRequest, maxTicks);
}

function snapshotTransportMetrics(metrics) {
  return {
    requests: { ...metrics.requests },
    wallMs: Object.fromEntries(Object.entries(metrics.wallMs).map(([key, value]) => [key, round(value)])),
    authorityBridge: { ...metrics.authorityBridge },
  };
}

export function fetchJson(url, signal = null) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? cancellationError());
      return;
    }
    const request = http.get(url, { timeout: 1500 }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => {
        if (response.statusCode !== 200) {
          reject(new Error(`HTTP ${response.statusCode} ${url}: ${body.slice(0, 300)}`));
          return;
        }
        try {
          resolve(JSON.parse(body));
        } catch (error) {
          reject(error);
        }
      });
    });
    const onAbort = () => request.destroy(signal.reason ?? cancellationError());
    signal?.addEventListener("abort", onAbort, { once: true });
    request.on("close", () => signal?.removeEventListener("abort", onAbort));
    request.on("timeout", () => request.destroy(new Error("timeout")));
    request.on("error", reject);
  });
}

function postJson(url, payload, timeoutMs = 1500, signal = null) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? cancellationError());
      return;
    }
    const body = JSON.stringify(payload);
    const request = http.request(url, {
      method: "POST",
      timeout: Math.max(1, timeoutMs),
      headers: {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(body),
      },
    }, (response) => {
      let responseBody = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { responseBody += chunk; });
      response.on("end", () => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error(`HTTP ${response.statusCode} ${url}: ${responseBody.slice(0, 300)}`));
          return;
        }
        try {
          resolve(JSON.parse(responseBody));
        } catch (error) {
          reject(error);
        }
      });
    });
    const onAbort = () => request.destroy(signal.reason ?? cancellationError());
    signal?.addEventListener("abort", onAbort, { once: true });
    request.on("close", () => signal?.removeEventListener("abort", onAbort));
    request.on("timeout", () => request.destroy(new Error("timeout")));
    request.on("error", reject);
    request.end(body);
  });
}

function portIsFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => server.close(() => resolve(true)));
    server.listen(port, "127.0.0.1");
  });
}


function compactStatus(status) {
  if (!status || typeof status !== "object") return status ?? null;
  return {
    shardId: status.shardId ?? null,
    tick: status.tick ?? null,
    clock: status.clock ? { mode: status.clock.mode } : null,
    sessionCount: status.sessionCount ?? null,
    actorCount: status.actorCount ?? null,
    counters: status.counters ?? null,
    recentRejections: status.recentRejections ?? [],
    source: status.source ? { stateHash: status.source.stateHash, sliceHash: status.source.sliceHash, actorCount: status.source.actorCount } : null,
    authority: status.authority ? { mode: status.authority.mode, rustLive: status.authority.rustLive } : null,
    persistence: status.persistence ?? null,
  };
}

function compactHttpPayload(payload) {
  if (!payload || typeof payload !== "object") return payload ?? null;
  if (payload.schema === "successor.game-shard-oracle.v1") {
    return {
      schema: payload.schema,
      tick: payload.tick,
      actorCount: Object.keys(payload.actors ?? {}).length,
      inventoryRows: Array.isArray(payload.inventory) ? payload.inventory.length : null,
      placedExtractors: Array.isArray(payload.placedExtractors) ? payload.placedExtractors.map((extractor) => ({ ...extractor })) : null,
      counters: payload.counters,
      source: payload.source,
    };
  }
  return compactStatus(payload);
}

function compactSourceIdentity(identity) {
  if (!identity || typeof identity !== "object") return null;
  return {
    schema: identity.schema ?? null,
    sourceHash: identity.sourceHash ?? null,
    fileCount: finiteInteger(identity.fileCount),
    totalBytes: finiteInteger(identity.totalBytes),
    provenance: identity.provenance ?? null,
  };
}

export function failureRecord(error, { step = null, lane = null, sourceIdentity = null } = {}) {
  const name = error?.name ?? "Error";
  const code = typeof error?.code === "string" && error.code.length > 0
    ? error.code
    : name === "ScenarioAssertionError"
      ? "SCENARIO_ASSERTION_FAILED"
      : name.replace(/([a-z])([A-Z])/gu, "$1_$2").toUpperCase();
  return {
    schema: "successor.scenario-failure.v1",
    code,
    message: error instanceof Error ? error.message : String(error),
    step: finiteInteger(step),
    lane,
    sourceIdentity: compactSourceIdentity(sourceIdentity?.before ?? sourceIdentity),
    details: canonicalFailureValue(error?.details),
  };
}

async function sampleProcessResources(runtime) {
  if (typeof runtime?.inspect !== "function") return null;
  try {
    const inspection = await runtime.inspect();
    if (!inspection || typeof inspection !== "object") return null;
    return {
      mainPid: Number.isInteger(inspection.mainPid) ? inspection.mainPid : null,
      memoryCurrentBytes: Number.isFinite(inspection.memoryCurrentBytes) ? inspection.memoryCurrentBytes : null,
      cpuUsageNSec: Number.isFinite(inspection.cpuUsageNSec) ? inspection.cpuUsageNSec : null,
      proc: inspection.proc ? {
        rssBytes: Number.isFinite(inspection.proc.rssBytes) ? inspection.proc.rssBytes : null,
        highWaterRssBytes: Number.isFinite(inspection.proc.highWaterRssBytes) ? inspection.proc.highWaterRssBytes : null,
        threads: Number.isFinite(inspection.proc.threads) ? inspection.proc.threads : null,
        fileDescriptors: Number.isFinite(inspection.proc.fileDescriptors) ? inspection.proc.fileDescriptors : null,
      } : null,
      activeState: inspection.activeState ?? null,
      error: inspection.error ?? null,
    };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

async function writeStepFailureArtifact(root, runDir, record, error) {
  try {
    const failureDir = path.join(runDir, "failures");
    await fs.mkdir(failureDir, { recursive: true });
    const filePath = path.join(failureDir, `step-${String(record.index).padStart(4, "0")}.json`);
    await fs.writeFile(filePath, `${JSON.stringify({
      schema: "successor.scenario-step-failure.v1",
      step: record,
      error: failureRecord(error, { step: record.index }),
    }, null, 2)}
`, "utf8");
    return path.relative(root, filePath);
  } catch {
    return null;
  }
}

function canonicalFailureValue(value) {
  if (value === undefined) return null;
  if (value === null || typeof value !== "object") return value ?? null;
  if (Array.isArray(value)) return value.map(canonicalFailureValue);
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalFailureValue(value[key])]));
}

function finiteInteger(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : null;
}

function cancellationError() {
  return new ScenarioAssertionError("scenario branch cancelled", { cancelled: true });
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw signal.reason ?? cancellationError();
}

function linkAbortSignal(parentSignal, controller) {
  if (!parentSignal) return () => {};
  const abort = () => controller.abort(parentSignal.reason ?? cancellationError());
  if (parentSignal.aborted) abort();
  else parentSignal.addEventListener("abort", abort, { once: true });
  return () => parentSignal.removeEventListener("abort", abort);
}

function delayWithSignal(ms, signal = null) {
  if (!signal) return delay(ms);
  if (signal.aborted) return Promise.reject(signal.reason ?? cancellationError());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, Math.max(0, ms));
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? cancellationError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

function safeName(value) {
  return String(value).replace(/[^A-Za-z0-9_.-]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 80) || "scenario";
}

function round(value) {
  return Number.isFinite(value) ? Math.round(value * 1000) / 1000 : null;
}


function deterministicDriverTickMs() {
  const configured = Number(process.env.SUCCESSOR_PLAY_GATE_DRIVER_TICK_MS ?? 86_400_000);
  return Number.isFinite(configured) && configured > 0 ? configured : 86_400_000;
}
