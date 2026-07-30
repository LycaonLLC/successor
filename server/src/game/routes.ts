import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";

import { ManualClock, systemClock, type ShardClock } from "./clock.js";
import { clientCommandSchema } from "./protocol.js";
import { canonicalRecordKindPayloadEtag, characterSlotCap, successorMacrosRecordCaps, successorMacrosRecordKind, type CharacterStore, type SuccessorMacroRecord } from "./characterStore.js";
import { metricsPayloadFromStatus } from "./metrics.js";
import { GameShardCheckpointError, type GameShard, type GameShardDebugOracle } from "./shard.js";
import { devIdentityAllowed } from "./colyseusRoom.js";

export interface GameRoutesOptions {
  shard: GameShard;
  characterStore: CharacterStore;
  clock?: ShardClock;
  onCharacterDeleted?: (characterId: string) => void;
}

interface SpatialSpeechMessage {
  id: string;
  actorId: string;
  areaId: string;
  speaker: string;
  body: string;
  x: number;
  y: number;
  source: string;
  createdAt: string;
  expiresAt: string;
}

const spatialSpeechPostSchema = z.object({
  actorId: z.string().min(1).max(96),
  body: z.string().min(1).max(180),
  speaker: z.string().min(1).max(80).optional(),
  source: z.string().min(1).max(64).optional(),
  ttlMs: z.number().int().min(500).max(10_000).optional(),
});

const debugAuthorityCommandPostSchema = z.object({
  actorId: z.string().min(1).max(96),
  command: clientCommandSchema,
  commandId: z.number().int().positive().optional(),
});

const debugClockAdvancePostSchema = z.object({
  ticks: z.number().int().min(0).max(200_000).optional(),
  ms: z.number().min(0).optional(),
  toTick: z.number().int().min(0).optional(),
}).strict().refine(
  (value) => [value.ticks, value.ms, value.toTick].filter((candidate) => candidate !== undefined).length === 1,
  { message: "exactly one of ticks, ms, or toTick is required" },
);

const debugRestockLoadoutPostSchema = z.object({
  actorId: z.string().min(1).max(96),
});

const createCharacterPostSchema = z.object({
  name: z.unknown(),
  appearance: z.unknown(),
  worn: z.unknown().optional(),
  initialProfessionId: z.unknown(),
});

const selectInitialProfessionPostSchema = z.object({
  initialProfessionId: z.unknown(),
});

const enterCharacterParamsSchema = z.object({
  id: z.string().min(1).max(96),
});

const macroSavePostSchema = z.object({
  id: z.string().min(1).max(64).regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u),
  name: z.string().min(1).max(successorMacrosRecordCaps.maxNameCharacters).refine((value) => !hasControlCharacters(value)),
  iconId: z.string().min(1).max(successorMacrosRecordCaps.maxIconIdCharacters).regex(/^[A-Za-z0-9][A-Za-z0-9:_-]{0,63}$/u),
  body: z.string().refine((value) => Buffer.byteLength(value, "utf8") <= successorMacrosRecordCaps.maxBodyBytes),
}).strict();

const characterMacroParamsSchema = z.object({
  id: z.string().min(1).max(96),
});

const characterMacroItemParamsSchema = z.object({
  id: z.string().min(1).max(96),
  macroId: z.string().min(1).max(64).regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u),
});

const macroCrudRateLimitCapacity = 20;
const macroCrudRateLimitRefillPerMs = 10 / 60_000;
const debugClockMaxTicksPerRequest = 200_000;

