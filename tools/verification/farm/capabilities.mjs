#!/usr/bin/env node
import fs from "node:fs";
import { access } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { errorDocument, parseArgs, printJson, repoRoot, runProcess } from "./common.mjs";
import { loadChromium } from "../client3d/lib/browser.mjs";

export const CAPABILITIES_SCHEMA = "successor.farm-capabilities.v1";
const PORT_RANGE_START = 29_700;
const PORT_RANGE_END = 29_799;
const PORT_WINDOW_SIZE = 32;

export async function probeCapabilities({ root = repoRoot } = {}) {
  const absoluteRoot = path.resolve(root);
  const [pnpm, rustc, cargo, rustupTargets, rsync, systemdRun, systemdUser, ffmpeg, playwright, processHostModule, ports] =
    await Promise.all([
      probeVersionCommand("pnpm", ["--version"]),
      probeVersionCommand("rustc", ["--version"]),
      probeVersionCommand("cargo", ["--version"]),
      probeCommand("rustup", ["target", "list", "--installed"]),
      probeCommand("rsync", ["--version"]),
      probeVersionCommand("systemd-run", ["--version"]),
      probeCommand("systemctl", ["--user", "is-system-running"], { acceptedExitCodes: [0, 1] }),
      probeVersionCommand("ffmpeg", ["-version"]),
      probePlaywright(absoluteRoot),
      pathAvailable(path.join(absoluteRoot, "tools", "verification", "lib", "process-host.mjs")),
      findFreePortRange(),
    ]);

  const wasmInstalled = rustupTargets.available && rustupTargets.stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .includes("wasm32-unknown-unknown");
  const rsyncProtocol = rsync.available
    ? Number(rsync.stdout.match(/protocol version\s+(\d+)/iu)?.[1] ?? NaN)
    : null;
  const systemdState = systemdUser.stdout.trim();
  const systemdOperational = systemdRun.available && systemdUser.available &&
    (systemdState === "running" || systemdState === "degraded");
  const processHostOverride = process.env.SUCCESSOR_PROCESS_HOST;
  const selectedProcessHost = processHostOverride === "child" || processHostOverride === "systemd"
    ? processHostOverride
    : systemdOperational
      ? "systemd"
      : "child";

  return {
    schema: CAPABILITIES_SCHEMA,
    generatedAt: new Date().toISOString(),
    host: {
      hostname: os.hostname(),
      os: os.platform(),
      osRelease: os.release(),
      arch: os.arch(),
      logicalCores: os.cpus().length,
      totalMemoryBytes: os.totalmem(),
    },
    toolchain: {
      node: {
        available: true,
        version: process.version.replace(/^v/u, ""),
        executable: process.execPath,
      },
      pnpm: publicProbe(pnpm),
      rustc: publicProbe(rustc),
      cargo: publicProbe(cargo),
      wasmTarget: {
        available: wasmInstalled,
        target: "wasm32-unknown-unknown",
        probeAvailable: rustupTargets.available,
        ...(rustupTargets.available ? {} : { reason: rustupTargets.reason }),
      },
      rsync: {
        available: rsync.available,
        version: rsync.available ? parseRsyncVersion(rsync.stdout) : null,
        protocol: Number.isFinite(rsyncProtocol) ? rsyncProtocol : null,
        ...(rsync.available ? {} : { reason: rsync.reason }),
      },
    },
    runtime: {
      systemd: {
        available: systemdRun.available,
        version: systemdRun.version,
        userManagerOperational: systemdOperational,
        ...(systemdRun.available ? {} : { reason: systemdRun.reason }),
      },
      playwright,
      ffmpeg: publicProbe(ffmpeg),
      processHost: {
        available: processHostModule,
        selected: selectedProcessHost,
        override: processHostOverride ?? null,
        systemdOperational,
      },
    },
    networking: {
      freePortRange: ports,
    },
    tempRoot: os.tmpdir(),
  };
}

