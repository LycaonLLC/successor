#!/usr/bin/env node
import { chromium } from "@playwright/test";
import childProcess from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(scriptDir, "..");
const appBinary = process.env.SUCCESSOR_DESKTOP_BINARY
  ? path.resolve(process.env.SUCCESSOR_DESKTOP_BINARY)
  : path.join(desktopRoot, "release", `successor-${process.platform}-${process.arch}`, "successor");

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

// Teardown: graceful SIGTERM first (app stops its game server, which reaps the
// Rust bridge), then escalate to SIGKILL on the whole process group. A killed
// Electron group can orphan the detached game-server child, so sweep any
// servers still running under the packaged binary path (never the dev stack's
// /usr/bin/node servers).
async function terminateDesktopApp(app, verifyRunId) {
  if (!app.pid) return;
  const exited = new Promise((resolve) => {
    if (app.exitCode !== null || app.signalCode) return resolve(true);
    app.once("exit", () => resolve(true));
  });
  app.kill("SIGTERM");
  const graceful = await Promise.race([exited, delay(6_000).then(() => false)]);
  if (!graceful) {
    try {
      process.kill(-app.pid, "SIGKILL");
    } catch {
      // group already gone
    }
  }
  reapOrphanedPackagedServers(verifyRunId);
}

function reapOrphanedPackagedServers(verifyRunId) {
  const list = childProcess.spawnSync("pgrep", ["-f", `^${appBinary} .*server/dist/index\\.js`], { encoding: "utf8" });
  const pids = (list.stdout ?? "").split(/\s+/).map(Number).filter((pid) => (
    Number.isInteger(pid)
    && pid > 1
    && processEnvironmentValue(pid, "SUCCESSOR_DESKTOP_VERIFY_RUN_ID") === verifyRunId
  ));
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // already gone
    }
  }
  if (pids.length > 0) {
    childProcess.spawnSync("sleep", ["2"]);
    for (const pid of pids) {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // gone
        }
      }
    }
  }
}