export async function registerGameRoutes(app: FastifyInstance, options: GameRoutesOptions): Promise<void> {
  const { shard, characterStore, clock = systemClock, onCharacterDeleted } = options;
  const macroCrudRateLimitBuckets = new Map<string, MacroCrudRateLimitBucket>();
  const spatialSpeechMessages: SpatialSpeechMessage[] = [];
  const deterministicSpeechTimelineKeys = new Set<string>();
  const deterministicSpeechActorCooldowns = new Map<string, number>();
  let deterministicSpeechStartedAtTick: number | null = null;
  let deterministicSpeechLastAt = 0;
  let nextSpatialSpeechSeq = 1;
  const debugAuthorityCommandsEnabled = isEnabled(process.env.GAME_DEBUG_AUTHORITY_COMMANDS);
  const enqueueDeterministicSpeech = async () => {
    const oracle = await shard.debugOracle({ refreshAiDebug: false });
    if (deterministicSpeechStartedAtTick === null) {
      deterministicSpeechStartedAtTick = typeof oracle.tick === "number" ? oracle.tick : 0;
      for (const event of oracle.timelineEvents ?? []) {
        if (event.tick < deterministicSpeechStartedAtTick) deterministicSpeechTimelineKeys.add(timelineEventSpeechKey(event));
      }
    }
    const now = Date.now();
    for (const event of oracle.timelineEvents ?? []) {
      const key = timelineEventSpeechKey(event);
      if (deterministicSpeechTimelineKeys.has(key)) continue;
      deterministicSpeechTimelineKeys.add(key);
      const bark = deterministicBarkForTimelineEvent(event, oracle);
      if (!bark) continue;
      if (now - deterministicSpeechLastAt < 1_800) continue;
      if (now - (deterministicSpeechActorCooldowns.get(bark.actorId) ?? 0) < 7_000) continue;
      const actor = oracle.actors[bark.actorId];
      if (!actor || actor.lifeState !== "alive") continue;
      const ttlMs = spatialSpeechTtlMs(bark.body);
      spatialSpeechMessages.push({
        id: `spatial_speech_${nextSpatialSpeechSeq++}`,
        actorId: actor.id,
        areaId: actor.areaId,
        speaker: spatialSpeechSpeakerForActor(actor),
        body: bark.body,
        x: actor.x,
        y: actor.y,
        source: "deterministic-authority-bark",
        createdAt: new Date(now).toISOString(),
        expiresAt: new Date(now + ttlMs).toISOString(),
      });
      deterministicSpeechLastAt = now;
      deterministicSpeechActorCooldowns.set(actor.id, now);
      break;
    }
  };

  app.get("/game/status", async (_request, reply) => withDebugCors(reply).send(shard.status()));

  app.get("/readyz", async (_request, reply) => {
    const status = shard.status();
    return withDebugCors(reply).header("cache-control", "no-store").status(status.readiness.ready ? 200 : 503).send({
      schema: "successor.readiness.v1",
      ready: status.readiness.ready,
      checks: status.readiness,
    });
  });

  app.get("/metrics", async (_request, reply) => {
    const shardMetrics = (shard as { metrics?: () => Promise<unknown> }).metrics;
    const payload = typeof shardMetrics === "function"
      ? await shardMetrics.call(shard)
      : metricsPayloadFromStatus(shard.status());
    return withDebugCors(reply).send(payload);
  });

  app.options("/game/characters", async (_request, reply) => rejectNonDevHttp(reply) ?? withDebugCors(reply).status(204).send());

  app.get("/game/characters", async (_request, reply) => {
    const devOnly = rejectNonDevHttp(reply);
    if (devOnly) return devOnly;
    const status = shard.status();
    return withDebugCors(reply).send({
      server: {
        online: true,
        tick: status.tick,
        sessionCount: status.sessionCount,
        actorCount: status.actorCount,
        shardId: status.shardId,
      },
      characters: characterStore.list().map((record) => ({
        ...record,
        liveState: shard.characterLiveState(record.id),
      })),
      limits: {
        maxCharacters: characterSlotCap(),
      },
    });
  });

  app.post("/game/characters", async (request, reply) => {
    const devOnly = rejectNonDevHttp(reply);
    if (devOnly) return devOnly;
    const parsed = createCharacterPostSchema.safeParse(request.body);
    if (!parsed.success) {
      return withDebugCors(reply).status(400).send({ error: characterCreateSchemaError(request.body) });
    }
    const result = characterStore.create(parsed.data);
    if (result.ok) return withDebugCors(reply).status(201).send(result.record);
    const statusCode = result.error === "invalid_id" || result.error === "invalid_name" || result.error === "invalid_appearance" || result.error === "invalid_worn" || result.error === "invalid_initial_profession" ? 400 : 409;
    return withDebugCors(reply).status(statusCode).send({ error: result.error });
  });

  app.options("/game/characters/:id/initial-profession", async (_request, reply) => rejectNonDevHttp(reply) ?? withDebugCors(reply).status(204).send());

  app.put("/game/characters/:id/initial-profession", async (request, reply) => {
    const devOnly = rejectNonDevHttp(reply);
    if (devOnly) return devOnly;
    const params = enterCharacterParamsSchema.safeParse(request.params);
    if (!params.success) return withDebugCors(reply).status(404).send({ error: "character_not_found" });
    const parsed = selectInitialProfessionPostSchema.safeParse(request.body);
    if (!parsed.success) return withDebugCors(reply).status(400).send({ error: "invalid_initial_profession" });
    const result = characterStore.selectInitialProfession(params.data.id, parsed.data.initialProfessionId);
    if (result.ok) return withDebugCors(reply).send(result.record);
    const statusCode = result.error === "character_not_found" ? 404
      : result.error === "invalid_initial_profession" ? 400
      : 409;
    return withDebugCors(reply).status(statusCode).send({ error: result.error });
  });

  app.options("/game/characters/:id/enter", async (_request, reply) => rejectNonDevHttp(reply) ?? withDebugCors(reply).status(204).send());

  app.post("/game/characters/:id/enter", async (request, reply) => {
    const devOnly = rejectNonDevHttp(reply);
    if (devOnly) return devOnly;
    const params = enterCharacterParamsSchema.safeParse(request.params);
    if (!params.success) return withDebugCors(reply).status(404).send({ error: "character_not_found" });
    const record = characterStore.get(params.data.id);
    if (!record) return withDebugCors(reply).status(404).send({ error: "character_not_found" });
    if (!record.worldEntryClaimed && record.initialProfessionId === null) {
      return withDebugCors(reply).status(409).send({ error: "initial_profession_required" });
    }
    const liveState = shard.characterLiveState(record.id);
    const spawn = shard.characterJoinSpawnForActor(record.id, record.position);
    return withDebugCors(reply).send({
      ok: true,
      join: {
        player: record.ownerRef,
        actorId: record.id,
        name: record.name,
        spawnArea: spawn.areaId,
        spawnX: spawn.x,
        spawnY: spawn.y,
        facing: spawn.facing,
        appearance: record.appearance,
        worn: record.worn,
        recordKinds: record.recordKinds,
        liveState,
        takeover: liveState === "online",
        reconnect: liveState === "linkdead",
      },
    });
  });

  app.options("/game/characters/:id", async (_request, reply) => rejectNonDevHttp(reply) ?? withDebugCors(reply).status(204).send());

  app.delete("/game/characters/:id", async (request, reply) => {
    const devOnly = rejectNonDevHttp(reply);
    if (devOnly) return devOnly;
    const params = enterCharacterParamsSchema.safeParse(request.params);
    if (!params.success) return withDebugCors(reply).status(404).send({ error: "character_not_found" });
    const record = characterStore.get(params.data.id);
    if (!record) return withDebugCors(reply).status(404).send({ error: "character_not_found" });
    // A live session (or a link-dead actor still holding the world slot) owns
    // the character — deletion only applies to offline records.
    const liveState = shard.characterLiveState(record.id);
    if (liveState !== "offline") return withDebugCors(reply).status(409).send({ error: "character_online" });
    const hasAuthorityState = record.worldEntryClaimed !== false || shard.characterHasDurableAuthorityState(record.id);
    if (hasAuthorityState) return withDebugCors(reply).status(409).send({ error: "character_deletion_requires_retirement" });
    const removed = characterStore.delete(record.id);
    if (!removed) return withDebugCors(reply).status(404).send({ error: "character_not_found" });
    onCharacterDeleted?.(removed.id);
    return withDebugCors(reply).send({ ok: true, deleted: { id: removed.id, name: removed.name } });
  });

  app.options("/game/characters/:id/macros", async (_request, reply) => rejectNonDevHttp(reply) ?? withDebugCors(reply).status(204).send());

  app.get("/game/characters/:id/macros", async (request, reply) => {
    const devOnly = rejectNonDevHttp(reply);
    if (devOnly) return devOnly;
    const params = characterMacroParamsSchema.safeParse(request.params);
    if (!params.success) return withDebugCors(reply).status(404).send({ error: "character_not_found" });
    const rateLimit = consumeMacroCrudRateLimit(macroCrudRateLimitBuckets, `macros:${params.data.id}`);
    if (!rateLimit.ok) return withDebugCors(reply).status(429).send({ error: "macro_rate_limited", retryAfterMs: rateLimit.retryAfterMs });
    const payload = characterStore.recordKindPayload<SuccessorMacroRecord>(params.data.id, successorMacrosRecordKind);
    if (!payload) return withDebugCors(reply).status(404).send({ error: "character_not_found" });
    return sendMacroRecordPayload(reply, params.data.id, payload);
  });

  app.post("/game/characters/:id/macros", async (request, reply) => {
    const devOnly = rejectNonDevHttp(reply);
    if (devOnly) return devOnly;
    const params = characterMacroParamsSchema.safeParse(request.params);
    if (!params.success) return withDebugCors(reply).status(404).send({ error: "character_not_found" });
    const rateLimit = consumeMacroCrudRateLimit(macroCrudRateLimitBuckets, `macros:${params.data.id}`);
    if (!rateLimit.ok) return withDebugCors(reply).status(429).send({ error: "macro_rate_limited", retryAfterMs: rateLimit.retryAfterMs });
    const parsed = macroSavePostSchema.safeParse(request.body);
    if (!parsed.success) {
      return withDebugCors(reply).status(400).send({
        error: "invalid_macro",
        issues: parsed.error.issues.map((issue) => ({ path: issue.path, message: issue.message })),
      });
    }
    const result = characterStore.saveRecordKindItem<SuccessorMacroRecord>(
      params.data.id,
      successorMacrosRecordKind,
      parsed.data,
    );
    if (!result.ok) return sendMacroRecordError(reply, result.error);
    return sendMacroRecordPayload(reply, params.data.id, result.payload, result.item, result.etag);
  });

  app.options("/game/characters/:id/macros/:macroId", async (_request, reply) => rejectNonDevHttp(reply) ?? withDebugCors(reply).status(204).send());

  app.delete("/game/characters/:id/macros/:macroId", async (request, reply) => {
    const devOnly = rejectNonDevHttp(reply);
    if (devOnly) return devOnly;
    const params = characterMacroItemParamsSchema.safeParse(request.params);
    if (!params.success) return withDebugCors(reply).status(400).send({ error: "invalid_macro_id" });
    const rateLimit = consumeMacroCrudRateLimit(macroCrudRateLimitBuckets, `macros:${params.data.id}`);
    if (!rateLimit.ok) return withDebugCors(reply).status(429).send({ error: "macro_rate_limited", retryAfterMs: rateLimit.retryAfterMs });
    const result = characterStore.deleteRecordKindItem<SuccessorMacroRecord>(
      params.data.id,
      successorMacrosRecordKind,
      params.data.macroId,
    );
    if (!result.ok) return sendMacroRecordError(reply, result.error);
    if (!result.deleted) return withDebugCors(reply).status(404).send({ error: "macro_not_found" });
    return sendMacroRecordPayload(reply, params.data.id, result.payload, undefined, result.etag);
  });

  app.get("/game/debug/clock", async (_request, reply) => {
    const devOnly = rejectNonDevHttp(reply);
    if (devOnly) return devOnly;
    if (!debugAuthorityCommandsEnabled) {
      return withDebugCors(reply).status(403).send({
        error: "debug_authority_command_disabled",
        enableWith: "GAME_DEBUG_AUTHORITY_COMMANDS=1",
      });
    }
    const status = shard.status();
    return withDebugCors(reply).send({
      schema: "successor.debug-clock.v1",
      mode: clock.mode,
      virtualNowMs: clock.nowMs(),
      tick: status.tick,
    });
  });

  app.options("/game/debug/clock/advance", async (_request, reply) => rejectNonDevHttp(reply) ?? withDebugCors(reply).status(204).send());

  app.post("/game/debug/clock/advance", async (request, reply) => {
    const devOnly = rejectNonDevHttp(reply);
    if (devOnly) return devOnly;
    if (!debugAuthorityCommandsEnabled) {
      return withDebugCors(reply).status(403).send({
        error: "debug_authority_command_disabled",
        enableWith: "GAME_DEBUG_AUTHORITY_COMMANDS=1",
      });
    }
    if (clock.mode !== "manual") {
      return withDebugCors(reply).status(409).send({ error: "manual_clock_required", mode: clock.mode });
    }
    const manualClock = clock as ManualClock;

    const parsed = debugClockAdvancePostSchema.safeParse(request.body);
    if (!parsed.success) {
      return withDebugCors(reply).status(400).send({
        error: "invalid_debug_clock_advance",
        issues: parsed.error.issues.map((issue) => ({ path: issue.path, message: issue.message })),
      });
    }

    await shard.settleForDebug();
    const before = shard.status();
    const beforeNowMs = clock.nowMs();
    const authorityIntervalMs = before.authority.cadence.authorityIntervalMs;
    if (!Number.isFinite(authorityIntervalMs) || authorityIntervalMs <= 0) {
      return withDebugCors(reply).status(500).send({ error: "invalid_authority_interval" });
    }

    let requestedTicks: number | undefined;
    if (parsed.data.ticks !== undefined) {
      requestedTicks = parsed.data.ticks;
    } else if (parsed.data.toTick !== undefined) {
      requestedTicks = parsed.data.toTick - before.tick;
      if (requestedTicks < 0) {
        return withDebugCors(reply).status(400).send({
          error: "debug_clock_target_tick_in_past",
          tick: before.tick,
          toTick: parsed.data.toTick,
        });
      }
      if (requestedTicks > debugClockMaxTicksPerRequest) {
        return withDebugCors(reply).status(400).send({
          error: "debug_clock_advance_too_large",
          maxTicks: debugClockMaxTicksPerRequest,
        });
      }
    }

    let debugAdvanceStats = {
      authorityBridgeRequests: 0,
      authorityBridgeTicks: 0,
      authorityBridgeBatchedRequests: 0,
      authorityBridgeMaxTicksPerRequest: 0,
    };
    const settle = () => shard.settleForDebug();
    if (requestedTicks !== undefined) {
      if (requestedTicks > 0) {
        const advanceMs = requestedTicks * authorityIntervalMs;
        const roundingSlackMs = authorityIntervalMs / 1_000_000;
        shard.beginDebugClockAdvance(requestedTicks);
        try {
          await manualClock.advance(advanceMs + roundingSlackMs, { settle });
        } finally {
          debugAdvanceStats = shard.endDebugClockAdvance();
        }
      }
    } else {
      const advanceMs = parsed.data.ms ?? 0;
      if (Math.ceil(advanceMs / authorityIntervalMs) > debugClockMaxTicksPerRequest) {
        return withDebugCors(reply).status(400).send({
          error: "debug_clock_advance_too_large",
          maxTicks: debugClockMaxTicksPerRequest,
        });
      }
      await manualClock.advance(advanceMs, { settle });
    }

    const after = shard.status();
    const expectedTick = requestedTicks === undefined ? undefined : before.tick + requestedTicks;
    if (expectedTick !== undefined && after.tick !== expectedTick) {
      return withDebugCors(reply).status(409).send({
        error: "debug_clock_tick_target_not_reached",
        expectedTick,
        tick: after.tick,
        virtualNowMs: clock.nowMs(),
      });
    }
    return withDebugCors(reply).send({
      schema: "successor.debug-clock-advance.v1",
      mode: clock.mode,
      tick: after.tick,
      virtualNowMs: clock.nowMs(),
      advancedTicks: after.tick - before.tick,
      advancedMs: clock.nowMs() - beforeNowMs,
      authorityBridgeRequests: debugAdvanceStats.authorityBridgeRequests,
      authorityBridgeTicks: debugAdvanceStats.authorityBridgeTicks,
      authorityBridgeBatchedRequests: debugAdvanceStats.authorityBridgeBatchedRequests,
      authorityBridgeMaxTicksPerRequest: debugAdvanceStats.authorityBridgeMaxTicksPerRequest,
      stateHashAvailable: typeof after.persistence.stateHash === "string" && after.persistence.stateHash.length > 0,
    });
  });

  app.get("/game/debug/oracle", async (request, reply) => {
    const devOnly = rejectNonDevHttp(reply);
    if (devOnly) return devOnly;
    const query = request.query as { freshAiDebug?: string; awaitAiDebug?: string };
    const awaitAiDebug = query.freshAiDebug === "1" || query.awaitAiDebug === "1";
    return withDebugCors(reply).send(await shard.debugOracle({ awaitAiDebug }));
  });

  app.options("/game/debug/checkpoint", async (_request, reply) => rejectNonDevHttp(reply) ?? withDebugCors(reply).status(204).send());

  app.post("/game/debug/checkpoint", async (_request, reply) => {
    const devOnly = rejectNonDevHttp(reply);
    if (devOnly) return devOnly;
    try {
      return withDebugCors(reply).send(await shard.checkpoint("debug"));
    } catch (error) {
      app.log.warn({ error }, "debug game shard checkpoint failed");
      const code = error instanceof GameShardCheckpointError ? error.code : "checkpoint_failed";
      return withDebugCors(reply).status(code === "persistence_disabled" ? 409 : 500).send({ error: code });
    }
  });

  app.options("/game/debug/reset-fixture", async (_request, reply) => rejectNonDevHttp(reply) ?? withDebugCors(reply).status(204).send());

  app.post("/game/debug/reset-fixture", async (_request, reply) => {
    const devOnly = rejectNonDevHttp(reply);
    if (devOnly) return devOnly;
    const result = await shard.resetDebugFixture();
    if (result.accepted) await shard.checkpoint("debug-reset");
    return withDebugCors(reply).status(result.accepted ? 202 : 500).send(result);
  });

  app.options("/game/debug/authority-command", async (_request, reply) => rejectNonDevHttp(reply) ?? withDebugCors(reply).status(204).send());

  app.post("/game/debug/authority-command", async (request, reply) => {
    const devOnly = rejectNonDevHttp(reply);
    if (devOnly) return devOnly;
    if (!debugAuthorityCommandsEnabled) {
      return withDebugCors(reply).status(403).send({
        error: "debug_authority_command_disabled",
        enableWith: "GAME_DEBUG_AUTHORITY_COMMANDS=1",
      });
    }

    const parsed = debugAuthorityCommandPostSchema.safeParse(request.body);
    if (!parsed.success) {
      return withDebugCors(reply).status(400).send({
        error: "invalid_debug_authority_command",
        issues: parsed.error.issues.map((issue) => ({ path: issue.path, message: issue.message })),
      });
    }

    const result = await shard.submitDebugAuthorityCommand(parsed.data.actorId, parsed.data.command, parsed.data.commandId);
    if (result.receipt.accepted) await shard.checkpoint("debug");
    return withDebugCors(reply).status(202).send({
      schema: "successor.debug-authority-command.v1",
      actorId: result.actorId,
      commandId: result.commandId,
      commandKind: result.commandKind,
      receipt: result.receipt,
      eventCount: result.events.length,
      events: result.events,
    });
  });

  app.options("/game/debug/restock-loadout", async (_request, reply) => rejectNonDevHttp(reply) ?? withDebugCors(reply).status(204).send());

  app.post("/game/debug/restock-loadout", async (request, reply) => {
    const devOnly = rejectNonDevHttp(reply);
    if (devOnly) return devOnly;
    const parsed = debugRestockLoadoutPostSchema.safeParse(request.body);
    if (!parsed.success) {
      return withDebugCors(reply).status(400).send({
        error: "invalid_debug_restock_loadout",
        issues: parsed.error.issues.map((issue) => ({ path: issue.path, message: issue.message })),
      });
    }

    const result = await shard.restockDebugActorLoadout(parsed.data.actorId);
    if (result.accepted) await shard.checkpoint("debug-restock");
    return withDebugCors(reply).status(result.accepted ? 202 : 404).send(result);
  });

  app.options("/game/debug/spatial-speech", async (_request, reply) => rejectNonDevHttp(reply) ?? withDebugCors(reply).status(204).send());

  app.get("/game/debug/spatial-speech", async (_request, reply) => {
    const devOnly = rejectNonDevHttp(reply);
    if (devOnly) return devOnly;
    await enqueueDeterministicSpeech();
    pruneSpatialSpeechMessages(spatialSpeechMessages);
    return withDebugCors(reply).send({
      schema: "successor.debug-spatial-speech.v1",
      messages: spatialSpeechMessages,
    });
  });

  app.post("/game/debug/spatial-speech", async (request, reply) => {
    const devOnly = rejectNonDevHttp(reply);
    if (devOnly) return devOnly;
    const parsed = spatialSpeechPostSchema.safeParse(request.body);
    if (!parsed.success) {
      return withDebugCors(reply).status(400).send({
        error: "invalid_spatial_speech",
        issues: parsed.error.issues.map((issue) => ({ path: issue.path, message: issue.message })),
      });
    }

    const oracle = await shard.debugOracle({ refreshAiDebug: false });
    const actor = oracle.actors[parsed.data.actorId];
    if (!actor) {
      return withDebugCors(reply).status(404).send({ error: "actor_not_found" });
    }
    if (actor.lifeState !== "alive") {
      return withDebugCors(reply).status(409).send({ error: "actor_not_alive", lifeState: actor.lifeState });
    }

    const now = Date.now();
    const ttlMs = parsed.data.ttlMs ?? spatialSpeechTtlMs(parsed.data.body);
    const body = normalizeSpatialSpeechBody(parsed.data.body);
    if (!body) {
      return withDebugCors(reply).status(400).send({ error: "empty_spatial_speech" });
    }

    const message: SpatialSpeechMessage = {
      id: `spatial_speech_${nextSpatialSpeechSeq++}`,
      actorId: actor.id,
      areaId: actor.areaId,
      speaker: spatialSpeechSpeakerForActor(actor),
      body,
      x: actor.x,
      y: actor.y,
      source: normalizeSpatialSpeechBody(parsed.data.source ?? "debug").slice(0, 64) || "debug",
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + ttlMs).toISOString(),
    };
    spatialSpeechMessages.push(message);
    pruneSpatialSpeechMessages(spatialSpeechMessages);
    return withDebugCors(reply).status(201).send({
      schema: "successor.debug-spatial-speech-post.v1",
      message,
    });
  });
}

