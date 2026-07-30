// Journey: windows smoke — permanent player destinations open + close through
// `/ui`; contextual tool/station surfaces reject that global route.
// World-opened panes (converse/trade/loot/travel/examine) have their own
// journeys. FX LAB is dev-flag-only: absent by default, then reachable through
// `/ui fxlab` only after re-entry with ?fxlab=1.
const WINDOWS = [
  { ui: "character", id: "character" },
  { ui: "inventory", id: "inventory" },
  { ui: "datapad", id: "datapad" },
  { ui: "skills", id: "skills" },
  { ui: "actions", id: "actions" },
  { ui: "macros", id: "macros" },
  { ui: "options", id: "options" },
];

const CONTEXT_ONLY = [
  { ui: "craft", id: "craft" },
  { ui: "splice", id: "splice" },
  { ui: "survey", id: "surveyTool" },
  { ui: "author", id: "author" },
  { ui: "travel", id: "travel" },
  { ui: "loot", id: "loot" },
  { ui: "examine", id: "examine" },
];

export default {
  id: "windows",
  title: "Windows smoke (open/close all)",
  timeoutMs: 90000,
  characters: [{ role: "primary", id: "h3d-win-probe", name: "ProbeWin", x: 516, y: 512, initialProfessionId: "brawler" }],
  async run(ctx) {
    const s = ctx.primary;
    await ctx.moneyShot("00-spawn");
    // Open every panel; assert each becomes visible.
    for (const w of WINDOWS) {
      await s.slash(`/ui ${w.ui}`);
      await s.waitDom(`.sc3d-window[data-window="${w.id}"]`, { state: "visible", timeoutMs: 6000 });
      ctx.note(`opened ${w.id}`);
    }
    await ctx.delay(300);
    await ctx.moneyShot("01-all-open");

    // Every panel must be simultaneously present + visible.
    for (const w of WINDOWS) {
      await s.assertDom(`.sc3d-window[data-window="${w.id}"]`, { visible: true }, `window ${w.id} not visible after open-all`);
    }

    // Close via Escape (window manager closes the focused/topmost window per
    // press) — stacked panels occlude lower ✕ buttons, so a click on each is
    // unreliable; Escape peels the stack top-down.
    const openCount = () => s.page.evaluate(() =>
      document.querySelectorAll('.sc3d-window[data-window]:not([hidden])').length);
    let remaining = await openCount();
    for (let i = 0; i < WINDOWS.length + 4 && remaining > 0; i += 1) {
      await s.press("Escape");
      await ctx.delay(120);
      remaining = await openCount();
    }
    await ctx.moneyShot("02-all-closed");
    s.assert(remaining === 0, `${remaining} window(s) still open after Escape-close pass`);
    for (const w of WINDOWS) {
      await s.assertDom(`.sc3d-window[data-window="${w.id}"]`, { visible: false }, `window ${w.id} still visible after close`);
    }

    for (const entry of CONTEXT_ONLY) {
      await s.slash(`/ui ${entry.ui}`);
      await ctx.delay(80);
      const visible = await s.page.locator(
        `.sc3d-window[data-window="${entry.id}"]:not([hidden])`,
      ).count();
      s.assert(visible === 0, `/ui ${entry.ui} bypassed its contextual entry gate`);
    }
    ctx.note(`global /ui denied ${CONTEXT_ONLY.length} contextual surfaces`);

    // FX LAB dev flag: absent without the flag, registered with it.
    await s.slash("/ui fxlab");
    await ctx.delay(400);
    const bareCount = await s.page.locator('.sc3d-window[data-window="fxlab"]').count();
    s.assert(bareCount === 0, "fxlab window exists without the dev flag (?fxlab=1) — gate broken");
    const flaggedUrl = `${s.page.url()}&fxlab=1`;
    await s.goto(flaggedUrl);
    await s.enterWorld("h3d-win-probe");
    await s.slash("/ui fxlab");
    await s.waitDom('.sc3d-window[data-window="fxlab"]', { state: "visible", timeoutMs: 6000 });
    await ctx.moneyShot("03-fxlab-devflag");
    await s.press("Escape");
    ctx.note(`smoke covered ${WINDOWS.length} windows (opened + closed) + fxlab dev-flag gate`);
  },
};
