import { describe, expect, it } from "vitest";

import { SCRATCH_STACK_MIN_PORT, scratchEndpoint, scratchPortFromEnv } from "./driverHarness";

describe("scratch driver harness guards", () => {
  it("only accepts disposable scratch ports", () => {
    expect(scratchPortFromEnv({ OPEN_DESERT_PORT: "28092" })).toBe(28092);
    expect(scratchEndpoint(28092)).toBe("http://127.0.0.1:28092");
    expect(scratchPortFromEnv({})).toBeNull();
    expect(() => scratchPortFromEnv({ OPEN_DESERT_PORT: "9999" })).toThrow(String(SCRATCH_STACK_MIN_PORT));
    expect(() => scratchPortFromEnv({ OPEN_DESERT_PORT: "not-a-port" })).toThrow("not-a-port");
  });
});
