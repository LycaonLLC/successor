#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { FarmError, errorDocument, parseArgs, printJson } from "../verification/farm/common.mjs";
import { canonicalJson, sha256Json } from "../verification/farm/protocol.mjs";

export const SOURCE_SEAL_SCHEMA = "successor.release-source-seal.v1";
export const RELEASE_SEAL_SCHEMA = "successor.release-seal.v1";
export const SOURCE_SEAL_SCHEMA_V2 = "successor.release-source-seal.v2";
export const RELEASE_SEAL_SCHEMA_V2 = "successor.release-seal.v2";
export const RELEASE_INPUT_SCHEMA_V2 = "successor.release-input.v2";
export const STANDALONE_MATRIX_SCHEMA_V1 = "successor.verify-standalone-matrix.v1";
const SHA256 = /^[a-f0-9]{64}$/u;
const COMMIT = /^[a-f0-9]{40}$/u;
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,159}$/u;
const RELEASE_TARGETS = new Set([
  "web/browser/browser",
  "linux/x64/desktop",
  "linux/x64/tui",
  "macos/arm64/desktop",
  "macos/arm64/tui",
]);

export function buildSealRecords(input) {
  if (isV2Input(input)) return buildStandaloneSealRecords(input);
  if (input?.schema && ![SOURCE_SEAL_SCHEMA, RELEASE_SEAL_SCHEMA].includes(input.schema)) {
    throw new FarmError("unsupported seal input schema", { code: "INPUT_SCHEMA_INVALID" });
  }
  const sourceSeal = buildSourceSeal(input);
  const releaseSeal = buildReleaseSeal({
    sourceSeal,
    client: input.client,
    image: input.image,
    verification: input.verification,
  });
  return { sourceSeal, releaseSeal };
}

export function buildStandaloneSealRecords(input) {
  if (input?.schema && ![RELEASE_INPUT_SCHEMA_V2, SOURCE_SEAL_SCHEMA_V2, RELEASE_SEAL_SCHEMA_V2].includes(input.schema)) {
    throw new FarmError("unsupported standalone seal input schema", { code: "INPUT_SCHEMA_INVALID" });
  }
  const sourceSeal = buildStandaloneSourceSeal(input);
  const releaseSeal = buildStandaloneReleaseSeal({
    sourceSeal,
    releaseId: input.releaseId,
    server: input.server,
    image: input.image,
    browser: input.browser,
    client: input.client,
    site: input.site ?? input.sitePublication,
    downloads: input.downloads ?? input.downloadManifest,
    verification: input.verification,
  });
  return { sourceSeal, releaseSeal };
}

export function buildSourceSeal(input) {
  if (isV2Input(input)) return buildStandaloneSourceSeal(input);
  const source = validateSource(input?.source);
  const fixture = validateFixture(input?.fixture);
  const schemas = validateSchemas(input?.schemas);
  const authority = validateAuthority(input?.authority);
  const value = {
    schema: SOURCE_SEAL_SCHEMA,
    source: {
      commit: source.commit,
      tree: source.tree,
      sourceHash: source.sourceHash,
      manifestHash: sha256Json(source.manifest),
      manifestSchema: source.manifest.schema,
    },
    fixture,
    schemas,
    authority,
  };
  return withSealDigest(value);
}

export function buildStandaloneSourceSeal(input) {
  const source = validateStandaloneSource(input?.source);
  const fixture = validateFixture(input?.fixture);
  const schemas = validateSchemas(input?.schemas);
  const controlSchemaHead = validateControlSchemaHead(input?.controlSchemaHead ?? input?.controlSchema ?? input?.controlStoreSchemaHead ?? input?.schemas?.controlSchemaHead ?? input?.schemas?.controlStoreSchemaHead);
  return withSealDigest({
    schema: SOURCE_SEAL_SCHEMA_V2,
    source: {
      commit: source.commit,
      tree: source.tree,
      sourceHash: source.sourceHash,
      manifestHash: source.manifestHash,
      manifestSchema: source.manifest.schema,
    },
    fixture,
    schemas,
    controlSchemaHead,
  });
}

