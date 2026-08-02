// The immutable client runtime pointer. The site never guesses where the
// runtime lives: it reads /client/release.json (published by the promotion
// script), demands the exact versioned shape, and refuses anything else.
// No pointer, no iframe — pages show an honest unavailable state instead.

export const RUNTIME_POINTER_PATH = "/client/release.json";
export const RUNTIME_POINTER_SCHEMA = "successor.client-runtime-pointer.v1";

export interface RuntimePointer {
  readonly entry: URL;
  /** Compatibility URL string for existing stable pointer consumers. */
  readonly href: string;
  readonly clientReleaseId?: string;
  readonly serverReleaseId?: string;
  readonly channel?: "beta";
}

/**
 * Validates the published pointer document and resolves its entry URL.
 * Requirements, all hard:
 * - `schema` is exactly {@link RUNTIME_POINTER_SCHEMA}
 * - `entry` is a bounded string that parses as an http(s) URL
 * - the URL carries no embedded credentials
 * Returns the resolved entry URL, or null for anything malformed.
 */
export function parseRuntimePointer(value: unknown, baseURI: string): URL | null {
  return parseRuntimePointerDocument(value, baseURI)?.entry ?? null;
}

export function parseRuntimePointerDocument(value: unknown, baseURI: string): RuntimePointer | null {
  if (value === null || typeof value !== "object") return null;
  const doc = value as Record<string, unknown>;
  if (doc.schema !== RUNTIME_POINTER_SCHEMA) return null;
  const entry = doc.entry;
  if (typeof entry !== "string" || entry.length === 0 || entry.length > 2048) return null;
  let url: URL;
  try {
    url = new URL(entry, baseURI);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.username !== "" || url.password !== "") return null;
  const boundedRelease = (field: unknown): string | undefined =>
    typeof field === "string" && /^[A-Za-z0-9][A-Za-z0-9._@-]{0,127}$/u.test(field)
      ? field
      : undefined;
  if (doc.clientReleaseId !== undefined && boundedRelease(doc.clientReleaseId) === undefined) return null;
  if (doc.serverReleaseId !== undefined && boundedRelease(doc.serverReleaseId) === undefined) return null;
  if (doc.channel !== undefined && doc.channel !== "beta") return null;
  return {
    entry: url,
    href: url.href,
    clientReleaseId: boundedRelease(doc.clientReleaseId),
    serverReleaseId: boundedRelease(doc.serverReleaseId),
    channel: doc.channel === "beta" ? "beta" : undefined,
  };
}

/** Fetches and validates a runtime pointer. Network trouble reads as unavailable. */
export async function loadRuntimePointer(
  baseURI: string,
  path = RUNTIME_POINTER_PATH,
): Promise<RuntimePointer | null> {
  try {
    const res = await fetch(path, { cache: "no-store" });
    if (!res.ok) return null;
    return parseRuntimePointerDocument((await res.json()) as unknown, baseURI);
  } catch {
    return null;
  }
}
