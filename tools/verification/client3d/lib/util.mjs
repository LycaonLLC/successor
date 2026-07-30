// Shared utilities for the client-3d journey harness.
// Small, dependency-free helpers: HTTP JSON, ports, and IO.
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";


/** Resolve the repository root from a script directory, never from process.cwd(). */
export function repoRootFrom(startDir) {
  const start = path.resolve(startDir);
  const git = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd: start, encoding: "utf8" });
  if (git.status === 0 && git.stdout.trim()) return git.stdout.trim();
  let cursor = start;
  for (;;) {
    if (fs.existsSync(path.join(cursor, "pnpm-workspace.yaml")) && fs.existsSync(path.join(cursor, "package.json"))) return cursor;
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  throw new Error(`unable to resolve repo root from ${start}`);
}
/** Return true when `candidate` is the root itself or is nested beneath it. */
function isWithin(root, candidate) {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(candidate);
  return resolvedCandidate === resolvedRoot || resolvedCandidate.startsWith(`${resolvedRoot}${path.sep}`);
}

/**
 * Keep headed-Chromium user data outside the checkout and collected artifact
 * tree. The profile is volatile runtime state, not farm evidence.
 */
export function assertOutsideArtifactRoots(candidate, { repoRoot, artifactRoot } = {}) {
  if (typeof candidate !== "string" || !path.isAbsolute(candidate)) throw new Error("browser runtime root must be absolute");
  for (const [label, root] of [["repository", repoRoot], ["artifact", artifactRoot]]) {
    if (typeof root === "string" && isWithin(root, candidate)) {
      throw new Error(`browser runtime root must not be beneath the ${label} root`);
    }
  }
  return candidate;
}

/** Create a unique, run-owned volatile root and prove it cannot be collected. */
export function createBrowserRuntimeRoot({ runId, repoRoot, artifactRoot } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `successor-client3d-${safeName(runId ?? "run")}-`));
  try {
    return assertOutsideArtifactRoots(root, { repoRoot, artifactRoot });
  } catch (error) {
    fs.rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

export function removeBrowserRuntimeRoot(root) {
  if (typeof root !== "string" || !path.isAbsolute(root)) throw new Error("browser runtime root must be absolute");
  fs.rmSync(root, { recursive: true, force: true });
}

export function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

export function stamp() {
  return new Date().toISOString().replace(/[-:]/gu, "").replace(/\.\d{3}Z$/u, "Z");
}

export function safeName(value) {
  return String(value).replace(/[^a-zA-Z0-9_.-]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 96) || "run";
}

export function round(value, places = 3) {
  const factor = 10 ** places;
  return Math.round((Number(value) || 0) * factor) / factor;
}

export function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function tail(text, max = 2000) {
  if (!text) return "";
  return text.length > max ? text.slice(text.length - max) : text;
}

/** GET a URL and JSON-parse the body. Rejects on non-2xx or parse failure. */
export function getJson(url, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, { timeout: timeoutMs }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => {
        if ((response.statusCode ?? 0) < 200 || (response.statusCode ?? 0) >= 300) {
          reject(new Error(`HTTP ${response.statusCode} ${url}: ${body.slice(0, 200)}`));
          return;
        }
        try { resolve(body ? JSON.parse(body) : {}); } catch (error) { reject(error); }
      });
    });
    request.on("timeout", () => request.destroy(new Error("timeout")));
    request.on("error", reject);
  });
}

/** POST JSON to a URL and JSON-parse the reply. Resolves on 2xx, rejects otherwise. */
export function postJson(url, payload, timeoutMs = 6000) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload ?? {});
    const request = http.request(url, {
      method: "POST",
      timeout: timeoutMs,
      headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) },
    }, (response) => {
      let responseBody = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { responseBody += chunk; });
      response.on("end", () => {
        const status = response.statusCode ?? 0;
        let parsed = null;
        try { parsed = responseBody ? JSON.parse(responseBody) : {}; } catch { parsed = { raw: responseBody }; }
        if (status < 200 || status >= 300) {
          reject(Object.assign(new Error(`HTTP ${status} ${url}: ${responseBody.slice(0, 200)}`), { status, body: parsed }));
          return;
        }
        resolve(parsed);
      });
    });
    request.on("timeout", () => request.destroy(new Error("timeout")));
    request.on("error", reject);
    request.end(body);
  });
}

/** True when an HTTP GET to path returns < 500 (server is up). */
export function isHttpReachable(port, requestPath = "/") {
  return new Promise((resolve) => {
    const request = http.get({ hostname: "127.0.0.1", port, path: requestPath, timeout: 800 }, (response) => {
      response.resume();
      resolve((response.statusCode ?? 599) < 500);
    });
    request.on("timeout", () => request.destroy(new Error("timeout")));
    request.on("error", () => resolve(false));
  });
}

/** Resolve the first free TCP port >= startPort not in `claimed`. */
export function pickFreePort(startPort, claimed = new Set()) {
  return new Promise((resolve, reject) => {
    const tryPort = (candidate) => {
      if (candidate > 65535) return reject(new Error(`no free port >= ${startPort}`));
      if (claimed.has(candidate)) return tryPort(candidate + 1);
      const server = net.createServer();
      server.once("error", () => tryPort(candidate + 1));
      server.once("listening", () => server.close(() => resolve(candidate)));
      server.listen(candidate, "127.0.0.1");
    };
    tryPort(startPort);
  });
}


/** Wait until `producer()` satisfies `predicate`, else throw. */
export async function waitFor(producer, { timeoutMs = 15000, intervalMs = 150, predicate = Boolean, label = "condition" } = {}) {
  const deadline = Date.now() + timeoutMs;
  let latest;
  while (Date.now() <= deadline) {
    latest = await producer();
    if (predicate(latest)) return latest;
    await delay(intervalMs);
  }
  throw new Error(`timed out waiting for ${label}; latest=${JSON.stringify(latest)?.slice(0, 300)}`);
}
