#!/usr/bin/env node
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");
const DATA_ATTR = "data-sc3d-movement-probe";
const MOVE_TRACE_ATTR = "data-sc3d-move-trace";
const DEFAULT_SAMPLE_MS = 55;
const DEFAULT_SCREENSHOT_MS = 400;
const STALL_MS = 180;
const STALL_DISTANCE_EPSILON_CELLS = 0.01;
const SNAPBACK_DOT_EPSILON_CELLS = 0.015;
// Must match the Rust authority law covered by
// authority_sprint_uses_fractional_action_cost_for_smooth_moves.
const AUTHORITY_TICK_RATE_HZ = 30;
const SPRINT_ACTION_DRAIN_PER_SECOND = 10;
const SPRINT_ACTION_COST_MILLI_PER_TICK = Math.ceil((SPRINT_ACTION_DRAIN_PER_SECOND * 1_000) / AUTHORITY_TICK_RATE_HZ);
const FIRST_MOVE_EPSILON_CELLS = 0.025;
const RELEASE_KEYS = ["w", "a", "s", "d", "Shift"];
const KEYBOARD_KEY = new Map([
  ["KeyW", "w"],
  ["KeyA", "a"],
  ["KeyS", "s"],
  ["KeyD", "d"],
  ["ShiftLeft", "Shift"],
]);
const MOVEMENT_KEYS = new Set(["KeyW", "KeyA", "KeyS", "KeyD"]);

const argv = parseArgs(process.argv.slice(2));
const port = integerArg(argv, "port", 18093, { min: 1024, max: 65535 });
const vitePort = integerArg(argv, "vite-port", 5179, { min: 1024, max: 65535 });
const actor = stringArg(argv, "actor", `movement-lab-${Date.now().toString(36)}`);
const clientKind = enumArg(argv, "client", "client-3d", ["client-3d", "rust-web", "rust-native"]);
const actorName = stringArg(argv, "name", actor);
const sampleMs = integerArg(argv, "sample-ms", DEFAULT_SAMPLE_MS, { min: 16, max: 500 });
const screenshotMs = integerArg(argv, "screenshot-ms", DEFAULT_SCREENSHOT_MS, { min: 100, max: 5_000 });
const outDir = path.resolve(stringArg(argv, "out-dir", "/tmp/movement-lab"));
const runId = stringArg(argv, "run-id", `${stamp()}-${safeName(actor)}-${port}`);
const baseUrl = stringArg(argv, "base-url", `http://127.0.0.1:${vitePort}/`);
const spawnArea = stringArg(argv, "spawn-area", "open-desert-overworld");
const spawnX = stringArg(argv, "spawn-x", "700");
const spawnY = stringArg(argv, "spawn-y", "700");
const strict = boolArg(argv, "strict", false);
const maxRejects = nonNegativeIntegerArg(argv, "max-rejects", strict ? 0 : Number.POSITIVE_INFINITY);
const maxSnapbacks = nonNegativeIntegerArg(argv, "max-snapbacks", strict ? 0 : Number.POSITIVE_INFINITY);
const serverTrace = boolArg(argv, "server-trace", false);
const serverUnit = normalizeSystemdUnit(stringArg(argv, "server-unit", `successor-open-desert-${port}.service`));
const forbiddenPorts = new Set([18092]);
if (forbiddenPorts.has(port)) {
  throw new Error(`Refusing to run movement harness against ${port}; use a dedicated backend such as 18093.`);
}
if (argv.has("headless") && boolArg(argv, "headless", true) !== true) {
  throw new Error("Movement harness must run headless; do not open browser windows on the owner's desktop.");
}
const headless = true;
const sprintActionThreshold = numberArg(argv, "sprint-action-threshold", 10, { min: 0, max: 10_000 });
const maxActionContamination = numberArg(argv, "max-action-contamination", 0.10, { min: 0, max: 1 });
const energyRetries = integerArg(argv, "energy-retries", 2, { min: 0, max: 10 });
const viewport = {
  width: integerArg(argv, "width", 1440, { min: 640, max: 7680 }),
  height: integerArg(argv, "height", 960, { min: 480, max: 4320 }),
};
const plan = movementPlan(energyRetries);
if (boolArg(argv, "plan-json", false)) {
  console.log(JSON.stringify(plan, null, 2));
  process.exit(0);
}
if (clientKind === "rust-native") {
  const forwarded = process.argv.slice(2).filter((arg, index, values) => {
    if (arg === "--client") return false;
    if (index > 0 && values[index - 1] === "--client") return false;
    return !arg.startsWith("--client=");
  });
  const native = spawnSync(
    process.execPath,
    [path.join(__dirname, "run-rust-native.mjs"), ...forwarded],
    { cwd: repoRoot, stdio: "inherit" },
  );
  process.exit(native.status ?? 1);
}


const { chromium, driver } = loadBrowserDriver();
const runDir = path.join(outDir, runId);
const metricPath = path.join(outDir, `metrics-${runId}.json`);
const startWallMs = Date.now();
const startedAt = performance.now();
const pageConsole = [];
const pageErrors = [];
let browser = null;

