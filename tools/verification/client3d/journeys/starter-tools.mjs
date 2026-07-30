// Journey: the Craftsman trainer replaces the two-item bootstrap bundle.
// Alpha parks a Field Multitool at an in-range exchange and receives only the
// missing Mineral Survey Tool. Beta parks the same tool, walks outside the
// exchange footprint while staying beside the trainer, and receives both
// tools because remote exchange rows are not ownership proof.
//
// Fixture geometry:
//   camp-trainer cell (510,504)
//   starter-tool-exchange overlay cell is placed beside the trainer so both
//   1.75-cell interact radii overlap at (511,505) / (510.2,505.8).
import { ITEM, findInventoryStack } from "./_helpers.mjs";

const TOOL_VARIANT = 500;
const TRAINER_ID = "camp-trainer";
const EXCHANGE_ID = "starter-tool-exchange";
// Free plaza south of trainer (510,504), clear of commerce shell/desk/rails.
// Exchange overlay cell (510,505); shared stand (510.5,505.4) — center y 505.9 clears front_wall_right min y 506.289.
const TRAINER_EXCHANGE_STAND = { x: 510.5, y: 505.4 };
// Runtime-reached trainer-only stand (exchange out, trainer in); avoid 510.9,503.2 collision converge.
const TRAINER_ONLY_STAND = { x: 510.6, y: 503.0 };

function carriedQuantity(oracle, actorId, itemId) {
  return (oracle?.inventory ?? [])
    .filter((row) => Number(row.itemId) === itemId && String(row.container).startsWith(actorId))
    .reduce((sum, row) => sum + Number(row.available ?? row.quantity ?? 0), 0);
}

function exchangeQuantity(oracle, itemId) {
  return (oracle?.inventory ?? [])
    .filter((row) => Number(row.itemId) === itemId && String(row.container) === "district-exchange")
    .reduce((sum, row) => sum + Number(row.available ?? row.quantity ?? 0), 0);
}

function newReceipt(probe, knownCommandIds, kind) {
  return (probe.authorityReceiptTail ?? []).find((entry) => (
    !knownCommandIds.has(entry.commandId) && entry.kind === kind
  ));
}

async function walkToCell(ctx, s, target, { withinCells = 0.35, timeoutMs = 20000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const p = await s.probe();
    const x = Number(p?.authorityPlayer?.x ?? p?.playerCell?.x ?? 0);
    const y = Number(p?.authorityPlayer?.y ?? p?.playerCell?.y ?? 0);
    const dx = target.x - x;
    const dy = target.y - y;
    const distance = Math.hypot(dx, dy);
    if (distance <= withinCells) return distance;
    const keys = [];
    if (dy > 0.15) keys.push("KeyS"); else if (dy < -0.15) keys.push("KeyW");
    if (dx > 0.15) keys.push("KeyD"); else if (dx < -0.15) keys.push("KeyA");
    if (keys.length === 0) {
      if (Math.abs(dx) >= Math.abs(dy)) keys.push(dx >= 0 ? "KeyD" : "KeyA");
      else keys.push(dy >= 0 ? "KeyS" : "KeyW");
    }
    await s.hold(keys, Math.min(420, Math.max(140, distance * 220)));
  }
  const p = await s.probe();
  throw new Error(`walkToCell timed out at (${p?.authorityPlayer?.x},${p?.authorityPlayer?.y}) going to (${target.x},${target.y})`);
}

async function clickVisibleOption(s, selector, label) {
  const option = s.page.locator(selector).first();
  await option.waitFor({ state: "visible", timeout: 8000 });
  const box = await option.boundingBox();
  s.assert(
    box && box.width > 0 && box.height > 0,
    `${label} has no clickable screen rectangle: ${JSON.stringify(box)}`,
  );
  await s.page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}

