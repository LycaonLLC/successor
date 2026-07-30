#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const specRoot = path.join(root, "src", "slice-core", "specs");

const weapons = readJson("weapons.v1.json");
const progression = readJson("progression.v1.json");
const tuning = readJson("tuning.v1.json");
const actors = readJson("actor-archetypes.v1.json");

assert(weapons.schema === "successor.weapon-catalog.v1", "weapon schema mismatch");
assert(progression.schema === "successor.progression-specs.v1", "progression schema mismatch");
assert(tuning.schema === "successor.slice-tuning.v1", "tuning schema mismatch");
assert(actors.schema === "successor.actor-archetypes.v1", "actor archetype schema mismatch");

const weaponIds = Object.keys(weapons.weapons ?? {}).sort();
assert(weaponIds.includes("slugthrower"), "slugthrower spec missing");
const slugSpec = weapons.weapons["slugthrower"];
assert(slugSpec.id === "slugthrower", "slugthrower id mismatch");
assert(slugSpec.caliber === "slug", "slugthrower ammo caliber mismatch");
assert(slugSpec.requiredCert === "cert_rifle", "slugthrower cert mismatch");
assertPositive(slugSpec.magazineSize, "slugthrower magazineSize");
assertPositive(slugSpec.reloadMs, "slugthrower reloadMs");

const professionIds = Object.keys(progression.professions ?? {}).sort();
for (const profession of ["bioengineer", "brawler", "commando", "craftsman", "marksman", "medic", "scout"]) {
  assert(professionIds.includes(profession), `missing profession ${profession}`);
}
assertPositive(progression.professionRankXp, "professionRankXp");
assertPositive(progression.sessionBuffDurationMs, "sessionBuffDurationMs");

const skillNodeIds = new Set();
for (const node of progression.skillNodes ?? []) {
  assert(typeof node.id === "string" && node.id.length > 0, "skill node missing id");
  assert(!skillNodeIds.has(node.id), `duplicate skill node ${node.id}`);
  assert(professionIds.includes(node.profession), `skill node ${node.id} has invalid profession`);
  assert(Array.isArray(node.grants), `skill node ${node.id} grants must be an array`);
  skillNodeIds.add(node.id);
}

const effectIds = Object.keys(progression.effects ?? {}).sort();
for (const effectId of ["clone-sickness", "entertainer-session", "medic-prep"]) {
  assert(effectIds.includes(effectId), `missing effect ${effectId}`);
  const effect = progression.effects[effectId];
  assert(effect.id === effectId, `effect id mismatch ${effectId}`);
  assert(professionIds.includes(effect.sourceProfession), `effect ${effectId} has invalid source profession`);
  assertPositive(effect.durationMs, `effect ${effectId} durationMs`);
  assertTraitDelta(effect.traitDelta, `effect ${effectId}.traitDelta`);
}

assertPositive(tuning.movement?.playerSpeedCellsPerSecond, "movement.playerSpeedCellsPerSecond");
assertPositive(tuning.movement?.sprintSpeedMultiplier, "movement.sprintSpeedMultiplier");
assertPositive(tuning.movement?.sprintActionDrainPerSecond, "movement.sprintActionDrainPerSecond");
assertPositive(tuning.spatialChat?.minTtlMs, "spatialChat.minTtlMs");
assertPositive(tuning.spatialChat?.maxTtlMs, "spatialChat.maxTtlMs");
assertPositive(tuning.spatialChat?.maxStack, "spatialChat.maxStack");
const actorRoleIds = Object.keys(actors.roles ?? {}).sort();
for (const role of ["player", "public_shopkeeper", "range_guard", "creature", "scripted_player"]) {
  assert(actorRoleIds.includes(role), `missing actor role ${role}`);
}
for (const zone of ["head", "torso", "left_arm", "right_arm", "legs"]) {
  assertPositive(actors.bodyZones?.[zone]?.hp, `actor body zone ${zone}.hp`);
}
assertTraits(actors.defaults?.traits, "actors.defaults.traits");
for (const [role, spec] of Object.entries(actors.roles ?? {})) {
  if (spec.traits !== undefined) assertTraits(spec.traits, `actors.roles.${role}.traits`);
}
for (const armorKey of ["head", "torso", "arms", "legs"]) {
  assertNonNegative(actors.defaults?.armor?.[armorKey], `actors.defaults.armor.${armorKey}`);
}

console.log(JSON.stringify({
  ok: true,
  specs: {
    weapons: {
      schema: weapons.schema,
      ids: weaponIds,
    },
    progression: {
      schema: progression.schema,
      professions: professionIds,
      skillNodes: Array.from(skillNodeIds).sort(),
      effects: effectIds,
    },
    tuning: {
      schema: tuning.schema,
      playerSpeedCellsPerSecond: tuning.movement.playerSpeedCellsPerSecond,
      sprintSpeedMultiplier: tuning.movement.sprintSpeedMultiplier,
      sprintActionDrainPerSecond: tuning.movement.sprintActionDrainPerSecond,
    },
    actors: {
      schema: actors.schema,
      roles: actorRoleIds,
      bodyZones: Object.keys(actors.bodyZones ?? {}).sort(),
    },
  },
}, null, 2));

function readJson(file) {
  return JSON.parse(fs.readFileSync(path.join(specRoot, file), "utf8"));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertPositive(value, label) {
  assert(typeof value === "number" && Number.isFinite(value) && value > 0, `${label} must be positive`);
}

function assertNonNegative(value, label) {
  assert(typeof value === "number" && Number.isFinite(value) && value >= 0, `${label} must be non-negative`);
}

function assertTraits(value, label) {
  assertPositive(value?.body, `${label}.body`);
  assertPositive(value?.spirit, `${label}.spirit`);
}

function assertTraitDelta(value, label) {
  assert(value && typeof value === "object", `${label} must be an object`);
  for (const key of ["body", "spirit"]) {
    if (value[key] !== undefined) {
      assert(typeof value[key] === "number" && Number.isFinite(value[key]), `${label}.${key} must be finite`);
    }
  }
}
