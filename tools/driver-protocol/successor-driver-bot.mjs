#!/usr/bin/env node
import { spawn } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";

const repoRoot = path.resolve(import.meta.dirname, "..", "..");
const defaultCliPath = path.join(repoRoot, "client", "dist", "headless", "cli.js");
const defaultSlicePath = path.join(repoRoot, "client", "public", "successor-slice", "open-desert-slice.json");

const driverBufferLimits = Object.freeze({
  envelopes: 512,
  textLines: 128,
  stderr: 256,
  stdoutPartialChars: 64 * 1024,
  stderrPartialChars: 64 * 1024,
});

function closeTimeout(value, fallback, name) {
  const timeout = value ?? fallback;
  if (!Number.isSafeInteger(timeout) || timeout <= 0) {
    throw new TypeError(`${name} must be a positive integer`);
  }
  return timeout;
}

function inheritsProcessHostGroup() {
  return process.platform !== "win32" && process.env.SUCCESSOR_PROCESS_HOST === "child";
}

export function startSuccessorDriverBot(options = {}) {
  const cliPath = options.cliPath ?? defaultCliPath;
  const gameUrl = options.gameUrl ?? `http://127.0.0.1:${process.env.OPEN_DESERT_PORT ?? "28093"}`;
  const actorId = options.actorId ?? `driver-bot-${Date.now().toString(36)}`;
  const displayName = options.displayName ?? "Driver Bot";
  const argv = [
    cliPath,
    "--game-url",
    gameUrl,
    "--slice",
    options.slicePath ?? defaultSlicePath,
    "--actor-id",
    actorId,
    "--player-id",
    options.playerId ?? actorId,
    "--display-name",
    displayName,
  ];
  if (options.characterId) argv.push("--character-id", options.characterId);
  if (options.spawnArea) argv.push("--spawn-area", options.spawnArea);
  if (options.spawnX !== undefined) argv.push("--spawn-x", String(options.spawnX));
  if (options.spawnY !== undefined) argv.push("--spawn-y", String(options.spawnY));
  if (options.facing) argv.push("--facing", options.facing);
  if (options.text) argv.push("--text");

  const ownsProcessGroup = process.platform !== "win32" && !inheritsProcessHostGroup();
  const child = spawn(process.execPath, argv, {
    cwd: repoRoot,
    detached: ownsProcessGroup,
    env: { ...process.env, ...(options.env ?? {}) },
    stdio: ["pipe", "pipe", "pipe"],
  });

  const envelopes = [];
  const textLines = [];
  const stderr = [];
  const dropped = {
    envelopes: 0,
    textLines: 0,
    stderr: 0,
    stdoutBufferTruncations: 0,
    stdoutBufferDrops: 0,
    stderrBufferTruncations: 0,
    stderrBufferDrops: 0,
  };
  const waiters = new Set();
  const terminationWaiters = new Set();
  const closeGraceMs = closeTimeout(options.closeGraceMs, 3_000, "closeGraceMs");
  const closeTermMs = closeTimeout(options.closeTermMs, 2_000, "closeTermMs");
  const closeKillMs = closeTimeout(options.closeKillMs, 2_000, "closeKillMs");
  let stdoutBuffer = "";
  let stderrBuffer = "";
  let exit = null;
  let exitError = null;
  let closePromise = null;

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdoutBuffer += chunk;
    drainStdoutLines();
  });

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderrBuffer += chunk;
    drainStderrLines();
  });

  child.on("exit", (code, signal) => {
    if (stdoutBuffer.trim()) recordStdoutLine(stdoutBuffer.trimEnd());
    if (stderrBuffer.trim()) pushBounded(stderr, stderrBuffer.trimEnd(), "stderr");
    exit = { code, signal };
    rejectProtocolWaiters(new Error(`successor-play exited before protocol wait completed: ${JSON.stringify(exit)}\n${stderr.join("\n")}`));
    settleTerminationWaiters();
  });

  child.on("error", (error) => {
    exitError = error;
    rejectProtocolWaiters(error);
    settleTerminationWaiters();
  });

  function recordStdoutLine(line) {
    if (!line) return;
    try {
      pushBounded(envelopes, JSON.parse(line), "envelopes");
    } catch {
      pushBounded(textLines, line, "textLines");
    }
    pumpWaiters();
  }

  function pushBounded(buffer, value, kind) {
    const limit = driverBufferLimits[kind];
    const removeCount = buffer.length - limit + 1;
    if (removeCount > 0) {
      buffer.splice(0, removeCount);
      dropped[kind] += removeCount;
    }
    buffer.push(value);
  }

  function rejectProtocolWaiters(error) {
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    waiters.clear();
  }

  function capPartialBuffer(buffer, stream) {
    const limit = driverBufferLimits[`${stream}PartialChars`];
    if (buffer.length <= limit) return buffer;
    dropped[`${stream}BufferTruncations`] += 1;
    dropped[`${stream}BufferDrops`] += 1;
    return "";
  }

  function drainStdoutLines() {
    let start = 0;
    let newline;
    while ((newline = stdoutBuffer.indexOf("\n", start)) !== -1) {
      recordStdoutLine(stdoutBuffer.slice(start, newline).trimEnd());
      start = newline + 1;
    }
    stdoutBuffer = capPartialBuffer(stdoutBuffer.slice(start), "stdout");
  }

  function drainStderrLines() {
    let start = 0;
    let newline;
    while ((newline = stderrBuffer.indexOf("\n", start)) !== -1) {
      pushBounded(stderr, stderrBuffer.slice(start, newline), "stderr");
      start = newline + 1;
    }
    stderrBuffer = capPartialBuffer(stderrBuffer.slice(start), "stderr");
  }
  function pumpWaiters() {
    for (const waiter of [...waiters]) {
      const match = envelopes.find(waiter.predicate);
      if (!match) continue;
      clearTimeout(waiter.timer);
      waiters.delete(waiter);
      waiter.resolve(match);
    }
  }

  function waitFor(predicate, label, timeoutMs = 8_000) {
    const existing = envelopes.find(predicate);
    if (existing) return Promise.resolve(existing);
    if (exitError) return Promise.reject(exitError);
    if (exit) return Promise.reject(new Error(`successor-play already exited before ${label}: ${JSON.stringify(exit)}\n${stderr.join("\n")}`));
    const gate = Promise.withResolvers();
    const waiter = {
      predicate,
      label,
      resolve: gate.resolve,
      reject: gate.reject,
      timer: setTimeout(() => {
        waiters.delete(waiter);
        gate.reject(new Error(`timed out waiting for ${label}\nstdout=${JSON.stringify(envelopes.slice(-8))}\nstderr=${stderr.join("\n")}`));
      }, timeoutMs),
    };
    waiters.add(waiter);
    return gate.promise;
  }

  function isOwnedProcessGroupAlive() {
    if (!ownsProcessGroup || !Number.isInteger(child.pid)) return false;
    try {
      process.kill(-child.pid, 0);
      return true;
    } catch (error) {
      if (error?.code === "ESRCH") return false;
      if (error?.code === "EPERM") return true;
      throw error;
    }
  }

  function isTerminationVerified() {
    return exit !== null && !isOwnedProcessGroupAlive();
  }

  function terminationError(label, cause) {
    const error = new Error(`could not verify successor-play process termination during ${label}; pid=${child.pid ?? "unknown"}; exit=${JSON.stringify(exit)}\nstderr=${stderr.join("\n")}`, cause ? { cause } : undefined);
    return error;
  }

  function settleTerminationWaiters() {
    for (const waiter of [...terminationWaiters]) waiter.check();
  }

  function waitForVerifiedTermination(label, timeoutMs) {
    if (exitError) return Promise.reject(terminationError(label, exitError));
    if (isTerminationVerified()) return Promise.resolve();
    const gate = Promise.withResolvers();
    const deadline = Date.now() + timeoutMs;
    const waiter = {
      timer: null,
      check() {
        if (exitError) return finish(terminationError(label, exitError));
        try {
          if (isTerminationVerified()) return finish();
        } catch (error) {
          return finish(terminationError(label, error));
        }
        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0) return finish(terminationError(label));
        waiter.timer = setTimeout(waiter.check, Math.min(25, remainingMs));
      },
    };
    const finish = (error) => {
      if (!terminationWaiters.delete(waiter)) return;
      clearTimeout(waiter.timer);
      if (error) gate.reject(error);
      else gate.resolve();
    };
    terminationWaiters.add(waiter);
    waiter.check();
    return gate.promise;
  }

  function signalProcess(signal) {
    if (ownsProcessGroup && Number.isInteger(child.pid)) {
      try {
        process.kill(-child.pid, signal);
      } catch (error) {
        if (error?.code !== "ESRCH") throw terminationError(`${signal} escalation`, error);
      }
      return;
    }
    if (exit === null && !child.kill(signal)) {
      throw terminationError(`${signal} escalation`);
    }
  }

  function send(frame) {
    child.stdin.write(`${JSON.stringify(frame)}\n`);
  }

  async function close() {
    closePromise ??= closeDriver();
    return closePromise;
  }

  async function closeDriver() {
    if (exitError) throw terminationError("close", exitError);
    if (isTerminationVerified()) return;

    try {
      send({ op: "quit" });
    } catch {
      // A broken stdin cannot prove death; the TERM/KILL escalation below still must.
    }

    try {
      await waitForVerifiedTermination("graceful quit", closeGraceMs);
      return;
    } catch (gracefulError) {
      if (exitError) throw gracefulError;
    }

    signalProcess("SIGTERM");
    try {
      await waitForVerifiedTermination("SIGTERM", closeTermMs);
      return;
    } catch (termError) {
      if (exitError) throw termError;
    }

    signalProcess("SIGKILL");
    await waitForVerifiedTermination("SIGKILL", closeKillMs);
  }

  return {
    child,
    envelopes,
    textLines,
    stderr,
    dropped,
    send,
    waitFor,
    close,
  };
}

