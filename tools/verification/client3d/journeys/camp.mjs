// Journey: exact raw Bone + Hide → hands-craft Camp Kit through the real craft
// window → walk to a measured footprint-clear site → place shelter → arm
// ten-minute abandonment grace → return cancels the practical teardown path
// → owner pack-up. Exact >10-minute expiry timing and natural creature
// harvesting are covered in authority tests; this browser lane proves the
// ordinary crafting UI, world presentation, and projected countdown.
import { openDockWindow, openInventoryContextAction } from "./_helpers.mjs";

const CAMP_KIT = 3007;
const BONE = 2103;
const HIDE = 2101;
const CAMP_RECIPE = "camp_kit";
// open-desert-slice.json grounded: commerce facility (500,498) 12×9 + collisionBounds
// swallows legacy (500,500); GR0K actor is at (510,514). Authority PlaceCamp needs a
// clear 5×5 shelter box (half-extent 2.5 cells) — plaza-south (512,520) is open ground
// outside buildings, terminals, occupation props, and fixture actors.
const CAMP_SITE_X = 512;
const CAMP_SITE_Y = 520;
// Player-anchor door lane (authority player.x), not door world X.
// Door world X = cellX + 0.5 + 0.5*(5/2.85). Player center = player.x + 0.5, so
// the matching player.x is cellX + 0.5*(5/2.85) ≈ cellX + 0.877.
const CAMP_TEMPLATE_SCALE = 5 / 2.85;
const CAMP_DOOR_LANE_OFFSET_X = 0.5 * CAMP_TEMPLATE_SCALE;
// Player.y whose center sits on the door face (door world Z offset 1.2075*scale).
const CAMP_DOOR_FACE_OFFSET_Y = 1.2075 * CAMP_TEMPLATE_SCALE;
const AUTHORITY_STOP_EPSILON_CELLS = 0.01;
const AUTHORITY_STOP_QUIET_MS = 700;
const PLACEMENT_POSITION_EPSILON_CELLS = 0.03;

