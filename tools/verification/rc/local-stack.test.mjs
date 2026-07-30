import assert from "node:assert/strict";
import fs from "node:fs/promises";
import net from "node:net";
import https from "node:https";
import path from "node:path";
import test from "node:test";
import { tmpdir } from "node:os";
import { createLoopbackTls, startLocalStack } from "./local-stack.mjs";

const SHA = "f07c47d00ee804c88662576a4ed6ca69cadf432f";

test("local stack starts, probes edges, and stops owned process and ports", async () => {
  const root = await fs.mkdtemp(path.join(tmpdir(), "successor-rc-stack-repo-"));
  const runRoot = await fs.mkdtemp(path.join(tmpdir(), "successor-rc-stack-run-"));
  try {
    await fs.mkdir(path.join(root, "server", "dist"), { recursive: true });
    await fs.mkdir(path.join(root, "site", "dist"), { recursive: true });
    await fs.mkdir(path.join(root, "client-3d", "dist"), { recursive: true });
    await fs.mkdir(path.join(root, "client-tui", "dist"), { recursive: true });
    await fs.mkdir(path.join(root, "target", "debug", "examples"), { recursive: true });
    await fs.writeFile(path.join(root, "target", "debug", "examples", "authority_bridge_server"), "fixture", "utf8");
    await fs.writeFile(path.join(root, "server", "dist", "index.js"), `
      const http = require("node:http");
      const body = (res, value) => { res.writeHead(200, {"content-type":"application/json"}); res.end(JSON.stringify(value)); };
      const server = http.createServer((req, res) => {
        if (req.url === "/healthz") return body(res, {ok:true});
        if (req.url === "/game/status") return body(res, {shardId: process.env.GAME_SHARD_ID, readiness:{ready:true}});
        if (req.method === "POST" && req.url === "/matchmake/joinOrCreate/game") return body(res, {proxied:true});
        res.writeHead(404); res.end();
      });
      server.listen(Number(process.env.PORT), process.env.HOST);
      process.on("SIGTERM", () => server.close(() => process.exit(0)));
    `, "utf8");
    await fs.writeFile(path.join(root, "site", "dist", "index.html"), "<!doctype html><title>site</title>", "utf8");
    const outsideStatic = path.join(runRoot, "outside-static.txt");
    await fs.writeFile(outsideStatic, "must-not-be-served", "utf8");
    await fs.symlink(outsideStatic, path.join(root, "site", "dist", "leak.txt"));
    await fs.writeFile(path.join(root, "client-3d", "dist", "index.html"), "<!doctype html><title>client</title>", "utf8");
    await fs.writeFile(path.join(root, "client-3d", "dist", "current.json"), JSON.stringify({ releaseId: "old", launchPage: "old", entryScript: "old", styles: [], assetBaseUrl: "old", storeOrigin: "old" }), "utf8");
    await fs.writeFile(path.join(root, "client-tui", "dist", "cli.js"), "#!/usr/bin/env node\n", "utf8");
    const events = [];
    const stack = await startLocalStack({ repoRoot: root, runRoot, sha: SHA, build: async () => {}, onEvent: (event) => events.push(event) });
    assert.equal((await stack.probe()).ready, true);
    assert.match(stack.siteUrl, /^https:\/\/127\.0\.0\.1:\d+$/u);
    assert.match(stack.clientUrl, /^https:\/\/127\.0\.0\.1:\d+$/u);
    assert.match(stack.controlUrl, /^http:\/\/127\.0\.0\.1:\d+$/u);
    const runtimePointer = await getJson(`${stack.siteUrl}/client/release.json`);
    assert.equal(runtimePointer.schema, "successor.client-runtime-pointer.v1");
    assert.equal(runtimePointer.sourceCommit, SHA);
    assert.equal(runtimePointer.clientReleaseId, `successor-rc@${SHA.slice(0, 16)}`);
    assert.equal(runtimePointer.entry, `${stack.clientUrl}/index.html`);
    assert.equal(stack.mintedSecrets.length, 1);
    assert.equal(await getStatus(`${stack.siteUrl}/leak.txt`), 403);
    assert.deepEqual(await postJson(`${stack.siteUrl}/matchmake/joinOrCreate/game`), { proxied: true });
    assert.ok(events.some((event) => event.type === "stack.ready"));
    const ports = Object.values(stack.ports);
    await stack.stop();
    await stack.stop();
    assert.equal((await stack.probe()).ready, false);
    for (const port of ports) await assert.rejects(connect(port), /ECONNREFUSED|socket hang up|timeout/u);
    const logs = await readTree(path.join(runRoot, "logs"));
    assert.doesNotMatch(logs, /ALPHA_CONTROL_CLAIM_SECRET|[A-Za-z0-9_-]{43}/u);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(runRoot, { recursive: true, force: true });
  }
});

