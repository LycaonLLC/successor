#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile, readdir, mkdir, stat, writeFile } from "node:fs/promises";
import { join, relative, resolve, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const CONTENT_TYPES = new Map([
  [".html", "text/html; charset=utf-8"], [".css", "text/css; charset=utf-8"], [".js", "application/javascript"], [".mjs", "application/javascript"], [".json", "application/json"],
  [".svg", "image/svg+xml"], [".png", "image/png"], [".jpg", "image/jpeg"], [".jpeg", "image/jpeg"], [".webp", "image/webp"], [".avif", "image/avif"], [".gif", "image/gif"], [".ico", "image/x-icon"],
  [".woff", "font/woff"], [".woff2", "font/woff2"], [".ttf", "font/ttf"], [".otf", "font/otf"], [".mp3", "audio/mpeg"], [".ogg", "audio/ogg"], [".wav", "audio/wav"], [".mp4", "video/mp4"], [".webm", "video/webm"],
]);
const SMOKE_EXTENSIONS = new Set([".html", ".mp3", ".ogg", ".wav", ".woff", ".woff2", ".ttf", ".otf"]);
export const RESERVED_SITE_PATHS = new Set(["downloads/manifest.json"]);

export const PUBLIC_SITE_POINTER_PATH = "/current.json";
export const PUBLIC_SITE_POINTER_OBJECT_KEY = "site/current.json";
export const PUBLIC_SITE_POINTER_CONTENT_TYPE = "application/json";
export const PUBLIC_SITE_POINTER_CACHE_CONTROL = "no-store, no-cache, must-revalidate";
export const PUBLIC_SITE_POINTER_SCHEMA = "successor-site-pointer.v1";

/** Exact public route -> origin object mapping for the immutable site pointer. */
export function publicSiteRouteMap() {
  return Object.freeze({
    request_path: PUBLIC_SITE_POINTER_PATH,
    object_key: PUBLIC_SITE_POINTER_OBJECT_KEY,
    content_type: PUBLIC_SITE_POINTER_CONTENT_TYPE,
    cache_control: PUBLIC_SITE_POINTER_CACHE_CONTROL,
    rewrite_from: PUBLIC_SITE_POINTER_PATH,
    rewrite_to: `/${PUBLIC_SITE_POINTER_OBJECT_KEY}`,
  });
}

export function assertPublicSitePointerBody(pointer) {
  if (!pointer || typeof pointer !== "object" || Array.isArray(pointer)) {
    throw new Error("site pointer body must be a JSON object");
  }
  if (pointer.schema !== PUBLIC_SITE_POINTER_SCHEMA) {
    throw new Error(`site pointer schema must be ${PUBLIC_SITE_POINTER_SCHEMA}`);
  }
  if (typeof pointer.site_release_id !== "string" || !pointer.site_release_id) {
    throw new Error("site pointer requires site_release_id");
  }
  if (typeof pointer.manifest_sha256 !== "string" || !/^[0-9a-f]{64}$/.test(pointer.manifest_sha256)) {
    throw new Error("site pointer requires manifest_sha256");
  }
  if (typeof pointer.release_prefix !== "string" || !pointer.release_prefix.startsWith("site/releases/")) {
    throw new Error("site pointer requires release_prefix under site/releases/");
  }
  // Refuse publisher-only inventory fields so client runtime never inherits them.
  for (const forbidden of ["files", "operations", "smoke_routes", "canonical", "url_path", "object_key"]) {
    if (Object.prototype.hasOwnProperty.call(pointer, forbidden)) {
      throw new Error(`site pointer must not include publisher-only field ${forbidden}`);
    }
  }
  return pointer;
}

export function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
export function contentType(path) { return CONTENT_TYPES.get(extname(path).toLowerCase()) ?? "application/octet-stream"; }
async function filesUnder(root, current = root) {
  const entries = await readdir(current, { withFileTypes: true });
  const result = [];
  for (const entry of entries) { const absolute = join(current, entry.name); if (entry.isDirectory()) result.push(...await filesUnder(root, absolute)); else if (entry.isFile()) result.push(absolute); }
  return result.sort();
}
function safeReleaseId(value) { if (!/^[A-Za-z0-9][A-Za-z0-9._-]{1,127}$/.test(value ?? "")) throw new Error("site release id must be 2-128 safe URL characters"); return value; }
function safeRelative(root, absolute) { const path = relative(root, absolute).split("\\").join("/"); if (!path || path.startsWith("../") || path.includes("/../") || path.startsWith("/")) throw new Error(`unsafe site path: ${path}`); return path; }
function requestPath(path) { return path === "index.html" ? "/" : `/${path}`; }

export async function buildSiteManifest(dist, siteReleaseId) {
  const root = resolve(dist); const releaseId = safeReleaseId(siteReleaseId); const entries = [];
  for (const absolute of await filesUnder(root)) { const path = safeRelative(root, absolute); if (RESERVED_SITE_PATHS.has(path)) continue; const bytes = await readFile(absolute); entries.push({ path, sha256: sha256(bytes), size: bytes.length, content_type: contentType(path), object_key: `site/releases/${releaseId}/${path}` }); }
  if (!entries.some((entry) => entry.path === "index.html")) throw new Error("site dist must contain index.html");
  const inventory = { schema: "successor-site-assets.v1", site_release_id: releaseId, files: entries }; const manifestSha256 = sha256(Buffer.from(`${JSON.stringify(inventory, null, 2)}\n`));
  return { ...inventory, manifest_sha256: manifestSha256, release_prefix: `site/releases/${releaseId}`, files: entries.map((entry) => ({ ...entry, url_path: requestPath(entry.path) })) };
}
export async function syntheticPrefixSmoke(dist, manifest) {
  const root = resolve(dist); const smoke = [];
  for (const entry of manifest.files) {
    if (!SMOKE_EXTENSIONS.has(extname(entry.path).toLowerCase())) continue;
    const absolute = join(root, entry.path); const info = await stat(absolute).catch(() => null); if (!info?.isFile()) throw new Error(`synthetic-prefix-smoke missing ${entry.path}`);
    const bytes = await readFile(absolute); if (sha256(bytes) !== entry.sha256) throw new Error(`synthetic-prefix-smoke digest mismatch for ${entry.path}`);
    const syntheticPath = `/${entry.object_key}`; if (!syntheticPath.startsWith(`/site/releases/${manifest.site_release_id}/`)) throw new Error(`unprefixed synthetic route ${entry.path}`);
    smoke.push({ request_path: entry.url_path, synthetic_path: syntheticPath, content_type: entry.content_type });
  }
  if (smoke.length === 0) throw new Error("synthetic-prefix-smoke found no HTML/media/font/audio routes"); return smoke;
}
export function manifestCanonical(manifest) { const inventory = { schema: manifest.schema, site_release_id: manifest.site_release_id, files: manifest.files.map(({ path, sha256, size, content_type, object_key }) => ({ path, sha256, size, content_type, object_key })) }; return `${JSON.stringify(inventory, null, 2)}\n`; }
export function assertManifestDigest(manifest) { const digest = sha256(Buffer.from(manifestCanonical(manifest))); if (digest !== manifest.manifest_sha256) throw new Error(`site manifest SHA mismatch: expected ${manifest.manifest_sha256}, calculated ${digest}`); return digest; }
function parseArgs(argv) { const args = { dist: "site/dist", outputDir: ".successor-site-publish", dryRun: false, apply: false }; for (let i = 0; i < argv.length; i += 1) { const arg = argv[i]; if (arg === "--dry-run") args.dryRun = true; else if (arg === "--apply") args.apply = true; else if (["--dist", "--output-dir", "--bucket", "--site-release-id"].includes(arg)) args[arg.slice(2).replaceAll("-", "_")] = argv[++i]; else throw new Error(`unknown argument: ${arg}`); } if (args.dryRun === args.apply) throw new Error("choose exactly one of --dry-run or --apply"); if (!args.site_release_id) throw new Error("--site-release-id is required"); if (args.apply && !/^s3:\/\/[^/]+$/.test(args.bucket ?? "")) throw new Error("--bucket s3://name is required with --apply"); return args; }
function upload(source, destination, type) { const result = spawnSync("aws", ["s3", "cp", source, destination, "--content-type", type, "--cache-control", "public,max-age=31536000,immutable", "--metadata-directive", "REPLACE"], { stdio: "inherit" }); if (result.status !== 0) throw new Error(`aws upload failed for ${destination}`); }
async function main() { const args = parseArgs(process.argv.slice(2)); const manifest = await buildSiteManifest(args.dist, args.site_release_id); const smoke = await syntheticPrefixSmoke(args.dist, manifest); assertManifestDigest(manifest); const out = resolve(args.output_dir); await mkdir(out, { recursive: true }); const manifestPath = join(out, "site-manifest.json"); await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`); const destination = args.bucket ?? "s3://SITE_BUCKET"; const operations = manifest.files.map((entry) => ({ source: join(resolve(args.dist), entry.path), destination: `${destination}/${entry.object_key}`, content_type: entry.content_type })); operations.push({ source: manifestPath, destination: `${destination}/site/manifests/${manifest.manifest_sha256}.json`, content_type: "application/json" }); await writeFile(join(out, "synthetic-prefix-proof.json"), `${JSON.stringify({ schema: "successor-site-publish-proof.v1", site_release_id: manifest.site_release_id, manifest_sha256: manifest.manifest_sha256, smoke_routes: smoke }, null, 2)}\n`); if (args.dryRun) { console.log(JSON.stringify({ mode: "dry-run", manifest_sha256: manifest.manifest_sha256, release_prefix: manifest.release_prefix, operations }, null, 2)); return; } for (const operation of operations) upload(operation.source, operation.destination, operation.content_type); }
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((error) => { console.error(`publish-site: ${error.message}`); process.exit(1); });
