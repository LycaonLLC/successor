import { describe, expect, it } from "vitest";
import type {
  PlayState,
  ServerAuthorityActorState,
  SliceSnapshot,
} from "../gameState";
import { skillNodeDefinitions } from "../progressionSystem";
import {
  nextTrainableBoxes,
  visibleTeachListFor,
  type DialogueCtx,
} from "./dialogueTree";

function dialogueContext(
  professionXp: number,
  trackXp: number | undefined,
  skillBoxes = ["marksman-novice"],
): DialogueCtx {
  const actor = {
    id: "player",
    professions: [{
      id: "marksman",
      label: "Marksman",
      xp: professionXp,
      trackXp: trackXp === undefined ? undefined : { rifle: trackXp },
      skillPoints: 16,
      skillBoxes,
    }],
    skillPointsUsed: 16,
    skillPointsCap: 250,
    credits: 0,
  } as unknown as ServerAuthorityActorState;
  const state = {
    playerActorId: "player",
    serverAuthority: {
      playerActorId: "player",
      actors: { player: actor },
    },
  } as unknown as PlayState;
  return {
    state,
    slice: {} as SliceSnapshot,
    npc: {
      actorId: "trainer",
      label: "Trainer",
      professionIds: ["marksman"],
      distanceCells: 1,
      inRange: true,
    },
    isCarriedContainer: () => false,
  };
}

describe("dialogue trainer XP eligibility", () => {
  it("uses the minimum of general and track XP for tracked boxes", () => {
    const generalShort = nextTrainableBoxes(dialogueContext(50, 150), "marksman")[0]!;
    const trackShort = nextTrainableBoxes(dialogueContext(150, 50), "marksman")[0]!;
    const funded = nextTrainableBoxes(dialogueContext(150, 150), "marksman")[0]!;

    expect(generalShort.node.id).toBe("marksman-rifle-i");
    expect(generalShort.canTrain).toBe(false);
    expect(generalShort.reason).toBe("Needs 50 more XP");
    expect(trackShort.canTrain).toBe(false);
    expect(trackShort.reason).toBe("Needs 50 more XP");
    expect(funded.canTrain).toBe(true);
    expect(funded.reason).toBe(null);
  });

  it("fails closed when a tracked XP pool is absent", () => {
    const missingTrack = nextTrainableBoxes(dialogueContext(150, undefined), "marksman")[0]!;

    expect(missingTrack.node.id).toBe("marksman-rifle-i");
    expect(missingTrack.canTrain).toBe(false);
    expect(missingTrack.reason).toBe("Needs 100 more XP");
  });

  it("hides XP-short trainer choices while leaving funded choices visible", () => {
    const short = visibleTeachListFor(dialogueContext(50, 50));
    expect(short).toEqual([]);

    const funded = visibleTeachListFor(dialogueContext(150, 150));
    expect(funded.map((entry) => entry.node.id)).toEqual(["marksman-rifle-i"]);
  });

  it("keeps master boxes on general profession XP rather than a track pool", () => {
    const trainedTracks = skillNodeDefinitions
      .filter((node) => node.profession === "marksman" && node.track !== "novice" && node.track !== "master")
      .map((node) => node.id);
    const master = nextTrainableBoxes(
      dialogueContext(1_800, undefined, ["marksman-novice", ...trainedTracks]),
      "marksman",
    )[0]!;

    expect(master.node.id).toBe("marksman-master");
    expect(master.canTrain).toBe(true);
    expect(master.reason).toBe(null);
  });
});