try {
  fs.mkdirSync(outDir, { recursive: true });
  fs.mkdirSync(runDir, { recursive: true });
  const startStatus = await fetchJson(port, "/game/status").catch((error) => {
    throw new Error(`open-desert backend ${port} is not reachable at /game/status: ${error.message}`);
  });

  browser = await chromium.launch({
    headless,
    ...(fs.existsSync("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")
      ? { executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" }
      : {}),
    args: [
      "--no-sandbox",
      "--disable-background-timer-throttling",
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
      `--window-size=${viewport.width},${viewport.height}`,
    ],
    timeout: 30_000,
  });
  const context = await browser.newContext({ viewport, deviceScaleFactor: 1 });
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);
  page.setDefaultNavigationTimeout(35_000);
  page.on("console", (msg) => {
    const type = msg.type();
    if (type === "error" || type === "warning") {
      pageConsole.push({ type, text: msg.text(), atWallMs: Date.now() });
    }
  });
  page.on("pageerror", (error) => pageErrors.push({ message: error.stack ?? error.message, atWallMs: Date.now() }));

  const runtimeUrl = buildRuntimeUrl({
    baseUrl,
    port,
    actor,
    actorName,
    spawnArea,
    spawnX,
    spawnY,
    clientKind,
  });
  await page.goto(runtimeUrl, { waitUntil: "domcontentloaded" });
  await page.bringToFront();
  await page.waitForSelector("body", { timeout: 10_000 });
  await installBridge(page, sampleMs, clientKind);
  await waitForWorldReady(page, clientKind);
  await focusRuntime(page);
  await releaseAll(page);

  const scenarioReports = [];
  for (const scenario of scenarios()) {
    const report = await runScenarioWithEnergyRetry(page, scenario);
    scenarioReports.push(report);
  }
  await releaseAll(page);
  const endStatus = await fetchJson(port, "/game/status").catch((error) => ({ error: error.message }));
  const serverTraceReport = serverTrace ? collectServerTrace({ runDir, unit: serverUnit, sinceWallMs: startWallMs }) : null;

  const headline = {
    sprintHoldTimeToFirstMoveMs: scenarioReports.find((item) => item.id === "sprint-hold")?.metrics.timeToFirstCellChangeMs ?? null,
    sprintHoldStallCount: scenarioReports.find((item) => item.id === "sprint-hold")?.metrics.stallCount ?? null,
    abruptFlipResponseMs: scenarioReports.find((item) => item.id === "abrupt-180-flip")?.metrics.directionFlipResponseMs ?? null,
  };
  const failures = scenarioReports.flatMap((scenario) => scenario.failures.map((failure) => `${scenario.id}: ${failure}`));
  if (pageErrors.length > 0) failures.push(`${pageErrors.length} page error(s)`);
  if (serverTraceReport?.error) failures.push(`server trace collect error: ${serverTraceReport.error}`);
  if (serverTrace && serverTraceReport && !serverTraceReport.error && serverTraceReport.lineCount <= 0) {
    failures.push(`server trace enabled but no successor.move-trace.v1 lines collected from ${serverUnit}`);
  }

  const result = {
    schema: "successor.movement-lab.metrics.v1",
    runId,
    generatedAt: new Date().toISOString(),
    status: failures.length === 0 ? "pass" : "fail",
    driver,
    config: {
      port,
      vitePort,
      actor,
      actorName,
      runtimeUrl,
      clientKind,
      headless,
      sampleMs,
      screenshotMs,
      outDir,
      runDir,
      spawnArea,
      spawnX,
      spawnY,
      strict,
      maxRejects: Number.isFinite(maxRejects) ? maxRejects : null,
      maxSnapbacks: Number.isFinite(maxSnapbacks) ? maxSnapbacks : null,
      sprintActionThreshold,
      maxActionContamination,
      energyRetries,
      serverTrace: serverTrace ? { unit: serverUnit, path: serverTraceReport?.path ?? path.join(runDir, "server-trace.jsonl") } : null,
      thresholds: {
        stallMs: STALL_MS,
        stallDistanceEpsilonCells: STALL_DISTANCE_EPSILON_CELLS,
        firstMoveEpsilonCells: FIRST_MOVE_EPSILON_CELLS,
        snapbackDotEpsilonCells: SNAPBACK_DOT_EPSILON_CELLS,
      },
    },
    headline,
    failures,
    server: {
      start: compactStatus(startStatus),
      end: compactStatus(endStatus),
    },
    browser: {
      consoleWarningsAndErrors: pageConsole.slice(0, 80),
      pageErrors,
    },
    serverTrace: serverTraceReport,
    scenarios: scenarioReports,
    plan,
    durationMs: round(performance.now() - startedAt),
    wallStartedAtMs: startWallMs,
  };
  fs.writeFileSync(metricPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  printSummary(result);
  console.log(`metrics: ${metricPath}`);
  if (result.status !== "pass") process.exitCode = 1;
} catch (error) {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
} finally {
  if (browser) await browser.close().catch(() => {});
}

function movementPlan(retries) {
  const plannedScenarios = scenarios().map(({ id, label, plannedDurationMs }) => ({ id, label, plannedDurationMs }));
  const plannedDurationMs = plannedScenarios.reduce((total, scenario) => total + scenario.plannedDurationMs, 0);
  const maxAttempts = retries + 1;
  const fixedMarginMs = 180_000;
  return {
    schema: "successor.movement-lab.plan.v1",
    scenarioCount: plannedScenarios.length,
    plannedDurationMs,
    energyRetries: retries,
    maxAttempts,
    maxScenarioActionMs: plannedDurationMs * maxAttempts,
    fixedMarginMs,
    recommendedTimeoutMs: (plannedDurationMs * maxAttempts) + fixedMarginMs,
    scenarios: plannedScenarios,
  };
}

function scenarios() {
  return [
    {
      id: "sprint-hold",
      label: "sprint-hold one direction 8s",
      plannedDurationMs: 8_000,
      async action(ctx) {
        await ctx.down("ShiftLeft", "sprint");
        await ctx.down("KeyW", "move-start");
        await ctx.wait(8_000);
        await ctx.up("KeyW", "move-end");
        await ctx.up("ShiftLeft", "sprint-end");
      },
    },
    {
      id: "abrupt-180-flip",
      label: "hold 4s then 180 flip 4s",
      plannedDurationMs: 8_000,
      async action(ctx) {
        await ctx.down("ShiftLeft", "sprint");
        await ctx.down("KeyW", "move-start");
        await ctx.wait(4_000);
        ctx.mark("flip", { fromKeys: ["KeyW"], toKeys: ["KeyS"] });
        await ctx.down("KeyS", "flip-down");
        await ctx.up("KeyW", "flip-up");
        await ctx.wait(4_000);
        await ctx.up("KeyS", "move-end");
        await ctx.up("ShiftLeft", "sprint-end");
      },
    },
    {
      id: "stop-start",
      label: "10x hold 1s, release 0.5s",
      plannedDurationMs: 15_000,
      async action(ctx) {
        for (let i = 0; i < 10; i += 1) {
          ctx.mark("stop-start-cycle", { cycle: i + 1, phase: "hold" });
          await ctx.down("ShiftLeft", `cycle-${i + 1}-sprint`);
          await ctx.down("KeyW", `cycle-${i + 1}-move`);
          await ctx.wait(1_000);
          await ctx.up("KeyW", `cycle-${i + 1}-release-move`);
          await ctx.up("ShiftLeft", `cycle-${i + 1}-release-sprint`);
          ctx.mark("stop-start-cycle", { cycle: i + 1, phase: "release" });
          await ctx.wait(500);
        }
      },
    },
    {
      id: "zigzag-90",
      label: "WASD 90 degree changes every 800ms",
      plannedDurationMs: 8_000,
      async action(ctx) {
        await ctx.down("ShiftLeft", "sprint");
        const order = ["KeyW", "KeyD", "KeyS", "KeyA", "KeyW", "KeyD", "KeyS", "KeyA", "KeyW", "KeyD"];
        let current = null;
        for (const key of order) {
          if (current) {
            ctx.mark("turn", { fromKeys: [current], toKeys: [key] });
            await ctx.up(current, "turn-up");
          } else {
            ctx.mark("turn", { fromKeys: [], toKeys: [key] });
          }
          await ctx.down(key, "turn-down");
          current = key;
          await ctx.wait(800);
        }
        if (current) await ctx.up(current, "move-end");
        await ctx.up("ShiftLeft", "sprint-end");
      },
    },
    {
      id: "diagonal-shifts",
      label: "W+D <-> W+A every 1s",
      plannedDurationMs: 8_000,
      async action(ctx) {
        await ctx.down("ShiftLeft", "sprint");
        await ctx.down("KeyW", "forward");
        await ctx.down("KeyD", "lateral-start");
        let lateral = "KeyD";
        for (let i = 0; i < 8; i += 1) {
          await ctx.wait(1_000);
          const next = lateral === "KeyD" ? "KeyA" : "KeyD";
          ctx.mark("diagonal-shift", { fromKeys: ["KeyW", lateral], toKeys: ["KeyW", next] });
          await ctx.down(next, "lateral-down");
          await ctx.up(lateral, "lateral-up");
          lateral = next;
        }
        await ctx.up(lateral, "lateral-end");
        await ctx.up("KeyW", "forward-end");
        await ctx.up("ShiftLeft", "sprint-end");
      },
    },
    {
      id: "sprint-marathon",
      label: "exhaust sprint, recover under lock, then auto-resume",
      plannedDurationMs: 55_000,
      async action(ctx) {
        // Start holding sprint + forward
        await ctx.down("ShiftLeft", "sprint-hold");
        await ctx.down("KeyW", "marathon-start");

        // Phase 1: Wait for exhaustion (sprintRecoveryLocked = true)
        let marathonKey = "KeyW";
        const marathonDirections = ["KeyW", "KeyD", "KeyS", "KeyA"];
        let marathonDirectionIndex = 0;
        let exhausted = false;
        for (let i = 0; i < 160; i++) {
          const vitals = await ctx.getActionVitals();
          if (vitals.mobility?.sprintRecoveryLocked === true) {
            exhausted = true;
            ctx.mark("exhaustion-achieved", { action: vitals.action });
            break;
          }
          await ctx.wait(250);
          if (i > 0 && i % 8 === 0) {
            marathonDirectionIndex = (marathonDirectionIndex + 1) % marathonDirections.length;
            const next = marathonDirections[marathonDirectionIndex];
            await ctx.down(next, "marathon-clearance-turn-down");
            await ctx.up(marathonKey, "marathon-clearance-turn-up");
            marathonKey = next;
          }
        }
        if (!exhausted) {
          throw new Error("Sprint exhaustion never triggered sprintRecoveryLocked");
        }

        // Phase 2: Partial-Recovery Lock validation
        // Wait until action recovers partially (e.g., to 30) and confirm sprintRecoveryLocked remains true
        let partialRecoveryConfirmed = false;
        for (let i = 0; i < 60; i++) {
          const vitals = await ctx.getActionVitals();
          if (vitals.action > 10 && vitals.action < 90) {
            if (vitals.mobility?.sprintRecoveryLocked === true) {
              partialRecoveryConfirmed = true;
              ctx.mark("partial-recovery-locked", { action: vitals.action });
              break;
            }
          }
          await ctx.wait(100);
        }
        if (!partialRecoveryConfirmed) {
          throw new Error("sprintRecoveryLocked cleared prematurely during partial action recovery");
        }

        // Phase 3 & 4: remain locked through partial recovery, then unlock only at full Action.
        // The exact 800/1000 recovery multiplier is asserted by the deterministic Rust authority test.
        let unlocked = false;
        const startRecovery = Date.now();
        for (let i = 0; i < 300; i++) {
          const vitals = await ctx.getActionVitals();
          if (!vitals.mobility?.sprintRecoveryLocked) {
            unlocked = true;
            const recoveryDurationMs = Date.now() - startRecovery;
            ctx.mark("full-unlock-achieved", { action: vitals.action, durationMs: recoveryDurationMs });
            break;
          }
          await ctx.wait(100);
        }
        if (!unlocked) {
          throw new Error("sprintRecoveryLocked did not clear after full action recovery");
        }

        // Phase 5: held sprint intent resumes immediately after the full-action unlock.
        // Sampling can observe the first fractional sprint spend in the same authority tick,
        // so allow the integer Action projection to be one point below max.
        const unlockVitals = await ctx.getActionVitals();
        if (unlockVitals.action < unlockVitals.maxAction - 1 || unlockVitals.mobility?.sprintRecoveryLocked) {
          throw new Error("sprint recovery lock cleared before full action");
        }
        await ctx.wait(1000);
        const postVitals = await ctx.getActionVitals();
        const unlockSprintTick = unlockVitals.mobility?.lastSprintTick ?? -1;
        const postSprintTick = postVitals.mobility?.lastSprintTick ?? -1;
        if (postVitals.mobility?.sprintRecoveryLocked || postVitals.action >= unlockVitals.action || postSprintTick <= unlockSprintTick) {
          throw new Error("held sprint intent did not resume after full recovery");
        }
        ctx.mark("sprint-resumed", { action: postVitals.action, lastSprintTick: postSprintTick });

        // Clean up
        await ctx.up(marathonKey, "marathon-end");
        await ctx.up("ShiftLeft", "sprint-end");
      },
    },

  ];
}

async function runScenarioWithEnergyRetry(page, scenario) {
  let lastReport = null;
  for (let attempt = 0; attempt <= energyRetries; attempt += 1) {
    await waitForActionFull(actor, { reason: `${scenario.id} attempt ${attempt + 1}` });
    const report = await runScenario(page, scenario, attempt + 1);
    lastReport = report;
    const actionBudgetFraction = report.metrics.actionContamination?.budget?.fraction
      ?? report.metrics.actionContamination?.fraction
      ?? 0;
    if (actionBudgetFraction <= maxActionContamination) return report;
    if (attempt < energyRetries) {
      await delay(2_000 * (attempt + 1));
    }
  }
  if (lastReport) {
    const failure = actionContaminationFailure(lastReport.metrics.actionContamination);
    lastReport.status = "fail";
    lastReport.failures.push(`${failure ?? "action contamination exceeded budget"} after ${energyRetries + 1} attempt(s)`);
  }
  return lastReport;
}

async function runScenario(page, scenario, attempt = 1) {
  const scenarioDir = path.join(outDir, scenario.id);
  fs.rmSync(scenarioDir, { recursive: true, force: true });
  fs.mkdirSync(scenarioDir, { recursive: true });
  await prepareScenarioPage(page);
  const consoleStartIndex = pageConsole.length;

  const keyEvents = [];
  const marks = [];
  const samples = [];
  const screenshotPaths = [];
  const clientMoveTrace = [];
  const actionSamples = [];
  let latestActionVitals = null;
  let latestProbe = null;
  let actionSampleError = null;
  let done = false;
  let screenshotError = null;
  let screencast = null;
  let sampleError = null;
  let scenarioRunError = null;
  let moveTraceError = null;
  const scenarioStartWallMs = Date.now();
  const held = new Set();
  const heldOrder = [];
  try {
    latestActionVitals = await fetchActorActionVitals(actor);
    actionSamples.push({
      ...latestActionVitals,
      wallTimeMs: Date.now(),
      atScenarioMs: Date.now() - scenarioStartWallMs,
    });
  } catch (error) {
    actionSampleError ??= error instanceof Error ? error.message : String(error);
  }

  const ctx = {
    async down(code, phase = "") {
      const keyboardKey = keyboardKeyForCode(code);
      await page.keyboard.down(keyboardKey);
      if (!held.has(code)) heldOrder.push(code);
      held.add(code);
      keyEvents.push(keyEvent("keydown", code, phase, scenarioStartWallMs));
    },
    async up(code, phase = "") {
      const keyboardKey = keyboardKeyForCode(code);
      await page.keyboard.up(keyboardKey);
      held.delete(code);
      removeFromArray(heldOrder, code);
      keyEvents.push(keyEvent("keyup", code, phase, scenarioStartWallMs));
    },
    wait(ms) {
      return delay(ms);
    },
    mark(kind, detail = {}) {
      marks.push({
        kind,
        detail,
        atWallMs: Date.now(),
        atScenarioMs: Date.now() - scenarioStartWallMs,
        toIntent: Array.isArray(detail.toKeys) ? intentFromKeys(detail.toKeys) : null,
      });
    },
    async getActionVitals() {
      return await fetchActorActionVitals(actor);
    },
  };

  try {
    latestProbe = await readBridgeProbe(page);
  } catch (error) {
    if (!isRetryablePageContextError(error)) sampleError = error instanceof Error ? error.message : String(error);
  }

  const probePoller = (async () => {
    while (!done) {
      try {
        latestProbe = await readBridgeProbe(page);
      } catch (error) {
        if (!isRetryablePageContextError(error)) sampleError = error instanceof Error ? error.message : String(error);
      }
      await delay(10);
    }
  })();

  const sampler = (async () => {
    while (!done) {
      const sampleStart = performance.now();
      const probe = latestProbe;
      if (probe) {
        const wallTimeMs = Date.now();
        samples.push({
          ...probe,
          seq: probe.seq ?? null,
          bridgeSeq: probe.seq ?? null,
          bridgeWallTimeMs: probe.wallTimeMs ?? null,
          bridgeAgeMs: typeof probe.wallTimeMs === "number" ? wallTimeMs - probe.wallTimeMs : null,
          wallTimeMs,
          actionVitals: latestActionVitals,
          atScenarioMs: wallTimeMs - scenarioStartWallMs,
        });
      }
      const elapsed = performance.now() - sampleStart;
      await delay(Math.max(5, sampleMs - elapsed));
    }
  })();

  const actionSampler = (async () => {
    while (!done) {
      try {
        latestActionVitals = await fetchActorActionVitals(actor);
        actionSamples.push({
          ...latestActionVitals,
          wallTimeMs: Date.now(),
          atScenarioMs: Date.now() - scenarioStartWallMs,
        });
      } catch (error) {
        actionSampleError ??= error instanceof Error ? error.message : String(error);
      }
      await delay(250);
    }
  })();

  try {
    screencast = await startScenarioScreencast(page, scenarioDir, scenarioStartWallMs, screenshotPaths);
  } catch (error) {
    screenshotError = error instanceof Error ? error.message : String(error);
  }

  const traceCollector = clientKind === "client-3d"
    ? (async () => {
        while (!done) {
          await delay(1_000);
          try {
            clientMoveTrace.push(...await drainMoveTrace(page));
          } catch (error) {
            moveTraceError ??= error instanceof Error ? error.message : String(error);
          }
        }
      })()
    : Promise.resolve();

  try {
    await delay(Math.max(90, sampleMs * 2));
    await scenario.action(ctx);
    await releaseAll(page);
    await delay(300);
  } catch (error) {
    scenarioRunError = error instanceof Error ? error.message : String(error);
  } finally {
    done = true;
    if (screencast) {
      try {
        await screencast.stop();
      } catch (error) {
        screenshotError ??= error instanceof Error ? error.message : String(error);
      }
    }
    await Promise.allSettled([probePoller, sampler, traceCollector, actionSampler]);
    await releaseAll(page);
    if (clientKind === "client-3d") {
      try {
        clientMoveTrace.push(...await drainMoveTrace(page));
      } catch (error) {
        moveTraceError ??= error instanceof Error ? error.message : String(error);
      }
    }
    if (latestActionVitals !== null) {
      actionSamples.push({
        ...latestActionVitals,
        wallTimeMs: Date.now(),
        atScenarioMs: Date.now() - scenarioStartWallMs,
      });
    }
  }

  const annotatedSamples = annotateSamples(samples, keyEvents);
  const actionContamination = deriveActionContamination(annotatedSamples);
  const metrics = deriveScenarioMetrics(annotatedSamples, keyEvents, marks, clientMoveTrace);
  metrics.actionContamination = actionContamination;
  const scenarioConsole = pageConsole.slice(consoleStartIndex);
  const anomalyConsoleLines = scenarioConsole.filter((entry) => entry.text.includes("[moverec-anomaly]"));
  const capturedDurationMs =
    (annotatedSamples.at(-1)?.wallTimeMs ?? Date.now())
    - (annotatedSamples[0]?.wallTimeMs ?? scenarioStartWallMs);
  const failures = [];
  const actionFailure = actionContaminationFailure(actionContamination);
  if (actionFailure) failures.push(actionFailure);
  const expectedMinSamples = Math.floor((capturedDurationMs / sampleMs) * 0.55);
  if (annotatedSamples.length < expectedMinSamples) failures.push(`too few samples ${annotatedSamples.length} < ${expectedMinSamples}`);
  if (screenshotPaths.length < Math.max(1, Math.floor(capturedDurationMs / screenshotMs) - 2)) {
    failures.push(`too few screenshots ${screenshotPaths.length}`);
  }
  if (metrics.timeToFirstCellChangeMs === null) failures.push("no first movement cell change detected");
  if (metrics.cumulativeDistanceCells < 0.1) failures.push(`movement distance too low ${metrics.cumulativeDistanceCells}`);
  if (sampleError) failures.push(`sample loop error: ${sampleError}`);
  if (screenshotError) failures.push(`screenshot loop error: ${screenshotError}`);
  if (moveTraceError) failures.push(`move trace drain error: ${moveTraceError}`);
  if (actionSampleError) failures.push(`action sample error: ${actionSampleError}`);
  if (scenarioRunError) failures.push(`scenario action failed: ${scenarioRunError}`);
  if (strict && anomalyConsoleLines.length > 0) failures.push(`${anomalyConsoleLines.length} moverec anomaly console line(s)`);
  if (metrics.rejectedDelta > maxRejects) failures.push(`rejectedDelta ${metrics.rejectedDelta} > maxRejects ${maxRejects}`);
  if (metrics.snapbackCount > maxSnapbacks) failures.push(`snapbacks ${metrics.snapbackCount} > maxSnapbacks ${maxSnapbacks}`);

  return {
    id: scenario.id,
    label: scenario.label,
    status: failures.length === 0 ? "pass" : "fail",
    attempt,
    plannedDurationMs: scenario.plannedDurationMs,
    capturedDurationMs: round(capturedDurationMs),
    screenshotDir: scenarioDir,
    screenshotCount: screenshotPaths.length,
    screenshots: screenshotPaths,
    sampleCount: annotatedSamples.length,
    actionSampleCount: actionSamples.length,
    actionSamples,
    keyEvents,
    marks,
    console: {
      warningErrorCount: scenarioConsole.length,
      moverecAnomalyCount: anomalyConsoleLines.length,
      moverecAnomalies: anomalyConsoleLines.slice(0, 12),
    },
    clientMoveTrace,
    metrics,
    failures,
    samples: annotatedSamples,
  };
}

function keyEvent(type, code, phase, scenarioStartWallMs) {
  const atWallMs = Date.now();
  return {
    type,
    code,
    key: keyboardKeyForCode(code),
    phase,
    atWallMs,
    atScenarioMs: atWallMs - scenarioStartWallMs,
  };
}

function deriveScenarioMetrics(samples, keyEvents, marks, moveTraceEvents = []) {
  const valid = samples
    .filter((sample) => sample?.playerCell && Number.isFinite(sample.playerCell.x) && Number.isFinite(sample.playerCell.y))
    .sort((a, b) => a.wallTimeMs - b.wallTimeMs);
  const deltas = [];
  const frameMs = [];
  const predictionErrors = [];
  const snapbacks = [];
  let cumulativeDistance = 0;
  let stallActive = null;
  const stallEvents = [];

  for (let i = 0; i < valid.length; i += 1) {
    const sample = valid[i];
    if (typeof sample.predictionErrorCells === "number") predictionErrors.push(sample.predictionErrorCells);
    if (i === 0) continue;
    const prev = valid[i - 1];
    const dt = Math.max(0, sample.wallTimeMs - prev.wallTimeMs);
    const dx = sample.playerCell.x - prev.playerCell.x;
    const dy = sample.playerCell.y - prev.playerCell.y;
    const dist = Math.hypot(dx, dy);
    const prevIntent = prev.intent ?? { x: 0, y: 0, magnitude: 0 };
    cumulativeDistance += dist;
    deltas.push(dist);
    frameMs.push(dt);

    if (prevIntent.magnitude > 0 && dist <= STALL_DISTANCE_EPSILON_CELLS) {
      if (!stallActive) {
        stallActive = {
          startWallMs: prev.wallTimeMs,
          startScenarioMs: prev.atScenarioMs,
          durationMs: 0,
          keys: prev.keysHeld ?? [],
        };
      }
      stallActive.durationMs += dt;
    } else if (stallActive) {
      if (stallActive.durationMs >= STALL_MS) stallEvents.push({ ...stallActive, durationMs: round(stallActive.durationMs) });
      stallActive = null;
    }

    if (prevIntent.magnitude > 0 && dist > STALL_DISTANCE_EPSILON_CELLS) {
      const dot = dx * prevIntent.x + dy * prevIntent.y;
      if (dot < -SNAPBACK_DOT_EPSILON_CELLS) {
        snapbacks.push({
          atWallMs: sample.wallTimeMs,
          atScenarioMs: sample.atScenarioMs,
          dx: round(dx),
          dy: round(dy),
          dot: round(dot),
          keys: prev.keysHeld ?? [],
        });
      }
    }
  }
  if (stallActive && stallActive.durationMs >= STALL_MS) stallEvents.push({ ...stallActive, durationMs: round(stallActive.durationMs) });

  const movementKeyDowns = keyEvents.filter((event) => event.type === "keydown" && MOVEMENT_KEYS.has(event.code));
  const firstMoveLatencies = movementKeyDowns.map((event) => firstCellChangeAfter(valid, event)).filter((value) => value !== null);
  const firstMove = firstMoveLatencies[0] ?? null;
  const flipResponses = marks
    .filter((mark) => mark.kind === "flip" && mark.toIntent)
    .map((mark) => responseInDirection(valid, mark.atWallMs, mark.toIntent))
    .filter((value) => value !== null);
  const turnResponses = marks
    .filter((mark) => (mark.kind === "turn" || mark.kind === "diagonal-shift") && mark.toIntent)
    .map((mark) => responseInDirection(valid, mark.atWallMs, mark.toIntent))
    .filter((value) => value !== null);
  const first = valid[0] ?? null;
  const last = valid.at(-1) ?? null;
  const acceptedDelta = Math.max(0, (last?.acceptedCommands ?? 0) - (first?.acceptedCommands ?? 0));
  const rejectedDelta = Math.max(0, (last?.rejectedCommands ?? 0) - (first?.rejectedCommands ?? 0));
  const microStutter = deriveMicroStutters(valid, keyEvents, moveTraceEvents);
  const endToEnd = deriveEndToEndTiming(valid, movementKeyDowns);

  return {
    timeToFirstCellChangeMs: firstMove,
    timeToFirstCellChangeByKeydownMs: firstMoveLatencies,
    directionFlipResponseMs: flipResponses[0] ?? null,
    turnResponseMs: summarize(turnResponses),
    stallCount: stallEvents.length,
    stallTotalMs: round(stallEvents.reduce((sum, event) => sum + event.durationMs, 0)),
    stallMaxMs: round(Math.max(0, ...stallEvents.map((event) => event.durationMs))),
    stallEvents,
    snapbackCount: snapbacks.length,
    snapbackEvents: snapbacks.slice(0, 40),
    acceptedDelta,
    rejectedDelta,
    rejectLogTail: last?.rejectLog ?? [],
    cumulativeDistanceCells: round(cumulativeDistance),
    netDistanceCells: round(first && last ? distance(first.playerCell, last.playerCell) : 0),
    deltaP50Cells: round(percentile(deltas, 0.5)),
    deltaP95Cells: round(percentile(deltas, 0.95)),
    frameP50Ms: round(percentile(frameMs, 0.5)),
    frameP95Ms: round(percentile(frameMs, 0.95)),
    predictionErrorMaxCells: round(Math.max(0, ...predictionErrors)),
    predictionErrorP95Cells: round(percentile(predictionErrors, 0.95)),
    endToEnd,
    microStutter,
    startCell: first?.playerCell ?? null,
    endCell: last?.playerCell ?? null,
  };
}

function deriveEndToEndTiming(samples, movementKeyDowns) {
  const events = [];
  for (const keydown of movementKeyDowns) {
    const baseline = [...samples]
      .reverse()
      .find((sample) => sample.wallTimeMs <= keydown.atWallMs);
    const baselineApplied = baseline?.moveGate?.appliedCommandId ?? 0;
    const sent = samples.find((sample) =>
      sample.wallTimeMs >= keydown.atWallMs
      && Number.isFinite(sample.moveGate?.lastSendAtWallMs)
      && sample.moveGate.lastSendAtWallMs >= keydown.atWallMs);
    const applied = samples.find((sample) =>
      sample.wallTimeMs >= keydown.atWallMs
      && Number.isFinite(sample.moveGate?.appliedCommandId)
      && sample.moveGate.appliedCommandId > baselineApplied);
    const renderedMs = firstCellChangeAfter(samples, keydown);
    events.push({
      inputAtWallMs: keydown.atWallMs,
      clientSentAtWallMs: sent?.moveGate?.lastSendAtWallMs ?? null,
      authorityAppliedCommandId: applied?.moveGate?.appliedCommandId ?? null,
      authorityObservedAtWallMs: applied?.moveGate?.appliedObservedAtWallMs ?? null,
      inputToSendMs: sent ? round(sent.moveGate.lastSendAtWallMs - keydown.atWallMs) : null,
      sendToAppliedObservedMs: sent && applied
        ? round(applied.moveGate.appliedObservedAtWallMs - sent.moveGate.lastSendAtWallMs)
        : null,
      inputToRenderedMs: renderedMs,
    });
  }
  return {
    events,
    inputToSendMs: summarize(events.map((event) => event.inputToSendMs).filter(Number.isFinite)),
    sendToAppliedObservedMs: summarize(
      events.map((event) => event.sendToAppliedObservedMs).filter(Number.isFinite),
    ),
    inputToRenderedMs: summarize(events.map((event) => event.inputToRenderedMs).filter(Number.isFinite)),
  };
}

function deriveMicroStutters(samples, keyEvents, moveTraceEvents) {
  const renderEvents = moveTraceEvents
    .filter((event) => event.kind === "render-position-moved" && Number.isFinite(event.wallTimeMs))
    .sort((a, b) => a.wallTimeMs - b.wallTimeMs);
  const stutters = [];
  const rollingMagnitudes = [];
  let lowRun = 0;
  let lowRunStart = null;
  let lowRunActive = false;
  let worstGapMs = 0;

  for (let i = 1; i < renderEvents.length; i += 1) {
    const previous = renderEvents[i - 1];
    const event = renderEvents[i];
    const held = movementHeldAt(keyEvents, previous.wallTimeMs) || movementHeldAt(keyEvents, event.wallTimeMs);
    const gapMs = event.wallTimeMs - previous.wallTimeMs;
    if (held && gapMs >= 120) {
      worstGapMs = Math.max(worstGapMs, gapMs);
      stutters.push(stutterEvent("render-gap", event, samples, moveTraceEvents, {
        gapMs: round(gapMs),
        magnitudeCells: renderMagnitude(event),
        rollingMedianCells: rollingMagnitudes.length > 0 ? round(percentile(rollingMagnitudes, 0.5)) : null,
      }));
    }

    const magnitude = renderMagnitude(event);
    const rollingMedian = rollingMagnitudes.length >= 8 ? percentile(rollingMagnitudes, 0.5) : null;
    if (held && rollingMedian !== null && rollingMedian > 0 && magnitude < rollingMedian * 0.4) {
      lowRun += 1;
      lowRunStart ??= event;
      if (lowRun >= 2 && !lowRunActive) {
        lowRunActive = true;
        stutters.push(stutterEvent("low-magnitude-run", event, samples, moveTraceEvents, {
          consecutiveSamples: lowRun,
          runStartWallMs: lowRunStart.wallTimeMs,
          gapMs: round(gapMs),
          magnitudeCells: round(magnitude),
          rollingMedianCells: round(rollingMedian),
        }));
      }
    } else {
      lowRun = 0;
      lowRunStart = null;
      lowRunActive = false;
    }

    if (held && magnitude > 0) {
      rollingMagnitudes.push(magnitude);
      if (rollingMagnitudes.length > 30) rollingMagnitudes.shift();
    }
  }

  const timestampsMs = stutters.map((event) => event.atScenarioMs).filter((value) => Number.isFinite(value));
  const interStutterIntervalsMs = [];
  for (let i = 1; i < timestampsMs.length; i += 1) {
    interStutterIntervalsMs.push(round(timestampsMs[i] - timestampsMs[i - 1]));
  }
  return {
    count: stutters.length,
    worstGapMs: round(worstGapMs),
    timestampsMs,
    interStutterIntervalsMs,
    events: stutters,
  };
}

function stutterEvent(kind, event, samples, moveTraceEvents, detail) {
  const sample = nearestSample(samples, event.wallTimeMs);
  return {
    kind,
    wallTimeMs: event.wallTimeMs,
    atScenarioMs: sample?.atScenarioMs ?? null,
    playerCell: sample?.playerCell ?? { x: event.toX ?? null, y: event.toY ?? null },
    predictionErrorCells: sample?.predictionErrorCells ?? event.predictionErrorCells ?? null,
    detail,
    nearbyMoveTrace: nearbyMoveTraceEvents(moveTraceEvents, event.wallTimeMs),
  };
}

function renderMagnitude(event) {
  if (Number.isFinite(event.deltaX) || Number.isFinite(event.deltaY)) {
    return Math.hypot(Number(event.deltaX) || 0, Number(event.deltaY) || 0);
  }
  return Math.hypot((Number(event.toX) || 0) - (Number(event.fromX) || 0), (Number(event.toY) || 0) - (Number(event.fromY) || 0));
}

function movementHeldAt(keyEvents, wallTimeMs) {
  const held = new Set();
  for (const event of keyEvents) {
    if (event.atWallMs > wallTimeMs) break;
    if (event.type === "keydown") held.add(event.code);
    else held.delete(event.code);
  }
  for (const key of held) {
    if (MOVEMENT_KEYS.has(key)) return true;
  }
  return false;
}

function nearestSample(samples, wallTimeMs) {
  let best = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const sample of samples) {
    const delta = Math.abs(sample.wallTimeMs - wallTimeMs);
    if (delta < bestDistance) {
      best = sample;
      bestDistance = delta;
    }
  }
  return best;
}

