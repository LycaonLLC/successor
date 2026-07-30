#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const defaultSlicePath = path.join(repoRoot, "client", "public", "successor-slice", "open-desert-slice.json");
const defaultBundlePath = path.join(repoRoot, "client", "public", "successor-slice", "open-desert-map-bundle.json");
const bundleSchema = "successor.map-bundle.v1";
const chunkSizeCells = 16;

export function compileMapBundle(slice, { sourcePath = null } = {}) {
  validateSlice(slice);
  const areas = [...slice.areas].sort(byId).map((area) => compileArea(slice, area));
  return {
    schema: bundleSchema,
    source: {
      schema: slice.schema,
      path: sourcePath,
      hash: sliceMapSourceHash(slice),
      stateHash: slice.stateHash,
    },
    grid: {
      cellSizePx: slice.grid.cellSizePx,
      chunkSizeCells,
    },
    areas,
    indexes: buildIndexes(areas),
    metrics: bundleMetrics(areas),
  };
}

export function sliceMapSourceHash(slice) {
  return stableHash(stableStringify({
    schema: slice.schema,
    grid: slice.grid,
    areas: slice.areas ?? [],
    populationTemplates: slice.populationTemplates ?? [],
    spawnZones: slice.spawnZones ?? [],
    actors: slice.actors ?? [],
    props: slice.props ?? [],
    blockedCells: slice.blockedCells ?? [],
    transitions: slice.transitions ?? [],
    cloneFacilities: slice.cloneFacilities ?? [],
  }));
}

function runCli() {
  const slicePath = resolveOption("--slice", defaultSlicePath);
  const bundlePath = resolveOption("--out", defaultBundlePath);
  const write = process.argv.includes("--write");
  const slice = JSON.parse(fs.readFileSync(slicePath, "utf8"));
  const bundle = compileMapBundle(slice, { sourcePath: repoRelative(slicePath) });
  const expectedText = `${JSON.stringify(bundle, null, 2)}\n`;

  if (write) {
    fs.mkdirSync(path.dirname(bundlePath), { recursive: true });
    fs.writeFileSync(bundlePath, expectedText, "utf8");
  } else {
    const currentText = fs.readFileSync(bundlePath, "utf8");
    if (currentText !== expectedText) {
      throw new Error(`${repoRelative(bundlePath)} is stale; regenerate it with tools/successor/configure-open-desert-fixture.mjs`);
    }
  }

  console.log(JSON.stringify({
    ok: true,
    mode: write ? "write" : "verify",
    slice: repoRelative(slicePath),
    output: repoRelative(bundlePath),
    sourceHash: bundle.source.hash,
    stateHash: bundle.source.stateHash,
    grid: bundle.grid,
    metrics: bundle.metrics,
  }, null, 2));
}

