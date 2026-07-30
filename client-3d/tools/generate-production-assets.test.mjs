import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  addEntry,
  assertStagingMatchesManifest,
  createAssetManifest,
  generateProductionAssets,
  resolveMappedPublicAsset,
} from "./generate-production-assets.mjs";
import { isGeneratedOrIgnoredPath } from "../../tools/verification/farm/source-hash.mjs";

test("source classifier ignores generated staging leftovers", () => {
  assert.equal(isGeneratedOrIgnoredPath("client-3d/.generated/production-assets/production-asset-manifest.json"), true);
});

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "successor-production-assets-"));
}

function entry(sourcePath, authority = "test.authority") {
  return { sourcePath, authorities: new Set([authority]) };
}

test("reachable assets are included with size, hash, and authority", () => {
  const root = tempRoot();
  try {
    fs.mkdirSync(path.join(root, "client-3d", "public", "assets"), { recursive: true });
    fs.writeFileSync(path.join(root, "client-3d", "public", "assets", "required.bin"), "required");
    const manifest = createAssetManifest({
      repoRoot: root,
      fixtureIdentity: "fixture-test",
      entries: new Map([["assets/required.bin", entry("client-3d/public/assets/required.bin")]]),
    });
    assert.equal(manifest.entries[0].path, "assets/required.bin");
    assert.equal(manifest.entries[0].size, 8);
    assert.equal(manifest.entries[0].authority[0], "test.authority");
    assert.match(manifest.entries[0].sha256, /^[0-9a-f]{64}$/u);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
test("post-copy verification rejects bytes changed after manifest hashing", () => {
  const root = tempRoot();
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), "successor-production-assets-copy-"));
  try {
    fs.mkdirSync(path.join(root, "client-3d", "public", "assets"), { recursive: true });
    fs.writeFileSync(path.join(root, "client-3d", "public", "assets", "required.bin"), "required");
    const manifest = createAssetManifest({
      repoRoot: root,
      fixtureIdentity: "fixture-test",
      entries: new Map([["assets/required.bin", entry("client-3d/public/assets/required.bin")]]),
    });
    fs.mkdirSync(path.join(stage, "assets"), { recursive: true });
    fs.writeFileSync(path.join(stage, "assets", "required.bin"), "mutated");
    fs.writeFileSync(path.join(stage, "production-asset-manifest.json"), JSON.stringify(manifest));
    assert.throws(() => assertStagingMatchesManifest(stage, manifest), /staged bytes changed/iu);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(stage, { recursive: true, force: true });
  }
});

