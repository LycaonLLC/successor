import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { registerGameRoutes } from "./routes.js";
import { CharacterStore, successorMacroRecordBodyMaxBytes, successorMacrosRecordKind } from "./characterStore.js";
import { GameShardCheckpointError, type GameShard } from "./shard.js";
import type { GameActorSnapshot } from "./protocol.js";
import { RustAuthorityBridge } from "./rustAuthorityBridge.js";
import { createApp } from "../index.js";

let appInstance: FastifyInstance | null = null;
const originalDebugAuthorityCommands = process.env.GAME_DEBUG_AUTHORITY_COMMANDS;
const originalGameAllowDevIdentity = process.env.GAME_ALLOW_DEV_IDENTITY;
const originalSuccessorSiteUrl = process.env.SUCCESSOR_SITE_URL;
const originalNodeEnv = process.env.NODE_ENV;
const originalGameClock = process.env.GAME_CLOCK;
const originalGameShardPersistence = process.env.GAME_SHARD_PERSISTENCE;
const originalGameCharacterStorePath = process.env.GAME_CHARACTER_STORE_PATH;
const originalLogLevel = process.env.LOG_LEVEL;
const tempDirs: string[] = [];

beforeEach(() => {
  process.env.GAME_ALLOW_DEV_IDENTITY = "1";
  delete process.env.SUCCESSOR_SITE_URL;
  process.env.NODE_ENV = "test";
});

afterEach(async () => {
  if (appInstance) {
    await appInstance.close();
    appInstance = null;
  }
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  if (originalDebugAuthorityCommands === undefined) delete process.env.GAME_DEBUG_AUTHORITY_COMMANDS;
  else process.env.GAME_DEBUG_AUTHORITY_COMMANDS = originalDebugAuthorityCommands;
  if (originalGameAllowDevIdentity === undefined) delete process.env.GAME_ALLOW_DEV_IDENTITY;
  else process.env.GAME_ALLOW_DEV_IDENTITY = originalGameAllowDevIdentity;
  if (originalSuccessorSiteUrl === undefined) delete process.env.SUCCESSOR_SITE_URL;
  else process.env.SUCCESSOR_SITE_URL = originalSuccessorSiteUrl;
  if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = originalNodeEnv;
  if (originalGameClock === undefined) delete process.env.GAME_CLOCK;
  else process.env.GAME_CLOCK = originalGameClock;
  if (originalGameShardPersistence === undefined) delete process.env.GAME_SHARD_PERSISTENCE;
  else process.env.GAME_SHARD_PERSISTENCE = originalGameShardPersistence;
  if (originalGameCharacterStorePath === undefined) delete process.env.GAME_CHARACTER_STORE_PATH;
  else process.env.GAME_CHARACTER_STORE_PATH = originalGameCharacterStorePath;
  if (originalLogLevel === undefined) delete process.env.LOG_LEVEL;
  else process.env.LOG_LEVEL = originalLogLevel;
});

function routeOptions(shard: GameShard) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "successor-routes-character-store-"));
  tempDirs.push(dir);
  return { shard, characterStore: new CharacterStore(path.join(dir, "characters.json")) };
}

function buildRealRustAuthorityBridge() {
  const cwd = process.cwd();
  const repoRoot = path.basename(cwd) === "server" ? path.resolve(cwd, "..") : cwd;
  execFileSync(
    "cargo",
    ["build", "--quiet", "-p", "successor-sim", "--example", "authority_bridge_server"],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        CARGO_PROFILE_DEV_OPT_LEVEL: process.env.CARGO_PROFILE_DEV_OPT_LEVEL ?? "2",
      },
      stdio: "inherit",
    },
  );
}

function routeActorSnapshot(overrides: Partial<GameActorSnapshot> = {}): GameActorSnapshot {
  return {
    id: "char_route",
    label: "Atlas",
    display_name: "Atlas",
    link_dead: false,
    appearance: { skin: "#aabbcc", hair: "hair_crop2", hair_mat: "hair_chestnut" },
    role: "player",
    sprite: "adventurer-premium-male",
    areaId: "open-desert-overworld",
    x: 520,
    y: 516,
    direction: "right",
    posture: "standing",
    postureUntilTick: 0,
    lifeState: "alive",
    lifecycleSeq: 1,
    vitals: { health: 91, action: 77, spirit: 68 },
    maxVitals: { health: 100, action: 100, spirit: 100 },
    bleed: { active: false, stackCount: 0, severity: 0, remainingMs: 0, ratesPerSecond: { health: 0, action: 0, spirit: 0 } },
    statuses: [],
    ...overrides,
  };
}

