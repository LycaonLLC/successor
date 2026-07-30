import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

const pidfileSchema = "successor.process-host-pid.v1";
const tracked = new Map();
let exitHookInstalled = false;
const terminationListeners = new Map();

/**
 * Create a process supervisor scoped to one verification run directory.
 *
 * The systemd implementation preserves the existing transient user-unit
 * contract. The portable implementation owns a detached process group and a
 * pidfile beneath runDir, so cleanup can never widen beyond this run.
 */
export function createProcessHost({ runId, runDir, kind, inspectChildHooks } = {}) {
  const namespace = validateName(runId, "runId");
  if (!runDir) throw new Error("createProcessHost requires runDir");
  const root = path.resolve(runDir);
  const selectedKind = selectKind(kind);
  const logsDir = path.join(root, "logs");
  const pidsDir = path.join(root, "pids");

  const host = {
    kind: selectedKind,
    runId: namespace,
    runDir: root,
    async start(options) {
      const name = validateName(options?.name, "process name");
      const argv = validateArgv(options?.argv);
      const cwd = path.resolve(options?.cwd ?? process.cwd());
      const env = normalizeEnv(options?.env);
      await fs.mkdir(logsDir, { recursive: true });
      await fs.mkdir(pidsDir, { recursive: true });
      const logPath = path.join(logsDir, `${name}.log`);

      const handle = selectedKind === "systemd"
        ? await startSystemd({ name, argv, env: options?.env ?? {}, cwd, logPath })
        : await startChild({ name, argv, env, cwd, logPath, pidsDir, namespace });

      if (options?.persist !== true) trackOwned(host, handle);
      return handle;
    },
    async stop(handle, options = {}) {
      const normalized = validateHandle(handle, selectedKind, root);
      const result = selectedKind === "systemd"
        ? await stopSystemd(normalized, options)
        : await stopChild(normalized, pidsDir, namespace, options);
      if (result.ok) untrackOwned(host, normalized);
      return result;
    },
    async assertStopped(handle, options = {}) {
      const normalized = validateHandle(handle, selectedKind, root);
      const result = selectedKind === "systemd"
        ? await assertSystemdStopped(normalized, options)
        : await assertChildStopped(normalized, pidsDir, namespace, options);
      if (result.ok) untrackOwned(host, normalized);
      return result;
    },
    async observeStopped(handle, options = {}) {
      const normalized = validateHandle(handle, selectedKind, root);
      return selectedKind === "systemd"
        ? await assertSystemdStopped(normalized, options)
        : await observeChildStopped(normalized, pidsDir, namespace, options);
    },
    async logs(handle, options = {}) {
      const normalized = validateHandle(handle, selectedKind, root);
      return selectedKind === "systemd"
        ? systemdLogs(normalized, options)
        : childLogs(normalized, options);
    },
    async sweep(prefix) {
      if (selectedKind === "child") {
        const ownedPrefix = prefix === undefined ? "" : validateName(prefix, "sweep prefix");
        return sweepChildren(host, pidsDir, ownedPrefix);
      }
      const ownedPrefix = validateName(prefix ?? namespace, "sweep prefix");
      if (!ownedPrefix.startsWith(namespace)) {
        throw new Error(`refusing to sweep ${ownedPrefix}; systemd host owns only ${namespace}`);
      }
      return sweepSystemd(host, ownedPrefix);
    },
    async inspect(handle) {
      const normalized = validateHandle(handle, selectedKind, root);
      return selectedKind === "systemd"
        ? inspectSystemd(normalized)
        : inspectChild(normalized, pidsDir, namespace, inspectChildHooks);
    },
    /**
     * Recover a child handle only from this host's own persisted pidfile.
     * The returned birth token proves the PID was not reused; callers must
     * keep it private and pass only `handle` to lifecycle operations.
     */
    async recover(name) {
      if (selectedKind !== "child") throw new Error("persisted handle recovery requires the child process host");
      return recoverChild(name, pidsDir, namespace, root);
    },
    adopt(handle) {
      const normalized = validateHandle(handle, selectedKind, root);
      trackOwned(host, normalized);
      return normalized;
    },
  };

  return host;
}

function selectKind(requestedKind) {
  const override = process.env.SUCCESSOR_PROCESS_HOST;
  if (override && override !== "systemd" && override !== "child") {
    throw new Error(`SUCCESSOR_PROCESS_HOST must be systemd or child; got ${override}`);
  }
  const requested = override ?? requestedKind;
  if (requested && requested !== "systemd" && requested !== "child") {
    throw new Error(`process host kind must be systemd or child; got ${requested}`);
  }
  if (requested === "systemd") {
    if (!systemdAvailable()) throw new Error("systemd process host requested, but the user systemd manager is unavailable");
    return "systemd";
  }
  if (requested === "child") return "child";
  return systemdAvailable() ? "systemd" : "child";
}

function systemdAvailable() {
  for (const command of ["systemd-run", "systemctl", "journalctl"]) {
    const result = spawnSync(command, ["--version"], { stdio: "ignore", timeout: 1500 });
    if (result.error || result.status !== 0) return false;
  }
  const manager = spawnSync("systemctl", ["--user", "show-environment"], { stdio: "ignore", timeout: 1500 });
  return !manager.error && manager.status === 0;
}

