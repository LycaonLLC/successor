// Stage layout guarantees, checked at the source of truth (markup + CSS):
// the game frame owns the viewport under a minimal header at every width —
// no fixed-ratio postage stamp, no marketing container choke, nothing
// below the fold, and safe-area handling for phones (390x844 included).
// Live-browser measurement happens in the release smoke pass; these tests
// pin the layout system those measurements depend on.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { readPage, sitePath } from "./helpers";

const playHtml = readPage("play/index.html");
const accountHtml = readPage("account/index.html");
const pagesCss = readFileSync(sitePath("src/styles/pages.css"), "utf8");
const tokensCss = readFileSync(sitePath("src/styles/tokens.css"), "utf8");
const componentsCss = readFileSync(sitePath("src/styles/components.css"), "utf8");

function block(css: string, selector: string): string {
  const start = css.indexOf("\n" + selector + " {");
  expect(start, "missing CSS block " + selector).toBeGreaterThanOrEqual(0);
  const end = css.indexOf("}", start);
  return css.slice(start, end);
}

describe("/play/ is a game shell", () => {
  it("puts the stage directly under the header, outside any shell container", () => {
    const mainAt = playHtml.indexOf('<main id="main" class="play-main">');
    const stageAt = playHtml.indexOf('class="game-stage"');
    const shellAt = playHtml.indexOf('<div class="shell">', mainAt);
    expect(mainAt).toBeGreaterThan(0);
    expect(stageAt).toBeGreaterThan(mainAt);
    expect(shellAt).toBe(-1);
  });

  it("ships no marketing stack or footer below the client", () => {
    expect(playHtml).not.toContain('id="h-expect"');
    expect(playHtml).not.toContain('id="h-evidence"');
    expect(playHtml).not.toContain('class="site-foot"');
    expect(playHtml).not.toContain("play-inventory-truth");
  });

  it("sizes the stage to the dynamic viewport minus the header, with safe areas", () => {
    expect(playHtml).toContain("viewport-fit=cover");
    const stage = block(pagesCss, ".game-stage");
    expect(stage).toContain("min-height: calc(100dvh - var(--topbar-h))");
    expect(stage).toContain("padding-bottom: env(safe-area-inset-bottom)");
    const body = block(pagesCss, 'body[data-page="play"]');
    expect(body).toContain("min-height: 100dvh");
    // The header is one shared token, so stage math can never drift from it.
    expect(tokensCss).toContain("--topbar-h: 3.5rem;");
    expect(block(componentsCss, ".topbar .shell")).toContain("min-height: var(--topbar-h)");
  });

  it("fills the stage edge to edge with the frame — no box, no ratio, no border", () => {
    const frame = block(pagesCss, ".stage-frame");
    expect(frame).toContain("position: absolute");
    expect(frame).toContain("inset: 0");
    expect(frame).toContain("width: 100%");
    expect(frame).toContain("height: 100%");
    expect(frame).toContain("border: 0");
    // The postage-stamp regression: any fixed-ratio choke on any stage rule.
    expect(pagesCss).not.toContain("aspect-ratio");
    expect(pagesCss).not.toContain(".game-frame");
    // No max-width anywhere in the stage system.
    expect(block(pagesCss, ".game-stage")).not.toContain("max-width");
    expect(frame).not.toContain("max-width");
  });

  it("gives a live client the entire viewport with no site chrome or document scroll", () => {
    const fullBody = block(
      pagesCss,
      'body[data-page="play"][data-play-state="live"][data-play-view="full"]',
    );
    expect(fullBody).toContain("position: fixed");
    expect(fullBody).toContain("inset: 0");
    expect(fullBody).toContain("height: 100dvh");
    expect(fullBody).toContain("overflow: hidden");
    expect(fullBody).toContain("padding: 0");
    expect(pagesCss).toContain(
      'body[data-page="play"][data-play-state="live"][data-play-view="full"] > .topbar',
    );
    expect(pagesCss).toContain(
      'body[data-page="play"][data-play-state="live"][data-play-view="full"] > .site-foot',
    );
    expect(
      block(
        pagesCss,
        'body[data-page="play"][data-play-state="live"][data-play-view="full"] .play-main',
      ),
    ).toContain("height: 100%");
    expect(
      block(
        pagesCss,
        'body[data-page="play"][data-play-state="live"][data-play-view="full"] .game-stage',
      ),
    ).toContain("height: 100%");
  });

  it("keeps an exit control above the cross-origin frame and a framed return state", () => {
    expect(playHtml).toContain('id="play-frame-exit"');
    expect(playHtml).toContain('id="play-frame-enter"');
    const controls = block(pagesCss, ".play-frame-controls");
    expect(controls).toContain("z-index: var(--z-head)");
    expect(controls).toContain("safe-area-inset-top");
    expect(block(pagesCss, ".play-frame-control")).toContain("cursor: pointer");
    expect(pagesCss).toContain(
      'body[data-page="play"][data-play-state="live"][data-play-view="framed"]',
    );
    expect(
      block(
        pagesCss,
        'body[data-page="play"][data-play-state="live"][data-play-view="framed"]',
      ),
    ).toContain("overflow: hidden");
  });
});

