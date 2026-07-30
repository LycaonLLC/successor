#!/usr/bin/env node
import { spawn } from "node:child_process";
import path from "node:path";
import { performance } from "node:perf_hooks";

import { appendLedgerEntry, createRunId, repoSnapshot, writeJsonArtifact } from "./ledger.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..", "..");
const runId = createRunId("aoi-1000");
const started = performance.now();
const repo = await repoSnapshot(repoRoot);

const result = await runCommand(["cargo", "run", "-q", "-p", "successor-sim", "--example", "aoi_1000_benchmark"]);
const durationMs = round(performance.now() - started);
const parsed = parseJsonFromOutput(result.stdout);
const status = result.exitCode === 0 && parsed?.snapshot?.budgetedP95Passes ? "pass" : "fail";
const artifactPath = await writeJsonArtifact(
  repoRoot,
  path.join("verification", "ledgers", "artifacts", "aoi-shard-bench", `${runId}.json`),
  parsed ?? { stdout: result.stdout, stderr: result.stderr },
);

await appendLedgerEntry(repoRoot, "net-snapshot-ledger", {
  runId,
  phase: "phase-6-netcode-aoi-budget",
  status,
  summary: status === "pass"
    ? "1000-observer AOI benchmark passed the degraded snapshot byte budget."
    : "1000-observer AOI benchmark failed the snapshot byte budget.",
  repo,
  command: {
    argv: ["cargo", "run", "-q", "-p", "successor-sim", "--example", "aoi_1000_benchmark"],
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
});

if (parsed) {
  console.log(JSON.stringify(parsed, null, 2));
} else {
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
}
if (status !== "pass") process.exitCode = 1;

function runCommand(argv) {
  return new Promise((resolve) => {
    const child = spawn(argv[0], argv.slice(1), {
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
