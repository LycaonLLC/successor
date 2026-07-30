import { describe, test, expect, beforeAll, afterAll, afterEach } from "vitest";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createProcessHost } from "./process-host.mjs";

const testRunDir = path.resolve(
  import.meta.dirname,
  "../../../verification/.runs/test-process-host-" + Math.random().toString(36).substring(2, 10)
);

function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

function hasSystemd() {
  for (const command of ["systemd-run", "systemctl", "journalctl"]) {
    const result = spawnSync(command, ["--version"], { stdio: "ignore", timeout: 1500 });
    if (result.error || result.status !== 0) return false;
  }
  const manager = spawnSync("systemctl", ["--user", "show-environment"], { stdio: "ignore", timeout: 1500 });
  return !manager.error && manager.status === 0;
}

beforeAll(async () => {
  await fs.mkdir(testRunDir, { recursive: true });
});

afterAll(async () => {
  await fs.rm(testRunDir, { recursive: true, force: true }).catch(() => {});
});

describe("ProcessHost Kind Selection", () => {
  const origHostEnv = process.env.SUCCESSOR_PROCESS_HOST;

  afterEach(() => {
    if (origHostEnv === undefined) {
      delete process.env.SUCCESSOR_PROCESS_HOST;
    } else {
      process.env.SUCCESSOR_PROCESS_HOST = origHostEnv;
    }
  });

  test("explicit kind child", () => {
    const host = createProcessHost({ runId: "testsel1", runDir: testRunDir, kind: "child" });
    expect(host.kind).toBe("child");
  });

  test("explicit kind systemd", () => {
    if (hasSystemd()) {
      const host = createProcessHost({ runId: "testsel2", runDir: testRunDir, kind: "systemd" });
      expect(host.kind).toBe("systemd");
    } else {
      expect(() =>
        createProcessHost({ runId: "testsel2", runDir: testRunDir, kind: "systemd" })
      ).toThrow("user systemd manager is unavailable");
    }
  });

  test("override via env SUCCESSOR_PROCESS_HOST", () => {
    process.env.SUCCESSOR_PROCESS_HOST = "child";
    const host = createProcessHost({ runId: "testsel3", runDir: testRunDir, kind: "systemd" });
    expect(host.kind).toBe("child");
  });

  test("invalid kind throws", () => {
    expect(() =>
      createProcessHost({ runId: "testsel4", runDir: testRunDir, kind: "invalid" })
    ).toThrow();
  });

  test("invalid env override throws", () => {
    process.env.SUCCESSOR_PROCESS_HOST = "invalid";
    expect(() => createProcessHost({ runId: "testsel5", runDir: testRunDir })).toThrow();
  });
});

