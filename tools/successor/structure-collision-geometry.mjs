const CARDINAL_ROTATIONS = new Set([0, 90, 180, 270]);

export const STRUCTURE_PLAYER_RADIUS_MILLI = 300;
export const STRUCTURE_SAFE_POINT_PADDING_MILLI = 150;

/**
 * Transform GLB-local structure boxes into prop-local millicell AABBs using
 * the same recenter, cardinal yaw, uniform fit, and placement center as the
 * 3D renderer's composePlacement helper.
 */
/**
 * Transform explicit placed-solid proxy boxes into stable, post-rotation
 * prop-local milli-cell AABBs. Input boxes use the same centred X/Z metres as
 * structure sidecars; output never depends on render meshes or floating point
 * scene state.
 */
export function stablePlacedCollisionBounds({ boxes, footprint, cellSize, rotation = 0 }) {
  assertCardinalRotation(rotation);
  assertCellSize(cellSize);
  assertFootprint(footprint);
  if (!Array.isArray(boxes) || boxes.length === 0) {
    throw new Error("placed collision sidecar must contain at least one box");
  }
  const rotatedFootprint = rotateBounds(footprint, footprint, rotation);
  const rotatedSpanX = rotatedFootprint.maxX - rotatedFootprint.minX;
  const rotatedSpanY = rotatedFootprint.maxY - rotatedFootprint.minY;
  if (!(rotatedSpanX > 0) || !(rotatedSpanY > 0)) {
    throw new Error("placed collision footprint has no positive rotated span");
  }
  const scale = Math.min(cellSize.w / rotatedSpanX, cellSize.h / rotatedSpanY);
  const maxXMilli = cellSize.w * 1000;
  const maxYMilli = cellSize.h * 1000;
  const toLocalMilliX = (value) => Math.round((cellSize.w / 2 + value * scale) * 1000);
  const toLocalMilliY = (value) => Math.round((cellSize.h / 2 + value * scale) * 1000);
  return boxes.map((box, index) => {
    assertRawBox(box, footprint, `placed collision box ${index}`);
    const rotated = rotateBounds(box, footprint, rotation);
    const minX = clamp(toLocalMilliX(rotated.minX), 0, maxXMilli);
    const maxX = clamp(toLocalMilliX(rotated.maxX), 0, maxXMilli);
    const minY = clamp(toLocalMilliY(rotated.minY), 0, maxYMilli);
    const maxY = clamp(toLocalMilliY(rotated.maxY), 0, maxYMilli);
    if (!(maxX > minX) || !(maxY > minY)) {
      throw new Error(`placed collision box ${index} has no transformed area`);
    }
    return {
      ...(box.id === undefined ? {} : { id: box.id }),
      xMilli: minX,
      yMilli: minY,
      wMilli: maxX - minX,
      hMilli: maxY - minY,
    };
  });
}

