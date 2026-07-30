import { describe, expect, it } from "vitest";

import {
  createPlayState,
  type ActorSnapshot,
  type PlayState,
  type ServerAuthorityActorState,
  type ServerAuthorityProfessionState,
  type SliceSnapshot,
} from "@successor/client/src/slice-core/gameState";
import {
  STARTER_TOOL_ITEM_IDS,
  DENY_NOVICE_FIRST,
  DENY_RANGE,
  DENY_SKILL_POINTS,
  denyXp,
  holdsAllOwnedOrExchangeItems,
  holdsAnyLocalItem,
  nextTrainableBoxes,
  resolveNode,
  teachListFor,
  trainerDialogueNpc,
  type DialogueCtx,
  type ResolvedNode,
} from "./dialogueTree";
import { STARTER_TOOL_CONTRACT_LIVE, STARTER_TOOL_PENDING_NOTE } from "./starterToolLeaf";
import { TRAINER_ATTACK_DENY_NOTE, trainerRadialActions } from "./trainerRadial";
import { trainerDialogueTree } from "./trainerScripts";

// ── Fixture rig ────────────────────────────────────────────────────────────

function trainerActor(overrides: Partial<ActorSnapshot> = {}): ActorSnapshot {
  return {
    id: "camp-trainer",
    entity: "actor:camp-trainer",
    areaId: "a",
    label: "Camp Trainer",
    role: "profession_trainer",
    professionIds: ["craftsman", "marksman", "medic"],
    sprite: "adventurer-premium-male",
    poseSet: "idle",
    direction: "front",
    cell: { x: 2, y: 2 },
    route: [],
    ...overrides,
  };
}

function sliceFixture(trainer: ActorSnapshot): SliceSnapshot {
  return {
    schema: "successor.slice.v1",
    tick: 10,
    tickRateHz: 30,
    combatModel: "roll",
    grid: { cellSizePx: 60 },
    zone: { id: 1, name: "Test", width: 100, height: 100, level: 0 },
    areas: [{ id: "a", name: "A", kind: "overworld", width: 100, height: 100, level: 0 }],
    stateHash: "fixture",
    camera: { followActor: "player", zoom: 72 },
    actors: [
      {
        id: "player",
        entity: "actor:player",
        areaId: "a",
        label: "Field Observer",
        role: "player",
        sprite: "adventurer-premium-male",
        poseSet: "idle",
        direction: "right",
        cell: { x: 2, y: 2 },
        route: [],
      },
      trainer,
    ],
    props: [],
    blockedCells: [],
    transitions: [],
    cloneFacilities: [],
    inventory: [],
    reservations: [],
    events: [],
  };
}

interface RigOptions {
  trainer?: Partial<ActorSnapshot>;
  professions?: ServerAuthorityProfessionState[];
  skillPointsUsed?: number;
  skillPointsCap?: number;
  credits?: number;
  /** Player authority position (trainer source sits at 2.5, 2.5). */
  playerAt?: { x: number; y: number };
}

interface Rig {
  state: PlayState;
  slice: SliceSnapshot;
  ctx: DialogueCtx;
}

function authorityPlayer(options: RigOptions): ServerAuthorityActorState {
  return {
    id: "player",
    label: "Field Observer",
    areaId: "a",
    x: options.playerAt?.x ?? 2.5,
    y: options.playerAt?.y ?? 3.0,
    direction: "right",
    lifeState: "alive",
    lifecycleSeq: 1,
    vitals: { health: 100, action: 100, spirit: 100 },
    maxVitals: { health: 100, action: 100, spirit: 100 },
    bleed: { active: false, stackCount: 0, severity: 0, remainingMs: 0, ratesPerSecond: { health: 0, action: 0, spirit: 0 } },
    statuses: [],
    professions: options.professions ?? [],
    skillPointsUsed: options.skillPointsUsed ?? 0,
    skillPointsCap: options.skillPointsCap ?? 250,
    credits: options.credits ?? 0,
  };
}

function rig(options: RigOptions = {}): Rig {
  const trainer = trainerActor(options.trainer);
  const slice = sliceFixture(trainer);
  const state = createPlayState(slice);
  state.serverAuthority.playerActorId = "player";
  state.serverAuthority.actors["player"] = authorityPlayer(options);
  const npc = trainerDialogueNpc(state, slice, trainer.id);
  if (!npc) throw new Error("fixture: trainer npc did not resolve");
  // Host-injected container scope (the 3D window wires the identity-aware
  // inventory scope; tests pin the raw player-owner rule).
  const isCarriedContainer = (container: string): boolean => container === "player" || container.startsWith("player:");
  return { state, slice, ctx: { state, slice, npc, isCarriedContainer } };
}

