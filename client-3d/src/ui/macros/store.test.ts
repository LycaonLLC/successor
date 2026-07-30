import { afterEach, describe, expect, it, vi } from "vitest";

import {
  adoptMacroPayload,
  configureMacroStore,
  createParentMacroDataPort,
  deleteMacro,
  macroCaps,
  macroAppliedGeneration,
  macroPayloadEtag,
  macroPreviewLine,
  macroStoreStatus,
  macros,
  normalizeMacroName,
  refreshMacros,
  resetMacroStoreForTest,
  saveMacro,
  slugMacroId,
  type MacroDataPort,
} from "./store";

type FetchCall = { url: string; method: string; body: unknown; headers?: Record<string, string> };

function stubFetch(
  responder: (call: FetchCall) => { status: number; json: unknown },
): { impl: typeof fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    if (init?.headers && typeof init.headers === "object" && !Array.isArray(init.headers)) {
      for (const [key, value] of Object.entries(init.headers as Record<string, string>)) {
        headers[key.toLowerCase()] = value;
      }
    }
    const call: FetchCall = {
      url: String(input),
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
      headers,
    };
    calls.push(call);
    const { status, json } = responder(call);
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => json,
    } as Response;
  }) as typeof fetch;
  return { impl, calls };
}

function serverPayload(items: unknown[], extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: "successor.macros.v1",
    characterId: "char_1",
    recordKind: "successor.macros.v1",
    record: { version: 1, items },
    etag: typeof extra.etag === "string" ? extra.etag : `etag-${items.length}`,
    caps: { maxItems: 64, maxBodyBytes: 8192, maxNameCharacters: 48, maxIconIdCharacters: 64 },
    macros: items,
    ...extra,
  };
}

const savedRow = {
  id: "heal_self",
  name: "Heal Self",
  iconId: "macro:command",
  body: "/target self\n/pause 1",
  createdAt: "2026-07-08T00:00:00.000Z",
  updatedAt: "2026-07-08T00:00:00.000Z",
};

afterEach(() => {
  resetMacroStoreForTest();
});

describe("macro store pure helpers", () => {
  it("slugs ids into the server pattern and dodges collisions", () => {
    expect(slugMacroId("Heal Self!", [])).toBe("heal_self");
    expect(slugMacroId("Heal Self", ["heal_self"])).toBe("heal_self_2");
    expect(slugMacroId("Heal Self", ["heal_self", "heal_self_2"])).toBe("heal_self_3");
    // Non-alphanumeric head gets a stable prefix (server: ^[A-Za-z0-9]…).
    expect(slugMacroId("__grind", [])).toMatch(/^[a-z0-9]/u);
    expect(slugMacroId("", [])).toBe("macro");
  });

  it("previews the first non-comment line and truncates long ones", () => {
    expect(macroPreviewLine("# banner\n\n/attack $target; /pause 1\n/loop 3")).toBe("/attack $target; /pause 1");
    expect(macroPreviewLine("#only comments\n \n")).toBe("(empty)");
    const long = `/say ${"x".repeat(90)}`;
    expect(macroPreviewLine(long)).toHaveLength(72);
    expect(macroPreviewLine(long).endsWith("…")).toBe(true);
  });

  it("normalizes names: collapse whitespace, strip control chars, cap length", () => {
    expect(normalizeMacroName("  Heal   Self \u0007")).toBe("Heal Self");
    expect(normalizeMacroName("x".repeat(80))).toHaveLength(48);
  });
});

