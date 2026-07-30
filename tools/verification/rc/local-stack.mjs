import fs from "node:fs/promises";
import fsSync from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { createProcessHost } from "../lib/process-host.mjs";
import { assertPrivatePath, assertRegularFileUnderWorktree, ensurePrivateDirectory } from "./path-security.mjs";

const LOOPBACK = "127.0.0.1";
const DEFAULT_TIMEOUT_MS = 30_000;
const MIME = new Map([
  [".html", "text/html; charset=utf-8"], [".js", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"], [".json", "application/json; charset=utf-8"],
  [".png", "image/png"], [".jpg", "image/jpeg"], [".svg", "image/svg+xml"],
  [".woff2", "font/woff2"], [".wasm", "application/wasm"],
]);
const PROXY_PREFIXES = ["/alpha-api/", "/matchmake/", "/game", "/chat", "/healthz", "/version"];
const EDGE_CONNECTIONS = new WeakMap();

/**
 * Start the real local chain. The server is the real standalone authority and
 * the two TLS edges only provide production-shaped origins and static assets.
 * No browser/game authority is faked here.
 */
export async function startLocalStack({ repoRoot, runRoot, sha, signal, onEvent, build = ensureBuilds } = {}) {
  const root = path.resolve(String(repoRoot ?? ""));
  const run = path.resolve(String(runRoot ?? ""));
  if (!root || root === path.parse(root).root) throw new Error("repoRoot is required");
  if (!run || run === path.parse(run).root) throw new Error("runRoot is required");
  const releaseId = releaseForSha(sha);
  const privateRoot = path.join(run, "private");
  const stateRoot = path.join(privateRoot, "state");
  const logsRoot = path.join(run, "logs");
  await ensurePrivateDirectory(run, "private/state");
  await ensurePrivateDirectory(run, "logs");
  await ensurePrivateDirectory(run, "pids");

  assertAbort(signal);
  const claimSecret = crypto.randomBytes(32).toString("base64url");
  try { onEvent?.({ type: "secret.minted", atMs: 0, mintedSecrets: [claimSecret] }); } catch { /* registration is repeated on the returned stack */ }
  const ports = await allocatePorts(3);
  const controlPort = ports[0];
  const sitePort = ports[1];
  const clientPort = ports[2];
  const controlUrl = `http://${LOOPBACK}:${controlPort}`;
  const siteUrl = `https://${LOOPBACK}:${sitePort}`;
  const clientUrl = `https://${LOOPBACK}:${clientPort}`;
  const serverEntry = path.join(root, "server", "dist", "index.js");
  const siteDist = path.join(root, "site", "dist");
  const clientDist = path.join(root, "client-3d", "dist");
  const tuiDist = path.join(root, "client-tui", "dist", "cli.js");
  const rustBridge = path.join(root, "target", "debug", "examples", "authority_bridge_server");
  await build({ root, logsRoot, releaseId, siteUrl, clientUrl, signal });
  for (const [label, candidate] of [["site", siteDist], ["client", clientDist]]) {
    if (!fsSync.existsSync(candidate)) throw new Error(`${label} build output is missing: ${candidate}`);
  }
  await assertRegularFileUnderWorktree(root, serverEntry, "serverEntry");
  await assertRegularFileUnderWorktree(root, rustBridge, "rustBridge");
  await assertRegularFileUnderWorktree(root, tuiDist, "TUI client");
  const shardId = `rc-${String(sha).slice(0, 12).toLowerCase()}-${safePart(path.basename(run))}`;
  const stateDb = path.join(stateRoot, "alpha-control.sqlite");
  const characterStore = path.join(stateRoot, "characters.json");
  for (const candidate of [stateDb, characterStore, path.join(stateRoot, `${shardId}.checkpoint.json`), path.join(stateRoot, `${shardId}.journal.jsonl`), path.join(stateRoot, "state-generation.manifest.json")]) await assertPrivatePath(run, candidate);
  const serverHost = createProcessHost({ runId: `rc-${safePart(path.basename(run))}`, runDir: run, kind: "child" });
  const handles = { server: null };
  const secrets = [claimSecret];
  let server = null;
  let siteEdge = null;
  let clientEdge = null;
  let stopped = false;
  let stopping = null;
  const startedAt = Date.now();
  const emit = (type, fields = {}) => {
    try { onEvent?.({ type, atMs: Date.now() - startedAt, ...boundedFields(fields) }); } catch { /* evidence callbacks must not break teardown */ }
  };

  const cleanup = async () => {
    if (stopping) return stopping;
    stopping = (async () => {
      stopped = true;
      emit("stack.stop.begin");
      const failures = [];
      const edgeResults = await Promise.allSettled([closeEdge(clientEdge), closeEdge(siteEdge)]);
      for (const result of edgeResults) if (result.status === "rejected") failures.push(`edge: ${result.reason?.message ?? result.reason}`);
      clientEdge = null;
      siteEdge = null;
      if (handles.server) {
        const result = await serverHost.stop(handles.server, { graceMs: 8_000 }).catch((error) => ({ ok: false, failures: [String(error)] }));
        emit("process.stop", { name: "server", ok: result.ok, finalState: result.finalState });
        if (!result.ok) failures.push(`server: ${(result.failures ?? ["stop failed"]).join("; ")}`);
        handles.server = null;
      }
      await scrubLogs(logsRoot, secrets).catch((error) => failures.push(`log scrub: ${error.message}`));
      await fs.rm(path.join(privateRoot, "tls"), { recursive: true, force: true }).catch((error) => failures.push(`tls cleanup: ${error.message}`));
      emit("stack.stop.done", { ok: failures.length === 0 });
      if (failures.length) throw infrastructureError(`local stack cleanup failed: ${failures.join(" | ")}`);
      return { ok: true };
    })();
    return stopping;
  };
  const abortHandler = () => { void cleanup().catch(() => undefined); };
  signal?.addEventListener("abort", abortHandler, { once: true });

  try {
    const tls = await createLoopbackTls(path.join(privateRoot, "tls"));
    const env = sterileEnv({
      HOST: LOOPBACK,
      PORT: String(controlPort),
      NODE_ENV: "development",
      LOG_LEVEL: "warn",
      SUCCESSOR_CONTROL_PLANE_MODE: "standalone",
      ALPHA_CONTROL_DB_PATH: stateDb,
      ALPHA_CONTROL_CLAIM_SECRET: claimSecret,
      SUCCESSOR_ALPHA_ORIGIN: siteUrl,
      SUCCESSOR_ALPHA_CLIENT_ORIGIN: clientUrl,
      SUCCESSOR_ALPHA_GAME_ENDPOINT: `wss://${LOOPBACK}:${sitePort}/game/ws`,
      SUCCESSOR_ALPHA_CHAT_ENDPOINT: `wss://${LOOPBACK}:${sitePort}/chat/ws`,
      SUCCESSOR_ALPHA_REGISTRATION_OPEN: "true",
      SUCCESSOR_ALPHA_REGISTRATION_CAP: "3",
      SUCCESSOR_CLIENT_RELEASE_ID: releaseId,
      SUCCESSOR_SERVER_RELEASE_ID: releaseId,
      SUCCESSOR_ALPHA_CLIENT_RELEASE_ALLOWLIST: releaseId,
      SUCCESSOR_SHARD_ID: shardId,
      GAME_SHARD_ID: shardId,
      GAME_SHARD_PERSISTENCE: "1",
      GAME_SHARD_STATE_DIR: stateRoot,
      GAME_CHARACTER_STORE_PATH: characterStore,
      GAME_RUST_AUTHORITY_BRIDGE_BIN: rustBridge,
      GAME_SHARD_CHECKPOINT_PATH: path.join(stateRoot, `${shardId}.checkpoint.json`),
      GAME_SHARD_JOURNAL_PATH: path.join(stateRoot, `${shardId}.journal.jsonl`),
      GAME_SHARD_MANIFEST_PATH: path.join(stateRoot, "state-generation.manifest.json"),
    });
    handles.server = await serverHost.start({
      name: `rc-server-${controlPort}`,
      argv: [process.execPath, serverEntry],
      cwd: root,
      env,
    });
    emit("process.start", { name: "server", pid: handles.server.pid });

    server = await waitForBackend(controlUrl, DEFAULT_TIMEOUT_MS, signal);
    siteEdge = await createEdge({ name: "site", staticRoot: siteDist, backendPort: controlPort, tls, port: sitePort, origin: siteUrl, clientOrigin: clientUrl, releaseId, sourceCommit: String(sha).toLowerCase(), onEvent: emit });
    clientEdge = await createEdge({ name: "client", staticRoot: clientDist, backendPort: controlPort, tls, port: clientPort, origin: clientUrl, clientOrigin: clientUrl, releaseId, sourceCommit: String(sha).toLowerCase(), onEvent: emit });
    await waitForEdges(siteUrl, clientUrl, DEFAULT_TIMEOUT_MS, signal);
    emit("stack.ready", { sitePort, clientPort, controlPort, releaseId });

    const stack = {
      siteUrl,
      clientUrl,
      gameEndpoint: `wss://${LOOPBACK}:${sitePort}/game/ws`,
      controlUrl,
      repoRoot: root,
      runId: safePart(path.basename(run)),
      mintedSecrets: [claimSecret],
      registerSensitive(values) {
        const additions = [...new Set((values ?? []).filter((value) => typeof value === "string" && value.length > 0))];
        secrets.push(...additions);
        if (additions.length) onEvent?.({ type: "secret.minted", atMs: Date.now() - startedAt, mintedSecrets: additions });
      },
      releaseId,
      shardId,
      ports: { site: sitePort, client: clientPort, control: controlPort },
      async probe() {
        if (stopped) return { ready: false, reason: "stopped" };
        const [backend, site, client] = await Promise.all([
          probeJson(`${controlUrl}/healthz`),
          probeOrigin(siteUrl, "/"),
          probeOrigin(clientUrl, "/current.json"),
        ]);
        const ready = backend.ok === true && site.ok && client.ok && (!server?.readiness || server.readiness.ready !== false);
        return { ready, backend, site, client, releaseId, shardId };
      },
      async stop() {
        await cleanup();
        signal?.removeEventListener("abort", abortHandler);
        return { ok: true };
      },
    };
    const initial = await stack.probe();
    if (!initial.ready) throw new Error(`local stack readiness failed: ${JSON.stringify(redactProbe(initial))}`);
    return stack;
  } catch (error) {
    try { await cleanup(); } catch (cleanupError) { if (error && typeof error === "object") error.cause = cleanupError; }
    signal?.removeEventListener("abort", abortHandler);
    throw error;
  }
}

async function ensureBuilds({ root, logsRoot, releaseId, siteUrl, clientUrl, signal }) {
  assertAbort(signal);
  const tmpDir = path.join(path.dirname(logsRoot), "private", "tmp");
  await fs.mkdir(tmpDir, { recursive: true, mode: 0o700 });
  const common = sterileEnv({ CI: "1", CARGO_INCREMENTAL: "0", TMPDIR: tmpDir });
  await runBuild("install", ["pnpm", "install", "--offline", "--frozen-lockfile"], root, logsRoot, common, signal);
  const clientEnv = sterileEnv({
    CI: "1",
    SUCCESSOR_PACKAGE_MODE: "hosted-release",
    SUCCESSOR_CLIENT_RELEASE_ID: releaseId,
    SUCCESSOR_STOREFRONT_ORIGIN: siteUrl,
    SUCCESSOR_GAME_ORIGIN: siteUrl.replace(/^https:/u, "wss:"),
    SUCCESSOR_CHAT_ORIGIN: siteUrl.replace(/^https:/u, "wss:"),
  });
  const builds = [
    ["server", ["pnpm", "--dir", "server", "build"], common],
    ["site", ["pnpm", "--dir", "site", "build"], common],
    ["client", ["pnpm", "--dir", "client-3d", "build"], clientEnv],
    ["tui", ["pnpm", "--dir", "client-tui", "build"], common],
    ["rust", ["cargo", "build", "-p", "successor-sim", "--example", "authority_bridge_server", "--locked"], common],
  ];
  const controller = new AbortController();
  const abortFromParent = () => controller.abort();
  signal?.addEventListener("abort", abortFromParent, { once: true });
  const promises = builds.map(([name, argv, env]) => runBuild(name, argv, root, logsRoot, env, controller.signal).catch((error) => { controller.abort(); throw error; }));
  const results = await Promise.allSettled(promises);
  signal?.removeEventListener("abort", abortFromParent);
  const failure = results.find((result) => result.status === "rejected");
  if (failure) throw failure.reason;
  assertAbort(signal);
}

async function runBuild(name, argv, cwd, logsRoot, env, signal) {
  const logPath = path.join(logsRoot, `build-${name}.log`);
  const handle = fsSync.openSync(logPath, fsSync.constants.O_WRONLY | fsSync.constants.O_CREAT | fsSync.constants.O_TRUNC | fsSync.constants.O_NOFOLLOW, 0o600);
  fsSync.fchmodSync(handle, 0o600);
  try {
    await new Promise((resolve, reject) => {
      if (signal?.aborted) { reject(infrastructureError(`${name} build cancelled before start`)); return; }
      const child = spawn(argv[0], argv.slice(1), { cwd, env, detached: true, stdio: ["ignore", handle, handle] });
      let failure = null;
      let killTimer = null;
      let settled = false;
      const terminate = () => {
        if (!child.pid) return;
        try { process.kill(-child.pid, "SIGTERM"); } catch { child.kill("SIGTERM"); }
        killTimer ??= setTimeout(() => { try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); } }, 5_000);
      };
      const onAbort = () => { failure ??= infrastructureError(`${name} build cancelled after sibling failure`); terminate(); };
      signal?.addEventListener("abort", onAbort, { once: true });
      const timeout = setTimeout(() => { failure ??= infrastructureError(`${name} build timed out; see ${logPath}`); terminate(); }, 15 * 60_000);
      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (killTimer) clearTimeout(killTimer);
        signal?.removeEventListener("abort", onAbort);
        if (error) reject(error); else resolve();
      };
      child.once("error", (error) => finish(infrastructureError(`${name} build failed (${error.code ?? error.message}); see ${logPath}`)));
      child.once("close", (code, closeSignal) => {
        if (failure) finish(failure);
        else if (code === 0) finish(null);
        else finish(infrastructureError(`${name} build failed (${closeSignal ?? code}); see ${logPath}`));
      });
    });
  } finally {
    fsSync.closeSync(handle);
  }
}

