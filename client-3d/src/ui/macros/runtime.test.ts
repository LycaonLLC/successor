import { afterEach, describe, expect, it } from "vitest";

import { createPlayState, type PlayState, type SliceSnapshot } from "@successor/client/src/slice-core/gameState";
import type { VerbExecutionResult, VerbRegistry, VerbRegistryEntry } from "@successor/client/src/slice-core/verbRegistry/index";
import { createMacroRuntime, reasonCopy, type MacroRuntime } from "./runtime";
import { configureMacroStore, resetMacroStoreForTest } from "./store";

function sliceFixture(): SliceSnapshot {
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
    actors: [{
      id: "player",
      entity: "actor:player",
      areaId: "a",
      label: "Field Observer",
      role: "player",
      sprite: "adventurer-premium-male",
      poseSet: "idle",
      direction: "right",
      cell: { x: 1, y: 2 },
      route: [],
    }],
    props: [],
    blockedCells: [],
    transitions: [],
    cloneFacilities: [],
    inventory: [],
    reservations: [],
    events: [],
  };
}

interface RecordedInvocation {
  verb: string;
  args: readonly string[];
}

/** Minimal SP1-shaped registry: one authority verb + one query verb. */
function fakeRegistry(record: RecordedInvocation[], nextCommandId: () => number): VerbRegistry {
  const entryFor = (verb: string, cls: "authority" | "query"): VerbRegistryEntry => ({
    class: cls,
    kind: cls,
    verb,
    aliases: [],
    argSchema: [],
    ...(cls === "authority" ? { commandKind: "SampleResource" } : {}),
    execute: (args): VerbExecutionResult => {
      record.push({ verb, args });
      if (cls === "authority") {
        const commandId = nextCommandId();
        return {
          schema: "successor.verb-result.v1",
          verb,
          class: "authority",
          text: `${verb.toUpperCase()} QUEUED`,
          data: { commandKind: "SampleResource", queued: true, commandId, issuedAtTick: 10 },
        };
      }
      return {
        schema: "successor.verb-result.v1",
        verb,
        class: "query",
        text: "WHERE a 1,2",
        data: { query: verb, areaId: "a" },
      };
    },
  });
  const entries: Record<string, VerbRegistryEntry> = {
    sample: entryFor("sample", "authority"),
    where: entryFor("where", "query"),
  };
  return {
    entries: () => Object.values(entries),
    authorityEntries: () => [entries.sample!],
    localEntries: () => [],
    queryEntries: () => [entries.where!],
    resolve: (verb) => entries[verb] ?? null,
    resolveCommandKind: () => null,
    executeLine: () => null,
  };
}

interface Rig {
  state: PlayState;
  runtime: MacroRuntime;
  record: RecordedInvocation[];
  /** Advance the authoritative clock and pump the runtime once. */
  step(tick: number): void;
  pushReceipt(receipt: { commandId: number; accepted: boolean; reasonCode?: string }): void;
}

function rig(seedMacros: { id: string; name: string; body: string }[]): Rig {
  const slice = sliceFixture();
  const state = createPlayState(slice);
  configureMacroStore({
    apiBase: "http://127.0.0.1:9",
    characterId: "char_test",
    seed: {
      version: 1,
      items: seedMacros.map((macro) => ({ ...macro, iconId: "macro:command", createdAt: "", updatedAt: "" })),
    },
  });
  const record: RecordedInvocation[] = [];
  let commandSeq = 40;
  const runtime = createMacroRuntime({ state, slice, registry: fakeRegistry(record, () => ++commandSeq) });
  return {
    state,
    runtime,
    record,
    step(tick: number): void {
      state.serverAuthority.snapshotTick = tick;
      state.serverAuthority.lastSnapshotReceivedAtMs = state.worldTimeMs;
      runtime.update();
    },
    pushReceipt(receipt): void {
      state.serverAuthority.receiptLog.push({ ...receipt, tick: state.serverAuthority.snapshotTick, receivedAtMs: 1 });
    },
  };
}

afterEach(() => {
  resetMacroStoreForTest();
});

