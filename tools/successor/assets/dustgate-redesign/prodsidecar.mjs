#!/usr/bin/env node
/**
 * Run the repository's OWN structure-collision transformer over the three
 * production sidecars.
 *
 *     node tools/successor/assets/dustgate-redesign/prodsidecar.mjs
 *
 * The Blender build already asserts its own geometry, but that is the authoring
 * side marking its own homework. This drives the exact module the fixture
 * generator uses (`tools/successor/structure-collision-geometry.mjs`) against
 * the emitted `successor.structure-collision.v3` files, at every cardinal
 * rotation, and re-derives the door approach points the fixture would bake.
 *
 * It writes nothing into the fixture, the runtime, or `client-3d/`. Report goes
 * to the git-ignored production artifact root.
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  STRUCTURE_PLAYER_RADIUS_MILLI,
  deriveStructureDoorPoints,
  structurePointIsClear,
  transformStructureCollision,
} from "../../structure-collision-geometry.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../../../..");
const ROOT = resolve(
  REPO,
  "verification/ledgers/artifacts/dustgate-opus5-production-20260729",
);

const UNITS = [
  { uid: "clone", cellSize: { w: 12, h: 10 } },
  { uid: "commerce", cellSize: { w: 14, h: 11 } },
  { uid: "shelter", cellSize: { w: 8, h: 7 } },
];

const ROTATIONS = [0, 90, 180, 270];

/** Zero-tolerance overlap between a promised whole cell and any blocker. */
function promisedCellsClear(collision, promised) {
  const failures = [];
  const blockers = [...collision.walls, ...collision.furniture, collision.door].filter(Boolean);
  for (const [id, cell] of Object.entries(promised ?? {})) {
    if (!Array.isArray(cell) || cell.length !== 2 || !cell.every(Number.isInteger)) {
      failures.push(`${id}: malformed cell ${JSON.stringify(cell)}`);
      continue;
    }
    const [col, row] = cell;
    const rect = { minX: col * 1000, maxX: (col + 1) * 1000, minY: row * 1000, maxY: (row + 1) * 1000 };
    const overlap = blockers.find(
      (box) =>
        Math.min(box.xMilli + box.wMilli, rect.maxX) > Math.max(box.xMilli, rect.minX) &&
        Math.min(box.yMilli + box.hMilli, rect.maxY) > Math.max(box.yMilli, rect.minY),
    );
    if (overlap) failures.push(`${id}: blocker ${overlap.id ?? "unnamed"} overlaps cell ${col},${row}`);
  }
  return failures;
}

/** Every baked box must be integral and inside the prop rect (Rust clamps silently otherwise). */
function bakedBoxesLegal(collision, cellSize) {
  const failures = [];
  const all = [...collision.walls, ...collision.furniture, ...(collision.door ? [collision.door] : [])];
  for (const box of all) {
    const values = [box.xMilli, box.yMilli, box.wMilli, box.hMilli];
    if (!values.every(Number.isInteger)) failures.push(`${box.id ?? "unnamed"}: non-integer milli`);
    if (!(box.xMilli >= 0 && box.yMilli >= 0)) failures.push(`${box.id ?? "unnamed"}: negative origin`);
    if (!(box.wMilli > 0 && box.hMilli > 0)) failures.push(`${box.id ?? "unnamed"}: non-positive extent`);
    if (box.xMilli + box.wMilli > cellSize.w * 1000) failures.push(`${box.id ?? "unnamed"}: overruns prop width`);
    if (box.yMilli + box.hMilli > cellSize.h * 1000) failures.push(`${box.id ?? "unnamed"}: overruns prop height`);
  }
  return failures;
}

const report = { generatedBy: "tools/successor/assets/dustgate-redesign/prodsidecar.mjs", units: {} };
const failures = [];

