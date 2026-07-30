// Journey: weapon certification gate (combat-doctrine.md §3). A Rifle-I
// marksman is handed a crafted slugthrower (item 3101, crafted variant
// 101080090, Rifle III cert). Drawing it is honestly REJECTED
// (weapon_not_certified in the reject ring); train Rifle III and the same
// visible inventory action is ACCEPTED; the certified slugthrower fires at
// the pit trooper. Money shots: reject, certified-equip, fire.
import { waitHostile, acquireTarget, approachHostile, fightToKill } from "./_helpers.mjs";

const SLUGTHROWER = 3101;
const CRAFTED_SLUGTHROWER_VARIANT = 101_080_090; // P70 / H80 / R90

function certRejects(probe) {
  return (probe.rejectLog ?? []).filter((r) => r.reason === "weapon_not_certified").length;
}

function newEquipReceipt(probe, knownCommandIds) {
  return (probe.authorityReceiptTail ?? []).find((entry) => (
    !knownCommandIds.has(entry.commandId) && entry.kind === "SetEquippedWeapon"
  ));
}

async function openInventory(s) {
  await s.press("KeyI");
  // The first inventory open constructs two weapon previews. Under the full
  // software-GL gate that can cross ten seconds even though the key routed.
  await s.waitDom('.sc3d-window[data-window="inventory"]', { state: "visible", timeoutMs: 20000 });
}

const INVENTORY_SELECTOR = `.inv-slot[data-item-id="${SLUGTHROWER}"][data-variant-id="${CRAFTED_SLUGTHROWER_VARIANT}"]`;

