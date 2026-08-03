#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const packageDir = path.resolve(here, "..");
const defaultRepoRoot = path.resolve(packageDir, "..");
export const DEFAULT_STAGING_DIR = path.join(packageDir, ".generated", "production-assets");
export const PRODUCTION_MANIFEST_NAME = "production-asset-manifest.json";
// Four furnished starting-town buildings replace two light prototypes.
export const PUBLIC_RELEASE_BUDGET = Object.freeze({ maxFiles: 425, maxBytes: 270_000_000 });

const PAWN_CORE_FILES = [
  "game_pack.json",
  "manifest_anim.json",
  "slugthrower_attach.json",
  "vibrosword_attach.json",
  "pawn_male.glb",
  "pawn_female.glb",
  "slugthrower.glb",
  "vibrosword.glb",
];
const PAWN_MATERIAL_FILES = [
  "equipment/manifest.json",
  "equipment/wardrobe_palette.json",
  "equipment/Materials/materials.json",
  "equipment/ClothingMaterials/clothing_materials.json",
];
const ALWAYS_RUNTIME_WORLD_FILES = [
  "world-items/podtent_scout.glb",
  "world-items/podtent_scout_collision.json",
  "world-items/campfire_scout.glb",
  "world-items/extractor_mineral.glb",
  "world-items/extractor_chemical.glb",
  "world-items/extractor_gas.glb",
  "world-items/extractor_water.glb",
];

