import Fastify from "fastify";
import websocket from "@fastify/websocket";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

import { ChatHub } from "./chat/hub.js";
import { configureTicketLogger } from "./auth/tickets.js";
import {
  AlphaControlStore,
  MIGRATIONS,
  controlSchemaHeadCanUpgrade,
  migrationChecksumForTests,
} from "./alpha/index.js";
import { registerAlphaRoutes } from "./alpha/http.js";
import { LaunchSessionRegistry, runtimeAuthConfigFromEnv } from "./auth/runtime.js";
import { registerChatRoutes } from "./chat/routes.js";
import { ManualClock, systemClock } from "./game/clock.js";
import { GameShard, gameSessionAdmissionCapFromEnv, slowConsumerBufferCapBytesFromEnv } from "./game/shard.js";
import { registerColyseusGameServer } from "./game/colyseusServer.js";
import { CharacterStore } from "./game/characterStore.js";
import { registerGameRoutes } from "./game/routes.js";
import { loadVerificationFixtureLoadouts } from "./game/verificationFixtureLoadout.js";
import { acquireHostedStateLock, hostedStateLockHealthy, releaseHostedStateLock, type HostedStateLockLease } from "./lifecycleSupervisor.js";
import { RuntimeHeartbeat, runtimeHeartbeatConfigFromEnv } from "./runtimeHeartbeat.js";

const PORT = Number(process.env.PORT ?? 28093);
const HOST = process.env.HOST ?? "127.0.0.1";

export interface RuntimeCloserHooks {
  stopHeartbeat: () => void;
  closeSessions: () => Promise<void>;
  closeShard: () => Promise<void>;
  closeDurableStores: () => void | Promise<void>;
}

export function createRuntimeCloser(hooks: RuntimeCloserHooks): () => Promise<void> {
  let closePromise: Promise<void> | undefined;
  return () => {
    closePromise ??= (async () => {
      let closeError: unknown;
      const attempt = async (operation: () => void | Promise<void>): Promise<void> => {
        try {
          await operation();
        } catch (error) {
          closeError ??= error;
        }
      };
      await attempt(hooks.stopHeartbeat);
      await attempt(hooks.closeSessions);
      await attempt(hooks.closeShard);
      await attempt(hooks.closeDurableStores);
      if (closeError) throw closeError;
    })();
    return closePromise;
  };
}

