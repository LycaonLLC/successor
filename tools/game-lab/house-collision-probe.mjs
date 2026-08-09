#!/usr/bin/env node
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import process from "node:process";
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { deriveStructureDoorPoints, STRUCTURE_PLAYER_RADIUS_MILLI } from "../successor/structure-collision-geometry.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");
const runsRoot = path.join(repoRoot, ".game-lab", "runs");
const slicePath = path.join(repoRoot, "client", "public", "successor-slice", "open-desert-slice.json");
const housePropId = "dustgate-home-starter";
const playerRadiusCells = STRUCTURE_PLAYER_RADIUS_MILLI / 1000;
const sweptCircleSkinCells = 0.002;
const doorPassDepthCells = 0.4;
const doorExitDepthCells = 0.2;
const wallSpawnPaddingCells = 0.05;
const cornerSpawnPaddingCells = 0.1;
const cornerTangentPaddingCells = 0.3;
const wallTangentInsetCells = 0.5;
const houseProbe = loadHouseProbe(slicePath);
const forbiddenBackendPorts = new Set([28093, 18192, 5179]);
const viewport = { width: 1440, height: 960 };
const dataAttr = "data-house-collision-probe";
const releaseCodes = ["KeyW", "KeyA", "KeyS", "KeyD", "ShiftLeft"];
let bridgeSeq = 0;

const options = await parseArgs(process.argv.slice(2));
if (options.geometryOnly) {
  console.log(JSON.stringify({
    ok: true,
    slicePath: path.relative(repoRoot, slicePath),
    housePropId,
    probe: houseProbe,
  }, null, 2));
  process.exit(0);
}
const runId = safeName(options.runId ?? `house-collision-${stamp()}`);
const runDir = path.resolve(options.outDir ?? path.join(runsRoot, runId));
const logsDir = path.join(runDir, "logs");
const tracesDir = path.join(runDir, "traces");
const shotsDir = path.join(runDir, "shots");
fs.mkdirSync(logsDir, { recursive: true });
fs.mkdirSync(tracesDir, { recursive: true });
fs.mkdirSync(shotsDir, { recursive: true });

const port = options.port ?? await pickFreePort(18093, forbiddenBackendPorts);
if (forbiddenBackendPorts.has(port)) throw new Error(`refusing live backend port ${port}`);
const vitePort = options.vitePort ?? await pickFreePort(5180, new Set([port]));
const unitName = safeName(options.unit ?? `house-collision-${runId.slice(0, 32)}-${port}`);
const unitService = `${unitName}.service`;
const startedAt = new Date().toISOString();
const manifest = {
  schema: "successor.house-collision-probe.v1",
  runId,
  startedAt,
  completedAt: null,
  port,
  vitePort,
  unit: unitService,
  runDir,
  scenarios: [],
  artifacts: { logs: "logs", traces: "traces", shots: "shots" },
};
writeJson(path.join(runDir, "manifest.json"), manifest);

let vite = null;
try {
  const boot = bootIsolatedStack({ port, unitName, logsDir });
  manifest.server = { boot };
  writeJson(path.join(runDir, "manifest.json"), manifest);
  vite = await ensureVite(vitePort, logsDir);
  manifest.vite = { port: vitePort, spawned: Boolean(vite) };
  writeJson(path.join(runDir, "manifest.json"), manifest);

  const { chromium, driver } = loadBrowserDriver();
  manifest.browser = { driver };
  const browser = await chromium.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-background-timer-throttling",
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
      `--window-size=${viewport.width},${viewport.height}`,
    ],
    timeout: 30_000,
  });
  try {
    const context = await browser.newContext({ viewport, deviceScaleFactor: 1 });
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    page.setDefaultNavigationTimeout(45_000);
    const pageConsole = [];
    const pageErrors = [];
    page.on("console", (msg) => {
      if (msg.type() === "error" || msg.type() === "warning") pageConsole.push({ type: msg.type(), text: msg.text(), at: Date.now() });
    });
    page.on("pageerror", (error) => pageErrors.push({ message: error.stack ?? error.message, at: Date.now() }));

    for (const scenario of scenarios(runId)) {
      const result = await runScenario(page, scenario, { runId, port, vitePort });
      manifest.scenarios.push({
        id: result.id,
        verdict: result.verdict,
        failures: result.failures,
        metrics: result.metrics,
        screenshots: result.screenshots.map((shot) => path.relative(runDir, shot)),
      });
      writeJson(path.join(runDir, "manifest.json"), manifest);
    }

    manifest.pageConsole = pageConsole.slice(0, 80);
    manifest.pageErrors = pageErrors;
    await browser.close();
  } finally {
    await browser.close().catch(() => {});
  }

  const serverTrace = collectServerMoveTrace({ unit: unitService, sinceIso: startedAt, outPath: path.join(tracesDir, "server-move-trace.jsonl") });
  manifest.serverTrace = serverTrace;
  manifest.completedAt = new Date().toISOString();
  manifest.status = manifest.scenarios.every((scenario) => scenario.verdict === "pass") && !manifest.pageErrors?.length ? "pass" : "fail";
  writeJson(path.join(runDir, "manifest.json"), manifest);
  printSummary(manifest);
  if (manifest.status !== "pass") process.exitCode = 1;
} finally {
  if (!options.keepServer) stopScratchUnit(unitService, logsDir);
  if (vite) stopProcess(vite);
}

