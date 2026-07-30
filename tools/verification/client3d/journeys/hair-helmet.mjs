// Journey: hair is saved character APPEARANCE, never inventory headwear.
// Equipping a cranium helmet leaves the same hair mesh attached; unequipping
// the helmet also leaves hair unchanged. Proven through the local pawn's live
// attached-mesh probe plus the authority-backed Combat Helm inventory row.
const HELMET_ITEM_ID = 7103; // canonical loot-table Combat Helm
const HELMET_EQUIPMENT_ID = "helmet_s2"; // shipped cranium attachment

const hairIds = (ids) => (ids ?? []).filter((id) => typeof id === "string" && id.startsWith("hair_")).sort();

async function inventoryRow(s, selector) {
  return s.page.locator(selector).first().evaluate((el) => ({
    key: el.getAttribute("data-key") ?? "",
    itemId: el.getAttribute("data-item-id") ?? "",
    title: el.querySelector(".inv-slot-title")?.textContent?.trim() ?? "",
    equipped: el.hasAttribute("data-equipped"),
  }));
}

async function renderedEquipmentSnapshot(s) {
  const [probe, client] = await Promise.all([
    s.probe(),
    s.page.evaluate(() => {
      const actorId = window.__successor3d?.playerActorId;
      const rawCache = actorId ? localStorage.getItem(`successor3d.appearance.${actorId}`) : null;
      let cache = null;
      try {
        cache = rawCache ? JSON.parse(rawCache) : null;
      } catch {
        cache = null;
      }
      return {
        paperDollEquipmentIds: window.__successor3dInventoryPaperDollEquipmentIds ?? [],
        cacheEquipmentIds: cache?.equipmentIds ?? [],
      };
    }),
  ]);
  return {
    world: probe?.localEquipmentIds ?? [],
    paperDoll: client.paperDollEquipmentIds,
    cache: client.cacheEquipmentIds,
  };
}

