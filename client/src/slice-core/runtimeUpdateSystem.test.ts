import { describe, expect, it, vi } from "vitest";
import type { SfxPlayer } from "../audio/sfx";
import { createPlayState, type ActorSnapshot, type ServerAuthorityActorState, type SliceSnapshot } from "./gameState";
import { applyServerPacket, flushGameAuthorityCommands } from "./gameAuthoritySystem";
import {
  authorityMoveDurationTicks,
  deadReckonedAuthorityPlayerTarget,
  enqueueAuthorityMovementForCellCrossing,
  movingAuthorityCorrection,
  predictedAuthorityPlayerTarget,
  movementInputKeys,
  predictServerAuthorityMovement,
  reconcileServerAuthorityPlayer,
  updateActorPresentationTimers,
  updateChatBubbleTtls,
  updatePlayState,
  updateServerAuthorityActorVisuals,
} from "./runtimeUpdateSystem";
import {
  clickMoveTarget,
  clickRouteReplanCount,
  clickRouteWaypoints,
  drainClickMoveEvents,
  movementVectorFromKeys,
  setClickMoveTarget,
  setSprintToggleEnabled,
  type ClickMoveEvent,
} from "./movementSystem";
import type { PropSnapshot } from "./worldTypes";

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

const targetProp: PropSnapshot = {
  id: "target-1",
  entity: "prop.target",
  areaId: "open-desert-overworld",
  label: "Range Target",
  kind: "target",
  cell: { x: 3, y: 3 },
  size: { w: 1, h: 1 },
  interactive: true,
  solid: true,
  visible: true,
};

function slice(props: PropSnapshot[] = [targetProp], overrides: Partial<SliceSnapshot> = {}): SliceSnapshot {
  const base: SliceSnapshot = {
    schema: "test",
    tick: 1,
    tickRateHz: 20,
    combatModel: "roll",
    grid: { cellSizePx: 32 },
    zone: { id: 1, name: "Test", width: 24, height: 18, level: 0 },
    areas: [{ id: "open-desert-overworld", name: "Open Desert", kind: "overworld", width: 24, height: 18, level: 0 }],
    stateHash: "hash",
    camera: { followActor: "player", zoom: 1 },
    actors: [player, vendor],
    props,
    blockedCells: [],
    transitions: [],
    inventory: [],
    reservations: [],
    events: [],
  };
  return { ...base, ...overrides };
}

function play(sliceSnapshot = slice()) {
  return createPlayState(sliceSnapshot);
}

function sfx(): SfxPlayer {
  return {
    play: vi.fn(),
    playAt: vi.fn(),
    setListenerPosition: vi.fn(),
  } as unknown as SfxPlayer;
}

function remoteAuthorityActor(overrides: Partial<ServerAuthorityActorState> = {}): ServerAuthorityActorState {
  return {
    id: "vendor",
    label: "Warden",
  areaId: "open-desert-overworld",
    x: 10,
    y: 5,
    direction: "right",
    lifeState: "alive",
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
    ...overrides,
  };
}

