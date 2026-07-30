import { describe, expect, it } from "vitest";
import { assertStandalonePersistenceEnabled, assertStandaloneSocketEndpoints, createRuntimeCloser } from "./index.js";

describe("runtime shutdown teardown", () => {
  it("stops sessions before durable shard close and stays safe when called twice", async () => {
    const events: string[] = [];
    const closeRuntime = createRuntimeCloser({
      stopHeartbeat: () => { events.push("heartbeat"); },
      closeSessions: async () => { events.push("sessions"); },
      closeShard: async () => { events.push("shard"); },
      closeDurableStores: () => { events.push("stores"); },
    });

    await Promise.all([closeRuntime(), closeRuntime()]);

    expect(events).toEqual(["heartbeat", "sessions", "shard", "stores"]);
  });

  it("flushes later teardown phases and reports the first failure", async () => {
    const events: string[] = [];
    const firstFailure = new Error("session close failed");
    const closeRuntime = createRuntimeCloser({
      stopHeartbeat: () => { events.push("heartbeat"); },
      closeSessions: async () => {
        events.push("sessions");
        throw firstFailure;
      },
      closeShard: async () => { events.push("shard"); },
      closeDurableStores: () => { events.push("stores"); },
    });

    await expect(closeRuntime()).rejects.toBe(firstFailure);
    expect(events).toEqual(["heartbeat", "sessions", "shard", "stores"]);
  });
});

describe("standalone durability startup fencing", () => {
  it("refuses standalone mode when shard persistence is disabled", () => {
    expect(() => assertStandalonePersistenceEnabled("standalone", false)).toThrow("durable shard persistence");
    expect(() => assertStandalonePersistenceEnabled("standalone", true)).not.toThrow();
    expect(() => assertStandalonePersistenceEnabled("legacy", false)).not.toThrow();
  });
});

describe("standalone socket endpoint cookie isolation", () => {
  it("refuses production game/chat endpoints on the storefront host", () => {
    expect(() => assertStandaloneSocketEndpoints(
      "https://www.successorgame.com",
      "wss://www.successorgame.com/game",
      "wss://chat.successorgame.com/chat",
      true,
    )).toThrow("must not share the storefront hostname");
  });

  it("accepts distinct game/chat hosts without requiring them to differ from each other", () => {
    expect(() => assertStandaloneSocketEndpoints(
      "https://www.successorgame.com",
      "wss://play.successorgame.com/game",
      "wss://play.successorgame.com/chat",
      true,
    )).not.toThrow();
  });
});