function nearbyMoveTraceEvents(moveTraceEvents, wallTimeMs) {
  return moveTraceEvents
    .filter((event) => event.kind === "command-acked" || event.kind === "command-enqueued")
    .map((event) => ({ event, dtMs: event.wallTimeMs - wallTimeMs }))
    .filter((entry) => Math.abs(entry.dtMs) <= 250)
    .sort((a, b) => Math.abs(a.dtMs) - Math.abs(b.dtMs))
    .slice(0, 12)
    .map(({ event, dtMs }) => ({
      kind: event.kind,
      dtMs: round(dtMs),
      commandId: event.commandId ?? null,
      accepted: event.accepted ?? null,
      reasonCode: event.reasonCode ?? null,
      latencyMs: event.latencyMs ?? null,
      dx: event.dx ?? null,
      dy: event.dy ?? null,
      sprint: event.sprint ?? null,
      predictionErrorCells: event.predictionErrorCells ?? null,
    }));
}

function firstCellChangeAfter(samples, event) {
  if (samples.length === 0) return null;
  const baselineIndex = Math.max(0, findLastIndex(samples, (sample) => sample.wallTimeMs <= event.atWallMs));
  const baseline = samples[baselineIndex];
  if (!baseline?.playerCell) return null;
  for (let i = baselineIndex + 1; i < samples.length; i += 1) {
    const sample = samples[i];
    if (sample.wallTimeMs < event.atWallMs) continue;
    if (distance(baseline.playerCell, sample.playerCell) >= FIRST_MOVE_EPSILON_CELLS) {
      return round(sample.wallTimeMs - event.atWallMs);
    }
  }
  return null;
}