describe("runtimeUpdateSystem", () => {
  it("locks local input while the recording camera follows a remote actor", () => {
    const sliceSnapshot = slice();
    const state = play(sliceSnapshot);
    const audio = sfx();
    state.serverAuthority.connected = true;
    state.serverAuthority.status = "connected";
    state.serverAuthority.sourceMatchesClient = true;
    state.observerCamera = {
      followActorId: "desert-warden-agent-wing-02",
      inputLocked: true,
    };
    state.keys.add("KeyD");
    state.keys.add("Space");
    state.serverAuthority.actors["desert-warden-agent-wing-02"] = {
      id: "desert-warden-agent-wing-02",
      label: "Warden Lead",
  areaId: "open-desert-overworld",
      x: 12,
      y: 7,
      renderX: 12,
      renderY: 7,
      direction: "left",
      lifeState: "alive",
      lifecycleSeq: 1,
      vitals: { health: 250, action: 100, spirit: 100 },
      maxVitals: { health: 250, action: 100, spirit: 100 },
      bleed: {
        active: false,
        stackCount: 0,
        severity: 0,
        remainingMs: 0,
        ratesPerSecond: { health: 0, action: 0, spirit: 0 },
      },
      statuses: [],
    };

    updatePlayState(state, sliceSnapshot, 16, 1_000, audio);

    expect(state.player).toEqual({ x: 12, y: 7 });
    expect(state.facing).toBe("left");
    expect(state.moving).toBe(false);
    expect(state.authorityCommands.pending).toHaveLength(0);
    expect(audio.setListenerPosition).toHaveBeenCalledWith({ x: 12.5, y: 7.5 });
  });

  it("updates movement, queues roll combat, timers, and listener position through the frame tick", () => {
    const sliceSnapshot = slice();
    const state = play(sliceSnapshot);
    const audio = sfx();
    state.serverAuthority.connected = true;
    state.serverAuthority.status = "connected";
    state.serverAuthority.sourceMatchesClient = true;
    state.keys.add("KeyD");
    state.keys.add("Space");
    state.softLockActorId = "vendor";
    state.cooldownMs = 20;
    state.cooldownTotalMs = 20;
    state.chatBubbles = [{ body: "hey", sender: "Field Observer", own: true, ttlMs: 1000, totalTtlMs: 1000 }];

    updatePlayState(state, sliceSnapshot, 100, 1_000, audio);

    expect(audio.setListenerPosition).toHaveBeenCalledWith({ x: 4.5, y: 5.5 });
    expect(state.player.x).toBeGreaterThan(4);
    expect(state.facing).toBe("right");
    expect(state.status).toBe("server authority moving");
    expect(state.cooldownMs).toBe(0);
    expect(state.cooldownTotalMs).toBe(0);
    expect(state.rollRepeatTargetId).toBe("vendor");
    expect(state.authorityCommands.totalQueued).toBe(2);
    expect(state.authorityCommands.pending.at(-1)?.command).toEqual({
      QueueCombatAction: { action_id: "basic_shot", target_actor_id: "vendor" },
    });
    expect(state.chatBubbles[0]?.ttlMs).toBe(900);
  });

  it("expires actor hit-flash presentation without changing authority statuses", () => {
    const state = play();
    const combat = state.actors.vendor!;
    combat.hitFlashMs = 120;
    const statuses = combat.statuses;

    updateActorPresentationTimers(state, 50);

    expect(combat.hitFlashMs).toBe(70);
    expect(combat.statuses).toBe(statuses);

    updateActorPresentationTimers(state, 100);
    expect(combat.hitFlashMs).toBe(0);
  });

  it("queues Rust-shaped movement intents when player movement crosses cells", () => {
    const sliceSnapshot = slice();
    const state = play(sliceSnapshot);
    const audio = sfx();
    state.serverAuthority.connected = true;
    state.serverAuthority.sourceMatchesClient = true;
    state.player = { x: 4.99, y: 5 };
    state.keys.add("KeyD");

    updatePlayState(state, sliceSnapshot, 100, 1_000, audio);

    expect(state.player.x).toBeGreaterThan(5);
    expect(state.authorityCommands.totalQueued).toBe(1);
    expect(state.authorityCommands.pending[0]).toEqual({
      session: 1,
      player: 1,
      command_id: 1,
      issued_at_tick: 20,
      command: { SetMoveIntent: { dx: 1, dy: 0, facing: "Right" } },
    });
  });

  it("keeps world-cardinal WASD as axis-aligned authority intents", () => {
    const cases = [
      { key: "KeyW", dx: 0, dy: -1 },
      { key: "KeyA", dx: -1, dy: 0 },
      { key: "KeyS", dx: 0, dy: 1 },
      { key: "KeyD", dx: 1, dy: 0 },
    ];
    for (const expected of cases) {
      const sliceSnapshot = slice();
      const state = play(sliceSnapshot);
      state.serverAuthority.connected = true;
      state.serverAuthority.sourceMatchesClient = true;
      state.movementInputMode = "world";
      state.keys.add(expected.key);

      updatePlayState(state, sliceSnapshot, 100, 1_000, sfx());

      expect(state.authorityCommands.pending[0]?.command).toMatchObject({
        SetMoveIntent: { dx: expected.dx, dy: expected.dy },
      });
    }
  });

  it("sprints on shift by moving faster and leaving Action spend to authority acks", () => {
    const sliceSnapshot = slice();
    const state = play(sliceSnapshot);
    const audio = sfx();
    state.serverAuthority.connected = true;
    state.serverAuthority.sourceMatchesClient = true;
    state.player = { x: 4, y: 5 };
    state.keys.add("ShiftLeft");
    state.keys.add("KeyD");
    const startingAction = state.actors.player!.vitals.action;

    updatePlayState(state, sliceSnapshot, 100, 1_000, audio);

    expect(state.player.x).toBeCloseTo(4.1566, 3);
    expect(state.actors.player!.vitals.action).toBe(startingAction);
    expect(state.authorityCommands.pending[0]?.command).toEqual({
      SetMoveIntent: { dx: 1, dy: 0, facing: "Right", sprint: true },
    });
    expect(state.status).toBe("server authority sprinting");
  });

  it("caps local prediction lead from authoritative movement state", () => {
    const sliceSnapshot = slice();
    const state = play(sliceSnapshot);
    state.serverAuthority.enabled = true;
    state.serverAuthority.connected = true;
    state.serverAuthority.sourceMatchesClient = true;
    state.serverAuthority.playerActorId = "player";
    state.serverAuthority.actors.player = {
      id: "player",
      label: "Field Observer",
  areaId: "open-desert-overworld",
      x: 4,
      y: 5,
      direction: "right",
      lifeState: "alive",
      lifecycleSeq: 1,
      vitals: { health: 155, action: 155, spirit: 160 },
      maxVitals: { health: 155, action: 155, spirit: 160 },
      bleed: {
        active: false,
        stackCount: 0,
        severity: 0,
        remainingMs: 0,
        ratesPerSecond: { health: 0, action: 0, spirit: 0 },
      },
      statuses: [],
    };
    state.player = { x: 4.57, y: 5 };

    predictServerAuthorityMovement(state, sliceSnapshot, { x: 1, y: 0 }, 100, false);

    expect(state.player.x - state.serverAuthority.actors.player.x).toBeLessThanOrEqual(0.821);
  });

  it("keeps held-but-unordered movement keys active when deriving input", () => {
    const state = play();
    state.keys.add("KeyW");
    state.keys.add("KeyA");
    state.movementKeyOrder = ["KeyA"];

    const keys = Array.from(movementInputKeys(state));
    const vector = movementVectorFromKeys(keys, state.movementInputMode);

    expect(keys).toContain("KeyW");
    expect(keys).toContain("KeyA");
    expect(vector.x).toBeLessThan(0);
    expect(vector.y).toBeLessThan(0);
  });

  it("lets a freshly ordered key win same-axis conflicts against a stale held key", () => {
    const state = play();
    // Refocus trap shape: W physically held but lost from the order array;
    // the player then presses S. S must win the y-axis (last-key-wins).
    state.keys.add("KeyW");
    state.keys.add("KeyS");
    state.movementKeyOrder = ["KeyS"];

    const vector = movementVectorFromKeys(Array.from(movementInputKeys(state)), state.movementInputMode);

    expect(vector.y).toBeGreaterThan(0);
  });

  it("does not snap the local player forward when authority is ahead during movement", () => {
    const sliceSnapshot = slice();
    const state = play(sliceSnapshot);
    state.serverAuthority.enabled = true;
    state.serverAuthority.connected = true;
    state.serverAuthority.sourceMatchesClient = true;
    state.serverAuthority.playerActorId = "player";
    state.serverAuthority.actors.player = {
      id: "player",
      label: "Field Observer",
  areaId: "open-desert-overworld",
      x: 4,
      y: 5,
      direction: "right",
      lifeState: "alive",
      lifecycleSeq: 1,
      vitals: { health: 155, action: 155, spirit: 160 },
      maxVitals: { health: 155, action: 155, spirit: 160 },
      bleed: {
        active: false,
        stackCount: 0,
        severity: 0,
        remainingMs: 0,
        ratesPerSecond: { health: 0, action: 0, spirit: 0 },
      },
      statuses: [],
    };
    state.player = { x: 3.3, y: 5 };
    state.keys.add("KeyD");
    state.movementKeyOrder = ["KeyD"];

    predictServerAuthorityMovement(state, sliceSnapshot, { x: 1, y: 0 }, 16, false);

    expect(state.player.x).toBeLessThan(3.42);
  });

  it("replaces a queued move intent on direction change without a cadence bypass path", () => {
    const sliceSnapshot = slice([], { tickRateHz: 30, tick: 100 });
    const state = play(sliceSnapshot);
    const audio = sfx();
    state.serverAuthority.connected = true;
    state.serverAuthority.sourceMatchesClient = true;
    state.serverAuthority.snapshotTick = 100;
    state.serverAuthority.lastSnapshotReceivedAtMs = 1_000;
    state.keys.add("KeyD");
    state.movementKeyOrder = ["KeyD"];

    updatePlayState(state, sliceSnapshot, 16, 1_000, audio);

    expect(state.authorityCommands.totalQueued).toBe(1);
    const firstIssuedAt = state.authorityCommands.pending[0]!.issued_at_tick;
    expect(state.authorityCommands.pending[0]?.command).toEqual({
      SetMoveIntent: { dx: 1, dy: 0, facing: "Right" },
    });

    state.keys.delete("KeyD");
    state.keys.add("KeyA");
    state.movementKeyOrder = ["KeyA"];
    updatePlayState(state, sliceSnapshot, 16, 1_016, audio);

    expect(state.facing).toBe("left");
    expect(state.authorityCommands.totalQueued).toBe(2);
    expect(state.authorityCommands.pending).toHaveLength(1);
    expect(state.authorityCommands.pending[0]).toMatchObject({
      command: { SetMoveIntent: { dx: -1, dy: 0, facing: "Left" } },
    });
    expect(state.authorityCommands.pending[0]!.issued_at_tick).toBeGreaterThanOrEqual(firstIssuedAt);
    expect(state.serverAuthority.lastMoveIssuedAtTick).toBeNull();
  });

  it("does not enqueue a repeated held move intent while the same intent is pending", () => {
    const sliceSnapshot = slice([], { tickRateHz: 30, tick: 100 });
    const state = play(sliceSnapshot);
    const audio = sfx();
    state.serverAuthority.connected = true;
    state.serverAuthority.sourceMatchesClient = true;
    state.serverAuthority.snapshotTick = 100;
    state.serverAuthority.lastSnapshotReceivedAtMs = 1_000;
    state.keys.add("KeyD");
    state.movementKeyOrder = ["KeyD"];

    updatePlayState(state, sliceSnapshot, 16, 1_100, audio);

    expect(state.authorityCommands.pending).toHaveLength(1);
    expect(state.authorityCommands.totalQueued).toBe(1);
    const pendingCommandId = state.authorityCommands.pending[0]!.command_id;

    updatePlayState(state, sliceSnapshot, 16, 1_200, audio);

    expect(state.authorityCommands.pending).toHaveLength(1);
    expect(state.authorityCommands.pending[0]?.command_id).toBe(pendingCommandId);
    expect(state.authorityCommands.pending[0]?.command).toEqual({
      SetMoveIntent: { dx: 1, dy: 0, facing: "Right" },
    });
  });

  it("expires stale in-flight moves and resumes a held-key movement send", () => {
    const sliceSnapshot = slice([], { tickRateHz: 30, tick: 100 });
    const state = play(sliceSnapshot);
    const audio = sfx();
    state.serverAuthority.connected = true;
    state.serverAuthority.sourceMatchesClient = true;
    state.serverAuthority.snapshotTick = 100;
    state.serverAuthority.lastSnapshotReceivedAtMs = 2_050;
    state.serverAuthority.lastMoveIssuedAtTick = 104;
    state.serverAuthority.lastMoveCommandAtMs = 0;
    state.serverAuthority.wasMovingLastFrame = true;
    state.serverAuthority.lastMoveVector = { x: 1, y: 0 };
    state.serverAuthority.nextMoveCommandAtMs = 2_050;
    state.serverAuthority.playerActorId = "player";
    state.serverAuthority.actors.player = remoteAuthorityActor({
      id: "player",
      label: "Field Observer",
      x: 4,
      y: 5,
      direction: "right",
    });
    state.serverAuthority.inFlightMoves.push(
      {
        commandId: 40,
        dx: 1,
        dy: 0,
        durationTicks: 2,
        sprint: false,
        sentAtMs: 0,
      },
      {
        commandId: 41,
        dx: 1,
        dy: 0,
        durationTicks: 2,
        sprint: false,
        sentAtMs: 10,
      },
    );
    state.keys.add("KeyD");
    state.movementKeyOrder = ["KeyD"];

    updatePlayState(state, sliceSnapshot, 16, 2_050, audio);

    expect(state.serverAuthority.inFlightMoves).toHaveLength(0);
    expect(state.serverAuthority.receiptLog.slice(-2)).toMatchObject([
      { commandId: 40, accepted: false, reasonCode: "expired" },
      { commandId: 41, accepted: false, reasonCode: "expired" },
    ]);
    expect(state.serverAuthority.recentMoveRejections?.slice(0, 2)).toEqual([
      { commandId: 40, reasonCode: "expired", serverTick: 100, dx: 1, dy: 0 },
      { commandId: 41, reasonCode: "expired", serverTick: 100, dx: 1, dy: 0 },
    ]);
    expect(state.authorityCommands.pending).toHaveLength(1);
    expect(state.authorityCommands.pending[0]?.command).toHaveProperty("SetMoveIntent");

    const room = { connection: { isOpen: true }, send: vi.fn() };
    expect(flushGameAuthorityCommands(state, room as never)).toBe(1);
    expect(state.serverAuthority.inFlightMoves).toHaveLength(0);
    expect(state.serverAuthority.sentCommandLog.at(-1)).toMatchObject({
      commandId: 1,
      kind: "SetMoveIntent",
      dx: 1,
      dy: 0,
    });
  });

  it("recovers the move gate from late receipts after in-flight expiry", () => {
    const sliceSnapshot = slice([], { tickRateHz: 30, tick: 100 });
    const state = play(sliceSnapshot);
    const audio = sfx();
    state.serverAuthority.connected = true;
    state.serverAuthority.sourceMatchesClient = true;
    state.serverAuthority.snapshotTick = 100;
    state.serverAuthority.lastSnapshotReceivedAtMs = 1_000;
    state.serverAuthority.lastMoveIssuedAtTick = 2_000;
    state.serverAuthority.lastMoveCommandAtMs = 1_150;
    state.serverAuthority.nextMoveCommandAtMs = 1_200;
    state.serverAuthority.playerActorId = "player";
    state.serverAuthority.actors.player = remoteAuthorityActor({
      id: "player",
      label: "Field Observer",
      x: 4,
      y: 5,
      direction: "back",
    });
    state.player = { x: 4, y: 5 };
    state.serverAuthority.sentCommandLog.push({
      commandId: 77,
      kind: "Move",
      sentAtMs: 0,
      issuedAtTick: 2_000,
    });

    applyServerPacket(state, sliceSnapshot, {
      type: "game.receipts",
      receipts: [{ commandId: 77, accepted: false, tick: 103, reasonCode: "move_cooldown" }],
      events: [],
    }, audio);

    expect(state.serverAuthority.inFlightMoves).toHaveLength(0);
    expect(state.serverAuthority.lastMoveIssuedAtTick).toBe(103);

    state.keys.add("KeyW");
    state.movementKeyOrder = ["KeyW"];
    updatePlayState(state, sliceSnapshot, 16, 1_200, audio);

    expect(state.authorityCommands.pending).toHaveLength(1);
    expect(state.authorityCommands.pending[0]?.command).toEqual({
      SetMoveIntent: { dx: 0, dy: -1, facing: "Back" },
    });
  });

  it("blocks local input when server source metadata mismatches the client slice", () => {
    const sliceSnapshot = slice();
    const state = play(sliceSnapshot);
    const audio = sfx();
    state.serverAuthority.connected = true;
    state.serverAuthority.sourceMatchesClient = false;
    state.keys.add("KeyD");
    state.keys.add("Space");

    updatePlayState(state, sliceSnapshot, 100, 1_000, audio);

    expect(state.player).toEqual({ x: 4, y: 5 });
    expect(state.authorityCommands.totalQueued).toBe(0);
    expect(state.status).toBe("server authority source mismatch");
  });


  it("queues one movement intent per crossed cell for proof-time jumps", () => {
    const state = play();

    enqueueAuthorityMovementForCellCrossing(
      state,
      { tick: 1, tickRateHz: 20 },
      { x: 4.1, y: 5 },
      { x: 7.2, y: 5 },
      "x",
    );

    expect(state.authorityCommands.pending.map((entry) => entry.command)).toEqual([
      { Move: { dx: 1, dy: 0, duration_ticks: 15 } },
      { Move: { dx: 1, dy: 0, duration_ticks: 15 } },
      { Move: { dx: 1, dy: 0, duration_ticks: 15 } },
    ]);
    expect(authorityMoveDurationTicks(20)).toBe(15);
  });

  it("predicts smooth movement while server authority owns receipts", () => {
    const sliceSnapshot = slice();
    const state = play(sliceSnapshot);
    const audio = sfx();
    state.serverAuthority.enabled = true;
    state.serverAuthority.connected = true;
    state.serverAuthority.sourceMatchesClient = true;
    state.serverAuthority.playerActorId = "player";
    state.serverAuthority.actors.player = {
      id: "player",
      label: "Field Observer",
  areaId: "open-desert-overworld",
      x: 4,
      y: 5,
      direction: "right",
      lifeState: "alive",
      lifecycleSeq: 1,
      vitals: { health: 155, action: 155, spirit: 160 },
      maxVitals: { health: 155, action: 155, spirit: 160 },
      bleed: {
        active: false,
        stackCount: 0,
        severity: 0,
        remainingMs: 0,
        ratesPerSecond: { health: 0, action: 0, spirit: 0 },
      },
      statuses: [],
    };
    state.keys.add("KeyD");

    updatePlayState(state, sliceSnapshot, 16, 1_000, audio);

    expect(state.player.x).toBeGreaterThan(4);
    expect(state.player.x).toBeLessThan(4.11);
    expect(state.authorityCommands.totalQueued).toBe(1);
    expect(state.authorityCommands.pending[0]?.command).toEqual({
      SetMoveIntent: { dx: 1, dy: 0, facing: "Right" },
    });
  });

  it("caps local prediction distance during a dropped render frame", () => {
    const sliceSnapshot = slice();
    const state = play(sliceSnapshot);
    state.player = { x: 4, y: 5 };

    const prediction = predictServerAuthorityMovement(state, sliceSnapshot, { x: 0, y: 1 }, 80, true);

    expect(prediction).toEqual({ moved: true, blocked: false });
    expect(state.player.x).toBeCloseTo(4);
    expect(state.player.y).toBeCloseTo(5.1566, 3);
  });

  it("normalizes diagonal local prediction so eight-way movement is not faster", () => {
    const sliceSnapshot = slice();
    const diagonalState = play(sliceSnapshot);
    const cardinalState = play(sliceSnapshot);
    diagonalState.player = { x: 4, y: 5 };
    cardinalState.player = { x: 4, y: 5 };

    const diagonal = predictServerAuthorityMovement(diagonalState, sliceSnapshot, { x: Math.SQRT1_2, y: Math.SQRT1_2 }, 80);
    const cardinal = predictServerAuthorityMovement(cardinalState, sliceSnapshot, { x: 1, y: 0 }, 80);

    expect(diagonal).toEqual({ moved: true, blocked: false });
    expect(cardinal).toEqual({ moved: true, blocked: false });
    expect(Math.hypot(diagonalState.player.x - 4, diagonalState.player.y - 5))
      .toBeCloseTo(cardinalState.player.x - 4, 3);
  });

  it("slides diagonal local prediction along circle-vs-AABB movement blockers", () => {
    const wall: PropSnapshot = {
      id: "wall",
      entity: "prop/wall",
  areaId: "open-desert-overworld",
      label: "Wall",
      kind: "prop",
      cell: { x: 5, y: 0 },
      size: { w: 1, h: 18 },
      solid: false,
      interactive: false,
      collisionBounds: [{ xMilli: 0, yMilli: 0, wMilli: 295, hMilli: 18_000 }],
    };
    const sliceSnapshot = slice([wall]);
    const state = play(sliceSnapshot);
    state.player = { x: 4.19, y: 5 };

    const prediction = predictServerAuthorityMovement(state, sliceSnapshot, { x: Math.SQRT1_2, y: Math.SQRT1_2 }, 80);

    expect(prediction).toEqual({ moved: true, blocked: true });
    expect(state.player.x).toBeGreaterThanOrEqual(4.198);
    expect(state.player.x).toBeLessThan(4.201);
    expect(state.player.y).toBeGreaterThan(5);
  });

  it("clamps local prediction at a wall while forwarding keyboard intent to Rust", () => {
    const wall: PropSnapshot = {
      id: "wall",
      entity: "prop/wall",
  areaId: "open-desert-overworld",
      label: "Wall",
      kind: "prop",
      cell: { x: 5, y: 0 },
      size: { w: 1, h: 18 },
      solid: false,
      interactive: false,
      collisionBounds: [{ xMilli: 0, yMilli: 0, wMilli: 295, hMilli: 18_000 }],
    };
    const sliceSnapshot = slice([wall], { tickRateHz: 30 });
    const liveState = play(sliceSnapshot);
    liveState.serverAuthority.connected = true;
    liveState.serverAuthority.sourceMatchesClient = true;
    liveState.player = { x: 4.198, y: 5 };
    liveState.keys.add("KeyD");
    liveState.movementKeyOrder = ["KeyD"];

    updatePlayState(liveState, sliceSnapshot, 16, 1_000, sfx());

    expect(liveState.player.x).toBeCloseTo(4.198, 3);
    expect(liveState.authorityCommands.totalQueued).toBe(1);
    expect(liveState.authorityCommands.pending[0]?.command).toEqual({
      SetMoveIntent: { dx: 1, dy: 0, facing: "Right" },
    });
    expect(liveState.status).toBe("server authority moving");
  });

  it("sends the plain diagonal intent octant for an angled wall press", () => {
    const wall: PropSnapshot = {
      id: "wall",
      entity: "prop/wall",
  areaId: "open-desert-overworld",
      label: "Wall",
      kind: "prop",
      cell: { x: 5, y: 0 },
      size: { w: 1, h: 18 },
      solid: false,
      interactive: false,
      collisionBounds: [{ xMilli: 0, yMilli: 0, wMilli: 295, hMilli: 18_000 }],
    };
    const sliceSnapshot = slice([wall], { tickRateHz: 30 });
    const liveState = play(sliceSnapshot);
    liveState.serverAuthority.connected = true;
    liveState.serverAuthority.sourceMatchesClient = true;
    liveState.player = { x: 4.19, y: 5 };
    liveState.keys.add("KeyD");
    liveState.keys.add("KeyS");
    liveState.movementKeyOrder = ["KeyD", "KeyS"];

    updatePlayState(liveState, sliceSnapshot, 16, 1_000, sfx());

    expect(liveState.player.x).toBeGreaterThanOrEqual(4.198);
    expect(liveState.player.x).toBeLessThan(4.201);
    expect(liveState.player.y).toBeGreaterThan(5);
    expect(liveState.authorityCommands.totalQueued).toBe(1);
    expect(liveState.authorityCommands.pending[0]?.command).toEqual({
      SetMoveIntent: { dx: 1, dy: 1, facing: "Front" },
    });
  });



  it("keeps held move intents edge-triggered and refreshes them only on keepalive", () => {
    const sliceSnapshot = slice([], { tickRateHz: 30, tick: 100 });
    const state = play(sliceSnapshot);
    const audio = sfx();
    state.serverAuthority.connected = true;
    // Deltas may omit source metadata and recompute the match flag from the
    // last accepted hash/count. Seed both so omission cannot fail-closed the
    // held-intent keepalive path mid-test.
    state.serverAuthority.sourceStateHash = sliceSnapshot.stateHash;
    state.serverAuthority.sourceActorCount = 2;
    state.serverAuthority.sourceMatchesClient = true;
    state.serverAuthority.playerActorId = "player";
    state.serverAuthority.snapshotTick = 100;
    state.serverAuthority.lastSnapshotReceivedAtMs = 1_000;
    state.serverAuthority.actors.player = remoteAuthorityActor({
      id: "player",
      label: "Field Observer",
      x: 4,
      y: 5,
      direction: "back",
    });
    state.player = { x: 4, y: 5 };
    state.keys.add("KeyW");
    state.movementKeyOrder = ["KeyW"];

    updatePlayState(state, sliceSnapshot, 16, 1_200, audio);
    expect(state.authorityCommands.pending).toHaveLength(1);
    const firstIssuedAt = state.authorityCommands.pending[0]!.issued_at_tick;
    expect(firstIssuedAt).toBeGreaterThan(101);

    const room = { connection: { isOpen: true }, send: vi.fn() };
    expect(flushGameAuthorityCommands(state, room as never)).toBe(1);
    expect(state.authorityCommands.pending).toHaveLength(0);
    expect(state.serverAuthority.inFlightMoves).toHaveLength(0);
    expect(state.serverAuthority.sentCommandLog.at(-1)).toMatchObject({ kind: "SetMoveIntent", dx: 0, dy: -1 });

    applyServerPacket(state, sliceSnapshot, {
      type: "game.acks",
      acks: [[1, 1, 101]],
      playerPosition: [4, 4.96],
    }, audio);
    expect(state.serverAuthority.snapshotTick).toBe(101);
    expect(state.serverAuthority.lastMoveIssuedAtTick).toBeNull();

    applyServerPacket(state, sliceSnapshot, {
      type: "game.delta",
      receipts: [],
      delta: {
        schema: "successor.authoritative-shard-delta.v1",
        shardId: "test",
        tick: 102,
        playerActorId: "player",
        actors: {},
      },
      events: [],
    } as never, audio);
    expect(state.serverAuthority.snapshotTick).toBe(102);

    updatePlayState(state, sliceSnapshot, 16, 1_267, audio);
    expect(state.authorityCommands.pending).toHaveLength(0);

    updatePlayState(state, sliceSnapshot, 16, 1_701, audio);
    expect(state.authorityCommands.pending).toHaveLength(1);
    expect(state.authorityCommands.pending[0]!.command).toHaveProperty("SetMoveIntent");
    expect(Number.isFinite(state.authorityCommands.pending[0]!.issued_at_tick)).toBe(true);
  });
  it("self-heals local prediction from inside a fine prop bound without trap-state escape rules", () => {
    const wall: PropSnapshot = {
      id: "wall",
      entity: "prop/wall",
  areaId: "open-desert-overworld",
      label: "Wall",
      kind: "prop",
      cell: { x: 5, y: 0 },
      size: { w: 1, h: 18 },
      solid: false,
      interactive: false,
      collisionBounds: [{ xMilli: 0, yMilli: 0, wMilli: 295, hMilli: 18_000 }],
    };
    const sliceSnapshot = slice([wall]);
    const state = play(sliceSnapshot);
    state.player = { x: 4.65, y: 5 };

    const prediction = predictServerAuthorityMovement(state, sliceSnapshot, { x: 0, y: 1 }, 16);

    expect(prediction).toEqual({ moved: true, blocked: true });
    expect(state.player.x).toBeCloseTo(5.095, 3);
    expect(state.player.y).toBeGreaterThan(5);
  });

  it("faces the latest movement direction in server authority mode", () => {
    const sliceSnapshot = slice();
    const state = play(sliceSnapshot);
    const audio = sfx();
    state.serverAuthority.enabled = true;
    state.serverAuthority.connected = true;
    state.serverAuthority.sourceMatchesClient = true;
    state.serverAuthority.playerActorId = "player";
    state.serverAuthority.actors.player = {
      id: "player",
      label: "Field Observer",
  areaId: "open-desert-overworld",
      x: 4,
      y: 5,
      direction: "right",
      lifeState: "alive",
      lifecycleSeq: 1,
      vitals: { health: 155, action: 155, spirit: 160 },
      maxVitals: { health: 155, action: 155, spirit: 160 },
      bleed: {
        active: false,
        stackCount: 0,
        severity: 0,
        remainingMs: 0,
        ratesPerSecond: { health: 0, action: 0, spirit: 0 },
      },
      statuses: [],
    };
    state.keys.add("KeyD");
    state.keys.add("KeyS");
    state.movementKeyOrder = ["KeyD", "KeyS"];

    updatePlayState(state, sliceSnapshot, 16, 1_000, audio);

    expect(state.player.x).toBeGreaterThan(4);
    expect(state.player.y).toBeGreaterThan(5);
    expect(state.player.x - 4).toBeCloseTo(state.player.y - 5, 3);
    expect(state.facing).toBe("front_right");
    expect(state.authorityCommands.pending[0]?.command).toEqual({
      SetMoveIntent: { dx: 1, dy: 1, facing: "Front" },
    });
  });

  it("locks facing while control is held so movement can strafe", () => {
    const sliceSnapshot = slice();
    const state = play(sliceSnapshot);
    const audio = sfx();
    state.serverAuthority.enabled = true;
    state.serverAuthority.connected = true;
    state.serverAuthority.sourceMatchesClient = true;
    state.serverAuthority.playerActorId = "player";
    state.serverAuthority.actors.player = {
      id: "player",
      label: "Field Observer",
      areaId: "open-desert-overworld",
      x: 4,
      y: 5,
      direction: "right",
      lifeState: "alive",
      lifecycleSeq: 1,
      vitals: { health: 155, action: 155, spirit: 160 },
      maxVitals: { health: 155, action: 155, spirit: 160 },
      bleed: {
        active: false,
        stackCount: 0,
        severity: 0,
        remainingMs: 0,
        ratesPerSecond: { health: 0, action: 0, spirit: 0 },
      },
      statuses: [],
    };
    state.facing = "right";
    state.keys.add("MouseRight");
    state.rotationLockFacing = "right";
    state.keys.add("KeyD");
    state.keys.add("KeyS");
    state.movementKeyOrder = ["KeyD", "KeyS"];

    updatePlayState(state, sliceSnapshot, 16, 1_000, audio);

    expect(state.player.x).toBeGreaterThan(4);
    expect(state.player.y).toBeGreaterThan(5);
    expect(state.player.x - 4).toBeCloseTo(state.player.y - 5, 3);
    expect(state.facing).toBe("right");
    expect(state.authorityCommands.pending[0]?.command).toEqual({
      SetMoveIntent: { dx: 1, dy: 1, facing: "Right" },
    });
  });

  it("damps local-player reconciliation monotonically without overshoot", () => {
    const sliceSnapshot = slice([], { tickRateHz: 30 });
    const state = play(sliceSnapshot);
    state.serverAuthority.playerActorId = "player";
    state.serverAuthority.actors.player = remoteAuthorityActor({
      id: "player",
      label: "Field Observer",
      x: 4.8,
      y: 5,
      direction: "right",
      receivedAtMs: 1_000,
    });
    state.player = { x: 4, y: 5 };

    for (let frame = 0; frame < 20; frame += 1) {
      const before = state.player.x;
      reconcileServerAuthorityPlayer(state, sliceSnapshot, 16);
      expect(state.player.x).toBeGreaterThan(before);
      expect(state.player.x).toBeLessThanOrEqual(4.8);
    }
  });

  it("dead-reckons the moving target between acks and damps the next ack correction", () => {
    const sliceSnapshot = slice([], { tickRateHz: 30 });
    const state = play(sliceSnapshot);
    state.worldTimeMs = 1_090;
    state.serverAuthority.playerActorId = "player";
    state.serverAuthority.actors.player = remoteAuthorityActor({
      id: "player",
      label: "Field Observer",
      x: 4,
      y: 5,
      direction: "right",
      receivedAtMs: 1_000,
    });
    state.player = { x: 4, y: 5 };
    state.moving = true;
    state.keys.add("KeyD");
    state.movementKeyOrder = ["KeyD"];

    const target = deadReckonedAuthorityPlayerTarget(state, sliceSnapshot, state.serverAuthority.actors.player!);
    expect(target.x).toBeCloseTo(4 + 1.357 * 0.09, 3);
    expect(target.y).toBeCloseTo(5);

    state.worldTimeMs = 1_100;
    state.serverAuthority.actors.player = remoteAuthorityActor({
      id: "player",
      label: "Field Observer",
      x: 4.2,
      y: 5,
      direction: "right",
      receivedAtMs: 1_100,
    });
    const beforeAckCorrection = state.player.x;
    reconcileServerAuthorityPlayer(state, sliceSnapshot, 16);

    expect(state.player.x).toBeGreaterThan(beforeAckCorrection);
    expect(state.player.x).toBeLessThan(4.2);
  });

  it("allows a bounded prediction lead while moving under server authority", () => {
    const correction = movingAuthorityCorrection(
      {
        keys: new Set(["KeyD", "KeyS"]),
        movementKeyOrder: ["KeyD", "KeyS"],
      },
      { x: -0.08, y: -0.08 },
    );

    expect(correction).toEqual({ x: 0, y: 0 });
  });

  it("renders remote actors 120ms behind authority samples by server tick with true cells-per-second velocity", () => {
    const state = play(slice([], { tickRateHz: 30 }));
    state.worldTimeMs = 400;
    state.worldClock.authoritativeTick = 12;
    state.worldClock.receivedAtMs = 400;
    state.serverAuthority.playerActorId = "player";
    state.serverAuthority.actors.vendor = remoteAuthorityActor({
      x: 12.4,
      renderX: 11.584,
      renderY: 5,
      interpolationSamples: [
        { x: 10, y: 5, receivedAtMs: 0, tick: 0 },
        { x: 11.2, y: 5, receivedAtMs: 200, tick: 6 },
        { x: 12.4, y: 5, receivedAtMs: 400, tick: 12 },
      ],
    });

    updateServerAuthorityActorVisuals(state, 16);

    const actor = state.serverAuthority.actors.vendor!;
    expect(actor.renderX).toBeCloseTo(11.68, 3);
    expect(actor.renderY).toBeCloseTo(5);
    expect(actor.renderVelocityX).toBeCloseTo(6, 2);
    expect(actor.renderVelocityY).toBeCloseTo(0);
  });

  it("falls back to receive-time interpolation for tickless remote samples", () => {
    const state = play();
    state.worldTimeMs = 260;
    state.serverAuthority.playerActorId = "player";
    state.serverAuthority.actors.vendor = remoteAuthorityActor({
      x: 10.6,
      renderX: 10.144,
      renderY: 5,
      interpolationSamples: [
        { x: 10, y: 5, receivedAtMs: 100 },
        { x: 10.6, y: 5, receivedAtMs: 200 },
      ],
    });

    updateServerAuthorityActorVisuals(state, 16);

    const actor = state.serverAuthority.actors.vendor!;
    expect(actor.renderX).toBeCloseTo(10.24, 3);
    expect(actor.renderY).toBeCloseTo(5);
    expect(actor.renderVelocityX).toBeCloseTo(6, 2);
  });

  it("briefly extrapolates a remote actor across a short authority packet gap", () => {
    const state = play(slice([], { tickRateHz: 30 }));
    state.worldTimeMs = 500;
    state.worldClock.authoritativeTick = 15;
    state.worldClock.receivedAtMs = 500;
    state.serverAuthority.playerActorId = "player";
    state.serverAuthority.actors.vendor = remoteAuthorityActor({
      x: 11.2,
      renderX: 11.8,
      renderY: 5,
      interpolationSamples: [
        { x: 10, y: 5, receivedAtMs: 0, tick: 0 },
        { x: 11.2, y: 5, receivedAtMs: 200, tick: 6 },
      ],
    });

    updateServerAuthorityActorVisuals(state, 33.333);

    const actor = state.serverAuthority.actors.vendor!;
    expect(actor.renderX).toBeCloseTo(11.92, 3);
    expect(actor.renderY).toBeCloseTo(5);
    expect(actor.renderVelocityX).toBeCloseTo(3.6, 1);
  });

  it("respects stationary duplicate snapshots so stops do not glide past authority", () => {
    const state = play(slice([], { tickRateHz: 30 }));
    state.worldTimeMs = 500;
    state.worldClock.authoritativeTick = 15;
    state.worldClock.receivedAtMs = 500;
    state.serverAuthority.playerActorId = "player";
    state.serverAuthority.actors.vendor = remoteAuthorityActor({
      x: 12,
      renderX: 12,
      renderY: 5,
      interpolationSamples: [
        { x: 10, y: 5, receivedAtMs: 0, tick: 0 },
        { x: 12, y: 5, receivedAtMs: 200, tick: 6 },
        { x: 12, y: 5, receivedAtMs: 400, tick: 12 },
      ],
    });

    updateServerAuthorityActorVisuals(state, 16);

    const actor = state.serverAuthority.actors.vendor!;
    expect(actor.renderX).toBeCloseTo(12, 3);
    expect(actor.renderY).toBeCloseTo(5);
    expect(actor.renderVelocityX).toBe(0);
    expect(actor.renderVelocityY).toBe(0);
  });

  it("snaps remote render across large discontinuities without emitting a bogus animation velocity", () => {
    const state = play(slice([], { tickRateHz: 30 }));
    state.worldTimeMs = 400;
    state.worldClock.authoritativeTick = 12;
    state.worldClock.receivedAtMs = 400;
    state.serverAuthority.playerActorId = "player";
    state.serverAuthority.actors.vendor = remoteAuthorityActor({
      x: 34,
      renderX: 10,
      renderY: 5,
      interpolationSamples: [
        { x: 10, y: 5, receivedAtMs: 0, tick: 0 },
        { x: 34, y: 5, receivedAtMs: 400, tick: 12 },
      ],
    });

    updateServerAuthorityActorVisuals(state, 16);

    const actor = state.serverAuthority.actors.vendor!;
    expect(actor.renderX).toBeCloseTo(26.8, 3);
    expect(actor.renderY).toBeCloseTo(5);
    expect(actor.renderVelocityX).toBe(0);
    expect(actor.renderVelocityY).toBe(0);
  });

  it("holds remote actors without a snapshot buffer instead of running old catch-up clamps", () => {
    const state = play();
    state.serverAuthority.playerActorId = "player";
    state.serverAuthority.actors.vendor = remoteAuthorityActor({
      x: 12,
      renderX: 10,
      renderY: 5,
      interpolationSamples: [
        { x: 12, y: 5, receivedAtMs: 100 },
      ],
    });

    updateServerAuthorityActorVisuals(state, 16);

    const actor = state.serverAuthority.actors.vendor!;
    expect(actor.renderX).toBe(10);
    expect(actor.renderY).toBe(5);
    expect(actor.renderVelocityX).toBe(0);
    expect(actor.renderVelocityY).toBe(0);
  });

  it("corrects perpendicular strafe drift and excessive forward prediction lead", () => {
    const correction = movingAuthorityCorrection(
      {
        keys: new Set(["KeyD", "KeyS"]),
        movementKeyOrder: ["KeyD", "KeyS"],
      },
      { x: -0.22, y: -0.8 },
    );

    expect(correction.x).toBeCloseTo(0.19);
    expect(correction.y).toBeCloseTo(-0.39);
  });

  it("allows more forward prediction lead while sprinting", () => {
    const state = play();
    state.keys.add("ShiftLeft");
    state.keys.add("KeyS");
    state.movementKeyOrder = ["KeyS"];
    state.actors[state.playerActorId]!.vitals.action = 100;
    const correction = movingAuthorityCorrection(
      state,
      { x: 0, y: -0.4 },
    );

    expect(correction).toEqual({ x: 0, y: 0 });
  });

  it("uses walking prediction lead when Shift is held without enough Action", () => {
    const state = play();
    state.keys.add("ShiftLeft");
    state.keys.add("KeyS");
    state.movementKeyOrder = ["KeyS"];
    state.actors[state.playerActorId]!.vitals.action = 0.8;

    const correction = movingAuthorityCorrection(state, { x: 0, y: -0.4 });

    expect(correction.x).toBeCloseTo(0);
    expect(correction.y).toBeCloseTo(0);
  });

  it("projects current input while no move command is in flight without pulling ahead of local", () => {
    const sliceSnapshot = slice([], { tickRateHz: 30 });
    const state = play(sliceSnapshot);
    state.moving = true;
    state.player = { x: 4, y: 5.3 };
    state.keys.add("KeyS");
    state.movementKeyOrder = ["KeyS"];

    const target = predictedAuthorityPlayerTarget(state, sliceSnapshot, { x: 4, y: 5 });

    expect(target.x).toBeCloseTo(4);
    expect(target.y).toBeCloseTo(5.0905);

    state.player = { x: 4, y: 5.05 };
    const cappedTarget = predictedAuthorityPlayerTarget(state, sliceSnapshot, { x: 4, y: 5 });
    expect(cappedTarget.y).toBeCloseTo(5.05);
  });

  it("does not clamp speculative local prediction behind authority", () => {
    const sliceSnapshot = slice([], { tickRateHz: 30 });
    const state = play(sliceSnapshot);
    state.moving = true;
    state.player = { x: 4, y: 4.7 };
    state.keys.add("KeyS");
    state.movementKeyOrder = ["KeyS"];

    const target = predictedAuthorityPlayerTarget(state, sliceSnapshot, { x: 4, y: 5 });

    expect(target.x).toBeCloseTo(4);
    expect(target.y).toBeCloseTo(5);
  });

  it("excludes opposed in-flight flip leftovers from prediction targets while keeping perpendicular and idle replay", () => {
    const sliceSnapshot = slice([], { tickRateHz: 30 });
    const state = play(sliceSnapshot);
    state.moving = true;
    state.keys.add("KeyD");
    state.movementKeyOrder = ["KeyD"];
    state.serverAuthority.inFlightMoves.push(
      {
        commandId: 10,
        dx: -1,
        dy: 0,
        durationTicks: 2,
        sprint: false,
        sentAtMs: 1_000,
      },
      {
        commandId: 11,
        dx: 0,
        dy: 1,
        durationTicks: 2,
        sprint: false,
        sentAtMs: 1_000,
      },
    );
    state.authorityCommands.pending.push({
      session: state.authorityCommands.session,
      player: state.authorityCommands.player,
      command_id: 12,
      issued_at_tick: 100,
      command: { Move: { dx: -1, dy: 0, duration_ticks: 2 } },
    });

    const flipTarget = predictedAuthorityPlayerTarget(state, sliceSnapshot, { x: 4, y: 5 });

    expect(flipTarget.x).toBeCloseTo(4);
    expect(flipTarget.y).toBeCloseTo(5.0905);

    state.moving = false;
    state.keys.clear();
    state.movementKeyOrder = [];
    const idleTarget = predictedAuthorityPlayerTarget(state, sliceSnapshot, { x: 4, y: 5 });
    expect(idleTarget.x).toBeLessThan(4);
    expect(idleTarget.y).toBeGreaterThan(5);
  });

  it("queues a stop intent, not a synthetic Move, after input stops", () => {
    const sliceSnapshot = slice([], { tickRateHz: 30 });
    const state = play(sliceSnapshot);
    const audio = sfx();
    state.serverAuthority.connected = true;
    state.serverAuthority.sourceMatchesClient = true;
    state.serverAuthority.wasMovingLastFrame = true;
    state.serverAuthority.lastMoveIntent = { dx: 1, dy: 0, sprint: false, facing: "right" };
    state.serverAuthority.lastMoveVector = { x: 1, y: 0 };
    state.serverAuthority.lastMoveCommandAtMs = 950;
    state.facing = "right";

    updatePlayState(state, sliceSnapshot, 16, 1_000, audio);

    expect(state.authorityCommands.pending).toHaveLength(1);
    expect(state.authorityCommands.pending[0]?.command).toEqual({
      SetMoveIntent: { dx: 0, dy: 0, facing: "Right" },
    });
    expect(state.serverAuthority.wasMovingLastFrame).toBe(false);
  });

  it("queues transition intents only when movement carries the player into the trigger", () => {
    const transitionSlice = slice([], {
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
    });
    const state = play(transitionSlice);
    const audio = sfx();
    state.serverAuthority.connected = true;
    state.serverAuthority.sourceMatchesClient = true;

    state.keys.add("KeyD");
    updatePlayState(state, transitionSlice, 16, 1_000, audio);

    expect(state.activeAreaId).toBe("open-desert-overworld");
    expect(state.player.x).toBeGreaterThan(4);
    expect(state.player.x).toBeLessThan(4.2);
    expect(state.player.y).toBe(5);
    expect(state.authorityCommands.totalByKind.EnterTransition).toBe(1);
    expect(state.authorityCommands.pending.some((envelope) => (
      "EnterTransition" in envelope.command && envelope.command.EnterTransition.transition_id === "bolt-bench-entry"
    ))).toBe(true);
    expect(state.transitionCooldownMs).toBe(180);
    expect(state.transitionFlashMs).toBe(0);
    expect(state.status).toBe("enter bolt bench requested");
    expect(audio.play).not.toHaveBeenCalledWith("area_transition");
  });

  it("does not queue transition intents from idle authority reconciliation", () => {
    const transitionSlice = slice([], {
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
    });
    const state = play(transitionSlice);
    const audio = sfx();
    state.serverAuthority.connected = true;
    state.serverAuthority.sourceMatchesClient = true;

    updatePlayState(state, transitionSlice, 16, 1_000, audio);

    expect(state.authorityCommands.totalByKind.EnterTransition).toBe(0);
    expect(audio.play).not.toHaveBeenCalledWith("area_transition");
  });

  it("prunes expired chat bubbles", () => {
    const state = play();
    state.chatBubbles = [
      { body: "keep", sender: "Field Observer", own: true, ttlMs: 100, totalTtlMs: 100 },
      { body: "drop", sender: "Warden", own: false, ttlMs: 10, totalTtlMs: 10 },
    ];

    updateChatBubbleTtls(state, 50);

    expect(state.chatBubbles.map((bubble) => bubble.body)).toEqual(["keep"]);
    expect(state.chatBubbles[0]!.ttlMs).toBe(50);
  });
});

