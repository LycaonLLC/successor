// ACTIVITY LOOPS + MULTI-PLAYER CHOREOGRAPHY, composed over the PlayFlows
// driver primitives. Every deliberate command is human-paced through the
// SimPlayer shell and narrated into the transcript. Combat/economy truth comes
// from the shard oracle; the behaviours only ever ASK the authority.
import { moveTo, engageTarget, surveyBest, trainSkill } from "../../successor/play-flows/primitives.mjs";
import { fetchJson, delay } from "./world.mjs";
import { recordDivergence } from "./kpi.mjs";

const CAMP_TRAINER = { x: 515, y: 514, areaId: "open-desert-overworld" };
const HUNTER_CAMP_SITES = [
  { x: 620, y: 552, areaId: "open-desert-overworld" },
  { x: 646, y: 552, areaId: "open-desert-overworld" },
  { x: 620, y: 526, areaId: "open-desert-overworld" },
];
const HOME_LEASH_CELLS = 60; // hunters work a ground near home instead of chasing across the map

// Cap a long internal wait so the soak winds down near its deadline instead of
// overrunning by a full activity timeout.
function capToDeadline(sim, ms) {
  if (!sim.deadlineMs) return ms;
  return Math.max(500, Math.min(ms, sim.deadlineMs - Date.now()));
}

// ---- seeded chat pools (human-plausible, varied per draw) -----------------
const CHAT = {
  greetHunt: ["heading up to the north ridge, rogues are thick today", "anyone seeing drifters near the dunes?", "loading in, going hunting", "back on. where's the action"],
  hunting: ["got one", "reloading", "these drifters hit hard", "clean kill", "watch the flank", "loot's mine, I tagged it", "one more and I'm heading back"],
  survey: ["iron's paying out over here", "surveying the flats, decent concentration", "sampling a vein, back in a bit", "crafting a battery, need copper", "workshop's humming"],
  trade: ["selling iron and stims, fair prices", "who needs ammo? got a stack", "open to trade, ping me", "coin for ore, my camp's the exchange", "deal's good, pleasure doing business"],
  duel: ["throw down then, first to yield", "no hard feelings — blades up", "good spar", "you're on", "well fought"],
  social: ["quiet out here tonight", "anyone running the verdance route?", "camp's up if you need to rest", "long shift", "how's everyone holding up"],
  farewell: ["logging off, good hunting", "that's me done for tonight", "heading out, catch you tomorrow", "packing it in"],
};

// ---- oracle helpers (authoritative truth source) -------------------------
async function oracle(sim) { return fetchJson(`${sim.gameUrl}/game/debug/oracle`); }
async function oracleActor(sim, actorId) { const o = await oracle(sim); return o.actors?.[actorId] ?? null; }
async function corpseRows(sim, container) {
  const o = await oracle(sim);
  return (o.inventory ?? []).filter((r) => r.container === container && Number(r.available) > 0);
}
function isCreature(actor) {
  return actor.role === "creature" || actor.factionId === "gaia" || String(actor.sprite ?? "").startsWith("creature-");
}
function isHostile(actor) {
  return (actor.factionId === "rogue_troopers" || isCreature(actor) || /rogue|drifter/i.test(`${actor.label} ${actor.id}`)) && actor.lifeState === "alive";
}
function dist(a, b) { return Math.hypot(Number(a.x) - Number(b.x), Number(a.y) - Number(b.y)); }

async function moveToward(sim, cell, opts = {}) {
  const outcome = await moveTo(sim.ctx, cell, { toleranceCells: opts.toleranceCells ?? 2.5, maxPulses: opts.maxPulses ?? 90, ...(opts.moveOptions ?? {}) });
  const after = await sim.where().catch(() => null);
  const oa = await oracleActor(sim, sim.actorId).catch(() => null);
  if (after && oa) recordDivergence(sim.kpi, after, oa, opts.rubberBandCells ?? 6);
  return { after, outcome };
}

// A leash walk that never hard-fails the invariant: arrives "close enough".
async function roveHome(sim, jitter = 6) {
  const target = { x: sim.home.x + sim.rng.int(-jitter, jitter), y: sim.home.y + sim.rng.int(-jitter, jitter), areaId: sim.home.areaId };
  await moveToward(sim, target, { toleranceCells: 4, maxPulses: 70 }).catch(() => {});
}