export function buildReleaseSeal({ sourceSeal, client, image, verification, server, browser, site, downloads, releaseId } = {}) {
  if (sourceSeal?.schema === SOURCE_SEAL_SCHEMA_V2) {
    return buildStandaloneReleaseSeal({ sourceSeal, releaseId, server, image, browser, client, site, downloads, verification });
  }
  if (!sourceSeal || sourceSeal.schema !== SOURCE_SEAL_SCHEMA || sourceSeal.sealSha256 !== sha256WithoutDigest(sourceSeal)) {
    throw new FarmError("release seal requires a valid source seal", { code: "SOURCE_SEAL_INVALID" });
  }
  const checkedClient = validateClient(client);
  const checkedImage = validateImage(image);
  const checkedVerification = validateVerification(verification, sourceSeal.source.sourceHash);
  return withSealDigest({
    schema: RELEASE_SEAL_SCHEMA,
    sourceSeal: {
      schema: sourceSeal.schema,
      sealSha256: sourceSeal.sealSha256,
    },
    client: checkedClient,
    image: checkedImage,
    verification: checkedVerification,
  });
}

export function buildStandaloneReleaseSeal({ sourceSeal, releaseId, server, image, browser, client, site, downloads, verification } = {}) {
  if (!sourceSeal || sourceSeal.schema !== SOURCE_SEAL_SCHEMA_V2 || sourceSeal.sealSha256 !== sha256WithoutDigest(sourceSeal)) {
    throw new FarmError("standalone release seal requires a valid v2 source seal", { code: "SOURCE_SEAL_INVALID" });
  }
  const checkedServer = validateStandaloneServer(server ?? { releaseId, image });
  const checkedReleaseId = releaseId ?? checkedServer.releaseId;
  if (checkedServer.releaseId !== checkedReleaseId) throw new FarmError("server release does not match release identity", { code: "RELEASE_SOURCE_MISMATCH" });
  const checkedBrowser = validateBrowser(browser ?? client, checkedReleaseId);
  const checkedSite = validateSite(site, checkedReleaseId);
  const checkedDownloads = validateDownloads(downloads, checkedReleaseId, sourceSeal.source);
  const checkedVerification = validateStandaloneVerification(verification, sourceSeal.source);
  return withSealDigest({
    schema: RELEASE_SEAL_SCHEMA_V2,
    sourceSeal: { schema: sourceSeal.schema, sealSha256: sourceSeal.sealSha256 },
    releaseId: checkedReleaseId,
    server: checkedServer,
    browser: checkedBrowser,
    site: checkedSite,
    downloads: checkedDownloads,
    verification: checkedVerification,
  });
}

export async function writeSealRecords({ records, outDir } = {}) {
  if (!records?.sourceSeal || !records?.releaseSeal) throw new FarmError("seal output requires source and release records", { code: "SEAL_RECORDS_INVALID" });
  const directory = path.resolve(outDir ?? ".successor-release-seal");
  await mkdir(directory, { recursive: true });
  await writeCanonical(path.join(directory, "source-seal.json"), records.sourceSeal);
  await writeCanonical(path.join(directory, "release-seal.json"), records.releaseSeal);
  return {
    outDir: directory,
    sourceSeal: path.join(directory, "source-seal.json"),
    releaseSeal: path.join(directory, "release-seal.json"),
  };
}

function isV2Input(value) {
  if (!value || typeof value !== "object") return false;
  if (value.schema) return [RELEASE_INPUT_SCHEMA_V2, SOURCE_SEAL_SCHEMA_V2, RELEASE_SEAL_SCHEMA_V2].includes(value.schema);
  return Boolean(value.controlSchemaHead || value.server || value.browser || value.site || value.downloads || value.downloadManifest);
}

function validateSource(value) {
  if (!value || typeof value !== "object" || !COMMIT.test(value.commit ?? "") || !COMMIT.test(value.tree ?? "") || !SHA256.test(value.sourceHash ?? "")) {
    throw new FarmError("source seal identity is invalid", { code: "SOURCE_IDENTITY_INVALID" });
  }
  const manifest = value.manifest;
  if (!manifest || manifest.schema !== "successor.source-manifest.v1" || manifest.sourceHash !== value.sourceHash || !Array.isArray(manifest.entries) || manifest.fileCount !== manifest.entries.length || !Number.isSafeInteger(manifest.totalBytes) || manifest.totalBytes < 0) {
    throw new FarmError("source seal manifest is invalid or not bound to sourceHash", { code: "SOURCE_MANIFEST_INVALID" });
  }
  return { commit: value.commit, tree: value.tree, sourceHash: value.sourceHash, manifest };
}

