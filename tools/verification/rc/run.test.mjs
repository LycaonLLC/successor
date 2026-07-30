import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { deriveVerdict } from "./run.mjs";

const runner = path.join(path.dirname(fileURLToPath(import.meta.url)), "run.mjs");

function git(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, `${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

test("runner rejects abbreviated commits with one invocation line", () => {
  const result = spawnSync(process.execPath, [runner, "--commit", "f07c47d0"], { encoding: "utf8" });
  assert.equal(result.status, 2);
  assert.match(result.stdout, /^RC FAIL invocation f07c47d0\n$/u);
  assert.equal(result.stderr, "");
});

test("explicit pass cannot override blocked or incomplete gates", () => {
  assert.equal(deriveVerdict({ verdict: "pass", gates: { worldReady: "blocked" } }, null, false, false), "incomplete");
  assert.equal(deriveVerdict({ verdict: "pass", gates: { worldReady: "incomplete" } }, null, false, false), "incomplete");
  assert.equal(deriveVerdict({ verdict: "pass", gates: { worldReady: "fail" } }, null, false, false), "fail");
  assert.equal(deriveVerdict({ verdict: "pass", gates: { worldReady: "pass", cleanup: "pass" } }, null, false, false), "pass");
  assert.equal(deriveVerdict({ verdict: "pass", gates: {} }, null, false, false), "incomplete");
});

test("a fail verdict without a failing gate seals a bounded failure bundle", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "successor-rc-run-mismatch-"));
  try {
    const worktree = path.join(root, "fixture");
    const rcDir = path.join(worktree, "tools", "verification", "rc");
    await fs.mkdir(rcDir, { recursive: true });
    for (const file of ["run.mjs", "evidence.mjs", "failure.mjs", "path-security.mjs"]) await fs.copyFile(path.join(path.dirname(runner), file), path.join(rcDir, file));
    await fs.writeFile(path.join(worktree, "package.json"), '{"type":"module"}\n');
    await fs.writeFile(path.join(rcDir, "local-stack.mjs"), `export async function startLocalStack({ onEvent }) {\n  await onEvent({ type: "stack.ready" });\n  return { probe: async () => ({ status: "ready" }), stop: async () => ({ ok: true }) };\n}\n`);
    await fs.writeFile(path.join(rcDir, "two-player.mjs"), `export async function runTwoPlayerEntryProof() {\n  return { verdict: "fail", gates: { worldReady: "pass" }, aliases: { p1: "p1", p2: "p2" } };\n}\n`);
    git(worktree, ["init", "-q"]);
    git(worktree, ["config", "user.email", "rc-test@example.invalid"]);
    git(worktree, ["config", "user.name", "RC test"]);
    git(worktree, ["add", "."]);
    git(worktree, ["commit", "-qm", "fixture"]);
    const sha = git(worktree, ["rev-parse", "HEAD"]);
    const isolated = await import(`${pathToFileURL(path.join(rcDir, "run.mjs")).href}?mismatch-test=${Date.now()}`);
    const runRoot = path.join(root, "run");
    const result = await isolated.runProof({ sha, worktree, runRoot, runId: "rc-mismatch" });
    assert.equal(result.exitCode, 1);
    assert.match(result.line, /RC FAIL inconsistent-proof .*\/failure\/bundle\.json$/u);
    const bundlePath = path.join(runRoot, "evidence", "failure", "bundle.json");
    const bundle = JSON.parse(await fs.readFile(bundlePath, "utf8"));
    assert.equal(bundle.code, "inconsistent-proof");
    assert.equal(bundle.step, "proof");
    assert.match(bundle.reason, /without a failing gate/u);
    const manifest = JSON.parse(await fs.readFile(path.join(runRoot, "evidence", "manifest.json"), "utf8"));
    assert.equal(manifest.verdict, "fail");
    assert.equal(manifest.failure.code, "inconsistent-proof");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
