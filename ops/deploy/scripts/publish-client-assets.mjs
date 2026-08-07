#!/usr/bin/env node
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { readFile, readdir, mkdir, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const CONTENT_TYPES = new Map([
  [".js", "application/javascript"],
  [".mjs", "application/javascript"],
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".json", "application/json"],
  [".wasm", "application/wasm"],
  [".glb", "model/gltf-binary"],
  [".gltf", "model/gltf+json"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
  [".svg", "image/svg+xml"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
  [".mp3", "audio/mpeg"],
  [".ogg", "audio/ogg"],
  [".wav", "audio/wav"],
  [".mp4", "video/mp4"],
  [".webm", "video/webm"],
  [".ttf", "font/ttf"],
  [".spak", "application/octet-stream"],
]);

// Object-store uploads are precompressed for these types. .spak packs are
// dominated by uncompressed GLB payload, so they gzip well despite containing
// some already-compressed audio. Already-compressed media stays identity.
const GZIP_EXTENSIONS = new Set([".json", ".js", ".mjs", ".css", ".html", ".wasm", ".glb", ".gltf", ".spak"]);

// Paths that become content-addressed objects under objects/<sha256> in
// --object-store mode. Mirrors the streaming predicate in
// client-rust/tools/web-release.mjs; everything else stays release-scoped.
const OBJECT_PATH_PREFIXES = ["assets/", "successor-audio/", "successor-slice/", "render/", "packs/"];

const UPLOAD_CONCURRENCY = 16;
const IMMUTABLE_CACHE = "public,max-age=31536000,immutable";
const POINTER_CACHE = "no-store,no-cache,must-revalidate";

function parseArgs(argv) {
  const args = { dist: "client-3d/dist", outputDir: ".successor-client-publish", dryRun: false, apply: false, objectStore: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--apply") args.apply = true;
    else if (arg === "--object-store") args.objectStore = true;
    else if (["--dist", "--output-dir", "--bucket", "--cdn-origin", "--store-origin", "--baseline-manifest", "--existing-objects"].includes(arg)) args[arg.slice(2).replaceAll("-", "_")] = argv[++i];
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (args.dryRun === args.apply) throw new Error("choose exactly one of --dry-run or --apply");
  if (!args.cdn_origin) throw new Error("--cdn-origin is required");
  if (!/^https:\/\/[^/*]+$/.test(args.store_origin ?? "")) throw new Error("--store-origin must be one exact https origin (no wildcard)");
  if (args.apply && !/^s3:\/\/[^/]+$/.test(args.bucket ?? "")) throw new Error("--bucket s3://name is required with --apply");
  if (args.baseline_manifest && args.object_store) throw new Error("--baseline-manifest copy-forward only applies to path-layout (non-object-store) releases");
  return args;
}

async function filesUnder(root, current = root) {
  const entries = await readdir(current, { withFileTypes: true });
  const paths = [];
  for (const entry of entries) {
    const path = join(current, entry.name);
    if (entry.isDirectory()) paths.push(...await filesUnder(root, path));
    else if (entry.isFile() && relative(root, path).split("\\").join("/") !== "current.json") paths.push(path);
  }
  return paths.sort();
}

function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function extensionOf(path) { return path.slice(path.lastIndexOf(".")).toLowerCase(); }
function contentType(path) { return CONTENT_TYPES.get(extensionOf(path)) ?? "application/octet-stream"; }
function originUrl(origin, key) { return `${origin.replace(/\/$/, "")}/${key}`; }
function isObjectPath(path) { return OBJECT_PATH_PREFIXES.some((prefix) => path.startsWith(prefix)); }

const FORBIDDEN_ROOT_ASSET_PREFIXES = [
  "/successor-slice/",
  "/successor-audio/",
  "/assets/",
  "/production-asset-manifest.json",
];
const SCANNED_DIST_EXTENSIONS = new Set([".js", ".mjs", ".css", ".html", ".json"]);

/** Reject root-relative asset requests that bypass an immutable release prefix. */
export async function assertNoUnprefixedRuntimeAssetPaths(dist) {
  const root = resolve(dist);
  const offenders = [];
  for (const absolute of await filesUnder(root)) {
    const extension = absolute.slice(absolute.lastIndexOf(".")).toLowerCase();
    if (!SCANNED_DIST_EXTENSIONS.has(extension)) continue;
    const source = await readFile(absolute, "utf8");
    for (const prefix of FORBIDDEN_ROOT_ASSET_PREFIXES) {
      const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const requestPattern = new RegExp("(?:fetch|loadAsync|\\.load|new URL)\\s*\\(\\s*[\"\\x27]" + escaped + "|(?:src|href)\\s*=\\s*[\"\\x27]" + escaped, "u");
      if (requestPattern.test(source)) offenders.push(`${relative(root, absolute)}:${prefix}`);
    }
  }
  if (offenders.length) throw new Error(`dist contains unprefixed runtime asset paths: ${offenders.join(", ")}`);
  return true;
}
// "/objects/" is deliberately NOT a forbidden root prefix: content-addressed
// objects are immutable by construction, exactly like a release prefix.

const REQUIRED_RUST_RUNTIME_ASSETS = [
  "assets/pawn-pack/pawn_male.glb",
  "assets/pawn-pack/pawn_female.glb",
];

/** Fail closed before publication when a Rust runtime omits fatal body assets. */
export function assertRequiredRustRuntimeAssets(releaseId, paths) {
  if (!releaseId.startsWith("successor-rust-")) return true;
  const available = new Set(paths);
  const missing = REQUIRED_RUST_RUNTIME_ASSETS.filter((path) => !available.has(path));
  if (missing.length > 0) throw new Error(`Rust runtime is missing required assets: ${missing.join(", ")}`);
  return true;
}

async function rustReleaseDocument(root, releaseId) {
  if (!releaseId.startsWith("successor-rust-")) return null;
  const path = join(root, "release-manifest.json");
  let release;
  try {
    release = JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new Error("Rust runtime dist must contain release-manifest.json");
  }
  if (release.clientReleaseId !== releaseId) throw new Error("Rust release manifest identity mismatch");
  return release;
}

async function assertRustReleaseManifest(root, releaseId, entries) {
  const release = await rustReleaseDocument(root, releaseId);
  if (!release) return true;
  const published = new Map(entries.map((entry) => [entry.path, entry]));
  for (const expected of release.files ?? []) {
    const actual = published.get(expected.path);
    if (!actual || actual.size !== expected.bytes || actual.sha256 !== expected.sha256) {
      throw new Error(`Rust release inventory mismatch: ${expected.path}`);
    }
  }
  if (release.schema === "successor.rust-web-release.v2") {
    if (!Array.isArray(release.boot) || release.boot.length === 0) {
      throw new Error("Rust v2 release manifest requires a non-empty boot[]");
    }
    const packIndex = release.packIndex && typeof release.packIndex === "object" ? release.packIndex : {};
    for (const [id, reference] of Object.entries(packIndex)) {
      if (!reference || typeof reference.pack !== "string" || !published.has(reference.pack)) {
        throw new Error(`Rust pack index references unpublished pack for: ${id}`);
      }
    }
    for (const initial of release.boot) {
      if (!published.has(initial) && !(initial in packIndex)) throw new Error(`Rust boot asset is not published: ${initial}`);
    }
    // Staged spawn-neighborhood region packs (Phase 5): optional, but every
    // listed pack must be a published file.
    if (release.bootPacks !== undefined) {
      if (!Array.isArray(release.bootPacks) || release.bootPacks.some((path) => typeof path !== "string")) {
        throw new Error("Rust v2 release manifest bootPacks must be a string array");
      }
      for (const pack of release.bootPacks) {
        if (!published.has(pack)) throw new Error(`Rust boot pack is not published: ${pack}`);
      }
    }
    for (const required of REQUIRED_RUST_RUNTIME_ASSETS) {
      if (!release.boot.includes(required)) throw new Error(`Rust boot stream omits required asset: ${required}`);
    }
    return true;
  }
  if (!Array.isArray(release.files) || !Array.isArray(release.initialAssets) || release.initialAssets.length === 0) {
    throw new Error("Rust release manifest requires files[] and a non-empty initialAssets[]");
  }
  for (const initial of release.initialAssets) {
    if (!published.has(initial)) throw new Error(`Rust initial asset is not published: ${initial}`);
  }
  return true;
}

function localPath(value, origin, field) {
  if (typeof value !== "string") throw new Error(`dist/current.json ${field} must be a URL`);
  let parsed;
  try { parsed = new URL(value); } catch { throw new Error(`dist/current.json ${field} must be an absolute URL`); }
  if (parsed.origin !== origin) throw new Error(`dist/current.json ${field} has a foreign origin`);
  const decoded = decodeURIComponent(parsed.pathname);
  const path = decoded.replace(/^\/+/, "");
  if (!path || path.split("/").some((part) => part === "..")) throw new Error(`dist/current.json ${field} has an invalid path`);
  return path;
}

export async function buildManifest(dist, cdnOrigin, storeOrigin, { objectStore = false } = {}) {
  const root = resolve(dist);
  await assertNoUnprefixedRuntimeAssetPaths(root);
  const sourcePointer = JSON.parse(await readFile(join(root, "current.json"), "utf8"));
  if (typeof sourcePointer.releaseId !== "string" || sourcePointer.releaseId.length === 0) throw new Error("dist/current.json requires releaseId");
  if (typeof sourcePointer.entryScript !== "string") throw new Error("dist/current.json requires entryScript");
  if (!Array.isArray(sourcePointer.styles)) throw new Error("dist/current.json requires styles[]");
  if (typeof sourcePointer.assetBaseUrl !== "string") throw new Error("dist/current.json requires assetBaseUrl");
  if (sourcePointer.storeOrigin !== storeOrigin) throw new Error("dist/current.json storeOrigin must exactly match --store-origin");
  const localOrigin = new URL(sourcePointer.entryScript).origin;
  const launchValue = sourcePointer.launchPage ?? `${localOrigin}/index.html`;
  const launchPath = localPath(launchValue, localOrigin, "launchPage");
  const entryPath = localPath(sourcePointer.entryScript, localOrigin, "entryScript");
  const stylePaths = sourcePointer.styles.map((value) => localPath(value, localOrigin, "styles[]"));
  const assetBase = new URL(sourcePointer.assetBaseUrl);
  if (assetBase.origin !== localOrigin) throw new Error("dist/current.json assetBaseUrl has a foreign origin");
  const decodedBasePath = decodeURIComponent(assetBase.pathname);
  const assetBasePath = decodedBasePath.replace(/^\/+/, "");
  if (!decodedBasePath.endsWith("/") || assetBasePath.split("/").some((part) => part === "..")) throw new Error("dist/current.json assetBaseUrl must be a safe directory URL");
  const entries = [];
  for (const absolute of await filesUnder(root)) {
    const bytes = await readFile(absolute);
    const path = relative(root, absolute).split("\\").join("/");
    const digest = sha256(bytes);
    const entry = { path, sha256: digest, size: bytes.length, content_type: contentType(path) };
    if (objectStore) entry.content_encoding = GZIP_EXTENSIONS.has(extensionOf(path)) ? "gzip" : null;
    entries.push(entry);
  }
  const rustRelease = await rustReleaseDocument(root, sourcePointer.releaseId);
  const rustV2 = rustRelease?.schema === "successor.rust-web-release.v2";
  if (!rustV2) assertRequiredRustRuntimeAssets(sourcePointer.releaseId, entries.map((entry) => entry.path));
  await assertRustReleaseManifest(root, sourcePointer.releaseId, entries);
  const inventory = {
    schema: objectStore ? "successor-client-assets.v2" : "successor-client-assets.v1",
    release_id: sourcePointer.releaseId,
    files: entries,
  };
  const inventoryCanonical = `${JSON.stringify(inventory, null, 2)}\n`;
  const manifestSha256 = sha256(Buffer.from(inventoryCanonical));
  const releasePrefix = `releases/${manifestSha256}`;
  for (const item of entries) {
    item.object_key = objectStore && isObjectPath(item.path) ? `objects/${item.sha256}` : `${releasePrefix}/${item.path}`;
    item.url = originUrl(cdnOrigin, item.object_key);
  }
  const byPath = new Map(entries.map((item) => [item.path, item.url]));
  const mapped = (field, path) => {
    if (!byPath.has(path)) throw new Error(`dist/current.json ${field} must reference a file in dist`);
    return byPath.get(path);
  };
  const manifest = { ...inventory, manifest_sha256: manifestSha256, cdn_origin: cdnOrigin.replace(/\/$/, ""), store_origin: storeOrigin, files: entries };
  const canonical = `${JSON.stringify(manifest, null, 2)}\n`;
  const manifestKey = `manifests/${manifestSha256}.json`;
  const cdnBase = `${cdnOrigin.replace(/\/$/, "")}/${releasePrefix}/${assetBasePath}`;
  return { manifest, canonical, manifestSha256, manifestKey, pointer: { releaseId: sourcePointer.releaseId, launchPage: mapped("launchPage", launchPath), entryScript: mapped("entryScript", entryPath), styles: stylePaths.map((path) => mapped("styles[]", path)), assetBaseUrl: cdnBase, manifestSha256, manifestUrl: originUrl(cdnOrigin, manifestKey), cdnOrigin: manifest.cdn_origin, storeOrigin } };
}

function assertManifestIntegrity(root, result) {
  if (result.manifest.manifest_sha256 !== result.manifestSha256) throw new Error("manifest inventory hash mismatch");
  for (const item of result.manifest.files) {
    const releaseScoped = /^releases\/[0-9a-f]{64}\/.+/.test(item.object_key) && item.object_key.endsWith(item.path);
    const objectScoped = new RegExp(`^objects/${item.sha256}$`).test(item.object_key);
    if (!releaseScoped && !objectScoped) throw new Error(`invalid release object key for ${item.path}`);
  }
  return true;
}

async function loadBaselineManifest(value) {
  if (!value) return null;
  let parsed;
  if (/^https:\/\//u.test(value)) {
    const response = await fetch(value);
    if (!response.ok) throw new Error(`baseline manifest fetch failed: ${response.status}`);
    parsed = await response.json();
  } else {
    parsed = JSON.parse(await readFile(resolve(value), "utf8"));
  }
  if (!Array.isArray(parsed.files)) throw new Error("baseline manifest requires files[]");
  const byPath = new Map();
  for (const file of parsed.files) {
    if (typeof file.path === "string" && typeof file.sha256 === "string") byPath.set(file.path, file.sha256);
  }
  const prefixMatch = /^releases\/([0-9a-f]{64})\//.exec(parsed.files.find((file) => typeof file.object_key === "string")?.object_key ?? "");
  if (!prefixMatch) throw new Error("baseline manifest files carry no release prefix");
  return { byPath, releasePrefix: `releases/${prefixMatch[1]}` };
}

async function loadExistingObjects(args) {
  if (args.existing_objects) {
    const text = await readFile(resolve(args.existing_objects), "utf8");
    return new Set(text.split("\n").map((line) => line.trim()).filter(Boolean));
  }
  if (!args.bucket) return new Set();
  const listing = await runAws(["s3", "ls", `${args.bucket}/objects/`, "--recursive"]);
  const keys = new Set();
  for (const line of listing.split("\n")) {
    const match = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\s+\d+ (.+)$/u.exec(line.trim());
    if (match) keys.add(match[1]);
  }
  return keys;
}

function runAws(args) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn("aws", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => rejectPromise(new Error(`aws ${args[0]} ${args[1] ?? ""} failed: ${error.message}`)));
    child.on("close", (status) => {
      if (status === 0) resolvePromise(stdout);
      else rejectPromise(new Error(`aws ${args.slice(0, 2).join(" ")} exited ${status}: ${stderr.trim()}`));
    });
  });
}

async function runPool(items, worker, concurrency = UPLOAD_CONCURRENCY) {
  let next = 0;
  const lanes = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++];
      await worker(item);
    }
  });
  await Promise.all(lanes);
}

