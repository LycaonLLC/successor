#!/usr/bin/env node
/**
 * Packaged hosted-login smoke (Linux, under Xvfb — run via:
 *   xvfb-run -a pnpm --dir desktop smoke:hosted
 *
 * Packages the desktop app from the real client-3d dist, then drives the
 * PACKAGED binary against a local fake account API plus a fake hosted game
 * endpoint:
 *   sign-in shell -> device code -> approval -> character select ->
 *   Enter world -> game page -> matchmake attempt against the hosted
 *   endpoint -> forced game-leg failure -> back on character select.
 *
 * Proves, against the shipped artifact: hosted is the default mode, no local
 * shard starts, the envelope crosses IPC exactly once, tickets ride the
 * matchmake body (never a URL), one-leg failure cleans up and remints, and
 * no secret reaches the runtime log, page URLs, or history.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(desktopRoot, "..");

const CREDENTIAL = "credential-smoke-0123456789abcdef";
const DEVICE_CODE = "device-code-smoke-0123456789abcdef";
const USER_CODE = "SMOKECODE1";
const GAME_TICKET = "game-ticket-smoke-0123456789";
const CHAT_TICKET = "chat-ticket-smoke-0123456789";
const SECRETS = [CREDENTIAL, DEVICE_CODE, GAME_TICKET, CHAT_TICKET];

function fail(message) {
  throw new Error(`hosted-smoke: FAIL — ${message}`);
}

async function withTimeout(promise, timeoutMs, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function clientReleaseIdFromDist() {
  // The packaged dist pins SUCCESSOR_ASSET_RELEASE_ID at build time; the
  // envelope release.client must match it exactly, as in production.
  const manifestPath = path.join(repoRoot, "client-3d", ".generated", "production-assets", "production-asset-manifest.json");
  try {
    const releaseId = JSON.parse(fs.readFileSync(manifestPath, "utf8")).releaseId;
    return typeof releaseId === "string" && releaseId ? releaseId : "successor-alpha";
  } catch {
    return "successor-alpha";
  }
}

function startFakeApi(gamePort, chatPort, clientReleaseId) {
  const state = { polls: 0, exchanged: false, ticketMints: 0, requests: [] };
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      state.requests.push({ method: req.method, url: req.url });
      const send = (status, payload) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(payload));
      };
      if (req.method === "POST" && req.url === "/alpha-api/device/start") {
        return send(201, {
          authorizationId: "auth_smoke",
          deviceCode: DEVICE_CODE,
          userCode: USER_CODE,
          expiresAt: Date.now() + 600_000,
          pollIntervalMs: 5000,
          scopes: ["character:list", "play-ticket"],
        });
      }
      if (req.method === "POST" && req.url === "/alpha-api/device/poll") {
        if (state.exchanged) return send(200, { status: "exchanged" });
        state.polls += 1;
        if (state.polls < 2) return send(200, { status: "pending" });
        state.exchanged = true;
        return send(200, { status: "exchanged", credential: CREDENTIAL, scopes: ["character:list", "play-ticket"] });
      }
      if (req.url === "/alpha-api/characters") {
        if (req.headers.authorization !== `Bearer ${CREDENTIAL}`) return send(401, { error: "invalid_auth" });
        return send(200, { characters: [{ id: "char-smoke", name: "Smokewalker", initialProfessionId: "medic", worldEntryClaimed: true }] });
      }
      if (req.method === "POST" && req.url === "/alpha-api/play-ticket") {
        if (req.headers.authorization !== `Bearer ${CREDENTIAL}`) return send(401, { error: "invalid_auth" });
        state.ticketMints += 1;
        return send(200, {
          gameTicket: `${GAME_TICKET}-${state.ticketMints}`,
          chatTicket: `${CHAT_TICKET}-${state.ticketMints}`,
          characterId: "char-smoke",
          expiresAt: Date.now() + 45_000,
          endpoints: { game: `ws://127.0.0.1:${gamePort}/game/ws`, chat: `ws://127.0.0.1:${chatPort}/chat` },
          release: { client: clientReleaseId, server: "successor-server-smoke", shard: "open-desert" },
        });
      }
      if (req.method === "POST" && req.url === "/alpha-api/device/logout") {
        res.writeHead(204);
        return res.end();
      }
      return send(404, { error: "not_found" });
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, state, port: server.address().port })));
}

/** Fake hosted game endpoint: records matchmake POSTs, answers 500 so the
 *  game leg fails deterministically and the one-leg cleanup path runs. */
