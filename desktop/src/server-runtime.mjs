import childProcess from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { desktopLog } from "./log-sink.mjs";
import { successorDesktopEnv } from "./env.mjs";

const defaultGamePort = 18192;
const defaultDesktopShardId = "desktop-open-desert";
const portScanLimit = 9;
const readinessTimeoutMs = 60_000;
const readinessPollMs = 250;
// Close can wait for an in-flight ten-second export and then publish a forced
// ten-second final export. Keep SIGKILL comfortably above both durability legs.
export const desktopServerStopGraceMs = 30_000;
const stopKillWaitMs = 2_000;
const checkpointSchema = "successor.game-shard-checkpoint.v1";
const characterStoreSchema = "successor.character-store.v2";
const characterIdPattern = /^[a-z0-9][a-z0-9_.-]{0,63}$/u;
const ownerRefPattern = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u;
const stateLockHandshakeSchema = "successor.state-lock.v1";
const stateLockHandshakeTimeoutMs = 5_000;
const stateLockReleaseTimeoutMs = 2_000;
const flockBin = "/usr/bin/flock";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const stateLockSupervisorPath = path.join(moduleDir, "state-lock-supervisor.mjs");
let activeRuntime = null;
let startPromise = null;
let stopPromise = null;

export function desktopShardPersistenceConfig({ stateDir, shardId = defaultDesktopShardId } = {}) {
  if (!stateDir) throw new Error("desktop shard persistence requires a durable stateDir");
  const resolvedStateDir = path.resolve(stateDir);
  return {
    shardId,
    stateDir: resolvedStateDir,
    checkpointPath: path.join(resolvedStateDir, `${shardId}.checkpoint.json`),
    journalPath: path.join(resolvedStateDir, `${shardId}.journal.jsonl`),
    characterStorePath: path.join(resolvedStateDir, "characters.json"),
    manifestPath: path.join(resolvedStateDir, "state-generation.manifest.json"),
    stateLockPath: path.join(resolvedStateDir, ".desktop-state.lock"),
  };
}

export function desktopCheckpointRestoreCanStart(restore, { checkpointExpected } = {}) {
  if (!restore || typeof restore !== "object" || Array.isArray(restore)) return false;
  if (checkpointExpected === true) {
    const reasonIsConsistent = restore.reason === undefined || restore.reason === "loaded";
    return restore.loaded === true && reasonIsConsistent && !restore.error;
  }
  if (checkpointExpected === false) return restore.loaded === false && restore.reason === "missing";
  return false;
}

export function desktopCheckpointCompatibility({ checkpointRaw, sliceRaw, shardId = defaultDesktopShardId } = {}) {
  let checkpoint;
  try {
    checkpoint = JSON.parse(checkpointRaw);
  } catch {
    return { compatible: false, reason: "invalid_json" };
  }

  if (
    !checkpoint
    || typeof checkpoint !== "object"
    || Array.isArray(checkpoint)
    || checkpoint.schema !== checkpointSchema
    || typeof checkpoint.sliceHash !== "string"
    || checkpoint.sliceHash.length === 0
  ) {
    return { compatible: false, reason: "schema_mismatch" };
  }
  if (checkpoint.shardId !== shardId) {
    return { compatible: false, reason: "shard_mismatch" };
  }
  let projectionStateHash;
  try {
    projectionStateHash = desktopCheckpointProjectionStateHash(checkpoint);
  } catch {
    return { compatible: false, reason: "invalid_projection" };
  }
  if (checkpoint.projectionStateHash !== projectionStateHash) {
    return { compatible: false, reason: "projection_state_hash_mismatch" };
  }
  if (checkpoint.manifest && !desktopDurabilityManifestValid(checkpoint.manifest, { sliceHash: checkpoint.sliceHash, sourceStateHash: checkpoint.sourceStateHash })) {
    return { compatible: false, reason: "manifest_mismatch" };
  }

  let slice;
  try {
    slice = JSON.parse(sliceRaw);
  } catch {
    return { compatible: false, reason: "current_slice_invalid_json" };
  }
  const currentSourceStateHash = typeof slice?.stateHash === "string" && slice.stateHash.length > 0
    ? slice.stateHash
    : undefined;
  if (!currentSourceStateHash) {
    return { compatible: false, reason: "current_slice_missing_state_hash" };
  }

  const currentSliceHash = sha256(sliceRaw);
  if (checkpoint.sliceHash === currentSliceHash) {
    return {
      compatible: true,
      reason: "slice_hash_match",
      currentSliceHash,
      currentSourceStateHash,
    };
  }

  const checkpointSourceStateHash = typeof checkpoint.sourceStateHash === "string" && checkpoint.sourceStateHash.length > 0
    ? checkpoint.sourceStateHash
    : undefined;
  return {
    compatible: false,
    reason: checkpointSourceStateHash && checkpointSourceStateHash !== currentSourceStateHash
      ? "source_state_hash_mismatch"
      : "slice_hash_mismatch",
    currentSliceHash,
    currentSourceStateHash,
  };
}