function processEnvironmentValue(pid, name) {
  try {
    const entries = fs.readFileSync(`/proc/${pid}/environ`, "utf8").split("\0");
    const prefix = `${name}=`;
    return entries.find((entry) => entry.startsWith(prefix))?.slice(prefix.length) ?? null;
  } catch {
    return null;
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const verifyRoot = fs.mkdtempSync(path.join(os.tmpdir(), "successor-desktop-key-ownership-"));
  const configRoot = path.join(verifyRoot, "config");
  const cacheRoot = path.join(verifyRoot, "cache");
  const runtimeLogPath = path.join(verifyRoot, "desktop-runtime.log");
  const verifyRunId = path.basename(verifyRoot);
  fs.mkdirSync(configRoot, { recursive: true });
  fs.mkdirSync(cacheRoot, { recursive: true });
  const cdpPort = await availableLoopbackPort(process.env.SUCCESSOR_DESKTOP_CDP_PORT);
  const cdpOrigin = `http://127.0.0.1:${cdpPort}`;
  const appEnv = desktopVerificationEnvironment({ configRoot, cacheRoot, runtimeLogPath, verifyRunId });
  const app = childProcess.spawn(appBinary, [...desktopLaunchArgs(), `--remote-debugging-port=${cdpPort}`], {
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
    env: appEnv,
  });
  let browser;
  try {
    await waitForCdp(cdpOrigin, app);
    browser = await chromium.connectOverCDP(cdpOrigin);
    const page = await waitForSuccessorPage(browser, runtimeLogPath);
    await page.waitForFunction(() => window.__successorDesktop?.isDesktopShell === true, null, { timeout: 10_000 });
    const nativeWindow = await page.evaluate(() => window.__successorDesktop?.windowState?.());
    const expectsInitialFullScreen = process.env.SUCCESSOR_DESKTOP_FULLSCREEN === "1" && process.env.SUCCESSOR_DESKTOP_WINDOWED !== "1";
    if (expectsInitialFullScreen) {
      assertFullScreenState(nativeWindow, "initial fullscreen");
      const f11WindowedState = await exitGameFullScreenWithShortcut(page, "F11");
      const altFullScreenState = await enterGameFullScreenWithShortcut(page, "Alt+Enter");
      const altWindowedState = await exitGameFullScreenWithShortcut(page, "Alt+Enter");
      nativeWindow.windowToggleProof = { f11WindowedState, altFullScreenState, altWindowedState };
    } else {
      if (!isWindowedContentState(nativeWindow)) {
        throw new Error(`desktop combat window did not launch windowed/resizable: ${JSON.stringify(nativeWindow)}`);
      }
      const f11FullScreenState = await enterGameFullScreenWithShortcut(page, "F11");
      const f11WindowedState = await exitGameFullScreenWithShortcut(page, "F11");
      const altFullScreenState = await enterGameFullScreenWithShortcut(page, "Alt+Enter");
      const altWindowedState = await exitGameFullScreenWithShortcut(page, "Alt+Enter");
      nativeWindow.windowToggleProof = { f11FullScreenState, f11WindowedState, altFullScreenState, altWindowedState };
    }
    await page.evaluate(() => {
      window.__desktopKeyOwnershipProof = { dom: [], desktop: [] };
      window.addEventListener("keydown", (event) => {
        window.__desktopKeyOwnershipProof.dom.push({ type: "keydown", code: event.code, key: event.key, ctrlKey: event.ctrlKey, metaKey: event.metaKey });
      });
      window.addEventListener("keyup", (event) => {
        window.__desktopKeyOwnershipProof.dom.push({ type: "keyup", code: event.code, key: event.key, ctrlKey: event.ctrlKey, metaKey: event.metaKey });
      });
      window.addEventListener("successor-desktop-key-input", (event) => {
        window.__desktopKeyOwnershipProof.desktop.push(event.detail);
      });
    });

    const beforeUrl = page.url();
    await page.keyboard.down("ControlLeft");
    await page.keyboard.down("KeyW");
    await page.keyboard.up("KeyW");
    await page.keyboard.up("ControlLeft");
    await page.waitForTimeout(250);

    const proof = await page.evaluate(() => ({
      url: location.href,
      title: document.title,
      desktop: window.__successorDesktop,
      events: window.__desktopKeyOwnershipProof,
    }));
    const sawCtrlW = proof.events.dom.some((event) => event.type === "keydown" && event.code === "KeyW" && event.ctrlKey === true)
      || proof.events.desktop.some((event) => event.type === "keydown" && event.code === "KeyW" && event.ctrlKey === true);
    if (page.isClosed()) throw new Error("Ctrl+W closed the desktop window");
    if (proof.url !== beforeUrl) throw new Error(`Ctrl+W navigated away from ${beforeUrl} to ${proof.url}`);
    if (!sawCtrlW) throw new Error(`Ctrl+W did not reach the game input surface: ${JSON.stringify(proof)}`);

    await page.waitForFunction(() => Number.isFinite(window.__successor3d?.tick) && (window.__successor3d?.tick ?? 0) > 0, null, { timeout: 20_000 });
    await page.waitForFunction(() => window.__successor3d?.sourceMatchesClient === true, null, { timeout: 10_000 });
    await page.waitForFunction(() => (window.__successor3d?.actorCount ?? 0) >= 1, null, { timeout: 20_000 });
    // Planetfall boot loadscreen swallows gameplay keydowns while active
    // (client input gates on isLoadScreenActive) — wait for the overlay to
    // clear or start fading before probing WASD, or the walk goes nowhere.
    await page.waitForFunction(
      () => {
        const overlay = document.querySelector(".sc3d-loadscreen");
        return overlay === null || overlay.classList.contains("sc3d-loadscreen--fading");
      },
      null,
      { timeout: 20_000 },
    );
    await page.bringToFront();
    // NEVER click the canvas here: a combat-mode click can hit an interactable
    // pawn (e.g. the camp trainer), open its window, flip to cursor mode, and
    // focus a text input that swallows WASD. Keyboard input needs no click.
    await page.waitForTimeout(400);
    const before = await page.evaluate(() => ({ x: window.__successor3d.playerCell.x, y: window.__successor3d.playerCell.y, tick: window.__successor3d.tick }));
    await page.keyboard.down("KeyW");
    let after = before;
    const movementDeadline = Date.now() + 5_000;
    try {
      do {
        await page.waitForTimeout(200);
        after = await page.evaluate(() => ({ x: window.__successor3d.playerCell.x, y: window.__successor3d.playerCell.y, tick: window.__successor3d.tick }));
      } while (Math.hypot(after.x - before.x, after.y - before.y) <= 0.5 && Date.now() < movementDeadline);
    } finally {
      await page.keyboard.up("KeyW");
    }
    const movedCells = Math.hypot(after.x - before.x, after.y - before.y);
    if (!(movedCells > 0.5) || !(after.tick > before.tick)) {
      const diag = await page.evaluate(() => ({
        probe: {
          tick: window.__successor3d?.tick,
          serverStatus: window.__successor3d?.serverStatus,
          cursorMode: window.__successor3d?.cursorMode,
          pointerLocked: window.__successor3d?.pointerLocked,
          accepted: window.__successor3d?.acceptedCommands,
          rejected: window.__successor3d?.rejectedCommands,
          lifeState: window.__successor3d?.playerAuthorityLifeState,
          moveGate: window.__successor3d?.moveGate,
          rejectLog: window.__successor3d?.rejectLog?.slice(-4),
        },
        recentDomKeys: window.__desktopKeyOwnershipProof?.dom?.slice(-6) ?? null,
        activeElement: document.activeElement?.tagName ?? null,
        visibility: document.visibilityState,
        hasFocus: document.hasFocus(),
      }));
      throw new Error(`WASD movement failed: ${JSON.stringify({ before, after, movedCells, diag })}`);
    }
    const runtimeProof = await page.evaluate(() => ({
      tick: window.__successor3d?.tick,
      serverStatus: window.__successor3d?.serverStatus,
      sourceMatchesClient: window.__successor3d?.sourceMatchesClient,
      actorCount: window.__successor3d?.actorCount,
      playerActorId: window.__successor3d?.playerActorId,
      playerLifeState: window.__successor3d?.playerAuthorityLifeState,
      cursorMode: window.__successor3d?.cursorMode,
    }));
    runtimeProof.movedCells = Math.round(movedCells * 100) / 100;

    const runtimeViewportProof = await verifyRuntimeFullScreenViewport(page);
    const freshRosterProof = verifyFreshDurableRoster(configRoot);

    console.log(JSON.stringify({
      ok: true,
      appBinary,
      url: proof.url,
      sawCtrlW,
      nativeWindow,
      runtimeProof,
      runtimeViewportProof,
      freshRosterProof,
    }, null, 2));

  } finally {
    if (browser) await browser.close().catch(() => undefined);
    await terminateDesktopApp(app, verifyRunId);
    if (process.env.SUCCESSOR_DESKTOP_KEEP_VERIFY_ARTIFACTS === "1") {
      console.error(`desktop verification artifacts retained at ${verifyRoot}`);
    } else {
      fs.rmSync(verifyRoot, { recursive: true, force: true });
    }
  }
}

function verifyFreshDurableRoster(configRoot) {
  const rosterPath = path.join(configRoot, "successor", "game-state", "characters.json");
  let roster;
  try {
    roster = JSON.parse(fs.readFileSync(rosterPath, "utf8"));
  } catch (error) {
    throw new Error(`packaged fresh-install roster could not be read at ${rosterPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (roster?.schema !== "successor.character-store.v2" || !Array.isArray(roster.characters)) {
    throw new Error(`packaged fresh-install roster is malformed at ${rosterPath}`);
  }
  if (roster.characters.length !== 0) {
    const ids = roster.characters.map((record) => record?.id ?? null);
    throw new Error(`packaged fresh install inherited checkout character rows: ${JSON.stringify(ids)}`);
  }
  return { characterCount: 0 };
}

function desktopVerificationEnvironment({ configRoot, cacheRoot, runtimeLogPath, verifyRunId }) {
  const env = { ...process.env };
  for (const name of ["URL", "DEV_URL", "CLIENT_DIST", "SHARED_PUBLIC", "SKIP_SERVER", "SPAWN_SERVER", "GAME_PORT"]) {
    delete env[`SUCCESSOR_DESKTOP_${name}`];
  }
  return {
    ...env,
    XDG_CONFIG_HOME: configRoot,
    XDG_CACHE_HOME: cacheRoot,
    SUCCESSOR_DESKTOP_MODE: "offline",
    SUCCESSOR_DESKTOP_ENABLE_DEVTOOLS: "0",
    SUCCESSOR_DESKTOP_RUNTIME_LOG: runtimeLogPath,
    SUCCESSOR_DESKTOP_VERIFY_RUN_ID: verifyRunId,
    // Key ownership belongs to the explicit offline combat runtime. Hosted
    // account/link behavior is covered by the separate packaged desktop smoke.
    SUCCESSOR_DESKTOP_APP_QUERY: process.env.SUCCESSOR_DESKTOP_APP_QUERY
      ?? "gamePort=18192&player=pocket-grug&actorId=pocket-grug&name=Grug&autoEnter=1&equip=slugthrower&spawnArea=open-desert-overworld&spawnX=540&spawnY=540&facing=front&slicePath=/successor-slice/open-desert-slice.json&mapBundlePath=/successor-slice/open-desert-map-bundle.json",
  };
}

function availableLoopbackPort(explicitPort) {
  const requested = Number(explicitPort ?? 0);
  if (explicitPort !== undefined && (!Number.isInteger(requested) || requested < 1 || requested > 65_535)) {
    throw new Error(`SUCCESSOR_DESKTOP_CDP_PORT must be an integer TCP port from 1 to 65535; got ${explicitPort}`);
  }
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: requested, exclusive: true }, () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : null;
      server.close((error) => {
        if (error) reject(error);
        else if (!port) reject(new Error("could not allocate a desktop verification CDP port"));
        else resolve(port);
      });
    });
  });
}

function desktopLaunchArgs() {
  const args = [];
  if (process.platform === "linux" && process.env.SUCCESSOR_DESKTOP_NO_SANDBOX !== "0") args.push("--no-sandbox");
  if (process.env.SUCCESSOR_DESKTOP_VERIFY_SOFTWARE_GL === "1") {
    args.push("--use-angle=swiftshader", "--enable-unsafe-swiftshader");
  }
  return args;
}

async function waitForWindowState(page, predicate, label, timeoutMs = 5_000) {
  const started = Date.now();
  let state = null;
  while (Date.now() - started < timeoutMs) {
    state = await page.evaluate(() => window.__successorDesktop?.windowState?.());
    if (predicate(state)) return state;
    await page.waitForTimeout(80);
  }
  throw new Error(`${label} timed out: ${JSON.stringify(state)}`);
}

async function enterGameFullScreenWithShortcut(page, shortcut) {
  await pressWindowShortcut(page, shortcut);
  const state = await waitForWindowState(
    page,
    (windowState) => windowState?.gameFullScreen === true && contentFillsDisplay(windowState),
    `${shortcut} fullscreen entry`,
  );
  assertFullScreenState(state, `${shortcut} fullscreen entry`);
  await page.waitForTimeout(260);
  return state;
}

async function exitGameFullScreenWithShortcut(page, shortcut) {
  await pressWindowShortcut(page, shortcut);
  const state = await waitForWindowState(
    page,
    (windowState) => isWindowedContentState(windowState),
    `${shortcut} windowed exit`,
  );
  await page.waitForTimeout(260);
  const settledState = await page.evaluate(() => window.__successorDesktop?.windowState?.());
  if (!isWindowedContentState(settledState)) {
    throw new Error(`${shortcut} exit did not settle into a sane windowed state: ${JSON.stringify(settledState)}`);
  }
  return settledState;
}

async function pressWindowShortcut(page, shortcut) {
  await page.mouse.click(16, 16);
  await page.keyboard.press(shortcut);
}

function assertFullScreenState(state, label) {
  if (state?.gameFullScreen !== true) {
    throw new Error(`desktop combat window is not fullscreen for ${label}: ${JSON.stringify(state)}`);
  }
  if (state?.fullScreen !== true && state?.resizable !== false) {
    throw new Error(`desktop custom fullscreen window is resizable for ${label}: ${JSON.stringify(state)}`);
  }
  if (!contentFillsDisplay(state)) {
    throw new Error(`desktop combat window content does not fill the display for ${label}: ${JSON.stringify(state)}`);
  }
}

async function verifyRuntimeFullScreenViewport(page) {
  const fullScreenState = await enterGameFullScreenWithShortcut(page, "F11");
  const fullScreenViewport = await waitForRuntimeViewportFill(page, "runtime F11 fullscreen viewport");
  const windowedState = await exitGameFullScreenWithShortcut(page, "F11");
  return { fullScreenState, fullScreenViewport, windowedState };
}

async function waitForRuntimeViewportFill(page, label, timeoutMs = 5_000) {
  const started = Date.now();
  let proof = null;
  while (Date.now() - started < timeoutMs) {
    proof = await runtimeViewportProof(page);
    if (runtimeViewportFillsDisplay(proof)) return proof;
    await page.waitForTimeout(80);
  }
  throw new Error(`${label} timed out: ${JSON.stringify(proof)}`);
}

async function runtimeViewportProof(page) {
  return page.evaluate(async () => {
    const windowState = await window.__successorDesktop?.windowState?.();
    const stage = document.querySelector("#successor3d-canvas-host")?.getBoundingClientRect();
    return {
      windowState,
      viewport: {
        innerWidth: window.innerWidth,
        innerHeight: window.innerHeight,
        clientWidth: document.documentElement.clientWidth,
        clientHeight: document.documentElement.clientHeight,
      },
      stage: stage ? {
        x: stage.x,
        y: stage.y,
        width: stage.width,
        height: stage.height,
      } : null,
    };
  });
}

function runtimeViewportFillsDisplay(proof) {
  const display = proof?.windowState?.displayBounds;
  const viewport = proof?.viewport;
  const stage = proof?.stage;
  if (!display || !viewport || !stage) return false;
  return (
    viewport.innerWidth >= display.width - 2
    && viewport.innerHeight >= display.height - 2
    && viewport.clientWidth >= display.width - 2
    && viewport.clientHeight >= display.height - 2
    && stage.x <= 1
    && stage.y <= 1
    && stage.width >= display.width - 2
    && stage.height >= display.height - 2
  );
}

function contentFillsDisplay(state) {
  const contentBounds = state?.contentBounds;
  const displayBounds = state?.displayBounds;
  return Boolean(
    contentBounds
    && displayBounds
    && contentBounds.x <= displayBounds.x
    && contentBounds.y <= displayBounds.y
    && contentBounds.x + contentBounds.width >= displayBounds.x + displayBounds.width
    && contentBounds.y + contentBounds.height >= displayBounds.y + displayBounds.height
  );
}

function isWindowedContentState(state) {
  const contentBounds = state?.contentBounds;
  const displayBounds = state?.displayBounds;
  return Boolean(
    state?.gameFullScreen === false
    && state?.resizable === true
    && contentBounds
    && displayBounds
    && contentBounds.width < displayBounds.width
    && contentBounds.height < displayBounds.height,
  );
}

function waitForCdp(origin, app) {
  const deadline = Date.now() + 15_000;
  return new Promise((resolve, reject) => {
    const chunks = [];
    app.stderr.on("data", (chunk) => chunks.push(chunk.toString("utf8")));
    app.stdout.on("data", (chunk) => chunks.push(chunk.toString("utf8")));
    app.on("exit", (code, signal) => reject(new Error(`desktop app exited before CDP opened: code=${code} signal=${signal}\n${chunks.join("")}`)));
    const tick = () => {
      http.get(`${origin}/json/version`, (response) => {
        response.resume();
        if (response.statusCode === 200) resolve();
        else retry();
      }).on("error", retry);
    };
    const retry = () => {
      if (Date.now() > deadline) reject(new Error(`timed out waiting for ${origin}`));
      else setTimeout(tick, 100);
    };
    tick();
  });
}

async function waitForSuccessorPage(browser, runtimeLogPath) {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    for (const context of browser.contexts()) {
      for (const page of context.pages()) {
        if (page.url().startsWith("successor://app/")) return page;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const urls = browser.contexts().flatMap((context) => context.pages().map((page) => page.url()));
  throw new Error(`desktop app page did not load successor://app/; pages=${JSON.stringify(urls)}${runtimeLogTail(runtimeLogPath)}`);
}

function runtimeLogTail(logPath) {
  try {
    const lines = fs.readFileSync(logPath, "utf8").trimEnd().split("\n").slice(-30);
    return `\ndesktop runtime log tail:\n${lines.join("\n")}`;
  } catch {
    return "";
  }
}
