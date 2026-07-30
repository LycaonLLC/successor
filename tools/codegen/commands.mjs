#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..", "..");
const generatedDir = path.join(scriptDir, "generated");
const manifestPath = path.join(generatedDir, "successor.commands.manifest.v1.json");
const verbsPath = path.join(generatedDir, "verbs.generated.json");
const docsPath = path.join(generatedDir, "COMMANDS.generated.md");
const protocolPath = path.join(repoRoot, "server", "src", "game", "protocol.ts");
const authorityCommandSystemPath = path.join(repoRoot, "client", "src", "slice-core", "authorityCommandSystem.ts");
const shardPath = path.join(repoRoot, "server", "src", "game", "shard.ts");
const regenCommand = "cargo run -p successor-sim --bin emit_command_manifest -- tools/codegen/generated/successor.commands.manifest.v1.json && node tools/codegen/commands.mjs";
const manifestSchema = "successor.commands.manifest.v1";
const verbSchema = "successor.command-verbs.generated.v1";
const allowedArgTypes = new Set(["int", "bool", "milli", "enum", "id-domain", "text"]);

const options = parseArgs(process.argv.slice(2));
if (options.help) {
  printUsage();
  process.exit(0);
}

try {
  const manifest = readJson(manifestPath);
  const validationFailures = validateManifest(manifest);
  const mirrorFacts = readMirrorFacts();
  const driftFailures = checkDrift(manifest, mirrorFacts, options);
  const generated = generateArtifacts(manifest);
  const freshnessFailures = options.check ? checkFreshness(generated) : [];
  const failures = [...validationFailures, ...driftFailures, ...freshnessFailures];

  if (failures.length > 0) {
    console.error(formatFailureReport(failures, mirrorFacts));
    process.exit(1);
  }

  if (options.check) {
    console.log(`command manifest check passed: ${manifest.commands.length} command kinds, ${durableIntentCount(manifest)} durable-intent annotation(s), drift mirrors green`);
  } else {
    fs.mkdirSync(generatedDir, { recursive: true });
    fs.writeFileSync(verbsPath, generated.verbsJson, "utf8");
    fs.writeFileSync(docsPath, generated.docsMarkdown, "utf8");
    console.log(`wrote ${relative(verbsPath)}`);
    console.log(`wrote ${relative(docsPath)}`);
    console.log(`command manifest codegen passed: ${manifest.commands.length} command kinds, ${durableIntentCount(manifest)} durable-intent annotation(s), drift mirrors green`);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

function parseArgs(args) {
  const parsed = {
    check: false,
    help: false,
    simulateMissingClientKinds: [],
    simulateMissingServerKinds: [],
    simulateMissingClientCommandKeys: [],
    simulateMissingIngressBudgetKinds: [],
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--check") {
      parsed.check = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      parsed.help = true;
      continue;
    }
    if (arg === "--simulate-missing-client-kind") {
      parsed.simulateMissingClientKinds.push(requiredValue(args, ++index, arg));
      continue;
    }
    if (arg.startsWith("--simulate-missing-client-kind=")) {
      parsed.simulateMissingClientKinds.push(arg.split("=", 2)[1] ?? "");
      continue;
    }
    if (arg === "--simulate-missing-server-kind") {
      parsed.simulateMissingServerKinds.push(requiredValue(args, ++index, arg));
      continue;
    }
    if (arg.startsWith("--simulate-missing-server-kind=")) {
      parsed.simulateMissingServerKinds.push(arg.split("=", 2)[1] ?? "");
      continue;
    }
    if (arg === "--simulate-missing-client-command-key") {
      parsed.simulateMissingClientCommandKeys.push(requiredValue(args, ++index, arg));
      continue;
    }
    if (arg.startsWith("--simulate-missing-client-command-key=")) {
      parsed.simulateMissingClientCommandKeys.push(arg.split("=", 2)[1] ?? "");
      continue;
    }
    if (arg === "--simulate-missing-ingress-budget-kind") {
      parsed.simulateMissingIngressBudgetKinds.push(requiredValue(args, ++index, arg));
      continue;
    }
    if (arg.startsWith("--simulate-missing-ingress-budget-kind=")) {
      parsed.simulateMissingIngressBudgetKinds.push(arg.split("=", 2)[1] ?? "");
      continue;
    }
    throw new Error(`unknown argument ${arg}`);
  }
  return parsed;
}

function requiredValue(args, index, flag) {
  const value = args[index];
  if (!value) throw new Error(`${flag} requires a command kind`);
  return value;
}

function printUsage() {
  console.log(`Usage:
  node tools/codegen/commands.mjs
      Generate tools/codegen/generated/verbs.generated.json and COMMANDS.generated.md from the committed manifest.

  node tools/codegen/commands.mjs --check
      Verify manifest shape, generated artifact freshness, and drift against server/client mirrors.

Regenerate the manifest first with:
  cargo run -p successor-sim --bin emit_command_manifest -- tools/codegen/generated/successor.commands.manifest.v1.json

Red-path proof helpers mutate parsed mirror sets in memory only:
  node tools/codegen/commands.mjs --check --simulate-missing-client-kind CancelAbilityQueue
  node tools/codegen/commands.mjs --check --simulate-missing-server-kind CancelAbilityQueue
  node tools/codegen/commands.mjs --check --simulate-missing-client-command-key CancelAbilityQueue
  node tools/codegen/commands.mjs --check --simulate-missing-ingress-budget-kind CancelAbilityQueue`);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function readMirrorFacts() {
  const protocolSource = fs.readFileSync(protocolPath, "utf8");
  const clientSource = fs.readFileSync(authorityCommandSystemPath, "utf8");
  const shardSource = fs.readFileSync(shardPath, "utf8");
  const protocol = extractProtocolKinds(protocolSource);
  const clientUnion = extractAuthorityClientCommandKinds(clientSource);
  const clientKindAlias = extractAuthorityClientCommandKindAlias(clientSource);
  const clientCommandKeys = extractQuotedKindArray(protocolSource, "const CLIENT_COMMAND_KEYS = [", relative(protocolPath));
  const ingressBudget = extractQuotedKindArray(shardSource, "const ingressBudgetCommandKinds = [", relative(shardPath));
  return {
    protocolKinds: protocol.kinds,
    clientKinds: clientUnion.kinds,
    clientKindAliasKinds: clientKindAlias.kinds,
    clientCommandKeyKinds: clientCommandKeys.kinds,
    ingressBudgetKinds: ingressBudget.kinds,
    anchors: {
      protocol: { file: relative(protocolPath), line: protocol.startLine, label: "rawClientCommandSchema" },
      clientUnion: { file: relative(authorityCommandSystemPath), line: clientUnion.startLine, label: "AuthorityClientCommand" },
      clientKindAlias: { file: relative(authorityCommandSystemPath), line: clientKindAlias.startLine, label: "AuthorityClientCommandKind" },
      clientCommandKeys: { file: relative(protocolPath), line: clientCommandKeys.startLine, label: "CLIENT_COMMAND_KEYS" },
      ingressBudget: { file: relative(shardPath), line: ingressBudget.startLine, label: "ingressBudgetCommandKinds" },
      shardCommandKind: { file: relative(shardPath), line: findLine(shardSource, "function commandKind(command: ClientCommand): string"), label: "commandKind" },
      shardNeverGuard: { file: relative(shardPath), line: findLine(shardSource, "const unclassified: never = command"), label: "never guard" },
    },
  };
}

function extractProtocolKinds(source) {
  const lines = source.split(/\r?\n/);
  const startIndex = lines.findIndex((line) => line.includes("const rawClientCommandSchema = z.union(["));
  if (startIndex < 0) throw new Error(`unable to find rawClientCommandSchema in ${relative(protocolPath)}`);
  const kinds = [];
  for (let index = startIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === "]);" || line.trim() === "]);" || line.startsWith("]);")) break;
    const match = line.match(/^ {4}([A-Z][A-Za-z0-9_]*)\s*:/);
    if (match) kinds.push(match[1]);
  }
  return { kinds, startLine: startIndex + 1 };
}

function extractAuthorityClientCommandKinds(source) {
  const lines = source.split(/\r?\n/);
  const startIndex = lines.findIndex((line) => line.includes("export type AuthorityClientCommand ="));
  if (startIndex < 0) throw new Error(`unable to find AuthorityClientCommand in ${relative(authorityCommandSystemPath)}`);
  const kinds = [];
  for (let index = startIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    const match = line.match(/\|\s*\{\s*([A-Z][A-Za-z0-9_]*)\s*:/);
    if (match) kinds.push(match[1]);
    if (line.trim().endsWith(";")) break;
  }
  return { kinds, startLine: startIndex + 1 };
}

function extractAuthorityClientCommandKindAlias(source) {
  const lines = source.split(/\r?\n/);
  const startIndex = lines.findIndex((line) => line.includes("export type AuthorityClientCommandKind ="));
  if (startIndex < 0) throw new Error(`unable to find AuthorityClientCommandKind in ${relative(authorityCommandSystemPath)}`);
  const kinds = [];
  for (let index = startIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    const match = line.match(/\|\s*"([A-Z][A-Za-z0-9_]*)"/);
    if (match) kinds.push(match[1]);
    if (line.trim().endsWith(";")) break;
  }
  return { kinds, startLine: startIndex + 1 };
}

/**
 * Extracts a `"Kind",` quoted-string array (e.g. CLIENT_COMMAND_KEYS in
 * protocol.ts, ingressBudgetCommandKinds in shard.ts) — the two wire/budget
 * mirrors that are independent of rawClientCommandSchema. A missing kind in
 * either silently rejects real clients (parse) or drops them off the
 * rate-limit budget map.
 */
function extractQuotedKindArray(source, marker, file) {
  const lines = source.split(/\r?\n/);
  const startIndex = lines.findIndex((line) => line.includes(marker));
  if (startIndex < 0) throw new Error(`unable to find ${marker} in ${file}`);
  const kinds = [];
  for (let index = startIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim().startsWith("]")) break;
    const match = line.match(/^\s*"([A-Z][A-Za-z0-9_]*)"\s*,?\s*$/);
    if (match) kinds.push(match[1]);
  }
  return { kinds, startLine: startIndex + 1 };
}

function validateManifest(manifest) {
  const failures = [];
  if (manifest.schema !== manifestSchema) {
    failures.push({ kind: "manifest", message: `manifest schema is ${JSON.stringify(manifest.schema)}; expected ${manifestSchema}` });
  }
  if (!Array.isArray(manifest.commands)) {
    failures.push({ kind: "manifest", message: "manifest.commands must be an array" });
    return failures;
  }
  if (manifest.commands.length < 40) {
    failures.push({ kind: "manifest", message: `manifest has ${manifest.commands.length} command kinds; expected 40+ wire commands` });
  }
  const seenKinds = new Set();
  const seenVerbs = new Set();
  const requiredKinds = new Map([
    ["CancelAbilityQueue", "SP0 requires CancelAbilityQueue in the manifest"],
    ["DebugGrantSkillBoxes", "SP0 requires DebugGrantSkillBoxes with debugGated=true"],
  ]);
  for (const command of manifest.commands) {
    if (!command || typeof command !== "object") {
      failures.push({ kind: "manifest", message: "manifest command row must be an object" });
      continue;
    }
    if (typeof command.kind !== "string" || !/^[A-Z][A-Za-z0-9_]*$/.test(command.kind)) {
      failures.push({ kind: "manifest", message: `invalid command kind ${JSON.stringify(command.kind)}` });
    } else if (seenKinds.has(command.kind)) {
      failures.push({ kind: "manifest", message: `duplicate command kind ${command.kind}` });
    } else {
      seenKinds.add(command.kind);
    }
    if (typeof command.verb !== "string" || !/^[a-z][a-z0-9-]*$/.test(command.verb)) {
      failures.push({ kind: "manifest", message: `${command.kind ?? "<unknown>"} has invalid verb ${JSON.stringify(command.verb)}` });
    } else if (seenVerbs.has(command.verb)) {
      failures.push({ kind: "manifest", message: `duplicate verb ${command.verb}` });
    } else {
      seenVerbs.add(command.verb);
    }
    for (const alias of command.aliases ?? []) {
      if (!/^[a-z][a-z0-9-]*$/.test(alias)) failures.push({ kind: "manifest", message: `${command.kind} has invalid alias ${alias}` });
    }
    if (!Array.isArray(command.args)) failures.push({ kind: "manifest", message: `${command.kind} args must be an array` });
    for (const arg of command.args ?? []) {
      if (!arg || typeof arg.name !== "string") failures.push({ kind: "manifest", message: `${command.kind} has an arg without a name` });
      if (!allowedArgTypes.has(arg.type)) failures.push({ kind: "manifest", message: `${command.kind}.${arg?.name ?? "<arg>"} has unsupported type ${JSON.stringify(arg?.type)}` });
      if (arg.type === "enum" && (!Array.isArray(arg.enumValues) || arg.enumValues.length === 0)) failures.push({ kind: "manifest", message: `${command.kind}.${arg.name} enum arg needs enumValues` });
      if (arg.type === "id-domain" && typeof arg.domain !== "string") failures.push({ kind: "manifest", message: `${command.kind}.${arg.name} id-domain arg needs domain` });
    }
    for (const reasonCode of command.reasonCodes ?? []) {
      if (!/^[a-z][a-z0-9_]*$/.test(reasonCode)) failures.push({ kind: "manifest", message: `${command.kind} has non-snake-case reason code ${reasonCode}` });
    }
  }
  // The whole slash namespace (verbs + aliases) must be globally unique — the
  // client verb registry flattens them into one map, so any overlap silently
  // last-wins shadows a command (the HarvestCrop/HarvestCorpse "harvest" class).
  const tokenOwner = new Map();
  for (const command of manifest.commands) {
    if (typeof command.kind !== "string") continue;
    const tokens = [command.verb, ...(command.aliases ?? [])].filter((t) => typeof t === "string");
    for (const token of tokens) {
      const prev = tokenOwner.get(token);
      if (prev && prev !== command.kind) {
        failures.push({ kind: "manifest", message: `slash token "${token}" is claimed by both ${prev} and ${command.kind} — verbs+aliases must be globally unique (no silent last-wins shadowing)` });
      } else {
        tokenOwner.set(token, command.kind);
      }
    }
  }
  for (const [kind, message] of requiredKinds) {
    if (!seenKinds.has(kind)) failures.push({ kind: "manifest", message });
  }
  const debugGrant = manifest.commands.find((command) => command.kind === "DebugGrantSkillBoxes");
  if (debugGrant && debugGrant.debugGated !== true) {
    failures.push({ kind: "manifest", message: "DebugGrantSkillBoxes must be marked debugGated=true" });
  }
  const queue = manifest.commands.find((command) => command.kind === "QueueCombatAction");
  if (!queue?.durableIntent || !String(queue.durableIntent.when ?? "").includes("basic_shot")) {
    failures.push({ kind: "manifest", message: "QueueCombatAction must annotate basic_shot repeat_intent durable behavior" });
  }
  return failures;
}

function checkDrift(manifest, facts, options) {
  const failures = [];
  const manifestKinds = manifest.commands.map((command) => command.kind);
  const serverKinds = new Set(facts.protocolKinds);
  const clientKinds = new Set(facts.clientKinds);
  const clientKindAliasKinds = new Set(facts.clientKindAliasKinds);
  for (const kind of options.simulateMissingServerKinds) serverKinds.delete(kind);
  for (const kind of options.simulateMissingClientKinds) {
    clientKinds.delete(kind);
    clientKindAliasKinds.delete(kind);
  }
  const clientCommandKeyKinds = new Set(facts.clientCommandKeyKinds);
  const ingressBudgetKinds = new Set(facts.ingressBudgetKinds);
  for (const kind of options.simulateMissingClientCommandKeys) clientCommandKeyKinds.delete(kind);
  for (const kind of options.simulateMissingIngressBudgetKinds) ingressBudgetKinds.delete(kind);

  const debugKinds = new Set(manifest.commands.filter((command) => command.debugGated).map((command) => command.kind));
  const nonDebugManifestKinds = manifest.commands.filter((command) => !command.debugGated).map((command) => command.kind);

  for (const kind of manifestKinds) {
    if (!serverKinds.has(kind)) failures.push(mirrorFailure("server-missing", kind, `server protocol.ts is missing manifest command kind ${kind}`));
  }
  for (const kind of facts.protocolKinds) {
    if (!manifestKinds.includes(kind)) failures.push(mirrorFailure("manifest-missing-server", kind, `manifest is missing server protocol command kind ${kind}`));
  }
  for (const kind of nonDebugManifestKinds) {
    if (!clientKinds.has(kind)) failures.push(mirrorFailure("client-missing", kind, `client authorityCommandSystem.ts is missing non-debug manifest command kind ${kind}`));
    if (!clientKindAliasKinds.has(kind)) failures.push(mirrorFailure("client-kind-alias-missing", kind, `client AuthorityClientCommandKind is missing non-debug manifest command kind ${kind}`));
  }
  for (const kind of facts.clientKinds) {
    if (!nonDebugManifestKinds.includes(kind)) {
      const debugNote = debugKinds.has(kind) ? " (manifest row is debugGated, so the public client union should not expose it)" : "";
      failures.push(mirrorFailure("manifest-missing-client", kind, `manifest non-debug surface is missing client command kind ${kind}${debugNote}`));
    }
  }
  for (const kind of facts.clientKindAliasKinds) {
    if (!nonDebugManifestKinds.includes(kind)) failures.push(mirrorFailure("manifest-missing-client-kind-alias", kind, `manifest non-debug surface is missing client AuthorityClientCommandKind ${kind}`));
  }
  // Wire-parse + ingress-budget mirrors (CLIENT_COMMAND_KEYS, ingressBudgetCommandKinds).
  // Both carry every command kind (debug included), so they are checked against
  // the full manifest surface — a missing kind here silently rejects real
  // clients at parse or drops them off the rate-limit budget map.
  for (const kind of manifestKinds) {
    if (!clientCommandKeyKinds.has(kind)) failures.push(mirrorFailure("protocol-client-keys-missing", kind, `protocol.ts CLIENT_COMMAND_KEYS is missing manifest command kind ${kind} — clients sending it are rejected at parse`));
  }
  for (const kind of facts.clientCommandKeyKinds) {
    if (!manifestKinds.includes(kind)) failures.push(mirrorFailure("manifest-missing-protocol-client-keys", kind, `manifest is missing protocol.ts CLIENT_COMMAND_KEYS kind ${kind}`));
  }
  for (const kind of manifestKinds) {
    if (!ingressBudgetKinds.has(kind)) failures.push(mirrorFailure("ingress-budget-missing", kind, `shard.ts ingressBudgetCommandKinds is missing manifest command kind ${kind} — it falls off the rate-limit budget map`));
  }
  for (const kind of facts.ingressBudgetKinds) {
    if (!manifestKinds.includes(kind)) failures.push(mirrorFailure("manifest-missing-ingress-budget", kind, `manifest is missing shard.ts ingressBudgetCommandKinds kind ${kind}`));
  }
  return failures;
}

function mirrorFailure(kind, commandKind, message) {
  return { kind, commandKind, message };
}

function generateArtifacts(manifest) {
  const verbs = {
    schema: verbSchema,
    sourceManifest: relative(manifestPath),
    regenerationCommand: regenCommand,
    commandCount: manifest.commands.length,
    debugGatedCount: manifest.commands.filter((command) => command.debugGated).length,
    durableIntentCount: durableIntentCount(manifest),
    verbs: manifest.commands.map((command) => ({
      kind: command.kind,
      verb: command.verb,
      defaultVerb: kebabCase(command.kind),
      aliases: command.aliases ?? [],
      debugGated: command.debugGated === true,
      budgetClass: command.budgetClass,
      durableIntent: command.durableIntent ?? null,
      args: command.args,
      reasonCodes: command.reasonCodes,
    })),
  };
  return {
    verbsJson: `${JSON.stringify(verbs, null, 2)}\n`,
    docsMarkdown: renderDocs(manifest, verbs),
  };
}

function renderDocs(manifest, verbs) {
  const lines = [];
  lines.push("# Successor command manifest");
  lines.push("");
  lines.push("Generated from `successor.commands.manifest.v1`.");
  lines.push("");
  lines.push("Regenerate:");
  lines.push("");
  lines.push("```sh");
  lines.push(regenCommand);
  lines.push("```");
  lines.push("");
  lines.push(`- Manifest schema: \`${manifest.schema}\``);
  lines.push(`- Command kinds: ${manifest.commands.length}`);
  lines.push(`- Debug-gated kinds: ${manifest.commands.filter((command) => command.debugGated).map((command) => `\`${command.kind}\``).join(", ")}`);
  lines.push(`- Durable-intent annotations: ${durableIntentCount(manifest)}`);
  lines.push("");
  lines.push("| Kind | Verb | Default verb | Args | Reason codes | Notes |");
  lines.push("|---|---|---|---|---|---|");
  for (const row of verbs.verbs) {
    const args = row.args.length === 0 ? "—" : row.args.map(formatArg).join("<br>");
    const reasons = row.reasonCodes.length === 0 ? "—" : row.reasonCodes.map((reason) => `\`${reason}\``).join(", ");
    const notes = [
      manifest.commands.find((command) => command.kind === row.kind)?.doc ?? "",
      row.debugGated ? "debug-gated" : "",
      row.durableIntent ? `durable: ${row.durableIntent.kind} (${row.durableIntent.when})` : "",
    ].filter(Boolean).join("; ");
    lines.push(`| \`${row.kind}\` | \`/${row.verb}\`${row.aliases.length ? `<br>aliases: ${row.aliases.map((alias) => `\`/${alias}\``).join(", ")}` : ""} | \`/${row.defaultVerb}\` | ${args} | ${reasons} | ${escapeTable(notes)} |`);
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

