#!/usr/bin/env node
/**
 * MUD journey gate — the TUI's live proofs as a standing gate.
 *
 * The default remains the original shared two-pass bar: each pass boots one
 * scratch shard and runs every selected journey sequentially through it.
 * `--isolated` is the farm/iteration lane: every journey gets one disposable
 * ProcessHost stack and one pass, with a bounded `--concurrency N` queue.
 *
 * Usage:
 *   node client-tui/journeys/runner.mjs
 *   node client-tui/journeys/runner.mjs --once
 *   node client-tui/journeys/runner.mjs --only trade,group
 *   node client-tui/journeys/runner.mjs --isolated --concurrency 2 --only trade,group
 *   TUI_GATE_SKIP_BUILD=1 ...                      # require existing dist artifacts
 *   TUI_GATE_PORT=28110 ...                        # port base override
 */

import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { grant, grantSkillBoxes } from "./lib/grants.mjs";
import { createSession } from "./lib/session.mjs";
import { prepareStackBuild, resetStackFixture, startStack } from "./lib/stack.mjs";

/** Thrown by context.skip(reason) — the runner records a runtime SKIP. */
class SkipJourney extends Error {}

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");
const CLIENT_TUI_ROOT = path.join(REPO_ROOT, "client-tui");
const JOURNEY_DIR = path.join(import.meta.dirname, "journeys");
const CLI_PATH = path.join(CLIENT_TUI_ROOT, "dist", "cli.js");
const SOURCE_DIRS_FOR_DIST = [
  path.join(CLIENT_TUI_ROOT, "src"),
  path.join(REPO_ROOT, "client", "src"),
];

export function parseRunnerArgs(argv, env = process.env) {
  const isolated = argv.includes("--isolated");
  const once = argv.includes("--once");
  const onlyValue = optionValue(argv, "--only", { required: false });
  const concurrencyPresent = argv.includes("--concurrency") || argv.some((arg) => arg.startsWith("--concurrency="));
  const concurrencyValue = optionValue(argv, "--concurrency", { required: concurrencyPresent });
  if (!isolated && concurrencyPresent) {
    throw new Error("--concurrency requires --isolated; shared mode is intentionally sequential");
  }
  const concurrency = concurrencyValue === null ? 1 : Number(concurrencyValue);
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 64) {
    throw new Error(`--concurrency must be an integer from 1 to 64; got ${concurrencyValue}`);
  }
  const portBase = Number(env.TUI_GATE_PORT ?? 28110);
  if (!Number.isInteger(portBase) || portBase < 1024 || portBase > 65535) {
    throw new Error(`TUI_GATE_PORT must be an integer from 1024 to 65535; got ${env.TUI_GATE_PORT}`);
  }
  return {
    isolated,
    once,
    only: onlyValue ? onlyValue.split(",") : null,
    concurrency,
    portBase,
    skipBuild: env.TUI_GATE_SKIP_BUILD === "1",
  };
}

/** Ordered bounded worker queue. The worker receives a stable slot number. */
export async function mapBounded(items, concurrency, worker) {
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error("mapBounded concurrency must be a positive integer");
  if (items.length === 0) return [];
  const results = new Array(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(concurrency, items.length);
  await Promise.all(Array.from({ length: workerCount }, async (_unused, slot) => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index, slot);
    }
  }));
  return results;
}

export async function loadJourneys({ journeyDir = JOURNEY_DIR, only = null } = {}) {
  const files = readdirSync(journeyDir).filter((file) => file.endsWith(".mjs")).sort();
  const journeys = [];
  for (const file of files) {
    const mod = await import(pathToFileURL(path.join(journeyDir, file)).href);
    const id = file.replace(/^\d+-/, "").replace(/\.mjs$/, "");
    if (only && !only.some((pick) => id.includes(pick))) continue;
    journeys.push({ file, id, run: mod.default, skip: mod.skip ?? null });
  }
  return journeys;
}

