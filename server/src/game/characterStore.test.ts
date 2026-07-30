import os from "node:os";
import path from "node:path";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
// @ts-expect-error — the verification script is JavaScript without a declaration file.
import { writeLoadCharacterStore } from "../../../tools/verification/load/player-load.mjs";

import {
  CharacterStore,
  actorAppearanceToCharacterAppearance,
  characterAppearanceToActorAppearance,
  characterSlotCap,
  defaultCharacterAppearance,
  normalizeCharacterAppearance,
  successorMacroRecordBodyMaxBytes,
  successorMacrosRecordCaps,
  successorMacrosRecordKind,
  type SuccessorMacroRecord,
} from "./characterStore.js";
import { FACE_BROW_COLORS, FACE_EYE_COLORS, FACE_LIP_COLORS } from "./face.gen.js";
import type { GameActorSnapshot } from "./protocol.js";

const appearance = {
  skinTone: "#aabbcc",
  hair: "hair_mop" as const,
  hairMat: "hair_raven",
  face: null,
};

function currentStoredRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const worn = [
    { item: "under_bodysuit", colors: ["#89cff0"] },
    { item: "boots_canvas_ankle", colors: ["#303030", "#808080"] },
  ];
  return {
    id: "char_inventory_owner",
    ownerRef: "local",
    name: "Atlas",
    appearance,
    worn,
    wornColors: Object.fromEntries(worn.map((entry) => [entry.item, entry.colors])),
    position: null,
    vitals: null,
    initialProfessionId: null,
    professions: null,
    activeTitleId: null,
    careerGoalId: null,
    recordKinds: {},
    worldEntryClaimed: false,
    createdAt: "2026-07-06T00:00:00.000Z",
    lastSeenAt: "2026-07-06T00:00:00.000Z",
    lastLogoutAt: null,
    totalPlayMs: 0,
    ...overrides,
  };
}

function withStore(test: (store: CharacterStore) => void): void {
  withStoreFile((store) => test(store));
}

