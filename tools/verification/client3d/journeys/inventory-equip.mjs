// Journey: inventory-backed weapon equip. Drives the real INVENTORY window
// (server-backed stacks only), equips ranged + melee weapons from rows, and
// proves authority receipts plus held-model/swing behavior.
import { ITEM, waitHostile, acquireTarget, approachHostile, fightToKill } from "./_helpers.mjs";

const SLUGTHROWER_ITEM_ID = 3101;
const CRAFTED_SLUGTHROWER_VARIANT = 101_080_090; // P70 / H80 / R90

async function openInventory(s) {
  const inventory = s.page.locator('.sc3d-window[data-window="inventory"]');
  if (await inventory.isVisible().catch(() => false)) return;
  await s.press("KeyI");
  await s.waitDom('.sc3d-window[data-window="inventory"]', { state: "visible", timeoutMs: 10000 });
}

async function closeInventory(s) {
  const inventory = s.page.locator('.sc3d-window[data-window="inventory"]');
  if (!await inventory.isVisible().catch(() => false)) return;
  await s.press("KeyI");
  await s.waitDom('.sc3d-window[data-window="inventory"]', { state: "hidden", timeoutMs: 10000 });
}

async function rowSnapshot(s) {
  return s.page.evaluate(() => [...document.querySelectorAll(".inv-slot")].map((el) => ({
    key: el.getAttribute("data-key"),
    itemId: el.getAttribute("data-item-id"),
    variantId: el.getAttribute("data-variant-id"),
    category: el.getAttribute("data-cat"),
    title: el.querySelector(".inv-slot-title")?.textContent?.trim() ?? "",
    equipped: el.hasAttribute("data-equipped"),
  })));
}
async function equipFromInventory(ctx, s, itemId, weaponId, label, expectedVariantId = 0) {
  const selector = `.inv-slot[data-item-id="${itemId}"][data-variant-id="${expectedVariantId}"]`;
  await s.waitDom(selector, { state: "visible", timeoutMs: 12000 });
  const initiallyEquipped = await s.page.locator(selector).first().evaluate((el) => el.hasAttribute("data-equipped"));
  if (initiallyEquipped) {
    await s.dblclick(selector);
    await s.waitProbeCall(
      () => rowSnapshot(s),
      (rows) => rows.find((candidate) => candidate.itemId === String(itemId) && candidate.variantId === String(expectedVariantId))?.equipped === false,
      { timeoutMs: 8000, label: `${label} pre-clear from initially equipped row` },
    );
  }
  const before = await s.probe();
  await s.dblclick(selector);
  const receiptProbe = await s.waitProbe(
    (probe) => (probe.acceptedCommands ?? 0) > (before.acceptedCommands ?? 0)
      || (probe.rejectedCommands ?? 0) > (before.rejectedCommands ?? 0),
    { timeoutMs: 8000, label: `${label} equip receipt` },
  );
  s.assert(
    (receiptProbe.acceptedCommands ?? 0) > (before.acceptedCommands ?? 0),
    `${label} equip rejected: status=${receiptProbe.status}; receipts=${JSON.stringify(receiptProbe.authorityReceiptTail ?? [])}`,
  );
  const oracleAfterReceipt = await s.oracle().catch(() => null);
  ctx.note(`${label}: oracle weapon after receipt ${JSON.stringify(oracleAfterReceipt?.actors?.[s.actorId]?.weapon ?? null)}`);
  await s.waitProbeCall(
    () => s.oracle(),
    (oracle) => oracle?.actors?.[s.actorId]?.weapon?.weaponId === weaponId
      && Number(oracle.actors[s.actorId].weapon.weaponItemId ?? 0) === itemId
      && Number(oracle.actors[s.actorId].weapon.weaponVariantId ?? 0) === expectedVariantId,
    { timeoutMs: 8000, label: `${label} authority weapon state exact variant ${expectedVariantId}` },
  );
  const rows = await rowSnapshot(s);
  const row = rows.find((candidate) => candidate.itemId === String(itemId) && candidate.variantId === String(expectedVariantId));
  s.assert(row?.equipped === true, `${label} exact variant row did not render equipped; rows=${JSON.stringify(rows)}`);
  ctx.note(`${label}: authority-backed row ${row.key} equipped as ${weaponId}/${itemId}/variant-${expectedVariantId}`);
}

async function swingOnce(ctx, s, label, shotName) {
  await closeInventory(s);
  await s.slash("/attack basic_shot $target");
  const swing = await s.waitProbe(
    (probe) => String(probe.activeClipsByLayer?.montage ?? "").startsWith("swing_"),
    { timeoutMs: 8000, label: `${label} melee swing montage` },
  );
  ctx.note(`${label} montage -> ${swing.activeClipsByLayer.montage}`);
  await ctx.moneyShot(shotName);
  await s.page.waitForTimeout(1700);
}