export default {
  id: "hair-helmet",
  title: "Hair appearance stays independent from helmet inventory",
  timeoutMs: 120000,
  characters: [{ role: "primary", id: "h3d-hair-probe", name: "ProbeHair", x: 516, y: 512, initialProfessionId: "brawler" }],
  async arm(ctx) {
    const give = await ctx.debugCommand({
      DebugGiveItem: { item_id: HELMET_ITEM_ID, variant_id: 0, quantity: 1, equip: false },
    });
    ctx.note(`authority grant Combat Helm ${HELMET_ITEM_ID} -> ${JSON.stringify(give.receipt ?? give.error ?? give)}`);
  },
  async run(ctx) {
    const s = ctx.primary;

    // 0. Saved appearance hair rides the pawn independently at spawn.
    const spawn = await s.waitProbe(
      (p) => Array.isArray(p.localEquipmentIds) && hairIds(p.localEquipmentIds).length > 0,
      { label: "saved appearance hair attached at spawn", timeoutMs: 20000 },
    );
    const hairAtSpawn = hairIds(spawn.localEquipmentIds);
    ctx.note(`spawn localEquipmentIds=${JSON.stringify(spawn.localEquipmentIds)}`);
    s.assert(!spawn.localEquipmentIds.includes(HELMET_EQUIPMENT_ID), "no helmet expected on the pawn at spawn");
    await ctx.moneyShot("00-hair-visible");

    // 1. Equip canonical Combat Helm 7103 from its REAL authority inventory row.
    await s.slash("/ui inventory");
    await s.waitDom('.sc3d-window[data-window="inventory"]', { state: "visible", timeoutMs: 8000 });
    const slot = `.inv-slot[data-item-id="${HELMET_ITEM_ID}"]`;
    await s.waitDom(slot, { state: "visible", timeoutMs: 8000 });
    const grantedRow = await inventoryRow(s, slot);
    s.assert(
      grantedRow.itemId === String(HELMET_ITEM_ID) && grantedRow.key.includes(`:field-pack:${HELMET_ITEM_ID}:`),
      `Combat Helm was not backed by the actor authority inventory row: ${JSON.stringify(grantedRow)}`,
    );
    s.assert(!grantedRow.equipped, `Combat Helm unexpectedly equipped before UI action: ${JSON.stringify(grantedRow)}`);
    ctx.note(`authority inventory row=${JSON.stringify(grantedRow)}`);
    const initialRendered = await s.waitProbeCall(
      () => renderedEquipmentSnapshot(s),
      (snapshot) => hairAtSpawn.every((id) => snapshot.world.includes(id)
        && snapshot.paperDoll.includes(id)
        && snapshot.cache.includes(id))
        && !snapshot.world.includes(HELMET_EQUIPMENT_ID)
        && !snapshot.paperDoll.includes(HELMET_EQUIPMENT_ID)
        && !snapshot.cache.includes(HELMET_EQUIPMENT_ID),
      { label: "initial hair meshes agree across world, paper doll, and cache", timeoutMs: 12000 },
    );
    ctx.note(`initial rendered equipment=${JSON.stringify(initialRendered)}`);
    await s.dblclick(slot);

    // 2. Helmet ON → helmet and saved appearance hair coexist.
    const helmeted = await s.waitProbeCall(
      () => renderedEquipmentSnapshot(s),
      (snapshot) => [snapshot.world, snapshot.paperDoll, snapshot.cache].every(
        (ids) => ids.includes(HELMET_EQUIPMENT_ID)
          && JSON.stringify(hairIds(ids)) === JSON.stringify(hairAtSpawn),
      ),
      { label: "helmet and hair attached on world pawn, paper doll, and cache", timeoutMs: 12000 },
    );
    ctx.note(`helmeted with saved hair rendered equipment=${JSON.stringify(helmeted)}`);
    const equippedRow = await inventoryRow(s, slot);
    s.assert(equippedRow.equipped, `Combat Helm authority row did not render equipped: ${JSON.stringify(equippedRow)}`);
    ctx.note(`equipped authority inventory row=${JSON.stringify(equippedRow)}`);
    await ctx.moneyShot("01-helmet-and-hair-visible");

    // 3. Unequip the helmet through the same authority-backed inventory row.
    await s.dblclick(slot);

    // 4. Helmet OFF → saved appearance hair remains attached and unchanged.
    const bare = await s.waitProbeCall(
      () => renderedEquipmentSnapshot(s),
      (snapshot) => [snapshot.world, snapshot.paperDoll, snapshot.cache].every(
        (ids) => JSON.stringify(hairIds(ids)) === JSON.stringify(hairAtSpawn)
          && !ids.includes(HELMET_EQUIPMENT_ID),
      ),
      { label: "helmet removed from world pawn, paper doll, and cache with hair unchanged", timeoutMs: 12000 },
    );
    const hairAfter = hairIds(bare.world);
    ctx.note(`unhelmeted rendered equipment=${JSON.stringify(bare)}`);
    const unequippedRow = await inventoryRow(s, slot);
    s.assert(!unequippedRow.equipped, `Combat Helm authority row remained equipped: ${JSON.stringify(unequippedRow)}`);
    ctx.note(`unequipped authority inventory row=${JSON.stringify(unequippedRow)}`);
    await ctx.moneyShot("02-helmet-off-hair-still-visible");

    // The saved hair is not consumed by the round-trip: identical before/after.
    s.assert(
      JSON.stringify(hairAtSpawn) === JSON.stringify(hairAfter),
      `saved hair changed across the helmet round-trip: ${hairAtSpawn.join(",")} → ${hairAfter.join(",")}`,
    );
    ctx.note(`independent slots proven: hair [${hairAtSpawn.join(",")}] persists before, during, and after ${HELMET_EQUIPMENT_ID}`);
  },
};
