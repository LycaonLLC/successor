import crypto from "node:crypto";
import fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";

export const EVIDENCE_SCHEMA = "successor.rc-proof.v1";
const MAX_EVENT_BYTES = 16_384;
const MAX_EVENTS = 10_000;
const SAFE_TECHNICAL_ID_FIELDS = new Set(["commandId", "releaseId", "runId", "shardId"]);
const FORBIDDEN_FIELD_FAMILY = /(?:account|authorization|body|capabilit(?:y|ies)|chat|cookie|credential|csrf|device|headers|owner|password|payload|secret|session|ticket|token)/iu;
const IDENTIFIER_FIELD = /(?:^|_)(?:id|ids|ref|refs)$|(?:Id|Ids|Ref|Refs)$/u;

export function isForbiddenEvidenceField(key) {
  const name = String(key ?? "");
  return !SAFE_TECHNICAL_ID_FIELDS.has(name) && (FORBIDDEN_FIELD_FAMILY.test(name) || IDENTIFIER_FIELD.test(name));
}
const SECRET_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/u,
  /(?:^|[^A-Z0-9])AKIA[0-9A-Z]{16}(?:$|[^A-Z0-9])/u,
  /(?:authorization|proxy-authorization)\s*[:=]\s*bearer\s+[A-Za-z0-9._~+/=-]{12,}/iu,
  /(?:aws_secret_access_key|cloudflare_api_token|session_token)\s*[:=]/iu,
];