function validateStandaloneSource(value) {
  if (!value || typeof value !== "object" || !COMMIT.test(value.commit ?? "") || !COMMIT.test(value.tree ?? "") || !SHA256.test(value.sourceHash ?? "")) {
    throw new FarmError("standalone source identity is invalid", { code: "SOURCE_IDENTITY_INVALID" });
  }
  const manifest = value.manifest;
  if (!manifest || typeof manifest !== "object" || !["successor.source-manifest.v1", "successor.source-manifest.v2"].includes(manifest.schema) || manifest.sourceHash !== value.sourceHash || !Array.isArray(manifest.entries) || manifest.fileCount !== manifest.entries.length || !Number.isSafeInteger(manifest.totalBytes) || manifest.totalBytes < 0) {
    throw new FarmError("standalone source manifest is invalid", { code: "SOURCE_MANIFEST_INVALID" });
  }
  validateFileRecords(manifest.entries, "source manifest entries");
  if (manifest.entries.reduce((sum, entry) => sum + entry.size, 0) !== manifest.totalBytes) throw new FarmError("source manifest totalBytes drift", { code: "SOURCE_MANIFEST_INVALID" });
  const manifestHash = value.manifestHash ?? value.manifestSha256 ?? manifest.manifestHash ?? manifest.manifestSha256;
  if (!SHA256.test(manifestHash ?? "") || manifestHash !== digestWithoutFields(manifest, ["manifestHash", "manifestSha256"])) throw new FarmError("source manifest internal digest mismatch", { code: "SOURCE_MANIFEST_DIGEST_MISMATCH" });
  return { commit: value.commit, tree: value.tree, sourceHash: value.sourceHash, manifest, manifestHash };
}

function validateFixture(value) {
  if (!value || typeof value !== "object" || typeof value.identity !== "string" || value.identity.length === 0 || !SHA256.test(value.sliceHash ?? "") || !SHA256.test(value.mapBundleHash ?? "")) {
    throw new FarmError("fixture identity and hashes are required", { code: "FIXTURE_IDENTITY_INVALID" });
  }
  return { identity: value.identity, sliceHash: value.sliceHash, mapBundleHash: value.mapBundleHash };
}

function validateSchemas(value) {
  if (!value || typeof value !== "object" || typeof value.wire !== "string" || value.wire.length === 0 || typeof value.save !== "string" || value.save.length === 0) {
    throw new FarmError("wire and save schema versions are required", { code: "SCHEMA_IDENTITY_INVALID" });
  }
  return { wire: value.wire, save: value.save };
}

function validateControlSchemaHead(value) {
  if (!value || typeof value !== "object" || !Number.isSafeInteger(value.version) || value.version < 1 || typeof value.name !== "string" || value.name.length === 0 || !SHA256.test(value.checksum ?? "")) {
    throw new FarmError("standalone control schema head is invalid", { code: "CONTROL_SCHEMA_HEAD_INVALID" });
  }
  if (value.version !== 2 || value.name !== "alpha-control-bug-reports-v2" || value.checksum !== "b42f94dbcc2939109e5fcbb28069ddc215bb2eb8873df522b704aee701994c73") throw new FarmError("standalone control schema head is not the current AlphaControlStore head", { code: "CONTROL_SCHEMA_HEAD_INVALID" });
  return { version: value.version, name: value.name, checksum: value.checksum };
}

function validateAuthority(value) {
  if (!value || typeof value !== "object" || typeof value.generation !== "string" || value.generation.length === 0 || typeof value.compatibility !== "string" || value.compatibility.length === 0 || !SHA256.test(value.checkpointHash ?? "") || !SHA256.test(value.journalHash ?? "")) {
    throw new FarmError("authority generation and checkpoint/journal compatibility are required", { code: "AUTHORITY_IDENTITY_INVALID" });
  }
  return { generation: value.generation, compatibility: value.compatibility, checkpointHash: value.checkpointHash, journalHash: value.journalHash };
}

