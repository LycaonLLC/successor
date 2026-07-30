#!/usr/bin/env node
// SimPlayer population runner — spins N synthetic players against one claimed
// scratch shard for a long-horizon soak that looks, to the shard's own
// counters/receipts, like regular gameplay. Staggered arcs, human pacing,
// concurrent solo activity loops, and a choreography director that guarantees
// the multiplayer beats (group / trade / duel) + the crafter and camp arcs.
//
//   pnpm sim:players -- --minutes 20 --population 4 [--port 28188] [--seed N]
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

import { repoRootFrom, writeSoakSlice, writeCharacterStore, spawnShard, enterCharacter, restockLoadout, debugGive, fetchJson, portIsFree, delay } from "./world.mjs";
import { SimPlayer } from "./sim-player.mjs";
import { pickActivity } from "./personality.mjs";
import { finalizeKpi, defaultThresholds, syncAuthoritative, evaluateInvariants } from "./kpi.mjs";
import * as B from "./behaviors.mjs";
import { createLocalSourceIdentity } from "../farm/source-hash.mjs";

const repoRoot = repoRootFrom(import.meta.dirname);
const forbiddenPorts = new Set([28093, 18192, 5179]);

// Item ids (from the manifest / trade aliases).
const ITEM = {
  STIMPAK: 1001,
  IRON: 2001,
  COPPER: 2007,
  FUEL: 2009,
  FUEL_VARIANT: 47_222_777,
  CAMP_KIT: 3007,
};

// The acceptance roster: 2 hunters + 1 crafter-farmer + 1 trader-socialite. A
// larger --population fills with extra hunters; smaller trims from the tail.
function buildRoster(population) {
  const cluster = { areaId: "open-desert-overworld", facing: "right" }; // (~632,540) overlaps rogue-zones 051+045 within the 60-cell leash
  const roster = [
    { key: "hunter", id: "sim-vale", name: "Vale", archetype: "hunter", initialProfessionId: "marksman", x: 630, y: 540, ...cluster, skillBoxIds: ["marksman-novice", "marksman-rifle-i"] },
    { key: "hunter", id: "sim-crane", name: "Crane", archetype: "hunter", initialProfessionId: "scout", x: 633, y: 538, ...cluster, skillBoxIds: ["scout-novice", "marksman-rifle-i"] },
    { key: "crafter", id: "sim-mora", name: "Mora", archetype: "crafter-farmer", initialProfessionId: "craftsman", x: 513, y: 514, areaId: "open-desert-overworld", facing: "right", skillBoxIds: ["craftsman-novice"] },
    { key: "trader", id: "sim-pip", name: "Pip", archetype: "trader-socialite", initialProfessionId: "scout", x: 636, y: 541, areaId: "open-desert-overworld", facing: "left", skillBoxIds: ["scout-novice"] },
  ];
  const extras = [];
  const extraNames = ["Kessa", "Dorn", "Wren", "Bex", "Sable", "Rue", "Jax", "Nova", "Fenn", "Odd", "Tamsin", "Corin"];
  for (let i = roster.length; i < population; i += 1) {
    extras.push({ key: "hunter", id: `sim-hunter-${i}`, name: extraNames[(i - roster.length) % extraNames.length], archetype: "hunter", initialProfessionId: "marksman", x: 628 + (i % 5), y: 538 - (i % 3), areaId: "open-desert-overworld", facing: "right", skillBoxIds: ["marksman-novice", "marksman-rifle-i"] });
  }
  return [...roster, ...extras].slice(0, Math.max(1, population));
}

// A dense respawning ground for the supply-bounded macro-uptime probe
// (LootTables AFK anchor): maxAlive 12, fast respawn, centred on the cluster.
function buildFarmZone(cx = 632, cy = 540) {
  const cells = [];
  for (let dx = -3; dx <= 2; dx += 1) for (let dy = -2; dy <= 1; dy += 1) cells.push({ x: cx + dx, y: cy + dy });
  return {
    id: "simplayer-farm-zone", actorIdPrefix: "simplayer-farm", templateId: "open-desert-rogue-trooper",
    areaId: "open-desert-overworld", candidateCells: cells,
    initialCount: 12, maxAlive: 12, spawnEverySeconds: 20, batchMin: 3, batchMax: 5, seed: 917531,
    activation: { radiusCells: 70, leashRadiusCells: 70, deactivationRadiusCells: 110, releaseTicks: 60, lingerTicks: 120, checkEveryTicks: 10 },
  };
}

// A couple of loot-bearing rogue stragglers in the hunting cluster guarantee
// at least one real /loot pickup (spawn-zone template rogues carry no drops;
// loot-table drops are the LootTables lane's job). Mirrors open-desert-combat-active.
function buildLootHostiles() {
  const spec = [
    { id: "sim-loot-straggler-a", label: "Rogue Straggler", x: 628, y: 540 },
    { id: "sim-loot-straggler-b", label: "Rogue Straggler", x: 635, y: 538 },
  ];
  const actors = spec.map((r) => ({ id: r.id, entity: `simplayer:${r.id}`, areaId: "open-desert-overworld", label: r.label, role: "skirmisher", factionId: "rogue_troopers", socialGroup: "open_desert_rogues", pvpStatus: "overt", professionIds: ["marksman"], skillBoxIds: ["marksman-novice"], sprite: "adventurer-premium-male", poseSet: "idle", direction: "left", cell: { x: r.x, y: r.y }, route: [], vitals: { health: 90, action: 100, spirit: 80 }, maxVitals: { health: 90, action: 100, spirit: 80 } }));
  const inventory = spec.map((r) => ({ container: `${r.id}:field-pack`, item: "Stimpak A", itemId: 1001, variantId: 0, quantity: 3, reserved: 0, available: 3 }));
  return { actors, inventory };
}

