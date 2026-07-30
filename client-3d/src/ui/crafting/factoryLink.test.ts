import { beforeEach, describe, expect, it } from "vitest";
import type { PlayState, SliceSnapshot } from "@successor/client/src/slice-core/gameState";
import {
  activeFactory,
  consumeFactorySchematicsOpenRequest,
  requestFactorySchematicsOpen,
  resetFactoryLinkForTests,
  resolveFactorySession,
  setActiveFactory,
  setFactorySchematicsOpenListener,
  withinFactoryRange,
} from "./factoryLink";

function makeState(x = 494.5, y = 508.5): PlayState {
  return {
    playerActorId: "player",
    activeAreaId: "open-desert-overworld",
    player: { x, y },
    serverAuthority: {
      playerActorId: "player",
      actors: {
        player: { id: "player", areaId: "open-desert-overworld", x, y },
      },
    },
  } as unknown as PlayState;
}

function makeSlice(): SliceSnapshot {
  return {
    props: [
      {
        id: "dustgate-occupation-workbench",
        areaId: "open-desert-overworld",
        kind: "factory",
        interactive: true,
        cell: { x: 494, y: 508 },
        size: { w: 2, h: 1 },
      },
    ],
  } as unknown as SliceSnapshot;
}

describe("factoryLink", () => {
  beforeEach(() => {
    resetFactoryLinkForTests();
  });

  it("binds and opens schematics immediately when datapad listener is already mounted", () => {
    const opens: string[] = [];
    setFactorySchematicsOpenListener(() => opens.push("schematics"));
    setActiveFactory("dustgate-occupation-workbench");
    requestFactorySchematicsOpen();
    expect(activeFactory()).toBe("dustgate-occupation-workbench");
    expect(opens).toEqual(["schematics"]);
    expect(consumeFactorySchematicsOpenRequest()).toBe(false);
  });

  it("defers schematics open until first lazy datapad mount consumes the request", () => {
    setActiveFactory("dustgate-occupation-workbench");
    requestFactorySchematicsOpen();
    expect(consumeFactorySchematicsOpenRequest()).toBe(true);
    expect(consumeFactorySchematicsOpenRequest()).toBe(false);
  });

  it("clears stale factory binding when the player leaves station range", () => {
    const slice = makeSlice();
    setActiveFactory("dustgate-occupation-workbench");
    const near = makeState(494.5, 508.5);
    expect(withinFactoryRange(near, slice, "dustgate-occupation-workbench")).toBe(true);
    expect(resolveFactorySession(near, slice)).toEqual({
      factoryId: "dustgate-occupation-workbench",
      inReach: true,
    });
    const far = makeState(10, 10);
    expect(withinFactoryRange(far, slice, "dustgate-occupation-workbench")).toBe(false);
    expect(resolveFactorySession(far, slice)).toEqual({
      factoryId: null,
      inReach: false,
    });
    expect(activeFactory()).toBeNull();
  });
});
