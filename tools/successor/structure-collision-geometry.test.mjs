import assert from "node:assert";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test, describe } from "node:test";
import { fileURLToPath } from "node:url";

import {
  transformStructureCollision,
  stablePlacedCollisionBounds,
  deriveStructureDoorPoints,
  assertCardinalRotation,
  structurePointIsClear,
  STRUCTURE_PLAYER_RADIUS_MILLI,
} from "./structure-collision-geometry.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");
const openDesertSlicePath = path.join(repoRoot, "client", "public", "successor-slice", "open-desert-slice.json");

function circlePathIntersectsBox(start, end, radiusMilli, box) {
  const boxMaxX = box.xMilli + box.wMilli;
  const boxMaxY = box.yMilli + box.hMilli;
  const pathMinX = Math.min(start.xMilli, end.xMilli);
  const pathMaxX = Math.max(start.xMilli, end.xMilli);
  const pathMinY = Math.min(start.yMilli, end.yMilli);
  const pathMaxY = Math.max(start.yMilli, end.yMilli);
  const dx = intervalDistance(pathMinX, pathMaxX, box.xMilli, boxMaxX);
  const dy = intervalDistance(pathMinY, pathMaxY, box.yMilli, boxMaxY);
  return dx * dx + dy * dy <= radiusMilli * radiusMilli;
}

function intervalDistance(minA, maxA, minB, maxB) {
  if (maxA < minB) return minB - maxA;
  if (maxB < minA) return minA - maxB;
  return 0;
}

const mockSidecar = {
  schema: "successor.structure-collision.v2",
  footprint: {
    minX: -2,
    minZ: -2,
    maxX: 2,
    maxZ: 2,
    spanX: 4,
    spanZ: 4,
    centerX: 0,
    centerZ: 0
  },
  walls: [
    // Wall on the left (asymmetric)
    {
      minX: -2,
      minZ: -2,
      maxX: -1.5,
      maxZ: 1
    },
    // Back wall
    {
      minX: -1.5,
      minZ: -2,
      maxX: 2,
      maxZ: -1.5
    },
    // Wall on the right
    {
      minX: 1.5,
      minZ: -1.5,
      maxX: 2,
      maxZ: 2
    }
  ],
  door: {
    closed: {
      minX: -1.5,
      minZ: 1.8,
      maxX: 1.5,
      maxZ: 2
    }
  },
  interiorRegions: [{
    id: "main",
    minX: -1.4,
    minZ: -1.4,
    maxX: 1.4,
    maxZ: 1.4,
    floorTopY: 0.02,
  }]
};