describe("macro store record-kind sync", () => {
  it("seeds synchronously from the join-payload record kind", () => {
    configureMacroStore({
      apiBase: "http://127.0.0.1:9",
      characterId: "char_1",
      seed: { version: 1, items: [savedRow, { bogus: true }], etag: "seed-etag-0001" },
    });
    expect(macros()).toHaveLength(1);
    expect(macros()[0]).toMatchObject({ id: "heal_self", name: "Heal Self" });
    expect(macroStoreStatus().phase).toBe("seeded");
    expect(macroPayloadEtag()).toBe("seed-etag-0001");
  });

  it("saves through POST and adopts the server's full payload + caps", async () => {
    const { impl, calls } = stubFetch(() => ({
      status: 200,
      json: serverPayload([savedRow], { macro: savedRow, etag: "after-save-etag" }),
    }));
    configureMacroStore({
      apiBase: "http://x/",
      characterId: "char_1",
      fetchImpl: impl,
      seed: { version: 1, items: [], etag: "empty-etag-0001" },
    });

    const result = await saveMacro({ name: "Heal Self", body: "/target self\n/pause 1" });
    expect(result.ok).toBe(true);
    expect(result.status).toBe("SAVED · HEAL SELF");
    expect(result.macro?.id).toBe("heal_self");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      url: "http://x/game/characters/char_1/macros",
      method: "POST",
      body: { id: "heal_self", name: "Heal Self", iconId: "macro:command", body: "/target self\n/pause 1" },
    });
    expect(calls[0]?.headers?.["if-match"]).toBe("empty-etag-0001");
    expect(macros()).toHaveLength(1);
    expect(macroCaps()).toEqual({ maxItems: 64, maxBodyBytes: 8192, maxNameCharacters: 48 });
    expect(macroStoreStatus().phase).toBe("synced");
    expect(macroPayloadEtag()).toBe("after-save-etag");
  });

  it("denies locally before any wire call: empty name, oversize body, duplicate name", async () => {
    const { impl, calls } = stubFetch(() => ({ status: 200, json: serverPayload([]) }));
    configureMacroStore({
      apiBase: "http://x",
      characterId: "char_1",
      seed: { version: 1, items: [savedRow], etag: "seed-etag" },
      fetchImpl: impl,
    });

    expect((await saveMacro({ name: "  ", body: "/x" })).reasonCode).toBe("invalid_macro");
    const oversize = await saveMacro({ name: "Big", body: "x".repeat(8193) });
    expect(oversize.reasonCode).toBe("macro_too_large");
    expect(oversize.status).toContain("8193 / 8192");
    const duplicate = await saveMacro({ name: "heal self", body: "/x" });
    expect(duplicate.reasonCode).toBe("invalid_macro");
    expect(duplicate.status).toContain("NAME TAKEN");
    expect(calls).toHaveLength(0);
  });

  it("maps server denies to reason codes + receipt copy (429 rate limit)", async () => {
    const { impl } = stubFetch(() => ({
      status: 429,
      json: { error: "macro_rate_limited", retryAfterMs: 4200 },
    }));
    configureMacroStore({
      apiBase: "http://x",
      characterId: "char_1",
      fetchImpl: impl,
      seed: { version: 1, items: [], etag: "empty-etag" },
    });

    const result = await saveMacro({ name: "Grind", body: "/pause 1" });
    expect(result.ok).toBe(false);
    expect(result.reasonCode).toBe("macro_rate_limited");
    expect(result.status).toBe("DENIED · RATE LIMITED — RETRY 5S");
    expect(macroStoreStatus().phase).toBe("denied");
  });

  it("deletes through DELETE and adopts the emptied payload", async () => {
    const { impl, calls } = stubFetch(() => ({
      status: 200,
      json: serverPayload([], { etag: "empty-after-delete" }),
    }));
    configureMacroStore({
      apiBase: "http://x",
      characterId: "char_1",
      seed: { version: 1, items: [savedRow], etag: "with-heal" },
      fetchImpl: impl,
    });

    const result = await deleteMacro("heal_self");
    expect(result.ok).toBe(true);
    expect(result.status).toBe("DELETED · HEAL SELF");
    expect(calls[0]).toMatchObject({
      url: "http://x/game/characters/char_1/macros/heal_self",
      method: "DELETE",
    });
    expect(calls[0]?.headers?.["if-match"]).toBe("with-heal");
    expect(macros()).toHaveLength(0);
    expect(macroPayloadEtag()).toBe("empty-after-delete");
  });

  it("surfaces transport failure as link_down without dropping the local list", async () => {
    const impl = (async () => {
      throw new Error("refused");
    }) as unknown as typeof fetch;
    configureMacroStore({
      apiBase: "http://x",
      characterId: "char_1",
      seed: { version: 1, items: [savedRow], etag: "seed" },
      fetchImpl: impl,
    });

    const result = await saveMacro({ id: "heal_self", name: "Heal Self", body: "/pause 2" });
    expect(result.reasonCode).toBe("link_down");
    expect(macroStoreStatus().phase).toBe("link_down");
    expect(macros()).toHaveLength(1);
  });

  it("replaces the full list on conflict refresh and keeps the current ETag", async () => {
    const current = {
      ...savedRow,
      body: "/target self\n/heal",
    };
    const port: MacroDataPort = {
      async list() {
        return serverPayload([current], { etag: "current-etag" });
      },
      async save() {
        return {
          ...serverPayload([current], { etag: "current-etag", error: "etag_mismatch" }),
          ok: false,
          status: 409,
        };
      },
      async delete() {
        return { ok: false, error: "etag_mismatch", status: 409 };
      },
    };
    configureMacroStore({
      characterId: "char_1",
      dataPort: port,
      seed: { version: 1, items: [savedRow], etag: "stale-etag" },
    });
    expect(macros()[0]?.body).toBe("/target self\n/pause 1");

    const result = await saveMacro({ id: "heal_self", name: "Heal Self", body: "/pause 9" });
    expect(result.ok).toBe(false);
    expect(result.reasonCode).toBe("etag_mismatch");
    expect(macros()).toHaveLength(1);
    expect(macros()[0]?.body).toBe("/target self\n/heal");
    expect(macroPayloadEtag()).toBe("current-etag");
    expect(macroStoreStatus().phase).toBe("synced");
  });

  it("uses the data port for full-list refresh and delete", async () => {
    const calls: string[] = [];
    const port: MacroDataPort = {
      async list() {
        calls.push("list");
        return serverPayload([savedRow], { etag: "list-etag" });
      },
      async save() {
        calls.push("save");
        return serverPayload([savedRow], { etag: "save-etag", macro: savedRow, ok: true });
      },
      async delete(input) {
        calls.push(`delete:${input.macroId}:${input.etag}`);
        return serverPayload([], { etag: "empty-etag", ok: true });
      },
    };
    configureMacroStore({ characterId: "char_1", dataPort: port });
    const refreshed = await refreshMacros();
    expect(refreshed.ok).toBe(true);
    expect(macros()).toHaveLength(1);
    expect(macroPayloadEtag()).toBe("list-etag");

    const deleted = await deleteMacro("heal_self");
    expect(deleted.ok).toBe(true);
    expect(calls).toEqual(["list", "delete:heal_self:list-etag"]);
    expect(macros()).toHaveLength(0);
    expect(macroPayloadEtag()).toBe("empty-etag");
  });
});

