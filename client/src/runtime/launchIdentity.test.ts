import { afterEach, describe, expect, it, vi } from "vitest";
import { getLaunchIdentity } from "./launchIdentity";

function launchFrom(search: string, selectedCharacter?: { id?: string; name?: string }) {
  vi.stubGlobal("window", {
    location: { search },
    __successorSelectedCharacter: selectedCharacter,
  } as unknown as Window & typeof globalThis);
  return getLaunchIdentity();
}

describe("getLaunchIdentity", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("keeps account ownership separate from the URL-selected character", () => {
    expect(launchFrom("?player=Profile:Tenant-9&characterId=Char_Grug&name=Grug")).toMatchObject({
      ownerRef: "Profile:Tenant-9",
      playerId: "char_grug",
      characterId: "char_grug",
      displayName: "Grug",
    });
  });

  it("gives the in-page character selection precedence over URL identity", () => {
    expect(launchFrom(
      "?player=local&characterId=char_stale&name=Owner",
      { id: "char_current", name: "Current" },
    )).toMatchObject({
      ownerRef: "local",
      playerId: "char_current",
      characterId: "char_current",
      displayName: "Current",
    });
  });

  it("preserves the server's full 64-byte character-id boundary", () => {
    const characterId = `char_${"a".repeat(59)}`;
    expect(launchFrom(`?player=local&characterId=${characterId}`).characterId).toBe(characterId);
  });

  it("does not invent a character identity from an empty URL value", () => {
    expect(launchFrom("?player=local&characterId=%20%20")).toMatchObject({
      ownerRef: "local",
      playerId: "local",
      characterId: undefined,
    });
  });
});
