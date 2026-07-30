// Journey: ranged exchange. Fires the slugthrower at the sparring partner and
// verifies the bolt terminates AT the target surface (CombatVisualFX 0.34c
// contract) via __successorFx.debug().lastArrival, then kills + reloads.
// Money shots: aim, fire, impact-at-surface, kill.
import { waitHostile, acquireTarget, approachHostile, fightToKill, combatTabHasLines } from "./_helpers.mjs";

export default {
  id: "ranged",
  title: "Ranged exchange (fire/impact/reload/kill)",
  timeoutMs: 150000,
  // Ideal-band distance (10 cells) from the sparring partner post (592,512).
  characters: [{
    role: "primary",
    id: "h3d-ranged-probe",
    name: "ProbeRanged",
    x: 582,
    y: 512,
    initialProfessionId: "marksman",
    // Marksman starters no longer auto-restock a held slugthrower; arm the
    // real starter rifle + ammo through the pre-entry fixture so basic_shot
    // can emit ranged_roll events the FX arrival tap can observe.
    verificationLoadout: {
      mode: "client3d-pre-entry.v1",
      items: [
        { itemId: 3101, variantId: 0, quantity: 1, equipped: true },
        { itemId: 1101, variantId: 0, quantity: 240, equipped: false },
      ],
    },
  }],
  async run(ctx) {
    const s = ctx.primary;
    await waitHostile(ctx, s);
    const acquired = await acquireTarget(ctx, s);
    const targetId = acquired.selectedActorId;
    ctx.note(`acquired ${targetId}`);
    await ctx.moneyShot("00-aim");
    // Stay in band if the partner drifted far.
    await approachHostile(ctx, s, 16);

    const arrivals0 = (await s.fx())?.lastArrival?.count ?? 0;
    await s.slash("/attack basic_shot $target");
    await ctx.moneyShot("01-fire");

    // Sustained fire throws a burst; track the TIGHTEST arrival — a hit
    // terminates at the target surface (~0.34c, CombatVisualFX contract). A
    // single spread pellet can land wide, so prove min-over-window, not first.
    let minSurface = Infinity;
    let sawArrival = false;
    const deadline = Date.now() + 12000;
    while (Date.now() < deadline) {
      await ctx.delay(350);
      const la = (await s.fx())?.lastArrival;
      if (la && la.count > arrivals0 && la.targetActorId) {
        sawArrival = true;
        minSurface = Math.min(minSurface, la.surfaceDistance);
        if (minSurface < 0.8) break;
      }
    }
    ctx.note(`arrivals seen=${sawArrival} minSurfaceDist=${Number.isFinite(minSurface) ? minSurface.toFixed(3) : "n/a"}c`);
    await ctx.moneyShot("02-impact");
    s.assert(sawArrival, "no bolt arrival registered at a target during sustained fire");
    s.assert(minSurface < 1.5, `no bolt terminated at the target surface (tightest ${minSurface.toFixed(3)}c — mid-flight vanish?)`);

    const result = await fightToKill(ctx, s, targetId, {});
    ctx.note(`fight -> killed=${result.killed} myHits=${result.myHits}`);
    await ctx.moneyShot("03-kill");
    s.assert(result.killed, `ranged did not kill the sparring partner within budget (myHits=${result.myHits})`);
    s.assert(result.myHits > 0, `no combat events attributed to the player`);

    // Reload must be accepted by authority (no reject added).
    const beforeReload = (await s.probe()).rejectedCommands;
    await s.slash("/reload");
    await ctx.delay(600);
    const afterReload = (await s.probe()).rejectedCommands;
    ctx.note(`reload rejects delta ${afterReload - beforeReload}`);
    s.assert(afterReload === beforeReload, `reload was rejected (rejects +${afterReload - beforeReload})`);

    const lines = await combatTabHasLines(s);
    await ctx.moneyShot("04-combat-tab");
    s.assert(lines > 0, `COMBAT tab shows no combat lines after the exchange`);
  },
};