function infrastructureError(message) { const error = new Error(message); error.infrastructure = true; return error; }

function releaseForSha(value) {
  const sha = String(value ?? "").trim();
  if (!/^[0-9a-f]{40}$/iu.test(sha)) throw new Error("sha must be a full 40-character hexadecimal commit");
  return `successor-rc@${sha.slice(0, 16).toLowerCase()}`;
}

function safePart(value) { return String(value).replace(/[^A-Za-z0-9_.-]/gu, "-").slice(0, 32) || "run"; }
function assertAbort(signal) { if (signal?.aborted) throw abortError(); }
function abortError() { const error = new Error("local stack start aborted"); error.name = "AbortError"; return error; }

function sterileEnv(values) {
  const env = Object.fromEntries(Object.keys(process.env).map((key) => [key, undefined]));
  for (const key of ["PATH", "HOME", "TMPDIR", "LANG", "TZ"]) if (process.env[key]) env[key] = process.env[key];
  Object.assign(env, values);
  return env;
}

async function allocatePorts(count) {
  const ports = [];
  const servers = [];
  try {
    for (let i = 0; i < count; i += 1) {
      const holder = net.createServer();
      await new Promise((resolve, reject) => { holder.once("error", reject); holder.listen({ host: LOOPBACK, port: 0 }, resolve); });
      ports.push(holder.address().port);
      servers.push(holder);
    }
  } finally {
    await Promise.all(servers.map((holder) => new Promise((resolve) => holder.close(() => resolve()))));
  }
  return ports;
}

