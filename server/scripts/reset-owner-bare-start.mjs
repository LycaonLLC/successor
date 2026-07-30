#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const CHARACTER_STORE_SCHEMA = "successor.character-store.v2";
const DEFAULT_OWNER_CHARACTER_ID = process.env.SUCCESSOR_OWNER_CHARACTER_ID ?? "char_c115220cd4854251";
export const DOCTRINE_STARTING_CREDITS = 5_000;
export const DEFAULT_APOC_STARTER_WORN = [
  { item: "top_rigged_tank", colors: ["#b08040", "#406090"] },
  { item: "legs_wrapped_workpants", colors: ["#804040", "#505060", "#706050"] },
  { item: "boots_canvas_ankle", colors: ["#303030", "#808080"] },
  { item: "gloves_knuckled_half", colors: ["#406090", "#808080"] },
];

const STRIPPED_CHARACTER_KEYS = [
  "inventory",
  "items",
  "loadout",
  "equipment",
  "equipped",
  "gear",
  "weapon",
  "weaponId",
  "weaponItemId",
  "wornGear",
  "wornItems",
];

function defaultCharacterStorePath() {
  return process.env.GAME_CHARACTER_STORE_PATH
    ? path.resolve(process.env.GAME_CHARACTER_STORE_PATH)
    : path.resolve(import.meta.dirname, "..", "data", "characters.json");
}

function usage() {
  return [
    "Usage: node server/scripts/reset-owner-bare-start.mjs [--store PATH] [--character-id ID] [--owner-ref REF] [--name NAME]",
    "",
    "Backs up the character store, then rewrites exactly one character to the ratified bare-start doctrine:",
    "  - identity, appearance, professions/skills, recordKinds, timestamps, and playtime are preserved",
    "  - creator worn clothes are preserved when present; otherwise the default apoc starter clothes are written",
    "  - runtime/inventory/equipment/loadout fields outside the character-store schema are stripped",
    "  - position and vitals are nulled so the next join takes the normal new-player spawn/health path",
    `  - starting credits are the authority balance const DOCTRINE_STARTING_CREDITS=${DOCTRINE_STARTING_CREDITS} (not a JSON inventory chip)`,
    "",
    "Undo: copy the emitted backupPath back over the store path.",
  ].join("\n");
}

function parseArgs(argv) {
  const options = {
    store: defaultCharacterStorePath(),
    characterId: DEFAULT_OWNER_CHARACTER_ID,
    ownerRef: undefined,
    name: undefined,
  };
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      return { help: true };
    }
    const value = argv[index + 1];
    if (arg === "--store") {
      if (!value) throw new Error("--store requires a path");
      options.store = path.resolve(value);
      index += 1;
    } else if (arg === "--character-id") {
      if (!value) throw new Error("--character-id requires an id");
      options.characterId = value.trim();
      index += 1;
    } else if (arg === "--owner-ref") {
      if (!value) throw new Error("--owner-ref requires a value");
      options.ownerRef = value.trim();
      index += 1;
    } else if (arg === "--name") {
      if (!value) throw new Error("--name requires a value");
      options.name = value.trim();
      index += 1;
    } else {
      throw new Error(`unknown argument ${arg}\n${usage()}`);
    }
  }
  return options;
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function cloneWorn(worn) {
  if (!Array.isArray(worn) || worn.length === 0) return cloneJson(DEFAULT_APOC_STARTER_WORN);
  return worn
    .filter((entry) => isPlainObject(entry) && typeof entry.item === "string" && Array.isArray(entry.colors))
    .map((entry) => ({ item: entry.item, colors: entry.colors.filter((color) => typeof color === "string") }));
}

function backupPathFor(storePath, now = new Date()) {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  return `${storePath}.bare-start-${stamp}.backup`;
}

function summarizeCharacter(character) {
  const strippedKeysPresent = STRIPPED_CHARACTER_KEYS.filter((key) => Object.prototype.hasOwnProperty.call(character, key));
  return {
    id: character.id,
    ownerRef: character.ownerRef,
    name: character.name,
    worn: cloneWorn(character.worn),
    position: character.position ?? null,
    vitals: character.vitals ?? null,
    professionCount: Array.isArray(character.professions) ? character.professions.length : character.professions ? 1 : 0,
    recordKindKeys: isPlainObject(character.recordKinds) ? Object.keys(character.recordKinds).sort() : [],
    strippedKeysPresent,
  };
}

export function resetOwnerBareStart(options = {}) {
  const storePath = path.resolve(options.store ?? defaultCharacterStorePath());
  const beforeText = fs.readFileSync(storePath, "utf8");
  const data = JSON.parse(beforeText);
  if (!isPlainObject(data) || data.schema !== CHARACTER_STORE_SCHEMA || !Array.isArray(data.characters)) {
    throw new Error(`refusing non-${CHARACTER_STORE_SCHEMA} character store: ${storePath}`);
  }

  const characterId = (options.characterId ?? DEFAULT_OWNER_CHARACTER_ID).trim();
  const candidates = data.characters.filter((character) => {
    if (!isPlainObject(character)) return false;
    if (characterId && character.id !== characterId) return false;
    if (options.ownerRef && character.ownerRef !== options.ownerRef) return false;
    if (options.name && character.name !== options.name) return false;
    return true;
  });
  if (candidates.length !== 1) {
    throw new Error(`expected exactly one character match, found ${candidates.length} in ${storePath}`);
  }

  const character = candidates[0];
  const before = summarizeCharacter(character);
  const backupPath = backupPathFor(storePath);
  fs.writeFileSync(backupPath, beforeText, { encoding: "utf8", flag: "wx" });

  const preservedWorn = cloneWorn(character.worn);
  for (const key of STRIPPED_CHARACTER_KEYS) delete character[key];
  character.worn = preservedWorn.length > 0 ? preservedWorn : cloneJson(DEFAULT_APOC_STARTER_WORN);
  character.position = null;
  character.vitals = null;

  const afterText = `${JSON.stringify(data, null, 2)}\n`;
  fs.writeFileSync(storePath, afterText, "utf8");
  const after = summarizeCharacter(character);
  return {
    status: beforeText === afterText ? "already-doctrine-bare" : "reset",
    storePath,
    characterId: character.id,
    backupPath,
    undoCommand: `cp ${JSON.stringify(backupPath)} ${JSON.stringify(storePath)}`,
    doctrine: {
      startingCreditsBalance: DOCTRINE_STARTING_CREDITS,
      inventoryItems: [],
      tools: [],
      weapons: [],
      armor: [],
      wornSource: before.worn.length > 0 ? "preserved-creator-worn" : "default-apoc-starter-worn",
    },
    before,
    after,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const parsed = parseArgs(process.argv);
    if (parsed.help) {
      console.log(usage());
    } else {
      console.log(JSON.stringify(resetOwnerBareStart(parsed), null, 2));
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
