#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..", "..", "..");
const defaultRegistryPath = path.join(scriptDir, "coverage-map.json");
const defaultManifestPath = path.join(repoRoot, "tools", "codegen", "generated", "successor.commands.manifest.v1.json");
const defaultQuarantinePath = path.join(repoRoot, "verification", "flaky-quarantine.json");
const tuiJourneyRoot = path.join(repoRoot, "client-tui", "journeys", "journeys");
const tuiRunnerPath = path.join(repoRoot, "client-tui", "journeys", "runner.mjs");
const client3dJourneyRoot = path.join(repoRoot, "tools", "verification", "client3d", "journeys");
const client3dJourneyIndexPath = path.join(client3dJourneyRoot, "index.mjs");
const tuiJourneyPrefix = "client-tui/journeys/journeys/";
const client3dJourneyPrefix = "tools/verification/client3d/journeys/";
const scenarioRoot = path.join(repoRoot, "tools", "verification", "scenario", "scenarios");
const expectedRegistrySchema = "successor.coverage-registry.v1";
const expectedManifestSchema = "successor.commands.manifest.v1";
const expectedQuarantineSchema = "successor.flaky-quarantine.v1";
const waiverWindowMs = 14 * 24 * 60 * 60 * 1000;
const requirementNames = new Set([
  "coverage",
  "multiplayerScenario",
  "restartScenario",
  "raceScenario",
  "browserJourney",
]);
const expectedOperationalSurfaceIds = [
  "local-identity-joined-player-load",
  "cross-host-identity-joined-player-load",
  "reconnect-command-id-continuity",
  "slow-consumer-backpressure-isolation",
  "malformed-client-isolation",
  "teardown-resource-leak-proof",
];
const operationalEvidenceTypes = new Set(["sourceTest", "scenario", "tool"]);
const expectedSystemIds = [
  "combat_roll",
  "crafting",
  "duels",
  "exchange",
  "extraction",
  "farming_land",
  "groups",
  "inventory_stacks",
  "guilds",
  "loot",
  "movement",
  "profession_training",
  "resource_economy",
  "splice_bioengineer",
  "trade",
  "travel_doors",
  "vitals_status",
];

await main();

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printUsage();
    return;
  }

  const inputDiagnostics = [];
  const registry = readJson(options.registryPath, "registry", inputDiagnostics);
  const manifest = readJson(options.manifestPath, "manifest", inputDiagnostics);
  const quarantine = readJson(options.quarantinePath, "quarantine", inputDiagnostics);
  if (inputDiagnostics.length > 0) {
    printFailures(inputDiagnostics);
    process.exitCode = 1;
    return;
  }

  const scenarioDiscovery = discoverScenarios();
  const journeyDiscovery = await discoverBrowserJourneys();
  const validation = validateAll({
    registry,
    manifest,
    quarantine,
    scenarios: scenarioDiscovery.scenarios,
    discoveryDiagnostics: [...scenarioDiscovery.diagnostics, ...journeyDiscovery.diagnostics],
    browserJourneys: journeyDiscovery.browserJourneys,
    now: new Date(),
  });
  if (validation.diagnostics.length > 0) {
    printFailures(validation.diagnostics);
    process.exitCode = 1;
    return;
  }

  if (options.selfTest) {
    runSelfTest({
      registry,
      manifest,
      quarantine,
      scenarios: scenarioDiscovery.scenarios,
      browserJourneys: journeyDiscovery.browserJourneys,
    });
    return;
  }

  printSuccess(validation.summary);
}

/*
 * Keep browser evidence tied to the loaders that actually execute it. The
 * client-3D index is the explicit registry, while the TUI runner's loader is
 * the authority for its directory (including its filename-derived IDs).
 */
async function discoverBrowserJourneys() {
  const diagnostics = [];
  const browserJourneys = {
    tui: new Set(),
    client3d: new Set(),
  };
  try {
    const { loadJourneys } = await import(pathToFileURL(tuiRunnerPath).href);
    const loaded = await loadJourneys({ journeyDir: tuiJourneyRoot });
    for (const journey of loaded) {
      if (typeof journey.run !== "function") continue;
      browserJourneys.tui.add(path.posix.join(tuiJourneyPrefix, journey.file));
    }
  } catch (error) {
    diagnostics.push(diag("TUI_JOURNEY_LOAD", tuiRunnerPath, `TUI runner could not load journeys: ${error.message}`));
  }
  try {
    const source = fs.readFileSync(client3dJourneyIndexPath, "utf8");
    const indexModule = await import(`${pathToFileURL(client3dJourneyIndexPath).href}?coverage-check`);
    const exportedIds = new Set(
      Array.isArray(indexModule.journeys)
        ? indexModule.journeys.map((journey) => journey?.id).filter((id) => typeof id === "string")
        : [],
    );
    const importedFiles = new Map();
    for (const match of source.matchAll(/^\s*import\s+([A-Za-z_$][\w$]*)\s+from\s+["']\.\/([^"']+\.mjs)["'];?\s*$/gmu)) {
      importedFiles.set(match[1], match[2]);
    }
    const journeyArray = source.match(/export\s+const\s+journeys\s*=\s*\[([\s\S]*?)\]\s*;/u)?.[1] ?? "";
    for (const localName of journeyArray.matchAll(/\b([A-Za-z_$][\w$]*)\b/gu)) {
      const fileName = importedFiles.get(localName[1]);
      if (!fileName) continue;
      const journeyModule = await import(pathToFileURL(path.join(client3dJourneyRoot, fileName)).href);
      if (exportedIds.has(journeyModule.default?.id)) {
        browserJourneys.client3d.add(path.posix.join(client3dJourneyPrefix, fileName));
      }
    }
  } catch (error) {
    diagnostics.push(diag("CLIENT3D_JOURNEY_LOAD", client3dJourneyIndexPath, `client-3D journey index could not load journeys: ${error.message}`));
  }
  return { diagnostics, browserJourneys };
}