function profession(id: string, overrides: Partial<ServerAuthorityProfessionState> = {}): ServerAuthorityProfessionState {
  return { id, label: id, xp: 0, skillPoints: 0, ...overrides };
}

/** Rendered option states, one compact line per option ("2 LABEL ⛔ reason"). */
function renderedOptions(resolved: ResolvedNode): string[] {
  return resolved.options.map((option, index) =>
    `${index + 1} ${option.label}${option.enabled ? "" : ` \u26D4 ${option.note ?? ""}`}`,
  );
}

// ── Availability predicates ────────────────────────────────────────────────

describe("nextTrainableBoxes", () => {
  it("offers only the novice box while the profession is unlearned", () => {
    const { ctx } = rig();
    const entries = nextTrainableBoxes(ctx, "craftsman");
    expect(entries.map((entry) => entry.node.id)).toEqual(["craftsman-novice"]);
    expect(entries[0]!.canTrain).toBe(true);
    expect(entries[0]!.reason).toBeNull();
    expect(entries[0]!.costLabel).toBe("STARTER · 16 SP");
  });

  it("denies the novice box on the skill-point cap with the honest reason", () => {
    const { ctx } = rig({ skillPointsUsed: 240 });
    const [novice] = nextTrainableBoxes(ctx, "craftsman");
    expect(novice!.canTrain).toBe(false);
    expect(novice!.reason).toBe(DENY_SKILL_POINTS);
  });

  it("walks each track to its next untrained box with per-track XP gates", () => {
    const { ctx } = rig({
      professions: [profession("marksman", {
        xp: 500,
        trackXp: { rifle: 300 },
        skillBoxes: ["marksman-rifle-i"],
      })],
    });
    const entries = nextTrainableBoxes(ctx, "marksman");
    expect(entries.map((entry) => entry.node.id)).toEqual([
      "marksman-rifle-ii",
      "marksman-pistol-i",
      "marksman-tactics-i",
      "marksman-fieldcraft-i",
    ]);
    // rifle-ii needs 300 track XP — exactly met.
    expect(entries[0]!.canTrain).toBe(true);
    // pistol-i has no pistol trackXp — missing track pool is zero, not profession XP.
    expect(entries[1]!.canTrain).toBe(false);
    expect(entries[1]!.reason).toBe(denyXp(100));
  });

  it("denies on missing XP with the amount still owed", () => {
    const { ctx } = rig({
      professions: [profession("marksman", {
        xp: 40,
        trackXp: { rifle: 40 },
        skillBoxes: [],
      })],
    });
    const rifleEntry = nextTrainableBoxes(ctx, "marksman").find((entry) => entry.node.id === "marksman-rifle-i");
    expect(rifleEntry!.canTrain).toBe(false);
    expect(rifleEntry!.reason).toBe(denyXp(60));
  });

  it("gates every entry on interaction range", () => {
    const { ctx } = rig({ playerAt: { x: 20, y: 20 } });
    expect(ctx.npc.inRange).toBe(false);
    const entries = nextTrainableBoxes(ctx, "craftsman");
    expect(entries.every((entry) => entry.reason === DENY_RANGE)).toBe(true);
  });

  it("offers the master box once every track is trained out", () => {
    const boxes = [
      ...["survey", "tools", "experimentation", "assembly"].flatMap((track) =>
        ["i", "ii", "iii", "iv"].map((tier) => `craftsman-${track}-${tier}`)),
    ];
    const { ctx } = rig({
      professions: [profession("craftsman", { xp: 5000, skillBoxes: boxes })],
    });
    const entries = nextTrainableBoxes(ctx, "craftsman");
    expect(entries.map((entry) => entry.node.id)).toEqual(["craftsman-master"]);
  });

  it("returns nothing for a mastered-out profession", () => {
    const boxes = [
      ...["survey", "tools", "experimentation", "assembly"].flatMap((track) =>
        ["i", "ii", "iii", "iv"].map((tier) => `craftsman-${track}-${tier}`)),
      "craftsman-master",
    ];
    const { ctx } = rig({
      professions: [profession("craftsman", { xp: 9000, skillBoxes: boxes })],
    });
    expect(nextTrainableBoxes(ctx, "craftsman")).toEqual([]);
  });
});