function startFakeGame() {
  const state = { requests: [] };
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      state.requests.push({
        method: req.method,
        url: req.url,
        body,
        origin: req.headers.origin ?? null,
        cookie: req.headers.cookie ?? null,
        authorization: req.headers.authorization ?? null,
      });
      // Pre-join reads succeed so the real client advances to the join
      // attempt; every join/mutation is denied so the game leg fails
      // deterministically and the one-leg cleanup path runs. CORS mirrors the
      // hosted game backend, which must answer the desktop app origin.
      const cors = {
        "access-control-allow-origin": req.headers.origin ?? "*",
        "access-control-allow-methods": "GET, POST, OPTIONS",
        "access-control-allow-headers": "content-type, authorization",
        // Chromium Private Network Access preflight for 127.0.0.1 targets.
        "access-control-allow-private-network": "true",
      };
      if (req.method === "OPTIONS") {
        res.writeHead(204, cors);
        return res.end();
      }
      if (req.method === "GET") {
        res.writeHead(200, { "content-type": "application/json", ...cors });
        return res.end(JSON.stringify({ online: true, tick: 1, sessionCount: 0, actorCount: 0, shardId: "open-desert", records: {}, items: [] }));
      }
      res.writeHead(500, { "content-type": "application/json", ...cors });
      res.end(JSON.stringify({ error: "smoke_denies_join" }));
    });
  });
  server.on("upgrade", (req, socket) => {
    state.requests.push({ method: "UPGRADE", url: req.url, body: "" });
    socket.destroy();
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, state, port: server.address().port })));
}

