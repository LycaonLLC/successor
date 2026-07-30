import { describe, test, expect, vi, beforeAll, afterAll } from "vitest";

// Mock child_process so pnpm/cargo build commands do not run
vi.mock("node:child_process", () => {
  return {
    spawnSync: vi.fn().mockReturnValue({ status: 0, stdout: "", stderr: "" }),
    spawn: vi.fn().mockReturnValue({
      pid: 99999,
      unref: vi.fn(),
      once: vi.fn((event, cb) => {
        if (event === "spawn") setTimeout(cb, 0);
      }),
      on: vi.fn()
    })
  };
});

// Mock http so healthz and status checks resolve immediately
vi.mock("node:http", () => {
  return {
    default: {
      get: vi.fn((options, cb) => {
        const res = {
          statusCode: 200,
          resume: vi.fn(),
          setEncoding: vi.fn(),
          on: vi.fn((event, eventCb) => {
            if (event === "end" || event === "data") {
              setTimeout(() => {
                if (event === "data") eventCb('{"ok":true,"shardId":"mock-shard","actorCount":0,"source":"mock"}');
                if (event === "end") eventCb();
              }, 0);
            }
          })
        };
        setTimeout(() => cb(res), 0);
        return {
          on: vi.fn(),
          destroy: vi.fn()
        };
      })
    }
  };
});

// Mock process-host so it doesn't touch the filesystem or spawn real processes
vi.mock("./process-host.mjs", () => {
  return {
    createProcessHost: vi.fn().mockReturnValue({
      kind: "child",
      runId: "mock-run-id",
      runDir: "mock-run-dir",
      start: vi.fn().mockResolvedValue({
        name: "mock-proc",
        pid: 88888,
        logPath: "mock-log"
      }),
      stop: vi.fn().mockResolvedValue({ ok: true, finalState: "inactive", failures: [] }),
      logs: vi.fn().mockResolvedValue("mock-logs"),
      inspect: vi.fn().mockResolvedValue({ activeState: "active", mainPid: 88888, error: null }),
      sweep: vi.fn().mockResolvedValue({ ok: true, swept: [], failures: [] }),
      adopt: vi.fn((handle) => handle)
    })
  };
});

describe("Migrated Callers Parsing and Importing", () => {
  const originalLog = console.log;
  const originalError = console.error;

  beforeAll(() => {
    console.log = () => {};
    console.error = () => {};
  });

  afterAll(() => {
    console.log = originalLog;
    console.error = originalError;
  });

  test("import tools/verification/scenario/runner.mjs", async () => {
    const mod = await import("../scenario/runner.mjs");
    expect(mod.loadScenario).toBeTypeOf("function");
  });

  test("import tools/verification/client3d/lib/stack.mjs", async () => {
    const mod = await import("../client3d/lib/stack.mjs");
    expect(mod.buildPrerequisites).toBeTypeOf("function");
  });

  test("import tools/verification/farm/capabilities.mjs", async () => {
    const mod = await import("../farm/capabilities.mjs");
    expect(mod.probeCapabilities).toBeTypeOf("function");
  });

  test("import tools/verification/simplayer/world.mjs", async () => {
    const mod = await import("../simplayer/world.mjs");
    expect(mod.writeSoakSlice).toBeTypeOf("function");
  });

  test("import client-tui/journeys/lib/stack.mjs", async () => {
    const mod = await import("../../../client-tui/journeys/lib/stack.mjs");
    expect(mod.startStack).toBeTypeOf("function");
  });

  test("import tools/successor/serve-open-desert-fixture.mjs", async () => {
    const mod = await import("../../successor/serve-open-desert-fixture.mjs");
    expect(mod).toBeDefined();
  });
});
