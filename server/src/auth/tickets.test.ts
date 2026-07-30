import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { commitHostedFirstEntry, parseLaunchTicketResponse, pendingFirstEntryCommit, resolveLaunchTicketIdentity } from "./tickets.js";

const validTicket = "A".repeat(32);
const originalNodeEnv = process.env.NODE_ENV;
const originalSiteUrl = process.env.SUCCESSOR_SITE_URL;
const originalRuntimeSecret = process.env.SUCCESSOR_RUNTIME_SECRET;
const originalRuntimeBearerToken = process.env.SUCCESSOR_RUNTIME_BEARER_TOKEN;
const originalShardId = process.env.SUCCESSOR_SHARD_ID;
const originalReleaseId = process.env.SUCCESSOR_RELEASE_ID;

function ticketPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    player: {
      id: "prof_player_legacy",
      profileId: "profile-123",
      characterId: "char-abc",
      displayName: "Atlas",
      zoneId: "open-desert-overworld",
    },
    entitlement: {
      access: true,
      characterSlots: 3,
      activeUntil: null,
    },
    ...overrides,
  };
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("launch ticket redemption", () => {
  beforeEach(() => {
    process.env.NODE_ENV = "test";
    process.env.SUCCESSOR_SITE_URL = "https://successor.example";
    delete process.env.SUCCESSOR_RUNTIME_SECRET;
    delete process.env.SUCCESSOR_RUNTIME_BEARER_TOKEN;
    delete process.env.SUCCESSOR_SHARD_ID;
    delete process.env.SUCCESSOR_RELEASE_ID;
  });

  afterEach(() => {
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
    if (originalSiteUrl === undefined) delete process.env.SUCCESSOR_SITE_URL;
    else process.env.SUCCESSOR_SITE_URL = originalSiteUrl;
    if (originalRuntimeSecret === undefined) delete process.env.SUCCESSOR_RUNTIME_SECRET;
    else process.env.SUCCESSOR_RUNTIME_SECRET = originalRuntimeSecret;
    if (originalRuntimeBearerToken === undefined) delete process.env.SUCCESSOR_RUNTIME_BEARER_TOKEN;
    else process.env.SUCCESSOR_RUNTIME_BEARER_TOKEN = originalRuntimeBearerToken;
    if (originalShardId === undefined) delete process.env.SUCCESSOR_SHARD_ID;
    else process.env.SUCCESSOR_SHARD_ID = originalShardId;
    if (originalReleaseId === undefined) delete process.env.SUCCESSOR_RELEASE_ID;
    else process.env.SUCCESSOR_RELEASE_ID = originalReleaseId;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("parses the full frozen ticket payload", () => {
    const parsed = parseLaunchTicketResponse(ticketPayload({
      entitlement: {
        access: true,
        characterSlots: 10,
        activeUntil: "2026-08-09T00:00:00.000Z",
      },
    }));

    expect(parsed).toMatchObject({
      player: {
        profileId: "profile-123",
        characterId: "char-abc",
        displayName: "Atlas",
        zoneId: "open-desert-overworld",
      },
      entitlement: {
        access: true,
        characterSlots: 10,
        activeUntil: "2026-08-09T00:00:00.000Z",
      },
    });
  });

  it("parses the minimal frozen ticket payload with a null activeUntil", () => {
    expect(parseLaunchTicketResponse(ticketPayload())).toMatchObject({
      entitlement: { access: true, characterSlots: 3, activeUntil: null },
    });
  });

  it("tolerates forward-compatible extra fields", () => {
    const parsed = parseLaunchTicketResponse(ticketPayload({
      player: {
        id: "prof_player_legacy",
        profileId: "profile-123",
        characterId: "char-abc",
        displayName: "Atlas",
        zoneId: "open-desert-overworld",
        shardHint: "ashvat-a",
      },
      entitlement: {
        access: true,
        characterSlots: 3,
        activeUntil: null,
        sku: "founder",
      },
      moderation: { standing: "clear" },
    }));

    expect(parsed?.player.profileId).toBe("profile-123");
    expect(parsed?.entitlement.characterSlots).toBe(3);
  });

  it("sends the complete runtime identity header set in hosted mode and returns normalized identity", async () => {
    process.env.NODE_ENV = "production";
    process.env.SUCCESSOR_RUNTIME_SECRET = "runtime-secret";
    process.env.SUCCESSOR_RUNTIME_BEARER_TOKEN = "bearer-token";
    process.env.SUCCESSOR_SHARD_ID = "ashvat-a";
    process.env.SUCCESSOR_RELEASE_ID = "release-2026-08-09";
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => jsonResponse(ticketPayload()));
    vi.stubGlobal("fetch", fetchMock);

    const identity = await resolveLaunchTicketIdentity(validTicket);

    expect(identity).toMatchObject({
      userId: "profile-123",
      displayName: "Atlas",
      zoneId: "open-desert-overworld",
      player: { profileId: "profile-123", characterId: "char-abc" },
      entitlement: { access: true, characterSlots: 3, activeUntil: null },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`https://successor.example/api/v1/storefront/successor/session-ticket/${validTicket}`);
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      headers: {
        Accept: "application/json",
        "User-Agent": "Successor-Runtime/1.0",
        "x-successor-runtime-key": "runtime-secret",
        Authorization: "Bearer bearer-token",
        "x-successor-shard-id": "ashvat-a",
        "x-successor-release-id": "release-2026-08-09",
      },
    });
    expect((fetchMock.mock.calls[0]?.[1] as RequestInit).headers).toEqual({
      Accept: "application/json",
      "User-Agent": "Successor-Runtime/1.0",
      "x-successor-runtime-key": "runtime-secret",
      Authorization: "Bearer bearer-token",
      "x-successor-shard-id": "ashvat-a",
      "x-successor-release-id": "release-2026-08-09",
    });
  });

  it.each([
    ["secret missing", undefined, "bearer-token", "ashvat-a", "release-2026-08-09"],
    ["secret blank", "  \t", "bearer-token", "ashvat-a", "release-2026-08-09"],
    ["bearer token missing", "runtime-secret", undefined, "ashvat-a", "release-2026-08-09"],
    ["bearer token blank", "runtime-secret", "  \t", "ashvat-a", "release-2026-08-09"],
    ["shard ID missing", "runtime-secret", "bearer-token", undefined, "release-2026-08-09"],
    ["shard ID blank", "runtime-secret", "bearer-token", "  \t", "release-2026-08-09"],
    ["release ID missing", "runtime-secret", "bearer-token", "ashvat-a", undefined],
    ["release ID blank", "runtime-secret", "bearer-token", "ashvat-a", "  \t"],
  ])("fails closed before fetch when hosted %s", async (_caseName, secret, bearerToken, shardId, releaseId) => {
    process.env.NODE_ENV = "production";
    if (secret === undefined) delete process.env.SUCCESSOR_RUNTIME_SECRET;
    else process.env.SUCCESSOR_RUNTIME_SECRET = secret;
    if (bearerToken === undefined) delete process.env.SUCCESSOR_RUNTIME_BEARER_TOKEN;
    else process.env.SUCCESSOR_RUNTIME_BEARER_TOKEN = bearerToken;
    if (shardId === undefined) delete process.env.SUCCESSOR_SHARD_ID;
    else process.env.SUCCESSOR_SHARD_ID = shardId;
    if (releaseId === undefined) delete process.env.SUCCESSOR_RELEASE_ID;
    else process.env.SUCCESSOR_RELEASE_ID = releaseId;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(resolveLaunchTicketIdentity(validTicket)).resolves.toBeNull();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps local/dev redemption testable without runtime credentials", async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => jsonResponse(ticketPayload()));
    vi.stubGlobal("fetch", fetchMock);

    await expect(resolveLaunchTicketIdentity(validTicket)).resolves.toMatchObject({ userId: "profile-123" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((fetchMock.mock.calls[0]?.[1] as RequestInit).headers).toEqual({ Accept: "application/json", "User-Agent": "Successor-Runtime/1.0" });
  });

  it("returns null for HTTP errors", async () => {
    process.env.NODE_ENV = "production";
    process.env.SUCCESSOR_RUNTIME_SECRET = "runtime-secret";
    process.env.SUCCESSOR_RUNTIME_BEARER_TOKEN = "bearer-token";
    process.env.SUCCESSOR_SHARD_ID = "ashvat-a";
    process.env.SUCCESSOR_RELEASE_ID = "release-2026-08-09";
    const fetchMock = vi.fn(async () => jsonResponse({ error: "unauthorized" }, 401));
    vi.stubGlobal("fetch", fetchMock);

    await expect(resolveLaunchTicketIdentity(validTicket)).resolves.toBeNull();
  });

  it("returns null for non-JSON bodies", async () => {
    process.env.NODE_ENV = "production";
    process.env.SUCCESSOR_RUNTIME_SECRET = "runtime-secret";
    process.env.SUCCESSOR_RUNTIME_BEARER_TOKEN = "bearer-token";
    process.env.SUCCESSOR_SHARD_ID = "ashvat-a";
    process.env.SUCCESSOR_RELEASE_ID = "release-2026-08-09";
    const fetchMock = vi.fn(async () => new Response("not-json", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(resolveLaunchTicketIdentity(validTicket)).resolves.toBeNull();
  });

  it("returns null for invalid JSON ticket bodies", async () => {
    process.env.NODE_ENV = "production";
    process.env.SUCCESSOR_RUNTIME_SECRET = "runtime-secret";
    process.env.SUCCESSOR_RUNTIME_BEARER_TOKEN = "bearer-token";
    process.env.SUCCESSOR_SHARD_ID = "ashvat-a";
    process.env.SUCCESSOR_RELEASE_ID = "release-2026-08-09";
    const fetchMock = vi.fn(async () => jsonResponse({ player: { profileId: "profile-123" } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(resolveLaunchTicketIdentity(validTicket)).resolves.toBeNull();
  });

  it("does not log or expose credentials when fetch fails", async () => {
    process.env.NODE_ENV = "production";
    const runtimeSecret = "runtime-secret-not-for-logs";
    const runtimeBearerToken = "bearer-token-not-for-logs";
    process.env.SUCCESSOR_RUNTIME_SECRET = runtimeSecret;
    process.env.SUCCESSOR_RUNTIME_BEARER_TOKEN = runtimeBearerToken;
    process.env.SUCCESSOR_SHARD_ID = "ashvat-a";
    process.env.SUCCESSOR_RELEASE_ID = "release-2026-08-09";
    const fetchMock = vi.fn(async () => {
      throw new Error(`upstream failed for ${runtimeSecret}/${runtimeBearerToken}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(resolveLaunchTicketIdentity(validTicket)).resolves.toBeNull();

    const logged = [logSpy.mock.calls, warnSpy.mock.calls, errorSpy.mock.calls].flat(2).join(" ");
    expect(logged).not.toContain(runtimeSecret);
    expect(logged).not.toContain(runtimeBearerToken);
  });

  it("treats 404 as an invalid/expired/consumed ticket", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ error: "not_found" }, 404)));

    await expect(resolveLaunchTicketIdentity(validTicket)).resolves.toBeNull();
  });

  it("parses a pending hosted first-entry contract and keeps old payloads compatible", () => {
    const parsed = parseLaunchTicketResponse(ticketPayload({
      shardId: "ashvat-a",
      releaseId: "release-2026-08-09",
      entryNonce: "nonce-123",
      firstEntry: { ok: true, idempotent: false, status: "pending", entryNonce: "nonce-123" },
    }));
    expect(parsed).toMatchObject({ shardId: "ashvat-a", releaseId: "release-2026-08-09", firstEntry: { status: "pending" } });
    expect(pendingFirstEntryCommit(parsed!)).toEqual({ entryNonce: "nonce-123", shardId: "ashvat-a", releaseId: "release-2026-08-09" });
    const entered = parseLaunchTicketResponse(ticketPayload({ shardId: "ashvat-a", releaseId: "release-2026-08-09", entryNonce: "nonce-123", firstEntry: { ok: true, idempotent: true, status: "entered", entryNonce: "nonce-123" } }));
    expect(pendingFirstEntryCommit(entered!)).toEqual({ entryNonce: "nonce-123", shardId: "ashvat-a", releaseId: "release-2026-08-09" });
    expect(pendingFirstEntryCommit(parseLaunchTicketResponse(ticketPayload())!)).toBeUndefined();
  });

  it("posts the exact hosted first-entry commit contract", async () => {
    process.env.NODE_ENV = "production";
    process.env.SUCCESSOR_RUNTIME_SECRET = "runtime-secret";
    process.env.SUCCESSOR_RUNTIME_BEARER_TOKEN = "bearer-token";
    process.env.SUCCESSOR_SHARD_ID = "ashvat-a";
    process.env.SUCCESSOR_RELEASE_ID = "release-2026-08-09";
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => jsonResponse({ firstEntry: { ok: true, idempotent: false, status: "entered", entryNonce: "nonce-123" } }));
    vi.stubGlobal("fetch", fetchMock);

    await commitHostedFirstEntry("char-abc", { entryNonce: "nonce-123", shardId: "ashvat-a", releaseId: "release-2026-08-09" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://successor.example/api/v1/storefront/successor/first-entry/char-abc/commit");
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({
      Accept: "application/json",
      "Content-Type": "application/json",
      "User-Agent": "Successor-Runtime/1.0",
      "x-successor-runtime-key": "runtime-secret",
      Authorization: "Bearer bearer-token",
      "x-successor-shard-id": "ashvat-a",
      "x-successor-release-id": "release-2026-08-09",
    });
    expect(JSON.parse(String(init.body))).toEqual({ entryNonce: "nonce-123", shardId: "ashvat-a", releaseId: "release-2026-08-09" });
  });

  it("treats an idempotent entered response as success and prevents overlap", async () => {
    process.env.NODE_ENV = "production";
    process.env.SUCCESSOR_RUNTIME_SECRET = "runtime-secret";
    process.env.SUCCESSOR_RUNTIME_BEARER_TOKEN = "bearer-token";
    process.env.SUCCESSOR_SHARD_ID = "ashvat-a";
    process.env.SUCCESSOR_RELEASE_ID = "release-2026-08-09";
    let releaseFetch!: () => void;
    const fetchMock = vi.fn(async () => {
      await new Promise<void>((resolve) => { releaseFetch = resolve; });
      return jsonResponse({ firstEntry: { ok: true, idempotent: true, status: "entered", entryNonce: "nonce-123" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const first = commitHostedFirstEntry("char-abc", { entryNonce: "nonce-123", shardId: "ashvat-a", releaseId: "release-2026-08-09" });
    const second = commitHostedFirstEntry("char-abc", { entryNonce: "nonce-123", shardId: "ashvat-a", releaseId: "release-2026-08-09" });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    releaseFetch();
    await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);
  });

});
