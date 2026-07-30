#!/usr/bin/env node

import fs from "node:fs";

export const SCHEMA = "successor.building-geometry-diagnostic.v1";
export const TOLERANCES = Object.freeze({
  floorSurfaceMeters: 0.002,
  rootFloorMeters: 0.002,
  bodyFloorMeters: 0.02,
  shadowClearanceMeters: 0.03,
});

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function firstDefined(object, ...keys) {
  for (const key of keys) {
    if (object?.[key] !== undefined) return object[key];
  }
  return undefined;
}

function normalizeMilliAabb(raw) {
  if (!raw || typeof raw !== "object") return null;
  const xMilli = firstDefined(raw, "xMilli", "x_milli", "left");
  const yMilli = firstDefined(raw, "yMilli", "y_milli", "top");
  const width = firstDefined(raw, "wMilli", "w_milli");
  const height = firstDefined(raw, "hMilli", "h_milli");
  const wMilli = isFiniteNumber(width) ? width : raw.right - xMilli;
  const hMilli = isFiniteNumber(height) ? height : raw.bottom - yMilli;
  if (![xMilli, yMilli, wMilli, hMilli].every(isFiniteNumber)) return null;
  if (wMilli <= 0 || hMilli <= 0) return null;
  return {
    xMilli,
    yMilli,
    wMilli,
    hMilli,
    ...(typeof raw.id === "string" ? { id: raw.id } : {}),
    ...(typeof raw.open === "boolean" ? { open: raw.open } : {}),
  };
}

function normalizeWorldBox3(raw) {
  if (!raw || typeof raw !== "object" || !raw.min || !raw.max) return null;
  const values = [raw.min.x, raw.min.y, raw.min.z, raw.max.x, raw.max.y, raw.max.z];
  if (!values.every(isFiniteNumber)) return null;
  if (raw.min.x > raw.max.x || raw.min.y > raw.max.y || raw.min.z > raw.max.z) return null;
  return {
    min: { x: raw.min.x, y: raw.min.y, z: raw.min.z },
    max: { x: raw.max.x, y: raw.max.y, z: raw.max.z },
  };
}

function translateLocalAabb(local, cell) {
  return {
    ...local,
    xMilli: local.xMilli + cell.x * 1000,
    yMilli: local.yMilli + cell.y * 1000,
  };
}

function sameGeometry(left, right) {
  return ["xMilli", "yMilli", "wMilli", "hMilli"]
    .every((key) => left[key] === right[key]);
}

function compareGeometrySets(expected, actual) {
  const unmatchedActual = [...actual];
  const missing = [];
  const matches = [];
  for (const expectedBox of expected) {
    const matchIndex = unmatchedActual.findIndex((actualBox) => {
      if (!sameGeometry(expectedBox, actualBox)) return false;
      if (expectedBox.id && actualBox.id) return expectedBox.id === actualBox.id;
      return true;
    });
    if (matchIndex < 0) {
      missing.push(expectedBox);
      continue;
    }
    const [actualBox] = unmatchedActual.splice(matchIndex, 1);
    matches.push({
      primitiveId: expectedBox.id ?? actualBox.id ?? null,
      expected: expectedBox,
      actual: actualBox,
    });
  }
  return { matches, missing, extra: unmatchedActual };
}

function authorityStateRoot(raw) {
  return raw?.rustAuthority?.state?.state
    ?? raw?.state?.state
    ?? raw?.state
    ?? raw
    ?? {};
}

function authorityRecords(raw, propId, fieldName) {
  if (raw === undefined || raw === null) return null;
  const root = authorityStateRoot(raw);
  const snakeName = fieldName.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
  const records = root[fieldName] ?? root[snakeName];
  if (!Array.isArray(records)) return [];
  return records.flatMap((record) => {
    if (!record || typeof record !== "object" || Array.isArray(record)) {
      return [{ malformed: true }];
    }
    const recordPropId = record.propId ?? record.prop_id;
    if (typeof recordPropId !== "string") return [{ malformed: true }];
    return recordPropId === propId ? [record] : [];
  });
}

function layerStatus(provided, passed) {
  if (!provided) return "not_provided";
  return passed ? "pass" : "fail";
}

function addCheck(checks, name, pass, evidence = undefined) {
  checks.push({ name, pass: Boolean(pass), ...(evidence === undefined ? {} : { evidence }) });
}

function phaseMatchesFade(building) {
  if (building.phase === "interior") return building.target === 1 && building.fade === 1;
  if (building.phase === "exterior") return building.target === 0 && building.fade === 0;
  if (building.phase === "entering") return building.target === 1 && building.fade >= 0 && building.fade <= 1;
  if (building.phase === "exiting") return building.target === 0 && building.fade >= 0 && building.fade <= 1;
  return false;
}

