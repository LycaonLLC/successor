import { describe, expect, it } from "vitest";
import {
  applyGameSpawnParams,
  defaultBackendWsUrl,
  runtimeBackendHttpBase,
  runtimeBackendHost,
  runtimeBackendPort,
  runtimeDefaults,
} from "./runtimeDefaults";

const location = { protocol: "http:", hostname: "127.0.0.1" };

describe("runtimeDefaults", () => {
  it("standardizes the clean local backend socket and HTTP URLs", () => {
    expect(runtimeDefaults.localClientUrl).toBe("http://127.0.0.1:5179/");
    expect(defaultBackendWsUrl({ kind: "game", location })).toBe("ws://127.0.0.1:28093/game/ws");
    expect(defaultBackendWsUrl({ kind: "chat", location })).toBe("ws://127.0.0.1:28093/chat/ws");
    expect(runtimeBackendHttpBase({ location })).toBe("http://127.0.0.1:28093");
  });

  it("uses the local backend host from the packaged desktop protocol", () => {
    expect(defaultBackendWsUrl({ kind: "game", location: { protocol: "successor:", hostname: "app" } })).toBe("ws://127.0.0.1:28093/game/ws");
    expect(runtimeBackendHost({ protocol: "successor:", hostname: "app" })).toBe("127.0.0.1");
  });

  it("preserves local port overrides for HTTP APIs", () => {
    expect(runtimeBackendPort("game", new URLSearchParams("gamePort=8123"))).toBe(8123);
    expect(runtimeBackendPort("chat", new URLSearchParams("gamePort=8123"))).toBe(8123);
    expect(runtimeBackendPort("chat", new URLSearchParams("backendPort=8124"))).toBe(8124);
    expect(runtimeBackendPort("chat", new URLSearchParams("gamePort=8123&backendPort=8124"))).toBe(8124);
    expect(runtimeBackendPort("game", new URLSearchParams("authority=client&gamePort=8125"))).toBe(8125);
    expect(runtimeBackendHttpBase({ location, searchParams: new URLSearchParams("gamePort=8123") })).toBe("http://127.0.0.1:8123");
  });

  it("converts trusted hosted game socket origins without retaining the socket path", () => {
    expect(runtimeBackendHttpBase({ gameWsUrl: "wss://alpha.successor.compress.biz/game/ws" })).toBe("https://alpha.successor.compress.biz");
    expect(runtimeBackendHttpBase({ gameWsUrl: "ws://127.0.0.1:8123/game/ws" })).toBe("http://127.0.0.1:8123");
  });

  it("fails closed for invalid hosted socket URLs and schemes", () => {
    expect(() => runtimeBackendHttpBase({ gameWsUrl: "https://alpha.successor.compress.biz/game/ws" })).toThrow(/ws:/i);
    expect(() => runtimeBackendHttpBase({ gameWsUrl: "not a URL" })).toThrow(/invalid/i);
    expect(() => runtimeBackendHttpBase({ gameWsUrl: "" })).toThrow(/invalid/i);
  });

  it("applies the standard local dev spawn when no explicit spawn is supplied", () => {
    const url = new URL("ws://127.0.0.1:28093/game/ws");

    applyGameSpawnParams(url, new URLSearchParams(), true);

    expect(url.searchParams.get("spawnArea")).toBe("open-desert-overworld");
    expect(url.searchParams.get("spawnX")).toBe("512");
    expect(url.searchParams.get("spawnY")).toBe("512");
    expect(url.searchParams.get("facing")).toBe("front");
  });
});
