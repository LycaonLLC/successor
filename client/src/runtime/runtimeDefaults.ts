import runtimeDefaultsJson from "./runtimeDefaults.json";

export type RuntimeSocketKind = "game" | "chat";

export interface RuntimeDefaults {
  schema: "successor.runtime-defaults.v1";
  localClientUrl: string;
  localBackend: {
    host: string;
    port: number;
    gameWsPath: string;
    chatWsPath: string;
  };

  defaultSpawn: {
    spawnArea: string;
    spawnX: number;
    spawnY: number;
    facing: "front" | "right" | "back" | "left";
  };
}

export interface RuntimeLocationLike {
  protocol: string;
  hostname: string;
}

export interface BackendWsUrlOptions {
  kind: RuntimeSocketKind;
  searchParams?: URLSearchParams;
  location?: RuntimeLocationLike;
}

export interface RuntimeGameWsUrlOptions {
  gameWsUrl?: string;
  searchParams?: URLSearchParams;
  location?: RuntimeLocationLike;
}

export const runtimeDefaults = runtimeDefaultsJson as RuntimeDefaults;

export function defaultBackendWsUrl(options: BackendWsUrlOptions): string {
  const location = options.location ?? window.location;
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const host = runtimeBackendHost(location);
  const port = runtimeBackendPort(options.kind, options.searchParams);
  const path = options.kind === "game"
    ? runtimeDefaults.localBackend.gameWsPath
    : runtimeDefaults.localBackend.chatWsPath;
  return `${protocol}//${host}:${port}${path}`;
}

/**
 * Resolve the game socket URL used by both the authority client and hosted HTTP
 * calls. A launch-provided URL is authoritative; local launches use the
 * existing document/port defaults and query overrides.
 */
export function runtimeGameWsUrl(options: RuntimeGameWsUrlOptions = {}): string {
  if (options.gameWsUrl !== undefined) {
    const url = parseGameWsUrl(options.gameWsUrl);
    return url.toString();
  }
  return defaultBackendWsUrl({
    kind: "game",
    searchParams: options.searchParams,
    location: options.location,
  });
}

/**
 * Return the HTTP origin for game APIs. Hosted launches must use the same
 * origin as their trusted game socket (wss→https, ws→http), never the iframe's
 * document host or a ticket-derived URL.
 */
export function runtimeBackendHttpBase(options: RuntimeGameWsUrlOptions = {}): string {
  const url = parseGameWsUrl(runtimeGameWsUrl(options));
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  return url.origin;
}

export function runtimeBackendHost(location: RuntimeLocationLike): string {
  if (location.protocol === "http:" || location.protocol === "https:") {
    return location.hostname || runtimeDefaults.localBackend.host;
  }
  return runtimeDefaults.localBackend.host;
}

export function runtimeBackendPort(kind: RuntimeSocketKind, searchParams = new URLSearchParams()): number {
  const specific = kind === "game" ? searchParams.get("gamePort") : searchParams.get("chatPort");
  const shared = searchParams.get("backendPort");
  const proofShared = kind === "chat" ? searchParams.get("gamePort") : null;
  return normalizePort(specific ?? shared ?? proofShared, runtimeDefaults.localBackend.port);
}

export function applyGameSpawnParams(url: URL, sourceParams = new URLSearchParams(), useDefaults: boolean): void {
  const defaults = runtimeDefaults.defaultSpawn;
  const spawnArea = sourceParams.get("spawnArea") ?? (useDefaults ? defaults.spawnArea : null);
  const spawnX = sourceParams.get("spawnX") ?? (useDefaults ? String(defaults.spawnX) : null);
  const spawnY = sourceParams.get("spawnY") ?? (useDefaults ? String(defaults.spawnY) : null);
  const facing = sourceParams.get("facing") ?? (useDefaults ? defaults.facing : null);
  if (spawnArea) url.searchParams.set("spawnArea", spawnArea);
  if (spawnX) url.searchParams.set("spawnX", spawnX);
  if (spawnY) url.searchParams.set("spawnY", spawnY);
  if (facing) url.searchParams.set("facing", facing);
}

function parseGameWsUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Invalid Successor game websocket URL");
  }
  if (url.protocol !== "ws:" && url.protocol !== "wss:" || !url.hostname) {
    throw new Error("Successor game websocket URL must use ws: or wss:");
  }
  return url;
}

function normalizePort(value: string | null, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65_535 ? parsed : fallback;
}
