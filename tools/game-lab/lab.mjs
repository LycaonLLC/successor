#!/usr/bin/env node
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import process from "node:process";
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");
const runsRoot = path.join(repoRoot, ".game-lab", "runs");
const slicePath = path.join(repoRoot, "client", "public", "successor-slice", "open-desert-slice.json");
const mapBundlePath = "/successor-slice/open-desert-map-bundle.json";
const sliceUrlPath = "/successor-slice/open-desert-slice.json";
const forbiddenPorts = new Set([28093, 18192, 5179]);
const defaultVitePortStart = 5180;
const dataAttr = "data-sc3d-game-lab-probe";
const releaseKeys = ["w", "a", "s", "d", "Shift"];
const batteryVersions = {
  movement: "movement-lab:v1",
  "fx-smoke": "game-lab-fx-smoke:v1",
  "combat-smoke": "game-lab-combat-smoke:v2",
  "ui-smoke": "game-lab-ui-smoke:v1",
};
const defaultBatteries = Object.keys(batteryVersions);
const pageViewport = { width: 1440, height: 960 };
let bridgeSeq = 0;

const [command, ...rest] = process.argv.slice(2);
try {
  if (command === "run") {
    await runCommand(rest);
  } else if (command === "compare") {
    compareCommand(rest);
  } else if (command === "list") {
    listCommand();
  } else {
    printUsage();
    process.exitCode = command ? 1 : 0;
  }
} catch (error) {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
}

async function runCommand(args) {
  const options = parseRunArgs(args);
  const batteries = options.batteries.length > 0 ? options.batteries : defaultBatteries;
  const port = options.port ?? await pickFreePort(18093);
  guardLabPort(port);
  const vitePort = options.vitePort ?? await pickFreePort(defaultVitePortStart);
  const runId = options.runId ?? `${stamp()}-${Math.random().toString(36).slice(2, 8)}`;
  const runDir = path.join(runsRoot, safeName(runId));
  const logsDir = path.join(runDir, "logs");
  const rootTracesDir = path.join(runDir, "traces");
  const sessionRecordingPath = path.join(runDir, "session-recording.jsonl");
  fs.mkdirSync(logsDir, { recursive: true });
  fs.mkdirSync(rootTracesDir, { recursive: true });
  fs.writeFileSync(sessionRecordingPath, "", "utf8");

  const startedAt = new Date().toISOString();
  const gitRev = resolveGitRev();
  const sliceStateHash = readSliceStateHash();
  const unitName = `successor-game-lab-${safeName(runId).slice(0, 32)}-${port}`;
  const unitService = `${unitName}.service`;
  const manifest = {
    schema: "successor.game-lab.manifest.v1",
    runId,
    startedAt,
    completedAt: null,
    gitRev,
    sliceStateHash,
    port,
    vitePort,
    unit: unitService,
    status: "running",
    batteries: batteries.map((id) => ({ id, version: batteryVersions[id] })),
    verdicts: {},
    artifacts: {
      runDir,
      sessionRecording: path.relative(runDir, sessionRecordingPath),
    },
    failures: [],
  };
  writeManifest(runDir, manifest);

  let viteProcess = null;
  const ctx = {
    runId,
    runDir,
    logsDir,
    sessionRecordingPath,
    port,
    vitePort,
    unitService,
    unitName,
    manifest,
    sliceStateHash,
    startedAt,
  };
  const runStartedAt = performance.now();
  try {
    const boot = bootIsolatedStack(ctx);
    manifest.server = { boot };
    writeManifest(runDir, manifest);
    viteProcess = await ensureVite(vitePort, logsDir);
    manifest.vite = { port: vitePort, spawned: Boolean(viteProcess) };
    writeManifest(runDir, manifest);

    for (const battery of batteries) {
      const started = new Date().toISOString();
      try {
        const result = await runBattery(ctx, battery, started);
        manifest.verdicts[battery] = result.verdict;
        if (result.verdict !== "pass") manifest.failures.push(...result.failures.map((failure) => `${battery}: ${failure}`));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        manifest.verdicts[battery] = "fail";
        manifest.failures.push(`${battery}: ${message}`);
        writeFailedBatteryMetrics(ctx, battery, started, message);
      }
      writeManifest(runDir, manifest);
    }
  } finally {
    const rootServerTrace = collectServerMoveTrace({
      unit: unitService,
      sinceIso: startedAt,
      outPath: path.join(rootTracesDir, "server-move-trace.jsonl"),
    });
    manifest.artifacts.serverMoveTrace = path.relative(runDir, rootServerTrace.path);
    manifest.serverTrace = rootServerTrace;
    manifest.completedAt = new Date().toISOString();
    manifest.durationMs = Math.round(performance.now() - runStartedAt);
    manifest.status = Object.values(manifest.verdicts).every((value) => value === "pass") && manifest.failures.length === 0 ? "pass" : "fail";
    writeManifest(runDir, manifest);
    if (!options.keepServer) stopScratchUnit(unitService, logsDir);
    if (viteProcess) stopProcess(viteProcess);
  }

  printRunSummary(manifest);
  if (manifest.status !== "pass") process.exitCode = 1;
}

function compareCommand(args) {
  if (args.length !== 2) throw new Error("compare requires exactly two run ids or paths");
  const leftDir = resolveRunDir(args[0]);
  const rightDir = resolveRunDir(args[1]);
  const left = loadRunMetrics(leftDir);
  const right = loadRunMetrics(rightDir);
  const rows = [];
  for (const key of Object.keys(left.values).sort()) {
    if (!(key in right.values)) continue;
    const a = left.values[key];
    const b = right.values[key];
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
    const delta = b - a;
    rows.push({ metric: key, A: round(a), B: round(b), delta: round(delta), pct: a === 0 ? null : round((delta / a) * 100) });
  }
  console.log(`A ${left.runId}  B ${right.runId}`);
  if (rows.length === 0) {
    console.log("No common numeric metrics.");
    return;
  }
  console.table(rows.slice(0, 160));
  if (rows.length > 160) console.log(`… ${rows.length - 160} more common numeric metrics omitted`);
}

