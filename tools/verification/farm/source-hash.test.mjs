import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { createLocalSourceIdentity, createTreeSourceIdentity } from "./source-hash.mjs";

async function withTempDirectory(prefix, callback) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  try {
    return await callback(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function writeFixtureFile(root, relativePath, content) {
  const filePath = path.join(root, ...relativePath.split("/"));
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, "utf8");
}

function initGit(root) {
  const options = { cwd: root, stdio: "pipe" };
  execFileSync("git", ["init", "--quiet"], options);
  execFileSync("git", ["config", "user.email", "source-hash-test@example.invalid"], options);
  execFileSync("git", ["config", "user.name", "Source Hash Test"], options);
}

describe("source hash tree parity", () => {
  it("matches planner and worker identities while ignoring Git-ignored farm artifacts", async () => {
    await withTempDirectory("successor-source-hash-git-", async (root) => {
      await writeFixtureFile(root, ".gitignore", [
        ".terraform/",
        "*.tfstate",
        "tools/verification/coverage/temp-*.json",
        "pkg/",
        "*.local.toml",
        "",
      ].join("\n"));
      await writeFixtureFile(root, "source.txt", "expected source\n");
      initGit(root);
      execFileSync("git", ["add", ".gitignore", "source.txt"], { cwd: root, stdio: "pipe" });
      execFileSync("git", ["commit", "--quiet", "-m", "fixture"], { cwd: root, stdio: "pipe" });

      await writeFixtureFile(root, ".terraform/terraform.tfstate", "ignored terraform state\n");
      await writeFixtureFile(root, "infra.tfstate", "ignored state\n");
      await writeFixtureFile(root, "tools/verification/coverage/temp-run.json", "ignored coverage\n");
      await writeFixtureFile(root, "pkg/generated.js", "ignored package output\n");
      await writeFixtureFile(root, "server/dev.local.toml", "ignored local config\n");

      const planner = await createLocalSourceIdentity({ root, includeManifest: true });
      const worker = await createTreeSourceIdentity({
        root,
        expectedPaths: planner.manifest.entries.map((entry) => entry.path),
        includeManifest: true,
      });
      assert.strictEqual(worker.sourceHash, planner.sourceHash);
      assert.deepEqual(worker.manifest.entries.map((entry) => entry.path), planner.manifest.entries.map((entry) => entry.path));

      await writeFixtureFile(root, "injected-source.txt", "unexpected source\n");
      const mismatchedWorker = await createTreeSourceIdentity({
        root,
        expectedPaths: planner.manifest.entries.map((entry) => entry.path),
        includeManifest: false,
      });
      assert.notStrictEqual(mismatchedWorker.sourceHash, planner.sourceHash);
    });
  });

  it("uses deterministic ignored-artifact fallback for transported trees without Git metadata", async () => {
    await withTempDirectory("successor-source-hash-transport-", async (root) => {
      await writeFixtureFile(root, "source.txt", "expected source\n");
      await writeFixtureFile(root, ".terraform/terraform.tfstate", "ignored terraform state\n");
      await writeFixtureFile(root, "infra.tfstate", "ignored state\n");
      await writeFixtureFile(root, "tools/verification/coverage/temp-run.json", "ignored coverage\n");
      await writeFixtureFile(root, "pkg/generated.js", "ignored package output\n");
      await writeFixtureFile(root, "server/dev.local.toml", "ignored local config\n");

      const expectedPaths = ["source.txt"];
      const clean = await createTreeSourceIdentity({ root, expectedPaths, includeManifest: true });
      assert.deepEqual(clean.manifest.entries.map((entry) => entry.path), expectedPaths);

      await writeFixtureFile(root, "injected-source.txt", "unexpected source\n");
      const mismatched = await createTreeSourceIdentity({ root, expectedPaths, includeManifest: false });
      assert.notStrictEqual(mismatched.sourceHash, clean.sourceHash);
    });
  });
});
