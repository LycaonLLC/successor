// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { createPlayState, type SliceSnapshot } from "@successor/client/src/slice-core/gameState";
import { sprintToggleEnabled, setSprintToggleEnabled } from "@successor/client/src/slice-core/movementSystem";
import { mountStatusPlate } from "./statusPlate";

function slice(): SliceSnapshot {
  return {
    schema: "test",
    tick: 1,
    tickRateHz: 20,
    combatModel: "roll",
    grid: { cellSizePx: 32 },
    zone: { id: 1, name: "Test", width: 24, height: 18, level: 0 },
    areas: [{ id: "open-desert-overworld", name: "Open Desert", kind: "overworld", width: 24, height: 18, level: 0 }],
    stateHash: "hash",
    camera: { followActor: "player", zoom: 1 },
    actors: [{
      id: "player",
      entity: "actor.player",
      areaId: "open-desert-overworld",
      label: "Field Observer",
      role: "player",
      sprite: "adventurer-premium-male",
      poseSet: "idle",
      direction: "right",
      cell: { x: 4, y: 5 },
      route: [],
    }],
    props: [],
    blockedCells: [],
    transitions: [],
    inventory: [],
    reservations: [],
    events: [],
  };
}

function authorityPlayer(sprintRecoveryLocked: boolean) {
  return {
    id: "player",
    label: "Field Observer",
    areaId: "open-desert-overworld",
    x: 4,
    y: 5,
    direction: "right" as const,
    lifeState: "alive" as const,
    lifecycleSeq: 1,
    vitals: { health: 100, action: 100, spirit: 100 },
    maxVitals: { health: 100, action: 100, spirit: 100 },
    bleed: { active: false, stackCount: 0, severity: 0, remainingMs: 0, ratesPerSecond: { health: 0, action: 0, spirit: 0 } },
    statuses: [],
    mobility: { sprintRecoveryLocked },
  };
}

async function nextFrame(): Promise<void> {
  // Executor form: this package's tsc lib predates Promise.withResolvers.
  await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
}

describe("status plate RUN toggle", () => {
  it("mounts an accessible off-state button and flips the persistent intent on click", async () => {
    const sliceSnapshot = slice();
    const state = createPlayState(sliceSnapshot);
    const shell = document.createElement("div");
    const plate = mountStatusPlate(shell, state, sliceSnapshot);

    const run = shell.querySelector<HTMLButtonElement>(".successor3d-run")!;
    expect(run).not.toBeNull();
    expect(run.tagName).toBe("BUTTON");
    expect(run.dataset.state).toBe("off");
    expect(run.getAttribute("aria-pressed")).toBe("false");

    run.click();
    expect(sprintToggleEnabled(state)).toBe(true);
    await nextFrame();
    await nextFrame();
    expect(run.dataset.state).toBe("on");
    expect(run.getAttribute("aria-pressed")).toBe("true");

    plate.dispose();
  });

  it("shows WINDED while the authority recovery lock holds and keeps the pressed intent", async () => {
    const sliceSnapshot = slice();
    const state = createPlayState(sliceSnapshot);
    state.serverAuthority.playerActorId = "player";
    state.serverAuthority.actors.player = authorityPlayer(true);
    setSprintToggleEnabled(state, true);
    const shell = document.createElement("div");
    const plate = mountStatusPlate(shell, state, sliceSnapshot);

    await nextFrame();
    await nextFrame();
    const run = shell.querySelector<HTMLButtonElement>(".successor3d-run")!;
    expect(run.dataset.state).toBe("locked");
    expect(run.getAttribute("aria-pressed")).toBe("true");
    expect(run.textContent).toContain("WINDED");

    // The sim clears the lock at full Action — the plate goes back to ON.
    state.serverAuthority.actors.player = authorityPlayer(false);
    await nextFrame();
    await nextFrame();
    expect(run.dataset.state).toBe("on");
    expect(run.textContent).toContain("RUN");

    plate.dispose();
  });
  it("stamps WINDED without inventing a pressed intent when the lock hits with run off", async () => {
    const sliceSnapshot = slice();
    const state = createPlayState(sliceSnapshot);
    state.serverAuthority.playerActorId = "player";
    state.serverAuthority.actors.player = authorityPlayer(true);
    const shell = document.createElement("div");
    const plate = mountStatusPlate(shell, state, sliceSnapshot);
    await nextFrame();
    await nextFrame();
    const run = shell.querySelector<HTMLButtonElement>(".successor3d-run")!;
    // Shift-held sprint drained Action with the toggle off: the lock is
    // real, the request is not — WINDED shows, aria-pressed stays false.
    expect(run.dataset.state).toBe("locked");
    expect(run.getAttribute("aria-pressed")).toBe("false");
    expect(run.textContent).toContain("WINDED");
    // Requesting run while winded records the intent without hiding the lock.
    run.click();
    expect(sprintToggleEnabled(state)).toBe(true);
    await nextFrame();
    await nextFrame();
    expect(run.dataset.state).toBe("locked");
    expect(run.getAttribute("aria-pressed")).toBe("true");
    plate.dispose();
  });
});

describe("status plate tags layout contract", () => {
  it("keeps the tags row before the HEALTH gauges so camp-collapse cannot cover vitals", async () => {
    const sliceSnapshot = slice();
    const state = createPlayState(sliceSnapshot);
    state.serverAuthority.playerActorId = "player";
    state.serverAuthority.actors.player = authorityPlayer(false);
    state.serverAuthority.placedCamps = [{
      campId: "camp_own",
      areaId: "open-desert-overworld",
      cellX: 4,
      cellY: 4,
      isOwner: true,
      renderKind: "scout-camp",
      abandonSecondsRemaining: 95,
    }];
    const shell = document.createElement("div");
    const plateCtrl = mountStatusPlate(shell, state, sliceSnapshot);
    await nextFrame();
    await nextFrame();
    const plate = shell.querySelector<HTMLElement>(".successor3d-plate")!;
    const tags = plate.querySelector<HTMLElement>(".successor3d-plate-tags")!;
    const gauges = plate.querySelector<HTMLElement>(".successor3d-gauges")!;
    const health = plate.querySelector<HTMLElement>('.successor3d-gauge[data-vital="health"]')!;
    expect(tags).not.toBeNull();
    expect(gauges).not.toBeNull();
    expect(health).not.toBeNull();
    // DOM order contract: tags are a prior sibling of gauges (in-flow stack),
    // never an overlay that can paint across the HEALTH row.
    expect(tags.compareDocumentPosition(gauges) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(gauges.contains(health)).toBe(true);
    const campdown = plate.querySelector<HTMLElement>('[data-ref="campdown"]')!;
    expect(campdown.hidden).toBe(false);
    expect(campdown.textContent).toContain("CAMP COLLAPSE");
    expect(campdown.textContent).toMatch(/\d/);
    plateCtrl.dispose();
  });
});
