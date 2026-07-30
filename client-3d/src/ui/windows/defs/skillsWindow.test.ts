// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import {
  createPlayState,
  type PlayState,
  type ServerAuthorityActorState,
  type ServerAuthorityProfessionState,
  type SliceSnapshot,
} from "@successor/client/src/slice-core/gameState";
import { skillNodeDefinitions } from "@successor/client/src/slice-core/progressionSystem";
import { createWindowManager, type WindowManager } from "../windowManager";
import {
  createSkillsWindowDefinition,
  skillNodeHoverText,
  skillNodeXp,
} from "./skillsWindow";

function fixtureSlice(): SliceSnapshot {
  return {
    schema: "successor.slice-core.v1",
    tick: 12,
    tickRateHz: 20,
    combatModel: "roll",
    grid: { cellSizePx: 32 },
    zone: { id: 1, name: "Open Desert", width: 40, height: 24, level: 0 },
    areas: [{ id: "desert", name: "Open Desert", kind: "overworld", width: 40, height: 24, level: 0 }],
    stateHash: "skills-unlearn-fixture",
    camera: { followActor: "player", zoom: 1 },
    actors: [
      {
        id: "player",
        entity: "actor/player",
        areaId: "desert",
        label: "Learner",
        role: "player",
        sprite: "adventurer-premium-male",
        poseSet: "walk",
        direction: "right",
        cell: { x: 4, y: 5 },
        route: [],
      },
      {
        id: "profession-trainer-01",
        entity: "actor/profession-trainer-01",
        areaId: "desert",
        label: "Vela Orr",
        role: "profession_trainer",
        capabilities: ["train:profession"],
        sprite: "adventurer-premium-female",
        poseSet: "walk",
        direction: "left",
        cell: { x: 5, y: 5 },
        route: [],
      },
    ],
    props: [],
    blockedCells: [],
    transitions: [],
    inventory: [],
    reservations: [],
    events: [],
  };
}

function authorityPlayer(skillBoxes: string[]): ServerAuthorityActorState {
  return {
    id: "player",
    label: "Learner",
    areaId: "desert",
    x: 4.5,
    y: 5.5,
    direction: "right",
    lifeState: "alive",
    lifecycleSeq: 0,
    vitals: { health: 100, action: 100, spirit: 100 },
    maxVitals: { health: 100, action: 100, spirit: 100 },
    bleed: {
      active: false,
      stackCount: 0,
      severity: 0,
      remainingMs: 0,
      ratesPerSecond: { health: 0, action: 0, spirit: 0 },
    },
    statuses: [],
    professions: [{
      id: "marksman",
      label: "Marksman",
      xp: 200,
      trackXp: { rifle: 200 },
      skillPoints: skillBoxes.includes("marksman-rifle-i") ? 24 : skillBoxes.length > 0 ? 16 : 0,
      skillBoxes,
    }],
    skillPointsUsed: skillBoxes.includes("marksman-rifle-i") ? 24 : skillBoxes.length > 0 ? 16 : 0,
    skillPointsCap: 250,
    credits: 5_000,
  } as ServerAuthorityActorState;
}

function mountSkills(skillBoxes: string[]): { manager: WindowManager; state: PlayState } {
  const slice = fixtureSlice();
  const state = createPlayState(slice);
  state.serverAuthority.playerActorId = "player";
  state.serverAuthority.snapshotTick = slice.tick;
  state.serverAuthority.actors.player = authorityPlayer(skillBoxes);
  state.selectedActorId = "profession-trainer-01";
  state.professionUi.selectedProfessionId = "marksman";
  const mount = document.createElement("div");
  document.body.appendChild(mount);
  const manager = createWindowManager({
    mount,
    state,
    slice,
    storageScope: `skills-unlearn-${Math.random()}`,
  });
  manager.register(createSkillsWindowDefinition());
  manager.open("skills");
  manager.update(0, 0);
  return { manager, state };
}

afterEach(() => {
  document.body.textContent = "";
  globalThis.localStorage?.clear();
});