function responseInDirection(samples, eventWallMs, intent) {
  if (!intent || intent.magnitude <= 0) return null;
  let start = samples.findIndex((sample) => sample.wallTimeMs >= eventWallMs);
  if (start < 1) start = Math.max(1, start);
  for (let i = start; i < samples.length; i += 1) {
    const prev = samples[i - 1];
    const sample = samples[i];
    const dx = sample.playerCell.x - prev.playerCell.x;
    const dy = sample.playerCell.y - prev.playerCell.y;
    const dot = dx * intent.x + dy * intent.y;
    if (Math.hypot(dx, dy) > STALL_DISTANCE_EPSILON_CELLS && dot > SNAPBACK_DOT_EPSILON_CELLS) {
      return round(sample.wallTimeMs - eventWallMs);
    }
  }
  return null;
}

function annotateSamples(samples, keyEvents) {
  const events = [...keyEvents].sort((a, b) => a.atWallMs - b.atWallMs);
  const sorted = [...samples].sort((a, b) => a.wallTimeMs - b.wallTimeMs);
  const held = new Set();
  const order = [];
  let eventIndex = 0;
  return sorted.map((sample) => {
    while (eventIndex < events.length && events[eventIndex].atWallMs <= sample.wallTimeMs) {
      const event = events[eventIndex];
      if (event.type === "keydown") {
        if (!held.has(event.code)) order.push(event.code);
        held.add(event.code);
      } else {
        held.delete(event.code);
        removeFromArray(order, event.code);
      }
      eventIndex += 1;
    }
    const keysHeld = order.filter((code) => held.has(code));
    return {
      ...sample,
      keysHeld,
      intent: intentFromKeys(keysHeld),
    };
  });
}

