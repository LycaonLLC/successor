// Journey: BANK + BACKUP + DEATH + CLONE + CORPSE two-browser lifecycle.
//
// The keeper banks credits at the Dustgate vault terminal (DEPOSIT /
// WITHDRAW on the credits rail) and moves full item stacks through the
// current vault-grid BANK window (native inventory drag deposit + vault
// slot double-click retrieve — full stacks only). Then buys a skill
// backup at the clone terminal (SAVE BACKUP), then the hunter duels the
// keeper to a LETHAL death through the honest 3-strike incap rule (three
// real duel downs inside the incap window — no debug kill). The keeper
// activates a clone from the visible YOU DIED overlay, respawns at the
// cloning facility, walks BACK to its own public corpse bag, physically
// double-clicks the rendered bag on the canvas (probe-published screen
// coordinates → the real raycast picker route), and recovers corpse-side
// items and credits through the LOOT window's per-stack double-click,
// TAKE ALL, and TAKE CREDITS controls while vaulted stacks stay vaulted.
//
// Fixture seeding only: exact inventory via the pre-entry verification
// loadout, exact credits via the character store professions record. No
// debug authority commands anywhere.
//
// Money shots: vault-linked bank, backup saved, lethal death overlay,
// clone-side corpse view (hunter), corpse double-clicked loot window,
// recovered inventory.
import { openDockWindow } from "./_helpers.mjs";
import { waitAuthorityStationary } from "./camp.mjs";

const KEEPER = "h3d-bcc-keeper";
const HUNTER = "h3d-bcc-hunter";
const STIMPAK = 1001;
const BANDAGE = 1002;
const SLUGTHROWER = 3101; // crafted slugthrower weapon item
const IRON_SLUG = 1101; // slug_iron ammo item
const START_CREDITS = 1400;
const BANK = '.sc3d-window[data-window="bank"]';
const INVENTORY = '.sc3d-window[data-window="inventory"]';
const CLONE = '.sc3d-window[data-window="clone-terminal"]';
const LOOT = '.sc3d-window[data-window="loot"]';
const BANK_CELL = { x: 504.2, y: 502.2 };
const COMMERCE_FACILITY_ID = "dustgate-commerce-facility";
const COMMERCE_SOUTH_PORTAL = { x: 506, y: 508.5 };
const COMMERCE_ENTRY = { x: 506, y: 505.8 };
// Axis-separated commerce route pinned to global project contract (CORRIDOR_Y=503.5, WEST_LANE_X=501.3, TERMINAL_Y=502.0):
// Entry (506.0,505.8) -> north to ENTRY_CORRIDOR_NORTH (506.0,503.5) -> west to WEST_CORRIDOR (501.3,503.5)
// -> north to NORTH_OF_COUNTER (501.3,502.0) -> east to BANK_STAND (502.0,502.0).
const COMMERCE_ENTRY_CORRIDOR_NORTH = { x: 506.0, y: 503.5 };
const COMMERCE_WEST_CORRIDOR = { x: 501.3, y: 503.5 };
const COMMERCE_NORTH_OF_COUNTER = { x: 501.3, y: 502.0 };
const COMMERCE_BANK_STAND = { x: 502.0, y: 502.0 };
const CLONE_TERMINAL_CELL = { x: 518, y: 502 };
const CLONE_FACILITY_ID = "dustgate-cloning-facility";
const CLONE_RESPAWN_CELL = { x: 519, y: 503 };
// Exterior south lane for clone facility — diagonal plaza→portal clips commerce SE corner.
const CLONE_SOUTH_LANE = { x: 518.5, y: 512 };
const CLONE_SOUTH_PORTAL = { x: 518.5, y: 508.5 };
const CLONE_ENTRY = { x: 518.5, y: 506 };
// Terminal collider ~518.18-518.82/502.18-502.82; interaction uses centers.
// Left stand actor (516.8,502.2) → center ~517.3,502.7 ≈1.22 from terminal center 518.5,502.5.
const CLONE_CLEAR_LEFT = { x: 516.8, y: 504.8 };
const CLONE_TERMINAL_STAND = { x: 516.8, y: 502.2 };
const DUEL_CELL = { x: 512, y: 512 };

/** Wallet credits of an actor from the server oracle. */
function credits(oracle, actorId) {
  return oracle?.actors?.[actorId]?.credits ?? null;
}

/** First oracle inventory row for itemId inside a container prefix. */
function row(oracle, containerPrefix, itemId) {
  return (oracle?.inventory ?? []).find(
    (r) => r.itemId === itemId && String(r.container).startsWith(containerPrefix) && (r.available ?? 0) > 0,
  ) ?? null;
}