function listCommand() {
  fs.mkdirSync(runsRoot, { recursive: true });
  const rows = [];
  for (const entry of fs.readdirSync(runsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifestPath = path.join(runsRoot, entry.name, "manifest.json");
    if (!fs.existsSync(manifestPath)) continue;
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    rows.push({
      runId: manifest.runId ?? entry.name,
      startedAt: manifest.startedAt ?? "",
      status: manifest.status ?? "unknown",
      port: manifest.port ?? "",
      verdicts: Object.entries(manifest.verdicts ?? {}).map(([id, verdict]) => `${id}:${verdict}`).join(" "),
    });
  }
  rows.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  if (rows.length === 0) {
    console.log("No Game Lab runs archived yet.");
    return;
  }
  console.table(rows);
}

async function runBattery(ctx, battery, startedAt) {
  if (battery === "movement") return runMovementBattery(ctx, startedAt);
  if (battery === "fx-smoke") return runFxSmokeBattery(ctx, startedAt);
  if (battery === "combat-smoke") return runCombatSmokeBattery(ctx, startedAt);
  if (battery === "ui-smoke") return runUiSmokeBattery(ctx, startedAt);
  throw new Error(`unknown battery ${battery}`);
}

function runMovementBattery(ctx, startedAt) {
  const work = prepareBattery(ctx, "movement");
  const movementRunId = `${ctx.runId}-movement`;
  const movementMetricsPath = path.join("/tmp", "movement-lab", `metrics-${movementRunId}.json`);
  const movementRunDir = path.join("/tmp", "movement-lab", movementRunId);
  const logPath = path.join(work.dir, "movement-lab.log");
  const baseUrl = `http://127.0.0.1:${ctx.vitePort}/?gameTrace=1`;
  const actor = labActorId(ctx.runId, "movement");
  const argv = [
    "tools/movement-lab/run-scenarios.mjs",
    `--port=${ctx.port}`,
    `--vite-port=${ctx.vitePort}`,
    `--actor=${actor}`,
    `--name=${actor}`,
    `--run-id=${movementRunId}`,
    `--base-url=${baseUrl}`,
    "--screenshot-ms=450",
    "--server-trace",
    `--server-unit=${ctx.unitService}`,
    "--sprint-action-threshold=10",
    "--max-action-contamination=0.10",
    "--energy-retries=2",
  ];
  const movementPlan = movementPlanFor(argv);
  const movementTimeoutMs = movementPlan.recommendedTimeoutMs;
  const result = spawnSync(process.execPath, argv, {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: movementTimeoutMs,
  });
  fs.writeFileSync(logPath, `${result.stdout ?? ""}${result.stderr ?? ""}`, "utf8");
  const failures = [];
  if (result.error) failures.push(result.error.message);
  if (result.status !== 0) failures.push(`movement-lab exited ${result.status}`);
  let movementMetrics = null;
  let movementClientTraceCount = 0;
  if (fs.existsSync(movementMetricsPath)) {
    movementMetrics = JSON.parse(fs.readFileSync(movementMetricsPath, "utf8"));
    fs.copyFileSync(movementMetricsPath, path.join(work.dir, "movement-lab-metrics.json"));
    copyMovementArtifacts(movementMetrics, work.shotsDir);
    movementClientTraceCount = writeMovementClientTrace(movementMetrics, path.join(work.tracesDir, "client-move-trace.jsonl"));
    const movementServerTrace = path.join(movementRunDir, "server-trace.jsonl");
    if (fs.existsSync(movementServerTrace)) fs.copyFileSync(movementServerTrace, path.join(work.tracesDir, "server-move-trace.jsonl"));
    if (movementMetrics.status !== "pass") failures.push(...(movementMetrics.failures ?? ["movement-lab status not pass"]));
  } else {
    failures.push(`missing movement metrics ${movementMetricsPath}`);
  }
  const metrics = {
    schema: "successor.game-lab.battery-metrics.v1",
    battery: "movement",
    version: batteryVersions.movement,
    startedAt,
    completedAt: new Date().toISOString(),
    verdict: failures.length === 0 ? "pass" : "fail",
    failures,
    timeoutMs: movementTimeoutMs,
    plan: movementPlan,
    movementLab: movementMetrics,
    movementClientTraceCount,
    artifacts: {
      log: path.relative(work.dir, logPath),
      sourceMetrics: movementMetrics ? "movement-lab-metrics.json" : null,
      traces: relativeFiles(work.dir, work.tracesDir),
      shots: relativeFiles(work.dir, work.shotsDir),
    },
  };
  writeJson(work.metricsPath, metrics);
  return { verdict: metrics.verdict, failures };
}
function movementPlanFor(argv) {
  const result = spawnSync(process.execPath, [argv[0], ...argv.slice(1), "--plan-json"], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 30_000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`movement-lab plan derivation failed ${result.status}: ${(result.stderr || result.stdout || "").trim()}`);
  }
  const plan = JSON.parse(result.stdout);
  if (!Number.isFinite(plan.recommendedTimeoutMs) || plan.recommendedTimeoutMs <= 0) {
    throw new Error(`movement-lab plan missing recommended timeout: ${result.stdout}`);
  }
  return plan;
}

