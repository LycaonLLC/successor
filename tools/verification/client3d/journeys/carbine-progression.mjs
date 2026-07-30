// Journey: Marksman carbine ladder. The real inventory rows prove Kiln is
// Rifle-IV-gated and Lightning is Master-gated, then each accepted weapon is
// drawn, fired, procedurally reloaded, and allowed to settle back to stow.
import { ITEM, waitHostile, acquireTarget, approachHostile, fightToKill } from "./_helpers.mjs";

const MAGAZINE_SIZE = 30;
// A single-phase visual run synchronizes to the rendered HUD, then freezes
// only that frame; freezing all three lets live authority skip later windows.
const REQUESTED_RELOAD_PROOF_PHASE = process.env.SUCCESSOR_RELOAD_PROOF_PHASE;
const RELOAD_PROOF_PHASE = ["eject", "drop", "reseat"].includes(REQUESTED_RELOAD_PROOF_PHASE)
  ? REQUESTED_RELOAD_PROOF_PHASE
  : "eject-drop";

function newEquipReceipt(probe, knownCommandIds) {
  return (probe.authorityReceiptTail ?? []).find((entry) => (
    !knownCommandIds.has(entry.commandId) && entry.kind === "SetEquippedWeapon"
  ));
}

async function openInventory(s) {
  const inventory = s.page.locator('.sc3d-window[data-window="inventory"]');
  if (await inventory.isVisible().catch(() => false)) return;
  await s.press("KeyI");
  await s.waitDom('.sc3d-window[data-window="inventory"]', { state: "visible", timeoutMs: 20000 });
}

async function closeInventory(s) {
  const inventory = s.page.locator('.sc3d-window[data-window="inventory"]');
  if (!await inventory.isVisible().catch(() => false)) return;
  await s.press("KeyI");
  await s.waitDom('.sc3d-window[data-window="inventory"]', { state: "hidden", timeoutMs: 10000 });
}

async function zoomForWeaponProof(s) {
  const canvasBox = await s.page.locator("canvas.successor3d-canvas").boundingBox();
  s.assert(canvasBox, "game canvas missing while framing carbine proof");
  await s.page.mouse.move(canvasBox.x + canvasBox.width * 0.5, canvasBox.y + canvasBox.height * 0.5);
  for (let notch = 0; notch < 8; notch += 1) await s.page.mouse.wheel(0, -100);
  await s.waitProbe(
    (probe) => probe.zoomPercent === 140,
    { label: "carbine proof zoom", timeoutMs: 10000 },
  );
  await s.page.mouse.move(2, 2);
}

async function reloadMoneyShot(ctx, s, step) {
  await ctx.moneyShot(step, s, {
    type: "jpeg",
    quality: 90,
    clip: { x: 480, y: 240, width: 500, height: 370 },
  });
}

async function frozenReloadMoneyShot(ctx, s, step) {
  const cdp = await s.page.context().newCDPSession(s.page);
  await s.page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => resolve())));
  try {
    await cdp.send("Page.setWebLifecycleState", { state: "frozen" });
    await reloadMoneyShot(ctx, s, step);
  } finally {
    await cdp.send("Page.setWebLifecycleState", { state: "active" }).catch(() => {});
    await cdp.detach().catch(() => {});
  }
}

async function waitReloadPhase(s, label, phase, minFraction, maxFraction) {
  return s.waitProbeCall(
    () => s.oracle(),
    (oracle) => {
      const weapon = oracle?.actors?.[s.actorId]?.weapon;
      const total = Number(weapon?.reloadTotalTicks ?? 0);
      const remaining = Number(weapon?.reloadRemainingTicks ?? 0);
      const fraction = total > 0 ? (total - remaining) / total : 0;
      return remaining > 0 && fraction >= minFraction && fraction < maxFraction;
    },
    { label: `${label} reload ${phase} phase`, timeoutMs: 8000, intervalMs: 25 },
  );
}

