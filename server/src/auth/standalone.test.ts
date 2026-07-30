import { describe, expect, it } from "vitest";
import { standaloneIdentity } from "./standalone.js";
import type { CharacterRecord } from "../game/characterStore.js";

const launch = {
  launchId: "launch-1",
  accountId: "account-1",
  ownerRef: "owner-1",
  characterId: "char-1",
  shardId: "open-desert",
  clientReleaseId: "client-1",
  serverReleaseId: "server-1",
  issuer: "successor-server",
  purpose: "game" as const,
};

function character(worldEntryClaimed: boolean): CharacterRecord {
  return {
    id: "char-1",
    ownerRef: "owner-1",
    name: "Atlas",
    appearance: { skinTone: "#c78f62", hair: "hair_mop", hairMat: "hair_raven", face: null },
    worn: [{ item: "under_bodysuit", colors: ["#89cff0"] }],
    wornColors: { under_bodysuit: ["#89cff0"] },
    position: { areaId: "waterworks", x: 4, y: 5, facing: "right" },
    vitals: { health: 90, action: 80, spirit: 70 },
    initialProfessionId: "scout",
    professions: { skillBoxes: ["scout-novice"], credits: 5000 },
    activeTitleId: "scout-novice",
    careerGoalId: "trailblazer",
    recordKinds: {},
    worldEntryClaimed,
    createdAt: "2026-01-01T00:00:00.000Z",
    lastSeenAt: "2026-01-01T00:00:00.000Z",
    lastLogoutAt: null,
    totalPlayMs: 0,
  };
}

describe("standalone launch identity hydration", () => {
  it("hydrates exact creator seed and returning marker without creating a character", () => {
    const first = standaloneIdentity(launch, character(false));
    expect(first).toMatchObject({
      accountId: "account-1",
      ownerRef: "owner-1",
      characterId: "char-1",
      returningCharacter: false,
      appearance: { skin: "#c78f62", hair: "hair_mop", hair_mat: "hair_raven" },
      worn: [{ item: "under_bodysuit", colors: ["#89cff0"] }],
      professionIds: ["scout"],
      skillBoxIds: ["scout-novice"],
      credits: 5000,
      vitals: { health: 90, action: 80, spirit: 70 },
      activeTitleId: "scout-novice",
      careerGoalId: "trailblazer",
      spawn: { areaId: "waterworks", x: 4, y: 5, facing: "right" },
    });
    expect(standaloneIdentity(launch, character(true)).returningCharacter).toBe(true);
  });
});