function validateSlice(slice) {
  const errors = [];
  if (slice?.schema !== "successor.slice.v1") errors.push(`slice schema must be successor.slice.v1, got ${slice?.schema}`);
  if (!positiveNumber(slice?.grid?.cellSizePx)) errors.push("slice grid.cellSizePx must be positive");
  if (typeof slice?.stateHash !== "string" || slice.stateHash.length === 0) errors.push("slice stateHash is required");

  const areas = new Map();
  for (const area of slice?.areas ?? []) {
    if (!requiredId(area, "area", errors)) continue;
    if (areas.has(area.id)) errors.push(`duplicate area id ${area.id}`);
    areas.set(area.id, area);
    if (typeof area.name !== "string" || area.name.length === 0) errors.push(`area ${area.id} name is required`);
    if (typeof area.kind !== "string" || area.kind.length === 0) errors.push(`area ${area.id} kind is required`);
    if (!positiveInt(area.width) || !positiveInt(area.height)) errors.push(`area ${area.id} dimensions must be positive integers`);
    if (!Number.isInteger(area.level)) errors.push(`area ${area.id} level must be an integer`);
  }
  if (areas.size === 0) errors.push("slice must declare at least one area");

  validateUniqueIds(slice?.props ?? [], "prop", errors);
  for (const prop of slice?.props ?? []) {
    const area = areas.get(prop.areaId);
    if (!area) {
      errors.push(`prop ${prop.id} references unknown area ${prop.areaId}`);
      continue;
    }
    if (!positiveNumber(prop.size?.w) || !positiveNumber(prop.size?.h)) errors.push(`prop ${prop.id} has invalid size`);
    if (!rectWithinArea(prop.cell, prop.size, area)) errors.push(`prop ${prop.id} is outside area ${area.id}`);
    if (typeof prop.kind !== "string" || prop.kind.length === 0) errors.push(`prop ${prop.id} kind is required`);
    if (typeof prop.solid !== "boolean") errors.push(`prop ${prop.id} solid must be explicit`);
    if (typeof prop.visible !== "boolean") errors.push(`prop ${prop.id} visible must be explicit`);
  }

  validateUniqueIds(slice?.transitions ?? [], "transition", errors);
  for (const transition of slice?.transitions ?? []) {
    const from = areas.get(transition.fromAreaId);
    const to = areas.get(transition.toAreaId);
    if (!from) errors.push(`transition ${transition.id} references unknown source area ${transition.fromAreaId}`);
    if (!to) errors.push(`transition ${transition.id} references unknown destination area ${transition.toAreaId}`);
    if (from && !rectWithinArea(transition.fromCell, transition.triggerSize, from)) errors.push(`transition ${transition.id} trigger is outside its source area`);
    if (to && !withinArea(transition.toCell, to)) errors.push(`transition ${transition.id} destination is outside its area`);
  }

  validateUniqueIds(slice?.cloneFacilities ?? [], "clone facility", errors);
  for (const facility of slice?.cloneFacilities ?? []) {
    const area = areas.get(facility.areaId);
    if (!area) {
      errors.push(`clone facility ${facility.id} references unknown area ${facility.areaId}`);
      continue;
    }
    if (!integerCellWithinArea(facility.respawnCell, area)) errors.push(`clone facility ${facility.id} respawn must be an integer cell inside ${area.id}`);
    if (!nonNegativeNumber(facility.sicknessDurationMs)) errors.push(`clone facility ${facility.id} sicknessDurationMs must be non-negative`);
  }

  validateUniqueIds(slice?.actors ?? [], "actor", errors);
  const actorIds = new Set();
  for (const actor of slice?.actors ?? []) {
    actorIds.add(actor.id);
    const area = areas.get(actor.areaId);
    if (!area) {
      errors.push(`actor ${actor.id} references unknown area ${actor.areaId}`);
      continue;
    }
    if (!integerCellWithinArea(actor.cell, area)) errors.push(`actor ${actor.id} must occupy an integer cell inside ${area.id}`);
  }
  if (slice?.camera?.followActor && !actorIds.has(slice.camera.followActor)) {
    errors.push(`camera.followActor references unknown actor ${slice.camera.followActor}`);
  }

  validateUniqueIds(slice?.populationTemplates ?? [], "population template", errors);
  const templateIds = new Set((slice?.populationTemplates ?? []).map((template) => template.id));
  validateUniqueIds(slice?.spawnZones ?? [], "spawn zone", errors);
  for (const zone of slice?.spawnZones ?? []) {
    const area = areas.get(zone.areaId);
    if (!area) errors.push(`spawn zone ${zone.id} references unknown area ${zone.areaId}`);
    if (!templateIds.has(zone.templateId)) errors.push(`spawn zone ${zone.id} references unknown template ${zone.templateId}`);
    if (!nonNegativeInt(zone.initialCount) || !nonNegativeInt(zone.maxAlive) || zone.initialCount > zone.maxAlive) {
      errors.push(`spawn zone ${zone.id} has invalid initialCount/maxAlive`);
    }
    for (const cell of zone.candidateCells ?? []) {
      if (area && !integerCellWithinArea(cell, area)) errors.push(`spawn zone ${zone.id} has an invalid candidate cell`);
    }
  }

  for (const cell of slice?.blockedCells ?? []) {
    const area = areas.get(cell.areaId);
    if (!area || !integerCellWithinArea(cell, area)) errors.push(`blocked cell ${cell.areaId}:${cell.x},${cell.y} is invalid`);
  }

  for (const planet of slice?.travelCatalog?.planets ?? []) {
    for (const city of planet.cities ?? []) {
      if (!Number.isInteger(city.spawn?.x) || !Number.isInteger(city.spawn?.y)) {
        errors.push(`travel city ${city.id} spawn coordinates must be integers`);
      }
    }
  }

  if (errors.length > 0) throw new Error(errors.join("\n"));
}