function scenarios(runId) {
  return [
    {
      id: "closed-door-ram",
      label: "closed door accepts+clamps and leaves pawn mobile",
      actor: `${runId}-closed-door`.slice(0, 96),
      spawn: houseProbe.exterior,
      resetBefore: true,
      steps: [
        { kind: "hold", keys: houseProbe.enterKeys, ms: 2200, label: "ram into closed door" },
        { kind: "hold", keys: houseProbe.exitKeys, ms: 650, label: "back away after clamp" },
      ],
      checks: [closedDoorCheck, postClampMobilityCheck],
    },
    {
      id: "door-open-center-pass",
      label: "F opens door and centered sprint enters shelter",
      actor: `${runId}-door-pass`.slice(0, 96),
      spawn: houseProbe.exterior,
      resetBefore: true,
      steps: [
        { kind: "press", key: "KeyF", ms: 450, label: "toggle door open" },
        { kind: "hold", keys: houseProbe.enterKeys, ms: 2200, label: "pass through door" },
      ],
      checks: [doorOpenedCheck, doorPassCheck],
    },
    {
      id: "door-left-jamb-brush",
      label: "left-of-center doorway brush should glide through instead of sill-stalling",
      actor: `${runId}-left-jamb`.slice(0, 96),
      spawn: houseProbe.leftJambExterior,
      resetBefore: true,
      steps: [
        { kind: "press", key: "KeyF", ms: 450, label: "toggle door open" },
        { kind: "hold", keys: houseProbe.enterKeys, ms: 2600, label: "through left brush" },
      ],
      checks: [doorOpenedCheck, doorPassCheck],
    },
    {
      id: "door-right-jamb-brush",
      label: "right-of-center doorway brush should glide through instead of sill-stalling",
      actor: `${runId}-right-jamb`.slice(0, 96),
      spawn: houseProbe.rightJambExterior,
      resetBefore: true,
      steps: [
        { kind: "press", key: "KeyF", ms: 450, label: "toggle door open" },
        { kind: "hold", keys: houseProbe.enterKeys, ms: 2600, label: "through right brush" },
      ],
      checks: [doorOpenedCheck, doorPassCheck],
    },
    {
      id: "door-sprint-exit-center",
      label: "F opens door from interior and centered sprint exits shelter",
      actor: `${runId}-door-exit`.slice(0, 96),
      spawn: houseProbe.interior,
      resetBefore: true,
      steps: [
        { kind: "press", key: "KeyF", ms: 450, label: "toggle door open from interior" },
        { kind: "hold", keys: houseProbe.exitKeys, ms: 2200, label: "pass out through door" },
      ],
      checks: [doorOpenedCheck, doorExitCheck],
    },
    {
      id: "door-close-mid-transit",
      label: "closing the door mid-transit does not wedge or pop the pawn",
      actor: `${runId}-door-close-mid`.slice(0, 96),
      spawn: houseProbe.exterior,
      resetBefore: true,
      steps: [
        { kind: "press", key: "KeyF", ms: 450, label: "toggle door open" },
        { kind: "holdPress", keys: houseProbe.enterKeys, beforePressMs: 780, pressKey: "KeyF", afterPressMs: 1500, label: "sprint in and close while crossing" },
      ],
      checks: [doorCloseMidTransitCheck],
    },
    {
      id: "back-wall-diagonal-slide",
      label: "diagonal charge into back wall slides along the face without overlap",
      actor: `${runId}-back-slide`.slice(0, 96),
      spawn: houseProbe.wallSlideSpawn,
      resetBefore: true,
      steps: [
        { kind: "hold", keys: houseProbe.wallSlideKeys, ms: 650, label: "diagonal into back wall" },
      ],
      checks: [wallSlideCheck],
    },
    {
      id: "exterior-back-corner-glide",
      label: "outside back corner charge glides instead of snagging",
      actor: `${runId}-corner`.slice(0, 96),
      spawn: houseProbe.cornerGlideSpawn,
      resetBefore: true,
      steps: [
        { kind: "hold", keys: houseProbe.cornerGlideKeys, ms: 1250, label: "glide around exterior corner" },
      ],
      checks: [cornerGlideCheck],
    },
  ];
}