export default {
  id: "inventory-equip",
  title: "Inventory equip — authority-backed melee + ranged rows",
  timeoutMs: 150000,
  characters: [{ role: "primary", id: "h3d-equip-probe", name: "ProbeEquip", x: 589, y: 512, initialProfessionId: "marksman" }],
  async arm(ctx) {
    const slug = await ctx.debugCommand({ DebugGiveItem: { item_id: SLUGTHROWER_ITEM_ID, variant_id: CRAFTED_SLUGTHROWER_VARIANT, quantity: 1, equip: false } });
    const sword = await ctx.debugCommand({ DebugGiveItem: { item_id: ITEM.vibrosword, variant_id: 0, quantity: 1, equip: false } });
    const fieldSaber = await ctx.debugCommand({ DebugGiveItem: { item_id: ITEM.fieldSaber, variant_id: 0, quantity: 1, equip: false } });
    const quarryChopper = await ctx.debugCommand({ DebugGiveItem: { item_id: ITEM.quarryChopper, variant_id: 0, quantity: 1, equip: false } });
    await ctx.debugCommand({ DebugGrantSkillBoxes: { skill_box_ids: [
      "marksman-rifle-iii",
      "brawler-novice",
      "brawler-melee-i",
      "brawler-melee-ii",
      "brawler-melee-iii",
    ] } });
    ctx.note(`give crafted slugthrower -> ${JSON.stringify(slug.receipt ?? slug.error ?? "?")}`);
    ctx.note(`give vibrosword -> ${JSON.stringify(sword.receipt ?? sword.error ?? "?")}`);
    ctx.note(`give Field Saber -> ${JSON.stringify(fieldSaber.receipt ?? fieldSaber.error ?? "?")}`);
    ctx.note(`give Quarry Chopper -> ${JSON.stringify(quarryChopper.receipt ?? quarryChopper.error ?? "?")}`);
  },
  async run(ctx) {
    const s = ctx.primary;
    const startupActor = (await s.oracle())?.actors?.[s.actorId] ?? null;
    ctx.note(`startup profession state -> ${JSON.stringify({
      professionIds: startupActor?.professionIds ?? [],
      skillBoxIds: startupActor?.skillBoxIds ?? [],
      professions: startupActor?.professions ?? [],
    })}`);
    await openInventory(s);
    await equipFromInventory(ctx, s, SLUGTHROWER_ITEM_ID, "slugthrower", "Crafted Slugthrower", CRAFTED_SLUGTHROWER_VARIANT);
    await s.waitProbe((probe) => probe.muzzleWorld !== null, { timeoutMs: 8000, label: "Slugthrower held model / muzzle" });
    const craftedRow = `.inv-slot[data-item-id="${SLUGTHROWER_ITEM_ID}"][data-variant-id="${CRAFTED_SLUGTHROWER_VARIANT}"]`;
    await s.page.locator(craftedRow).click({ button: "right" });
    await s.page.locator('.sc3d-radial:not([hidden]) .sc3d-radial-item[data-action="examine"]').click({ timeout: 6000 });
    await s.waitDom('.sc3d-window[data-window="examine"]', { state: "visible", timeoutMs: 8000 });
    await s.waitProbeCall(
      () => s.page.locator('.sc3d-window[data-window="examine"] [data-ref="stats"]').innerText(),
      (text) => text.includes("Power") && text.includes("Range · point / ideal / max") && text.includes("Authority-resolved"),
      { timeoutMs: 8000, label: "crafted Slugthrower examine stat rows" },
    );
    const statText = await s.page.locator('.sc3d-window[data-window="examine"] [data-ref="stats"]').innerText();
    for (const label of ["Power", "Handling", "Reliability", "Range · point / ideal / max", "Damage · cadence · accuracy · reload", "Authority-resolved"]) {
      s.assert(statText.includes(label), `crafted Slugthrower examine missing ${label}: ${statText}`);
    }
    s.assert(!statText.includes("Durability capacity"), `crafted Slugthrower examine leaked legacy durability: ${statText}`);
    ctx.note(`crafted Slugthrower P70/H80/R90 examine: ${statText.replaceAll("\\n", " | ")}`);
    await ctx.moneyShot("01-slugthrower-stats");
    await s.press("Escape");

    await openInventory(s);
    await equipFromInventory(ctx, s, ITEM.fieldSaber, "field-saber", "Field Saber");

    await waitHostile(ctx, s);
    const acquired = await acquireTarget(ctx, s);
    const targetId = acquired.selectedActorId;
    await approachHostile(ctx, s, 1.4);
    await swingOnce(ctx, s, "Field Saber", "02-field-saber-swing");

    await openInventory(s);
    await equipFromInventory(ctx, s, ITEM.quarryChopper, "quarry-chopper", "Quarry Chopper");
    await swingOnce(ctx, s, "Quarry Chopper", "03-quarry-chopper-swing");

    await openInventory(s);
    await equipFromInventory(ctx, s, ITEM.vibrosword, "vibrosword", "Vibrosword");
    await closeInventory(s);
    await ctx.moneyShot("04-vibrosword-equipped");

    const result = await fightToKill(ctx, s, targetId, { meleeRange: 1.8, timeoutMs: 70000 });
    ctx.note(`vibrosword swing -> killed=${result.killed} sawMyHit=${result.sawMyHit} downedDelta=${result.downedDelta}`);
    await ctx.moneyShot("05-vibrosword-swing");
    s.assert(result.sawMyHit, "vibrosword inventory equip produced no player melee swing/hit events");
  },
};