async function main(argv) {
  const opts = parseArgs(argv);
  const localStartIdentity = await captureStableLocalSourceIdentity();
  const runId = `soak-${new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 14)}-p${opts.population}-m${opts.minutes}`;
  const outDir = path.resolve(repoRoot, opts.out ?? path.join("verification", "ledgers", "artifacts", "simplayer", runId));
  await fs.mkdir(outDir, { recursive: true });
  const runDir = path.join(outDir, "shard");
  const thresholds = defaultThresholds();
  const farm = opts.profile === "farm";
  const starter3 = opts.workload === "starter3";
  if (starter3 && opts.population !== 3) throw new Error("starter3 workload requires --population 3");
  const bodies = farm ? buildRoster(2).filter((b) => b.key === "hunter") : buildRoster(opts.population);
  const mergedLog = [];
  const gaps = [];
  const verbose = process.env.SUCCESSOR_SIMPLAYER_QUIET !== "1";
  const onBeat = (sim, beat) => {
    mergedLog.push(beat);
    if (verbose) process.stderr.write(`${new Date(beat.ms).toISOString().slice(14, 19)} ${String(beat.actor).padEnd(6)} ${String(beat.kind).padEnd(9)} ${beat.text}\n`);
  };

  if (forbiddenPorts.has(opts.port)) throw new Error(`port ${opts.port} is reserved by a supported client or standing authority; choose an isolated scratch port`);
  if (!(await portIsFree(opts.port))) throw new Error(`port ${opts.port} is busy; claim a free port with --port`);

  console.log(`[soak] ${runId} — ${bodies.length} SimPlayers, ${opts.minutes} min, port ${opts.port}, seed ${opts.seed}`);
  const lootHostiles = buildLootHostiles();
  const { slicePath } = await writeSoakSlice({ baseSlicePath: path.join(repoRoot, "client/public/successor-slice/open-desert-slice.json"), outDir: runDir, tag: runId.slice(-14), extraActors: lootHostiles.actors, extraInventory: lootHostiles.inventory, extraSpawnZones: farm ? [buildFarmZone()] : [] });
  const { storePath } = await writeCharacterStore({ bodies, outDir: runDir });
  const shard = await spawnShard({ repoRoot, port: opts.port, slicePath, characterStorePath: storePath, shardId: `simplayer-${runId}`, tag: runId.slice(-8) });
  console.log(`[soak] shard ${shard.unitService} rustLive=${shard.status.authority?.rustLive} actors=${shard.status.actorCount}`);

  const started = performance.now();
  const startedAtMs = Date.now();
  const endMs = startedAtMs + Math.min(opts.minutes * 60_000, opts.maxDurationMs);
  const sims = [];
  let fatal = null;
  let syncTimer = null;
  let telemetryTimer = null;
  let phase = "boot";
  const telemetry = createTelemetry({ runId, opts, shard, startedAtMs, gaps });
  await sampleTelemetry(telemetry, shard, phase, shard.status).catch(() => {});
  telemetryTimer = setInterval(() => { void sampleTelemetry(telemetry, shard, phase).catch(() => {}); }, opts.sampleIntervalMs);
  telemetryTimer.unref();
  try {
    // Staggered logins — the population trickles in like real players.
    const stagger = Math.min(9_000, Math.max(2_000, Math.trunc((opts.minutes * 60_000) / (bodies.length * 12))));
    for (let i = 0; i < bodies.length; i += 1) {
      const body = bodies[i];
      const sim = new SimPlayer({ baseSeed: opts.seed, body, archetype: body.archetype, repoRoot, gameUrl: shard.gameUrl, slicePath, onBeat, farm });
      sim.deadlineMs = endMs;
      sims.push(sim);
    }
    const byKey = (k) => sims.filter((s) => s.body.key === k);
    const hunters = byKey("hunter");
    const crafter = byKey("crafter")[0] ?? null;
    const trader = byKey("trader")[0] ?? null;

    // Boot staggered.
    for (let i = 0; i < sims.length; i += 1) {
      const sim = sims[i];
      const join = await enterCharacter(shard.gameUrl, sim.actorId);
      await sim.boot(join);
      await provision(shard.gameUrl, sim, farm);
      await sim.say("local", sim.rng.pick(B.CHAT[sim.archetype === "trader-socialite" ? "trade" : sim.archetype === "crafter-farmer" ? "survey" : "greetHunt"]));
      if (i < sims.length - 1) await delay(stagger);
    }
    phase = "running";

    // Periodic authoritative KPI sync from the oracle (truth source).
    syncTimer = setInterval(() => { void syncAll(shard.gameUrl, sims).catch(() => {}); }, 15_000);
    syncTimer.unref();

    // Concurrent solo arcs + the choreography director.
    const soloArcs = sims.map((sim) => farm ? farmLoop(sim, endMs) : soloLoop(sim, endMs));
    const direction = farm ? Promise.resolve() : director({ sims, hunters, crafter, trader, startedAtMs, endMs, workload: opts.workload, gaps });
    await Promise.all([...soloArcs, direction]);

    await syncAll(shard.gameUrl, sims);

    phase = "logout";
    // Staggered logout.
    for (const sim of sims) {
      await sim.enqueue(async () => { await sim.say("local", sim.rng.pick(B.CHAT.farewell)); sim.beat("logout", `${sim.name} logs off.`); });
      await sim.close("logout");
      await delay(400);
    }
  } catch (error) {
    fatal = error instanceof Error ? error.stack ?? error.message : String(error);
    console.error(`[soak] FATAL: ${fatal}`);
  } finally {
    if (syncTimer) clearInterval(syncTimer);
    if (telemetryTimer) clearInterval(telemetryTimer);
    for (const sim of sims) await sim.close("shutdown").catch(() => {});
  }

  // Final authoritative sync and KPI finalization happen before artifacts/judge.
  await syncAll(shard.gameUrl, sims).catch(() => {});
  for (const sim of sims) finalizeKpi(sim.kpi, thresholds);
  const finalStatus = await fetchJson(`${shard.gameUrl}/game/status`).catch(() => null);
  const finalOracle = await fetchJson(`${shard.gameUrl}/game/debug/oracle`).catch(() => null);
  await sampleTelemetry(telemetry, shard, "final", finalStatus).catch(() => {});
  telemetry.errorLogLines = await shard.errorLogLines(new Date(startedAtMs).toISOString());
  telemetry.summary = summarizeTelemetry(telemetry);
  const teardown = await shard.stop();
  const localFinalIdentity = await captureStableLocalSourceIdentity();
  const sourceBinding = evaluateSourceBinding(localStartIdentity, localFinalIdentity);
  if (!sourceBinding.stable) fatal ??= "source_changed";

  telemetry.sourceBinding = sourceBinding;
  telemetry.summary = { ...telemetry.summary, sourceBinding };
  await writeArtifacts({ outDir, runId, opts, bodies, sims, mergedLog, finalStatus, finalOracle, teardown, fatal, durationMs: round(performance.now() - started), telemetry, gaps, sourceBinding });
  const verdict = judge({ sims, fatal, teardown, profile: opts.profile, workload: opts.workload, sourceBinding });
  console.log(`\n[soak] ${verdict.green ? "GREEN" : "RED"} — ${verdict.summary}`);
  console.log(`[soak] artifacts: ${path.relative(repoRoot, outDir)}`);
  for (const line of verdict.lines) console.log(`  ${line}`);
  return verdict.green ? 0 : 1;
}

