import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import {
  VERIFY_SELECTION_SCHEMA,
  diffSourceManifests,
  selectVerificationTasks,
} from "./select.mjs";
import { VERIFY_FULL_PLAN_SCHEMA, buildFullVerificationPlan } from "./verify-full.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..", "..");
const HASH = {
  baseline: "a".repeat(64),
  current: "b".repeat(64),
  entryA: "c".repeat(64),
  entryB: "d".repeat(64),
  entryC: "e".repeat(64),
  entryD: "f".repeat(64),
};
const STATIC_TASK_IDS = [
  "static:commands",
  "static:coverage",
  "static:denylist",
  "static:successor-context",
  "static:deploy-contract",
  "static:fixture",
  "static:wardrobe",
  "static:zero-gpu",
];

function manifest(entries, sourceHash) {
  return {
    schema: "successor.source-manifest.v1",
    sourceHash,
    fileCount: entries.length,
    totalBytes: entries.reduce((total, entry) => total + entry.size, 0),
    entries,
  };
}

function entry(sourcePath, contentSha256, { size = 1, type = "file", executable = false, symlinkTarget } = {}) {
  return {
    path: sourcePath,
    type,
    executable,
    size,
    contentSha256,
    ...(type === "symlink" ? { symlinkTarget } : {}),
  };
}

function task(id, lane, shard, overrides = {}) {
  return { id, lane, shard, required: true, ...overrides };
}

function tasks() {
  return [
    ...STATIC_TASK_IDS.map((id) => task(id, "static", `tools/${id}.mjs`, { tier: "G0", phase: 0 })),
    task("node:server", "node", "server"),
    task("node:client", "node", "client"),
    task("node:client-3d", "node", "client-3d"),
    task("node:client-tui", "node", "client-tui"),
    task("rust:successor-sim", "rust", "crates/successor-sim"),
    task("rust:successor-slice", "rust", "crates/successor-slice"),
    task("accel:movement-smoke", "accel", "tools/verification/scenario/scenarios/movement-smoke.scenario.json"),
    task("accel:craft-smoke", "accel", "tools/verification/scenario/scenarios/craft-smoke.scenario.json"),
    task("realtime:movement-smoke", "realtime", "tools/verification/scenario/scenarios/movement-smoke.scenario.json"),
    task("realtime:movement-race", "realtime", "tools/verification/scenario/scenarios/movement-race.scenario.json"),
    task("tui:movement", "tui", "client-tui/journeys/journeys/020-movement.mjs"),
    task("tui:farm-loop", "tui", "client-tui/journeys/journeys/150-farm-loop.mjs"),
    task("3d:movement", "3d", "tools/verification/client3d/journeys/movement.mjs"),
    task("3d:farm", "3d", "tools/verification/client3d/journeys/farm.mjs"),
    task("desktop:smoke", "desktop", "tools/verification/desktop-smoke.mjs"),
    task("feel:visual-review", "desktop", "tools/verification/feel.mjs", { category: "feel" }),
    task("perf:world-bench", "node", "tools/verification/perf.mjs", { category: "perf" }),
    task("soak:overnight", "realtime", "tools/verification/soak.mjs", { optIn: true }),
  ];
}

function coverageMap() {
  return {
    schema: "successor.coverage-registry.v1",
    systems: [
      {
        id: "movement",
        scenarioRefs: ["movement-smoke"],
        tuiJourneys: ["client-tui/journeys/journeys/020-movement.mjs"],
        client3dJourneys: ["tools/verification/client3d/journeys/movement.mjs"],
      },
    ],
    commands: [
      {
        kind: "Move",
        systemId: "movement",
        refs: { files: [{ path: "crates/successor-sim/src/authority/tests.rs" }], scenarios: ["movement-smoke"] },
      },
    ],
  };
}

const CURRENT = manifest([entry("client/src/runtime.ts", HASH.entryA)], HASH.current);

function select(changedPaths, { mode = "fast", currentManifest = CURRENT, baselineManifest, baselinePath } = {}) {
  return selectVerificationTasks({
    tasks: tasks(),
    coverageMap: coverageMap(),
    changedPaths,
    mode,
    currentManifest,
    baselineManifest,
    baselinePath,
  });
}

function sorted(ids) {
  return [...ids].sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
}

