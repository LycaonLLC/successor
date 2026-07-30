import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..", "..", "..");
const checkScript = path.join(scriptDir, "check.mjs");

const realRegistryPath = path.join(scriptDir, "coverage-map.json");
const realManifestPath = path.resolve(repoRoot, "tools/codegen/generated/successor.commands.manifest.v1.json");
const realQuarantinePath = path.resolve(repoRoot, "verification/flaky-quarantine.json");

const realRegistry = JSON.parse(fs.readFileSync(realRegistryPath, "utf8"));
const realManifest = JSON.parse(fs.readFileSync(realManifestPath, "utf8"));
const realQuarantine = JSON.parse(fs.readFileSync(realQuarantinePath, "utf8"));
const manifestCounts = {
  total: realManifest.commands.length,
  production: realManifest.commands.filter((command) => command.debugGated === false).length,
  debug: realManifest.commands.filter((command) => command.debugGated === true).length,
};
const activeWaiverCount = realRegistry.waivers.filter((waiver) => Date.parse(waiver.expiresAt) > Date.now()).length;
const activeCoverageWaiverCount = realRegistry.waivers.filter((waiver) => (
  waiver.scope?.requirement === "coverage" && Date.parse(waiver.expiresAt) > Date.now()
)).length;
const activeRequiredSurfaceWaiverCount = activeWaiverCount - activeCoverageWaiverCount;

function appendTestWaiver(registry) {
  const createdAt = new Date();
  const expiresAt = new Date(createdAt.getTime() + 14 * 24 * 60 * 60 * 1000);
  const waiver = {
    id: "coverage-check-test-waiver",
    scope: { systemId: "movement", requirement: "raceScenario" },
    owner: "test-owner",
    reason: "Synthetic waiver used to exercise metadata validation.",
    createdAt: createdAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
  };
  registry.waivers ??= [];
  registry.waivers.push(waiver);
  return waiver;
}

const tempDirectories = new Set();

function createTempJsonFile(data) {
  const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "successor-coverage-check-"));
  const filePath = path.join(tempDirectory, "fixture.json");
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");
  tempDirectories.add(tempDirectory);
  return filePath;
}

