#!/usr/bin/env node
/**
 * Asset-local verifier for the standalone Valley Market runtime handoff.
 * It intentionally validates the shipped files rather than the ignored build
 * tree, including the official Khronos glTF Validator result.
 *
 *   node src/verify_runtime_package.mjs
 */
import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const khronosValidator = require("gltf-validator");

const sourceRoot = path.resolve(import.meta.dirname, "..");
const repoRoot = path.resolve(sourceRoot, "../../../..");
const packageRoot = path.join(repoRoot, "runtime-buildings", "market");
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
const revealPrefixes = Object.freeze(["roof__", "wall_front__", "wall_back__", "wall_left__", "wall_right__"]);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sha256(data) {
  return createHash("sha256").update(data).digest("hex");
}

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
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
  assert(20 + jsonLength <= bytes.length, "GLB JSON chunk exceeds file length");
  return JSON.parse(bytes.toString("utf8", 20, 20 + jsonLength).trim());
}

function embeddedImageSummary(gltf) {
  const images = gltf.images ?? [];
  assert(images.length > 0, "GLB has no images");
  for (const [index, image] of images.entries()) {
    assert(!Object.hasOwn(image, "uri"), `image ${index} has a prohibited URI`);
    assert(Number.isInteger(image.bufferView), `image ${index} has no embedded bufferView`);
    assert(typeof image.mimeType === "string" && image.mimeType.length > 0,
      `image ${index} has no MIME type`);
  }
  for (const [index, buffer] of (gltf.buffers ?? []).entries()) {
    assert(!Object.hasOwn(buffer, "uri"), `buffer ${index} has a prohibited external URI`);
  }
  return { image_count: images.length, external_image_uri_count: 0 };
}

function assertBox(box, footprint, label) {
  assert(box && typeof box === "object", `${label} is missing`);
  for (const field of ["minX", "minZ", "maxX", "maxZ"]) {
    assert(Number.isFinite(box[field]), `${label}.${field} must be finite`);
  }
  assert(box.maxX > box.minX && box.maxZ > box.minZ, `${label} must have positive area`);
  const epsilon = 1e-6;
  assert(box.minX >= footprint.minX - epsilon && box.maxX <= footprint.maxX + epsilon
    && box.minZ >= footprint.minZ - epsilon && box.maxZ <= footprint.maxZ + epsilon,
  `${label} lies outside the declared footprint`);
}

function overlaps(a, b) {
  return Math.min(a.maxX, b.maxX) > Math.max(a.minX, b.minX)
    && Math.min(a.maxZ, b.maxZ) > Math.max(a.minZ, b.minZ);
}

function cellBounds(footprint, [column, row]) {
  const cellM = 0.95;
  return {
    minX: footprint.minX + column * cellM,
    maxX: footprint.minX + (column + 1) * cellM,
    minZ: footprint.minZ + row * cellM,
    maxZ: footprint.minZ + (row + 1) * cellM,
  };
}

function assertPromisedCellsClear(collision) {
  const blockers = [...collision.walls, ...collision.furniture, collision.door.closed];
  for (const [name, cell] of Object.entries(requiredClearCells)) {
    const cellBox = cellBounds(collision.footprint, cell);
    const overlap = blockers.find((box) => overlaps(box, cellBox));
    assert(!overlap, `${overlap?.id ?? "collision blocker"} overlaps promised ${name} cell (${cell.join(",")})`);
  }
}