async function waitRenderedReloadPhase(s, label, phase, minFraction, maxFraction) {
  let handle;
  try {
    handle = await s.page.waitForFunction(
      ({ min, max }) => {
        const mag = document.querySelector(".successor3d-mag[data-reloading]");
        if (!mag) return false;
        const pips = mag.querySelectorAll(".successor3d-pip");
        const total = pips.length;
        const filled = mag.querySelectorAll(".successor3d-pip.filled").length;
        const fraction = total > 0 ? filled / total : 0;
        return total > 0 && fraction >= min && fraction < max
          ? { filled, total, fraction }
          : false;
      },
      { min: minFraction, max: maxFraction },
      { polling: "raf", timeout: 8000 },
    );
  } catch (error) {
    throw new Error(
      `${label} rendered reload ${phase} never entered [${minFraction}, ${maxFraction})`,
      { cause: error },
    );
  }
  try {
    return await handle.jsonValue();
  } finally {
    await handle.dispose();
  }
}

function noteReloadPhase(ctx, s, label, phase, oracle) {
  const weapon = oracle.actors[s.actorId].weapon;
  ctx.note(`${label}: ${phase} frame at ${(1 - weapon.reloadRemainingTicks / weapon.reloadTotalTicks).toFixed(3)} reload fraction`);
}

async function equipReceiptFromRow(s, itemId, label) {
  const selector = `.inv-slot[data-item-id="${itemId}"][data-variant-id="0"]`;
  await s.waitDom(selector, { state: "visible", timeoutMs: 15000 });
  const before = await s.probe();
  const knownCommandIds = new Set((before.authorityReceiptTail ?? []).map((entry) => entry.commandId));
  await s.dblclick(selector);
  const probe = await s.waitProbe(
    (candidate) => Boolean(newEquipReceipt(candidate, knownCommandIds)),
    { label: `${label} SetEquippedWeapon receipt`, timeoutMs: 10000 },
  );
  return { probe, receipt: newEquipReceipt(probe, knownCommandIds), selector };
}

async function assertAcceptedEquip(ctx, s, itemId, weaponId, label) {
  const { receipt, selector } = await equipReceiptFromRow(s, itemId, label);
  s.assert(receipt?.accepted === true, `${label} equip rejected: ${JSON.stringify(receipt ?? null)}`);
  await s.waitProbeCall(
    () => s.oracle(),
    (oracle) => {
      const weapon = oracle?.actors?.[s.actorId]?.weapon;
      return weapon?.weaponId === weaponId
        && Number(weapon.weaponItemId ?? 0) === itemId
        && Number(weapon.weaponVariantId ?? 0) === 0;
    },
    { label: `${label} exact authority weapon`, timeoutMs: 10000 },
  );
  await s.waitProbeCall(
    () => s.page.locator(selector).first().evaluate((element) => element.hasAttribute("data-equipped")),
    (equipped) => equipped === true,
    { label: `${label} inventory row visibly equipped`, timeoutMs: 8000 },
  );
  ctx.note(`${label}: certified equip accepted ${JSON.stringify(receipt)}`);
}

async function assertRejectedEquip(ctx, s, itemId, label) {
  const { receipt, selector } = await equipReceiptFromRow(s, itemId, label);
  s.assert(
    receipt?.accepted === false && receipt.reasonCode === "weapon_not_certified",
    `${label} did not reject with weapon_not_certified: ${JSON.stringify(receipt ?? null)}`,
  );
  const visiblyEquipped = await s.page.locator(selector).first().evaluate((element) => element.hasAttribute("data-equipped"));
  s.assert(visiblyEquipped === false, `${label} rejected row rendered equipped`);
  const status = await s.page.locator('.sc3d-window[data-window="inventory"] [data-ref="status"]').innerText();
  s.assert(!/\bEQUIPPED\b/.test(status), `${label} rejected equip announced a committed state: ${status}`);
  await ctx.delay(1600);
  ctx.note(`${label}: expected cert rejection ${JSON.stringify(receipt)}`);
}

