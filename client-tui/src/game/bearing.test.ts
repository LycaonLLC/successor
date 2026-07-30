import { describe, expect, it } from "vitest";

import { bandFor, bearingPhrase, bearingShort, gridRef, keysForWind, parseWind, windFor, worldCompassVector } from "./bearing";

describe("bearing (radar compass contract)", () => {
  it("preserves raw world deltas in the shared north-up compass", () => {
    expect(worldCompassVector(10, -10)).toEqual({ east: 10, north: 10 });
    expect(worldCompassVector(-7, 0)).toEqual({ east: -7, north: -0 });
  });

  it("names raw authority cardinals without rotation", () => {
    expect(windFor(0, -1)).toBe("north");
    expect(windFor(-1, 0)).toBe("west");
    expect(windFor(0, 1)).toBe("south");
    expect(windFor(1, 0)).toBe("east");
  });

  it("names raw diagonal winds", () => {
    expect(windFor(1, -1)).toBe("north-east");
    expect(windFor(-1, -1)).toBe("north-west");
    expect(windFor(-1, 1)).toBe("south-west");
    expect(windFor(1, 1)).toBe("south-east");
  });

  it("keysForWind maps directly to world-cardinal movement", () => {
    expect(keysForWind("north")).toEqual(["KeyW"]);
    expect(keysForWind("west")).toEqual(["KeyA"]);
    expect(keysForWind("south")).toEqual(["KeyS"]);
    expect(keysForWind("east")).toEqual(["KeyD"]);
    expect(keysForWind("north-east")).toEqual(["KeyW", "KeyD"]);
    expect(keysForWind("south-west")).toEqual(["KeyS", "KeyA"]);
    expect(parseWind("ne")).toBe("north-east");
    expect(parseWind("northeast")).toBe("north-east");
    expect(parseWind("bogus")).toBeNull();
  });

  it("grid ref matches the radar's raw north-up centering", () => {
    expect(gridRef(80, 80, 160, 160)).toBe("E 0 · N 0");
    expect(gridRef(90, 70, 160, 160)).toBe("E 10 · N 10");
  });

  it("bands the horizon honestly against the 96c scope", () => {
    expect(bandFor(1)).toBe("beside");
    expect(bandFor(7.9)).toBe("close");
    expect(bandFor(19)).toBe("near");
    expect(bandFor(39)).toBe("stretch");
    expect(bandFor(79)).toBe("far");
    expect(bandFor(96)).toBe("edge");
    expect(bandFor(97)).toBe("beyond");
  });

  it("composes bearing phrases and terse pane forms", () => {
    expect(bearingPhrase(0.5, 0.5)).toBe("at your side");
    expect(bearingPhrase(0, -30)).toBe("a stretch off to the north");
    expect(bearingShort(0, -30)).toBe("N 30c");
  });
});