async function main() {
  if (process.platform !== "linux") fail("this smoke runs on Linux under Xvfb");
  const clientDist = path.join(repoRoot, "client-3d", "dist");
  if (!fs.existsSync(path.join(clientDist, "index.html"))) {
    fail("client-3d/dist missing; run pnpm --dir client-3d build first");
  }

  // 1) Package the real artifact and check the record.
  const build = spawnSync("node", [path.join(desktopRoot, "scripts", "build-desktop.mjs")], {
    cwd: desktopRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
  if (build.status !== 0) fail("desktop packaging failed");
  const buildResult = JSON.parse(build.stdout);
  const record = buildResult.artifact;
  if (record.requirements.publishable !== false) fail("artifact must stay publishable:false before hosted proof");
  if (!/end-to-end proof/.test(record.requirements.distribution)) fail("artifact distribution note must name the missing hosted proof");
  console.log(`hosted-smoke: packaged ${record.archive} (${record.bytes} bytes, publishable=${record.requirements.publishable})`);

  const packagedBinary = path.join(buildResult.packageRoot, "successor");
  if (!fs.existsSync(packagedBinary)) fail("packaged binary missing");

  // 2) Fake hosted world + account API.
  const game = await startFakeGame();
  const chat = await startFakeGame();
  const api = await startFakeApi(game.port, chat.port, clientReleaseIdFromDist());

  // 3) Drive the packaged binary.
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "successor-hosted-smoke-"));
  const runtimeLog = path.join(tempHome, "runtime.log");
  const { _electron } = await import("playwright").catch(() => import("@playwright/test"));
  const app = await _electron.launch({
    executablePath: packagedBinary,
    // Software WebGL for the Xvfb display: modern Chromium refuses the
    // SwiftShader fallback without the explicit unsafe opt-in.
    args: ["--no-sandbox", "--disable-gpu-sandbox", "--enable-unsafe-swiftshader", "--use-angle=swiftshader-webgl"],
    env: {
      ...process.env,
      HOME: tempHome,
      XDG_CONFIG_HOME: path.join(tempHome, ".config"),
      SUCCESSOR_DESKTOP_API_ORIGIN: `http://127.0.0.1:${api.port}`,
      SUCCESSOR_DESKTOP_RUNTIME_LOG: runtimeLog,
      ELECTRON_DISABLE_SANDBOX: "1",
    },
  });
  try {
    const page = await app.firstWindow();
    page.on("console", (message) => console.error("renderer:", message.type(), message.text().slice(0, 600)));
    await page.waitForSelector("#btn-start:visible", { timeout: 30_000 });
    if (!page.url().startsWith("successor://shell/")) fail(`expected shell page, got ${page.url()}`);

    await page.click("#btn-start");
    await page.waitForFunction(() => document.querySelector("#user-code")?.textContent?.length >= 4, null, { timeout: 15_000 });
    const shownCode = (await page.textContent("#user-code")).trim();
    if (shownCode !== USER_CODE) fail(`shell must show the human code; got "${shownCode}"`);

    // Device approval happens "in the browser" (the fake API approves on poll).
    await page.waitForSelector(".roster-row", { timeout: 30_000 });
    const rosterName = await page.textContent(".roster-name");
    if (!rosterName.includes("Smokewalker")) fail("character roster must render from the scoped credential");

    await page.click("#btn-enter");
    await page.waitForFunction(() => window.location.href.startsWith("successor://app/"), null, { timeout: 30_000 });
    const gameUrl = page.url();
    for (const secret of SECRETS) {
      if (gameUrl.includes(secret)) fail("secret leaked into the game URL");
    }
    if (/ticket|credential/i.test(new URL(gameUrl).search)) fail("game URL query must not carry capability material");

    // The real client must attempt the hosted matchmake with the ticket in the
    // BODY; our fake denies it, and the desktop must land back on select.
    const deadline = Date.now() + 120_000;
    while (!game.state.requests.some((row) => row.method === "POST") && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (game.state.requests.length === 0) {
      const tailLog = fs.existsSync(runtimeLog) ? fs.readFileSync(runtimeLog, "utf8").split("\n").slice(-40).join("\n") : "(no runtime log)";
      console.error(tailLog);
      fail("packaged client never reached the hosted game endpoint");
    }
    const matchmake = game.state.requests.find((row) => row.method === "POST");
    if (!matchmake) fail(`expected a matchmake POST against the hosted endpoint; saw ${JSON.stringify(game.state.requests)}`);
    if (!matchmake.body.includes(`${GAME_TICKET}-1`)) fail("game ticket must travel in the matchmake body");
    if (SECRETS.some((secret) => matchmake.url.includes(secret))) fail("ticket leaked into the matchmake URL");
    // Scoped header policy: the hosted world must see the exact configured
    // storefront Origin, and never any account API cookie/bearer material.
    if (matchmake.origin !== `http://127.0.0.1:${api.port}`) fail(`matchmake Origin must be the configured storefront origin; saw ${matchmake.origin}`);
    if (matchmake.cookie !== null || matchmake.authorization !== null) fail("matchmake must not carry cookies or Authorization");

    await page.waitForFunction(
      () => document.querySelector("#plate")?.dataset.stage === "characters"
        && (document.querySelector("#characters-notice")?.textContent ?? "").length > 0,
      null,
      { timeout: 60_000 },
    );
    console.log("hosted-smoke: one-leg failure returned to character select with an honest notice");

    const referrer = await withTimeout(page.evaluate(() => document.referrer), 5_000, "renderer history audit");
    const historyLeak = SECRETS.find((secret) => page.url().includes(secret) || referrer.includes(secret));
    if (historyLeak) fail("secret visible to the shell renderer surfaces");
  } finally {
    const appProcess = app.process();
    try {
      await withTimeout(app.close(), 5_000, "Electron close");
    } catch {
      appProcess.kill("SIGKILL");
    }
    api.server.close();
    game.server.close();
    chat.server.close();
  }

  // 4) Runtime log hygiene + no local shard.
  const log = fs.readFileSync(runtimeLog, "utf8");
  for (const secret of SECRETS) {
    if (log.includes(secret)) fail("secret leaked into the runtime log");
  }
  if (log.includes(USER_CODE)) fail("human device code leaked into the runtime log");
  if (log.includes("game-server-spawn")) fail("hosted mode must never start the local shard");
  if (!log.includes("hosted-shell-open")) fail("hosted shell open event missing from the log");
  const handoffs = log.split("\n").filter((line) => line.includes("hosted-launch-handoff")).length;
  if (handoffs !== 1) fail(`launch envelope must cross IPC exactly once; saw ${handoffs}`);

  console.log("hosted-smoke: PASS — packaged hosted login, one-use envelope, no local shard, no secret leaks");
}

main().catch((error) => {
  console.error(error?.stack ?? String(error));
  process.exitCode = 1;
});
