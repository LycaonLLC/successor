import { mkdtemp, rm, writeFile, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertNoUnprefixedRuntimeAssetPaths,
  assertRequiredRustRuntimeAssets,
  buildManifest,
  planOperations,
} from "./publish-client-assets.mjs";

const roots = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function tempRoot() {
  const root = await mkdtemp(join(tmpdir(), "successor-publish-assets-"));
  roots.push(root);
  return root;
}

const POINTER = {
  releaseId: "successor-rust-beta@test",
  launchPage: "http://localhost:5179/index.html",
  entryScript: "http://localhost:5179/successor.js",
  styles: [],
  assetBaseUrl: "http://localhost:5179/",
  storeOrigin: "https://store.compress.biz",
};

async function rustDist(root, { schema = "successor.rust-web-release.v1", files = [] } = {}) {
  const dist = join(root, "dist");
  await mkdir(join(dist, "assets/pawn-pack"), { recursive: true });
  await writeFile(join(dist, "index.html"), "<html></html>\n");
  await writeFile(join(dist, "successor.js"), "// shim\n");
  await writeFile(join(dist, "assets/pawn-pack/pawn_male.glb"), Buffer.from([1, 2, 3]));
  await writeFile(join(dist, "assets/pawn-pack/pawn_female.glb"), Buffer.from([4, 5, 6]));
  for (const file of files) {
    await mkdir(join(dist, file.path, ".."), { recursive: true });
    await writeFile(join(dist, file.path), file.bytes);
  }
  await writeFile(join(dist, "current.json"), JSON.stringify(POINTER));
  const releaseManifest = {
    schema,
    clientReleaseId: POINTER.releaseId,
    files: [],
    ...(schema === "successor.rust-web-release.v2"
      ? { boot: [], packIndex: {} }
      : { initialAssets: [] }),
  };
  await writeFile(join(dist, "release-manifest.json"), JSON.stringify(releaseManifest));
  return { dist, releaseManifest };
}

