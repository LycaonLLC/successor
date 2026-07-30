// Journey: Scrapline melee exchange. Uses explicitly armed Scrapline
// Machete, closes on the camp sparring partner, and drives a basic-attack
// exchange to a kill. Proves stowed/held/first-swing presentation plus the
// authority hit, kill, and COMBAT tab. The inventory-equip journey retains
// the later-content Vibrosword equip-and-swing proof.
import { waitHostile, acquireTarget, approachHostile, fightToKill, combatTabHasLines } from "./_helpers.mjs";

export default {
  id: "melee",
  title: "Scrapline melee (stow → draw → swing → kill)",
  timeoutMs: 150000,
  // West of the sparring partner post (center+80 = 592,512); far from camp so
  // the only nearby actor is the sparring rogue.
  characters: [{ role: "primary", id: "h3d-melee-probe", name: "ProbeMelee", x: 589, y: 512, initialProfessionId: "brawler" }],
  async arm(ctx) {
    // Trained brawler: attack-speed tree drives the swing cadence to the 1s
    // floor + melee tree the damage, so the exchange resolves in-budget.
    const grant = await ctx.debugCommand({ DebugGrantSkillBoxes: { skill_box_ids: [
      "brawler-melee-i", "brawler-melee-ii", "brawler-melee-iii", "brawler-melee-iv",
      "brawler-attack-speed-i", "brawler-attack-speed-ii", "brawler-attack-speed-iii", "brawler-attack-speed-iv", "brawler-master",
    ] } });
    await ctx.debugCommand({ DebugGiveItem: { item_id: 3105, variant_id: 0, quantity: 1 } });
    await ctx.debugCommand({ SetEquippedWeapon: { weapon_id: "scrapline-machete", weapon_item_id: 3105, weapon_variant_id: 0 } });
    ctx.note(`grant brawler tree -> ${JSON.stringify(grant.receipt ?? grant.error ?? "?")}`);
  },
  async run(ctx) {
    const s = ctx.primary;
    const starter = await s.waitProbeCall(
      () => s.oracle(),
      (oracle) => oracle?.actors?.[s.actorId]?.weapon?.weaponId === "scrapline-machete"
        && Number(oracle.actors[s.actorId].weapon.weaponItemId ?? 0) === 3105,
      { timeoutMs: 8000, label: "equipped Scrapline authority state" },
    );
    ctx.note(`equipped weapon -> ${JSON.stringify(starter.actors[s.actorId].weapon)}`);
    await waitHostile(ctx, s);
    await ctx.moneyShot("00-scrapline-stowed");

    const acquired = await acquireTarget(ctx, s);
    const targetId = acquired.selectedActorId;
    ctx.note(`acquired ${targetId}`);
    await ctx.moneyShot("01-target-acquired");

    const closed = await approachHostile(ctx, s, 1.4);
    ctx.note(`closed to ${closed ? closed.distanceCells.toFixed(2) : "?"} cells`);
    await ctx.moneyShot("02-scrapline-in-melee-range");

    // Arm the FIRST attack from the stowed state and catch the real swing
    // montage after the authored draw. This is the browser-level regression
    // for the fire-token/draw race in PawnRenderer.
    await s.slash("/attack basic_shot $target");
    const firstSwing = await s.waitProbe(
      (probe) => String(probe.activeClipsByLayer?.montage ?? "").startsWith("swing_"),
      { timeoutMs: 8000, label: "Scrapline first swing montage after draw" },
    );
    ctx.note(`first Scrapline montage -> ${firstSwing.activeClipsByLayer.montage}`);
    await ctx.moneyShot("03-scrapline-first-swing");

    const result = await fightToKill(ctx, s, targetId, { meleeRange: 1.8, timeoutMs: 70000 });
    ctx.note(`fight -> killed=${result.killed} sawMyHit=${result.sawMyHit} lastTargetHp=${result.lastTargetHp} downedDelta=${result.downedDelta}`);
    await ctx.moneyShot("04-kill");

    s.assert(result.sawMyHit, `no Scrapline hit attributed to the player during the exchange`);
    s.assert(result.killed, `Scrapline did not down the sparring partner within budget (lastTargetHp=${result.lastTargetHp})`);

    const lines = await combatTabHasLines(s);
    ctx.note(`combat tab lines=${lines}`);
    await ctx.moneyShot("05-combat-tab");
    s.assert(lines > 0, `COMBAT tab shows no combat lines after the exchange`);
  },
};
