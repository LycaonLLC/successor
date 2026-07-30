// Journey: DUEL two-browser (consent PvP → scoped damage → honorable end).
// Alpha /duel Beta → Beta /accept-duel → scoped exchange (damage, no death) →
// Beta /yield-duel → both survive; the winner/forfeit outcome reaches the
// client combat presentation surface.
const ALPHA = "h3d-duel-alpha";
const BETA = "h3d-duel-beta";
const SLUGTHROWER_ITEM_ID = 3101;
const IRON_SLUG_ITEM_ID = 1101;
const STARTER_SLUG_QUANTITY = 240;
const STARTER_RIFLE_LOADOUT = {
  mode: "client3d-pre-entry.v1",
  items: [
    { itemId: SLUGTHROWER_ITEM_ID, variantId: 0, quantity: 1, equipped: true },
    { itemId: IRON_SLUG_ITEM_ID, variantId: 0, quantity: STARTER_SLUG_QUANTITY, equipped: false },
  ],
};

/** Wait until a multi-browser journey has held a live authority link long enough
 * that one-shot session messages (duelOutcome) will not land on a reconnecting
 * socket and vanish. Mirrors the trade journey barrier. */
async function waitLinkStable(s, label, { stableMs = 2500, timeoutMs = 30000 } = {}) {
  await s.waitProbe(
    (p) => p.serverStatus === "connected" && !!p.authorityPlayer,
    { label: `${label} link connected`, timeoutMs: 20000 },
  );
  const deadline = Date.now() + timeoutMs;
  let since = Date.now();
  while (Date.now() - since < stableMs) {
    if (Date.now() > deadline) {
      throw new Error(`[${s.name}] timed out waiting for ${label} link stability`);
    }
    const probe = await s.probe();
    if (!(probe?.serverStatus === "connected" && probe?.authorityPlayer)) {
      since = Date.now();
    }
    await s.page.waitForTimeout(200);
  }
}

export default {
  id: "duel",
  title: "Duel two-browser (consent → scoped → yield)",
  timeoutMs: 130000,
  characters: [
    {
      role: "alpha",
      id: ALPHA,
      name: "DuelAlpha",
      x: 512,
      y: 512,
      initialProfessionId: "marksman",
      verificationLoadout: STARTER_RIFLE_LOADOUT,
    },
    {
      role: "beta",
      id: BETA,
      name: "DuelBeta",
      x: 514,
      y: 512,
      initialProfessionId: "marksman",
      verificationLoadout: STARTER_RIFLE_LOADOUT,
    },
  ],
  async run(ctx) {
    const alpha = ctx.session("alpha");
    const beta = ctx.session("beta");
    // Both sides must hold a stable authority link before consent / combat /
    // yield — duelOutcome is a one-shot session message and is lost if either
    // browser is mid-reconnect when yield resolves.
    await Promise.all([
      waitLinkStable(alpha, "alpha"),
      waitLinkStable(beta, "beta"),
    ]);
    await alpha.waitProbe(
      (p) => p.muzzleWorld !== null || !!p.authorityPlayer?.weapon?.weaponId,
      { label: "alpha starter rifle armed", timeoutMs: 15000 },
    ).catch(() => null);
    await ctx.moneyShot("00-pre-duel", alpha);
    // Consent pair: challenge + accept.
    await alpha.slash(`/duel ${BETA}`);
    await ctx.delay(600);
    await beta.slash("/accept-duel");
    const duelLive = await alpha.waitProbe(
      (p) => p.duel?.hasActiveDuel === true && !!p.duel?.opponentActorId,
      { label: "alpha active duel view", timeoutMs: 10000 },
    ).catch(() => null);
    ctx.note(`active duel view=${JSON.stringify(duelLive?.duel ?? null)}`);
    await ctx.moneyShot("01-duel-accepted", alpha);
    // Scoped exchange — duel opponents are same-faction (not hostile-relation),
    // so target by id, not "nearest hostile".
    await alpha.slash(`/target ${BETA}`);
    await beta.slash(`/target ${ALPHA}`);
    const startBetaHp = (await alpha.oracle()).actors?.[BETA]?.vitals?.health ?? null;
    await alpha.slash("/attack basic_shot $target");
    await beta.slash("/attack basic_shot $target");
    // Wait for at least one side to land scoped damage rather than a blind delay.
    const mid = await alpha.waitProbeCall(
      () => alpha.oracle(),
      (o) => {
        const hp = o?.actors?.[BETA]?.vitals?.health;
        return typeof hp === "number" && startBetaHp !== null && hp < startBetaHp;
      },
      { label: "scoped duel damage on beta", timeoutMs: 12000 },
    ).catch(async () => alpha.oracle());
    const betaHp = mid?.actors?.[BETA]?.vitals?.health ?? null;
    ctx.note(`scoped exchange: beta hp ${startBetaHp} -> ${betaHp}`);
    await ctx.moneyShot("02-scoped-exchange", alpha);
    // Honorable end — Beta yields.
    await beta.slash("/yield-duel");
    // Both survive (scoped) — necessary but NOT sufficient.
    const ended = await alpha.waitProbeCall(
      () => alpha.oracle(),
      (o) => o.actors?.[ALPHA]?.lifeState === "alive" && o.actors?.[BETA]?.lifeState === "alive",
      { label: "both survive the duel", timeoutMs: 10000 },
    );
    alpha.assert(ended.actors[ALPHA]?.lifeState === "alive" && ended.actors[BETA]?.lifeState === "alive",
      "duel should end with both duellists alive (scoped, honorable yield)");
    // The duel outcome must reach the client as a winner/forfeit view, not just
    // accept receipts. Prefer the maintained presentation surfaces: probe queue,
    // combat-tab duel-result line, then DOM banner if present.
    const outcomeReached = async (s2) => {
      const probe = await s2.probe().catch(() => null);
      const outcomes = probe?.duelOutcomes ?? [];
      if (Array.isArray(outcomes) && outcomes.some((row) => row && (row.result || row.reason))) return true;
      const lines = await s2.page.locator(".sc3d-chat-combatrow").allTextContents().catch(() => []);
      if (lines.some((t) => /duel|forfeit|yield|victor|\bwon\b|\blost\b/i.test(t))) return true;
      const domBanner = await s2.page.locator('[data-ref="duelBanner"], .sc3d-duel-outcome, [data-duel-outcome]').first().isVisible().catch(() => false);
      return Boolean(domBanner);
    };
    const winnerView = await alpha.waitProbeCall(() => outcomeReached(alpha), (v) => v === true,
      { label: "duel outcome view reached the client", timeoutMs: 12000, intervalMs: 200 });
    ctx.note(`duel outcome view reached client=${winnerView}`);
    await ctx.moneyShot("03-outcome", alpha);
    alpha.assert(winnerView === true, "duel outcome view did not reach the client");
  },
};