// Out-of-band provisioning (a test loadout / starting stock) — NOT part of the
// human-plausible transcript; runs in a labelled "provision" phase per sim.
async function provision(gameUrl, sim, farm = false) {
  await restockLoadout(gameUrl, sim.actorId).catch(() => {});
  if (farm) { sim.beat("provision", `${sim.name} kits out for a farming run.`, { phase: "provision" }); return; }
  if (sim.body.key === "hunter") {
    await debugGive(gameUrl, sim.actorId, { itemId: ITEM.CAMP_KIT, quantity: 1 });
    await debugGive(gameUrl, sim.actorId, { itemId: ITEM.IRON, quantity: 6 }); // goods to sell to the trader
  } else if (sim.body.key === "trader") {
    await debugGive(gameUrl, sim.actorId, { itemId: ITEM.CAMP_KIT, quantity: 1 });
  } else if (sim.body.key === "crafter") {
    await debugGive(gameUrl, sim.actorId, { itemId: ITEM.CAMP_KIT, quantity: 1 });
    await debugGive(gameUrl, sim.actorId, { itemId: ITEM.COPPER, quantity: 120 }); // reagent stock so the survey->sample(iron)->craft cycle completes
    await debugGive(gameUrl, sim.actorId, { itemId: ITEM.FUEL, variantId: ITEM.FUEL_VARIANT, quantity: 12 });
  }
  sim.beat("provision", `${sim.name} kits out (loadout restocked).`, { phase: "provision" });
}

async function syncAll(gameUrl, sims) {
  const oracle = await fetchJson(`${gameUrl}/game/debug/oracle`);
  for (const sim of sims) {
    const actor = oracle.actors?.[sim.actorId] ?? null;
    syncAuthoritative(sim.kpi, actor, Number(actor?.credits ?? 0));
    evaluateInvariants(sim.kpi, defaultThresholds());
  }
}

// One weighted, human-paced activity + an idle gap. Each iteration is a queued
// task so the director can claim the sim between activities.
async function soloLoop(sim, endMs) {
  while (Date.now() < endMs && sim.alive) {
    await sim.enqueue(async () => {
      const name = pickActivity(sim.rng, sim.personality.menu);
      await runActivity(sim, name);
    }).catch((e) => sim.beat("warn", `${sim.name} activity error: ${e.message}`));
    await sim.pace("idle");
  }
}

// Pure supply-bounded hunting: back-to-back kill/loot with minimal pacing, no
// social/craft/idle downtime — measures the ceiling a parked macro sees.
async function farmLoop(sim, endMs) {
  while (Date.now() < endMs && sim.alive) {
    await sim.enqueue(() => B.patrolAndHunt(sim, { maxKills: 4 })).catch((e) => sim.beat("warn", `${sim.name} farm error: ${e.message}`));
  }
}

