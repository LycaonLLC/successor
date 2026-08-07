#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const args = parseArgs(process.argv.slice(2));
const port = integer(args, "port", 18093);
const controlPort = integer(args, "control-port", 47778);
const actor = text(args, "actor", `movement-native-${Date.now().toString(36)}`);
const runId = text(args, "run-id", `${stamp()}-${actor}`);
const outDir = path.resolve(text(args, "out-dir", "/tmp/movement-lab"));
const sampleMs = integer(args, "sample-ms", 55);
const binary = path.resolve(text(args, "native-bin", path.join(repo, "client-rust/out/bin/successor-dev")));
const control = path.resolve(text(args, "control-bin", path.join(repo, "client-rust/out/bin/successor-control")));
const endpoint = text(args, "endpoint", `ws://127.0.0.1:${port}`);
const runDir = path.join(outDir, runId);
const metricPath = path.join(outDir, `metrics-${runId}.json`);

for (const required of [binary, control]) {
  if (!fs.existsSync(required)) throw new Error(`missing ${required}; run make -C client-rust dev`);
}
fs.mkdirSync(runDir, { recursive: true });
const child = spawn(binary, [
  "--dev-identity", "--endpoint", endpoint, "--player-id", actor, "--actor-id", actor,
  "--spawn-area", "open-desert-overworld", "--spawn-x", "700", "--spawn-y", "700",
  "--control-port", String(controlPort),
], { cwd: path.join(repo, "client-rust"), stdio: ["ignore", "pipe", "pipe"] });
let stderr = "";
child.stderr.on("data", chunk => { stderr = `${stderr}${chunk}`.slice(-16_384); });

