// Journey: exchange store/retrieve. Stores an item stack into the personal
// exchange and retrieves it, proving the round-trip conserves the stack.
// Money shots: before store, after retrieve.
import { ITEM, findInventoryStack } from "./_helpers.mjs";

export default {
  id: "exchange",
  title: "Exchange store / retrieve",
  timeoutMs: 90000,
  characters: [{ role: "primary", id: "h3d-exchange-probe", name: "ProbeXchg", x: 511, y: 512, initialProfessionId: "craftsman" }],
  // The open-desert fixture ships no district-exchange; add one server-side
  // (client keeps the default slice; we drive + assert authoritatively).
  serverSliceOverlay: {
    props: [{
      id: "district-exchange-camp",
      entity: "container:district-exchange",
      areaId: "open-desert-overworld",
      label: "Camp Exchange",
      kind: "resource_container",
      cell: { x: 510, y: 512 },
      size: { w: 1, h: 1 },
      interactive: true,
      solid: false,
      visible: false,
    }],
  },
  async arm(ctx) {
    const give = await ctx.debugCommand({ DebugGiveItem: { item_id: ITEM.ironOre, variant_id: 0, quantity: 10 } });
    ctx.note(`give iron x10 -> ${JSON.stringify(give.receipt ?? give.error ?? "?")}`);
  },
  async run(ctx) {
    const s = ctx.primary;
    const stack = await findInventoryStack(s, ITEM.ironOre);
    s.assert(stack, `no iron stack to store`);
    ctx.note(`iron stack ${JSON.stringify(stack)} available ${stack.available}`);
    await ctx.moneyShot("00-before-store");

    const startQty = stack.available;
    // STORE 4 units into the exchange.
    await s.slash(`/store-to-exchange ${ITEM.ironOre} ${stack.variantId} 4`);
    const afterStore = await s.waitProbeCall(
      () => findInventoryStack(s, ITEM.ironOre).then((r) => r?.available ?? 0),
      (q) => q === startQty - 4,
      { label: "iron reduced by store", timeoutMs: 8000 },
    ).catch(() => null);
    ctx.note(`after store available=${afterStore}`);
    s.assert(afterStore === startQty - 4, `store did not remove 4 iron (start ${startQty}, now ${afterStore})`);

    // RETRIEVE 4 units back.
    await s.slash(`/retrieve-from-exchange ${ITEM.ironOre} ${stack.variantId} 4`);
    const afterRetrieve = await s.waitProbeCall(
      () => findInventoryStack(s, ITEM.ironOre).then((r) => r?.available ?? 0),
      (q) => q === startQty,
      { label: "iron restored by retrieve", timeoutMs: 8000 },
    ).catch(() => null);
    ctx.note(`after retrieve available=${afterRetrieve}`);
    await ctx.moneyShot("01-after-retrieve");
    s.assert(afterRetrieve === startQty, `retrieve did not restore iron to ${startQty} (now ${afterRetrieve})`);
  },
};
