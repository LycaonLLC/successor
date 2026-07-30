// Journey: macros — direct client3d harness truth.
//
// This farm boots the live client without a hosted parent macro data port
// (no site iframe / secret-free CharacterStore writer). Durable successor.macros.v1
// save MUST fail closed and MUST NOT land in the local macro record/list.
// Hosted CRUD E2E is intentionally out of scope here — proven later under the
// parent-port path.
//
// What this harness DOES prove: KeyM opens the macros window, a built-in
// long-running starter macro issues a real authority command, stays live long
// enough for stop to clear it, and the placed world side-effect is cleaned up
// through ordinary slash commands.
const PROBE_NAME = "ProbePatrol";
const PROBE_BODY = "/loop forever\n/kneel\n/pause 300\n/stand\n/pause 300\n/endloop";
/** Checked-in starter pack macro with a real PlaceCamp + 15s pause window. */
const STARTER_NAME = "make-camp";
const CAMP_KIT = 3007;
/**
 * Footprint-clear outdoor site shared with camp.mjs.
 * open-desert-slice.json: commerce facility cell (500,498) size 12×9 + fine
 * collisionBounds cover old (500,500); GR0K sits at (510,514). Center (512,520)
 * keeps the authority 5×5 shelter box (half-extent 2.5 cells) on open plaza-
 * south ground clear of buildings, terminals, occupation props, and actors.
 */
const CAMP_SITE = { x: 512, y: 520 };

/** Accepted-receipt proof from the probe authority receipt tail. */
async function waitAcceptedReceipt(s, kind, { timeoutMs = 10000 } = {}) {
  return s.waitProbe(
    (p) => (p.authorityReceiptTail ?? []).some((r) => r.kind === kind && r.accepted),
    { label: `${kind} accepted receipt`, timeoutMs },
  );
}

