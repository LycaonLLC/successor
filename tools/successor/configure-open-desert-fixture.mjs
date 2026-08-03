#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { assertCardinalRotation, deriveStructureDoorPoints, stablePlacedCollisionBounds, structurePointIsClear, transformStructureCollision } from "./structure-collision-geometry.mjs";

// Open-desert world-slice generator defaults (all overrideable by CLI/env):
//   worldSeed: 424242               (--world-seed / SUCCESSOR_OPEN_DESERT_WORLD_SEED)
//   areaSize: 1024 cells            (--area-size / SUCCESSOR_OPEN_DESERT_AREA_SIZE; max 1024)
//   rogueZoneCount: 18              (--rogue-zone-count / SUCCESSOR_OPEN_DESERT_ROGUE_ZONE_COUNT)
//   roguePerZone: deterministic 1..2 (--rogue-per-zone-min/max / SUCCESSOR_OPEN_DESERT_ROGUE_PER_ZONE_MIN/MAX)
//   desertCritterZoneCount: 48      (--desert-critter-zone-count / SUCCESSOR_DESERT_CRITTER_ZONE_COUNT; multiple of 4)
//   verdanceCritterZoneCount: 24    (--verdance-critter-zone-count / SUCCESSOR_VERDANCE_CRITTER_ZONE_COUNT; multiple of 2)
//   critterPerZone: deterministic 2..3 (--critter-per-zone-min/max / SUCCESSOR_CRITTER_PER_ZONE_MIN/MAX)
//   safeRadiusCells: 100 around the center camp (--safe-radius-cells / SUCCESSOR_OPEN_DESERT_SAFE_RADIUS_CELLS)
//   activationRadiusCells: 112      (--activation-radius-cells / SUCCESSOR_OPEN_DESERT_ACTIVATION_RADIUS_CELLS)
//   leashRadiusCells: 112           (--leash-radius-cells / SUCCESSOR_OPEN_DESERT_LEASH_RADIUS_CELLS)
//   deactivationRadiusCells: 168    (--deactivation-radius-cells / SUCCESSOR_OPEN_DESERT_DEACTIVATION_RADIUS_CELLS)
//   leashReleaseTicks: 240          (--leash-release-ticks / SUCCESSOR_OPEN_DESERT_LEASH_RELEASE_TICKS)
//   lingerTicks: 300 (10s @30Hz)    (--linger-ticks / SUCCESSOR_OPEN_DESERT_LINGER_TICKS)
//   activationCheckEveryTicks: 10   (--activation-check-every-ticks / SUCCESSOR_OPEN_DESERT_ACTIVATION_CHECK_EVERY_TICKS)

const repoRoot = path.resolve(import.meta.dirname, "../..");
const successorSliceRoot = path.join(repoRoot, "client", "public", "successor-slice");
const defaultSlicePath = path.join(successorSliceRoot, "open-desert-slice.json");
const defaultMapBundlePath = path.join(successorSliceRoot, "open-desert-map-bundle.json");
const overworldAreaId = "open-desert-overworld";
const verdanceAreaId = "verdance-forest-overworld";
const ashvatPlanetId = "ashvat";
const dustgateCityId = "dustgate";
const verdancePlanetId = "verdance";
const lowboughCityId = "lowbough";
const dustgateTerminalPropId = "travel-terminal-dustgate";
const lowboughTerminalPropId = "travel-terminal-lowbough";
const bankTerminalPropId = "dustgate-bank-terminal";
const commerceFacilityPropId = "dustgate-commerce-facility";
const cloningFacilityPropId = "dustgate-cloning-facility";
const cloneTerminalPropId = "dustgate-clone-terminal";
const clonePodPropId = "dustgate-clone-pod";
// The Grok wedge's authored front is -Y. The mapping-owned -90 X correction
// maps that face to runtime +Z, toward the locked north-up camera at yaw 0.
const travelTerminalScreenFacingRotation = 0;
const maxAreaSize = 1024;
// Preserve the pre-envelope world layout: old scatter margin was leash 88 + 8.
// Activation/leash/deactivation radii may grow, but seeded zone centers should not reshuffle.
const SCATTER_MARGIN_CELLS = 96;

const worldSeed = integerOption("--world-seed", "SUCCESSOR_OPEN_DESERT_WORLD_SEED", 424242, { min: 1, max: 0xffff_ffff });
const areaSize = integerOption("--area-size", "SUCCESSOR_OPEN_DESERT_AREA_SIZE", 1024, { min: 256, max: maxAreaSize });
const rogueZoneCount = integerOption("--rogue-zone-count", "SUCCESSOR_OPEN_DESERT_ROGUE_ZONE_COUNT", 18, { min: 1, max: 64 });
const roguePerZoneMin = integerOption("--rogue-per-zone-min", "SUCCESSOR_OPEN_DESERT_ROGUE_PER_ZONE_MIN", 1, { min: 1, max: 4 });
const roguePerZoneMax = integerOption("--rogue-per-zone-max", "SUCCESSOR_OPEN_DESERT_ROGUE_PER_ZONE_MAX", 2, { min: roguePerZoneMin, max: 4 });
// Gaia critter zones — dominant ambient wildlife, scattered AWAY from the
// spawn camp (rocky/flora edges). Zone counts split exactly evenly across the
// biome's species roster, so they must divide by the roster size.
const desertCritterZoneCount = integerOption("--desert-critter-zone-count", "SUCCESSOR_DESERT_CRITTER_ZONE_COUNT", 48, { min: 0, max: 128 });
const verdanceCritterZoneCount = integerOption("--verdance-critter-zone-count", "SUCCESSOR_VERDANCE_CRITTER_ZONE_COUNT", 24, { min: 0, max: 128 });
const critterPerZoneMin = integerOption("--critter-per-zone-min", "SUCCESSOR_CRITTER_PER_ZONE_MIN", 2, { min: 1, max: 4 });
const critterPerZoneMax = integerOption("--critter-per-zone-max", "SUCCESSOR_CRITTER_PER_ZONE_MAX", 3, { min: critterPerZoneMin, max: 4 });
// Gaia wildlife wave (owner contract 2026-07-12): six adult species with EXACT
// sprite ids; role `creature`, faction `gaia` (no enemies/allies), passive
// roam/flee AI with species-specific social groups. Desert hosts four species,
// Verdance two.
const desertCritterSpecies = [
  { templateId: "open-desert-bellback", label: "Bellback", sprite: "creature-bellback-adult", socialGroup: "open_desert_bellbacks" },
  { templateId: "open-desert-pebblehorn", label: "Pebblehorn", sprite: "creature-pebblehorn-adult", socialGroup: "open_desert_pebblehorns" },
  { templateId: "open-desert-snufflefin", label: "Snufflefin", sprite: "creature-snufflefin-adult", socialGroup: "open_desert_snufflefins" },
  { templateId: "open-desert-pocketclod", label: "Pocketclod", sprite: "creature-pocketclod-adult", socialGroup: "open_desert_pocketclods" },
];
const verdanceCritterSpecies = [
  { templateId: "verdance-mossmuff", label: "Mossmuff", sprite: "creature-mossmuff-adult", socialGroup: "verdance_mossmuffs" },
  { templateId: "verdance-dapplepod", label: "Dapplepod", sprite: "creature-dapplepod-adult", socialGroup: "verdance_dapplepods" },
];
if (desertCritterZoneCount % desertCritterSpecies.length !== 0) {
  throw new Error(`--desert-critter-zone-count (${desertCritterZoneCount}) must be a multiple of ${desertCritterSpecies.length} for an exact species split`);
}
if (verdanceCritterZoneCount % verdanceCritterSpecies.length !== 0) {
  throw new Error(`--verdance-critter-zone-count (${verdanceCritterZoneCount}) must be a multiple of ${verdanceCritterSpecies.length} for an exact species split`);
}
// Designer safe radius stays the camp comfort radius; scatter also excludes at least activationRadiusCells.
const safeRadiusCells = integerOption("--safe-radius-cells", "SUCCESSOR_OPEN_DESERT_SAFE_RADIUS_CELLS", 100, { min: 32, max: Math.floor(areaSize / 2) - 8 });
// Ceiling intentionally exceeds the 96-cell radar rim so hostile/yellow actors exist before clamp range while preserving act<=leash<=deact.
const activationRadiusCells = integerOption("--activation-radius-cells", "SUCCESSOR_OPEN_DESERT_ACTIVATION_RADIUS_CELLS", 112, { min: 24, max: 128 });
// Leash (cells). The spawn-zone leash is ACTIVATION BOOKKEEPING ONLY in the
// current sim — `last_player_within_leash_tick` is recorded but never
// consumed (despawn is driven by deactivation + linger), and rogue PURSUIT
// reach is bounded by the combat-AI acquire/keep-focus radii
// (SKIRMISHER_ACQUIRE_RADIUS 115c keep-focus, ROGUE_ALERT_RADIUS 14c
// acquire), NOT by this leash. Its only hard role: the Rust population
// validation requires `activation <= leash <= deactivation`
// (population.rs), so leash must rise with activation. Raising it 88->112 is
// therefore camp-safe: roaming zones are kept outside the camp activation
// radius (see safeRadiusCells + post-scatter assertion), and the spawn-zone
// leash never governed how close a kited rogue gets to camp. Kept == activation
// (112) as the tightest valid value; raise freely if a future leash-out despawn
// margin is ever wired in.
const leashRadiusCells = integerOption("--leash-radius-cells", "SUCCESSOR_OPEN_DESERT_LEASH_RADIUS_CELLS", 112, { min: activationRadiusCells, max: 160 });
const leashReleaseTicks = integerOption("--leash-release-ticks", "SUCCESSOR_OPEN_DESERT_LEASH_RELEASE_TICKS", 240, { min: 30, max: 1800 });
// Deactivation radius (despawn threshold): a zone only releases its alive
// actors once no player has been within this radius for `lingerTicks`.
// Default 168 >> leash (112): the margin (168-112 = 56 cells, ~12s of retreat
// at walk speed) plus the 300-tick (10s) linger window means a real
// departure despawns rogues only once they are far off-screen — 168 cells
// >> the ~24-cell max view half-diagonal, so despawn is never visible and a
// brief leash-out keeps rogues alive to leash back to post. Must be >= leash.
const deactivationRadiusCells = integerOption("--deactivation-radius-cells", "SUCCESSOR_OPEN_DESERT_DEACTIVATION_RADIUS_CELLS", 168, { min: leashRadiusCells, max: 200 });
// Linger (ticks) before despawn after the last player leaves deactivation
// radius. Default 300 = 10s at 30Hz: long enough for leash-return, short
// enough that a real departure cleans up.
const lingerTicks = integerOption("--linger-ticks", "SUCCESSOR_OPEN_DESERT_LINGER_TICKS", 300, { min: 30, max: 1800 });
const activationCheckEveryTicks = integerOption("--activation-check-every-ticks", "SUCCESSOR_OPEN_DESERT_ACTIVATION_CHECK_EVERY_TICKS", 10, { min: 1, max: 120 });
const minZoneSpacingCells = integerOption("--min-zone-spacing-cells", "SUCCESSOR_OPEN_DESERT_MIN_ZONE_SPACING_CELLS", 72, { min: 64, max: 180 });
// Defaults 6/12/20 keep initial engagements within the default 3D camera
// footprint (roughly 20 cells vertically); the tested max was trimmed from
// 22 to 20 cells so fights begin on-screen.
const weaponPointBlankCells = integerOption("--weapon-point-blank-cells", "SUCCESSOR_OPEN_DESERT_WEAPON_POINT_BLANK_CELLS", 6, { min: 1, max: 94 });
const weaponIdealCells = integerOption("--weapon-ideal-cells", "SUCCESSOR_OPEN_DESERT_WEAPON_IDEAL_CELLS", 12, { min: weaponPointBlankCells + 1, max: 95 });
const weaponMaxCells = integerOption("--weapon-max-cells", "SUCCESSOR_OPEN_DESERT_WEAPON_MAX_CELLS", 20, { min: weaponIdealCells + 1, max: 96 });
const shelterHouseRotation = integerOption("--shelter-house-rotation", "SUCCESSOR_OPEN_DESERT_SHELTER_HOUSE_ROTATION", 0, { min: 0, max: 270 });
assertCardinalRotation(shelterHouseRotation);

