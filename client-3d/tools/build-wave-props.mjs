#!/usr/bin/env node
/**
 * Regenerate the Asset Lab wave-prop library from the canonical source-assets
 * iterations. Source assets are read-only; only client-3d/public/assets/wave-props
 * is replaced.
 */
import { cp, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";

const repoRoot = resolve(import.meta.dirname, "..");
const sourceRoot = resolve(process.env.SUCCESSOR_SOURCE_ASSETS ?? resolve(repoRoot, "../../source-assets"));
const finalOutputRoot = resolve(process.env.WAVE_PROPS_OUTPUT ?? join(repoRoot, "public/assets/wave-props"));
const outputRoot = finalOutputRoot + ".staging-" + process.pid;

const settledUnits = [
  { wave: "everyday-wave-20260719", lane: "crop-growth", root: "props/successor/everyday-wave-20260719/crop-growth" },
  { wave: "everyday-wave-20260719", lane: "everyday-world-props", root: "props/successor/everyday-wave-20260719/everyday-world-props" },
  { wave: "everyday-wave-20260719", lane: "prepared-foods", root: "props/successor/everyday-wave-20260719/prepared-foods" },
  { wave: "everyday-wave-20260719", lane: "raw-ingredients", root: "props/successor/everyday-wave-20260719/raw-ingredients" },
  { wave: "homebuilder-wave-20260719", lane: "building-components", root: "props/successor/homebuilder-wave-20260719/building-components" },
  { wave: "homebuilder-wave-20260719", lane: "furniture", root: "props/successor/homebuilder-wave-20260719/furniture" },
  // Rejected wave-generator gun family: excluded everywhere client-side (owner decision 2026-07-21).
  { wave: "grok45-wave-20260718", lane: "profession-world-weapons", root: "props/successor/grok45-wave-20260718/profession-world-weapons", exclude: /^successor_weapon_/ },
  { wave: "grok45-wave-20260718", lane: "vehicle-components", root: "props/vehicles/successor/grok45-wave-20260718/components" },
  { wave: "grok45-wave-20260718", lane: "vehicle-hulls", root: "props/vehicles/successor/grok45-wave-20260718/hulls", filesOnly: true },
  { wave: "grok45-wave-20260718", lane: "droid-systems", root: "characters/successor/grok45-wave-20260718/droid-systems", filesOnly: true },
];
const fullSpectrumLanes = [
  "medical-bio-lab",
  "infrastructure-computing",
  "modular-fluid-pipes",
  "contraband-chemicals",
  "ammunition-packaging",
  "scifi-handhelds",
  "extraction-installations",
  "weapon-overhaul",
].map((lane) => ({ wave: "full-spectrum-wave-20260720", lane, root: `props/successor/full-spectrum-wave-20260720/${lane}` }));

const units = [...settledUnits, ...fullSpectrumLanes];
const manifestEntries = [];
const copiedFiles = [];
const usedIds = new Set();

const exists = async (path) => {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
};

const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));

const slug = (value) => value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const humanize = (value) => value
  .replace(/\.[^.]+$/, "")
  .replace(/[_-]+/g, " ")
  .replace(/\b\w/g, (letter) => letter.toUpperCase());

async function directDirectories(path) {
  const entries = await readdir(path, { withFileTypes: true });
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
}

async function directGlbs(path) {
  if (!(await exists(path))) return [];
  const entries = await readdir(path, { withFileTypes: true });
  return entries.filter((entry) => entry.isFile() && extname(entry.name).toLowerCase() === ".glb").map((entry) => join(path, entry.name));
}

/**
 * Iteration policy: accepted reset iterations supersede the original assets.
 * Rejected/proof dirs are never considered. Among accepted iterations, the
 * source directory mtime is the "latest iteration" authority; the name rank is
 * only a deterministic tie-breaker for copied trees with equal mtimes.
 */
