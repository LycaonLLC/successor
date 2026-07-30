// Journey: humanoid loot-table drops through the live 3D client and authority
// oracle. Farms population-spawned rogue troopers whose corpses roll tiered
// gear (variant_id >= 60M) plus independent ordinary wardrobe pieces
// (item 7301–7335, variant 0). Authored scenario actors are intentionally not
// used because they do not exercise the population loot-table path.
//
// Stall root (verify-full attempt-0): shared nearestHostile acquire/approach
// locked onto open-desert-sparring-* while re-approach chased a different
// overlay rogue, so every post-first-kill QueueCombatAction rejected
// out_of_range for ~9 minutes. Helpers below stick to the scratch population
// prefix and walk/fight that exact actor id.
import { ITEM } from "./_helpers.mjs";

const DROP_VARIANT_FLOOR = 60_000_000; // rolled-drop variant namespace (LootTables)
const WARDROBE_ITEM_MIN = 7301;
const WARDROBE_ITEM_MAX = 7335;
const MAX_KILLS = 20;
const POP_PREFIX = "h3d-loot-drop-rogue";

function isPopulationRogue(id) {
  return typeof id === "string" && id.startsWith(POP_PREFIX);
}

function actorDist(player, actor) {
  return Math.hypot(Number(actor.x) - Number(player.x), Number(actor.y) - Number(player.y));
}

/** Nearest living scratch-population rogue from authority oracle, or null. */
async function nearestPopulationRogue(s) {
  const o = await s.oracle().catch(() => null);
  const player = o?.actors?.[s.actorId];
  if (!player || !o?.actors) return null;
  let best = null;
  let bestDist = Infinity;
  for (const [id, actor] of Object.entries(o.actors)) {
    if (!isPopulationRogue(id)) continue;
    if (!actor || actor.lifeState !== "alive") continue;
    if (actor.areaId && player.areaId && actor.areaId !== player.areaId) continue;
    const dist = actorDist(player, actor);
    if (dist < bestDist) {
      bestDist = dist;
      best = { id, dist, x: Number(actor.x), y: Number(actor.y) };
    }
  }
  return best;
}

async function ensurePlayerAlive(ctx, s) {
  const life = async () => {
    const o = await s.oracle().catch(() => null);
    return o?.actors?.[s.actorId]?.lifeState ?? null;
  };
  let state = await life();
  if (state === "alive" || state == null) return;
  ctx.note(`player lifeState=${state}; waiting incap auto-revive`);
  await s.waitProbeCall(
    () => s.oracle(),
    (o) => o?.actors?.[s.actorId]?.lifeState === "alive",
    { label: "player auto-revive", timeoutMs: 60000 },
  );
}

function authorityTick(probe) {
  const tick = Number(probe?.tick);
  return Number.isFinite(tick) ? tick : null;
}

function countPopulationRogues(oracle, player) {
  if (!oracle?.actors) return 0;
  let count = 0;
  for (const [id, actor] of Object.entries(oracle.actors)) {
    if (!isPopulationRogue(id)) continue;
    if (!actor || actor.lifeState !== "alive") continue;
    if (player?.areaId && actor.areaId && actor.areaId !== player.areaId) continue;
    count += 1;
  }
  return count;
}

/**
 * Wait until a living scratch-population rogue is on the authority map.
 * Under loaded farm the 20s wall clock is a lottery against activation/spawn;
 * wait up to 90s while authority ticks advance, and report tick/count diagnostics.
 */