async function waitForBackend(base, timeoutMs, signal) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    assertAbort(signal);
    try {
      const [health, status] = await Promise.all([requestJson(`${base}/healthz`), requestJson(`${base}/game/status`)]);
      if (health?.ok === true && (status?.shardId || status?.readiness?.ready === true)) return status;
      lastError = new Error("backend returned non-ready status");
    } catch (error) { lastError = error; }
    await delay(120);
  }
  throw new Error(`local authority never became ready: ${lastError?.message ?? "timeout"}`);
}

async function createEdge({ name, staticRoot, backendPort, tls, port, origin, clientOrigin, releaseId, sourceCommit, onEvent }) {
  const edge = https.createServer(tls, (request, response) => {
    if (isProxyPath(request.url ?? "/")) return proxyHttp(request, response, backendPort);
    return serveStatic(request, response, staticRoot, { origin, clientOrigin, releaseId, sourceCommit });
  });
  const connections = new Set();
  EDGE_CONNECTIONS.set(edge, connections);
  edge.on("connection", (socket) => { connections.add(socket); socket.once("close", () => connections.delete(socket)); });
  edge.on("upgrade", (request, socket, head) => proxyUpgrade(request, socket, head, backendPort, connections));
  await new Promise((resolve, reject) => { edge.once("error", reject); edge.listen({ host: LOOPBACK, port }, resolve); });
  onEvent("edge.ready", { name, port });
  return edge;
}