describe("macro runtime chat-line parity (/macro, /dump)", () => {
  it("runs a saved macro by name and reports the run slot", () => {
    const r = rig([{ id: "scan", name: "Scan", body: "/where\n/pause 5" }]);
    expect(r.runtime.handleSlashLine("/macro run Scan")).toBe("MACRO RUNNING — SCAN (SLOT 1/4)");
    r.step(20);
    expect(r.record).toEqual([{ verb: "where", args: [] }]);
    expect(r.runtime.runs()[0]).toMatchObject({ name: "Scan", status: "paused" });
  });

  it("supports bare /macro <name>, stop, list, and /dump; other lines pass through", () => {
    const r = rig([{ id: "scan", name: "Scan", body: "/pause 30" }]);
    expect(r.runtime.handleSlashLine("/survey iron")).toBeNull();
    expect(r.runtime.handleSlashLine("hello")).toBeNull();
    expect(r.runtime.handleSlashLine("/macro list")).toBe("MACROS 1/64 — Scan · STARTER 8");
    expect(r.runtime.handleSlashLine("/macro Scan")).toContain("MACRO RUNNING — SCAN");
    r.step(12);
    expect(r.runtime.handleSlashLine("/macro list")).toContain("RUNNING Scan");
    expect(r.runtime.handleSlashLine("/macro stop Scan")).toBe("MACRO STOPPED — 1 RUN");
    expect(r.runtime.handleSlashLine("/macro stop Scan")).toBe("MACRO DENIED — SCAN NOT RUNNING");
    r.runtime.handleSlashLine("/macro Scan");
    expect(r.runtime.handleSlashLine("/dump")).toBe("MACROS DUMPED — 1 RUN STOPPED");
    expect(r.runtime.runs()).toHaveLength(0);
  });

  it("denies unknown macros with the engine reason code", () => {
    const r = rig([]);
    expect(r.runtime.handleSlashLine("/macro run ghost")).toBe("MACRO DENIED — NOT FOUND");
  });

  it("resolves starter-pack macros by name when no character macro shadows them", () => {
    const r = rig([]);
    expect(r.runtime.handleSlashLine("/macro run field-report")).toContain("MACRO RUNNING — FIELD-REPORT");
    r.step(20);
    expect(r.record[0]).toEqual({ verb: "where", args: [] });
  });

  it("prefers a character macro over a starter with the same name", () => {
    const r = rig([{ id: "fr", name: "field-report", body: "/where\n/pause 30" }]);
    expect(r.runtime.handleSlashLine("/macro run field-report")).toContain("MACRO RUNNING — FIELD-REPORT");
    r.step(20);
    // The starter body would issue /vitals next; the character body pauses.
    expect(r.record).toEqual([{ verb: "where", args: [] }]);
    expect(r.runtime.runs()[0]).toMatchObject({ name: "field-report", status: "paused" });
  });
});

describe("macro runtime receipt pump + notices", () => {
  it("resolves /waitreceipt from the live receipt log and halts on reject", () => {
    const r = rig([{ id: "grind", name: "Grind", body: "/sample metal\n/waitreceipt\n/where" }]);
    expect(r.runtime.start("Grind").ok).toBe(true);
    r.step(20);
    // Authority verb executed; run is now blocked on its receipt.
    expect(r.record).toEqual([{ verb: "sample", args: ["metal"] }]);
    expect(r.runtime.runs()[0]).toMatchObject({ status: "waiting_receipt" });

    r.pushReceipt({ commandId: 41, accepted: false, reasonCode: "sample_cooldown" });
    r.step(21);
    // Default /onreject halt: the run dies carrying the server's reason.
    expect(r.runtime.runs()).toHaveLength(0);
    const notices = r.runtime.drainNotices();
    expect(notices).toEqual([{ kind: "halted", name: "Grind", runId: "macro:1", reasonCode: "sample_cooldown" }]);
    expect(r.runtime.drainNotices()).toEqual([]);
    // The query after /waitreceipt never ran.
    expect(r.record).toHaveLength(1);
  });

  it("continues past accepted receipts and completes with a notice", () => {
    const r = rig([{ id: "grind", name: "Grind", body: "/sample metal\n/waitreceipt\n/where" }]);
    r.runtime.start("Grind");
    r.step(20);
    r.pushReceipt({ commandId: 41, accepted: true });
    r.step(21);
    expect(r.record.map((entry) => entry.verb)).toEqual(["sample", "where"]);
    expect(r.runtime.drainNotices()).toEqual([{ kind: "completed", name: "Grind", runId: "macro:1", reasonCode: null }]);
  });

  it("pumps only NEW receipts across log trims (identity cursor)", () => {
    const r = rig([{ id: "grind", name: "Grind", body: "/sample metal\n/waitreceipt timeout=60\n/where" }]);
    // Pre-fill unrelated receipts so the ring is mid-life before the run.
    for (let index = 0; index < 130; index += 1) {
      r.pushReceipt({ commandId: 1000 + index, accepted: true });
    }
    r.step(20);
    r.runtime.start("Grind");
    r.step(21);
    expect(r.runtime.runs()[0]).toMatchObject({ status: "waiting_receipt" });
    // 130 more receipts flow — the 128-cap ring fully rotates, then ours lands.
    for (let index = 0; index < 130; index += 1) {
      r.pushReceipt({ commandId: 2000 + index, accepted: true });
      if (index % 40 === 0) r.step(22);
    }
    r.pushReceipt({ commandId: 41, accepted: true });
    r.step(30);
    expect(r.record.map((entry) => entry.verb)).toEqual(["sample", "where"]);
  });
});

describe("reason copy", () => {
  it("formats engine reason codes for the deny voice", () => {
    expect(reasonCopy("macro_run_slots_exhausted")).toBe("RUN SLOTS EXHAUSTED");
    expect(reasonCopy("sample_cooldown")).toBe("SAMPLE COOLDOWN");
    expect(reasonCopy(null)).toBe("UNSPECIFIED");
  });
});
