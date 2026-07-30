import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { writeCharacterStore, writePublicSlice, writeVerificationFixtureLoadouts } from "./fixture.mjs";
import { assertOutsideArtifactRoots, createBrowserRuntimeRoot, removeBrowserRuntimeRoot } from "./util.mjs";

const fixtureCharacter = (overrides = {}) => ({
  id: "fixture-slugger",
  name: "Slugger",
  x: 511,
  y: 97,
  initialProfessionId: "marksman",
  ...overrides,
});


const validLoadout = (items = [
  { itemId: 3101, variantId: 7, quantity: 1, equipped: true },
  { itemId: 1101, variantId: 3, quantity: 12, equipped: false },
]) => ({ mode: "client3d-pre-entry.v1", items });

async function withRunDir(run) {
  const runDir = await fs.mkdtemp(path.join(os.tmpdir(), "successor-client3d-loadout-"));
  try {
    await run(runDir);
  } finally {
    await fs.rm(runDir, { recursive: true, force: true });
  }
}

async function withScratchRepo(run) {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "successor-client3d-slice-"));
  const publicSliceDir = path.join(repoRoot, "client", "public", "successor-slice");
  const compilerDir = path.join(repoRoot, "tools", "successor");
  try {
    await fs.mkdir(publicSliceDir, { recursive: true });
    await fs.mkdir(compilerDir, { recursive: true });
    await fs.copyFile(
      path.resolve(import.meta.dirname, "../../../../tools/successor/compile-map-bundle.mjs"),
      path.join(compilerDir, "compile-map-bundle.mjs"),
    );
    await fs.writeFile(path.join(publicSliceDir, "open-desert-slice.json"), `${JSON.stringify({
      schema: "successor.slice.v1",
      stateHash: "fixture-state-hash",
      grid: { cellSizePx: 64 },
      areas: [{ id: "test-area", name: "Test Area", kind: "outdoors", width: 8, height: 8, level: 0 }],
      props: [],
      actors: [],
      inventory: [],
      populationTemplates: [],
      spawnZones: [],
      blockedCells: [],
      transitions: [],
      cloneFacilities: [],
    }, null, 2)}\n`, "utf8");
    await run(repoRoot);
  } finally {
    await fs.rm(repoRoot, { recursive: true, force: true });
  }
}