async function startSystemd({ name, argv, env, cwd, logPath }) {
  const unit = `${name}.service`;
  stopSystemdByUnit(unit, cwd, 3000);
  const environmentFile = path.join(path.dirname(logPath), `.${name}.environment-${process.pid}-${Date.now()}`);
  await writeSystemdEnvironmentFile(environmentFile, env);
  try {
    runSync([
      "systemd-run",
      "--user",
      `--unit=${name}`,
      "--collect",
      "--same-dir",
      `--property=EnvironmentFile=${environmentFile}`,
      ...argv,
    ], { cwd });
  } finally {
    await fs.rm(environmentFile, { force: true });
  }
  const logFile = await openOutputNoFollow(logPath, { append: true });
  await logFile.close();
  return { name, unit, logPath };
}

async function stopSystemd(handle, { graceMs = 3000 } = {}) {
  const timeoutMs = positiveTimeout(graceMs, 3000);
  const stopped = stopSystemdByUnit(handle.unit, undefined, timeoutMs + 2000);
  if (stopped.error?.code === "ETIMEDOUT") {
    spawnSync("systemctl", ["--user", "kill", "--kill-whom=all", "--signal=KILL", handle.unit], {
      encoding: "utf8",
      timeout: 2000,
    });
  }
  return assertSystemdStopped(handle, { timeoutMs: timeoutMs + 2000 });
}

function stopSystemdByUnit(unit, cwd, timeoutMs) {
  return spawnSync("systemctl", ["--user", "stop", unit], {
    cwd,
    encoding: "utf8",
    timeout: timeoutMs,
  });
}

async function assertSystemdStopped(handle, { timeoutMs = 4000, intervalMs = 150 } = {}) {
  const deadline = Date.now() + positiveTimeout(timeoutMs, 4000);
  let finalState = "unknown";
  do {
    const active = spawnSync("systemctl", ["--user", "is-active", handle.unit], {
      encoding: "utf8",
      timeout: 1500,
    });
    finalState = `${active.stdout ?? ""}${active.stderr ?? ""}`.trim() || `exit-${active.status}`;
    if (active.error?.code === "ENOENT" || active.status !== 0 || ["inactive", "unknown", "failed"].includes(finalState)) {
      return stoppedResult(handle, finalState);
    }
    await delay(intervalMs);
  } while (Date.now() <= deadline);
  return survivorResult(handle, `${handle.unit} remained active after stop`, finalState);
}

async function systemdLogs(handle, options) {
  const args = ["--user", "-u", handle.unit];
  if (options.since) args.push("--since", String(options.since));
  if (options.priority) args.push("-p", String(options.priority));
  if (Number.isInteger(options.lines) && options.lines > 0) args.push("-n", String(options.lines));
  args.push("--no-pager", "-o", options.output ?? "cat");
  const result = spawnSync("journalctl", args, {
    encoding: "utf8",
    maxBuffer: options.maxBuffer ?? 16 * 1024 * 1024,
    timeout: options.timeoutMs ?? 5000,
  });
  const text = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  await fs.mkdir(path.dirname(handle.logPath), { recursive: true });
  const logFile = await openOutputNoFollow(handle.logPath);
  try { await logFile.writeFile(text, { encoding: "utf8" }); }
  finally { await logFile.close(); }
  return text;
}

async function sweepSystemd(host, prefix) {
  const result = spawnSync("systemctl", [
    "--user",
    "list-units",
    "--all",
    "--no-legend",
    "--plain",
    `${prefix}*.service`,
  ], { encoding: "utf8", timeout: 3000 });
  if (result.error || (result.status !== 0 && result.status !== 1)) {
    throw commandError(["systemctl", "--user", "list-units", `${prefix}*.service`], result);
  }
  const swept = [];
  const failures = [];
  for (const line of String(result.stdout ?? "").split(/\r?\n/u)) {
    const unit = line.trim().split(/\s+/u)[0];
    if (!unit || !unit.startsWith(prefix) || !unit.endsWith(".service")) continue;
    const handle = {
      name: unit.slice(0, -".service".length),
      unit,
      logPath: path.join(host.runDir, "logs", `${unit.slice(0, -".service".length)}.log`),
    };
    const stopped = await host.stop(handle);
    if (stopped.ok) swept.push(handle.name);
    else failures.push(...stopped.failures);
  }
  if (swept.length > 0) {
    spawnSync("systemctl", ["--user", "reset-failed", `${prefix}*.service`], {
      encoding: "utf8",
      timeout: 2000,
    });
  }
  return { kind: "systemd", swept, failures, ok: failures.length === 0 };
}

function inspectSystemd(handle) {
  const result = spawnSync("systemctl", [
    "--user",
    "show",
    handle.unit,
    "-p", "MainPID",
    "-p", "MemoryCurrent",
    "-p", "CPUUsageNSec",
    "-p", "ActiveState",
    "-p", "SubState",
  ], { encoding: "utf8", timeout: 2000 });
  if (result.status !== 0) {
    return { error: `${result.status}: ${`${result.stdout ?? ""}${result.stderr ?? ""}`.trim()}` };
  }
  const show = parseProperties(result.stdout);
  const mainPid = parsePositiveInt(show.MainPID);
  return {
    activeState: show.ActiveState ?? null,
    subState: show.SubState ?? null,
    mainPid,
    memoryCurrentBytes: parseNonNegativeInt(show.MemoryCurrent),
    cpuUsageNSec: parsePositiveInt(show.CPUUsageNSec),
    proc: mainPid ? linuxProcStatus(mainPid) : null,
    error: null,
  };
}