export function authorityCellFromPosition(position) {
  const x = Number(position?.x);
  const y = Number(position?.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  // Rust's AuthorityPosition::cell uses div_euclid(1000). World coordinates
  // exposed by the probe are cell units, so Math.floor is the matching
  // quantizer for positive and negative positions alike.
  return { x: Math.floor(x), y: Math.floor(y) };
}

export function placementMatchesMeasuredSite(camp, measuredPosition, placedPlayerPosition, {
  maxPositionDrift = PLACEMENT_POSITION_EPSILON_CELLS,
} = {}) {
  const measuredCell = authorityCellFromPosition(measuredPosition);
  const placementCell = authorityCellFromPosition(placedPlayerPosition);
  const positionDrift = measuredPosition && placedPlayerPosition
    ? Math.hypot(
      Number(placedPlayerPosition.x) - Number(measuredPosition.x),
      Number(placedPlayerPosition.y) - Number(measuredPosition.y),
    )
    : Number.POSITIVE_INFINITY;
  return {
    measuredCell,
    placementCell,
    positionDrift,
    matches: Boolean(
      measuredCell
      && placementCell
      && camp
      && camp.cellX === measuredCell.x
      && camp.cellY === measuredCell.y
      && placementCell.x === measuredCell.x
      && placementCell.y === measuredCell.y
      && Number.isFinite(positionDrift)
      && positionDrift <= maxPositionDrift
    ),
  };
}

function ownedAvailable(oracle, actorId, itemId) {
  return (oracle?.inventory ?? [])
    .filter((row) => row.itemId === itemId && String(row.container).startsWith(actorId))
    .reduce((total, row) => total + Number(row.available ?? row.quantity ?? 0), 0);
}

async function authorityPulse(ctx, s, key, { pulseMs = 460, settleMs = 1800 } = {}) {
  const before = (await s.probe()).authorityPlayer;
  if (!before) {
    await ctx.delay(150);
    return { actor: null, moved: false };
  }

  await s.hold(key, pulseMs);
  const moved = await s.waitProbe(
    (p) => {
      const actor = p.authorityPlayer;
      return actor && Math.hypot(actor.x - before.x, actor.y - before.y) >= 0.03;
    },
    { label: `authority displacement after ${key}`, timeoutMs: settleMs, intervalMs: 100 },
  ).catch(() => null);
  if (moved?.authorityPlayer) return { actor: moved.authorityPlayer, moved: true };

  // A closed/animating door can intentionally consume one presentation-side
  // pulse. Re-read authority truth so the caller can retry without guessing
  // from local prediction or elapsed key time.
  await ctx.delay(250);
  return { actor: (await s.probe()).authorityPlayer, moved: false };
}

export async function waitAuthorityStationary(ctx, s, {
  timeoutMs = 10000,
  quietMs = AUTHORITY_STOP_QUIET_MS,
  epsilonCells = AUTHORITY_STOP_EPSILON_CELLS,
} = {}) {
  // A DOM keyup only requests a zero SetMoveIntent. Under a busy gate that
  // command can sit behind the final positive intent, so elapsed key-hold time
  // is not proof that authority has stopped. Require released local input,
  // drained movement queues (and the latest visible sent move acknowledged),
  // then a quiet authoritative position for real wall time. Idle authority
  // snapshots intentionally retain their last tick, so tick advancement is
  // not a valid stationary signal.
  await s.releaseAll();
  const deadline = Date.now() + timeoutMs;
  let anchor = null;
  let quietSince = null;
  let last = null;
  while (Date.now() < deadline) {
    const probe = await s.probe();
    const actor = probe?.authorityPlayer ?? null;
    const tick = Number(probe?.tick);
    const moveGate = probe?.moveGate ?? null;
    last = { actor, tick, moveGate };
    const pendingMoves = Number(moveGate?.pendingMoves);
    const inFlightMoves = Number(moveGate?.inFlightMoves);
    const latestSentMove = Array.isArray(moveGate?.sentMoveTail)
      ? moveGate.sentMoveTail.at(-1) ?? null
      : null;
    const latestSentReceipt = latestSentMove && Array.isArray(moveGate?.receiptTail)
      ? [...moveGate.receiptTail].reverse().find((receipt) => receipt.commandId === latestSentMove.commandId) ?? null
      : null;
    const latestVisibleMoveSettled = !latestSentMove || latestSentReceipt?.accepted === true;
    const stopObserved = moveGate?.moving === false
      && pendingMoves === 0
      && inFlightMoves === 0
      && moveGate?.sendGateStalled !== true
      && latestVisibleMoveSettled;
    if (!actor || !Number.isFinite(tick) || !stopObserved) {
      anchor = null;
      quietSince = null;
      await ctx.delay(100);
      continue;
    }

    const movedFromAnchor = anchor
      ? (actor.areaId ?? null) !== anchor.areaId
        || Math.hypot(actor.x - anchor.x, actor.y - anchor.y) > epsilonCells
      : true;
    if (movedFromAnchor) {
      anchor = { x: actor.x, y: actor.y, areaId: actor.areaId ?? null };
      quietSince = Date.now();
    } else if (
      quietSince !== null
      && Date.now() - quietSince >= quietMs
    ) {
      return actor;
    }
    await ctx.delay(100);
  }
  s.assert(false, `authority player never settled after release: ${JSON.stringify(last)}`);
  return null;
}

async function moveAuthorityAxisIntoCell(ctx, s, axis, targetCell, {
  timeoutMs = 30000,
  pulseMs = 460,
} = {}) {
  const deadline = Date.now() + timeoutMs;
  let attempts = 0;
  let lastMove = null;
  let lastActor = null;
  while (Date.now() < deadline) {
    const before = (await s.probe()).authorityPlayer;
    if (!before) {
      await ctx.delay(150);
      continue;
    }

    // Aim just inside the near edge of the desired cell. The authority stop
    // intent can trail the positive intent under load, so aiming at the cell's
    // center or far edge unnecessarily increases overshoot risk.
    const currentCell = Math.floor(before[axis]);
    if (currentCell !== targetCell) {
      const target = currentCell < targetCell ? targetCell + 0.05 : targetCell + 0.95;
      lastMove = await moveAuthorityAxisTo(ctx, s, axis, target, {
        tolerance: 0.02,
        timeoutMs: Math.min(22000, Math.max(1000, deadline - Date.now())),
        pulseMs,
      });
      attempts += 1;
    }

    const settled = await waitAuthorityStationary(ctx, s, {
      timeoutMs: Math.min(10000, Math.max(1000, deadline - Date.now())),
    });
    lastActor = settled;
    if (settled && Math.floor(settled[axis]) === targetCell) {
      return { actor: settled, cell: targetCell, attempts, lastMove };
    }
    // A delayed zero intent may carry the pawn through the target cell. Re-read
    // the settled side and make a bounded correction from that authority truth.
  }
  s.assert(
    false,
    `failed to settle authority ${axis} in cell ${targetCell}: ${JSON.stringify({ attempts, lastMove, lastActor })}`,
  );
  return { actor: lastActor, cell: lastActor ? Math.floor(lastActor[axis]) : null, attempts, lastMove };
}

async function moveAuthorityAxisTo(ctx, s, axis, target, {
  tolerance = 0.14,
  timeoutMs = 14000,
  maxPulseMs = 380,
  minPulseMs = 120,
} = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  let pulses = 0;
  let stalls = 0;
  while (Date.now() < deadline) {
    const actor = (await s.probe()).authorityPlayer;
    if (!actor) {
      await ctx.delay(150);
      continue;
    }
    last = actor;
    const delta = target - actor[axis];
    if (Math.abs(delta) <= tolerance) return { actor, pulses, stalls };
    const key = axis === "x"
      ? (delta > 0 ? "KeyD" : "KeyA")
      : (delta > 0 ? "KeyS" : "KeyW");
    const pulseMs = Math.min(maxPulseMs, Math.max(minPulseMs, Math.round(Math.abs(delta) * 500)));
    const result = await authorityPulse(ctx, s, key, { pulseMs });
    pulses += 1;
    stalls += result.moved ? 0 : 1;
    if (result.actor) last = result.actor;
  }
  return { actor: last, pulses, stalls };
}

async function waitCampDoorPassable(s, campId, timeoutMs = 8000) {
  return s.waitProbe(
    (p) => {
      const door = p.campDoors?.[campId];
      return door?.open === true && Number(door.t) >= 0.5;
    },
    { label: `camp door ${campId} passable`, timeoutMs, intervalMs: 100 },
  );
}

async function approachCampCenter(ctx, s, target, { withinCells = 0.85, timeoutMs = 15000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = { x: Number.NaN, y: Number.NaN, distance: Number.POSITIVE_INFINITY };
  while (Date.now() < deadline) {
    let actor = (await s.probe()).authorityPlayer;
    if (!actor) {
      await ctx.delay(150);
      continue;
    }

    let dx = target.x - actor.x;
    let dy = target.y - actor.y;
    last = { x: actor.x, y: actor.y, distance: Math.hypot(dx, dy) };
    if (last.distance <= withinCells) return last;

    // Correct each world axis from a fresh authority position. This avoids
    // treating equal-and-opposite x/y errors as "already home" via x+y.
    if (Math.abs(dx) > 0.25) {
      await s.hold(dx > 0 ? "KeyD" : "KeyA", Math.min(280, Math.max(100, Math.abs(dx) * 35)));
    }

    actor = (await s.probe()).authorityPlayer;
    if (!actor) continue;
    dx = target.x - actor.x;
    dy = target.y - actor.y;
    last = { x: actor.x, y: actor.y, distance: Math.hypot(dx, dy) };
    if (last.distance <= withinCells) return last;
    if (Math.abs(dy) > 0.25) {
      await s.hold(dy > 0 ? "KeyS" : "KeyW", Math.min(280, Math.max(100, Math.abs(dy) * 35)));
    }
  }
  await s.releaseAll();
  const actor = (await s.probe()).authorityPlayer;
  return actor
    ? { x: actor.x, y: actor.y, distance: Math.hypot(target.x - actor.x, target.y - actor.y) }
    : last;
}

async function leaveCampPresenceRadius(ctx, s, origin, camp, { beyondCells = 6.5, timeoutMs = 30000 } = {}) {
  // Pod-tent door faces +Y (south). Align the PLAYER ANCHOR on the door lane
  // (player.x = cellX + 0.5*scale so player center matches door world X), step
  // the player center onto the door face, wait for the panel blocker to clear,
  // then cross south in canonical KeyS pulses. Every pulse must produce fresh
  // authority displacement; elapsed key time is never proof of leaving.
  const laneX = camp.cellX + CAMP_DOOR_LANE_OFFSET_X;
  const doorFaceY = camp.cellY + CAMP_DOOR_FACE_OFFSET_Y;
  const aligned = await moveAuthorityAxisTo(ctx, s, "x", laneX, {
    tolerance: 0.14,
    timeoutMs: 18000,
    maxPulseMs: 380,
  });
  const alignedActor = aligned.actor;
  s.assert(
    alignedActor && Math.abs(alignedActor.x - laneX) <= 0.18,
    `failed to align with camp doorway x=${laneX}: ${JSON.stringify(aligned)}`,
  );
  await waitAuthorityStationary(ctx, s, { timeoutMs: 4000, quietMs: 400, epsilonCells: 0.02 });

  // Approach the door face so the auto-door trigger engages (center of tent is
  // outside the 2.5-cell open radius of the south door).
  const nearDoor = await moveAuthorityAxisTo(ctx, s, "y", doorFaceY - 0.35, {
    tolerance: 0.12,
    timeoutMs: 16000,
    maxPulseMs: 380,
  });
  s.assert(
    nearDoor.actor && nearDoor.actor.y >= camp.cellY + 1.2,
    `failed to approach camp door face before leave: ${JSON.stringify(nearDoor)}`,
  );
  // Re-seat x after the y walk so diagonal drift cannot walk the wall.
  const reseated = await moveAuthorityAxisTo(ctx, s, "x", laneX, {
    tolerance: 0.14,
    timeoutMs: 10000,
    maxPulseMs: 300,
  });
  s.assert(
    reseated.actor && Math.abs(reseated.actor.x - laneX) <= 0.18,
    `failed to re-seat camp doorway x=${laneX}: ${JSON.stringify(reseated)}`,
  );
  await waitCampDoorPassable(s, camp.campId);

  const deadline = Date.now() + timeoutMs;
  let last = { x: Number.NaN, y: Number.NaN, distance: 0 };
  let pulses = 0;
  let stalls = 0;
  while (Date.now() < deadline) {
    const actor = (await s.probe()).authorityPlayer;
    if (!actor) {
      await ctx.delay(150);
      continue;
    }
    const dx = actor.x - origin.x;
    const dy = actor.y - origin.y;
    const distance = Math.hypot(dx, dy);
    if (distance >= beyondCells) return { x: actor.x, y: actor.y, distance, pulses, stalls };

    last = { x: actor.x, y: actor.y, distance };
    // Keep the door lane while driving south so wall collisions do not pin y.
    if (Math.abs(actor.x - laneX) > 0.18) {
      const correct = await authorityPulse(ctx, s, actor.x > laneX ? "KeyA" : "KeyD", { pulseMs: 180 });
      pulses += 1;
      stalls += correct.moved ? 0 : 1;
      continue;
    }
    const result = await authorityPulse(ctx, s, "KeyS", { pulseMs: 400 });
    pulses += 1;
    stalls += result.moved ? 0 : 1;
  }
  await s.releaseAll();
  const actor = (await s.probe()).authorityPlayer;
  return actor
    ? { x: actor.x, y: actor.y, distance: Math.hypot(actor.x - origin.x, actor.y - origin.y), pulses, stalls }
    : { ...last, pulses, stalls };
}

async function returnThroughCampDoor(ctx, s, origin, camp) {
  const laneX = camp.cellX + CAMP_DOOR_LANE_OFFSET_X;
  const aligned = await moveAuthorityAxisTo(ctx, s, "x", laneX, { tolerance: 0.14, timeoutMs: 16000 });
  s.assert(
    aligned.actor && Math.abs(aligned.actor.x - laneX) <= 0.18,
    `failed to align for camp return x=${laneX}: ${JSON.stringify(aligned)}`,
  );

  // Stop safely outside but within the 2.5-cell auto-door trigger, wait for
  // the panel blocker to clear, then cross to an interior point before doing
  // the final exact-center correction.
  const outsideDoorY = camp.cellY + 3.15;
  const approached = await moveAuthorityAxisTo(ctx, s, "y", outsideDoorY, {
    tolerance: 0.14,
    timeoutMs: 18000,
    maxPulseMs: 420,
  });
  s.assert(
    approached.actor && Math.abs(approached.actor.y - outsideDoorY) <= 0.18,
    `failed to reach camp door approach y=${outsideDoorY}: ${JSON.stringify(approached)}`,
  );
  await waitCampDoorPassable(s, camp.campId);

  const crossed = await moveAuthorityAxisTo(ctx, s, "y", camp.cellY + 0.35, {
    tolerance: 0.14,
    timeoutMs: 18000,
    maxPulseMs: 420,
  });
  s.assert(
    crossed.actor && crossed.actor.y <= camp.cellY + 0.53,
    `failed to cross camp doorway: ${JSON.stringify(crossed)}`,
  );
  return approachCampCenter(ctx, s, origin, { withinCells: 0.85, timeoutMs: 12000 });
}

async function moveToVisibleCampPackUpPoint(ctx, s, placementPosition, camp) {
  // The rendered tent is centered on the streamed cell center. Stand inside
  // its front doorway, but deliberately farther than the retired 1.5-cell
  // radial gate from the exact fine-coordinate placement point.
  // Actor anchors (not door world faces): lane x ≈ cellX+0.877, door-face y ≈ cellY+2.118.
  const target = {
    x: camp.cellX + CAMP_DOOR_LANE_OFFSET_X,
    y: camp.cellY + CAMP_DOOR_FACE_OFFSET_Y,
  };
  await waitCampDoorPassable(s, camp.campId);
  const aligned = await moveAuthorityAxisTo(ctx, s, "x", target.x, {
    tolerance: 0.14,
    timeoutMs: 12000,
  });
  s.assert(
    aligned.actor && Math.abs(aligned.actor.x - target.x) <= 0.18,
    `failed to align with the camp doorway pack-up point: ${JSON.stringify({ target, aligned })}`,
  );
  const moved = await moveAuthorityAxisTo(ctx, s, "y", target.y, {
    tolerance: 0.14,
    timeoutMs: 12000,
  });
  s.assert(moved.actor, `authority player absent after pack-up axis move: ${JSON.stringify(moved)}`);
  // Residual post-move authority drift can push the actor past the visible
  // 5×5 half-extent before F. Measure pack-up stance only after stop settles.
  const actor = await waitAuthorityStationary(ctx, s, {
    timeoutMs: 4000,
    quietMs: 400,
    epsilonCells: 0.02,
  });
  s.assert(actor, `authority player absent at visible camp pack-up point: ${JSON.stringify(moved)}`);
  const visibleCenter = { x: camp.cellX + 0.5, y: camp.cellY + 0.5 };
  return {
    actor,
    target,
    visibleCenter,
    distanceFromPlacement: Math.hypot(
      actor.x - placementPosition.x,
      actor.y - placementPosition.y,
    ),
    insideVisibleFootprint:
      Math.abs(actor.x - visibleCenter.x) <= 2.5
      && Math.abs(actor.y - visibleCenter.y) <= 2.5,
  };
}

export default {
  id: "camp",
  title: "Camp craft / clear-site shelter / pack up",
  timeoutMs: 180000,
  characters: [{
    role: "primary",
    id: "h3d-camp-probe",
    name: "ProbeCamp",
    x: CAMP_SITE_X,
    y: CAMP_SITE_Y,
    initialProfessionId: "scout",
    skillBoxIds: ["scout-novice"],
  }],
  async arm(ctx) {
    await ctx.debugCommand({ DebugGiveItem: { item_id: BONE, variant_id: 700, quantity: 24 } });
    await ctx.debugCommand({ DebugGiveItem: { item_id: HIDE, variant_id: 700, quantity: 36 } });
    ctx.note("Scout starter allocation + exactly Bone ×24 and Hide ×36 (no debug-granted Camp Kit)");
  },
  async run(ctx) {
    const s = ctx.primary;
    await ctx.moneyShot("00-spawn");

    const startActor = (await s.oracle()).actors?.[s.actorId];
    const startBoxes = (startActor?.professions ?? []).flatMap((profession) => profession.skillBoxes ?? []);
    s.assert(startActor?.skillPointsUsed === 16, `Scout starter SP ${startActor?.skillPointsUsed} != 16`);
    s.assert(JSON.stringify(startBoxes) === JSON.stringify(["scout-novice"]), `Scout starter boxes drifted: ${JSON.stringify(startBoxes)}`);

    // CRAFT — enter through the carried raw-resource context action, then
    // drive every real four-phase surface. The fixture provides only the exact
    // recipe inputs; there is no finished-kit debug grant.
    const beforeCraft = await s.oracle();
    const initialKits = ownedAvailable(beforeCraft, s.actorId, CAMP_KIT);
    const initialBone = ownedAvailable(beforeCraft, s.actorId, BONE);
    const initialHide = ownedAvailable(beforeCraft, s.actorId, HIDE);
    s.assert(initialKits === 0, `expected no prebuilt Camp Kit before ordinary craft, got ${initialKits}`);
    s.assert(initialBone === 24, `expected exact Bone ×24 before craft, got ${initialBone}`);
    s.assert(initialHide === 36, `expected exact Hide ×36 before craft, got ${initialHide}`);
    ctx.note(`raw camp inputs exact; Camp Kit baseline=${initialKits}`);
    await openDockWindow(s, "inventory");
    await Promise.all([BONE, HIDE].map((itemId) => s.waitDom(
      `.inv-slot[data-item-id="${itemId}"]`,
      { state: "visible", timeoutMs: 15000 },
    )));
    await ctx.moneyShot("00-resource-container-glyphs");

    await openInventoryContextAction(s, BONE, "craft");
    await s.waitDom('.sc3d-window[data-window="craft"]', { state: "visible", timeoutMs: 8000 });
    await s.waitDom(`.scp-craft-recipe[data-recipe-id="${CAMP_RECIPE}"]`, { state: "visible", timeoutMs: 12000 });
    await s.click(`.scp-craft-recipe[data-recipe-id="${CAMP_RECIPE}"]`);
    await s.waitDom(`.scp-craft-recipe[data-recipe-id="${CAMP_RECIPE}"][data-selected]`, { state: "attached", timeoutMs: 8000 });
    await s.waitDom('.scp-craft-browse [data-ref="begin"]:not([disabled])', { state: "attached", timeoutMs: 8000 });
    await s.page.waitForFunction(() => {
      const text = Array.from(document.querySelectorAll(".scp-craft-req"))
        .map((el) => el.textContent ?? "")
        .join(" | ");
      return /Bone\s*\(×24\)/.test(text)
        && /Hide\s*\(×36\)/.test(text)
        && (text.match(/READY/g) ?? []).length >= 2;
    }, null, { timeout: 8000 });
    const browseReqs = await s.page.$$eval(".scp-craft-req", (els) => els.map((el) => el.textContent ?? ""));
    s.assert(
      browseReqs.some((line) => /Bone\s*\(×24\)/.test(line) && /24 carried/.test(line) && /READY/.test(line))
        && browseReqs.some((line) => /Hide\s*\(×36\)/.test(line) && /36 carried/.test(line) && /READY/.test(line)),
      `Camp Kit requirements did not show exact ready inputs: ${browseReqs.join(" | ")}`,
    );
    ctx.note("Camp Kit browse shows Bone ×24 and Hide ×36 together, both READY");
    await ctx.moneyShot("01-camp-kit-browse");
    await s.click('.scp-craft-browse [data-ref="begin"]');

    await s.waitDom('[data-ref="slotsSurface"]:not([hidden])', { state: "attached", timeoutMs: 10000 });
    let assembleReady = false;
    for (let attempt = 0; attempt < 4 && !assembleReady; attempt += 1) {
      const load = s.page.locator(".scp-craft-opt-load:not([disabled])").first();
      s.assert(await load.count() > 0, `no enabled LOAD control on Camp Kit slot attempt ${attempt + 1}`);
      await load.click({ timeout: 6000 });
      await ctx.delay(900);
      assembleReady = await s.page.locator('[data-ref="assemble"]:not([disabled])').count() > 0;
    }
    s.assert(assembleReady, "ASSEMBLE never armed for the exact Camp Kit inputs");
    ctx.note("Camp Kit slots filled through ordinary single-click LOAD controls");
    await ctx.moneyShot("02-camp-kit-slots");

    await s.click('[data-ref="assemble"]');
    await s.waitDom('[data-ref="finishSurface"]:not([hidden])', { state: "attached", timeoutMs: 12000 });
    await s.waitDom('[data-ref="toFinish"]:not([disabled])', { state: "attached", timeoutMs: 8000 });
    await s.click('[data-ref="toFinish"]');
    await s.waitDom('[data-ref="finishGo"]:not([disabled])', { state: "attached", timeoutMs: 8000 });
    await ctx.moneyShot("03-camp-kit-assembled");
    await s.click('[data-ref="finishGo"]');
    const crafted = await s.waitProbeCall(
      () => s.oracle(),
      (oracle) => ownedAvailable(oracle, s.actorId, CAMP_KIT) === initialKits + 1
        && ownedAvailable(oracle, s.actorId, BONE) === 0
        && ownedAvailable(oracle, s.actorId, HIDE) === 0,
      { label: "Camp Kit crafted and exact raw inputs consumed", timeoutMs: 12000 },
    );
    const craftedKits = ownedAvailable(crafted, s.actorId, CAMP_KIT);
    ctx.note(`Camp Kit crafted through UI: ${initialKits}→${craftedKits}; Bone 24→0; Hide 36→0`);
    await ctx.moneyShot("04-camp-kit-crafted");

    // Close the craft and inventory windows before authority movement.
    await s.press("Escape");
    await ctx.delay(250);
    await s.press("Escape");
    await ctx.delay(250);

    // SITE — settle at measured plaza-south (512,520). Base shelter footprint
    // is 5×5 cells; slice collision + GR0K/(510,514) make legacy (500,500) reject
    // with structure_footprint_blocked after commerce/occupation props landed.
    const siteX = await moveAuthorityAxisIntoCell(ctx, s, "x", CAMP_SITE_X, { timeoutMs: 30000 });
    const siteY = await moveAuthorityAxisIntoCell(ctx, s, "y", CAMP_SITE_Y, { timeoutMs: 30000, pulseMs: 500 });
    s.assert(siteX.actor, `authority player absent while reaching camp-site x: ${JSON.stringify(siteX)}`);
    s.assert(siteY.actor, `authority player absent while reaching camp-site y: ${JSON.stringify(siteY)}`);
    // Reconfirm both axes together. The y traversal must not inherit an x
    // movement intent, and the placement command must not race a trailing stop.
    const measuredSite = await waitAuthorityStationary(ctx, s);
    const measuredCell = authorityCellFromPosition(measuredSite);
    s.assert(
      measuredCell?.x === CAMP_SITE_X && measuredCell?.y === CAMP_SITE_Y,
      `settled camp site quantized outside measured clear cell ${CAMP_SITE_X},${CAMP_SITE_Y}: ${JSON.stringify({ measuredSite, measuredCell, siteX, siteY })}`,
    );
    ctx.note(`settled footprint-clear site reached at ${measuredSite.x.toFixed(3)},${measuredSite.y.toFixed(3)} → cell ${measuredCell.x},${measuredCell.y}`);

    // PLACE — a server-owned camp appears with an auto-door only after the
    // complete rendered/shelter footprint passes authority collision checks.
    await s.slash("/place-camp");
    const placed = await s.waitProbe(
      (p) => (p.placedCamps ?? []).some((c) => c.isOwner),
      { label: "camp placed", timeoutMs: 10000 },
    );
    const camp = placed.placedCamps.find((c) => c.isOwner);
    const placementContract = placementMatchesMeasuredSite(camp, measuredSite, placed.authorityPlayer);
    s.assert(
      placementContract.matches,
      `camp placement diverged from settled measured site: ${JSON.stringify({ camp, measuredSite, placedPlayer: placed.authorityPlayer, placementContract })}`,
    );
    s.assert(camp.areaId === measuredSite.areaId, `camp area ${camp.areaId} != measured area ${measuredSite.areaId}`);
    s.assert(camp.renderKind === "scout-camp", `unexpected camp render kind ${JSON.stringify(camp.renderKind)}`);
    s.assert(placed.placedCamps.filter((entry) => entry.isOwner).length === 1, "placement did not project exactly one owner camp");
    const afterPlace = await s.waitProbeCall(
      () => s.oracle(),
      (oracle) => ownedAvailable(oracle, s.actorId, CAMP_KIT) === initialKits
        && ownedAvailable(oracle, s.actorId, BONE) === 0
        && ownedAvailable(oracle, s.actorId, HIDE) === 0
        && (oracle.placedCamps ?? []).some(
          (entry) => entry.campId === camp.campId && entry.cellX === measuredCell.x && entry.cellY === measuredCell.y,
        ),
      { label: "placed Camp Kit consumed with raw inputs still exhausted", timeoutMs: 10000 },
    );
    s.assert(
      (afterPlace.placedCamps ?? []).some((entry) => entry.campId === camp.campId && entry.cellX === measuredCell.x && entry.cellY === measuredCell.y),
      `oracle missing placed camp snapshot at measured cell: ${JSON.stringify(afterPlace.placedCamps ?? [])}`,
    );
    const campPosition = { x: measuredSite.x, y: measuredSite.y };
    ctx.note(`camp ${camp.campId} accepted at settled position ${campPosition.x.toFixed(3)},${campPosition.y.toFixed(3)} → projected cell ${camp.cellX},${camp.cellY}; placement drift=${placementContract.positionDrift.toFixed(3)}; Camp Kit ${craftedKits}→${initialKits}; door ${JSON.stringify(placed.campDoors?.[camp.campId] ?? null)}`);
    await ctx.moneyShot("05-camp-placed-clear-site");

    // ABANDON — walk >6 cells away; the abandonment grace countdown arms.
    const departed = await leaveCampPresenceRadius(ctx, s, campPosition, camp);
    await s.releaseAll();
    s.assert(departed.distance >= 6.5, `failed to leave camp presence radius: ${JSON.stringify(departed)}`);
    ctx.note(`departed ${departed.distance.toFixed(2)} cells from authority camp position at ${departed.x.toFixed(2)},${departed.y.toFixed(2)}`);
    const abandoned = await s.waitProbe(
      (p) => { const c = (p.placedCamps ?? []).find((x) => x.isOwner); return c && c.abandonSecondsRemaining != null; },
      { label: "abandon countdown armed", timeoutMs: 12000 },
    );
    const abandonSecondsRemaining = Number(abandoned.placedCamps.find((c) => c.isOwner)?.abandonSecondsRemaining);
    s.assert(
      Number.isFinite(abandonSecondsRemaining) && abandonSecondsRemaining > 0 && abandonSecondsRemaining <= 600,
      `camp abandonment countdown outside 1..600 seconds: ${JSON.stringify(abandonSecondsRemaining)}`,
    );
    ctx.note(`abandon countdown armed at ${abandonSecondsRemaining}s`);
    await ctx.moneyShot("06-abandon-countdown");

    // RETURN through the real automatic doorway so the abandonment countdown
    // clears, then stand near the visible front edge. This point is inside the
    // rendered 5×5 footprint but intentionally outside the retired 1.5-cell
    // radial gate around the fine-coordinate placement point.
    const target = campPosition;
    const returned = await returnThroughCampDoor(ctx, s, target, camp);
    await s.releaseAll();
    s.assert(returned.distance <= 0.85, `failed to return through camp door: ${JSON.stringify(returned)}`);
    const reentered = await s.waitProbe(
      (p) => {
        const c = (p.placedCamps ?? []).find((x) => x.isOwner && x.campId === camp.campId);
        return c && c.abandonSecondsRemaining == null;
      },
      { label: "camp abandonment countdown cleared after re-entry", timeoutMs: 8000 },
    );
    const reenteredCamp = reentered.placedCamps.find((c) => c.isOwner && c.campId === camp.campId);
    s.assert(reenteredCamp?.abandonSecondsRemaining == null, `camp countdown still armed after re-entry: ${JSON.stringify(reenteredCamp)}`);

    const packUpPoint = await moveToVisibleCampPackUpPoint(ctx, s, campPosition, camp);
    await s.releaseAll();
    s.assert(
      packUpPoint.insideVisibleFootprint,
      `pack-up proof point escaped the visible 5×5 camp footprint: ${JSON.stringify(packUpPoint)}`,
    );
    s.assert(
      packUpPoint.distanceFromPlacement > 1.5,
      `pack-up proof point still satisfies the retired radial gate: ${JSON.stringify(packUpPoint)}`,
    );
    await s.waitProbe(
      (p) => (p.interactions ?? []).some((option) => option.kind === "camp" && option.targetId === camp.campId),
      { label: "camp F-chip offered inside visible footprint beyond old radial gate", timeoutMs: 5000 },
    );
    ctx.note(
      `inside visible footprint at ${packUpPoint.actor.x.toFixed(2)},${packUpPoint.actor.y.toFixed(2)}; `
      + `${packUpPoint.distanceFromPlacement.toFixed(2)} cells from fine placement (> retired 1.5 gate)`,
    );

    // Money shot before arming: the 4s PACK_UP_ARM_WINDOW starts on first F,
    // and a slow screenshot between F presses can expire the confirm.
    await ctx.moneyShot("07-pack-up-inside-footprint");
    // Exercise the player-facing two-step F flow, not a slash-command shortcut.
    await s.press("KeyF");
    await ctx.delay(250);
    await s.press("KeyF");
    const struck = await s.waitProbe(
      (p) => !(p.placedCamps ?? []).some((c) => c.isOwner),
      { label: "camp struck from visible footprint", timeoutMs: 8000 },
    );
    ctx.note(`packed up through F-confirm; struck=${struck !== null}`);
    await ctx.moneyShot("08-packed-up");
    s.assert(struck, "camp was not struck from inside its visible 5×5 footprint");
    await s.waitProbeCall(
      () => s.oracle(),
      (oracle) => !(oracle.placedCamps ?? []).some((entry) => entry.campId === camp.campId)
        && ownedAvailable(oracle, s.actorId, CAMP_KIT) === initialKits,
      { label: "packed camp removed without returning its consumed kit", timeoutMs: 8000 },
    );
  },
};
