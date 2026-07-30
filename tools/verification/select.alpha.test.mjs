import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { selectVerificationTasks } from "./select.mjs";

const HASH = "a".repeat(64);
const STATIC = ["static:commands", "static:coverage", "static:denylist", "static:successor-context", "static:deploy-contract", "static:fixture"];

function task(id, lane, shard, extra = {}) {
  return { id, lane, shard, required: true, ...extra };
}

function tasks() {
  return [
    ...STATIC.map((id) => task(id, "static", `package.json#${id}`, { tier: "G0", phase: 0, category: "static" })),
    task("node:server", "node", "server"),
    task("node:client", "node", "client"),
    task("node:client-3d", "node", "client-3d"),
    task("rust:successor-sim", "rust", "crates/successor-sim"),
    task("accel:movement-smoke", "accel", "movement"),
    task("tui:movement", "tui", "movement"),
    task("3d:movement", "3d", "movement"),
    task("desktop:smoke", "desktop", "desktop"),
  ];
}

function coverageMap() {
  return { schema: "successor.coverage-registry.v1", systems: [], commands: [] };
}

function manifest() {
  return {
    schema: "successor.source-manifest.v1",
    sourceHash: HASH,
    fileCount: 0,
    totalBytes: 0,
    entries: [],
  };
}

function select(path) {
  return selectVerificationTasks({ tasks: tasks(), coverageMap: coverageMap(), changedPaths: [path], currentManifest: manifest() });
}

function assertStaticAnd(selection, ids) {
  assert.deepEqual(selection.taskIds, [...new Set([...STATIC, ...ids])].sort());
}

describe("alpha verification selection precedence", () => {
  it("keeps documentation ahead of deploy and runtime classification", () => {
    const selection = select("docs/ops/deploy.md");
    assertStaticAnd(selection, []);
    assert.equal(selection.rules.find((rule) => rule.id === "documentation-only")?.paths[0], "docs/ops/deploy.md");
  });

  it("routes fixture and map changes to the fixture gate before client fallback", () => {
    const selection = select("client/public/successor-slice/open-desert-slice.json");
    assertStaticAnd(selection, ["static:fixture", "node:server", "rust:successor-sim"]);
    assert.equal(selection.rules.find((rule) => rule.id === "fixture-map")?.paths[0], "client/public/successor-slice/open-desert-slice.json");
  });

  it("routes save and wire contracts across authority and focused client gates", () => {
    const selection = select("server/src/game/save-schema.ts");
    assertStaticAnd(selection, ["node:server", "rust:successor-sim", "accel:movement-smoke", "tui:movement", "3d:movement"]);
    assert.equal(selection.rules.find((rule) => rule.id === "save-wire-contract")?.paths[0], "server/src/game/save-schema.ts");
    assert.equal(selection.taskIds.includes("desktop:smoke"), false);
  });

  it("routes staging deploy files to the provider-free deploy contract and server build", () => {
    const selection = select("ops/deploy/scripts/deploy.sh");
    assertStaticAnd(selection, ["static:deploy-contract", "node:server"]);
    assert.equal(selection.rules.find((rule) => rule.id === "deploy-runtime")?.paths[0], "ops/deploy/scripts/deploy.sh");
  });
});