async function startChild({ name, argv, env, cwd, logPath, pidsDir, namespace }) {
  const existing = await readPidfile(pidfilePath(pidsDir, name));
  if (existing) {
    await stopChild({ name, pid: existing.pid, logPath }, pidsDir, namespace, { graceMs: 1000 });
    const survivor = await readPidfile(pidfilePath(pidsDir, name));
    if (survivor) throw new Error(`refusing to replace live owned process ${name} (${survivor.pid})`);
  }

  const logFile = await openOutputNoFollow(logPath);
  let child;
  try {
    child = spawn(argv[0], argv.slice(1), {
      cwd,
      env,
      detached: true,
      shell: false,
      stdio: ["ignore", logFile.fd, logFile.fd],
    });
    await spawned(child);
    if (!Number.isInteger(child.pid) || child.pid <= 0) throw new Error(`child host did not receive a pid for ${name}`);
    const handle = { name, pid: child.pid, logPath };
    const birthToken = await requireProcessBirthToken(child.pid);
    try {
      await writePidfileAtomic(pidfilePath(pidsDir, name), {
        schema: pidfileSchema,
        runId: namespace,
        name,
        pid: child.pid,
        birthToken,
        startedAt: new Date().toISOString(),
      });
    } catch (error) {
      if (processBirthToken(child.pid) === birthToken) killGroup(child.pid, "SIGKILL");
      throw error;
    }
    child.unref();
    return handle;
  } finally {
    await logFile.close();
  }
}

async function stopChild(handle, pidsDir, namespace, { graceMs = 3000 } = {}) {
  const file = pidfilePath(pidsDir, handle.name);
  const record = await readPidfile(file);
  if (!record) {
    if (!groupAlive(handle.pid)) return stoppedResult(handle, "inactive");
    return survivorResult(handle, `owned pidfile missing for live process group ${handle.pid}`, "ownership-unknown");
  }

  const identity = verifyChildIdentity(record, handle, namespace);
  if (identity.state === "mismatch") {
    await removePidfile(file);
    return stalePidfileResult(handle, identity.reason);
  }
  if (identity.state === "gone") {
    if (groupAlive(handle.pid)) {
      return survivorResult(handle, `leader died while process group ${handle.pid} remains live`, "leader-gone-group-live");
    }
    await removePidfile(file);
    return stoppedResult(handle, "inactive");
  }
  if (identity.state !== "match") {
    return survivorResult(handle, identity.reason, "identity-unavailable");
  }

  killGroup(handle.pid, "SIGTERM");
  const grace = positiveTimeout(graceMs, 3000);
  if (!(await waitForGroupExit(handle.pid, grace))) {
    const refreshed = await readPidfile(file);
    const killIdentity = refreshed
      ? verifyChildIdentity(refreshed, handle, namespace)
      : { state: "unknown", reason: `owned pidfile disappeared before SIGKILL for ${handle.name}` };
    if (killIdentity.state === "mismatch") {
      await removePidfile(file);
      return stalePidfileResult(handle, killIdentity.reason);
    }
    const orphanContinuation = killIdentity.state === "unknown"
      && refreshed
      && verifiedOrphanContinuation(record, refreshed, handle, namespace);
    if (killIdentity.state !== "match" && !orphanContinuation) {
      return survivorResult(handle, killIdentity.reason, "identity-unavailable");
    }
    killGroup(handle.pid, "SIGKILL");
    const killWaitMs = Math.max(500, Math.min(3000, grace));
    if (!(await waitForGroupExit(handle.pid, killWaitMs))) {
      return survivorResult(handle, `process group ${handle.pid} survived SIGTERM and SIGKILL`, "survivor");
    }
  }
  await removePidfile(file);
  return stoppedResult(handle, "inactive");
}

async function assertChildStopped(handle, pidsDir, namespace, { timeoutMs = 4000, intervalMs = 100 } = {}) {
  const file = pidfilePath(pidsDir, handle.name);
  const deadline = Date.now() + positiveTimeout(timeoutMs, 4000);
  do {
    const record = await readPidfile(file);
    if (!record) {
      if (!groupAlive(handle.pid)) return stoppedResult(handle, "inactive");
      return survivorResult(handle, `owned pidfile missing for live process group ${handle.pid}`, "ownership-unknown");
    }
    const identity = verifyChildIdentity(record, handle, namespace);
    if (identity.state === "mismatch") {
      await removePidfile(file);
      return stalePidfileResult(handle, identity.reason);
    }
    if (identity.state === "gone") {
      if (groupAlive(handle.pid)) {
        return survivorResult(handle, `leader died while process group ${handle.pid} remains live`, "leader-gone-group-live");
      }
      await removePidfile(file);
      return stoppedResult(handle, "inactive");
    }
    if (identity.state === "unknown") {
      return survivorResult(handle, identity.reason, "identity-unavailable");
    }
    await delay(intervalMs);
  } while (Date.now() <= deadline);
  return survivorResult(handle, `process group ${handle.pid} remained active`, "active");
}

