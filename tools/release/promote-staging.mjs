#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { FarmError, errorDocument, parseArgs, printJson } from "../verification/farm/common.mjs";
import { canonicalJson, sha256Json } from "../verification/farm/protocol.mjs";
import { RELEASE_SEAL_SCHEMA } from "./seal.mjs";

export const STAGING_PROMOTION_SCHEMA = "successor.staging-promotion.v1";
const SHA256 = /^[a-f0-9]{64}$/u;

export function buildStagingPromotion({ releaseSeal, testedImageRef, candidateImageRef, testedClientManifestSha256, candidateClientManifestSha256, rebuild = false } = {}) {
  validateReleaseSeal(releaseSeal);
  if (rebuild === true) throw new FarmError("staging promotion refuses rebuilds; promote the tested immutable digest", { code: "REBUILD_FORBIDDEN" });
  if (typeof testedImageRef !== "string" || typeof candidateImageRef !== "string") throw new FarmError("tested and candidate image references are required", { code: "IMAGE_REF_REQUIRED" });
  const tested = parseDigestRef(testedImageRef);
  const candidate = parseDigestRef(candidateImageRef);
  if (testedImageRef !== releaseSeal.image.ref || tested.digest !== releaseSeal.image.digest) throw new FarmError("tested image is not the image sealed by verification", { code: "TESTED_IMAGE_MISMATCH" });
  if (candidateImageRef !== testedImageRef || candidate.digest !== tested.digest) throw new FarmError("staging candidate must use the exact tested immutable image digest", { code: "IMAGE_DIGEST_MISMATCH" });
  if (testedClientManifestSha256 !== releaseSeal.client.manifestSha256 || candidateClientManifestSha256 !== testedClientManifestSha256) throw new FarmError("staging candidate must use the exact tested client manifest digest", { code: "CLIENT_MANIFEST_MISMATCH" });
  const unsigned = {
    schema: STAGING_PROMOTION_SCHEMA,
    releaseSealSha256: releaseSeal.sealSha256,
    image: { ref: candidateImageRef, digest: candidate.digest },
    client: { manifestSha256: candidateClientManifestSha256 },
    rebuild: false,
  };
  return { ...unsigned, promotionSha256: sha256Json(unsigned) };
}

export function parseDigestRef(value) {
  const match = value.match(/^(.+)@sha256:([a-f0-9]{64})$/u);
  if (!match) throw new FarmError("image reference must be digest pinned as IMAGE@sha256:DIGEST", { code: "IMAGE_NOT_DIGEST_PINNED" });
  return { ref: value, repository: match[1], digest: match[2] };
}

function validateReleaseSeal(value) {
  if (!value || value.schema !== RELEASE_SEAL_SCHEMA || typeof value.sealSha256 !== "string" || !SHA256.test(value.sealSha256) || !value.image || !value.client) throw new FarmError("release seal is invalid", { code: "RELEASE_SEAL_INVALID" });
  const { sealSha256: ignored, ...unsigned } = value;
  if (sha256Json(unsigned) !== value.sealSha256 || typeof value.image.ref !== "string" || !SHA256.test(value.image.digest ?? "") || typeof value.client.manifestSha256 !== "string" || !SHA256.test(value.client.manifestSha256)) throw new FarmError("release seal content or identity is invalid", { code: "RELEASE_SEAL_INVALID" });
}

export async function writePromotionRecord(filePath, record) {
  await writeFile(path.resolve(filePath), `${JSON.stringify(record, null, 2)}\n`, "utf8");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write("usage: promote-staging.mjs --seal RELEASE-SEAL.json --tested-image IMAGE@sha256:DIGEST --candidate-image IMAGE@sha256:DIGEST --tested-client-manifest SHA256 --candidate-client-manifest SHA256 [--out RECORD.json]\n");
    return;
  }
  const required = ["seal", "tested-image", "candidate-image", "tested-client-manifest", "candidate-client-manifest"];
  for (const name of required) if (!args[name]) throw new FarmError(`promotion requires --${name}`, { code: "USAGE" });
  const releaseSeal = JSON.parse(await readFile(path.resolve(String(args.seal)), "utf8"));
  const record = buildStagingPromotion({ releaseSeal, testedImageRef: String(args["tested-image"]), candidateImageRef: String(args["candidate-image"]), testedClientManifestSha256: String(args["tested-client-manifest"]), candidateClientManifestSha256: String(args["candidate-client-manifest"]), rebuild: Boolean(args.rebuild) });
  if (args.out) await writePromotionRecord(String(args.out), record);
  printJson(record, Boolean(args.pretty));
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main().catch((error) => { printJson(errorDocument(STAGING_PROMOTION_SCHEMA, error), true); process.exitCode = 1; });