function main() {
  const outputArg = process.argv.find((arg) => arg.startsWith("--out="));
  const mapBundleArg = process.argv.find((arg) => arg.startsWith("--map-bundle="));
  const outputPath = path.resolve(outputArg?.slice("--out=".length) || defaultSlicePath);
  const mapBundlePath = path.resolve(mapBundleArg?.slice("--map-bundle=".length) || defaultMapBundlePath);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.mkdirSync(path.dirname(mapBundlePath), { recursive: true });

  const slice = buildSlice();
  fs.writeFileSync(outputPath, `${JSON.stringify(slice, null, 2)}\n`, "utf8");
  rebuildMapBundle(outputPath, mapBundlePath);

  const critterZones = slice.spawnZones.filter((zone) => zone.templateId !== "open-desert-rogue-trooper");
  const critterZonesByTemplate = {};
  for (const zone of critterZones) {
    critterZonesByTemplate[zone.templateId] = (critterZonesByTemplate[zone.templateId] ?? 0) + 1;
  }
  console.log(JSON.stringify({
    ok: true,
    path: path.relative(repoRoot, outputPath),
    mapBundle: path.relative(repoRoot, mapBundlePath),
    worldSeed,
    areaSize,
    spawnZoneCount: slice.spawnZones.length,
    rogueZoneCount: slice.spawnZones.filter((zone) => zone.templateId === "open-desert-rogue-trooper" && zone.id !== "open-desert-sparring-zone").length,
    sparringZoneCount: slice.spawnZones.filter((zone) => zone.id === "open-desert-sparring-zone").length,
    critterZoneCount: critterZones.length,
    desertCritterZoneCount: critterZones.filter((zone) => zone.areaId === overworldAreaId).length,
    verdanceCritterZoneCount: critterZones.filter((zone) => zone.areaId === verdanceAreaId).length,
    critterZonesByTemplate,
    cachePropCount: slice.props.filter((prop) => /^open-desert-cache-/.test(prop.id)).length,
    travelTerminalCount: slice.props.filter((prop) => prop.kind === "travel_terminal").length,
    areas: slice.areas.map((area) => ({ id: area.id, biome: area.biome, width: area.width, height: area.height })),
    peacefulAreas: [verdanceAreaId],
    averageSpacingCells: Math.floor(Math.sqrt((areaSize * areaSize) / slice.spawnZones.length)),
    safeRadiusCells,
    roguePerZone: `${roguePerZoneMin}-${roguePerZoneMax}`,
    critterPerZone: `${critterPerZoneMin}-${critterPerZoneMax}`,
    activationRadiusCells,
    leashRadiusCells,
    deactivationRadiusCells,
    leashReleaseTicks,
    lingerTicks,
    activationCheckEveryTicks,
    weaponRangeBands: slice.combatTuning.weaponRangeBands,
    actors: slice.actors.length,
    dormantInitialActors: slice.spawnZones.reduce((sum, zone) => sum + zone.initialCount, 0),
    stateHash: slice.stateHash,
  }, null, 2));
}

function buildSlice() {
  const center = Math.floor(areaSize / 2);
  const layout = openDesertLayout(center);
  const zones = spawnZones(center);
  const slice = {
    schema: "successor.slice.v1",
    combatModel: "roll",
    combatTuning: combatTuning(),
    worldSeed,
    tick: 0,
    tickRateHz: 30,
    grid: { cellSizePx: 60 },
    zone: { id: 1, name: "Open Desert", width: areaSize, height: areaSize, level: 0 },
    areas: areas(),
    // v5 adds the authored bank + enterable cloning facility identity.
    stateHash: `planetfall-v5-seed-${worldSeed}-size-${areaSize}-rogues-${rogueZoneCount}-desert-critters-${desertCritterZoneCount}-verdance-critters-${verdanceCritterZoneCount}-areas-${overworldAreaId}-${verdanceAreaId}`,
    camera: { followActor: "player", zoom: 72 },
    factions: factions(),
    populationTemplates: populationTemplates(),
    spawnZones: zones,
    actors: [playerActor(layout), campTrainerActor(center), grokActor(center)],
    props: props(center, layout, zones),
    blockedCells: [],
    noClaimZones: noClaimZones(center),
    transitions: [],
    cloneFacilities: cloneFacilities(layout),
    travelCatalog: travelCatalog(center, layout),
    inventory: inventoryRows(zones),
    reservations: [],
    npcJobs: [],
    events: [],
    weather: [
      {
        areaId: "open-desert-overworld",
        eventType: "sandstorm",
        centerCell: { x: 512, y: 512 },
        radiusCells: 48,
        spawnRadiusCells: 320,
        magnitudeRange: [0.45, 1],
        periodTicks: { idle: 1200, warning: 450, active: 1800, decay: 300 },
        dpsMilliHealth: 8000,
        phaseOffsetTicks: 0
      },
      {
        areaId: "verdance-forest-overworld",
        eventType: "sporefall",
        centerCell: { x: 512, y: 512 },
        radiusCells: 48,
        periodTicks: { idle: 1200, warning: 450, active: 1800, decay: 300 },
        spawnRadiusCells: 320,
        magnitudeRange: [0.45, 1],
        dpsMilliHealth: 8000,
        phaseOffsetTicks: 2000
      }
    ],
  };
  // Server-side/coarse collision remains OFF: the dense camp prop ring can
  // wedge cardinal movement at spawn, so blockedCells stays empty.
  // House collisionBounds above are client-only prediction/command data; the
  // server/Rust launch path strips bounds from solid:false props. Restore coarse
  // collision by reverting to:
  //   slice.blockedCells = slice.props.flatMap(blockedCellsForProp);
  slice.blockedCells = [];
  assertFirstSessionLegibility(slice);
  assertEnterableFloorMetadata(slice);
  assertStableFixtureGeometry(slice);
  return slice;
}

function combatTuning() {
  return {
    weaponRangeBands: {
      slugthrower: {
        pointBlankCells: weaponPointBlankCells,
        idealCells: weaponIdealCells,
        maxCells: weaponMaxCells,
      },
      // Project the current Roll melee band too, so clients can approach
      // without resurrecting a separate client-side combat table.
      vibrosword: {
        pointBlankCells: 1,
        idealCells: 2,
        maxCells: 3,
      },
      // Primitive Brawler starts use projected authority tuning too. Clients
      // may approach from these bands; they must not grow a parallel
      // hard-coded weapon table.
      "scrapline-machete": {
        pointBlankCells: 1,
        idealCells: 2,
        maxCells: 3,
      },
    },
  };
}

function areas() {
  return [
    { id: overworldAreaId, name: "Open Desert", kind: "overworld", width: areaSize, height: areaSize, level: 0, biome: "desert" },
    { id: verdanceAreaId, name: "Verdance Forest", kind: "overworld", width: areaSize, height: areaSize, level: 0, biome: "forest" },
  ];
}

