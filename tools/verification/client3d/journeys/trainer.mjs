// Journey: trainer converse → unlearn → relearn. Starts from an ordinary
// Marksman novice allocation and its one-time kit, selects the Dustgate trainer via
// F-interact, then proves that the novice box spends/refunds the normal SP
// budget while the starter kit is never reissued or removed.
// Money shots: converse window, refunded ledger, restored ledger.

const MARKSMAN_NOVICE = "marksman-novice";
const SLUGTHROWER_ITEM_ID = 3_101;
const IRON_SLUG_ITEM_ID = 1_101;
const STARTER_SLUG_QUANTITY = 240;

function actorSkillBoxes(actor) {
  return (actor?.professions ?? []).flatMap((profession) => profession.skillBoxes ?? []);
}

function starterKitSnapshot(oracle, actorId) {
  const rows = (oracle?.inventory ?? [])
    .filter((row) => String(row.container).startsWith(actorId))
    .filter((row) => [SLUGTHROWER_ITEM_ID, IRON_SLUG_ITEM_ID].includes(Number(row.itemId)))
    .map((row) => ({
      itemId: Number(row.itemId),
      variantId: Number(row.variantId ?? 0),
      quantity: Number(row.quantity ?? 0),
    }))
    .sort((a, b) => a.itemId - b.itemId || a.variantId - b.variantId);
  return rows;
}

function assertExactStarterKit(s, rows, label) {
  const slugthrowers = rows.filter((row) => row.itemId === SLUGTHROWER_ITEM_ID);
  const slugs = rows.filter((row) => row.itemId === IRON_SLUG_ITEM_ID);
  s.assert(slugthrowers.length === 1, `${label}: Slugthrower row count ${slugthrowers.length} != 1: ${JSON.stringify(rows)}`);
  s.assert(slugthrowers[0]?.quantity === 1, `${label}: Slugthrower quantity ${slugthrowers[0]?.quantity} != 1`);
  s.assert(slugs.length === 1, `${label}: Iron Slug row count ${slugs.length} != 1: ${JSON.stringify(rows)}`);
  s.assert(slugs[0]?.quantity === STARTER_SLUG_QUANTITY, `${label}: Iron Slug quantity ${slugs[0]?.quantity} != ${STARTER_SLUG_QUANTITY}`);
}

function newReceipt(probe, knownCommandIds, kind) {
  return (probe.authorityReceiptTail ?? []).find((entry) => (
    !knownCommandIds.has(entry.commandId)
    && entry.kind === kind
  ));
}