function intentFromKeys(keys) {
  let sx = 0;
  let sy = 0;
  for (const code of keys) {
    switch (code) {
      case "KeyW": sy = -1; break;
      case "KeyS": sy = 1; break;
      case "KeyA": sx = -1; break;
      case "KeyD": sx = 1; break;
      default: break;
    }
  }
  const ox = sx + sy;
  const oy = -sx + sy;
  const mag = Math.hypot(ox, oy);
  if (mag <= 0) return { x: 0, y: 0, magnitude: 0 };
  return { x: ox / mag, y: oy / mag, magnitude: 1 };
}

async function prepareScenarioPage(page) {
  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await page.waitForSelector("body", { timeout: 10_000 });
      await page.bringToFront();
      await releaseAll(page);
      await focusRuntime(page);
      await installBridge(page, sampleMs, clientKind);
      await waitForWorldReady(page, clientKind);
      if (clientKind === "client-3d") await clearMoveTrace(page);
      return;
    } catch (error) {
      if (!isRetryablePageContextError(error) || attempt === maxAttempts) throw error;
      await page.waitForLoadState("domcontentloaded", { timeout: 10_000 }).catch(() => {});
      await delay(750 * attempt);
    }
  }
}

function isRetryablePageContextError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return /Execution context was destroyed|Cannot find context|frame was detached|waitForFunction: Timeout/i.test(message);
}

