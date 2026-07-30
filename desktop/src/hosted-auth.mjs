/**
 * Device-flow client for the standalone account API.
 *
 * Runs only in the Electron MAIN process. The device code, device credential,
 * and launch tickets live here in memory and never reach a URL, query string,
 * argv, env, log line, renderer snapshot, or error message. Errors carry a
 * machine `code` and a generic message; response bodies are never echoed.
 */

export const STANDALONE_LAUNCH_SCHEMA = "successor.launch-context.v1";
export const STANDALONE_LAUNCH_MESSAGE = "successor.launch.v1";
export const DEVICE_POLL_FLOOR_MS = 5_000;
export const DEVICE_POLL_CEILING_MS = 60_000;

export class HostedAuthError extends Error {
  constructor(code, message) {
    super(message ?? code);
    this.name = "HostedAuthError";
    this.code = code;
  }
}

function apiUrl(apiOrigin, route) {
  return `${apiOrigin}/alpha-api/${route}`;
}

async function postJson(fetchImpl, apiOrigin, route, body, headers = {}) {
  let response;
  try {
    response = await fetchImpl(apiUrl(apiOrigin, route), {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  } catch {
    throw new HostedAuthError("network", "account service unreachable");
  }
  return response;
}

async function readJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function errorCodeFor(response, body) {
  const apiError = body && typeof body === "object" && typeof body.error === "string" ? body.error : null;
  if (response.status === 429 && apiError === "rate_limited") return "rate_limited";
  if (apiError === "release_not_allowed") return "release_not_allowed";
  if (apiError === "device_not_found") return "device_not_found";
  if (response.status === 401) return "unauthorized";
  return `http_${response.status}`;
}

/** POST device/start -> { deviceCode, userCode, expiresAt, pollIntervalMs }. */
export async function startDeviceAuthorization({ fetchImpl = globalThis.fetch, apiOrigin, clientId, releaseId, scopes }) {
  const response = await postJson(fetchImpl, apiOrigin, "device/start", { clientId, releaseId, scopes: [...scopes] });
  const body = await readJson(response);
  if (response.status !== 201) throw new HostedAuthError(errorCodeFor(response, body), "device link could not start");
  if (
    !body || typeof body !== "object"
    || typeof body.deviceCode !== "string" || body.deviceCode.length < 20
    || typeof body.userCode !== "string" || !/^[A-Z0-9]{4,32}$/u.test(body.userCode)
    || !Number.isSafeInteger(body.expiresAt)
  ) {
    throw new HostedAuthError("invalid_response", "account service sent an unusable device link");
  }
  const pollIntervalMs = Number.isSafeInteger(body.pollIntervalMs) && body.pollIntervalMs > 0
    ? body.pollIntervalMs
    : DEVICE_POLL_FLOOR_MS;
  return {
    deviceCode: body.deviceCode,
    userCode: body.userCode,
    expiresAt: body.expiresAt,
    pollIntervalMs: Math.max(DEVICE_POLL_FLOOR_MS, pollIntervalMs),
  };
}

const POLL_STATUSES = new Set(["pending", "approved", "denied", "exchanged", "revoked", "expired", "slow_down"]);

/** One POST device/poll. Returns { status, retryAfterMs?, credential? }. */
export async function pollDeviceOnce({ fetchImpl = globalThis.fetch, apiOrigin, deviceCode }) {
  const response = await postJson(fetchImpl, apiOrigin, "device/poll", { deviceCode });
  const body = await readJson(response);
  if (response.status !== 200 && response.status !== 429) {
    throw new HostedAuthError(errorCodeFor(response, body), "device link poll failed");
  }
  const status = body && typeof body === "object" ? body.status : null;
  if (response.status === 429 && status !== "slow_down") {
    // Route-level rate limit: treat as a slow_down leg honoring Retry-After.
    const retryAfterSec = Number(response.headers?.get?.("retry-after"));
    return { status: "slow_down", retryAfterMs: Number.isFinite(retryAfterSec) && retryAfterSec > 0 ? retryAfterSec * 1000 : DEVICE_POLL_FLOOR_MS * 2 };
  }
  if (!POLL_STATUSES.has(status)) throw new HostedAuthError("invalid_response", "account service sent an unusable poll result");
  const result = { status };
  if (Number.isSafeInteger(body.retryAfterMs) && body.retryAfterMs > 0) result.retryAfterMs = body.retryAfterMs;
  if (status === "exchanged") {
    if (typeof body.credential !== "string" || body.credential.length < 20) {
      throw new HostedAuthError("invalid_response", "account service sent an unusable credential");
    }
    result.credential = body.credential;
  }
  return result;
}

/**
 * Poll until a terminal status. Interval starts at max(5s, pollIntervalMs)
 * and only ever rises on slow_down. `deadline` is the authorization expiry;
 * we stop locally when it passes even if the server never answers "expired".
 */
export async function runDevicePollLoop({
  fetchImpl = globalThis.fetch,
  apiOrigin,
  deviceCode,
  pollIntervalMs,
  expiresAt,
  signal,
  now = Date.now,
  delay = defaultDelay,
  maxTransientFailures = 3,
}) {
  let interval = Math.max(DEVICE_POLL_FLOOR_MS, pollIntervalMs ?? DEVICE_POLL_FLOOR_MS);
  let transientFailures = 0;
  while (true) {
    if (signal?.aborted) return { status: "cancelled" };
    if (now() >= expiresAt) return { status: "expired" };
    await delay(Math.min(interval, DEVICE_POLL_CEILING_MS), signal);
    if (signal?.aborted) return { status: "cancelled" };
    if (now() >= expiresAt) return { status: "expired" };
    let result;
    try {
      result = await pollDeviceOnce({ fetchImpl, apiOrigin, deviceCode });
      transientFailures = 0;
    } catch (error) {
      if (error instanceof HostedAuthError && (error.code === "network" || error.code.startsWith("http_5"))) {
        transientFailures += 1;
        if (transientFailures >= maxTransientFailures) return { status: "unreachable" };
        continue;
      }
      throw error;
    }
    if (result.status === "pending") continue;
    if (result.status === "slow_down") {
      interval = Math.max(interval, result.retryAfterMs ?? interval + DEVICE_POLL_FLOOR_MS);
      continue;
    }
    if (result.status === "approved") continue; // next poll exchanges
    return result; // exchanged | denied | expired | revoked
  }
}

function defaultDelay(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(() => {
      signal?.removeEventListener?.("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal?.addEventListener?.("abort", onAbort, { once: true });
  });
}

/** GET characters with the scoped credential. Returns the public roster. */
export async function listCharacters({ fetchImpl = globalThis.fetch, apiOrigin, credential }) {
  let response;
  try {
    response = await fetchImpl(apiUrl(apiOrigin, "characters"), {
      headers: { authorization: `Bearer ${credential}` },
    });
  } catch {
    throw new HostedAuthError("network", "account service unreachable");
  }
  const body = await readJson(response);
  if (response.status !== 200) throw new HostedAuthError(errorCodeFor(response, body), "character list failed");
  if (!body || !Array.isArray(body.characters)) throw new HostedAuthError("invalid_response", "account service sent an unusable roster");
  return body.characters
    .filter((row) => row && typeof row === "object" && typeof row.id === "string" && typeof row.name === "string")
    .map((row) => ({
      id: row.id,
      name: row.name,
      professionId: typeof row.initialProfessionId === "string" ? row.initialProfessionId : null,
      worldEntryClaimed: row.worldEntryClaimed === true,
    }));
}

/**
 * POST play-ticket and shape the response into the exact shared standalone
 * launch envelope (client/src/runtime/launchContext.ts). Anything malformed
 * fails closed before a window ever sees it.
 */
export async function mintLaunchEnvelope({ fetchImpl = globalThis.fetch, apiOrigin, credential, characterId }) {
  const response = await postJson(fetchImpl, apiOrigin, "play-ticket", { characterId }, {
    authorization: `Bearer ${credential}`,
  });
  const body = await readJson(response);
  if (response.status !== 200) throw new HostedAuthError(errorCodeFor(response, body), "launch could not be issued");
  const envelope = body && typeof body === "object"
    ? {
      schema: STANDALONE_LAUNCH_SCHEMA,
      gameTicket: body.gameTicket,
      chatTicket: body.chatTicket,
      endpoints: {
        game: body.endpoints?.game,
        chat: body.endpoints?.chat,
      },
      release: {
        client: body.release?.client,
        server: body.release?.server,
        ...(typeof body.release?.shard === "string" ? { shard: body.release.shard } : {}),
      },
      characterId: body.characterId,
      expiresAt: body.expiresAt,
    }
    : null;
  if (!envelope || !isValidLaunchEnvelope(envelope)) {
    throw new HostedAuthError("invalid_response", "account service sent an unusable launch");
  }
  return envelope;
}

export function isValidLaunchEnvelope(envelope) {
  if (!envelope || typeof envelope !== "object") return false;
  if (envelope.schema !== STANDALONE_LAUNCH_SCHEMA) return false;
  if (!isToken(envelope.gameTicket) || !isToken(envelope.chatTicket)) return false;
  if (envelope.gameTicket === envelope.chatTicket) return false;
  if (!isSocketUrl(envelope.endpoints?.game) || !isSocketUrl(envelope.endpoints?.chat)) return false;
  if (!isToken(envelope.release?.client) || !isToken(envelope.release?.server)) return false;
  if (!isToken(envelope.characterId) || envelope.characterId.length > 128) return false;
  if (!Number.isSafeInteger(envelope.expiresAt)) return false;
  return true;
}

/** Best-effort server-side revoke of the device credential (sign out). */
export async function revokeDeviceCredential({ fetchImpl = globalThis.fetch, apiOrigin, credential }) {
  try {
    const response = await postJson(fetchImpl, apiOrigin, "device/logout", {}, {
      authorization: `Bearer ${credential}`,
    });
    // 404 means an older API without the logout route; local clear still wins.
    return response.status === 204;
  } catch {
    return false;
  }
}

function isToken(value) {
  return typeof value === "string" && value.length > 0 && value === value.trim() && value.length <= 4096;
}

function isSocketUrl(value) {
  if (typeof value !== "string" || !value) return false;
  let url;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== "ws:" && url.protocol !== "wss:") return false;
  if (!url.hostname || url.username || url.password || url.search || url.hash) return false;
  return true;
}
