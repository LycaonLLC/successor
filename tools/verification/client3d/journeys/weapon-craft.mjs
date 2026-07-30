// Journey: craft the master-tier Lightning Carbine through the ordinary
// four-phase crafting window. This proves the real recipe catalog, all four
// material slots, experimentation line, encoded output variant, and inventory
// settlement instead of substituting a debug-granted finished weapon.
import { ITEM, openInventoryContextAction } from "./_helpers.mjs";

const RECIPE = "lightning_carbine";
const COPPER = 2007;
const IRON = 2001;
const POLYMER = 2010;
const GAS = 2004;
const OUTPUT = 3121;
const RANGED_VARIANT_BASE = 31_000_000;

export default {
  id: "weapon-craft",
  title: "Craft Lightning Carbine — slots, experiment, prototype",
  timeoutMs: 150000,
  characters: [{
    role: "primary",
    id: "h3d-weapon-craft-probe",
    name: "WeaponCraftProbe",
    x: 512,
    y: 512,
    initialProfessionId: "craftsman",
  }],
  async arm(ctx) {
    const skill = await ctx.debugCommand({
      DebugGrantSkillBoxes: {
        skill_box_ids: [
          "craftsman-assembly-i",
          "craftsman-assembly-ii",
          "craftsman-assembly-iii",
          "craftsman-assembly-iv",
        ],
      },
    });
    await ctx.debugCommand({ DebugGiveItem: { item_id: ITEM.fieldMultitool, variant_id: 0, quantity: 1 } });
    for (const [itemId, variantId, quantity] of [
      [COPPER, 701, 18],
      [IRON, 702, 12],
      [POLYMER, 48_000_700, 10],
      [GAS, 704, 6],
    ]) {
      await ctx.debugCommand({ DebugGiveItem: { item_id: itemId, variant_id: variantId, quantity } });
    }
    ctx.note(`grant Craftsman Assembly IV -> ${JSON.stringify(skill.receipt ?? skill.error ?? "?")}; armed exact Lightning materials`);
  },
  async run(ctx) {
    const s = ctx.primary;
    await openInventoryContextAction(s, ITEM.fieldMultitool, "craft", {
      readyItemIds: [COPPER, IRON, POLYMER, GAS],
    });
    await s.waitDom('.sc3d-window[data-window="craft"]', { state: "visible", timeoutMs: 10000 });
    await s.waitDom(`.scp-craft-recipe[data-recipe-id="${RECIPE}"]`, { state: "visible", timeoutMs: 15000 });
    await s.click(`.scp-craft-recipe[data-recipe-id="${RECIPE}"]`);
    await s.waitDom(`.scp-craft-recipe[data-recipe-id="${RECIPE}"][data-selected]`, { state: "attached", timeoutMs: 8000 });
    await s.waitDom('.scp-craft-browse [data-ref="begin"]:not([disabled])', { state: "attached", timeoutMs: 8000 });

    const requirementText = await s.page.$$eval(".scp-craft-req", (elements) => elements.map((element) => element.textContent ?? ""));
    for (const expected of [
      /Copper\s*\(×18\)/,
      /Iron\s*\(×12\)/,
      /Polymer\s*\(×10\)/,
      /Gas\s*\(×6\)/,
    ]) {
      s.assert(requirementText.some((line) => expected.test(line) && /READY/.test(line)), `Lightning requirement missing or not READY: ${expected} in ${requirementText.join(" | ")}`);
    }
    ctx.note(`Lightning browse requirements: ${requirementText.join(" | ")}`);
    await ctx.moneyShot("00-lightning-recipe");
    await s.click('.scp-craft-browse [data-ref="begin"]');

    await s.waitDom('[data-ref="slotsSurface"]:not([hidden])', { state: "attached", timeoutMs: 10000 });
    let assembleReady = false;
    for (let attempt = 0; attempt < 6 && !assembleReady; attempt += 1) {
      const load = s.page.locator(".scp-craft-opt-load:not([disabled])").first();
      s.assert(await load.count() > 0, `no enabled LOAD control on Lightning slot ${attempt + 1}`);
      await load.click({ timeout: 6000 });
      await ctx.delay(900);
      assembleReady = await s.page.locator('[data-ref="assemble"]:not([disabled])').count() > 0;
    }
    s.assert(assembleReady, "Lightning ASSEMBLE never armed after loading four exact resources");
    const slots = await s.page.$$eval(".scp-craft-slot-material", (elements) => elements.map((element) => element.textContent ?? ""));
    s.assert(slots.length === 4, `Lightning published ${slots.length} slots instead of 4: ${slots.join(" | ")}`);
    ctx.note(`Lightning slots loaded: ${slots.join(" | ")}`);
    await ctx.moneyShot("01-lightning-slots");

    await s.click('[data-ref="assemble"]');
    await s.waitDom('[data-ref="finishSurface"]:not([hidden])', { state: "attached", timeoutMs: 12000 });
    const statLines = await s.page.$$eval(".scp-craft-line", (elements) => elements.map((element) => element.textContent ?? ""));
    for (const label of ["power", "handling", "reliability"]) {
      s.assert(statLines.some((line) => line.toLowerCase().includes(label)), `Lightning finish surface missing ${label}: ${statLines.join(" | ")}`);
    }
    await ctx.moneyShot("02-lightning-assembled");

    const plus = s.page.locator('.scp-craft-line button[data-spend="+"]:not([disabled])').first();
    if (await plus.count() > 0) {
      await plus.click({ timeout: 6000 });
      const finishExperiment = s.page.locator('[data-ref="exitExperiment"]:not([disabled])');
      if (await finishExperiment.count() > 0) await finishExperiment.click({ timeout: 6000 });
      await ctx.delay(800);
    }
    await ctx.moneyShot("03-lightning-experiment");

    await s.waitDom('[data-ref="toFinish"]:not([disabled])', { state: "attached", timeoutMs: 8000 });
    await s.click('[data-ref="toFinish"]');
    await s.waitDom('[data-ref="finishGo"]:not([disabled])', { state: "attached", timeoutMs: 8000 });
    await s.click('[data-ref="finishGo"]');
    const crafted = await s.waitProbeCall(
      () => s.oracle(),
      (oracle) => (oracle.inventory ?? []).some((row) => (
        Number(row.itemId) === OUTPUT
        && Number(row.variantId ?? 0) >= RANGED_VARIANT_BASE
        && String(row.container).startsWith(s.actorId)
        && Number(row.available ?? row.quantity ?? 0) === 1
      )),
      { label: "crafted Lightning Carbine encoded variant in inventory", timeoutMs: 12000 },
    );
    const row = crafted.inventory.find((candidate) => Number(candidate.itemId) === OUTPUT && String(candidate.container).startsWith(s.actorId));
    const encodedVariant = Number(row?.variantId) - 31_000_000;
    const craftedStats = {
      power: Math.min(100, Math.floor(encodedVariant / 1_000_000)),
      handling: Math.min(100, Math.floor(encodedVariant / 1_000) % 1_000),
      reliability: Math.min(100, encodedVariant % 1_000),
    };
    s.assert(row?.item === "Lightning Carbine", `crafted item name mismatch: ${JSON.stringify(row ?? null)}`);
    s.assert(
      Number.isInteger(encodedVariant)
        && encodedVariant >= 0
        && Object.values(craftedStats).every((value) => Number.isInteger(value) && value > 0),
      `crafted Lightning Carbine variant does not encode positive P/H/R stats: ${JSON.stringify({ row, craftedStats })}`,
    );
    ctx.note(`crafted Lightning Carbine item ${row.itemId}@${row.variantId} P${craftedStats.power}/H${craftedStats.handling}/R${craftedStats.reliability} x${row.available ?? row.quantity}`);
    await ctx.moneyShot("04-lightning-prototype");
  },
};
