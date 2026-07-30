// Per-journey character store + runtime URL construction.
//
// Fixture law: probe identities ONLY (never owner chars), disposable per-run
// stores under the run dir. Each journey declares its character(s) (position,
// professions, skill boxes); we serialize them in the server's
// successor.character-store.v2 format so the REAL character-select roster
// lists them and the shard identity-join spawns the actor at the stored cell.
import path from "node:path";
import { writeJson } from "./util.mjs";
import { validateFixtureCombatModel } from "../../lib/fixture-combat-model.mjs";

const NAME_PATTERN = /^[A-Za-z]{3,16}$/u;
const NOW_ISO = "2026-07-08T00:00:00.000Z";
const DEFAULT_APPEARANCE = {
  skinTone: "#c78f62",
  hair: "hair_mop",
  hairMat: "hair_umber",
  face: null,
};
const EMPTY_MACROS = { version: 1, items: [] };
const VERIFICATION_FIXTURE_MODE = "client3d-pre-entry.v1";
const VERIFICATION_FIXTURE_LOADOUT_SCHEMA = "successor.verification-pre-entry-loadouts.v1";
const MAX_U32 = 4_294_967_295;
const CHARACTER_ID_PATTERN = /^[a-z0-9][a-z0-9_.-]{0,63}$/u;
const INITIAL_PROFESSION_IDS = ["marksman", "scout", "craftsman", "medic", "brawler"];

/**
 * Normalize a journey character spec into a store record.
 * spec: { id, name, x, y, initialProfessionId, areaId?, facing?, appearance?, vitals?, professions?, skillBoxIds? }
 */
export function characterRecord(spec) {
  if (!CHARACTER_ID_PATTERN.test(spec?.id ?? "")) throw new Error("character spec requires a canonical durable id");
  if (!NAME_PATTERN.test(spec.name ?? "")) throw new Error(`character name must be 3-16 letters: ${spec.name}`);
  const providedProfessions = spec.professions ?? (spec.skillBoxIds
    ? { learned: [], trackXp: {}, skillBoxes: spec.skillBoxIds, activeTitleId: null, credits: 5000, skillPointCap: 250 }
    : null);
  const initialProfessionId = fixtureInitialProfessionId(spec);
  const professions = fixtureProfessionState(providedProfessions, initialProfessionId);
  const worn = spec.worn ?? [];
  return {
    id: spec.id,
    ownerRef: "local",
    name: spec.name,
    appearance: {
      ...DEFAULT_APPEARANCE,
      ...(spec.appearance ?? {}),
      face: spec.appearance?.face ?? null,
    },
    worn,
    wornColors: spec.wornColors ?? Object.fromEntries(worn.map((entry) => [entry.item, [...(entry.colors ?? [])]])),
    position: {
      areaId: spec.areaId ?? "open-desert-overworld",
      x: Number(spec.x ?? 512),
      y: Number(spec.y ?? 512),
      facing: spec.facing ?? "right",
    },
    vitals: spec.vitals ?? null,
    initialProfessionId,
    professions,
    activeTitleId: professions.activeTitleId ?? null,
    careerGoalId: professions.careerGoalId ?? null,
    recordKinds: spec.recordKinds ?? { "successor.macros.v1": EMPTY_MACROS },
    worldEntryClaimed: false,
    createdAt: NOW_ISO,
    lastSeenAt: NOW_ISO,
    lastLogoutAt: null,
    totalPlayMs: 0,
  };
}

function fixtureProfessionState(professions, initialProfessionId) {
  const normalized = {
    learned: [],
    trackXp: {},
    activeTitleId: null,
    credits: 5_000,
    skillPointCap: 250,
    ...(professions ?? {}),
  };
  const skillBoxes = Array.isArray(normalized.skillBoxes) ? [...normalized.skillBoxes] : [];
  const noviceBoxId = `${initialProfessionId}-novice`;
  if (!skillBoxes.includes(noviceBoxId)) skillBoxes.unshift(noviceBoxId);
  return { ...normalized, skillBoxes };
}

