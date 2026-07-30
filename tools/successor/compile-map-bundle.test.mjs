import assert from "node:assert/strict";
import { mkdtemp, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { isMainModulePath } from "./compile-map-bundle.mjs";

test("CLI main detection follows real paths through symlinks", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "successor-compile-map-"));
  const link = path.join(dir, "compile-map-bundle.mjs");
  const target = path.resolve(import.meta.dirname, "compile-map-bundle.mjs");
  await symlink(target, link);
  assert.equal(isMainModulePath(link, target), true);
});