async function selectExactInteraction(ctx, s, kind, targetId, { label = "interaction" } = {}) {
  const match = (option) => option?.kind === kind && option?.targetId === targetId;
  // KeyV advances state.interactions.selectedIndex; probe.interactions stays a
  // stable nearest-first roster. Selection truth is probe.selectedInteraction.
  await s.waitProbe(
    (probe) => (probe.interactions ?? []).some(match),
    { label: `${label} present in interaction roster`, timeoutMs: 10000 },
  );
  let last = await s.probe();
  const roster = last.interactions ?? [];
  const maxCycles = Math.min(12, Math.max(4, roster.length * 2 + 2));
  for (let cycle = 0; cycle < maxCycles; cycle += 1) {
    last = await s.probe();
    if (match(last.selectedInteraction)) {
      s.assert(
        match(last.selectedInteraction),
        `${label} selectedInteraction drifted after select: ${JSON.stringify(last.selectedInteraction)} roster=${JSON.stringify(last.interactions ?? [])}`,
      );
      return last;
    }
    if (!(last.interactions ?? []).some(match)) {
      await s.waitProbe(
        (probe) => (probe.interactions ?? []).some(match),
        { label: `${label} restored in interaction roster`, timeoutMs: 4000 },
      ).catch(() => null);
      continue;
    }
    await s.press("KeyV");
    await ctx.delay(120);
  }
  last = await s.probe();
  s.assert(
    match(last.selectedInteraction),
    `${label} never became selectedInteraction after ${maxCycles} KeyV cycles: selected=${JSON.stringify(last.selectedInteraction ?? null)} roster=${JSON.stringify(last.interactions ?? [])}`,
  );
  return last;
}

async function parkMultitoolAtExchange(ctx, s, label) {
  const stack = await findInventoryStack(s, ITEM.fieldMultitool);
  s.assert(stack, `${label}: no carried Field Multitool to store`);
  await s.slash(`/store-to-exchange ${ITEM.fieldMultitool} ${stack.variantId} 1`);
  const parked = await s.waitProbeCall(
    () => s.oracle(),
    (oracle) => carriedQuantity(oracle, s.actorId, ITEM.fieldMultitool) === 0
      && exchangeQuantity(oracle, ITEM.fieldMultitool) > 0,
    { label: `${label} Field Multitool parked at exchange`, timeoutMs: 10000 },
  );
  ctx.note(`${label}: parked Field Multitool; exchange quantity=${exchangeQuantity(parked, ITEM.fieldMultitool)}`);
}

async function moveBesideTrainer(ctx, s) {
  await walkToCell(ctx, s, TRAINER_EXCHANGE_STAND, { withinCells: 0.3, timeoutMs: 20000 });
  await s.waitProbe(
    (probe) => (probe.interactions ?? []).some((option) => option.kind === "exchange" && option.targetId === EXCHANGE_ID)
      && (probe.interactions ?? []).some((option) => option.kind === "trainer" && option.targetId === TRAINER_ID),
    { label: "alpha beside trainer with exchange still in range", timeoutMs: 10000 },
  );
  // Exact first-option trainer before any later F open can hit exchange.
  const finalProbe = await selectExactInteraction(ctx, s, "trainer", TRAINER_ID, {
    label: "alpha trainer chip",
  });
  ctx.note(`alpha positioned beside trainer at (${Number(finalProbe.authorityPlayer?.x).toFixed(3)}, ${Number(finalProbe.authorityPlayer?.y).toFixed(3)}); selected=${JSON.stringify(finalProbe.selectedInteraction ?? null)}`);
  return finalProbe;
}

async function clearTrainerLane(ctx, s) {
  // Park alpha in the proven commerce west lane. South through x=506 entry
  // stalls on the closed front door; do not open/mutate doors. North beside
  // trainer desk, then west on free y=503.5 through the PA gap into the west
  // aisle (~9 cells from trainer) so beta can take the stand alone.
  await walkToCell(ctx, s, { x: 510.2, y: 505.4 }, { withinCells: 0.3, timeoutMs: 15000 });
  await walkToCell(ctx, s, { x: 510.2, y: 503.5 }, { withinCells: 0.3, timeoutMs: 15000 });
  await walkToCell(ctx, s, { x: 501.3, y: 503.5 }, { withinCells: 0.3, timeoutMs: 15000 });
  await s.waitProbe(
    (probe) => Number(probe.authorityPlayer?.x ?? 0) <= 501.7,
    { label: "alpha clears the trainer lane", timeoutMs: 8000 },
  );
}

