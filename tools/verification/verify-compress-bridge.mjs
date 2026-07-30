#!/usr/bin/env node
import dns from "node:dns/promises";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const requireFromServer = createRequire(path.join(repoRoot, "server", "package.json"));
const { Client: ColyseusClient } = await import(requireFromServer.resolve("@colyseus/sdk"));
const { default: Redis } = await import(requireFromServer.resolve("ioredis"));
const { default: postgres } = await import(requireFromServer.resolve("postgres"));

const compressRoot = path.resolve(process.env.COMPRESS_MAIN_ROOT ?? path.join(repoRoot, "..", "compress", "ComPressMain"));
const databaseUrl = process.env.COMPRESS_BRIDGE_DATABASE_URL ?? "postgres://compress:compress_secret@127.0.0.1:5435/successor_dev";
const redisUrl = process.env.COMPRESS_BRIDGE_REDIS_URL ?? "redis://:redis_secret@127.0.0.1:6381";
const storeDomain = process.env.COMPRESS_BRIDGE_STORE_DOMAIN ?? "successor.localhost";
const runtimeSecret = process.env.SUCCESSOR_RUNTIME_SECRET ?? "compress-bridge-runtime-secret-local-proof";
const runId = safeRunId(process.env.COMPRESS_BRIDGE_RUN_ID ?? `compress-bridge-${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${Math.random().toString(36).slice(2, 8)}`);
const customerEmail = `compress-bridge-proof-${runId}@localhost.dev`;
const characterName = process.env.COMPRESS_BRIDGE_CHARACTER_NAME ?? "Proofrunner";
const forbiddenPorts = new Set([28093, 5179, 18192, 3000, 5174]);
const startedAt = new Date();
const startedMs = performance.now();
const artifactDir = path.join(repoRoot, "verification", "ledgers", "artifacts", "compress-bridge", runId);
const transcript = [];
const managedProcesses = [];
const tempFiles = [];
const inheritedEnv = sanitizedInheritedEnv(process.env);
let apiPort = null;
let gamePort = null;
let apiProcess = null;
let gameProcess = null;
let settingsRestore = null;
let finalStatus = "fail";

class CookieJar {
  constructor() {
    this.cookies = new Map();
  }

  capture(headers) {
    const values = typeof headers.getSetCookie === "function"
      ? headers.getSetCookie()
      : splitSetCookie(headers.get("set-cookie"));
    for (const value of values) {
      const [pair] = value.split(";", 1);
      const index = pair.indexOf("=");
      if (index <= 0) continue;
      this.cookies.set(pair.slice(0, index), pair.slice(index + 1));
    }
  }

