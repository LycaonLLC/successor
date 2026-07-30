export function isCreatorMode(params: URLSearchParams): boolean {
  return params.get("mode") === "creator";
}

export function usesTicketDirectEntry(params: URLSearchParams): boolean {
  // Standalone launches arrive through the validated in-memory handoff. URL
  // tickets are legacy-only and require an explicit legacy marker.
  if (typeof window !== "undefined" && window.__successorLaunchContext) return true;
  const legacyMode = params.get("legacy") === "1" || (typeof window !== "undefined" && window.__successorLaunch?.mode === "legacy");
  const rawTicket = legacyMode && params.has("ticket")
    ? params.get("ticket")
    : legacyMode && typeof window !== "undefined" ? window.__successorLaunch?.ticket : undefined;
  return Boolean(rawTicket?.normalize("NFKC").trim());
}