function loadHouseProbe(file) {
  const slice = JSON.parse(fs.readFileSync(file, "utf8"));
  const prop = slice.props?.find((candidate) => candidate.id === housePropId);
  if (!prop?.door?.blocker || !Array.isArray(prop.collisionBounds) || prop.collisionBounds.length === 0) {
    throw new Error(`${file}: generated ${housePropId} collision data missing`);
  }
  const points = deriveStructureDoorPoints({ walls: prop.collisionBounds, door: prop.door.blocker, cellSize: prop.size });
  const normalKey = points.normalAxis === "x" ? "x" : "y";
  const tangentKey = points.tangentAxis === "x" ? "x" : "y";
  const tangentMilliKey = points.tangentAxis === "x" ? "xMilli" : "yMilli";
  const base = { x: Number(prop.cell.x), y: Number(prop.cell.y) };
  const toWorldPoint = (point) => ({ x: round(base.x + point.xMilli / 1000), y: round(base.y + point.yMilli / 1000) });
  const pointOnAxes = (normal, tangent) => {
    const point = { x: 0, y: 0 };
    point[normalKey] = round(base[normalKey] + normal);
    point[tangentKey] = round(base[tangentKey] + tangent);
    return point;
  };
  const face = (box, axis, sign) => {
    const origin = axis === "x" ? box.xMilli : box.yMilli;
    const size = axis === "x" ? box.wMilli : box.hMilli;
    return (origin + (sign > 0 ? size : 0)) / 1000;
  };
  const tangentExtent = points.tangentAxis === "x" ? prop.door.blocker.wMilli : prop.door.blocker.hMilli;
  const jambOffset = Math.max(0, tangentExtent / 2000 - playerRadiusCells * 0.7);
  const exterior = toWorldPoint(points.exterior);
  const interior = toWorldPoint(points.interior);
  const exteriorNormal = exterior[normalKey];
  const doorTangent = base[tangentKey] + points.doorCenter[tangentMilliKey] / 1000;
  const backWall = points.interiorWall;
  const backWallOutside = face(backWall, points.normalAxis, -points.outwardSign);
  const backWallTangentMin = face(backWall, points.tangentAxis, -1);
  const backWallTangentMax = face(backWall, points.tangentAxis, 1);
  const wallSlideSpawn = pointOnAxes(backWallOutside - points.outwardSign * (playerRadiusCells + wallSpawnPaddingCells), backWallTangentMin + wallTangentInsetCells);
  const cornerGlideSpawn = pointOnAxes(backWallOutside - points.outwardSign * (playerRadiusCells + cornerSpawnPaddingCells), backWallTangentMin - playerRadiusCells - cornerTangentPaddingCells);
  const outward = points.normalAxis === "x" ? { x: points.outwardSign, y: 0 } : { x: 0, y: points.outwardSign };
  const tangent = points.tangentAxis === "x" ? { x: 1, y: 0 } : { x: 0, y: 1 };
  const doorOutwardFace = face(prop.door.blocker, points.normalAxis, points.outwardSign);
  const doorInwardFace = face(prop.door.blocker, points.normalAxis, -points.outwardSign);
  return {
    exterior,
    interior,
    leftJambExterior: pointOnAxes(exteriorNormal - base[normalKey], doorTangent - base[tangentKey] - jambOffset),
    rightJambExterior: pointOnAxes(exteriorNormal - base[normalKey], doorTangent - base[tangentKey] + jambOffset),
    wallSlideSpawn,
    cornerGlideSpawn,
    enterKeys: keysForWorldVector(-outward.x, -outward.y),
    exitKeys: keysForWorldVector(outward.x, outward.y),
    wallSlideKeys: keysForWorldVector(outward.x + tangent.x, outward.y + tangent.y),
    cornerGlideKeys: keysForWorldVector(tangent.x, tangent.y),
    normalKey,
    tangentKey,
    outwardSign: points.outwardSign,
    closedDoorClampNormal: base[normalKey] + doorOutwardFace + points.outwardSign * (playerRadiusCells + sweptCircleSkinCells),
    interiorPassNormal: base[normalKey] + doorInwardFace - points.outwardSign * doorPassDepthCells,
    exteriorPassNormal: base[normalKey] + doorOutwardFace + points.outwardSign * doorExitDepthCells,
    backWallContactNormal: base[normalKey] + backWallOutside - points.outwardSign * (playerRadiusCells + sweptCircleSkinCells),
    backWallTangentMin: base[tangentKey] + backWallTangentMin,
    backWallTangentMax: base[tangentKey] + backWallTangentMax,
  };
}

function keysForWorldVector(x, y) {
  const screenX = x - y;
  const screenY = x + y;
  const keys = [];
  if (screenX < 0) keys.push("KeyA");
  else if (screenX > 0) keys.push("KeyD");
  if (screenY < 0) keys.push("KeyW");
  else if (screenY > 0) keys.push("KeyS");
  if (keys.length === 0) throw new Error("house probe movement vector is zero");
  return keys;
}