async function openCraftsmanTrainer(ctx, s, label) {
  await s.waitProbe(
    (probe) => (probe.interactions ?? []).some((option) => option.kind === "trainer" && option.targetId === TRAINER_ID),
    { label: `${label} trainer in reach`, timeoutMs: 10000 },
  );
  let converseOpen = false;
  for (let attempt = 0; attempt < 4 && !converseOpen; attempt += 1) {
    // Roster can reorder while exchange/other options compete — reselect exact
    // trainer as selectedInteraction immediately before every trusted KeyF.
    const selected = await selectExactInteraction(ctx, s, "trainer", TRAINER_ID, {
      label: `${label} trainer chip before F (attempt ${attempt + 1})`,
    });
    s.assert(
      selected.selectedInteraction?.kind === "trainer" && selected.selectedInteraction?.targetId === TRAINER_ID,
      `${label}: selectedInteraction not trainer before KeyF: ${JSON.stringify(selected.selectedInteraction ?? null)} roster=${JSON.stringify(selected.interactions ?? [])}`,
    );
    await s.press("KeyF");
    converseOpen = await s.page.locator('.sc3d-window[data-window="converse"]').first().isVisible().catch(() => false);
    if (!converseOpen) {
      await ctx.delay(900);
      converseOpen = await s.page.locator('.sc3d-window[data-window="converse"]').first().isVisible().catch(() => false);
    }
    // F may open exchange TRADE (or another surface) when roster races. Dismiss
    // unconditionally before the next exact-trainer reselect + KeyF retry.
    if (!converseOpen) {
      await s.press("Escape");
      await ctx.delay(200);
    }
  }
  s.assert(converseOpen, `${label}: CONVERSE did not open`);
  await s.waitProbe(
    (probe) => probe.selectedActorId === TRAINER_ID,
    { label: `${label} camp trainer selected`, timeoutMs: 6000 },
  );
  await clickVisibleOption(s, '.scv-option[data-option="tools"]', `${label} tools option`);
  await s.waitDom('.scv-option[data-option="starter-tool"]', { state: "visible", timeoutMs: 8000 });
}

async function requestStarterBundle(ctx, s, label, expectedCarried) {
  await openCraftsmanTrainer(ctx, s, label);
  const before = await s.probe();
  const knownCommandIds = new Set((before.authorityReceiptTail ?? []).map((entry) => entry.commandId));
  await clickVisibleOption(s, '.scv-option[data-option="starter-tool"]', `${label} starter-tool option`);
  const receiptProbe = await s.waitProbe(
    (probe) => Boolean(newReceipt(probe, knownCommandIds, "RequestStarterTool")),
    { label: `${label} RequestStarterTool receipt`, timeoutMs: 12000 },
  );
  const receipt = newReceipt(receiptProbe, knownCommandIds, "RequestStarterTool");
  s.assert(receipt?.accepted === true, `${label}: RequestStarterTool rejected: ${JSON.stringify(receipt ?? null)}`);
  const settled = await s.waitProbeCall(
    () => s.oracle(),
    (oracle) => carriedQuantity(oracle, s.actorId, ITEM.fieldMultitool) === expectedCarried.fieldMultitool
      && carriedQuantity(oracle, s.actorId, ITEM.mineralSurveyTool) === expectedCarried.mineralSurveyTool,
    { label: `${label} exact starter bundle settlement`, timeoutMs: 12000 },
  );
  await s.waitProbeCall(
    () => s.page.locator(".scv-current").last().innerText(),
    (text) => text.includes("Multitool and mineral scanner"),
    { label: `${label} starter-tool dialogue acknowledgement`, timeoutMs: 8000 },
  );
  ctx.note(`${label}: accepted starter request; carried Field=${carriedQuantity(settled, s.actorId, ITEM.fieldMultitool)} Mineral=${carriedQuantity(settled, s.actorId, ITEM.mineralSurveyTool)}; receipt=${JSON.stringify(receipt)}`);
  return settled;
}

