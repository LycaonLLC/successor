import { describe, expect, it } from "vitest";

import type { PlayState, SliceSnapshot } from "@successor/client/src/slice-core/gameState";

import { createTuiPlayStateFixture } from "../../test/fixtures/playState";
import { createConverseSession } from "./converse";

/** Seat a marksman trainer beside the player (slice identity + AOI stream). */
function withTrainer(state: PlayState, slice: SliceSnapshot, x = 41, y = 44): void {
  slice.actors.push({
    id: "camp-trainer",
    entity: "actor/trainer",
    areaId: "open-desert",
    label: "Vex",
    role: "profession_trainer",
    professionIds: ["marksman"],
    sprite: "adventurer-premium-male",
    poseSet: "walk",
    direction: "front",
    cell: { x, y },
    route: [],
  });
  state.serverAuthority.actors["camp-trainer"] = {
    ...state.serverAuthority.actors["civilian-1"]!,
    id: "camp-trainer",
    label: "Vex",
    role: "profession_trainer",
    x,
    y,
  };
}

describe("/converse", () => {
  it("opens the nearest trainer as numbered dialogue with a leave option", () => {
    const { state, slice } = createTuiPlayStateFixture();
    withTrainer(state, slice);
    const converse = createConverseSession(state, slice);
    const lines = converse.open(undefined);
    const text = lines.map((line) => line.text).join("\n");
    expect(text).toContain("⟨Vex⟩");
    expect(text).toMatch(/ 1\. /);
    expect(text).toContain(" 0. Leave.");
    expect(converse.active()).toBe(true);
  });

  it("refuses politely when no trainer exists or the trainer is out of range", () => {
    const { state, slice } = createTuiPlayStateFixture();
    const converse = createConverseSession(state, slice);
    expect(converse.open(undefined)[0]!.register).toBe("reject");
    withTrainer(state, slice, 60, 60); // ~25c away
    const lines = createConverseSession(state, slice).open(undefined);
    expect(lines[0]!.text).toMatch(/step within/);
  });

  it("selects numbered options; goto renders the next node; 0 leaves with a beat", () => {
    const { state, slice } = createTuiPlayStateFixture();
    withTrainer(state, slice);
    const converse = createConverseSession(state, slice);
    const opening = converse.open(undefined).map((line) => line.text).join("\n");
    const next = converse.select(1);
    expect(next.length).toBeGreaterThan(0);
    expect(next.map((line) => line.text).join("\n")).not.toBe(opening);
    const leave = converse.select(0);
    expect(leave[0]!.text).toMatch(/turns back to their work/);
    expect(converse.active()).toBe(false);
  });

  it("out-of-range ticks end the conversation with the exit beat", () => {
    const { state, slice } = createTuiPlayStateFixture();
    withTrainer(state, slice);
    const converse = createConverseSession(state, slice);
    converse.open(undefined);
    expect(converse.tick()).toEqual([]);
    state.serverAuthority.actors["camp-trainer"]!.x = 90; // walks away
    const lines = converse.tick();
    expect(lines[0]!.text).toMatch(/turns back/);
    expect(converse.active()).toBe(false);
  });

  it("out-of-band selections and unknown numbers stay honest", () => {
    const { state, slice } = createTuiPlayStateFixture();
    withTrainer(state, slice);
    const converse = createConverseSession(state, slice);
    converse.open(undefined);
    expect(converse.select(99)[0]!.text).toMatch(/no 99 on offer/);
  });
});
