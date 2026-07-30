#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const STATUS_SCHEMA = "successor.farm-task-exec.v1";

export async function executeTaskDescriptor({ descriptorPath, statusPath }) {
  const descriptor = JSON.parse(await fs.readFile(descriptorPath, "utf8"));
  validateDescriptor(descriptor);
  const startedAt = new Date().toISOString();
  const started = performance.now();
  const child = spawn(descriptor.argv[0], descriptor.argv.slice(1), {
    cwd: descriptor.cwd,
    env: { ...process.env, ...descriptor.env },
    shell: false,
    detached: process.platform !== "win32",
    stdio: "inherit",
  });
  const completion = await new Promise((resolve) => {
    let spawnError = null;
    let timedOut = false;
    const terminate = () => {
      timedOut = true;
      killProcessGroup(child, "SIGTERM");
      setTimeout(() => killProcessGroup(child, "SIGKILL"), descriptor.graceMs).unref();
    };
    const timer = setTimeout(terminate, descriptor.deadlineMs);
    child.once("error", (error) => { spawnError = error; });
    child.once("close", (exitCode, signal) => {
      clearTimeout(timer);
      resolve({ exitCode, signal, spawnError, timedOut });
    });
  });
  const status = {
    schema: STATUS_SCHEMA,
    startedAt,
    completedAt: new Date().toISOString(),
    durationMs: Math.round((performance.now() - started) * 1000) / 1000,
    exitCode: completion.exitCode,
    signal: completion.signal,
    timedOut: completion.timedOut,
    error: completion.spawnError ? { code: completion.spawnError.code ?? null, message: completion.spawnError.message } : null,
  };
  await writeAtomic(statusPath, status);
  return completion.spawnError ? 127 : completion.timedOut ? 124 : completion.exitCode ?? (completion.signal ? 128 : 1);
}

function validateDescriptor(value) {
  if (!value || value.schema !== "successor.farm-task-descriptor.v1") throw new Error("invalid farm task descriptor schema");
  if (!Array.isArray(value.argv) || value.argv.length === 0 || value.argv.some((item) => typeof item !== "string" || item.includes("\0"))) throw new Error("invalid farm task argv");
  if (typeof value.cwd !== "string" || !path.isAbsolute(value.cwd)) throw new Error("invalid farm task cwd");
  if (!value.env || typeof value.env !== "object" || Array.isArray(value.env) || Object.values(value.env).some((item) => typeof item !== "string")) throw new Error("invalid farm task env");
  value.deadlineMs ??= 15 * 60_000;
  value.graceMs ??= 30_000;
  if (!Number.isInteger(value.deadlineMs) || value.deadlineMs <= 0 || !Number.isInteger(value.graceMs) || value.graceMs < 0) throw new Error("invalid farm task deadline");
}

function killProcessGroup(child, signal) {
  if (!child.pid) return;
  try {
    process.kill(process.platform === "win32" ? child.pid : -child.pid, signal);
  } catch (error) {
    if (error?.code !== "ESRCH") child.kill(signal);
  }
}

async function writeAtomic(outputPath, value) {
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  const temporary = `${outputPath}.tmp-${process.pid}`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fs.rename(temporary, outputPath);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const descriptorIndex = process.argv.indexOf("--descriptor");
  const statusIndex = process.argv.indexOf("--status");
  if (descriptorIndex === -1 || statusIndex === -1) throw new Error("usage: task-exec.mjs --descriptor FILE --status FILE");
  executeTaskDescriptor({ descriptorPath: path.resolve(process.argv[descriptorIndex + 1]), statusPath: path.resolve(process.argv[statusIndex + 1]) })
    .then((exitCode) => { process.exitCode = exitCode; })
    .catch((error) => { console.error(error.stack ?? error.message); process.exitCode = 127; });
}