function fail(message) {
  throw new Error(`production asset pipeline: ${message}`);
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    fail(`cannot read JSON ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function canonicalJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function normalizeDestination(destination) {
  if (typeof destination !== "string" || destination.length === 0) fail("asset destination must be a non-empty string");
  if (destination.includes("\\") || destination.startsWith("/") || /^[a-z][a-z0-9+.-]*:/iu.test(destination)) {
    fail(`private or absolute asset destination is forbidden: ${destination}`);
  }
  const normalized = path.posix.normalize(destination);
  if (normalized === "." || normalized.startsWith("../") || normalized.includes("/../") || normalized.includes("\0")) {
    fail(`asset destination escapes staging root: ${destination}`);
  }
  return normalized;
}

export function normalizePublicPath(publicPath) {
  if (typeof publicPath !== "string" || publicPath.length === 0) fail("asset source URL must be a non-empty string");
  if (!publicPath.startsWith("/") || publicPath.startsWith("//") || /^[a-z][a-z0-9+.-]*:/iu.test(publicPath)) {
    fail(`private or absolute asset path is forbidden: ${publicPath}`);
  }
  // Reject raw traversal tokens before normalize can collapse them away.
  if (publicPath.includes("\\") || publicPath.includes("\0") || /(^|\/)\.\.(\/|$)/u.test(publicPath)) {
    fail(`asset path traversal is forbidden: ${publicPath}`);
  }
  const normalized = path.posix.normalize(publicPath);
  if (
    normalized !== publicPath
    || normalized.includes("..")
    || normalized.includes("\\")
    || normalized === "/"
  ) {
    fail(`asset path traversal is forbidden: ${publicPath}`);
  }
  return normalized.slice(1);
}
function categoryForDestination(destination) {
  if (destination.startsWith("successor-slice/")) return "world";
  if (destination.startsWith("successor-audio/")) return "audio";
  if (destination.includes("/pawn-pack/equipment/")) return "equipment";
  if (destination.includes("/pawn-pack/weapons/")) return "weapon";
  if (destination.includes("/face-kit/")) return "character-creator";
  if (destination.startsWith("assets/items/")) return "item";
  if (destination.startsWith("assets/world-items/")) return "world";
  if (destination.startsWith("assets/pawn-pack/")) return "character-creator";
  return "runtime";
}

function addClassification(entry, category, reason) {
  entry.categories.add(category ?? categoryForDestination(entry.destination));
  entry.reasons.add(reason ?? "runtime-reference");
}

export function addEntry(entries, { sourcePath, destination, authority, category, reason }) {
  if (typeof sourcePath !== "string" || path.isAbsolute(sourcePath)) {
    fail(`private absolute source path is forbidden: ${String(sourcePath)}`);
  }
  const normalizedDestination = normalizeDestination(destination);
  if (typeof authority !== "string" || authority.length === 0) fail(`asset ${normalizedDestination} has no source authority`);
  const current = entries.get(normalizedDestination);
  if (current && current.sourcePath !== sourcePath) {
    fail(`duplicate/conflicting destination ${normalizedDestination}: ${current.sourcePath} vs ${sourcePath}`);
  }
  if (current) {
    current.authorities.add(authority);
    addClassification(current, category, reason ?? authority);
    return;
  }
  const entry = {
    destination: normalizedDestination,
    sourcePath,
    authorities: new Set([authority]),
    categories: new Set(),
    reasons: new Set(),
  };
  addClassification(entry, category, reason ?? authority);
  entries.set(normalizedDestination, entry);
}

function assertInside(candidate, root) {
  const relative = path.relative(root, candidate);
  if (relative.length === 0 || relative.startsWith("..") || path.isAbsolute(relative)) {
    fail(`asset source escapes public root: ${candidate}`);
  }
}

function assertRealInside(candidate, root) {
  const realRoot = fs.realpathSync(root);
  const realCandidate = fs.realpathSync(candidate);
  assertInside(realCandidate, realRoot);
}


function addPublicUrl(entries, publicPath, authority) {
  const relative = normalizePublicPath(publicPath);
  const sourcePath = relative.startsWith("successor-slice/") || relative.startsWith("successor-audio/")
    ? path.posix.join("client", "public", relative)
    : path.posix.join("client-3d", "public", relative);
  addEntry(entries, { sourcePath, destination: relative, authority });
}

function addClientAsset(entries, relative, authority) {
  const normalized = normalizeDestination(path.posix.join("assets", relative));
  addEntry(entries, {
    sourcePath: path.posix.join("client-3d", "public", normalized),
    destination: normalized,
    authority,
  });
}


/**
 * Resolve a props-mapping GLB/path reference to a containment-safe public asset.
 * Absolute public URLs (`/assets/...`) stage exactly once under client-3d/public.
 * Relative world-item filenames stay under assets/world-items/.
 */
export function resolveMappedPublicAsset(mappedPath, { underWorldItems = false } = {}) {
  if (typeof mappedPath !== "string" || mappedPath.length === 0) {
    fail("mapped asset path must be a non-empty string");
  }
  if (mappedPath.includes("\\") || mappedPath.includes("\0") || mappedPath.includes("*")) {
    fail(`mapped asset path is forbidden: ${mappedPath}`);
  }
  if (mappedPath.startsWith("/")) {
    // Public absolute URL — stage exactly once at the public-relative path.
    const relative = normalizePublicPath(mappedPath);
    return {
      sourcePath: path.posix.join("client-3d", "public", relative),
      destination: relative,
    };
  }
  // Relative mapping — optional world-items prefix for classic prop filenames.
  if (/(^|\/)\.\.(\/|$)/u.test(mappedPath) || mappedPath.startsWith("/")) {
    fail(`mapped asset path escapes staging root: ${mappedPath}`);
  }
  const joined = underWorldItems
    ? path.posix.join("world-items", mappedPath)
    : mappedPath;
  const normalizedJoin = path.posix.normalize(joined);
  if (
    normalizedJoin !== joined
    || normalizedJoin.startsWith("../")
    || normalizedJoin === ".."
    || normalizedJoin.includes("/../")
    || path.posix.isAbsolute(normalizedJoin)
  ) {
    fail(`mapped asset path escapes staging root: ${mappedPath}`);
  }
  // If the relative already names assets/..., keep it; else place under assets/.
  const destination = normalizedJoin.startsWith("assets/")
    ? normalizeDestination(normalizedJoin)
    : normalizeDestination(path.posix.join("assets", normalizedJoin));
  return {
    sourcePath: path.posix.join("client-3d", "public", destination),
    destination,
  };
}


function parseCreatureRegistry(repoRoot) {
  const source = fs.readFileSync(path.join(repoRoot, "client-3d", "src", "render", "pawns.ts"), "utf8");
  const registry = new Map();
  const pattern = /"([^"]+)":\s*\{\s*speciesId:\s*"[^"]+",\s*assetPath:\s*"([^"]+)"/g;
  for (const match of source.matchAll(pattern)) registry.set(match[1], match[2]);
  if (registry.size === 0) fail("creature registry is empty or changed shape");
  return registry;
}

function parseFaceAssets(repoRoot) {
  const source = fs.readFileSync(path.join(repoRoot, "client-3d", "src", "assets", "faceKit", "face-kit.js"), "utf8");
  const block = source.match(/FACE_ASSET_FILES\s*=\s*Object\.freeze\(\{([\s\S]*?)\}\)/u)?.[1] ?? "";
  const files = [];
  const pattern = /^\s*[a-z]+:\s*"([^"]+)"/gmu;
  for (const match of block.matchAll(pattern)) files.push(match[1]);
  if (files.length === 0) fail("face registry is empty or changed shape");
  return [...new Set(files)].sort();
}

function addWorldMappingAssets(entries, repoRoot, fixture) {
  const mapping = readJson(path.join(repoRoot, "client-3d", "src", "render", "props-mapping.json"));
  const wanted = new Set();
  for (const prop of fixture.props ?? []) {
    const key = prop?.assetKey ?? prop?.kind;
    if (typeof key === "string") wanted.add(key);
  }
  for (const key of [...wanted].sort()) {
    const entry = mapping.entries?.[key];
    if (!entry || entry.skip === true) continue;
    if (typeof entry.glb === "string") {
      const resolved = resolveMappedPublicAsset(entry.glb, { underWorldItems: true });
      addEntry(entries, {
        sourcePath: resolved.sourcePath,
        destination: resolved.destination,
        authority: `fixture.prop:${key}`,
      });
    }
    if (typeof entry.animatedScreen?.texture === "string") {
      const resolved = resolveMappedPublicAsset(entry.animatedScreen.texture, { underWorldItems: true });
      addEntry(entries, {
        sourcePath: resolved.sourcePath,
        destination: resolved.destination,
        authority: `registry.props-mapping:${key}.screen`,
      });
    }
    if (typeof entry.enterable?.manifest === "string") {
      const resolved = resolveMappedPublicAsset(entry.enterable.manifest, { underWorldItems: true });
      addEntry(entries, {
        sourcePath: resolved.sourcePath,
        destination: resolved.destination,
        authority: `registry.props-mapping:${key}.enterable`,
      });
    }
  }
  for (const relative of ALWAYS_RUNTIME_WORLD_FILES) addClientAsset(entries, relative, "registry.world-runtime");
}
 
function addEquipmentMaterialTextures(entries, repoRoot) {
  const base = path.join(repoRoot, "client-3d", "public", "assets", "pawn-pack", "equipment");
  for (const file of ["Materials/materials.json", "ClothingMaterials/clothing_materials.json"]) {
    const config = readJson(path.join(base, file));
    for (const preset of config.materials ?? []) {
      for (const texture of Object.values(preset.maps ?? {})) {
        if (typeof texture !== "string") continue;
        addClientAsset(entries, path.posix.join("pawn-pack", "equipment", texture), `registry.equipmentMaterials:${preset.id}`);
      }
    }
  }
}

function addCropWorldAssets(entries) {
  const species = ["ashgrain", "sunmelon", "cavemoss", "emberbean", "riftroot", "brineleaf", "glasspepper", "coilreed", "nightplum"];
  const looks = ["planted", "establishing", "laden", "husk"];
  for (const id of species) for (const look of looks) {
    addClientAsset(entries, path.posix.join("items", "custom", "crops", "world", id, `${look}.glb`), `registry.crops:${id}/${look}`);
  }
}

function addPawnAssets(entries, repoRoot, fixture) {
  const base = path.join(repoRoot, "client-3d", "public", "assets", "pawn-pack");
  for (const relative of PAWN_CORE_FILES) addClientAsset(entries, path.posix.join("pawn-pack", relative), "loader.pawnPack.core");
  for (const relative of PAWN_MATERIAL_FILES) addClientAsset(entries, path.posix.join("pawn-pack", relative), "loader.pawnPack.manifests");
  const gamePack = readJson(path.join(base, "game_pack.json"));
  const bareFile = gamePack?.pawns?.male?.bare_file;
  if (typeof bareFile === "string" && bareFile.length > 0) addClientAsset(entries, path.posix.join("pawn-pack", bareFile), "loader.pawnPack.bareBody");

  const equipmentManifest = readJson(path.join(base, "equipment", "manifest.json"));
  for (const item of equipmentManifest.items ?? []) {
    if (item?.viewerOnly === true) continue;
    if (typeof item?.glb !== "string") fail("equipment manifest item has no GLB path");
    const relative = path.posix.normalize(path.posix.join("assets", "pawn-pack", "equipment", item.glb));
    if (relative === "assets" || relative.startsWith("../") || !relative.startsWith("assets/")) fail(`equipment path escapes assets root: ${item.glb}`);
    addClientAsset(entries, relative.slice("assets/".length), `registry.pawnEquipment:${item.id}`);
  }

  const weaponsManifestPath = path.join(base, "weapons", "weapons_manifest.json");
  const weaponsManifest = readJson(weaponsManifestPath);
  addClientAsset(entries, "pawn-pack/weapons/weapons_manifest.json", "loader.weapons.registry");
  for (const item of weaponsManifest.items ?? []) {
    if (typeof item?.glb !== "string" || typeof item?.attach !== "string") fail(`weapon manifest item ${item?.id ?? "?"} has invalid paths`);
    addClientAsset(entries, path.posix.join("pawn-pack", "weapons", item.glb), `registry.weapons:${item.id}`);
    addClientAsset(entries, path.posix.join("pawn-pack", "weapons", item.attach), `registry.weapons:${item.id}`);
  }

  const sprites = new Set();
  for (const actor of fixture.actors ?? []) if (typeof actor?.sprite === "string") sprites.add(actor.sprite);
  for (const template of fixture.populationTemplates ?? []) if (typeof template?.sprite === "string") sprites.add(template.sprite);
  if ([...sprites].includes("droid-grok-humanoid")) {
    addClientAsset(entries, "pawn-pack/special/droid_grok_humanoid.glb", "fixture.actors:droid-grok-humanoid");
  }
}

function parseCatalogOnlyItemIds(repoRoot) {
  const source = fs.readFileSync(path.join(repoRoot, "crates", "successor-sim", "src", "authority.rs"), "utf8");
  const ids = new Set();
  const pattern = /const\s+(?:BIO_ADDITIVE_|INGREDIENT_|FOOD_)[A-Z0-9_]*_ITEM_ID:\s*u32\s*=\s*([\d_]+)\s*;/gu;
  for (const match of source.matchAll(pattern)) ids.add(Number.parseInt(match[1].replaceAll("_", ""), 10));
  if (ids.size === 0) fail("authority catalog-only item registry is empty or changed shape");
  return ids;
}

function recordExcludedAsset(excluded, repoRoot, publicPath, category, reason) {
  const relative = normalizePublicPath(publicPath);
  const sourcePath = relative.startsWith("successor-slice/") || relative.startsWith("successor-audio/")
    ? path.posix.join("client", "public", relative)
    : path.posix.join("client-3d", "public", relative);
  const sourceAbsolute = path.resolve(repoRoot, sourcePath);
  assertInside(sourceAbsolute, repoRoot);
  const stat = fs.lstatSync(sourceAbsolute, { throwIfNoEntry: false });
  if (!stat || !stat.isFile() || stat.isSymbolicLink()) fail(`excluded catalog asset is not a regular file: ${sourcePath}`);
  const bytes = fs.readFileSync(sourceAbsolute);
  excluded.push({ path: relative, source: sourcePath, size: bytes.byteLength, category, reason });
}

function addAllItemModels(entries, repoRoot, excluded) {
  const models = readJson(path.join(repoRoot, "client-3d", "src", "ui", "inventory", "itemModels.json"));
  const catalogOnly = parseCatalogOnlyItemIds(repoRoot);
  const paths = new Set();
  for (const [key, value] of Object.entries(models)) {
    if (key === "_comment") continue;
    if (!/^\d+$/u.test(key)) fail(`inventory item-model key is not numeric: ${key}`);
    if (typeof value !== "string" || !value.startsWith("/assets/")) fail(`inventory item ${key} has unresolved runtime model`);
    if (catalogOnly.has(Number(key))) {
      recordExcludedAsset(excluded, repoRoot, value, "catalog", `authority.catalog-only:item-${key}`);
      continue;
    }
    paths.add(value);
  }
  paths.add("/assets/world-items/supply_cache.glb");
  for (const publicPath of [...paths].sort()) addPublicUrl(entries, publicPath, "registry.inventory.itemModels");
}

function addFixtureItemModels(entries, repoRoot, fixture) {
  const models = readJson(path.join(repoRoot, "client-3d", "src", "ui", "inventory", "itemModels.json"));
  const ids = new Set((fixture.inventory ?? []).map((row) => row?.itemId).filter((id) => Number.isInteger(id)));
  for (const id of [...ids].sort((a, b) => a - b)) {
    const publicPath = models[String(id)];
    if (typeof publicPath === "string") addPublicUrl(entries, publicPath, `fixture.inventory:item-${id}`);
    else if (!(id >= 1101 && id <= 1103)) fail(`fixture item ${id} missing from runtime item-model registry`);
  }
}

function addCreatureAssets(entries, repoRoot, fixture) {
  const registry = parseCreatureRegistry(repoRoot);
  const sprites = new Set();
  for (const actor of fixture.actors ?? []) if (typeof actor?.sprite === "string") sprites.add(actor.sprite);
  for (const template of fixture.populationTemplates ?? []) if (typeof template?.sprite === "string") sprites.add(template.sprite);
  for (const sprite of [...sprites].sort()) {
    const publicPath = registry.get(sprite);
    if (publicPath) addPublicUrl(entries, publicPath, `fixture.creature:${sprite}`);
    else if (sprite.startsWith("creature-")) fail(`fixture creature sprite missing from runtime registry: ${sprite}`);
  }
}

function addFaceAssets(entries, repoRoot) {
  for (const file of parseFaceAssets(repoRoot)) addClientAsset(entries, path.posix.join("face-kit", "assets", file), "loader.faceKit.atlases");
}

function addAudio(entries, repoRoot) {
  const manifest = readJson(path.join(repoRoot, "client", "public", "successor-audio", "sfx", "manifest.json"));
  addPublicUrl(entries, "/successor-audio/sfx/manifest.json", "loader.sfx.manifest");
  for (const clip of manifest.clips ?? []) {
    if (typeof clip?.path !== "string") fail("audio manifest clip has no path");
    addPublicUrl(entries, clip.path, `registry.sfx:${clip.id}`);
  }
}

function collectOfflinePlan(repoRoot) {
  const root = path.resolve(repoRoot);
  const entries = new Map();
  for (const publicRoot of ["client-3d/public", "client/public"]) {
    const absoluteRoot = path.join(root, publicRoot);
    function walk(current) {
      for (const name of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const absolute = path.join(current, name.name);
        if (name.isDirectory()) {
          walk(absolute);
        } else if (name.isFile()) {
          const relative = path.relative(root, absolute).split(path.sep).join("/");
          const destination = relative.startsWith("client-3d/public/")
            ? relative.slice("client-3d/public/".length)
            : relative.slice("client/public/".length);
          addEntry(entries, { sourcePath: relative, destination, authority: "developer.offline-full", category: "developer", reason: "explicit-offline-full-staging" });
        } else if (name.isSymbolicLink()) {
          fail(`offline staging refuses symbolic link: ${absolute}`);
        }
      }
    }
    walk(absoluteRoot);
  }
  const fixturePath = path.join(root, "client", "public", "successor-slice", "open-desert-slice.json");
  return { fixture: readJson(fixturePath), entries, excluded: [] };
}

export function collectReachabilityPlan({ repoRoot = defaultRepoRoot, fixturePath } = {}) {
  const root = path.resolve(repoRoot);
  const resolvedFixture = fixturePath ? path.resolve(fixturePath) : path.join(root, "client", "public", "successor-slice", "open-desert-slice.json");
  const fixture = readJson(resolvedFixture);
  const entries = new Map();
  const excluded = [];
  const fixtureRelative = path.relative(root, resolvedFixture).split(path.sep).join("/");
  if (fixtureRelative.startsWith("..") || path.isAbsolute(fixtureRelative)) fail("fixture path must be inside repository");
  addEntry(entries, { sourcePath: fixtureRelative, destination: "successor-slice/open-desert-slice.json", authority: "fixture.source" });
  addEntry(entries, {
    sourcePath: "client/public/successor-slice/open-desert-map-bundle.json",
    destination: "successor-slice/open-desert-map-bundle.json",
    authority: "fixture.mapBundle",
  });
  addWorldMappingAssets(entries, root, fixture);
  addPawnAssets(entries, root, fixture);
  addEquipmentMaterialTextures(entries, root);
  addCropWorldAssets(entries);
  addCreatureAssets(entries, root, fixture);
  addFaceAssets(entries, root);
  addAllItemModels(entries, root, excluded);
  addFixtureItemModels(entries, root, fixture);
  addAudio(entries, root);
  return { fixture, entries, excluded };
}

export function createAssetManifest({ entries, excluded = [], repoRoot = defaultRepoRoot, fixtureIdentity, releaseId = fixtureIdentity, mode = "production", enforceBudget = true }) {
  if (!(entries instanceof Map)) fail("entries must be a Map");
  if (mode !== "production" && mode !== "offline") fail(`unsupported staging mode: ${mode}`);
  if (typeof fixtureIdentity !== "string" || fixtureIdentity.length === 0) fail("fixture identity is required");
  const root = path.resolve(repoRoot);
  const records = [];
  let totalBytes = 0;
  for (const destination of [...entries.keys()].sort()) {
    const entry = entries.get(destination);
    const normalizedDestination = normalizeDestination(destination);
    const sourcePath = entry?.sourcePath;
    if (!entry || typeof sourcePath !== "string") fail(`invalid manifest entry ${normalizedDestination}`);
    if (path.isAbsolute(sourcePath)) fail(`private absolute source path is forbidden: ${sourcePath}`);
    const sourceAbsolute = path.resolve(root, sourcePath);
    assertInside(sourceAbsolute, root);
    const stat = fs.lstatSync(sourceAbsolute, { throwIfNoEntry: false });
    if (!stat) fail(`missing referenced asset ${sourcePath} (destination ${normalizedDestination})`);
    if (!stat.isFile() || stat.isSymbolicLink()) fail(`referenced asset is not a regular file: ${sourcePath}`);
    assertRealInside(sourceAbsolute, root);
    const bytes = fs.readFileSync(sourceAbsolute);
    const authorities = [...(entry.authorities ?? [])].sort();
    if (authorities.length === 0) fail(`asset ${normalizedDestination} has no source authority`);
    const categories = [...(entry.categories ?? [categoryForDestination(normalizedDestination)])].sort();
    const reasons = [...(entry.reasons ?? authorities)].sort();
    totalBytes += bytes.byteLength;
    records.push({
      path: normalizedDestination,
      category: categories,
      reason: reasons,
      size: bytes.byteLength,
      sha256: sha256(bytes),
      source: sourcePath,
      authority: authorities,
    });
  }
  const excludedRecords = [...new Map(excluded.map((entry) => [entry.path, entry])).values()]
    .sort((a, b) => a.path.localeCompare(b.path));
  const excludedBytes = excludedRecords.reduce((total, entry) => total + entry.size, 0);
  const totals = { files: records.length, bytes: totalBytes };
  if (enforceBudget && (totals.files > PUBLIC_RELEASE_BUDGET.maxFiles || totals.bytes > PUBLIC_RELEASE_BUDGET.maxBytes)) {
    fail(`public release budget exceeded: ${totals.files} files/${totals.bytes} bytes; limit ${PUBLIC_RELEASE_BUDGET.maxFiles} files/${PUBLIC_RELEASE_BUDGET.maxBytes} bytes`);
  }
  const sourceIdentity = sha256(Buffer.from(canonicalJson(records.map(({ source, sha256: hash }) => ({ source, sha256: hash }))), "utf8"));
  const contentHash = sha256(Buffer.from(canonicalJson({ fixtureIdentity, sourceIdentity, entries: records }), "utf8"));

  const manifest = {
    schema: "successor-production-assets/v1",
    mode,
    releaseId: `${releaseId ?? fixtureIdentity}@${contentHash.slice(0, 16)}`,
    contentHash,
    sourceIdentity,
    fixture: { identity: fixtureIdentity },
    budget: PUBLIC_RELEASE_BUDGET,
    selection: {
      before: { files: totals.files + excludedRecords.length, bytes: totalBytes + excludedBytes },
      after: totals,
      savings: { files: excludedRecords.length, bytes: excludedBytes },
      excluded: excludedRecords.map(({ path, size, category, reason }) => ({ path, size, category, reason })),
    },
    entries: records,
    totals,
  };
  const manifestHash = sha256(Buffer.from(canonicalJson(manifest), "utf8"));
  return Object.freeze({ ...manifest, manifestSha256: manifestHash });
}

export function assertStagingMatchesManifest(stagingDir, manifest) {
  const expected = new Set([...manifest.entries.map((entry) => entry.path), PRODUCTION_MANIFEST_NAME]);
  const actual = new Set();
  function walk(current, prefix = "") {
    for (const name of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = path.join(current, name.name);
      const relative = prefix ? `${prefix}/${name.name}` : name.name;
      if (name.isDirectory()) walk(absolute, relative);
      else if (name.isFile()) actual.add(relative.split(path.sep).join("/"));
      else fail(`unexpected non-file staging entry ${relative}`);
    }
  }
  walk(stagingDir);
  const unexpected = [...actual].filter((file) => !expected.has(file)).sort();
  const missing = [...expected].filter((file) => !actual.has(file)).sort();
  if (unexpected.length || missing.length) fail(`staging contents mismatch; unexpected=${unexpected.join(",") || "none"}; missing=${missing.join(",") || "none"}`);
  for (const entry of manifest.entries) {
    const file = path.join(stagingDir, entry.path);
    const bytes = fs.readFileSync(file);
    if (bytes.byteLength !== entry.size || sha256(bytes) !== entry.sha256) {
      fail(`staged bytes changed after manifest creation: ${entry.path}`);
    }
  }
  const unsignedManifest = { ...manifest };
  delete unsignedManifest.manifestSha256;
  if (typeof manifest.manifestSha256 !== "string" || sha256(Buffer.from(canonicalJson(unsignedManifest), "utf8")) !== manifest.manifestSha256) {
    fail("manifest self-hash is invalid");
  }
  const manifestFile = path.join(stagingDir, PRODUCTION_MANIFEST_NAME);
  if (fs.readFileSync(manifestFile, "utf8") !== canonicalJson(manifest)) fail("staged manifest bytes changed after manifest creation");
  return true;
}

export function generateProductionAssets({ repoRoot = defaultRepoRoot, stagingDir = DEFAULT_STAGING_DIR, releaseId, allowExternalStaging = false, mode = "production" } = {}) {
  const root = path.resolve(repoRoot);
  if (mode !== "production" && mode !== "offline") fail(`unsupported staging mode: ${mode}`);
  const plan = mode === "offline" ? collectOfflinePlan(root) : collectReachabilityPlan({ repoRoot: root });
  const { fixture, entries, excluded } = plan;
  const fixtureIdentity = typeof fixture.stateHash === "string" && fixture.stateHash.length > 0 ? fixture.stateHash : "unknown-fixture";
  const manifest = createAssetManifest({ entries, excluded, mode, enforceBudget: mode === "production", repoRoot: root, fixtureIdentity, releaseId: releaseId ?? fixtureIdentity });
  const stage = path.resolve(stagingDir);
  if (!allowExternalStaging) assertInside(stage, root);
  for (const authoredRoot of [
    path.join(root, "client-3d", "public"),
    path.join(root, "client", "public"),
  ]) {
    const relative = path.relative(authoredRoot, stage);
    if (relative.length === 0 || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
      fail(`staging directory may not overlap authored public source: ${stage}`);
    }
  }
  const stageParts = path.relative(root, stage).split(path.sep);
  if (stageParts.some((part) => part === ".git" || part === "private" || part === ".ssh" || part === ".gnupg")) {
    fail(`staging directory targets a private repository descendant: ${stage}`);
  }
  const existingStage = fs.lstatSync(stage, { throwIfNoEntry: false });
  if (existingStage?.isSymbolicLink()) fail(`staging directory may not be a symlink: ${stage}`);
  const parent = path.dirname(stage);
  fs.mkdirSync(parent, { recursive: true });
  if (!allowExternalStaging) assertRealInside(parent, root);
  fs.rmSync(stage, { recursive: true, force: true });
  fs.mkdirSync(stage, { recursive: true });
  for (const entry of manifest.entries) {
    const sourceAbsolute = path.resolve(root, entry.source);
    const sourceBytes = fs.readFileSync(sourceAbsolute);
    if (sourceBytes.byteLength !== entry.size || sha256(sourceBytes) !== entry.sha256) {
      fail(`source drift detected during staging: ${entry.path}`);
    }
    const destinationAbsolute = path.join(stage, entry.path);
    fs.mkdirSync(path.dirname(destinationAbsolute), { recursive: true });
    fs.copyFileSync(sourceAbsolute, destinationAbsolute);
  }
  fs.writeFileSync(path.join(stage, PRODUCTION_MANIFEST_NAME), canonicalJson(manifest), "utf8");
  assertStagingMatchesManifest(stage, manifest);
  return { manifest, stagingDir: stage };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = generateProductionAssets({ releaseId: process.env.SUCCESSOR_RELEASE_ID });
  console.log(JSON.stringify({
    stagingDir: result.stagingDir,
    manifest: path.join(result.stagingDir, PRODUCTION_MANIFEST_NAME),
    fixtureIdentity: result.manifest.fixture.identity,
    files: result.manifest.totals.files,
    bytes: result.manifest.totals.bytes,
    manifestSha256: result.manifest.manifestSha256,
  }, null, 2));
}
