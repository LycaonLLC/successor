import websocket from "@fastify/websocket";
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import { registerChatRoutes } from "./routes.js";
import { ChatHub } from "./hub.js";
import type { RuntimeAuthConfig } from "../auth/runtime.js";

const runtimeAuth: RuntimeAuthConfig = {
  mode: "standalone",
  origin: "https://www.successorgame.com",
  clientOrigin: "https://d2kf3ri6r74a0m.cloudfront.net",
  shardId: "open-desert",
  clientReleaseId: "dev",
  serverReleaseId: "dev",
  issuer: "successor-server",
};

function makeApp() {
  const app = Fastify({ logger: false });
  return app.register(websocket).then(async () => {
    await registerChatRoutes(app, {
      hub: new ChatHub(),
      runtimeAuth,
      controlStore: {} as never,
      characterStore: {} as never,
    });
    await app.ready();
    return app;
  });
}

describe("standalone chat origin admission", () => {
  let app: Awaited<ReturnType<typeof makeApp>> | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it.each(["null", "https://evil.successorgame.com", "https://d2kf3ri6r74a0m.cloudfront.net.evil.test"]) ("rejects %s before the auth timer", async (origin) => {
    app = await makeApp();
    const socket = await app.injectWS("/chat/ws", { headers: { origin } });
    const close = await new Promise<{ code: number; reason: string }>((resolve) => {
      socket.on("close", (code, reason) => resolve({ code, reason: reason.toString() }));
    });
    expect(close).toEqual({ code: 1008, reason: "origin not allowed" });
  });

  it.each([runtimeAuth.origin, runtimeAuth.clientOrigin, "successor://app", undefined]) ("allows trusted origin %s to reach first-frame authentication", async (origin) => {
    app = await makeApp();
    const socket = await app.injectWS("/chat/ws", { headers: origin ? { origin } : {} });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(socket.readyState).toBe(1);
    socket.close();
  });
});