  headers(extra = {}) {
    const headers = { ...extra };
    const cookie = [...this.cookies.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
    if (cookie) headers.Cookie = cookie;
    return headers;
  }

  names() {
    return [...this.cookies.keys()].sort();
  }
}

await fs.mkdir(artifactDir, { recursive: true });

try {
  await assertPath(path.join(compressRoot, "packages", "core", "package.json"), "ComPress core package");
  await assertPath(path.join(repoRoot, "server", "package.json"), "Successor server package");

  const resolution = await resolveStoreHost(storeDomain);
  step("host-resolution", "pass", {
    host: storeDomain,
    addresses: resolution,
    decision: "Use SUCCESSOR_SITE_URL with successor.localhost so fetch carries the tenant Host; bind ComPress API on :: because this host resolves successor.localhost to ::1 first.",
  });

  apiPort = await allocatePort(Number(process.env.COMPRESS_BRIDGE_API_PORT ?? 3100), "::");
  forbiddenPorts.add(apiPort);
  gamePort = await allocatePort(Number(process.env.COMPRESS_BRIDGE_GAME_PORT ?? 28500), "127.0.0.1");
  forbiddenPorts.add(gamePort);

  const splitDbEnv = deriveSplitDatabaseEnv(databaseUrl);
  const compressEnv = {
    ...inheritedEnv,
    NODE_ENV: process.env.NODE_ENV === "production" ? "development" : (process.env.NODE_ENV ?? "development"),
    DATABASE_URL: databaseUrl,
    ...splitDbEnv,
    REDIS_URL: redisUrl,
    JWT_SECRET: process.env.JWT_SECRET ?? "compress-bridge-jwt-secret-000000000000",
    JWT_REFRESH_SECRET: process.env.JWT_REFRESH_SECRET ?? "compress-bridge-refresh-secret-0000000000",
    CSRF_SECRET: process.env.CSRF_SECRET ?? "compress-bridge-csrf-secret-00000000000",
    BACKGROUND_WORKERS_ENABLED: "false",
    RUNTIME_CONTROL_BACKGROUND_WORKER_ENABLED: "false",
    PLATFORM_TENANT_BILLING_BACKGROUND_WORKER_ENABLED: "false",
    PLATFORM_HOSTS: process.env.PLATFORM_HOSTS ?? "platform.localhost",
    SMTP_HOST: process.env.SMTP_HOST ?? "127.0.0.1",
    SMTP_PORT: process.env.SMTP_PORT ?? "1025",
    SUCCESSOR_RUNTIME_SECRET: runtimeSecret,
    SUCCESSOR_GAME_WS_URL: `ws://127.0.0.1:${gamePort}`,
    SUCCESSOR_STORE_DOMAIN: storeDomain,
  };

  const seedResult = runCommand("seed-successor-store", "pnpm", ["--filter", "@compress/core", "exec", "tsx", path.join(compressRoot, "plugins", "successor", "scripts", "seed-successor-store.ts")], {
    cwd: compressRoot,
    env: compressEnv,
    timeoutMs: 120_000,
  });
  const seed = parseLastJsonObject(seedResult.stdout);
  assert(seed?.ok === true, "seed-successor-store did not return ok=true", seed);
  assert(seed.domain === storeDomain, `seeded domain ${seed.domain} did not match ${storeDomain}`);
  assert(seed.storeId, "seed did not return storeId");
  assert(Array.isArray(seed.plans) && seed.plans.some((plan) => plan.name === "3 Character Slots"), "seed did not include the 3 Character Slots plan", seed.plans);
  step("seed-successor-store", "pass", {
    storeId: seed.storeId,
    domain: seed.domain,
    planCount: seed.plans.length,
    threeSlotPlanId: seed.plans.find((plan) => plan.name === "3 Character Slots")?.id,
  });

  const domainRow = await ensureTenantDomainRow(seed.storeId, storeDomain);
  step("ensure-store-domain-routing", "pass", domainRow);

  const settingsNormalization = await temporarilyNormalizeStoreSettingsForProof(seed.storeId);
  step("ensure-store-settings-bootable", "pass", settingsNormalization);

  const apiLogPath = path.join(artifactDir, "compress-api.log");
  apiProcess = startManagedProcess("compress-api", "pnpm", ["--filter", "@compress/core", "dev"], {
    cwd: compressRoot,
    env: {
      ...compressEnv,
      PORT: String(apiPort),
      HOST: "::",
    },
    logPath: apiLogPath,
  });
  await waitForHttpJson(`http://[::1]:${apiPort}/health`, { timeoutMs: 90_000 });
  step("boot-compress-api", "pass", {
    port: apiPort,
    host: "::",
    command: "pnpm --filter @compress/core dev",
    cwd: compressRoot,
    logPath: relativeToRepoOrAbsolute(apiLogPath),
    env: summarizeEnv({
      NODE_ENV: compressEnv.NODE_ENV,
      DATABASE_URL: databaseUrl,
      DATABASE_APP_URL: splitDbEnv.DATABASE_APP_URL,
      DATABASE_EXTENSION_URL: splitDbEnv.DATABASE_EXTENSION_URL,
      DATABASE_PLATFORM_URL: splitDbEnv.DATABASE_PLATFORM_URL,
      REDIS_URL: redisUrl,
      PORT: String(apiPort),
      HOST: "::",
      SUCCESSOR_RUNTIME_SECRET: runtimeSecret,
      SUCCESSOR_GAME_WS_URL: `ws://127.0.0.1:${gamePort}`,
      BACKGROUND_WORKERS_ENABLED: "false",
    }),
  });

  const apiBase = `http://${storeDomain}:${apiPort}`;
  const cookieJar = new CookieJar();
  let csrf = await getCsrf(apiBase, cookieJar);
  step("csrf", "pass", { cookieNames: cookieJar.names(), tokenBytes: csrf.length });

  const startAuth = await apiJson(apiBase, "/api/v1/auth/email/start", {
    method: "POST",
    cookieJar,
    csrf,
    body: { email: customerEmail, returnTo: "/account" },
  });
  assertStatus(startAuth, 202, "passwordless email start");
  const challengeId = startAuth.body.challengeId;
  assert(typeof challengeId === "string" && challengeId.length > 0, "passwordless start did not return challengeId", startAuth.body);
  const passwordlessCode = await readPasswordlessCodeFromRedis({ storeId: seed.storeId, email: customerEmail });
  const verifyAuth = await apiJson(apiBase, "/api/v1/auth/email/verify", {
    method: "POST",
    cookieJar,
    csrf,
    body: { challengeId, code: passwordlessCode },
  });
  assertStatus(verifyAuth, 200, "passwordless email verify");
  const accessToken = verifyAuth.body?.tokens?.accessToken;
  const customerId = verifyAuth.body?.user?.id;
  assert(typeof accessToken === "string" && accessToken.length > 20, "passwordless verify did not return access token", verifyAuth.body);
  assert(typeof customerId === "string" && customerId.length > 0, "passwordless verify did not return user id", verifyAuth.body);
  step("customer-passwordless-http-login", "pass", {
    email: customerEmail,
    userId: customerId,
    challengeId,
    isNewUser: verifyAuth.body.isNewUser,
    cookieNames: cookieJar.names(),
  });
  csrf = await getCsrf(apiBase, cookieJar);
  step("csrf-post-login", "pass", { cookieNames: cookieJar.names(), tokenBytes: csrf.length });

  const subscription = await createSubscriptionThroughComPressService({
    compressEnv,
    storeId: seed.storeId,
    email: customerEmail,
  });
  assert(subscription.ok === true, "subscription setup did not return ok=true", subscription);
  assert(subscription.summary?.access === true, "subscription summary did not grant successor.access", subscription.summary);
  assert(subscription.summary?.characterSlots === 3, "subscription summary did not grant 3 slots", subscription.summary);
  assert(subscription.entitlements?.access?.length >= 1, "missing successor.access entitlement row", subscription.entitlements);
  assert(subscription.entitlements?.slots?.some((row) => Number(row.metadata?.characterSlots) === 3), "missing successor.slots entitlement metadata characterSlots=3", subscription.entitlements);
  step("subscription-service-grant", "pass", {
    subscriptionId: subscription.subscriptionId,
    productId: subscription.productId,
    planId: subscription.planId,
    planName: subscription.planName,
    billingEngine: "local",
    entitlementRows: {
      access: subscription.entitlements.access.length,
      slots: subscription.entitlements.slots.length,
      slotMetadata: subscription.entitlements.slots.map((row) => row.metadata),
    },
    summary: subscription.summary,
  });

  const bootstrap = await apiJson(apiBase, "/api/v1/storefront/successor/bootstrap", {
    method: "GET",
    cookieJar,
    accessToken,
  });
  assertStatus(bootstrap, 200, "successor bootstrap");
  assert(bootstrap.body.authenticated === true, "bootstrap did not authenticate customer", bootstrap.body);
  assert(bootstrap.body.limits?.maxCharacters === 3, "bootstrap limits.maxCharacters was not 3", bootstrap.body);
  const profileId = bootstrap.body.profile?.id;
  assert(typeof profileId === "string" && profileId.length > 0, "bootstrap did not return profile id", bootstrap.body.profile);
  step("storefront-bootstrap", "pass", {
    authenticated: bootstrap.body.authenticated,
    profileId,
    maxCharacters: bootstrap.body.limits.maxCharacters,
    existingCharacters: bootstrap.body.characters?.length ?? null,
  });

  const created = await apiJson(apiBase, "/api/v1/storefront/successor/characters", {
    method: "POST",
    cookieJar,
    csrf,
    accessToken,
    body: { name: characterName },
  });
  assertStatus(created, 201, "create Successor character");
  const character = created.body.character;
  assert(character?.name === characterName, `created character name was not ${characterName}`, character);
  assert(typeof character.id === "string" && character.id.length > 0, "created character did not return id", character);
  step("storefront-create-character", "pass", {
    characterId: character.id,
    name: character.name,
    slotIndex: character.slotIndex,
  });

  const ticketResponse = await apiJson(apiBase, "/api/v1/storefront/successor/session-ticket", {
    method: "POST",
    cookieJar,
    csrf,
    accessToken,
    body: { characterId: character.id },
  });
  assertStatus(ticketResponse, 200, "mint session ticket");
  const ticket = ticketResponse.body.ticket;
  assert(typeof ticket === "string" && /^[A-Fa-f0-9_-]{32,160}$/u.test(ticket), "session-ticket response did not return a valid ticket", ticketResponse.body);
  assert(typeof ticketResponse.body.wsUrl === "string" && ticketResponse.body.wsUrl.includes(String(gamePort)), "session-ticket response wsUrl did not point at the proof game port", ticketResponse.body);
  assert(new Date(ticketResponse.body.expiresAt).getTime() > Date.now(), "session-ticket response expiresAt was not in the future", ticketResponse.body);
  step("storefront-mint-session-ticket", "pass", {
    ticketLength: ticket.length,
    wsUrl: ticketResponse.body.wsUrl,
    expiresAt: ticketResponse.body.expiresAt,
  });

  const characterStorePath = path.join(artifactDir, "game-characters.json");
  const gameLogPath = path.join(artifactDir, "successor-game.log");
  const bridgeBin = await existingRustBridgeBin();
  const gameEnv = {
    ...inheritedEnv,
    PORT: String(gamePort),
    HOST: "127.0.0.1",
    LOG_LEVEL: process.env.LOG_LEVEL ?? "warn",
    SUCCESSOR_SITE_URL: `http://${storeDomain}:${apiPort}`,
    SUCCESSOR_RUNTIME_SECRET: runtimeSecret,
    GAME_ALLOW_DEV_IDENTITY: "0",
    GAME_CHARACTER_STORE_PATH: characterStorePath,
    GAME_SHARD_PERSISTENCE: "0",
    GAME_RUST_AUTHORITY_BRIDGE_BIN: bridgeBin,
  };
  gameProcess = startManagedProcess("successor-game", "pnpm", ["--dir", "server", "exec", "tsx", "src/index.ts"], {
    cwd: repoRoot,
    env: gameEnv,
    logPath: gameLogPath,
  });
  await waitForHttpJson(`http://127.0.0.1:${gamePort}/healthz`, { timeoutMs: 90_000 });
  step("boot-successor-game", "pass", {
    port: gamePort,
    host: "127.0.0.1",
    command: "pnpm --dir server exec tsx src/index.ts",
    cwd: repoRoot,
    logPath: relativeToRepoOrAbsolute(gameLogPath),
    env: summarizeEnv({
      PORT: String(gamePort),
      HOST: "127.0.0.1",
      SUCCESSOR_SITE_URL: `http://${storeDomain}:${apiPort}`,
      SUCCESSOR_RUNTIME_SECRET: runtimeSecret,
      GAME_ALLOW_DEV_IDENTITY: "0",
      GAME_CHARACTER_STORE_PATH: characterStorePath,
      GAME_SHARD_PERSISTENCE: "0",
      GAME_RUST_AUTHORITY_BRIDGE_BIN: bridgeBin,
    }),
    hostOverride: "No explicit Host header support exists in server/src/auth/tickets.ts; SUCCESSOR_SITE_URL uses successor.localhost so fetch naturally carries Host successor.localhost to ComPress.",
  });

  const colyseus = new ColyseusClient(`http://127.0.0.1:${gamePort}`);
  const room = await colyseus.joinOrCreate("game", { ticket });
  const hello = await waitForGameHello(room);
  assert(hello.playerActorId === character.id.toLowerCase(), "game hello actor id did not match ComPress character id", { playerActorId: hello.playerActorId, characterId: character.id });
  const helloActor = hello.snapshot?.actors?.[hello.playerActorId];
  const actorDisplayName = helloActor?.displayName ?? helloActor?.display_name ?? helloActor?.label;
  assert(actorDisplayName === characterName, `game hello actor display name was not ${characterName}`, helloActor);
  const persistedRecord = await waitForCharacterStoreRecord(characterStorePath, character.id.toLowerCase(), profileId);
  assert(persistedRecord.name === characterName, "game character store record did not preserve display name", persistedRecord);
  assert(persistedRecord.ownerRef === profileId, "game character store ownerRef did not match ComPress profileId", { ownerRef: persistedRecord.ownerRef, profileId });
  step("game-ticket-join", "pass", {
    roomId: room.roomId ?? room.id,
    sessionId: room.sessionId,
    actorId: hello.playerActorId,
    displayName: actorDisplayName,
    ownerRef: persistedRecord.ownerRef,
    profileId,
    characterStorePath: relativeToRepoOrAbsolute(characterStorePath),
  });

  const reusedTicket = await expectJoinRejected(colyseus, { ticket }, {
    label: "same ticket reuse",
    expectedReason: "invalid launch ticket",
    expectedCloseCode: 1008,
  });
  step("game-rejects-reused-ticket", "pass", reusedTicket);

  const unticketed = await expectJoinRejected(colyseus, { playerId: "dev-bypass-proof" }, {
    label: "unticketed dev identity",
    expectedReason: "dev identity disabled",
    expectedCloseCode: 1008,
  });
  step("game-rejects-unticketed-join", "pass", unticketed);

  await room.leave(true);
  finalStatus = "pass";
} catch (error) {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  step("fatal", "fail", { error: message });
  process.exitCode = 1;
} finally {
  await teardown();
  const completedAt = new Date();
  const report = {
    schema: "successor.compress-bridge-proof.v1",
    status: finalStatus,
    runId,
    startedAt: startedAt.toISOString(),
    completedAt: completedAt.toISOString(),
    durationMs: round(performance.now() - startedMs),
    ports: { compressApi: apiPort, successorGame: gamePort },
    store: { domain: storeDomain },
    customer: { email: customerEmail },
    transcript,
  };
  const reportPath = path.join(artifactDir, "report.json");
  const transcriptPath = path.join(artifactDir, "transcript.txt");
  await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await fs.writeFile(transcriptPath, renderTranscript(report), "utf8");
  console.log(renderTranscript(report));
  console.log(`Artifacts: ${relativeToRepoOrAbsolute(reportPath)}, ${relativeToRepoOrAbsolute(transcriptPath)}`);
}

function step(name, status, details = {}) {
  transcript.push({ at: new Date().toISOString(), step: name, status, details });
}

function safeRunId(value) {
  return value.replace(/[^a-zA-Z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 96) || `compress-bridge-${Date.now()}`;
}

async function assertPath(target, label) {
  try {
    await fs.access(target);
  } catch {
    throw new Error(`${label} not found at ${target}`);
  }
}

async function resolveStoreHost(host) {
  const addresses = await dns.lookup(host, { all: true, verbatim: true });
  return addresses.map((entry) => `${entry.address}/${entry.family}`).sort();
}

async function allocatePort(start, host) {
  for (let port = Math.max(1, start); port < 65535; port += 1) {
    if (forbiddenPorts.has(port)) continue;
    if (await canListen(port, host)) return port;
  }
  throw new Error(`no free port available at or above ${start} for ${host}`);
}

function canListen(port, host) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.listen({ port, host }, () => {
      server.close(() => resolve(true));
    });
  });
}

