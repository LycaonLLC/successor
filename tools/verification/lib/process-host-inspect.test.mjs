import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { after, before, test } from "node:test";

import { createProcessHost } from "./process-host.mjs";

const testRunDir = path.resolve(
  import.meta.dirname,
  "../../../verification/.runs/test-process-host-inspect-" + Math.random().toString(36).slice(2, 10),
);
const host = createProcessHost({ runId: "inspectidentity", runDir: testRunDir, kind: "child" });

before(async () => {
  await fs.mkdir(testRunDir, { recursive: true });
});

after(async () => {
  await fs.rm(testRunDir, { recursive: true, force: true });
});

function pidfile(name) {
  return path.join(testRunDir, "pids", `${name}.pid`);
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function groupAlive(pgid) {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

async function waitFor(predicate, label, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`timed out waiting for ${label}`);
}

async function forceStopGroup(pgid) {
  try {
    process.kill(-pgid, "SIGKILL");
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
  await waitFor(() => !groupAlive(pgid), `process group ${pgid} to exit`);
}

async function inspectWithoutSignals(handle, processHost = host) {
  const originalKill = process.kill;
  const sent = [];
  process.kill = (pid, signal) => {
    if (signal !== undefined && signal !== 0) sent.push({ pid, signal });
    return originalKill(pid, signal);
  };
  try {
    return await processHost.inspect(handle);
  } finally {
    process.kill = originalKill;
    assert.deepEqual(sent, [], "inspection must never signal a process group");
  }
}

function assertFailClosed(inspection, errorPattern, subState) {
  assert.equal(inspection.activeState, "unknown", "untrusted ownership must not be reported active");
  assert.equal(inspection.subState, subState);
  assert.equal(typeof inspection.error, "string", "inspection must report a fail-closed error");
  assert.match(inspection.error, errorPattern);
  assert.equal(inspection.memoryCurrentBytes, null, "untrusted groups must not contribute aggregate memory");
  assert.equal(inspection.cpuUsageNSec, null, "untrusted groups must not contribute aggregate CPU");
  assert.equal(inspection.proc, null, "untrusted leaders must not contribute RSS evidence");
}

async function startSleeper(name) {
  return host.start({
    name,
    argv: [process.execPath, "-e", "setTimeout(() => {}, 30000)"],
  });
}

test("child inspection returns live, birth-bound process-group evidence", async () => {
  const handle = await startSleeper("inspect-positive");
  try {
    const inspection = await host.inspect(handle);
    assert.equal(inspection.error, null);
    assert.equal(inspection.activeState, "active");
    assert.equal(inspection.mainPid, handle.pid);
    assert.ok(Number.isFinite(inspection.memoryCurrentBytes));
    assert.ok(Number.isFinite(inspection.cpuUsageNSec));
    assert.ok(Number.isFinite(inspection.proc?.rssBytes));
  } finally {
    await host.stop(handle);
  }
});

test("child inspection rejects a pidfile replacement that occurs after its complete group snapshot", async () => {
  let snapshotSeamCalls = 0;
  const raceHost = createProcessHost({
    runId: "inspectidentity",
    runDir: testRunDir,
    kind: "child",
    inspectChildHooks: {
      async afterGroupSnapshot({ handle, pidfile: file }) {
        snapshotSeamCalls += 1;
        const record = JSON.parse(await fs.readFile(file, "utf8"));
        assert.equal(record.pid, handle.pid, "the initial pidfile binding reached the post-snapshot seam");
        record.birthToken = "ps:99999 99999 Thu Jul 9 00:00:00 2026|proc:999999";
        await fs.writeFile(file, JSON.stringify(record));
      },
    },
  });
  const handle = await raceHost.start({
    name: "inspect-post-snapshot-race",
    argv: [process.execPath, "-e", "setTimeout(() => {}, 30000)"],
  });
  try {
    const inspection = await inspectWithoutSignals(handle, raceHost);
    assert.equal(snapshotSeamCalls, 1, "the replacement must occur only after a complete snapshot");
    assertFailClosed(inspection, /birth token mismatch/i, "stale-pidfile");
    assert.equal(groupAlive(handle.pid), true, "post-snapshot replacement must not signal the live group");
  } finally {
    await forceStopGroup(handle.pid);
  }
});

test("child inspection rejects an identity switch whose replacement also passes post-snapshot birth verification", async () => {
  let currentBirthToken = null;
  let birthTokenReads = 0;
  let snapshotSeamCalls = 0;
  const raceHost = createProcessHost({
    runId: "inspectidentity",
    runDir: testRunDir,
    kind: "child",
    inspectChildHooks: {
      processBirthToken(pid) {
        assert.ok(Number.isInteger(pid) && pid > 0);
        birthTokenReads += 1;
        return currentBirthToken;
      },
      async afterGroupSnapshot({ handle, pidfile: file }) {
        snapshotSeamCalls += 1;
        const replacement = JSON.parse(await fs.readFile(file, "utf8"));
        assert.equal(replacement.pid, handle.pid);
        assert.equal(replacement.birthToken, currentBirthToken, "snapshot must follow a successful identity-A verification");
        currentBirthToken = "ps:77777 77777 Thu Jul 10 00:00:00 2026|proc:777777";
        replacement.birthToken = currentBirthToken;
        await fs.writeFile(file, JSON.stringify(replacement));
      },
    },
  });
  const handle = await raceHost.start({
    name: "inspect-identity-switch-race",
    argv: [process.execPath, "-e", "setTimeout(() => {}, 30000)"],
  });
  try {
    const initial = JSON.parse(await fs.readFile(pidfile(handle.name), "utf8"));
    currentBirthToken = initial.birthToken;
    const inspection = await inspectWithoutSignals(handle, raceHost);
    assert.equal(snapshotSeamCalls, 1, "the replacement must follow the complete snapshot");
    assert.equal(birthTokenReads, 2, "both the original A and replacement B records must pass their own birth checks");
    assertFailClosed(inspection, /pidfile binding changed during process-group inspection/i, "stale-pidfile");
    assert.equal(groupAlive(handle.pid), true, "identity-switch inspection must not signal the live group");
  } finally {
    await forceStopGroup(handle.pid);
  }
});

test("child inspection refuses a tampered birth token while the original group remains live", async () => {
  const handle = await startSleeper("inspect-tampered-birth");
  const file = pidfile(handle.name);
  try {
    const record = JSON.parse(await fs.readFile(file, "utf8"));
    record.birthToken = "ps:99999 99999 Thu Jul 9 00:00:00 2026|proc:999999";
    await fs.writeFile(file, JSON.stringify(record));

    const inspection = await inspectWithoutSignals(handle);
    assertFailClosed(inspection, /birth token mismatch/i, "stale-pidfile");
    assert.equal(groupAlive(handle.pid), true, "inspection must leave the original live group untouched");
  } finally {
    await forceStopGroup(handle.pid);
  }
});

test("child inspection rejects wrong handle PID and name without touching the unrelated controlled group", async () => {
  const handle = await startSleeper("inspect-wrong-handle");
  const foreign = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { detached: true, stdio: "ignore" });
  assert.ok(Number.isInteger(foreign.pid) && foreign.pid > 0);
  foreign.unref();
  try {
    await waitFor(() => groupAlive(foreign.pid), "foreign controlled group");
    const wrongPid = await inspectWithoutSignals({ ...handle, pid: foreign.pid });
    assertFailClosed(wrongPid, /pid mismatch/i, "stale-pidfile");
    assert.equal(groupAlive(foreign.pid), true, "a mismatched handle must not signal the foreign group");

    const wrongName = await inspectWithoutSignals({ ...handle, name: "inspect-wrong-name" });
    assertFailClosed(wrongName, /pidfile.*missing|ownership/i, "ownership-unknown");
    assert.equal(groupAlive(handle.pid), true, "a mismatched name must not signal the owned group");
  } finally {
    await forceStopGroup(foreign.pid);
    await host.stop(handle);
  }
});

test("child inspection fails closed when its pidfile is missing while the group remains live", async () => {
  const handle = await startSleeper("inspect-missing-pidfile");
  try {
    await fs.rm(pidfile(handle.name));
    const inspection = await inspectWithoutSignals(handle);
    assertFailClosed(inspection, /pidfile.*missing|ownership/i, "ownership-unknown");
    assert.equal(groupAlive(handle.pid), true, "missing ownership evidence must not terminate a live group");
  } finally {
    await forceStopGroup(handle.pid);
  }
});

test("child inspection fails closed when live PID birth identity is unavailable", async () => {
  const handle = await startSleeper("inspect-identity-unavailable");
  const originalPath = process.env.PATH;
  try {
    process.env.PATH = "";
    const inspection = await inspectWithoutSignals(handle);
    assertFailClosed(inspection, /identity.*unavailable|could not verify.*identity/i, "identity-unavailable");
    assert.equal(groupAlive(handle.pid), true, "identity uncertainty must not terminate a live group");
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    await host.stop(handle);
  }
});

test("child inspection fails closed when the leader exits but its process group remains live", async () => {
  const handle = await host.start({
    name: "inspect-leader-gone",
    argv: [
      process.execPath,
      "-e",
      "const { spawn } = require('node:child_process'); const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' }); child.unref(); setTimeout(() => process.exit(0), 100);",
    ],
  });
  try {
    await waitFor(() => groupAlive(handle.pid) && !pidAlive(handle.pid), "dead leader with live process group");
    const inspection = await inspectWithoutSignals(handle);
    assertFailClosed(inspection, /leader.*gone|leader.*died/i, "leader-gone-group-live");
    assert.equal(groupAlive(handle.pid), true, "leader-gone inspection must not signal the remaining group");
  } finally {
    await forceStopGroup(handle.pid);
  }
});
