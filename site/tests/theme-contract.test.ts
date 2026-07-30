import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readPage, ROUTE_FILES, sitePath } from "./helpers";

const EXPECTED_TOKENS = [
  "--frame",
  "--frame-2",
  "--frame-3",
  "--seam",
  "--chalk",
  "--dust",
  "--primary",
  "--primary-ink",
  "--primary-hover",
  "--primary-press",
  "--link",
  "--link-hover",
  "--link-decoration",
  "--focus",
  "--selection-bg",
  "--selection-ink",
  "--active-border",
  "--control-active",
  "--edge-glow",
  "--danger",
  "--ok",
] as const;

const REMOVED_TOKENS = [
  "--uv",
  "--uv-ink",
  "--uv-dim",
  "--uv-glow",
  "--signal",
  "--signal-hover",
  "--signal-press",
  "--oxide",
  "--oxide-ink",
  "--hud",
] as const;

function walkDir(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = join(dir, entry.name);
    return entry.isDirectory() ? walkDir(fullPath) : [fullPath];
  });
}

describe("monochrome theme contract", () => {
  it("tokens.css has dark default and @media (prefers-color-scheme: light)", () => {
    const tokensCss = readFileSync(sitePath("src/styles/tokens.css"), "utf8");
    expect(tokensCss).toContain(":root {");
    expect(tokensCss).toContain("@media (prefers-color-scheme: light) {");
    const rootIndex = tokensCss.indexOf(":root {");
    const mediaIndex = tokensCss.indexOf("@media (prefers-color-scheme: light)");
    expect(rootIndex).toBeGreaterThan(-1);
    expect(mediaIndex).toBeGreaterThan(rootIndex);
  });

  it.each([...ROUTE_FILES])("%s advertises dark light and both media-qualified theme colors", (route) => {
    const html = readPage(route);
    expect(html).toContain('<meta name="color-scheme" content="dark light" />');
    expect(html).toContain('<meta name="theme-color" content="#0B0B0B" media="(prefers-color-scheme: dark)" />');
    expect(html).toContain('<meta name="theme-color" content="#F8F8F8" media="(prefers-color-scheme: light)" />');
  });

  it("no CSS or SVG source contains UV/ultraviolet/purple/cyan/amber brand markers or #7B5CFF", () => {
    const forbidden = [/uv/i, /ultraviolet/i, /purple/i, /cyan/i, /amber/i, /#7b5cff/i];

    const cssFiles = walkDir(sitePath("src/styles")).filter((f) => f.endsWith(".css"));
    const svgFiles = [
      ...walkDir(sitePath("public")).filter((f) => f.endsWith(".svg")),
      ...walkDir(sitePath("src")).filter((f) => f.endsWith(".svg")),
    ];

    for (const file of [...cssFiles, ...svgFiles]) {
      const content = readFileSync(file, "utf8");
      for (const pattern of forbidden) {
        expect(content, `${file} matches forbidden pattern ${pattern}`).not.toMatch(pattern);
      }
    }
  });

  it("all hex fills in brand and favicon SVGs are grayscale", () => {
    const brandAndFavSvgs = [
      ...walkDir(sitePath("public/brand")).filter((f) => f.endsWith(".svg")),
      sitePath("public/favicon.svg"),
    ];

    for (const svgPath of brandAndFavSvgs) {
      const content = readFileSync(svgPath, "utf8");
      const hexMatches = content.match(/#[0-9a-fA-F]{3,8}\b/g) || [];
      for (const hex of hexMatches) {
        let r = 0, g = 0, b = 0;
        if (hex.length === 4) {
          const rChar = hex[1]!;
          const gChar = hex[2]!;
          const bChar = hex[3]!;
          r = parseInt(rChar + rChar, 16);
          g = parseInt(gChar + gChar, 16);
          b = parseInt(bChar + bChar, 16);
        } else if (hex.length === 7 || hex.length === 9) {
          r = parseInt(hex.slice(1, 3), 16);
          g = parseInt(hex.slice(3, 5), 16);
          b = parseInt(hex.slice(5, 7), 16);
        }
        expect(r, `${svgPath} hex ${hex} red component`).toBe(g);
        expect(g, `${svgPath} hex ${hex} green component`).toBe(b);
      }
    }
  });

  it("expected semantic theme tokens exist in tokens.css and removed tokens/comments are gone", () => {
    const tokensCss = readFileSync(sitePath("src/styles/tokens.css"), "utf8");
    for (const token of EXPECTED_TOKENS) {
      expect(tokensCss).toContain(`${token}:`);
    }
    for (const token of REMOVED_TOKENS) {
      expect(tokensCss).not.toContain(token);
    }
  });

  it("only --danger and --ok may have nonzero OKLCH chroma in tokens.css", () => {
    const tokensCss = readFileSync(sitePath("src/styles/tokens.css"), "utf8");
    const declRegex = /(--[a-z0-9-]+)\s*:\s*oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*[\d.]+)?\s*\)/gi;
    let match: RegExpExecArray | null;
    while ((match = declRegex.exec(tokensCss)) !== null) {
      const varName = match[1]!;
      const chromaStr = match[3]!;
      const chroma = parseFloat(chromaStr);
      if (varName === "--danger" || varName === "--ok") {
        expect(chroma, `${varName} expected non-zero chroma`).toBeGreaterThan(0);
      } else {
        expect(chroma, `${varName} must have zero chroma`).toBe(0);
      }
    }
  });

  it("no manual theme-toggle hook or switch is introduced across site routes and scripts", () => {
    const jsTsFiles = walkDir(sitePath("src")).filter((f) => f.endsWith(".ts") || f.endsWith(".js"));
    const htmlFiles = ROUTE_FILES.map((r) => sitePath(r));

    const togglePatterns = [/theme-toggle/i, /toggle-theme/i, /prefers-color-scheme\s*=/i, /localStorage.*theme/i];

    for (const file of [...htmlFiles, ...jsTsFiles]) {
      const content = readFileSync(file, "utf8");
      for (const pattern of togglePatterns) {
        expect(content, `${file} matches theme toggle pattern ${pattern}`).not.toMatch(pattern);
      }
    }
  });

  it("prefers-reduced-motion media query rule still exists", () => {
    const cssFiles = walkDir(sitePath("src/styles")).filter((f) => f.endsWith(".css"));
    let found = false;
    for (const file of cssFiles) {
      const content = readFileSync(file, "utf8");
      if (content.includes("prefers-reduced-motion")) {
        found = true;
        break;
      }
    }
    expect(found, "prefers-reduced-motion rule should exist in CSS").toBe(true);
  });
});
