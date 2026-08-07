import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readPage, ROUTE_FILES, sitePath } from "./helpers";

const NAV_HREFS = ["/", "/roadmap/", "/alpha/", "/account/", "/play/"];
const CREDIT = "From Lycaon LLC, in partnership with ROYCORP GAME STUDIOS.";
const PREALPHA = "Invite alpha. Saves may reset.";

describe("routes and deep links", () => {
  it.each([...ROUTE_FILES])("%s exists as a real file for static deep links", (route) => {
    expect(readPage(route).length).toBeGreaterThan(0);
  });

  it.each([...ROUTE_FILES])("%s carries the shared accessible chrome", (route) => {
    const html = readPage(route);
    expect(html).toContain('<html lang="en">');
    expect(html).toContain('class="skip-link" href="#main"');
    expect(html).toContain('<main id="main"');
    expect(html).toMatch(/<title>[^<]+<\/title>/);
    expect(html).toMatch(/<meta\s+name="description"/);
    expect(html.match(/<h1[\s>]/g)).toHaveLength(1);
    for (const href of NAV_HREFS) expect(html).toContain(`href="${href}"`);
    if (route !== "play/index.html") {
      expect(html).toContain(CREDIT);
      expect(html).toContain(PREALPHA);
      expect(html).toContain('href="/legal/terms/"');
      expect(html).toContain('href="/legal/privacy/"');
      expect(html).toContain('href="/download/"');
    }
  });

  it.each([...ROUTE_FILES])("%s ships no inline style attributes (CSP style-src bans them)", (route) => {
    expect(readPage(route)).not.toMatch(/\sstyle="/);
  });

  it("marks the current page in the nav", () => {
    expect(readPage("alpha/index.html")).toContain('href="/alpha/" aria-current="page"');
    expect(readPage("roadmap/index.html")).toContain('href="/roadmap/" aria-current="page"');
    expect(readPage("account/index.html")).toContain('href="/account/" aria-current="page"');
    expect(readPage("play/index.html")).toContain('href="/play/" aria-current="page"');
  });

  it("keeps alpha and roadmap as static MPA inputs", () => {
    const vite = readFileSync(sitePath("vite.config.ts"), "utf8");
    expect(vite).toContain('alpha: resolve(__dirname, "alpha/index.html")');
    expect(vite).toContain('roadmap: resolve(__dirname, "roadmap/index.html")');
  });
});

describe("alpha access route", () => {
  const alpha = readPage("alpha/index.html");
  const flat = alpha.replace(/\s+/g, " ");

  it("states the admissions model without a sales pitch", () => {
    expect(alpha).toContain("Successor Alpha");
    expect(flat).toContain("Invite alpha. Admissions open and close.");
    expect(flat).toContain("No waitlist. Register when admissions are open; otherwise sign in.");
  });

  it("routes to account, connect, play, and download without fake redeem/waitlist doors", () => {
    expect(alpha).toContain('href="/account/"');
    expect(alpha).toContain(">Account<");
    expect(alpha).toContain('href="/connect/"');
    expect(alpha).toContain("Connect device");
    expect(alpha).toContain('href="/play/"');
    expect(alpha).toContain(">Play<");
    expect(alpha).toContain('href="/download/"');
    expect(alpha).toContain(">Download<");
    expect(alpha).not.toMatch(/apply now|request access|redeem an invite|invite code/i);
    expect(alpha).not.toMatch(/<form[^>]*>(?:(?!<\/form>)[\s\S])*(?:redeem|request access|invite code)[\s\S]*?<\/form>/i);
    expect(alpha).not.toContain("Pick the door");
    expect(alpha).not.toContain("Write the password down somewhere real");
  });
});

describe("roadmap route", () => {
  const roadmap = readPage("roadmap/index.html");
  const flat = roadmap.replace(/\s+/g, " ");

  it("uses the short title and honest intro", () => {
    expect(roadmap).toContain("Where it stands");
    expect(flat).toContain("A short ledger. Nothing here is a promise.");
  });

  it("separates the three status groups and does not sell deferred work as live", () => {
    for (const label of ["Live in alpha", "In playtesting", "Later"]) {
      expect(roadmap).toContain(label);
    }
    const liveAt = roadmap.indexOf("Live in alpha");
    const playAt = roadmap.indexOf("In playtesting");
    const horizonAt = roadmap.indexOf(">Later<");
    expect(liveAt).toBeGreaterThan(0);
    expect(playAt).toBeGreaterThan(liveAt);
    expect(horizonAt).toBeGreaterThan(playAt);

    const liveChunk = roadmap.slice(liveAt, playAt);
    expect(liveChunk).not.toMatch(/Open registration|Mail and markets|WebTransport/i);
    expect(roadmap).toContain("Open registration");
    expect(roadmap).toContain("Mail and markets");
  });

  it("grounds live claims in current world facts only", () => {
    expect(roadmap).toContain("Open desert and Verdance forest");
    expect(roadmap).toContain("Browser play, Linux, and macOS builds are live.");
    expect(roadmap).toContain("A native and web client, rebuilt from the metal up.");
    expect(roadmap).not.toMatch(/sea travel|territorial claims|two planets|marketplace is live/i);
  });
});

describe("home terminal presentation", () => {
  const home = readPage("index.html");

  it("uses real TUI text and never the rejected narrow graphical capture", () => {
    expect(home).toContain('data-slot="home-terminal-tui"');
    expect(home).toContain("SUCCESSOR · OPEN DESERT");
    expect(home).toContain("[local] Rusk: anyone near the extractor?");
    expect(home).not.toContain("mobile-surface-390.webp");
  });

  it("shows the same original Dustgate opening used by the terminal", () => {
    expect(home).toContain("Dustgate holds the desert margin.");
    expect(home).toContain("The rest is already out there.");
    expect(home).toContain("Replay opening");
  });
});

describe("core copy hygiene", () => {
  it("keeps braille art out of every public surface", () => {
    for (const route of ROUTE_FILES) {
      expect(readPage(route), route).not.toMatch(/[\u2800-\u28ff]/u);
    }
    const srcDir = sitePath("src");
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
        entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)],
      );
    for (const file of walk(srcDir)) {
      expect(readFileSync(file, "utf8"), file).not.toMatch(/[\u2800-\u28ff]/u);
    }
  });

  it("never sells engineering or marketing slop on any public surface", () => {
    const banned = [
      /not published yet/i,
      /no starter weapon/i,
      /profession (?:supply )?kit/i,
      /world state/i,
      /\bsimulation\b/i,
      /\brenderer\b/i,
      /\bauthoritative\b/i,
      /server capacity/i,
      /feature parity/i,
      /\boptimization\b/i,
      /database migration/i,
      /persistent character/i,
      /authoritative server/i,
      /living world/i,
      /seamless/i,
      /next-generation/i,
      /immersive/i,
      /endless possibilities/i,
      /forge your path/i,
      /shape the world/i,
      /\bembark\b/i,
      /\bdelve\b/i,
      /\bharness\b/i,
      /\becosystem\b/i,
      /\bschema\b/i,
      /\bchecksum\b/i,
      /release identity/i,
      /\bunlock\b/i,
      /level up/i,
      /your story/i,
      /friends pre-alpha/i,
      /No status page yet/i,
    ];
    for (const route of ROUTE_FILES) {
      const html = readPage(route);
      for (const pattern of banned) {
        expect(html, `${route} matches ${pattern}`).not.toMatch(pattern);
      }
    }
  });

  it("never mentions the storefront platform or its vocabulary", () => {
    for (const route of ROUTE_FILES) {
      expect(readPage(route)).not.toMatch(/compress/i);
    }
    const srcDir = sitePath("src");
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
        entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)],
      );
    for (const file of walk(srcDir)) {
      expect(readFileSync(file, "utf8"), file).not.toMatch(/compress/i);
    }
  });
});

