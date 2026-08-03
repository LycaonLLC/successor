#!/usr/bin/env node
/**
 * Packages the approved furnished Valley Market build as the standalone runtime
 * handoff. The authoring build remains untouched under build/; this script
 * converts its three-dimensional authored collision boxes into the runtime
 * XZ sidecar shape and writes only the four handoff files.
 *
 * Run after gen_textures.py, build_market.py, post_gltf.mjs, and manifest.py:
 *   node src/package_runtime.mjs
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";

const sourceRoot = path.resolve(import.meta.dirname, "..");
const repoRoot = path.resolve(sourceRoot, "../../../..");
const buildRoot = path.join(sourceRoot, "build");
const packageRoot = path.join(repoRoot, "runtime-buildings", "market");

const runtimeKey = "valley_market";
const files = Object.freeze({
  glb: "valley_market.glb",
  collision: "valley_market_collision.json",
  manifest: "valley_market_manifest.json",
  provenance: "valley_market.provenance.json",
});
const requiredClearCells = Object.freeze({
  bank_terminal_civic: [3, 3],
  trade_terminal: [6, 3],
  pa_terminal: [9, 3],
  trainer_npc: [10, 6],
});
const fixtureNames = Object.freeze({
  bank: "bank_terminal_civic",
  trade: "trade_terminal",
  assoc: "pa_terminal",
  trainer: "trainer_npc",
});
const collisionBodyTopM = 1.85;
const floorTopM = 0.02;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sha256(data) {
  return createHash("sha256").update(data).digest("hex");
}

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

function writeJson(file, value) {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function sameJson(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function parseGlbJson(bytes) {
  assert(bytes.length >= 20, "GLB is too short");
  assert(bytes.toString("ascii", 0, 4) === "glTF", "GLB magic is missing");
  assert(bytes.readUInt32LE(4) === 2, "GLB must be version 2");
  assert(bytes.readUInt32LE(8) === bytes.length, "GLB header length does not match file length");
  const jsonLength = bytes.readUInt32LE(12);
  assert(bytes.readUInt32LE(16) === 0x4e4f534a, "GLB JSON chunk is missing");
  const jsonEnd = 20 + jsonLength;
  assert(jsonEnd <= bytes.length, "GLB JSON chunk exceeds file length");
  return JSON.parse(bytes.toString("utf8", 20, jsonEnd).trim());
}

function embeddedImageSummary(gltf) {
  const images = gltf.images ?? [];
  assert(images.length > 0, "furnished GLB has no images to package");
  let externalImageUris = 0;
  for (const [index, image] of images.entries()) {
    if (Object.hasOwn(image, "uri")) externalImageUris += 1;
    assert(!Object.hasOwn(image, "uri"), `image ${index} has a URI instead of an embedded bufferView`);
    assert(Number.isInteger(image.bufferView), `image ${index} has no embedded bufferView`);
    assert(typeof image.mimeType === "string" && image.mimeType.length > 0,
      `image ${index} has no MIME type`);
  }
  for (const [index, buffer] of (gltf.buffers ?? []).entries()) {
    assert(!Object.hasOwn(buffer, "uri"), `buffer ${index} has an external URI`);
  }
  return { image_count: images.length, external_image_uri_count: externalImageUris };
}

function runtimeBox(box, footprint) {
  assert(box && typeof box === "object", "source collision has an invalid box");
  assert(Array.isArray(box.min) && box.min.length === 3 && Array.isArray(box.max) && box.max.length === 3,
    `source collision box ${box.id ?? "<unnamed>"} has invalid bounds`);
  const [minX, minY, minZ] = box.min;
  const [maxX, maxY, maxZ] = box.max;
  assert([minX, minY, minZ, maxX, maxY, maxZ].every(isFiniteNumber),
    `source collision box ${box.id ?? "<unnamed>"} has non-finite bounds`);
  assert(maxX > minX && maxY > minY && maxZ > minZ,
    `source collision box ${box.id ?? "<unnamed>"} has empty bounds`);
  const epsilon = 1e-6;
  assert(minX >= footprint.minX - epsilon && maxX <= footprint.maxX + epsilon
    && minZ >= footprint.minZ - epsilon && maxZ <= footprint.maxZ + epsilon,
  `source collision box ${box.id ?? "<unnamed>"} exceeds the 12x9 footprint`);
  return { id: box.id, minX, minZ, maxX, maxZ };
}

function overlaps(a, b) {
  return Math.min(a.maxX, b.maxX) > Math.max(a.minX, b.minX)
    && Math.min(a.maxZ, b.maxZ) > Math.max(a.minZ, b.minZ);
}

function cellBounds(footprint, cellM, [column, row]) {
  return {
    minX: footprint.minX + column * cellM,
    maxX: footprint.minX + (column + 1) * cellM,
    minZ: footprint.minZ + row * cellM,
    maxZ: footprint.minZ + (row + 1) * cellM,
  };
}

function assertPromisedCellsClear({ footprint, cellM, walls, furniture, door }) {
  const blockers = [...walls, ...furniture, door];
  for (const [name, cell] of Object.entries(requiredClearCells)) {
    const occupied = cellBounds(footprint, cellM, cell);
    const overlap = blockers.find((box) => overlaps(box, occupied));
    assert(!overlap, `${overlap?.id ?? "collision blocker"} overlaps promised ${name} cell (${cell.join(",")})`);
  }
}

function touchedDoorCells(footprint, cellM, columns, rows, door) {
  const cells = [];
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      if (overlaps(door, cellBounds(footprint, cellM, [column, row]))) {
        cells.push([column, row]);
      }
    }
  }
  assert(cells.length > 0, "exterior door does not intersect any declared footprint cell");
  return cells;
}

function authoringInteriorRegions(sourceManifest) {
  const regions = sourceManifest.interior_bounds_authoring_m;
  assert(regions && typeof regions === "object", "source manifest has no authored interior bounds");
  return Object.entries(regions).map(([id, region]) => {
    assert(Array.isArray(region.x) && region.x.length === 2 && Array.isArray(region.y) && region.y.length === 2,
      `source interior region ${id} has invalid bounds`);
    const [minX, maxX] = region.x;
    const [minAuthoringY, maxAuthoringY] = region.y;
    assert([minX, maxX, minAuthoringY, maxAuthoringY].every(isFiniteNumber)
      && maxX > minX && maxAuthoringY > minAuthoringY,
    `source interior region ${id} has non-positive bounds`);
    return {
      id,
      minX,
      minZ: -maxAuthoringY,
      maxX,
      maxZ: -minAuthoringY,
      floorTopY: floorTopM,
    };
  });
}

function sourceContract(sourceManifest) {
  const grid = sourceManifest.authority_grid;
  assert(grid && grid.cols === 12 && grid.rows === 9 && grid.cell_m === 0.95,
    "source manifest no longer declares the 12x9 @ 0.95m contract");
  assert(sourceManifest.gltf_conventions?.up === "+Y" && sourceManifest.gltf_conventions?.front === "+Z (public side)",
    "source manifest has unexpected glTF axes");
  assert(sourceManifest.gltf_conventions?.floor_top_y_m === floorTopM,
    "source manifest has an unexpected floor top");
  const max = sourceManifest.footprint_max_m;
  assert(max?.x === 11.4 && max?.z === 8.55, "source manifest has an unexpected footprint");
  for (const [sourceName, runtimeName] of Object.entries(fixtureNames)) {
    assert(sameJson(sourceManifest.fixture_cells?.[sourceName]?.cell, requiredClearCells[runtimeName]),
      `source fixture cell drifted for ${runtimeName}`);
  }
}

function main() {
  const sourceGlbPath = path.join(buildRoot, "market_house_furnished.glb");
  const sourceCollisionPath = path.join(buildRoot, "market_house.collision.json");
  const sourceManifestPath = path.join(buildRoot, "market_house.manifest.json");
  for (const file of [sourceGlbPath, sourceCollisionPath, sourceManifestPath]) {
    assert(existsSync(file), `missing build input ${path.relative(sourceRoot, file)}`);
  }

  const sourceManifest = readJson(sourceManifestPath);
  sourceContract(sourceManifest);
  const sourceGlb = readFileSync(sourceGlbPath);
  const sourceGlbHash = sha256(sourceGlb);
  assert(sourceManifest.furnished?.file === "market_house_furnished.glb", "source manifest furnished file changed");
  assert(sourceManifest.furnished?.sha256 === sourceGlbHash, "source manifest furnished hash is stale");

  const sourceCollisionBytes = readFileSync(sourceCollisionPath);
  const sourceCollisionHash = sha256(sourceCollisionBytes);
  const sourceCollision = JSON.parse(sourceCollisionBytes.toString("utf8"));
  assert(sourceCollision.schema === "successor.structure-collision.v3", "source collision schema changed");
  assert(sourceManifest.collision?.sidecar_sha256 === sourceCollisionHash,
    "source manifest collision hash is stale");
  assert(Array.isArray(sourceCollision.boxes) && sourceCollision.boxes.length > 0,
    "source collision has no authored boxes");
  assert(Array.isArray(sourceManifest.collision?.clearance_checks)
    && sourceManifest.collision.clearance_checks.every((check) => check.clear),
  "source authored clearance checks are not all clear");

  const gltf = parseGlbJson(sourceGlb);
  const imageSummary = embeddedImageSummary(gltf);
  const footprint = {
    minX: -5.7,
    minZ: -4.275,
    maxX: 5.7,
    maxZ: 4.275,
    spanX: 11.4,
    spanZ: 8.55,
    centerX: 0,
    centerZ: 0,
  };
  const sourceBodyBoxes = sourceCollision.boxes.filter((box) => box.min[1] < collisionBodyTopM
    && box.max[1] > floorTopM);
  const wallBoxes = sourceBodyBoxes.filter((box) => box.kind === "structure")
    .map((box) => runtimeBox(box, footprint));
  const furnitureBoxes = sourceBodyBoxes.filter((box) => box.kind === "furniture")
    .map((box) => runtimeBox(box, footprint));
  const doorBoxes = sourceBodyBoxes.filter((box) => box.kind === "door")
    .map((box) => runtimeBox(box, footprint));
  assert(wallBoxes.length > 0, "no body-height structure boxes were produced");
  assert(furnitureBoxes.length > 0, "no body-height furniture boxes were produced");
  assert(doorBoxes.length === 1, `expected one exterior door collision box, found ${doorBoxes.length}`);
  const closedDoor = { ...doorBoxes[0], id: "closed_door_panel" };
  assertPromisedCellsClear({ footprint, cellM: 0.95, walls: wallBoxes, furniture: furnitureBoxes, door: closedDoor });

  const sourceDoor = sourceManifest.door;
  assert(sourceDoor?.node === "door_slide" && sourceDoor.node_parent === null,
    "source GLB does not expose a root door_slide node");
  assert(sourceDoor.local_axis === "X" && sourceDoor.open_local_x_m === -2.6 && sourceDoor.travel_abs_m === 2.6,
    "source door no longer has the approved local-axis travel");
  assert(sameJson(sourceDoor.clips, ["door_open", "door_close"]), "source door clips changed");

  const door = {
    ...sourceDoor,
    axisLocal: [-1, 0, 0],
    slide_axis_local: [-1, 0, 0],
    slide_distance_m: sourceDoor.travel_abs_m,
    facing: "south",
  };
  const doorCells = touchedDoorCells(footprint, 0.95, 12, 9, closedDoor);
  const interiorRegions = authoringInteriorRegions(sourceManifest);
  for (const region of interiorRegions) {
    assert(region.minX >= footprint.minX && region.maxX <= footprint.maxX
      && region.minZ >= footprint.minZ && region.maxZ <= footprint.maxZ,
    `interior region ${region.id} exceeds the footprint`);
  }

  const collision = {
    schema: "successor.structure-collision.v3",
    source: files.glb,
    generatedBy: "tools/successor/assets/market-opus5-rebuild/src/package_runtime.mjs",
    contract: {
      runtimeKey,
      footprint_cells: [12, 9],
      cell_m: 0.95,
      floor_top_y_m: floorTopM,
      entry_facing: "south",
      entry_axis: "+Z",
      structuralRoles: ["authored_shell", "service_wall", "niches", "flank_recesses", "entry_structure"],
      furnitureRoles: ["authored_furnished_interior", "trainer_consultation", "back_of_house", "service_hardware"],
      decorativeExcluded: ["roof", "clerestory", "trim", "lights", "loose_visual_props"],
      terminal_cells_kept_clear: requiredClearCells,
    },
    footprint,
    floor: { topY: floorTopM, slabThicknessM: 0.32 },
    walls: wallBoxes,
    furniture: furnitureBoxes,
    door: { node: "door_slide", closed: closedDoor },
    interiorRegions,
    sourceCollision: {
      file: "market_house.collision.json",
      sha256: `sha256:${sourceCollisionHash}`,
      authored_box_count: sourceCollision.boxes.length,
      body_height_max_m: collisionBodyTopM,
      body_height_box_count: sourceBodyBoxes.length,
      excluded_overhead_box_count: sourceCollision.boxes.length - sourceBodyBoxes.length,
    },
  };

  const sourceLod0 = sourceManifest.lods?.lod0;
  assert(sourceLod0 && Number.isInteger(sourceLod0.triangles), "source manifest lod0 metrics are missing");
  const permanentPrefixes = ["floor__", "interior__"];
  const revealablePrefixes = ["roof__", "wall_front__", "wall_back__", "wall_left__", "wall_right__"];
  assert(sameJson(sourceManifest.permanent_prefixes, permanentPrefixes),
    "source permanent cutaway prefixes changed");
  assert(sameJson(sourceManifest.cutaway_prefixes?.filter((prefix) => !permanentPrefixes.includes(prefix)), revealablePrefixes),
    "source revealable cutaway prefixes changed");
  const manifest = {
    schema: "successor.runtime-building-manifest.v1",
    building: runtimeKey,
    runtimeKey,
    label: "Valley Market",
    units: "m",
    front: "+Z",
    footprintCells: [12, 9],
    footprint_max_m: [11.4, 8.55],
    runtime_scale_at_12x9_cells: 1.0526315789473684,
    floorHeightM: floorTopM,
    floorTopY: floorTopM,
    exteriorEntry: {
      facing: "south",
      frontAxis: "+Z",
      doorNode: "door_slide",
      doorCells,
    },
    door,
    door_cells: doorCells,
    service_anchor_cells: requiredClearCells,
    promised_clear_cells: requiredClearCells,
    collisionProxy: {
      source: runtimeKey,
      sidecar: files.collision,
      structuralOnly: false,
      includesFurniture: true,
      wallCount: wallBoxes.length,
      furnitureCount: furnitureBoxes.length,
    },
    cutaway: {
      faces: {
        front: "wall_front__",
        back: "wall_back__",
        left: "wall_left__",
        right: "wall_right__",
      },
      hide: revealablePrefixes,
      revealPrefixes: revealablePrefixes,
      keep: permanentPrefixes,
      stub_by_face: true,
    },
    interiorRegions,
    bbox_span_m: [sourceLod0.size_m.x, sourceLod0.size_m.y_up, sourceLod0.size_m.z_front],
    tri_count: sourceManifest.furnished.triangles_with_props,
    materials: sourceLod0.materials,
    asset: {
      file: files.glb,
      bytes: sourceGlb.length,
      sha256: `sha256:${sourceGlbHash}`,
      images: imageSummary,
    },
    source: {
      furnished_glb: "market_house_furnished.glb",
      furnished_sha256: `sha256:${sourceGlbHash}`,
      generator: sourceManifest.generator,
      generator_sha256: `sha256:${sourceManifest.generator_sha256}`,
      post_export: sourceManifest.post_export,
      git_rev: sourceManifest.git_rev,
      authored_clearance_check_count: sourceManifest.collision.clearance_checks.length,
      authored_clearance_issues: sourceManifest.collision.clearance_issues,
    },
  };

  const provenance = {
    schema: "successor-asset-provenance/1",
    asset_id: runtimeKey,
    asset_kind: "model_glb",
    asset_path: `runtime-buildings/market/${files.glb}`,
    asset_hash: `sha256:${sourceGlbHash}`,
    source_blend_or_script: "tools/successor/assets/market-opus5-rebuild/src/build_market.py (deterministic Blender authoring source)",
    package_script: "tools/successor/assets/market-opus5-rebuild/src/package_runtime.mjs",
    regeneration_command: "cd tools/successor/assets/market-opus5-rebuild && python3 src/gen_textures.py && blender -b --factory-startup -noaudio --python-exit-code 1 -P src/build_market.py -- --stage full && node src/post_gltf.mjs build/market_house_furnished.glb 1.0 && python3 src/manifest.py && node src/package_runtime.mjs",
    source_inputs: {
      source_manifest_sha256: `sha256:${sha256(readFileSync(sourceManifestPath))}`,
      source_collision_sha256: `sha256:${sourceCollisionHash}`,
      furnished_source_sha256: `sha256:${sourceGlbHash}`,
      imported_props: sourceManifest.props,
    },
    contract: {
      runtime_key: runtimeKey,
      footprint_cells: [12, 9],
      footprint_m: [11.4, 8.55],
      floor_top_y_m: floorTopM,
      exterior_entry_facing: "south",
      terminal_cells_kept_clear: requiredClearCells,
      door_node: "door_slide",
    },
    validation: {
      image_embedding: imageSummary,
      authored_clearance_checks: sourceManifest.collision.clearance_checks.length,
      authored_clearance_issues: sourceManifest.collision.clearance_issues,
      verifier: "tools/successor/assets/market-opus5-rebuild/src/verify_runtime_package.mjs",
    },
    rights: {
      redistribution_status: "authorized for Successor runtime distribution only; no standalone reuse grant",
      source_license: "Successor proprietary project asset; all rights reserved",
    },
  };

  mkdirSync(packageRoot, { recursive: true });
  copyFileSync(sourceGlbPath, path.join(packageRoot, files.glb));
  writeJson(path.join(packageRoot, files.collision), collision);
  writeJson(path.join(packageRoot, files.manifest), manifest);
  writeJson(path.join(packageRoot, files.provenance), provenance);

  console.log(`PACKAGED ${path.relative(repoRoot, packageRoot)}`);
  console.log(`  ${files.glb}: ${sourceGlb.length} bytes sha256:${sourceGlbHash}`);
  console.log(`  ${files.collision}: ${wallBoxes.length} walls, ${furnitureBoxes.length} furniture, 1 exterior door`);
  console.log(`  embedded images: ${imageSummary.image_count}; external image URIs: ${imageSummary.external_image_uri_count}`);
}

main();