export function ensureDesktopCharacterStore({
  durablePath,
  log = () => {},
} = {}) {
  if (!durablePath) {
    throw new Error("desktop character-store initialization requires durablePath");
  }
  if (fs.existsSync(durablePath)) {
    const durable = readValidatedCharacterStore(durablePath, "durable");
    return { initialized: false, reason: "durable_exists", characterCount: durable.characterCount };
  }

  const sourceRaw = `${JSON.stringify({ schema: characterStoreSchema, characters: [] }, null, 2)}\n`;
  const dir = path.dirname(durablePath);
  fs.mkdirSync(dir, { recursive: true });
  const tempPath = path.join(dir, `.${path.basename(durablePath)}.initialize-${process.pid}-${randomUUID()}.tmp`);
  let fd;
  try {
    fd = fs.openSync(tempPath, "wx", 0o600);
    fs.writeFileSync(fd, sourceRaw, "utf8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    readValidatedCharacterStore(tempPath, "initialization temp");

    try {
      // Hard-link publication is atomic and refuses to replace a destination
      // that appeared after the initial existence check.
      fs.linkSync(tempPath, durablePath);
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const durable = readValidatedCharacterStore(durablePath, "durable");
      return { initialized: false, reason: "durable_exists", characterCount: durable.characterCount };
    }
    fsyncDirectory(dir);
    const durable = readValidatedCharacterStore(durablePath, "durable");
    log("game-server-character-store-initialized", {
      durablePath,
      characterCount: durable.characterCount,
    });
    return { initialized: true, reason: "fresh_store_initialized", characterCount: durable.characterCount };
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    if (fs.existsSync(tempPath)) {
      fs.rmSync(tempPath, { force: true });
      fsyncDirectory(dir);
    }
  }
}

export async function acquireDesktopStateLock({
  stateDir,
  lockPath,
  log = () => {},
  serverEntry = "",
  serverCwd = "",
  serverEnv = process.env,
} = {}) {
  if (!stateDir && !lockPath) throw new Error("desktop state lock requires stateDir or lockPath");
  const resolvedStateDir = path.resolve(stateDir ?? path.dirname(lockPath));
  const resolvedLockPath = path.resolve(lockPath ?? path.join(resolvedStateDir, ".desktop-state.lock"));
  fs.mkdirSync(resolvedStateDir, { recursive: true });
  assertFile(flockBin, "desktop state locking requires /usr/bin/flock");
  assertFile(stateLockSupervisorPath, "desktop state-lock supervisor is missing");
  if (serverEntry) assertFile(serverEntry, "server dist entry missing; run pnpm --dir server build");
  if (serverCwd) assertDirectory(serverCwd, "server working directory missing");

  const args = [
    "--exclusive",
    "--nonblock",
    "--no-fork",
    resolvedLockPath,
    process.execPath,
    stateLockSupervisorPath,
    resolvedLockPath,
    ...(serverEntry ? [serverEntry, serverCwd] : []),
  ];
  const child = childProcess.spawn(flockBin, args, {
    cwd: serverCwd || resolvedStateDir,
    detached: true,
    env: {
      ...serverEnv,
      ELECTRON_RUN_AS_NODE: "1",
    },
    stdio: ["pipe", "pipe", "pipe", "pipe"],
  });
  pipeLogLines(child.stdout, serverEntry ? "game-server-stdout" : "game-state-lock-stdout", log, { pid: child.pid });
  pipeLogLines(child.stderr, serverEntry ? "game-server-stderr" : "game-state-lock-stderr", log, { pid: child.pid });

  let handshake;
  try {
    handshake = await waitForStateLockHandshake(child, resolvedLockPath);
  } catch (error) {
    child.stdin?.destroy();
    if (child.pid && isProcessGroupAlive(child.pid)) signalProcessGroup(child.pid, "SIGKILL", log);
    await waitForChildExit(child, stateLockReleaseTimeoutMs);
    const cause = error instanceof Error ? `: ${error.message}` : "";
    throw new Error(`Successor desktop game state is already in use or its lock could not be acquired at ${resolvedLockPath}${cause}`);
  }

  const lease = {
    child,
    lockPath: resolvedLockPath,
    ownerPid: handshake.pid,
    serverEntry,
    serverStarted: false,
    released: false,
    log,
  };
  log("game-state-lock-acquired", { lockPath: resolvedLockPath, ownerPid: handshake.pid });
  return lease;
}

export async function releaseDesktopStateLock(lease, { log = lease?.log ?? (() => {}) } = {}) {
  if (!lease || lease.released) return;
  lease.released = true;
  const child = lease.child;
  if (child?.exitCode === null && child?.signalCode === null) {
    try {
      if (child.stdin?.writable) child.stdin.end("release\n");
      else signalProcess(child.pid, "SIGTERM", log);
    } catch {
      signalProcess(child.pid, "SIGTERM", log);
    }
    if (!await waitForChildExit(child, stateLockReleaseTimeoutMs) && child.pid) {
      signalProcessGroup(child.pid, "SIGKILL", log);
      await waitForChildExit(child, stateLockReleaseTimeoutMs);
    }
  }
  log("game-state-lock-released", { lockPath: lease.lockPath, ownerPid: lease.ownerPid });
}

export async function startGameServer(options = {}) {
  if (activeRuntime?.ready) return runtimeInfo(activeRuntime);
  if (startPromise) return startPromise;

  startPromise = startGameServerInternal(options).finally(() => {
    startPromise = null;
  });
  return startPromise;
}

export async function stopGameServer(options = {}) {
  if (stopPromise) return stopPromise;

  const runtime = activeRuntime;
  const log = options.log ?? runtime?.log ?? desktopLog;
  if (!runtime?.child?.pid) {
    activeRuntime = null;
    return;
  }

  stopPromise = stopGameServerInternal(runtime, log).finally(() => {
    if (activeRuntime === runtime) activeRuntime = null;
    stopPromise = null;
  });
  return stopPromise;
}

async function startGameServerInternal(options) {
  const log = options.log ?? desktopLog;
  const repoRoot = findRepoRoot(options.repoRoot);
  const paths = runtimePaths(repoRoot);
  const requestedPort = requestedGamePort(options);
  const port = await chooseAvailablePort(requestedPort, log);
  const persistence = desktopShardPersistenceConfig({
    stateDir: options.stateDir,
    shardId: options.shardId,
  });
  assertFile(paths.rustBridgeBin, "Rust authority bridge binary missing; build target/debug/examples/authority_bridge_server");
  const serverEnv = desktopServerEnvironment({
    port,
    paths,
    persistence,
    serverDebugEnabled: successorDesktopEnv("SERVER_DEBUG") === "1",
  });

  let stateLock;
  let runtime;
  try {
    // This kernel lease must cover every read or write of the durable desktop
    // state, including initialization and checkpoint compatibility preflight.
    stateLock = await acquireDesktopStateLock({
      stateDir: persistence.stateDir,
      lockPath: persistence.stateLockPath,
      log,
      serverEntry: paths.serverEntry,
      serverCwd: paths.serverCwd,
      serverEnv,
    });

    await regenerateOpenDesertFixture(paths, log);
    const expectedStateHash = readFixtureStateHash(paths.slicePath);
    const checkpointPreflight = assertDurableCheckpointCompatible({
      checkpointPath: persistence.checkpointPath,
      journalPath: persistence.journalPath,
      characterStorePath: persistence.characterStorePath,
      slicePath: paths.slicePath,
      shardId: persistence.shardId,
      log,
    });
    ensureDesktopCharacterStore({
      durablePath: persistence.characterStorePath,
      log,
    });

    const child = startStateLockedServer(stateLock, paths, port, persistence, log);
    runtime = {
      child,
      stateLock,
      log,
      port,
      repoRoot,
      shardId: persistence.shardId,
      stateDir: persistence.stateDir,
      checkpointPath: persistence.checkpointPath,
      journalPath: persistence.journalPath,
      characterStorePath: persistence.characterStorePath,
      stateLockPath: persistence.stateLockPath,
      manifestPath: persistence.manifestPath,
      checkpointExpected: checkpointPreflight.checkpointExpected,
      slicePath: paths.slicePath,
      mapBundlePath: paths.mapBundlePath,
      expectedStateHash,
      ready: false,
      stopping: false,
      exit: null,
      onUnexpectedExit: typeof options.onUnexpectedExit === "function" ? options.onUnexpectedExit : null,
    };
    activeRuntime = runtime;
    installServerExitWatch(runtime);

    const status = await waitForServerReady(runtime);
    runtime.ready = true;
    runtime.status = status;
    log("game-server-ready", {
      pid: child.pid,
      port,
      shardId: runtime.shardId,
      stateDir: runtime.stateDir,
      checkpointPath: runtime.checkpointPath,
      journalPath: runtime.journalPath,
      characterStorePath: runtime.characterStorePath,
      stateLockPath: runtime.stateLockPath,
      checkpointExpected: runtime.checkpointExpected,
      tick: status.tick,
      sessionCount: status.sessionCount,
      sourceStateHash: status.source?.stateHash,
      sourceActorCount: status.source?.actorCount,
    });
    return runtimeInfo(runtime);
  } catch (error) {
    log("game-server-start-failed", { port, pid: runtime?.child?.pid ?? stateLock?.child?.pid ?? null, ...errorDetails(error) });
    if (runtime) await stopGameServer({ log });
    else if (stateLock) await releaseDesktopStateLock(stateLock, { log });
    throw error;
  }
}

function runtimeInfo(runtime) {
  return {
    port: runtime.port,
    pid: runtime.child?.pid ?? null,
    repoRoot: runtime.repoRoot,
    shardId: runtime.shardId,
    stateDir: runtime.stateDir,
    checkpointPath: runtime.checkpointPath,
    journalPath: runtime.journalPath,
    characterStorePath: runtime.characterStorePath,
    stateLockPath: runtime.stateLockPath,
    checkpointExpected: runtime.checkpointExpected,
    slicePath: runtime.slicePath,
    mapBundlePath: runtime.mapBundlePath,
    expectedStateHash: runtime.expectedStateHash,
    status: runtime.status ?? null,
  };
}

function runtimePaths(repoRoot) {
  return {
    repoRoot,
    fixtureScript: path.join(repoRoot, "tools", "successor", "configure-open-desert-fixture.mjs"),
    serverEntry: path.join(repoRoot, "server", "dist", "index.js"),
    serverCwd: path.join(repoRoot, "server"),
    slicePath: path.join(repoRoot, "client", "public", "successor-slice", "open-desert-slice.json"),
    mapBundlePath: path.join(repoRoot, "client", "public", "successor-slice", "open-desert-map-bundle.json"),
    rustBridgeBin: path.join(repoRoot, "target", "debug", "examples", "authority_bridge_server"),
  };
}

function findRepoRoot(explicitRoot) {
  const candidates = [
    explicitRoot,
    path.resolve(moduleDir, "../.."),
    path.resolve(moduleDir, "../../../../../.."),
    process.cwd(),
    path.resolve(process.cwd(), ".."),
    path.resolve(process.cwd(), "../.."),
    path.resolve(process.cwd(), "../../.."),
  ].filter(Boolean);

  for (const candidate of candidates) {
    const root = path.resolve(candidate);
    if (isRepoRoot(root)) return root;
  }

  throw new Error(`Could not locate the Successor repo root from ${moduleDir}; expected server/dist/index.js and tools/successor/configure-open-desert-fixture.mjs.`);
}

function isRepoRoot(root) {
  return fileExists(path.join(root, "server", "dist", "index.js"))
    && fileExists(path.join(root, "tools", "successor", "configure-open-desert-fixture.mjs"))
    && directoryExists(path.join(root, "client", "public", "successor-slice"));
}

function requestedGamePort(options) {
  if (options.requestedPort !== undefined && options.requestedPort !== null && options.requestedPort !== "") {
    return parsePort(options.requestedPort, "requested gamePort");
  }
  if (successorDesktopEnv("GAME_PORT")) {
    return parsePort(successorDesktopEnv("GAME_PORT"), "SUCCESSOR_DESKTOP_GAME_PORT");
  }
  return defaultGamePort;
}

async function chooseAvailablePort(basePort, log) {
  for (let offset = 0; offset <= portScanLimit; offset += 1) {
    const port = basePort + offset;
    if (port > 65_535) break;
    if (await canListenOnPort(port)) {
      if (offset > 0) log("game-server-port-selected", { requestedPort: basePort, port, offset });
      return port;
    }
    log("game-server-port-busy", { port });
  }
  throw new Error(`No available Successor desktop game port from ${basePort} through ${Math.min(basePort + portScanLimit, 65_535)}; set SUCCESSOR_DESKTOP_GAME_PORT to a free port.`);
}

function canListenOnPort(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once("error", () => resolve(false));
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () => {
      server.close(() => resolve(true));
    });
  });
}