describe("structure-collision-geometry", () => {
  const cellSize = { w: 6, h: 6 };

  test("stable placed proxy emits deterministic post-rotation milli AABBs", () => {
    const footprint = { minX: -2, minZ: -1, maxX: 2, maxZ: 1, centerX: 0, centerZ: 0 };
    const boxes = [{ id: "counter:proxy", minX: -1.5, minZ: -0.25, maxX: 1.5, maxZ: 0.25 }];
    const first = stablePlacedCollisionBounds({ boxes, footprint, cellSize: { w: 6, h: 3 }, rotation: 90 });
    const second = stablePlacedCollisionBounds({ boxes, footprint, cellSize: { w: 6, h: 3 }, rotation: 90 });
    assert.deepStrictEqual(first, second);
    assert.deepStrictEqual(first[0], { id: "counter:proxy", xMilli: 2813, yMilli: 375, wMilli: 375, hMilli: 2250 });
  });

  test("stable placed proxy rejects malformed or out-of-footprint bounds", () => {
    const footprint = { minX: -1, minZ: -1, maxX: 1, maxZ: 1, centerX: 0, centerZ: 0 };
    assert.throws(() => stablePlacedCollisionBounds({
      boxes: [{ minX: -2, minZ: 0, maxX: 0, maxZ: 1 }],
      footprint,
      cellSize,
    }), /lies outside the footprint/);
    assert.throws(() => stablePlacedCollisionBounds({
      boxes: [{ minX: 0, minZ: 0, maxX: 0, maxZ: 1 }],
      footprint,
      cellSize,
    }), /positive finite XZ box/);
  });

  test("structure furniture proxies transform with rotation and fail closed", () => {
    const sidecar = {
      ...mockSidecar,
      furniture: [{ id: "counter_a", minX: -1, minZ: -0.5, maxX: 1, maxZ: 0.5 }],
    };
    for (const rotation of [0, 90, 180, 270]) {
      const result = transformStructureCollision(sidecar, cellSize, rotation);
      assert.equal(result.furniture.length, 1);
      assert.equal(result.furniture[0].id, "counter_a");
      assert.ok(result.furniture[0].wMilli > 0 && result.furniture[0].hMilli > 0);
    }
    assert.throws(() => transformStructureCollision({
      ...mockSidecar,
      furniture: [{ id: "bad", minX: -3, minZ: 0, maxX: 0, maxZ: 1 }],
    }, cellSize), /furniture 0.*outside the footprint/);
  });

  test("0° compatibility: default rotation matches explicit 0°", () => {
    const resultDefault = transformStructureCollision(mockSidecar, cellSize);
    const resultExplicit0 = transformStructureCollision(mockSidecar, cellSize, 0);
    assert.deepStrictEqual(resultDefault, resultExplicit0);
  });

  test("asymmetric wall + door at 0/90/180/270", () => {
    for (const rotation of [0, 90, 180, 270]) {
      const { walls, door } = transformStructureCollision(mockSidecar, cellSize, rotation);
      assert.ok(walls.length > 0, `walls should exist at rotation ${rotation}`);
      assert.ok(door, `door should exist at rotation ${rotation}`);

      // Derive door points should succeed for all cardinal rotations
      const points = deriveStructureDoorPoints({ walls, door, cellSize });
      assert.ok(points.interior, `interior point should be derived at rotation ${rotation}`);
      assert.ok(points.exterior, `exterior point should be derived at rotation ${rotation}`);
    }
  });

  test("4 rotations round-trip within 1 millicell", () => {
    // Assert that rotating preserves box dimensions (width and height switch/rotate correctly)
    const res0 = transformStructureCollision(mockSidecar, cellSize, 0);
    const res90 = transformStructureCollision(mockSidecar, cellSize, 90);
    const res180 = transformStructureCollision(mockSidecar, cellSize, 180);
    const res270 = transformStructureCollision(mockSidecar, cellSize, 270);

    // Wall 0 (the asymmetric left wall)
    // res0: xMilli=0, wMilli=750, yMilli=0, hMilli=4500 (since maxZ was 1, so rotatedZ span is 3. 3 * 1.5 * 1000 = 4500)
    // res90: rotated 90 degrees, should map to yMilli=0, hMilli=750, xMilli=1500, wMilli=4500 (check exact coords)
    // Let's assert that the dimensions round-trip (e.g. width/height swap and match)
    assert.strictEqual(res0.walls[0].wMilli, res90.walls[0].hMilli);
    assert.strictEqual(res0.walls[0].hMilli, res90.walls[0].wMilli);
    assert.strictEqual(res0.walls[0].wMilli, res180.walls[0].wMilli);
    assert.strictEqual(res0.walls[0].hMilli, res180.walls[0].hMilli);
    assert.strictEqual(res90.walls[0].wMilli, res270.walls[0].wMilli);
    assert.strictEqual(res90.walls[0].hMilli, res270.walls[0].hMilli);

    // Door blocker
    assert.strictEqual(res0.door.wMilli, res90.door.hMilli);
    assert.strictEqual(res0.door.hMilli, res90.door.wMilli);
  });

  test("door alignment: interior and exterior points align with door center", () => {
    for (const rotation of [0, 90, 180, 270]) {
      const { walls, door } = transformStructureCollision(mockSidecar, cellSize, rotation);
      const points = deriveStructureDoorPoints({ walls, door, cellSize });

      if (points.normalAxis === "y") {
        // Tangent is X. Interior/exterior X coordinates must align with doorCenter.xMilli
        assert.strictEqual(points.interior.xMilli, points.doorCenter.xMilli);

        assert.strictEqual(points.exterior.xMilli, points.doorCenter.xMilli);
      } else {
        // Tangent is Y. Interior/exterior Y coordinates must align with doorCenter.yMilli
        assert.strictEqual(points.interior.yMilli, points.doorCenter.yMilli);
        assert.strictEqual(points.exterior.yMilli, points.doorCenter.yMilli);
      }
    }
  });

  test("explicit interior regions transform with cardinal yaw and scaled floor", () => {
    for (const rotation of [0, 90, 180, 270]) {
      const result = transformStructureCollision(mockSidecar, cellSize, rotation);
      assert.equal(result.interiorRegions.length, 1);
      assert.equal(result.interiorRegions[0].id, "main");
      assert.equal(result.interiorRegions[0].floorTopM, 0.03);
      assert.ok(result.interiorRegions[0].wMilli > 0);
      assert.ok(result.interiorRegions[0].hMilli > 0);
    }
  });

  test("actual cloning facility proxy is structural, open at portal, and safe", () => {
    const sidecarPath = path.join(repoRoot, "client-3d", "public", "assets", "world-items", "cloning_facility_collision.json");
    const sidecar = JSON.parse(readFileSync(sidecarPath, "utf8"));
    assert.equal(sidecar.schema, "successor.structure-collision.v3");
    assert.equal(sidecar.walls.length, 9, "expected nine named structural wall proxies");
    assert.ok(sidecar.walls.length < 98);
    assert.equal(sidecar.interiorRegions.length, 1);
    assert.equal(sidecar.floor.topY, 0.02);
    const result = transformStructureCollision(sidecar, { w: 10, h: 8 }, 0);
    assert.ok(result.floorTopM > 0.021 && result.floorTopM < 0.022);
    assert.ok(result.interiorRegions[0].floorTopM > 0.021 && result.interiorRegions[0].floorTopM < 0.022);
    const points = deriveStructureDoorPoints({ walls: result.walls, door: result.door, cellSize: { w: 10, h: 8 } });
    assert.ok(result.door.wMilli >= 900, `door width ${result.door.wMilli} is below safe diameter`);
    assert.equal(structurePointIsClear(points.interior, result.walls, result.door), true);
    assert.equal(structurePointIsClear(points.exterior, result.walls, result.door), true);
    const leftPocketPoint = { xMilli: 2_200, yMilli: 7_700 };
    const leftPocketBlocker = result.walls.find((box) => (
      circlePathIntersectsBox(
        leftPocketPoint,
        leftPocketPoint,
        STRUCTURE_PLAYER_RADIUS_MILLI,
        box,
      )
    ));
    assert.ok(leftPocketBlocker, "visible left pocket wall must block actor occupancy");
    assert.equal(leftPocketBlocker.id, "entry_bay_front_left");
    for (const rotation of [0, 90, 180, 270]) {
      const rotated = transformStructureCollision(sidecar, { w: 10, h: 8 }, rotation);
      assert.equal(rotated.interiorRegions.length, 1);
      assert.equal(rotated.walls.length, 9);
      assert.doesNotThrow(() => deriveStructureDoorPoints({ walls: rotated.walls, door: rotated.door, cellSize: { w: 10, h: 8 } }));
    }
  });

  test("arbitrary 45° rejection", () => {
    // 45 degrees should throw error
    assert.throws(() => {
      transformStructureCollision(mockSidecar, cellSize, 45);
    }, /must be exactly 0, 90, 180, or 270 degrees/);

    // assertCardinalRotation directly
    assert.throws(() => {
      assertCardinalRotation(45);
    }, /must be exactly 0, 90, 180, or 270 degrees/);
    assert.throws(() => {
      assertCardinalRotation(30);
    }, /must be exactly 0, 90, 180, or 270 degrees/);

    // Valid ones should not throw
    assert.doesNotThrow(() => assertCardinalRotation(0));
    assert.doesNotThrow(() => assertCardinalRotation(90));
    assert.doesNotThrow(() => assertCardinalRotation(180));
    assert.doesNotThrow(() => assertCardinalRotation(270));
  });

  test("center-relative layout at 512/1024", () => {
    // Test with cell size 512x1024
    const largeCellSize = { w: 512, h: 1024 };

    // Let's have a centered GLB box
    const centeredSidecar = {
      schema: "successor.structure-collision.v2",
      footprint: {
        minX: -1,
        minZ: -1,
        maxX: 1,
        maxZ: 1,
        spanX: 2,
        spanZ: 2,
        centerX: 0,
        centerZ: 0
      },
      walls: [
        {
          minX: -0.5,
          minZ: -0.5,
          maxX: 0.5,
          maxZ: 0.5
        }
      ]
    };

    const { walls } = transformStructureCollision(centeredSidecar, largeCellSize, 0);
    assert.strictEqual(walls.length, 1);

    // Centered wall should have its center at (512 / 2 * 1000, 1024 / 2 * 1000)
    const expectedCenterX = (largeCellSize.w / 2) * 1000;
    const expectedCenterY = (largeCellSize.h / 2) * 1000;

    const wallCenter = {
      x: walls[0].xMilli + walls[0].wMilli / 2,
      y: walls[0].yMilli + walls[0].hMilli / 2
    };

    assert.strictEqual(wallCenter.x, expectedCenterX);
    assert.strictEqual(wallCenter.y, expectedCenterY);
  });

  test("Open Desert default player and travel spawn clear immediate W and D routes around the closed shelter", () => {
    const slice = JSON.parse(readFileSync(openDesertSlicePath, "utf8"));
    const player = slice.actors?.find((actor) => actor.id === "player");
    const shelter = slice.props?.find((prop) => prop.id === "open-desert-shelter-house");
    const travelPlanet = slice.travelCatalog?.planets?.find((planet) => planet.areaId === player?.areaId);
    const travelSpawn = travelPlanet?.cities?.find((city) => city.id === "dustgate")?.spawn;

    assert.ok(player, "Open Desert fixture must contain the player actor");
    assert.ok(shelter, "Open Desert fixture must contain open-desert-shelter-house");
    assert.deepStrictEqual(shelter.cell, { x: 509, y: 508 }, "Shelter House must be anchored at the Open Desert spawn-safe coordinates (509, 508)");
    assert.deepStrictEqual(player.cell, { x: 512, y: 513 }, "Default player spawn must be (512, 513)");
    assert.deepStrictEqual(travelSpawn, { x: 512, y: 513 }, "Dustgate travel spawn must be (512, 513)");
    assert.ok(Array.isArray(shelter.collisionBounds) && shelter.collisionBounds.length > 0, "Shelter House must retain mesh-derived collisionBounds");
    assert.ok(shelter.door?.blocker, "Shelter House must retain its closed-door blocker");

    const blockers = [
      ...shelter.collisionBounds.map((bounds, index) => ({ ...bounds, label: `collisionBounds[${index}]` })),
      { ...shelter.door.blocker, label: "door.blocker" },
    ];
    const start = { xMilli: player.cell.x * 1000, yMilli: player.cell.y * 1000 };
    for (const { label, dx, dy } of [
      { label: "W", dx: 0, dy: -1 },
      { label: "D", dx: 1, dy: 0 },
    ]) {
      const end = { xMilli: start.xMilli + dx * 1000, yMilli: start.yMilli + dy * 1000 };
      const blocker = blockers.find((candidate) => circlePathIntersectsBox(start, end, STRUCTURE_PLAYER_RADIUS_MILLI, candidate));
      assert.strictEqual(
        blocker,
        undefined,
        `Default ${label} route from (${player.cell.x}, ${player.cell.y}) to (${end.xMilli / 1000}, ${end.yMilli / 1000}) must clear ${STRUCTURE_PLAYER_RADIUS_MILLI} milli circle radius; blocked by ${blocker?.label ?? "unknown blocker"}`,
      );
    }
  });

  test("geometry-only house probe test (runs child process)", () => {
    const probePath = path.join(repoRoot, "tools/game-lab/house-collision-probe.mjs");
    const run = spawnSync("node", [probePath, "--geometry-only"], { encoding: "utf8" });

    assert.strictEqual(run.status, 0, `probe script should exit with status 0. Stderr: ${run.stderr}`);

    const parsed = JSON.parse(run.stdout);
    assert.strictEqual(parsed.ok, true, "probe stdout ok field should be true");
    assert.ok(parsed.probe, "probe stdout should contain probe data");
    assert.ok(parsed.probe.exterior, "probe data should have exterior point");
    assert.ok(parsed.probe.interior, "probe data should have interior point");
    assert.strictEqual(parsed.probe.outwardSign, 1, "probe data outwardSign should match expected");
  });
});