interface MacroCrudRateLimitBucket {
  tokens: number;
  updatedAt: number;
}

type MacroCrudRateLimitResult = { ok: true } | { ok: false; retryAfterMs: number };

function consumeMacroCrudRateLimit(
  buckets: Map<string, MacroCrudRateLimitBucket>,
  key: string,
  now = Date.now(),
): MacroCrudRateLimitResult {
  const bucket = buckets.get(key) ?? { tokens: macroCrudRateLimitCapacity, updatedAt: now };
  const elapsedMs = Math.max(0, now - bucket.updatedAt);
  const tokens = Math.min(macroCrudRateLimitCapacity, bucket.tokens + elapsedMs * macroCrudRateLimitRefillPerMs);
  if (tokens < 1) {
    bucket.tokens = tokens;
    bucket.updatedAt = now;
    buckets.set(key, bucket);
    return { ok: false, retryAfterMs: Math.ceil((1 - tokens) / macroCrudRateLimitRefillPerMs) };
  }
  bucket.tokens = tokens - 1;
  bucket.updatedAt = now;
  buckets.set(key, bucket);
  return { ok: true };
}

function sendMacroRecordPayload(
  reply: FastifyReply,
  characterId: string,
  payload: { version: number; items: SuccessorMacroRecord[] },
  macro?: SuccessorMacroRecord,
  etag?: string,
): FastifyReply {
  const token = etag ?? canonicalRecordKindPayloadEtag(payload);
  return withDebugCors(reply)
    .header("etag", `"${token}"`)
    .send({
    schema: successorMacrosRecordKind,
    characterId,
    recordKind: successorMacrosRecordKind,
    record: payload,
    etag: token,
    caps: {
      maxItems: successorMacrosRecordCaps.maxItems,
      maxBodyBytes: successorMacrosRecordCaps.maxBodyBytes,
      maxNameCharacters: successorMacrosRecordCaps.maxNameCharacters,
      maxIconIdCharacters: successorMacrosRecordCaps.maxIconIdCharacters,
    },
    macros: payload.items,
    ...(macro ? { macro } : {}),
  });
}