export default {
  id: "trainer",
  title: "Trainer unlearn ↔ relearn",
  timeoutMs: 90000,
  // Profession 'marksman' auto-grants the single Slugthrower; explicit verificationLoadout
  // supplies only the missing starter ammunition (240 Iron Slugs) so the journey can prove
  // trainer unlearn/relearn refunds SP and auto-unequips without altering or duplicating the starter kit.
  characters: [{
    role: "primary",
    id: "h3d-trainer-probe",
    name: "ProbeTrain",
    x: 510.9,
    y: 503.2,
    initialProfessionId: "marksman",
    verificationLoadout: {
      mode: "client3d-pre-entry.v1",
      items: [
        { itemId: IRON_SLUG_ITEM_ID, variantId: 0, quantity: STARTER_SLUG_QUANTITY, equipped: false },
      ],
    },
  }],
  async run(ctx) {
    const s = ctx.primary;
    await ctx.moneyShot("00-spawn");

    const initial = await s.waitProbeCall(
      () => s.oracle(),
      (oracle) => {
        const actor = oracle?.actors?.[s.actorId];
        const kit = starterKitSnapshot(oracle, s.actorId);
        return actor?.skillPointsUsed === 16
          && actor?.skillPointsCap === 250
          && actorSkillBoxes(actor).includes(MARKSMAN_NOVICE)
          && kit.filter((row) => row.itemId === SLUGTHROWER_ITEM_ID && row.quantity === 1).length === 1
          && kit.filter((row) => row.itemId === IRON_SLUG_ITEM_ID && row.quantity === STARTER_SLUG_QUANTITY).length === 1;
      },
      { label: "Marksman novice allocation and one-time starter kit", timeoutMs: 12000 },
    );
    const initialActor = initial.actors[s.actorId];
    const initialKit = starterKitSnapshot(initial, s.actorId);
    s.assert(initialActor.skillPointsUsed === 16 && initialActor.skillPointsCap === 250, `initial SP ${initialActor.skillPointsUsed}/${initialActor.skillPointsCap} != 16/250`);
    s.assert(actorSkillBoxes(initialActor).includes(MARKSMAN_NOVICE), `initial professions omitted ${MARKSMAN_NOVICE}`);
    assertExactStarterKit(s, initialKit, "initial kit");

    // The Dustgate trainer is the nearest interactable at stand (510.9, 503.2) → F opens CONVERSE.
    await s.waitProbe(
      (p) => (p.interactions ?? []).some((o) => o.kind === "trainer" && o.targetId === "camp-trainer"),
      { label: "trainer converse interaction in reach", timeoutMs: 10000 },
    );
    let converseOpen = false;
    for (let attempt = 0; attempt < 4 && !converseOpen; attempt += 1) {
      // Re-confirm the trainer chip is still the selected interaction, then F.
      await s.waitProbe((p) => (p.interactions ?? []).some((o) => o.kind === "trainer" && o.targetId === "camp-trainer"), { label: "trainer chip", timeoutMs: 4000 }).catch(() => {});
      await s.press("KeyF");
      converseOpen = await s.page.locator('.sc3d-window[data-window="converse"]').first().isVisible().catch(() => false);
      if (!converseOpen) { await ctx.delay(900); converseOpen = await s.page.locator('.sc3d-window[data-window="converse"]').first().isVisible().catch(() => false); }
    }
    s.assert(converseOpen, "CONVERSE window did not open on F-interact with the trainer");
    const selected = await s.waitProbe(
      (probe) => probe.selectedActorId === "camp-trainer",
      { label: "camp trainer selected by F-interact", timeoutMs: 6000 },
    );
    s.assert(selected.selectedActorId === "camp-trainer", `selected actor ${selected.selectedActorId} != camp-trainer`);
    await ctx.moneyShot("01-converse-window");
    await s.assertDom(".scv-options", { visible: true }, "converse window has no options menu");

    // The Skills window uses the explicitly selected in-range trainer. First
    // remove the only box and prove the ordinary 16 SP allocation is refunded.
    await s.press("KeyK");
    await s.waitDom('.sc3d-window[data-window="skills"]', { state: "visible", timeoutMs: 8000 });
    await s.click('.scp-track[data-track="marksman"]');
    const unlearnSelector = `.scp-skill-box[data-skill-box="${MARKSMAN_NOVICE}"][data-action="unlearn"]:not(:disabled)`;
    const unlearnButton = s.page.locator(unlearnSelector).first();
    await unlearnButton.waitFor({ state: "visible", timeout: 8000 });
    const knownUnlearnIds = new Set((await s.probe()).authorityReceiptTail?.map((entry) => entry.commandId) ?? []);
    await unlearnButton.click();
    const unlearnProbe = await s.waitProbe(
      (probe) => Boolean(newReceipt(probe, knownUnlearnIds, "UnlearnSkillBox")),
      { label: `UnlearnSkillBox receipt for ${MARKSMAN_NOVICE}`, timeoutMs: 12000 },
    );
    const unlearnReceipt = newReceipt(unlearnProbe, knownUnlearnIds, "UnlearnSkillBox");
    s.assert(unlearnReceipt?.accepted === true, `UnlearnSkillBox rejected for ${MARKSMAN_NOVICE}: ${JSON.stringify(unlearnReceipt ?? null)}`);
    const unlearned = await s.waitProbeCall(
      () => s.oracle(),
      (oracle) => {
        const actor = oracle?.actors?.[s.actorId];
        return actor?.skillPointsUsed === 0
          && !actorSkillBoxes(actor).includes(MARKSMAN_NOVICE)
          && actor?.weapon?.weaponId !== "slugthrower";
      },
      { label: `${MARKSMAN_NOVICE} removed, 16 SP refunded, and uncertified weapon unequipped`, timeoutMs: 10000 },
    );
    const unlearnedActor = unlearned.actors[s.actorId];
    s.assert(unlearnedActor.skillPointsUsed === 0, `unlearned SP ${unlearnedActor.skillPointsUsed} != 0`);
    s.assert(!actorSkillBoxes(unlearnedActor).includes(MARKSMAN_NOVICE), `${MARKSMAN_NOVICE} remained after accepted unlearn`);
    s.assert(unlearnedActor.weapon?.weaponId !== "slugthrower", `unlearn left an uncertified Slugthrower equipped: ${JSON.stringify(unlearnedActor.weapon ?? null)}`);
    const unlearnedKit = starterKitSnapshot(unlearned, s.actorId);
    assertExactStarterKit(s, unlearnedKit, "post-unlearn kit");
    s.assert(JSON.stringify(unlearnedKit) === JSON.stringify(initialKit), `unlearn changed starter-kit quantities: ${JSON.stringify(initialKit)} -> ${JSON.stringify(unlearnedKit)}`);
    ctx.note(`unlearned ${MARKSMAN_NOVICE}; SP 16→0; Slugthrower auto-unequipped; kit unchanged ${JSON.stringify(unlearnedKit)}; receipt=${JSON.stringify(unlearnReceipt)}`);
    await ctx.moneyShot("02-unlearned-refund");

    // Relearn that exact novice box through the same selected trainer. The SP
    // spend returns to 16, but first-entry provisioning must not run again.
    const trainSelector = `.scp-skill-box[data-skill-box="${MARKSMAN_NOVICE}"][data-action="train"]:not(:disabled)`;
    const trainButton = s.page.locator(trainSelector).first();
    await trainButton.waitFor({ state: "visible", timeout: 8000 });
    const knownTrainIds = new Set((await s.probe()).authorityReceiptTail?.map((entry) => entry.commandId) ?? []);
    await trainButton.click();
    const trainProbe = await s.waitProbe(
      (probe) => Boolean(newReceipt(probe, knownTrainIds, "PurchaseSkillBox")),
      { label: `PurchaseSkillBox receipt for ${MARKSMAN_NOVICE}`, timeoutMs: 12000 },
    );
    const trainReceipt = newReceipt(trainProbe, knownTrainIds, "PurchaseSkillBox");
    s.assert(trainReceipt?.accepted === true, `PurchaseSkillBox rejected for ${MARKSMAN_NOVICE}: ${JSON.stringify(trainReceipt ?? null)}`);
    const relearned = await s.waitProbeCall(
      () => s.oracle(),
      (oracle) => {
        const actor = oracle?.actors?.[s.actorId];
        return actor?.skillPointsUsed === 16 && actorSkillBoxes(actor).includes(MARKSMAN_NOVICE);
      },
      { label: `${MARKSMAN_NOVICE} restored with normal 16 SP spend`, timeoutMs: 10000 },
    );
    const relearnedActor = relearned.actors[s.actorId];
    s.assert(relearnedActor.skillPointsUsed === 16, `relearned SP ${relearnedActor.skillPointsUsed} != 16`);
    s.assert(actorSkillBoxes(relearnedActor).includes(MARKSMAN_NOVICE), `${MARKSMAN_NOVICE} missing after accepted relearn`);
    const relearnedKit = starterKitSnapshot(relearned, s.actorId);
    assertExactStarterKit(s, relearnedKit, "post-relearn kit");
    s.assert(JSON.stringify(relearnedKit) === JSON.stringify(initialKit), `relearn duplicated or changed starter kit: ${JSON.stringify(initialKit)} -> ${JSON.stringify(relearnedKit)}`);
    ctx.note(`relearned ${MARKSMAN_NOVICE}; SP 0→16; kit still unchanged ${JSON.stringify(relearnedKit)}; receipt=${JSON.stringify(trainReceipt)}`);
    await ctx.moneyShot("03-relearned");
  },
};
