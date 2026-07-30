import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { loadVerificationFixtureLoadouts } from "./verificationFixtureLoadout.js";

const validDocument = (loadouts = [{
  characterId: "fixture-slugger",
  items: [
    { itemId: 3101, variantId: 7, quantity: 1, equipped: true },
    { itemId: 1101, variantId: 3, quantity: 12, equipped: false },
  ],
}]) => ({
  schema: "successor.verification-pre-entry-loadouts.v1",
  mode: "client3d-pre-entry.v1",
  loadouts,
});

async function withFixtureDocument(document: unknown, run: (fixturePath: string) => void | Promise<void>): Promise<void> {
  const runDir = await fs.mkdtemp(path.join(os.tmpdir(), "successor-verification-loadout-"));
  const fixturePath = path.join(runDir, "loadouts.json");
  try {
    await fs.writeFile(fixturePath, `${JSON.stringify(document)}\n`, "utf8");
    await run(fixturePath);
  } finally {
    await fs.rm(runDir, { recursive: true, force: true });
  }
}

function fixtureEnv(fixturePath: string, overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    GAME_VERIFICATION_FIXTURE_MODE: "client3d-pre-entry.v1",
    GAME_VERIFICATION_FIXTURE_LOADOUTS_PATH: fixturePath,
    GAME_SHARD_PERSISTENCE: "0",
    ...overrides,
  };
}

function persistentFixtureEnv(fixturePath: string, overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const root = path.dirname(fixturePath);
  const stateDir = path.join(root, "game-state");
  return fixtureEnv(fixturePath, {
    GAME_SHARD_PERSISTENCE: "1",
    GAME_ALLOW_DEV_IDENTITY: "1",
    GAME_VERIFICATION_FIXTURE_ROOT: root,
    GAME_CHARACTER_STORE_PATH: path.join(root, "characters.json"),
    GAME_SHARD_STATE_DIR: stateDir,
    GAME_SHARD_CHECKPOINT_PATH: path.join(stateDir, "fixture.checkpoint.json"),
    GAME_SHARD_JOURNAL_PATH: path.join(stateDir, "fixture.journal.jsonl"),
    ...overrides,
  });
}

describe("verification pre-entry authority loadout file", () => {
  it("loads exact equipped weapon and ammunition stacks only for the requested character", async () => {
    await withFixtureDocument(validDocument(), (fixturePath) => {
      const loadouts = loadVerificationFixtureLoadouts(fixtureEnv(fixturePath));

      expect(loadouts.get("fixture-slugger")).toEqual([
        { itemId: 3101, variantId: 7, quantity: 1, equipped: true },
        { itemId: 1101, variantId: 3, quantity: 12, equipped: false },
      ]);
      expect(loadouts.get("ordinary-character")).toBeUndefined();
    });
  });

  it("allows an explicitly isolated persistent fixture lane", async () => {
    await withFixtureDocument(validDocument(), (fixturePath) => {
      expect(loadVerificationFixtureLoadouts(persistentFixtureEnv(fixturePath)).get("fixture-slugger")).toHaveLength(2);
    });
  });

  it.each([
    {
      name: "an absent fixture mode",
      env: (fixturePath: string) => fixtureEnv(fixturePath, { GAME_VERIFICATION_FIXTURE_MODE: undefined }),
      message: /GAME_VERIFICATION_FIXTURE_MODE/u,
    },
    {
      name: "a non-verification fixture mode",
      env: (fixturePath: string) => fixtureEnv(fixturePath, { GAME_VERIFICATION_FIXTURE_MODE: "development" }),
      message: /GAME_VERIFICATION_FIXTURE_MODE/u,
    },
    {
      name: "a persistent shard without an isolated fixture root",
      env: (fixturePath: string) => fixtureEnv(fixturePath, { GAME_SHARD_PERSISTENCE: "1" }),
      message: /GAME_ALLOW_DEV_IDENTITY=1|GAME_VERIFICATION_FIXTURE_ROOT/u,
    },
  ])("rejects $name even when the loadout document is otherwise valid", async ({ env, message }) => {
    await withFixtureDocument(validDocument(), (fixturePath) => {
      expect(() => loadVerificationFixtureLoadouts(env(fixturePath))).toThrow(message);
    });
  });

  it.each([
    ["character store", "GAME_CHARACTER_STORE_PATH", path.join(os.tmpdir(), "escaped-characters.json")],
    ["checkpoint", "GAME_SHARD_CHECKPOINT_PATH", path.join(os.tmpdir(), "escaped-checkpoint.json")],
    ["journal", "GAME_SHARD_JOURNAL_PATH", path.join(os.tmpdir(), "escaped-journal.jsonl")],
  ])("rejects an isolated persistent fixture whose %s escapes its disposable root", async (_label, envName, escapedPath) => {
    await withFixtureDocument(validDocument(), (fixturePath) => {
      expect(() => loadVerificationFixtureLoadouts(persistentFixtureEnv(fixturePath, {
        [envName]: escapedPath,
      }))).toThrow(/escapes GAME_VERIFICATION_FIXTURE_ROOT/u);
    });
  });

  it.each([
    {
      name: "a negative physical item identifier",
      document: validDocument([{
        characterId: "fixture-slugger",
        items: [{ itemId: -3101, variantId: 0, quantity: 1, equipped: true }],
      }]),
      message: /invalid verification fixture item/u,
    },
    {
      name: "a duplicate physical stack",
      document: validDocument([{
        characterId: "fixture-slugger",
        items: [
          { itemId: 1101, variantId: 3, quantity: 12, equipped: false },
          { itemId: 1101, variantId: 3, quantity: 1, equipped: false },
        ],
      }]),
      message: /duplicate verification fixture item/u,
    },
    {
      name: "multiple equipped physical stacks",
      document: validDocument([{
        characterId: "fixture-slugger",
        items: [
          { itemId: 3101, variantId: 0, quantity: 1, equipped: true },
          { itemId: 3103, variantId: 0, quantity: 1, equipped: true },
        ],
      }]),
      message: /multiple equipped items/u,
    },
  ])("rejects $name instead of provisioning it into authority", async ({ document, message }) => {
    await withFixtureDocument(document, (fixturePath) => {
      expect(() => loadVerificationFixtureLoadouts(fixtureEnv(fixturePath))).toThrow(message);
    });
  });
});
