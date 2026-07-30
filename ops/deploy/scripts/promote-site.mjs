#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { RESERVED_SITE_PATHS, assertManifestDigest, syntheticPrefixSmoke, sha256, publicSiteRouteMap, assertPublicSitePointerBody, PUBLIC_SITE_POINTER_SCHEMA, PUBLIC_SITE_POINTER_CONTENT_TYPE, PUBLIC_SITE_POINTER_CACHE_CONTROL } from "./publish-site.mjs";

export function assertSameDigest(manifest, expectedDigest) {
  if (!/^[0-9a-f]{64}$/.test(manifest.manifest_sha256 ?? "")) throw new Error("promotion manifest must contain a SHA-256 digest");
  if (expectedDigest && manifest.manifest_sha256 !== expectedDigest) throw new Error("promotion digest does not match the sealed site manifest");
  assertManifestDigest(manifest);
  return manifest.manifest_sha256;
}

export function buildPromotionPlan(manifest, bucket) {
  if (!/^s3:\/\/[^/]+$/.test(bucket)) throw new Error("bucket must be s3://name");
  if (manifest.files.some((entry) => RESERVED_SITE_PATHS.has(entry.path))) throw new Error("promotion manifest contains a reserved durable site path");
  const releaseRoot = `${bucket}/${manifest.release_prefix}`;
  const currentRoot = `${bucket}/site/current`;
  const operations = manifest.files.map((entry) => ({
    source: `${releaseRoot}/${entry.path}`,
    destination: `${currentRoot}/${entry.path}`,
    cache_control: "no-store, no-cache, must-revalidate",
    content_type: entry.content_type,
  }));
  const route = publicSiteRouteMap();
  const pointer = assertPublicSitePointerBody({
    schema: PUBLIC_SITE_POINTER_SCHEMA,
    site_release_id: manifest.site_release_id,
    manifest_sha256: manifest.manifest_sha256,
    release_prefix: manifest.release_prefix,
  });
  return {
    operations,
    pointer,
    pointer_destination: `${bucket}/${route.object_key}`,
    pointer_route: route,
  };
}

function copy(operation) {
  const result = spawnSync("aws", ["s3", "cp", operation.source, operation.destination, "--content-type", operation.content_type, "--cache-control", operation.cache_control, "--metadata-directive", "REPLACE"], { stdio: "inherit" });
  if (result.status !== 0) throw new Error(`aws promotion copy failed for ${operation.destination}`);
}
function parseArgs(argv) {
  const args = { dryRun: false, apply: false, expectedDigest: "", outputDir: ".successor-site-promotion" };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--apply") args.apply = true;
    else if (["--manifest", "--bucket", "--dist", "--expected-manifest-sha256", "--output-dir"].includes(arg)) args[arg.slice(2).replaceAll("-", "_")] = argv[++i];
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (args.dryRun === args.apply) throw new Error("choose exactly one of --dry-run or --apply");
  if (!args.manifest || !args.bucket) throw new Error("--manifest and --bucket are required");
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const manifest = JSON.parse(await readFile(resolve(args.manifest), "utf8"));
  assertSameDigest(manifest, args.expected_manifest_sha256);
  if (args.dist) await syntheticPrefixSmoke(args.dist, manifest);
  const plan = buildPromotionPlan(manifest, args.bucket);
  const out = resolve(args.output_dir);
  await mkdir(out, { recursive: true });
  const pointerPath = join(out, "current.json");
  await writeFile(pointerPath, `${JSON.stringify(plan.pointer, null, 2)}\n`);
  if (args.dryRun) { console.log(JSON.stringify({ mode: "dry-run", manifest_sha256: manifest.manifest_sha256, pointer: plan.pointer, operations: plan.operations }, null, 2)); return; }
  for (const operation of plan.operations) copy(operation);
  const result = spawnSync("aws", ["s3", "cp", pointerPath, plan.pointer_destination, "--content-type", PUBLIC_SITE_POINTER_CONTENT_TYPE, "--cache-control", PUBLIC_SITE_POINTER_CACHE_CONTROL, "--metadata-directive", "REPLACE"], { stdio: "inherit" });
  if (result.status !== 0) throw new Error("aws promotion pointer write failed");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((error) => { console.error(`promote-site: ${error.message}`); process.exit(1); });
