import { describe, expect, it } from "vitest";

import { createMacroEngine } from "./engine";
import type { MacroCommandReceipt, MacroEngine, MacroValue, MacroVerbDefinition, MacroVerbInvocation, MacroVerbRegistry } from "./types";
import type { VerbRegistry } from "../verbRegistry";

interface InvocationRecord {
  readonly verb: string;
  readonly macroName: string;
  readonly tick: number;
  readonly depth: number;
  readonly positional: readonly MacroValue[];
  readonly named: Readonly<Record<string, MacroValue>>;
  readonly receiptToken?: string;
}

function mockRegistry(records: InvocationRecord[], options: {
  readonly rejectVerb?: string;
  readonly queryActionAtTick?: number;
} = {}): MacroVerbRegistry {
  let receiptSequence = 0;
  const authorityVerb = (verb: string): MacroVerbDefinition => ({
    verb,
    kind: "authority",
    execute(invocation: MacroVerbInvocation) {
      receiptSequence += 1;
      const receiptToken = `${verb}:${receiptSequence}`;
      records.push(recordInvocation(invocation, receiptToken));
      if (options.rejectVerb === verb) return { accepted: false, reasonCode: `${verb}_rejected` };
      return { accepted: true, receipt: { token: receiptToken, kind: verb } };
    },
  });
  const localVerb = (verb: string): MacroVerbDefinition => ({
    verb,
    kind: "local",
    execute(invocation: MacroVerbInvocation) {
      records.push(recordInvocation(invocation));
      return { accepted: true };
    },
  });
  const definitions: Record<string, MacroVerbDefinition> = {
    attack: authorityVerb("attack"),
    sample: authorityVerb("sample"),
    emote: localVerb("emote"),
    vitals: {
      verb: "vitals",
      kind: "query",
      query(invocation: MacroVerbInvocation) {
        records.push(recordInvocation(invocation));
        return { action: invocation.tick >= (options.queryActionAtTick ?? 0) ? 50 : 40 };
      },
    },
  };
  return {
    resolve(verb: string): MacroVerbDefinition | null {
      return definitions[verb] ?? null;
    },
  };
}

function recordInvocation(invocation: MacroVerbInvocation, receiptToken?: string): InvocationRecord {
  return {
    verb: invocation.verb,
    macroName: invocation.macroName,
    tick: invocation.tick,
    depth: invocation.depth,
    positional: [...invocation.positional],
    named: { ...invocation.named },
    receiptToken,
  };
}

function engineWith(records: InvocationRecord[], body: string, options: Parameters<typeof mockRegistry>[1] & { readonly caps?: Parameters<typeof createMacroEngine>[0]["caps"]; readonly variables?: Record<string, MacroValue> } = {}): MacroEngine {
  const engine = createMacroEngine({
    registry: mockRegistry(records, options),
    caps: options.caps,
    variables: { target: "rogue-01", ...(options.variables ?? {}) },
  });
  const started = engine.startMacro({ name: "root", body });
  expect(started).toMatchObject({ ok: true });
  return engine;
}

