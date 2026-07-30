// Headed journey: the real Dustgate bank terminal and its 1.75-cell link.
// The transfer proof uses visible inventory/vault tiles, native drag events,
// double-click, and Enter. No authority state is mutated outside normal UI.
//
// Geometry is fixture-grounded on open-desert-slice.json:
//   dustgate-bank-terminal cell (503,501) size 1×1 → terminal center (503.5,501.5)
//   bankLink reach = hypot((player.x+0.5)-centerX, (player.y+0.5)-centerY) ≤ 1.75
//   stand (503.8,502.2): actor→center ≈1.44 (in range, clear of kiosk solid x:503..504 y:501.16..501.84)
//   stand (506.5,504.5): actor→center ≈4.95 (out of range)
//   bank-clone-corpse axis corridor: (506.0, 503.5) → (501.3, 503.5) → (501.3, 502.0) → (502.0, 502.0)
const BANK = '.sc3d-window[data-window="bank"]';
const INVENTORY = '.sc3d-window[data-window="inventory"]';
const BANK_ID = "dustgate-bank-terminal";
const STIMPAK = 1001;
const BANDAGE = 1002;
const BANK_TRANSFER_KINDS = new Set(["BankStoreItem", "BankRetrieveItem"]);

// Stand SE of the kiosk, clear of the solid counter/collider, inside 1.75 reach.
const BANK_CELL = { x: 503.8, y: 502.2 };
// Well beyond the hard 1.75-cell terminal reach while still on the open plaza.
const BANK_OUT_OF_RANGE = { x: 506.5, y: 504.5 };

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
    if (dy > 0.08) keys.push("KeyS"); else if (dy < -0.08) keys.push("KeyW");
    if (dx > 0.08) keys.push("KeyD"); else if (dx < -0.08) keys.push("KeyA");
    if (keys.length === 0) {
      if (Math.abs(dx) >= Math.abs(dy)) keys.push(dx >= 0 ? "KeyD" : "KeyA");
      else keys.push(dy >= 0 ? "KeyS" : "KeyW");
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

function freshBankTransferReceipts(probe, knownIds) {
  return (probe?.authorityReceiptTail ?? []).filter((entry) => (
    !knownIds.has(entry.commandId) && BANK_TRANSFER_KINDS.has(entry.kind)
  ));
}

/** Baseline command ids immediately before the gesture; require a fresh accepted kind. */
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

/**
 * After a deliberate out-of-range denial gesture: wait a bounded quiet window
 * and assert no NEW bank transfer kinds appear. Ignores unrelated movement /
 * UI receipts that may still append to the rolling tail.
 */
async function assertNoFreshBankTransfer(ctx, s, knownIds, { quietMs = 1500 } = {}) {
  const deadline = Date.now() + quietMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await s.probe();
    const fresh = freshBankTransferReceipts(last, knownIds);
    s.assert(
      fresh.length === 0,
      `out-of-range Enter/dblclick emitted bank transfer: ${JSON.stringify(fresh)}`,
    );
    await ctx.delay(150);
  }
  last = await s.probe();
  const fresh = freshBankTransferReceipts(last, knownIds);
  s.assert(
    fresh.length === 0,
    `Enter and double-click out of range sent bank transfer command: ${JSON.stringify(fresh)}`,
  );
  return last;
}

async function waitText(s, selector, text, label) {
  return s.waitFn(
    `(() => document.querySelector(${JSON.stringify(selector)})?.textContent === ${JSON.stringify(text)})()`,
    { label, timeoutMs: 12000 },
  );
}

async function openBank(s) {
  const probe = await s.waitProbe(
    (p) => (p.interactions ?? []).some((o) => o.kind === "bankTerminal" && o.targetId === BANK_ID),
    { label: "bank terminal in F interaction chip", timeoutMs: 15000 },
  );
  const selected = probe?.interactions?.[0];
  s.assert(selected?.kind === "bankTerminal" && selected?.targetId === BANK_ID, "bank terminal must win interaction selection");
  await s.press("KeyF");
  await s.waitDom(BANK, { state: "visible", timeoutMs: 10000 });
  await waitText(s, `${BANK} [data-ref="link"]`, "VAULT LINKED", "vault link");
}

async function moveWindow(s, selector, dx) {
  const title = s.page.locator(`${selector} .sc3d-window-title`);
  const box = await title.boundingBox();
  s.assert(box, `${selector} title bar is visible for normal window reposition`);
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await s.page.mouse.move(x, y);
  await s.page.mouse.down();
  await s.page.mouse.move(x + dx, y, { steps: 8 });
  await s.page.mouse.up();
}

