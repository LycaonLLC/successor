import { describe, expect, it } from "vitest";

import { createArmedConfirm } from "./armedConfirm";

describe("armed confirm", () => {
  it("arms once, confirms inside the ttl, and consumes", () => {
    const confirm = createArmedConfirm();
    expect(confirm.arm("packup:rig-1", 10_000, 1_000)).toBe(true);   // armed
    expect(confirm.arm("packup:rig-1", 10_000, 2_000)).toBe(false);  // already armed → caller confirms
    expect(confirm.confirm("packup:rig-1", 3_000)).toBe(true);       // consumed
    expect(confirm.confirm("packup:rig-1", 3_100)).toBe(false);      // one-shot
  });

  it("expires on TTL", () => {
    const confirm = createArmedConfirm();
    confirm.arm("packup:rig-1", 10_000, 1_000);
    expect(confirm.armedKey(12_000)).toBeNull();
    expect(confirm.arm("packup:rig-1", 10_000, 12_000)).toBe(true); // re-arms fresh
  });

  it("a different key re-arms instead of confirming; disarm clears", () => {
    const confirm = createArmedConfirm();
    confirm.arm("packup:rig-1", 10_000, 1_000);
    expect(confirm.arm("packup:rig-2", 10_000, 2_000)).toBe(true);
    expect(confirm.confirm("packup:rig-1", 2_500)).toBe(false);
    confirm.disarm();
    expect(confirm.armedKey(2_600)).toBeNull();
  });
});
