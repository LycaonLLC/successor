export const STANDALONE_LAUNCH_SCHEMA = "successor.launch-context.v1" as const;
export const STANDALONE_LAUNCH_MESSAGE = "successor.launch.v1" as const;
export const STANDALONE_LAUNCH_MAX_AGE_MS = 45_000;
/** Bounded positive allowance for small host/server clock skew on the max-future check only. */
export const STANDALONE_LAUNCH_SERVER_CLOCK_SKEW_ALLOWANCE_MS = 5_000;

export interface StandaloneLaunchContextV1 {
  schema: typeof STANDALONE_LAUNCH_SCHEMA;
  gameTicket: string;
  chatTicket: string;
  endpoints: {
    game: string;
    chat: string;
  };
  release: {
    client: string;
    server: string;
    shard?: string;
  };
  characterId: string;
  expiresAt: number;
}

export interface StandaloneLaunchMessageV1 {
  type: typeof STANDALONE_LAUNCH_MESSAGE;
  launch: StandaloneLaunchContextV1;
}

export interface LaunchContextValidationOptions {
  now?: number;
  clientReleaseId?: string;
  serverReleaseId?: string;
  gameOrigin?: string;
  chatOrigin?: string;
}

/**
 * The returned object is intentionally mutable. Call discard() immediately
 * after the two socket connect attempts so ticket strings do not survive in
 * launch state or diagnostic objects.
 */
export interface EphemeralLaunchCapabilities {
  readonly schema: typeof STANDALONE_LAUNCH_SCHEMA;
  gameTicket: string | undefined;
  chatTicket: string | undefined;
  readonly gameEndpoint: string;
  readonly chatEndpoint: string;
  readonly clientReleaseId: string;
  readonly serverReleaseId: string;
  readonly shard: string | undefined;
  readonly characterId: string;
  readonly expiresAt: number;
  discard: () => void;
}

const consumedLaunches = new Set<string>();

export function validateStandaloneLaunchContext(
  value: unknown,
  options: LaunchContextValidationOptions = {},
): StandaloneLaunchContextV1 | null {
  if (!isPlainRecord(value) || !hasOnlyKeys(value, ["schema", "gameTicket", "chatTicket", "endpoints", "release", "characterId", "expiresAt"])) return null;
  if (value.schema !== STANDALONE_LAUNCH_SCHEMA) return null;
  if (!isNonEmptyToken(value.gameTicket) || !isNonEmptyToken(value.chatTicket)) return null;
  if (value.gameTicket === value.chatTicket) return null;
  if (!isPlainRecord(value.endpoints) || !hasOnlyKeys(value.endpoints, ["game", "chat"])) return null;
  const gameEndpoint = parseSocketEndpoint(value.endpoints.game, options.gameOrigin);
  const chatEndpoint = parseSocketEndpoint(value.endpoints.chat, options.chatOrigin);
  if (!gameEndpoint || !chatEndpoint) return null;
  if (!isPlainRecord(value.release) || !hasOnlyKeys(value.release, ["client", "server", "shard"])) return null;
  if (!isNonEmptyToken(value.release.client) || !isNonEmptyToken(value.release.server)) return null;
  const shard = value.release.shard === undefined
    ? undefined
    : isNonEmptyToken(value.release.shard)
      ? value.release.shard
      : null;
  if (shard === null) return null;
  if (options.clientReleaseId !== undefined && value.release.client !== options.clientReleaseId) return null;
  if (options.serverReleaseId !== undefined && value.release.server !== options.serverReleaseId) return null;
  if (!isNonEmptyToken(value.characterId) || value.characterId.length > 128) return null;
  const expiresAt = typeof value.expiresAt === "number" && Number.isSafeInteger(value.expiresAt)
    ? value.expiresAt
    : null;
  if (expiresAt === null) return null;
  const now = options.now ?? Date.now();
  if (expiresAt <= now || expiresAt - now > STANDALONE_LAUNCH_MAX_AGE_MS + STANDALONE_LAUNCH_SERVER_CLOCK_SKEW_ALLOWANCE_MS) return null;
  return {
    schema: STANDALONE_LAUNCH_SCHEMA,
    gameTicket: value.gameTicket,
    chatTicket: value.chatTicket,
    endpoints: { game: gameEndpoint, chat: chatEndpoint },
    release: {
      client: value.release.client,
      server: value.release.server,
      ...(shard === undefined ? {} : { shard }),
    },
    characterId: value.characterId,
    expiresAt,
  };
}

export function validateStandaloneLaunchMessage(
  value: unknown,
  options: LaunchContextValidationOptions = {},
): StandaloneLaunchMessageV1 | null {
  if (!isPlainRecord(value) || value.type !== STANDALONE_LAUNCH_MESSAGE) return null;
  const launch = validateStandaloneLaunchContext(value.launch, options);
  return launch ? { type: STANDALONE_LAUNCH_MESSAGE, launch } : null;
}

export function consumeStandaloneLaunchContext(
  value: unknown,
  options: LaunchContextValidationOptions = {},
): EphemeralLaunchCapabilities | null {
  const context = validateStandaloneLaunchContext(value, options);
  if (!context) return null;
  const fingerprint = launchFingerprint(context);
  if (consumedLaunches.has(fingerprint)) return null;
  consumedLaunches.add(fingerprint);
  let gameTicket: string | undefined = context.gameTicket;
  let chatTicket: string | undefined = context.chatTicket;
  let discarded = false;
  return {
    schema: context.schema,
    get gameTicket() { return gameTicket; },
    set gameTicket(value: string | undefined) { gameTicket = value; },
    get chatTicket() { return chatTicket; },
    set chatTicket(value: string | undefined) { chatTicket = value; },
    gameEndpoint: context.endpoints.game,
    chatEndpoint: context.endpoints.chat,
    clientReleaseId: context.release.client,
    serverReleaseId: context.release.server,
    shard: context.release.shard,
    characterId: context.characterId,
    expiresAt: context.expiresAt,
    discard: () => {
      if (discarded) return;
      discarded = true;
      gameTicket = undefined;
      chatTicket = undefined;
    },
  };
}

export function clearConsumedLaunchesForTests(): void {
  consumedLaunches.clear();
}

function parseSocketEndpoint(value: unknown, expectedOrigin?: string): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  let url: URL;
  try { url = new URL(value); } catch { return null; }
  if (url.protocol !== "ws:" && url.protocol !== "wss:") return null;
  if (!url.hostname || url.username || url.password || url.search || url.hash) return null;
  if (expectedOrigin !== undefined && url.origin !== expectedOrigin) return null;
  return url.toString();
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function isNonEmptyToken(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value === value.trim() && value.length <= 4096;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function launchFingerprint(context: StandaloneLaunchContextV1): string {
  return hash(`${context.gameTicket}\u0000${context.chatTicket}\u0000${context.characterId}\u0000${context.expiresAt}`);
}

function hash(value: string): string {
  let hashValue = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hashValue ^= value.charCodeAt(index);
    hashValue = Math.imul(hashValue, 16777619);
  }
  return (hashValue >>> 0).toString(16);
}
