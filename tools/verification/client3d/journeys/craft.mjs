// Journey: CRAFT four-phase window (the earlier sandbox design bench). Grants craftsman + tool +
// resources, then drives the REAL craft window through every phase:
//   BROWSE (known recipes) → SLOTS (best-fit recommendation) → ASSEMBLE →
//   FINISH (experiment) → CREATE PROTOTYPE.
// Each phase is a codified live-proof step with a money shot. Asserts against
// the window's own phase surfaces + the crafted output landing in inventory.
import { ITEM, openInventoryContextAction } from "./_helpers.mjs";

const COPPER = 2007;
const RECIPE = "metal_extractor"; // 2 slots: iron structural frame + copper conductor

export default {
  id: "craft",
  title: "Craft four-phase window",
  timeoutMs: 130000,
  characters: [{ role: "primary", id: "h3d-craft-probe", name: "ProbeCraft", x: 512, y: 512, initialProfessionId: "craftsman" }],
  async arm(ctx) {
    await ctx.debugCommand({ DebugGiveItem: { item_id: ITEM.fieldMultitool, variant_id: 0, quantity: 1 } });
    await ctx.debugCommand({ DebugGiveItem: { item_id: ITEM.ironOre, variant_id: 7, quantity: 100 } });
    await ctx.debugCommand({ DebugGiveItem: { item_id: COPPER, variant_id: 11, quantity: 100 } });
    ctx.note("Craftsman explicit Field Multitool + 100 iron + 100 copper");
  },
  async run(ctx) {
    const s = ctx.primary;

    // ── BROWSE ─────────────────────────────────────────────────────────────
    await openInventoryContextAction(s, ITEM.fieldMultitool, "craft");
    await s.waitDom('.sc3d-window[data-window="craft"]', { state: "visible", timeoutMs: 8000 });
    await s.waitDom(".scp-craft-recipe", { state: "visible", timeoutMs: 12000 });
    const recipeCount = await s.page.locator(".scp-craft-recipe").count();
    ctx.note(`browse: ${recipeCount} known recipe(s)`);
    s.assert(recipeCount > 0, "no known recipes in the craft browser after training craftsman");

    // Select the Personal Mineral Sampler and verify both needs before beginning.
    await s.click(`.scp-craft-recipe[data-recipe-id="${RECIPE}"]`);
    await s.waitDom(`.scp-craft-recipe[data-recipe-id="${RECIPE}"][data-selected]`, { state: "attached", timeoutMs: 8000 });
    await s.waitDom('.scp-craft-browse [data-ref="begin"]:not([disabled])', { state: "attached", timeoutMs: 8000 });
    await s.waitDom(".scp-craft-req-material", { state: "visible", timeoutMs: 8000 });
    await s.page.waitForFunction(() => {
      const text = Array.from(document.querySelectorAll(".scp-craft-req"))
        .map((el) => el.textContent ?? "")
        .join(" | ");
      return /Iron\s*\(×80\)/.test(text)
        && /100 carried/.test(text)
        && /Copper\s*\(×36\)/.test(text)
        && /READY/.test(text);
    }, null, { timeout: 8000 });
    const browseReqs = await s.page.$$eval(".scp-craft-req", (els) => els.map((el) => el.textContent ?? ""));
    s.assert(
      browseReqs.some((line) => /Iron\s*\(×80\)/.test(line) && /100 carried/.test(line) && /READY/.test(line))
        && browseReqs.some((line) => /Copper\s*\(×36\)/.test(line) && /100 carried/.test(line) && /READY/.test(line)),
      `sampler requirements did not show both owned materials: ${browseReqs.join(" | ")}`,
    );
    ctx.note("sampler requirements show Iron ×80 and Copper ×36 together, both READY");
    await ctx.moneyShot("00-browse");
    await s.click('.scp-craft-browse [data-ref="begin"]');

    // ── SLOTS (best-fit recommendation) ───────────────────────────────────
    await s.waitDom('[data-ref="slotsSurface"]:not([hidden])', { state: "attached", timeoutMs: 10000 });
    await s.waitDom(".scp-craft-opt", { state: "visible", timeoutMs: 8000 });
    const slotMaterials = await s.page.$$eval(".scp-craft-slot-material", (els) => els.map((el) => el.textContent ?? ""));
    s.assert(
      slotMaterials.includes("Iron (×80)") && slotMaterials.includes("Copper (×36)"),
      `sampler slot cards did not show both material needs: ${slotMaterials.join(" | ")}`,
    );
    // Fill through the ordinary single-click LOAD control. The authority
    // confirms each assignment before the window advances to the next slot.
    let assembleReady = false;
    for (let attempt = 0; attempt < 4 && !assembleReady; attempt += 1) {
      const load = s.page.locator(".scp-craft-opt-load:not([disabled])").first();
      s.assert(await load.count() > 0, `no enabled LOAD control on sampler slot attempt ${attempt + 1}`);
      await load.click({ timeout: 6000 });
      await ctx.delay(900);
      assembleReady = await s.page.locator('[data-ref="assemble"]:not([disabled])').count() > 0;
    }
    ctx.note(`sampler slots filled by single-click LOAD; assemble ready=${assembleReady}`);
    await ctx.moneyShot("01-slots-load-controls");
    s.assert(assembleReady, "ASSEMBLE never armed — single-click sampler slot assignment failed");

    // ── ASSEMBLE (point of no return) ─────────────────────────────────────
    await s.click('[data-ref="assemble"]');
    await s.waitDom('[data-ref="finishSurface"]:not([hidden])', { state: "attached", timeoutMs: 12000 });
    await ctx.delay(400);
    await ctx.moneyShot("02-assembled-finish");

    // ── EXPERIMENT ────────────────────────────────────────────────────────
    const plus = s.page.locator('.scp-craft-line button[data-spend="+"]:not([disabled])').first();
    if (await plus.count() > 0) {
      await plus.click({ timeout: 6000 }).catch(() => {});
      await ctx.delay(200);
      const expBtn = s.page.locator('[data-ref="exitExperiment"]:not([disabled])');
      if (await expBtn.count() > 0) {
        await expBtn.click({ timeout: 6000 }).catch(() => {});
        ctx.note("experimented one point");
        await ctx.delay(800);
      }
    }
    await ctx.moneyShot("03-experiment");

    // ── CREATE PROTOTYPE ──────────────────────────────────────────────────
    await s.waitDom('[data-ref="toFinish"]:not([disabled])', { state: "attached", timeoutMs: 8000 });
    await s.click('[data-ref="toFinish"]');
    await s.waitDom('[data-ref="finishGo"]:not([disabled])', { state: "attached", timeoutMs: 8000 });
    await s.click('[data-ref="finishGo"]');
    // The crafted sampler lands in inventory and the session returns to browse.
    const crafted = await s.waitProbeCall(
      () => s.oracle(),
      (o) => (o.inventory ?? []).some((r) => r.itemId === 3006 && String(r.container).startsWith("h3d-craft-probe") && (r.available ?? 0) > 0),
      { label: "crafted sampler in inventory", timeoutMs: 12000 },
    );
    const sampler = crafted.inventory.find((r) => r.itemId === 3006 && String(r.container).startsWith("h3d-craft-probe"));
    ctx.note(`prototype crafted: sampler ${sampler.itemId}@${sampler.variantId} x${sampler.available}`);
    await ctx.moneyShot("04-prototype");

    // ── PERSONAL INVENTORY DISCARD ────────────────────────────────────────
    // Crafting leaves 20 iron. Prove its purpose copy, then delete the exact
    // carried stack through the visible two-step ledger control.
    await s.slash("/ui inventory");
    const ironSlot = '.inv-slot[data-item-id="2001"]';
    await s.waitDom(ironSlot, { state: "visible", timeoutMs: 8000 });
    await s.click(ironSlot);
    const descriptionSelector = '.sc3d-window[data-window="inventory"] [data-ref="desc"]';
    await s.page.waitForFunction(
      (selector) => /crafting metal/i.test(document.querySelector(selector)?.textContent ?? ""),
      descriptionSelector,
      { timeout: 5000 },
    );
    const ironDescription = await s.page.locator(descriptionSelector).textContent();
    s.assert(/crafting metal/i.test(ironDescription ?? ""), `Iron Ore purpose copy missing: ${ironDescription}`);
    const discard = '.sc3d-window[data-window="inventory"] [data-ref="discardBtn"]:not([hidden])';
    await s.waitDom(discard, { state: "visible", timeoutMs: 8000 });
    await s.click(discard);
    await s.waitDom(`${discard}[data-armed]`, { state: "attached", timeoutMs: 3000 });
    await s.click(discard);
    await s.waitProbeCall(
      () => s.oracle(),
      (o) => !(o.inventory ?? []).some((r) => r.itemId === ITEM.ironOre && String(r.container).startsWith("h3d-craft-probe")),
      { label: "discarded leftover iron stack", timeoutMs: 10000 },
    );
    ctx.note("leftover Iron Ore stack discarded through two-step confirmation");
    await ctx.moneyShot("05-inventory-discarded");
  },
};
