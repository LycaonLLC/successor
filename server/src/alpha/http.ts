import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import {
  AlphaControlStoreError,
  type AlphaControlStore,
  type DevicePollResult,
} from "./index.js";
import type { CharacterStore, CharacterRecord, SuccessorMacroRecord } from "../game/characterStore.js";
import {
  canonicalRecordKindPayloadEtag,
  isValidStandaloneOwnerRef,
  normalizeCharacterWorn,
  normalizeExpectedEtag,
  successorMacroRecordBodyMaxBytes,
  successorMacrosRecordCaps,
  successorMacrosRecordKind,
} from "../game/characterStore.js";
import type { LaunchSessionRegistry } from "../auth/runtime.js";

const SESSION_COOKIE = "__Host-successor_session";
const JSON_CONTENT_TYPE = /^application\/json(?:;|$)/iu;
const callsignPattern = /^[a-z0-9][a-z0-9_-]{2,31}$/u;
const releasePattern = /^[A-Za-z0-9][A-Za-z0-9.@_-]{0,127}$/u;
const idPattern = /^[a-z0-9][a-z0-9_.-]{0,63}$/u;
const legalSchema = z.object({ terms: z.string().min(1).max(32), privacy: z.string().min(1).max(32) }).strict();
const registerSchema = z.object({ callsign: z.string().min(3).max(32), password: z.string().min(1).max(256), legal: legalSchema.optional() }).strict();
const loginSchema = z.object({ callsign: z.string().min(3).max(32), password: z.string().min(1).max(256) }).strict();
const characterSchema = z.object({ name: z.string().min(3).max(16), appearance: z.unknown(), worn: z.unknown().optional(), initialProfessionId: z.string().min(1).max(32) }).strict();
const playTicketSchema = z.object({ characterId: z.string().regex(idPattern), shardId: z.string().regex(releasePattern).optional(), clientReleaseId: z.string().regex(releasePattern).optional() }).strict();
const deviceStartSchema = z.object({ clientId: z.string().min(1).max(128), releaseId: z.string().regex(releasePattern), scopes: z.array(z.enum(["character:list", "play-ticket"])).min(1).max(2) }).strict();
const devicePollSchema = z.object({ deviceCode: z.string().min(20).max(128) }).strict();
const deviceDecisionSchema = z.object({ userCode: z.string().min(4).max(32), decision: z.enum(["approve", "deny"]) }).strict();
const deviceIdSchema = z.object({ id: z.string().min(1).max(128) }).strict();
const deleteAccountSchema = z.object({ password: z.string().min(1).max(256) }).strict();
const characterIdParamsSchema = z.object({ id: z.string().regex(idPattern) }).strict();
const characterMacroItemParamsSchema = z.object({
  id: z.string().regex(idPattern),
  macroId: z.string().min(1).max(64).regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u),
}).strict();
const macroSaveSchema = z.object({
  id: z.string().min(1).max(64).regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u),
  name: z.string().min(1).max(successorMacrosRecordCaps.maxNameCharacters),
  iconId: z.string().min(1).max(successorMacrosRecordCaps.maxIconIdCharacters).regex(/^[A-Za-z0-9][A-Za-z0-9:_-]{0,63}$/u),
  body: z.string().refine((value) => Buffer.byteLength(value, "utf8") <= successorMacroRecordBodyMaxBytes),
}).strict();

export interface AlphaHttpOptions {
  readonly controlStore: AlphaControlStore;
  readonly characterStore: CharacterStore;
  readonly sessionRevocations: LaunchSessionRegistry;
  readonly origin: string;
  readonly shardId: string;
  readonly clientReleaseId: string;
  readonly serverReleaseId: string;
  readonly issuer: string;
  readonly acceptedClientReleaseIds?: readonly string[];
  readonly gameEndpoint?: string;
  readonly chatEndpoint?: string;
  readonly requiredLegalVersions?: Readonly<Record<string, string>>;
  readonly accountRetirement?: (accountId: string) => Promise<void> | void;
  readonly trustedProxyHops?: number;
  readonly cleanupIntervalMs?: number;
  readonly cleanupBatchSize?: number;
  readonly rateLimits?: Partial<Record<"register" | "login" | "deviceStart" | "devicePoll" | "macros", number>>;
}