describe("client-3d pre-entry verification loadouts", () => {
  it("writes exact physical stacks into a private run-local handoff without leaking them into the saved character", async () => {
    await withRunDir(async (runDir) => {
      const character = fixtureCharacter({
        skillBoxIds: ["marksman-novice", "marksman-rifle-i", "marksman-rifle-ii", "marksman-rifle-iii"],
        verificationLoadout: validLoadout(),
      });
      const storePath = writeCharacterStore(runDir, [character]);
      const loadoutPath = writeVerificationFixtureLoadouts(runDir, [character]);

      expect(loadoutPath).toBe(path.join(runDir, "verification-pre-entry-loadouts.json"));
      const store = JSON.parse(await fs.readFile(storePath, "utf8"));
      expect(store).toMatchObject({
        schema: "successor.character-store.v2",
        characters: [{ id: "fixture-slugger", initialProfessionId: "marksman" }],
      });
      expect(store.characters[0].professions).toMatchObject({
        skillBoxes: ["marksman-novice", "marksman-rifle-i", "marksman-rifle-ii", "marksman-rifle-iii"],
      });
      expect(store.characters[0]).not.toHaveProperty("verificationLoadout");
      expect(JSON.parse(await fs.readFile(loadoutPath, "utf8"))).toEqual({
        schema: "successor.verification-pre-entry-loadouts.v1",
        mode: "client3d-pre-entry.v1",
        loadouts: [{
          characterId: "fixture-slugger",
          items: [
            { itemId: 3101, variantId: 7, quantity: 1, equipped: true },
            { itemId: 1101, variantId: 3, quantity: 12, equipped: false },
          ],
        }],
      });
    });
  });

  it("does not materialize an authority handoff for an ordinary bare-start character", async () => {
    await withRunDir(async (runDir) => {
      const ordinaryCharacter = fixtureCharacter({ id: "ordinary", name: "Ordinary" });

      expect(writeVerificationFixtureLoadouts(runDir, [ordinaryCharacter])).toBeNull();
      await expect(fs.access(path.join(runDir, "verification-pre-entry-loadouts.json"))).rejects.toThrow();
    });
  });

  it("writes the declared ordinary starter provenance for every pre-entry fixture", async () => {
    await withRunDir(async (runDir) => {
      const storePath = writeCharacterStore(runDir, [
        fixtureCharacter({ id: "scout", name: "Scout", initialProfessionId: "scout", skillBoxIds: ["scout-novice"] }),
        fixtureCharacter({ id: "explicit", name: "Explicit", initialProfessionId: "brawler" }),
        fixtureCharacter({ id: "marksman", name: "Marksman" }),
      ]);
      const store = JSON.parse(await fs.readFile(storePath, "utf8"));

      expect(store.characters.map((character) => character.initialProfessionId)).toEqual([
        "scout",
        "brawler",
        "marksman",
      ]);
      expect(store.characters.map((character) => character.professions.skillBoxes)).toEqual([
        ["scout-novice"],
        ["brawler-novice"],
        ["marksman-novice"],
      ]);
      expect(store.characters.map((character) => character.professions.credits)).toEqual([
        5_000,
        5_000,
        5_000,
      ]);
    });
  });

  it("rejects omitted or invalid initial professions instead of silently provisioning a Marksman kit", async () => {
    await withRunDir(async (runDir) => {
      expect(() => writeCharacterStore(runDir, [fixtureCharacter({
        id: "omitted",
        name: "Omitted",
        initialProfessionId: undefined,
      })])).toThrow(/requires an explicit initial profession/u);
      expect(() => writeCharacterStore(runDir, [fixtureCharacter({
        id: "invalid",
        name: "Invalid",
        initialProfessionId: "chef",
      })])).toThrow(/invalid initial profession/u);
      await expect(fs.access(path.join(runDir, "characters.json"))).rejects.toThrow();
    });
  });

  it.each([
    {
      name: "wrong verification mode",
      loadout: { mode: "non-verification", items: [{ itemId: 3101, variantId: 0, quantity: 1, equipped: true }] },
    },
    {
      name: "negative item id",
      loadout: validLoadout([{ itemId: -3101, variantId: 0, quantity: 1, equipped: true }]),
    },
    {
      name: "zero ammunition quantity",
      loadout: validLoadout([{ itemId: 1101, variantId: 0, quantity: 0, equipped: false }]),
    },
    {
      name: "duplicate physical stack",
      loadout: validLoadout([
        { itemId: 1101, variantId: 3, quantity: 12, equipped: false },
        { itemId: 1101, variantId: 3, quantity: 1, equipped: false },
      ]),
    },
    {
      name: "two equipped physical items",
      loadout: validLoadout([
        { itemId: 3101, variantId: 0, quantity: 1, equipped: true },
        { itemId: 3103, variantId: 0, quantity: 1, equipped: true },
      ]),
    },
  ])("rejects $name before it can create a pre-entry handoff", async ({ loadout }) => {
    await withRunDir(async (runDir) => {
      const character = fixtureCharacter({ verificationLoadout: loadout });

      expect(() => writeVerificationFixtureLoadouts(runDir, [character])).toThrow(/verification loadout/u);
      await expect(fs.access(path.join(runDir, "verification-pre-entry-loadouts.json"))).rejects.toThrow();
    });
  });

  it("keeps the headed Chrome profile outside the checkout and artifact tree, then cleans it up", async () => {
    await withRunDir(async (runDir) => {
      // Keep the two forbidden roots disjoint so each guard's diagnostic is
      // deterministic: an artifact violation must not also be a repository
      // violation merely because the artifact tree lives inside the checkout.
      const artifactRoot = await fs.mkdtemp(path.join(os.tmpdir(), "successor-client3d-artifact-"));
      const runtimeRoot = createBrowserRuntimeRoot({ runId: "run-1", repoRoot: runDir, artifactRoot });
      try {
        expect(runtimeRoot.startsWith(`${os.tmpdir()}${path.sep}`)).toBe(true);
        expect(assertOutsideArtifactRoots(runtimeRoot, { repoRoot: runDir, artifactRoot })).toBe(runtimeRoot);
        expect(() => assertOutsideArtifactRoots(path.join(artifactRoot, "chrome-profile"), { repoRoot: runDir, artifactRoot })).toThrow(/artifact root/u);
        expect(() => assertOutsideArtifactRoots(path.join(runDir, "chrome-profile"), { repoRoot: runDir, artifactRoot })).toThrow(/repository root/u);
      } finally {
        removeBrowserRuntimeRoot(runtimeRoot);
        await fs.rm(artifactRoot, { recursive: true, force: true });
      }
      await expect(fs.access(runtimeRoot)).rejects.toThrow();
    });
  });
});

describe("client-3d scratch map bundles", () => {
  it("compiles isolated overlays with the canonical compiler and removes both generated files", async () => {
    await withScratchRepo(async (repoRoot) => {
      const first = writePublicSlice(repoRoot, "first-slice", {
        props: [{
          id: "first-prop",
          label: "First prop",
          kind: "fixture",
          areaId: "test-area",
          cell: { x: 1, y: 1 },
          size: { w: 1, h: 1 },
          solid: false,
          visible: true,
        }],
      });
      const second = writePublicSlice(repoRoot, "second-slice", {
        props: [{
          id: "second-prop",
          label: "Second prop",
          kind: "fixture",
          areaId: "test-area",
          cell: { x: 2, y: 2 },
          size: { w: 1, h: 1 },
          solid: false,
          visible: true,
        }],
      });
      const firstBundlePath = path.join(repoRoot, "client", "public", "successor-slice", "first-slice-bundle.json");
      const secondBundlePath = path.join(repoRoot, "client", "public", "successor-slice", "second-slice-bundle.json");

      const firstBundle = JSON.parse(await fs.readFile(firstBundlePath, "utf8"));
      const secondBundle = JSON.parse(await fs.readFile(secondBundlePath, "utf8"));
      expect(firstBundle.source.path).toBe("client/public/successor-slice/first-slice.json");
      expect(secondBundle.source.path).toBe("client/public/successor-slice/second-slice.json");
      expect(firstBundle.source.hash).not.toBe(secondBundle.source.hash);

      first.cleanup();
      second.cleanup();
      await expect(fs.access(first.absPath)).rejects.toThrow();
      await expect(fs.access(firstBundlePath)).rejects.toThrow();
      await expect(fs.access(second.absPath)).rejects.toThrow();
      await expect(fs.access(secondBundlePath)).rejects.toThrow();
    });
  });
});
