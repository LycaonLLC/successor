import { describe, expect, it } from "vitest";

import { Compositor, surfaceToText } from "./compositor";
import { PLAIN, Surface, stringWidth, style, wrapText } from "./surface";
import { SLATE } from "../theme";

describe("surface", () => {
  it("clips text at the limit and never writes out of bounds", () => {
    const surface = new Surface(10, 2);
    surface.text(6, 0, "OVERFLOW", PLAIN);
    surface.text(-2, 1, "LEAD", PLAIN);
    expect(surfaceToText(surface)).toBe("      OVER\nAD");
  });

  it("wide glyphs occupy two cells and refuse to straddle the clip edge", () => {
    const surface = new Surface(5, 1);
    surface.text(0, 0, "字ab字", PLAIN); // second 字 needs cols 4+5; col 5 is clipped → dropped
    expect(stringWidth("字ab字")).toBe(6);
    expect(surfaceToText(surface)).toBe("字ab");
  });

  it("gauges render eighth-block partials over a dotted track", () => {
    const surface = new Surface(8, 1);
    surface.gauge(0, 0, 8, 0.5, style({ fg: SLATE.brass }), style({ fg: SLATE.faint }));
    expect(surfaceToText(surface)).toBe("████····");
    const partial = new Surface(4, 1);
    partial.gauge(0, 0, 4, 0.6, style({ fg: SLATE.brass }), style({ fg: SLATE.faint }));
    expect(surfaceToText(partial)).toBe("██▍·");
  });

  it("boxes carry stenciled titles on the top rule", () => {
    const surface = new Surface(14, 3);
    surface.box(0, 0, 14, 3, PLAIN, "RADAR");
    const rows = surfaceToText(surface).split("\n");
    expect(rows[0]).toBe("┌ RADAR ─────┐");
    expect(rows[2]).toBe("└────────────┘");
  });

  it("wraps prose with a hang indent and hard-breaks monster tokens", () => {
    const wrapped = wrapText("the scanner paints iron thickest to the north", 16, 2);
    expect(wrapped[0]).toBe("the scanner");
    expect(wrapped.slice(1).every((row) => row.startsWith("  "))).toBe(true);
    const hard = wrapText("xxxxxxxxxxxxxxxxxxxxxxxx", 10, 2);
    expect(hard.length).toBeGreaterThan(1);
  });
});

describe("compositor", () => {
  it("first render paints; identical second render emits no cell writes", () => {
    const chunks: string[] = [];
    const compositor = new Compositor((chunk) => chunks.push(chunk), "truecolor");
    const surface = new Surface(12, 2);
    surface.text(0, 0, "HELLO", PLAIN);
    compositor.render(surface);
    const firstBytes = chunks.join("");
    expect(firstBytes).toContain("HELLO");

    chunks.length = 0;
    compositor.render(surface);
    const secondBytes = chunks.join("");
    expect(secondBytes).not.toContain("HELLO");
    expect(secondBytes.length).toBeLessThan(24); // sync begin/end only
  });

  it("damage repaints only the changed run", () => {
    const chunks: string[] = [];
    const compositor = new Compositor((chunk) => chunks.push(chunk), "truecolor");
    const a = new Surface(20, 2);
    a.text(0, 0, "HP 096", PLAIN);
    compositor.render(a);
    chunks.length = 0;
    const b = new Surface(20, 2);
    b.text(0, 0, "HP 084", PLAIN);
    compositor.render(b);
    const bytes = chunks.join("");
    expect(bytes).toContain("84");
    expect(bytes).not.toContain("HP"); // unchanged prefix untouched
  });
});