describe("ProcessHost Child Mode Behavior", () => {
  let host;

  beforeAll(() => {
    host = createProcessHost({ runId: "testchild", runDir: testRunDir, kind: "child" });
  });

  test("argv/env/cwd/log capture", async () => {
    const name = "argv-env-cwd-test";
    const handle = await host.start({
      name,
      argv: [
        process.execPath,
        "-e",
        "console.log('ARGV_JSON:' + JSON.stringify(process.argv)); console.log('ENV_VAR:' + process.env.TEST_VAR); console.log('CWD_VAL:' + process.cwd());",
        "arg1",
        "arg2"
      ],
      env: { TEST_VAR: "captureready" },
      cwd: testRunDir
    });

    expect(handle.name).toBe(name);
    expect(handle.pid).toBeGreaterThan(0);
    expect(handle.logPath).toBe(path.join(testRunDir, "logs", `${name}.log`));

    // Wait for the process to exit and then check logs
    await host.assertStopped(handle, { timeoutMs: 5000 });

    const logs = await host.logs(handle);
    expect(logs).toContain("ARGV_JSON:");
    expect(logs).toContain("arg1");
    expect(logs).toContain("arg2");
    expect(logs).toContain("ENV_VAR:captureready");
    expect(logs).toContain("CWD_VAL:" + testRunDir);
  });

  test("refuses a symlinked child log before spawning or changing its target", async () => {
    const name = "symlink-log-test";
    const outside = path.join(testRunDir, "outside-child-log.txt");
    const logPath = path.join(testRunDir, "logs", `${name}.log`);
    await fs.mkdir(path.dirname(logPath), { recursive: true });
    await fs.writeFile(outside, "sentinel", { encoding: "utf8", mode: 0o600 });
    await fs.rm(logPath, { force: true });
    await fs.symlink(outside, logPath);
    try {
      await expect(host.start({ name, argv: [process.execPath, "-e", "console.log('must-not-run')"] })).rejects.toThrow(/ELOOP|symbolic link/iu);
      expect(await fs.readFile(outside, "utf8")).toBe("sentinel");
      expect(fsSync.existsSync(path.join(testRunDir, "pids", `${name}.pid`))).toBe(false);
    } finally {
      await fs.rm(logPath, { force: true });
      await fs.rm(outside, { force: true });
    }
  });

  test("atomic pidfile creation and reading", async () => {
    const name = "pidfile-test";
    const handle = await host.start({
      name,
      argv: [process.execPath, "-e", "setTimeout(() => {}, 5000)"]
    });

    const pidfile = path.join(testRunDir, "pids", `${name}.pid`);
    expect(fsSync.existsSync(pidfile)).toBe(true);

    const content = await fs.readFile(pidfile, "utf8");
    const parsed = JSON.parse(content);
    expect(parsed.schema).toBe("successor.process-host-pid.v1");
    expect(parsed.runId).toBe("testchild");
    expect(parsed.name).toBe(name);
    expect(parsed.pid).toBe(handle.pid);

    await host.stop(handle);
    expect(fsSync.existsSync(pidfile)).toBe(false);
  });

  test("refuses a symlinked owned pidfile without terminating its live process", async () => {
    const name = "pidfile-symlink-test";
    const handle = await host.start({ name, argv: [process.execPath, "-e", "setTimeout(() => {}, 10000)"] });
    const pidfile = path.join(testRunDir, "pids", `${name}.pid`);
    const outside = path.join(testRunDir, "outside-owned-pidfile.json");
    await fs.rename(pidfile, outside);
    await fs.symlink(outside, pidfile);
    try {
      await expect(host.start({ name, argv: [process.execPath, "-e", "process.exit(0)"] })).rejects.toThrow(/ELOOP|symbolic link/iu);
      expect(isPidAlive(handle.pid)).toBe(true);
      expect(JSON.parse(await fs.readFile(outside, "utf8")).pid).toBe(handle.pid);
    } finally {
      await fs.rm(pidfile, { force: true });
      await fs.rename(outside, pidfile);
      await host.stop(handle);
    }
  });

  test("prevent duplicate start if alive", async () => {
    const name = "duplicate-test";
    const handle = await host.start({
      name,
      argv: [process.execPath, "-e", "setTimeout(() => {}, 10000)"]
    });

    const originalKill = process.kill;
    try {
      // Mock process.kill to prevent killing (except signal 0 which checks liveness)
      process.kill = (pid, signal) => {
        if (signal === 0) {
          return originalKill(pid, 0);
        }
        return true;
      };

      await expect(
        host.start({
          name,
          argv: [process.execPath, "-e", "setTimeout(() => {}, 10000)"]
        })
      ).rejects.toThrow("refusing to replace live owned process");
    } finally {
      process.kill = originalKill;
    }

    try { process.kill(-handle.pid, "SIGKILL"); } catch {}
    await host.stop(handle);
  });

  test("process-group child/grandchild stop", async () => {
    const name = "group-kill-test";
    // Spawn a parent that spawns a grandchild and keeps both running
    const script = `
      const { spawn } = require('child_process');
      const grandchild = spawn('${process.execPath}', ['-e', 'setTimeout(() => {}, 20000)'], {
        detached: false, // child of this process
        stdio: 'ignore'
      });
      console.log('GRANDCHILD_PID:' + grandchild.pid);
      setTimeout(() => {}, 20000);
    `;

    const handle = await host.start({
      name,
      argv: [process.execPath, "-e", script]
    });

    // Wait for the grandchild PID to be printed in logs
    let grandchildPid = null;
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const logs = await host.logs(handle);
      const match = /GRANDCHILD_PID:(\d+)/.exec(logs);
      if (match) {
        grandchildPid = Number(match[1]);
        break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }

    expect(grandchildPid).toBeGreaterThan(0);
    expect(isPidAlive(handle.pid)).toBe(true);
    expect(isPidAlive(grandchildPid)).toBe(true);

    // Stop parent, which should kill process group (including grandchild)
    await host.stop(handle);

    expect(isPidAlive(handle.pid)).toBe(false);
    expect(isPidAlive(grandchildPid)).toBe(false);
  });

  test("inspect reports only the owned process group", async () => {
    const handle = await host.start({
      name: "group-inspect-test",
      argv: [process.execPath, "-e", "setTimeout(() => {}, 10000)"]
    });

    try {
      const inspection = await host.inspect(handle);
      expect(inspection.error).toBeNull();
      expect(inspection.activeState).toBe("active");
      expect(inspection.processGroup.some((row) => row.pid === handle.pid)).toBe(true);
      expect(inspection.processGroup.every((row) => row.pgid === handle.pid)).toBe(true);
      expect(inspection.processGroup.some((row) => row.pid === process.pid)).toBe(false);
      expect(inspection.memoryCurrentBytes).toBe(
        inspection.processGroup.reduce((sum, row) => sum + row.rssBytes, 0)
      );
      expect(inspection.cpuUsageNSec).toBe(
        inspection.processGroup.reduce((sum, row) => sum + row.cpuNSec, 0)
      );
    } finally {
      await host.stop(handle);
    }
  });

  test("TERM grace then KILL with stubborn child", async () => {
    const name = "stubborn-test";
    const script = `
      process.on('SIGTERM', () => {
        console.log('IGNORED_SIGTERM');
      });
      setTimeout(() => {}, 10000);
    `;

    const handle = await host.start({
      name,
      argv: [process.execPath, "-e", script]
    });

    // Wait for node to boot and register SIGTERM listener
    await new Promise((r) => setTimeout(r, 600));

    const started = Date.now();
    // Stop with a short grace period
    const stopResult = await host.stop(handle, { graceMs: 500 });
    const duration = Date.now() - started;

    expect(stopResult.ok).toBe(true);
    expect(isPidAlive(handle.pid)).toBe(false);
    // Should have taken at least 500ms grace period before SIGKILL
    expect(duration).toBeGreaterThanOrEqual(400);

    const logs = await host.logs(handle);
    expect(logs).toContain("IGNORED_SIGTERM");
  });

  test("idempotent stop", async () => {
    const name = "idempotent-test";
    const handle = await host.start({
      name,
      argv: [process.execPath, "-e", "process.exit(0)"]
    });

    await host.assertStopped(handle);

    const stop1 = await host.stop(handle);
    expect(stop1.ok).toBe(true);
    expect(stop1.finalState).toBe("inactive");

    const stop2 = await host.stop(handle);
    expect(stop2.ok).toBe(true);
    expect(stop2.finalState).toBe("inactive");
  });

  test("spawn failure handling", async () => {
    const name = "spawn-fail-test";
    await expect(
      host.start({
        name,
        argv: ["/usr/bin/non-existent-binary-xyz-123"]
      })
    ).rejects.toThrow();

    const pidfile = path.join(testRunDir, "pids", `${name}.pid`);
    expect(fsSync.existsSync(pidfile)).toBe(false);
  });

  test("concurrent unique runs", async () => {
    const p1 = host.start({ name: "con1", argv: [process.execPath, "-e", "setTimeout(() => {}, 2000)"] });
    const p2 = host.start({ name: "con2", argv: [process.execPath, "-e", "setTimeout(() => {}, 2000)"] });

    const [h1, h2] = await Promise.all([p1, p2]);
    expect(h1.pid).not.toBe(h2.pid);

    await Promise.all([host.stop(h1), host.stop(h2)]);
  });

  test("survivor detection and no foreign-process kill", async () => {
    const name = "foreign-proc-test";
    // Spawn a real detached child process
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 10000)"], {
      detached: true,
      stdio: "ignore"
    });
    // Wait for it to boot
    await new Promise((r) => setTimeout(r, 200));

    const fakeHandle = {
      name,
      pid: child.pid,
      logPath: path.join(testRunDir, "logs", `${name}.log`)
    };

    // Attempting to stop without a pidfile should detect missing ownership and refuse to kill
    const stopResult = await host.stop(fakeHandle);
    expect(stopResult.ok).toBe(false);
    expect(stopResult.finalState).toBe("ownership-unknown");
    expect(stopResult.failures[0]).toContain("owned pidfile missing");

    // The foreign process must still be alive!
    expect(isPidAlive(child.pid)).toBe(true);

    // Clean it up manually
    try { process.kill(-child.pid, "SIGKILL"); } catch {}
  });

  test("scoped sweep", async () => {
    const h1 = await host.start({ name: "sweep-target-1", argv: [process.execPath, "-e", "setTimeout(() => {}, 5000)"] });
    const h2 = await host.start({ name: "sweep-target-2", argv: [process.execPath, "-e", "setTimeout(() => {}, 5000)"] });
    const h3 = await host.start({ name: "sweep-ignore-3", argv: [process.execPath, "-e", "setTimeout(() => {}, 5000)"] });

    const sweepResult = await host.sweep("sweep-target");
    expect(sweepResult.ok).toBe(true);
    expect(sweepResult.swept).toContain("sweep-target-1");
    expect(sweepResult.swept).toContain("sweep-target-2");
    expect(sweepResult.swept).not.toContain("sweep-ignore-3");

    expect(isPidAlive(h1.pid)).toBe(false);
    expect(isPidAlive(h2.pid)).toBe(false);
    expect(isPidAlive(h3.pid)).toBe(true);

    await host.stop(h3);
  });

  test("birth token mismatch - stop negative proof", async () => {
    const name = "token-mismatch-stop";
    const handle = await host.start({
      name,
      argv: [process.execPath, "-e", "setTimeout(() => {}, 10000)"]
    });

    await new Promise((r) => setTimeout(r, 200));

    const pidfile = path.join(testRunDir, "pids", `${name}.pid`);
    const content = await fs.readFile(pidfile, "utf8");
    const parsed = JSON.parse(content);
    parsed.birthToken = "ps:99999 99999 Thu Jul 9 00:00:00 2026|proc:999999";
    await fs.writeFile(pidfile, JSON.stringify(parsed));

    const originalKill = process.kill;
    let signalSent = false;
    process.kill = (pid, signal) => {
      if (signal !== 0) signalSent = true;
      return originalKill(pid, signal);
    };

    try {
      const stopResult = await host.stop(handle);
      expect(stopResult.ok).toBe(true);
      expect(stopResult.finalState).toBe("stale-pidfile");
      expect(stopResult.stalePidfile).toBe(true);
      expect(stopResult.staleReason).toContain("birth token mismatch");

      expect(signalSent).toBe(false);
      expect(fsSync.existsSync(pidfile)).toBe(false);
      expect(isPidAlive(handle.pid)).toBe(true);
    } finally {
      process.kill = originalKill;
      try { process.kill(-handle.pid, "SIGKILL"); } catch {}
    }
  });

  test("old pidfile format missing birth token", async () => {
    const name = "old-pidfile-stop";
    const handle = await host.start({
      name,
      argv: [process.execPath, "-e", "setTimeout(() => {}, 10000)"]
    });

    await new Promise((r) => setTimeout(r, 200));

    const pidfile = path.join(testRunDir, "pids", `${name}.pid`);
    const content = await fs.readFile(pidfile, "utf8");
    const parsed = JSON.parse(content);
    delete parsed.birthToken;
    await fs.writeFile(pidfile, JSON.stringify(parsed));

    const originalKill = process.kill;
    let signalSent = false;
    process.kill = (pid, signal) => {
      if (signal !== 0) signalSent = true;
      return originalKill(pid, signal);
    };

    try {
      const stopResult = await host.stop(handle);
      expect(stopResult.ok).toBe(true);
      expect(stopResult.finalState).toBe("stale-pidfile");
      expect(stopResult.stalePidfile).toBe(true);
      expect(stopResult.staleReason).toContain("birth token missing");

      expect(signalSent).toBe(false);
      expect(fsSync.existsSync(pidfile)).toBe(false);
      expect(isPidAlive(handle.pid)).toBe(true);
    } finally {
      process.kill = originalKill;
      try { process.kill(-handle.pid, "SIGKILL"); } catch {}
    }
  });

  test("birth token mismatch - sweep negative proof", async () => {
    const name = "token-mismatch-sweep";
    const handle = await host.start({
      name,
      argv: [process.execPath, "-e", "setTimeout(() => {}, 10000)"]
    });

    await new Promise((r) => setTimeout(r, 200));

    const pidfile = path.join(testRunDir, "pids", `${name}.pid`);
    const content = await fs.readFile(pidfile, "utf8");
    const parsed = JSON.parse(content);
    parsed.birthToken = "ps:99999 99999 Thu Jul 9 00:00:00 2026|proc:999999";
    await fs.writeFile(pidfile, JSON.stringify(parsed));

    const originalKill = process.kill;
    let signalSent = false;
    process.kill = (pid, signal) => {
      if (signal !== 0) signalSent = true;
      return originalKill(pid, signal);
    };

    try {
      const sweepResult = await host.sweep("token-mismatch-sweep");
      expect(sweepResult.ok).toBe(true);
      expect(sweepResult.swept).toContain(name);

      expect(signalSent).toBe(false);
      expect(fsSync.existsSync(pidfile)).toBe(false);
      expect(isPidAlive(handle.pid)).toBe(true);
    } finally {
      process.kill = originalKill;
      try { process.kill(-handle.pid, "SIGKILL"); } catch {}
    }
  });

  test("birth token mismatch - exit cleanup negative proof", async () => {
    const name = "token-mismatch-exit";
    const handle = await host.start({
      name,
      argv: [process.execPath, "-e", "setTimeout(() => {}, 10000)"]
    });

    await new Promise((r) => setTimeout(r, 200));

    const pidfile = path.join(testRunDir, "pids", `${name}.pid`);
    const content = await fs.readFile(pidfile, "utf8");
    const parsed = JSON.parse(content);
    parsed.birthToken = "ps:99999 99999 Thu Jul 9 00:00:00 2026|proc:999999";
    await fs.writeFile(pidfile, JSON.stringify(parsed));

    const originalKill = process.kill;
    let signalSent = false;
    process.kill = (pid, signal) => {
      if (signal !== 0) signalSent = true;
      return originalKill(pid, signal);
    };

    try {
      process.emit("exit");

      expect(signalSent).toBe(false);
      expect(fsSync.existsSync(pidfile)).toBe(false);
      expect(isPidAlive(handle.pid)).toBe(true);
    } finally {
      process.kill = originalKill;
      try { process.kill(-handle.pid, "SIGKILL"); } catch {}
    }
  });

  test("SIGINT child-mode run cleanup proof", async () => {
    const name = "sigint-cleanup-test";
    const handle = await host.start({
      name,
      argv: [process.execPath, "-e", "setTimeout(() => {}, 10000)"]
    });

    await new Promise((r) => setTimeout(r, 200));

    expect(isPidAlive(handle.pid)).toBe(true);
    const pidfile = path.join(testRunDir, "pids", `${name}.pid`);
    expect(fsSync.existsSync(pidfile)).toBe(true);

    const dummyListener = () => {};
    process.on("SIGINT", dummyListener);

    try {
      process.emit("SIGINT");

      // Wait for process to exit and pidfile to be unlinked
      await new Promise((r) => setTimeout(r, 200));

      // The child process should have been killed, and the pidfile removed
      expect(isPidAlive(handle.pid)).toBe(false);
      expect(fsSync.existsSync(pidfile)).toBe(false);
    } finally {
      process.off("SIGINT", dummyListener);
      try { process.kill(-handle.pid, "SIGKILL"); } catch {}
    }
  });

  test("stubborn grandchild SIGKILL cleanup tooth test", async () => {
    const name = "stubborn-grandchild-test";
    const script = `
      const { spawn } = require('child_process');
      const grandchildScript = 'process.on("SIGTERM", () => console.log("GRANDCHILD_IGNORED_SIGTERM")); setTimeout(() => {}, 20000);';
      const grandchild = spawn('${process.execPath}', ['-e', grandchildScript], {
        detached: false,
        stdio: ['ignore', 'inherit', 'inherit']
      });
      console.log('GRANDCHILD_PID:' + grandchild.pid);
      setTimeout(() => {}, 20000);
    `;

    const handle = await host.start({
      name,
      argv: [process.execPath, "-e", script]
    });

    let grandchildPid = null;
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const logs = await host.logs(handle);
      const match = /GRANDCHILD_PID:(\d+)/.exec(logs);
      if (match) {
        grandchildPid = Number(match[1]);
        break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }

    expect(grandchildPid).toBeGreaterThan(0);
    expect(isPidAlive(handle.pid)).toBe(true);
    expect(isPidAlive(grandchildPid)).toBe(true);

    const stopResult = await host.stop(handle, { graceMs: 500 });
    console.log("GRANDCHILD STOP RESULT:", stopResult);
    expect(stopResult.ok).toBe(true);

    expect(isPidAlive(handle.pid)).toBe(false);
    expect(isPidAlive(grandchildPid)).toBe(false);
  });
});