/**
 * Build the ordered upload/copy plan. Objects first (only keys not already in
 * the bucket), then release-scoped files (copy-forward when the baseline
 * carries identical content), then the manifest, and current.json strictly
 * last so the mutable pointer never leads its immutable tree.
 */
export async function planOperations({ result, dist, out, bucket, baseline, existingObjects }) {
  const root = resolve(dist);
  const uploads = [];
  const copies = [];
  const gzDir = join(out, "objects-gz");
  const seenObjects = new Set();
  let skippedExisting = 0;
  let copiedForward = 0;
  for (const item of result.manifest.files) {
    const objectScoped = item.object_key.startsWith("objects/");
    if (objectScoped && (existingObjects.has(item.object_key) || seenObjects.has(item.object_key))) {
      skippedExisting += 1;
      continue;
    }
    if (objectScoped) seenObjects.add(item.object_key);
    const destination = `${bucket}/${item.object_key}`;
    if (!objectScoped && baseline) {
      const baselineSha = baseline.byPath.get(item.path);
      if (baselineSha === item.sha256) {
        copies.push({ kind: "copy", copy_source: `${bucket.replace(/^s3:\/\//u, "")}/${baseline.releasePrefix}/${item.path}`, key: item.object_key, destination });
        copiedForward += 1;
        continue;
      }
    }
    let source = join(root, item.path);
    if (objectScoped && item.content_encoding === "gzip") {
      await mkdir(gzDir, { recursive: true });
      const gzPath = join(gzDir, item.sha256);
      await writeFile(gzPath, gzipSync(await readFile(source), { level: 9 }));
      source = gzPath;
    }
    uploads.push({ kind: "cp", source, destination, content_type: item.content_type, cache_control: IMMUTABLE_CACHE, ...(objectScoped && item.content_encoding === "gzip" ? { content_encoding: "gzip" } : {}) });
  }
  uploads.push({ kind: "cp", source: join(out, "manifest.json"), destination: `${bucket}/${result.manifestKey}`, content_type: "application/json", cache_control: IMMUTABLE_CACHE });
  uploads.push({ kind: "cp", source: join(out, "current.json"), destination: `${bucket}/current.json`, content_type: "application/json", cache_control: POINTER_CACHE });
  return { uploads, copies, skippedExisting, copiedForward };
}

