import { describe, expect, it } from "vitest";

import { parseDriverEnvelopes, runScratchDriverTranscript, scratchPortFromEnv } from "./driverHarness";

const scratchPort = scratchPortFromEnv();
const maybeIt = scratchPort === null ? it.skip : it;

describe("scratch stack driver integration", () => {
  maybeIt("round-trips headless query frames and tears down with a closed status", async () => {
    const result = await runScratchDriverTranscript({
      port: scratchPort,
      frames: [
        { op: "query", verb: "/where" },
        { op: "query", verb: "/budget" },
        { op: "quit" },
      ],
      timeoutMs: 15_000,
    });

    expect(result.code, result.stderr).toBe(0);
    const envelopes = parseDriverEnvelopes(result.stdoutLines);
    expect(envelopes.some((envelope) => envelope.type === "query" && envelope.verb === "where")).toBe(true);
    expect(envelopes.some((envelope) => envelope.type === "query" && envelope.verb === "budget")).toBe(true);
    expect(envelopes.at(-1)).toMatchObject({ type: "status", status: "closed" });
  });
});
