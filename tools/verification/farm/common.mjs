import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

export class FarmError extends Error {
  constructor(message, { code = "FARM_ERROR", details, cause } = {}) {
    super(message, { cause });
    this.name = this.constructor.name;
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

export function parseArgs(argv) {
  const args = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      args._.push(token);
      continue;
    }
    const equals = token.indexOf("=");
    if (equals !== -1) {
      args[token.slice(2, equals)] = token.slice(equals + 1);
      continue;
    }
    const key = token.slice(2);
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith("--")) {
      args[key] = next;
      index += 1;
    } else {
      args[key] = true;
    }
  }
  return args;
}

export async function runProcess(command, argv = [], {
  cwd,
  env,
  input,
  signal,
  timeoutMs = 60_000,
  maxOutputBytes = 4 * 1024 * 1024,
} = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, argv, {
      cwd,
      env: env ? { ...process.env, ...env } : process.env,
      stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let overflow = false;
    let timedOut = false;
    let aborted = false;
    let spawnError;
    const terminate = () => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 2_000).unref();
    };
    const onAbort = () => {
      aborted = true;
      terminate();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
    const timer = timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          terminate();
        }, timeoutMs)
      : undefined;
    timer?.unref();

    const collect = (chunks, chunk, currentBytes) => {
      if (currentBytes + chunk.length > maxOutputBytes) {
        overflow = true;
        return currentBytes;
      }
      chunks.push(chunk);
      return currentBytes + chunk.length;
    };
    child.stdout.on("data", (chunk) => {
      stdoutBytes = collect(stdout, chunk, stdoutBytes);
    });
    child.stderr.on("data", (chunk) => {
      stderrBytes = collect(stderr, chunk, stderrBytes);
    });
    child.on("error", (error) => {
      spawnError = error;
    });
    child.on("close", (exitCode, childSignal) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve({
        command,
        argv,
        exitCode,
        signal: childSignal,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        overflow,
        timedOut,
        aborted,
        error: spawnError,
        ok: exitCode === 0 && !timedOut && !aborted && !overflow && !spawnError,
      });
    });
    if (input !== undefined) {
      child.stdin.on("error", () => {});
      child.stdin.end(input);
    }
  });
}

export function processFailure(result, label) {
  const reason = result.error
    ? result.error.code ?? result.error.message
    : result.timedOut
      ? "timeout"
      : result.overflow
        ? "output-limit"
        : `exit-${result.exitCode}${result.signal ? `-${result.signal}` : ""}`;
  return new FarmError(`${label} failed (${reason})`, {
    code: "PROCESS_FAILED",
    details: { command: result.command, exitCode: result.exitCode, signal: result.signal, reason },
    cause: result.error,
  });
}

export function printJson(value, pretty = false) {
  process.stdout.write(`${JSON.stringify(value, null, pretty ? 2 : 0)}\n`);
}

export function errorDocument(schema, error) {
  return {
    schema,
    status: "error",
    error: {
      code: error?.code ?? "UNEXPECTED_ERROR",
      message: error instanceof Error ? error.message : String(error),
      ...(error?.details === undefined ? {} : { details: error.details }),
    },
  };
}