async function waitPopulationHostile(ctx, s, { timeoutMs = 90000 } = {}) {
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  const startProbe = await s.probe().catch(() => null);
  const startingTick = authorityTick(startProbe);
  let currentTick = startingTick;
  let peakTick = startingTick ?? 0;
  let lastCount = 0;
  let samples = 0;
  while (Date.now() < deadline) {
    await ensurePlayerAlive(ctx, s);
    const found = await nearestPopulationRogue(s);
    const probe = await s.probe().catch(() => null);
    const oracle = await s.oracle().catch(() => null);
    const player = oracle?.actors?.[s.actorId] ?? null;
    currentTick = authorityTick(probe) ?? currentTick;
    if (currentTick != null && currentTick > peakTick) peakTick = currentTick;
    lastCount = countPopulationRogues(oracle, player);
    samples += 1;
    if (found) {
      ctx.note(
        `population hostile ready id=${found.id} startTick=${startingTick ?? "n/a"} `
        + `currentTick=${currentTick ?? "n/a"} tickDelta=${
          startingTick != null && currentTick != null ? currentTick - startingTick : "n/a"
        } livingPrefix=${lastCount} waitedMs=${Date.now() - startedAt}`,
      );
      return found;
    }
    // Probe presence is a cheap secondary signal while oracle catches up.
    if (probe?.nearestHostile?.lifeState === "alive" && isPopulationRogue(probe.nearestHostile.id)) {
      ctx.note(
        `population hostile via probe id=${probe.nearestHostile.id} startTick=${startingTick ?? "n/a"} `
        + `currentTick=${currentTick ?? "n/a"} livingPrefix=${lastCount} waitedMs=${Date.now() - startedAt}`,
      );
      return {
        id: probe.nearestHostile.id,
        dist: probe.nearestHostile.distanceCells,
        x: probe.nearestHostile.x,
        y: probe.nearestHostile.y,
      };
    }
    await ctx.delay(250);
  }
  const tickDelta = startingTick != null && currentTick != null ? currentTick - startingTick : null;
  throw new Error(
    "no living h3d-loot-drop-rogue population actor within budget"
    + ` (waitedMs=${Date.now() - startedAt}`
    + ` startTick=${startingTick ?? "n/a"}`
    + ` currentTick=${currentTick ?? "n/a"}`
    + ` tickDelta=${tickDelta ?? "n/a"}`
    + ` peakTick=${peakTick || "n/a"}`
    + ` livingPrefixCount=${lastCount}`
    + ` samples=${samples})`,
  );
}

/** Target a specific population rogue by id; retry through first-frame misses. */
async function acquirePopulationTarget(ctx, s, preferredId = null) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await ensurePlayerAlive(ctx, s);
    const pick = preferredId
      ? { id: preferredId }
      : await nearestPopulationRogue(s);
    const targetId = pick?.id ?? null;
    if (!targetId) {
      await ctx.delay(300);
      continue;
    }
    await s.slash(`/target ${targetId}`);
    const got = await s.waitProbe(
      (p) => String(p.selectedActorId) === String(targetId),
      { label: `population target ${targetId}`, timeoutMs: 4000 },
    ).catch(() => null);
    if (got) return targetId;
    await ctx.delay(400);
  }
  const fallback = await nearestPopulationRogue(s);
  const targetId = fallback?.id;
  if (!targetId) throw new Error("acquirePopulationTarget: no population rogue to select");
  await s.slash(`/target ${targetId}`);
  await s.waitProbe(
    (p) => String(p.selectedActorId) === String(targetId),
    { label: `population target ${targetId}`, timeoutMs: 4000 },
  );
  return targetId;
}

/**
 * Walk toward one authority actor id (not nearestHostile). Shared approachHostile
 * re-reads nearest each burst and drifts off the selected sparring/post target
 * onto overlay rogues — the out_of_range stall.
 */
async function approachActor(ctx, s, targetId, withinCells, { timeoutMs = 16000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const o = await s.oracle().catch(() => null);
    const player = o?.actors?.[s.actorId];
    const target = o?.actors?.[targetId];
    if (!player) { await ctx.delay(200); continue; }
    if (!target || target.lifeState !== "alive") return target ?? null;
    const dx = Number(target.x) - Number(player.x);
    const dy = Number(target.y) - Number(player.y);
    const dist = Math.hypot(dx, dy);
    if (dist <= withinCells) return target;
    const keys = [];
    if (dy > 0.25) keys.push("KeyS"); else if (dy < -0.25) keys.push("KeyW");
    if (dx > 0.25) keys.push("KeyD"); else if (dx < -0.25) keys.push("KeyA");
    if (keys.length === 0) keys.push("KeyD");
    await s.hold(keys, 280);
  }
  return (await s.oracle().catch(() => null))?.actors?.[targetId] ?? null;
}

/**
 * Melee the selected population actor until downed. Re-closes on THAT id and
 * re-issues /target so attack intent cannot stick to a different body.
 */