async function installBridge(page, intervalMs, client) {
  await page.addScriptTag({
    content: `(() => {
      const attr = ${JSON.stringify(DATA_ATTR)};
      const intervalMs = ${JSON.stringify(intervalMs)};
      const client = ${JSON.stringify(client)};
      if (window.__dwMovementLabBridge?.interval) window.clearInterval(window.__dwMovementLabBridge.interval);
      let seq = 0;
      const finite = (value) => Number.isFinite(value) ? value : null;
      const cloneTail = (value) => Array.isArray(value) ? value.slice(-8) : [];
      const sample = () => {
        const legacy = window.__successor3d;
        const rust = typeof window.__successorMovementProbe === "function"
          ? window.__successorMovementProbe()
          : null;
        const payload = rust ? {
          seq: ++seq,
          ok: true,
          client,
          wallTimeMs: Date.now(),
          perfMs: performance.now(),
          tick: null,
          fps: rust.frameDtMs > 0 ? 1000 / rust.frameDtMs : null,
          serverStatus: "connected",
          sourceMatchesClient: true,
          activeAreaId: null,
          playerActorId: null,
          playerCell: { x: finite(rust.rendered?.[0]), y: finite(rust.rendered?.[1]) },
          authorityPlayer: { x: finite(rust.authoritative?.[0]), y: finite(rust.authoritative?.[1]), areaId: null },
          predictionErrorCells: finite(rust.correctionCells),
          renderDriftMaxCells: finite(rust.correctionCells),
          acceptedCommands: null,
          rejectedCommands: null,
          moveGate: {
            moving: rust.intent?.[0] !== 0 || rust.intent?.[1] !== 0,
            inFlightMoves: null,
            pendingMoves: null,
            sendGateStalled: false,
            lastMoveIssuedAtTick: null,
            snapshotTick: null,
            lastMoveCommandAtMs: finite(rust.lastSendMs),
            nextMoveCommandAtMs: finite(rust.nextSendMs),
            moveCommandIntervalMs: Number.isFinite(rust.nextSendMs) && Number.isFinite(rust.lastSendMs)
              ? Math.max(0, rust.nextSendMs - rust.lastSendMs)
              : null,
            sampledAtMs: finite(rust.sampledAtMs),
            lastChangeAtWallMs: Number.isFinite(rust.lastChangeMs) && Number.isFinite(rust.sampledAtMs)
              ? Date.now() - rust.sampledAtMs + rust.lastChangeMs
              : null,
            lastSendAtWallMs: Number.isFinite(rust.lastSendMs) && Number.isFinite(rust.sampledAtMs)
              ? Date.now() - rust.sampledAtMs + rust.lastSendMs
              : null,
            appliedObservedAtWallMs: Date.now(),
            appliedCommandId: finite(rust.appliedCommandId),
            blockerCount: finite(rust.blockerCount),
            presentedGroundY: finite(rust.presentedGroundY),
            sampledGroundY: finite(rust.sampledGroundY),
            sentMoveTail: [],
            receiptTail: [],
          },
          rejectLog: [],
        } : {
          seq: ++seq,
          ok: !!legacy,
          client,
          wallTimeMs: Date.now(),
          perfMs: performance.now(),
          tick: legacy?.tick ?? null,
          fps: legacy?.fps ?? null,
          serverStatus: legacy?.serverStatus ?? null,
          sourceMatchesClient: legacy?.sourceMatchesClient ?? null,
          activeAreaId: legacy?.activeAreaId ?? null,
          playerActorId: legacy?.playerActorId ?? null,
          playerCell: legacy?.playerCell ? { x: finite(legacy.playerCell.x), y: finite(legacy.playerCell.y) } : null,
          authorityPlayer: legacy?.authorityPlayer ? { x: finite(legacy.authorityPlayer.x), y: finite(legacy.authorityPlayer.y), areaId: legacy.authorityPlayer.areaId ?? null } : null,
          predictionErrorCells: finite(legacy?.predictionErrorCells ?? null),
          renderDriftMaxCells: finite(legacy?.renderDriftMaxCells ?? null),
          acceptedCommands: legacy?.acceptedCommands ?? null,
          rejectedCommands: legacy?.rejectedCommands ?? null,
          moveGate: legacy?.moveGate ? {
            moving: legacy.moveGate.moving === true,
            inFlightMoves: legacy.moveGate.inFlightMoves ?? null,
            pendingMoves: legacy.moveGate.pendingMoves ?? null,
            sendGateStalled: legacy.moveGate.sendGateStalled === true,
            lastMoveIssuedAtTick: legacy.moveGate.lastMoveIssuedAtTick ?? null,
            snapshotTick: legacy.moveGate.snapshotTick ?? null,
            lastMoveCommandAtMs: finite(legacy.moveGate.lastMoveCommandAtMs ?? null),
            nextMoveCommandAtMs: finite(legacy.moveGate.nextMoveCommandAtMs ?? null),
            moveCommandIntervalMs: finite(legacy.moveGate.moveCommandIntervalMs ?? null),
            sentMoveTail: cloneTail(legacy.moveGate.sentMoveTail),
            receiptTail: cloneTail(legacy.moveGate.receiptTail),
          } : null,
          rejectLog: cloneTail(legacy?.rejectLog),
        };
        document.body?.setAttribute(attr, JSON.stringify(payload));
      };
      sample();
      const interval = window.setInterval(sample, intervalMs);
      window.__dwMovementLabBridge = { interval, sample };
    })();`,
  });
}

async function waitForWorldReady(page, client) {
  await page.waitForFunction(({ attr, client }) => {
    const raw = document.body?.getAttribute(attr);
    if (!raw) return false;
    try {
      const probe = JSON.parse(raw);
      return client === "rust-web"
        ? !!(probe?.ok && probe?.playerCell)
        : !!(probe?.ok && probe?.playerCell && probe?.sourceMatchesClient === true
          && probe?.serverStatus && probe.serverStatus !== "off");
    } catch {
      return false;
    }
  }, { attr: DATA_ATTR, client }, { timeout: 30_000 });
  await page.waitForSelector("canvas", { timeout: 15_000 });
}

