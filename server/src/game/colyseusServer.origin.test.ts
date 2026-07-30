import net from "node:net";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import {
  isAllowedColyseusOrigin,
  registerColyseusGameServer,
} from "./colyseusServer.js";

const legacyRuntime = {
  mode: "legacy" as const,
  shardId: "open-desert",
  clientReleaseId: "dev",
  serverReleaseId: "dev",
  issuer: "successor-server",
};
const standaloneRuntime = {
  ...legacyRuntime,
  mode: "standalone" as const,
  origin: "https://www.successorgame.com",
  clientOrigin: "https://d2kf3ri6r74a0m.cloudfront.net",
};
type TestRuntime = typeof legacyRuntime | typeof standaloneRuntime;

let app: FastifyInstance | undefined;

afterEach(async () => {
  if (app) {
    await app.close();
    app = undefined;
  }
});

function serverOptions(runtimeAuth: TestRuntime = legacyRuntime) {
  return {
    shard: {} as never,
    characterStore: {} as never,
    runtimeAuth,
    controlStore: runtimeAuth.mode === "standalone" ? {} as never : undefined,
  };
}

describe("local Colyseus origin policy", () => {
  it("allows only the app scheme, canonical loopback origins, and missing Origin", () => {
    for (const origin of [
      "successor://app",
      "http://127.0.0.1:5179",
      "https://127.0.0.1:5179",
      "http://localhost:5179",
      "http://[::1]:5179",
      undefined,
    ]) {
      expect(isAllowedColyseusOrigin(origin)).toBe(true);
    }

    for (const origin of [
      "https://evil.example",
      "successor://evil",
      "http://0.0.0.0:5179",
      "http://127.0.0.1:5179/",
      "http://127.0.0.1:80",
      "successor://app,https://evil.example",
      ["successor://app", "https://evil.example"],
    ]) {
      expect(isAllowedColyseusOrigin(origin)).toBe(false);
    }
  });

  it("allows exact site/client origins and native origins, but rejects arbitrary origins", () => {
    for (const origin of [
      "https://www.successorgame.com",
      "https://d2kf3ri6r74a0m.cloudfront.net",
      "successor://app",
      "http://127.0.0.1:5179",
      undefined,
    ]) {
      expect(isAllowedColyseusOrigin(origin, standaloneRuntime.origin, standaloneRuntime.clientOrigin)).toBe(true);
    }
    for (const origin of [
      "https://evil.example",
      "https://d2kf3ri6r74a0m.cloudfront.net.evil.test",
      "successor://evil",
      ["https://www.successorgame.com", "https://evil.example"],
    ]) {
      expect(isAllowedColyseusOrigin(origin, standaloneRuntime.origin, standaloneRuntime.clientOrigin)).toBe(false);
    }
  });

  it("accepts successor://app and legacy no-Origin matchmake while rejecting evil and multi-valued origins", async () => {
    app = Fastify();
    await registerColyseusGameServer(app, serverOptions());

    const preflight = await app.inject({
      method: "OPTIONS",
      url: "/matchmake/joinOrCreate/game",
      headers: { origin: "successor://app" },
    });
    expect(preflight.statusCode).toBe(204);
    expect(preflight.headers["access-control-allow-origin"]).toBe("successor://app");
    expect(preflight.headers["access-control-allow-credentials"]).toBe("true");
    expect(preflight.headers.vary).toContain("Origin");

    const posted = await app.inject({
      method: "POST",
      url: "/matchmake/joinOrCreate/game",
      headers: { origin: "successor://app" },
      payload: { actor: "legacy" },
    });
    expect(posted.statusCode).not.toBe(403);
    expect(posted.headers["access-control-allow-origin"]).toBe("successor://app");
    expect(posted.headers["access-control-allow-credentials"]).toBe("true");

    const legacy = await app.inject({
      method: "POST",
      url: "/matchmake/joinOrCreate/game",
      payload: { actor: "legacy" },
    });
    expect(legacy.statusCode).not.toBe(403);
    expect(legacy.headers["access-control-allow-origin"]).toBeUndefined();
    expect(legacy.headers["access-control-allow-credentials"]).toBeUndefined();

    const evil = await app.inject({
      method: "OPTIONS",
      url: "/matchmake/joinOrCreate/game",
      headers: { origin: "https://evil.example" },
    });
    expect(evil.statusCode).toBe(403);
    expect(evil.headers["access-control-allow-origin"]).toBeUndefined();
    expect(evil.headers["access-control-allow-credentials"]).toBeUndefined();

    const multiValued = await app.inject({
      method: "POST",
      url: "/matchmake/joinOrCreate/game",
      headers: { origin: "successor://app,https://evil.example" },
      payload: { actor: "legacy" },
    });
    expect(multiValued.statusCode).toBe(403);
    expect(multiValued.headers["access-control-allow-origin"]).toBeUndefined();
    expect(multiValued.headers["access-control-allow-credentials"]).toBeUndefined();
  });

  it("returns CORS headers only for exact site/client origins", async () => {
    app = Fastify();
    await registerColyseusGameServer(app, serverOptions(standaloneRuntime));

    const exact = await app.inject({
      method: "OPTIONS",
      url: "/matchmake/joinOrCreate/game",
      headers: { origin: standaloneRuntime.origin },
    });
    expect(exact.statusCode).toBe(204);
    expect(exact.headers["access-control-allow-origin"]).toBe(standaloneRuntime.origin);
    expect(exact.headers["access-control-allow-credentials"]).toBe("true");

    const client = await app.inject({
      method: "OPTIONS",
      url: "/matchmake/joinOrCreate/game",
      headers: { origin: standaloneRuntime.clientOrigin },
    });
    expect(client.statusCode).toBe(204);
    expect(client.headers["access-control-allow-origin"]).toBe(standaloneRuntime.clientOrigin);
    expect(client.headers["access-control-allow-credentials"]).toBe("true");

    const missing = await app.inject({
      method: "OPTIONS",
      url: "/matchmake/joinOrCreate/game",
    });
    expect(missing.statusCode).toBe(204);
    expect(missing.headers["access-control-allow-origin"]).toBeUndefined();
    expect(missing.headers["access-control-allow-credentials"]).toBeUndefined();

    const evil = await app.inject({
      method: "OPTIONS",
      url: "/matchmake/joinOrCreate/game",
      headers: { origin: "https://evil.example" },
    });
    expect(evil.statusCode).toBe(403);
    expect(evil.headers["access-control-allow-origin"]).toBeUndefined();
    expect(evil.headers["access-control-allow-credentials"]).toBeUndefined();
  });

  it("uses the same local policy for accepted and rejected room upgrades", async () => {
    app = Fastify();
    await registerColyseusGameServer(app, serverOptions());
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (!address || typeof address === "string") throw new Error("test server did not expose a TCP address");

    const accepted = await rawUpgrade(address.port, "successor://app");
    expect(accepted).toContain("101 Switching Protocols");

    const rejected = await rawUpgrade(address.port, "https://evil.example");
    expect(rejected).toContain("403 Forbidden");

    const rejectedMultiValued = await rawUpgrade(address.port, ["successor://app", "https://evil.example"]);
    expect(rejectedMultiValued).toContain("403 Forbidden");

    const acceptedLegacy = await rawUpgrade(address.port);
    expect(acceptedLegacy).toContain("101 Switching Protocols");
  });
});

function rawUpgrade(port: number, origins?: string | string[]): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    let response = "";
    const originHeaders = origins === undefined
      ? ""
      : (Array.isArray(origins) ? origins.map((origin) => `Origin: ${origin}\r\n`).join("") : `Origin: ${origins}\r\n`);
    const finish = () => {
      socket.destroy();
      resolve(response);
    };
    socket.on("connect", () => {
      socket.write(
        `GET /game/room HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n${originHeaders}\r\n`,
      );
    });
    socket.on("data", (chunk) => {
      response += chunk.toString("utf8");
      if (response.includes("\r\n\r\n")) finish();
    });
    socket.on("error", (error) => {
      if (response) resolve(response);
      else reject(error);
    });
    socket.on("close", () => {
      if (response) resolve(response);
    });
  });
}