/** Pure per-journey ProcessHost/path allocation used by the isolated scheduler. */
export function isolatedJourneyLayout({
  env = process.env,
  repoRoot = REPO_ROOT,
  artifactRoot,
  gateRunId,
  journeyId,
  index,
  total,
  portBase,
}) {
  const ordinal = String(index + 1).padStart(3, "0");
  const safeJourneyId = safeName(journeyId);
  const scope = `${ordinal}-${safeJourneyId}`;
  const configuredRunDir = env.SUCCESSOR_PROCESS_RUN_DIR ? path.resolve(env.SUCCESSOR_PROCESS_RUN_DIR) : null;
  const defaultRunRoot = path.join(repoRoot, "verification", ".runs", "tui", `tui-gate-${gateRunId}`);
  const runRoot = configuredRunDir ?? defaultRunRoot;
  const runDir = total === 1 && configuredRunDir ? configuredRunDir : path.join(runRoot, scope);
  const configuredRunId = env.SUCCESSOR_PROCESS_RUN_ID ? safeName(env.SUCCESSOR_PROCESS_RUN_ID) : null;
  const runIdBase = configuredRunId ?? safeName(`tui-${gateRunId}`);
  const runId = total === 1 && configuredRunId ? configuredRunId : safeName(`${runIdBase}-${scope}`);
  const storePath = total === 1 && env.SUCCESSOR_FARM_STORE_PATH
    ? path.resolve(env.SUCCESSOR_FARM_STORE_PATH)
    : path.join(runDir, env.SUCCESSOR_FARM_STORE_PATH ? path.basename(env.SUCCESSOR_FARM_STORE_PATH) : "characters.json");
  const shardPath = total === 1 && env.SUCCESSOR_FARM_SHARD_PATH
    ? path.resolve(env.SUCCESSOR_FARM_SHARD_PATH)
    : path.join(runDir, env.SUCCESSOR_FARM_SHARD_PATH ? path.basename(env.SUCCESSOR_FARM_SHARD_PATH) : "shard");
  const port = portBase + index;
  if (port > 65535) throw new Error(`isolated journey ${journeyId} exceeds the TCP port range at ${port}`);
  return {
    port,
    runId,
    runDir,
    storePath,
    shardPath,
    artifactDir: path.join(artifactRoot, "isolated", scope),
    unit: `successor-tui-${runId.slice(0, 40)}-${port}`,
  };
}