function pointInsideAnyInterior(rootPosition, prop, interiorBounds) {
  if (!rootPosition || !isFiniteNumber(rootPosition.x) || !isFiniteNumber(rootPosition.z)) return false;
  const xMilli = (rootPosition.x - prop.cell.x) * 1000;
  const yMilli = (rootPosition.z - prop.cell.y) * 1000;
  return interiorBounds.some((bounds) => (
    xMilli >= bounds.xMilli
    && xMilli <= bounds.xMilli + bounds.wMilli
    && yMilli >= bounds.yMilli
    && yMilli <= bounds.yMilli + bounds.hMilli
  ));
}

function validateMeshCounts(meshCounts) {
  if (!meshCounts || typeof meshCounts !== "object") return false;
  const values = [meshCounts.floor, meshCounts.reveal, meshCounts.keep, meshCounts.door];
  return values.every((value) => Number.isInteger(value) && value >= 0)
    && meshCounts.floor > 0
    && meshCounts.door > 0;
}

function diagnoseClientLayer(raw, prop, floorSurfaceY, authorityDoorOpen) {
  if (raw === undefined || raw === null) return { status: "not_provided" };
  const building = raw.building;
  const pawn = raw.pawn;
  if (!building || !pawn) {
    return { status: "fail", checks: [], error: "client probe requires building and pawn" };
  }

  const checks = [];
  const expectedInteriorBounds = (prop.enterable?.interiorBounds ?? [])
    .map(normalizeMilliAabb)
    .filter(Boolean);
  const actualInteriorBounds = Array.isArray(building.interiorBounds)
    ? building.interiorBounds.map(normalizeMilliAabb).filter(Boolean)
    : [];
  const interiorDiff = compareGeometrySets(expectedInteriorBounds, actualInteriorBounds);

  addCheck(checks, "propId", building.propId === prop.id, building.propId);
  addCheck(
    checks,
    "cell",
    building.cell?.x === prop.cell?.x && building.cell?.y === prop.cell?.y,
    building.cell,
  );
  addCheck(
    checks,
    "size",
    building.size?.w === prop.size?.w && building.size?.h === prop.size?.h,
    building.size,
  );
  addCheck(checks, "rotation", building.rotation === (prop.rotation ?? 0), building.rotation);
  addCheck(checks, "explicitInteriorBounds", building.explicitInteriorBounds === true);
  addCheck(
    checks,
    "interiorBounds",
    expectedInteriorBounds.length > 0
      && interiorDiff.missing.length === 0
      && interiorDiff.extra.length === 0,
    { missing: interiorDiff.missing, extra: interiorDiff.extra },
  );
  addCheck(
    checks,
    "floorSurface",
    isFiniteNumber(building.floorSurfaceY)
      && isFiniteNumber(floorSurfaceY)
      && Math.abs(building.floorSurfaceY - floorSurfaceY) <= TOLERANCES.floorSurfaceMeters,
    { rendered: building.floorSurfaceY, authored: floorSurfaceY },
  );
  addCheck(checks, "phase", phaseMatchesFade(building), {
    phase: building.phase,
    target: building.target,
    fade: building.fade,
  });
  addCheck(checks, "dwell", Number.isInteger(building.dwell) && building.dwell >= 0);
  addCheck(checks, "doorOpen", typeof building.doorOpen === "boolean", building.doorOpen);
  if (typeof authorityDoorOpen === "boolean") {
    addCheck(
      checks,
      "doorAuthorityParity",
      building.doorOpen === authorityDoorOpen,
      { rendered: building.doorOpen, authoritative: authorityDoorOpen },
    );
  }
  addCheck(
    checks,
    "doorSlide",
    isFiniteNumber(building.doorSlideT) && building.doorSlideT >= 0 && building.doorSlideT <= 1,
    building.doorSlideT,
  );
  addCheck(checks, "doorNotInRevealSet", building.doorInRevealSet === false);
  addCheck(checks, "meshCounts", validateMeshCounts(building.meshCounts), building.meshCounts);

  const worldBounds = {};
  for (const role of ["floor", "reveal", "keep", "door"]) {
    worldBounds[role] = normalizeWorldBox3(building.worldBounds?.[role]);
    addCheck(checks, `${role}WorldBounds`, worldBounds[role] !== null, worldBounds[role]);
  }
  addCheck(
    checks,
    "floorSurfaceInsideRenderedEnvelope",
    worldBounds.floor !== null
      && isFiniteNumber(building.floorSurfaceY)
      && building.floorSurfaceY >= worldBounds.floor.min.y - TOLERANCES.floorSurfaceMeters
      && building.floorSurfaceY <= worldBounds.floor.max.y + TOLERANCES.floorSurfaceMeters,
    worldBounds.floor,
  );

  const bodyBounds = normalizeWorldBox3(pawn.bodyBounds);
  addCheck(checks, "actorId", typeof pawn.actorId === "string" && pawn.actorId.length > 0, pawn.actorId);
  addCheck(
    checks,
    "pawnRoot",
    pawn.rootPosition
      && [pawn.rootPosition.x, pawn.rootPosition.y, pawn.rootPosition.z].every(isFiniteNumber),
    pawn.rootPosition,
  );
  addCheck(checks, "bodyBounds", bodyBounds !== null, bodyBounds);
  addCheck(
    checks,
    "bodyMinMatchesBounds",
    bodyBounds !== null
      && isFiniteNumber(pawn.bodyMinY)
      && Math.abs(pawn.bodyMinY - bodyBounds.min.y) <= TOLERANCES.floorSurfaceMeters,
    { bodyMinY: pawn.bodyMinY, boundsMinY: bodyBounds?.min.y },
  );
  addCheck(
    checks,
    "rootGrounding",
    isFiniteNumber(pawn.rootPosition?.y)
      && Math.abs(pawn.rootPosition.y - floorSurfaceY) <= TOLERANCES.rootFloorMeters,
    { rootY: pawn.rootPosition?.y, floorSurfaceY },
  );
  addCheck(
    checks,
    "bodyGrounding",
    isFiniteNumber(pawn.bodyMinY)
      && Math.abs(pawn.bodyMinY - floorSurfaceY) <= TOLERANCES.bodyFloorMeters,
    { bodyMinY: pawn.bodyMinY, floorSurfaceY },
  );
  const shadowClearance = pawn.shadowPlaneY - floorSurfaceY;
  addCheck(
    checks,
    "shadowClearance",
    isFiniteNumber(pawn.shadowPlaneY)
      && shadowClearance >= 0
      && shadowClearance <= TOLERANCES.shadowClearanceMeters,
    shadowClearance,
  );
  if (building.phase === "interior") {
    addCheck(
      checks,
      "interiorPawnPosition",
      pointInsideAnyInterior(pawn.rootPosition, prop, expectedInteriorBounds),
      pawn.rootPosition,
    );
  }

  return {
    status: checks.every((check) => check.pass) ? "pass" : "fail",
    checks,
  };
}

