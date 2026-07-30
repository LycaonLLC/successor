import { describe, expect, it } from "vitest";
import { authorityActorHasSkillBox, authorityActorLinkDead, authorityProfessionTrackXp, authorityProfessionXp, syncAuthorityActorKeys } from "./authorityActorProbe";

describe("authority actor verification projection", () => {
  it("reuses sorted storage and omits absent entries", () => {
    const target = ["stale", "stale-2"];
    syncAuthorityActorKeys(target, { zed: { linkDead: false }, absent: undefined, alpha: { linkDead: true } });
    expect(target).toEqual(["alpha", "zed"]);
  });

  it("projects exact link-dead truth without substituting another actor", () => {
    const actors = { alpha: { linkDead: true }, zed: { linkDead: false } };
    expect(authorityActorLinkDead(actors, "alpha")).toBe(true);
    expect(authorityActorLinkDead(actors, "zed")).toBe(false);
    expect(authorityActorLinkDead(actors, "missing")).toBeNull();
  });

  it("projects exact authority profession XP and learned skill boxes", () => {
    const actors = { alpha: { professions: [{ id: "craftsman", xp: 135, trackXp: { survey: 135 }, skillBoxes: ["craftsman-assembly-i"] }] } };
    expect(authorityProfessionXp(actors, "alpha", "craftsman")).toBe(135);
    expect(authorityProfessionTrackXp(actors, "alpha", "craftsman", "survey")).toBe(135);
    expect(authorityProfessionTrackXp(actors, "alpha", "craftsman", "assembly")).toBe(0);
    expect(authorityProfessionXp(actors, "alpha", "scout")).toBeNull();
    expect(authorityActorHasSkillBox(actors, "alpha", "craftsman-assembly-i")).toBe(true);
    expect(authorityActorHasSkillBox(actors, "alpha", "missing")).toBe(false);
    expect(authorityActorHasSkillBox(actors, "missing", "craftsman-assembly-i")).toBeNull();
  });
});
