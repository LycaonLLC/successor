#!/usr/bin/env node
// Desktop-shell smoke: consume shared build artifacts in farm skip-build mode
// (or build them when invoked standalone), regenerate the open-desert slice,
// assert the committed fixture remains current unless an explicit dirty-tree
// override proves regeneration is idempotent, then boot a desktop-like server
// env and drive the built client-3d dist through an authority-backed equip.
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

import { loadChromium, launchBrowser, Session } from "./client3d/lib/browser.mjs";
import { runtimeUrl, writeCharacterStore } from "./client3d/lib/fixture.mjs";
import { delay, getJson, isHttpReachable, pickFreePort, repoRootFrom, stamp, tail, writeJson } from "./client3d/lib/util.mjs";
import { boundedEnvPort, DESKTOP_SMOKE_PORT_RANGE } from "./desktop-smoke-ports.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = repoRootFrom(__dirname);
const runId = process.env.DESKTOP_SMOKE_RUN_ID ?? `desktop-smoke-${stamp()}`;
const artifactRel = path.join("verification", "ledgers", "artifacts", "desktop-smoke", runId);
const artifactsDir = path.join(repoRoot, artifactRel);
const logsDir = path.join(artifactsDir, "logs");
const startedAt = new Date().toISOString();
const started = performance.now();
const ownerForbiddenPorts = new Set([28093, 5179, 18192]);
const lanePortMin = DESKTOP_SMOKE_PORT_RANGE.start;
const lanePortMax = DESKTOP_SMOKE_PORT_RANGE.end;
const characterId = "desktop-smoke-probe";
const slugthrowerItemId = 3101;
const skipBuild = process.env.DESKTOP_SMOKE_SKIP_BUILD === "1";
const slicePaths = [
  "client/public/successor-slice/open-desert-slice.json",
  "client/public/successor-slice/open-desert-map-bundle.json",
];

fs.mkdirSync(logsDir, { recursive: true });

const manifest = {
  schema: "successor.desktop-smoke.v1",
  status: "fail",
  runId,
  startedAt,
  completedAt: null,
  durationMs: 0,
  ports: {},
  artifacts: { root: artifactRel },
  build: [],
  fixture: null,
  server: null,
  browser: null,
  equip: null,
  failures: [],
};

let preview = null;
let server = null;
let browser = null;
let session = null;

try {
  const ports = await allocatePorts();
  manifest.ports = ports;

  if (skipBuild) {
    assertPreparedDesktopArtifacts();
    manifest.build.push({ label: "shared phase-0 prerequisites", skipped: true });
  } else {
    manifest.build.push(runCommand("server dist", ["pnpm", "--dir", "server", "build"]));
    manifest.build.push(runCommand("rust authority bridge", ["cargo", "build", "-q", "-p", "successor-sim", "--example", "authority_bridge_server"], {
      env: { ...process.env, CARGO_PROFILE_DEV_OPT_LEVEL: process.env.CARGO_PROFILE_DEV_OPT_LEVEL ?? "2" },
    }));
    manifest.build.push(runCommand("client-3d dist", ["pnpm", "--dir", "client-3d", "build"]));
  }

  manifest.fixture = regenerateAndAssertFixtureClean();

  const storePath = writeCharacterStore(artifactsDir, [{
    id: characterId,
    name: "DeskSmoke",
    x: 589,
    y: 512,
    initialProfessionId: "marksman",
    worn: [],
  }]);

  preview = await startPreview(ports.preview);
  server = await startDesktopLikeServer({ port: ports.game, storePath, stateDir: path.join(artifactsDir, "game-state") });
  manifest.server = server.status;

  const chromiumInfo = loadChromium(repoRoot);
  browser = await launchBrowser(chromiumInfo.chromium);
  session = new Session({
    browser,
    name: "desktop-smoke",
    gamePort: ports.game,
    vitePort: ports.preview,
    actorId: characterId,
    shotsDir: artifactsDir,
    shotPrefix: "desktop-smoke",
  });
  await session.open();
  const url = runtimeUrl({ vitePort: ports.preview, gamePort: ports.game, equip: "slugthrower" });
  await session.goto(url);
  await session.enterWorld(characterId);
  const hello = await getJson(`http://127.0.0.1:${ports.game}/game/status`, 3000);
  await session.debugCommand({ DebugGrantSkillBoxes: { skill_box_ids: ["marksman-novice", "marksman-rifle-i", "marksman-rifle-ii", "marksman-rifle-iii"] } });
  await session.debugCommand({ DebugGiveItem: { item_id: slugthrowerItemId, variant_id: 0, quantity: 1, equip: false } });

  const equip = await equipSlugthrowerFromInventory(session);
  const screenshot = await session.shot("slugthrower-equipped");
  manifest.browser = {
    chromium: chromiumInfo.resolvedFrom,
    url,
    console: session.console,
    pageErrors: session.pageErrors,
    screenshot: path.relative(repoRoot, screenshot),
    hello: { shardId: hello.shardId, tick: hello.tick, sourceStateHash: hello.source?.stateHash ?? null },
  };
  manifest.equip = equip;
  manifest.status = "pass";
} catch (error) {
  if (session) {
    manifest.browser = {
      ...(manifest.browser ?? {}),
      url: session.page?.url?.() ?? null,
      console: session.console,
      pageErrors: session.pageErrors,
    };
  }
  manifest.failures.push(error instanceof Error ? error.stack ?? error.message : String(error));
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
} finally {
  await session?.close().catch(() => {});
  await browser?.close().catch(() => {});
  const serverStopError = await stopChild(server?.child, "server", 30_000).then(() => null, (error) => error);
  if (serverStopError) {
    manifest.status = "fail";
    manifest.failures.push(serverStopError instanceof Error ? serverStopError.message : String(serverStopError));
    process.exitCode = 1;
  }
  await stopChild(preview?.child, "preview").catch(() => {});
  manifest.completedAt = new Date().toISOString();
  manifest.durationMs = Math.round(performance.now() - started);
  const reportPath = path.join(artifactsDir, "desktop-smoke-report.json");
  writeJson(reportPath, manifest);
  console.log(JSON.stringify({
    status: manifest.status,
    runId,
    report: path.relative(repoRoot, reportPath),
    ports: manifest.ports,
    durationMs: manifest.durationMs,
    failures: manifest.failures.map((failure) => failure.split("\n")[0]),
  }, null, 2));
}

