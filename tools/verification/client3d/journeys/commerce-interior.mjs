// Headed journey: Commerce interior navigation, door sliding, cutaway reveal,
// and terminal/trainer zone verification. Proves the centerline route,
// sliding door interactions via F-prompt, and proximity to all terminals.
// No authority/economy-mutating purchases are conducted.
//
// Route geometry is fixture-grounded on open-desert-slice.json commerce
// facility (500,498) 12×9 and its collisionBounds:
//   queue_rail_bank  x 502.558-504.442 @ y 503.037-503.121 (EXP y 502.737..503.421)
//   queue_rail_trade x 505.558-507.442 @ y 503.037-503.121 (EXP y 502.737..503.421)
//   queue_rail_pa    x 508.558-510.442 @ y 503.037-503.121 (EXP y 502.737..503.421)
//   vestibule_pier_left ~504.03-504.39 @ y 505.80-506.15 (EXP x 503.732..504.689, y 505.495..506.453)
//   column_west      x 502.758-503.242 @ y 504.574-505.058 (EXP x 502.458..503.542, y 504.274..505.358)
//   column_east      x 508.758-509.242 @ y 504.574-505.058 (EXP x 508.458..509.542, y 504.274..505.358)
//   counter_bank     x 502.368-504.632 @ y 500.500-500.995 (EXP x 502.068..504.932, y 500.200..501.295)
//   bench_west       x 500.579-501.053 @ y 501.395-504.237 (EXP x 500.279..501.353, y 501.095..504.537)
//   trainer_desk     x 511.011-511.421 @ y 503.805-505.237 (EXP x 510.711..511.721, y 503.505..505.537)
//
// Anchor + 0.5 center semantics:
// - CORRIDOR_Y = 503.5 (actor center Y = 504.0, clear between queue_rail EXP y max 503.421 and column EXP y min 504.274)
// - TERMINAL_Y = 502.0 (actor center Y = 502.5, clear between counter EXP y max 501.295 and queue_rail EXP y min 502.737)
// - WEST_LANE_X = 501.3 (actor center X = 501.8, ~0.45m clear of bench_west EXP x max 501.353 and ~0.46m clear of queue_rail_bank EXP x min 502.258)
// - GAP_X = 504.5 (actor center X = 505.0, clear between queue_rail_bank EXP x max 504.742 and queue_rail_trade EXP x min 505.258)
//
// Collision-clear corridor pathing (player r=0.3):
// ENTRY (506.0, 505.8) → straight north x=506.0 to ENTRY_CORRIDOR_NORTH (506.0, 503.5)
// → west on free y=503.5 corridor to WEST_CORRIDOR (501.3, 503.5)
// → north on west lane x=501.3 to NORTH_OF_COUNTER (501.3, 502.0)
// → east to BANK_STAND (502.0, 502.0) → TRADE_STAND (506.0, 502.0) → PA_STAND (508.5, 502.0)
// → west along TERMINAL_Y=502.0 to GAP_TERMINAL (504.5, 502.0)
// → north along GAP_X=504.5 to GAP_CORRIDOR (504.5, 503.5)
// → east along CORRIDOR_Y=503.5 to TRAINER_CORRIDOR_X (510.2, 503.5)
// → south on x=510.2 to TRAINER_STAND (510.2, 505.4).
const BANK_ID = "dustgate-bank-terminal";
const TRADE_ID = "dustgate-trade-terminal";
const PA_ID = "dustgate-pa-terminal";
const TRAINER_ID = "camp-trainer";
const FACILITY_ID = "dustgate-commerce-facility";

const BANK_WINDOW = '.sc3d-window[data-window="bank"]';
const TRADE_WINDOW = '.sc3d-window[data-window="datapad"]';
const PA_WINDOW = '.sc3d-window[data-window="player-association"]';
const CONVERSE_WINDOW = '.sc3d-window[data-window="converse"]';

// Centerline entry / exit (door opening spans ~504.7-507.3).
const SOUTH_APPROACH = { x: 506.0, y: 509.0 };
const SOUTH_PORTAL = { x: 506.0, y: 508.5 };
const ENTRY = { x: 506.0, y: 505.8 };

// Corridor anchor Y = 503.5 (actor center Y = 504.0)
const CORRIDOR_Y = 503.5;
const ENTRY_CORRIDOR_NORTH = { x: 506.0, y: CORRIDOR_Y };

// West lane anchor X = 501.3 (actor center X = 501.8, ~0.45m clear of bench_west EXP x max 501.353 and ~0.46m clear of queue_rail_bank EXP x min 502.258)
const WEST_LANE_X = 501.3;
const WEST_CORRIDOR = { x: WEST_LANE_X, y: CORRIDOR_Y };