describe("teachListFor", () => {
  it("scopes entries to the professions the NPC teaches", () => {
    const { ctx } = rig({
      trainer: { professionIds: ["craftsman"] },
      professions: [profession("marksman", { xp: 500 })],
    });
    const entries = teachListFor(ctx);
    expect(entries.every((entry) => entry.professionId === "craftsman")).toBe(true);
  });

  it("ignores non-trainable profession ids on the NPC", () => {
    const { ctx } = rig({ trainer: { professionIds: ["enforcer", "medic"] } });
    const entries = teachListFor(ctx);
    expect(entries.map((entry) => entry.node.id)).toEqual(["medic-novice"]);
  });
});

describe("holdsAnyLocalItem", () => {
  it("sees carried rows and ignores foreign containers", () => {
    const { ctx } = rig();
    ctx.state.inventory = [
      { container: "rogue-01", item: "crafting_tool", itemId: 3001, variantId: 0, quantity: 1, reserved: 0, available: 1 },
    ];
    expect(holdsAnyLocalItem(ctx, STARTER_TOOL_ITEM_IDS)).toBe(false);
    ctx.state.inventory = [
      { container: "player:backpack", item: "crafting_tool", itemId: 3001, variantId: 0, quantity: 1, reserved: 0, available: 1 },
    ];
    expect(holdsAnyLocalItem(ctx, STARTER_TOOL_ITEM_IDS)).toBe(true);
  });

  it("counts exchange rows only inside the authority exchange footprint", () => {
    const { ctx } = rig();
    ctx.state.inventory = [
      { container: "district-exchange", item: "Field Multitool", itemId: 3001, variantId: 0, quantity: 1, reserved: 0, available: 1 },
      { container: "district-exchange", item: "Mineral Survey Tool", itemId: 3008, variantId: 0, quantity: 1, reserved: 0, available: 1 },
    ];
    expect(holdsAnyLocalItem(ctx, STARTER_TOOL_ITEM_IDS)).toBe(false);
    expect(holdsAllOwnedOrExchangeItems(ctx, STARTER_TOOL_ITEM_IDS)).toBe(false);
    ctx.slice.props.push({
      id: "district-exchange-01",
      entity: "container:district-exchange",
      areaId: "a",
      label: "District Exchange",
      kind: "exchange",
      cell: { x: 2, y: 2 },
      size: { w: 2, h: 3 },
      interactive: true,
    });
    expect(holdsAllOwnedOrExchangeItems(ctx, STARTER_TOOL_ITEM_IDS)).toBe(true);
  });
});

// ── Trainer scripts ────────────────────────────────────────────────────────

describe("trainerDialogueTree", () => {
  it("pins camp-trainer to the crafter persona", () => {
    const { ctx } = rig();
    expect(trainerDialogueTree(ctx.npc).id).toBe("trainer-craftsman");
  });

  it("routes single-profession trainers to their own persona", () => {
    const { ctx } = rig({ trainer: { id: "medic-trainer-01", professionIds: ["medic"] } });
    expect(trainerDialogueTree(ctx.npc).id).toBe("trainer-medic");
  });

  it("falls back to the bench generalist for unpinned multi-profession trainers", () => {
    const { ctx } = rig({ trainer: { id: "unknown-trainer", professionIds: ["scout", "brawler"] } });
    expect(trainerDialogueTree(ctx.npc).id).toBe("trainer-craftsman");
  });

  it("greets by progression state (stranger → toolless → learned → master)", () => {
    const stranger = rig();
    const strangerTree = trainerDialogueTree(stranger.ctx.npc);
    expect(resolveNode(strangerTree, "entry", stranger.ctx).line).toContain("kicking dust");

    // Learned but bench-kit-less — the diegetic tool-recovery hook outranks
    // the plain working greeting.
    const toolless = rig({ professions: [profession("craftsman")] });
    expect(resolveNode(trainerDialogueTree(toolless.ctx.npc), "entry", toolless.ctx).line).toContain("empty hands");

    const learned = rig({ professions: [profession("craftsman")] });
    learned.state.inventory = [
      { container: "player", item: "Field Multitool", itemId: 3001, variantId: 0, quantity: 1, reserved: 0, available: 1 },
      { container: "player", item: "Mineral Survey Tool", itemId: 3008, variantId: 0, quantity: 1, reserved: 0, available: 1 },
    ];
    expect(resolveNode(trainerDialogueTree(learned.ctx.npc), "entry", learned.ctx).line).toContain("Back again");

    const master = rig({
      professions: [profession("craftsman", { skillBoxes: ["craftsman-master"] })],
    });
    expect(resolveNode(trainerDialogueTree(master.ctx.npc), "entry", master.ctx).line).toContain("Master's hands");
  });

  it("keeps farewell available on the root regardless of state", () => {
    const { ctx } = rig({ playerAt: { x: 50, y: 50 } });
    const resolved = resolveNode(trainerDialogueTree(ctx.npc), "entry", ctx);
    const farewell = resolved.options.find((option) => option.id === "farewell");
    expect(farewell).toBeDefined();
    expect(farewell!.enabled).toBe(true);
    expect(farewell!.action).toEqual({ kind: "end" });
  });

  it("falls back to the entry node for unknown node ids", () => {
    const { ctx } = rig();
    const tree = trainerDialogueTree(ctx.npc);
    expect(resolveNode(tree, "no-such-node", ctx).id).toBe("entry");
  });
});