async function allocatePorts() {
  const claimed = new Set(ownerForbiddenPorts);
  const gameStart = boundedEnvPort("DESKTOP_SMOKE_GAME_PORT", lanePortMin);
  const game = await pickFreePort(gameStart, claimed);
  if (game > lanePortMax) throw new Error(`desktop smoke game port ${game} outside ${lanePortMin}-${lanePortMax}`);
  claimed.add(game);
  const previewStart = boundedEnvPort("DESKTOP_SMOKE_PREVIEW_PORT", Math.max(lanePortMin, game + 1));
  const preview = await pickFreePort(previewStart, claimed);
  if (preview > lanePortMax) throw new Error(`desktop smoke preview port ${preview} outside ${lanePortMin}-${lanePortMax}`);
  if (ownerForbiddenPorts.has(game) || ownerForbiddenPorts.has(preview)) throw new Error(`refusing forbidden owner/live port: ${game}/${preview}`);
  return { game, preview };
}


function runCommand(label, argv, options = {}) {
  const stepStarted = performance.now();
  const result = spawnSync(argv[0], argv.slice(1), {
    cwd: repoRoot,
    env: options.env ?? process.env,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const record = {
    label,
    argv,
    exitCode: result.status,
    durationMs: Math.round(performance.now() - stepStarted),
    stdoutTail: tail(result.stdout, 1200),
    stderrTail: tail(result.stderr, 1200),
  };
  if (result.status !== 0) {
    throw new Error(`${label} failed (${result.status})\n${record.stdoutTail}${record.stderrTail}`);
  }
  return record;
}

function regenerateAndAssertFixtureClean() {
  const before = new Map(slicePaths.map((slicePath) => [
    slicePath,
    fs.readFileSync(path.join(repoRoot, slicePath)),
  ]));
  const regen = runCommand("open-desert fixture regen", [process.execPath, path.join(repoRoot, "tools", "successor", "configure-open-desert-fixture.mjs")], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", GAME_ALLOW_DEV_IDENTITY: process.env.GAME_ALLOW_DEV_IDENTITY ?? "1" },
  });
  const changed = slicePaths.filter((slicePath) => {
    const after = fs.readFileSync(path.join(repoRoot, slicePath));
    return !before.get(slicePath).equals(after);
  });
  if (changed.length > 0) {
    throw new Error(`desktop fixture generator changed current generated output\n${changed.join("\n")}`);
  }
  const committed = spawnSync("git", ["diff", "--quiet", "--", ...slicePaths], { cwd: repoRoot }).status === 0;
  const allowDirtyFixture = process.env.DESKTOP_SMOKE_ALLOW_DIRTY_FIXTURE === "1";
  if (!committed && !allowDirtyFixture) {
    throw new Error("desktop fixture differs from the committed baseline; set DESKTOP_SMOKE_ALLOW_DIRTY_FIXTURE=1 only for an intentional dirty-tree idempotence proof");
  }
  return { clean: true, baseline: committed ? "committed" : "working-tree-dirty", regen };
}

async function startPreview(port) {
  if (await isHttpReachable(port, "/")) throw new Error(`preview port ${port} already serving; refusing to hijack`);
  const out = fs.openSync(path.join(logsDir, "client-3d-preview.log"), "a");
  const child = spawn("pnpm", ["--dir", "client-3d", "exec", "vite", "preview", "--host", "127.0.0.1", "--port", String(port), "--strictPort"], {
    cwd: repoRoot,
    env: { ...process.env, SUCCESSOR_GAME_LAB: "1", GAME_ALLOW_DEV_IDENTITY: process.env.GAME_ALLOW_DEV_IDENTITY ?? "1" },
    stdio: ["ignore", out, out],
  });
  await waitForHttp(port, "/", `client-3d preview ${port}`, child, 60000);
  return { child, port };
}

async function startDesktopLikeServer({ port, storePath, stateDir }) {
  if (await isHttpReachable(port, "/game/status")) throw new Error(`game port ${port} already serving; refusing to hijack`);
  const slicePath = path.join(repoRoot, "client", "public", "successor-slice", "open-desert-slice.json");
  const rustBridgeBin = path.join(repoRoot, "target", "debug", "examples", "authority_bridge_server");
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key === "PORT" || key === "HOST" || key.startsWith("GAME_")) delete env[key];
  }
  const shardId = `desktop-smoke-${Date.now()}`;
  Object.assign(env, {
    ELECTRON_RUN_AS_NODE: "1",
    PORT: String(port),
    HOST: "127.0.0.1",
    LOG_LEVEL: "silent",
    GAME_ALLOW_DEV_IDENTITY: process.env.GAME_ALLOW_DEV_IDENTITY ?? "1",
    GAME_SHARD_ID: shardId,
    GAME_SHARD_PERSISTENCE: "1",
    GAME_SHARD_STATE_DIR: stateDir,
    GAME_SHARD_CHECKPOINT_PATH: path.join(stateDir, `${shardId}.checkpoint.json`),
    GAME_SHARD_JOURNAL_PATH: path.join(stateDir, `${shardId}.journal.jsonl`),
    GAME_FIRE_DEBUG: "0",
    GAME_DEBUG_AUTHORITY_COMMANDS: "1",
    GAME_SLICE_PATH: slicePath,
    GAME_RUST_AUTHORITY_BRIDGE_BIN: rustBridgeBin,
    GAME_CHARACTER_STORE_PATH: storePath,
  });
  const out = fs.openSync(path.join(logsDir, "game-server.log"), "a");
  const child = spawn(process.execPath, [path.join(repoRoot, "server", "dist", "index.js")], {
    cwd: path.join(repoRoot, "server"),
    env,
    stdio: ["ignore", out, out],
  });
  try {
    await waitForHttp(port, "/game/status", `desktop-like game server ${port}`, child, 60000);
    const status = await getJson(`http://127.0.0.1:${port}/game/status`, 3000);
    return { child, status: { port, shardId: status.shardId, tick: status.tick, sourceStateHash: status.source?.stateHash ?? null, sourceActorCount: status.source?.actorCount ?? null } };
  } catch (error) {
    const cleanupError = await stopChild(child, "server", 30_000).then(() => null, (stopError) => stopError);
    if (cleanupError) {
      throw new Error(`${error instanceof Error ? error.message : String(error)}\nserver exit/cleanup check failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`, { cause: error });
    }
    throw error;
  }
}

