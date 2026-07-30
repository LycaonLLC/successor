export type CardinalDirection = "front" | "right" | "back" | "left";
export type Direction = CardinalDirection | "front_left" | "front_right" | "back_left" | "back_right";

export interface Point {
  x: number;
  y: number;
}

/**
 * Canonical north-up presentation boundary.
 *
 * Authority/world coordinates are already screen-cardinal: +x is east/right,
 * -y is north/up, +y is south/down, and -x is west/left. Maps, radars, survey
 * tools, and terminal bearings must preserve this basis without a camera- or
 * view-relative rotation.
 */
export function northUpScreenVectorFromWorld(x: number, y: number): Point {
  return { x, y };
}

/** Inverse of northUpScreenVectorFromWorld. */
export function worldVectorFromNorthUpScreen(x: number, y: number): Point {
  return { x, y };
}

export interface Cell {
  x: number;
  y: number;
}

export interface CellSize {
  w: number;
  h: number;
}

export const cardinalDirections: CardinalDirection[] = ["front", "right", "back", "left"];
export const directions: Direction[] = [
  "front",
  "front_right",
  "right",
  "back_right",
  "back",
  "back_left",
  "left",
  "front_left",
];

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function angleForDirection(direction: Direction): number {
  switch (direction) {
    case "right":
      return 0;
    case "front_right":
      return Math.PI / 4;
    case "front":
      return Math.PI / 2;
    case "front_left":
      return (Math.PI * 3) / 4;
    case "left":
      return Math.PI;
    case "back_left":
      return (-Math.PI * 3) / 4;
    case "back":
      return -Math.PI / 2;
    case "back_right":
      return -Math.PI / 4;
  }
}

export function isMovementKey(code: string): boolean {
  return (
    code === "KeyW" ||
    code === "KeyA" ||
    code === "KeyS" ||
    code === "KeyD" ||
    code === "ArrowUp" ||
    code === "ArrowLeft" ||
    code === "ArrowDown" ||
    code === "ArrowRight"
  );
}

export function movementKeyVector(code: string): Point {
  if (code === "KeyA" || code === "ArrowLeft") return { x: -1, y: 0 };
  if (code === "KeyD" || code === "ArrowRight") return { x: 1, y: 0 };
  if (code === "KeyW" || code === "ArrowUp") return { x: 0, y: -1 };
  if (code === "KeyS" || code === "ArrowDown") return { x: 0, y: 1 };
  return { x: 0, y: 0 };
}

export function movementKeyDirection(code: string): Direction {
  if (code === "KeyA" || code === "ArrowLeft") return "left";
  if (code === "KeyD" || code === "ArrowRight") return "right";
  if (code === "KeyW" || code === "ArrowUp") return "back";
  return "front";
}

export function normalizeDirection(direction: string): Direction {
  if (
    direction === "front" ||
    direction === "right" ||
    direction === "back" ||
    direction === "left" ||
    direction === "front_left" ||
    direction === "front_right" ||
    direction === "back_left" ||
    direction === "back_right"
  ) {
    return direction;
  }
  if (direction === "down") return "front";
  if (direction === "up") return "back";
  if (direction === "left_down" || direction === "down_left") return "front_left";
  if (direction === "right_down" || direction === "down_right") return "front_right";
  if (direction === "left_up" || direction === "up_left") return "back_left";
  if (direction === "right_up" || direction === "up_right") return "back_right";
  return "front";
}

export function directionFromVector(x: number, y: number, fallback: Direction = "front"): Direction {
  if (!Number.isFinite(x) || !Number.isFinite(y) || Math.hypot(x, y) < 0.001) return fallback;
  const angle = Math.atan2(y, x);
  const eighth = Math.PI / 8;
  if (angle >= -eighth && angle < eighth) return "right";
  if (angle >= eighth && angle < 3 * eighth) return "front_right";
  if (angle >= 3 * eighth && angle < 5 * eighth) return "front";
  if (angle >= 5 * eighth && angle < 7 * eighth) return "front_left";
  if (angle >= 7 * eighth || angle < -7 * eighth) return "left";
  if (angle >= -7 * eighth && angle < -5 * eighth) return "back_left";
  if (angle >= -5 * eighth && angle < -3 * eighth) return "back";
  return "back_right";
}

export function cardinalDirectionForVisualDirection(direction: Direction): CardinalDirection {
  switch (direction) {
    case "front_left":
    case "front_right":
      return "front";
    case "back_left":
    case "back_right":
      return "back";
    default:
      return direction;
  }
}

export function cellKey(cell: Cell): string {
  return `${cell.x},${cell.y}`;
}
