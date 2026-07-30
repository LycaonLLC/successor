#!/usr/bin/env node
// One-off proof capture: four dressed pawns in four wardrobe palettes.
//
// Boots ONE disposable-store backend (four pre-dressed characters) + a scratch
// vite, enters each character through the REAL charselect, screenshots the
// spawned pawn, and writes raw frames for a wardrobe review montage.
// Not a gate journey — palette coverage montage for the owner review.
//
// Usage: node tools/verification/client3d/palette-montage.mjs [--vite 29750] [--backend 29751]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Backend, Vite } from "./lib/stack.mjs";
import { loadChromium, launchBrowser, Session } from "./lib/browser.mjs";
import { runtimeUrl, writeCharacterStore } from "./lib/fixture.mjs";
import { repoRootFrom } from "./lib/util.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = repoRootFrom(__dirname);

const args = process.argv.slice(2);
const vitePort = Number(args[args.indexOf("--vite") + 1] || 0) || 29750;
const backendPort = Number(args[args.indexOf("--backend") + 1] || 0) || 29751;

// Four palettes across the dye families (all colors = legal family swatches).
const CHARACTERS = [
  {
    id: "pal-rust", name: "RustCourier", x: 512, y: 512, facing: "front",
    appearance: { skinTone: "#b98a5e", hair: "hair_afro2", hairMat: "hair_crimson", face: null },
    worn: [
      { item: "top_rigged_tank", colors: ["#804040", "#3f7472"] },
      { item: "legs_reinforced_denim_pants", colors: ["#406090", "#303030"] },
      { item: "boots_canvas_ankle", colors: ["#b0a890", "#a08858"] },
      { item: "gloves_plain_work", colors: ["#a08858"] },
    ],
  },
  {
    id: "pal-olive", name: "OliveScout", x: 512, y: 512, facing: "front",
    appearance: { skinTone: "#6f4a33", hair: "hair_mop", hairMat: "hair_moss", face: null },
    worn: [
      { item: "top_plated_rig_vest", colors: ["#6f6844", "#687048", "#5f7358"] },
      { item: "legs_gaitered_cargo_pants", colors: ["#687048", "#5f7358"] },
      { item: "boots_trail_shoes", colors: ["#5f7358", "#7a5038"] },
      { item: "gloves_tipped_work", colors: ["#687048", "#a08858"] },
    ],
  },
  {
    id: "pal-oxblood", name: "OxbloodWarden", x: 512, y: 512, facing: "front",
    appearance: { skinTone: "#4a3223", hair: "hair_crop2", hairMat: "hair_raven", face: null },
    worn: [
      { item: "top_spiked_leather_vest", colors: ["#6b3b30", "#3a3a3e"] },
      { item: "legs_skirted_workpants", colors: ["#3a3a3e", "#506078", "#6b3b30"] },
      { item: "boots_split_toe", colors: ["#6b3b30", "#b0a890"] },
      { item: "gloves_guarded_leather", colors: ["#7e4a38", "#4a4a4e"] },
    ],
  },
  {
    id: "pal-bone", name: "BoneDrifter", x: 512, y: 512, facing: "front",
    appearance: { skinTone: "#e8c39a", hair: "hair_mop", hairMat: "hair_bleach", face: null },
    worn: [
      { item: "top_laced_corset_vest", colors: ["#b0a890", "#406090", "#34302c"] },
      { item: "legs_layered_wrap_skirt", colors: ["#b0a890", "#406090", "#3c4456"] },
      { item: "boots_cuffed_runners", colors: ["#406090", "#b08040"] },
      { item: "gloves_knuckled_half", colors: ["#506078", "#303030"] },
    ],
  },
];

const runId = `palette-montage-${Date.now()}`;
const runDir = path.join(repoRoot, "verification", "ledgers", "artifacts", "client3d", runId);
const outDir = path.join(runDir, "proofs");
fs.mkdirSync(runDir, { recursive: true });
fs.mkdirSync(outDir, { recursive: true });
const storePath = writeCharacterStore(runDir, CHARACTERS);

let vite = null;
let browser = null;
let backend = null;
try {
  const loaded = loadChromium(repoRoot);
  browser = await launchBrowser(loaded.chromium);
  vite = new Vite({ repoRoot, port: vitePort, runId, runDir, logsDir: path.join(runDir, "vite") });
  await vite.start();
  backend = new Backend({ repoRoot, port: backendPort, runId, runDir, storePath, logsDir: path.join(runDir, "logs") });
  await backend.boot();

  for (const spec of CHARACTERS) {
    const session = new Session({
      browser, name: `palette:${spec.id}`, gamePort: backendPort, vitePort,
      actorId: spec.id, shotsDir: outDir, shotPrefix: spec.id,
    });
    await session.open();
    await session.goto(runtimeUrl({ vitePort, gamePort: backendPort }));
    await session.enterWorld(spec.id);
    await session.waitProbe(
      (p) => p.serverStatus === "connected" && p.authorityPlayer && (p.authorityPlayer.worn ?? []).length === 4,
      { label: "worn set live", timeoutMs: 20000 },
    );
    await new Promise((resolve) => setTimeout(resolve, 900)); // attach + palette settle
    const file = await session.shot("pawn");
    console.log(`[palette-montage] ${spec.name}: ${file}`);
    await session.close();
  }
  console.log(`[palette-montage] frames in ${outDir}`);
} finally {
  if (browser) await browser.close().catch(() => {});
  if (backend) await backend.teardown().catch(() => {});
  if (vite) await vite.stop();
}
