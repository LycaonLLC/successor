import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  actorDriverOptions,
  materializeFixtureSlice,
  writeFixtureCharacterStore,
} from "./fixture-registry.mjs";

describe("scenario fixture registry", () => {
  it("keeps the bank clone trainer overlay aligned with the canonical slice geography", async () => {
    const registry = JSON.parse(await fs.readFile(path.resolve(import.meta.dirname, "fixture-registry.v1.json"), "utf8"));
    const fixture = registry.fixtures["open-desert-multiplayer-bank-clone-corpse"];
    const overlayTrainer = fixture.sliceOverlay.actors.find((actor) => actor.id === "camp-trainer");
    const source = JSON.parse(await fs.readFile(path.resolve(import.meta.dirname, "../../../client/public/successor-slice/open-desert-slice.json"), "utf8"));
    const sourceTrainer = source.actors.find((actor) => actor.id === "camp-trainer");
    expect(overlayTrainer?.cell).toEqual(sourceTrainer?.cell);
  });
  it("removes a selected durable character from authored actors before overlay replacement", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "successor-fixture-registry-"));
    try {
      const slicePath = path.join(tempDir, "slice.json");
      await fs.writeFile(slicePath, `${JSON.stringify({
        stateHash: "seed-hash",
        actors: [
          {
            id: "player",
            label: "Field Observer",
            areaId: "open-desert-overworld",
            direction: "front",
            cell: { x: 512, y: 512 },
            professionIds: ["marksman"],
            skillBoxIds: ["marksman-novice"],
          },
          {
            id: "npc-1",
            label: "Source NPC",
            areaId: "open-desert-overworld",
            direction: "front",
            cell: { x: 1, y: 1 },
          },
        ],
        props: [{ id: "source-prop", cell: { x: 1, y: 1 } }],
      }, null, 2)}\n`, "utf8");

      const fixture = {
        name: "unit-fixture",
        slicePath,
        defaults: { spawnArea: "open-desert-overworld", facing: "right" },
        characters: {
          ranger: {
            id: "player",
            name: "RangerOne",
            initialProfessionId: "marksman",
            position: { areaId: "open-desert-overworld", x: 520, y: 520, facing: "right" },
          },
        },
        sliceOverlay: {
          actors: [
            {
              id: "npc-1",
              label: "Overlay NPC",
              areaId: "open-desert-overworld",
              direction: "left",
              cell: { x: 2, y: 3 },
            },
          ],
          props: [{ id: "overlay-prop", cell: { x: 2, y: 3 } }],
        },
      };

      const materialized = await materializeFixtureSlice(fixture, path.join(tempDir, "out"), {
        alpha: { character: "fixture:ranger" },
      });
      const output = JSON.parse(await fs.readFile(materialized.slicePath, "utf8"));

      expect(output.stateHash).toBe("seed-hash-unit-fixture-verification");
      expect(output.actors).toHaveLength(1);
      expect(output.actors.find((actor) => actor.id === "player")).toBeUndefined();
      expect(output.actors.find((actor) => actor.id === "npc-1")).toMatchObject({
        label: "Overlay NPC",
        direction: "left",
        cell: { x: 2, y: 3 },
      });
      expect(output.props).toEqual([
        { id: "source-prop", cell: { x: 1, y: 1 } },
        { id: "overlay-prop", cell: { x: 2, y: 3 } },
      ]);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("uses an explicit durable probe id without claiming the default player placeholder", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "successor-fixture-registry-"));
    try {
      const slicePath = path.join(tempDir, "slice.json");
      await fs.writeFile(slicePath, `${JSON.stringify({
        stateHash: "seed-hash",
        actors: [
          {
            id: "player",
            label: "Field Observer",
            areaId: "open-desert-overworld",
            direction: "front",
            cell: { x: 512, y: 512 },
          },
          {
            id: "fixture-ranger",
            label: "Authored Ranger",
            areaId: "open-desert-overworld",
            direction: "front",
            cell: { x: 520, y: 520 },
          },
        ],
        inventory: [
          { container: "player:field-pack", itemId: 1001, variantId: 0, quantity: 4, available: 4, reserved: 0 },
          { container: "fixture-ranger:field-pack", itemId: 2001, variantId: 0, quantity: 2, available: 2, reserved: 0 },
        ],
      }, null, 2)}\n`, "utf8");
      const fixture = {
        name: "durable-probe",
        slicePath,
        defaults: { spawnArea: "open-desert-overworld", facing: "right" },
        characters: {
          ranger: {
            id: "fixture-ranger",
            name: "RangerOne",
            initialProfessionId: "scout",
            position: { areaId: "open-desert-overworld", x: 520, y: 520, facing: "right" },
          },
        },
        // Force a run-local copy so the authored actor can be inspected.
        sliceOverlay: { blockedCells: [{ areaId: "open-desert-overworld", x: 1, y: 1 }] },
      };
      const actorSpecs = {
        alpha: {
          character: "fixture:ranger",
          id: "durable-ranger-probe",
          spawn: { areaId: "open-desert-overworld", x: 530, y: 531, facing: "left" },
        },
      };

      const materialized = await materializeFixtureSlice(fixture, path.join(tempDir, "out"), actorSpecs);
      const output = JSON.parse(await fs.readFile(materialized.slicePath, "utf8"));
      expect(output.actors).toEqual([expect.objectContaining({
        id: "fixture-ranger",
        label: "Authored Ranger",
        direction: "front",
        cell: { x: 520, y: 520 },
      })]);
      expect(output.inventory).toEqual([
        expect.objectContaining({ container: "fixture-ranger:field-pack", itemId: 2001, quantity: 2 }),
      ]);

      const store = await writeFixtureCharacterStore(fixture, path.join(tempDir, "store"), actorSpecs);
      expect(store.characters).toEqual([expect.objectContaining({
        id: "durable-ranger-probe",
        name: "RangerOne",
        initialProfessionId: "scout",
        position: { areaId: "open-desert-overworld", x: 530, y: 531, facing: "left" },
        professions: expect.objectContaining({ skillBoxes: ["scout-novice"] }),
      })]);
      expect(actorDriverOptions(fixture, "alpha", actorSpecs.alpha)).toMatchObject({
        actorId: "durable-ranger-probe",
        characterId: "durable-ranger-probe",
        spawnX: 530,
        spawnY: 531,
        facing: "left",
      });
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("seeds a durable fixture record from the removed same-id overlay actor", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "successor-fixture-registry-"));
    try {
      const slicePath = path.join(tempDir, "slice.json");
      await fs.writeFile(slicePath, `${JSON.stringify({
        stateHash: "seed-hash",
        actors: [{ id: "player", label: "Field Observer", cell: { x: 1, y: 1 } }],
        inventory: [{ container: "player:field-pack", itemId: 1001, variantId: 0, quantity: 4, available: 4, reserved: 0 }],
      })}\n`, "utf8");
      const fixture = {
        name: "durable-seed",
        slicePath,
        defaults: { spawnArea: "open-desert-overworld", facing: "right" },
        characters: {
          crafter: {
            id: "bootcraft",
            name: "BootCraft",
            initialProfessionId: "craftsman",
            position: { areaId: "open-desert-overworld", x: 512, y: 512, facing: "right" },
          },
        },
        sliceOverlay: {
          actors: [{
            id: "bootcraft",
            label: "BootCraft",
            cell: { x: 512, y: 512 },
            vitals: { health: 280, action: 160, spirit: 100 },
            professionIds: ["craftsman"],
            skillBoxIds: ["craftsman-novice"],
            activeTitleId: "craftsman-novice",
            credits: 1000,
          }],
          inventory: [{ container: "bootcraft:field-pack", itemId: 2001, variantId: 0, quantity: 2, available: 2, reserved: 0 }],
        },
      };
      const actorSpecs = { alpha: { character: "fixture:crafter" } };

      const materialized = await materializeFixtureSlice(fixture, path.join(tempDir, "out"), actorSpecs);
      const output = JSON.parse(await fs.readFile(materialized.slicePath, "utf8"));
      expect(output.actors.find((actor) => actor.id === "player")).toBeUndefined();
      expect(output.actors.find((actor) => actor.id === "bootcraft")).toBeUndefined();
      expect(output.inventory).toEqual([
        expect.objectContaining({ container: "bootcraft:field-pack", itemId: 2001, quantity: 2 }),
      ]);

      const store = await writeFixtureCharacterStore(fixture, path.join(tempDir, "store"), actorSpecs);
      expect(store.characters).toEqual([expect.objectContaining({
        id: "bootcraft",
        initialProfessionId: "craftsman",
        vitals: { health: 280, action: 160, spirit: 100 },
        professions: {
          learned: ["craftsman"],
          trackXp: {},
          skillBoxes: ["craftsman-novice"],
          activeTitleId: "craftsman-novice",
          careerGoalId: null,
          credits: 1000,
          skillPointCap: 250,
        },
      })]);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("rejects omitted or invalid initial professions before writing a disposable character", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "successor-fixture-registry-"));
    try {
      const baseFixture = {
        name: "starter-validation",
        defaults: { spawnArea: "open-desert-overworld", facing: "right" },
      };
      await expect(writeFixtureCharacterStore({
        ...baseFixture,
        characters: { omitted: { id: "omitted", name: "Omitted" } },
      }, path.join(tempDir, "omitted"))).rejects.toThrow(/requires an explicit initial profession/u);
      await expect(writeFixtureCharacterStore({
        ...baseFixture,
        characters: { invalid: { id: "invalid", name: "Invalid", initialProfessionId: "chef" } },
      }, path.join(tempDir, "invalid"))).rejects.toThrow(/invalid initial profession/u);
      await expect(fs.access(path.join(tempDir, "omitted", "characters.json"))).rejects.toThrow();
      await expect(fs.access(path.join(tempDir, "invalid", "characters.json"))).rejects.toThrow();
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("materializes a roll overlay into a run-local copy without changing the production source", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "successor-fixture-registry-"));
    try {
      const slicePath = path.join(tempDir, "production-roll-slice.json");
      const sourceText = `${JSON.stringify({
        stateHash: "production-roll-hash",
        combatModel: "roll",
        actors: [{ id: "player", cell: { x: 4, y: 8 } }],
      }, null, 2)}\n`;
      await fs.writeFile(slicePath, sourceText, "utf8");

      const outDir = path.join(tempDir, "run-42");
      const materialized = await materializeFixtureSlice({
        name: "roll-run",
        slicePath,
        characters: {},
        sliceOverlay: { combatModel: "roll" },
      }, outDir);

      expect(materialized.slicePath).toBe(path.join(outDir, "roll-run.slice.json"));
      expect(materialized.materializedFrom).toBe(slicePath);
      expect(await fs.readFile(slicePath, "utf8")).toBe(sourceText);
      await expect(fs.readFile(materialized.slicePath, "utf8")).resolves.toMatch(/"combatModel": "roll"/u);
      expect(JSON.parse(await fs.readFile(materialized.slicePath, "utf8"))).toMatchObject({
        stateHash: "production-roll-hash-roll-run-verification",
        combatModel: "roll",
        actors: [{ id: "player", cell: { x: 4, y: 8 } }],
      });
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("rejects invalid combat models before creating a run-local fixture", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "successor-fixture-registry-"));
    try {
      const slicePath = path.join(tempDir, "production-slice.json");
      const sourceText = `${JSON.stringify({ stateHash: "production-hash", combatModel: "roll", actors: [] })}\n`;
      await fs.writeFile(slicePath, sourceText, "utf8");
      const outDir = path.join(tempDir, "invalid-run");

      await expect(materializeFixtureSlice({
        name: "invalid-model",
        slicePath,
        characters: {},
        sliceOverlay: { combatModel: "laser" },
      }, outDir)).rejects.toThrow('fixture invalid-model sliceOverlay: combatModel must be one of roll; received "laser"');

      expect(await fs.readFile(slicePath, "utf8")).toBe(sourceText);
      await expect(fs.access(path.join(outDir, "invalid-model.slice.json"))).rejects.toThrow();
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});
