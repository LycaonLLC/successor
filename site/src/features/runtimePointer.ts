// The immutable client runtime pointer. The site never guesses where the
// runtime lives: it reads /client/release.json (published by the promotion
// script), demands the exact versioned shape, and refuses anything else.
// No pointer, no iframe — pages show an honest unavailable state instead.

export const RUNTIME_POINTER_PATH = "/client/release.json";
export const RUNTIME_POINTER_SCHEMA = "successor.client-runtime-pointer.v1";

/**
 * Validates the published pointer document and resolves its entry URL.
 * Requirements, all hard:
 * - `schema` is exactly {@link RUNTIME_POINTER_SCHEMA}
 * - `entry` is a bounded string that parses as an http(s) URL
 * - the URL carries no embedded credentials
 * Returns the resolved entry URL, or null for anything malformed.
 */
export function parseRuntimePointer(value: unknown, baseURI: string): URL | null {
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
  return url;
}

/** Fetches and validates the pointer. Network trouble reads as "no pointer". */
export async function loadRuntimePointer(baseURI: string): Promise<URL | null> {
  try {
    const res = await fetch(RUNTIME_POINTER_PATH, { cache: "no-store" });
    if (!res.ok) return null;
    return parseRuntimePointer((await res.json()) as unknown, baseURI);
  } catch {
    return null;
  }
}