async function checkDeathAndRespawn(sim) {
  const v = await sim.vitals().catch(() => null);
  if (v && (v.lifeState === "downed" || v.lifeState === "dead" || (typeof v.health === "number" && v.health <= 0))) {
    sim.beat("death", `${sim.name} is downed.`, { vitals: v });
    await sim.act("reaction", "clone-respawn", () => sim.authority("/clone-respawn", { primitive: "cloneRespawn", commandKind: "CloneRespawn", requireAccepted: false, receiptTimeoutMs: 10_000 }));
    await sim.settle(1200);
    sim.beat("respawn", `${sim.name} respawns at the clone facility and gets back to it.`);
    return true;
  }
  return false;
}

// ---- ACTIVITY LOOP: patrol-and-hunt (leashed to home) --------------------
export async function patrolAndHunt(sim, { maxKills = 1 } = {}) {
  if (await checkDeathAndRespawn(sim)) return { status: "respawned" };
  const here = await sim.where().catch(() => sim.home);
  // if we drifted off the leash, walk back to the hunting ground first
  if (dist(here, sim.home) > HOME_LEASH_CELLS) {
    sim.beat("hunt", `${sim.name} circles back to the hunting ground.`);
    await roveHome(sim, 5);
  }
  let kills = 0;
  for (let round = 0; round < maxKills; round += 1) {
    const near = await sim.nearby("all").catch(() => null);
    const origin = near?.origin ?? await sim.where();
    const hostiles = (near?.actors ?? []).filter(isHostile).filter((a) => dist(a, sim.home) <= HOME_LEASH_CELLS);
    if (hostiles.length === 0) {
      sim.beat("hunt", `${sim.name} scans the ground — nothing in range, repositioning.`);
      await roveHome(sim, 8);
      await sim.settle(1200);
      continue;
    }
    hostiles.sort((a, b) => dist(a, origin) - dist(b, origin));
    const target = hostiles[0];
    const kind = isCreature(target) ? "creature" : "rogue";
    sim.beat("hunt", `${sim.name} spots ${target.label} at (${Math.round(target.x)},${Math.round(target.y)}) and closes in.`, { targetId: target.id, kind });
    await moveToward(sim, { x: target.x, y: target.y, areaId: target.areaId }, { toleranceCells: 6, maxPulses: 80 });
    const eng = await sim.act("reaction", "engage", () => engageTarget(sim.ctx, target.id, { actionId: "basic_shot", receiptTimeoutMs: 10_000 }));
    if (eng?.error || eng?.attack?.receipt?.accepted !== true) {
      sim.beat("hunt", `${sim.name}'s shot didn't connect (${eng?.attack?.receipt?.reasonCode ?? eng?.error ?? "no receipt"}).`);
      await sim.settle(1200);
      continue;
    }
    sim.beat("hunt", `${sim.name} opens fire on ${target.label}.`);
    const down = await waitForKill(sim, target.id, capToDeadline(sim, 55_000));
    if (down) {
      kills += 1;
      sim.beat("kill", `${sim.name} drops ${target.label}.`, { targetId: target.id });
      if (sim.rng.chanceMilli(680)) await sim.say("local", sim.rng.pick(CHAT.hunting));
      await lootCorpse(sim, target);
    } else {
      sim.beat("hunt", `${sim.name} loses the target.`);
    }
    if (await checkDeathAndRespawn(sim)) break;
    await sim.pace("step");
  }
  return { status: "hunted", kills };
}

async function waitForKill(sim, targetId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const a = await oracleActor(sim, targetId).catch(() => null);
    if (!a) return true;
    if (a.lifeState && a.lifeState !== "alive") return true;
    await delay(1200);
  }
  return false;
}