function classifyMovementAttempt(record) {
  if (!record || typeof record !== "object") {
    return { classification: "malformed", accepted: false };
  }
  const accepted = Boolean(record.accepted ?? record.receipt?.accepted);
  const attemptedDelta = record.attemptedDelta ?? record.delta;
  const resolvedDelta = record.resolvedDelta ?? record.receipt?.resolvedDelta;
  if (!attemptedDelta || !isFiniteNumber(attemptedDelta.x) || !isFiniteNumber(attemptedDelta.y)) {
    return { classification: "malformed", accepted };
  }
  if (!accepted) {
    return {
      accepted,
      attemptedDelta,
      resolvedDelta: resolvedDelta ?? null,
      endpoint: record.endpoint ?? record.resolvedEndpoint ?? null,
      classification: "rejected",
    };
  }
  if (!resolvedDelta || !isFiniteNumber(resolvedDelta.x) || !isFiniteNumber(resolvedDelta.y)) {
    return { classification: "malformed", accepted, attemptedDelta };
  }

  let classification = "slid";
  if (resolvedDelta.x === 0 && resolvedDelta.y === 0) {
    classification = "no-progress";
  } else if (resolvedDelta.x === attemptedDelta.x && resolvedDelta.y === attemptedDelta.y) {
    classification = "direct";
  } else {
    const cross = attemptedDelta.x * resolvedDelta.y - attemptedDelta.y * resolvedDelta.x;
    classification = Math.abs(cross) < Number.EPSILON ? "clamped" : "slid";
  }
  return {
    accepted,
    attemptedDelta,
    resolvedDelta,
    endpoint: record.endpoint ?? record.resolvedEndpoint ?? null,
    classification,
  };
}

function diagnoseMovementLayer(raw) {
  if (raw === undefined || raw === null) return { status: "not_provided" };
  const records = raw.records ?? raw.receipts ?? raw.trace;
  if (!Array.isArray(records) || records.length === 0) {
    return {
      status: "fail",
      error: "movement trace is empty or malformed",
      attempts: [],
      accepted: 0,
      rejected: 0,
    };
  }
  const attempts = records.map(classifyMovementAttempt);
  return {
    status: attempts.every((attempt) => attempt.classification !== "malformed") ? "pass" : "fail",
    accepted: attempts.filter((attempt) => attempt.accepted).length,
    rejected: attempts.filter((attempt) => !attempt.accepted).length,
    classifications: Object.fromEntries(
      ["direct", "clamped", "slid", "no-progress", "rejected", "malformed"]
        .map((classification) => [
          classification,
          attempts.filter((attempt) => attempt.classification === classification).length,
        ]),
    ),
    attempts,
  };
}