function compileArea(slice, area) {
  const props = (slice.props ?? []).filter((prop) => prop.areaId === area.id).sort(byId);
  const transitions = (slice.transitions ?? []).filter((transition) => transition.fromAreaId === area.id).sort(byId);
  const cloneFacilities = (slice.cloneFacilities ?? []).filter((facility) => facility.areaId === area.id).sort(byId);
  const collision = compileCollision(slice, area, props);
  const propAnchors = props.map(propAnchor);
  const transitionTriggers = transitions.map(transitionTrigger);
  const facilityAnchors = cloneFacilities.map(cloneFacility);
  const spawnPoints = compileSpawnPoints(slice, area, facilityAnchors);
  const occluders = propAnchors
    .filter((prop) => prop.visible && (prop.kind === "building" || prop.solid))
    .map((prop) => ({
      id: prop.id,
      areaId: prop.areaId,
      kind: prop.kind === "building" ? "building" : "solid_prop",
      cell: prop.cell,
      size: prop.size,
    }))
    .sort(byId);
  const biome = typeof area.biome === "string" && area.biome.length > 0 ? area.biome : "unspecified";
  const lightingZones = [areaZone(area, "lighting", `${biome}-ambient`)];
  const audioZones = [areaZone(area, "audio", `${biome}-ambience`)];

  const compiled = {
    id: area.id,
    name: area.name,
    kind: area.kind,
    width: area.width,
    height: area.height,
    level: area.level,
    biome,
    chunks: [],
    terrainLayer: {
      kind: "world-area-grid-v1",
      totalCells: area.width * area.height,
      biome,
    },
    collision,
    propAnchors,
    transitionTriggers,
    cloneFacilities: facilityAnchors,
    spawnPoints,
    occluders,
    lightingZones,
    audioZones,
  };
  compiled.chunks = compileChunks(compiled);
  return compiled;
}

function compileCollision(slice, area, props) {
  const byKey = new Map();
  for (const blockedCell of (slice.blockedCells ?? []).filter((cell) => cell.areaId === area.id)) {
    addCollisionSource(byKey, area.id, blockedCell, { kind: "blocked_cell", id: `${blockedCell.x},${blockedCell.y}` });
  }
  for (const prop of props) {
    if (!prop.solid) continue;
    for (const cell of integerCellsForRect(prop.cell, prop.size)) {
      addCollisionSource(byKey, area.id, cell, { kind: "solid_prop", id: prop.id });
    }
  }
  return [...byKey.values()].sort((a, b) => a.y - b.y || a.x - b.x);
}

function addCollisionSource(byKey, areaId, cell, source) {
  const key = `${cell.x},${cell.y}`;
  const existing = byKey.get(key);
  if (existing) {
    if (!existing.sources.some((candidate) => candidate.kind === source.kind && candidate.id === source.id)) {
      existing.sources.push(source);
      existing.sources.sort((a, b) => `${a.kind}:${a.id}`.localeCompare(`${b.kind}:${b.id}`));
    }
    return;
  }
  byKey.set(key, { key, areaId, x: cell.x, y: cell.y, sources: [source] });
}

function propAnchor(prop) {
  return {
    id: prop.id,
    areaId: prop.areaId,
    label: prop.label,
    kind: prop.kind,
    assetKey: prop.assetKey ?? null,
    cell: { ...prop.cell },
    size: { ...prop.size },
    center: { x: prop.cell.x + prop.size.w / 2, y: prop.cell.y + prop.size.h / 2 },
    foot: { x: prop.cell.x + prop.size.w / 2, y: prop.cell.y + prop.size.h },
    interactive: prop.interactive === true,
    solid: prop.solid,
    visible: prop.visible,
    rotation: prop.rotation,
  };
}

function transitionTrigger(transition) {
  return {
    id: transition.id,
    label: transition.label,
    style: transition.style,
    areaId: transition.fromAreaId,
    cell: { ...transition.fromCell },
    size: { ...transition.triggerSize },
    toAreaId: transition.toAreaId,
    toCell: { ...transition.toCell },
    toFacing: transition.toFacing,
  };
}