async function chooseIteration(root) {
  const names = await directDirectories(root);
  const candidates = [];
  for (const name of names) {
    if (/^(rejected|proof)(?:-|$)/i.test(name)) continue;
    if (!/(?:reset|canonical-rebuild)/i.test(name)) continue;
    const assets = join(root, name, "assets");
    if (!(await exists(assets))) continue;
    const rank = name.toLowerCase().startsWith("parent-reset")
      ? 3
      : name.toLowerCase().startsWith("reset")
        ? 2
        : name.toLowerCase().startsWith("canonical-rebuild")
          ? 1
          : 0;
    candidates.push({ name, root: join(root, name), assets, mtimeMs: (await stat(join(root, name))).mtimeMs, rank });
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs || b.rank - a.rank || b.name.localeCompare(a.name));
  if (candidates.length > 0) return candidates[0];
  const assets = join(root, "assets");
  return { name: "base", root, assets };
}

function rosterEntries(value) {
  if (!value || typeof value !== "object") return [];
  const assets = Array.isArray(value.assets) ? value.assets : Array.isArray(value.entries) ? value.entries : [];
  return assets.filter((entry) => entry && typeof entry === "object" && typeof entry.id === "string");
}

async function laneMetadata(unit, iteration) {
  const metadataPaths = [
    join(iteration.root, "generator/roster.json"),
    join(unit.root, "generator/roster.json"),
    join(iteration.root, "manifest.json"),
    join(unit.root, "manifest.json"),
  ];
  for (const path of metadataPaths) {
    if (await exists(path)) {
      const json = await readJson(path);
      const entries = rosterEntries(json);
      if (entries.length > 0) return entries;
    }
  }
  return [];
}

function parseCsvLine(line) {
  const cells = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === "\"") {
      if (quoted && line[index + 1] === "\"") {
        cell += "\"";
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (char === "," && !quoted) {
      cells.push(cell);
      cell = "";
    } else {
      cell += char;
    }
  }
  cells.push(cell);
  return cells;
}

async function readCatalog(unit, iteration) {
  const paths = [join(iteration.root, "catalog.csv"), join(unit.root, "catalog.csv")];
  for (const path of paths) {
    if (!(await exists(path))) continue;
    const lines = (await readFile(path, "utf8")).split(/\r?\n/).filter(Boolean);
    if (lines.length === 0) return new Map();
    const headers = parseCsvLine(lines[0]);
    const idIndex = headers.indexOf("id");
    if (idIndex < 0) return new Map();
    const categoryIndex = headers.indexOf("category");
    const familyIndex = headers.indexOf("family");
    const rows = new Map();
    for (const line of lines.slice(1)) {
      const cells = parseCsvLine(line);
      const id = cells[idIndex];
      if (!id) continue;
      rows.set(id, { category: cells[categoryIndex] || cells[familyIndex] || "" });
    }
    return rows;
  }
  return new Map();
}

function basenameFromEntry(entry) {
  if (typeof entry.glb === "string") return basename(entry.glb);
  if (typeof entry.file === "string") return basename(entry.file);
  return `${entry.id}.glb`;
}

async function resolveSourceFiles(unit, iteration, metadata) {
  const allGlbs = await directGlbs(iteration.assets);
  if (metadata.length === 0) return allGlbs.map((path) => ({ path, metadata: null }));
  const byName = new Map(allGlbs.map((path) => [basename(path), path]));
  const resolved = [];
  for (const entry of metadata) {
    const preferred = [basenameFromEntry(entry), `${entry.id}.glb`];
    const path = preferred.map((name) => byName.get(name)).find(Boolean);
    if (!path) throw new Error(`${unit.wave}/${unit.lane}: no canonical GLB for roster entry ${entry.id} in ${iteration.assets}`);
    resolved.push({ path, metadata: entry });
  }
  return resolved;
}

