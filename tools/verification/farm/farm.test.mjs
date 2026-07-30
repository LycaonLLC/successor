import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, it } from "node:test";

import { dispatchFarmRun, runVerificationFarm } from "./dispatch.mjs";
import { acquireHostLock } from "./host-lock.mjs";
import { buildVerifyMatrix } from "./matrix-report.mjs";
import { canonicalJson, checksumTree, sha256Json, validateResultEnvelope, verifyArtifactChecksums } from "./protocol.mjs";
import { createLocalSourceIdentity, createTreeSourceIdentity } from "./source-hash.mjs";
import { isPreservedCacheDirectory } from "./sync.mjs";
import { buildTaskGraph, buildVerificationPlan, createWorkerPlan, rematerializePlanForAttempt, RESOURCE_CLASSES, RESOURCE_CLASS_LIMITS, scheduleTasksLpt, taskDigest, updatedTimingHistory, validatePlan } from "./task-plan.mjs";
import { executeWorkerPlan } from "./worker.mjs";
import { selectVerificationTasks } from "../select.mjs";

const SOURCE_HASH = "a".repeat(64);
const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

async function withTempDirectory(prefix, callback) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  try {
    return await callback(directory);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

function capabilities({ node = true, rust = true } = {}) {
  return {
    host: { os: "linux" },
    toolchain: {
      node: { available: node },
      pnpm: { available: true },
      rustc: { available: rust },
      cargo: { available: rust },
      wasmTarget: { available: false },
    },
    runtime: {
      processHost: { available: true },
      playwright: { available: false, chromiumInstalled: false },
      ffmpeg: { available: false },
    },
    networking: { freePortRange: { start: 29_700, size: 32 } },
  };
}

function timingHistory(tasks = {}) {
  return {
    schema: "successor.farm-timings.v1",
    remoteOverheadMs: 0,
    referenceCores: 1,
    laneDefaultsMs: { node: 1_000, rust: 1_000 },
    tasks,
  };
}

async function createPlan(root, { source = { sourceHash: SOURCE_HASH, paths: ["fixture.txt"] }, task: taskOverrides = {} } = {}) {
  const checkout = path.join(root, "checkout");
  await fs.mkdir(path.join(checkout, "nested"), { recursive: true });
  return createWorkerPlan({
    runId: "run-1",
    hostAssignment: {
      host: {
        id: "host-a",
        transport: "local",
        checkout,
        capabilities: capabilities(),
      },
      tasks: [{
        id: "node:fixture",
        lane: "node",
        shard: "fixture",
        phase: 1,
        tier: "G1",
        category: "test",
        dependencies: [],
        required: true,
        optIn: false,
        defaultFresh: true,
        skipBuild: false,
        argv: [process.execPath, "-e", "process.exit(0)"],
        cwd: "nested",
        env: { TASK: "$TASK_RUN_ID", PORT: "$PORT0" },
        tags: ["node"],
        deadlineMs: 5_000,
        portCount: 1,
        artifactPaths: ["artifacts/$TASK_RUN_ID"],
        artifactDiscoveryRoots: [],
        digestGroup: null,
        ...taskOverrides,
      }],
    },
    source,
    deterministic: true,
  });
}

async function createMatchingPlan(root, task = {}) {
  const checkout = path.join(root, "checkout");
  await fs.mkdir(checkout, { recursive: true });
  await fs.writeFile(path.join(checkout, "fixture.txt"), "fixture source", "utf8");
  const source = await createTreeSourceIdentity({ root: checkout, expectedPaths: ["fixture.txt"], includeManifest: false });
  return createPlan(root, { source: { sourceHash: source.sourceHash, paths: ["fixture.txt"] }, task });
}

function fixtureTask(id, overrides = {}) {
  return {
    id,
    lane: "node",
    shard: id,
    phase: 1,
    tier: "G1",
    category: "test",
    dependencies: [],
    required: true,
    optIn: false,
    defaultFresh: true,
    skipBuild: false,
    argv: [process.execPath, "-e", "process.exit(0)"],
    cwd: "nested",
    env: {},
    tags: ["node"],
    deadlineMs: 1_000,
    portCount: 0,
    artifactPaths: [],
    artifactDiscoveryRoots: [],
    digestGroup: null,
    ...overrides,
  };
}

async function createMatchingPlanForTasks(root, tasks, { phase1Concurrency = 2 } = {}) {
  const checkout = path.join(root, "checkout");
  await fs.mkdir(path.join(checkout, "nested"), { recursive: true });
  await fs.writeFile(path.join(checkout, "fixture.txt"), "fixture source", "utf8");
  const source = await createTreeSourceIdentity({ root: checkout, expectedPaths: ["fixture.txt"], includeManifest: false });
  return createWorkerPlan({
    runId: "run-1",
    hostAssignment: {
      host: { id: "host-a", transport: "local", checkout, capabilities: capabilities() },
      tasks,
      phase1Concurrency,
    },
    source: { sourceHash: source.sourceHash, paths: ["fixture.txt"] },
    deterministic: true,
  });
}

function refreshPlanDigests(plan) {
  for (const task of plan.tasks) task.digest = taskDigest(task);
  const { digest, ...unsignedPlan } = plan;
  plan.digest = sha256Json(unsignedPlan);
  return plan;
}

function sourceManifest(sourceHash = SOURCE_HASH) {
  return {
    schema: "successor.source-manifest.v1",
    sourceHash,
    fileCount: 0,
    totalBytes: 0,
    entries: [],
  };
}

function resultFor(plan, executionAttempt = 0, status = "pass") {
  const task = plan.tasks[0];
  return {
    schema: "successor.farm-result.v1",
    runId: plan.runId,
    leaseId: plan.leaseId,
    host: { id: plan.host.id },
    sourceHash: plan.source.sourceHash,
    task: { id: task.id, digest: task.digest },
    executionAttempt,
    status,
    durationMs: 12,
    artifacts: [],
    ledgerEntries: [],
  };
}

function workerDocument(plan, executionAttempt, status) {
  const unsignedResult = resultFor(plan, executionAttempt, status);
  const result = { ...unsignedResult, checksum: sha256Json(unsignedResult) };
  const unsignedDocument = {
    schema: "successor.farm-worker.v1",
    executionAttempt,
    results: [result],
  };
  return { ...unsignedDocument, checksum: sha256Json(unsignedDocument) };
}

function resourceProbeProgram() {
  return [
    "const fs=require('node:fs');",
    "const root=process.env.TRACK_ROOT;",
    "const cls=process.env.TRACK_CLASS;",
    "const holdMs=Number(process.env.TRACK_HOLD_MS||50);",
    "const statePath=root+'/state.json';",
    "const lockPath=root+'/.lock';",
    "const mutate=(fn)=>{while(true){try{fs.mkdirSync(lockPath);break;}catch{}}let state=JSON.parse(fs.readFileSync(statePath,'utf8'));state=fn(state);fs.writeFileSync(statePath,JSON.stringify(state));fs.rmdirSync(lockPath);};",
    "mutate((state)=>{const barrier=cls==='exclusive'||cls==='browser';if(barrier?state.active>0:state.exclusive>0||state.browser>0)state.violations++;state.active++;state.activeByClass[cls]=(state.activeByClass[cls]||0)+1;if(cls==='exclusive')state.exclusive++;if(cls==='browser')state.browser++;state.max=Math.max(state.max,state.active);state.maxByClass[cls]=Math.max(state.maxByClass[cls]||0,state.activeByClass[cls]);state.started[cls]=(state.started[cls]||0)+1;return state;});",
    "setTimeout(()=>{mutate((state)=>{state.active--;state.activeByClass[cls]--;if(cls==='exclusive')state.exclusive--;if(cls==='browser')state.browser--;return state;});process.exit(0);},holdMs);",
  ].join("");
}

describe("farm verification contracts", () => {
  it("keeps plan digests stable when optional properties are omitted rather than set to undefined", () => {
    const withUndefinedOptionals = {
      z: [undefined, { extra: undefined, value: "ok" }],
      optional: undefined,
      task: { deadlineMs: 5_000, digestGroup: undefined },
    };
    const withoutOptionals = {
      task: { deadlineMs: 5_000 },
      z: [undefined, { value: "ok" }],
    };

    assert.strictEqual(canonicalJson(withUndefinedOptionals), canonicalJson(withoutOptionals));
    assert.strictEqual(sha256Json(withUndefinedOptionals), sha256Json(withoutOptionals));
  });

  it("traverses cache parents while preserving only the cache roots", () => {
    const packageRoots = new Set(["", "desktop"]);
    assert.strictEqual(isPreservedCacheDirectory("verification", packageRoots), false);
    assert.strictEqual(isPreservedCacheDirectory("verification/.runs", packageRoots), true);
    assert.strictEqual(isPreservedCacheDirectory("desktop", packageRoots), false);
    assert.strictEqual(isPreservedCacheDirectory("desktop/release", packageRoots), true);
  });

  it("materializes every task CWD beneath the assigned host checkout", async () => {
    await withTempDirectory("successor-farm-plan-", async (root) => {
      const plan = await createPlan(root);

      assert.strictEqual(plan.host.checkout, path.join(root, "checkout"));
      assert.strictEqual(plan.tasks[0].cwd, path.join(root, "checkout", "nested"));
      assert.ok(!plan.tasks[0].cwd.includes(".."));
    });
  });
  it("materializes the full-farm desktop task with the dirty-fixture override because its source hash binds the current working tree, not the committed baseline", async () => {
    const desktopTemplate = (await buildTaskGraph({ root: REPOSITORY_ROOT, lanes: ["desktop"] }))
      .find((task) => task.id === "desktop:smoke");
    assert.ok(desktopTemplate, "desktop smoke task must be registered");
    const plan = createWorkerPlan({
      runId: "run-desktop-dirty-source",
      hostAssignment: {
        host: {
          id: "host-a",
          transport: "local",
          checkout: REPOSITORY_ROOT,
          capabilities: capabilities(),
        },
        tasks: [desktopTemplate],
        phase1Concurrency: 1,
      },
      source: { sourceHash: SOURCE_HASH, paths: ["fixture.txt"] },
      deterministic: true,
    });
    const desktopTask = plan.tasks.find((task) => task.id === "desktop:smoke");
    assert.ok(desktopTask);
    assert.strictEqual(plan.source.sourceHash, SOURCE_HASH);
    assert.strictEqual(desktopTask.env.DESKTOP_SMOKE_ALLOW_DIRTY_FIXTURE, "1");
    assert.strictEqual(desktopTask.env.DESKTOP_SMOKE_SKIP_BUILD, "1");
  });

  it("assigns longest eligible work to capability-compatible hosts using LPT", () => {
    const tasks = [
      { id: "node:long", lane: "node", tags: ["node"] },
      { id: "rust:medium", lane: "rust", tags: ["rust"] },
      { id: "node:short", lane: "node", tags: ["node"] },
    ];
    const hosts = [
      { id: "rust-only", transport: "local", coreWeight: 1, capabilities: capabilities({ node: false, rust: true }) },
      { id: "node-and-rust", transport: "local", coreWeight: 1, capabilities: capabilities({ node: true, rust: true }) },
    ];
    const assignments = scheduleTasksLpt({
      tasks,
      hosts,
      timings: timingHistory({
        "node:long": { medianMs: 900 },
        "rust:medium": { medianMs: 500 },
        "node:short": { medianMs: 100 },
      }),
    });

    assert.deepEqual(assignments.map((assignment) => ({
      host: assignment.host.id,
      tasks: assignment.tasks.map((task) => task.id),
    })), [
      { host: "rust-only", tasks: ["rust:medium"] },
      { host: "node-and-rust", tasks: ["node:long", "node:short"] },
    ]);
  });
  it("caps backend scenarios at four and keeps browser-heavy work host-exclusive", async () => {
    await withTempDirectory("successor-farm-resource-caps-", async (root) => {
      const trackRoot = path.join(root, "track");
      await fs.mkdir(trackRoot);
      await fs.writeFile(path.join(trackRoot, "state.json"), JSON.stringify({ active: 0, activeByClass: {}, exclusive: 0, browser: 0, max: 0, maxByClass: {}, violations: 0, started: {} }), "utf8");
      const tasks = [
        ...Array.from({ length: 6 }, (_, index) => fixtureTask(`accel:backend-${index}`, { resourceClass: RESOURCE_CLASSES.BACKEND_SCENARIO, argv: [process.execPath, "-e", resourceProbeProgram()], env: { TRACK_ROOT: trackRoot, TRACK_CLASS: "backend" } })),
        ...Array.from({ length: 5 }, (_, index) => fixtureTask(`3d:browser-${index}`, { resourceClass: RESOURCE_CLASSES.BROWSER_HEAVY, argv: [process.execPath, "-e", resourceProbeProgram()], env: { TRACK_ROOT: trackRoot, TRACK_CLASS: "browser" } })),
      ];
      const plan = await createMatchingPlanForTasks(root, tasks, { phase1Concurrency: 4 });
      const worker = await executeWorkerPlan({ plan, root: plan.host.checkout, artifactRoot: path.join(root, "results"), lockRoot: path.join(root, "locks"), capabilities: capabilities() });
      const state = JSON.parse(await fs.readFile(path.join(trackRoot, "state.json"), "utf8"));
      assert.strictEqual(worker.status, "pass");
      assert.strictEqual(state.violations, 0);
      assert.ok(state.maxByClass.backend <= 4);
      assert.strictEqual(state.maxByClass.browser, 1);
      assert.ok(state.max <= 4);
      assert.deepEqual(state.started, { backend: 6, browser: 5 });
    });
  });
  it("caps headless tasks at the configured limit while backend and cpu-light workers retain their independent overlap", async () => {
    await withTempDirectory("successor-farm-headless-cap-", async (root) => {
      const trackRoot = path.join(root, "track");
      await fs.mkdir(trackRoot);
      await fs.writeFile(path.join(trackRoot, "state.json"), JSON.stringify({ active: 0, activeByClass: {}, exclusive: 0, browser: 0, max: 0, maxByClass: {}, violations: 0, started: {} }), "utf8");
      const tasks = [
        ...Array.from({ length: 5 }, (_, index) => fixtureTask(`tui:headless-${index}`, {
          resourceClass: RESOURCE_CLASSES.HEADLESS,
          argv: [process.execPath, "-e", resourceProbeProgram()],
          env: { TRACK_ROOT: trackRoot, TRACK_CLASS: "headless", TRACK_HOLD_MS: "200" },
        })),
        ...Array.from({ length: 6 }, (_, index) => fixtureTask(`accel:backend-${index}`, {
          resourceClass: RESOURCE_CLASSES.BACKEND_SCENARIO,
          argv: [process.execPath, "-e", resourceProbeProgram()],
          env: { TRACK_ROOT: trackRoot, TRACK_CLASS: "backend", TRACK_HOLD_MS: "200" },
        })),
        ...Array.from({ length: 6 }, (_, index) => fixtureTask(`node:cpu-light-${index}`, {
          resourceClass: RESOURCE_CLASSES.CPU_LIGHT,
          argv: [process.execPath, "-e", resourceProbeProgram()],
          env: { TRACK_ROOT: trackRoot, TRACK_CLASS: "cpu-light", TRACK_HOLD_MS: "200" },
        })),
      ];
      const plan = await createMatchingPlanForTasks(root, tasks, { phase1Concurrency: 4 });
      const worker = await executeWorkerPlan({ plan, root: plan.host.checkout, artifactRoot: path.join(root, "results"), lockRoot: path.join(root, "locks"), capabilities: capabilities() });
      const state = JSON.parse(await fs.readFile(path.join(trackRoot, "state.json"), "utf8"));
      assert.strictEqual(worker.status, "pass");
      assert.strictEqual(state.violations, 0);
      assert.strictEqual(state.maxByClass.headless, RESOURCE_CLASS_LIMITS[RESOURCE_CLASSES.HEADLESS]);
      assert.strictEqual(state.maxByClass.backend, 4);
      assert.ok(state.maxByClass["cpu-light"] > RESOURCE_CLASS_LIMITS[RESOURCE_CLASSES.HEADLESS], "cpu-light must retain more than the headless cap");
      assert.ok(state.max >= 4, `headless cap must not collapse backend or cpu-light overlap: ${JSON.stringify(state)}`);
    });
  });


  it("blocks browser-heavy work against headless, backend, realtime, and desktop runtime classes while ordinary classes overlap", async () => {
    await withTempDirectory("successor-farm-browser-barrier-", async (root) => {
      const trackRoot = path.join(root, "track");
      await fs.mkdir(trackRoot);
      await fs.writeFile(path.join(trackRoot, "state.json"), JSON.stringify({ active: 0, activeByClass: {}, exclusive: 0, browser: 0, max: 0, maxByClass: {}, violations: 0, started: {} }), "utf8");
      const tasks = [
        fixtureTask("node:headless", { resourceClass: RESOURCE_CLASSES.HEADLESS, argv: [process.execPath, "-e", resourceProbeProgram()], env: { TRACK_ROOT: trackRoot, TRACK_CLASS: "headless" } }),
        fixtureTask("accel:backend", { resourceClass: RESOURCE_CLASSES.BACKEND_SCENARIO, argv: [process.execPath, "-e", resourceProbeProgram()], env: { TRACK_ROOT: trackRoot, TRACK_CLASS: "backend" } }),
        fixtureTask("realtime:runtime", { resourceClass: RESOURCE_CLASSES.EXCLUSIVE, argv: [process.execPath, "-e", resourceProbeProgram()], env: { TRACK_ROOT: trackRoot, TRACK_CLASS: "exclusive" } }),
        fixtureTask("desktop:runtime", { resourceClass: RESOURCE_CLASSES.EXCLUSIVE, argv: [process.execPath, "-e", resourceProbeProgram()], env: { TRACK_ROOT: trackRoot, TRACK_CLASS: "exclusive" } }),
        fixtureTask("3d:browser", { resourceClass: RESOURCE_CLASSES.BROWSER_HEAVY, argv: [process.execPath, "-e", resourceProbeProgram()], env: { TRACK_ROOT: trackRoot, TRACK_CLASS: "browser" } }),
      ];
      const plan = await createMatchingPlanForTasks(root, tasks, { phase1Concurrency: 4 });
      const worker = await executeWorkerPlan({ plan, root: plan.host.checkout, artifactRoot: path.join(root, "results"), lockRoot: path.join(root, "locks"), capabilities: capabilities() });
      const state = JSON.parse(await fs.readFile(path.join(trackRoot, "state.json"), "utf8"));
      assert.strictEqual(worker.status, "pass");
      assert.strictEqual(state.violations, 0);
      assert.strictEqual(state.maxByClass.browser, 1);
      assert.ok(state.maxByClass.headless >= 1);
      assert.ok(state.maxByClass.backend >= 1);
      assert.ok(state.max >= 2, "non-browser work should retain normal concurrency");
      assert.strictEqual(state.started.browser, 1);
      assert.strictEqual(state.started.headless, 1);
      assert.strictEqual(state.started.backend, 1);
      assert.strictEqual(state.started.exclusive, 2);
    });
  });
  it("runs one browser task beside two non-browser tasks without timeline overlap", async () => {
    await withTempDirectory("successor-farm-browser-representative-", async (root) => {
      const trackRoot = path.join(root, "track");
      await fs.mkdir(trackRoot);
      await fs.writeFile(path.join(trackRoot, "state.json"), JSON.stringify({ active: 0, activeByClass: {}, exclusive: 0, browser: 0, max: 0, maxByClass: {}, violations: 0, started: {} }), "utf8");
      const tasks = [
        fixtureTask("node:headless-representative", { resourceClass: RESOURCE_CLASSES.HEADLESS, argv: [process.execPath, "-e", resourceProbeProgram()], env: { TRACK_ROOT: trackRoot, TRACK_CLASS: "headless" } }),
        fixtureTask("accel:backend-representative", { resourceClass: RESOURCE_CLASSES.BACKEND_SCENARIO, argv: [process.execPath, "-e", resourceProbeProgram()], env: { TRACK_ROOT: trackRoot, TRACK_CLASS: "backend" } }),
        fixtureTask("3d:browser-representative", { resourceClass: RESOURCE_CLASSES.BROWSER_HEAVY, argv: [process.execPath, "-e", resourceProbeProgram()], env: { TRACK_ROOT: trackRoot, TRACK_CLASS: "browser" } }),
      ];
      const plan = await createMatchingPlanForTasks(root, tasks, { phase1Concurrency: 3 });
      const worker = await executeWorkerPlan({ plan, root: plan.host.checkout, artifactRoot: path.join(root, "results"), lockRoot: path.join(root, "locks"), capabilities: capabilities() });
      const state = JSON.parse(await fs.readFile(path.join(trackRoot, "state.json"), "utf8"));
      assert.strictEqual(worker.status, "pass");
      assert.deepEqual(worker.results.map((result) => result.status), ["pass", "pass", "pass"]);
      assert.strictEqual(state.active, 0);
      assert.strictEqual(state.violations, 0);
      assert.strictEqual(state.maxByClass.browser, 1);
      assert.ok(state.max >= 2, "headless and backend retain normal overlap before browser barrier");
      assert.deepEqual(state.started, { backend: 1, browser: 1, headless: 1 });
    });
  });

  it("keeps exclusive realtime/desktop/load work alone from every other resource class", async () => {
    await withTempDirectory("successor-farm-resource-exclusive-", async (root) => {
      const trackRoot = path.join(root, "track");
      await fs.mkdir(trackRoot);
      await fs.writeFile(path.join(trackRoot, "state.json"), JSON.stringify({ active: 0, activeByClass: {}, exclusive: 0, browser: 0, max: 0, maxByClass: {}, violations: 0, started: {} }), "utf8");
      const tasks = [
        fixtureTask("realtime:exclusive-a", { resourceClass: RESOURCE_CLASSES.EXCLUSIVE, argv: [process.execPath, "-e", resourceProbeProgram()], env: { TRACK_ROOT: trackRoot, TRACK_CLASS: "exclusive" } }),
        fixtureTask("node:ordinary-a", { argv: [process.execPath, "-e", resourceProbeProgram()], env: { TRACK_ROOT: trackRoot, TRACK_CLASS: "ordinary" } }),
        fixtureTask("desktop:exclusive-b", { resourceClass: RESOURCE_CLASSES.EXCLUSIVE, argv: [process.execPath, "-e", resourceProbeProgram()], env: { TRACK_ROOT: trackRoot, TRACK_CLASS: "exclusive" } }),
        fixtureTask("node:ordinary-b", { argv: [process.execPath, "-e", resourceProbeProgram()], env: { TRACK_ROOT: trackRoot, TRACK_CLASS: "ordinary" } }),
      ];
      const plan = await createMatchingPlanForTasks(root, tasks, { phase1Concurrency: 4 });
      const worker = await executeWorkerPlan({ plan, root: plan.host.checkout, artifactRoot: path.join(root, "results"), lockRoot: path.join(root, "locks"), capabilities: capabilities() });
      const state = JSON.parse(await fs.readFile(path.join(trackRoot, "state.json"), "utf8"));
      assert.strictEqual(worker.status, "pass");
      assert.strictEqual(state.violations, 0);
      assert.strictEqual(state.started.exclusive, 2);
      assert.strictEqual(state.started.ordinary, 2);
    });
  });


  it("persists bounded observed duration samples and updates LPT medians", () => {
    const timings = timingHistory({ "node:fixture": { samplesMs: [10, 20], medianMs: 20 } });
    const updated = updatedTimingHistory(timings, [
      { task: { id: "node:fixture" }, status: "pass", durationMs: 30 },
      { task: { id: "node:fixture" }, status: "killed", durationMs: 40 },
      { task: { id: "node:ignored" }, status: "refused", durationMs: 50 },
    ]);
    assert.deepEqual(updated.tasks["node:fixture"], { samplesMs: [10, 20, 30, 40], medianMs: 30 });
    assert.strictEqual(updated.tasks["node:ignored"], undefined);
  });

  it("allows exactly one atomic checkout-lock owner and refuses a lock lacking an owner record", async () => {
    await withTempDirectory("successor-farm-lock-", async (root) => {
      const contenders = await Promise.allSettled([
        acquireHostLock({ runId: "run-one", leaseId: "lease-one", hostId: "host-a", root }),
        acquireHostLock({ runId: "run-two", leaseId: "lease-two", hostId: "host-a", root }),
      ]);
      const acquired = contenders.filter((outcome) => outcome.status === "fulfilled");
      const refused = contenders.filter((outcome) => outcome.status === "rejected");

      assert.strictEqual(acquired.length, 1);
      assert.strictEqual(refused.length, 1);
      assert.strictEqual(refused[0].reason.code, "HOST_LOCKED");
      await acquired[0].value.release();

      await fs.writeFile(path.join(root, "checkout.lock"), "{not-json", "utf8");
      await assert.rejects(
        acquireHostLock({ runId: "run-three", leaseId: "lease-three", hostId: "host-a", root }),
        (error) => error?.code === "HOST_LOCK_CORRUPT",
      );
    });
  });

  it("rejects result envelopes whose source, task, host, lease, run, or retry attempt do not match the plan", async () => {
    await withTempDirectory("successor-farm-result-", async (root) => {
      const plan = await createPlan(root);
      const valid = resultFor(plan);
      assert.strictEqual(validateResultEnvelope(valid, { plan, executionAttempt: 0 }), valid);

      const cases = [
        ["source", { sourceHash: "b".repeat(64) }],
        ["host", { host: { id: "host-b" } }],
        ["lease", { leaseId: "lease-other" }],
        ["run", { runId: "run-other" }],
        ["task", { task: { id: "node:other", digest: valid.task.digest } }],
        ["attempt", { executionAttempt: 1 }],
      ];
      for (const [name, replacement] of cases) {
        const result = { ...valid, ...replacement };
        assert.throws(
          () => validateResultEnvelope(result, { plan, executionAttempt: 0 }),
          (error) => error?.code === "RESULT_BINDING_MISMATCH",
          name,
        );
      }
    });
  });

  it("rejects collected artifact reports when a reported file changes or disappears", async () => {
    await withTempDirectory("successor-farm-artifacts-", async (root) => {
      await fs.mkdir(path.join(root, "artifacts"));
      const report = path.join(root, "artifacts", "result.txt");
      await fs.writeFile(report, "trusted result", "utf8");
      const artifacts = await checksumTree(root, ["artifacts"]);
      assert.deepEqual(await verifyArtifactChecksums(root, artifacts), { ok: true, failures: [] });

      await fs.writeFile(report, "tampered result", "utf8");
      const checksumFailure = await verifyArtifactChecksums(root, artifacts);
      assert.strictEqual(checksumFailure.ok, false);
      assert.strictEqual(checksumFailure.failures[0].path, "artifacts/result.txt");
      assert.notStrictEqual(checksumFailure.failures[0].actual, artifacts[0].sha256);

      await fs.rm(report);
      const missingFailure = await verifyArtifactChecksums(root, artifacts);
      assert.strictEqual(missingFailure.ok, false);
      assert.deepEqual(missingFailure.failures[0], { path: "artifacts/result.txt", error: "ENOENT" });
    });
  });

  it("keeps a chrome-profile symlink outside collected roots while rejecting any durable artifact symlink", async () => {
    await withTempDirectory("successor-farm-profile-boundary-", async (root) => {
      const artifactsRoot = path.join(root, "artifacts");
      const runtimeRoot = path.join(root, "runtime");
      await fs.mkdir(artifactsRoot, { recursive: true });
      await fs.mkdir(runtimeRoot, { recursive: true });
      await fs.writeFile(path.join(artifactsRoot, "durable-report.json"), "{\"status\":\"pass\"}\n", "utf8");
      await fs.symlink("/tmp", path.join(runtimeRoot, "chrome-profile"));

      const collected = await checksumTree(root, ["artifacts"]);
      assert.deepEqual(collected.map((artifact) => artifact.path), ["artifacts/durable-report.json"]);

      await fs.symlink("/tmp", path.join(artifactsRoot, "unrelated-link"));
      await assert.rejects(
        () => checksumTree(root, ["artifacts"]),
        (error) => error?.code === "UNSAFE_ARTIFACT" && /unrelated-link/u.test(error.message),
      );
    });
  });
  it("refuses a worker plan when the checkout source hash does not match its bound source", async () => {
    await withTempDirectory("successor-farm-source-mismatch-", async (root) => {
      const plan = await createPlan(root);
      const worker = await executeWorkerPlan({
        plan,
        root: plan.host.checkout,
        artifactRoot: path.join(root, "results"),
        lockRoot: path.join(root, "locks"),
        capabilities: capabilities(),
      });

      assert.strictEqual(worker.status, "refused");
      assert.strictEqual(worker.results[0].status, "refused");
      assert.strictEqual(worker.results[0].reason.code, "SOURCE_MISMATCH");
      assert.strictEqual(worker.results[0].sourceHash, plan.source.sourceHash);
      assert.strictEqual(worker.results[0].task.digest, plan.tasks[0].digest);
    });
  });

  it("refuses a result when a started task changes its source after the initial firewall and retains command evidence", async () => {
    await withTempDirectory("successor-farm-source-drift-", async (root) => {
      const fixturePath = path.join(root, "checkout", "fixture.txt");
      const plan = await createMatchingPlan(root, {
        argv: [process.execPath, "-e", "require('node:fs').writeFileSync(process.env.FIXTURE_PATH, 'mutated source')"],
        env: { FIXTURE_PATH: fixturePath },
        artifactPaths: [],
      });
      const worker = await executeWorkerPlan({
        plan,
        root: plan.host.checkout,
        artifactRoot: path.join(root, "results"),
        lockRoot: path.join(root, "locks"),
        capabilities: capabilities(),
      });

      assert.strictEqual(worker.status, "refused");
      assert.strictEqual(worker.source.initial.match, true);
      assert.strictEqual(worker.source.final.match, false);
      assert.strictEqual(worker.results[0].reason.code, "SOURCE_CHANGED_DURING_EXECUTION");
      assert.ok(worker.results[0].artifacts.length >= 3);
      assert.deepEqual(await verifyArtifactChecksums(worker.artifactRoot, worker.results[0].artifacts), { ok: true, failures: [] });
    });
  });

  it("kills a task that exceeds its explicit deadline and reports a bound deadline failure", async () => {
    await withTempDirectory("successor-farm-deadline-", async (root) => {
      const plan = await createMatchingPlan(root, {
        argv: [process.execPath, "-e", "setInterval(() => {}, 1_000)"],
        deadlineMs: 40,
        artifactPaths: [],
      });
      const worker = await executeWorkerPlan({
        plan,
        root: plan.host.checkout,
        artifactRoot: path.join(root, "results"),
        lockRoot: path.join(root, "locks"),
        capabilities: capabilities(),
      });

      assert.strictEqual(worker.status, "killed");
      assert.strictEqual(worker.results[0].status, "killed");
      assert.strictEqual(worker.results[0].reason.code, "TASK_DEADLINE_EXCEEDED");
      assert.strictEqual(worker.results[0].executionAttempt, 0);
      assert.ok(worker.results[0].artifacts.length >= 3);
      assert.deepEqual(await verifyArtifactChecksums(worker.artifactRoot, worker.results[0].artifacts), { ok: true, failures: [] });
      assert.throws(
        () => validateResultEnvelope({ ...worker.results[0], artifacts: [] }, { plan, executionAttempt: 0 }),
        (error) => error?.code === "EMPTY_COMMAND_ARTIFACTS",
      );
    });
  });

  it("releases the host lock after a failed task so a later run can cleanly acquire it", async () => {
    await withTempDirectory("successor-farm-cleanup-", async (root) => {
      const plan = await createMatchingPlan(root, {
        argv: [process.execPath, "-e", "process.exit(7)"],
        artifactPaths: [],
      });
      const lockRoot = path.join(root, "locks");
      const worker = await executeWorkerPlan({
        plan,
        root: plan.host.checkout,
        artifactRoot: path.join(root, "results"),
        lockRoot,
        capabilities: capabilities(),
      });
      assert.strictEqual(worker.status, "fail");
      const lock = await acquireHostLock({ runId: "cleanup-check", leaseId: "cleanup-check", hostId: plan.host.id, root: lockRoot });
      await lock.release();
    });
  });

  it("reports a bound cancellation without starting an already-aborted task", async () => {
    await withTempDirectory("successor-farm-cancel-", async (root) => {
      const plan = await createMatchingPlan(root, { artifactPaths: [] });
      const controller = new AbortController();
      controller.abort();
      const worker = await executeWorkerPlan({
        plan,
        root: plan.host.checkout,
        artifactRoot: path.join(root, "results"),
        lockRoot: path.join(root, "locks"),
        capabilities: capabilities(),
        signal: controller.signal,
      });

      assert.strictEqual(worker.status, "killed");
      assert.strictEqual(worker.results[0].status, "killed");
      assert.strictEqual(worker.results[0].reason.code, "CANCELLED");
      assert.strictEqual(worker.results[0].task.digest, plan.tasks[0].digest);
    });
  });
  it("fails closed on unsigned, empty, or incomplete worker documents", async () => {
    await withTempDirectory("successor-farm-worker-document-", async (root) => {
      const plan = await createMatchingPlan(root);
      await assert.rejects(
        dispatchFarmRun({
          plans: [plan],
          maxAttempts: 1,
          workerRunner: async ({ plan: workerPlan, executionAttempt }) => {
            const document = workerDocument(workerPlan, executionAttempt, "pass");
            delete document.checksum;
            return document;
          },
        }),
        (error) => error?.code === "WORKER_RESULT_CHECKSUM_MISMATCH",
      );
      await assert.rejects(
        dispatchFarmRun({
          plans: [plan],
          maxAttempts: 1,
          workerRunner: async () => ({
            schema: "successor.farm-worker.v1",
            executionAttempt: 0,
            results: [],
            checksum: sha256Json({
              schema: "successor.farm-worker.v1",
              executionAttempt: 0,
              results: [],
            }),
          }),
        }),
        (error) => error?.code === "WORKER_RESULT_COVERAGE_MISMATCH",
      );
    });
  });


  it("retries a failed task once and quarantines a recovery without allowing a green dispatch", async () => {
    await withTempDirectory("successor-farm-flaky-", async (root) => {
      const plan = await createPlan(root);
      const executions = [];
      const seenPlans = [];
      const dispatch = await dispatchFarmRun({
        plans: [plan],
        artifactRoot: path.join(root, "results"),
        lockRoot: path.join(root, "locks"),
        maxAttempts: 2,
        workerRunner: async ({ plan: retryPlan, executionAttempt }) => {
          executions.push(executionAttempt);
          seenPlans.push(retryPlan);
          return workerDocument(retryPlan, executionAttempt, executionAttempt === 0 ? "fail" : "pass");
        },
      });

      assert.deepEqual(executions, [0, 1]);
      assert.strictEqual(dispatch.status, "fail");
      assert.strictEqual(dispatch.attempts.length, 2);
      assert.strictEqual(seenPlans[0].attempt, 0);
      assert.strictEqual(seenPlans[1].attempt, 1);
      assert.strictEqual(seenPlans[0].tasks[0].taskRunId.endsWith("-a0"), true);
      assert.strictEqual(seenPlans[1].tasks[0].taskRunId.endsWith("-a1"), true);
      const manualRetry = rematerializePlanForAttempt(plan, [plan.tasks[0].id], 1);
      assert.strictEqual(manualRetry.tasks[0].taskRunId, seenPlans[1].tasks[0].taskRunId);
      assert.strictEqual(manualRetry.tasks[0].digest, seenPlans[1].tasks[0].digest);
      assert.notStrictEqual(manualRetry.digest, plan.digest);
      assert.notStrictEqual(seenPlans[0].tasks[0].taskRunId, seenPlans[1].tasks[0].taskRunId);
      assert.notStrictEqual(seenPlans[0].tasks[0].statePaths.runDir, seenPlans[1].tasks[0].statePaths.runDir);
      assert.notStrictEqual(seenPlans[0].tasks[0].env.SUCCESSOR_PROCESS_RUN_DIR, seenPlans[1].tasks[0].env.SUCCESSOR_PROCESS_RUN_DIR);
      assert.notStrictEqual(seenPlans[0].tasks[0].artifactPaths[0], seenPlans[1].tasks[0].artifactPaths[0]);
      assert.notStrictEqual(seenPlans[0].tasks[0].digest, seenPlans[1].tasks[0].digest);
      assert.ok(seenPlans[1].tasks[0].artifactPaths[0].includes("-a1"));
      assert.ok(seenPlans[1].tasks[0].env.SUCCESSOR_PROCESS_RUN_ID.endsWith("-a1"));
      assert.strictEqual(dispatch.taskOutcomes.length, 1);
      assert.strictEqual(dispatch.taskOutcomes[0].status, "quarantined");
      assert.strictEqual(dispatch.taskOutcomes[0].gateStatus, "fail");
      assert.strictEqual(dispatch.taskOutcomes[0].quarantine.code, "FLAKY_RECOVERY");
      assert.strictEqual(dispatch.taskOutcomes[0].task.digest, plan.tasks[0].digest);
      assert.deepEqual(dispatch.taskOutcomes[0].attempts.map((attempt) => attempt.executionAttempt), [0, 1]);
      assert.notStrictEqual(dispatch.taskOutcomes[0].attempts[0].task.digest, dispatch.taskOutcomes[0].attempts[1].task.digest);
      assert.strictEqual(dispatch.matrix.status, "fail");
      assert.strictEqual(dispatch.matrix.tasks.length, 1);
      assert.strictEqual(dispatch.matrix.tasks[0].status, "quarantined");
      assert.strictEqual(dispatch.matrix.tasks[0].gateStatus, "fail");
      assert.strictEqual(dispatch.matrix.tasks[0].digest, plan.tasks[0].digest);
      assert.strictEqual(dispatch.matrix.durations.sumTaskMs, 24);
    });
  });

  it("marks a repeated failure deterministic and keeps the farm result failed", async () => {
    await withTempDirectory("successor-farm-deterministic-", async (root) => {
      const plan = await createPlan(root);
      const seenPlans = [];
      const dispatch = await dispatchFarmRun({
        plans: [plan],
        artifactRoot: path.join(root, "results"),
        lockRoot: path.join(root, "locks"),
        maxAttempts: 2,
        workerRunner: async ({ plan: retryPlan, executionAttempt }) => {
          seenPlans.push(retryPlan);
          return workerDocument(retryPlan, executionAttempt, "fail");
        },
      });

      assert.strictEqual(dispatch.status, "fail");
      assert.strictEqual(seenPlans[1].attempt, 1);
      assert.strictEqual(seenPlans[1].tasks[0].taskRunId.endsWith("-a1"), true);
      assert.notStrictEqual(seenPlans[0].tasks[0].taskRunId, seenPlans[1].tasks[0].taskRunId);
      assert.notStrictEqual(seenPlans[0].tasks[0].statePaths.storePath, seenPlans[1].tasks[0].statePaths.storePath);
      assert.notStrictEqual(seenPlans[0].tasks[0].env.SUCCESSOR_FARM_STORE_PATH, seenPlans[1].tasks[0].env.SUCCESSOR_FARM_STORE_PATH);
      assert.notStrictEqual(seenPlans[0].tasks[0].artifactPaths[0], seenPlans[1].tasks[0].artifactPaths[0]);
      assert.notStrictEqual(seenPlans[0].tasks[0].digest, seenPlans[1].tasks[0].digest);
      assert.strictEqual(dispatch.taskOutcomes.length, 1);
      assert.strictEqual(dispatch.taskOutcomes[0].status, "fail");
      assert.strictEqual(dispatch.taskOutcomes[0].gateStatus, "fail");
      assert.strictEqual(dispatch.taskOutcomes[0].deterministicFailure, true);
      assert.strictEqual(dispatch.taskOutcomes[0].task.digest, plan.tasks[0].digest);
      assert.deepEqual(dispatch.taskOutcomes[0].attempts.map((attempt) => attempt.executionAttempt), [0, 1]);
      assert.notStrictEqual(dispatch.taskOutcomes[0].attempts[0].task.digest, dispatch.taskOutcomes[0].attempts[1].task.digest);
      assert.strictEqual(dispatch.matrix.tasks.length, 1);
      assert.strictEqual(dispatch.matrix.tasks[0].deterministicFailure, true);
      assert.strictEqual(dispatch.matrix.tasks[0].digest, plan.tasks[0].digest);
    });
  });
  it("builds one deterministic G0/G1-G4 graph where static truth checks never initiate builds and every registered 3D journey has one task", async () => {
    const graph = await buildTaskGraph({ root: REPOSITORY_ROOT, lanes: "all" });
    const staticIds = ["static:commands", "static:coverage", "static:denylist", "static:deploy-contract", "static:fixture", "static:successor-context", "static:wardrobe", "static:zero-gpu"];
    const staticTasks = graph.filter((task) => task.category === "static");
    const registry = await import(pathToFileURL(path.join(REPOSITORY_ROOT, "tools", "verification", "client3d", "journeys", "index.mjs")).href);
    const task3dIds = graph.filter((task) => task.lane === "3d").map((task) => task.id);

    assert.deepEqual(staticTasks.map((task) => task.id), staticIds);
    assert.ok(staticTasks.every((task) => task.phase === 0 && task.tier === "G0" && task.dependencies.length === 0 && !task.argv.includes("build")));
    assert.deepEqual(task3dIds, registry.journeys.map((journey) => `3d:${journey.id}`).sort());
    const wearableTask = graph.find((task) => task.id === "3d:wearable-persistence");
    assert.ok(wearableTask);
    assert.strictEqual(wearableTask.required, false);
    assert.strictEqual(wearableTask.optIn, true);
    const attack = graph.find((task) => task.id === "tui:attack-approach");
    assert.ok(attack);
    assert.deepEqual(attack.argv, ["pnpm", "tui:gate", "--once", "--isolated", "--only", "attack-approach"]);
    assert.deepEqual(graph.find((task) => task.id === "node:server")?.dependencies, ["build:authority-bridge", "build:server"]);
    assert.deepEqual(graph.find((task) => task.id === "node:client")?.dependencies, ["build:authority-bridge", "build:server", "build:client-headless"]);

    const selected3d = task3dIds[0];
    const plan = await buildVerificationPlan({ root: REPOSITORY_ROOT, mode: "fast", taskIds: [selected3d] });
    const buildIds = plan.tasks.filter((task) => task.category === "build").map((task) => task.id);
    const gate = plan.tasks.find((task) => task.id === selected3d);

    assert.strictEqual(new Set(buildIds).size, buildIds.length);
    assert.deepEqual(buildIds, ["build:authority-bridge", "build:client-3d", "build:server"]);
    assert.strictEqual(gate.skipBuild, true);
    assert.ok(gate.argv.includes("--skip-build"));
    const proofsArg = gate.argv.indexOf("--proofs-dir");
    assert.ok(proofsArg >= 0);
    assert.strictEqual(gate.argv[proofsArg + 1], "verification/ledgers/artifacts/client3d/$TASK_RUN_ID/proofs");

    const fullPlan = await buildVerificationPlan({ root: REPOSITORY_ROOT, mode: "full" });
    const fullById = new Map(fullPlan.tasks.map((task) => [task.id, task]));
    const desktopBuild = fullById.get("build:desktop");
    const desktopSmoke = fullById.get("desktop:smoke");

    assert.ok(desktopBuild && desktopSmoke);
    assert.ok(!fullById.has("3d:wearable-persistence"));
    assert.ok(!fullById.has("build:wasm-replay"));
    assert.ok(!fullById.has("wasm:authority-browser-replay"));
    assert.ok(desktopBuild.phase === 0 && desktopBuild.category === "build" && desktopBuild.argv.join(" ") === "pnpm --dir desktop build");
    assert.ok(desktopSmoke.phase === 1 && desktopSmoke.tier === "G4" && desktopSmoke.required && !desktopSmoke.optIn && desktopSmoke.skipBuild);
    assert.deepEqual(desktopSmoke.dependencies, ["build:authority-bridge", "build:server", "build:client-3d", "build:desktop"]);

    const wearableFastPlan = await buildVerificationPlan({ root: REPOSITORY_ROOT, mode: "fast", taskIds: ["3d:wearable-persistence"] });
    const wearablePlanById = new Map(wearableFastPlan.tasks.map((task) => [task.id, task]));
    assert.ok(wearablePlanById.has("3d:wearable-persistence"));
    const wearableBuildIds = wearableFastPlan.tasks.filter((task) => task.category === "build").map((task) => task.id);
    assert.deepEqual(wearableBuildIds, ["build:authority-bridge", "build:client-3d", "build:server"]);

    const desktopFastPlan = await buildVerificationPlan({ root: REPOSITORY_ROOT, mode: "fast", taskIds: ["desktop:smoke"] });
    assert.ok(desktopFastPlan.tasks.some((task) => task.id === "desktop:smoke"));
  });

  it("assigns phase-one work to disjoint safe slot windows and isolated process state paths", async () => {
    await withTempDirectory("successor-farm-slots-", async (root) => {
      const plan = await createMatchingPlanForTasks(root, [
        fixtureTask("node:slot-a", { portCount: 2 }),
        fixtureTask("node:slot-b", { portCount: 2 }),
        fixtureTask("node:slot-c", { portCount: 2 }),
      ], { phase1Concurrency: 3 });
      const phaseOne = plan.tasks.filter((task) => task.phase === 1);
      const windows = phaseOne.map((task) => task.portWindow);
      const statePaths = phaseOne.flatMap((task) => Object.values(task.statePaths));

      assert.strictEqual(plan.phase1Concurrency, 3);
      assert.strictEqual(new Set(phaseOne.map((task) => task.slot)).size, 3);
      assert.strictEqual(new Set(statePaths).size, statePaths.length);
      assert.ok(phaseOne.every((task) => task.ports.every((port) => port >= 29_700 && port <= 29_799)));
      assert.ok(windows.every((window, index) => windows.slice(index + 1).every((other) => window.end < other.start || other.end < window.start)));

      const outOfRangePlan = structuredClone(plan);
      outOfRangePlan.tasks[0].ports = [];
      outOfRangePlan.tasks[0].portWindow = { start: 29_692, end: 29_699, size: 8 };
      refreshPlanDigests(outOfRangePlan);
      assert.throws(() => validatePlan(outOfRangePlan), (error) => error?.code === "INVALID_PLAN");
    });
  });

  it("runs phase zero exclusively before concurrently-ready phase-one slots", async () => {
    await withTempDirectory("successor-farm-phases-", async (root) => {
      const syncRoot = path.join(root, "sync");
      await fs.mkdir(syncRoot);
      const phaseOneProgram = [
        "const fs = require('node:fs');",
        "const root = process.env.SYNC_ROOT;",
        "if (!fs.existsSync(root + '/phase-zero-complete')) process.exit(41);",
        "fs.writeFileSync(root + '/ready-' + process.env.SUCCESSOR_PROCESS_RUN_ID, 'ready');",
        "const ready = () => fs.readdirSync(root).filter((name) => name.startsWith('ready-')).length;",
        "const timer = setInterval(() => { if (ready() >= 2) { clearInterval(timer); process.exit(0); } }, 1);",
        "setTimeout(() => { clearInterval(timer); process.exit(42); }, 500);",
      ].join("");
      const plan = await createMatchingPlanForTasks(root, [
        fixtureTask("static:phase-zero", {
          phase: 0,
          tier: "G0",
          category: "static",
          argv: [process.execPath, "-e", "require('node:fs').writeFileSync(process.env.SYNC_ROOT + '/phase-zero-complete', 'done')"],
          env: { SYNC_ROOT: syncRoot },
        }),
        fixtureTask("node:parallel-a", { argv: [process.execPath, "-e", phaseOneProgram], env: { SYNC_ROOT: syncRoot } }),
        fixtureTask("node:parallel-b", { argv: [process.execPath, "-e", phaseOneProgram], env: { SYNC_ROOT: syncRoot } }),
      ], { phase1Concurrency: 2 });
      const worker = await executeWorkerPlan({
        plan,
        root: plan.host.checkout,
        artifactRoot: path.join(root, "results"),
        lockRoot: path.join(root, "locks"),
        capabilities: capabilities(),
      });

      assert.strictEqual(worker.status, "pass");
      assert.deepEqual(worker.results.map((result) => result.status), ["pass", "pass", "pass"]);
      assert.ok(worker.results.slice(1).every((result) => result.command.exitCode === 0));
      assert.ok(worker.results.every((result) => result.artifacts.length >= 3));
      for (const result of worker.results) assert.deepEqual(await verifyArtifactChecksums(worker.artifactRoot, result.artifacts), { ok: true, failures: [] });
    });
  });

  it("keeps full selection and the verify matrix fresh against the full canonical source hash", async () => {
    const selectorTasks = [
      fixtureTask("static:truth", { phase: 0, tier: "G0", category: "static" }),
      fixtureTask("node:unit"),
    ];
    const selection = selectVerificationTasks({
      tasks: selectorTasks,
      coverageMap: { schema: "successor.coverage-registry.v1", systems: [], commands: [] },
      mode: "full",
      currentManifest: sourceManifest(),
    });

    assert.deepEqual(selection.taskIds, ["node:unit", "static:truth"]);
    assert.deepEqual(selection.cache, { enabled: false, sourceHash: SOURCE_HASH, reason: "full-mode-fresh" });

    await withTempDirectory("successor-farm-matrix-", async (root) => {
      const plan = await createMatchingPlan(root, { artifactPaths: [] });
      const dispatch = await dispatchFarmRun({
        plans: [plan],
        artifactRoot: path.join(root, "results"),
        lockRoot: path.join(root, "locks"),
        maxAttempts: 1,
        workerRunner: async ({ plan: workerPlan, executionAttempt }) => workerDocument(workerPlan, executionAttempt, "pass"),
        matrixPath: path.join(root, "verify-matrix.json"),
      });
      assert.deepEqual(JSON.parse(await fs.readFile(path.join(root, "verify-matrix.json"), "utf8")), dispatch.matrix);

      assert.strictEqual(dispatch.matrix.schema, "successor.verify-matrix.v1");
      assert.strictEqual(dispatch.matrix.status, "pass");
      assert.strictEqual(dispatch.matrix.durations.sumTaskMs, 12);
      assert.strictEqual(dispatch.matrix.cache.sourceHash, plan.source.sourceHash);
      assert.deepEqual(dispatch.matrix.cache, { hit: false, disposition: "fresh", sourceHash: plan.source.sourceHash, enabled: false, reason: "full-mode-fresh" });

      const scopedSelection = {
        ...dispatch.matrix.selection,
        cache: { ...dispatch.matrix.selection.cache, scopePrefixes: ["tools/verification"] },
      };
      assert.throws(
        () => buildVerifyMatrix({ plans: [plan], dispatch, selection: scopedSelection, wallMs: 12 }),
        (error) => error?.code === "SCOPED_CACHE_FORBIDDEN",
      );
      const cachedFullSelection = {
        ...dispatch.matrix.selection,
        cache: { ...dispatch.matrix.selection.cache, enabled: true },
      };
      assert.throws(
        () => buildVerifyMatrix({ plans: [plan], dispatch, selection: cachedFullSelection, wallMs: 12 }),
        (error) => error?.code === "FULL_MODE_CACHE_FORBIDDEN",
      );
    });
  });
  it("plans every requested full-mode task across all lanes and refuses a missing selection before dispatch", async () => {
    const requestedTaskIds = ["static:commands", "3d:registry-journey"];
    const selection = {
      mode: "full",
      source: { currentHash: SOURCE_HASH },
      cache: { enabled: false, sourceHash: SOURCE_HASH, reason: "full-mode-fresh" },
    };
    const plannerCalls = [];
    const dispatcherCalls = [];
    const planDocument = {
      source: { sourceHash: SOURCE_HASH },
      plans: [{ tasks: requestedTaskIds.map((id) => ({ id })) }],
    };
    const matrix = { schema: "successor.verify-matrix.v1", status: "pass" };
    const outcome = await runVerificationFarm({
      root: "/isolated/fixture",
      runId: "verify-fixture",
      taskIds: requestedTaskIds,
      mode: "full",
      selection,
      planner: async (options) => {
        plannerCalls.push(options);
        return planDocument;
      },
      dispatcher: async (options) => {
        dispatcherCalls.push(options);
        return { matrix };
      },
    });

    assert.deepEqual(plannerCalls, [{ root: "/isolated/fixture", runId: "verify-fixture", lanes: "all", only: requestedTaskIds }]);
    assert.deepEqual(dispatcherCalls, [{ plans: planDocument.plans, maxAttempts: 2, timingPath: "/isolated/fixture/tools/verification/farm/farm-timings.json", signal: undefined, selection, matrixPath: undefined }]);
    assert.strictEqual(outcome.matrix, matrix);

    let dispatched = false;
    await assert.rejects(
      runVerificationFarm({
        root: "/isolated/fixture",
        taskIds: requestedTaskIds,
        mode: "full",
        selection,
        planner: async () => ({ source: { sourceHash: SOURCE_HASH }, plans: [{ tasks: [{ id: "static:commands" }] }] }),
        dispatcher: async () => {
          dispatched = true;
          return { matrix };
        },
      }),
      (error) => error?.code === "MISSING_SELECTED_TASK",
    );
    assert.strictEqual(dispatched, false);
  });
  it("ignores untracked verification run artifacts while hashing adjacent untracked verification source", async () => {
    await withTempDirectory("successor-farm-source-policy-", async (root) => {
      const verificationRoot = path.join(root, "verification");
      const runtimeArtifact = path.join(verificationRoot, ".runs", "run-1", "result.json");
      const trackedInput = path.join(verificationRoot, "tracked-input.json");
      const untrackedInput = path.join(verificationRoot, "new-input.json");
      await fs.mkdir(path.dirname(runtimeArtifact), { recursive: true });
      await fs.writeFile(trackedInput, "tracked verification input", "utf8");
      execFileSync("git", ["init", "--quiet"], { cwd: root, stdio: "pipe" });
      execFileSync("git", ["config", "user.email", "farm-test@example.invalid"], { cwd: root, stdio: "pipe" });
      execFileSync("git", ["config", "user.name", "Farm Test"], { cwd: root, stdio: "pipe" });
      execFileSync("git", ["add", "verification/tracked-input.json"], { cwd: root, stdio: "pipe" });
      execFileSync("git", ["commit", "--quiet", "-m", "fixture source"], { cwd: root, stdio: "pipe" });
      await fs.writeFile(runtimeArtifact, "first runtime result", "utf8");

      const beforeRuntimeChange = await createLocalSourceIdentity({ root, includeManifest: false });
      await fs.writeFile(runtimeArtifact, "second runtime result", "utf8");
      const afterRuntimeChange = await createLocalSourceIdentity({ root, includeManifest: false });
      assert.strictEqual(afterRuntimeChange.sourceHash, beforeRuntimeChange.sourceHash);

      await fs.writeFile(untrackedInput, "new verification source", "utf8");
      const afterSourceChange = await createLocalSourceIdentity({ root, includeManifest: false });
      assert.notStrictEqual(afterSourceChange.sourceHash, beforeRuntimeChange.sourceHash);
    });
  });
});
