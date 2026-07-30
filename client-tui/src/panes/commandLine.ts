/**
 * COMMAND LINE — the player's hand.
 *
 * Line editor (history, cursor, kill-to-start/end), tab-completion over the
 * merged verb inventory with a ghost hint inline, and the right cluster:
 * ingress budget truth (sent/accepted/rejected + pending) with the last
 * receipt stamp. The caret is the real hardware cursor.
 */

import type { PlayState } from "@successor/client/src/slice-core/gameState";
import { reasonCopy } from "../language/copy";
import { stringWidth } from "../term/surface";
import type { Surface } from "../term/surface";
import type { Palette, Rect } from "./styles";

export interface CommandLine {
  buffer: string;
  cursor: number;
  history: string[];
  historyAt: number;
  /** Completion candidates for the current token + rotation index. */
  completions: string[];
  completionAt: number;
  ghost: string;
}

export function createCommandLine(): CommandLine {
  return { buffer: "", cursor: 0, history: [], historyAt: -1, completions: [], completionAt: -1, ghost: "" };
}

export function insertText(line: CommandLine, text: string): void {
  line.buffer = line.buffer.slice(0, line.cursor) + text + line.buffer.slice(line.cursor);
  line.cursor += text.length;
  resetCompletion(line);
}

export function backspace(line: CommandLine): void {
  if (line.cursor === 0) return;
  line.buffer = line.buffer.slice(0, line.cursor - 1) + line.buffer.slice(line.cursor);
  line.cursor -= 1;
  resetCompletion(line);
}

export function deleteForward(line: CommandLine): void {
  line.buffer = line.buffer.slice(0, line.cursor) + line.buffer.slice(line.cursor + 1);
  resetCompletion(line);
}

export function moveCursor(line: CommandLine, delta: number): void {
  line.cursor = Math.max(0, Math.min(line.buffer.length, line.cursor + delta));
}

export function killToStart(line: CommandLine): void {
  line.buffer = line.buffer.slice(line.cursor);
  line.cursor = 0;
  resetCompletion(line);
}

export function killToEnd(line: CommandLine): void {
  line.buffer = line.buffer.slice(0, line.cursor);
  resetCompletion(line);
}

export function historyStep(line: CommandLine, direction: -1 | 1): void {
  if (line.history.length === 0) return;
  if (line.historyAt === -1 && direction === -1) line.historyAt = line.history.length;
  line.historyAt = Math.max(0, Math.min(line.history.length, line.historyAt + direction));
  line.buffer = line.historyAt >= line.history.length ? "" : line.history[line.historyAt] ?? "";
  line.cursor = line.buffer.length;
  resetCompletion(line);
}

export function commit(line: CommandLine): string {
  const value = line.buffer;
  if (value.trim().length > 0 && line.history[line.history.length - 1] !== value) {
    line.history.push(value);
    if (line.history.length > 100) line.history.splice(0, line.history.length - 100);
  }
  line.buffer = "";
  line.cursor = 0;
  line.historyAt = -1;
  resetCompletion(line);
  return value;
}

/** Tab: complete the leading verb token from the merged inventory. */
export function completeVerb(line: CommandLine, verbs: readonly string[]): void {
  const match = /^\/([a-z0-9-]*)$/i.exec(line.buffer.slice(0, line.cursor));
  if (!match) return;
  const prefix = match[1]!.toLowerCase();
  if (line.completions.length === 0) {
    line.completions = verbs.filter((verb) => verb.startsWith(prefix)).sort();
    line.completionAt = -1;
  }
  if (line.completions.length === 0) return;
  line.completionAt = (line.completionAt + 1) % line.completions.length;
  const verb = line.completions[line.completionAt]!;
  line.buffer = `/${verb}${line.buffer.slice(line.cursor)}`;
  line.cursor = verb.length + 1;
}

function resetCompletion(line: CommandLine): void {
  line.completions = [];
  line.completionAt = -1;
  line.ghost = "";
}

/** Ghost hint: the alphabetically-first verb completing the current token. */
export function updateGhost(line: CommandLine, verbs: readonly string[]): void {
  const match = /^\/([a-z0-9-]+)$/i.exec(line.buffer);
  if (!match || line.cursor !== line.buffer.length) {
    line.ghost = "";
    return;
  }
  const prefix = match[1]!.toLowerCase();
  const hit = verbs.filter((verb) => verb.startsWith(prefix) && verb !== prefix).sort()[0];
  line.ghost = hit ? hit.slice(prefix.length) : "";
}

export interface CommandLineRender {
  cursorRow: number;
  cursorCol: number;
}

export function renderCommandLine(
  surface: Surface,
  rect: Rect,
  line: CommandLine,
  state: PlayState,
  palette: Palette,
): CommandLineRender {
  surface.text(rect.x, rect.y, ">", palette.accentBold);
  const inputX = rect.x + 2;

  // right cluster: budget truth + last receipt stamp
  const sa = state.serverAuthority;
  const pending = state.authorityCommands.pending.length;
  const last = sa.lastReceipt;
  const stamp = last
    ? last.accepted ? `ok ${last.commandId}` : reasonCopy(last.reasonCode ?? "rejected")
    : "—";
  const cluster = `${sa.acceptedCommands}✓ ${sa.rejectedCommands}✗${pending > 0 ? ` ${pending}…` : ""} · ${stamp}`;
  const clusterW = stringWidth(cluster);
  const clusterX = rect.x + rect.w - clusterW - 1;
  const inputW = Math.max(8, clusterX - inputX - 2);

  // window the buffer around the cursor
  const windowStart = Math.max(0, line.cursor - inputW + 1);
  const visible = line.buffer.slice(windowStart, windowStart + inputW);
  const afterInput = surface.text(inputX, rect.y, visible, palette.ink, inputX + inputW);
  if (line.ghost && line.cursor === line.buffer.length) {
    surface.text(afterInput, rect.y, line.ghost, palette.faint, inputX + inputW);
  }
  if (clusterX > inputX) {
    surface.text(clusterX, rect.y, cluster, last && !last.accepted ? palette.oxide : palette.faint, rect.x + rect.w);
  }
  return { cursorRow: rect.y, cursorCol: inputX + Math.min(inputW - 1, line.cursor - windowStart) };
}
