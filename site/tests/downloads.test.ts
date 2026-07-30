import { beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  formatSize,
  initDownloads,
  isPublishableBuild,
  parseManifest,
  renderDownloads,
} from "../src/features/downloads";
import { readPage, ROUTE_FILES, sitePath } from "./helpers";

const TARGETS = [
  { targetId: "3d-linux-x64", client: "3D client", platform: "Linux x86-64" },
  { targetId: "3d-macos-arm64", client: "3D client", platform: "macOS, Apple silicon" },
  { targetId: "tui-linux-x64", client: "Terminal client", platform: "Linux x86-64" },
  { targetId: "tui-macos-arm64", client: "Terminal client", platform: "macOS, Apple silicon" },
];

function makeBuild(targetId: string): Record<string, unknown> {
  return {
    targetId,
    client: "Installed 3D client",
    platform: "Linux x86-64",
    version: "0.9.1",
    publishedAt: "2026-08-01T00:00:00Z",
    sizeBytes: 123_500_000,
    sha256: "a".repeat(64),
    url: `/downloads/successor-${targetId}-0.9.1.tar.gz`,
  };
}

function mountSurface(variant: "full" | "compact"): HTMLElement {
  document.body.innerHTML = `<div data-downloads="${variant}"><p class="dl-loading">Checking the current builds…</p></div>`;
  const surface = document.querySelector<HTMLElement>("[data-downloads]");
  if (!surface) throw new Error("no surface");
  return surface;
}

