import { z } from "zod";

import { normalizeDisplayName, normalizeUserId } from "../chat/policy.js";
import type { ChatSessionIdentity } from "../chat/hub.js";

const DEFAULT_SUCCESSOR_SITE_URL = "http://successor.localhost:5174";
const SESSION_TICKET_PATH = "/api/v1/storefront/successor/session-ticket";
const FIRST_ENTRY_COMMIT_PATH = "/api/v1/storefront/successor/first-entry";
const ticketSchema = z.string().regex(/^[A-Za-z0-9_-]{32,160}$/u);
const controlPlaneFieldSchema = z.string().trim().min(1).max(256);
const launchTicketPlayerSchema = z.object({
  id: z.string().min(1), profileId: z.string().min(1), characterId: z.string().min(1), displayName: z.string().min(1), zoneId: z.string().min(1),
  initialProfessionId: z.enum(["marksman", "scout", "craftsman", "medic", "brawler"]).optional(),
});
const launchTicketEntitlementSchema = z.object({ access: z.boolean(), characterSlots: z.number().int().min(0).max(10), activeUntil: z.string().datetime({ offset: true }).nullable() });
const firstEntryStatusSchema = z.enum(["pending", "entered", "failed"]);
const launchTicketFirstEntrySchema = z.object({
  ok: z.boolean().optional(),
  idempotent: z.boolean().optional(),
  status: firstEntryStatusSchema,
  entryNonce: controlPlaneFieldSchema.optional(),
});
const launchTicketResponseSchema = z.object({
  player: launchTicketPlayerSchema,
  entitlement: launchTicketEntitlementSchema,
  bridgeVersion: controlPlaneFieldSchema.optional(),
  world: z.unknown().optional(),
  shardId: controlPlaneFieldSchema.optional(),
  releaseId: controlPlaneFieldSchema.optional(),
  entryNonce: controlPlaneFieldSchema.optional(),
  firstEntry: launchTicketFirstEntrySchema.optional(),
});
export type LaunchTicketPlayer = z.infer<typeof launchTicketPlayerSchema>;
export type LaunchTicketEntitlement = z.infer<typeof launchTicketEntitlementSchema>;
export type LaunchTicketFirstEntry = z.infer<typeof launchTicketFirstEntrySchema>;
export type LaunchTicketResponse = z.infer<typeof launchTicketResponseSchema>;
export interface HostedFirstEntryCommit {
  entryNonce: string;
  shardId: string;
  releaseId: string;
}
export interface LaunchTicketIdentity extends ChatSessionIdentity {
  player: LaunchTicketPlayer;
  entitlement: LaunchTicketEntitlement;
  firstEntry?: LaunchTicketFirstEntry;
  entryNonce?: string;
  shardId?: string;
  releaseId?: string;
  pendingFirstEntryCommit?: HostedFirstEntryCommit;
}
export interface TicketLogger { warn(fields: { reason: TicketFailureReason }, message: string): void; }
export type TicketFailureReason = "network_error" | "timeout" | `http_${number}` | "invalid_json" | "invalid_schema" | "invalid_profile" | "first_entry_contract" | "first_entry_commit";
const lastLogged = new Map<string, number>();
let defaultLogger: TicketLogger | undefined;
export function configureTicketLogger(logger: TicketLogger): void { defaultLogger = logger; }
const LOG_INTERVAL_MS = 60_000;
function logFailure(logger: TicketLogger | undefined, reason: TicketFailureReason): void {
  logger ??= defaultLogger;
  if (!logger) return;
  const now = Date.now();
  if (now - (lastLogged.get(reason) ?? 0) < LOG_INTERVAL_MS) return;
  lastLogged.set(reason, now);
  logger.warn({ reason }, "launch ticket redemption failed");
}
function redeemBaseUrl(): string { const siteUrl = process.env.SUCCESSOR_SITE_URL?.trim() || DEFAULT_SUCCESSOR_SITE_URL; return `${siteUrl.replace(/\/+$/u, "")}${SESSION_TICKET_PATH}`; }
function hostedRuntime(): boolean { const nodeEnv = process.env.NODE_ENV?.trim().toLowerCase(); if (nodeEnv === "test") return false; return nodeEnv === "production" || Boolean(process.env.SUCCESSOR_SITE_URL?.trim()); }
function runtimeCredentials(): { runtimeSecret: string; runtimeBearerToken: string; shardId: string; releaseId: string } | null {
  const runtimeSecret = process.env.SUCCESSOR_RUNTIME_SECRET?.trim();
  const runtimeBearerToken = process.env.SUCCESSOR_RUNTIME_BEARER_TOKEN?.trim();
  const shardId = process.env.SUCCESSOR_SHARD_ID?.trim();
  const releaseId = process.env.SUCCESSOR_RELEASE_ID?.trim();
  if (!runtimeSecret || !runtimeBearerToken || !shardId || !releaseId) return null;
  return { runtimeSecret, runtimeBearerToken, shardId, releaseId };
}
function runtimeHeaders(credentials: { runtimeSecret: string; runtimeBearerToken: string; shardId: string; releaseId: string }, contract?: HostedFirstEntryCommit): Record<string, string> {
  return {
    Accept: "application/json",
    ...(contract ? { "Content-Type": "application/json" } : {}),
    "User-Agent": "Successor-Runtime/1.0",
    "x-successor-runtime-key": credentials.runtimeSecret,
    Authorization: `Bearer ${credentials.runtimeBearerToken}`,
    "x-successor-shard-id": credentials.shardId,
    "x-successor-release-id": credentials.releaseId,
  };
}
export function parseLaunchTicketResponse(body: unknown): LaunchTicketResponse | null { const parsed = launchTicketResponseSchema.safeParse(body); return parsed.success ? parsed.data : null; }
export async function resolveLaunchTicketIdentity(ticket: string, logger?: TicketLogger): Promise<LaunchTicketIdentity | null> {
  const parsedTicket = ticketSchema.safeParse(ticket.trim()); if (!parsedTicket.success) return null;
  const url = `${redeemBaseUrl().replace(/\/+$/u, "")}/${encodeURIComponent(parsedTicket.data)}`;
  const credentials = runtimeCredentials();
  if (hostedRuntime() && !credentials) { logFailure(logger, "network_error"); return null; }
  const headers: Record<string, string> = credentials ? runtimeHeaders(credentials) : { Accept: "application/json", "User-Agent": "Successor-Runtime/1.0" };
  let response: Response;
  try { response = await fetch(url, { headers, signal: AbortSignal.timeout(2500) }); } catch (error) { logFailure(logger, error instanceof DOMException && error.name === "TimeoutError" ? "timeout" : "network_error"); return null; }
  if (!response.ok) { logFailure(logger, `http_${Math.max(100, Math.min(599, response.status))}`); return null; }
  let body: unknown; try { body = await response.json(); } catch { logFailure(logger, "invalid_json"); return null; }
  const parsed = parseLaunchTicketResponse(body); if (!parsed) { logFailure(logger, "invalid_schema"); return null; }
  const player = parsed.player; const userId = normalizeUserId(player.profileId); if (!userId) { logFailure(logger, "invalid_profile"); return null; }
  return {
    userId,
    displayName: normalizeDisplayName(player.displayName, userId),
    zoneId: normalizeUserId(player.zoneId) || "open-desert",
    player,
    entitlement: parsed.entitlement,
    firstEntry: parsed.firstEntry,
    entryNonce: parsed.entryNonce ?? parsed.firstEntry?.entryNonce,
    shardId: parsed.shardId,
    releaseId: parsed.releaseId,
  };
}