export default {
  id: "certification",
  title: "Weapon certification gate (reject / cert-unlock / fire)",
  timeoutMs: 150000,
  characters: [{
    role: "primary",
    id: "h3d-cert-probe",
    name: "CertProbe",
    x: 582,
    y: 512,
    initialProfessionId: "marksman",
    skillBoxIds: ["marksman-novice", "marksman-rifle-i"],
  }],
  async arm(ctx) {
    const unequip = await ctx.debugCommand({ SetEquippedWeapon: { weapon_id: null } });
    const give = await ctx.debugCommand({
      DebugGiveItem: { item_id: SLUGTHROWER, variant_id: CRAFTED_SLUGTHROWER_VARIANT, quantity: 1, equip: false },
    });
    ctx.note(`unequip starter Slugthrower -> ${JSON.stringify(unequip.receipt ?? unequip.error ?? "?")}; give crafted slugthrower ${CRAFTED_SLUGTHROWER_VARIANT} -> ${JSON.stringify(give.receipt ?? give.error ?? "?")}; Rifle I is pre-seeded`);
  },
  async run(ctx) {
    const s = ctx.primary;
    const spawn = await s.waitProbe((p) => p.serverStatus === "connected" && p.authorityPlayer, { label: "spawn" });
    const playerActorId = spawn.playerActorId;
    await ctx.moneyShot("00-spawn");

    // Drive the exact visible inventory row. A Rifle-I marksman must be
    // rejected by the authority's Rifle-III requirement for this crafted
    // variant; do not use the slash shortcut as a substitute for the UI path.
    await openInventory(s);
    await s.waitDom(INVENTORY_SELECTOR, { state: "visible", timeoutMs: 12000 });
    const beforeReject = await s.probe();
    const rejectCountBefore = certRejects(beforeReject);
    const knownRejectCommandIds = new Set(beforeReject.authorityReceiptTail?.map((entry) => entry.commandId) ?? []);
    await s.dblclick(INVENTORY_SELECTOR);
    const rejected = await s.waitProbe(
      (p) => Boolean(newEquipReceipt(p, knownRejectCommandIds)),
      { label: "cert reject receipt", timeoutMs: 8000 },
    );
    const rejectReceipt = newEquipReceipt(rejected, knownRejectCommandIds);
    s.assert(rejectReceipt?.accepted === false && rejectReceipt.reasonCode === "weapon_not_certified",
      `uncertified crafted slugthrower draw did not reject with weapon_not_certified: ${JSON.stringify(rejectReceipt ?? null)}`);
    const rejectCountAfterDeny = certRejects(rejected);
    s.assert(rejectCountAfterDeny > rejectCountBefore,
      `uncertified draw receipt was not reflected in reject ring: before=${rejectCountBefore} after=${rejectCountAfterDeny}`);
    await s.waitProbeCall(
      () => s.page.locator(INVENTORY_SELECTOR).first().evaluate((el) => el.hasAttribute("data-equipped")),
      (equipped) => equipped === false,
      { label: "rejected crafted row remains visibly unequipped", timeoutMs: 8000 },
    );
    await s.waitProbeCall(
      () => s.oracle(),
      (oracle) => {
        const weapon = oracle?.actors?.[playerActorId]?.weapon;
        return !weapon || (weapon.weaponId !== "slugthrower" && Number(weapon.weaponItemId ?? 0) !== SLUGTHROWER);
      },
      { label: "rejected crafted weapon absent from authority state", timeoutMs: 8000 },
    );
    ctx.note(`cert reject registered (weapon_not_certified x${rejectCountAfterDeny}) receipt=${JSON.stringify(rejectReceipt)}`);
    await ctx.moneyShot("01-cert-reject");

    // Train Rifle III (with its current prerequisite box) and repeat the same
    // visible row action. Acceptance is tied to this NEW SetEquippedWeapon
    // receipt, not an aggregate command counter that could be stale.
    const certGrant = await ctx.debugCommand({
      DebugGrantSkillBoxes: { skill_box_ids: ["marksman-rifle-ii", "marksman-rifle-iii"] },
    });
    s.assert(
      certGrant.receipt?.accepted === true,
      `Rifle III debug grant rejected: ${JSON.stringify(certGrant.receipt ?? certGrant.error ?? null)}`,
    );
    const beforeAccept = await s.probe();
    const knownAcceptCommandIds = new Set(beforeAccept.authorityReceiptTail?.map((entry) => entry.commandId) ?? []);
    await s.dblclick(INVENTORY_SELECTOR);
    const equipped = await s.waitProbe(
      (p) => Boolean(newEquipReceipt(p, knownAcceptCommandIds)),
      { label: "certified equip receipt", timeoutMs: 8000 },
    );
    const equipReceipt = newEquipReceipt(equipped, knownAcceptCommandIds);
    s.assert(equipReceipt?.accepted === true,
      `certified crafted slugthrower draw rejected: ${JSON.stringify(equipReceipt ?? null)}`);
    s.assert(certRejects(equipped) === rejectCountAfterDeny, "the certified draw must NOT add a new cert reject");
    await s.waitProbeCall(
      () => s.oracle(),
      (oracle) => {
        const weapon = oracle?.actors?.[playerActorId]?.weapon;
        return weapon?.weaponId === "slugthrower"
          && Number(weapon.weaponItemId ?? 0) === SLUGTHROWER
          && Number(weapon.weaponVariantId ?? 0) === CRAFTED_SLUGTHROWER_VARIANT;
      },
      { label: "certified weapon authority state", timeoutMs: 8000 },
    );
    await s.waitProbeCall(
      () => s.page.locator(INVENTORY_SELECTOR).first().evaluate((el) => el.hasAttribute("data-equipped")),
      (isEquipped) => isEquipped === true,
      { label: "certified crafted row visibly equipped", timeoutMs: 8000 },
    );
    ctx.note(`certified slugthrower accepted after Rifle III receipt=${JSON.stringify(equipReceipt)}`);
    await ctx.moneyShot("02-certified-equipped");
    await s.press("Escape");

    // The certified slugthrower fires at the sparring trooper.
    await waitHostile(ctx, s);
    const acquired = await acquireTarget(ctx, s);
    await approachHostile(ctx, s, 16);
    const result = await fightToKill(ctx, s, acquired.selectedActorId, { timeoutMs: 30000 });
    ctx.note(`certified-weapon fight -> killed=${result.killed} myHits=${result.myHits}`);
    s.assert(result.myHits > 0, "the certified slugthrower registered no combat events");
    await ctx.moneyShot("03-fire");
  },
};
