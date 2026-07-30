import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { FarmError } from "./common.mjs";

export const FARM_RESULT_SCHEMA = "successor.farm-result.v1";
export const FARM_TIMINGS_SCHEMA = "successor.farm-timings.v1";
export const FARM_LEDGER_SCHEMA = "successor.ledger-entry.v1";
export const VERIFY_MATRIX_SCHEMA = "successor.verify-matrix.v1";


/**
 * Stable JSON for hashes and protocol documents. Optional object properties are
 * omitted (the same shape JSON.stringify produces); undefined array slots are
 * canonicalized as null. This keeps plan digests stable without making callers
 * manufacture placeholder values for optional fields.
 */
export function canonicalJson(value) {
  if (value === undefined) return "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).filter((key) => value[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new FarmError("farm protocol value is not JSON encodable", { code: "INVALID_PROTOCOL_VALUE" });
  return encoded;
}

export function sha256Json(value) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export async function readJson(filePath) {
  let text;
  try {
    text = await fs.readFile(filePath, "utf8");
  } catch (cause) {
    throw new FarmError(`could not read JSON document ${filePath}`, { code: "JSON_READ_FAILED", cause });
  }
  try {
    return JSON.parse(text);
  } catch (cause) {
    throw new FarmError(`invalid JSON document ${filePath}`, { code: "INVALID_JSON", cause });
  }
}

export async function writeJsonAtomic(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  await fs.rename(temporary, filePath);
}

export function validateId(value, label = "identifier") {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,159}$/u.test(value)) {
    throw new FarmError(`${label} is invalid`, { code: "INVALID_IDENTIFIER", details: { label } });
  }
  return value;
}

export function safeName(value) {
  validateId(value);
  return value.replaceAll(":", "--").replaceAll("@", "-");
}

export function validateRelativePath(value, label = "relative path") {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0") || value.includes("\\") || path.posix.isAbsolute(value)) {
    throw new FarmError(`${label} is invalid`, { code: "INVALID_ARTIFACT_PATH" });
  }
  const segments = value.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new FarmError(`${label} escapes its root`, { code: "INVALID_ARTIFACT_PATH" });
  }
  return value;
}

export function resolveWithin(root, relativePath) {
  validateRelativePath(relativePath);
  const absoluteRoot = path.resolve(root);
  const resolved = path.resolve(absoluteRoot, ...relativePath.split("/"));
  if (resolved !== absoluteRoot && !resolved.startsWith(`${absoluteRoot}${path.sep}`)) {
    throw new FarmError("path escapes its farm root", { code: "INVALID_ARTIFACT_PATH" });
  }
  return resolved;
}

export async function checksumTree(root, relativeRoots) {
  const files = [];
  for (const relativeRoot of [...new Set(relativeRoots)].sort(byteCompare)) {
    validateRelativePath(relativeRoot);
    await walk(resolveWithin(root, relativeRoot), relativeRoot, files);
  }
  files.sort((left, right) => byteCompare(left.path, right.path));
  return files;
}