function fixtureInitialProfessionId(spec) {
  if (spec.initialProfessionId === undefined) {
    throw new Error(`character spec requires an explicit initial profession: ${spec.id}`);
  }
  if (!INITIAL_PROFESSION_IDS.includes(spec.initialProfessionId)) {
    throw new Error(`invalid initial profession for ${spec.id}: ${spec.initialProfessionId}`);
  }
  return spec.initialProfessionId;
}

/** Write a disposable per-journey character store; returns its path. */
export function writeCharacterStore(runDir, characterSpecs) {
  const payload = {
    schema: "successor.character-store.v2",
    characters: characterSpecs.map(characterRecord),
  };
  const storePath = path.join(runDir, "characters.json");
  writeJson(storePath, payload);
  return storePath;
}

/**
 * Materialize the private pre-entry inventory handoff for one disposable
 * client-3d backend. The server rejects this document unless it was launched
 * by the explicit verification fixture mode. Persistent runs must keep every
 * mutable file inside one disposable per-journey root.
 */
export function writeVerificationFixtureLoadouts(runDir, characterSpecs) {
  const loadouts = characterSpecs
    .filter((spec) => spec?.verificationLoadout !== undefined)
    .map((spec) => ({ characterId: spec.id, items: normalizeVerificationLoadout(spec.id, spec.verificationLoadout) }));
  if (loadouts.length === 0) return null;
  const fixturePath = path.join(runDir, "verification-pre-entry-loadouts.json");
  writeJson(fixturePath, {
    schema: VERIFICATION_FIXTURE_LOADOUT_SCHEMA,
    mode: VERIFICATION_FIXTURE_MODE,
    loadouts,
  });
  return fixturePath;
}

function normalizeVerificationLoadout(characterId, value) {
  if (!CHARACTER_ID_PATTERN.test(characterId)
    || !hasExactKeys(value, ["mode", "items"])
    || value.mode !== VERIFICATION_FIXTURE_MODE
    || !Array.isArray(value.items)
    || value.items.length === 0
    || value.items.length > 16) {
    throw new Error(`invalid verification loadout for ${characterId}`);
  }
  const seenStacks = new Set();
  let equippedCount = 0;
  const items = value.items.map((item) => {
    if (!hasExactKeys(item, ["itemId", "variantId", "quantity", "equipped"])
      || !u32(item.itemId, false)
      || !u32(item.variantId, true)
      || !u32(item.quantity, false)
      || typeof item.equipped !== "boolean") {
      throw new Error(`invalid verification loadout item for ${characterId}`);
    }
    const key = `${item.itemId}:${item.variantId}`;
    if (seenStacks.has(key)) throw new Error(`duplicate verification loadout item ${key} for ${characterId}`);
    seenStacks.add(key);
    if (item.equipped) equippedCount += 1;
    return { itemId: item.itemId, variantId: item.variantId, quantity: item.quantity, equipped: item.equipped };
  });
  if (equippedCount > 1) throw new Error(`multiple equipped verification loadout items for ${characterId}`);
  return items;
}

function hasExactKeys(value, keys) {
  return Boolean(value)
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.keys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key));
}

function u32(value, zeroAllowed) {
  return Number.isSafeInteger(value)
    && value <= MAX_U32
    && (zeroAllowed ? value >= 0 : value > 0);
}

/**
 * Build the client-3d runtime URL. No autoEnter / player params: we want the
 * REAL character-select flow (owner spec: boot -> charselect -> spawn). The
 * shared committed slice is served by vite's client-public middleware.
 */
export function runtimeUrl({ vitePort, gamePort, equip, slicePath, mapBundlePath, extra = {} }) {
  const url = new URL(`http://127.0.0.1:${vitePort}/`);
  url.searchParams.set("gamePort", String(gamePort));
  url.searchParams.set("authority", "server");
  url.searchParams.set("slicePath", slicePath ?? "/successor-slice/open-desert-slice.json");
  url.searchParams.set("mapBundlePath", mapBundlePath ?? "/successor-slice/open-desert-map-bundle.json");
  url.searchParams.set("gameTrace", "1");
  if (equip) url.searchParams.set("equip", equip);
  for (const [key, value] of Object.entries(extra)) url.searchParams.set(key, String(value));
  return url.toString();
}