/** Walk with real WASD toward an authority cell until within reach. */
async function walkToCell(ctx, s, target, { withinCells = 1.3, timeoutMs = 25000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const p = await s.probe();
    const dx = target.x - (p?.playerCell?.x ?? 0);
    const dy = target.y - (p?.playerCell?.y ?? 0);
    const dist = Math.hypot(dx, dy);
    if (dist <= withinCells) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) break;
      let settled = null;
      try {
        settled = await waitAuthorityStationary(ctx, s, { timeoutMs: remainingMs });
      } catch {
        break;
      }
      const settledDist = Math.hypot(target.x - (settled?.x ?? 0), target.y - (settled?.y ?? 0));
      if (settledDist <= withinCells) return settledDist;
      continue;
    }
    const keys = [];
    if (dy > 0.3) keys.push("KeyS"); else if (dy < -0.3) keys.push("KeyW");
    if (dx > 0.3) keys.push("KeyD"); else if (dx < -0.3) keys.push("KeyA");
    // Both axes inside the 0.3 deadzone but still outside withinCells: nudge the
    // dominant remaining axis toward the target (never unconditional KeyS).
    if (keys.length === 0) {
      if (Math.abs(dx) >= Math.abs(dy)) keys.push(dx >= 0 ? "KeyD" : "KeyA");
      else keys.push(dy >= 0 ? "KeyS" : "KeyW");
    }
    await s.hold(keys, Math.min(600, Math.max(120, Math.round(dist * 200))));
  }
  const p = await s.probe();
  throw new Error(`walkToCell(${target.x},${target.y}) timed out at (${p?.playerCell?.x},${p?.playerCell?.y})`);
}

/**
 * Open a terminal window through the real F interact verb. Waits until the
 * terminal joins the interaction options, presses F, and if another option
 * held the selection, cycles it with the real V key and retries.
 */
async function openTerminalWithF(ctx, s, kind, windowSel) {
  await s.waitProbe(
    (p) => (p.interactions ?? []).some((o) => o.kind === kind),
    { label: `${kind} interactable`, timeoutMs: 10000 },
  );
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await s.press("KeyF");
    const open = await s.waitDom(windowSel, { state: "visible", timeoutMs: 2500 }).then(() => true).catch(() => false);
    if (open) return;
    await s.press("KeyV"); // cycle the interact selection to the terminal
  }
  const interactions = (await s.probe())?.interactions ?? [];
  throw new Error(`F never opened ${windowSel}; interactions=${JSON.stringify(interactions.map((o) => `${o.kind}:${o.targetId}`))}`);
}

/**
 * Capture authorityReceiptTail commandIds, run a real UI/slash action, then
 * require a fresh accepted receipt of exact `kind` not present in the baseline.
 * Prevents stale-kind matches from earlier bank/door/clone actions.
 */
async function performWithAcceptedReceipt(s, kind, action, { timeoutMs = 10000 } = {}) {
  const baseline = new Set(
    ((await s.probe())?.authorityReceiptTail ?? []).map((entry) => entry.commandId),
  );
  await action();
  const probe = await s.waitProbe(
    (p) => (p.authorityReceiptTail ?? []).some((r) => (
      r.kind === kind
      && r.accepted
      && !baseline.has(r.commandId)
    )),
    { label: `fresh ${kind} accepted receipt`, timeoutMs },
  );
  const receipt = (probe.authorityReceiptTail ?? []).find((r) => (
    r.kind === kind && r.accepted && !baseline.has(r.commandId)
  ));
  s.assert(receipt, `expected fresh accepted ${kind} receipt after action`);
  return receipt;
}

/**
 * Ensure a facility south portal is open from oracle propStates[id].doorOpen.
 * Only issues /toggle-door when closed; requires a fresh accepted ToggleDoor
 * receipt and doorOpen true. Never blind-toggles an already-open door.
 */
async function ensureFacilityDoorOpen(ctx, s, facilityId) {
  const oracle = await s.oracle();
  if (oracle?.propStates?.[facilityId]?.doorOpen === true) {
    ctx.note(`${facilityId} already open — skip ToggleDoor`);
    return;
  }
  const receipt = await performWithAcceptedReceipt(
    s,
    "ToggleDoor",
    () => s.slash(`/toggle-door prop_id=${facilityId}`),
  );
  await s.waitProbeCall(
    () => s.oracle(),
    (o) => o?.propStates?.[facilityId]?.doorOpen === true,
    { label: `${facilityId} doorOpen true`, timeoutMs: 10000 },
  );
  ctx.note(`${facilityId} opened via ToggleDoor command=${receipt.commandId}`);
}

/**
 * Bank terminal lives inside dustgate-commerce-facility. Direct WASD from the
 * plaza into (503,501) hits the closed shell — ensure the south portal is open
 * (only ToggleDoor when oracle says closed), step the clear centerline, then
 * aisle around the queue rail to the bank stand and F-open the terminal.
 * Exit leaves the door alone so a later re-entry does not flip an open shell shut.
 */

async function enterCommerceBank(ctx, s) {
  // Diagonal plaza→portal clips the commerce SE corner (~511.7,511.4). Stay on
  // the clear exterior south lane first (west along y≈512 to x=506), then north
  // to the south portal mouth.
  await walkToCell(ctx, s, { x: 506, y: 512 }, { withinCells: 0.5, timeoutMs: 30000 });
  await walkToCell(ctx, s, COMMERCE_SOUTH_PORTAL, { withinCells: 0.5, timeoutMs: 30000 });
  await ensureFacilityDoorOpen(ctx, s, COMMERCE_FACILITY_ID);
  await walkToCell(ctx, s, COMMERCE_ENTRY, { withinCells: 0.35, timeoutMs: 20000 });
  // Centerline south of the queue rail leaves the player ~2.4 cells from the
  // terminal center (player center vs 503.5,501.5) — outside the 1.75 reach.
  // vestibule_pier_left blocks a direct west cut at y≈505.5; go north at x≈506
  // past pier/column (lane y≈503.5), west into the aisle, then north to the bank
  // stand. Corridor tolerances only; real bankTerminal F is the acceptance.
  await walkToCell(ctx, s, COMMERCE_ENTRY_CORRIDOR_NORTH, { withinCells: 0.25, timeoutMs: 20000 });
  await walkToCell(ctx, s, COMMERCE_WEST_CORRIDOR, { withinCells: 0.25, timeoutMs: 20000 });
  await walkToCell(ctx, s, COMMERCE_NORTH_OF_COUNTER, { withinCells: 0.25, timeoutMs: 20000 });
  await walkToCell(ctx, s, COMMERCE_BANK_STAND, { withinCells: 0.25, timeoutMs: 20000 });
  await openTerminalWithF(ctx, s, "bankTerminal", BANK);
}