async function regenerateOpenDesertFixture(paths, log) {
  log("open-desert-fixture-regen-start", { script: paths.fixtureScript });
  let result;
  try {
    result = await runNodeScript(paths.fixtureScript, {
      cwd: paths.repoRoot,
      log,
      eventPrefix: "open-desert-fixture",
    });
  } catch (error) {
    result = { ok: false, code: null, signal: null, error };
  }

  if (result.ok) {
    log("open-desert-fixture-regen-complete", { script: paths.fixtureScript, code: result.code, signal: result.signal });
    return;
  }

  const hasExistingFixture = fileExists(paths.slicePath) && fileExists(paths.mapBundlePath);
  if (hasExistingFixture) {
    log("open-desert-fixture-regen-warning", {
      script: paths.fixtureScript,
      code: result.code,
      signal: result.signal,
      ...(result.error ? errorDetails(result.error) : {}),
      message: "fixture regeneration failed; continuing because existing open-desert slice and map bundle are present",
    });
    return;
  }

  const cause = result.error instanceof Error ? `: ${result.error.message}` : "";
  throw new Error(`Open-desert fixture regeneration failed with code=${result.code ?? "null"} signal=${result.signal ?? "null"}${cause}, and ${paths.slicePath} / ${paths.mapBundlePath} are not both present.`);
}