async function runFxSmokeBattery(ctx, startedAt) {
  return withBrowserBattery(ctx, "fx-smoke", startedAt, async ({ page, work }) => {
    const failures = [];
    const families = [
      { id: "psg", expression: `(() => { const fx = window.__successorFx; return fx ? [fx.psgTest("bubble", true), fx.psgTest("formfit", true)] : [false, false]; })()` },
      { id: "bolt", expression: `(() => { const fx = window.__successorFx; return fx ? [fx.boltTest()] : [false]; })()` },
      { id: "hit", expression: `(() => { const fx = window.__successorFx; return fx ? [fx.hitTest()] : [false]; })()` },
      { id: "blood", expression: `(() => { const fx = window.__successorFx; return fx ? [fx.bloodTest()] : [false]; })()` },
      { id: "status", expression: `(() => { const fx = window.__successorFx; return fx ? [fx.statusTest()] : [false]; })()` },
      { id: "power", expression: `(() => { const fx = window.__successorFx; return fx ? [fx.powerTest()] : [false]; })()` },
      { id: "beam", expression: `(() => { const fx = window.__successorFx; return fx ? [fx.beamTest()] : [false]; })()` },
    ];
    const reports = [];
    await waitForMainWorld(page, `Boolean(window.__successorFx?.debug)`, 12_000);
    for (const family of families) {
      const returns = await mainWorld(page, family.expression);
      if (!Array.isArray(returns) || returns.some((value) => value !== true)) failures.push(`${family.id} hook returned ${JSON.stringify(returns)}`);
      await delay(250);
      const firstStats = await mainWorld(page, `window.__successorFx?.debug?.() ?? null`);
      const firstShot = path.join(work.shotsDir, `${family.id}-01.png`);
      await page.screenshot({ path: firstShot, fullPage: false });
      await delay(500);
      const secondStats = await mainWorld(page, `window.__successorFx?.debug?.() ?? null`);
      const secondShot = path.join(work.shotsDir, `${family.id}-02.png`);
      await page.screenshot({ path: secondShot, fullPage: false });
      if (!firstStats || !secondStats) failures.push(`${family.id} debug stats missing`);
      reports.push({
        id: family.id,
        returns,
        stats: { first: firstStats, second: secondStats },
        screenshots: [path.relative(work.dir, firstShot), path.relative(work.dir, secondShot)],
      });
    }
    const traces = await drainBrowserTraces(ctx, page, work, "fx-smoke");
    const serverTrace = collectServerMoveTrace({ unit: ctx.unitService, sinceIso: startedAt, outPath: path.join(work.tracesDir, "server-move-trace.jsonl") });
    const metrics = {
      schema: "successor.game-lab.battery-metrics.v1",
      battery: "fx-smoke",
      version: batteryVersions["fx-smoke"],
      startedAt,
      completedAt: new Date().toISOString(),
      verdict: failures.length === 0 ? "pass" : "fail",
      failures,
      families: reports,
      traces,
      serverTrace,
    };
    writeJson(work.metricsPath, metrics);
    return { verdict: metrics.verdict, failures };
  });
}

async function runCombatSmokeBattery(ctx, startedAt) {
  const spawn = pickCombatSpawn();
  if (Object.keys(ctx.manifest.verdicts).length > 0) {
    const reset = await postJson(ctx.port, "/game/debug/reset-fixture", {});
    ctx.manifest.server = { ...(ctx.manifest.server ?? {}), combatReset: reset };
    writeManifest(ctx.runDir, ctx.manifest);
    await delay(500);
  }
  return withBrowserBattery(ctx, "combat-smoke", startedAt, async ({ page, work }) => {
    const actorId = labActorId(ctx.runId, "combat");
    await page.goto(runtimeUrl(ctx, {
      actor: actorId,
      name: "GameLab Combat",
      spawnX: spawn.playerX,
      spawnY: spawn.playerY,
      equip: "slugthrower",
      gameTrace: true,
      moveTrace: true,
    }), { waitUntil: "domcontentloaded" });
    await armPage(page);
    const failures = [];
    const commandResponses = [];
    const startOracle = await waitForTarget(ctx.port, actorId, 18_000);
    if (!startOracle.target) failures.push("no live Gaia creature activated near combat spawn");
    await postJson(ctx.port, "/game/debug/restock-loadout", { actorId })
      .then((response) => commandResponses.push({ actorId, restock: response }))
      .catch((error) => failures.push(`restock ${actorId} failed: ${error.message}`));
    commandResponses.push(await postDebugCommand(ctx.port, actorId, { SetEquippedWeapon: { weapon_id: "slugthrower" } }));
    let target = startOracle.target;
    let oracle = startOracle.oracle;
    const movementSteps = [];
    const combatEvents = [];
    const engagementRangeCells = 18;
    const deadline = Date.now() + 60_000;
    let killed = false;
    let shotCount = 0;
    while (target && Date.now() < deadline) {
      oracle = await fetchJson(ctx.port, "/game/debug/oracle?freshAiDebug=1");
      target = pickLiveTarget(oracle, actorId, target.id) ?? pickLiveTarget(oracle, actorId, null);
      if (!target || target.lifeState !== "alive") {
        killed = true;
        break;
      }
      const me = oracle.actors[actorId];
      if (!me || me.lifeState !== "alive") {
        failures.push("combat actor died before kill");
        break;
      }
      if (distance(me, target) > engagementRangeCells) {
        const step = stepToward(me, target);
        const response = await postDebugCommand(ctx.port, actorId, { Move: { dx: step.dx, dy: step.dy, duration_ticks: 6, facing: step.facing, sprint: true } });
        commandResponses.push(response);
        movementSteps.push({ tick: oracle.tick, actor: compactOracleActor(me), target: compactOracleActor(target), step });
        await delay(280);
        continue;
      }
      const response = await postDebugCommand(ctx.port, actorId, { QueueCombatAction: { action_id: "basic_shot", target_actor_id: target.id } });
      commandResponses.push(response);
      shotCount += 1;
      for (const event of response.events ?? []) {
        combatEvents.push(event);
        if (event.lifecycle?.kind === "downed" || event.lifecycle?.kind === "killed" || event.lifeState !== "alive") killed = true;
      }
      if (killed) break;
      await delay(1_150);
    }
    const traces = await drainBrowserTraces(ctx, page, work, "combat-smoke");
    const traceCombatEvents = traces.gameTraceEvents.filter((event) => event.kind === "combat-event");
    for (const event of traceCombatEvents) combatEvents.push(event.event ?? event);
    const killEvents = combatEvents.filter((event) => {
      const lifecycleKind = event.lifecycle?.kind;
      return lifecycleKind === "downed" || lifecycleKind === "killed" || event.lifeState === "downed" || event.lifeState === "dead";
    });
    if (killEvents.length > 0) killed = true;
    if (shotCount <= 0) failures.push("no QueueCombatAction command sent");
    if (!killed) failures.push("target was not killed/downed inside 60s");
    if (combatEvents.length <= 0) failures.push("no combat events flowed to response or game trace");
    writeJsonl(path.join(work.tracesDir, "combat-events.jsonl"), combatEvents);
    const serverTrace = collectServerMoveTrace({ unit: ctx.unitService, sinceIso: startedAt, outPath: path.join(work.tracesDir, "server-move-trace.jsonl") });
    const metrics = {
      schema: "successor.game-lab.battery-metrics.v1",
      battery: "combat-smoke",
      version: batteryVersions["combat-smoke"],
      startedAt,
      completedAt: new Date().toISOString(),
      verdict: failures.length === 0 ? "pass" : "fail",
      failures,
      spawn,
      actorIds: [actorId],
      movementSteps,
      shotCount,
      killed,
      killEvents: killEvents.map((event) => ({
        id: event.id ?? null,
        targetActorId: event.targetActorId ?? null,
        lifecycle: event.lifecycle ?? null,
        lifeState: event.lifeState ?? null,
      })),
      finalTarget: target ? compactOracleActor(target) : null,
      combatEventCount: combatEvents.length,
      commandResponses,
      traces,
      serverTrace,
    };
    writeJson(work.metricsPath, metrics);
    return { verdict: metrics.verdict, failures };
  }, { navigate: false });
}

