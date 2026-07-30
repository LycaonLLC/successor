import { describe, expect, it } from "vitest";

import {
  bestSurveyCell,
  attackUntilDowned,
  attackUntilCloneEligible,
  createFlowContext,
  headingForDelta,
  issueAuthorityLine,
  harvestCorpse,
  moveTo,
  sampleLoop,
  craftAssignSlot,
  craftClearSlot,
  craftDraftSchematic,
  craftRecipe,
  FlowStepError,
  plantSeed,
  placeFarmStructure,
  removeFarmStructure,
  waterTile,
  setCareerGoal,
  spliceBegin,
  spliceAssignSlot,
  spliceCancel,
  spliceClearSlot,
  surveyBest,
  surveyAndSample,
  trainSkill,
  waitForEnvelope,
  waitForExtractorCollectable,
} from "./primitives.mjs";

class FixtureDriver {
  constructor(script = {}) {
    this.envelopes = [];
    this.sent = [];
    this.positions = script.positions ?? [{ areaId: "open-desert-overworld", x: 10, y: 10, facing: "right" }];
    this.inventory = script.inventory ?? [0, 0, 14];
    this.surveyPayload = script.surveyPayload ?? null;
    this.lastWhere = null;
    this.samplePositions = [];
    this.commandId = 0;
  }

  send(frame) {
    this.sent.push(frame);
    if (frame.op === "query") return this.query(frame.verb);
    if (frame.op === "verb") return this.verb(frame.line);
  }

  query(line) {
    if (line.startsWith("/where")) {
      const data = this.positions[Math.min(this.whereCount ?? 0, this.positions.length - 1)];
      this.whereCount = (this.whereCount ?? 0) + 1;
      this.lastWhere = data;
      this.envelopes.push({ v: "successor.driver.v1", type: "query", line, verb: "where", text: `WHERE ${data.x},${data.y}`, data });
      return;
    }
    if (line.startsWith("/inv")) {
      const totalAvailable = this.inventory[Math.min(this.invCount ?? 0, this.inventory.length - 1)];
      this.invCount = (this.invCount ?? 0) + 1;
      this.envelopes.push({ v: "successor.driver.v1", type: "query", line, verb: "inv", text: `INV ${totalAvailable}`, data: { totalAvailable, rows: [{ container: "player:field-pack", item: "Iron", itemId: 2001, variantId: 7, available: totalAvailable }] } });
    }
  }

  verb(line) {
    const commandKind = line.startsWith("/set-move-intent")
      ? "SetMoveIntent"
      : line.startsWith("/survey")
        ? "SurveyResource"
        : line.startsWith("/sample")
          ? "SampleResource"
          : "Unknown";
    if (line.startsWith("/sample")) this.samplePositions.push(this.lastWhere);
    const commandId = ++this.commandId;
    this.envelopes.push({ v: "successor.driver.v1", type: "event", event: "authority_queued", line, data: { commandId, commandKind, flushed: 1 } });
    this.envelopes.push({ v: "successor.driver.v1", type: "receipt", commandId, commandKind, accepted: true, tick: commandId });
    if (line.startsWith("/survey") && this.surveyPayload) {
      this.envelopes.push({ v: "successor.driver.v1", type: "event", event: "survey_result", data: { payload: this.surveyPayload } });
    }
  }
}

function ctx(driver) {
  return createFlowContext({
    flowName: "test",
    driver,
    gameUrl: "http://127.0.0.1:28999",
    sleep: async () => undefined,
  });
}

