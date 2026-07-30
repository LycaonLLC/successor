import { afterEach, describe, expect, it } from "vitest";
import {
  appendCampMovementBlockers,
  campCollisionProfileFromSidecar,
  CAMP_SHELTER_FOOTPRINT_CELLS,
  clearCampDoorState,
  formatAbandonCountdown,
  pointInsideCampShelter,
  pointInsideCampInteractionFootprint,
  registerCampCollisionProfile,
  setCampDoorOpen,
} from "./campSystem";
import type { ServerAuthorityPlacedCampState } from "./gameState";
import type { MovementBlocker } from "./movementSystem";

function camp(overrides: Partial<ServerAuthorityPlacedCampState> = {}): ServerAuthorityPlacedCampState {
  return {
    campId: "camp:player:1",
    areaId: "open-desert-overworld",
    cellX: 10,
    cellY: 6,
    isOwner: true,
    renderKind: "scout-camp",
    ...overrides,
  };
}

afterEach(() => {
  registerCampCollisionProfile("scout-camp", null);
  clearCampDoorState("camp:player:1");
});

describe("campSystem", () => {
  it("translates the pod-tent sidecar with the exact house-pipeline scale math", () => {
    // Real podtent_scout numbers: 2.85 m span into the authority's 5-cell
    // shelter footprint. Renderer and collision consume the same constant.
    const profile = campCollisionProfileFromSidecar({
      footprint: { spanX: 2.85, spanZ: 2.85, centerX: 0, centerZ: 0 },
      walls: [{ minX: -1.425, minZ: -1.425, maxX: 1.425, maxZ: -1.3 }],
      door: { node: "door_slide", closed: { minX: -0.03, minZ: 1.16, maxX: 1.03, maxZ: 1.255 } },
    }, CAMP_SHELTER_FOOTPRINT_CELLS);

    expect(CAMP_SHELTER_FOOTPRINT_CELLS).toBe(5);
    const scale = CAMP_SHELTER_FOOTPRINT_CELLS / 2.85;
    expect(profile.walls).toHaveLength(1);
    expect(profile.walls[0]!.minX).toBeCloseTo(-1.425 * scale, 6);
    expect(profile.walls[0]!.maxY).toBeCloseTo(-1.3 * scale, 6);
    expect(profile.door).not.toBeNull();
    expect(profile.door!.minX).toBeCloseTo(-0.03 * scale, 6);
    expect(profile.door!.maxX).toBeCloseTo(1.03 * scale, 6);
    expect(profile.door!.minY).toBeCloseTo(1.16 * scale, 6);
  });

  it("appends world-translated camp blockers and gates the door on visual state", () => {
    registerCampCollisionProfile("scout-camp", {
      walls: [{ minX: -1, minY: -1, maxX: 1, maxY: -0.8 }],
      door: { minX: -0.5, minY: 0.8, maxX: 0.5, maxY: 1 },
    });
    const camps = [camp()];
    const blockers: MovementBlocker[] = [];

    appendCampMovementBlockers(blockers, camps, "open-desert-overworld");
    // Wall translated to the camp center (10.5, 6.5) + the CLOSED door.
    expect(blockers).toContainEqual({ left: 9.5, top: 5.5, right: 11.5, bottom: 5.7 });
    expect(blockers).toContainEqual({ left: 10, top: 7.3, right: 11, bottom: 7.5 });

    // Door visually open → its blocker drops, walls stay.
    expect(setCampDoorOpen("camp:player:1", true)).toBe(true);
    expect(setCampDoorOpen("camp:player:1", true)).toBe(false); // no change
    blockers.length = 0;
    appendCampMovementBlockers(blockers, camps, "open-desert-overworld");
    expect(blockers).toContainEqual({ left: 9.5, top: 5.5, right: 11.5, bottom: 5.7 });
    expect(blockers).not.toContainEqual({ left: 10, top: 7.3, right: 11, bottom: 7.5 });
  });

  it("contributes no blockers for foreign areas or unregistered render kinds", () => {
    registerCampCollisionProfile("scout-camp", {
      walls: [{ minX: -1, minY: -1, maxX: 1, maxY: -0.8 }],
      door: null,
    });
    const blockers: MovementBlocker[] = [];
    appendCampMovementBlockers(blockers, [camp({ areaId: "elsewhere" })], "open-desert-overworld");
    expect(blockers).toHaveLength(0);
    appendCampMovementBlockers(blockers, [camp({ renderKind: "unknown-kind" })], "open-desert-overworld");
    expect(blockers).toHaveLength(0);
  });

  it("claims SHELTERED only inside the wire-conservative box", () => {
    const camps = [camp()];
    // Camp cell (10,6) → guaranteed box is (10.5, 6.5) ± 2.0 per axis.
    expect(pointInsideCampShelter(camps, "open-desert-overworld", 10.5, 6.5)).toBe(true);
    expect(pointInsideCampShelter(camps, "open-desert-overworld", 12.5, 8.5)).toBe(true);
    // One step past the conservative edge: the sim MIGHT still shelter this
    // (its box is position±2.5) but the client must never over-claim.
    expect(pointInsideCampShelter(camps, "open-desert-overworld", 12.6, 6.5)).toBe(false);
    expect(pointInsideCampShelter(camps, "other-area", 10.5, 6.5)).toBe(false);
  });

  it("matches pack-up to the rendered cell-centered 5×5 footprint", () => {
    const placed = camp();
    expect(pointInsideCampInteractionFootprint(placed, "open-desert-overworld", 13, 9)).toBe(true);
    expect(pointInsideCampInteractionFootprint(placed, "open-desert-overworld", 13.001, 9)).toBe(false);
    expect(pointInsideCampInteractionFootprint(placed, "open-desert-overworld", 8, 4)).toBe(true);
    expect(pointInsideCampInteractionFootprint(placed, "other-area", 10.5, 6.5)).toBe(false);
  });

  it("formats the abandonment countdown as M:SS, floored at zero", () => {
    expect(formatAbandonCountdown(894)).toBe("14:54");
    expect(formatAbandonCountdown(60)).toBe("1:00");
    expect(formatAbandonCountdown(9)).toBe("0:09");
    expect(formatAbandonCountdown(-3)).toBe("0:00");
  });
});
