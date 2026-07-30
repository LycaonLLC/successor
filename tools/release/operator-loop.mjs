#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { FarmError, errorDocument, parseArgs, printJson } from "../verification/farm/common.mjs";
import { canonicalJson, sha256Json } from "../verification/farm/protocol.mjs";

export const OPERATOR_LOOP_SCHEMA = "successor.operator-loop.v1";
export const TELEMETRY_REVIEW_SCHEMA = "successor.post-session-review.v1";
export const RESTORE_REHEARSAL_SCHEMA = "successor.restore-rehearsal.v1";
export const RETENTION_POLICY_SCHEMA = "successor.backup-retention-policy.v1";
export const ROLLBACK_DECISION_SCHEMA = "successor.rollback-decision.v1";
const SHA256 = /^[a-f0-9]{64}$/u;
const DIGEST_REF = /^.+@sha256:([a-f0-9]{64})$/u;

export function validateRetentionPolicy(value) {
  if (!value || value.schema !== RETENTION_POLICY_SCHEMA) throw operatorError("backup retention policy schema is required", "RETENTION_POLICY_MISSING");
  if (value.enabled !== true) throw operatorError("backup retention must be enabled", "RETENTION_POLICY_DISABLED");
  if (!Number.isSafeInteger(value.keepRecent) || value.keepRecent < 2) throw operatorError("retention must keep at least two recent backups", "RETENTION_POLICY_UNSAFE");
  if (!Number.isSafeInteger(value.keepFailedGenerations) || value.keepFailedGenerations < 1) throw operatorError("retention must keep a failed-generation history", "RETENTION_POLICY_UNSAFE");
  if (!Number.isSafeInteger(value.maxAgeDays) || value.maxAgeDays < 7 || value.maxAgeDays > 3650) throw operatorError("retention maxAgeDays is outside the safe range", "RETENTION_POLICY_UNSAFE");
  if (!Number.isSafeInteger(value.intervalMinutes) || value.intervalMinutes < 1 || value.intervalMinutes > value.maxAgeDays * 24 * 60) throw operatorError("backup interval is outside the retention window", "RETENTION_POLICY_UNSAFE");
  if (typeof value.archivePrefix !== "string" || value.archivePrefix.length === 0 || value.archivePrefix.startsWith("/")) throw operatorError("retention archive prefix is required", "RETENTION_POLICY_UNSAFE");
  return {
    schema: RETENTION_POLICY_SCHEMA,
    enabled: true,
    keepRecent: value.keepRecent,
    keepFailedGenerations: value.keepFailedGenerations,
    maxAgeDays: value.maxAgeDays,
    intervalMinutes: value.intervalMinutes,
    archivePrefix: value.archivePrefix,
  };
}

export function buildRetentionPolicy(value) {
  const policy = validateRetentionPolicy(value);
  return { ...policy, policySha256: sha256Unsigned(policy) };
}

export function buildRollbackDecision({ current, target, requestedImageRef, restoreArchive = null } = {}) {
  validateGeneration(current, "current generation");
  validateGeneration(target, "rollback target generation");
  const requested = parseDigestRef(requestedImageRef);
  if (requested.digest !== target.imageDigest) throw operatorError("rollback image digest does not match the sealed target", "ROLLBACK_DIGEST_MISMATCH");
  if (current.generation !== target.expectedCurrentGeneration) throw operatorError("rollback refuses an incompatible state generation; restore the matching backup first", "ROLLBACK_GENERATION_MISMATCH");
  if (current.compatibility !== target.compatibility) throw operatorError("rollback refuses an incompatible save/journal generation", "ROLLBACK_COMPATIBILITY_MISMATCH");
  if (target.restoreRequired === true && (!restoreArchive || typeof restoreArchive !== "string")) throw operatorError("incompatible rollback requires an explicit isolated restore archive", "ROLLBACK_RESTORE_REQUIRED");
  const unsigned = {
    schema: ROLLBACK_DECISION_SCHEMA,
    action: target.restoreRequired === true ? "restore-then-rollback" : "rollback",
    currentGeneration: current.generation,
    targetGeneration: target.generation,
    compatibility: target.compatibility,
    image: { ref: requested.ref, digest: requested.digest },
    restoreArchive: restoreArchive ?? null,
  };
  return { ...unsigned, decisionSha256: sha256Unsigned(unsigned) };
}

export function buildTelemetryReviewRecord({ release, session, metrics, logs, journal, reviewedAt = "" } = {}) {
  validateIdentity(release, "release");
  if (!session || typeof session.id !== "string" || session.id.length === 0 || typeof session.startedAt !== "string" || typeof session.endedAt !== "string") throw operatorError("session identity and bounds are required", "SESSION_EVIDENCE_INVALID");
  const evidence = { metrics: normalizeEvidence(metrics, "metrics"), logs: normalizeEvidence(logs, "logs"), journal: normalizeEvidence(journal, "journal") };
  if (Object.values(evidence).every((items) => items.length === 0)) throw operatorError("post-session review needs metrics, logs, or journal evidence", "SESSION_EVIDENCE_MISSING");
  const unsigned = {
    schema: TELEMETRY_REVIEW_SCHEMA,
    release: { sealSha256: release.sealSha256, imageDigest: release.imageDigest, clientManifestSha256: release.clientManifestSha256 },
    session: { id: session.id, startedAt: session.startedAt, endedAt: session.endedAt, outcome: session.outcome ?? "unreviewed" },
    evidence,
    reviewedAt: reviewedAt || new Date().toISOString(),
  };
  return { ...unsigned, reviewSha256: sha256Unsigned(unsigned) };
}