/** Reverse the south-portal route back out to the town plaza. */
async function exitCommerceToPlaza(ctx, s) {
  // Reverse exact axis-separated route: west to NORTH_OF_COUNTER -> south to WEST_CORRIDOR
  // -> east to ENTRY_CORRIDOR_NORTH -> portal -> plaza.
  await walkToCell(ctx, s, COMMERCE_NORTH_OF_COUNTER, { withinCells: 0.25, timeoutMs: 20000 });
  await walkToCell(ctx, s, COMMERCE_WEST_CORRIDOR, { withinCells: 0.25, timeoutMs: 20000 });
  await walkToCell(ctx, s, COMMERCE_ENTRY_CORRIDOR_NORTH, { withinCells: 0.25, timeoutMs: 20000 });
  await walkToCell(ctx, s, COMMERCE_ENTRY, { withinCells: 0.35, timeoutMs: 20000 });
  await walkToCell(ctx, s, COMMERCE_SOUTH_PORTAL, { withinCells: 0.5, timeoutMs: 20000 });
  await walkToCell(ctx, s, { x: 512, y: 512 }, { withinCells: 0.8, timeoutMs: 30000 });
}

/** Plaza → clone south portal via exterior south lane (east then north). */
async function approachCloneSouthPortal(ctx, s) {
  await walkToCell(ctx, s, CLONE_SOUTH_LANE, { withinCells: 0.5, timeoutMs: 30000 });
  await walkToCell(ctx, s, CLONE_SOUTH_PORTAL, { withinCells: 0.5, timeoutMs: 30000 });
}

/** Clone interior → plaza via south portal then south lane (south then west). */
async function exitCloneToPlaza(ctx, s) {
  await walkToCell(ctx, s, CLONE_ENTRY, { withinCells: 0.35, timeoutMs: 20000 });
  await walkToCell(ctx, s, CLONE_SOUTH_PORTAL, { withinCells: 0.5, timeoutMs: 20000 });
  await walkToCell(ctx, s, CLONE_SOUTH_LANE, { withinCells: 0.5, timeoutMs: 20000 });
  await walkToCell(ctx, s, { x: 512, y: 512 }, { withinCells: 0.8, timeoutMs: 30000 });
}


/**
 * Visible vault-grid proof from the real BANK window. Private vault rows never
 * enter the global oracle. Bank createSlot stamps data-key + data-stack (not
 * data-item-id). Prefer authority key embed `:itemId:` (loot/inventory grammar);
 * vault keys are currently `vault:${stackId}`, so also accept aria noun + count.
 */
const VAULT_ITEM_ARIA_NOUN = {
  [STIMPAK]: "Stimpak",
  [BANDAGE]: "Bandage",
};

function vaultSlotSelector(itemId) {
  return `${BANK} .inv-slot[data-key*=":${itemId}:"]`;
}

async function waitVaultSlot(s, itemId, available, { timeoutMs = 10000 } = {}) {
  const bankSel = JSON.stringify(BANK);
  const keyNeedle = JSON.stringify(`:${itemId}:`);
  const noun = VAULT_ITEM_ARIA_NOUN[itemId];
  s.assert(noun, `vault aria noun map missing itemId ${itemId}`);
  const nounLit = JSON.stringify(noun);
  const expectedAriaQty = JSON.stringify(`, ${available} in vault`);
  return s.waitFn(
    `(() => Array.from(document.querySelectorAll(${bankSel} + " .inv-slot[data-stack]")).some((slot) => {
      const key = slot.getAttribute("data-key") ?? "";
      const aria = slot.getAttribute("aria-label") ?? "";
      const countText = slot.querySelector(".inv-count")?.textContent ?? "";
      const identityOk = key.includes(${keyNeedle}) || aria.includes(${nounLit});
      const qtyOk = aria.includes(${expectedAriaQty})
        || countText === String(${available})
        || (${available} === 1 && countText === "" && aria.includes(" in vault"));
      return identityOk && qtyOk;
    }))()`,
    { label: `vault item ${itemId} x${available}`, timeoutMs },
  );
}

/** Resolve the live vault gridcell for itemId (key embed or aria noun). */
async function vaultSlotHandle(s, itemId) {
  const noun = VAULT_ITEM_ARIA_NOUN[itemId];
  s.assert(noun, `vault aria noun map missing itemId ${itemId}`);
  const keySel = vaultSlotSelector(itemId);
  if (await s.page.locator(keySel).count() > 0) return s.page.locator(keySel).first();
  const slots = s.page.locator(`${BANK} .inv-slot[data-stack]`);
  const n = await slots.count();
  for (let i = 0; i < n; i += 1) {
    const slot = slots.nth(i);
    const aria = await slot.getAttribute("aria-label");
    if (aria && aria.includes(noun)) return slot;
  }
  return null;
}

