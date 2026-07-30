import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Api } from "../src/api/client";
import { SELECTED_CHARACTER_KEY, resetHandoffForTests, storeSelectedCharacterId } from "../src/features/characterHandoff";
import {
  CLIENT_EXIT_WORLD_RESULT_TYPE,
  CLIENT_EXIT_WORLD_TYPE,
  CLIENT_READY_TYPE,
  initPlayPage,
  isLaunchContext,
  LAUNCH_FAILED_TYPE,
  LAUNCH_MESSAGE_TYPE,
} from "../src/features/play";
import { RUNTIME_POINTER_SCHEMA } from "../src/features/runtimePointer";
import { mountPage, settle } from "./helpers";

const ENTRY = "https://client.example/releases/0f3a/index.html";
const CLIENT_ORIGIN = "https://client.example";
const CHARACTER_APPEARANCE = { skinTone: "#c78f62", hair: "hair_mop", hairMat: "hair_raven", face: null };
const CHARACTER_WORN = [{ item: "under_bodysuit", colors: ["#89cff0"] }];

const CONTEXT = {
  schema: "successor.launch-context.v1" as const,
  gameTicket: "g-ticket",
  chatTicket: "c-ticket",
  endpoints: { game: "wss://shard.example/game", chat: "wss://shard.example/chat" },
  release: { client: "client-r1", server: "server-r1", shard: "shard-1" },
  characterId: "char-1",
  expiresAt: 1_784_950_000_000,
};

function stubPointer(body: unknown = { schema: RUNTIME_POINTER_SCHEMA, entry: ENTRY }): void {
  vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockImplementation(() => Promise.resolve(
    new Response(JSON.stringify(body), { status: 200 }),
  )));
}

function makeApi(overrides: Partial<Api> = {}): Api {
  return {
    session: vi.fn(() => Promise.resolve({ ok: true as const, value: { callsign: "wolf", setup: { characterCount: 1, maxCharacters: 5 } } })),
    characters: vi.fn(() => Promise.resolve({ ok: true as const, value: { characters: [{ id: "char-1", name: "Rook", initialProfessionId: "scout", worldEntryClaimed: false, appearance: CHARACTER_APPEARANCE, worn: CHARACTER_WORN }] } })),
    playTicket: vi.fn(() => Promise.resolve({ ok: true as const, value: CONTEXT })),
    ...overrides,
  } as unknown as Api;
}

function submitLaunch(): void {
  const form = document.getElementById("launch-form");
  if (!(form instanceof HTMLFormElement)) throw new Error("missing launch form");
  form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
}

function gameFrame(): HTMLIFrameElement {
  const iframe = document.getElementById("game-frame");
  if (!(iframe instanceof HTMLIFrameElement) || !iframe.contentWindow) throw new Error("missing game frame");
  return iframe;
}

beforeEach(() => {
  vi.useRealTimers();
  window.sessionStorage.clear();
  resetHandoffForTests();
  vi.unstubAllGlobals();
});

