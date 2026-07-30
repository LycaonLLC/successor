#!/usr/bin/env node
import { spawn } from "node:child_process";
import path from "node:path";
import { performance } from "node:perf_hooks";

import { appendLedgerEntry, createRunId, repoSnapshot, writeJsonArtifact } from "./ledger.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..", "..");
const profile = process.env.GAME_OPT_PROFILE ?? "local";
const strict = isEnabled(process.env.GAME_OPT_STRICT);
const includeBrowser = process.env.GAME_OPT_BROWSER === undefined
  ? true
  : isEnabled(process.env.GAME_OPT_BROWSER);
const includeScale = isEnabled(process.env.GAME_OPT_SCALE) || profile === "stress";
const runId = createRunId(`netcode-${profile}`);
const started = performance.now();
const repo = await repoSnapshot(repoRoot);

const commands = [];

if (includeBrowser) {
  commands.push({
    id: "browser-roll-journeys",
    phase: "graphical-client-authority",
    argv: ["pnpm", "3d:gate", "--only", "movement", "--only", "ranged", "--concurrency", "1"],
    env: {},
    timeoutMs: 300_000,
    successMetrics: { status: "pass", journeys: ["movement", "ranged"] },
  });
}

if (includeScale) {
  commands.push({
    id: "websocket",
    phase: "websocket-receipts",
    argv: ["pnpm", "--dir", "server", "bench:game:ws"],
    env: websocketEnv(profile),
  });
}

const results = [];
for (const command of commands) {
  const commandStarted = performance.now();
  const result = await runCommand(command.argv, command.env, command.timeoutMs);
  const durationMs = round(performance.now() - commandStarted);
  const parsed = parseJsonFromOutput(result.stdout)
    ?? (result.exitCode === 0 && !result.timedOut ? command.successMetrics ?? null : null);
  results.push({
    ...command,
    durationMs,
    exitCode: result.exitCode,
    signal: result.signal,
    timedOut: result.timedOut,
    timeoutMs: command.timeoutMs ?? null,
    parsed,
    stdoutTail: tail(result.stdout),
    stderrTail: tail(result.stderr),
  });
}

const findings = deriveFindings(results);
const hardFailures = results.filter((result) => result.timedOut || (result.exitCode !== 0 && !result.parsed));
const budgetFailures = findings.filter((finding) => finding.severity === "fail");
const status = hardFailures.length > 0
  ? "error"
  : budgetFailures.length > 0
    ? "needs_optimization"
    : "pass";
const report = {
  schema: "successor.netcode-optimization-suite.v1",
  runId,
  generatedAt: new Date().toISOString(),
  profile,
  status,
  strict,
  includeBrowser,
  includeScale,
  durationMs: round(performance.now() - started),
  summary: summarize(results),
  findings,
  commands: results.map((result) => ({
    id: result.id,
    phase: result.phase,
    argv: result.argv,
    env: result.env,
    durationMs: result.durationMs,
    exitCode: result.exitCode,
    signal: result.signal,
    timedOut: result.timedOut,
    metrics: result.parsed,
    stdoutTail: result.stdoutTail,
    stderrTail: result.stderrTail,
  })),
};

const artifactPath = await writeJsonArtifact(
  repoRoot,
  path.join("verification", "ledgers", "artifacts", "netcode-optimization-suite", `${runId}.json`),
  report,
);
await writeJsonArtifact(
  repoRoot,
  path.join("verification", "ledgers", "artifacts", "netcode-optimization-suite", "latest.json"),
  report,
);
await appendLedgerEntry(repoRoot, "netcode-optimization-suite", {
  runId,
  phase: "multiplayer-performance-experience-optimization",
  status,
  summary: status === "pass"
    ? "Netcode optimization suite passed the configured deterministic gates."
    : "Netcode optimization suite produced actionable performance findings.",
  repo,
  command: {
    argv: ["node", "tools/verification/netcode-optimization-suite.mjs"],
    cwd: repoRoot,
    durationMs: report.durationMs,
    exitCode: status === "error" ? 1 : 0,
    signal: null,
  },
  metrics: report.summary,
  artifacts: {
    report: artifactPath,
    latest: path.join("verification", "ledgers", "artifacts", "netcode-optimization-suite", "latest.json"),
  },
  details: {
    findings,
  },
});

console.log(JSON.stringify(report, null, 2));
if (hardFailures.length > 0 || (strict && budgetFailures.length > 0)) process.exitCode = 1;