async function runActivity(sim, name) {
  switch (name) {
    case "patrolAndHunt": return B.patrolAndHunt(sim, { maxKills: 1 });
    case "surveyMineCraft": return B.surveyMineCraft(sim, { family: "iron" });
    case "trainerVisit": return B.trainerVisit(sim, { box: sim.body.key === "crafter" ? "craftsman-novice" : "marksman-rifle-i" });
    case "campRest": return B.campRest(sim);
    case "tradeErrand": return B.traderRounds(sim);
    case "sellRun": return B.traderRounds(sim);
    case "chatSmalltalk": return B.chatSmalltalk(sim, { context: sim.rng.pick(["social", sim.body.key === "hunter" ? "hunting" : sim.body.key === "trader" ? "trade" : "survey"]) });
    default: return B.idle(sim);
  }
}

// Choreography director: guarantees the crafter arc + the multiplayer beats at
// soak-fraction milestones, claiming participants between their solo activities.
async function director({ sims, hunters, crafter, trader, startedAtMs, endMs, workload = "population", gaps = [] }) {
  const span = endMs - startedAtMs;
  const at = (frac) => startedAtMs + Math.trunc(span * frac);
  const H0 = hunters[0] ?? null;
  const H1 = hunters[1] ?? null;
  const camper = sims.find((sim) => sim.body.initialProfessionId === "scout") ?? crafter;

  // Guaranteed crafter path early (train tool -> survey/sample/craft).
  if (crafter) await scheduleBeat(at(0.04), endMs, () => { void crafter.enqueue(async () => {
    await B.trainerVisit(crafter, { box: "craftsman-novice" });
    await B.surveyMineCraft(crafter, { family: "iron" });
  }); });

  // Guaranteed opening hunt for each hunter.
  for (const h of hunters.slice(0, 2)) {
    await scheduleBeat(at(0.06), endMs, () => { void h.enqueue(() => B.patrolAndHunt(h, { maxKills: 1 })); });
  }

  // Group up (H0 leader invites H1).
  if (H0 && H1) await scheduleBeat(at(0.20), endMs, () => choreograph([H0, H1], () => B.formGroup(H0, H1)));

  // Trade: trader buys iron from a hunter with scalar wallet credits.
  if (trader && H0) await scheduleBeat(at(0.42), endMs, () => choreograph([trader, H0], () => B.tradeBetween(trader, H0, { offerSpec: "-", requestSpec: "iron:3", offerCredits: 5, requestItemId: ITEM.IRON })));

  if (workload === "starter3" && !trader) {
    gaps.push({ chain: "SimPlayer<->SimPlayer trade", status: "unsupported", reason: "starter3 roster has no trader; no substitute behavior was attempted" });
  }
  // Guaranteed camp: the novice scout pitches + rests.
  if (camper) await scheduleBeat(at(0.55), endMs, () => { void camper.enqueue(() => B.campRest(camper)); });

  // Duel: they leave the party then settle it 1v1, honourable yield.
  if (H0 && H1) await scheduleBeat(at(0.70), endMs, () => choreograph([H0, H1], async () => {
    await H1.authority("/group-leave", { primitive: "groupLeave", commandKind: "GroupLeave", requireAccepted: false, receiptTimeoutMs: 8_000 }).catch(() => {});
    await B.duelBetween(H0, H1);
  }));
}

async function scheduleBeat(atMs, endMs, fn) {
  const wait = Math.min(atMs, endMs - 5_000) - Date.now();
  if (wait > 0) await delay(wait);
  if (Date.now() >= endMs) return;
  try { await fn(); } catch (e) { console.error(`[director] beat error: ${e.message}`); }
}

// Park each participant's serial queue, run the interaction once holding all of
// them, then release — race-free rendezvous across concurrent solo loops.
async function choreograph(participants, fn) {
  const release = Promise.withResolvers();
  const arrivals = participants.map((sim) => {
    const arrived = Promise.withResolvers();
    sim.enqueue(async () => { arrived.resolve(); await release.promise; });
    return arrived.promise;
  });
  await Promise.all(arrivals);
  try { return await fn(); } finally { release.resolve(); }
}

export async function captureStableLocalSourceIdentity({ root = repoRoot, capture = createLocalSourceIdentity } = {}) {
  const first = await capture({ root, includeManifest: false });
  const second = await capture({ root, includeManifest: false });
  if (first.sourceHash !== second.sourceHash) throw new Error(`source changed during identity capture: ${first.sourceHash} -> ${second.sourceHash}`);
  return second;
}

