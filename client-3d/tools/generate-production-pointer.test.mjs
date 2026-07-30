import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  DEFAULT_STOREFRONT_ORIGIN,
  writeProductionPointer,
} from "./generate-production-pointer.mjs";

test("publishes an immutable CDN-root pointer with launch page and existing targets", () => {
  const dist = fs.mkdtempSync(path.join(os.tmpdir(), "successor-production-pointer-"));
  try {
    fs.mkdirSync(path.join(dist, "assets"));
    fs.writeFileSync(path.join(dist, "assets", "main.js"), "main");
    fs.writeFileSync(path.join(dist, "assets", "main.css"), "css");
    fs.writeFileSync(path.join(dist, "index.html"), '<link rel="stylesheet" href="/assets/main.css"><script type="module" crossorigin src="/assets/main.js"></script>');
    fs.writeFileSync(path.join(dist, "production-asset-manifest.json"), JSON.stringify({ releaseId: "fixture@abcdef0123456789", contentHash: "a".repeat(64) }));
    const pointer = writeProductionPointer({ distDir: dist, publicAssetOrigin: "https://cdn.example.test/", configuredStorefrontOrigin: "https://store.example.test" });
    assert.deepEqual(pointer, { releaseId: "fixture@abcdef0123456789", launchPage: "https://cdn.example.test/index.html", entryScript: "https://cdn.example.test/assets/main.js", styles: ["https://cdn.example.test/assets/main.css"], assetBaseUrl: "https://cdn.example.test/", storeOrigin: "https://store.example.test" });
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dist, "current.json"), "utf8")), pointer);
  } finally { fs.rmSync(dist, { recursive: true, force: true }); }
});

test("requires one exact HTTPS storefront origin", () => {
  const dist = fs.mkdtempSync(path.join(os.tmpdir(), "successor-production-pointer-origin-"));
  try {
    fs.mkdirSync(path.join(dist, "assets"));
    fs.writeFileSync(path.join(dist, "assets", "main.js"), "main");
    fs.writeFileSync(path.join(dist, "assets", "main.css"), "css");
    fs.writeFileSync(path.join(dist, "index.html"), '<link rel="stylesheet" href="/assets/main.css"><script type="module" crossorigin src="/assets/main.js"></script>');
    fs.writeFileSync(path.join(dist, "production-asset-manifest.json"), JSON.stringify({ releaseId: "fixture@hash", contentHash: "b".repeat(64) }));
    assert.throws(() => writeProductionPointer({ distDir: dist, configuredStorefrontOrigin: "https://store.example.test/path" }), /one exact https origin/iu);
  } finally { fs.rmSync(dist, { recursive: true, force: true }); }
});

test("uses the canonical storefront for ordinary builds but keeps hosted releases explicit", () => {
  const dist = fs.mkdtempSync(path.join(os.tmpdir(), "successor-production-pointer-default-origin-"));
  try {
    fs.mkdirSync(path.join(dist, "assets"));
    fs.writeFileSync(path.join(dist, "assets", "main.js"), "main");
    fs.writeFileSync(path.join(dist, "assets", "main.css"), "css");
    fs.writeFileSync(path.join(dist, "index.html"), '<link rel="stylesheet" href="/assets/main.css"><script type="module" crossorigin src="/assets/main.js"></script>');
    fs.writeFileSync(path.join(dist, "production-asset-manifest.json"), JSON.stringify({ releaseId: "fixture@hash", contentHash: "b".repeat(64) }));

    const pointer = writeProductionPointer({
      distDir: dist,
      publicAssetOrigin: "http://127.0.0.1:5179",
    });
    assert.equal(pointer.storeOrigin, DEFAULT_STOREFRONT_ORIGIN);
    assert.throws(
      () => writeProductionPointer({
        distDir: dist,
        publicAssetOrigin: "https://cdn.example.test/",
        packageMode: "hosted-release",
      }),
      /SUCCESSOR_STOREFRONT_ORIGIN is required/iu,
    );
  } finally { fs.rmSync(dist, { recursive: true, force: true }); }
});

test("fails when a pointer target is missing", () => {
  const dist = fs.mkdtempSync(path.join(os.tmpdir(), "successor-production-pointer-missing-"));
  try {
    fs.writeFileSync(path.join(dist, "index.html"), '<link rel="stylesheet" href="/assets/missing.css"><script type="module" crossorigin src="/assets/missing.js"></script>');
    fs.writeFileSync(path.join(dist, "production-asset-manifest.json"), JSON.stringify({ releaseId: "fixture@hash", contentHash: "b".repeat(64) }));
    assert.throws(() => writeProductionPointer({ distDir: dist }), /missing pointer target/iu);
  } finally { fs.rmSync(dist, { recursive: true, force: true }); }
});
