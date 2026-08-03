import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertNoUnprefixedRuntimeAssetPaths,
  assertRequiredRustRuntimeAssets,
} from "./publish-client-assets.mjs";

const roots = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("publish client synthetic-prefix gate", () => {
  it("rejects root runtime asset requests and accepts release-prefixed requests", async () => {
    const root = await mkdtemp(join(tmpdir(), "successor-publish-assets-"));
    roots.push(root);
    await mkdir(join(root, "assets"), { recursive: true });
    await writeFile(join(root, "assets", "bad.js"), 'fetch("/assets/pawn-pack/pawn_male.glb")');
    await expect(assertNoUnprefixedRuntimeAssetPaths(root)).rejects.toThrow("/assets/");
    await writeFile(join(root, "assets", "bad.js"), 'fetch("/releases/fakehash/assets/pawn-pack/pawn_male.glb")');
    await expect(assertNoUnprefixedRuntimeAssetPaths(root)).resolves.toBe(true);
  });
});

describe("Rust runtime required-asset gate", () => {
  it("rejects a beta inventory without both authored pawn bodies", () => {
    expect(() => assertRequiredRustRuntimeAssets(
      "successor-rust-beta@abc123",
      ["index.html", "successor.js", "assets/pawn-pack/pawn_male.glb"],
    )).toThrow("assets/pawn-pack/pawn_female.glb");
  });

  it("accepts a beta inventory containing both authored pawn bodies", () => {
    expect(assertRequiredRustRuntimeAssets(
      "successor-rust-beta@abc123",
      [
        "index.html",
        "successor.js",
        "assets/pawn-pack/pawn_male.glb",
        "assets/pawn-pack/pawn_female.glb",
      ],
    )).toBe(true);
  });
});
