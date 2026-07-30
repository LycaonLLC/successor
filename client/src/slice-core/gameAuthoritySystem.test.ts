import { describe, expect, it, vi } from "vitest";
import type { SfxPlayOptions, SfxPlayer, SfxPoint } from "../audio/sfx";
import { createPlayState, type ActorSnapshot, type SliceSnapshot } from "./gameState";
import {
  enqueueAuthorityCommand,
  enqueueAuthorityPlantSeedCommand,
  enqueueAuthorityTillTileCommand,
  enqueueAuthoritySetEquippedClothingCommand,
  enqueueAuthorityWaterTileCommand,
  settleAuthorityCommand,
} from "./authorityCommandSystem";
import { clearCampDoorState, registerCampCollisionProfile, setCampDoorOpen } from "./campSystem";
import {
  applyAuthoritativeDelta,
  applyServerPacket,
  drainAbilityQueueEvents,
  flushGameAuthorityCommands,
  gameAuthorityLaunchFailureForLeave,
} from "./gameAuthoritySystem";
import { actorTargetSummary } from "./selectionSystem";

const player: ActorSnapshot = {
  id: "player",
  entity: "actor.player",
  areaId: "open-desert-overworld",
  label: "Field Observer",
  role: "player",
  sprite: "adventurer-premium-male",
  poseSet: "idle",
  direction: "right",
  cell: { x: 4, y: 5 },
  route: [],
};

const vendor: ActorSnapshot = {
  id: "vendor",
  entity: "actor.vendor",
  areaId: "open-desert-overworld",
  label: "Warden",
  role: "public_shopkeeper",
  sprite: "adventurer-premium-male",
  poseSet: "idle",
  direction: "front",
  cell: { x: 8, y: 5 },
  route: [],
};

