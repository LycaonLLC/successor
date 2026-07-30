#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { packageTuiArtifact } from "../../release/package-tui.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const outDir = path.resolve(process.env.SUCCESSOR_MATRIX_ARTIFACT_ROOT ?? path.join(os.homedir(), ".cache", "successor", "standalone-rc"), "tui-packaged-smoke");
const runtimeCandidates = [process.env.SUCCESSOR_TUI_NODE22_RUNTIME, path.join(os.userInfo().homedir, ".cache", "successor", "node-v22.22.2-linux-x64", "bin", "node"), "/opt/successor/node-v22.22.2-linux-x64/bin/node", "/usr/local/bin/node"].filter(Boolean);
let runtimePath;
for (const candidate of runtimeCandidates) { try { if ((await stat(candidate)).isFile()) { const version = (await run(candidate, ["--version"])).stdout.trim(); if (/^v22\./u.test(version)) { runtimePath = candidate; break; } } } catch {} }
if (!runtimePath) throw new Error("known Node 22.22.2 Linux x64 runtime missing; set SUCCESSOR_TUI_NODE22_RUNTIME to a fixed path");
const distDir = path.join(root, "client-tui", "dist");
const slicePath = path.join(root, "client", "public", "successor-slice", "open-desert-slice.json");
const { archivePath, row } = await packageTuiArtifact({ platform: "linux", arch: "x64", releaseId: "standalone-rc", version: "0.0.1", distDir, runtimePath, slicePath, repoRoot: root, outDir });
const extractDir = path.join(outDir, "extracted");
await rm(extractDir, { recursive: true, force: true });
await mkdir(extractDir, { recursive: true });
const tar = await run("tar", ["-xzf", archivePath, "-C", extractDir]);
if (tar.code !== 0) throw new Error(`TUI archive extraction failed: ${tar.stderr}`);
const entry = path.join(extractDir, "successor-tui-standalone-rc", "bin", "successor-tui");
const help = await run(entry, ["--help"], { timeoutMs: 15_000 });
if (help.code !== 0 || /ERR_MODULE_NOT_FOUND/u.test(`${help.stdout}\n${help.stderr}`) || !/hosted|login|ticket/iu.test(help.stdout)) throw new Error(`packaged TUI --help failed or omitted hosted commands: ${help.stderr || help.stdout}`);
const legacy = await run(entry, [], { env: { SUCCESSOR_TICKET: "forbidden-test-ticket" }, timeoutMs: 15_000 });
if (legacy.code === 0 || !/legacy|SUCCESSOR_TICKET|refus/iu.test(`${legacy.stdout}\n${legacy.stderr}`)) throw new Error("SUCCESSOR_TICKET was not refused outside --legacy");
console.log(JSON.stringify({ schema: "successor.tui-packaged-executable-smoke.v1", status: "pass", archive: { path: path.relative(root, archivePath), bytes: row.bytes, sha256: row.sha256 }, proof: "packaged executable/runtime smoke only; no publishability or live-world claim", nonLive: true }));

function run(command, args, { env = {}, timeoutMs = 30_000 } = {}) { return new Promise((resolve, reject) => { const child = spawn(command, args, { cwd: root, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] }); let stdout = ""; let stderr = ""; const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs); child.stdout.on("data", (chunk) => { stdout += chunk; }); child.stderr.on("data", (chunk) => { stderr += chunk; }); child.on("error", reject); child.on("close", (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr }); }); }); }
