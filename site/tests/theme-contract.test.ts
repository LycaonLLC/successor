// Five-theme contract: DAWN daylight glass by default, plus the four game
// chromes ported byte-exact from the Rust client. The client's hud.rs is the
// single source of truth — this suite reads it and holds tokens.css and
// theme.ts to the same bytes, so a client palette change that forgets the
// site (or vice versa) fails here.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readPage, ROUTE_FILES, sitePath } from "./helpers";
import { GAME_PARITY, THEMES, THEME_STORAGE_KEY, storedTheme } from "../src/features/theme";

const tokensCss = readFileSync(sitePath("src/styles/tokens.css"), "utf8");
const baseCss = readFileSync(sitePath("src/styles/base.css"), "utf8");
const componentsCss = readFileSync(sitePath("src/styles/components.css"), "utf8");
const hudRs = readFileSync(
  join(sitePath(".."), "client-rust/source/app/src/hud.rs"),
  "utf8",
);

const GAME_THEME_IDS = ["signal", "phosphor", "amber", "oxide"] as const;

/** hud.rs THEMES entries, in declaration order. */
function hudPalettes(): Array<Record<string, string>> {
  const body = hudRs.slice(hudRs.indexOf("pub const THEMES"), hudRs.indexOf("];", hudRs.indexOf("pub const THEMES")));
  const entries = [...body.matchAll(/Palette\s*\{([\s\S]*?)\}/g)];
  return entries.map((entry) => {
    const fields = entry[1] ?? "";
    const palette: Record<string, string> = {};
    for (const match of fields.matchAll(/(\w+):\s*hexa?\(0x([0-9a-fA-F]{6})/g)) {
      const [, key, hex] = match;
      if (key !== undefined && hex !== undefined) palette[key] = `#${hex.toLowerCase()}`;
    }
    return palette;
  });
}

describe("game palette parity", () => {
  const palettes = hudPalettes();

  it("hud.rs still ships exactly four themes", () => {
    expect(palettes).toHaveLength(4);
  });

  it.each(GAME_THEME_IDS.map((id, index) => [id, index] as const))(
    "%s matches hud.rs byte-for-byte in theme.ts and tokens.css",
    (id, index) => {
      const hud = palettes[index];
      if (!hud) throw new Error(`hud.rs palette ${index} missing`);
      const bgPanel = hud.bg_panel ?? "";
      const bgCell = hud.bg_cell ?? "";
      const parity = GAME_PARITY[id];
      expect(parity.accent).toBe(hud.accent);
      expect(parity.ink).toBe(hud.ink);
      expect(parity.inkDim).toBe(hud.ink_dim);
      expect(parity.hairline).toBe(hud.hairline);
      expect(parity.bgPanel).toBe(bgPanel);
      expect(parity.bgCell).toBe(bgCell);
      expect(parity.accentSoft).toBe(hud.accent_soft);
      expect(parity.danger).toBe(hud.danger);

      // tokens.css block for the theme carries the same bytes.
      const start = tokensCss.indexOf(`[data-theme="${id}"]`);
      expect(start, `tokens.css missing [data-theme="${id}"]`).toBeGreaterThan(0);
      const block = tokensCss.slice(start, tokensCss.indexOf("}", start));
      expect(block).toContain(`--ink: ${hud.ink};`);
      expect(block).toContain(`--ink-dim: ${hud.ink_dim};`);
      expect(block).toContain(`--hairline: ${hud.hairline};`);
      expect(block).toContain(`--accent: ${hud.accent};`);
      expect(block).toContain(`--danger: ${hud.danger};`);
      // Panel/cell carry hud.rs alphas 232/235 -> 0.91/0.92 (2dp).
      const [pr = 0, pg = 0, pb = 0] = [1, 3, 5].map((at) => parseInt(bgPanel.slice(at, at + 2), 16));
      expect(block).toContain(`--panel: rgb(${pr} ${pg} ${pb} / 0.91);`);
      const [cr = 0, cg = 0, cb = 0] = [1, 3, 5].map((at) => parseInt(bgCell.slice(at, at + 2), 16));
      expect(block).toContain(`--cell: rgb(${cr} ${cg} ${cb} / 0.92);`);
      expect(block).toContain("color-scheme: dark;");

      // Deck swatch shows the shipped accent.
      expect(componentsCss).toContain(
        `.theme-deck button[data-theme-pick="${id}"] .swatch { background: ${hud.accent}; }`,
      );
    },
  );
});

describe("theme system", () => {
  it("dawn is the default: light scheme on :root, no data-theme required", () => {
    const root = tokensCss.slice(tokensCss.indexOf(":root {"), tokensCss.indexOf("[data-theme="));
    expect(root).toContain("color-scheme: light;");
    const first = THEMES[0];
    if (!first) throw new Error("THEMES is empty");
    expect(first.id).toBe("dawn");
    expect(first.inGame).toBe(false);
    expect(THEMES).toHaveLength(5);
  });

  it("storedTheme accepts only known ids and falls back to dawn", () => {
    expect(storedTheme({ getItem: () => "phosphor" })).toBe("phosphor");
    expect(storedTheme({ getItem: () => "garbage" })).toBe("dawn");
    expect(storedTheme({ getItem: () => null })).toBe("dawn");
    expect(THEME_STORAGE_KEY).toBe("successor-theme");
  });

  it.each([...ROUTE_FILES])("%s mounts the deck and a scripted theme-color meta", (route) => {
    const html = readPage(route);
    expect(html).toContain("data-theme-deck");
    expect(html).toContain('content="dark light"');
    const plain = [...html.matchAll(/<meta name="theme-color"(?![^>]*media)/g)];
    expect(plain, "exactly one non-media theme-color meta").toHaveLength(1);
  });

  it("prefers-reduced-motion kill switch still exists", () => {
    expect(baseCss).toContain("@media (prefers-reduced-motion: reduce)");
  });

  it("every theme keeps readable ink (WCAG AA on its own cell)", () => {
    const luminance = (hex: string): number => {
      const channel = (value: number): number => {
        const c = value / 255;
        return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      };
      const [r = 0, g = 0, b = 0] = [1, 3, 5].map((at) => channel(parseInt(hex.slice(at, at + 2), 16)));
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    for (const id of GAME_THEME_IDS) {
      const parity = GAME_PARITY[id];
      const contrast =
        (Math.max(luminance(parity.ink), luminance(parity.bgCell)) + 0.05) /
        (Math.min(luminance(parity.ink), luminance(parity.bgCell)) + 0.05);
      expect(contrast, `${id} ink on cell`).toBeGreaterThanOrEqual(4.5);
    }
  });
});