async function runUiSmokeBattery(ctx, startedAt) {
  return withBrowserBattery(ctx, "ui-smoke", startedAt, async ({ page, work }) => {
    const failures = [];
    await page.click('button[aria-label="FX LAB"]');
    await page.locator('.sc3d-window[data-window="fxlab"]:not([hidden]) .scp-fxlab').waitFor({ timeout: 10_000 });
    await page.click('button[aria-label="DATAPAD"]');
    await page.locator('.sc3d-window[data-window="datapad"]:not([hidden]) .scp-datapad').waitFor({ timeout: 10_000 });
    await page.click('.sc3d-window[data-window="datapad"] .scp-tab[data-tab="waypoints"]');
    await page.locator('.sc3d-window[data-window="datapad"] .scp-datapad-surface[data-ref="waypointsHost"]:not([hidden])').waitFor({ timeout: 10_000 });
    await mainWorld(page, `window.__successor3dWaypoints?.clearLab?.() ?? 0`);
    const created = await mainWorld(page, `window.__successor3dWaypoints?.createAtPlayer?.("LAB WAYPOINT") ?? null`);
    if (!created?.ok || !created.waypoint?.id) failures.push(`waypoint create failed: ${JSON.stringify(created)}`);
    const row = page.locator('.sc3d-window[data-window="datapad"] .scp-waypoint-row', { hasText: "LAB WAYPOINT" });
    await row.waitFor({ timeout: 10_000 });
    const rowCountAfterCreate = await page.locator('.sc3d-window[data-window="datapad"] .scp-waypoint-row').count();
    if (created?.waypoint?.id) {
      const deleted = await mainWorld(page, `window.__successor3dWaypoints?.delete?.(${JSON.stringify(created.waypoint.id)}) ?? null`);
      if (!deleted?.ok) failures.push(`waypoint delete failed: ${JSON.stringify(deleted)}`);
      await page.locator('.sc3d-window[data-window="datapad"] .scp-waypoint-row', { hasText: "LAB WAYPOINT" }).waitFor({ state: "detached", timeout: 10_000 });
    }
    const rowCountAfterDelete = await page.locator('.sc3d-window[data-window="datapad"] .scp-waypoint-row').count();
    const shot = path.join(work.shotsDir, "ui-windows-waypoints.png");
    await page.screenshot({ path: shot, fullPage: false });
    const traces = await drainBrowserTraces(ctx, page, work, "ui-smoke");
    const serverTrace = collectServerMoveTrace({ unit: ctx.unitService, sinceIso: startedAt, outPath: path.join(work.tracesDir, "server-move-trace.jsonl") });
    const metrics = {
      schema: "successor.game-lab.battery-metrics.v1",
      battery: "ui-smoke",
      version: batteryVersions["ui-smoke"],
      startedAt,
      completedAt: new Date().toISOString(),
      verdict: failures.length === 0 ? "pass" : "fail",
      failures,
      windows: { fxlabOpen: true, datapadOpen: true, waypointsTabOpen: true },
      waypoint: { created, rowCountAfterCreate, rowCountAfterDelete },
      screenshots: [path.relative(work.dir, shot)],
      traces,
      serverTrace,
    };
    writeJson(work.metricsPath, metrics);
    return { verdict: metrics.verdict, failures };
  });
}

