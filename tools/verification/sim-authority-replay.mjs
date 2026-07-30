#!/usr/bin/env node
import { spawn } from "node:child_process";
import path from "node:path";
import { performance } from "node:perf_hooks";

import { appendLedgerEntry, createRunId, repoSnapshot, writeJsonArtifact } from "./ledger.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..", "..");
const runId = createRunId("authority-replay");
const argv = ["cargo", "run", "-q", "-p", "successor-sim", "--example", "authority_command_replay"];
const started = performance.now();
const repo = await repoSnapshot(repoRoot);
const result = await runCommand(argv);
const durationMs = round(performance.now() - started);
const parsed = parseJsonFromOutput(result.stdout);
const pass =
  result.exitCode === 0 &&
  parsed?.schema === "successor.authority-command-replay.v1" &&
  parsed?.config?.commands === 26 &&
  parsed?.replay?.nativeRepeatMatches === true &&
  parsed?.replay?.accepted === 4 &&
  parsed?.replay?.rejected === 22 &&
  parsed?.replay?.finalAreaId === "open-desert-overworld" &&
  parsed?.replay?.combatEvents === 0 &&
  parsed?.replay?.hits === 0;
const status = pass ? "pass" : "fail";
const artifactPath = await writeJsonArtifact(
  repoRoot,
  path.join("verification", "ledgers", "artifacts", "authority-command-replay", `${runId}.json`),
  parsed ?? { stdout: result.stdout, stderr: result.stderr },
);

const ledgerPayload = {
  runId,
  phase: "rust-authority-command-replay",
  status,
  summary: pass
    ? "Rust authority command replay exercised current movement and combat-queue commands, rejected protected-target, invalid, or duplicate commands, and repeated deterministically."
    : "Rust authority command replay failed deterministic command/snapshot acceptance.",
  repo,
  command: {
    argv,
    cwd: repoRoot,
    durationMs,
    exitCode: result.exitCode,
    signal: result.signal,
  },
  metrics: parsed ?? {},
  artifacts: {
    summary: artifactPath,
  },
  details: {
    stdoutTail: tail(result.stdout),
    stderrTail: tail(result.stderr),
  },
};

await appendLedgerEntry(repoRoot, "sim-replay-ledger", ledgerPayload);
await appendLedgerEntry(repoRoot, "net-snapshot-ledger", {
  ...ledgerPayload,
  phase: "rust-authority-snapshot-frame",
  summary: pass
    ? "Rust authority replay emitted deterministic server frame and snapshot bundle hashes."
    : "Rust authority replay failed server frame/snapshot bundle proof.",
});

if (parsed) {
  console.log(JSON.stringify(parsed, null, 2));
} else {
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
}
if (!pass) process.exitCode = 1;

function runCommand(command) {
  return new Promise((resolve) => {
    const child = spawn(command[0], command.slice(1), {
      cwd: repoRoot,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("close", (exitCode, signal) => resolve({ stdout, stderr, exitCode, signal }));
  });
}

function parseJsonFromOutput(text) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

function tail(text, maxLength = 1200) {
  if (!text) return "";
  return text.length > maxLength ? text.slice(text.length - maxLength) : text;
}

function round(value) {
  return Math.round(value * 1000) / 1000;
}
