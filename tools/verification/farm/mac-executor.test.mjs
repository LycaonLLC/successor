import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, it } from "node:test";
import { dispatchFarmRun } from "./dispatch.mjs";

import { executeRemoteWorkerPlan } from "./remote-executor.mjs";
import { sha256Json } from "./protocol.mjs";
import { createTreeSourceIdentity } from "./source-hash.mjs";
import { REMOTE_CHECKOUT } from "./sync.mjs";
import { createWorkerPlan } from "./task-plan.mjs";

const SOURCE_HASH = "a".repeat(64);
const FARM_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));

async function withTempDirectory(prefix, callback) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  try {
    return await callback(directory);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

function capabilities({ node = true, pnpm = true, rust = true, wasm = false, playwright = false } = {}) {
  return {
    schema: "successor.farm-capabilities.v1",
    host: { os: "darwin", logicalCores: 8 },
    toolchain: {
      node: { available: node },
      pnpm: { available: pnpm },
      rustc: { available: rust },
      cargo: { available: rust },
      wasmTarget: { available: wasm },
    },
    runtime: {
      processHost: { available: true, selected: "child" },
      playwright: { available: playwright, chromiumInstalled: playwright },
      ffmpeg: { available: false },
    },
    networking: { freePortRange: { start: 29_700, end: 29_731, size: 32 } },
  };
}
async function createMatchingRemotePlan(root, options = {}) {
  await fs.writeFile(path.join(root, "fixture.txt"), "fixture", "utf8");
  const source = await createTreeSourceIdentity({ root, expectedPaths: ["fixture.txt"], includeManifest: false });
  return createRemotePlan({ ...options, sourceHash: source.sourceHash });
}

function createRemotePlan({ tags = ["node"], env = {}, sourceHash = SOURCE_HASH, transport = "ssh", hostId = "macbook-codex", checkout = REMOTE_CHECKOUT, phase = 0 } = {}) {
  return createWorkerPlan({
    runId: "remote-run",
    hostAssignment: {
      host: {
        id: hostId,
        transport,
        checkout,
        capabilities: capabilities(),
      },
      tasks: [{
        id: "node:remote-fixture",
        lane: "node",
        shard: "remote-fixture",
        phase,
        tier: phase === 0 ? "G0" : "G1",
        category: "test",
        dependencies: [],
        required: true,
        optIn: false,
        defaultFresh: true,
        skipBuild: false,
        argv: [process.execPath, "-e", "process.exit(0)"],
        cwd: ".",
        env,
        tags,
        deadlineMs: 1_000,
        portCount: 0,
        artifactPaths: [],
        artifactDiscoveryRoots: [],
        digestGroup: null,
      }],
    },
    source: { sourceHash, paths: ["fixture.txt"] },
    deterministic: true,
  });
}

function preflightFor(plan, overrides = {}) {
  return {
    schema: "successor.farm-preflight.v1",
    status: "ready",
    host: plan.host.id,
    checkout: REMOTE_CHECKOUT,
    source: { match: true, localHash: plan.source.sourceHash, remoteHash: plan.source.sourceHash },
    capabilities: capabilities(),
    ...overrides,
  };
}

function signedWorkerDocument(plan, { result = {}, executionAttempt = 0 } = {}) {
  const taskResult = {
    schema: "successor.farm-result.v1",
    runId: plan.runId,
    leaseId: plan.leaseId,
    host: { id: plan.host.id },
    sourceHash: plan.source.sourceHash,
    task: { id: plan.tasks[0].id, digest: plan.tasks[0].digest },
    executionAttempt,
    status: "pass",
    durationMs: 1,
    artifacts: [],
    ledgerEntries: [],
    ...result,
  };
  taskResult.checksum = sha256Json(taskResult);
  const document = {
    schema: "successor.farm-worker.v1",
    runId: plan.runId,
    leaseId: plan.leaseId,
    host: plan.host.id,
    executionAttempt,
    results: [taskResult],
  };
  document.checksum = sha256Json(document);
  return document;
}

function successfulProcess(document, calls) {
  return async (executable, argv, options) => {
    calls.push({ executable, argv, options });
    if (executable === "ssh") return { ok: true, stdout: JSON.stringify(document), stderr: "", exitCode: 0, timedOut: false, overflow: false, error: null };
    if (executable === "rsync") return { ok: true, stdout: "", stderr: "", exitCode: 0, timedOut: false, overflow: false, error: null };
    throw new Error(`unexpected executable ${executable}`);
  };
}

function runNode(args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "pipe"], ...options });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (exitCode) => resolve({ exitCode, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") }));
  });
}

