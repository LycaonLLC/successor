import { z } from "zod";

export const chatChannels = ["local", "zone", "global", "trade", "party", "guild", "whisper", "system"] as const;
export type ChatChannel = (typeof chatChannels)[number];

export const presenceStates = ["online", "away", "busy", "offline"] as const;
export type PresenceState = (typeof presenceStates)[number];

export const clientSendMessageSchema = z.object({
  type: z.literal("chat.send"),
  requestId: z.string().min(1).max(64).optional(),
  channel: z.enum(["local", "zone", "global", "trade", "party", "guild", "whisper"]),
  body: z.string(),
  targetId: z.string().min(1).max(64).optional(),
});

export const clientFriendAddSchema = z.object({
  type: z.literal("friend.add"),
  requestId: z.string().min(1).max(64).optional(),
  friendId: z.string().min(1).max(64),
});

export const clientFriendRemoveSchema = z.object({
  type: z.literal("friend.remove"),
  requestId: z.string().min(1).max(64).optional(),
  friendId: z.string().min(1).max(64),
});

export const clientIgnoreAddSchema = z.object({
  type: z.literal("ignore.add"),
  requestId: z.string().min(1).max(64).optional(),
  targetId: z.string().min(1).max(64),
});

export const clientIgnoreRemoveSchema = z.object({
  type: z.literal("ignore.remove"),
  requestId: z.string().min(1).max(64).optional(),
  targetId: z.string().min(1).max(64),
});

export const clientPresenceSetSchema = z.object({
  type: z.literal("presence.set"),
  requestId: z.string().min(1).max(64).optional(),
  status: z.enum(["online", "away", "busy"]),
});

export const clientPingSchema = z.object({
  type: z.literal("ping"),
  requestId: z.string().min(1).max(64).optional(),
  at: z.number().finite().optional(),
});

export const clientPacketSchema = z.discriminatedUnion("type", [
  clientSendMessageSchema,
  clientFriendAddSchema,
  clientFriendRemoveSchema,
  clientIgnoreAddSchema,
  clientIgnoreRemoveSchema,
  clientPresenceSetSchema,
  clientPingSchema,
]);

export type ClientPacket = z.infer<typeof clientPacketSchema>;

export interface ChatUser {
  id: string;
  displayName: string;
}

export interface FriendPresence {
  id: string;
  displayName: string;
  status: PresenceState;
  since: string;
}

export interface ChatMessage {
  id: string;
  channel: ChatChannel;
  sender: ChatUser;
  body: string;
  sentAt: string;
  zoneId: string;
  targetId?: string;
  system: boolean;
}

export type ServerPacket =
  | {
      type: "chat.hello";
      sessionId: string;
      self: FriendPresence;
      channels: ChatChannel[];
      serverTime: string;
      policy: ChatPolicySnapshot;
    }
  | { type: "chat.message"; message: ChatMessage }
  | { type: "chat.history"; channel: ChatChannel; messages: ChatMessage[] }
  | { type: "chat.error"; code: string; message: string; requestId?: string }
  | { type: "friends.snapshot"; friends: FriendPresence[] }
  | { type: "friend.event"; friend: FriendPresence; action: "added" | "removed" }
  | { type: "presence.update"; user: FriendPresence; reason: "connect" | "disconnect" | "status" | "friend-add" }
  | { type: "pong"; requestId?: string; at: number };

export interface ChatPolicySnapshot {
  maxBodyLength: number;
  maxMessagesPerWindow: number;
  rateWindowMs: number;
  channels: Record<ChatChannel, { label: string; clientWritable: boolean; slowModeMs: number }>;
}