export function transformStructureCollision(sidecar, cellSize, rotation = 0) {
  const footprint = sidecar?.footprint;
  if (!footprint) throw new Error("structure collision sidecar has no footprint");
  assertFootprint(footprint);
  for (const [index, wall] of (sidecar.walls ?? []).entries()) {
    assertRawBox(wall, footprint, `structure collision wall ${index}`);
  }
  for (const [index, furniture] of (sidecar.furniture ?? []).entries()) {
    assertRawBox(furniture, footprint, `structure collision furniture ${index}`);
  }
  if (sidecar.door?.closed) assertRawBox(sidecar.door.closed, footprint, "structure collision door");
  assertCardinalRotation(rotation);
  assertCellSize(cellSize);

  const rotatedFootprint = rotateBounds(footprint, footprint, rotation);
  const rotatedSpanX = rotatedFootprint.maxX - rotatedFootprint.minX;
  const rotatedSpanY = rotatedFootprint.maxY - rotatedFootprint.minY;
  const scale = Math.min(cellSize.w / rotatedSpanX, cellSize.h / rotatedSpanY);
  const maxXMilli = cellSize.w * 1000;
  const maxYMilli = cellSize.h * 1000;
  const toLocalMilliX = (x) => Math.round((cellSize.w / 2 + x * scale) * 1000);
  const toLocalMilliY = (y) => Math.round((cellSize.h / 2 + y * scale) * 1000);
  const toBox = (box) => {
    const rotated = rotateBounds(box, footprint, rotation);
    const minX = clamp(toLocalMilliX(rotated.minX), 0, maxXMilli);
    const maxX = clamp(toLocalMilliX(rotated.maxX), 0, maxXMilli);
    const minY = clamp(toLocalMilliY(rotated.minY), 0, maxYMilli);
    const maxY = clamp(toLocalMilliY(rotated.maxY), 0, maxYMilli);
    const transformed = {
      xMilli: minX,
      yMilli: minY,
      wMilli: Math.max(0, maxX - minX),
      hMilli: Math.max(0, maxY - minY),
    };
    if (box.id !== undefined) transformed.id = box.id;
    return transformed;
  };

  const walls = (sidecar.walls ?? []).map(toBox).filter(hasArea);
  const door = sidecar.door?.closed ? toBox(sidecar.door.closed) : null;
  const interiorRegions = (sidecar.interiorRegions ?? []).map((region, index) => {
    assertRegion(region, footprint, index);
    const box = toBox(region);
    if (!hasArea(box)) throw new Error(`structure collision interior region ${index} has no transformed area`);
    const authoredFloorTop = region.floorTopY ?? sidecar.floor?.topY;
    if (!Number.isFinite(authoredFloorTop)) throw new Error(`structure collision interior region ${index} has no finite floorTopY`);
    return {
      id: region.id ?? `interior-${index + 1}`,
      ...box,
      floorTopM: authoredFloorTop * scale,
    };
  });
  const furniture = (sidecar.furniture ?? []).map(toBox).filter(hasArea);
  const floorTopM = sidecar.floor?.topY;
  if (floorTopM !== undefined && !Number.isFinite(floorTopM)) {
    throw new Error("structure collision sidecar floor top must be finite");
  }
  return {
    walls,
    door,
    interiorRegions,
    furniture,
    floorTopM: floorTopM === undefined ? undefined : floorTopM * scale,
  };
}

function assertRegion(region, footprint, index) {
  if (!region || ![region.minX, region.minZ, region.maxX, region.maxZ].every(Number.isFinite)
    || !(region.maxX > region.minX) || !(region.maxZ > region.minZ)) {
    throw new Error(`structure collision interior region ${index} is not a positive XZ box`);
  }
  const epsilon = 1e-6;
  if (region.minX < footprint.minX - epsilon || region.maxX > footprint.maxX + epsilon
    || region.minZ < footprint.minZ - epsilon || region.maxZ > footprint.maxZ + epsilon) {
    throw new Error(`structure collision interior region ${index} lies outside the footprint`);
  }
}

/**
 * Derive blocker-clear points on both sides of a structure door. The door's
 * thin axis and its position relative to the prop center establish the outward
 * normal; the nearest wall behind the doorway establishes the usable interior
 * interval. The exterior point is kept beyond the prop footprint so it cannot
 * be classified as sheltered merely because a rotated mesh has fit margins.
 */
