import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { initTerminalPreview } from "../src/features/home";

const homeCss = readFileSync(resolve(process.cwd(), "src/styles/home.css"), "utf8");

describe("home terminal opening", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("IntersectionObserver", undefined);
    document.body.innerHTML = `
      <section data-terminal-preview>
        <button data-terminal-replay>Replay opening</button>
      </section>
    `;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    document.body.innerHTML = "";
  });

  it("plays, returns to the field, and can replay", () => {
    initTerminalPreview(document, false);
    const preview = document.querySelector<HTMLElement>("[data-terminal-preview]");
    const replay = document.querySelector<HTMLButtonElement>("[data-terminal-replay]");
    expect(preview?.dataset.crawlState).toBe("playing");
    expect(replay?.disabled).toBe(true);
    vi.advanceTimersByTime(10_500);
    expect(preview?.dataset.crawlState).toBe("field");
    expect(replay?.disabled).toBe(false);
    replay?.click();
    expect(preview?.dataset.crawlState).toBe("playing");
  });

  it("does not animate when reduced motion is requested", () => {
    initTerminalPreview(document, true);
    const preview = document.querySelector<HTMLElement>("[data-terminal-preview]");
    expect(preview?.dataset.crawlState).toBeUndefined();
  });

  it("recedes along the tilted plane and exits behind a hard horizon", () => {
    expect(homeCss).toContain("perspective-origin: 50% 10%;");
    expect(homeCss).toMatch(/\.terminal-crawl::after\s*\{[\s\S]*?height:\s*10\.5%;/);
    expect(homeCss).toContain(
      "transform: translateX(-50%) rotateX(56deg) translateY(42%);",
    );
    expect(homeCss).toContain(
      "transform: translateX(-50%) rotateX(56deg) translateY(-520%);",
    );
    expect(homeCss).not.toContain("mask-image");
    expect(homeCss).not.toContain("translate(-50%, 36%) rotateX(58deg)");
  });
});