async function withBrowserBattery(ctx, battery, startedAt, fn, options = {}) {
  const work = prepareBattery(ctx, battery);
  const { chromium, driver } = loadBrowserDriver();
  const consoleLines = [];
  const pageErrors = [];
  let browser = null;
  try {
    browser = await chromium.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-background-timer-throttling",
        "--disable-backgrounding-occluded-windows",
        "--disable-renderer-backgrounding",
        `--window-size=${pageViewport.width},${pageViewport.height}`,
      ],
      timeout: 30_000,
    });
    const context = await browser.newContext({ viewport: pageViewport, deviceScaleFactor: 1 });
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    page.setDefaultNavigationTimeout(45_000);
    page.on("console", (msg) => {
      if (msg.type() === "error" || msg.type() === "warning") consoleLines.push({ type: msg.type(), text: msg.text(), at: Date.now() });
    });
    page.on("pageerror", (error) => pageErrors.push({ message: error.stack ?? error.message, at: Date.now() }));
    if (options.navigate !== false) {
      const actor = labActorId(ctx.runId, battery);
      await page.goto(runtimeUrl(ctx, { actor, name: `GameLab ${battery}`, gameTrace: true, moveTrace: true }), { waitUntil: "domcontentloaded" });
      await armPage(page);
    }
    const result = await fn({ page, work, driver });
    if (consoleLines.length > 0 || pageErrors.length > 0) {
      const metrics = JSON.parse(fs.readFileSync(work.metricsPath, "utf8"));
      metrics.browser = { driver, consoleWarningsAndErrors: consoleLines.slice(0, 80), pageErrors };
      if (pageErrors.length > 0 && metrics.verdict === "pass") {
        metrics.verdict = "fail";
        metrics.failures.push(`${pageErrors.length} page error(s)`);
        result.verdict = "fail";
        result.failures.push(`${pageErrors.length} page error(s)`);
      }
      writeJson(work.metricsPath, metrics);
    }
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const metrics = {
      schema: "successor.game-lab.battery-metrics.v1",
      battery,
      version: batteryVersions[battery],
      startedAt,
      completedAt: new Date().toISOString(),
      verdict: "fail",
      failures: [message],
      browser: { driver: driver ?? null, consoleWarningsAndErrors: consoleLines.slice(0, 80), pageErrors },
    };
    writeJson(work.metricsPath, metrics);
    return { verdict: "fail", failures: [message] };
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

async function armPage(page) {
  await page.bringToFront();
  await page.waitForSelector("body", { timeout: 10_000 });
  await installProbeBridge(page);
  await waitForWorldReady(page);
  await releaseAll(page);
}

function bootIsolatedStack(ctx, label = "open-desert-boot") {
  const logPath = path.join(ctx.logsDir, `${safeName(label)}.log`);
  const env = {
    ...process.env,
    OPEN_DESERT_PORT: String(ctx.port),
    OPEN_DESERT_UNIT: ctx.unitName,
    GAME_MOVE_TRACE: "1",
  };
  const result = spawnSync(process.execPath, ["tools/successor/serve-open-desert-fixture.mjs"], {
    cwd: repoRoot,
    env,
    encoding: "utf8",
    timeout: 240_000,
  });
  fs.writeFileSync(logPath, `${result.stdout ?? ""}${result.stderr ?? ""}`, "utf8");
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`serve-open-desert-fixture exited ${result.status}; see ${logPath}`);
  const status = JSON.parse(result.stdout.slice(result.stdout.indexOf("{")));
  guardLabPort(status.port);
  return { ...status, log: path.relative(ctx.runDir, logPath) };
}

async function ensureVite(vitePort, logsDir) {
  if (await isHttpReachable(vitePort, "/")) return null;
  const out = fs.openSync(path.join(logsDir, "vite.log"), "a");
  const child = spawn("pnpm", ["--dir", "client-3d", "exec", "vite", "--host", "127.0.0.1", "--port", String(vitePort)], {
    cwd: repoRoot,
    env: { ...process.env, SUCCESSOR_GAME_LAB: "1" },
    stdio: ["ignore", out, out],
    detached: false,
  });
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (await isHttpReachable(vitePort, "/")) return child;
    if (child.exitCode !== null) throw new Error(`vite exited ${child.exitCode}; see ${path.join(logsDir, "vite.log")}`);
    await delay(400);
  }
  throw new Error(`timed out waiting for vite on ${vitePort}`);
}

async function installProbeBridge(page) {
  await page.addScriptTag({
    content: `(() => {
      if (window.__dwGameLabProbeInterval) return;
      window.__dwGameLabProbeInterval = window.setInterval(() => {
        try {
          if (document.body) document.body.setAttribute(${JSON.stringify(dataAttr)}, JSON.stringify(window.__successor3d ?? null));
        } catch {}
      }, 100);
    })();`,
  });
}

async function waitForWorldReady(page) {
  const deadline = Date.now() + 35_000;
  let last = null;
  while (Date.now() < deadline) {
    last = await readProbe(page);
    if (last && last.serverStatus === "connected" && last.authorityPlayer) return last;
    await delay(150);
  }
  throw new Error(`timed out waiting for __successor3d connected probe; last=${JSON.stringify(last)}`);
}

async function readProbe(page) {
  const raw = await page.evaluate((attr) => document.body?.getAttribute(attr) ?? null, dataAttr);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function waitForMainWorld(page, expression, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await mainWorld(page, expression).catch(() => false);
    if (value) return value;
    await delay(150);
  }
  throw new Error(`timed out waiting for main-world expression ${expression}`);
}