describe("parent macro data port generation ordering", () => {
  it("drops old unsolicited state seen during mutation even if delivered after success clears inFlight", async () => {
    const port = createParentMacroDataPort({
      characterId: "char_1",
      parentOrigin: "https://site.example",
      bindWindow: false,
      requestTimeoutMs: 5_000,
    });
    configureMacroStore({
      characterId: "char_1",
      dataPort: port,
      seed: {
        version: 1,
        items: [savedRow],
        etag: "etag-v1-aaaaaaaa",
      },
    });
    expect(macroPayloadEtag()).toBe("etag-v1-aaaaaaaa");
    expect(macroAppliedGeneration()).toBe(0);

    const savePromise = saveMacro({
      id: "heal_self",
      name: "Heal Self",
      body: "/target self\n/heal",
    });
    expect(port.__mutationInFlightForTest()).toBe(1);

    const staleState = {
      type: "successor.macros.state.v1",
      characterId: "char_1",
      version: 1,
      generation: 0,
      etag: "etag-stale-bbbbbb",
      caps: { maxItems: 64, maxBodyBytes: 8192, maxNameCharacters: 48 },
      macros: [{ ...savedRow, body: "/stale-pre-mutation" }],
    };
    port.__deliverForTest(staleState);
    expect(macros()[0]?.body).toBe("/target self\n/pause 1");
    expect(macroPayloadEtag()).toBe("etag-v1-aaaaaaaa");

    port.__deliverForTest({
      type: "successor.macros.result.v1",
      requestId: "m1",
      characterId: "char_1",
      ok: true,
      operation: "save",
      generation: 1,
      version: 1,
      etag: "etag-v2-cccccccc",
      caps: { maxItems: 64, maxBodyBytes: 8192, maxNameCharacters: 48 },
      macros: [{ ...savedRow, body: "/target self\n/heal" }],
      macro: { ...savedRow, body: "/target self\n/heal" },
    });
    const result = await savePromise;
    expect(result.ok).toBe(true);
    expect(macros()[0]?.body).toBe("/target self\n/heal");
    expect(macroPayloadEtag()).toBe("etag-v2-cccccccc");
    expect(macroAppliedGeneration()).toBe(1);
    expect(port.__mutationInFlightForTest()).toBe(0);

    // Late delivery of pre-mutation state after inFlight cleared — must not roll back.
    port.__deliverForTest(staleState);
    expect(macros()[0]?.body).toBe("/target self\n/heal");
    expect(macroPayloadEtag()).toBe("etag-v2-cccccccc");
    expect(macroAppliedGeneration()).toBe(1);

    // Fresh post-mutation state at generation >= applied is accepted.
    port.__deliverForTest({
      type: "successor.macros.state.v1",
      characterId: "char_1",
      version: 1,
      generation: 2,
      etag: "etag-v3-dddddddd",
      caps: { maxItems: 64, maxBodyBytes: 8192, maxNameCharacters: 48 },
      macros: [{ ...savedRow, body: "/target self\n/heal\n/pause 1" }],
    });
    expect(macroAppliedGeneration()).toBe(2);
    expect(macroPayloadEtag()).toBe("etag-v3-dddddddd");
    expect(macros()[0]?.body).toBe("/target self\n/heal\n/pause 1");
  });

  it("adoptMacroPayload rejects older generation unsolicited state without consulting ETag strings", () => {
    configureMacroStore({
      characterId: "char_1",
      seed: { version: 1, items: [savedRow], etag: "etag-hold" },
    });
    expect(
      adoptMacroPayload(
        { version: 1, items: [savedRow], macros: [savedRow], etag: "etag-hold", generation: 3 },
        { generation: 3 },
      ),
    ).toBe(true);
    expect(macroAppliedGeneration()).toBe(3);

    expect(
      adoptMacroPayload(
        {
          version: 1,
          items: [{ ...savedRow, body: "/old" }],
          macros: [{ ...savedRow, body: "/old" }],
          etag: "etag-old-zzzzzzzz",
          generation: 2,
        },
        { unsolicited: true, generation: 2 },
      ),
    ).toBe(false);
    expect(macroPayloadEtag()).toBe("etag-hold");
    expect(macros()[0]?.body).toBe("/target self\n/pause 1");
  });
});

