import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { ensureBuiltCli, materializeActorId, runJourneyGate } from "../journeys/runner.mjs";
type Session = {
  actorId: string;
  quit(): Promise<void>;
  kill(): void;
  transcript(): string;
};

type GateStack = {
  unit: string;
  shardId: string;
  sliceHash: string;
  runId?: string;
  runDir?: string;
  storePath?: string;
  shardPath?: string;
  sharedProof?: string;
  stop(): Promise<{ ok: true }>;
};

type JourneyContext = {
  port: number;
  stack: GateStack;
  session(options: { actorId?: string }): Session;
  check(description: string, condition: unknown): void;
};

type IsolatedLayout = Required<Pick<GateStack, "unit" | "runId" | "runDir" | "storePath" | "shardPath">> & { port: number };

async function withTempDirectory<T>(prefix: string, callback: (directory: string) => Promise<T>): Promise<T> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  try {
    return await callback(directory);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

function stackFor(layout: IsolatedLayout, onStop: () => void = () => undefined): GateStack {
  return {
    unit: layout.unit,
    runId: layout.runId,
    runDir: layout.runDir,
    storePath: layout.storePath,
    shardPath: layout.shardPath,
    shardId: `shard-${layout.port}`,
    sliceHash: `slice-${layout.port}`,
    stop: async () => {
      onStop();
      return { ok: true };
    },
  };
}

function disposableSession(actorId = "fixture-actor"): Session {
  return {
    actorId,
    quit: async () => undefined,
    kill: () => undefined,
    transcript: () => `transcript for ${actorId}`,
  };
}

describe("TUI journey runner isolation", () => {
  it("bounds long farm actor IDs at 64 characters while retaining deterministic distinct identities", () => {
    const longRun = "farm-run-with-a-deliberately-long-identifier-for-boundary-proof";
    const first = materializeActorId(longRun, 0, "attack-approach", "gunner");
    const second = materializeActorId(longRun, 0, "attack-approach", "mark");
    expect(first).toHaveLength(64);
    expect(second).toHaveLength(64);
    expect(first).not.toBe(second);
    expect(first).toBe(materializeActorId(longRun, 0, "attack-approach", "gunner"));
  });

  it("requires a prebuilt CLI in skip-build mode while allowing a stale existing CLI to pass through", async () => {
    await withTempDirectory("successor-tui-skip-build-", async (root) => {
      const cliPath = path.join(root, "client-tui", "dist", "cli.js");
      const sourcePath = path.join(root, "client-tui", "src", "cli.ts");
      await fs.mkdir(path.dirname(cliPath), { recursive: true });
      await fs.mkdir(path.dirname(sourcePath), { recursive: true });
      await fs.writeFile(cliPath, "old built CLI\n", "utf8");
      await fs.writeFile(sourcePath, "newer source\n", "utf8");
      await fs.utimes(cliPath, new Date(1_000), new Date(1_000));
      await fs.utimes(sourcePath, new Date(2_000), new Date(2_000));

      expect(() => ensureBuiltCli({
        cliPath,
        sourceDirs: [path.dirname(sourcePath)],
        repoRoot: root,
        env: { TUI_GATE_SKIP_BUILD: "1" },
      })).not.toThrow();

      await fs.rm(cliPath);
      expect(() => ensureBuiltCli({
        cliPath,
        sourceDirs: [path.dirname(sourcePath)],
        repoRoot: root,
        env: { TUI_GATE_SKIP_BUILD: "1" },
      })).toThrow(`TUI_GATE_SKIP_BUILD=1 requires prebuilt client-tui dist; missing: ${cliPath}`);
    });
  });

  it("keeps isolated stacks bounded and emits source-ordered, independently scoped failure evidence", async () => {
    await withTempDirectory("successor-tui-isolated-", async (root) => {
      const artifactRoot = path.join(root, "artifacts");
      const firstTwoStarted = Promise.withResolvers<void>();
      const gammaStarted = Promise.withResolvers<void>();
      const releases: Record<"alpha" | "beta" | "gamma", PromiseWithResolvers<void>> = {
        alpha: Promise.withResolvers<void>(),
        beta: Promise.withResolvers<void>(),
        gamma: Promise.withResolvers<void>(),
      };
      const started: Array<{ id: "alpha" | "beta" | "gamma"; port: number; stack: GateStack }> = [];
      let activeStacks = 0;
      let peakStacks = 0;

      const journeys = (["alpha", "beta", "gamma"] as const).map((id) => ({
        id,
        async run(context: JourneyContext) {
          started.push({ id, port: context.port, stack: context.stack });
          if (started.length === 2) firstTwoStarted.resolve();
          if (id === "gamma") gammaStarted.resolve();
          await releases[id].promise;
          if (id === "alpha") {
            context.session({ actorId: "alpha-session" });
            throw new Error("alpha journey regression");
          }
          context.check(`${id} stayed inside its own shard`, true);
        },
      }));

      const gate = runJourneyGate({
        argv: ["--isolated", "--concurrency", "2"],
        env: { TUI_GATE_PORT: "32000", TUI_GATE_RUN_ID: "isolation-proof" },
        repoRoot: root,
        artifactRoot,
        journeys,
        preflight: false,
        now: () => 1_700_000_000_000,
        log: () => undefined,
        startStackFn: async (port: number, layout: IsolatedLayout) => {
          activeStacks += 1;
          peakStacks = Math.max(peakStacks, activeStacks);
          return stackFor({ ...layout, port }, () => {
            activeStacks -= 1;
          });
        },
        createSessionFn: ({ actorId }: { actorId?: string }) => disposableSession(actorId),
      });
      void gate.catch((error: unknown) => {
        firstTwoStarted.reject(error);
        gammaStarted.reject(error);
      });

      await firstTwoStarted.promise;
      expect(peakStacks).toBe(2);
      releases.beta.resolve();
      await gammaStarted.promise;
      expect(peakStacks).toBe(2);
      releases.gamma.resolve();
      releases.alpha.resolve();

      const result = await gate;
      expect(activeStacks).toBe(0);
      expect(result.exitCode).toBe(1);
      expect(result.manifest).toMatchObject({
        schema: "successor.tui-gate.v1",
        mode: "isolated",
        concurrency: 2,
        status: "fail",
      });

      const journeyResults = result.manifest.passes[0].results;
      expect(journeyResults.map((journey) => journey.id)).toEqual(["alpha", "beta", "gamma"]);
      expect(journeyResults.map((journey) => journey.status)).toEqual(["fail", "pass", "pass"]);
      for (const field of ["port", "shardId", "runId", "runDir", "storePath", "shardPath", "artifactDir"]) {
        expect(new Set(journeyResults.map((journey) => journey[field])).size, field).toBe(journeyResults.length);
      }

      const failed = journeyResults[0]!;
      expect(failed.transcriptPath).toBe(path.join(failed.artifactDir!, "alpha-FAIL.txt"));
      expect(await fs.readFile(failed.transcriptPath!, "utf8")).toContain("transcript for alpha-session");
      await expect(fs.access(path.join(journeyResults[1]!.artifactDir!, "alpha-FAIL.txt"))).rejects.toThrow();
      expect(JSON.parse(await fs.readFile(result.manifestPath, "utf8"))).toMatchObject({
        status: "fail",
        mode: "isolated",
      });
    });
  });

  it("retains the explicit shared iteration mode so later journeys observe the same stack state", async () => {
    await withTempDirectory("successor-tui-shared-", async (root) => {
      const journeys = [
        {
          id: "writer",
          async run(context: JourneyContext) {
            context.stack.sharedProof = "writer-completed";
          },
        },
        {
          id: "reader",
          async run(context: JourneyContext) {
            context.check("the previous journey used this shared iteration stack", context.stack.sharedProof === "writer-completed");
          },
        },
      ];
      const sharedStack: GateStack = {
        unit: "shared-stack",
        shardId: "shared-shard",
        sliceHash: "shared-slice",
        stop: async () => ({ ok: true }),
      };
      let resetCalls = 0;

      const result = await runJourneyGate({
        argv: ["--once"],
        env: { TUI_GATE_PORT: "32100", TUI_GATE_RUN_ID: "shared-compatibility" },
        repoRoot: root,
        artifactRoot: path.join(root, "artifacts"),
        journeys,
        preflight: false,
        now: () => 1_700_000_000_000,
        log: () => undefined,
        startStackFn: async () => sharedStack,
        resetStackFn: async (port: number) => {
          expect(port).toBe(32100);
          resetCalls += 1;
          return { accepted: true };
        },
      });

      expect(result.exitCode).toBe(0);
      expect(resetCalls).toBe(journeys.length);
      expect(result.manifest).toMatchObject({
        status: "pass",
        bar: "single pass (iteration mode)",
      });
      expect(result.manifest.passes).toHaveLength(1);
      expect(result.manifest.passes[0].results.map((journey) => journey.status)).toEqual(["pass", "pass"]);
    });
  });
});