async function ensureTenantDomainRow(storeId, domain) {
  const sql = postgres(databaseUrl, { max: 1 });
  try {
    const existing = await sql`
      SELECT id::text, store_id::text, normalized_host, status, ownership_status, dns_status, cert_status, is_primary
      FROM store_domains
      WHERE normalized_host = lower(${domain})
        AND removed_at IS NULL
      LIMIT 1
    `;
    if (existing.length > 0) {
      const row = existing[0];
      if (row.store_id !== storeId) {
        throw new Error(`store_domains row for ${domain} belongs to ${row.store_id}, expected ${storeId}`);
      }
      const [updated] = await sql`
        UPDATE store_domains
        SET status = 'active',
            ownership_status = 'managed',
            dns_status = 'managed',
            cert_status = CASE WHEN cert_status IN ('failed', 'revoked', 'expired') THEN 'not_requested' ELSE cert_status END,
            is_primary = true,
            redirect_to_primary = false,
            updated_at = now()
        WHERE id = ${row.id}::uuid
        RETURNING id::text, store_id::text, normalized_host, status, ownership_status, dns_status, cert_status, is_primary
      `;
      return { ...updated, action: "updated" };
    }
    const [inserted] = await sql`
      INSERT INTO store_domains (
        store_id,
        domain,
        normalized_host,
        domain_type,
        role,
        status,
        ownership_status,
        dns_status,
        cert_status,
        is_primary,
        redirect_to_primary,
        primary_since,
        metadata
      )
      VALUES (
        ${storeId}::uuid,
        ${domain},
        lower(${domain}),
        'hosted_subdomain',
        'primary',
        'active',
        'managed',
        'managed',
        'not_requested',
        true,
        false,
        now(),
        ${JSON.stringify({ proof: "successor-compress-bridge" })}::jsonb
      )
      RETURNING id::text, store_id::text, normalized_host, status, ownership_status, dns_status, cert_status, is_primary
    `;
    return { ...inserted, action: "inserted" };
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function temporarilyNormalizeStoreSettingsForProof(storeId) {
  const sql = postgres(databaseUrl, { max: 1 });
  try {
    const [row] = await sql`
      SELECT settings
      FROM stores
      WHERE id = ${storeId}::uuid
      LIMIT 1
    `;
    if (!row) throw new Error(`store ${storeId} not found while normalizing settings`);
    const settings = row.settings ?? {};
    const presentation = settings?.site?.storefront?.presentation;
    const supportedPresentations = new Set(["default", "retro95", "nerv-terminal", "weyland-yutani", "crayon-kids", "jrpg-quest", "giga-lab"]);
    if (presentation === undefined || supportedPresentations.has(presentation)) {
      return { changed: false, presentation: presentation ?? null };
    }
    const normalized = structuredClone(settings);
    normalized.site = normalized.site && typeof normalized.site === "object" ? normalized.site : {};
    normalized.site.storefront = normalized.site.storefront && typeof normalized.site.storefront === "object"
      ? normalized.site.storefront
      : {};
    normalized.site.storefront.presentation = "default";
    settingsRestore = { storeId, settings };
    await sql`
      UPDATE stores
      SET settings = ${JSON.stringify(normalized)}::jsonb
      WHERE id = ${storeId}::uuid
    `;
    await clearSettingsCache(storeId);
    return {
      changed: true,
      reason: "local dev store had a presentation enum unsupported by this ComPress backend; normalized only for this proof and will restore during teardown",
      originalPresentation: presentation,
      temporaryPresentation: "default",
    };
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function restoreStoreSettingsAfterProof() {
  if (!settingsRestore) return null;
  const snapshot = settingsRestore;
  settingsRestore = null;
  const sql = postgres(databaseUrl, { max: 1 });
  try {
    await sql`
      UPDATE stores
      SET settings = ${JSON.stringify(snapshot.settings)}::jsonb
      WHERE id = ${snapshot.storeId}::uuid
    `;
    await clearSettingsCache(snapshot.storeId);
    return { restored: true, storeId: snapshot.storeId };
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function clearSettingsCache(storeId) {
  const redis = new Redis(redisUrl, { lazyConnect: true, maxRetriesPerRequest: 1 });
  try {
    await redis.connect();
    await redis.del(`settings:${storeId}`);
  } finally {
    await redis.quit().catch(() => undefined);
  }
}

function sanitizedInheritedEnv(source) {
  const output = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    // Some local shells export docker-compose-style placeholders literally
    // (for example "${PLATFORM_AI_DEFAULT_REASONING_EFFORT:-medium}").
    // ComPress validates every present env var strictly, so drop placeholders
    // from the proof process instead of letting unrelated local shell state
    // poison this cross-system seam check.
    if (value.includes("${")) continue;
    output[key] = value;
  }
  return output;
}

function deriveSplitDatabaseEnv(baseUrl) {
  const roles = {
    DATABASE_APP_URL: "compress_app",
    DATABASE_EXTENSION_URL: "compress_extension",
    DATABASE_PLATFORM_URL: "compress_platform",
  };
  const output = {};
  for (const [key, role] of Object.entries(roles)) {
    if (process.env[key]) {
      output[key] = process.env[key];
      continue;
    }
    const url = new URL(baseUrl);
    url.username = role;
    output[key] = url.toString();
  }
  return output;
}

function runCommand(label, command, args, options) {
  const started = performance.now();
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    timeout: options.timeoutMs ?? 60_000,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  const record = {
    command: [command, ...args].join(" "),
    cwd: options.cwd,
    exitCode: result.status,
    durationMs: round(performance.now() - started),
    stdoutTail: tail(result.stdout ?? ""),
    stderrTail: tail(result.stderr ?? ""),
  };
  if (result.status !== 0) {
    step(label, "fail", record);
    throw new Error(`${label} failed with exit ${result.status}\n${record.stdoutTail}\n${record.stderrTail}`);
  }
  return { ...record, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function parseLastJsonObject(output) {
  const trimmed = output.trim();
  const start = trimmed.lastIndexOf("{");
  if (start < 0) throw new Error(`no JSON object found in command output: ${tail(output)}`);
  for (let index = start; index >= 0; index = trimmed.lastIndexOf("{", index - 1)) {
    try {
      return JSON.parse(trimmed.slice(index));
    } catch {
      // Keep scanning backward; pnpm wrappers can prepend non-JSON lines.
    }
  }
  throw new Error(`failed to parse JSON object from command output: ${tail(output)}`);
}

function startManagedProcess(label, command, args, options) {
  const logFd = fsSync.openSync(options.logPath, "a");
  fsSync.writeSync(logFd, `\n--- ${new Date().toISOString()} ${label}: ${command} ${args.join(" ")} ---\n`);
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    detached: true,
    stdio: ["ignore", logFd, logFd],
  });
  child.once("exit", () => {
    try { fsSync.closeSync(logFd); } catch { /* already closed */ }
  });
  child.once("error", () => {
    try { fsSync.closeSync(logFd); } catch { /* already closed */ }
  });
  managedProcesses.push({ label, child, logPath: options.logPath });
  return child;
}

async function waitForHttpJson(url, { timeoutMs }) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(1500) });
      if (response.ok) return await response.json();
      lastError = new Error(`${url} returned ${response.status}: ${await response.text()}`);
    } catch (error) {
      lastError = error;
    }
    await delay(500);
  }
  throw new Error(`timed out waiting for ${url}: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

async function getCsrf(apiBase, cookieJar) {
  const response = await fetch(`${apiBase}/api/v1/auth/csrf`, { headers: cookieJar.headers({ Accept: "application/json" }) });
  cookieJar.capture(response.headers);
  if (!response.ok) throw new Error(`csrf failed ${response.status}: ${await response.text()}`);
  const body = await response.json();
  if (typeof body.token !== "string") throw new Error(`csrf response missing token: ${JSON.stringify(body)}`);
  return body.token;
}

async function apiJson(apiBase, requestPath, options) {
  const headers = {
    Accept: "application/json",
    "Content-Type": "application/json",
  };
  if (options.csrf) headers["x-csrf-token"] = options.csrf;
  if (options.accessToken) headers.Authorization = `Bearer ${options.accessToken}`;
  const response = await fetch(`${apiBase}${requestPath}`, {
    method: options.method,
    headers: options.cookieJar.headers(headers),
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: AbortSignal.timeout(options.timeoutMs ?? 15_000),
  });
  options.cookieJar.capture(response.headers);
  const text = await response.text();
  let body = null;
  if (text.trim()) {
    try {
      body = JSON.parse(text);
    } catch {
      body = { raw: text };
    }
  }
  return { status: response.status, body, headers: response.headers };
}

function assertStatus(response, status, label) {
  assert(response.status === status, `${label} returned ${response.status}, expected ${status}`, response.body);
}

async function readPasswordlessCodeFromRedis({ storeId, email }) {
  const redis = new Redis(redisUrl, { lazyConnect: true, maxRetriesPerRequest: 1 });
  try {
    await redis.connect();
    const key = `email:queue:${storeId}`;
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const jobs = await redis.lrange(key, 0, -1);
      for (const raw of jobs.slice().reverse()) {
        let job;
        try { job = JSON.parse(raw); } catch { continue; }
        if (job?.storeId !== storeId) continue;
        if (job?.data?.email !== email) continue;
        if (typeof job.data.code === "string" && /^\d{6}$/u.test(job.data.code)) {
          return job.data.code;
        }
      }
      await delay(250);
    }
    throw new Error(`no passwordless code appeared in Redis queue ${key} for ${email}`);
  } finally {
    await redis.quit().catch(() => undefined);
  }
}

async function createSubscriptionThroughComPressService({ compressEnv, storeId, email }) {
  const scriptPath = path.join(compressRoot, "packages", "core", `.compress-bridge-setup-${process.pid}-${Date.now()}.ts`);
  tempFiles.push(scriptPath);
  const script = `
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import * as schema from './src/db/schema.js';
import { HookRegistry } from './src/hooks/registry.js';
import { registerSubscriptionEntitlementHooks } from '../../plugins/subscriptions/src/entitlement-hooks.js';
import { createSubscription } from '../../plugins/subscriptions/src/service.js';
import { resolveEntitlementSummary, SUCCESSOR_ACCESS_REF, SUCCESSOR_SLOTS_REF } from '../../plugins/successor/src/entitlement-summary.js';

const DATABASE_URL = process.env.DATABASE_URL!;
const storeId = process.env.PROOF_STORE_ID!;
const email = process.env.PROOF_CUSTOMER_EMAIL!;
const characterName = process.env.PROOF_CHARACTER_NAME!;
const sql = postgres(DATABASE_URL, { max: 3 });
const db = drizzle(sql, { schema }) as any;
const hooks = new HookRegistry({ info() {}, warn() {}, error() {} } as any);
registerSubscriptionEntitlementHooks(db, hooks as any);
try {
  const [store] = await db.select().from(schema.stores).where(eq(schema.stores.id, storeId)).limit(1);
  if (!store) throw new Error('store not found');
  const [user] = await db.select().from(schema.users).where(and(eq(schema.users.storeId, storeId), eq(schema.users.email, email))).limit(1);
  if (!user) throw new Error('customer user not found');

  const staleCharacterRows = await sql\`
    UPDATE successor_characters sc
    SET status = 'deleted', slot_index = -1000, updated_at = now()
    FROM successor_profiles sp
    JOIN users u ON u.id = sp.user_id
    WHERE sc.profile_id = sp.id
      AND sc.store_id = \${storeId}::uuid
      AND sc.canonical_name = lower(\${characterName})
      AND sc.status = 'active'
      AND u.email LIKE 'compress-bridge-proof-%@localhost.dev'
    RETURNING sc.id::text AS id
  \`;
  await sql\`
    DELETE FROM successor_character_name_reservations nr
    USING successor_characters sc
    JOIN successor_profiles sp ON sp.id = sc.profile_id
    JOIN users u ON u.id = sp.user_id
    WHERE nr.store_id = \${storeId}::uuid
      AND nr.canonical_name = lower(\${characterName})
      AND nr.character_id = sc.id
      AND u.email LIKE 'compress-bridge-proof-%@localhost.dev'
  \`;

  const [product] = await db.select().from(schema.products).where(and(eq(schema.products.storeId, storeId), eq(schema.products.slug, 'successor-access'))).limit(1);
  if (!product) throw new Error('successor-access product not found');
  const [plan] = await db.select().from(schema.productPlans).where(and(eq(schema.productPlans.storeId, storeId), eq(schema.productPlans.productId, product.id), eq(schema.productPlans.name, '3 Character Slots'))).limit(1);
  if (!plan) throw new Error('3 Character Slots plan not found');
  const periodStart = new Date();
  const periodEnd = new Date(periodStart.getTime() + 30 * 24 * 60 * 60 * 1000);
  const subscription = await createSubscription(db, hooks as any, {
    storeId,
    userId: user.id,
    productId: product.id,
    planId: plan.id,
    billingEngine: 'local',
    intervalUnit: plan.intervalUnit ?? 'month',
    intervalCount: plan.intervalCount ?? 1,
    amount: plan.amount,
    currency: plan.currency,
    quantity: 1,
    initialStatus: 'active',
    currentPeriodStart: periodStart,
    currentPeriodEnd: periodEnd,
    nextBillingDate: periodEnd,
    metadata: { proof: 'successor-compress-bridge', runId: process.env.PROOF_RUN_ID ?? null },
  });
  const rows = await db.select({
    id: schema.entitlements.id,
    resourceRef: schema.entitlements.resourceRef,
    metadata: schema.entitlements.metadata,
    activeUntil: schema.entitlements.activeUntil,
  }).from(schema.entitlements).where(and(
    eq(schema.entitlements.storeId, storeId),
    eq(schema.entitlements.userId, user.id),
    eq(schema.entitlements.source, 'subscription'),
    eq(schema.entitlements.sourceId, subscription.id),
    eq(schema.entitlements.resourceKind, 'feature'),
    inArray(schema.entitlements.resourceRef, [SUCCESSOR_ACCESS_REF, SUCCESSOR_SLOTS_REF]),
    isNull(schema.entitlements.revokedAt),
  ));
  const summary = await resolveEntitlementSummary(db, storeId, user.id);
  console.log(JSON.stringify({
    ok: true,
    storeId,
    userId: user.id,
    subscriptionId: subscription.id,
    productId: product.id,
    planId: plan.id,
    planName: plan.name,
    staleProofCharactersDeleted: staleCharacterRows.length,
    entitlements: {
      access: rows.filter((row: any) => row.resourceRef === SUCCESSOR_ACCESS_REF),
      slots: rows.filter((row: any) => row.resourceRef === SUCCESSOR_SLOTS_REF),
    },
    summary,
  }, null, 2));
} finally {
  await sql.end({ timeout: 5 });
}
`;
  await fs.writeFile(scriptPath, script, "utf8");
  const result = runCommand("subscription-service-setup", "pnpm", ["--filter", "@compress/core", "exec", "tsx", scriptPath], {
    cwd: compressRoot,
    env: {
      ...compressEnv,
      PROOF_STORE_ID: storeId,
      PROOF_CUSTOMER_EMAIL: email,
      PROOF_CHARACTER_NAME: characterName,
      PROOF_RUN_ID: runId,
    },
    timeoutMs: 120_000,
  });
  return parseLastJsonObject(result.stdout);
}

async function existingRustBridgeBin() {
  const candidates = [
    path.join(repoRoot, "target", "debug", "examples", "authority_bridge_server"),
    path.join(repoRoot, "target", "release", "examples", "authority_bridge_server"),
  ];
  for (const candidate of candidates) {
    try {
      await fs.access(candidate, fsSync.constants.X_OK);
      return candidate;
    } catch {
      // try next
    }
  }
  return "";
}

async function waitForGameHello(room) {
  const packets = [];
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for game.hello; packets=${JSON.stringify(packets.slice(-5))}`)), 20_000);
    room.onMessage("game.packet", (packet) => {
      packets.push(packet);
      if (packet?.type === "game.hello") {
        clearTimeout(timer);
        resolve(packet);
      }
    });
    room.send("game.ready");
  });
}

async function waitForCharacterStoreRecord(characterStorePath, characterId, ownerRef) {
  const deadline = Date.now() + 10_000;
  let last = null;
  while (Date.now() < deadline) {
    try {
      const raw = await fs.readFile(characterStorePath, "utf8");
      const parsed = JSON.parse(raw);
      last = parsed;
      const record = parsed.characters?.find((candidate) => candidate.id === characterId && candidate.ownerRef === ownerRef);
      if (record) return record;
    } catch {
      // file may not exist yet
    }
    await delay(100);
  }
  throw new Error(`timed out waiting for game character store record ${characterId}/${ownerRef}; last=${JSON.stringify(last)}`);
}

async function expectJoinRejected(colyseus, options, expectation) {
  try {
    const room = await colyseus.joinOrCreate("game", options);
    const closed = await Promise.race([
      new Promise((resolve) => room.onLeave((code) => resolve({ code }))),
      delay(2_500).then(() => null),
    ]);
    await room.leave(true).catch(() => undefined);
    if (closed?.code === expectation.expectedCloseCode) {
      return { rejected: true, closeCode: closed.code, via: "onLeave-after-join" };
    }
    throw new Error(`${expectation.label} unexpectedly joined room ${room.id}; close=${JSON.stringify(closed)}`);
  } catch (error) {
    const summary = summarizeJoinError(error);
    const message = summary.message ?? "";
    const code = Number(summary.code ?? summary.closeCode ?? summary.statusCode);
    const hasExpectedCode = code === expectation.expectedCloseCode || message.includes(String(expectation.expectedCloseCode));
    const hasExpectedReason = message.toLowerCase().includes(expectation.expectedReason.toLowerCase());
    assert(hasExpectedCode, `${expectation.label} rejection did not expose close code ${expectation.expectedCloseCode}`, summary);
    assert(hasExpectedReason, `${expectation.label} rejection did not include reason ${expectation.expectedReason}`, summary);
    return { rejected: true, closeCode: expectation.expectedCloseCode, via: "join-error", error: summary };
  }
}

function summarizeJoinError(error) {
  if (!error || typeof error !== "object") return { message: String(error) };
  const out = {
    name: error.name,
    message: error.message,
    code: error.code,
    closeCode: error.closeCode,
    statusCode: error.statusCode,
  };
  for (const key of ["error", "reason"]) {
    if (typeof error[key] === "string") out[key] = error[key];
  }
  return Object.fromEntries(Object.entries(out).filter(([, value]) => value !== undefined));
}

async function teardown() {
  for (const processInfo of managedProcesses.slice().reverse()) {
    await stopManagedProcess(processInfo);
  }
  const restoredSettings = await restoreStoreSettingsAfterProof().catch((error) => ({
    restored: false,
    error: error instanceof Error ? error.message : String(error),
  }));
  if (restoredSettings) step("restore-store-settings", restoredSettings.restored ? "pass" : "fail", restoredSettings);
  for (const tempFile of tempFiles) {
    await fs.rm(tempFile, { force: true }).catch(() => undefined);
  }
  step("teardown", "pass", {
    killedProcesses: managedProcesses.map((item) => item.label),
    ports: { compressApi: apiPort, successorGame: gamePort },
  });
}

async function stopManagedProcess({ label, child, logPath }) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  const wait = onceExit(child, 8_000);
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    return;
  }
  const exited = await wait;
  if (!exited) {
    try { process.kill(-child.pid, "SIGKILL"); } catch { /* already gone */ }
    await onceExit(child, 2_000);
  }
  step(`kill-${label}`, "pass", { pid: child.pid, logPath: relativeToRepoOrAbsolute(logPath) });
}

function onceExit(child, timeoutMs) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve(true);
      return;
    }
    const timer = setTimeout(() => resolve(false), timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}


function splitSetCookie(value) {
  if (!value) return [];
  return value.split(/,(?=\s*[^;,]+=)/u).map((part) => part.trim()).filter(Boolean);
}

function assert(condition, message, details) {
  if (!condition) {
    const suffix = details === undefined ? "" : `\n${JSON.stringify(details, null, 2)}`;
    throw new Error(`${message}${suffix}`);
  }
}

function summarizeEnv(env) {
  return Object.fromEntries(Object.entries(env).map(([key, value]) => [key, redactValue(key, value)]));
}

function redactValue(key, value) {
  if (value === undefined || value === null) return value;
  const raw = String(value);
  if (key.includes("SECRET")) return `<set:${raw.length} chars>`;
  if (key.endsWith("_URL")) return redactUrl(raw);
  if (key === "GAME_RUST_AUTHORITY_BRIDGE_BIN" || key === "GAME_CHARACTER_STORE_PATH") return relativeToRepoOrAbsolute(raw);
  return raw;
}

function redactUrl(value) {
  try {
    const url = new URL(value);
    if (url.password) url.password = "***";
    return url.toString();
  } catch {
    return value;
  }
}

function renderTranscript(report) {
  const lines = [];
  lines.push(`Successor ↔ ComPress bridge proof: ${report.status.toUpperCase()}`);
  lines.push(`Run: ${report.runId}`);
  lines.push(`Started: ${report.startedAt}`);
  lines.push(`Completed: ${report.completedAt}`);
  lines.push(`Ports: ComPress API ${report.ports.compressApi}, Successor game ${report.ports.successorGame}`);
  lines.push(`Store: ${report.store.domain}`);
  lines.push(`Customer: ${report.customer.email}`);
  lines.push("");
  for (const entry of report.transcript) {
    lines.push(`[${entry.status.toUpperCase()}] ${entry.step}`);
    const details = entry.details && Object.keys(entry.details).length > 0 ? JSON.stringify(entry.details, null, 2) : "";
    if (details) lines.push(indent(details, "  "));
  }
  return `${lines.join("\n")}\n`;
}

function indent(text, prefix) {
  return text.split("\n").map((line) => `${prefix}${line}`).join("\n");
}

function tail(text, max = 6000) {
  const raw = text ?? "";
  return raw.length <= max ? raw : raw.slice(raw.length - max);
}

function round(value) {
  return Math.round(value * 1000) / 1000;
}

function relativeToRepoOrAbsolute(target) {
  if (!target) return target;
  const relative = path.relative(repoRoot, target);
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative) ? relative : target;
}
