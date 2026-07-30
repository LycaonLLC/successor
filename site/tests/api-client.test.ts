import { beforeEach, describe, expect, it, vi } from "vitest";
import { api, resetClientStateForTests } from "../src/api/client";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

function initAt(fetchMock: ReturnType<typeof vi.fn<typeof fetch>>, index: number): RequestInit {
  return fetchMock.mock.calls[index]?.[1] as RequestInit;
}

function headersAt(fetchMock: ReturnType<typeof vi.fn<typeof fetch>>, index: number): Record<string, string> {
  return initAt(fetchMock, index).headers as Record<string, string>;
}

describe("alpha-api client", () => {
  beforeEach(() => {
    resetClientStateForTests();
    vi.restoreAllMocks();
  });

  it("matches every browser account route's method, path, headers, and payload", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      // register (CSRF + mutation; rotating)
      .mockResolvedValueOnce(json({ csrfToken: "register-token", authenticated: false }))
      .mockResolvedValueOnce(json({ callsign: "wolf", setup: { characterCount: 0, maxCharacters: 5 } }, 201))
      // login (CSRF + mutation; rotating)
      .mockResolvedValueOnce(json({ csrfToken: "login-token", authenticated: false }))
      .mockResolvedValueOnce(json({ callsign: "wolf", setup: { characterCount: 0, maxCharacters: 5 } }))
      // logout (CSRF + mutation; rotating)
      .mockResolvedValueOnce(json({ csrfToken: "logout-token", authenticated: true }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      // create character (CSRF + mutation; reuses token afterward)
      .mockResolvedValueOnce(json({ csrfToken: "create-token", authenticated: true }))
      .mockResolvedValueOnce(json({ id: "char-1", name: "Rook", initialProfessionId: "scout", worldEntryClaimed: false }, 201))
      // play ticket (reuses token)
      .mockResolvedValueOnce(json({ gameTicket: "game", chatTicket: "chat", characterId: "char-1", expiresAt: 1, endpoints: { game: "", chat: "" }, release: { client: "client", server: "server", shard: "shard" } }))
      // device decision (reuses token; 204)
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      // device list (GET)
      .mockResolvedValueOnce(json({ devices: [] }))
      // device revoke (DELETE; reuses token)
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      // account deletion (DELETE; rotating)
      .mockResolvedValueOnce(json({ status: "pending_deletion" }, 202));
    vi.stubGlobal("fetch", fetchMock);

    await api.register({
      callsign: "wolf",
      password: "long-enough-pw",
      legal: { terms: "2026-07-24", privacy: "2026-07-24" },
    });
    await api.login({ callsign: "wolf", password: "long-enough-pw" });
    await api.logout();
    await api.createCharacter({
      name: "Rook",
      initialProfessionId: "scout",
      appearance: { skinTone: "#c78f62", hair: "hair_mop", hairMat: "hair_raven", face: null },
    });
    const ticket = await api.playTicket("char-1");
    expect(ticket.ok).toBe(true);
    if (ticket.ok) expect(ticket.value.schema).toBe("successor.launch-context.v1");
    await api.deviceDecision("ABCD1234", "approved");
    await api.deviceList();
    await api.deviceRevoke("device/one");
    await api.deleteAccount("long-enough-pw");

    expect(fetchMock).toHaveBeenCalledTimes(13);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/alpha-api/csrf");
    expect(initAt(fetchMock, 0).method).toBe("GET");
    expect(initAt(fetchMock, 0).credentials).toBe("same-origin");
    expect(initAt(fetchMock, 0).cache).toBe("no-store");
    expect(headersAt(fetchMock, 0).accept).toBe("application/json");

    expect(fetchMock.mock.calls[1]?.[0]).toBe("/alpha-api/register");
    expect(initAt(fetchMock, 1).method).toBe("POST");
    expect(headersAt(fetchMock, 1)["x-csrf-token"]).toBe("register-token");
    expect(headersAt(fetchMock, 1)["x-successor-csrf"]).toBeUndefined();
    expect(initAt(fetchMock, 1).body).toBe(JSON.stringify({
      callsign: "wolf",
      password: "long-enough-pw",
      legal: { terms: "2026-07-24", privacy: "2026-07-24" },
    }));

    expect(fetchMock.mock.calls[2]?.[0]).toBe("/alpha-api/csrf");
    expect(fetchMock.mock.calls[3]?.[0]).toBe("/alpha-api/login");
    expect(initAt(fetchMock, 3).method).toBe("POST");
    expect(headersAt(fetchMock, 3)["x-csrf-token"]).toBe("login-token");
    expect(initAt(fetchMock, 3).body).toBe(JSON.stringify({ callsign: "wolf", password: "long-enough-pw" }));

    expect(fetchMock.mock.calls[4]?.[0]).toBe("/alpha-api/csrf");
    expect(fetchMock.mock.calls[5]?.[0]).toBe("/alpha-api/logout");
    expect(initAt(fetchMock, 5).method).toBe("POST");
    expect(headersAt(fetchMock, 5)["x-csrf-token"]).toBe("logout-token");
    expect(initAt(fetchMock, 5).body).toBe("{}");

    expect(fetchMock.mock.calls[6]?.[0]).toBe("/alpha-api/csrf");
    expect(fetchMock.mock.calls[7]?.[0]).toBe("/alpha-api/characters");
    expect(initAt(fetchMock, 7).method).toBe("POST");
    expect(initAt(fetchMock, 7).body).toBe(JSON.stringify({
      name: "Rook",
      initialProfessionId: "scout",
      appearance: { skinTone: "#c78f62", hair: "hair_mop", hairMat: "hair_raven", face: null },
    }));

    expect(fetchMock.mock.calls[8]?.[0]).toBe("/alpha-api/play-ticket");
    expect(initAt(fetchMock, 8).method).toBe("POST");
    expect(initAt(fetchMock, 8).body).toBe(JSON.stringify({ characterId: "char-1" }));

    expect(fetchMock.mock.calls[9]?.[0]).toBe("/alpha-api/device/decision");
    expect(initAt(fetchMock, 9).method).toBe("POST");
    expect(initAt(fetchMock, 9).body).toBe(JSON.stringify({ userCode: "ABCD1234", decision: "approve" }));

    expect(fetchMock.mock.calls[10]?.[0]).toBe("/alpha-api/devices");
    expect(initAt(fetchMock, 10).method).toBe("GET");
    expect(initAt(fetchMock, 10).body).toBeUndefined();

    expect(fetchMock.mock.calls[11]?.[0]).toBe("/alpha-api/devices/device%2Fone");
    expect(initAt(fetchMock, 11).method).toBe("DELETE");
    expect(headersAt(fetchMock, 11)["x-csrf-token"]).toBe("create-token");
    expect(initAt(fetchMock, 11).body).toBeUndefined();

    expect(fetchMock.mock.calls[12]?.[0]).toBe("/alpha-api/account");
    expect(initAt(fetchMock, 12).method).toBe("DELETE");
    expect(headersAt(fetchMock, 12)["x-csrf-token"]).toBe("create-token");
    expect(initAt(fetchMock, 12).body).toBe(JSON.stringify({ password: "long-enough-pw" }));
    for (const call of fetchMock.mock.calls) {
      expect((call[1] as RequestInit).credentials).toBe("same-origin");
      expect((call[1] as RequestInit).cache).toBe("no-store");
    }
  });

  it("seeds the server csrfToken field and retries once with a fresh token after CSRF rejection", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json({ csrfToken: "stale", authenticated: true }))
      .mockResolvedValueOnce(json({ error: "csrf_mismatch" }, 403))
      .mockResolvedValueOnce(json({ csrfToken: "fresh", authenticated: true }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await api.deviceDecision("ABCD1234", "approved");
    expect(result.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(headersAt(fetchMock, 1)["x-csrf-token"]).toBe("stale");
    expect(headersAt(fetchMock, 3)["x-csrf-token"]).toBe("fresh");
  });

  it("retries once after a stale session response, then stops", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json({ csrfToken: "stale", authenticated: true }))
      .mockResolvedValueOnce(json({ error: "invalid_session" }, 401))
      .mockResolvedValueOnce(json({ csrfToken: "fresh", authenticated: false }))
      .mockResolvedValueOnce(json({ error: "invalid_session" }, 401));
    vi.stubGlobal("fetch", fetchMock);

    const result = await api.deviceDecision("ABCD1234", "approved");
    expect(result.ok).toBe(false);
    if (!result.ok && result.error.kind === "rejected") expect(result.error.code).toBe("invalid_session");
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("keeps known not-found responses rejected with actionable messages", async () => {
    for (const [code, message] of [["device_not_found", "That device is no longer available."], ["character_not_found", "That character is no longer available."]] as const) {
      vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(json({ error: code }, 404)));
      const result = await api.session();
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe("rejected");
        if (result.error.kind === "rejected") expect(result.error.message).toBe(message);
      }
    }
  });

  it("maps server string error codes to actionable messages without exposing codes", async () => {
    const cases = [
      ["invalid_session", "Your session expired. Sign in again."],
      ["invalid_credentials", "Callsign or password did not match."],
      ["login_failed", "Callsign or password did not match."],
      ["callsign_taken", "That callsign is already in use."],
      ["registration_cap", "Registration is currently full. Please try again later."],
      ["rate_limited", "Too many attempts. Please wait a moment and try again."],
      ["invalid_name", "Use 3–16 letters with optional internal hyphens."],
      ["name_taken", "That character name is already in use."],
      ["slots_full", "All character slots are full."],
    ] as const;
    for (const [code, message] of cases) {
      const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(json({ error: code }, 409));
      vi.stubGlobal("fetch", fetchMock);
      const result = await api.session();
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe("rejected");
        if (result.error.kind === "rejected") {
          expect(result.error.code).toBe(code);
          expect(result.error.message).toBe(message);
          expect(result.error.message).not.toContain(code);
        }
      }
    }
  });

  it("maps network failure and 5xx to unavailable while preserving 404 errors", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockRejectedValue(new TypeError("down")));
    const offline = await api.session();
    expect(offline.ok).toBe(false);
    if (!offline.ok) {
      expect(offline.error.kind).toBe("unavailable");
      expect(offline.error.message).toContain("not reachable");
    }

    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(json({}, 503)));
    const down = await api.session();
    expect(down.ok).toBe(false);
    if (!down.ok) expect(down.error.kind).toBe("unavailable");

    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(new Response("", { status: 404 })));
    const missing = await api.session();
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error.kind).toBe("rejected");
  });

  it("never touches web storage or document.cookie", async () => {
    const setItem = vi.spyOn(window.localStorage, "setItem");
    const getItem = vi.spyOn(window.localStorage, "getItem");
    const sessionSet = vi.spyOn(window.sessionStorage, "setItem");
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json({ csrfToken: "tok", authenticated: false }))
      .mockResolvedValueOnce(json({ callsign: "wolf", setup: { characterCount: 0, maxCharacters: 5 } }));
    vi.stubGlobal("fetch", fetchMock);

    await api.login({ callsign: "wolf", password: "long-enough-pw" });

    expect(setItem).not.toHaveBeenCalled();
    expect(getItem).not.toHaveBeenCalled();
    expect(sessionSet).not.toHaveBeenCalled();
    expect(document.cookie).toBe("");
  });

  it("keeps credential hygiene in source: no storage APIs anywhere in src/", async () => {
    const { readdirSync, readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const srcDir = join(process.cwd(), "src");
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
        entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)],
      );
    // Sole ruled exception: the creator handoff stores one opaque
    // character id under a versioned sessionStorage key, consumed for direct
    // entry and cleared by /play/ in one visit. Tickets, tokens, and cookies stay
    // banned there like everywhere else (asserted below).
    const handoff = join(srcDir, "features", "characterHandoff.ts");
    for (const file of walk(srcDir).filter((f) => f.endsWith(".ts"))) {
      const source = readFileSync(file, "utf8");
      if (file === handoff) {
        expect(source, file).not.toMatch(/localStorage|document\.cookie/);
        expect(source, file).not.toMatch(/ticket|token|csrf|password/i);
        continue;
      }
      expect(source, file).not.toMatch(/localStorage|sessionStorage|document\.cookie/);
    }
  });
});