async function closeWindow(s, sel) {
  // Click this window's own close control — Escape only closes the focused
  // window, and vault dblclick focuses BANK while INVENTORY may still be open.
  const closeBtn = s.page.locator(`${sel} .sc3d-window-close`);
  await closeBtn.waitFor({ state: "visible", timeout: 4000 });
  await closeBtn.click();
  await s.waitDom(sel, { state: "hidden", timeoutMs: 4000 });
}

/**
 * Probe a right-to-left / vertical lattice inside the visible bank content rect
 * with elementFromPoint. Require topmost hit inside .scp-bank and outside the
 * inventory window. Returns targetPosition relative to the bank root, or null.
 */
async function probeUnobstructedBankDropPosition(s) {
  return s.page.evaluate(({ bankSel, invSel }) => {
    const bank = document.querySelector(`${bankSel} .scp-bank`) ?? document.querySelector(bankSel);
    if (!(bank instanceof HTMLElement)) return null;
    const rect = bank.getBoundingClientRect();
    if (rect.width <= 8 || rect.height <= 8) return null;
    const xs = [];
    for (let i = 0; i <= 12; i += 1) xs.push(rect.right - 10 - i * Math.max(6, rect.width / 14));
    const ys = [];
    for (let i = 0; i <= 10; i += 1) ys.push(rect.top + rect.height * (0.12 + i * 0.08));
    for (const x of xs) {
      if (x < rect.left + 4 || x > rect.right - 4) continue;
      for (const y of ys) {
        if (y < rect.top + 4 || y > rect.bottom - 4) continue;
        const hit = document.elementFromPoint(x, y);
        if (!(hit instanceof Element)) continue;
        if (!hit.closest(".scp-bank")) continue;
        if (hit.closest(invSel) || hit.closest('.sc3d-window[data-window="inventory"]')) continue;
        return { x: x - rect.left, y: y - rect.top };
      }
    }
    return null;
  }, { bankSel: BANK, invSel: INVENTORY });
}

async function unobstructedBankDropPosition(s) {
  const point = await probeUnobstructedBankDropPosition(s);
  s.assert(point && Number.isFinite(point.x) && Number.isFinite(point.y),
    `no unobstructed .scp-bank drop point beside inventory (got ${JSON.stringify(point)})`);
  return { x: point.x, y: point.y };
}

/**
 * Slide INVENTORY via its real WindowManager title bar so .scp-bank content is
 * not fully covered. Chooses left vs right candidate from current BANK/INVENTORY
 * bounding boxes (keep y). Canonical path: title pointerdown/move/up.
 */
async function slideInventoryClearOfBank(s) {
  const plan = await s.page.evaluate(({ bankSel, invSel }) => {
    const bank = document.querySelector(bankSel);
    const inv = document.querySelector(invSel);
    if (!(bank instanceof HTMLElement) || !(inv instanceof HTMLElement)) return null;
    const b = bank.getBoundingClientRect();
    const i = inv.getBoundingClientRect();
    const vw = window.innerWidth;
    const gap = 16;
    // dx to place inventory fully left of bank, or fully right of bank.
    const dxLeft = (b.left - gap - i.width) - i.left;
    const dxRight = (b.right + gap) - i.left;
    // Clamp so the window stays mostly on-screen.
    const clampDx = (dx) => {
      const nextLeft = i.left + dx;
      const minLeft = 8;
      const maxLeft = Math.max(minLeft, vw - i.width - 8);
      if (nextLeft < minLeft) return dx + (minLeft - nextLeft);
      if (nextLeft > maxLeft) return dx - (nextLeft - maxLeft);
      return dx;
    };
    const left = clampDx(dxLeft);
    const right = clampDx(dxRight);
    // Prefer the side that separates more from the bank center.
    const leftSep = Math.abs((i.left + left + i.width / 2) - (b.left + b.width / 2));
    const rightSep = Math.abs((i.left + right + i.width / 2) - (b.left + b.width / 2));
    const dx = rightSep >= leftSep ? right : left;
    return {
      dx,
      before: { x: i.x, y: i.y, w: i.width, h: i.height },
      bank: { x: b.x, y: b.y, w: b.width, h: b.height },
    };
  }, { bankSel: BANK, invSel: INVENTORY });
  s.assert(plan && Number.isFinite(plan.dx), `inventory/bank rects unavailable for title slide (got ${JSON.stringify(plan)})`);

  const title = s.page.locator(`${INVENTORY} .sc3d-window-title`);
  const box = await title.boundingBox();
  s.assert(box, "inventory title bar is visible for WindowManager move");
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await s.page.mouse.move(x, y);
  await s.page.mouse.down();
  await s.page.mouse.move(x + plan.dx, y, { steps: 12 });
  await s.page.mouse.up();

  // Wait until the inventory window bbox actually moved horizontally.
  const originX = plan.before.x;
  await s.page.waitForFunction(({ invSel, originX: ox }) => {
    const inv = document.querySelector(invSel);
    if (!(inv instanceof HTMLElement)) return false;
    return Math.abs(inv.getBoundingClientRect().x - ox) >= 8;
  }, { invSel: INVENTORY, originX }, { timeout: 5000 });

  const drop = await probeUnobstructedBankDropPosition(s);
  s.assert(drop, `inventory title slide dx=${plan.dx} still leaves .scp-bank fully covered`);
  return drop;
}

