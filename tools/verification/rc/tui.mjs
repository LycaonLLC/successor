import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { assertPrivatePath, ensurePrivateDirectory } from "./path-security.mjs";

const PROBE_TIMEOUT_MS = 60_000;
const MAX_OUTPUT_BYTES = 16_384;
const SAFE_ENV_KEYS = ["PATH", "HOME", "TMPDIR", "LANG", "TZ"];

export async function runTuiWorldProof({ stack, player, runRoot, signal, onEvent } = {}) {
  if (!stack || typeof stack !== "object") return { status: "incomplete", reason: "stack_unavailable" };
  if (!player || typeof player.mintTuiLaunch !== "function") return { status: "incomplete", reason: "character_launch_unavailable" };
  const repoRoot = path.resolve(String(stack.repoRoot ?? ""));
  const cliPath = path.join(repoRoot, "client-tui", "dist", "cli.js");
  const slicePath = path.join(repoRoot, "client", "public", "successor-slice", "open-desert-slice.json");
  let envelope;
  try {
    await ensurePrivateDirectory(runRoot, "private");
    envelope = await player.mintTuiLaunch();
    validateLaunchEnvelope(envelope, stack);
  } catch {
    return { status: "incomplete", reason: "character_launch_unavailable" };
  }

  const privateRoot = path.join(path.resolve(String(runRoot ?? "")), "private");
  const capabilityPath = path.join(privateRoot, `.tui-capability-${process.pid}-${Date.now()}`);
  await assertPrivatePath(runRoot, capabilityPath);
  const capability = JSON.stringify({
    gameTicket: envelope.gameTicket,
    // Colyseus SDK uses one base URL for HTTP matchmake and room WebSocket.
    // The local edge exposes both at its origin; the advertised /game/ws path
    // is the browser-facing socket hint and must not become an SDK path prefix.
    endpoint: nativeGameEndpoint(stack),
    origin: envelope.origin,
    characterId: envelope.characterId,
    slicePath,
  });
  let handle;
  let child;
  let exited = false;
  let output = "";
  let outputOverflow = false;
  const startedAt = Date.now();
  try {
    await fs.writeFile(capabilityPath, capability, { encoding: "utf8", mode: 0o600, flag: "wx" });
    handle = await fs.open(capabilityPath, "r");
    await fs.unlink(capabilityPath);
    if (signal?.aborted) return { status: "incomplete", reason: "aborted" };
    child = spawn(process.execPath, [cliPath, "--rc-world-probe", "--rc-probe-fd", "3"], {
      cwd: repoRoot,
      env: sterileEnv(),
      detached: true,
      stdio: ["ignore", "pipe", "ignore", handle.fd],
    });
    await handle.close();
    handle = undefined;
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => {
      if (Buffer.byteLength(output) + Buffer.byteLength(String(chunk)) > MAX_OUTPUT_BYTES) {
        outputOverflow = true;
        return;
      }
      output += String(chunk);
    });
    const abort = () => terminateChild(child);
    signal?.addEventListener("abort", abort, { once: true });
    const exit = await waitChild(child, PROBE_TIMEOUT_MS);
    exited = true;
    signal?.removeEventListener("abort", abort);
    const parsed = outputOverflow ? null : parseTuiProbeOutput(output);
    const cleanExit = exit.code === 0 && exit.signal === null;
    // Child close is the teardown barrier. Only then may cleanupComplete enter
    // the gate input; protocol output itself cannot self-attest process cleanup.
    const gate = tuiGateStatus(parsed ? { ...parsed, cleanupComplete: cleanExit } : null, cleanExit);
    const result = { ...gate, processExited: exited, cleanupComplete: cleanExit, durationMs: Date.now() - startedAt };
    onEvent?.({ type: "tui.world.probe", status: result.status, authorityConnected: result.authorityConnected, tickPositive: result.tickPositive, identityMatch: result.identityMatch, sourceMatchesClient: result.sourceMatchesClient, reasonClass: result.reasonClass, processExited: result.processExited, cleanupComplete: result.cleanupComplete });
    return result;
  } catch (error) {
    if (child && !exited) {
      try { await terminateChild(child); } catch { /* preserve the original failure */ }
    }
    return { status: "incomplete", reason: error?.code === "ETIMEDOUT" ? "probe_timeout" : "probe_failed", processExited: exited, cleanupComplete: false };
  } finally {
    if (handle) await handle.close().catch(() => undefined);
    await fs.unlink(capabilityPath).catch(() => undefined);
    if (child && !exited) await terminateChild(child).catch(() => undefined);
  }
}