/** Importable gate entrypoint; tests inject only the stack/session boundaries. */
export async function runJourneyGate(options = {}) {
  const env = options.env ?? process.env;
  const repoRoot = options.repoRoot ?? REPO_ROOT;
  const clientTuiRoot = options.clientTuiRoot ?? CLIENT_TUI_ROOT;
  const journeyDir = options.journeyDir ?? JOURNEY_DIR;
  const cliPath = options.cliPath ?? path.join(clientTuiRoot, "dist", "cli.js");
  const sourceDirs = options.sourceDirs ?? SOURCE_DIRS_FOR_DIST;
  const args = parseRunnerArgs(options.argv ?? process.argv.slice(2), env);
  const now = options.now ?? (() => Date.now());
  const log = options.log ?? ((line = "") => console.log(line));
  const errorLog = options.errorLog ?? ((line) => console.error(line));
  const startStackFn = options.startStackFn ?? startStack;
  const prepareStackBuildFn = options.prepareStackBuildFn ?? prepareStackBuild;
  const createSessionFn = options.createSessionFn ?? createSession;
  const grantFn = options.grantFn ?? grant;
  const grantSkillsFn = options.grantSkillsFn ?? grantSkillBoxes;
  const resetStackFn = options.resetStackFn ?? resetStackFixture;

  if (options.preflight !== false) {
    ensureBuiltCli({ cliPath, sourceDirs, repoRoot, env });
    if (args.isolated || args.skipBuild) prepareStackBuildFn({ skipBuild: args.skipBuild });
  }

  const startedMs = now();
  const gateRunId = safeName(env.TUI_GATE_RUN_ID ?? env.SUCCESSOR_PROCESS_RUN_ID ?? startedMs.toString(36));
  const artifactLeaf = env.SUCCESSOR_PROCESS_RUN_ID ? gateRunId : `tui-gate-${gateRunId}`;
  const artifactRoot = path.resolve(options.artifactRoot ?? path.join(repoRoot, "verification", "ledgers", "artifacts", "tui-gate", artifactLeaf));
  mkdirSync(artifactRoot, { recursive: true });

  const journeys = options.journeys ?? await loadJourneys({ journeyDir, only: args.only });
  if (journeys.length === 0) {
    errorLog("no journeys matched");
    return { exitCode: 2, manifest: null, manifestPath: null };
  }

  let passes;
  if (args.isolated) {
    const concurrency = Math.min(args.concurrency, journeys.length);
    const planned = journeys.map((journey, index) => ({
      journey,
      layout: isolatedJourneyLayout({
        env,
        repoRoot,
        artifactRoot,
        gateRunId,
        journeyId: journey.id,
        index,
        total: journeys.length,
        portBase: args.portBase,
      }),
    }));
    const results = await mapBounded(planned, concurrency, async ({ journey, layout }, _index, slot) => runIsolatedJourney({
      journey,
      layout,
      slot,
      gateRunId,
      startStackFn,
      createSessionFn,
      grantFn,
      grantSkillsFn,
      log,
      now,
    }));
    passes = [{ pass: 1, mode: "isolated", results }];
  } else {
    const passCount = args.once ? 1 : 2;
    passes = [];
    for (let index = 0; index < passCount; index += 1) {
      passes.push(await runSharedPass({
        passIndex: index,
        journeys,
        portBase: args.portBase,
        artifactRoot,
        gateRunId,
        startStackFn,
        createSessionFn,
        grantFn,
        grantSkillsFn,
        resetStackFn,
        log,
        now,
        skipBuild: args.skipBuild,
      }));
    }
  }

  const flat = passes.flatMap((pass) => pass.results);
  const failed = flat.filter((result) => result.status === "fail");
  const passCount = args.isolated ? 1 : (args.once ? 1 : 2);
  const manifest = {
    schema: "successor.tui-gate.v1",
    runId: gateRunId,
    startedAt: new Date(now()).toISOString(),
    bar: args.isolated
      ? "isolated single pass per journey"
      : (args.once ? "single pass (iteration mode)" : "two consecutive green passes on fresh shards"),
    status: failed.length === 0 ? "pass" : "fail",
    ...(args.isolated ? { mode: "isolated", concurrency: Math.min(args.concurrency, journeys.length) } : {}),
    passes,
  };
  const manifestPath = path.join(artifactRoot, "tui-gate-report.json");
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  log(`\ntui:gate ${manifest.status} · journeys=${journeys.length}×${passCount} · fails=${failed.length} · report=${manifestPath}`);
  return { exitCode: failed.length === 0 ? 0 : 1, manifest, manifestPath };
}

async function runSharedPass({
  passIndex,
  journeys,
  portBase,
  artifactRoot,
  gateRunId,
  startStackFn,
  createSessionFn,
  grantFn,
  grantSkillsFn,
  resetStackFn,
  log,
  now,
  skipBuild,
}) {
  const port = portBase + passIndex;
  const passDir = path.join(artifactRoot, `pass-${passIndex + 1}`);
  mkdirSync(passDir, { recursive: true });
  log(`\n▶ pass ${passIndex + 1} — booting scratch shard on ${port}…`);
  const stack = skipBuild ? await startStackFn(port, { skipBuild: true }) : await startStackFn(port);
  log(`  shard ${stack.shardId} up (${stack.unit})`);
  const results = [];
  try {
    for (const journey of journeys) {
      // Every journey owns a clean authored fixture even in the faster shared
      // stack lane. Transient sessions temporarily claim the authored `player`
      // placeholder; without this reset, their granted skills/inventory and
      // combat state can leak into the next journey and manufacture passes.
      await resetStackFn(port);
      results.push(await executeJourney({
        journey,
        passIndex,
        port,
        stack,
        passDir,
        gateRunId,
        createSessionFn,
        grantFn,
        grantSkillsFn,
        log,
        now,
      }));
    }
  } finally {
    await stack.stop();
    log(`  shard on ${port} stopped`);
  }
  return { pass: passIndex + 1, port, shardId: stack.shardId, sliceHash: stack.sliceHash, results };
}

