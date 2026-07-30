import childProcess from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const flockBin = "/usr/bin/flock";
const handshakeSchema = "successor.state-lock.v1";
const handshakeTimeoutMs = 5_000;
const releaseTimeoutMs = 2_000;
let activeLease: HostedStateLockLease | undefined;

export interface HostedStateLockLease {
  readonly lockPath: string;
  readonly ownerPid: number;
  readonly child: childProcess.ChildProcess;
  released: boolean;
}

/**
 * Own the state-domain lease in a tiny child process. The child inherits the
 * kernel flock and exits when this process disappears (its stdin closes), so a
 * parent/container kill cannot leave a writer behind.
 */
export async function acquireHostedStateLock(stateDir: string, lockPath = path.join(stateDir, ".desktop-state.lock")): Promise<HostedStateLockLease> {
  const resolvedStateDir = path.resolve(stateDir);
  const resolvedLockPath = path.resolve(lockPath);
  fs.mkdirSync(resolvedStateDir, { recursive: true });
  if (!fs.existsSync(flockBin)) throw new Error(`hosted state locking requires ${flockBin}`);
  const moduleDir = path.dirname(new URL(import.meta.url).pathname);
  const supervisorCandidates = [path.join(moduleDir, "state-lock-supervisor.js"), path.join(moduleDir, "..", "dist", "state-lock-supervisor.js")];
  const supervisorPath = supervisorCandidates.find((candidate) => fs.existsSync(candidate));
  if (!supervisorPath) throw new Error(`hosted state-lock supervisor is missing at ${supervisorCandidates.join(", ")}`);
  const child = childProcess.spawn(flockBin, ["--exclusive", "--nonblock", "--no-fork", resolvedLockPath, process.execPath, supervisorPath, resolvedLockPath], {
    cwd: resolvedStateDir,
    detached: true,
    stdio: ["pipe", "ignore", "pipe", "pipe"],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
  });
  try {
    const handshake = await waitForHandshake(child, resolvedLockPath);
    const lease = { lockPath: resolvedLockPath, ownerPid: handshake.pid, child, released: false };
    activeLease = lease;
    child.once("exit", () => { if (activeLease === lease) activeLease = undefined; });
    return lease;
  } catch (error) {
    try { child.stdin?.destroy(); } catch { /* already closed */ }
    try { if (child.pid) process.kill(-(child.pid), "SIGKILL"); } catch { /* already gone */ }
    await waitForExit(child, releaseTimeoutMs);
    throw error;
  }
}

export async function releaseHostedStateLock(lease: HostedStateLockLease | undefined): Promise<void> {
  if (!lease || lease.released) return;
  lease.released = true;
  if (activeLease === lease) activeLease = undefined;
  if (lease.child.exitCode !== null || lease.child.signalCode !== null) return;
  try {
    lease.child.stdin?.end("release\n");
  } catch {
    try { lease.child.kill("SIGTERM"); } catch { /* already gone */ }
  }
  if (await waitForExit(lease.child, releaseTimeoutMs)) return;
  try { process.kill(-(lease.child.pid ?? 0), "SIGKILL"); } catch { /* already gone */ }
  await waitForExit(lease.child, releaseTimeoutMs);
}

export function hostedStateLockHealthy(): boolean {
  if (activeLease && !activeLease.released && activeLease.child.exitCode === null && activeLease.child.signalCode === null) return true;
  const rawFd = process.env.GAME_STATE_LOCK_FD;
  if (!rawFd) return false;
  const fd = Number(rawFd);
  if (!Number.isInteger(fd) || fd < 3) return false;
  try { return fs.fstatSync(fd).isFile(); } catch { return false; }
}

function waitForHandshake(child: childProcess.ChildProcess, expectedLockPath: string): Promise<{ pid: number }> {
  return new Promise((resolve, reject) => {
    const stream = child.stdio?.[3];
    if (!stream || !("setEncoding" in stream) || typeof stream.setEncoding !== "function") { reject(new Error("hosted state-lock handshake pipe unavailable")); return; }
    stream.setEncoding("utf8");
    let buffer = "";
    let settled = false;
    const timer = setTimeout(() => fail(new Error(`hosted state-lock ownership not proven within ${handshakeTimeoutMs}ms`)), handshakeTimeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      stream.off("data", onData);
      stream.off("end", onEnd);
      stream.off("error", onError);
      child.off("error", onChildError);
      child.off("exit", onExit);
    };
    const fail = (error: Error) => { if (settled) return; settled = true; cleanup(); reject(error); };
    const succeed = (value: { pid: number }) => { if (settled) return; settled = true; cleanup(); resolve(value); };
    const onData = (chunk: string) => {
      buffer += chunk;
      if (buffer.length > 16_384) { fail(new Error("hosted state-lock handshake exceeded 16KB")); return; }
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      try {
        const value = JSON.parse(buffer.slice(0, newline)) as { schema?: unknown; pid?: unknown; lockPath?: unknown };
        if (value.schema !== handshakeSchema || !Number.isInteger(value.pid) || (value.pid as number) <= 0 || path.resolve(String(value.lockPath ?? "")) !== expectedLockPath) {
          fail(new Error("hosted state-lock supervisor sent malformed or mismatched ownership proof"));
          return;
        }
        succeed({ pid: value.pid as number });
      } catch (error) {
        fail(new Error(`hosted state-lock supervisor sent invalid handshake JSON: ${error instanceof Error ? error.message : String(error)}`));
      }
    };
    const onEnd = () => fail(new Error("hosted state-lock supervisor closed before ownership proof"));
    const onError = (error: Error) => fail(error);
    const onChildError = (error: Error) => fail(error);
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => fail(new Error(`hosted state-lock supervisor exited before ownership proof code=${code ?? "null"} signal=${signal ?? "null"}`));
    stream.on("data", onData);
    stream.once("end", onEnd);
    stream.once("error", onError);
    child.once("error", onChildError);
    child.once("exit", onExit);
  });
}

function waitForExit(child: childProcess.ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const finish = (value: boolean) => { clearTimeout(timer); child.off("exit", onExit); resolve(value); };
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    child.once("exit", onExit);
  });
}