export function buildRestoreRehearsalPlan({ archive, liveStateDir, isolatedTargetDir, writerAccess = false, release = null } = {}) {
  if (typeof archive !== "string" || archive.length === 0) throw operatorError("restore rehearsal archive is required", "REHEARSAL_ARCHIVE_MISSING");
  if (typeof liveStateDir !== "string" || liveStateDir.length === 0 || typeof isolatedTargetDir !== "string" || isolatedTargetDir.length === 0) throw operatorError("live and isolated target paths are required", "REHEARSAL_PATH_INVALID");
  if (writerAccess === true) throw operatorError("restore rehearsal refuses live writer access", "REHEARSAL_WRITER_ACCESS");
  const live = path.resolve(liveStateDir);
  const target = path.resolve(isolatedTargetDir);
  if (live === target || target.startsWith(`${live}${path.sep}`) || live.startsWith(`${target}${path.sep}`)) throw operatorError("restore rehearsal target must be isolated from live state", "REHEARSAL_TARGET_NOT_ISOLATED");
  if (release !== null) validateIdentity(release, "release");
  const unsigned = {
    schema: RESTORE_REHEARSAL_SCHEMA,
    mode: "isolated-read-only",
    archive: path.resolve(archive),
    liveStateDir: live,
    isolatedTargetDir: target,
    writerAccess: false,
    release: release ? { sealSha256: release.sealSha256, imageDigest: release.imageDigest } : null,
  };
  return { ...unsigned, planSha256: sha256Unsigned(unsigned) };
}

function validateGeneration(value, label) {
  if (!value || typeof value !== "object" || typeof value.generation !== "string" || value.generation.length === 0 || typeof value.compatibility !== "string" || value.compatibility.length === 0 || !SHA256.test(value.imageDigest ?? "")) throw operatorError(`${label} is missing generation, compatibility, or image digest`, "GENERATION_IDENTITY_INVALID");
}

function validateIdentity(value, label) {
  if (!value || typeof value !== "object" || !SHA256.test(value.sealSha256 ?? "") || !SHA256.test(value.imageDigest ?? "") || !SHA256.test(value.clientManifestSha256 ?? "")) throw operatorError(`${label} identity is incomplete`, "RELEASE_IDENTITY_INVALID");
}

function parseDigestRef(value) {
  if (typeof value !== "string") throw operatorError("digest-pinned image reference is required", "IMAGE_NOT_DIGEST_PINNED");
  const match = value.match(DIGEST_REF);
  if (!match) throw operatorError("image reference must be digest pinned", "IMAGE_NOT_DIGEST_PINNED");
  return { ref: value, digest: match[1] };
}

function normalizeEvidence(value, kind) {
  if (!Array.isArray(value)) throw operatorError(`${kind} evidence must be an array`, "SESSION_EVIDENCE_INVALID");
  return value.map((item) => {
    if (!item || typeof item !== "object" || typeof item.path !== "string" || item.path.length === 0 || !SHA256.test(item.sha256 ?? "")) throw operatorError(`${kind} evidence requires path and sha256`, "SESSION_EVIDENCE_INVALID");
    return { path: item.path, sha256: item.sha256, ...(item.bytes === undefined ? {} : { bytes: item.bytes }) };
  }).sort((left, right) => Buffer.compare(Buffer.from(`${left.path}\0${left.sha256}`), Buffer.from(`${right.path}\0${right.sha256}`)));
}

function operatorError(message, code) {
  return new FarmError(message, { code });
}

function sha256Unsigned(value) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write("usage: operator-loop.mjs --kind retention|rollback|telemetry|rehearsal --input INPUT.json [--out FILE] [--pretty]\n");
    return;
  }
  if (!args.input || !args.kind) throw operatorError("--kind and --input are required", "USAGE");
  const input = JSON.parse(await readFile(path.resolve(String(args.input)), "utf8"));
  const result = args.kind === "retention" ? buildRetentionPolicy(input)
    : args.kind === "rollback" ? buildRollbackDecision(input)
      : args.kind === "telemetry" ? buildTelemetryReviewRecord(input)
        : args.kind === "rehearsal" ? buildRestoreRehearsalPlan(input)
          : (() => { throw operatorError(`unsupported operator kind ${args.kind}`, "USAGE"); })();
  if (args.out) await writeFile(path.resolve(String(args.out)), `${JSON.stringify(result, null, 2)}\n`, "utf8");
  printJson(result, Boolean(args.pretty));
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main().catch((error) => { printJson(errorDocument(OPERATOR_LOOP_SCHEMA, error), true); process.exitCode = 1; });
