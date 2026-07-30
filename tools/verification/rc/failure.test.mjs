import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { tmpdir } from "node:os";
import { writeFailureBundle } from "./failure.mjs";

test("failure bundle refuses symlinked failure path and uses private mode", async () => {
  const root = await fs.mkdtemp(path.join(tmpdir(), "rc-failure-"));
  const outside = await fs.mkdtemp(path.join(tmpdir(), "rc-failure-outside-"));
  try {
    await fs.symlink(outside, path.join(root, "failure"));
    await assert.rejects(writeFailureBundle(root, { reason: "safe" }), /symlink/u);
    await fs.unlink(path.join(root, "failure"));
    const target = await writeFailureBundle(root, { reason: "safe" });
    assert.equal((await fs.stat(path.dirname(target))).mode & 0o777, 0o700);
  } finally { await fs.rm(root, { recursive: true, force: true }); await fs.rm(outside, { recursive: true, force: true }); }
});
