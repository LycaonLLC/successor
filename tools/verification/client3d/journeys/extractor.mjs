// Journey: extractor lifecycle — place → crank (manual) → battery → collect →
// pack up. Grants the Personal Mineral Sampler (item 3006) + a battery, drives the authority
// verbs, and reads placedExtractors mode/hopper/battery from the probe.
// Money shots: placed, cranking, battery running, collected/packed.
import { ITEM, findInventoryStack } from "./_helpers.mjs";

export default {
  id: "extractor",
  title: "Extractor place/crank/battery/collect/packup",
  timeoutMs: 120000,
  characters: [{ role: "primary", id: "h3d-extract-probe", name: "ProbeExtract", x: 512, y: 512, initialProfessionId: "craftsman" }],
  async arm(ctx) {
    const tool = await ctx.debugCommand({ DebugGiveItem: { item_id: ITEM.metalExtractor, variant_id: 0, quantity: 1 } }); // 3006 Personal Mineral Sampler (id kept)
    // Battery variant encodes runtime seconds: EXTRACTOR_BATTERY_VARIANT_BASE
    // (32_000_000) + seconds. Variant 0 decodes to 0 runtime -> missing_battery.
    const batt = await ctx.debugCommand({ DebugGiveItem: { item_id: 3201, variant_id: 32003600, quantity: 1 } });
    ctx.note(`give extractor ${JSON.stringify(tool.receipt ?? tool.error)} + battery ${JSON.stringify(batt.receipt ?? batt.error)}`);
  },
  async run(ctx) {
    const s = ctx.primary;
    await ctx.moneyShot("00-spawn");

    // PLACE — a server-owned extractor appears (idle).
    await s.slash("/place-extractor iron");
    const placed = await s.waitProbe(
      (p) => (p.placedExtractors ?? []).some((e) => e.isOwner),
      { label: "extractor placed", timeoutMs: 10000 },
    );
    const mine = placed.placedExtractors.find((e) => e.isOwner);
    const extractorId = mine.extractorId; // sim derives the id (not from actor id)
    ctx.note(`placed ${extractorId} mode=${mine.mode} hopper=${mine.hopperPct}`);
    s.assert(mine.mode === "idle", `fresh extractor should be idle, got ${mine.mode}`);
    await ctx.moneyShot("01-placed");

    // CRANK — manual extraction.
    await s.slash(`/crank ${extractorId}`);
    const cranking = await s.waitProbe(
      (p) => (p.placedExtractors ?? []).some((e) => e.isOwner && e.mode === "manual"),
      { label: "extractor cranking", timeoutMs: 10000 },
    );
    ctx.note(`cranking mode=${cranking.placedExtractors.find((e) => e.isOwner).mode}`);
    await ctx.moneyShot("02-cranking");
    await s.slash("/stop-crank");
    // Manual crank must release (idle) before a battery can be inserted.
    await s.waitProbe(
      (p) => (p.placedExtractors ?? []).some((e) => e.isOwner && e.mode === "idle"),
      { label: "crank released to idle", timeoutMs: 8000 },
    ).catch(() => ctx.note("crank did not report idle before battery insert"));

    // BATTERY — insert the crafted battery for autonomous extraction.
    const battStack = await findInventoryStack(s, 3201);
    s.assert(battStack, `no battery stack found to insert`);
    ctx.note(`battery stack ${JSON.stringify(battStack)}`);
    await s.slash(`/insert-battery ${extractorId} ${battStack.container} ${battStack.stackId} ${battStack.variantId}`);
    const powered = await s.waitProbe(
      (p) => (p.placedExtractors ?? []).some((e) => e.isOwner && e.mode === "battery"),
      { label: "extractor on battery", timeoutMs: 10000 },
    ).catch(async () => {
      const p = await s.probe();
      ctx.note(`battery insert failed; rejects=${JSON.stringify((p.rejectLog ?? []).slice(-3))} mode=${(p.placedExtractors ?? []).find((e) => e.isOwner)?.mode}`);
      throw new (await import("../lib/browser.mjs")).JourneyAssertionError(`[extractor] battery did not engage: ${JSON.stringify((p.rejectLog ?? []).slice(-1))}`);
    });
    const batt = powered.placedExtractors.find((e) => e.isOwner);
    ctx.note(`battery mode=${batt.mode} batteryPct=${batt.batteryPct} hopper=${batt.hopperPct}`);
    await ctx.moneyShot("03-battery");

    // COLLECT — hopper yield to inventory.
    await ctx.delay(3000);
    const invBefore = (await s.probe()).inventoryRows;
    await s.slash(`/collect-extractor ${extractorId}`);
    await ctx.delay(1500);
    const afterCollect = await s.probe();
    ctx.note(`collect invRows ${invBefore} -> ${afterCollect.inventoryRows}`);
    await ctx.moneyShot("04-collected");

    // PACK UP — destroy/pickup the extractor; the world prop clears.
    await s.slash(`/destroy-extractor ${extractorId}`);
    const packed = await s.waitProbe(
      (p) => !(p.placedExtractors ?? []).some((e) => e.isOwner),
      { label: "extractor packed up", timeoutMs: 10000 },
    );
    ctx.note(`packed up; placedExtractors owner-count ${(packed.placedExtractors ?? []).filter((e) => e.isOwner).length}`);
    await ctx.moneyShot("05-packed");
  },
};
