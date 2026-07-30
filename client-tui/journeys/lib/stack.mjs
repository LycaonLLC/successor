/**
 * Scratch shard lifecycle for TUI gate passes.
 *
 * Shared-stack passes use one shard across their journeys. Isolated runs pass an
 * explicit ProcessHost run directory, character store, shard state path, and
 * port for each journey. Teardown always runs; boot failures include the
 * fixture launcher's captured output.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { createProcessHost } from "../../../tools/verification/lib/process-host.mjs";

// TUI_GATE_REPO points the shard build at a pinned baseline worktree
// (harness law: every red is NEW code, never baseline drift); the client
// dist under test always comes from this package.
const REPO_ROOT = process.env.TUI_GATE_REPO ?? path.resolve(import.meta.dirname, "..", "..", "..");
const FIXTURE_SCRIPT = path.join(REPO_ROOT, "tools", "successor", "serve-open-desert-fixture.mjs");

export const FORBIDDEN_PORTS = new Set([5179, 18092, 18192, 28093]);

/** Build the server/Rust prerequisites once, or assert them in skip-build mode. */
export function prepareStackBuild({ skipBuild = false } = {}) {
  const result = spawnSync(process.execPath, [FIXTURE_SCRIPT], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      OPEN_DESERT_BUILD_ONLY: "1",
      ...(skipBuild ? { OPEN_DESERT_SKIP_BUILD: "1" } : {}),
    },
    encoding: "utf8",
    timeout: 15 * 60 * 1000,
  });
  if (result.status !== 0) {
    throw new Error(`scratch shard preflight failed\n${result.stdout ?? ""}${result.stderr ?? ""}`);
  }
}
export function probePortFree(port) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once("error", () => resolve(false));
    probe.once("listening", () => probe.close(() => resolve(true)));
    probe.listen(port, "127.0.0.1");
  });
}

export async function startStack(port, options = {}) {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error(`TUI gate port must be an integer from 1024 to 65535; got ${port}`);
  }
  if (FORBIDDEN_PORTS.has(port)) {
    throw new Error(`port ${port} is reserved for an active Successor service`);
  }
  if (!(await probePortFree(port))) {
    throw new Error(`port ${port} is not free — claim a different TUI_GATE_PORT`);
  }

  const runId = safeProcessName(options.runId ?? `tui-${port}-${Date.now().toString(36)}-${process.pid}`);
  const runDir = path.resolve(options.runDir ?? path.join(REPO_ROOT, "verification", ".runs", "tui", runId));
  // Even shared-pass journeys use durable character identities. Keep their
  // roster and Rust checkpoint in this run's disposable domain instead of
  // falling through to the repo-level developer store.
  const storePath = path.resolve(options.storePath ?? path.join(runDir, "characters.json"));
  const shardPath = path.resolve(options.shardPath ?? path.join(runDir, "shard"));
  mkdirSync(runDir, { recursive: true });
  mkdirSync(path.dirname(storePath), { recursive: true });
  mkdirSync(shardPath, { recursive: true });

  const skipBuild = options.skipBuild ?? process.env.TUI_GATE_SKIP_BUILD === "1";
  const unit = options.unit ? safeProcessName(options.unit) : null;
  const shardId = options.runId ? safeProcessName(`open-desert-${runId}`) : null;
  const result = spawnSync(process.execPath, [FIXTURE_SCRIPT], {
    cwd: REPO_ROOT,
    // Fast farm cadence for the gate (F-Time dev override): crops mature in
    // seconds so the farm journey plays a full grow arc live. Bridge reads it.
    env: {
      ...process.env,
      OPEN_DESERT_PORT: String(port),
      ...(unit ? { OPEN_DESERT_UNIT: unit } : {}),
      ...(shardId ? { OPEN_DESERT_SHARD_ID: shardId } : {}),
      OPEN_DESERT_CHARACTER_STORE_PATH: storePath,
      OPEN_DESERT_SHARD_PATH: shardPath,
      ...(skipBuild ? { OPEN_DESERT_SKIP_BUILD: "1" } : {}),
      SUCCESSOR_FARM_DAY_SECONDS: process.env.SUCCESSOR_FARM_DAY_SECONDS ?? "1",
      SUCCESSOR_PROCESS_RUN_ID: runId,
      SUCCESSOR_PROCESS_RUN_DIR: runDir,
    },
    encoding: "utf8",
    timeout: 15 * 60 * 1000,
  });
  if (result.status !== 0) {
    throw new Error(`scratch shard boot failed on ${port}\n${result.stdout ?? ""}${result.stderr ?? ""}`);
  }
  const jsonStart = result.stdout.indexOf("{");
  if (jsonStart < 0) throw new Error(`scratch shard boot returned no JSON on ${port}\n${result.stdout}`);
  const boot = JSON.parse(result.stdout.slice(jsonStart));
  if (!boot.processHost?.handle) throw new Error(`scratch shard boot did not return a process handle on ${port}`);
  const processHost = createProcessHost({
    runId: boot.processHost.runId,
    runDir: boot.processHost.runDir,
    kind: boot.processHost.kind,
  });
  const handle = processHost.adopt(boot.processHost.handle);
  const status = await fetchStatus(port);
  return {
    port,
    unit: handle.unit ?? handle.name,
    runId: processHost.runId,
    runDir: processHost.runDir,
    storePath: boot.storePath ?? storePath,
    shardPath: boot.shardPath ?? shardPath,
    shardId: status.shardId,
    sliceHash: status.source?.sliceHash,
    async stop() {
      return processHost.stop(handle, { graceMs: 30_000 });
    },
  };
}

function safeProcessName(value) {
  const safe = String(value).trim().replace(/[^A-Za-z0-9_.:@-]+/gu, "-").replace(/^-+|-+$/gu, "");
  if (!safe || safe === "." || safe === "..") throw new Error(`invalid TUI ProcessHost run id: ${value}`);
  return safe;
}

export async function fetchStatus(port) {
  const response = await fetch(`http://127.0.0.1:${port}/game/status`);
  if (!response.ok) throw new Error(`status HTTP ${response.status} on ${port}`);
  return response.json();
}

/** Restore the authored fixture and Rust bridge between shared-stack journeys.
 * This keeps each proof independent while retaining the cheaper one-shard pass. */
export async function resetStackFixture(port) {
  const response = await fetch(`http://127.0.0.1:${port}/game/debug/reset-fixture`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  if (!response.ok) throw new Error(`fixture reset HTTP ${response.status} on ${port}`);
  const result = await response.json();
  if (result?.accepted !== true) throw new Error(`fixture reset rejected on ${port}`);
  return result;
}
