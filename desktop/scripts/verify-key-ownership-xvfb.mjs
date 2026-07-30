#!/usr/bin/env node
import { appendFile, mkdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "../..");
const logDir = path.join(root, ".successor-standalone-key-ownership");
const logPath = path.join(logDir, "openbox.log");
await mkdir(logDir, { recursive: true });
const log = async (line) => appendFile(logPath, `${new Date().toISOString()} ${line}\n`);
let wm;
let check;
let stopping = false;
const stop = async (code = 1) => {
  if (stopping) return;
  stopping = true;
  if (check?.pid) { try { process.kill(-check.pid, "SIGTERM"); } catch {} }
  if (wm?.pid) { try { process.kill(-wm.pid, "SIGTERM"); } catch {} }
  await log(`cleanup code=${code}`);
  process.exitCode = code;
};
process.on("SIGTERM", () => void stop(143));
process.on("SIGINT", () => void stop(130));
wm = spawn("openbox", ["--sm-disable"], { cwd: root, detached: true, stdio: ["ignore", "pipe", "pipe"] });
wm.stdout.on("data", (chunk) => void log(`stdout ${String(chunk).trim()}`));
wm.stderr.on("data", (chunk) => void log(`stderr ${String(chunk).trim()}`));
wm.on("error", async (error) => { await log(`spawn-error ${error.message}`); await stop(1); });
await new Promise((resolve) => setTimeout(resolve, 500));
if (wm.exitCode !== null) { await log(`openbox-exited ${wm.exitCode}`); await stop(1); }
check = spawn("pnpm", ["--dir", "desktop", "run", "verify:key-ownership"], { cwd: root, env: { ...process.env, DISPLAY: process.env.DISPLAY, SUCCESSOR_DESKTOP_VERIFY_SOFTWARE_GL: process.env.SUCCESSOR_DESKTOP_VERIFY_SOFTWARE_GL ?? "1" }, detached: true, stdio: "inherit" });
check.on("error", async (error) => { await log(`check-error ${error.message}`); await stop(1); });
check.on("close", async (code, signal) => { await log(`check-exit code=${code} signal=${signal ?? ""}`); await stop(code ?? 1); });