async function fightPopulationToKill(ctx, s, targetId, { timeoutMs = 60000, reAttackMs = 2500, meleeRange = 1.8 } = {}) {
  await s.slash(`/target ${targetId}`);
  await s.slash("/attack basic_shot $target");
  const deadline = Date.now() + timeoutMs;
  let lastAttack = Date.now();
  let killed = false;
  let sawMyHit = false;
  let lastTargetHp = null;
  while (Date.now() < deadline) {
    await ctx.delay(400);
    // One oracle snapshot owns player life, target life/hp, and melee range.
    // Never mix probe.playerCell (client-predicted) with authority target coords.
    const o = await s.oracle().catch(() => null);
    const player = o?.actors?.[s.actorId];
    const targetActor = o?.actors?.[targetId];
    const life = player?.lifeState ?? null;
    if (life && life !== "alive") {
      ctx.note(`fight interrupted; player lifeState=${life}`);
      break;
    }
    const p = await s.probe();
    if ((p.combatEventLog ?? []).some((e) => String(e.shooter) === String(p.playerActorId) && e.hit)) sawMyHit = true;
    if (targetActor?.vitals) lastTargetHp = targetActor.vitals.health;
    const targetDowned = targetActor && ["downed", "dead", "respawning"].includes(targetActor.lifeState);
    if (targetDowned) { killed = true; break; }
    if (!targetActor || targetActor.lifeState !== "alive") {
      // Released/despawned mid-fight — not a kill proof.
      break;
    }
    const dist = player && targetActor.x != null
      ? actorDist(player, targetActor)
      : Infinity;
    if (dist > meleeRange) {
      await approachActor(ctx, s, targetId, meleeRange, { timeoutMs: 4000 });
      await s.slash(`/target ${targetId}`);
      await s.slash("/attack basic_shot $target");
      lastAttack = Date.now();
      continue;
    }
    if (String(p.selectedActorId) !== String(targetId) || Date.now() - lastAttack > reAttackMs) {
      await s.slash(`/target ${targetId}`);
      await s.slash("/attack basic_shot $target");
      lastAttack = Date.now();
    }
  }
  const end = await s.probe();
  const myHits = (end.combatEventLog ?? []).filter((e) => e.shooter && String(end.playerActorId) === String(e.shooter)).length;
  return { killed, myHits, sawMyHit, lastTargetHp };
}