function cleanupTempDirectories(directories) {
  for (const directory of directories) {
    if (!tempDirectories.delete(directory)) continue;
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function cleanupFixtureFiles(filePaths) {
  cleanupTempDirectories(filePaths.map((filePath) => path.dirname(filePath)));
}

afterEach(() => {
  cleanupTempDirectories([...tempDirectories]);
});

function runCheck(registryPath, manifestPath, quarantinePath, extraArgs = []) {
  try {
    const stdout = execFileSync("node", [
      checkScript,
      "--registry", registryPath,
      "--manifest", manifestPath,
      "--quarantine", quarantinePath,
      ...extraArgs
    ], { encoding: "utf8", stdio: "pipe" });
    return { status: 0, stdout, stderr: "" };
  } catch (error) {
    return {
      status: error.status || 1,
      stdout: error.stdout || "",
      stderr: error.stderr || ""
    };
  } finally {
    cleanupFixtureFiles([registryPath, manifestPath, quarantinePath]);
  }
}

describe("Coverage Registry Check Suite", () => {
  it("verifies the current registry is green and reports exact counts", () => {
    const regPath = createTempJsonFile(realRegistry);
    const manPath = createTempJsonFile(realManifest);
    const quarPath = createTempJsonFile(realQuarantine);

    const result = runCheck(regPath, manPath, quarPath);
    assert.strictEqual(result.status, 0);
    assert.ok(result.stdout.includes(`Coverage registry OK: ${manifestCounts.total}/${manifestCounts.total} commands tracked`));
    assert.ok(result.stdout.includes(`${manifestCounts.production} production, ${manifestCounts.debug} debug-only`));
    assert.ok(result.stdout.includes("16 systems"));
    assert.ok(result.stdout.includes(`${manifestCounts.total} commands have existing refs`));
    assert.ok(result.stdout.includes(`${manifestCounts.production}/${manifestCounts.production} production, ${manifestCounts.debug}/${manifestCounts.debug} debug-only`));
    assert.ok(result.stdout.includes("0 command-coverage waivers"));
    assert.ok(result.stdout.includes(`${activeWaiverCount} active waivers`));
    assert.ok(result.stdout.includes(`${activeCoverageWaiverCount} command coverage, ${activeRequiredSurfaceWaiverCount} required surfaces, 0 operational surfaces`));
  });

  it("removes external fixture directories after checker failures", () => {
    const registry = structuredClone(realRegistry);
    const manifest = structuredClone(realManifest);
    const quarantine = structuredClone(realQuarantine);
    registry.commands[0].kind = "DefinitelyUnknownCommand";

    const fixturePaths = [
      createTempJsonFile(registry),
      createTempJsonFile(manifest),
      createTempJsonFile(quarantine),
    ];
    const fixtureDirectories = fixturePaths.map((filePath) => path.dirname(filePath));

    const result = runCheck(...fixturePaths);

    assert.strictEqual(result.status, 1);
    assert.ok(result.stderr.includes("COMMAND_UNKNOWN"));
    assert.ok(fixtureDirectories.every((directory) => !fs.existsSync(directory)));
  });

  it("fails on unknown/missing/duplicate commands", () => {
    // 1. Unknown command: Replace one command in registry with an unknown one
    {
      const registry = structuredClone(realRegistry);
      const manifest = structuredClone(realManifest);
      const quarantine = structuredClone(realQuarantine);

      const originalKind = registry.commands[0].kind;
      registry.commands[0].kind = "DefinitelyUnknownCommand";

      const regPath = createTempJsonFile(registry);
      const manPath = createTempJsonFile(manifest);
      const quarPath = createTempJsonFile(quarantine);

      const result = runCheck(regPath, manPath, quarPath);
      assert.strictEqual(result.status, 1);
      assert.ok(result.stderr.includes("COMMAND_UNKNOWN"));
      assert.ok(result.stderr.includes("COMMAND_MISSING"));
    }

    // 2. Duplicate command in registry
    {
      const registry = structuredClone(realRegistry);
      const manifest = structuredClone(realManifest);
      const quarantine = structuredClone(realQuarantine);

      registry.commands.push(structuredClone(registry.commands[0]));

      const regPath = createTempJsonFile(registry);
      const manPath = createTempJsonFile(manifest);
      const quarPath = createTempJsonFile(quarantine);

      const result = runCheck(regPath, manPath, quarPath);
      assert.strictEqual(result.status, 1);
      assert.ok(result.stderr.includes("COMMAND_DUPLICATE"));
      assert.ok(result.stderr.includes("COMMAND_COUNT"));
    }

    // 3. Duplicate command in manifest
    {
      const registry = structuredClone(realRegistry);
      const manifest = structuredClone(realManifest);
      const quarantine = structuredClone(realQuarantine);

      manifest.commands.push(structuredClone(manifest.commands[0]));

      const regPath = createTempJsonFile(registry);
      const manPath = createTempJsonFile(manifest);
      const quarPath = createTempJsonFile(quarantine);

      const result = runCheck(regPath, manPath, quarPath);
      assert.strictEqual(result.status, 1);
      assert.ok(result.stderr.includes("MANIFEST_COMMAND_DUPLICATE"));
      assert.ok(result.stderr.includes("MANIFEST_DECLARED_COUNT"));
    }
  });

  it("fails when an authority command is omitted in the registry", () => {
    const registry = structuredClone(realRegistry);
    const manifest = structuredClone(realManifest);
    const quarantine = structuredClone(realQuarantine);

    registry.commands.splice(0, 1);

    const regPath = createTempJsonFile(registry);
    const manPath = createTempJsonFile(manifest);
    const quarPath = createTempJsonFile(quarantine);

    const result = runCheck(regPath, manPath, quarPath);
    assert.strictEqual(result.status, 1);
    assert.ok(result.stderr.includes("COMMAND_MISSING"));
    assert.ok(result.stderr.includes("COMMAND_COUNT"));
  });

  it("fails on missing file and scenario references, and relative path violations", () => {
    // 1. Missing file ref
    {
      const registry = structuredClone(realRegistry);
      const manifest = structuredClone(realManifest);
      const quarantine = structuredClone(realQuarantine);

      const cmd = registry.commands[0];
      cmd.refs.files = [{ path: "tools/verification/coverage/__missing_file__.test.mjs", anchor: "some-anchor" }];
      cmd.refs.scenarios = [];

      const regPath = createTempJsonFile(registry);
      const manPath = createTempJsonFile(manifest);
      const quarPath = createTempJsonFile(quarantine);

      const result = runCheck(regPath, manPath, quarPath);
      assert.strictEqual(result.status, 1);
      assert.ok(result.stderr.includes("FILE_MISSING"));
    }

    // 2. Missing scenario ref
    {
      const registry = structuredClone(realRegistry);
      const manifest = structuredClone(realManifest);
      const quarantine = structuredClone(realQuarantine);

      const cmd = registry.commands[0];
      cmd.refs.files = [];
      cmd.refs.scenarios = ["__MissingScenario__"];

      const regPath = createTempJsonFile(registry);
      const manPath = createTempJsonFile(manifest);
      const quarPath = createTempJsonFile(quarantine);

      const result = runCheck(regPath, manPath, quarPath);
      assert.strictEqual(result.status, 1);
      assert.ok(result.stderr.includes("SCENARIO_MISSING"));
    }

    // 3. Absolute path / outside repo / duplicate / directory path / shape / anchor checks
    {
      const registry = structuredClone(realRegistry);
      const manifest = structuredClone(realManifest);
      const quarantine = structuredClone(realQuarantine);

      const cmd = registry.commands[0];
      cmd.refs.files = [
        { path: "/absolute/path", anchor: "some-anchor" },
        { path: "../outside/repo", anchor: "some-anchor" },
        { path: "tools/verification/coverage", anchor: "some-anchor" },
        { path: "tools/verification/coverage/check.test.mjs" },
        { path: "package.json", anchor: "some-anchor", kind: "invalid" }
      ];

      const regPath = createTempJsonFile(registry);
      const manPath = createTempJsonFile(manifest);
      const quarPath = createTempJsonFile(quarantine);

      const result = runCheck(regPath, manPath, quarPath);
      assert.strictEqual(result.status, 1);
      assert.ok(result.stderr.includes("FILE_REF_RELATIVE"));
      assert.ok(result.stderr.includes("FILE_REF_OUTSIDE_REPO"));
      assert.ok(result.stderr.includes("FILE_NOT_FILE"));
      assert.ok(result.stderr.includes("COVERAGE_ANCHOR"));
      assert.ok(result.stderr.includes("COVERAGE_FILE_KIND"));
    }

    // 4. Duplicate test paths for same command
    {
      const registry = structuredClone(realRegistry);
      const manifest = structuredClone(realManifest);
      const quarantine = structuredClone(realQuarantine);

      const cmd = registry.commands[0];
      cmd.refs.files = [
        { path: "tools/verification/coverage/check.test.mjs", anchor: "some-anchor" },
        { path: "tools/verification/coverage/check.test.mjs", anchor: "another-anchor" }
      ];

      const regPath = createTempJsonFile(registry);
      const manPath = createTempJsonFile(manifest);
      const quarPath = createTempJsonFile(quarantine);

      const result = runCheck(regPath, manPath, quarPath);
      assert.strictEqual(result.status, 1);
      assert.ok(result.stderr.includes("COVERAGE_FILE_DUPLICATE"));
    }

    // 5. Journey path prefixes/suffix constraints
    {
      const registry = structuredClone(realRegistry);
      const manifest = structuredClone(realManifest);
      const quarantine = structuredClone(realQuarantine);

      const system = registry.systems[0];
      system.tuiJourneys = ["package.json"];
      system.client3dJourneys = ["package.json"];

      const regPath = createTempJsonFile(registry);
      const manPath = createTempJsonFile(manifest);
      const quarPath = createTempJsonFile(quarantine);

      const result = runCheck(regPath, manPath, quarPath);
      assert.strictEqual(result.status, 1);
      assert.ok(result.stderr.includes("JOURNEY_PATH"));
    }
  });

  it("enforces test surface logic, inline production tests anchors, and scenario anchors", () => {
    // 1. Unrelated production file cannot satisfy command coverage
    {
      const registry = structuredClone(realRegistry);
      const manifest = structuredClone(realManifest);
      const quarantine = structuredClone(realQuarantine);


      const cmd = registry.commands[0];
      cmd.refs.files = [{ path: "tools/verification/coverage/check.mjs", anchor: "function validateAll" }];
      cmd.refs.scenarios = [];

      const regPath = createTempJsonFile(registry);
      const manPath = createTempJsonFile(manifest);
      const quarPath = createTempJsonFile(quarantine);

      const result = runCheck(regPath, manPath, quarPath);
      assert.strictEqual(result.status, 1);
      assert.ok(result.stderr.includes("FILE_NOT_TEST_SURFACE"));
    }

    // 2. Inline test in production file: fails if anchor is before #[cfg(test)] mod
    {
      const registry = structuredClone(realRegistry);
      const manifest = structuredClone(realManifest);
      const quarantine = structuredClone(realQuarantine);


      const cmd = registry.commands[0];
      cmd.refs.files = [{ path: "crates/successor-sim/src/authority/groups.rs", anchor: "GROUP_INVITE_EXPIRY_TICKS", kind: "inlineTest" }];
      cmd.refs.scenarios = [];

      const regPath = createTempJsonFile(registry);
      const manPath = createTempJsonFile(manifest);
      const quarPath = createTempJsonFile(quarantine);

      const result = runCheck(regPath, manPath, quarPath);
      assert.strictEqual(result.status, 1);
      assert.ok(result.stderr.includes("INLINE_TEST_ANCHOR"));
    }

    // 3. Inline test in production file: passes if anchor is inside/after #[cfg(test)] mod
    {
      const registry = structuredClone(realRegistry);
      const manifest = structuredClone(realManifest);
      const quarantine = structuredClone(realQuarantine);


      const cmd = registry.commands[0];
      cmd.refs.files = [{ path: "crates/successor-sim/src/authority/groups.rs", anchor: "fn invite_accept_forms_group_with_inviter_as_leader()", kind: "inlineTest" }];
      cmd.refs.scenarios = [];

      const regPath = createTempJsonFile(registry);
      const manPath = createTempJsonFile(manifest);
      const quarPath = createTempJsonFile(quarantine);

      const result = runCheck(regPath, manPath, quarPath);
      assert.ok(!result.stderr.includes("INLINE_TEST_ANCHOR"));
      assert.ok(!result.stderr.includes("FILE_NOT_TEST_SURFACE"));
    }

    // 4. Test file lacks anchor
    {
      const registry = structuredClone(realRegistry);
      const manifest = structuredClone(realManifest);
      const quarantine = structuredClone(realQuarantine);


      const cmd = registry.commands[0];
      cmd.refs.files = [{ path: "tools/successor/play-flows/primitives.test.mjs", anchor: "MissingCoverageAnchor" }];
      cmd.refs.scenarios = [];

      const regPath = createTempJsonFile(registry);
      const manPath = createTempJsonFile(manifest);
      const quarPath = createTempJsonFile(quarantine);

      const result = runCheck(regPath, manPath, quarPath);
      assert.strictEqual(result.status, 1);
      assert.ok(result.stderr.includes("COVERAGE_ANCHOR_MISSING"));
    }

    // 5. Command scenario ref requires the command anchor in scenario content
    {
      const registry = structuredClone(realRegistry);
      const manifest = structuredClone(realManifest);
      const quarantine = structuredClone(realQuarantine);

      const craftItemCmd = registry.commands.find(c => c.kind === "CraftItem");
      assert.ok(craftItemCmd !== undefined);
      craftItemCmd.refs.scenarios = ["move-displacement"];

      const regPath = createTempJsonFile(registry);
      const manPath = createTempJsonFile(manifest);
      const quarPath = createTempJsonFile(quarantine);

      const result = runCheck(regPath, manPath, quarPath);
      assert.strictEqual(result.status, 1);
      assert.ok(result.stderr.includes("SCENARIO_ANCHOR_MISSING"));
    }
  });

  it("enforces debug-only command flags and checks count mismatches", () => {
    // 1. debugOnly mismatch
    {
      const registry = structuredClone(realRegistry);
      const manifest = structuredClone(realManifest);
      const quarantine = structuredClone(realQuarantine);

      const cmdIdx = registry.commands.findIndex(c => c.debugOnly === false);
      registry.commands[cmdIdx].debugOnly = true;

      const regPath = createTempJsonFile(registry);
      const manPath = createTempJsonFile(manifest);
      const quarPath = createTempJsonFile(quarantine);

      const result = runCheck(regPath, manPath, quarPath);
      assert.strictEqual(result.status, 1);
      assert.ok(result.stderr.includes("COMMAND_DEBUG_MISMATCH"));
    }

    // 2. debugOnly is not a boolean
    {
      const registry = structuredClone(realRegistry);
      const manifest = structuredClone(realManifest);
      const quarantine = structuredClone(realQuarantine);

      registry.commands[0].debugOnly = "not-a-boolean";

      const regPath = createTempJsonFile(registry);
      const manPath = createTempJsonFile(manifest);
      const quarPath = createTempJsonFile(quarantine);

      const result = runCheck(regPath, manPath, quarPath);
      assert.strictEqual(result.status, 1);
      assert.ok(result.stderr.includes("COMMAND_DEBUG_FLAG"));
    }
    // 3. Generated manifest debug count metadata must agree with its entries.
    {
      const registry = structuredClone(realRegistry);
      const manifest = structuredClone(realManifest);
      const quarantine = structuredClone(realQuarantine);

      manifest.debugGatedCount += 1;

      const result = runCheck(
        createTempJsonFile(registry),
        createTempJsonFile(manifest),
        createTempJsonFile(quarantine),
      );
      assert.strictEqual(result.status, 1);
      assert.ok(result.stderr.includes("MANIFEST_DEBUG_COUNT"));
    }
  });

  it("enforces multiplayer, persistence, race, and browser visible properties or waivers", () => {
    // 1. Failure when properties are set but no valid scenarios or journeys are referenced, and no waivers exist
    {
      const registry = structuredClone(realRegistry);
      const manifest = structuredClone(realManifest);
      const quarantine = structuredClone(realQuarantine);

      const system = registry.systems[0];
      system.properties = {
        realTimeRace: "high",
        accelLaneEligible: true,
        multiplayerNeed: "high",
        persistenceNeed: true,
        browserVisible: true
      };
      system.scenarioRefs = [];
      system.tuiJourneys = [];
      system.client3dJourneys = [];

      registry.waivers = registry.waivers.filter(w => w.scope.systemId !== system.id);

      const regPath = createTempJsonFile(registry);
      const manPath = createTempJsonFile(manifest);
      const quarPath = createTempJsonFile(quarantine);

      const result = runCheck(regPath, manPath, quarPath);
      assert.strictEqual(result.status, 1);
      assert.ok(result.stderr.includes("PROPERTY_UNCOVERED"));
      assert.ok(result.stderr.includes(`system:${system.id}.multiplayerScenario`));
      assert.ok(result.stderr.includes(`system:${system.id}.restartScenario`));
      assert.ok(result.stderr.includes(`system:${system.id}.raceScenario`));
      assert.ok(result.stderr.includes(`system:${system.id}.browserJourney`));
    }

    // 2. Green when waivers are provided for those property gaps
    {
      const registry = structuredClone(realRegistry);
      const manifest = structuredClone(realManifest);
      const quarantine = structuredClone(realQuarantine);

      const system = registry.systems[0];
      system.properties = {
        realTimeRace: "high",
        accelLaneEligible: true,
        multiplayerNeed: "high",
        persistenceNeed: true,
        browserVisible: true
      };
      system.scenarioRefs = [];
      system.tuiJourneys = [];
      system.client3dJourneys = [];

      registry.waivers = registry.waivers.filter(w => w.scope.systemId !== system.id);

      const now = new Date();
      const expires = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000);
      const createdAt = now.toISOString();
      const expiresAt = expires.toISOString();

      const requirements = ["multiplayerScenario", "restartScenario", "raceScenario", "browserJourney"];
      requirements.forEach((req, idx) => {
        registry.waivers.push({
          id: `temp-waiver-${system.id}-${req}-${idx}`,
          scope: {
            systemId: system.id,
            requirement: req
          },
          owner: "test-owner",
          reason: "This is a dummy test waiver that has more than twenty characters.",
          createdAt,
          expiresAt
        });
      });

      const regPath = createTempJsonFile(registry);
      const manPath = createTempJsonFile(manifest);
      const quarPath = createTempJsonFile(quarantine);

      const result = runCheck(regPath, manPath, quarPath);
      assert.strictEqual(result.status, 0);
    }
  });

  it("counts only journeys loaded by the browser runners", () => {
    // Registered journeys remain valid evidence for both browser surfaces.
    {
      const registry = structuredClone(realRegistry);
      const manifest = structuredClone(realManifest);
      const quarantine = structuredClone(realQuarantine);
      const travel = registry.systems.find((system) => system.id === "travel_doors");
      travel.tuiJourneys = ["client-tui/journeys/journeys/090-travel-exchange.mjs"];
      travel.client3dJourneys = ["tools/verification/client3d/journeys/travel.mjs"];

      const result = runCheck(
        createTempJsonFile(registry),
        createTempJsonFile(manifest),
        createTempJsonFile(quarantine),
      );
      assert.strictEqual(result.status, 0);
    }

    // An existing 3D helper is not a journey exported by the 3D index.
    {
      const registry = structuredClone(realRegistry);
      const manifest = structuredClone(realManifest);
      const quarantine = structuredClone(realQuarantine);
      const travel = registry.systems.find((system) => system.id === "travel_doors");
      travel.tuiJourneys = [];
      travel.client3dJourneys = ["tools/verification/client3d/journeys/_helpers.mjs"];

      const result = runCheck(
        createTempJsonFile(registry),
        createTempJsonFile(manifest),
        createTempJsonFile(quarantine),
      );
      assert.strictEqual(result.status, 1);
      assert.ok(result.stderr.includes("PROPERTY_UNCOVERED"));
      assert.ok(result.stderr.includes("system:travel_doors.browserJourney"));
    }

    // The TUI runner only counts runnable modules it can load as journeys.
    const unregisteredTuiPath = path.resolve(repoRoot, "client-tui/journeys/journeys/999-coverage-helper.mjs");
    fs.writeFileSync(unregisteredTuiPath, "export const notAJourney = true;\n", "utf8");
    try {
      const registry = structuredClone(realRegistry);
      const manifest = structuredClone(realManifest);
      const quarantine = structuredClone(realQuarantine);
      const travel = registry.systems.find((system) => system.id === "travel_doors");
      travel.tuiJourneys = ["client-tui/journeys/journeys/999-coverage-helper.mjs"];
      travel.client3dJourneys = [];

      const result = runCheck(
        createTempJsonFile(registry),
        createTempJsonFile(manifest),
        createTempJsonFile(quarantine),
      );
      assert.strictEqual(result.status, 1);
      assert.ok(result.stderr.includes("PROPERTY_UNCOVERED"));
      assert.ok(result.stderr.includes("system:travel_doors.browserJourney"));
    } finally {
      fs.rmSync(unregisteredTuiPath, { force: true });
    }
  });

  it("requires scoped multiplayer waivers to observe all kinds across distinct issuing actors", () => {
    {
      const registry = structuredClone(realRegistry);
      const manifest = structuredClone(realManifest);
      const quarantine = structuredClone(realQuarantine);
      const exchange = registry.systems.find((system) => system.id === "exchange");
      exchange.scenarioRefs = ["social-trade-exchange-restart-persistence"];
      const result = runCheck(
        createTempJsonFile(registry),
        createTempJsonFile(manifest),
        createTempJsonFile(quarantine),
      );
      assert.strictEqual(result.status, 0);
    }

    {
      const registry = structuredClone(realRegistry);
      const manifest = structuredClone(realManifest);
      const quarantine = structuredClone(realQuarantine);
      const now = new Date();
      const expires = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000);
      const trade = registry.systems.find((system) => system.id === "trade");
      trade.scenarioRefs = ["social-trade-exchange-restart-persistence"];
      registry.waivers.push({
        id: "temp-trade-contention-waiver",
        scope: {
          systemId: "trade",
          requirement: "multiplayerScenario",
          commandKinds: ["AddTradeItem"],
        },
        owner: "test-owner",
        reason: "This waiver verifies two actors contend through the scoped trade command.",
        createdAt: now.toISOString(),
        expiresAt: expires.toISOString(),
      });

      const result = runCheck(
        createTempJsonFile(registry),
        createTempJsonFile(manifest),
        createTempJsonFile(quarantine),
      );
      assert.strictEqual(result.status, 1);
      assert.ok(result.stderr.includes("WAIVER_UNUSED waiver:temp-trade-contention-waiver"));
    }
  });

  it("validates waiver metadata (owner, reason, fixed 14-day window, expiration, duplicates, and unused)", () => {
    // 1. Invalid owner (too short or TBD)
    {
      const registry = structuredClone(realRegistry);
      const manifest = structuredClone(realManifest);
      const quarantine = structuredClone(realQuarantine);

      const waiver = appendTestWaiver(registry);
      waiver.owner = "tbd";

      const regPath = createTempJsonFile(registry);
      const manPath = createTempJsonFile(manifest);
      const quarPath = createTempJsonFile(quarantine);

      const result = runCheck(regPath, manPath, quarPath);
      assert.strictEqual(result.status, 1);
      assert.ok(result.stderr.includes("WAIVER_OWNER"));
    }

    // 2. Invalid reason (too short)
    {
      const registry = structuredClone(realRegistry);
      const manifest = structuredClone(realManifest);
      const quarantine = structuredClone(realQuarantine);

      const waiver = appendTestWaiver(registry);
      waiver.reason = "too short";

      const regPath = createTempJsonFile(registry);
      const manPath = createTempJsonFile(manifest);
      const quarPath = createTempJsonFile(quarantine);

      const result = runCheck(regPath, manPath, quarPath);
      assert.strictEqual(result.status, 1);
      assert.ok(result.stderr.includes("WAIVER_REASON"));
    }

    // 3. Expiry window not 14 days
    {
      const registry = structuredClone(realRegistry);
      const manifest = structuredClone(realManifest);
      const quarantine = structuredClone(realQuarantine);

      const waiver = appendTestWaiver(registry);
      waiver.createdAt = "2026-07-09T00:00:00.000Z";
      waiver.expiresAt = "2026-07-20T00:00:00.000Z";

      const regPath = createTempJsonFile(registry);
      const manPath = createTempJsonFile(manifest);
      const quarPath = createTempJsonFile(quarantine);

      const result = runCheck(regPath, manPath, quarPath);
      assert.strictEqual(result.status, 1);
      assert.ok(result.stderr.includes("WAIVER_WINDOW"));
    }

    // 4. Expired waiver
    {
      const registry = structuredClone(realRegistry);
      const manifest = structuredClone(realManifest);
      const quarantine = structuredClone(realQuarantine);

      const waiver = appendTestWaiver(registry);
      waiver.createdAt = "1999-12-18T00:00:00.000Z";
      waiver.expiresAt = "2000-01-01T00:00:00.000Z";

      const regPath = createTempJsonFile(registry);
      const manPath = createTempJsonFile(manifest);
      const quarPath = createTempJsonFile(quarantine);

      const result = runCheck(regPath, manPath, quarPath);
      assert.strictEqual(result.status, 1);
      assert.ok(result.stderr.includes("WAIVER_EXPIRED"));
    }

    // 5. Duplicate ID and Duplicate Scope
    {
      const registry = structuredClone(realRegistry);
      const manifest = structuredClone(realManifest);
      const quarantine = structuredClone(realQuarantine);

      const waiver = appendTestWaiver(registry);
      registry.waivers.push(structuredClone(waiver));

      const regPath = createTempJsonFile(registry);
      const manPath = createTempJsonFile(manifest);
      const quarPath = createTempJsonFile(quarantine);

      const result = runCheck(regPath, manPath, quarPath);
      assert.strictEqual(result.status, 1);
      assert.ok(result.stderr.includes("WAIVER_DUPLICATE_ID"));
    }

    // 6. Unused active waiver
    {
      const registry = structuredClone(realRegistry);
      const manifest = structuredClone(realManifest);
      const quarantine = structuredClone(realQuarantine);

      const now = new Date();
      const expires = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000);
      registry.waivers.push({
        id: "unused-coverage-waiver",
        scope: {
          systemId: "movement",
          requirement: "coverage",
          commandKind: "Move"
        },
        owner: "test-owner",
        reason: "Unused active coverage waiver on command that has references.",
        createdAt: now.toISOString(),
        expiresAt: expires.toISOString()
      });

      const regPath = createTempJsonFile(registry);
      const manPath = createTempJsonFile(manifest);
      const quarPath = createTempJsonFile(quarantine);

      const result = runCheck(regPath, manPath, quarPath);
      assert.strictEqual(result.status, 1);
      assert.ok(result.stderr.includes("WAIVER_UNUSED"));
    }
  });

  it("makes all required operational surfaces accountable without changing command coverage", () => {
    const expectedSurfaceIds = [
      "local-identity-joined-player-load",
      "cross-host-identity-joined-player-load",
      "reconnect-command-id-continuity",
      "slow-consumer-backpressure-isolation",
      "malformed-client-isolation",
      "teardown-resource-leak-proof",
    ];

    // The checked-in registry is the success case: all six required obligations are named,
    // concrete evidence is present where available, and command accounting stays manifest-derived.
    {
      const registry = structuredClone(realRegistry);
      const manifest = structuredClone(realManifest);
      const quarantine = structuredClone(realQuarantine);

      assert.deepEqual(
        registry.operationalSurfaces.map((surface) => surface.id).sort(),
        [...expectedSurfaceIds].sort(),
      );
      assert.ok(registry.operationalSurfaces.every((surface) => surface.required === true));

      const regPath = createTempJsonFile(registry);
      const manPath = createTempJsonFile(manifest);
      const quarPath = createTempJsonFile(quarantine);
      const result = runCheck(regPath, manPath, quarPath);

      assert.strictEqual(result.status, 0);
      assert.ok(result.stdout.includes(`Coverage registry OK: ${manifestCounts.total}/${manifestCounts.total} commands tracked`));
      assert.ok(result.stdout.includes(`${manifestCounts.production}/${manifestCounts.production} production, ${manifestCounts.debug}/${manifestCounts.debug} debug-only`));
      assert.ok(result.stdout.includes("operational evidence 6/6, operational debt 0"));
    }

    // A required runtime claim cannot be discharged by an unknown evidence type or a
    // source-test path which does not resolve to a checked-in test surface.
    {
      const registry = structuredClone(realRegistry);
      const manifest = structuredClone(realManifest);
      const quarantine = structuredClone(realQuarantine);
      const surface = registry.operationalSurfaces.find((entry) => entry.id === "local-identity-joined-player-load");
      assert.ok(surface);
      surface.evidence = [{ type: "unrecognized", path: "tools/verification/coverage/check.test.mjs" }];

      const regPath = createTempJsonFile(registry);
      const manPath = createTempJsonFile(manifest);
      const quarPath = createTempJsonFile(quarantine);
      const result = runCheck(regPath, manPath, quarPath);

      assert.strictEqual(result.status, 1);
      assert.ok(result.stderr.includes("OP_EVIDENCE_TYPE"));
      assert.ok(result.stderr.includes("OP_SURFACE_UNCOVERED"));
    }
    {
      const registry = structuredClone(realRegistry);
      const manifest = structuredClone(realManifest);
      const quarantine = structuredClone(realQuarantine);
      const surface = registry.operationalSurfaces.find((entry) => entry.id === "local-identity-joined-player-load");
      assert.ok(surface);
      surface.evidence = [{
        type: "sourceTest",
        path: "tools/verification/coverage/missing-operational-source.test.mjs",
        anchor: "missingOperationalProof",
      }];

      const regPath = createTempJsonFile(registry);
      const manPath = createTempJsonFile(manifest);
      const quarPath = createTempJsonFile(quarantine);
      const result = runCheck(regPath, manPath, quarPath);

      assert.strictEqual(result.status, 1);
      assert.ok(result.stderr.includes("OP_EVIDENCE_SOURCE_TEST"));
      assert.ok(result.stderr.includes("OP_SURFACE_UNCOVERED"));
    }
    {
      const registry = structuredClone(realRegistry);
      const manifest = structuredClone(realManifest);
      const quarantine = structuredClone(realQuarantine);
      const surface = registry.operationalSurfaces.find((entry) => entry.id === "local-identity-joined-player-load");
      assert.ok(surface);
      surface.evidence = [{ type: "tool", path: "tools/verification/coverage/check.mjs" }];

      const regPath = createTempJsonFile(registry);
      const manPath = createTempJsonFile(manifest);
      const quarPath = createTempJsonFile(quarantine);
      const result = runCheck(regPath, manPath, quarPath);

      assert.strictEqual(result.status, 1);
      assert.ok(result.stderr.includes("OP_EVIDENCE_TOOL"));
      assert.ok(result.stderr.includes("OP_SURFACE_UNCOVERED"));
    }


    // References are sets, so the same evidence cannot paper over multiple obligations
    // within the same surface.
    {
      const registry = structuredClone(realRegistry);
      const manifest = structuredClone(realManifest);
      const quarantine = structuredClone(realQuarantine);
      const surface = registry.operationalSurfaces.find((entry) => entry.id === "local-identity-joined-player-load");
      assert.ok(surface);
      surface.evidence.push(structuredClone(surface.evidence[0]));

      const regPath = createTempJsonFile(registry);
      const manPath = createTempJsonFile(manifest);
      const quarPath = createTempJsonFile(quarantine);
      const result = runCheck(regPath, manPath, quarPath);

      assert.strictEqual(result.status, 1);
      assert.ok(result.stderr.includes("OP_EVIDENCE_DUPLICATE"));
    }

    // Operational waivers are bounded and must be consumed by their exact missing surface.
    {
      const registry = structuredClone(realRegistry);
      const manifest = structuredClone(realManifest);
      const quarantine = structuredClone(realQuarantine);
      const waivedSurfaceId = "slow-consumer-backpressure-isolation";
      const surface = registry.operationalSurfaces.find((entry) => entry.id === waivedSurfaceId);
      assert.ok(surface);
      surface.evidence = [];
      registry.operationalWaivers.push({
        id: "expired-operational-waiver",
        surfaceId: waivedSurfaceId,
        owner: "test-owner",
        reason: "Expired test waiver for a deliberately uncovered operational surface.",
        createdAt: "1999-12-18T00:00:00.000Z",
        expiresAt: "2000-01-01T00:00:00.000Z",
      });

      const regPath = createTempJsonFile(registry);
      const manPath = createTempJsonFile(manifest);
      const quarPath = createTempJsonFile(quarantine);
      const result = runCheck(regPath, manPath, quarPath);

      assert.strictEqual(result.status, 1);
      assert.ok(result.stderr.includes("OP_WAIVERS_EXPIRED"));
      assert.ok(result.stderr.includes("OP_SURFACE_UNCOVERED"));
    }
    {
      const registry = structuredClone(realRegistry);
      const manifest = structuredClone(realManifest);
      const quarantine = structuredClone(realQuarantine);
      const waivedSurfaceId = "slow-consumer-backpressure-isolation";
      const surface = registry.operationalSurfaces.find((entry) => entry.id === waivedSurfaceId);
      assert.ok(surface);
      surface.evidence = [];
      const now = new Date();
      registry.operationalWaivers.push({
        id: "mis-scoped-operational-waiver",
        surfaceId: "local-identity-joined-player-load",
        owner: "test-owner",
        reason: "Active test waiver intentionally assigned to the wrong operational surface.",
        createdAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000).toISOString(),
      });

      const regPath = createTempJsonFile(registry);
      const manPath = createTempJsonFile(manifest);
      const quarPath = createTempJsonFile(quarantine);
      const result = runCheck(regPath, manPath, quarPath);

      assert.strictEqual(result.status, 1);
      assert.ok(result.stderr.includes("OP_WAIVERS_UNUSED"));
      assert.ok(result.stderr.includes(`operational:${waivedSurfaceId}`));
      assert.ok(result.stderr.includes("OP_SURFACE_UNCOVERED"));
    }
  });

  it("validates flaky quarantine entries and expiration", () => {
    // 1. Expired quarantine entry
    {
      const registry = structuredClone(realRegistry);
      const manifest = structuredClone(realManifest);
      const quarantine = structuredClone(realQuarantine);

      quarantine.entries.push({
        id: "quar-task-1",
        task: "some-flaky-task",
        owner: "some-owner",
        reason: "This is a detailed description of the observed flake that is over 20 characters.",
        firstSeen: "2026-06-01T00:00:00.000Z",
        expiresAt: "2026-06-15T00:00:00.000Z"
      });

      const regPath = createTempJsonFile(registry);
      const manPath = createTempJsonFile(manifest);
      const quarPath = createTempJsonFile(quarantine);

      const result = runCheck(regPath, manPath, quarPath);
      assert.strictEqual(result.status, 1);
      assert.ok(result.stderr.includes("QUARANTINE_EXPIRED"));
    }

    // 2. Invalid quarantine entry metadata (short owner / short reason / wrong dates)
    {
      const registry = structuredClone(realRegistry);
      const manifest = structuredClone(realManifest);
      const quarantine = structuredClone(realQuarantine);

      quarantine.entries.push({
        id: "quar-task-2",
        task: "some-task",
        owner: "ab",
        reason: "too short",
        firstSeen: "invalid-date",
        expiresAt: "invalid-date"
      });

      const regPath = createTempJsonFile(registry);
      const manPath = createTempJsonFile(manifest);
      const quarPath = createTempJsonFile(quarantine);

      const result = runCheck(regPath, manPath, quarPath);
      assert.strictEqual(result.status, 1);
      assert.ok(result.stderr.includes("QUARANTINE_OWNER"));
      assert.ok(result.stderr.includes("QUARANTINE_REASON"));
      assert.ok(result.stderr.includes("QUARANTINE_FIRST_SEEN"));
      assert.ok(result.stderr.includes("QUARANTINE_EXPIRES_AT"));
    }
  });

  it("ensures diagnostics are printed in deterministic sorted order and command exits non-zero on error", () => {
    const registry = structuredClone(realRegistry);
    const manifest = structuredClone(realManifest);
    const quarantine = structuredClone(realQuarantine);

    registry.commands[0].debugOnly = "not-a-boolean";
    const waiver = appendTestWaiver(registry);
    waiver.owner = "tbd";

    const regPath = createTempJsonFile(registry);
    const manPath = createTempJsonFile(manifest);
    const quarPath = createTempJsonFile(quarantine);

    const result = runCheck(regPath, manPath, quarPath);
    assert.strictEqual(result.status, 1);

    const lines = result.stderr.split("\n")
      .filter(line => line.startsWith("- "))
      .map(line => line.trim());

    const sortedLines = [...lines].sort();
    assert.deepEqual(lines, sortedLines);
  });

  it("validates the package wiring order in package.json", () => {
    const pkgPath = path.resolve(repoRoot, "package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
    const ciScript = pkg.scripts?.ci || "";

    assert.ok(ciScript.includes("check:commands"));
    assert.ok(ciScript.includes("check:coverage"));

    const checkCommandsIndex = ciScript.indexOf("check:commands");
    const checkCoverageIndex = ciScript.indexOf("check:coverage");

    assert.ok(checkCommandsIndex > -1);
    assert.ok(checkCoverageIndex > -1);
    assert.ok(checkCommandsIndex < checkCoverageIndex);
  });
});