test("missing references, traversal, absolute paths, and conflicting destinations fail closed", () => {
  const root = tempRoot();
  try {
    assert.throws(() => createAssetManifest({
      repoRoot: root,
      fixtureIdentity: "fixture-test",
      entries: new Map([["assets/missing.bin", entry("client-3d/public/assets/missing.bin")]]),
    }), /missing referenced asset/iu);
    assert.throws(() => createAssetManifest({
      repoRoot: root,
      fixtureIdentity: "fixture-test",
      entries: new Map([["../escape.bin", entry("safe.bin")]]),
    }), /escapes staging root/iu);
    assert.throws(() => createAssetManifest({
      repoRoot: root,
      fixtureIdentity: "fixture-test",
      entries: new Map([["assets/private.bin", entry(path.join(root, "private.bin"))]]),
    }), /absolute source path/iu);
    const entries = new Map();
    addEntry(entries, { destination: "assets/same.bin", sourcePath: "a.bin", authority: "one" });
    assert.throws(
      () => addEntry(entries, { destination: "assets/same.bin", sourcePath: "b.bin", authority: "two" }),
      /duplicate\/conflicting/iu,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
test("cleanup refuses to overlap authored public source", () => {
  const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
  assert.throws(
    () => generateProductionAssets({ repoRoot, stagingDir: path.join(repoRoot, "client-3d", "public") }),
    /overlap authored public source/iu,
  );
});


test("production plan reruns deterministically and omits catalogs/labs", () => {
  const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), "successor-production-assets-stage-"));
  try {
    const first = generateProductionAssets({ repoRoot, stagingDir: stage, allowExternalStaging: true });
    const firstBytes = fs.readFileSync(path.join(stage, "production-asset-manifest.json"));
    const second = generateProductionAssets({ repoRoot, stagingDir: stage, allowExternalStaging: true });
    const secondBytes = fs.readFileSync(path.join(stage, "production-asset-manifest.json"));
    assert.deepEqual(secondBytes, firstBytes);
    assert.equal(second.manifest.manifestSha256, first.manifest.manifestSha256);
    assert.ok(second.manifest.entries.some((item) => item.path === "successor-slice/open-desert-slice.json"));
    assert.ok(second.manifest.entries.some((item) => item.path.includes("creatures/")));
    assert.equal(second.manifest.entries.some((item) => /asset-lab|trial/iu.test(item.path)), false);
    // Dustgate occupation props map absolute public wave-props URLs; stage them once.
    assert.ok(second.manifest.entries.some((item) => item.path.startsWith("assets/wave-props/")));
    assert.equal(second.manifest.entries.some((item) => item.path.includes("world-items/assets/")), false);
    assert.ok(second.manifest.entries.filter((item) => item.path.endsWith(".png")).length >= 50);
    assert.equal(second.manifest.entries.filter((item) => item.path.includes("crops/world/")).length, 36);
    assert.ok(second.manifest.entries.some((item) => item.path === "assets/pawn-pack/plasma_hilt.glb"));
    assert.ok(second.manifest.entries.some((item) => item.path === "assets/pawn-pack/weapons/custom/wpn_launcher_flare_net.glb"));
    assert.ok(second.manifest.entries.some((item) => item.path === "assets/pawn-pack/equipment/Under/top_frayed_tunic.glb"));
    assert.ok(second.manifest.entries.some((item) => item.path === "assets/items/custom/crops/world/nightplum/laden.glb"));
    assert.equal(second.manifest.entries.some((item) => item.path.endsWith("food/dishes/ashgrain_hearth_loaf.glb")), false);
    assert.ok(second.manifest.entries.every((item) => Array.isArray(item.category) && item.category.length > 0 && Array.isArray(item.reason) && item.reason.length > 0));
    assert.equal(second.manifest.selection.after.files, second.manifest.totals.files);
    assert.equal(second.manifest.selection.after.bytes, second.manifest.totals.bytes);
    assert.equal(second.manifest.selection.before.files - second.manifest.selection.after.files, second.manifest.selection.savings.files);
    assert.equal(second.manifest.selection.before.bytes - second.manifest.selection.after.bytes, second.manifest.selection.savings.bytes);
    assert.ok(second.manifest.entries.some((item) => item.path === "assets/world-items/supply_cache.glb"));
    assertStagingMatchesManifest(stage, second.manifest);
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
});

test("offline developer mode intentionally stages the full authored public tree", () => {
  const repoRoot = tempRoot();
  const stage = path.join(repoRoot, ".generated", "offline");
  try {
    fs.mkdirSync(path.join(repoRoot, "client-3d", "public", "assets", "catalog"), { recursive: true });
    fs.mkdirSync(path.join(repoRoot, "client", "public", "successor-slice"), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, "client-3d", "public", "assets", "catalog", "viewer-only.bin"), "catalog");
    fs.writeFileSync(path.join(repoRoot, "client", "public", "successor-slice", "open-desert-slice.json"), JSON.stringify({ stateHash: "offline-fixture" }));
    const result = generateProductionAssets({ repoRoot, stagingDir: stage, mode: "offline" });
    assert.equal(result.manifest.mode, "offline");
    assert.ok(result.manifest.entries.some((item) => item.path === "assets/catalog/viewer-only.bin"));
    assert.ok(result.manifest.entries.some((item) => item.path === "successor-slice/open-desert-slice.json"));
    assertStagingMatchesManifest(stage, result.manifest);
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("props-mapping absolute public paths stage once under public root", () => {
  const absolute = resolveMappedPublicAsset(
    "/assets/wave-props/everyday-wave-20260719/everyday-world-props/successor_everyday_workbench.glb",
  );
  assert.equal(
    absolute.destination,
    "assets/wave-props/everyday-wave-20260719/everyday-world-props/successor_everyday_workbench.glb",
  );
  assert.equal(
    absolute.sourcePath,
    "client-3d/public/assets/wave-props/everyday-wave-20260719/everyday-world-props/successor_everyday_workbench.glb",
  );
  assert.equal(absolute.destination.includes("world-items/assets/"), false);

  const relative = resolveMappedPublicAsset("supply_cache.glb", { underWorldItems: true });
  assert.equal(relative.destination, "assets/world-items/supply_cache.glb");
  assert.equal(relative.sourcePath, "client-3d/public/assets/world-items/supply_cache.glb");

  const alreadyPrefixed = resolveMappedPublicAsset("assets/world-items/supply_cache.glb");
  assert.equal(alreadyPrefixed.destination, "assets/world-items/supply_cache.glb");

  assert.throws(() => resolveMappedPublicAsset("../escape.glb", { underWorldItems: true }), /escapes staging root|forbidden/iu);
  assert.throws(() => resolveMappedPublicAsset("/assets/../secret.bin"), /traversal|forbidden|escapes/iu);
  assert.throws(() => resolveMappedPublicAsset("//evil.example/x.glb"), /absolute asset path is forbidden/iu);
  assert.throws(() => resolveMappedPublicAsset("C:\\windows\\x.glb"), /forbidden/iu);
});