export function diagnose({ slice, propId, authorityExport, clientProbe, movementTrace }) {
  const prop = (slice?.props ?? []).find((candidate) => candidate.id === propId);
  if (!prop) throw new Error(`prop not found: ${propId}`);

  const localWalls = (prop.collisionBounds ?? []).map(normalizeMilliAabb).filter(Boolean);
  const localDoor = normalizeMilliAabb(prop.door?.blocker);
  const floorSurfaceY = firstDefined(prop.enterable, "floorSurfaceY", "floorHeightM")
    ?? prop.floorSurfaceY;
  const expectedWalls = localWalls.map((bounds) => translateLocalAabb(bounds, prop.cell));
  const expectedDoors = localDoor ? [translateLocalAabb(localDoor, prop.cell)] : [];

  const fineRecords = authorityRecords(authorityExport, propId, "fineCollisionBounds");
  const doorRecords = authorityRecords(authorityExport, propId, "doorCollisionBounds");
  const actualWalls = (fineRecords ?? [])
    .map((record) => normalizeMilliAabb(record) ?? { malformed: true });
  const actualDoors = (doorRecords ?? [])
    .map((record) => normalizeMilliAabb(record) ?? { malformed: true });
  const wallDiff = compareGeometrySets(expectedWalls, actualWalls);
  const doorDiff = compareGeometrySets(expectedDoors, actualDoors);
  const authorityProvided = authorityExport !== undefined && authorityExport !== null;
  const authorityPassed = authorityProvided
    && fineRecords !== null
    && doorRecords !== null
    && wallDiff.missing.length === 0
    && wallDiff.extra.length === 0
    && doorDiff.missing.length === 0
    && doorDiff.extra.length === 0;
  const authoritativeDoorOpen = doorRecords?.length === 1
    && typeof doorRecords[0].open === "boolean"
    ? doorRecords[0].open
    : undefined;

  const layers = {
    slice: {
      status: layerStatus(
        true,
        localWalls.length > 0
          && localDoor !== null
          && isFiniteNumber(floorSurfaceY)
          && Array.isArray(prop.enterable?.interiorBounds)
          && prop.enterable.interiorBounds.length > 0,
      ),
      wallPrimitiveIds: localWalls.map((bounds) => bounds.id ?? null),
      doorPrimitiveId: localDoor?.id ?? null,
      floorSurfaceY,
    },
    authority: {
      status: layerStatus(authorityProvided, authorityPassed),
      expected: [...expectedWalls, ...expectedDoors],
      actual: [...actualWalls, ...actualDoors],
      matches: [...wallDiff.matches, ...doorDiff.matches],
      missing: [...wallDiff.missing, ...doorDiff.missing],
      extra: [...wallDiff.extra, ...doorDiff.extra],
      doorOpen: authoritativeDoorOpen ?? null,
    },
    client: diagnoseClientLayer(clientProbe, prop, floorSurfaceY, authoritativeDoorOpen),
    movement: diagnoseMovementLayer(movementTrace),
  };
  const providedLayers = Object.values(layers)
    .filter((layer) => layer.status !== "not_provided");

  return {
    schema: SCHEMA,
    version: 1,
    prop: {
      id: prop.id,
      cell: prop.cell,
      size: prop.size,
      rotation: prop.rotation ?? 0,
    },
    layers,
    overall: {
      status: providedLayers.every((layer) => layer.status === "pass") ? "pass" : "fail",
    },
  };
}

function parseCliArguments(argv) {
  const valueFor = (flag) => {
    const index = argv.indexOf(flag);
    return index < 0 ? undefined : argv[index + 1];
  };
  return {
    slicePath: valueFor("--slice"),
    propId: valueFor("--prop-id"),
    authorityExportPath: valueFor("--authority-export"),
    clientProbePath: valueFor("--client-probe"),
    movementTracePath: valueFor("--movement-trace"),
    outputPath: valueFor("--out"),
    strict: argv.includes("--strict"),
  };
}

function readJson(path) {
  return path ? JSON.parse(fs.readFileSync(path, "utf8")) : undefined;
}

function runCli() {
  const options = parseCliArguments(process.argv.slice(2));
  if (!options.slicePath) throw new Error("--slice is required");
  if (!options.propId) throw new Error("--prop-id is required");
  const report = diagnose({
    slice: readJson(options.slicePath),
    propId: options.propId,
    authorityExport: readJson(options.authorityExportPath),
    clientProbe: readJson(options.clientProbePath),
    movementTrace: readJson(options.movementTracePath),
  });
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  if (options.outputPath) fs.writeFileSync(options.outputPath, serialized);
  else process.stdout.write(serialized);
  if (options.strict && report.overall.status !== "pass") process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    runCli();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  }
}