async function mainWorld(page, expression, timeoutMs = 8_000) {
  bridgeSeq += 1;
  const attr = `data-sc3d-game-lab-call-${Date.now()}-${bridgeSeq}`;
  await page.addScriptTag({
    content: `(() => {
      const attr = ${JSON.stringify(attr)};
      try {
        const value = (${expression});
        document.body.setAttribute(attr, JSON.stringify({ ok: true, value }));
      } catch (error) {
        document.body.setAttribute(attr, JSON.stringify({ ok: false, error: error && (error.stack || error.message) || String(error) }));
      }
      document.currentScript?.remove();
    })();`,
  });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const raw = await page.evaluate((name) => document.body?.getAttribute(name) ?? null, attr);
    if (raw) {
      await page.evaluate((name) => document.body?.removeAttribute(name), attr).catch(() => {});
      const parsed = JSON.parse(raw);
      if (!parsed.ok) throw new Error(parsed.error ?? "main-world call failed");
      return parsed.value;
    }
    await delay(25);
  }
  throw new Error(`main-world call timed out: ${expression}`);
}

async function drainBrowserTraces(ctx, page, work, battery) {
  const gameTraceEvents = await mainWorld(page, `window.__successorGameTrace?.drain?.() ?? []`).catch((error) => [{ schema: "successor.game-trace.v1", kind: "lab-drain-error", error: error.message }]);
  const moveTraceEvents = await mainWorld(page, `window.__successorMoveTrace?.drain?.() ?? []`).catch((error) => [{ kind: "lab-drain-error", error: error.message }]);
  const gameTracePath = path.join(work.tracesDir, "client-game-trace.jsonl");
  const moveTracePath = path.join(work.tracesDir, "client-move-trace.jsonl");
  writeJsonl(gameTracePath, gameTraceEvents);
  writeJsonl(moveTracePath, moveTraceEvents);
  const sessionRows = gameTraceEvents.map((event) => ({ ...event, labRunId: ctx.runId, battery }));
  appendJsonl(ctx.sessionRecordingPath, sessionRows);
  return {
    gameTracePath: path.relative(work.dir, gameTracePath),
    gameTraceCount: gameTraceEvents.length,
    moveTracePath: path.relative(work.dir, moveTracePath),
    moveTraceCount: moveTraceEvents.length,
    gameTraceEvents,
  };
}

function collectServerMoveTrace({ unit, sinceIso, outPath }) {
  const result = spawnSync("journalctl", ["--user", "-u", unit, "-o", "cat", "--since", sinceIso], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 20_000,
  });
  const lines = [];
  const errors = [];
  if (result.error) errors.push(result.error.message);
  if (result.status !== 0 && result.stderr) errors.push(result.stderr.trim());
  for (const line of (result.stdout ?? "").split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed.schema === "successor.move-trace.v1") lines.push(trimmed);
    } catch {
      // ignore non-JSON server log lines
    }
  }
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, lines.length > 0 ? `${lines.join("\n")}\n` : "", "utf8");
  return { path: outPath, lineCount: lines.length, error: errors.join("; ") || null };
}

function runtimeUrl(ctx, options) {
  const url = new URL(`http://127.0.0.1:${ctx.vitePort}/`);
  url.searchParams.set("gamePort", String(ctx.port));
  url.searchParams.set("authority", "server");
  url.searchParams.set("player", options.actor);
  url.searchParams.set("actorId", options.actor);
  url.searchParams.set("name", options.name ?? options.actor);
  url.searchParams.set("autoEnter", "1");
  url.searchParams.set("equip", options.equip ?? "slugthrower");
  url.searchParams.set("unlimitedAmmo", "1");
  url.searchParams.set("spawnArea", options.spawnArea ?? "open-desert-overworld");
  url.searchParams.set("spawnX", String(options.spawnX ?? 515));
  url.searchParams.set("spawnY", String(options.spawnY ?? 515));
  url.searchParams.set("facing", "right");
  url.searchParams.set("slicePath", sliceUrlPath);
  url.searchParams.set("mapBundlePath", mapBundlePath);
  if (options.gameTrace) url.searchParams.set("gameTrace", "1");
  if (options.moveTrace) url.searchParams.set("moveTrace", "1");
  return url.toString();
}

function prepareBattery(ctx, battery) {
  const dir = path.join(ctx.runDir, battery);
  const tracesDir = path.join(dir, "traces");
  const shotsDir = path.join(dir, "shots");
  fs.mkdirSync(tracesDir, { recursive: true });
  fs.mkdirSync(shotsDir, { recursive: true });
  return { battery, dir, tracesDir, shotsDir, metricsPath: path.join(dir, "metrics.json") };
}

function writeFailedBatteryMetrics(ctx, battery, startedAt, message) {
  const work = prepareBattery(ctx, battery);
  writeJson(work.metricsPath, {
    schema: "successor.game-lab.battery-metrics.v1",
    battery,
    version: batteryVersions[battery],
    startedAt,
    completedAt: new Date().toISOString(),
    verdict: "fail",
    failures: [message],
  });
}

function copyMovementArtifacts(metrics, shotsDir) {
  for (const scenario of metrics.scenarios ?? []) {
    const targetDir = path.join(shotsDir, safeName(scenario.id ?? "scenario"));
    fs.mkdirSync(targetDir, { recursive: true });
    for (const shot of scenario.screenshots ?? []) {
      if (typeof shot !== "string" || !fs.existsSync(shot)) continue;
      fs.copyFileSync(shot, path.join(targetDir, path.basename(shot)));
    }
  }
}

async function waitForTarget(port, actorId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let oracle = null;
  while (Date.now() < deadline) {
    oracle = await fetchJson(port, "/game/debug/oracle?freshAiDebug=1");
    const target = pickLiveTarget(oracle, actorId, null);
    if (oracle.actors[actorId] && target) return { oracle, target };
    await delay(350);
  }
  return { oracle: oracle ?? await fetchJson(port, "/game/debug/oracle"), target: oracle ? pickLiveTarget(oracle, actorId, null) : null };
}