function validateClient(value) {
  if (!value || typeof value !== "object" || typeof value.releaseId !== "string" || value.releaseId.length === 0 || !SHA256.test(value.manifestSha256 ?? "")) {
    throw new FarmError("client release and asset manifest identity are required", { code: "CLIENT_RELEASE_INVALID" });
  }
  const manifest = value.manifest;
  if (!manifest || manifest.schema !== "successor-client-assets.v1" || manifest.release_id !== value.releaseId || manifest.manifest_sha256 !== value.manifestSha256 || !Array.isArray(manifest.files)) {
    throw new FarmError("client asset manifest is invalid or not bound to its release", { code: "CLIENT_MANIFEST_INVALID" });
  }
  return { releaseId: value.releaseId, manifestSha256: value.manifestSha256, manifestHash: sha256Json(manifest) };
}

function validateStandaloneServer(value) {
  if (!value || typeof value !== "object" || typeof value.releaseId !== "string" || !ID.test(value.releaseId)) throw new FarmError("server release identity is required", { code: "SERVER_RELEASE_INVALID" });
  const image = value.image ?? { ref: value.ref ?? value.imageRef, digest: value.digest ?? value.imageDigest };
  const checkedImage = validateImage(image);
  return { releaseId: value.releaseId, image: checkedImage };
}

function validateImage(value) {
  if (!value || typeof value !== "object" || typeof value.ref !== "string") throw new FarmError("immutable image reference is required", { code: "IMAGE_IDENTITY_INVALID" });
  const match = value.ref.match(/^([^?\s]+)@sha256:([a-f0-9]{64})$/u);
  if (!match || value.digest !== match[2] || /:(?:latest|stable|current|staging|dev|nightly)$/u.test(match[1])) throw new FarmError("image reference and digest must be immutable and equal", { code: "IMAGE_DIGEST_INVALID" });
  return { ref: value.ref, digest: match[2] };
}

function validateBrowser(value, releaseId) {
  if (!value || typeof value !== "object" || value.releaseId !== releaseId) throw new FarmError("browser release does not match release identity", { code: "RELEASE_SOURCE_MISMATCH" });
  const manifest = value.manifest;
  if (!manifest || typeof manifest !== "object" || !Array.isArray(manifest.files) || !ID.test(String(manifest.schema ?? ""))) throw new FarmError("browser client manifest is invalid", { code: "CLIENT_MANIFEST_INVALID" });
  const manifestSha256 = value.manifestSha256 ?? value.manifestDigest ?? manifest.manifestSha256 ?? manifest.manifest_sha256;
  if (!SHA256.test(manifestSha256 ?? "") || manifestSha256 !== digestWithoutFields(manifest, ["manifestSha256", "manifest_sha256", "manifestDigest"])) throw new FarmError("browser client manifest digest mismatch", { code: "CLIENT_MANIFEST_DIGEST_MISMATCH" });
  validateFileRecords(manifest.files, "browser client manifest files");
  return { releaseId, manifestSchema: manifest.schema, manifestSha256, manifestHash: sha256Json(manifest) };
}

function validateSite(value, releaseId) {
  if (!value || typeof value !== "object" || value.releaseId !== releaseId) throw new FarmError("site release does not match release identity", { code: "RELEASE_SOURCE_MISMATCH" });
  const manifest = value.manifest;
  if (!manifest || typeof manifest !== "object" || typeof manifest.schema !== "string") throw new FarmError("standalone site publication manifest is invalid", { code: "SITE_MANIFEST_INVALID" });
  const releaseDigest = value.releaseDigest ?? value.release_digest ?? manifest.releaseDigest ?? manifest.release_digest;
  if (!SHA256.test(releaseDigest ?? "")) throw new FarmError("standalone site release digest is invalid", { code: "SITE_RELEASE_DIGEST_INVALID" });
  const manifestSha256 = value.manifestSha256 ?? value.manifestDigest ?? manifest.manifestSha256 ?? manifest.manifest_sha256;
  if (!SHA256.test(manifestSha256 ?? "") || manifestSha256 !== digestWithoutFields(manifest, ["manifestSha256", "manifest_sha256", "manifestDigest"])) throw new FarmError("site publication manifest digest mismatch", { code: "SITE_MANIFEST_DIGEST_MISMATCH" });
  const manifestReleaseId = manifest.releaseId ?? manifest.release_id;
  if (manifestReleaseId !== releaseId || (manifest.releaseDigest ?? manifest.release_digest) !== releaseDigest) throw new FarmError("site publication is not bound to release", { code: "RELEASE_SOURCE_MISMATCH" });
  return { releaseId, manifestSchema: manifest.schema, manifestSha256, releaseDigest, manifestHash: sha256Json(manifest) };
}