function assertDoorAndCutaway(gltf, manifest) {
  const nodes = gltf.nodes ?? [];
  const nodeNames = nodes.map((node) => node.name ?? "");
  const doorIndex = nodeNames.indexOf("door_slide");
  assert(doorIndex >= 0, "GLB has no door_slide node");
  const sceneIndex = gltf.scene ?? 0;
  const sceneNodes = gltf.scenes?.[sceneIndex]?.nodes ?? [];
  assert(sceneNodes.includes(doorIndex), "door_slide must be a scene root node");
  const animationNames = new Set((gltf.animations ?? []).map((animation) => animation.name));
  assert(animationNames.has("door_open") && animationNames.has("door_close"),
    "GLB must provide door_open and door_close clips");
  for (const prefix of revealPrefixes) {
    assert(nodeNames.some((name) => name.startsWith(prefix)), `GLB has no revealable ${prefix} node`);
  }
  assert(sameJson(manifest.cutaway.revealPrefixes, revealPrefixes), "manifest cutaway prefixes drifted");
  assert(sameJson(manifest.cutaway.keep, ["floor__", "interior__"]), "manifest cutaway keep set drifted");
}

async function main() {
  const paths = Object.fromEntries(Object.entries(files).map(([key, file]) => [key, path.join(packageRoot, file)]));
  for (const file of Object.values(paths)) assert(existsSync(file), `missing handoff file ${path.relative(repoRoot, file)}`);

  const glb = readFileSync(paths.glb);
  const glbHash = `sha256:${sha256(glb)}`;
  const gltf = parseGlbJson(glb);
  const imageSummary = embeddedImageSummary(gltf);
  const collision = readJson(paths.collision);
  const manifest = readJson(paths.manifest);
  const provenance = readJson(paths.provenance);

  assert(manifest.schema === "successor.runtime-building-manifest.v1", "manifest schema changed");
  assert(manifest.building === "valley_market" && manifest.runtimeKey === "valley_market",
    "manifest runtime key must remain valley_market");
  assert(sameJson(manifest.footprintCells, [12, 9]), "manifest footprint cells must remain 12x9");
  assert(sameJson(manifest.footprint_max_m, [11.4, 8.55]), "manifest footprint metres must remain 11.4x8.55");
  assert(manifest.floorHeightM === 0.02 && manifest.floorTopY === 0.02, "manifest floor top must remain 0.02m");
  assert(manifest.front === "+Z" && manifest.exteriorEntry?.facing === "south",
    "manifest entry must face south on +Z");
  assert(manifest.exteriorEntry?.doorNode === "door_slide", "manifest exterior entry must name door_slide");
  assert(manifest.door?.node === "door_slide" && manifest.door.local_axis === "X"
    && manifest.door.open_local_x_m === -2.6 && manifest.door.slide_distance_m === 2.6,
  "manifest door must retain the authored local X axis and 2.6m travel");
  assert(sameJson(manifest.door?.axisLocal, [-1, 0, 0]), "manifest door axisLocal must be -X");
  assert(sameJson(manifest.service_anchor_cells, requiredClearCells), "manifest service cells drifted");
  assert(sameJson(manifest.promised_clear_cells, requiredClearCells), "manifest promised cells drifted");
  assert(manifest.collisionProxy?.sidecar === files.collision, "manifest collision sidecar name drifted");
  assert(manifest.asset?.file === files.glb && manifest.asset?.bytes === glb.length && manifest.asset?.sha256 === glbHash,
    "manifest asset identity does not match the GLB");
  assert(sameJson(manifest.asset.images, imageSummary), "manifest embedded-image metadata does not match the GLB");
  assertDoorAndCutaway(gltf, manifest);

  assert(collision.schema === "successor.structure-collision.v3", "collision schema changed");
  assert(collision.source === files.glb, "collision source must point to valley_market.glb");
  assert(collision.contract?.runtimeKey === "valley_market",
    "collision runtime identity drifted");
  assert(sameJson(collision.contract?.footprint_cells, [12, 9]), "collision footprint cells must remain 12x9");
  assert(collision.contract?.floor_top_y_m === 0.02 && collision.contract?.entry_facing === "south"
    && collision.contract?.entry_axis === "+Z", "collision floor or entry contract drifted");
  assert(sameJson(collision.contract?.terminal_cells_kept_clear, requiredClearCells),
    "collision promised terminal/trainer cells drifted");
  const footprint = collision.footprint;
  assert(footprint?.minX === -5.7 && footprint?.maxX === 5.7 && footprint?.minZ === -4.275 && footprint?.maxZ === 4.275
    && footprint?.spanX === 11.4 && footprint?.spanZ === 8.55, "collision footprint must remain 11.4x8.55m centered at origin");
  assert(collision.floor?.topY === 0.02, "collision floor top must remain 0.02m");
  assert(collision.door?.node === "door_slide", "collision must name the exterior door_slide node");
  assert(Array.isArray(collision.walls) && collision.walls.length > 0, "collision must contain wall blockers");
  assert(Array.isArray(collision.furniture) && collision.furniture.length > 0, "collision must contain furnished blockers");
  for (const [index, box] of collision.walls.entries()) assertBox(box, footprint, `walls[${index}]`);
  for (const [index, box] of collision.furniture.entries()) assertBox(box, footprint, `furniture[${index}]`);
  assertBox(collision.door.closed, footprint, "door.closed");
  assertPromisedCellsClear(collision);
  const { transformStructureCollision } = await import(
    pathToFileURL(path.join(repoRoot, "tools", "successor", "structure-collision-geometry.mjs")).href,
  );
  const runtimeCollision = transformStructureCollision(collision, { w: 12, h: 9 }, 0);
  assert(runtimeCollision.walls.length === collision.walls.length
    && runtimeCollision.furniture.length === collision.furniture.length
    && runtimeCollision.door?.id === "closed_door_panel",
  "runtime collision adapter did not accept the packaged sidecar");

  assert(provenance.schema === "successor-asset-provenance/1", "provenance schema changed");
  assert(provenance.asset_id === "valley_market",
    "provenance runtime identity drifted");
  assert(provenance.asset_path === `runtime-buildings/market/${files.glb}` && provenance.asset_hash === glbHash,
    "provenance asset identity does not match the GLB");
  assert(sameJson(provenance.contract?.footprint_cells, [12, 9]) && provenance.contract?.floor_top_y_m === 0.02
    && provenance.contract?.exterior_entry_facing === "south", "provenance contract drifted");
  assert(sameJson(provenance.contract?.terminal_cells_kept_clear, requiredClearCells),
    "provenance terminal/trainer cells drifted");
  assert(sameJson(provenance.validation?.image_embedding, imageSummary),
    "provenance embedded-image metadata does not match the GLB");

  const validatorReport = await khronosValidator.validateBytes(
    new Uint8Array(glb.buffer, glb.byteOffset, glb.byteLength),
    { uri: files.glb, format: "glb", writeTimestamp: false, maxIssues: 0 },
  );
  const issues = validatorReport.issues ?? {};
  assert(issues.numErrors === 0, `Khronos glTF Validator reported ${issues.numErrors ?? "unknown"} errors`);
  assert(issues.numWarnings === 0, `Khronos glTF Validator reported ${issues.numWarnings ?? "unknown"} warnings`);

  console.log("VERIFY_RUNTIME_PACKAGE_OK");
  console.log(`  package: ${path.relative(repoRoot, packageRoot)}`);
  console.log(`  GLB: ${files.glb} (${glb.length} bytes, ${glbHash})`);
  console.log(`  Khronos glTF Validator: errors=${issues.numErrors}, warnings=${issues.numWarnings}`);
  console.log(`  embedded images=${imageSummary.image_count}, external image URIs=${imageSummary.external_image_uri_count}`);
  console.log(`  collision: ${collision.walls.length} walls, ${collision.furniture.length} furniture, 1 exterior door; 4 promised cells clear`);
  console.log("  runtime collision adapter: accepted 12x9 sidecar at rotation 0");
  console.log(`  reveal prefixes: ${revealPrefixes.join(", ")}`);
}

main().catch((error) => {
  console.error(`VERIFY_RUNTIME_PACKAGE_FAIL: ${error.message}`);
  process.exitCode = 1;
});
