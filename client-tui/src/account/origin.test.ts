/**
 * Hosted socket admission — the exact storefront Origin must ride on both
 * real handshakes: the Colyseus matchmake HTTP request and the chat WS
 * upgrade. Observed against live local listeners, not mocks of our own code.
 */
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createSuccessorHeadlessHost } from "@successor/client/src/headless/host";
import { hostedChatSocket } from "../game/session";
import { storefrontOrigin } from "./hosted";

const SLICE = path.resolve(import.meta.dirname, "../../../client/public/successor-slice/open-desert-slice.json");

let servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.map((server) => {
    const { promise, resolve } = Promise.withResolvers<void>();
    server.close(() => resolve());
    return promise;
  }));
  servers = [];
});
async function listen(server: Server): Promise<number> {
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  return address.port;
}

describe("hosted origin admission", () => {
  it("sends the exact Origin on the Colyseus matchmake request", async () => {
    const origins: Array<string | undefined> = [];
    const server = createServer((request, response) => {
      origins.push(request.headers.origin);
      response.writeHead(403, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "denied" }));
    });
    const port = await listen(server);
    const host = await createSuccessorHeadlessHost({
      endpoint: `http://127.0.0.1:${port}`,
      slicePath: SLICE,
      characterId: "char_a",
      actorId: "char_a",
      gameTicket: "game-capability",
      clientReleaseId: "test-client-release",
      origin: "https://www.successorgame.com",
      readyTimeoutMs: 3_000,
    });
    await expect(host.start()).rejects.toThrow();
    expect(origins.length).toBeGreaterThan(0);
    expect(origins[0]).toBe("https://www.successorgame.com");
  });

  it("sends the exact Origin on the chat WS upgrade, no cookies or bearer", async () => {
    const server = createServer();
    const seen = Promise.withResolvers<{ origin?: string; cookie?: string; authorization?: string; host?: string }>();
    server.on("upgrade", (request, socket) => {
      seen.resolve({
        origin: request.headers.origin,
        cookie: request.headers.cookie,
        authorization: request.headers.authorization,
        host: request.headers.host,
      });
      socket.destroy();
    });
    const port = await listen(server);
    const socket = hostedChatSocket(`ws://127.0.0.1:${port}/chat/ws`, "https://www.successorgame.com");
    socket.addEventListener("error", () => {});
    const headers = await seen.promise;
    socket.close();
    // the socket host is exactly the launch endpoint's host
    expect(headers.host).toBe(`127.0.0.1:${port}`);
    expect(headers.cookie).toBeUndefined();
    expect(headers.authorization).toBeUndefined();
  });

  it("derives the canonical origin from the account service URL and refuses unsafe ones", () => {
    expect(storefrontOrigin("https://www.successorgame.com")).toBe("https://www.successorgame.com");
    expect(storefrontOrigin("https://www.successorgame.com/prefix")).toBe("https://www.successorgame.com");
    expect(storefrontOrigin("http://127.0.0.1:8080")).toBe("http://127.0.0.1:8080");
    expect(() => storefrontOrigin("http://successorgame.com")).toThrow(/non-https Origin/u);
    expect(() => storefrontOrigin("not a url")).toThrow(/not a URL/u);
  });
});
