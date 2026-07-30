// Journey: MEDIC CRAFT — the component-based medical crafting tree in the four-phase craft
// window (the owner's money shot). Grants a medic + Field Multitool + the four
// stimpak components, then:
//   BROWSE the COMPONENTS tab (BEC / Liquid Suspension / CRDM / Solid Delivery
//   Shell) → BROWSE the SUPPLIES tab (Advanced Stimpak + basic + buff + anti-state)
//   → craft the ADVANCED STIMPAK from the four components through every phase
//   (SLOTS best-fit → ASSEMBLE → EXPERIMENT → CREATE PROTOTYPE).
// Component quality carries into the product (craft_slot_stats) — the component-quality carry-through.
import { ITEM, openInventoryContextAction } from "./_helpers.mjs";

// Current medic-crafting item ids used by the isolated verification fixture.
const BEC = 1201;
const LIQUID_SUSPENSION = 1202;
const CRDM = 1203;
const SOLID_DELIVERY_SHELL = 1204;
const ADVANCED_STIMPAK = 1007;
const COMPONENT_QUALITY = 820; // variant IS the crafted quality (0..1000)
const RECIPE = "advanced_stimpak";

export default {
  id: "medic-craft",
  title: "Medic craft — component-quality tree → Advanced Stimpak",
  timeoutMs: 140000,
  characters: [{ role: "primary", id: "h3d-medic-probe", name: "ProbeMedic", x: 512, y: 512, initialProfessionId: "medic" }],
  async arm(ctx) {
    await ctx.debugCommand({
      DebugGrantSkillBoxes: {
        skill_box_ids: [
          "medic-medical-crafting-i",
          "medic-medical-crafting-ii",
          "medic-medical-crafting-iii",
          "medic-medical-crafting-iv",
        ],
      },
    });
    await ctx.debugCommand({ DebugGiveItem: { item_id: ITEM.fieldMultitool, variant_id: 0, quantity: 1 } });
    for (const id of [BEC, LIQUID_SUSPENSION, CRDM, SOLID_DELIVERY_SHELL]) {
      await ctx.debugCommand({ DebugGiveItem: { item_id: id, variant_id: COMPONENT_QUALITY, quantity: 2 } });
    }
    ctx.note("Medic starter allocation/tool + medical-crafting IV + 4 stimpak components @Q820");
  },
  async run(ctx) {
    const s = ctx.primary;

    // Robustly switch a category tab and confirm it latched (aria-selected).
    // The tab nav can overflow, so scroll the tab into view before clicking.
    const selectTab = async (cat) => {
      const tab = s.page.locator(`.scp-tab[data-cat="${cat}"]`);
      for (let attempt = 0; attempt < 6; attempt += 1) {
        await tab.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
        await tab.click({ timeout: 4000, force: true }).catch(() => {});
        await ctx.delay(400);
        if (await s.page.locator(`.scp-tab[data-cat="${cat}"][aria-selected="true"]`).count() > 0) return true;
      }
      return false;
    };
    const recipeIds = async () => s.page.$$eval(".scp-craft-recipe", (els) =>
      els.map((e) => `${e.dataset.recipeId}${e.hasAttribute("data-locked") ? "(locked)" : ""}`));

    // ── BROWSE: the component tree on camera ────────────────────────────────
    await openInventoryContextAction(s, ITEM.fieldMultitool, "craft");
    await s.waitDom('.sc3d-window[data-window="craft"]', { state: "visible", timeoutMs: 8000 });
    await s.waitDom(".scp-craft-recipe", { state: "visible", timeoutMs: 12000 });

    // COMPONENTS tab: the four sub-components (BEC / LS / CRDM / Shell).
    s.assert(await selectTab("component"), "COMPONENTS tab never latched");
    ctx.note(`components tab: ${(await recipeIds()).join(", ")}`);
    s.assert((await s.page.locator(".scp-craft-recipe").count()) >= 4, "component tree missing from the craft window");
    await ctx.moneyShot("00-component-tree");

    // SUPPLIES tab: stimpaks + buff packs + anti-state (best-effort money shot;
    // if the tab clips off-nav we still select via the always-visible ALL tab).
    if (await selectTab("supply")) {
      ctx.note(`supplies tab: ${(await recipeIds()).join(", ")}`);
      await ctx.moneyShot("01-supplies-tab");
    } else {
      ctx.note("supplies tab did not latch (nav overflow) — selecting via ALL");
    }
    // ALL tab reliably lists every recipe including the Advanced Stimpak.
    s.assert(await selectTab("all"), "ALL tab never latched");
    ctx.note(`all tab: ${(await recipeIds()).join(", ")}`);

    // ── Select Advanced Stimpak and begin assembly ─────────────────────────
    const advRow = `.scp-craft-recipe[data-recipe-id="${RECIPE}"]`;
    await s.waitDom(advRow, { state: "visible", timeoutMs: 8000 });
    const advLoc = s.page.locator(advRow);
    await advLoc.scrollIntoViewIfNeeded({ timeout: 4000 }).catch(() => {});
    await advLoc.click({ timeout: 8000, force: true });
    await ctx.delay(300);
    await s.waitDom('.scp-craft-browse [data-ref="begin"]:not([disabled])', { state: "attached", timeoutMs: 8000 });
    await ctx.moneyShot("02-advanced-selected");
    await s.click('.scp-craft-browse [data-ref="begin"]');

    // ── SLOTS: fill all four component slots via best-fit ───────────────────
    await s.waitDom('[data-ref="slotsSurface"]:not([hidden])', { state: "attached", timeoutMs: 10000 });
    await s.waitDom(".scp-craft-opt", { state: "visible", timeoutMs: 8000 });
    let assembleReady = false;
    for (let attempt = 0; attempt < 8 && !assembleReady; attempt += 1) {
      const rec = s.page.locator(".scp-craft-opt[data-recommended]").first();
      if (await rec.count() > 0) {
        await rec.dblclick({ timeout: 6000 }).catch(() => {});
      } else {
        await s.page.locator(".scp-craft-opt").first().dblclick({ timeout: 6000 }).catch(() => {});
      }
      await ctx.delay(800);
      assembleReady = await s.page.locator('[data-ref="assemble"]:not([disabled])').count() > 0;
    }
    ctx.note(`component slots filled; assemble ready=${assembleReady}`);
    await ctx.moneyShot("03-component-slots");
    s.assert(assembleReady, "ASSEMBLE never armed — component slot assignment failed");

    // ── ASSEMBLE ────────────────────────────────────────────────────────────
    await s.click('[data-ref="assemble"]');
    await s.waitDom('[data-ref="finishSurface"]:not([hidden])', { state: "attached", timeoutMs: 12000 });
    await ctx.delay(400);
    await ctx.moneyShot("04-assembled");

    // ── EXPERIMENT (push the potency line toward its component-defined cap) ──
    for (let i = 0; i < 3; i += 1) {
      const plus = s.page.locator('.scp-craft-line button[data-spend="+"]:not([disabled])').first();
      if (await plus.count() === 0) break;
      await plus.click({ timeout: 6000 }).catch(() => {});
      await ctx.delay(150);
    }
    const expBtn = s.page.locator('[data-ref="exitExperiment"]:not([disabled])');
    if (await expBtn.count() > 0) {
      await expBtn.click({ timeout: 6000 }).catch(() => {});
      ctx.note("experimented on the advanced-stimpak potency line");
      await ctx.delay(800);
    }
    await ctx.moneyShot("05-experiment");

    // ── CREATE PROTOTYPE ────────────────────────────────────────────────────
    await s.waitDom('[data-ref="toFinish"]:not([disabled])', { state: "attached", timeoutMs: 8000 });
    await s.click('[data-ref="toFinish"]');
    await s.waitDom('[data-ref="finishGo"]:not([disabled])', { state: "attached", timeoutMs: 8000 });
    await s.click('[data-ref="finishGo"]');
    const crafted = await s.waitProbeCall(
      () => s.oracle(),
      (o) => (o.inventory ?? []).some((r) => r.itemId === ADVANCED_STIMPAK && String(r.container).startsWith("h3d-medic-probe") && (r.available ?? 0) > 0),
      { label: "advanced stimpak in inventory", timeoutMs: 12000 },
    );
    const stim = crafted.inventory.find((r) => r.itemId === ADVANCED_STIMPAK && String(r.container).startsWith("h3d-medic-probe"));
    // Decode the encoded medical variant: 41_000_000 + kind*1e6 + potency*1e3 + qty.
    const encoded = stim.variantId - 41_000_000;
    const potency = Math.floor((encoded % 1_000_000) / 1_000);
    ctx.note(`ADVANCED STIMPAK crafted: ${stim.itemId}@${stim.variantId} x${stim.available} — potency ${potency}`);
    s.assert(potency >= 180 && potency <= 350, `advanced stimpak potency ${potency} outside its floor/ceiling`);
    s.assert(potency > 160, `advanced stimpak (${potency}) must out-heal a max basic stimpak (160)`);
    await ctx.moneyShot("06-advanced-stimpak-crafted");
  },
};