function validateDownloads(value, releaseId, source) {
  const manifest = value?.manifest && typeof value.manifest === "object" ? value.manifest : value;
  if (!manifest || typeof manifest !== "object" || !Array.isArray(manifest.rows ?? manifest.targets)) throw new FarmError("download manifest is invalid", { code: "DOWNLOAD_MANIFEST_INVALID" });
  const rows = manifest.rows ?? manifest.targets;
  const manifestReleaseId = manifest.releaseId ?? manifest.release_id;
  if (manifestReleaseId !== releaseId || typeof manifest.version !== "string" || manifest.version.length === 0) throw new FarmError("download manifest release identity is invalid", { code: "RELEASE_SOURCE_MISMATCH" });
  const seen = new Set();
  const checked = rows.map((row) => validateDownloadRow(row, releaseId, manifest.version, source, seen));
  if (checked.length !== RELEASE_TARGETS.size || seen.size !== RELEASE_TARGETS.size) throw new FarmError("download manifest must contain exactly the five standalone targets", { code: "TARGET_SET_INVALID" });
  for (const target of RELEASE_TARGETS) if (!seen.has(target)) throw new FarmError(`download manifest is missing target ${target}`, { code: "TARGET_SET_INVALID" });
  const manifestSha256 = value?.manifestSha256 ?? value?.manifestDigest ?? manifest.manifestSha256 ?? manifest.manifest_sha256;
  if (!SHA256.test(manifestSha256 ?? "") || manifestSha256 !== digestWithoutFields(manifest, ["manifestSha256", "manifest_sha256", "manifestDigest"])) throw new FarmError("download manifest digest mismatch", { code: "DOWNLOAD_MANIFEST_DIGEST_MISMATCH" });
  return { schema: manifest.schema ?? "successor.standalone-download-manifest.v1", releaseId, version: manifest.version, manifestSha256, manifestHash: sha256Json(manifest), rows: checked.sort((a, b) => targetKey(a).localeCompare(targetKey(b))) };
}

function validateDownloadRow(row, releaseId, version, source, seen) {
  if (!row || typeof row !== "object") throw new FarmError("download target row is invalid", { code: "TARGET_ROW_INVALID" });
  const platform = row.platform === "darwin" ? "macos" : row.platform === "browser" ? "web" : row.platform;
  const arch = row.arch === "web" ? "browser" : row.arch;
  const key = `${platform}/${arch}/${row.client}`;
  if (!RELEASE_TARGETS.has(key)) throw new FarmError(`unsupported or extra standalone target ${key}`, { code: "TARGET_SET_INVALID" });
  if (seen.has(key)) throw new FarmError(`duplicate standalone target ${key}`, { code: "TARGET_DUPLICATE" });
  seen.add(key);
  if (row.releaseId !== undefined && row.releaseId !== releaseId) throw new FarmError("download target release mismatch", { code: "RELEASE_SOURCE_MISMATCH" });
  if (row.version !== version) throw new FarmError("download target version mismatch", { code: "TARGET_ROW_INVALID" });
  if (!Number.isSafeInteger(row.bytes) || row.bytes < 0 || !SHA256.test(row.sha256 ?? "") || !COMMIT.test(row.sourceCommit ?? "")) throw new FarmError("download target checksum or source identity is invalid", { code: "TARGET_CHECKSUM_INVALID" });
  if (row.sourceCommit !== source.commit) throw new FarmError("download target source commit mismatch", { code: "SOURCE_RELEASE_MISMATCH" });
  if (row.publishable !== true || row.unavailable === true) throw new FarmError("final standalone release cannot contain unavailable or unpublished targets", { code: "TARGET_UNPUBLISHABLE" });
  validateImmutableUrl(row.url);
  validateProof(row.proof, row, source);
  return { platform, arch, client: row.client, version, bytes: row.bytes, sha256: row.sha256, url: row.url, publishable: true, proof: normalizeProof(row.proof, row, source), sourceCommit: source.commit };
}