export function deriveStructureDoorPoints({
  walls,
  door,
  cellSize,
  playerRadiusMilli = STRUCTURE_PLAYER_RADIUS_MILLI,
  paddingMilli = STRUCTURE_SAFE_POINT_PADDING_MILLI,
}) {
  assertCellSize(cellSize);
  if (!door || !hasArea(door)) throw new Error("structure collision has no positive door blocker");
  if (!Array.isArray(walls) || walls.length === 0) throw new Error("structure collision has no wall blockers");
  if (!(playerRadiusMilli >= 0) || !(paddingMilli >= 0)) throw new Error("structure door clearances must be non-negative");

  const widthMilli = cellSize.w * 1000;
  const heightMilli = cellSize.h * 1000;
  const doorCenter = boxCenter(door);
  const normalAxis = door.wMilli >= door.hMilli ? "y" : "x";
  const tangentAxis = normalAxis === "x" ? "y" : "x";
  const normalExtent = normalAxis === "x" ? widthMilli : heightMilli;
  const propCenterNormal = normalExtent / 2;
  const doorCenterNormal = coordinate(doorCenter, normalAxis);
  const outwardSign = Math.sign(doorCenterNormal - propCenterNormal);
  if (outwardSign === 0) throw new Error("structure door is centered; outward side is ambiguous");

  const safeClearanceMilli = playerRadiusMilli + paddingMilli;
  const tangentSpan = extent(door, tangentAxis);
  if (tangentSpan < safeClearanceMilli * 2) {
    throw new Error(`structure doorway ${tangentSpan} milli is narrower than required safe diameter ${safeClearanceMilli * 2}`);
  }

  const tangentCenter = coordinate(doorCenter, tangentAxis);
  const doorInwardFace = face(door, normalAxis, -outwardSign);
  const corridorWalls = walls.filter((wall) => distanceToInterval(tangentCenter, face(wall, tangentAxis, -1), face(wall, tangentAxis, 1)) <= safeClearanceMilli);
  const inwardWalls = corridorWalls.filter((wall) => {
    const wallFace = face(wall, normalAxis, outwardSign);
    return outwardSign > 0 ? wallFace <= doorInwardFace : wallFace >= doorInwardFace;
  });
  if (inwardWalls.length === 0) throw new Error("structure doorway has no mesh-derived interior wall boundary");
  const interiorWall = inwardWalls.reduce((closest, wall) => {
    const closestFace = face(closest, normalAxis, outwardSign);
    const wallFace = face(wall, normalAxis, outwardSign);
    return outwardSign > 0 ? (wallFace > closestFace ? wall : closest) : (wallFace < closestFace ? wall : closest);
  });
  const interiorWallFace = face(interiorWall, normalAxis, outwardSign);
  const interiorNearWall = interiorWallFace + outwardSign * safeClearanceMilli;
  const interiorNearDoor = doorInwardFace - outwardSign * safeClearanceMilli;
  if ((interiorNearDoor - interiorNearWall) * outwardSign <= 0) {
    throw new Error("structure doorway has no blocker-clear interior interval");
  }

  const interiorNormal = Math.round((interiorNearWall + interiorNearDoor) / 2);
  const exteriorNormal = (outwardSign > 0 ? normalExtent : 0) + outwardSign * safeClearanceMilli;
  const interior = pointOnAxes(normalAxis, interiorNormal, tangentAxis, tangentCenter);
  const exterior = pointOnAxes(normalAxis, exteriorNormal, tangentAxis, tangentCenter);
  const blockers = [...walls, door];
  assertCircleClear("interior", interior, playerRadiusMilli, blockers);
  assertCircleClear("exterior", exterior, playerRadiusMilli, blockers);

  return {
    interior,
    exterior,
    doorCenter: { xMilli: Math.round(doorCenter.x), yMilli: Math.round(doorCenter.y) },
    interiorWall,
    normalAxis,
    tangentAxis,
    outwardSign,
    safeClearanceMilli,
  };
}

export function assertCardinalRotation(rotation) {
  if (!CARDINAL_ROTATIONS.has(rotation)) {
    throw new Error(`structure collision rotation must be exactly 0, 90, 180, or 270 degrees; got ${rotation}`);
  }
}

export function structurePointIsClear(point, walls, door, radiusMilli = STRUCTURE_PLAYER_RADIUS_MILLI) {
  if (walls.some((box) => circleIntersectsBox(point, radiusMilli, box))) return false;
  return !door || !circleIntersectsBox(point, radiusMilli, door);
}

