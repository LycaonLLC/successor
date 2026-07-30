#!/usr/bin/env node
// sync-pawn-pack.mjs — copy the cooked PawnForgeV2 game pack into client-3d.
//
// Runtime source of truth: /home/lycaon/dev/games/pawn-forge/export/game_pack/
// Template gear source of truth:
// /home/lycaon/dev/games/pawn-forge/pawnforgev2/template/
//
// Usage:
//   node scripts/sync-pawn-pack.mjs                  # copy runtime + equipment
//   node scripts/sync-pawn-pack.mjs <src-dir>        # explicit cook output
//   node scripts/sync-pawn-pack.mjs --equipment-only # template equipment only
//
// Re-run this after every re-cook or template gear update. Runtime files are
// copied, while equipment is overlaid and JSON catalogs are merged by stable
// id so promoted wardrobe items are never erased by a narrower template.
// Cook reports, staging files, and render baselines stay in pawn-forge.
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_SOURCE = "/home/lycaon/dev/games/pawn-forge/export/game_pack";
const DEFAULT_TEMPLATE_SOURCE = "/home/lycaon/dev/games/pawn-forge/pawnforgev2/template";
const EQUIPMENT_DIRECTORIES = [
  "Armor",
  "Under",
  "Materials",
];
const CLOTHING_MATERIALS_ENTRY = "ClothingMaterials";
const RUNTIME_FILES = [
  "game_pack.json",
  "manifest_anim.json",
  "slugthrower_attach.json",
  "vibrosword_attach.json",
  "pawn_male.glb",
  "pawn_female.glb",
  "slugthrower.glb",
  "vibrosword.glb",
];

const args = process.argv.slice(2);
const equipmentOnly = args.includes("--equipment-only");
const explicitSource = args.find((arg) => !arg.startsWith("--"));
const sourceDir = explicitSource ?? DEFAULT_SOURCE;
const templateDir = DEFAULT_TEMPLATE_SOURCE;
const destDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../public/assets/pawn-pack");
const equipmentDestDir = path.join(destDir, "equipment");

function requireSource(src, label) {
  if (!existsSync(src)) {
    throw new Error(`missing PawnForge source ${label}: ${src}`);
  }
  return statSync(src);
}

function readJsonIfExists(file, fallback) {
  if (!existsSync(file)) return fallback;
  return JSON.parse(readFileSync(file, "utf8"));
}

function mergeById(preferred, fallback) {
  const preferredIds = new Set(preferred.map((entry) => entry.id));
  return [...preferred, ...fallback.filter((entry) => !preferredIds.has(entry.id))];
}

function mergeEquipmentManifest(src, dest) {
  const incoming = JSON.parse(readFileSync(src, "utf8"));
  const existing = readJsonIfExists(dest, { groups: [], items: [] });
  const merged = {
    ...existing,
    ...incoming,
    groups: [...new Set([...(incoming.groups ?? []), ...(existing.groups ?? [])])],
    items: mergeById(incoming.items ?? [], existing.items ?? []),
  };
  writeFileSync(dest, `${JSON.stringify(merged, null, 1)}\n`);
  console.log(`merged equipment/manifest.json (${merged.items.length} items)`);
}

function mergeClothingMaterials(srcDir, destDir) {
  const srcManifest = path.join(srcDir, "clothing_materials.json");
  const destManifest = path.join(destDir, "clothing_materials.json");
  const existing = readJsonIfExists(destManifest, { materials: [] });
  cpSync(srcDir, destDir, { recursive: true });
  const incoming = JSON.parse(readFileSync(srcManifest, "utf8"));
  const merged = {
    ...existing,
    ...incoming,
    materials: mergeById(incoming.materials ?? [], existing.materials ?? []),
  };
  writeFileSync(destManifest, `${JSON.stringify(merged, null, 1)}\n`);
  console.log(`merged equipment/ClothingMaterials (${merged.materials.length} materials)`);
}

const runtimeSources = equipmentOnly
  ? []
  : RUNTIME_FILES.map((file) => {
      const src = path.join(sourceDir, file);
      return { file, src, bytes: requireSource(src, file).size };
    });
const equipmentSources = EQUIPMENT_DIRECTORIES.map((entry) => {
  const src = path.join(templateDir, entry);
  requireSource(src, `template/${entry}`);
  return { entry, src };
});
requireSource(path.join(templateDir, "manifest.json"), "template/manifest.json");
requireSource(path.join(templateDir, CLOTHING_MATERIALS_ENTRY), `template/${CLOTHING_MATERIALS_ENTRY}`);

mkdirSync(destDir, { recursive: true });
for (const { file, src, bytes } of runtimeSources) {
  const dest = path.join(destDir, file);
  copyFileSync(src, dest);
  console.log(`synced ${file} (${bytes} bytes)`);
}

mkdirSync(equipmentDestDir, { recursive: true });
for (const { entry, src } of equipmentSources) {
  const dest = path.join(equipmentDestDir, entry);
  cpSync(src, dest, { recursive: true });
  console.log(`overlaid equipment/${entry}`);
}
mergeEquipmentManifest(
  path.join(templateDir, "manifest.json"),
  path.join(equipmentDestDir, "manifest.json"),
);
mergeClothingMaterials(
  path.join(templateDir, CLOTHING_MATERIALS_ENTRY),
  path.join(equipmentDestDir, CLOTHING_MATERIALS_ENTRY),
);
console.log(`pawn pack synced -> ${destDir}`);

console.log("NOTE: vite snapshots public/ at boot — if the 5179 dev server was already running, restart it (systemctl --user restart successor-client-3d-5179.service) or new/changed pack files may be served as index.html.");
