import { describe, expect, it } from "vitest";

import { windowOpenSetStorageKey } from "./windowManager";

describe("windowOpenSetStorageKey", () => {
  it("partitions persisted window state by character", () => {
    expect(windowOpenSetStorageKey("char-alpha")).toBe("successor3d.windows.open.v1.char-alpha");
    expect(windowOpenSetStorageKey("char-beta")).not.toBe(windowOpenSetStorageKey("char-alpha"));
  });

  it("encodes storage scopes that contain key separators", () => {
    expect(windowOpenSetStorageKey("profile/character one")).toBe(
      "successor3d.windows.open.v1.profile%2Fcharacter%20one",
    );
  });
});