test("systemd launch keeps explicit environment values out of argv", async () => {
  const fakeBin = await fs.mkdtemp(path.join(testRunDir, "fake-systemd-"));
  const captureArgs = path.join(fakeBin, "args.txt");
  const captureEnv = path.join(fakeBin, "environment.txt");
  const originalPath = process.env.PATH;
  const originalArgs = process.env.PROCESS_HOST_CAPTURE_ARGS;
  const originalEnv = process.env.PROCESS_HOST_CAPTURE_ENV;
  const systemdRun = `#!/bin/sh
printf '%s\n' "$@" > "$PROCESS_HOST_CAPTURE_ARGS"
for arg in "$@"; do
  case "$arg" in
    --property=EnvironmentFile=*) cp "\${arg#--property=EnvironmentFile=}" "$PROCESS_HOST_CAPTURE_ENV" ;;
  esac
done
`;
  const success = "#!/bin/sh\nexit 0\n";
  try {
    for (const [name, source] of [["systemd-run", systemdRun], ["systemctl", success], ["journalctl", success]]) {
      const executable = path.join(fakeBin, name);
      await fs.writeFile(executable, source, { encoding: "utf8", mode: 0o700 });
    }
    process.env.PATH = `${fakeBin}:${originalPath}`;
    process.env.PROCESS_HOST_CAPTURE_ARGS = captureArgs;
    process.env.PROCESS_HOST_CAPTURE_ENV = captureEnv;
    const secret = "capability-must-not-enter-argv";
    const host = createProcessHost({ runId: "test-systemd-env", runDir: testRunDir, kind: "systemd" });
    await host.start({ name: "test-systemd-env", argv: [process.execPath, "-e", "process.exit(0)"], env: { PROOF_SECRET: secret }, cwd: testRunDir });
    const args = await fs.readFile(captureArgs, "utf8");
    expect(args).not.toContain(secret);
    expect(args).not.toContain("--setenv=");
    const property = args.split(/\r?\n/u).find((value) => value.startsWith("--property=EnvironmentFile="));
    expect(property).toBeTruthy();
    expect(await fs.readFile(captureEnv, "utf8")).toContain(`PROOF_SECRET="${secret}"`);
    await expect(fs.access(property.slice("--property=EnvironmentFile=".length))).rejects.toThrow();
  } finally {
    if (originalPath === undefined) delete process.env.PATH; else process.env.PATH = originalPath;
    if (originalArgs === undefined) delete process.env.PROCESS_HOST_CAPTURE_ARGS; else process.env.PROCESS_HOST_CAPTURE_ARGS = originalArgs;
    if (originalEnv === undefined) delete process.env.PROCESS_HOST_CAPTURE_ENV; else process.env.PROCESS_HOST_CAPTURE_ENV = originalEnv;
    await fs.rm(fakeBin, { recursive: true, force: true });
  }
});

