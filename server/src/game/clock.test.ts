import { describe, expect, it, vi } from "vitest";
import { ManualClock, systemClock } from "./clock.js";
import type { ShardTimer } from "./clock.js";

describe("ManualClock", () => {
  it("due-time and insertion order", async () => {
    const clock = new ManualClock(0);
    const order: number[] = [];
    clock.setTimeout(() => { order.push(1); }, 10);
    clock.setTimeout(() => { order.push(2); }, 10);
    clock.setTimeout(() => { order.push(3); }, 5);
    clock.setTimeout(() => { order.push(4); }, 15);

    await clock.advance(20);
    expect(order).toEqual([3, 1, 2, 4]);
  });

  it("due-time and insertion order when scheduled at different virtual times", async () => {
    const clock = new ManualClock(0);
    const order: number[] = [];
    clock.setTimeout(() => {
      order.push(1);
      clock.setTimeout(() => { order.push(3); }, 0);
    }, 10);
    clock.setTimeout(() => { order.push(2); }, 10);

    await clock.advance(10);
    expect(order).toEqual([1, 2, 3]);
  });

  it("async callback awaited before next timer", async () => {
    const clock = new ManualClock(0);
    const order: string[] = [];

    clock.setTimeout(async () => {
      order.push("A start");
      await new Promise<void>((resolve) => setImmediate(resolve));
      order.push("A end");
    }, 10);

    clock.setTimeout(() => {
      order.push("B");
    }, 20);

    await clock.advance(20);
    expect(order).toEqual(["A start", "A end", "B"]);
  });

  it("recursive async timer schedules all target callbacks", async () => {
    const clock = new ManualClock(0);
    let count = 0;
    const recursiveTimer = async () => {
      count++;
      if (count < 3) {
        clock.setTimeout(recursiveTimer, 10);
      }
    };
    clock.setTimeout(recursiveTimer, 10);

    await clock.advance(30);
    expect(count).toBe(3);
    expect(clock.nowMs()).toBe(30);
  });

  it("clear timeout/interval/self-clear", async () => {
    const clock = new ManualClock(0);
    const order: number[] = [];

    const t1 = clock.setTimeout(() => { order.push(1); }, 10);
    clock.setTimeout(() => { order.push(2); }, 10);
    clock.clearTimeout(t1);

    const i1 = clock.setInterval(() => { order.push(3); }, 10);

    let intervalCount = 0;
    const i2: ShardTimer = clock.setInterval(() => {
      intervalCount++;
      order.push(4);
      if (intervalCount === 2) {
        clock.clearInterval(i2);
      }
    }, 10);

    await clock.advance(25);
    expect(order).toEqual([2, 3, 4, 3, 4]);

    clock.clearInterval(i1);
    await clock.advance(10);
    expect(order).toEqual([2, 3, 4, 3, 4]);
  });

  it("monotonic/wall now", () => {
    const clock = new ManualClock(100);
    expect(clock.nowMs()).toBe(100);
    expect(clock.monotonicMs()).toBe(100);

    expect(systemClock.mode).toBe("system");
    expect(typeof systemClock.nowMs()).toBe("number");
    expect(typeof systemClock.monotonicMs()).toBe("number");
  });

  it("concurrent advance rejection", async () => {
    const clock = new ManualClock(0);
    let p1Resolved = false;
    clock.setTimeout(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
    }, 10);

    const p1 = clock.advance(20).then(() => { p1Resolved = true; });

    await expect(clock.advance(10)).rejects.toThrow("ManualClock advance is already in progress");
    await p1;
    expect(p1Resolved).toBe(true);
  });

  it("callback failure propagation", async () => {
    const clock = new ManualClock(0);
    clock.setTimeout(() => {
      throw new Error("Callback error");
    }, 10);

    await expect(clock.advance(20)).rejects.toThrow("Callback error");
    expect(clock.nowMs()).toBe(10);

    let run = false;
    clock.setTimeout(() => { run = true; }, 15);
    await clock.advance(15);
    expect(run).toBe(true);
  });

  it("1000-callback yield", async () => {
    const clock = new ManualClock(0);
    let count = 0;
    for (let i = 0; i < 1005; i++) {
      clock.setTimeout(() => {
        count++;
      }, 10);
    }

    const spy = vi.spyOn(globalThis, "setImmediate");

    try {
      await clock.advance(20);
      expect(count).toBe(1005);
      expect(spy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it("settle called per fire", async () => {
    const clock = new ManualClock(0);
    const order: string[] = [];

    clock.setTimeout(() => {
      order.push("A");
    }, 10);

    clock.setTimeout(() => {
      order.push("B");
    }, 20);

    let settleCount = 0;
    const settle = () => {
      settleCount++;
      order.push(`settle ${settleCount}`);
    };

    await clock.advance(25, { settle });
    expect(order).toEqual(["A", "settle 1", "B", "settle 2"]);
  });

  it("tooth test: void-discarding recursive callback skips advancement/ticks", async () => {
    const clock = new ManualClock(0);
    let count = 0;

    const cb = () => {
      (async () => {
        await new Promise<void>((resolve) => setImmediate(resolve));
        count++;
        if (count < 3) {
          clock.setTimeout(cb, 10);
        }
      })();
    };

    clock.setTimeout(cb, 10);

    await clock.advance(30);

    expect(count).toBe(0);

    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(count).toBe(1);
  });
});