async function observeChildStopped(handle, pidsDir, namespace, { timeoutMs = 4000, intervalMs = 100 } = {}) {
  const file = pidfilePath(pidsDir, handle.name);
  const deadline = Date.now() + positiveTimeout(timeoutMs, 4000);
  do {
    const record = await readPidfile(file);
    if (!record) {
      if (!groupAlive(handle.pid)) return stoppedResult(handle, "inactive");
      return survivorResult(handle, `owned pidfile missing for live process group ${handle.pid}`, "ownership-unknown");
    }
    const identity = verifyChildIdentity(record, handle, namespace);
    if (identity.state === "mismatch") {
      return stalePidfileResult(handle, identity.reason);
    }
    if (identity.state === "gone") {
      return groupAlive(handle.pid)
        ? survivorResult(handle, `leader died while process group ${handle.pid} remains live`, "leader-gone-group-live")
        : stoppedResult(handle, "inactive");
    }
    if (identity.state === "unknown") {
      return survivorResult(handle, identity.reason, "identity-unavailable");
    }
    await delay(intervalMs);
  } while (Date.now() <= deadline);
  return survivorResult(handle, `process group ${handle.pid} remained active`, "active");
}

async function childLogs(handle, options) {
  const text = await fs.readFile(handle.logPath, "utf8").catch((error) => {
    if (error?.code === "ENOENT") return "";
    throw error;
  });
  if (!Number.isInteger(options.lines) || options.lines <= 0) return text;
  const lines = text.split(/\r?\n/u);
  return lines.slice(-options.lines).join("\n");
}

async function sweepChildren(host, pidsDir, prefix) {
  const entries = await fs.readdir(pidsDir, { withFileTypes: true }).catch((error) => {
    if (error?.code === "ENOENT") return [];
    throw error;
  });
  const swept = [];
  const failures = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".pid")) continue;
    const record = await readPidfile(path.join(pidsDir, entry.name));
    if (!record || record.runId !== host.runId || !record.name.startsWith(prefix)) continue;
    const handle = {
      name: record.name,
      pid: record.pid,

      logPath: path.join(host.runDir, "logs", `${record.name}.log`),
    };
    const stopped = await host.stop(handle);
    if (stopped.ok) swept.push(handle.name);
    else failures.push(...stopped.failures);
  }
  return { kind: "child", swept, failures, ok: failures.length === 0 };
}
async function recoverChild(name, pidsDir, namespace, runDir) {
  const normalizedName = validateName(name, "process name");
  const file = pidfilePath(pidsDir, normalizedName);
  const record = await readPidfile(file);
  if (!record) return { active: false, reason: "pidfile-missing" };
  if (record.runId !== namespace || record.name !== normalizedName || !record.birthToken) {
    await removePidfile(file);
    return { active: false, reason: "pidfile-binding-mismatch" };
  }
  const handle = {
    name: normalizedName,
    pid: record.pid,
    logPath: path.join(runDir, "logs", `${normalizedName}.log`),
  };
  const identity = verifyChildIdentity(record, handle, namespace);
  if (identity.state === "match") return { handle, birthToken: record.birthToken, active: true };
  if (identity.state === "gone") {
    await removePidfile(file);
    return { handle, birthToken: record.birthToken, active: false, reason: "gone" };
  }
  if (identity.state === "mismatch") await removePidfile(file);
  return { active: false, reason: identity.state === "unknown" ? "identity-unavailable" : identity.state };
}

