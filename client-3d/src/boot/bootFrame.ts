export const BOOT_FRAME_FALLBACK_MS = 75;

export type BootFrameScheduler = {
  requestAnimationFrame?: (callback: FrameRequestCallback) => number;
  cancelAnimationFrame?: (handle: number) => void;
  setTimeout: (callback: () => void, delayMs: number) => number;
  clearTimeout: (handle: number) => void;
};

function defaultBootFrameScheduler(): BootFrameScheduler {
  if (typeof window === "undefined") {
    return {
      requestAnimationFrame: undefined,
      cancelAnimationFrame: undefined,
      setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs) as unknown as number,
      clearTimeout: (handle) => globalThis.clearTimeout(handle),
    };
  }

  return {
    requestAnimationFrame: typeof window.requestAnimationFrame === "function"
      ? window.requestAnimationFrame.bind(window)
      : undefined,
    cancelAnimationFrame: typeof window.cancelAnimationFrame === "function"
      ? window.cancelAnimationFrame.bind(window)
      : undefined,
    setTimeout: window.setTimeout.bind(window),
    clearTimeout: window.clearTimeout.bind(window),
  };
}

/**
 * Wait for one paint opportunity without letting a throttled/offscreen iframe
 * hold boot forever. The first callback wins and cleans up the other one.
 */
export function waitForNextBootFrame(
  scheduler: BootFrameScheduler = defaultBootFrameScheduler(),
  fallbackMs = BOOT_FRAME_FALLBACK_MS,
): Promise<void> {
  return new Promise<void>((resolve) => {
    let settled = false;
    let frameId: number | undefined;
    let timerId: number | undefined;

    const finish = (winner: "frame" | "timer"): void => {
      if (settled) return;
      settled = true;
      if (winner === "frame") {
        if (timerId !== undefined) scheduler.clearTimeout(timerId);
      } else if (frameId !== undefined) {
        scheduler.cancelAnimationFrame?.(frameId);
      }
      resolve();
    };

    timerId = scheduler.setTimeout(() => finish("timer"), fallbackMs);
    if (settled) return;

    if (scheduler.requestAnimationFrame) {
      frameId = scheduler.requestAnimationFrame(() => finish("frame"));
    }
  });
}