function openDesertLayout(center) {
  const starterSize = { w: 8, h: 6 };
  const starterCollision = enterableStructureCollision({
    glbName: "home_modular_starter",
    cellSize: starterSize,
    rotation: shelterHouseRotation,
  });
  const courtSize = { w: 10, h: 8 };
  const courtCollision = enterableStructureCollision({
    glbName: "home_modular_court",
    cellSize: courtSize,
    rotation: 0,
  });
  const wingSize = { w: 12, h: 10 };
  const wingCollision = enterableStructureCollision({
    glbName: "home_modular_wing",
    cellSize: wingSize,
    rotation: 0,
  });
  const facilitySize = { w: 10, h: 8 };
  const facilityCollision = enterableStructureCollision({
    glbName: "cloning_facility",
    cellSize: facilitySize,
    rotation: 0,
  });
  const expectedFacilityFloorTopM = 0.02 * (facilitySize.w / 9.5);
  if (Math.abs(facilityCollision.floorTopM - expectedFacilityFloorTopM) > 1e-12) {
    throw new Error(`cloning facility floor contract drifted: expected ${expectedFacilityFloorTopM}, got ${facilityCollision.floorTopM}`);
  }
  if (facilityCollision.collisionBounds.length < 9) {
    throw new Error(`cloning_facility structural proxy must preserve its authored blockers (got ${facilityCollision.collisionBounds.length})`);
  }

  const marketSize = { w: 12, h: 9 };
  const marketCollision = enterableStructureCollision({
    glbName: "valley_market",
    cellSize: marketSize,
    rotation: 0,
  });
  assertPromisedCellsClear(marketCollision, marketSize);
  if (marketCollision.furniture.length !== 27 || marketCollision.furniture.some((box) => !box.id)) {
    throw new Error(`valley_market must carry 27 named furniture blockers (got ${marketCollision.furniture.length})`);
  }

  const starterCell = { x: center, y: center };
  const facilityCell = { x: center + 1, y: center - 13 };
  const marketCell = { x: center - 12, y: center - 14 };
  const courtCell = { x: center - 19, y: center + 8 };
  const wingCell = { x: center + 7, y: center + 8 };
  const toWorld = (cell, point) => ({
    x: cell.x + point.xMilli / 1000,
    y: cell.y + point.yMilli / 1000,
  });
  const building = (cell, size, rotation, collision) => ({
    cell,
    size,
    rotation,
    collisionBounds: collision.collisionBounds,
    interiorRegions: collision.interiorRegions,
    floorTopM: collision.floorTopM,
    door: collision.door,
    safeExterior: collision.safeExterior,
    safeInterior: collision.safeInterior,
  });
  const starter = building(starterCell, starterSize, shelterHouseRotation, starterCollision);
  const facility = building(facilityCell, facilitySize, 0, facilityCollision);
  const market = building(marketCell, marketSize, 0, marketCollision);
  const court = building(courtCell, courtSize, 0, courtCollision);
  const wing = building(wingCell, wingSize, 0, wingCollision);
  const namedBuildings = { starter, facility, market, court, wing };
  for (const [leftId, left] of Object.entries(namedBuildings)) {
    for (const [rightId, right] of Object.entries(namedBuildings)) {
      if (leftId >= rightId) continue;
      if (rectsOverlap(propFootprintRect(left), propFootprintRect(right))) {
        throw new Error(`Dustgate building footprints overlap: ${leftId}/${rightId}`);
      }
    }
  }

  const cloneRespawn = { x: facilityCell.x + 6, y: facilityCell.y + 4 };
  const cloneRespawnLocal = { xMilli: 6000, yMilli: 4000 };
  if (!structurePointIsClear(cloneRespawnLocal, facility.collisionBounds, facility.door.blocker)) {
    throw new Error("reviewed clone respawn local (6,4) is blocked by facility collision");
  }
  const layout = {
    center: { x: center, y: center },
    starter,
    facility,
    market,
    court,
    wing,
    playerSpawn: nearestClearLayoutCell(toWorld(starterCell, starterCollision.safeExterior), starter, "exterior"),
    cloneRespawn,
    bankTerminal: { x: marketCell.x + 3, y: marketCell.y + 3 },
    tradeTerminal: { x: marketCell.x + 6, y: marketCell.y + 3 },
    paTerminal: { x: marketCell.x + 9, y: marketCell.y + 3 },
    // Both sit inside the cloning facility. The terminal is the operator island
    // at the centre of the hall; the pod completes the vat bank in the back-left
    // corner. The pod used to stand two cells inside the portal, directly in the
    // entry lane, where a solid 1x1 blocker meant a pawn walking straight in
    // stopped against it -- see tools/successor/assets/cloning-facility-opus5.
    cloneTerminal: { x: facilityCell.x + 5, y: facilityCell.y + 3 },
    clonePod: { x: facilityCell.x + 2, y: facilityCell.y + 1 },
  };
  const pointsInsideArea = [
    layout.playerSpawn,
    layout.cloneRespawn,
    ...Object.values(namedBuildings).flatMap(({ cell, size }) => [
      cell,
      { x: cell.x + size.w, y: cell.y + size.h },
    ]),
  ].every((point) => point.x >= 1 && point.x <= areaSize - 2
    && point.y >= 1 && point.y <= areaSize - 2);
  if (!pointsInsideArea) throw new Error(`open-desert center layout exceeds area bounds: ${JSON.stringify(layout)}`);
  return layout;
}

function nearestClearLayoutCell(ideal, house, side) {
  const searchRadius = Math.ceil(Math.max(house.size.w, house.size.h)) + 2;
  const minX = Math.floor(ideal.x) - searchRadius;
  const maxX = Math.ceil(ideal.x) + searchRadius;
  const minY = Math.floor(ideal.y) - searchRadius;
  const maxY = Math.ceil(ideal.y) + searchRadius;
  const shelterInsetMilli = 250;
  let best = null;
  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      const local = { xMilli: (x - house.cell.x) * 1000, yMilli: (y - house.cell.y) * 1000 };
      const insideShelter = local.xMilli >= shelterInsetMilli && local.xMilli <= house.size.w * 1000 - shelterInsetMilli
        && local.yMilli >= shelterInsetMilli && local.yMilli <= house.size.h * 1000 - shelterInsetMilli;
      if ((side === "interior") !== insideShelter) continue;
      if (!structurePointIsClear(local, house.collisionBounds, house.door.blocker)) continue;
      const distanceSquared = (x - ideal.x) ** 2 + (y - ideal.y) ** 2;
      if (!best || distanceSquared < best.distanceSquared
        || (distanceSquared === best.distanceSquared && (y < best.cell.y || (y === best.cell.y && x < best.cell.x)))) {
        best = { cell: { x, y }, distanceSquared };
      }
    }
  }
  if (!best) throw new Error(`no collision-clear integer ${side} cell near ${JSON.stringify(ideal)}`);
  return best.cell;
}

function travelCatalog(center, layout) {
  return {
    schema: "successor.travel-catalog.v1",
    planets: [
      {
        id: ashvatPlanetId,
        label: "Ashvat",
        biome: "desert",
        areaId: overworldAreaId,
        cities: [{
          id: dustgateCityId,
          label: "Dustgate",
          terminalPropId: dustgateTerminalPropId,
          spawn: { ...layout.playerSpawn },
        }],
      },
      {
        id: verdancePlanetId,
        label: "Verdance",
        biome: "forest",
        areaId: verdanceAreaId,
        cities: [{
          id: lowboughCityId,
          label: "Lowbough",
          terminalPropId: lowboughTerminalPropId,
          spawn: { x: center, y: center },
        }],
      },
    ],
  };
}

function playerActor(layout) {
  return {
    id: "player",
    entity: "1:1",
    areaId: overworldAreaId,
    label: "Field Observer",
    role: "player",
    factionId: "desert_wardens",
    socialGroup: "open_desert_player",
    guildTag: "WARD",
    pvpStatus: "overt",
    professionIds: ["marksman"],
    skillBoxIds: ["marksman-novice", "marksman-rifle-i"],
    sprite: "adventurer-premium-male",
    poseSet: "walk",
    direction: "front",
    cell: { ...layout.playerSpawn },
    route: [],
    vitals: { health: 280, action: 160, spirit: 100 },
    maxVitals: { health: 280, action: 160, spirit: 100 },
  };
}

/**
 * Camp profession trainer — the start-simple bootstrap NPC: learning
 * Novice Craftsman at this actor grants the crafting tool + iron survey
 * tool (server-side trainer grant), which unlocks the survey/sample loop.
 */
function campTrainerActor(center) {
  return {
    id: "camp-trainer",
    entity: "1:2",
    areaId: overworldAreaId,
    // established sandbox-style named service NPC: a personal name; the "a profession trainer"
    // type read comes from the server descriptor (derive_actor_descriptor).
    label: "Knox Vale",
    role: "profession_trainer",
    factionId: "desert_wardens",
    socialGroup: "open_desert_camp",
    pvpStatus: "none",
    professionIds: ["craftsman", "marksman", "medic", "brawler", "scout", "bioengineer"],
    skillBoxIds: [],
    sprite: "adventurer-premium-male",
    poseSet: "idle",
    direction: "front",
    // A REAL first walk from spawn (center, center+1): ~7 cells southeast,
    // past the road barrier toward the plinth ruins — far enough that the
    // first objective cannot auto-resolve at spawn (client-3d first-steps
    // marks "reached" within ~2.5 cells), close enough to stay one legible
    // walk. Cell (517,518) is clear of every camp prop footprint.
    cell: { x: center - 2, y: center - 8 },
    route: [],
  };
}

/**
 * Named start-zone droid. `scripted_player` is the authority-protected social
 * NPC lane: it gives GR0K the target/nameplate/examine contract without
 * inventing a trainer, quest, vendor, or combat job before his purpose is
 * designed.
 */