export function evaluateSourceBinding(startIdentity, finalIdentity) {
  const localStartHash = startIdentity?.sourceHash ?? null;
  const localFinalHash = finalIdentity?.sourceHash ?? null;
  return { localStartHash, localFinalHash, stable: localStartHash !== null && localStartHash === localFinalHash };
}
async function writeArtifacts({ outDir, runId, opts, bodies, sims, mergedLog, finalStatus, finalOracle, teardown, fatal, durationMs, telemetry, gaps = [], sourceBinding = null }) {
  // Per-player + merged human-readable transcripts.
  for (const sim of sims) {
    const lines = sim.transcript.map(fmtBeat);
    await fs.writeFile(path.join(outDir, `player-${sim.actorId}.transcript.txt`), `# ${sim.name} (${sim.personality.label}) — ${sim.actorId}\n# traits: ${JSON.stringify(sim.personality.traits)}\n\n${lines.join("\n")}\n`, "utf8");
  }
  mergedLog.sort((a, b) => a.ms - b.ms);
  await fs.writeFile(path.join(outDir, "soak-transcript.txt"), `# SimPlayer soak ${runId}\n# reads like a live session log (elapsed | actor | beat)\n\n${mergedLog.map(fmtBeat).join("\n")}\n`, "utf8");

  const kpi = {
    schema: "successor.simplayer-kpi.v2",
    runId, seed: opts.seed, minutes: opts.minutes, population: bodies.length,
    players: sims.map((s) => s.kpi),
    population_totals: aggregate(sims),
    population_receipts: aggregateReceipts(sims),
    rejection_table: rejectionTable(sims),
    loottables_telemetry: lootTablesTelemetry(sims, opts),
    shard_counters: finalStatus?.counters ?? null,
    shard_recent_rejections: finalStatus?.recentRejections ?? [],
    sourceBinding,
  };
  await fs.writeFile(path.join(outDir, "kpi.json"), `${JSON.stringify(kpi, null, 2)}\n`, "utf8");

  // Invariant report.
  const invariants = {
    schema: "successor.simplayer-invariants.v1",
    runId, thresholds: defaultThresholds(),
    players: sims.map((s) => ({ actorId: s.actorId, name: s.name, breaches: s.kpi.breaches, evidence: s.kpi.invariants })),
    breachCount: sims.reduce((n, s) => n + s.kpi.breaches.length, 0),
    clean: sims.every((s) => s.kpi.breaches.length === 0) && !fatal && teardown.ok,
  };
  await fs.writeFile(path.join(outDir, "invariants.json"), `${JSON.stringify(invariants, null, 2)}\n`, "utf8");
  if (telemetry) {
    await safeWrite(path.join(outDir, "telemetry.json"), `${JSON.stringify(telemetry, null, 2)}\n`);
    await safeWrite(path.join(outDir, "telemetry.jsonl"), `${telemetry.samples.map((sample) => JSON.stringify(sample)).join("\n")}${telemetry.samples.length ? "\n" : ""}`);
    const { samples: _samples, ...compactTelemetry } = telemetry;
    await safeWrite(path.join(outDir, "telemetry-summary.json"), `${JSON.stringify(compactTelemetry, null, 2)}\n`);
  }

  const run = {
    schema: "successor.simplayer-run.v1",
    runId, opts, durationMs, fatal, gaps,
    shard: { unit: teardown.unit, teardownOk: teardown.ok, finalState: teardown.finalState ?? null },
    finalStatus: finalStatus ? { tick: finalStatus.tick, sessionCount: finalStatus.sessionCount, actorCount: finalStatus.actorCount, counters: finalStatus.counters, recentRejections: finalStatus.recentRejections, sourceStateHash: finalStatus.source?.stateHash, bridgeChildSignalCode: finalStatus.authority?.bridge?.childSignalCode ?? null } : null,
    oracleActorCount: finalOracle ? Object.keys(finalOracle.actors ?? {}).length : null,
    verdict: judge({ sims, fatal, teardown, profile: opts.profile, workload: opts.workload, sourceBinding }),
    sourceBinding,
  };
  await fs.writeFile(path.join(outDir, "run.json"), `${JSON.stringify(run, null, 2)}\n`, "utf8");
  return run;
}

async function safeWrite(target, content) {
  try {
    await fs.writeFile(target, content, "utf8");
    return true;
  } catch (error) {
    if (error?.code === "ENOSPC" || error?.code === "EDQUOT") return false;
    throw error;
  }
}

function fmtBeat(b) {
  const t = new Date(b.ms).toISOString().slice(14, 19); // mm:ss elapsed
  return `${t} | ${String(b.actor).padEnd(11)} | ${String(b.kind).padEnd(9)} | ${b.text}`;
}

function aggregate(sims) {
  const totals = { kills: 0, npcKills: 0, deaths: 0, samples: 0, crafts: 0, trades: 0, camps: 0, loots: 0, trainings: 0, duelChallenges: 0, duelAccepts: 0, duelYields: 0, groupInvites: 0, groupAccepts: 0, chatLines: 0, creditsDelta: 0, receiptsAccepted: 0, receiptsRejected: 0 };
  for (const s of sims) {
    const k = s.kpi;
    totals.kills += k.authoritative.kills; totals.npcKills += k.authoritative.npcKills; totals.deaths += k.authoritative.deaths;
    for (const key of ["samples", "crafts", "trades", "camps", "loots", "trainings", "duelChallenges", "duelAccepts", "duelYields", "groupInvites", "groupAccepts", "chatLines"]) totals[key] += k.counters[key];
    totals.creditsDelta += (k.derived?.creditsDelta ?? 0);
    totals.receiptsAccepted += k.receipts.accepted; totals.receiptsRejected += k.receipts.rejected;
  }
  return totals;
}