async function runScenario(page, scenario, ctx) {
  if (scenario.resetBefore) {
    await postJson(ctx.port, "/game/debug/reset-fixture", {}).catch(() => null);
    await delay(500);
  }
  const dir = path.join(runDir, scenario.id);
  const shotDir = path.join(shotsDir, scenario.id);
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(shotDir, { recursive: true });
  const url = runtimeUrl({ ...ctx, actor: scenario.actor, spawn: scenario.spawn });
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await armPage(page);
  await page.screenshot({ path: path.join(shotDir, "00-start.png"), fullPage: false });

  const samples = [];
  const keyEvents = [];
  let done = false;
  const sampler = (async () => {
    while (!done) {
      const probe = await readProbe(page).catch(() => null);
      if (probe) samples.push({ atMs: Date.now(), ...compactProbe(probe) });
      await delay(55);
    }
  })();

  const screenshots = [path.join(shotDir, "00-start.png")];
  try {
    for (const [index, step] of scenario.steps.entries()) {
      await page.bringToFront();
      if (step.kind === "press") {
        await page.keyboard.press(keyboardKeyForCode(step.key));
        keyEvents.push({ type: "press", key: step.key, label: step.label, atMs: Date.now() });
        await delay(step.ms ?? 250);
      } else if (step.kind === "hold") {
        await dispatchKeyCodes(page, "keydown", step.keys);
        const downAt = Date.now();
        for (const key of step.keys) {
          keyEvents.push({ type: "down", key, label: step.label, atMs: downAt });
        }
        await delay(step.ms);
        await dispatchKeyCodes(page, "keyup", [...step.keys].reverse());
        const upAt = Date.now();
        for (const key of [...step.keys].reverse()) {
          keyEvents.push({ type: "up", key, label: step.label, atMs: upAt });
        }
        await delay(180);
      } else if (step.kind === "holdPress") {
        await dispatchKeyCodes(page, "keydown", step.keys);
        const downAt = Date.now();
        for (const key of step.keys) {
          keyEvents.push({ type: "down", key, label: step.label, atMs: downAt });
        }
        await delay(step.beforePressMs);
        await page.keyboard.press(keyboardKeyForCode(step.pressKey));
        keyEvents.push({ type: "press", key: step.pressKey, label: step.label, atMs: Date.now() });
        await delay(step.afterPressMs);
        await dispatchKeyCodes(page, "keyup", [...step.keys].reverse());
        const upAt = Date.now();
        for (const key of [...step.keys].reverse()) {
          keyEvents.push({ type: "up", key, label: step.label, atMs: upAt });
        }
        await delay(180);
      }
      const shot = path.join(shotDir, `${String(index + 1).padStart(2, "0")}-${safeName(step.label)}.png`);
      await page.screenshot({ path: shot, fullPage: false });
      screenshots.push(shot);
    }
  } finally {
    done = true;
    await sampler;
    await releaseAll(page);
  }
  await delay(250);
  const finalProbe = await readProbe(page).catch(() => null);
  if (finalProbe) samples.push({ atMs: Date.now(), ...compactProbe(finalProbe) });
  const clientMoveTrace = await mainWorld(page, `window.__successorMoveTrace?.drain?.() ?? []`).catch((error) => [{ kind: "drain-error", error: error.message }]);
  const clientGameTrace = await mainWorld(page, `window.__successorGameTrace?.drain?.() ?? []`).catch((error) => [{ kind: "drain-error", error: error.message }]);
  const metrics = deriveMetrics(samples, scenario.spawn);
  const failures = [];
  for (const check of scenario.checks) check({ scenario, samples, keyEvents, metrics, finalProbe, failures });
  const result = {
    schema: "successor.house-collision-scenario.v1",
    id: scenario.id,
    label: scenario.label,
    actor: scenario.actor,
    spawn: scenario.spawn,
    runtimeUrl: url,
    verdict: failures.length === 0 ? "pass" : "fail",
    failures,
    metrics,
    keyEvents,
    samples,
    screenshots,
    clientMoveTraceCount: clientMoveTrace.length,
    clientGameTraceCount: clientGameTrace.length,
  };
  writeJson(path.join(dir, "metrics.json"), result);
  writeJsonl(path.join(dir, "client-move-trace.jsonl"), clientMoveTrace);
  writeJsonl(path.join(dir, "client-game-trace.jsonl"), clientGameTrace);
  return result;
}

