// The home terminal: a real 80-column TUI frame inside a game window frame.
// The opening crawl is a staggered instrument readout that settles back to
// the field screen; content is never gated on JS having run.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { readPage, sitePath } from "./helpers";

const home = readPage("index.html");
const homeCss = readFileSync(sitePath("src/styles/home.css"), "utf8");
const homeTs = readFileSync(sitePath("src/features/home.ts"), "utf8");

describe("home terminal opening", () => {
  it("ships the preview, replay control, crawl, and field frame", () => {
    expect(home).toContain("data-terminal-preview");
    expect(home).toContain("data-terminal-replay");
    expect(home).toContain("data-crawl");
    expect(home).toContain('data-slot="home-terminal-tui"');
    expect(home).toContain("DUSTGATE / FIRST CYCLE");
    expect(home).toContain("SUCCESSOR · OPEN DESERT");
  });

  it("field frame is the default; the crawl only exists while playing", () => {
    expect(homeCss).toContain(".term [data-crawl] { display: none; }");
    expect(homeCss).toContain('.term[data-crawl-state="playing"] [data-crawl] { display: block; }');
    expect(homeCss).toContain('.term[data-crawl-state="playing"] .term-field { display: none; }');
  });

  it("the stagger settles inside the replay window home.ts holds", () => {
    const intro = Number(/TERMINAL_INTRO_MS = ([\d_]+)/.exec(homeTs)?.[1]?.replaceAll("_", ""));
    expect(intro).toBeGreaterThan(0);
    const delays = [...homeCss.matchAll(/\.crawl-line:nth-child\(\d\) \{ animation-delay: (\d+)ms; \}/g)]
      .map((match) => Number(match[1]));
    expect(delays.length).toBeGreaterThanOrEqual(4);
    const duration = Number(/crawl-in (\d+)ms/.exec(homeCss)?.[1]);
    expect(duration).toBeGreaterThan(0);
    expect(Math.max(...delays) + duration).toBeLessThanOrEqual(intro);
  });

  it("uses this world's resource names, not reference-world ones", () => {
    expect(home).toContain("Daxmere iron");
    expect(home.toLowerCase()).not.toContain("dantooine");
  });

  it("keeps the real 80x24 frame as text, not a bitmap", () => {
    expect(home).toContain("<pre");
    expect(home).toContain("/attack rogue-1");
    expect(home).not.toMatch(/terminal[^"]*\.(webp|png|jpg)/);
  });
});
