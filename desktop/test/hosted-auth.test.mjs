import assert from "node:assert/strict";
import test from "node:test";

import {
  DEVICE_POLL_FLOOR_MS,
  HostedAuthError,
  isValidLaunchEnvelope,
  listCharacters,
  mintLaunchEnvelope,
  pollDeviceOnce,
  revokeDeviceCredential,
  runDevicePollLoop,
  startDeviceAuthorization,
} from "../src/hosted-auth.mjs";

const API = "http://127.0.0.1:9";

function jsonResponse(status, body, headers = {}) {
  return {
    status,
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
    json: async () => body,
  };
}

function scriptedFetch(script) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const step = script.shift();
    if (!step) throw new Error("fetch script exhausted");
    if (step instanceof Error) throw step;
    return step;
  };
  return { fetchImpl, calls };
}

const START_BODY = {
  authorizationId: "auth_1",
  deviceCode: "device-code-0123456789abcdef0123",
  userCode: "ABCD2EFGH3",
  expiresAt: Date.now() + 600_000,
  pollIntervalMs: 5000,
  scopes: ["character:list", "play-ticket"],
};

test("device start posts the exact scoped request and returns the link", async () => {
  const { fetchImpl, calls } = scriptedFetch([jsonResponse(201, START_BODY)]);
  const started = await startDeviceAuthorization({
    fetchImpl,
    apiOrigin: API,
    clientId: "successor-desktop",
    releaseId: "successor-alpha",
    scopes: ["character:list", "play-ticket"],
  });
  assert.equal(calls[0].url, `${API}/alpha-api/device/start`);
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    clientId: "successor-desktop",
    releaseId: "successor-alpha",
    scopes: ["character:list", "play-ticket"],
  });
  assert.equal(calls[0].init.headers["content-type"], "application/json");
  assert.equal(started.userCode, "ABCD2EFGH3");
  assert.equal(started.pollIntervalMs, 5000);
});

test("device start never floors the poll interval below five seconds", async () => {
  const { fetchImpl } = scriptedFetch([jsonResponse(201, { ...START_BODY, pollIntervalMs: 750 })]);
  const started = await startDeviceAuthorization({
    fetchImpl,
    apiOrigin: API,
    clientId: "successor-desktop",
    releaseId: "successor-alpha",
    scopes: ["play-ticket"],
  });
  assert.equal(started.pollIntervalMs, DEVICE_POLL_FLOOR_MS);
});

test("device start errors are sanitized machine codes without response echo", async () => {
  const { fetchImpl } = scriptedFetch([jsonResponse(400, { error: "release_not_allowed", secretEcho: "nope" })]);
  await assert.rejects(
    startDeviceAuthorization({ fetchImpl, apiOrigin: API, clientId: "c", releaseId: "r", scopes: ["play-ticket"] }),
    (error) => {
      assert.ok(error instanceof HostedAuthError);
      assert.equal(error.code, "release_not_allowed");
      assert.ok(!error.message.includes("nope"));
      return true;
    },
  );
});

test("poll loop rides pending, honors slow_down retryAfterMs, and yields the one credential", async () => {
  const waits = [];
  const { fetchImpl } = scriptedFetch([
    jsonResponse(200, { status: "pending", expiresAt: START_BODY.expiresAt }),
    jsonResponse(429, { status: "slow_down", retryAfterMs: 10_000 }, { "retry-after": "10" }),
    jsonResponse(200, { status: "pending" }),
    jsonResponse(200, { status: "exchanged", credential: "credential-0123456789abcdef0123", scopes: START_BODY.scopes }),
  ]);
  const outcome = await runDevicePollLoop({
    fetchImpl,
    apiOrigin: API,
    deviceCode: START_BODY.deviceCode,
    pollIntervalMs: 5000,
    expiresAt: START_BODY.expiresAt,
    delay: async (ms) => waits.push(ms),
  });
  assert.equal(outcome.status, "exchanged");
  assert.equal(outcome.credential, "credential-0123456789abcdef0123");
  // First wait is the floor; after slow_down the interval rises and stays up.
  assert.deepEqual(waits, [5000, 5000, 10_000, 10_000]);
  assert.ok(waits.every((ms) => ms >= DEVICE_POLL_FLOOR_MS));
});

test("poll loop reports denied, revoked, and server-side expiry honestly", async () => {
  for (const status of ["denied", "revoked", "expired"]) {
    const { fetchImpl } = scriptedFetch([jsonResponse(200, { status })]);
    const outcome = await runDevicePollLoop({
      fetchImpl,
      apiOrigin: API,
      deviceCode: START_BODY.deviceCode,
      pollIntervalMs: 5000,
      expiresAt: Date.now() + 60_000,
      delay: async () => undefined,
    });
    assert.equal(outcome.status, status);
  }
});

test("poll loop expires locally when the authorization deadline passes", async () => {
  const { fetchImpl, calls } = scriptedFetch([]);
  const outcome = await runDevicePollLoop({
    fetchImpl,
    apiOrigin: API,
    deviceCode: START_BODY.deviceCode,
    pollIntervalMs: 5000,
    expiresAt: Date.now() - 1,
    delay: async () => undefined,
  });
  assert.equal(outcome.status, "expired");
  assert.equal(calls.length, 0);
});