function deriveMetrics(samples, spawn) {
  const positions = samples.filter((sample) => sample.playerCell);
  let distance = 0;
  let maxPredictionError = 0;
  let stallMs = 0;
  let longestStallMs = 0;
  let currentStallMs = 0;
  for (let i = 0; i < positions.length; i += 1) {
    const sample = positions[i];
    maxPredictionError = Math.max(maxPredictionError, sample.predictionErrorCells ?? 0);
    if (i === 0) continue;
    const prev = positions[i - 1];
    const dt = Math.max(0, sample.atMs - prev.atMs);
    const dx = sample.playerCell.x - prev.playerCell.x;
    const dy = sample.playerCell.y - prev.playerCell.y;
    const moved = Math.hypot(dx, dy);
    distance += moved;
    const moving = prev.moveGate?.moving === true;
    if (moving && moved <= 0.01) {
      stallMs += dt;
      currentStallMs += dt;
      longestStallMs = Math.max(longestStallMs, currentStallMs);
    } else {
      currentStallMs = 0;
    }
  }
  const first = positions[0] ?? null;
  const last = positions.at(-1) ?? null;
  return {
    first: first?.playerCell ?? null,
    last: last?.playerCell ?? null,
    deltaFromSpawn: last ? roundPoint({ x: last.playerCell.x - spawn.x, y: last.playerCell.y - spawn.y }) : null,
    distance: round(distance),
    maxPredictionError: round(maxPredictionError),
    stallMs: Math.round(stallMs),
    longestStallMs: Math.round(longestStallMs),
    acceptedDelta: last && first ? Math.max(0, (last.acceptedCommands ?? 0) - (first.acceptedCommands ?? 0)) : 0,
    rejectedDelta: last && first ? Math.max(0, (last.rejectedCommands ?? 0) - (first.rejectedCommands ?? 0)) : 0,
    finalDoorOpen: last?.doorOpen ?? null,
    finalSheltered: last?.sheltered ?? null,
    finalMoveGate: last?.moveGate ?? null,
  };
}

function closedDoorCheck({ samples, keyEvents, metrics, failures }) {
  const ramEndAt = keyEvents.find((event) => event.type === "up" && event.label === "ram into closed door")?.atMs ?? Number.POSITIVE_INFINITY;
  const ramSamples = samples.filter((sample) => sample.playerCell && sample.atMs <= ramEndAt);
  const clamped = ramSamples.at(-1)?.playerCell ?? null;
  metrics.closedDoorOffsetMilli = clamped
    ? Math.round((clamped[houseProbe.normalKey] - houseProbe.closedDoorClampNormal) * 1000)
    : null;
  if (!clamped || Math.abs(metrics.closedDoorOffsetMilli) > 70) failures.push(`closed door did not clamp at visual face + radius/skin: ${JSON.stringify(clamped)} offsetMilli=${metrics.closedDoorOffsetMilli}`);
  if (metrics.rejectedDelta !== 0) failures.push(`closed-door ram rejected ${metrics.rejectedDelta} move(s); expected accepted-and-clamped`);
}

function postClampMobilityCheck({ metrics, failures }) {
  const outwardDelta = metrics.deltaFromSpawn?.[houseProbe.normalKey] * houseProbe.outwardSign;
  if (!Number.isFinite(outwardDelta) || outwardDelta < -0.15) failures.push(`post-clamp back-away mobility too low: delta ${JSON.stringify(metrics.deltaFromSpawn)}`);
}

function doorOpenedCheck({ metrics, failures }) {
  if (metrics.finalDoorOpen !== true) failures.push(`door did not report open; finalDoorOpen=${metrics.finalDoorOpen}`);
}

function doorPassCheck({ metrics, failures }) {
  const interiorOffset = metrics.last
    ? (metrics.last[houseProbe.normalKey] - houseProbe.interiorPassNormal) * houseProbe.outwardSign
    : Number.POSITIVE_INFINITY;
  if (interiorOffset > 0) failures.push(`door pass did not reach interior/shelter side: final ${JSON.stringify(metrics.last)}`);
  if (metrics.finalSheltered !== true) failures.push(`door pass did not end sheltered; finalSheltered=${metrics.finalSheltered}`);
  if (metrics.rejectedDelta !== 0) failures.push(`door pass rejected ${metrics.rejectedDelta} move(s)`);
}
function doorExitCheck({ metrics, failures }) {
  const exteriorOffset = metrics.last
    ? (metrics.last[houseProbe.normalKey] - houseProbe.exteriorPassNormal) * houseProbe.outwardSign
    : Number.NEGATIVE_INFINITY;
  if (exteriorOffset < 0) failures.push(`door exit did not reach exterior side: final ${JSON.stringify(metrics.last)}`);
  if (metrics.finalSheltered !== false) failures.push(`door exit did not end unsheltered; finalSheltered=${metrics.finalSheltered}`);
  if (metrics.rejectedDelta !== 0) failures.push(`door exit rejected ${metrics.rejectedDelta} move(s)`);
}

