// One consumer of the public build manifest hydrates every download
// surface on the site: the home page's compact list and the download
// page's full list both render availability from /downloads/manifest.json.
// Supported target labels are site UI; only a valid manifest build can
// turn one into a download link.
import type { DownloadBuild } from "../api/types";

export const SHA256_PATTERN = /^[0-9a-f]{64}$/i;
export const MANIFEST_URL = "/downloads/manifest.json";

export interface PlannedTarget {
  targetId: string;
  client: string;
  platform: string;
}

export const SUPPORTED_TARGETS: readonly PlannedTarget[] = [
  { targetId: "3d-linux-x64", client: "3D client", platform: "Linux x86-64" },
  {
    targetId: "3d-macos-arm64",
    client: "3D client",
    platform: "macOS, Apple silicon",
  },
  { targetId: "tui-linux-x64", client: "Terminal client", platform: "Linux x86-64" },
  {
    targetId: "tui-macos-arm64",
    client: "Terminal client",
    platform: "macOS, Apple silicon",
  },
];

export interface ParsedManifest {
  targets: PlannedTarget[];
  builds: Map<string, DownloadBuild>;
}

export function isPublishableBuild(value: unknown): value is DownloadBuild {
  if (typeof value !== "object" || value === null) return false;
  const build = value as Record<string, unknown>;
  return (
    typeof build.targetId === "string" &&
    build.targetId.length > 0 &&
    typeof build.version === "string" &&
    build.version.length > 0 &&
    typeof build.publishedAt === "string" &&
    build.publishedAt.length > 0 &&
    typeof build.sizeBytes === "number" &&
    Number.isFinite(build.sizeBytes) &&
    build.sizeBytes > 0 &&
    typeof build.sha256 === "string" &&
    SHA256_PATTERN.test(build.sha256) &&
    typeof build.url === "string" &&
    (build.url.startsWith("/") || build.url.startsWith("https://"))
  );
}


export function formatSize(bytes: number): string {
  const mb = bytes / 1_000_000;
  return mb >= 100 ? `${Math.round(mb)} MB` : `${mb.toFixed(1)} MB`;
}

/** Reads the durable release ledger defensively; malformed builds stay unavailable. */
export function parseManifest(value: unknown): ParsedManifest | null {
  if (typeof value !== "object" || value === null) return null;
  const raw = value as Record<string, unknown>;
  if (!Array.isArray(raw.builds)) return null;
  const supportedIds = new Set(SUPPORTED_TARGETS.map((target) => target.targetId));
  const builds = new Map<string, DownloadBuild>();
  for (const candidate of raw.builds) {
    if (isPublishableBuild(candidate) && supportedIds.has(candidate.targetId)) {
      builds.set(candidate.targetId, candidate);
    }
  }
  return { targets: [...SUPPORTED_TARGETS], builds };
}

function renderUnreachable(container: HTMLElement): void {
  const doc = container.ownerDocument;
  const note = doc.createElement("p");
  note.className = "dl-error";
  note.textContent =
    "Could not read the build list right now. The browser client still works — try again in a little while.";
  container.replaceChildren(note);
}

function renderAvailable(
  li: HTMLLIElement,
  build: DownloadBuild,
  variant: string,
): void {
  const doc = li.ownerDocument;
  li.dataset.state = "available";
  const get = doc.createElement("div");
  get.className = "dl-get";
  const link = doc.createElement("a");
  link.className = "btn btn-secondary";
  link.href = build.url;
  link.textContent = `Download ${build.version}`;
  const meta = doc.createElement("span");
  meta.className = "dl-meta";
  meta.textContent = `${formatSize(build.sizeBytes)} · published ${build.publishedAt.slice(0, 10)}`;
  get.append(link, meta);
  li.append(get);
  if (variant !== "full") return;
  // Verification is for the careful, behind a disclosure, not a headline.
  const verify = doc.createElement("details");
  verify.className = "dl-verify";
  const summary = doc.createElement("summary");
  summary.textContent = "Check the file before you run it";
  const line = doc.createElement("p");
  line.append("Its SHA-256 should read ");
  const code = doc.createElement("code");
  code.className = "hash";
  code.textContent = build.sha256;
  line.append(code);
  const how = doc.createElement("p");
  how.textContent = "shasum -a 256 the-file on macOS, sha256sum the-file on Linux.";
  verify.append(summary, line, how);
  li.append(verify);
}

/**
 * Renders one download surface from the manifest. Returns how many rows
 * carry a real published build.
 */
export function renderDownloads(container: HTMLElement, manifest: unknown): number {
  const doc = container.ownerDocument;
  const variant = container.dataset.downloads === "full" ? "full" : "compact";
  const parsed = parseManifest(manifest);
  if (!parsed) {
    renderUnreachable(container);
    return 0;
  }
  const list = doc.createElement("ul");
  list.className = "dl-list";
  let published = 0;
  for (const target of parsed.targets) {
    const li = doc.createElement("li");
    li.className = "dl-row";
    li.dataset.target = target.targetId;
    const what = doc.createElement("div");
    what.className = "dl-what";
    const client = doc.createElement("span");
    client.className = "dl-client";
    client.textContent = target.client;
    const platform = doc.createElement("span");
    platform.className = "dl-plat";
    platform.textContent = target.platform;
    what.append(client, platform);
    li.append(what);
    const build = parsed.builds.get(target.targetId);
    if (build) {
      published += 1;
      renderAvailable(li, build, variant);
    } else {
      li.dataset.state = "unavailable";
      const soon = doc.createElement("span");
      soon.className = "dl-soon";
      soon.textContent = "Not ready yet.";
      li.append(soon);
    }
    list.append(li);
  }
  container.replaceChildren(list);
  return published;
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * Hydrates every `[data-downloads]` surface in the document from the
 * one public manifest. The static markup carries only a loading state;
 * this replaces it with available and unavailable rows, or with an
 * honest unreachable note when the manifest cannot be read.
 */
export async function initDownloads(
  doc: Document,
  fetcher: FetchLike = (url, init) => fetch(url, init),
): Promise<void> {
  const surfaces = [...doc.querySelectorAll<HTMLElement>("[data-downloads]")];
  if (surfaces.length === 0) return;
  let manifest: unknown = null;
  try {
    const res = await fetcher(MANIFEST_URL, { cache: "no-store" });
    if (res.ok) manifest = (await res.json()) as unknown;
  } catch {
    manifest = null;
  }
  for (const surface of surfaces) {
    if (manifest === null) renderUnreachable(surface);
    else renderDownloads(surface, manifest);
  }
}