function grokActor(center) {
  return {
    id: "grok",
    entity: "1:3",
    areaId: overworldAreaId,
    label: "GR0K",
    role: "scripted_player",
    factionId: "desert_wardens",
    socialGroup: "open_desert_camp",
    pvpStatus: "none",
    professionIds: [],
    skillBoxIds: [],
    sprite: "droid-grok-humanoid",
    poseSet: "idle",
    direction: "right",
    cell: { x: center - 2, y: center + 2 },
    route: [],
  };
}

function cloneFacilities(layout) {
  return [{
    id: cloningFacilityPropId,
    label: "Dustgate Cloning Facility",
    areaId: overworldAreaId,
    respawnCell: { ...layout.cloneRespawn },
    respawnFacing: "front",
    sicknessDurationMs: 30_000,
  }];
}

function populationTemplates() {
  return [
    {
      id: "open-desert-rogue-trooper",
      labelPrefix: "Rogue Drifter",
      role: "skirmisher",
      factionId: "rogue_troopers",
      socialGroup: "open_desert_rogues",
      pvpStatus: "overt",
      professionIds: ["marksman"],
      skillBoxIds: ["marksman-novice"],
      sprite: "adventurer-premium-male",
      poseSet: "idle",
      direction: "left",
    },
    ...[...desertCritterSpecies, ...verdanceCritterSpecies].map((species) => ({
      // Gaia wildlife — yellow attackable combat-NPC presentation, passive
      // roam/flee AI (role `creature` routes into the shared passive-creature
      // brain), harvestable corpse. Faction `gaia` carries no relations.
      id: species.templateId,
      labelPrefix: species.label,
      role: "creature",
      factionId: "gaia",
      socialGroup: species.socialGroup,
      pvpStatus: "overt",
      professionIds: [],
      skillBoxIds: [],
      sprite: species.sprite,
      poseSet: "idle",
      direction: "left",
      vitals: { health: 60, action: 45, spirit: 40 },
      maxVitals: { health: 60, action: 45, spirit: 40 },
    })),
  ];
}

function spawnZones(center) {
  const rng = xorshift32(worldSeed ^ 0x51f15eED);
  const centers = scatterZoneCenters(rng, center, { count: rogueZoneCount });
  assertRoamingZoneCentersOutsideActivation(centers, center);
  const zones = centers.map((cell, index) => {
    const enemyCount = 2;
    const ordinal = String(index + 1).padStart(3, "0");
    const id = `open-desert-rogue-zone-${ordinal}`;
    return {
      id,
      actorIdPrefix: `open-desert-rogue-${ordinal}`,
      templateId: "open-desert-rogue-trooper",
      areaId: overworldAreaId,
      candidateCells: candidateCellsForZone(cell, enemyCount),
      initialCount: enemyCount,
      maxAlive: enemyCount,
      spawnEverySeconds: 150,
      batchMin: 1,
      batchMax: 1,
      seed: mix32(worldSeed ^ ((index + 1) * 0x9e37_79b1)),
      activation: {
        radiusCells: activationRadiusCells,
        leashRadiusCells,
        deactivationRadiusCells,
        releaseTicks: leashReleaseTicks,
        lingerTicks,
        checkEveryTicks: activationCheckEveryTicks,
      },
      encounter: humanoidEncounter(cell, id, index),
    };
  });
  // Gaia critter zones — the dominant procedural wildlife, scattered AWAY
  // from the spawn camp (rocky/flora edges, not a greeting committee). Zones
  // rotate round-robin through the biome roster for an exact species split;
  // they reuse the roaming activation envelope + the same scatter exclusion
  // as rogues so they never boot-activate on the camp.
  const desertCritterRng = xorshift32(worldSeed ^ 0xc1a0_deed);
  const desertCritterCenters = scatterZoneCenters(desertCritterRng, center, {
    count: desertCritterZoneCount,
    minSpacingCells: 54,
    existingCenters: centers,
  });
  assertRoamingZoneCentersOutsideActivation(desertCritterCenters, center);
  for (const [index, cell] of desertCritterCenters.entries()) {
    const species = desertCritterSpecies[index % desertCritterSpecies.length];
    const count = critterPerZoneMin + nextRange(desertCritterRng, 0, critterPerZoneMax - critterPerZoneMin);
    const ordinal = String(Math.floor(index / desertCritterSpecies.length) + 1).padStart(2, "0");
    zones.push({
      id: `${species.templateId}-zone-${ordinal}`,
      actorIdPrefix: `${species.templateId}-${ordinal}`,
      templateId: species.templateId,
      areaId: overworldAreaId,
      candidateCells: candidateCellsForZone(cell, count),
      initialCount: count,
      maxAlive: count,
      spawnEverySeconds: 180,
      batchMin: 1,
      batchMax: 1,
      seed: mix32(worldSeed ^ ((index + 1) * 0x13c0_ffee)),
      activation: {
        radiusCells: activationRadiusCells,
        leashRadiusCells,
        deactivationRadiusCells,
        releaseTicks: leashReleaseTicks,
        lingerTicks,
        checkEveryTicks: activationCheckEveryTicks,
      },
    });
  }
  const verdanceCritterRng = xorshift32(worldSeed ^ 0x67da_ce11);
  const verdanceCritterCenters = scatterZoneCenters(verdanceCritterRng, center, {
    count: verdanceCritterZoneCount,
    minSpacingCells: 72,
  });
  assertRoamingZoneCentersOutsideActivation(verdanceCritterCenters, center);
  for (const [index, cell] of verdanceCritterCenters.entries()) {
    const species = verdanceCritterSpecies[index % verdanceCritterSpecies.length];
    const count = critterPerZoneMin + nextRange(verdanceCritterRng, 0, critterPerZoneMax - critterPerZoneMin);
    const ordinal = String(Math.floor(index / verdanceCritterSpecies.length) + 1).padStart(2, "0");
    zones.push({
      id: `${species.templateId}-zone-${ordinal}`,
      actorIdPrefix: `${species.templateId}-${ordinal}`,
      templateId: species.templateId,
      areaId: verdanceAreaId,
      candidateCells: candidateCellsForZone(cell, count),
      initialCount: count,
      maxAlive: count,
      spawnEverySeconds: 180,
      batchMin: 1,
      batchMax: 1,
      seed: mix32(worldSeed ^ ((index + 1) * 0x67da_ce11)),
      activation: {
        radiusCells: activationRadiusCells,
        leashRadiusCells,
        deactivationRadiusCells,
        releaseTicks: leashReleaseTicks,
        lingerTicks,
        checkEveryTicks: activationCheckEveryTicks,
      },
    });
  }
  // Sparring zone (owner spec 2026-07-03: a combat-test partner near camp).
  // ONE respawning rogue 80 cells east. TIGHT PER-ZONE LEASH (16): the
  // roaming-zone leash (now 112, activation bookkeeping only — does NOT bound
  // pursuit, see leashRadiusCells above) is intentionally NOT used here. The
  // sparring partner is a perma-respawning combat actor right next to camp,
  // so it gets its own tight 16/16/40 envelope (activation must be <= leash
  // per the Rust validation) and snaps back fast (short releaseTicks) for
  // rematches. This is the ONE documented pop-in exception (it can appear at
  // its known post 80 cells from camp); every roaming zone follows the
  // off-screen rule. DO NOT change these values without an owner ruling.
  const sparringCell = { x: center + 80, y: center };
  zones.push({
    id: "open-desert-sparring-zone",
    actorIdPrefix: "open-desert-sparring",
    templateId: "open-desert-rogue-trooper",
    areaId: overworldAreaId,
    candidateCells: candidateCellsForZone(sparringCell, 2),
    initialCount: 2,
    maxAlive: 2,
    spawnEverySeconds: 15,
    batchMin: 1,
    batchMax: 1,
    seed: mix32(worldSeed ^ 0x50a8_b1d1),
    activation: {
      radiusCells: 16,
      leashRadiusCells: 16,
      deactivationRadiusCells: 40,
      releaseTicks: 120,
      lingerTicks,
      checkEveryTicks: activationCheckEveryTicks,
    },
    encounter: humanoidEncounter(sparringCell, "open-desert-sparring-zone", rogueZoneCount),
  });
  return zones;
}

function scatterZoneCenters(rng, center, options = {}) {
  const count = options.count;
  if (!Number.isInteger(count) || count < 0) {
    throw new Error("scatterZoneCenters requires an explicit non-negative integer count");
  }
  const spacing = options.minSpacingCells ?? minZoneSpacingCells;
  const existingCenters = options.existingCenters ?? [];
  const margin = SCATTER_MARGIN_CELLS;
  const minSpacingSq = spacing * spacing;
  // Exclude the larger of the designer camp-safe radius and the activation
  // envelope, so future activation growth cannot boot-activate roaming zones.
  const campExclusionRadiusCells = Math.max(safeRadiusCells, activationRadiusCells);
  const campExclusionSq = campExclusionRadiusCells * campExclusionRadiusCells;
  const centers = [];
  const maxAttempts = Math.max(1, count) * 4000;
  for (let attempt = 0; centers.length < count && attempt < maxAttempts; attempt += 1) {
    const x = margin + nextRange(rng, 0, areaSize - margin * 2 - 1);
    const y = margin + nextRange(rng, 0, areaSize - margin * 2 - 1);
    const campDx = x - center;
    const campDy = y - center;
    if (campDx * campDx + campDy * campDy <= campExclusionSq) continue;
    if ([...existingCenters, ...centers].some((other) => {
      const dx = x - other.x;
      const dy = y - other.y;
      return dx * dx + dy * dy < minSpacingSq;
    })) {
      continue;
    }
    centers.push({ x, y });
  }
  if (centers.length !== count) {
    throw new Error(`could only place ${centers.length}/${count} spawn zones at min spacing ${spacing}; reduce count or spacing`);
  }
  centers.sort((a, b) => a.y - b.y || a.x - b.x);
  return centers;
}