describe("gameAuthoritySystem", () => {
  it("classifies an intentional same-character replacement as a terminal hosted launch failure", () => {
    expect(gameAuthorityLaunchFailureForLeave(4000, "game session replaced")).toBe("session-replaced");
    expect(gameAuthorityLaunchFailureForLeave(4000, "other reason")).toBeNull();
    expect(gameAuthorityLaunchFailureForLeave(1006, "game session replaced")).toBeNull();
  });

  it("records matching server source metadata from hello snapshots", () => {
    const sliceSnapshot = slice();
    const state = createPlayState(sliceSnapshot);

    applyServerPacket(state, sliceSnapshot, {
      type: "game.hello",
      sessionId: "g_1",
      playerActorId: "player",
      serverTime: "1970-01-01T00:00:00.000Z",
      snapshot: shardSnapshot({
        sourceStateHash: "hash",
        sourceActorCount: 2,
      }),
    }, sfxRecorder());

    expect(state.serverAuthority.sourceStateHash).toBe("hash");
    expect(state.serverAuthority.sourceActorCount).toBe(2);
    expect(state.serverAuthority.sourceMatchesClient).toBe(true);
  });

  it("retains Rust clothing equipped and colors fields across snapshots and deltas", () => {
    const sliceSnapshot = slice();
    const state = createPlayState(sliceSnapshot);
    const clothing = {
      container: "player:clothing",
      item: "Rigged Tank",
      itemId: 5_001,
      variantId: 7,
      quantity: 1,
      reserved: 0,
      available: 1,
      equipped: true,
      colors: ["#112233", "#445566"],
    };

    applyServerPacket(state, sliceSnapshot, {
      type: "game.hello",
      sessionId: "g_1",
      playerActorId: "player",
      serverTime: "1970-01-01T00:00:00.000Z",
      snapshot: shardSnapshot({
        sourceStateHash: "hash",
        sourceActorCount: 2,
        inventory: [clothing],
      }),
    }, sfxRecorder());

    expect(state.inventory).toEqual([clothing]);

    applyServerPacket(state, sliceSnapshot, {
      type: "game.delta",
      receipts: [],
      delta: {
        schema: "successor.authoritative-shard-delta.v1",
        shardId: "test",
        tick: 21,
        playerActorId: "player",
        actors: {},
        inventory: [{ ...clothing, equipped: false }],
        counters: counters(),
      },
      events: [],
    }, sfxRecorder());

    expect(state.inventory).toEqual([{ ...clothing, equipped: false }]);
    expect(state.inventory[0]?.colors).toEqual(["#112233", "#445566"]);
  });

  it("applies owning-session group views from snapshots and deltas", () => {
    const sliceSnapshot = slice();
    const state = createPlayState(sliceSnapshot);

    applyServerPacket(state, sliceSnapshot, {
      type: "game.hello",
      sessionId: "g_1",
      playerActorId: "player",
      serverTime: "1970-01-01T00:00:00.000Z",
      snapshot: shardSnapshot({
        groups: {
          group: {
            groupId: 7,
            leaderActorId: "player",
            createdTick: 20,
            memberActorIds: ["player", "vendor"],
          },
          members: [
            {
              actorId: "player",
              name: "Field Observer",
              areaId: "open-desert-overworld",
              vitals: { health: 91, action: 72, spirit: 63 },
              maxVitals: { health: 100, action: 100, spirit: 90 },
              lifeState: "alive",
              isLeader: true,
              linkDead: false,
            },
            {
              actorId: "vendor",
              name: "Warden",
              areaId: "open-desert-overworld",
              vitals: { health: 75, action: 80, spirit: 81 },
              maxVitals: { health: 100, action: 100, spirit: 100 },
              lifeState: "alive",
              isLeader: false,
              linkDead: false,
            },
          ],
        },
      }),
    }, sfxRecorder());

    expect(state.serverAuthority.group.group?.leaderActorId).toBe("player");
    expect(state.serverAuthority.group.members.map((member) => member.actorId)).toEqual(["player", "vendor"]);
    expect(state.serverAuthority.group.members[1]?.vitals.health).toBe(75);

    applyServerPacket(state, sliceSnapshot, {
      type: "game.delta",
      receipts: [],
      delta: {
        schema: "successor.authoritative-shard-delta.v1",
        shardId: "test",
        tick: 22,
        playerActorId: "player",
        actors: {},
        groups: {
          members: [],
          pendingInvite: {
            inviterActorId: "vendor",
            inviterName: "Warden",
            issuedTick: 21,
            expiresTick: 921,
          },
        },
        counters: counters(),
      },
      events: [],
    }, sfxRecorder());

    expect(state.serverAuthority.group.group).toBeUndefined();
    expect(state.serverAuthority.group.members).toEqual([]);
    expect(state.serverAuthority.group.pendingInvite?.inviterActorId).toBe("vendor");
  });

  it("applies owner ability queue views and drains lifecycle events once", () => {
    const sliceSnapshot = slice();
    const state = createPlayState(sliceSnapshot);

    applyServerPacket(state, sliceSnapshot, {
      type: "game.hello",
      sessionId: "g_1",
      playerActorId: "player",
      serverTime: "1970-01-01T00:00:00.000Z",
      snapshot: shardSnapshot({ sourceStateHash: "hash", sourceActorCount: 2 }),
    }, sfxRecorder());

    applyServerPacket(state, sliceSnapshot, {
      type: "game.delta",
      receipts: [],
      delta: {
        schema: "successor.authoritative-shard-delta.v1",
        shardId: "test",
        tick: 21,
        playerActorId: "player",
        actors: {},
        abilityQueue: {
          actorId: "player",
          nextReadyTick: 42,
          entries: [{
            id: "q2",
            abilityId: "aimed_shot",
            iconId: "aimed_shot",
            class: "combat",
            targetActorId: "vendor",
            lifecycle: "pending",
            enqueuedAtTick: 20,
            readyTick: 42,
          }],
          repeatIntent: {
            id: "q1",
            abilityId: "basic_shot",
            iconId: "basic_shot",
            class: "combat",
            targetActorId: "vendor",
            lifecycle: "pending",
            enqueuedAtTick: 19,
            readyTick: 42,
            fireSeq: 2,
          },
        },
        counters: counters(),
      },
      events: [],
      abilityQueueEvents: [{
        id: "q1",
        lifecycle: "fired",
        tick: 21,
        abilityId: "basic_shot",
        iconId: "basic_shot",
        fireSeq: 2,
      }],
    }, sfxRecorder());

    expect(state.abilityQueue.view?.actorId).toBe("player");
    expect(state.abilityQueue.view?.entries[0]).toMatchObject({
      id: "q2",
      abilityId: "aimed_shot",
      iconId: "aimed_shot",
      targetActorId: "vendor",
    });
    expect(state.abilityQueue.view?.repeatIntent?.fireSeq).toBe(2);
    expect(drainAbilityQueueEvents(state)).toEqual([{
      id: "q1",
      lifecycle: "fired",
      tick: 21,
      abilityId: "basic_shot",
      iconId: "basic_shot",
      fireSeq: 2,
    }]);
    expect(drainAbilityQueueEvents(state)).toEqual([]);
  });

  it("rebuilds door movement blockers when doorOpen prop-state mirrors flip", () => {
    const sliceSnapshot = slice();
    sliceSnapshot.props.push({
      id: "door-house",
      entity: "prop/door-house",
      areaId: "open-desert-overworld",
      label: "Door House",
      kind: "prop",
      cell: { x: 10, y: 4 },
      size: { w: 5, h: 4 },
      interactive: false,
      solid: false,
      door: { blocker: { xMilli: 2420, yMilli: 3705, wMilli: 1240, hMilli: 295 }, interactRadiusCells: 2.2 },
    });
    const state = createPlayState(sliceSnapshot);
    const doorBox = { left: 12.42, top: 7.705, right: 13.66, bottom: 8 };

    expect(state.movementBlockers).toContainEqual(doorBox);

    applyServerPacket(state, sliceSnapshot, {
      type: "game.hello",
      sessionId: "g_1",
      playerActorId: "player",
      serverTime: "1970-01-01T00:00:00.000Z",
      snapshot: shardSnapshot({
        sourceStateHash: "hash",
        sourceActorCount: 2,
        propStates: { "door-house": { doorOpen: true } },
      }),
    }, sfxRecorder());

    expect(state.movementBlockers).not.toContainEqual(doorBox);

    applyServerPacket(state, sliceSnapshot, {
      type: "game.delta",
      receipts: [],
      delta: {
        schema: "successor.authoritative-shard-delta.v1",
        shardId: "test",
        tick: 21,
        playerActorId: "player",
        actors: {},
        propStates: { "door-house": { doorOpen: false } },
        counters: counters(),
      },
      events: [],
    }, sfxRecorder());

    expect(state.movementBlockers).toContainEqual(doorBox);
  });

  it("syncs the local player loadout from explicit authoritative weapon state", () => {
    const sliceSnapshot = slice();
    const state = createPlayState(sliceSnapshot);
    const weapon = {
      weaponId: "slugthrower",
      ammoType: "slug_iron",
      loadedRounds: 17,
      magazineSize: 30,
      reloadUntilTick: 0,
      reloadRemainingTicks: 0,
      reloadTotalTicks: 1,
    };
    state.loadout.activeWeaponId = null;
    state.loadout.equipped.longGun = null;
    state.loadout.ammo["slug"] = { loaded: 0, reserve: 0 };

    applyServerPacket(state, sliceSnapshot, {
      type: "game.hello",
      sessionId: "g_1",
      playerActorId: "player",
      serverTime: "1970-01-01T00:00:00.000Z",
      snapshot: shardSnapshot({
        sourceStateHash: "hash",
        sourceActorCount: 2,
        actors: {
          player: { ...actorSnapshot("player", 4, 5), weapon: null },
          vendor: actorSnapshot("vendor", 8, 5),
        },
      }),
    }, sfxRecorder());

    expect(state.loadout.activeWeaponId).toBeNull();
    expect(state.loadout.equipped.longGun).toBeNull();
    expect(state.loadout.ammo["slug"].loaded).toBe(0);

    state.loadout.activeWeaponId = "slugthrower";
    state.loadout.equipped.longGun = "slugthrower";
    applyServerPacket(state, sliceSnapshot, {
      type: "game.delta",
      receipts: [],
      delta: {
        schema: "successor.authoritative-shard-delta.v1",
        shardId: "test",
        tick: 21,
        playerActorId: "player",
        actors: {
          player: { ...actorSnapshot("player", 4, 5), weapon: { ...weapon, loadedRounds: 16 } },
        },
        counters: counters(),
      },
      events: [],
    }, sfxRecorder());

    expect(state.loadout.activeWeaponId).toBe("slugthrower");
    expect(state.loadout.equipped.longGun).toBe("slugthrower");
    expect(state.loadout.ammo["slug"].loaded).toBe(16);
  });

  it("keeps server ticks on remote interpolation samples even when position is unchanged", () => {
    const sliceSnapshot = slice();
    const state = createPlayState(sliceSnapshot);
    applyServerPacket(state, sliceSnapshot, {
      type: "game.hello",
      sessionId: "g_1",
      playerActorId: "player",
      serverTime: "1970-01-01T00:00:00.000Z",
      snapshot: shardSnapshot({ sourceStateHash: "hash", sourceActorCount: 2 }),
    }, sfxRecorder());

    state.worldTimeMs = 100;
    applyServerPacket(state, sliceSnapshot, {
      type: "game.delta",
      receipts: [],
      delta: {
        schema: "successor.authoritative-shard-delta.v1",
        shardId: "test",
        tick: 21,
        playerActorId: "player",
        actors: {
          vendor: actorSnapshot("vendor", 8, 5),
        },
        counters: counters(),
      },
      events: [],
    }, sfxRecorder());

    expect(state.serverAuthority.actors.vendor?.interpolationSamples?.map((sample) => sample.tick)).toEqual([20, 21]);
  });

  it("keeps locked-facing sprint strafe receipts from rotating the authoritative mirror", () => {
    const sliceSnapshot = slice();
    const state = createPlayState(sliceSnapshot);
    applyServerPacket(state, sliceSnapshot, {
      type: "game.hello",
      sessionId: "g_1",
      playerActorId: "player",
      serverTime: "1970-01-01T00:00:00.000Z",
      snapshot: shardSnapshot({ sourceStateHash: "hash", sourceActorCount: 2 }),
    }, sfxRecorder());
    state.serverAuthority.inFlightMoves.push({
      commandId: 1,
      dx: 0,
      dy: 1,
      durationTicks: 2,
      sprint: true,
      facing: "right",
      sentAtMs: 1_000,
    });

    applyServerPacket(state, sliceSnapshot, {
      type: "game.acks",
      acks: [[1, 1, 21]],
      playerPosition: [4, 5.25],
    }, sfxRecorder());

    expect(state.serverAuthority.actors.player?.direction).toBe("right");
    expect(state.serverAuthority.actors.player?.y).toBe(5.25);
  });

  it("does not let sprint-held player action bounce upward from movement acks", () => {
    const sliceSnapshot = slice();
    const state = createPlayState(sliceSnapshot);
    applyServerPacket(state, sliceSnapshot, {
      type: "game.hello",
      sessionId: "g_1",
      playerActorId: "player",
      serverTime: "1970-01-01T00:00:00.000Z",
      snapshot: shardSnapshot({ sourceStateHash: "hash", sourceActorCount: 2 }),
    }, sfxRecorder());
    state.moving = true;
    state.keys.add("ShiftLeft");
    state.actors.player!.vitals.action = 72;

    applyServerPacket(state, sliceSnapshot, {
      type: "game.acks",
      acks: [[2, 1, 22]],
      playerActor: {
        ...actorSnapshot("player", 4.2, 5),
        vitals: { health: 100, action: 96, spirit: 100 },
      },
    }, sfxRecorder());

    expect(state.actors.player?.vitals.action).toBe(72);
    expect(state.serverAuthority.actors.player?.vitals.action).toBe(96);
  });

  it("does not speed burst the moving player toward speculative ack targets", () => {
    const sliceSnapshot = slice();
    const state = createPlayState(sliceSnapshot);
    applyServerPacket(state, sliceSnapshot, {
      type: "game.hello",
      sessionId: "g_1",
      playerActorId: "player",
      serverTime: "1970-01-01T00:00:00.000Z",
      snapshot: shardSnapshot({ sourceStateHash: "hash", sourceActorCount: 2 }),
    }, sfxRecorder());
    state.player = { x: 4.18, y: 5 };
    state.moving = true;
    state.keys.add("KeyD");
    state.movementKeyOrder = ["KeyD"];
    state.serverAuthority.inFlightMoves.push({
      commandId: 7,
      dx: 1,
      dy: 0,
      durationTicks: 1,
      sprint: false,
      facing: "right",
      sentAtMs: 1_000,
    });

    applyServerPacket(state, sliceSnapshot, {
      type: "game.acks",
      acks: [[7, 1, 22]],
      playerPosition: [4.15, 5],
    }, sfxRecorder());

    expect(state.serverAuthority.authoritativePlayer).toEqual({ x: 4.15, y: 5 });
    expect(state.player.x).toBe(4.18);
  });

  it("allows sprint prediction lead without walking-speed pullback", () => {
    const sliceSnapshot = slice();
    const state = createPlayState(sliceSnapshot);
    applyServerPacket(state, sliceSnapshot, {
      type: "game.hello",
      sessionId: "g_1",
      playerActorId: "player",
      serverTime: "1970-01-01T00:00:00.000Z",
      snapshot: shardSnapshot({ sourceStateHash: "hash", sourceActorCount: 2 }),
    }, sfxRecorder());
    state.player = { x: 4.94, y: 5 };
    state.moving = true;
    state.keys.add("ShiftLeft");
    state.keys.add("KeyD");
    state.movementKeyOrder = ["KeyD"];

    applyServerPacket(state, sliceSnapshot, {
      type: "game.acks",
      acks: [],
      playerPosition: [4, 5],
    }, sfxRecorder());

    expect(state.serverAuthority.authoritativePlayer).toEqual({ x: 4, y: 5 });
    expect(state.player.x).toBe(4.94);
  });

  it("uses walking ack correction when Shift is held without enough Action", () => {
    const sliceSnapshot = slice();
    const state = createPlayState(sliceSnapshot);
    applyServerPacket(state, sliceSnapshot, {
      type: "game.hello",
      sessionId: "g_1",
      playerActorId: "player",
      serverTime: "1970-01-01T00:00:00.000Z",
      snapshot: shardSnapshot({ sourceStateHash: "hash", sourceActorCount: 2 }),
    }, sfxRecorder());
    state.actors.player!.vitals.action = 0.8;
    state.player = { x: 4.94, y: 5 };
    state.moving = true;
    state.keys.add("ShiftLeft");
    state.keys.add("KeyD");
    state.movementKeyOrder = ["KeyD"];

    applyServerPacket(state, sliceSnapshot, {
      type: "game.acks",
      acks: [],
      playerPosition: [4, 5],
    }, sfxRecorder());

    expect(state.serverAuthority.authoritativePlayer).toEqual({ x: 4, y: 5 });
    expect(state.player.x).toBeCloseTo(4.94);
  });

  it("ignores stale movement order entries when projecting current move intent from acks", () => {
    const sliceSnapshot = slice();
    const state = createPlayState(sliceSnapshot);
    applyServerPacket(state, sliceSnapshot, {
      type: "game.hello",
      sessionId: "g_1",
      playerActorId: "player",
      serverTime: "1970-01-01T00:00:00.000Z",
      snapshot: shardSnapshot({ sourceStateHash: "hash", sourceActorCount: 2 }),
    }, sfxRecorder());
    state.moving = true;
    state.player = { x: 4, y: 4.8 };
    state.keys.add("KeyW");
    state.movementKeyOrder = ["KeyA"];

    applyServerPacket(state, sliceSnapshot, {
      type: "game.acks",
      acks: [],
      playerPosition: [4, 5],
    }, sfxRecorder());

    expect(state.serverAuthority.predictionTarget?.x).toBeCloseTo(4);
    expect(state.serverAuthority.predictionTarget?.y).toBeLessThan(5);
  });

  it("flushes movement before transitions so doorway entry is authoritative", () => {
    const state = createPlayState(slice());
    state.playerActorId = "player";
    state.serverAuthority.playerActorId = "player";
    state.serverAuthority.connected = true;
    state.serverAuthority.sourceMatchesClient = true;
    enqueueAuthorityCommand(state.authorityCommands, {
      EnterTransition: { transition_id: "bolt-bench-entry" },
    }, 20);
    const moveEnvelope = enqueueAuthorityCommand(state.authorityCommands, {
      Move: { dx: 1, dy: 0, duration_ticks: 2, facing: "Right" },
    }, 20);

    const sent: unknown[] = [];
    const room = {
      connection: { isOpen: true },
      send: (_type: string, envelope: { command: unknown }) => sent.push(envelope.command),
    };

    // First flush should send the prioritized Move command (one in-flight command limit)
    expect(flushGameAuthorityCommands(state, room as never)).toBe(1);
    expect(sent).toEqual([
      { Move: { dx: 1, dy: 0, duration_ticks: 2, facing: "Right" } },
    ]);

    // Subsequent flush is blocked by the in-flight Move command
    expect(flushGameAuthorityCommands(state, room as never)).toBe(0);

    // Settle the in-flight Move command
    settleAuthorityCommand(state.authorityCommands, moveEnvelope.command_id);

    // Second flush should now send the EnterTransition command
    expect(flushGameAuthorityCommands(state, room as never)).toBe(1);
    expect(sent).toEqual([
      { Move: { dx: 1, dy: 0, duration_ticks: 2, facing: "Right" } },
      { EnterTransition: { transition_id: "bolt-bench-entry" } },
    ]);
  });

  it("requeues an unconfirmed command on a stale actor-source mismatch and sends the same envelope only after a verified hello", () => {
    const sliceSnapshot = slice();
    const state = createPlayState(sliceSnapshot);
    state.playerActorId = "player";
    state.serverAuthority.playerActorId = "player";
    state.serverAuthority.connected = true;
    state.serverAuthority.sourceMatchesClient = true;
    const command = enqueueAuthorityCommand(state.authorityCommands, {
      EnterTransition: { transition_id: "bolt-bench-entry" },
    }, 20);
    const sent: number[] = [];
    const room = {
      connection: { isOpen: true },
      send: (_type: string, envelope: { command_id: number }) => sent.push(envelope.command_id),
    };

    expect(flushGameAuthorityCommands(state, room as never)).toBe(1);
    applyServerPacket(state, sliceSnapshot, {
      type: "game.hello",
      sessionId: "g_spoofed",
      playerActorId: "vendor",
      serverTime: "1970-01-01T00:00:00.000Z",
      snapshot: shardSnapshot({ sourceStateHash: "hash", sourceActorCount: 2, playerActorId: "vendor" }),
    }, sfxRecorder());

    expect(state.status).toBe("server authority source mismatch: client actor player server actor vendor");
    expect(state.authorityCommands.inFlight).toBeNull();
    expect(state.authorityCommands.pending.map((pending) => pending.command_id)).toEqual([command.command_id]);
    expect(flushGameAuthorityCommands(state, room as never)).toBe(0);

    applyServerPacket(state, sliceSnapshot, {
      type: "game.hello",
      sessionId: "g_verified",
      playerActorId: "player",
      serverTime: "1970-01-01T00:00:00.000Z",
      snapshot: shardSnapshot({ sourceStateHash: "hash", sourceActorCount: 2 }),
    }, sfxRecorder());

    expect(flushGameAuthorityCommands(state, room as never)).toBe(1);
    expect(sent).toEqual([command.command_id, command.command_id]);
  });

  it("retains queued work while disconnected and sends its original command after reconnect", () => {
    const state = createPlayState(slice());
    state.playerActorId = "player";
    state.serverAuthority.playerActorId = "player";
    state.serverAuthority.sourceMatchesClient = true;
    const command = enqueueAuthorityCommand(state.authorityCommands, {
      EnterTransition: { transition_id: "reconnect-entry" },
    }, 20);
    const sent: number[] = [];
    const room = {
      connection: { isOpen: true },
      send: (_type: string, envelope: { command_id: number }) => sent.push(envelope.command_id),
    };

    expect(flushGameAuthorityCommands(state, room as never)).toBe(0);
    expect(state.authorityCommands.pending.map((pending) => pending.command_id)).toEqual([command.command_id]);

    state.serverAuthority.connected = true;
    expect(flushGameAuthorityCommands(state, room as never)).toBe(1);
    expect(state.authorityCommands.inFlight?.command_id).toBe(command.command_id);

    state.serverAuthority.connected = false;
    expect(flushGameAuthorityCommands(state, room as never)).toBe(0);
    expect(state.authorityCommands.inFlight).toBeNull();
    expect(state.authorityCommands.pending.map((pending) => pending.command_id)).toEqual([command.command_id]);

    state.serverAuthority.connected = true;
    expect(flushGameAuthorityCommands(state, room as never)).toBe(1);
    expect(sent).toEqual([command.command_id, command.command_id]);
  });

  it("flushes priority classes one at a time, then uses command id within a class", () => {
    const state = createPlayState(slice());
    state.playerActorId = "player";
    state.serverAuthority.playerActorId = "player";
    state.serverAuthority.connected = true;
    state.serverAuthority.sourceMatchesClient = true;
    const transition = enqueueAuthorityCommand(state.authorityCommands, {
      EnterTransition: { transition_id: "bolt-bench-entry" },
    }, 20);
    const move = enqueueAuthorityCommand(state.authorityCommands, {
      Move: { dx: 1, dy: 0, duration_ticks: 2, facing: "Right" },
    }, 20);
    const water = enqueueAuthorityWaterTileCommand(state.authorityCommands, 20, "parcel:planet-a:1", 3, 4);
    const sent: number[] = [];
    const room = {
      connection: { isOpen: true },
      send: (_type: string, envelope: { command_id: number }) => sent.push(envelope.command_id),
    };

    for (const commandId of [move.command_id, transition.command_id, water.command_id]) {
      expect(flushGameAuthorityCommands(state, room as never)).toBe(1);
      expect(flushGameAuthorityCommands(state, room as never)).toBe(0);
      applyServerPacket(state, slice(), { type: "game.acks", acks: [[commandId, 1, 20]] }, sfxRecorder());
    }

    expect(sent).toEqual([move.command_id, transition.command_id, water.command_id]);
    expect(state.authorityCommands.inFlight).toBeNull();
    expect(state.authorityCommands.pending).toEqual([]);
  });

  it("flushes exact equipped clothing identity and settles it on an authoritative receipt", () => {
    const sliceSnapshot = slice();
    const state = createPlayState(sliceSnapshot);
    state.playerActorId = "player";
    state.serverAuthority.playerActorId = "player";
    state.serverAuthority.connected = true;
    state.serverAuthority.sourceMatchesClient = true;
    const command = enqueueAuthoritySetEquippedClothingCommand(
      state.authorityCommands,
      20,
      5_001,
      false,
      "12",
      0,
      "player:field-pack",
    );
    const sent: unknown[] = [];
    const room = {
      connection: { isOpen: true },
      send: (_type: string, envelope: unknown) => sent.push(envelope),
    };

    expect(flushGameAuthorityCommands(state, room as never)).toBe(1);
    expect(sent).toEqual([{
      session: state.authorityCommands.session,
      player: state.authorityCommands.player,
      command_id: command.command_id,
      issued_at_tick: 20,
      command: {
        SetEquippedClothing: {
          item_id: 5_001,
          equipped: false,
          container: "player:field-pack",
          stack_id: "12",
          variant_id: 0,
        },
      },
    }]);

    applyServerPacket(state, sliceSnapshot, {
      type: "game.receipts",
      receipts: [{ commandId: command.command_id, accepted: true, tick: 21 }],
      events: [],
    }, sfxRecorder());

    expect(state.authorityCommands.inFlight).toBeNull();
    expect(state.authorityCommands.pending).toEqual([]);
    expect(state.serverAuthority.receiptLog.at(-1)).toMatchObject({
      commandId: command.command_id,
      accepted: true,
    });
  });

  it("serializes movement intents and unrelated commands behind exact receipts", () => {
    const sliceSnapshot = slice();
    const state = createPlayState(sliceSnapshot);
    state.playerActorId = "player";
    state.serverAuthority.playerActorId = "player";
    state.serverAuthority.connected = true;
    state.serverAuthority.sourceMatchesClient = true;
    const initialIntent = enqueueAuthorityCommand(state.authorityCommands, {
      SetMoveIntent: { dx: 1, dy: 0, facing: "Right" },
    }, 20);
    const newerIntent = enqueueAuthorityCommand(state.authorityCommands, {
      SetMoveIntent: { dx: 0, dy: -1, facing: "Back" },
    }, 21);
    const neutralRelease = enqueueAuthorityCommand(state.authorityCommands, {
      SetMoveIntent: { dx: 0, dy: 0, facing: "Back" },
    }, 22);
    const firstTransition = enqueueAuthorityCommand(state.authorityCommands, {
      EnterTransition: { transition_id: "bolt-bench-entry" },
    }, 23);
    const secondTransition = enqueueAuthorityCommand(state.authorityCommands, {
      EnterTransition: { transition_id: "reconnect-entry" },
    }, 24);
    const sent: number[] = [];
    const room = {
      connection: { isOpen: true },
      send: (_type: string, envelope: { command_id: number }) => sent.push(envelope.command_id),
    };

    for (const commandId of [
      initialIntent.command_id,
      newerIntent.command_id,
      neutralRelease.command_id,
      firstTransition.command_id,
      secondTransition.command_id,
    ]) {
      expect(flushGameAuthorityCommands(state, room as never)).toBe(1);
      expect(flushGameAuthorityCommands(state, room as never)).toBe(0);
      applyServerPacket(state, sliceSnapshot, {
        type: "game.receipts",
        receipts: [{ commandId, accepted: true, tick: 20 }],
        events: [],
      }, sfxRecorder());
    }

    expect(sent).toEqual([
      initialIntent.command_id,
      newerIntent.command_id,
      neutralRelease.command_id,
      firstTransition.command_id,
      secondTransition.command_id,
    ]);
    expect(state.authorityCommands.inFlight).toBeNull();
    expect(state.authorityCommands.pending).toEqual([]);
  });

  it("ignores unknown and duplicate receipts while settling each recovered farming command exactly once", () => {
    const sliceSnapshot = slice();
    const state = createPlayState(sliceSnapshot);
    state.playerActorId = "player";
    state.serverAuthority.playerActorId = "player";
    state.serverAuthority.connected = true;
    state.serverAuthority.sourceMatchesClient = true;
    const till = enqueueAuthorityTillTileCommand(state.authorityCommands, 20, "parcel:planet-a:1", 3, 4);
    const plant = enqueueAuthorityPlantSeedCommand(state.authorityCommands, 21, "parcel:planet-a:1", 3, 4, "player:seed-pouch", "7", 42);
    const water = enqueueAuthorityWaterTileCommand(state.authorityCommands, 22, "parcel:planet-a:1", 3, 4);
    const sent: number[] = [];
    const room = {
      connection: { isOpen: true },
      send: (_type: string, envelope: { command_id: number }) => sent.push(envelope.command_id),
    };

    expect(flushGameAuthorityCommands(state, room as never)).toBe(1);
    applyServerPacket(state, sliceSnapshot, { type: "game.receipts", receipts: [{ commandId: 999, accepted: true, tick: 20 }], events: [] }, sfxRecorder());
    expect(state.authorityCommands.inFlight?.command_id).toBe(till.command_id);
    expect(state.serverAuthority.receiptLog).toEqual([]);

    applyServerPacket(state, sliceSnapshot, {
      type: "game.hello",
      sessionId: "g_mismatch",
      playerActorId: "player",
      serverTime: "1970-01-01T00:00:00.000Z",
      snapshot: shardSnapshot({ sourceStateHash: "wrong", sourceActorCount: 2 }),
    }, sfxRecorder());
    expect(state.authorityCommands.pending.map((pending) => pending.command_id)).toEqual([till.command_id, plant.command_id, water.command_id]);

    applyServerPacket(state, sliceSnapshot, {
      type: "game.hello",
      sessionId: "g_recovered",
      playerActorId: "player",
      serverTime: "1970-01-01T00:00:00.000Z",
      snapshot: shardSnapshot({ sourceStateHash: "hash", sourceActorCount: 2 }),
    }, sfxRecorder());
    for (const commandId of [till.command_id, plant.command_id, water.command_id]) {
      expect(flushGameAuthorityCommands(state, room as never)).toBe(1);
      applyServerPacket(state, sliceSnapshot, { type: "game.receipts", receipts: [{ commandId, accepted: true, tick: 30 }], events: [] }, sfxRecorder());
    }
    applyServerPacket(state, sliceSnapshot, { type: "game.receipts", receipts: [{ commandId: water.command_id, accepted: true, tick: 30 }], events: [] }, sfxRecorder());

    expect(sent).toEqual([till.command_id, till.command_id, plant.command_id, water.command_id]);
    expect(state.authorityCommands.pending).toEqual([]);
    expect(state.authorityCommands.inFlight).toBeNull();
    expect(state.serverAuthority.acceptedCommands).toBe(3);
    expect(state.serverAuthority.receiptLog.map((receipt) => receipt.commandId)).toEqual([till.command_id, plant.command_id, water.command_id]);
  });

  it("flushes same-tick blocked movement commands after each exact rejection and records no duplicate receipt", () => {
    const sliceSnapshot = slice();
    const state = createPlayState(sliceSnapshot);
    state.playerActorId = "player";
    state.serverAuthority.playerActorId = "player";
    state.serverAuthority.connected = true;
    state.serverAuthority.sourceMatchesClient = true;
    const first = enqueueAuthorityCommand(state.authorityCommands, {
      Move: { dx: 1, dy: 0, duration_ticks: 30, facing: "Right" },
    }, 76);
    const second = enqueueAuthorityCommand(state.authorityCommands, {
      Move: { dx: 1, dy: 0, duration_ticks: 30, facing: "Right" },
    }, 76);
    const sent: number[] = [];
    const room = {
      connection: { isOpen: true },
      send: (_type: string, envelope: { command_id: number }) => sent.push(envelope.command_id),
    };

    expect(flushGameAuthorityCommands(state, room as never)).toBe(1);
    expect(flushGameAuthorityCommands(state, room as never)).toBe(0);
    applyServerPacket(state, sliceSnapshot, {
      type: "game.receipts",
      receipts: [{ commandId: first.command_id, accepted: false, tick: 76, reasonCode: "blocked_cell" }],
      events: [],
    }, sfxRecorder());
    expect(state.authorityCommands.inFlight).toBeNull();
    expect(flushGameAuthorityCommands(state, room as never)).toBe(1);
    applyServerPacket(state, sliceSnapshot, {
      type: "game.receipts",
      receipts: [{ commandId: second.command_id, accepted: false, tick: 76, reasonCode: "blocked_cell" }],
      events: [],
    }, sfxRecorder());
    applyServerPacket(state, sliceSnapshot, {
      type: "game.receipts",
      receipts: [{ commandId: second.command_id, accepted: false, tick: 76, reasonCode: "blocked_cell" }],
      events: [],
    }, sfxRecorder());

    expect(sent).toEqual([first.command_id, second.command_id]);
    expect(state.authorityCommands.pending).toEqual([]);
    expect(state.authorityCommands.inFlight).toBeNull();
    expect(state.serverAuthority.receiptLog.map((receipt) => receipt.commandId)).toEqual([
      first.command_id,
      second.command_id,
    ]);
    expect(state.serverAuthority.rejectedCommands).toBe(2);
  });

  it("plays transition feedback only after the authoritative actor changes area", () => {
    const transitionSlice = {
      ...slice(),
      areas: [
        { id: "open-desert-overworld", name: "Open Desert", kind: "overworld", width: 24, height: 18, level: 0 },
        { id: "bolt-bench", name: "Bolt Bench", kind: "public_interior", width: 12, height: 10, level: 0 },
      ],
      transitions: [{
        id: "bolt-bench-entry",
        label: "Enter Bolt Bench",
        style: "door",
        fromAreaId: "open-desert-overworld",
        fromCell: { x: 4, y: 5 },
        triggerSize: { w: 1, h: 1 },
        toAreaId: "bolt-bench",
        toCell: { x: 2, y: 3 },
        toFacing: "front",
      }],
    } satisfies SliceSnapshot;
    const state = createPlayState(transitionSlice);
    applyServerPacket(state, transitionSlice, {
      type: "game.hello",
      sessionId: "g_1",
      playerActorId: "player",
      serverTime: "1970-01-01T00:00:00.000Z",
      snapshot: shardSnapshot({ sourceStateHash: "hash", sourceActorCount: 2 }),
    }, sfxRecorder());

    const audio = sfxRecorder();
    applyServerPacket(state, transitionSlice, {
      type: "game.delta",
      receipts: [{ commandId: 9, accepted: true, tick: 25 }],
      delta: {
        schema: "successor.authoritative-shard-delta.v1",
        shardId: "test",
        tick: 25,
        playerActorId: "player",
        actors: {
          player: {
            ...actorSnapshot("player", 2, 3),
            areaId: "bolt-bench",
            direction: "front",
          },
        },
        counters: counters(),
      },
      events: [],
    }, audio);

    expect(state.activeAreaId).toBe("bolt-bench");
    expect(state.lastTransitionLabel).toBe("Enter Bolt Bench");
    expect(state.status).toBe("enter bolt bench");
    expect(state.transitionFlashMs).toBe(420);
    expect(audio.played).toEqual(["area_transition"]);
  });

  it("records approximate inbound packet throughput for the network monitor", () => {
    const sliceSnapshot = slice();
    const state = createPlayState(sliceSnapshot);

    applyServerPacket(state, sliceSnapshot, {
      type: "game.hello",
      sessionId: "g_1",
      playerActorId: "player",
      serverTime: "1970-01-01T00:00:00.000Z",
      snapshot: shardSnapshot({
        sourceStateHash: "hash",
        sourceActorCount: 2,
      }),
    }, sfxRecorder());

    expect(state.serverAuthority.receivedPackets).toBe(1);
    expect(state.serverAuthority.receivedBytes).toBeGreaterThan(0);
    expect(state.serverAuthority.receivedBytesByType["game.hello"]).toBe(state.serverAuthority.receivedBytes);
    expect(state.serverAuthority.lastPacketType).toBe("game.hello");
    expect(state.serverAuthority.recentInboundBytes).toHaveLength(1);
  });

  it("applies numeric compact actor movement lanes from authoritative deltas", () => {
    const sliceSnapshot = slice();
    const state = createPlayState(sliceSnapshot);

    applyServerPacket(state, sliceSnapshot, {
      type: "game.hello",
      sessionId: "g_1",
      playerActorId: "player",
      serverTime: "1970-01-01T00:00:00.000Z",
      snapshot: {
        ...shardSnapshot({ sourceStateHash: "hash", sourceActorCount: 2 }),
        actorRefs: [[1, "player"], [2, "vendor"]],
      },
    }, sfxRecorder());

    applyAuthoritativeDelta(state, sliceSnapshot, {
      schema: "successor.authoritative-shard-delta.v1",
      shardId: "test",
      tick: 21,
      playerActorId: "player",
      actors: {},
      compactActorMoves: [[2, 925, 525, 1]],
      counters: counters(),
    });

    expect(state.serverAuthority.actorIdsByNetId[2]).toBe("vendor");
    expect(state.serverAuthority.actors.vendor?.x).toBe(9.25);
    expect(state.serverAuthority.actors.vendor?.y).toBe(5.25);
    expect(state.serverAuthority.actors.vendor?.direction).toBe("right");
  });

  it("preserves remote actor render position across large non-teleport authority moves", () => {
    const sliceSnapshot = slice();
    const state = createPlayState(sliceSnapshot);

    applyServerPacket(state, sliceSnapshot, {
      type: "game.hello",
      sessionId: "g_1",
      playerActorId: "player",
      serverTime: "1970-01-01T00:00:00.000Z",
      snapshot: {
        ...shardSnapshot({ sourceStateHash: "hash", sourceActorCount: 2 }),
        actorRefs: [[1, "player"], [2, "vendor"]],
      },
    }, sfxRecorder());
    state.serverAuthority.actors.vendor!.renderX = 8;
    state.serverAuthority.actors.vendor!.renderY = 5;

    applyAuthoritativeDelta(state, sliceSnapshot, {
      schema: "successor.authoritative-shard-delta.v1",
      shardId: "test",
      tick: 22,
      playerActorId: "player",
      actors: {},
      compactActorMoves: [[2, 1300, 500, 1]],
      counters: counters(),
    });

    expect(state.serverAuthority.actors.vendor?.x).toBe(13);
    expect(state.serverAuthority.actors.vendor?.renderX).toBe(8);
    expect(state.serverAuthority.actors.vendor?.renderY).toBe(5);
  });

  it("preserves faction metadata from compact full actor snapshots", () => {
    const sliceSnapshot = slice();
    const state = createPlayState(sliceSnapshot);

    applyAuthoritativeDelta(state, sliceSnapshot, {
      schema: "successor.authoritative-shard-delta.v1",
      shardId: "test",
      tick: 22,
      playerActorId: "player",
      actors: {},
      compactActors: [[
        "skirmish-red-trooper",
        "Kade Rill",
        "open-desert-overworld",
        10,
        5,
        1,
        0,
        1,
        [100, 100, 100],
        [100, 100, 100],
        [0, 0, 0, 0, 0, 0, 0],
        [],
        "red_crew",
        "red_squad",
        "overt",
      ]],
      counters: counters(),
    });

    expect(state.serverAuthority.actors["skirmish-red-trooper"]).toMatchObject({
      factionId: "red_crew",
      socialGroup: "red_squad",
      pvpStatus: "overt",
    });
  });

  it("carries willAutoAggro from full JSON actor snapshots into the client mirror (threat legibility)", () => {
    const sliceSnapshot = slice();
    const state = createPlayState(sliceSnapshot);

    applyAuthoritativeDelta(state, sliceSnapshot, {
      schema: "successor.authoritative-shard-delta.v1",
      shardId: "test",
      tick: 22,
      playerActorId: "player",
      actors: { "auto-rogue": { ...actorSnapshot("auto-rogue", 10, 5), willAutoAggro: true } },
      counters: counters(),
    });

    expect(state.serverAuthority.actors["auto-rogue"]?.willAutoAggro).toBe(true);
  });

  it("decodes willAutoAggro from the compact full-snapshot tuple (bridge round-trip, trailing field)", () => {
    const sliceSnapshot = slice();
    const state = createPlayState(sliceSnapshot);
    // willAutoAggro is the last compact-tuple field; index 49 sits after
    // nextSampleTick (47) and Wardrobe's worn slot (48).
    const compact: unknown[] = [
      "auto-rogue", "Kade Rill", "open-desert-overworld", 10, 5, 1, 0, 1,
      [100, 100, 100], [100, 100, 100], [0, 0, 0, 0, 0, 0, 0], [],
      "rogue_troopers", "rogue_patrol", "overt",
    ];
    compact.length = 50;
    compact[49] = 1;

    applyAuthoritativeDelta(state, sliceSnapshot, {
      schema: "successor.authoritative-shard-delta.v1",
      shardId: "test",
      tick: 22,
      playerActorId: "player",
      actors: {},
      compactActors: [compact as unknown as never],
      counters: counters(),
    });

    expect(state.serverAuthority.actors["auto-rogue"]?.willAutoAggro).toBe(true);
  });

  it("decodes sprint recovery lock from compact actor snapshots and patches", () => {
    const sliceSnapshot = slice();
    const state = createPlayState(sliceSnapshot);
    const compact: unknown[] = [
      "player", "Field Observer", "open-desert-overworld", 10, 5, 1, 0, 1,
      [100, 0, 100], [100, 100, 100], [0, 0, 0, 0, 0, 0, 0], [],
      "desert_wardens", null, "none",
    ];
    compact.length = 52;
    compact[51] = 1;

    applyAuthoritativeDelta(state, sliceSnapshot, {
      schema: "successor.authoritative-shard-delta.v1",
      shardId: "test",
      tick: 22,
      playerActorId: "player",
      actors: {},
      compactActors: [compact as unknown as never],
      counters: counters(),
    });
    expect(state.serverAuthority.actors.player?.mobility?.sprintRecoveryLocked).toBe(true);

    const patch: unknown[] = Array.from({ length: 52 }, () => null);
    patch[0] = "player";
    patch[51] = 0;
    applyAuthoritativeDelta(state, sliceSnapshot, {
      schema: "successor.authoritative-shard-delta.v1",
      shardId: "test",
      tick: 23,
      playerActorId: "player",
      actors: {},
      compactActorPatches: [patch as unknown as never],
      counters: counters(),
    });
    expect(state.serverAuthority.actors.player?.mobility?.sprintRecoveryLocked).toBe(false);
  });

  it("updates faction metadata from compact actor patches", () => {
    const sliceSnapshot = slice();
    const state = createPlayState(sliceSnapshot);

    applyAuthoritativeDelta(state, sliceSnapshot, {
      schema: "successor.authoritative-shard-delta.v1",
      shardId: "test",
      tick: 22,
      playerActorId: "player",
      actors: {},
      compactActors: [[
        "skirmish-red-trooper",
        "Kade Rill",
        "open-desert-overworld",
        10,
        5,
        1,
        0,
        1,
        [100, 100, 100],
        [100, 100, 100],
        [0, 0, 0, 0, 0, 0, 0],
        [],
        "red_crew",
        "red_squad",
        "overt",
      ]],
      counters: counters(),
    });

    applyAuthoritativeDelta(state, sliceSnapshot, {
      schema: "successor.authoritative-shard-delta.v1",
      shardId: "test",
      tick: 23,
      playerActorId: "player",
      actors: {},
      compactActorPatches: [[
        "skirmish-red-trooper",
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        false,
        null,
        null,
        null,
        false,
        false,
        false,
        "blue_crew",
        "blue_squad",
        "covert",
      ]],
      counters: counters(),
    });

    expect(state.serverAuthority.actors["skirmish-red-trooper"]).toMatchObject({
      factionId: "blue_crew",
      socialGroup: "blue_squad",
      pvpStatus: "covert",
    });
  });

  it("decodes clone respawn timing state from compact actor snapshots and patches", () => {
    const sliceSnapshot = slice();
    const state = createPlayState(sliceSnapshot);

    applyAuthoritativeDelta(state, sliceSnapshot, {
      schema: "successor.authoritative-shard-delta.v1",
      shardId: "test",
      tick: 22,
      playerActorId: "player",
      actors: {},
      compactActors: [[
        "clone-pending",
        "Clone Pending",
        "open-desert-overworld",
        10,
        5,
        1,
        1,
        2,
        [0, 0, 0],
        [100, 100, 100],
        [0, 0, 0, 0, 0, 0, 0],
        [],
        null,
        null,
        "none",
        0,
        480,
        [],
        null,
        0,
        0,
        0,
        null,
        null,
        "player",
        null,
        null,
        null,
        0,
        "standing",
        0,
        null,
        1,
        12_000,
        1,
        "alerted",
      ]],
      counters: counters(),
    });

    expect(state.serverAuthority.actors["clone-pending"]).toMatchObject({
      lifeState: "downed",
      respawnAtTick: 480,
      cloneSicknessRemainingMs: 12_000,
      inCombat: true,
      peaceRequested: true,
      aiAttitude: "alerted",
    });

    applyAuthoritativeDelta(state, sliceSnapshot, {
      schema: "successor.authoritative-shard-delta.v1",
      shardId: "test",
      tick: 23,
      playerActorId: "player",
      actors: {},
      compactActorPatches: [[
        "clone-pending",
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        900,
        null,
        null,
        null,
        null,
        null,
        false,
        null,
        null,
        null,
        false,
        false,
        false,
        false,
        false,
        false,
        null,
        null,
        null,
        false,
        0,
        5_000,
        0,
        "hostile",
      ]],
      counters: counters(),
    });

    expect(state.serverAuthority.actors["clone-pending"]).toMatchObject({
      respawnAtTick: 900,
      cloneSicknessRemainingMs: 5_000,
      inCombat: false,
      peaceRequested: false,
      aiAttitude: "hostile",
    });
  });

  it("emits a spatial question bubble when a passive rogue becomes alerted", () => {
    const sliceSnapshot = slice();
    const state = createPlayState(sliceSnapshot);

    applyAuthoritativeDelta(state, sliceSnapshot, {
      schema: "successor.authoritative-shard-delta.v1",
      shardId: "test",
      tick: 24,
      playerActorId: "player",
      actors: {
        player: actorSnapshot("player", 4, 5),
        "open-desert-rogue-01": {
          ...actorSnapshot("open-desert-rogue-01", 8, 5),
          label: "Kade Rill",
          factionId: "rogue_troopers",
          socialGroup: "open_desert_rogues",
          aiAttitude: "alerted",
        },
      },
      counters: counters(),
    });

    expect(state.chatBubbles[0]).toMatchObject({
      body: "?",
      sender: "Kade Rill",
      own: false,
      actorId: "open-desert-rogue-01",
    });

    applyAuthoritativeDelta(state, sliceSnapshot, {
      schema: "successor.authoritative-shard-delta.v1",
      shardId: "test",
      tick: 25,
      playerActorId: "player",
      actors: {},
      actorPatches: {
        "open-desert-rogue-01": {
          id: "open-desert-rogue-01",
          aiAttitude: "alerted",
        },
      },
      counters: counters(),
    });

    expect(state.chatBubbles.map((bubble) => bubble.body)).toEqual(["?"]);
  });

  it("decodes auto roll combat queue entries from compact actor snapshots", () => {
    const sliceSnapshot = slice();
    const state = createPlayState(sliceSnapshot);

    applyAuthoritativeDelta(state, sliceSnapshot, {
      schema: "successor.authoritative-shard-delta.v1",
      shardId: "test",
      tick: 24,
      playerActorId: "player",
      actors: {},
      compactActors: [[
        "auto-shooter",
        "Auto Shooter",
        "open-desert-overworld",
        10,
        5,
        1,
        0,
        1,
        [100, 100, 100],
        [100, 100, 100],
        [0, 0, 0, 0, 0, 0, 0],
        [],
        null,
        null,
        "none",
        0,
        0,
        [],
        null,
        0,
        0,
        0,
        null,
        null,
        "player",
        null,
        null,
        null,
        0,
        "standing",
        0,
        { nextReadyTick: 44, entries: [{ actionId: "basic_shot", targetActorId: "target", auto: true }] },
        1,
        0,
        0,
      ]],
      counters: counters(),
    });

    expect(state.serverAuthority.actors["auto-shooter"]?.combatQueue).toEqual({
      nextReadyTick: 44,
      entries: [{ actionId: "basic_shot", targetActorId: "target", auto: true }],
    });
  });

  it("removes actors that leave the authoritative AOI", () => {
    const sliceSnapshot = slice();
    const state = createPlayState(sliceSnapshot);

    applyServerPacket(state, sliceSnapshot, {
      type: "game.hello",
      sessionId: "g_1",
      playerActorId: "player",
      serverTime: "1970-01-01T00:00:00.000Z",
      snapshot: shardSnapshot({ sourceStateHash: "hash", sourceActorCount: 2 }),
    }, sfxRecorder());

    expect(state.serverAuthority.actors.vendor).toBeDefined();

    applyAuthoritativeDelta(state, sliceSnapshot, {
      schema: "successor.authoritative-shard-delta.v1",
      shardId: "test",
      tick: 22,
      playerActorId: "player",
      actors: {},
      actorRemovals: ["vendor"],
      counters: counters(),
    });

    expect(state.serverAuthority.actors.vendor).toBeUndefined();
  });

  it("does not keep non-player respawning actors in client authority", () => {
    const sliceSnapshot = slice();
    const state = createPlayState(sliceSnapshot);

    applyServerPacket(state, sliceSnapshot, {
      type: "game.hello",
      sessionId: "g_1",
      playerActorId: "player",
      serverTime: "1970-01-01T00:00:00.000Z",
      snapshot: shardSnapshot({ sourceStateHash: "hash", sourceActorCount: 2 }),
    }, sfxRecorder());
    state.selectedActorId = "vendor";
    state.actorPresentationFrames.vendor = { x: 8, y: 5, frame: 1 } as never;

    applyAuthoritativeDelta(state, sliceSnapshot, {
      schema: "successor.authoritative-shard-delta.v1",
      shardId: "test",
      tick: 22,
      playerActorId: "player",
      actors: {
        vendor: {
          ...actorSnapshot("vendor", 8, 5),
          lifeState: "respawning",
          lifecycleSeq: 3,
          vitals: { health: 0, action: 0, spirit: 0 },
        },
      },
      counters: counters(),
    });

    expect(state.serverAuthority.actors.vendor).toBeUndefined();
    expect(state.actorPresentationFrames.vendor).toBeUndefined();
    expect(state.selectedActorId).toBeNull();
  });

  it("does not re-add actors when a delta sends removal and patch together", () => {
    const sliceSnapshot = slice();
    const state = createPlayState(sliceSnapshot);

    applyServerPacket(state, sliceSnapshot, {
      type: "game.hello",
      sessionId: "g_1",
      playerActorId: "player",
      serverTime: "1970-01-01T00:00:00.000Z",
      snapshot: shardSnapshot({ sourceStateHash: "hash", sourceActorCount: 2 }),
    }, sfxRecorder());

    applyAuthoritativeDelta(state, sliceSnapshot, {
      schema: "successor.authoritative-shard-delta.v1",
      shardId: "test",
      tick: 22,
      playerActorId: "player",
      actors: {},
      actorPatches: {
        vendor: {
          id: "vendor",
          x: 9,
          y: 5,
          lifeState: "respawning",
          lifecycleSeq: 3,
        },
      },
      actorRemovals: ["vendor"],
      counters: counters(),
    });

    expect(state.serverAuthority.actors.vendor).toBeUndefined();
  });

  it("does not roll an actor back to an older lifecycle generation", () => {
    const sliceSnapshot = slice();
    const state = createPlayState(sliceSnapshot);

    applyServerPacket(state, sliceSnapshot, {
      type: "game.hello",
      sessionId: "g_1",
      playerActorId: "player",
      serverTime: "1970-01-01T00:00:00.000Z",
      snapshot: shardSnapshot({ sourceStateHash: "hash", sourceActorCount: 2 }),
    }, sfxRecorder());

    applyServerPacket(state, sliceSnapshot, {
      type: "game.delta",
      delta: {
        schema: "successor.authoritative-shard-delta.v1",
        shardId: "test",
        tick: 23,
        playerActorId: "player",
        actors: {},
        counters: counters(),
      },
      receipts: [],
      events: [{
        ...combatEvent(1),
        lifeState: "downed",
        targetLifecycleSeq: 2,
        lifecycle: { kind: "downed", from: "alive", to: "downed", cause: "test" },
      }],
    }, sfxRecorder());

    expect(state.serverAuthority.actors.vendor?.lifecycleSeq).toBe(2);
    expect(state.actors.vendor?.lifecycleSeq).toBe(2);

    applyAuthoritativeDelta(state, sliceSnapshot, {
      schema: "successor.authoritative-shard-delta.v1",
      shardId: "test",
      tick: 24,
      playerActorId: "player",
      actors: {},
      actorPatches: {
        vendor: {
          id: "vendor",
          lifeState: "downed",
          lifecycleSeq: 1,
          vitals: { health: 0, action: 0, spirit: 0 },
        },
      },
      counters: counters(),
    });

    expect(state.serverAuthority.actors.vendor?.lifecycleSeq).toBe(2);
    expect(state.actors.vendor?.lifecycleSeq).toBe(2);
  });


  it("marks source mismatches before accepting server authority as playable", () => {
    const sliceSnapshot = slice();
    const state = createPlayState(sliceSnapshot);

    applyServerPacket(state, sliceSnapshot, {
      type: "game.hello",
      sessionId: "g_1",
      playerActorId: "player",
      serverTime: "1970-01-01T00:00:00.000Z",
      snapshot: shardSnapshot({
        sourceStateHash: "server-combat-fixture-v1",
        sourceActorCount: 3,
      }),
    }, sfxRecorder());

    expect(state.serverAuthority.sourceMatchesClient).toBe(false);
    expect(state.serverAuthority.status).toBe("error");
    expect(state.serverAuthority.actors).toEqual({});
    expect(state.status).toBe("server authority source mismatch: client hash/2 server server-combat-fixture-v1/3");
  });

  it("clears private bank and corpse projections on an authority source mismatch", () => {
    const sliceSnapshot = slice();
    const state = createPlayState(sliceSnapshot);
    state.serverAuthority.bank = {
      credits: 777,
      items: [],
      backupPresent: true,
      backupSavedTick: 1,
      backupSkillCount: 2,
      backupCost: 1000,
    };
    state.serverAuthority.playerCorpses = [{
      id: "corpse:old",
      ownerLabel: "Old",
      areaId: "camp",
      cellX: 1,
      cellY: 1,
      x: 1,
      y: 1,
      expiryTick: 100,
      hasItems: true,
      creditsPresent: true,
      creditsCount: 10,
      isOwner: true,
      container: "corpse:old",
    }];

    applyServerPacket(state, sliceSnapshot, {
      type: "game.hello",
      sessionId: "g_mismatch",
      playerActorId: "player",
      serverTime: "1970-01-01T00:00:00.000Z",
      snapshot: shardSnapshot({ sourceStateHash: "wrong", sourceActorCount: 99 }),
    }, sfxRecorder());

    expect(state.serverAuthority.bank).toBeNull();
    expect(state.serverAuthority.playerCorpses).toEqual([]);
  });


  it("preserves bank and corpse projections across receipt-only deltas", () => {
    const sliceSnapshot = slice();
    const state = createPlayState(sliceSnapshot);
    state.serverAuthority.bank = {
      credits: 777,
      items: [],
      backupPresent: true,
      backupSavedTick: 1,
      backupSkillCount: 2,
      backupCost: 1000,
    };
    state.serverAuthority.playerCorpses = [{
      id: "corpse:receipt",
      ownerLabel: "Receipt",
      areaId: "camp",
      cellX: 1,
      cellY: 1,
      x: 1,
      y: 1,
      expiryTick: 100,
      hasItems: false,
      creditsPresent: true,
      creditsCount: 4,
      isOwner: true,
      container: "corpse:receipt",
    }];
    applyAuthoritativeDelta(state, sliceSnapshot, {
      schema: "successor.authoritative-shard-delta.v1",
      shardId: "test",
      tick: 1,
      playerActorId: "player",
      actors: {},
      counters: counters(),
    });
    expect(state.serverAuthority.bank?.credits).toBe(777);
    expect(state.serverAuthority.playerCorpses.map((row) => row.id)).toEqual(["corpse:receipt"]);
  });
  it("drops stale mismatch deltas before actors or hit effects reach presentation", () => {
    const sliceSnapshot = slice();
    const state = createPlayState(sliceSnapshot);
    const sfx = sfxRecorder();

    applyServerPacket(state, sliceSnapshot, {
      type: "game.delta",
      receipts: [],
      delta: {
        schema: "successor.authoritative-shard-delta.v1",
        shardId: "test",
        tick: 21,
        playerActorId: "player",
        actors: {
          player: actorSnapshot("player", 4, 5),
          "stale-target": actorSnapshot("stale-target", 10, 5),
        },
        sourceStateHash: "old-combat-fixture",
        sourceActorCount: 202,
        counters: counters(),
      },
      events: [combatEvent(1)],
    } as never, sfx);

    expect(state.serverAuthority.sourceMatchesClient).toBe(false);
    expect(state.serverAuthority.actors).toEqual({});
    expect(state.hits).toBe(0);
    expect(sfx.playedAt).toHaveLength(0);

    applyServerPacket(state, sliceSnapshot, {
      type: "game.acks",
      acks: [[2, 1, 22]],
      playerActor: actorSnapshot("player", 5, 5),
    }, sfx);
    expect(state.serverAuthority.actors).toEqual({});
  });

  it("plays remote rifle reload animation from authoritative reload status", () => {
    const state = createPlayState(slice());
    const sfx = sfxRecorder();
    state.serverAuthority.playerActorId = "player";

    applyAuthoritativeDelta(state, slice(), {
      schema: "successor.authoritative-shard-delta.v1",
      shardId: "test",
      tick: 10,
      playerActorId: "player",
      actors: {
        player: actorSnapshot("player", 4, 5),
        "remote-rifle": actorSnapshot("remote-rifle", 4, 5),
      },
      counters: counters(),
    }, sfx);

    applyAuthoritativeDelta(state, slice(), {
      schema: "successor.authoritative-shard-delta.v1",
      shardId: "test",
      tick: 11,
      playerActorId: "player",
      actors: {
        "remote-rifle": {
          ...actorSnapshot("remote-rifle", 4, 5),
          statuses: [{ id: "reloading", label: "Reloading", severity: 1, remainingMs: 1_600 }],
        },
      },
      counters: counters(),
    }, sfx);

    expect(state.weaponFireAnimations["remote-rifle"]).toMatchObject({
      weaponId: "slugthrower",
      kind: "reload",
      durationMs: 1_600,
    });
    expect(sfx.playedAt).toEqual(["slugthrower_reload"]);

    applyAuthoritativeDelta(state, slice(), {
      schema: "successor.authoritative-shard-delta.v1",
      shardId: "test",
      tick: 12,
      playerActorId: "player",
      actors: {
        "remote-rifle": {
          ...actorSnapshot("remote-rifle", 4, 5),
          statuses: [{ id: "reloading", label: "Reloading", severity: 1, remainingMs: 1_200 }],
        },
      },
      counters: counters(),
    }, sfx);

    expect(sfx.playedAt).toEqual(["slugthrower_reload"]);
  });

  it("clears stale corpse statuses when an authoritative actor respawns alive", () => {
    const sliceSnapshot = slice();
    const state = createPlayState(sliceSnapshot);

    applyAuthoritativeDelta(state, sliceSnapshot, {
      schema: "successor.authoritative-shard-delta.v1",
      shardId: "test",
      tick: 10,
      playerActorId: "player",
      actors: {
        player: actorSnapshot("player", 4, 5),
        vendor: { ...actorSnapshot("vendor", 8, 5), lifeState: "downed", statuses: [{ id: "dead", label: "Dead", severity: 3, remainingMs: 60_000 }] },
      },
      counters: counters(),
    });

    expect(actorTargetSummary(vendor, state).name).toContain("Corpse of");
    expect(state.actors.vendor?.statuses.some((status) => status.id === "dead")).toBe(true);

    applyAuthoritativeDelta(state, sliceSnapshot, {
      schema: "successor.authoritative-shard-delta.v1",
      shardId: "test",
      tick: 20,
      playerActorId: "player",
      actors: {},
      actorPatches: {
        vendor: { id: "vendor", lifeState: "alive", x: 8, y: 5 },
      },
      counters: counters(),
    });

    const summary = actorTargetSummary(vendor, state);
    // Name is the CLEAN personal/label read now; the actor descriptor is the
    // descriptor/role, no longer composed into the name (regression pinned dead).
    expect(summary.name).toBe("Warden");
    expect(summary.role).toBe("public shopkeeper");
    expect(summary.lifeState).toBe("alive");
    expect(summary.statuses.some((status) => status.id === "dead" || status.id === "downed")).toBe(false);
    expect(state.actors.vendor).toMatchObject({ downed: false, lifeState: "alive" });
  });

  it("spawns a wake-up floating status when authoritative sleep expires", () => {
    const sliceSnapshot = slice();
    const state = createPlayState(sliceSnapshot);

    applyAuthoritativeDelta(state, sliceSnapshot, {
      schema: "successor.authoritative-shard-delta.v1",
      shardId: "test",
      tick: 10,
      playerActorId: "player",
      actors: {
        player: actorSnapshot("player", 4, 5),
        vendor: { ...actorSnapshot("vendor", 8, 5), statuses: [{ id: "sleeping", label: "Sleeping", severity: 1, remainingMs: 1_000, stacks: 1, threshold: 4 }] },
      },
      counters: counters(),
    });

    applyAuthoritativeDelta(state, sliceSnapshot, {
      schema: "successor.authoritative-shard-delta.v1",
      shardId: "test",
      tick: 20,
      playerActorId: "player",
      actors: {},
      actorPatches: {
        vendor: { id: "vendor", lifeState: "alive", statuses: [] },
      },
      counters: counters(),
    });

    expect(state.actors.vendor?.statuses.some((status) => status.id === "sleeping")).toBe(false);
    expect(state.floatingTexts.at(-1)).toMatchObject({ label: "AWAKE", value: null });
  });


  it("advances the authoritative player mirror from normalized compact move acks", () => {
    const state = createPlayState(slice());
    state.serverAuthority.playerActorId = "player";
    applyAuthoritativeDelta(state, slice(), {
      schema: "successor.authoritative-shard-delta.v1",
      shardId: "test",
      tick: 10,
      playerActorId: "player",
      actors: { player: actorSnapshot("player", 4, 5) },
      sourceStateHash: "hash",
      sourceActorCount: 2,
      counters: counters(),
    });
    state.serverAuthority.inFlightMoves.push({
      commandId: 7,
      dx: 1,
      dy: -1,
      durationTicks: 1,
      sprint: false,
      sentAtMs: 1_000,
    });

    applyServerPacket(state, slice(), {
      type: "game.acks",
      acks: [[7, 1, 20]],
    }, sfxRecorder());

    expect(state.serverAuthority.acceptedCommands).toBe(1);
    expect(state.serverAuthority.inFlightMoves).toHaveLength(0);
    expect(state.serverAuthority.actors.player?.x).toBeCloseTo(4.032, 3);
    expect(state.serverAuthority.actors.player?.y).toBeCloseTo(4.968, 3);
    expect(state.serverAuthority.authoritativePlayer?.x).toBeCloseTo(4.032, 3);
    expect(state.serverAuthority.authoritativePlayer?.y).toBeCloseTo(4.968, 3);
  });

  it("prefers server player position included with move acks over local dead reckoning", () => {
    const state = createPlayState(slice());
    state.worldTimeMs = 1_200;
    state.serverAuthority.playerActorId = "player";
    applyAuthoritativeDelta(state, slice(), {
      schema: "successor.authoritative-shard-delta.v1",
      shardId: "test",
      tick: 10,
      playerActorId: "player",
      actors: { player: actorSnapshot("player", 4, 5) },
      sourceStateHash: "hash",
      sourceActorCount: 2,
      counters: counters(),
    });
    state.serverAuthority.inFlightMoves.push({
      commandId: 8,
      dx: 1,
      dy: 0,
      durationTicks: 1,
      sprint: false,
      sentAtMs: 1_000,
    });

    applyServerPacket(state, slice(), {
      type: "game.acks",
      acks: [[8, 1, 21]],
      playerPosition: [4.04, 5],
    }, sfxRecorder());

    expect(state.serverAuthority.inFlightMoves).toHaveLength(0);
    expect(state.serverAuthority.actors.player?.x).toBeCloseTo(4.04);
    expect(state.serverAuthority.authoritativePlayer?.x).toBeCloseTo(4.04);
  });

  it("updates the authority clock from move ack receipt ticks", () => {
    const state = createPlayState(slice());
    state.worldTimeMs = 1_200;
    state.serverAuthority.snapshotTick = 10;
    state.serverAuthority.lastSnapshotReceivedAtMs = 900;
    state.serverAuthority.playerActorId = "player";
    applyAuthoritativeDelta(state, slice(), {
      schema: "successor.authoritative-shard-delta.v1",
      shardId: "test",
      tick: 10,
      playerActorId: "player",
      actors: { player: actorSnapshot("player", 4, 5) },
      sourceStateHash: "hash",
      sourceActorCount: 2,
      counters: counters(),
    });
    state.serverAuthority.lastMoveIssuedAtTick = 19;
    state.serverAuthority.inFlightMoves.push({
      commandId: 8,
      dx: 1,
      dy: 0,
      durationTicks: 2,
      sprint: false,
      sentAtMs: 1_100,
    });

    applyServerPacket(state, slice(), {
      type: "game.acks",
      acks: [[8, 1, 21]],
      playerPosition: [4.04, 5],
    }, sfxRecorder());

    expect(state.serverAuthority.snapshotTick).toBe(21);
    expect(state.serverAuthority.lastSnapshotReceivedAtMs).toBe(1_200);
    expect(state.serverAuthority.lastMoveIssuedAtTick).toBe(21);
  });
  it("corrects the optimistic move tick on REJECTED move receipts too (blocked_cell)", () => {
    const state = createPlayState(slice());
    state.worldTimeMs = 1_200;
    state.serverAuthority.snapshotTick = 10;
    state.serverAuthority.playerActorId = "player";
    applyAuthoritativeDelta(state, slice(), {
      schema: "successor.authoritative-shard-delta.v1",
      shardId: "test",
      tick: 10,
      playerActorId: "player",
      actors: { player: actorSnapshot("player", 4, 5) },
      sourceStateHash: "hash",
      sourceActorCount: 2,
      counters: counters(),
    });
    // Optimistic stamp far ahead of the server: a blocked_cell rejection
    // returns BEFORE the shard advances next_move_tick. The observed move tick
    // mirror still follows the receipt so probes and future estimates do not
    // stay pinned to stale optimism.
    state.serverAuthority.lastMoveIssuedAtTick = 45;
    state.serverAuthority.inFlightMoves.push({
      commandId: 9,
      dx: 0,
      dy: 1,
      durationTicks: 2,
      sprint: false,
      sentAtMs: 1_100,
    });

    applyServerPacket(state, slice(), {
      type: "game.receipts",
      receipts: [{ commandId: 9, accepted: false, tick: 12, reasonCode: "blocked_cell" }],
      events: [],
    }, sfxRecorder());

    expect(state.serverAuthority.lastMoveIssuedAtTick).toBe(12);
    expect(state.serverAuthority.rejectedCommands).toBe(1);
  });

  it("drops rejected move receipts without advancing the authoritative mirror", () => {
    const state = createPlayState(slice());
    state.serverAuthority.playerActorId = "player";
    applyAuthoritativeDelta(state, slice(), {
      schema: "successor.authoritative-shard-delta.v1",
      shardId: "test",
      tick: 10,
      playerActorId: "player",
      actors: { player: actorSnapshot("player", 4, 5) },
      sourceStateHash: "hash",
      sourceActorCount: 2,
      counters: counters(),
    });
    state.serverAuthority.inFlightMoves.push({
      commandId: 9,
      dx: 1,
      dy: 0,
      durationTicks: 1,
      sprint: false,
      sentAtMs: 1_000,
    });

    applyServerPacket(state, slice(), {
      type: "game.acks",
      acks: [[9, 0, 22, "blocked_cell"]],
    }, sfxRecorder());

    expect(state.serverAuthority.rejectedCommands).toBe(1);
    expect(state.serverAuthority.inFlightMoves).toHaveLength(0);
    expect(state.serverAuthority.lastReceipt).toMatchObject({ commandId: 9, accepted: false, reasonCode: "blocked_cell" });
    expect(state.serverAuthority.recentMoveRejections?.[0]).toEqual({ commandId: 9, reasonCode: "blocked_cell", serverTick: 22, dx: 1, dy: 0 });
    expect(state.serverAuthority.recentMoveRejectionCount).toBe(1);
    expect(state.serverAuthority.recentMoveRejectionWriteIndex).toBe(1);
    expect(state.serverAuthority.actors.player?.x).toBeCloseTo(4);
    expect(state.serverAuthority.authoritativePlayer?.x).toBeCloseTo(4);
  });

  it("removes stale combat state when authority hides a harvested respawning corpse", () => {
    const state = createPlayState(slice());
    state.serverAuthority.playerActorId = "player";
    const downed = {
      ...actorSnapshot("gaia-corpse", 6, 5),
      label: "Duskback Corpse",
      role: "creature",
      lifeState: "downed" as const,
      bodyVanishAtTick: 10_000,
    };
    applyAuthoritativeDelta(state, slice(), {
      schema: "successor.authoritative-shard-delta.v1",
      shardId: "test",
      tick: 10,
      playerActorId: "player",
      actors: { player: actorSnapshot("player", 4, 5), "gaia-corpse": downed },
      counters: counters(),
    });
    expect(state.serverAuthority.actors["gaia-corpse"]?.lifeState).toBe("downed");
    expect(state.actors["gaia-corpse"]?.lifeState).toBe("downed");

    applyAuthoritativeDelta(state, slice(), {
      schema: "successor.authoritative-shard-delta.v1",
      shardId: "test",
      tick: 11,
      playerActorId: "player",
      actors: {
        "gaia-corpse": {
          ...downed,
          lifeState: "respawning" as const,
          bodyVanishAtTick: 0,
        },
      },
      counters: counters(),
    });

    expect(state.serverAuthority.actors["gaia-corpse"]).toBeUndefined();
    expect(state.actors["gaia-corpse"]).toBeUndefined();
  });

  it("keeps authoritative fire debug data on the latest receipt", () => {
    const state = createPlayState(slice());

    applyServerPacket(state, slice(), {
      type: "game.delta",
      receipts: [{
        commandId: 12,
        accepted: true,
        tick: 20,
        fireDebug: {
          shooterActorId: "player",
          areaId: "open-desert-overworld",
          direction: "right",
          actor: { x: 4, y: 5 },
          muzzle: { x: 5.788, y: 5.367 },
          start: { x: 5.868, y: 5.367 },
          end: { x: 69.868, y: 5.367 },
          expandedCollisionRadiusCells: 0.45,
          hitActorId: null,
          hitPoint: null,
          hitZone: null,
          distanceCells: null,
        },
      }],
      delta: {
        schema: "successor.authoritative-shard-delta.v1",
        shardId: "test",
        tick: 20,
        playerActorId: "player",
        actors: {},
        counters: counters(),
      },
      events: [],
    }, sfxRecorder());

    expect(state.serverAuthority.lastReceipt?.fireDebug).toMatchObject({
      shooterActorId: "player",
      start: { x: 5.868, y: 5.367 },
      hitActorId: null,
    });
  });

  it("keeps actor positions stable on rapid hits while projecting every damage number", () => {
    const state = createPlayState(slice());
    state.worldTimeMs = 1000;
    const sfx = sfxRecorder();

    applyServerPacket(state, slice(), {
      type: "game.delta",
      receipts: [],
      delta: {
        schema: "successor.authoritative-shard-delta.v1",
        shardId: "test",
        tick: 20,
        playerActorId: "player",
        actors: {
          shooter: actorSnapshot("shooter", 4, 5),
          vendor: actorSnapshot("vendor", 8, 5),
        },
        counters: counters(),
      },
      events: [1, 2, 3, 4].map((id) => combatEvent(id)),
    } as never, sfx);

    expect(state.serverAuthority.receivedEvents).toBe(4);
    expect(state.hits).toBe(4);
    expect(state.actors.vendor?.hitFlashMs).toBeGreaterThan(0);
    expect(state.serverAuthority.actors.vendor).toMatchObject({ x: 8, y: 5, renderX: 8, renderY: 5 });
    expect(state.floatingTexts.map((text) => text.value)).toEqual([12, 12, 12, 12]);
    expect(state.serverAuthority.visualLog).toHaveLength(4);
    expect(sfx.playedAt).toEqual(["body_hit_2", "body_hit_3", "body_hit_4", "body_hit_1"]);
    expect(state.serverAuthority.lastEvent).toMatchObject({ id: 4, targetActorId: "vendor" });
  });

  it("keeps a manual target sticky through queued player shots and incoming hostile fire", () => {
    const sliceSnapshot = slice();
    const state = createPlayState(sliceSnapshot);
    state.worldTimeMs = 1000;
    state.selectedActorId = "target-a";
    const sfx = sfxRecorder();

    applyServerPacket(state, sliceSnapshot, {
      type: "game.delta",
      receipts: [],
      delta: {
        schema: "successor.authoritative-shard-delta.v1",
        shardId: "test",
        tick: 20,
        playerActorId: "player",
        actors: {
          player: actorSnapshot("player", 4, 5),
          "target-a": actorSnapshot("target-a", 8, 5),
          "hostile-b": actorSnapshot("hostile-b", 6, 5),
        },
        counters: counters(),
      },
      events: [
        { ...combatEvent(10), shooterActorId: "player", targetActorId: "target-a" },
        { ...combatEvent(11), shooterActorId: "hostile-b", targetActorId: "player", hitPoint: { x: 4.15, y: 5.45 } },
        { ...combatEvent(12), shooterActorId: "player", targetActorId: "hostile-b", hitPoint: { x: 6.15, y: 5.45 } },
      ],
    } as never, sfx);

    expect(state.serverAuthority.receivedEvents).toBe(3);
    expect(state.selectedActorId).toBe("target-a");
    expect(state.serverAuthority.lastEvent).toMatchObject({ id: 12, targetActorId: "hostile-b" });
  });

  it("auto-fills an empty selection from the local player's combat target only", () => {
    const sliceSnapshot = slice();
    const state = createPlayState(sliceSnapshot);
    state.worldTimeMs = 1000;
    const sfx = sfxRecorder();

    applyServerPacket(state, sliceSnapshot, {
      type: "game.delta",
      receipts: [],
      delta: {
        schema: "successor.authoritative-shard-delta.v1",
        shardId: "test",
        tick: 20,
        playerActorId: "player",
        actors: {
          player: actorSnapshot("player", 4, 5),
          "target-a": actorSnapshot("target-a", 8, 5),
          "hostile-b": actorSnapshot("hostile-b", 6, 5),
        },
        counters: counters(),
      },
      events: [
        { ...combatEvent(20), shooterActorId: "hostile-b", targetActorId: "player", hitPoint: { x: 4.15, y: 5.45 } },
      ],
    } as never, sfx);

    expect(state.selectedActorId).toBeNull();

    applyServerPacket(state, sliceSnapshot, {
      type: "game.delta",
      receipts: [],
      delta: {
        schema: "successor.authoritative-shard-delta.v1",
        shardId: "test",
        tick: 21,
        playerActorId: "player",
        actors: {},
        counters: counters(),
      },
      events: [
        { ...combatEvent(21), shooterActorId: "player", targetActorId: "target-a" },
      ],
    } as never, sfx);

    expect(state.selectedActorId).toBe("target-a");
  });

  it("shows stat dodges as dodge text without damage numbers or hit counter increments", () => {
    const state = createPlayState(slice());
    state.worldTimeMs = 1000;
    const sfx = sfxRecorder();

    applyServerPacket(state, slice(), {
      type: "game.delta",
      receipts: [],
      delta: {
        schema: "successor.authoritative-shard-delta.v1",
        shardId: "test",
        tick: 20,
        playerActorId: "player",
        actors: {
          shooter: actorSnapshot("shooter", 4, 5),
          vendor: actorSnapshot("vendor", 8, 5),
        },
        counters: counters(),
      },
      events: [{
        ...combatEvent(8),
        damage: 0,
        effect: { kind: "dodge" as const },
        lifecycle: {
          kind: "hit" as const,
          from: "alive" as const,
          to: "alive" as const,
          cause: "dodged",
        },
      }],
    } as never, sfx);

    expect(state.serverAuthority.receivedEvents).toBe(1);
    expect(state.hits).toBe(0);
    expect(state.floatingTexts).toHaveLength(1);
    expect(state.floatingTexts[0]).toMatchObject({ label: "DODGE", value: null });
    expect(state.serverAuthority.visualLog).toHaveLength(1);
    expect(sfx.playedAt).toEqual(["projectile_hit"]);
  });

  it("staggers ranged-roll burst audio on the tracer ordinal and keeps outcome layers distinct", async () => {
    vi.useFakeTimers();
    const performanceNow = vi.spyOn(globalThis.performance, "now").mockReturnValue(0);
    try {
      const state = createPlayState(slice());
      state.worldTimeMs = 1000;
      const sfx = sfxRecorder();
      const rollEvent = (id: number, overrides: Record<string, unknown>) => ({
        ...combatEvent(id),
        shooterActorId: "player",
        kind: "ranged_roll",
        actionId: "burst-a",
        weaponId: "slugthrower" as const,
        ...overrides,
      });

      applyServerPacket(state, slice(), {
        type: "game.delta",
        receipts: [],
        delta: {
          schema: "successor.authoritative-shard-delta.v1",
          shardId: "test",
          tick: 20,
          playerActorId: "player",
          actors: {
            player: actorSnapshot("player", 4, 5),
            vendor: actorSnapshot("vendor", 8, 5),
          },
          counters: counters(),
        },
        events: [
          rollEvent(10, { hit: true }),
          rollEvent(11, { hit: false, damage: 0 }),
          rollEvent(12, {
            hit: true,
            damage: 0,
            effect: { kind: "dodge" as const },
            lifecycle: {
              kind: "hit" as const,
              from: "alive" as const,
              to: "alive" as const,
              cause: "dodged",
            },
          }),
        ],
      } as never, sfx);

      expect(sfx.playedAt.filter((id) => id === "slugthrower_fire")).toHaveLength(1);
      expect(sfx.playedAt.some((id) => id.startsWith("body_hit_"))).toBe(true);
      expect(sfx.playedAt.some((id) => id.startsWith("dart_flesh_tick_"))).toBe(false);
      const rangedImpactIndex = sfx.playedAt.findIndex((id) => id.startsWith("body_hit_"));
      expect(sfx.playAtOptions[rangedImpactIndex]).toMatchObject({
        maxDistanceCells: 24,
        farGainFloor: 0,
      });
      const afterFirst = sfx.playedAt.length;

      await vi.advanceTimersByTimeAsync(113);
      expect(sfx.playedAt).toHaveLength(afterFirst);

      await vi.advanceTimersByTimeAsync(2);
      const afterMiss = sfx.playedAt.slice(afterFirst);
      expect(afterMiss.filter((id) => id === "slugthrower_fire")).toHaveLength(1);
      expect(afterMiss.some((id) => id.startsWith("body_hit_"))).toBe(false);
      expect(afterMiss.some((id) => id.startsWith("dart_flesh_tick_"))).toBe(false);

      await vi.advanceTimersByTimeAsync(115);
      const afterDodge = sfx.playedAt.slice(afterFirst + afterMiss.length);
      expect(afterDodge.filter((id) => id === "slugthrower_fire")).toHaveLength(1);
      expect(afterDodge.some((id) => id.startsWith("dart_flesh_tick_"))).toBe(true);
      expect(afterDodge.some((id) => id.startsWith("body_hit_"))).toBe(false);
    } finally {
      performanceNow.mockRestore();
      vi.useRealTimers();
    }
  });

  it("keeps an unarmed impact local instead of leaking punch audio across the map", () => {
    const state = createPlayState(slice());
    state.worldTimeMs = 1000;
    const sfx = sfxRecorder();

    applyServerPacket(state, slice(), {
      type: "game.delta",
      receipts: [],
      delta: {
        schema: "successor.authoritative-shard-delta.v1",
        shardId: "test",
        tick: 20,
        playerActorId: "player",
        actors: {
          player: actorSnapshot("player", 4, 5),
          vendor: actorSnapshot("vendor", 8, 5),
        },
        counters: counters(),
      },
      events: [{
        ...combatEvent(13),
        shooterActorId: "player",
        kind: "ranged_roll",
        actionId: "basic_shot",
        weaponId: "unarmed" as const,
        ammoTypeId: "melee" as const,
        hit: true,
      }],
    } as never, sfx);

    expect(state.weaponFireAnimations.player).toMatchObject({ weaponId: "unarmed", kind: "fire" });
    expect(sfx.playedAt.some((id) => id === "slugthrower_fire" || id.startsWith("gunshot_"))).toBe(false);
    expect(sfx.playedAt.some((id) => id.startsWith("body_hit_"))).toBe(true);
    const punchImpactIndex = sfx.playedAt.findIndex((id) => id.startsWith("body_hit_"));
    expect(sfx.playAtOptions[punchImpactIndex]).toMatchObject({
      minDistanceCells: 1.25,
      maxDistanceCells: 14,
      rolloff: 2.1,
      farGainFloor: 0,
    });
    expect(state.serverAuthority.visualLog.at(-1)).toMatchObject({ eventId: 13, lifecycleKind: "hit" });
  });

  it("plays utility feedback from authoritative medical and ammo inventory changes", () => {
    const sliceSnapshot = slice();
    const state = createPlayState(sliceSnapshot);
    applyServerPacket(state, sliceSnapshot, {
      type: "game.hello",
      sessionId: "g_1",
      playerActorId: "player",
      serverTime: "1970-01-01T00:00:00.000Z",
      snapshot: shardSnapshot({ sourceStateHash: "hash", sourceActorCount: 2 }),
    }, sfxRecorder());

    const audio = sfxRecorder();
    const bleedingVendor = {
      ...actorSnapshot("vendor", 8, 5),
      bleed: {
        active: true,
        stackCount: 1,
        severity: 2,
        remainingMs: 8_000,
        ratesPerSecond: { health: 3, action: 0, spirit: 0 },
      },
      statuses: [{ id: "bleeding", label: "Bleeding", severity: 2, remainingMs: 8_000 }],
    };
    applyServerPacket(state, sliceSnapshot, {
      type: "game.delta",
      receipts: [],
      delta: {
        schema: "successor.authoritative-shard-delta.v1",
        shardId: "test",
        tick: 21,
        playerActorId: "player",
        actors: { vendor: bleedingVendor },
        counters: counters(),
      },
      events: [],
    } as never, audio);

    applyServerPacket(state, sliceSnapshot, {
      type: "game.delta",
      receipts: [],
      delta: {
        schema: "successor.authoritative-shard-delta.v1",
        shardId: "test",
        tick: 22,
        playerActorId: "player",
        actors: {
          vendor: {
            ...bleedingVendor,
            statuses: [
              ...bleedingVendor.statuses,
              { id: "stimpak_a_heal", label: "Stimpak A", severity: 1, remainingMs: 3_800 },
            ],
          },
        },
        counters: counters(),
      },
      events: [],
    } as never, audio);

    applyServerPacket(state, sliceSnapshot, {
      type: "game.delta",
      receipts: [],
      delta: {
        schema: "successor.authoritative-shard-delta.v1",
        shardId: "test",
        tick: 23,
        playerActorId: "player",
        actors: {
          vendor: {
            ...actorSnapshot("vendor", 8, 5),
            statuses: [{ id: "stimpak_a_heal", label: "Stimpak A", severity: 1, remainingMs: 3_400 }],
          },
        },
        inventory: [{
          container: "vendor:field-pack",
          item: "Iron Slug",
          itemId: 1101,
          variantId: 0,
          quantity: 160,
          reserved: 0,
          available: 160,
        }],
        counters: counters(),
      },
      events: [],
    } as never, audio);

    expect(audio.playedAt).toEqual([]);
    expect(state.floatingTexts.map((text) => text.label)).toEqual(["STIMPAK", "+AMMO", "BANDAGE"]);
    expect(state.floatingTexts.map((text) => text.actorId ?? null)).toEqual(["vendor", "vendor", "vendor"]);
  });

  it("plays local-only profession XP gain feedback from authoritative actor deltas", () => {
    const sliceSnapshot = slice();
    const state = createPlayState(sliceSnapshot);
    state.serverAuthority.playerActorId = "player";

    applyAuthoritativeDelta(state, sliceSnapshot, {
      schema: "successor.authoritative-shard-delta.v1",
      shardId: "test",
      tick: 30,
      playerActorId: "player",
      actors: {
        player: {
          ...actorSnapshot("player", 4, 5),
          professions: [{ id: "marksman", label: "Marksman", xp: 20, trackXp: { rifle: 20 }, skillPoints: 2 }],
        },
        vendor: {
          ...actorSnapshot("vendor", 8, 5),
          professions: [{ id: "scout", label: "Scout", xp: 30, trackXp: { harvest: 30 }, skillPoints: 1 }],
        },
      },
      counters: counters(),
    });

    applyAuthoritativeDelta(state, sliceSnapshot, {
      schema: "successor.authoritative-shard-delta.v1",
      shardId: "test",
      tick: 31,
      playerActorId: "player",
      actors: {
        player: {
          ...actorSnapshot("player", 4, 5),
          professions: [{ id: "marksman", label: "Marksman", xp: 48, trackXp: { rifle: 48 }, skillPoints: 2 }],
        },
        vendor: {
          ...actorSnapshot("vendor", 8, 5),
          professions: [{ id: "scout", label: "Scout", xp: 80, trackXp: { harvest: 80 }, skillPoints: 1 }],
        },
      },
      counters: counters(),
    });

    expect(state.floatingTexts.map((text) => text.label)).toEqual(["+28 RIFLE XP"]);
  });

  it("does not invent shield presentation from actor snapshots without a combat event", () => {
    const sliceSnapshot = slice();
    const state = createPlayState(sliceSnapshot);
    state.serverAuthority.playerActorId = "player";
    const previousShield = {
      chargeMilli: 72_000,
      maxChargeMilli: 100_000,
      durabilityCharges: 72,
      maxDurabilityCharges: 100,
      rechargeAvailableTick: 300,
      rechargeBlocked: true,
      lastDamageTick: 12,
      lastBlockTick: 10,
    };

    applyAuthoritativeDelta(state, sliceSnapshot, {
      schema: "successor.authoritative-shard-delta.v1",
      shardId: "test",
      tick: 40,
      playerActorId: "player",
      actors: {
        player: { ...actorSnapshot("player", 4, 5), personalShield: previousShield },
      },
      counters: counters(),
    });

    applyAuthoritativeDelta(state, sliceSnapshot, {
      schema: "successor.authoritative-shard-delta.v1",
      shardId: "test",
      tick: 41,
      playerActorId: "player",
      actors: {
        player: {
          ...actorSnapshot("player", 4, 5),
          personalShield: { ...previousShield, lastDamageTick: 13, lastBlockTick: 10 },
        },
      },
      counters: counters(),
    });

    expect(state.floatingTexts).toHaveLength(0);
    expect(state.serverAuthority.eventLog).toHaveLength(0);
  });

  it("labels authoritative economy resource gain and store feedback", () => {
    const sliceSnapshot = slice();
    const state = createPlayState(sliceSnapshot);
    const audio = sfxRecorder();
    applyServerPacket(state, sliceSnapshot, {
      type: "game.hello",
      sessionId: "g_1",
      playerActorId: "player",
      serverTime: "1970-01-01T00:00:00.000Z",
      snapshot: shardSnapshot({ sourceStateHash: "hash", sourceActorCount: 2 }),
    }, audio);
    state.inventory = [
      {
        container: "vendor:resource-crate",
        item: "Clodpowder Cinders",
        itemId: 2006,
        variantId: 77,
        quantity: 80,
        reserved: 0,
        available: 80,
      },
      {
        container: "district-exchange",
        item: "Clodpowder Cinders",
        itemId: 2006,
        variantId: 77,
        quantity: 0,
        reserved: 0,
        available: 0,
      },
    ];

    applyServerPacket(state, sliceSnapshot, {
      type: "game.delta",
      receipts: [],
      delta: {
        schema: "successor.authoritative-shard-delta.v1",
        shardId: "test",
        tick: 24,
        playerActorId: "player",
        actors: { vendor: actorSnapshot("vendor", 8, 5) },
        inventory: [
          {
            container: "vendor:resource-crate",
        item: "Clodpowder Cinders",
            itemId: 2006,
            variantId: 77,
            quantity: 0,
            reserved: 0,
            available: 0,
          },
          {
            container: "district-exchange",
        item: "Clodpowder Cinders",
            itemId: 2006,
            variantId: 77,
            quantity: 80,
            reserved: 0,
            available: 80,
          },
        ],
        counters: counters(),
      },
      events: [],
    } as never, audio);

    applyServerPacket(state, sliceSnapshot, {
      type: "game.delta",
      receipts: [],
      delta: {
        schema: "successor.authoritative-shard-delta.v1",
        shardId: "test",
        tick: 25,
        playerActorId: "player",
        actors: { vendor: actorSnapshot("vendor", 8, 5) },
        inventory: [
          {
            container: "district-exchange",
        item: "Clodpowder Cinders",
            itemId: 2006,
            variantId: 77,
            quantity: 80,
            reserved: 0,
            available: 80,
          },
          {
            container: "vendor:resource-crate",
        item: "Clodpowder Cinders",
            itemId: 2006,
            variantId: 77,
            quantity: 0,
            reserved: 0,
            available: 0,
          },
          {
            container: "vendor:resource-crate",
            item: "Iron Resource Container",
            itemId: 2001,
            variantId: 9,
            quantity: 72,
            reserved: 0,
            available: 72,
          },
        ],
        counters: counters(),
      },
      events: [],
    } as never, audio);

    expect(state.floatingTexts.map((text) => text.label)).toEqual(["STORE", "+IRON"]);
    expect(state.floatingTexts.map((text) => text.actorId ?? null)).toEqual(["vendor", "vendor"]);
    expect(audio.playedAt).toEqual([]);
  });

  it("suppresses faraway npc inventory transfer audio while keeping economy visuals", () => {
    const sliceSnapshot = slice();
    const state = createPlayState(sliceSnapshot);
    const audio = sfxRecorder();
    applyServerPacket(state, sliceSnapshot, {
      type: "game.hello",
      sessionId: "g_1",
      playerActorId: "player",
      serverTime: "1970-01-01T00:00:00.000Z",
      snapshot: shardSnapshot({ sourceStateHash: "hash", sourceActorCount: 2 }),
    }, audio);
    state.inventory = [{
      container: "vendor:field-pack",
      item: "Iron Slug",
      itemId: 1101,
      variantId: 0,
      quantity: 10,
      reserved: 0,
      available: 10,
    }];

    applyServerPacket(state, sliceSnapshot, {
      type: "game.delta",
      receipts: [],
      delta: {
        schema: "successor.authoritative-shard-delta.v1",
        shardId: "test",
        tick: 23,
        playerActorId: "player",
        actors: { vendor: actorSnapshot("vendor", 40, 5) },
        inventory: [{
          container: "vendor:field-pack",
          item: "Iron Slug",
          itemId: 1101,
          variantId: 0,
          quantity: 10,
          reserved: 0,
          available: 10,
        }],
        counters: counters(),
      },
      events: [],
    } as never, audio);

    applyServerPacket(state, sliceSnapshot, {
      type: "game.delta",
      receipts: [],
      delta: {
        schema: "successor.authoritative-shard-delta.v1",
        shardId: "test",
        tick: 24,
        playerActorId: "player",
        actors: { vendor: actorSnapshot("vendor", 40, 5) },
        inventory: [{
          container: "vendor:field-pack",
          item: "Iron Slug",
          itemId: 1101,
          variantId: 0,
          quantity: 20,
          reserved: 0,
          available: 20,
        }],
        counters: counters(),
      },
      events: [],
    } as never, audio);

    expect(state.floatingTexts.map((text) => text.label)).toEqual(["+AMMO"]);
    expect(audio.playedAt).toEqual([]);
  });

  it("keeps nearby npc inventory transfer feedback visual-only", () => {
    const sliceSnapshot = slice();
    const state = createPlayState(sliceSnapshot);
    const audio = sfxRecorder();
    applyServerPacket(state, sliceSnapshot, {
      type: "game.hello",
      sessionId: "g_1",
      playerActorId: "player",
      serverTime: "1970-01-01T00:00:00.000Z",
      snapshot: shardSnapshot({ sourceStateHash: "hash", sourceActorCount: 2 }),
    }, audio);
    state.inventory = [{
      container: "vendor:field-pack",
      item: "Iron Slug",
      itemId: 1101,
      variantId: 0,
      quantity: 10,
      reserved: 0,
      available: 10,
    }];

    applyServerPacket(state, sliceSnapshot, {
      type: "game.delta",
      receipts: [],
      delta: {
        schema: "successor.authoritative-shard-delta.v1",
        shardId: "test",
        tick: 24,
        playerActorId: "player",
        actors: { vendor: actorSnapshot("vendor", 8, 5) },
        inventory: [{
          container: "vendor:field-pack",
          item: "Iron Slug",
          itemId: 1101,
          variantId: 0,
          quantity: 20,
          reserved: 0,
          available: 20,
        }],
        counters: counters(),
      },
      events: [],
    } as never, audio);

    expect(audio.playedAt).toEqual([]);
  });

  it("keeps local player support and inventory feedback audible", () => {
    const sliceSnapshot = slice();
    const state = createPlayState(sliceSnapshot);
    const audio = sfxRecorder();
    applyServerPacket(state, sliceSnapshot, {
      type: "game.hello",
      sessionId: "g_1",
      playerActorId: "player",
      serverTime: "1970-01-01T00:00:00.000Z",
      snapshot: shardSnapshot({ sourceStateHash: "hash", sourceActorCount: 2 }),
    }, audio);
    state.inventory = [
      {
        container: "player:field-pack",
        item: "Stimpak A",
        itemId: 1001,
        variantId: 0,
        quantity: 10,
        reserved: 0,
        available: 10,
      },
      {
        container: "player:field-pack",
        item: "Field Bandage",
        itemId: 1002,
        variantId: 0,
        quantity: 10,
        reserved: 0,
        available: 10,
      },
      {
        container: "player:field-pack",
        item: "Iron Slug",
        itemId: 1101,
        variantId: 0,
        quantity: 10,
        reserved: 0,
        available: 10,
      },
    ];

    applyServerPacket(state, sliceSnapshot, {
      type: "game.delta",
      receipts: [],
      delta: {
        schema: "successor.authoritative-shard-delta.v1",
        shardId: "test",
        tick: 24,
        playerActorId: "player",
        actors: { player: actorSnapshot("player", 4, 5) },
        inventory: [
          {
            container: "player:field-pack",
            item: "Stimpak A",
            itemId: 1001,
            variantId: 0,
            quantity: 9,
            reserved: 0,
            available: 9,
          },
          {
            container: "player:field-pack",
            item: "Field Bandage",
            itemId: 1002,
            variantId: 0,
            quantity: 9,
            reserved: 0,
            available: 9,
          },
          {
            container: "player:field-pack",
            item: "Iron Slug",
            itemId: 1101,
            variantId: 0,
            quantity: 20,
            reserved: 0,
            available: 20,
          },
        ],
        counters: counters(),
      },
      events: [],
    } as never, audio);

    expect(audio.playedAt).toEqual(["stimpak_apply", "bandage_apply", "inventory_transfer"]);
    expect(state.floatingTexts.map((text) => text.label)).toEqual(["STIMPAK", "BANDAGE", "+AMMO"]);
    expect(state.floatingTexts.map((text) => text.actorId ?? null)).toEqual(["player", "player", "player"]);
  });

  it("throttles repeated authoritative ammo gain visuals for the same actor item", () => {
    const sliceSnapshot = slice();
    const state = createPlayState(sliceSnapshot);
    const audio = sfxRecorder();
    applyServerPacket(state, sliceSnapshot, {
      type: "game.hello",
      sessionId: "g_1",
      playerActorId: "player",
      serverTime: "1970-01-01T00:00:00.000Z",
      snapshot: shardSnapshot({ sourceStateHash: "hash", sourceActorCount: 2 }),
    }, audio);
    state.inventory = [{
      container: "vendor:field-pack",
      item: "Iron Slug",
      itemId: 1101,
      variantId: 0,
      quantity: 10,
      reserved: 0,
      available: 10,
    }];

    state.worldTimeMs = 1_000;
    applyServerPacket(state, sliceSnapshot, {
      type: "game.delta",
      receipts: [],
      delta: {
        schema: "successor.authoritative-shard-delta.v1",
        shardId: "test",
        tick: 24,
        playerActorId: "player",
        actors: { vendor: actorSnapshot("vendor", 8, 5) },
        inventory: [{
          container: "vendor:field-pack",
          item: "Iron Slug",
          itemId: 1101,
          variantId: 0,
          quantity: 20,
          reserved: 0,
          available: 20,
        }],
        counters: counters(),
      },
      events: [],
    } as never, audio);

    state.worldTimeMs = 1_100;
    applyServerPacket(state, sliceSnapshot, {
      type: "game.delta",
      receipts: [],
      delta: {
        schema: "successor.authoritative-shard-delta.v1",
        shardId: "test",
        tick: 25,
        playerActorId: "player",
        actors: { vendor: actorSnapshot("vendor", 8, 5) },
        inventory: [{
          container: "vendor:field-pack",
          item: "Iron Slug",
          itemId: 1101,
          variantId: 0,
          quantity: 30,
          reserved: 0,
          available: 30,
        }],
        counters: counters(),
      },
      events: [],
    } as never, audio);

    expect(state.floatingTexts.map((text) => text.label)).toEqual(["+AMMO"]);
    expect(audio.playedAt).toEqual([]);
  });

  it("plays bandage feedback from authoritative inventory consumption while bleeding remains", () => {
    const sliceSnapshot = slice();
    const state = createPlayState(sliceSnapshot);
    applyServerPacket(state, sliceSnapshot, {
      type: "game.hello",
      sessionId: "g_1",
      playerActorId: "player",
      serverTime: "1970-01-01T00:00:00.000Z",
      snapshot: shardSnapshot({ sourceStateHash: "hash", sourceActorCount: 2 }),
    }, sfxRecorder());
    state.inventory = [{
      container: "vendor:field-pack",
      item: "Field Bandage",
      itemId: 1002,
      variantId: 0,
      quantity: 10,
      reserved: 0,
      available: 10,
    }];

    const audio = sfxRecorder();
    applyServerPacket(state, sliceSnapshot, {
      type: "game.delta",
      receipts: [],
      delta: {
        schema: "successor.authoritative-shard-delta.v1",
        shardId: "test",
        tick: 24,
        playerActorId: "player",
        actors: {
          vendor: {
            ...actorSnapshot("vendor", 8, 5),
            bleed: {
              active: true,
              stackCount: 1,
              severity: 2,
              remainingMs: 8_000,
              ratesPerSecond: { health: 3, action: 0, spirit: 0 },
            },
            statuses: [{ id: "bleeding", label: "Bleeding", severity: 2, remainingMs: 8_000 }],
          },
        },
        inventory: [{
          container: "vendor:field-pack",
          item: "Field Bandage",
          itemId: 1002,
          variantId: 0,
          quantity: 9,
          reserved: 0,
          available: 9,
        }],
        counters: counters(),
      },
      events: [],
    } as never, audio);

    expect(audio.playedAt).toEqual([]);
    expect(state.floatingTexts.map((text) => text.label)).toEqual(["BANDAGE"]);
    expect(state.floatingTexts.map((text) => text.actorId ?? null)).toEqual(["vendor"]);
  });

  it("plays remote bandage feedback when authoritative actor bleed clears without inventory visibility", () => {
    const sliceSnapshot = slice();
    const state = createPlayState(sliceSnapshot);
    applyServerPacket(state, sliceSnapshot, {
      type: "game.hello",
      sessionId: "g_1",
      playerActorId: "player",
      serverTime: "1970-01-01T00:00:00.000Z",
      snapshot: shardSnapshot({ sourceStateHash: "hash", sourceActorCount: 2 }),
    }, sfxRecorder());

    const bleedingVendor = {
      ...actorSnapshot("vendor", 8, 5),
      bleed: {
        active: true,
        stackCount: 1,
        severity: 2,
        remainingMs: 8_000,
        ratesPerSecond: { health: 3, action: 0, spirit: 0 },
      },
      statuses: [{ id: "bleeding", label: "Bleeding", severity: 2, remainingMs: 8_000 }],
    };

    const audio = sfxRecorder();
    applyServerPacket(state, sliceSnapshot, {
      type: "game.delta",
      receipts: [],
      delta: {
        schema: "successor.authoritative-shard-delta.v1",
        shardId: "test",
        tick: 27,
        playerActorId: "player",
        actors: { vendor: bleedingVendor },
        counters: counters(),
      },
      events: [],
    } as never, audio);

    applyServerPacket(state, sliceSnapshot, {
      type: "game.delta",
      receipts: [],
      delta: {
        schema: "successor.authoritative-shard-delta.v1",
        shardId: "test",
        tick: 28,
        playerActorId: "player",
        actors: { vendor: actorSnapshot("vendor", 8, 5) },
        counters: counters(),
      },
      events: [],
    } as never, audio);

    expect(audio.playedAt).toEqual([]);
    expect(state.floatingTexts.map((text) => text.label)).toEqual(["BANDAGE"]);
    expect(state.floatingTexts.map((text) => text.actorId ?? null)).toEqual(["vendor"]);
  });

  it("plays stimpak feedback from authoritative inventory consumption when actor status is omitted", () => {
    const sliceSnapshot = slice();
    const state = createPlayState(sliceSnapshot);
    applyServerPacket(state, sliceSnapshot, {
      type: "game.hello",
      sessionId: "g_1",
      playerActorId: "player",
      serverTime: "1970-01-01T00:00:00.000Z",
      snapshot: shardSnapshot({ sourceStateHash: "hash", sourceActorCount: 2 }),
    }, sfxRecorder());
    state.inventory = [{
      container: "vendor:field-pack",
      item: "Stimpak A",
      itemId: 1001,
      variantId: 0,
      quantity: 10,
      reserved: 0,
      available: 10,
    }];

    const audio = sfxRecorder();
    applyServerPacket(state, sliceSnapshot, {
      type: "game.delta",
      receipts: [],
      delta: {
        schema: "successor.authoritative-shard-delta.v1",
        shardId: "test",
        tick: 25,
        playerActorId: "player",
        actors: {},
        inventory: [{
          container: "vendor:field-pack",
          item: "Stimpak A",
          itemId: 1001,
          variantId: 0,
          quantity: 9,
          reserved: 0,
          available: 9,
        }],
        counters: counters(),
      },
      events: [],
    } as never, audio);

    expect(audio.playedAt).toEqual([]);
    expect(state.floatingTexts.map((text) => text.label)).toEqual(["STIMPAK"]);
    expect(state.floatingTexts.map((text) => text.actorId ?? null)).toEqual(["vendor"]);
  });

  it("plays distinct feedback for simultaneous stimpak and bandage consumption", () => {
    const sliceSnapshot = slice();
    const state = createPlayState(sliceSnapshot);
    applyServerPacket(state, sliceSnapshot, {
      type: "game.hello",
      sessionId: "g_1",
      playerActorId: "player",
      serverTime: "1970-01-01T00:00:00.000Z",
      snapshot: shardSnapshot({ sourceStateHash: "hash", sourceActorCount: 2 }),
    }, sfxRecorder());
    state.inventory = [
      {
        container: "vendor:field-pack",
        item: "Stimpak A",
        itemId: 1001,
        variantId: 0,
        quantity: 10,
        reserved: 0,
        available: 10,
      },
      {
        container: "vendor:field-pack",
        item: "Field Bandage",
        itemId: 1002,
        variantId: 0,
        quantity: 10,
        reserved: 0,
        available: 10,
      },
    ];

    const audio = sfxRecorder();
    applyServerPacket(state, sliceSnapshot, {
      type: "game.delta",
      receipts: [],
      delta: {
        schema: "successor.authoritative-shard-delta.v1",
        shardId: "test",
        tick: 26,
        playerActorId: "player",
        actors: {
          vendor: {
            ...actorSnapshot("vendor", 8, 5),
            bleed: {
              active: true,
              stackCount: 1,
              severity: 2,
              remainingMs: 8_000,
              ratesPerSecond: { health: 3, action: 0, spirit: 0 },
            },
            statuses: [{ id: "bleeding", label: "Bleeding", severity: 2, remainingMs: 8_000 }],
          },
        },
        inventory: [
          {
            container: "vendor:field-pack",
            item: "Stimpak A",
            itemId: 1001,
            variantId: 0,
            quantity: 9,
            reserved: 0,
            available: 9,
          },
          {
            container: "vendor:field-pack",
            item: "Field Bandage",
            itemId: 1002,
            variantId: 0,
            quantity: 9,
            reserved: 0,
            available: 9,
          },
        ],
        counters: counters(),
      },
      events: [],
    } as never, audio);

    expect(audio.playedAt).toEqual([]);
    expect(state.floatingTexts.map((text) => text.label)).toEqual(["STIMPAK", "BANDAGE"]);
    expect(state.floatingTexts.map((text) => text.actorId ?? null)).toEqual(["vendor", "vendor"]);
  });

  it("applies authoritative death events immediately when actor detail is budgeted out", () => {
    const sliceSnapshot = slice();
    const state = createPlayState(sliceSnapshot);
    const sfx = sfxRecorder();

    applyServerPacket(state, sliceSnapshot, {
      type: "game.delta",
      receipts: [],
      delta: {
        schema: "successor.authoritative-shard-delta.v1",
        shardId: "test",
        tick: 20,
        playerActorId: "player",
        actors: {
          shooter: actorSnapshot("shooter", 4, 5),
          vendor: actorSnapshot("vendor", 8, 5),
        },
        counters: counters(),
      },
      events: [],
    } as never, sfx);
    state.actorPresentationFrames.vendor = {
      actorId: "vendor",
      label: "vendor",
      sheetId: "walk",
      frameLabel: "walk_00",
      animated: true,
      lifecycleSeq: 1,
      direction: "right",
      frameIndex: 0,
      runtimeFrameIndex: 0,
      x: 8,
      y: 5,
      nameplateVisible: true,
      statusChipsVisible: false,
    };

    applyServerPacket(state, sliceSnapshot, {
      type: "game.delta",
      receipts: [],
      delta: {
        schema: "successor.authoritative-shard-delta.v1",
        shardId: "test",
        tick: 21,
        playerActorId: "player",
        actors: {},
        counters: counters(),
      },
      events: [{
        ...combatEvent(32),
        lifeState: "downed",
        lifecycle: { kind: "killed", from: "alive", to: "downed", cause: "critical trauma" },
      }],
    } as never, sfx);

    expect(state.serverAuthority.actors.vendor).toMatchObject({
      lifeState: "downed",
      vitals: { health: 0, action: 0, spirit: 0 },
    });
    expect(state.actors.vendor).toMatchObject({
      lifeState: "downed",
      downed: true,
      vitals: { health: 0, action: 0, spirit: 0 },
    });
    expect(state.actors.vendor?.statuses.some((status) => status.id === "dead")).toBe(true);
    expect(state.actorPresentationFrames.vendor).toBeUndefined();
  });

  it("clears stale presentation frames when an actor leaves authority AOI", () => {
    const sliceSnapshot = slice();
    const state = createPlayState(sliceSnapshot);
    const sfx = sfxRecorder();

    applyServerPacket(state, sliceSnapshot, {
      type: "game.delta",
      receipts: [],
      delta: {
        schema: "successor.authoritative-shard-delta.v1",
        shardId: "test",
        tick: 20,
        playerActorId: "player",
        actors: {
          vendor: actorSnapshot("vendor", 8, 5),
        },
        counters: counters(),
      },
      events: [],
    } as never, sfx);
    state.actorPresentationFrames.vendor = {
      actorId: "vendor",
      label: "vendor",
      sheetId: "walk",
      frameLabel: "walk_03",
      animated: true,
      lifecycleSeq: 1,
      direction: "front",
      frameIndex: 3,
      runtimeFrameIndex: 43,
      x: 8,
      y: 5,
      nameplateVisible: true,
      statusChipsVisible: false,
    };

    applyServerPacket(state, sliceSnapshot, {
      type: "game.delta",
      receipts: [],
      delta: {
        schema: "successor.authoritative-shard-delta.v1",
        shardId: "test",
        tick: 21,
        playerActorId: "player",
        actorRemovals: ["vendor"],
        actors: {},
        counters: counters(),
      },
      events: [],
    } as never, sfx);

    expect(state.serverAuthority.actors.vendor).toBeUndefined();
    expect(state.actorPresentationFrames.vendor).toBeUndefined();
  });

  it("records non-active-area combat events without leaking their visuals into the current area", () => {
    const state = createPlayState(slice());
    state.activeAreaId = "test-interior";
    const sfx = sfxRecorder();

    applyServerPacket(state, slice(), {
      type: "game.delta",
      receipts: [],
      delta: {
        schema: "successor.authoritative-shard-delta.v1",
        shardId: "test",
        tick: 20,
        playerActorId: "player",
        actors: {
          shooter: actorSnapshot("shooter", 4, 5),
          vendor: actorSnapshot("vendor", 8, 5),
        },
        counters: counters(),
      },
      events: [combatEvent(1)],
    } as never, sfx);

    expect(state.serverAuthority.receivedEvents).toBe(1);
    expect(state.serverAuthority.lastEvent).toMatchObject({ id: 1, targetActorId: "vendor" });
    expect(state.hits).toBe(0);
    expect(state.selectedActorId).toBeNull();
    expect(state.floatingTexts).toHaveLength(0);
    expect(sfx.playedAt).toHaveLength(0);
  });

  it("applies placedCamps full-replace and folds camp collision into movement blockers", () => {
    registerCampCollisionProfile("scout-camp", {
      walls: [{ minX: -1, minY: -1, maxX: 1, maxY: -0.8 }],
      door: { minX: -0.5, minY: 0.8, maxX: 0.5, maxY: 1 },
    });
    try {
      const sliceSnapshot = slice();
      const state = createPlayState(sliceSnapshot);
      applyServerPacket(state, sliceSnapshot, {
        type: "game.hello",
        sessionId: "g_1",
        playerActorId: "player",
        serverTime: "1970-01-01T00:00:00.000Z",
        snapshot: shardSnapshot({
          placedCamps: [{
            campId: "camp:player:1",
            areaId: "open-desert-overworld",
            cellX: 10,
            cellY: 6,
            isOwner: true,
            renderKind: "scout-camp",
            abandonSecondsRemaining: 894,
          }],
        }),
      }, sfxRecorder());

      expect(state.serverAuthority.placedCamps).toHaveLength(1);
      expect(state.serverAuthority.placedCamps[0]).toMatchObject({
        campId: "camp:player:1",
        isOwner: true,
        renderKind: "scout-camp",
        abandonSecondsRemaining: 894,
      });
      // Camp walls + CLOSED door blocker joined the shared movement set
      // (translated to the camp center 10.5, 6.5).
      expect(state.movementBlockers).toContainEqual({ left: 9.5, top: 5.5, right: 11.5, bottom: 5.7 });
      expect(state.movementBlockers).toContainEqual({ left: 10, top: 7.3, right: 11, bottom: 7.5 });

      // Auto-door slides open (renderer drive) → the next rebuild-carrying
      // delta drops ONLY the door blocker.
      setCampDoorOpen("camp:player:1", true);
      applyAuthoritativeDelta(state, sliceSnapshot, {
        schema: "successor.authoritative-shard-delta.v1",
        shardId: "test",
        tick: 21,
        playerActorId: "player",
        actors: {},
        propStates: {},
        counters: counters(),
      });
      expect(state.movementBlockers).toContainEqual({ left: 9.5, top: 5.5, right: 11.5, bottom: 5.7 });
      expect(state.movementBlockers).not.toContainEqual({ left: 10, top: 7.3, right: 11, bottom: 7.5 });

      // Full-replace: an empty list despawns the camp AND its collision.
      applyAuthoritativeDelta(state, sliceSnapshot, {
        schema: "successor.authoritative-shard-delta.v1",
        shardId: "test",
        tick: 22,
        playerActorId: "player",
        actors: {},
        placedCamps: [],
        placedParcels: [],
        farmPlots: [],
        propStates: {},
        counters: counters(),
      });
      expect(state.serverAuthority.placedCamps).toHaveLength(0);
      expect(state.movementBlockers).not.toContainEqual({ left: 9.5, top: 5.5, right: 11.5, bottom: 5.7 });
    } finally {
      registerCampCollisionProfile("scout-camp", null);
      clearCampDoorState("camp:player:1");
    }
  });
  it("enqueues one actor-routed bubble for valid dialogue and ignores malformed deliveries", () => {
    const sliceSnapshot = slice();
    const state = createPlayState(sliceSnapshot);
    applyServerPacket(state, sliceSnapshot, {
      type: "game.delta",
      receipts: [],
      delta: {
        schema: "successor.authoritative-shard-delta.v1",
        shardId: "test",
        tick: 24,
        playerActorId: "player",
        actors: {},
        dialogueDeliveries: [
          { actorId: "vendor", speaker: "Warden", body: "Stay sharp." },
          { actorId: "vendor", speaker: "Warden", body: "   " },
          { actorId: "vendor", speaker: "", body: "ignored" },
          { actorId: 9 as unknown as string, speaker: "Warden", body: "ignored" },
        ],
        counters: counters(),
      },
      events: [],
    }, sfxRecorder());
    expect(state.chatBubbles).toHaveLength(1);
    expect(state.chatBubbles[0]).toMatchObject({
      actorId: "vendor",
      sender: "Warden",
      body: "Stay sharp.",
      own: false,
    });
  });
});

