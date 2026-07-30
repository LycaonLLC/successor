// Journey: travel. At the Dustgate terminal, purchases a ticket to Verdance/
// Lowbough and uses it, proving the planetfall area transition (activeAreaId
// flips + the arrival load screen). Money shots: origin, arrival on Verdance.
export default {
  id: "travel",
  title: "Travel (purchase + planetfall)",
  timeoutMs: 100000,
  characters: [{ role: "primary", id: "h3d-travel-probe", name: "ProbeTravel", x: 522, y: 512, initialProfessionId: "brawler" }],
  async run(ctx) {
    const s = ctx.primary;
    const start = await s.waitProbe((p) => p.serverStatus === "connected", { label: "spawn" });
    ctx.note(`origin area ${start.activeAreaId}`);
    s.assert(start.activeAreaId === "open-desert-overworld", `expected to start on open-desert, got ${start.activeAreaId}`);
    await ctx.moneyShot("00-origin");

    // The terminal interaction is the only player route to the travel surface.
    await s.waitProbe(
      (probe) => (probe.interactions ?? []).some((option) => option.kind === "travelTerminal"),
      { label: "Dustgate travel terminal interaction", timeoutMs: 8000 },
    );
    await s.press("KeyF");
    await s.waitDom('.sc3d-window[data-window="travel"]', { state: "visible", timeoutMs: 6000 });
    await ctx.moneyShot("01-travel-window");

    // Purchase a ticket to Verdance/Lowbough, then use it (must be at origin).
    const buy = await s.slash("/purchase-travel-ticket travel-terminal-dustgate verdance lowbough");
    await ctx.delay(600);
    const afterBuyRejects = (await s.probe()).rejectLog ?? [];
    ctx.note(`post-purchase rejects ${JSON.stringify(afterBuyRejects.slice(-1))}`);
    await s.slash("/use-travel-ticket");

    // Planetfall: activeAreaId flips to Verdance.
    const arrived = await s.waitProbe(
      (p) => p.activeAreaId === "verdance-forest-overworld",
      { label: "planetfall to Verdance", timeoutMs: 30000 },
    );
    ctx.note(`arrived area ${arrived.activeAreaId}`);
    await s.waitLoadScreenClear().catch(() => {});
    await ctx.delay(600);
    await ctx.moneyShot("02-arrival-verdance");
    s.assert(arrived.activeAreaId === "verdance-forest-overworld", `did not planetfall to Verdance`);
  },
};
