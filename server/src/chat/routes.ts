import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { resolveLaunchTicketIdentity, type TicketLogger } from "../auth/tickets.js";
import { redeemStandaloneLaunch, type StandaloneLaunchStore } from "../auth/standalone.js";
import type { RuntimeAuthConfig } from "../auth/runtime.js";
import { originMatches, trustedNativeOrigin } from "../auth/runtime.js";
import { normalizeDisplayName, normalizeUserId } from "./policy.js";
import { devIdentityAllowed } from "../game/colyseusRoom.js";
import type { CharacterStore } from "../game/characterStore.js";
import { ChatHub, type ChatSocket } from "./hub.js";

const standaloneAuthenticateSchema = z.object({
  type: z.literal("chat.authenticate"),
  chatTicket: z.string().min(32).max(256),
  release: z.string().trim().min(1).max(128),
}).strict();
const CHAT_AUTH_FRAME_MAX_BYTES = 1_024;

export interface ChatRoutesOptions {
  hub: ChatHub;
  logger?: TicketLogger;
  runtimeAuth?: RuntimeAuthConfig;
  controlStore?: StandaloneLaunchStore;
  characterStore?: CharacterStore;
}

export async function registerChatRoutes(app: FastifyInstance, options: ChatRoutesOptions): Promise<void> {
  const { hub, logger, runtimeAuth, controlStore, characterStore } = options;
  app.get("/chat/status", async () => {
    const snapshot = hub.snapshot();
    const friendWatcherCount = Object.values(snapshot.groups.friendWatchers).reduce((total, count) => total + count, 0);
    return { ...snapshot, groups: { ...snapshot.groups, friendWatchers: friendWatcherCount } };
  });

  app.get("/chat/ws", { websocket: true }, async (socket, request) => {
    if (runtimeAuth?.mode === "standalone" && (
      !runtimeAuth.origin
      || !runtimeAuth.clientOrigin
      || (!originMatches(request.headers.origin, [runtimeAuth.origin, runtimeAuth.clientOrigin]) && !trustedNativeOrigin(request.headers.origin))
    )) {
      socket.close(1008, "origin not allowed");
      return;
    }
    const query = request.query as Record<string, string | undefined>;
    if (runtimeAuth?.mode === "standalone") {
      await authenticateStandaloneSocket(socket, hub, runtimeAuth, controlStore, characterStore);
      return;
    }
    const ticket = query.ticket?.trim();
    if (ticket) {
      const identity = await resolveLaunchTicketIdentity(ticket, logger);
      if (!identity) { socket.close(1008, "invalid launch ticket"); return; }
      hub.connect(socket, { ...identity, userId: normalizeUserId(identity.player.characterId) });
      return;
    }
    if (!devIdentityAllowed()) { socket.close(1008, "session ticket required"); return; }
    const userId = normalizeUserId(query.playerId ?? query.userId ?? "");
    const displayName = normalizeDisplayName(query.displayName ?? "", userId || "Guest");
    const zoneId = normalizeUserId(query.zoneId ?? query.zone ?? "open-desert") || "open-desert";
    const partyId = query.partyId ? normalizeUserId(query.partyId) : undefined;
    const devOnlyGuildId = query.guildId ? normalizeUserId(query.guildId) : undefined;
    if (!userId) { socket.close(1008, "playerId required"); return; }
    hub.connect(socket, { userId, displayName, zoneId, partyId }, { devOnlyGuildId });
  });
}

async function authenticateStandaloneSocket(
  socket: ChatSocket,
  hub: ChatHub,
  runtimeAuth: RuntimeAuthConfig,
  controlStore: StandaloneLaunchStore | undefined,
  characterStore: CharacterStore | undefined,
): Promise<void> {
  if (!controlStore || !characterStore) { socket.close(1011, "standalone chat is unavailable"); return; }
  let settled = false;
  const timeout = setTimeout(() => {
    if (settled) return;
    settled = true;
    socket.close(1008, "chat authentication timeout");
  }, 5_000);
  socket.on("close", () => clearTimeout(timeout));
  socket.on("message", (data) => {
    if (settled) return;
    settled = true;
    clearTimeout(timeout);
    void (async () => {
      const parsed = standaloneAuthenticateSchema.safeParse(parseFrame(data));
      if (!parsed.success) { socket.close(1008, "chat authentication required"); return; }
      try {
        const identity = await redeemStandaloneLaunch(parsed.data.chatTicket, "chat", controlStore, characterStore, runtimeAuth, undefined, parsed.data.release);
        // The URL/query was intentionally never consulted; only the bounded
        // first frame supplies the one-use chat capability.
        const hubIdentity = { ...identity, userId: normalizeUserId(identity.characterId) };
        hub.connect(socket, hubIdentity);
      } catch {
        socket.close(1008, "invalid chat ticket");
      }
    })();
  });
}

function parseFrame(data: unknown): unknown {
  const raw = Buffer.isBuffer(data) ? data : Buffer.from(String(data), "utf8");
  if (raw.byteLength > CHAT_AUTH_FRAME_MAX_BYTES) return null;
  try { return JSON.parse(raw.toString("utf8")); } catch { return null; }
}