function runNodeScript(scriptPath, { cwd, log, eventPrefix }) {
  return new Promise((resolve, reject) => {
    const child = childProcess.spawn(process.execPath, [scriptPath], {
      cwd,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    pipeLogLines(child.stdout, `${eventPrefix}-stdout`, log, { pid: child.pid });
    pipeLogLines(child.stderr, `${eventPrefix}-stderr`, log, { pid: child.pid });
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ ok: code === 0, code, signal }));
  });
}

export function desktopServerEnvironment({
  baseEnv = process.env,
  port,
  paths,
  persistence,
  serverDebugEnabled = false,
} = {}) {
  const env = { ...baseEnv };
  for (const key of Object.keys(env)) {
    if (key === "PORT" || key === "HOST" || key.startsWith("GAME_")) delete env[key];
  }
  Object.assign(env, {
    ELECTRON_RUN_AS_NODE: "1",
    PORT: String(port),
    HOST: "127.0.0.1",
    GAME_SHARD_ID: persistence.shardId,
    GAME_SHARD_STATE_DIR: persistence.stateDir,
    GAME_SHARD_PERSISTENCE: "1",
    GAME_SHARD_MANIFEST_PATH: persistence.manifestPath,
    GAME_CHARACTER_STORE_PATH: persistence.characterStorePath,
    GAME_FIRE_DEBUG: serverDebugEnabled ? "1" : "0",
    GAME_DEBUG_AUTHORITY_COMMANDS: serverDebugEnabled ? "1" : "0",
    GAME_SLICE_PATH: paths.slicePath,
    GAME_MAP_BUNDLE_PATH: paths.mapBundlePath,
    GAME_STATE_LOCK_HELD: "1",
    GAME_HOSTED_DURABILITY: "1",
    GAME_STATE_LOCK_FD: "3",
    GAME_RUST_AUTHORITY_BRIDGE_BIN: paths.rustBridgeBin,
  });
  return env;
}

