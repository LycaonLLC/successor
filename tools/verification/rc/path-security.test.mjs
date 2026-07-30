import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { tmpdir } from "node:os";
import { assertPrivatePath, assertRegularFileUnderWorktree, ensurePrivateDirectory } from "./path-security.mjs";

test("private directories reject symlinks and normalize broad modes", async () => {
  const root = await fs.mkdtemp(path.join(tmpdir(), "rc-private-"));
  const outside = await fs.mkdtemp(path.join(tmpdir(), "rc-outside-"));
  try {
    await fs.mkdir(path.join(root, "private"), { mode: 0o755 });
    const safe = await ensurePrivateDirectory(root, "private/state");
    assert.equal((await fs.stat(safe.path)).mode & 0o777, 0o700);
    await fs.symlink(outside, path.join(root, "private", "leak"));
    await assert.rejects(ensurePrivateDirectory(root, "private/leak/state"), /symlink/u);
    await assert.rejects(assertPrivatePath(root, path.join(root, "private", "leak", "secret")), /symlink/u);
  } finally { await fs.rm(root, { recursive: true, force: true }); await fs.rm(outside, { recursive: true, force: true }); }
});

test("build files must be regular realpaths under worktree", async () => {
  const root = await fs.mkdtemp(path.join(tmpdir(), "rc-build-"));
  const outside = await fs.mkdtemp(path.join(tmpdir(), "rc-build-outside-"));
  try {
    await fs.mkdir(path.join(root, "server", "dist"), { recursive: true });
    await fs.writeFile(path.join(outside, "index.js"), "x");
    await fs.symlink(path.join(outside, "index.js"), path.join(root, "server", "dist", "index.js"));
    await assert.rejects(assertRegularFileUnderWorktree(root, path.join(root, "server", "dist", "index.js"), "serverEntry"), /symlink/u);
  } finally { await fs.rm(root, { recursive: true, force: true }); await fs.rm(outside, { recursive: true, force: true }); }
});
