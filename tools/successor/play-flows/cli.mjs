#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";

import { fetchJson, gameUrlFromOptions, resolveCharacterForPlay, startPlayFlowDriver } from "./client.mjs";
import { createFlowContext, formatHumanStep } from "./primitives.mjs";
import { flowRegistry, runRegisteredFlow } from "./flows.mjs";

const repoRoot = path.resolve(import.meta.dirname, "../../..");

export async function main(argv = process.argv.slice(2), io = process) {
  const options = parseArgs(argv);
  if (options.help) {
    io.stdout.write(helpText());
    return 0;
  }
  const flowName = options.flow;
  if (!flowName) throw new Error("--flow is required");
  const gameUrl = gameUrlFromOptions(options);
  const startedAt = new Date().toISOString();
  const started = performance.now();
  const stepLines = [];
  let driver = null;
  let resolved = null;
  let ctx = null;

  const onStep = (step) => {
    const line = options.json
      ? JSON.stringify({ schema: "successor.play-flow.step.v1", ...step })
      : formatHumanStep(step);
    stepLines.push(line);
    if (!options.quiet) io.stdout.write(`${line}\n`);
  };

  try {
    resolved = await resolveCharacterForPlay({ ...options, gameUrl });
    driver = startPlayFlowDriver({
      repoRoot,
      gameUrl,
      slicePath: options.slicePath,
      cliPath: options.cliPath,
      character: resolved.character,
      join: resolved.join,
      spawnArea: options.spawnArea,
      spawnX: options.spawnX,
      spawnY: options.spawnY,
      facing: options.facing,
    });
    ctx = createFlowContext({
      flowName,
      gameUrl,
      driver,
      fetchJson,
      onStep,
      defaultTimeoutMs: options.timeoutMs ?? 12_000,
    });
    await waitForReady(driver, options.readyTimeoutMs ?? 12_000);

    const loop = Math.max(1, Math.trunc(options.loop ?? 1));
    const iterations = options.flowUsesLoop ? 1 : loop;
    const outcomes = [];
    for (let index = 0; index < iterations; index += 1) {
      outcomes.push(await runRegisteredFlow(ctx, flowName, { ...options, loopIndex: index, loop: options.flowUsesLoop ? loop : undefined }));
    }

    const report = buildReport({ status: "pass", flowName, options, resolved, startedAt, started, ctx, outcomes });
    await writeReport(options.out, report, stepLines);
    if (options.json) io.stdout.write(`${JSON.stringify(report)}\n`);
    else io.stdout.write(`FLOW ${flowName} PASS · steps=${ctx.steps.length} · receipts=${report.receipts.accepted}/${report.receipts.total} accepted\n`);
    return 0;
  } catch (error) {
    const report = buildReport({ status: "fail", flowName, options, resolved, startedAt, started, ctx, outcomes: [], error });
    await writeReport(options.out, report, stepLines).catch(() => undefined);
    if (options.json) io.stdout.write(`${JSON.stringify(report)}\n`);
    io.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    return 1;
  } finally {
    if (driver) await driver.close().catch(() => undefined);
  }
}

function buildReport({ status, flowName, options, resolved, startedAt, started, ctx, outcomes, error }) {
  const steps = ctx?.steps ?? [];
  const receipts = steps.flatMap((step) => step.receipt ? [step.receipt] : []);
  return {
    schema: "successor.play-flow.run.v1",
    status,
    flow: flowName,
    gameUrl: gameUrlFromOptions(options),
    startedAt,
    completedAt: new Date().toISOString(),
    durationMs: round(performance.now() - started),
    character: resolved ? {
      id: resolved.character.id,
      name: resolved.character.name,
      created: resolved.created,
      liveState: resolved.join.liveState,
      takeover: resolved.join.takeover === true,
      reconnect: resolved.join.reconnect === true,
    } : null,
    receipts: {
      total: receipts.length,
      accepted: receipts.filter((receipt) => receipt.accepted === true).length,
      rejected: receipts.filter((receipt) => receipt.accepted === false).length,
      rejectedByReason: countBy(receipts.filter((receipt) => receipt.accepted === false).map((receipt) => receipt.reasonCode ?? "unknown")),
    },
    steps,
    outcomes,
    ...(error ? { error: error instanceof Error ? error.message : String(error) } : {}),
  };
}