function withStoreFile(test: (store: CharacterStore, filePath: string) => void): void {
  const dir = mkdtempSync(path.join(os.tmpdir(), "successor-character-store-"));
  try {
    const filePath = path.join(dir, "characters.json");
    test(new CharacterStore(filePath, () => Date.parse("2026-07-06T00:00:00.000Z")), filePath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function injectStoreRenameFailure(filePath: string, action: () => void): unknown {
  const backupPath = `${filePath}.before-injected-rename-failure`;
  renameSync(filePath, backupPath);
  mkdirSync(filePath);
  let didThrow = false;
  let thrown: unknown;
  try {
    action();
  } catch (error) {
    didThrow = true;
    thrown = error;
  } finally {
    rmSync(filePath, { recursive: true, force: true });
    renameSync(backupPath, filePath);
  }
  if (!didThrow) throw new Error("expected injected character-store rename failure");
  return thrown;
}

function actorSnapshot(overrides: Partial<GameActorSnapshot> = {}): GameActorSnapshot {
  return {
    id: "char_test",
    label: "Atlas",
    display_name: "Atlas",
    link_dead: false,
    appearance: { skin: "#aabbcc", hair: "hair_mop", hair_mat: "hair_raven" },
    role: "player",
    sprite: "adventurer-premium-male",
    areaId: "open-desert",
    x: 14,
    y: 22,
    direction: "right",
    posture: "standing",
    postureUntilTick: 0,
    lifeState: "alive",
    lifecycleSeq: 1,
    vitals: { health: 87, action: 66, spirit: 55 },
    maxVitals: { health: 100, action: 100, spirit: 100 },
    bleed: { active: false, stackCount: 0, severity: 0, remainingMs: 0, ratesPerSecond: { health: 0, action: 0, spirit: 0 } },
    statuses: [],
    ...overrides,
  };
}

function macroRecordPayloadText(filePath: string, characterId: string): string {
  const data = JSON.parse(readFileSync(filePath, "utf8")) as {
    characters: Array<{ id: string; recordKinds?: Record<string, unknown> }>;
  };
  const character = data.characters.find((candidate) => candidate.id === characterId);
  if (!character) throw new Error(`missing character ${characterId}`);
  return JSON.stringify(character.recordKinds?.[successorMacrosRecordKind]);
}

describe("CharacterStore", () => {
  it("rejects non-canonical character-store schemas", () => withStoreFile((store, filePath) => {
    writeFileSync(filePath, JSON.stringify({ schema: "foreign.character-store.v1", characters: [] }), "utf8");
    expect(() => store.list()).toThrow(/unsupported character-store schema/u);
  }));

  it("fails closed on a malformed character record and retains the store byte-for-byte", () => withStoreFile((store, filePath) => {
    const raw = `${JSON.stringify({
      schema: "successor.character-store.v2",
      characters: [currentStoredRecord({ name: "" })],
    }, null, 2)}\n`;
    writeFileSync(filePath, raw, "utf8");

    expect(() => store.list()).toThrow(/invalid character-store record at characters\[0\]/u);
    expect(() => store.create({ name: "Replacement", appearance })).toThrow(/characters\[0\]/u);
    expect(readFileSync(filePath, "utf8")).toBe(raw);
  }));

  it("rejects a missing characters array and duplicate durable ids", () => withStoreFile((store, filePath) => {
    writeFileSync(filePath, JSON.stringify({ schema: "successor.character-store.v2" }), "utf8");
    expect(() => store.list()).toThrow(/characters; expected an array/u);

    const duplicate = currentStoredRecord({ id: "char_duplicate" });
    writeFileSync(filePath, JSON.stringify({
      schema: "successor.character-store.v2",
      characters: [duplicate, { ...duplicate, name: "Beryl" }],
    }), "utf8");
    const reopened = new CharacterStore(filePath);
    expect(() => reopened.list()).toThrow(/duplicate character-store id.*characters\[1\]/u);
  }));

  it("rejects non-canonical persisted character ids instead of trimming them", () => withStoreFile((_store, filePath) => {
    for (const id of [" char_inventory_owner ", "Char_Inventory_Owner", "char:inventory", `char_${"x".repeat(60)}`]) {
      const raw = `${JSON.stringify({
        schema: "successor.character-store.v2",
        characters: [currentStoredRecord({ id })],
      }, null, 2)}\n`;
      writeFileSync(filePath, raw, "utf8");

      expect(() => new CharacterStore(filePath).list()).toThrow(/invalid character-store record at characters\[0\]/u);
      expect(readFileSync(filePath, "utf8")).toBe(raw);
    }
  }));

  it("requires current owner and world-entry fields without legacy defaults", () => withStoreFile((_store, filePath) => {
    for (const ownerRef of [" local ", "bad owner", "", null]) {
      writeFileSync(filePath, JSON.stringify({
        schema: "successor.character-store.v2",
        characters: [currentStoredRecord({ ownerRef })],
      }), "utf8");
      expect(() => new CharacterStore(filePath).list()).toThrow(/invalid character-store record at characters\[0\]/u);
    }

    writeFileSync(filePath, JSON.stringify({
      schema: "successor.character-store.v2",
      characters: [currentStoredRecord({ worldEntryClaimed: "false" })],
    }), "utf8");
    expect(() => new CharacterStore(filePath).list()).toThrow(/invalid character-store record at characters\[0\]/u);

    for (const missing of ["ownerRef", "worldEntryClaimed"]) {
      const record = currentStoredRecord();
      delete record[missing];
      writeFileSync(filePath, JSON.stringify({ schema: "successor.character-store.v2", characters: [record] }), "utf8");
      expect(() => new CharacterStore(filePath).list()).toThrow(/invalid character-store record at characters\[0\]/u);
    }
  }));

  it("fails closed on an explicit invalid persisted initial profession", () => withStoreFile((_store, filePath) => {
    writeFileSync(filePath, JSON.stringify({
      schema: "successor.character-store.v2",
      characters: [currentStoredRecord({ initialProfessionId: "chef" })],
    }), "utf8");
    expect(() => new CharacterStore(filePath).list()).toThrow(/invalid character-store record at characters\[0\]/u);
  }));

  it("resolves generated PC and Mac load IDs with the default local owner", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "successor-player-load-character-store-"));
    try {
      const storePath = path.join(dir, "characters.json");
      const runId = "owner-binding";
      const pcId = `player-load-${runId}-pc-001`;
      const macId = `player-load-${runId}-mac-001`;

      await writeLoadCharacterStore(storePath, runId, 1, ["pc", "mac"]);

      const store = new CharacterStore(storePath, () => Date.parse("2026-07-06T00:00:00.000Z"));
      expect(store.get(pcId)).toMatchObject({ id: pcId, ownerRef: "local" });
      expect(store.get(macId)).toMatchObject({ id: macId, ownerRef: "local" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("finds durable ids across owner namespaces", () => withStoreFile((store, filePath) => {
    writeFileSync(filePath, JSON.stringify({
      schema: "successor.character-store.v2",
      characters: [
        currentStoredRecord({ id: "char_local", ownerRef: "local", name: "Atlas" }),
        currentStoredRecord({ id: "char_remote", ownerRef: "friend-account", name: "Beryl" }),
      ],
    }), "utf8");

    expect(store.hasId("char_local")).toBe(true);
    expect(store.hasId("char_remote")).toBe(true);
    expect(store.hasId("char_missing")).toBe(false);
  }));

  it("creates characters and rejects case-insensitive name collisions", () => withStore((store) => {
    const created = store.create({ name: "Atlas", appearance });
    expect(created).toMatchObject({ ok: true });
    expect(store.create({ name: "atlas", appearance })).toEqual({ ok: false, error: "name_taken" });
    if (!created.ok) throw new Error("expected character create to succeed");
    expect(created.record.recordKinds[successorMacrosRecordKind]).toEqual({ version: 1, items: [] });
    expect(store.create({ name: "At", appearance })).toEqual({ ok: false, error: "invalid_name" });
  }));

  it("seeds exactly the selected novice box and treats it as an ordinary 16-point allocation", () => withStore((store) => {
    const created = store.create({ name: "Atlas", appearance, initialProfessionId: "brawler" });
    expect(created).toMatchObject({
      ok: true,
      record: {
        initialProfessionId: "brawler",
        professions: {
          learned: [],
          skillBoxes: ["brawler-novice"],
          skillPointCap: 250,
          credits: 5000,
        },
      },
    });
    expect(store.create({ name: "Beryl", appearance, initialProfessionId: "chef" })).toEqual({
      ok: false,
      error: "invalid_initial_profession",
    });
  }));

  it("locks and durably retries interrupted initial-profession selection", () => withStoreFile((store, filePath) => {
    const created = store.create({ name: "Atlas", appearance });
    if (!created.ok) throw new Error("expected character create to succeed");

    const beforeSelection = readFileSync(filePath, "utf8");
    expect(injectStoreRenameFailure(filePath, () => {
      store.selectInitialProfession(created.record.id, "scout");
    })).toBeInstanceOf(Error);
    expect(readFileSync(filePath, "utf8")).toBe(beforeSelection);
    expect(store.get(created.record.id)).toMatchObject({ initialProfessionId: null, professions: null });

    expect(store.selectInitialProfession(created.record.id, "scout")).toMatchObject({
      ok: true,
      record: {
        initialProfessionId: "scout",
        professions: { skillBoxes: ["scout-novice"] },
      },
    });
    // A network retry with the committed value is harmless; a different value
    // cannot swap the one-time kit after the original request committed.
    expect(store.selectInitialProfession(created.record.id, "scout")).toMatchObject({ ok: true });
    expect(store.selectInitialProfession(created.record.id, "medic")).toEqual({
      ok: false,
      error: "initial_profession_locked",
    });

    const reopened = new CharacterStore(filePath);
    expect(reopened.get(created.record.id)).toMatchObject({
      initialProfessionId: "scout",
      professions: { skillBoxes: ["scout-novice"] },
    });
    expect(reopened.claimWorldEntry(created.record.id)).toMatchObject({ returning: false });
    expect(reopened.selectInitialProfession(created.record.id, "scout")).toEqual({
      ok: false,
      error: "character_already_entered",
    });
  }));

  it("durably claims first world entry before a later store instance can retry", () => withStoreFile((store, filePath) => {
    const created = store.create({ name: "Atlas", appearance });
    if (!created.ok) throw new Error("expected character create to succeed");
    expect(created.record.worldEntryClaimed).toBe(false);
    expect(store.hasEnteredWorld()).toBe(false);

    expect(store.claimWorldEntry(created.record.id)).toMatchObject({
      returning: false,
      record: { worldEntryClaimed: true },
    });
    const persisted = JSON.parse(readFileSync(filePath, "utf8")) as {
      characters: Array<{ worldEntryClaimed?: boolean }>;
    };
    expect(persisted.characters[0]?.worldEntryClaimed).toBe(true);
    expect(store.hasEnteredWorld()).toBe(true);

    const reopened = new CharacterStore(filePath);
    expect(reopened.claimWorldEntry(created.record.id)).toMatchObject({
      returning: true,
      record: { worldEntryClaimed: true },
    });
    expect(reopened.delete(created.record.id)).toBeNull();
    expect(reopened.get(created.record.id)?.worldEntryClaimed).toBe(true);
    expect(reopened.hasEnteredWorld()).toBe(true);
  }));

  it("reloads durable state after failed create and world-entry claim saves", () => withStoreFile((store, filePath) => {
    const created = store.create({ id: "char_atlas", name: "Atlas", appearance });
    if (!created.ok) throw new Error("expected character create to succeed");

    const beforeCreate = readFileSync(filePath, "utf8");
    expect(injectStoreRenameFailure(filePath, () => {
      store.create({ id: "char_beryl", name: "Beryl", appearance });
    })).toBeInstanceOf(Error);
    expect(readFileSync(filePath, "utf8")).toBe(beforeCreate);
    expect(store.get("char_beryl")).toBeNull();
    expect(store.list()).toHaveLength(1);

    const beforeClaim = readFileSync(filePath, "utf8");
    expect(store.get(created.record.id)?.worldEntryClaimed).toBe(false);
    expect(injectStoreRenameFailure(filePath, () => {
      store.claimWorldEntry(created.record.id);
    })).toBeInstanceOf(Error);
    expect(readFileSync(filePath, "utf8")).toBe(beforeClaim);
    expect(store.get(created.record.id)?.worldEntryClaimed).toBe(false);

    const reopened = new CharacterStore(filePath);
    expect(reopened.get(created.record.id)?.worldEntryClaimed).toBe(false);
    expect(reopened.get("char_beryl")).toBeNull();
  }));

  it("enforces the five-character slot limit", () => withStore((store) => {
    for (const name of ["Astra", "Beryl", "Cairo", "Dover", "Elias"]) {
      expect(store.create({ name, appearance }).ok).toBe(true);
    }
    expect(store.create({ name: "Fable", appearance })).toEqual({ ok: false, error: "slots_full" });
  }));

  it("clamps purchased entitlement slot caps and keeps the dev fallback when absent", () => {
    expect(characterSlotCap({ characterSlots: 0 })).toBe(0);
    expect(characterSlotCap({ characterSlots: 3 })).toBe(3);
    expect(characterSlotCap({ characterSlots: 10 })).toBe(10);
    expect(characterSlotCap({ characterSlots: 99 })).toBe(10);
    expect(characterSlotCap()).toBe(5);
    expect(characterSlotCap(null)).toBe(5);
  });

  it("bypasses the dev slot cap for ticket-seeded sim-state records", () => withStore((store) => {
    for (const name of ["Astra", "Beryl", "Cairo", "Dover", "Elias"]) {
      expect(store.create({ name, appearance }).ok).toBe(true);
    }
    const seeded = store.create({
      id: "ticket-char-01",
      ownerRef: "profile-123",
      name: "Fable",
      appearance,
      bypassSlotCap: true,
    });

    expect(seeded).toMatchObject({ ok: true, record: { id: "ticket-char-01", ownerRef: "profile-123", name: "Fable" } });
  }));

  it("persists logout position, vitals, profession title, career goal, professions, and play time", () => withStore((store) => {
    const created = store.create({ name: "Atlas", appearance });
    if (!created.ok) throw new Error("expected character create to succeed");
    const record = store.saveActorSnapshot(created.record.id, actorSnapshot({
      professions: [{ id: "marksman", label: "Marksman", xp: 12, skillPoints: 2, skillBoxes: ["marksman-novice"] }],
      activeTitle: { id: "marksman-novice", label: "Novice Marksman", skillBoxId: "marksman-novice" },
      careerGoalId: "rifle_quartermaster",
    }), { logout: true, playMs: 1234, atMs: Date.parse("2026-07-06T00:01:00.000Z") });
    expect(record).toMatchObject({
      position: { areaId: "open-desert", x: 14, y: 22, facing: "right" },
      vitals: { health: 87, action: 66, spirit: 55 },
      totalPlayMs: 1234,
      lastLogoutAt: "2026-07-06T00:01:00.000Z",
      activeTitleId: "marksman-novice",
      careerGoalId: "rifle_quartermaster",
    });
    expect(record?.professions).toEqual([{ id: "marksman", label: "Marksman", xp: 12, skillPoints: 2, skillBoxes: ["marksman-novice"] }]);
  }));

  it("stores generic record-kind items with macro validation and delete semantics", () => withStore((store) => {
    const created = store.create({ name: "Atlas", appearance });
    if (!created.ok) throw new Error("expected character create to succeed");
    const saved = store.saveRecordKindItem<SuccessorMacroRecord>(
      created.record.id,
      successorMacrosRecordKind,
      { id: "heal_self", name: "Heal Self", iconId: "macro:medic", body: "/target self\n/heal" },
      { atMs: Date.parse("2026-07-06T00:03:00.000Z") },
    );
    expect(saved).toMatchObject({
      ok: true,
      item: {
        id: "heal_self",
        name: "Heal Self",
        iconId: "macro:medic",
        body: "/target self\n/heal",
        createdAt: "2026-07-06T00:03:00.000Z",
        updatedAt: "2026-07-06T00:03:00.000Z",
      },
    });

    const updated = store.saveRecordKindItem<SuccessorMacroRecord>(
      created.record.id,
      successorMacrosRecordKind,
      { id: "heal_self", name: "Heal Self", iconId: "macro:medic", body: "/target self\n/heal;\n/pause 0.5" },
      { atMs: Date.parse("2026-07-06T00:04:00.000Z") },
    );
    expect(updated).toMatchObject({
      ok: true,
      item: {
        id: "heal_self",
        createdAt: "2026-07-06T00:03:00.000Z",
        updatedAt: "2026-07-06T00:04:00.000Z",
      },
    });
    expect(store.listRecordKindItems<SuccessorMacroRecord>(created.record.id, successorMacrosRecordKind)).toEqual([
      expect.objectContaining({ id: "heal_self", body: "/target self\n/heal;\n/pause 0.5" }),
    ]);

    expect(store.deleteRecordKindItem<SuccessorMacroRecord>(created.record.id, successorMacrosRecordKind, "heal_self")).toMatchObject({
      ok: true,
      deleted: true,
      payload: { version: 1, items: [] },
    });
  }));

  it("enforces record-kind caps before writing macro records", () => withStore((store) => {
    const created = store.create({ name: "Atlas", appearance });
    if (!created.ok) throw new Error("expected character create to succeed");
    expect(store.saveRecordKindItem(
      created.record.id,
      successorMacrosRecordKind,
      { id: "oversized", name: "Oversized", iconId: "macro:test", body: "x".repeat(successorMacroRecordBodyMaxBytes + 1) },
    )).toEqual({ ok: false, error: "invalid_record" });

    for (let index = 0; index < successorMacrosRecordCaps.maxItems; index += 1) {
      expect(store.saveRecordKindItem(
        created.record.id,
        successorMacrosRecordKind,
        { id: `macro_${index}`, name: `Macro ${index}`, iconId: "macro:test", body: "/pause 1" },
      ).ok).toBe(true);
    }
    expect(store.saveRecordKindItem(
      created.record.id,
      successorMacrosRecordKind,
      { id: "one_too_many", name: "One Too Many", iconId: "macro:test", body: "/pause 1" },
    )).toEqual({ ok: false, error: "record_limit_exceeded" });
  }));

  it("rejects a pre-v2 record instead of defaulting missing current fields", () => withStoreFile((store, filePath) => {
    writeFileSync(filePath, `${JSON.stringify({
      schema: "successor.character-store.v2",
      characters: [{
        id: "char_live",
        ownerRef: "local",
        name: "Atlas",
        appearance,
        position: null,
        vitals: null,
        professions: null,
        createdAt: "2026-07-06T00:00:00.000Z",
        lastSeenAt: "2026-07-06T00:00:00.000Z",
        lastLogoutAt: null,
        totalPlayMs: 0,
      }],
    }, null, 2)}\n`, "utf8");
    expect(() => store.get("char_live")).toThrow(/invalid character-store record/u);
  }));

  it("keeps macro record payloads byte-meaning-identical across load/save round trips", () => withStoreFile((store, filePath) => {
    const created = store.create({ name: "Atlas", appearance });
    if (!created.ok) throw new Error("expected character create to succeed");
    const body = "/sample copper\n/pause 0.5\n/macro run récolte";
    expect(store.saveRecordKindItem(
      created.record.id,
      successorMacrosRecordKind,
      { id: "copper_run", name: "Copper Run", iconId: "macro:copper", body },
    ).ok).toBe(true);
    const before = macroRecordPayloadText(filePath, created.record.id);

    const reloaded = new CharacterStore(filePath, () => Date.parse("2026-07-06T00:05:00.000Z"));
    reloaded.saveActorSnapshot(created.record.id, actorSnapshot({ id: created.record.id }), {
      atMs: Date.parse("2026-07-06T00:05:00.000Z"),
    });

    expect(macroRecordPayloadText(filePath, created.record.id)).toBe(before);
  }));
  it("isolates macro records by owner and refuses foreign owner scope", () => withStore((store) => {
    const owned = store.create({ ownerRef: "owner-a", name: "Atlas", appearance, bypassSlotCap: true });
    const other = store.create({ ownerRef: "owner-b", name: "Beryl", appearance, bypassSlotCap: true });
    if (!owned.ok || !other.ok) throw new Error("expected characters");
    const saved = store.saveRecordKindItem(
      owned.record.id,
      successorMacrosRecordKind,
      { id: "scan", name: "Scan", iconId: "macro:scan", body: "/pause 1" },
      { ownerRef: "owner-a" },
    );
    expect(saved.ok).toBe(true);
    expect(store.listRecordKindItems(owned.record.id, successorMacrosRecordKind, "owner-b")).toBeNull();
    expect(store.recordKindPayloadEtag(owned.record.id, successorMacrosRecordKind, "owner-b")).toBeNull();
    expect(store.saveRecordKindItem(
      owned.record.id,
      successorMacrosRecordKind,
      { id: "scan2", name: "Scan2", iconId: "macro:scan", body: "/pause 1" },
      { ownerRef: "owner-b" },
    )).toEqual({ ok: false, error: "character_not_found" });
    expect(store.deleteRecordKindItem(
      owned.record.id,
      successorMacrosRecordKind,
      "scan",
      { ownerRef: "owner-b" },
    )).toEqual({ ok: false, error: "character_not_found" });
  }));

  it("enforces canonical ETag create/update/delete and leaves stale writes unchanged", () => withStore((store) => {
    const created = store.create({ name: "Atlas", appearance });
    if (!created.ok) throw new Error("expected character");
    const emptyEtag = store.recordKindPayloadEtag(created.record.id, successorMacrosRecordKind);
    expect(emptyEtag).toMatch(/^[a-f0-9]{64}$/u);

    const createdMacro = store.saveRecordKindItem(
      created.record.id,
      successorMacrosRecordKind,
      { id: "heal", name: "Heal", iconId: "macro:medic", body: "/heal" },
      { expectedEtag: emptyEtag!, requireEtag: true, atMs: Date.parse("2026-07-06T00:10:00.000Z") },
    );
    expect(createdMacro.ok).toBe(true);
    if (!createdMacro.ok) throw new Error("create failed");
    expect(createdMacro.etag).not.toBe(emptyEtag);
    const afterCreate = store.listRecordKindItems(created.record.id, successorMacrosRecordKind);
    expect(afterCreate).toHaveLength(1);

    const stale = store.saveRecordKindItem(
      created.record.id,
      successorMacrosRecordKind,
      { id: "heal", name: "Heal", iconId: "macro:medic", body: "/heal\n/pause 1" },
      { expectedEtag: emptyEtag!, requireEtag: true },
    );
    expect(stale).toMatchObject({ ok: false, error: "etag_mismatch", etag: createdMacro.etag });
    if (!stale.ok && stale.error === "etag_mismatch") {
      expect(stale.payload.items[0]).toMatchObject({ body: "/heal" });
    }
    expect(store.listRecordKindItems(created.record.id, successorMacrosRecordKind)).toEqual(afterCreate);

    const updated = store.saveRecordKindItem(
      created.record.id,
      successorMacrosRecordKind,
      { id: "heal", name: "Heal", iconId: "macro:medic", body: "/heal\n/pause 1" },
      { expectedEtag: createdMacro.etag, requireEtag: true, atMs: Date.parse("2026-07-06T00:11:00.000Z") },
    );
    expect(updated.ok).toBe(true);
    if (!updated.ok) throw new Error("update failed");
    expect(updated.etag).not.toBe(createdMacro.etag);

    const deleted = store.deleteRecordKindItem(
      created.record.id,
      successorMacrosRecordKind,
      "heal",
      { expectedEtag: updated.etag, requireEtag: true },
    );
    expect(deleted).toMatchObject({ ok: true, deleted: true });
    if (!deleted.ok) throw new Error("delete failed");
    expect(deleted.payload.items).toEqual([]);
    expect(deleted.etag).toBe(emptyEtag);

    expect(store.saveRecordKindItem(
      created.record.id,
      successorMacrosRecordKind,
      { id: "heal", name: "Heal", iconId: "macro:medic", body: "/heal" },
      { requireEtag: true },
    )).toEqual({ ok: false, error: "etag_required" });
  }));

  it("rejects oversize UTF-8 macro bodies by byte length, not code-unit length", () => withStore((store) => {
    const created = store.create({ name: "Atlas", appearance });
    if (!created.ok) throw new Error("expected character");
    // Each 'é' is 2 UTF-8 bytes; 4097 of them exceeds 8 KiB.
    const body = "é".repeat(4097);
    expect(Buffer.byteLength(body, "utf8")).toBeGreaterThan(successorMacroRecordBodyMaxBytes);
    expect(store.saveRecordKindItem(
      created.record.id,
      successorMacrosRecordKind,
      { id: "utf8", name: "Utf8", iconId: "macro:test", body },
    )).toEqual({ ok: false, error: "invalid_record" });
  }));

  it("keeps social contacts character-scoped across owners and store restart", () => withStoreFile((store, filePath) => {
    const atlas = store.create({ id: "char_atlas", ownerRef: "owner-a", name: "Atlas", appearance, bypassSlotCap: true });
    const beryl = store.create({ id: "char_beryl", ownerRef: "owner-a", name: "Beryl", appearance, bypassSlotCap: true });
    const cairo = store.create({ id: "char_cairo", ownerRef: "owner-b", name: "Cairo", appearance, bypassSlotCap: true });
    if (!atlas.ok || !beryl.ok || !cairo.ok) throw new Error("expected characters to create");
    expect(store.saveSocialContact(atlas.record.id, beryl.record.id, "friend").ok).toBe(true);
    expect(store.saveSocialContact(beryl.record.id, cairo.record.id, "ignored").ok).toBe(true);
    const reopened = new CharacterStore(filePath);
    expect(reopened.listSocialContacts(atlas.record.id)).toEqual([{ id: beryl.record.id, relation: "friend" }]);
    expect(reopened.listSocialContacts(beryl.record.id)).toEqual([{ id: cairo.record.id, relation: "ignored" }]);
    expect(reopened.listSocialContacts(cairo.record.id)).toEqual([]);
  }));

  it("resolves names globally and enforces constrained global uniqueness", () => withStore((store) => {
    const first = store.create({ ownerRef: "owner-a", name: "At-las", appearance, bypassSlotCap: true });
    expect(first.ok).toBe(true);
    expect(store.resolveCharacter("AT-LAS")?.id).toBe(first.ok ? first.record.id : "");
    expect(store.create({ ownerRef: "owner-b", name: "at-las", appearance, bypassSlotCap: true })).toEqual({ ok: false, error: "name_taken" });
    for (const name of ["Ab", "Atlas-", "-Atlas", "At--Las", "At1as", "A".repeat(17)]) {
      expect(store.create({ name, appearance, bypassSlotCap: true })).toMatchObject({ ok: false, error: "invalid_name" });
    }
  }));
  it("removes inbound social edges before durable id reuse", () => withStore((store) => {
    const original = store.create({ id: "char_reused", ownerRef: "owner-a", name: "Atlas", appearance, bypassSlotCap: true });
    const watcher = store.create({ id: "char_watcher", ownerRef: "owner-b", name: "Beryl", appearance, bypassSlotCap: true });
    if (!original.ok || !watcher.ok) throw new Error("expected characters to create");
    expect(store.saveSocialContact(watcher.record.id, original.record.id, "friend").ok).toBe(true);
    expect(store.delete(original.record.id, "owner-a")?.id).toBe(original.record.id);
    const replacement = store.create({ id: original.record.id, ownerRef: "owner-c", name: "Cairo", appearance, bypassSlotCap: true });
    expect(replacement.ok).toBe(true);
    expect(store.listSocialContacts(watcher.record.id)).toEqual([]);
    expect(store.listSocialContacts(replacement.ok ? replacement.record.id : "")).toEqual([]);
  }));
  it("accepts dotted durable ids for social friend and ignore records", () => withStore((store) => {
    const atlas = store.create({ id: "char.atlas", ownerRef: "owner-a", name: "Atlas", appearance, bypassSlotCap: true });
    const beryl = store.create({ id: "char.beryl", ownerRef: "owner-a", name: "Beryl", appearance, bypassSlotCap: true });
    if (!atlas.ok || !beryl.ok) throw new Error("expected dotted-id characters");
    expect(store.saveSocialContact(atlas.record.id, beryl.record.id, "friend").ok).toBe(true);
    expect(store.saveSocialContact(beryl.record.id, atlas.record.id, "ignored").ok).toBe(true);
    expect(store.deleteSocialContact(atlas.record.id, beryl.record.id)).toMatchObject({ ok: true, deleted: true });
    expect(store.deleteSocialContact(beryl.record.id, atlas.record.id)).toMatchObject({ ok: true, deleted: true });
  }));
});
describe("character appearance (hair is an appearance property, not an item)", () => {
  it("accepts any well-formed hair style id — validation is a pattern, not a fixed enum", () => {
    const normalized = normalizeCharacterAppearance({ skinTone: "#aabbcc", hair: "hair_ponytail_long", hairMat: "hair_silver", face: null });
    expect(normalized).toEqual({ skinTone: "#aabbcc", hair: "hair_ponytail_long", hairMat: "hair_silver", face: null });
  });

  it("uses explicit null for bald and rejects an empty current hair field", () => {
    const bald = normalizeCharacterAppearance({ skinTone: "#aabbcc", hair: null, hairMat: "hair_raven", face: null });
    expect(bald).toEqual({ skinTone: "#aabbcc", hair: null, hairMat: "hair_raven", face: null });
    expect(normalizeCharacterAppearance({ skinTone: "#aabbcc", hair: "", hairMat: "hair_raven", face: null })).toBeNull();
    expect(characterAppearanceToActorAppearance(bald!)).toEqual({ skin: "#aabbcc", hair: null, hair_mat: "hair_raven", face: null });
  });

  it("rejects a malformed hair style id", () => {
    expect(normalizeCharacterAppearance({ skinTone: "#aabbcc", hair: "not-a-hair", hairMat: "hair_raven", face: null })).toBeNull();
    expect(normalizeCharacterAppearance({ skinTone: "#aabbcc", hair: 42, hairMat: "hair_raven", face: null })).toBeNull();
  });

  it("round-trips a created character's hair through the store and back to actor appearance", () => withStore((store) => {
    const created = store.create({ name: "Coily", appearance: { skinTone: "#4a3223", hair: "hair_crop2", hairMat: "hair_chestnut", face: null } });
    if (!created.ok) throw new Error("expected create to succeed");
    expect(created.record.appearance).toEqual({ skinTone: "#4a3223", hair: "hair_crop2", hairMat: "hair_chestnut", face: null });
    expect(characterAppearanceToActorAppearance(created.record.appearance)).toEqual({ skin: "#4a3223", hair: "hair_crop2", hair_mat: "hair_chestnut", face: null });
    expect(defaultCharacterAppearance().hair).toBe("hair_mop");
  }));
});

describe("character face (face-kit selection validated against the generated registry)", () => {
  const validFace = {
    eyes: "veteran",
    brows: "sharp",
    nose: "stoic",
    mouth: "feral",
    eyeColor: FACE_EYE_COLORS[2]!,
    browColor: FACE_BROW_COLORS[1]!,
    lipColor: FACE_LIP_COLORS[3]!,
  };

  it("accepts a registry-valid face and round-trips it through create and the actor wire shape", () => withStore((store) => {
    const created = store.create({
      name: "Faceful",
      appearance: { skinTone: "#4a3223", hair: "hair_crop2", hairMat: "hair_chestnut", face: validFace },
    });
    if (!created.ok) throw new Error("expected create to succeed");
    expect(created.record.appearance.face).toEqual(validFace);
    const wire = characterAppearanceToActorAppearance(created.record.appearance);
    expect(wire.face).toEqual({
      eyes: "veteran",
      brows: "sharp",
      nose: "stoic",
      mouth: "feral",
      eye_color: validFace.eyeColor,
      brow_color: validFace.browColor,
      lip_color: validFace.lipColor,
    });
    expect(actorAppearanceToCharacterAppearance(wire).face).toEqual(validFace);
  }));

  it("requires an explicit face field and accepts null as the current blank state", () => {
    expect(normalizeCharacterAppearance({ skinTone: "#aabbcc", hair: null, hairMat: "hair_raven" })).toBeNull();
    expect(normalizeCharacterAppearance({ skinTone: "#aabbcc", hair: null, hairMat: "hair_raven", face: null })?.face).toBeNull();
  });

  it("rejects the whole appearance when a present face has an unknown style or off-registry color", () => {
    expect(normalizeCharacterAppearance({
      skinTone: "#aabbcc", hair: null, hairMat: "hair_raven",
      face: { ...validFace, eyes: "smolder" },
    })).toBeNull();
    expect(normalizeCharacterAppearance({
      skinTone: "#aabbcc", hair: null, hairMat: "hair_raven",
      face: { ...validFace, lipColor: "#123456" },
    })).toBeNull();
    expect(normalizeCharacterAppearance({
      skinTone: "#aabbcc", hair: null, hairMat: "hair_raven",
      face: { eyes: "stoic" },
    })).toBeNull();
  });
});
