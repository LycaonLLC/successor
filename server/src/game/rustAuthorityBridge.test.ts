import { describe, expect, it, vi } from "vitest";
import { fileURLToPath } from "url";
import * as path from "path";

import {
  buildRustAuthorityActorRequest,
  buildRustAuthorityBatchRequest,
  buildRustAuthorityRemoveActorRequest,
  buildRustAuthorityRelocateActorRequest,
  buildRustAuthorityBridgeRequest,
  buildRustAuthorityTickRequest,
  buildRustAuthorityDebugRequest,
  sanitizeRustAuthoritySlicePayload,
  RustAuthorityBridge,
  type RustAuthorityBridgeTickOutput,
} from "./rustAuthorityBridge.js";
import type { ClientCommandEnvelope } from "./protocol.js";


describe("RustAuthorityBridge", () => {
  it("passes collision bounds through to Rust launch, including solid:false structure props", () => {
    const payload = {
      schema: "successor.slice.v1",
      props: [
        {
          id: "client-only-house",
          solid: false,
          collisionBounds: [{ xMilli: 79, yMilli: 0, wMilli: 4842, hMilli: 295 }],
        },
        {
          id: "solid-cover",
          solid: true,
          collisionBounds: [{ xMilli: 0, yMilli: 0, wMilli: 1000, hMilli: 1000 }],
        },
      ],
    };

    const sanitized = sanitizeRustAuthoritySlicePayload(payload) as typeof payload;

    expect(sanitized).toBe(payload);
  });

  it("builds the Rust bridge request from the live client command envelope", () => {
    const envelope: ClientCommandEnvelope = {
      session: 2,
      player: 9,
      command_id: 17,
      issued_at_tick: 24,
      command: {
        QueueCombatAction: {
          action_id: "basic_shot",
          target_actor_id: "target",
        },
      },
    };

    const request = buildRustAuthorityBridgeRequest({
      requestId: 3,
      actorId: "player",
      envelope,
      areaInterestRadiusCells: 48,
      craftRollKey: "ab".repeat(32),
    });

    expect(request).toEqual({
      requestId: 3,
      config: {
        session: 2,
        player: 9,
        playerActorId: "player",
        areaInterestRadiusCells: 48,
        craftRollKey: "ab".repeat(32),
      },
      envelope,
    });
  });

  it("serializes TakeLootItem commands to the Rust bridge unchanged", () => {
    const envelope: ClientCommandEnvelope = {
      session: 4,
      player: 12,
      command_id: 18,
      issued_at_tick: 25,
      command: {
        TakeLootItem: {
          container: "cache:open-desert-cache-01",
          itemId: 1001,
          variantId: 7,
          quantity: 2,
        },
      },
    };

    const request = buildRustAuthorityBridgeRequest({
      requestId: 4,
      actorId: "player",
      envelope,
      areaInterestRadiusCells: 48,
    });

    expect(request.envelope.command).toEqual(envelope.command);
  });

  it("serializes group commands to the Rust bridge unchanged", () => {
    const inviteEnvelope: ClientCommandEnvelope = {
      session: 4,
      player: 12,
      command_id: 19,
      issued_at_tick: 26,
      command: { GroupInvite: { target_actor_id: "partner" } },
    };
    const acceptEnvelope: ClientCommandEnvelope = {
      session: 4,
      player: 13,
      command_id: 20,
      issued_at_tick: 27,
      command: { GroupAccept: {} },
    };
    const kickEnvelope: ClientCommandEnvelope = {
      session: 4,
      player: 12,
      command_id: 21,
      issued_at_tick: 28,
      command: { GroupKick: { target_actor_id: "partner" } },
    };

    for (const envelope of [inviteEnvelope, acceptEnvelope, kickEnvelope]) {
      const request = buildRustAuthorityBridgeRequest({
        requestId: envelope.command_id,
        actorId: "player",
        envelope,
        areaInterestRadiusCells: 48,
      });
      expect(request.envelope.command).toEqual(envelope.command);
    }
  });

  it("can override client ids with server-owned Rust authority ids", () => {
    const envelope: ClientCommandEnvelope = {
      session: 1,
      player: 1,
      command_id: 4,
      issued_at_tick: 24,
      command: { Move: { dx: 1, dy: 0, duration_ticks: 8 } },
    };

    const request = buildRustAuthorityBridgeRequest({
      requestId: 9,
      actorId: "player",
      envelope,
      session: 3,
      player: 42,
    });

    expect(request.config).toMatchObject({
      session: 3,
      player: 42,
      playerActorId: "player",
    });
    expect(request.envelope.session).toBe(3);
    expect(request.envelope.player).toBe(42);
  });

  it("builds a Rust bridge tick request without a client command", () => {
    const request = buildRustAuthorityTickRequest({
      requestId: 13,
      ticks: 1,
      actorId: "__server_tick_observer__",
      areaInterestRadiusCells: 64,
      craftRollKey: "cd".repeat(32),
    });

    expect(request).toEqual({
      type: "tick",
      requestId: 13,
      ticks: 1,
      includeAiDebug: false,
      config: {
        session: 0,
        player: 0,
        playerActorId: "__server_tick_observer__",
        areaInterestRadiusCells: 64,
        craftRollKey: "cd".repeat(32),
      },
      weatherHazards: [],
    });
  });

  it("normalizes weather hazards on Rust bridge tick requests", () => {
    const request = buildRustAuthorityTickRequest({
      requestId: 15,
      ticks: 1,
      actorId: "__server_tick_observer__",
      weatherHazards: [{
        areaId: "open-desert-overworld",
        centerXMilli: 512_900.8,
        centerYMilli: 511_200.2,
        radiusMilli: 48_999.7,
        dpsMilliHealth: 8_000.9,
        shelters: [{ minXMilli: 10.9, minYMilli: 20.9, maxXMilli: 30.9, maxYMilli: 40.9 }],
      }],
    });

    expect(request.weatherHazards).toEqual([{
      areaId: "open-desert-overworld",
      centerXMilli: 512_900,
      centerYMilli: 511_200,
      radiusMilli: 48_999,
      dpsMilliHealth: 8_000,
      shelters: [{ minXMilli: 10, minYMilli: 20, maxXMilli: 30, maxYMilli: 40 }],
    }]);
  });

  it("preserves normalized weather hazards at their individual virtual tick boundaries", () => {
    const request = buildRustAuthorityTickRequest({
      requestId: 16,
      ticks: 2,
      actorId: "__server_tick_observer__",
      weatherHazardsByTick: [
        [{ areaId: "open-desert-overworld", centerXMilli: 100.9, centerYMilli: 200.9, radiusMilli: 300.9, dpsMilliHealth: 400.9, shelters: [] }],
        [{ areaId: "open-desert-overworld", centerXMilli: 101.9, centerYMilli: 201.9, radiusMilli: 301.9, dpsMilliHealth: 401.9, shelters: [] }],
      ],
    });

    expect(request.weatherHazardsByTick).toEqual([
      [{ areaId: "open-desert-overworld", centerXMilli: 100, centerYMilli: 200, radiusMilli: 300, dpsMilliHealth: 400, shelters: [] }],
      [{ areaId: "open-desert-overworld", centerXMilli: 101, centerYMilli: 201, radiusMilli: 301, dpsMilliHealth: 401, shelters: [] }],
    ]);
  });

  it("rejects a weather schedule that cannot cover every requested batch tick", () => {
    expect(() => buildRustAuthorityTickRequest({
      requestId: 17,
      ticks: 2,
      actorId: "__server_tick_observer__",
      weatherHazardsByTick: [[]],
    })).toThrow(/weatherHazardsByTick length must equal ticks/u);
  });

  it("preserves an explicit batched tick count for manual clock advances", () => {
    const request = buildRustAuthorityTickRequest({
      requestId: 14,
      ticks: 4,
      actorId: "__server_tick_observer__",
      areaInterestRadiusCells: 64,
    });

    expect(request).toMatchObject({
      type: "tick",
      requestId: 14,
      ticks: 4,
      config: { playerActorId: "__server_tick_observer__" },
    });
  });

  it("can request AI debug through an explicit Rust bridge debug request", () => {
    expect(buildRustAuthorityDebugRequest({ requestId: 14 })).toEqual({
      type: "debug",
      requestId: 14,
    });
  });

  it("builds Rust bridge actor lifecycle requests", () => {
    const upsert = buildRustAuthorityActorRequest({
      requestId: 14,
      actor: {
        id: "remote-actor",
        areaId: "authority-test-overworld",
        x: 5.9,
        y: 7.1,
        direction: "right",
        bareStart: true,
        returning: true,
        professionIds: ["combat", "scout"],
        activeTitleId: "scout-novice",
        capabilities: ["debug:bridge_capability", "combat:ranged_basic"],
        factionId: "red_crew",
        socialGroup: "red_squad",
        pvpStatus: "overt",
      },
    });
    const remove = buildRustAuthorityRemoveActorRequest({ requestId: 15, actorId: "remote-actor" });
    const purge = buildRustAuthorityRemoveActorRequest({
      requestId: 16,
      actorId: "retired-actor",
      purgeInventory: true,
    });
    const relocate = buildRustAuthorityRelocateActorRequest({
      requestId: 17,
      actorId: "remote-actor",
      areaId: "verdance-forest-overworld",
      x: 512.9,
      y: 511.2,
      direction: "front",
    });

    expect(upsert).toEqual({
      type: "upsertActor",
      requestId: 14,
      actor: {
        id: "remote-actor",
        areaId: "authority-test-overworld",
        x: 5,
        y: 7,
        direction: "right",
        bareStart: true,
        returning: true,
        professionIds: ["combat", "scout"],
        activeTitleId: "scout-novice",
        capabilities: ["debug:bridge_capability", "combat:ranged_basic"],
        factionId: "red_crew",
        socialGroup: "red_squad",
        pvpStatus: "overt",
      },
    });
    expect(remove).toEqual({
      type: "removeActor",
      requestId: 15,
      actorId: "remote-actor",
    });
    expect(purge).toEqual({
      type: "removeActor",
      requestId: 16,
      actorId: "retired-actor",
      purgeInventory: true,
    });
    expect(relocate).toEqual({
      type: "relocateActor",
      requestId: 17,
      actorId: "remote-actor",
      areaId: "verdance-forest-overworld",
      x: 512,
      y: 511,
      direction: "front",
    });
  });

  it("builds a Rust bridge command batch request", () => {
    const first: ClientCommandEnvelope = {
      session: 1,
      player: 1,
      command_id: 21,
      issued_at_tick: 24,
      command: { Move: { dx: 1, dy: 0, duration_ticks: 8 } },
    };
    const second: ClientCommandEnvelope = {
      session: 1,
      player: 1,
      command_id: 22,
      issued_at_tick: 25,
      command: { Move: { dx: 0, dy: 1, duration_ticks: 8 } },
    };
    const steps = [
      buildRustAuthorityBridgeRequest({ requestId: 21, actorId: "player", envelope: first }),
      buildRustAuthorityBridgeRequest({ requestId: 22, actorId: "player", envelope: second }),
    ];

    expect(buildRustAuthorityBatchRequest({ requestId: 20, steps })).toEqual({
      type: "batch",
      requestId: 20,
      steps,
    });
  });

  it("preserves an immediate SurveyResource result from a Rust command batch unchanged", async () => {
    vi.useFakeTimers();
    try {
      const here = path.dirname(fileURLToPath(import.meta.url));
      const slicePath = path.resolve(here, "../../../client/public/successor-slice/open-desert-slice.json");
      const bridge = new RustAuthorityBridge({
        enabled: true,
        slicePath,
        command: "tail",
        args: ["-f", "/dev/null"],
      });
      const surveyResult = {
        family: "metal",
        areaId: "authority-test-overworld",
        spawnId: "resource:authority-test-overworld:iron",
        spawnName: "Iron Vein",
        centerX: 24,
        centerY: 56,
        rangeCells: 24,
        stepCells: 12,
        cols: 5,
        rows: 5,
        concentrationMilli: [1000, 950, 900, 850, 800, 950, 900, 850, 800, 750, 900, 850, 800, 750, 700, 850, 800, 750, 700, 650, 800, 750, 700, 650, 600],
        cooldownUntilTick: 300,
        tick: 0,
      };
      const promise = bridge.submitCommand({
        actorId: "player",
        envelope: {
          session: 1,
          player: 1,
          command_id: 201,
          issued_at_tick: 0,
          command: { SurveyResource: { family: "mineral" } },
        },
        timeoutMs: 100,
      });

      vi.advanceTimersByTime(1);
      const batches = bridge["commandBatches"];
      const batchRequestId = Array.from(batches.keys())[0]!;
      const stepRequestId = batches.get(batchRequestId)![0]!.request.requestId;
      bridge["handleOutputLine"](JSON.stringify({
        schema: "successor.rust-authority-bridge-batch.v1",
        requestId: batchRequestId,
        steps: [{
          schema: "successor.rust-authority-bridge-step.v1",
          requestId: stepRequestId,
          status: "accepted",
          applied: true,
          surveyResult,
        }],
      }));

      const result = await promise;
      expect(result.surveyResult).toEqual(surveyResult);
      expect(result).not.toHaveProperty("survey_result");
      bridge.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("retains command in batch on post-write timeout and resolves with late accepted Rust reply", async () => {
    vi.useFakeTimers();
    try {
      const here = path.dirname(fileURLToPath(import.meta.url));
      const slicePath = path.resolve(here, "../../../client/public/successor-slice/open-desert-slice.json");
      const bridge = new RustAuthorityBridge({
        enabled: true,
        slicePath,
        command: "tail",
        args: ["-f", "/dev/null"],
      });

      const envelope: ClientCommandEnvelope = {
        session: 1,
        player: 1,
        command_id: 101,
        issued_at_tick: 24,
        command: { Move: { dx: 1, dy: 0, duration_ticks: 8 } },
      };

      const promise = bridge.submitCommand({ actorId: "actor:1", envelope, timeoutMs: 100 });

      // Wait for flushCommandBatch (setImmediate)
      vi.advanceTimersByTime(1);

      // Verify batch written
      const batchesMap = bridge["commandBatches"];
      expect(batchesMap.size).toBe(1);
      const batchRequestId = Array.from(batchesMap.keys())[0]!;
      const batchItems = batchesMap.get(batchRequestId)!;
      expect(batchItems.length).toBe(1);
      const stepRequestId = batchItems[0]!.request.requestId;
      expect(batchItems[0]!.batchRequestId).toBe(batchRequestId);

      // Wait beyond the 100ms timeout
      vi.advanceTimersByTime(150);

      // Assert promise has not rejected/resolved yet (remains pending)
      let settled = false;
      promise.then(() => { settled = true; }, () => { settled = true; });
      interface PromiseResolvers<T> {
        promise: Promise<T>;
        resolve: (value: T | PromiseLike<T>) => void;
        reject: (reason?: unknown) => void;
      }
      // Cast Promise constructor since target library is ES2022 and lacks withResolvers typing
      const typedPromise = Promise as unknown as {
        withResolvers: <T>() => PromiseResolvers<T>;
      };
      const resolvers = typedPromise.withResolvers<void>();
      resolvers.resolve();
      await resolvers.promise;
      expect(settled).toBe(false);

      // Assert batch/backlog still tracks one
      expect(bridge.debugStatus().commandBatchPendingItems).toBe(1);
      expect(bridge.debugStatus().backlogSize).toBe(1);
      expect(batchesMap.size).toBe(1);

      // Emit accepted Rust batch reply
      const stepOutput = {
        schema: "successor.rust-authority-bridge-step.v1",
        requestId: stepRequestId,
        status: "accepted" as const,
        applied: true,
        targetStateHash: "abc",
      };
      const batchOutput = {
        schema: "successor.rust-authority-bridge-batch.v1",
        requestId: batchRequestId,
        steps: [stepOutput],
      };

      bridge["handleOutputLine"](JSON.stringify(batchOutput));

      // Assert promise resolves accepted, no interim failure
      const result = await promise;
      expect(result).toMatchObject({ status: "accepted", applied: true });

      // Assert commandBatches/pending items become zero
      expect(batchesMap.size).toBe(0);
      expect(bridge.debugStatus().commandBatchPendingItems).toBe(0);
      expect(bridge.debugStatus().backlogSize).toBe(0);

      bridge.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("retains command in batch on post-write timeout and resolves with late rejected Rust reply", async () => {
    vi.useFakeTimers();
    try {
      const here = path.dirname(fileURLToPath(import.meta.url));
      const slicePath = path.resolve(here, "../../../client/public/successor-slice/open-desert-slice.json");
      const bridge = new RustAuthorityBridge({
        enabled: true,
        slicePath,
        command: "tail",
        args: ["-f", "/dev/null"],
      });

      const envelope: ClientCommandEnvelope = {
        session: 1,
        player: 1,
        command_id: 102,
        issued_at_tick: 24,
        command: { Move: { dx: 1, dy: 0, duration_ticks: 8 } },
      };

      const promise = bridge.submitCommand({ actorId: "actor:1", envelope, timeoutMs: 100 });

      // Wait for flushCommandBatch
      vi.advanceTimersByTime(1);

      const batchesMap = bridge["commandBatches"];
      const batchRequestId = Array.from(batchesMap.keys())[0]!;
      const batchItems = batchesMap.get(batchRequestId)!;
      const stepRequestId = batchItems[0]!.request.requestId;

      // Wait beyond timeout
      vi.advanceTimersByTime(150);

      // Emit rejected Rust batch reply late
      const stepOutput = {
        schema: "successor.rust-authority-bridge-step.v1",
        requestId: stepRequestId,
        status: "rejected" as const,
        reasonCode: "sample_cooldown",
        applied: false,
      };
      const batchOutput = {
        schema: "successor.rust-authority-bridge-batch.v1",
        requestId: batchRequestId,
        steps: [stepOutput],
      };

      bridge["handleOutputLine"](JSON.stringify(batchOutput));

      // Assert real reject receipt/output resolves, not transport timeout
      const result = await promise;
      expect(result).toMatchObject({ status: "rejected", reasonCode: "sample_cooldown", applied: false });

      // Assert batch/backlog are cleared
      expect(batchesMap.size).toBe(0);
      expect(bridge.debugStatus().commandBatchPendingItems).toBe(0);

      bridge.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("safely rejects pre-write timeout commands and does not write them", async () => {
    vi.useFakeTimers();
    try {
      const here = path.dirname(fileURLToPath(import.meta.url));
      const slicePath = path.resolve(here, "../../../client/public/successor-slice/open-desert-slice.json");
      const bridge = new RustAuthorityBridge({
        enabled: true,
        slicePath,
        command: "tail",
        args: ["-f", "/dev/null"],
      });

      const envelope: ClientCommandEnvelope = {
        session: 1,
        player: 1,
        command_id: 103,
        issued_at_tick: 24,
        command: { Move: { dx: 1, dy: 0, duration_ticks: 8 } },
      };

      // Prevent automatic flush to simulate event loop delay / pre-write state
      const originalSchedule = bridge["scheduleCommandBatchFlush"];
      bridge["scheduleCommandBatchFlush"] = () => {};

      // Set timeout to 1ms
      const promise = bridge.submitCommand({ actorId: "actor:1", envelope, timeoutMs: 1 });

      const writeSpy = vi.spyOn(bridge["child"].stdin, "write");

      // Advance timers by 2ms so the timeout callback fires
      vi.advanceTimersByTime(2);

      // Assert promise is rejected with timeout
      await expect(promise).rejects.toThrow("rust authority bridge request timed out");

      // Restore original flush scheduler and run flush manually
      bridge["scheduleCommandBatchFlush"] = originalSchedule;
      bridge["flushCommandBatch"]();

      // Assert it was never written to child stdin
      expect(writeSpy).not.toHaveBeenCalled();

      // Assert commandBatch is empty and commandBatches map has no entries
      expect(bridge["commandBatch"].length).toBe(0);
      expect(bridge["commandBatches"].size).toBe(0);

      bridge.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects delayed in-flight commands and clears batch on child exit or error", async () => {
    vi.useFakeTimers();
    try {
      const here = path.dirname(fileURLToPath(import.meta.url));
      const slicePath = path.resolve(here, "../../../client/public/successor-slice/open-desert-slice.json");
      const bridge = new RustAuthorityBridge({
        enabled: true,
        slicePath,
        command: "tail",
        args: ["-f", "/dev/null"],
      });

      const envelope: ClientCommandEnvelope = {
        session: 1,
        player: 1,
        command_id: 104,
        issued_at_tick: 24,
        command: { Move: { dx: 1, dy: 0, duration_ticks: 8 } },
      };

      const promise = bridge.submitCommand({ actorId: "actor:1", envelope, timeoutMs: 100 });

      // Wait for flushCommandBatch
      vi.advanceTimersByTime(1);

      // Wait beyond timeout (delayed in-flight)
      vi.advanceTimersByTime(150);

      // Emit child exit
      bridge["child"].emit("exit", 1, null);

      // Assert promise is rejected with exit error
      await expect(promise).rejects.toThrow("rust authority bridge exited: code=1 signal=null");

      // Assert batch is cleared
      expect(bridge["commandBatches"].size).toBe(0);
      expect(bridge.debugStatus().commandBatchPendingItems).toBe(0);

      bridge.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("counts delayed in-flight commands towards the backlog limit to prevent unbounded growth", async () => {
    vi.useFakeTimers();
    try {
      const here = path.dirname(fileURLToPath(import.meta.url));
      const slicePath = path.resolve(here, "../../../client/public/successor-slice/open-desert-slice.json");
      const bridge = new RustAuthorityBridge({
        enabled: true,
        slicePath,
        command: "tail",
        args: ["-f", "/dev/null"],
      });

      const envelope: ClientCommandEnvelope = {
        session: 1,
        player: 1,
        command_id: 105,
        issued_at_tick: 24,
        command: { Move: { dx: 1, dy: 0, duration_ticks: 8 } },
      };

      // Submit 8192 commands and catch their rejections to avoid unhandled rejection errors on close
      const promises = [];
      for (let i = 0; i < 8192; i++) {
        const p = bridge.submitCommand({ actorId: "actor:1", envelope, timeoutMs: 10 });
        p.catch(() => {});
        promises.push(p);
      }

      // Flush them all to child stdin
      vi.advanceTimersByTime(1);

      // Let their timeouts pass so they become delayed in-flight
      vi.advanceTimersByTime(15);

      // Verify backlog size is 8192
      expect(bridge.debugStatus().backlogSize).toBe(8192);

      // Submit 8193rd command - it should reject immediately with backlog full error
      await expect(bridge.submitCommand({ actorId: "actor:1", envelope })).rejects.toThrow(
        "rust authority bridge backlog is full"
      );

      bridge.close();
    } finally {
      vi.useRealTimers();
    }
  }, 15_000);

  it("deserializes inventory resourceStats from bridge child process output", () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const slicePath = path.resolve(here, "../../../client/public/successor-slice/open-desert-slice.json");
    const bridge = new RustAuthorityBridge({
      enabled: true,
      slicePath,
      command: "tail",
      args: ["-f", "/dev/null"],
    });

    const mockOutput = {
      schema: "successor.rust-authority-bridge-step.v1",
      requestId: 42,
      actor: null,
      inventory: [
        {
          container: "player:field-pack",
          stackId: 1,
          item: "Copper",
          itemId: 2007,
          variantId: 221001,
          quantity: 24,
          reserved: 0,
          available: 24,
          resourceStats: {
            conductivity: 950,
            malleability: 450,
            shock_resistance: 10,
            thermal_resistance: 20,
            chemical_purity: 0,
            density: 0,
            tensile_strength: 0,
            flexibility: 0,
            potency: 0,
            nutrition: 0,
            stability: 0,
            extraction_yield: 600,
          },
        },
        {
          container: "player:field-pack",
          stackId: 2,
          item: "Carbon",
          itemId: 2008,
          variantId: 266666,
          quantity: 10,
          reserved: 0,
          available: 10,
          resourceStats: {
            conductivity: 100,
            malleability: 200,
            shock_resistance: 300,
            thermal_resistance: 400,
            chemical_purity: 500,
            density: 600,
            tensile_strength: 700,
            flexibility: 800,
            potency: 900,
            nutrition: 100,
            stability: 200,
            extraction_yield: 300,
          },
        },
        {
          container: "player:field-pack",
          stackId: 3,
          item: "Fuel",
          itemId: 2009,
          variantId: 47123456,
          quantity: 5,
          reserved: 0,
          available: 5,
          resourceStats: {
            conductivity: 10,
            malleability: 20,
            shock_resistance: 30,
            thermal_resistance: 40,
            chemical_purity: 50,
            density: 60,
            tensile_strength: 70,
            flexibility: 80,
            potency: 90,
            nutrition: 100,
            stability: 110,
            extraction_yield: 120,
          },
        },
        {
          container: "player:field-pack",
          stackId: 4,
          item: "Polymer",
          itemId: 2010,
          variantId: 48123456,
          quantity: 8,
          reserved: 0,
          available: 8,
          resourceStats: {
            conductivity: 11,
            malleability: 22,
            shock_resistance: 33,
            thermal_resistance: 44,
            chemical_purity: 55,
            density: 66,
            tensile_strength: 77,
            flexibility: 88,
            potency: 99,
            nutrition: 111,
            stability: 222,
            extraction_yield: 333,
          },
        },
        {
          container: "player:field-pack",
          stackId: 5,
          item: "Clodpowder",
          itemId: 2006,
          variantId: 99,
          quantity: 1,
          reserved: 0,
          available: 1,
          resourceStats: {
            conductivity: 1,
            malleability: 2,
            shock_resistance: 3,
            thermal_resistance: 4,
            chemical_purity: 5,
            density: 6,
            tensile_strength: 7,
            flexibility: 8,
            potency: 9,
            nutrition: 10,
            stability: 11,
            extraction_yield: 12,
          },
        },
        {
          container: "player:field-pack",
          stackId: 6,
          item: "Clodpowder",
          itemId: 2006,
          variantId: 46072101,
          quantity: 2,
          reserved: 0,
          available: 2,
          resourceStats: {
            conductivity: 2,
            malleability: 4,
            shock_resistance: 6,
            thermal_resistance: 8,
            chemical_purity: 10,
            density: 12,
            tensile_strength: 14,
            flexibility: 16,
            potency: 18,
            nutrition: 20,
            stability: 22,
            extraction_yield: 24,
          },
        },
      ],
    };

    const resolvers = {
      resolve: vi.fn(),
      reject: vi.fn(),
      // Mock Timeout to satisfy NodeJS.Timeout without running a real timer or using 'any'
      timeout: {
        ref() { return this; },
        unref() { return this; },
        hasRef() { return true; },
        refresh() { return this; },
        [Symbol.toPrimitive]() { return 0; }
      } as unknown as NodeJS.Timeout,
      requestType: "step",
      startedAtMs: Date.now(),
    };

    bridge["livePending"].set(42, resolvers);
    bridge["handleOutputLine"](JSON.stringify(mockOutput));

    expect(resolvers.resolve).toHaveBeenCalledWith(mockOutput);
    const resolvedOutput = resolvers.resolve.mock.calls[0] ? resolvers.resolve.mock.calls[0][0] as RustAuthorityBridgeTickOutput : undefined;
    expect(resolvedOutput).toBeDefined();
    if (resolvedOutput) {
      const inventory = resolvedOutput.inventory;
      expect(inventory).toBeDefined();
      expect(inventory?.length).toBe(6);

      // Verify Copper
      const copper = inventory?.find(r => r.itemId === 2007);
      expect(copper).toBeDefined();
      expect(copper?.resourceStats?.conductivity).toBe(950);
      expect(copper?.resourceStats?.extraction_yield).toBe(600);
      expect(copper?.resourceStats?.flexibility).toBe(0);

      // Verify Carbon
      const carbon = inventory?.find(r => r.itemId === 2008);
      expect(carbon).toBeDefined();
      expect(carbon?.resourceStats?.conductivity).toBe(100);
      expect(carbon?.resourceStats?.flexibility).toBe(800);

      // Verify Fuel
      const fuel = inventory?.find(r => r.itemId === 2009);
      expect(fuel).toBeDefined();
      expect(fuel?.resourceStats?.conductivity).toBe(10);
      expect(fuel?.resourceStats?.flexibility).toBe(80);

      // Verify Polymer
      const polymer = inventory?.find(r => r.itemId === 2010);
      expect(polymer).toBeDefined();
      expect(polymer?.resourceStats?.conductivity).toBe(11);
      expect(polymer?.resourceStats?.flexibility).toBe(88);

      // Verify Legacy Clodpowder
      const legacyResource = inventory?.find(r => r.itemId === 2006 && r.variantId === 99);
      expect(legacyResource).toBeDefined();
      expect(legacyResource?.resourceStats?.conductivity).toBe(1);
      expect(legacyResource?.resourceStats?.flexibility).toBe(8);

      // Verify Encoded Clodpowder
      const encodedResource = inventory?.find(r => r.itemId === 2006 && r.variantId === 46072101);
      expect(encodedResource).toBeDefined();
      expect(encodedResource?.resourceStats?.conductivity).toBe(2);
      expect(encodedResource?.resourceStats?.flexibility).toBe(16);
    }

    bridge.close();
  });

});
