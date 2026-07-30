// Journey: credit chip lifecycle — LOOT → REDEEM → balance delta.
// Overlays a lootable rogue carrying a Credit Chip (item 9002, quantity IS its
// face value), fells it, HOLD-F take-alls the chip into the pack, then redeems
// it with `/redeem-chip <container> <stackId>` and asserts the authoritative
// credit balance rose by exactly the chip's value while the chip stack is gone.
// Proves owner ruling 2026-07-08: chips are physical lootable currency redeemed
// into the credit balance.
// Money shots: chip corpse, chip in pack, redeemed (balance up).
import { ITEM, findInventoryStack, holdFTakeAll, approachCorpse } from "./_helpers.mjs";

const ROGUE = "h3d-chip-rogue";
const CHIP = ITEM.creditChip; // 9002
const CHIP_VALUE = 3500;

export default {
  id: "credit-chip",
  title: "Credit chip (loot → redeem → balance)",
  timeoutMs: 150000,
  characters: [{ role: "primary", id: "h3d-chip-probe", name: "ProbeChip", x: 589, y: 512, initialProfessionId: "brawler" }],
  serverSliceOverlay: {
    actors: [{
      id: ROGUE, entity: `scenario:${ROGUE}`, areaId: "open-desert-overworld",
      label: "Chit Runner", role: "skirmisher", factionId: "rogue_troopers",
      socialGroup: "open_desert_rogues", pvpStatus: "overt",
      professionIds: ["marksman"], skillBoxIds: ["marksman-novice"],
      sprite: "adventurer-premium-male", poseSet: "idle", direction: "left",
      cell: { x: 587, y: 512 }, route: [],
      vitals: { health: 70, action: 100, spirit: 80 }, maxVitals: { health: 70, action: 100, spirit: 80 },
    }],
    // A chip in the rogue's pack becomes corpse loot on death (non-ammo
    // inventory transfers to `corpse:<id>`).
    inventory: [{
      container: `${ROGUE}:field-pack`, item: "Credit Chip", itemId: CHIP,
      variantId: 0, quantity: CHIP_VALUE, reserved: 0, available: CHIP_VALUE,
    }],
  },
  async arm(ctx) {
    await ctx.debugCommand({ DebugGiveItem: { item_id: ITEM.vibrosword, variant_id: 0, quantity: 1, equip: true } });
    await ctx.debugCommand({ DebugGrantSkillBoxes: { skill_box_ids: [
      "brawler-melee-i", "brawler-melee-ii", "brawler-melee-iii", "brawler-melee-iv",
      "brawler-attack-speed-i", "brawler-attack-speed-ii", "brawler-attack-speed-iii", "brawler-attack-speed-iv", "brawler-master",
    ] } });
    ctx.note("armed vibrosword + brawler tree; overlaid a chip-carrying rogue");
  },
  async run(ctx) {
    const s = ctx.primary;
    const { approachHostile, fightToKill } = await import("./_helpers.mjs");

    const creditsOf = async () => (await s.oracle().catch(() => null))?.actors?.[s.actorId]?.credits ?? null;
    const creditsBefore = await creditsOf();
    ctx.note(`credits before: ${creditsBefore}`);
    s.assert(typeof creditsBefore === "number", "oracle did not expose player credits");

    // Fell the chip-carrying rogue.
    await s.waitProbe((p) => (p.nearestHostile && p.nearestHostile.lifeState === "alive"), { label: "rogue present" });
    await s.slash(`/target ${ROGUE}`);
    await s.waitProbe((p) => p.selectedActorId === ROGUE, { label: "rogue targeted", timeoutMs: 5000 }).catch(() => {});
    await approachHostile(ctx, s, 1.4);
    const result = await fightToKill(ctx, s, ROGUE, { meleeRange: 1.8, timeoutMs: 60000 });
    s.assert(result.killed, "could not fell the chip-carrying rogue");

    const corpse = `corpse:${ROGUE}`;
    await s.waitProbeCall(
      () => s.oracle(),
      (o) => (o.inventory ?? []).some((r) => r.container === corpse && r.itemId === CHIP && (r.available ?? 0) > 0),
      { label: "chip on corpse", timeoutMs: 12000 },
    );
    // Money shot: the chip sitting on the corpse before we take it.
    await approachCorpse(ctx, s, ROGUE, { withinCells: 1.2 });
    await ctx.moneyShot("00-chip-corpse");
    // Walk within reach and HOLD-F take-all. The shared helper retries
    // approach + hold if the corpse drifts outside the 1.75-cell interaction
    // radius under concurrent load (the root cause of gate-only failures was
    // a swallowed .catch masking this drift).
    await holdFTakeAll(ctx, s, ROGUE);
    const chip = await (async () => {
      for (let i = 0; i < 20; i += 1) {
        const found = await findInventoryStack(s, CHIP, { timeoutMs: 1000 });
        if (found) return found;
      }
      return null;
    })();
    s.assert(chip, "HOLD-F take-all did not bring the credit chip into the pack");
    ctx.note(`chip in pack: ${chip.container} stack ${chip.stackId} x${chip.available}`);
    await ctx.moneyShot("01-chip-in-pack");

    // Redeem the chip → credits += value, chip consumed.
    await s.slash(`/redeem-chip ${chip.container} ${chip.stackId}`);
    const redeemed = await s.waitProbeCall(
      () => s.oracle(),
      (o) => {
        const creditsNow = o.actors?.[s.actorId]?.credits ?? null;
        const chipGone = !(o.inventory ?? []).some((r) => r.itemId === CHIP && String(r.container).startsWith(s.actorId) && (r.available ?? 0) > 0);
        return creditsNow === creditsBefore + CHIP_VALUE && chipGone;
      },
      { label: "credits banked + chip consumed", timeoutMs: 12000 },
    );
    const creditsAfter = redeemed.actors[s.actorId].credits;
    ctx.note(`credits after: ${creditsAfter} (delta +${creditsAfter - creditsBefore})`);
    s.assert(creditsAfter === creditsBefore + CHIP_VALUE, `credit balance delta wrong: ${creditsBefore} -> ${creditsAfter}, expected +${CHIP_VALUE}`);
    await ctx.moneyShot("02-redeemed");
  },
};