function sendMacroRecordError(reply: FastifyReply, error: string): FastifyReply {
  switch (error) {
    case "character_not_found":
      return withDebugCors(reply).status(404).send({ error: "character_not_found" });
    case "record_limit_exceeded":
      return withDebugCors(reply).status(409).send({ error: "macro_limit_exceeded" });
    case "record_too_large":
    case "payload_too_large":
      return withDebugCors(reply).status(413).send({ error: "macro_too_large" });
    case "invalid_record":
      return withDebugCors(reply).status(400).send({ error: "invalid_macro" });
    default:
      return withDebugCors(reply).status(500).send({ error: "macro_record_kind_unavailable" });
  }
}

function withDebugCors(reply: FastifyReply): FastifyReply {
  return reply
    .header("Access-Control-Allow-Origin", "*")
    .header("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS")
    .header("Access-Control-Allow-Headers", "Content-Type");
}

function rejectNonDevHttp(reply: FastifyReply): FastifyReply | null {
  return devIdentityAllowed()
    ? null
    : withDebugCors(reply).status(404).send({ error: "not_found" });
}

function isEnabled(value: string | undefined): boolean {
  return value === "1" || value === "true";
}

function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

function characterCreateSchemaError(body: unknown): "invalid_character_request" | "invalid_initial_profession" {
  if (body !== null
    && typeof body === "object"
    && !Array.isArray(body)
    && Object.hasOwn(body, "name")
    && Object.hasOwn(body, "appearance")
    && !Object.hasOwn(body, "initialProfessionId")) {
    return "invalid_initial_profession";
  }
  return "invalid_character_request";
}

