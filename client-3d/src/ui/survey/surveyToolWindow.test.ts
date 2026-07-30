// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import {
  createSurveyToolWindowDefinition,
  surveyScreenPointFromWorld,
  surveyWorldPointFromScreen,
  type SurveyMapProjection,
} from "../windows/defs/surveyToolWindow";
import type { WindowContext } from "../windows/windowManager";
import type { PlayState, SliceSnapshot } from "@successor/client/src/slice-core/gameState";
import { createAuthorityCommandQueue } from "@successor/client/src/slice-core/authorityCommandSystem";

const projection: SurveyMapProjection = {
  playerX: 40,
  playerY: -12,
  centerX: 320,
  centerY: 240,
  scale: 8,
};

describe("Survey map north-up projection", () => {
  it("projects raw N/S/E/W up/down/right/left from the player marker", () => {
    const marker = surveyScreenPointFromWorld(projection, projection.playerX, projection.playerY);
    const north = surveyScreenPointFromWorld(projection, projection.playerX, projection.playerY - 1);
    const south = surveyScreenPointFromWorld(projection, projection.playerX, projection.playerY + 1);
    const east = surveyScreenPointFromWorld(projection, projection.playerX + 1, projection.playerY);
    const west = surveyScreenPointFromWorld(projection, projection.playerX - 1, projection.playerY);

    expect(marker).toEqual({ x: projection.centerX, y: projection.centerY });
    expect(north).toEqual({ x: marker.x, y: marker.y - projection.scale });
    expect(south).toEqual({ x: marker.x, y: marker.y + projection.scale });
    expect(east).toEqual({ x: marker.x + projection.scale, y: marker.y });
    expect(west).toEqual({ x: marker.x - projection.scale, y: marker.y });
  });

  it("round-trips cursor screen pixels back to raw world points", () => {
    for (const world of [
      { x: 40, y: -12 },
      { x: 51.25, y: -4.5 },
      { x: 21.75, y: -19.125 },
    ]) {
      const screen = surveyScreenPointFromWorld(projection, world.x, world.y);
      const roundTrip = surveyWorldPointFromScreen(projection, screen.x, screen.y);
      expect(roundTrip.x).toBeCloseTo(world.x);
      expect(roundTrip.y).toBeCloseTo(world.y);
    }
  });

  it("uses the same projected point for peak, disc center, and heat sample", () => {
    const rawTarget = { x: 47.5, y: -6.25 };
    const peak = surveyScreenPointFromWorld(projection, rawTarget.x, rawTarget.y);
    const discCenter = surveyScreenPointFromWorld(projection, rawTarget.x, rawTarget.y);
    const heatSample = surveyScreenPointFromWorld(projection, rawTarget.x, rawTarget.y);

    expect(discCenter).toEqual(peak);
    expect(heatSample).toEqual(peak);
    const roundTrip = surveyWorldPointFromScreen(projection, peak.x, peak.y);
    expect(roundTrip.x).toBeCloseTo(rawTarget.x);
    expect(roundTrip.y).toBeCloseTo(rawTarget.y);
  });
});

describe("Survey tool window DOM and status behavior", () => {
  it("mounts and asserts the status node has correct aria attributes and updates without focus theft", () => {
    const mockState = {
      playerActorId: "player-1",
      activeAreaId: "area-1",
      facing: "front",
      player: { x: 10, y: 20 },
      serverAuthority: {
        playerActorId: "player-1",
        lastReceipt: null,
        sentCommandLog: [],
        resourceSpawns: [],
        actors: {},
      },
      inventory: [],
      authorityCommands: createAuthorityCommandQueue(),
      loadout: {
        activeWeaponId: null,
      },
    } as unknown as PlayState;

    const mockSlice = {
      tickRateHz: 30,
      tick: 100,
    } as unknown as SliceSnapshot;

    const ctx: WindowContext = {
      state: mockState,
      slice: mockSlice,
    };

    const def = createSurveyToolWindowDefinition({});
    const contentRoot = document.createElement("div");
    document.body.appendChild(contentRoot);

    const handle = def.mount(contentRoot, ctx);

    const statusEl = contentRoot.querySelector('[data-ref="status"]');
    expect(statusEl).not.toBeNull();
    expect(statusEl!.getAttribute("role")).toBe("status");
    expect(statusEl!.getAttribute("aria-live")).toBe("polite");
    expect(statusEl!.getAttribute("aria-atomic")).toBe("true");
    expect(statusEl!.textContent).toBe("");

    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();
    expect(document.activeElement).toBe(input);

    handle.update(0.1, 100);

    expect(statusEl!.textContent).toBe("HAND SAMPLE READY · TOOL SURVEY REQUIRES CRAFTSMAN + MATCHING TOOL");
    const sampleButton = contentRoot.querySelector('[data-ref="sampleBtn"]') as HTMLButtonElement;
    expect(sampleButton.disabled).toBe(false);
    expect((contentRoot.querySelector('[data-ref="surveyBtn"]') as HTMLButtonElement).disabled).toBe(true);
    sampleButton.click();
    expect(mockState.authorityCommands.pending.at(-1)?.command).toEqual({
      SampleResource: { family: "metal" },
    });
    expect(document.activeElement).toBe(input);
    expect(statusEl!.textContent).toBe("SAMPLING — HOLD POSITION");
    statusEl!.removeAttribute("data-flash");

    mockState.inventory = [{
      container: "player-1:backpack",
      item: "mineral_survey_tool",
      itemId: 3008,
      variantId: 0,
      quantity: 1,
      reserved: 0,
      available: 1,
    }];
    handle.update(0.1, 110);
    expect(statusEl!.textContent).toBe("HAND SAMPLE READY · TOOL SURVEY REQUIRES CRAFTSMAN");
    expect((contentRoot.querySelector('[data-ref="surveyBtn"]') as HTMLButtonElement).disabled).toBe(true);

    mockState.serverAuthority.actors["player-1"] = {
      professions: [{
        id: "craftsman",
        label: "Craftsman",
        xp: 0,
        skillPoints: 16,
        skillBoxes: ["craftsman-novice"],
      }],
    } as unknown as PlayState["serverAuthority"]["actors"][string];
    handle.update(0.1, 120);
    expect(statusEl!.textContent).toBe("HAND SAMPLE READY · CRAFTSMAN SURVEY READY");
    expect((contentRoot.querySelector('[data-ref="surveyBtn"]') as HTMLButtonElement).disabled).toBe(false);

    handle.dispose();
    contentRoot.remove();
    input.remove();
  });
});