function startStateLockedServer(lease, paths, port, persistence, log) {
  if (!lease?.child?.pid || lease.released) throw new Error("desktop state lock is not active");
  if (lease.serverStarted) throw new Error("desktop state lock already started its game server");
  if (!lease.child.stdin?.writable) throw new Error("desktop state-lock supervisor command channel is closed");
  lease.serverStarted = true;
  lease.child.stdin.write("start\n");
  log("game-server-spawn", {
    pid: lease.child.pid,
    port,
    shardId: persistence.shardId,
    stateDir: persistence.stateDir,
    checkpointPath: persistence.checkpointPath,
    journalPath: persistence.journalPath,
    characterStorePath: persistence.characterStorePath,
    cwd: paths.serverCwd,
    entry: paths.serverEntry,
    slicePath: paths.slicePath,
    rustBridgeBin: paths.rustBridgeBin,
  });
  return lease.child;
}

function installServerExitWatch(runtime) {
  runtime.child.once("error", (error) => {
    runtime.exit = { code: null, signal: null, error };
    runtime.log("game-server-error", { pid: runtime.child.pid, port: runtime.port, ...errorDetails(error) });
    if (!runtime.stopping && runtime.child.pid) signalProcessGroup(runtime.child.pid, "SIGKILL", runtime.log);
    if (runtime.ready && !runtime.stopping) runtime.onUnexpectedExit?.({ pid: runtime.child.pid, port: runtime.port, error });
  });

  runtime.child.once("exit", (code, signal) => {
    runtime.exit = { code, signal };
    const expected = runtime.stopping || !runtime.ready;
    runtime.log("game-server-exit", { pid: runtime.child.pid, port: runtime.port, code, signal, expected });
    // The server inherited a duplicate of the kernel lock descriptor. If its
    // supervisor disappears unexpectedly, kill the whole process group before
    // reporting the exit so an orphan can never keep writing behind our back.
    if (!runtime.stopping && runtime.child.pid) signalProcessGroup(runtime.child.pid, "SIGKILL", runtime.log);
    if (activeRuntime === runtime && runtime.stopping) activeRuntime = null;
    if (runtime.ready && !runtime.stopping) {
      runtime.onUnexpectedExit?.({ pid: runtime.child.pid, port: runtime.port, code, signal });
    }
  });
}

async function waitForServerReady(runtime) {
  const deadline = Date.now() + readinessTimeoutMs;
  let lastFailure = null;

  while (Date.now() < deadline) {
    if (runtime.exit) {
      const suffix = runtime.exit.error ? `: ${runtime.exit.error.message}` : ` code=${runtime.exit.code ?? "null"} signal=${runtime.exit.signal ?? "null"}`;
      throw new Error(`Game server exited before readiness${suffix}`);
    }

    try {
      const response = await getStatusJson(runtime.port);
      if (response.statusCode === 200) {
        const status = response.json;
        const stateHash = status?.source?.stateHash;
        if (stateHash && stateHash !== runtime.expectedStateHash) {
          throw new FatalReadinessError(`Game server source stateHash mismatch: expected ${runtime.expectedStateHash}, got ${stateHash}`);
        }
        const restore = status?.persistence?.restore;
        const restorePending = restore?.reason === "rust_restore_pending";
        if (restorePending && runtime.checkpointExpected) {
          lastFailure = `status persistence restore is still pending: ${JSON.stringify(restore)}`;
          await delay(readinessPollMs);
          continue;
        }
        if (!desktopCheckpointRestoreCanStart(restore, { checkpointExpected: runtime.checkpointExpected })) {
          const reason = typeof restore?.reason === "string" && restore.reason.length > 0
            ? restore.reason
            : "malformed_restore_status";
          throw new FatalReadinessError(
            `Game server checkpoint restore failed: ${reason}${restore?.error ? `: ${restore.error}` : ""}`,
          );
        }
        if (Number.isFinite(status?.tick) && stateHash === runtime.expectedStateHash && status?.readiness?.ready === true) return status;
        lastFailure = `status missing numeric tick or matching source.stateHash: ${JSON.stringify(status)}`;
      } else {
        lastFailure = `HTTP ${response.statusCode}: ${response.body.slice(0, 400)}`;
      }
    } catch (error) {
      if (error instanceof FatalReadinessError) throw error;
      lastFailure = error instanceof Error ? error.message : String(error);
    }

    await delay(readinessPollMs);
  }

  throw new Error(`Timed out after ${readinessTimeoutMs}ms waiting for http://127.0.0.1:${runtime.port}/game/status with source.stateHash=${runtime.expectedStateHash}; last failure: ${lastFailure ?? "none"}`);
}

