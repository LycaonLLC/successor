/**
 * CHAT — the social strip. Channel-tagged lines from the chat hub, own
 * scrollback, unread counter while the strip is short. Whispers glow.
 */

import type { ChatMessage } from "@successor/client/src/chat/chatClient";
import type { Surface, Style } from "../term/surface";
import { wrapText } from "../term/surface";
import type { Palette, Rect } from "./styles";

const CAPACITY = 200;

export class ChatPane {
  private readonly messages: ChatMessage[] = [];
  private unread = 0;

  push(message: ChatMessage): void {
    // Same-id dedupe (chatClient's own rule) — hub reconnect history replays
    // must not double a line the reader already has.
    if (this.messages.some((existing) => existing.id === message.id)) return;
    this.messages.push(message);
    if (this.messages.length > CAPACITY) this.messages.splice(0, this.messages.length - CAPACITY);
    this.unread += 1;
  }

  markRead(): void {
    this.unread = 0;
  }

  render(surface: Surface, rect: Rect, palette: Palette): void {
    if (rect.h < 1 || rect.w < 12) return;
    this.unread = 0;
    const rows: Array<{ text: string; style: Style }> = [];
    for (let i = this.messages.length - 1; i >= 0 && rows.length < rect.h; i -= 1) {
      const message = this.messages[i]!;
      const tag = message.system ? "sys" : message.channel;
      const line = message.system
        ? `· ${message.body}`
        : `[${tag}] ${message.sender.displayName}: ${message.body}`;
      const style = message.system
        ? palette.faint
        : message.channel === "whisper"
          ? palette.amber
          : message.channel === "system"
            ? palette.faint
            : palette.ink;
      const wrapped = wrapText(line, rect.w - 1, 2);
      for (let r = wrapped.length - 1; r >= 0; r -= 1) rows.push({ text: wrapped[r]!, style });
    }
    let y = rect.y + rect.h - 1;
    for (let r = 0; r < rows.length && y >= rect.y; r += 1, y -= 1) {
      surface.text(rect.x, y, rows[r]!.text, rows[r]!.style, rect.x + rect.w);
    }
    if (this.messages.length === 0) {
      surface.text(rect.x, rect.y + rect.h - 1, "chat quiet", palette.faint);
    }
  }
}