async function readBridgeProbe(page) {
  const raw = await page.evaluate((attr) => document.body?.getAttribute(attr) ?? null, DATA_ATTR);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function clearMoveTrace(page) {
  await moveTraceCommand(page, "clear");
}

async function drainMoveTrace(page) {
  const payload = await moveTraceCommand(page, "drain");
  if (payload.error) throw new Error(payload.error);
  return Array.isArray(payload.events) ? payload.events : [];
}

async function moveTraceCommand(page, method) {
  await page.addScriptTag({
    content: `(() => {
      const attr = ${JSON.stringify(MOVE_TRACE_ATTR)};
      const method = ${JSON.stringify(method)};
      try {
        const trace = window.__successorMoveTrace;
        if (!trace) {
          document.body?.setAttribute(attr, JSON.stringify({
            ok: false,
            method,
            countBefore: null,
            events: [],
            error: "window.__successorMoveTrace is not installed; ensure the URL has moveTrace=1",
          }));
          return;
        }
        const countBefore = trace.count ?? null;
        let events = [];
        if (method === "clear") {
          trace.clear();
        } else if (method === "drain") {
          events = trace.drain();
        } else {
          throw new Error("unsupported move trace method " + method);
        }
        document.body?.setAttribute(attr, JSON.stringify({
          ok: true,
          method,
          countBefore,
          countAfter: trace.count ?? null,
          capacity: trace.capacity ?? null,
          events,
        }));
      } catch (error) {
        document.body?.setAttribute(attr, JSON.stringify({
          ok: false,
          method,
          countBefore: null,
          events: [],
          error: error instanceof Error ? error.message : String(error),
        }));
      } finally {
        document.currentScript?.remove();
      }
    })();`,
  });
  const raw = await page.evaluate((attr) => document.body?.getAttribute(attr) ?? null, MOVE_TRACE_ATTR);
  if (!raw) throw new Error("move trace command produced no DOM payload");
  const payload = JSON.parse(raw);
  if (!payload.ok && method !== "clear") throw new Error(payload.error ?? "move trace command failed");
  return payload;
}

async function focusRuntime(page) {
  await page.bringToFront();
  await page.evaluate(() => {
    window.focus();
    const canvas = document.querySelector("canvas");
    if (canvas instanceof HTMLElement) canvas.focus();
  });
}

async function releaseAll(page) {
  for (const key of RELEASE_KEYS) {
    await page.keyboard.up(key).catch(() => {});
  }
}

async function startScenarioScreencast(page, scenarioDir, scenarioStartWallMs, screenshotPaths) {
  const cdp = await page.context().newCDPSession(page);
  let index = 0;
  let lastSavedAt = 0;
  const saveIntervalMs = Math.max(100, Math.floor(screenshotMs * 0.8));
  let stopped = false;
  let captureError = null;

  cdp.on("Page.screencastFrame", async (frame) => {
    try {
      const now = Date.now();
      if (!stopped && now - lastSavedAt >= saveIntervalMs) {
        const file = path.join(scenarioDir, `${String(index).padStart(3, "0")}-${now - scenarioStartWallMs}ms.jpg`);
        fs.writeFileSync(file, Buffer.from(frame.data, "base64"));
        screenshotPaths.push(file);
        index += 1;
        lastSavedAt = now;
      }
    } catch (error) {
      captureError ??= error instanceof Error ? error.message : String(error);
    } finally {
      await cdp.send("Page.screencastFrameAck", { sessionId: frame.sessionId }).catch(() => {});
    }
  });

  await cdp.send("Page.startScreencast", {
    format: "jpeg",
    quality: 70,
    maxWidth: Math.min(viewport.width, 960),
    maxHeight: Math.min(viewport.height, 640),
    everyNthFrame: 1,
  });

  return {
    async stop() {
      stopped = true;
      await cdp.send("Page.stopScreencast").catch(() => {});
      await cdp.detach().catch(() => {});
      if (captureError) throw new Error(captureError);
    },
  };
}

function buildRuntimeUrl({
  baseUrl: rawBaseUrl,
  port: gamePort,
  actor: actorId,
  actorName: name,
  spawnArea: area,
  spawnX: x,
  spawnY: y,
  clientKind: client,
}) {
  const url = new URL(rawBaseUrl);
  if (client === "rust-web") {
    const launch = {
      schema: "successor.launch-context.v1",
      gameTicket: "dev-identity",
      chatTicket: "dev-chat-identity",
      endpoints: {
        game: `ws://127.0.0.1:${gamePort}`,
        chat: `ws://127.0.0.1:${gamePort}`,
      },
      release: { client: "movement-lab", server: "movement-lab", shard: "movement-lab" },
      devSpawn: { area, x: String(x), y: String(y), facing: "right" },
      characterId: actorId,
      expiresAt: Date.now() + 3_600_000,
    };
    url.searchParams.set("launch", Buffer.from(JSON.stringify(launch)).toString("base64"));
    return url.toString();
  }
  url.searchParams.set("gamePort", String(gamePort));
  url.searchParams.set("slicePath", "/successor-slice/open-desert-slice.json");
  url.searchParams.set("mapBundlePath", "/successor-slice/open-desert-map-bundle.json");
  url.searchParams.set("player", actorId);
  url.searchParams.set("actorId", actorId);
  url.searchParams.set("name", name);
  url.searchParams.set("autoEnter", "1");
  url.searchParams.set("equip", "slugthrower");
  url.searchParams.set("spawnArea", area);
  url.searchParams.set("spawnX", String(x));
  url.searchParams.set("spawnY", String(y));
  url.searchParams.set("facing", "right");
  url.searchParams.set("moveTrace", "1");
  return url.toString();
}

function loadBrowserDriver() {
  const candidates = [
    { label: "client-3d", pkg: path.join(repoRoot, "client-3d", "package.json") },
    { label: "desktop", pkg: path.join(repoRoot, "desktop", "package.json") },
    { label: "repo-root", pkg: path.join(repoRoot, "package.json") },
    { label: "client", pkg: path.join(repoRoot, "client", "package.json") },
  ];
  const checks = [];
  for (const candidate of candidates) {
    try {
      const req = createRequire(candidate.pkg);
      const resolved = req.resolve("puppeteer");
      checks.push(`${candidate.label}:puppeteer:${resolved}`);
    } catch {
      checks.push(`${candidate.label}:no-puppeteer`);
    }
  }
  for (const candidate of candidates) {
    const req = createRequire(candidate.pkg);
    for (const moduleName of ["@playwright/test", "playwright"]) {
      try {
        const resolved = req.resolve(moduleName);
        const mod = req(moduleName);
        if (mod?.chromium) {
          return {
            chromium: mod.chromium,
            driver: {
              name: "playwright",
              module: moduleName,
              resolvedFrom: candidate.label,
              resolvedPath: resolved,
              note: "client-3d puppeteer was not present; Playwright was used from the workspace/client install.",
              checks,
            },
          };
        }
      } catch {
        // Try next module/candidate.
      }
    }
  }
  throw new Error(`No browser automation driver found. Resolution checks: ${checks.join(", ")}`);
}

function fetchJson(statusPort, requestPath) {
  return new Promise((resolve, reject) => {
    const req = http.get({ hostname: "127.0.0.1", port: statusPort, path: requestPath, timeout: 1_500 }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => {
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 200)}`));
          return;
        }
        try {
          resolve(JSON.parse(body));
        } catch (error) {
          reject(error);
        }
      });
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
  });
}

async function fetchActorActionVitals(actorId) {
  const oracle = await fetchJson(port, "/game/debug/oracle");
  const actorState = oracle?.actors?.[actorId] ?? null;
  if (!actorState) {
    return {
      actorId,
      found: false,
      action: null,
      maxAction: null,
      sprintActionThreshold,
      full: false,
      lifeState: null,
      tick: finiteNumber(oracle?.tick),
      mobility: null,
    };
  }
  const action = finiteNumber(actorState.vitals?.action);
  const maxAction = finiteNumber(actorState.maxVitals?.action);
  return {
    actorId,
    found: true,
    action,
    maxAction,
    sprintActionThreshold,
    full: action !== null && maxAction !== null && action >= maxAction - 0.001,
    lifeState: actorState.lifeState ?? null,
    tick: finiteNumber(oracle?.tick),
    mobility: compactMobility(actorState.mobility),
  };
}

async function waitForActionFull(actorId, { reason }) {
  const deadline = Date.now() + 75_000;
  let last = null;
  while (Date.now() < deadline) {
    last = await fetchActorActionVitals(actorId);
    if (last.found && last.full && last.lifeState !== "downed") return last;
    await delay(500);
  }
  throw new Error(`Timed out waiting for ${actorId} action regen before ${reason}; last=${JSON.stringify(last)}`);
}

function deriveActionContamination(samples) {
  let heldMovementSamples = 0;
  let contaminatedHeldSamples = 0;
  let contaminatedSamples = 0;
  let samplesWithVitals = 0;
  let minAction = Number.POSITIVE_INFINITY;
  let maxAction = null;
  for (const sample of samples) {
    const vitals = sample.actionVitals;
    if (vitals?.found && typeof vitals.action === "number") {
      samplesWithVitals += 1;
      minAction = Math.min(minAction, vitals.action);
      if (typeof vitals.maxAction === "number") maxAction = vitals.maxAction;
      if (vitals.action < sprintActionThreshold) contaminatedSamples += 1;
    }
    const held = Array.isArray(sample.keysHeld) && sample.keysHeld.some((key) => MOVEMENT_KEYS.has(key));
    if (held) {
      heldMovementSamples += 1;
      if (vitals?.found && typeof vitals.action === "number" && vitals.action < sprintActionThreshold) {
        contaminatedHeldSamples += 1;
      }
    }
  }
  const thresholdFraction = heldMovementSamples > 0 ? contaminatedHeldSamples / heldMovementSamples : 0;
  const sprintBudget = deriveSprintDrainBudget(samples);
  const budget = sprintBudget ?? {
    kind: "legacy-action-threshold",
    fraction: thresholdFraction,
    percent: round(thresholdFraction * 100),
    contaminatedHeldSamples,
    heldMovementSamples,
  };
  return {
    sprintActionThreshold,
    fraction: budget.fraction,
    percent: round(budget.fraction * 100),
    thresholdFraction,
    thresholdPercent: round(thresholdFraction * 100),
    contaminatedHeldSamples,
    heldMovementSamples,
    contaminatedSamples,
    totalSamples: samples.length,
    sampleFraction: samples.length > 0 ? contaminatedSamples / samples.length : 0,
    samplesWithVitals,
    missingVitalsSamples: samples.length - samplesWithVitals,
    minAction: Number.isFinite(minAction) ? round(minAction) : null,
    maxAction,
    budget,
  };
}

function deriveSprintDrainBudget(samples) {
  const telemetry = samples
    .map((sample) => sample.actionVitals)
    .filter((vitals) => vitals?.found && vitals.mobility)
    .filter((vitals) => Number.isFinite(vitals.mobility.sprintTicks) && Number.isFinite(vitals.mobility.sprintActionSpentMilli));
  if (telemetry.length < 2) return null;
  const first = telemetry[0].mobility;
  const last = telemetry.at(-1).mobility;
  const sprintTicks = Math.max(0, last.sprintTicks - first.sprintTicks);
  const observedSpentMilli = Math.max(0, last.sprintActionSpentMilli - first.sprintActionSpentMilli);
  if (sprintTicks <= 0 && observedSpentMilli <= 0) return null;
  const expectedSpentMilli = sprintTicks * SPRINT_ACTION_COST_MILLI_PER_TICK;
  const deviationMilli = Math.abs(observedSpentMilli - expectedSpentMilli);
  const fraction = expectedSpentMilli > 0 ? deviationMilli / expectedSpentMilli : 1;
  return {
    kind: "fractional-sprint-drain",
    authorityTickRateHz: AUTHORITY_TICK_RATE_HZ,
    sprintActionDrainPerSecond: SPRINT_ACTION_DRAIN_PER_SECOND,
    sprintActionCostMilliPerTick: SPRINT_ACTION_COST_MILLI_PER_TICK,
    sprintTicks,
    observedSpentMilli,
    expectedSpentMilli,
    deviationMilli,
    fraction,
    percent: round(fraction * 100),
    start: {
      sprintTicks: first.sprintTicks,
      sprintActionSpentMilli: first.sprintActionSpentMilli,
      sprintActionDrainMilli: first.sprintActionDrainMilli,
    },
    end: {
      sprintTicks: last.sprintTicks,
      sprintActionSpentMilli: last.sprintActionSpentMilli,
      sprintActionDrainMilli: last.sprintActionDrainMilli,
    },
  };
}

function actionContaminationFailure(actionContamination) {
  const budget = actionContamination?.budget;
  const fraction = budget?.fraction ?? actionContamination?.fraction ?? 0;
  if (fraction <= maxActionContamination) return null;
  const limit = (maxActionContamination * 100).toFixed(1);
  if (budget?.kind === "fractional-sprint-drain") {
    return `sprint drain deviation ${(fraction * 100).toFixed(1)}% > ${limit}% (${budget.observedSpentMilli}m observed vs ${budget.expectedSpentMilli}m expected over ${budget.sprintTicks} sprint ticks)`;
  }
  return `action contamination ${(fraction * 100).toFixed(1)}% > ${limit}%`;
}

function compactMobility(mobility) {
  if (!mobility || typeof mobility !== "object") return null;
  return {
    sprintActionDrainMilli: finiteNumber(mobility.sprintActionDrainMilli),
    sprintRegenBlockUntilTick: finiteNumber(mobility.sprintRegenBlockUntilTick),
    sprintRegenBlocked: mobility.sprintRegenBlocked === true,
    sprintTicks: finiteNumber(mobility.sprintTicks),
    sprintActionSpentMilli: finiteNumber(mobility.sprintActionSpentMilli),
    lastSprintTick: finiteNumber(mobility.lastSprintTick),
    sprintRecoveryLocked: mobility.sprintRecoveryLocked === true,
  };
}

function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function collectServerTrace({ runDir: traceRunDir, unit, sinceWallMs }) {
  const since = new Date(Math.max(0, sinceWallMs - 2_000)).toISOString();
  const outputPath = path.join(traceRunDir, "server-trace.jsonl");
  const argv = ["--user", "-u", unit, "-o", "cat", "--since", since];
  const result = spawnSync("journalctl", argv, {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) {
    fs.writeFileSync(outputPath, "", "utf8");
    return {
      path: outputPath,
      unit,
      since,
      command: ["journalctl", ...argv],
      lineCount: 0,
      error: `${result.stderr || result.stdout || "journalctl failed"}`.trim(),
    };
  }
  const lines = (result.stdout ?? "")
    .split(/\r?\n/)
    .filter((line) => line.includes("successor.move-trace.v1"))
    .filter((line) => {
      try {
        return JSON.parse(line).schema === "successor.move-trace.v1";
      } catch {
        return false;
      }
    });
  fs.writeFileSync(outputPath, lines.length > 0 ? `${lines.join("\n")}\n` : "", "utf8");
  return {
    path: outputPath,
    unit,
    since,
    command: ["journalctl", ...argv],
    lineCount: lines.length,
  };
}


function printSummary(result) {
  console.log(`movement-lab: ${result.status} · driver=${result.driver.name}/${result.driver.module} · actor=${result.config.actor} · port=${result.config.port}`);
  console.table(result.scenarios.map((scenario) => ({
    scenario: scenario.id,
    status: scenario.status,
    samples: scenario.sampleCount,
    shots: scenario.screenshotCount,
    firstMoveMs: scenario.metrics.timeToFirstCellChangeMs,
    stalls: scenario.metrics.stallCount,
    stallMs: scenario.metrics.stallTotalMs,
    flipMs: scenario.metrics.directionFlipResponseMs,
    snapbacks: scenario.metrics.snapbackCount,
    rejects: scenario.metrics.rejectedDelta,
    predErrMax: scenario.metrics.predictionErrorMaxCells,
    micro: scenario.metrics.microStutter?.count ?? null,
    actionContamPct: scenario.metrics.actionContamination?.percent ?? null,
  })));
}

function compactStatus(status) {
  if (!status || typeof status !== "object") return status ?? null;
  return {
    shardId: status.shardId ?? null,
    tick: status.tick ?? null,
    actorCount: status.actorCount ?? null,
    sessionCount: status.sessionCount ?? null,
    sourceHash: status.source?.stateHash ?? status.sourceHash ?? null,
    error: status.error ?? undefined,
  };
}

function summarize(values) {
  return {
    count: values.length,
    p50: round(percentile(values, 0.5)),
    p95: round(percentile(values, 0.95)),
    values,
  };
}

function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * p)));
  return sorted[index] ?? 0;
}

function distance(a, b) {
  return Math.hypot((a?.x ?? 0) - (b?.x ?? 0), (a?.y ?? 0) - (b?.y ?? 0));
}

function keyboardKeyForCode(code) {
  const key = KEYBOARD_KEY.get(code);
  if (!key) throw new Error(`unsupported key code ${code}`);
  return key;
}

function removeFromArray(array, value) {
  const index = array.indexOf(value);
  if (index >= 0) array.splice(index, 1);
}

function findLastIndex(array, predicate) {
  for (let i = array.length - 1; i >= 0; i -= 1) {
    if (predicate(array[i], i)) return i;
  }
  return -1;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function round(value) {
  if (!Number.isFinite(value)) return null;
  return Math.round(value * 1000) / 1000;
}

function safeName(value) {
  return String(value).replace(/[^a-zA-Z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "run";
}

function stamp() {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function parseArgs(args) {
  const parsed = new Map();
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (!arg.startsWith("--")) continue;
    const body = arg.slice(2);
    if (body.startsWith("no-")) {
      parsed.set(body.slice(3), "0");
      continue;
    }
    const eq = body.indexOf("=");
    if (eq >= 0) {
      parsed.set(body.slice(0, eq), body.slice(eq + 1));
      continue;
    }
    const next = args[i + 1];
    if (next && !next.startsWith("--")) {
      parsed.set(body, next);
      i += 1;
    } else {
      parsed.set(body, "1");
    }
  }
  return parsed;
}

function stringArg(args, name, fallback) {
  const value = args.get(name);
  return value === undefined || value === "" ? fallback : String(value);
}

function enumArg(args, name, fallback, allowed) {
  const value = stringArg(args, name, fallback);
  if (!allowed.includes(value)) {
    throw new Error(`--${name} must be one of ${allowed.join(", ")}; got ${value}`);
  }
  return value;
}

function integerArg(args, name, fallback, { min, max }) {
  const raw = args.get(name);
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`--${name} must be an integer from ${min} to ${max}; got ${raw}`);
  }
  return value;
}

function numberArg(args, name, fallback, { min, max }) {
  const raw = args.get(name);
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(`--${name} must be a number from ${min} to ${max}; got ${raw}`);
  }
  return value;
}

function nonNegativeIntegerArg(args, name, fallback) {
  const raw = args.get(name);
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`--${name} must be a non-negative integer; got ${raw}`);
  }
  return value;
}

function normalizeSystemdUnit(value) {
  return value.endsWith(".service") ? value : `${value}.service`;
}

function boolArg(args, name, fallback) {
  const raw = args.get(name);
  if (raw === undefined || raw === "") return fallback;
  return parseBool(raw, `--${name}`);
}

function envBool(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  return parseBool(raw, name);
}

function parseBool(raw, label) {
  const normal = String(raw).toLowerCase();
  if (["1", "true", "yes", "on"].includes(normal)) return true;
  if (["0", "false", "no", "off"].includes(normal)) return false;
  throw new Error(`${label} must be boolean-ish; got ${raw}`);
}
