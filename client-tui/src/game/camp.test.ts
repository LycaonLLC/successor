import { describe, expect, it } from "vitest";

import { createTuiPlayStateFixture } from "../../test/fixtures/playState";
import { campStatusLines, sheltered } from "./camp";

function withCamp(state: ReturnType<typeof createTuiPlayStateFixture>["state"], overrides: Record<string, unknown> = {}) {
  state.serverAuthority.placedCamps = [{
    campId: "camp:observer:1",
    areaId: "open-desert",
    cellX: 40,
    cellY: 44,
    isOwner: true,
    renderKind: "pod-tent",
    ...overrides,
  } as (typeof state.serverAuthority.placedCamps)[number]];
}

describe("/camp status over the placedCamps stream", () => {
  it("bare ground steers to the pitch verb", () => {
    const { state } = createTuiPlayStateFixture();
    const text = campStatusLines(state).map((line) => line.text).join("\n");
    expect(text).toContain("No camp on this ground");
    expect(text).toContain("/camp pitch");
  });

  it("standing camp speaks persistence; the shelter box speaks over you", () => {
    const { state } = createTuiPlayStateFixture();
    withCamp(state); // player fixture stands at 40,44 — inside the box
    const text = campStatusLines(state).map((line) => line.text).join("\n");
    expect(text).toContain("under your canvas");
    expect(text).toContain("persists while you camp here");
    expect(text).toContain("The canvas holds over you — you are sheltered.");
    expect(sheltered(state)).toBe(true);
  });

  it("abandoned camp counts down honestly with bearing", () => {
    const { state } = createTuiPlayStateFixture();
    withCamp(state, { cellX: 52, cellY: 44, abandonSecondsRemaining: 898 });
    const text = campStatusLines(state).map((line) => line.text).join("\n");
    expect(text).toMatch(/Your camp stands \S+ 12c — abandoned, collapses in 14:58/);
    expect(text).toContain("Returning resets it.");
    expect(sheltered(state)).toBe(false);
  });

  it("foreign camps are presence only", () => {
    const { state } = createTuiPlayStateFixture();
    state.serverAuthority.placedCamps = [{
      campId: "camp:rusk:1", areaId: "open-desert", cellX: 60, cellY: 44, isOwner: false, renderKind: "pod-tent",
    } as (typeof state.serverAuthority.placedCamps)[number]];
    const text = campStatusLines(state).map((line) => line.text).join("\n");
    expect(text).toContain("Another camp on this stretch — not yours to touch.");
    expect(text).toContain("No camp on this ground");
  });
});