function assertRoamingZoneCentersOutsideActivation(centers, center) {
  const activationSq = activationRadiusCells * activationRadiusCells;
  const bad = centers.find((cell) => {
    const dx = cell.x - center;
    const dy = cell.y - center;
    return dx * dx + dy * dy <= activationSq;
  });
  if (bad) {
    const d = Math.hypot(bad.x - center, bad.y - center).toFixed(2);
    throw new Error(`roaming spawn zone center ${bad.x},${bad.y} is ${d} cells from camp; must exceed activation radius ${activationRadiusCells}`);
  }
}

function candidateCellsForZone(center, enemyCount) {
  const offsets = [
    { x: 0, y: 0 },
    { x: 1, y: 0 },
    { x: 0, y: 1 },
    { x: 1, y: 1 },
  ];
  return offsets.slice(0, enemyCount).map((offset) => ({
    x: clamp(center.x + offset.x, 1, areaSize - 2),
    y: clamp(center.y + offset.y, 1, areaSize - 2),
  }));
}

function factions() {
  return [
    { id: "desert_wardens", label: "Desert Wardens", playerAllowed: true, enemies: ["rogue_troopers"], allies: [], adjustFactorMilli: 1000 },
    { id: "rogue_troopers", label: "Rogue Troopers", playerAllowed: false, enemies: ["desert_wardens"], allies: [], adjustFactorMilli: 1000 },
    { id: "gaia", label: "Gaia", playerAllowed: false, enemies: [], allies: [], adjustFactorMilli: 1000 },
  ];
}

function humanoidEncounter(centerCell, zoneId, index) {
  const rotation = [0, 90, 180, 270][mix32(worldSeed ^ (index * 0x9e37_79b1)) % 4];
  const mirrored = (mix32(worldSeed ^ (index * 0x85eb_ca6b)) & 1) === 1;
  const spawnPoints = [
    transformCampOffset(centerCell, { x: 6, y: 0 }, rotation, mirrored),
    transformCampOffset(centerCell, { x: 6, y: 1 }, rotation, mirrored),
  ];
  const patrolPoints = [
    transformCampOffset(centerCell, { x: 6, y: 0 }, rotation, mirrored),
    transformCampOffset(centerCell, { x: 7, y: 1 }, rotation, mirrored),
  ];
  return {
    campId: `${zoneId}-camp`,
    rotation,
    mirrored,
    spawnPoints,
    patrolPoints,
    footlockerId: `${zoneId}-footlocker`,
  };
}

function transformCampOffset(center, offset, rotation, mirrored) {
  let x = mirrored ? -offset.x : offset.x;
  let y = offset.y;
  if (rotation === 90) [x, y] = [-y, x];
  else if (rotation === 180) [x, y] = [-x, -y];
  else if (rotation === 270) [x, y] = [y, -x];
  return { x: center.x + x, y: center.y + y };
}
function inventoryRows(zones = []) {
  return [
    inventoryRow("player:field-pack", "Stimpak A", 1001, 0, 4),
    inventoryRow("player:field-pack", "Field Bandage", 1002, 0, 6),
    inventoryRow("player:field-pack", "Iron Slug", 1101, 0, 120),
    inventoryRow("player:field-pack", "Slugthrower", 3101, 0, 1),
    inventoryRow("player:field-pack", "Vibrosword", 3103, 0, 1),
    inventoryRow("player:field-pack", "Plasma Sword", 3104, 0, 1),
    inventoryRow("player:field-pack", "Scrapline Machete", 3105, 0, 1),
    inventoryRow("player:field-pack", "Field Saber", 3106, 0, 1),
    inventoryRow("player:field-pack", "Quarry Chopper", 3107, 0, 1),
    inventoryRow("player:field-pack", "STEN Mk II", 3111, 0, 1),
    inventoryRow("player:field-pack", "Kiln Energy Cell Carbine", 3112, 0, 1),
    inventoryRow("player:field-pack", "Lightning Carbine", 3121, 0, 1),
    inventoryRow("player:field-pack", "Badge Bolt Pistol", 3122, 0, 1),
    inventoryRow("player:field-pack", "Slagrail Vanguard", 3123, 0, 1),
    inventoryRow("player:field-pack", "Coilgate Scatter", 3124, 0, 1),
    inventoryRow("player:field-pack", "Kiln Long Pattern", 3125, 0, 1),
    inventoryRow("player:field-pack", "Bastion LMG", 3126, 0, 1),
    inventoryRow("player:field-pack", "Flare Net Launcher", 3127, 0, 1),
    inventoryRow("player:field-pack", "Personal Shield Generator", 1004, 0, 1),
    ...zones
      .filter((zone) => zone.templateId === "open-desert-rogue-trooper")
      .map((zone) => inventoryRow(`footlocker:${zone.id}-footlocker`, "Field Bandage", 1002, 0, 3)),
  ];
}

// First-session legibility (client-3d first-steps guidance contract): the
// First-session legibility keeps exactly one starter trainer beyond immediate
// interaction range. Encounter footlockers are intentionally remote and are
// not part of the starter objective.
const FIRST_SESSION_TRAINER_MIN_WALK_CELLS = 4;
const FIRST_SESSION_TRAINER_WALK_CELLS = 12;

function assertEnterableFloorMetadata(slice) {
  for (const prop of slice.props ?? []) {
    if (!prop.enterable) continue;
    if (!Number.isFinite(prop.enterable.floorHeightM)) {
      throw new Error(`enterable prop ${prop.id} must declare finite floorHeightM`);
    }
  }
}

function assertStableFixtureGeometry(slice) {
  const banned = new Set([
    "open-desert-cache-01",
    "open-desert-cache-02",
    "open-desert-cache-03",
    "open-desert-camp-fallen-block",
    "open-desert-camp-road-barrier",
    "open-desert-camp-plinth",
    "open-desert-camp-brick",
    "open-desert-camp-brick-shard",
  ]);
  if (slice.props.some((prop) => banned.has(prop.id))) throw new Error("starter clutter remains in fixture props");
  if (slice.inventory.some((row) => row.container.startsWith("cache:"))) throw new Error("starter cache inventory remains in fixture");
  for (const prop of slice.props) {
    if (!prop.size) throw new Error(`prop ${prop.id} has no size`);
    for (const bounds of prop.collisionBounds ?? []) {
      if (![bounds.xMilli, bounds.yMilli, bounds.wMilli, bounds.hMilli].every(Number.isInteger)
        || bounds.xMilli < 0 || bounds.yMilli < 0 || bounds.wMilli <= 0 || bounds.hMilli <= 0
        || bounds.xMilli + bounds.wMilli > prop.size.w * 1000
        || bounds.yMilli + bounds.hMilli > prop.size.h * 1000) {
        throw new Error(`malformed post-rotation collision bounds for ${prop.id}`);
      }
    }
  }
  const functionalIds = new Set([
    dustgateTerminalPropId,
    lowboughTerminalPropId,
    bankTerminalPropId,
    "dustgate-trade-terminal",
    "dustgate-pa-terminal",
    cloningFacilityPropId,
    cloneTerminalPropId,
    clonePodPropId,
    commerceFacilityPropId,
    "dustgate-home-starter",
    "dustgate-home-court",
    "dustgate-home-wing",
  ]);
  for (const id of functionalIds) {
    if (!slice.props.some((prop) => prop.id === id)) throw new Error(`functional prop ${id} missing`);
  }
  const humanoidZones = slice.spawnZones.filter((zone) => zone.templateId === "open-desert-rogue-trooper");
  for (const zone of humanoidZones) {
    if (zone.initialCount !== 2 || zone.encounter?.spawnPoints?.length !== 2 || zone.encounter?.patrolPoints?.length !== 2) {
      throw new Error(`humanoid zone ${zone.id} must have two spawn and patrol points`);
    }
    const blockers = slice.props.filter((prop) => prop.id.startsWith(`${zone.id}-`) && prop.solid);
    for (const point of [...zone.encounter.spawnPoints, ...zone.encounter.patrolPoints]) {
      if (blockers.some((prop) => point.x >= prop.cell.x && point.x < prop.cell.x + prop.size.w
        && point.y >= prop.cell.y && point.y < prop.cell.y + prop.size.h)) {
        throw new Error(`humanoid zone ${zone.id} has spawn/patrol point inside a blocker`);
      }
    }
  }
  const portalProps = slice.props.filter((prop) => prop.interactive && prop.solid);
  for (const left of portalProps) {
    for (const right of portalProps) {
      if (left.id >= right.id) continue;
      if (left.areaId === right.areaId && left.cell.x < right.cell.x + right.size.w && left.cell.x + left.size.w > right.cell.x
        && left.cell.y < right.cell.y + right.size.h && left.cell.y + left.size.h > right.cell.y) {
        throw new Error(`interactive blocker overlap ${left.id}/${right.id}`);
      }
    }
  }


  const occupation = slice.props.filter((prop) => prop.id.startsWith("dustgate-occupation-"));
  if (occupation.length < 10 || occupation.length > 16) {
    throw new Error(`dustgate occupation pack must place 10-16 props, got ${occupation.length}`);
  }
  const occupationIds = occupation.map((prop) => prop.id).sort();
  if (new Set(occupationIds).size !== occupationIds.length) {
    throw new Error("dustgate occupation pack has duplicate prop ids");
  }
  for (const prop of occupation) {
    if (prop.interactive && prop.id !== "dustgate-occupation-workbench") throw new Error(`occupation prop ${prop.id} must stay noninteractive`);
    if (prop.solid) throw new Error(`occupation prop ${prop.id} must stay noncollision/detail`);
    if (prop.collisionBounds?.length) throw new Error(`occupation prop ${prop.id} must not carry collisionBounds`);
    if (!prop.assetKey || !String(prop.assetKey).startsWith("everyday_")) {
      throw new Error(`occupation prop ${prop.id} must use everyday_* assetKey`);
    }
    if (prop.areaId !== overworldAreaId) throw new Error(`occupation prop ${prop.id} must stay in Dustgate overworld`);
  }
  const clearance = dustgateOccupationClearanceRects(layoutFromSlice(slice));
  for (const prop of occupation) {
    const rect = propFootprintRect(prop);
    for (const zone of clearance) {
      if (rectsOverlap(rect, zone.rect)) {
        throw new Error(`occupation prop ${prop.id} overlaps clearance ${zone.id}`);
      }
    }
    for (const other of occupation) {
      if (other.id <= prop.id) continue;
      if (rectsOverlap(rect, propFootprintRect(other))) {
        throw new Error(`occupation props overlap ${prop.id}/${other.id}`);
      }
    }
  }
}

