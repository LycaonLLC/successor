import path from "node:path";

import { FarmError, processFailure, runProcess as defaultRunProcess } from "./common.mjs";
import { runMacPreflight } from "./preflight.mjs";
import { safeName, sha256Json, verifyArtifactChecksums } from "./protocol.mjs";
import { createTreeSourceIdentity } from "./source-hash.mjs";
import { REMOTE_CHECKOUT, REMOTE_FARM_ROOT } from "./sync.mjs";
import { taskEligibleOnHost, validatePlan } from "./task-plan.mjs";

const SSH_OPTIONS = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=8"];
const REMOTE_WORKER = `${REMOTE_CHECKOUT}/tools/verification/farm/worker.mjs`;

/** Dynamic worker data is stdin JSON; no user-controlled data enters an SSH command string. */
export async function executeRemoteWorkerPlan({
  plan,
  root,
  artifactRoot,
  executionAttempt = 0,
  preflight = runMacPreflight,
  runProcess = defaultRunProcess,
  syncAttempts,
  signal,
} = {}) {
  validatePlan(plan);
  if (plan.host.transport !== "ssh") throw new FarmError("remote executor requires an SSH worker plan", { code: "REMOTE_PLAN_REQUIRED" });
  const host = sshHostForPlan(plan);
  const preflightDocument = await preflight({ root, host, ...(syncAttempts === undefined ? {} : { syncAttempts }) });
  assertPreflight(preflightDocument, plan, host);
  const capabilityHost = { ...plan.host, capabilities: preflightDocument.capabilities };
  const ineligible = plan.tasks.filter((task) => !taskEligibleOnHost(task, capabilityHost));
  if (ineligible.length > 0) {
    throw new FarmError("remote plan contains a task unsupported by the probed host", { code: "HOST_CAPABILITY_MISMATCH", details: { host, tasks: ineligible.map((task) => task.id) } });
  }

  const remoteArtifactRoot = remoteArtifactsFor(plan, executionAttempt);
  const invocation = await runProcess(
    "ssh",
    [...SSH_OPTIONS, host, "env", "SUCCESSOR_PROCESS_HOST=child", "node", REMOTE_WORKER, "--protocol-stdin"],
    {
      input: JSON.stringify({ plan, executionAttempt, artifactRoot: remoteArtifactRoot }),
      timeoutMs: remoteDeadline(plan),
      maxOutputBytes: 16 * 1024 * 1024,
      signal,
    },
  );
  if (!invocation.ok) throw remoteWorkerFailure(invocation);
  const remoteDocument = parseWorkerDocument(invocation.stdout);
  verifyRemoteChecksums(remoteDocument, plan, executionAttempt);

  const finalLocal = await createTreeSourceIdentity({ root, expectedPaths: plan.source.paths, includeManifest: false });
  if (finalLocal.sourceHash !== plan.source.sourceHash) {
    throw new FarmError("local source changed while the remote worker was executing", { code: "SOURCE_CHANGED_DURING_REMOTE_EXECUTION" });
  }
  const localArtifactRoot = path.resolve(artifactRoot);
  if (remoteDocument.results.some((result) => result.artifacts.length > 0)) {
    const transfer = await runProcess(
      "rsync",
      ["--archive", "--checksum", "-e", "ssh -o BatchMode=yes -o ConnectTimeout=8", `${host}:${remoteArtifactRoot}/`, `${localArtifactRoot}/`],
      { signal, timeoutMs: 10 * 60_000, maxOutputBytes: 2 * 1024 * 1024 },
    );
    if (!transfer.ok) throw processFailure(transfer, "remote farm artifact transfer");
    for (const result of remoteDocument.results) {
      const verified = await verifyArtifactChecksums(localArtifactRoot, result.artifacts);
      if (!verified.ok) throw new FarmError("remote artifact checksums failed after transfer", { code: "ARTIFACT_CHECKSUM_MISMATCH", details: verified.failures });
    }
  }
  return { ...remoteDocument, artifactRoot: localArtifactRoot, remoteArtifactRoot, preflight: preflightDocument };
}

export function remoteArtifactsFor(plan, executionAttempt) {
  return path.posix.join(REMOTE_FARM_ROOT, "results", safeName(plan.runId), safeName(plan.leaseId), `attempt-${executionAttempt}`);
}

export function sshHostForPlan(plan) {
  const host = plan?.host?.id;
  if (typeof host !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/u.test(host)) throw new FarmError("SSH plan host id is not a safe SSH alias", { code: "INVALID_FARM_HOST" });
  return host;
}

function assertPreflight(document, plan, host) {
  if (!document || !["ready", "ready-with-pending"].includes(document.status) || document.host !== host || document.checkout !== REMOTE_CHECKOUT || document.source?.match !== true || document.source?.localHash !== plan.source.sourceHash || document.source?.remoteHash !== plan.source.sourceHash) {
    throw new FarmError("remote preflight did not establish source parity for the signed worker plan", { code: "REMOTE_PREFLIGHT_REFUSED" });
  }
  if (!document.capabilities || typeof document.capabilities !== "object") throw new FarmError("remote preflight did not provide capabilities", { code: "INVALID_CAPABILITIES_DOCUMENT" });
}

function parseWorkerDocument(stdout) {
  try {
    const document = JSON.parse(stdout);
    if (document?.schema !== "successor.farm-worker.v1" || !Array.isArray(document.results) || typeof document.checksum !== "string") throw new Error("invalid document");
    return document;
  } catch (cause) {
    throw new FarmError("remote worker emitted an invalid protocol document", { code: "INVALID_WORKER_RESULT", cause });
  }
}

function verifyRemoteChecksums(document, plan, executionAttempt) {
  const { checksum, ...unsignedDocument } = document;
  if (checksum !== sha256Json(unsignedDocument)) throw new FarmError("remote worker document checksum mismatch", { code: "REMOTE_RESULT_CHECKSUM_MISMATCH" });
  for (const result of document.results) {
    const { checksum: resultChecksum, ...unsignedResult } = result;
    if (typeof resultChecksum !== "string" || resultChecksum !== sha256Json(unsignedResult)) throw new FarmError("remote task result checksum mismatch", { code: "REMOTE_RESULT_CHECKSUM_MISMATCH" });
    if (result.runId !== plan.runId || result.leaseId !== plan.leaseId || result.host?.id !== plan.host.id || result.sourceHash !== plan.source.sourceHash || result.executionAttempt !== executionAttempt) throw new FarmError("remote result is not bound to its signed plan", { code: "RESULT_BINDING_MISMATCH" });
  }
}

function remoteWorkerFailure(invocation) {
  try {
    const error = JSON.parse(invocation.stdout)?.error;
    if (typeof error?.code === "string" && typeof error?.message === "string") return new FarmError(error.message, { code: error.code, details: error.details });
  } catch {
    // Keep remote diagnostics redaction-safe below.
  }
  return processFailure(invocation, "remote farm worker");
}

function remoteDeadline(plan) {
  return Math.min(60 * 60_000, Math.max(60_000, plan.tasks.reduce((sum, task) => sum + task.deadlineMs + task.graceMs, 0) + 60_000));
}