describe("Mac farm executor contracts", () => {
  it("binds a canonical full-tree hash without a Git checkout, including content and executable mode", async () => {
    await withTempDirectory("successor-farm-nongit-", async (root) => {
      const source = path.join(root, "fixture.txt");
      await fs.writeFile(source, "first", "utf8");
      await fs.chmod(source, 0o644);
      const initial = await createTreeSourceIdentity({ root, expectedPaths: ["fixture.txt"], includeManifest: true });

      await fs.chmod(source, 0o755);
      const modeChanged = await createTreeSourceIdentity({ root, expectedPaths: ["fixture.txt"] });
      await fs.writeFile(source, "second", "utf8");
      const contentChanged = await createTreeSourceIdentity({ root, expectedPaths: ["fixture.txt"] });

      assert.strictEqual(initial.provenance, null);
      assert.notStrictEqual(modeChanged.sourceHash, initial.sourceHash);
      assert.notStrictEqual(contentChanged.sourceHash, modeChanged.sourceHash);
    });
  });

  it("removes stale synchronized sources while preserving only declared build and package-cache roots", async () => {
    await withTempDirectory("successor-farm-reconcile-home-", async (home) => {
      const checkout = path.join(home, "successor-farm", "checkout");
      await Promise.all([
        fs.mkdir(path.join(checkout, "src"), { recursive: true }),
        fs.mkdir(path.join(checkout, "nested"), { recursive: true }),
        fs.mkdir(path.join(checkout, "target"), { recursive: true }),
        fs.mkdir(path.join(checkout, "node_modules", "cached"), { recursive: true }),
        fs.mkdir(path.join(checkout, ".cache"), { recursive: true }),
        fs.mkdir(path.join(checkout, ".pnpm-store"), { recursive: true }),
        fs.mkdir(path.join(checkout, ".vite"), { recursive: true }),
        fs.mkdir(path.join(checkout, "desktop", "release"), { recursive: true }),
        fs.mkdir(path.join(checkout, "verification", ".runs"), { recursive: true }),
        fs.mkdir(path.join(checkout, "nested", "dist"), { recursive: true }),
        fs.mkdir(path.join(checkout, "obsolete", "child"), { recursive: true }),
      ]);
      await Promise.all([
        fs.writeFile(path.join(checkout, "package.json"), "{}"),
        fs.writeFile(path.join(checkout, "src", "keep.mjs"), "export {}"),
        fs.writeFile(path.join(checkout, "nested", "package.json"), "{}"),
        fs.writeFile(path.join(checkout, "target", "keep"), "cache"),
        fs.writeFile(path.join(checkout, "node_modules", "cached", "keep"), "cache"),
        fs.writeFile(path.join(checkout, ".cache", "keep"), "cache"),
        fs.writeFile(path.join(checkout, ".pnpm-store", "keep"), "cache"),
        fs.writeFile(path.join(checkout, ".vite", "keep"), "cache"),
        fs.writeFile(path.join(checkout, "desktop", "release", "keep"), "cache"),
        fs.writeFile(path.join(checkout, "verification", ".runs", "keep"), "cache"),
        fs.writeFile(path.join(checkout, "desktop", "stale"), "stale"),
        fs.writeFile(path.join(checkout, "verification", "stale"), "stale"),
        fs.writeFile(path.join(checkout, "nested", "dist", "keep"), "cache"),
        fs.writeFile(path.join(checkout, "obsolete.txt"), "stale"),
        fs.writeFile(path.join(checkout, "obsolete", "child", "stale"), "stale"),
      ]);
      const syncModule = pathToFileURL(path.join(FARM_DIRECTORY, "sync.mjs")).href;
      const allowedPaths = ["package.json", "src/keep.mjs", "nested/package.json"];
      const script = `import { reconcileCheckout } from ${JSON.stringify(syncModule)}; const result = await reconcileCheckout({ allowedPaths: ${JSON.stringify(allowedPaths)} }); process.stdout.write(JSON.stringify(result));`;
      const result = await runNode(["--input-type=module", "--eval", script], { env: { ...process.env, HOME: home } });

      assert.strictEqual(result.exitCode, 0, result.stderr);
      const reconciled = JSON.parse(result.stdout);
      assert.ok(reconciled.removedEntries >= 2);
      await Promise.all([
        fs.access(path.join(checkout, "src", "keep.mjs")),
        fs.access(path.join(checkout, "target", "keep")),
        fs.access(path.join(checkout, "node_modules", "cached", "keep")),
        fs.access(path.join(checkout, ".cache", "keep")),
        fs.access(path.join(checkout, ".pnpm-store", "keep")),
        fs.access(path.join(checkout, ".vite", "keep")),
        fs.access(path.join(checkout, "desktop", "release", "keep")),
        fs.access(path.join(checkout, "verification", ".runs", "keep")),
        fs.access(path.join(checkout, "nested", "dist", "keep")),
      ]);
      await assert.rejects(fs.access(path.join(checkout, "obsolete.txt")));
      await assert.rejects(fs.access(path.join(checkout, "obsolete")));
      await assert.rejects(fs.access(path.join(checkout, "desktop", "stale")));
      await assert.rejects(fs.access(path.join(checkout, "verification", "stale")));
    });
  });

  it("refuses transactional dispatch when the preflight's local or remote full hash is stale", async () => {
    await withTempDirectory("successor-farm-preflight-race-", async (root) => {
      const plan = createRemotePlan();
      let calls = 0;
      await assert.rejects(
        executeRemoteWorkerPlan({
          plan,
          root,
          artifactRoot: path.join(root, "artifacts"),
          preflight: async () => preflightFor(plan, { source: { match: true, localHash: "b".repeat(64), remoteHash: plan.source.sourceHash } }),
          runProcess: async () => { calls += 1; throw new Error("remote worker must not run after hash drift"); },
        }),
        (error) => error?.code === "REMOTE_PREFLIGHT_REFUSED",
      );
      assert.strictEqual(calls, 0);
    });
  });

  it("routes capability-incompatible work away from the Mac before invoking SSH", async () => {
    await withTempDirectory("successor-farm-capability-", async (root) => {
      const plan = createRemotePlan({ tags: ["node", "playwright"] });
      let calls = 0;
      await assert.rejects(
        executeRemoteWorkerPlan({
          plan,
          root,
          artifactRoot: path.join(root, "artifacts"),
          preflight: async () => preflightFor(plan, { capabilities: capabilities({ playwright: false }) }),
          runProcess: async () => { calls += 1; throw new Error("ineligible task must not invoke SSH"); },
        }),
        (error) => error?.code === "HOST_CAPABILITY_MISMATCH",
      );
      assert.strictEqual(calls, 0);
    });
  });

  it("uses a fixed SSH argv and JSON stdin so task environment values cannot become shell syntax", async () => {
    await withTempDirectory("successor-farm-safe-ssh-", async (root) => {
      const dangerousValue = "quote'; touch SHOULD_NEVER_RUN; #\nnext";
      const plan = await createMatchingRemotePlan(root, { env: { FIXTURE_VALUE: dangerousValue } });
      const calls = [];
      const document = signedWorkerDocument(plan);
      const output = await executeRemoteWorkerPlan({
        plan,
        root,
        artifactRoot: path.join(root, "artifacts"),
        preflight: async () => preflightFor(plan),
        runProcess: successfulProcess(document, calls),
      });

      assert.strictEqual(output.remoteArtifactRoot.endsWith("attempt-0"), true);
      assert.strictEqual(calls.length, 1);
      assert.deepEqual(calls[0].argv, [
        "-o", "BatchMode=yes", "-o", "ConnectTimeout=8", "macbook-codex",
        "env", "SUCCESSOR_PROCESS_HOST=child", "node", `${REMOTE_CHECKOUT}/tools/verification/farm/worker.mjs`, "--protocol-stdin",
      ]);
      assert.ok(!calls[0].argv.some((entry) => entry.includes(dangerousValue)));
      assert.strictEqual(JSON.parse(calls[0].options.input).plan.tasks[0].env.FIXTURE_VALUE, dangerousValue);
      assert.strictEqual(calls[0].executable, "ssh");
    });
  });

  it("rejects a remote worker document or a task receipt when its checksum is tampered", async () => {
    await withTempDirectory("successor-farm-checksum-", async (root) => {
      const plan = createRemotePlan();
      const valid = signedWorkerDocument(plan);
      const tamperedDocument = structuredClone(valid);
      tamperedDocument.results[0].status = "fail";
      const calls = [];
      await assert.rejects(
        executeRemoteWorkerPlan({
          plan,
          root,
          artifactRoot: path.join(root, "document-artifacts"),
          preflight: async () => preflightFor(plan),
          runProcess: successfulProcess(tamperedDocument, calls),
        }),
        (error) => error?.code === "REMOTE_RESULT_CHECKSUM_MISMATCH",
      );
      assert.strictEqual(calls.length, 1);

      const tamperedReceipt = signedWorkerDocument(plan);
      tamperedReceipt.results[0].checksum = "0".repeat(64);
      const { checksum: _ignored, ...unsignedDocument } = tamperedReceipt;
      tamperedReceipt.checksum = sha256Json(unsignedDocument);
      const receiptCalls = [];
      await assert.rejects(
        executeRemoteWorkerPlan({
          plan,
          root,
          artifactRoot: path.join(root, "receipt-artifacts"),
          preflight: async () => preflightFor(plan),
          runProcess: successfulProcess(tamperedReceipt, receiptCalls),
        }),
        (error) => error?.code === "REMOTE_RESULT_CHECKSUM_MISMATCH",
      );
      assert.strictEqual(receiptCalls.length, 1);
    });
  });
  it("preserves a structured remote checkout-lease conflict without accepting a worker result", async () => {
    await withTempDirectory("successor-farm-remote-lease-", async (root) => {
      const plan = createRemotePlan();
      const calls = [];
      await assert.rejects(
        executeRemoteWorkerPlan({
          plan,
          root,
          artifactRoot: path.join(root, "artifacts"),
          preflight: async () => preflightFor(plan),
          runProcess: async (executable, argv, options) => {
            calls.push({ executable, argv, options });
            return { ok: false, stdout: JSON.stringify({ error: { code: "HOST_LOCKED", message: "remote checkout has a live lease" } }), stderr: "", exitCode: 1, timedOut: false, overflow: false, error: null };
          },
        }),
        (error) => error?.code === "HOST_LOCKED",
      );
      assert.deepEqual(calls.map((call) => call.executable), ["ssh"]);
    });
  });

  it("keeps remote deadline failures and recovered remote failures non-green under the shared retry/quarantine truth", async () => {
    await withTempDirectory("successor-farm-remote-truth-", async (root) => {
      const plan = createRemotePlan({ phase: 1 });
      const deadlineAttempts = [];
      const deadline = await dispatchFarmRun({
        root,
        plans: [plan],
        artifactRoot: path.join(root, "deadline-artifacts"),
        maxAttempts: 2,
        remotePreflight: async () => preflightFor(plan),
        remoteWorkerRunner: async ({ plan: retryPlan, executionAttempt }) => {
          deadlineAttempts.push(executionAttempt);
          return signedWorkerDocument(retryPlan, { executionAttempt, result: { status: "killed", reason: { code: "TASK_DEADLINE_EXCEEDED", message: "deadline" } } });
        },
      });
      assert.deepEqual(deadlineAttempts, [0, 1]);
      assert.strictEqual(deadline.status, "fail");
      assert.strictEqual(deadline.taskOutcomes[0].status, "killed");
      assert.strictEqual(deadline.taskOutcomes[0].gateStatus, "fail");

      const recoveredAttempts = [];
      const recovered = await dispatchFarmRun({
        root,
        plans: [plan],
        artifactRoot: path.join(root, "recovered-artifacts"),
        maxAttempts: 2,
        remotePreflight: async () => preflightFor(plan),
        remoteWorkerRunner: async ({ plan: retryPlan, executionAttempt }) => {
          recoveredAttempts.push(executionAttempt);
          return signedWorkerDocument(retryPlan, { executionAttempt, result: { status: executionAttempt === 0 ? "fail" : "pass" } });
        },
      });
      assert.deepEqual(recoveredAttempts, [0, 1]);
      assert.strictEqual(recovered.status, "fail");
      assert.strictEqual(recovered.taskOutcomes[0].status, "quarantined");
      assert.strictEqual(recovered.taskOutcomes[0].gateStatus, "fail");
      assert.strictEqual(recovered.taskOutcomes[0].quarantine.code, "FLAKY_RECOVERY");
    });
  });

  it("keeps a local-only plan executable when no remote host is selected", async () => {
    await withTempDirectory("successor-farm-local-only-", async (root) => {
      const plan = createRemotePlan({ transport: "local", hostId: "local-fixture", checkout: root });
      let localCalls = 0;
      let remoteCalls = 0;
      const dispatch = await dispatchFarmRun({
        root,
        plans: [plan],
        artifactRoot: path.join(root, "artifacts"),
        maxAttempts: 1,
        workerRunner: async ({ plan: workerPlan, executionAttempt }) => {
          localCalls += 1;
          return signedWorkerDocument(workerPlan, { executionAttempt });
        },
        remoteWorkerRunner: async () => {
          remoteCalls += 1;
          throw new Error("local-only dispatch must not call the remote runner");
        },
      });
      assert.strictEqual(localCalls, 1);
      assert.strictEqual(remoteCalls, 0);
      assert.strictEqual(dispatch.status, "pass");
    });
  });
  it("forwards the same cancellation signal to remote execution and artifact transfer", async () => {
    await withTempDirectory("successor-farm-remote-signal-", async (root) => {
      const plan = await createMatchingRemotePlan(root);
      const content = "remote artifact";
      const artifact = {
        path: "tasks/remote-fixture/result.txt",
        size: Buffer.byteLength(content),
        sha256: createHash("sha256").update(content).digest("hex"),
      };
      const document = signedWorkerDocument(plan, { result: { artifacts: [artifact] } });
      const controller = new AbortController();
      const calls = [];
      await executeRemoteWorkerPlan({
        plan,
        root,
        artifactRoot: path.join(root, "transferred"),
        signal: controller.signal,
        preflight: async () => preflightFor(plan),
        runProcess: async (executable, argv, options) => {
          calls.push({ executable, argv, options });
          if (executable === "ssh") return { ok: true, stdout: JSON.stringify(document), stderr: "", exitCode: 0, timedOut: false, overflow: false, error: null };
          if (executable === "rsync") {
            const localFile = path.join(root, "transferred", ...artifact.path.split("/"));
            await fs.mkdir(path.dirname(localFile), { recursive: true });
            await fs.writeFile(localFile, content, "utf8");
            return { ok: true, stdout: "", stderr: "", exitCode: 0, timedOut: false, overflow: false, error: null };
          }
          throw new Error(`unexpected executable ${executable}`);
        },
      });
      assert.deepEqual(calls.map((call) => call.executable), ["ssh", "rsync"]);
      assert.ok(calls.every((call) => call.options.signal === controller.signal));
    });
  });
});
