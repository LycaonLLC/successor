import http from "node:http";
import { describe, expect, it } from "vitest";

import {
  durationBetweenClockSnapshots,
  failureRecord,
  evaluateOracleCondition,
  executeStep,
  parseDurationMs,
  parseScenarioStep,
  recordActionStepResult,
  scenarioMatrixLanes,
  runManualClockPoll,
  validateScenario,
  waitExtractorCollectable,
} from "./runner.mjs";
import { dispatchScenarioAction } from "./actions.mjs";
import { acceptGoldenDigestRegistry, evaluateGoldenAcceptance } from "./digest-registry.mjs";

describe("successor.scenario.v1 runner parsing", () => {
  it("parses macro-grammar actor lines and /pause lines", () => {
    expect(parseScenarioStep("alpha> /target nearest hostile")).toEqual({ send: { actor: "alpha", line: "/target nearest hostile" } });
    expect(parseScenarioStep("/pause 1.25s")).toEqual({ pauseMs: 1250 });
    expect(parseScenarioStep("pause 250ms")).toEqual({ pauseMs: 250 });
  });

  it("normalizes duration tokens", () => {
    expect(parseDurationMs("8s")).toBe(8000);
    expect(parseDurationMs("75ms")).toBe(75);
    expect(parseDurationMs(42)).toBe(42);
  });

  it("validates the JSON scenario contract", () => {
    const scenario = {
      schema: "successor.scenario.v1",
      name: "unit-contract",
      fixture: "open-desert-movement",
      actors: { alpha: { character: "fixture:ranger-01" } },
      steps: ["alpha> /where"],
    };
    expect(() => validateScenario(scenario, "unit")).not.toThrow();
    expect(() => validateScenario({ ...scenario, actors: {} }, "unit")).toThrow(/actor/u);
    expect(() => validateScenario({ ...scenario, schema: "wrong" }, "unit")).toThrow(/schema/u);
    expect(() => validateScenario({ ...scenario, steps: [] }, "unit")).toThrow(/steps/u);
  });

  it("requires an explicit reason before a scenario can schedule realtime work", () => {
    const scenario = {
      schema: "successor.scenario.v1",
      name: "realtime-contract",
      fixture: "open-desert-movement",
      actors: { alpha: { character: "fixture:ranger-01" } },
      steps: ["alpha> /where"],
    };

    expect(() => validateScenario({ ...scenario, lanes: ["accel", "realtime"], matrixLanes: ["accel", "realtime"] }, "unjustified-realtime"))
      .toThrow(/realtimeReason/u);
    expect(() => validateScenario({ ...scenario, lanes: ["accel"], matrixLanes: ["realtime"], realtimeReason: "golden digest parity" }, "matrix-outside-supported"))
      .toThrow(/matrixLanes.*not present/u);
    expect(() => validateScenario({ ...scenario, lanes: ["accel"], matrixLanes: ["accel", "accel"] }, "duplicate-matrix"))
      .toThrow(/matrixLanes.*duplicates/u);
  });

  it("keeps optional realtime certification out of the routine matrix while retaining parity members", () => {
    const scenario = {
      schema: "successor.scenario.v1",
      name: "organic-certification",
      fixture: "open-desert-movement",
      actors: { alpha: { character: "fixture:ranger-01" } },
      steps: ["alpha> /where"],
      lanes: ["accel", "realtime"],
      matrixLanes: ["accel"],
      realtimeReason: "one-time organic certification",
    };
    const parityScenario = {
      ...scenario,
      name: "movement-parity",
      matrixLanes: ["accel", "realtime"],
      realtimeReason: "golden digest parity",
    };

    expect(() => validateScenario(scenario, "organic-certification")).not.toThrow();
    expect(scenarioMatrixLanes(scenario)).toEqual(["accel"]);
    expect(scenarioMatrixLanes(parityScenario)).toEqual(["accel", "realtime"]);
  });

  it("validates bounded parallel branches and rejects nested or oversized work", () => {
    const base = {
      schema: "successor.scenario.v1",
      name: "parallel-contract",
      fixture: "open-desert-movement",
      actors: {
        alpha: { character: "fixture:ranger-01" },
        beta: { character: "fixture:ranger-02" },
      },
      steps: [{
        parallel: [
          { actor: "alpha", steps: ["alpha> /where"] },
          { actor: "beta", steps: ["beta> /where"] },
        ],
      }],
    };
    expect(() => validateScenario(base, "parallel")).not.toThrow();
    expect(() => validateScenario({ ...base, steps: [{ parallel: [{ actor: "alpha", steps: ["alpha> /where"] }] }] }, "parallel-small"))
      .toThrow(/at least two branches/u);
    expect(() => validateScenario({
      ...base,
      steps: [{ parallel: [
        { actor: "alpha", steps: [{ parallel: base.steps }] },
        { actor: "beta", steps: ["beta> /where"] },
      ] }],
    }, "parallel-nested")).toThrow(/nested parallel/u);
  });
});