function doorCloseMidTransitCheck({ metrics, failures }) {
  if (metrics.finalDoorOpen !== false) failures.push(`mid-transit close did not leave door closed; finalDoorOpen=${metrics.finalDoorOpen}`);
  const interiorOffset = metrics.last
    ? (metrics.last[houseProbe.normalKey] - houseProbe.interiorPassNormal) * houseProbe.outwardSign
    : Number.POSITIVE_INFINITY;
  if (interiorOffset > 0) failures.push(`mid-transit close did not leave pawn on safe interior side: final ${JSON.stringify(metrics.last)}`);
  if (metrics.finalSheltered !== true) failures.push(`mid-transit close should end sheltered inside; finalSheltered=${metrics.finalSheltered}`);
  if (metrics.rejectedDelta !== 0) failures.push(`mid-transit close rejected ${metrics.rejectedDelta} command(s)`);
}

function lowStallCheck({ metrics, failures }) {
  if (metrics.longestStallMs > 260) failures.push(`door brush stall too long: ${metrics.longestStallMs}ms`);
}

function wallSlideCheck({ scenario, metrics, failures }) {
  const tangentProgress = metrics.last ? metrics.last[houseProbe.tangentKey] - scenario.spawn[houseProbe.tangentKey] : Number.NEGATIVE_INFINITY;
  const contactError = metrics.last ? Math.abs(metrics.last[houseProbe.normalKey] - houseProbe.backWallContactNormal) : Number.POSITIVE_INFINITY;
  metrics.wallSlideTangentProgress = round(tangentProgress);
  metrics.wallSlideContactError = round(contactError);
  if (tangentProgress < 0.75 || metrics.last?.[houseProbe.tangentKey] > houseProbe.backWallTangentMax + 0.6) failures.push(`wall slide did not progress along the mesh-derived back wall: final ${JSON.stringify(metrics.last)}`);
  if (contactError > 0.2) failures.push(`wall slide left the mesh-derived wall contact lane: final ${JSON.stringify(metrics.last)} error=${round(contactError)}`);
  if (metrics.rejectedDelta !== 0) failures.push(`wall slide rejected ${metrics.rejectedDelta} move(s)`);
}

function cornerGlideCheck({ scenario, metrics, failures }) {
  const tangentProgress = metrics.last ? metrics.last[houseProbe.tangentKey] - scenario.spawn[houseProbe.tangentKey] : Number.NEGATIVE_INFINITY;
  const contactError = metrics.last ? Math.abs(metrics.last[houseProbe.normalKey] - houseProbe.backWallContactNormal) : Number.POSITIVE_INFINITY;
  metrics.cornerTangentProgress = round(tangentProgress);
  metrics.cornerContactError = round(contactError);
  if (tangentProgress < 1) failures.push(`corner glide did not progress around the mesh-derived back corner: final ${JSON.stringify(metrics.last)}`);
  if (contactError > 0.3) failures.push(`corner glide left the exterior wall lane: final ${JSON.stringify(metrics.last)} error=${round(contactError)}`);
  if (metrics.rejectedDelta !== 0) failures.push(`corner glide rejected ${metrics.rejectedDelta} move(s)`);
}

function lowPredictionErrorCheck({ metrics, failures }) {
  if (metrics.maxPredictionError > 0.1) failures.push(`prediction error too high: ${metrics.maxPredictionError}`);
}

function compactProbe(probe) {
  return {
    tick: probe.tick,
    playerCell: probe.playerCell ? roundPoint(probe.playerCell) : null,
    authorityPlayer: probe.authorityPlayer ? roundPoint({ x: probe.authorityPlayer.x, y: probe.authorityPlayer.y }) : null,
    predictionErrorCells: round(probe.predictionErrorCells ?? 0),
    acceptedCommands: probe.acceptedCommands ?? 0,
    rejectedCommands: probe.rejectedCommands ?? 0,
    sheltered: probe.weather?.sheltered ?? null,
    doorOpen: probe.doorStates?.[housePropId]?.doorOpen ?? null,
    interactions: (probe.interactions ?? []).map((item) => ({ id: item.id, kind: item.kind, targetId: item.targetId, distanceCells: item.distanceCells, doorOpen: item.doorOpen })),
    moveGate: probe.moveGate ? {
      moving: probe.moveGate.moving,
      inFlightMoves: probe.moveGate.inFlightMoves,
      pendingMoves: probe.moveGate.pendingMoves,
      predictionErrorCells: round(probe.moveGate.predictionErrorCells ?? 0),
      receiptTail: probe.moveGate.receiptTail,
    } : null,
  };
}

async function armPage(page) {
  await page.bringToFront();
  await page.waitForSelector("body", { timeout: 10_000 });
  await installProbeBridge(page);
  await waitForWorldReady(page);
  await releaseAll(page);
}

async function installProbeBridge(page) {
  await page.addScriptTag({
    content: `(() => {
      if (window.__houseCollisionProbeInterval) return;
      window.__houseCollisionProbeInterval = window.setInterval(() => {
        try { if (document.body) document.body.setAttribute(${JSON.stringify(dataAttr)}, JSON.stringify(window.__successor3d ?? null)); } catch {}
      }, 50);
    })();`,
  });
}