function getStatusJson(port) {
  return new Promise((resolve, reject) => {
    const request = http.get({ hostname: "127.0.0.1", port, path: "/game/status", timeout: 2_000 }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        body += chunk;
        if (body.length > 1_000_000) request.destroy(new Error("/game/status response exceeded 1MB"));
      });
      response.on("end", () => {
        if (response.statusCode !== 200) {
          resolve({ statusCode: response.statusCode ?? 0, body, json: null });
          return;
        }
        try {
          resolve({ statusCode: response.statusCode, body, json: JSON.parse(body) });
        } catch (error) {
          reject(error);
        }
      });
    });
    request.on("timeout", () => request.destroy(new Error("/game/status request timed out")));
    request.on("error", reject);
  });
}

class FatalReadinessError extends Error {}

async function stopGameServerInternal(runtime, log) {
  runtime.stopping = true;
  try {
    await stopDesktopServerSupervisor(runtime.child, { port: runtime.port, log });
  } finally {
    await releaseDesktopStateLock(runtime.stateLock, { log });
  }
}

export async function stopDesktopServerSupervisor(child, {
  port = null,
  log = desktopLog,
  graceMs = desktopServerStopGraceMs,
  killWaitMs = stopKillWaitMs,
} = {}) {
  const pid = child?.pid;
  if (!pid) return { stopped: false, reason: "missing_pid" };

  log("game-server-stop-start", { pid, port, signal: "SIGTERM" });
  signalProcess(pid, "SIGTERM", log);
  const exitedWithinGrace = await waitForChildExit(child, graceMs);
  let escalated = false;

  if (!exitedWithinGrace) {
    escalated = true;
    log("game-server-stop-escalate", { pid, port, signal: "SIGKILL", graceMs });
    signalProcessGroup(pid, "SIGKILL", log);
    await waitForChildExit(child, killWaitMs);
  }

  let groupExited = await waitForProcessGroupExit(pid, killWaitMs);
  if (!groupExited && !escalated) {
    escalated = true;
    log("game-server-stop-escalate", {
      pid,
      port,
      signal: "SIGKILL",
      graceMs,
      reason: "process_group_remained_after_supervisor_exit",
    });
    signalProcessGroup(pid, "SIGKILL", log);
    await waitForChildExit(child, killWaitMs);
    groupExited = await waitForProcessGroupExit(pid, killWaitMs);
  }

  const code = child.exitCode;
  const signal = child.signalCode;
  if (escalated) {
    const error = new Error(
      `Successor game server graceful stop failed: SIGKILL escalation was required; code=${code ?? "null"} signal=${signal ?? "null"} aliveAfterKill=${!groupExited}`,
    );
    log("game-server-stop-failed", { pid, port, escalated, code, signal, aliveAfterKill: !groupExited, ...errorDetails(error) });
    throw error;
  }
  if (!exitedWithinGrace || code !== 0 || signal !== null) {
    const error = new Error(
      `Successor game server graceful stop failed: code=${code ?? "null"} signal=${signal ?? "null"}`,
    );
    log("game-server-stop-failed", { pid, port, escalated, code, signal, aliveAfterKill: !groupExited, ...errorDetails(error) });
    throw error;
  }

  log("game-server-stop-complete", { pid, port, escalated: false, code, signal });
  return { stopped: true, escalated: false, code, signal };
}

function signalProcess(pid, signal, log) {
  try {
    process.kill(pid, signal);
  } catch (error) {
    if (error?.code === "ESRCH") return;
    log("game-server-signal-failed", { pid, signal, ...errorDetails(error) });
  }
}

function signalProcessGroup(pid, signal, log) {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (error?.code === "ESRCH") return;
    log("game-server-signal-failed", { pid, signal, ...errorDetails(error) });
  }
}

async function waitForProcessGroupExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessGroupAlive(pid)) return true;
    await delay(100);
  }
  return !isProcessGroupAlive(pid);
}

function isProcessGroupAlive(pid) {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    if (error?.code === "EPERM") return true;
    return false;
  }
}

function readFixtureStateHash(slicePath) {
  const parsed = JSON.parse(fs.readFileSync(slicePath, "utf8"));
  if (typeof parsed.stateHash !== "string" || parsed.stateHash.length === 0) {
    throw new Error(`Open-desert fixture ${slicePath} does not contain a top-level stateHash string.`);
  }
  return parsed.stateHash;
}

