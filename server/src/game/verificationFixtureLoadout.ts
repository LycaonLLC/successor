import fs from "node:fs";
import path from "node:path";

export const verificationFixtureMode = "client3d-pre-entry.v1" as const;
const verificationFixtureSchema = "successor.verification-pre-entry-loadouts.v1";
const maxU32 = 4_294_967_295;
const characterIdPattern = /^[a-z0-9][a-z0-9_.-]{0,63}$/u;

export interface VerificationFixtureLoadoutItem {
  itemId: number;
  variantId: number;
  quantity: number;
  equipped: boolean;
}

export type VerificationFixtureLoadouts = ReadonlyMap<string, readonly VerificationFixtureLoadoutItem[]>;


/**
 * Reads the private, per-run fixture handoff used only by the client-3d
 * verification backend. Persistent fixture runs must prove that every mutable
 * path is contained by one explicit disposable root; a production shard must
 * fail closed instead of accepting an accidental provisioning file.
 */
export function loadVerificationFixtureLoadouts(env: NodeJS.ProcessEnv = process.env): VerificationFixtureLoadouts {
  const mode = env.GAME_VERIFICATION_FIXTURE_MODE?.trim();
  const fixturePath = env.GAME_VERIFICATION_FIXTURE_LOADOUTS_PATH?.trim();
  if (!mode && !fixturePath) return new Map();
  if (mode !== verificationFixtureMode) {
    throw new Error(`verification fixture loadouts require GAME_VERIFICATION_FIXTURE_MODE=${verificationFixtureMode}`);
  }
  if (!fixturePath) throw new Error("verification fixture loadouts require GAME_VERIFICATION_FIXTURE_LOADOUTS_PATH");
  if (env.GAME_SHARD_PERSISTENCE !== "0") {
    assertIsolatedPersistentFixtureEnv(env, fixturePath);
  }

  let document: unknown;
  try {
    document = JSON.parse(fs.readFileSync(fixturePath, "utf8"));
  } catch (error) {
    throw new Error(
      `verification fixture loadouts could not be read: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  return parseVerificationFixtureLoadouts(document);
}

function assertIsolatedPersistentFixtureEnv(env: NodeJS.ProcessEnv, fixturePath: string): void {
  if (env.GAME_SHARD_PERSISTENCE !== "1") {
    throw new Error("verification fixture loadouts require GAME_SHARD_PERSISTENCE=0 or an isolated persistent fixture contract");
  }
  if (env.GAME_ALLOW_DEV_IDENTITY !== "1") {
    throw new Error("persistent verification fixture loadouts require GAME_ALLOW_DEV_IDENTITY=1");
  }
  const rootValue = env.GAME_VERIFICATION_FIXTURE_ROOT?.trim();
  if (!rootValue || !path.isAbsolute(rootValue)) {
    throw new Error("persistent verification fixture loadouts require an absolute GAME_VERIFICATION_FIXTURE_ROOT");
  }
  const root = path.resolve(rootValue);
  const mutablePaths = [
    ["GAME_VERIFICATION_FIXTURE_LOADOUTS_PATH", fixturePath],
    ["GAME_CHARACTER_STORE_PATH", env.GAME_CHARACTER_STORE_PATH],
    ["GAME_SHARD_STATE_DIR", env.GAME_SHARD_STATE_DIR],
    ["GAME_SHARD_CHECKPOINT_PATH", env.GAME_SHARD_CHECKPOINT_PATH],
    ["GAME_SHARD_JOURNAL_PATH", env.GAME_SHARD_JOURNAL_PATH],
  ] as const;
  for (const [name, value] of mutablePaths) {
    if (!value?.trim() || !path.isAbsolute(value)) {
      throw new Error(`persistent verification fixture loadouts require absolute ${name}`);
    }
    const candidate = path.resolve(value);
    const relative = path.relative(root, candidate);
    if (relative === "" && name !== "GAME_SHARD_STATE_DIR") continue;
    if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error(`persistent verification fixture path ${name} escapes GAME_VERIFICATION_FIXTURE_ROOT`);
    }
  }

  const stateDir = path.resolve(env.GAME_SHARD_STATE_DIR!);
  for (const [name, value] of [
    ["GAME_SHARD_CHECKPOINT_PATH", env.GAME_SHARD_CHECKPOINT_PATH!],
    ["GAME_SHARD_JOURNAL_PATH", env.GAME_SHARD_JOURNAL_PATH!],
  ] as const) {
    const relative = path.relative(stateDir, path.resolve(value));
    if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error(`persistent verification fixture path ${name} must be inside GAME_SHARD_STATE_DIR`);
    }
  }
}

export function parseVerificationFixtureLoadouts(document: unknown): VerificationFixtureLoadouts {
  if (!isExactRecord(document, ["schema", "mode", "loadouts"])
    || document.schema !== verificationFixtureSchema
    || document.mode !== verificationFixtureMode
    || !Array.isArray(document.loadouts)) {
    throw new Error("invalid verification fixture loadout document");
  }
  const loadouts = new Map<string, readonly VerificationFixtureLoadoutItem[]>();
  for (const entry of document.loadouts) {
    if (!isExactRecord(entry, ["characterId", "items"])
      || typeof entry.characterId !== "string"
      || !characterIdPattern.test(entry.characterId)
      || !Array.isArray(entry.items)
      || entry.items.length === 0
      || entry.items.length > 16
      || loadouts.has(entry.characterId)) {
      throw new Error("invalid verification fixture loadout entry");
    }
    const seenStacks = new Set<string>();
    let equippedCount = 0;
    const items = entry.items.map((item) => {
      if (!isExactRecord(item, ["itemId", "variantId", "quantity", "equipped"])
        || !u32(item.itemId, false)
        || !u32(item.variantId, true)
        || !u32(item.quantity, false)
        || typeof item.equipped !== "boolean") {
        throw new Error(`invalid verification fixture item for ${entry.characterId}`);
      }
      const key = `${item.itemId}:${item.variantId}`;
      if (seenStacks.has(key)) throw new Error(`duplicate verification fixture item ${key} for ${entry.characterId}`);
      seenStacks.add(key);
      if (item.equipped) equippedCount += 1;
      return { itemId: item.itemId, variantId: item.variantId, quantity: item.quantity, equipped: item.equipped };
    });
    if (equippedCount > 1) throw new Error(`verification fixture loadout has multiple equipped items for ${entry.characterId}`);
    loadouts.set(entry.characterId, items);
  }
  return loadouts;
}

function isExactRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function u32(value: unknown, zeroAllowed: boolean): value is number {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value <= maxU32
    && (zeroAllowed ? value >= 0 : value > 0);
}
