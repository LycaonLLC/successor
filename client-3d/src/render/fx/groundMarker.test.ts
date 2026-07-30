import { describe, expect, it } from "vitest";
import { Scene } from "three";
import {
  cancelClickMove,
  completeClickMove,
  drainClickMoveEvents,
  setClickMoveTarget,
  type ClickMoveEvent,
} from "@successor/client/src/slice-core/movementSystem";
import { ClickMoveMarkerFx } from "./groundMarker";

// Each game state owns its bounded click-move event queue.
function freshMarker(reducedMotion = false): { fx: ClickMoveMarkerFx; state: object } {
  const state = {};
  const scratch: ClickMoveEvent[] = [];
  drainClickMoveEvents(state, scratch);
  return { fx: new ClickMoveMarkerFx(new Scene(), reducedMotion), state };
}

describe("ClickMoveMarkerFx", () => {
  it("stamps at the clicked cell centre and idles while the target lives", () => {
    const { fx, state } = freshMarker();
    setClickMoveTarget(state, 8, 5, "area-a");

    fx.update(state, 1 / 60);

    expect(fx.debugPhase).toBe("active");
    expect(fx.debugX).toBeCloseTo(8.5);
    expect(fx.debugZ).toBeCloseTo(5.5);

    // Stays active across time while the target is unchanged.
    for (let i = 0; i < 120; i += 1) fx.update(state, 1 / 60);
    expect(fx.debugPhase).toBe("active");
    fx.dispose();
  });

  it("follows a retarget to the new cell without leaving the active phase", () => {
    const { fx, state } = freshMarker();
    setClickMoveTarget(state, 8, 5, "area-a");
    fx.update(state, 1 / 60);
    setClickMoveTarget(state, 2, 9, "area-a");

    fx.update(state, 1 / 60);

    expect(fx.debugPhase).toBe("active");
    expect(fx.debugX).toBeCloseTo(2.5);
    expect(fx.debugZ).toBeCloseTo(9.5);
    fx.dispose();
  });

  it("plays the landing beat on arrival and returns to idle", () => {
    const { fx, state } = freshMarker();
    setClickMoveTarget(state, 8, 5, "area-a");
    fx.update(state, 1 / 60);
    completeClickMove(state);

    fx.update(state, 1 / 60);
    expect(fx.debugPhase).toBe("arriving");

    // The 260ms landing beat finishes and the marker hides.
    fx.update(state, 0.3);
    expect(fx.debugPhase).toBe("idle");
    expect(fx.debugOpacity).toBe(0);
    fx.dispose();
  });

  it("fades fast on cancel", () => {
    const { fx, state } = freshMarker();
    setClickMoveTarget(state, 8, 5, "area-a");
    fx.update(state, 1 / 60);
    cancelClickMove(state, "manual-input");

    fx.update(state, 1 / 60);
    expect(fx.debugPhase).toBe("cancelling");
    fx.update(state, 0.2);
    expect(fx.debugPhase).toBe("idle");
    fx.dispose();
  });

  it("skips the stamp-in animation under reduced motion (full alpha immediately)", () => {
    const { fx, state } = freshMarker(true);
    setClickMoveTarget(state, 8, 5, "area-a");

    fx.update(state, 0.001);

    expect(fx.debugPhase).toBe("active");
    expect(fx.debugOpacity).toBeCloseTo(0.62);
    fx.dispose();
  });

  it("eases in the stamp with motion enabled (no instant pop)", () => {
    const { fx, state } = freshMarker(false);
    setClickMoveTarget(state, 8, 5, "area-a");

    fx.update(state, 0.001);

    expect(fx.debugPhase).toBe("active");
    expect(fx.debugOpacity).toBeLessThan(0.1);
    fx.dispose();
  });

  it("fades out an orphaned marker when the target vanished without an event", () => {
    const { fx, state } = freshMarker();
    setClickMoveTarget(state, 8, 5, "area-a");
    fx.update(state, 1 / 60);

    // Another consumer drained the cancel event — the marker must not squat.
    cancelClickMove(state, "cleared");
    const stolen: ClickMoveEvent[] = [];
    drainClickMoveEvents(state, stolen);

    fx.update(state, 1 / 60);
    expect(fx.debugPhase).toBe("cancelling");
    fx.dispose();
  });
});