function formatArg(arg) {
  const bits = [`\`${arg.name}\``, arg.required ? "required" : "optional", `\`${arg.type}\``];
  if (arg.domain) bits.push(`domain=\`${arg.domain}\``);
  if (arg.enumValues?.length) bits.push(`values=${arg.enumValues.map((value) => `\`${value}\``).join(",")}`);
  if (arg.repeated) bits.push("repeated");
  if (arg.nullable) bits.push("nullable");
  if (arg.default !== undefined) bits.push(`default=\`${arg.default}\``);
  return bits.join(" ");
}

function checkFreshness(generated) {
  const failures = [];
  compareGeneratedFile(verbsPath, generated.verbsJson, failures);
  compareGeneratedFile(docsPath, generated.docsMarkdown, failures);
  return failures;
}

function compareGeneratedFile(filePath, expected, failures) {
  const actual = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : null;
  if (actual !== expected) {
    failures.push({
      kind: "generated-stale",
      message: `${relative(filePath)} is stale or missing; run ${regenCommand}`,
    });
  }
}

function formatFailureReport(failures, facts) {
  const anchor = facts.anchors;
  const lines = [
    "COMMAND MANIFEST DRIFT CHECK FAILED",
    `manifest: ${relative(manifestPath)}`,
    `server mirror: ${anchor.protocol.file}:${anchor.protocol.line} (${anchor.protocol.label})`,
    `client mirror: ${anchor.clientUnion.file}:${anchor.clientUnion.line} (${anchor.clientUnion.label}); ${anchor.clientKindAlias.file}:${anchor.clientKindAlias.line} (${anchor.clientKindAlias.label})`,
    `exhaustiveness anchor: ${anchor.shardCommandKind.file}:${anchor.shardCommandKind.line} (${anchor.shardCommandKind.label}); ${anchor.shardNeverGuard.file}:${anchor.shardNeverGuard.line} (${anchor.shardNeverGuard.label})`,
    `wire-parse mirror: ${anchor.clientCommandKeys.file}:${anchor.clientCommandKeys.line} (${anchor.clientCommandKeys.label})`,
    `ingress-budget mirror: ${anchor.ingressBudget.file}:${anchor.ingressBudget.line} (${anchor.ingressBudget.label})`,
    "",
  ];
  for (const failure of failures) {
    lines.push(`- ${failure.message}`);
    if (failure.kind === "client-missing" || failure.kind === "client-kind-alias-missing") {
      lines.push(`  fix: add ${failure.commandKind} to the client mirror if it is player-callable, or mark the manifest row debugGated if it is debug-only.`);
    } else if (failure.kind === "server-missing") {
      lines.push(`  fix: add ${failure.commandKind} to ${anchor.protocol.file} or remove it from the manifest if it is not a wire command.`);
    } else if (failure.kind === "protocol-client-keys-missing") {
      lines.push(`  fix: add ${failure.commandKind} to ${anchor.clientCommandKeys.file} CLIENT_COMMAND_KEYS or remove it from the manifest if it is not a wire command.`);
    } else if (failure.kind === "ingress-budget-missing") {
      lines.push(`  fix: add ${failure.commandKind} to ${anchor.ingressBudget.file} ingressBudgetCommandKinds or remove it from the manifest if it is not a wire command.`);
    } else if (failure.kind === "manifest-missing-server" || failure.kind === "manifest-missing-client" || failure.kind === "manifest-missing-client-kind-alias" || failure.kind === "manifest-missing-protocol-client-keys" || failure.kind === "manifest-missing-ingress-budget") {
      lines.push(`  fix: regenerate/update ${relative(manifestPath)} from the source command surface, then rerun ${relative("tools/codegen/commands.mjs")} --check.`);
    }
  }
  return lines.join("\n");
}

function findLine(source, needle) {
  const index = source.split(/\r?\n/).findIndex((line) => line.includes(needle));
  if (index < 0) throw new Error(`unable to find ${needle}`);
  return index + 1;
}

function durableIntentCount(manifest) {
  return manifest.commands.filter((command) => command.durableIntent).length;
}

function kebabCase(value) {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1-$2")
    .toLowerCase();
}

function escapeTable(value) {
  return String(value).replaceAll("|", "\\|");
}

function relative(filePath) {
  return path.relative(repoRoot, path.resolve(repoRoot, filePath)).replaceAll(path.sep, "/");
}
