import fs from "node:fs";

const itemModels = JSON.parse(
  fs.readFileSync(
    new URL("../../../../client-3d/src/ui/inventory/itemModels.json", import.meta.url),
    "utf8",
  ),
);
const STATIC_MODEL_BY_ITEM_ID = new Map(
  Object.entries(itemModels)
    .filter(([itemId, modelPath]) => itemId !== "_comment" && typeof modelPath === "string")
    .map(([itemId, modelPath]) => [Number(itemId), modelPath]),
);
const CREATOR_CLOTHING_ITEM_IDS = Array.from({ length: 35 }, (_, index) => 7301 + index);
const ALL_ITEM_IDS = [
  ...STATIC_MODEL_BY_ITEM_ID.keys(),
  ...CREATOR_CLOTHING_ITEM_IDS,
].sort((left, right) => left - right);
const GRANT_ITEM_IDS = ALL_ITEM_IDS.filter((itemId) => itemId !== 5001);
const UNKNOWN_ITEM_MODEL_PATH = "/assets/world-items/supply_cache.glb";
const DOCK_LABELS = ["CHARACTER", "INVENTORY", "DATAPAD", "SKILLS", "ACTIONS", "MACROS", "OPTIONS", "ASSOCIATION"];
const SHOT_BY_INDEX = {
  0: "00-inventory-models-top",
  31: "01-inventory-models-resources-tools",
  63: "02-inventory-models-seeds-produce",
  82: "03-inventory-models-loot-gear",
  115: "04-inventory-models-gloves",
  123: "05-inventory-models-currency-bottom",
};

