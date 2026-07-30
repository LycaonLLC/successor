// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { superviseWorldPropsLoad } from "./SuccessorThreeRenderer";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("SuccessorThreeRenderer world-prop hydration", () => {
  it("lets renderer creation resolve while deferred hydration remains unresolved", async () => {
    const hydration = deferred<void>();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    let hydrationSettled = false;
    void hydration.promise.then(() => {
      hydrationSettled = true;
    });

    const creation = Promise.resolve().then(() => {
      superviseWorldPropsLoad(hydration.promise);
      return { ready: true };
    });
    await expect(creation).resolves.toEqual({ ready: true });
    expect(hydrationSettled).toBe(false);
    expect(consoleError).not.toHaveBeenCalled();

    hydration.resolve();
    await hydration.promise;
    expect(consoleError).not.toHaveBeenCalled();
  });

  it("logs a rejected hydration without producing an unhandled rejection", async () => {
    const hydration = deferred<void>();
    const failure = new Error("prop hydration failed");
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);

    try {
      superviseWorldPropsLoad(hydration.promise);
      hydration.reject(failure);
      await Promise.resolve();
      await Promise.resolve();

      expect(consoleError).toHaveBeenCalledWith("world props: initial load failed", failure);
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});
