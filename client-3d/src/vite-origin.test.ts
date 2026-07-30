import { describe, expect, it } from "vitest";
import { validateSocketOrigin, validateStorefrontOrigin } from "../vite.config";

describe("validateStorefrontOrigin", () => {
  it.each([undefined, "", "http://storefront.example", "https://storefront.example/path", "https://storefront.example?x=1", "https://*.example"]) ("rejects %s in hosted-release", (origin) => {
    expect(() => validateStorefrontOrigin(origin, "hosted-release")).toThrow();
  });
  it("accepts one exact HTTPS origin", () => {
    expect(validateStorefrontOrigin("https://storefront.example", "hosted-release")).toBe("https://storefront.example");
  });
  it("keeps non-hosted behavior", () => {
    expect(validateStorefrontOrigin(undefined, "development")).toBe("");
  });
});


describe("validateSocketOrigin", () => {
  it.each([undefined, "", "https://world.example", "ws://world.example", "wss://world.example/path", "wss://world.example?x=1", "wss://*.example"]) ("rejects %s in hosted-release", (origin) => {
    expect(() => validateSocketOrigin(origin, "SUCCESSOR_GAME_ORIGIN", "hosted-release")).toThrow();
  });
  it("accepts one exact WSS origin", () => {
    expect(validateSocketOrigin("wss://world.example", "SUCCESSOR_GAME_ORIGIN", "hosted-release")).toBe("wss://world.example");
  });
  it("keeps non-hosted behavior", () => {
    expect(validateSocketOrigin(undefined, "SUCCESSOR_GAME_ORIGIN", "development")).toBe("");
  });
});