async function runIsolatedJourney({
  journey,
  layout,
  slot,
  gateRunId,
  startStackFn,
  createSessionFn,
  grantFn,
  grantSkillsFn,
  log,
  now,
}) {
  mkdirSync(layout.artifactDir, { recursive: true });
  const metadata = { ...layout, slot: slot + 1 };
  log(`\n▶ ${journey.id} — booting isolated shard on ${layout.port} (slot ${slot + 1})…`);
  let stack = null;
  let result = null;
  try {
    stack = await startStackFn(layout.port, {
      runId: layout.runId,
      runDir: layout.runDir,
      storePath: layout.storePath,
      shardPath: layout.shardPath,
      unit: layout.unit,
      skipBuild: true,
    });
    log(`  shard ${stack.shardId} up (${stack.unit})`);
    result = await executeJourney({
      journey,
      passIndex: 0,
      port: layout.port,
      stack,
      passDir: layout.artifactDir,
      gateRunId,
      createSessionFn,
      grantFn,
      grantSkillsFn,
      log,
      now,
      metadata: {
        ...metadata,
        unit: stack.unit,
        runId: stack.runId ?? layout.runId,
        runDir: stack.runDir ?? layout.runDir,
        storePath: stack.storePath ?? layout.storePath,
        shardPath: stack.shardPath ?? layout.shardPath,
        shardId: stack.shardId,
        sliceHash: stack.sliceHash,
      },
    });
  } catch (error) {
    const transcriptPath = path.join(layout.artifactDir, `${journey.id}-FAIL.txt`);
    const message = String(error?.message ?? error);
    writeFileSync(transcriptPath, `${message}\n`);
    result = {
      id: journey.id,
      status: "fail",
      durationMs: 0,
      checks: [],
      error: message,
      transcriptPath,
      ...metadata,
      shardId: stack?.shardId ?? null,
      sliceHash: stack?.sliceHash ?? null,
    };
    log(`  ✗ ${journey.id} — ${message.split("\n")[0]} (transcript: ${transcriptPath})`);
  } finally {
    if (stack) {
      try {
        const stopped = await stack.stop();
        if (stopped?.ok === false) result = teardownFailure(result, `isolated shard on ${layout.port} did not stop cleanly`);
        log(`  shard on ${layout.port} stopped`);
      } catch (error) {
        result = teardownFailure(result, `isolated shard teardown failed on ${layout.port}: ${error?.message ?? error}`);
      }
    }
  }
  return result;
}
export function materializeActorId(gateRunId, passIndex, journeyId, suffix) {
  const candidate = `gate-${gateRunId}-p${passIndex + 1}-${journeyId}-${suffix}`;
  if (candidate.length <= 64) return candidate;
  const digest = createHash("sha256").update(candidate).digest("hex").slice(0, 16);
  return `${candidate.slice(0, 47)}-${digest}`;
}


async function executeJourney({
  journey,
  passIndex,
  port,
  stack,
  passDir,
  gateRunId,
  createSessionFn,
  grantFn,
  grantSkillsFn,
  log,
  now,
  metadata = {},
}) {
  if (journey.skip) {
    log(`  ↓ ${journey.id} SKIP — ${journey.skip}`);
    return { id: journey.id, status: "skip", reason: journey.skip, ...metadata };
  }
  const started = now();
  const sessions = [];
  const checks = [];
  const context = {
    port,
    stack,
    passDir,
    actorId: (suffix) => materializeActorId(gateRunId, passIndex, journey.id, suffix),
    session(opts) {
      const created = createSessionFn({ port, ...opts });
      sessions.push(created);
      return created;
    },
    grant: (actorId, name, quantity) => grantFn(port, actorId, name, quantity),
    grantSkills: (actorId, skillBoxIds) => grantSkillsFn(port, actorId, skillBoxIds),
    check(desc, condition) {
      checks.push({ desc, ok: Boolean(condition) });
      if (!condition) throw new Error(`check failed: ${desc}`);
    },
    note(desc) {
      checks.push({ desc, ok: true });
    },
    skip(reason) {
      throw new SkipJourney(reason);
    },
  };
  try {
    await journey.run(context);
    for (const session of sessions) await session.quit();
    const durationMs = now() - started;
    log(`  ✓ ${journey.id} (${(durationMs / 1000).toFixed(1)}s, ${checks.length} checks)`);
    return { id: journey.id, status: "pass", durationMs, checks, ...metadata };
  } catch (error) {
    if (error instanceof SkipJourney) {
      for (const session of sessions) await session.quit();
      log(`  ↓ ${journey.id} SKIP — ${error.message}`);
      return { id: journey.id, status: "skip", reason: error.message, ...metadata };
    }
    for (const session of sessions) session.kill();
    const transcriptPath = path.join(passDir, `${journey.id}-FAIL.txt`);
    writeFileSync(transcriptPath, sessions.map((session, index) => `=== session ${index} (${session.actorId}) ===\n${session.transcript()}`).join("\n\n"));
    const message = String(error?.message ?? error);
    log(`  ✗ ${journey.id} — ${message.split("\n")[0]} (transcript: ${transcriptPath})`);
    return { id: journey.id, status: "fail", durationMs: now() - started, checks, error: message, transcriptPath, ...metadata };
  }
}