async function walk(absolutePath, relativePath, output) {
  let stats;
  try {
    stats = await fs.lstat(absolutePath);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  if (stats.isSymbolicLink()) {
    throw new FarmError(`artifact ${relativePath} is a symlink`, { code: "UNSAFE_ARTIFACT" });
  }
  if (stats.isFile()) {
    const bytes = await fs.readFile(absolutePath);
    output.push({ path: relativePath.split(path.sep).join("/"), size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
    return;
  }
  if (!stats.isDirectory()) throw new FarmError(`artifact ${relativePath} is not a regular file`, { code: "UNSAFE_ARTIFACT" });
  const entries = await fs.readdir(absolutePath, { withFileTypes: true });
  entries.sort((left, right) => byteCompare(left.name, right.name));
  for (const entry of entries) await walk(path.join(absolutePath, entry.name), path.posix.join(relativePath, entry.name), output);
}

export async function verifyArtifactChecksums(root, artifacts) {
  if (!Array.isArray(artifacts)) throw new FarmError("result artifacts must be an array", { code: "INVALID_RESULT" });
  const failures = [];
  for (const artifact of artifacts) {
    try {
      validateRelativePath(artifact?.path, "artifact path");
      if (!/^[a-f0-9]{64}$/u.test(artifact?.sha256 ?? "") || !Number.isSafeInteger(artifact?.size) || artifact.size < 0) {
        throw new Error("invalid checksum record");
      }
      const bytes = await fs.readFile(resolveWithin(root, artifact.path));
      const actual = createHash("sha256").update(bytes).digest("hex");
      if (actual !== artifact.sha256 || bytes.length !== artifact.size) failures.push({ path: artifact.path, expected: artifact.sha256, actual, expectedSize: artifact.size, actualSize: bytes.length });
    } catch (error) {
      failures.push({ path: artifact?.path ?? null, error: error?.code ?? error?.message ?? String(error) });
    }
  }
  return { ok: failures.length === 0, failures };
}

export function validateResultEnvelope(result, { plan, executionAttempt } = {}) {
  if (!result || result.schema !== FARM_RESULT_SCHEMA) throw new FarmError("unsupported farm result schema", { code: "INVALID_RESULT" });
  validateId(result.runId, "result runId");
  validateId(result.leaseId, "result leaseId");
  if (!result.host || typeof result.host !== "object") throw new FarmError("result host provenance is missing", { code: "INVALID_RESULT" });
  validateId(result.host.id, "result host id");
  if (!/^[a-f0-9]{64}$/u.test(result.sourceHash ?? "")) throw new FarmError("result sourceHash is invalid", { code: "INVALID_RESULT" });
  if (!["pass", "fail", "refused", "killed"].includes(result.status)) throw new FarmError("result status is invalid", { code: "INVALID_RESULT" });
  if (!result.task || typeof result.task !== "object") throw new FarmError("result task is missing", { code: "INVALID_RESULT" });
  validateId(result.task.id, "result task id");
  if (!/^[a-f0-9]{64}$/u.test(result.task.digest ?? "")) throw new FarmError("result task digest is invalid", { code: "INVALID_RESULT" });
  if (!Number.isInteger(result.executionAttempt) || result.executionAttempt < 0) throw new FarmError("result execution attempt is invalid", { code: "INVALID_RESULT" });
  if (executionAttempt !== undefined && result.executionAttempt !== executionAttempt) throw new FarmError("result execution attempt does not match dispatch", { code: "RESULT_BINDING_MISMATCH" });
  if (!Number.isFinite(result.durationMs) || result.durationMs < 0) throw new FarmError("result duration is invalid", { code: "INVALID_RESULT" });
  if (!Array.isArray(result.artifacts) || !Array.isArray(result.ledgerEntries)) throw new FarmError("result arrays are invalid", { code: "INVALID_RESULT" });
  validateArtifactRecords(result.artifacts, "result artifacts");
  if (result.command && result.command.started !== false && result.status !== "pass" && result.artifacts.length === 0) {
    throw new FarmError("a started non-passing command must retain checksummed artifacts", { code: "EMPTY_COMMAND_ARTIFACTS" });
  }
  if (plan) {
    if (result.runId !== plan.runId || result.leaseId !== plan.leaseId || result.host.id !== plan.host.id || result.sourceHash !== plan.source.sourceHash) {
      throw new FarmError("result is not bound to its worker plan", { code: "RESULT_BINDING_MISMATCH" });
    }
    const plannedTask = plan.tasks.find((task) => task.id === result.task.id);
    if (!plannedTask || plannedTask.digest !== result.task.digest) throw new FarmError("result task is not bound to its worker plan", { code: "RESULT_BINDING_MISMATCH" });
  }
  return result;
}

export function validateVerifyMatrix(matrix) {
  if (!matrix || matrix.schema !== VERIFY_MATRIX_SCHEMA) throw new FarmError("unsupported verify matrix schema", { code: "INVALID_MATRIX" });
  validateId(matrix.runId, "matrix runId");
  if (!/^[a-f0-9]{64}$/u.test(matrix.sourceHash ?? "")) throw new FarmError("matrix sourceHash is invalid", { code: "INVALID_MATRIX" });
  if (!["pass", "fail"].includes(matrix.status) || !["fast", "full"].includes(matrix.mode)) throw new FarmError("matrix status or mode is invalid", { code: "INVALID_MATRIX" });
  if (!matrix.selection || !matrix.cache || !matrix.plan || !matrix.durations || !Array.isArray(matrix.tasks) || !Array.isArray(matrix.coverageEvidence)) {
    throw new FarmError("verify matrix sections are missing", { code: "INVALID_MATRIX" });
  }
  if (!Number.isFinite(matrix.durations.wallMs) || matrix.durations.wallMs < 0 || !Number.isFinite(matrix.durations.sumTaskMs) || matrix.durations.sumTaskMs < 0 || !Number.isFinite(matrix.durations.parallelismRatio) || matrix.durations.parallelismRatio < 0) {
    throw new FarmError("verify matrix durations are invalid", { code: "INVALID_MATRIX" });
  }
  if (matrix.mode === "full" && (matrix.cache.enabled !== false || matrix.cache.hit !== false || matrix.cache.disposition !== "fresh")) {
    throw new FarmError("full verify matrix contains cache provenance", { code: "FULL_MODE_CACHE_FORBIDDEN" });
  }
  if (matrix.cache.sourceHash !== matrix.sourceHash || matrix.selection.source?.currentHash !== matrix.sourceHash) {
    throw new FarmError("matrix provenance is not bound to its full source hash", { code: "INVALID_MATRIX" });
  }
  const taskIds = new Set();
  for (const task of matrix.tasks) {
    validateId(task?.id, "matrix task id");
    if (taskIds.has(task.id)) throw new FarmError(`duplicate matrix task ${task.id}`, { code: "INVALID_MATRIX" });
    taskIds.add(task.id);
    if (!/^[a-f0-9]{64}$/u.test(task.digest ?? "") || task.sourceHash !== matrix.sourceHash) throw new FarmError("matrix task binding is invalid", { code: "INVALID_MATRIX" });
    if (!["pass", "fail", "refused", "killed", "quarantined"].includes(task.status) || !["pass", "fail"].includes(task.gateStatus)) throw new FarmError("matrix task status is invalid", { code: "INVALID_MATRIX" });
    if ((task.status === "pass") !== (task.gateStatus === "pass")) throw new FarmError("non-pass matrix task cannot have a passing gate status", { code: "INVALID_MATRIX" });
    if (!Number.isFinite(task.durationMs) || task.durationMs < 0 || !Array.isArray(task.attempts) || !Array.isArray(task.artifacts) || !Array.isArray(task.coverageEvidence)) throw new FarmError("matrix task arrays or duration are invalid", { code: "INVALID_MATRIX" });
    for (const artifactSet of task.artifacts) {
      if (!Number.isInteger(artifactSet?.executionAttempt) || artifactSet.executionAttempt < 0 || !Array.isArray(artifactSet.files)) throw new FarmError("matrix task artifact set is invalid", { code: "INVALID_MATRIX" });
      if (artifactSet.files.length > 0 && (typeof artifactSet.artifactRoot !== "string" || !path.isAbsolute(artifactSet.artifactRoot))) throw new FarmError("matrix task artifacts are not bound to an artifact root", { code: "INVALID_MATRIX" });
      validateArtifactRecords(artifactSet.files, "matrix task artifacts");
    }
    for (const attempt of task.attempts) {
      if (!Number.isInteger(attempt.executionAttempt) || attempt.executionAttempt < 0 || !["pass", "fail", "refused", "killed"].includes(attempt.status) || !Number.isFinite(attempt.durationMs) || attempt.durationMs < 0 || !Array.isArray(attempt.artifacts)) {
        throw new FarmError("matrix attempt is invalid", { code: "INVALID_MATRIX" });
      }
      if (attempt.artifacts.length > 0 && (typeof attempt.artifactRoot !== "string" || !path.isAbsolute(attempt.artifactRoot))) throw new FarmError("matrix attempt artifacts are not bound to an artifact root", { code: "INVALID_MATRIX" });
      validateArtifactRecords(attempt.artifacts, "matrix attempt artifacts");
      if (attempt.cache?.sourceHash !== matrix.sourceHash) throw new FarmError("matrix attempt cache provenance is invalid", { code: "INVALID_MATRIX" });
    }
  }
  if (matrix.plan.taskCount !== matrix.tasks.length || (matrix.status === "pass") !== matrix.tasks.every((task) => task.gateStatus === "pass")) {
    throw new FarmError("matrix roll-up status does not match its tasks", { code: "INVALID_MATRIX" });
  }
  return matrix;
}

function validateArtifactRecords(artifacts, label) {
  const paths = new Set();
  for (const artifact of artifacts) {
    validateRelativePath(artifact?.path, `${label} path`);
    if (paths.has(artifact.path)) throw new FarmError(`${label} contain a duplicate path`, { code: "INVALID_RESULT" });
    paths.add(artifact.path);
    if (!/^[a-f0-9]{64}$/u.test(artifact?.sha256 ?? "") || !Number.isSafeInteger(artifact?.size) || artifact.size < 0) {
      throw new FarmError(`${label} contain an invalid checksum record`, { code: "INVALID_RESULT" });
    }
  }
}

export async function copyArtifactSource(repoRoot, sourceRelative, destinationRoot) {
  validateRelativePath(sourceRelative, "artifact source");
  const source = resolveWithin(repoRoot, sourceRelative);
  let stats;
  try {
    stats = await fs.lstat(source);
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
  if (stats.isSymbolicLink()) throw new FarmError(`artifact source ${sourceRelative} is a symlink`, { code: "UNSAFE_ARTIFACT" });
  const destination = resolveWithin(destinationRoot, path.posix.join("collected", sourceRelative));
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.cp(source, destination, { recursive: stats.isDirectory(), force: false, errorOnExist: true, dereference: false });
  return true;
}

export function tail(text, maxBytes = 16_384) {
  const value = String(text ?? "");
  return Buffer.byteLength(value) <= maxBytes ? value : Buffer.from(value).subarray(-maxBytes).toString("utf8");
}

function byteCompare(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}