function categoryFor(unit, entry, catalog) {
  return String(entry?.category ?? entry?.family ?? catalog.get(entry?.id)?.category ?? unit.lane).trim().replace(/\\/g, "/") || unit.lane;
}

function labelFor(entry, sourcePath) {
  return String(entry?.display_name ?? entry?.name ?? entry?.label ?? humanize(basename(sourcePath))).trim();
}

function uniqueId(unit, sourceId) {
  if (!usedIds.has(sourceId)) {
    usedIds.add(sourceId);
    return sourceId;
  }
  const prefixed = `${slug(unit.wave)}_${slug(unit.lane)}_${sourceId}`;
  usedIds.add(prefixed);
  return prefixed;
}

async function copyUnit(unit) {
  const root = join(sourceRoot, unit.root);
  if (!(await exists(root))) throw new Error(`Missing source unit: ${root}`);
  const iteration = await chooseIteration(root);
  const metadata = unit.filesOnly ? [] : await laneMetadata(unit, iteration);
  const catalog = await readCatalog(unit, iteration);
  let files = await resolveSourceFiles(unit, iteration, metadata);
  if (unit.exclude) files = files.filter(({ path }) => !unit.exclude.test(basename(path)));
  if (files.length === 0) throw new Error(`${unit.wave}/${unit.lane}: canonical iteration has no GLBs`);
  const waveDir = slug(unit.wave);
  const laneDir = slug(unit.lane);
  for (const { path: sourcePath, metadata: entry } of files) {
    const fileName = basename(sourcePath);
    const sourceId = String(entry?.id ?? fileName.replace(/\.glb$/i, ""));
    const id = uniqueId(unit, sourceId);
    const category = categoryFor(unit, entry, catalog);
    const destinationRelative = `${waveDir}/${laneDir}/${fileName}`;
    const destination = join(outputRoot, destinationRelative);
    await mkdir(dirname(destination), { recursive: true });
    await cp(sourcePath, destination);
    copiedFiles.push({ sourcePath, destination, destinationRelative });
    manifestEntries.push({
      id,
      label: labelFor(entry, sourcePath),
      glb: destinationRelative,
      kind: category,
      group: `WORLD PROPS · ${unit.wave.toUpperCase()} · ${unit.lane.toUpperCase()}`,
      category,
      categoryPath: [unit.wave, unit.lane, category],
      animated: false,
      clips: [],
    });
  }
  console.log(`${unit.wave}/${unit.lane}: ${files.length} GLBs from ${iteration.name}`);
}

await rm(outputRoot, { recursive: true, force: true });
await mkdir(outputRoot, { recursive: true });
for (const unit of units) await copyUnit(unit);
manifestEntries.sort((a, b) => a.id.localeCompare(b.id));
const manifest = {
  format: "successor/trial-props/1",
  assetBase: "/assets/wave-props/",
  wave: "successor-wave-props-20260720",
  group: "WORLD PROPS · WAVE ASSETS",
  source: "Canonical wave GLBs copied from source-assets; reset iterations supersede original assets and rejected/proof iterations are excluded.",
  generatedAt: new Date().toISOString(),
  entries: manifestEntries,
};
await writeFile(join(outputRoot, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
const backupRoot = finalOutputRoot + ".previous-" + process.pid;
await rm(backupRoot, { recursive: true, force: true });
if (await exists(finalOutputRoot)) await rename(finalOutputRoot, backupRoot);
await rename(outputRoot, finalOutputRoot);
await rm(backupRoot, { recursive: true, force: true });

let byteSize = 0;
for (const file of copiedFiles) byteSize += (await stat(file.destination)).size;
console.log(`manifest entries: ${manifestEntries.length}`);
console.log(`copied GLBs: ${copiedFiles.length}`);
console.log(`GLB bytes: ${byteSize}`);
if (manifestEntries.length !== copiedFiles.length) throw new Error("manifest entry count does not equal copied GLB count");