export async function createApp() {
  const runtimeAuth = runtimeAuthConfigFromEnv();
  const sessionRevocations = new LaunchSessionRegistry();
  const trustedProxyHops = runtimeAuth.mode === "standalone" ? positiveBoundedEnv("SUCCESSOR_ALPHA_TRUSTED_PROXY_HOPS", 0, 0, 8) : 0;
  const persistenceEnabled = !isDisabled(process.env.GAME_SHARD_PERSISTENCE);
  const durableStateDir = process.env.GAME_SHARD_STATE_DIR ?? path.join(repoRootPath(), "server", ".local-state");
  assertStandalonePersistenceEnabled(runtimeAuth.mode, persistenceEnabled);
  if (persistenceEnabled && !hostedStateLockHealthy()) throw new Error("hosted durable server requires the lifetime state lock before startup");
  if (runtimeAuth.mode === "standalone") assertStandaloneStateLayout(runtimeAuth.controlDbPath!, durableStateDir, runtimeAuth.shardId, persistenceEnabled);
  const controlStore = runtimeAuth.mode === "standalone"
    ? new AlphaControlStore({ dbPath: runtimeAuth.controlDbPath!, claimSecret: runtimeAuth.claimSecret!, requiredLegalVersions: alphaLegalVersionsFromEnv(), registrationOpen: process.env.SUCCESSOR_ALPHA_REGISTRATION_OPEN?.trim().toLowerCase() === "true", registrationCap: positiveBoundedEnv("SUCCESSOR_ALPHA_REGISTRATION_CAP", 64, 1, 10_000) })
    : undefined;
  const app = Fastify({
    trustProxy: trustedProxyHops,
    logger: {
      level: process.env.LOG_LEVEL ?? "info",
    },
  });

  await app.register(websocket);
  const gameShardId = runtimeAuth.shardId;
  const characterStore = new CharacterStore(characterStorePath());
  if (runtimeAuth.mode === "standalone") {
    const origin = process.env.SUCCESSOR_ALPHA_ORIGIN?.trim();
    const originPattern = process.env.NODE_ENV === "production" ? /^https:\/\/[^/]+$/u : /^https?:\/\/[^/]+$/u;
    if (!origin || !originPattern.test(origin)) throw new Error("SUCCESSOR_ALPHA_ORIGIN must be an exact origin");
    const requiredLegalVersions = alphaLegalVersionsFromEnv();
    const allowlist = runtimeAuth.acceptedClientReleaseIds ?? [runtimeAuth.clientReleaseId];
    const gameEndpoint = process.env.SUCCESSOR_ALPHA_GAME_ENDPOINT?.trim();
    const chatEndpoint = process.env.SUCCESSOR_ALPHA_CHAT_ENDPOINT?.trim();
    assertStandaloneSocketEndpoints(origin, gameEndpoint, chatEndpoint, process.env.NODE_ENV === "production");
    await registerAlphaRoutes(app, { controlStore: controlStore!, characterStore, sessionRevocations, origin, shardId: runtimeAuth.shardId, clientReleaseId: runtimeAuth.clientReleaseId, serverReleaseId: runtimeAuth.serverReleaseId, issuer: runtimeAuth.issuer, acceptedClientReleaseIds: allowlist, gameEndpoint, chatEndpoint, requiredLegalVersions, trustedProxyHops });
  }
  if (runtimeAuth.mode === "standalone") controlStore!.auditOwnerRefs(characterStore.ownerRefs());
  const gameSessionAdmissionCap = gameSessionAdmissionCapFromEnv();
  configureTicketLogger(app.log);
  let liveGuildIdForActor: (actorId: string) => string | null = () => null;
  let liveChatPositionForActor: (actorId: string) => { areaId: string; x: number; y: number } | null = () => null;
  const chatHub = new ChatHub({
    logger: app.log,
    social: characterStore,
    guildAuthority: {
      guildIdForActor: (actorId) => liveGuildIdForActor(actorId),
    },
    spatialAuthority: {
      positionForActor: (actorId) => liveChatPositionForActor(actorId),
    },
    localRadiusCells: numberEnv("CHAT_LOCAL_RADIUS_CELLS", 24),
    maxSessions: numberEnv("CHAT_MAX_SESSIONS", 10_000),
    maxSessionsPerUser: numberEnv("CHAT_MAX_SESSIONS_PER_USER", 4),
    maxPacketBytes: numberEnv("CHAT_MAX_PACKET_BYTES", 2_048),
    sessionRevocations,
  });
  // Validate durable identity records before starting either network surface.
  characterStore.list();
  await registerChatRoutes(app, { hub: chatHub, logger: app.log, runtimeAuth, controlStore, characterStore });
  const gameClock = process.env.GAME_CLOCK?.trim().toLowerCase() === "manual" ? new ManualClock() : systemClock;
  const verificationFixtureLoadouts = loadVerificationFixtureLoadouts();
  const gameShard = new GameShard({
    clock: gameClock,
    shardId: gameShardId,
    logger: app.log,
    slicePath: process.env.GAME_SLICE_PATH ?? defaultSlicePath(),
    mapBundlePath: process.env.GAME_MAP_BUNDLE_PATH ?? defaultMapBundlePath(),
    maxSessions: gameSessionAdmissionCap,
    maxPacketBytes: numberEnv("GAME_MAX_PACKET_BYTES", 65_536),
    slowConsumerBufferCapBytes: slowConsumerBufferCapBytesFromEnv(),
    sessionRevocations,
    areaInterestRadiusCells: numberEnv("GAME_AOI_RADIUS_CELLS", 192),
    snapshotIntervalMs: numberEnv("GAME_SNAPSHOT_INTERVAL_MS", 20),
    worldClock: {
      realSecondsPerGameDay: numberEnv("GAME_DAY_SECONDS", 300),
    },
    persistence: gameShardPersistenceOptions(gameShardId, runtimeAuth.mode === "standalone" ? controlStore!.schemaHead() : undefined),
    hasEnteredCharacters: characterStore.hasEnteredWorld(),
    verificationFixtureLoadouts,
    characterPersistence: {
      checkpointIntervalMs: numberEnv("GAME_CHARACTER_CHECKPOINT_SECONDS", 30) * 1000,
      hasCharacter: (characterId) => characterStore.hasId(characterId),
      claimWorldEntry: (characterId, ownerRef) => {
        const claimed = characterStore.claimWorldEntry(characterId, ownerRef);
        return claimed ? { returning: claimed.returning } : null;
      },
      saveSnapshot: (characterId, snapshot, options) => {
        characterStore.saveActorSnapshot(characterId, snapshot, {
          atMs: options.atMs,
          logout: options.logout,
          playMs: options.playMs,
        });
      },
      markSeen: (characterId, atMs) => {
        characterStore.markSeen(characterId, atMs);
      },
    },
    rustAuthorityBridge: {
      enabled: true,
      cwd: repoRootPath(),
    },
  });
  liveGuildIdForActor = (actorId) => gameShard.guildIdForActor(actorId);
  liveChatPositionForActor = (actorId) => gameShard.chatPositionForActor(actorId);
  await registerGameRoutes(app, {
    shard: gameShard,
    characterStore,
    clock: gameClock,
    onCharacterDeleted: (characterId) => chatHub.invalidateDeletedCharacter(characterId),
  });
  const colyseusServer = await registerColyseusGameServer(app, {
    shard: gameShard,
    characterStore,
    maxClients: gameSessionAdmissionCap,
    maxPayloadBytes: numberEnv("GAME_MAX_PACKET_BYTES", 65_536),
    runtimeAuth,
    controlStore,
    sessionRevocations,
  });
  const runtimeHeartbeat = new RuntimeHeartbeat({
    config: runtimeHeartbeatConfigFromEnv(),
    isReady: () => gameShard.status().readiness.ready,
    logger: {
      warn: (fields, message) => app.log.warn(fields, message),
      info: (fields, message) => app.log.info(fields, message),
    },
  });
  const closeRuntime = createRuntimeCloser({
    stopHeartbeat: () => runtimeHeartbeat.stop(),
    closeSessions: () => colyseusServer.gracefullyShutdown(false),
    closeShard: () => gameShard.close(),
    closeDurableStores: () => controlStore?.close(),
  });
  app.addHook("onReady", async () => {
    runtimeHeartbeat.start();
  });
  app.addHook("preClose", async () => {
    try {
      await closeRuntime();
    } catch (error) {
      app.log.error({ error }, "Successor runtime teardown failed before listener close");
    }
  });
  app.addHook("onClose", async () => {
    await closeRuntime();
  });

  app.get("/healthz", async () => ({ ok: true, ts: Date.now() }));


  app.get("/version", async () => ({
    name: "successor-server",
    version: process.env.npm_package_version ?? "0.0.1",
  }));

  // Future: /login and persistent shard routing move in front of the in-memory authority shard.
  return app;
}