describe("download surfaces", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("no public page hardcodes an unpublished download state", () => {
    for (const route of ROUTE_FILES) {
      expect(readPage(route), route).not.toMatch(/not published yet/i);
    }
  });

  it("every download surface is manifest-driven with a loading state", () => {
    for (const route of ["download/index.html"]) {
      const html = readPage(route);
      expect(html, route).toContain("data-downloads");
      expect(html, route).toContain("dl-loading");
      expect(html, route).not.toMatch(/builds are available/i);
      // No pre-rendered download links can exist before the manifest speaks.
      expect(html, route).not.toMatch(/href="[^"]*\.(tar|zip|dmg|AppImage|deb)/);
    }
  });

  it("published builds render as available rows with real links", () => {
    const surface = mountSurface("full");
    const applied = renderDownloads(surface, { builds: TARGETS.map((t) => makeBuild(t.targetId)) });
    expect(applied).toBe(4);
    const rows = surface.querySelectorAll('li[data-state="available"]');
    expect(rows).toHaveLength(4);
    const link = surface.querySelector<HTMLAnchorElement>('li[data-target="3d-macos-arm64"] a');
    expect(link?.getAttribute("href")).toBe("/downloads/successor-3d-macos-arm64-0.9.1.tar.gz");
    expect(link?.textContent).toBe("Download 0.9.1");
    expect(surface.textContent).toContain("124 MB");
    expect(surface.textContent).toContain("published 2026-08-01");
    expect(surface.textContent).not.toMatch(/not ready yet/i);
    // The loading state is gone once rows render.
    expect(surface.querySelector(".dl-loading")).toBeNull();
  });

  it("renders the deployed release-ledger schema without development target metadata", () => {
    const surface = mountSurface("full");
    const applied = renderDownloads(surface, {
      schema: "successor.downloads.v1",
      releaseId: "successor-alpha",
      builds: [
        makeBuild("3d-linux-x64"),
        makeBuild("3d-macos-arm64"),
        makeBuild("tui-linux-x64"),
        makeBuild("tui-macos-arm64"),
        makeBuild("unsupported-target"),
      ],
    });
    expect(applied).toBe(4);
    expect(surface.querySelectorAll('li[data-state="available"]')).toHaveLength(4);
    expect(surface.querySelector('[data-target="unsupported-target"]')).toBeNull();
  });

  it("keeps checksums behind a disclosure instead of leading with them", () => {
    const surface = mountSurface("full");
    renderDownloads(surface, { builds: [makeBuild("3d-linux-x64")] });
    const row = surface.querySelector('li[data-target="3d-linux-x64"]');
    const verify = row?.querySelector("details.dl-verify");
    expect(verify).not.toBeNull();
    expect(verify?.hasAttribute("open")).toBe(false);
    expect(verify?.querySelector("code.hash")?.textContent).toBe("a".repeat(64));
    // The hash lives only inside the disclosure, never in the row's lede.
    const lede = row?.querySelector(".dl-get");
    expect(lede?.textContent).not.toContain("a".repeat(64));
  });

  it("compact surfaces skip the verification disclosure", () => {
    const surface = mountSurface("compact");
    renderDownloads(surface, { builds: [makeBuild("3d-linux-x64")] });
    expect(surface.querySelector("details.dl-verify")).toBeNull();
    expect(surface.querySelector('li[data-state="available"] a')).not.toBeNull();
  });

  it("a manifest without builds renders honest unavailable rows and no links", () => {
    const surface = mountSurface("full");
    const applied = renderDownloads(surface, { builds: [] });
    expect(applied).toBe(0);
    expect(surface.querySelectorAll('li[data-state="unavailable"]')).toHaveLength(4);
    expect(surface.querySelector("a")).toBeNull();
    expect(surface.textContent).toContain("Not ready yet.");
  });

  it("refuses builds the manifest cannot vouch for", () => {
    const missingHash = { ...makeBuild("3d-linux-x64"), sha256: "not-a-hash" };
    const missingUrl = { ...makeBuild("3d-linux-x64"), url: "ftp://nope" };
    const missingSize = { ...makeBuild("3d-linux-x64"), sizeBytes: 0 };
    expect(isPublishableBuild(missingHash)).toBe(false);
    expect(isPublishableBuild(missingUrl)).toBe(false);
    expect(isPublishableBuild(missingSize)).toBe(false);
    const surface = mountSurface("full");
    const applied = renderDownloads(surface, { builds: [missingHash, missingUrl, missingSize] });
    expect(applied).toBe(0);
    expect(surface.querySelector("a")).toBeNull();
    expect(surface.querySelectorAll('li[data-state="unavailable"]')).toHaveLength(4);
  });

  it("an unreachable manifest becomes an honest error state on every surface", async () => {
    document.body.innerHTML =
      '<div data-downloads="compact"><p class="dl-loading">Checking…</p></div>' +
      '<div data-downloads="full"><p class="dl-loading">Checking…</p></div>';
    await initDownloads(document, () => Promise.reject(new Error("offline")));
    const errors = document.querySelectorAll(".dl-error");
    expect(errors).toHaveLength(2);
    expect(document.querySelector("a")).toBeNull();
    expect(document.querySelector(".dl-loading")).toBeNull();
  });

  it("hydrates every surface in one pass from one fetched manifest", async () => {
    document.body.innerHTML =
      '<div data-downloads="compact"><p class="dl-loading">Checking…</p></div>' +
      '<div data-downloads="full"><p class="dl-loading">Checking…</p></div>';
    const manifest = { builds: [makeBuild("tui-linux-x64")] };
    let calls = 0;
    await initDownloads(document, () => {
      calls += 1;
      return Promise.resolve(new Response(JSON.stringify(manifest), { status: 200 }));
    });
    expect(calls).toBe(1);
    expect(document.querySelectorAll('li[data-state="available"]')).toHaveLength(2);
    expect(document.querySelectorAll('li[data-state="unavailable"]')).toHaveLength(6);
  });

  it("formats sizes for humans", () => {
    expect(formatSize(123_500_000)).toBe("124 MB");
    expect(formatSize(52_400_000)).toBe("52.4 MB");
  });

  it("the shipped manifest matches the live four-target release ledger", () => {
    const manifest = JSON.parse(
      readFileSync(sitePath("public/downloads/manifest.json"), "utf8"),
    ) as {
      schema: string;
      releaseId: string;
      version: string;
      builds: Array<Record<string, unknown>>;
    };
    expect(manifest.schema).toBe("successor.downloads.v1");
    expect(manifest.releaseId).toBe("successor-alpha@cdab7dccacc1d75c");
    expect(manifest.version).toBe("0.0.4");
    expect(manifest.builds).toHaveLength(4);
    expect(manifest.builds.every(isPublishableBuild)).toBe(true);
    expect(manifest.builds.map((build) => build.targetId).sort()).toEqual([
      "3d-linux-x64",
      "3d-macos-arm64",
      "tui-linux-x64",
      "tui-macos-arm64",
    ]);
    const parsed = parseManifest(manifest);
    expect(parsed?.builds.size).toBe(4);
    expect(parsed?.targets.map((target) => target.targetId).sort()).toEqual([
      "3d-linux-x64",
      "3d-macos-arm64",
      "tui-linux-x64",
      "tui-macos-arm64",
    ]);
  });
});