function isProxyPath(url) { const pathname = new URL(url, "http://local").pathname; return PROXY_PREFIXES.some((prefix) => pathname === prefix.slice(0, -1) || pathname.startsWith(prefix)) || /^\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+$/u.test(pathname); }
function proxyHttp(request, response, backendPort) {
  const upstream = http.request({ host: LOOPBACK, port: backendPort, path: request.url, method: request.method, headers: { ...request.headers, host: `${LOOPBACK}:${backendPort}`, connection: "close" } }, (reply) => {
    response.writeHead(reply.statusCode ?? 502, reply.headers);
    reply.pipe(response);
  });
  upstream.on("error", () => { if (!response.headersSent) response.writeHead(502); response.end(); });
  request.pipe(upstream);
}
function proxyUpgrade(request, socket, head, backendPort, connections) {
  const upstream = http.request({ host: LOOPBACK, port: backendPort, path: request.url, method: "GET", headers: { ...request.headers, host: `${LOOPBACK}:${backendPort}`, connection: "Upgrade" } });
  upstream.once("upgrade", (reply, upstreamSocket, upstreamHead) => {
    connections?.add(upstreamSocket);
    upstreamSocket.once("close", () => connections?.delete(upstreamSocket));
    socket.write(`HTTP/1.1 101 Switching Protocols\r\n${Object.entries(reply.headers).map(([key, value]) => `${key}: ${value}`).join("\r\n")}\r\n\r\n`);
    if (upstreamHead?.length) socket.write(upstreamHead);
    if (head?.length) upstreamSocket.write(head);
    socket.pipe(upstreamSocket).pipe(socket);
  });
  upstream.on("response", (reply) => { socket.write(`HTTP/1.1 ${reply.statusCode ?? 502} ${reply.statusMessage ?? "Bad Gateway"}\r\nConnection: close\r\n\r\n`); socket.destroy(); });
  upstream.on("error", () => socket.destroy());
  upstream.end();
}

