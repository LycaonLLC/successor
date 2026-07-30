import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "vitest";

import { assertOutsideArtifactRoots, createBrowserRuntimeRoot, removeBrowserRuntimeRoot } from "./util.mjs";

async function withTempDirectory(callback) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "successor-client3d-util-"));
  try {
    await callback(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

describe("client-3d runtime artifact boundary", () => {
  it("creates headed-browser state outside repo/artifact roots and removes it", async () => {
    await withTempDirectory(async (root) => {
      const repoRoot = path.join(root, "checkout");
      const artifactRoot = path.join(root, "verification", "ledgers", "artifacts", "client3d", "run-1");
      const runtimeRoot = createBrowserRuntimeRoot({ runId: "run-1", repoRoot, artifactRoot });
      try {
        assert.ok(runtimeRoot.startsWith(`${os.tmpdir()}${path.sep}`));
        assert.strictEqual(assertOutsideArtifactRoots(runtimeRoot, { repoRoot, artifactRoot }), runtimeRoot);
        assert.throws(
          () => assertOutsideArtifactRoots(path.join(artifactRoot, "chrome-profile"), { repoRoot, artifactRoot }),
          /artifact root/u,
        );
        assert.throws(
          () => assertOutsideArtifactRoots(path.join(repoRoot, "chrome-profile"), { repoRoot, artifactRoot }),
          /repository root/u,
        );
      } finally {
        removeBrowserRuntimeRoot(runtimeRoot);
      }
      await assert.rejects(fs.access(runtimeRoot));
    });
  });
});