async function finalizeReleaseManifest(dist, releaseManifest) {
  const { readdir } = await import("node:fs/promises");
  const walk = async (dir, base = dir) => {
    const out = [];
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) out.push(...await walk(path, base));
      else if (entry.isFile()) out.push(path);
    }
    return out;
  };
  const files = [];
  for (const absolute of await walk(dist)) {
    const path = absolute.slice(dist.length + 1).split("\\").join("/");
    if (path === "release-manifest.json" || path === "current.json") continue;
    const bytes = await readFile(absolute);
    files.push({ path, bytes: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex") });
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  releaseManifest.files = files;
  if (releaseManifest.schema === "successor.rust-web-release.v2") {
    releaseManifest.boot = files.filter((f) => f.path.startsWith("assets/")).map((f) => f.path);
    releaseManifest.packIndex = {};
  } else {
    releaseManifest.initialAssets = files.map((f) => f.path);
  }
  await writeFile(join(dist, "release-manifest.json"), JSON.stringify(releaseManifest));
  return releaseManifest;
}

describe("publish client synthetic-prefix gate", () => {
  it("rejects root runtime asset requests and accepts release-prefixed requests", async () => {
    const root = await tempRoot();
    await mkdir(join(root, "assets"), { recursive: true });
    await writeFile(join(root, "assets", "bad.js"), 'fetch("/assets/pawn-pack/pawn_male.glb")');
    await expect(assertNoUnprefixedRuntimeAssetPaths(root)).rejects.toThrow("/assets/");
    await writeFile(join(root, "assets", "bad.js"), 'fetch("/releases/fakehash/assets/pawn-pack/pawn_male.glb")');
    await expect(assertNoUnprefixedRuntimeAssetPaths(root)).resolves.toBe(true);
  });

  it("accepts content-addressed object requests", async () => {
    const root = await tempRoot();
    await mkdir(join(root, "assets"), { recursive: true });
    await writeFile(join(root, "assets", "ok.js"), 'fetch("/objects/" + "a".repeat(64))');
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

describe("object-store manifest", () => {
  it("classifies stream paths as content objects and keeps entry files release-scoped", async () => {
    const root = await tempRoot();
    const { dist, releaseManifest } = await rustDist(root);
    await finalizeReleaseManifest(dist, releaseManifest);
    const result = await buildManifest(dist, "https://cdn.example.test", "https://store.compress.biz", { objectStore: true });
    expect(result.manifest.schema).toBe("successor-client-assets.v2");
    const byPath = new Map(result.manifest.files.map((file) => [file.path, file]));
    expect(byPath.get("assets/pawn-pack/pawn_male.glb").object_key).toBe(`objects/${byPath.get("assets/pawn-pack/pawn_male.glb").sha256}`);
    expect(byPath.get("index.html").object_key).toBe(`releases/${result.manifestSha256}/index.html`);
    expect(byPath.get("successor.js").object_key).toBe(`releases/${result.manifestSha256}/successor.js`);
    expect(byPath.get("assets/pawn-pack/pawn_male.glb").content_encoding).toBe("gzip");
    expect(byPath.get("index.html").content_encoding).toBe("gzip");
  });

  it("keeps legacy path layout and v1 schema without --object-store", async () => {
    const root = await tempRoot();
    const { dist, releaseManifest } = await rustDist(root);
    await finalizeReleaseManifest(dist, releaseManifest);
    const result = await buildManifest(dist, "https://cdn.example.test", "https://store.compress.biz");
    expect(result.manifest.schema).toBe("successor-client-assets.v1");
    expect(result.manifest.files.every((file) => file.object_key.startsWith(`releases/${result.manifestSha256}/`))).toBe(true);
    expect(result.manifest.files.every((file) => file.content_encoding === undefined)).toBe(true);
  });

  it("keeps the inventory hash independent of object key assignment", async () => {
    const root = await tempRoot();
    const { dist, releaseManifest } = await rustDist(root);
    await finalizeReleaseManifest(dist, releaseManifest);
    const a = await buildManifest(dist, "https://cdn.example.test", "https://store.compress.biz", { objectStore: true });
    const b = await buildManifest(dist, "https://cdn.other.example", "https://store.compress.biz", { objectStore: true });
    expect(a.manifestSha256).toBe(b.manifestSha256);
  });

  it("validates a v2 boot stream against files and packIndex", async () => {
    const root = await tempRoot();
    const { dist, releaseManifest } = await rustDist(root, {
      schema: "successor.rust-web-release.v2",
      files: [{ path: "packs/boot.spak", bytes: Buffer.from([9, 9, 9]) }],
    });
    await finalizeReleaseManifest(dist, releaseManifest);
    const result = await buildManifest(dist, "https://cdn.example.test", "https://store.compress.biz", { objectStore: true });
    expect(result.manifest.schema).toBe("successor-client-assets.v2");
  });

  it("rejects a v2 manifest whose boot omits a required pawn body", async () => {
    const root = await tempRoot();
    const { dist, releaseManifest } = await rustDist(root, { schema: "successor.rust-web-release.v2" });
    await finalizeReleaseManifest(dist, releaseManifest);
    releaseManifest.boot = releaseManifest.boot.filter((path) => !path.includes("pawn_female"));
    await writeFile(join(dist, "release-manifest.json"), JSON.stringify(releaseManifest));
    await expect(buildManifest(dist, "https://cdn.example.test", "https://store.compress.biz", { objectStore: true }))
      .rejects.toThrow("pawn_female");
  });
});

describe("publication planning", () => {
  it("skips objects already present in the store and uploads pointer last", async () => {
    const root = await tempRoot();
    const { dist, releaseManifest } = await rustDist(root);
    await finalizeReleaseManifest(dist, releaseManifest);
    const out = join(root, "publish");
    await mkdir(out, { recursive: true });
    const result = await buildManifest(dist, "https://cdn.example.test", "https://store.compress.biz", { objectStore: true });
    const male = result.manifest.files.find((file) => file.path === "assets/pawn-pack/pawn_male.glb");
    const existing = new Set([male.object_key]);
    const first = await planOperations({ result, dist, out, bucket: "s3://BUCKET", baseline: null, existingObjects: existing });
    expect(first.skippedExisting).toBe(1);
    expect(first.uploads.some((op) => op.destination.endsWith(male.object_key))).toBe(false);
    expect(first.uploads.at(-1).destination).toBe("s3://BUCKET/current.json");
    expect(first.uploads.at(-2).destination).toContain("/manifests/");
    const everything = new Set(result.manifest.files.filter((file) => file.object_key.startsWith("objects/")).map((file) => file.object_key));
    const second = await planOperations({ result, dist, out, bucket: "s3://BUCKET", baseline: null, existingObjects: everything });
    expect(second.uploads.length).toBe(5);
    expect(second.uploads.filter((op) => op.destination.includes("/objects/")).length).toBe(0);
  });

  it("writes gzip payloads only for compressible object types", async () => {
    const root = await tempRoot();
    const { dist, releaseManifest } = await rustDist(root, {
      files: [{ path: "successor-audio/sfx/clip.mp3", bytes: Buffer.from([73, 68, 51]) }],
    });
    await finalizeReleaseManifest(dist, releaseManifest);
    const out = join(root, "publish");
    await mkdir(out, { recursive: true });
    const result = await buildManifest(dist, "https://cdn.example.test", "https://store.compress.biz", { objectStore: true });
    const plan = await planOperations({ result, dist, out, bucket: "s3://BUCKET", baseline: null, existingObjects: new Set() });
    const glb = plan.uploads.find((op) => op.content_type === "model/gltf-binary");
    const mp3 = plan.uploads.find((op) => op.content_type === "audio/mpeg");
    expect(glb.content_encoding).toBe("gzip");
    expect(mp3.content_encoding).toBeUndefined();
    const gzBytes = await readFile(glb.source);
    expect(gzBytes[0]).toBe(0x1f);
    expect(gzBytes[1]).toBe(0x8b);
  });

  it("copies unchanged legacy files forward from the baseline release", async () => {
    const root = await tempRoot();
    const { dist, releaseManifest } = await rustDist(root);
    await finalizeReleaseManifest(dist, releaseManifest);
    const out = join(root, "publish");
    await mkdir(out, { recursive: true });
    const previous = await buildManifest(dist, "https://cdn.example.test", "https://store.compress.biz");
    await writeFile(join(dist, "successor.js"), "// shim v2\n");
    await finalizeReleaseManifest(dist, releaseManifest);
    const next = await buildManifest(dist, "https://cdn.example.test", "https://store.compress.biz");
    const baseline = {
      byPath: new Map(previous.manifest.files.map((file) => [file.path, file.sha256])),
      releasePrefix: `releases/${previous.manifestSha256}`,
    };
    const plan = await planOperations({ result: next, dist, out, bucket: "s3://BUCKET", baseline, existingObjects: new Set() });
    const copiedPaths = plan.copies.map((op) => op.key);
    expect(copiedPaths).toContain(`releases/${next.manifestSha256}/index.html`);
    expect(copiedPaths).not.toContain(`releases/${next.manifestSha256}/successor.js`);
    expect(plan.copies.every((op) => op.copy_source.startsWith(`BUCKET/releases/${previous.manifestSha256}/`))).toBe(true);
    expect(plan.uploads.some((op) => op.destination.endsWith("/successor.js"))).toBe(true);
  });
});
