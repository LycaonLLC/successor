// Journey: generated camp footlocker — visible open/take, then take-only
// rejection. The final encounter fixture owns the prop, its three rows, and
// the exact authored camp geometry; this journey never seeds or mutates that
// world state. It uses only the normal F interaction and visible inventory /
// loot-window gestures.
//
// Fixture: open-desert-rogue-zone-001-footlocker at cell (172,160), solid body
// collider x 172.21-172.79. Spawn/approach from the south face so the 1.75-cell
// lootCache chip is live without standing inside the solid.
//
// After the allowed locker→pack take empties the surface, the LOOT window shows
// the real `.scp-empty` overlay (`pointer-events: auto`, "NOTHING REMAINS").
// The negative carried→locker drag must target the visible emptyText node —
// not the covered `.dwl-grid` (emptyText intercepts the overlay center).

import { openDockWindow } from "./_helpers.mjs";

const LOCKER_ID = "open-desert-rogue-zone-001-footlocker";
const LOCKER_CONTAINER = `footlocker:${LOCKER_ID}`;
const PROBE_ACTOR = "h3d-footlocker-probe";
const BANDAGE_ITEM_ID = 1002;
const LOOT = '.sc3d-window[data-window="loot"]';
const INVENTORY = '.sc3d-window[data-window="inventory"]';
// South of the footlocker face (cell y=160) — clear of body collider (172.21..172.79, y 160..161),
// grill (170,159), and chair-b (169,160), 1.30 cells from footlocker center (172.5,160.5)
// (well within 1.75 lootCache interaction radius).
const LOCKER_STAND = { x: 172.5, y: 161.8 };

function isInsertKind(kind) {
  // Negative path must not emit insert/move-into-locker commands. TakeLoot is
  // the allowed direction and is tracked separately on the positive path.
  return /deposit|storeloot|insertloot|bankstore|moveitem/iu.test(String(kind ?? ""));
}

function commandIdsOf(probe, predicate) {
  return new Set(
    (probe?.authorityReceiptTail ?? [])
      .filter((entry) => predicate(entry.kind))
      .map((entry) => entry.commandId),
  );
}

function freshCommands(probe, baselineIds, predicate) {
  return (probe?.authorityReceiptTail ?? []).filter(
    (entry) => predicate(entry.kind) && !baselineIds.has(entry.commandId),
  );
}

function carriedBandageQty(oracle) {
  return (oracle?.inventory ?? [])
    .filter((row) => String(row.container).startsWith(`${PROBE_ACTOR}:`) && Number(row.itemId) === BANDAGE_ITEM_ID)
    .reduce((sum, row) => sum + Number(row.available ?? 0), 0);
}

async function walkToCell(ctx, s, target, { withinCells = 0.35, timeoutMs = 20000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const p = await s.probe();
    const actor = p?.authorityPlayer ?? p?.playerCell;
    const px = Number(actor?.x);
    const py = Number(actor?.y);
    if (!Number.isFinite(px) || !Number.isFinite(py)) {
      await ctx.delay(100);
      continue;
    }
    const dx = target.x - px;
    const dy = target.y - py;
    const distance = Math.hypot(dx, dy);
    if (distance <= withinCells) return distance;
    const keys = [];
    if (dy > 0.1) keys.push("KeyS"); else if (dy < -0.1) keys.push("KeyW");
    if (dx > 0.1) keys.push("KeyD"); else if (dx < -0.1) keys.push("KeyA");
    if (keys.length === 0) {
      if (Math.abs(dx) >= Math.abs(dy)) keys.push(dx >= 0 ? "KeyD" : "KeyA");
      else keys.push(dy >= 0 ? "KeyS" : "KeyW");
    }
    await s.hold(keys, Math.min(280, Math.max(100, Math.round(distance * 160))));
  }
  const p = await s.probe();
  const actor = p?.authorityPlayer ?? p?.playerCell;
  throw new Error(`walkToCell timed out at (${actor?.x},${actor?.y}) going to (${target.x},${target.y})`);
}