type Req = FastifyRequest<{ Body?: unknown; Params?: unknown }>;

export async function registerAlphaRoutes(app: FastifyInstance, options: AlphaHttpOptions): Promise<void> {
  const acceptedReleases = new Set(options.acceptedClientReleaseIds ?? [options.clientReleaseId]);
  if (acceptedReleases.size === 0 || [...acceptedReleases].some((value) => !releasePattern.test(value))) throw new Error("invalid standalone client release allowlist");
  const requiredLegal = options.requiredLegalVersions ?? {};
  const buckets = new Map<string, { count: number; resetAt: number }>();
  const limits = { register: options.rateLimits?.register ?? 20, login: options.rateLimits?.login ?? 30, deviceStart: options.rateLimits?.deviceStart ?? 30, devicePoll: options.rateLimits?.devicePoll ?? 60, macros: options.rateLimits?.macros ?? 30 };
  const cleanupIntervalMs = options.cleanupIntervalMs ?? 60_000;
  const cleanupBatchSize = options.cleanupBatchSize ?? 100;
  if (!Number.isInteger(cleanupIntervalMs) || cleanupIntervalMs < 1 || cleanupIntervalMs > 3_600_000 || !Number.isInteger(cleanupBatchSize) || cleanupBatchSize < 1 || cleanupBatchSize > 1_000) throw new Error("invalid alpha cleanup bounds");
  let cleanupTimer: ReturnType<typeof setInterval> | undefined;

  app.addHook("onReady", async () => {
    cleanupTimer = setInterval(() => { void options.controlStore.cleanupExpired(cleanupBatchSize).catch(() => undefined); }, cleanupIntervalMs);
    cleanupTimer.unref?.();
  });
  app.addHook("onClose", async () => {
    if (cleanupTimer) clearInterval(cleanupTimer);
    cleanupTimer = undefined;
  });

  app.addHook("onRequest", async (request, reply) => {
    if (!request.url.startsWith("/alpha-api/")) return;
    reply.header("cache-control", "no-store, max-age=0");
    reply.header("pragma", "no-cache");
    reply.header("expires", "0");
    reply.header("vary", "Origin, Sec-Fetch-Site, Authorization");
    if (request.headers["access-control-request-method"] || request.headers.origin && request.headers.origin !== options.origin) {
      reply.removeHeader("access-control-allow-origin");
    }
    const forwarded = request.headers["x-forwarded-for"];
    const trustedHops = options.trustedProxyHops ?? 0;
    if (forwarded) {
      const hops = String(forwarded).split(",").map((part) => part.trim()).filter(Boolean);
      if (trustedHops < 1 || hops.length !== trustedHops) return reply.code(400).send({ error: "proxy_forbidden" });
    }
    const length = request.headers["content-length"];
    if (length && (!/^\d+$/u.test(length) || Number(length) > 64 * 1024)) return reply.code(413).send({ error: "body_too_large" });
  });

  app.get("/alpha-api/csrf", async (request, reply) => {
    const requestOrigin = request.headers.origin;
    const fetchSite = request.headers["sec-fetch-site"];
    if ((requestOrigin && requestOrigin !== options.origin) || (fetchSite && !["same-origin", "same-site"].includes(String(fetchSite)))) return reply.code(403).send({ error: "request_forbidden" });
    const token = cookieValue(request.headers.cookie, SESSION_COOKIE);
    let session: { kind: "pre_auth" | "auth"; csrfToken: string; accountId?: string } | undefined;
    if (token) {
      try {
        const inspected = await options.controlStore.inspectSession(token);
        const refreshed = await options.controlStore.refreshCsrf(token);
        session = { kind: inspected.kind, csrfToken: refreshed, accountId: inspected.accountId };
      } catch {
        // Expired/revoked cookies are replaced with a new anonymous pre-session.
      }
    }
    if (!session) {
      const credentials = await options.controlStore.createPreAuthSession();
      setSessionCookie(reply, credentials.token);
      session = { kind: "pre_auth", csrfToken: credentials.csrfToken };
    }
    return reply.send({ csrfToken: session.csrfToken, authenticated: session.kind === "auth" });
  });

  app.post("/alpha-api/register", async (request: Req, reply) => {
    if (rejectCookieMutation(request, reply, options.origin)) return;
    const registerCallsign = typeof (request.body as { callsign?: unknown })?.callsign === "string" ? String((request.body as { callsign: string }).callsign).trim().toLowerCase() : "invalid";
    if (!consumeRate(buckets, `register:${request.ip}`, limits.register) || !consumeRate(buckets, `register:call:${registerCallsign}`, limits.register) || !consumeRate(buckets, "register:global", limits.register * 10)) return reply.code(429).send({ error: "rate_limited" });
    const parsed = registerSchema.safeParse(request.body);
    if (!parsed.success || !callsignPattern.test(parsed.data.callsign.trim().toLowerCase())) return reply.code(400).send({ error: "invalid_request" });
    const pre = await requirePreSession(request, options.controlStore, request.headers["x-csrf-token"] ?? "");
    if (!pre) return reply.code(401).send({ error: "invalid_session" });
    if (!legalMatches(parsed.data.legal, requiredLegal)) return reply.code(400).send({ error: "legal_required" });
    try {
      const account = await options.controlStore.registerAccount({ callsign: parsed.data.callsign, password: parsed.data.password, legalAcceptance: parsed.data.legal });
      const session = await options.controlStore.rotateSession(pre.token, account.accountId);
      setSessionCookie(reply, session.token);
      return reply.code(201).send(publicAccount(account, requiredLegal));
    } catch (error) {
      return sendAlphaError(reply, error, "registration_failed");
    }
  });

  app.post("/alpha-api/login", async (request: Req, reply) => {
    if (rejectCookieMutation(request, reply, options.origin)) return;
    const loginCallsign = typeof (request.body as { callsign?: unknown })?.callsign === "string" ? String((request.body as { callsign: string }).callsign).trim().toLowerCase() : "invalid";
    if (!consumeRate(buckets, `login:${request.ip}`, limits.login) || !consumeRate(buckets, `login:call:${loginCallsign}`, limits.login) || !consumeRate(buckets, "login:global", limits.login * 10)) return reply.code(429).send({ error: "rate_limited" });
    const parsed = loginSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request" });
    const pre = await requirePreSession(request, options.controlStore, request.headers["x-csrf-token"] ?? "");
    if (!pre) return reply.code(401).send({ error: "invalid_session" });
    try {
      const account = await options.controlStore.verifyPassword(parsed.data.callsign, parsed.data.password);
      const session = await options.controlStore.rotateSession(pre.token, account.accountId);
      setSessionCookie(reply, session.token);
      return reply.send(publicAccount(account, requiredLegal));
    } catch (error) {
      const code = error instanceof AlphaControlStoreError ? error.code : "";
      if (code === "ALPHA_PASSWORD_INVALID" || code === "ALPHA_ACCOUNT_NOT_FOUND" || code === "ALPHA_ACCOUNT_DELETED") return reply.code(401).send({ error: "invalid_credentials" });
      return sendAlphaError(reply, error, "login_failed");
    }
  });

  app.post("/alpha-api/logout", async (request: Req, reply) => {
    if (rejectCookieMutation(request, reply, options.origin)) return;
    const auth = await requireAuth(request, options.controlStore, request.headers["x-csrf-token"] ?? "");
    if (!auth) return reply.code(401).send({ error: "invalid_session" });
    const revoked = await options.controlStore.revokeSession(auth.token);
    for (const launchId of revoked.launchIds) options.sessionRevocations.closeLaunch(launchId);
    clearSessionCookie(reply);
    return reply.code(204).send();
  });

  app.get("/alpha-api/session", async (request, reply) => {
    const auth = await requireAuth(request, options.controlStore);
    if (!auth) return reply.code(401).send({ error: "invalid_session" });
    const account = options.controlStore.getAccount(auth.accountId);
    if (!isValidStandaloneOwnerRef(account.ownerRef)) return reply.code(503).send({ error: "owner_state_invalid" });
    return reply.send(publicAccount(account, requiredLegal, options.characterStore.list(account.ownerRef).length));
  });

  app.get("/alpha-api/characters", async (request, reply) => {
    const identity = await authorizeScoped(request, options, "character:list");
    if (!identity) return reply.code(401).send({ error: "invalid_auth" });
    const account = options.controlStore.getAccount(identity.accountId);
    if (!isValidStandaloneOwnerRef(account.ownerRef)) return reply.code(503).send({ error: "owner_state_invalid" });
    return reply.send({ characters: publicCharacters(options.characterStore.list(account.ownerRef)) });
  });

  app.post("/alpha-api/characters", async (request: Req, reply) => {
    if (rejectCookieMutation(request, reply, options.origin)) return;
    const auth = await requireAuth(request, options.controlStore, request.headers["x-csrf-token"] ?? "");
    if (!auth) return reply.code(401).send({ error: "invalid_session" });
    const parsed = characterSchema.safeParse(request.body);
    if (!parsed.success || (parsed.data.worn !== undefined && !normalizeCharacterWorn(parsed.data.worn))) return reply.code(400).send({ error: "invalid_request" });
    const account = options.controlStore.getAccount(auth.accountId);
    if (!isValidStandaloneOwnerRef(account.ownerRef)) return reply.code(503).send({ error: "owner_state_invalid" });
    const result = options.characterStore.create({ name: parsed.data.name, appearance: parsed.data.appearance, worn: parsed.data.worn, initialProfessionId: parsed.data.initialProfessionId, ownerRef: account.ownerRef, slotCap: 5 });
    if (!result.ok) return reply.code(result.error === "slots_full" || result.error === "name_taken" ? 409 : 400).send({ error: result.error });
    return reply.code(201).send(publicCharacter(result.record));
  });

  app.post("/alpha-api/play-ticket", async (request: Req, reply) => {
    if (!requireJson(request, reply)) return;
    const bearer = bearerToken(request.headers.authorization);
    if (!bearer && rejectCookieMutation(request, reply, options.origin)) return;
    const identity = bearer ? await authorizeScoped(request, options, "play-ticket") : await authorizeBrowserMutation(request, options);
    if (!identity) return reply.code(401).send({ error: "invalid_auth" });
    const parsed = playTicketSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request" });
    const shardId = parsed.data.shardId ?? options.shardId;
    const clientReleaseId = parsed.data.clientReleaseId ?? options.clientReleaseId;
    if (shardId !== options.shardId || !acceptedReleases.has(clientReleaseId)) return reply.code(400).send({ error: "release_not_allowed" });
    const account = options.controlStore.getAccount(identity.accountId);
    if (!isValidStandaloneOwnerRef(account.ownerRef)) return reply.code(503).send({ error: "owner_state_invalid" });
    const character = options.characterStore.get(parsed.data.characterId, account.ownerRef);
    if (!character) return reply.code(404).send({ error: "character_not_found" });
    try {
      const envelope = await options.controlStore.createLaunch({ accountId: account.accountId, ownerRef: account.ownerRef, characterId: character.id, shardId, clientReleaseId, serverReleaseId: options.serverReleaseId, issuer: options.issuer, provenance: identity.provenance });
      return reply.send({ gameTicket: envelope.gameTicket, chatTicket: envelope.chatTicket, characterId: character.id, expiresAt: envelope.expiresAt, endpoints: { game: options.gameEndpoint ?? "", chat: options.chatEndpoint ?? "" }, release: { client: clientReleaseId, server: options.serverReleaseId, shard: shardId } });
    } catch (error) {
      return sendAlphaError(reply, error, "launch_unavailable");
    }
  });

  app.post("/alpha-api/device/start", async (request: Req, reply) => {
    if (!requireJson(request, reply)) return;
    if (!consumeRate(buckets, `device-start:${request.ip}`, limits.deviceStart)) return reply.code(429).send({ error: "rate_limited" });
    const parsed = deviceStartSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request" });
    if (!acceptedReleases.has(parsed.data.releaseId)) return reply.code(400).send({ error: "release_not_allowed" });
    try { return reply.code(201).send(await options.controlStore.startDeviceAuthorization(parsed.data)); } catch (error) { return sendAlphaError(reply, error, "device_start_failed"); }
  });

  app.post("/alpha-api/device/poll", async (request: Req, reply) => {
    if (!requireJson(request, reply)) return;
    if (!consumeRate(buckets, `device-poll:${request.ip}`, limits.devicePoll)) return reply.code(429).send({ error: "rate_limited" });
    const parsed = devicePollSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request" });
    try {
      const result = await options.controlStore.pollDevice(parsed.data.deviceCode);
      const statusCode = result.status === "slow_down" ? 429 : 200;
      if (result.retryAfterMs) reply.header("retry-after", String(Math.ceil(result.retryAfterMs / 1000)));
      return reply.code(statusCode).send(safeDeviceResult(result));
    } catch (error) { return sendAlphaError(reply, error, "device_poll_failed"); }
  });

  app.post("/alpha-api/device/decision", async (request: Req, reply) => {
    if (rejectCookieMutation(request, reply, options.origin)) return;
    const auth = await requireAuth(request, options.controlStore, request.headers["x-csrf-token"] ?? "");
    if (!auth) return reply.code(401).send({ error: "invalid_session" });
    const parsed = deviceDecisionSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request" });
    try {
      if (parsed.data.decision === "approve") await options.controlStore.approveDevice(parsed.data.userCode, auth.accountId);
      else await options.controlStore.denyDevice(parsed.data.userCode);
      return reply.code(204).send();
    } catch (error) { return sendAlphaError(reply, error, "device_decision_failed"); }
  });

  app.post("/alpha-api/device/logout", async (request, reply) => {
    const credential = bearerToken(request.headers.authorization);
    if (!credential) return reply.code(401).send({ error: "invalid_auth" });
    if (request.headers["content-length"] && Number(request.headers["content-length"]) !== 0) return reply.code(400).send({ error: "body_forbidden" });
    try {
      const revoked = await options.controlStore.revokeDeviceCredential(credential);
      for (const launchId of revoked.launchIds) options.sessionRevocations.closeLaunch(launchId);
      return reply.code(204).send();
    } catch (error) { return sendAlphaError(reply, error, "device_logout_failed"); }
  });

  app.get("/alpha-api/devices", async (request, reply) => {
    const auth = await requireAuth(request, options.controlStore);
    if (!auth) return reply.code(401).send({ error: "invalid_session" });
    return reply.send({ devices: options.controlStore.listDevices(auth.accountId) });
  });

  app.delete("/alpha-api/devices/:id", async (request: Req, reply) => {
    if (rejectCookieMutation(request, reply, options.origin)) return;
    const auth = await requireAuth(request, options.controlStore, request.headers["x-csrf-token"] ?? "");
    if (!auth) return reply.code(401).send({ error: "invalid_session" });
    const parsed = deviceIdSchema.safeParse(request.params);
    if (!parsed.success) return reply.code(404).send({ error: "device_not_found" });
    try {
      const revoked = await options.controlStore.revokeDeviceForAccount(auth.accountId, parsed.data.id);
      for (const launchId of revoked.launchIds) options.sessionRevocations.closeLaunch(launchId);
      return reply.code(204).send();
    } catch (error) { return sendAlphaError(reply, error, "device_not_found"); }
  });

  app.delete("/alpha-api/account", async (request: Req, reply) => {
    if (rejectCookieMutation(request, reply, options.origin)) return;
    const auth = await requireAuth(request, options.controlStore, request.headers["x-csrf-token"] ?? "");
    if (!auth) return reply.code(401).send({ error: "invalid_session" });
    const parsed = deleteAccountSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request" });
    try {
      await options.controlStore.verifyPassword(options.controlStore.getAccount(auth.accountId).callsign, parsed.data.password);
      const revoked = await options.controlStore.revokeAccount(auth.accountId);
      for (const launchId of revoked.launchIds) options.sessionRevocations.closeLaunch(launchId);
      options.sessionRevocations.closeAccount(auth.accountId);
      await options.accountRetirement?.(auth.accountId);
      clearSessionCookie(reply);
      return reply.code(202).send({ status: "pending_deletion" });
    } catch (error) {
      const code = error instanceof AlphaControlStoreError ? error.code : "";
      if (code === "ALPHA_PASSWORD_INVALID" || code === "ALPHA_ACCOUNT_DELETED") return reply.code(401).send({ error: "invalid_password" });
      return sendAlphaError(reply, error, "account_delete_failed");
    }
  });

  // Hosted macro CRUD — sole production boundary. Owner is resolved server-side
  // from the authenticated account; browser never supplies owner/account identity.
  app.get("/alpha-api/characters/:id/macros", async (request: Req, reply) => {
    const auth = await requireAuth(request, options.controlStore);
    if (!auth) return reply.code(401).send({ error: "invalid_session" });
    const params = characterIdParamsSchema.safeParse(request.params);
    if (!params.success) return reply.code(404).send({ error: "character_not_found" });
    if (!consumeMacroRate(buckets, auth, params.data.id, limits.macros)) {
      return reply.code(429).send({ error: "macro_rate_limited", retryAfterMs: 60_000 });
    }
    const account = options.controlStore.getAccount(auth.accountId);
    if (!isValidStandaloneOwnerRef(account.ownerRef)) return reply.code(503).send({ error: "owner_state_invalid" });
    const payload = options.characterStore.recordKindPayload<SuccessorMacroRecord>(
      params.data.id,
      successorMacrosRecordKind,
      account.ownerRef,
    );
    if (!payload) return reply.code(404).send({ error: "character_not_found" });
    return sendHostedMacroPayload(reply, params.data.id, payload);
  });

  app.post("/alpha-api/characters/:id/macros", async (request: Req, reply) => {
    if (rejectCookieMutation(request, reply, options.origin)) return;
    const auth = await requireAuth(request, options.controlStore, request.headers["x-csrf-token"] ?? "");
    if (!auth) return reply.code(401).send({ error: "invalid_session" });
    const params = characterIdParamsSchema.safeParse(request.params);
    if (!params.success) return reply.code(404).send({ error: "character_not_found" });
    if (!consumeMacroRate(buckets, auth, params.data.id, limits.macros)) {
      return reply.code(429).send({ error: "macro_rate_limited", retryAfterMs: 60_000 });
    }
    const parsed = macroSaveSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_macro" });
    const expectedEtag = normalizeExpectedEtag(request.headers["if-match"]);
    if (!expectedEtag) return reply.code(400).send({ error: "etag_required" });
    const account = options.controlStore.getAccount(auth.accountId);
    if (!isValidStandaloneOwnerRef(account.ownerRef)) return reply.code(503).send({ error: "owner_state_invalid" });
    if (!options.characterStore.get(params.data.id, account.ownerRef)) {
      return reply.code(404).send({ error: "character_not_found" });
    }
    const result = options.characterStore.saveRecordKindItem<SuccessorMacroRecord>(
      params.data.id,
      successorMacrosRecordKind,
      parsed.data,
      { ownerRef: account.ownerRef, expectedEtag, requireEtag: true },
    );
    if (!result.ok) {
      if (result.error === "etag_mismatch") {
        return sendHostedMacroPayload(reply, params.data.id, result.payload, undefined, 409, "etag_mismatch");
      }
      return sendHostedMacroWriteError(reply, result.error);
    }
    return sendHostedMacroPayload(reply, params.data.id, result.payload, result.item, 200, undefined, result.etag);
  });

  app.delete("/alpha-api/characters/:id/macros/:macroId", async (request: Req, reply) => {
    if (rejectCookieMutation(request, reply, options.origin)) return;
    const auth = await requireAuth(request, options.controlStore, request.headers["x-csrf-token"] ?? "");
    if (!auth) return reply.code(401).send({ error: "invalid_session" });
    const params = characterMacroItemParamsSchema.safeParse(request.params);
    if (!params.success) return reply.code(404).send({ error: "character_not_found" });
    if (!consumeMacroRate(buckets, auth, params.data.id, limits.macros)) {
      return reply.code(429).send({ error: "macro_rate_limited", retryAfterMs: 60_000 });
    }
    const expectedEtag = normalizeExpectedEtag(request.headers["if-match"]);
    if (!expectedEtag) return reply.code(400).send({ error: "etag_required" });
    const account = options.controlStore.getAccount(auth.accountId);
    if (!isValidStandaloneOwnerRef(account.ownerRef)) return reply.code(503).send({ error: "owner_state_invalid" });
    if (!options.characterStore.get(params.data.id, account.ownerRef)) {
      return reply.code(404).send({ error: "character_not_found" });
    }
    const result = options.characterStore.deleteRecordKindItem<SuccessorMacroRecord>(
      params.data.id,
      successorMacrosRecordKind,
      params.data.macroId,
      { ownerRef: account.ownerRef, expectedEtag, requireEtag: true },
    );
    if (!result.ok) {
      if (result.error === "etag_mismatch") {
        return sendHostedMacroPayload(reply, params.data.id, result.payload, undefined, 409, "etag_mismatch");
      }
      return sendHostedMacroWriteError(reply, result.error);
    }
    if (!result.deleted) return reply.code(404).send({ error: "macro_not_found" });
    return sendHostedMacroPayload(reply, params.data.id, result.payload, undefined, 200, undefined, result.etag);
  });
}

