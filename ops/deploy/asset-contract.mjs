import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const root = await mkdtemp(join(tmpdir(), "successor-assets-"));
try {
  const dist = join(root, "dist");
  const out = join(root, "publish");
  await mkdir(join(dist, "chunks"), { recursive: true });
  await writeFile(join(dist, "index.html"), "<script type=module src=\"chunks/app.js\"></script>\n");
  await writeFile(join(dist, "chunks/app.js"), "import './style.css';\n");
  await writeFile(join(dist, "chunks/style.css"), "@font-face { src: url(./font.woff2); }\n");
  await writeFile(join(dist, "chunks/font.woff2"), Buffer.from([0, 1, 2, 3]));
  await writeFile(join(dist, "audio.mp3"), Buffer.from([73, 68, 51]));
  await writeFile(join(dist, "current.json"), JSON.stringify({ releaseId: "release-contract", launchPage: "http://localhost:5179/index.html", entryScript: "http://localhost:5179/chunks/app.js", styles: ["http://localhost:5179/chunks/style.css"], assetBaseUrl: "http://localhost:5179/chunks/" }));
  const script = new URL("./scripts/publish-client-assets.mjs", import.meta.url);
  const run = spawnSync(process.execPath, [script.pathname, "--dist", dist, "--output-dir", out, "--cdn-origin", "https://cdn.example.test", "--store-origin", "https://store.compress.biz", "--dry-run"], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  const report = JSON.parse(run.stdout);
  assert.equal(report.mode, "dry-run");
  assert.match(report.pointer_url, /https:\/\/cdn\.example\.test\/current\.json$/);
  assert.match(report.manifest_url, /https:\/\/cdn\.example\.test\/manifests\/[0-9a-f]{64}\.json$/);
  const manifest = JSON.parse(await readFile(join(out, "manifest.json"), "utf8"));
  const pointer = JSON.parse(await readFile(join(out, "current.json"), "utf8"));
  assert.equal(pointer.manifestSha256, report.manifest_sha256);
  assert.equal(pointer.releaseId, "release-contract");
  assert.match(pointer.launchPage, /^https:\/\/cdn\.example\.test\/releases\/[0-9a-f]{64}\/index\.html$/);
  assert.match(pointer.entryScript, /^https:\/\/cdn\.example\.test\/releases\/[0-9a-f]{64}\/chunks\/app\.js$/);
  assert.match(pointer.styles[0], /^https:\/\/cdn\.example\.test\/releases\/[0-9a-f]{64}\/chunks\/style\.css$/);
  assert.match(pointer.assetBaseUrl, /^https:\/\/cdn\.example\.test\/releases\/[0-9a-f]{64}\/chunks\/$/);
  assert.ok(report.operations.some((item) => item.destination.endsWith("/index.html")));
  assert.ok(report.operations.some((item) => item.destination.endsWith("/chunks/app.js")));
  assert.equal(pointer.storeOrigin, "https://store.compress.biz");
  assert.equal(manifest.files.length, 5);
  assert.equal(manifest.files.find((item) => item.path === "chunks/app.js").content_type, "application/javascript");
  assert.equal(manifest.files.find((item) => item.path === "chunks/style.css").content_type, "text/css; charset=utf-8");
  assert.equal(manifest.files.find((item) => item.path === "chunks/font.woff2").content_type, "font/woff2");
  assert.equal(manifest.files.find((item) => item.path === "audio.mp3").content_type, "audio/mpeg");
  assert.ok(manifest.files.every((item) => /^releases\/[0-9a-f]{64}\//.test(item.object_key)));
  assert.ok(report.operations.slice(0, -2).every((item) => item.cache_control.endsWith("immutable")));
  assert.equal(report.operations.at(-1).destination, "s3://BUCKET/current.json");
  assert.equal(report.operations.at(-1).cache_control, "no-store,no-cache,must-revalidate");
  console.log("successor client asset contract: PASS");
} finally {
  await rm(root, { recursive: true, force: true });
}