export default {
  id: "footlocker",
  title: "Camp footlocker (open + take-only gestures)",
  headed: true,
  // The authored final encounter is required; this journey does not overlay
  // or debug-grant any prop or inventory state.
  timeoutMs: 120000,
  characters: [{
    role: "primary",
    id: PROBE_ACTOR,
    name: "LockerProbe",
    x: 172.5,
    y: 162.5,
    initialProfessionId: "brawler",
    verificationLoadout: {
      mode: "client3d-pre-entry.v1",
      items: [{ itemId: 1002, variantId: 0, quantity: 1, equipped: false }],
    },
  }],
  async run(ctx) {
    const s = ctx.primary;

    // Normal inventory is mounted before the loot surface so a real carried
    // tile remains available as the source of rejected insert gestures.
    await openDockWindow(s, "inventory");
    await s.waitDom(`${INVENTORY} .inv-slot[data-item-id="3105"], ${INVENTORY} .inv-slot[data-item-id="1002"]`, {
      state: "visible",
      timeoutMs: 12000,
    });

    // Walk onto the authored south face so the F chip is for this locker, not
    // a neighboring camp prop that can steal the first KeyF.
    await walkToCell(ctx, s, LOCKER_STAND, { withinCells: 0.3, timeoutMs: 20000 });
    await s.waitProbe(
      (p) => (p.interactions ?? []).some((option) => option.kind === "lootCache" && option.targetId === LOCKER_ID),
      { label: "generated camp footlocker in visible F interaction range", timeoutMs: 15000 },
    );
    // Prefer the footlocker chip if another interactable is nearer.
    for (let cycle = 0; cycle < 4; cycle += 1) {
      const probe = await s.probe();
      const options = probe?.interactions ?? [];
      if (options[0]?.kind === "lootCache" && options[0]?.targetId === LOCKER_ID) break;
      if (!options.some((option) => option.kind === "lootCache" && option.targetId === LOCKER_ID)) break;
      await s.press("KeyV");
      await ctx.delay(200);
    }

    const beforeOpenOracle = await s.oracle();
    const beforeLockerRows = (beforeOpenOracle.inventory ?? []).filter(
      (row) => String(row.container) === LOCKER_CONTAINER && Number(row.available ?? 0) > 0,
    );
    const carriedBandageBefore = carriedBandageQty(beforeOpenOracle);
    s.assert(
      beforeLockerRows.length === 1,
      `fixture locker rows ${beforeLockerRows.length} != 1: ${JSON.stringify(beforeLockerRows)}`,
    );
    const baselineInsertIds = commandIdsOf(await s.probe(), isInsertKind);

    // Tap F, not a debug route: the visible LOOT window is the only open path.
    await s.press("KeyF");
    await s.waitDom(LOOT, { state: "visible", timeoutMs: 10000 });
    await s.waitDom(`${LOOT} .dwl-grid .inv-slot`, { state: "visible", timeoutMs: 10000 });
    await ctx.moneyShot("00-footlocker-open");

    // Allowed direction first: locker tile → pack (empties the one-row locker).
    const lootSlot = s.page.locator(`${LOOT} .dwl-grid .inv-slot`).first();
    await s.press("KeyI");
    await s.waitDom(INVENTORY, { state: "hidden", timeoutMs: 5000 });
    await lootSlot.dblclick();
    await s.waitProbeCall(
      () => s.oracle(),
      (oracle) => carriedBandageQty(oracle) > carriedBandageBefore,
      { label: "footlocker item taken into carried inventory", timeoutMs: 12000 },
    );
    const afterTake = await s.oracle();
    const afterLockerRows = (afterTake.inventory ?? []).filter(
      (row) => String(row.container) === LOCKER_CONTAINER && Number(row.available ?? 0) > 0,
    );
    s.assert(
      afterLockerRows.length === 0,
      `take should empty the one-row locker, got ${afterLockerRows.length}: ${JSON.stringify(afterLockerRows)}`,
    );
    const carriedAfterTake = carriedBandageQty(afterTake);
    await ctx.moneyShot("01-footlocker-taken");

    // emptyText is the exact visible hit target once the grid has no rows
    // (covers .scp-empty center; events bubble to the loot drop handler).
    const emptyText = s.page.locator(`${LOOT} .scp-empty [data-ref="emptyText"]`).first();
    await emptyText.waitFor({ state: "visible", timeout: 8000 });
    await s.waitProbeCall(
      () => emptyText.innerText(),
      (text) => String(text ?? "").includes("NOTHING REMAINS"),
      { label: "loot empty overlay shows NOTHING REMAINS", timeoutMs: 5000 },
    );

    // Re-open inventory so a carried tile is available for the rejected insert.
    await openDockWindow(s, "inventory");
    const source = s.page.locator(
      `${INVENTORY} .inv-slot[data-item-id="3105"], ${INVENTORY} .inv-slot[data-item-id="1002"]`,
    ).first();
    await source.waitFor({ state: "visible", timeout: 8000 });
    const sourceBox = await source.boundingBox();
    const emptyBox = await emptyText.boundingBox();
    s.assert(
      sourceBox && emptyBox && emptyBox.width > 0 && emptyBox.height > 0,
      "carried tile and visible emptyText lack screen rectangles",
    );

    // Carried → empty-locker drag must hit emptyText and emit no insert/MoveItem.
    // Quantity stays put.
    const beforeDragInsertIds = commandIdsOf(await s.probe(), isInsertKind);
    await source.dragTo(emptyText);
    await ctx.delay(1500);
    const afterDrag = await s.probe();
    const newDragInserts = freshCommands(afterDrag, beforeDragInsertIds, isInsertKind);
    s.assert(
      newDragInserts.length === 0,
      `carried→empty drag emitted insert/MoveItem: ${JSON.stringify(newDragInserts)}`,
    );
    const afterDragOracle = await s.oracle();
    s.assert(
      carriedBandageQty(afterDragOracle) === carriedAfterTake,
      `carried bandage qty changed on rejected empty-locker drag: ${carriedAfterTake}→${carriedBandageQty(afterDragOracle)}`,
    );
    ctx.note("carried inventory drag onto visible emptyText rejected; qty unchanged");

    // Double-click on the carried tile is also not an insertion route.
    const beforeDblInsertIds = commandIdsOf(await s.probe(), isInsertKind);
    await source.dblclick();
    await ctx.delay(1500);
    const afterDoubleClick = await s.probe();
    const newDblInserts = freshCommands(afterDoubleClick, beforeDblInsertIds, isInsertKind);
    s.assert(
      newDblInserts.length === 0,
      `carried double-click emitted insert/MoveItem: ${JSON.stringify(newDblInserts)}`,
    );
    s.assert(
      carriedBandageQty(await s.oracle()) === carriedAfterTake,
      "carried bandage qty changed on rejected double-click insert",
    );
    ctx.note("carried inventory double-click rejected as a locker insert");

    const finalProbe = await s.probe();
    const newFinalInserts = freshCommands(finalProbe, baselineInsertIds, isInsertKind);
    s.assert(
      newFinalInserts.length === 0,
      `footlocker journey emitted insert/MoveItem: ${JSON.stringify(newFinalInserts)}`,
    );
    ctx.note(`take-only locker transfer left ${afterLockerRows.length} rows and no insert command`);
  },
};