describe("legal pages", () => {
  const terms = readPage("legal/terms/index.html");
  const privacy = readPage("legal/privacy/index.html");

  it("both carry the version, the owner, and the partnership credit", () => {
    for (const page of [terms, privacy]) {
      expect(page).toContain("Version 2026-07-24");
      expect(page).toContain("Lycaon LLC");
      expect(page).toContain("ROYCORP GAME STUDIOS");
    }
  });

  it("states the no-recovery account model plainly", () => {
    expect(terms).toContain("If you lose the password, the account is gone.");
    expect(privacy).toContain("No email.");
  });

  it("discloses the cookie by name and the password handling honestly", () => {
    expect(privacy).toContain("__Host-successor_session");
    expect(privacy).toContain("never stored");
  });

  it("keeps a contact anchor and invents no address or jurisdiction", () => {
    expect(terms).toContain('id="contact"');
    for (const page of [terms, privacy]) {
      expect(page).not.toMatch(/governed by|governing law|jurisdiction|court|arbitration/i);
      expect(page).not.toMatch(/\d+\s+(street|st\.|avenue|ave\.|road|suite)/i);
    }
  });
});

describe("functional route hooks", () => {
  it("account keeps session, auth, roster, devices, delete, and creator hooks", () => {
    const html = readPage("account/index.html");
    for (const id of [
      "creator-section",
      "creator-stage",
      "creator-status",
      "creator-retry",
      "api-status",
      "auth-benches",
      "login-form",
      "login-callsign",
      "login-password",
      "register-form",
      "reg-callsign",
      "reg-password",
      "reg-password-repeat",
      "reg-legal",
      "session-panel",
      "logout-button",
      "roster-section",
      "roster-list",
      "roster-status",
      "roster-retry",
      "devices-section",
      "device-list",
      "devices-status",
      "delete-section",
      "delete-form",
      "delete-password",
      "delete-confirm",
    ]) {
      expect(html).toContain(`id="${id}"`);
    }
    expect(html).toContain('data-slot="session-callsign"');
    expect(html).toContain("data-requires-session");
    expect(html).toContain('data-session-state="unknown"');
    expect(html).toContain("account-intro");
  });

  it("connect keeps device decision hooks", () => {
    const html = readPage("connect/index.html");
    for (const id of [
      "api-status",
      "signin-first",
      "decision-section",
      "device-decision-form",
      "device-code",
      "decision-result",
      "devices-section",
      "device-list",
      "devices-status",
    ]) {
      expect(html).toContain(`id="${id}"`);
    }
  });

  it("play keeps launch stage hooks", () => {
    const html = readPage("play/index.html");
    for (const id of [
      "launch-section",
      "h-launch",
      "api-status",
      "signin-first",
      "launch-form",
      "launch-character",
      "launch-character-error",
      "launch-retry",
      "launch-hint",
      "launch-result",
    ]) {
      expect(html).toContain(`id="${id}"`);
    }
    expect(html).toContain('data-stage-state="idle"');
    expect(html).toContain('class="game-stage"');
    expect(html).toContain('class="play-main"');
  });

  it("download keeps the full downloads surface", () => {
    expect(readPage("download/index.html")).toContain('data-downloads="full"');
  });
});
