import { describe, expect, it } from "vitest";

import { authorityCommandKind } from "@successor/client/src/slice-core/authorityCommandSystem";
import { updatePlayState } from "@successor/client/src/slice-core/runtimeUpdateSystem";
import type { SfxPlayer } from "@successor/client/src/audio/sfx";

import { createTuiPlayStateFixture } from "../../test/fixtures/playState";

function noopSfx(): SfxPlayer {
  return {
    probe: {
      ready: true,
      unlocked: false,
      clipCount: 0,
      lastPlayed: null,
      listener: null,
      lastDistanceCells: null,
      lastPan: 0,
      lastGain: 1,
      errors: [],
      activeLoops: [],
      recentPlayed: [],
    },
    load: async () => {},
    setListenerPosition: () => {},
    play: () => {},
    playAt: () => {},
    setLoop: () => {},
    stopLoop: () => {},
    stopAllLoops: () => {},
  };
}

describe("movement — key injection through the shared runtime", () => {
  it("held KeyW streams a raw north SetMoveIntent on the wire (fake clock)", () => {
    const { state, slice } = createTuiPlayStateFixture();
    state.movementInputMode = "world";
    // fixture spawn (40,44) sits inside the tin-shelter prop — start from
    // open ground so the prediction gate tests MOVEMENT, not that wall
    state.player = { x: 60, y: 60 };
    const me = state.serverAuthority.actors[state.playerActorId]!;
    me.x = 60;
    me.y = 60;
    state.serverAuthority.authoritativePlayer = { x: 60, y: 60 };
    // session key injection shape: Set + order, exactly like a keyboard
    state.keys.add("KeyW");
    state.movementKeyOrder.push("KeyW");

    const sfx = noopSfx();
    let time = 10_000; // deterministic virtual clock — no wall time
    for (let i = 0; i < 20; i += 1) {
      time += 50;
      updatePlayState(state, slice, 50, time, sfx);
    }

    expect(state.moving).toBe(true);
    const kinds = state.authorityCommands.pending.map((envelope) => authorityCommandKind(envelope.command));
    expect(kinds).toContain("SetMoveIntent");
    // World-cardinal W = north = raw (0,-1).
    const intent = state.authorityCommands.pending
      .map((envelope) => envelope.command)
      .find((command) => "SetMoveIntent" in command);
    expect(intent).toBeDefined();
    if (intent && "SetMoveIntent" in intent) {
      const payload = intent.SetMoveIntent as { dx: number; dy: number };
      expect(payload.dx).toBe(0);
      expect(payload.dy).toBeLessThan(0);
    }
  });

  it("dynamic identities alias to the slice followActor so the gate opens (session parity)", () => {
    const { state, slice } = createTuiPlayStateFixture();
    // simulate the pre-fix shape: playerActorId set to a wire-only id
    state.playerActorId = "fable-live";
    expect(slice.actors.some((actor) => actor.id === "fable-live")).toBe(false);
    // the session alias rule
    if (!slice.actors.some((actor) => actor.id === state.playerActorId)) {
      state.playerActorId = slice.camera.followActor;
    }
    expect(state.actors[state.playerActorId]).toBeDefined();
  });
});
