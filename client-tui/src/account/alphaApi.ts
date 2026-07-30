/**
 * Same-origin alpha API client — the four calls a signed-in terminal needs.
 *
 * Everything rides in headers and JSON bodies. No capability, code, or
 * credential ever touches a URL, argv, the environment, or a log line.
 * HTTPS is required except for loopback (local fake-API testing).
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";


export const DEVICE_CLIENT_ID = "successor-tui";
export const DEVICE_SCOPES = ["character:list", "play-ticket"] as const;
/** Poll floor — never poll faster than this, whatever the server says. */
export const MIN_POLL_INTERVAL_MS = 5_000;

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{20,128}$/u;
const REQUEST_TIMEOUT_MS = 15_000;

export type AlphaApiErrorCode =
  | "API_URL_INVALID"
  | "API_UNREACHABLE"
  | "API_RESPONSE_INVALID"
  | "AUTH_REJECTED"
  | "DEVICE_NOT_FOUND"
  | "DEVICE_STATE"
  | "LEGAL_REQUIRED"
  | "RELEASE_NOT_ALLOWED"
  | "CHARACTER_NOT_FOUND"
  | "API_ERROR";

export class AlphaApiError extends Error {
  readonly code: AlphaApiErrorCode;
  readonly status?: number;
  constructor(code: AlphaApiErrorCode, message: string, status?: number) {
    super(message);
    this.name = "AlphaApiError";
    this.code = code;
    this.status = status;
  }
}

export interface DeviceStart {
  readonly deviceCode: string;
  readonly userCode: string;
  readonly expiresAt: number;
  readonly pollIntervalMs: number;
}

export type DevicePollStatus = "pending" | "approved" | "denied" | "exchanged" | "revoked" | "expired" | "slow_down";

export interface DevicePoll {
  readonly status: DevicePollStatus;
  readonly retryAfterMs?: number;
  readonly credential?: string;
  readonly scopes?: readonly string[];
}

export interface OwnedCharacter {
  readonly id: string;
  readonly name: string;
  readonly initialProfessionId: string;
  readonly worldEntryClaimed: boolean;
}

export interface LaunchEnvelope {
  readonly gameTicket: string;
  readonly chatTicket: string;
  readonly characterId: string;
  readonly expiresAt: number;
  readonly endpoints: { readonly game: string; readonly chat: string };
  readonly release: { readonly client: string; readonly server: string; readonly shard: string };
}

export interface AlphaApi {
  readonly apiUrl: string;
  /** Human approval page for the device flow — clean URL, no code embedded. */
  readonly connectUrl: string;
  deviceStart(releaseId: string): Promise<DeviceStart>;
  devicePoll(deviceCode: string): Promise<DevicePoll>;
  /** Revokes the credential itself. Resolves even when the server predates the route. */
  deviceLogout(credential: string): Promise<"revoked" | "unsupported">;
  listCharacters(credential: string): Promise<OwnedCharacter[]>;
  playTicket(credential: string, characterId: string): Promise<LaunchEnvelope>;
}

/** HTTPS everywhere; plain http only for loopback fakes. Path prefixes are kept. */
export function normalizeApiUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new AlphaApiError("API_URL_INVALID", `${raw} is not a URL.`);
  }
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "::1" || url.hostname === "[::1]" || url.hostname === "localhost";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new AlphaApiError("API_URL_INVALID", `${raw} — the account service must be https (plain http is allowed only for 127.0.0.1).`);
  }
  if (url.search || url.hash || url.username || url.password) {
    throw new AlphaApiError("API_URL_INVALID", `${raw} — the account service URL takes no query, fragment, or userinfo.`);
  }
  return `${url.origin}${url.pathname.replace(/\/+$/u, "")}`;
}

interface JsonResponse {
  readonly status: number;
  readonly body: Record<string, unknown> | null;
  readonly retryAfterMs?: number;
}