function aggregateReceipts(sims) {
  const out = { total: 0, accepted: 0, rejected: 0, byKind: {}, rejectedByReason: {}, rejectedByKindReason: {} };
  for (const s of sims) {
    const r = s.kpi.receipts;
    out.total += r.total; out.accepted += r.accepted; out.rejected += r.rejected;
    for (const [kind, counts] of Object.entries(r.byKind ?? {})) {
      out.byKind[kind] = out.byKind[kind] ?? { accepted: 0, rejected: 0 };
      out.byKind[kind].accepted += counts.accepted ?? 0;
      out.byKind[kind].rejected += counts.rejected ?? 0;
    }
    for (const [reason, count] of Object.entries(r.rejectedByReason ?? {})) {
      out.rejectedByReason[reason] = (out.rejectedByReason[reason] ?? 0) + count;
    }
    for (const [key, count] of Object.entries(r.rejectedByKindReason ?? {})) {
      out.rejectedByKindReason[key] = (out.rejectedByKindReason[key] ?? 0) + count;
    }
  }
  out.byKind = Object.fromEntries(Object.entries(out.byKind).sort(([a], [b]) => a.localeCompare(b)));
  return out;
}

function rejectionTable(sims) {
  return Object.entries(aggregateReceipts(sims).rejectedByKindReason)
    .map(([key, count]) => {
      const [kind, ...reasonParts] = key.split("|");
      return { kind, reason: reasonParts.join("|") || "unknown", count };
    })
    .sort((a, b) => b.count - a.count || a.kind.localeCompare(b.kind) || a.reason.localeCompare(b.reason));
}

function createTelemetry({ runId, opts, shard, startedAtMs, gaps = [] }) {
  return {
    schema: "successor.simplayer-telemetry.v2",
    runId,
    profile: opts.profile,
    workload: opts.workload,
    port: opts.port,
    unitService: shard.unitService,
    startedAt: new Date(startedAtMs).toISOString(),
    expectedTickRateHz: 30,
    sampleIntervalMs: opts.sampleIntervalMs,
    retentionCap: opts.retentionCap,
    maxDurationMs: opts.maxDurationMs,
    host: hostIdentity(),
    samples: [],
    collectedSampleCount: 0,
    droppedSampleCount: 0,
    gaps,
    errorLogLines: [],
    summary: null,
  };
}
async function sampleTelemetry(telemetry, shard, phase, statusOverride = null) {
  const status = statusOverride ?? await fetchJson(`${shard.gameUrl}/game/status`);
  const resources = await shard.resourceSnapshot();
  const proc = resources?.proc && !resources.proc.error ? resources.proc : null;
  const now = Date.now();
  const previous = telemetry.samples.at(-1);
  const cpuNs = resources?.cpuUsageNSec ?? null;
  const previousCpuNs = previous?.unit?.cpuUsageNSec ?? null;
  const elapsedSincePrevious = previous ? Math.max(0, now - Date.parse(previous.at)) : 0;
  const cpuPercent = Number.isFinite(cpuNs) && Number.isFinite(previousCpuNs) && elapsedSincePrevious > 0
    ? round(((cpuNs - previousCpuNs) / (elapsedSincePrevious * 1e6)) * 100)
    : null;
  const sample = {
    at: new Date(now).toISOString(),
    elapsedMs: now - Date.parse(telemetry.startedAt),
    phase,
    labels: { stage: phase, action: phase === "running" ? "concurrent_simplayer_activity" : phase },
    tick: status?.tick ?? null,
    sessionCount: status?.sessionCount ?? null,
    actorCount: status?.actorCount ?? null,
    sourceStateHash: status?.source?.stateHash ?? null,
    sourceSliceHash: status?.source?.sliceHash ?? null,
    counters: status?.counters ?? null,
    recentRejections: status?.recentRejections ?? [],
    instrumentation: status?.instrumentation ?? null,
    authority: {
      mode: status?.authority?.mode ?? null,
      rustLive: status?.authority?.rustLive ?? null,
      inProcessAuthorityForTests: status?.authority?.inProcessAuthorityForTests ?? null,
      bridgeChildSignalCode: status?.authority?.bridge?.childSignalCode ?? null,
      bridgeChildExitCode: status?.authority?.bridge?.childExitCode ?? null,
      bridgeClosed: status?.authority?.bridge?.closed ?? null,
      tickTiming: status?.authority?.tickTiming ?? null,
      liveRequestTimings: status?.authority?.bridge?.timings?.liveRequests ?? null,
    },
    memory: {
      unitBytes: resources?.memoryCurrentBytes ?? null,
      rssBytes: proc?.rssBytes ?? null,
      highWaterRssBytes: proc?.highWaterRssBytes ?? null,
      threads: proc?.threads ?? null,
      fileDescriptors: proc?.fileDescriptors ?? null,
    },
    unit: {
      activeState: resources?.activeState ?? null,
      subState: resources?.subState ?? null,
      mainPid: resources?.mainPid ?? null,
      cpuUsageNSec: cpuNs,
      cpuPercent,
      normalizedCpuPercent: cpuPercent === null ? null : round(cpuPercent / Math.max(1, telemetry.host.cpuCores)),
      processGroup: resources?.processGroup ?? null,
      error: resources?.error ?? null,
    },
  };
  telemetry.collectedSampleCount += 1;
  if (telemetry.samples.length >= telemetry.retentionCap) {
    telemetry.samples.shift();
    telemetry.droppedSampleCount += 1;
  }
  telemetry.samples.push(sample);
  return sample;
}

