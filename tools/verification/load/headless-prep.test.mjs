import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { defaultRunProcess, prepareHeadlessCli } from "./headless-prep.mjs";
import { createTreeSourceIdentity } from "../farm/source-hash.mjs";
import { createProcessHost } from "../lib/process-host.mjs";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForFile(target, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      return await fs.readFile(target, "utf8");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    await delay(20);
  }
  throw new Error(`timed out waiting for ${target}`);
}

function processGroupAlive(pid) {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

async function assertPidGone(pid, label) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline && pidAlive(pid)) await delay(20);
  assert.equal(pidAlive(pid), false, `${label} must be dead`);
}
async function readProcessGroupId(pid) {
  return Number(execFileSync("ps", ["-o", "pgid=", "-p", String(pid)], { encoding: "utf8" }).trim());
}

async function withOuterChildPhase(t, run) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "successor-headless-phase-"));
  const host = createProcessHost({ runId: `headless-phase-${Date.now().toString(36)}`, runDir: root, kind: "child" });
  let handle;
  let cleaned = false;
  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    if (handle) await host.stop(handle, { graceMs: 100 }).catch(() => {});
    await fs.rm(root, { recursive: true, force: true });
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

async function primeCachedCli(root, sourceHash) {
  return prepareHeadlessCli({
    root,
    sourceHash,
    sourcePaths: ["fixture.txt", "pnpm-lock.yaml"],
    runProcess: async (_command, argv) => {
      if (argv[2] === "install") {
        await fs.mkdir(path.join(root, "client", "node_modules", ".bin"), { recursive: true });
        await fs.writeFile(path.join(root, "client", "node_modules", ".bin", "vite"), "vite", "utf8");
      } else {
        await fs.mkdir(path.join(root, "client", "dist", "headless"), { recursive: true });
        await fs.writeFile(path.join(root, "client", "dist", "headless", "cli.js"), "known-good-cli", "utf8");
      }
      return { ok: true, exitCode: 0, signal: null, timedOut: false, error: null };
    },
  });
}

