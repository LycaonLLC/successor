import childProcess from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const handshakeSchema = "successor.state-lock.v1";
const lostParentStopGraceMs = 30_000;
const [lockPath, serverEntry = "", serverCwd = ""] = process.argv.slice(2);

if (!lockPath) fail("state-lock supervisor requires a lock path");

const lockFd = findInheritedLockFd(lockPath);
if (lockFd === null) fail(`state-lock supervisor did not inherit the flock descriptor for ${lockPath}`);

writeHandshake({ schema: handshakeSchema, pid: process.pid, lockPath: path.resolve(lockPath) });

let server = null;
let stopping = false;
let stdinBuffer = "";

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  stdinBuffer += chunk;
  const lines = stdinBuffer.split(/\r?\n/u);
  stdinBuffer = lines.pop() ?? "";
  for (const line of lines) handleCommand(line.trim());
});
process.stdin.on("end", () => stopForLostParent());
process.on("SIGTERM", () => stopServer("SIGTERM"));
process.on("SIGINT", () => stopServer("SIGINT"));

function handleCommand(command) {
  if (command === "start") {
    startServer();
    return;
  }
  if (command === "release") {
    if (server) fail("cannot release a state lock while the game server is running");
    process.exit(0);
  }
  if (command) fail(`unknown state-lock supervisor command ${JSON.stringify(command)}`);
}

function startServer() {
  if (server) fail("state-lock supervisor received duplicate start command");
  if (!serverEntry || !serverCwd) fail("state-lock supervisor is missing the game server command");

  server = childProcess.spawn(process.execPath, [serverEntry], {
    cwd: serverCwd,
    env: process.env,
    // The duplicated lock descriptor keeps the kernel lease alive if this
    // supervisor exits unexpectedly while the server is still running.
    stdio: ["ignore", "inherit", "inherit", lockFd],
  });
  server.once("error", (error) => fail(`failed to spawn the game server: ${error.message}`));
  server.once("exit", (code, signal) => {
    server = null;
    if (signal && !stopping) {
      process.stderr.write(`[successor-state-lock] game server exited from signal ${signal}\n`);
    }
    process.exit(code ?? (stopping ? 0 : 1));
  });
}

function stopServer(signal) {
  if (stopping) return;
  stopping = true;
  if (!server?.pid) {
    process.exit(0);
    return;
  }
  try {
    server.kill(signal);
  } catch {
    process.exit(0);
  }
}

function stopForLostParent() {
  stopServer("SIGTERM");
  if (!server?.pid) return;
  const timer = setTimeout(() => {
    try {
      server?.kill("SIGKILL");
    } catch {
      // The child already exited.
    }
  }, lostParentStopGraceMs);
  timer.unref();
}

function findInheritedLockFd(filePath) {
  const target = fs.statSync(filePath);
  const fdDirectory = fs.existsSync("/proc/self/fd") ? "/proc/self/fd" : "/dev/fd";
  for (const name of fs.readdirSync(fdDirectory)) {
    const fd = Number(name);
    if (!Number.isInteger(fd) || fd <= 3) continue;
    try {
      const candidate = fs.fstatSync(fd);
      if (candidate.dev === target.dev && candidate.ino === target.ino) return fd;
    } catch {
      // Descriptors can disappear while the directory is enumerated.
    }
  }
  return null;
}

function writeHandshake(payload) {
  try {
    fs.writeSync(3, `${JSON.stringify(payload)}\n`);
    fs.closeSync(3);
  } catch (error) {
    fail(`state-lock handshake failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function fail(message) {
  process.stderr.write(`[successor-state-lock] ${message}\n`);
  process.exit(1);
}