function isCleanWsEndpoint(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === (process.env.NODE_ENV === "production" ? "wss:" : "ws:") || url.protocol === "wss:") && Boolean(url.hostname) && !url.username && !url.password && !url.search && !url.hash;
  } catch { return false; }
}

function positiveBoundedEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${name} is outside validated bounds`);
  return value;
}

function alphaLegalVersionsFromEnv(): Readonly<Record<string, string>> {
  const raw = process.env.SUCCESSOR_ALPHA_LEGAL_VERSIONS?.trim();
  if (!raw) return {};
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error("SUCCESSOR_ALPHA_LEGAL_VERSIONS must be a JSON object"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("SUCCESSOR_ALPHA_LEGAL_VERSIONS must be a JSON object");
  const output: Record<string, string> = {};
  for (const [name, version] of Object.entries(parsed)) {
    if (!/^[a-z][a-z0-9_-]{0,31}$/u.test(name) || typeof version !== "string" || version.length < 1 || version.length > 32) throw new Error("SUCCESSOR_ALPHA_LEGAL_VERSIONS contains invalid entry");
    output[name] = version;
  }
  return output;
}

function numberEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function defaultSlicePath(): string {
  return path.join(repoRootPath(), "client", "public", "successor-slice", "open-desert-slice.json");
}

function characterStorePath(): string {
  if (process.env.GAME_CHARACTER_STORE_PATH) return process.env.GAME_CHARACTER_STORE_PATH;
  if (!isDisabled(process.env.GAME_SHARD_PERSISTENCE)) {
    const stateDir = process.env.GAME_SHARD_STATE_DIR ?? path.join(repoRootPath(), "server", ".local-state");
    return path.join(stateDir, "characters.json");
  }
  return path.join(repoRootPath(), "server", "data", "characters.json");
}

function defaultMapBundlePath(): string {
  return path.join(repoRootPath(), "client", "public", "successor-slice", "open-desert-map-bundle.json");
}

function gameShardPersistenceOptions(shardId: string, controlSchemaHead?: { version: number; checksum: string }) {
  if (isDisabled(process.env.GAME_SHARD_PERSISTENCE)) return undefined;
  const stateDir = process.env.GAME_SHARD_STATE_DIR ?? path.join(repoRootPath(), "server", ".local-state");
  return {
    checkpointPath: process.env.GAME_SHARD_CHECKPOINT_PATH ?? path.join(stateDir, `${shardId}.checkpoint.json`),
    manifestPath: process.env.GAME_SHARD_MANIFEST_PATH ?? path.join(stateDir, "state-generation.manifest.json"),
    journalPath: process.env.GAME_SHARD_JOURNAL_PATH ?? path.join(stateDir, `${shardId}.journal.jsonl`),
    controlSchemaHead,
    checkpointIntervalMs: numberEnv("GAME_SHARD_CHECKPOINT_INTERVAL_MS", 5_000),
  };
}

export function assertStandaloneSocketEndpoints(origin: string, gameEndpoint: string | undefined, chatEndpoint: string | undefined, production: boolean): void {
  if (!gameEndpoint || !chatEndpoint || !isCleanWsEndpoint(gameEndpoint) || !isCleanWsEndpoint(chatEndpoint)) throw new Error("standalone game/chat endpoints must be clean ws/wss URLs");
  if (!production) return;
  const storefrontHostname = new URL(origin).hostname;
  const endpointHostnames = [new URL(gameEndpoint).hostname, new URL(chatEndpoint).hostname];
  if (endpointHostnames.some((hostname) => hostname === storefrontHostname)) throw new Error("standalone game/chat endpoints must not share the storefront hostname");
}

export function assertStandalonePersistenceEnabled(mode: "standalone" | "legacy", persistenceEnabled: boolean): void {
  if (mode === "standalone" && !persistenceEnabled) throw new Error("standalone mode requires durable shard persistence");
}

function isDisabled(value: string | undefined): boolean {
  return value === "0" || value === "false" || value === "off";
}

function repoRootPath(): string {
  const cwd = process.cwd();
  return path.basename(cwd) === "server" ? path.resolve(cwd, "..") : cwd;
}

async function main() {
  const persistenceEnabled = !isDisabled(process.env.GAME_SHARD_PERSISTENCE);
  let stateLock: HostedStateLockLease | undefined;
  if (persistenceEnabled) {
    const inheritedLease = hostedStateLockHealthy();
    if (!inheritedLease) {
      const stateDir = process.env.GAME_SHARD_STATE_DIR ?? path.join(repoRootPath(), "server", ".local-state");
      stateLock = await acquireHostedStateLock(stateDir, process.env.GAME_SHARD_LOCK_PATH ?? path.join(stateDir, ".desktop-state.lock"));
      process.env.GAME_STATE_LOCK_HELD = "1";
    }
    process.env.GAME_HOSTED_DURABILITY = "1";
  }
  const app = await createApp();
  await app.listen({ port: PORT, host: HOST });
  app.log.info(`Successor server listening on ${HOST}:${PORT}`);

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info({ signal }, "Successor server graceful shutdown requested");
    try {
      await app.close();
      await releaseHostedStateLock(stateLock);
      process.exit(0);
    } catch (error) {
      app.log.error({ error, signal }, "Successor server graceful shutdown failed");
      await releaseHostedStateLock(stateLock);
      process.exit(1);
    }
  };
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("SIGINT", () => void shutdown("SIGINT"));
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

function assertStandaloneStateLayout(controlDbPath: string, stateDir: string, shardId: string, persistenceEnabled: boolean): void {
  if (!persistenceEnabled) return;
  const root = path.resolve(stateDir);
  const control = path.resolve(controlDbPath);
  const paths = {
    control,
    character: characterStorePath(),
    checkpoint: process.env.GAME_SHARD_CHECKPOINT_PATH ?? path.join(root, `${shardId}.checkpoint.json`),
    journal: process.env.GAME_SHARD_JOURNAL_PATH ?? path.join(root, `${shardId}.journal.jsonl`),
    manifest: process.env.GAME_SHARD_MANIFEST_PATH ?? path.join(root, "state-generation.manifest.json"),
  };
  for (const [name, candidate] of Object.entries(paths)) {
    if (!isWithin(root, candidate)) throw new Error(`standalone ${name} path escapes the fenced state generation`);
  }
  const evidence = [paths.character, paths.checkpoint, paths.journal, paths.manifest].some((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).size > 0);
  if (evidence && (!fs.existsSync(control) || fs.statSync(control).size === 0 || !fs.readFileSync(control).subarray(0, 1024 * 1024).includes(Buffer.from("schema_migrations")))) {
    throw new Error("standalone control DB is missing, new, or unbound beside durable state");
  }
  if (fs.existsSync(paths.manifest)) {
    let manifest: unknown;
    try { manifest = JSON.parse(fs.readFileSync(paths.manifest, "utf8")); } catch { throw new Error("state generation manifest is corrupt"); }
    const expected = { version: MIGRATIONS.at(-1)!.version, checksum: migrationChecksumForTests(MIGRATIONS.at(-1)!) };
    const actual = manifest && typeof manifest === "object" && !Array.isArray(manifest) ? (manifest as { controlSchemaHead?: unknown }).controlSchemaHead : undefined;
    if (!controlSchemaHeadCanUpgrade(actual, expected)) {
      throw new Error("state generation manifest is not bound to a compatible control schema head");
    }
  }
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, path.resolve(candidate));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}
