import { describe, expect, it } from "vitest";

import {
  assertFrameSize,
  changedCellCount,
  createFrame,
  diffFrames,
  frameToSnapshot,
  writeText,
} from "./frameSnapshot";

describe("terminal frame snapshot substrate", () => {
  it("renders fixed 80x24 and 100x30 snapshots with visible cell boundaries", () => {
    const eighty = createFrame({ columns: 80, rows: 24 });
    writeText(eighty, 0, 0, "SUCCESSOR");
    writeText(eighty, 2, 23, "> /where");

    const hundred = createFrame({ columns: 100, rows: 30 });
    writeText(hundred, 0, 0, "SUCCESSOR · OPEN DESERT THEATRE");
    writeText(hundred, 2, 29, "> /queue");

    assertFrameSize(eighty, { columns: 80, rows: 24 });
    assertFrameSize(hundred, { columns: 100, rows: 30 });
    expect(frameToSnapshot(eighty).split("\n")[0]).toBe("# 80x24");
    expect(frameToSnapshot(hundred).split("\n")[0]).toBe("# 100x30");
    expect(frameToSnapshot(eighty)).toContain("|SUCCESSOR");
    expect(frameToSnapshot(eighty)).toContain("/where");
  });

  it("diffs changed cells as row-local runs instead of repainting the full screen", () => {
    const previous = createFrame({ columns: 20, rows: 4 });
    const next = createFrame({ columns: 20, rows: 4 });
    writeText(previous, 0, 0, "HP 096");
    writeText(next, 0, 0, "HP 084");
    writeText(next, 2, 2, "FIRED", { fg: "green", bold: true });

    const runs = diffFrames(previous, next);

    expect(runs).toEqual([
      { row: 0, startColumn: 4, cells: [{ ch: "8" }, { ch: "4" }] },
      {
        row: 2,
        startColumn: 2,
        cells: [
          { ch: "F", fg: "green", bold: true },
          { ch: "I", fg: "green", bold: true },
          { ch: "R", fg: "green", bold: true },
          { ch: "E", fg: "green", bold: true },
          { ch: "D", fg: "green", bold: true },
        ],
      },
    ]);
    expect(changedCellCount(runs)).toBe(7);
  });
});