async function inspectChild(handle, pidsDir, namespace, inspectHooks) {
  const file = pidfilePath(pidsDir, handle.name);
  const birthTokenForInspect = typeof inspectHooks?.processBirthToken === "function"
    ? inspectHooks.processBirthToken
    : processBirthToken;
  let record;
  try {
    record = await readPidfile(file);
  } catch (error) {
    return untrustedChildInspection(handle, "ownership-unknown", `could not read owned pidfile for ${handle.name}: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (!record) {
    return groupAlive(handle.pid)
      ? untrustedChildInspection(handle, "ownership-unknown", `owned pidfile missing for live process group ${handle.pid}`)
      : inactiveChildInspection(handle);
  }

  const initialIdentityFailure = childIdentityFailureInspection(record, handle, namespace, birthTokenForInspect);
  if (initialIdentityFailure) return initialIdentityFailure;

  const snapshot = processGroupSnapshot(handle.pid);
  if (snapshot.state !== "complete") {
    return untrustedChildInspection(handle, "inspection-unavailable", snapshot.error);
  }
  if (typeof inspectHooks?.afterGroupSnapshot === "function") {
    await inspectHooks.afterGroupSnapshot({ handle, pidfile: file });
  }
  let confirmedRecord;
  try {
    confirmedRecord = await readPidfile(file);
  } catch (error) {
    return untrustedChildInspection(handle, "ownership-unknown", `could not read owned pidfile for ${handle.name}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!confirmedRecord) {
    return groupAlive(handle.pid)
      ? untrustedChildInspection(handle, "ownership-unknown", `owned pidfile missing for live process group ${handle.pid}`)
      : inactiveChildInspection(handle);
  }
  const postSnapshotIdentityFailure = childIdentityFailureInspection(confirmedRecord, handle, namespace, birthTokenForInspect);
  if (postSnapshotIdentityFailure) return postSnapshotIdentityFailure;
  if (!sameChildPidfileBinding(record, confirmedRecord)) {
    return untrustedChildInspection(handle, "stale-pidfile", `pidfile binding changed during process-group inspection for ${handle.name}`);
  }
  const main = snapshot.rows.find((row) => row.pid === handle.pid) ?? null;
  if (!main) {
    return untrustedChildInspection(handle, "inspection-unavailable", `owned process leader ${handle.pid} is not in expected process group ${handle.pid}`);
  }
  const groupMemory = snapshot.rows.map((row) => row.rssBytes).filter(Number.isFinite);
  const groupHighWater = snapshot.rows.map((row) => row.highWaterRssBytes).filter(Number.isFinite);
  const groupThreads = snapshot.rows.map((row) => row.threads).filter(Number.isFinite);
  const groupFds = snapshot.rows.map((row) => row.fileDescriptors).filter(Number.isFinite);
  return {
    activeState: "active",
    subState: "running",
    mainPid: handle.pid,
    memoryCurrentBytes: groupMemory.length ? groupMemory.reduce((sum, value) => sum + value, 0) : null,
    cpuUsageNSec: snapshot.rows.reduce((sum, row) => sum + row.cpuNSec, 0),
    proc: {
      rssBytes: main.rssBytes,
      highWaterRssBytes: groupHighWater.length ? Math.max(...groupHighWater) : null,
      threads: groupThreads.length ? groupThreads.reduce((sum, value) => sum + value, 0) : null,
      fileDescriptors: groupFds.length ? groupFds.reduce((sum, value) => sum + value, 0) : null,
    },
    processGroup: snapshot.rows,
    error: null,
  };
}

function childIdentityFailureInspection(record, handle, namespace, birthTokenForInspect) {
  const identity = verifyChildIdentity(record, handle, namespace, birthTokenForInspect);
  if (identity.state === "match") return null;
  if (identity.state === "mismatch") {
    const currentBirth = birthTokenForInspect(handle.pid);
    if (partialBirthIdentity(record.birthToken, currentBirth)) {
      return untrustedChildInspection(handle, "identity-unavailable", `could not verify complete process-birth identity for live process ${handle.pid}`);
    }
    return untrustedChildInspection(handle, "stale-pidfile", identity.reason);
  }
  if (identity.state === "gone") {
    return groupAlive(handle.pid)
      ? untrustedChildInspection(handle, "leader-gone-group-live", `leader died while process group ${handle.pid} remains live`)
      : inactiveChildInspection(handle);
  }
  return processAlive(handle.pid)
    ? untrustedChildInspection(handle, "identity-unavailable", identity.reason)
    : untrustedChildInspection(handle, "leader-gone-group-live", `leader died while process group ${handle.pid} remains live`);
}

function sameChildPidfileBinding(initial, confirmed) {
  return initial.runId === confirmed.runId
    && initial.name === confirmed.name
    && initial.pid === confirmed.pid
    && initial.birthToken === confirmed.birthToken
    && initial.startedAt === confirmed.startedAt;
}

function inactiveChildInspection(handle) {
  return {
    activeState: "inactive",
    subState: "dead",
    mainPid: handle.pid,
    memoryCurrentBytes: null,
    cpuUsageNSec: null,
    proc: null,
    error: null,
  };
}

function untrustedChildInspection(handle, subState, error) {
  return {
    activeState: "unknown",
    subState,
    mainPid: handle.pid,
    memoryCurrentBytes: null,
    cpuUsageNSec: null,
    proc: null,
    error,
  };
}

function partialBirthIdentity(expected, current) {
  if (!expected || !current) return false;
  const expectedPs = expected.includes("ps:");
  const expectedProc = expected.includes("proc:");
  const currentPs = current.includes("ps:");
  const currentProc = current.includes("proc:");
  return (expectedPs && !currentPs) || (expectedProc && !currentProc);
}

function processGroupSnapshot(pgid) {
  const result = spawnSync("ps", ["-axo", "pid=,pgid=,rss=,time="], {
    encoding: "utf8",
    timeout: 2000,
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    return { state: "unavailable", error: `could not obtain process-group snapshot for ${pgid}` };
  }
  const snapshot = process.env.SUCCESSOR_PROCESS_HOST_TEST_PS_MALFORMED === "1"
    ? "malformed ps success output"
    : String(result.stdout ?? "");
  const rows = [];
  for (const line of snapshot.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s*$/u.exec(line);
    if (!match) {
      return { state: "ambiguous", error: `ambiguous process-group snapshot for ${pgid}` };
    }
    const rowPid = Number(match[1]);
    const rowPgid = Number(match[2]);
    const rssKiB = Number(match[3]);
    if (rowPgid !== pgid) continue;
    if (!Number.isSafeInteger(rowPid) || rowPid <= 0 || !Number.isSafeInteger(rowPgid) || rowPgid <= 0 || !Number.isSafeInteger(rssKiB) || rssKiB < 0) {
      return { state: "ambiguous", error: `ambiguous process-group snapshot for ${pgid}` };
    }
    const cpuNSec = parsePsTimeNs(match[4]);
    const rssBytes = rssKiB * 1024;
    if (!Number.isSafeInteger(cpuNSec) || !Number.isSafeInteger(rssBytes)) {
      return { state: "ambiguous", error: `ambiguous process-group snapshot for ${pgid}` };
    }
    const proc = linuxProcStatus(rowPid);
    rows.push({
      pid: rowPid,
      pgid: rowPgid,
      rssBytes,
      cpuNSec,
      highWaterRssBytes: proc?.highWaterRssBytes ?? null,
      threads: proc?.threads ?? null,
      fileDescriptors: proc?.fileDescriptors ?? null,
    });
  }
  return { state: "complete", rows };
}

function parsePsTimeNs(value) {
  const [dayPart, clockPart] = value.includes("-") ? value.split("-", 2) : ["0", value];
  if (!/^\d+$/u.test(dayPart)) return null;
  const fields = clockPart.split(":");
  if (fields.length < 1 || fields.length > 3 || fields.some((field) => !/^\d+$/u.test(field))) return null;
  const values = fields.map(Number);
  let seconds = Number(dayPart) * 86400;
  if (fields.length === 3) seconds += values[0] * 3600 + values[1] * 60 + values[2];
  else if (fields.length === 2) seconds += values[0] * 60 + values[1];
  else seconds += values[0];
  return Number.isSafeInteger(seconds) && seconds >= 0 && Number.isSafeInteger(seconds * 1_000_000_000)
    ? seconds * 1_000_000_000
    : null;
}

async function requireProcessBirthToken(pid) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const token = processBirthToken(pid);
    if (token) return token;
    await delay(10);
  }
  throw new Error(`could not establish process-birth identity for pid ${pid}`);
}