// Loot a corpse: creatures are HARVESTED (all available resources), humanoids are LOOTED
// from their cache rows. Both feed the "loots" KPI (see kpi KPI_KIND).
async function lootCorpse(sim, target) {
  const targetId = target.id;
  // step onto the corpse so the take/harvest is in reach
  const c = await oracleActor(sim, targetId).catch(() => null);
  if (c) await moveToward(sim, { x: c.x, y: c.y, areaId: c.areaId }, { toleranceCells: 1.4, maxPulses: 30 }).catch(() => {});
  if (isCreature(target)) {
    const res = await sim.act("reaction", "harvest", () => sim.authority(`/harvest-corpse target_actor_id=${targetId}`, { primitive: "harvest", commandKind: "HarvestCorpse", requireAccepted: false, receiptTimeoutMs: 10_000 }));
    if (res?.receipt?.accepted) sim.beat("loot", `${sim.name} harvests usable resources from the ${target.label}.`, { targetId });
    else sim.beat("loot", `${sim.name} couldn't harvest (${res?.receipt?.reasonCode ?? res?.error ?? "?"}).`);
    return;
  }
  const rows = await corpseRows(sim, `corpse:${targetId}`).catch(() => []);
  if (rows.length === 0) { sim.beat("loot", `${sim.name} checks the corpse — nothing worth taking.`); return; }
  const row = rows[0];
  const res = await sim.act("reaction", "loot", () => sim.authority(`/loot corpse:${targetId} ${row.itemId} ${row.variantId} ${row.available}`, { primitive: "loot", commandKind: "TakeLootItem", requireAccepted: false, receiptTimeoutMs: 10_000 }));
  if (res?.receipt?.accepted) sim.beat("loot", `${sim.name} loots ${row.available}x ${row.item ?? `item ${row.itemId}`} from the corpse.`, { itemId: row.itemId });
  else sim.beat("loot", `${sim.name} couldn't loot (${res?.receipt?.reasonCode ?? res?.error ?? "?"}).`);
}

// ---- ACTIVITY LOOP: survey -> sample -> craft ----------------------------
export async function surveyMineCraft(sim, { family = "iron" } = {}) {
  if (await checkDeathAndRespawn(sim)) return { status: "respawned" };
  let survey = await sim.act("reaction", "survey", () => surveyBest(sim.ctx, family, { requireAccepted: false }));
  if (survey?.survey?.receipt?.accepted === false && survey.survey.receipt.reasonCode === "missing_survey_tool") {
    sim.beat("craft", `${sim.name} lacks a survey tool — heading to the trainer.`);
    const t = await trainerVisit(sim, { box: "craftsman-novice" });
    if (!t.accepted) return { status: "no_tool" };
    survey = await sim.act("reaction", "survey", () => surveyBest(sim.ctx, family, { requireAccepted: false }));
  }
  if (!survey?.best) { sim.beat("craft", `${sim.name}'s survey came up empty (${survey?.survey?.receipt?.reasonCode ?? "no concentration"}).`); return { status: "survey_failed" }; }
  sim.beat("craft", `${sim.name} surveys ${family}: best vein ~${survey.best.concentrationPct}% nearby.`);
  // work the vein close to the workshop (iron + copper co-locate near camp) so
  // both craft metals are reachable without trekking off across the desert
  const here0 = await sim.where().catch(() => sim.home);
  if (dist(here0, sim.home) > 12) await moveToward(sim, sim.home, { toleranceCells: 3, maxPulses: 50 });
  await sim.act("reaction", "kneel", () => sim.authority("/kneel", { primitive: "kneel", commandKind: "SetPosture", requireAccepted: false, receiptTimeoutMs: 8_000 }));
  await sim.settle(800);
  const sampled = await sampleUntil(sim, family, 40, capToDeadline(sim, 60_000));
  sim.beat("craft", `${sim.name} samples ${family} (+${sampled} units to the crate).`);
  if (sim.rng.chanceMilli(600)) await sim.say("local", sim.rng.pick(CHAT.survey));
  await sim.act("reaction", "stand", () => sim.authority("/stand", { primitive: "stand", commandKind: "SetPosture", requireAccepted: false, receiptTimeoutMs: 8_000 }));
  await sampleSecondAndCraft(sim).catch((e) => sim.beat("warn", `${sim.name} craft attempt: ${e.message}`));
  return { status: "crafted" };
}

async function sampleUntil(sim, family, target, timeoutMs) {
  const invBefore = await sim.inv("resource-crate").catch(() => ({ totalAvailable: 0 }));
  const start = Number(invBefore?.totalAvailable ?? 0);
  await sim.act("reaction", "sample", () => sim.authority(`/sample ${family}`, { primitive: "sample", commandKind: "SampleResource", requireAccepted: false, receiptTimeoutMs: 10_000 }));
  const deadline = Date.now() + timeoutMs;
  let latest = start;
  while (Date.now() <= deadline) {
    await delay(2500);
    const inv = await sim.inv("resource-crate").catch(() => null);
    latest = Number(inv?.totalAvailable ?? latest);
    if (latest - start >= target) break;
  }
  return Math.max(0, latest - start);
}