function teardownFailure(result, message) {
  if (!result) return { id: "harness", status: "fail", durationMs: 0, checks: [], error: message };
  return {
    ...result,
    status: "fail",
    error: result.error ? `${result.error}\n${message}` : message,
  };
}

export function ensureBuiltCli({
  cliPath = CLI_PATH,
  sourceDirs = SOURCE_DIRS_FOR_DIST,
  repoRoot = REPO_ROOT,
  env = process.env,
} = {}) {
  const cliMissing = !existsSync(cliPath);
  if (env.TUI_GATE_SKIP_BUILD === "1") {
    if (cliMissing) {
      throw new Error(`TUI_GATE_SKIP_BUILD=1 requires prebuilt client-tui dist; missing: ${cliPath}`);
    }
    return;
  }

  const cliMtimeMs = cliMissing ? 0 : statSync(cliPath).mtimeMs;
  const newestSourceMtimeMs = newestMtimeMs(sourceDirs);
  if (!cliMissing && cliMtimeMs >= newestSourceMtimeMs) return;

  const reason = cliMissing ? "missing client-tui/dist/cli.js" : "client-tui/dist/cli.js older than source";
  console.log(`tui:gate preflight: ${reason}; running pnpm --dir client-tui build`);
  const result = spawnSync("pnpm", ["--dir", "client-tui", "build"], {
    cwd: repoRoot,
    env,
    stdio: "inherit",
  });
  if (result.status !== 0) {
    throw new Error(`tui:gate preflight build failed (${result.status}); run pnpm --dir client-tui build`);
  }
}

function newestMtimeMs(paths) {
  let newest = 0;
  for (const candidate of paths) newest = Math.max(newest, newestMtimeInTree(candidate));
  return newest;
}

function newestMtimeInTree(targetPath) {
  if (!existsSync(targetPath)) return 0;
  const stat = statSync(targetPath);
  if (!stat.isDirectory()) return stat.mtimeMs;
  let newest = stat.mtimeMs;
  for (const entry of readdirSync(targetPath, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    newest = Math.max(newest, newestMtimeInTree(path.join(targetPath, entry.name)));
  }
  return newest;
}

function optionValue(argv, name, { required }) {
  const equals = argv.find((arg) => arg.startsWith(`${name}=`));
  if (equals) {
    const value = equals.slice(name.length + 1);
    if (!value && required) throw new Error(`${name} requires a value`);
    return value || null;
  }
  const index = argv.indexOf(name);
  if (index < 0) return null;
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    if (required) throw new Error(`${name} requires a value`);
    return null;
  }
  return value;
}

function safeName(value) {
  const safe = String(value).trim().replace(/[^A-Za-z0-9_.:@-]+/gu, "-").replace(/^-+|-+$/gu, "");
  if (!safe || safe === "." || safe === "..") throw new Error(`invalid TUI gate name: ${value}`);
  return safe;
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  try {
    const result = await runJourneyGate();
    process.exitCode = result.exitCode;
  } catch (error) {
    console.error(`tui:gate preflight failed: ${error?.stack ?? error}`);
    process.exitCode = 1;
  }
}
