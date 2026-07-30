import { describe, expect, it } from "vitest";
import { BOOT_FRAME_FALLBACK_MS, type BootFrameScheduler, waitForNextBootFrame } from "./bootFrame";

type FakeScheduler = BootFrameScheduler & {
  fireFrame: () => void;
  fireTimer: () => void;
  frameCancelCount: number;
  timerClearCount: number;
};

function createFakeScheduler(options: { withAnimationFrame?: boolean } = {}): FakeScheduler {
  let frameCallback: FrameRequestCallback | undefined;
  let timerCallback: (() => void) | undefined;
  let nextHandle = 1;
  let frameCancelCount = 0;
  let timerClearCount = 0;

  const scheduler: FakeScheduler = {
    requestAnimationFrame: options.withAnimationFrame === false
      ? undefined
      : (callback) => {
        frameCallback = callback;
        return nextHandle++;
      },
    cancelAnimationFrame: () => {
      frameCancelCount += 1;
    },
    setTimeout: (callback) => {
      timerCallback = callback;
      return nextHandle++;
    },
    clearTimeout: () => {
      timerClearCount += 1;
    },
    fireFrame: () => {
      frameCallback?.(performance.now());
    },
    fireTimer: () => {
      timerCallback?.();
    },
    get frameCancelCount() {
      return frameCancelCount;
    },
    get timerClearCount() {
      return timerClearCount;
    },
  };

  return scheduler;
}

describe("waitForNextBootFrame", () => {
  it("uses the animation frame and clears the fallback timer", async () => {
    const scheduler = createFakeScheduler();
    const waiting = waitForNextBootFrame(scheduler);
    let resolved = false;
    void waiting.then(() => {
      resolved = true;
    });

    scheduler.fireFrame();
    await waiting;
    expect(resolved).toBe(true);
    expect(scheduler.frameCancelCount).toBe(0);
    expect(scheduler.timerClearCount).toBe(1);

    // A callback that was already queued cannot resolve boot a second time.
    scheduler.fireTimer();
    expect(scheduler.frameCancelCount).toBe(0);
    expect(scheduler.timerClearCount).toBe(1);
  });

  it("falls back to the timer when a throttled animation frame never arrives", async () => {
    const scheduler = createFakeScheduler();
    const waiting = waitForNextBootFrame(scheduler);
    scheduler.fireTimer();

    await waiting;
    expect(scheduler.frameCancelCount).toBe(1);
    expect(scheduler.timerClearCount).toBe(0);

    // A stale rAF callback cannot resolve boot a second time or clear again.
    scheduler.fireFrame();
    expect(scheduler.frameCancelCount).toBe(1);
    expect(scheduler.timerClearCount).toBe(0);
  });

  it("keeps the conservative fallback budget explicit", () => {
    expect(BOOT_FRAME_FALLBACK_MS).toBeGreaterThanOrEqual(50);
    expect(BOOT_FRAME_FALLBACK_MS).toBeLessThanOrEqual(100);
  });
});
