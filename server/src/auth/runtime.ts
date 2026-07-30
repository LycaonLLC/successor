import type { LaunchProvenance } from "../alpha/control-store.js";

export type TicketControlPlaneMode = "standalone" | "legacy";

export interface RuntimeAuthConfig {
  readonly mode: TicketControlPlaneMode;
  readonly shardId: string;
  readonly clientReleaseId: string;
  readonly serverReleaseId: string;
  readonly issuer: string;
  /** Exact HTTPS storefront origin required by standalone HTTP cookie/API admission. */
  readonly origin?: string;
  /** Exact HTTPS immutable client CDN origin allowed for hosted transports. */
  readonly clientOrigin?: string;
  readonly controlDbPath?: string;
  readonly claimSecret?: Uint8Array;
}

export interface LaunchSessionRevocationSink {
  register(provenance: LaunchProvenance, close: () => void): () => void;
}

/**
 * Small in-process index for bounded account/device revoke disconnects. HTTP
 * routes can call closeLaunch/closeAccount after revoking control state.
 */
export class LaunchSessionRegistry implements LaunchSessionRevocationSink {
  private readonly sessions = new Map<string, Set<{ provenance: LaunchProvenance; close: () => void }>>();

  register(provenance: LaunchProvenance, close: () => void): () => void {
    const entry = { provenance, close };
    const bucket = this.sessions.get(provenance.launchId) ?? new Set();
    bucket.add(entry);
    this.sessions.set(provenance.launchId, bucket);
    return () => {
      const current = this.sessions.get(provenance.launchId);
      if (!current) return;
      current.delete(entry);
      if (current.size === 0) this.sessions.delete(provenance.launchId);
    };
  }

  closeLaunch(launchId: string): number {
    const bucket = this.sessions.get(launchId);
    if (!bucket) return 0;
    let closed = 0;
    for (const entry of [...bucket]) {
      closed += 1;
      entry.close();
    }
    return closed;
  }

  closeAccount(accountId: string): number {
    let closed = 0;
    for (const bucket of this.sessions.values()) {
      for (const entry of [...bucket]) {
        if (entry.provenance.accountId !== accountId) continue;
        closed += 1;
        entry.close();
      }
    }
    return closed;
  }
}

function required(value: string | undefined, name: string): string {
  const normalized = value?.trim();
  if (!normalized) throw new Error(`${name} is required`);
  if (normalized.length > 256) throw new Error(`${name} is too long`);
  return normalized;
}

function parseSecret(raw: string): Uint8Array {
  const value = raw.trim();
  const bytes = /^[0-9a-f]+$/iu.test(value) && value.length % 2 === 0
    ? Buffer.from(value, "hex")
    : Buffer.from(value, "base64url");
  if (bytes.byteLength < 32) throw new Error("ALPHA_CONTROL_CLAIM_SECRET must contain at least 256 bits");
  return bytes;
}

function requiredStandaloneOrigin(raw: string | undefined, name: string): string {
  const value = required(raw, name);
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${name} must be an exact HTTPS origin`);
  }
  if (parsed.protocol !== "https:" || parsed.origin !== value || parsed.pathname !== "/" || parsed.search || parsed.hash || parsed.username || parsed.password) {
    throw new Error(`${name} must be an exact HTTPS origin`);
  }
  return value;
}

export function originMatches(requestOrigin: string | string[] | undefined, requiredOrigin: string | readonly string[] | undefined): boolean {
  if (!requiredOrigin) return true;
  if (Array.isArray(requestOrigin)) return false;
  const allowedOrigins = Array.isArray(requiredOrigin) ? requiredOrigin : [requiredOrigin];
  return typeof requestOrigin === "string" && allowedOrigins.includes(requestOrigin);
}

/** Origins emitted by native/local clients; browser origins must match the configured HTTPS list. */
export function trustedNativeOrigin(requestOrigin: string | string[] | undefined): boolean {
  if (requestOrigin === undefined) return true;
  if (Array.isArray(requestOrigin)) return false;
  if (requestOrigin === "successor://app") return true;
  let parsed: URL;
  try {
    parsed = new URL(requestOrigin);
  } catch {
    return false;
  }
  return (parsed.protocol === "http:" || parsed.protocol === "https:")
    && parsed.origin === requestOrigin
    && ["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname);
}

export function runtimeAuthConfigFromEnv(env: NodeJS.ProcessEnv = process.env): RuntimeAuthConfig {
  const rawMode = env.SUCCESSOR_CONTROL_PLANE_MODE?.trim().toLowerCase();
  if (rawMode && rawMode !== "standalone" && rawMode !== "legacy") {
    throw new Error("SUCCESSOR_CONTROL_PLANE_MODE must be standalone or legacy");
  }
  // Existing local/test harnesses remain on the old path until they opt into
  // standalone. Production must choose explicitly; no accidental ComPress use.
  const mode = (rawMode ?? (env.NODE_ENV === "production" ? "" : "legacy")) as TicketControlPlaneMode | "";
  if (!mode) throw new Error("SUCCESSOR_CONTROL_PLANE_MODE is required in production");
  const successorShardId = env.SUCCESSOR_SHARD_ID?.trim();
  const gameShardId = env.GAME_SHARD_ID?.trim();
  if (successorShardId && gameShardId && successorShardId !== gameShardId) throw new Error("SUCCESSOR_SHARD_ID conflicts with GAME_SHARD_ID");
  const shardId = required(successorShardId ?? gameShardId ?? "open-desert", "SUCCESSOR_SHARD_ID");
  const clientReleaseId = required(env.SUCCESSOR_CLIENT_RELEASE_ID ?? env.SUCCESSOR_RELEASE_ID ?? "dev", "SUCCESSOR_CLIENT_RELEASE_ID");
  const serverReleaseId = required(env.SUCCESSOR_SERVER_RELEASE_ID ?? env.SUCCESSOR_RELEASE_ID ?? "dev", "SUCCESSOR_SERVER_RELEASE_ID");
  const issuer = required(env.SUCCESSOR_LAUNCH_ISSUER ?? "successor-server", "SUCCESSOR_LAUNCH_ISSUER");
  if (mode === "legacy") return { mode, shardId, clientReleaseId, serverReleaseId, issuer };
  const controlDbPath = required(env.ALPHA_CONTROL_DB_PATH, "ALPHA_CONTROL_DB_PATH");
  const claimSecret = parseSecret(required(env.ALPHA_CONTROL_CLAIM_SECRET, "ALPHA_CONTROL_CLAIM_SECRET"));
  const origin = requiredStandaloneOrigin(env.SUCCESSOR_ALPHA_ORIGIN, "SUCCESSOR_ALPHA_ORIGIN");
  const clientOrigin = requiredStandaloneOrigin(env.SUCCESSOR_ALPHA_CLIENT_ORIGIN, "SUCCESSOR_ALPHA_CLIENT_ORIGIN");
  return { mode, shardId, clientReleaseId, serverReleaseId, issuer, origin, clientOrigin, controlDbPath, claimSecret };
}