import fsSync from "node:fs";
import { spawnSync } from "node:child_process";
const PUBLIC_SLICE_DIR = "client/public/successor-slice";
/**
 * Write a disposable per-journey slice by adding run-local world rows and an
 * optional validated combat model to the committed open-desert base. The Vite
 * client and scratch backend load the same file, and a matching scratch map
 * bundle is generated below without changing either committed source file.
 * Returns { absPath, urlPath, cleanup }. cleanup() removes the scratch file.
 */
export function writePublicSlice(repoRoot, name, overlay) {
  const base = JSON.parse(fsSync.readFileSync(path.join(repoRoot, PUBLIC_SLICE_DIR, "open-desert-slice.json"), "utf8"));
  const combatModel = validateFixtureCombatModel(overlay?.combatModel, "client-3d serverSliceOverlay");
  // Preserve the authority stateHash used for the harness join. The matching
  // map bundle is regenerated from this merged scratch slice below.
  const merged = {
    ...base,
    ...(combatModel ? { combatModel } : {}),
    props: [...(base.props ?? []), ...((overlay?.props ?? []).map((prop) => ({ ...prop })))],
    actors: [...(base.actors ?? []), ...((overlay?.actors ?? []).map((actor) => ({ ...actor })))],
    inventory: [...(base.inventory ?? []), ...((overlay?.inventory ?? []).map((row) => ({ ...row })))],
    populationTemplates: [
      ...(base.populationTemplates ?? []),
      ...((overlay?.populationTemplates ?? []).map((template) => ({ ...template }))),
    ],
    spawnZones: [
      ...(base.spawnZones ?? []),
      ...((overlay?.spawnZones ?? []).map((zone) => ({ ...zone }))),
    ],
  };
  const absPath = path.join(repoRoot, PUBLIC_SLICE_DIR, `${name}.json`);
  const bundleAbsPath = path.join(repoRoot, PUBLIC_SLICE_DIR, `${name}-bundle.json`);
  writeJson(absPath, merged);
  // Regenerate a MATCHING map bundle with the canonical Successor compiler.
  // Keep the paths explicit so separate gate runs cannot fall back to, or
  // overwrite, the committed open-desert bundle.
  const compiler = path.join(repoRoot, "tools", "successor", "compile-map-bundle.mjs");
  const compilerArgs = [
    compiler,
    "--write",
    `--slice=${path.relative(repoRoot, absPath)}`,
    `--out=${path.relative(repoRoot, bundleAbsPath)}`,
  ];
  const result = spawnSync(process.execPath, compilerArgs, {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    for (const filePath of [absPath, bundleAbsPath]) {
      try { fsSync.rmSync(filePath, { force: true }); } catch { /* best-effort */ }
    }
    const output = [
      result.error ? `spawn error:\n${result.error.stack ?? result.error.message}` : null,
      result.stdout ? `stdout:\n${result.stdout}` : null,
      result.stderr ? `stderr:\n${result.stderr}` : null,
    ].filter(Boolean).join("\n").trim();
    const outcome = result.status ?? (result.signal ? `signal ${result.signal}` : "no exit status");
    throw new Error(`scratch map bundle build failed (${outcome}) running ${path.relative(repoRoot, compiler)}:\n${output || "no process output"}`);
  }
  return {
    absPath,
    urlPath: `/successor-slice/${name}.json`,
    bundleUrlPath: `/successor-slice/${name}-bundle.json`,
    cleanup: () => {
      for (const f of [absPath, bundleAbsPath]) { try { fsSync.rmSync(f, { force: true }); } catch { /* best-effort */ } }
    },
  };
}
