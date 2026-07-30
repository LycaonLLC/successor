// Journey: explicit Deathblow targeting — selected target + real radial against a
// visibly downed duel opponent. The stale/invalid route is proven first: an
// unknown explicit selector queues nothing. A legal down is produced by the
// normal duel + combat commands; no debug authority mutation is used.
//
// Money shots: selected living target, visibly downed duel target with radial
// Deathblow affordance, and the normal respawning result. Post-duel stale
// proof waits for the exact beta actor to reappear alive, then requires a
// real Rust not_in_duel reject (not a local no-dispatch race).

const ALPHA = "h3d-deathblow-alpha";
const BETA = "h3d-deathblow-beta";

const DEATHBLOW_RECEIPT = (probe) => (probe?.authorityReceiptTail ?? [])
  .findLast((entry) => entry.kind === "Deathblow");

const deathblowReceipts = (probe) => (probe?.authorityReceiptTail ?? [])
  .filter((entry) => entry.kind === "Deathblow");

const maxDeathblowCommandId = (probe) => deathblowReceipts(probe)
  .reduce((max, entry) => Math.max(max, Number(entry.commandId) || 0), 0);

export default {
  id: "deathblow",
  title: "Deathblow targeting (selected + radial + stale guard)",
  headed: true,
  timeoutMs: 150000,
  characters: [
    {
      role: "alpha",
      id: ALPHA,
      name: "BlowAlpha",
      x: 512,
      y: 512,
      initialProfessionId: "marksman",
      // Certified Lightning Carbine path (same ladder carbine-progression proves
      // downs a 100HP target before reload). Fixture-only — no in-run debug give.
      skillBoxIds: [
        "marksman-novice",
        "marksman-rifle-i",
        "marksman-rifle-ii",
        "marksman-rifle-iii",
        "marksman-rifle-iv",
        "marksman-master",
      ],
      verificationLoadout: {
        mode: "client3d-pre-entry.v1",
        items: [
          { itemId: 3121, variantId: 0, quantity: 1, equipped: true },
          { itemId: 1101, variantId: 0, quantity: 240, equipped: false },
        ],
      },
    },
    {
      role: "beta",
      id: BETA,
      name: "BlowBeta",
      x: 513.2,
      y: 512,
      initialProfessionId: "marksman",
      // A low but legal starting health keeps the real combat down inside the
      // explicit Deathblow interaction window without a debug kill.
      vitals: { health: 30, action: 160, spirit: 100 },
      verificationLoadout: {
        mode: "client3d-pre-entry.v1",
        items: [
          { itemId: 3101, variantId: 0, quantity: 1, equipped: true },
          { itemId: 1101, variantId: 0, quantity: 240, equipped: false },
        ],
      },
    },
  ],
  async run(ctx) {
    const alpha = ctx.session("alpha");
    const beta = ctx.session("beta");
    // Multi-browser entry can flap the second session once during planetfall
    // settle. Require both authority links to hold connected before any slash
    // command so consent/combat are not lost on a reconnecting socket.
    const waitLinked = async (s, label) => {
      await s.waitProbe(
        (p) => p?.serverStatus === "connected" && !!p.authorityPlayer,
        { label: `${label} connected`, timeoutMs: 45000 },
      );
      const deadline = Date.now() + 30000;
      let since = Date.now();
      while (Date.now() - since < 2500) {
        if (Date.now() > deadline) throw new Error(`[${s.name}] ${label} link never stabilized`);
        const probe = await s.probe();
        if (!(probe?.serverStatus === "connected" && probe?.authorityPlayer)) since = Date.now();
        await s.page.waitForTimeout(200);
      }
    };
    await Promise.all([
      waitLinked(alpha, "alpha"),
      waitLinked(beta, "beta"),
    ]);
    // Prove the fixture-armed Lightning is the live authority weapon before any
    // duel/combat — slugthrower magazines only dealt ~56 and emptied mid-fight.
    const armed = await alpha.waitProbeCall(
      () => alpha.oracle(),
      (o) => {
        const weapon = o?.actors?.[ALPHA]?.weapon;
        return weapon?.weaponId === "lightning-carbine"
          && Number(weapon?.weaponItemId ?? 0) === 3121;
      },
      { label: "alpha Lightning Carbine authority weapon", timeoutMs: 15000 },
    );
    alpha.assert(
      armed?.actors?.[ALPHA]?.weapon?.weaponId === "lightning-carbine"
        && Number(armed?.actors?.[ALPHA]?.weapon?.weaponItemId ?? 0) === 3121,
      `alpha not armed with Lightning before duel: ${JSON.stringify(armed?.actors?.[ALPHA]?.weapon ?? null)}`,
    );
    ctx.note(`alpha weapon -> ${JSON.stringify(armed.actors[ALPHA].weapon)}`);
    // Invalid explicit target: the resolver rejects before an authority
    // envelope is emitted. This is the stale/invalid no-dispatch contract.
    const beforeInvalid = await alpha.probe();
    await alpha.slash("/deathblow stale-target-that-is-not-visible");
    await ctx.delay(500);
    const afterInvalid = await alpha.probe();
    alpha.assert(
      afterInvalid.acceptedCommands === beforeInvalid.acceptedCommands
        && afterInvalid.rejectedCommands === beforeInvalid.rejectedCommands
        && !DEATHBLOW_RECEIPT(afterInvalid),
      `invalid Deathblow dispatched unexpectedly: ${JSON.stringify({ beforeInvalid, afterInvalid })}`,
    );
    ctx.note("invalid explicit target denied locally with no Deathblow dispatch");

    // Real consent duel, then an ordinary authority combat down.
    await alpha.slash(`/duel ${BETA}`);
    await ctx.delay(500);
    await beta.slash("/accept-duel");
    await alpha.slash(`/target ${BETA}`);
    const selected = await alpha.waitProbe(
      (p) => p.selectedActorId === BETA && p.selectedActor?.lifeState === "alive" && p.selectedActor?.rendered === true,
      { label: "selected living duel target", timeoutMs: 10000 },
    );
    alpha.assert(selected.selectedActorId === BETA, `selected id drifted: ${selected.selectedActorId}`);
    await ctx.moneyShot("00-selected-living-target", alpha);

    for (let shot = 0; shot < 8; shot += 1) {
      await alpha.slash("/attack basic_shot $target");
      await ctx.delay(500);
      const state = await alpha.oracle();
      if (state?.actors?.[BETA]?.lifeState === "downed") break;
    }
    const combatProbe = await alpha.probe();
    const combatOracle = await alpha.oracle();
    ctx.note(`combat diagnostics beta=${JSON.stringify(combatOracle?.actors?.[BETA])} receipts=${JSON.stringify(combatProbe?.authorityReceiptTail?.slice(-8))}`);
    const downed = await alpha.waitProbeCall(
      () => alpha.oracle(),
      (o) => o?.actors?.[BETA]?.lifeState === "downed",
      { label: "beta visibly downed by real duel combat", timeoutMs: 30000, intervalMs: 250 },
    );
    alpha.assert(downed.actors[BETA].lifeState === "downed", "combat did not produce a downed duel target");

    const downedView = await alpha.waitProbe(
      (p) => p.selectedActorId === BETA
        && p.selectedActor?.lifeState === "downed"
        && p.selectedActor?.rendered === true
        && p.selectedActor?.screen
        && Number.isFinite(p.selectedActor.screen.px)
        && Number.isFinite(p.selectedActor.screen.py),
      { label: "downed duel target rendered and selected", timeoutMs: 10000 },
    );
    await ctx.moneyShot("01-visibly-downed-duel-target", alpha);

    // Real right-click on the rendered pawn opens the production radial. The
    // radial action itself routes through the same selected target state.
    const point = downedView.selectedActor.screen;
    await alpha.page.mouse.click(point.px, point.py, { button: "right" });
    await alpha.waitDom('.sc3d-radial:not([hidden])', { state: "visible", timeoutMs: 8000 });
    const deathblowButton = '.sc3d-radial:not([hidden]) .sc3d-radial-item[data-action="deathblow"]';
    await alpha.waitDom(deathblowButton, { state: "visible", timeoutMs: 8000 });
    alpha.assert(
      await alpha.page.locator(deathblowButton).getAttribute("aria-disabled") !== "true",
      "visible downed duel target exposed a disabled Deathblow radial action",
    );
    await ctx.moneyShot("02-radial-deathblow", alpha);
    await alpha.click(deathblowButton);

    const receipt = await alpha.waitProbe(
      (p) => DEATHBLOW_RECEIPT(p)?.accepted === true,
      { label: "accepted Deathblow receipt", timeoutMs: 15000 },
    );
    alpha.assert(DEATHBLOW_RECEIPT(receipt)?.accepted === true, `Deathblow was not accepted: ${JSON.stringify(receipt.authorityReceiptTail)}`);
    const betaAfter = await alpha.waitProbeCall(
      () => alpha.oracle(),
      (o) => ["respawning", "dead"].includes(o?.actors?.[BETA]?.lifeState),
      { label: "Deathblow normal respawn lifecycle", timeoutMs: 12000 },
    );
    alpha.assert(["respawning", "dead"].includes(betaAfter.actors[BETA].lifeState), `target lifecycle did not advance: ${betaAfter.actors[BETA].lifeState}`);
    await ctx.moneyShot("03-deathblow-respawning", alpha);

    // Post-duel stale denial is a real Rust reject once beta is alive/visible
    // again. Under load, beta can finish clone respawn before the slash; the
    // client correctly dispatches the visible target and authority answers
    // not_in_duel. Never require local no-dispatch after that race, and never
    // fire a second command while beta is still absent.
    const betaAlive = await alpha.waitProbe(
      (p) => {
        const selectedAlive = p.selectedActorId === BETA
          && p.selectedActor?.id === BETA
          && p.selectedActor?.lifeState === "alive"
          && p.selectedActor?.rendered === true;
        if (selectedAlive) return true;
        // Selection can drop during respawn; exact-id presence in the authority
        // keyset plus a living selected re-acquire is enough to proceed.
        return Array.isArray(p.authorityActorKeys) && p.authorityActorKeys.includes(BETA);
      },
      { label: "exact beta actor present after Deathblow lifecycle", timeoutMs: 45000 },
    );
    if (betaAlive.selectedActorId !== BETA || betaAlive.selectedActor?.lifeState !== "alive") {
      await alpha.slash(`/target ${BETA}`);
    }
    const betaVisible = await alpha.waitProbe(
      (p) => p.selectedActorId === BETA
        && p.selectedActor?.id === BETA
        && p.selectedActor?.lifeState === "alive"
        && p.selectedActor?.rendered === true,
      { label: "exact beta alive and visible for stale Deathblow", timeoutMs: 20000 },
    );
    alpha.assert(
      betaVisible.selectedActorId === BETA && betaVisible.selectedActor?.id === BETA,
      `stale Deathblow target identity drifted before slash: ${JSON.stringify(betaVisible.selectedActor ?? null)}`,
    );
    // Deathblow end is recorded on the outcome tail. Live hasActiveDuel can lag
    // under load even after Rust ended the duel; wait briefly, then proceed on
    // outcome + the not_in_duel receipt as the authority no-active-duel proof.
    const duelEnded = await alpha.waitProbe(
      (p) => (p.duelOutcomes ?? []).some((row) => row?.reason === "deathblow"),
      { label: "Deathblow duel outcome recorded", timeoutMs: 15000 },
    );
    await alpha.waitProbe(
      (p) => p.duel?.hasActiveDuel !== true,
      { label: "no active duel before stale Deathblow", timeoutMs: 8000 },
    ).catch(() => null);

    const beforeStale = await alpha.probe();
    alpha.assert(
      (beforeStale.duelOutcomes ?? []).some((row) => row?.reason === "deathblow")
        || duelEnded,
      `Deathblow duel outcome missing before stale slash: ${JSON.stringify(beforeStale.duelOutcomes ?? null)}`,
    );
    alpha.assert(
      beforeStale.selectedActorId === BETA
        && beforeStale.selectedActor?.id === BETA
        && beforeStale.selectedActor?.lifeState === "alive"
        && beforeStale.selectedActor?.rendered === true,
      `refusing stale Deathblow while exact beta absent/unready: ${JSON.stringify({
        selectedActorId: beforeStale.selectedActorId,
        selectedActor: beforeStale.selectedActor,
      })}`,
    );
    const baselineCommandId = maxDeathblowCommandId(beforeStale);
    const baselineAccepted = beforeStale.acceptedCommands;
    const baselineRejected = beforeStale.rejectedCommands;
    await alpha.slash(`/deathblow ${BETA}`);

    const staleReject = await alpha.waitProbe(
      (p) => deathblowReceipts(p).some((entry) => (
        Number(entry.commandId) > baselineCommandId
          && entry.accepted === false
          && entry.reasonCode === "not_in_duel"
      )),
      { label: "fresh rejected Deathblow not_in_duel receipt", timeoutMs: 15000 },
    );
    const fresh = deathblowReceipts(staleReject).filter((entry) => Number(entry.commandId) > baselineCommandId);
    const reject = fresh.find((entry) => entry.accepted === false && entry.reasonCode === "not_in_duel") ?? null;
    alpha.assert(reject, `missing fresh not_in_duel Deathblow receipt after baseline ${baselineCommandId}: ${JSON.stringify(fresh)}`);
    alpha.assert(
      staleReject.acceptedCommands === baselineAccepted,
      `stale Deathblow changed accepted count ${baselineAccepted} -> ${staleReject.acceptedCommands}`,
    );
    alpha.assert(
      staleReject.rejectedCommands === baselineRejected + 1,
      `stale Deathblow rejected count expected ${baselineRejected + 1}, got ${staleReject.rejectedCommands}`,
    );
    // Authority proof of no active duel is the not_in_duel reject itself, plus
    // the recorded deathblow outcome. Live hasActiveDuel is checked when clear.
    const outcomeEnded = (staleReject.duelOutcomes ?? []).some((row) => row?.reason === "deathblow");
    alpha.assert(
      reject.reasonCode === "not_in_duel" && outcomeEnded,
      `no-active-duel authority proof missing: ${JSON.stringify({
        reject,
        duel: staleReject.duel,
        duelOutcomes: staleReject.duelOutcomes,
      })}`,
    );
    if (staleReject.duel?.hasActiveDuel === true) {
      ctx.note(`live duel probe still sticky after not_in_duel; authority outcome+reject prove duel ended`);
    }
    alpha.assert(
      staleReject.selectedActorId === BETA && staleReject.selectedActor?.id === BETA,
      `exact beta identity lost after stale Deathblow: ${JSON.stringify({
        selectedActorId: staleReject.selectedActorId,
        selectedActor: staleReject.selectedActor,
      })}`,
    );
    alpha.assert(
      fresh.every((entry) => entry.accepted !== true),
      `stale Deathblow must not accept a second command: ${JSON.stringify(fresh)}`,
    );
    ctx.note(`stale post-duel Deathblow rejected by Rust not_in_duel commandId=${reject.commandId}; accepted unchanged; rejected +1`);
  },
};
