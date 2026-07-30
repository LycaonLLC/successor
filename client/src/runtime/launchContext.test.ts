import { describe, expect, it, beforeEach } from "vitest";
import {
  clearConsumedLaunchesForTests,
  consumeStandaloneLaunchContext,
  validateStandaloneLaunchContext,
  validateStandaloneLaunchMessage,
} from "./launchContext";

const now = 1_700_000_000_000;
const context = () => ({
  schema: "successor.launch-context.v1",
  gameTicket: "game-secret",
  chatTicket: "chat-secret",
  endpoints: { game: "wss://game.example.test/colyseus", chat: "wss://chat.example.test/socket" },
  release: { client: "client-r1", server: "server-r1", shard: "alpha" },
  characterId: "char-1",
  expiresAt: now + 30_000,
});

beforeEach(() => clearConsumedLaunchesForTests());

describe("standalone launch context", () => {
  it("requires exact schema, schemes, origins, releases, and live expiry with bounded clock-skew allowance", () => {
    const value = context();
    expect(validateStandaloneLaunchContext(value, {
      now,
      clientReleaseId: "client-r1",
      serverReleaseId: "server-r1",
      gameOrigin: "wss://game.example.test",
      chatOrigin: "wss://chat.example.test",
    })).toMatchObject({ characterId: "char-1" });
    expect(validateStandaloneLaunchContext({ ...value, schema: "successor.launch.v0" }, { now })).toBeNull();
    expect(validateStandaloneLaunchContext({ ...value, endpoints: { ...value.endpoints, game: "https://game.example.test" } }, { now })).toBeNull();
    expect(validateStandaloneLaunchContext(value, { now, gameOrigin: "wss://evil.example.test" })).toBeNull();
    // Ordinary ~30s remaining is valid; exact expiry/past is fail-closed.
    expect(validateStandaloneLaunchContext({ ...value, expiresAt: now + 30_000 }, { now })).not.toBeNull();
    expect(validateStandaloneLaunchContext({ ...value, expiresAt: now - 1 }, { now })).toBeNull();
    expect(validateStandaloneLaunchContext({ ...value, expiresAt: now }, { now })).toBeNull();
    // Small host/server skew just above the 45s mint TTL stays valid; beyond 50s is rejected.
    expect(validateStandaloneLaunchContext({ ...value, expiresAt: now + 45_083 }, { now })).not.toBeNull();
    expect(validateStandaloneLaunchContext({ ...value, expiresAt: now + 50_000 }, { now })).not.toBeNull();
    expect(validateStandaloneLaunchContext({ ...value, expiresAt: now + 50_001 }, { now })).toBeNull();
    expect(validateStandaloneLaunchContext({ ...value, release: { ...value.release, server: "server-r2" } }, { now, serverReleaseId: "server-r1" })).toBeNull();
  });

  it("accepts only structured-clone plain objects and exact postMessage shape", () => {
    const message = { type: "successor.launch.v1", launch: context() };
    expect(validateStandaloneLaunchMessage(message, { now })).not.toBeNull();
    expect(validateStandaloneLaunchMessage({ ...message, type: "successor.launch.v2" }, { now })).toBeNull();
    expect(validateStandaloneLaunchMessage(Object.create({ ...message }), { now })).toBeNull();
    expect(validateStandaloneLaunchMessage({ ...message, launch: { ...message.launch, endpoints: Object.create(message.launch.endpoints) } }, { now })).toBeNull();
  });

  it("consumes once, and discard drops both capabilities so replay needs a new envelope", () => {
    const first = consumeStandaloneLaunchContext(context(), { now });
    expect(first?.gameTicket).toBe("game-secret");
    first?.discard();
    expect(first?.gameTicket).toBeUndefined();
    expect(first?.chatTicket).toBeUndefined();
    expect(consumeStandaloneLaunchContext(context(), { now })).toBeNull();
    expect(consumeStandaloneLaunchContext({ ...context(), gameTicket: "new-game", chatTicket: "new-chat" }, { now })).not.toBeNull();
  });
});
