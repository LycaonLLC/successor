#!/usr/bin/env node
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const RELEASE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}(?:@[0-9a-f]{8,64})?$/u;
const HASH = /^[0-9a-f]{64}$/u;
const COMMIT = /^[0-9a-f]{40}$/u;

export function parseArgs(argv) {
  const args = { dryRun: false, apply: false, outputDir: ".successor-client-promotion" };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--apply") args.apply = true;
    else if (["--pointer", "--source-commit", "--client-release-id", "--site-bucket", "--output-dir"].includes(arg)) args[arg.slice(2).replaceAll("-", "_")] = argv[++i];
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (args.dryRun === args.apply) throw new Error("choose exactly one of --dry-run or --apply");
  for (const name of ["pointer", "source_commit", "client_release_id"]) if (!args[name]) throw new Error(`--${name.replaceAll("_", "-")} is required`);
  if (args.apply && !args.site_bucket) throw new Error("--site-bucket is required with --apply");
  if (args.site_bucket && !/^[A-Za-z0-9.!_-]{3,63}$/u.test(args.site_bucket)) throw new Error("--site-bucket must be an S3 bucket name");
  return args;
}

function exactHttpsOrigin(value, field) {
  if (typeof value !== "string" || !/^https:\/\/[^/*?#]+$/u.test(value)) throw new Error(`${field} must be one exact https origin`);
  return value;
}

export function buildPromotion(pointer, sourceCommit, clientReleaseId) {
  if (!pointer || typeof pointer !== "object" || Array.isArray(pointer)) throw new Error("pointer must be a JSON object");
  if (!COMMIT.test(sourceCommit)) throw new Error("--source-commit must be a 40-character lowercase commit");
  if (!RELEASE_ID.test(clientReleaseId)) throw new Error("--client-release-id is invalid");
  const entry = pointer.launchPage;
  if (typeof entry !== "string" || Object.hasOwn(pointer, "entry")) throw new Error("asset pointer requires raw launchPage and must not use site entry shape");
  const cdn = exactHttpsOrigin(pointer.cdnOrigin ?? pointer.cdn_origin, "asset pointer cdnOrigin");
  const store = exactHttpsOrigin(pointer.storeOrigin ?? pointer.store_origin, "asset pointer storeOrigin");
  const manifestSha256 = pointer.manifestSha256 ?? pointer.manifest_sha256;
  if (!HASH.test(manifestSha256 ?? "")) throw new Error("asset pointer manifestSha256 must be a sha256");
  let parsed;
  try { parsed = new URL(entry); } catch { throw new Error("asset pointer entry must be an absolute URL"); }
  if (parsed.origin !== cdn || parsed.search || parsed.hash) throw new Error("asset pointer entry must exactly use the CDN origin without query or fragment");
  if (parsed.pathname !== `/releases/${manifestSha256}/index.html`) throw new Error("asset pointer entry must be the immutable release index");
  return { schema: "successor.client-runtime-pointer.v1", entry: parsed.href, manifestSha256, sourceCommit, clientReleaseId };
}
export async function promote({ pointerPath, sourceCommit, clientReleaseId, siteBucket, outputDir, apply }) {
  const pointer = JSON.parse(await readFile(resolve(pointerPath), "utf8"));
  const runtimePointer = buildPromotion(pointer, sourceCommit, clientReleaseId);
  const out = resolve(outputDir);
  await mkdir(out, { recursive: true });
  const proof = join(out, "release.json");
  await writeFile(proof, `${JSON.stringify(runtimePointer, null, 2)}\n`);
  const destination = `s3://${siteBucket}/site/current/client/release.json`;
  const plan = { mode: apply ? "apply" : "dry-run", proof, destination, content_type: "application/json", cache_control: "no-store,no-cache,must-revalidate", pointer: runtimePointer };
  if (apply) {
    const proc = spawnSync("aws", ["s3", "cp", proof, destination, "--content-type", "application/json", "--cache-control", "no-store,no-cache,must-revalidate", "--metadata-directive", "REPLACE"], { stdio: "inherit" });
    if (proc.status !== 0) throw new Error("aws upload failed");
  }
  return plan;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  console.log(JSON.stringify(await promote({ pointerPath: args.pointer, sourceCommit: args.source_commit, clientReleaseId: args.client_release_id, siteBucket: args.site_bucket ?? "SITE_BUCKET", outputDir: args.output_dir, apply: args.apply }), null, 2));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((error) => { console.error(`promote-client-runtime: ${error.message}`); process.exit(1); });
