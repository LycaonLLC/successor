import { performance } from "node:perf_hooks";

export type ShardTimerCallback = () => void | Promise<void>;

export interface ShardTimer {
  unref(): ShardTimer;
}

export interface ShardClock {
  readonly mode: "system" | "manual";
  nowMs(): number;
  monotonicMs(): number;
  setTimeout(callback: ShardTimerCallback, ms: number): ShardTimer;
  clearTimeout(timer: ShardTimer): void;
  setInterval(callback: ShardTimerCallback, ms: number): ShardTimer;
  clearInterval(timer: ShardTimer): void;
}

export interface ManualClockAdvanceOptions {
  settle?: () => void | Promise<void>;
}

const manualClockYieldEveryCallbacks = 1_000;

export const systemClock: ShardClock = {
  mode: "system",
  nowMs: Date.now,
  monotonicMs: () => performance.now(),
  setTimeout(callback, ms) {
    const timer = setTimeout(callback, normalizeTimeoutDelay(ms));
    timer.unref();
    return timer;
  },
  clearTimeout(timer) {
    clearTimeout(timer as NodeJS.Timeout);
  },
  setInterval(callback, ms) {
    const timer = setInterval(callback, normalizeIntervalDelay(ms));
    timer.unref();
    return timer;
  },
  clearInterval(timer) {
    clearInterval(timer as NodeJS.Timeout);
  },
};

class ManualTimer implements ShardTimer {
  heapIndex = -1;
  cleared = false;

  constructor(
    readonly owner: ManualClock,
    readonly callback: ShardTimerCallback,
    readonly intervalMs: number | null,
    public dueMs: number,
    public insertionOrder: number,
  ) {}

  unref(): ShardTimer {
    return this;
  }
}

export class ManualClock implements ShardClock {
  readonly mode = "manual" as const;

  private virtualNowMs: number;
  private nextInsertionOrder = 1;
  private readonly timers: ManualTimer[] = [];
  private advancing = false;

  constructor(initialNowMs = 0) {
    if (!Number.isFinite(initialNowMs)) throw new RangeError("ManualClock initial time must be finite");
    this.virtualNowMs = initialNowMs;
  }

  nowMs(): number {
    return this.virtualNowMs;
  }

  monotonicMs(): number {
    return this.virtualNowMs;
  }

  setTimeout(callback: ShardTimerCallback, ms: number): ShardTimer {
    return this.schedule(callback, normalizeTimeoutDelay(ms), null);
  }

  clearTimeout(timer: ShardTimer): void {
    this.clear(timer);
  }

  setInterval(callback: ShardTimerCallback, ms: number): ShardTimer {
    const intervalMs = normalizeIntervalDelay(ms);
    return this.schedule(callback, intervalMs, intervalMs);
  }

  clearInterval(timer: ShardTimer): void {
    this.clear(timer);
  }

