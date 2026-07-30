import type { ChatChannel, ChatPolicySnapshot } from "./protocol.js";

export const maxBodyLength = 320;
export const rateWindowMs = 4_000;
export const maxMessagesPerWindow = 8;
export const maxHistoryPerChannel = 80;

export const channelPolicy: ChatPolicySnapshot["channels"] = {
  local: { label: "Local", clientWritable: true, slowModeMs: 0 },
  zone: { label: "Zone", clientWritable: true, slowModeMs: 450 },
  global: { label: "Global", clientWritable: true, slowModeMs: 900 },
  trade: { label: "Trade", clientWritable: true, slowModeMs: 1_500 },
  party: { label: "Party", clientWritable: true, slowModeMs: 0 },
  guild: { label: "Guild", clientWritable: true, slowModeMs: 0 },
  whisper: { label: "Whisper", clientWritable: true, slowModeMs: 0 },
  system: { label: "System", clientWritable: false, slowModeMs: 0 },
};

export const policySnapshot: ChatPolicySnapshot = {
  maxBodyLength,
  maxMessagesPerWindow,
  rateWindowMs,
  channels: channelPolicy,
};

const blockedTerms = ["badword", "scamlink"];
const urlPattern = /\b(?:https?:\/\/|www\.)\S+/iu;

export interface ModerationResult {
  ok: boolean;
  body?: string;
  code?: string;
  message?: string;
}

export function normalizeUserId(value: string): string {
  return value
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 64);
}

export function normalizeDisplayName(value: string, fallback: string): string {
  const normalized = stripControlCharacters(value.normalize("NFKC")).trim().replace(/\s+/gu, " ");
  return (normalized || fallback).slice(0, 32);
}

export function normalizeChatBody(value: string): string {
  return stripControlCharacters(value.normalize("NFKC")).trim().replace(/\s+/gu, " ");
}

export function moderateChatBody(value: string, channel: ChatChannel): ModerationResult {
  const body = normalizeChatBody(value);
  if (!body) {
    return { ok: false, code: "empty", message: "Message was empty." };
  }
  if (body.length > maxBodyLength) {
    return { ok: false, code: "too_long", message: `Message exceeds ${maxBodyLength} characters.` };
  }
  if (urlPattern.test(body)) {
    return { ok: false, code: "url_blocked", message: "Links are disabled in chat for this slice." };
  }
  const lowered = body.toLowerCase();
  if (blockedTerms.some((term) => lowered.includes(term))) {
    return { ok: false, code: "blocked_term", message: "Message blocked by local chat rules." };
  }
  if (channel === "trade" && body.length < 4) {
    return { ok: false, code: "trade_too_short", message: "Trade messages need a little more detail." };
  }
  return { ok: true, body };
}

function stripControlCharacters(value: string): string {
  let output = "";
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (code <= 8 || code === 11 || code === 12 || (code >= 14 && code <= 31) || code === 127) {
      continue;
    }
    output += char;
  }
  return output;
}