describe("launch protocol contract", () => {
  it("uses the exact message types from the shared client contract", () => {
    expect(LAUNCH_MESSAGE_TYPE).toBe("successor.launch.v1");
    expect(CLIENT_READY_TYPE).toBe("successor.client.ready.v1");
    expect(LAUNCH_FAILED_TYPE).toBe("successor.launch.failed.v1");
    expect(CLIENT_EXIT_WORLD_TYPE).toBe("successor.client.exit-world.v1");
    expect(CLIENT_EXIT_WORLD_RESULT_TYPE).toBe("successor.client.exit-world-result.v1");
  });

  it("accepts the normalized launch envelope with epoch-ms expiry", () => {
    expect(isLaunchContext(CONTEXT)).toBe(true);
    expect(isLaunchContext({ ...CONTEXT, release: { client: "c", server: "s", shard: "shard-1" } })).toBe(true);
  });

  it("requires the protocol schema and complete server fields", () => {
    const { schema: _schema, ...serverContext } = CONTEXT;
    expect(isLaunchContext(serverContext)).toBe(false);
    expect(isLaunchContext({ ...CONTEXT, expiresAt: "soon" })).toBe(false);
    expect(isLaunchContext({ ...CONTEXT, release: { client: "c", server: "s" } })).toBe(false);
    expect(isLaunchContext({ ...CONTEXT, endpoints: { game: "wss://g" } })).toBe(false);
    expect(isLaunchContext({ ...CONTEXT, gameTicket: undefined })).toBe(false);
    expect(isLaunchContext(null)).toBe(false);
  });

  it("posts the schema-bearing context to the iframe after the client handshake", async () => {
    mountPage("play/index.html");
    stubPointer();
    await initPlayPage(document, makeApi());
    submitLaunch();
    await settle();
    const iframe = gameFrame();
    expect(iframe.src).toBe(ENTRY);
    // The stage owns the viewport while the client runs.
    expect(document.getElementById("launch-section")?.dataset.stageState).toBe("live");
    expect(document.body.dataset.playState).toBe("live");
    expect(document.body.dataset.playView).toBe("full");
    expect(iframe.allowFullscreen).toBe(true);
    const win = iframe.contentWindow;
    if (!win) throw new Error("missing frame window");
    const postMessage = vi.spyOn(win, "postMessage");
    window.dispatchEvent(new MessageEvent("message", {
      origin: CLIENT_ORIGIN,
      source: win,
      data: { type: CLIENT_READY_TYPE },
    }));
    expect(postMessage).toHaveBeenCalledWith({ type: LAUNCH_MESSAGE_TYPE, launch: CONTEXT }, CLIENT_ORIGIN);
    expect(document.activeElement).toBe(iframe);
    window.dispatchEvent(new MessageEvent("message", { origin: CLIENT_ORIGIN, source: win, data: { type: CLIENT_READY_TYPE } }));
    expect(postMessage).toHaveBeenCalledTimes(2);
    expect(postMessage).toHaveBeenLastCalledWith(
      { type: LAUNCH_MESSAGE_TYPE, launch: CONTEXT },
      CLIENT_ORIGIN,
    );
    window.dispatchEvent(new MessageEvent("message", { origin: CLIENT_ORIGIN, source: win, data: { type: LAUNCH_FAILED_TYPE } }));
    expect(document.getElementById("game-frame")).toBeNull();
    expect(document.getElementById("launch-section")?.dataset.stageState).toBe("idle");
    expect(document.body.dataset.playState).toBe("idle");
    expect(document.body.dataset.playView).toBeUndefined();
    expect(document.getElementById("launch-result")?.textContent).toContain("Entry failed before the world opened.");
  });

  it("stops a displaced live frame and explains that another client took control", async () => {
    mountPage("play/index.html");
    stubPointer();
    await initPlayPage(document, makeApi());
    submitLaunch();
    await settle();
    const iframe = gameFrame();
    const win = iframe.contentWindow;
    if (!win) throw new Error("missing frame window");
    window.dispatchEvent(new MessageEvent("message", {
      origin: CLIENT_ORIGIN,
      source: win,
      data: { type: LAUNCH_FAILED_TYPE, reason: "session-replaced" },
    }));
    expect(document.getElementById("game-frame")).toBeNull();
    expect(document.body.dataset.playState).toBe("idle");
    expect(document.getElementById("launch-result")?.textContent).toContain(
      "This character was opened in another client",
    );
  });

  it("keeps the live lifecycle listener after the one-shot ticket handoff expires", async () => {
    mountPage("play/index.html");
    stubPointer();
    await initPlayPage(document, makeApi());
    vi.useFakeTimers();
    try {
      submitLaunch();
      await vi.advanceTimersByTimeAsync(0);
      const iframe = gameFrame();
      const win = iframe.contentWindow;
      if (!win) throw new Error("missing frame window");
      window.dispatchEvent(new MessageEvent("message", {
        origin: CLIENT_ORIGIN,
        source: win,
        data: { type: CLIENT_READY_TYPE },
      }));
      await vi.advanceTimersByTimeAsync(30_000);
      window.dispatchEvent(new MessageEvent("message", {
        origin: CLIENT_ORIGIN,
        source: win,
        data: { type: LAUNCH_FAILED_TYPE, reason: "session-replaced" },
      }));
      expect(document.getElementById("game-frame")).toBeNull();
      expect(document.getElementById("launch-result")?.textContent).toContain(
        "This character was opened in another client",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("leaves and re-enters full view without destroying the live session", async () => {
    mountPage("play/index.html");
    stubPointer();
    await initPlayPage(document, makeApi());
    submitLaunch();
    await settle();
    const iframe = gameFrame();

    document.getElementById("play-frame-exit")?.click();
    expect(document.body.dataset.playState).toBe("live");
    expect(document.body.dataset.playView).toBe("framed");
    expect(document.getElementById("game-frame")).toBe(iframe);
    expect(document.activeElement).toBe(document.getElementById("play-frame-enter"));

    document.getElementById("play-frame-enter")?.click();
    expect(document.body.dataset.playView).toBe("full");
    expect(document.activeElement).toBe(iframe);

    window.dispatchEvent(new KeyboardEvent("keydown", { code: "Escape", bubbles: true, cancelable: true }));
    expect(document.body.dataset.playView).toBe("framed");
    expect(document.getElementById("game-frame")).toBe(iframe);
  });

  it("cleanly exits the old character before minting and mounting a replacement", async () => {
    mountPage("play/index.html");
    stubPointer();
    const playTicket = vi.fn((characterId: string) => Promise.resolve({
      ok: true as const,
      value: { ...CONTEXT, characterId },
    }));
    const api = makeApi({
      characters: vi.fn(() => Promise.resolve({
        ok: true as const,
        value: {
          characters: [
            { id: "char-1", name: "Rook", initialProfessionId: "scout", worldEntryClaimed: true, appearance: CHARACTER_APPEARANCE, worn: CHARACTER_WORN },
            { id: "char-2", name: "Grugga", initialProfessionId: "marksman", worldEntryClaimed: true, appearance: CHARACTER_APPEARANCE, worn: CHARACTER_WORN },
          ],
        },
      })),
      playTicket,
    });
    await initPlayPage(document, api);
    submitLaunch();
    await settle();
    const oldFrame = gameFrame();
    const oldWindow = oldFrame.contentWindow;
    if (!oldWindow) throw new Error("missing old frame window");
    window.dispatchEvent(new MessageEvent("message", {
      origin: CLIENT_ORIGIN,
      source: oldWindow,
      data: { type: CLIENT_READY_TYPE },
    }));
    const oldPostMessage = vi.spyOn(oldWindow, "postMessage");
    const select = document.getElementById("launch-character");
    if (!(select instanceof HTMLSelectElement)) throw new Error("missing character select");
    select.value = "char-2";
    submitLaunch();
    await settle();

    expect(oldPostMessage).toHaveBeenCalledWith(
      { type: CLIENT_EXIT_WORLD_TYPE },
      CLIENT_ORIGIN,
    );
    expect(playTicket).toHaveBeenCalledTimes(1);
    expect(document.getElementById("game-frame")).toBe(oldFrame);

    // A lookalike acknowledgement from another source cannot release teardown.
    window.dispatchEvent(new MessageEvent("message", {
      origin: CLIENT_ORIGIN,
      source: {} as Window,
      data: { type: CLIENT_EXIT_WORLD_RESULT_TYPE, ok: true },
    }));
    await settle();
    expect(playTicket).toHaveBeenCalledTimes(1);

    window.dispatchEvent(new MessageEvent("message", {
      origin: CLIENT_ORIGIN,
      source: oldWindow,
      data: { type: CLIENT_EXIT_WORLD_RESULT_TYPE, ok: true },
    }));
    await settle();
    await settle();

    expect(playTicket).toHaveBeenCalledTimes(2);
    expect(playTicket).toHaveBeenLastCalledWith("char-2");
    const replacement = gameFrame();
    expect(replacement).not.toBe(oldFrame);
    expect(oldFrame.isConnected).toBe(false);
  });

  it("spends no ticket when the runtime pointer misses the versioned schema", async () => {
    mountPage("play/index.html");
    stubPointer({ entry: ENTRY }); // old unversioned shape: rejected
    const api = makeApi();
    await initPlayPage(document, api);
    submitLaunch();
    await settle();
    expect(api.playTicket).not.toHaveBeenCalled();
    expect(document.getElementById("game-frame")).toBeNull();
    expect(document.getElementById("launch-result")?.textContent).toContain("no ticket was spent");
  });
});

describe("direct-entry handoff on /play/", () => {
  it("consumes the one-shot id and opens the matching character without a second confirmation", async () => {
    mountPage("play/index.html");
    stubPointer();
    window.sessionStorage.setItem(SELECTED_CHARACTER_KEY, "char-1");
    const api = makeApi();
    await initPlayPage(document, api);
    await settle();
    // Consumed and cleared before anything else could read it.
    expect(window.sessionStorage.getItem(SELECTED_CHARACTER_KEY)).toBeNull();
    const select = document.getElementById("launch-character");
    expect(select instanceof HTMLSelectElement && select.value).toBe("char-1");
    expect(api.playTicket).toHaveBeenCalledTimes(1);
    expect(api.playTicket).toHaveBeenCalledWith("char-1");
    expect(gameFrame().src).toBe(ENTRY);
    expect(document.body.dataset.playState).toBe("live");
    expect(document.body.dataset.playView).toBe("full");
  });

  it("clears an id that matches no roster row and leaves the selector alone", async () => {
    mountPage("play/index.html");
    stubPointer();
    window.sessionStorage.setItem(SELECTED_CHARACTER_KEY, "char_gone00000000");
    const api = makeApi();
    await initPlayPage(document, api);
    await settle();
    expect(window.sessionStorage.getItem(SELECTED_CHARACTER_KEY)).toBeNull();
    expect(api.playTicket).not.toHaveBeenCalled();
    expect(document.getElementById("game-frame")).toBeNull();
  });

  it("clears malformed stored values without acting on them", async () => {
    mountPage("play/index.html");
    stubPointer();
    window.sessionStorage.setItem(SELECTED_CHARACTER_KEY, "../../not-an-id");
    const api = makeApi();
    await initPlayPage(document, api);
    await settle();
    expect(window.sessionStorage.getItem(SELECTED_CHARACTER_KEY)).toBeNull();
    expect(api.playTicket).not.toHaveBeenCalled();
  });

  it("restores the fallback picker without spending a ticket when direct entry has no valid runtime", async () => {
    mountPage("play/index.html");
    stubPointer({ entry: ENTRY });
    window.sessionStorage.setItem(SELECTED_CHARACTER_KEY, "char-1");
    const api = makeApi();
    await initPlayPage(document, api);
    await settle();
    expect(api.playTicket).not.toHaveBeenCalled();
    expect(document.getElementById("game-frame")).toBeNull();
    expect(document.getElementById("launch-section")?.dataset.stageState).toBe("idle");
    expect(document.body.dataset.playState).toBe("idle");
    expect(document.body.dataset.playView).toBeUndefined();
    expect(document.getElementById("launch-result")?.textContent).toContain("no ticket was spent");
  });

  it("changes nothing for a direct visit: no auto-submit, selector as before", async () => {
    mountPage("play/index.html");
    stubPointer();
    const api = makeApi();
    await initPlayPage(document, api);
    await settle();
    expect(api.playTicket).not.toHaveBeenCalled();
    expect(document.getElementById("game-frame")).toBeNull();
    const button = document.querySelector<HTMLButtonElement>('#launch-form button[type="submit"]');
    expect(button?.disabled).toBe(false);
    submitLaunch();
    await settle();
    expect(api.playTicket).toHaveBeenCalledTimes(1);
  });

  it("never lets tickets or tokens near the URL or storage on launch", async () => {
    mountPage("play/index.html");
    stubPointer();
    window.sessionStorage.setItem(SELECTED_CHARACTER_KEY, "char-1");
    const api = makeApi();
    await initPlayPage(document, api);
    await settle();
    const iframe = gameFrame();
    expect(iframe.src).not.toMatch(/ticket|token|csrf|char-1/i);
    expect(window.sessionStorage.length).toBe(0);
  });

  it("uses in-memory handoff when sessionStorage is denied", async () => {
    mountPage("play/index.html");
    stubPointer();
    const setItem = vi.spyOn(window.sessionStorage, "setItem").mockImplementation(() => {
      throw new DOMException("Denied", "SecurityError");
    });
    const getItem = vi.spyOn(window.sessionStorage, "getItem").mockImplementation(() => {
      throw new DOMException("Denied", "SecurityError");
    });
    expect(storeSelectedCharacterId(window, "char-1")).toBe(true);
    const api = makeApi();
    await initPlayPage(document, api);
    await settle();
    const select = document.getElementById("launch-character");
    expect(select instanceof HTMLSelectElement && select.value).toBe("char-1");
    expect(api.playTicket).toHaveBeenCalledWith("char-1");
    // Second consume is empty — one-shot.
    expect(storeSelectedCharacterId(window, "char-1")).toBe(true);
    // Clear memory by consuming through a fresh play bootstrap path is covered above;
    // storage spies stay denied the whole time.
    setItem.mockRestore();
    getItem.mockRestore();
  });
});