describe("click-to-move + sprint toggle through the authority input frame", () => {
  const scratchEvents: ClickMoveEvent[] = [];

  function drainedState(sliceSnapshot = slice()) {
    scratchEvents.length = 0;
    const state = play(sliceSnapshot);
    state.serverAuthority.connected = true;
    state.serverAuthority.sourceMatchesClient = true;
    return state;
  }

  function authorityPlayer(overrides: Partial<ServerAuthorityActorState> = {}): ServerAuthorityActorState {
    return { ...remoteAuthorityActor({ id: "player", label: "Field Observer", x: 4, y: 5 }), ...overrides };
  }

  it("drives an eastbound authority move intent from a ground click and faces the travel direction", () => {
    const sliceSnapshot = slice();
    const state = drainedState(sliceSnapshot);
    setClickMoveTarget(state, 8, 5, "open-desert-overworld", 900);

    updatePlayState(state, sliceSnapshot, 100, 1_000, sfx());

    expect(state.moving).toBe(true);
    expect(state.facing).toBe("right");
    expect(state.player.x).toBeGreaterThan(4);
    expect(state.authorityCommands.pending[0]?.command).toEqual({
      SetMoveIntent: { dx: 1, dy: 0, facing: "Right" },
    });
    expect(clickMoveTarget(state)).not.toBeNull();
  });

  it("hands the frame back to the keyboard: a held movement key cancels navigation", () => {
    const sliceSnapshot = slice();
    const state = drainedState(sliceSnapshot);
    setClickMoveTarget(state, 8, 5, "open-desert-overworld", 900);
    state.keys.add("KeyW");

    updatePlayState(state, sliceSnapshot, 100, 1_000, sfx());

    expect(clickMoveTarget(state)).toBeNull();
    drainClickMoveEvents(state, scratchEvents);
    expect(scratchEvents.map((event) => event.kind)).toEqual(["set", "cancelled"]);
    // The manual key owns the frame — the intent is the keyboard's.
    expect(state.authorityCommands.pending[0]?.command).toEqual({
      SetMoveIntent: { dx: 0, dy: -1, facing: "Back" },
    });
  });

  it("cancels navigation while input is locked (death/observer/transition lockouts)", () => {
    const sliceSnapshot = slice();
    const state = drainedState(sliceSnapshot);
    state.observerCamera = { followActorId: "vendor", inputLocked: true };
    state.serverAuthority.actors.vendor = remoteAuthorityActor();
    setClickMoveTarget(state, 8, 5, "open-desert-overworld", 900);

    updatePlayState(state, sliceSnapshot, 100, 1_000, sfx());

    expect(clickMoveTarget(state)).toBeNull();
    expect(state.moving).toBe(false);
    expect(state.authorityCommands.pending).toHaveLength(0);
  });

  it("drops a navigation target left behind by an area transition", () => {
    const sliceSnapshot = slice();
    const state = drainedState(sliceSnapshot);
    setClickMoveTarget(state, 8, 5, "somewhere-else", 900);

    updatePlayState(state, sliceSnapshot, 100, 1_000, sfx());

    expect(clickMoveTarget(state)).toBeNull();
    expect(state.moving).toBe(false);
  });

  it("arrives: a target inside the arrival radius completes and stops cleanly", () => {
    const sliceSnapshot = slice();
    const state = drainedState(sliceSnapshot);
    setClickMoveTarget(state, 4.2, 5, "open-desert-overworld", 900);

    updatePlayState(state, sliceSnapshot, 100, 1_000, sfx());

    expect(clickMoveTarget(state)).toBeNull();
    drainClickMoveEvents(state, scratchEvents);
    expect(scratchEvents.map((event) => event.kind)).toEqual(["set", "arrived"]);
    expect(state.moving).toBe(false);
  });
  it("cancels navigation on bounded route failure instead of waiting out the stall watchdog", () => {
    // Seal the goal in a blocked ring so the presentation router cannot plan.
    const sliceSnapshot = slice();
    const state = drainedState(sliceSnapshot);
    state.player = { x: 4.2, y: 5 };
    for (const key of ["7,4", "8,4", "9,4", "7,5", "9,5", "7,6", "8,6", "9,6"]) {
      state.blocked.add(key);
    }
    setClickMoveTarget(state, 8.5, 5.5, "open-desert-overworld", 900);
    // One 100ms frame, far inside the stall window: planner reports unreachable,
    // navigation cancels immediately, and the frame emits an ordinary stop
    // (no move intent reaches the authority queue).
    updatePlayState(state, sliceSnapshot, 100, 1_000, sfx());
    expect(clickMoveTarget(state)).toBeNull();
    drainClickMoveEvents(state, scratchEvents);
    expect(scratchEvents.map((event) => event.kind)).toEqual(["set", "cancelled"]);
    expect(state.moving).toBe(false);
    expect(state.authorityCommands.pending).toHaveLength(0);
  });

  it("sprints from the persistent toggle without a held shift", () => {
    const sliceSnapshot = slice();
    const state = drainedState(sliceSnapshot);
    setSprintToggleEnabled(state, true);
    state.keys.add("KeyD");

    updatePlayState(state, sliceSnapshot, 100, 1_000, sfx());

    expect(state.authorityCommands.pending[0]?.command).toEqual({
      SetMoveIntent: { dx: 1, dy: 0, facing: "Right", sprint: true },
    });
    expect(state.status).toBe("server authority sprinting");
  });

  it("stops requesting sprint under the authority recovery lock and resumes on unlock", () => {
    const sliceSnapshot = slice();
    const state = drainedState(sliceSnapshot);
    state.serverAuthority.playerActorId = "player";
    state.serverAuthority.actors.player = authorityPlayer({ mobility: { sprintRecoveryLocked: true } });
    setSprintToggleEnabled(state, true);
    state.keys.add("KeyD");

    updatePlayState(state, sliceSnapshot, 100, 1_000, sfx());

    // Winded: the toggle intent survives but the client walks honestly.
    expect(state.authorityCommands.pending[0]?.command).toEqual({
      SetMoveIntent: { dx: 1, dy: 0, facing: "Right" },
    });
    expect(state.status).toBe("server authority moving");

    // Full Action: the sim clears the lock — sprint resumes with no re-toggle.
    state.serverAuthority.actors.player = authorityPlayer({ mobility: { sprintRecoveryLocked: false } });
    updatePlayState(state, sliceSnapshot, 100, 2_000, sfx());

    expect(state.authorityCommands.pending.at(-1)?.command).toEqual({
      SetMoveIntent: { dx: 1, dy: 0, facing: "Right", sprint: true },
    });
    expect(state.status).toBe("server authority sprinting");
  });

  it("routes a click around blocked cells and still emits SetMoveIntent only", () => {
    const sliceSnapshot = slice();
    const state = drainedState(sliceSnapshot);
    state.player = { x: 4.2, y: 5 };
    // Pillar directly east — router must detour, never walk through.
    state.blocked.add("6,5");
    state.blocked.add("6,4");
    state.blocked.add("6,6");
    setClickMoveTarget(state, 9.5, 5.5, "open-desert-overworld", 900);
    updatePlayState(state, sliceSnapshot, 100, 1_000, sfx());
    expect(clickMoveTarget(state)).not.toBeNull();
    expect(clickRouteWaypoints(state).length).toBeGreaterThan(0);
    expect(state.moving).toBe(true);
    const command = state.authorityCommands.pending[0]?.command;
    expect(command && "SetMoveIntent" in command).toBe(true);
    if (command && "SetMoveIntent" in command) {
      const intent = command.SetMoveIntent;
      // Sole player movement command remains SetMoveIntent octants.
      expect(Math.abs(intent.dx) <= 1).toBe(true);
      expect(Math.abs(intent.dy) <= 1).toBe(true);
      expect(Math.abs(intent.dx) + Math.abs(intent.dy)).toBeGreaterThan(0);
    }
  });

  it("sprints from a click route under the same toggle calculation as keyboard", () => {
    const sliceSnapshot = slice();
    const state = drainedState(sliceSnapshot);
    setSprintToggleEnabled(state, true);
    setClickMoveTarget(state, 8, 5, "open-desert-overworld", 900);
    updatePlayState(state, sliceSnapshot, 100, 1_000, sfx());
    expect(state.authorityCommands.pending[0]?.command).toEqual({
      SetMoveIntent: { dx: 1, dy: 0, facing: "Right", sprint: true },
    });
    expect(state.status).toBe("server authority sprinting");
  });

  it("keeps WINDED recovery lock on click routes and does not unlock early", () => {
    const sliceSnapshot = slice();
    const state = drainedState(sliceSnapshot);
    state.serverAuthority.playerActorId = "player";
    state.serverAuthority.actors.player = authorityPlayer({
      mobility: { sprintRecoveryLocked: true },
      vitals: { health: 100, action: 40, spirit: 100 },
      maxVitals: { health: 100, action: 100, spirit: 100 },
    });
    setSprintToggleEnabled(state, true);
    setClickMoveTarget(state, 8, 5, "open-desert-overworld", 900);
    updatePlayState(state, sliceSnapshot, 100, 1_000, sfx());
    // Lock projected: walk honestly even with toggle armed and partial Action.
    expect(state.authorityCommands.pending[0]?.command).toEqual({
      SetMoveIntent: { dx: 1, dy: 0, facing: "Right" },
    });
    expect(state.status).toBe("server authority moving");
    // Still partial Action + lock: must not resume sprint.
    state.serverAuthority.actors.player = authorityPlayer({
      mobility: { sprintRecoveryLocked: true },
      vitals: { health: 100, action: 90, spirit: 100 },
      maxVitals: { health: 100, action: 100, spirit: 100 },
    });
    updatePlayState(state, sliceSnapshot, 100, 2_000, sfx());
    expect(state.authorityCommands.pending.at(-1)?.command).toEqual({
      SetMoveIntent: { dx: 1, dy: 0, facing: "Right" },
    });
    // Unlock only when authority clears the lock (full Action on the sim).
    state.serverAuthority.actors.player = authorityPlayer({
      mobility: { sprintRecoveryLocked: false },
      vitals: { health: 100, action: 100, spirit: 100 },
      maxVitals: { health: 100, action: 100, spirit: 100 },
    });
    updatePlayState(state, sliceSnapshot, 100, 3_000, sfx());
    expect(state.authorityCommands.pending.at(-1)?.command).toEqual({
      SetMoveIntent: { dx: 1, dy: 0, facing: "Right", sprint: true },
    });
  });

  it("uses authority-streamed position for click waypoint arrival", () => {
    const sliceSnapshot = slice();
    const state = drainedState(sliceSnapshot);
    state.serverAuthority.playerActorId = "player";
    state.serverAuthority.actors.player = authorityPlayer({ x: 4, y: 5 });
    setClickMoveTarget(state, 4.2, 5, "open-desert-overworld", 900);
    // Presentation player is still far away, but authority already sits inside
    // the arrival radius — route must complete from authority, not prediction.
    state.player = { x: 10, y: 10 };
    updatePlayState(state, sliceSnapshot, 100, 1_000, sfx());
    expect(clickMoveTarget(state)).toBeNull();
    drainClickMoveEvents(state, scratchEvents);
    expect(scratchEvents.map((event) => event.kind)).toEqual(["set", "arrived"]);
  });

  it("replans when blockers change mid-route and stops on bounded failure", () => {
    const sliceSnapshot = slice();
    const state = drainedState(sliceSnapshot);
    state.player = { x: 4.2, y: 5 };
    setClickMoveTarget(state, 12.5, 5.5, "open-desert-overworld", 900);
    updatePlayState(state, sliceSnapshot, 100, 1_000, sfx());
    expect(clickRouteWaypoints(state).length).toBeGreaterThan(0);
    // Seal the goal: next frame's revision replan fails and cancels visibly
    // with an ordinary stop (no lingering move intent).
    for (const key of ["11,4", "12,4", "13,4", "11,5", "13,5", "11,6", "12,6", "13,6"]) {
      state.blocked.add(key);
    }
    updatePlayState(state, sliceSnapshot, 100, 1_200, sfx());
    expect(clickMoveTarget(state)).toBeNull();
    expect(clickRouteReplanCount(state)).toBe(0); // cleared on cancel
    expect(state.moving).toBe(false);
  });
});
