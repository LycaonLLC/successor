#!/usr/bin/env node
import { createHash } from "node:crypto";
import { access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { CAPABILITIES_SCHEMA } from "./capabilities.mjs";
import { FarmError, errorDocument, parseArgs, printJson, processFailure, repoRoot, runProcess } from "./common.mjs";
import { createLocalSourceIdentity } from "./source-hash.mjs";
import {
  REMOTE_CHECKOUT,
  SourceMismatchError,
  compareRemoteSource,
  recomputeRemoteSourceIdentity,
  syncToFarm,
} from "./sync.mjs";

export const PREFLIGHT_SCHEMA = "successor.farm-preflight.v1";
export const AUTHORITY_SMOKE_SCHEMA = "successor.farm-authority-smoke.v1";
const SSH_OPTIONS = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=8"];
const AUTHORITY_REPLAY_ARGV = [
  "run",
  "-q",
  "-p",
  "successor-sim",
  "--example",
  "authority_command_replay",
];

export async function runMacPreflight({
  root = repoRoot,
  host,
  skipSync = false,
  syncAttempts,
} = {}) {
  const startedAt = new Date().toISOString();
  let source;
  try {
    source = skipSync
      ? await compareRemoteSource({ root, host, ...(syncAttempts === undefined ? {} : { maxAttempts: syncAttempts }) })
      : await syncToFarm({ root, host, ...(syncAttempts === undefined ? {} : { maxAttempts: syncAttempts }) });
  } catch (error) {
    if (error instanceof SourceMismatchError) {
      return refusedSourceDocument({ startedAt, host: error.host ?? host ?? null, skipSync, error });
    }
    throw error;
  }

  const selectedHost = source.host;
  const capabilities = await probeRemoteCapabilities(selectedHost);
  const [localSmoke, remoteSmoke] = await Promise.all([
    runAuthorityReplaySmoke({ root }),
    runRemoteAuthorityReplaySmoke(selectedHost),
  ]);
  const authoritySmoke = compareAuthoritySmoke(localSmoke, remoteSmoke);

  const expectedPaths = source.identity.manifest.entries.map((entry) => entry.path);
  const [finalLocal, finalRemote] = await Promise.all([
    createLocalSourceIdentity({ root, includeManifest: false }),
    recomputeRemoteSourceIdentity({ host: selectedHost, expectedPaths }),
  ]);
  const sourceStillCurrent = finalLocal.sourceHash === source.sourceHash &&
    finalRemote.sourceHash === source.sourceHash;
  let status;
  let refusal = null;
  if (!sourceStillCurrent) {
    status = "refused";
    refusal = {
      code: "SOURCE_CHANGED_AFTER_PREFLIGHT",
      message: "local or remote source changed after synchronization; remote results cannot be accepted",
    };
  } else if (authoritySmoke.status === "failed") {
    status = "refused";
    refusal = {
      code: "AUTHORITY_REPLAY_FAILED",
      message: "the cross-architecture authority replay/hash smoke did not match",
    };
  } else if (authoritySmoke.status === "pending") {
    status = "ready-with-pending";
  } else {
    status = "ready";
  }

  return {
    schema: PREFLIGHT_SCHEMA,
    status,
    startedAt,
    completedAt: new Date().toISOString(),
    host: selectedHost,
    checkout: REMOTE_CHECKOUT,
    source: {
      status: source.status,
      synchronized: !skipSync,
      localHash: finalLocal.sourceHash,
      synchronizedHash: source.sourceHash,
      remoteHash: finalRemote.sourceHash,
      synchronizedRemoteHash: source.remoteSourceHash,
      match: sourceStillCurrent,
      fileCount: source.fileCount,
      totalBytes: source.totalBytes,
      provenance: finalLocal.provenance,
      attempts: source.attempts ?? [],
    },
    capabilities,
    authoritySmoke,
    ...(refusal ? { refusal } : {}),
  };
}

export async function probeRemoteCapabilities(host) {
  const modulePath = `${REMOTE_CHECKOUT}/tools/verification/farm/capabilities.mjs`;
  const result = await runProcess(
    "ssh",
    [...SSH_OPTIONS, host, "node", modulePath, "--root", REMOTE_CHECKOUT],
    { timeoutMs: 2 * 60_000, maxOutputBytes: 2 * 1024 * 1024 },
  );
  if (!result.ok) throw processFailure(result, "remote capability probe");
  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch (cause) {
    throw new FarmError("remote capability probe did not emit valid JSON", {
      code: "INVALID_CAPABILITIES_DOCUMENT",
      cause,
    });
  }
  if (parsed?.schema !== CAPABILITIES_SCHEMA) {
    throw new FarmError("remote capability probe emitted an unsupported schema", {
      code: "INVALID_CAPABILITIES_DOCUMENT",
    });
  }
  return parsed;
}

export async function runAuthorityReplaySmoke({ root = repoRoot } = {}) {
  const example = path.join(root, "crates", "successor-sim", "examples", "authority_command_replay.rs");
  const fixture = path.join(root, "client", "public", "successor-slice", "open-desert-slice.json");
  if (!(await readable(example)) || !(await readable(fixture))) {
    return {
      schema: AUTHORITY_SMOKE_SCHEMA,
      status: "pending",
      reason: "portable authority_command_replay example or its fixture is not present",
      command: null,
    };
  }

  const result = await runProcess("cargo", AUTHORITY_REPLAY_ARGV, {
    cwd: root,
    timeoutMs: 30 * 60_000,
    maxOutputBytes: 8 * 1024 * 1024,
  });
  if (!result.ok) {
    return {
      schema: AUTHORITY_SMOKE_SCHEMA,
      status: "failed",
      reason: processReason(result),
      command: { executable: "cargo", argv: AUTHORITY_REPLAY_ARGV },
    };
  }
  const replay = parseJsonFromOutput(result.stdout);
  if (!isValidReplay(replay)) {
    return {
      schema: AUTHORITY_SMOKE_SCHEMA,
      status: "failed",
      reason: "authority replay output failed its deterministic replay invariants",
      command: { executable: "cargo", argv: AUTHORITY_REPLAY_ARGV },
    };
  }
  const digest = createHash("sha256").update(canonicalJson(replay)).digest("hex");
  return {
    schema: AUTHORITY_SMOKE_SCHEMA,
    status: "pass",
    command: { executable: "cargo", argv: AUTHORITY_REPLAY_ARGV },
    replaySchema: replay.schema,
    digest,
    hashes: {
      initialState: replay.replay.initialStateHash,
      finalState: replay.replay.finalStateHash,
      replay: replay.replay.replayHash,
      repeatReplay: replay.replay.repeatReplayHash,
      firstFrame: replay.replay.firstFrameHash,
      lastFrame: replay.replay.lastFrameHash,
    },
    commands: replay.config.commands,
    accepted: replay.replay.accepted,
    rejected: replay.replay.rejected,
  };
}

async function runRemoteAuthorityReplaySmoke(host) {
  const modulePath = `${REMOTE_CHECKOUT}/tools/verification/farm/preflight.mjs`;
  const result = await runProcess(
    "ssh",
    [...SSH_OPTIONS, host, "node", modulePath, "authority-smoke"],
    { timeoutMs: 35 * 60_000, maxOutputBytes: 2 * 1024 * 1024 },
  );
  if (!result.ok) {
    return {
      schema: AUTHORITY_SMOKE_SCHEMA,
      status: "failed",
      reason: processReason(result),
      command: { executable: "cargo", argv: AUTHORITY_REPLAY_ARGV },
    };
  }
  try {
    const parsed = JSON.parse(result.stdout);
    if (parsed?.schema === AUTHORITY_SMOKE_SCHEMA) return parsed;
  } catch {
    // Normalized below; raw remote output is intentionally not included.
  }
  return {
    schema: AUTHORITY_SMOKE_SCHEMA,
    status: "failed",
    reason: "remote authority smoke emitted an invalid document",
    command: { executable: "cargo", argv: AUTHORITY_REPLAY_ARGV },
  };
}

function compareAuthoritySmoke(local, remote) {
  if (local.status === "pending" || remote.status === "pending") {
    return {
      schema: AUTHORITY_SMOKE_SCHEMA,
      status: "pending",
      portableCommand: local.command ?? remote.command,
      local,
      remote,
    };
  }
  const match = local.status === "pass" && remote.status === "pass" && local.digest === remote.digest;
  return {
    schema: AUTHORITY_SMOKE_SCHEMA,
    status: match ? "pass" : "failed",
    architectureIndependentDigestMatch: match,
    local,
    remote,
  };
}

function refusedSourceDocument({ startedAt, host, skipSync, error }) {
  return {
    schema: PREFLIGHT_SCHEMA,
    status: "refused",
    startedAt,
    completedAt: new Date().toISOString(),
    host,
    checkout: REMOTE_CHECKOUT,
    source: {
      status: "mismatch",
      synchronized: !skipSync,
      localHash: error.localHash,
      remoteHash: error.remoteHash,
      match: false,
    },
    capabilities: null,
    authoritySmoke: {
      schema: AUTHORITY_SMOKE_SCHEMA,
      status: "not-run",
      reason: "source mismatch",
    },
    refusal: {
      code: error.code,
      message: error.message,
    },
  };
}

function isValidReplay(replay) {
  return replay?.schema === "successor.authority-command-replay.v1" &&
    replay?.config?.commands === 26 &&
    replay?.replay?.nativeRepeatMatches === true &&
    replay?.replay?.replayHash === replay?.replay?.repeatReplayHash &&
    replay?.replay?.accepted === 4 &&
    replay?.replay?.rejected === 22 &&
    replay?.replay?.finalAreaId === "open-desert-overworld" &&
    replay?.replay?.combatEvents === 0 &&
    replay?.replay?.hits === 0;
}

function parseJsonFromOutput(text) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function processReason(result) {
  if (result.error) return result.error.code ?? result.error.name ?? "spawn-error";
  if (result.timedOut) return "timeout";
  if (result.overflow) return "output-limit";
  return `exit-${result.exitCode}${result.signal ? `-${result.signal}` : ""}`;
}

async function readable(candidate) {
  try {
    await access(candidate);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args._[0] === "authority-smoke") {
    const result = await runAuthorityReplaySmoke({ root: repoRoot });
    printJson(result, Boolean(args.pretty));
    if (result.status === "failed") process.exitCode = 1;
    return;
  }
  const result = await runMacPreflight({
    root: args.root ?? repoRoot,
    host: args.host,
    skipSync: Boolean(args["skip-sync"]),
    syncAttempts: args.attempts === undefined ? undefined : Number(args.attempts),
  });
  printJson(result, Boolean(args.pretty));
  if (result.status === "refused") process.exitCode = 2;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error) => {
    printJson(errorDocument(PREFLIGHT_SCHEMA, error), true);
    process.exitCode = 1;
  });
}