function processBirthToken(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const ps = spawnSync("ps", ["-o", "pid=,pgid=,lstart=", "-p", String(pid)], {
    encoding: "utf8",
    timeout: 1500,
  });
  const psStart = ps.status === 0 ? String(ps.stdout ?? "").trim().replace(/\s+/gu, " ") : "";
  const linuxStart = linuxProcessStartTicks(pid);
  if (psStart && linuxStart) return `ps:${psStart}|proc:${linuxStart}`;
  if (psStart) return `ps:${psStart}`;
  if (linuxStart) return `proc:${linuxStart}`;
  return null;
}

function linuxProcessStartTicks(pid) {
  if (process.platform !== "linux") return null;
  try {
    const stat = fsSync.readFileSync(`/proc/${pid}/stat`, "utf8");
    const close = stat.lastIndexOf(")");
    if (close < 0) return null;
    const fieldsFromState = stat.slice(close + 1).trim().split(/\s+/u);
    const startTicks = fieldsFromState[19];
    return /^\d+$/u.test(startTicks ?? "") ? startTicks : null;
  } catch {
    return null;
  }
}

function verifyChildIdentity(record, handle, namespace, birthTokenForProcess = processBirthToken) {
  if (record.runId !== namespace) {
    return { state: "mismatch", reason: `pidfile runId mismatch for ${handle.name}` };
  }
  if (record.name !== handle.name) {
    return { state: "mismatch", reason: `pidfile name mismatch for ${handle.name}` };
  }
  if (record.pid !== handle.pid) {
    return { state: "mismatch", reason: `pidfile pid mismatch for ${handle.name}` };
  }
  if (!record.birthToken) {
    return { state: "mismatch", reason: `pidfile birth token missing for ${handle.name}` };
  }
  const current = birthTokenForProcess(handle.pid);
  if (!current) {
    return groupAlive(handle.pid)
      ? { state: "unknown", reason: `could not verify process-birth identity for live group ${handle.pid}` }
      : { state: "gone", reason: `process ${handle.pid} is gone` };
  }
  if (current !== record.birthToken) {
    return { state: "mismatch", reason: `pidfile birth token mismatch for ${handle.name}` };
  }
  return { state: "match", reason: null };
}

