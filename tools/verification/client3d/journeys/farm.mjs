// Journey: FARM LIVING LOOP — acquire → claim → till → plant → water → grow →
// HARVEST (produce + offspring) → REPLANT the offspring → second generation.
// Agriculture W1-W5 + BioEngineer seed lineage, driven via slash verbs, asserted
// through the server oracle (placedParcels + farmPlots + inventory). Claim is a
// credit sink; tiles are farmed POINT-BLANK inside the parcel's farm yard.
// Growth runs on the dev day-length (SUCCESSOR_FARM_DAY_SECONDS on the scratch
// backend) so a crop matures in seconds; harvest is driven by attempts (stored
// truth), not the lazy materialized snapshot.
//
// RELIABILITY: each farm verb is sent via slash, then the oracle is polled to
// confirm the command was accepted. Under concurrent gate load the WebSocket
// flush pipeline (gameAuthoritySystem.ts flushGameAuthorityCommands) can silently
// drop enqueued authority commands when the sourceMatchesClient guard fires; the
// retry loop absorbs this by re-sending on missed oracle confirmation.
import { findInventoryStack } from "./_helpers.mjs";

const ASHGRAIN_SEED = 6001;
const ASHGRAIN_PRODUCE = 6101;
const GENE_SAMPLER = 6201;
const CLAIM_X = 800; // lattice-aligned SNAPPED origin the claim must land on (800 = 100*8)
const CLAIM_Y = 800;
const REQUEST_X = 803; // deliberately OFF-lattice: the server snap rounds 803->800, 802->800
const REQUEST_Y = 802;

/** Send a slash command and wait for oracle confirmation; retry on miss. */
async function slashAndConfirm(ctx, s, slashLine, oraclePredicate, { label, retries = 4, timeoutMs = 6000, delayMs = 500 } = {}) {
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    await s.slash(slashLine);
    const result = await s.waitProbeCall(
      () => s.oracle(),
      oraclePredicate,
      { label: `${label} (attempt ${attempt + 1})`, timeoutMs },
    ).catch(() => null);
    if (result) return result;
    ctx.note(`${label}: oracle miss on attempt ${attempt + 1}, retrying slash`);
    await ctx.delay(delayMs);
  }
  return null;
}