async function waitForHttp(port, requestPath, label, child, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`${label} exited before readiness (${describeChildExit(child)}); see ${logsDir}`);
    }
    if (await isHttpReachable(port, requestPath)) return;
    await delay(250);
  }
  throw new Error(`${label} never became reachable; see ${logsDir}`);
}

async function equipSlugthrowerFromInventory(s) {
  const selector = `.inv-slot[data-item-id="${slugthrowerItemId}"]`;
  await s.press("KeyI");
  await s.waitDom('.sc3d-window[data-window="inventory"]', { state: "visible", timeoutMs: 10000 });
  await s.waitDom(selector, { state: "visible", timeoutMs: 12000 });
  const beforeProbe = await s.probe();
  const initiallyEquipped = await s.page.locator(selector).first().evaluate((el) => el.hasAttribute("data-equipped"));
  if (initiallyEquipped) {
    await s.dblclick(selector);
    await s.waitProbeCall(
      () => inventoryRows(s),
      (rows) => rows.find((row) => row.itemId === String(slugthrowerItemId))?.equipped === false,
      { timeoutMs: 8000, label: "desktop smoke pre-clear initially equipped Slugthrower" },
    );
  }
  const acceptedBefore = (await s.probe())?.acceptedCommands ?? beforeProbe?.acceptedCommands ?? 0;
  await s.dblclick(selector);
  const receiptProbe = await s.waitProbe(
    (probe) => (probe.acceptedCommands ?? 0) > acceptedBefore,
    { timeoutMs: 8000, label: "desktop smoke Slugthrower accepted receipt" },
  );
  const oracle = await s.waitProbeCall(
    () => s.oracle(),
    (state) => state?.actors?.[s.actorId]?.weapon?.weaponId === "slugthrower"
      && Number(state.actors[s.actorId].weapon.weaponItemId ?? 0) === slugthrowerItemId,
    { timeoutMs: 8000, label: "desktop smoke authority-backed Slugthrower state" },
  );
  const rows = await inventoryRows(s);
  const row = rows.find((candidate) => candidate.itemId === String(slugthrowerItemId));
  if (row?.equipped !== true) throw new Error(`desktop smoke Slugthrower row did not render equipped: ${JSON.stringify(rows).slice(0, 500)}`);
  await s.waitProbe((probe) => probe.muzzleWorld !== null, { timeoutMs: 8000, label: "desktop smoke held gun model" });
  return {
    acceptedCommandsBefore: acceptedBefore,
    acceptedCommandsAfter: receiptProbe.acceptedCommands,
    row,
    authorityWeapon: oracle.actors[s.actorId].weapon,
    muzzleWorld: (await s.probe())?.muzzleWorld ?? null,
  };
}