export default {
  id: "inventory-models",
  title: "Every inventory item renders its GLB turntable model",
  headed: true,
  timeoutMs: 300000,
  // Keep a ranged weapon equipped so the Personal Shield Generator remains an
  // inventory model instead of being auto-consumed by the melee shield system.
  characters: [{ role: "primary", id: "h3d-model-probe", name: "ProbeModels", x: 522, y: 512, initialProfessionId: "marksman" }],

  async arm(ctx) {
    for (const itemId of GRANT_ITEM_IDS) {
      const lootVariant = (itemId >= 7101 && itemId <= 7104) || (itemId >= 7201 && itemId <= 7204);
      const result = await ctx.debugCommand({
        DebugGiveItem: {
          item_id: itemId,
          variant_id: lootVariant ? 61_000_500 : 0,
          quantity: 1,
          equip: false,
        },
      });
      ctx.primary.assert(
        result?.receipt?.accepted === true,
        `authority rejected inventory-model grant ${itemId}: ${result?.receipt?.reasonCode ?? "missing receipt"}`,
      );
    }
    ctx.note(`authority granted ${GRANT_ITEM_IDS.length} inventory model families`);
  },

  async run(ctx) {
    const s = ctx.primary;
    const failedModelResponses = [];
    let glbResponseCount = 0;
    s.page.on("response", (response) => {
      if (!new URL(response.url()).pathname.endsWith(".glb")) return;
      glbResponseCount += 1;
      if (!response.ok()) {
        failedModelResponses.push({
          url: response.url(),
          status: response.status(),
        });
      }
    });

    const ticketPurchase = await ctx.debugCommand({
      PurchaseTravelTicket: {
        terminal_prop_id: "travel-terminal-dustgate",
        to_planet_id: "verdance",
        to_city_id: "lowbough",
      },
    });
    s.assert(
      ticketPurchase?.receipt?.accepted === true,
      `authority rejected inventory-model Travel Ticket purchase: ${ticketPurchase?.receipt?.reasonCode ?? "missing receipt"}`,
    );
    await s.waitProbeCall(
      async () => {
        const oracle = await s.oracle();
        const ownedItemIds = new Set(
          (oracle.inventory ?? [])
            .filter((row) => String(row.container).startsWith(s.actorId) && (row.available ?? 0) > 0)
            .map((row) => row.itemId),
        );
        return {
          ownedCount: ownedItemIds.size,
          missingItemIds: ALL_ITEM_IDS.filter((itemId) => !ownedItemIds.has(itemId)),
        };
      },
      (coverage) => coverage.missingItemIds.length === 0,
      { label: `${ALL_ITEM_IDS.length} inventory families granted`, timeoutMs: 30000 },
    );

    await s.press("KeyI");
    await s.waitDom('.sc3d-window[data-window="inventory"]', { state: "visible", timeoutMs: 10000 });
    const presentItemIds = await s.waitProbeCall(
      () => s.page.$$eval(
        ".inv-slot[data-item-id]",
        (slots) => slots.map((slot) => Number(slot.getAttribute("data-item-id"))),
      ),
      (itemIds) => ALL_ITEM_IDS.every((itemId) => itemIds.includes(itemId)),
      { label: `${ALL_ITEM_IDS.length} inventory slots reconciled`, timeoutMs: 20000 },
    );
    s.assert(
      await s.page.locator(".inv-slot img, .inventory-pixel-sprite").count() === 0,
      "2D inventory sprite element survived the GLB-only cutover",
    );

    const renderedModels = [];
    for (let index = 0; index < ALL_ITEM_IDS.length; index += 1) {
      const itemId = ALL_ITEM_IDS[index];
      const slot = s.page.locator(`.inv-slot[data-item-id="${itemId}"]`).first();
      await slot.evaluate((element) => element.scrollIntoView({ block: "center", inline: "nearest" }));
      const slotKey = await slot.getAttribute("data-key");
      s.assert(typeof slotKey === "string" && slotKey.length > 0, `item ${itemId} has no slot key`);
      const assetKey = await s.waitProbeCall(
        () => s.page.evaluate(
          (key) => window.__successor3dInventoryModelAssetKey?.(key) ?? null,
          slotKey,
        ),
        (value) => typeof value === "string" && value.startsWith("model:"),
        { label: `item ${itemId} loaded GLB turntable`, timeoutMs: 20000, intervalMs: 40 },
      );
      const staticModelPath = STATIC_MODEL_BY_ITEM_ID.get(itemId);
      if (staticModelPath) {
        s.assert(
          assetKey.startsWith(`model:${staticModelPath}:`),
          `item ${itemId} loaded ${assetKey}, expected ${staticModelPath}`,
        );
      } else {
        s.assert(
          assetKey.startsWith("model:/assets/pawn-pack/equipment/Under/"),
          `creator clothing ${itemId} did not resolve its Under/ GLB: ${assetKey}`,
        );
      }
      s.assert(
        !assetKey.includes(UNKNOWN_ITEM_MODEL_PATH),
        `item ${itemId} fell through to the unknown-item safety model`,
      );
      renderedModels.push({ itemId, assetKey });

      const shotName = SHOT_BY_INDEX[index];
      if (shotName) {
        await ctx.delay(180);
        await ctx.moneyShot(shotName);
      }
    }

    const dockLabels = await s.page.$$eval(
      ".sc3d-dock-btn",
      (buttons) => buttons.map((button) => button.getAttribute("aria-label")),
    );
    s.assert(
      JSON.stringify(dockLabels) === JSON.stringify(DOCK_LABELS),
      `permanent dock mismatch: ${JSON.stringify(dockLabels)}`,
    );
    s.assert(
      failedModelResponses.length === 0,
      `GLB HTTP failures: ${JSON.stringify(failedModelResponses)}`,
    );
    s.assert(
      renderedModels.length === ALL_ITEM_IDS.length,
      `rendered ${renderedModels.length}/${ALL_ITEM_IDS.length} inventory models`,
    );
    ctx.note(
      `GLB turntables=${renderedModels.length}; static=${STATIC_MODEL_BY_ITEM_ID.size}; creator clothing=${CREATOR_CLOTHING_ITEM_IDS.length}; DOM slots=${presentItemIds.length}; GLB responses=${glbResponseCount}; dock=${dockLabels.join(" > ")}`,
    );
  },
};
