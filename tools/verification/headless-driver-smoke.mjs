#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";

import { startSuccessorDriverBot } from "../driver-protocol/successor-driver-bot.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..", "..");
const port = process.env.OPEN_DESERT_PORT ?? "28092";
const gameUrl = process.env.SUCCESSOR_GAME_URL ?? `http://127.0.0.1:${port}`;
const actorId = process.env.SUCCESSOR_ACTOR_ID ?? `headless-driver-${Date.now().toString(36)}`;
const slicePath = path.join(repoRoot, "client", "public", "successor-slice", "open-desert-slice.json");
const spawn = currentCreatureSpawn(slicePath);
const startedAt = performance.now();
const bot = startSuccessorDriverBot({
  gameUrl,
  actorId,
  displayName: "Headless Driver",
  slicePath,
  spawnArea: "open-desert-overworld",
  spawnX: spawn.x,
  spawnY: spawn.y,
  facing: "right",
});

try {
  const ready = await bot.waitFor((envelope) => envelope.type === "status" && envelope.status === "ready", "driver ready", 12_000);

  bot.send({ op: "query", verb: "/where" });
  const where = await bot.waitFor((envelope) => envelope.type === "query" && envelope.verb === "where", "/where query");

  bot.send({ op: "verb", line: "/target nearest hostile" });
  const targetEvent = await bot.waitFor((envelope) => envelope.type === "event" && envelope.event === "verb" && envelope.line === "/target nearest hostile", "/target nearest hostile event");
  let targetId = targetIdFromEvent(targetEvent);
  let nearbyAll = null;
  if (!targetId) {
    bot.send({ op: "query", verb: "/nearby all" });
    nearbyAll = await bot.waitFor((envelope) => envelope.type === "query" && envelope.verb === "nearby", "/nearby all query");
    targetId = firstNearbyHostileId(nearbyAll);
    if (!targetId) throw new Error("current open-desert fixture exposed no nearby hostile at the Gaia creature spawn");
  }

  const attackLine = `/attack basic_shot ${targetId}`;
  bot.send({ op: "verb", line: attackLine });
  const attackQueued = await bot.waitFor((envelope) => envelope.type === "event" && envelope.event === "authority_queued" && envelope.line === attackLine, "attack queued");
  const attackCommandId = commandIdFromQueuedEvent(attackQueued);
  const attackReceipt = await bot.waitFor(
    (envelope) => envelope.type === "receipt" && envelope.commandId === attackCommandId,
    "attack receipt",
    8_000,
  );

  bot.send({ op: "query", verb: "/queue" });
  const queue = await bot.waitFor((envelope) => envelope.type === "query" && envelope.verb === "queue", "/queue query");

  for (let index = 0; index < 180; index += 1) {
    bot.send({ op: "verb", line: "/survey metal" });
  }
  const budgetReject = await bot.waitFor(
    (envelope) => envelope.type === "receipt" && envelope.accepted === false && envelope.reasonCode === "ingress_budget_exhausted",
    "ingress budget rejection",
    12_000,
  );

  await bot.close();
  console.log(JSON.stringify({
    schema: "successor.headless-driver-smoke.v1",
    status: "pass",
    durationMs: Math.round((performance.now() - startedAt) * 1000) / 1000,
    gameUrl,
    actorId,
    ready,
    transcript: [
      { send: { op: "query", verb: "/where" }, recv: where },
      { send: { op: "verb", line: "/target nearest hostile" }, recv: targetEvent },
      ...(nearbyAll ? [{ send: { op: "query", verb: "/nearby all" }, recv: nearbyAll }] : []),
      { send: { op: "verb", line: attackLine }, recv: attackQueued },
      { recv: attackReceipt },
      { send: { op: "query", verb: "/queue" }, recv: queue },
      { send: { op: "verb", line: "/survey metal", count: 180 }, recv: budgetReject },
    ],
    receiptCounts: {
      total: bot.envelopes.filter((envelope) => envelope.type === "receipt").length,
      rejected: bot.envelopes.filter((envelope) => envelope.type === "receipt" && envelope.accepted === false).length,
      ingressBudgetExhausted: bot.envelopes.filter((envelope) => envelope.type === "receipt" && envelope.reasonCode === "ingress_budget_exhausted").length,
    },
  }, null, 2));
} catch (error) {
  await bot.close().catch(() => undefined);
  console.error(error instanceof Error ? error.stack : String(error));
  console.error(JSON.stringify({ recentEnvelopes: bot.envelopes.slice(-12), stderr: bot.stderr }, null, 2));
  process.exitCode = 1;
}

function targetIdFromEvent(envelope) {
  return envelope?.data?.result?.data?.target?.id ?? null;
}

function firstNearbyHostileId(envelope) {
  const actor = envelope?.data?.actors?.find((candidate) => candidate?.relation === "hostile" && candidate?.lifeState !== "downed" && candidate?.lifeState !== "dead");
  return typeof actor?.id === "string" ? actor.id : null;
}

function currentCreatureSpawn(filePath) {
  const slice = JSON.parse(fs.readFileSync(filePath, "utf8"));
  const zone = (slice.spawnZones ?? []).find((entry) => entry.templateId === "open-desert-bellback" && entry.areaId === "open-desert-overworld");
  const cell = zone?.candidateCells?.[0] ?? { x: 193, y: 97 };
  return { x: Math.max(1, cell.x - 3), y: cell.y };
}

function commandIdFromQueuedEvent(envelope) {
  const commandId = envelope?.data?.commandId;
  if (typeof commandId !== "number") throw new Error(`queued event missing commandId: ${JSON.stringify(envelope)}`);
  return commandId;
}