// The soak provisions copper and processed fuel; the live survey/sample pull
// supplies the iron, so this phase can prove assembly without a second economy
// cooldown dominating a bounded run.
async function sampleSecondAndCraft(sim) {
  const invOracle = await oracle(sim);
  const owned = (invOracle.inventory ?? []).filter((r) => (r.container ?? "").startsWith(`${sim.actorId}:`) && Number(r.available) >= 1);
  const iron = owned.filter((r) => Number(r.itemId) === 2001 && Number(r.available) >= 12).sort((a, b) => b.available - a.available)[0];
  const copper = owned.filter((r) => Number(r.itemId) === 2007 && Number(r.available) >= 24).sort((a, b) => b.available - a.available)[0];
  const fuel = owned.filter((r) => Number(r.itemId) === 2009 && Number(r.available) >= 12).sort((a, b) => b.available - a.available)[0];
  if (!iron || !copper || !fuel) { sim.beat("craft", `${sim.name} doesn't have the full copper, iron, and processed-fuel lot yet — will craft next cycle.`); return; }
  sim.beat("craft", `${sim.name} begins crafting an extractor battery at the workbench.`);
  const begin = await sim.authority("/craft-begin extractor_battery", { primitive: "craftBegin", commandKind: "CraftBegin", requireAccepted: false, receiptTimeoutMs: 8_000 });
  if (begin?.receipt?.accepted !== true) { sim.beat("craft", `${sim.name} can't start the recipe (${begin?.receipt?.reasonCode ?? "?"}).`); return; }
  const slots = [
    ["copper", 0, copper],
    ["iron", 1, iron],
    ["fuel", 2, fuel],
  ];
  for (const [label, slotIndex, row] of slots) {
    const assigned = await sim.act("step", `assign ${label}`, () => sim.authority(`/craft-assign-slot slot_index=${slotIndex} container=${row.container} stack_id=${row.stackId} variant_id=${row.variantId ?? 0}`, { primitive: "craftAssign", commandKind: "CraftAssignSlot", requireAccepted: false }));
    if (assigned?.receipt?.accepted !== true) {
      sim.beat("craft", `${sim.name} can't seat the ${label} lot (${assigned?.receipt?.reasonCode ?? assigned?.error ?? "?"}).`);
      await sim.authority("/craft-cancel", { primitive: "craftCancel", commandKind: "CraftCancel", requireAccepted: false }).catch(() => {});
      return;
    }
  }
  const assemble = await sim.act("step", "assemble", () => sim.authority("/craft-assemble", { primitive: "craftAssemble", commandKind: "CraftAssemble", requireAccepted: false, receiptTimeoutMs: 8_000 }));
  if (assemble?.receipt?.accepted !== true) { sim.beat("craft", `${sim.name}'s assembly failed (${assemble?.receipt?.reasonCode ?? "?"}).`); return; }
  await sim.act("step", "experiment", () => sim.authority("/craft-experiment line_id=0 points=1", { primitive: "craftExperiment", commandKind: "CraftExperiment", requireAccepted: false }));
  const done = await sim.act("step", "finalize", () => sim.authority("/craft-finalize-prototype", { primitive: "craftFinalize", commandKind: "CraftFinalizePrototype", requireAccepted: false, receiptTimeoutMs: 8_000 }));
  if (done?.receipt?.accepted === true) sim.beat("craft", `${sim.name} finishes an extractor battery — not masterwork, but it works.`);
  else sim.beat("craft", `${sim.name} couldn't finalize the craft (${done?.receipt?.reasonCode ?? "?"}).`);
}

