#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { createProcessHost } from "../verification/lib/process-host.mjs";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const serverRoot = path.join(repoRoot, "server");
const serverDistPath = path.join(serverRoot, "dist", "index.js");
const port = integerEnv("OPEN_DESERT_PORT", 18092, { min: 1024, max: 65535 });
const unit = process.env.OPEN_DESERT_UNIT ?? `successor-open-desert-${port}`;
const slicePath = path.resolve(process.env.OPEN_DESERT_SLICE_PATH ?? path.join(repoRoot, "client", "public", "successor-slice", "open-desert-slice.json"));
const rustBridgeBin = path.join(repoRoot, "target", "debug", "examples", "authority_bridge_server");
const nodeBin = process.env.NODE_BIN ?? process.execPath;
const runSuffix = new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 14);
const processRunId = process.env.SUCCESSOR_PROCESS_RUN_ID ?? unit;
const processRunDir = path.resolve(process.env.SUCCESSOR_PROCESS_RUN_DIR ?? path.join(repoRoot, "verification", ".runs", "open-desert", unit));
const characterStorePath = process.env.OPEN_DESERT_CHARACTER_STORE_PATH
  ? path.resolve(process.env.OPEN_DESERT_CHARACTER_STORE_PATH)
  : path.join(processRunDir, "characters.json");
const shardPath = process.env.OPEN_DESERT_SHARD_PATH
  ? path.resolve(process.env.OPEN_DESERT_SHARD_PATH)
  : path.join(processRunDir, "shard");
const shardId = process.env.OPEN_DESERT_SHARD_ID ?? `open-desert-${runSuffix}`;
const skipBuild = process.env.OPEN_DESERT_SKIP_BUILD === "1";
const buildOnly = process.env.OPEN_DESERT_BUILD_ONLY === "1";

if (skipBuild) assertBuildArtifacts();
else buildPrerequisites();

if (buildOnly) {
  console.log(JSON.stringify({ ok: true, buildOnly: true, serverDistPath, rustBridgeBin }));
} else {
  await serveFixture();
}

function buildPrerequisites() {
  run(["cargo", "build", "-q", "-p", "successor-sim", "--example", "authority_bridge_server"], {
    cwd: repoRoot,
    env: { ...process.env, CARGO_PROFILE_DEV_OPT_LEVEL: process.env.CARGO_PROFILE_DEV_OPT_LEVEL ?? "2" },
  });
  run(["pnpm", "--dir", "server", "build"], { cwd: repoRoot });
}

function assertBuildArtifacts() {
  const missing = [serverDistPath, rustBridgeBin].filter((candidate) => !existsSync(candidate));
  if (missing.length > 0) {
    throw new Error(`OPEN_DESERT_SKIP_BUILD=1 requires prebuilt artifacts; missing: ${missing.join(", ")}`);
  }
}

async function serveFixture() {
  const processHost = createProcessHost({ runId: processRunId, runDir: processRunDir });
  const handle = await startScratchUnit(unit, processHost);
  let status;
  try {
    status = await waitForStatus(port);
  } catch (error) {
    const log = await processHost.logs(handle).catch(() => "");
    await processHost.stop(handle).catch(() => undefined);
    throw new Error(`${error instanceof Error ? error.message : String(error)}${log.trim() ? `\n${log.slice(-4000)}` : ""}`);
  }
  console.log(JSON.stringify({
    ok: true,
    unit: handle.unit ?? handle.name,
    port,
    url: `http://127.0.0.1:${port}/game/status`,
    slicePath: path.relative(repoRoot, slicePath),
    shardId: status.shardId,
    shardPath,
    storePath: characterStorePath,
    actorCount: status.actorCount,
    source: status.source,
    processHost: {
      kind: processHost.kind,
      runId: processHost.runId,
      runDir: processHost.runDir,
      handle,
    },
  }, null, 2));
}

async function startScratchUnit(unitName, processHost) {
  const env = {
    PORT: String(port),
    HOST: "127.0.0.1",
    GAME_SHARD_ID: shardId,
    GAME_SHARD_PERSISTENCE: "1",
    GAME_SHARD_STATE_DIR: shardPath,
    GAME_DEBUG_AUTHORITY_COMMANDS: "1",
    GAME_MOVE_TRACE: process.env.GAME_MOVE_TRACE ?? "0",
    GAME_SLICE_PATH: slicePath,
    GAME_RUST_AUTHORITY_BRIDGE_BIN: rustBridgeBin,
    GAME_CHARACTER_STORE_PATH: characterStorePath,
    // Dev/QA farm cadence override (F-Time §H): forwarded to the Rust bridge so a
    // scratch shard can grow crops in seconds. Absent => production day-length.
    ...(process.env.SUCCESSOR_FARM_DAY_SECONDS
      ? { SUCCESSOR_FARM_DAY_SECONDS: process.env.SUCCESSOR_FARM_DAY_SECONDS }
      : {}),
  };
  return processHost.start({
    name: unitName,
    argv: [nodeBin, serverDistPath],
    env,
    cwd: serverRoot,
    persist: true,
  });
}

function waitForStatus(statusPort, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      statusRequest(statusPort)
        .then(resolve)
        .catch((error) => {
          if (Date.now() >= deadline) {
            reject(new Error(`Timed out waiting for open-desert server on ${statusPort}: ${error.message}`));
            return;
          }
          setTimeout(attempt, 100);
        });
    };
    attempt();
  });
}

function statusRequest(statusPort) {
  return new Promise((resolve, reject) => {
    const request = http.get({ hostname: "127.0.0.1", port: statusPort, path: "/game/status", timeout: 800 }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        body += chunk;
      });
      response.on("end", () => {
        if (response.statusCode !== 200) {
          reject(new Error(`HTTP ${response.statusCode}`));
          return;
        }
        try {
          resolve(JSON.parse(body));
        } catch (error) {
          reject(error);
        }
      });
    });
    request.on("timeout", () => request.destroy(new Error("timeout")));
    request.on("error", reject);
  });
}

function run(argv, options = {}) {
  const result = spawnSync(argv[0], argv.slice(1), {
    cwd: options.cwd ?? repoRoot,
    env: options.env ?? process.env,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`${argv.join(" ")} failed ${result.status}\n${result.stdout ?? ""}${result.stderr ?? ""}`.trim());
  }
  return result;
}

function integerEnv(name, fallback, { min, max }) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}; got ${raw}`);
  }
  return parsed;
}
