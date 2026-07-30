import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { readPage, ROUTE_FILES, sitePath } from "./helpers";

interface MediaSlot {
  id: string;
  status: string;
  files?: string[];
  inline?: boolean;
  source: string;
  provenance: string;
}

const manifest = JSON.parse(readFileSync(sitePath("src/media/manifest.json"), "utf8")) as {
  slots: MediaSlot[];
};

const allHtml = ROUTE_FILES.map((route) => readPage(route)).join("\n");

describe("media manifest truth", () => {
  it("every available slot's optimized files exist in public/", () => {
    for (const slot of manifest.slots) {
      expect(slot.status, slot.id).toBe("available");
      expect(slot.source.length, slot.id).toBeGreaterThan(0);
      for (const file of slot.files ?? []) {
        expect(existsSync(sitePath(`public${file}`)), `${slot.id}: ${file}`).toBe(true);
      }
    }
  });

  it("every image the pages serve is declared in the manifest", () => {
    const declared = new Set(manifest.slots.flatMap((slot) => slot.files ?? []));
    const served = [...allHtml.matchAll(/"(\/(?:media|audio)\/[\w.-]+)"/g)].map((m) => m[1] ?? "");
    expect(served.length).toBeGreaterThan(0);
    for (const path of served) {
      expect(declared.has(path), `undeclared media: ${path}`).toBe(true);
    }
  });

  it("every visual slot in the manifest is placed in a page via data-slot", () => {
    for (const slot of manifest.slots) {
      if (slot.id === "audio-old-intro") continue; // audio mounts via the button, not a figure
      expect(allHtml, slot.id).toContain(`data-slot="${slot.id}"`);
    }
  });

  it("provenance ids live in the manifest, never in player-facing pages", () => {
    const raw = readFileSync(sitePath("src/media/manifest.json"), "utf8");
    expect(raw).toContain("8e1ed520");
    expect(raw).toContain("verify-full-1784899243000");
    for (const route of ROUTE_FILES) {
      const html = readPage(route);
      expect(html, route).not.toContain("8e1ed520");
      expect(html, route).not.toContain("1784899243000");
    }
  });
});
