import { spawn } from "node:child_process";
import path from "node:path";

import type { SuccessorDriverEnvelope, SuccessorDriverInboundFrame } from "../../client/src/headless/protocol";

export const SCRATCH_STACK_MIN_PORT = 28_000;
export const SCRATCH_STACK_MAX_PORT = 65_535;

export interface ScratchDriverRunOptions {
  port?: number | null;
  repoRoot?: string;
  frames: readonly SuccessorDriverInboundFrame[];
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

export interface ScratchDriverRunResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  stdoutLines: string[];
  stderrLines: string[];
}

export function scratchPortFromEnv(env: NodeJS.ProcessEnv = process.env): number | null {
  const raw = env.OPEN_DESERT_PORT;
  if (raw === undefined || raw === "") return null;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < SCRATCH_STACK_MIN_PORT || port > SCRATCH_STACK_MAX_PORT) {
    throw new Error(`OPEN_DESERT_PORT must be a scratch port in ${SCRATCH_STACK_MIN_PORT}..${SCRATCH_STACK_MAX_PORT}; got ${raw}`);
  }
  return port;
}

export function scratchEndpoint(port: number): string {
  if (!Number.isInteger(port) || port < SCRATCH_STACK_MIN_PORT || port > SCRATCH_STACK_MAX_PORT) {
    throw new Error(`scratch endpoint requires port ${SCRATCH_STACK_MIN_PORT}..${SCRATCH_STACK_MAX_PORT}; got ${port}`);
  }
  return `http://127.0.0.1:${port}`;
}

export async function runScratchDriverTranscript(options: ScratchDriverRunOptions): Promise<ScratchDriverRunResult> {
  const port = options.port ?? scratchPortFromEnv(options.env ?? process.env);
  if (port === null) throw new Error("OPEN_DESERT_PORT is required for scratch driver integration");
  const timeoutMs = options.timeoutMs ?? 15_000;
  const repoRoot = options.repoRoot ?? path.resolve(import.meta.dirname, "..", "..");
  const cliPath = path.join(repoRoot, "client", "dist", "headless", "cli.js");
  const slicePath = path.join(repoRoot, "client", "public", "successor-slice", "open-desert-slice.json");
  const child = spawn(
    process.execPath,
    [
      cliPath,
      "--game-url",
      scratchEndpoint(port),
      "--slice",
      slicePath,
      "--ready-timeout-ms",
      String(timeoutMs),
    ],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        ...(options.env ?? {}),
        OPEN_DESERT_PORT: String(port),
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );

  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  const timeout = setTimeout(() => {
    child.kill("SIGTERM");
  }, timeoutMs + 2_000);

  try {
    for (const frame of options.frames) {
      child.stdin.write(`${JSON.stringify(frame)}\n`);
    }
    if (!options.frames.some((frame) => frame.op === "quit")) {
      child.stdin.write(`${JSON.stringify({ op: "quit" } satisfies SuccessorDriverInboundFrame)}\n`);
    }
    child.stdin.end();

    const result = await new Promise<ScratchDriverRunResult>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", (code, signal) => {
        resolve({
          code,
          signal,
          stdout,
          stderr,
          stdoutLines: splitLines(stdout),
          stderrLines: splitLines(stderr),
        });
      });
    });
    return result;
  } finally {
    clearTimeout(timeout);
    if (!child.killed && child.exitCode === null) child.kill("SIGTERM");
  }
}

export function parseDriverEnvelopes(lines: readonly string[]): SuccessorDriverEnvelope[] {
  return lines
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as SuccessorDriverEnvelope);
}

function splitLines(value: string): string[] {
  return value.split(/\r?\n/u).filter((line) => line.length > 0);
}
