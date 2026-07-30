import { describe, expect, it } from "vitest";
import { enterableFloorYAt } from "./props";
import type { EnterableInteriorBounds, PropSnapshot } from "@successor/client/src/slice-core/worldTypes";

const FLOOR_Y = 0.14736842105263157;
const FACILITY_FLOOR_Y = 0.02105263157894737;

function prop(rotation: 0 | 90 | 180 | 270, interiorBounds?: EnterableInteriorBounds[]): PropSnapshot {
  return {
    id: "facility",
    entity: "prop:facility",
    areaId: "desert",
    label: "Facility",
    kind: "building",
    assetKey: "cloning_facility",
    cell: { x: 10, y: 20 },
    size: { w: 10, h: 8 },
    rotation,
    interactive: false,
    enterable: { floorHeightM: FLOOR_Y, ...(interiorBounds ? { interiorBounds } : {}) },
    visible: true,
  };
}

describe("enterable floor lookup — legacy footprint fallback", () => {
  // The 10x8 prop occupies world x in [10, 20], z in [20, 28] at EVERY
  // cardinal rotation (composePlacement always fits the rotated asset into
  // the same footprint) — the fallback must agree for q0-q3.
  it("q0: keeps the authored 10x8 floor exact at zero rotation", () => {
    expect(enterableFloorYAt([prop(0)], "desert", 15, 24)).toBe(FLOOR_Y);
    expect(enterableFloorYAt([prop(0)], "desert", 20.1, 24)).toBe(0);
  });

  it("q1 (90): rectangular footprint containment matches the world footprint", () => {
    expect(enterableFloorYAt([prop(90)], "desert", 14, 25)).toBe(FLOOR_Y);
    expect(enterableFloorYAt([prop(90)], "desert", 10, 20)).toBe(FLOOR_Y);
    // Regression: the old inverse transform compared the swapped local point
    // against the UNSWAPPED (w, h) rectangle and accepted z=29 (> 28).
    expect(enterableFloorYAt([prop(90)], "desert", 15, 29)).toBe(0);
    expect(enterableFloorYAt([prop(90)], "desert", 15, 31.1)).toBe(0);
  });

  it("q2 (180): containment matches the world footprint", () => {
    expect(enterableFloorYAt([prop(180)], "desert", 15, 24)).toBe(FLOOR_Y);
    expect(enterableFloorYAt([prop(180)], "desert", 9.9, 24)).toBe(0);
  });

  it("q3 (270): rectangular footprint containment matches the world footprint", () => {
    expect(enterableFloorYAt([prop(270)], "desert", 14, 25)).toBe(FLOOR_Y);
    expect(enterableFloorYAt([prop(270)], "desert", 15, 29)).toBe(0);
    expect(enterableFloorYAt([prop(270)], "desert", 21, 24)).toBe(0);
  });

  it("ignores hidden props", () => {
    const hidden = { ...prop(0), visible: false, enterable: { floorHeightM: 4 } };
    expect(enterableFloorYAt([hidden], "desert", 15, 24)).toBe(0);
  });

  it("keeps two enterable house instances independent", () => {
    const first = prop(0);
    const second = { ...prop(0), id: "house-2", cell: { x: 40, y: 40 }, enterable: { floorHeightM: 0.75 } };
    expect(enterableFloorYAt([first, second], "desert", 15, 24)).toBe(FLOOR_Y);
    expect(enterableFloorYAt([first, second], "desert", 45, 44)).toBe(0.75);
  });
});

describe("enterable floor lookup — explicit interiorBounds", () => {
  // Contract: interiorBounds are POST-ROTATION prop-local milli AABBs.
  // local = (world - prop.cell) * 1000, with no second yaw — a rotated prop
  // must not re-rotate its already-rotated bounds.
  const bounds: EnterableInteriorBounds[] = [
    { id: "main-room", xMilli: 1000, yMilli: 1000, wMilli: 8000, hMilli: 6000 },
  ];

  it("uses explicit bounds instead of the footprint", () => {
    const facility = { ...prop(0, bounds), enterable: { floorHeightM: FACILITY_FLOOR_Y, interiorBounds: bounds } };
    // Inside the region.
    expect(enterableFloorYAt([facility], "desert", 14.5, 24.5)).toBe(FACILITY_FLOOR_Y);
    // Inside the footprint but OUTSIDE the explicit region (wall band).
    expect(enterableFloorYAt([facility], "desert", 10.5, 20.5)).toBe(0);
  });

  it("applies no second yaw on a rotated prop (bounds are post-rotation)", () => {
    const rotated = { ...prop(270), enterable: { floorHeightM: FACILITY_FLOOR_Y, interiorBounds: bounds } };
    expect(enterableFloorYAt([rotated], "desert", 14.5, 24.5)).toBe(FACILITY_FLOOR_Y);
    expect(enterableFloorYAt([rotated], "desert", 10.5, 20.5)).toBe(0);
  });

  it("falls back to the footprint when interiorBounds is empty", () => {
    const empty = { ...prop(0), enterable: { floorHeightM: FLOOR_Y, interiorBounds: [] } };
    expect(enterableFloorYAt([empty], "desert", 10.5, 20.5)).toBe(FLOOR_Y);
  });
});

describe("enterable floor lookup — center-based pawn grounding", () => {
  it("resolves at the rendered center, not the authority anchor corner", () => {
    // Authority anchor just outside the footprint; the rendered/physical
    // ground center (anchor +0.5/+0.5) is inside. Pawn grounding queries the
    // CENTER — querying the anchor (the old `x - 0.5` bug) buries the feet.
    const anchorX = 9.7;
    const anchorZ = 24;
    expect(enterableFloorYAt([prop(0)], "desert", anchorX + 0.5, anchorZ + 0.5)).toBe(FLOOR_Y);
    expect(enterableFloorYAt([prop(0)], "desert", anchorX, anchorZ)).toBe(0);
  });
});