async function applyPlan(plan, bucket) {
  const bucketName = bucket.replace(/^s3:\/\//u, "");
  const cpArgs = (op) => {
    const args = ["s3", "cp", op.source, op.destination, "--content-type", op.content_type, "--cache-control", op.cache_control, "--metadata-directive", "REPLACE"];
    if (op.content_encoding) args.push("--content-encoding", op.content_encoding);
    return args;
  };
  const manifestAndPointer = plan.uploads.slice(-2);
  const objectUploads = plan.uploads.slice(0, -2).filter((op) => op.destination.includes("/objects/"));
  const releaseUploads = plan.uploads.slice(0, -2).filter((op) => !op.destination.includes("/objects/"));
  await runPool(objectUploads, async (op) => { await runAws(cpArgs(op)); });
  await runPool(releaseUploads, async (op) => { await runAws(cpArgs(op)); });
  await runPool(plan.copies, async (op) => {
    await runAws(["s3api", "copy-object", "--bucket", bucketName, "--copy-source", op.copy_source, "--key", op.key, "--metadata-directive", "COPY"]);
  });
  await runAws(cpArgs(manifestAndPointer[0]));
  await runAws(cpArgs(manifestAndPointer[1]));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = await buildManifest(args.dist, args.cdn_origin, args.store_origin, { objectStore: args.objectStore });
  assertManifestIntegrity(args.dist, result);
  const out = resolve(args.output_dir);
  await mkdir(out, { recursive: true });
  await writeFile(join(out, "manifest.json"), result.canonical);
  await writeFile(join(out, "current.json"), `${JSON.stringify(result.pointer, null, 2)}\n`);
  const baseline = await loadBaselineManifest(args.baseline_manifest);
  const existingObjects = args.objectStore ? await loadExistingObjects(args) : new Set();
  const bucket = args.bucket ?? "s3://BUCKET";
  const plan = await planOperations({ result, dist: args.dist, out, bucket, baseline, existingObjects });
  const operations = [...plan.uploads.slice(0, -2), ...plan.copies, ...plan.uploads.slice(-2)];
  if (args.dryRun) {
    console.log(JSON.stringify({ mode: "dry-run", manifest_sha256: result.manifestSha256, manifest_url: result.pointer.manifestUrl, pointer_url: originUrl(args.cdn_origin, "current.json"), skipped_existing_objects: plan.skippedExisting, copied_forward: plan.copiedForward, operations }, null, 2));
    return;
  }
  await applyPlan(plan, bucket);
  console.log(JSON.stringify({ mode: "apply", manifest_sha256: result.manifestSha256, uploaded: plan.uploads.length, copied_forward: plan.copiedForward, skipped_existing_objects: plan.skippedExisting }, null, 2));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((error) => { console.error(`publish-client-assets: ${error.message}`); process.exit(1); });