test("poll loop stops on cancellation and reports unreachable after repeated network loss", async () => {
  const abort = new AbortController();
  abort.abort();
  const cancelled = await runDevicePollLoop({
    fetchImpl: async () => {
      throw new Error("must not fetch after abort");
    },
    apiOrigin: API,
    deviceCode: START_BODY.deviceCode,
    pollIntervalMs: 5000,
    expiresAt: Date.now() + 60_000,
    signal: abort.signal,
    delay: async () => undefined,
  });
  assert.equal(cancelled.status, "cancelled");

  const { fetchImpl } = scriptedFetch([new Error("down"), new Error("down"), new Error("down")]);
  const unreachable = await runDevicePollLoop({
    fetchImpl,
    apiOrigin: API,
    deviceCode: START_BODY.deviceCode,
    pollIntervalMs: 5000,
    expiresAt: Date.now() + 60_000,
    delay: async () => undefined,
  });
  assert.equal(unreachable.status, "unreachable");
});

test("route-level 429 without a slow_down body is treated as slow_down with Retry-After", async () => {
  const { fetchImpl } = scriptedFetch([jsonResponse(429, { error: "rate_limited" }, { "retry-after": "7" })]);
  const result = await pollDeviceOnce({ fetchImpl, apiOrigin: API, deviceCode: START_BODY.deviceCode });
  assert.equal(result.status, "slow_down");
  assert.equal(result.retryAfterMs, 7000);
});

test("character list uses the bearer header only and maps the public roster", async () => {
  const { fetchImpl, calls } = scriptedFetch([jsonResponse(200, {
    characters: [
      { id: "char-1", name: "Bountyscout", initialProfessionId: "medic", worldEntryClaimed: true, appearance: {} },
      { id: "char-2", name: "Dustcaller" },
      { bogus: true },
    ],
  })]);
  const roster = await listCharacters({ fetchImpl, apiOrigin: API, credential: "credential-0123456789abcdef0123" });
  assert.equal(calls[0].url, `${API}/alpha-api/characters`);
  assert.equal(calls[0].init.headers.authorization, "Bearer credential-0123456789abcdef0123");
  assert.ok(!calls[0].url.includes("credential"));
  assert.deepEqual(roster, [
    { id: "char-1", name: "Bountyscout", professionId: "medic", worldEntryClaimed: true },
    { id: "char-2", name: "Dustcaller", professionId: null, worldEntryClaimed: false },
  ]);
});

test("character list maps 401 to the unauthorized code", async () => {
  const { fetchImpl } = scriptedFetch([jsonResponse(401, { error: "invalid_auth" })]);
  await assert.rejects(
    listCharacters({ fetchImpl, apiOrigin: API, credential: "credential-0123456789abcdef0123" }),
    (error) => error instanceof HostedAuthError && error.code === "unauthorized",
  );
});

const TICKET_BODY = {
  gameTicket: "game-ticket-0123456789abcdef",
  chatTicket: "chat-ticket-0123456789abcdef",
  characterId: "char-1",
  expiresAt: Date.now() + 45_000,
  endpoints: { game: "wss://game.example/game", chat: "wss://chat.example/chat" },
  release: { client: "successor-alpha", server: "successor-server-1", shard: "open-desert" },
};

test("mint returns the exact shared standalone envelope shape", async () => {
  const { fetchImpl, calls } = scriptedFetch([jsonResponse(200, TICKET_BODY)]);
  const envelope = await mintLaunchEnvelope({
    fetchImpl,
    apiOrigin: API,
    credential: "credential-0123456789abcdef0123",
    characterId: "char-1",
  });
  assert.equal(calls[0].url, `${API}/alpha-api/play-ticket`);
  assert.deepEqual(JSON.parse(calls[0].init.body), { characterId: "char-1" });
  assert.equal(calls[0].init.headers.authorization, "Bearer credential-0123456789abcdef0123");
  assert.deepEqual(envelope, {
    schema: "successor.launch-context.v1",
    gameTicket: TICKET_BODY.gameTicket,
    chatTicket: TICKET_BODY.chatTicket,
    endpoints: TICKET_BODY.endpoints,
    release: TICKET_BODY.release,
    characterId: "char-1",
    expiresAt: TICKET_BODY.expiresAt,
  });
  assert.equal(isValidLaunchEnvelope(envelope), true);
});

test("mint fails closed on malformed envelopes", async () => {
  const bad = [
    { ...TICKET_BODY, chatTicket: TICKET_BODY.gameTicket },
    { ...TICKET_BODY, endpoints: { game: "https://game.example", chat: TICKET_BODY.endpoints.chat } },
    { ...TICKET_BODY, endpoints: { game: "wss://game.example/x?ticket=leak", chat: TICKET_BODY.endpoints.chat } },
    { ...TICKET_BODY, gameTicket: "" },
    { ...TICKET_BODY, expiresAt: "soon" },
  ];
  for (const body of bad) {
    const { fetchImpl } = scriptedFetch([jsonResponse(200, body)]);
    await assert.rejects(
      mintLaunchEnvelope({ fetchImpl, apiOrigin: API, credential: "credential-0123456789abcdef0123", characterId: "char-1" }),
      (error) => error instanceof HostedAuthError && error.code === "invalid_response",
    );
  }
});

test("credential revoke is best-effort and tolerates an API without the logout route", async () => {
  const ok = scriptedFetch([jsonResponse(204, null)]);
  assert.equal(await revokeDeviceCredential({ fetchImpl: ok.fetchImpl, apiOrigin: API, credential: "credential-0123456789abcdef0123" }), true);
  assert.equal(ok.calls[0].url, `${API}/alpha-api/device/logout`);
  const missing = scriptedFetch([jsonResponse(404, { error: "not_found" })]);
  assert.equal(await revokeDeviceCredential({ fetchImpl: missing.fetchImpl, apiOrigin: API, credential: "x".repeat(24) }), false);
  const down = scriptedFetch([new Error("offline")]);
  assert.equal(await revokeDeviceCredential({ fetchImpl: down.fetchImpl, apiOrigin: API, credential: "x".repeat(24) }), false);
});