describe("scenario runner cancellation and virtual duration", () => {
  it("waits for a blocked parallel branch to acknowledge cancellation before the step rejects", async () => {
    let cancellationAcknowledged = false;
    let blockedStartedResolve;
    const blockedStarted = new Promise((resolve) => { blockedStartedResolve = resolve; });
    const blockedSession = {
      envelopes: [], options: { actorId: "blocked" }, stderr: [], exit: null,
      waitFor(_predicate, _label, _timeoutMs, _startIndex, signal) {
        blockedStartedResolve();
        return new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            cancellationAcknowledged = true;
            reject(signal.reason);
          }, { once: true });
        });
      },
    };
    const failingSession = {
      envelopes: [], options: { actorId: "failing" }, stderr: [], exit: null,
      async waitFor() {
        await blockedStarted;
        throw new Error("deliberate branch failure");
      },
    };
    const context = {
      actors: { blocked: { id: "blocked" }, failing: { id: "failing" } },
      captures: {}, vars: {}, transcript: [], chatSessions: new Map(),
      scheduler: { clockMode: "system", currentTick: 0, tickRateHz: 30, commandGapTicks: 1, advancedTicks: 0 },
      lane: "realtime", sourceIdentity: { before: null },
    };
    const server = http.createServer((request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(request.url === "/game/debug/clock"
        ? { schema: "successor.debug-clock.v1", mode: "system", tick: 0, virtualNowMs: 0 }
        : { tick: 0, actors: {} }));
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;
    const runtime = {
      gameUrl: `http://127.0.0.1:${port}`,
      transport: {
        requests: { total: 0, clockSnapshot: 0, status: 0, clockAdvance: 0, oracle: 0, authorityCommand: 0, other: 0 },
        wallMs: { total: 0, clockSnapshot: 0, status: 0, clockAdvance: 0, oracle: 0, authorityCommand: 0, other: 0 },
        authorityBridge: { requests: 0, ticks: 0, batchedRequests: 0, maxTicksPerRequest: 0 },
      },
    };
    const pending = executeStep({
      parallel: [
        { actor: "blocked", steps: [{ await: { actor: "blocked", kind: "event", event: "never", timeoutMs: 10_000 } }] },
        { actor: "failing", steps: [{ await: { actor: "failing", kind: "event", event: "fail", timeoutMs: 10_000 } }] },
      ],
    }, context, new Map([["blocked", blockedSession], ["failing", failingSession]]), runtime);

    await expect(pending).rejects.toMatchObject({ name: "ScenarioAssertionError", details: { cancelled: true } });
    await new Promise((resolve) => server.close(resolve));
    expect(cancellationAcknowledged).toBe(true);
  });

  it("uses accumulated manual ticks when endpoint virtual time resets after restart", () => {
    expect(durationBetweenClockSnapshots(
      { virtualNowMs: 1_000 },
      { virtualNowMs: 100 },
      { advancedTicks: 45, tickRateHz: 30 },
    )).toBe(1_500);
    expect(durationBetweenClockSnapshots(
      { virtualNowMs: 1_000 },
      { virtualNowMs: 2_500 },
      { advancedTicks: 0, tickRateHz: 30 },
    )).toBe(1_500);
  });
});

function scenarioResult(lane, overrides = {}) {
  const sourceIdentity = {
    schema: "successor.source-identity.v1",
    sourceHash: "sha256:source-a",
    fileCount: 3,
    totalBytes: 128,
    provenance: "local",
  };
  return {
    scenario: "extractor-journey",
    lane,
    status: "pass",
    finalSnapshotDigest: "sha256:final-a",
    finalStateHash: "sha256:state-a",
    stateProbes: [{ afterStep: 3, tick: 18, stateHash: "sha256:state-a" }],
    sourceIdentity: { before: sourceIdentity, after: sourceIdentity },
    ...overrides,
  };
}