async function serveStatic(request, response, root, { origin, clientOrigin, releaseId, sourceCommit }) {
  let pathname;
  try { pathname = decodeURIComponent(new URL(request.url ?? "/", "http://local").pathname); } catch { response.writeHead(400); response.end(); return; }
  if (pathname === "/client/release.json") {
    const body = JSON.stringify({ schema: "successor.client-runtime-pointer.v1", entry: `${clientOrigin}/index.html`, manifestSha256: crypto.createHash("sha256").update(releaseId).digest("hex"), sourceCommit, clientReleaseId: releaseId });
    response.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }); response.end(body); return;
  }
  if (pathname === "/current.json") {
    const file = path.join(root, "current.json");
    try {
      const pointer = JSON.parse((await readStaticFile(root, file)).toString("utf8"));
      const base = `${clientOrigin}/`;
      const body = JSON.stringify({ ...pointer, releaseId, launchPage: `${base}index.html`, entryScript: pointer.entryScript?.replace(/^https?:\/\/[^/]+/u, clientOrigin), styles: Array.isArray(pointer.styles) ? pointer.styles.map((value) => value.replace(/^https?:\/\/[^/]+/u, clientOrigin)) : pointer.styles, assetBaseUrl: base, storeOrigin: origin });
      response.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }); response.end(body); return;
    } catch { /* fall through to normal static handling */ }
  }
  const relative = pathname === "/" ? "/index.html" : pathname.endsWith("/") ? `${pathname}index.html` : pathname;
  const file = path.resolve(root, `.${relative}`);
  if (!file.startsWith(`${path.resolve(root)}${path.sep}`) && file !== path.resolve(root, "index.html")) { response.writeHead(403); response.end(); return; }
  try {
    const body = await readStaticFile(root, file);
    response.writeHead(200, { "content-type": MIME.get(path.extname(file).toLowerCase()) ?? "application/octet-stream", "cache-control": "no-store" }); response.end(body);
  } catch (error) { response.writeHead(error?.code === "ENOENT" ? 404 : error?.code === "EACCES" ? 403 : 500); response.end(); }
}