function pickLiveTarget(oracle, actorId, preferredId) {
  const me = oracle.actors[actorId];
  if (!me) return null;
  if (preferredId && isGaiaCreature(oracle.actors[preferredId]) && oracle.actors[preferredId]?.lifeState === "alive") return oracle.actors[preferredId];
  let best = null;
  let bestDistance = Infinity;
  for (const target of Object.values(oracle.actors ?? {})) {
    if (!target || target.id === actorId || target.lifeState !== "alive" || target.areaId !== me.areaId) continue;
    if (!isGaiaCreature(target)) continue;
    const d = distance(me, target);
    if (d < bestDistance) {
      best = target;
      bestDistance = d;
    }
  }
  return best;
}

function isGaiaCreature(target) {
  return target?.role === "creature"
    && (target.factionId === "gaia" || String(target.sprite ?? "").startsWith("creature-"));
}

function pickCombatSpawn() {
  const slice = JSON.parse(fs.readFileSync(slicePath, "utf8"));
  const zone = (slice.spawnZones ?? []).find((entry) => entry.templateId === "open-desert-bellback" && entry.areaId === "open-desert-overworld");
  const cell = zone?.candidateCells?.[0] ?? { x: 193, y: 97 };
  return {
    zoneId: zone?.id ?? "open-desert-bellback-zone-01",
    targetCell: { x: cell.x, y: cell.y },
    playerX: Math.max(1, cell.x - 3),
    playerY: cell.y,
  };
}

function stepToward(me, target) {
  const dx = Math.sign(Math.round(target.x - me.x));
  const dy = Math.sign(Math.round(target.y - me.y));
  const stepX = Math.max(-1, Math.min(1, dx));
  const stepY = Math.max(-1, Math.min(1, dy));
  let facing = "Right";
  if (Math.abs(stepY) > Math.abs(stepX)) facing = stepY > 0 ? "Front" : "Back";
  else if (stepX < 0) facing = "Left";
  else if (stepX > 0) facing = "Right";
  return { dx: stepX, dy: stepY, facing };
}

async function postDebugCommand(port, actorId, command) {
  return postJson(port, "/game/debug/authority-command", { actorId, command });
}

async function releaseAll(page) {
  for (const key of releaseKeys) await page.keyboard.up(key).catch(() => {});
  await page.mouse.up().catch(() => {});
}

