import fs from "node:fs/promises";
import path from "node:path";
import { validateFixtureCombatModel } from "../lib/fixture-combat-model.mjs";

const registryPath = path.resolve(import.meta.dirname, "fixture-registry.v1.json");
const characterStoreSchema = "successor.character-store.v2";
const emptyMacrosPayload = { version: 1, items: [] };
const initialProfessionIds = ["marksman", "scout", "craftsman", "medic", "brawler"];

export async function loadFixtureRegistry(repoRoot = path.resolve(import.meta.dirname, "../../..")) {
  const registry = JSON.parse(await fs.readFile(registryPath, "utf8"));
  if (registry.schema !== "successor.fixture-registry.v1") throw new Error(`invalid fixture registry schema in ${registryPath}`);
  const defaults = registry.defaults ?? {};
  const fixtures = Object.fromEntries(Object.entries(registry.fixtures ?? {}).map(([name, fixture]) => {
    validateFixtureCombatModel(fixture.sliceOverlay?.combatModel, `fixture ${name} sliceOverlay`);
    const slicePath = path.resolve(repoRoot, fixture.slicePath ?? defaults.slicePath);
    return [name, {
      ...fixture,
      name,
      slicePath,
      defaults,
      characters: fixture.characters ?? {},
    }];
  }));
  return { ...registry, repoRoot, defaults, fixtures };
}

export async function resolveFixture(name, repoRoot) {
  const registry = await loadFixtureRegistry(repoRoot);
  const fixture = registry.fixtures[name];
  if (!fixture) throw new Error(`unknown scenario fixture ${name}; available=${Object.keys(registry.fixtures).join(", ")}`);
  const source = JSON.parse(await fs.readFile(fixture.slicePath, "utf8"));
  return {
    ...fixture,
    sourceStateHash: source.stateHash ?? null,
    sourceActorCount: Array.isArray(source.actors) ? source.actors.length : null,
  };
}

export async function materializeFixtureSlice(fixture, outDir, actorSpecs = {}) {
  const source = JSON.parse(await fs.readFile(fixture.slicePath, "utf8"));
  const combatModel = validateFixtureCombatModel(fixture.sliceOverlay?.combatModel, `fixture ${fixture.name} sliceOverlay`);
  const actorCharacterOverrides = fixtureCharacterOverrides(fixture, actorSpecs);
  const sessionCharacters = fixtureSessionCharacters(fixture, actorSpecs);
  const removesDefaultPlayerPlaceholder = sessionCharacters.length > 0
    && !sessionCharacters.some((character) => character.id === "player");
  const sourceActors = Array.isArray(source.actors) ? source.actors : [];
  const overlayActors = Array.isArray(fixture.sliceOverlay?.actors) ? fixture.sliceOverlay.actors : [];
  const needsActorOverride = [...sourceActors, ...overlayActors]
    .some((actor) => actorCharacterOverrides.has(actor.id) || (removesDefaultPlayerPlaceholder && actor.id === "player"));
  if (!fixture.sliceOverlay && !needsActorOverride) return fixture;

  await fs.mkdir(outDir, { recursive: true });
  const overlayInventory = Array.isArray(fixture.sliceOverlay?.inventory) ? fixture.sliceOverlay.inventory : [];
  const overlayProps = Array.isArray(fixture.sliceOverlay?.props) ? fixture.sliceOverlay.props : [];
  const overlayBlockedCells = Array.isArray(fixture.sliceOverlay?.blockedCells) ? fixture.sliceOverlay.blockedCells : [];
  const actorsById = new Map();
  for (const actor of sourceActors) {
    // A durable fixture character must enter through the same dynamic session
    // path as a real player. Keeping a same-id authored actor would either let
    // the session impersonate world content or make the production collision
    // guard reject it. Actor-owned slice inventory intentionally remains: the
    // interrupted-entry recovery path preserves it before claiming entry.
    if (actorCharacterOverrides.has(actor.id) || (removesDefaultPlayerPlaceholder && actor.id === "player")) continue;
    actorsById.set(actor.id, { ...actor });
  }
  for (const actor of overlayActors) {
    if (actorCharacterOverrides.has(actor.id) || (removesDefaultPlayerPlaceholder && actor.id === "player")) continue;
    actorsById.set(actor.id, { ...actor });
  }
  const sourceInventory = Array.isArray(source.inventory) ? source.inventory : [];
  const sourceReservations = Array.isArray(source.reservations) ? source.reservations : [];
  const materialized = {
    ...source,
    ...(combatModel ? { combatModel } : {}),
    stateHash: `${source.stateHash ?? "slice"}-${fixture.name}-verification`,
    actors: [...actorsById.values()],
    inventory: [
      ...sourceInventory.filter((row) => !removesDefaultPlayerPlaceholder || !actorOwnsContainer("player", row.container)),
      ...overlayInventory.map((row) => ({ ...row })),
    ],
    reservations: sourceReservations.filter((row) => !removesDefaultPlayerPlaceholder || (
      row.actor !== "player" && !actorOwnsContainer("player", row.from)
    )),
    props: [...(source.props ?? []), ...overlayProps.map((prop) => ({ ...prop }))],
    blockedCells: [...(source.blockedCells ?? []), ...overlayBlockedCells.map((cell) => ({ ...cell }))],
  };
  const slicePath = path.join(outDir, `${fixture.name}.slice.json`);
  await fs.writeFile(slicePath, `${JSON.stringify(materialized, null, 2)}\n`, "utf8");
  return {
    ...fixture,
    slicePath,
    sourceStateHash: materialized.stateHash,
    sourceActorCount: materialized.actors.length,
    materializedFrom: fixture.slicePath,
  };
}

