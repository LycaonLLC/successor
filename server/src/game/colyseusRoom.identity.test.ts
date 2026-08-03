import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CharacterStore, defaultStarterWorn } from "./characterStore.js";
import { devIdentityAllowed, identityFromOptions } from "./colyseusRoom.js";
// @ts-expect-error — the verification script is JavaScript without a declaration file.
import { writeLoadCharacterStore } from "../../../tools/verification/load/player-load.mjs";

const validAppearance = { body: "female" as const, skinTone: "#c78f62", hair: "hair_mop", hairMat: "hair_raven", face: null };

function currentIdentityRecord(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    id: "fixture-character",
    ownerRef: "local",
    name: "Fixture",
    appearance: validAppearance,
    worn: [],
    wornColors: {},
    position: null,
    vitals: null,
    initialProfessionId: "marksman",
    professions: null,
    activeTitleId: null,
    careerGoalId: null,
    recordKinds: {},
    worldEntryClaimed: true,
    createdAt: "2026-07-08T00:00:00.000Z",
    lastSeenAt: "2026-07-08T00:00:00.000Z",
    lastLogoutAt: null,
    totalPlayMs: 0,
    ...overrides,
  };
}

function tempStore(): { store: CharacterStore; dir: string } {
  const dir = mkdtempSync(path.join(os.tmpdir(), "successor-identity-"));
  return { store: new CharacterStore(path.join(dir, "characters.json")), dir };
}

function ticketPlayer(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "profile-legacy",
    profileId: "profile-123",
    characterId: "char-ticket",
    displayName: "Atlas-Prime",
    zoneId: "open-desert-overworld",
    initialProfessionId: "marksman",
    ...overrides,
  };
}

function stubTicketFetch(payload: unknown): void {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" },
  })));
}

