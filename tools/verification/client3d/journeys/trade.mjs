// Journey: TRADE two-browser double-lock (with the scam beat). Alpha opens a
// secure table with Beta; both stake wallet credits; Alpha SEALS; Beta changes
// its amount
// (the last-second switch) which breaks BOTH seals; both re-seal + countersign
// → atomic swap. Drives the real trade windows; asserts seals/banner + the
// authoritative credit swap. Money shots: table, sealed, seals-broken, executed.
const ALPHA = "h3d-trade-alpha";
const BETA = "h3d-trade-beta";
const TRADE = '.sc3d-window[data-window="trade"]';

function credits(oracle, actorId) {
  return Number(oracle.actors?.[actorId]?.credits ?? 0);
}

export default {
  id: "trade",
  title: "Trade two-browser (double-lock + scam beat)",
  timeoutMs: 150000,
  characters: [
    {
      role: "alpha", id: ALPHA, name: "TradeAlpha", x: 512, y: 512, initialProfessionId: "brawler",
    },
    {
      role: "beta", id: BETA, name: "TradeBeta", x: 513, y: 512, initialProfessionId: "brawler",
    },
  ],
  async run(ctx) {
    const alpha = ctx.session("alpha");
    const beta = ctx.session("beta");
    // LINK-STABILITY BARRIER — the headed lane's second session drops its
    // link once (~13s after entry, at planetfall settle) and self-heals ~5s
    // later. `tradeSession` is a one-shot delivery to LIVE sessions only
    // (shard deliverTradeSessionsToParticipants), so a ProposeTrade that
    // lands mid-reconnect is silently lost and the partner window never
    // opens. No trade command flies until BOTH links have held CONNECTED
    // through a contiguous stability window.
    const linkStable = async (s, label, { stableMs = 2500, timeoutMs = 30000 } = {}) => {
      await s.waitProbe(
        (p) => p.serverStatus === "connected" && !!p.authorityPlayer,
        { label: `${label} link connected`, timeoutMs: 20000 },
      );
      const deadline = Date.now() + timeoutMs;
      let since = Date.now();
      while (Date.now() - since < stableMs) {
        s.assert(Date.now() <= deadline, `${label} link never held connected for ${stableMs}ms`);
        const p = await s.probe();
        if (!p || p.serverStatus !== "connected") since = Date.now();
        await ctx.delay(200);
      }
    };
    await Promise.all([linkStable(alpha, "alpha"), linkStable(beta, "beta")]);
    ctx.note("barrier: both links stable");
    const setCoin = async (s, amount) => {
      await s.page.fill(`${TRADE} [data-ref="coinInput"]`, String(amount));
      await s.page.press(`${TRADE} [data-ref="coinInput"]`, "Enter");
      await ctx.delay(500);
    };
    const startCreditsA = credits(await alpha.oracle(), ALPHA);
    const startCreditsB = credits(await beta.oracle(), BETA);

    // OPEN the secure table (ProposeTrade → auto-opens both sides).
    await alpha.slash(`/trade ${BETA}`);
    // BARRIER: both tables visible with a live session (coin input editable).
    await Promise.all([
      alpha.waitDom(TRADE, { state: "visible", timeoutMs: 8000 }),
      beta.waitDom(TRADE, { state: "visible", timeoutMs: 10000 }),
    ]);
    await Promise.all([
      alpha.waitDom(`${TRADE} [data-ref="coinInput"]`, { state: "visible", timeoutMs: 8000 }),
      beta.waitDom(`${TRADE} [data-ref="coinInput"]`, { state: "visible", timeoutMs: 8000 }),
    ]);
    await ctx.delay(600);
    await ctx.moneyShot("00-table-open", alpha);

    // PARALLEL OFFERS — both sides stake credits concurrently (asymmetric
    // amounts), then the barrier settles before any seal flies.
    await Promise.all([setCoin(alpha, 100), setCoin(beta, 50)]);

    // ALPHA SEALS — a diagonal SEALED stamp on both clients.
    await alpha.click(`${TRADE} [data-ref="acceptBtn"]`);
    await alpha.waitDom(`${TRADE} [data-ref="mineSeal"]`, { state: "visible", timeoutMs: 8000 });
    await ctx.moneyShot("01-alpha-sealed", alpha);
    ctx.note("alpha sealed");

    // SCAM BEAT — Beta changes credits after Alpha sealed → BOTH seals break.
    await setCoin(beta, 25);
    await alpha.waitDom(`${TRADE} [data-ref="mineSeal"]`, { state: "hidden", timeoutMs: 8000 });
    await ctx.moneyShot("02-seals-broken", alpha);
    ctx.note("scam beat: alpha seal broken by beta credit change");

    // PARALLEL LOCKS — both re-seal concurrently → the dual countersign arms.
    await Promise.all([
      alpha.click(`${TRADE} [data-ref="acceptBtn"]`),
      beta.click(`${TRADE} [data-ref="acceptBtn"]`),
    ]);
    // BARRIER: confirm armed on BOTH clients before any countersign.
    await Promise.all([
      alpha.waitDom(`${TRADE} [data-ref="confirmBtn"]:not([hidden])`, { state: "attached", timeoutMs: 10000 }),
      beta.waitDom(`${TRADE} [data-ref="confirmBtn"]:not([hidden])`, { state: "attached", timeoutMs: 10000 }),
    ]);
    ctx.note("barrier: both sealed; confirm armed");

    // PARALLEL CONFIRMS — both countersign CONCURRENTLY → atomic swap executes.
    await Promise.all([
      alpha.click(`${TRADE} [data-ref="confirmBtn"]`),
      beta.click(`${TRADE} [data-ref="confirmBtn"]`),
    ]);
    // Both projections converge on the terminal EXECUTED banner.
    await Promise.all([
      alpha.waitDom(`${TRADE} [data-ref="banner"]:not([hidden])`, { state: "attached", timeoutMs: 10000 }),
      beta.waitDom(`${TRADE} [data-ref="banner"]:not([hidden])`, { state: "attached", timeoutMs: 10000 }),
    ]);
    ctx.note("both projections show terminal banner");
    // Authoritative proof: wallet credits moved (alpha -100+25, beta -25+100).
    const swapped = await alpha.waitProbeCall(
      () => alpha.oracle(),
      (o) => credits(o, ALPHA) === startCreditsA - 100 + 25 && credits(o, BETA) === startCreditsB - 25 + 100,
      { label: "atomic credit swap executed", timeoutMs: 12000 },
    );
    ctx.note(`executed: alpha credits ${startCreditsA}->${credits(swapped, ALPHA)} beta ${startCreditsB}->${credits(swapped, BETA)}`);
    await ctx.moneyShot("03-executed", alpha);
  },
};