function validateProof(proof, row, source) {
  if (!proof || typeof proof !== "object" || proof === true || proof === false) throw new FarmError("download target proof is missing", { code: "TARGET_PROOF_INVALID" });
  const statusPass = proof.status === "pass" || proof.result === "pass" || proof.verified === true;
  const digest = proof.sha256 ?? proof.artifactSha256 ?? proof.digest ?? proof.artifact?.sha256;
  const bytes = proof.bytes ?? proof.artifactBytes ?? proof.artifact?.bytes;
  const sourceCommit = proof.sourceCommit ?? proof.commit ?? proof.artifact?.sourceCommit ?? proof.artifact?.source?.commit;
  if (!statusPass || digest !== row.sha256 || bytes !== row.bytes || sourceCommit !== source.commit) throw new FarmError("download target proof does not prove its exact artifact", { code: "TARGET_PROOF_INVALID" });
}

function normalizeProof(proof, row, source) {
  return { schema: proof.schema ?? "successor.artifact-proof.v1", status: "pass", bytes: row.bytes, sha256: row.sha256, sourceCommit: source.commit };
}

function validateStandaloneVerification(value, source) {
  const matrix = value?.matrix ?? value;
  if (!matrix || typeof matrix !== "object" || matrix.schema !== STANDALONE_MATRIX_SCHEMA_V1 || matrix.status !== "pass" || typeof matrix.runId !== "string" || matrix.runId.length === 0) throw new FarmError("verification must be a passing standalone matrix", { code: "VERIFICATION_INVALID" });
  const identity = matrix.source ?? { commit: matrix.sourceCommit, tree: matrix.sourceTree, sourceHash: matrix.sourceHash };
  if (!identity || identity.commit !== source.commit || identity.tree !== source.tree || identity.sourceHash !== source.sourceHash) throw new FarmError("standalone verification source identity mismatch", { code: "VERIFICATION_SOURCE_MISMATCH" });
  if (!Array.isArray(matrix.tasks) || matrix.tasks.length === 0) throw new FarmError("standalone verification tasks are required", { code: "VERIFICATION_INVALID" });
  const tasks = matrix.tasks.map((task) => validateVerificationTask(task, source));
  const artifactIdentity = sha256Json(tasks.map((task) => ({ id: task.id, digest: task.digest, artifacts: task.artifacts })).sort((left, right) => Buffer.compare(Buffer.from(left.id), Buffer.from(right.id))));
  if (value?.artifactIdentity !== undefined && value.artifactIdentity !== artifactIdentity) throw new FarmError("verification artifact identity mismatch", { code: "VERIFICATION_ARTIFACT_MISMATCH" });
  const matrixSha256 = sha256Json(matrix);
  if (value?.matrixSha256 !== undefined && value.matrixSha256 !== matrixSha256) throw new FarmError("verification matrix digest mismatch", { code: "VERIFICATION_DIGEST_MISMATCH" });
  return { schema: matrix.schema, runId: matrix.runId, matrixSha256, artifactIdentity, source: { commit: source.commit, tree: source.tree, sourceHash: source.sourceHash } };
}

function validateVerificationTask(task, source) {
  if (!task || typeof task !== "object" || typeof task.id !== "string" || task.id.length === 0 || !SHA256.test(task.digest ?? "") || !Array.isArray(task.artifacts) || task.status !== undefined && task.status !== "pass" || task.gateStatus !== undefined && task.gateStatus !== "pass") throw new FarmError("standalone verification task identity is invalid", { code: "VERIFICATION_INVALID" });
  if (task.sourceCommit !== undefined && task.sourceCommit !== source.commit || task.sourceTree !== undefined && task.sourceTree !== source.tree || task.sourceHash !== undefined && task.sourceHash !== source.sourceHash) throw new FarmError("verification task source mismatch", { code: "VERIFICATION_SOURCE_MISMATCH" });
  const artifacts = task.artifacts.map((artifact) => {
    const bytes = artifact.bytes ?? artifact.size;
    if (!artifact || typeof artifact !== "object" || typeof artifact.path !== "string" || !Number.isSafeInteger(bytes) || bytes < 0 || !SHA256.test(artifact.sha256 ?? "")) throw new FarmError("verification artifact identity is invalid", { code: "VERIFICATION_INVALID" });
    return { path: artifact.path, bytes, sha256: artifact.sha256 };
  });
  return { id: task.id, digest: task.digest, artifacts };
}