export default {
  id: "loot-drops",
  title: "Loot drops (population humanoids → authority corpse stacks)",
  timeoutMs: 540000,
  // West of the sparring post (592,512): scratch population surrounds the
  // probe. Journey helpers intentionally ignore open-desert-sparring-* so the
  // farm stays on the overlaid population loot-table path.
  characters: [{ role: "primary", id: "h3d-drops-probe", name: "ProbeDrops", x: 589, y: 512, initialProfessionId: "brawler" }],
  // Scratch population zones: Rust clamps initial_count and max_alive to 2 for
  // each humanoid/skirmisher zone. Ten distinct zones yield 20 total initial
  // skirmishers under that clamp to supply the 20-kill RNG budget deterministically.
  // Every zone shares the full 24-candidate pool so actor occupancy and solid obstacles
  // leave bounded slack for all 20 actors without failing authority placement.
  serverSliceOverlay: {
    spawnZones: Array.from({ length: 10 }, (_, i) => {
      const idx = String(i + 1).padStart(2, "0");
      return {
        id: "h3d-loot-drop-rogues-" + idx,
        actorIdPrefix: "h3d-loot-drop-rogue-" + idx,
        templateId: "open-desert-rogue-trooper",
        areaId: "open-desert-overworld",
        candidateCells: [
          { x: 583, y: 508 }, { x: 585, y: 508 }, { x: 587, y: 508 }, { x: 589, y: 508 },
          { x: 591, y: 508 }, { x: 593, y: 508 }, { x: 595, y: 508 }, { x: 583, y: 511 },
          { x: 585, y: 511 }, { x: 593, y: 511 }, { x: 595, y: 511 }, { x: 583, y: 514 },
          { x: 585, y: 514 }, { x: 587, y: 514 }, { x: 589, y: 514 }, { x: 591, y: 514 },
          { x: 593, y: 514 }, { x: 595, y: 514 }, { x: 583, y: 517 }, { x: 585, y: 517 },
          { x: 587, y: 517 }, { x: 591, y: 517 }, { x: 593, y: 517 }, { x: 595, y: 517 },
        ].map((c) => ({ ...c })),
        initialCount: 2,
        maxAlive: 2,
        spawnEverySeconds: 900,
        batchMin: 1,
        batchMax: 1,
        seed: 2_973_011 + i,
        activation: {
          radiusCells: 48,
          leashRadiusCells: 48,
          deactivationRadiusCells: 72,
          releaseTicks: 240,
          lingerTicks: 300,
          checkEveryTicks: 10,
        },
      };
    }),
  },
  async arm(ctx) {
    await ctx.debugCommand({ DebugGiveItem: { item_id: ITEM.vibrosword, variant_id: 0, quantity: 1, equip: true } });
    // brawler-ranged-block-i is Rust intentional 95% saber/ranged block lane for isolating loot-table proof under 20 initial skirmishers.
    await ctx.debugCommand({ DebugGrantSkillBoxes: { skill_box_ids: [
      "brawler-melee-i", "brawler-melee-ii", "brawler-melee-iii", "brawler-melee-iv",
      "brawler-attack-speed-i", "brawler-attack-speed-ii", "brawler-attack-speed-iii", "brawler-attack-speed-iv", "brawler-master",
      "brawler-ranged-block-i",
    ] } });
    ctx.note("armed vibrosword + brawler tree; farming population h3d-loot-drop-rogue* for rolled drops");
  },
  async run(ctx) {
    const s = ctx.primary;
    let kills = 0;
    let drop = null; // tiered gear roll
    let wardrobeDrop = null;
    for (let i = 0; i < MAX_KILLS && !drop; i += 1) {
      await ensurePlayerAlive(ctx, s);
      const present = await waitPopulationHostile(ctx, s);
      const targetId = await acquirePopulationTarget(ctx, s, present.id);
      if (!isPopulationRogue(targetId)) {
        ctx.note(`kill#${i} skip non-population target ${targetId}`);
        continue;
      }
      ctx.note(`kill#${i} engaging population ${targetId} (oracleDist=${present.dist?.toFixed?.(2) ?? present.dist ?? "?"})`);
      await approachActor(ctx, s, targetId, 1.4, { timeoutMs: 16000 });
      const result = await fightPopulationToKill(ctx, s, targetId, { meleeRange: 1.8, timeoutMs: 60000 });
      if (!result.killed) {
        ctx.note(`kill#${i} miss ${targetId} (targetHp=${result.lastTargetHp}, sawHit=${result.sawMyHit}) — retry`);
        await ensurePlayerAlive(ctx, s);
        continue;
      }
      kills += 1;
      // Population rogue-troopers carry no field-pack loot, so corpse stacks here
      // are either a tiered gear roll or the independent wardrobe roll.
      const corpse = `corpse:${targetId}`;
      const rolled = await s.waitProbeCall(
        () => s.oracle(),
        (o) => (o.inventory ?? []).some((r) => r.container === corpse && (r.available ?? 0) > 0),
        { label: `corpse ${corpse} roll`, timeoutMs: 4000 },
      ).catch(() => null);
      if (!rolled) { ctx.note(`kill#${kills} ${targetId}: rolled nothing`); continue; }
      const rows = rolled.inventory.filter((r) => r.container === corpse && (r.available ?? 0) > 0);
      const wardrobe = rows.find((r) => r.itemId >= WARDROBE_ITEM_MIN && r.itemId <= WARDROBE_ITEM_MAX && (r.variantId ?? r.variant_id ?? 0) === 0);
      if (wardrobe && !wardrobeDrop) {
        wardrobeDrop = { container: corpse, itemId: wardrobe.itemId, variantId: 0, available: wardrobe.available };
        ctx.note(`kill#${kills} ${targetId}: WARDROBE DROP item=${wardrobeDrop.itemId} variant=0 x${wardrobeDrop.available}`);
      }
      const row = rows.find((candidate) => (candidate.variantId ?? candidate.variant_id ?? 0) >= DROP_VARIANT_FLOOR);
      if (!row) { ctx.note(`kill#${kills} ${targetId}: wardrobe-only corpse; continue for tiered gear`); continue; }
      drop = { container: corpse, itemId: row.itemId, variantId: row.variantId ?? row.variant_id ?? 0, available: row.available };
      ctx.note(`kill#${kills} ${targetId}: ROLLED GEAR item=${drop.itemId} variant=${drop.variantId} x${drop.available}`);
    }
    ctx.note(`farmed ${kills} kill(s); tiered gear=${drop ? "yes" : "no"}; wardrobe=${wardrobeDrop ? `${wardrobeDrop.itemId}@0` : "not observed in this RNG run"}`);
    s.assert(kills > 0, "could not fell any population rogue-trooper (combat/targeting broken)");
    s.assert(drop, `no tiered humanoid-table drop across ${MAX_KILLS} kills (RNG tail ~1.3e-5, or tables not firing on naturals)`);
    s.assert(
      drop.variantId >= DROP_VARIANT_FLOOR,
      `corpse item variant ${drop.variantId} below rolled-drop floor ${DROP_VARIANT_FLOOR} — not a table roll`,
    );

    ctx.note(`authority corpse stack proven: ${drop.container} item=${drop.itemId} variant=${drop.variantId} x${drop.available}`);
    await ctx.moneyShot("00-corpse-rolled");
  },
};