function staticPlus(...ids) {
  return sorted([...STATIC_TASK_IDS, ...ids]);
}

function rule(selection, id) {
  return selection.rules.find((candidate) => candidate.id === id);
}

describe("verification selection contracts", () => {
  it("selects exactly G0 plus the changed scenario's accelerated task, without realtime or UI leakage", () => {
    const selection = select(["tools/verification/scenario/scenarios/movement-smoke.scenario.json"]);

    assert.strictEqual(selection.schema, VERIFY_SELECTION_SCHEMA);
    assert.deepEqual(selection.taskIds, staticPlus("accel:movement-smoke"));
    assert.strictEqual(selection.noOpScope, false);
    assert.deepEqual(rule(selection, "scenario-ref"), {
      id: "scenario-ref",
      paths: ["tools/verification/scenario/scenarios/movement-smoke.scenario.json"],
      taskIds: ["accel:movement-smoke"],
    });
    assert.deepEqual(selection.taskIds.filter((id) => /^(?:realtime|tui|3d|desktop):/u.test(id)), []);
  });

  it("selects the actual realtime task when a scenario has no accelerated counterpart", () => {
    const selection = select(["tools/verification/scenario/scenarios/movement-race.scenario.json"]);

    assert.deepEqual(selection.taskIds, staticPlus("realtime:movement-race"));
    assert.deepEqual(selection.taskIds.filter((id) => /^(?:accel|tui|3d|desktop):/u.test(id)), []);
    assert.deepEqual(rule(selection, "scenario-ref"), {
      id: "scenario-ref",
      paths: ["tools/verification/scenario/scenarios/movement-race.scenario.json"],
      taskIds: ["realtime:movement-race"],
    });
  });

  it("keeps docs-only changes as a G0-only no-op scope", () => {
    const selection = select(["docs/CANONICAL_CONTEXT.md"]);

    assert.deepEqual(selection.taskIds, sorted(STATIC_TASK_IDS));
    assert.strictEqual(selection.noOpScope, true);
    assert.deepEqual(selection.coverageEvidence.find((evidence) => evidence.path === "docs/CANONICAL_CONTEXT.md"), {
      kind: "scope-noop",
      path: "docs/CANONICAL_CONTEXT.md",
      systemIds: [],
      taskIds: [],
    });
  });

  it("selects the owning TUI unit task and every isolated TUI journey only for TUI package code", () => {
    const selection = select(["client-tui/src/game/farm.ts"]);

    assert.deepEqual(selection.taskIds, staticPlus("node:client-tui", "tui:farm-loop", "tui:movement"));
    assert.deepEqual(selection.taskIds.filter((id) => /^(?:realtime|3d|desktop):/u.test(id)), []);
    assert.deepEqual(rule(selection, "client-tui-package"), {
      id: "client-tui-package",
      paths: ["client-tui/src/game/farm.ts"],
      taskIds: ["node:client-tui", "tui:farm-loop", "tui:movement"],
    });
  });

  it("selects the owning 3D unit task and every 3D journey only for 3D package code", () => {
    const selection = select(["client-3d/src/ui/inventory/containers.ts"]);

    assert.deepEqual(selection.taskIds, staticPlus("node:client-3d", "3d:farm", "3d:movement"));
    assert.deepEqual(selection.taskIds.filter((id) => /^(?:realtime|tui|desktop):/u.test(id)), []);
    assert.deepEqual(rule(selection, "client-3d-package"), {
      id: "client-3d-package",
      paths: ["client-3d/src/ui/inventory/containers.ts"],
      taskIds: ["3d:farm", "3d:movement", "node:client-3d"],
    });
  });

  it("selects the Rust authority unit task and every registry-backed movement verification surface", () => {
    const selection = select(["crates/successor-sim/src/authority/tests.rs"]);

    assert.deepEqual(selection.taskIds, staticPlus(
      "rust:successor-sim",
      "accel:craft-smoke",
      "accel:movement-smoke",
      "tui:movement",
      "3d:movement",
    ));
    assert.deepEqual(rule(selection, "coverage-file-ref"), {
      id: "coverage-file-ref",
      paths: ["crates/successor-sim/src/authority/tests.rs"],
      taskIds: ["3d:movement", "accel:movement-smoke", "tui:movement"],
    });
    assert.deepEqual(selection.coverageEvidence.find((evidence) => evidence.path === "crates/successor-sim/src/authority/tests.rs" && evidence.kind === "coverage-ref"), {
      kind: "coverage-ref",
      path: "crates/successor-sim/src/authority/tests.rs",
      systemIds: ["movement"],
      taskIds: ["3d:movement", "accel:movement-smoke", "tui:movement"],
    });
    assert.deepEqual(selection.taskIds.filter((id) => /^(?:realtime|desktop):/u.test(id)), []);
  });

  it("selects the server unit task and all accelerated scenarios for server game code", () => {
    const selection = select(["server/src/game/shard.ts"]);

    assert.deepEqual(selection.taskIds, staticPlus("node:server", "accel:craft-smoke", "accel:movement-smoke"));
    assert.deepEqual(selection.taskIds.filter((id) => /^(?:realtime|tui|3d|desktop):/u.test(id)), []);
    assert.deepEqual(rule(selection, "server-package"), {
      id: "server-package",
      paths: ["server/src/game/shard.ts"],
      taskIds: ["accel:craft-smoke", "accel:movement-smoke", "node:server"],
    });
  });

  it("expands a coverage registry change to every required verification task but never feel, perf, or soak work", () => {
    const selection = select(["tools/verification/coverage/coverage-map.json"]);
    const expected = tasks().filter((candidate) => !["feel:visual-review", "perf:world-bench", "soak:overnight"].includes(candidate.id)).map((candidate) => candidate.id);

    assert.deepEqual(selection.taskIds, sorted(expected));
    assert.deepEqual(rule(selection, "coverage-registry-change"), {
      id: "coverage-registry-change",
      paths: ["tools/verification/coverage/coverage-map.json"],
      taskIds: sorted(expected),
    });
    assert.deepEqual(selection.coverageEvidence.find((evidence) => evidence.path === "tools/verification/coverage/coverage-map.json"), {
      kind: "coverage-ref",
      path: "tools/verification/coverage/coverage-map.json",
      systemIds: ["movement"],
      taskIds: sorted(expected),
    });
  });

  it("uses a conservative unit-only fallback for unknown package code outside known roots", () => {
    const selection = select(["packages/unmapped/src/index.ts"]);

    assert.deepEqual(selection.taskIds, staticPlus(
      "node:client",
      "node:client-3d",
      "node:client-tui",
      "node:server",
      "rust:successor-sim",
      "rust:successor-slice",
    ));
    assert.deepEqual(selection.taskIds.filter((id) => /^(?:accel|realtime|tui|3d|desktop):/u.test(id)), []);
    assert.deepEqual(rule(selection, "unknown-code-conservative-units"), {
      id: "unknown-code-conservative-units",
      paths: ["packages/unmapped/src/index.ts"],
      taskIds: [
        "node:client",
        "node:client-3d",
        "node:client-tui",
        "node:server",
        "rust:successor-sim",
        "rust:successor-slice",
      ],
    });
  });

  it("derives exact, byte-sorted changed paths from an explicit verified manifest baseline", () => {
    const baseline = manifest([
      entry("docs/removed.md", HASH.entryA),
      entry("server/src/game/shard.ts", HASH.entryB),
      entry("tools/verification/scenario/scenarios/movement-smoke.scenario.json", HASH.entryC),
    ], HASH.baseline);
    const current = manifest([
      entry("client/src/runtime.ts", HASH.entryD),
      entry("server/src/game/shard.ts", HASH.entryC),
      entry("tools/verification/scenario/scenarios/movement-smoke.scenario.json", HASH.entryC, { executable: true }),
    ], HASH.current);

    assert.deepEqual(diffSourceManifests(baseline, current), [
      "client/src/runtime.ts",
      "docs/removed.md",
      "server/src/game/shard.ts",
      "tools/verification/scenario/scenarios/movement-smoke.scenario.json",
    ]);

    const selection = select(undefined, { baselineManifest: baseline, currentManifest: current, baselinePath: "verification/baseline.json" });
    assert.deepEqual(selection.changedPaths, [
      "client/src/runtime.ts",
      "docs/removed.md",
      "server/src/game/shard.ts",
      "tools/verification/scenario/scenarios/movement-smoke.scenario.json",
    ]);
    assert.strictEqual(selection.source.baseline.path, "verification/baseline.json");
  });

  it("fails loud instead of deriving a tiny fast delta from an unverified dirty worktree", () => {
    assert.throws(
      () => selectVerificationTasks({
        tasks: tasks(),
        coverageMap: coverageMap(),
        currentManifest: CURRENT,
      }),
      (error) => error?.code === "BASELINE_REQUIRED",
    );
  });

  it("never returns a non-G0 selection when the task graph has no static truth checks", () => {
    assert.throws(
      () => selectVerificationTasks({
        tasks: tasks().filter((candidate) => candidate.tier !== "G0"),
        coverageMap: coverageMap(),
        changedPaths: ["server/src/game/shard.ts"],
        currentManifest: CURRENT,
      }),
      (error) => error?.code === "G0_TASKS_MISSING",
    );
  });

  it("makes full selection fresh and canonical while excluding opt-in feel/perf/soak tasks", () => {
    const scopedCurrent = { ...CURRENT, scopePrefixes: ["client/"] };
    const selection = select([], { mode: "full", currentManifest: scopedCurrent });
    const expected = tasks().filter((candidate) => !["feel:visual-review", "perf:world-bench", "soak:overnight"].includes(candidate.id)).map((candidate) => candidate.id);

    assert.strictEqual(selection.mode, "full");
    assert.deepEqual(selection.taskIds, sorted(expected));
    assert.strictEqual(selection.cache.enabled, false);
    assert.strictEqual(selection.cache.reason, "full-mode-fresh");
    assert.strictEqual(selection.cache.sourceHash, HASH.current);
    assert.strictEqual(selection.source.currentHash, HASH.current);
    assert.deepEqual(selection.coverageEvidence, [{
      kind: "full",
      path: null,
      systemIds: [],
      taskIds: sorted(expected),
    }, {
      kind: "static",
      path: null,
      systemIds: [],
      taskIds: sorted(STATIC_TASK_IDS),
    }]);
  });

  it("builds a fresh full verification plan with separate shared-build and verification phases", () => {
    const plannedTasks = tasks().map((candidate) => ({
      ...candidate,
      phase: candidate.phase ?? 1,
      ...(candidate.tier === "G0" ? { category: "build" } : {}),
    }));
    const selection = selectVerificationTasks({
      tasks: plannedTasks,
      coverageMap: coverageMap(),
      mode: "full",
      currentManifest: CURRENT,
    });

    const plan = buildFullVerificationPlan({ tasks: plannedTasks, selection });
    const phase1 = plannedTasks
      .filter((candidate) => candidate.phase === 1 && !["feel:visual-review", "perf:world-bench", "soak:overnight"].includes(candidate.id))
      .map((candidate) => candidate.id);

    assert.strictEqual(plan.schema, VERIFY_FULL_PLAN_SCHEMA);
    assert.strictEqual(plan.mode, "full");
    assert.strictEqual(plan.fresh, true);
    assert.strictEqual(plan.sourceHash, HASH.current);
    assert.deepEqual(plan.taskIds, selection.taskIds);
    assert.deepEqual(plan.phases, [
      { id: "phase-0", taskIds: sorted(STATIC_TASK_IDS) },
      { id: "phase-1", taskIds: sorted(phase1) },
    ]);
  });

  it("rejects a full plan if a selection claims cached or scoped provenance", () => {
    const selection = select([], { mode: "full" });

    assert.throws(
      () => buildFullVerificationPlan({
        tasks: tasks(),
        selection: { ...selection, cache: { ...selection.cache, enabled: true } },
      }),
      (error) => error?.code === "INVALID_FULL_PROVENANCE",
    );
  });

  it("preserves the legacy aggregate gate script while verification selection remains a separate surface", async () => {
    const packageJson = JSON.parse(await fs.readFile(path.join(repoRoot, "package.json"), "utf8"));

    assert.strictEqual(
      packageJson.scripts["gate:all"],
      "GAME_ALLOW_DEV_IDENTITY=1 pnpm play:gate && GAME_ALLOW_DEV_IDENTITY=1 pnpm tui:gate && GAME_ALLOW_DEV_IDENTITY=1 pnpm 3d:gate",
    );
  });
});
