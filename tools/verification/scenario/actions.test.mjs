import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  dispatchScenarioAction,
  getScenarioAction,
  scenarioActionNames,
  ScenarioActionDispatchError,
} from "./actions.mjs";

function createMockScenarioContext(alias, actorId, options = {}) {
  const driver = options.driver ?? {
    envelopes: [],
    sent: [],
    send(frame) {
      this.sent.push(frame);
      const line = frame.line ?? frame.verb ?? "";
      if (!line) return;

      if (frame.op === "query") {
        if (line.startsWith("/where")) {
          this.envelopes.push({
            v: "successor.driver.v1",
            type: "query",
            line,
            verb: "where",
            text: "WHERE 10,10",
            data: { areaId: "desert", x: 10, y: 10 }
          });
        }
        return;
      }

      const commandId = this.envelopes.length + 1;
      const cmdName = line.split(" ")[0].replace("/", "");
      const commandKind = options.commandKindMap?.[cmdName] ?? "Unknown";

      this.envelopes.push({
        v: "successor.driver.v1",
        type: "event",
        event: "authority_queued",
        line,
        data: { commandId, commandKind, flushed: 1 }
      });

      const accepted = options.rejectCommand === cmdName ? false : true;
      const reasonCode = options.rejectCommand === cmdName ? (options.reasonCode ?? "error") : undefined;

      this.envelopes.push({
        v: "successor.driver.v1",
        type: "receipt",
        commandId,
        commandKind,
        accepted,
        reasonCode,
        tick: commandId
      });

      if (options.onVerb) {
        options.onVerb(this, line, commandId);
      }
    }
  };

  const boundContexts = new Map();

  const ctx = {
    driver,
    gameUrl: "http://127.0.0.1:28999",
    actor: { alias, id: actorId, actorId },
    actorId,
    tickRateHz: 30,
    defaultTimeoutMs: 50,
    sleep: options.sleep ?? (async () => undefined),
    advanceTicks: options.advanceTicks ?? (async () => undefined),
    recordFrame: options.recordFrame ?? (() => undefined),
    oracle: options.oracle ?? (async () => ({ tick: 0 })),
    forActor(newAlias) {
      if (newAlias === alias) return ctx;
      if (boundContexts.has(newAlias)) return boundContexts.get(newAlias);
      const subCtx = createMockScenarioContext(newAlias, `${newAlias}-id`, options);
      boundContexts.set(newAlias, subCtx);
      return subCtx;
    }
  };

  return ctx;
}