test("local stack refuses a symlinked build log before writing outside the run root", async () => {
  const root = await fs.mkdtemp(path.join(tmpdir(), "successor-rc-stack-log-repo-"));
  const runRoot = await fs.mkdtemp(path.join(tmpdir(), "successor-rc-stack-log-run-"));
  const outside = path.join(tmpdir(), `successor-rc-build-log-${process.pid}-${Date.now()}.txt`);
  try {
    await fs.mkdir(path.join(runRoot, "logs"), { mode: 0o700 });
    await fs.writeFile(outside, "sentinel", { encoding: "utf8", mode: 0o600 });
    await fs.symlink(outside, path.join(runRoot, "logs", "build-install.log"));
    await assert.rejects(startLocalStack({ repoRoot: root, runRoot, sha: SHA }), /ELOOP|symbolic link/iu);
    assert.equal(await fs.readFile(outside, "utf8"), "sentinel");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(runRoot, { recursive: true, force: true });
    await fs.rm(outside, { force: true });
  }
});

test("local TLS generation refuses preexisting key symlinks without changing their target", async () => {
  const runRoot = await fs.mkdtemp(path.join(tmpdir(), "successor-rc-tls-run-"));
  const tlsRoot = path.join(runRoot, "private", "tls");
  const outside = path.join(tmpdir(), `successor-rc-tls-outside-${process.pid}-${Date.now()}.pem`);
  try {
    await fs.mkdir(tlsRoot, { recursive: true, mode: 0o700 });
    await fs.writeFile(outside, "sentinel", { encoding: "utf8", mode: 0o600 });
    await fs.symlink(outside, path.join(tlsRoot, "key.pem"));
    await assert.rejects(createLoopbackTls(tlsRoot), /private file symlink refused/iu);
    assert.equal(await fs.readFile(outside, "utf8"), "sentinel");
  } finally {
    await fs.rm(runRoot, { recursive: true, force: true });
    await fs.rm(outside, { force: true });
  }
});

test("local stack refuses an abbreviated commit", async () => {
  await assert.rejects(startLocalStack({ repoRoot: "/does/not/exist", runRoot: "/does/not/exist", sha: "f07c47d0" }), /full 40-character/u);
});

function connect(port) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1");
    socket.setTimeout(800, () => { socket.destroy(); reject(new Error("timeout")); });
    socket.once("error", reject);
    socket.once("connect", () => { socket.destroy(); resolve(); });
  });
}
async function readTree(root) {
  let output = "";
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) output += await readTree(file);
    else output += await fs.readFile(file, "utf8").catch(() => "");
  }
  return output;
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, { rejectUnauthorized: false, timeout: 2_000 }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
        catch (error) { reject(error); }
      });
    });
    request.on("timeout", () => request.destroy(new Error("request timeout")));
    request.on("error", reject);
  });
}

function getStatus(url) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, { rejectUnauthorized: false, timeout: 2_000 }, (response) => {
      response.resume();
      response.on("end", () => resolve(response.statusCode));
    });
    request.on("timeout", () => request.destroy(new Error("request timeout")));
    request.on("error", reject);
  });
}

function postJson(url) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const request = https.request({ hostname: parsed.hostname, port: parsed.port, path: parsed.pathname, method: "POST", rejectUnauthorized: false, timeout: 2_000, headers: { "content-type": "application/json" } }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
        catch (error) { reject(error); }
      });
    });
    request.on("timeout", () => request.destroy(new Error("request timeout")));
    request.on("error", reject);
    request.end("{}");
  });
}