function normalizeSpatialSpeechBody(value: string): string {
  return [...value]
    .map((character) => {
      const code = character.charCodeAt(0);
      return code <= 31 || code === 127 ? " " : character;
    })
    .join("")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 180);
}

function spatialSpeechTtlMs(body: string): number {
  return Math.min(7_000, Math.max(1_800, normalizeSpatialSpeechBody(body).length * 80));
}

function spatialSpeechSpeakerForActor(actor: { id: string; label: string }): string {
  return normalizeSpatialSpeechBody(actor.label).slice(0, 80) || actor.id;
}

interface DeterministicSpatialBark {
  actorId: string;
  speaker: string;
  body: string;
}

function timelineEventSpeechKey(event: { tick: number; label: string }): string {
  return `${event.tick}:${event.label}`;
}

function deterministicBarkForTimelineEvent(
  event: GameShardDebugOracle["timelineEvents"][number],
  oracle: GameShardDebugOracle,
): DeterministicSpatialBark | null {
  const label = normalizeSpatialSpeechBody(event.label);
  const actorId = label.split(/\s+/u)[0] ?? "";
  const actor = oracle.actors[actorId];
  if (!actor || actor.factionId !== "desert_wardens") return null;
  const lower = label.toLowerCase();
  let body: string | null = null;
  if (lower.includes("crafted") && lower.includes("45 acp")) body = "Ammo batch ready.";
  else if (lower.includes("crafted") && lower.includes("stimpak")) body = "Stims cooked and ready.";
  else if (lower.includes("crafted") && lower.includes("tool")) body = "Tool finished. Check storage.";
  else if (lower.includes("sampled") && (lower.includes("iron") || lower.includes("mineral"))) body = "Iron vein is paying out.";
  else if (lower.includes("harvested") && lower.includes("bone")) body = "Bone harvested. Processing next.";
  else if (lower.includes("processed") && lower.includes("powder")) body = "Clod powder processed.";
  else if (lower.includes("looted") && lower.includes("45 acp")) body = "Ammo pulled from the corpse.";
  else if (lower.includes(" stored ")) body = "Supplies are in the vault.";
  else if (lower.includes(" retrieved ")) body = "Resupplied. Back on line.";
  else if (lower.includes(" trained ") || lower.includes("auto-trained")) body = skillTrainingBarkBody(lower);
  if (!body) return null;
  return {
    actorId: actor.id,
    speaker: normalizeSpatialSpeechBody(actor.label).slice(0, 80) || actor.id,
    body,
  };
}