// ---- ACTIVITY LOOP: trainer visit ----------------------------------------
export async function trainerVisit(sim, { box = "marksman-rifle-i" } = {}) {
  const here = await sim.where().catch(() => sim.home);
  if (dist(here, CAMP_TRAINER) > 45) { sim.beat("trainer", `${sim.name} is too far from a trainer right now; will train back at camp later.`); await sim.pace("idle"); return { status: "too_far", accepted: false }; }
  sim.beat("trainer", `${sim.name} steps up to the Camp Trainer to work on ${box}.`);
  await moveToward(sim, CAMP_TRAINER, { toleranceCells: 1.3, maxPulses: 90 });
  const res = await sim.act("reaction", "train", () => trainSkill(sim.ctx, box, { trainerId: "camp-trainer", move: false }));
  const reasonCode = res?.trained?.receipt?.reasonCode ?? res?.error ?? null;
  const trained = res?.trained?.receipt?.accepted === true;
  const ready = trained || (typeof reasonCode === "string" && reasonCode.includes("skill_already_learned"));
  if (trained) sim.beat("trainer", `${sim.name} trains ${box}.`);
  else if (ready) sim.beat("trainer", `${sim.name} already knows ${box}.`);
  else sim.beat("trainer", `${sim.name} skips training (${reasonCode ?? "already known"}).`);

  if (ready && box === "craftsman-novice") {
    const tool = await sim.act("reaction", "starter tools", () => sim.authority("/request-starter-tool camp-trainer", { primitive: "requestStarterTool", commandKind: "RequestStarterTool", requireAccepted: false, receiptTimeoutMs: 8_000 }));
    const toolReason = tool?.receipt?.reasonCode ?? null;
    const equipped = tool?.receipt?.accepted === true || toolReason === "tool_already_held";
    if (tool?.receipt?.accepted === true) sim.beat("trainer", `${sim.name} requisitions the starter tool bundle.`);
    else if (!equipped) sim.beat("trainer", `${sim.name} couldn't requisition starter tools (${toolReason ?? "?"}).`);
    return { status: equipped ? "trained" : "no_tool", accepted: equipped };
  }

  return { status: ready ? "trained" : "rejected", accepted: ready };
}

// ---- ACTIVITY LOOP: camp rest --------------------------------------------
export async function campRest(sim) {
  const has = await sim.inv().catch(() => null);
  const hasKit = (has?.rows ?? []).some((r) => Number(r.itemId) === 3007 && Number(r.available) > 0);
  if (!hasKit) { sim.beat("camp", `${sim.name} has no camp kit; takes a short breather instead.`); await sim.pace("idle"); return { status: "no_kit" }; }
  const here = await sim.where().catch(() => sim.home);
  const sites = [here, ...HUNTER_CAMP_SITES];
  let placed = null;
  for (const site of sites) {
    if (dist(await sim.where().catch(() => sim.home), site) > 1.3) {
      await moveToward(sim, site, { toleranceCells: 1.3, maxPulses: 60 });
    }
    sim.beat("camp", `${sim.name} pitches a scout camp to rest.`);
    placed = await sim.act("reaction", "place-camp", () => sim.authority("/place-camp", { primitive: "placeCamp", commandKind: "PlaceCamp", requireAccepted: false, receiptTimeoutMs: 8_000 }));
    if (placed?.receipt?.accepted === true) break;
    if (placed?.receipt?.reasonCode !== "structure_footprint_blocked") break;
    sim.beat("camp", `${sim.name} finds the ground blocked and scouts a clearer patch.`);
  }
  if (placed?.receipt?.accepted !== true) { sim.beat("camp", `${sim.name} couldn't pitch camp (${placed?.receipt?.reasonCode ?? "already placed"}).`); return { status: "failed" }; }
  if (sim.rng.chanceMilli(500)) await sim.say("local", sim.rng.pick(CHAT.social));
  sim.beat("camp", `${sim.name} rests at the camp for a while.`);
  await sim.settle(sim.rng.int(4000, 8000));
  return { status: "camped" };
}

// ---- ACTIVITY LOOP: trader rounds (errand + social, near home) -----------
export async function traderRounds(sim) {
  sim.beat("errand", `${sim.name} works the crowd, hawking wares.`);
  await roveHome(sim, 7);
  if (sim.rng.chanceMilli(800)) await sim.say(sim.rng.chanceMilli(500) ? "trade" : "zone", sim.rng.pick(CHAT.trade));
  await sim.pace("idle");
  return { status: "errand" };
}

// ---- ACTIVITY LOOP: chat smalltalk ---------------------------------------
export async function chatSmalltalk(sim, { context = "social" } = {}) {
  const pool = CHAT[context] ?? CHAT.social;
  await sim.say(sim.rng.chanceMilli(sim.personality.traits.sociability) ? "zone" : "local", sim.rng.pick(pool));
  return { status: "chatted" };
}