const firstEntryCommitsInFlight = new Map<string, Promise<void>>();

export function pendingFirstEntryCommit(identity: Pick<LaunchTicketIdentity, "firstEntry" | "entryNonce" | "shardId" | "releaseId">): HostedFirstEntryCommit | undefined {
  if (identity.firstEntry?.status !== "pending" && identity.firstEntry?.status !== "entered") return undefined;
  const entryNonce = identity.entryNonce;
  const shardId = identity.shardId;
  const releaseId = identity.releaseId;
  if (!entryNonce || !shardId || !releaseId) return undefined;
  return { entryNonce, shardId, releaseId };
}

export async function commitHostedFirstEntry(
  characterId: string,
  contract: HostedFirstEntryCommit,
  logger?: TicketLogger,
): Promise<void> {
  const key = `${characterId}\u0000${contract.entryNonce}`;
  const existing = firstEntryCommitsInFlight.get(key);
  if (existing) return existing;
  const operation = performHostedFirstEntryCommit(characterId, contract, logger);
  firstEntryCommitsInFlight.set(key, operation);
  try {
    await operation;
  } finally {
    if (firstEntryCommitsInFlight.get(key) === operation) firstEntryCommitsInFlight.delete(key);
  }
}

async function performHostedFirstEntryCommit(characterId: string, contract: HostedFirstEntryCommit, logger?: TicketLogger): Promise<void> {
  const credentials = runtimeCredentials();
  if (hostedRuntime() && !credentials) {
    logFailure(logger, "first_entry_contract");
    throw new Error("hosted first-entry commit credentials unavailable");
  }
  if (!credentials) {
    logFailure(logger, "first_entry_contract");
    throw new Error("first-entry commit is unavailable without hosted runtime credentials");
  }
  const url = `${(process.env.SUCCESSOR_SITE_URL?.trim() || DEFAULT_SUCCESSOR_SITE_URL).replace(/\/+$/u, "")}${FIRST_ENTRY_COMMIT_PATH}/${encodeURIComponent(characterId)}/commit`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: runtimeHeaders(credentials, contract),
      body: JSON.stringify(contract),
      signal: AbortSignal.timeout(2500),
    });
  } catch (error) {
    logFailure(logger, error instanceof DOMException && error.name === "TimeoutError" ? "timeout" : "first_entry_commit");
    throw new Error("hosted first-entry commit request failed", { cause: error });
  }
  if (!response.ok) {
    logFailure(logger, `http_${Math.max(100, Math.min(599, response.status))}`);
    throw new Error("hosted first-entry commit was rejected");
  }
  let body: unknown;
  try { body = await response.json(); } catch (error) {
    logFailure(logger, "invalid_json");
    throw new Error("hosted first-entry commit response was invalid", { cause: error });
  }
  const parsed = launchTicketFirstEntrySchema.safeParse(
    isRecord(body) && isRecord(body.firstEntry) ? body.firstEntry : body,
  );
  if (!parsed.success || parsed.data.status !== "entered") {
    logFailure(logger, "invalid_schema");
    throw new Error("hosted first-entry commit did not enter the character");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