function runCommand(argv, env, commandTimeoutMs = null) {
  return new Promise((resolve) => {
    const timeoutMs = commandTimeoutMs
      ?? parsePositiveInt(process.env.GAME_OPT_COMMAND_TIMEOUT_MS, profile === "stress" ? 120_000 : 60_000);
    const child = spawn(argv[0], argv.slice(1), {
      cwd: repoRoot,
      detached: process.platform !== "win32",
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const killTimer = setTimeout(() => {
      timedOut = true;
      stderr += `\nCommand timed out after ${timeoutMs}ms\n`;
      if (process.platform === "win32") child.kill("SIGTERM");
      else {
        try {
          process.kill(-child.pid, "SIGTERM");
        } catch {
          child.kill("SIGTERM");
        }
      }
      setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          if (process.platform === "win32") child.kill("SIGKILL");
          else {
            try {
              process.kill(-child.pid, "SIGKILL");
            } catch {
              child.kill("SIGKILL");
            }
          }
        }
      }, 2_000).unref();
    }, timeoutMs);
    killTimer.unref();
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    let settled = false;
    const finish = (exitCode, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      resolve({ stdout, stderr, exitCode, signal, timedOut });
    };
    child.on("exit", (exitCode, signal) => {
      setTimeout(() => finish(exitCode, signal), 25);
    });
    child.on("close", finish);
  });
}

function websocketEnv(selectedProfile) {
  const stress = selectedProfile === "stress";
  return {
    GAME_WS_BENCH_PLAYERS: process.env.GAME_WS_BENCH_PLAYERS ?? (stress ? "600" : "500"),
    GAME_WS_BENCH_COMMANDS: process.env.GAME_WS_BENCH_COMMANDS ?? (stress ? "8" : "4"),
    GAME_WS_BENCH_CONNECT_BATCH: process.env.GAME_WS_BENCH_CONNECT_BATCH ?? (stress ? "100" : "100"),
    GAME_WS_BENCH_TIMEOUT_MS: process.env.GAME_WS_BENCH_TIMEOUT_MS ?? (stress ? "30000" : "20000"),
  };
}

function summarize(results) {
  const byId = Object.fromEntries(results.map((result) => [result.id, result.parsed]));
  return {
    websocket: byId.websocket?.timing && {
      players: byId.websocket.config?.players,
      commandsPerPlayer: byId.websocket.config?.commandsPerPlayer,
      receiptP95Ms: byId.websocket.timing.receiptLatencyMs?.p95,
      receiptP99Ms: byId.websocket.timing.receiptLatencyMs?.p99,
      bytes: byId.websocket.delivery?.bytes,
      peakRssMb: byId.websocket.memory?.peakRssMb,
      passes: byId.websocket.budget?.receiptP95Passes,
    },
    browser: byId["browser-roll-journeys"] && {
      status: byId["browser-roll-journeys"].status,
      journeys: byId["browser-roll-journeys"].journeys,
    },
  };
}

function deriveFindings(results) {
  const findings = [];
  const parsedById = Object.fromEntries(results.map((result) => [result.id, result.parsed]));
  for (const result of results) {
    if (result.timedOut) {
      findings.push({
        severity: "error",
        id: `${result.id}.command_timeout`,
        message: `${result.id} timed out before emitting metrics`,
        nextAction: "Keep the timeout artifact, then narrow the bench to the first missing receipt/session before changing budgets.",
      });
      continue;
    }
    if (result.exitCode !== 0 && !result.parsed) {
      findings.push({
        severity: "error",
        id: `${result.id}.command_failed`,
        message: `${result.id} exited ${result.exitCode}`,
        nextAction: "Fix the failing bench before trusting optimization deltas.",
      });
    }
    if (!result.parsed) {
      findings.push({
        severity: "error",
        id: `${result.id}.missing_json`,
        message: `${result.id} did not emit parseable JSON metrics`,
        nextAction: "Make the bench emit one JSON object so autonomous comparison can proceed.",
      });
    }
    if (result.parsed?.status && result.parsed.status !== "pass") {
      findings.push({
        severity: "fail",
        id: `${result.id}.status`,
        message: `${result.id} reported status ${result.parsed.status}`,
        nextAction: "Open the parsed gate report and fix the first listed failure before broadening the optimization pass.",
      });
    }
  }

  const websocket = parsedById.websocket;
  if (websocket?.budget?.receiptP95Passes === false) {
    findings.push({
      severity: "fail",
      id: "websocket.receipt_p95",
      message: `websocket receipt p95 ${websocket.timing?.receiptLatencyMs?.p95}ms exceeded ${websocket.budget?.receiptP95BudgetMs}ms`,
      nextAction: "Prioritize receipt lane and prevent snapshot work from delaying command acknowledgements.",
    });
  }

  if (findings.length === 0) {
    findings.push({
      severity: "pass",
      id: "suite.clean",
      message: "Configured deterministic gates passed.",
      nextAction: "Increase GAME_OPT_PROFILE=stress or lower one budget to keep finding the next bottleneck.",
    });
  }
  return findings;
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

function tail(text, maxLength = 1600) {
  if (!text) return "";
  return text.length > maxLength ? text.slice(text.length - maxLength) : text;
}

function isEnabled(value) {
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

function parsePositiveInt(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function round(value) {
  return Math.round(value * 1000) / 1000;
}