describe("ProcessHost Systemd Mode Behavior", () => {
  let host;

  beforeAll(() => {
    if (!hasSystemd()) return;
    host = createProcessHost({ runId: "testphsysd", runDir: testRunDir, kind: "systemd" });
  });

  test("transient unit startup, inspect, logs, stop, sweep", async () => {
    if (!hasSystemd()) {
      console.log("Skipping systemd tests (systemd not available)");
      return;
    }

    const name = "testphsysd-proc1";
    const handle = await host.start({
      name,
      argv: [process.execPath, "-e", "console.log('SYSTEMD_OK'); setTimeout(() => {}, 2000);"],
      cwd: testRunDir
    });

    expect(handle.name).toBe(name);
    expect(handle.unit).toBe(`${name}.service`);
    expect(handle.logPath).toBe(path.join(testRunDir, "logs", `${name}.log`));

    // Inspect transient unit
    const inspect = await host.inspect(handle);
    expect(inspect.error).toBeNull();
    expect(inspect.activeState).toBe("active");
    expect(inspect.mainPid).toBeGreaterThan(0);

    // Wait a bit for it to print log
    await new Promise((r) => setTimeout(r, 500));

    // Retrieve logs
    const logs = await host.logs(handle);
    expect(logs).toContain("SYSTEMD_OK");

    // Stop unit
    const stopResult = await host.stop(handle);
    expect(stopResult.ok).toBe(true);

    const inspectPost = await host.inspect(handle);
    expect(inspectPost.activeState).not.toBe("active");

    // Test sweep
    const h2 = await host.start({
      name: "testphsysd-proc2",
      argv: [process.execPath, "-e", "setTimeout(() => {}, 5000);"]
    });

    const sweepResult = await host.sweep("testphsysd-");
    expect(sweepResult.ok).toBe(true);
    expect(sweepResult.swept).toContain("testphsysd-proc2");

    const inspectPostSweep = await host.inspect(h2);
    expect(inspectPostSweep.activeState).not.toBe("active");
  });
});