describe("parent macro data port malformed-commit watermark", () => {
  it("advances appliedGeneration on correlated ok:false macros_unavailable so delayed gen-0 state cannot roll back", async () => {
    const port = createParentMacroDataPort({
      characterId: "char_1",
      parentOrigin: "https://site.example",
      bindWindow: false,
      requestTimeoutMs: 5_000,
    });
    configureMacroStore({
      characterId: "char_1",
      dataPort: port,
      seed: {
        version: 1,
        items: [savedRow],
        etag: "etag-v1-aaaaaaaa",
      },
    });
    expect(macroAppliedGeneration()).toBe(0);
    expect(macros()[0]?.body).toBe("/target self\n/pause 1");

    const savePromise = saveMacro({
      id: "heal_self",
      name: "Heal Self",
      body: "/target self\n/heal",
    });
    expect(port.__mutationInFlightForTest()).toBe(1);

    const stalePreWrite = {
      type: "successor.macros.state.v1",
      characterId: "char_1",
      version: 1,
      generation: 0,
      etag: "etag-stale-bbbbbb",
      caps: { maxItems: 64, maxBodyBytes: 8192, maxNameCharacters: 48 },
      macros: [{ ...savedRow, body: "/stale-pre-mutation" }],
    };
    port.__deliverForTest(stalePreWrite);

    // Durable write committed but payload unprojectable — watermark must still rise.
    port.__deliverForTest({
      type: "successor.macros.result.v1",
      requestId: "m1",
      characterId: "char_1",
      ok: false,
      operation: "save",
      error: "macros_unavailable",
      generation: 1,
    });

    const result = await savePromise;
    expect(result.ok).toBe(false);
    expect(result.reasonCode).toBe("macros_unavailable");
    expect(macroAppliedGeneration()).toBe(1);
    // Local library unchanged (no projected payload) but watermark advanced.
    expect(macros()[0]?.body).toBe("/target self\n/pause 1");
    expect(macroPayloadEtag()).toBe("etag-v1-aaaaaaaa");
    expect(port.__mutationInFlightForTest()).toBe(0);

    // Delayed gen-0 pre-mutation state after inFlight clears — must not roll back.
    port.__deliverForTest(stalePreWrite);
    expect(macros()[0]?.body).toBe("/target self\n/pause 1");
    expect(macroPayloadEtag()).toBe("etag-v1-aaaaaaaa");
    expect(macroAppliedGeneration()).toBe(1);

    // Fresh higher-generation recovery state is still accepted.
    port.__deliverForTest({
      type: "successor.macros.state.v1",
      characterId: "char_1",
      version: 1,
      generation: 2,
      etag: "etag-v2-recovered",
      caps: { maxItems: 64, maxBodyBytes: 8192, maxNameCharacters: 48 },
      macros: [{ ...savedRow, body: "/recovered" }],
    });
    expect(macroAppliedGeneration()).toBe(2);
    expect(macroPayloadEtag()).toBe("etag-v2-recovered");
    expect(macros()[0]?.body).toBe("/recovered");
  });

  it("does not advance watermark on ordinary same-generation mutation failure", async () => {
    const port = createParentMacroDataPort({
      characterId: "char_1",
      parentOrigin: "https://site.example",
      bindWindow: false,
      requestTimeoutMs: 5_000,
    });
    configureMacroStore({
      characterId: "char_1",
      dataPort: port,
      seed: {
        version: 1,
        items: [savedRow],
        etag: "etag-v1-aaaaaaaa",
      },
    });
    // Establish watermark at 1 via prior solicited success projection.
    expect(
      adoptMacroPayload(
        {
          version: 1,
          items: [savedRow],
          macros: [savedRow],
          etag: "etag-v1-aaaaaaaa",
          generation: 1,
        },
        { generation: 1 },
      ),
    ).toBe(true);
    expect(macroAppliedGeneration()).toBe(1);

    const savePromise = saveMacro({
      id: "heal_self",
      name: "Heal Self",
      body: "/x",
    });
    port.__deliverForTest({
      type: "successor.macros.result.v1",
      requestId: "m1",
      characterId: "char_1",
      ok: false,
      operation: "save",
      error: "invalid_macro",
      generation: 1,
    });
    const result = await savePromise;
    expect(result.ok).toBe(false);
    expect(result.reasonCode).toBe("invalid_macro");
    expect(macroAppliedGeneration()).toBe(1);
  });
});