export async function runDriverLines(options) {
  const bot = startSuccessorDriverBot(options);
  await bot.waitFor((envelope) => envelope.type === "status" && envelope.status === "ready", "driver ready");
  for (const line of options.lines ?? []) bot.send({ op: "verb", line });
  return bot;
}

function parseCli(argv) {
  const options = { lines: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];
    if (arg === "--line") {
      if (value === undefined) throw new Error("--line requires a value");
      options.lines.push(value);
      index += 1;
    } else if (arg === "--game-url") {
      if (value === undefined) throw new Error("--game-url requires a value");
      options.gameUrl = value;
      index += 1;
    } else if (arg === "--actor-id") {
      if (value === undefined) throw new Error("--actor-id requires a value");
      options.actorId = value;
      index += 1;
    } else if (arg === "--cli") {
      if (value === undefined) throw new Error("--cli requires a value");
      options.cliPath = value;
      index += 1;
    } else {
      throw new Error(`unknown option ${arg}`);
    }
  }
  return options;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const options = parseCli(process.argv.slice(2));
  const bot = await runDriverLines(options);
  await bot.waitFor((envelope) => envelope.type === "receipt" || envelope.type === "query", "first receipt/query", 5_000).catch(() => null);
  await bot.close();
  console.log(JSON.stringify({ envelopes: bot.envelopes, textLines: bot.textLines, stderr: bot.stderr, dropped: bot.dropped }, null, 2));
}