describe("account workshop stage", () => {
  it("puts the stage first in main, directly under the header, outside any shell", () => {
    // The below-the-fold regression (creator at y≈858 on a 1440x960 desktop):
    // the stage lived after page-head + note + roster inside main.shell. Now
    // it is the first thing in an unshelled main, exactly like /play/.
    const mainAt = accountHtml.indexOf('<main id="main">');
    const stageAt = accountHtml.indexOf('id="creator-stage"');
    const shellAt = accountHtml.indexOf('<div class="shell">', mainAt);
    expect(mainAt).toBeGreaterThan(0);
    expect(stageAt).toBeGreaterThan(mainAt);
    // Every shelled column (including the stage caption) comes after the stage.
    expect(shellAt).toBeGreaterThan(stageAt);
    // The old marketing-column wrapper is gone for good.
    expect(accountHtml).not.toContain('<main id="main" class="shell">');
    // Account lifecycle copy (roster, devices, deletion) stays below the stage.
    const stageEnd = accountHtml.indexOf("</section>", stageAt);
    expect(accountHtml.indexOf('id="h-roster"')).toBeGreaterThan(stageEnd);
    expect(accountHtml.indexOf('id="h-devices"')).toBeGreaterThan(stageEnd);
    expect(accountHtml.indexOf('id="h-delete"')).toBeGreaterThan(stageEnd);
  });

  it("sizes the stage to the dynamic viewport minus the header, with safe areas", () => {
    expect(accountHtml).toContain("viewport-fit=cover");
    const stage = block(pagesCss, ".creator-stage");
    expect(stage).toContain("min-height: calc(100dvh - var(--topbar-h))");
    expect(stage).toContain("padding-bottom: env(safe-area-inset-bottom)");
    expect(stage).toContain("width: 100%");
    expect(stage).not.toContain("max-width");
    expect(stage).not.toContain("aspect-ratio");
    // The clamp() formula that capped the stage at viewport-minus-12rem is gone.
    expect(stage).not.toContain("clamp(");
    // The 100vw full-bleed hack overshot by the scrollbar width (x=-7.5 in the
    // live proof) and risked horizontal overflow; the stage no longer needs it.
    expect(accountHtml).not.toContain("full-bleed");
  });

  it("retires the signed-out pitch while a session is active", () => {
    // Signed in, nothing sits between the topbar and the stage; the pitch
    // and the no-reset warning belong to the signed-out page only.
    expect(accountHtml).toContain('class="page-head account-intro"');
    expect(accountHtml).toContain('class="page-section account-intro"');
    expect(pagesCss).toContain(
      'body[data-page="account"][data-session-state="active"] .account-intro',
    );
  });

  it("ships loading and retry affordances in markup, and no plain form", () => {
    expect(accountHtml).toContain('id="creator-status"');
    expect(accountHtml).toContain('id="creator-retry"');
    expect(accountHtml).not.toContain("create-character-form");
    expect(accountHtml).not.toContain("char-appearance");
    // The stage starts veiled as loading; the script owns it from there.
    expect(accountHtml).toContain('data-stage-state="loading"');
  });

  it("keeps the loading pulse honest under prefers-reduced-motion", () => {
    // The veil's pulse rides the global reduced-motion kill switch.
    const baseCss = readFileSync(sitePath("src/styles/base.css"), "utf8");
    expect(baseCss).toContain("@media (prefers-reduced-motion: reduce)");
    expect(block(pagesCss, ".stage-mark")).toContain("animation:");
  });
});
