#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import fssync from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const serverRoot = path.join(repoRoot, "server");
const stateDir = path.join(serverRoot, ".local-state");
const host = "127.0.0.1";
const port = integerEnv("GAME_AUTHORITY_SERVER_PORT") ?? 28093;
const shardId = process.env.GAME_SHARD_ID ?? "open-desert-persistent";
const pidPath = path.join(stateDir, `server-${port}.pid`);
const listenerPidPath = path.join(stateDir, `server-${port}.listener.pid`);
const metaPath = path.join(stateDir, `server-${port}.json`);
const lockPath = path.join(stateDir, `server-${port}.lock`);
const outLogPath = path.join(stateDir, `server-${port}.out.log`);
const errLogPath = path.join(stateDir, `server-${port}.err.log`);
const healthUrl = `http://${host}:${port}/healthz?check=server-local-persistent`;
const statusUrl = `http://${host}:${port}/game/status?check=server-local-persistent`;
const requestedPersistence = process.env.GAME_SHARD_PERSISTENCE ?? "1";
const requestedAoiRadiusCells = process.env.GAME_AOI_RADIUS_CELLS ?? "192";
const requestedMaxPacketBytes = process.env.GAME_MAX_PACKET_BYTES ?? "65536";
const expectedSourceStateHash = process.env.GAME_EXPECT_SOURCE_STATE_HASH;
const expectedSourceActorCount = integerEnv("GAME_EXPECT_SOURCE_ACTOR_COUNT");


const startedAt = new Date().toISOString();
let lockHandle = null;
let launchedChildPid = null;

try {
  await fs.mkdir(stateDir, { recursive: true });
  lockHandle = await acquireLock(lockPath);

  await runForeground("pnpm", ["--dir", "server", "build"]);
  await runForeground("cargo", ["build", "-p", "successor-sim", "--example", "authority_bridge_server"], rustAuthorityBridgeCargoEnv());

  const beforeScan = await scanPort(port);
  assertNoUnmanagedListeners(beforeScan, "before restart");
  const previousListeners = beforeScan.exactProcesses.filter(isSuccessorServerProcess);
  const killedPids = previousListeners.map((processInfo) => processInfo.pid);
  if (previousListeners.length > 0) {
    await stopPids(killedPids, port);
  }

  await removeIfExists(pidPath);
  await removeIfExists(listenerPidPath);
  await removeIfExists(metaPath);

  const outFd = fssync.openSync(outLogPath, "a");
  const errFd = fssync.openSync(errLogPath, "a");
  const child = spawn("pnpm", ["--dir", "server", "start"], {
    cwd: repoRoot,
    detached: true,
    env: {
      ...process.env,
      HOST: host,
      PORT: String(port),
      GAME_SHARD_ID: shardId,
      GAME_SHARD_STATE_DIR: process.env.GAME_SHARD_STATE_DIR ?? stateDir,
      GAME_SHARD_PERSISTENCE: requestedPersistence,
      GAME_AOI_RADIUS_CELLS: requestedAoiRadiusCells,
      GAME_MAX_PACKET_BYTES: requestedMaxPacketBytes,
    },
    stdio: ["ignore", outFd, errFd],
  });
  child.unref();
  launchedChildPid = child.pid;
  fssync.closeSync(outFd);
  fssync.closeSync(errFd);

  await fs.writeFile(pidPath, `${child.pid}\n`, "utf8");
  const health = await waitForJson(healthUrl, 12_000, (json) => json?.ok === true);
  const status = await waitForJson(statusUrl, 4_000);
  assertExpectedSource(status);
  const afterScan = await scanPort(port);
  assertNoUnmanagedListeners(afterScan, "after restart");
  const listenerProcesses = afterScan.exactProcesses.filter(isSuccessorServerProcess);
  if (listenerProcesses.length === 0) {
    throw new Error(`Health passed but no repo-owned ${host}:${port} listener was discoverable`);
  }
  const listenerPids = listenerProcesses.map((processInfo) => processInfo.pid);
  await fs.writeFile(listenerPidPath, `${listenerPids.join("\n")}\n`, "utf8");

  const summary = {
    status: "pass",
    command: ["pnpm", "--dir", "server", "start"],
    host,
    port,
    shardId,
    killedPids,
    launcherPid: child.pid,
    listenerPids,
    health,
    gameStatus: compactGameStatus(status),
    files: relativeFiles({ pidPath, listenerPidPath, metaPath, outLogPath, errLogPath, lockPath }),
    startedAt,
    readyAt: new Date().toISOString(),
  };
  await fs.writeFile(metaPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(summary));
} catch (error) {
  await stopLaunchedServerAfterFailure();
  const failure = {
    status: "fail",
    host,
    port,
    shardId,
    error: error instanceof Error ? error.message : String(error),
    files: relativeFiles({ pidPath, listenerPidPath, metaPath, outLogPath, errLogPath, lockPath }),
    startedAt,
    failedAt: new Date().toISOString(),
  };
  console.error(JSON.stringify(failure));
  process.exitCode = 1;
} finally {
  if (lockHandle) await releaseLock(lockHandle, lockPath);
}