async function dragCarriedStackToBank(s, carriedSlotSel) {
  const bankRoot = s.page.locator(`${BANK} .scp-bank`);
  await s.waitDom(`${BANK} .scp-bank`, { state: "visible", timeoutMs: 10000 });
  const targetPosition = await unobstructedBankDropPosition(s);
  await s.page.locator(carriedSlotSel).dragTo(bankRoot, { targetPosition });
}

/**
 * One real consent duel that ends with the keeper down (or dead on the
 * lethal third strike). Returns the public authority actor at that state.
 */
async function duelToDown(ctx, hunter, keeper, round) {
  await hunter.slash(`/duel ${KEEPER}`);
  await ctx.delay(800);
  await keeper.slash("/accept-duel");
  await ctx.delay(500);
  await hunter.slash(`/target ${KEEPER}`);
  // Honest fight math: the keeper's passive health regen (6 hp/s) is always
  // on and its real max health is 280, so the hunter arms the basic_shot
  // server repeat once, then layers real aimed_shot rolls (1.5x damage, +15
  // accuracy, 25 action each against ~24 action/s regen) on top. No debug
  // damage — just sustained honest fire inside a generous window.
  const deadline = Date.now() + 150000;
  await hunter.slash("/attack basic_shot $target");
  let lastAttack = Date.now();
  while (Date.now() < deadline) {
    if (Date.now() - lastAttack > 2500) {
      await hunter.slash("/attack aimed_shot $target");
      lastAttack = Date.now();
    }
    await ctx.delay(700);
    const actor = (await hunter.oracle().catch(() => null))?.actors?.[KEEPER] ?? null;
    const state = actor?.lifeState ?? null;
    if (state === "downed" || state === "respawning") {
      ctx.note(`duel round ${round}: keeper ${state}`);
      return { state, actor };
    }
  }
  throw new Error(`duel round ${round}: hunter never downed the keeper`);
}