describe("colyseusRoom identity resolution (W2 ticket gate)", () => {
  const savedFlag = process.env.GAME_ALLOW_DEV_IDENTITY;
  const savedSiteUrl = process.env.SUCCESSOR_SITE_URL;
  const savedNodeEnv = process.env.NODE_ENV;
  const validTicket = "B".repeat(32);
  let store: CharacterStore;
  let dir: string;

  beforeEach(() => {
    delete process.env.GAME_ALLOW_DEV_IDENTITY;
    delete process.env.SUCCESSOR_SITE_URL;
    process.env.NODE_ENV = "test";
    ({ store, dir } = tempStore());
  });
  afterEach(() => {
    if (savedFlag === undefined) delete process.env.GAME_ALLOW_DEV_IDENTITY;
    else process.env.GAME_ALLOW_DEV_IDENTITY = savedFlag;
    if (savedSiteUrl === undefined) delete process.env.SUCCESSOR_SITE_URL;
    else process.env.SUCCESSOR_SITE_URL = savedSiteUrl;
    if (savedNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = savedNodeEnv;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  it("defaults dev identity ON only for local/harness and fail-closes production/network deploys", () => {
    expect(devIdentityAllowed()).toBe(true);
    process.env.SUCCESSOR_SITE_URL = "https://successor.example";
    expect(devIdentityAllowed()).toBe(false);
    delete process.env.SUCCESSOR_SITE_URL;
    process.env.NODE_ENV = "production";
    expect(devIdentityAllowed()).toBe(false);
  });

  it("treats explicit off values as disabled and explicit on values as enabled", () => {
    for (const off of ["0", "false", "off", "no", "OFF", "False"]) {
      process.env.GAME_ALLOW_DEV_IDENTITY = off;
      expect(devIdentityAllowed()).toBe(false);
    }
    for (const on of ["1", "true", "on", "yes"]) {
      process.env.GAME_ALLOW_DEV_IDENTITY = on;
      expect(devIdentityAllowed()).toBe(true);
    }
    process.env.GAME_ALLOW_DEV_IDENTITY = "";
    process.env.NODE_ENV = "test";
    delete process.env.SUCCESSOR_SITE_URL;
    expect(devIdentityAllowed()).toBe(true);
  });

  it("resolves the characterId path to the character's ownerRef (dev default ON)", async () => {
    const created = store.create({ name: "Atlas", appearance: validAppearance, initialProfessionId: "marksman" });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const identity = await identityFromOptions({ characterId: created.record.id }, store);
    expect(identity.characterId).toBe(created.record.id);
    expect(identity.actorId).toBe(created.record.id);
    expect(identity.ownerRef).toBe("local");
    expect(identity.playerId).toBe("local");
    expect(identity.displayName).toBe("Atlas");
    expect(identity.returningCharacter).toBe(false);
    expect(identity.skillBoxIds).toEqual(["marksman-novice"]);

    // Identity resolution is read-only. Disconnecting before game.ready must
    // not consume the one-time starter-inventory path.
    const reopened = new CharacterStore(path.join(dir, "characters.json"));
    await expect(identityFromOptions({ characterId: created.record.id }, reopened)).resolves.toMatchObject({
      characterId: created.record.id,
      returningCharacter: false,
    });
    expect(reopened.get(created.record.id)?.worldEntryClaimed).toBe(false);

    expect(reopened.claimWorldEntry(created.record.id)?.returning).toBe(false);
    await expect(identityFromOptions({ characterId: created.record.id }, reopened)).resolves.toMatchObject({
      characterId: created.record.id,
      returningCharacter: true,
    });
  });

  it("keeps an explicit fresh dev fixture spawn without signaling production shelter selection", async () => {
    const created = store.create({ name: "Farmer", appearance: validAppearance, initialProfessionId: "craftsman" });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const identity = await identityFromOptions({
      characterId: created.record.id,
      spawnArea: "open-desert-overworld",
      spawnX: "802",
      spawnY: "806",
      facing: "right",
    }, store);

    expect(identity.spawn).toEqual({
      areaId: "open-desert-overworld",
      x: 802,
      y: 806,
      facing: "right",
    });
    expect(identity).not.toHaveProperty("returningCharacter");
    expect(store.get(created.record.id)?.worldEntryClaimed).toBe(false);
  });

  it("resolves a server-normalized mixed-case Mac load characterId from the default local owner", async () => {
    const runId = "approved-mac5-20260710T110248Z";
    const namespace = "MacBookPro";
    const expectedId = "player-load-approved-mac5-20260710t110248z-macbookpro-004";
    await writeLoadCharacterStore(path.join(dir, "characters.json"), runId, 4, [namespace]);

    expect(store.get(expectedId)).toMatchObject({
      id: expectedId,
      ownerRef: "local",
      initialProfessionId: "marksman",
      professions: { skillBoxes: ["marksman-novice"] },
    });
    await expect(identityFromOptions({ characterId: expectedId.toUpperCase() }, store)).resolves.toMatchObject({
      actorId: expectedId,
      characterId: expectedId,
      ownerRef: "local",
      playerId: "local",
      skillBoxIds: ["marksman-novice"],
    });
  });

  it("projects persisted title, career goal, and canonical Rifle III skill boxes into the entered character identity", async () => {
    writeFileSync(path.join(dir, "characters.json"), `${JSON.stringify({
      schema: "successor.character-store.v2",
      characters: [currentIdentityRecord({
        id: "fixture-slugger",
        name: "Slugger",
        professions: {
          learned: [],
          trackXp: {},
          skillBoxes: ["marksman-novice", "marksman-rifle-i", "marksman-rifle-ii", "marksman-rifle-iii"],
          activeTitleId: null,
          credits: 5000,
          skillPointCap: 250,
        },
        activeTitleId: "marksman-rifle-iii",
        careerGoalId: "rifle_quartermaster",
      })],
    })}\n`, "utf8");

    const identity = await identityFromOptions({ characterId: "fixture-slugger" }, store);

    expect(identity).toMatchObject({
      actorId: "fixture-slugger",
      characterId: "fixture-slugger",
      returningCharacter: true,
      professionIds: ["marksman"],
      skillBoxIds: ["marksman-novice", "marksman-rifle-i", "marksman-rifle-ii", "marksman-rifle-iii"],
      credits: 5000,
      activeTitleId: "marksman-rifle-iii",
      careerGoalId: "rifle_quartermaster",
    });
  });

  it("projects exact legacy-array XP into the retired-actor rebuild identity", async () => {
    writeFileSync(path.join(dir, "characters.json"), `${JSON.stringify({
      schema: "successor.character-store.v2",
      characters: [currentIdentityRecord({
        id: "fixture-progressed",
        name: "Progressed",
        professions: [{
          id: "craftsman",
          label: "Craftsman",
          xp: 70,
          trackXp: { assembly: 60, experimentation: 10 },
          skillPoints: 16,
          skillBoxes: ["craftsman-novice"],
        }],
        credits: 8_765,
        skillPointCap: 300,
      })],
    })}\n`, "utf8");

    await expect(identityFromOptions({ characterId: "fixture-progressed" }, store)).resolves.toMatchObject({
      actorId: "fixture-progressed",
      characterId: "fixture-progressed",
      returningCharacter: true,
      professionIds: ["craftsman"],
      skillBoxIds: ["craftsman-novice"],
      professions: [{
        id: "craftsman",
        xp: 70,
        trackXp: { assembly: 60, experimentation: 10 },
        skillBoxes: ["craftsman-novice"],
      }],
      credits: 8_765,
      skillPointsCap: 300,
    });
  });

  it("rejects an unresolved pre-picker character before first entry", async () => {
    writeFileSync(path.join(dir, "characters.json"), `${JSON.stringify({
      schema: "successor.character-store.v2",
      characters: [currentIdentityRecord({
        id: "fixture-bootstrap",
        name: "Bootstrap",
        vitals: { health: 210, action: 140, spirit: 90 },
        initialProfessionId: null,
        professions: {
          learned: [],
          trackXp: {},
          skillBoxes: [],
          activeTitleId: null,
          credits: 5000,
          skillPointCap: 250,
        },
        worldEntryClaimed: false,
      })],
    })}\n`, "utf8");

    await expect(identityFromOptions({ characterId: "fixture-bootstrap" }, store)).rejects.toMatchObject({
      closeCode: 1008,
      message: "initial profession selection required",
    });
  });

  it("projects the resolved novice allocation, first-entry credits, and vitals", async () => {
    writeFileSync(path.join(dir, "characters.json"), `${JSON.stringify({
      schema: "successor.character-store.v2",
      characters: [currentIdentityRecord({
        id: "fixture-bootstrap-resolved",
        name: "Bootstrap",
        vitals: { health: 210, action: 140, spirit: 90 },
        initialProfessionId: "medic",
        professions: {
          learned: [],
          trackXp: {},
          skillBoxes: ["medic-novice"],
          activeTitleId: null,
          credits: 5000,
          skillPointCap: 250,
        },
        worldEntryClaimed: false,
      })],
    })}\n`, "utf8");

    await expect(identityFromOptions({ characterId: "fixture-bootstrap-resolved" }, store)).resolves.toMatchObject({
      actorId: "fixture-bootstrap-resolved",
      characterId: "fixture-bootstrap-resolved",
      returningCharacter: false,
      skillBoxIds: ["medic-novice"],
      credits: 5000,
      vitals: { health: 210, action: 140, spirit: 90 },
    });
  });

  it("resolves the raw playerId path (dev default ON)", async () => {
    const identity = await identityFromOptions({ playerId: "probeone" }, store);
    expect(identity.playerId).toBe("probeone");
    expect(identity.actorId).toBe("probeone");
    // raw dev path carries no persisted owner reference
    expect(identity.ownerRef).toBeUndefined();
  });

  it("rejects an unknown characterId", async () => {
    await expect(identityFromOptions({ characterId: "char_missing" }, store)).rejects.toThrow(/invalid characterId/u);
  });

  it("rejects a reserved durable character before claiming world entry", async () => {
    const created = store.create({ id: "player", name: "Reserved", appearance: validAppearance, initialProfessionId: "marksman" });
    expect(created.ok).toBe(true);
    await expect(identityFromOptions({ characterId: "player" }, store, {
      isCharacterIdReserved: (id) => id === "player",
    })).rejects.toMatchObject({
      closeCode: 1008,
      message: "character id collides with authored actor",
    });
    expect(store.get("player")?.worldEntryClaimed).toBe(false);
  });

  it("rejects a reserved ticket character before creating durable state", async () => {
    process.env.GAME_ALLOW_DEV_IDENTITY = "0";
    stubTicketFetch({
      player: ticketPlayer({ characterId: "player" }),
      entitlement: { access: true, characterSlots: 3, activeUntil: null },
    });

    await expect(identityFromOptions({ ticket: validTicket }, store, {
      isCharacterIdReserved: (id) => id === "player",
    })).rejects.toMatchObject({
      closeCode: 1008,
      message: "character id collides with authored actor",
    });
    expect(store.hasId("player")).toBe(false);
  });

  it("does not let a raw dev identity impersonate a durable character actor id", async () => {
    const created = store.create({ id: "char-owned", name: "Owned", appearance: validAppearance, initialProfessionId: "marksman" });
    expect(created.ok).toBe(true);
    await expect(identityFromOptions({ playerId: "probe", actorId: "char-owned" }, store)).rejects.toMatchObject({
      closeCode: 1008,
      message: "durable character identity required",
    });
  });

  it("does not let a raw dev identity claim an authored actor id", async () => {
    await expect(identityFromOptions({ playerId: "probe", actorId: "player" }, store, {
      isCharacterIdReserved: (id) => id === "player",
    })).rejects.toMatchObject({
      closeCode: 1008,
      message: "character id collides with authored actor",
    });
  });

  it("refuses browser-chosen identity with a 1008 join rejection when dev identity is disabled", async () => {
    const created = store.create({ name: "Gamma", appearance: validAppearance, initialProfessionId: "marksman" });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    process.env.GAME_ALLOW_DEV_IDENTITY = "0";
    await expect(identityFromOptions({ characterId: created.record.id }, store)).rejects.toMatchObject({ closeCode: 1008 });
    await expect(identityFromOptions({ playerId: "probeone" }, store)).rejects.toMatchObject({ closeCode: 1008 });
  });

  it("rejects a ticket missing required entitlement fields instead of default-opening", async () => {
    process.env.GAME_ALLOW_DEV_IDENTITY = "0";
    stubTicketFetch({
      player: ticketPlayer(),
      entitlement: { characterSlots: 3, activeUntil: null },
    });

    await expect(identityFromOptions({ ticket: validTicket }, store)).rejects.toMatchObject({
      closeCode: 1008,
      message: "invalid launch ticket",
    });
  });

  it("rejects a redeemed ticket without subscription access with close code 1008", async () => {
    process.env.GAME_ALLOW_DEV_IDENTITY = "0";
    stubTicketFetch({
      player: ticketPlayer(),
      entitlement: { access: false, characterSlots: 0, activeUntil: null },
    });

    await expect(identityFromOptions({ ticket: validTicket }, store)).rejects.toMatchObject({
      closeCode: 1008,
      message: "subscription required",
    });
  });

  it("fails closed when a current ticket omits its initial profession", async () => {
    process.env.GAME_ALLOW_DEV_IDENTITY = "0";
    const player = ticketPlayer();
    delete player.initialProfessionId;
    stubTicketFetch({
      player,
      entitlement: { access: true, characterSlots: 3, activeUntil: "2026-08-09T00:00:00.000Z" },
    });

    await expect(identityFromOptions({ ticket: validTicket }, store)).rejects.toMatchObject({
      closeCode: 1008,
      message: "initial profession selection required",
    });
    expect(store.get("char-ticket", "profile-123")).toBeNull();
  });

  it("rejects an existing hosted character when the ticket omits a current field", async () => {
    process.env.GAME_ALLOW_DEV_IDENTITY = "0";
    const created = store.create({
      id: "char-ticket",
      ownerRef: "profile-123",
      name: "Atlas",
      appearance: validAppearance,
      initialProfessionId: "brawler",
    });
    expect(created.ok).toBe(true);
    const player = ticketPlayer();
    delete player.initialProfessionId;
    stubTicketFetch({
      player,
      entitlement: { access: true, characterSlots: 3, activeUntil: "2026-08-09T00:00:00.000Z" },
    });

    await expect(identityFromOptions({ ticket: validTicket }, store)).rejects.toMatchObject({
      closeCode: 1008,
      message: "initial profession selection required",
    });
  });

  it("rejects invalid hosted names when a ticket would create a new character", async () => {
    process.env.GAME_ALLOW_DEV_IDENTITY = "0";
    stubTicketFetch({
      player: ticketPlayer({ displayName: "Atlas Prime", characterId: "char-invalid-name" }),
      entitlement: { access: true, characterSlots: 3, activeUntil: null },
    });
    await expect(identityFromOptions({ ticket: validTicket }, store)).rejects.toMatchObject({
      closeCode: 1008,
      message: "invalid ticket character: invalid_name",
    });
    expect(store.get("char-invalid-name", "profile-123")).toBeNull();
  });

  it("loads ticket identity from current durable state and ignores query identity", async () => {
    process.env.GAME_ALLOW_DEV_IDENTITY = "0";
    const created = store.create({
      id: "char-ticket",
      ownerRef: "profile-123",
      name: "Atlas-Prime",
      appearance: validAppearance,
      initialProfessionId: "marksman",
    });
    expect(created.ok).toBe(true);
    stubTicketFetch({
      player: ticketPlayer(),
      entitlement: { access: true, characterSlots: 3, activeUntil: "2026-08-09T00:00:00.000Z" },
    });

    const identity = await identityFromOptions({
      ticket: validTicket,
      actorId: "browser-actor",
      playerId: "browser-player",
      name: "BrowserName",
      characterId: "",
    }, store);

    expect(identity).toMatchObject({
      actorId: "char-ticket",
      playerId: "profile-123",
      ownerRef: "profile-123",
      characterId: "char-ticket",
      returningCharacter: false,
      displayName: "Atlas-Prime",
      sprite: "adventurer-premium-female",
      zoneId: "open-desert-overworld",
      entitlement: { access: true, characterSlots: 3, activeUntil: "2026-08-09T00:00:00.000Z" },
    });
    expect(identity.worn).toEqual(defaultStarterWorn());
    expect(identity.skillBoxIds).toEqual(["marksman-novice"]);
    expect(store.get("char-ticket", "profile-123")).toMatchObject({
      id: "char-ticket",
      ownerRef: "profile-123",
      name: "Atlas-Prime",
      initialProfessionId: "marksman",
      worn: defaultStarterWorn(),
      worldEntryClaimed: false,
    });
  });
});
