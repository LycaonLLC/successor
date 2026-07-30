// Scratch stack lifecycle for the client-3d journey harness.
//
// Topology (see run-journeys.mjs): ONE shared vite serving the real client-3d
// source, N scratch backends (one per journey, isolated process + port +
// per-journey character store), each browser session navigating to the shared
// vite with `?gamePort=<backend>`. Backends are the parallelism unit.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";

import { createProcessHost } from "../../lib/process-host.mjs";
import { delay, getJson, isHttpReachable, safeName, tail } from "./util.mjs";

// Live standing units (owner dev stack + desktop shell) — never reuse.
export const FORBIDDEN_PORTS = new Set([18192, 5179, 28093]);

/** Build the Rust authority bridge + server dist once. Throws on failure. */
export function buildPrerequisites(repoRoot) {
  const commands = [
    ["cargo", "build", "-q", "-p", "successor-sim", "--example", "authority_bridge_server"],
    ["pnpm", "--dir", "server", "build"],
  ];
  const results = [];
  for (const argv of commands) {
    const started = performance.now();
    const result = spawnSync(argv[0], argv.slice(1), {
      cwd: repoRoot,
      env: { ...process.env, CARGO_PROFILE_DEV_OPT_LEVEL: process.env.CARGO_PROFILE_DEV_OPT_LEVEL ?? "2" },
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
    results.push({ argv, exitCode: result.status, durationMs: Math.round(performance.now() - started) });
    if (result.status !== 0) {
      throw new Error(`${argv.join(" ")} failed ${result.status}\n${tail(result.stdout)}${tail(result.stderr)}`);
    }
  }
  return results;
}

/** Sweep only processes bearing this invocation's unique run-id prefix. */
export async function sweepStaleStack(runId, _vitePort, repoRoot, runDir) {
  const ownPrefix = safeName(`h3d-${runId}`).slice(0, 40);
  const ownedRunDir = runDir ?? path.join(repoRoot, "verification", ".runs", "client3d", safeName(runId));
  const primaryHost = createProcessHost({ runId: ownPrefix, runDir: ownedRunDir });
  const childHost = createProcessHost({ runId: ownPrefix, runDir: ownedRunDir, kind: "child" });
  const hosts = primaryHost.kind === childHost.kind ? [primaryHost] : [primaryHost, childHost];
  const results = [];
  for (const host of hosts) results.push(await host.sweep(ownPrefix));
  return {
    ok: results.every((result) => result.ok),
    swept: results.flatMap((result) => result.swept),
    failures: results.flatMap((result) => result.failures),
  };
}

/** A single scratch backend: its own supervised process, port, and character store. */
export class Backend {
  constructor({ repoRoot, port, runId, runDir, storePath, verificationLoadoutsPath, slicePath, logsDir }) {
    this.repoRoot = repoRoot;
    this.port = port;
    this.runId = runId;
    this.storePath = storePath;
    this.verificationLoadoutsPath = verificationLoadoutsPath ?? null;
    this.slicePath = slicePath ?? path.join(repoRoot, "client", "public", "successor-slice", "open-desert-slice.json");
    this.logsDir = logsDir;
    this.unitPrefix = safeName(`h3d-${runId}`).slice(0, 40);
    this.unit = `${this.unitPrefix}-${port}`;
    this.runSuffix = new Date().toISOString().replace(/[^0-9]/gu, "").slice(0, 14);
    this.shardId = this.unit;
    this.stateDir = path.join(path.dirname(this.storePath), "game-state");
    this.url = `http://127.0.0.1:${port}`;
    this.rustBridgeBin = path.join(repoRoot, "target", "debug", "examples", "authority_bridge_server");
    this.processHost = createProcessHost({ runId: this.unitPrefix, runDir: runDir ?? path.dirname(logsDir) });
    this.handle = null;
  }

  get unitService() {
    return this.handle?.unit ?? this.handle?.name ?? this.unit;
  }

  /** Start the server and wait for /game/status. Resolves to status JSON. */
  async boot(timeoutMs = 25000) {
    const runSuffix = this.runSuffix;
    const env = {
      PORT: String(this.port),
      HOST: "127.0.0.1",
      LOG_LEVEL: process.env.SUCCESSOR_CLIENT3D_LOG_LEVEL ?? "silent",
      GAME_ALLOW_DEV_IDENTITY: process.env.GAME_ALLOW_DEV_IDENTITY ?? "1",
      GAME_SHARD_ID: `${this.shardId}-${runSuffix}`,
      GAME_SHARD_PERSISTENCE: "1",
      GAME_SHARD_STATE_DIR: this.stateDir,
      GAME_SHARD_CHECKPOINT_PATH: path.join(this.stateDir, `${this.shardId}-${runSuffix}.checkpoint.json`),
      GAME_SHARD_JOURNAL_PATH: path.join(this.stateDir, `${this.shardId}-${runSuffix}.journal.jsonl`),
      GAME_DEBUG_AUTHORITY_COMMANDS: "1",
      GAME_MOVE_TRACE: "0",
      GAME_SLICE_PATH: this.slicePath,
      GAME_RUST_AUTHORITY_BRIDGE_BIN: this.rustBridgeBin,
      GAME_CHARACTER_STORE_PATH: this.storePath,
      ...(this.verificationLoadoutsPath ? {
        GAME_VERIFICATION_FIXTURE_MODE: "client3d-pre-entry.v1",
        GAME_VERIFICATION_FIXTURE_ROOT: path.dirname(this.storePath),
        GAME_VERIFICATION_FIXTURE_LOADOUTS_PATH: this.verificationLoadoutsPath,
      } : {}),
      // F-Time dev override (§H): crops mature in seconds on the scratch shard so
      // the farm journey can play a full grow->harvest->replant arc. Forwarded to
      // the Rust bridge; absent => production day-length.
      ...(process.env.SUCCESSOR_FARM_DAY_SECONDS ? { SUCCESSOR_FARM_DAY_SECONDS: process.env.SUCCESSOR_FARM_DAY_SECONDS } : { SUCCESSOR_FARM_DAY_SECONDS: "1" }),
    };
    this.handle = await this.processHost.start({
      name: this.unit,
      argv: [process.execPath, path.join(this.repoRoot, "server", "dist", "index.js")],
      env,
      cwd: this.repoRoot,
    });
    const deadline = Date.now() + timeoutMs;
    let lastError = null;
    while (Date.now() < deadline) {
      try {
        const status = await getJson(`${this.url}/game/status`, 900);
        if (status?.shardId) return status;
      } catch (error) { lastError = error; }
      await delay(150);
    }
    await this.dumpLogs();
    throw new Error(`backend ${this.unit} never became ready on ${this.port}: ${lastError?.message ?? "no status"}`);
  }

  async dumpLogs() {
    if (!this.logsDir || !this.handle) return;
    const text = await this.processHost.logs(this.handle).catch(() => "");
    try {
      fs.mkdirSync(this.logsDir, { recursive: true });
      fs.writeFileSync(path.join(this.logsDir, `${this.unit}.log`), text, "utf8");
    } catch { /* best-effort */ }
  }

  /** Stop the process group/unit and assert it reached inactive. */
  async teardown() {
    if (!this.handle) return { ok: true, unit: this.unitService, finalState: "not-started", failures: [] };
    const handle = this.handle;
    const result = await this.processHost.stop(handle, { graceMs: 30_000 });
    if (result.ok) this.handle = null;
    return result;
  }
}

/** Shared vite dev server for the real client-3d source. */
export class Vite {
  constructor({ repoRoot, port, runId, runDir, logsDir }) {
    this.repoRoot = repoRoot;
    this.port = port;
    this.logsDir = logsDir;
    this.handle = null;
    this.name = `${safeName(`h3d-${runId ?? `vite-${process.pid}`}`).slice(0, 40)}-vite-${port}`;
    this.processHost = createProcessHost({
      runId: safeName(`h3d-${runId ?? `vite-${process.pid}`}`).slice(0, 40),
      runDir: runDir ?? path.dirname(logsDir),
      kind: "child",
    });
    this.url = `http://127.0.0.1:${port}`;
  }

  async start(timeoutMs = 60000) {
    if (await isHttpReachable(this.port, "/")) {
      throw new Error(`vite port ${this.port} already serving; refusing to hijack a live server`);
    }
    this.handle = await this.processHost.start({
      name: this.name,
      argv: ["pnpm", "--dir", "client-3d", "exec", "vite", "--host", "127.0.0.1", "--port", String(this.port), "--strictPort"],
      cwd: this.repoRoot,
      env: { SUCCESSOR_GAME_LAB: "1" },
    });
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await isHttpReachable(this.port, "/")) return;
      if (this.handle && (await this.processHost.assertStopped(this.handle, { timeoutMs: 0 })).ok) throw new Error(`vite exited; see ${this.handle.logPath}`);
      await delay(300);
    }
    throw new Error(`vite never became reachable on ${this.port}`);
  }

  async stop() {
    if (!this.handle) return { ok: true, name: this.name, finalState: "not-started", failures: [] };
    return this.processHost.stop(this.handle);
  }
}
