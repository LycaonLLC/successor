#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { createEvidenceWriter } from "./evidence.mjs";
import { createFailureBundle, writeFailureBundle } from "./failure.mjs";

export const EXIT = Object.freeze({ PASS: 0, FAIL: 1, INVOCATION: 2, INFRA: 3, INTEGRITY: 4 });
const RUNNER_PATH = path.resolve(fileURLToPath(import.meta.url));

export async function runProof(options = {}) {
  const args = normalizeOptions(options);
  const started = Date.now();
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  process.once("SIGINT", onAbort);
  process.once("SIGTERM", onAbort);
  let evidence;
  let stack = null;
  let proof = null;
  let failure = null;
  let infra = false;
  let cleanup = true;
  let incompleteReason = null;
  let postRunClean = false;
  let eventQueue = Promise.resolve();
  try {
    validateOptions(args);
    await fs.mkdir(args.runRoot, { recursive: true, mode: 0o700 });
    await fs.chmod(args.runRoot, 0o700);
    await fs.mkdir(args.artifactRoot, { recursive: true, mode: 0o700 });
    await fs.chmod(args.artifactRoot, 0o700);
    verifyRunnerSource(args);
    evidence = createEvidenceWriter({ artifactRoot: args.artifactRoot, runId: args.runId, sha: args.sha });
    await evidence.init();
    const onEvent = (event) => {
      if (!event || typeof event !== "object") return eventQueue;
      eventQueue = eventQueue.then(async () => {
        evidence.registerSecrets([...(Array.isArray(event.mintedSecrets) ? event.mintedSecrets : []), ...(Array.isArray(event.secrets) ? event.secrets : []), ...(typeof event.mintedSecret === "string" ? [event.mintedSecret] : [])]);
        const safeEvent = { ...event };
        delete safeEvent.mintedSecrets; delete safeEvent.secrets; delete safeEvent.mintedSecret;
        await evidence.record(safeEvent);
      });
      return eventQueue;
    };
    const stackModule = await loadModule(args.stackModule, args.worktree, "local-stack.mjs");
    const playerModule = await loadModule(args.playerModule, args.worktree, "two-player.mjs");
    if (typeof stackModule.startLocalStack !== "function") throw codedError("runner-missing-export", "stack module must export startLocalStack", true);
    if (typeof playerModule.runTwoPlayerEntryProof !== "function") throw codedError("runner-missing-export", "two-player module must export runTwoPlayerEntryProof", true);
    stack = await stackModule.startLocalStack({ repoRoot: args.worktree, runRoot: args.runRoot, sha: args.sha, signal: controller.signal, onEvent });
    if (!stack || typeof stack !== "object" || typeof stack.stop !== "function") throw codedError("stack-contract", "startLocalStack returned no stop()", true);
    evidence.registerSecrets(stack.mintedSecrets ?? stack.secrets ?? []);
    if (typeof stack.probe === "function") {
      const probe = await stack.probe();
      evidence.registerSecrets(probe?.mintedSecrets ?? probe?.secrets ?? []);
      if (probe?.status === "blocked" || probe?.status === "incomplete") incompleteReason = String(probe.reason ?? "stack is incomplete");
      if (probe?.status === "fail") throw codedError("stack-probe-failed", probe.reason ?? "stack probe failed", true);
    }
    proof = incompleteReason
      ? { verdict: "incomplete", gates: { stack: { status: "incomplete", reason: incompleteReason } }, aliases: {} }
      : await playerModule.runTwoPlayerEntryProof({ stack, runRoot: args.runRoot, signal: controller.signal, onEvent });
    evidence.registerSecrets(proof?.mintedSecrets ?? proof?.secrets ?? []);
    if (!proof || typeof proof !== "object") throw codedError("proof-contract", "entry proof returned no result", false);
    failure = findFailure(proof);
  } catch (error) {
    failure = { step: error.step ?? "bootstrap", reason: error.message ?? String(error), code: error.code ?? "orchestration-error" };
    infra = Boolean(error.infrastructure);
  } finally {
    if (stack?.stop) {
      try { const stopped = await stack.stop(); if (stopped?.ok === false) throw new Error("stack stop reported incomplete cleanup"); } catch (error) { cleanup = false; failure ??= { step: "teardown", reason: error.message, code: "teardown-failed" }; infra = true; }
    }
    process.removeListener("SIGINT", onAbort);
    process.removeListener("SIGTERM", onAbort);
    await eventQueue.catch((error) => { cleanup = false; failure ??= { step: "evidence", reason: error.message, code: "evidence-write-failed" }; });
  }
  if (!evidence) return { exitCode: EXIT.INVOCATION, line: `RC FAIL invocation ${args.sha?.slice(0, 12) ?? "unknown"}` };
  postRunClean = sourceClean(args.worktree);
  if (!postRunClean) failure ??= { step: "source-integrity", reason: "tested worktree changed during proof", code: "post-run-dirty" };
  const status = deriveVerdict(proof, failure, infra, controller.signal.aborted);
  if (status === "fail" && !failure) failure = synthesizeFailure(proof, controller.signal.aborted);
  if (failure && status !== "pass") {
    const bundle = createFailureBundle({ step: failure.step, reason: failure.reason, code: failure.code, events: evidence.events, gates: proof?.gates ?? {}, cleanup: { complete: cleanup } });
    await writeFailureBundle(args.artifactRoot, bundle);
  }
  const sealed = await evidence.seal({
    verdict: status,
    gates: proof?.gates ?? {},
    aliases: proof?.aliases ?? {},
    screenshots: proof?.screenshots ?? [],
    steps: proof?.steps ?? gatesToSteps(proof?.gates),
    stack: stackSummary(stack),
    worktreeClean: postRunClean,
    failure,
    cleanup,
    denylist: "clean",
  });
  if (!sealed.ok) return { exitCode: EXIT.INTEGRITY, line: `RC FAIL evidence-integrity ${path.join(args.artifactRoot, "tombstone.json")}`, runRoot: args.runRoot };
  const manifestPath = path.join(args.artifactRoot, "manifest.json");
  const digest = crypto.createHash("sha256").update(await fs.readFile(manifestPath)).digest("hex");
  const firstFailure = failure?.step ?? firstNonPass(proof?.gates) ?? "unknown";
  const reason = failure?.code ?? firstFailure;
  const line = status === "pass"
    ? `RC PASS ${args.sha.slice(0, 12)} ${manifestPath} ${digest}`
    : status === "incomplete"
      ? `RC INCOMPLETE ${reason} ${manifestPath}`
      : `RC FAIL ${reason} ${path.join(args.artifactRoot, "failure", "bundle.json")}`;
  return { exitCode: status === "pass" ? EXIT.PASS : status === "incomplete" ? EXIT.INFRA : infra ? EXIT.INFRA : EXIT.FAIL, line, manifestPath, runRoot: args.runRoot, durationMs: Date.now() - started };
}

