#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile, readdir, mkdir, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

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
]);

function parseArgs(argv) {
  const args = { dist: "client-3d/dist", outputDir: ".successor-client-publish", dryRun: false, apply: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--apply") args.apply = true;
    else if (["--dist", "--output-dir", "--bucket", "--cdn-origin", "--store-origin"].includes(arg)) args[arg.slice(2).replaceAll("-", "_")] = argv[++i];
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (args.dryRun === args.apply) throw new Error("choose exactly one of --dry-run or --apply");
  if (!args.cdn_origin) throw new Error("--cdn-origin is required");
  if (!/^https:\/\/[^/*]+$/.test(args.store_origin ?? "")) throw new Error("--store-origin must be one exact https origin (no wildcard)");
  if (args.apply && !/^s3:\/\/[^/]+$/.test(args.bucket ?? "")) throw new Error("--bucket s3://name is required with --apply");
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
function contentType(path) { return CONTENT_TYPES.get(path.slice(path.lastIndexOf(".")).toLowerCase()) ?? "application/octet-stream"; }
function originUrl(origin, key) { return `${origin.replace(/\/$/, "")}/${key}`; }

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

export async function buildManifest(dist, cdnOrigin, storeOrigin) {
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
    entries.push({ path, sha256: digest, size: bytes.length, content_type: contentType(path) });
  }
  const inventory = { schema: "successor-client-assets.v1", release_id: sourcePointer.releaseId, files: entries };
  const inventoryCanonical = `${JSON.stringify(inventory, null, 2)}\n`;
  const manifestSha256 = sha256(Buffer.from(inventoryCanonical));
  const releasePrefix = `releases/${manifestSha256}`;
  for (const item of entries) {
    item.object_key = `${releasePrefix}/${item.path}`;
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
    if (!/^releases\/[0-9a-f]{64}\/.+/.test(item.object_key) || !item.object_key.endsWith(item.path)) throw new Error(`invalid release object key for ${item.path}`);
  }
  return true;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = await buildManifest(args.dist, args.cdn_origin, args.store_origin);
  assertManifestIntegrity(args.dist, result);
  const out = resolve(args.output_dir);
  await mkdir(out, { recursive: true });
  await writeFile(join(out, "manifest.json"), result.canonical);
  await writeFile(join(out, "current.json"), `${JSON.stringify(result.pointer, null, 2)}\n`);
  const operations = result.manifest.files.map((item) => ({ source: join(resolve(args.dist), item.path), destination: `${args.bucket ?? "s3://BUCKET"}/${item.object_key}`, content_type: item.content_type, cache_control: "public,max-age=31536000,immutable" }));
  operations.push({ source: join(out, "manifest.json"), destination: `${args.bucket ?? "s3://BUCKET"}/${result.manifestKey}`, content_type: "application/json", cache_control: "public,max-age=31536000,immutable" });
  operations.push({ source: join(out, "current.json"), destination: `${args.bucket ?? "s3://BUCKET"}/current.json`, content_type: "application/json", cache_control: "no-store,no-cache,must-revalidate" });
  if (args.dryRun) { console.log(JSON.stringify({ mode: "dry-run", manifest_sha256: result.manifestSha256, manifest_url: result.pointer.manifestUrl, pointer_url: originUrl(args.cdn_origin, "current.json"), operations }, null, 2)); return; }
  for (const op of operations) {
    const proc = spawnSync("aws", ["s3", "cp", op.source, op.destination, "--content-type", op.content_type, "--cache-control", op.cache_control, "--metadata-directive", "REPLACE"], { stdio: "inherit" });
    if (proc.status !== 0) throw new Error(`aws upload failed for ${op.destination}`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((error) => { console.error(`publish-client-assets: ${error.message}`); process.exit(1); });
