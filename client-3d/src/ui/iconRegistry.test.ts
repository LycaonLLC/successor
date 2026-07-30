import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { craftSlotIconOrGenericSvg, craftSlotIconSvg } from "./iconRegistry";
import { UI_ICONS } from "./icons";

const authorityCraftingPath = fileURLToPath(new URL(
  "../../../crates/successor-sim/src/authority/crafting.rs",
  import.meta.url,
));

function authorityCraftSlotSymbols(): string[] {
  const source = readFileSync(authorityCraftingPath, "utf8");
  return [...new Set([...source.matchAll(/symbol:\s*"([^"]+)"/g)].map((match) => match[1]!))].sort();
}

describe("craft purpose icon registry", () => {
  it("covers every slot symbol emitted by the Rust crafting authority", () => {
    const symbols = authorityCraftSlotSymbols();
    expect(symbols.filter((symbol) => craftSlotIconSvg(symbol) === null)).toEqual([]);
    for (const symbol of symbols) {
      expect(craftSlotIconSvg(symbol), symbol).toContain('fill="currentColor"');
    }
  });

  it("keeps unknown future authority vocabulary on the caller fallback path", () => {
    expect(craftSlotIconSvg("future-unmapped-slot")).toBeNull();
  });

  it("fails closed to the generic stock vector — never a letter or raw token", () => {
    const generic = craftSlotIconOrGenericSvg("future-unmapped-slot");
    expect(generic).toContain("<svg");
    expect(generic).toContain('fill="currentColor"');
    expect(generic).not.toContain("future-unmapped-slot");
    // Mapped symbols keep their purpose silhouette.
    expect(craftSlotIconOrGenericSvg("casing")).toBe(craftSlotIconSvg("casing"));
  });
});

describe("bank / cloning window glyphs", () => {
  it("registers real inline vectors — no emoji or text-symbol placeholders", () => {
    for (const id of ["bank", "clone-facility"] as const) {
      const svg = UI_ICONS[id];
      expect(svg, id).toContain("<svg");
      expect(svg, id).toContain('stroke="currentColor"');
      // Stroke-path glyph vocabulary only: no raw text nodes inside the icon.
      expect(svg, id).not.toMatch(/<text[\s>]/);
    }
  });
});
