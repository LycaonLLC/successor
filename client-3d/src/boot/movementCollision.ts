import type { Point } from "@successor/client/src/slice-core/geometry";
import type { WorldFloraCollider } from "../render/flora/scatter";

/**
 * Client-side world collision as OCTANT SELECTION (Planetfall, owner-blessed
 * client-only). The move wire is integer 8-way (`dx/dy = Math.sign(...)`), so
 * fractional "slide" vectors cannot reach the server — instead we pick the
 * nearest of {desired, ±45°, ±90°} whose short probe path clears every
 * collider, and return that EXACT 8-way unit vector. Prediction and the
 * scheduled Move command both read the same vector, so client and server walk
 * the identical octant: no divergence, no rubber-banding — the pawn walks
 * around a titan the same 8-way way it walks everywhere else.
 *
 * Accuracy lives in the probe: sub-cell circle/segment distance against the
 * authored trunk radii. Cheaters who strip the clamp walk through trees; the
 * sim doesn't care (collision is OFF server-side by fixture ruling).
 */

const PAWN_RADIUS_CELLS = 0.38;
const PROBE_CELLS = 1.05;
/** Octant turn preference: straight, then the gentler turns, then 90°. */
const OCTANT_TRIES = [0, 1, -1, 2, -2] as const;
const SQRT1_2 = Math.SQRT1_2;

/** The 8 move octants (unit length), indexed by angle/45°. */
const OCTANTS: readonly Point[] = [
  { x: 1, y: 0 },
  { x: SQRT1_2, y: SQRT1_2 },
  { x: 0, y: 1 },
  { x: -SQRT1_2, y: SQRT1_2 },
  { x: -1, y: 0 },
  { x: -SQRT1_2, y: -SQRT1_2 },
  { x: 0, y: -1 },
  { x: SQRT1_2, y: -SQRT1_2 },
] as const;

const ZERO: Point = { x: 0, y: 0 };

let lastZeroClampMs = Number.NEGATIVE_INFINITY;

/**
 * True while the collision clamp recently zeroed movement (pawn pressing
 * into a trunk). The movement flight recorder consults this so intentional
 * blocking never files an "intent-no-motion" anomaly.
 */
export function movementClampZeroedRecently(nowMs: number): boolean {
  return nowMs - lastZeroClampMs < 400;
}

export function clampMovementOctant(
  px: number,
  pz: number,
  vector: Point,
  colliders: readonly WorldFloraCollider[],
  colliderCount: number,
): Point {
  if (colliderCount === 0 || (vector.x === 0 && vector.y === 0)) return vector;
  const desired = Math.round(Math.atan2(vector.y, vector.x) / (Math.PI / 4));
  for (const turn of OCTANT_TRIES) {
    const octant = OCTANTS[(((desired + turn) % 8) + 8) % 8]!;
    if (pathClear(px, pz, octant, colliders, colliderCount)) return octant;
  }
  lastZeroClampMs = performance.now();
  return ZERO;
}

function pathClear(
  px: number,
  pz: number,
  octant: Point,
  colliders: readonly WorldFloraCollider[],
  colliderCount: number,
): boolean {
  const tipX = px + octant.x * PROBE_CELLS;
  const tipZ = pz + octant.y * PROBE_CELLS;
  for (let i = 0; i < colliderCount; i += 1) {
    const collider = colliders[i]!;
    let tipSq: number;
    let hereSq: number;
    if (collider.kind === "circle") {
      tipSq = distSqToPoint(tipX, tipZ, collider.x, collider.z);
      hereSq = distSqToPoint(px, pz, collider.x, collider.z);
    } else {
      tipSq = distSqToSegment(tipX, tipZ, collider.ax, collider.az, collider.bx, collider.bz);
      hereSq = distSqToSegment(px, pz, collider.ax, collider.az, collider.bx, collider.bz);
    }
    const range = collider.r + PAWN_RADIUS_CELLS;
    // Block only when the step ENDS inside AND does not move us farther out —
    // a pawn that finds itself overlapping (chunk stream-in, ack snap) can
    // always walk its way free instead of freezing forever.
    if (tipSq < range * range && tipSq <= hereSq) return false;
  }
  return true;
}

function distSqToPoint(x: number, z: number, cx: number, cz: number): number {
  const dx = x - cx;
  const dz = z - cz;
  return dx * dx + dz * dz;
}

function distSqToSegment(x: number, z: number, ax: number, az: number, bx: number, bz: number): number {
  const abx = bx - ax;
  const abz = bz - az;
  const lengthSq = abx * abx + abz * abz;
  const t = lengthSq > 0 ? Math.max(0, Math.min(1, ((x - ax) * abx + (z - az) * abz) / lengthSq)) : 0;
  const dx = x - (ax + abx * t);
  const dz = z - (az + abz * t);
  return dx * dx + dz * dz;
}