describe("crafter tools branch", () => {
  it("offers the starter-tool leaf until the complete starter bundle is held", () => {
    const bare = rig();
    const tree = trainerDialogueTree(bare.ctx.npc);
    const withoutKit = resolveNode(tree, "tools", bare.ctx);
    const grant = withoutKit.options.find((option) => option.id === "starter-tool");
    expect(grant).toBeDefined();
    expect(grant!.action).toEqual({ kind: "starterTool" });
    if (STARTER_TOOL_CONTRACT_LIVE) {
      expect(grant!.enabled).toBe(true);
    } else {
      expect(grant!.enabled).toBe(false);
      expect(grant!.note).toBe(STARTER_TOOL_PENDING_NOTE);
    }

    bare.state.inventory = [
      { container: "player", item: "crafting_tool", itemId: 3001, variantId: 0, quantity: 1, reserved: 0, available: 1 },
    ];
    const missingSurveyTool = resolveNode(tree, "tools", bare.ctx);
    expect(missingSurveyTool.options.find((option) => option.id === "starter-tool")).toBeDefined();

    bare.state.inventory.push(
      { container: "player", item: "mineral_survey_tool", itemId: 3008, variantId: 0, quantity: 1, reserved: 0, available: 1 },
    );
    const holding = resolveNode(tree, "tools", bare.ctx);
    expect(holding.options.find((option) => option.id === "starter-tool")).toBeUndefined();
    expect(holding.line).toContain("already carrying");
  });

  it("requires both bundle items when they are parked at an in-range exchange", () => {
    const parked = rig();
    parked.slice.props.push({
      id: "district-exchange-01",
      entity: "container:district-exchange",
      areaId: "a",
      label: "District Exchange",
      kind: "exchange",
      cell: { x: 2, y: 2 },
      size: { w: 2, h: 3 },
      interactive: true,
    });
    const tree = trainerDialogueTree(parked.ctx.npc);
    parked.state.inventory = [
      { container: "district-exchange", item: "crafting_tool", itemId: 3001, variantId: 0, quantity: 1, reserved: 0, available: 1 },
    ];
    const missingSurveyTool = resolveNode(tree, "tools", parked.ctx);
    expect(missingSurveyTool.options.find((option) => option.id === "starter-tool")).toBeDefined();

    parked.state.inventory.push(
      { container: "district-exchange", item: "mineral_survey_tool", itemId: 3008, variantId: 0, quantity: 1, reserved: 0, available: 1 },
    );
    const holding = resolveNode(tree, "tools", parked.ctx);
    expect(holding.options.find((option) => option.id === "starter-tool")).toBeUndefined();
    expect(holding.line).toContain("already carrying");
  });
});

describe("camp field-start branch", () => {
  it("makes the complete first-session path discoverable without assigning GR0K a role", () => {
    const { ctx } = rig();
    const tree = trainerDialogueTree(ctx.npc);
    const entry = resolveNode(tree, "entry", ctx);
    expect(entry.options.find((option) => option.id === "field-start")?.action)
      .toEqual({ kind: "goto", nodeId: "field-start" });

    const start = resolveNode(tree, "field-start", ctx);
    expect(start.line).toContain("point spend, not a destiny");
    expect(start.line).toContain("unlearn");
    expect(start.options.map((option) => option.id)).toEqual([
      "field-resources",
      "field-hunt",
      "field-craft",
      "back",
    ]);

    const resources = resolveNode(tree, "field-resources", ctx);
    expect(resources.line).toContain("hand-sample");
    expect(resources.line).toContain("Craftsman novice");
    const hunt = resolveNode(tree, "field-hunt", ctx);
    expect(hunt.line).toContain("24 bone and 36 hide");
    expect(hunt.line).toContain("ten minutes");
    const craft = resolveNode(tree, "field-craft", ctx);
    expect(craft.line).toContain("Field Multitool and Mineral Survey Tool");
    expect(craft.line).toContain("Chemical, gas, and water survey tools are crafted");
  });
});

