export interface TerminalSize {
  columns: number;
  rows: number;
}

export interface FrameCell {
  ch: string;
  fg?: string;
  bg?: string;
  bold?: boolean;
  dim?: boolean;
}

export type MutableTerminalFrame = FrameCell[][];
export type TerminalFrame = readonly (readonly FrameCell[])[];

export interface FrameDiffRun {
  row: number;
  startColumn: number;
  cells: FrameCell[];
}

const SPACE_CELL: FrameCell = { ch: " " };

export function createFrame(size: TerminalSize, fill: FrameCell | string = SPACE_CELL): MutableTerminalFrame {
  assertTerminalSize(size);
  const cell = typeof fill === "string" ? { ch: fill } : fill;
  return Array.from({ length: size.rows }, () => (
    Array.from({ length: size.columns }, () => ({ ...cell, ch: normalizeCellChar(cell.ch) }))
  ));
}

export function writeText(
  frame: MutableTerminalFrame,
  column: number,
  row: number,
  text: string,
  style: Omit<FrameCell, "ch"> = {},
): void {
  if (row < 0 || row >= frame.length) return;
  const line = frame[row];
  if (!line) return;
  for (let index = 0; index < text.length; index += 1) {
    const x = column + index;
    if (x < 0 || x >= line.length) continue;
    line[x] = { ...style, ch: normalizeCellChar(text[index] ?? " ") };
  }
}

export function frameSize(frame: TerminalFrame): TerminalSize {
  return { rows: frame.length, columns: frame[0]?.length ?? 0 };
}

export function assertFrameSize(frame: TerminalFrame, expected: TerminalSize): void {
  const actual = frameSize(frame);
  if (actual.columns !== expected.columns || actual.rows !== expected.rows) {
    throw new Error(`terminal frame size mismatch: expected ${expected.columns}x${expected.rows}, got ${actual.columns}x${actual.rows}`);
  }
  for (const [rowIndex, row] of frame.entries()) {
    if (row.length !== expected.columns) {
      throw new Error(`terminal frame row ${rowIndex} has ${row.length} columns, expected ${expected.columns}`);
    }
  }
}

export function frameToSnapshot(frame: TerminalFrame): string {
  const { columns, rows } = frameSize(frame);
  assertFrameSize(frame, { columns, rows });
  const lines = frame.map((row) => `|${row.map((cell) => visibleChar(cell.ch)).join("")}|`);
  return [`# ${columns}x${rows}`, ...lines].join("\n");
}

export function diffFrames(previous: TerminalFrame, next: TerminalFrame): FrameDiffRun[] {
  const size = frameSize(previous);
  assertFrameSize(previous, size);
  assertFrameSize(next, size);
  const runs: FrameDiffRun[] = [];
  for (let y = 0; y < size.rows; y += 1) {
    const prevRow = previous[y]!;
    const nextRow = next[y]!;
    let start = -1;
    let cells: FrameCell[] = [];
    const flush = (): void => {
      if (start < 0) return;
      runs.push({ row: y, startColumn: start, cells });
      start = -1;
      cells = [];
    };
    for (let x = 0; x < size.columns; x += 1) {
      if (sameCell(prevRow[x]!, nextRow[x]!)) {
        flush();
        continue;
      }
      if (start < 0) start = x;
      cells.push({ ...nextRow[x]! });
    }
    flush();
  }
  return runs;
}

export function changedCellCount(runs: readonly FrameDiffRun[]): number {
  return runs.reduce((total, run) => total + run.cells.length, 0);
}

function assertTerminalSize(size: TerminalSize): void {
  if (!Number.isInteger(size.columns) || !Number.isInteger(size.rows) || size.columns <= 0 || size.rows <= 0) {
    throw new Error(`invalid terminal size ${size.columns}x${size.rows}`);
  }
}

function normalizeCellChar(ch: string): string {
  if (ch.length === 0) return " ";
  return Array.from(ch)[0] ?? " ";
}

function visibleChar(ch: string): string {
  if (ch === " ") return "·";
  if (ch === "|") return "│";
  return ch;
}

function sameCell(left: FrameCell, right: FrameCell): boolean {
  return left.ch === right.ch
    && left.fg === right.fg
    && left.bg === right.bg
    && left.bold === right.bold
    && left.dim === right.dim;
}