export function resolveFixtureCharacter(fixture, ref) {
  const key = String(ref ?? "").replace(/^fixture:/u, "");
  const character = fixture.characters[key];
  if (!character) throw new Error(`fixture ${fixture.name} has no character ${ref}`);
  return normalizeFixtureCharacter(character, fixture.defaults, fixtureActorSeed(fixture, character.id));
}

export async function writeFixtureCharacterStore(fixture, outDir, actorSpecs = {}) {
  await fs.mkdir(outDir, { recursive: true });
  const used = new Map();
  for (const spec of Object.values(actorSpecs)) {
    if (!spec?.character) continue;
    const character = mergeCharacter(resolveFixtureCharacter(fixture, spec.character), spec);
    used.set(character.id, character);
  }
  if (used.size === 0) {
    for (const character of Object.values(fixture.characters)) {
      const normalized = normalizeFixtureCharacter(character, fixture.defaults, fixtureActorSeed(fixture, character.id));
      used.set(normalized.id, normalized);
    }
  }
  const payload = {
    schema: characterStoreSchema,
    characters: [...used.values()].map(characterRecord),
  };
  const storePath = path.join(outDir, "characters.json");
  await fs.writeFile(storePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return { path: storePath, characters: payload.characters };
}

export function actorDriverOptions(fixture, alias, spec) {
  const character = resolveFixtureCharacter(fixture, spec.character);
  const merged = mergeCharacter(character, spec);
  return {
    alias,
    actorId: merged.id,
    playerId: "local",
    characterId: merged.id,
    displayName: merged.name,
    spawnArea: merged.position.areaId,
    spawnX: merged.position.x,
    spawnY: merged.position.y,
    facing: merged.position.facing,
  };
}

function fixtureCharacterOverrides(fixture, actorSpecs = {}) {
  const selected = [];
  for (const { sourceCharacter, sessionCharacter } of fixtureSessionCharacterPairs(fixture, actorSpecs)) {
    // An explicit session id creates a separate durable probe instead of
    // impersonating the authored fixture actor. Leave that authored actor in
    // its source position; the session spawn owns the probe's placement.
    if (sessionCharacter.id !== sourceCharacter.id) continue;
    selected.push(sessionCharacter);
  }
  return new Map(selected.map((character) => [character.id, character]));
}

function fixtureSessionCharacters(fixture, actorSpecs = {}) {
  return fixtureSessionCharacterPairs(fixture, actorSpecs).map(({ sessionCharacter }) => sessionCharacter);
}

function fixtureSessionCharacterPairs(fixture, actorSpecs = {}) {
  const selected = [];
  for (const spec of Object.values(actorSpecs ?? {})) {
    if (!spec?.character) continue;
    const sourceCharacter = resolveFixtureCharacter(fixture, spec.character);
    selected.push({ sourceCharacter, sessionCharacter: mergeCharacter(sourceCharacter, spec) });
  }
  if (selected.length > 0) return selected;
  return Object.values(fixture.characters).map((character) => {
    const sourceCharacter = normalizeFixtureCharacter(character, fixture.defaults, fixtureActorSeed(fixture, character.id));
    return { sourceCharacter, sessionCharacter: sourceCharacter };
  });
}

function mergeCharacter(character, spec) {
  const spawn = spec.spawn ?? {};
  return {
    ...character,
    ...(spec.id === undefined ? {} : { id: requiredCharacterId(spec.id, "fixture session character id") }),
    position: {
      ...character.position,
      ...(spawn.areaId ? { areaId: spawn.areaId } : {}),
      ...(spawn.x !== undefined ? { x: Number(spawn.x) } : {}),
      ...(spawn.y !== undefined ? { y: Number(spawn.y) } : {}),
      ...(spawn.facing ? { facing: spawn.facing } : {}),
    },
  };
}

function normalizeFixtureCharacter(character, defaults = {}, actorSeed = null) {
  const position = character.position ?? {};
  const areaId = position.areaId ?? defaults.spawnArea ?? "open-desert-overworld";
  const facing = position.facing ?? defaults.facing ?? "right";
  const id = requiredString(character.id, "fixture character id");
  const initialProfessionId = requiredInitialProfessionId(character.initialProfessionId, id);
  return {
    id,
    name: requiredString(character.name, "fixture character name"),
    appearance: {
      skinTone: "#c78f62",
      hair: "hair_mop",
      hairMat: "hair_raven",
      ...(character.appearance ?? {}),
      face: character.appearance?.face ?? null,
    },
    position: {
      areaId,
      x: finiteNumber(position.x, 512),
      y: finiteNumber(position.y, 512),
      facing,
    },
    vitals: character.vitals ?? actorSeed?.vitals ?? null,
    initialProfessionId,
    professions: fixtureProfessionState(character.professions ?? actorProfessionSeed(actorSeed), initialProfessionId),
    recordKinds: character.recordKinds ?? { "successor.macros.v1": emptyMacrosPayload },
  };
}

function fixtureProfessionState(professions, initialProfessionId) {
  const normalized = {
    learned: [],
    trackXp: {},
    skillBoxes: [],
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

function fixtureActorSeed(fixture, characterId) {
  const overlayActors = Array.isArray(fixture.sliceOverlay?.actors) ? fixture.sliceOverlay.actors : [];
  return overlayActors.find((actor) => actor?.id === characterId) ?? null;
}

function actorProfessionSeed(actor) {
  if (!actor) return null;
  const learned = Array.isArray(actor.professionIds) ? actor.professionIds : [];
  const skillBoxes = Array.isArray(actor.skillBoxIds) ? actor.skillBoxIds : [];
  const hasSeed = learned.length > 0
    || skillBoxes.length > 0
    || actor.activeTitleId !== undefined
    || actor.careerGoalId !== undefined
    || actor.credits !== undefined;
  if (!hasSeed) return null;
  return {
    learned,
    skillBoxes,
    activeTitleId: actor.activeTitleId ?? null,
    careerGoalId: actor.careerGoalId ?? null,
    ...(actor.credits === undefined ? {} : { credits: actor.credits }),
  };
}

function actorOwnsContainer(actorId, container) {
  if (typeof container !== "string") return false;
  return container === actorId || container.startsWith(`${actorId}:`) || container.startsWith(`${actorId}/`);
}

function characterRecord(character) {
  const now = "2026-07-08T00:00:00.000Z";
  const worn = character.worn ?? [];
  return {
    id: character.id,
    ownerRef: "local",
    name: character.name,
    appearance: character.appearance,
    worn,
    wornColors: character.wornColors
      ?? Object.fromEntries(worn.map((entry) => [entry.item, [...(entry.colors ?? [])]])),
    position: character.position,
    vitals: character.vitals,
    initialProfessionId: character.initialProfessionId,
    professions: character.professions,
    activeTitleId: character.professions?.activeTitleId ?? null,
    careerGoalId: character.professions?.careerGoalId ?? null,
    recordKinds: character.recordKinds,
    worldEntryClaimed: false,
    createdAt: now,
    lastSeenAt: now,
    lastLogoutAt: null,
    totalPlayMs: 0,
  };
}

function requiredString(value, label) {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} is required`);
  return value;
}

function requiredInitialProfessionId(value, characterId) {
  if (value === undefined) {
    throw new Error(`fixture character ${characterId} requires an explicit initial profession`);
  }
  if (!initialProfessionIds.includes(value)) {
    throw new Error(`fixture character ${characterId} has invalid initial profession ${JSON.stringify(value)}`);
  }
  return value;
}

function requiredCharacterId(value, label) {
  const id = requiredString(value, label);
  // Match the Colyseus session's canonical normalizeActorId form exactly so
  // the stored durable id cannot normalize into a different lookup key.
  if (!/^[a-z0-9][a-z0-9_.-]{0,63}$/u.test(id)) throw new Error(`${label} is invalid`);
  return id;
}

function finiteNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}
