import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { RESERVED_SITE_PATHS, buildSiteManifest, syntheticPrefixSmoke, assertManifestDigest, publicSiteRouteMap, assertPublicSitePointerBody, PUBLIC_SITE_POINTER_CONTENT_TYPE, PUBLIC_SITE_POINTER_CACHE_CONTROL, PUBLIC_SITE_POINTER_SCHEMA } from "./publish-site.mjs";
import { assertSameDigest, buildPromotionPlan } from "./promote-site.mjs";

const roots = [];
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "successor-site-contract-"));
  roots.push(root);
  await mkdir(join(root, "audio"), { recursive: true });
  await mkdir(join(root, "fonts"), { recursive: true });
  await mkdir(join(root, "downloads"), { recursive: true });
  await writeFile(join(root, "index.html"), "<!doctype html><link rel=\"stylesheet\" href=\"/app.css\">");
  await writeFile(join(root, "app.css"), "body{font-family:site}");
  await writeFile(join(root, "audio", "intro.ogg"), "fake-audio");
  await writeFile(join(root, "fonts", "site.woff2"), "fake-font");
  await writeFile(join(root, "downloads", "manifest.json"), JSON.stringify({ builds: [] }));
  return root;
}

process.on("exit", () => { for (const root of roots) void rm(root, { recursive: true, force: true }); });

describe("standalone site publication contract", () => {
  it("builds immutable release keys and smokes HTML/audio/font routes", async () => {
    const root = await fixture();
    const manifest = await buildSiteManifest(root, "alpha-20260724");
    assert.equal(manifest.release_prefix, "site/releases/alpha-20260724");
    assertManifestDigest(manifest);
    const smoke = await syntheticPrefixSmoke(root, manifest);
    assert.deepEqual(smoke.map((route) => route.request_path).sort(), ["/", "/audio/intro.ogg", "/fonts/site.woff2"]);
    assert(smoke.every((route) => route.synthetic_path.startsWith("/site/releases/alpha-20260724/")));
    assert(RESERVED_SITE_PATHS.has("downloads/manifest.json"));
    assert.equal(manifest.files.some((entry) => entry.path === "downloads/manifest.json"), false);
  });

  it("promotes only a digest-pinned manifest and writes current after release copies", async () => {
    const root = await fixture();
    const manifest = await buildSiteManifest(root, "alpha-20260724");
    const plan = buildPromotionPlan(manifest, "s3://successor-site");
    assert.equal(assertSameDigest(manifest, manifest.manifest_sha256), manifest.manifest_sha256);
    assert.equal(plan.pointer.manifest_sha256, manifest.manifest_sha256);
    assert.equal(plan.pointer_destination, "s3://successor-site/site/current.json");
    assert(plan.operations.every((operation) => operation.source.includes("/site/releases/alpha-20260724/")));
    assert.throws(() => assertSameDigest(manifest, "0".repeat(64)), /does not match/);
    assert.throws(
      () => buildPromotionPlan({ ...manifest, files: [...manifest.files, { path: "downloads/manifest.json" }] }, "s3://successor-site"),
      /reserved durable site path/,
    );
  });

  it("maps public /current.json to immutable pointer object with exact type/cache/body", async () => {
    const root = await fixture();
    const manifest = await buildSiteManifest(root, "alpha-20260724");
    const plan = buildPromotionPlan(manifest, "s3://successor-site");
    const route = publicSiteRouteMap();
    assert.deepEqual(route, {
      request_path: "/current.json",
      object_key: "site/current.json",
      content_type: PUBLIC_SITE_POINTER_CONTENT_TYPE,
      cache_control: PUBLIC_SITE_POINTER_CACHE_CONTROL,
      rewrite_from: "/current.json",
      rewrite_to: "/site/current.json",
    });
    assert.equal(plan.pointer_destination, "s3://successor-site/site/current.json");
    assert.deepEqual(plan.pointer_route, route);
    assert.equal(plan.pointer.schema, PUBLIC_SITE_POINTER_SCHEMA);
    assertPublicSitePointerBody(plan.pointer);
    assert.equal(Object.prototype.hasOwnProperty.call(plan.pointer, "files"), false);
    assert.equal(manifest.files.some((entry) => entry.path === "current.json"), false);
    assert.equal(RESERVED_SITE_PATHS.has("downloads/manifest.json"), true);
    assert.throws(
      () => assertPublicSitePointerBody({ ...plan.pointer, files: manifest.files }),
      /publisher-only field files/,
    );
    assert.throws(
      () => assertPublicSitePointerBody({ ...plan.pointer, schema: "publisher-only.v1" }),
      /site pointer schema/,
    );
  });
});