export function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function createEvidenceWriter({ artifactRoot, runId, sha, secrets = [] } = {}) {
  if (!artifactRoot || !runId || !/^[0-9a-f]{40}$/iu.test(String(sha ?? ""))) throw new Error("evidence requires artifactRoot, runId, and exact SHA");
  const root = path.resolve(artifactRoot);
  const secretNeedles = new Set([...secrets].filter((value) => typeof value === "string" && value.length > 0));
  const events = [];
  let eventFileReady = false;
  let sealed = false;

  async function init() {
    await ensureDirectoryNoSymlinks(root, root);
    await fs.chmod(root, 0o700);
    await ensureDirectoryNoSymlinks(root, path.join(root, "failure"));
    await ensureDirectoryNoSymlinks(root, path.join(root, "screenshots"));
    await writeNoFollow(path.join(root, "events.jsonl"), "", false);
    eventFileReady = true;
    return api;
  }

  function registerSecrets(values) {
    for (const value of values ?? []) if (typeof value === "string" && value.length) secretNeedles.add(value);
  }

  async function record(event) {
    if (sealed) throw new Error("evidence already sealed");
    if (!eventFileReady) await init();
    if (events.length >= MAX_EVENTS) throw new Error("evidence event limit exceeded");
    const normalized = normalizeEvent(event, events.length + 1);
    const line = `${JSON.stringify(normalized)}\n`;
    if (Buffer.byteLength(line) > MAX_EVENT_BYTES) throw new Error("evidence event too large");
    events.push(normalized);
    await writeNoFollow(path.join(root, "events.jsonl"), line, true);
    return normalized;
  }

  async function writeJson(relativePath, value) {
    if (sealed) throw new Error("evidence already sealed");
    const target = safePath(root, relativePath);
    await ensureDirectoryNoSymlinks(root, path.dirname(target));
    const content = `${JSON.stringify(value, null, 2)}
`;
    await writeNoFollow(target, content, false);
    return relativePath;
  }

  async function seal({ verdict, gates = {}, aliases = {}, screenshots = [], steps = [], stack = {}, worktreeClean = true, failure = null, cleanup = true, denylist = "clean" } = {}) {
    if (sealed) throw new Error("evidence already sealed");
    if (!["pass", "fail", "incomplete"].includes(verdict)) throw new Error(`invalid verdict: ${verdict}`);
    if (!eventFileReady) await init();
    const safeScreenshots = await validateScreenshots(root, screenshots);
    const manifest = {
      schema: EVIDENCE_SCHEMA,
      runId,
      worktree: { sha: String(sha), clean: Boolean(worktreeClean) },
      ...(stack && Object.keys(stack).length ? { stack: normalizeObject(stack) } : {}),
      steps: normalizeSteps(steps),
      ...(gates && Object.keys(gates).length ? { gates: normalizeGates(gates) } : {}),
      ...(aliases && Object.keys(aliases).length ? { aliases: normalizeAliases(aliases) } : {}),
      ...(safeScreenshots.length ? { screenshots: safeScreenshots } : {}),
      verdict,
      sealed: { secretScan: "clean", denylist, cleanup: Boolean(cleanup) },
      ...(failure ? { failure: normalizeObject(failure) } : {}),
    };
    assertManifestShape(manifest);
    await writeNoFollow(path.join(root, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, false);
    const scan = await scanEvidence(root, [...secretNeedles]);
    if (!scan.clean) {
      sealed = true;
      await quarantine(root, { runId, sha: String(sha), code: scan.code, pathClass: scan.pathClass });
      return { ok: false, integrity: true, manifest: null, scan };
    }
    const digest = sha256(JSON.stringify(manifest));
    manifest.sealed.manifestSha256 = digest;
    await writeNoFollow(path.join(root, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, false);
    const finalScan = await scanEvidence(root, [...secretNeedles]);
    if (!finalScan.clean) {
      sealed = true;
      await quarantine(root, { runId, sha: String(sha), code: finalScan.code, pathClass: finalScan.pathClass });
      return { ok: false, integrity: true, manifest: null, scan: finalScan };
    }
    sealed = true;
    return { ok: true, integrity: false, manifest, scan: finalScan };
  }

  const api = { init, record, registerSecrets, writeJson, seal, get events() { return events.slice(); }, get secrets() { return [...secretNeedles]; }, root };
  return api;
}

export async function scanEvidence(root, secrets = []) {
  const needleList = [...new Set(secrets.filter((value) => typeof value === "string" && value.length))];
  let files;
  try { files = await listFiles(root); } catch (error) { return { clean: false, code: "evidence-read-failed", pathClass: "root", error: error.message }; }
  for (const file of files) {
    let content;
    try { content = await fs.readFile(file); } catch (error) { return { clean: false, code: "evidence-read-failed", pathClass: classifyPath(root, file), error: error.message }; }
    const text = content.toString("utf8");
    if (needleList.some((needle) => content.includes(Buffer.from(needle)))) return { clean: false, code: "minted-secret-present", pathClass: classifyPath(root, file) };
    if (SECRET_PATTERNS.some((pattern) => pattern.test(text))) return { clean: false, code: "denylist-pattern-present", pathClass: classifyPath(root, file) };
  }
  return { clean: true, files: files.length, hits: 0 };
}

export async function quarantine(root, { runId, sha, code = "evidence-integrity", pathClass = "unknown" } = {}) {
  const absolute = path.resolve(root);
  await fs.rm(absolute, { recursive: true, force: true });
  await fs.mkdir(absolute, { recursive: true, mode: 0o700 });
  await fs.chmod(absolute, 0o700);
  const tombstone = { schema: "successor.rc-proof.tombstone.v1", runId: String(runId ?? "unknown"), sha: String(sha ?? "unknown"), code: String(code).slice(0, 120), pathClass: String(pathClass).slice(0, 120) };
  await fs.writeFile(path.join(absolute, "tombstone.json"), `${JSON.stringify(tombstone, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  return tombstone;
}

async function validateScreenshots(root, screenshots) {
  const values = Array.isArray(screenshots) ? screenshots : [];
  if (values.length > 200) throw new Error("too many screenshots");
  const output = [];
  for (const value of values) {
    if (typeof value !== "string" || !/^screenshots\/[A-Za-z0-9_.-]+\.png$/u.test(value)) throw new Error("invalid screenshot evidence path");
    const target = safePath(root, value);
    const metadata = await fs.lstat(target);
    if (metadata.isSymbolicLink() || !metadata.isFile()) throw new Error("screenshot evidence is not a regular file");
    const [realRoot, realTarget] = await Promise.all([fs.realpath(root), fs.realpath(target)]);
    if (realTarget !== realRoot && !realTarget.startsWith(`${realRoot}${path.sep}`)) throw new Error("screenshot evidence escapes root");
    output.push(value);
  }
  return output;
}

async function ensureDirectoryNoSymlinks(root, directory) {
  const absoluteRoot = path.resolve(root);
  const absoluteDirectory = path.resolve(directory);
  if (absoluteDirectory !== absoluteRoot && !absoluteDirectory.startsWith(`${absoluteRoot}${path.sep}`)) throw new Error("evidence directory escapes root");
  const relative = path.relative(path.dirname(absoluteRoot), absoluteDirectory);
  let cursor = path.dirname(absoluteRoot);
  for (const part of relative.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    const metadata = await fs.lstat(cursor).catch((error) => error.code === "ENOENT" ? null : Promise.reject(error));
    if (metadata?.isSymbolicLink()) throw new Error(`symlink in evidence path: ${part}`);
    if (metadata === null) await fs.mkdir(cursor, { mode: 0o700 });
  }
}

async function writeNoFollow(file, content, append) {
  const flags = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_NOFOLLOW | (append ? fsConstants.O_APPEND : fsConstants.O_TRUNC);
  const handle = await fs.open(file, flags, 0o600);
  try { await handle.writeFile(content, { encoding: "utf8" }); }
  finally { await handle.close(); }
}

async function listFiles(root) {
  const output = [];
  async function visit(directory) {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const target = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`symlink in evidence: ${entry.name}`);
      if (entry.isDirectory()) await visit(target);
      else if (entry.isFile()) output.push(target);
      else throw new Error(`non-regular evidence entry: ${entry.name}`);
    }
  }
  await visit(root);
  return output;
}

function safePath(root, relativePath) {
  if (typeof relativePath !== "string" || path.isAbsolute(relativePath)) throw new Error("evidence path must be relative");
  const absolute = path.resolve(root, relativePath);
  if (absolute !== root && !absolute.startsWith(`${root}${path.sep}`)) throw new Error("evidence path escapes root");
  return absolute;
}
function classifyPath(root, file) { return path.relative(root, file).split(path.sep)[0] || "root"; }
function normalizeEvent(value, sequence) { const event = normalizeObject(value ?? {}); const atMs = Number.isFinite(Number(event.atMs)) ? Math.max(0, Math.trunc(Number(event.atMs))) : Date.now(); const type = String(event.type ?? "event").slice(0, 100); delete event.sequence; delete event.atMs; delete event.type; return { sequence, atMs, type, ...event }; }
function normalizeObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/u.test(key)) continue;
    if (isForbiddenEvidenceField(key)) throw new Error(`forbidden evidence field: ${key}`);
    if (typeof item === "string") out[key] = item.slice(0, 500);
    else if (typeof item === "number" || typeof item === "boolean" || item === null) out[key] = item;
    else if (Array.isArray(item)) out[key] = item.slice(0, 30).map((entry) => normalizeValue(entry));
    else if (item && typeof item === "object") out[key] = normalizeObject(item);
  }
  return out;
}
function normalizeValue(value) { if (typeof value === "string") return value.slice(0, 300); if (typeof value === "number" || typeof value === "boolean" || value === null) return value; if (Array.isArray(value)) return value.slice(0, 30).map((entry) => normalizeValue(entry)); if (value && typeof value === "object") return normalizeObject(value); return null; }
function assertManifestShape(manifest) {
  const allowed = new Set(["schema", "runId", "worktree", "stack", "steps", "gates", "aliases", "screenshots", "verdict", "sealed", "failure"]);
  if (Object.keys(manifest).some((key) => !allowed.has(key))) throw new Error("manifest has unknown fields");
  if (manifest.schema !== EVIDENCE_SCHEMA || !/^rc-[A-Za-z0-9._-]+$/u.test(manifest.runId)) throw new Error("manifest identity is invalid");
  if (!manifest.worktree || Object.keys(manifest.worktree).some((key) => !["sha", "clean"].includes(key)) || !/^[0-9a-f]{40}$/iu.test(manifest.worktree.sha) || typeof manifest.worktree.clean !== "boolean") throw new Error("manifest worktree is invalid");
  if (!Array.isArray(manifest.steps) || !["pass", "fail", "incomplete"].includes(manifest.verdict)) throw new Error("manifest verdict is invalid");
  if (!manifest.sealed || !["clean", "hit", "error"].includes(manifest.sealed.secretScan) || typeof manifest.sealed.cleanup !== "boolean") throw new Error("manifest seal is invalid");
  if (manifest.stack && Object.keys(manifest.stack).some((key) => !["siteUrl", "clientUrl", "controlUrl", "releaseId", "status"].includes(key))) throw new Error("manifest stack is invalid");
  if (manifest.failure && (Object.keys(manifest.failure).some((key) => !["step", "reason", "code"].includes(key)) || !["step", "reason", "code"].every((key) => typeof manifest.failure[key] === "string" && manifest.failure[key].length > 0))) throw new Error("manifest failure is invalid");
  if (manifest.screenshots && !manifest.screenshots.every((item) => typeof item === "string" && /^screenshots\/[A-Za-z0-9_.-]+\.png$/u.test(item))) throw new Error("manifest screenshots are invalid");
}
function normalizeAliases(value) {
  const out = {};
  for (const [key, item] of Object.entries(value ?? {}).slice(0, 20)) {
    if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/u.test(key)) continue;
    const normalized = normalizeObject({ [key]: item });
    if (Object.hasOwn(normalized, key)) out[key] = String(normalized[key]).slice(0, 120);
  }
  return out;
}
function normalizeGates(value) { const out = {}; for (const [key, item] of Object.entries(value ?? {}).slice(0, 100)) { if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/u.test(key)) continue; if (typeof item === "string" || typeof item === "boolean") out[key] = item; else if (item && typeof item === "object" && !Array.isArray(item)) out[key] = normalizeObject(item); } return out; }
function normalizeScalarMap(value) { const out = {}; for (const [key, item] of Object.entries(value ?? {}).slice(0, 50)) { if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/u.test(key) || isForbiddenEvidenceField(key)) continue; if (typeof item === "string") out[key] = item.slice(0, 300); else if (typeof item === "boolean") out[key] = item; } return out; }
function normalizeSteps(steps) { return (Array.isArray(steps) ? steps : Object.entries(steps ?? {}).map(([name, status]) => ({ name, status }))).slice(0, 100).map((step) => { const source = normalizeObject(step); const status = ["pass", "fail", "blocked", "incomplete"].includes(source.status) ? source.status : "fail"; const name = String(source.name ?? "unknown").slice(0, 120) || "unknown"; const gate = source.gate && typeof source.gate === "object" ? normalizeScalarMap(source.gate) : {}; return { name, status, ...(source.ms !== undefined ? { ms: Math.max(0, Math.trunc(Number(source.ms) || 0)) } : {}), ...(source.reason ? { reason: String(source.reason).slice(0, 500) } : {}), ...(Array.isArray(source.evidence) ? { evidence: source.evidence.slice(0, 100).map((item) => String(item).slice(0, 300)) } : {}), ...(Object.keys(gate).length ? { gate } : {}) }; }); }
