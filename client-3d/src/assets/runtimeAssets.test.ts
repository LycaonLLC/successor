import { describe, expect, it } from "vitest";
import { isProductionAssetManifestCompatible } from "./runtimeAssets";

const fixture = "planetfall-v5-seed-424242-size-1024-rogues-18-desert-critters-48-verdance-critters-24-areas-open-desert-overworld-verdance-forest-overworld";
const contentHash = "a".repeat(64);
const releaseId = `${fixture}@${contentHash.slice(0, 16)}`;

function manifest(overrides: Record<string, unknown> = {}) {
  return {
    schema: "successor-production-assets/v1",
    fixture: { identity: fixture },
    contentHash,
    releaseId,
    ...overrides,
  } as never;
}

describe("production asset manifest compatibility", () => {
  it("accepts the immutable long asset identity independently of the protocol client identity", () => {
    expect(isProductionAssetManifestCompatible(manifest(), { stateHash: fixture }, contentHash, releaseId)).toBe(true);
    expect(isProductionAssetManifestCompatible(manifest(), { stateHash: fixture }, contentHash, "successor-alpha@aaaaaaaaaaaaaaaa")).toBe(false);
  });

  it("rejects stale or tampered identities", () => {
    expect(isProductionAssetManifestCompatible(manifest({ contentHash: "b".repeat(64) }), { stateHash: fixture }, contentHash, releaseId)).toBe(false);
    expect(isProductionAssetManifestCompatible(manifest({ releaseId: `${fixture}@${"b".repeat(16)}` }), { stateHash: fixture }, contentHash, releaseId)).toBe(false);
    expect(isProductionAssetManifestCompatible(manifest(), { stateHash: "other-fixture" }, contentHash, releaseId)).toBe(false);
  });
});