function cloneFacility(facility) {
  return {
    id: facility.id,
    label: facility.label,
    areaId: facility.areaId,
    respawnCell: { ...facility.respawnCell },
    respawnFacing: facility.respawnFacing,
    sicknessDurationMs: facility.sicknessDurationMs,
  };
}

function compileSpawnPoints(slice, area, cloneFacilities) {
  const actorSpawns = (slice.actors ?? [])
    .filter((actor) => actor.areaId === area.id)
    .map((actor) => ({
      id: actor.id === slice.camera?.followActor ? `camera-follow:${actor.id}` : `actor:${actor.id}`,
      areaId: area.id,
      kind: actor.id === slice.camera?.followActor ? "camera_follow_actor" : "actor",
      actorId: actor.id,
      label: actor.label,
      cell: { ...actor.cell },
      facing: actor.direction,
    }));
  const cloneSpawns = cloneFacilities.map((facility) => ({
    id: `clone-respawn:${facility.id}`,
    areaId: area.id,
    kind: "clone_respawn",
    actorId: null,
    label: `${facility.label} Respawn`,
    cell: { ...facility.respawnCell },
    facing: facility.respawnFacing,
  }));
  return [...actorSpawns, ...cloneSpawns].sort(byId);
}

function compileChunks(area) {
  const chunks = [];
  const cols = Math.ceil(area.width / chunkSizeCells);
  const rows = Math.ceil(area.height / chunkSizeCells);
  for (let chunkY = 0; chunkY < rows; chunkY += 1) {
    for (let chunkX = 0; chunkX < cols; chunkX += 1) {
      const originCell = { x: chunkX * chunkSizeCells, y: chunkY * chunkSizeCells };
      const sizeCells = {
        w: Math.min(chunkSizeCells, area.width - originCell.x),
        h: Math.min(chunkSizeCells, area.height - originCell.y),
      };
      chunks.push({
        id: `${area.id}:${chunkX},${chunkY}`,
        areaId: area.id,
        chunkX,
        chunkY,
        originCell,
        sizeCells,
        cellCount: sizeCells.w * sizeCells.h,
        collisionCellCount: area.collision.filter((cell) => rectContainsCell(cell, originCell, sizeCells)).length,
        propIds: area.propAnchors.filter((prop) => rectIntersects(prop.cell, prop.size, originCell, sizeCells)).map((prop) => prop.id).sort(),
        transitionIds: area.transitionTriggers.filter((transition) => rectIntersects(transition.cell, transition.size, originCell, sizeCells)).map((transition) => transition.id).sort(),
        cloneFacilityIds: area.cloneFacilities.filter((facility) => rectContainsCell(facility.respawnCell, originCell, sizeCells)).map((facility) => facility.id).sort(),
        spawnPointIds: area.spawnPoints.filter((spawn) => rectContainsCell(spawn.cell, originCell, sizeCells)).map((spawn) => spawn.id).sort(),
      });
    }
  }
  return chunks;
}

function buildIndexes(areas) {
  const indexes = {
    areaIds: areas.map((area) => area.id).sort(),
    propIdsByArea: {},
    transitionIdsByArea: {},
    cloneFacilityIdsByArea: {},
    spawnPointIdsByArea: {},
    chunkIdsByArea: {},
  };
  for (const area of areas) {
    indexes.propIdsByArea[area.id] = area.propAnchors.map((prop) => prop.id).sort();
    indexes.transitionIdsByArea[area.id] = area.transitionTriggers.map((transition) => transition.id).sort();
    indexes.cloneFacilityIdsByArea[area.id] = area.cloneFacilities.map((facility) => facility.id).sort();
    indexes.spawnPointIdsByArea[area.id] = area.spawnPoints.map((spawn) => spawn.id).sort();
    indexes.chunkIdsByArea[area.id] = area.chunks.map((chunk) => chunk.id).sort();
  }
  return indexes;
}