export async function idle(sim) {
  sim.beat("idle", `${sim.name} pauses to get their bearings.`);
  await sim.pace("idle");
  return { status: "idle" };
}

// ======== CHOREOGRAPHY between two SimPlayers ==============================

export async function rendezvous(a, b, { withinCells = 1.5 } = {}) {
  const wb = await b.where().catch(() => null);
  if (!wb) return false;
  a.beat("meet", `${a.name} moves to meet ${b.name}.`);
  await moveToward(a, { x: wb.x, y: wb.y, areaId: wb.areaId }, { toleranceCells: withinCells, maxPulses: 120 }).catch(() => {});
  return true;
}

export async function formGroup(leader, member) {
  await rendezvous(leader, member, { withinCells: 6 });
  leader.beat("group", `${leader.name} invites ${member.name} to group up.`);
  const inv = await leader.act("reaction", "group-invite", () => leader.authority(`/group-invite ${member.actorId}`, { primitive: "groupInvite", commandKind: "GroupInvite", requireAccepted: false, receiptTimeoutMs: 10_000 }));
  if (inv?.receipt?.accepted !== true) { leader.beat("group", `${leader.name}'s invite bounced (${inv?.receipt?.reasonCode ?? "?"}).`); return { ok: false }; }
  await member.pace("reaction");
  const acc = await member.act("reaction", "group-accept", () => member.authority("/group-accept", { primitive: "groupAccept", commandKind: "GroupAccept", requireAccepted: false, receiptTimeoutMs: 10_000 }));
  const ok = acc?.receipt?.accepted === true;
  if (ok) { member.beat("group", `${member.name} accepts — party formed with ${leader.name}.`); await member.say("local", "grouped up, let's move"); }
  else member.beat("group", `${member.name} couldn't accept (${acc?.receipt?.reasonCode ?? "?"}).`);
  return { ok };
}

export async function duelBetween(challenger, target) {
  await rendezvous(challenger, target, { withinCells: 3 });
  challenger.beat("duel", `${challenger.name} throws down the glove — challenges ${target.name} to a duel.`);
  await challenger.say("local", challenger.rng.pick(CHAT.duel));
  const ch = await challenger.act("reaction", "duel-challenge", () => challenger.authority(`/duel-challenge ${target.actorId}`, { primitive: "duelChallenge", commandKind: "DuelChallenge", requireAccepted: false, receiptTimeoutMs: 10_000 }));
  if (ch?.receipt?.accepted !== true) { challenger.beat("duel", `${challenger.name}'s challenge failed (${ch?.receipt?.reasonCode ?? "?"}).`); return { ok: false }; }
  await target.pace("reaction");
  const ac = await target.act("reaction", "duel-accept", () => target.authority("/duel-accept", { primitive: "duelAccept", commandKind: "DuelAccept", requireAccepted: false, receiptTimeoutMs: 10_000 }));
  if (ac?.receipt?.accepted !== true) { target.beat("duel", `${target.name} declined or couldn't accept (${ac?.receipt?.reasonCode ?? "?"}).`); return { ok: false }; }
  target.beat("duel", `${target.name} accepts — blades up, the duel is on.`);
  const chBefore = await oracleActor(challenger, challenger.actorId).catch(() => null);
  await challenger.act("reaction", "duel-fire", () => engageTarget(challenger.ctx, target.actorId, { actionId: "basic_shot", receiptTimeoutMs: 8_000 })).catch(() => {});
  await target.act("reaction", "duel-fire", () => engageTarget(target.ctx, challenger.actorId, { actionId: "basic_shot", receiptTimeoutMs: 8_000 })).catch(() => {});
  challenger.beat("duel", `${challenger.name} and ${target.name} trade fire.`);
  await delay(challenger.rng.int(5000, 8000));
  // honourable end: the challenger yields. We verify via the yield RECEIPT +
  // post-duel health. The duel-outcome envelope, when forwarded, is captured
  // opportunistically but never required.
  const yield_ = await challenger.act("reaction", "duel-yield", () => challenger.authority("/duel-yield", { primitive: "duelYield", commandKind: "DuelYield", requireAccepted: false, receiptTimeoutMs: 12_000 }));
  const yielded = yield_?.receipt?.accepted === true;
  const chAfter = await oracleActor(challenger, challenger.actorId).catch(() => null);
  const tgAfter = await oracleActor(target, target.actorId).catch(() => null);
  const outcomeEnvelope = challenger.driver.envelopes.slice(-40).find((e) => e.type === "event" && /duel/i.test(String(e.event)) && (e.data?.payload?.outcome || e.data?.outcome));
  challenger.beat("duel", `${challenger.name} lowers their weapon — the duel ends with honor.`, { yielded, challengerHealthBefore: chBefore?.vitals?.health, challengerHealthAfter: chAfter?.vitals?.health, targetHealthAfter: tgAfter?.vitals?.health, outcomeForwarded: Boolean(outcomeEnvelope) });
  target.beat("duel", `${target.name} takes the win. Good spar.`);
  await target.say("local", target.rng.pick(CHAT.duel));
  await challenger.authority("/peace", { primitive: "peace", commandKind: "Peace", requireAccepted: false }).catch(() => {});
  await target.authority("/peace", { primitive: "peace", commandKind: "Peace", requireAccepted: false }).catch(() => {});
  return { ok: true, yielded };
}