function postJson(port, requestPath, payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = http.request({
      hostname: "127.0.0.1",
      port,
      path: requestPath,
      method: "POST",
      timeout: 8_000,
      headers: {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(body),
      },
    }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { text += chunk; });
      res.on("end", () => {
        try {
          const parsed = text ? JSON.parse(text) : null;
          if ((res.statusCode ?? 500) >= 400) reject(new Error(`HTTP ${res.statusCode}: ${text}`));
          else resolve(parsed);
        } catch (error) {
          reject(error);
        }
      });
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

function fetchJson(port, requestPath) {
  return new Promise((resolve, reject) => {
    const req = http.get({ hostname: "127.0.0.1", port, path: requestPath, timeout: 8_000 }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { text += chunk; });
      res.on("end", () => {
        try {
          if ((res.statusCode ?? 500) >= 400) reject(new Error(`HTTP ${res.statusCode}: ${text}`));
          else resolve(JSON.parse(text));
        } catch (error) {
          reject(error);
        }
      });
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
  });
}

function isHttpReachable(port, requestPath) {
  return new Promise((resolve) => {
    const req = http.get({ hostname: "127.0.0.1", port, path: requestPath, timeout: 1_500 }, (res) => {
      res.resume();
      resolve((res.statusCode ?? 500) < 500);
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", () => resolve(false));
  });
}

function pickFreePort(startPort) {
  return new Promise((resolve, reject) => {
    const tryPort = (port) => {
      if (port > 65535) {
        reject(new Error(`no free port >= ${startPort}`));
        return;
      }
      if (forbiddenPorts.has(port)) {
        tryPort(port + 1);
        return;
      }
      const server = net.createServer();
      server.once("error", () => tryPort(port + 1));
      server.once("listening", () => {
        server.close(() => resolve(port));
      });
      server.listen(port, "127.0.0.1");
    };
    tryPort(startPort);
  });
}

function parseRunArgs(args) {
  const options = { batteries: [], port: null, vitePort: null, runId: null, keepServer: false };
  for (const arg of args) {
    if (arg.startsWith("--port=")) options.port = parseInteger(arg.slice("--port=".length), "port");
    else if (arg.startsWith("--vite-port=")) options.vitePort = parseInteger(arg.slice("--vite-port=".length), "vite-port");
    else if (arg.startsWith("--run-id=")) options.runId = safeName(arg.slice("--run-id=".length));
    else if (arg === "--keep-server") options.keepServer = true;
    else if (arg.startsWith("--")) throw new Error(`unknown option ${arg}`);
    else {
      if (!batteryVersions[arg]) throw new Error(`unknown battery ${arg}; expected ${defaultBatteries.join(", ")}`);
      options.batteries.push(arg);
    }
  }
  if (options.port !== null) guardLabPort(options.port);
  return options;
}

function parseInteger(raw, label) {
  const value = Number(raw);
  if (!Number.isInteger(value)) throw new Error(`${label} must be an integer, got ${raw}`);
  return value;
}

function guardLabPort(port) {
  if (!Number.isInteger(port) || port < 18093 || port > 65535 || forbiddenPorts.has(port)) {
    throw new Error(`Game Lab refuses port ${port}; use an isolated backend port >=18093 outside the standing authority and client ports.`);
  }
}

function resolveGitRev() {
  const gitDir = path.join(repoRoot, ".git");
  const headPath = path.join(gitDir, "HEAD");
  const head = fs.readFileSync(headPath, "utf8").trim();
  if (!head.startsWith("ref:")) return head;
  const ref = head.slice(4).trim();
  const looseRefPath = path.join(gitDir, ref);
  if (fs.existsSync(looseRefPath)) return fs.readFileSync(looseRefPath, "utf8").trim();
  const packedRefsPath = path.join(gitDir, "packed-refs");
  if (fs.existsSync(packedRefsPath)) {
    for (const line of fs.readFileSync(packedRefsPath, "utf8").split(/\r?\n/u)) {
      if (line.startsWith("#") || line.startsWith("^")) continue;
      const [sha, packedRef] = line.trim().split(/\s+/u);
      if (packedRef === ref) return sha;
    }
  }
  return `${head} (unresolved)`;
}

function readSliceStateHash() {
  return JSON.parse(fs.readFileSync(slicePath, "utf8")).stateHash ?? null;
}

function writeManifest(runDir, manifest) {
  fs.mkdirSync(runDir, { recursive: true });
  writeJson(path.join(runDir, "manifest.json"), manifest);
}

function loadBrowserDriver() {
  const candidates = [
    { label: "client-3d", pkg: path.join(repoRoot, "client-3d", "package.json") },
    { label: "repo-root", pkg: path.join(repoRoot, "package.json") },
    { label: "client", pkg: path.join(repoRoot, "client", "package.json") },
  ];
  const failures = [];
  for (const candidate of candidates) {
    const require = createRequire(candidate.pkg);
    for (const specifier of ["@playwright/test", "playwright"]) {
      try {
        const resolvedPath = require.resolve(specifier);
        const mod = require(specifier);
        if (mod.chromium) {
          return { chromium: mod.chromium, driver: { name: "playwright", module: specifier, resolvedFrom: candidate.label, resolvedPath } };
        }
        failures.push(`${candidate.label}:${specifier}: chromium missing`);
      } catch (error) {
        failures.push(`${candidate.label}:${specifier}: ${error.message}`);
      }
    }
  }
  throw new Error(`No Playwright chromium driver available (${failures.join("; ")})`);
}

function loadRunMetrics(runDir) {
  const manifest = JSON.parse(fs.readFileSync(path.join(runDir, "manifest.json"), "utf8"));
  const values = {};
  for (const battery of Object.keys(batteryVersions)) {
    const metricsPath = path.join(runDir, battery, "metrics.json");
    if (!fs.existsSync(metricsPath)) continue;
    flattenNumbers(`${battery}`, JSON.parse(fs.readFileSync(metricsPath, "utf8")), values);
  }
  return { runId: manifest.runId ?? path.basename(runDir), values };
}

function flattenNumbers(prefix, value, out) {
  if (typeof value === "number" && Number.isFinite(value)) {
    out[prefix] = value;
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => flattenNumbers(`${prefix}[${index}]`, entry, out));
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) flattenNumbers(`${prefix}.${key}`, entry, out);
  }
}

function resolveRunDir(value) {
  const direct = path.resolve(value);
  if (fs.existsSync(path.join(direct, "manifest.json"))) return direct;
  const archived = path.join(runsRoot, safeName(value));
  if (fs.existsSync(path.join(archived, "manifest.json"))) return archived;
  throw new Error(`run not found: ${value}`);
}

function writeMovementClientTrace(metrics, outPath) {
  const rows = [];
  for (const scenario of metrics.scenarios ?? []) {
    for (const event of scenario.clientMoveTrace ?? []) rows.push({ scenarioId: scenario.id ?? null, ...event });
  }
  writeJsonl(outPath, rows);
  return rows.length;
}

function relativeFiles(root, dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push(path.relative(root, full));
    }
  };
  walk(dir);
  out.sort();
  return out;
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function writeJsonl(file, rows) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, rows.length > 0 ? `${rows.map((row) => JSON.stringify(row)).join("\n")}\n` : "", "utf8");
}

function appendJsonl(file, rows) {
  if (rows.length === 0) return;
  fs.appendFileSync(file, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");
}

function printRunSummary(manifest) {
  console.log(`run ${manifest.runId} ${manifest.status}`);
  console.log(`dir ${path.join(runsRoot, safeName(manifest.runId))}`);
  console.table(Object.entries(manifest.verdicts).map(([battery, verdict]) => ({ battery, verdict })));
  if (manifest.failures.length > 0) console.log(`failures: ${manifest.failures.join(" | ")}`);
}

function printUsage() {
  console.log(`Usage:
  node tools/game-lab/lab.mjs run [movement] [fx-smoke] [combat-smoke] [ui-smoke] [--port=18093] [--run-id=id]
  node tools/game-lab/lab.mjs compare <runA> <runB>
  node tools/game-lab/lab.mjs list`);
}

function stopScratchUnit(unitService, logsDir) {
  const result = spawnSync("systemctl", ["--user", "stop", unitService], { cwd: repoRoot, encoding: "utf8" });
  fs.writeFileSync(path.join(logsDir, "stop-server.log"), `${result.stdout ?? ""}${result.stderr ?? ""}`, "utf8");
}

function stopProcess(child) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
}

function safeName(value) {
  return String(value).replace(/[^a-zA-Z0-9_.-]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 96) || "run";
}

function labActorId(runId, suffix) {
  return `game-lab-${safeName(runId).toLowerCase()}-${safeName(suffix).toLowerCase()}`.slice(0, 96);
}

function stamp() {
  return new Date().toISOString().replace(/[-:]/gu, "").replace(/\.\d{3}Z$/u, "Z");
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function distance(a, b) {
  if (!a || !b) return Infinity;
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function compactOracleActor(actor) {
  if (!actor) return null;
  return {
    id: actor.id,
    role: actor.role ?? null,
    areaId: actor.areaId,
    x: round(actor.x),
    y: round(actor.y),
    lifeState: actor.lifeState,
    vitals: actor.vitals ?? null,
  };
}

function round(value) {
  return Math.round(value * 1000) / 1000;
}
