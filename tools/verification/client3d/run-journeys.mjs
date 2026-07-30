#!/usr/bin/env node
// THE 3D CLIENT TEST HARNESS — per-system journey runner.
//
// Spins ONE shared vite + N scratch backends (claimed ports, teardown-asserted),
// drives the REAL client-3d in headless chromium through boot -> charselect ->
// spawn -> system journeys, and emits per-journey pass/fail + timing + a
// review-ready screenshot bundle + summary manifest. Joins the standing gates
// as `pnpm 3d:gate`.
//
// Ports: vite 29700, backends 29701.. (one per worker slot) — clear of the
// standing services and other claimed verification/farm ranges.
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

import { appendLedgerEntry, createRunId, repoSnapshot, writeJsonArtifact } from "../ledger.mjs";
import { Backend, Vite, buildPrerequisites, FORBIDDEN_PORTS, sweepStaleStack } from "./lib/stack.mjs";
import { loadChromium, launchBrowser, Session, JourneyAssertionError } from "./lib/browser.mjs";
import { runtimeUrl, writeCharacterStore, writePublicSlice, writeVerificationFixtureLoadouts } from "./lib/fixture.mjs";
import { delay, pickFreePort, repoRootFrom, writeJson } from "./lib/util.mjs";
import { journeys as allJourneys } from "./journeys/index.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = repoRootFrom(__dirname);

const args = parseArgs(process.argv.slice(2));
const runId = args.runId ?? createRunId("client3d-gate");
const artifactRel = path.join("verification", "ledgers", "artifacts", "client3d", runId);
const artifactsDir = path.join(repoRoot, artifactRel);
const defaultProofsDir = path.join(artifactsDir, "proofs");
const proofsDir = resolveProofsDir(args.proofsDir);
const vitePort = args.vitePort ?? 29700;
const backendBase = args.backendBase ?? 29701;
const startedAtIso = new Date().toISOString();
const started = performance.now();

fs.mkdirSync(artifactsDir, { recursive: true });
fs.mkdirSync(proofsDir, { recursive: true });

const selected = filterJourneys(allJourneys, args);
if (selected.length === 0) { console.error(`no journeys match ${JSON.stringify(args.only)}`); process.exit(2); }

const runnable = selected.filter((journey) => !journey.skip);
const skipped = selected.filter((journey) => journey.skip);
const concurrency = Math.max(1, Math.min(args.concurrency ?? 3, Math.max(1, runnable.length)));
const headed = args.headed || selected.some((journey) => journey.headed === true);

let vite = null;
let browser = null;
const results = [];
let chromiumInfo = null;

// Teardown registry: every live backend registers here so a fatal error OR a
// SIGINT/SIGTERM tears down the WHOLE scratch stack (vite + all backends), not
// just the per-journey finally paths. Idempotent; respects --keep.
const activeBackends = new Set();
let tornDown = false;
async function teardownAll() {
  if (tornDown) return;
  tornDown = true;
  if (!args.keep) {
    for (const backend of [...activeBackends]) { await backend.teardown().catch(() => {}); activeBackends.delete(backend); }
  }
  if (vite) await vite.stop();
  if (browser) await browser.close().catch(() => {});
}
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    console.error(`[3d:gate] ${sig} — tearing down scratch stack (vite + ${activeBackends.size} backend(s))…`);
    teardownAll().finally(() => {
      process.exit(sig === "SIGINT" ? 130 : 143);
    });
  });
}