for (const { uid, cellSize } of UNITS) {
  const path = resolve(ROOT, `manifests/${uid}_collision.json`);
  const sidecar = JSON.parse(readFileSync(path, "utf8"));
  const entry = { sidecar: path, schema: sidecar.schema, cellSize, rotations: {} };

  if (sidecar.schema !== "successor.structure-collision.v3") {
    failures.push(`${uid}: schema is ${sidecar.schema}`);
  }
  const swapped = { w: cellSize.h, h: cellSize.w };

  for (const rotation of ROTATIONS) {
    const size = rotation === 90 || rotation === 270 ? swapped : cellSize;
    let collision;
    try {
      collision = transformStructureCollision(sidecar, size, rotation);
    } catch (error) {
      failures.push(`${uid} @${rotation}: transform threw: ${error.message}`);
      continue;
    }
    const legal = bakedBoxesLegal(collision, size);
    legal.forEach((message) => failures.push(`${uid} @${rotation}: ${message}`));

    let doorPoints = null;
    try {
      doorPoints = deriveStructureDoorPoints({ walls: collision.walls, door: collision.door, cellSize: size });
    } catch (error) {
      failures.push(`${uid} @${rotation}: door points threw: ${error.message}`);
    }

    let interiorClear = null;
    let exteriorClear = null;
    if (doorPoints) {
      interiorClear = structurePointIsClear(doorPoints.interior, collision.walls, collision.door, STRUCTURE_PLAYER_RADIUS_MILLI);
      exteriorClear = structurePointIsClear(doorPoints.exterior, collision.walls, collision.door, STRUCTURE_PLAYER_RADIUS_MILLI);
      if (!interiorClear) failures.push(`${uid} @${rotation}: derived interior door point is blocked`);
      if (!exteriorClear) failures.push(`${uid} @${rotation}: derived exterior door point is blocked`);
      if (!(collision.door.wMilli >= 900 || collision.door.hMilli >= 900)) {
        failures.push(`${uid} @${rotation}: doorway narrower than the 900 milli safe diameter`);
      }
    }

    if (rotation === 0) {
      promisedCellsClear(collision, sidecar.contract?.terminal_cells_kept_clear).forEach((message) =>
        failures.push(`${uid} @0: ${message}`),
      );
    }

    entry.rotations[rotation] = {
      walls: collision.walls.length,
      furniture: collision.furniture.length,
      interiorRegions: collision.interiorRegions.length,
      floorTopM: collision.floorTopM,
      door: collision.door,
      doorPoints,
      interiorClear,
      exteriorClear,
    };
  }

  const zero = entry.rotations[0];
  if (zero) {
    const counts = ROTATIONS.map((r) => entry.rotations[r]?.walls);
    if (new Set(counts).size !== 1) failures.push(`${uid}: wall counts differ across rotations: ${counts}`);
    const regions = ROTATIONS.map((r) => entry.rotations[r]?.interiorRegions);
    if (new Set(regions).size !== 1) failures.push(`${uid}: region counts differ across rotations: ${regions}`);
  }
  report.units[uid] = entry;
}

report.failures = failures;
mkdirSync(resolve(ROOT, "qa"), { recursive: true });
writeFileSync(resolve(ROOT, "qa/sidecar_gate.json"), `${JSON.stringify(report, null, 2)}\n`);

for (const { uid } of UNITS) {
  const entry = report.units[uid];
  const zero = entry?.rotations?.[0];
  if (!zero) continue;
  console.log(
    `${uid.padEnd(9)} walls ${String(zero.walls).padStart(2)}  furniture ${String(zero.furniture).padStart(2)}` +
      `  regions ${zero.interiorRegions}  floorTopM ${zero.floorTopM.toFixed(5)}` +
      `  door ${zero.door.wMilli}x${zero.door.hMilli} milli` +
      `  interior/exterior clear ${zero.interiorClear}/${zero.exteriorClear}`,
  );
}

if (failures.length > 0) {
  console.error(`\n${failures.length} sidecar failure(s):`);
  failures.forEach((message) => console.error(`  ${message}`));
  process.exit(1);
}
console.log("\nall three sidecars transform, bake and derive door points cleanly at 0/90/180/270");