describe("game routes", () => {
  it("returns root metrics JSON from shard authority metrics", async () => {
    appInstance = Fastify();
    const shard = {
      status: () => ({
        tick: 77,
        authority: {
          metrics: { tick: 77, hits: 2, deaths: 1 },
          exchangeMetrics: { schema: "successor.authority.exchange-metrics.v1", totals: { closedLifetime: 1 } },
        },
      }),
      characterLiveState: () => "offline",
      defaultJoinSpawnForActor: () => ({ areaId: "open-desert-overworld", x: 512, y: 512, facing: "front" }),
      characterJoinSpawnForActor: () => ({ areaId: "open-desert-overworld", x: 512, y: 512, facing: "front" }),
    } as unknown as GameShard;
    await registerGameRoutes(appInstance, routeOptions(shard));

    const response = await appInstance.inject({ method: "GET", url: "/metrics" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      schema: "successor.metrics.v1",
      tick: 77,
      authority: { hits: 2, deaths: 1 },
      exchange: { schema: "successor.authority.exchange-metrics.v1" },
    });
  });

  it("awaits the shard metrics query when the shard exposes one", async () => {
    appInstance = Fastify();
    const shard = {
      metrics: async () => ({
        schema: "successor.metrics.v1",
        tick: 88,
        authority: { tick: 88, hits: 3 },
        exchange: { schema: "successor.authority.exchange-metrics.v1", totals: { active: 1 } },
      }),
      status: () => {
        throw new Error("metrics route should not fall back to status when shard.metrics exists");
      },
      characterLiveState: () => "offline",
      defaultJoinSpawnForActor: () => ({ areaId: "open-desert-overworld", x: 512, y: 512, facing: "front" }),
      characterJoinSpawnForActor: () => ({ areaId: "open-desert-overworld", x: 512, y: 512, facing: "front" }),
    } as unknown as GameShard;
    await registerGameRoutes(appInstance, routeOptions(shard));

    const response = await appInstance.inject({ method: "GET", url: "/metrics" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      schema: "successor.metrics.v1",
      tick: 88,
      authority: { hits: 3 },
      exchange: { totals: { active: 1 } },
    });
  });

  it("gates readyz on shard readiness and disables caching", async () => {
    appInstance = Fastify();
    let ready = false;
    const shard = {
      status: () => ({ readiness: { ready, checkpoint: ready, rust: ready } }),
      characterLiveState: () => "offline",
      defaultJoinSpawnForActor: () => ({ areaId: "open-desert-overworld", x: 512, y: 512, facing: "front" }),
      characterJoinSpawnForActor: () => ({ areaId: "open-desert-overworld", x: 512, y: 512, facing: "front" }),
    } as unknown as GameShard;
    await registerGameRoutes(appInstance, routeOptions(shard));

    const pending = await appInstance.inject({ method: "GET", url: "/readyz" });
    expect(pending.statusCode).toBe(503);
    expect(pending.headers["cache-control"]).toBe("no-store");
    ready = true;
    const available = await appInstance.inject({ method: "GET", url: "/readyz" });
    expect(available.statusCode).toBe(200);
    expect(available.json()).toMatchObject({ schema: "successor.readiness.v1", ready: true });
  });

  it("hides dev roster and debug HTTP surfaces when dev identity is disabled", async () => {
    process.env.GAME_ALLOW_DEV_IDENTITY = "0";
    appInstance = Fastify();
    const shard = {
      status: () => ({ tick: 42, sessionCount: 0, actorCount: 0, shardId: "test-shard" }),
      characterLiveState: () => "offline",
      debugOracle: () => ({ schema: "successor.game-shard-oracle.v1", actors: {} }),
      defaultJoinSpawnForActor: () => ({ areaId: "open-desert-overworld", x: 512, y: 512, facing: "front" }),
      characterJoinSpawnForActor: () => ({ areaId: "open-desert-overworld", x: 512, y: 512, facing: "front" }),
    } as unknown as GameShard;
    await registerGameRoutes(appInstance, routeOptions(shard));

    const status = await appInstance.inject({ method: "GET", url: "/game/status" });
    const characters = await appInstance.inject({ method: "GET", url: "/game/characters" });
    const charactersOptions = await appInstance.inject({ method: "OPTIONS", url: "/game/characters" });
    const debug = await appInstance.inject({ method: "GET", url: "/game/debug/oracle" });
    const checkpoint = await appInstance.inject({ method: "POST", url: "/game/debug/checkpoint" });

    expect(status.statusCode).toBe(200);
    expect(characters.statusCode).toBe(404);
    expect(characters.json()).toEqual({ error: "not_found" });
    expect(charactersOptions.statusCode).toBe(404);
    expect(debug.statusCode).toBe(404);
    expect(checkpoint.statusCode).toBe(404);
  });

  it("creates characters and enters at the stored logout position or shard default", async () => {
    appInstance = Fastify();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "successor-routes-character-api-"));
    tempDirs.push(dir);
    const characterStore = new CharacterStore(path.join(dir, "characters.json"));
    const shard = {
      status: () => ({ tick: 42, sessionCount: 0, actorCount: 0, shardId: "test-shard" }),
      characterLiveState: () => "offline",
      defaultJoinSpawnForActor: () => ({ areaId: "open-desert-overworld", x: 512, y: 512, facing: "front" }),
      characterJoinSpawnForActor: (_actorId: string, fallback?: { areaId: string; x: number; y: number; facing: string } | null) => fallback ?? { areaId: "open-desert-overworld", x: 512, y: 512, facing: "front" },
    } as unknown as GameShard;
    await registerGameRoutes(appInstance, { shard, characterStore });

    const created = await appInstance.inject({
      method: "POST",
      url: "/game/characters",
      payload: {
        name: "Atlas",
        appearance: { skinTone: "#aabbcc", hair: "hair_crop2", hairMat: "hair_chestnut", face: null },
        initialProfessionId: "brawler",
      },
    });
    expect(created.statusCode).toBe(201);
    const createdRecord = created.json() as { id: string };

    const duplicate = await appInstance.inject({
      method: "POST",
      url: "/game/characters",
      payload: {
        name: "atlas",
        appearance: { skinTone: "#aabbcc", hair: "hair_crop2", hairMat: "hair_chestnut", face: null },
        initialProfessionId: "brawler",
      },
    });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json()).toEqual({ error: "name_taken" });

    const freshEnter = await appInstance.inject({ method: "POST", url: `/game/characters/${createdRecord.id}/enter` });
    expect(freshEnter.statusCode).toBe(200);
    expect(freshEnter.json().join).toMatchObject({
      actorId: createdRecord.id,
      name: "Atlas",
      spawnArea: "open-desert-overworld",
      spawnX: 512,
      spawnY: 512,
      facing: "front",
      appearance: { skinTone: "#aabbcc", hair: "hair_crop2", hairMat: "hair_chestnut", face: null },
    });

    characterStore.saveActorSnapshot(createdRecord.id, routeActorSnapshot({ id: createdRecord.id }), {
      logout: true,
      atMs: Date.parse("2026-07-06T00:02:00.000Z"),
    });
    const savedEnter = await appInstance.inject({ method: "POST", url: `/game/characters/${createdRecord.id}/enter` });
    expect(savedEnter.json().join).toMatchObject({
      spawnArea: "open-desert-overworld",
      spawnX: 520,
      spawnY: 516,
      facing: "right",
    });
  });

  it("requires one ordinary novice allocation and resolves interrupted pre-picker creation idempotently", async () => {
    appInstance = Fastify();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "successor-routes-initial-profession-"));
    tempDirs.push(dir);
    const characterStore = new CharacterStore(path.join(dir, "characters.json"));
    const shard = {
      status: () => ({ tick: 42, sessionCount: 0, actorCount: 0, shardId: "test-shard" }),
      characterLiveState: () => "offline",
      defaultJoinSpawnForActor: () => ({ areaId: "open-desert-overworld", x: 512, y: 512, facing: "front" }),
      characterJoinSpawnForActor: () => ({ areaId: "open-desert-overworld", x: 512, y: 512, facing: "front" }),
    } as unknown as GameShard;
    await registerGameRoutes(appInstance, { shard, characterStore });

    const missing = await appInstance.inject({
      method: "POST",
      url: "/game/characters",
      payload: {
        name: "Atlas",
        appearance: { skinTone: "#aabbcc", hair: "hair_crop2", hairMat: "hair_chestnut", face: null },
      },
    });
    expect(missing.statusCode).toBe(400);
    expect(missing.json()).toEqual({ error: "invalid_initial_profession" });

    const bodyless = await appInstance.inject({ method: "POST", url: "/game/characters" });
    expect(bodyless.statusCode).toBe(400);
    expect(bodyless.json()).toEqual({ error: "invalid_character_request" });

    for (const payload of [
      [],
      { initialProfessionId: "brawler", appearance: { skinTone: "#aabbcc", hair: "hair_crop2", hairMat: "hair_chestnut", face: null } },
      { initialProfessionId: "brawler", name: "Atlas" },
      { name: "Atlas" },
    ]) {
      const malformed = await appInstance.inject({
        method: "POST",
        url: "/game/characters",
        payload,
      });
      expect(malformed.statusCode).toBe(400);
      expect(malformed.json()).toEqual({ error: "invalid_character_request" });
    }

    const invalid = await appInstance.inject({
      method: "POST",
      url: "/game/characters",
      payload: {
        name: "Atlas",
        appearance: { skinTone: "#aabbcc", hair: "hair_crop2", hairMat: "hair_chestnut", face: null },
        initialProfessionId: "chef",
      },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toEqual({ error: "invalid_initial_profession" });

    const legacy = characterStore.create({ name: "Legacy", appearance: { skinTone: "#aabbcc", hair: "hair_crop2", hairMat: "hair_chestnut", face: null } });
    if (!legacy.ok) throw new Error("expected legacy pending character creation");
    const blocked = await appInstance.inject({ method: "POST", url: `/game/characters/${legacy.record.id}/enter` });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json()).toEqual({ error: "initial_profession_required" });

    const preflight = await appInstance.inject({
      method: "OPTIONS",
      url: `/game/characters/${legacy.record.id}/initial-profession`,
      headers: {
        origin: "http://127.0.0.1:5179",
        "access-control-request-method": "PUT",
        "access-control-request-headers": "content-type",
      },
    });
    expect(preflight.statusCode).toBe(204);
    expect(preflight.headers["access-control-allow-methods"]).toContain("PUT");

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const selected = await appInstance.inject({
        method: "PUT",
        url: `/game/characters/${legacy.record.id}/initial-profession`,
        payload: { initialProfessionId: "scout" },
      });
      expect(selected.statusCode).toBe(200);
      expect(selected.json()).toMatchObject({
        id: legacy.record.id,
        initialProfessionId: "scout",
        professions: { skillBoxes: ["scout-novice"], skillPointCap: 250 },
      });
    }

    const changed = await appInstance.inject({
      method: "PUT",
      url: `/game/characters/${legacy.record.id}/initial-profession`,
      payload: { initialProfessionId: "brawler" },
    });
    expect(changed.statusCode).toBe(409);
    expect(changed.json()).toEqual({ error: "initial_profession_locked" });

    const enter = await appInstance.inject({ method: "POST", url: `/game/characters/${legacy.record.id}/enter` });
    expect(enter.statusCode).toBe(200);
  });

  it("deletes only never-entered characters and preserves offline world owners", async () => {
    appInstance = Fastify();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "successor-routes-character-delete-"));
    tempDirs.push(dir);
    const characterStore = new CharacterStore(path.join(dir, "characters.json"));
    const authorityOwners = new Set<string>();
    const deletedCharacterIds: string[] = [];
    const shard = {
      status: () => ({ tick: 42, sessionCount: 0, actorCount: 0, shardId: "test-shard" }),
      characterLiveState: () => "offline",
      characterHasDurableAuthorityState: (characterId: string) => authorityOwners.has(characterId),
      defaultJoinSpawnForActor: () => ({ areaId: "open-desert-overworld", x: 512, y: 512, facing: "front" }),
      characterJoinSpawnForActor: () => ({ areaId: "open-desert-overworld", x: 512, y: 512, facing: "front" }),
    } as unknown as GameShard;
    await registerGameRoutes(appInstance, { shard, characterStore, onCharacterDeleted: (characterId) => deletedCharacterIds.push(characterId) });

    const fresh = characterStore.create({ name: "Fresh", appearance: { skinTone: "#aabbcc", hair: "hair_crop2", hairMat: "hair_chestnut", face: null } });
    if (!fresh.ok) throw new Error("expected fresh character creation");
    const freshDelete = await appInstance.inject({ method: "DELETE", url: `/game/characters/${fresh.record.id}` });
    expect(freshDelete.statusCode).toBe(200);
    expect(characterStore.get(fresh.record.id)).toBeNull();
    expect(deletedCharacterIds).toEqual([fresh.record.id]);

    const veteran = characterStore.create({ name: "Veteran", appearance: { skinTone: "#aabbcc", hair: "hair_crop2", hairMat: "hair_chestnut", face: null } });
    if (!veteran.ok) throw new Error("expected veteran character creation");
    expect(characterStore.claimWorldEntry(veteran.record.id)?.record.worldEntryClaimed).toBe(true);
    const veteranDelete = await appInstance.inject({ method: "DELETE", url: `/game/characters/${veteran.record.id}` });
    expect(veteranDelete.statusCode).toBe(409);
    expect(veteranDelete.json()).toEqual({ error: "character_deletion_requires_retirement" });
    expect(characterStore.get(veteran.record.id)?.worldEntryClaimed).toBe(true);

    const interrupted = characterStore.create({ name: "Pending", appearance: { skinTone: "#aabbcc", hair: "hair_crop2", hairMat: "hair_chestnut", face: null } });
    if (!interrupted.ok) throw new Error("expected interrupted character creation");
    authorityOwners.add(interrupted.record.id);
    const interruptedDelete = await appInstance.inject({ method: "DELETE", url: `/game/characters/${interrupted.record.id}` });
    expect(interruptedDelete.statusCode).toBe(409);
    expect(interruptedDelete.json()).toEqual({ error: "character_deletion_requires_retirement" });
    expect(characterStore.get(interrupted.record.id)?.worldEntryClaimed).toBe(false);
  });
  it("rejects deletion after world entry and preserves the durable roster", async () => {
    appInstance = Fastify();
    const liveStates = new Map<string, "offline" | "online" | "linkdead">();
    const retired: string[] = [];
    const failing = new Set<string>();
    const shard = {
      status: () => ({ tick: 42, sessionCount: 0, actorCount: 0, shardId: "test-shard" }),
      characterLiveState: (characterId: string) => liveStates.get(characterId) ?? "offline",
      characterHasDurableAuthorityState: () => false,
      retireOfflineCharacter: async (characterId: string) => {
        if (failing.has(characterId)) throw new Error("authority unavailable");
        retired.push(characterId);
      },
      defaultJoinSpawnForActor: () => ({ areaId: "open-desert-overworld", x: 512, y: 512, facing: "front" }),
      characterJoinSpawnForActor: () => ({ areaId: "open-desert-overworld", x: 512, y: 512, facing: "front" }),
    } as unknown as GameShard;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "successor-routes-character-retire-"));
    tempDirs.push(dir);
    const store = new CharacterStore(path.join(dir, "characters.json"));
    await registerGameRoutes(appInstance, { shard, characterStore: store });
    const create = (name: string) => {
      const result = store.create({
        name,
        appearance: { skinTone: "#aabbcc", hair: "hair_crop2", hairMat: "hair_chestnut", face: null },
      });
      if (!result.ok) throw new Error(`failed to create ${name}`);
      return result.record;
    };

    const played = create("Played");
    store.claimWorldEntry(played.id);
    const playedDelete = await appInstance.inject({ method: "DELETE", url: `/game/characters/${played.id}` });
    expect(playedDelete.statusCode).toBe(409);
    expect(playedDelete.json()).toEqual({ error: "character_deletion_requires_retirement" })
    expect(store.get(played.id)?.worldEntryClaimed).toBe(true);
    expect(retired).toEqual([]);

    const failed = create("Failed");
    store.claimWorldEntry(failed.id);
    failing.add(failed.id);
    const failedDelete = await appInstance.inject({ method: "DELETE", url: `/game/characters/${failed.id}` });
    expect(failedDelete.statusCode).toBe(409);
    expect(failedDelete.json()).toEqual({ error: "character_deletion_requires_retirement" });
    expect(store.get(failed.id)?.worldEntryClaimed).toBe(true);

    const online = create("Online");
    store.claimWorldEntry(online.id);
    liveStates.set(online.id, "online");
    const onlineDelete = await appInstance.inject({ method: "DELETE", url: `/game/characters/${online.id}` });
    expect(onlineDelete.statusCode).toBe(409);
    liveStates.set(online.id, "linkdead");
    const linkdeadDelete = await appInstance.inject({ method: "DELETE", url: `/game/characters/${online.id}` });
    expect(linkdeadDelete.statusCode).toBe(409);

    const neverEntered = create("NeverEntered");
    const neverEnteredDelete = await appInstance.inject({ method: "DELETE", url: `/game/characters/${neverEntered.id}` });
    expect(neverEnteredDelete.statusCode).toBe(200);
    expect(store.get(neverEntered.id)).toBeNull();
  });

  it("offers character re-entry for online takeover and link-dead reconnect instead of rejecting already_online", async () => {
    appInstance = Fastify();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "successor-routes-character-reentry-"));
    tempDirs.push(dir);
    const characterStore = new CharacterStore(path.join(dir, "characters.json"));
    const liveStates = new Map<string, "online" | "linkdead">();
    const shard = {
      status: () => ({ tick: 42, sessionCount: 1, actorCount: 1, shardId: "test-shard" }),
      characterLiveState: (characterId: string) => liveStates.get(characterId) ?? "offline",
      characterJoinSpawnForActor: () => ({ areaId: "open-desert-overworld", x: 533, y: 529, facing: "left" }),
      defaultJoinSpawnForActor: () => ({ areaId: "open-desert-overworld", x: 512, y: 512, facing: "front" }),
    } as unknown as GameShard;
    await registerGameRoutes(appInstance, { shard, characterStore });

    const created = await appInstance.inject({
      method: "POST",
      url: "/game/characters",
      payload: {
        name: "Rejoin",
        appearance: { skinTone: "#aabbcc", hair: "hair_crop2", hairMat: "hair_chestnut", face: null },
        initialProfessionId: "marksman",
      },
    });
    const characterId = (created.json() as { id: string }).id;

    liveStates.set(characterId, "online");
    const onlineEnter = await appInstance.inject({ method: "POST", url: `/game/characters/${characterId}/enter` });
    expect(onlineEnter.statusCode).toBe(200);
    expect(onlineEnter.json().join).toMatchObject({
      actorId: characterId,
      spawnX: 533,
      spawnY: 529,
      facing: "left",
      liveState: "online",
      takeover: true,
      reconnect: false,
    });

    liveStates.set(characterId, "linkdead");
    const linkdeadEnter = await appInstance.inject({ method: "POST", url: `/game/characters/${characterId}/enter` });
    expect(linkdeadEnter.statusCode).toBe(200);
    expect(linkdeadEnter.json().join).toMatchObject({
      liveState: "linkdead",
      takeover: false,
      reconnect: true,
    });
  });

  it("exposes debug oracle with browser-readable CORS headers", async () => {
    appInstance = Fastify();
    const shard = {
      status: () => ({ ok: true }),
      debugOracle: () => ({ schema: "successor.game-shard-oracle.v1", actors: {} }),
    } as unknown as GameShard;
    await registerGameRoutes(appInstance, routeOptions(shard));

    const response = await appInstance.inject({ method: "GET", url: "/game/debug/oracle" });

    expect(response.statusCode).toBe(200);
    expect(response.headers["access-control-allow-origin"]).toBe("*");
    expect(response.json()).toMatchObject({ schema: "successor.game-shard-oracle.v1" });
  });

  it("awaits a debug checkpoint and returns persisted shard evidence", async () => {
    appInstance = Fastify();
    let checkpointCompleted = false;
    const checkpointPath = "/tmp/test-shard.checkpoint.json";
    const stateHash = "a".repeat(64);
    const shard = {
      checkpoint: async (reason: string) => {
        await new Promise<void>((resolve) => setImmediate(resolve));
        checkpointCompleted = true;
        expect(reason).toBe("debug");
        return {
          schema: "successor.game-shard-checkpoint-evidence.v1" as const,
          shardId: "test-shard",
          tick: 84,
          stateHash,
          projectionStateHash: "b".repeat(64),
          persistence: {
            enabled: true as const,
            checkpointPath,
            journalPath: "/tmp/test-shard.journal.jsonl",
            checkpointWriteCount: 3,
            lastCheckpointAt: "2026-07-09T12:00:00.000Z",
            lastCheckpointTick: 84,
            lastCheckpointReason: reason,
            stateHash,
          },
        };
      },
    } as unknown as GameShard;
    await registerGameRoutes(appInstance, routeOptions(shard));

    const response = await appInstance.inject({ method: "POST", url: "/game/debug/checkpoint" });

    expect(checkpointCompleted).toBe(true);
    expect(response.statusCode).toBe(200);
    expect(response.headers["access-control-allow-origin"]).toBe("*");
    expect(response.json()).toEqual({
      schema: "successor.game-shard-checkpoint-evidence.v1",
      shardId: "test-shard",
      tick: 84,
      stateHash,
      projectionStateHash: "b".repeat(64),
      persistence: {
        enabled: true,
        checkpointPath,
        journalPath: "/tmp/test-shard.journal.jsonl",
        checkpointWriteCount: 3,
        lastCheckpointAt: "2026-07-09T12:00:00.000Z",
        lastCheckpointTick: 84,
        lastCheckpointReason: "debug",
        stateHash,
      },
    });
  });

  it("fails the debug checkpoint endpoint when persistence is disabled or the checkpoint fails", async () => {
    appInstance = Fastify();
    let attempt = 0;
    const shard = {
      checkpoint: async () => {
        attempt += 1;
        if (attempt === 1) {
          throw new GameShardCheckpointError("persistence_disabled", "checkpoint persistence disabled for test");
        }
        throw new Error("checkpoint export failed for test");
      },
    } as unknown as GameShard;
    await registerGameRoutes(appInstance, routeOptions(shard));

    const disabled = await appInstance.inject({ method: "POST", url: "/game/debug/checkpoint" });
    const failed = await appInstance.inject({ method: "POST", url: "/game/debug/checkpoint" });

    expect(disabled.statusCode).toBe(409);
    expect(disabled.json()).toEqual({ error: "persistence_disabled" });
    expect(failed.statusCode).toBe(500);
    expect(failed.json()).toEqual({ error: "checkpoint_failed" });
  });

  it("accepts debug spatial speech for a live actor and exposes it to the client poller", async () => {
    appInstance = Fastify();
    const shard = {
      status: () => ({ ok: true }),
      debugOracle: () => ({
        schema: "successor.game-shard-oracle.v1",
        actors: {
          "desert-warden-agent-lead-01": {
            id: "desert-warden-agent-lead-01",
            label: "Desert Warden Skirmisher",
            areaId: "authority-test-overworld",
            x: 35.5,
            y: 17,
            lifeState: "alive",
          },
        },
      }),
    } as unknown as GameShard;
    await registerGameRoutes(appInstance, routeOptions(shard));

    const posted = await appInstance.inject({
      method: "POST",
      url: "/game/debug/spatial-speech",
      payload: {
        actorId: "desert-warden-agent-lead-01",
        speaker: "Novice Marksman",
        body: " Grubs pushing left. ",
        source: "test",
      },
    });
    const listed = await appInstance.inject({ method: "GET", url: "/game/debug/spatial-speech" });

    expect(posted.statusCode).toBe(201);
    expect(posted.headers["access-control-allow-methods"]).toContain("POST");
    expect(posted.json().message).toMatchObject({
      actorId: "desert-warden-agent-lead-01",
      areaId: "authority-test-overworld",
      speaker: "Desert Warden Skirmisher",
      body: "Grubs pushing left.",
      x: 35.5,
      y: 17,
      source: "test",
    });
    expect(listed.json().messages).toHaveLength(1);
  });

  it("turns skill training timeline events into deterministic spatial barks", async () => {
    appInstance = Fastify();
    const shard = {
      status: () => ({ ok: true }),
      debugOracle: () => ({
        schema: "successor.game-shard-oracle.v1",
        tick: 30,
        actors: {
          "desert-warden-agent-guard-01": {
            id: "desert-warden-agent-guard-01",
            label: "Aster Vale",
            areaId: "authority-test-overworld",
            factionId: "desert_wardens",
            x: 35.5,
            y: 17,
            lifeState: "alive",
          },
        },
        timelineEvents: [
          {
            tick: 30,
            label: "desert-warden-agent-guard-01 auto-trained medic-novice with profession-trainer-01",
          },
        ],
      }),
    } as unknown as GameShard;
    await registerGameRoutes(appInstance, routeOptions(shard));

    const response = await appInstance.inject({ method: "GET", url: "/game/debug/spatial-speech" });

    expect(response.statusCode).toBe(200);
    expect(response.json().messages).toEqual([
      expect.objectContaining({
        actorId: "desert-warden-agent-guard-01",
        speaker: "Aster Vale",
        body: "Medic basics learned.",
        source: "deterministic-authority-bark",
      }),
    ]);
  });

  it("submits gated debug item and skill authority commands through the shard", async () => {
    process.env.GAME_DEBUG_AUTHORITY_COMMANDS = "1";
    appInstance = Fastify();
    const submitted: unknown[] = [];
    const shard = {
      status: () => ({ ok: true }),
      debugOracle: () => ({ schema: "successor.game-shard-oracle.v1", actors: {} }),
      checkpoint: async () => undefined,
      submitDebugAuthorityCommand: async (actorId: string, command: unknown) => {
        submitted.push({ actorId, command });
        const commandKind = Object.keys(command as Record<string, unknown>)[0] ?? "unknown";
        return {
          actorId,
          commandId: submitted.length,
          commandKind,
          receipt: { commandId: submitted.length, accepted: true, tick: 42 },
          events: [],
          delta: {},
        };
      },
    } as unknown as GameShard;
    await registerGameRoutes(appInstance, routeOptions(shard));

    const give = await appInstance.inject({
      method: "POST",
      url: "/game/debug/authority-command",
      payload: {
        actorId: "ActionJohnson",
        command: { DebugGiveItem: { item_id: 3104, variant_id: 0, quantity: 1, equip: true } },
      },
    });
    const grant = await appInstance.inject({
      method: "POST",
      url: "/game/debug/authority-command",
      payload: {
        actorId: "ActionJohnson",
        command: { DebugGrantSkillBoxes: { skill_box_ids: ["brawler-ranged-block-i"] } },
      },
    });

    expect(give.statusCode).toBe(202);
    expect(give.json()).toMatchObject({
      schema: "successor.debug-authority-command.v1",
      actorId: "ActionJohnson",
      commandId: 1,
      commandKind: "DebugGiveItem",
      receipt: { accepted: true },
    });
    expect(grant.statusCode).toBe(202);
    expect(grant.json()).toMatchObject({
      actorId: "ActionJohnson",
      commandId: 2,
      commandKind: "DebugGrantSkillBoxes",
    });
    expect(submitted).toEqual([
      {
        actorId: "ActionJohnson",
        command: { DebugGiveItem: { item_id: 3104, variant_id: 0, quantity: 1, equip: true } },
      },
      {
        actorId: "ActionJohnson",
        command: { DebugGrantSkillBoxes: { skill_box_ids: ["brawler-ranged-block-i"] } },
      },
    ]);
  });

  it("keeps direct debug authority commands disabled unless explicitly enabled", async () => {
    delete process.env.GAME_DEBUG_AUTHORITY_COMMANDS;
    appInstance = Fastify();
    const submitted: unknown[] = [];
    const shard = {
      status: () => ({ ok: true }),
      debugOracle: () => ({ schema: "successor.game-shard-oracle.v1", actors: {} }),
      submitDebugAuthorityCommand: async (actorId: string, command: unknown) => {
        submitted.push({ actorId, command });
        return {
          actorId,
          commandId: 7,
          commandKind: "Move",
          receipt: { commandId: 7, accepted: true, tick: 42 },
          events: [],
          delta: {},
        };
      },
    } as unknown as GameShard;
    await registerGameRoutes(appInstance, routeOptions(shard));

    const response = await appInstance.inject({
      method: "POST",
      url: "/game/debug/authority-command",
      payload: {
        actorId: "desert-warden-agent-lead-01",
        command: { Move: { dx: 1, dy: 0, duration_ticks: 3, facing: "Right" } },
      },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({
      error: "debug_authority_command_disabled",
      enableWith: "GAME_DEBUG_AUTHORITY_COMMANDS=1",
    });
    expect(submitted).toEqual([]);
  });

  it("resets the debug fixture through the shard", async () => {
    appInstance = Fastify();
    let resets = 0;
    const shard = {
      status: () => ({ ok: true }),
      debugOracle: () => ({ schema: "successor.game-shard-oracle.v1", actors: {} }),
      checkpoint: async () => undefined,
      resetDebugFixture: async () => {
        resets += 1;
        return {
          schema: "successor.debug-reset-fixture.v1",
          accepted: true,
          tick: 42,
          actorIds: ["desert-warden-agent-lead-01"],
          inventory: [],
        };
      },
    } as unknown as GameShard;
    await registerGameRoutes(appInstance, routeOptions(shard));

    const response = await appInstance.inject({
      method: "POST",
      url: "/game/debug/reset-fixture",
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({
      schema: "successor.debug-reset-fixture.v1",
      accepted: true,
      actorIds: ["desert-warden-agent-lead-01"],
    });
    expect(resets).toBe(1);
  });

  it("submits debug loadout restocks through the shard", async () => {
    appInstance = Fastify();
    const restocks: string[] = [];
    const shard = {
      status: () => ({ ok: true }),
      debugOracle: () => ({ schema: "successor.game-shard-oracle.v1", actors: {} }),
      checkpoint: async () => undefined,
      restockDebugActorLoadout: async (actorId: string) => {
        restocks.push(actorId);
        return {
          schema: "successor.debug-restock-loadout.v1",
          actorId,
          accepted: true,
          tick: 42,
          inventory: [{ container: `${actorId}:field-pack`, item: "Stimpak A", itemId: 1001, variantId: 0, quantity: 10, reserved: 0, available: 10 }],
        };
      },
    } as unknown as GameShard;
    await registerGameRoutes(appInstance, routeOptions(shard));

    const response = await appInstance.inject({
      method: "POST",
      url: "/game/debug/restock-loadout",
      payload: { actorId: "desert-warden-agent-lead-01" },
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({
      schema: "successor.debug-restock-loadout.v1",
      actorId: "desert-warden-agent-lead-01",
      accepted: true,
    });
    expect(restocks).toEqual(["desert-warden-agent-lead-01"]);
  });

  it("persists macro CRUD records and includes them in character load payloads", async () => {
    appInstance = Fastify();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "successor-routes-macro-api-"));
    tempDirs.push(dir);
    const characterStore = new CharacterStore(path.join(dir, "characters.json"), () => Date.parse("2026-07-06T00:10:00.000Z"));
    const shard = {
      status: () => ({ tick: 42, sessionCount: 0, actorCount: 0, shardId: "test-shard" }),
      characterLiveState: () => "offline",
      defaultJoinSpawnForActor: () => ({ areaId: "open-desert-overworld", x: 512, y: 512, facing: "front" }),
      characterJoinSpawnForActor: (_actorId: string, fallback?: { areaId: string; x: number; y: number; facing: string } | null) => fallback ?? { areaId: "open-desert-overworld", x: 512, y: 512, facing: "front" },
    } as unknown as GameShard;
    await registerGameRoutes(appInstance, { shard, characterStore });

    const created = await appInstance.inject({
      method: "POST",
      url: "/game/characters",
      payload: {
        name: "Macro",
        appearance: { skinTone: "#aabbcc", hair: "hair_crop2", hairMat: "hair_chestnut", face: null },
        initialProfessionId: "craftsman",
      },
    });
    const characterId = (created.json() as { id: string }).id;

    const emptyList = await appInstance.inject({ method: "GET", url: `/game/characters/${characterId}/macros` });
    expect(emptyList.statusCode).toBe(200);
    expect(emptyList.json()).toMatchObject({
      schema: successorMacrosRecordKind,
      characterId,
      record: { version: 1, items: [] },
      macros: [],
    });

    const oversized = await appInstance.inject({
      method: "POST",
      url: `/game/characters/${characterId}/macros`,
      payload: { id: "too_big", name: "Too Big", iconId: "macro:test", body: "x".repeat(successorMacroRecordBodyMaxBytes + 1) },
    });
    expect(oversized.statusCode).toBe(400);
    expect(oversized.json()).toMatchObject({ error: "invalid_macro" });

    const saved = await appInstance.inject({
      method: "POST",
      url: `/game/characters/${characterId}/macros`,
      payload: { id: "heal_self", name: "Heal Self", iconId: "macro:medic", body: "/target self\n/heal" },
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject({
      schema: successorMacrosRecordKind,
      macro: {
        id: "heal_self",
        name: "Heal Self",
        iconId: "macro:medic",
        body: "/target self\n/heal",
        createdAt: "2026-07-06T00:10:00.000Z",
        updatedAt: "2026-07-06T00:10:00.000Z",
      },
    });

    const characters = await appInstance.inject({ method: "GET", url: "/game/characters" });
    expect(characters.json().characters[0].recordKinds[successorMacrosRecordKind].items).toEqual([
      expect.objectContaining({ id: "heal_self", body: "/target self\n/heal" }),
    ]);

    const entered = await appInstance.inject({ method: "POST", url: `/game/characters/${characterId}/enter` });
    expect(entered.json().join.recordKinds[successorMacrosRecordKind].items).toEqual([
      expect.objectContaining({ id: "heal_self" }),
    ]);

    const deleted = await appInstance.inject({ method: "DELETE", url: `/game/characters/${characterId}/macros/heal_self` });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json().macros).toEqual([]);
  });

  it("rate-limits the macro CRUD route per character", async () => {
    appInstance = Fastify();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "successor-routes-macro-rate-"));
    tempDirs.push(dir);
    const characterStore = new CharacterStore(path.join(dir, "characters.json"));
    const shard = {
      status: () => ({ tick: 42, sessionCount: 0, actorCount: 0, shardId: "test-shard" }),
      characterLiveState: () => "offline",
      defaultJoinSpawnForActor: () => ({ areaId: "open-desert-overworld", x: 512, y: 512, facing: "front" }),
      characterJoinSpawnForActor: () => ({ areaId: "open-desert-overworld", x: 512, y: 512, facing: "front" }),
    } as unknown as GameShard;
    await registerGameRoutes(appInstance, { shard, characterStore });
    const created = await appInstance.inject({
      method: "POST",
      url: "/game/characters",
      payload: {
        name: "Budget",
        appearance: { skinTone: "#aabbcc", hair: "hair_crop2", hairMat: "hair_chestnut", face: null },
        initialProfessionId: "medic",
      },
    });
    const characterId = (created.json() as { id: string }).id;

    for (let index = 0; index < 20; index += 1) {
      const response = await appInstance.inject({ method: "GET", url: `/game/characters/${characterId}/macros` });
      expect(response.statusCode).toBe(200);
    }
    const limited = await appInstance.inject({ method: "GET", url: `/game/characters/${characterId}/macros` });
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toMatchObject({ error: "macro_rate_limited" });
    expect(limited.json().retryAfterMs).toBeGreaterThan(0);
  });

  it("Integration boot normal compiled entrypoint with manual clock + real Rust bridge and a batched 300-tick advance", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "successor-integration-test-"));
    tempDirs.push(tempDir);

    // Set env vars for manual clock, real Rust bridge and dev mode
    process.env.GAME_CLOCK = "manual";
    process.env.GAME_ALLOW_DEV_IDENTITY = "1";
    process.env.GAME_DEBUG_AUTHORITY_COMMANDS = "1";
    process.env.GAME_SHARD_PERSISTENCE = "0";
    process.env.GAME_CHARACTER_STORE_PATH = path.join(tempDir, "characters.json");
    process.env.LOG_LEVEL = "warn";
    // Match the default bridge launch profile before the request timeout starts.
    // Otherwise a previously built unoptimized artifact makes `cargo run`
    // rebuild inside the first live tick, turning artifact order into a false
    // authority timeout.
    buildRealRustAuthorityBridge();
    // Boot entrypoint
    appInstance = await createApp();

    // Get initial clock state
    const clockResponse = await appInstance.inject({
      method: "GET",
      url: "/game/debug/clock",
    });
    expect(clockResponse.statusCode).toBe(200);
    const initialClock = clockResponse.json() as { virtualNowMs: number; tick: number; mode: string };
    expect(initialClock.mode).toBe("manual");

    const requestedTicks = 300;

    // Advance enough ticks to prove that the real bridge batches manual time.
    const advanceResponse = await appInstance.inject({
      method: "POST",
      url: "/game/debug/clock/advance",
      payload: { ticks: requestedTicks },
    });

    expect(advanceResponse.statusCode).toBe(200);
    const advanceData = advanceResponse.json() as {
      mode: string;
      tick: number;
      virtualNowMs: number;
      advancedTicks: number;
      advancedMs: number;
      authorityBridgeRequests: number;
      authorityBridgeTicks: number;
      authorityBridgeBatchedRequests: number;
      authorityBridgeMaxTicksPerRequest: number;
    };

    // Assert exact delta for 30Hz virtual elapsed
    expect(advanceData.mode).toBe("manual");
    expect(advanceData.advancedTicks).toBe(requestedTicks);
    expect(advanceData.advancedMs).toBeCloseTo(10_000, 4);
    expect(advanceData.virtualNowMs).toBeCloseTo(initialClock.virtualNowMs + 10_000, 4);
    expect(advanceData.tick).toBe(initialClock.tick + requestedTicks);
    expect(advanceData.authorityBridgeRequests).toBe(1);
    expect(advanceData.authorityBridgeTicks).toBe(requestedTicks);
    expect(advanceData.authorityBridgeBatchedRequests).toBe(1);
    expect(advanceData.authorityBridgeMaxTicksPerRequest).toBe(requestedTicks);

    // Verify the clock state matches the advanced time
    const finalClockResponse = await appInstance.inject({
      method: "GET",
      url: "/game/debug/clock",
    });
    const finalClock = finalClockResponse.json() as { virtualNowMs: number; tick: number };
    expect(finalClock.virtualNowMs).toBeCloseTo(initialClock.virtualNowMs + 10_000, 4);
    expect(finalClock.tick).toBe(initialClock.tick + requestedTicks);
  }, 300_000);

  it("Test system mode 409, debug gate 403, and cap/invalid body failures", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "successor-integration-failures-"));
    tempDirs.push(tempDir);

    // --- Scenario 1: System Mode 409 ---
    process.env.GAME_CLOCK = "system";
    process.env.GAME_ALLOW_DEV_IDENTITY = "1";
    process.env.GAME_DEBUG_AUTHORITY_COMMANDS = "1";
    process.env.GAME_SHARD_PERSISTENCE = "0";
    process.env.GAME_CHARACTER_STORE_PATH = path.join(tempDir, "characters1.json");
    process.env.LOG_LEVEL = "warn";

    let localApp = await createApp();
    try {
      const response = await localApp.inject({
        method: "POST",
        url: "/game/debug/clock/advance",
        payload: { ticks: 1 },
      });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ error: "manual_clock_required", mode: "system" });
    } finally {
      await localApp.close();
    }

    // --- Scenario 2: Debug Gate 403 ---
    process.env.GAME_CLOCK = "manual";
    process.env.GAME_DEBUG_AUTHORITY_COMMANDS = "0";
    process.env.GAME_CHARACTER_STORE_PATH = path.join(tempDir, "characters2.json");

    localApp = await createApp();
    try {
      const response = await localApp.inject({
        method: "POST",
        url: "/game/debug/clock/advance",
        payload: { ticks: 1 },
      });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ error: "debug_authority_command_disabled" });
    } finally {
      await localApp.close();
    }

    // --- Scenario 3: Cap/Invalid Body 400 ---
    process.env.GAME_CLOCK = "manual";
    process.env.GAME_DEBUG_AUTHORITY_COMMANDS = "1";
    process.env.GAME_CHARACTER_STORE_PATH = path.join(tempDir, "characters3.json");

    localApp = await createApp();
    try {
      const resNegativeTicks = await localApp.inject({
        method: "POST",
        url: "/game/debug/clock/advance",
        payload: { ticks: -1 },
      });
      expect(resNegativeTicks.statusCode).toBe(400);

      const resTooLargeTicks = await localApp.inject({
        method: "POST",
        url: "/game/debug/clock/advance",
        payload: { ticks: 200001 },
      });
      expect(resTooLargeTicks.statusCode).toBe(400);

      const resNegativeMs = await localApp.inject({
        method: "POST",
        url: "/game/debug/clock/advance",
        payload: { ms: -1 },
      });
      expect(resNegativeMs.statusCode).toBe(400);

      const resInvalidBody = await localApp.inject({
        method: "POST",
        url: "/game/debug/clock/advance",
        payload: { ticks: "invalid" },
      });
      expect(resInvalidBody.statusCode).toBe(400);
    } finally {
      await localApp.close();
    }
  });

  it("proves bridge command/live timeouts remain real wall-clock under frozen manual time", async () => {
    const cwd = process.cwd();
    const repoRoot = path.basename(cwd) === "server" ? path.resolve(cwd, "..") : cwd;
    const slicePath = path.join(repoRoot, "client", "public", "successor-slice", "open-desert-slice.json");

    // Exception: Integration test exercising real wall-clock timeouts against the platform clock under frozen manual time.
    // We need a real delay to verify the global setTimeout fires when the manual clock is not advanced.
    const bridge = new RustAuthorityBridge({
      enabled: true,
      cwd: repoRoot,
      slicePath,
    });

    try {
      const promise = bridge.submitAiDebug({ timeoutMs: 1 });
      await expect(promise).rejects.toThrow("rust authority bridge request timed out");
    } finally {
      bridge.close();
    }
  });
});