export function assertDurableCheckpointCompatible({
  checkpointPath,
  journalPath,
  characterStorePath,
  slicePath,
  shardId,
  log = () => {},
}) {
  const checkpointBytes = durableFileBytes(checkpointPath, "checkpoint");
  const journalBytes = journalPath ? durableFileBytes(journalPath, "journal") : null;
  const journalHasEntries = journalPath && journalBytes !== null
    ? durableJournalHasEntries(journalPath)
    : false;
  if (checkpointBytes === null) {
    const enteredCharacterCount = characterStorePath && durableFileBytes(characterStorePath, "character store") !== null
      ? readValidatedCharacterStore(characterStorePath, "durable").enteredCharacterCount
      : 0;
    const hazards = [];
    if (journalHasEntries) hazards.push(`configured journal contains ${journalBytes} bytes`);
    if (enteredCharacterCount > 0) hazards.push(`${enteredCharacterCount} durable character(s) have entered the world`);
    if (hazards.length > 0) {
      throw new Error(
        `Durable game checkpoint is missing at ${checkpointPath} while ${hazards.join(" and ")}. Startup is blocked to prevent replacing persisted player state; explicit recovery or reset is required.`,
      );
    }
    return { checkpointExpected: false };
  }

  if (journalPath && !journalHasEntries) {
    throw checkpointCompatibilityError(checkpointPath, "journal_missing_or_empty");
  }
  if (characterStorePath && durableFileBytes(characterStorePath, "character store") === null) {
    throw checkpointCompatibilityError(checkpointPath, "character_store_missing");
  }
  if (characterStorePath) readValidatedCharacterStore(characterStorePath, "durable");

  let checkpointRaw;
  let sliceRaw;
  try {
    checkpointRaw = fs.readFileSync(checkpointPath, "utf8");
    sliceRaw = fs.readFileSync(slicePath, "utf8");
  } catch (error) {
    throw checkpointCompatibilityError(checkpointPath, "checkpoint_read_failed", error);
  }

  const compatibility = desktopCheckpointCompatibility({ checkpointRaw, sliceRaw, shardId });
  if (!compatibility.compatible) {
    throw checkpointCompatibilityError(checkpointPath, compatibility.reason);
  }
  log("game-server-checkpoint-compatible", {
    checkpointPath,
    shardId,
    reason: compatibility.reason,
    currentSliceHash: compatibility.currentSliceHash,
    currentSourceStateHash: compatibility.currentSourceStateHash,
  });
  return { checkpointExpected: true, compatibility };
}

function durableJournalHasEntries(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8").split(/\r?\n/u).some((line) => line.trim().length > 0);
  } catch (error) {
    const message = error instanceof Error ? `: ${error.message}` : "";
    throw new Error(`Failed to inspect durable game journal at ${filePath}${message}`, { cause: error });
  }
}

function durableFileBytes(filePath, label) {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) throw new Error(`${label} path is not a regular file`);
    return stat.size;
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    const message = error instanceof Error ? `: ${error.message}` : "";
    throw new Error(`Failed to inspect durable game ${label} at ${filePath}${message}`, { cause: error });
  }
}

function checkpointCompatibilityError(checkpointPath, reason, cause) {
  const suffix = cause instanceof Error ? `: ${cause.message}` : "";
  return new Error(
    `Durable game checkpoint is incompatible (${reason})${suffix}. The checkpoint was retained at ${checkpointPath}; migration or an explicit reset is required before the desktop game can start.`,
  );
}