async function readStaticFile(root, candidate) {
  const absoluteRoot = path.resolve(root);
  const absoluteCandidate = path.resolve(candidate);
  const relative = path.relative(absoluteRoot, absoluteCandidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw Object.assign(new Error("static path escapes root"), { code: "EACCES" });
  let cursor = absoluteRoot;
  for (const part of relative.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    const metadata = await fs.lstat(cursor);
    if (metadata.isSymbolicLink()) throw Object.assign(new Error("static symlink refused"), { code: "EACCES" });
  }
  const [realRoot, realFile] = await Promise.all([fs.realpath(absoluteRoot), fs.realpath(absoluteCandidate)]);
  const realRelative = path.relative(realRoot, realFile);
  if (realRelative.startsWith("..") || path.isAbsolute(realRelative)) throw Object.assign(new Error("static target escapes root"), { code: "EACCES" });
  const metadata = await fs.stat(realFile);
  if (!metadata.isFile()) throw Object.assign(new Error("static target is not a file"), { code: "ENOENT" });
  return fs.readFile(realFile);
}

async function waitForEdges(siteUrl, clientUrl, timeoutMs, signal) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    assertAbort(signal);
    try {
      const [site, client] = await Promise.all([probeOrigin(siteUrl, "/"), probeOrigin(clientUrl, "/current.json")]);
      if (site.ok && client.ok) return;
      lastError = new Error("edge returned non-success status");
    } catch (error) { lastError = error; }
    await delay(100);
  }
  throw new Error(`local TLS edges never became ready: ${lastError?.message ?? "timeout"}`);
}