function slice(): SliceSnapshot {
  return {
    schema: "test",
    tick: 1,
    tickRateHz: 30,
    combatModel: "roll",
    grid: { cellSizePx: 32 },
    zone: { id: 1, name: "Test", width: 24, height: 18, level: 0 },
    areas: [{ id: "open-desert-overworld", name: "Open Desert", kind: "overworld", width: 24, height: 18, level: 0 }],
    stateHash: "hash",
    camera: { followActor: "player", zoom: 1 },
    actors: [player, vendor],
    props: [],
    blockedCells: [],
    transitions: [],
    inventory: [],
    reservations: [],
    events: [],
  };
}

function shardSnapshot(overrides: Partial<{ sourceStateHash: string; sourceActorCount: number }> & Record<string, unknown> = {}) {
  return {
    schema: "successor.authoritative-shard-snapshot.v1" as const,
    shardId: "test",
    tick: 20,
    playerActorId: "player",
    actors: {
      player: actorSnapshot("player", 4, 5),
      vendor: actorSnapshot("vendor", 8, 5),
    },
    sourceStateHash: "hash",
    sourceActorCount: 2,
    counters: counters(),
    ...overrides,
  };
}

function actorSnapshot(id: string, x: number, y: number) {
  return {
    id,
    label: id,
    areaId: "open-desert-overworld",
    x,
    y,
    direction: "right" as const,
    lifeState: "alive" as const,
    lifecycleSeq: 1,
    vitals: { health: 100, action: 100, spirit: 100 },
    maxVitals: { health: 100, action: 100, spirit: 100 },
    bleed: {
      active: false,
      stackCount: 0,
      severity: 0,
      remainingMs: 0,
      ratesPerSecond: { health: 0, action: 0, spirit: 0 },
    },
    statuses: [],
  };
}