describe("skills window per-box unlearn", () => {
  it("queues an owned leaf box unlearn through the selected nearby trainer", () => {
    const { manager, state } = mountSkills(["marksman-novice"]);
    const novice = manager.root.querySelector<HTMLButtonElement>(
      '[data-skill-box="marksman-novice"]',
    );

    expect(novice?.disabled).toBe(false);
    expect(novice?.dataset.action).toBe("unlearn");
    expect(novice?.textContent).toContain("UNLEARN · +16 SP");
    novice?.click();
    expect(state.authorityCommands.pending.at(-1)?.command).toEqual({
      UnlearnSkillBox: {
        skill_box_id: "marksman-novice",
        trainer_actor_id: "profession-trainer-01",
      },
    });
    manager.dispose();
  });

  it("blocks a prerequisite until its learned dependent is removed", () => {
    const { manager } = mountSkills(["marksman-novice", "marksman-rifle-i"]);
    const novice = manager.root.querySelector<HTMLButtonElement>(
      '[data-skill-box="marksman-novice"]',
    );
    const rifleOne = manager.root.querySelector<HTMLButtonElement>(
      '[data-skill-box="marksman-rifle-i"]',
    );

    expect(novice?.disabled).toBe(true);
    expect(novice?.title).toContain("Unlearn dependent boxes first");
    expect(rifleOne?.disabled).toBe(false);
    expect(rifleOne?.dataset.action).toBe("unlearn");
    manager.dispose();
  });

  it("does not synthesize novice ownership from a boxless banked-XP snapshot", () => {
    const { manager } = mountSkills([]);
    const novice = manager.root.querySelector<HTMLButtonElement>(
      '[data-skill-box="marksman-novice"]',
    );

    expect(novice?.dataset.action).toBe("train");
    expect(novice?.textContent).not.toContain("UNLEARN");
    manager.dispose();
  });
});

describe("skills window XP and unlock context", () => {
  const marksman = (
    xp: number,
    trackXp: Record<string, number> | undefined,
  ): ServerAuthorityProfessionState => ({
    id: "marksman",
    label: "Marksman",
    xp,
    trackXp,
    skillPoints: 16,
    skillBoxes: ["marksman-novice"],
  });

  it("fails closed for an absent track and caps visible progress by profession XP", () => {
    const rifle = skillNodeDefinitions.find((node) => node.id === "marksman-rifle-i")!;

    expect(skillNodeXp(marksman(150, undefined), rifle)).toBe(0);
    expect(skillNodeXp(marksman(150, { rifle: 400 }), rifle)).toBe(150);
    expect(skillNodeXp(marksman(400, { rifle: 150 }), rifle)).toBe(150);
  });

  it("names the exact XP pool, certs, schematics, and authority unlocks on hover", () => {
    const rifleThree = skillNodeDefinitions.find((node) => node.id === "marksman-rifle-iii")!;
    const rifleHover = skillNodeHoverText(
      marksman(700, { rifle: 700 }),
      rifleThree,
      "Ready to train",
      false,
    );
    expect(rifleHover).toContain("RIFLE XP · 700 usable / 650 required");
    expect(rifleHover).toContain("WEAPON CERTS · Crafted Slugthrower · Assault Rifle");

    const craftsman = skillNodeDefinitions.find((node) => node.id === "craftsman-assembly-i")!;
    const craftHover = skillNodeHoverText(
      {
        id: "craftsman",
        label: "Craftsman",
        xp: 120,
        trackXp: { assembly: 120 },
        skillPoints: 16,
        skillBoxes: ["craftsman-novice"],
      },
      craftsman,
      "Ready to train",
      false,
    );
    expect(craftHover).toContain("CRAFT SCHEMATICS · Crafted Slugthrower Mk I · Quarry Chopper");

    const novice = skillNodeDefinitions.find((node) => node.id === "craftsman-novice")!;
    expect(skillNodeHoverText(null, novice, "Ready to train", false))
      .toContain("AUTHORITY UNLOCKS · Ammo Crafting · Profession Tool Crafting · Iron Gathering");
  });

  it("states the authority's exact XP and SP refund for trained boxes", () => {
    const rifle = skillNodeDefinitions.find((node) => node.id === "marksman-rifle-i")!;
    const hover = skillNodeHoverText(
      marksman(20, { rifle: 20 }),
      rifle,
      "Unlearn and recover 8 SP plus 100 XP. Credits are not refunded.",
      true,
    );
    expect(hover).toContain("UNLEARN · restores 8 SP and 100 RIFLE XP");
  });
});
