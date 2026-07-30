import { afterEach, describe, expect, it, vi } from "vitest";
import { RuntimeHeartbeat, runtimeHeartbeatConfigFromEnv, type RuntimeHeartbeatLogger } from "./runtimeHeartbeat.js";

const config = {
  siteUrl: "https://successor.example",
  runtimeSecret: "legacy-runtime-secret",
  runtimeBearerToken: "runtime-bearer-token",
  shardId: "shard-scout",
  releaseId: "release-2026-07-24",
};

function response(status = 204): Response {
  return new Response(null, { status });
}

function logger(): RuntimeHeartbeatLogger & { warnings: Array<{ reason: string }>; infos: Array<{ reason: string }> } {
  const warnings: Array<{ reason: string }> = [];
  const infos: Array<{ reason: string }> = [];
  return {
    warnings,
    infos,
    warn: (fields) => warnings.push(fields),
    info: (fields) => infos.push(fields),
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("runtime heartbeat", () => {
  it("sends the authenticated ready heartbeat only after local readiness", async () => {
    vi.useFakeTimers();
    let ready = false;
    const fetchImpl = vi.fn<typeof fetch>(async () => response());
    const heartbeat = new RuntimeHeartbeat({ config, isReady: () => ready, fetchImpl, intervalMs: 1_000 });

    heartbeat.start();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetchImpl).not.toHaveBeenCalled();

    ready = true;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("https://successor.example/api/v1/storefront/successor/runtime/heartbeat");
    expect(init?.method).toBe("PUT");
    expect(init?.body).toBe(JSON.stringify({ readiness: "ready" }));
    expect(init?.headers).toEqual({
      Accept: "application/json",
      "Content-Type": "application/json",
      "User-Agent": "Successor-Runtime/1.0",
      "x-successor-runtime-key": "legacy-runtime-secret",
      Authorization: "Bearer runtime-bearer-token",
      "x-successor-shard-id": "shard-scout",
      "x-successor-release-id": "release-2026-07-24",
    });
    heartbeat.stop();
  });

  it("does not overlap requests and stops future refreshes on shutdown", async () => {
    vi.useFakeTimers();
    let resolveRequest!: (value: Response) => void;
    const pending = new Promise<Response>((resolve) => { resolveRequest = resolve; });
    const fetchImpl = vi.fn<typeof fetch>(() => pending);
    const heartbeat = new RuntimeHeartbeat({ config, isReady: () => true, fetchImpl, intervalMs: 1_000 });

    heartbeat.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const signal = fetchImpl.mock.calls[0]?.[1]?.signal as AbortSignal;
    heartbeat.stop();
    expect(signal.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    resolveRequest(response());
    await Promise.resolve();
  });

  it("logs bounded failure and one recovery without exposing credentials", async () => {
    vi.useFakeTimers();
    const logs = logger();
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response(503))
      .mockResolvedValueOnce(response(503))
      .mockResolvedValueOnce(response(204));
    const heartbeat = new RuntimeHeartbeat({ config, isReady: () => true, fetchImpl, logger: logs, intervalMs: 1_000 });

    heartbeat.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(logs.warnings).toEqual([{ reason: "http_503" }]);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(logs.warnings).toEqual([{ reason: "http_503" }]);
    expect(logs.infos).toEqual([{ reason: "recovered" }]);
    expect(JSON.stringify(logs)).not.toContain("legacy-runtime-secret");
    expect(JSON.stringify(logs)).not.toContain("runtime-bearer-token");
    heartbeat.stop();
  });

  it("fails closed for hosted runtimes with incomplete credentials", async () => {
    vi.useFakeTimers();
    expect(runtimeHeartbeatConfigFromEnv({ NODE_ENV: "production", SUCCESSOR_SITE_URL: "https://successor.example" })).toBeNull();
    expect(runtimeHeartbeatConfigFromEnv({ NODE_ENV: "development" })).toBeNull();
    expect(runtimeHeartbeatConfigFromEnv({
      NODE_ENV: "production",
      SUCCESSOR_SITE_URL: "https://successor.example/",
      SUCCESSOR_RUNTIME_SECRET: "secret",
      SUCCESSOR_RUNTIME_BEARER_TOKEN: "bearer",
      SUCCESSOR_SHARD_ID: "shard",
      SUCCESSOR_RELEASE_ID: "release",
    })).toEqual({
      siteUrl: "https://successor.example",
      runtimeSecret: "secret",
      runtimeBearerToken: "bearer",
      shardId: "shard",
      releaseId: "release",
    });

    const fetchImpl = vi.fn<typeof fetch>(async () => response());
    const heartbeat = new RuntimeHeartbeat({ config: null, isReady: () => true, fetchImpl, intervalMs: 1_000 });
    heartbeat.start();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(fetchImpl).not.toHaveBeenCalled();
    heartbeat.stop();
  });
});