function parseArgs(args) {
  const parsed = {
    registryPath: defaultRegistryPath,
    manifestPath: defaultManifestPath,
    quarantinePath: defaultQuarantinePath,
    selfTest: false,
    help: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") continue;
    if (arg === "--registry") {
      parsed.registryPath = resolveInputPath(requiredValue(args, ++index, arg));
    } else if (arg === "--manifest") {
      parsed.manifestPath = resolveInputPath(requiredValue(args, ++index, arg));
    } else if (arg === "--quarantine") {
      parsed.quarantinePath = resolveInputPath(requiredValue(args, ++index, arg));
    } else if (arg === "--self-test") {
      parsed.selfTest = true;
    } else if (arg === "--help" || arg === "-h") {
      parsed.help = true;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return parsed;
}

function requiredValue(args, index, flag) {
  const value = args[index];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a path`);
  return value;
}

function resolveInputPath(value) {
  return path.isAbsolute(value) ? value : path.resolve(repoRoot, value);
}

function printUsage() {
  console.log(`Usage: node tools/verification/coverage/check.mjs [options]\n\nOptions:\n  --registry <path>    Validate another registry copy; refs still resolve from repo root\n  --manifest <path>    Validate against another command manifest copy\n  --quarantine <path>  Validate another flaky-quarantine copy\n  --self-test          Exercise unknown-command, missing-ref, and expired-waiver failures in memory\n  -h, --help           Show this help`);
}

function readJson(filePath, label, diagnostics) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    diagnostics.push(diag("JSON_READ", label, `${relativeOrAbsolute(filePath)}: ${error.message}`));
    return null;
  }
}

function discoverScenarios() {
  const diagnostics = [];
  const scenarios = new Map();
  let files = [];
  try {
    files = walkFiles(scenarioRoot).filter((filePath) => filePath.endsWith(".scenario.json"));
  } catch (error) {
    diagnostics.push(diag("SCENARIO_DISCOVERY", "scenarios", error.message));
    return { diagnostics, scenarios };
  }
  for (const filePath of files.sort()) {
    let scenario;
    try {
      scenario = JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch (error) {
      diagnostics.push(diag("SCENARIO_JSON", relativeRepoPath(filePath), error.message));
      continue;
    }
    const name = scenario?.name;
    if (typeof name !== "string" || name.trim() === "") {
      diagnostics.push(diag("SCENARIO_NAME", relativeRepoPath(filePath), "scenario must have a non-empty name"));
      continue;
    }
    if (scenarios.has(name)) {
      diagnostics.push(diag("SCENARIO_DUPLICATE", `scenario:${name}`, `also declared by ${relativeRepoPath(filePath)}`));
      continue;
    }
    const actorCount = isPlainObject(scenario.actors) ? Object.keys(scenario.actors).length : 0;
    const tags = Array.isArray(scenario.tags) ? scenario.tags : [];
    const lanes = Array.isArray(scenario.lanes) ? scenario.lanes : [];
    const relativePath = relativeRepoPath(filePath);
    scenarios.set(name, {
      name,
      path: relativePath,
      source: fs.readFileSync(filePath, "utf8"),
      commandActors: collectCommandActors(scenario.steps),
      multiplayer: actorCount >= 2,
      restart: scenario.persistence === true && containsKeyDeep(scenario.steps, "restart"),
      race: tags.includes("race") || lanes.includes("race") || relativePath.includes("/races/"),
    });
  }
  return { diagnostics, scenarios };
}

function walkFiles(directory) {
  const files = [];
  const entries = fs.readdirSync(directory, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walkFiles(entryPath));
    else if (entry.isFile()) files.push(entryPath);
  }
  return files;
}

function collectCommandActors(steps) {
  const commandActors = new Map();
  const visit = (value) => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!isPlainObject(value)) return;
    if (isPlainObject(value.command) && typeof value.command.actor === "string" && isPlainObject(value.command.body)) {
      for (const kind of Object.keys(value.command.body)) {
        const actors = commandActors.get(kind) ?? new Set();
        actors.add(value.command.actor);
        commandActors.set(kind, actors);
      }
    }
    Object.values(value).forEach(visit);
  };
  visit(steps);
  return commandActors;
}

function hasScopedMultiplayerContention(scenarios, commandKinds) {
  return scenarios.some((scenario) => {
    if (!scenario.multiplayer) return false;
    const actors = new Set();
    for (const kind of commandKinds) {
      const commandActors = scenario.commandActors.get(kind);
      if (!commandActors || commandActors.size === 0) return false;
      commandActors.forEach((actor) => actors.add(actor));
    }
    return actors.size >= 2;
  });
}

function containsKeyDeep(value, key) {
  if (Array.isArray(value)) return value.some((entry) => containsKeyDeep(entry, key));
  if (!isPlainObject(value)) return false;
  if (Object.hasOwn(value, key)) return true;
  return Object.values(value).some((entry) => containsKeyDeep(entry, key));
}

function validateAll({ registry, manifest, quarantine, scenarios, discoveryDiagnostics = [], browserJourneys, now }) {
  const diagnostics = [...discoveryDiagnostics];
  const manifestState = validateManifest(manifest, diagnostics);
  const registryState = validateRegistry(registry, manifestState, scenarios, browserJourneys, now, diagnostics);
  const quarantineState = validateQuarantine(quarantine, now, diagnostics);
  return {
    diagnostics: sortDiagnostics(diagnostics),
    summary: {
      manifestCommands: manifestState.commands.size,
      productionCommands: manifestState.productionCount,
      debugCommands: manifestState.debugCount,
      trackedCommands: registryState.trackedCount,
      referencedCommands: registryState.referencedCount,
      referencedProductionCommands: registryState.referencedProductionCount,
      referencedDebugCommands: registryState.referencedDebugCount,
      coverageWaivers: registryState.coverageWaiverCount,
      propertyWaivers: registryState.propertyWaiverCount,
      operationalSurfaceCount: registryState.operationalSurfaceCount,
      operationalEvidenceCount: registryState.operationalEvidenceCount,
      operationalWaivers: registryState.operationalWaiverCount,
      systems: registryState.systemIds,
      activeWaivers: registryState.activeWaiverCount,
      quarantinedTasks: quarantineState.activeCount,
    },
  };
}

function validateManifest(manifest, diagnostics) {
  const commands = new Map();
  let productionCount = 0;
  let debugCount = 0;
  if (!isPlainObject(manifest)) {
    diagnostics.push(diag("MANIFEST_SHAPE", "manifest", "manifest must be an object"));
    return { commands, productionCount, debugCount, commandCount: 0 };
  }
  if (manifest.schema !== expectedManifestSchema) {
    diagnostics.push(diag("MANIFEST_SCHEMA", "manifest.schema", `expected ${expectedManifestSchema}, got ${render(manifest.schema)}`));
  }
  if (!Array.isArray(manifest.commands)) {
    diagnostics.push(diag("MANIFEST_COMMANDS", "manifest.commands", "commands must be an array"));
    return { commands, productionCount, debugCount, commandCount: 0 };
  }
  const manifestCommandCount = manifest.commands.length;
  if (manifest.commandCount !== manifestCommandCount) {
    diagnostics.push(diag("MANIFEST_DECLARED_COUNT", "manifest.commandCount", `declares ${render(manifest.commandCount)} but contains ${manifestCommandCount}`));
  }
  const manifestProductionCount = manifest.commands.filter((command) => command?.debugGated !== true).length;
  const manifestDebugCount = manifest.commands.filter((command) => command?.debugGated === true).length;
  manifest.commands.forEach((command, index) => {
    const location = `manifest.commands[${index}]`;
    if (!isPlainObject(command) || typeof command.kind !== "string" || command.kind.trim() === "") {
      diagnostics.push(diag("MANIFEST_COMMAND_KIND", location, "command kind must be a non-empty string"));
      return;
    }
    if (commands.has(command.kind)) {
      diagnostics.push(diag("MANIFEST_COMMAND_DUPLICATE", `command:${command.kind}`, "command kind appears more than once in the manifest"));
      return;
    }
    if (typeof command.debugGated !== "boolean") {
      diagnostics.push(diag("MANIFEST_DEBUG_FLAG", `command:${command.kind}`, "debugGated must be boolean"));
    }
    const debugOnly = command.debugGated === true;
    if (debugOnly) debugCount += 1;
    else productionCount += 1;
    commands.set(command.kind, { debugOnly });
  });
  if (productionCount !== manifestProductionCount) {
    diagnostics.push(diag("MANIFEST_PRODUCTION_COUNT", "manifest.commands", `manifest declares ${manifestProductionCount} production commands, got ${productionCount}`));
  }
  if (debugCount !== manifestDebugCount) {
    diagnostics.push(diag("MANIFEST_DEBUG_COUNT", "manifest.commands", `manifest declares ${manifestDebugCount} debug-gated commands, got ${debugCount}`));
  }
  if (manifest.debugGatedCount !== manifestDebugCount) {
    diagnostics.push(diag("MANIFEST_DEBUG_COUNT", "manifest.debugGatedCount", `declares ${render(manifest.debugGatedCount)} debug-gated commands, but command entries classify ${debugCount}`));
  }
  return { commands, productionCount, debugCount, commandCount: manifestCommandCount };
}

function validateRegistry(registry, manifestState, scenarios, browserJourneys, now, diagnostics) {
  const systems = new Map();
  const commandEntries = new Map();
  const validScenarioRefsBySystem = new Map();
  const validBrowserRefsBySystem = new Map();
  const activeWaivers = new Map();
  const consumedWaivers = new Set();
  let referencedCount = 0;
  let referencedProductionCount = 0;
  let referencedDebugCount = 0;

  if (!isPlainObject(registry)) {
    diagnostics.push(diag("REGISTRY_SHAPE", "registry", "registry must be an object"));
    return { trackedCount: 0, referencedCount, referencedProductionCount, referencedDebugCount, systemIds: [], activeWaiverCount: 0, coverageWaiverCount: 0, propertyWaiverCount: 0, operationalSurfaceCount: 0, operationalEvidenceCount: 0, operationalWaiverCount: 0 };
  }
  if (registry.schema !== expectedRegistrySchema) {
    diagnostics.push(diag("REGISTRY_SCHEMA", "registry.schema", `expected ${expectedRegistrySchema}, got ${render(registry.schema)}`));
  }
  const expectedManifestPath = relativeRepoPath(defaultManifestPath);
  if (registry.commandManifest !== expectedManifestPath) {
    diagnostics.push(diag("REGISTRY_MANIFEST_PATH", "registry.commandManifest", `expected repo-relative authority path ${expectedManifestPath}`));
  }

  if (!Array.isArray(registry.systems)) {
    diagnostics.push(diag("SYSTEMS_SHAPE", "registry.systems", "systems must be an array"));
  } else {
    if (registry.systems.length !== expectedSystemIds.length) {
      diagnostics.push(diag("SYSTEM_COUNT", "registry.systems", `expected ${expectedSystemIds.length} systems, got ${registry.systems.length}`));
    }
    registry.systems.forEach((system, index) => {
      const location = `registry.systems[${index}]`;
      if (!isPlainObject(system) || typeof system.id !== "string" || system.id.trim() === "") {
        diagnostics.push(diag("SYSTEM_ID", location, "system id must be a non-empty string"));
        return;
      }
      if (systems.has(system.id)) {
        diagnostics.push(diag("SYSTEM_DUPLICATE", `system:${system.id}`, "system appears more than once"));
        return;
      }
      if (!expectedSystemIds.includes(system.id)) {
        diagnostics.push(diag("SYSTEM_UNKNOWN", `system:${system.id}`, "system is not one of the 18 command-coverage systems"));
      }
      systems.set(system.id, system);
      validateProperties(system, diagnostics);
      const validScenarioRefs = validateScenarioRefs(system.scenarioRefs, `system:${system.id}.scenarioRefs`, scenarios, diagnostics);
      const validTuiRefs = validateJourneyFileRefs(system.tuiJourneys, `system:${system.id}.tuiJourneys`, tuiJourneyPrefix, browserJourneys?.tui, "TUI runner", diagnostics);
      const validClient3dRefs = validateJourneyFileRefs(system.client3dJourneys, `system:${system.id}.client3dJourneys`, client3dJourneyPrefix, browserJourneys?.client3d, "client-3D journey index", diagnostics);
      validScenarioRefsBySystem.set(system.id, validScenarioRefs);
      validBrowserRefsBySystem.set(system.id, validTuiRefs.length + validClient3dRefs.length);
    });
  }
  for (const systemId of expectedSystemIds) {
    if (!systems.has(systemId)) diagnostics.push(diag("SYSTEM_MISSING", `system:${systemId}`, "required coverage system is missing"));
  }

  if (!Array.isArray(registry.commands)) {
    diagnostics.push(diag("COMMANDS_SHAPE", "registry.commands", "commands must be an array so duplicates remain detectable"));
  } else {
    if (registry.commands.length !== manifestState.commandCount) {
      diagnostics.push(diag("COMMAND_COUNT", "registry.commands", `expected ${manifestState.commandCount} command mappings from the generated manifest, got ${registry.commands.length}`));
    }
    registry.commands.forEach((entry, index) => {
      const location = `registry.commands[${index}]`;
      if (!isPlainObject(entry) || typeof entry.kind !== "string" || entry.kind.trim() === "") {
        diagnostics.push(diag("COMMAND_KIND", location, "kind must be a non-empty string"));
        return;
      }
      if (commandEntries.has(entry.kind)) {
        diagnostics.push(diag("COMMAND_DUPLICATE", `command:${entry.kind}`, "command appears more than once in the registry"));
        return;
      }
      commandEntries.set(entry.kind, entry);
      const manifestCommand = manifestState.commands.get(entry.kind);
      if (!manifestCommand) {
        diagnostics.push(diag("COMMAND_UNKNOWN", `command:${entry.kind}`, "command is not present in the generated authority manifest"));
      }
      if (typeof entry.systemId !== "string" || !systems.has(entry.systemId)) {
        diagnostics.push(diag("COMMAND_SYSTEM", `command:${entry.kind}`, `unknown system membership ${render(entry.systemId)}`));
      }
      if (typeof entry.debugOnly !== "boolean") {
        diagnostics.push(diag("COMMAND_DEBUG_FLAG", `command:${entry.kind}`, "debugOnly must be boolean"));
      } else if (manifestCommand && entry.debugOnly !== manifestCommand.debugOnly) {
        diagnostics.push(diag("COMMAND_DEBUG_MISMATCH", `command:${entry.kind}`, `registry debugOnly=${entry.debugOnly} does not match manifest debugGated=${manifestCommand.debugOnly}`));
      }
      if (!isPlainObject(entry.refs)) {
        diagnostics.push(diag("COMMAND_REFS", `command:${entry.kind}`, "refs must be an object with files and scenarios arrays"));
        return;
      }
      const validFiles = validateCoverageFileRefs(entry.refs.files, `command:${entry.kind}.refs.files`, entry.kind, diagnostics);
      const validScenarios = validateCommandScenarioRefs(entry.refs.scenarios, `command:${entry.kind}.refs.scenarios`, scenarios, entry.kind, diagnostics);
      entry.__validReferenceCount = validFiles.length + validScenarios.length;
    });
  }
  for (const kind of manifestState.commands.keys()) {
    if (!commandEntries.has(kind)) diagnostics.push(diag("COMMAND_MISSING", `command:${kind}`, "manifest command has no registry mapping"));
  }
  for (const systemId of expectedSystemIds) {
    const ownsProductionCommand = [...commandEntries.values()].some((entry) => (
      entry.systemId === systemId && manifestState.commands.get(entry.kind)?.debugOnly === false
    ));
    if (!ownsProductionCommand) diagnostics.push(diag("SYSTEM_EMPTY", `system:${systemId}`, "system must own at least one production command"));
  }

  validateWaivers(registry.waivers, systems, commandEntries, now, diagnostics, activeWaivers);

  for (const [kind, entry] of commandEntries) {
    if (entry.__validReferenceCount > 0) {
      referencedCount += 1;
      if (manifestState.commands.get(kind)?.debugOnly === true) referencedDebugCount += 1;
      else if (manifestState.commands.has(kind)) referencedProductionCount += 1;
      continue;
    }
    const waiver = activeWaivers.get(waiverKey(entry.systemId, "coverage", kind));
    if (waiver) consumedWaivers.add(waiver.id);
    else diagnostics.push(diag("COMMAND_UNCOVERED", `command:${kind}`, "command needs at least one existing file/scenario ref or an active coverage waiver"));
  }

  for (const [systemId, system] of systems) {
    if (!isPlainObject(system.properties)) continue;
    const scenarioRefs = validScenarioRefsBySystem.get(systemId) ?? [];
    const multiplayerWaiver = activeWaivers.get(waiverKey(systemId, "multiplayerScenario"));
    const hasMultiplayerScenario = multiplayerWaiver && Array.isArray(multiplayerWaiver.scope.commandKinds)
      ? hasScopedMultiplayerContention(scenarioRefs, multiplayerWaiver.scope.commandKinds)
      : scenarioRefs.some((scenario) => scenario.multiplayer);
    if (system.properties.multiplayerNeed === "high" && !hasMultiplayerScenario) {
      consumePropertyWaiver(systemId, "multiplayerScenario", activeWaivers, consumedWaivers, diagnostics, "multiplayerNeed=high requires a referenced scenario with at least two actors");
    }
    if (system.properties.persistenceNeed === true && !scenarioRefs.some((scenario) => scenario.restart)) {
      consumePropertyWaiver(systemId, "restartScenario", activeWaivers, consumedWaivers, diagnostics, "persistenceNeed=true requires a referenced persistence scenario containing a restart step");
    }
    if (system.properties.realTimeRace === "high" && !scenarioRefs.some((scenario) => scenario.race)) {
      consumePropertyWaiver(systemId, "raceScenario", activeWaivers, consumedWaivers, diagnostics, "realTimeRace=high requires a referenced race-tagged/race-lane scenario");
    }
    if (system.properties.browserVisible === true && (validBrowserRefsBySystem.get(systemId) ?? 0) === 0) {
      consumePropertyWaiver(systemId, "browserJourney", activeWaivers, consumedWaivers, diagnostics, "browserVisible=true requires an existing TUI or client-3d journey file");
    }
  }
  const operationalState = validateOperationalSurfaces(registry.operationalSurfaces, registry.operationalWaivers, scenarios, now, diagnostics);

  for (const waiver of activeWaivers.values()) {
    if (!consumedWaivers.has(waiver.id)) {
      diagnostics.push(diag("WAIVER_UNUSED", `waiver:${waiver.id}`, "active waiver does not correspond to a current coverage/property gap"));
    }
  }

  const coverageWaiverCount = [...activeWaivers.values()].filter((waiver) => waiver.scope.requirement === "coverage").length;
  const propertyWaiverCount = activeWaivers.size - coverageWaiverCount;
  for (const entry of commandEntries.values()) delete entry.__validReferenceCount;
  return {
    trackedCount: [...commandEntries.keys()].filter((kind) => manifestState.commands.has(kind)).length,
    referencedCount,
    referencedProductionCount,
    referencedDebugCount,
    systemIds: [...systems.keys()].filter((id) => expectedSystemIds.includes(id)).sort(),
    activeWaiverCount: activeWaivers.size + operationalState.activeWaiverCount,
    coverageWaiverCount,
    propertyWaiverCount,
    operationalSurfaceCount: operationalState.surfaceCount,
    operationalEvidenceCount: operationalState.evidenceCount,
    operationalWaiverCount: operationalState.activeWaiverCount,
  };
}

function validateProperties(system, diagnostics) {
  const location = `system:${system.id}.properties`;
  if (!isPlainObject(system.properties)) {
    diagnostics.push(diag("SYSTEM_PROPERTIES", location, "properties must be an object"));
    return;
  }
  if (!new Set(["high", "medium", "low"]).has(system.properties.realTimeRace)) {
    diagnostics.push(diag("PROPERTY_REAL_TIME_RACE", location, "realTimeRace must be high, medium, or low"));
  }
  if (typeof system.properties.accelLaneEligible !== "boolean") {
    diagnostics.push(diag("PROPERTY_ACCEL", location, "accelLaneEligible must be boolean"));
  }
  if (!new Set(["high", "medium", "low"]).has(system.properties.multiplayerNeed)) {
    diagnostics.push(diag("PROPERTY_MULTIPLAYER", location, "multiplayerNeed must be high, medium, or low"));
  }
  if (typeof system.properties.persistenceNeed !== "boolean") {
    diagnostics.push(diag("PROPERTY_PERSISTENCE", location, "persistenceNeed must be boolean"));
  }
  if (typeof system.properties.browserVisible !== "boolean") {
    diagnostics.push(diag("PROPERTY_BROWSER", location, "browserVisible must be boolean"));
  }
}

function validateOperationalSurfaces(rawSurfaces, rawWaivers, scenarios, now, diagnostics) {
  const surfaces = new Map();
  const seenEvidence = new Set();
  let evidenceCount = 0;
  if (!Array.isArray(rawSurfaces)) {
    diagnostics.push(diag("OP_SURFACES_SHAPE", "registry.operationalSurfaces", "operationalSurfaces must be an array of required operational coverage surfaces"));
  } else {
    if (rawSurfaces.length !== expectedOperationalSurfaceIds.length) {
      diagnostics.push(diag("OP_SURFACES_COUNT", "registry.operationalSurfaces", `expected ${expectedOperationalSurfaceIds.length} operational surfaces, got ${rawSurfaces.length}`));
    }
    for (const [index, surface] of rawSurfaces.entries()) {
      const location = `registry.operationalSurfaces[${index}]`;
      if (!isPlainObject(surface) || typeof surface.id !== "string" || !/^[a-z][a-z0-9-]*$/u.test(surface.id)) {
        diagnostics.push(diag("OP_SURFACE_ID", location, "operational surface id must be a non-empty lowercase hyphenated string"));
        continue;
      }
      if (surfaces.has(surface.id)) {
        diagnostics.push(diag("OP_SURFACE_DUPLICATE", `operational:${surface.id}`, "operational surface appears more than once"));
        continue;
      }
      if (!expectedOperationalSurfaceIds.includes(surface.id)) {
        diagnostics.push(diag("OP_SURFACE_UNKNOWN", `operational:${surface.id}`, "operational surface is not in the required coverage registry"));
      }
      if (surface.required !== true) {
        diagnostics.push(diag("OP_SURFACE_REQUIRED", `operational:${surface.id}`, "operational surface must declare required: true"));
      }
      const validEvidence = validateOperationalEvidence(surface.evidence, `operational:${surface.id}.evidence`, scenarios, seenEvidence, diagnostics);
      evidenceCount += validEvidence;
      surfaces.set(surface.id, { required: surface.required === true, validEvidence });
    }
  }
  for (const surfaceId of expectedOperationalSurfaceIds) {
    if (!surfaces.has(surfaceId)) diagnostics.push(diag("OP_SURFACE_MISSING", `operational:${surfaceId}`, "required operational surface is missing"));
  }

  const activeWaivers = validateOperationalWaivers(rawWaivers, surfaces, now, diagnostics);
  const consumedWaivers = new Set();
  for (const surfaceId of expectedOperationalSurfaceIds) {
    const surface = surfaces.get(surfaceId);
    if (!surface || !surface.required) continue;
    if (surface.validEvidence > 0) continue;
    const waiver = activeWaivers.get(surfaceId);
    if (waiver) consumedWaivers.add(waiver.id);
    else diagnostics.push(diag("OP_SURFACE_UNCOVERED", `operational:${surfaceId}`, "required operational surface needs validated evidence or an active expiring waiver"));
  }
  for (const [surfaceId, waiver] of activeWaivers) {
    const surface = surfaces.get(surfaceId);
    if (!consumedWaivers.has(waiver.id) && surface?.required === true && surface.validEvidence > 0) {
      diagnostics.push(diag("OP_WAIVERS_UNUSED", `operational:${surfaceId}`, "active operational waiver does not correspond to a current evidence gap"));
    }
  }
  return { surfaceCount: expectedOperationalSurfaceIds.filter((id) => surfaces.has(id)).length, evidenceCount, activeWaiverCount: activeWaivers.size };
}

function validateOperationalEvidence(rawEvidence, location, scenarios, seenEvidence, diagnostics) {
  if (!Array.isArray(rawEvidence)) {
    diagnostics.push(diag("OP_EVIDENCE_SHAPE", location, "evidence must be an array of typed sourceTest, scenario, or tool references"));
    return 0;
  }
  let valid = 0;
  for (const [index, evidence] of rawEvidence.entries()) {
    const evidenceLocation = `${location}[${index}]`;
    if (!isPlainObject(evidence)) {
      diagnostics.push(diag("OP_EVIDENCE_SHAPE", evidenceLocation, "operational evidence must be an object"));
      continue;
    }
    if (!operationalEvidenceTypes.has(evidence.type)) {
      diagnostics.push(diag("OP_EVIDENCE_TYPE", evidenceLocation, `unsupported operational evidence type ${render(evidence.type)}`));
      continue;
    }
    const key = operationalEvidenceKey(evidence);
    if (seenEvidence.has(key)) {
      diagnostics.push(diag("OP_EVIDENCE_DUPLICATE", evidenceLocation, "operational evidence ref appears more than once"));
      continue;
    }
    seenEvidence.add(key);
    if (evidence.type === "sourceTest") {
      if (validateOperationalSourceTest(evidence, evidenceLocation, diagnostics)) valid += 1;
    } else if (evidence.type === "scenario") {
      if (typeof evidence.name !== "string" || evidence.name.trim() === "" || !scenarios.has(evidence.name)) {
        diagnostics.push(diag("OP_EVIDENCE_SCENARIO", evidenceLocation, "scenario evidence must name a declared checked-in scenario"));
      } else {
        valid += 1;
      }
    } else if (validateOperationalTool(evidence, evidenceLocation, diagnostics)) {
      valid += 1;
    }
  }
  return valid;
}

function operationalEvidenceKey(evidence) {
  if (evidence.type === "scenario") return `scenario\u0000${evidence.name ?? ""}`;
  return `${evidence.type}\u0000${evidence.path ?? ""}\u0000${evidence.anchor ?? ""}\u0000${evidence.invocation ?? ""}`;
}

function validateOperationalSourceTest(evidence, location, diagnostics) {
  if (typeof evidence.path !== "string" || evidence.path.trim() === "" || typeof evidence.anchor !== "string" || evidence.anchor.trim().length < 4) {
    diagnostics.push(diag("OP_EVIDENCE_SOURCE_TEST", location, "sourceTest evidence needs a dedicated test path and a non-empty test anchor"));
    return false;
  }
  const source = readOperationalEvidenceSource(evidence.path, location, "OP_EVIDENCE_SOURCE_TEST", diagnostics);
  if (source === null) return false;
  if (!isDedicatedTestPath(evidence.path) || !source.includes(evidence.anchor)) {
    diagnostics.push(diag("OP_EVIDENCE_SOURCE_TEST", location, "sourceTest evidence must resolve to a dedicated checked-in test with its declared anchor"));
    return false;
  }
  return true;
}

function validateOperationalTool(evidence, location, diagnostics) {
  if (typeof evidence.path !== "string" || evidence.path.trim() === "" || typeof evidence.anchor !== "string" || evidence.anchor.trim().length < 4 || typeof evidence.invocation !== "string" || evidence.invocation.trim().length < 4) {
    diagnostics.push(diag("OP_EVIDENCE_TOOL", location, "tool evidence needs a checked-in tool path, source anchor, and invocation"));
    return false;
  }
  const source = readOperationalEvidenceSource(evidence.path, location, "OP_EVIDENCE_TOOL", diagnostics);
  if (source === null) return false;
  if (!evidence.path.startsWith("tools/") || !source.includes(evidence.anchor)) {
    diagnostics.push(diag("OP_EVIDENCE_TOOL", location, "tool evidence must resolve to an anchored checked-in tool under tools/"));
    return false;
  }
  return true;
}

function readOperationalEvidenceSource(ref, location, code, diagnostics) {
  if (path.isAbsolute(ref) || ref.includes("\\")) {
    diagnostics.push(diag(code, location, "evidence path must use repo-relative POSIX separators"));
    return null;
  }
  const resolved = path.resolve(repoRoot, ref);
  const relative = path.relative(repoRoot, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    diagnostics.push(diag(code, location, "evidence path resolves outside the repository"));
    return null;
  }
  try {
    if (!fs.statSync(resolved).isFile()) throw new Error("not a file");
    return fs.readFileSync(resolved, "utf8");
  } catch {
    diagnostics.push(diag(code, location, "evidence path does not resolve to a checked-in file"));
    return null;
  }
}

function validateOperationalWaivers(rawWaivers, surfaces, now, diagnostics) {
  const activeWaivers = new Map();
  if (!Array.isArray(rawWaivers)) {
    diagnostics.push(diag("OP_WAIVERS_SHAPE", "registry.operationalWaivers", "operationalWaivers must be an array"));
    return activeWaivers;
  }
  const ids = new Set();
  for (const [index, waiver] of rawWaivers.entries()) {
    const location = `registry.operationalWaivers[${index}]`;
    if (!isPlainObject(waiver)) {
      diagnostics.push(diag("OP_WAIVER_SHAPE", location, "operational waiver must be an object"));
      continue;
    }
    const waiverLocation = typeof waiver.surfaceId === "string" ? `operational:${waiver.surfaceId}` : location;
    if (typeof waiver.id !== "string" || !/^[a-z][a-z0-9-]*$/u.test(waiver.id)) diagnostics.push(diag("OP_WAIVER_ID", waiverLocation, "operational waiver id must be a non-empty lowercase hyphenated string"));
    else if (ids.has(waiver.id)) diagnostics.push(diag("OP_WAIVER_DUPLICATE_ID", waiverLocation, "operational waiver id appears more than once"));
    else ids.add(waiver.id);
    if (typeof waiver.owner !== "string" || waiver.owner.trim().length < 3 || /^(tbd|unknown|n\/a)$/iu.test(waiver.owner.trim())) diagnostics.push(diag("OP_WAIVER_OWNER", waiverLocation, "owner must name a concrete owning lane or person"));
    if (typeof waiver.reason !== "string" || waiver.reason.trim().length < 20) diagnostics.push(diag("OP_WAIVER_REASON", waiverLocation, "reason must concretely describe the missing operational surface"));
    const createdAt = canonicalIsoMillis(waiver.createdAt);
    const expiresAt = canonicalIsoMillis(waiver.expiresAt);
    if (createdAt === null) diagnostics.push(diag("OP_WAIVER_CREATED_AT", waiverLocation, "createdAt must be canonical ISO-8601 UTC with milliseconds"));
    if (expiresAt === null) diagnostics.push(diag("OP_WAIVER_EXPIRES_AT", waiverLocation, "expiresAt must be canonical ISO-8601 UTC with milliseconds"));
    if (createdAt !== null && expiresAt !== null && expiresAt - createdAt !== waiverWindowMs) diagnostics.push(diag("OP_WAIVER_WINDOW", waiverLocation, "expiry must be fixed exactly 14 days after createdAt"));
    if (expiresAt !== null && expiresAt <= now.getTime()) diagnostics.push(diag("OP_WAIVERS_EXPIRED", waiverLocation, `expired at ${waiver.expiresAt}`));
    if (typeof waiver.surfaceId !== "string" || !surfaces.has(waiver.surfaceId) || !expectedOperationalSurfaceIds.includes(waiver.surfaceId)) {
      diagnostics.push(diag("OP_WAIVER_SURFACE", waiverLocation, "operational waiver must name an existing required operational surface"));
      continue;
    }
    if (createdAt === null || expiresAt === null || expiresAt - createdAt !== waiverWindowMs || expiresAt <= now.getTime()) continue;
    if (activeWaivers.has(waiver.surfaceId)) diagnostics.push(diag("OP_WAIVER_DUPLICATE_SURFACE", waiverLocation, "operational surface already has an active waiver"));
    else activeWaivers.set(waiver.surfaceId, waiver);
  }
  return activeWaivers;
}

function validateWaivers(rawWaivers, systems, commandEntries, now, diagnostics, activeWaivers) {
  if (!Array.isArray(rawWaivers)) {
    diagnostics.push(diag("WAIVERS_SHAPE", "registry.waivers", "waivers must be an array"));
    return;
  }
  const ids = new Set();
  for (const [index, waiver] of rawWaivers.entries()) {
    const location = `registry.waivers[${index}]`;
    if (!isPlainObject(waiver)) {
      diagnostics.push(diag("WAIVER_SHAPE", location, "waiver must be an object"));
      continue;
    }
    if (typeof waiver.id !== "string" || waiver.id.trim() === "") {
      diagnostics.push(diag("WAIVER_ID", location, "waiver id must be a non-empty string"));
      continue;
    }
    if (ids.has(waiver.id)) diagnostics.push(diag("WAIVER_DUPLICATE_ID", `waiver:${waiver.id}`, "waiver id appears more than once"));
    ids.add(waiver.id);
    if (typeof waiver.owner !== "string" || waiver.owner.trim().length < 3 || /^(tbd|unknown|n\/a)$/iu.test(waiver.owner.trim())) {
      diagnostics.push(diag("WAIVER_OWNER", `waiver:${waiver.id}`, "owner must name a concrete owning lane or person"));
    }
    if (typeof waiver.reason !== "string" || waiver.reason.trim().length < 20) {
      diagnostics.push(diag("WAIVER_REASON", `waiver:${waiver.id}`, "reason must concretely describe the missing surface"));
    }
    const createdAt = canonicalIsoMillis(waiver.createdAt);
    const expiresAt = canonicalIsoMillis(waiver.expiresAt);
    if (createdAt === null) diagnostics.push(diag("WAIVER_CREATED_AT", `waiver:${waiver.id}`, "createdAt must be canonical ISO-8601 UTC with milliseconds"));
    if (expiresAt === null) diagnostics.push(diag("WAIVER_EXPIRES_AT", `waiver:${waiver.id}`, "expiresAt must be canonical ISO-8601 UTC with milliseconds"));
    if (createdAt !== null && expiresAt !== null && expiresAt - createdAt !== waiverWindowMs) {
      diagnostics.push(diag("WAIVER_WINDOW", `waiver:${waiver.id}`, "expiry must be fixed exactly 14 days after createdAt"));
    }
    if (expiresAt !== null && expiresAt <= now.getTime()) {
      diagnostics.push(diag("WAIVER_EXPIRED", `waiver:${waiver.id}`, `expired at ${waiver.expiresAt}`));
    }
    if (!isPlainObject(waiver.scope)) {
      diagnostics.push(diag("WAIVER_SCOPE", `waiver:${waiver.id}`, "scope must be an object"));
      continue;
    }
    const { systemId, requirement, commandKind, commandKinds } = waiver.scope;
    if (typeof systemId !== "string" || !systems.has(systemId)) {
      diagnostics.push(diag("WAIVER_SYSTEM", `waiver:${waiver.id}`, `unknown system ${render(systemId)}`));
    }
    if (!requirementNames.has(requirement)) {
      diagnostics.push(diag("WAIVER_REQUIREMENT", `waiver:${waiver.id}`, `unknown requirement ${render(requirement)}`));
    }
    if (requirement === "coverage") {
      if (typeof commandKind !== "string" || !commandEntries.has(commandKind)) {
        diagnostics.push(diag("WAIVER_COMMAND", `waiver:${waiver.id}`, "coverage waiver must name an existing commandKind"));
      } else if (commandEntries.get(commandKind).systemId !== systemId) {
        diagnostics.push(diag("WAIVER_COMMAND_SYSTEM", `waiver:${waiver.id}`, `${commandKind} is not owned by ${systemId}`));
      }
    } else if (commandKind !== undefined) {
      diagnostics.push(diag("WAIVER_COMMAND_SCOPE", `waiver:${waiver.id}`, "commandKind is only valid for coverage waivers; use commandKinds as explanatory scope"));
    }
    if (commandKinds !== undefined) {
      if (!Array.isArray(commandKinds) || commandKinds.length === 0) {
        diagnostics.push(diag("WAIVER_COMMANDS", `waiver:${waiver.id}`, "commandKinds must be a non-empty array when present"));
      } else {
        for (const kind of commandKinds) {
          if (typeof kind !== "string" || !commandEntries.has(kind)) {
            diagnostics.push(diag("WAIVER_COMMANDS", `waiver:${waiver.id}`, `unknown commandKinds entry ${render(kind)}`));
          } else if (commandEntries.get(kind).systemId !== systemId) {
            diagnostics.push(diag("WAIVER_COMMANDS_SYSTEM", `waiver:${waiver.id}`, `${kind} is not owned by ${systemId}`));
          }
        }
      }
    }
    const structurallyValid = typeof systemId === "string"
      && systems.has(systemId)
      && requirementNames.has(requirement)
      && createdAt !== null
      && expiresAt !== null
      && expiresAt - createdAt === waiverWindowMs
      && expiresAt > now.getTime();
    if (!structurallyValid) continue;
    const key = waiverKey(systemId, requirement, commandKind);
    if (activeWaivers.has(key)) {
      diagnostics.push(diag("WAIVER_DUPLICATE_SCOPE", `waiver:${waiver.id}`, `scope duplicates waiver ${activeWaivers.get(key).id}`));
    } else {
      activeWaivers.set(key, waiver);
    }
  }
}

function consumePropertyWaiver(systemId, requirement, activeWaivers, consumedWaivers, diagnostics, message) {
  const waiver = activeWaivers.get(waiverKey(systemId, requirement));
  if (waiver) consumedWaivers.add(waiver.id);
  else diagnostics.push(diag("PROPERTY_UNCOVERED", `system:${systemId}.${requirement}`, `${message}; add a real reference or a concrete 14-day waiver`));
}

function waiverKey(systemId, requirement, commandKind = "") {
  return `${systemId}\u0000${requirement}\u0000${commandKind ?? ""}`;
}

function validateFileRefs(rawRefs, location, diagnostics) {
  if (!Array.isArray(rawRefs)) {
    diagnostics.push(diag("FILE_REFS_SHAPE", location, "must be an array of repo-relative file paths"));
    return [];
  }
  const valid = [];
  const seen = new Set();
  for (const ref of rawRefs) {
    if (typeof ref !== "string" || ref.trim() === "") {
      diagnostics.push(diag("FILE_REF", location, "file ref must be a non-empty string"));
      continue;
    }
    if (seen.has(ref)) {
      diagnostics.push(diag("FILE_REF_DUPLICATE", `${location}:${ref}`, "file ref appears more than once"));
      continue;
    }
    seen.add(ref);
    if (path.isAbsolute(ref) || ref.includes("\\")) {
      diagnostics.push(diag("FILE_REF_RELATIVE", `${location}:${ref}`, "file ref must use repo-relative POSIX separators"));
      continue;
    }
    const resolved = path.resolve(repoRoot, ref);
    const relative = path.relative(repoRoot, resolved);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      diagnostics.push(diag("FILE_REF_OUTSIDE_REPO", `${location}:${ref}`, "file ref resolves outside the repository"));
      continue;
    }
    let stat;
    try {
      stat = fs.statSync(resolved);
    } catch {
      diagnostics.push(diag("FILE_MISSING", `${location}:${ref}`, "referenced file does not exist"));
      continue;
    }
    if (!stat.isFile()) {
      diagnostics.push(diag("FILE_NOT_FILE", `${location}:${ref}`, "reference must resolve to a file, not a directory"));
      continue;
    }
    valid.push(ref);
  }
  return valid;
}

function validateJourneyFileRefs(rawRefs, location, requiredPrefix, loadedRefs, _loaderName, diagnostics) {
  const existingRefs = validateFileRefs(rawRefs, location, diagnostics);
  const valid = [];
  for (const ref of existingRefs) {
    if (!ref.startsWith(requiredPrefix) || !ref.endsWith(".mjs")) {
      diagnostics.push(diag("JOURNEY_PATH", `${location}:${ref}`, `journey must be an .mjs file under ${requiredPrefix}`));
    } else if (loadedRefs?.has(ref)) {
      valid.push(ref);
    }
  }
  return valid;
}

function validateCoverageFileRefs(rawRefs, location, commandKind, diagnostics) {
  if (!Array.isArray(rawRefs)) {
    diagnostics.push(diag("COVERAGE_FILE_REFS_SHAPE", location, "must be an array of { path, anchor, kind? } test references"));
    return [];
  }
  const valid = [];
  const seenPaths = new Set();
  for (const ref of rawRefs) {
    if (!isPlainObject(ref) || typeof ref.path !== "string" || ref.path.trim() === "") {
      diagnostics.push(diag("COVERAGE_FILE_REF", location, "coverage file ref must be an object with a non-empty path"));
      continue;
    }
    const refLocation = `${location}:${ref.path}`;
    if (seenPaths.has(ref.path)) {
      diagnostics.push(diag("COVERAGE_FILE_DUPLICATE", refLocation, "test file path appears more than once for this command"));
      continue;
    }
    seenPaths.add(ref.path);
    if (typeof ref.anchor !== "string" || ref.anchor.trim().length < 4) {
      diagnostics.push(diag("COVERAGE_ANCHOR", refLocation, "coverage ref needs a command-specific non-empty anchor"));
      continue;
    }
    if (ref.kind !== undefined && ref.kind !== "inlineTest") {
      diagnostics.push(diag("COVERAGE_FILE_KIND", refLocation, `unsupported coverage ref kind ${render(ref.kind)}`));
      continue;
    }
    if (path.isAbsolute(ref.path) || ref.path.includes("\\")) {
      diagnostics.push(diag("FILE_REF_RELATIVE", refLocation, "file ref must use repo-relative POSIX separators"));
      continue;
    }
    const resolved = path.resolve(repoRoot, ref.path);
    const relative = path.relative(repoRoot, resolved);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      diagnostics.push(diag("FILE_REF_OUTSIDE_REPO", refLocation, "file ref resolves outside the repository"));
      continue;
    }
    let source;
    try {
      const stat = fs.statSync(resolved);
      if (!stat.isFile()) {
        diagnostics.push(diag("FILE_NOT_FILE", refLocation, "reference must resolve to a file, not a directory"));
        continue;
      }
      source = fs.readFileSync(resolved, "utf8");
    } catch {
      diagnostics.push(diag("FILE_MISSING", refLocation, "referenced test file does not exist"));
      continue;
    }
    const dedicatedTest = isDedicatedTestPath(ref.path);
    if (!dedicatedTest && ref.kind !== "inlineTest") {
      diagnostics.push(diag("FILE_NOT_TEST_SURFACE", refLocation, "production files do not count as coverage; use a dedicated test path or kind=inlineTest for a real inline test module"));
      continue;
    }
    const anchorIndex = source.indexOf(ref.anchor);
    if (anchorIndex < 0) {
      diagnostics.push(diag("COVERAGE_ANCHOR_MISSING", refLocation, `anchor ${render(ref.anchor)} for ${commandKind} was not found`));
      continue;
    }
    if (!dedicatedTest) {
      const inlineTestModuleIndex = source.search(/#\[cfg\(test\)\]\s*mod\s+\w+\s*\{/u);
      if (inlineTestModuleIndex < 0 || anchorIndex < inlineTestModuleIndex) {
        diagnostics.push(diag("INLINE_TEST_ANCHOR", refLocation, "inlineTest anchor must occur inside the file's #[cfg(test)] test module"));
        continue;
      }
    }
    valid.push(ref);
  }
  return valid;
}

function isDedicatedTestPath(ref) {
  const basename = path.posix.basename(ref);
  return basename === "tests.rs"
    || basename.endsWith("_tests.rs")
    || /\.(?:test|spec)\.(?:[cm]?[jt]sx?|mjs|cjs)$/u.test(basename)
    || ref.split("/").includes("tests");
}

function validateCommandScenarioRefs(rawRefs, location, scenarios, commandKind, diagnostics) {
  const existing = validateScenarioRefs(rawRefs, location, scenarios, diagnostics);
  const valid = [];
  const commandAnchor = `\"${commandKind}\"`;
  for (const scenario of existing) {
    if (!scenario.source.includes(commandAnchor)) {
      diagnostics.push(diag("SCENARIO_ANCHOR_MISSING", `${location}:${scenario.name}`, `scenario does not contain command-specific anchor ${commandAnchor}`));
    } else {
      valid.push(scenario);
    }
  }
  return valid;
}

function validateScenarioRefs(rawRefs, location, scenarios, diagnostics) {
  if (!Array.isArray(rawRefs)) {
    diagnostics.push(diag("SCENARIO_REFS_SHAPE", location, "must be an array of scenario names"));
    return [];
  }
  const valid = [];
  const seen = new Set();
  for (const name of rawRefs) {
    if (typeof name !== "string" || name.trim() === "") {
      diagnostics.push(diag("SCENARIO_REF", location, "scenario ref must be a non-empty scenario name"));
      continue;
    }
    if (seen.has(name)) {
      diagnostics.push(diag("SCENARIO_REF_DUPLICATE", `${location}:${name}`, "scenario ref appears more than once"));
      continue;
    }
    seen.add(name);
    const scenario = scenarios.get(name);
    if (!scenario) diagnostics.push(diag("SCENARIO_MISSING", `${location}:${name}`, "no scenario declares this name"));
    else valid.push(scenario);
  }
  return valid;
}

function validateQuarantine(quarantine, now, diagnostics) {
  let activeCount = 0;
  if (!isPlainObject(quarantine)) {
    diagnostics.push(diag("QUARANTINE_SHAPE", "quarantine", "flaky quarantine must be an object"));
    return { activeCount };
  }
  if (quarantine.schema !== expectedQuarantineSchema) {
    diagnostics.push(diag("QUARANTINE_SCHEMA", "quarantine.schema", `expected ${expectedQuarantineSchema}, got ${render(quarantine.schema)}`));
  }
  if (!Array.isArray(quarantine.entries)) {
    diagnostics.push(diag("QUARANTINE_ENTRIES", "quarantine.entries", "entries must be an array"));
    return { activeCount };
  }
  const ids = new Set();
  for (const [index, entry] of quarantine.entries.entries()) {
    const location = `quarantine.entries[${index}]`;
    if (!isPlainObject(entry)) {
      diagnostics.push(diag("QUARANTINE_ENTRY", location, "entry must be an object"));
      continue;
    }
    if (typeof entry.id !== "string" || entry.id.trim() === "") {
      diagnostics.push(diag("QUARANTINE_ID", location, "id must be a non-empty string"));
    } else if (ids.has(entry.id)) {
      diagnostics.push(diag("QUARANTINE_DUPLICATE", `quarantine:${entry.id}`, "id appears more than once"));
    } else {
      ids.add(entry.id);
    }
    if (typeof entry.task !== "string" || entry.task.trim() === "") diagnostics.push(diag("QUARANTINE_TASK", location, "task must be a non-empty string"));
    if (typeof entry.owner !== "string" || entry.owner.trim().length < 3) diagnostics.push(diag("QUARANTINE_OWNER", location, "owner must name a concrete owning lane or person"));
    if (typeof entry.reason !== "string" || entry.reason.trim().length < 20) diagnostics.push(diag("QUARANTINE_REASON", location, "reason must describe the observed flake"));
    const firstSeen = canonicalIsoMillis(entry.firstSeen);
    const expiresAt = canonicalIsoMillis(entry.expiresAt);
    if (firstSeen === null) diagnostics.push(diag("QUARANTINE_FIRST_SEEN", location, "firstSeen must be canonical ISO-8601 UTC with milliseconds"));
    if (expiresAt === null) diagnostics.push(diag("QUARANTINE_EXPIRES_AT", location, "expiresAt must be canonical ISO-8601 UTC with milliseconds"));
    if (firstSeen !== null && expiresAt !== null && expiresAt <= firstSeen) diagnostics.push(diag("QUARANTINE_WINDOW", location, "expiresAt must be after firstSeen"));
    if (expiresAt !== null && expiresAt <= now.getTime()) diagnostics.push(diag("QUARANTINE_EXPIRED", entry.id ? `quarantine:${entry.id}` : location, `expired at ${entry.expiresAt}`));
    if (expiresAt !== null && expiresAt > now.getTime()) activeCount += 1;
  }
  return { activeCount };
}

function canonicalIsoMillis(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) return null;
  return parsed;
}

function runSelfTest({ registry, manifest, quarantine, scenarios, browserJourneys }) {
  const cases = [
    {
      name: "unknown command",
      code: "COMMAND_UNKNOWN",
      mutate(copy) {
        copy.commands.push({
          kind: "DefinitelyUnknownCommand",
          systemId: "movement",
          debugOnly: false,
          refs: { files: [{ path: "crates/successor-sim/src/authority/tests.rs", anchor: "ClientCommand::Move {" }], scenarios: [] },
        });
      },
    },
    {
      name: "missing ref",
      code: "FILE_MISSING",
      mutate(copy) {
        copy.commands[0].refs.files[0].path = "tools/verification/coverage/__missing__.test.mjs";
      },
    },
    {
      name: "unrelated production file",
      code: "FILE_NOT_TEST_SURFACE",
      mutate(copy) {
        copy.commands[0].refs.files[0] = {
          path: "crates/successor-sim/src/authority/commands.rs",
          anchor: "ClientCommand::Move {",
        };
      },
    },
    {
      name: "expired waiver",
      code: "WAIVER_EXPIRED",
      mutate(copy) {
        copy.waivers[0].createdAt = "1999-12-18T00:00:00.000Z";
        copy.waivers[0].expiresAt = "2000-01-01T00:00:00.000Z";
      },
    },
  ];
  for (const selfTest of cases) {
    const invalidRegistry = structuredClone(registry);
    selfTest.mutate(invalidRegistry);
    const result = validateAll({
      registry: invalidRegistry,
      manifest,
      quarantine,
      scenarios,
      browserJourneys,
      now: new Date(),
    });
    if (!result.diagnostics.some((diagnostic) => diagnostic.code === selfTest.code)) {
      throw new Error(`self-test ${selfTest.name} did not produce ${selfTest.code}`);
    }
    console.log(`Self-test PASS: ${selfTest.name} -> ${selfTest.code}`);
  }
}

function printFailures(diagnostics) {
  const sorted = sortDiagnostics(diagnostics);
  console.error(`Coverage registry check failed with ${sorted.length} diagnostic${sorted.length === 1 ? "" : "s"}:`);
  for (const diagnostic of sorted) {
    console.error(`- ${diagnostic.code} ${diagnostic.location}: ${diagnostic.message}`);
  }
}

function printSuccess(summary) {
  console.log(`Coverage registry OK: ${summary.trackedCommands}/${summary.manifestCommands} commands tracked (${summary.productionCommands} production, ${summary.debugCommands} debug-only) across ${summary.systems.length} systems.`);
  console.log(`Evidence: ${summary.referencedCommands} commands have existing refs (${summary.referencedProductionCommands}/${summary.productionCommands} production, ${summary.referencedDebugCommands}/${summary.debugCommands} debug-only); ${summary.coverageWaivers} command-coverage waivers account for the remaining commands.`);
  console.log(`Debt: ${summary.activeWaivers} active waivers (${summary.coverageWaivers} command coverage, ${summary.propertyWaivers} required surfaces, ${summary.operationalWaivers} operational surfaces).`);
  console.log(`Operational coverage: operational evidence ${summary.operationalEvidenceCount}/${summary.operationalSurfaceCount}, operational debt ${summary.operationalWaivers}.`);
  console.log(`Systems: ${summary.systems.join(", ")}`);
  console.log(`Flaky quarantine: ${summary.quarantinedTasks} active entries.`);
}

function sortDiagnostics(diagnostics) {
  return [...diagnostics].sort((left, right) => {
    const leftKey = `${left.code}\u0000${left.location}\u0000${left.message}`;
    const rightKey = `${right.code}\u0000${right.location}\u0000${right.message}`;
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });
}

function diag(code, location, message) {
  return { code, location, message };
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function relativeRepoPath(filePath) {
  return path.relative(repoRoot, filePath).split(path.sep).join("/");
}

function relativeOrAbsolute(filePath) {
  const relative = path.relative(repoRoot, filePath);
  return relative.startsWith("..") || path.isAbsolute(relative) ? filePath : relative.split(path.sep).join("/");
}

function render(value) {
  return JSON.stringify(value);
}