async function walkOutsideExchangeFootprint(ctx, s) {
  await walkToCell(ctx, s, TRAINER_ONLY_STAND, { withinCells: 0.3, timeoutMs: 15000 });
  const outside = await s.waitProbe(
    (probe) => !(probe.interactions ?? []).some((option) => option.kind === "exchange" && option.targetId === EXCHANGE_ID)
      && (probe.interactions ?? []).some((option) => option.kind === "trainer" && option.targetId === TRAINER_ID),
    { label: "beta outside exchange footprint but inside trainer reach", timeoutMs: 10000 },
  );
  ctx.note(`beta moved to (${Number(outside.authorityPlayer?.x).toFixed(3)}, ${Number(outside.authorityPlayer?.y).toFixed(3)}): exchange out of reach, trainer still in reach`);
}

export default {
  id: "starter-tools",
  title: "Craftsman starter tools — bundle, backfill, exchange footprint",
  timeoutMs: 120000,
  characters: [
    { role: "alpha", id: "h3d-tools-alpha", name: "ToolsAlpha", x: 510.5, y: 505.4, initialProfessionId: "brawler" },
    // Clear of alpha/exchange so beta does not spawn stacked on the shared stand.
    { role: "beta", id: "h3d-tools-beta", name: "ToolsBeta", x: 509.5, y: 505.4, initialProfessionId: "brawler" },
  ],
  serverSliceOverlay: {
    props: [{
      id: EXCHANGE_ID,
      entity: "container:district-exchange",
      areaId: "open-desert-overworld",
      label: "Camp Tool Exchange",
      kind: "resource_container",
      // South of trainer (510,504); free of commerce shell/desk/queue rails.
      cell: { x: 510, y: 505 },
      size: { w: 1, h: 1 },
      interactive: true,
      solid: false,
      visible: true,
    }],
  },
  async arm(ctx) {
    for (const role of ["alpha", "beta"]) {
      const session = ctx.session(role);
      const give = await ctx.debugCommand({
        DebugGiveItem: { item_id: ITEM.fieldMultitool, variant_id: TOOL_VARIANT, quantity: 1, equip: false },
      }, session);
      ctx.note(`${role}: give Field Multitool -> ${JSON.stringify(give.receipt ?? give.error ?? "?")}`);
    }
  },
  async run(ctx) {
    const alpha = ctx.session("alpha");
    const beta = ctx.session("beta");

    await parkMultitoolAtExchange(ctx, alpha, "alpha");
    const alphaBefore = await alpha.probe();
    alpha.assert(
      (alphaBefore.interactions ?? []).some((option) => option.kind === "exchange" && option.targetId === EXCHANGE_ID),
      "alpha does not see the exchange inside its footprint",
    );
    await moveBesideTrainer(ctx, alpha);
    await requestStarterBundle(ctx, alpha, "alpha in-range backfill", {
      fieldMultitool: 0,
      mineralSurveyTool: 1,
    });
    await ctx.moneyShot("01-in-range-exchange-backfill", alpha);
    await alpha.press("Escape");
    await clearTrainerLane(ctx, alpha);

    await parkMultitoolAtExchange(ctx, beta, "beta");
    await walkOutsideExchangeFootprint(ctx, beta);
    const betaSettled = await requestStarterBundle(ctx, beta, "beta remote-exchange full bundle", {
      fieldMultitool: 1,
      mineralSurveyTool: 1,
    });
    beta.assert(
      exchangeQuantity(betaSettled, ITEM.fieldMultitool) >= 2,
      `remote exchange Field Multitools were consumed or counted as carried: ${exchangeQuantity(betaSettled, ITEM.fieldMultitool)}`,
    );
    await ctx.moneyShot("02-out-of-range-exchange-full-bundle", beta);
  },
};
