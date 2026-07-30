import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { startSuccessorDriverBot } from "./successor-driver-bot.mjs";
import { createProcessHost } from "../verification/lib/process-host.mjs";

const fixtureSource = String.raw`
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";

const mode = process.env.SUCCESSOR_DRIVER_FIXTURE_MODE;
const processGroupId = (pid = process.pid) => {
  const stat = readFileSync("/proc/" + pid + "/stat", "utf8");
  return Number(stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/u)[2]);
};
const markTerm = (role) => {
  if (process.env.SUCCESSOR_DRIVER_FIXTURE_TERM_PATH) appendFileSync(process.env.SUCCESSOR_DRIVER_FIXTURE_TERM_PATH, role + "\n");
};
const emit = (value) => process.stdout.write(JSON.stringify(value) + "\n");
const keepAlive = setInterval(() => {}, 1_000);
let descendant;

if (mode === "stubborn-descendant" || mode === "leader-exits-with-descendant") {
  descendant = spawn(process.execPath, ["-e", "const fs = require('node:fs'); const mark = () => { if (process.env.SUCCESSOR_DRIVER_FIXTURE_TERM_PATH) fs.appendFileSync(process.env.SUCCESSOR_DRIVER_FIXTURE_TERM_PATH, 'descendant\\n'); }; process.on('SIGTERM', mark); process.on('SIGINT', () => {}); setInterval(() => {}, 1000);"], { stdio: "ignore" });
  emit({ type: "fixture", descendantPid: descendant.pid, descendantPgid: processGroupId(descendant.pid) });
  if (process.env.SUCCESSOR_DRIVER_FIXTURE_PIDFILE) writeFileSync(process.env.SUCCESSOR_DRIVER_FIXTURE_PIDFILE, String(descendant.pid));
}
process.on("SIGTERM", () => {
  markTerm("driver");
  if (mode === "stubborn-descendant") return;
  process.exit(0);
});
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  for (const line of chunk.split("\n")) {
    if (!line) continue;
    const frame = JSON.parse(line);
    if (frame.op !== "quit") continue;
    if (mode === "stubborn-descendant") continue;
    emit({ type: "status", status: "closed" });
    if (mode === "delayed") setTimeout(() => process.exit(0), 120);
    else if (mode === "leader-exits-with-descendant") process.exit(0);
    else process.exit(0);
  }
});
emit({ type: "status", status: "ready" });
`;

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

function isGroupAlive(pgid) {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

async function eventually(predicate, label, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`${label} remained alive after ${timeoutMs}ms`);
}