function summarizeTelemetry(telemetry) {
  const samples = telemetry.samples;
  const tickSamples = samples.filter((s) => typeof s.tick === "number");
  const first = tickSamples[0] ?? null;
  const last = tickSamples.at(-1) ?? null;
  const durationSec = first && last ? Math.max(0, (last.elapsedMs - first.elapsedMs) / 1000) : 0;
  const tickDelta = first && last ? last.tick - first.tick : null;
  const expectedTickDelta = tickDelta === null ? null : durationSec * telemetry.expectedTickRateHz;
  const memorySeries = samples.map((s) => s.memory?.unitBytes ?? s.memory?.rssBytes).filter((n) => typeof n === "number");
  const stateHashes = [...new Set(samples.map((s) => s.sourceStateHash).filter(Boolean))];
  const bridgeSignalCodes = [...new Set(samples.map((s) => s.authority?.bridgeChildSignalCode).filter(Boolean))];
  const bridgeExitCodes = [...new Set(samples.map((s) => s.authority?.bridgeChildExitCode).filter((v) => v !== null && v !== undefined))];
  const cpu = samples.map((s) => s.unit?.normalizedCpuPercent).filter(Number.isFinite);
  const rss = samples.map((s) => s.memory?.rssBytes).filter(Number.isFinite);
  const highWater = samples.map((s) => s.memory?.highWaterRssBytes).filter(Number.isFinite);
  const threads = samples.map((s) => s.memory?.threads).filter(Number.isFinite);
  const fds = samples.map((s) => s.memory?.fileDescriptors).filter(Number.isFinite);
  return {
    sampleCount: samples.length,
    collectedSampleCount: telemetry.collectedSampleCount,
    droppedSampleCount: telemetry.droppedSampleCount,
    retentionCap: telemetry.retentionCap,
    sampleIntervalMs: telemetry.sampleIntervalMs,
    firstTick: first?.tick ?? null,
    lastTick: last?.tick ?? null,
    tickDelta,
    observedTickRateHz: durationSec > 0 && tickDelta !== null ? round(tickDelta / durationSec) : null,
    expectedTickDelta: expectedTickDelta === null ? null : round(expectedTickDelta),
    tickDriftTicks: expectedTickDelta === null || tickDelta === null ? null : round(tickDelta - expectedTickDelta),
    sourceStateHashStable: stateHashes.length <= 1,
    sourceStateHashes: stateHashes,
    runningSessionDrops: runningSessionDrops(samples),
    memoryBytes: {
      start: memorySeries[0] ?? null,
      end: memorySeries.at(-1) ?? null,
      peak: memorySeries.length ? Math.max(...memorySeries) : null,
      drift: memorySeries.length >= 2 ? memorySeries.at(-1) - memorySeries[0] : null,
    },
    normalizedCpuPercent: distribution(cpu),
    rssBytes: distribution(rss),
    highWaterRssBytes: distribution(highWater),
    threads: distribution(threads),
    fileDescriptors: distribution(fds),
    rustLiveAllSamples: samples.every((s) => s.authority?.rustLive === true),
    inProcessAuthoritySeen: samples.some((s) => s.authority?.inProcessAuthorityForTests === true),
    bridgeChildSignalCodes: bridgeSignalCodes,
    bridgeChildExitCodes: bridgeExitCodes,
    lastTickTiming: last?.authority?.tickTiming ?? null,
    errorLevelLogLineCount: telemetry.errorLogLines.length,
  };
}

function distribution(values) {
  if (values.length === 0) return { p50: null, p95: null, p99: null, max: null };
  const sorted = [...values].sort((a, b) => a - b);
  const at = (fraction) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1))];
  return { p50: round(at(0.5)), p95: round(at(0.95)), p99: round(at(0.99)), max: round(sorted.at(-1)) };
}

function runningSessionDrops(samples) {
  let previous = null;
  let drops = 0;
  for (const sample of samples) {
    if (sample.phase !== "running" || typeof sample.sessionCount !== "number") continue;
    if (previous !== null && sample.sessionCount < previous) drops += previous - sample.sessionCount;
    previous = sample.sessionCount;
  }
  return drops;
}

// kills/hour telemetry for the LootTables AFK-calibration lane (per-hunter +
// pooled), plus the authoritative longArc profiles the shard already derives.
function lootTablesTelemetry(sims, opts) {
  const hunters = sims.filter((s) => s.body.key === "hunter");
  const pooledNpcKills = hunters.reduce((n, s) => n + s.kpi.authoritative.npcKills, 0);
  const hours = Math.max(1e-6, opts.minutes / 60);
  return {
    note: "kills/hour basis for month-scale AFK loot calibration; npcKills are authoritative (oracle actor stats).",
    soakMinutes: opts.minutes,
    perHunter: hunters.map((s) => ({ actorId: s.actorId, npcKills: s.kpi.authoritative.npcKills, killsPerHour: round(s.kpi.authoritative.npcKills / hours), shotsFired: s.kpi.authoritative.shotsFired, hitRate: s.kpi.authoritative.longArc?.combat?.hitRate ?? null })),
    pooledNpcKills, pooledKillsPerHour: round(pooledNpcKills / hours),
  };
}