try {
  await waitReady();
  await waitInputReady();
  const reports = [];
  for (const scenario of scenarios()) reports.push(await runScenario(scenario));
  const failures = reports.flatMap(report => report.failures.map(failure => `${report.id}: ${failure}`));
  const result = {
    schema: "successor.movement-lab.metrics.v1",
    runId,
    generatedAt: new Date().toISOString(),
    status: failures.length === 0 ? "pass" : "fail",
    driver: "rust-native-control",
    config: { clientKind: "rust-native", port, controlPort, actor, endpoint, sampleMs, binary, runDir },
    failures,
    scenarios: reports,
    clientStderrTail: stderr.split("\n").slice(-40),
  };
  fs.writeFileSync(metricPath, `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify({ status: result.status, metricPath, scenarios: reports.map(({ id, metrics }) => ({ id, ...metrics })) }, null, 2));
  if (failures.length) process.exitCode = 1;
} finally {
  for (const key of ["w", "a", "s", "d", "shift"]) command(`key up ${key}`, true);
  child.kill("SIGTERM");
  await Promise.race([new Promise(resolve => child.once("exit", resolve)), delay(3_000)]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

async function runScenario(scenario) {
  const samples = [];
  const keyEvents = [];
  const start = Date.now();
  let sampleError = null;
  let sampling = false;
  const takeSample = () => {
    if (sampling) return;
    sampling = true;
    try {
      const status = command("status");
      if (status?.movement) samples.push({ wallTimeMs: Date.now(), ...status.movement });
    } catch (error) {
      sampleError ??= String(error);
    } finally {
      sampling = false;
    }
  };
  takeSample();
  const timer = setInterval(takeSample, sampleMs);
  const key = async (kind, name) => {
    command(`key ${kind} ${name}`);
    keyEvents.push({ kind, name, wallTimeMs: Date.now() });
  };
  try {
    await scenario.run(key);
    await delay(350);
  } finally {
    clearInterval(timer);
    for (const name of ["w", "a", "s", "d", "shift"]) command(`key up ${name}`, true);
    takeSample();
  }
  const screenshot = path.join(runDir, `${scenario.id}.bmp`);
  command(`screenshot ${screenshot}`);
  const first = samples[0];
  const last = samples.at(-1);
  const distances = [];
  for (let i = 1; i < samples.length; i += 1) {
    distances.push(Math.hypot(
      samples[i].rendered[0] - samples[i - 1].rendered[0],
      samples[i].rendered[1] - samples[i - 1].rendered[1],
    ));
  }
  const firstDown = keyEvents.find(event => event.kind === "down" && event.name !== "shift");
  const firstMoved = firstDown && samples.find(sample => sample.wallTimeMs >= firstDown.wallTimeMs
    && Math.hypot(sample.rendered[0] - first.rendered[0], sample.rendered[1] - first.rendered[1]) >= 0.025);
  const applied = firstDown && samples.find(sample => sample.wallTimeMs >= firstDown.wallTimeMs
    && sample.applied_command_id > (first.applied_command_id ?? 0));
  const sent = firstDown && samples.find(sample => sample.wallTimeMs >= firstDown.wallTimeMs
    && sample.last_send_ms > (first.last_send_ms ?? 0));
  const clockOffset = sent ? sent.wallTimeMs - sent.sampled_at_ms : null;
  const sentWall = sent ? clockOffset + sent.last_send_ms : null;
  const metrics = {
    durationMs: Date.now() - start,
    sampleCount: samples.length,
    cumulativeDistanceCells: round(distances.reduce((sum, value) => sum + value, 0)),
    correctionMaxCells: round(Math.max(0, ...samples.map(sample => sample.correction_cells ?? 0))),
    inputToSendMs: firstDown && sentWall !== null ? round(sentWall - firstDown.wallTimeMs) : null,
    sendToAppliedObservedMs: sentWall !== null && applied ? round(applied.wallTimeMs - sentWall) : null,
    inputToRenderedMs: firstDown && firstMoved ? firstMoved.wallTimeMs - firstDown.wallTimeMs : null,
    start: first?.rendered ?? null,
    end: last?.rendered ?? null,
  };
  const failures = [];
  if (sampleError) failures.push(`status sampling failed: ${sampleError}`);
  if (samples.length < 4) failures.push(`too few samples: ${samples.length}`);
  if (metrics.cumulativeDistanceCells < 0.05) failures.push("movement distance too low");
  if (!fs.existsSync(screenshot)) failures.push("screenshot missing");
  return { id: scenario.id, status: failures.length ? "fail" : "pass", metrics, failures, keyEvents, samples, screenshots: [screenshot] };
}

function scenarios() {
  return [
    { id: "sprint-hold", run: async key => {
      await key("down", "shift"); await key("down", "w"); await delay(8_000);
      await key("up", "w"); await key("up", "shift");
    } },
    { id: "abrupt-180-flip", run: async key => {
      await key("down", "shift"); await key("down", "w"); await delay(4_000);
      await key("down", "s"); await key("up", "w"); await delay(4_000);
      await key("up", "s"); await key("up", "shift");
    } },
    { id: "stop-start", run: async key => {
      for (let i = 0; i < 10; i += 1) {
        await key("down", "shift"); await key("down", "w"); await delay(1_000);
        await key("up", "w"); await key("up", "shift"); await delay(500);
      }
    } },
    { id: "zigzag-90", run: async key => {
      await key("down", "shift");
      for (const name of ["w", "d", "s", "a", "w", "d", "s", "a", "w", "d"]) {
        await key("down", name); await delay(800); await key("up", name);
      }
      await key("up", "shift");
    } },
    { id: "diagonal-shifts", run: async key => {
      await key("down", "shift"); await key("down", "w"); await key("down", "d");
      let lateral = "d";
      for (let i = 0; i < 8; i += 1) {
        await delay(1_000);
        const next = lateral === "d" ? "a" : "d";
        await key("down", next); await key("up", lateral); lateral = next;
      }
      await key("up", lateral); await key("up", "w"); await key("up", "shift");
    } },
    { id: "sprint-marathon", run: async key => {
      await key("down", "shift"); await key("down", "w"); await delay(55_000);
      await key("up", "w"); await key("up", "shift");
    } },
  ];
}

async function waitReady() {
  const deadline = Date.now() + 45_000;
  let last = null;
  while (Date.now() < deadline) {
    try {
      last = command("status");
      if ((last?.game_connection === "Ready" || last?.game_connection === "Connected") && last?.movement) return;
    } catch {}
    if (child.exitCode !== null) throw new Error(`native client exited ${child.exitCode}: ${stderr}`);
    await delay(250);
  }
  throw new Error(`native client did not become ready: ${JSON.stringify(last)} ${stderr}`);
}

async function waitInputReady() {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    command("key down w");
    await delay(100);
    const status = command("status");
    if (status?.movement?.intent?.[1] === -1) {
      command("key up w");
      await delay(150);
      return;
    }
    command("key up w", true);
    await delay(250);
  }
  throw new Error("native control input did not become ready");
}

function command(value, ignoreFailure = false) {
  const result = spawnSync(control, ["--port", String(controlPort), ...value.split(" ")], { encoding: "utf8", timeout: 10_000 });
  if (result.status !== 0) {
    if (ignoreFailure) return null;
    throw new Error(`${value}: ${result.stderr || result.stdout}`);
  }
  const lines = result.stdout.trim().split("\n").filter(Boolean);
  return JSON.parse(lines.at(-1));
}

function parseArgs(values) {
  const out = new Map();
  for (let i = 0; i < values.length; i += 1) {
    const raw = values[i];
    if (!raw.startsWith("--")) continue;
    const eq = raw.indexOf("=");
    if (eq > 0) out.set(raw.slice(2, eq), raw.slice(eq + 1));
    else if (values[i + 1] && !values[i + 1].startsWith("--")) out.set(raw.slice(2), values[++i]);
    else out.set(raw.slice(2), "1");
  }
  return out;
}
function text(values, name, fallback) { return values.get(name) || fallback; }
function integer(values, name, fallback) {
  const value = Number(text(values, name, fallback));
  if (!Number.isInteger(value)) throw new Error(`--${name} must be an integer`);
  return value;
}
function delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function round(value) { return Math.round(value * 1_000) / 1_000; }
function stamp() { return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z"); }
