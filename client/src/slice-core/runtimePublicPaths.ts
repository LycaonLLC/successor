const defaultSlicePath = "/successor-slice/open-desert-slice.json";
const defaultMapBundlePath = "/successor-slice/open-desert-map-bundle.json";

/**
 * Resolve a public runtime path against the directory containing the current
 * document. Immutable browser releases are served below `/releases/<id>/`,
 * while headless hosts have no document and must keep root public paths.
 *
 * `null` means the caller supplied a protocol, protocol-relative URL, or a
 * traversal path that would escape the immutable release directory. Internal
 * `..` segments from an asset manifest are normalized when they stay inside
 * that directory.
 */
export function resolveRuntimePublicPath(path: string, documentBaseHref?: string): string | null {
  if (!safePublicPath(path)) return null;
  if (!path.startsWith("/")) return path;

  const baseHref = documentBaseHref
    ?? (typeof document === "undefined" ? null : document.baseURI);
  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(path);
  } catch {
    return null;
  }
  const hasTraversal = decodedPath.includes("..");
  if (!baseHref) return hasTraversal ? null : path;

  let base: URL;
  try {
    base = new URL(baseHref);
  } catch {
    return path;
  }
  let directory = base.pathname;
  if (!directory.endsWith("/")) {
    directory = directory.slice(0, directory.lastIndexOf("/") + 1);
  }
  if (!directory.endsWith("/")) directory += "/";

  if (!hasTraversal && (path === directory.slice(0, -1) || path.startsWith(directory))) return path;

  if (hasTraversal && !decodedPath.startsWith(directory)) return null;
  const resolutionBase = decodedPath.startsWith(directory) ? `${base.origin}/` : `${base.origin}${directory}`;
  const normalized = new URL(decodedPath.slice(1), new URL(resolutionBase));
  if (hasTraversal && !normalized.pathname.startsWith(directory)) return null;
  return `${normalized.pathname}${normalized.search}${normalized.hash}`;
}

/** Resolve a known-good public path, failing closed for manifest data. */
export function requireRuntimePublicPath(path: string, documentBaseHref?: string): string {
  const resolved = resolveRuntimePublicPath(path, documentBaseHref);
  if (!resolved) throw new Error(`unsafe runtime public path: ${path}`);
  return resolved;
}

export const slicePath = runtimePublicAssetPath("slicePath", defaultSlicePath);
export const mapBundlePath = runtimePublicAssetPath("mapBundlePath", defaultMapBundlePath);
export function runtimePublicAssetPath(
  queryParam: string,
  fallback: string,
  search = typeof window === "undefined" ? "" : window.location.search,
): string {
  const candidate = new URLSearchParams(search).get(queryParam);
  if (!candidate) return requireRuntimePublicPath(fallback);
  if (safeRuntimePublicAssetPath(candidate)) return requireRuntimePublicPath(candidate);
  console.warn(`Ignoring unsafe Successor runtime asset path override for ${queryParam}: ${candidate}`);
  return requireRuntimePublicPath(fallback);
}

function safePublicPath(value: string): boolean {
  if (value.startsWith("//") || /^[a-z][a-z0-9+.-]*:/iu.test(value)) return false;
  try {
    decodeURIComponent(value);
    return true;
  } catch {
    return false;
  }
}

function safeRuntimePublicAssetPath(value: string): boolean {
  return value.startsWith("/successor-slice/")
    && safePublicPath(value)
    && !value.includes("..");
}