async function waitForWorldReady(page) {
  const deadline = Date.now() + 35_000;
  let last = null;
  while (Date.now() < deadline) {
    last = await readProbe(page).catch(() => null);
    if (last?.serverStatus === "connected" && last.authorityPlayer) return last;
    await delay(150);
  }
  throw new Error(`timed out waiting for connected probe; last=${JSON.stringify(last)}`);
}

async function readProbe(page) {
  const raw = await page.evaluate((attr) => document.body?.getAttribute(attr) ?? null, dataAttr);
  return raw ? JSON.parse(raw) : null;
}

async function mainWorld(page, expression, timeoutMs = 8_000) {
  bridgeSeq += 1;
  const attr = `data-house-collision-call-${Date.now()}-${bridgeSeq}`;
  await page.addScriptTag({
    content: `(() => {
      const attr = ${JSON.stringify(attr)};
      try { document.body.setAttribute(attr, JSON.stringify({ ok: true, value: (${expression}) })); }
      catch (error) { document.body.setAttribute(attr, JSON.stringify({ ok: false, error: error && (error.stack || error.message) || String(error) })); }
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

function runtimeUrl({ vitePort, port, actor, spawn }) {
  const url = new URL(`http://127.0.0.1:${vitePort}/`);
  url.searchParams.set("gamePort", String(port));
  url.searchParams.set("authority", "server");
  url.searchParams.set("player", actor);
  url.searchParams.set("actorId", actor);
  url.searchParams.set("name", actor);
  url.searchParams.set("autoEnter", "1");
  url.searchParams.set("equip", "slugthrower");
  url.searchParams.set("spawnArea", "open-desert-overworld");
  url.searchParams.set("spawnX", String(spawn.x));
  url.searchParams.set("spawnY", String(spawn.y));
  url.searchParams.set("facing", "right");
  url.searchParams.set("slicePath", "/successor-slice/open-desert-slice.json");
  url.searchParams.set("mapBundlePath", "/successor-slice/open-desert-map-bundle.json");
  url.searchParams.set("gameTrace", "1");
  url.searchParams.set("moveTrace", "1");
  return url.toString();
}

function bootIsolatedStack({ port, unitName, logsDir }) {
  const logPath = path.join(logsDir, "open-desert-boot.log");
  const env = { ...process.env, OPEN_DESERT_PORT: String(port), OPEN_DESERT_UNIT: unitName, GAME_MOVE_TRACE: "1" };
  const result = spawnSync(process.execPath, ["tools/successor/serve-open-desert-fixture.mjs"], { cwd: repoRoot, env, encoding: "utf8", timeout: 240_000 });
  fs.writeFileSync(logPath, `${result.stdout ?? ""}${result.stderr ?? ""}`, "utf8");
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`serve-open-desert-fixture exited ${result.status}; see ${logPath}`);
  return JSON.parse(result.stdout.slice(result.stdout.indexOf("{")));
}

async function ensureVite(vitePort, logsDir) {
  if (await isHttpReachable(vitePort, "/")) return null;
  const out = fs.openSync(path.join(logsDir, "vite.log"), "a");
  const child = spawn("pnpm", ["--dir", "client-3d", "exec", "vite", "--host", "127.0.0.1", "--port", String(vitePort)], { cwd: repoRoot, env: { ...process.env, HOUSE_COLLISION_PROBE: "1" }, stdio: ["ignore", out, out] });
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (await isHttpReachable(vitePort, "/")) return child;
    if (child.exitCode !== null) throw new Error(`vite exited ${child.exitCode}; see ${path.join(logsDir, "vite.log")}`);
    await delay(400);
  }
  throw new Error(`timed out waiting for vite on ${vitePort}`);
}

function collectServerMoveTrace({ unit, sinceIso, outPath }) {
  const result = spawnSync("journalctl", ["--user", "-u", unit, "-o", "cat", "--since", sinceIso], { cwd: repoRoot, encoding: "utf8", timeout: 20_000 });
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
    } catch {}
  }
  writeJsonl(outPath, lines.map((line) => JSON.parse(line)));
  return { path: outPath, lineCount: lines.length, error: errors.join("; ") || null };
}

async function postJson(port, requestPath, payload) {
  const body = JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: "127.0.0.1", port, path: requestPath, method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) }, timeout: 5_000 }, (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => {
        try { resolve(data ? JSON.parse(data) : {}); } catch (error) { reject(error); }
      });
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    req.end(body);
  });
}

function isHttpReachable(port, requestPath) {
  return new Promise((resolve) => {
    const req = http.get({ hostname: "127.0.0.1", port, path: requestPath, timeout: 700 }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode !== undefined && res.statusCode < 500));
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", () => resolve(false));
  });
}