export function tuiGateStatus(result, processExited = result?.processExited === true) {
  if (!result || typeof result !== "object") return { status: "incomplete", reason: "probe_missing" };
  if (result.status === "fail" || Object.values(result).some((value) => value === false)) return { status: "fail", reason: result.reasonClass ?? result.reason ?? "probe_failed", ...safeProbeFlags(result) };
  const required = ["authorityConnected", "tickPositive", "identityMatch", "sourceMatchesClient"];
  if (required.some((key) => result[key] !== true) || processExited !== true || result.cleanupComplete !== true) return { status: "incomplete", reason: result.reason ?? "probe_incomplete", ...safeProbeFlags(result) };
  return { status: "pass", ...safeProbeFlags(result) };
}

export function parseTuiProbeOutput(stdout) {
  const lines = String(stdout ?? "").trim().split(/\r?\n/u).filter(Boolean);
  if (lines.length !== 1) return null;
  let value;
  try { value = JSON.parse(lines[0]); } catch { return null; }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const allowed = new Set(["type", "status", "reasonClass", "authorityConnected", "tickPositive", "identityMatch", "sourceMatchesClient"]);
  if (Object.keys(value).some((key) => !allowed.has(key))) return null;
  if (value.type !== "successor.tui.world-ready.v1") return null;
  if (value.status !== "pass" && value.status !== "fail") return null;
  if (value.reasonClass !== undefined && !["input", "session-start", "authority-timeout", "probe-crash"].includes(value.reasonClass)) return null;
  if (value.status === "fail" && value.reasonClass === undefined) return null;
  for (const key of ["authorityConnected", "tickPositive", "identityMatch", "sourceMatchesClient"]) if (typeof value[key] !== "boolean") return null;
  return value;
}

function safeProbeFlags(value) {
  return { ...(typeof value.authorityConnected === "boolean" ? { authorityConnected: value.authorityConnected } : {}), ...(typeof value.tickPositive === "boolean" ? { tickPositive: value.tickPositive } : {}), ...(typeof value.identityMatch === "boolean" ? { identityMatch: value.identityMatch } : {}), ...(typeof value.sourceMatchesClient === "boolean" ? { sourceMatchesClient: value.sourceMatchesClient } : {}), ...(typeof value.reasonClass === "string" ? { reasonClass: value.reasonClass } : {}) };
}

export function nativeGameEndpoint(stack) {
  if (!stack || typeof stack.gameEndpoint !== "string") throw new Error("local stack game endpoint unavailable");
  const endpoint = new URL(stack.gameEndpoint);
  if (endpoint.protocol !== "wss:" || endpoint.pathname !== "/game/ws" || endpoint.search || endpoint.hash) throw new Error("local TLS game endpoint invalid");
  return endpoint.origin;
}

export function validateLaunchEnvelope(value, stack) {
  if (!value || typeof value !== "object") throw new Error("launch missing");
  for (const key of ["gameTicket", "characterId", "origin"]) if (typeof value[key] !== "string" || value[key].length === 0) throw new Error("launch incomplete");
  if (!stack || typeof stack.siteUrl !== "string" || typeof stack.gameEndpoint !== "string") throw new Error("local stack endpoint unavailable");
  if (value.origin !== stack.siteUrl) throw new Error("storefront origin is not local stack origin");
  if (!value.endpoints || value.endpoints.game !== stack.gameEndpoint) throw new Error("game endpoint is not local stack endpoint");
  const origin = new URL(stack.siteUrl);
  const endpoint = new URL(stack.gameEndpoint);
  if (origin.protocol !== "https:" || endpoint.protocol !== "wss:" || endpoint.pathname !== "/game/ws" || endpoint.host !== origin.host) throw new Error("local TLS endpoint invalid");
  return true;
}

function sterileEnv() {
  const env = {};
  for (const key of SAFE_ENV_KEYS) if (process.env[key]) env[key] = process.env[key];
  env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  return env;
}

function waitChild(child, timeoutMs) {
  return new Promise((resolve, reject) => {
    let timer;
    const finish = (value, error) => { clearTimeout(timer); child.removeListener("close", onClose); child.removeListener("error", onError); if (error) reject(error); else resolve(value); };
    const onClose = (code, signal) => finish({ code, signal });
    const onError = (error) => finish(null, error);
    child.once("close", onClose);
    child.once("error", onError);
    timer = setTimeout(() => { void terminateChild(child).finally(() => finish(null, Object.assign(new Error("TUI probe timed out"), { code: "ETIMEDOUT" }))); }, timeoutMs);
  });
}

async function terminateChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  try { process.kill(-child.pid, "SIGTERM"); } catch { try { child.kill("SIGTERM"); } catch { /* already gone */ } }
  await new Promise((resolve) => setTimeout(resolve, 2_000));
  if (child.exitCode === null && child.signalCode === null) {
    try { process.kill(-child.pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch { /* already gone */ } }
  }
}