async function waitForReady(driver, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const ready = driver.envelopes.find((envelope) => envelope.type === "status" && envelope.status === "ready");
    if (ready) return ready;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for successor-play ready; stderr=${driver.stderr.join("\n")}`);
}

async function writeReport(outPath, report, stepLines) {
  if (!outPath) return;
  const resolved = path.resolve(repoRoot, outPath);
  await fs.mkdir(path.dirname(resolved), { recursive: true });
  const payload = outPath.endsWith(".jsonl")
    ? `${stepLines.join("\n")}${stepLines.length ? "\n" : ""}${JSON.stringify(report)}\n`
    : `${JSON.stringify(report, null, 2)}\n`;
  await fs.writeFile(resolved, payload, "utf8");
}

function parseArgs(argv) {
  const options = { json: false, create: true, flowUsesLoop: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") continue;
    if (arg === "--help" || arg === "-h") return { help: true };
    if (arg === "--json") { options.json = true; continue; }
    if (arg === "--quiet") { options.quiet = true; continue; }
    if (arg === "--no-create") { options.create = false; continue; }
    const value = argv[index + 1];
    if (value === undefined) throw new Error(`${arg} requires a value`);
    index += 1;
    switch (arg) {
      case "--port": options.port = finiteInteger(arg, value); break;
      case "--game-url": options.gameUrl = value; break;
      case "--as": options.as = value; break;
      case "--profession": options.profession = value; break;
      case "--flow": options.flow = value; break;
      case "--loop": options.loop = finiteInteger(arg, value); break;
      case "--family": options.family = value; break;
      case "--n":
      case "--units": options.units = finiteInteger(arg, value); break;
      case "--waypoints": options.waypoints = value; options.flowUsesLoop = true; break;
      case "--target": options.target = value; break;
      case "--action": options.actionId = value; break;
      case "--weapon": options.weapon = value; break;
      case "--weapon-item-id": options.weaponItemId = finiteInteger(arg, value); break;
      case "--filter": options.filter = value; break;
      case "--item-id": options.itemId = finiteInteger(arg, value); break;
      case "--variant-id": options.variantId = finiteInteger(arg, value); break;
      case "--quantity": options.quantity = finiteInteger(arg, value); break;
      case "--out": options.out = value; break;
      case "--slice": options.slicePath = value; break;
      case "--cli": options.cliPath = value; break;
      case "--spawn-area": options.spawnArea = value; break;
      case "--spawn-x": options.spawnX = Number(value); if (!Number.isFinite(options.spawnX)) throw new Error(`${arg} must be a number; got ${value}`); break;
      case "--spawn-y": options.spawnY = Number(value); if (!Number.isFinite(options.spawnY)) throw new Error(`${arg} must be a number; got ${value}`); break;
      case "--facing": options.facing = parseFacing(value); break;
      case "--timeout-ms": options.timeoutMs = finiteInteger(arg, value); break;
      case "--ready-timeout-ms": options.readyTimeoutMs = finiteInteger(arg, value); break;
      case "--text-body": options.text = value; break;
      default: throw new Error(`unknown play:flow option ${arg}`);
    }
  }
  return options;
}

function finiteInteger(name, raw) {
  const value = Number(raw);
  if (!Number.isInteger(value)) throw new Error(`${name} must be an integer; got ${raw}`);
  return value;
}

function parseFacing(raw) {
  if (raw === "front" || raw === "right" || raw === "back" || raw === "left") return raw;
  throw new Error(`--facing must be front/right/back/left; got ${raw}`);
}

function countBy(values) {
  const counts = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return counts;
}

function round(value) {
  return Math.round(value * 1000) / 1000;
}

function helpText() {
  return `play:flow — terminal game-flow runner\n\nUsage:\n  pnpm play:flow -- --port 28xxx --as ActionJohnson --profession scout --flow <name> [--loop N] [--json]\n\nFlows:\n${Object.entries(flowRegistry).map(([name, flow]) => `  ${name.padEnd(14)} ${flow.description}`).join("\n")}\n\nCommon options:\n  --port N                 scratch server port\n  --game-url URL           explicit game URL\n  --as NAME_OR_ID          character-store name/id to enter\n  --profession ID          required starter allocation when --as creates a character\n  --flow NAME              flow registry key\n  --loop N                 repeat whole flow N times (patrol treats it as route loops)\n  --json                   emit structured step JSON and final report\n  --out PATH               write final JSON report (or JSONL if PATH ends .jsonl)\n  --spawn-x/--spawn-y N    optional driver spawn override after /enter\n  --family iron            resource family for harvest/errand\n  --units N                harvest target units (default 10)\n  --item-id/--variant-id N loot-sweep stack selector\n  --waypoints 'x,y;x,y'    patrol waypoints\n`;
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], "file:").href) {
  main().then((code) => {
    process.exitCode = code;
  });
}