function verifiedOrphanContinuation(preTermRecord, refreshed, handle, namespace) {
  return preTermRecord.runId === namespace
    && preTermRecord.name === handle.name
    && preTermRecord.pid === handle.pid
    && Boolean(preTermRecord.birthToken)
    && refreshed.runId === preTermRecord.runId
    && refreshed.name === preTermRecord.name
    && refreshed.pid === preTermRecord.pid
    && refreshed.birthToken === preTermRecord.birthToken
    && processBirthToken(handle.pid) === null
    && groupAlive(handle.pid);
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function groupAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  // `kill(-pgid, 0)` reports a zombie-only group as existent. A *complete*,
  // parseable ps snapshot can refine that to dead; empty/malformed/truncated
  // successful output is ambiguous and must retain the conservative probe.
  const ps = spawnSync("ps", ["-axo", "pid=,pgid=,stat="], {
    encoding: "utf8",
    timeout: 1500,
    maxBuffer: 4 * 1024 * 1024,
  });
  const snapshot = process.env.SUCCESSOR_PROCESS_HOST_TEST_PS_MALFORMED === "1"
    ? "malformed ps success output"
    : String(ps.stdout ?? "");
  let rows = 0;
  let ambiguous = ps.status !== 0;
  let live = false;
  if (!ambiguous) {
    for (const line of snapshot.split(/\r?\n/u)) {
      if (!line.trim()) continue;
      const match = /^\s*\d+\s+(\d+)\s+(\S+)\s*$/u.exec(line);
      if (!match) {
        ambiguous = true;
        break;
      }
      rows += 1;
      if (Number(match[1]) === pid && !match[2].startsWith("Z")) live = true;
    }
  }
  if (!ambiguous && rows > 0) return live;
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function killGroup(pid, signal) {
  try {
    process.kill(-pid, signal);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

async function waitForGroupExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    if (!groupAlive(pid)) return true;
    await delay(50);
  }
  return !groupAlive(pid);
}

function trackOwned(host, handle) {
  installExitHook();
  tracked.set(trackKey(host, handle), { host, handle });
}

function untrackOwned(host, handle) {
  tracked.delete(trackKey(host, handle));
}

function trackKey(host, handle) {
  return `${host.kind}\0${host.runDir}\0${handle.name}`;
}

function installExitHook() {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.on("exit", cleanupTrackedOnExit);
  for (const signal of ["SIGINT", "SIGTERM"]) {
    const listener = () => handleTerminationSignal(signal, listener);
    terminationListeners.set(signal, listener);
    process.on(signal, listener);
  }
}

function cleanupTrackedOnExit() {
  for (const { host, handle } of tracked.values()) cleanupOnExit(host, handle);
  tracked.clear();
}

function handleTerminationSignal(signal, ownListener) {
  const hasOtherListeners = process.listeners(signal).some((listener) => listener !== ownListener);
  cleanupTrackedOnExit();
  process.off(signal, ownListener);
  terminationListeners.delete(signal);
  if (!hasOtherListeners) process.kill(process.pid, signal);
}

function cleanupOnExit(host, handle) {
  if (host.kind === "systemd") {
    spawnSync("systemctl", ["--user", "stop", handle.unit], { stdio: "ignore", timeout: 2000 });
    spawnSync("systemctl", ["--user", "kill", "--kill-whom=all", "--signal=KILL", handle.unit], {
      stdio: "ignore",
      timeout: 1000,
    });
    return;
  }
  const file = path.join(host.runDir, "pids", `${handle.name}.pid`);
  const record = readPidfileSync(file);
  if (!record) return;
  const identity = verifyChildIdentity(record, handle, host.runId);
  if (identity.state === "match") {
    try { process.kill(-handle.pid, "SIGKILL"); } catch { /* already gone */ }
  }
  if (identity.state === "match" || identity.state === "mismatch" || identity.state === "gone") {
    try { fsSync.unlinkSync(file); } catch { /* already removed */ }
  }
}

function validateName(value, label) {
  const name = String(value ?? "").trim();
  if (!name || !/^[A-Za-z0-9_.:@-]+$/u.test(name) || name === "." || name === "..") {
    throw new Error(`${label} must contain only letters, digits, dot, underscore, colon, at, or dash`);
  }
  return name;
}

function validateArgv(argv) {
  if (!Array.isArray(argv) || argv.length === 0 || argv.some((arg) => typeof arg !== "string" || arg.includes("\0"))) {
    throw new Error("process host start requires a non-empty string argv array");
  }
  return [...argv];
}

function validateHandle(handle, kind, runDir) {
  const name = validateName(handle?.name, "process handle name");
  const logPath = path.resolve(handle?.logPath ?? path.join(runDir, "logs", `${name}.log`));
  if (!isWithin(runDir, logPath)) throw new Error(`process handle logPath escapes runDir: ${logPath}`);
  if (kind === "systemd") {
    const unit = String(handle?.unit ?? `${name}.service`);
    if (unit !== `${name}.service`) throw new Error(`process handle unit mismatch for ${name}`);
    return { name, unit, logPath };
  }
  const pid = Number(handle?.pid);
  if (!Number.isInteger(pid) || pid <= 0) throw new Error(`process handle ${name} has invalid pid`);
  return { name, pid, logPath };
}

async function openOutputNoFollow(file, { append = false } = {}) {
  const flags = fsSync.constants.O_WRONLY
    | fsSync.constants.O_CREAT
    | fsSync.constants.O_NOFOLLOW
    | (append ? fsSync.constants.O_APPEND : fsSync.constants.O_TRUNC);
  const handle = await fs.open(file, flags, 0o600);
  await handle.chmod(0o600);
  return handle;
}

async function writeSystemdEnvironmentFile(file, env) {
  const lines = [];
  for (const [key, rawValue] of Object.entries(env ?? {})) {
    if (rawValue === undefined) continue;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key)) throw new Error(`invalid environment key: ${key}`);
    const value = String(rawValue);
    if (/[\r\n\0]/u.test(value)) throw new Error(`systemd environment value for ${key} contains a forbidden control character`);
    const escaped = value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("$", "\\$").replaceAll("`", "\\`");
    lines.push(`${key}="${escaped}"`);
  }
  const flags = fsSync.constants.O_WRONLY | fsSync.constants.O_CREAT | fsSync.constants.O_EXCL | fsSync.constants.O_NOFOLLOW;
  const handle = await fs.open(file, flags, 0o600);
  try {
    await handle.writeFile(`${lines.join("\n")}${lines.length ? "\n" : ""}`, { encoding: "utf8" });
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function normalizeEnv(env) {
  const merged = { ...process.env };
  for (const [key, value] of Object.entries(env ?? {})) {
    if (value === undefined) delete merged[key];
    else merged[key] = String(value);
  }
  return merged;
}

function pidfilePath(pidsDir, name) {
  return path.join(pidsDir, `${validateName(name, "pidfile name")}.pid`);
}

async function writePidfileAtomic(file, record) {
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temp, `${JSON.stringify(record)}\n`, { encoding: "utf8", flag: "wx" });
  try {
    await fs.rename(temp, file);
  } catch (error) {
    await fs.rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function readPidfile(file) {
  let handle;
  try {
    handle = await fs.open(file, fsSync.constants.O_RDONLY | fsSync.constants.O_NOFOLLOW);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) throw new Error(`process-host pidfile is not a regular file: ${file}`);
    return parsePidfile(await handle.readFile({ encoding: "utf8" }), file);
  } finally {
    await handle.close();
  }
}

function readPidfileSync(file) {
  let descriptor;
  try {
    descriptor = fsSync.openSync(file, fsSync.constants.O_RDONLY | fsSync.constants.O_NOFOLLOW);
    if (!fsSync.fstatSync(descriptor).isFile()) return null;
    return parsePidfile(fsSync.readFileSync(descriptor, "utf8"), file);
  } catch {
    return null;
  } finally {
    if (descriptor !== undefined) fsSync.closeSync(descriptor);
  }
}

function parsePidfile(text, file) {
  try {
    const parsed = JSON.parse(text);
    if (parsed?.schema !== pidfileSchema) throw new Error("unknown schema");
    return {
      name: validateName(parsed.name, "pidfile process name"),
      pid: parseRequiredPid(parsed.pid),
      runId: String(parsed.runId ?? ""),
      birthToken: typeof parsed.birthToken === "string" && parsed.birthToken ? parsed.birthToken : null,
      startedAt: typeof parsed.startedAt === "string" ? parsed.startedAt : null,
    };
  } catch (error) {
    throw new Error(`invalid process-host pidfile ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function removePidfile(file) {
  await fs.rm(file, { force: true });
}

function spawned(child) {
  return new Promise((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
}

function runSync(argv, options = {}) {
  const result = spawnSync(argv[0], argv.slice(1), {
    cwd: options.cwd,
    env: options.env ?? process.env,
    encoding: "utf8",
    timeout: options.timeoutMs ?? 15000,
    maxBuffer: options.maxBuffer ?? 8 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) throw commandError(argv, result);
  return result;
}

function commandError(argv, result) {
  const rendered = argv.map((arg) => arg.startsWith("--setenv=") ? `${arg.slice(0, arg.indexOf("=") + 1)}<redacted>` : arg).join(" ");
  const detail = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  return new Error(`${rendered} failed ${result.error?.code ?? result.status}${detail ? `\n${detail}` : ""}`);
}

function stoppedResult(handle, finalState) {
  return {
    ok: true,
    name: handle.name,
    unit: handle.unit ?? handle.name,
    pid: handle.pid ?? null,
    finalState,
    failures: [],
  };
}

function stalePidfileResult(handle, reason) {
  return {
    ...stoppedResult(handle, "stale-pidfile"),
    stalePidfile: true,
    staleReason: reason,
  };
}

function survivorResult(handle, failure, finalState) {
  return {
    ok: false,
    name: handle.name,
    unit: handle.unit ?? handle.name,
    pid: handle.pid ?? null,
    finalState,
    failures: [failure],
  };
}

function parseProperties(text) {
  const out = {};
  for (const line of String(text ?? "").split(/\r?\n/u)) {
    const eq = line.indexOf("=");
    if (eq > 0) out[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return out;
}

function linuxProcStatus(pid) {
  if (process.platform !== "linux") return null;
  try {
    const values = {};
    for (const line of fsSync.readFileSync(`/proc/${pid}/status`, "utf8").split(/\r?\n/u)) {
      const match = /^([^:]+):\s+(.+)$/u.exec(line);
      if (match) values[match[1]] = match[2];
    }
    return {
      rssBytes: parseKb(values.VmRSS),
      highWaterRssBytes: parseKb(values.VmHWM),
      threads: parsePositiveInt(values.Threads),
      fileDescriptors: readFdCount(pid),
    };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

function readFdCount(pid) {
  if (process.platform !== "linux") return null;
  try {
    return fsSync.readdirSync(`/proc/${pid}/fd`).length;
  } catch {
    return null;
  }
}

function parseKb(value) {
  const match = /^(\d+)\s+kB$/u.exec(String(value ?? ""));
  return match ? Number(match[1]) * 1024 : null;
}

function parsePositiveInt(value) {
  const number = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function parseNonNegativeInt(value) {
  const number = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(number) && number >= 0 && number <= Number.MAX_SAFE_INTEGER ? number : null;
}

function parseRequiredPid(value) {
  const pid = Number(value);
  if (!Number.isInteger(pid) || pid <= 0) throw new Error(`invalid pid ${value}`);
  return pid;
}

function positiveTimeout(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

function isWithin(parent, child) {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}