export default {
  id: "farm",
  title: "Farm living loop (claim/till/plant/grow/HARVEST/replant)",
  timeoutMs: 180000,
  characters: [{ role: "primary", id: "h3d-farm-probe", name: "ProbeFarm", x: CLAIM_X, y: CLAIM_Y, initialProfessionId: "craftsman" }],
  async arm(ctx) {
    // The fresh character's 5,000-credit wallet funds the claim. A Gene Sampler
    // + Sequencing box lets the probe sample a REAL fertile wild genome (so
    // harvest mints true-breeding offspring — a variant-0 stub would grow but
    // propagate nothing).
    await ctx.debugCommand({ DebugGiveItem: { item_id: GENE_SAMPLER, variant_id: 0, quantity: 1 } });
    await ctx.debugCommand({ DebugGrantSkillBoxes: { skill_box_ids: ["bioengineer-novice"] } });
    ctx.note("armed Gene Sampler + bioengineer-novice; using fresh wallet credits");
  },
  async run(ctx) {
    const s = ctx.primary;
    await ctx.moneyShot("00-spawn");

    // ── ACQUIRE: sample a real fertile wild ashgrain genome into a seed. ──
    await s.slash("/gene-sample ashgrain");
    const seed = await findInventoryStack(s, ASHGRAIN_SEED, { timeoutMs: 10000 });
    s.assert(seed, "gene-sample never banked an ashgrain seed");
    ctx.note(`acquired seed handle ${seed.variantId}`);

    // ── CLAIM a homestead: request an OFF-lattice origin; the server SNAPS it to the
    //    global lattice so the lot lands on (CLAIM_X, CLAIM_Y). Journeys assert the
    //    snapped origin (LAND WAVE §A/§5) — the whole point of server-side snap.
    await s.slash(`/claim ashvat open-desert-overworld ${REQUEST_X} ${REQUEST_Y} homestead`);
    const claimed = await s.waitProbeCall(
      () => s.oracle(),
      (o) => (o.placedParcels ?? []).some((p) => p.rect && p.rect.x === CLAIM_X && p.rect.y === CLAIM_Y),
      { label: "homestead parcel claimed at the snapped lattice origin", timeoutMs: 12000 },
    );
    const parcel = claimed.placedParcels.find((p) => p.rect && p.rect.x === CLAIM_X && p.rect.y === CLAIM_Y);
    s.assert(parcel, `claim must SNAP from (${REQUEST_X},${REQUEST_Y}) to the lattice origin (${CLAIM_X},${CLAIM_Y})`);
    s.assert(parcel.rect.x % 8 === 0 && parcel.rect.y % 8 === 0, "the snapped origin is lattice-aligned (multiple of 8)");
    ctx.note(`claim requested (${REQUEST_X},${REQUEST_Y}) -> SNAPPED to (${parcel.rect.x},${parcel.rect.y})`);
    const parcelId = parcel.parcelId;
    const yard = parcel.farmYard;
    ctx.note(`claimed ${parcelId} tier ${parcel.tier} yard ${JSON.stringify(yard)}`);

    // The one-second QA game-day also makes the prepaid 30-day upkeep period
    // expire in 30 real seconds. Exercise the real owner finance path now so the
    // grow loop remains live long enough to harvest instead of silently freezing
    // at the deed boundary.
    const knownReceiptIds = new Set((await s.probe()).authorityReceiptTail?.map((entry) => entry.commandId) ?? []);
    await s.slash(`/upkeep ${parcelId}`);
    const paidProbe = await s.waitProbe(
      (probe) => (probe.authorityReceiptTail ?? []).some((entry) => (
        !knownReceiptIds.has(entry.commandId) && entry.kind === "PayUpkeep"
      )),
      { label: "PayUpkeep authority receipt", timeoutMs: 8000 },
    );
    const upkeepReceipt = (paidProbe.authorityReceiptTail ?? []).find((entry) => (
      !knownReceiptIds.has(entry.commandId) && entry.kind === "PayUpkeep"
    ));
    s.assert(upkeepReceipt?.accepted === true, `PayUpkeep rejected: ${JSON.stringify(upkeepReceipt ?? null)}`);
    ctx.note(`upkeep extended through accepted receipt ${JSON.stringify(upkeepReceipt)}`);
    await ctx.moneyShot("01-claimed");

    // Cardinal contract: east is screen-right / +X and south is screen-down /
    // +Y. Move along each axis explicitly into the yard; the old isometric
    // shortcut treated S as southeast and stranded the probe west of the lot.
    const inYard = (a) => a && a.x >= yard.x && a.y >= yard.y && a.x < yard.x + yard.w && a.y < yard.y + yard.h;
    const sprintToward = async (code, reached) => {
      for (let i = 0; i < 18 && !reached((await s.probe()).authorityPlayer); i += 1) {
        await s.dispatchKeys("keydown", ["ShiftLeft", code]);
        await ctx.delay(180);
        await s.dispatchKeys("keyup", [code, "ShiftLeft"]);
        await ctx.delay(100);
      }
    };
    await sprintToward("KeyD", (actor) => actor && actor.x >= yard.x + 1);
    await sprintToward("KeyS", (actor) => actor && actor.y >= yard.y + 1);
    if (!inYard((await s.probe()).authorityPlayer)) {
      // Fine correction without sprint overshoot.
      await s.dispatchKeys("keydown", ["KeyD", "KeyS"]);
      await ctx.delay(220);
      await s.dispatchKeys("keyup", ["KeyS", "KeyD"]);
      await ctx.delay(120);
    }
    await s.releaseAll();

    // ── TILL → PLANT → WATER the tile UNDERFOOT. Each slash command is sent
    // and oracle-confirmed; on miss (WebSocket flush dropped the command under
    // concurrent load), the slash is re-sent. ──
    const tileAt = (o, x, y) => ((o.farmPlots ?? []).find((pl) => pl.parcelId === parcelId)?.tiles ?? [])
      .find((t) => t.cellX === x && t.cellY === y);
    let grown = null;
    let cellX = null;
    let cellY = null;
    for (let attempt = 0; attempt < 5 && !grown; attempt += 1) {
      await s.releaseAll();
      await ctx.delay(700);
      const pos = (await s.probe()).authorityPlayer;
      s.assert(inYard(pos), `could not reach the farm yard (at ${pos.x.toFixed(1)},${pos.y.toFixed(1)})`);
      cellX = Math.floor(pos.x);
      cellY = Math.floor(pos.y);
      ctx.note(`attempt ${attempt + 1}: standing at tile ${cellX},${cellY}`);

      // TILL: send and confirm the tile is tilled.
      const tilled = await slashAndConfirm(
        ctx, s, `/till ${parcelId} ${cellX} ${cellY}`,
        (o) => { const t = tileAt(o, cellX, cellY); return t && t.tilled; },
        { label: "till", timeoutMs: 6000 },
      );
      if (!tilled) { ctx.note(`retry ${attempt + 1} — till missed`); continue; }

      // PLANT: send and confirm a crop is planted.
      const planted = await slashAndConfirm(
        ctx, s, `/plant ${parcelId} ${cellX} ${cellY} ${seed.container} ${seed.stackId} ${seed.variantId}`,
        (o) => { const t = tileAt(o, cellX, cellY); return t && t.crop; },
        { label: "plant", timeoutMs: 6000 },
      );
      if (!planted) { ctx.note(`retry ${attempt + 1} — plant missed`); continue; }

      // WATER: send and confirm moisture.
      const watered = await slashAndConfirm(
        ctx, s, `/water ${parcelId} ${cellX} ${cellY}`,
        (o) => { const t = tileAt(o, cellX, cellY); return t && t.tilled && t.crop && t.moisturePct > 0; },
        { label: "water", timeoutMs: 6000 },
      );
      if (watered) grown = watered;
      else ctx.note(`retry ${attempt + 1} — water missed`);
    }
    s.assert(grown, "tile never reached tilled+planted+watered");
    const tile = tileAt(grown, cellX, cellY);
    s.assert(tile.crop && tile.crop.seedItemId === ASHGRAIN_SEED, "tile did not register the planted crop");
    ctx.note(`growth: stage ${tile.crop.stage}/${tile.crop.stageCount} matureInDays ${tile.crop.timeToMatureGameDays} health ${tile.crop.health}`);
    await ctx.moneyShot("02-planted-watered");

    // ── GROW: water advances stored growth (lazy settle); poll until the crop
    // reads harvestable (dev day-length → seconds). Each water is confirmed via
    // oracle before sending the next — if a water is silently dropped by the
    // flush pipeline, the retry fires another. ──
    let lastMoisture = -1;
    const matured = await s.waitProbeCall(
      async () => {
        // Only re-water when moisture has been consumed (avoids flooding the
        // command queue with redundant waters that the flush pipeline drops).
        const pre = await s.oracle();
        const preTile = tileAt(pre, cellX, cellY);
        const moisture = preTile?.moisturePct ?? 0;
        if (moisture <= lastMoisture || moisture === 0) {
          await s.slash(`/water ${parcelId} ${cellX} ${cellY}`);
          await ctx.delay(1200);
        } else {
          await ctx.delay(600);
        }
        const post = await s.oracle();
        const postTile = tileAt(post, cellX, cellY);
        lastMoisture = postTile?.moisturePct ?? 0;
        return post;
      },
      (o) => { const t = tileAt(o, cellX, cellY); return t && t.crop && t.crop.mature === true; },
      { label: "crop matured (harvestable)", timeoutMs: 90000, intervalMs: 200 },
    );
    ctx.note(`matured: ${JSON.stringify(tileAt(matured, cellX, cellY).crop).slice(0, 200)}`);
    await ctx.moneyShot("03-grown");

    // ── HARVEST: produce (6_1xx) into the bag + true-breeding OFFSPRING seeds.
    // Detect success via the PRODUCE landing in inventory (regrowth-agnostic — a
    // perennial regrows the tile, a single-harvest clears it; both mint produce). ──
    await s.slash(`/reap ${parcelId} ${cellX} ${cellY}`);
    const produce = await s.waitProbeCall(
      () => findInventoryStack(s, ASHGRAIN_PRODUCE, { timeoutMs: 1500 }),
      (row) => !!row && row.available >= 1,
      { label: "harvest minted produce into the bag", timeoutMs: 14000 },
    );
    s.assert(produce && produce.available >= 1, "harvest did not mint produce into the bag");
    const offspring = await findInventoryStack(s, ASHGRAIN_SEED, { timeoutMs: 8000 });
    s.assert(offspring && offspring.available >= 1, "harvest minted no offspring seeds (fertile crop should propagate)");
    ctx.note(`harvest: produce x${produce.available}, offspring seeds x${offspring.available} (handle ${offspring.variantId})`);
    await ctx.moneyShot("04-harvested");

    // ── SECOND GENERATION: a single-harvest crop cleared the tile (replant the
    // offspring); a perennial already regrew in place. Either way a crop stands. ──
    const afterHarvest = tileAt(await s.oracle(), cellX, cellY);
    if (!afterHarvest || !afterHarvest.crop) {
      await s.slash(`/plant ${parcelId} ${cellX} ${cellY} ${offspring.container} ${offspring.stackId} ${offspring.variantId}`);
      await s.slash(`/water ${parcelId} ${cellX} ${cellY}`);
      ctx.note("single-harvest crop cleared the tile — replanted the offspring");
    } else {
      ctx.note("perennial crop regrew in place — the second fruiting");
    }
    const gen2 = await s.waitProbeCall(
      () => s.oracle(),
      (o) => { const t = tileAt(o, cellX, cellY); return t && t.crop && t.crop.seedItemId === ASHGRAIN_SEED; },
      { label: "second generation growing", timeoutMs: 12000 },
    );
    const g2 = tileAt(gen2, cellX, cellY);
    s.assert(g2.crop && g2.crop.seedItemId === ASHGRAIN_SEED, "second generation did not take root");
    ctx.note(`second generation: stage ${g2.crop.stage}/${g2.crop.stageCount} — the living loop closes`);
    await ctx.moneyShot("05-second-generation");
  },
};