async function stopLaunchedServerAfterFailure() {
  if (!launchedChildPid) return;
  try {
    const scan = await scanPort(port);
    const pids = scan.exactProcesses
      .filter(isSuccessorServerProcess)
      .map((processInfo) => processInfo.pid);
    const uniquePids = [...new Set(pids.length > 0 ? pids : [launchedChildPid])];
    await stopPids(uniquePids, port);
  } catch {
    signalPid(launchedChildPid, "SIGTERM");
  }
}

async function acquireLock(file) {
  const payload = `${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await fs.open(file, "wx");
      await handle.writeFile(payload, "utf8");
      return handle;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      if (!(await removeStaleLock(file))) {
        const owner = await readLockOwner(file);
        throw new Error(`Persistent server lock is active at ${path.relative(repoRoot, file)}${owner ? ` by pid ${owner.pid}` : ""}`);
      }
    }
  }
  throw new Error(`Could not acquire persistent server lock at ${path.relative(repoRoot, file)}`);
}

async function removeStaleLock(file) {
  const owner = await readLockOwner(file);
  const stat = await fs.stat(file).catch(() => null);
  const ageMs = stat ? Date.now() - stat.mtimeMs : Number.POSITIVE_INFINITY;
  if (owner?.pid && processIsAlive(owner.pid) && ageMs < 120_000) return false;
  if (!owner?.pid && ageMs < 120_000) return false;
  await removeIfExists(file);
  return true;
}

async function readLockOwner(file) {
  try {
    const raw = await fs.readFile(file, "utf8");
    const parsed = JSON.parse(raw);
    return Number.isInteger(parsed.pid) ? { pid: parsed.pid } : null;
  } catch {
    return null;
  }
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

async function releaseLock(handle, file) {
  try {
    await handle.close();
  } finally {
    await removeIfExists(file);
  }
}

async function runForeground(command, args, env = {}) {
  await new Promise((resolve, reject) => {
    const childProcess = spawn(command, args, { cwd: repoRoot, env: { ...process.env, ...env }, stdio: "inherit" });
    childProcess.on("error", reject);
    childProcess.on("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} ${args.join(" ")} failed${signal ? ` with signal ${signal}` : ` with code ${code}`}`));
    });
  });
}