function counters() {
  return {
    acceptedCommands: 0,
    rejectedCommands: 0,
    shotsFired: 0,
    hits: 0,
    deaths: 0,
  };
}

function combatEvent(id: number) {
  return {
    id,
    tick: 20,
    shooterActorId: "shooter",
    targetActorId: "vendor",
    hitPoint: { x: 8.15, y: 5.45 },
    damage: 12,
    zone: "torso" as const,
    previousLifeState: "alive" as const,
    lifeState: "alive" as const,
    targetLifecycleSeq: 1,
    bleedStackCount: 0,
    lifecycle: {
      kind: "hit" as const,
      from: "alive" as const,
      to: "alive" as const,
      cause: "torso hit",
    },
  };
}

function sfxRecorder(): SfxPlayer & {
  playedAt: string[];
  played: string[];
  playAtPositions: SfxPoint[];
  playAtOptions: SfxPlayOptions[];
} {
  const recorder = {
    playedAt: [] as string[],
    playAtPositions: [] as SfxPoint[],
    playAtOptions: [] as SfxPlayOptions[],
    played: [] as string[],
    probe: {
      ready: true,
      unlocked: true,
      clipCount: 0,
      lastPlayed: null,
      listener: null,
      lastDistanceCells: null,
      lastPan: 0,
      lastGain: 1,
      errors: [],
    },
    load: async () => undefined,
    play: (id: string) => {
      recorder.played.push(id);
    },
    playAt: (id: string, position: SfxPoint, options?: SfxPlayOptions) => {
      recorder.playedAt.push(id);
      recorder.playAtPositions.push(position);
      recorder.playAtOptions.push(options ?? {});
    },
    setListenerPosition: () => undefined,
  };
  return recorder as SfxPlayer & {
    playedAt: string[];
    played: string[];
    playAtPositions: SfxPoint[];
    playAtOptions: SfxPlayOptions[];
  };
}