async function withFixture(run) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "successor-headless-prep-"));
  try {
    await fs.mkdir(path.join(root, "client"), { recursive: true });
    await fs.writeFile(path.join(root, "pnpm-lock.yaml"), "lock-v1", "utf8");
    await fs.writeFile(path.join(root, "fixture.txt"), "source", "utf8");
    const identity = await createTreeSourceIdentity({ root, expectedPaths: ["fixture.txt", "pnpm-lock.yaml"], includeManifest: false });
    return await run(root, identity.sourceHash);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

describe("remote headless preparation", () => {
  it("builds a missing CLI exactly once and proves the signed tree remains unchanged", async () => {
    await withFixture(async (root, sourceHash) => {
      const calls = [];
      const result = await prepareHeadlessCli({
        root,
        sourceHash,
        sourcePaths: ["fixture.txt", "pnpm-lock.yaml"],
        runProcess: async (command, argv, options) => {
          calls.push({ command, argv, options });
          if (argv[2] === "install") {
            await fs.mkdir(path.join(root, "client", "node_modules", ".bin"), { recursive: true });
            await fs.writeFile(path.join(root, "client", "node_modules", ".bin", "vite"), "vite", "utf8");
          } else {
            await fs.mkdir(path.join(root, "client", "dist", "headless"), { recursive: true });
            await fs.writeFile(path.join(root, "client", "dist", "headless", "cli.js"), "built", "utf8");
          }
          return { ok: true, exitCode: 0, signal: null, timedOut: false, error: null };
        },
      });
      assert.equal(result.status, "pass");
      assert.equal(result.built, true);
      assert.equal(result.source.beforeHash, sourceHash);
      assert.equal(result.source.afterHash, sourceHash);
      assert.deepEqual(calls.map((call) => call.argv), [["--dir", "client", "install", "--frozen-lockfile"], ["--dir", "client", "build:headless"]]);
    });
  });

  it("fails closed when the bounded dependency install fails", async () => {
    await withFixture(async (root, sourceHash) => {
      const result = await prepareHeadlessCli({
        root,
        sourceHash,
        sourcePaths: ["fixture.txt", "pnpm-lock.yaml"],
        runProcess: async () => ({ ok: false, exitCode: 1, signal: null, timedOut: false, error: null, stderr: "token=not-safe" }),
      });
      assert.deepEqual(result.error, { code: "DEPENDENCY_INSTALL_FAILED", reason: "exit-1", stderr: "token=[redacted]" });
      assert.equal(result.phase, "install");
    });
  });

  it("rehydrates dependencies when the lockfile marker is stale without rebuilding a verified CLI", async () => {
    await withFixture(async (root, sourceHash) => {
      await primeCachedCli(root, sourceHash);
      await fs.writeFile(path.join(root, "client", "node_modules", ".successor-lock-hash"), "stale\n", "utf8");
      const calls = [];
      const result = await prepareHeadlessCli({
        root,
        sourceHash,
        sourcePaths: ["fixture.txt", "pnpm-lock.yaml"],
        runProcess: async (command, argv) => {
          calls.push([command, argv]);
          return { ok: true, exitCode: 0, signal: null, timedOut: false, error: null };
        },
      });
      assert.equal(result.installed, true);
      assert.equal(result.built, false);
      assert.deepEqual(calls, [["pnpm", ["--dir", "client", "install", "--frozen-lockfile"]]]);
    });
  });

  it("rebuilds when a cached CLI is tampered despite a current source marker", async () => {
    await withFixture(async (root, sourceHash) => {
      await primeCachedCli(root, sourceHash);
      const cliPath = path.join(root, "client", "dist", "headless", "cli.js");
      await fs.writeFile(cliPath, "tampered-cli", "utf8");
      const calls = [];
      const result = await prepareHeadlessCli({
        root,
        sourceHash,
        sourcePaths: ["fixture.txt", "pnpm-lock.yaml"],
        runProcess: async (command, argv) => {
          calls.push([command, argv]);
          await fs.writeFile(cliPath, "rebuilt-cli", "utf8");
          return { ok: true, exitCode: 0, signal: null, timedOut: false, error: null };
        },
      });
      assert.equal(result.status, "pass");
      assert.equal(result.installed, false);
      assert.equal(result.built, true);
      assert.deepEqual(calls, [["pnpm", ["--dir", "client", "build:headless"]]]);
    });
  });

  it("rebuilds when the cached CLI marker names a stale toolchain", async () => {
    await withFixture(async (root, sourceHash) => {
      await primeCachedCli(root, sourceHash);
      const markerPath = path.join(root, "client", "dist", "headless", ".successor-source-hash");
      const marker = JSON.parse(await fs.readFile(markerPath, "utf8"));
      marker.toolchain.node = "v0.0.0-stale";
      await fs.writeFile(markerPath, `${JSON.stringify(marker)}\n`, "utf8");
      const calls = [];
      const result = await prepareHeadlessCli({
        root,
        sourceHash,
        sourcePaths: ["fixture.txt", "pnpm-lock.yaml"],
        runProcess: async (command, argv) => {
          calls.push([command, argv]);
          return { ok: true, exitCode: 0, signal: null, timedOut: false, error: null };
        },
      });
      assert.equal(result.status, "pass");
      assert.equal(result.installed, false);
      assert.equal(result.built, true);
      assert.deepEqual(calls, [["pnpm", ["--dir", "client", "build:headless"]]]);
    });
  });

  it("retains the bounded redacted stderr tail containing the terminal compiler cause", async () => {
    const result = await defaultRunProcess(process.execPath, ["-e", "process.stderr.write('x'.repeat(200000)); process.stderr.write(' token=do-not-print\\nfinal compiler cause: missing export'); process.exitCode = 1"], { timeoutMs: 10_000 });
    assert.equal(result.ok, false);
    assert.ok(result.stderr.length <= 8 * 1024);
    assert.match(result.stderr, /token=\[redacted\]/u);
    assert.doesNotMatch(result.stderr, /do-not-print/u);
    assert.match(result.stderr, /final compiler cause: missing export$/u);
  });

  it("kills an owned process group after TERM is ignored and proves its descendant is gone", async () => {
    await withFixture(async (root) => {
      const pidPath = path.join(root, "processes.json");
      const script = [
        "const { spawn } = require('node:child_process');",
        "const fs = require('node:fs');",
        "process.on('SIGTERM', () => {});",
        "const descendant = spawn(process.execPath, ['-e', 'process.on(\\\"SIGTERM\\\", () => {}); setInterval(() => {}, 1000);'], { stdio: 'ignore' });",
        `fs.writeFileSync(${JSON.stringify(pidPath)}, JSON.stringify({ parent: process.pid, descendant: descendant.pid }));`,
        "setInterval(() => {}, 1000);",
      ].join("\n");
      let pids;
      try {
        const running = defaultRunProcess(process.execPath, ["-e", script], { cwd: root, timeoutMs: 150, termGraceMs: 150 });
        pids = JSON.parse(await waitForFile(pidPath));
        const result = await running;
        assert.equal(result.timedOut, true);
        assert.equal(result.escalated, true);
        assert.equal(result.groupClean, true);
        assert.equal(processGroupAlive(pids.parent), false, "owned process group must be absent after escalation");
        await assertPidGone(pids.descendant, "TERM-ignoring descendant");
      } finally {
        if (pids?.parent) {
          try { process.kill(-pids.parent, "SIGKILL"); } catch { /* already gone */ }
        }
        if (pids?.descendant) {
          try { process.kill(pids.descendant, "SIGKILL"); } catch { /* already gone */ }
        }
      }
    });
  });

  it("keeps the outer ProcessHost phase alive when an inherited prep child closes normally", async (t) => {
    if (process.platform === "win32") return;
    await withOuterChildPhase(t, async ({ root, start }) => {
      const wrapperPath = path.join(root, "normal-wrapper.mjs");
      const wrapperPidPath = path.join(root, "wrapper.json");
      const childPidPath = path.join(root, "child.json");
      const resultPath = path.join(root, "result.json");
      const childSource = [
        "const fs = require('node:fs');",
        "const { execFileSync } = require('node:child_process');",
        "const pgid = Number(execFileSync('ps', ['-o', 'pgid=', '-p', String(process.pid)], { encoding: 'utf8' }).trim());",
        `fs.writeFileSync(${JSON.stringify(childPidPath)}, JSON.stringify({ pid: process.pid, pgid }));`,
        "setTimeout(() => process.exit(0), 40);",
      ].join("\n");
      await fs.writeFile(wrapperPath, [
        "import { writeFileSync } from 'node:fs';",
        `import { defaultRunProcess } from ${JSON.stringify(new URL("./headless-prep.mjs", import.meta.url).href)};`,
        `writeFileSync(${JSON.stringify(wrapperPidPath)}, JSON.stringify({ pid: process.pid }));`,
        `const result = await defaultRunProcess(process.execPath, ["-e", ${JSON.stringify(childSource)}], { timeoutMs: 2_000, termGraceMs: 100 });`,
        `writeFileSync(${JSON.stringify(resultPath)}, JSON.stringify(result));`,
        "setInterval(() => {}, 1_000);",
      ].join("\n"), "utf8");

      const handle = await start(wrapperPath);
      const wrapper = JSON.parse(await waitForFile(wrapperPidPath));
      const child = JSON.parse(await waitForFile(childPidPath));
      const result = JSON.parse(await waitForFile(resultPath));

      assert.equal(result.ok, true);
      assert.equal(result.groupClean, true);
      assert.equal(await readProcessGroupId(wrapper.pid), handle.pid, "outer wrapper must lead the inherited phase group");
      assert.equal(child.pgid, handle.pid, "prep child must inherit the outer phase group");
      assert.equal(pidAlive(wrapper.pid), true, "normal prep close must not kill the outer wrapper");
      await assertPidGone(child.pid, "normally closed inherited prep child");
      t.diagnostic(`inherited prep normal-close evidence: outer pid/pgid=${wrapper.pid}/${handle.pid}, child pid/pgid=${child.pid}/${child.pgid}`);
    });
  });

  it("ProcessHost TERM-to-KILL removes the entire inherited prep subtree", async (t) => {
    if (process.platform === "win32") return;
    await withOuterChildPhase(t, async ({ root, start, stop }) => {
      const wrapperPath = path.join(root, "stubborn-wrapper.mjs");
      const wrapperPidPath = path.join(root, "wrapper.json");
      const subtreePidPath = path.join(root, "subtree.json");
      const termPath = path.join(root, "term.log");
      const descendantSource = [
        "const fs = require('node:fs');",
        `process.on('SIGTERM', () => fs.appendFileSync(${JSON.stringify(termPath)}, 'descendant\\n'));`,
        "setInterval(() => {}, 1_000);",
      ].join("\n");
      const prepSource = [
        "const fs = require('node:fs');",
        "const { execFileSync, spawn } = require('node:child_process');",
        "const pgid = () => Number(execFileSync('ps', ['-o', 'pgid=', '-p', String(process.pid)], { encoding: 'utf8' }).trim());",
        `process.on('SIGTERM', () => fs.appendFileSync(${JSON.stringify(termPath)}, 'prep\\n'));`,
        `const descendant = spawn(process.execPath, ["-e", ${JSON.stringify(descendantSource)}], { stdio: 'ignore' });`,
        `fs.writeFileSync(${JSON.stringify(subtreePidPath)}, JSON.stringify({ prep: process.pid, prepPgid: pgid(), descendant: descendant.pid }));`,
        "setInterval(() => {}, 1_000);",
      ].join("\n");
      await fs.writeFile(wrapperPath, [
        "import { writeFileSync } from 'node:fs';",
        `import { defaultRunProcess } from ${JSON.stringify(new URL("./headless-prep.mjs", import.meta.url).href)};`,
        `writeFileSync(${JSON.stringify(wrapperPidPath)}, JSON.stringify({ pid: process.pid }));`,
        `await defaultRunProcess(process.execPath, ["-e", ${JSON.stringify(prepSource)}], { timeoutMs: 10_000, termGraceMs: 100, killGraceMs: 500 });`,
      ].join("\n"), "utf8");

      const handle = await start(wrapperPath);
      const wrapper = JSON.parse(await waitForFile(wrapperPidPath));
      const subtree = JSON.parse(await waitForFile(subtreePidPath));
      const descendantPgid = await readProcessGroupId(subtree.descendant);
      assert.equal(await readProcessGroupId(wrapper.pid), handle.pid);
      assert.equal(subtree.prepPgid, handle.pid, "prep child must not create a nested detached group");
      assert.equal(descendantPgid, handle.pid, "TERM-ignoring prep descendant must remain in the outer group");

      const stopped = await stop();
      assert.equal(stopped.ok, true);
      assert.match(await fs.readFile(termPath, "utf8"), /prep/u, "outer ProcessHost must send TERM before KILL");
      assert.match(await fs.readFile(termPath, "utf8"), /descendant/u, "TERM must reach the inherited descendant before KILL");
      await assertPidGone(wrapper.pid, "outer prep wrapper");
      await assertPidGone(subtree.prep, "inherited prep child");
      await assertPidGone(subtree.descendant, "TERM-ignoring prep descendant");
      assert.equal(processGroupAlive(handle.pid), false, "outer ProcessHost group must be absent after escalation");
      t.diagnostic(`inherited prep escalation evidence: outer pgid=${handle.pid}; dead wrapper/prep/descendant pids=${wrapper.pid}/${subtree.prep}/${subtree.descendant}`);
    });
  });
});