describe("macroEngine scheduler", () => {
  it("emits a deterministic invocation sequence for the same tick sequence", () => {
    const body = "/attack $target action=basic_shot; /pause 0.1; /sample family=metal";
    const run = () => {
      const records: InvocationRecord[] = [];
      const engine = engineWith(records, body, { caps: { tickRateHz: 10 } });
      engine.tick(1);
      engine.tick(2);
      engine.tick(3);
      return records;
    };

    expect(run()).toEqual(run());
    expect(run().map((record) => [record.verb, record.tick, record.positional, record.named])).toEqual([
      ["attack", 1, ["rogue-01"], { action: "basic_shot" }],
      ["sample", 2, [], { family: "metal" }],
    ]);
  });

  it("enforces run slots and macro byte-size caps", () => {
    const records: InvocationRecord[] = [];
    const engine = createMacroEngine({ registry: mockRegistry(records), caps: { runSlots: 1, bodyBytes: 16 } });

    expect(engine.startMacro({ name: "large", body: "/sample metal with too much text" })).toEqual({ ok: false, reasonCode: "macro_body_too_large" });
    expect(engine.startMacro({ name: "one", body: "/pause 5" })).toEqual({ ok: true, runId: "macro:1" });
    expect(engine.startMacro({ name: "two", body: "/pause 5" })).toEqual({ ok: false, reasonCode: "macro_run_slots_exhausted" });
  });

  it("enforces macro chain depth without spawning parallel slots", () => {
    const records: InvocationRecord[] = [];
    const engine = createMacroEngine({
      registry: mockRegistry(records),
      caps: { recursionDepth: 2, chainDepth: 2 },
      macros: [{ name: "self", body: "/macro run self" }],
    });

    expect(engine.startMacro({ name: "self" })).toEqual({ ok: true, runId: "macro:1" });
    engine.tick(0);

    expect(engine.listRuns()).toEqual([]);
    expect(engine.getState().completedRuns.at(-1)).toMatchObject({ status: "halted", lastReasonCode: "macro_depth_exceeded" });
  });

  it("bounds forever-loop execution per tick instead of busy-spinning", () => {
    const records: InvocationRecord[] = [];
    const engine = engineWith(records, "/loop forever\n/sample ore\n/endloop", { caps: { loopIterationsPerTick: 2, statementsPerTick: 100 } });

    engine.tick(0);
    expect(records.map((record) => record.tick)).toEqual([0, 0]);
    expect(engine.listRuns()[0]).toMatchObject({ status: "yielded", wait: "yield:1" });

    engine.tick(1);
    expect(records.map((record) => record.tick)).toEqual([0, 0, 1, 1]);
  });

  it("times out /waitreceipt and follows /onreject goto with $last.reasonCode", () => {
    const records: InvocationRecord[] = [];
    const engine = engineWith(records, `
/onreject goto fail
/attack $target
/waitreceipt timeout=1
/sample ok
/goto done
fail:
/sample reason=$last.reasonCode
done:
`, { caps: { tickRateHz: 10 } });

    engine.tick(0);
    engine.tick(9);
    expect(records.map((record) => record.verb)).toEqual(["attack"]);

    engine.tick(10);
    expect(records.map((record) => [record.verb, record.tick, record.named])).toEqual([
      ["attack", 0, {}],
      ["sample", 10, { reason: "waitreceipt_timeout" }],
    ]);
    expect(engine.getState().completedRuns.at(-1)).toMatchObject({ status: "completed", lastReasonCode: "waitreceipt_timeout" });
  });

  it("continues after a rejected receipt and resolves $last.reasonCode plus $last.accepted", () => {
    const records: InvocationRecord[] = [];
    const engine = engineWith(records, `
/onreject continue
/attack $target
/waitreceipt timeout=5
/sample reason=$last.reasonCode accepted=$last.accepted
`, { caps: { tickRateHz: 10 } });

    engine.tick(0);
    const token = records[0]?.receiptToken;
    expect(token).toBe("attack:1");
    engine.ingestReceipt({ token, accepted: false, tick: 1, reasonCode: "out_of_range" } as MacroCommandReceipt);
    engine.tick(1);

    expect(records.map((record) => [record.verb, record.tick, record.named])).toEqual([
      ["attack", 0, {}],
      ["sample", 1, { reason: "out_of_range", accepted: false }],
    ]);
  });

  it("halts on immediate authority rejection under the default reject policy", () => {
    const records: InvocationRecord[] = [];
    const engine = engineWith(records, "/attack $target\n/sample metal", { rejectVerb: "attack" });

    engine.tick(0);

    expect(records.map((record) => record.verb)).toEqual(["attack"]);
    expect(engine.getState().completedRuns.at(-1)).toMatchObject({ status: "halted", lastReasonCode: "attack_rejected" });
  });

  it("polls /until query predicates on tick callbacks and emits after the predicate becomes true", () => {
    const records: InvocationRecord[] = [];
    const engine = engineWith(records, "/until vitals.action >= 50 timeout=1\n/sample done", { caps: { tickRateHz: 10 }, queryActionAtTick: 3 });

    engine.tick(0);
    engine.tick(1);
    engine.tick(2);
    expect(records.filter((record) => record.verb === "sample")).toHaveLength(0);

    engine.tick(3);
    expect(records.map((record) => [record.verb, record.tick])).toEqual([
      ["vitals", 0],
      ["vitals", 1],
      ["vitals", 2],
      ["vitals", 3],
      ["sample", 3],
    ]);
  });

  it("runs child macros synchronously in the same slot and resolves $1..$9 args", () => {
    const records: InvocationRecord[] = [];
    const engine = createMacroEngine({
      registry: mockRegistry(records),
      macros: [{ name: "child", body: "/sample $1" }],
    });

    expect(engine.startMacro({ name: "root", body: "/macro run child copper" })).toEqual({ ok: true, runId: "macro:1" });
    engine.tick(7);

    expect(records).toMatchObject([
      { verb: "sample", macroName: "child", depth: 2, tick: 7, positional: ["copper"] },
    ]);
    expect(engine.getState().completedRuns.at(-1)).toMatchObject({ status: "completed" });
  });

  it("accepts SP1 VerbRegistry entries directly and adapts their execution result", () => {
    const calls: Array<{ verb: string; args: readonly string[] }> = [];
    const verbRegistry: VerbRegistry = {
      entries: () => [],
      authorityEntries: () => [],
      localEntries: () => [],
      queryEntries: () => [],
      resolve(verb) {
        if (verb !== "sample") return null;
        return {
          class: "authority",
          verb: "sample",
          aliases: [],
          argSchema: [{ name: "family", type: "id-domain", required: true, domain: "resource_family" }],
          commandKind: "SampleResource",
          execute(args, invocation) {
            calls.push({ verb: invocation.invokedVerb, args });
            return {
              schema: "successor.verb-result.v1",
              verb: invocation.invokedVerb,
              class: "authority",
              text: "queued",
              data: { commandKind: "SampleResource", queued: true, commandId: 42, issuedAtTick: 7 },
            };
          },
        };
      },
      resolveCommandKind: () => null,
      executeLine: () => null,
    };
    const engine = createMacroEngine({ registry: verbRegistry });

    expect(engine.startMacro({ name: "root", body: "/sample family=metal" })).toEqual({ ok: true, runId: "macro:1" });
    engine.tick(4);

    expect(calls).toEqual([{ verb: "sample", args: ["family=metal"] }]);
    expect(engine.getState().completedRuns.at(-1)).toMatchObject({ status: "completed" });
  });

  it("exposes start/stop/list/state APIs for the future FE tab without DOM dependencies", () => {
    const records: InvocationRecord[] = [];
    const engine = createMacroEngine({
      registry: mockRegistry(records),
      macros: [{ name: "idle", iconId: "camp", body: "/pause 10" }],
    });

    expect(engine.listMacros()).toMatchObject([{ name: "idle", iconId: "camp" }]);
    expect(engine.startMacro({ name: "idle" })).toEqual({ ok: true, runId: "macro:1" });
    engine.tick(0);
    expect(engine.getState()).toMatchObject({ schema: "successor.macro-engine.state.v1", activeRuns: [{ name: "idle", status: "paused" }] });
    expect(engine.stopMacro("all")).toBe(1);
    expect(engine.getState().completedRuns.at(-1)).toMatchObject({ name: "idle", status: "stopped" });
  });
});