try {
  if (!args.skipBuild) {
    console.log("[3d:gate] building rust bridge + server dist…");
    buildPrerequisites(repoRoot);
  }
  const loaded = loadChromium(repoRoot);
  chromiumInfo = loaded.resolvedFrom;

  // Clear a prior run's leaked scratch stack (SIGKILL/OOM survivors) BEFORE
  // claiming ports — guarded to the sole-runner case (never touches a live
  // concurrent run). The existing vite "refuse to hijack" check still fails
  // loud if a live server is genuinely present.
  const sweep = await sweepStaleStack(runId, vitePort, repoRoot, artifactsDir);
  if (sweep.swept.length > 0) console.log(`[3d:gate] startup sweep: cleared ${sweep.swept.length} leaked unit(s) from a prior run`);
  else if (sweep.skipped) console.log(`[3d:gate] startup sweep skipped (${sweep.skipped})`);
  vite = new Vite({ repoRoot, port: vitePort, runId, runDir: artifactsDir, logsDir: path.join(artifactsDir, "vite") });
  console.log(`[3d:gate] starting shared vite on ${vitePort}…`);
  await vite.start();

  // Headed mode starts the managed browser only after vite is ready so the
  // omp-headed-browser session receives a live local URL.
  browser = await launchBrowser(loaded.chromium, headed
    ? {
      headed: true,
      runId,
      url: vite.url,
    }
    : undefined);

  // Record skip-marked journeys up front.
  for (const journey of skipped) {
    results.push({
      id: journey.id, title: journey.title, status: "skip",
      reason: typeof journey.skip === "string" ? journey.skip : journey.skip?.reason ?? "skip-marked",
      durationMs: 0, failures: [], screenshots: [], bestShots: [], notes: [],
    });
    console.log(`[3d:gate] SKIP ${journey.id} — ${results.at(-1).reason}`);
  }

  // Weight-budget scheduler: two-browser journeys open 2 contexts, so they
  // count as 2 slots — this bounds total live chromium contexts (software-GL
  // thrash was the concurrency flake source) regardless of the journey mix.
  const budget = concurrency;
  const backendPorts = await allocateBackendPorts(budget, backendBase);
  const freePorts = [...backendPorts];
  let available = budget;
  const waiters = new Set();
  const acquire = async (weight) => {
    while (available < weight) await new Promise((resolve) => waiters.add(resolve));
    available -= weight;
    return freePorts.pop();
  };
  const release = (port, weight) => {
    freePorts.push(port);
    available += weight;
    for (const resolve of [...waiters]) { waiters.delete(resolve); resolve(); }
  };
  await Promise.all(runnable.map(async (journey) => {
    const weight = Math.min(budget, Math.max(1, journey.characters.length));
    const port = await acquire(weight);
    try {
      const result = await runJourney(journey, port).catch((error) => failureResult(journey, error));
      results.push(result);
      logResult(result);
    } finally {
      release(port, weight);
    }
  }));
} catch (error) {
  console.error(`[3d:gate] fatal: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  results.push({ id: "harness", title: "harness bootstrap", status: "fail", durationMs: 0, failures: [String(error?.message ?? error)], screenshots: [], bestShots: [], notes: [] });
} finally {
  await teardownAll();
}

const orderIndex = new Map(selected.map((journey, i) => [journey.id, i]));
results.sort((a, b) => (orderIndex.get(a.id) ?? 99) - (orderIndex.get(b.id) ?? 99));
const durationMs = Math.round(performance.now() - started);
const passed = results.filter((r) => r.status === "pass");
const failed = results.filter((r) => r.status === "fail");
const skips = results.filter((r) => r.status === "skip");
const status = failed.length === 0 ? "pass" : "fail";

const manifest = {
  schema: "successor.client3d-gate.v1",
  status, runId, startedAt: startedAtIso, completedAt: new Date().toISOString(), durationMs,
  chromium: chromiumInfo, vitePort, concurrency, headed,
  totals: { total: results.length, passed: passed.length, failed: failed.length, skipped: skips.length },
  journeys: results.map((r) => ({
    id: r.id, title: r.title, status: r.status, durationMs: r.durationMs,
    reason: r.reason ?? null, failures: r.failures,
    teardownOk: r.teardownOk ?? null,
    consoleErrors: r.consoleErrors ?? 0,
    screenshots: r.screenshots.map((s) => relProof(s.path)),
    bestShots: r.bestShots.map((s) => relProof(s.path)),
    notes: r.notes,
  })),
  bestShots: results.flatMap((r) => r.bestShots.map((s) => relProof(s.path))),
};
const manifestRel = await writeJsonArtifact(repoRoot, path.join(artifactRel, "client3d-gate-report.json"), manifest);
writeJson(path.join(artifactsDir, "client3d-gate-summary.json"), gateSummary(manifest));

await appendLedgerEntry(repoRoot, "client3d-gate-ledger", {
  runId, phase: "client3d-journey-harness", status,
  summary: status === "pass"
    ? `3d:gate passed ${passed.length} journey(s) in real chromium; ${skips.length} skip-marked; ${manifest.bestShots.length} proof shots.`
    : `3d:gate failed ${failed.length}/${runnable.length} journey(s): ${failed.map((r) => r.id).join(", ")}.`,
  repo: await repoSnapshot(repoRoot).catch(() => ({ root: repoRoot, error: "snapshot failed" })),
  command: { argv: ["pnpm", "3d:gate"], cwd: repoRoot, durationMs, exitCode: status === "pass" ? 0 : 1, signal: null },
  metrics: manifest.totals,
  artifacts: { report: manifestRel, proofs: path.relative(repoRoot, proofsDir) },
  details: { failures: failed.flatMap((r) => r.failures.map((f) => `${r.id}: ${f}`)) },
}).catch((error) => console.error(`[3d:gate] ledger append failed: ${error.message}`));

printSummary(manifest, manifestRel, path.relative(repoRoot, proofsDir));
process.exitCode = status === "pass" ? 0 : 1;

// ── journey execution ─────────────────────────────────────────────────────
async function runJourney(journey, backendPort) {
  const journeyStarted = performance.now();
  const journeyDir = path.join(artifactsDir, journey.id);
  fs.mkdirSync(journeyDir, { recursive: true });
  const storePath = writeCharacterStore(journeyDir, journey.characters);
  const verificationLoadoutsPath = writeVerificationFixtureLoadouts(journeyDir, journey.characters);
  // Per-journey world overlay (e.g. district-exchange): one scratch slice in
  // client/public so client + server load the identical file (hash match).
  const publicSlice = journey.serverSliceOverlay
    ? writePublicSlice(repoRoot, `h3d-${runId}-${journey.id}-slice`.replace(/[^a-zA-Z0-9_.-]+/gu, "-"), journey.serverSliceOverlay)
    : null;
  const backend = new Backend({ repoRoot, port: backendPort, runId: `${runId}-${journey.id}`, runDir: artifactsDir, storePath, verificationLoadoutsPath, slicePath: publicSlice?.absPath, logsDir: path.join(journeyDir, "logs") });
  activeBackends.add(backend);
  const openSessions = [];
  const bestShots = [];
  const notes = [];
  const failures = [];
  let teardownOk = null;

  try {
    await backend.boot();
    // Creation journeys declare characters:[] and drive charselect creation
    // themselves: open ONE primary session parked at charselect (no spawn URL,
    // no enterWorld) so buildContext has a primary and the journey can create +
    // enter a character via the real UI, then assert the result in-world.
    if (journey.characters.length === 0) {
      const session = new Session({ browser, name: `${journey.id}:primary`, gamePort: backendPort, vitePort, actorId: null, shotsDir: proofsDir, shotPrefix: `h3d-${journey.id}` });
      await session.open();
      await session.goto(runtimeUrl({ vitePort, gamePort: backendPort, slicePath: publicSlice?.urlPath, mapBundlePath: publicSlice?.bundleUrlPath }));
      openSessions.push({ role: "primary", session, spec: { role: "primary", id: null } });
    }
    for (const [i, spec] of journey.characters.entries()) {
      const role = spec.role ?? (i === 0 ? "primary" : `p${i}`);
      const shotPrefix = i === 0 ? `h3d-${journey.id}` : `h3d-${journey.id}-${role}`;
      const session = new Session({ browser, name: `${journey.id}:${role}`, gamePort: backendPort, vitePort, actorId: spec.id, shotsDir: proofsDir, shotPrefix });
      await session.open();
      const url = runtimeUrl({ vitePort, gamePort: backendPort, equip: spec.equip, slicePath: publicSlice?.urlPath, mapBundlePath: publicSlice?.bundleUrlPath });
      // Spawn is the flakiest step under concurrent software-GL load (charselect
      // render / first-frame connect); one clean re-navigate + retry absorbs a
      // transient miss so a healthy journey is never failed by a slow boot.
      await session.goto(url);
      try {
        await session.enterWorld(spec.id);
      } catch (spawnError) {
        notes.push(`spawn retry [${role}]: ${String(spawnError.message).split("\n")[0].slice(0, 120)}`);
        await session.goto(url);
        await session.enterWorld(spec.id);
      }
      openSessions.push({ role, session, spec });
    }
    const ctx = buildContext(journey, backend, openSessions, bestShots, notes);
    if (journey.arm) await journey.arm(ctx);
    await withTimeout(journey.run(ctx), journey.timeoutMs ?? 150000, `${journey.id} run`);
  } catch (error) {
    const message = error instanceof JourneyAssertionError ? error.message : (error?.stack ?? String(error));
    failures.push(message);
    // best-effort failure shot from the primary session.
    await openSessions[0]?.session.shot("FAIL").catch(() => {});
  } finally {
    for (const { session } of openSessions) await session.close().catch(() => {});
    if (!args.keep) {
      teardownOk = (await backend.teardown().catch((e) => ({ ok: false, failures: [e.message] }))).ok;
      activeBackends.delete(backend);
    }
    if (!args.keep) publicSlice?.cleanup();
  }

  const screenshots = openSessions.flatMap(({ session }) => session.screenshots);
  const consoleErrors = openSessions.reduce((sum, { session }) => sum + session.pageErrors.length, 0);
  if (consoleErrors > 0) {
    for (const { role, session } of openSessions) {
      for (const err of session.pageErrors) notes.push(`pageerror[${role}]: ${String(err.message).split("\n")[0].slice(0, 200)}`);
    }
  }
  return {
    id: journey.id, title: journey.title,
    status: failures.length === 0 && teardownOk !== false ? "pass" : "fail",
    durationMs: Math.round(performance.now() - journeyStarted),
    failures: [...failures, ...(teardownOk === false ? [`backend ${backend.unitService} did not stop cleanly`] : [])],
    teardownOk, consoleErrors, screenshots, bestShots, notes,
  };
}

function buildContext(journey, backend, openSessions, bestShots, notes) {
  const byRole = new Map(openSessions.map(({ role, session }) => [role, session]));
  const primary = openSessions[0].session;
  return {
    journey, backend, primary,
    sessions: byRole,
    session: (role) => {
      const s = byRole.get(role);
      if (!s) throw new Error(`journey ${journey.id} has no session role ${role}`);
      return s;
    },
    note: (msg) => { notes.push(String(msg)); },
    oracle: () => primary.oracle(),
    debugCommand: (command, session = primary) => session.debugCommand(command),
    shot: (step, session = primary, options = {}) => session.shot(step, options),
    moneyShot: async (step, session = primary, options = {}) => {
      const file = await session.shot(step, options);
      bestShots.push({ step, path: file });
      return file;
    },
    delay,
  };
}

function failureResult(journey, error) {
  return {
    id: journey.id, title: journey.title, status: "fail", durationMs: 0,
    failures: [error instanceof Error ? error.message : String(error)],
    screenshots: [], bestShots: [], notes: [], teardownOk: null, consoleErrors: 0,
  };
}

// ── helpers ────────────────────────────────────────────────────────────────
function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new JourneyAssertionError(`${label} exceeded ${ms}ms budget`)), ms); });
  return Promise.race([promise.finally(() => clearTimeout(timer)), timeout]);
}

async function allocateBackendPorts(count, base) {
  const ports = [];
  const claimed = new Set(FORBIDDEN_PORTS);
  claimed.add(vitePort);
  let cursor = base;
  for (let i = 0; i < count; i += 1) {
    const port = await pickFreePort(cursor, claimed);
    if (port > 29799) throw new Error(`backend port ${port} outside claimed 29700-29799 block`);
    claimed.add(port); ports.push(port); cursor = port + 1;
  }
  return ports;
}

function relProof(absPath) { return path.relative(repoRoot, absPath); }

function gateSummary(manifest) {
  const icon = (s) => (s === "pass" ? "✅" : s === "skip" ? "⏭️" : "❌");
  const lines = [
    `SUCCESSOR 3D CLIENT GATE — ${manifest.status.toUpperCase()}`,
    `${manifest.totals.passed}/${manifest.totals.passed + manifest.totals.failed} journeys green · ${manifest.totals.skipped} skipped · ${(manifest.durationMs / 1000).toFixed(0)}s`,
    "",
    ...manifest.journeys.map((j) => `${icon(j.status)} ${j.title}${j.status === "skip" ? ` — ${j.reason}` : j.status === "fail" ? ` — ${j.failures[0]?.slice(0, 120) ?? ""}` : ` (${(j.durationMs / 1000).toFixed(0)}s)`}`),
  ];
  return { text: lines.join("\n"), bestShots: manifest.bestShots, status: manifest.status, runId: manifest.runId };
}

function logResult(result) {
  const tag = result.status === "pass" ? "PASS" : result.status === "skip" ? "SKIP" : "FAIL";
  console.log(`[3d:gate] ${tag} ${result.id} (${(result.durationMs / 1000).toFixed(1)}s)${result.failures.length ? ` — ${result.failures[0].split("\n")[0].slice(0, 160)}` : ""}`);
}

function printSummary(manifest, manifestRel, proofsRel) {
  console.log(`\n[3d:gate] ${manifest.status.toUpperCase()} · ${manifest.totals.passed} pass / ${manifest.totals.failed} fail / ${manifest.totals.skipped} skip · ${(manifest.durationMs / 1000).toFixed(0)}s`);
  console.log(`[3d:gate] report: ${manifestRel}`);
  console.log(`[3d:gate] proofs: ${manifest.bestShots.length} review frames under ${proofsRel}/`);
  for (const j of manifest.journeys) {
    const mark = j.status === "pass" ? "✓" : j.status === "skip" ? "~" : "✗";
    console.log(`  ${mark} ${j.id}${j.status === "fail" ? `: ${j.failures[0]?.split("\n")[0].slice(0, 160)}` : ""}`);
  }
}

function filterJourneys(list, parsed) {
  if (!parsed.only || parsed.only.length === 0) return list;
  const wanted = new Set(parsed.only);
  return list.filter((journey) => wanted.has(journey.id));
}

function resolveProofsDir(value) {
  if (value === undefined) return defaultProofsDir;
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) throw new Error("--proofs-dir must be a non-empty path");
  const resolved = path.resolve(repoRoot, value);
  if (!path.isAbsolute(resolved)) throw new Error("--proofs-dir must resolve to an absolute path");
  return resolved;
}


function parseArgs(argv) {
  const out = { only: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--journey" || arg === "--only") out.only.push(argv[++i]);
    else if (arg.startsWith("--journey=")) out.only.push(arg.slice("--journey=".length));
    else if (arg.startsWith("--only=")) out.only.push(arg.slice("--only=".length));
    else if (arg === "--concurrency") out.concurrency = Number(argv[++i]);
    else if (arg.startsWith("--concurrency=")) out.concurrency = Number(arg.slice("--concurrency=".length));
    else if (arg === "--vite-port") out.vitePort = Number(argv[++i]);
    else if (arg.startsWith("--vite-port=")) out.vitePort = Number(arg.slice("--vite-port=".length));
    else if (arg === "--backend-base") out.backendBase = Number(argv[++i]);
    else if (arg.startsWith("--backend-base=")) out.backendBase = Number(arg.slice("--backend-base=".length));
    else if (arg === "--run-id") out.runId = argv[++i];
    else if (arg.startsWith("--run-id=")) out.runId = arg.slice("--run-id=".length);
    else if (arg === "--skip-build") out.skipBuild = true;
    else if (arg === "--headed") out.headed = true;
    else if (arg === "--proofs-dir") out.proofsDir = argv[++i];
    else if (arg.startsWith("--proofs-dir=")) out.proofsDir = arg.slice("--proofs-dir=".length);
    else if (arg === "--keep") out.keep = true;
    else throw new Error(`unknown option ${arg}`);
  }
  return out;
}