function rustAuthorityBridgeCargoEnv() {
  return {
    CARGO_PROFILE_DEV_OPT_LEVEL: process.env.CARGO_PROFILE_DEV_OPT_LEVEL ?? "2",
  };
}
function integerEnv(name) {
  const raw = process.env[name];
  if (!raw) return undefined;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer, got ${raw}`);
  }
  return parsed;
}

function assertExpectedSource(status) {
  const actualHash = status?.source?.stateHash;
  const actualActorCount = status?.source?.actorCount;
  if (expectedSourceStateHash && actualHash !== expectedSourceStateHash) {
    throw new Error(`Server source stateHash mismatch: expected ${expectedSourceStateHash}, got ${actualHash ?? "unknown"}`);
  }
  if (expectedSourceActorCount !== undefined && actualActorCount !== expectedSourceActorCount) {
    throw new Error(`Server source actorCount mismatch: expected ${expectedSourceActorCount}, got ${actualActorCount ?? "unknown"}`);
  }
}


async function waitForJson(url, timeoutMs, predicate = () => true) {
  const started = Date.now();
  let lastError = null;
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(url);
      if (!response.ok) {
        lastError = new Error(`HTTP ${response.status}`);
      } else {
        const text = await response.text();
        const json = JSON.parse(text);
        if (predicate(json)) return json;
        lastError = new Error(`Unexpected JSON ${text.slice(0, 180)}`);
      }
    } catch (error) {
      lastError = error;
    }
    await sleep(250);
  }
  throw new Error(`Timed out waiting for ${url}: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

async function stopPids(pids, listenPort) {
  for (const pid of pids) signalPid(pid, "SIGTERM");
  if (await waitForExactLoopbackPortClear(listenPort, pids, 4_000)) return;
  const remaining = (await scanPort(listenPort)).exactProcesses
    .filter((processInfo) => pids.includes(processInfo.pid));
  for (const processInfo of remaining) signalPid(processInfo.pid, "SIGKILL");
  if (!(await waitForExactLoopbackPortClear(listenPort, pids, 2_000))) {
    throw new Error(`Could not stop repo-owned ${host}:${listenPort} listener(s): ${formatProcessList(remaining)}`);
  }
}

function signalPid(pid, signal) {
  try {
    process.kill(pid, signal);
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

async function waitForExactLoopbackPortClear(listenPort, watchedPids, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const stillListening = (await scanPort(listenPort)).exactProcesses
      .some((processInfo) => watchedPids.includes(processInfo.pid));
    if (!stillListening) return true;
    await sleep(100);
  }
  return !(await scanPort(listenPort)).exactProcesses
    .some((processInfo) => watchedPids.includes(processInfo.pid));
}

async function scanPort(listenPort) {
  const sockets = await listeningSocketsForPort(listenPort);
  const exactSockets = sockets.filter((socket) => socket.exactLoopbackV4);
  const unmanagedSockets = sockets.filter((socket) => !socket.exactLoopbackV4);
  const exactProcesses = await processesForSocketInodes(exactSockets.map((socket) => socket.inode));
  const unmanagedProcesses = await processesForSocketInodes(unmanagedSockets.map((socket) => socket.inode));
  return { sockets, exactSockets, unmanagedSockets, exactProcesses, unmanagedProcesses };
}

function assertNoUnmanagedListeners(scan, phase) {
  if (scan.unmanagedSockets.length > 0) {
    throw new Error(`Refusing to manage non-IPv4-loopback listener(s) on port ${port} ${phase}: ${formatSocketList(scan.unmanagedSockets)} ${formatProcessList(scan.unmanagedProcesses)}`.trim());
  }
  const unrelated = scan.exactProcesses.filter((processInfo) => !isSuccessorServerProcess(processInfo));
  if (unrelated.length > 0) {
    throw new Error(`Refusing to stop non-Successor listener(s) on ${host}:${port} ${phase}: ${formatProcessList(unrelated)}`);
  }
  if (scan.exactSockets.length > 0 && scan.exactProcesses.length === 0) {
    throw new Error(`Could not resolve listener PID(s) for ${host}:${port} ${phase}: ${formatSocketList(scan.exactSockets)}`);
  }
}

async function processesForSocketInodes(inodes) {
  const wanted = new Set(inodes.filter(Boolean));
  if (wanted.size === 0) return [];
  const byPid = new Map();
  const procEntries = await fs.readdir("/proc", { withFileTypes: true });
  await Promise.all(procEntries.map(async (entry) => {
    if (!entry.isDirectory() || !/^\d+$/u.test(entry.name)) return;
    const pid = Number.parseInt(entry.name, 10);
    const fdDir = `/proc/${entry.name}/fd`;
    let fds;
    try {
      fds = await fs.readdir(fdDir);
    } catch {
      return;
    }
    const matched = [];
    for (const fd of fds) {
      let link;
      try {
        link = await fs.readlink(path.join(fdDir, fd));
      } catch {
        continue;
      }
      const match = /^socket:\[(\d+)\]$/u.exec(link);
      if (match && wanted.has(match[1])) matched.push(match[1]);
    }
    if (matched.length > 0) byPid.set(pid, { ...(await processInfo(pid)), socketInodes: matched });
  }));
  return [...byPid.values()].sort((left, right) => left.pid - right.pid);
}

async function processInfo(pid) {
  const procRoot = `/proc/${pid}`;
  let cwd = null;
  let cmdline = "";
  try {
    cwd = await fs.readlink(path.join(procRoot, "cwd"));
  } catch {
    cwd = null;
  }
  try {
    cmdline = (await fs.readFile(path.join(procRoot, "cmdline"), "utf8")).replaceAll("\0", " ").trim();
  } catch {
    cmdline = "";
  }
  return { pid, cwd, cmdline };
}

function isSuccessorServerProcess(processInfo) {
  const cwd = processInfo.cwd ? path.resolve(processInfo.cwd) : "";
  const inRepo = cwd === repoRoot || cwd === serverRoot || cwd.startsWith(`${repoRoot}${path.sep}`);
  if (!inRepo) return false;
  const command = processInfo.cmdline;
  return command.includes("dist/index.js")
    || command.includes("src/index.ts")
    || command.includes("@successor/server")
    || command.includes("tsx watch");
}

function formatProcessList(processes) {
  return processes.length === 0
    ? "no resolved process"
    : processes
      .map((processInfo) => `${processInfo.pid}${processInfo.cwd ? ` cwd=${processInfo.cwd}` : ""}${processInfo.cmdline ? ` cmd=${processInfo.cmdline}` : ""}`)
      .join("; ");
}

function formatSocketList(sockets) {
  return sockets
    .map((socket) => `${socket.family}:${socket.localAddressHex}:${socket.portHex} inode=${socket.inode}`)
    .join("; ");
}

async function listeningSocketsForPort(listenPort) {
  const sockets = [];
  await readProcTcp("/proc/net/tcp", listenPort, "tcp4", sockets);
  await readProcTcp("/proc/net/tcp6", listenPort, "tcp6", sockets);
  return sockets;
}

async function readProcTcp(file, listenPort, family, sockets) {
  let text;
  try {
    text = await fs.readFile(file, "utf8");
  } catch {
    return;
  }
  const expectedPortHex = listenPort.toString(16).toUpperCase().padStart(4, "0");
  const lines = text.trim().split(/\n/u).slice(1);
  for (const line of lines) {
    const columns = line.trim().split(/\s+/u);
    const localAddress = columns[1] ?? "";
    const state = columns[3] ?? "";
    const inode = columns[9];
    const [addressHex = "", portHex = ""] = localAddress.split(":");
    if (state !== "0A" || portHex.toUpperCase() !== expectedPortHex || !inode) continue;
    sockets.push({
      family,
      localAddressHex: addressHex.toUpperCase(),
      portHex: portHex.toUpperCase(),
      inode,
      exactLoopbackV4: family === "tcp4" && addressHex.toUpperCase() === "0100007F",
    });
  }
}

function compactGameStatus(status) {
  return {
    shardId: status?.shardId,
    tick: status?.tick,
    actorCount: status?.actorCount ?? status?.actors,
    sessionCount: status?.sessionCount,
    authority: status?.authority ? {
      mode: status.authority.mode,
      rustLive: status.authority.rustLive,
      metricsTick: status.authority.metrics?.tick,
    } : undefined,
    source: status?.source ? {
      stateHash: status.source.stateHash,
      sliceHash: status.source.sliceHash,
      actorCount: status.source.actorCount,
      areas: status.source.areas,
    } : undefined,
    persistence: status?.persistence ? {
      enabled: status.persistence.enabled,
      checkpointPath: status.persistence.checkpointPath,
      restore: status.persistence.restore,
    } : undefined,
  };
}

function relativeFiles(files) {
  return Object.fromEntries(Object.entries(files).map(([key, value]) => [key, path.relative(repoRoot, value)]));
}

async function removeIfExists(file) {
  try {
    await fs.unlink(file);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}