function probeOrigin(origin, pathname) { return requestJson(`${origin}${pathname}`, true).then((body) => ({ ok: true, status: body.status, body: body.value })).catch((error) => ({ ok: false, error: error.message })); }
function probeJson(url) { return requestJson(url).then((value) => ({ ok: value.ok ?? true, value })).catch((error) => ({ ok: false, error: error.message })); }
function requestJson(url, tls = false) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const request = (tls ? https : http).get({ protocol: parsed.protocol, hostname: parsed.hostname, port: parsed.port, path: `${parsed.pathname}${parsed.search}`, rejectUnauthorized: false, timeout: 2_000 }, (response) => {
      const chunks = []; response.on("data", (chunk) => chunks.push(chunk)); response.on("end", () => { const text = Buffer.concat(chunks).toString("utf8"); let value = text; try { value = JSON.parse(text); } catch { /* static body */ } resolve(tls ? { status: response.statusCode, value } : value); });
    });
    request.on("timeout", () => request.destroy(new Error("request timeout")));
    request.on("error", reject);
  });
}
function probeJsonUnused() { return undefined; }
function redactProbe(value) { return JSON.parse(JSON.stringify(value, (key, item) => /token|secret|ticket|cookie|password|credential/iu.test(key) ? "<redacted>" : item)); }
function boundedFields(fields) { return Object.fromEntries(Object.entries(fields).filter(([key, value]) => ["name", "pid", "port", "sitePort", "clientPort", "controlPort", "releaseId", "ok", "finalState"].includes(key) && (typeof value === "string" || typeof value === "number" || typeof value === "boolean" || value === null))); }
async function closeEdge(edge) {
  if (!edge) return;
  const connections = EDGE_CONNECTIONS.get(edge) ?? new Set();
  await new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(forceTimer);
      clearTimeout(failTimer);
      if (error) reject(error); else resolve();
    };
    const forceTimer = setTimeout(() => {
      for (const socket of connections) socket.destroy();
      edge.closeAllConnections?.();
    }, 1_500);
    const failTimer = setTimeout(() => finish(new Error("local TLS edge did not close")), 5_000);
    edge.close((error) => finish(error));
  });
  EDGE_CONNECTIONS.delete(edge);
}
async function scrubLogs(logDir, secrets) {
  const entries = await fs.readdir(logDir, { withFileTypes: true }).catch(() => []);
  await Promise.all(entries.filter((entry) => entry.isFile()).map(async (entry) => {
    const file = path.join(logDir, entry.name);
    const handle = await fs.open(file, fsSync.constants.O_RDWR | fsSync.constants.O_NOFOLLOW);
    try {
      const metadata = await handle.stat();
      if (!metadata.isFile()) throw new Error(`RC log is not a regular file: ${entry.name}`);
      const text = await handle.readFile({ encoding: "utf8" });
      const clean = secrets.reduce((out, secret) => out.replaceAll(secret, "<redacted>"), text);
      if (clean !== text) {
        await handle.truncate(0);
        await handle.write(clean, 0, "utf8");
      }
    } finally {
      await handle.close();
    }
  }));
}
function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

export async function createLoopbackTls(dir) {
  const runRoot = path.dirname(path.dirname(dir));
  await ensurePrivateDirectory(runRoot, path.basename(path.dirname(dir)) + "/tls");
  const keyPath = path.join(dir, "key.pem");
  const certPath = path.join(dir, "cert.pem");
  await assertPrivatePath(runRoot, keyPath);
  await assertPrivatePath(runRoot, certPath);
  if (!fsSync.existsSync(keyPath) || !fsSync.existsSync(certPath)) {
    const generationDir = await fs.mkdtemp(path.join(dir, ".generate-"));
    await fs.chmod(generationDir, 0o700);
    const generatedKey = path.join(generationDir, "key.pem");
    const generatedCert = path.join(generationDir, "cert.pem");
    try {
      const result = spawnSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1", "-keyout", generatedKey, "-out", generatedCert], { stdio: "ignore", timeout: 15_000 });
      if (result.error || result.status !== 0) throw new Error(`openssl is required for local TLS (${result.error?.code ?? result.status})`);
      await requireRegularNoFollow(generatedKey, 0o600);
      await requireRegularNoFollow(generatedCert, 0o600);
      await fs.rename(generatedKey, keyPath);
      await fs.rename(generatedCert, certPath);
    } finally {
      await fs.rm(generationDir, { recursive: true, force: true });
    }
  }
  return { key: await requireRegularNoFollow(keyPath, 0o600), cert: await requireRegularNoFollow(certPath, 0o600) };
}

async function requireRegularNoFollow(file, mode) {
  const handle = await fs.open(file, fsSync.constants.O_RDONLY | fsSync.constants.O_NOFOLLOW);
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) throw new Error(`RC TLS path is not a regular file: ${path.basename(file)}`);
    await handle.chmod(mode);
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}