function synthesizeFailure(proof, aborted) {
  const step = firstNonPass(proof?.gates) ?? "proof";
  const reason = aborted
    ? "proof aborted before a failure was recorded"
    : "proof reported fail without a failing gate or failure detail";
  return { step, reason, code: aborted ? "proof-aborted" : "inconsistent-proof" };
}

function normalizeOptions(options) {
  const sha = String(options.sha ?? options.commit ?? "");
  const runRoot = path.resolve(String(options.runRoot ?? path.join(process.env.XDG_CACHE_HOME ?? path.join(process.env.HOME ?? ".", ".cache"), "successor-rc-proof", `rc-${Date.now()}`)));
  return { ...options, sha, worktree: path.resolve(String(options.worktree ?? path.dirname(path.dirname(path.dirname(RUNNER_PATH))))), runRoot, artifactRoot: path.resolve(String(options.artifactRoot ?? path.join(runRoot, "evidence"))), runId: String(options.runId ?? path.basename(runRoot)), stackModule: options.stackModule, playerModule: options.playerModule };
}
function validateOptions(args) {
  if (!/^[0-9a-f]{40}$/iu.test(args.sha)) throw codedError("invalid-sha", "commit must be exactly 40 hexadecimal characters", false);
  if (!pathInside(args.runRoot, args.artifactRoot)) throw codedError("invalid-artifact-root", "artifact root must be inside run root", false);
  if (!args.worktree || !args.runRoot) throw codedError("invalid-invocation", "worktree and run root are required", false);
}
function verifyRunnerSource(args) {
  if (!pathInside(args.worktree, RUNNER_PATH)) throw codedError("runner-not-from-worktree", "runner is not loaded from tested worktree", true);
  const head = git(args.worktree, ["rev-parse", "HEAD"]);
  if (head.toLowerCase() !== args.sha.toLowerCase()) throw codedError("source-sha-mismatch", `worktree HEAD ${head || "unknown"} does not match requested SHA`, true);
  const dirty = git(args.worktree, ["status", "--porcelain=v1", "--untracked-files=all"]);
  if (dirty) throw codedError("dirty-worktree", "tested worktree is dirty", true);
}
async function loadModule(spec, worktree, fallback) {
  const candidate = spec ? String(spec) : path.join(worktree, "tools", "verification", "rc", fallback);
  const resolved = path.isAbsolute(candidate) ? path.resolve(candidate) : path.resolve(worktree, candidate);
  if (!pathInside(worktree, resolved)) throw codedError("module-outside-worktree", `${fallback} must live inside the tested worktree`, false);
  try {
    const [realWorktree, realResolved] = await Promise.all([fs.realpath(worktree), fs.realpath(resolved)]);
    if (!pathInside(realWorktree, realResolved)) throw codedError("module-outside-worktree", `${fallback} escapes the tested worktree`, false);
    return await import(pathToFileURL(realResolved).href);
  } catch (error) {
    if (error.code === "ERR_MODULE_NOT_FOUND" || error.code === "MODULE_NOT_FOUND" || error.code === "ENOENT") throw codedError("runner-missing-at-commit", `${fallback} is missing at tested SHA`, true);
    throw error;
  }
}
function codedError(code, message, infrastructure) { const error = new Error(message); error.code = code; error.infrastructure = infrastructure; return error; }
export function deriveVerdict(proof, failure, infra, aborted) { if (aborted) return "fail"; if (infra) return "incomplete"; if (failure) return "fail"; const statuses = Object.values(proof?.gates ?? {}).map(gateStatus); if (statuses.length === 0) return "incomplete"; if (statuses.includes("fail") || proof?.verdict === "fail") return "fail"; if (statuses.some((status) => status !== "pass") || proof?.verdict === "incomplete") return "incomplete"; return "pass"; }
function gateStatus(value) { if (value === true || value === "pass") return "pass"; if (value === false || value === "fail") return "fail"; if (value === "blocked" || value === "incomplete") return value; if (value && typeof value === "object") return gateStatus(value.status ?? value.verdict ?? value.result); return "incomplete"; }
function findFailure(proof) { if (proof?.failure && typeof proof.failure === "object") return proof.failure; const entry = Object.entries(proof?.gates ?? {}).find(([, value]) => gateStatus(value) === "fail"); return entry ? { step: entry[0], reason: typeof entry[1] === "object" ? entry[1].reason ?? "gate failed" : "gate failed", code: "behavioral-failure" } : null; }
function gatesToSteps(gates) { return Object.entries(gates ?? {}).map(([name, value]) => ({ name, status: gateStatus(value) })); }
function firstNonPass(gates) { const entry = Object.entries(gates ?? {}).find(([, value]) => gateStatus(value) !== "pass"); return entry?.[0]; }
function stackSummary(stack) { if (!stack) return {}; const out = {}; for (const key of ["siteUrl", "clientUrl", "controlUrl", "releaseId", "status"]) if (typeof stack[key] === "string") out[key] = stack[key].slice(0, 300); return out; }
function sourceClean(root) { if (!root) return false; const result = spawnSync("git", ["status", "--porcelain=v1", "--untracked-files=all"], { cwd: root, encoding: "utf8" }); return result.status === 0 && result.stdout.trim() === ""; }
function git(cwd, args) { const result = spawnSync("git", args, { cwd, encoding: "utf8" }); return result.status === 0 ? result.stdout.trim() : ""; }
function pathInside(root, target) { const a = path.resolve(root); const b = path.resolve(target); return b === a || b.startsWith(`${a}${path.sep}`); }
function parseArgv(argv) { const out = {}; for (let index = 0; index < argv.length; index += 1) { const arg = argv[index]; if (!arg.startsWith("--")) throw codedError("invalid-invocation", `unexpected argument ${arg}`, false); const [key, inline] = arg.slice(2).split("=", 2); const value = inline ?? argv[++index]; if (value === undefined || value.startsWith("--")) throw codedError("invalid-invocation", `missing value for --${key}`, false); out[key.replaceAll("-", "_")] = value; } return out; }

async function main() {
  let result;
  try { const cli = parseArgv(process.argv.slice(2)); result = await runProof({ sha: cli.commit, worktree: cli.worktree, artifactRoot: cli.artifact_root, runRoot: cli.run_root, runId: cli.run_id, stackModule: cli.stack_module, playerModule: cli.player_module }); }
  catch (error) { result = { exitCode: error.code === "invalid-sha" || error.code === "invalid-invocation" ? EXIT.INVOCATION : error.infrastructure ? EXIT.INFRA : EXIT.FAIL, line: `RC FAIL ${error.code ?? "invocation"} ${error.message}` }; }
  process.stdout.write(`${result.line}\n`);
  process.exitCode = result.exitCode;
}

if (process.argv[1] && path.resolve(process.argv[1]) === RUNNER_PATH) main();
