#!/usr/bin/env node
// CraftWindowFE live-proof fixture (FIXTURE LAW: disposable slice copy, own
// file + own port — the shared open-desert slice is never mutated).
//
// Seeds the committed open-desert slice with exactly what the four-phase
// battery arc needs: copper stacks in three variants (one short stack so the
// honest-shortage state is visible), the Field Multitool, and the
// craftsman-novice skill box that unlocks the extractor_battery recipe
// (iron casing stacks already ship in the base fixture). Writes the paired
// slice + map bundle under successor-slice/craftfe-proof/.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const sliceDir = path.join(repoRoot, "client", "public", "successor-slice");
const outDir = path.join(sliceDir, "craftfe-proof");
const sourceSlice = path.join(sliceDir, "open-desert-slice.json");
const sourceBundle = path.join(sliceDir, "open-desert-map-bundle.json");
const outSlice = path.join(outDir, "craftfe-proof-slice.json");
const outBundle = path.join(outDir, "craftfe-proof-map-bundle.json");

const slice = JSON.parse(fs.readFileSync(sourceSlice, "utf8"));

const PACK = "player:field-pack";
const seedRows = [
  // Copper (2007): the conductor slot wants 24. Variants pick different
  // deterministic stat rolls server-side; 226118 carries the low-qty stack.
  { container: PACK, item: "Copper Resource Container", itemId: 2007, variantId: 220431, quantity: 40, reserved: 0, available: 40 },
  { container: PACK, item: "Copper Resource Container", itemId: 2007, variantId: 221502, quantity: 30, reserved: 0, available: 30 },
  { container: PACK, item: "Copper Resource Container", itemId: 2007, variantId: 226118, quantity: 10, reserved: 0, available: 10 },
  // Field Multitool at starter quality (variant encodes quality milli).
  { container: PACK, item: "Field Multitool", itemId: 3001, variantId: 500, quantity: 1, reserved: 0, available: 1 },
];
slice.inventory = [...slice.inventory, ...seedRows];

const player = slice.actors.find((actor) => actor.id === "player");
if (!player) throw new Error("open-desert slice has no player actor");
player.professionIds = [...new Set([...(player.professionIds ?? []), "craftsman"])];
player.skillBoxIds = [...new Set([...(player.skillBoxIds ?? []), "craftsman-novice"])];

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(outSlice, JSON.stringify(slice));
fs.copyFileSync(sourceBundle, outBundle);

console.log(JSON.stringify({
  ok: true,
  slice: path.relative(repoRoot, outSlice),
  bundle: path.relative(repoRoot, outBundle),
  seededRows: seedRows.length,
  playerSkillBoxes: player.skillBoxIds,
}, null, 2));