function assertFirstSessionLegibility(slice) {
  const player = slice.actors.find((actor) => actor.role === "player");
  if (!player) throw new Error("first-session: no player actor in slice");
  const spawn = player.cell;
  const trainers = slice.actors.filter((actor) => actor.areaId === player.areaId && actor.role === "profession_trainer");
  if (trainers.length !== 1) {
    throw new Error(`first-session: expected exactly one starter trainer in ${player.areaId}, got ${trainers.length}`);
  }
  const trainerDistance = Math.hypot(trainers[0].cell.x - spawn.x, trainers[0].cell.y - spawn.y);
  if (trainerDistance > FIRST_SESSION_TRAINER_WALK_CELLS) {
    throw new Error(`first-session: trainer is ${trainerDistance.toFixed(2)} cells from spawn; must stay within ${FIRST_SESSION_TRAINER_WALK_CELLS}`);
  }
  if (trainerDistance < FIRST_SESSION_TRAINER_MIN_WALK_CELLS) {
    throw new Error(`first-session: trainer is only ${trainerDistance.toFixed(2)} cells from spawn; must exceed ${FIRST_SESSION_TRAINER_MIN_WALK_CELLS} so the objective is a real walk`);
  }
  const grok = slice.actors.find((actor) => actor.id === "grok");
  if (grok && grok.role !== "scripted_player") {
    throw new Error(`first-session: GR0K must stay scripted_player (got ${grok.role})`);
  }
}

function inventoryRow(container, item, itemId, variantId, quantity) {
  return { container, item, itemId, variantId, quantity, reserved: 0, available: quantity };
}

/**
 * Structure collision remains mesh-derived. The sidecar carries GLB-local
 * triangle-slice AABBs; the shared geometry helper applies composePlacement's
 * recenter, cardinal yaw, uniform fit, and prop-local millicell clamp.
 */
function assertPromisedCellsClear(collision, cellSize) {
  const promised = collision.contract?.terminal_cells_kept_clear;
  if (!promised || typeof promised !== "object") {
    throw new Error("market collision sidecar must declare terminal_cells_kept_clear");
  }
  for (const [terminalId, cell] of Object.entries(promised)) {
    if (!Array.isArray(cell) || cell.length !== 2 || !cell.every(Number.isInteger)) {
      throw new Error(`commerce terminal clearance cell is malformed for ${terminalId}`);
    }
    const [col, row] = cell;
    const cellMinX = col * 1000;
    const cellMaxX = (col + 1) * 1000;
    const cellMinY = row * 1000;
    const cellMaxY = (row + 1) * 1000;
    const doorBlocker = collision.door?.blocker ?? collision.door;
    const blockers = [...collision.walls, ...collision.furniture, doorBlocker].filter(Boolean);
    const overlap = blockers.find((box) => (
      Math.min(box.xMilli + box.wMilli, cellMaxX) > Math.max(box.xMilli, cellMinX)
      && Math.min(box.yMilli + box.hMilli, cellMaxY) > Math.max(box.yMilli, cellMinY)
    ));
    if (overlap) {
      throw new Error(`commerce collision blocker ${overlap.id ?? "unnamed"} overlaps promised ${terminalId} cell (${col},${row})`);
    }
  }
}

function structureCollisionFromSidecar({ glbName, cellSize, rotation = 0 }) {
  const sidecarPath = path.join(repoRoot, "client-3d", "public", "assets", "world-items", `${glbName}_collision.json`);
  if (!fs.existsSync(sidecarPath)) throw new Error(`missing required collision sidecar ${path.relative(repoRoot, sidecarPath)}`);
  let sidecar;
  try {
    sidecar = JSON.parse(fs.readFileSync(sidecarPath, "utf8"));
  } catch (error) {
    throw new Error(`malformed collision sidecar ${path.relative(repoRoot, sidecarPath)}: ${error.message}`);
  }
  if (!sidecar || typeof sidecar !== "object" || !sidecar.footprint || !Array.isArray(sidecar.walls)) {
    throw new Error(`malformed collision sidecar ${path.relative(repoRoot, sidecarPath)}: footprint and walls are required`);
  }
  return { ...transformStructureCollision(sidecar, cellSize, rotation), contract: sidecar.contract };
}

function enterableStructureCollision({ glbName, cellSize, rotation }) {
  const collision = structureCollisionFromSidecar({ glbName, cellSize, rotation });
  if (!collision.door) throw new Error(`${glbName} sidecar carries no exterior door box`);
  if (collision.walls.length === 0) throw new Error(`${glbName} sidecar carries no wall boxes`);
  if (!Array.isArray(collision.interiorRegions) || collision.interiorRegions.length === 0) {
    throw new Error(`${glbName} sidecar carries no interior regions`);
  }
  if (!Number.isFinite(collision.floorTopM)) {
    throw new Error(`${glbName} sidecar carries no finite floor top`);
  }
  const doorPoints = deriveStructureDoorPoints({
    walls: collision.walls,
    door: collision.door,
    cellSize,
  });
  return {
    ...collision,
    collisionBounds: [...collision.walls, ...collision.furniture],
    door: {
      blocker: collision.door,
      interactRadiusCells: 3.1,
    },
    safeExterior: doorPoints.exterior,
    safeInterior: doorPoints.interior,
  };
}


function props(center, layout, zones) {
  const enterableBuilding = (id, label, assetKey, building) => worldProp({
    id,
    label,
    kind: "building",
    assetKey,
    cell: { ...building.cell },
    size: { ...building.size },
    solid: false,
    interactive: false,
    shelter: true,
    collisionBounds: building.collisionBounds,
    interiorRegions: building.interiorRegions,
    door: building.door,
    enterable: {
      floorHeightM: building.floorTopM,
      interiorBounds: building.interiorRegions.map(
        ({ xMilli, yMilli, wMilli, hMilli }) => ({ xMilli, yMilli, wMilli, hMilli }),
      ),
    },
    rotation: building.rotation === 0 ? undefined : building.rotation,
  });
  const serviceProps = [
    enterableBuilding(cloningFacilityPropId, "Dustgate Cloning Facility", "cloning_facility", layout.facility),
    enterableBuilding(commerceFacilityPropId, "Valley Market", "valley_market", layout.market),
    enterableBuilding("dustgate-home-starter", "Modular Starter Home", "home_modular_starter", layout.starter),
    enterableBuilding("dustgate-home-court", "Modular Court Home", "home_modular_court", layout.court),
    enterableBuilding("dustgate-home-wing", "Modular Wing Home", "home_modular_wing", layout.wing),
    terminalProp(bankTerminalPropId, "Dustgate Bank Terminal", "bank_terminal_civic", "bank_terminal", layout.bankTerminal, "bank_terminal"),
    terminalProp("dustgate-trade-terminal", "Dustgate Trade Terminal", "trade_terminal", "trade_terminal", layout.tradeTerminal, "trade_terminal"),
    terminalProp("dustgate-pa-terminal", "Dustgate PA Terminal", "pa_terminal", "pa_terminal", layout.paTerminal, "pa_terminal"),
    travelTerminal(dustgateTerminalPropId, "Travel Terminal — Dustgate", overworldAreaId, { x: center + 12, y: center }),
    travelTerminal(lowboughTerminalPropId, "Travel Terminal — Lowbough", verdanceAreaId, { x: center + 12, y: center }),
    terminalProp(cloneTerminalPropId, "Clone Terminal", "clone_terminal", "clone_terminal", layout.cloneTerminal, "clone_terminal"),
    terminalProp(clonePodPropId, "Clone Pod", "clone_pod", "clone_pod", layout.clonePod, "clone_pod"),
  ];
  return [
    ...serviceProps,
    ...dustgateOccupationProps(layout),
    ...zones
      .filter((zone) => zone.templateId === "open-desert-rogue-trooper" && zone.encounter)
      .flatMap((zone) => campPropsForZone(zone)),
  ];
}