async function probePlaywright(root) {
  try {
    const { chromium, resolvedFrom } = loadChromium(root);
    const cli = await probeVersionCommand("pnpm", ["exec", "playwright", "--version"], { cwd: root });
    const executable = chromium.executablePath();
    const installed = fs.existsSync(executable);
    let chromiumVersion = null;
    if (installed) {
      const versionResult = await runProcess(executable, ["--version"], { timeoutMs: 15_000 });
      if (versionResult.ok) chromiumVersion = firstLine(versionResult.stdout).trim() || null;
    }
    return {
      available: true,
      package: resolvedFrom.includes("playwright-core") ? "playwright-core" : "playwright",
      version: cli.version ?? parsePlaywrightVersion(resolvedFrom),
      chromiumInstalled: installed,
      chromiumVersion,
    };
  } catch (error) {
    const cli = await probeVersionCommand("pnpm", ["exec", "playwright", "--version"], { cwd: root });
    return {
      available: cli.available,
      package: cli.available ? "playwright" : null,
      version: cli.version,
      chromiumInstalled: false,
      chromiumVersion: null,
      ...(cli.available ? {} : { reason: error?.code ?? error?.name ?? cli.reason }),
    };
  }
}

async function findFreePortRange() {
  for (let start = PORT_RANGE_START; start + PORT_WINDOW_SIZE - 1 <= PORT_RANGE_END; start += PORT_WINDOW_SIZE) {
    const servers = [];
    let available = true;
    for (let port = start; port < start + PORT_WINDOW_SIZE; port += 1) {
      try {
        servers.push(await listenOnPort(port));
      } catch {
        available = false;
        break;
      }
    }
    await Promise.all(servers.map(closeServer));
    if (available) {
      return {
        availableAtProbe: true,
        start,
        end: start + PORT_WINDOW_SIZE - 1,
        size: PORT_WINDOW_SIZE,
        address: "127.0.0.1",
      };
    }
  }
  return {
    availableAtProbe: false,
    start: null,
    end: null,
    size: 0,
    address: "127.0.0.1",
  };
}

function listenOnPort(port) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () => {
      server.removeListener("error", reject);
      resolve(server);
    });
  });
}

function closeServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

async function probeVersionCommand(command, argv, options = {}) {
  const result = await probeCommand(command, argv, options);
  return {
    ...result,
    version: result.available ? parseVersion(firstLine(result.stdout)) : null,
  };
}

async function probeCommand(command, argv, { acceptedExitCodes = [0], ...options } = {}) {
  const result = await runProcess(command, argv, { timeoutMs: 15_000, maxOutputBytes: 512 * 1024, ...options });
  const accepted = !result.error && !result.timedOut && !result.overflow && acceptedExitCodes.includes(result.exitCode);
  return {
    available: accepted,
    exitCode: result.exitCode,
    stdout: result.stdout,
    reason: accepted ? null : probeReason(result),
  };
}

function publicProbe(probe) {
  return {
    available: probe.available,
    version: probe.version,
    ...(probe.available ? {} : { reason: probe.reason }),
  };
}

function probeReason(result) {
  if (result.error) return result.error.code ?? result.error.name ?? "spawn-error";
  if (result.timedOut) return "timeout";
  if (result.overflow) return "output-limit";
  return `exit-${result.exitCode}${result.signal ? `-${result.signal}` : ""}`;
}

function parseVersion(line) {
  return line.match(/\d+(?:\.\d+)+(?:[-+][0-9A-Za-z.-]+)?/u)?.[0] ?? (line.trim() || null);
}

function parseRsyncVersion(line) {
  return line.match(/version\s+(\d+(?:\.\d+)+)/iu)?.[1] ?? null;
}

function parsePlaywrightVersion(resolvedFrom) {
  return resolvedFrom.match(/playwright(?:-core)?@([^/]+)/u)?.[1]?.split("_")[0] ?? null;
}

function firstLine(text) {
  return text.split(/\r?\n/u)[0] ?? "";
}

async function pathAvailable(candidate) {
  try {
    await access(candidate, fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const capabilities = await probeCapabilities({ root: args.root ?? repoRoot });
  printJson(capabilities, Boolean(args.pretty));
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error) => {
    printJson(errorDocument(CAPABILITIES_SCHEMA, error), true);
    process.exitCode = 1;
  });
}