export default {
  id: "bank-proximity",
  title: "Dustgate bank proximity gestures and LINK LOST recovery (headed)",
  headed: true,
  timeoutMs: 180000,
  characters: [{
    role: "keeper",
    id: "h3d-bank-proximity",
    name: "BankProximity",
    x: 503.8,
    y: 502.2,
    initialProfessionId: "brawler",
    verificationLoadout: {
      mode: "client3d-pre-entry.v1",
      items: [
        { itemId: STIMPAK, variantId: 0, quantity: 3, equipped: false },
        { itemId: BANDAGE, variantId: 0, quantity: 4, equipped: false },
      ],
    },
  }],
  async run(ctx) {
    const s = ctx.session("keeper");
    await s.waitProbe((p) => p.serverStatus === "connected" && p.authorityPlayer, { label: "authority connected", timeoutMs: 45000 });

    await walkToCell(ctx, s, BANK_CELL, { withinCells: 0.3, stopIf: (p) => (p.interactions ?? []).some((o) => o.kind === "bankTerminal" && o.targetId === BANK_ID) });
    await openBank(s);
    await moveWindow(s, BANK, 360);
    await s.press("KeyI");
    await s.waitDom(INVENTORY, { state: "visible", timeoutMs: 10000 });
    await moveWindow(s, INVENTORY, -360);

    // Inventory → vault by native drag, then the inventory double-click path.
    const carriedStim = `${INVENTORY} .inv-slot[data-item-id="${STIMPAK}"]`;
    const carriedBandage = `${INVENTORY} .inv-slot[data-item-id="${BANDAGE}"]`;
    const vaultDrop = `${BANK} .scp-bank`;
    await s.waitDom(carriedStim, { state: "visible", timeoutMs: 15000 });

    let knownIds = knownCommandIds(await s.probe());
    await s.page.locator(carriedStim).dragTo(s.page.locator(vaultDrop));
    await awaitFreshAccepted(s, knownIds, "BankStoreItem");
    await s.waitDom(`${BANK} .inv-slot[data-stack]`, { state: "visible", timeoutMs: 10000 });

    knownIds = knownCommandIds(await s.probe());
    await s.dblclick(carriedBandage);
    await awaitFreshAccepted(s, knownIds, "BankStoreItem");
    await ctx.moneyShot("00-bank-store-gestures", s);

    // Vault → inventory by native drag. Leave the second vault stack for the
    // double-click retrieve after the deliberate out-of-range denial proof.
    const vaultSlots = `${BANK} .inv-slot[data-stack]`;
    await s.waitDom(vaultSlots, { state: "visible", timeoutMs: 10000 });
    const firstVaultStack = await s.page.locator(vaultSlots).first().getAttribute("data-stack");
    s.assert(firstVaultStack, "vault stack exposes its authority stack id");

    knownIds = knownCommandIds(await s.probe());
    await s.page.locator(`${BANK} .inv-slot[data-stack="${firstVaultStack}"]`).dragTo(s.page.locator(`${INVENTORY} .inv-grid`));
    await awaitFreshAccepted(s, knownIds, "BankRetrieveItem");

    // Step beyond the hard 1.75-cell terminal reach. The visible lock and
    // disabled draggable state are the client projection; no bank transfer
    // command is sent.
    await walkToCell(ctx, s, BANK_OUT_OF_RANGE, { withinCells: 0.35 });
    await waitText(s, `${BANK} [data-ref="link"]`, "NO VAULT LINK", "link lost header");
    await waitText(s, `${BANK} [data-ref="status"]`, "LINK LOST · RETURN TO TERMINAL", "link lost status");

    const vaultSlotLockState = await s.page.locator(vaultSlots).evaluateAll((nodes) => ({
      count: nodes.length,
      allLocked: nodes.every((node) => node.hasAttribute("data-locked") && node.draggable === false),
    }));
    s.assert(vaultSlotLockState.count > 0, "vault slots exist to verify LINK LOST lock state");
    s.assert(vaultSlotLockState.allLocked, "vault tiles are visibly locked and not draggable while LINK LOST");
    await s.page.waitForTimeout(500);

    // Baseline bank-transfer command ids only — movement receipts may still
    // append to the rolling tail and must not fail the denial proof.
    const deniedBaseline = knownCommandIds(await s.probe());
    const remainingVault = s.page.locator(vaultSlots).first();
    await remainingVault.focus();
    await s.page.keyboard.press("Enter");
    await s.dblclick(vaultSlots);
    await waitText(s, `${BANK} [data-ref="status"]`, "LINK LOST · RETURN TO TERMINAL", "disabled transfer denial");
    await assertNoFreshBankTransfer(ctx, s, deniedBaseline, { quietMs: 1500 });

    // Return inside reach using the runtime-proven bank-clone-corpse axis corridor route.
    await walkToCell(ctx, s, { x: 506.0, y: 503.5 }, { withinCells: 0.25, timeoutMs: 20000 });
    await walkToCell(ctx, s, { x: 501.3, y: 503.5 }, { withinCells: 0.25, timeoutMs: 20000 });
    await walkToCell(ctx, s, { x: 501.3, y: 502.0 }, { withinCells: 0.25, timeoutMs: 20000 });
    await walkToCell(ctx, s, { x: 502.0, y: 502.0 }, { withinCells: 0.25, timeoutMs: 20000, stopIf: (p) => (p.interactions ?? []).some((o) => o.kind === "bankTerminal" && o.targetId === BANK_ID) });

    await waitText(s, `${BANK} [data-ref="link"]`, "VAULT LINKED", "vault link recovered");
    knownIds = knownCommandIds(await s.probe());
    await s.dblclick(vaultSlots);
    await awaitFreshAccepted(s, knownIds, "BankRetrieveItem");
    await ctx.moneyShot("02-bank-link-recovered", s);
  },
};