function readValidatedCharacterStore(filePath, label) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    const message = error instanceof Error ? `: ${error.message}` : "";
    throw new Error(`Invalid ${label} Successor character store at ${filePath}; read failed${message}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? `: ${error.message}` : "";
    throw new Error(`Invalid ${label} Successor character store at ${filePath}; JSON parse failed${message}`);
  }
  if (
    !parsed
    || typeof parsed !== "object"
    || Array.isArray(parsed)
    || parsed.schema !== characterStoreSchema
    || !Array.isArray(parsed.characters)
  ) {
    throw new Error(
      `Invalid ${label} Successor character store at ${filePath}; expected schema=${characterStoreSchema} with a characters array`,
    );
  }
  const seenIds = new Set();
  let enteredCharacterCount = 0;
  for (const [index, candidate] of parsed.characters.entries()) {
    const validObject = candidate && typeof candidate === "object" && !Array.isArray(candidate);
    const id = validObject && typeof candidate.id === "string" ? candidate.id : "";
    const name = validObject && typeof candidate.name === "string"
      ? candidate.name.normalize("NFKC").replace(/[\u0000-\u001f\u007f]/gu, "").trim().replace(/\s+/gu, " ").slice(0, 32)
      : "";
    const ownerRefValid = validObject
      && typeof candidate.ownerRef === "string"
      && ownerRefPattern.test(candidate.ownerRef);
    const worldEntryMarkerValid = validObject && typeof candidate.worldEntryClaimed === "boolean";
    if (!characterIdPattern.test(id) || !name || !ownerRefValid || !worldEntryMarkerValid) {
      throw new Error(
        `Invalid ${label} Successor character store at ${filePath}; malformed record at characters[${index}]`,
      );
    }
    if (seenIds.has(id)) {
      throw new Error(
        `Invalid ${label} Successor character store at ${filePath}; duplicate id ${JSON.stringify(id)} at characters[${index}]`,
      );
    }
    seenIds.add(id);
    if (candidate.worldEntryClaimed) enteredCharacterCount += 1;
  }
  return { raw, characterCount: parsed.characters.length, enteredCharacterCount };
}

function fsyncDirectory(dirPath) {
  let fd;
  try {
    fd = fs.openSync(dirPath, "r");
    fs.fsyncSync(fd);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function waitForStateLockHandshake(child, expectedLockPath) {
  return new Promise((resolve, reject) => {
    const stream = child.stdio?.[3];
    if (!stream) {
      reject(new Error("state-lock supervisor handshake pipe is unavailable"));
      return;
    }

    let buffer = "";
    let settled = false;
    let timer;
    const cleanup = () => {
      clearTimeout(timer);
      stream.off("data", onData);
      stream.off("end", onEnd);
      stream.off("error", onStreamError);
      child.off("error", onChildError);
      child.off("exit", onChildExit);
    };
    const fail = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    const succeed = (handshake) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(handshake);
    };
    const parseLine = (line) => {
      let handshake;
      try {
        handshake = JSON.parse(line);
      } catch (error) {
        fail(new Error(`state-lock supervisor sent invalid handshake JSON: ${error instanceof Error ? error.message : String(error)}`));
        return;
      }
      if (
        !handshake
        || typeof handshake !== "object"
        || Array.isArray(handshake)
        || handshake.schema !== stateLockHandshakeSchema
        || !Number.isInteger(handshake.pid)
        || handshake.pid <= 0
        || path.resolve(String(handshake.lockPath ?? "")) !== path.resolve(expectedLockPath)
      ) {
        fail(new Error("state-lock supervisor sent a malformed or mismatched handshake"));
        return;
      }
      succeed(handshake);
    };
    const onData = (chunk) => {
      buffer += chunk;
      if (buffer.length > 16_384) {
        fail(new Error("state-lock supervisor handshake exceeded 16KB"));
        return;
      }
      const newline = buffer.indexOf("\n");
      if (newline >= 0) parseLine(buffer.slice(0, newline));
    };
    const onEnd = () => fail(new Error("state-lock supervisor closed its handshake pipe before ownership proof"));
    const onStreamError = (error) => fail(error);
    const onChildError = (error) => fail(error);
    const onChildExit = (code, signal) => fail(new Error(
      `state-lock supervisor exited before ownership proof code=${code ?? "null"} signal=${signal ?? "null"}`,
    ));

    stream.setEncoding("utf8");
    stream.on("data", onData);
    stream.once("end", onEnd);
    stream.once("error", onStreamError);
    child.once("error", onChildError);
    child.once("exit", onChildExit);
    timer = setTimeout(() => fail(new Error(
      `state-lock supervisor did not prove ownership within ${stateLockHandshakeTimeoutMs}ms`,
    )), stateLockHandshakeTimeoutMs);
  });
}

function waitForChildExit(child, timeoutMs) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (exited) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off("exit", onExit);
      resolve(exited);
    };
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    child.once("exit", onExit);
  });
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function desktopCheckpointProjectionStateHash(checkpoint) {
  const projection = JSON.parse(JSON.stringify({
    schema: checkpoint.schema,
    shardId: checkpoint.shardId,
    ...(typeof checkpoint.sourceStateHash === "string" ? { sourceStateHash: checkpoint.sourceStateHash } : {}),
    sliceHash: checkpoint.sliceHash,
    tick: checkpoint.tick,
    tickRateHz: checkpoint.tickRateHz,
    nextCombatEventId: checkpoint.nextCombatEventId,
    nextBotSeq: checkpoint.nextBotSeq,
    counters: checkpoint.counters,
    actors: checkpoint.actors,
    ...(checkpoint.authoredPlaceholderOwners ? {
      authoredPlaceholderOwners: checkpoint.authoredPlaceholderOwners,
    } : {}),
    propStates: checkpoint.propStates ?? {},
    travelTickets: checkpoint.travelTickets ?? [],
    ...(checkpoint.manifest ? { manifest: checkpoint.manifest } : {}),
  }));
  return sha256(stableStringify(projection));
}

function desktopDurabilityManifestValid(manifest, { sliceHash, sourceStateHash } = {}) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) return false;
  if (manifest.schema !== "successor.state-generation-manifest.v1"
    || manifest.fixtureHash !== sliceHash
    || (sourceStateHash && manifest.sourceStateHash !== sourceStateHash)
    || manifest.saveSchema !== checkpointSchema
    || manifest.characterMirror !== characterStoreSchema
    || manifest.journalAnchor !== "checkpoint"
    || manifest.wireSchema !== "successor.authoritative-shard-delta.v1"
    || typeof manifest.generation !== "string"
    || manifest.generation.length === 0) return false;
  return true;
}

function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
    .join(",")}}`;
}

function parsePort(raw, label) {
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${label} must be an integer TCP port from 1 to 65535; got ${raw}`);
  }
  return port;
}

function pipeLogLines(stream, event, log, details = {}) {
  if (!stream) return;
  let buffer = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    buffer += chunk;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (line.length > 0) log(event, { ...details, line });
    }
  });
  stream.on("end", () => {
    if (buffer.length > 0) log(event, { ...details, line: buffer });
  });
}

function errorDetails(error) {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
  }
  return { message: String(error) };
}

function assertFile(filePath, message) {
  if (fileExists(filePath)) return;
  throw new Error(`${message}: ${filePath}`);
}

function assertDirectory(dirPath, message) {
  if (directoryExists(dirPath)) return;
  throw new Error(`${message}: ${dirPath}`);
}

function fileExists(filePath) {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function directoryExists(dirPath) {
  try {
    return fs.statSync(dirPath).isDirectory();
  } catch {
    return false;
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