export default {
  id: "bank-clone-corpse",
  title: "Bank + backup + lethal duel + clone + corpse recovery (two-browser)",
  timeoutMs: 660000,
  characters: [
    {
      role: "keeper",
      id: KEEPER,
      name: "BankKeeper",
      x: 512,
      y: 512,
      initialProfessionId: "brawler",
      // Seed health low anyway; passive regen may refill it during the bank
      // walk, and the duel deadline budgets for a full-health honest fight.
      vitals: { health: 60, action: 160, spirit: 100 },
      // Exact life-history seed: wallet credits through the character store record.
      professions: { credits: START_CREDITS },
      // Exact inventory seed: the pre-entry verification fixture (replaces the
      // default deploy loadout — the keeper carries ONLY these two stacks).
      verificationLoadout: {
        mode: "client3d-pre-entry.v1",
        items: [
          { itemId: STIMPAK, variantId: 0, quantity: 3, equipped: false },
          { itemId: BANDAGE, variantId: 0, quantity: 4, equipped: false },
        ],
      },
    },
    {
      role: "hunter",
      id: HUNTER,
      name: "CloneHunter",
      x: 514,
      y: 512,
      initialProfessionId: "marksman",
      // Deep honest ammo reserve: three duel rounds against always-on regen
      // burn ~1000 slug rounds; the default deploy loadout carries ~270 and
      // runs dry mid-round-1 (observed ammo_unavailable rejections).
      verificationLoadout: {
        mode: "client3d-pre-entry.v1",
        items: [
          { itemId: SLUGTHROWER, variantId: 0, quantity: 1, equipped: true },
          { itemId: IRON_SLUG, variantId: 0, quantity: 2400, equipped: false },
        ],
      },
    },
  ],
  async run(ctx) {
    const keeper = ctx.session("keeper");
    const hunter = ctx.session("hunter");

    // Both browser contexts are live against the same authoritative shard.
    const [k0, h0] = await Promise.all([
      keeper.waitProbe((p) => p?.serverStatus === "connected", { label: "keeper connected", timeoutMs: 30000 }),
      hunter.waitProbe((p) => p?.serverStatus === "connected", { label: "hunter connected", timeoutMs: 30000 }),
    ]);
    keeper.assert(k0?.serverStatus === "connected" && h0?.serverStatus === "connected", "both sessions connected");
    const seeded = await keeper.oracle();
    keeper.assert(credits(seeded, KEEPER) === START_CREDITS, `fixture wallet is ${START_CREDITS} (got ${credits(seeded, KEEPER)})`);
    const seededStim = row(seeded, `${KEEPER}:`, STIMPAK);
    const seededBand = row(seeded, `${KEEPER}:`, BANDAGE);
    keeper.assert(seededStim?.available === 3 && seededBand?.available === 4, "fixture loadout is exactly stimpak x3 + bandage x4");

    // ── BANK: south portal → interior aisle → vault terminal (real F) ────
    await enterCommerceBank(ctx, keeper);
    await keeper.waitFn(
      `(() => { const el = document.querySelector('${BANK} [data-ref="link"]'); return !!el && el.textContent === "VAULT LINKED"; })()`,
      { label: "vault linked", timeoutMs: 10000 },
    );
    await ctx.moneyShot("00-vault-linked", keeper);

    // DEPOSIT 1200 → wallet 200, vault 1200.
    await keeper.page.fill(`${BANK} [data-ref="amount"]`, "1200");
    await keeper.click(`${BANK} [data-ref="deposit"]`);
    await keeper.waitProbeCall(() => keeper.oracle(), (o) => credits(o, KEEPER) === START_CREDITS - 1200,
      { label: "deposit landed (wallet 200)", timeoutMs: 10000 });
    // WITHDRAW 200 → wallet 400, vault 1000 (exactly one backup's cost).
    await keeper.page.fill(`${BANK} [data-ref="amount"]`, "200");
    await keeper.click(`${BANK} [data-ref="withdraw"]`);
    await keeper.waitProbeCall(() => keeper.oracle(), (o) => credits(o, KEEPER) === 400,
      { label: "withdraw landed (wallet 400)", timeoutMs: 10000 });
    ctx.note("credits: deposit 1200 + withdraw 200 → wallet 400, vault 1000");

    // Full-stack vault grid: inventory drag deposits, vault double-click retrieves.
    // Stimpak x3 stays vaulted through death; bandage proves both directions.
    await openDockWindow(keeper, "inventory");
    await keeper.waitDom(INVENTORY, { state: "visible", timeoutMs: 10000 });
    // Slide inventory via real title-bar drag so vault content is not fully covered.
    await slideInventoryClearOfBank(keeper);
    const carriedStim = `${INVENTORY} .inv-slot[data-item-id="${STIMPAK}"]`;
    const carriedBandage = `${INVENTORY} .inv-slot[data-item-id="${BANDAGE}"]`;
    const vaultSlots = `${BANK} .inv-slot[data-stack]`;
    await keeper.waitDom(carriedStim, { state: "visible", timeoutMs: 15000 });
    // Native Playwright drag onto an unobstructed point of the visible bank root
    // (do not synthesize drop events).
    await performWithAcceptedReceipt(
      keeper,
      "BankStoreItem",
      () => dragCarriedStackToBank(keeper, carriedStim),
    );
    await keeper.waitProbeCall(
      () => keeper.oracle(),
      (o) => !row(o, `${KEEPER}:`, STIMPAK),
      { label: "carried stimpak x3 deposited (oracle empty)", timeoutMs: 10000 },
    );
    await waitVaultSlot(keeper, STIMPAK, 3);
    await keeper.waitDom(carriedBandage, { state: "visible", timeoutMs: 10000 });
    await performWithAcceptedReceipt(
      keeper,
      "BankStoreItem",
      () => dragCarriedStackToBank(keeper, carriedBandage),
    );
    await keeper.waitProbeCall(
      () => keeper.oracle(),
      (o) => !row(o, `${KEEPER}:`, BANDAGE),
      { label: "carried bandage x4 deposited (oracle empty)", timeoutMs: 10000 },
    );
    await waitVaultSlot(keeper, BANDAGE, 4);
    // Retrieve full bandage stack via vault slot double-click (full stacks only).
    const vaultBandage = await vaultSlotHandle(keeper, BANDAGE);
    keeper.assert(vaultBandage, "vault bandage gridcell is visible");
    const bandageStackId = await vaultBandage.getAttribute("data-stack");
    keeper.assert(bandageStackId, "vault bandage slot exposes its authority stack id");
    await performWithAcceptedReceipt(
      keeper,
      "BankRetrieveItem",
      () => vaultBandage.dblclick(),
    );
    await keeper.waitProbeCall(
      () => keeper.oracle(),
      (o) => row(o, `${KEEPER}:`, BANDAGE)?.available === 4,
      { label: "bandage x4 retrieved to carried", timeoutMs: 10000 },
    );
    await waitVaultSlot(keeper, STIMPAK, 3);
    const vaultBandageAfter = await vaultSlotHandle(keeper, BANDAGE);
    keeper.assert(!vaultBandageAfter, "vault bandage slot cleared after full-stack retrieve");
    const vaultCount = await keeper.page.locator(vaultSlots).count();
    keeper.assert(vaultCount === 1, `vault holds exactly stimpak stack after retrieve (got ${vaultCount})`);
    ctx.note("vault grid: drag stimpak x3 + bandage x4 in; double-click retrieve bandage x4 → vaulted stimpak x3");
    await ctx.moneyShot("01-vault-transfers", keeper);
    await closeWindow(keeper, INVENTORY);
    await closeWindow(keeper, BANK);
    await exitCommerceToPlaza(ctx, keeper);

    // Approach clone facility via exterior south lane (east to 518.5,512 then north).
    // Diagonal plaza→portal clips the commerce SE corner the same way bank entry did.
    await approachCloneSouthPortal(ctx, keeper);
    await ensureFacilityDoorOpen(ctx, keeper, CLONE_FACILITY_ID);
    await walkToCell(ctx, keeper, CLONE_ENTRY, { withinCells: 0.35, timeoutMs: 20000 });
    // Do not walk into the solid terminal cell (518,502). Stage left, then stand
    // west of the collider so player center is inside the 1.75 interaction radius.
    await walkToCell(ctx, keeper, CLONE_CLEAR_LEFT, { withinCells: 0.4, timeoutMs: 20000 });
    await walkToCell(ctx, keeper, CLONE_TERMINAL_STAND, { withinCells: 0.4, timeoutMs: 20000 });
    await openTerminalWithF(ctx, keeper, "cloneTerminal", CLONE);
    await keeper.waitDom(`${CLONE} [data-ref="save"]:not([disabled])`, { state: "attached", timeoutMs: 10000 });
    await performWithAcceptedReceipt(
      keeper,
      "CloneSaveSkillBackup",
      () => keeper.click(`${CLONE} [data-ref="save"]`),
    );
    await keeper.waitFn(
      `(() => { const el = document.querySelector('${CLONE} [data-ref="backupStatus"]'); return !!el && el.textContent === "BACKUP ON FILE"; })()`,
      { label: "backup on file", timeoutMs: 8000 },
    );
    // Vault-first payment: the wallet's 400 must be untouched.
    keeper.assert(credits(await keeper.oracle(), KEEPER) === 400, "backup cost paid from the vault, wallet still 400");
    ctx.note("skill backup saved (1000 CR, vault-first)");
    await ctx.moneyShot("02-backup-saved", keeper);
    await keeper.press("Escape");
    await keeper.waitDom(CLONE, { state: "hidden", timeoutMs: 4000 }).catch(() => {});
    // Reverse clone south portal → south lane → plaza (no diagonal across commerce SE).
    await exitCloneToPlaza(ctx, keeper);
    await walkToCell(ctx, keeper, { x: 505, y: 517 }, { withinCells: 0.8, timeoutMs: 30000 });

    // ── LETHAL DEATH: three real duel downs inside the incap window ───────
    await walkToCell(ctx, keeper, DUEL_CELL);
    let deathSpot = null;
    for (let round = 1; round <= 3; round += 1) {
      const outcome = await duelToDown(ctx, hunter, keeper, round);
      if (outcome.state === "respawning") {
        keeper.assert(round === 3, `lethal death should take exactly 3 strikes (died on round ${round})`);
        deathSpot = outcome.actor;
        break;
      }
      keeper.assert(round < 3, "third duel down must be lethal (3-strike incap rule)");
      if (round === 1) await ctx.moneyShot("03-first-down", keeper);
      // Honest incap timer: the keeper gets back up on its own.
      await keeper.waitProbeCall(() => keeper.oracle(), (o) => o?.actors?.[KEEPER]?.lifeState === "alive",
        { label: `auto-revive after down ${round}`, timeoutMs: 90000, intervalMs: 500 });
    }
    keeper.assert(deathSpot, "lethal duel exposed the public death position");
    // The visible death flow: YOU DIED overlay with the clone facility button.
    await keeper.waitDom('.sc3d-death-panel[data-phase="respawning"]', { state: "visible", timeoutMs: 10000 });

    // ── CLONE: activate from the overlay's real facility button ───────────
    // Read the visible button's center, then use the real mouse. A locator
    // click can report a false timeout when successful cloning removes the
    // death overlay while Puppeteer is still finishing its click checks.
    const cloneButtonSelector = `.sc3d-death-clonebtn[data-facility-id="${CLONE_FACILITY_ID}"]`;
    const cloneButton = await keeper.page.evaluate((selector) => {
      const element = document.querySelector(selector);
      const panel = element?.closest(".sc3d-death-panel");
      if (!(element instanceof HTMLElement) || !(panel instanceof HTMLElement)) return null;
      const rect = element.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return null;
      return {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
        title: panel.querySelector(".sc3d-death-title")?.textContent ?? "",
        buttonText: element.textContent ?? "",
        recovery: panel.querySelector(".sc3d-death-recovery")?.textContent ?? "",
      };
    }, cloneButtonSelector);
    keeper.assert(cloneButton, "visible clone-facility button has a clickable screen rectangle");
    keeper.assert(cloneButton.title === "YOU DIED", `visible death title is YOU DIED (got ${cloneButton.title})`);
    keeper.assert(
      cloneButton.buttonText === "ACTIVATE CLONE · DUSTGATE CLONING FACILITY",
      `visible facility activation label is exact (got ${cloneButton.buttonText})`,
    );
    keeper.assert(
      cloneButton.recovery.startsWith("FIELD RECOVERY · "),
      `visible field-recovery countdown is present (got ${cloneButton.recovery})`,
    );
    ctx.note(`visible death panel: ${cloneButton.title}; ${cloneButton.buttonText}; ${cloneButton.recovery}`);
    // Click immediately: FIELD RECOVERY is intentionally short. Fresh accepted
    // CloneRespawn receipt proves explicit facility activation beat the timer.
    await performWithAcceptedReceipt(keeper, "CloneRespawn", () => keeper.page.mouse.click(
      cloneButton.x + cloneButton.width / 2,
      cloneButton.y + cloneButton.height / 2,
    ));
    const cloned = await keeper.waitProbeCall(() => keeper.oracle(), (o) => o?.actors?.[KEEPER]?.lifeState === "alive",
      { label: "clone respawn landed", timeoutMs: 15000 });
    const me = cloned.actors[KEEPER];
    keeper.assert(Math.hypot(me.x - CLONE_RESPAWN_CELL.x, me.y - CLONE_RESPAWN_CELL.y) < 3,
      `clone woke at the facility (got ${me.x},${me.y})`);
    keeper.assert(credits(cloned, KEEPER) === 0, "wallet credits stayed on the corpse (clone wallet 0)");
    await keeper.waitProbe((p) => p.playerCloneSickness > 0, { label: "clone sickness ticking", timeoutMs: 8000 });

    // Both clients see the SAME public corpse bag through the probe seam.
    const [kc, hc] = await Promise.all([
      keeper.waitProbe((p) => (p.playerCorpses ?? []).some((c) => c.isOwner && c.hasItems && c.creditsPresent),
        { label: "keeper sees its own corpse bag", timeoutMs: 12000 }),
      hunter.waitProbe((p) => (p.playerCorpses ?? []).some((c) => !c.isOwner && c.hasItems),
        { label: "hunter sees the public corpse bag", timeoutMs: 12000 }),
    ]);
    const corpse = kc.playerCorpses.find((c) => c.isOwner);
    keeper.assert(hc.playerCorpses.some((c) => c.id === corpse.id), "hunter's probe carries the same corpse id");
    keeper.assert(Math.hypot(corpse.x - deathSpot.x, corpse.y - deathSpot.y) < 2, "corpse bag lies at the death spot");
    ctx.note(`corpse ${corpse.id} at (${corpse.x},${corpse.y}); clone at (${me.x},${me.y})`);
    await ctx.moneyShot("05-clone-and-corpse", hunter);

    // The private vault is still visible after death and clone; prove it through
    // the real BANK window because the global oracle intentionally omits it.
    // Exit clone via south lane to plaza, then re-enter commerce the same way.
    await exitCloneToPlaza(ctx, keeper);
    await enterCommerceBank(ctx, keeper);
    await waitVaultSlot(keeper, STIMPAK, 3);
    await ctx.moneyShot("05a-vault-survived-clone", keeper);
    await closeWindow(keeper, BANK);
    await exitCommerceToPlaza(ctx, keeper);

    // ── CORPSE RUN: WASD back, then a REAL canvas double-click on the bag ─
    // The picker resolves actors before corpse bags, so the keeper must not
    // stand where its own pawn covers the bag's screen anchor (an overlapped
    // double-click reads as self-EXAMINE). Each attempt approaches the bag
    // from a different side, re-reads the live anchor, and double-clicks.
    const bagCell = { x: corpse.x, y: corpse.y };
    const standOffsets = [
      { x: 0, y: 1.0 },
      { x: 1.0, y: 0 },
      { x: -1.0, y: 0 },
      { x: 0, y: -1.0 },
      { x: 0.75, y: 0.75 },
    ];
    let lootOpen = false;
    for (let attempt = 0; attempt < standOffsets.length && !lootOpen; attempt += 1) {
      const off = standOffsets[attempt];
      await walkToCell(ctx, keeper, { x: bagCell.x + off.x, y: bagCell.y + off.y }, { withinCells: 0.5, timeoutMs: 30000 });
      // Close any window an earlier occluded click may have opened (examine).
      await keeper.press("Escape");
      await ctx.delay(500); // let the follow camera settle on the new stance
      const bag = ((await keeper.probe())?.playerCorpses ?? []).find((c) => c.id === corpse.id);
      keeper.assert(bag?.screen, "corpse bag has a live screen anchor");
      const rect = await keeper.page.evaluate(() => {
        const r = document.querySelector("canvas.successor3d-canvas").getBoundingClientRect();
        return { left: r.left, top: r.top };
      });
      await keeper.page.mouse.dblclick(rect.left + bag.screen.px, rect.top + bag.screen.py);
      lootOpen = await keeper.waitDom(LOOT, { state: "visible", timeoutMs: 2500 }).then(() => true).catch(() => false);
    }
    keeper.assert(lootOpen, "canvas double-click on the rendered bag opened the LOOT window");
    await ctx.moneyShot("06-corpse-loot-window", keeper);

    // Corpse holds bandage x4 (stimpak x3 stayed vaulted). Per-slot take first.
    const corpseContainer = `corpse:${corpse.id}`;
    await keeper.dblclick(`${LOOT} .inv-slot[data-key^="${corpseContainer}"][data-key*=":${BANDAGE}:"]`);
    await keeper.waitProbeCall(() => keeper.oracle(), (o) => row(o, `${KEEPER}:`, BANDAGE)?.available === 4,
      { label: "bandage x4 recovered from the corpse", timeoutMs: 10000 });
    // Exact credits back: TAKE CREDITS sweeps the wallet the corpse held.
    await keeper.click(`${LOOT} [data-ref="takeCredits"]`);
    await keeper.waitProbeCall(() => keeper.oracle(), (o) => credits(o, KEEPER) === 400,
      { label: "corpse credits recovered (wallet 400)", timeoutMs: 10000 });
    // TAKE ALL strips the rest (clone-shed gear). Stimpak remains vault-only.
    await keeper.click(`${LOOT} [data-ref="takeAll"]`);
    await keeper.waitProbeCall(() => keeper.oracle(),
      (o) => row(o, `${KEEPER}:`, BANDAGE)?.available === 4
        && !row(o, `${KEEPER}:`, STIMPAK)
        && !(o.inventory ?? []).some((r) => r.container === corpseContainer && (r.available ?? 0) > 0),
      { label: "corpse stripped; bandage home; stimpak still vaulted", timeoutMs: 12000 });
    // Emptied bag despawns from BOTH live clients (cross-context proof).
    await Promise.all([
      keeper.waitProbe((p) => !(p.playerCorpses ?? []).some((c) => c.id === corpse.id),
        { label: "keeper: emptied bag despawned", timeoutMs: 10000 }),
      hunter.waitProbe((p) => !(p.playerCorpses ?? []).some((c) => c.id === corpse.id),
        { label: "hunter: emptied bag despawned", timeoutMs: 10000 }),
    ]);
    ctx.note(`recovered: bandage x4 + 400 CR; vault kept stimpak x3; corpse ${corpse.id} cleaned up`);
    await ctx.moneyShot("07-recovered", keeper);
  },
};