async function fireAndReload(ctx, s, label, shotPrefix, finishTargetId = null) {
  await closeInventory(s);
  await s.waitProbe((probe) => probe.muzzleWorld !== null, { label: `${label} held model muzzle`, timeoutMs: 10000 });
  const before = await s.oracle();
  const loadedBefore = Number(before?.actors?.[s.actorId]?.weapon?.loadedRounds ?? 0);
  s.assert(loadedBefore === MAGAZINE_SIZE, `${label} started with ${loadedBefore}/${MAGAZINE_SIZE} rounds`);

  await s.slash("/attack basic_shot $target");
  const fired = await s.waitProbeCall(
    () => s.oracle(),
    (oracle) => {
      const loaded = Number(oracle?.actors?.[s.actorId]?.weapon?.loadedRounds ?? MAGAZINE_SIZE);
      return loaded >= 0 && loaded < loadedBefore;
    },
    { label: `${label} authority shot consumption`, timeoutMs: 10000 },
  );
  ctx.note(`${label}: fired; loaded=${fired.actors[s.actorId].weapon.loadedRounds}`);
  await ctx.moneyShot(`${shotPrefix}-fire`);
  if (finishTargetId) {
    const finish = await fightToKill(ctx, s, finishTargetId, { timeoutMs: 70000 });
    s.assert(finish.killed && finish.sawMyHit, `${label} combat proof did not finish target: ${JSON.stringify(finish)}`);
    ctx.note(`${label}: target finished before reload so the diagnostic frame contains no incoming hostile tracer`);
  }
  await s.slash("/peace");
  await s.waitProbeCall(
    () => s.oracle(),
    (oracle) => oracle?.actors?.[s.actorId]?.peaceRequested === true,
    { label: `${label} repeat-fire cancellation`, timeoutMs: 8000 },
  );
  await ctx.delay(300);

  await s.slash("/reload");
  const reloading = await s.waitProbeCall(
    () => s.oracle(),
    (oracle) => Number(oracle?.actors?.[s.actorId]?.weapon?.reloadRemainingTicks ?? 0) > 0,
    { label: `${label} procedural reload window`, timeoutMs: 8000 },
  );
  ctx.note(`${label}: reload window ${reloading.actors[s.actorId].weapon.reloadRemainingTicks}/${reloading.actors[s.actorId].weapon.reloadTotalTicks} ticks`);
  if (RELOAD_PROOF_PHASE !== "eject-drop") {
    let minFraction = 0.20;
    let maxFraction = 0.30;
    if (RELOAD_PROOF_PHASE === "drop") {
      minFraction = 0.56;
      maxFraction = 0.60;
    } else if (RELOAD_PROOF_PHASE === "reseat") {
      minFraction = 0.80;
      maxFraction = 0.97;
    }
    const renderedPhase = await waitRenderedReloadPhase(
      s,
      label,
      RELOAD_PROOF_PHASE,
      minFraction,
      maxFraction,
    );
    ctx.note(
      `${label}: rendered ${RELOAD_PROOF_PHASE} frame at ${renderedPhase.filled}/${renderedPhase.total} HUD pips (${renderedPhase.fraction.toFixed(3)} reload fraction)`,
    );
    await frozenReloadMoneyShot(ctx, s, `${shotPrefix}-reload-${RELOAD_PROOF_PHASE}`);
  } else {
    const ejectPhase = await waitReloadPhase(s, label, "eject", 0.20, 0.27);
    noteReloadPhase(ctx, s, label, "eject", ejectPhase);
    const ejectShot = reloadMoneyShot(ctx, s, `${shotPrefix}-reload-eject`);
    const dropPhase = await waitReloadPhase(s, label, "drop/belt", 0.43, 0.58);
    await ejectShot;
    noteReloadPhase(ctx, s, label, "drop/belt", dropPhase);
    await reloadMoneyShot(ctx, s, `${shotPrefix}-reload-drop`);
  }
  await s.waitProbeCall(
    () => s.oracle(),
    (oracle) => {
      const weapon = oracle?.actors?.[s.actorId]?.weapon;
      return Number(weapon?.reloadRemainingTicks ?? -1) === 0
        && Number(weapon?.loadedRounds ?? 0) === MAGAZINE_SIZE;
    },
    { label: `${label} reload completion`, timeoutMs: 12000 },
  );
}