export default {
  id: "macros",
  title: "Macros (KeyM fail-closed save + starter run/stop)",
  timeoutMs: 90000,
  characters: [{
    role: "primary",
    id: "h3d-macro-probe",
    name: "ProbeMacro",
    x: CAMP_SITE.x,
    y: CAMP_SITE.y,
    // Scout owns the camp profession chain; Camp Kit is armed in `arm`.
    initialProfessionId: "scout",
    skillBoxIds: ["scout-novice"],
  }],
  async arm(ctx) {
    // Exact prerequisite only — debug grant arms the kit; run/stop/cleanup use
    // ordinary starter + slash authority commands under proof.
    await ctx.debugCommand({ DebugGiveItem: { item_id: CAMP_KIT, variant_id: 0, quantity: 1 } });
    ctx.note("armed Camp Kit 3007 + Scout profession for make-camp starter");
  },
  async run(ctx) {
    const s = ctx.primary;

    // Open the macros window (KeyM window hotkey) — proof the authoring surface.
    await s.press("KeyM");
    await s.waitDom('.sc3d-window[data-window="macros"]', { state: "visible", timeoutMs: 6000 });
    await ctx.moneyShot("00-macros-window");

    // Durable save needs parent port / CharacterStore writer. Direct farm has
    // neither — assert fail-closed and no macro record/list appearance.
    const before = await s.page.evaluate(() => ({
      phase: window.__successor3dMacros.storePhase,
      version: window.__successor3dMacros.version,
      names: window.__successor3dMacros.list().map((m) => m.name),
    }));
    ctx.note(`store before save -> phase=${before.phase} version=${before.version} names=[${before.names.join(", ")}]`);

    const save = await s.page.evaluate(async ({ name, body }) => {
      return window.__successor3dMacros.save({ name, body });
    }, { name: PROBE_NAME, body: PROBE_BODY });
    ctx.note(`save -> ${JSON.stringify(save)}`);
    s.assert(save && save.ok === false, `direct harness must deny durable save, got: ${JSON.stringify(save)}`);
    s.assert(
      (save.reasonCode === "link_down" || save.reasonCode === "store_unbound")
        && /DENIED/u.test(String(save.status ?? "")),
      `durable save must fail closed as link_down|store_unbound with DENIED status, got: ${JSON.stringify(save)}`,
    );

    const after = await s.page.evaluate(() => ({
      phase: window.__successor3dMacros.storePhase,
      version: window.__successor3dMacros.version,
      names: window.__successor3dMacros.list().map((m) => m.name),
    }));
    ctx.note(`store after save -> phase=${after.phase} version=${after.version} names=[${after.names.join(", ")}]`);
    s.assert(
      !after.names.some((name) => name.toLowerCase() === PROBE_NAME.toLowerCase()),
      `denied save must not appear in macro record/list (saw ${PROBE_NAME})`,
    );
    ctx.note("hosted CRUD remains out of scope for direct client3d farm (parent port + CharacterStore writer)");

    // Long-running starter: PlaceCamp, then /pause 15 — stop during that window.
    const started = await s.page.evaluate((name) => window.__successor3dMacros.run(name), STARTER_NAME);
    ctx.note(`run ${STARTER_NAME} -> ${JSON.stringify(started)}`);
    s.assert(started && started.ok, `starter macro run rejected: ${JSON.stringify(started)}`);

    await waitAcceptedReceipt(s, "PlaceCamp", { timeoutMs: 12000 });
    ctx.note("PlaceCamp accepted from make-camp starter");

    const running = await s.waitProbeCall(
      () => s.page.evaluate(() => window.__successor3dMacros.runs()),
      (runs) => runs.some((r) => (
        r.name.toLowerCase() === STARTER_NAME
        && (r.status === "running" || r.status === "waiting" || r.status === "paused")
      )),
      { label: "starter macro run registered (active on 15s pause)", timeoutMs: 8000 },
    );
    ctx.note(`runs -> ${JSON.stringify(running)}`);

    const campLive = await s.waitProbe(
      (p) => (p.placedCamps ?? []).some((c) => c.isOwner),
      { label: "owner camp projected after PlaceCamp", timeoutMs: 8000 },
    );
    const camp = (campLive.placedCamps ?? []).find((c) => c.isOwner);
    s.assert(camp?.campId, `make-camp must leave an owned camp (got ${JSON.stringify(campLive.placedCamps ?? [])})`);
    ctx.note(`owned camp ${camp.campId} live during starter pause`);
    await ctx.moneyShot("01-macro-running");

    // Stop while the starter is still on its 15s pause — must halt >= 1 run.
    const stopped = await s.page.evaluate((name) => window.__successor3dMacros.stop(name), STARTER_NAME);
    ctx.note(`stop -> ${stopped} run(s) halted`);
    s.assert(stopped >= 1, `stop halted ${stopped} runs (expected >= 1)`);
    await s.waitProbeCall(
      () => s.page.evaluate(() => window.__successor3dMacros.runs()),
      (runs) => !runs.some((r) => (
        r.name.toLowerCase() === STARTER_NAME
        && (r.status === "running" || r.status === "waiting" || r.status === "paused")
      )),
      { label: "starter macro run cleared", timeoutMs: 6000 },
    );

    // Starter was interrupted mid-pause, so its trailing pack-up never ran.
    // Clean the real placed camp through the ordinary slash + accepted receipt.
    await s.slash("/pack-up-camp");
    await waitAcceptedReceipt(s, "PackUpCamp", { timeoutMs: 12000 });
    await s.waitProbe(
      (p) => !(p.placedCamps ?? []).some((c) => c.isOwner || c.campId === camp.campId),
      { label: "placed camp cleaned up after pack-up", timeoutMs: 8000 },
    );
    ctx.note(`camp ${camp.campId} packed up through ordinary /pack-up-camp`);
    await ctx.moneyShot("02-macro-stopped");
  },
};
