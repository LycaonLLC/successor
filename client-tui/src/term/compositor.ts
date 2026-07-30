/**
 * Compositor — double-buffered damage diff → minimal ANSI byte stream.
 *
 * One synchronized-output frame per render: move to each damaged run, emit
 * only SGR transitions, write the run. Continuation cells (wide glyphs) are
 * skipped — their lead cell wrote both columns.
 */

import {
  beginSync,
  clearScreen,
  cursorTo,
  DEFAULT_COLOR,
  endSync,
  resetSgr,
  sgrTransition,
} from "./ansi";
import { Surface } from "./surface";
import type { ColorMode } from "../theme";

const CONTINUATION = "\u0000";

export class Compositor {
  private previous: Surface | null = null;
  private cursorRow = -1;
  private cursorCol = -1;
  private sgrFg = DEFAULT_COLOR;
  private sgrBg = DEFAULT_COLOR;
  private sgrAttrs = 0;

  constructor(
    private readonly write: (chunk: string) => void,
    private readonly mode: ColorMode,
  ) {}

  /** Force the next frame to repaint every cell (resize, alt-screen entry). */
  invalidate(): void {
    this.previous = null;
  }

  /**
   * Diff `next` against the previous frame and emit the damage. Optionally
   * parks the hardware cursor at (cursorRow, cursorCol) and shows it there
   * (the command line's caret); otherwise the cursor stays where the last
   * run left it (hidden by the app shell).
   */
  render(next: Surface, cursor?: { row: number; col: number }): void {
    const parts: string[] = [beginSync];
    const prev = this.previous;
    if (!prev || prev.width !== next.width || prev.height !== next.height) {
      parts.push(resetSgr, clearScreen);
      this.sgrFg = DEFAULT_COLOR;
      this.sgrBg = DEFAULT_COLOR;
      this.sgrAttrs = 0;
      this.cursorRow = 0;
      this.cursorCol = 0;
    }

    for (let y = 0; y < next.height; y += 1) {
      const rowBase = y * next.width;
      let x = 0;
      while (x < next.width) {
        const i = rowBase + x;
        if (prev && prev.width === next.width && prev.height === next.height && cellEqual(prev, next, i)) {
          x += 1;
          continue;
        }
        if (next.chars[i] === CONTINUATION) {
          x += 1;
          continue;
        }
        // damaged run start — position cursor
        if (this.cursorRow !== y || this.cursorCol !== x) {
          parts.push(cursorTo(y, x));
          this.cursorRow = y;
          this.cursorCol = x;
        }
        // extend the run while damage continues
        while (x < next.width) {
          const j = rowBase + x;
          if (prev && prev.width === next.width && prev.height === next.height && cellEqual(prev, next, j)) break;
          const ch = next.chars[j]!;
          if (ch === CONTINUATION) {
            x += 1;
            this.cursorCol += 1;
            continue;
          }
          const sgr = sgrTransition(this.mode, this.sgrFg, this.sgrBg, this.sgrAttrs, next.fg[j]!, next.bg[j]!, next.attrs[j]!);
          if (sgr) {
            parts.push(sgr);
            this.sgrFg = next.fg[j]!;
            this.sgrBg = next.bg[j]!;
            this.sgrAttrs = next.attrs[j]!;
          }
          parts.push(ch);
          x += 1;
          this.cursorCol += ch === CONTINUATION ? 1 : 1;
          if (this.cursorCol >= next.width) break;
        }
      }
    }

    if (cursor) {
      parts.push(cursorTo(cursor.row, cursor.col));
      this.cursorRow = cursor.row;
      this.cursorCol = cursor.col;
    }
    parts.push(endSync);
    this.write(parts.join(""));
    this.previous = snapshot(next);
  }
}

function cellEqual(a: Surface, b: Surface, i: number): boolean {
  return a.chars[i] === b.chars[i] && a.fg[i] === b.fg[i] && a.bg[i] === b.bg[i] && a.attrs[i] === b.attrs[i];
}

function snapshot(from: Surface): Surface {
  const copy = new Surface(from.width, from.height);
  for (let i = 0; i < from.chars.length; i += 1) copy.chars[i] = from.chars[i]!;
  copy.fg.set(from.fg);
  copy.bg.set(from.bg);
  copy.attrs.set(from.attrs);
  return copy;
}

/** Render a surface to plain text rows — the snapshot-test format. */
export function surfaceToText(surface: Surface): string {
  const rows: string[] = [];
  for (let y = 0; y < surface.height; y += 1) {
    let row = "";
    for (let x = 0; x < surface.width; x += 1) {
      const ch = surface.chars[y * surface.width + x]!;
      row += ch === CONTINUATION ? "" : ch;
    }
    rows.push(row.replace(/\s+$/u, ""));
  }
  return rows.join("\n");
}