function campPropsForZone(zone) {
  const encounter = zone.encounter;
  const center = zone.candidateCells[0];
  const rotation = encounter.rotation;
  const mirrored = encounter.mirrored;
  const offsetCell = (offset) => transformCampOffset(center, offset, rotation, mirrored);
  const shelterCell = offsetCell({ x: -1, y: -1 });
  const shelterSize = { w: 3, h: 2 };
  const shelterCollision = structureCollisionFromSidecar({
    glbName: "shelter_frontier",
    cellSize: shelterSize,
    rotation,
  });
  const blocker = (id, size, offset, inset = 0.12) => {
    const cell = offsetCell(offset);
    const prop = worldProp({
      id: `${zone.id}-${id}`,
      label: id.replaceAll("-", " "),
      kind: "prop",
      assetKey: id === "footlocker" ? "footlocker_frontier" : id === "chair-a" ? "chair_frontier_a" : id === "chair-b" ? "chair_frontier_b" : `${id}_frontier`,
      cell,
      size,
      solid: true,
      interactive: id === "footlocker",
      rotation: rotation === 0 ? undefined : rotation,
      collisionBounds: placedCollisionFromManifest({
        assetKey: id === "footlocker" ? "footlocker_frontier" : id === "chair-a" ? "chair_frontier_a" : id === "chair-b" ? "chair_frontier_b" : `${id}_frontier`,
        size,
        rotation,
      }),
    });
    if (id === "footlocker") {
      prop.kind = "storage_chest";
      prop.container = `footlocker:${zone.id}-footlocker`;
      prop.takeOnly = true;
    }
    return prop;
  };
  return [
    worldProp({
      id: `${zone.id}-shelter`,
      label: "Frontier Shelter",
      kind: "building",
      assetKey: "shelter_frontier",
      cell: shelterCell,
      size: shelterSize,
      solid: false,
      interactive: false,
      shelter: true,
      collisionBounds: shelterCollision.walls,
      enterable: {
        floorHeightM: 0,
        interiorBounds: shelterCollision.interiorRegions,
      },
      rotation: rotation === 0 ? undefined : rotation,
    }),
    blocker("footlocker", { w: 1, h: 1 }, { x: 2, y: 0 }, 0.15),
    blocker("campfire", { w: 2, h: 2 }, { x: 0, y: 3 }, 0.18),
    blocker("chair-a", { w: 1, h: 1 }, { x: -1, y: 3 }, 0.15),
    blocker("chair-b", { w: 1, h: 1 }, { x: 2, y: 3 }, 0.15),
    blocker("grill", { w: 2, h: 1 }, { x: 3, y: 2 }, 0.12),
  ];
}


/**
 * Sparse Dustgate occupation around the commerce/work-yard apron.
 * Mostly detail-only everyday props (noncollision). The occupation workbench is the physical factory anchor. Kept outside door
 * mouths, terminal cells, trainer/GR0K stands, spawn, and travel approach.
 */
function dustgateOccupationProps(layout) {
  const placements = [
        // Vendor shade west of the commerce door mouth (door mouth keeps x 504-508 clear).
    // Vendor shade west of the commerce door mouth (door mouth keeps x 504-508 clear).
    { id: "dustgate-occupation-vendor-awning", label: "Vendor Awning", assetKey: "everyday_vendor_awning", cell: { x: 500, y: 509 }, size: { w: 2, h: 1 }, rotation: 0 },
    { id: "dustgate-occupation-wicker-display", label: "Wicker Display", assetKey: "everyday_wicker_display_stand", cell: { x: 502, y: 510 }, size: { w: 1, h: 1 }, rotation: 0 },
    { id: "dustgate-occupation-price-sign", label: "Price Sign", assetKey: "everyday_price_sign_slate", cell: { x: 499, y: 509 }, size: { w: 1, h: 1 }, rotation: 0 },
    { id: "dustgate-occupation-crate-open", label: "Open Crate", assetKey: "everyday_wooden_crate_open", cell: { x: 502, y: 509 }, size: { w: 1, h: 1 }, rotation: 90 },
    { id: "dustgate-occupation-burlap-sack", label: "Burlap Sack", assetKey: "everyday_burlap_sack_full", cell: { x: 501, y: 510 }, size: { w: 1, h: 1 }, rotation: 0 },
    { id: "dustgate-occupation-paper-bags", label: "Paper Bags", assetKey: "everyday_paper_bags_stack", cell: { x: 500, y: 510 }, size: { w: 1, h: 1 }, rotation: 0 },
    // Work / repair yard west of commerce, south of the facility apron (y >= 508).
    { id: "dustgate-occupation-workbench", label: "Workbench", assetKey: "everyday_workbench", cell: { x: 494, y: 508 }, size: { w: 2, h: 1 }, rotation: 0 },
    { id: "dustgate-occupation-sawhorses", label: "Sawhorses", assetKey: "everyday_sawhorse_pair", cell: { x: 494, y: 509 }, size: { w: 2, h: 1 }, rotation: 0 },
    { id: "dustgate-occupation-lumber", label: "Lumber Stack", assetKey: "everyday_lumber_stack", cell: { x: 493, y: 508 }, size: { w: 1, h: 2 }, rotation: 0 },
    { id: "dustgate-occupation-pallet", label: "Wooden Pallet", assetKey: "everyday_wooden_pallet", cell: { x: 496, y: 510 }, size: { w: 1, h: 1 }, rotation: 0 },
    { id: "dustgate-occupation-brick-stack", label: "Brick Stack", assetKey: "everyday_brick_stack", cell: { x: 497, y: 510 }, size: { w: 1, h: 1 }, rotation: 0 },
    { id: "dustgate-occupation-cement-bag", label: "Cement Bag", assetKey: "everyday_cement_bag", cell: { x: 498, y: 510 }, size: { w: 1, h: 1 }, rotation: 0 },
    { id: "dustgate-occupation-wheelbarrow", label: "Wheelbarrow", assetKey: "everyday_wheelbarrow", cell: { x: 493, y: 510 }, size: { w: 1, h: 1 }, rotation: 90 },
    { id: "dustgate-occupation-bucket", label: "Construction Bucket", assetKey: "everyday_bucket_construction", cell: { x: 495, y: 510 }, size: { w: 1, h: 1 }, rotation: 0 },
    // One civic lamp at the west work-yard edge.
    { id: "dustgate-occupation-street-lamp", label: "Street Lamp", assetKey: "everyday_street_lamp_post", cell: { x: 492, y: 508 }, size: { w: 1, h: 1 }, rotation: 0 },
  ];
  if (placements.length < 10 || placements.length > 16) {
    throw new Error(`dustgate occupation authoring must stay 10-16 props, got ${placements.length}`);
  }
  const props = placements.map((placement) => {
    const isFactory = placement.id === "dustgate-occupation-workbench";
    return worldProp({
      id: placement.id,
      entity: `prop:${overworldAreaId}:${placement.id}`,
      label: isFactory ? "Factory Workbench" : placement.label,
      kind: isFactory ? "factory" : "prop",
      assetKey: placement.assetKey,
      cell: { ...placement.cell },
      size: { ...placement.size },
      solid: false,
      interactive: isFactory,
      rotation: placement.rotation === 0 ? undefined : placement.rotation,
    });
  });
  const clearance = dustgateOccupationClearanceRects(layout);
  for (const prop of props) {
    const rect = propFootprintRect(prop);
    for (const zone of clearance) {
      if (rectsOverlap(rect, zone.rect)) {
        throw new Error(`dustgate occupation ${prop.id} overlaps clearance ${zone.id}`);
      }
    }
  }
  for (let i = 0; i < props.length; i += 1) {
    for (let j = i + 1; j < props.length; j += 1) {
      if (rectsOverlap(propFootprintRect(props[i]), propFootprintRect(props[j]))) {
        throw new Error(`dustgate occupation overlap ${props[i].id}/${props[j].id}`);
      }
    }
  }
  return props;
}

function layoutFromSlice(slice) {
  const byId = Object.fromEntries((slice.props ?? []).map((prop) => [prop.id, prop]));
  const center = Math.floor((slice.zone?.width ?? areaSize) / 2);
  const requireProp = (id) => {
    const prop = byId[id];
    if (!prop) throw new Error(`layoutFromSlice missing ${id}`);
    return prop;
  };
  const market = requireProp(commerceFacilityPropId);
  const facility = requireProp("dustgate-cloning-facility");
  const starter = requireProp("dustgate-home-starter");
  const court = requireProp("dustgate-home-court");
  const wing = requireProp("dustgate-home-wing");
  const player = (slice.actors ?? []).find((actor) => actor.id === "player");
  if (!player) throw new Error("layoutFromSlice missing player");
  return {
    center: { x: center, y: center },
    playerSpawn: { ...player.cell },
    bankTerminal: { ...requireProp("dustgate-bank-terminal").cell },
    tradeTerminal: { ...requireProp("dustgate-trade-terminal").cell },
    paTerminal: { ...requireProp("dustgate-pa-terminal").cell },
    cloneTerminal: { ...requireProp("dustgate-clone-terminal").cell },
    clonePod: { ...requireProp("dustgate-clone-pod").cell },
    market: { cell: { ...market.cell }, size: { ...market.size } },
    facility: { cell: { ...facility.cell }, size: { ...facility.size } },
    starter: { cell: { ...starter.cell }, size: { ...starter.size } },
    court: { cell: { ...court.cell }, size: { ...court.size } },
    wing: { cell: { ...wing.cell }, size: { ...wing.size } },
  };
}

function dustgateOccupationClearanceRects(layout) {
  const rects = [];
  const addCell = (id, cell, pad = 1) => {
    rects.push({
      id,
      rect: {
        x0: cell.x - pad,
        y0: cell.y - pad,
        x1: cell.x + 1 + pad,
        y1: cell.y + 1 + pad,
      },
    });
  };
  addCell("player-spawn", layout.playerSpawn, 2);
  addCell("grok", { x: layout.center.x - 2, y: layout.center.y + 2 }, 1);
  addCell("knox", { x: layout.center.x - 2, y: layout.center.y - 8 }, 1);
  addCell("travel-terminal-dustgate", { x: layout.center.x + 12, y: layout.center.y }, 2);
  addCell("bank-terminal", layout.bankTerminal, 1);
  addCell("trade-terminal", layout.tradeTerminal, 1);
  addCell("pa-terminal", layout.paTerminal, 1);
  addCell("clone-terminal", layout.cloneTerminal, 1);
  addCell("clone-pod", layout.clonePod, 1);
  for (const [id, building] of [
    ["valley-market", layout.market],
    ["cloning-facility", layout.facility],
    ["modular-starter", layout.starter],
    ["modular-court", layout.court],
    ["modular-wing", layout.wing],
  ]) {
    rects.push({
      id: `${id}-footprint`,
      rect: {
        x0: building.cell.x - 1,
        y0: building.cell.y - 1,
        x1: building.cell.x + building.size.w + 1,
        y1: building.cell.y + building.size.h + 1,
      },
    });
  }
  rects.push({
    id: "market-door-mouth",
    rect: {
      x0: layout.market.cell.x + 4,
      y0: layout.market.cell.y + layout.market.size.h,
      x1: layout.market.cell.x + 8,
      y1: layout.market.cell.y + layout.market.size.h + 3,
    },
  });
  rects.push({
    id: "clone-door-mouth",
    rect: {
      x0: layout.facility.cell.x + 3,
      y0: layout.facility.cell.y + layout.facility.size.h,
      x1: layout.facility.cell.x + 7,
      y1: layout.facility.cell.y + layout.facility.size.h + 3,
    },
  });
  rects.push({
    id: "plaza-lane",
    rect: {
      x0: layout.center.x - 1,
      y0: layout.center.y - 12,
      x1: layout.center.x + 2,
      y1: layout.center.y + 3,
    },
  });
  return rects;
}