export default {
  id: "carbine-progression",
  title: "Marksman carbines — Kiln IV → Lightning Master",
  timeoutMs: 170000,
  characters: [{
    role: "primary",
    id: "h3d-carbine-probe",
    name: "CarbineProbe",
    x: 582,
    y: 512,
    initialProfessionId: "marksman",
    skillBoxIds: ["marksman-novice", "marksman-rifle-i"],
  }],
  async arm(ctx) {
    await ctx.debugCommand({ SetEquippedWeapon: { weapon_id: null } });
    const kiln = await ctx.debugCommand({
      DebugGiveItem: { item_id: ITEM.kilnCarbine, variant_id: 0, quantity: 1, equip: false },
    });
    const lightning = await ctx.debugCommand({
      DebugGiveItem: { item_id: ITEM.lightningCarbine, variant_id: 0, quantity: 1, equip: false },
    });
    ctx.note(`give Kiln -> ${JSON.stringify(kiln.receipt ?? kiln.error ?? "?")}; Lightning -> ${JSON.stringify(lightning.receipt ?? lightning.error ?? "?")}`);
  },
  async run(ctx) {
    const s = ctx.primary;
    await waitHostile(ctx, s);
    const acquired = await acquireTarget(ctx, s);
    const targetId = acquired.selectedActorId;
    await approachHostile(ctx, s, 16);
    ctx.note(`targeted ${targetId}`);
    await zoomForWeaponProof(s);

    await openInventory(s);
    await assertRejectedEquip(ctx, s, ITEM.kilnCarbine, "Kiln before Rifle IV");
    await ctx.moneyShot("01-kiln-cert-reject");
    const rifleGrant = await ctx.debugCommand({
      DebugGrantSkillBoxes: { skill_box_ids: ["marksman-rifle-ii", "marksman-rifle-iii", "marksman-rifle-iv"] },
    });
    s.assert(rifleGrant.receipt?.accepted === true, `Rifle IV grant rejected: ${JSON.stringify(rifleGrant.receipt ?? rifleGrant.error ?? null)}`);
    await assertAcceptedEquip(ctx, s, ITEM.kilnCarbine, "wpn-carbine", "Kiln after Rifle IV");
    await fireAndReload(ctx, s, "Kiln", "02-kiln");

    await openInventory(s);
    await assertRejectedEquip(ctx, s, ITEM.lightningCarbine, "Lightning before Marksman Master");
    await ctx.moneyShot("03-lightning-cert-reject");
    const masterGrant = await ctx.debugCommand({
      DebugGrantSkillBoxes: { skill_box_ids: ["marksman-master"] },
    });
    s.assert(masterGrant.receipt?.accepted === true, `Marksman Master grant rejected: ${JSON.stringify(masterGrant.receipt ?? masterGrant.error ?? null)}`);
    await assertAcceptedEquip(ctx, s, ITEM.lightningCarbine, "lightning-carbine", "Lightning after Marksman Master");
    await fireAndReload(ctx, s, "Lightning", "04-lightning", targetId);
    // /peace clears the owner repeat queue and latches peaceRequested, but the
    // 8s combat linger stays open while nearby hostiles keep landing hits and
    // re-bumping combat_until. A single short KeyA stride (~4 cells) is not
    // enough under slow farm ticks — keep walking west in bounded chunks until
    // authority actually drops inCombat (past sparring range), then prove stow.
    await s.slash("/peace");
    await s.waitProbeCall(
      () => s.oracle(),
      (oracle) => oracle?.actors?.[s.actorId]?.peaceRequested === true,
      { label: "Lightning peace latch", timeoutMs: 8000 },
    );
    const stowOutOfCombat = (oracle) => (
      oracle?.actors?.[s.actorId]?.inCombat !== true
        && oracle?.actors?.[s.actorId]?.peaceRequested === true
    );
    let stowed = await s.oracle().then(stowOutOfCombat).catch(() => false);
    // 4s hold chunks × 8 = up to 32s of westward travel (~40+ cells at walk),
    // enough to leave sparring engagement range even when ticks run slow.
    for (let chunk = 0; chunk < 8 && !stowed; chunk += 1) {
      await s.hold(["KeyA"], 4000);
      // Re-assert peace so auto-return never re-arms while we break contact.
      await s.slash("/peace");
      stowed = await s.waitProbeCall(
        () => s.oracle(),
        stowOutOfCombat,
        { label: `Lightning out-of-combat after west chunk ${chunk + 1}`, timeoutMs: 2500, intervalMs: 200 },
      ).then(() => true).catch(() => false);
    }
    s.assert(stowed, "Lightning never reached out-of-combat stow authority after westward break-contact");
    const finalStow = await s.waitProbeCall(
      () => s.oracle(),
      stowOutOfCombat,
      { label: "Lightning out-of-combat stow authority", timeoutMs: 8000 },
    );
    s.assert(
      finalStow?.actors?.[s.actorId]?.inCombat !== true
        && finalStow?.actors?.[s.actorId]?.peaceRequested === true,
      "Lightning stow authority drifted after break-contact",
    );
    await ctx.delay(800);
    await ctx.moneyShot("05-lightning-stowed");
  },
};