function bundleMetrics(areas) {
  return {
    areaCount: areas.length,
    totalCells: sum(areas, (area) => area.width * area.height),
    chunkCount: sum(areas, (area) => area.chunks.length),
    collisionCells: sum(areas, (area) => area.collision.length),
    propAnchors: sum(areas, (area) => area.propAnchors.length),
    transitionTriggers: sum(areas, (area) => area.transitionTriggers.length),
    cloneFacilities: sum(areas, (area) => area.cloneFacilities.length),
    spawnPoints: sum(areas, (area) => area.spawnPoints.length),
    occluders: sum(areas, (area) => area.occluders.length),
    lightingZones: sum(areas, (area) => area.lightingZones.length),
    audioZones: sum(areas, (area) => area.audioZones.length),
  };
}

function areaZone(area, zoneType, kind) {
  return {
    id: `${area.id}:${zoneType}:${kind}`,
    areaId: area.id,
    kind,
    cell: { x: 0, y: 0 },
    size: { w: area.width, h: area.height },
  };
}

function integerCellsForRect(cell, size) {
  const cells = [];
  for (let y = Math.floor(cell.y); y < Math.ceil(cell.y + size.h); y += 1) {
    for (let x = Math.floor(cell.x); x < Math.ceil(cell.x + size.w); x += 1) cells.push({ x, y });
  }
  return cells;
}

function validateUniqueIds(values, label, errors) {
  const seen = new Set();
  for (const value of values) {
    if (!requiredId(value, label, errors)) continue;
    if (seen.has(value.id)) errors.push(`duplicate ${label} id ${value.id}`);
    seen.add(value.id);
  }
}

function requiredId(value, label, errors) {
  if (typeof value?.id !== "string" || value.id.length === 0) {
    errors.push(`${label} id is required`);
    return false;
  }
  return true;
}

function resolveOption(name, fallback) {
  const prefix = `${name}=`;
  const raw = process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
  if (!raw) return fallback;
  return path.isAbsolute(raw) ? raw : path.resolve(process.cwd(), raw);
}

function repoRelative(filePath) {
  const relative = path.relative(repoRoot, filePath);
  return relative.startsWith("..") ? filePath : relative.split(path.sep).join("/");
}

function integerCellWithinArea(cell, area) {
  return Number.isInteger(cell?.x) && Number.isInteger(cell?.y) && withinArea(cell, area);
}

function withinArea(cell, area) {
  return Number.isFinite(cell?.x) && Number.isFinite(cell?.y)
    && cell.x >= 0 && cell.y >= 0 && cell.x < area.width && cell.y < area.height;
}

function rectWithinArea(cell, size, area) {
  return Number.isFinite(cell?.x) && Number.isFinite(cell?.y)
    && positiveNumber(size?.w) && positiveNumber(size?.h)
    && cell.x >= 0 && cell.y >= 0
    && cell.x + size.w <= area.width && cell.y + size.h <= area.height;
}

function rectContainsCell(cell, rectCell, rectSize) {
  return cell.x >= rectCell.x && cell.x < rectCell.x + rectSize.w
    && cell.y >= rectCell.y && cell.y < rectCell.y + rectSize.h;
}

function rectIntersects(aCell, aSize, bCell, bSize) {
  return aCell.x < bCell.x + bSize.w && aCell.x + aSize.w > bCell.x
    && aCell.y < bCell.y + bSize.h && aCell.y + aSize.h > bCell.y;
}

function byId(a, b) {
  return a.id.localeCompare(b.id);
}

function sum(values, project) {
  return values.reduce((total, value) => total + project(value), 0);
}

function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  return `{${Object.keys(value)
    .filter((key) => value[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
    .join(",")}}`;
}

function stableHash(value) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function positiveInt(value) {
  return Number.isInteger(value) && value > 0;
}

function nonNegativeInt(value) {
  return Number.isInteger(value) && value >= 0;
}

function positiveNumber(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function nonNegativeNumber(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

const realpathOrResolve = (value) => {
  try { return fs.realpathSync(value); }
  catch { return path.resolve(value); }
};
export function isMainModulePath(argvPath, modulePath = fileURLToPath(import.meta.url)) {
  return Boolean(argvPath) && realpathOrResolve(argvPath) === realpathOrResolve(modulePath);
}
const isMain = isMainModulePath(process.argv[1]);
if (isMain) runCli();
