import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { artifactDigest, canonicalJson, hasUnredactedSecret, redactOutput, runCommand, sha256, validateMatrix, STANDALONE_MATRIX_SCHEMA } from "./protocol.mjs";
import { executeStandaloneMatrix, loadTaskMetadata } from "./run.mjs";

const node = process.execPath;
const git = (cwd, args) => execFileSync("git", ["-c", "user.name=standalone-test", "-c", "user.email=standalone@example.invalid", ...args], { cwd, encoding: "utf8" });
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "successor-standalone-test-"));
  await writeFile(path.join(root, "package.json"), "{}\n");
  git(root, ["init", "-q"]); git(root, ["add", "."]); git(root, ["commit", "-qm", "fixture"]);
  return root;
}

test("canonical ordering and task/artifact digests are deterministic", async () => {
  assert.equal(canonicalJson({ z: 1, a: { y: 2, x: 3 } }), '{"a":{"x":3,"y":2},"z":1}');
  const root = await fixture();
  const first = await artifactDigest(root, "package.json");
  const second = await artifactDigest(root, "package.json");
  assert.deepEqual(first, second);
  assert.equal(sha256(canonicalJson(first)), sha256(canonicalJson(second)));
  await rm(root, { recursive: true, force: true });
});

test("redacts credential output and rejects residual secret forms", () => {
  const clean = redactOutput("Authorization: Bearer abc.def.ghi token=super-secret", ["super-secret"]);
  assert.equal(hasUnredactedSecret(clean), false);
  assert.match(clean, /\[REDACTED\]/u);
  assert.equal(hasUnredactedSecret("password=hunter2"), true);
});

test("runCommand times out and kills the child process group", async () => {
  const result = await runCommand(node, ["-e", "setInterval(() => {}, 1000)"], { timeoutMs: 100 });
  assert.equal(result.timedOut, true);
  assert.equal(result.ok, false);
});

test("one required task failure fails the matrix and never reports skipped", async () => {
  const root = await fixture();
  const pass = [node, "-e", "console.log('ok')"];
  const fail = [node, "-e", "process.exit(3)"];
  const metadata = { schema: "successor.verify-standalone-task-metadata.v1", tasks: [
    { id: "standalone.a", label: "pass", required: true, command: pass, commands: [pass], artifacts: ["package.json"] },
    { id: "standalone.b", label: "fail", required: true, command: fail, commands: [fail], artifacts: ["package.json"] },
  ] };
  const matrix = await executeStandaloneMatrix({ root, metadata, artifactRoot: path.join(root, "..", "artifacts"), timeoutMs: 10_000, concurrency: 2 });
  assert.equal(matrix.status, "fail");
  assert.ok(matrix.tasks.every((task) => task.status !== "skipped"));
  await rm(root, { recursive: true, force: true });
});

test("source drift after task execution fails closed", async () => {
  const root = await fixture();
  const command = [node, "-e", "require('node:fs').appendFileSync('package.json','x')"];
  const metadata = { schema: "successor.verify-standalone-task-metadata.v1", tasks: [{ id: "standalone.mutate", label: "mutate", required: true, command, commands: [command], artifacts: ["package.json"] }] };
  const matrix = await executeStandaloneMatrix({ root, metadata, artifactRoot: path.join(root, "..", "drift-artifacts"), timeoutMs: 10_000, concurrency: 1 });
  assert.equal(matrix.status, "fail");
  assert.match(matrix.sourceError, /clean source tree|source changed/u);
  await rm(root, { recursive: true, force: true });
});

test("validateMatrix rejects artifact drift and accepts a clean synthetic matrix shape", () => {
  const artifact = { path: "report.json", bytes: 1, sha256: "a".repeat(64) };
  const matrix = { schema: STANDALONE_MATRIX_SCHEMA, source: { commit: "a".repeat(40), tree: "b".repeat(40), sourceHash: "c".repeat(64), manifest: {} }, tasks: [{ id: "standalone.a", command: ["true"], status: "pass", durationMs: 1, digest: "d".repeat(64), artifacts: [artifact] }] };
  assert.equal(validateMatrix(matrix), true);
  assert.throws(() => validateMatrix({ ...matrix, tasks: [{ ...matrix.tasks[0], artifacts: [{ ...artifact, sha256: "bad" }] }] }));
});

test("missing desktop command is a required explicit task, not an optional skip", async () => {
  const metadata = await loadTaskMetadata();
  const desktop = metadata.tasks.find((task) => task.id === "standalone.desktop");
  assert.ok(desktop?.commands.some((command) => command.join(" ").includes("verify-key-ownership-xvfb.mjs")));
  assert.equal(desktop.required, true);
});

test("rejects missing and cyclic task dependencies", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "successor-dag-test-"));
  const base = { schema: "successor.verify-standalone-task-metadata.v1", tasks: [{ id: "a", label: "a", required: true, command: [node, "-e", ""], artifacts: ["package.json"] }] };
  await writeFile(path.join(dir, "missing.json"), JSON.stringify({ ...base, tasks: [{ ...base.tasks[0], dependsOn: ["missing"] }] }));
  await assert.rejects(loadTaskMetadata(path.join(dir, "missing.json")), /missing task/);
  await writeFile(path.join(dir, "cycle.json"), JSON.stringify({ ...base, tasks: [{ ...base.tasks[0], dependsOn: ["b"] }, { id: "b", label: "b", required: true, command: [node, "-e", ""], artifacts: ["package.json"], dependsOn: ["a"] }] }));
  await assert.rejects(loadTaskMetadata(path.join(dir, "cycle.json")), /cycle/);
  await rm(dir, { recursive: true, force: true });
});