async function waitForFile(target, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      return await readFile(target, "utf8");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${target}`);
}

async function forceStop(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
  await eventually(() => !isAlive(pid) && !isGroupAlive(pid), `fixture process group ${pid}`);
}

async function startFixture(t, mode, timeouts = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "successor-driver-lifecycle-"));
  const cliPath = path.join(directory, "fixture.mjs");
  const descendantPidPath = path.join(directory, "descendant.pid");
  await writeFile(cliPath, fixtureSource, "utf8");
  const bot = startSuccessorDriverBot({
    cliPath,
    env: {
      SUCCESSOR_DRIVER_FIXTURE_MODE: mode,
      SUCCESSOR_DRIVER_FIXTURE_PIDFILE: descendantPidPath,
    },
    closeGraceMs: timeouts.closeGraceMs ?? 50,
    closeTermMs: timeouts.closeTermMs ?? 50,
    closeKillMs: timeouts.closeKillMs ?? 1_000,
  });
  t.after(async () => {
    await forceStop(bot.child.pid).catch(() => {});
    const descendantPid = Number(await readFile(descendantPidPath, "utf8").catch(() => ""));
    if (Number.isInteger(descendantPid) && descendantPid > 0) await forceStop(descendantPid).catch(() => {});
    await rm(directory, { recursive: true, force: true });
  });
  await bot.waitFor((envelope) => envelope.type === "status" && envelope.status === "ready", "fixture ready", 1_000);
  return bot;
}

async function assertDead(bot, descendantPid) {
  await eventually(() => !isAlive(bot.child.pid), `driver pid ${bot.child.pid}`);
  await eventually(() => !isGroupAlive(bot.child.pid), `driver process group ${bot.child.pid}`);
  if (descendantPid) await eventually(() => !isAlive(descendantPid), `descendant pid ${descendantPid}`);
}

async function readProcessGroupId(pid) {
  const stat = await readFile(`/proc/${pid}/stat`, "utf8");
  return Number(stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/u)[2]);
}

async function withOuterChildPhase(t, run) {
  const root = await mkdtemp(path.join(os.tmpdir(), "successor-driver-phase-"));
  const host = createProcessHost({
    runId: `driver-phase-${Date.now().toString(36)}`,
    runDir: root,
    kind: "child",
  });
  let handle;
  let cleaned = false;
  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    if (handle) await host.stop(handle, { graceMs: 100 }).catch(() => {});
    await rm(root, { recursive: true, force: true });
  };
  t.after(cleanup);
  try {
    return await run({
      root,
      start: async (wrapperPath) => {
        handle = await host.start({
          name: "outer-phase",
          argv: [process.execPath, wrapperPath],
          cwd: root,
          env: { SUCCESSOR_PROCESS_HOST: "child" },
        });
        return handle;
      },
      stop: async () => host.stop(handle, { graceMs: 100 }),
    });
  } finally {
    await cleanup();
  }
}

describe("successor driver bot lifecycle", () => {
  it("waits for a graceful child exit rather than treating the closed envelope as proof", async (t) => {
    const bot = await startFixture(t, "graceful");

    await bot.close();

    await assertDead(bot);
  });

  it("waits for a delayed graceful exit after quit", async (t) => {
    const bot = await startFixture(t, "delayed", { closeGraceMs: 250 });
    const startedAt = Date.now();

    await bot.close();

    assert.ok(Date.now() - startedAt >= 90, "close returned before the delayed child exit");
    await assertDead(bot);
  });

  it("escalates an unresponsive child through TERM and owned-group KILL", async (t) => {
    const bot = await startFixture(t, "stubborn-descendant");
    const fixture = await bot.waitFor((envelope) => envelope.type === "fixture", "fixture descendant", 1_000);
    const descendantPid = fixture.descendantPid;
    assert.ok(Number.isInteger(descendantPid) && descendantPid > 0);
    const startedAt = Date.now();
    if (process.platform !== "win32") assert.equal(await readProcessGroupId(bot.child.pid), bot.child.pid, "standalone driver must lead its detached process group");

    await bot.close();

    assert.ok(Date.now() - startedAt >= 90, "close skipped graceful and TERM windows");
    await assertDead(bot, descendantPid);
  });

  it("does not accept leader exit as lifecycle proof while an owned descendant survives", async (t) => {
    const bot = await startFixture(t, "leader-exits-with-descendant");
    const fixture = await bot.waitFor((envelope) => envelope.type === "fixture", "fixture descendant", 1_000);
    const descendantPid = fixture.descendantPid;
    assert.ok(Number.isInteger(descendantPid) && descendantPid > 0);

    await bot.close();

    await assertDead(bot, descendantPid);
  });

  it("rejects when a real child exit cannot be observed and therefore cannot prove termination", async (t) => {
    const bot = await startFixture(t, "graceful", { closeGraceMs: 30, closeTermMs: 30, closeKillMs: 30 });
    const emit = bot.child.emit;
    bot.child.emit = function suppressExitObservation(event, ...args) {
      if (event === "exit") return false;
      return emit.call(this, event, ...args);
    };
    try {
      await assert.rejects(bot.close(), /could not verify successor-play process termination/u);
    } finally {
      bot.child.emit = emit;
    }

    await assertDead(bot);
  });

  it("memoizes repeated close calls and leaves no process group behind", async (t) => {
    const bot = await startFixture(t, "delayed");

    const results = await Promise.all([bot.close(), bot.close(), bot.close(), bot.close()]);
    assert.deepEqual(results, [undefined, undefined, undefined, undefined]);
    await bot.close();

    await assertDead(bot);
  });
});

describe("inherited ProcessHost driver topology", () => {
  it("keeps the outer ProcessHost phase alive when an inherited driver child closes normally", async (t) => {
    if (process.platform === "win32") return;
    await withOuterChildPhase(t, async ({ root, start }) => {
      const cliPath = path.join(root, "fixture.mjs");
      const wrapperPath = path.join(root, "normal-wrapper.mjs");
      const topologyPath = path.join(root, "topology.json");
      const resultPath = path.join(root, "result.json");
      await writeFile(cliPath, fixtureSource, "utf8");
      await writeFile(wrapperPath, [
        "import { readFileSync, writeFileSync } from 'node:fs';",
        `import { startSuccessorDriverBot } from ${JSON.stringify(new URL("./successor-driver-bot.mjs", import.meta.url).href)};`,
        "const pgid = (pid) => { const stat = readFileSync(`/proc/${pid}/stat`, 'utf8'); return Number(stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\\s+/)[2]); };",
        `const bot = startSuccessorDriverBot({ cliPath: ${JSON.stringify(cliPath)}, env: { SUCCESSOR_DRIVER_FIXTURE_MODE: 'graceful' }, closeGraceMs: 100, closeTermMs: 100, closeKillMs: 500 });`,
        "await bot.waitFor((envelope) => envelope.type === 'status' && envelope.status === 'ready', 'fixture ready', 1_000);",
        `writeFileSync(${JSON.stringify(topologyPath)}, JSON.stringify({ wrapper: process.pid, driver: bot.child.pid, driverPgid: pgid(bot.child.pid) }));`,
        "await bot.close();",
        `writeFileSync(${JSON.stringify(resultPath)}, JSON.stringify({ closed: true }));`,
        "setInterval(() => {}, 1_000);",
      ].join("\n"), "utf8");

      const handle = await start(wrapperPath);
      const topology = JSON.parse(await waitForFile(topologyPath));
      await waitForFile(resultPath);
      assert.equal(await readProcessGroupId(topology.wrapper), handle.pid, "outer wrapper must lead the inherited phase group");
      assert.equal(topology.driverPgid, handle.pid, "driver child must inherit the outer phase group");
      assert.equal(isAlive(topology.wrapper), true, "normal driver close must not kill the outer wrapper");
      await eventually(() => !isAlive(topology.driver), `normally closed inherited driver pid ${topology.driver}`);
      t.diagnostic(`inherited driver normal-close evidence: outer pid/pgid=${topology.wrapper}/${handle.pid}, driver pid/pgid=${topology.driver}/${topology.driverPgid}`);
    });
  });

  it("ProcessHost TERM-to-KILL removes the entire inherited driver subtree", async (t) => {
    if (process.platform === "win32") return;
    await withOuterChildPhase(t, async ({ root, start, stop }) => {
      const cliPath = path.join(root, "fixture.mjs");
      const wrapperPath = path.join(root, "stubborn-wrapper.mjs");
      const topologyPath = path.join(root, "topology.json");
      const termPath = path.join(root, "term.log");
      await writeFile(cliPath, fixtureSource, "utf8");
      await writeFile(wrapperPath, [
        "import { readFileSync, writeFileSync } from 'node:fs';",
        `import { startSuccessorDriverBot } from ${JSON.stringify(new URL("./successor-driver-bot.mjs", import.meta.url).href)};`,
        "const pgid = (pid) => { const stat = readFileSync(`/proc/${pid}/stat`, 'utf8'); return Number(stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\\s+/)[2]); };",
        `const bot = startSuccessorDriverBot({ cliPath: ${JSON.stringify(cliPath)}, env: { SUCCESSOR_DRIVER_FIXTURE_MODE: 'stubborn-descendant', SUCCESSOR_DRIVER_FIXTURE_TERM_PATH: ${JSON.stringify(termPath)} }, closeGraceMs: 100, closeTermMs: 100, closeKillMs: 500 });`,
        "const fixture = await bot.waitFor((envelope) => envelope.type === 'fixture', 'fixture descendant', 1_000);",
        `writeFileSync(${JSON.stringify(topologyPath)}, JSON.stringify({ wrapper: process.pid, driver: bot.child.pid, driverPgid: pgid(bot.child.pid), descendant: fixture.descendantPid, descendantPgid: fixture.descendantPgid }));`,
        "setInterval(() => {}, 1_000);",
      ].join("\n"), "utf8");

      const handle = await start(wrapperPath);
      const topology = JSON.parse(await waitForFile(topologyPath));
      assert.equal(await readProcessGroupId(topology.wrapper), handle.pid);
      assert.equal(topology.driverPgid, handle.pid, "driver must not create a nested detached group");
      assert.equal(topology.descendantPgid, handle.pid, "TERM-ignoring driver descendant must remain in the outer group");

      const stopped = await stop();
      assert.equal(stopped.ok, true);
      const terms = await readFile(termPath, "utf8");
      assert.match(terms, /driver/u, "outer ProcessHost must send TERM before KILL");
      assert.match(terms, /descendant/u, "TERM must reach the inherited driver descendant before KILL");
      await eventually(() => !isAlive(topology.wrapper), `outer driver wrapper ${topology.wrapper}`);
      await eventually(() => !isAlive(topology.driver), `inherited driver ${topology.driver}`);
      await eventually(() => !isAlive(topology.descendant), `TERM-ignoring driver descendant ${topology.descendant}`);
      assert.equal(isGroupAlive(handle.pid), false, "outer ProcessHost group must be absent after escalation");
      t.diagnostic(`inherited driver escalation evidence: outer pgid=${handle.pid}; dead wrapper/driver/descendant pids=${topology.wrapper}/${topology.driver}/${topology.descendant}`);
    });
  });
});