  async advance(ms: number, options: ManualClockAdvanceOptions = {}): Promise<void> {
    if (!Number.isFinite(ms) || ms < 0) throw new RangeError("ManualClock advance must be a finite non-negative duration");
    if (this.advancing) throw new Error("ManualClock advance is already in progress");

    const targetMs = this.virtualNowMs + ms;
    if (!Number.isFinite(targetMs)) throw new RangeError("ManualClock target time must be finite");

    this.advancing = true;
    let callbacksSinceYield = 0;
    try {
      for (;;) {
        const timer = this.peekActiveTimer();
        if (!timer || timer.dueMs > targetMs) break;

        this.popTimer();
        if (timer.cleared) continue;
        this.virtualNowMs = timer.dueMs;

        let callbackFailed = false;
        let callbackError: unknown;
        try {
          const completion = timer.callback();
          if (completion) await completion;
        } catch (error) {
          callbackFailed = true;
          callbackError = error;
        }

        if (!timer.cleared && timer.intervalMs !== null) {
          timer.dueMs += timer.intervalMs;
          timer.insertionOrder = this.nextInsertionOrder++;
          this.pushTimer(timer);
        } else {
          timer.cleared = true;
        }

        let settlementFailed = false;
        let settlementError: unknown;
        try {
          const settlement = options.settle?.();
          if (settlement) await settlement;
        } catch (error) {
          settlementFailed = true;
          settlementError = error;
        }
        if (callbackFailed) throw callbackError;
        if (settlementFailed) throw settlementError;

        callbacksSinceYield += 1;
        if (callbacksSinceYield >= manualClockYieldEveryCallbacks) {
          callbacksSinceYield = 0;
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
      }
      this.virtualNowMs = targetMs;
    } finally {
      this.advancing = false;
    }
  }

  private schedule(callback: ShardTimerCallback, delayMs: number, intervalMs: number | null): ManualTimer {
    const timer = new ManualTimer(
      this,
      callback,
      intervalMs,
      this.virtualNowMs + delayMs,
      this.nextInsertionOrder++,
    );
    this.pushTimer(timer);
    return timer;
  }

  private clear(timer: ShardTimer): void {
    if (!(timer instanceof ManualTimer) || timer.owner !== this || timer.cleared) return;
    timer.cleared = true;
    if (timer.heapIndex >= 0) this.removeTimerAt(timer.heapIndex);
  }

  private peekActiveTimer(): ManualTimer | undefined {
    let timer = this.timers[0];
    while (timer?.cleared) {
      this.popTimer();
      timer = this.timers[0];
    }
    return timer;
  }

  private pushTimer(timer: ManualTimer): void {
    timer.heapIndex = this.timers.length;
    this.timers.push(timer);
    this.siftUp(timer.heapIndex);
  }

  private popTimer(): ManualTimer | undefined {
    if (this.timers.length === 0) return undefined;
    return this.removeTimerAt(0);
  }

  private removeTimerAt(index: number): ManualTimer | undefined {
    const removed = this.timers[index];
    const last = this.timers.pop();
    if (!removed || !last) return removed;

    removed.heapIndex = -1;
    if (removed === last) return removed;

    this.timers[index] = last;
    last.heapIndex = index;
    const parentIndex = Math.floor((index - 1) / 2);
    if (index > 0 && timerPrecedes(last, this.timers[parentIndex]!)) {
      this.siftUp(index);
    } else {
      this.siftDown(index);
    }
    return removed;
  }

  private siftUp(startIndex: number): void {
    let index = startIndex;
    while (index > 0) {
      const parentIndex = Math.floor((index - 1) / 2);
      if (!timerPrecedes(this.timers[index]!, this.timers[parentIndex]!)) break;
      this.swapTimers(index, parentIndex);
      index = parentIndex;
    }
  }

  private siftDown(startIndex: number): void {
    let index = startIndex;
    for (;;) {
      const leftIndex = index * 2 + 1;
      const rightIndex = leftIndex + 1;
      let nextIndex = index;
      if (leftIndex < this.timers.length && timerPrecedes(this.timers[leftIndex]!, this.timers[nextIndex]!)) {
        nextIndex = leftIndex;
      }
      if (rightIndex < this.timers.length && timerPrecedes(this.timers[rightIndex]!, this.timers[nextIndex]!)) {
        nextIndex = rightIndex;
      }
      if (nextIndex === index) return;
      this.swapTimers(index, nextIndex);
      index = nextIndex;
    }
  }

  private swapTimers(leftIndex: number, rightIndex: number): void {
    const left = this.timers[leftIndex]!;
    const right = this.timers[rightIndex]!;
    this.timers[leftIndex] = right;
    this.timers[rightIndex] = left;
    left.heapIndex = rightIndex;
    right.heapIndex = leftIndex;
  }
}

function timerPrecedes(left: ManualTimer, right: ManualTimer): boolean {
  return left.dueMs < right.dueMs
    || (left.dueMs === right.dueMs && left.insertionOrder < right.insertionOrder);
}

function normalizeTimeoutDelay(ms: number): number {
  return Number.isFinite(ms) ? Math.max(0, ms) : 0;
}

function normalizeIntervalDelay(ms: number): number {
  return Math.max(1, normalizeTimeoutDelay(ms));
}
