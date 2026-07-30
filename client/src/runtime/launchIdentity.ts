import type { EphemeralLaunchCapabilities } from "./launchContext";

/** Legacy launch shape. It is accepted only with mode: "legacy". */
export interface SuccessorLaunchContext {
  mode: "legacy";
  ticket?: string;
  player?: {
    id?: string;
    displayName?: string;
    zoneId?: string;
    partyId?: string;
    guildId?: string;
    guildTag?: string;
  };
  runtime?: {
    chatWsUrl?: string;
    gameWsUrl?: string;
  };
}

export interface LaunchIdentity {
  ownerRef: string;
  ownerDisplayName: string;
  playerId: string;
  displayName: string;
  characterId?: string;
  characterName?: string;
  selectedVariantId?: string;
  selectedAppearanceRecipe?: unknown;
  zoneId: string;
  partyId: string;
  guildId: string;
  guildTag: string | null;
  /** Legacy single capability. Never populated by standalone launches. */
  ticket?: string;
  gameTicket?: string;
  chatTicket?: string;
  chatWsUrl?: string;
  gameWsUrl?: string;
  clientReleaseId?: string;
  serverReleaseId?: string;
  standalone?: boolean;
}

interface SelectedCharacterLaunchState {
  id?: string;
  name?: string;
  variantId?: string;
  recipe?: unknown;
  staticVariant?: boolean;
}

declare global {
  interface Window {
    __successorLaunch?: SuccessorLaunchContext;
    __successorLaunchContext?: EphemeralLaunchCapabilities;
  }
}

export function getLaunchIdentity(): LaunchIdentity {
  const params = new URLSearchParams(window.location.search);
  const launch = window.__successorLaunch;
  const standalone = window.__successorLaunchContext;
  const selectedCharacter = (window as Window & {
    __successorSelectedCharacter?: SelectedCharacterLaunchState;
  }).__successorSelectedCharacter;
  const rawOwnerRef = params.get("player") ?? launch?.player?.id;
  const ownerRef = normalizeOwnerRef(rawOwnerRef);
  const ownerActorId = normalizeOptionalId(rawOwnerRef) ?? "observer";
  const ownerDisplayName = normalizeDisplayName(params.get("name") ?? launch?.player?.displayName ?? "Field Observer");
  const characterId = normalizeOptionalId(standalone?.characterId)
    ?? normalizeOptionalId(selectedCharacter?.id)
    ?? normalizeOptionalId(params.get("characterId"));
  const characterName = selectedCharacter?.name ? normalizeDisplayName(selectedCharacter.name) : undefined;
  return {
    ownerRef,
    ownerDisplayName,
    playerId: characterId ?? ownerActorId,
    displayName: characterName ?? ownerDisplayName,
    characterId,
    characterName,
    selectedVariantId: selectedCharacter?.variantId,
    selectedAppearanceRecipe: selectedCharacter?.staticVariant ? undefined : selectedCharacter?.recipe,
    zoneId: normalizeFallback(params.get("zone") ?? launch?.player?.zoneId, "open-desert"),
    partyId: normalizeFallback(params.get("party") ?? launch?.player?.partyId, ""),
    guildId: normalizeFallback(params.get("guild") ?? launch?.player?.guildId, ""),
    guildTag: normalizeGuildTag(params.get("guildTag") ?? launch?.player?.guildTag ?? params.get("guild") ?? launch?.player?.guildId),
    ticket: standalone ? undefined : (params.get("ticket") ?? (launch?.mode === "legacy" ? launch.ticket : undefined)),
    gameTicket: standalone?.gameTicket,
    chatTicket: standalone?.chatTicket,
    chatWsUrl: standalone?.chatEndpoint ?? params.get("chatWs") ?? launch?.runtime?.chatWsUrl,
    gameWsUrl: standalone?.gameEndpoint ?? launch?.runtime?.gameWsUrl,
    clientReleaseId: standalone?.clientReleaseId,
    serverReleaseId: standalone?.serverReleaseId,
    standalone: standalone !== undefined,
  };
}

export function discardLaunchCapabilities(): void {
  window.__successorLaunchContext?.discard();
  window.__successorLaunchContext = undefined;
}

function normalizeDisplayName(value: string): string {
  return value
    .normalize("NFKC")
    .trim()
    .replace(/\s+/gu, " ")
    .slice(0, 32) || "Field Observer";
}

function normalizeFallback(value: string | null | undefined, fallback: string): string {
  return value?.normalize("NFKC").trim().slice(0, 64) || fallback;
}

function normalizeGuildTag(value: string | null | undefined): string | null {
  const tag = value
    ?.normalize("NFKC")
    .trim()
    .replace(/[<>]/gu, "")
    .replace(/\s+/gu, "")
    .slice(0, 16);
  return tag || null;
}

function normalizeOwnerRef(value: string | null | undefined): string {
  const normalized = value?.normalize("NFKC").trim();
  return normalized && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u.test(normalized)
    ? normalized
    : "observer";
}

function normalizeOptionalId(value: string | null | undefined): string | undefined {
  const normalized = value
    ?.normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 64);
  return normalized || undefined;
}
