import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { originMatches, runtimeAuthConfigFromEnv } from "./runtime.js";

describe("standalone socket origin policy", () => {
  it.each([
    ["https://www.successorgame.com", true],
    ["https://d2kf3ri6r74a0m.cloudfront.net", true],
    ["https://evil.successorgame.com", false],
    ["https://www.successorgame.com.evil.test", false],
    ["null", false],
    [undefined, false],
    [["https://www.successorgame.com", "https://evil.test"], false],
  ])("accepts only the exact configured origin (%s)", (requestOrigin, allowed) => {
    expect(originMatches(requestOrigin, ["https://www.successorgame.com", "https://d2kf3ri6r74a0m.cloudfront.net"])).toBe(allowed);
  });

  it("requires exact HTTPS storefront and client origins in standalone mode", () => {
    const base = {
      NODE_ENV: "production",
      SUCCESSOR_CONTROL_PLANE_MODE: "standalone",
      ALPHA_CONTROL_DB_PATH: path.join(os.tmpdir(), "control.sqlite"),
      ALPHA_CONTROL_CLAIM_SECRET: "a".repeat(64),
      SUCCESSOR_ALPHA_ORIGIN: "https://www.successorgame.com",
      SUCCESSOR_ALPHA_CLIENT_ORIGIN: "https://d2kf3ri6r74a0m.cloudfront.net",
    };
    const config = runtimeAuthConfigFromEnv(base);
    expect(config.origin).toBe(base.SUCCESSOR_ALPHA_ORIGIN);
    expect(config.clientOrigin).toBe(base.SUCCESSOR_ALPHA_CLIENT_ORIGIN);
    expect(() => runtimeAuthConfigFromEnv({ ...base, SUCCESSOR_ALPHA_CLIENT_ORIGIN: undefined })).toThrow(/SUCCESSOR_ALPHA_CLIENT_ORIGIN is required/u);
    for (const [name, origin] of [["SUCCESSOR_ALPHA_ORIGIN", "http://www.successorgame.com"], ["SUCCESSOR_ALPHA_CLIENT_ORIGIN", "https://d2kf3ri6r74a0m.cloudfront.net/"] ] as const) {
      expect(() => runtimeAuthConfigFromEnv({ ...base, [name]: origin })).toThrow(/exact HTTPS origin/u);
    }
  });

  it("keeps legacy mode explicit and origin-independent", () => {
    const config = runtimeAuthConfigFromEnv({ NODE_ENV: "test", SUCCESSOR_CONTROL_PLANE_MODE: "legacy" });
    expect(config.mode).toBe("legacy");
    expect(config.origin).toBeUndefined();
    expect(originMatches(undefined, undefined)).toBe(true);
  });
});