function rotateBounds(box, footprint, rotation) {
  const corners = [
    rotatePoint(box.minX - footprint.centerX, box.minZ - footprint.centerZ, rotation),
    rotatePoint(box.minX - footprint.centerX, box.maxZ - footprint.centerZ, rotation),
    rotatePoint(box.maxX - footprint.centerX, box.minZ - footprint.centerZ, rotation),
    rotatePoint(box.maxX - footprint.centerX, box.maxZ - footprint.centerZ, rotation),
  ];
  return {
    minX: Math.min(...corners.map((point) => point.x)),
    minY: Math.min(...corners.map((point) => point.y)),
    maxX: Math.max(...corners.map((point) => point.x)),
    maxY: Math.max(...corners.map((point) => point.y)),
  };
}

// composePlacement uses yaw = -rotation around Three's +Y axis.
function rotatePoint(x, y, rotation) {
  if (rotation === 0) return { x, y };
  if (rotation === 90) return { x: -y, y: x };
  if (rotation === 180) return { x: -x, y: -y };
  return { x: y, y: -x };
}

function assertCellSize(cellSize) {
  if (!cellSize || !(cellSize.w > 0) || !(cellSize.h > 0)) {
    throw new Error("structure collision cell size must be positive");
  }
}

function hasArea(box) {
  return box.wMilli > 0 && box.hMilli > 0;
}

function boxCenter(box) {
  return { x: box.xMilli + box.wMilli / 2, y: box.yMilli + box.hMilli / 2 };
}

function assertFootprint(footprint) {
  if (!footprint || ![footprint.minX, footprint.minZ, footprint.maxX, footprint.maxZ].every(Number.isFinite)
    || !(footprint.maxX > footprint.minX) || !(footprint.maxZ > footprint.minZ)) {
    throw new Error("structure collision sidecar footprint must be a positive finite XZ box");
  }
}

function assertRawBox(box, footprint, label) {
  if (!box || ![box.minX, box.minZ, box.maxX, box.maxZ].every(Number.isFinite)
    || !(box.maxX > box.minX) || !(box.maxZ > box.minZ)) {
    throw new Error(`${label} must be a positive finite XZ box`);
  }
  const epsilon = 1e-6;
  if (box.minX < footprint.minX - epsilon || box.maxX > footprint.maxX + epsilon
    || box.minZ < footprint.minZ - epsilon || box.maxZ > footprint.maxZ + epsilon) {
    throw new Error(`${label} lies outside the footprint: box=${JSON.stringify(box)} footprint=${JSON.stringify(footprint)}`);
  }
}

function coordinate(point, axis) {
  return axis === "x" ? point.x : point.y;
}

function extent(box, axis) {
  return axis === "x" ? box.wMilli : box.hMilli;
}

function face(box, axis, sign) {
  const min = axis === "x" ? box.xMilli : box.yMilli;
  const size = extent(box, axis);
  return sign < 0 ? min : min + size;
}

function pointOnAxes(normalAxis, normal, tangentAxis, tangent) {
  const point = { xMilli: 0, yMilli: 0 };
  point[normalAxis === "x" ? "xMilli" : "yMilli"] = Math.round(normal);
  point[tangentAxis === "x" ? "xMilli" : "yMilli"] = Math.round(tangent);
  return point;
}

function distanceToInterval(value, min, max) {
  if (value < min) return min - value;
  if (value > max) return value - max;
  return 0;
}

function assertCircleClear(label, point, radius, blockers) {
  const offender = blockers.find((box) => circleIntersectsBox(point, radius, box));
  if (offender) throw new Error(`structure ${label} point intersects blocker ${JSON.stringify(offender)}`);
}

function circleIntersectsBox(point, radius, box) {
  const nearestX = clamp(point.xMilli, box.xMilli, box.xMilli + box.wMilli);
  const nearestY = clamp(point.yMilli, box.yMilli, box.yMilli + box.hMilli);
  const dx = point.xMilli - nearestX;
  const dy = point.yMilli - nearestY;
  return dx * dx + dy * dy <= radius * radius;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}
