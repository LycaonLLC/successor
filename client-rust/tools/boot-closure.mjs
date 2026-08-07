#!/usr/bin/env node
// Derives the Rust web client's boot closure from authored data — never a
// hand-maintained list. Shared by tools/web-release.mjs (release packs) and
// tools/dev-serve.mjs (development manifest). Everything here is resolved
// through the same manifests the runtime consumes, so a content change moves
// the closure automatically.
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const REQUIRED_BODY_ASSETS = [
  "assets/pawn-pack/pawn_male.glb",
  "assets/pawn-pack/pawn_female.glb",
];

// Read synchronously at ConnectedScene::build; absence is a hard launch error.
const BOOT_DOCUMENTS = [
  "render/props-mapping.json",
  "successor-slice/open-desert-slice.json",
  "successor-audio/sfx/manifest.json",
  "assets/pawn-pack/equipment/manifest.json",
  "assets/pawn-pack/equipment/wardrobe_palette.json",
  "assets/pawn-pack/weapons/weapons_manifest.json",
];

// Fixed starter outfit (canonical context: items under_bodysuit and
// boots_canvas_ankle are the immutable two-piece every character owns).
const STARTER_OUTFIT_IDS = new Set(["under_bodysuit", "boots_canvas_ankle"]);

/**
 * @returns {Promise<{boot: string[], audioCore: string[]}>} stable ids sorted.
 */
export async function deriveBootClosure(repoRoot) {
  const repo = resolve(repoRoot);
  const boot = new Set([...REQUIRED_BODY_ASSETS, ...BOOT_DOCUMENTS]);

  const equipmentManifest = JSON.parse(await readFile(
    join(repo, "client-3d/public/assets/pawn-pack/equipment/manifest.json"),
    "utf8",
  ));
  for (const item of equipmentManifest.items ?? []) {
    if (!STARTER_OUTFIT_IDS.has(String(item.id ?? "").toLowerCase())) continue;
    for (const field of ["glb", "glbFemale"]) {
      const glb = item[field];
      if (typeof glb === "string" && glb.length > 0) boot.add(`assets/pawn-pack/equipment/${glb}`);
    }
  }

  // Core audio: every clip id named by the Rust trigger map. Clip ids are
  // string literals in triggers.rs; intersect with the manifest's real ids.
  const audioManifest = JSON.parse(await readFile(
    join(repo, "client/public/successor-audio/sfx/manifest.json"),
    "utf8",
  ));
  const triggerSource = await readFile(join(repo, "client-rust/source/app/src/audio/triggers.rs"), "utf8");
  const literals = new Set([...triggerSource.matchAll(/"([a-z][a-z0-9_]+)"/gu)].map((match) => match[1]));
  const audioCore = [];
  for (const clip of audioManifest.clips ?? []) {
    if (!literals.has(clip.id)) continue;
    const path = String(clip.path ?? "").replace(/^\//u, "");
    if (path.startsWith("successor-audio/")) {
      boot.add(path);
      audioCore.push(path);
    }
  }

  return { boot: [...boot].sort(), audioCore: audioCore.sort() };
}