function judge({ sims, fatal, teardown, profile = "population", workload = "population", sourceBinding = null }) {
  const totals = aggregate(sims);
  const receipts = aggregateReceipts(sims);
  const breaches = sims.reduce((n, s) => n + s.kpi.breaches.length, 0);
  const booted = sims.filter((s) => s.transcript.some((b) => b.kind === "login")).length;
  const checks = profile === "farm" ? [
    ["all sims booted", booted === sims.length && sims.length > 0],
    ["hunting rate observed", totals.npcKills >= 1],
    ["combat command accepted", (receipts.byKind.QueueCombatAction?.accepted ?? 0) >= 1],
    ["zero invariant breaches", breaches === 0],
    ["no fatal error", !fatal],
    ["shard torn down", teardown.ok],
  ] : workload === "starter3" ? [
    ["all sims booted", booted === sims.length && sims.length === 3],
    ["hunting + loot", totals.loots >= 1 && totals.npcKills >= 1],
    ["survey->sample->craft", totals.samples >= 1 && totals.crafts >= 1],
    ["duel challenge + accept", totals.duelChallenges >= 1 && totals.duelAccepts >= 1],
    ["camp pitch", totals.camps >= 1],
    ["chat lines", totals.chatLines >= 3],
    ["zero invariant breaches", breaches === 0],
    ["no fatal error", !fatal],
    ["shard torn down", teardown.ok],
  ] : [
    ["all sims booted", booted === sims.length && sims.length > 0],
    ["hunting + loot", totals.loots >= 1 && totals.npcKills >= 1],
    ["survey->sample->craft", totals.samples >= 1 && totals.crafts >= 1],
    ["SimPlayer<->SimPlayer trade", totals.trades >= 1],
    ["duel challenge + accept", totals.duelChallenges >= 1 && totals.duelAccepts >= 1],
    ["camp pitch", totals.camps >= 1],
    ["chat lines", totals.chatLines >= 4],
    ["zero invariant breaches", breaches === 0],
    ["no fatal error", !fatal],
    ["shard torn down", teardown.ok],
  ];
  const green = checks.every(([, ok]) => ok) && sourceBinding?.stable !== false;
  return {
    green,
    profile,
    workload,
    sourceBinding,
    summary: `${checks.filter(([, ok]) => ok).length}/${checks.length} checks; kills=${totals.npcKills} samples=${totals.samples} crafts=${totals.crafts} trades=${totals.trades} duels=${totals.duelChallenges}/${totals.duelAccepts} camps=${totals.camps} chat=${totals.chatLines} deaths=${totals.deaths} breaches=${breaches}${sourceBinding?.stable === false ? " source_changed" : ""}`,
    lines: [...checks.map(([label, ok]) => `${ok ? "PASS" : "FAIL"}  ${label}`), ...(sourceBinding?.stable === false ? ["FAIL  source_changed"] : [])],
    totals, breaches,
  };
}

function parseArgs(argv) {
  const o = { minutes: 20, population: 4, port: 28188, seed: 424242, out: null, profile: "population", workload: "population", sampleIntervalMs: 15_000, retentionCap: 2_000, maxDurationMs: 3_600_000 };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--") continue;
    const v = argv[i + 1];
    switch (a) {
      case "--minutes": o.minutes = num(a, v); i += 1; break;
      case "--population": o.population = num(a, v); i += 1; break;
      case "--port": o.port = num(a, v); i += 1; break;
      case "--seed": o.seed = num(a, v); i += 1; break;
      case "--out": o.out = v; i += 1; break;
      case "--profile": o.profile = v; i += 1; break;
      case "--workload": o.workload = v; i += 1; break;
      case "--sample-interval-ms": o.sampleIntervalMs = num(a, v); i += 1; break;
      case "--retention-cap": o.retentionCap = num(a, v); i += 1; break;
      case "--max-duration-ms": o.maxDurationMs = num(a, v); i += 1; break;
      default: throw new Error(`unknown sim:players option ${a}`);
    }
  }
  if (!Number.isInteger(o.population) || o.population < 1 || o.population > 16) throw new Error("population must be an integer between 1 and 16");
  if (!Number.isInteger(o.sampleIntervalMs) || o.sampleIntervalMs < 100 || o.sampleIntervalMs > 60_000) throw new Error("sample interval must be between 100 and 60000ms");
  if (!Number.isInteger(o.retentionCap) || o.retentionCap < 1 || o.retentionCap > 1_000_000) throw new Error("retention cap must be between 1 and 1000000");
  if (!Number.isInteger(o.maxDurationMs) || o.maxDurationMs < 1_000 || o.maxDurationMs > 3_600_000) throw new Error("max duration must be between 1000 and 3600000ms");
  if (!["population", "starter3"].includes(o.workload)) throw new Error("workload must be population or starter3");
  return o;
}

function hostIdentity() {
  return {
    cpuModel: os.cpus()[0]?.model ?? null,
    cpuCores: Math.max(1, os.cpus().length),
    memoryBytes: Number.isSafeInteger(os.totalmem()) ? os.totalmem() : null,
    platform: process.platform,
    arch: process.arch,
  };
}

function num(name, v) { const n = Number(v); if (!Number.isFinite(n)) throw new Error(`${name} needs a number, got ${v}`); return n; }
function round(v) { return Number.isFinite(v) ? Math.round(v * 1000) / 1000 : 0; }

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }).catch((error) => { console.error(error.stack ?? error.message); process.exitCode = 1; });
}