function propFootprintRect(prop) {
  return {
    x0: prop.cell.x,
    y0: prop.cell.y,
    x1: prop.cell.x + prop.size.w,
    y1: prop.cell.y + prop.size.h,
  };
}

function rectsOverlap(a, b) {
  return a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0;
}

function noClaimZones(center) {
  return [
    { areaId: overworldAreaId, centerX: center, centerY: center, halfExtentCells: 64, label: "Dustgate hub" },
  ];
}

function terminalProp(id, label, assetKey, kind, cell, proxyId) {
  return worldProp({
    id,
    label,
    kind,
    assetKey,
    cell,
    size: { w: 1, h: 1 },
    solid: true,
    interactive: true,
    collisionBounds: ["bank_terminal_civic", "trade_terminal", "pa_terminal"].includes(assetKey)
      ? placedCollisionFromManifest({ assetKey, size: { w: 1, h: 1 }, rotation: travelTerminalScreenFacingRotation })
      : stableProxyBounds(proxyId, { w: 1, h: 1 }, travelTerminalScreenFacingRotation, 0.18),
    rotation: travelTerminalScreenFacingRotation,
  });
}

function placedCollisionFromManifest({ assetKey, size, rotation }) {
  const manifestPath = path.join(repoRoot, "client-3d", "public", "assets", "world-items", `${assetKey}_manifest.json`);
  if (!fs.existsSync(manifestPath)) throw new Error(`missing required collision manifest ${path.relative(repoRoot, manifestPath)}`);
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch (error) {
    throw new Error(`malformed collision manifest ${path.relative(repoRoot, manifestPath)}: ${error.message}`);
  }
  const boxes = manifest?.collision?.boxes ?? (manifest?.collisionProxy ? [manifest.collisionProxy] : null);
  const proxyMin = boxes?.[0]?.min;
  const proxyMax = boxes?.[0]?.max;
  const rawMin = Array.isArray(manifest?.bbox_min_m) ? manifest.bbox_min_m : proxyMin;
  const rawMax = Array.isArray(manifest?.bbox_max_m) ? manifest.bbox_max_m : proxyMax;
  const collisionFootprint = manifest?.collision?.footprint;
  const span = Array.isArray(collisionFootprint)
    ? collisionFootprint
    : manifest?.bbox_span_m
      ?? (rawMin && rawMax ? [Number(rawMax[0]) - Number(rawMin[0]), 0, Number(rawMax[2]) - Number(rawMin[2])] : null);
  if (!Array.isArray(boxes) || boxes.length === 0 || !Array.isArray(span) || span.length < 3) {
    throw new Error(`malformed collision manifest ${path.relative(repoRoot, manifestPath)}: collision.boxes and footprint are required`);
  }
  const boxMinX = Math.min(...boxes.map((box) => Number(box.min?.[0])));
  const boxMinZ = Math.min(...boxes.map((box) => Number(box.min?.[2])));
  const boxMaxX = Math.max(...boxes.map((box) => Number(box.max?.[0])));
  const boxMaxZ = Math.max(...boxes.map((box) => Number(box.max?.[2])));
  const footprint = {
    minX: Math.min(rawMin ? Number(rawMin[0]) : Number.POSITIVE_INFINITY, boxMinX),
    minZ: Math.min(rawMin ? Number(rawMin[2]) : Number.POSITIVE_INFINITY, boxMinZ),
    maxX: Math.max(rawMax ? Number(rawMax[0]) : Number.NEGATIVE_INFINITY, boxMaxX),
    maxZ: Math.max(rawMax ? Number(rawMax[2]) : Number.NEGATIVE_INFINITY, boxMaxZ),
    centerX: 0,
    centerZ: 0,
  };
  footprint.centerX = (footprint.minX + footprint.maxX) / 2;
  footprint.centerZ = (footprint.minZ + footprint.maxZ) / 2;
  return stablePlacedCollisionBounds({
    boxes: boxes.map((box) => ({
      id: box.id,
      minX: Number(box.min?.[0]),
      minZ: Number(box.min?.[2]),
      maxX: Number(box.max?.[0]),
      maxZ: Number(box.max?.[2]),
    })),
    footprint,
    cellSize: size,
    rotation,
  });
}

function stableProxyBounds(proxyId, size, rotation, inset) {
  const footprint = {
    minX: -size.w / 2,
    minZ: -size.h / 2,
    maxX: size.w / 2,
    maxZ: size.h / 2,
    centerX: 0,
    centerZ: 0,
  };
  const halfInsetX = Math.min(inset, size.w / 2 - 0.001);
  const halfInsetY = Math.min(inset, size.h / 2 - 0.001);
  return stablePlacedCollisionBounds({
    boxes: [{
      id: proxyId,
      minX: footprint.minX + halfInsetX,
      minZ: footprint.minZ + halfInsetY,
      maxX: footprint.maxX - halfInsetX,
      maxZ: footprint.maxZ - halfInsetY,
    }],
    footprint,
    cellSize: size,
    rotation,
  });
}

function travelTerminal(id, label, areaId, cell) {
  return worldProp({
    id,
    entity: `travel:${areaId}:${id}`,
    areaId,
    label,
    kind: "travel_terminal",
    assetKey: "travel_terminal",
    cell,
    size: { w: 1, h: 1 },
    solid: true,
    interactive: true,
    collisionBounds: stableProxyBounds(id, { w: 1, h: 1 }, travelTerminalScreenFacingRotation, 0.18),
    rotation: travelTerminalScreenFacingRotation,
  });
}

function coverProp(id, label, assetKey, cell, size) {
  return worldProp({
    id,
    entity: `cover:open-desert:${id}`,
    label,
    kind: "prop",
    assetKey,
    cell,
    size,
    // Owner diagnostic ruling (2026-07-04): collision OFF — cover props are
    // cosmetic. Restore by re-adding: solid: true, collisionBounds:
    // [{ xMilli: 0, yMilli: 0, wMilli: size.w * 1000, hMilli: size.h * 1000 }].
    solid: false,
    cover: { rating: 70, height: "high" },
  });
}
function worldProp({ id, entity, areaId = overworldAreaId, label, kind = "prop", assetKey, cell, size, solid = false, cover, collisionBounds, interiorRegions, door, interactive = false, rotation, shelter, enterable }) {
  const prop = {
    id,
    entity: entity ?? `prop:${areaId}:${id}`,
    areaId,
    label,
    kind,
    assetKey,
    cell,
    size,
    interactive,
    solid,
    visible: true,
  };
  if (cover) prop.cover = cover;
  if (collisionBounds) prop.collisionBounds = collisionBounds;
  if (interiorRegions) prop.interiorRegions = interiorRegions;
  if (door) prop.door = door;
  if (rotation !== undefined) prop.rotation = rotation;
  if (shelter !== undefined) prop.shelter = shelter;
  if (enterable) prop.enterable = enterable;
  return prop;
}

function blockedCellsForProp(prop) {
  if (!prop.solid) return [];
  const cells = [];
  for (let y = prop.cell.y; y < prop.cell.y + prop.size.h; y += 1) {
    for (let x = prop.cell.x; x < prop.cell.x + prop.size.w; x += 1) cells.push({ areaId: prop.areaId, x, y });
  }
  return cells;
}

function rebuildMapBundle(slicePath, bundlePath) {
  const compilerPath = path.join(repoRoot, "tools", "successor", "compile-map-bundle.mjs");
  const result = spawnSync(process.execPath, [compilerPath, "--write", `--slice=${slicePath}`, `--out=${bundlePath}`], {
    cwd: repoRoot,
    stdio: "inherit",
    env: process.env,
  });
  if (result.status !== 0) {
    throw new Error(`open-desert map bundle rebuild failed with status ${result.status ?? "unknown"}`);
  }
}

function xorshift32(seed) {
  let state = seed >>> 0;
  if (state === 0) state = 0x6d2b_79f5;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 0;
  };
}

function mix32(value) {
  let state = value >>> 0;
  state ^= state >>> 16;
  state = Math.imul(state, 0x7feb_352d) >>> 0;
  state ^= state >>> 15;
  state = Math.imul(state, 0x846c_a68b) >>> 0;
  state ^= state >>> 16;
  return state >>> 0;
}

function nextRange(rng, min, max) {
  if (max < min) return min;
  const span = max - min + 1;
  return min + (rng() % span);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function integerOption(argName, envName, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const argPrefix = `${argName}=`;
  const argValue = process.argv.find((arg) => arg.startsWith(argPrefix))?.slice(argPrefix.length);
  const raw = argValue ?? process.env[envName];
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${envName}/${argName} must be an integer from ${min} to ${max}; got ${raw}`);
  }
  return parsed;
}

main();