function skillTrainingBarkBody(label: string): string | null {
  const skillBoxId = label.match(/\b(?:auto-trained|trained)\s+([a-z0-9-]+)/u)?.[1] ?? "";
  if (!skillBoxId) return "New skill learned.";
  const profession = skillBoxId.split("-")[0] ?? "";
  if (skillBoxId.endsWith("-novice")) return `${professionLabel(profession)} basics learned.`;
  if (skillBoxId.endsWith("-master")) return `${professionLabel(profession)} mastered.`;
  if (skillBoxId.includes("marksman-rifle")) return "Rifle training improved.";
  if (skillBoxId.includes("scout-creature-harvesting")) return "Harvesting training improved.";
  if (skillBoxId.includes("scout-sprinting")) return "Sprint training improved.";
  if (skillBoxId.includes("scout-traversal")) return "Traversal training improved.";
  if (skillBoxId.includes("medic-medical-crafting")) return "Medical crafting improved.";
  if (skillBoxId.includes("medic-medicine-use")) return "Medicine use improved.";
  if (skillBoxId.includes("medic-medicine-speed")) return "Faster treatment learned.";
  if (skillBoxId.includes("medic-trauma")) return "Trauma care improved.";
  if (skillBoxId.includes("brawler-melee")) return "Melee training improved.";
  return "New skill learned.";
}

function professionLabel(professionId: string): string {
  switch (professionId) {
    case "marksman":
      return "Marksman";
    case "scout":
      return "Scout";
    case "craftsman":
      return "Craftsman";
    case "medic":
      return "Medic";
    case "brawler":
      return "Brawler";
    default:
      return "Profession";
  }
}

function pruneSpatialSpeechMessages(messages: SpatialSpeechMessage[]): void {
  const now = Date.now();
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (Date.parse(messages[index]!.expiresAt) <= now) {
      messages.splice(index, 1);
    }
  }
  if (messages.length > 32) {
    messages.splice(0, messages.length - 32);
  }
}