function validateFileRecords(records, label) {
  const paths = new Set();
  for (const record of records) {
    if (!record || typeof record !== "object" || typeof record.path !== "string" || record.path.length === 0 || record.path.startsWith("/") || record.path.includes("..") || paths.has(record.path) || !Number.isSafeInteger(record.size) || record.size < 0 || !SHA256.test(record.sha256 ?? "")) throw new FarmError(`${label} contain an invalid or duplicate file record`, { code: "MANIFEST_FILE_INVALID" });
    paths.add(record.path);
  }
}

function validateImmutableUrl(value) {
  if (typeof value !== "string" || value.length === 0) throw new FarmError("download URL is required", { code: "DOWNLOAD_URL_INVALID" });
  let parsed;
  try { parsed = new URL(value); } catch { throw new FarmError("download URL is invalid", { code: "DOWNLOAD_URL_INVALID" }); }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash || /(?:^|\/)(?:latest|stable|current|staging|nightly|dev)(?:\/|\.|$)/iu.test(parsed.pathname)) throw new FarmError("download URL must be immutable and credential/query free", { code: "DOWNLOAD_URL_INVALID" });
}

function targetKey(row) { return `${row.platform}/${row.arch}/${row.client}`; }
function digestWithoutFields(value, fields) {
  const ignored = new Set(fields);
  return sha256Json(Object.fromEntries(Object.entries(value).filter(([key]) => !ignored.has(key))));
}
function withSealDigest(value) { return { ...value, sealSha256: sha256WithoutDigest(value) }; }
function sha256WithoutDigest(value) {
  const { sealSha256: ignored, ...unsigned } = value;
  return createHash("sha256").update(canonicalJson(unsigned)).digest("hex");
}
async function writeCanonical(filePath, value) { await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8"); }

let cliSchema = RELEASE_SEAL_SCHEMA;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { process.stdout.write("usage: seal.mjs --input INPUT.json --out-dir DIR\n"); return; }
  if (!args.input) throw new FarmError("seal requires --input INPUT.json", { code: "USAGE" });
  const input = JSON.parse(await readFile(path.resolve(String(args.input)), "utf8"));
  cliSchema = isV2Input(input) ? RELEASE_SEAL_SCHEMA_V2 : RELEASE_SEAL_SCHEMA;
  const records = buildSealRecords(input);
  if (args["out-dir"]) await writeSealRecords({ records, outDir: String(args["out-dir"]) });
  printJson(records, Boolean(args.pretty));
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main().catch((error) => { printJson(errorDocument(cliSchema, error), true); process.exitCode = 1; });
function validateVerification(value, sourceHash) {
  if (!value || typeof value !== "object" || !value.matrix || value.matrix.schema !== "successor.verify-matrix.v1" || value.matrix.status !== "pass" || value.matrix.sourceHash !== sourceHash || typeof value.matrix.runId !== "string" || value.matrix.runId.length === 0) {
    throw new FarmError("verification must be a passing source-bound matrix", { code: "VERIFICATION_INVALID" });
  }
  const matrixSha256 = sha256Json(value.matrix);
  if (value.matrixSha256 !== undefined && value.matrixSha256 !== matrixSha256) throw new FarmError("verification matrix digest mismatch", { code: "VERIFICATION_DIGEST_MISMATCH" });
  const artifactIdentity = sha256Json((value.matrix.tasks ?? []).map((task) => ({ id: task.id, digest: task.digest, artifacts: task.artifacts })).sort((left, right) => Buffer.compare(Buffer.from(left.id), Buffer.from(right.id))));
  if (value.artifactIdentity !== undefined && value.artifactIdentity !== artifactIdentity) throw new FarmError("verification artifact identity mismatch", { code: "VERIFICATION_ARTIFACT_MISMATCH" });
  return { schema: value.matrix.schema, runId: value.matrix.runId, matrixSha256, artifactIdentity };
}