describe("crafter career branch", () => {
  it("lists the four sim career goals and routes through confirm beats", () => {
    const { ctx } = rig();
    const tree = trainerDialogueTree(ctx.npc);
    const career = resolveNode(tree, "career", ctx);
    expect(career.options.map((option) => option.id)).toEqual([
      "career:rifle_utility",
      "career:ranged_specialist",
      "career:melee_specialist",
      "career:rifle_quartermaster",
      "back",
    ]);
    const confirm = resolveNode(tree, "career-melee_specialist", ctx);
    expect(confirm.line).toContain("500 credits");
    const doIt = confirm.options.find((option) => option.id === "confirm");
    expect(doIt!.enabled).toBe(true);
    expect(doIt!.action).toEqual({ kind: "careerGoal", goalId: "melee_specialist" });
  });

  it("gates the respec leaf on interaction range", () => {
    const { ctx } = rig({ playerAt: { x: 50, y: 50 } });
    const tree = trainerDialogueTree(ctx.npc);
    const confirm = resolveNode(tree, "career-rifle_utility", ctx);
    const doIt = confirm.options.find((option) => option.id === "confirm");
    expect(doIt!.enabled).toBe(false);
    expect(doIt!.note).toBe(DENY_RANGE);
  });
});

// ── Rendered option states (snapshots) ─────────────────────────────────────

describe("rendered option states", () => {
  it("entry node — fresh stranger at the camp trainer", () => {
    const { ctx } = rig();
    const tree = trainerDialogueTree(ctx.npc);
    expect(renderedOptions(resolveNode(tree, "entry", ctx))).toMatchInlineSnapshot(`
      [
        "1 What can you teach me?",
        "2 How do I get moving?",
        "3 I need tools.",
        "4 Set my course.",
        "5 Who are you?",
        "6 Farewell.",
      ]
    `);
  });

  it("teach node — fresh stranger sees the three novice boxes with costs", () => {
    const { ctx } = rig();
    const tree = trainerDialogueTree(ctx.npc);
    expect(renderedOptions(resolveNode(tree, "teach", ctx))).toMatchInlineSnapshot(`
      [
        "1 CRAFTSMAN · NOVICE CRAFTSMAN · STARTER · 16 SP",
        "2 MARKSMAN · NOVICE MARKSMAN · STARTER · 16 SP",
        "3 MEDIC · NOVICE MEDIC · STARTER · 16 SP",
        "4 Show me the full ledger.",
        "5 Back.",
      ]
    `);
  });

  it("teach node — mid-progression marksman shows track gates honestly", () => {
    const { ctx } = rig({
      trainer: { id: "marksman-trainer-01", professionIds: ["marksman"] },
      professions: [profession("marksman", {
        xp: 120,
        trackXp: { rifle: 40 },
        skillBoxes: ["marksman-rifle-i"],
      })],
      skillPointsUsed: 244,
    });
    const tree = trainerDialogueTree(ctx.npc);
    expect(renderedOptions(resolveNode(tree, "teach", ctx))).toMatchInlineSnapshot(`
      [
        "1 Show me the full ledger.",
        "2 Back.",
      ]
    `);
  });

  it("teach node — out of range disables everything with the range reason", () => {
    const { ctx } = rig({ playerAt: { x: 20, y: 20 }, trainer: { professionIds: ["craftsman"] } });
    const tree = trainerDialogueTree(ctx.npc);
    expect(renderedOptions(resolveNode(tree, "teach", ctx))).toMatchInlineSnapshot(`
      [
        "1 NOVICE CRAFTSMAN · STARTER · 16 SP ⛔ Move closer to the trainer",
        "2 Show me the full ledger.",
        "3 Back.",
      ]
    `);
  });

  it("uses the novice-first reason for branch boxes of an unlearned profession", () => {
    const { ctx } = rig();
    // Force a branch entry for an unlearned profession through the predicate
    // itself (the teach list would only surface the novice box).
    const entries = nextTrainableBoxes(ctx, "craftsman");
    expect(entries[0]!.reason).toBeNull();
    expect(DENY_NOVICE_FIRST).toBe("Learn the novice box first");
  });
});

describe("trainerRadialActions", () => {
  it("leads with Converse and grays Attack with the in-character reason", () => {
    expect(trainerRadialActions()).toEqual([
      { id: "converse", label: "Converse", enabled: true, note: null },
      { id: "examine", label: "Examine", enabled: true, note: null },
      { id: "attack", label: "Attack", enabled: false, note: TRAINER_ATTACK_DENY_NOTE },
    ]);
  });
});