function consumeRate(buckets: Map<string, { count: number; resetAt: number }>, key: string, limit: number): boolean {
  const now = Date.now();
  if (buckets.size >= 4096 && !buckets.has(key)) { const oldest = buckets.keys().next().value; if (typeof oldest === "string") buckets.delete(oldest); }
  const current = buckets.get(key);
  if (!current || current.resetAt <= now) { buckets.set(key, { count: 1, resetAt: now + 60_000 }); return true; }
  if (current.count >= limit) return false;
  current.count += 1;
  return true;
}

function publicAccount(account: { callsign: string; status: string }, requiredLegal: Readonly<Record<string, string>>, characterCount = 0): Record<string, unknown> {
  return { callsign: account.callsign, setup: { characterCount, maxCharacters: 5 }, legal: requiredLegal, status: account.status };
}
function publicCharacters(records: CharacterRecord[]): unknown[] { return records.map(publicCharacter); }
function publicCharacter(record: CharacterRecord): Record<string, unknown> { return { id: record.id, name: record.name, appearance: record.appearance, worn: record.worn, initialProfessionId: record.initialProfessionId, worldEntryClaimed: record.worldEntryClaimed }; }
function legalMatches(value: { terms?: string; privacy?: string } | undefined, required: Readonly<Record<string, string>>): boolean { return Object.entries(required).every(([name, version]) => value?.[(name as "terms" | "privacy")] === version); }
function setSessionCookie(reply: FastifyReply, value: string): void { reply.header("set-cookie", `${SESSION_COOKIE}=${encodeURIComponent(value)}; Path=/; Secure; HttpOnly; SameSite=Lax`); }
function clearSessionCookie(reply: FastifyReply): void { reply.header("set-cookie", `${SESSION_COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`); }
function cookieValue(header: string | undefined, name: string): string | undefined { const found = header?.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${name}=`)); return found ? decodeURIComponent(found.slice(name.length + 1)) : undefined; }
function bearerToken(header: string | undefined): string | undefined { return header?.match(/^Bearer ([A-Za-z0-9_-]{20,128})$/u)?.[1]; }
function requireJson(request: Req, reply: FastifyReply): boolean { if (!JSON_CONTENT_TYPE.test(String(request.headers["content-type"] ?? ""))) { void reply.code(415).send({ error: "json_required" }); return false; } return true; }
function rejectCookieMutation(request: Req, reply: FastifyReply, origin: string): boolean { if (!requireJson(request, reply)) return true; if (request.headers.origin !== origin || !["same-origin", "same-site"].includes(String(request.headers["sec-fetch-site"] ?? ""))) { void reply.code(403).send({ error: "request_forbidden" }); return true; } return false; }
async function requirePreSession(request: Req, store: AlphaControlStore, csrf: string | string[] | undefined): Promise<{ token: string; accountId?: string } | null> { const token = cookieValue(request.headers.cookie, SESSION_COOKIE); if (!token || typeof csrf !== "string" || csrf.length === 0) return null; try { const session = await store.inspectSession(token, csrf); return session.kind === "pre_auth" ? { token, accountId: session.accountId } : null; } catch { return null; } }
async function requireAuth(request: Req, store: AlphaControlStore, csrf?: string | string[]): Promise<{ token: string; accountId: string; sessionId: string } | null> { const token = cookieValue(request.headers.cookie, SESSION_COOKIE); if (!token) return null; if (csrf !== undefined && (typeof csrf !== "string" || csrf.length === 0)) return null; try { const session = await store.inspectSession(token, typeof csrf === "string" ? csrf : undefined); return session.kind === "auth" && session.accountId ? { token, accountId: session.accountId, sessionId: session.sessionId } : null; } catch { return null; } }
async function authorizeBrowserMutation(request: Req, options: AlphaHttpOptions): Promise<{ accountId: string; provenance: { kind: "browser_session"; id: string } } | null> { const auth = await requireAuth(request, options.controlStore, request.headers["x-csrf-token"] ?? ""); return auth ? { accountId: auth.accountId, provenance: { kind: "browser_session", id: auth.sessionId } } : null; }
async function authorizeScoped(request: FastifyRequest, options: AlphaHttpOptions, scope: string): Promise<{ accountId: string; provenance: { kind: "device_credential"; id: string } | { kind: "browser_session"; id: string } } | null> { const bearer = bearerToken(request.headers.authorization); if (bearer) { try { const credential = await options.controlStore.inspectDeviceCredential(bearer); return credential.scopes.includes(scope) ? { accountId: credential.accountId, provenance: { kind: "device_credential", id: credential.credentialId } } : null; } catch { return null; } } const auth = await requireAuth(request, options.controlStore); return auth ? { accountId: auth.accountId, provenance: { kind: "browser_session", id: auth.sessionId } } : null; }
function safeDeviceResult(result: DevicePollResult): Record<string, unknown> { return { status: result.status, expiresAt: result.expiresAt, retryAfterMs: result.retryAfterMs, credential: result.credential, scopes: result.scopes }; }
function sendAlphaError(reply: FastifyReply, error: unknown, fallback: string): FastifyReply { if (error instanceof AlphaControlStoreError) { const mapping: Record<string, [number, string]> = { ALPHA_REGISTRATION_CLOSED: [403, "registration_closed"], ALPHA_REGISTRATION_CAP: [409, "registration_cap"], ALPHA_CALLSIGN_TAKEN: [409, "callsign_taken"], ALPHA_LEGAL_REQUIRED: [400, "legal_required"], ALPHA_DEVICE_SLOW_DOWN: [429, "slow_down"], ALPHA_DEVICE_SCOPE: [400, "invalid_scope"], ALPHA_DEVICE_INVALID: [404, "device_not_found"], ALPHA_DEVICE_STATE: [409, "device_state"], ALPHA_CREDENTIAL_INVALID: [401, "invalid_auth"], ALPHA_LAUNCH_INVALID: [400, "launch_invalid"], ALPHA_ACCOUNT_PENDING_DELETION: [403, "account_unavailable"], ALPHA_LAUNCH_CAP: [429, "launch_limit_reached"], ALPHA_PLAY_TICKET_RATE: [429, "play_ticket_rate_limited"], ALPHA_DEVICE_CAP: [429, "device_limit_reached"] }; const mapped = mapping[error.code]; if (mapped) return reply.code(mapped[0]).send({ error: mapped[1] }); } return reply.code(500).send({ error: fallback }); }

function consumeMacroRate(
  buckets: Map<string, { count: number; resetAt: number }>,
  auth: { accountId: string; sessionId: string },
  characterId: string,
  limit: number,
): boolean {
  return (
    consumeRate(buckets, `macros:acct:${auth.accountId}`, limit) &&
    consumeRate(buckets, `macros:sess:${auth.sessionId}`, limit) &&
    consumeRate(buckets, `macros:char:${auth.accountId}:${characterId}`, limit)
  );
}

function sendHostedMacroPayload(
  reply: FastifyReply,
  characterId: string,
  payload: { version: number; items: SuccessorMacroRecord[] },
  macro?: SuccessorMacroRecord,
  status = 200,
  error?: string,
  etag?: string,
): FastifyReply {
  const token = etag ?? canonicalRecordKindPayloadEtag(payload);
  const body: Record<string, unknown> = {
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
  };
  if (macro) body.macro = macro;
  if (error) body.error = error;
  return reply.code(status).header("etag", `"${token}"`).send(body);
}

function sendHostedMacroWriteError(reply: FastifyReply, error: string): FastifyReply {
  switch (error) {
    case "character_not_found":
      return reply.code(404).send({ error: "character_not_found" });
    case "record_limit_exceeded":
      return reply.code(409).send({ error: "macro_limit_exceeded" });
    case "record_too_large":
    case "payload_too_large":
      return reply.code(413).send({ error: "macro_too_large" });
    case "invalid_record":
      return reply.code(400).send({ error: "invalid_macro" });
    case "etag_required":
      return reply.code(400).send({ error: "etag_required" });
    case "unknown_record_kind":
      return reply.code(500).send({ error: "macro_record_kind_unavailable" });
    default:
      return reply.code(500).send({ error: "macro_write_failed" });
  }
}
