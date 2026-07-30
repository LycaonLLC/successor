import { describe, expect, it } from "vitest";
import { createAuthorityBeforeRenderer } from "./authorityRendererBoot";

type FakeAuthority = {
  initialSnapshot: Promise<void>;
};

type FakeChat = {
  connected: boolean;
  dispose: () => void;
};

type FakeRenderer = {
  view: string;
};

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

describe("createAuthorityBeforeRenderer", () => {
  it("starts game and chat first, then exposes view interest after renderer assignment", async () => {
    const authorityReady = deferred<void>();
    const rendererReady = deferred<FakeRenderer>();
    const order: string[] = [];
    let getViewInterest: (() => string | null) | undefined;
    let chatConnectCount = 0;
    let createdChat: FakeChat | undefined;

    const boot = createAuthorityBeforeRenderer({
      createAuthority: (viewInterest: () => string | null) => {
        order.push("authority");
        getViewInterest = viewInterest;
        return { initialSnapshot: authorityReady.promise } satisfies FakeAuthority;
      },
      createChat: () => {
        order.push("chat-create");
        createdChat = { connected: false, dispose: () => order.push("chat-dispose") };
        return createdChat;
      },
      connectChat: (chat) => {
        order.push("chat-connect");
        chat.connected = true;
        chatConnectCount += 1;
      },
      waitForAuthority: (authority) => authority.initialSnapshot,
      createRenderer: () => {
        order.push("renderer");
        return rendererReady.promise;
      },
      getViewInterest: (renderer) => renderer.view,
    });

    expect(order).toEqual(["authority", "chat-create", "chat-connect"]);
    expect(getViewInterest?.()).toBeNull();

    authorityReady.resolve();
    await Promise.resolve();
    expect(order).toEqual(["authority", "chat-create", "chat-connect", "renderer"]);
    expect(getViewInterest?.()).toBeNull();

    rendererReady.resolve({ view: "nearby-actors" });
    const started = await boot;
    expect(started.chat).toBe(createdChat);
    expect(started.chat.connected).toBe(true);
    expect(chatConnectCount).toBe(1);
    expect(getViewInterest?.()).toBe("nearby-actors");
  });

  it("closes both early transports when renderer boot fails", async () => {
    const order: string[] = [];
    const authorityReady = Promise.resolve();
    const boot = createAuthorityBeforeRenderer({
      createAuthority: () => ({ initialSnapshot: authorityReady } satisfies FakeAuthority),
      createChat: () => ({ connected: true, dispose: () => order.push("chat-close") }),
      connectChat: () => undefined,
      waitForAuthority: (authority) => authority.initialSnapshot,
      createRenderer: async (): Promise<FakeRenderer> => {
        throw new Error("renderer failed");
      },
      getViewInterest: (renderer) => renderer.view,
      closeAuthority: () => order.push("authority-close"),
      closeChat: (chat) => chat.dispose(),
    });

    await expect(boot).rejects.toThrow("renderer failed");
    expect(order).toEqual(["authority-close", "chat-close"]);
  });
});