describe("play-flow primitives", () => {
  it("selects the richest survey cell from a fixture PlayState survey payload", () => {
    expect(bestSurveyCell({
      areaId: "open-desert-overworld",
      centerX: 100,
      centerY: 200,
      rangeCells: 16,
      stepCells: 8,
      cols: 5,
      rows: 5,
      concentrationMilli: [1, 2, 3, 4, 5, 10, 20, 900, 40, 50],
    })).toMatchObject({ x: 100, y: 192, concentrationMilli: 900, concentrationPct: 90 });
  });
  it("maps the exact richest survey index to its authoritative grid coordinate", () => {
    const concentrationMilli = Array.from({ length: 21 }, () => 0);
    concentrationMilli[20] = 999;
    expect(bestSurveyCell({ centerX: 511, centerY: 512, rangeCells: 24, stepCells: 12, cols: 5, concentrationMilli })).toMatchObject({ index: 20, col: 0, row: 4, x: 487, y: 536, concentrationMilli: 999 });
  });


  it("issues SetMoveIntent pulses for moveTo and never uses the inert Move command", async () => {
    const driver = new FixtureDriver({ positions: [
      { areaId: "open-desert-overworld", x: 10, y: 10, facing: "right" },
      { areaId: "open-desert-overworld", x: 11.1, y: 10, facing: "right" },
      { areaId: "open-desert-overworld", x: 12.05, y: 10, facing: "right" },
    ] });

    const result = await moveTo(ctx(driver), { x: 12, y: 10 }, { toleranceCells: 0.2, pulseMs: 1 });

    expect(result.status).toBe("pass");
    const lines = driver.sent.filter((frame) => frame.op === "verb").map((frame) => frame.line);
    expect(lines.some((line) => line.startsWith("/move "))).toBe(false);
    expect(lines.filter((line) => line.startsWith("/set-move-intent 1 0 Right"))).toHaveLength(2);
    expect(lines.at(-1)).toBe("/set-move-intent 0 0 Right");
  });

  it("chooses the larger vertical delta before horizontal micro-correction", async () => {
    const driver = new FixtureDriver({ positions: [
      { areaId: "desert", x: 512.3, y: 511.86, facing: "right" },
      { areaId: "desert", x: 512.3, y: 513.9, facing: "front" },
      { areaId: "desert", x: 512.1, y: 513.9, facing: "left" },
    ] });

    const result = await moveTo(ctx(driver), { x: 512, y: 514 }, { toleranceCells: 0.2, pulseMs: 1, maxPulses: 3 });

    expect(result.status).toBe("pass");
    expect(driver.sent.filter((frame) => frame.op === "verb").map((frame) => frame.line)).toEqual([
      "/set-move-intent 0 1 Front true",
      "/set-move-intent -1 0 Left true",
      "/set-move-intent 0 0 Left",
    ]);
  });
  it("moves from the organic cage to the exact 489,488 survey cell before sampling at authority range", async () => {
    const target = { x: 489, y: 488 };
    const driver = new FixtureDriver({
      positions: [
        { areaId: "open-desert-overworld", x: 513.96, y: 512.33, facing: "back" },
        { areaId: "open-desert-overworld", x: 513.96, y: 512.33, facing: "back" },
        { areaId: "open-desert-overworld", x: 489.35, y: 512.33, facing: "left" },
        { areaId: "open-desert-overworld", x: 489.35, y: 488.35, facing: "back" },
      ],
      inventory: [0, 1],
      surveyPayload: {
        family: "iron",
        areaId: "open-desert-overworld",
        centerX: 513,
        centerY: 512,
        rangeCells: 24,
        stepCells: 12,
        cols: 5,
        rows: 5,
        concentrationMilli: [847, 747, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      },
    });

    const result = await surveyAndSample(ctx(driver), "iron", { units: 1, standAfter: false, toleranceCells: 0.9, moveOptions: { pulseMs: 1, maxPulses: 3 } });

    expect(result).toMatchObject({
      status: "pass",
      surveyed: { best: target },
      movement: { status: "pass" },
      gathering: { gained: 1 },
    });
    expect(result.movement.arrivalDistanceCells).toBeLessThanOrEqual(0.9);
    expect(Math.max(Math.abs(driver.samplePositions[0].x - target.x), Math.abs(driver.samplePositions[0].y - target.y))).toBeLessThanOrEqual(0.9);
    expect(driver.sent.filter((frame) => frame.op === "verb").map((frame) => frame.line)).toEqual([
      "/survey iron",
      "/set-move-intent -1 0 Left true",
      "/set-move-intent 0 -1 Back true",
      "/set-move-intent 0 0 Back",
      "/sample iron",
      "/sample iron true",
    ]);
  });

  it("fails closed after both cardinal exits from the known organic cage are blocked", async () => {
    const driver = new FixtureDriver({ positions: [
      { areaId: "open-desert-overworld", x: 513.96, y: 512.33, facing: "back" },
      { areaId: "open-desert-overworld", x: 513.96, y: 512.33, facing: "back" },
      { areaId: "open-desert-overworld", x: 513.96, y: 512.33, facing: "back" },
    ] });

    await expect(moveTo(ctx(driver), { x: 489, y: 488 }, { toleranceCells: 0.9, pulseMs: 1, maxStalePulses: 1, maxPulses: 3 }))
      .rejects.toMatchObject({ details: { reason: "movement_stalled", stalledAxes: ["x", "y"], stop: { receipt: { commandKind: "SetMoveIntent", accepted: true } } } });
    expect(driver.sent.filter((frame) => frame.op === "verb").map((frame) => frame.line)).toEqual([
      "/set-move-intent -1 0 Left true",
      "/set-move-intent 0 -1 Back true",
      "/set-move-intent 0 0 Back",
    ]);
  });

  it("falls back from a blocked dominant vertical axis, then resumes vertical travel after horizontal progress", async () => {
    const driver = new FixtureDriver({ positions: [
      { areaId: "desert", x: 0, y: 0, facing: "right" },
      { areaId: "desert", x: 0, y: 0, facing: "right" },
      { areaId: "desert", x: 2, y: 0, facing: "right" },
      { areaId: "desert", x: 2, y: 4, facing: "front" },
    ] });

    const result = await moveTo(ctx(driver), { x: 2, y: 4 }, { toleranceCells: 0.2, pulseMs: 1, maxStalePulses: 1, maxPulses: 4 });

    expect(result.status).toBe("pass");
    expect(driver.sent.filter((frame) => frame.op === "verb").map((frame) => frame.line)).toEqual([
      "/set-move-intent 0 1 Front true",
      "/set-move-intent 1 0 Right true",
      "/set-move-intent 0 1 Front true",
      "/set-move-intent 0 0 Front",
    ]);
  });

  it("fails only after both outstanding cardinal axes stall", async () => {
    const driver = new FixtureDriver({ positions: [
      { areaId: "desert", x: 0, y: 0, facing: "right" },
      { areaId: "desert", x: 0, y: 0, facing: "right" },
      { areaId: "desert", x: 0, y: 0, facing: "right" },
    ] });

    await expect(moveTo(ctx(driver), { x: 2, y: 4 }, { toleranceCells: 0.2, pulseMs: 1, maxStalePulses: 1, maxPulses: 3 }))
      .rejects.toMatchObject({ details: { reason: "movement_stalled", stalledAxes: ["y", "x"], stop: { receipt: { commandKind: "SetMoveIntent", accepted: true } } } });
    expect(driver.sent.filter((frame) => frame.op === "verb").map((frame) => frame.line)).toEqual([
      "/set-move-intent 0 1 Front true",
      "/set-move-intent 1 0 Right true",
      "/set-move-intent 0 0 Right",
    ]);
  });

  it("fails stalled movement after observed no-displacement pulses and sends a stop intent", async () => {
    const driver = new FixtureDriver({ positions: [
      { areaId: "open-desert-overworld", x: 10, y: 10, facing: "right" },
      { areaId: "open-desert-overworld", x: 10, y: 10, facing: "right" },
      { areaId: "open-desert-overworld", x: 10, y: 10, facing: "right" },
      { areaId: "open-desert-overworld", x: 10, y: 10, facing: "right" },
    ] });

    await expect(moveTo(ctx(driver), { x: 14, y: 10 }, { pulseMs: 1, maxStalePulses: 3 }))
      .rejects.toMatchObject({ details: { reason: "movement_stalled", stalePulses: 3, stop: { receipt: { commandKind: "SetMoveIntent", accepted: true } } } });
    const lines = driver.sent.filter((frame) => frame.op === "verb").map((frame) => frame.line);
    expect(lines.filter((line) => line.startsWith("/set-move-intent 1 0 Right"))).toHaveLength(3);
    expect(lines.at(-1)).toBe("/set-move-intent 0 0 Right");
  });

  it("does not count perpendicular collision sliding as progress toward the active axis", async () => {
    const driver = new FixtureDriver({ positions: [
      { areaId: "open-desert-overworld", x: 512.04, y: 527.3, facing: "back" },
      { areaId: "open-desert-overworld", x: 512.1, y: 527.3, facing: "back" },
      { areaId: "open-desert-overworld", x: 511.98, y: 527.3, facing: "back" },
      { areaId: "open-desert-overworld", x: 512.07, y: 527.3, facing: "back" },
    ] });

    await expect(moveTo(ctx(driver), { x: 512, y: 526 }, {
      toleranceCells: 0.2,
      pulseMs: 1,
      maxStalePulses: 3,
      maxPulses: 3,
    })).rejects.toMatchObject({
      details: {
        reason: "movement_stalled",
        stalePulses: 3,
        stalledAxes: ["y"],
      },
    });
    const lines = driver.sent.filter((frame) => frame.op === "verb").map((frame) => frame.line);
    expect(lines.filter((line) => line.startsWith("/set-move-intent 0 -1 Back"))).toHaveLength(3);
    expect(lines.at(-1)).toBe("/set-move-intent 0 0 Back");
  });

  it("moves into authoritative trainer range before issuing PurchaseSkillBox", async () => {
    const positions = [
      { areaId: "desert", x: 0, y: 0, facing: "right" },
      { areaId: "desert", x: 0, y: 0, facing: "right" },
      { areaId: "desert", x: 8.2, y: 0, facing: "right" },
      { areaId: "desert", x: 8.6, y: 0, facing: "right" },
      { areaId: "desert", x: 8.6, y: 0, facing: "right" },
    ];
    const driver = {
      envelopes: [],
      sent: [],
      commandId: 0,
      whereIndex: 0,
      lastWhere: null,
      observedAtTrain: null,
      send(frame) {
        this.sent.push(frame);
        if (frame.op === "query" && frame.verb.startsWith("/nearby all")) {
          this.envelopes.push({ type: "query", line: frame.verb, verb: "nearby", data: { origin: { x: 0, y: 0, areaId: "desert" }, actors: [{ id: "trainer-bob", x: 10, y: 0, areaId: "desert", role: "profession_trainer" }] } });
          return;
        }
        if (frame.op === "query" && frame.verb.startsWith("/where")) {
          this.lastWhere = positions[Math.min(this.whereIndex, positions.length - 1)];
          this.whereIndex += 1;
          this.envelopes.push({ type: "query", line: frame.verb, verb: "where", data: this.lastWhere });
          return;
        }
        if (frame.op === "verb") {
          const commandKind = frame.line.startsWith("/set-move-intent") ? "SetMoveIntent" : "PurchaseSkillBox";
          this.commandId += 1;
          if (commandKind === "PurchaseSkillBox") this.observedAtTrain = this.lastWhere;
          this.envelopes.push({ type: "event", event: "authority_queued", line: frame.line, data: { commandId: this.commandId, commandKind } });
          this.envelopes.push({ type: "receipt", commandId: this.commandId, commandKind, accepted: true, tick: this.commandId });
        }
      },
    };
    const context = createFlowContext({ flowName: "trainer-range", driver, sleep: async () => undefined, oracle: async () => ({ tick: 10 }) });

    const result = await trainSkill(context, "box-1", { moveOptions: { maxPulses: 3 } });
    const verbLines = driver.sent.filter((frame) => frame.op === "verb").map((frame) => frame.line);
    const purchaseIndex = verbLines.findIndex((line) => line.startsWith("/train-skill"));

    expect(result).toMatchObject({ status: "pass", approach: { observed: { x: 8.6, y: 0 } }, trained: { receipt: { commandKind: "PurchaseSkillBox", accepted: true } } });
    expect(result.approach.distanceCells).toBeLessThanOrEqual(1.75);
    expect(driver.observedAtTrain).toMatchObject({ x: 8.6, y: 0, areaId: "desert" });
    expect(verbLines.slice(0, purchaseIndex).every((line) => line.startsWith("/set-move-intent"))).toBe(true);
    expect(verbLines.slice(0, purchaseIndex).filter((line) => line.startsWith("/set-move-intent 1 0 Right")).length).toBe(2);
  });

  it("fine-corrects one bounded walking pulse after authoritative post-stop trainer drift", async () => {
    const positions = [
      { areaId: "desert", x: 0, y: 0, facing: "right" },
      { areaId: "desert", x: 0, y: 0, facing: "right" },
      { areaId: "desert", x: 8.2, y: 0, facing: "right" },
      { areaId: "desert", x: 8.6, y: 0, facing: "right" },
      { areaId: "desert", x: 7.9, y: 0, facing: "right" },
      { areaId: "desert", x: 7.9, y: 0, facing: "right" },
      { areaId: "desert", x: 8.85, y: 0, facing: "right" },
      { areaId: "desert", x: 8.85, y: 0, facing: "right" },
    ];
    const driver = {
      envelopes: [],
      sent: [],
      commandId: 0,
      whereIndex: 0,
      observedAtTrain: null,
      send(frame) {
        this.sent.push(frame);
        if (frame.op === "query" && frame.verb.startsWith("/nearby all")) {
          this.envelopes.push({ type: "query", line: frame.verb, verb: "nearby", data: { origin: { x: 0, y: 0, areaId: "desert" }, actors: [{ id: "trainer-bob", x: 10, y: 0, areaId: "desert", role: "profession_trainer" }] } });
          return;
        }
        if (frame.op === "query" && frame.verb.startsWith("/where")) {
          const data = positions[Math.min(this.whereIndex, positions.length - 1)];
          this.whereIndex += 1;
          this.envelopes.push({ type: "query", line: frame.verb, verb: "where", data });
          return;
        }
        if (frame.op === "verb") {
          const commandKind = frame.line.startsWith("/set-move-intent") ? "SetMoveIntent" : "PurchaseSkillBox";
          this.commandId += 1;
          if (commandKind === "PurchaseSkillBox") this.observedAtTrain = positions[Math.max(0, this.whereIndex - 1)];
          this.envelopes.push({ type: "event", event: "authority_queued", line: frame.line, data: { commandId: this.commandId, commandKind } });
          this.envelopes.push({ type: "receipt", commandId: this.commandId, commandKind, accepted: true, tick: this.commandId });
        }
      },
    };
    const context = createFlowContext({ flowName: "trainer-fine-correction", driver, sleep: async () => undefined, oracle: async () => ({ tick: 10 }) });


    const result = await trainSkill(context, "box-1", {
      trainerInteractionRadiusCells: 1.75,
      trainerApproachToleranceCells: 0.5,
      trainerFineCorrectionToleranceCells: 0.2,
      trainerFineCorrectionMaxPulses: 3,
      moveOptions: { maxPulses: 3, pulseMs: 1 },
    });
    const verbLines = driver.sent.filter((frame) => frame.op === "verb").map((frame) => frame.line);

    expect(result.approach).toMatchObject({
      observed: { x: 8.85, y: 0 },
      correction: { status: "pass" },
      target: { x: 8.9, y: 0 },
    });
    expect(result.approach.distanceCells).toBeLessThanOrEqual(1.75);
    expect(driver.observedAtTrain).toMatchObject({ x: 8.85, y: 0, areaId: "desert" });
    expect(verbLines).toEqual([
      "/set-move-intent 1 0 Right true",
      "/set-move-intent 1 0 Right true",
      "/set-move-intent 0 0 Right",
      "/set-move-intent 1 0 Right",
      "/set-move-intent 0 0 Right",
      "/train-skill box-1 trainer-bob",
    ]);
  });

  it("fails closed when one bounded trainer fine correction still ends outside authority range", async () => {
    const positions = [
      { areaId: "desert", x: 0, y: 0, facing: "right" },
      { areaId: "desert", x: 0, y: 0, facing: "right" },
      { areaId: "desert", x: 8.2, y: 0, facing: "right" },
      { areaId: "desert", x: 8.6, y: 0, facing: "right" },
      { areaId: "desert", x: 7.9, y: 0, facing: "right" },
      { areaId: "desert", x: 7.9, y: 0, facing: "right" },
      { areaId: "desert", x: 8.71, y: 0, facing: "right" },
      { areaId: "desert", x: 8, y: 0, facing: "right" },
    ];
    const driver = {
      envelopes: [],
      sent: [],
      commandId: 0,
      whereIndex: 0,
      send(frame) {
        this.sent.push(frame);
        if (frame.op === "query" && frame.verb.startsWith("/nearby all")) {
          this.envelopes.push({ type: "query", line: frame.verb, verb: "nearby", data: { origin: { x: 0, y: 0, areaId: "desert" }, actors: [{ id: "trainer-bob", x: 10, y: 0, areaId: "desert", role: "profession_trainer" }] } });
          return;
        }
        if (frame.op === "query" && frame.verb.startsWith("/where")) {
          const data = positions[Math.min(this.whereIndex, positions.length - 1)];
          this.whereIndex += 1;
          this.envelopes.push({ type: "query", line: frame.verb, verb: "where", data });
          return;
        }
        if (frame.op === "verb") {
          const commandId = ++this.commandId;
          const commandKind = frame.line.startsWith("/set-move-intent") ? "SetMoveIntent" : "PurchaseSkillBox";
          this.envelopes.push({ type: "event", event: "authority_queued", line: frame.line, data: { commandId, commandKind } });
          this.envelopes.push({ type: "receipt", commandId, commandKind, accepted: true, tick: commandId });
        }
      },
    };
    const context = createFlowContext({ flowName: "trainer-fine-correction-outside", driver, sleep: async () => undefined, oracle: async () => ({ tick: 10 }) });

    await expect(trainSkill(context, "box-1", {
      trainerApproachToleranceCells: 0.5,
      trainerFineCorrectionToleranceCells: 0.2,
      trainerFineCorrectionMaxPulses: 3,
      moveOptions: { maxPulses: 3, pulseMs: 1 },
    })).rejects.toMatchObject({
      message: "trainer trainer-bob remains outside interaction range",
      details: {
        distanceCells: 2,
        interactionRadiusCells: 1.75,
        correction: { status: "pass" },
      },
    });
    const verbLines = driver.sent.filter((frame) => frame.op === "verb").map((frame) => frame.line);
    expect(verbLines.filter((line) => line === "/set-move-intent 1 0 Right")).toHaveLength(1);
    expect(verbLines.some((line) => line.startsWith("/train-skill"))).toBe(false);
  });


  it("rejects a trainerless skill purchase instead of fabricating a successful PurchaseSkillBox", async () => {
    const driver = {
      envelopes: [],
      sent: [],
      send(frame) {
        this.sent.push(frame);
        if (frame.op === "query" && frame.verb === "/nearby all") {
          this.envelopes.push({
            type: "query",
            line: frame.verb,
            verb: "nearby",
            data: { origin: { x: 803.85, y: 808.21, areaId: "open-desert-overworld" }, actors: [] },
          });
        }
      },
    };
    const context = createFlowContext({ flowName: "no-trainer", driver, sleep: async () => undefined, oracle: async () => ({ tick: 10 }) });

    await expect(trainSkill(context, "medic-novice")).rejects.toMatchObject({
      message: "no trainer available for skill medic-novice",
      details: { status: "fail", reason: "no_trainer" },
    });
    expect(driver.sent).toEqual([{ op: "query", verb: "/nearby all" }]);
  });
  it("retries trainSkill exactly at the authoritative economy ready tick without sleeping", async () => {
    const advances = [];
    let sleeps = 0;
    let commandId = 0;
    const driver = {
      envelopes: [],
      sent: [],
      send(frame) {
        this.sent.push(frame);
        commandId += 1;
        const accepted = commandId === 2;
        this.envelopes.push({ type: "event", event: "authority_queued", line: frame.line, data: { commandId, commandKind: "PurchaseSkillBox" } });
        this.envelopes.push({ type: "receipt", commandId, commandKind: "PurchaseSkillBox", accepted, reasonCode: accepted ? undefined : "economy_cooldown", tick: accepted ? 27 : 20 });
      },
    };
    const context = createFlowContext({
      flowName: "train-cooldown",
      driver,
      actor: { id: "player" },
      sleep: async () => { sleeps += 1; },
      advanceTicks: async (ticks) => { advances.push(ticks); },
      oracle: async () => ({ actors: { player: { id: "player", nextEconomyActionTick: 27 } } }),
    });

    const result = await trainSkill(context, "craftsman-novice", { trainerId: "trainer-1", move: false, maxCooldownRetries: 1 });

    expect(result).toMatchObject({
      status: "pass",
      trained: {
        receipt: { accepted: true, commandKind: "PurchaseSkillBox" },
        cooldownAttempts: [
          { receipt: { accepted: false, reasonCode: "economy_cooldown", tick: 20 } },
          { receipt: { accepted: true, tick: 27 } },
        ],
      },
    });
    expect(driver.sent.map((frame) => frame.line)).toEqual([
      "/train-skill craftsman-novice trainer-1",
      "/train-skill craftsman-novice trainer-1",
    ]);
    expect(advances).toEqual([7]);
    expect(sleeps).toBe(0);
  });

  it("retries setCareerGoal exactly at the authoritative economy ready tick without sleeping", async () => {
    const advances = [];
    let sleeps = 0;
    let commandId = 0;
    const driver = {
      envelopes: [],
      sent: [],
      send(frame) {
        this.sent.push(frame);
        commandId += 1;
        const accepted = commandId === 2;
        this.envelopes.push({ type: "event", event: "authority_queued", line: frame.line, data: { commandId, commandKind: "SetCareerGoal" } });
        this.envelopes.push({ type: "receipt", commandId, commandKind: "SetCareerGoal", accepted, reasonCode: accepted ? undefined : "economy_cooldown", tick: accepted ? 27 : 20 });
      },
    };
    const context = createFlowContext({
      flowName: "career-cooldown",
      driver,
      actor: { id: "player" },
      sleep: async () => { sleeps += 1; },
      advanceTicks: async (ticks) => { advances.push(ticks); },
      oracle: async () => ({ actors: { player: { id: "player", nextEconomyActionTick: 27 } } }),
    });

    const result = await setCareerGoal(context, "scout", { trainerId: "trainer-1", settleTicks: 0 });

    expect(result.command).toMatchObject({ receipt: { accepted: true, commandKind: "SetCareerGoal" }, cooldownAttempts: [{ receipt: { reasonCode: "economy_cooldown", accepted: false } }, { receipt: { accepted: true } }] });
    expect(driver.sent.map((frame) => frame.line)).toEqual(["/set-career-goal goal_id=scout trainer_actor_id=trainer-1", "/set-career-goal goal_id=scout trainer_actor_id=trainer-1"]);
    expect(advances).toEqual([7]);
    expect(sleeps).toBe(0);
  });

  it("retries economy cooldown at the canonical ingress refill cadence when authority omits the ready field", async () => {
    const advances = [];
    let commandId = 0;
    const driver = {
      envelopes: [],
      sent: [],
      send(frame) {
        this.sent.push(frame);
        commandId += 1;
        const accepted = commandId === 2;
        this.envelopes.push({ type: "event", event: "authority_queued", line: frame.line, data: { commandId, commandKind: "SetCareerGoal" } });
        this.envelopes.push({ type: "receipt", commandId, commandKind: "SetCareerGoal", accepted, reasonCode: accepted ? undefined : "economy_cooldown", tick: commandId });
      },
    };
    const context = createFlowContext({
      flowName: "career-cooldown-no-ready-tick",
      driver,
      actor: { id: "player" },
      sleep: async () => undefined,
      advanceTicks: async (ticks) => { advances.push(ticks); },
      oracle: async () => ({ actors: { player: { id: "player" } } }),
    });

    const result = await setCareerGoal(context, "scout", { trainerId: "trainer-1", settleTicks: 0, maxCooldownRetries: 1 });

    expect(result.command).toMatchObject({ receipt: { accepted: true }, cooldownAttempts: [{ receipt: { reasonCode: "economy_cooldown", accepted: false } }, { receipt: { accepted: true } }] });
    expect(advances).toEqual([6]);
    expect(driver.sent).toHaveLength(2);
  });

  it("retries ingress budget exhaustion at the same receipt-driven refill cadence", async () => {
    const advances = [];
    let commandId = 0;
    const driver = {
      envelopes: [],
      sent: [],
      send(frame) {
        this.sent.push(frame);
        commandId += 1;
        const accepted = commandId === 2;
        this.envelopes.push({ type: "event", event: "authority_queued", line: frame.line, data: { commandId, commandKind: "SetCareerGoal" } });
        this.envelopes.push({ type: "receipt", commandId, commandKind: "SetCareerGoal", accepted, reasonCode: accepted ? undefined : "ingress_budget_exhausted", tick: commandId });
      },
    };
    const context = createFlowContext({
      flowName: "career-ingress-refill",
      driver,
      actor: { id: "player" },
      sleep: async () => undefined,
      advanceTicks: async (ticks) => { advances.push(ticks); },
      oracle: async () => ({ actors: { player: { id: "player" } } }),
    });

    const result = await setCareerGoal(context, "scout", { trainerId: "trainer-1", settleTicks: 0, maxCooldownRetries: 1 });

    expect(result.command).toMatchObject({ receipt: { accepted: true }, cooldownAttempts: [{ receipt: { reasonCode: "ingress_budget_exhausted", accepted: false } }, { receipt: { accepted: true } }] });
    expect(advances).toEqual([6]);
    expect(driver.sent).toHaveLength(2);
  });

  it("rejects fractional and string maxCooldownRetries before dispatching an economy command", async () => {
    for (const maxCooldownRetries of [1.5, "2"]) {
      const driver = { envelopes: [], sent: [], send(frame) { this.sent.push(frame); } };
      const context = createFlowContext({ flowName: "career-cooldown-invalid-bound", driver, sleep: async () => undefined });

      await expect(setCareerGoal(context, "scout", { trainerId: "trainer-1", maxCooldownRetries }))
        .rejects.toThrow(/maxCooldownRetries must be an integer/);
      expect(driver.sent).toHaveLength(0);
    }
  });

  it("queues combat with the manifest-compatible positional attack line and observes the target downed", async () => {
    let tick = 0;
    const driver = {
      envelopes: [],
      sent: [],
      send(frame) {
        this.sent.push(frame);
        this.envelopes.push({ type: "event", event: "authority_queued", line: frame.line, data: { commandId: 17, commandKind: "QueueCombatAction" } });
        this.envelopes.push({ type: "receipt", commandId: 17, commandKind: "QueueCombatAction", accepted: true, tick: 1 });
      },
    };
    const context = createFlowContext({
      flowName: "attack-positional",
      driver,
      sleep: async () => undefined,
      advanceTicks: async (ticks) => { tick += ticks; },
      oracle: async () => ({ actors: { "target-1": { id: "target-1", lifeState: tick > 0 ? "downed" : "alive" } } }),
    });

    const result = await attackUntilDowned(context, "target-1", { actionId: "basic_shot", maxTicks: 1, pollTicks: 1, maxPolls: 2 });

    expect(driver.sent.map((frame) => frame.line)).toEqual(["/attack basic_shot target-1"]);
    expect(result).toMatchObject({ attack: { receipt: { commandKind: "QueueCombatAction", accepted: true } }, target: { id: "target-1", lifeState: "downed" } });
  });

  it("stops on the explicit respawning clone window before authority auto-clones", async () => {
    let tick = 0;
    const driver = {
      envelopes: [],
      sent: [],
      send(frame) {
        this.sent.push(frame);
        this.envelopes.push({ type: "event", event: "authority_queued", line: frame.line, data: { commandId: 18, commandKind: "QueueCombatAction" } });
        this.envelopes.push({ type: "receipt", commandId: 18, commandKind: "QueueCombatAction", accepted: true, tick: 1 });
      },
    };
    const context = createFlowContext({
      flowName: "attack-clone-window",
      driver,
      sleep: async () => undefined,
      advanceTicks: async (ticks) => { tick += ticks; },
      oracle: async () => ({
        actors: {
          "target-1": tick > 0
            ? { id: "target-1", lifeState: "respawning", respawnAtTick: 91, bodyVanishTick: 0 }
            : { id: "target-1", lifeState: "alive", respawnAtTick: 0, bodyVanishTick: 0 },
        },
      }),
    });

    const result = await attackUntilCloneEligible(context, "target-1", {
      actionId: "basic_shot",
      maxTicks: 1,
      pollTicks: 1,
      maxPolls: 2,
    });

    expect(driver.sent.map((frame) => frame.line)).toEqual(["/attack basic_shot target-1"]);
    expect(result).toMatchObject({
      respawnAtTick: 91,
      target: { id: "target-1", lifeState: "respawning", respawnAtTick: 91 },
      combat: { cloneEligible: true },
    });
  });

  it("requeues receipt-proven attacks on bounded cadence until authority reports the target downed", async () => {
    let tick = 0;
    const advances = [];
    const driver = {
      envelopes: [],
      sent: [],
      commandId: 0,
      send(frame) {
        this.sent.push(frame);
        this.commandId += 1;
        this.envelopes.push({ type: "event", event: "authority_queued", line: frame.line, data: { commandId: this.commandId, commandKind: "QueueCombatAction" } });
        this.envelopes.push({ type: "receipt", commandId: this.commandId, commandKind: "QueueCombatAction", accepted: true, tick: this.commandId });
      },
    };
    const context = createFlowContext({
      flowName: "attack-requeue",
      driver,
      sleep: async () => undefined,
      advanceTicks: async (ticks) => { advances.push(ticks); tick += ticks; },
      oracle: async () => ({ actors: { "target-1": { id: "target-1", lifeState: tick >= 45 ? "downed" : "alive" } } }),
    });

    const result = await attackUntilDowned(context, "target-1", { actionId: "basic_shot", pollTicks: 15, requeueTicks: 30, maxTicks: 45, maxPolls: 4 });

    expect(driver.sent.map((frame) => frame.line)).toEqual(["/attack basic_shot target-1", "/attack basic_shot target-1"]);
    expect(result).toMatchObject({ target: { lifeState: "downed" }, advancedTicks: 45 });
    expect(result.attacks).toHaveLength(2);
    expect(result.attack).toMatchObject({ commandId: 2, receipt: { commandKind: "QueueCombatAction", accepted: true } });
    expect(result.attacks.every((attack) => attack.receipt.commandKind === "QueueCombatAction" && attack.receipt.accepted)).toBe(true);
    expect(advances).toEqual([15, 15, 15]);
  });

  it("uses a bounded south-then-east approach corridor for a caged target before attacking", async () => {
    let tick = 0;
    let whereIndex = 0;
    let commandId = 0;
    const wherePositions = [
      { areaId: "desert", x: 512.3, y: 512, facing: "right" },
      { areaId: "desert", x: 512.3, y: 512.55, facing: "front" },
      { areaId: "desert", x: 516, y: 512.55, facing: "right" },
    ];
    const driver = {
      envelopes: [],
      sent: [],
      send(frame) {
        this.sent.push(frame);
        if (frame.op === "query") {
          const data = wherePositions[Math.min(whereIndex, wherePositions.length - 1)];
          whereIndex += 1;
          this.envelopes.push({ type: "query", line: frame.verb, verb: "where", data });
          return;
        }
        commandId += 1;
        const commandKind = frame.line.startsWith("/attack") ? "QueueCombatAction" : "SetMoveIntent";
        this.envelopes.push({ type: "event", event: "authority_queued", line: frame.line, data: { commandId, commandKind } });
        this.envelopes.push({ type: "receipt", commandId, commandKind, accepted: true, tick: commandId });
      },
    };
    const context = createFlowContext({
      flowName: "caged-target-corridor",
      driver,
      actor: { id: "player" },
      sleep: async () => undefined,
      advanceTicks: async (ticks) => { tick += ticks; },
      oracle: async () => ({ actors: {
        player: { id: "player", areaId: "desert", x: 512.3, y: 512, lifeState: "alive" },
        "target-1": { id: "target-1", areaId: "desert", x: 516.3, y: 511.3, lifeState: tick > 0 ? "downed" : "alive" },
      } }),
    });

    const result = await attackUntilDowned(context, "target-1", { actionId: "basic_shot", approachRangeCells: 1.25, pollTicks: 1, maxTicks: 1, maxPolls: 2, attackMoveOptions: { maxPulses: 3 } });
    const lines = driver.sent.filter((frame) => frame.op === "verb").map((frame) => frame.line);

    expect(result).toMatchObject({ movements: [{ approach: { x: 516.3, y: 512.55 }, movement: { status: "pass" } }], target: { lifeState: "downed" } });
    expect(lines).toEqual(["/set-move-intent 0 1 Front true", "/set-move-intent 1 0 Right true", "/set-move-intent 0 0 Right", "/attack basic_shot target-1"]);
  });

  it("approaches each moving authoritative target before bounded out_of_range retry requeues", async () => {
    let tick = 0;
    let whereIndex = 0;
    let commandId = 0;
    let attackCount = 0;
    const advances = [];
    const wherePositions = [
      { areaId: "desert", x: 0, y: 0, facing: "right" },
      { areaId: "desert", x: 0, y: 1.25, facing: "front" },
      { areaId: "desert", x: 3.75, y: 1.25, facing: "right" },
      { areaId: "desert", x: 3, y: 0, facing: "right" },
      { areaId: "desert", x: 3, y: 1.25, facing: "front" },
      { areaId: "desert", x: 5.75, y: 1.25, facing: "right" },
    ];
    const driver = {
      envelopes: [],
      sent: [],
      send(frame) {
        this.sent.push(frame);
        if (frame.op === "query") {
          const data = wherePositions[Math.min(whereIndex, wherePositions.length - 1)];
          whereIndex += 1;
          this.envelopes.push({ type: "query", line: frame.verb, verb: "where", data });
          return;
        }
        const commandKind = frame.line.startsWith("/attack") ? "QueueCombatAction" : "SetMoveIntent";
        commandId += 1;
        const isAttack = commandKind === "QueueCombatAction";
        if (isAttack) attackCount += 1;
        const accepted = !isAttack || attackCount > 1;
        this.envelopes.push({ type: "event", event: "authority_queued", line: frame.line, data: { commandId, commandKind } });
        this.envelopes.push({ type: "receipt", commandId, commandKind, accepted, reasonCode: accepted ? undefined : "out_of_range", tick: commandId });
      },
    };
    const context = createFlowContext({
      flowName: "attack-moving-target",
      driver,
      actor: { id: "player" },
      sleep: async () => undefined,
      advanceTicks: async (ticks) => { advances.push(ticks); tick += ticks; },
      oracle: async () => ({
        actors: {
          player: { id: "player", areaId: "desert", x: tick < 15 ? 0 : 3, y: 0, lifeState: "alive" },
          "target-1": { id: "target-1", areaId: "desert", x: tick < 30 ? 4 : 6, y: 0, lifeState: tick >= 45 ? "downed" : "alive" },
        },
      }),
    });

    const result = await attackUntilDowned(context, "target-1", { actionId: "basic_shot", approachRangeCells: 1.25, pollTicks: 15, requeueTicks: 30, maxTicks: 45, maxPolls: 4, attackMoveOptions: { maxPulses: 3 } });
    const attackLines = driver.sent.filter((frame) => frame.op === "verb" && frame.line.startsWith("/attack")).map((frame) => frame.line);
    const firstAttackIndex = driver.sent.findIndex((frame) => frame.line === "/attack basic_shot target-1");

    expect(attackLines).toEqual(["/attack basic_shot target-1", "/attack basic_shot target-1"]);
    expect(result).toMatchObject({ target: { lifeState: "downed" }, rejectedAttempts: [{ receipt: { commandKind: "QueueCombatAction", accepted: false, reasonCode: "out_of_range" } }], attacks: [{ receipt: { accepted: true, commandKind: "QueueCombatAction" } }], movements: [{ target: { x: 4, y: 0 } }, { target: { x: 6, y: 0 } }] });
    expect(result.attack).toMatchObject({ receipt: { accepted: true, commandKind: "QueueCombatAction" } });
    expect(driver.sent.slice(0, firstAttackIndex).filter((frame) => frame.op === "verb").every((frame) => frame.line.startsWith("/set-move-intent"))).toBe(true);
    expect(advances).toEqual([15, 15, 15]);
  });

  it("retains target_unavailable as transient retry evidence while the authoritative target remains alive", async () => {
    let tick = 0;
    let commandId = 0;
    const driver = {
      envelopes: [],
      sent: [],
      send(frame) {
        this.sent.push(frame);
        commandId += 1;
        const accepted = commandId === 2;
        this.envelopes.push({ type: "event", event: "authority_queued", line: frame.line, data: { commandId, commandKind: "QueueCombatAction" } });
        this.envelopes.push({ type: "receipt", commandId, commandKind: "QueueCombatAction", accepted, reasonCode: accepted ? undefined : "target_unavailable", tick: commandId });
      },
    };
    const context = createFlowContext({
      flowName: "attack-target-unavailable-retry",
      driver,
      sleep: async () => undefined,
      advanceTicks: async (ticks) => { tick += ticks; },
      oracle: async () => ({ actors: { "target-1": { id: "target-1", lifeState: tick >= 45 ? "downed" : "alive" } } }),
    });

    const result = await attackUntilDowned(context, "target-1", { actionId: "basic_shot", pollTicks: 15, requeueTicks: 30, maxTicks: 45, maxPolls: 4 });

    expect(driver.sent.map((frame) => frame.line)).toEqual(["/attack basic_shot target-1", "/attack basic_shot target-1"]);
    expect(result).toMatchObject({ target: { lifeState: "downed" }, rejectedAttempts: [{ receipt: { reasonCode: "target_unavailable", accepted: false } }], attacks: [{ receipt: { commandKind: "QueueCombatAction", accepted: true } }] });
  });

  it("fails before a second attack when the target disappears after transient target_unavailable", async () => {
    let tick = 0;
    const driver = {
      envelopes: [],
      sent: [],
      send(frame) {
        this.sent.push(frame);
        this.envelopes.push({ type: "event", event: "authority_queued", line: frame.line, data: { commandId: 1, commandKind: "QueueCombatAction" } });
        this.envelopes.push({ type: "receipt", commandId: 1, commandKind: "QueueCombatAction", accepted: false, reasonCode: "target_unavailable", tick: 1 });
      },
    };
    const context = createFlowContext({
      flowName: "attack-target-missing",
      driver,
      sleep: async () => undefined,
      advanceTicks: async (ticks) => { tick += ticks; },
      oracle: async () => tick === 0 ? { actors: { "target-1": { id: "target-1", lifeState: "alive" } } } : { actors: {} },
    });

    await expect(attackUntilDowned(context, "target-1", { actionId: "basic_shot", pollTicks: 15, requeueTicks: 30, maxTicks: 45, maxPolls: 4 }))
      .rejects.toThrow(/attack target target-1 is absent from oracle/);
    expect(driver.sent.map((frame) => frame.line)).toEqual(["/attack basic_shot target-1"]);
  });

  it("waits for inventory delta in sampleLoop and keeps receipt details structured", async () => {
    const driver = new FixtureDriver({ inventory: [2, 2, 15] });
    const result = await sampleLoop(ctx(driver), "iron", 10, { pollMs: 1 });

    expect(result.status).toBe("pass");
    expect(result.gained).toBe(13);
    expect(result.sample.receipt).toMatchObject({ commandKind: "SampleResource", accepted: true });
  });

  it("maps deltas to the same cardinal headings as the runtime", () => {
    expect(headingForDelta(5, 1)).toBe("right");
    expect(headingForDelta(-5, 1)).toBe("left");
    expect(headingForDelta(0, -2)).toBe("back");
    expect(headingForDelta(0, 2)).toBe("front");
  });

  it("can issue a raw authority primitive and capture the accepted receipt", async () => {
    const driver = new FixtureDriver();
    const result = await issueAuthorityLine(ctx(driver), "/sample iron", { commandKind: "SampleResource" });
    expect(result).toMatchObject({ status: "pass", commandKind: "SampleResource", receipt: { accepted: true } });
  });

  // --- Five Coverage-Gap Actions & Behavior Tests ---

  it("assigns the exact authority inventory stack to a craft slot only after the session confirms it", async () => {
    const driver = {
      envelopes: [],
      sent: [],
      send(frame) {
        this.sent.push(frame);
        this.envelopes.push({ type: "event", event: "authority_queued", line: frame.line, data: { commandId: 31, commandKind: "CraftAssignSlot" } });
        this.envelopes.push({ type: "receipt", commandId: 31, commandKind: "CraftAssignSlot", accepted: true, tick: 1 });
        this.envelopes.push({
          type: "event",
          event: "craft_session",
          data: { payload: { phase: "slots", slotScreen: { slots: [{ slotIndex: 2, assigned: { stackId: "stack-1" } }] } } },
        });
      },
    };
    const context = createFlowContext({ flowName: "craft-assign-slot", driver, sleep: async () => undefined, advanceTicks: async () => undefined, oracle: async () => ({ tick: 1 }) });

    const result = await craftAssignSlot(context, 2, { container: "player:field-pack", stackId: "stack-1", variantId: 0 });

    expect(result).toMatchObject({
      status: "pass",
      item: { container: "player:field-pack", stackId: "stack-1", variantId: 0 },
      command: { receipt: { commandKind: "CraftAssignSlot", accepted: true } },
    });
    expect(driver.sent.map((frame) => frame.line)).toEqual(["/craft-assign-slot slot_index=2 container=player:field-pack stack_id=stack-1 variant_id=0"]);
  });

  it("selects actor-owned craft inventory over a richer cache row and rejects explicit cache ownership", async () => {
    const driver = {
      envelopes: [],
      sent: [],
      send(frame) {
        this.sent.push(frame);
        this.envelopes.push({ type: "event", event: "authority_queued", line: frame.line, data: { commandId: 32, commandKind: "CraftAssignSlot" } });
        this.envelopes.push({ type: "receipt", commandId: 32, commandKind: "CraftAssignSlot", accepted: true, tick: 1 });
        this.envelopes.push({ type: "event", event: "craft_session", data: { payload: { phase: "slots", slotScreen: { slots: [{ slotIndex: 0, assigned: { stackId: "pack-stack" } }] } } } });
      },
    };
    const context = createFlowContext({
      flowName: "craft-owned-inventory",
      driver,
      actor: { id: "player" },
      sleep: async () => undefined,
      advanceTicks: async () => undefined,
      oracle: async () => ({ tick: 1, inventory: [
        { container: "cache:shared", itemId: 6200, stackId: "cache-stack", variantId: 0, available: 99 },
        { container: "player:field-pack", itemId: 6200, stackId: "pack-stack", variantId: 0, available: 1 },
      ] }),
    });

    const selected = await craftAssignSlot(context, 0, { itemId: 6200 });
    expect(selected.item).toMatchObject({ container: "player:field-pack", stackId: "pack-stack", available: 1 });
    expect(driver.sent.map((frame) => frame.line)).toEqual(["/craft-assign-slot slot_index=0 container=player:field-pack stack_id=pack-stack variant_id=0"]);

    const sentBeforeUnownedAttempt = driver.sent.length;
    await expect(craftAssignSlot(context, 1, { container: "cache:shared", stackId: "cache-stack", variantId: 0 }))
      .rejects.toThrow(/craft slot 1 container is not actor-owned/);
    expect(driver.sent).toHaveLength(sentBeforeUnownedAttempt);
  });

  it("craftClearSlot behavior test: clears assigned slot index in craft session", async () => {
    let tick = 0;
    const envelopes = [];
    const driver = {
      envelopes,
      sent: [],
      send(frame) {
        this.sent.push(frame);
        if (frame.op === "verb" && frame.line.startsWith("/craft-clear-slot")) {
          // Push queued, receipt, and craft session events
          this.envelopes.push({ v: "successor.driver.v1", type: "event", event: "authority_queued", line: frame.line, data: { commandId: 42, commandKind: "CraftClearSlot", flushed: 1 } });
          this.envelopes.push({ v: "successor.driver.v1", type: "receipt", commandId: 42, commandKind: "CraftClearSlot", accepted: true, tick: 1 });
          this.envelopes.push({
            v: "successor.driver.v1",
            type: "event",
            event: "craft_session",
            data: {
              payload: {
                phase: "slots",
                recipeId: "iron-ingot",
                slotScreen: {
                  slots: [{ slotIndex: 2, assigned: null }]
                }
              }
            }
          });
        }
      }
    };

    const context = createFlowContext({
      flowName: "test-craftClearSlot",
      driver,
      gameUrl: "http://127.0.0.1:28999",
      sleep: async () => undefined,
      advanceTicks: async (ticks) => { tick += ticks; },
      oracle: async () => ({ tick })
    });

    const result = await craftClearSlot(context, 2);
    expect(result.status).toBe("pass");
    expect(result.command.receipt.accepted).toBe(true);
    expect(driver.sent[0].line).toBe("/craft-clear-slot slot_index=2");
  });

  it("craftClearSlot behavior test rejection path: fails when command is rejected", async () => {
    let tick = 0;
    const envelopes = [];
    const driver = {
      envelopes,
      sent: [],
      send(frame) {
        this.sent.push(frame);
        if (frame.op === "verb" && frame.line.startsWith("/craft-clear-slot")) {
          this.envelopes.push({ v: "successor.driver.v1", type: "event", event: "authority_queued", line: frame.line, data: { commandId: 43, commandKind: "CraftClearSlot", flushed: 1 } });
          this.envelopes.push({ v: "successor.driver.v1", type: "receipt", commandId: 43, commandKind: "CraftClearSlot", accepted: false, reasonCode: "invalid_slot", tick: 1 });
        }
      }
    };

    const context = createFlowContext({
      flowName: "test-craftClearSlot-rejection",
      driver,
      gameUrl: "http://127.0.0.1:28999",
      sleep: async () => undefined,
      advanceTicks: async (ticks) => { tick += ticks; },
      oracle: async () => ({ tick })
    });

    await expect(craftClearSlot(context, 2)).rejects.toThrow(/receipt rejected for \/craft-clear-slot/);
  });

  it("craftDraftSchematic behavior test: drafts a schematic with max_uses", async () => {
    let tick = 0;
    const envelopes = [];
    const driver = {
      envelopes,
      sent: [],
      send(frame) {
        this.sent.push(frame);
        if (frame.op === "verb" && frame.line.startsWith("/craft-draft-schematic")) {
          this.envelopes.push({ v: "successor.driver.v1", type: "event", event: "authority_queued", line: frame.line, data: { commandId: 50, commandKind: "CraftDraftSchematic", flushed: 1 } });
          this.envelopes.push({ v: "successor.driver.v1", type: "receipt", commandId: 50, commandKind: "CraftDraftSchematic", accepted: true, tick: 1 });
        }
      }
    };

    const context = createFlowContext({
      flowName: "test-craftDraftSchematic",
      driver,
      gameUrl: "http://127.0.0.1:28999",
      sleep: async () => undefined,
      advanceTicks: async (ticks) => { tick += ticks; },
      oracle: async () => ({
        tick,
        draftedSchematics: tick > 0 ? [{ id: "schem-1", schematicId: "schem-1", maxUses: 5 }] : []
      })
    });

    const result = await craftDraftSchematic(context, 5);
    expect(result.status).toBe("pass");
    expect(result.schematic.id).toBe("schem-1");
    expect(driver.sent[0].line).toBe("/craft-draft-schematic max_uses=5");
  });

  it("craftDraftSchematic behavior test rejection path: fails when command is rejected", async () => {
    let tick = 0;
    const envelopes = [];
    const driver = {
      envelopes,
      sent: [],
      send(frame) {
        this.sent.push(frame);
        if (frame.op === "verb" && frame.line.startsWith("/craft-draft-schematic")) {
          this.envelopes.push({ v: "successor.driver.v1", type: "event", event: "authority_queued", line: frame.line, data: { commandId: 51, commandKind: "CraftDraftSchematic", flushed: 1 } });
          this.envelopes.push({ v: "successor.driver.v1", type: "receipt", commandId: 51, commandKind: "CraftDraftSchematic", accepted: false, reasonCode: "insufficient_materials", tick: 1 });
        }
      }
    };

    const context = createFlowContext({
      flowName: "test-craftDraftSchematic-rejection",
      driver,
      gameUrl: "http://127.0.0.1:28999",
      sleep: async () => undefined,
      advanceTicks: async (ticks) => { tick += ticks; },
      oracle: async () => ({ tick })
    });

    await expect(craftDraftSchematic(context, 5)).rejects.toThrow(/receipt rejected/);
  });

  it("removeFarmStructure behavior test: removes a placed structure from parcel", async () => {
    let tick = 0;
    let removalCount = 0;
    const envelopes = [];
    const driver = {
      envelopes,
      sent: [],
      send(frame) {
        this.sent.push(frame);
        if (frame.op === "verb" && frame.line.startsWith("/remove-farm-structure")) {
          removalCount += 1;
          const commandId = 60 + removalCount;
          this.envelopes.push({ v: "successor.driver.v1", type: "event", event: "authority_queued", line: frame.line, data: { commandId, commandKind: "RemoveFarmStructure", flushed: 1 } });
          this.envelopes.push({ v: "successor.driver.v1", type: "receipt", commandId, commandKind: "RemoveFarmStructure", accepted: removalCount === 1, reasonCode: removalCount === 1 ? undefined : "no_farm_structure", tick: 1 });
        }
      }
    };

    const context = createFlowContext({
      flowName: "test-removeFarmStructure",
      driver,
      gameUrl: "http://127.0.0.1:28999",
      sleep: async () => undefined,
      advanceTicks: async (ticks) => { tick += ticks; },
      oracle: async () => ({
        tick,
        inventory: tick > 0 ? [{ itemId: 6301, available: 1 }] : []
      })
    });

    const result = await removeFarmStructure(context, "parcel-1", "struct-2", { itemId: 6301 });
    expect(result.status).toBe("pass");
    expect(result.afterAvailable).toBe(1);
    expect(driver.sent[0].line).toBe("/remove-farm-structure parcel_id=parcel-1 structure_id=struct-2");
    expect(result.absence.receipt).toMatchObject({ commandKind: "RemoveFarmStructure", accepted: false, reasonCode: "no_farm_structure" });
    expect(driver.sent.map((frame) => frame.line)).toEqual([
      "/remove-farm-structure parcel_id=parcel-1 structure_id=struct-2",
      "/remove-farm-structure parcel_id=parcel-1 structure_id=struct-2",
    ]);
  });

  it("removeFarmStructure behavior test rejection path: fails when command is rejected", async () => {
    let tick = 0;
    const envelopes = [];
    const driver = {
      envelopes,
      sent: [],
      send(frame) {
        this.sent.push(frame);
        if (frame.op === "verb" && frame.line.startsWith("/remove-farm-structure")) {
          this.envelopes.push({ v: "successor.driver.v1", type: "event", event: "authority_queued", line: frame.line, data: { commandId: 61, commandKind: "RemoveFarmStructure", flushed: 1 } });
          this.envelopes.push({ v: "successor.driver.v1", type: "receipt", commandId: 61, commandKind: "RemoveFarmStructure", accepted: false, reasonCode: "invalid_permissions", tick: 1 });
        }
      }
    };

    const context = createFlowContext({
      flowName: "test-removeFarmStructure-rejection",
      driver,
      gameUrl: "http://127.0.0.1:28999",
      sleep: async () => undefined,
      advanceTicks: async (ticks) => { tick += ticks; },
      oracle: async () => ({ tick })
    });

    await expect(removeFarmStructure(context, "parcel-1", "struct-2", { itemId: 6301 })).rejects.toThrow(/receipt rejected/);
  });

  it("spliceClearSlot behavior test: clears bioengineering splice slot", async () => {
    let tick = 0;
    const envelopes = [];
    const driver = {
      envelopes,
      sent: [],
      send(frame) {
        this.sent.push(frame);
        if (frame.op === "verb" && frame.line.startsWith("/splice-clear-slot")) {
          this.envelopes.push({ v: "successor.driver.v1", type: "event", event: "authority_queued", line: frame.line, data: { commandId: 70, commandKind: "SpliceClearSlot", flushed: 1 } });
          this.envelopes.push({ v: "successor.driver.v1", type: "receipt", commandId: 70, commandKind: "SpliceClearSlot", accepted: true, tick: 1 });
          this.envelopes.push({
            v: "successor.driver.v1",
            type: "event",
            event: "splice_session",
            data: {
              payload: {
                slots: [{ slotIndex: 1, filled: false }]
              }
            }
          });
        }
      }
    };

    const context = createFlowContext({
      flowName: "test-spliceClearSlot",
      driver,
      gameUrl: "http://127.0.0.1:28999",
      sleep: async () => undefined,
      advanceTicks: async (ticks) => { tick += ticks; },
      oracle: async () => ({ tick })
    });

    const result = await spliceClearSlot(context, 1);
    expect(result.status).toBe("pass");
    expect(result.command.receipt.accepted).toBe(true);
    expect(driver.sent[0].line).toBe("/splice-clear-slot slot_index=1");
  });

  it("spliceClearSlot behavior test rejection path: fails when command is rejected", async () => {
    let tick = 0;
    const envelopes = [];
    const driver = {
      envelopes,
      sent: [],
      send(frame) {
        this.sent.push(frame);
        if (frame.op === "verb" && frame.line.startsWith("/splice-clear-slot")) {
          this.envelopes.push({ v: "successor.driver.v1", type: "event", event: "authority_queued", line: frame.line, data: { commandId: 71, commandKind: "SpliceClearSlot", flushed: 1 } });
          this.envelopes.push({ v: "successor.driver.v1", type: "receipt", commandId: 71, commandKind: "SpliceClearSlot", accepted: false, reasonCode: "invalid_slot", tick: 1 });
        }
      }
    };

    const context = createFlowContext({
      flowName: "test-spliceClearSlot-rejection",
      driver,
      gameUrl: "http://127.0.0.1:28999",
      sleep: async () => undefined,
      advanceTicks: async (ticks) => { tick += ticks; },
      oracle: async () => ({ tick })
    });

    await expect(spliceClearSlot(context, 1)).rejects.toThrow(/receipt rejected/);
  });

  it("spliceCancel behavior test: cancels active splice session", async () => {
    let tick = 0;
    const envelopes = [];
    const driver = {
      envelopes,
      sent: [],
      send(frame) {
        this.sent.push(frame);
        if (frame.op === "verb" && frame.line.startsWith("/splice-cancel")) {
          this.envelopes.push({ v: "successor.driver.v1", type: "event", event: "authority_queued", line: frame.line, data: { commandId: 80, commandKind: "SpliceCancel", flushed: 1 } });
          this.envelopes.push({ v: "successor.driver.v1", type: "receipt", commandId: 80, commandKind: "SpliceCancel", accepted: true, tick: 1 });
          this.envelopes.push({
            v: "successor.driver.v1",
            type: "event",
            event: "splice_session",
            data: {
              payload: { phase: "browse" }
            }
          });
        }
      }
    };

    const context = createFlowContext({
      flowName: "test-spliceCancel",
      driver,
      gameUrl: "http://127.0.0.1:28999",
      sleep: async () => undefined,
      advanceTicks: async (ticks) => { tick += ticks; },
      oracle: async () => ({ tick })
    });

    const result = await spliceCancel(context);
    expect(result.status).toBe("pass");
    expect(result.command.receipt.accepted).toBe(true);
    expect(driver.sent[0].line).toBe("/splice-cancel");
  });

  it("spliceCancel behavior test rejection path: surfaces the authority actor-asleep rejection", async () => {
    let tick = 0;
    const envelopes = [];
    const driver = {
      envelopes,
      sent: [],
      send(frame) {
        this.sent.push(frame);
        if (frame.op === "verb" && frame.line.startsWith("/splice-cancel")) {
          this.envelopes.push({ v: "successor.driver.v1", type: "event", event: "authority_queued", line: frame.line, data: { commandId: 81, commandKind: "SpliceCancel", flushed: 1 } });
          this.envelopes.push({ v: "successor.driver.v1", type: "receipt", commandId: 81, commandKind: "SpliceCancel", accepted: false, reasonCode: "actor_asleep", tick: 1 });
        }
      }
    };

    const context = createFlowContext({
      flowName: "test-spliceCancel-rejection",
      driver,
      gameUrl: "http://127.0.0.1:28999",
      sleep: async () => undefined,
      advanceTicks: async (ticks) => { tick += ticks; },
      oracle: async () => ({ tick })
    });

    await expect(spliceCancel(context)).rejects.toThrow(/receipt rejected.*actor_asleep/u);
  });

  // --- Dispatcher, Invariants, Bounds & Semantic Tests ---

  it("injected sleep/advance only: verify no global sleep pauses wall time", async () => {
    let tick = 0;
    let virtualSleepCount = 0;
    const driver = new FixtureDriver();
    const context = createFlowContext({
      flowName: "test-virtual-time",
      driver,
      gameUrl: "http://127.0.0.1:28999",
      sleep: async (ms) => {
        virtualSleepCount += 1;
      },
      advanceTicks: async (ticks) => {
        tick += ticks;
      },
      oracle: async () => ({ tick })
    });

    const startWallTime = Date.now();
    await context.sleep(5000); // 5 seconds virtual sleep
    await context.advanceTicks(150); // 5 seconds of ticks at 30Hz
    const duration = Date.now() - startWallTime;

    expect(duration).toBeLessThan(100); // Should run in less than 100ms
    expect(virtualSleepCount).toBe(1);
    expect(tick).toBe(150);
  });

  it("bounds/timeouts: test that waitForEnvelope throws FlowStepError on timeout", async () => {
    const driver = new FixtureDriver();
    const context = createFlowContext({
      flowName: "test-timeout",
      driver,
      gameUrl: "http://127.0.0.1:28999",
      sleep: async () => undefined,
    });

    await expect(waitForEnvelope(context, () => false, "never", 1))
      .rejects.toThrow(FlowStepError);
  });

  it("retains the 48-unit sampling budget while attempting canonical positional cleanup on timeout", async () => {
    let commandId = 0;
    const driver = {
      envelopes: [],
      sent: [],
      send(frame) {
        this.sent.push(frame);
        if (frame.op === "query") {
          this.envelopes.push({ type: "query", line: frame.verb, verb: "where", data: { areaId: "desert", x: 10, y: 10, facing: "right" } });
          return;
        }
        commandId += 1;
        const commandKind = frame.line.startsWith("/survey") ? "SurveyResource" : frame.line.startsWith("/sample") ? "SampleResource" : "SetMoveIntent";
        this.envelopes.push({ type: "event", event: "authority_queued", line: frame.line, data: { commandId, commandKind } });
        this.envelopes.push({ type: "receipt", commandId, commandKind, accepted: true, tick: commandId });
        if (frame.line.startsWith("/survey")) this.envelopes.push({ type: "event", event: "survey_result", data: { payload: { family: "metal", spawnId: "open-desert-overworld:iron", areaId: "desert", centerX: 10, centerY: 10, rangeCells: 0, stepCells: 1, cols: 1, concentrationMilli: [100] } } });
      },
    };
    const context = createFlowContext({ flowName: "sample-timeout-cleanup", driver, actor: { id: "player" }, sleep: async () => undefined, advanceTicks: async () => undefined, oracle: async () => ({ inventory: [{ container: "cache:shared", itemId: 7100, available: 99 }, { container: "player:field-pack", itemId: 7100, available: 0 }] }) });

    await expect(surveyAndSample(context, "iron", { itemId: 7100, minUnits: 48, pollTicks: 30, maxPolls: 1, standAfter: false }))
      .rejects.toMatchObject({ details: { maxTicks: 28_800, maxPolls: 1, advancedTicks: 30 } });
    expect(driver.sent.filter((frame) => frame.op === "verb").map((frame) => frame.line).slice(-2)).toEqual(["/sample iron", "/sample iron true"]);
  });

  it("survey richest-cell movement: selects richest survey cell and moves", async () => {
    let tick = 0;
    const envelopes = [];
    const driver = {
      envelopes,
      sent: [],
      send(frame) {
        this.sent.push(frame);
        if (frame.op === "query" && frame.verb.startsWith("/where")) {
          this.envelopes.push({ v: "successor.driver.v1", type: "query", line: frame.verb, verb: "where", text: "WHERE 10,10", data: { areaId: "desert", x: 10, y: 10, facing: "right" } });
        }
        if (frame.op === "verb") {
          const commandId = ++this.commandId;
          const cmdName = frame.line.split(" ")[0].replace("/", "");
          const commandKind = cmdName === "survey" ? "SurveyResource" : "SetMoveIntent";
          this.envelopes.push({ v: "successor.driver.v1", type: "event", event: "authority_queued", line: frame.line, data: { commandId, commandKind, flushed: 1 } });
          if (cmdName === "survey") {
            this.envelopes.push({
              v: "successor.driver.v1",
              type: "event",
              event: "survey_result",
              data: {
                payload: {
                  family: "metal",
                  spawnId: "open-desert-overworld:iron",
                  centerX: 10,
                  centerY: 10,
                  rangeCells: 8,
                  stepCells: 4,
                  cols: 3,
                  rows: 3,
                  concentrationMilli: [100, 200, 300, 400, 900, 600, 700, 800, 50]
                }
              }
            });
          }
          this.envelopes.push({ v: "successor.driver.v1", type: "receipt", commandId, commandKind, accepted: true, tick: commandId });
        }
      },
      commandId: 0
    };

    const context = createFlowContext({
      flowName: "test-survey-richest",
      driver,
      gameUrl: "http://127.0.0.1:28999",
      sleep: async () => undefined,
      advanceTicks: async (ticks) => { tick += ticks; },
      oracle: async () => ({
        tick,
        actors: {
          "player": { id: "player", x: 10, y: 10 }
        }
      })
    });


    const result = await surveyBest(context, "iron", { requireAccepted: false });
    expect(result.survey.status).toBe("pass");
    expect(result.best).toMatchObject({ x: 6, y: 6 });
  });

  it("rejects a buffered broad metal survey result when its canonical spawn identity is not the requested resource", async () => {
    const driver = {
      envelopes: [],
      sent: [],
      send(frame) {
        this.sent.push(frame);
        this.envelopes.push({ type: "event", event: "authority_queued", line: frame.line, data: { commandId: 91, commandKind: "SurveyResource" } });
        this.envelopes.push({ type: "event", event: "survey_result", data: { payload: { family: "metal", spawnId: "open-desert-overworld:copper", concentrationMilli: [100], cols: 1 } } });
        this.envelopes.push({ type: "receipt", commandId: 91, commandKind: "SurveyResource", accepted: true, tick: 1 });
      },
    };
    const context = createFlowContext({ flowName: "survey-wrong-spawn", driver, sleep: async () => undefined });

    await expect(surveyBest(context, "iron", { surveyResultTimeoutMs: 1 })).rejects.toThrow(/timed out waiting for survey result for iron/);
    expect(driver.sent.map((frame) => frame.line)).toEqual(["/survey iron"]);
  });

  it("matches petrochemical by canonical spawn identity and broad metal by family identity", async () => {
    const survey = async (requested, payload) => {
      const driver = {
        envelopes: [],
        sent: [],
        send(frame) {
          this.sent.push(frame);
          this.envelopes.push({ type: "event", event: "authority_queued", line: frame.line, data: { commandId: 92, commandKind: "SurveyResource" } });
          this.envelopes.push({ type: "event", event: "survey_result", data: { payload } });
          this.envelopes.push({ type: "receipt", commandId: 92, commandKind: "SurveyResource", accepted: true, tick: 1 });
        },
      };
      const context = createFlowContext({ flowName: `survey-${requested}`, driver, sleep: async () => undefined });
      return surveyBest(context, requested);
    };

    const petrochemical = await survey("petrochemical", { family: "chemical", spawnId: "open-desert-overworld:petrochemical", concentrationMilli: [250], cols: 1 });
    const metal = await survey("metal", { family: "metal", spawnId: "open-desert-overworld:copper", concentrationMilli: [900], cols: 1 });

    expect(petrochemical).toMatchObject({ survey: { receipt: { accepted: true, commandKind: "SurveyResource" } }, result: { family: "chemical", spawnId: "open-desert-overworld:petrochemical" }, best: { concentrationMilli: 250 } });
    expect(metal).toMatchObject({ survey: { receipt: { accepted: true, commandKind: "SurveyResource" } }, result: { family: "metal", spawnId: "open-desert-overworld:copper" }, best: { concentrationMilli: 900 } });
  });

  it("craft line_id experiment semantics: throws when assembled session has no matching line_id", async () => {
    let tick = 0;
    const envelopes = [];
    const driver = {
      envelopes,
      sent: [],
      send(frame) {
        this.sent.push(frame);
        if (frame.op === "verb") {
          const commandId = ++this.commandId;
          let commandKind = "Unknown";
          if (frame.line.startsWith("/craft-begin")) commandKind = "CraftBegin";
          else if (frame.line.startsWith("/craft-assemble")) commandKind = "CraftAssemble";

          this.envelopes.push({ v: "successor.driver.v1", type: "event", event: "authority_queued", line: frame.line, data: { commandId, commandKind, flushed: 1 } });
          this.envelopes.push({ v: "successor.driver.v1", type: "receipt", commandId, commandKind, accepted: true, tick: commandId });

          if (commandKind === "CraftBegin") {
            this.envelopes.push({ v: "successor.driver.v1", type: "event", event: "craft_session", data: { payload: { phase: "slots", recipeId: "iron-plate" } } });
          } else if (commandKind === "CraftAssemble") {
            this.envelopes.push({
              v: "successor.driver.v1",
              type: "event",
              event: "craft_session",
              data: {
                payload: {
                  phase: "assembled",
                  recipeId: "iron-plate",
                  assembled: {
                    lines: [{ lineId: 1, name: "Quality" }]
                  }
                }
              }
            });
          }
        }
      },
      commandId: 0
    };

    const context = createFlowContext({
      flowName: "test-craft-experiments",
      driver,
      gameUrl: "http://127.0.0.1:28999",
      sleep: async () => undefined,
      advanceTicks: async (ticks) => { tick += ticks; },
      oracle: async () => ({ tick })
    });

    // Passing experiments with lineId 999 which does not exist in assembled lines
    await expect(craftRecipe(context, "iron-plate", [], {
      experiments: [{ lineId: 999, points: 5 }]
    })).rejects.toThrow(/has no experimentation line_id 999/);
  });

  it("correlates an authority receipt by both queued command identity and command kind", async () => {
    const driver = {
      envelopes: [],
      sent: [],
      send(frame) {
        this.sent.push(frame);
        this.envelopes.push({ type: "event", event: "authority_queued", line: frame.line, data: { commandId: 42, commandKind: "SampleResource" } });
        this.envelopes.push({ type: "receipt", commandId: 41, commandKind: "SampleResource", accepted: true });
        this.envelopes.push({ type: "receipt", commandId: 42, commandKind: "WrongKind", accepted: true });
        this.envelopes.push({ type: "receipt", commandId: 42, commandKind: "SampleResource", accepted: true, tick: 9 });
      },
    };
    const result = await issueAuthorityLine(ctx(driver), "/sample iron", { commandKind: "SampleResource" });
    expect(result).toMatchObject({ status: "pass", commandId: 42, commandKind: "SampleResource", receipt: { commandId: 42, commandKind: "SampleResource", accepted: true } });
  });

  it("fails before receipt wait when the queued command kind is not the requested authority command", async () => {
    const driver = { envelopes: [], sent: [], send(frame) {
      this.sent.push(frame);
      this.envelopes.push({ type: "event", event: "authority_queued", line: frame.line, data: { commandId: 7, commandKind: "SetMoveIntent" } });
    } };
    await expect(issueAuthorityLine(ctx(driver), "/sample iron", { commandKind: "SampleResource" }))
      .rejects.toMatchObject({ details: { reason: "wrong_command_kind", commandId: 7, commandKind: "SetMoveIntent" } });
  });

  it("rejects non-positive, fractional, and string schematic maxUses before issuing authority", async () => {
    for (const maxUses of [0, -1, 1.5, "2"]) {
      const driver = new FixtureDriver();
      const context = createFlowContext({ flowName: "strict-max-uses", driver, sleep: async () => undefined });
      await expect(craftDraftSchematic(context, maxUses)).rejects.toThrow(/maxUses must be (an integer|a positive integer)/);
      expect(driver.sent).toHaveLength(0);
    }
  });

  it("sends craft experimentation with the authority line_id only after the assembled session exposes that line", async () => {
    let commandId = 0;
    const driver = { envelopes: [], sent: [], send(frame) {
      this.sent.push(frame);
      const line = frame.line;
      const commandKind = line.startsWith("/craft-begin") ? "CraftBegin" : line.startsWith("/craft-assemble") ? "CraftAssemble" : line.startsWith("/craft-experiment") ? "CraftExperiment" : "CraftFinalizePrototype";
      commandId += 1;
      this.envelopes.push({ type: "event", event: "authority_queued", line, data: { commandId, commandKind } });
      this.envelopes.push({ type: "receipt", commandId, commandKind, accepted: true, tick: commandId });
      if (commandKind === "CraftBegin") this.envelopes.push({ type: "event", event: "craft_session", data: { payload: { phase: "slots", recipeId: "iron-plate" } } });
      if (commandKind === "CraftAssemble" || commandKind === "CraftExperiment") this.envelopes.push({ type: "event", event: "craft_session", data: { payload: { phase: "assembled", recipeId: "iron-plate", assembled: { lines: [{ lineId: 4, name: "quality" }] } } } });
      if (commandKind === "CraftFinalizePrototype") this.envelopes.push({ type: "event", event: "craft_session", data: { payload: { phase: "browse" } } });
    } };
    const context = createFlowContext({ flowName: "craft-line-id", driver, sleep: async () => undefined, advanceTicks: async () => undefined, oracle: async () => ({ tick: 10 }) });
    const result = await craftRecipe(context, "iron-plate", [], { experiments: [{ line_id: 4, points: 7 }], settleTicks: 0 });
    expect(result.status).toBe("pass");
    expect(driver.sent.map((frame) => frame.line)).toContain("/craft-experiment line_id=4 points=7");
    expect(result.commands.find((command) => command.commandKind === "CraftExperiment")?.receipt).toMatchObject({ accepted: true, commandKind: "CraftExperiment" });
  });

  it("projects the accepted artifact PlantSeed receipt to its exact tile, genome, species, inventory debit, and water follow-up", async () => {
    const parcelId = "parcel:ashvat:1";
    const cell = { x: 804, y: 808 };
    const seed = { itemId: 6001, variantId: 1, species: "ashgrain" };
    let planted = false;
    let watered = false;
    const driver = { envelopes: [], sent: [], send(frame) {
      this.sent.push(frame);
      const commandKind = frame.line.startsWith("/plant-seed") ? "PlantSeed" : "WaterTile";
      this.envelopes.push({ type: "event", event: "authority_queued", line: frame.line, data: { commandId: 756, commandKind, flushed: 1 } });
      this.envelopes.push({ type: "receipt", commandId: 756, commandKind, accepted: true, tick: 260661 });
      if (commandKind === "PlantSeed") planted = true;
      else watered = true;
    } };
    const crop = { seedItemId: 6001, seedVariantId: 1, species: "ashgrain" };
    const context = createFlowContext({
      flowName: "artifact-plant-seed-projection",
      driver,
      actor: { id: "organic" },
      sleep: async () => undefined,
      advanceTicks: async () => undefined,
      oracle: async () => ({
        tick: 260661,
        inventory: [{ container: "organic:field-pack", stackId: "7", itemId: 6001, variantId: 1, available: planted ? 1 : 2 }],
        farmPlots: [{ parcelId, tiles: [
          { cellX: 803, cellY: 808, tilled: true, moisturePct: 100, crop },
          { cellX: 804, cellY: 808, tilled: true, moisturePct: watered ? 100 : 0, crop: planted ? crop : null },
        ] }],
      }),
    });

    const plantedResult = await plantSeed(context, parcelId, cell, seed, { maxPolls: 1, maxTicks: 1 });
    expect(plantedResult).toMatchObject({
      status: "pass",
      seed: { container: "organic:field-pack", stackId: "7", itemId: 6001, variantId: 1, available: 2 },
      command: { receipt: { commandId: 756, commandKind: "PlantSeed", accepted: true, tick: 260661 } },
      tile: { cellX: 804, cellY: 808, crop },
      oracle: { inventory: [{ container: "organic:field-pack", stackId: "7", itemId: 6001, variantId: 1, available: 1 }] },
    });
    const wateredResult = await waterTile(context, parcelId, cell, { maxPolls: 1, maxTicks: 1 });
    expect(wateredResult).toMatchObject({
      status: "pass",
      command: { receipt: { commandKind: "WaterTile", accepted: true } },
      tile: { cellX: 804, cellY: 808, moisturePct: 100, crop },
    });
    expect(driver.sent.map((frame) => frame.line)).toEqual([
      "/plant-seed parcel_id=parcel:ashvat:1 cell_x=804 cell_y=808 container=organic:field-pack stack_id=7 variant_id=1",
      "/water-tile parcel_id=parcel:ashvat:1 cell_x=804 cell_y=808",
    ]);
  });

  it("fails closed after an accepted PlantSeed receipt when only another cell or genome/species matches", async () => {
    const parcelId = "parcel:ashvat:1";
    const target = { x: 804, y: 808 };
    const seed = { itemId: 6001, variantId: 1, species: "ashgrain" };
    const matchingCrop = { seedItemId: 6001, seedVariantId: 1, species: "ashgrain" };
    const rejectedProjection = async (targetCrop) => {
      const driver = { envelopes: [], sent: [], send(frame) {
        this.sent.push(frame);
        this.envelopes.push({ type: "event", event: "authority_queued", line: frame.line, data: { commandId: 756, commandKind: "PlantSeed", flushed: 1 } });
        this.envelopes.push({ type: "receipt", commandId: 756, commandKind: "PlantSeed", accepted: true, tick: 260661 });
      } };
      const context = createFlowContext({
        flowName: "artifact-plant-seed-mismatch",
        driver,
        actor: { id: "organic" },
        sleep: async () => undefined,
        advanceTicks: async () => undefined,
        oracle: async () => ({
          tick: 260661,
          inventory: [{ container: "organic:field-pack", stackId: "7", itemId: 6001, variantId: 1, available: 1 }],
          farmPlots: [
            { parcelId, tiles: [{ cellX: 803, cellY: 808, tilled: true, moisturePct: 100, crop: matchingCrop }, { cellX: 804, cellY: 808, tilled: true, moisturePct: 100, crop: targetCrop }] },
            { parcelId: "parcel:other:1", tiles: [{ cellX: 804, cellY: 808, tilled: true, moisturePct: 100, crop: matchingCrop }] },
          ],
        }),
      });
      await expect(plantSeed(context, parcelId, target, seed, { maxPolls: 1, maxTicks: 1 })).rejects.toMatchObject({
        message: "timed out waiting for planted tile 804,808",
        details: { lastReceipt: { commandId: 756, commandKind: "PlantSeed", accepted: true, tick: 260661 } },
      });
      expect(driver.sent).toHaveLength(1);
    };

    await rejectedProjection({ seedItemId: 6001, seedVariantId: 2, species: "ashgrain" });
    await rejectedProjection({ seedItemId: 6001, seedVariantId: 1, species: "grubroot" });
  });

  it("places then proves removal through the returned item and a no_farm_structure retry receipt", async () => {
    let available = 2;
    let structureExists = false;
    let commandId = 0;
    const driver = { envelopes: [], sent: [], send(frame) {
      this.sent.push(frame);
      commandId += 1;
      const isPlace = frame.line.startsWith("/place-farm-structure");
      const accepted = isPlace || structureExists;
      const commandKind = isPlace ? "PlaceFarmStructure" : "RemoveFarmStructure";
      this.envelopes.push({ type: "event", event: "authority_queued", line: frame.line, data: { commandId, commandKind } });
      this.envelopes.push({ type: "receipt", commandId, commandKind, accepted, reasonCode: accepted ? undefined : "no_farm_structure", tick: commandId });
      if (isPlace) { available -= 1; structureExists = true; } else if (accepted) { available += 1; structureExists = false; }
    } };
    const context = createFlowContext({ flowName: "place-remove-farm-structure", driver, sleep: async () => undefined, advanceTicks: async () => undefined, oracle: async () => ({ inventory: [{ itemId: 6301, available }] }) });
    const placed = await placeFarmStructure(context, "parcel-1", 6301, { x: 2, y: 3 });
    const removed = await removeFarmStructure(context, "parcel-1", "structure-1", { itemId: 6301 });
    expect(placed).toMatchObject({ status: "pass", beforeAvailable: 2, afterAvailable: 1, command: { receipt: { commandKind: "PlaceFarmStructure", accepted: true } } });
    expect(removed).toMatchObject({ status: "pass", beforeAvailable: 1, afterAvailable: 2, removalConfirmed: true, absence: { receipt: { accepted: false, reasonCode: "no_farm_structure" } } });
    expect(driver.sent.map((frame) => frame.line)).toEqual(["/place-farm-structure parcel_id=parcel-1 structure_item_id=6301 cell_x=2 cell_y=3", "/remove-farm-structure parcel_id=parcel-1 structure_id=structure-1", "/remove-farm-structure parcel_id=parcel-1 structure_id=structure-1"]);
  });

  it("opens a splice session before clearing its slot and cancelling it", async () => {
    let commandId = 0;
    const driver = { envelopes: [], sent: [], send(frame) {
      this.sent.push(frame);
      commandId += 1;
      const commandKind = frame.line.startsWith("/splice-begin") ? "SpliceBegin" : frame.line.startsWith("/splice-assign-slot") ? "SpliceAssignSlot" : frame.line.startsWith("/splice-clear-slot") ? "SpliceClearSlot" : "SpliceCancel";
      this.envelopes.push({ type: "event", event: "authority_queued", line: frame.line, data: { commandId, commandKind } });
      this.envelopes.push({ type: "receipt", commandId, commandKind, accepted: true, tick: commandId });
      const payload = commandKind === "SpliceBegin" ? { phase: "slots", slots: [{ slotIndex: 1, filled: false }] } : commandKind === "SpliceAssignSlot" ? { phase: "slots", slots: [{ slotIndex: 1, filled: true }] } : commandKind === "SpliceClearSlot" ? { phase: "slots", slots: [{ slotIndex: 1, filled: false }] } : { phase: "browse" };
      this.envelopes.push({ type: "event", event: "splice_session", data: { payload } });
    } };
    const context = createFlowContext({ flowName: "splice-lifecycle", driver, sleep: async () => undefined, advanceTicks: async () => undefined, oracle: async () => ({ tick: 10, inventory: [{ container: "player:field-pack", stackId: "stack-1", variantId: 0, itemId: 7001, available: 1 }] }) });
    const begun = await spliceBegin(context, "cactus");
    const assigned = await spliceAssignSlot(context, 1, { container: "player:field-pack", stackId: "stack-1", variantId: 0 });
    const cleared = await spliceClearSlot(context, 1);
    const cancelled = await spliceCancel(context);
    expect([begun, assigned, cleared, cancelled].map((result) => result.command.receipt.commandKind)).toEqual(["SpliceBegin", "SpliceAssignSlot", "SpliceClearSlot", "SpliceCancel"]);
    expect(driver.sent.map((frame) => frame.line)).toEqual(["/splice-begin species=cactus", "/splice-assign-slot slot_index=1 container=player:field-pack stack_id=stack-1 variant_id=0", "/splice-clear-slot slot_index=1", "/splice-cancel"]);
  });

  it("waits for collectable units on the requested extractor, not another hopper's progress", async () => {
    let tick = 0;
    const context = createFlowContext({ flowName: "extractor-collectable", driver: new FixtureDriver(), sleep: async () => undefined, advanceTicks: async (ticks) => { tick += ticks; }, oracle: async () => ({ placedExtractors: [{ extractorId: "other", collectableUnits: 99, hopperPct: 99 }, { extractorId: "target", collectableUnits: tick >= 2 ? 2 : 0, hopperPct: 100 }] }) });
    const result = await waitForExtractorCollectable(context, "target", { minUnits: 2, pollTicks: 2, maxTicks: 2, maxPolls: 2 });
    expect(result).toMatchObject({ status: "pass", extractor: { extractorId: "target", collectableUnits: 2 }, collectableUnits: 2, advancedTicks: 2 });
  });

  it("reports bounded wait diagnostics after the injected polling budget is exhausted", async () => {
    let sleeps = 0;
    const context = createFlowContext({ flowName: "bounded-wait", driver: new FixtureDriver(), sleep: async () => { sleeps += 1; } });
    await expect(waitForEnvelope(context, () => false, "never", 10, 0, { pollMs: 1, maxPolls: 2 })).rejects.toMatchObject({ details: { label: "never", maxPolls: 2, recentEnvelopes: [] } });
    expect(sleeps).toBe(2);
  });
  it("waits through the Clod lifecycle, then harvests the exact owned canonical corpse with its correlated receipt", async () => {
    const advances = [];
    let oracleCall = 0;
    let whereCall = 0;
    let commandId = 0;
    const target = {
      id: "organic-clod-02",
      areaId: "open-desert-overworld",
      x: 10,
      y: 0,
      lifeState: "downed",
      lootable: true,
      bodyVanishTick: 99,
      lootRightsActorId: "organic",
    };
    const driver = {
      envelopes: [],
      sent: [],
      send(frame) {
        this.sent.push(frame);
        if (frame.op === "query") {
          const position = [{ areaId: "open-desert-overworld", x: 0, y: 0 }, { areaId: "open-desert-overworld", x: 0, y: 0 }, { areaId: "open-desert-overworld", x: 8.2, y: 0 }][Math.min(whereCall++, 2)];
          this.envelopes.push({ type: "query", line: frame.verb, verb: "where", data: position });
          return;
        }
        commandId += 1;
        const commandKind = frame.line.startsWith("/harvest-corpse") ? "HarvestCorpse" : "SetMoveIntent";
        this.envelopes.push({ type: "event", event: "authority_queued", line: frame.line, data: { commandId, commandKind } });
        if (commandKind === "HarvestCorpse") this.envelopes.push({ type: "receipt", commandId: commandId - 1, commandKind, accepted: true, tick: commandId - 1 });
        this.envelopes.push({ type: "receipt", commandId, commandKind, accepted: true, tick: commandId });
      },
    };
    const context = createFlowContext({
      flowName: "organic-clod-02-harvest",
      actor: { id: "organic" },
      driver,
      sleep: async () => undefined,
      advanceTicks: async (ticks) => { advances.push(ticks); },
      oracle: async () => {
        const call = oracleCall++;
        return {
          actors: {
            organic: { id: "organic", areaId: "open-desert-overworld", x: call >= 2 ? 8.4 : 0, y: 0 },
            "organic-clod-02": call === 0
              ? { ...target, lifeState: "alive", lootable: false, bodyVanishTick: 0, lootRightsActorId: null }
              : target,
          },
        };
      },
    });

    const result = await harvestCorpse(context, "organic-clod-02", { harvestReadyPollTicks: 2, harvestReadyMaxTicks: 8 });

    expect(result).toMatchObject({
      status: "pass",
      target: { id: "organic-clod-02", lootRightsActorId: "organic", lifeState: "downed", lootable: true },
      ready: { polls: 2, advancedTicks: 2 },
      approach: { areaId: "open-desert-overworld", x: 8.9, y: 0 },
      movement: { arrivalDistanceCells: 0.7 },
      command: { commandId: 3, commandKind: "HarvestCorpse", receipt: { commandId: 3, commandKind: "HarvestCorpse", accepted: true } },
    });
    expect(advances).toEqual([2, 1]);
    expect(driver.sent.filter((frame) => frame.op === "verb").map((frame) => frame.line)).toEqual([
      "/set-move-intent 1 0 Right true",
      "/set-move-intent 0 0 Right",
      "/harvest-corpse target_actor_id=organic-clod-02",
    ]);
  });

  it("rejects a foreign-owned corpse without queuing an unavailable harvest", async () => {
    const advances = [];
    const driver = { envelopes: [], sent: [], send(frame) { this.sent.push(frame); } };
    const context = createFlowContext({
      flowName: "foreign-clod-corpse",
      actor: { id: "organic" },
      driver,
      sleep: async () => undefined,
      advanceTicks: async (ticks) => { advances.push(ticks); },
      oracle: async () => ({
        actors: {
          "organic-clod-02": { id: "organic-clod-02", lifeState: "downed", lootable: true, bodyVanishTick: 99, lootRightsActorId: "other-player" },
          "other-clod": { id: "other-clod", lifeState: "downed", lootable: true, bodyVanishTick: 99, lootRightsActorId: "organic" },
        },
      }),
    });

    await expect(harvestCorpse(context, "organic-clod-02", { harvestReadyPollTicks: 2, harvestReadyMaxTicks: 2 }))
      .rejects.toMatchObject({ details: { label: "actor-owned harvestable corpse organic-clod-02", advancedTicks: 2 } });
    expect(advances).toEqual([2]);
    expect(driver.sent).toEqual([]);
  });

  it("fails closed on an ambiguous canonical target instead of falling back to another harvestable corpse", async () => {
    const driver = { envelopes: [], sent: [], send(frame) { this.sent.push(frame); } };
    const context = createFlowContext({
      flowName: "ambiguous-clod-corpse",
      actor: { id: "organic" },
      driver,
      sleep: async () => undefined,
      advanceTicks: async () => undefined,
      oracle: async () => ({
        actors: {
          "organic-clod-02": { id: "corpse:organic-clod-02", lifeState: "downed", lootable: true, bodyVanishTick: 99, lootRightsActorId: "organic" },
          "organic-clod-03": { id: "organic-clod-03", lifeState: "downed", lootable: true, bodyVanishTick: 99, lootRightsActorId: "organic" },
        },
      }),
    });

    await expect(harvestCorpse(context, "organic-clod-02", { harvestReadyPollTicks: 1, harvestReadyMaxTicks: 1 }))
      .rejects.toThrow("timed out waiting for actor-owned harvestable corpse organic-clod-02");
    expect(driver.sent).toEqual([]);
  });
  it("does not dispatch harvest when post-approach canonical revalidation finds the actor outside authority range", async () => {
    let oracleCall = 0;
    let commandId = 0;
    const driver = {
      envelopes: [],
      sent: [],
      send(frame) {
        this.sent.push(frame);
        if (frame.op === "query") {
          this.envelopes.push({ type: "query", line: frame.verb, verb: "where", data: { areaId: "open-desert-overworld", x: 0, y: 0 } });
          return;
        }
        commandId += 1;
        this.envelopes.push({ type: "event", event: "authority_queued", line: frame.line, data: { commandId, commandKind: "SetMoveIntent" } });
        this.envelopes.push({ type: "receipt", commandId, commandKind: "SetMoveIntent", accepted: true, tick: commandId });
      },
    };
    const target = { id: "organic-clod-02", areaId: "open-desert-overworld", x: 0, y: 0, lifeState: "downed", lootable: true, bodyVanishTick: 99, lootRightsActorId: "organic" };
    const context = createFlowContext({
      flowName: "out-of-range-clod-corpse",
      actor: { id: "organic" },
      driver,
      sleep: async () => undefined,
      advanceTicks: async () => undefined,
      oracle: async () => ({ actors: { organic: { id: "organic", areaId: "open-desert-overworld", x: oracleCall++ === 0 ? 0 : 2, y: 0 }, "organic-clod-02": target } }),
    });

    await expect(harvestCorpse(context, "organic-clod-02"))
      .rejects.toMatchObject({ details: { target: { id: "organic-clod-02" }, harvester: { id: "organic" }, distanceCells: 2, interactionRadiusCells: 1.75 } });
    expect(driver.sent.filter((frame) => frame.op === "verb").map((frame) => frame.line)).toEqual(["/set-move-intent 0 0 Right"]);
  });
});