function actionContext({ accepted = true } = {}) {
  const transcript = [];
  const driver = {
    envelopes: [],
    send(frame) {
      const commandId = 41;
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
        ...(accepted ? {} : { reasonCode: "trainer_unavailable" }),
        tick: 29,
      });
    },
  };
  const context = {
    driver,
    gameUrl: "http://scenario.test",
    actor: { alias: "alpha", id: "alpha-id", actorId: "alpha-id" },
    actorId: "alpha-id",
    tickRateHz: 30,
    defaultTimeoutMs: 10,
    sleep: async () => undefined,
    advanceTicks: async () => 29,
    oracle: async () => ({ tick: 29 }),
    recordFrame(frame) {
      transcript.push(frame);
    },
    forActor() {
      return context;
    },
  };
  return { context, transcript };
}
function actionStepHarness({ captures = {}, vars = {}, queryData = {} } = {}) {
  const sent = [];
  const session = {
    envelopes: [],
    send(frame) {
      sent.push(frame);
      this.envelopes.push({
        type: "query",
        line: frame.verb,
        verb: String(frame.verb).replace(/^\//u, ""),
        data: queryData,
      });
    },
  };
  const context = {
    actors: { alpha: { id: "alpha-id" } },
    captures,
    vars,
    transcript: [],
    scheduler: { currentTick: 11, clockMode: "manual", tickRateHz: 30, commandGapTicks: 1 },
  };
  return {
    context,
    sessions: new Map([["alpha", session]]),
    runtime: { gameUrl: "http://scenario.test" },
    sent,
  };
}

describe("scenario runner extractor and transcript contracts", () => {
  it("waits for collectable units on the requested extractor instead of hopper percentage or another extractor", async () => {
    const observations = [
      {
        tick: 11,
        placedExtractors: [
          { extractorId: "extractor:other", collectableUnits: 9, hopperPct: 0 },
          { extractorId: "extractor:alpha:1", collectableUnits: 0, hopperPct: 100 },
        ],
      },
      {
        tick: 12,
        placedExtractors: [
          { extractorId: "extractor:other", collectableUnits: 9, hopperPct: 0 },
          { extractorId: "extractor:alpha:1", collectableUnits: 1, hopperPct: 0 },
        ],
      },
    ];
    const context = { vars: {}, captures: {}, transcript: [], scheduler: { currentTick: 11, clockMode: "manual", tickRateHz: 30, commandGapTicks: 1 } };
    let polls = 0;

    const extractor = await waitExtractorCollectable({
      extractorId: "extractor:alpha:1",
      target: 1,
      context,
      sessions: new Map(),
      runtime: null,
      timeoutMs: 100,
      actor: "alpha",
      fetchOracle: async () => observations.shift(),
      advancePoll: async () => { polls += 1; },
    });

    expect(polls).toBe(1);
    expect(extractor).toEqual({ extractorId: "extractor:alpha:1", collectableUnits: 1, hopperPct: 0, tick: 12 });
    expect(context.transcript).toHaveLength(1);
    expect(context.transcript[0]).toMatchObject({
      actor: "alpha",
      await: "extractorCollectableUnits",
      extractorId: "extractor:alpha:1",
      target: 1,
      recv: { extractorId: "extractor:alpha:1", collectableUnits: 1, tick: 12 },
    });
    expect(context.transcript[0].wallElapsedMs).toEqual(expect.any(Number));
    expect(context.transcript[0].wallElapsedMs).toBeGreaterThanOrEqual(0);
  });

  it("derives a 1200-tick manual-clock budget from the active restart's 40-second collectability timeout", async () => {
    const observations = [
      { tick: 1_104, placedExtractors: [{ extractorId: "extractor:player:1", collectableUnits: 0 }] },
      { tick: 1_105, placedExtractors: [{ extractorId: "extractor:player:1", collectableUnits: 1 }] },
    ];
    const context = {
      vars: {},
      captures: {},
      transcript: [],
      scheduler: { currentTick: 1_104, clockMode: "manual", tickRateHz: 30, commandGapTicks: 1 },
    };
    const pollStates = [];

    await waitExtractorCollectable({
      extractorId: "extractor:player:1",
      target: 1,
      context,
      sessions: new Map(),
      runtime: null,
      timeoutMs: 40_000,
      fetchOracle: async () => observations.shift(),
      advancePoll: async ({ pollState }) => { pollStates.push({ ...pollState }); },
    });

    expect(pollStates).toEqual([{ tickBudget: 1_200, advancedTicks: 0 }]);
  });

describe("manual-clock batched polling contracts", () => {
  it("observes every scheduled oracle boundary, records the first satisfying tick, and uses fewer advances than a one-tick baseline", async () => {
    const observations = [
      { tick: 40, ready: false, nextTick: 43 },
      { tick: 43, ready: false, nextTick: 47 },
      { tick: 47, ready: true, nextTick: 48 },
      { tick: 48, ready: true, nextTick: 49 },
    ];
    const calls = [];

    const outcome = await runManualClockPoll({
      observe: async () => {
        const observation = observations.shift();
        calls.push(`oracle:${observation.tick}`);
        return observation;
      },
      evaluate: (observation) => observation.ready ? observation.tick : false,
      advance: async (ticks, observation) => {
        calls.push(`advance:${observation.tick}+${ticks}`);
        return observation.tick + ticks;
      },
      nextAdvanceTicks: (observation) => observation.nextTick - observation.tick,
      tickBudget: 8,
      deadline: 1,
      now: () => 0,
      label: "extractor readiness",
    });

    expect(outcome).toMatchObject({
      observation: { tick: 47, ready: true },
      value: 47,
      pollState: { tickBudget: 8, advancedTicks: 7, polls: 3, advanceCalls: 2 },
    });
    expect(calls).toEqual([
      "oracle:40",
      "advance:40+3",
      "oracle:43",
      "advance:43+4",
      "oracle:47",
    ]);
    expect(outcome.pollState.advanceCalls).toBeLessThan(outcome.pollState.advancedTicks);
    expect(outcome.pollState.polls).toBeLessThan(outcome.pollState.advancedTicks);
    expect(observations).toEqual([{ tick: 48, ready: true, nextTick: 49 }]);
  });

  it("awaits an asynchronous virtual advance before the next oracle probe and preserves the receipt-to-probe boundary", async () => {
    const calls = [];
    let resolveAdvance;
    let receiptVisible = false;
    const advanceStarted = new Promise((resolve) => {
      resolveAdvance = () => {
        receiptVisible = true;
        calls.push("receipt:43");
        resolve();
      };
    });

    const pending = runManualClockPoll({
      observe: async () => {
        calls.push(`oracle:${receiptVisible ? 43 : 40}`);
        return { tick: receiptVisible ? 43 : 40, receiptVisible };
      },
      evaluate: (observation) => observation.receiptVisible ? observation.tick : false,
      advance: async (ticks, observation) => {
        calls.push(`advance:${observation.tick}+${ticks}`);
        await advanceStarted;
      },
      nextAdvanceTicks: () => 3,
      tickBudget: 3,
      deadline: 1,
      now: () => 0,
      label: "receipt before oracle capture",
    });

    await Promise.resolve();
    expect(calls).toEqual(["oracle:40", "advance:40+3"]);
    resolveAdvance();
    await expect(pending).resolves.toMatchObject({
      observation: { tick: 43, receiptVisible: true },
      value: 43,
      pollState: { advancedTicks: 3, polls: 2, advanceCalls: 1 },
    });
    expect(calls).toEqual(["oracle:40", "advance:40+3", "receipt:43", "oracle:43"]);
  });

  it("stops at the tick budget without an excess oracle or advance request", async () => {
    const calls = [];

    const pending = runManualClockPoll({
      observe: async () => {
        calls.push("oracle");
        return { ready: false };
      },
      evaluate: () => false,
      advance: async (ticks) => {
        calls.push(`advance:${ticks}`);
      },
      nextAdvanceTicks: () => 3,
      tickBudget: 5,
      deadline: 1,
      now: () => 0,
      label: "never-ready oracle",
    });

    await expect(pending).rejects.toMatchObject({
      name: "ScenarioAssertionError",
      message: "manual-clock tick budget exhausted while waiting for never-ready oracle",
      details: {
        tickBudget: 5,
        advancedTicks: 5,
        polls: 3,
        advanceCalls: 2,
        latest: { ready: false },
      },
    });
    expect(calls).toEqual(["oracle", "advance:3", "oracle", "advance:2", "oracle"]);
  });
});

  it("projects real dispatched action frames and receipt identity into a transcript-v2 step", async () => {
    const { context, transcript } = actionContext();
    const action = await dispatchScenarioAction({
      name: "trainSkill",
      args: { boxId: "marksman-novice", trainerId: "trainer-1", move: false, settleTicks: 0 },
    }, context);
    const step = recordActionStepResult({
      context: { transcript },
      stepRecord: { actor: "alpha", issuedAtTick: 17, expandedFrames: [], receipts: [] },
      actionResult: action,
      appendFrames: false,
    });

    expect(transcript).toEqual(action.expandedFrames);
    expect(step.expandedFrames).toEqual(action.expandedFrames);
    expect(step.receipt).toEqual({
      actor: "alpha",
      commandId: 41,
      commandKind: "PurchaseSkillBox",
      issuedAtTick: 17,
      accepted: true,
      reasonCode: null,
      tick: 29,
    });
  });
  it("resolves the Organic parcel capture path through nested action args without coercing tokens", async () => {
    const parcelId = "parcel:ashvat:804:808";
    const contract = {
      enabled: false,
      retries: 0,
      tiers: ["homestead", { name: "starter", limit: 2 }],
    };
    const { context, sessions, runtime, sent } = actionStepHarness({
      captures: {
        claimHome: { result: { parcel: { parcelId } } },
        fixture: { contract },
      },
      vars: { label: "organic" },
      queryData: {
        parcelId,
        contract,
        summary: `parcel=${parcelId} label=organic`,
      },
    });

    const result = await executeStep({
      action: {
        name: "assertQuery",
        args: {
          line: "/inspect $captures.claimHome.result.parcel.parcelId --label=$vars.label",
          expectation: [
            { path: "data.parcelId", value: "$captures.claimHome.result.parcel.parcelId" },
            {
              path: "data.contract",
              value: {
                enabled: "$captures.fixture.contract.enabled",
                retries: "$captures.fixture.contract.retries",
                tiers: [
                  "$captures.fixture.contract.tiers.0",
                  {
                    name: "$captures.fixture.contract.tiers.1.name",
                    limit: "$captures.fixture.contract.tiers.1.limit",
                  },
                ],
              },
            },
            { path: "data.summary", value: "parcel=$captures.claimHome.result.parcel.parcelId label=$vars.label" },
          ],
        },
      },
    }, context, sessions, runtime);

    expect(sent).toEqual([{ op: "query", verb: `/inspect ${parcelId} --label=organic` }]);
    expect(result.result.assertions).toEqual([
      { path: "data.parcelId", op: "eq", expected: parcelId, actual: parcelId },
      { path: "data.contract", op: "eq", expected: contract, actual: contract },
      { path: "data.summary", op: "eq", expected: `parcel=${parcelId} label=organic`, actual: `parcel=${parcelId} label=organic` },
    ]);
  });

  it("rejects a missing action capture before the action can send a driver frame", async () => {
    const { context, sessions, runtime, sent } = actionStepHarness();

    await expect(executeStep({
      action: {
        name: "query",
        args: { line: "/inspect $captures.claimHome.result.parcel.parcelId" },
      },
    }, context, sessions, runtime)).rejects.toMatchObject({
      name: "ScenarioAssertionError",
      message: "scenario action argument references missing value $captures.claimHome.result.parcel.parcelId",
    });

    expect(sent).toEqual([]);
    expect(context.transcript).toEqual([]);
  });

  it("emits stack-independent deterministic failure records for a real rejected action", async () => {
    const { context } = actionContext({ accepted: false });
    let actionFailure;
    try {
      await dispatchScenarioAction({
        name: "trainSkill",
        args: { boxId: "marksman-novice", trainerId: "trainer-1", move: false, settleTicks: 0 },
      }, context);
    } catch (error) {
      actionFailure = error;
    }

    const options = {
      step: 4,
      lane: "accel",
      sourceIdentity: { before: scenarioResult("accel").sourceIdentity.before },
    };
    const failure = failureRecord(actionFailure, options);

    expect(failure).toEqual(failureRecord(actionFailure, options));
    expect(failure).toMatchObject({
      schema: "successor.scenario-failure.v1",
      code: "SCENARIO_ACTION_DISPATCH_ERROR",
      step: 4,
      lane: "accel",
      sourceIdentity: { sourceHash: "sha256:source-a" },
    });
    expect(failure.message).toMatch(/receipt rejected.*trainer_unavailable/u);
    expect(failure).not.toHaveProperty("stack");
  });
});

describe("scenario runner oracle and command-stream guards", () => {
  it("selects a farm-tile oracle row by its exact parcel and cell before applying the match", () => {
    const oracle = {
      farmPlots: [
        {
          parcelId: "parcel:alpha",
          tiles: [
            { cellX: 12, cellY: 7, watered: true, crop: "ironroot" },
            { cellX: 13, cellY: 7, watered: false, crop: "ironroot" },
          ],
        },
        {
          parcelId: "parcel:beta",
          tiles: [{ cellX: 12, cellY: 7, watered: false, crop: "ironroot" }],
        },
      ],
    };
    const context = { vars: {}, captures: {} };
    const target = { type: "farmTile", parcelId: "parcel:alpha", cellX: 12, cellY: 7 };

    expect(evaluateOracleCondition(oracle, { ...target, match: { watered: false } }, context).ok).toBe(false);
    expect(evaluateOracleCondition(oracle, { ...target, match: { watered: true, crop: "ironroot" } }, context)).toEqual({
      ok: true,
      capture: { parcelId: "parcel:alpha", cellX: 12, cellY: 7, watered: true, crop: "ironroot" },
    });
  });

  it("rejects an admitted forbidden authority command while retaining a no-match transcript for safe commands", async () => {
    const safeSession = {
      envelopes: [
        { type: "event", event: "authority_queued", line: "/water-tile parcel:alpha 12 7", data: { commandId: 5, commandKind: "WaterTile", flushed: 1 } },
        { type: "receipt", commandId: 5, commandKind: "WaterTile", accepted: true, tick: 19 },
      ],
    };
    const safeContext = { transcript: [], vars: {}, captures: {} };
    const spec = { expect: { kind: "commandStreamNoMatch", match: { commandKind: { regex: "^Debug" } } } };

    await expect(executeStep(spec, safeContext, new Map([["alpha", safeSession]]), null)).resolves.toBe(1);
    expect(safeContext.transcript).toEqual([{
      expect: "commandStreamNoMatch",
      match: { commandKind: { regex: "^Debug" } },
      count: 1,
    }]);

    const debugSession = {
      envelopes: [
        { type: "event", event: "authority_queued", line: "/debug-give-item 1101", data: { commandId: 6, commandKind: "DebugGiveItem", flushed: 1 } },
        { type: "receipt", commandId: 6, commandKind: "DebugGiveItem", accepted: true, tick: 20 },
      ],
    };
    await expect(executeStep(spec, { transcript: [], vars: {}, captures: {} }, new Map([["alpha", debugSession]]), null))
      .rejects.toThrow(/forbidden command/u);
  });
});

describe("scenario golden acceptance", () => {
  it("updates a golden only after matching successful accel and realtime final state", () => {
    const registry = { schema: "successor.scenario-golden-digests.v1", scenarios: {} };
    const results = [scenarioResult("accel"), scenarioResult("realtime")];

    expect(evaluateGoldenAcceptance({ requestedLane: "all", results })).toEqual({ ok: true, reasons: [] });
    expect(acceptGoldenDigestRegistry(registry, results, "commit-a", "all")).toMatchObject({
      ok: true,
      registry: {
        scenarios: {
          "extractor-journey": {
            digest: "sha256:final-a",
            stateHash: "sha256:state-a",
            sourceIdentity: { sourceHash: "sha256:source-a" },
            lanes: ["accel", "realtime"],
          },
        },
      },
    });
  });

  it.each([
    ["a single requested lane", "accel", [scenarioResult("accel"), scenarioResult("realtime")], "LANE_ALL_REQUIRED"],
    ["missing realtime result", "all", [scenarioResult("accel")], "BOTH_LANES_REQUIRED"],
    ["failed realtime result", "all", [scenarioResult("accel"), scenarioResult("realtime", { status: "fail" })], "BOTH_LANES_MUST_PASS"],
    ["a changed source after accel", "all", [
      scenarioResult("accel", { sourceIdentity: { before: scenarioResult("accel").sourceIdentity.before, after: { ...scenarioResult("accel").sourceIdentity.before, sourceHash: "sha256:source-b" } } }),
      scenarioResult("realtime"),
    ], "SOURCE_IDENTITY_MISMATCH"],
    ["a final state hash mismatch", "all", [scenarioResult("accel"), scenarioResult("realtime", { finalStateHash: "sha256:state-b" })], "FINAL_STATE_HASH_MISMATCH"],
    ["a final snapshot digest mismatch", "all", [scenarioResult("accel"), scenarioResult("realtime", { finalSnapshotDigest: "sha256:final-b" })], "FINAL_DIGEST_MISMATCH"],
    ["a state probe mismatch", "all", [scenarioResult("accel"), scenarioResult("realtime", { stateProbes: [{ afterStep: 3, tick: 18, stateHash: "sha256:probe-b" }] })], "STATE_PROBE_MISMATCH"],
  ])("refuses to update goldens for %s", (_name, requestedLane, results, expectedReason) => {
    const outcome = acceptGoldenDigestRegistry(
      { schema: "successor.scenario-golden-digests.v1", scenarios: {} },
      results,
      "commit-a",
      requestedLane,
    );

    expect(outcome.ok).toBe(false);
    expect(outcome.registry).toBeNull();
    expect(outcome.reasons.map((reason) => reason.code)).toContain(expectedReason);
  });
});

function restartHarness({
  checkpointError = null,
  stopResult = { ok: true, finalState: "inactive", failures: [] },
  relaunchError = null,
  sourceHash = "fixture-source",
  reconnectError = null,
  pending = false,
} = {}) {
  const calls = [];
  const persistence = {
    checkpointPath: "/isolated/restart/checkpoint.json",
    journalPath: "/isolated/restart/journal.jsonl",
  };
  const context = {
    scenario: { persistence: true },
    captures: {},
    transcript: [],
    scheduler: { clockMode: "system", currentTick: 17, currentVirtualNowMs: 566.667, tickRateHz: 30, commandGapTicks: 1, advancedTicks: 0 },
  };
  const session = {
    envelopes: pending
      ? [{ type: "event", event: "authority_queued", line: "/move 10 12", data: { commandId: "pending-1", commandKind: "Move" } }]
      : [{ type: "status", status: "ready" }],
    async close() { calls.push("alpha:close"); },
    async start() {
      calls.push("alpha:start");
      if (reconnectError) throw reconnectError;
    },
    async waitFor(predicate, label, timeoutMs, startIndex) {
      calls.push(`alpha:ready:${label}:${timeoutMs}:${startIndex}`);
      const ready = { type: "status", status: "ready", data: { sourceStateHash: "fixture-source" } };
      if (!predicate(ready)) throw new Error("ready predicate rejected test fixture");
      return ready;
    },
  };
  const runtime = {
    handle: { name: "isolated-restart", pid: 701 },
    processHost: { kind: "child" },
    gameUrl: "http://127.0.0.1:28791",
    shardId: "restart-shard",
    fixture: { sourceStateHash: "fixture-source" },
    persistence,
    async inspect() { return { mainPid: this.handle.pid }; },
    async readOracle() {
      calls.push("oracle");
      return { schema: "successor.game-shard-oracle.v1", tick: 17, actors: {}, inventory: [], source: { stateHash: "fixture-source" } };
    },
    async checkpoint({ timeoutMs }) {
      calls.push(`checkpoint:${timeoutMs}`);
      if (checkpointError) throw checkpointError;
      return { checkpoint: { shardId: "restart-shard", tick: 17, stateHash: "checkpoint-hash" } };
    },
    async stop({ graceMs }) {
      calls.push(`stop:${graceMs}`);
      return stopResult;
    },
    async relaunch({ timeoutMs }) {
      calls.push(`relaunch:${timeoutMs}`);
      if (relaunchError) throw relaunchError;
      this.handle = { name: "isolated-restart", pid: 702 };
      return this;
    },
    async readStatus() {
      calls.push("status");
      return {
        shardId: "restart-shard",
        source: { stateHash: sourceHash },
        persistence: { enabled: true, checkpointPath: persistence.checkpointPath, journalPath: persistence.journalPath, restore: { loaded: true } },
      };
    },
  };
  return { context, runtime, sessions: new Map([["alpha", session]]), calls, persistence };
}

describe("scenario runner isolated restart seam", () => {
  const restartScenario = {
    schema: "successor.scenario.v1",
    name: "restart-contract",
    fixture: "open-desert-movement",
    actors: { alpha: { character: "fixture:ranger-01" } },
    steps: [{ restart: {} }],
  };

  it("requires persistence and a restart object before a scenario may restart a fixture", () => {
    expect(() => validateScenario(restartScenario, "restart-without-persistence")).toThrow(/persistence:true/u);
    expect(() => validateScenario({ ...restartScenario, persistence: true, steps: [{ restart: true }] }, "restart-not-object")).toThrow(/restart step must be an object/u);
    expect(() => validateScenario({ ...restartScenario, persistence: true }, "restart-persistent")).not.toThrow();
  });

  it("checkpoints, replaces the ProcessHost process, retains isolated persistence paths, reconnects actors, and records transcript-v2 evidence", async () => {
    const { context, runtime, sessions, calls, persistence } = restartHarness();

    const evidence = await executeStep({ restart: { as: "restartEvidence", timeoutMs: 4321 } }, context, sessions, runtime);

    expect(calls).toEqual([
      "oracle",
      "checkpoint:4321",
      "alpha:close",
      "stop:4321",
      "relaunch:4321",
      "status",
      "alpha:start",
      "alpha:ready:alpha source-validated authority hello:4321:1",
      "status",
      "oracle",
    ]);
    expect(evidence).toMatchObject({
      schema: "successor.scenario-restart-evidence.v1",
      shardId: "restart-shard",
      paths: persistence,
      oldProcess: { kind: "child", unit: "isolated-restart", mainPid: 701 },
      newProcess: { kind: "child", unit: "isolated-restart", mainPid: 702 },
      checkpoint: { checkpoint: { shardId: "restart-shard", tick: 17, stateHash: "checkpoint-hash" } },
      disconnects: [{ actor: "alpha", envelopeCount: 1, closed: true }],
      reconnects: [{ actor: "alpha", envelopeCount: 1, hello: { type: "status", status: "ready" } }],
    });
    expect(evidence.preAuthorityHash).toMatch(/^sha256:/u);
    expect(evidence.postAuthorityHash).toBe(evidence.preAuthorityHash);
    expect(context.captures.restartEvidence).toBe(evidence);
    expect(context.transcript).toEqual([{ restart: evidence }]);
  });

  it("refuses a restart while an admitted authority command lacks its receipt", async () => {
    const { context, runtime, sessions, calls } = restartHarness({ pending: true });

    await expect(executeStep({ restart: {} }, context, sessions, runtime)).rejects.toMatchObject({
      name: "ScenarioAssertionError",
      message: "restart pending command failed: authority receipts must settle before checkpoint",
      details: { pendingCommands: [{ actor: "alpha", commandId: "pending-1", commandKind: "Move", line: "/move 10 12" }] },
    });
    expect(calls).toEqual([]);
  });
  it.each([
    ["checkpoint", { checkpointError: new Error("barrier unavailable") }, /restart checkpoint failed: barrier unavailable/u, ["oracle", "checkpoint:12000"]],
    ["teardown", { stopResult: { ok: false, finalState: "surviving", failures: ["still alive"] } }, /restart teardown failed: ProcessHost reported surviving fixture process/u, ["oracle", "checkpoint:12000", "alpha:close", "stop:10000"]],
    ["relaunch", { relaunchError: new Error("bind denied") }, /restart relaunch failed: bind denied/u, ["oracle", "checkpoint:12000", "alpha:close", "stop:10000", "relaunch:12000"]],
    ["source validation", { sourceHash: "stale-source" }, /restart source validation failed: fixture source hash changed across restart/u, ["oracle", "checkpoint:12000", "alpha:close", "stop:10000", "relaunch:12000", "status"]],
    ["actor reconnect", { reconnectError: new Error("socket refused") }, /restart actor reconnect failed: alpha: socket refused/u, ["oracle", "checkpoint:12000", "alpha:close", "stop:10000", "relaunch:12000", "status", "alpha:start"]],
  ])("fails closed when %s cannot complete", async (_label, options, expected, callsBeforeFailure) => {
    const { context, runtime, sessions, calls } = restartHarness(options);

    await expect(executeStep({ restart: {} }, context, sessions, runtime)).rejects.toThrow(expected);
    expect(calls).toEqual(callsBeforeFailure);
  });
  function reconnectWithCommandId(postCommandId) {
    const harness = restartHarness();
    const session = harness.sessions.get("alpha");
    session.envelopes = [
      { type: "event", event: "authority_queued", line: "/kneel", data: { commandId: 47, commandKind: "SetPosture" } },
      { type: "receipt", commandId: 47, commandKind: "SetPosture", accepted: true, tick: 17 },
    ];
    session.reconnect = async (gameUrl, commandIdFloor) => {
      harness.calls.push(`alpha:reconnect:${gameUrl}:${commandIdFloor}`);
    };
    session.send = ({ line }) => {
      session.envelopes.push({ type: "event", event: "authority_queued", line, data: { commandId: postCommandId, commandKind: "SetPosture" } });
      session.envelopes.push({ type: "receipt", commandId: postCommandId, commandKind: "SetPosture", accepted: true, tick: 18 });
    };
    session.waitFor = async (predicate, _label, _timeoutMs, startIndex = 0) => {
      const existing = session.envelopes.slice(startIndex).find(predicate);
      if (existing) return existing;
      const ready = { type: "status", status: "ready" };
      if (predicate(ready)) {
        session.envelopes.push(ready);
        return ready;
      }
      throw new Error("test driver did not emit the requested frame");
    };
    return { ...harness, session };
  }

  it("continues command IDs above the settled pre-checkpoint authority command and records the accepted post-restart receipt", async () => {
    const { context, runtime, sessions, session } = reconnectWithCommandId(48);

    const evidence = await executeStep({ restart: {} }, context, sessions, runtime);
    const command = await executeStep({ send: { actor: "alpha", line: "/kneel", alignTick: false } }, context, sessions, runtime);

    expect(evidence.reconnects).toMatchObject([{ actor: "alpha", commandIdFloor: 48 }]);
    expect(command.data.commandId).toBe(48);
    expect(context.restartCommandFloors).toEqual({});
    expect(context.transcript).toContainEqual({
      actor: "alpha",
      restartCommandContinuity: {
        commandIdFloor: 48,
        receipt: expect.objectContaining({ commandId: 48, accepted: true }),
      },
    });
    expect(session.envelopes.filter((entry) => entry.type === "receipt").map((entry) => entry.commandId)).toEqual([47, 48]);
  });

  it("fails closed when a reconnected driver resets its next command ID instead of continuing above the persisted floor", async () => {
    const { context, runtime, sessions } = reconnectWithCommandId(1);

    await executeStep({ restart: {} }, context, sessions, runtime);
    await expect(executeStep({ send: { actor: "alpha", line: "/kneel", alignTick: false } }, context, sessions, runtime)).rejects.toMatchObject({
      name: "ScenarioAssertionError",
      message: "restart command continuity failed: reconnected driver reused a persisted command ID",
      details: { actor: "alpha", commandId: 1, commandIdFloor: 48 },
    });
  });
});