describe("scenario action dispatcher", () => {

  it("actor binding: dispatches action bound to correct target actor", async () => {
    let boundActor = null;
    const baseContext = createMockScenarioContext("alpha", "alpha-id", {
      commandKindMap: { "target-dummy": "TestCommand" },
      onVerb: (driver, line) => {
        // Just empty
      }
    });

    // We override forActor to spy on binding
    const originalForActor = baseContext.forActor;
    baseContext.forActor = (alias) => {
      boundActor = alias;
      return originalForActor(alias);
    };

    const spec = {
      name: "query",
      actor: "beta",
      args: { line: "/where" }
    };

    const envelope = await dispatchScenarioAction(spec, baseContext);
    expect(boundActor).toBe("beta");
    expect(envelope.status).toBe("pass");
    expect(envelope.actor).toBe("beta");
  });

  it("tooth test: swallowed command rejection fails dispatcher with ScenarioActionDispatchError", async () => {
    const context = createMockScenarioContext("alpha", "alpha-id", {
      commandKindMap: { "till-tile": "TillTile" },
      rejectCommand: "till-tile",
      reasonCode: "out_of_bounds"
    });

    const spec = {
      name: "tillTile",
      args: { parcelId: "p-1", cell: { x: 5, y: 5 } }
    };

    await expect(dispatchScenarioAction(spec, context)).rejects.toThrow(ScenarioActionDispatchError);
  });

  it("tooth test: missing receipt (timeout) throws ScenarioActionDispatchError", async () => {
    // A driver that never pushes the receipt envelope
    const driver = {
      envelopes: [],
      sent: [],
      send(frame) {
        this.sent.push(frame);
        // Push queued but NO receipt
        this.envelopes.push({
          v: "successor.driver.v1",
          type: "event",
          event: "authority_queued",
          line: frame.line,
          data: { commandId: 99, commandKind: "TillTile", flushed: 1 }
        });
      }
    };

    const context = createMockScenarioContext("alpha", "alpha-id", { driver });

    const spec = {
      name: "tillTile",
      args: { parcelId: "p-1", cell: { x: 5, y: 5 } }
    };

    // Should time out and fail
    await expect(dispatchScenarioAction(spec, context)).rejects.toThrow(ScenarioActionDispatchError);
  });

  it("tooth test: wrong oracle transition fails and throws ScenarioActionDispatchError", async () => {
    // tillTile polls oracle expecting row.tilled === true.
    // We mock the oracle returning tilled = false indefinitely.
    const context = createMockScenarioContext("alpha", "alpha-id", {
      commandKindMap: { "till-tile": "TillTile" },
      oracle: async () => ({
        tick: 0,
        inventory: [],
        placedParcels: [{
          parcelId: "p-1",
          tiles: [{ cellX: 5, cellY: 5, tilled: false }]
        }]
      })
    });

    const spec = {
      name: "tillTile",
      args: { parcelId: "p-1", cell: { x: 5, y: 5 } }
    };

    await expect(dispatchScenarioAction(spec, context)).rejects.toThrow(ScenarioActionDispatchError);
  });

  it("retries trainSkill at the authoritative economy ready tick without applying scenario settleTicks", async () => {
    const advances = [];
    let sleepCalls = 0;
    let commandId = 0;
    const driver = {
      envelopes: [],
      sent: [],
      send(frame) {
        this.sent.push(frame);
        commandId += 1;
        const accepted = commandId === 2;
        this.envelopes.push({
          v: "successor.driver.v1",
          type: "event",
          event: "authority_queued",
          line: frame.line,
          data: { commandId, commandKind: "PurchaseSkillBox", flushed: 1 },
        });
        this.envelopes.push({
          v: "successor.driver.v1",
          type: "receipt",
          commandId,
          commandKind: "PurchaseSkillBox",
          accepted,
          ...(accepted ? {} : { reasonCode: "economy_cooldown" }),
          tick: accepted ? 27 : 20,
        });
      },
    };
    const context = createMockScenarioContext("alpha", "alpha-id", {
      driver,
      advanceTicks: async (ticks) => { advances.push(ticks); },
      sleep: async () => { sleepCalls += 1; },
      oracle: async () => ({ actors: { "alpha-id": { id: "alpha-id", nextEconomyActionTick: 27 } } }),
    });

    const result = await dispatchScenarioAction({
      name: "trainSkill",
      args: { boxId: "craftsman-novice", trainerId: "trainer-bob", move: false, settleTicks: 10, maxCooldownRetries: 1 },
    }, context);

    expect(result).toMatchObject({
      status: "pass",
      result: {
        trained: {
          receipt: { accepted: true, commandKind: "PurchaseSkillBox", tick: 27 },
          cooldownAttempts: [
            { receipt: { accepted: false, reasonCode: "economy_cooldown", tick: 20 } },
            { receipt: { accepted: true, tick: 27 } },
          ],
        },
      },
    });
    expect(driver.sent.map((frame) => frame.line)).toEqual([
      "/train-skill craftsman-novice trainer-bob",
      "/train-skill craftsman-novice trainer-bob",
    ]);
    expect(advances).toEqual([7]);
    expect(sleepCalls).toBe(0);
  });

  it("craftRecipeBatch accepts all three required extractor finalizations serially", async () => {
    const context = createMockScenarioContext("alpha", "alpha-id", {
      commandKindMap: {
        "craft-begin": "CraftBegin",
        "craft-assemble": "CraftAssemble",
        "craft-finalize-prototype": "CraftFinalizePrototype"
      },
      onVerb: (driver, line) => {
        const recipeId = line.match(/^\/craft-begin recipe_id=(.+)$/)?.[1];
        const phase = recipeId
          ? { phase: "slots", recipeId }
          : line === "/craft-assemble"
            ? { phase: "assembled", recipeId: "metal_extractor" }
            : line === "/craft-finalize-prototype"
              ? { phase: "browse" }
              : null;
        if (phase) {
          driver.envelopes.push({
            v: "successor.driver.v1",
            type: "event",
            event: "craft_session",
            data: { payload: phase }
          });
        }
      }
    });

    const result = await dispatchScenarioAction({
      name: "craftRecipeBatch",
      actor: "alpha",
      args: { recipeId: "metal_extractor", count: 3, settleTicks: 0 }
    }, context);

    expect(result).toMatchObject({
      status: "pass",
      result: { recipeId: "metal_extractor", count: 3 },
    });
    expect(result.result.runs).toHaveLength(3);
    expect(result.receipts
      .filter((receipt) => receipt.commandKind === "CraftFinalizePrototype")
      .map(({ accepted }) => accepted)).toEqual([true, true, true]);
    expect(context.driver.sent.map((frame) => frame.line)).toEqual([
      "/craft-begin recipe_id=metal_extractor",
      "/craft-assemble",
      "/craft-finalize-prototype",
      "/craft-begin recipe_id=metal_extractor",
      "/craft-assemble",
      "/craft-finalize-prototype",
      "/craft-begin recipe_id=metal_extractor",
      "/craft-assemble",
      "/craft-finalize-prototype"
    ]);
  });

  it("craftRecipeBatch surfaces a rejected extractor finalization instead of reporting the batch as complete", async () => {
    let finalizations = 0;
    const context = createMockScenarioContext("alpha", "alpha-id", {
      commandKindMap: {
        "craft-begin": "CraftBegin",
        "craft-assemble": "CraftAssemble",
        "craft-finalize-prototype": "CraftFinalizePrototype"
      },
      onVerb: (driver, line) => {
        const recipeId = line.match(/^\/craft-begin recipe_id=(.+)$/)?.[1];
        const phase = recipeId
          ? { phase: "slots", recipeId }
          : line === "/craft-assemble"
            ? { phase: "assembled", recipeId: "metal_extractor" }
            : line === "/craft-finalize-prototype"
              ? { phase: "browse" }
              : null;
        if (line === "/craft-finalize-prototype") {
          finalizations += 1;
          if (finalizations === 2) {
            const receipt = driver.envelopes.findLast((envelope) => envelope.type === "receipt");
            receipt.accepted = false;
            receipt.reasonCode = "missing_inputs";
          }
        }
        if (phase) {
          driver.envelopes.push({
            v: "successor.driver.v1",
            type: "event",
            event: "craft_session",
            data: { payload: phase }
          });
        }
      }
    });

    await expect(dispatchScenarioAction({
      name: "craftRecipeBatch",
      actor: "alpha",
      args: { recipeId: "metal_extractor", count: 3, settleTicks: 0 }
    }, context)).rejects.toThrow(ScenarioActionDispatchError);
    expect(finalizations).toBe(2);
  });

  it("craftRecipeBatch rejects a non-positive count before authority dispatch", async () => {
    const context = createMockScenarioContext("alpha", "alpha-id");
    await expect(dispatchScenarioAction({
      name: "craftRecipeBatch",
      args: { recipeId: "solid_delivery_shell", count: 0 }
    }, context)).rejects.toThrow(ScenarioActionDispatchError);
    expect(context.driver.sent).toHaveLength(0);
  });

  // --- Table Testing Five Coverage-Gap Actions ---

  describe("five coverage-gap actions scenario dispatch tests", () => {
    it("craftClearSlot dispatch success", async () => {
      const context = createMockScenarioContext("alpha", "alpha-id", {
        commandKindMap: { "craft-clear-slot": "CraftClearSlot" },
        oracle: async () => ({ tick: 10 }),
        onVerb: (driver, line, cmdId) => {
          driver.envelopes.push({
            v: "successor.driver.v1",
            type: "event",
            event: "craft_session",
            data: {
              payload: {
                phase: "slots",
                slotScreen: {
                  slots: [{ slotIndex: 3, assigned: null }]
                }
              }
            }
          });
        }
      });

      const spec = {
        name: "craftClearSlot",
        args: { slotIndex: 3 }
      };

      const result = await dispatchScenarioAction(spec, context);
      expect(result.status).toBe("pass");
      expect(result.receipts[0].commandKind).toBe("CraftClearSlot");
    });

    it("craftDraftSchematic dispatch success", async () => {
      let tick = 0;
      const context = createMockScenarioContext("alpha", "alpha-id", {
        commandKindMap: { "craft-draft-schematic": "CraftDraftSchematic" },
        advanceTicks: async (t) => { tick += t; },
        oracle: async () => ({
          tick,
          draftedSchematics: tick > 0 ? [{ id: "schem-x", maxUses: 3 }] : []
        })
      });

      const spec = {
        name: "craftDraftSchematic",
        args: { maxUses: 3 }
      };

      const result = await dispatchScenarioAction(spec, context);
      expect(result.status).toBe("pass");
      expect(result.result.schematic.id).toBe("schem-x");
    });

    it("removeFarmStructure dispatch confirms returned item and authoritative absence", async () => {
    let tick = 0;
    let removeCalls = 0;
    const context = createMockScenarioContext("alpha", "alpha-id", {
      commandKindMap: { "remove-farm-structure": "RemoveFarmStructure" },
      advanceTicks: async (t) => { tick += t; },
      oracle: async () => ({
        tick,
        inventory: [{ container: "cache:shared", itemId: 6301, available: 99 }, { container: "alpha-id:field-pack", itemId: 6301, available: tick > 0 ? 1 : 0 }]
      }),
      onVerb: (driver, line) => {
        if (!line.startsWith("/remove-farm-structure")) return;
        removeCalls += 1;
        if (removeCalls === 2) {
          const receipt = driver.envelopes.at(-1);
          receipt.accepted = false;
          receipt.reasonCode = "no_farm_structure";
        }
      },
    });

    const spec = {
      name: "removeFarmStructure",
      args: { parcelId: "p-1", structureId: "s-1", itemId: 6301 }
    };

    const result = await dispatchScenarioAction(spec, context);
    expect(result.status).toBe("pass");
    expect(result.result).toMatchObject({ afterAvailable: 1, removalConfirmed: true, absence: { receipt: { accepted: false, reasonCode: "no_farm_structure" } } });
    expect(result.receipts.map((receipt) => receipt.commandKind)).toEqual(["RemoveFarmStructure", "RemoveFarmStructure"]);
    });

    it("spliceClearSlot dispatch success", async () => {
      const context = createMockScenarioContext("alpha", "alpha-id", {
        commandKindMap: { "splice-clear-slot": "SpliceClearSlot" },
        oracle: async () => ({ tick: 10 }),
        onVerb: (driver, line, cmdId) => {
          driver.envelopes.push({
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
      });

      const spec = {
        name: "spliceClearSlot",
        args: { slotIndex: 1 }
      };

      const result = await dispatchScenarioAction(spec, context);
      expect(result.status).toBe("pass");
      expect(result.receipts[0].commandKind).toBe("SpliceClearSlot");
    });

    it("spliceCancel dispatch success", async () => {
      const context = createMockScenarioContext("alpha", "alpha-id", {
        commandKindMap: { "splice-cancel": "SpliceCancel" },
        oracle: async () => ({ tick: 10 }),
        onVerb: (driver, line, cmdId) => {
          driver.envelopes.push({
            v: "successor.driver.v1",
            type: "event",
            event: "splice_session",
            data: {
              payload: { phase: "browse" }
            }
          });
        }
      });

      const spec = {
        name: "spliceCancel",
        args: {}
      };

      const result = await dispatchScenarioAction(spec, context);
      expect(result.status).toBe("pass");
      expect(result.receipts[0].commandKind).toBe("SpliceCancel");
    });
  });

  it("dispatches flattened move coordinates through receipt-checked SetMoveIntent", async () => {
    const context = createMockScenarioContext("alpha", "alpha-id", {
      commandKindMap: { "set-move-intent": "SetMoveIntent" },
    });

    const envelope = await dispatchScenarioAction({
      name: "moveTo",
      args: { x: 10, y: 10, toleranceCells: 0.1 },
    }, context);

    expect(envelope).toMatchObject({
      status: "pass",
      receipts: [{ commandKind: "SetMoveIntent", accepted: true }],
      result: { stop: { receipt: { commandKind: "SetMoveIntent", accepted: true } } },
    });
    expect(context.driver.sent.map((frame) => frame.line ?? frame.verb)).toEqual(["/where", "/set-move-intent 0 0 Right"]);
  });

  it("routes an actor-scoped placement only through the selected actor driver and captures its receipt", async () => {
    let tick = 0;
    const beta = createMockScenarioContext("beta", "beta-id", {
      commandKindMap: { "place-farm-structure": "PlaceFarmStructure" },
      advanceTicks: async (ticks) => { tick += ticks; },
      oracle: async () => ({ inventory: [{ container: "cache:shared", itemId: 6301, available: 99 }, { container: "beta-id:field-pack", itemId: 6301, available: tick > 0 ? 1 : 2 }] }),
    });
    const alpha = createMockScenarioContext("alpha", "alpha-id");
    alpha.forActor = (alias) => alias === "beta" ? beta : null;

    const envelope = await dispatchScenarioAction({
      name: "placeFarmStructure",
      actor: "beta",
      args: { parcelId: "parcel-1", structureItemId: 6301, cell: { x: 2, y: 3 } },
    }, alpha);

    expect(envelope).toMatchObject({ actor: "beta", status: "pass", receipts: [{ commandKind: "PlaceFarmStructure", accepted: true }], result: { beforeAvailable: 2, afterAvailable: 1 } });
    expect(alpha.driver.sent).toHaveLength(0);
    expect(beta.driver.sent.map((frame) => frame.line)).toEqual(["/place-farm-structure parcel_id=parcel-1 structure_item_id=6301 cell_x=2 cell_y=3"]);
  });

  it("propagates a degraded survey receipt as a warning envelope instead of reporting pass", async () => {
    const context = createMockScenarioContext("alpha", "alpha-id", {
      commandKindMap: { survey: "SurveyResource" },
      rejectCommand: "survey",
      reasonCode: "scanner_jammed",
    });

    const envelope = await dispatchScenarioAction({
      name: "surveyBest",
      args: { family: "iron", move: false, requireAccepted: false },
    }, context);

    expect(envelope).toMatchObject({
      status: "warn",
      result: { status: "warn", survey: { receipt: { commandKind: "SurveyResource", accepted: false, reasonCode: "scanner_jammed" } } },
      receipts: [{ commandKind: "SurveyResource", accepted: false }],
    });
  });
  it("dispatches surveyAndSample through receipt-backed survey, sampling, and stop transitions", async () => {
    let commandId = 0;
    let inventoryQueries = 0;
    const driver = {
      envelopes: [],
      sent: [],
      send(frame) {
        this.sent.push(frame);
        if (frame.op === "query") {
          if (frame.verb.startsWith("/where")) {
            this.envelopes.push({ type: "query", line: frame.verb, verb: "where", data: { areaId: "desert", x: 10, y: 10, facing: "right" } });
          } else if (frame.verb.startsWith("/inv iron")) {
            const totalAvailable = inventoryQueries++ === 0 ? 0 : 1;
            this.envelopes.push({ type: "query", line: frame.verb, verb: "inv", data: { totalAvailable, rows: [{ itemId: 7100, available: totalAvailable }] } });
          }
          return;
        }
        commandId += 1;
        const commandKind = frame.line.startsWith("/survey") || frame.line.startsWith("/sample") ? "SampleResource" : "SetMoveIntent";
        if (frame.line.startsWith("/survey")) {
          this.envelopes.push({ type: "event", event: "authority_queued", line: frame.line, data: { commandId, commandKind: "SurveyResource" } });
          this.envelopes.push({ type: "receipt", commandId, commandKind: "SurveyResource", accepted: true, tick: commandId });
          this.envelopes.push({ type: "event", event: "survey_result", data: { payload: { family: "metal", spawnId: "open-desert-overworld:iron", areaId: "desert", centerX: 10, centerY: 10, rangeCells: 0, stepCells: 1, cols: 1, rows: 1, concentrationMilli: [100] } } });
          return;
        }
        this.envelopes.push({ type: "event", event: "authority_queued", line: frame.line, data: { commandId, commandKind } });
        this.envelopes.push({ type: "receipt", commandId, commandKind, accepted: true, tick: commandId });
      },
    };
    const context = createMockScenarioContext("alpha", "alpha-id", { driver });

    const envelope = await dispatchScenarioAction({ name: "surveyAndSample", args: { family: "iron", units: 1, standAfter: false, pollMs: 1 } }, context);

    expect(envelope).toMatchObject({
      status: "pass",
      receipts: [
        { commandKind: "SurveyResource", accepted: true },
        { commandKind: "SetMoveIntent", accepted: true },
        { commandKind: "SampleResource", accepted: true },
        { commandKind: "SampleResource", accepted: true },
      ],
      result: { surveyed: { best: { x: 10, y: 10 } }, movement: { status: "pass" }, gathering: { gained: 1, after: { totalAvailable: 1 } }, stopped: { receipt: { commandKind: "SampleResource", accepted: true } } },
    });
    expect(driver.sent.filter((frame) => frame.op === "verb").map((frame) => frame.line)).toEqual(["/survey iron", "/set-move-intent 0 0 Right", "/sample iron", "/sample iron true"]);
  });

  it("dispatches the canonical slugthrower catalog invariant and rejects a duplicate item mapping", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "successor-catalog-"));
    const authorityPath = join(repoRoot, "crates/successor-sim/src");
    const serverPath = join(repoRoot, "server/src/game");
    try {
      await Promise.all([mkdir(authorityPath, { recursive: true }), mkdir(join(authorityPath, "authority"), { recursive: true }), mkdir(serverPath, { recursive: true })]);
      await Promise.all([
        writeFile(join(authorityPath, "authority.rs"), "const CRAFTED_SLUGTHROWER_ITEM_ID: u32 = 3_101;\n"),
        writeFile(join(authorityPath, "authority/crafting.rs"), "CraftRecipeDefinition { id: \"slugthrower\", output_item_id: CRAFTED_SLUGTHROWER_ITEM_ID, }\n"),
        writeFile(join(serverPath, "weapons.ts"), "slugthrower: { id: \"slugthrower\", }\n"),
        writeFile(join(serverPath, "shard.ts"), "case 3101: return \"slugthrower\";\n"),
      ]);

      const context = createMockScenarioContext("alpha", "alpha-id");
      const passed = await dispatchScenarioAction({ name: "assertCanonicalSlugthrowerCatalog", args: { repoRoot } }, context);
      expect(passed).toMatchObject({
        status: "pass",
        result: {
          recipe: { id: "slugthrower", outputItemId: 3101, count: 1 },
          weaponProfile: { code: "slugthrower", id: "slugthrower", count: 1 },
          weaponItemMapping: { itemId: 3101, code: "slugthrower", count: 1 },
        },
      });

      await writeFile(join(serverPath, "shard.ts"), "case 3101: return \"slugthrower\";\ncase 3101: return \"slugthrower\";\n");
      await expect(dispatchScenarioAction({ name: "assertCanonicalSlugthrowerCatalog", args: { repoRoot } }, context))
        .rejects.toThrow(/canonical slugthrower catalog invariant failed/);
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  it("registers every production action used by play-flow scenarios", () => {
    const productionActions = [
      "attackUntilCloneEligible",
      "attackUntilDowned",
      "bankDepositCredits",
      "bankRetrieveItem",
      "bankStoreItem",
      "bankWithdrawCredits",
      "claimParcel",
      "cloneSaveSkillBackup",
      "craftAssignSlot",
      "craftClearSlot",
      "craftDraftSchematic",
      "craftRecipe",
      "expectCraftRejected",
      "harvestCorpse",
      "moveTo",
      "placeFarmStructure",
      "plantSeed",
      "recoverPlayerCorpse",
      "removeFarmStructure",
      "setCareerGoal",
      "spliceAssignSlot",
      "spliceBegin",
      "spliceCancel",
      "spliceClearSlot",
      "surveyAndSample",
      "tillTile",
      "trainSkill",
      "waterTile",
    ];
    expect(productionActions).toHaveLength(28);
    for (const name of productionActions) {
      expect(scenarioActionNames).toContain(name);
      expect(getScenarioAction(name)).toEqual(expect.any(Function));
    }
  });

  it("captures a craft line_id experiment receipt and assembled state through dispatch", async () => {
    let commandId = 0;
    const driver = {
      envelopes: [],
      sent: [],
      send(frame) {
        this.sent.push(frame);
        if (frame.op !== "verb") return;
        commandId += 1;
        const commandKind = frame.line.startsWith("/craft-begin")
          ? "CraftBegin"
          : frame.line === "/craft-assemble"
            ? "CraftAssemble"
            : frame.line.startsWith("/craft-experiment")
              ? "CraftExperiment"
              : "CraftFinalizePrototype";
        this.envelopes.push({ type: "event", event: "authority_queued", line: frame.line, data: { commandId, commandKind } });
        this.envelopes.push({ type: "receipt", commandId, commandKind, accepted: true, tick: commandId });
        if (commandKind === "CraftBegin") {
          this.envelopes.push({ type: "event", event: "craft_session", data: { payload: { phase: "slots", recipeId: "iron-plate" } } });
        } else if (commandKind === "CraftAssemble" || commandKind === "CraftExperiment") {
          this.envelopes.push({
            type: "event",
            event: "craft_session",
            data: { payload: { phase: "assembled", recipeId: "iron-plate", assembled: { lines: [{ lineId: 4, name: "quality" }] } } },
          });
        } else {
          this.envelopes.push({ type: "event", event: "craft_session", data: { payload: { phase: "browse" } } });
        }
      },
    };
    const context = createMockScenarioContext("alpha", "alpha-id", { driver });
    const result = await dispatchScenarioAction({
      name: "craftRecipe",
      actor: "alpha",
      args: { recipeId: "iron-plate", experiments: [{ line_id: 4, points: 7 }], settleTicks: 0 },
    }, context);

    expect(result).toMatchObject({
      status: "pass",
      receipts: [
        { commandKind: "CraftBegin", accepted: true },
        { commandKind: "CraftAssemble", accepted: true },
        { commandKind: "CraftExperiment", accepted: true },
        { commandKind: "CraftFinalizePrototype", accepted: true },
      ],
      result: { experiments: [{ line_id: 4, points: 7 }] },
    });
    expect(driver.sent.map((frame) => frame.line)).toContain("/craft-experiment line_id=4 points=7");
  });

  it("selects the richest real survey cell before an actor-bound survey action returns", async () => {
    const context = createMockScenarioContext("alpha", "alpha-id", {
      commandKindMap: { survey: "SurveyResource" },
      onVerb: (driver, line) => {
        if (!line.startsWith("/survey")) return;
        driver.envelopes.push({
          type: "event",
          event: "survey_result",
          data: {
            payload: {
              family: "iron",
              areaId: "desert",
              centerX: 100,
              centerY: 200,
              rangeCells: 4,
              stepCells: 2,
              cols: 5,
              rows: 5,
              concentrationMilli: [10, 20, 30, 40, 50, 60, 70, 80, 900, 100],
            },
          },
        });
      },
    });
    const result = await dispatchScenarioAction({
      name: "surveyBest",
      actor: "alpha",
      args: { family: "iron", move: false },
    }, context);

    expect(result).toMatchObject({
      actor: "alpha",
      status: "pass",
      result: { best: { x: 102, y: 198, concentrationMilli: 900, index: 8 } },
    });
  });

  it("dispatches plantSeed through the exported primitive and proves the exact planted tile", async () => {
    const parcelId = "parcel:ashvat:1";
    const seed = { itemId: 6001, variantId: 1, species: "ashgrain" };
    let planted = false;
    const context = createMockScenarioContext("alpha", "alpha-id", {
      commandKindMap: { "plant-seed": "PlantSeed" },
      onVerb: (_driver, line) => {
        if (line.startsWith("/plant-seed")) planted = true;
      },
      oracle: async () => ({
        tick: 260661,
        inventory: [{
          container: "alpha-id:field-pack",
          stackId: "7",
          itemId: 6001,
          variantId: 1,
          species: "ashgrain",
          available: planted ? 1 : 2,
        }],
        farmPlots: [{
          parcelId,
          tiles: [{
            cellX: 804,
            cellY: 808,
            tilled: true,
            moisturePct: 0,
            crop: planted
              ? { seedItemId: 6001, seedVariantId: 1, species: "ashgrain" }
              : null,
          }],
        }],
      }),
    });

    const result = await dispatchScenarioAction({
      name: "plantSeed",
      actor: "alpha",
      args: {
        parcelId,
        cell: { x: 804, y: 808 },
        seed,
        maxPolls: 1,
        maxTicks: 1,
      },
    }, context);

    expect(result).toMatchObject({
      status: "pass",
      result: {
        command: { receipt: { commandKind: "PlantSeed", accepted: true } },
        tile: {
          cellX: 804,
          cellY: 808,
          crop: { seedItemId: 6001, seedVariantId: 1, species: "ashgrain" },
        },
      },
    });
    expect(context.driver.sent.map((frame) => frame.line)).toContain(
      "/plant-seed parcel_id=parcel:ashvat:1 cell_x=804 cell_y=808 container=alpha-id:field-pack stack_id=7 variant_id=1",
    );
  });

});