// Trade over the authority double-lock surface: item lines are staged in the
// proposal, scalar wallet credits through SetTradeCoin, then both participants
// lock and confirm. The authority oracle proves the atomic swap.
export async function tradeBetween(seller, buyer, { offerSpec, requestSpec, offerItemId, requestItemId, offerCredits = 0 } = {}) {
  const beforeSeller = await snapshotStacks(seller, [offerItemId, requestItemId]);
  const beforeBuyer = await snapshotStacks(buyer, [offerItemId, requestItemId]);
  const beforeSellerCredits = await walletCredits(seller);
  const beforeBuyerCredits = await walletCredits(buyer);
  // Settle the buyer so it is a fixed target (TRADE_INTERACTION_RADIUS is 1.5
  // cells), then close in and propose with retries — a leashed hunter can end a
  // step just outside range, so a single approach is seed-fragile.
  await buyer.authority("/set-move-intent 0 0", { primitive: "settle", commandKind: "SetMoveIntent", requireAccepted: false, receiptTimeoutMs: 6_000 }).catch(() => {});
  let propose = null;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const wb = await buyer.where().catch(() => null);
    if (wb) await moveToward(seller, { x: wb.x, y: wb.y, areaId: wb.areaId }, { toleranceCells: 1.0, maxPulses: 90 }).catch(() => {});
    if (attempt === 0) { seller.beat("meet", `${seller.name} moves to meet ${buyer.name}.`); seller.beat("trade", `${seller.name} opens a trade with ${buyer.name}: offering ${offerSpec} for ${requestSpec}.`); await seller.say("trade", seller.rng.pick(CHAT.trade)); }
    propose = await seller.act("reaction", "trade-propose", () => seller.authority(`/trade ${buyer.actorId} ${offerSpec} for ${requestSpec}`, { primitive: "proposeTrade", commandKind: "ProposeTrade", requireAccepted: false, receiptTimeoutMs: 10_000 }));
    if (propose?.receipt?.accepted === true) break;
    if (propose?.receipt?.reasonCode !== "target_unavailable") break;
    seller.beat("trade", `${seller.name} edges closer to ${buyer.name} to open the table.`);
    await seller.settle(500);
  }
  if (propose?.receipt?.accepted !== true) { seller.beat("trade", `${seller.name}'s proposal failed (${propose?.receipt?.reasonCode ?? propose?.error ?? "?"}).`); return { ok: false, reason: propose?.receipt?.reasonCode }; }
  const proposalId = await waitTradeProposalId(seller, 8_000);
  if (proposalId === null) { seller.beat("trade", `${seller.name} never saw the session open.`); return { ok: false, reason: "no_session" }; }
  if (offerCredits > 0) {
    const staged = await seller.act("step", "trade-credits", () => seller.authority(
      `/set-trade-coin ${proposalId} ${offerCredits}`,
      { primitive: "setTradeCredits", commandKind: "SetTradeCoin", requireAccepted: false, receiptTimeoutMs: 8_000 },
    ));
    if (staged?.receipt?.accepted !== true) {
      seller.beat("trade", `credit offer failed (${staged?.receipt?.reasonCode ?? "?"}).`);
      return { ok: false, reason: "credit_offer_failed" };
    }
  }
  buyer.beat("trade", `${buyer.name} looks over ${seller.name}'s offer.`);
  await buyer.act("reaction", "trade-review", () => buyer.nearby("all"));
  const sLock = await seller.act("step", "trade-lock", () => seller.authority(`/accept-trade ${proposalId}`, { primitive: "acceptTrade", commandKind: "AcceptTrade", requireAccepted: false, receiptTimeoutMs: 8_000 }));
  const bLock = await buyer.act("step", "trade-lock", () => buyer.authority(`/accept-trade ${proposalId}`, { primitive: "acceptTrade", commandKind: "AcceptTrade", requireAccepted: false, receiptTimeoutMs: 8_000 }));
  if (sLock?.receipt?.accepted !== true || bLock?.receipt?.accepted !== true) { seller.beat("trade", `lock failed (seller ${sLock?.receipt?.reasonCode ?? "?"} / buyer ${bLock?.receipt?.reasonCode ?? "?"}).`); return { ok: false, reason: "lock_failed" }; }
  seller.beat("trade", `both seal their offers.`);
  await seller.act("step", "trade-confirm", () => seller.authority(`/confirm-trade ${proposalId}`, { primitive: "confirmTrade", commandKind: "ConfirmTrade", requireAccepted: false, receiptTimeoutMs: 8_000 }));
  const c2 = await buyer.act("step", "trade-confirm", () => buyer.authority(`/confirm-trade ${proposalId}`, { primitive: "confirmTrade", commandKind: "ConfirmTrade", requireAccepted: false, receiptTimeoutMs: 8_000 }));
  await seller.settle(1200);
  const afterSeller = await snapshotStacks(seller, [offerItemId, requestItemId]);
  const afterBuyer = await snapshotStacks(buyer, [offerItemId, requestItemId]);
  const afterSellerCredits = await walletCredits(seller);
  const afterBuyerCredits = await walletCredits(buyer);
  const sellerGaveOffer = offerItemId === null || offerItemId === undefined
    ? afterSellerCredits === beforeSellerCredits - offerCredits
    : (afterSeller[offerItemId] ?? 0) < (beforeSeller[offerItemId] ?? 0);
  const buyerGotOffer = offerItemId === null || offerItemId === undefined
    ? afterBuyerCredits === beforeBuyerCredits + offerCredits
    : (afterBuyer[offerItemId] ?? 0) > (beforeBuyer[offerItemId] ?? 0);
  const ok = c2?.receipt?.accepted === true && sellerGaveOffer && buyerGotOffer;
  if (ok) { seller.beat("trade", `${seller.name} and ${buyer.name} shake on it — goods change hands (oracle-confirmed swap).`, { proposalId, offerItemId, requestItemId, offerCredits, beforeSeller, afterSeller, beforeBuyer, afterBuyer, beforeSellerCredits, afterSellerCredits, beforeBuyerCredits, afterBuyerCredits }); await buyer.say("trade", buyer.rng.pick(CHAT.trade)); }
  else seller.beat("trade", `the swap did not execute cleanly (confirm ${c2?.receipt?.reasonCode ?? "?"}; sellerGave=${sellerGaveOffer} buyerGot=${buyerGotOffer}).`);
  return { ok, proposalId, beforeSeller, afterSeller, beforeBuyer, afterBuyer };
}

async function walletCredits(sim) {
  const actor = await oracleActor(sim, sim.actorId);
  return Number(actor?.credits ?? 0);
}

async function snapshotStacks(sim, itemIds) {
  const o = await oracle(sim);
  const out = {};
  for (const id of itemIds) {
    if (id === null || id === undefined) continue;
    out[id] = (o.inventory ?? [])
      .filter((r) => (r.container ?? "").startsWith(`${sim.actorId}`) && Number(r.itemId) === Number(id))
      .reduce((sum, r) => sum + Number(r.available ?? 0), 0);
  }
  return out;
}

async function waitTradeProposalId(sim, timeoutMs) {
  const start = Math.max(0, sim.driver.envelopes.length - 60);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const ev = sim.driver.envelopes.slice(start).find((e) => e.type === "event" && e.event === "trade_session" && e.data?.payload?.proposalId !== undefined);
    if (ev) return Number(ev.data.payload.proposalId);
    await delay(300);
  }
  return null;
}

export { CHAT };
