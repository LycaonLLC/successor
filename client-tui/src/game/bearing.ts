import { northUpScreenVectorFromWorld } from "@successor/client/src/slice-core/geometry";

/**
 * Bearings, bands, grid refs — the spatial vocabulary of the MUD voice.
 *
 * Compass canon uses the raw north-up world basis shared with the 3D radar:
 * east is +x, north is -y. Input helpers map those winds to world-cardinal
 * WASD without any camera-relative rotation.
 */

export const RADAR_RADIUS_CELLS = 96;


export interface CompassVector {
  east: number;
  north: number;
}

export function worldCompassVector(dx: number, dy: number): CompassVector {
  const projected = northUpScreenVectorFromWorld(dx, dy);
  return { east: projected.x, north: -projected.y };
}

export type Wind = "north" | "north-east" | "east" | "south-east" | "south" | "south-west" | "west" | "north-west";

const WINDS: readonly Wind[] = ["north", "north-east", "east", "south-east", "south", "south-west", "west", "north-west"];
const WIND_SHORT: Record<Wind, string> = {
  north: "N",
  "north-east": "NE",
  east: "E",
  "south-east": "SE",
  south: "S",
  "south-west": "SW",
  west: "W",
  "north-west": "NW",
};

/** 8-wind compass for a world-space delta (player → subject). */
export function windFor(dx: number, dy: number): Wind {
  const { east, north } = worldCompassVector(dx, dy);
  const angle = Math.atan2(east, north); // 0 = north, +cw
  const index = Math.round(angle / (Math.PI / 4)) & 7;
  return WINDS[index < 0 ? index + 8 : index]!;
}

export function windShort(wind: Wind): string {
  return WIND_SHORT[wind];
}

export type DistanceBand = "beside" | "close" | "near" | "stretch" | "far" | "edge" | "beyond";

/** Distance bands over world-cell range; the radar radius is the horizon. */
export function bandFor(dCells: number): DistanceBand {
  if (dCells < 2) return "beside";
  if (dCells < 8) return "close";
  if (dCells < 20) return "near";
  if (dCells < 40) return "stretch";
  if (dCells < 80) return "far";
  if (dCells <= RADAR_RADIUS_CELLS) return "edge";
  return "beyond";
}

/** Band → prose fragment, composed after a subject: "…, close to the north". */
export const BAND_PHRASE: Record<DistanceBand, string> = {
  beside: "at your side",
  close: "close",
  near: "near",
  stretch: "a stretch off",
  far: "far off",
  edge: "at the edge of your scope",
  beyond: "beyond your scope",
};

/** "close to the north-east" / "at your side" (beside drops the wind). */
export function bearingPhrase(dx: number, dy: number): string {
  const d = Math.hypot(dx, dy);
  const band = bandFor(d);
  if (band === "beside") return BAND_PHRASE.beside;
  return `${BAND_PHRASE[band]} to the ${windFor(dx, dy)}`;
}

/** Terse pane form: "NE 34c". */
export function bearingShort(dx: number, dy: number): string {
  return `${WIND_SHORT[windFor(dx, dy)]} ${Math.round(Math.hypot(dx, dy))}c`;
}

/**
 * Player-facing north-up grid ref centered on the map middle exactly like the
 * 3D radar.
 */
export function gridRef(px: number, py: number, widthCells: number, heightCells: number): string {
  const projected = northUpScreenVectorFromWorld(px - widthCells / 2, py - heightCells / 2);
  const east = Math.round(projected.x);
  const north = Math.round(-projected.y);
  return `E ${east} · N ${north}`;
}

/**
 * Movement keys for a world compass wind: W=north, A=west, S=south, D=east.
 */
export function keysForWind(wind: Wind): readonly string[] {
  switch (wind) {
    case "north": return ["KeyW"];
    case "south": return ["KeyS"];
    case "east": return ["KeyD"];
    case "west": return ["KeyA"];
    case "north-east": return ["KeyW", "KeyD"];
    case "north-west": return ["KeyW", "KeyA"];
    case "south-east": return ["KeyS", "KeyD"];
    case "south-west": return ["KeyS", "KeyA"];
  }
}

export function parseWind(token: string): Wind | null {
  const t = token.trim().toLowerCase();
  const long = WINDS.find((wind) => wind === t || wind.replace("-", "") === t);
  if (long) return long;
  const short = (Object.entries(WIND_SHORT) as Array<[Wind, string]>).find(([, s]) => s.toLowerCase() === t);
  return short?.[0] ?? null;
}
