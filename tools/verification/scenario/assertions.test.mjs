import { describe, expect, it } from "vitest";

import {
  assertComparison,
  assertMatch,
  compactOracleForDigest,
  findInventoryRow,
  getPath,
  interpolate,
  matchObject,
  resolveValue,
  sha256Json,
} from "./assertions.mjs";

describe("scenario assertion helpers", () => {
  it("reads dot paths and resolves capture variables in matches", () => {
    const envelope = { type: "receipt", commandId: 7, accepted: true, data: { event: { lifecycle: "fired" } } };
    const context = { captures: { queued: { data: { commandId: 7 } } }, vars: {}, actors: {} };

    expect(getPath(envelope, "data.event.lifecycle")).toBe("fired");
    expect(matchObject(envelope, {
      commandId: "$captures.queued.data.commandId",
      accepted: true,
      "data.event.lifecycle": "fired",
    }, context).ok).toBe(true);
    expect(() => assertMatch(envelope, { accepted: false }, context, "receipt")).toThrow(/receipt failed/u);
  });
  it("matches exact nested arrays by value", () => {
    expect(matchObject({
      data: { roster: [{ actorId: "beta", permissions: ["invite", "war"] }] },
    }, {
      "data.roster": {
        includesObject: { actorId: "beta", permissions: ["invite", "war"] },
      },
    }).ok).toBe(true);
  });


  it("matches array membership with includesObject and excludesObject rules", () => {
    const snapshot = {
      data: {
        actors: [
          { id: "alpha", lifeState: "alive", relation: "friendly" },
          { id: "beta", lifeState: "alive", relation: "hostile" },
        ],
      },
    };

    expect(matchObject(snapshot, {
      "data.actors": {
        includesObject: { id: "beta", relation: "hostile" },
      },
    }).ok).toBe(true);
    expect(matchObject(snapshot, {
      "data.actors": {
        excludesObject: { id: "gamma" },
      },
    }).ok).toBe(true);
    expect(matchObject(snapshot, {
      "data.actors": {
        excludesObject: { relation: "hostile" },
      },
    }).ok).toBe(false);
  });

  it("resolves full $captures tokens and rejects leading-dot capture typos", () => {
    const context = {
      captures: {
        batteryExtractorCollectableAtCollection: { tick: 2191, collectableUnits: 22 },
      },
      vars: {},
      actors: {},
    };
    expect(resolveValue("$captures.batteryExtractorCollectableAtCollection.tick", context)).toBe(2191);
    // A leading-dot typo is not a capture token; resolveValue must leave it literal so Number() becomes NaN upstream.
    expect(resolveValue(".batteryExtractorCollectableAtCollection.tick", context)).toBe(".batteryExtractorCollectableAtCollection.tick");
    expect(Number(resolveValue(".batteryExtractorCollectableAtCollection.tick", context))).toBeNaN();
  });
  it("compares numeric and length operators and interpolates scenario variables", () => {
    expect(() => assertComparison({ actual: 4.2, op: "gte", expected: 4, label: "distance" })).not.toThrow();
    expect(() => assertComparison({ actual: 4, op: "lte", expected: 4, label: "deadline" })).not.toThrow();
    expect(() => assertComparison({ actual: 5, op: "lte", expected: 4, label: "deadline" })).toThrow(/deadline expected lte/u);
    expect(() => assertComparison({ actual: ["a", "b"], op: "length", expected: 2, label: "roster" })).not.toThrow();
    expect(interpolate("/loot corpse:$last_kill $captures.row.itemId", {
      vars: { last_kill: "rogue-1" },
      captures: { row: { itemId: 1101 } },
    })).toBe("/loot corpse:rogue-1 1101");
  });

  it("finds inventory rows and hashes compact oracle snapshots stably", () => {
    const oracle = {
      schema: "successor.game-shard-oracle.v1",
      shardId: "s",
      source: { stateHash: "fixture" },
      counters: { acceptedCommands: 1 },
      actors: { b: { id: "b", x: 2, y: 3, lifeState: "alive" }, a: { id: "a", x: 1, y: 1, lifeState: "downed" } },
      inventory: [
        { container: "corpse:a", item: "Iron Slug", itemId: 1101, variantId: 0, quantity: 3, available: 3, reserved: 0 },
      ],
    };

    expect(findInventoryRow(oracle, { container: "corpse:$last_kill", itemId: 1101, minAvailable: 1 }, { vars: { last_kill: "a" } })).toMatchObject({ available: 3 });
    const left = sha256Json(compactOracleForDigest(oracle));
    const right = sha256Json(compactOracleForDigest({
      ...oracle,
      shardId: "different-run-id",
      counters: { ...oracle.counters, packetsOut: 99, bytesOut: 123456 },
      actors: { a: oracle.actors.a, b: oracle.actors.b },
    }));
    expect(left).toBe(right);
  });
});