function pickFreePort(startPort, forbidden) {
  return new Promise((resolve, reject) => {
    const tryPort = (candidate) => {
      if (candidate > 65535) return reject(new Error(`no free port >= ${startPort}`));
      if (forbidden.has(candidate)) return tryPort(candidate + 1);
      const server = net.createServer();
      server.once("error", () => tryPort(candidate + 1));
      server.once("listening", () => server.close(() => resolve(candidate)));
      server.listen(candidate, "127.0.0.1");
    };
    tryPort(startPort);
  });
}

function loadBrowserDriver() {
  const candidates = [
    { label: "client-3d", pkg: path.join(repoRoot, "client-3d", "package.json") },
    { label: "repo-root", pkg: path.join(repoRoot, "package.json") },
    { label: "client", pkg: path.join(repoRoot, "client", "package.json") },
  ];
  const failures = [];
  for (const candidate of candidates) {
    const req = createRequire(candidate.pkg);
    for (const moduleName of ["@playwright/test", "playwright"]) {
      try {
        const resolvedPath = req.resolve(moduleName);
        const mod = req(moduleName);
        if (mod.chromium) return { chromium: mod.chromium, driver: { name: "playwright", module: moduleName, resolvedFrom: candidate.label, resolvedPath } };
      } catch (error) {
        failures.push(`${candidate.label}:${moduleName}:${error.message}`);
      }
    }
  }
  throw new Error(`No Playwright chromium driver available (${failures.join("; ")})`);
}

async function releaseAll(page) {
  await dispatchKeyCodes(page, "keyup", releaseCodes).catch(() => {});
  for (const key of releaseCodes) await page.keyboard.up(keyboardKeyForCode(key)).catch(() => {});
}

async function dispatchKeyCodes(page, type, codes) {
  const events = codes.map((code) => ({ code, key: keyboardKeyForCode(code) }));
  await page.evaluate(({ eventType, keyEvents }) => {
    for (const event of keyEvents) {
      window.dispatchEvent(new KeyboardEvent(eventType, { code: event.code, key: event.key, bubbles: true, cancelable: true }));
    }
  }, { eventType: type, keyEvents: events });
}

function keyboardKeyForCode(code) {
  if (code === "KeyW") return "w";
  if (code === "KeyA") return "a";
  if (code === "KeyS") return "s";
  if (code === "KeyD") return "d";
  if (code === "KeyF") return "f";
  if (code === "ShiftLeft") return "Shift";
  return code;
}

async function parseArgs(args) {
  const out = { keepServer: false };
  for (const arg of args) {
    if (arg.startsWith("--port=")) out.port = parseIntArg(arg, "--port=");
    else if (arg.startsWith("--vite-port=")) out.vitePort = parseIntArg(arg, "--vite-port=");
    else if (arg.startsWith("--run-id=")) out.runId = arg.slice("--run-id=".length);
    else if (arg.startsWith("--out-dir=")) out.outDir = arg.slice("--out-dir=".length);
    else if (arg.startsWith("--unit=")) out.unit = arg.slice("--unit=".length);
    else if (arg === "--keep-server") out.keepServer = true;
    else if (arg === "--geometry-only") out.geometryOnly = true;
    else throw new Error(`unknown option ${arg}`);
  }
  return out;
}

function parseIntArg(arg, prefix) {
  const value = Number(arg.slice(prefix.length));
  if (!Number.isInteger(value) || value <= 0 || value > 65535) throw new Error(`${prefix} expects a TCP port, got ${arg}`);
  return value;
}

function stopScratchUnit(unitService, logsDir) {
  const result = spawnSync("systemctl", ["--user", "stop", unitService], { cwd: repoRoot, encoding: "utf8" });
  fs.writeFileSync(path.join(logsDir, "stop-server.log"), `${result.stdout ?? ""}${result.stderr ?? ""}`, "utf8");
}

function stopProcess(child) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function writeJsonl(file, rows) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, rows.length > 0 ? `${rows.map((row) => JSON.stringify(row)).join("\n")}\n` : "", "utf8");
}

function printSummary(result) {
  console.log(`house-collision ${result.runId} ${result.status}`);
  console.log(`dir ${result.runDir}`);
  console.table(result.scenarios.map((scenario) => ({ id: scenario.id, verdict: scenario.verdict, failures: scenario.failures.join(" | "), last: JSON.stringify(scenario.metrics.last), stallMs: scenario.metrics.longestStallMs })));
  if (result.serverTrace) console.log(`server trace ${result.serverTrace.path} lines=${result.serverTrace.lineCount}`);
}

function safeName(value) {
  return String(value).replace(/[^a-zA-Z0-9_.-]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 96) || "run";
}

function stamp() {
  return new Date().toISOString().replace(/[-:]/gu, "").replace(/\.\d{3}Z$/u, "Z");
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function round(value) {
  return Math.round((Number(value) || 0) * 1000) / 1000;
}

function roundPoint(point) {
  return { x: round(point.x), y: round(point.y) };
}