// Terminal anchor Y = 502.0 (actor center Y = 502.5)
const TERMINAL_Y = 502.0;
const NORTH_OF_COUNTER = { x: WEST_LANE_X, y: TERMINAL_Y };
const BANK_STAND = { x: 502.0, y: TERMINAL_Y };
const TRADE_STAND = { x: 506.0, y: TERMINAL_Y };
const PA_STAND = { x: 508.5, y: TERMINAL_Y };

// Rail gap anchor (between bank and trade queue rails: EXP x max 504.742 .. EXP x min 505.258, actor center X = 505.0)
const GAP_X = 504.5;
const GAP_TERMINAL = { x: GAP_X, y: TERMINAL_Y };
const GAP_CORRIDOR = { x: GAP_X, y: CORRIDOR_Y };

// Trainer corridor and stand
const TRAINER_CORRIDOR_X = { x: 510.2, y: CORRIDOR_Y };
const TRAINER_STAND = { x: 510.2, y: 505.4 };
const EXIT_OUTSIDE = { x: 506.0, y: 511.0 };

async function walkToCell(ctx, s, target, { withinCells = 0.3, stopIf = null, timeoutMs = 30000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastPos = null;
  let stallTicks = 0;
  while (Date.now() < deadline) {
    const p = await s.probe();
    const currentX = p?.playerCell?.x ?? p?.authorityPlayer?.x ?? 0;
    const currentY = p?.playerCell?.y ?? p?.authorityPlayer?.y ?? 0;
    const dx = target.x - currentX;
    const dy = target.y - currentY;
    const distance = Math.hypot(dx, dy);
    if (distance <= withinCells || (stopIf && stopIf(p))) return distance;
    if (lastPos && Math.hypot(currentX - lastPos.x, currentY - lastPos.y) < 0.02) {
      stallTicks += 1;
      if (stallTicks > 20) {
        throw new Error(`walkToCell collision stall detected at (${currentX.toFixed(2)}, ${currentY.toFixed(2)}) going to (${target.x}, ${target.y})`);
      }
    } else {
      stallTicks = 0;
    }
    lastPos = { x: currentX, y: currentY };
    const keys = [];
    if (dy > 0.08) keys.push('KeyS'); else if (dy < -0.08) keys.push('KeyW');
    if (dx > 0.08) keys.push('KeyD'); else if (dx < -0.08) keys.push('KeyA');
    if (keys.length === 0) {
      if (Math.abs(dx) >= Math.abs(dy)) keys.push(dx >= 0 ? 'KeyD' : 'KeyA');
      else keys.push(dy >= 0 ? 'KeyS' : 'KeyW');
    }
    const holdMs = Math.min(600, Math.max(120, Math.round(distance * 200)));
    await s.hold(keys, holdMs);
  }
  const p = await s.probe();
  throw new Error(`walkToCell timed out at (${p?.playerCell?.x},${p?.playerCell?.y}) targeting (${target.x},${target.y})`);
}

function knownCommandIds(probe) {
  return new Set((probe?.authorityReceiptTail ?? []).map((entry) => entry.commandId));
}

function freshReceipt(probe, knownIds, kind) {
  return (probe?.authorityReceiptTail ?? []).find((entry) => (
    !knownIds.has(entry.commandId) && entry.kind === kind
  )) ?? null;
}

async function awaitFreshAccepted(s, knownIds, kind, { timeoutMs = 12000 } = {}) {
  const probe = await s.waitProbe(
    (p) => {
      const receipt = freshReceipt(p, knownIds, kind);
      return Boolean(receipt && receipt.accepted === true);
    },
    { label: `fresh accepted ${kind}`, timeoutMs },
  );
  const receipt = freshReceipt(probe, knownIds, kind);
  s.assert(receipt?.accepted === true, `expected fresh accepted ${kind}, got ${JSON.stringify(receipt ?? null)}`);
  return receipt;
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

async function openExactInteraction(ctx, s, kind, targetId, windowSel, { label = "interaction" } = {}) {
  // Require exact selectedInteraction immediately before every trusted KeyF.
  // Escape wrong surfaces so a sticky selectedIndex from a prior kiosk cannot
  // open TRADE/BANK/etc when we meant another terminal.
  let opened = false;
  for (let attempt = 0; attempt < 4 && !opened; attempt += 1) {
    const selected = await selectExactInteraction(ctx, s, kind, targetId, {
      label: `${label} before F (attempt ${attempt + 1})`,
    });
    s.assert(
      selected.selectedInteraction?.kind === kind && selected.selectedInteraction?.targetId === targetId,
      `${label}: selectedInteraction not exact before KeyF: ${JSON.stringify(selected.selectedInteraction ?? null)} roster=${JSON.stringify(selected.interactions ?? [])}`,
    );
    await s.press("KeyF");
    opened = await s.waitDom(windowSel, { state: "visible", timeoutMs: 4000 })
      .then(() => true)
      .catch(() => false);
    if (!opened) {
      await ctx.delay(400);
      opened = await s.page.locator(windowSel).first().isVisible().catch(() => false);
    }
    if (!opened) {
      await s.press("Escape");
      await ctx.delay(200);
    }
  }
  s.assert(opened, `${label}: KeyF never opened ${windowSel} with exact selectedInteraction`);
  await s.waitDom(windowSel, { state: "visible", timeoutMs: 5000 });
}

export default {
  id: "commerce-interior",
  title: "Commerce Facility Interior Walk and Terminal Interactivity (headed)",
  headed: true,
  timeoutMs: 180000,
  characters: [{
    role: "primary",
    id: "h3d-commerce-interior-probe",
    name: "CommerceInt",
    x: 506.0,
    y: 512.0,
    initialProfessionId: "brawler",
    professions: { credits: 30000 },
  }],
  async run(ctx) {
    const s = ctx.primary;
    await s.waitProbe((p) => p.serverStatus === 'connected' && p.authorityPlayer, { label: 'authority connected', timeoutMs: 45000 });

    // 1. Spawn/walk to south exterior
    ctx.note("walking to south entrance door approach");
    await walkToCell(ctx, s, SOUTH_APPROACH, {
      withinCells: 0.25,
      stopIf: (p) => p.interactions?.[0]?.kind === "door" && p.interactions?.[0]?.targetId === FACILITY_ID,
    });

    // 2. Open the commerce sliding door via F-interaction: closed door must win
    // roster[0] and default selectedInteraction (no KeyV) before trusted KeyF.
    ctx.note("asserting facility door wins interaction selection");
    const doorProbe = await s.waitProbe(
      (p) => p.interactions?.[0]?.kind === "door" && p.interactions?.[0]?.targetId === FACILITY_ID,
      { label: "closed facility door wins interaction selection", timeoutMs: 15000 }
    );
    s.assert(
      doorProbe.interactions?.[0]?.kind === "door" && doorProbe.interactions?.[0]?.targetId === FACILITY_ID,
      "facility door must win interaction selection when closed"
    );
    await ctx.moneyShot("01-exterior-approach", s);

    // Closed-door-wins is a product contract: do not KeyV-cycle the door into
    // selection. Assert the default selectedInteraction is already the facility door.
    s.assert(
      doorProbe.selectedInteraction?.kind === "door" && doorProbe.selectedInteraction?.targetId === FACILITY_ID,
      `facility door must be selectedInteraction without KeyV: ${JSON.stringify(doorProbe.selectedInteraction ?? null)} roster=${JSON.stringify(doorProbe.interactions ?? [])}`,
    );
    ctx.note("pressing KeyF to toggle door and awaiting fresh accepted ToggleDoor receipt");
    const knownIds = knownCommandIds(await s.probe());
    await s.press("KeyF");
    await awaitFreshAccepted(s, knownIds, "ToggleDoor", { timeoutMs: 12000 });

    // Wait until door slide open is registered in doorStates
    await s.waitProbe(
      (p) => p.doorStates?.[FACILITY_ID]?.doorOpen === true,
      { label: "door states shows open", timeoutMs: 15000 }
    );
    await ctx.moneyShot("02-door-opened", s);

    // 3. Walk centerline through clear opening into the building
    ctx.note("walking centerline through open door");
    await walkToCell(ctx, s, SOUTH_PORTAL, { withinCells: 0.25 });
    await walkToCell(ctx, s, ENTRY, { withinCells: 0.25 });
    await ctx.moneyShot("03-interior-cutaway", s);

    // Assert that we are inside the building's interior region (meaning cutaway works)
    const probe = await s.probe();
    s.assert(probe.doorStates?.[FACILITY_ID]?.doorOpen === true, "facility door state must remain open");

    // 4. Visit Bank Zone — north along x=506.0 to CORRIDOR_Y=503.5, west along y=503.5 to WEST_LANE_X=501.3, then north to TERMINAL_Y=502.0.
    ctx.note("walking to bank terminal via clear corridor (x=506.0 -> y=503.5 -> x=501.3 -> y=502.0)");
    await walkToCell(ctx, s, ENTRY_CORRIDOR_NORTH, { withinCells: 0.2 });
    await walkToCell(ctx, s, WEST_CORRIDOR, { withinCells: 0.2 });
    await walkToCell(ctx, s, NORTH_OF_COUNTER, { withinCells: 0.2 });
    await walkToCell(ctx, s, BANK_STAND, {
      withinCells: 0.25,
      stopIf: (p) => (p.interactions ?? []).some((o) => o.kind === "bankTerminal" && o.targetId === BANK_ID),
    });

    await s.waitProbe(
      (p) => (p.interactions ?? []).some((o) => o.kind === "bankTerminal" && o.targetId === BANK_ID),
      { label: "bank terminal interaction chip visible", timeoutMs: 15000 }
    );
    await openExactInteraction(ctx, s, "bankTerminal", BANK_ID, BANK_WINDOW, { label: "bank terminal" });
    await ctx.moneyShot("04-bank-zone", s);
    await s.press("Escape");
    await s.waitDom(BANK_WINDOW, { state: "hidden", timeoutMs: 10000 });

    // 5. Visit Trade Zone — east along TERMINAL_Y=502.0 corridor.
    ctx.note("walking to trade terminal on y=502.0 corridor (axis only)");
    await walkToCell(ctx, s, TRADE_STAND, {
      withinCells: 0.25,
      stopIf: (p) => (p.interactions ?? []).some((o) => o.kind === "exchange" && o.targetId === TRADE_ID),
    });

    await s.waitProbe(
      (p) => (p.interactions ?? []).some((o) => o.kind === "exchange" && o.targetId === TRADE_ID),
      { label: "trade terminal interaction chip visible", timeoutMs: 15000 }
    );
    await openExactInteraction(ctx, s, "exchange", TRADE_ID, TRADE_WINDOW, { label: "trade terminal" });
    await ctx.moneyShot("05-trade-zone", s);
    await s.press("Escape");
    await s.waitDom(TRADE_WINDOW, { state: "hidden", timeoutMs: 10000 });

    // 6. Visit PA Zone
    ctx.note("walking to PA terminal");
    await walkToCell(ctx, s, PA_STAND, {
      withinCells: 0.25,
      stopIf: (p) => (p.interactions ?? []).some((o) => o.kind === "paTerminal" && o.targetId === PA_ID),
    });

    await s.waitProbe(
      (p) => (p.interactions ?? []).some((o) => o.kind === "paTerminal" && o.targetId === PA_ID),
      { label: "PA terminal interaction chip visible", timeoutMs: 15000 }
    );
    await openExactInteraction(ctx, s, "paTerminal", PA_ID, PA_WINDOW, { label: "PA terminal" });
    await ctx.moneyShot("06-pa-zone", s);
    await s.press("Escape");
    await s.waitDom(PA_WINDOW, { state: "hidden", timeoutMs: 10000 });

    // 7. Visit Trainer Zone — west along TERMINAL_Y=502.0 to rail gap GAP_TERMINAL(504.5, 502.0),
    // north along GAP_X=504.5 to GAP_CORRIDOR(504.5, 503.5), east along CORRIDOR_Y=503.5 to TRAINER_CORRIDOR_X(510.2, 503.5),
    // then south along x=510.2 to TRAINER_STAND(510.2, 505.4).
    ctx.note("walking to camp trainer via rail gap anchor GAP_X=504.5 and east corridor x=510.2");
    await walkToCell(ctx, s, GAP_TERMINAL, { withinCells: 0.2 });
    await walkToCell(ctx, s, GAP_CORRIDOR, { withinCells: 0.2 });
    await walkToCell(ctx, s, TRAINER_CORRIDOR_X, { withinCells: 0.2 });
    await walkToCell(ctx, s, TRAINER_STAND, {
      withinCells: 0.25,
      stopIf: (p) => (p.interactions ?? []).some((o) => o.kind === "trainer" && o.targetId === TRAINER_ID),
    });

    await s.waitProbe(
      (p) => (p.interactions ?? []).some((o) => o.kind === "trainer" && o.targetId === TRAINER_ID),
      { label: "trainer interaction chip visible", timeoutMs: 15000 }
    );
    await openExactInteraction(ctx, s, "trainer", TRAINER_ID, CONVERSE_WINDOW, { label: "camp trainer" });
    await ctx.moneyShot("07-trainer-zone", s);
    await s.press("Escape");
    await s.waitDom(CONVERSE_WINDOW, { state: "hidden", timeoutMs: 10000 });

    // Walk back outside via centerline corridor (TRAINER_CORRIDOR_X -> ENTRY_CORRIDOR_NORTH -> ENTRY -> SOUTH_PORTAL -> EXIT_OUTSIDE).
    ctx.note("walking back outside");
    await walkToCell(ctx, s, TRAINER_CORRIDOR_X, { withinCells: 0.2 });
    await walkToCell(ctx, s, ENTRY_CORRIDOR_NORTH, { withinCells: 0.25 });
    await walkToCell(ctx, s, ENTRY, { withinCells: 0.25 });
    await walkToCell(ctx, s, SOUTH_PORTAL, { withinCells: 0.3 });
    await walkToCell(ctx, s, EXIT_OUTSIDE, { withinCells: 0.35 });
    await ctx.moneyShot("08-exit-complete", s);
  }
};
