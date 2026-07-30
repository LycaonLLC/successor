import { beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";

import type { Api } from "../src/api/client";
import {
  MACRO_PORT_DELETE_TYPE,
  MACRO_PORT_LIST_TYPE,
  MACRO_PORT_READY_TYPE,
  MACRO_PORT_RESULT_TYPE,
  MACRO_PORT_SAVE_TYPE,
  MACRO_PORT_STATE_TYPE,
  attachMacroPortBridge,
  parseMacroPortDelete,
  parseMacroPortList,
  parseMacroPortReady,
  parseMacroPortSave,
  publicMacroResultMessage,
  publicMacroStateMessage,
  assertSecretFreeMacroMessage,
  safeMacroPayload,
} from "../src/features/macros";

const ORIGIN = "https://client.example";
const CHARACTER_ID = "char_atlas";

const PAYLOAD = {
  schema: "successor.macros.v1",
  characterId: CHARACTER_ID,
  version: 1,
  etag: "a".repeat(64),
  caps: { maxItems: 64, maxBodyBytes: 8192, maxNameCharacters: 48, maxIconIdCharacters: 64 },
  macros: [
    {
      id: "heal_self",
      name: "Heal Self",
      iconId: "macro:command",
      body: "/heal",
      createdAt: "2026-07-08T00:00:00.000Z",
      updatedAt: "2026-07-08T00:00:00.000Z",
    },
  ],
  record: {
    version: 1,
    items: [
      {
        id: "heal_self",
        name: "Heal Self",
        iconId: "macro:command",
        body: "/heal",
        createdAt: "2026-07-08T00:00:00.000Z",
        updatedAt: "2026-07-08T00:00:00.000Z",
      },
    ],
  },
};

function makeApi(overrides: Partial<Api> = {}): Api {
  return {
    listMacros: vi.fn(async () => ({ ok: true as const, value: PAYLOAD })),
    saveMacro: vi.fn(async () => ({ ok: true as const, value: { ...PAYLOAD, macro: PAYLOAD.macros[0] } })),
    deleteMacro: vi.fn(async () => ({
      ok: true as const,
      value: {
        ...PAYLOAD,
        macros: [],
        record: { version: 1, items: [] },
        etag: "b".repeat(64),
      },
    })),
    ...overrides,
  } as unknown as Api;
}

type FrameHandle = {
  iframe: HTMLIFrameElement;
  contentWindow: Window;
  postMessage: MockInstance<Window["postMessage"]>;
};

/** Local fake frame window: exact source identity, no network navigation. */
function mountFrame(): FrameHandle {
  document.body.innerHTML = "";
  const iframe = document.createElement("iframe");
  document.body.append(iframe);

  const postMessage = vi.fn<Window["postMessage"]>(() => undefined) as unknown as MockInstance<
    Window["postMessage"]
  >;
  // Minimal MessageEventSource stand-in. Production only compares reference equality
  // against iframe.contentWindow and calls postMessage(payload, targetOrigin).
  const contentWindow = { postMessage } as unknown as Window;
  Object.defineProperty(iframe, "contentWindow", {
    configurable: true,
    value: contentWindow,
  });

  return { iframe, contentWindow, postMessage };
}

function post(
  frame: FrameHandle | HTMLIFrameElement,
  data: unknown,
  origin = ORIGIN,
  source: MessageEventSource | null | undefined = undefined,
): void {
  const iframe = "iframe" in frame ? frame.iframe : frame;
  const contentWindow =
    "contentWindow" in frame && !(frame instanceof HTMLIFrameElement)
      ? frame.contentWindow
      : iframe.contentWindow;
  window.dispatchEvent(
    new MessageEvent("message", {
      data,
      origin,
      source: source === undefined ? contentWindow : source,
    }),
  );
}

function sent(spy: MockInstance<Window["postMessage"]>, type: string): unknown[] {
  return spy.mock.calls
    .map((call) => call[0])
    .filter((message): message is Record<string, unknown> =>
      Boolean(message && typeof message === "object" && (message as { type?: string }).type === type),
    );
}

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("macro port message parsers", () => {
  it("accepts only character-bound ready/list/save/delete shapes", () => {
    expect(parseMacroPortReady({ type: MACRO_PORT_READY_TYPE, characterId: CHARACTER_ID })).toEqual({
      characterId: CHARACTER_ID,
    });
    expect(parseMacroPortReady({ type: MACRO_PORT_READY_TYPE, characterId: "BAD ID" })).toBeNull();
    expect(parseMacroPortList({ type: MACRO_PORT_LIST_TYPE, requestId: "r1", characterId: CHARACTER_ID })).toEqual({
      requestId: "r1",
      characterId: CHARACTER_ID,
    });
    expect(
      parseMacroPortSave({
        type: MACRO_PORT_SAVE_TYPE,
        requestId: "r2",
        characterId: CHARACTER_ID,
        etag: "a".repeat(64),
        macro: { id: "heal_self", name: "Heal", iconId: "macro:x", body: "/heal" },
      }),
    ).toMatchObject({ requestId: "r2", macro: { id: "heal_self" } });
    expect(
      parseMacroPortDelete({
        type: MACRO_PORT_DELETE_TYPE,
        requestId: "r3",
        characterId: CHARACTER_ID,
        etag: "a".repeat(64),
        macroId: "heal_self",
      }),
    ).toMatchObject({ macroId: "heal_self" });
  });

  it("builds secret-free state/result messages", () => {
    const payload = safeMacroPayload(PAYLOAD);
    expect(payload).not.toBeNull();
    if (!payload) throw new Error("payload");
    const state = publicMacroStateMessage(CHARACTER_ID, payload, "corr-1");
    expect(state).toEqual({
      type: MACRO_PORT_STATE_TYPE,
      characterId: CHARACTER_ID,
      etag: payload.etag,
      version: 1,
      caps: payload.caps,
      macros: payload.items,
      correlationId: "corr-1",
    });
    expect(JSON.stringify(state)).not.toMatch(/csrf|ownerRef|accountId|cookie|password/iu);

    const result = publicMacroResultMessage({
      requestId: "r1",
      characterId: CHARACTER_ID,
      ok: true,
      operation: "list",
      payload,
    });
    expect(result.type).toBe(MACRO_PORT_RESULT_TYPE);
    expect(JSON.stringify(result)).not.toMatch(/csrf|ownerRef|accountId|cookie|password/iu);
  });
});

describe("macro port bridge binding", () => {
  it("ignores wrong origin, wrong source, and wrong character id", async () => {
    const { iframe, postMessage } = mountFrame();
    const api = makeApi();
    const bridge = attachMacroPortBridge({
      api,
      iframe,
      clientOrigin: ORIGIN,
      characterId: CHARACTER_ID,
    });
    post(iframe, { type: MACRO_PORT_READY_TYPE, characterId: CHARACTER_ID }, "https://evil.example");
    post(iframe, { type: MACRO_PORT_READY_TYPE, characterId: CHARACTER_ID }, ORIGIN, window);
    post(iframe, { type: MACRO_PORT_READY_TYPE, characterId: "char_other" }, ORIGIN);
    await Promise.resolve();
    expect(api.listMacros).not.toHaveBeenCalled();
    expect(postMessage).not.toHaveBeenCalled();
    bridge.dispose();
  });

  it("pushes full-list state on ready and after list/save/delete", async () => {
    const { iframe, postMessage } = mountFrame();
    const api = makeApi();
    const bridge = attachMacroPortBridge({
      api,
      iframe,
      clientOrigin: ORIGIN,
      characterId: CHARACTER_ID,
    });

    post(iframe, { type: MACRO_PORT_READY_TYPE, characterId: CHARACTER_ID });
    await vi.waitFor(() => expect(postMessage).toHaveBeenCalled());
    expect(sent(postMessage, MACRO_PORT_STATE_TYPE)[0]).toMatchObject({
      type: MACRO_PORT_STATE_TYPE,
      characterId: CHARACTER_ID,
      etag: "a".repeat(64),
      macros: [expect.objectContaining({ id: "heal_self" })],
    });

    postMessage.mockClear();
    post(iframe, { type: MACRO_PORT_LIST_TYPE, requestId: "list-1", characterId: CHARACTER_ID });
    await vi.waitFor(() => expect(sent(postMessage, MACRO_PORT_RESULT_TYPE).length).toBe(1));
    expect(sent(postMessage, MACRO_PORT_RESULT_TYPE)[0]).toMatchObject({
      requestId: "list-1",
      ok: true,
      operation: "list",
    });
    expect(sent(postMessage, MACRO_PORT_STATE_TYPE)).toHaveLength(1);

    postMessage.mockClear();
    post(iframe, {
      type: MACRO_PORT_SAVE_TYPE,
      requestId: "save-1",
      characterId: CHARACTER_ID,
      etag: "a".repeat(64),
      macro: { id: "heal_self", name: "Heal Self", iconId: "macro:command", body: "/heal" },
    });
    await vi.waitFor(() => expect(api.saveMacro).toHaveBeenCalled());
    expect(api.saveMacro).toHaveBeenCalledWith(
      CHARACTER_ID,
      { id: "heal_self", name: "Heal Self", iconId: "macro:command", body: "/heal" },
      "a".repeat(64),
    );
    expect(sent(postMessage, MACRO_PORT_RESULT_TYPE)[0]).toMatchObject({ ok: true, operation: "save" });

    postMessage.mockClear();
    post(iframe, {
      type: MACRO_PORT_DELETE_TYPE,
      requestId: "del-1",
      characterId: CHARACTER_ID,
      etag: "a".repeat(64),
      macroId: "heal_self",
    });
    await vi.waitFor(() => expect(api.deleteMacro).toHaveBeenCalled());
    expect(api.deleteMacro).toHaveBeenCalledWith(CHARACTER_ID, "heal_self", "a".repeat(64));
    expect(sent(postMessage, MACRO_PORT_RESULT_TYPE)[0]).toMatchObject({ ok: true, operation: "delete" });

    // No secrets on the wire.
    for (const call of postMessage.mock.calls) {
      expect(JSON.stringify(call[0])).not.toMatch(/csrf|ownerRef|accountId|cookie|password/iu);
      expect(call[1]).toBe(ORIGIN);
    }
    bridge.dispose();
  });
});

describe("macro port secret-free structural guard", () => {
  it("allows player-authored name/body text containing password/cookie words", () => {
    const payload = safeMacroPayload({
      ...PAYLOAD,
      macros: [
        {
          id: "pwd_check",
          name: "password cookie drill",
          iconId: "macro:command",
          body: "/say never paste password or cookie here\n/pause 1",
          createdAt: "2026-07-08T00:00:00.000Z",
          updatedAt: "2026-07-08T00:00:00.000Z",
        },
      ],
      record: {
        version: 1,
        items: [
          {
            id: "pwd_check",
            name: "password cookie drill",
            iconId: "macro:command",
            body: "/say never paste password or cookie here\n/pause 1",
            createdAt: "2026-07-08T00:00:00.000Z",
            updatedAt: "2026-07-08T00:00:00.000Z",
          },
        ],
      },
    });
    expect(payload).not.toBeNull();
    if (!payload) throw new Error("payload");
    const state = publicMacroStateMessage(CHARACTER_ID, payload);
    expect(() => assertSecretFreeMacroMessage(state)).not.toThrow();
    expect(JSON.stringify(state)).toContain("password cookie drill");
    const result = publicMacroResultMessage({
      requestId: "save-pwd",
      characterId: CHARACTER_ID,
      ok: true,
      operation: "save",
      payload,
      macro: payload.items[0] ?? null,
    });
    expect(() => assertSecretFreeMacroMessage(result)).not.toThrow();
  });

  it("rejects secret-bearing structural keys even without scanning text", () => {
    expect(() =>
      assertSecretFreeMacroMessage({
        type: MACRO_PORT_STATE_TYPE,
        characterId: CHARACTER_ID,
        etag: "a".repeat(64),
        version: 1,
        caps: PAYLOAD.caps,
        macros: [],
        ownerRef: "acct-nope",
      }),
    ).toThrow(/secret field|non-allowlisted/i);
    expect(() =>
      assertSecretFreeMacroMessage({
        type: MACRO_PORT_RESULT_TYPE,
        requestId: "r1",
        characterId: CHARACTER_ID,
        ok: true,
        operation: "save",
        csrfToken: "leak",
      }),
    ).toThrow(/secret field|non-allowlisted/i);
  });
});

describe("macro port committed-write responses", () => {
  it("posts ok:false macros_unavailable when save body cannot be safely projected", async () => {
    const { iframe, postMessage } = mountFrame();
    const api = makeApi({
      saveMacro: vi.fn(async () => ({
        ok: true as const,
        // Missing etag/caps/macros → safeMacroPayload null
        value: { schema: "successor.macros.v1", garbage: true } as never,
      })),
    });
    const bridge = attachMacroPortBridge({
      api,
      iframe,
      clientOrigin: ORIGIN,
      characterId: CHARACTER_ID,
    });
    post(iframe, {
      type: MACRO_PORT_SAVE_TYPE,
      requestId: "save-bad",
      characterId: CHARACTER_ID,
      etag: "a".repeat(64),
      macro: { id: "heal_self", name: "Heal Self", iconId: "macro:command", body: "/heal" },
    });
    await vi.waitFor(() => expect(api.saveMacro).toHaveBeenCalled());
    await vi.waitFor(() => expect(sent(postMessage, MACRO_PORT_RESULT_TYPE).length).toBe(1));
    expect(sent(postMessage, MACRO_PORT_RESULT_TYPE)[0]).toEqual({
      type: MACRO_PORT_RESULT_TYPE,
      requestId: "save-bad",
      characterId: CHARACTER_ID,
      ok: false,
      operation: "save",
      error: "macros_unavailable",
      generation: 1,
    });
    expect(sent(postMessage, MACRO_PORT_STATE_TYPE)).toHaveLength(0);
    bridge.dispose();
  });

  it("posts ok:false macros_unavailable when delete body cannot be safely projected", async () => {
    const { iframe, postMessage } = mountFrame();
    const api = makeApi({
      deleteMacro: vi.fn(async () => ({
        ok: true as const,
        value: { not: "a payload" } as never,
      })),
    });
    const bridge = attachMacroPortBridge({
      api,
      iframe,
      clientOrigin: ORIGIN,
      characterId: CHARACTER_ID,
    });
    post(iframe, {
      type: MACRO_PORT_DELETE_TYPE,
      requestId: "del-bad",
      characterId: CHARACTER_ID,
      etag: "a".repeat(64),
      macroId: "heal_self",
    });
    await vi.waitFor(() => expect(api.deleteMacro).toHaveBeenCalled());
    await vi.waitFor(() => expect(sent(postMessage, MACRO_PORT_RESULT_TYPE).length).toBe(1));
    expect(sent(postMessage, MACRO_PORT_RESULT_TYPE)[0]).toEqual({
      type: MACRO_PORT_RESULT_TYPE,
      requestId: "del-bad",
      characterId: CHARACTER_ID,
      ok: false,
      operation: "delete",
      error: "macros_unavailable",
      generation: 1,
    });
    expect(sent(postMessage, MACRO_PORT_STATE_TYPE)).toHaveLength(0);
    bridge.dispose();
  });

  it("still posts ok:true full replacement after a committed save with legal secret-like body text", async () => {
    const body = "/say check password policy\n/pause 1";
    const saved = {
      id: "policy",
      name: "Policy",
      iconId: "macro:command",
      body,
      createdAt: "2026-07-08T00:00:00.000Z",
      updatedAt: "2026-07-08T00:00:00.000Z",
    };
    const value = {
      ...PAYLOAD,
      etag: "c".repeat(64),
      macros: [saved],
      record: { version: 1, items: [saved] },
      macro: saved,
    };
    const { iframe, postMessage } = mountFrame();
    const api = makeApi({
      saveMacro: vi.fn(async () => ({ ok: true as const, value })),
    });
    const bridge = attachMacroPortBridge({
      api,
      iframe,
      clientOrigin: ORIGIN,
      characterId: CHARACTER_ID,
    });
    post(iframe, {
      type: MACRO_PORT_SAVE_TYPE,
      requestId: "save-ok",
      characterId: CHARACTER_ID,
      etag: "a".repeat(64),
      macro: { id: "policy", name: "Policy", iconId: "macro:command", body },
    });
    await vi.waitFor(() => expect(sent(postMessage, MACRO_PORT_RESULT_TYPE).length).toBe(1));
    const result = sent(postMessage, MACRO_PORT_RESULT_TYPE)[0] as Record<string, unknown>;
    expect(result).toMatchObject({ ok: true, operation: "save", requestId: "save-ok" });
    expect(JSON.stringify(result)).toContain("password");
    expect(JSON.stringify(result)).not.toMatch(/"ownerRef"|"csrfToken"|"accountId"/u);
    expect(sent(postMessage, MACRO_PORT_STATE_TYPE)).toHaveLength(1);
    bridge.dispose();
  });
});

describe("macro port malformed committed-write supersession", () => {
  it("malformed committed save still supersedes pre-write focus and never pushes state", async () => {
    let listResolvers: Array<(value: typeof PAYLOAD) => void> = [];
    const { iframe, postMessage } = mountFrame();
    const api = makeApi({
      listMacros: vi.fn<Api["listMacros"]>(
        () =>
          new Promise((resolve) => {
            listResolvers.push((value) => resolve({ ok: true as const, value }));
          }),
      ),
      saveMacro: vi.fn(async () => ({
        ok: true as const,
        value: { schema: "successor.macros.v1", garbage: true } as never,
      })),
    });
    const bridge = attachMacroPortBridge({
      api,
      iframe,
      clientOrigin: ORIGIN,
      characterId: CHARACTER_ID,
    });

    post(iframe, { type: MACRO_PORT_READY_TYPE, characterId: CHARACTER_ID });
    await vi.waitFor(() => expect(listResolvers.length).toBe(1));

    post(iframe, {
      type: MACRO_PORT_SAVE_TYPE,
      requestId: "save-malformed-race",
      characterId: CHARACTER_ID,
      etag: "a".repeat(64),
      macro: { id: "heal_self", name: "Heal Self", iconId: "macro:command", body: "/heal" },
    });
    await vi.waitFor(() => expect(api.saveMacro).toHaveBeenCalled());
    await vi.waitFor(() => expect(sent(postMessage, MACRO_PORT_RESULT_TYPE).length).toBe(1));
    expect(sent(postMessage, MACRO_PORT_RESULT_TYPE)[0]).toEqual({
      type: MACRO_PORT_RESULT_TYPE,
      requestId: "save-malformed-race",
      characterId: CHARACTER_ID,
      ok: false,
      operation: "save",
      error: "macros_unavailable",
      generation: 1,
    });
    expect(sent(postMessage, MACRO_PORT_STATE_TYPE)).toHaveLength(0);

    postMessage.mockClear();
    listResolvers[0]!({
      ...PAYLOAD,
      etag: "a".repeat(64),
      macros: [{ ...PAYLOAD.macros[0]!, body: "/stale-before-malformed-commit" }],
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(sent(postMessage, MACRO_PORT_STATE_TYPE)).toHaveLength(0);
    expect(sent(postMessage, MACRO_PORT_RESULT_TYPE)).toHaveLength(0);
    bridge.dispose();
  });

  it("malformed committed delete still supersedes pre-write focus and never pushes state", async () => {
    let listResolvers: Array<(value: typeof PAYLOAD) => void> = [];
    const { iframe, postMessage } = mountFrame();
    const api = makeApi({
      listMacros: vi.fn<Api["listMacros"]>(
        () =>
          new Promise((resolve) => {
            listResolvers.push((value) => resolve({ ok: true as const, value }));
          }),
      ),
      deleteMacro: vi.fn(async () => ({
        ok: true as const,
        value: { not: "a payload" } as never,
      })),
    });
    const bridge = attachMacroPortBridge({
      api,
      iframe,
      clientOrigin: ORIGIN,
      characterId: CHARACTER_ID,
    });

    post(iframe, { type: MACRO_PORT_LIST_TYPE, requestId: "list-before-del", characterId: CHARACTER_ID });
    await vi.waitFor(() => expect(listResolvers.length).toBe(1));

    post(iframe, {
      type: MACRO_PORT_DELETE_TYPE,
      requestId: "del-malformed-race",
      characterId: CHARACTER_ID,
      etag: "a".repeat(64),
      macroId: "heal_self",
    });
    await vi.waitFor(() => expect(api.deleteMacro).toHaveBeenCalled());
    await vi.waitFor(() => expect(sent(postMessage, MACRO_PORT_RESULT_TYPE).length).toBe(1));
    expect(sent(postMessage, MACRO_PORT_RESULT_TYPE)[0]).toEqual({
      type: MACRO_PORT_RESULT_TYPE,
      requestId: "del-malformed-race",
      characterId: CHARACTER_ID,
      ok: false,
      operation: "delete",
      error: "macros_unavailable",
      generation: 1,
    });
    expect(sent(postMessage, MACRO_PORT_STATE_TYPE)).toHaveLength(0);

    postMessage.mockClear();
    listResolvers[0]!({
      ...PAYLOAD,
      etag: "a".repeat(64),
      macros: [{ ...PAYLOAD.macros[0]!, body: "/stale-before-malformed-delete" }],
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(sent(postMessage, MACRO_PORT_STATE_TYPE)).toHaveLength(0);
    expect(sent(postMessage, MACRO_PORT_RESULT_TYPE)).toHaveLength(0);
    bridge.dispose();
  });
});

describe("macro port parent generation supersession", () => {
  it("drops focus/list state begun before a committed mutation so stale bytes never ride a newer epoch", async () => {
    let listResolvers: Array<(value: typeof PAYLOAD) => void> = [];
    const { iframe, postMessage } = mountFrame();
    const api = makeApi({
      listMacros: vi.fn<Api["listMacros"]>(
        () =>
          new Promise((resolve) => {
            listResolvers.push((value) => resolve({ ok: true as const, value }));
          }),
      ),
      saveMacro: vi.fn(async () => ({
        ok: true as const,
        value: {
          ...PAYLOAD,
          etag: "c".repeat(64),
          macros: [{ ...PAYLOAD.macros[0]!, body: "/healed" }],
          record: { version: 1, items: [{ ...PAYLOAD.macros[0]!, body: "/healed" }] },
          macro: { ...PAYLOAD.macros[0]!, body: "/healed" },
        },
      })),
    });
    const bridge = attachMacroPortBridge({
      api,
      iframe,
      clientOrigin: ORIGIN,
      characterId: CHARACTER_ID,
    });

    post(iframe, { type: MACRO_PORT_READY_TYPE, characterId: CHARACTER_ID });
    await vi.waitFor(() => expect(listResolvers.length).toBe(1));

    post(iframe, {
      type: MACRO_PORT_SAVE_TYPE,
      requestId: "save-race",
      characterId: CHARACTER_ID,
      etag: "a".repeat(64),
      macro: { id: "heal_self", name: "Heal Self", iconId: "macro:command", body: "/healed" },
    });
    await vi.waitFor(() => expect(api.saveMacro).toHaveBeenCalled());
    await vi.waitFor(() => expect(sent(postMessage, MACRO_PORT_RESULT_TYPE).length).toBe(1));
    expect(sent(postMessage, MACRO_PORT_RESULT_TYPE)[0]).toMatchObject({
      ok: true,
      operation: "save",
      generation: 1,
    });
    expect(sent(postMessage, MACRO_PORT_STATE_TYPE)[0]).toMatchObject({ generation: 1 });

    postMessage.mockClear();
    listResolvers[0]!({
      ...PAYLOAD,
      etag: "a".repeat(64),
      macros: [{ ...PAYLOAD.macros[0]!, body: "/stale-focus" }],
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(sent(postMessage, MACRO_PORT_STATE_TYPE)).toHaveLength(0);
    expect(sent(postMessage, MACRO_PORT_RESULT_TYPE)).toHaveLength(0);

    listResolvers = [];
    post(iframe, { type: MACRO_PORT_LIST_TYPE, requestId: "list-fresh", characterId: CHARACTER_ID });
    await vi.waitFor(() => expect(listResolvers.length).toBe(1));
    listResolvers[0]!({
      ...PAYLOAD,
      etag: "c".repeat(64),
      macros: [{ ...PAYLOAD.macros[0]!, body: "/healed" }],
    });
    await vi.waitFor(() => expect(sent(postMessage, MACRO_PORT_RESULT_TYPE).length).toBe(1));
    expect(sent(postMessage, MACRO_PORT_RESULT_TYPE)[0]).toMatchObject({
      requestId: "list-fresh",
      ok: true,
      generation: 1,
    });
    expect(sent(postMessage, MACRO_PORT_STATE_TYPE)[0]).toMatchObject({ generation: 1 });
    bridge.dispose();
  });
});