function inventoryRows(s) {
  return s.page.evaluate(() => [...document.querySelectorAll(".inv-slot")].map((el) => ({
    key: el.getAttribute("data-key"),
    itemId: el.getAttribute("data-item-id"),
    category: el.getAttribute("data-cat"),
    title: el.querySelector(".inv-slot-title")?.textContent?.trim() ?? "",
    equipped: el.hasAttribute("data-equipped"),
  })));
}

function assertPreparedDesktopArtifacts() {
  const required = [
    path.join(repoRoot, "server", "dist", "index.js"),
    path.join(repoRoot, "target", "debug", "examples", "authority_bridge_server"),
    path.join(repoRoot, "client-3d", "dist", "index.html"),
    path.join(repoRoot, "desktop", "release", `successor-${process.platform}-${process.arch}`, "successor"),
  ];
  const missing = required.filter((file) => {
    try {
      return !fs.statSync(file).isFile() || fs.statSync(file).size === 0;
    } catch {
      return true;
    }
  });
  if (missing.length > 0) throw new Error(`desktop smoke skip-build prerequisites are missing: ${missing.join(", ")}`);
}

async function stopChild(child, label, graceMs = 3000) {
  if (!child) return;
  let forced = false;
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGTERM");
    const exited = await Promise.race([
      new Promise((resolve) => child.once("exit", () => resolve(true))),
      delay(graceMs).then(() => false),
    ]);
    if (exited === false && child.exitCode === null && child.signalCode === null) {
      forced = true;
      child.kill("SIGKILL");
      await Promise.race([new Promise((resolve) => child.once("exit", resolve)), delay(1000)]);
    }
  }
  fs.appendFileSync(path.join(logsDir, "teardown.log"), `${label} exitCode=${child.exitCode} signal=${child.signalCode ?? ""}\n`, "utf8");
  if (forced) throw new Error(`${label} did not complete graceful shutdown within ${graceMs}ms and required SIGKILL`);
  if (child.exitCode !== 0) throw new Error(`${label} did not exit cleanly (${describeChildExit(child)})`);
}

function describeChildExit(child) {
  if (child.exitCode !== null) return `exitCode=${child.exitCode}`;
  if (child.signalCode !== null) return `signal=${child.signalCode}`;
  return "still-running";
}
