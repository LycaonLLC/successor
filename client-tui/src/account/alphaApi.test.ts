import { describe, expect, it } from "vitest";

import { AlphaApiError, createAlphaApi, normalizeApiUrl } from "./alphaApi";

const CREDENTIAL = "credential-secret-00000000000000000000000001";

type FakeRoute = (init: RequestInit & { url: string }) => { status: number; body?: unknown; headers?: Record<string, string> };

function fakeFetch(route: FakeRoute): { fetchImpl: typeof fetch; calls: Array<{ url: string; init: RequestInit }> } {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, init });
    const result = route({ ...init, url });
    return new Response(result.body === undefined ? null : JSON.stringify(result.body), {
      status: result.status,
      headers: { "content-type": "application/json", ...result.headers },
    });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

describe("alpha api client", () => {
  it("requires https except for loopback, and refuses query/fragment/userinfo", () => {
    expect(normalizeApiUrl("https://www.successorgame.com")).toBe("https://www.successorgame.com");
    expect(normalizeApiUrl("https://www.successorgame.com/")).toBe("https://www.successorgame.com");
    expect(normalizeApiUrl("http://127.0.0.1:8080")).toBe("http://127.0.0.1:8080");
    expect(normalizeApiUrl("http://localhost:8080")).toBe("http://localhost:8080");
    expect(() => normalizeApiUrl("http://successorgame.com")).toThrow(AlphaApiError);
    expect(() => normalizeApiUrl("https://host/?ticket=x")).toThrow(AlphaApiError);
    expect(() => normalizeApiUrl("https://user:pass@host/")).toThrow(AlphaApiError);
    expect(() => normalizeApiUrl("not a url")).toThrow(AlphaApiError);
  });

  it("sends the credential as a bearer header, never in the URL", async () => {
    const { fetchImpl, calls } = fakeFetch(() => ({ status: 200, body: { characters: [] } }));
    const api = createAlphaApi("http://127.0.0.1:9999", fetchImpl);
    await api.listCharacters(CREDENTIAL);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("http://127.0.0.1:9999/alpha-api/characters");
    expect(calls[0]!.url).not.toContain(CREDENTIAL);
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe(`Bearer ${CREDENTIAL}`);
  });

  it("maps 429 plus Retry-After to slow_down with a millisecond window", async () => {
    const { fetchImpl } = fakeFetch(() => ({ status: 429, body: { status: "slow_down" }, headers: { "retry-after": "15" } }));
    const api = createAlphaApi("http://127.0.0.1:9999", fetchImpl);
    const poll = await api.devicePoll("device-code-secret-0000000000000000000001");
    expect(poll.status).toBe("slow_down");
    expect(poll.retryAfterMs).toBe(15_000);
  });

  it("prefers the body retryAfterMs over the header", async () => {
    const { fetchImpl } = fakeFetch(() => ({ status: 429, body: { status: "slow_down", retryAfterMs: 12_345 }, headers: { "retry-after": "60" } }));
    const api = createAlphaApi("http://127.0.0.1:9999", fetchImpl);
    const poll = await api.devicePoll("device-code-secret-0000000000000000000001");
    expect(poll.retryAfterMs).toBe(12_345);
  });

  it("refuses an exchanged poll without a usable token", async () => {
    const { fetchImpl } = fakeFetch(() => ({ status: 200, body: { status: "exchanged", credential: "nope" } }));
    const api = createAlphaApi("http://127.0.0.1:9999", fetchImpl);
    await expect(api.devicePoll("device-code-secret-0000000000000000000001")).rejects.toMatchObject({ code: "API_RESPONSE_INVALID" });
  });

  it("refuses a launch reply without a distinct split ticket pair", async () => {
    const base = { characterId: "char_a", expiresAt: 1, endpoints: { game: "https://game", chat: "" }, release: { client: "dev", server: "dev", shard: "open-desert" } };
    const same = fakeFetch(() => ({ status: 200, body: { ...base, gameTicket: "t1", chatTicket: "t1" } }));
    await expect(createAlphaApi("http://127.0.0.1:9999", same.fetchImpl).playTicket(CREDENTIAL, "char_a")).rejects.toMatchObject({ code: "API_RESPONSE_INVALID" });
    const missing = fakeFetch(() => ({ status: 200, body: { ...base, gameTicket: "t1" } }));
    await expect(createAlphaApi("http://127.0.0.1:9999", missing.fetchImpl).playTicket(CREDENTIAL, "char_a")).rejects.toMatchObject({ code: "API_RESPONSE_INVALID" });
  });

  it("maps auth and legal failures to typed codes", async () => {
    const unauthorized = fakeFetch(() => ({ status: 401, body: { error: "invalid_auth" } }));
    await expect(createAlphaApi("http://127.0.0.1:9999", unauthorized.fetchImpl).listCharacters(CREDENTIAL)).rejects.toMatchObject({ code: "AUTH_REJECTED" });
    const legal = fakeFetch(() => ({ status: 400, body: { error: "legal_required" } }));
    await expect(createAlphaApi("http://127.0.0.1:9999", legal.fetchImpl).playTicket(CREDENTIAL, "char_a")).rejects.toMatchObject({ code: "LEGAL_REQUIRED" });
  });

  it("treats logout as settled on 204, 404, and 401", async () => {
    for (const [status, expected] of [[204, "revoked"], [404, "unsupported"], [401, "revoked"]] as const) {
      const { fetchImpl, calls } = fakeFetch(() => ({ status, ...(status === 204 ? {} : { body: { error: "x" } }) }));
      const api = createAlphaApi("http://127.0.0.1:9999", fetchImpl);
      expect(await api.deviceLogout(CREDENTIAL)).toBe(expected);
      expect(calls[0]!.url).toBe("http://127.0.0.1:9999/alpha-api/device/logout");
    }
  });
});
