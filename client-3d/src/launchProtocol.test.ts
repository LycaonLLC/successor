import { afterEach, describe, expect, it } from "vitest";
import {
  HOSTED_EXIT_WORLD_REQUEST_TYPE,
  HOSTED_EXIT_WORLD_RESULT_TYPE,
  installParentExitWorldHandler,
  notifyHostedLaunchFailure,
  validateHostedLaunchMessage,
  waitForParentLaunch,
} from "./launchProtocol";

type Listener = (event: MessageEvent<unknown>) => void;
function launch(releaseClient = "r1") {
  return {
    schema: "successor.launch-context.v1",
    gameTicket: "game-secret",
    chatTicket: "chat-secret",
    endpoints: { game: "wss://game.example.test/socket", chat: "wss://chat.example.test/socket" },
    release: { client: releaseClient, server: "s1" },
    characterId: "char-1",
    expiresAt: Date.now() + 30_000,
  };
}
function fakeWindow() {
  const listeners = new Set<Listener>();
  const sent: unknown[] = [];
  const parent = { postMessage: (value: unknown, targetOrigin: string) => sent.push({ value, targetOrigin }) };
  const fake = { parent, addEventListener: (_type: string, listener: Listener) => listeners.add(listener), removeEventListener: (_type: string, listener: Listener) => listeners.delete(listener) };
  Object.defineProperty(globalThis, "window", { configurable: true, value: fake });
  return { listeners, parent, sent };
}
afterEach(() => {
  Reflect.deleteProperty(globalThis, "window");
  (import.meta.env as Record<string, string>).SUCCESSOR_CLIENT_RELEASE_ID = "";
  (import.meta.env as Record<string, string>).SUCCESSOR_STOREFRONT_ORIGIN = "";
});

describe("hosted client launch protocol", () => {
  it("reports a same-character replacement to the exact storefront origin", () => {
    (import.meta.env as Record<string, string>).SUCCESSOR_STOREFRONT_ORIGIN = "https://storefront.example.test";
    const { sent } = fakeWindow();
    notifyHostedLaunchFailure("session-replaced");
    expect(sent).toContainEqual({
      value: { type: "successor.launch.failed.v1", reason: "session-replaced" },
      targetOrigin: "https://storefront.example.test",
    });
  });

  it("requires the strict standalone schema and keeps legacy explicit", () => {
    expect(validateHostedLaunchMessage({ type: "successor.launch.v1", launch: launch() }, { clientReleaseId: "r1" })?.launch).toMatchObject({ characterId: "char-1" });
    expect(validateHostedLaunchMessage({ type: "successor.launch.v1", launch: launch() }, { clientReleaseId: "r2" })).toBeNull();
    expect(validateHostedLaunchMessage({ type: "successor.launch.v1", mode: "legacy", launch: { ticket: "t" } })).toMatchObject({ mode: "legacy" });
    expect(validateHostedLaunchMessage({ type: "successor.launch.v1", launch: { ticket: "t" } })).toBeNull();
  });
  it("uses the client release id for ready and exact-origin launch validation", async () => {
    (import.meta.env as Record<string, string>).SUCCESSOR_CLIENT_RELEASE_ID = "successor-alpha@a2d02071e180f9df";
    (import.meta.env as Record<string, string>).SUCCESSOR_STOREFRONT_ORIGIN = "https://storefront.example.test";
    const { listeners, parent, sent } = fakeWindow();
    const promise = waitForParentLaunch(50);
    expect(listeners.size).toBe(1);
    expect(sent).toContainEqual({ value: { type: "successor.client.ready.v1", releaseId: "successor-alpha@a2d02071e180f9df" }, targetOrigin: "https://storefront.example.test" });
    for (const listener of listeners) listener({ origin: "https://storefront.example.test", source: parent, data: { type: "successor.launch.v1", launch: launch("fixture-identity@a2d02071e180f9df") } } as never);
    for (const listener of listeners) listener({ origin: "https://evil.example.test", source: parent, data: { type: "successor.launch.v1", launch: launch("successor-alpha@a2d02071e180f9df") } } as never);
    for (const listener of listeners) listener({ origin: "https://storefront.example.test", source: parent, data: { type: "successor.launch.v1", launch: launch("successor-alpha@a2d02071e180f9df") } } as never);
    await expect(promise).resolves.toMatchObject({ launch: { characterId: "char-1", release: { client: "successor-alpha@a2d02071e180f9df" } }, capabilities: { gameEndpoint: "wss://game.example.test/socket" } });
    expect(listeners.size).toBe(0);
  });
  it("ignores malformed/wrong-source messages and times out honestly", async () => {
    (import.meta.env as Record<string, string>).SUCCESSOR_CLIENT_RELEASE_ID = "successor-alpha@a2d02071e180f9df";
    (import.meta.env as Record<string, string>).SUCCESSOR_STOREFRONT_ORIGIN = "https://storefront.example.test";
    const { listeners } = fakeWindow();
    const promise = waitForParentLaunch(5);
    for (const listener of listeners) listener({ origin: "https://storefront.example.test", source: {}, data: { type: "successor.launch.v1", launch: launch("successor-alpha@wrongwrongwrong") } } as never);
    await expect(promise).rejects.toThrow("Timed out waiting for Successor launch");
  });

  it("accepts a strict parent clean-exit request and returns the confirmed result", async () => {
    (import.meta.env as Record<string, string>).SUCCESSOR_STOREFRONT_ORIGIN = "https://storefront.example.test";
    const { listeners, parent, sent } = fakeWindow();
    let exits = 0;
    const dispose = installParentExitWorldHandler(async () => {
      exits += 1;
      return true;
    });
    expect(listeners.size).toBe(1);
    for (const listener of listeners) {
      listener({
        origin: "https://evil.example.test",
        source: parent,
        data: { type: HOSTED_EXIT_WORLD_REQUEST_TYPE },
      } as never);
      listener({
        origin: "https://storefront.example.test",
        source: {},
        data: { type: HOSTED_EXIT_WORLD_REQUEST_TYPE },
      } as never);
      listener({
        origin: "https://storefront.example.test",
        source: parent,
        data: { type: HOSTED_EXIT_WORLD_REQUEST_TYPE, extra: true },
      } as never);
    }
    expect(exits).toBe(0);
    for (const listener of listeners) {
      listener({
        origin: "https://storefront.example.test",
        source: parent,
        data: { type: HOSTED_EXIT_WORLD_REQUEST_TYPE },
      } as never);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(exits).toBe(1);
    expect(sent).toContainEqual({
      value: { type: HOSTED_EXIT_WORLD_RESULT_TYPE, ok: true },
      targetOrigin: "https://storefront.example.test",
    });
    dispose();
    expect(listeners.size).toBe(0);
  });
});