export function createAlphaApi(rawApiUrl: string, fetchImpl: typeof fetch = fetch): AlphaApi {
  const apiUrl = normalizeApiUrl(rawApiUrl);

  const request = async (method: string, route: string, init: { body?: unknown; bearer?: string }): Promise<JsonResponse> => {
    const headers: Record<string, string> = { accept: "application/json" };
    if (init.body !== undefined) headers["content-type"] = "application/json";
    if (init.bearer !== undefined) headers.authorization = `Bearer ${init.bearer}`;
    let response: Response;
    try {
      response = await fetchImpl(`${apiUrl}/alpha-api/${route}`, {
        method,
        headers,
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        redirect: "error",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      throw new AlphaApiError("API_UNREACHABLE", `Could not reach the account service at ${apiUrl}: ${error instanceof Error ? error.message : String(error)}`);
    }
    let body: Record<string, unknown> | null = null;
    const text = await response.text();
    if (text.length > 0) {
      try {
        const parsed = JSON.parse(text) as unknown;
        if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) body = parsed as Record<string, unknown>;
      } catch {
        body = null;
      }
    }
    const retryAfterHeader = Number(response.headers.get("retry-after"));
    return {
      status: response.status,
      body,
      ...(Number.isFinite(retryAfterHeader) && retryAfterHeader > 0 ? { retryAfterMs: retryAfterHeader * 1000 } : {}),
    };
  };

  const failFrom = (response: JsonResponse, fallback: string): AlphaApiError => {
    const error = typeof response.body?.error === "string" ? response.body.error : "";
    if (response.status === 401 || error === "invalid_auth") {
      return new AlphaApiError("AUTH_REJECTED", "The server no longer accepts this computer's access.", response.status);
    }
    if (error === "legal_required") {
      return new AlphaApiError("LEGAL_REQUIRED", "Your account has terms left to accept.", response.status);
    }
    if (error === "release_not_allowed") {
      return new AlphaApiError("RELEASE_NOT_ALLOWED", "The server does not accept this client release.", response.status);
    }
    if (error === "device_not_found") {
      return new AlphaApiError("DEVICE_NOT_FOUND", "The server does not know this sign-in attempt.", response.status);
    }
    if (error === "device_state") {
      return new AlphaApiError("DEVICE_STATE", "This sign-in attempt is already settled.", response.status);
    }
    if (error === "character_not_found") {
      return new AlphaApiError("CHARACTER_NOT_FOUND", "That character is not on this account.", response.status);
    }
    return new AlphaApiError("API_ERROR", `${fallback} (HTTP ${response.status}${error ? `, ${error}` : ""})`, response.status);
  };

  return {
    apiUrl,
    connectUrl: `${apiUrl}/connect`,

    async deviceStart(releaseId) {
      const response = await request("POST", "device/start", {
        body: { clientId: DEVICE_CLIENT_ID, releaseId, scopes: [...DEVICE_SCOPES] },
      });
      if (response.status !== 201 || response.body === null) throw failFrom(response, "Could not start sign-in");
      const { deviceCode, userCode, expiresAt, pollIntervalMs } = response.body;
      if (typeof deviceCode !== "string" || typeof userCode !== "string" || typeof expiresAt !== "number" || typeof pollIntervalMs !== "number") {
        throw new AlphaApiError("API_RESPONSE_INVALID", "The sign-in start reply was missing fields.");
      }
      return { deviceCode, userCode, expiresAt, pollIntervalMs };
    },

    async devicePoll(deviceCode) {
      const response = await request("POST", "device/poll", { body: { deviceCode } });
      if (response.body === null) throw failFrom(response, "Sign-in poll failed");
      const status = response.body.status;
      if (response.status === 429 || status === "slow_down") {
        const retryAfterMs = typeof response.body.retryAfterMs === "number" ? response.body.retryAfterMs : response.retryAfterMs;
        return { status: "slow_down", ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) };
      }
      if (response.status !== 200) throw failFrom(response, "Sign-in poll failed");
      if (status !== "pending" && status !== "approved" && status !== "denied" && status !== "exchanged" && status !== "revoked" && status !== "expired") {
        throw new AlphaApiError("API_RESPONSE_INVALID", "The sign-in poll reply had an unknown status.");
      }
      const credential = typeof response.body.credential === "string" ? response.body.credential : undefined;
      if (status === "exchanged") {
        if (credential === undefined || !TOKEN_PATTERN.test(credential)) {
          throw new AlphaApiError("API_RESPONSE_INVALID", "The server approved sign-in but returned an unusable access token.");
        }
        const scopes = Array.isArray(response.body.scopes) ? response.body.scopes.filter((scope): scope is string => typeof scope === "string") : [...DEVICE_SCOPES];
        return { status, credential, scopes };
      }
      return { status };
    },

    async deviceLogout(credential) {
      const response = await request("POST", "device/logout", { bearer: credential, body: {} });
      if (response.status === 204) return "revoked";
      if (response.status === 404) return "unsupported";
      if (response.status === 401) return "revoked"; // already dead server-side
      throw failFrom(response, "Could not revoke this computer's access");
    },

    async listCharacters(credential) {
      const response = await request("GET", "characters", { bearer: credential });
      if (response.status !== 200 || response.body === null) throw failFrom(response, "Could not list characters");
      const characters = response.body.characters;
      if (!Array.isArray(characters)) throw new AlphaApiError("API_RESPONSE_INVALID", "The character list reply was not a list.");
      return characters.map((entry) => {
        const record = (typeof entry === "object" && entry !== null ? entry : {}) as Record<string, unknown>;
        if (typeof record.id !== "string" || typeof record.name !== "string") {
          throw new AlphaApiError("API_RESPONSE_INVALID", "A character entry was missing its id or name.");
        }
        return {
          id: record.id,
          name: record.name,
          initialProfessionId: typeof record.initialProfessionId === "string" ? record.initialProfessionId : "",
          worldEntryClaimed: record.worldEntryClaimed === true,
        };
      });
    },

    async playTicket(credential, characterId) {
      const response = await request("POST", "play-ticket", { bearer: credential, body: { characterId } });
      if (response.status !== 200 || response.body === null) throw failFrom(response, "Could not start a launch");
      const { gameTicket, chatTicket, expiresAt } = response.body;
      const endpoints = (typeof response.body.endpoints === "object" && response.body.endpoints !== null ? response.body.endpoints : {}) as Record<string, unknown>;
      const release = (typeof response.body.release === "object" && response.body.release !== null ? response.body.release : {}) as Record<string, unknown>;
      if (typeof gameTicket !== "string" || typeof chatTicket !== "string" || gameTicket.length === 0 || chatTicket.length === 0 || gameTicket === chatTicket) {
        throw new AlphaApiError("API_RESPONSE_INVALID", "The launch reply did not carry a usable split ticket pair.");
      }
      return {
        gameTicket,
        chatTicket,
        characterId: typeof response.body.characterId === "string" ? response.body.characterId : characterId,
        expiresAt: typeof expiresAt === "number" ? expiresAt : 0,
        endpoints: {
          game: typeof endpoints.game === "string" ? endpoints.game : "",
          chat: typeof endpoints.chat === "string" ? endpoints.chat : "",
        },
        release: {
          client: typeof release.client === "string" ? release.client : "",
          server: typeof release.server === "string" ? release.server : "",
          shard: typeof release.shard === "string" ? release.shard : "",
        },
      };
    },
  };
}

/**
 * Release identity for device/start. Packaged artifacts carry a bundle.json
 * one directory above dist/cli.js; dev runs fall back to the env or "dev".
 */
export async function detectReleaseId(env: NodeJS.ProcessEnv = process.env, moduleUrl: string = import.meta.url): Promise<string> {
  try {
    // path arithmetic, not a module reference: bundle.json is packager-written
    // data one level above dist/, and must stay invisible to chunk validation
    const bundlePath = path.resolve(path.dirname(fileURLToPath(moduleUrl)), "..", "bundle.json");
    const bundle = JSON.parse(await readFile(bundlePath, "utf8")) as Record<string, unknown>;
    if (bundle.schema === "successor.tui-bundle.v1" && typeof bundle.releaseId === "string" && bundle.releaseId.length > 0) {
      return bundle.releaseId;
    }
  } catch {
    // not a packaged artifact — fall through
  }
  return env.SUCCESSOR_RELEASE_ID?.trim() || "dev";
}
