import { open } from "node:fs/promises";
import { createGameSession } from "./game/session";
import { declaredSliceActorCount, type PlayState, type SliceSnapshot } from "@successor/client/src/slice-core/gameState";

interface RcProbeInput {
  gameTicket: string;
  endpoint: string;
  origin: string;
  characterId: string;
  slicePath: string;
}

export type RcProbeReasonClass = "input" | "session-start" | "authority-timeout" | "probe-crash";

export interface RcProbeResult {
  type: "successor.tui.world-ready.v1";
  status: "pass" | "fail";
  authorityConnected: boolean;
  tickPositive: boolean;
  identityMatch: boolean;
  sourceMatchesClient: boolean;
  reasonClass?: RcProbeReasonClass;
}

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{20,128}$/u;
const ENDPOINT_PATTERN = /^wss?:\/\/127\.0\.0\.1:[0-9]+$/u;
const ORIGIN_PATTERN = /^https:\/\/127\.0\.0\.1:[0-9]+$/u;
const PROBE_TIMEOUT_MS = 30_000;

type RcProbeAuthority = Pick<PlayState["serverAuthority"], "sourceStateHash" | "sourceActorCount" | "sourceMatchesClient">;

export function rcProbeSourceMatchesClient(
  authority: RcProbeAuthority,
  slice: Pick<SliceSnapshot, "stateHash" | "actors" | "spawnZones">,
): boolean {
  return authority.sourceMatchesClient === true
    && typeof authority.sourceStateHash === "string"
    && authority.sourceStateHash.length > 0
    && typeof authority.sourceActorCount === "number"
    && Number.isFinite(authority.sourceActorCount)
    && Number.isInteger(authority.sourceActorCount)
    && authority.sourceStateHash === slice.stateHash
    && authority.sourceActorCount === declaredSliceActorCount(slice);
}

export async function runRcWorldProbeFromFd(fd: number): Promise<RcProbeResult> {
  let input: RcProbeInput;
  try {
    const handle = await open(`/proc/self/fd/${fd}`, "r");
    try { input = parseInput(JSON.parse(await handle.readFile("utf8"))); } finally { await handle.close(); }
  } catch {
    throw Object.assign(new Error("probe input invalid"), { reasonClass: "input" as const });
  }
  let session;
  try { session = await createGameSession({
    endpoint: input.endpoint,
    slicePath: input.slicePath,
    playerId: input.characterId,
    actorId: input.characterId,
    characterId: input.characterId,
    gameTicket: input.gameTicket,
    origin: input.origin,
    chatUrl: undefined,
    readyTimeoutMs: PROBE_TIMEOUT_MS,
  });
    await session.start();
  } catch { throw Object.assign(new Error("session start failed"), { reasonClass: "session-start" as const }); }
  try {
    const deadline = Date.now() + PROBE_TIMEOUT_MS;
    while (Date.now() <= deadline) {
      const authority = session.state.serverAuthority;
      const authorityConnected = authority.connected === true && authority.status === "connected";
      const tickPositive = Number(authority.snapshotTick) > 0;
      const identityMatch = authority.playerActorId === input.characterId;
      const sourceMatchesClient = rcProbeSourceMatchesClient(authority, session.slice);
      if (authorityConnected && tickPositive && identityMatch && sourceMatchesClient) {
        return { type: "successor.tui.world-ready.v1", status: "pass", authorityConnected, tickPositive, identityMatch, sourceMatchesClient };
      }
      const delay = Promise.withResolvers<void>();
      setTimeout(delay.resolve, 50);
      await delay.promise;
    }
    const authority = session.state.serverAuthority;
    return {
      type: "successor.tui.world-ready.v1",
      status: "fail",
      authorityConnected: authority.connected === true && authority.status === "connected",
      tickPositive: Number(authority.snapshotTick) > 0,
      identityMatch: authority.playerActorId === input.characterId,
      sourceMatchesClient: rcProbeSourceMatchesClient(authority, session.slice),
    };
  } finally {
    await session.dispose();
  }
}

function parseInput(value: unknown): RcProbeInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("probe input invalid");
  const record = value as Record<string, unknown>;
  if (typeof record.gameTicket !== "string" || !TOKEN_PATTERN.test(record.gameTicket)) throw new Error("probe capability invalid");
  if (typeof record.endpoint !== "string" || !ENDPOINT_PATTERN.test(record.endpoint)) throw new Error("probe endpoint invalid");
  if (typeof record.origin !== "string" || !ORIGIN_PATTERN.test(record.origin)) throw new Error("probe origin invalid");
  if (typeof record.characterId !== "string" || record.characterId.length < 1 || record.characterId.length > 64) throw new Error("probe identity invalid");
  if (typeof record.slicePath !== "string" || record.slicePath.length < 1 || record.slicePath.length > 512) throw new Error("probe slice invalid");
  return { gameTicket: record.gameTicket, endpoint: record.endpoint, origin: record.origin, characterId: record.characterId, slicePath: record.slicePath };
}
